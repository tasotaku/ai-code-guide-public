"""対象関数を具体例入力で実際に実行し、行ごとの変数の値をJSONで返すトレーサ。

stdin JSON:
  {
    "source": "<対象ファイルの全文>",
    "func_name": "Planner.merge_wants",    # 関数名または Class.method
    "setup": "<準備コード。EXAMPLE_ARGS(tuple) / 任意で EXAMPLE_KWARGS(dict) を定義>",
    "templates": {"Circle": "C({day},{serial})"},  # 型名→短縮表示テンプレート(任意)
    "file_path": "/abs/path/to/target.py",         # 対象ファイルの絶対パス(任意)。import解決に使う
    "workspace_root": "/abs/path/to/project"       # ワークスペースルート(任意)。sys.pathの保険
  }

file_path を渡すと、対象ファイルを本来のモジュール名・パッケージで実行するため、
プロジェクト内の自作モジュールへの絶対import・相対importが通常実行と同じに解決される。

stdout JSON:
  {
    "loops": [{"id": 0, "header_line": 11, "body_start": 12, "body_end": 27, "parent": null}],
    "steps": [{"line": 13, "iter_path": [[0, 1]], "changed": {"key": {"short": "(1,5)", "full": "(1, 5)"}}}],
    "iter_counts": {"0": {"": 2}},        # loop_id → 親iter_pathキー → 周回数
    "return_value": {"short": "...", "full": "..."},
    "func_line_start": 8, "func_line_end": 28,
    "error": null
  }

行番号はすべて1-based・ファイル絶対。iter_path は [ [loop_id, 周回(1-based)], ... ] の外側→内側。
"""

from __future__ import annotations

import ast
import importlib
import io
import json
import os
import re
import sys
import types
import unittest
from contextlib import redirect_stdout
from types import FrameType
from typing import Any

MAX_STEPS = 20000
SHORT_LIMIT = 96
FULL_LIMIT = 400
MAX_ELEMS = 6
IMPLICIT_RECEIVERS = {"self", "cls"}
IDENTITY_ATTR_NAMES = {
    "id", "name", "filename", "path", "key", "code", "status", "kind", "type", "version",
    "document_id", "quarantine_id", "scanner_version",
}


def install_sandbox_guard() -> None:
    """Confine writes to the disposable trace root and deny network/process escape."""
    root_value = os.environ.get("ACG_TRACE_SANDBOX_ROOT")
    if not root_value:
        return
    root = os.path.realpath(root_value)
    read_roots = {
        root,
        os.path.realpath(sys.base_prefix),
        os.path.realpath(sys.prefix),
    }

    def resolved(value: Any) -> str | None:
        if isinstance(value, int):
            return None
        try:
            return os.path.realpath(os.path.abspath(os.fspath(value)))
        except TypeError:
            return None

    def contained(path_value: Any, roots: set[str]) -> bool:
        candidate = resolved(path_value)
        if candidate is None:
            return True
        for allowed in roots:
            try:
                if os.path.commonpath([os.path.normcase(allowed), os.path.normcase(candidate)]) == os.path.normcase(allowed):
                    return True
            except ValueError:
                continue
        return False

    def require_inside(path_value: Any, operation: str, roots: set[str] | None = None) -> None:
        if not contained(path_value, roots or {root}):
            raise PermissionError(f"trace sandbox blocked {operation} outside its disposable workspace")

    def audit(event: str, args: tuple[Any, ...]) -> None:
        if event == "open" and args:
            mode = args[1] if len(args) > 1 else "r"
            flags = args[2] if len(args) > 2 else 0
            writing = (isinstance(mode, str) and any(marker in mode for marker in "wax+")) or (
                isinstance(flags, int)
                and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            )
            require_inside(args[0], "file write" if writing else "file read", {root} if writing else read_roots)
            return
        if event in {"os.remove", "os.rmdir", "os.mkdir", "os.chdir", "os.chmod", "os.truncate"} and args:
            require_inside(args[0], event)
            return
        if event in {"os.rename", "os.link", "os.symlink"} and len(args) >= 2:
            require_inside(args[0], event)
            require_inside(args[1], event)
            return
        if event == "subprocess.Popen" or event.startswith("socket.") or event in {"os.system", "os.posix_spawn"}:
            raise PermissionError(f"trace sandbox blocked {event}")

    sys.addaudithook(audit)


def find_function(tree: ast.Module, qualified_name: str) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    """Top-level function or explicitly qualified class method from the AST."""
    parts = qualified_name.split(".")
    body: list[ast.stmt] = tree.body
    for class_name in parts[:-1]:
        owner = next((node for node in body if isinstance(node, ast.ClassDef) and node.name == class_name), None)
        if owner is None:
            return None
        body = owner.body
    return next((
        node for node in body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == parts[-1]
    ), None)


def resolve_target(namespace: dict[str, Any], qualified_name: str) -> tuple[Any, unittest.TestCase | None, str | None]:
    """Return (callable, unittest instance needing cleanup, error)."""
    parts = qualified_name.split(".")
    if len(parts) == 1:
        target = namespace.get(qualified_name)
        return target, None, None if callable(target) else f"{qualified_name} が呼び出せません"

    owner: Any = namespace.get(parts[0])
    for part in parts[1:-1]:
        owner = getattr(owner, part, None)
    if not isinstance(owner, type):
        return None, None, f"クラス {'.'.join(parts[:-1])} が見つかりません"

    method_name = parts[-1]
    descriptor = owner.__dict__.get(method_name)
    if isinstance(descriptor, (staticmethod, classmethod)):
        target = getattr(owner, method_name, None)
        return target, None, None if callable(target) else f"{qualified_name} が呼び出せません"

    instance = namespace.get("EXAMPLE_INSTANCE")
    test_case: unittest.TestCase | None = None
    if instance is None and issubclass(owner, unittest.TestCase):
        test_case = owner(method_name)
        try:
            test_case.setUp()
        except Exception as e:
            return None, None, f"setUp の実行に失敗: {type(e).__name__}: {e}"
        instance = test_case
    if instance is None:
        return None, None, f"{qualified_name} の実行に必要な EXAMPLE_INSTANCE が定義されていません"
    if not isinstance(instance, owner):
        return None, None, f"EXAMPLE_INSTANCE は {owner.__name__} のインスタンスではありません"
    target = getattr(instance, method_name, None)
    return target, test_case, None if callable(target) else f"{qualified_name} が呼び出せません"


def collect_loops(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict[str, Any]]:
    """関数内の for/while を外側から順に列挙し、ネストの親子を parent で持つ。"""
    loops: list[dict[str, Any]] = []

    def visit(node: ast.AST, parent_id: int | None) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.For, ast.AsyncFor, ast.While)):
                loop_id = len(loops)
                loops.append({
                    "id": loop_id,
                    "header_line": child.lineno,
                    "body_start": child.body[0].lineno,
                    "body_end": child.body[-1].end_lineno or child.body[-1].lineno,
                    "parent": parent_id,
                })
                visit(child, loop_id)
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue  # AI_NOTE: ネスト関数内のループは対象関数のトレースに現れないので飛ばす
            else:
                visit(child, parent_id)

    visit(func, None)
    return loops


def collect_control_points(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict[str, Any]]:
    """Collect decisions and returns that a reader needs to match to the runtime path."""
    points: list[dict[str, Any]] = []

    def visit(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.If):
                points.append({
                    "line": child.lineno,
                    "kind": "if",
                    "body_start": child.body[0].lineno,
                    "body_end": child.body[-1].end_lineno or child.body[-1].lineno,
                })
                visit(child)
            elif isinstance(child, ast.Assert):
                points.append({"line": child.lineno, "kind": "assert"})
            elif isinstance(child, ast.Return):
                points.append({"line": child.lineno, "kind": "return"})
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue
            else:
                visit(child)

    # Visit only the selected function body, not the function node itself (which
    # would otherwise be treated as a nested function by the guard above).
    for statement in func.body:
        if isinstance(statement, ast.If):
            points.append({
                "line": statement.lineno,
                "kind": "if",
                "body_start": statement.body[0].lineno,
                "body_end": statement.body[-1].end_lineno or statement.body[-1].lineno,
            })
            visit(statement)
        elif isinstance(statement, ast.Assert):
            points.append({"line": statement.lineno, "kind": "assert"})
        elif isinstance(statement, ast.Return):
            points.append({"line": statement.lineno, "kind": "return"})
        else:
            visit(statement)
    return sorted(points, key=lambda point: (point["line"], point["kind"]))


class AssertionContextProxy:
    """Keep assertRaises/assertWarns context semantics while recording the final outcome."""

    def __init__(self, context: Any, recorder: "AssertionRecorder", method: str, line: int,
                 arguments: list[Any], keyword_arguments: dict[str, Any]):
        self._context = context
        self._recorder = recorder
        self._method = method
        self._line = line
        self._arguments = arguments
        self._keyword_arguments = keyword_arguments

    def __enter__(self):
        return self._context.__enter__()

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any):
        try:
            result = self._context.__exit__(exc_type, exc_value, traceback)
        except AssertionError as error:
            self._recorder.record(self._method, self._line, self._arguments,
                                  self._keyword_arguments, False, error)
            raise
        # assertRaises returns False for a non-matching exception so it can
        # propagate. assertWarns may validly return None on success.
        passed = not (self._method.startswith("assertRaises") and exc_type is not None and not result)
        observed = None if passed else exc_value
        self._recorder.record(self._method, self._line, self._arguments,
                              self._keyword_arguments, passed, observed,
                              observed_exception=exc_value if passed else None)
        return result


class AssertionRecorder:
    """Record unittest assertions without re-evaluating their argument expressions."""

    def __init__(self, renderer: "ValueRenderer", iter_path: Any):
        self.renderer = renderer
        self.iter_path = iter_path
        self.events: list[dict[str, Any]] = []
        self._originals: dict[str, Any] = {}
        self._active = 0

    def install(self, test_case: unittest.TestCase | None) -> None:
        if test_case is None:
            return
        for name in dir(test_case):
            if not name.startswith("assert"):
                continue
            original = getattr(test_case, name, None)
            if not callable(original):
                continue
            self._originals[name] = test_case.__dict__.get(name, None)

            def wrapped(*args: Any, __name: str = name, __original: Any = original, **kwargs: Any):
                if self._active > 0:
                    return __original(*args, **kwargs)
                line = sys._getframe(1).f_lineno
                self._active += 1
                try:
                    result = __original(*args, **kwargs)
                except AssertionError as error:
                    self.record(__name, line, list(args), kwargs, False, error)
                    raise
                finally:
                    self._active -= 1
                if __name.startswith(("assertRaises", "assertWarns")) and hasattr(result, "__enter__") and hasattr(result, "__exit__"):
                    return AssertionContextProxy(result, self, __name, line, list(args), kwargs)
                self.record(__name, line, list(args), kwargs, True)
                return result

            setattr(test_case, name, wrapped)

    def restore(self, test_case: unittest.TestCase | None) -> None:
        if test_case is None:
            return
        for name, previous in self._originals.items():
            if previous is None:
                test_case.__dict__.pop(name, None)
            else:
                setattr(test_case, name, previous)

    def record(self, method: str, line: int, arguments: list[Any], keyword_arguments: dict[str, Any],
               passed: bool, error: BaseException | None = None,
               observed_exception: BaseException | None = None) -> None:
        event: dict[str, Any] = {
            "line": line,
            "kind": "unittest",
            "method": method,
            "outcome": passed,
            "arguments": [
                {"short": self.renderer.short(value), "full": self.renderer.full(value)}
                for value in arguments
            ],
            "keyword_arguments": {
                name: {"short": self.renderer.short(value), "full": self.renderer.full(value)}
                for name, value in keyword_arguments.items()
            },
            "iter_path": [list(entry) for entry in self.iter_path()],
        }
        exception = observed_exception or error
        if exception is not None:
            event["exception"] = {"type": type(exception).__name__, "message": str(exception)}
        self.events.append(event)


class ValueRenderer:
    """実行結果の値を「型テンプレート→要素数制限→文字数上限」の決定論パイプで短縮表示する。"""

    def __init__(self, templates: dict[str, str]):
        self.templates = templates

    def short(self, value: Any, depth: int = 0) -> str:
        rendered = self._render(value, depth)
        if not isinstance(value, (str, bytes, int, float, bool, type(None), dict, list, tuple, set, frozenset)) and len(rendered) > 60:
            return self._summary(value, SHORT_LIMIT)
        if len(rendered) <= SHORT_LIMIT:
            return rendered
        return self._summary(value, SHORT_LIMIT)

    def full(self, value: Any) -> str:
        try:
            rendered = repr(value)
            state = self._public_state(value, 0)
            if self._has_runtime_address(rendered):
                return self._clip(state or self._remove_runtime_address(value, rendered), FULL_LIMIT)
            return self._clip(rendered, FULL_LIMIT)
        except Exception:
            return f"<{type(value).__name__}>"

    def _clip(self, text: str, limit: int) -> str:
        return text if len(text) <= limit else text[: limit - 1] + "…"

    def _render(self, value: Any, depth: int) -> str:
        # AI_NOTE: プリミティブは深さに関係なく常に値を出す(深い入れ子の 'alice' が <str> に化けるのを防ぐ)。
        if isinstance(value, str):
            return repr(value)
        if isinstance(value, (int, float, bool, type(None))):
            return repr(value)
        # AI_NOTE: コンテナ・オブジェクトの再帰は3段まで。それ以深は型名だけにして表示爆発を防ぐ。
        if depth > 3:
            return f"<{type(value).__name__}>"
        tname = type(value).__name__
        if tname in self.templates:
            return self._apply_template(value, self.templates[tname], depth)
        if isinstance(value, dict):
            items = [f"{self._render(k, depth + 1)}: {self._render(v, depth + 1)}"
                     for k, v in list(value.items())[:MAX_ELEMS]]
            more = f", …+{len(value) - MAX_ELEMS}" if len(value) > MAX_ELEMS else ""
            return "{" + ", ".join(items) + more + "}"
        if isinstance(value, (list, tuple, set, frozenset)):
            open_c, close_c = ("[", "]") if isinstance(value, list) else ("(", ")") if isinstance(value, tuple) else ("{", "}")
            items = [self._render(v, depth + 1) for v in list(value)[:MAX_ELEMS]]
            more = f", …+{len(value) - MAX_ELEMS}" if len(value) > MAX_ELEMS else ""
            return open_c + ", ".join(items) + more + close_c
        try:
            rendered = repr(value)
            if not self._has_runtime_address(rendered):
                return rendered
            return self._public_state(value, depth) or self._remove_runtime_address(value, rendered)
        except Exception:
            return f"<{tname}>"

    def _summary(self, value: Any, limit: int, seen: set[int] | None = None) -> str:
        """長いreprを途中で切らず、型・識別子・件数へ意味的に縮める。"""
        if isinstance(value, str):
            if len(repr(value)) <= limit:
                return repr(value)
            preview = value[:max(1, limit - 3)]
            while len(repr(preview + "…")) > limit and len(preview) > 1:
                preview = preview[:-1]
            return repr(preview + "…")
        if isinstance(value, bytes):
            return repr(value) if len(repr(value)) <= limit else f"bytes({len(value)} bytes)"
        if isinstance(value, (int, float, bool, type(None))):
            return self._clip(repr(value), limit)

        seen = seen or set()
        marker = id(value)
        if marker in seen:
            return f"{type(value).__name__}(…)"
        seen.add(marker)

        if isinstance(value, dict):
            if not value:
                return "{}"
            first_key, first_value = next(iter(value.items()))
            first = f"{self._summary(first_key, 28, seen)}: {self._summary(first_value, 42, seen)}"
            suffix = ", …" if len(value) > 1 else ""
            return self._clip(f"dict[{len(value)}]({first}{suffix})", limit)
        if isinstance(value, (list, tuple, set, frozenset)):
            values = list(value)
            if not values:
                return "[]" if isinstance(value, list) else "()" if isinstance(value, tuple) else "{}"
            label = type(value).__name__
            first = self._summary(values[0], max(24, limit - len(label) - 10), seen)
            suffix = ", …" if len(values) > 1 else ""
            return self._clip(f"{label}[{len(values)}]({first}{suffix})", limit)

        attrs = getattr(value, "__dict__", None)
        public = [(name, item) for name, item in attrs.items() if not name.startswith("_")] if isinstance(attrs, dict) else []
        tname = type(value).__name__

        # 状態保持fake等は中身を再帰展開せず、各コレクションの件数を見せる。
        collection_parts = [
            f"{name}={len(item)}"
            for name, item in public
            if isinstance(item, (dict, list, tuple, set, frozenset))
        ]
        scalar_parts = [
            f"{name}={self._summary(item, 36, seen)}"
            for name, item in public
            if self._is_identity_attr(name) and isinstance(item, (str, int, float, bool, type(None)))
        ]
        parts = scalar_parts or collection_parts
        if not parts:
            parts = [f"{name}={rendered}" for name, rendered in self._nested_identity(value, seen)]
        return self._fit_object_summary(tname, parts, limit)

    def _is_identity_attr(self, name: str) -> bool:
        lowered = name.lower()
        return lowered in IDENTITY_ATTR_NAMES or lowered.endswith("_id") or lowered.endswith("_name")

    def _nested_identity(self, value: Any, seen: set[int], depth: int = 0) -> list[tuple[str, str]]:
        if depth > 3:
            return []
        attrs = getattr(value, "__dict__", None)
        if not isinstance(attrs, dict):
            return []
        found: list[tuple[str, str]] = []
        for name, item in attrs.items():
            if name.startswith("_"):
                continue
            if self._is_identity_attr(name) and isinstance(item, (str, int, float, bool, type(None))):
                if not any(existing == name for existing, _ in found):
                    found.append((name, self._summary(item, 36, seen)))
            elif not isinstance(item, (str, bytes, int, float, bool, type(None), dict, list, tuple, set, frozenset)):
                for nested_name, rendered in self._nested_identity(item, seen, depth + 1):
                    if not any(existing == nested_name for existing, _ in found):
                        found.append((nested_name, rendered))
            if len(found) >= MAX_ELEMS:
                break
        return found

    def _fit_object_summary(self, tname: str, parts: list[str], limit: int) -> str:
        if not parts:
            return f"{tname}()"
        kept: list[str] = []
        for part in parts:
            candidate = f"{tname}(" + ", ".join([*kept, part]) + ")"
            if len(candidate) > limit:
                break
            kept.append(part)
        if not kept:
            return f"{tname}(…)" if len(tname) + 3 <= limit else self._clip(tname, limit)
        omitted = len(kept) < len(parts)
        rendered = f"{tname}(" + ", ".join(kept) + (", …" if omitted else "") + ")"
        if len(rendered) > limit:
            rendered = f"{tname}(" + ", ".join(kept) + ")"
        return rendered

    def _public_state(self, value: Any, depth: int) -> str | None:
        """既定reprの代わりに、型名と安全に読める公開属性を短く示す。"""
        attrs = getattr(value, "__dict__", None)
        if not isinstance(attrs, dict):
            return None
        public = [(name, item) for name, item in attrs.items() if not name.startswith("_")]
        if not public:
            return None
        items = [f"{name}={self._render(item, depth + 1)}" for name, item in public[:MAX_ELEMS]]
        if len(public) > MAX_ELEMS:
            items.append(f"…+{len(public) - MAX_ELEMS}")
        return f"{type(value).__name__}(" + ", ".join(items) + ")"

    def _has_runtime_address(self, rendered: str) -> bool:
        return re.search(r"\s+at 0x[0-9a-fA-F]+(?=>)", rendered) is not None

    def _remove_runtime_address(self, value: Any, rendered: str) -> str:
        # Python既定の `<pkg.Type object at 0x...>` は型名だけにし、
        # iterator/function等の固有ラベルは残して不安定なアドレスだけを落とす。
        if isinstance(value, types.GeneratorType) or type(value).__name__.endswith("iterator"):
            return f"<{type(value).__name__}>"
        if re.fullmatch(r"<[^<>]+ object at 0x[0-9a-fA-F]+>", rendered):
            return f"{type(value).__name__}()"
        return re.sub(r"\s+at 0x[0-9a-fA-F]+(?=>)", "", rendered)

    def _apply_template(self, value: Any, template: str, depth: int) -> str:
        # AI_NOTE: {attr} を getattr の短縮表示で埋める。属性欠落・壊れたテンプレートは repr へフォールバック。
        def repl(m: re.Match[str]) -> str:
            try:
                return self._render(getattr(value, m.group(1)), depth + 1)
            except Exception:
                return "?"
        try:
            return re.sub(r"\{(\w+)\}", repl, template)
        except Exception:
            try:
                return repr(value)
            except Exception:
                return f"<{type(value).__name__}>"


class CallRecorder:
    """Record calls in the target source file without mixing child frames into line tracing."""

    def __init__(self, filename: str, renderer: ValueRenderer):
        self.filename = os.path.abspath(filename) if filename else ""
        self.renderer = renderer
        self.calls: list[dict[str, Any]] = []
        self._open: dict[int, dict[str, Any]] = {}
        self._depth = 0

    def profile(self, frame: FrameType, event: str, arg: Any):
        if not self.filename or os.path.abspath(frame.f_code.co_filename) != self.filename:
            return
        if event == "call":
            record = {
                "sequence": len(self.calls) + 1,
                "depth": self._depth,
                "function": frame.f_code.co_qualname,
                "line": frame.f_code.co_firstlineno,
                "arguments": {
                    name: {"short": self.renderer.short(value), "full": self.renderer.full(value)}
                    for name, value in frame.f_locals.items()
                    if not name.startswith("__") and name not in IMPLICIT_RECEIVERS
                },
                "return_value": None,
                "exception": None,
            }
            self.calls.append(record)
            self._open[id(frame)] = record
            self._depth += 1
        elif event == "exception":
            self.record_exception(frame, arg)
        elif event == "return":
            record = self._open.pop(id(frame), None)
            if record is not None:
                if record["exception"] is None:
                    record["return_value"] = {
                        "short": self.renderer.short(arg),
                        "full": self.renderer.full(arg),
                    }
                self._depth = max(0, self._depth - 1)

    def record_exception(self, frame: FrameType, arg: Any) -> None:
        record = self._open.get(id(frame))
        if record is None:
            return
        exc_type, exc_value, _ = arg
        record["exception"] = {
            "type": getattr(exc_type, "__name__", str(exc_type)),
            "message": str(exc_value),
        }

    def finalize_target_success(self, return_value: Any) -> None:
        """Clear a handled child exception from the completed outer target call."""
        if not self.calls:
            return
        target = self.calls[0]
        target["exception"] = None
        target["return_value"] = {
            "short": self.renderer.short(return_value),
            "full": self.renderer.full(return_value),
        }


class Tracer:
    """対象関数のフレームだけ line/return イベントを拾い、直前行の実行結果(ローカル変数の差分)を記録する。

    sys.settrace の 'line' は「その行を実行する直前」に来る。よってイベント時点のローカルは
    「前イベントの行を実行し終えた結果」であり、差分は前イベントの行(prev)に帰属させる。
    周回: ループヘッダ行のイベントで周回カウンタを進め、内側ループのカウンタをリセットする。
    """

    def __init__(self, code_name: str, loops: list[dict[str, Any]], control_points: list[dict[str, Any]], renderer: ValueRenderer, func_line_start: int, call_recorder: CallRecorder):
        self.code_name = code_name
        self.loops = loops
        self.renderer = renderer
        self.control_points = control_points
        self.call_recorder = call_recorder
        # AI_NOTE: def行の行番号。最初のイベントで引数の初期値をこの行のstepとして出す(入力例の表示に使う)。
        self.func_line_start = func_line_start
        self.steps: list[dict[str, Any]] = []
        self.return_value: Any = None
        self.has_return = False
        self.overflow = False
        self.prev_line: int | None = None
        self.prev_iter_path: list[list[int]] = []
        # AI_NOTE: 変数名 → full表現。同一性(is)比較では grouped[key]=... のようなin-place変更を
        # 見逃すため、表現文字列の変化で「この行で値が変わった」を判定する。
        self.prev_repr: dict[str, str] = {}
        # AI_NOTE: loop_id → 現在の周回番号。親の周回が進んだらリセットされる。
        self.counters: dict[int, int] = {}
        self.target_frame: FrameType | None = None
        self.executed_lines: list[int] = []
        self.path_events: list[dict[str, Any]] = []
        self.assertion_events: list[dict[str, Any]] = []
        self.prev_assert_failed = False
        self.final_locals: dict[str, dict[str, str]] = {}

    def _loop_of_header(self, line: int) -> dict[str, Any] | None:
        for lp in self.loops:
            if lp["header_line"] == line:
                return lp
        return None

    def _iter_path_for(self, line: int) -> list[list[int]]:
        """この行を囲むループ列(外→内)の現在周回。ヘッダ行はそのループ自身も含む。"""
        path: list[list[int]] = []
        for lp in self.loops:
            inside_body = lp["body_start"] <= line <= lp["body_end"]
            on_header = line == lp["header_line"]
            if (inside_body or on_header) and lp["id"] in self.counters:
                path.append([lp["id"], self.counters[lp["id"]]])
        return path

    def _reset_children(self, loop_id: int) -> None:
        for lp in self.loops:
            if lp["parent"] == loop_id:
                self.counters.pop(lp["id"], None)
                self._reset_children(lp["id"])

    def _flush_prev(self, now_locals: dict[str, Any]) -> None:
        """前イベント行の実行で変わった変数を step として積む。"""
        now_repr: dict[str, str] = {}
        changed: dict[str, dict[str, str]] = {}
        for name, val in now_locals.items():
            if name.startswith("__") or name in IMPLICIT_RECEIVERS:
                continue
            full = self.renderer.full(val)
            now_repr[name] = full
            if self.prev_repr.get(name) != full:
                changed[name] = {"short": self.renderer.short(val), "full": full}
        if self.prev_line is None:
            # AI_NOTE: 最初のイベント=まだ1行も実行していない。この時点のローカル=引数なので def行のstepとして出す。
            if changed:
                self.steps.append({"line": self.func_line_start, "iter_path": [], "changed": changed})
        elif changed or self._loop_of_header(self.prev_line):
            self.steps.append({"line": self.prev_line, "iter_path": self.prev_iter_path, "changed": changed})
        self.prev_repr = now_repr

    def trace(self, frame: FrameType, event: str, arg: Any):
        if event == "call":
            # AI_NOTE: 対象関数の最初の呼び出しフレームだけ追う(再帰・内部呼び出しの2枚目以降は追わない)。
            if frame.f_code.co_name == self.code_name and self.target_frame is None:
                self.target_frame = frame
                return self.trace
            return self.trace
        if frame is not self.target_frame:
            if event == "exception":
                self.call_recorder.record_exception(frame, arg)
            return self.trace
        if len(self.steps) >= MAX_STEPS:
            self.overflow = True
            return None
        if event == "line":
            line = frame.f_lineno
            if line not in self.executed_lines:
                self.executed_lines.append(line)
            if self.prev_line is not None:
                decision = next((point for point in self.control_points if point["kind"] == "if" and point["line"] == self.prev_line), None)
                if decision is not None:
                    self.path_events.append({
                        "line": self.prev_line,
                        "kind": "if",
                        "outcome": decision["body_start"] <= line <= decision["body_end"],
                        "iter_path": self.prev_iter_path,
                    })
                assertion = next((point for point in self.control_points if point["kind"] == "assert" and point["line"] == self.prev_line), None)
                if assertion is not None and not self.prev_assert_failed:
                    self.assertion_events.append({
                        "line": self.prev_line,
                        "kind": "assert",
                        "method": "assert",
                        "outcome": True,
                        "iter_path": self.prev_iter_path,
                    })
                self.prev_assert_failed = False
            self._flush_prev(frame.f_locals)
            lp = self._loop_of_header(line)
            if lp is not None:
                self.counters[lp["id"]] = self.counters.get(lp["id"], 0) + 1
                self._reset_children(lp["id"])
            self.prev_line = line
            self.prev_iter_path = self._iter_path_for(line)
        elif event == "exception":
            self.call_recorder.record_exception(frame, arg)
            exc_type, exc_value, _ = arg
            assertion = next((point for point in self.control_points if point["kind"] == "assert" and point["line"] == self.prev_line), None)
            if assertion is not None and isinstance(exc_value, AssertionError):
                self.assertion_events.append({
                    "line": self.prev_line,
                    "kind": "assert",
                    "method": "assert",
                    "outcome": False,
                    "iter_path": self.prev_iter_path,
                    "exception": {"type": getattr(exc_type, "__name__", "AssertionError"), "message": str(exc_value)},
                })
                self.prev_assert_failed = True
        elif event == "return":
            assertion = next((point for point in self.control_points if point["kind"] == "assert" and point["line"] == self.prev_line), None)
            if assertion is not None and not self.prev_assert_failed:
                self.assertion_events.append({
                    "line": self.prev_line,
                    "kind": "assert",
                    "method": "assert",
                    "outcome": True,
                    "iter_path": self.prev_iter_path,
                })
            self._flush_prev(frame.f_locals)
            self.final_locals = {
                name: {"short": self.renderer.short(value), "full": self.renderer.full(value)}
                for name, value in frame.f_locals.items()
                if not name.startswith("__") and name not in IMPLICIT_RECEIVERS
            }
            self.return_value = arg
            self.has_return = True
            self.target_frame = None
        return self.trace


def build_iter_counts(steps: list[dict[str, Any]], loops: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """本体行が実際に実行された周回だけ数える(ヘッダの終了判定実行で+1された空周回を除外)。

    キー: loop_id(str) → 親側 iter_path の "id:iter,id:iter" 文字列(""=最外) → 周回数。
    """
    counts: dict[str, dict[str, int]] = {}
    body_range = {lp["id"]: (lp["body_start"], lp["body_end"]) for lp in loops}
    for st in steps:
        path = st["iter_path"]
        for i, (loop_id, iter_no) in enumerate(path):
            lo, hi = body_range[loop_id]
            on_body = lo <= st["line"] <= hi
            if not on_body:
                continue
            parent_key = ",".join(f"{lid}:{it}" for lid, it in path[:i])
            per_parent = counts.setdefault(str(loop_id), {})
            per_parent[parent_key] = max(per_parent.get(parent_key, 0), iter_no)
    return counts


def build_import_context(file_path: str, workspace_root: str) -> tuple[str, str]:
    """対象ファイルの import 解決環境を再現し、(モジュール完全名, パッケージルート) を返す。

    __init__.py を上に辿れるだけ辿った所がパッケージ境界。その外側を sys.path に置くことで、
    通常の実行と同じ絶対import(`import comiket.x`)と相対import(`from . import x`)が両方通る。
    """
    abs_path = os.path.abspath(file_path)
    directory = os.path.dirname(abs_path)
    parts = [os.path.splitext(os.path.basename(abs_path))[0]]
    root = directory
    while os.path.isfile(os.path.join(root, "__init__.py")):
        parts.insert(0, os.path.basename(root))
        parent = os.path.dirname(root)
        if parent == root:
            break
        root = parent
    if root not in sys.path:
        sys.path.insert(0, root)
    # AI_NOTE: パッケージ外のスクリプト(scripts/x.py から import comiket 等)を救う保険。
    # 末尾に足すのは、同名モジュールの解決順を通常実行と変えないため。
    if workspace_root and workspace_root not in sys.path:
        sys.path.append(workspace_root)
    return ".".join(parts), root


def run(payload: dict[str, Any]) -> dict[str, Any]:
    install_sandbox_guard()
    source: str = payload["source"]
    func_name: str = payload["func_name"]
    setup: str = payload.get("setup", "")
    templates: dict[str, str] = payload.get("templates", {})
    file_path: str = payload.get("file_path", "")
    workspace_root: str = payload.get("workspace_root", "")

    tree = ast.parse(source)
    func = find_function(tree, func_name)
    if func is None:
        return {"error": f"関数 {func_name} が見つかりません"}
    loops = collect_loops(func)
    control_points = collect_control_points(func)
    renderer = ValueRenderer(templates)

    # AI_NOTE: 対象ファイルを「本来の位置にある本来のモジュール」として実行する。エディタ上の未保存を
    # 含む source を使うのでファイルからは import せず、名前・パッケージ・__file__ だけ実物に揃える。
    # dataclass等が sys.modules[cls.__module__] を引くので、名前空間は実モジュールとして登録する。
    module_name = "__ai_code_guide_trace__"
    package = ""
    if file_path:
        module_name, _ = build_import_context(file_path, workspace_root)
        package = module_name.rpartition(".")[0]
    mod = types.ModuleType(module_name)
    mod.__file__ = os.path.abspath(file_path) if file_path else None
    mod.__package__ = package
    sys.modules[module_name] = mod
    namespace: dict[str, Any] = mod.__dict__
    # AI_NOTE: 対象モジュール実行→準備コード実行→トレース本番、の3段。print等の出力は捨てて壊れたJSONを防ぐ。
    with redirect_stdout(io.StringIO()):
        # AI_NOTE: 相対import は sys.modules 上の親パッケージを起点に解決されるため、先に実import する。
        if package:
            try:
                importlib.import_module(package)
            except Exception as e:
                return {"error": f"親パッケージ {package} の読み込みに失敗: {type(e).__name__}: {e}"}
        try:
            exec(compile(source, mod.__file__ or "<target>", "exec"), namespace)
        except ModuleNotFoundError as e:
            return {"error": f"対象ファイルの実行に失敗: モジュール {e.name} が見つかりません（実行位置: {sys.path[0]}）"}
        except Exception as e:
            return {"error": f"対象ファイルの実行に失敗: {type(e).__name__}: {e}"}
        try:
            exec(compile(setup, "<setup>", "exec"), namespace)
        except Exception as e:
            return {"error": f"準備コードの実行に失敗: {type(e).__name__}: {e}", "stage": "setup"}

        if "EXAMPLE_ARGS" not in namespace:
            return {"error": "準備コードが EXAMPLE_ARGS を定義していません", "stage": "setup"}
        args = namespace["EXAMPLE_ARGS"]
        kwargs = namespace.get("EXAMPLE_KWARGS", {})
        target, test_case, target_error = resolve_target(namespace, func_name)
        if target_error:
            return {"error": target_error, "stage": "setup"}

        call_recorder = CallRecorder(mod.__file__ or "", renderer)
        tracer = Tracer(func.name, loops, control_points, renderer, func.lineno, call_recorder)
        assertion_recorder = AssertionRecorder(renderer, lambda: tracer.prev_iter_path)
        assertion_recorder.install(test_case)
        previous_profile = sys.getprofile()

        def chained_profile(frame: FrameType, event: str, arg: Any):
            # Acceptance/observability profiles are evaluator- or host-owned.
            # Preserve them while adding our own call recorder; replacing the
            # active hook would make an executed call invisible externally.
            if previous_profile is not None:
                previous_profile(frame, event, arg)
            return call_recorder.profile(frame, event, arg)

        sys.settrace(tracer.trace)
        sys.setprofile(chained_profile)
        execution_error: Exception | None = None
        try:
            target(*args, **kwargs)
        except Exception as e:
            execution_error = e
        finally:
            sys.settrace(None)
            sys.setprofile(previous_profile)
            if test_case is not None:
                try:
                    test_case.tearDown()
                except Exception as e:
                    if execution_error is None:
                        execution_error = e
                try:
                    test_case.doCleanups()
                except Exception as e:
                    if execution_error is None:
                        execution_error = e
            assertion_recorder.restore(test_case)
        if execution_error is None and tracer.has_return:
            call_recorder.finalize_target_success(tracer.return_value)
        assertion_events = sorted(
            [*tracer.assertion_events, *assertion_recorder.events],
            key=lambda event: (event["line"], len(event.get("iter_path", []))),
        )
        if execution_error is not None:
            return {
                "error": f"実行中に例外: {type(execution_error).__name__}: {execution_error}",
                "stage": "run",
                "steps": tracer.steps,
                "loops": loops,
                "iter_counts": build_iter_counts(tracer.steps, loops),
                "return_value": None,
                # Keep the source envelope identical to a successful trace so
                # exception cards can still render code, line numbers, syntax
                # colors, and an exact jump target.
                "func_line_start": func.lineno,
                "func_line_end": func.end_lineno or func.lineno,
                "overflow": tracer.overflow,
                "calls": call_recorder.calls,
                "control_points": control_points,
                "executed_lines": tracer.executed_lines,
                "path_events": tracer.path_events,
                "final_locals": tracer.final_locals,
                "assertions": assertion_events,
            }

    return {
        "loops": loops,
        "steps": tracer.steps,
        "iter_counts": build_iter_counts(tracer.steps, loops),
        "return_value": {
            "short": renderer.short(tracer.return_value),
            "full": renderer.full(tracer.return_value),
        } if tracer.has_return else None,
        "func_line_start": func.lineno,
        "func_line_end": func.end_lineno or func.lineno,
        "overflow": tracer.overflow,
        "calls": call_recorder.calls,
        "control_points": control_points,
        "executed_lines": tracer.executed_lines,
        "path_events": tracer.path_events,
        "final_locals": tracer.final_locals,
        "assertions": assertion_events,
        "error": None,
    }


def main() -> None:
    # The extension protocol is UTF-8 JSON even when Windows inherits a legacy
    # console code page.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    payload = json.loads(sys.stdin.read())
    try:
        result = run(payload)
    except Exception as e:  # AI_NOTE: 最外の安全弁。どんな失敗でもJSONで返し、拡張側のparseを壊さない。
        result = {"error": f"{type(e).__name__}: {e}"}
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
