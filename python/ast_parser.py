#!/usr/bin/env python3
"""Parse Python AST and emit flowchart-compatible JSON."""

# AI_NOTE: #10 注釈を遅延評価(文字列化)する。GUI起動のVSCodeはPATH上のpython3が
# システムの3.9に解決されることがあり、`X | Y`(PEP604)型注釈を実行時に評価すると
# TypeError で落ちていた。これで 3.7+ でも注釈は評価されず安全になる。
from __future__ import annotations

import ast
import json
import sys
import textwrap
from typing import Any, Optional


def make_node(
    node_id: str,
    kind: str,
    label: str,
    line_start: int,
    line_end: int,
    children: Optional[list[str]] = None,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "kind": kind,
        "label": label,
        # VS Code Position/GraphNode contract is zero-based. Python AST lineno/end_lineno are one-based.
        "lineStart": max(0, line_start - 1),
        "lineEnd": max(0, line_end - 1),
        "children": children or [],
    }


class FlowchartBuilder(ast.NodeVisitor):
    def __init__(self, granularity: str = "normal") -> None:
        self.nodes: list[dict[str, Any]] = []
        self.edges: list[dict[str, str]] = []
        self.granularity = granularity
        self._counter = 0
        self._scope_stack: list[str] = []

    def _new_id(self, prefix: str = "n") -> str:
        self._counter += 1
        return f"{prefix}_{self._counter}"

    def _current_scope(self) -> Optional[str]:
        return self._scope_stack[-1] if self._scope_stack else None

    def _add_edge(self, from_id: str, to_id: str, label: str = "") -> None:
        self.edges.append({"from": from_id, "to": to_id, "label": label})

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        args = [a.arg for a in node.args.args]
        label = f"{node.name}({', '.join(args)})"
        node_id = self._new_id("func")
        end_line = node.end_lineno if hasattr(node, "end_lineno") else node.lineno
        fn_node = make_node(node_id, "function", label, node.lineno, end_line)
        self.nodes.append(fn_node)

        parent = self._current_scope()
        if parent:
            self._add_edge(parent, node_id)

        self._scope_stack.append(node_id)
        if self.granularity in ("normal", "detail"):
            self.generic_visit(node)
        self._scope_stack.pop()

    visit_AsyncFunctionDef = visit_FunctionDef  # type: ignore[assignment]

    def _visit_module_constant(self, node: ast.Assign | ast.AnnAssign) -> None:
        # Standard/overview inventory includes only named module constants. Function-local
        # assignments remain control-flow details and must not become top-level cards.
        if self._current_scope():
            return
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        names = [target.id for target in targets if isinstance(target, ast.Name)]
        if not names or not all(name.isupper() for name in names):
            return
        node_id = self._new_id("const")
        end_line = node.end_lineno if hasattr(node, "end_lineno") else node.lineno
        self.nodes.append(make_node(node_id, "constant", " = ".join(names), node.lineno, end_line))

    def visit_Assign(self, node: ast.Assign) -> None:
        self._visit_module_constant(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        self._visit_module_constant(node)

    def visit_If(self, node: ast.If) -> None:
        if self.granularity == "coarse":
            return
        try:
            cond_src = ast.unparse(node.test)
        except Exception:
            cond_src = "condition"
        label = f"if {cond_src}"
        node_id = self._new_id("if")
        end_line = node.end_lineno if hasattr(node, "end_lineno") else node.lineno
        self.nodes.append(make_node(node_id, "condition", label, node.lineno, end_line))

        parent = self._current_scope()
        if parent:
            self._add_edge(parent, node_id)

        self._scope_stack.append(node_id)
        for child in node.body:
            self.visit(child)
        self._scope_stack.pop()

        if node.orelse:
            else_id = self._new_id("else")
            self.nodes.append(make_node(else_id, "condition", "else", node.lineno, end_line))
            self._add_edge(node_id, else_id, "else")
            self._scope_stack.append(else_id)
            for child in node.orelse:
                self.visit(child)
            self._scope_stack.pop()

    def visit_For(self, node: ast.For) -> None:
        if self.granularity == "coarse":
            return
        try:
            target_src = ast.unparse(node.target)
            iter_src = ast.unparse(node.iter)
        except Exception:
            target_src, iter_src = "item", "iterable"
        label = f"for {target_src} in {iter_src}"
        node_id = self._new_id("for")
        end_line = node.end_lineno if hasattr(node, "end_lineno") else node.lineno
        self.nodes.append(make_node(node_id, "loop", label, node.lineno, end_line))

        parent = self._current_scope()
        if parent:
            self._add_edge(parent, node_id)

        self._scope_stack.append(node_id)
        if self.granularity == "detail":
            self.generic_visit(node)
        self._scope_stack.pop()

    def visit_While(self, node: ast.While) -> None:
        if self.granularity == "coarse":
            return
        try:
            cond_src = ast.unparse(node.test)
        except Exception:
            cond_src = "condition"
        label = f"while {cond_src}"
        node_id = self._new_id("while")
        end_line = node.end_lineno if hasattr(node, "end_lineno") else node.lineno
        self.nodes.append(make_node(node_id, "loop", label, node.lineno, end_line))

        parent = self._current_scope()
        if parent:
            self._add_edge(parent, node_id)

        self._scope_stack.append(node_id)
        if self.granularity == "detail":
            self.generic_visit(node)
        self._scope_stack.pop()

    def visit_Return(self, node: ast.Return) -> None:
        if self.granularity == "coarse":
            return
        try:
            val_src = ast.unparse(node.value) if node.value else "None"
        except Exception:
            val_src = "value"
        label = f"return {val_src}"
        node_id = self._new_id("ret")
        self.nodes.append(make_node(node_id, "return", label, node.lineno, node.lineno))

        parent = self._current_scope()
        if parent:
            self._add_edge(parent, node_id)

    def visit_Raise(self, node: ast.Raise) -> None:
        if self.granularity != "detail":
            return
        try:
            exc_src = ast.unparse(node.exc) if node.exc else "Exception"
        except Exception:
            exc_src = "Exception"
        label = f"raise {exc_src}"
        node_id = self._new_id("raise")
        self.nodes.append(make_node(node_id, "raise", label, node.lineno, node.lineno))

        parent = self._current_scope()
        if parent:
            self._add_edge(parent, node_id)


def build_module_overview(tree: ast.Module) -> list[dict[str, Any]]:
    """Coarse: one node per top-level definition or named constant."""
    nodes = []
    edges = []
    prev_id = None
    for i, node in enumerate(tree.body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kind = "class" if isinstance(node, ast.ClassDef) else "function"
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                try:
                    signature = ast.unparse(node.args)
                except Exception:
                    signature = ", ".join(a.arg for a in node.args.args)
                label = f"{node.name}({signature})"
            else:
                label = node.name
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [target.id for target in targets if isinstance(target, ast.Name)]
            if not names or not all(name.isupper() for name in names):
                continue
            kind = "constant"
            label = " = ".join(names)
        else:
            continue
        end_line = node.end_lineno if hasattr(node, "end_lineno") else node.lineno
        node_id = f"top_{i}"
        nodes.append(make_node(node_id, kind, label, node.lineno, end_line))
        if prev_id:
            edges.append({"from": prev_id, "to": node_id, "label": ""})
        prev_id = node_id
    return nodes, edges  # type: ignore[return-value]


def parse(source: str, granularity: str = "normal", target_func: str = "") -> dict[str, Any]:
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"error": f"SyntaxError: {e}", "nodes": [], "edges": []}

    if granularity == "coarse":
        nodes, edges = build_module_overview(tree)
        return {"nodes": nodes, "edges": edges}

    builder = FlowchartBuilder(granularity=granularity)

    if target_func:
        # only visit matching function
        for node in ast.walk(tree):
            if (
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == target_func
            ):
                builder.visit(node)
    else:
        builder.visit(tree)

    return {"nodes": builder.nodes, "edges": builder.edges}


class CFGBuilder:
    """制御フローグラフを構築する。連続文をブロックにまとめ、if/for/while/tryを分岐ノードにする。"""

    def __init__(self, lines: list[str], id_prefix: str = "", merge_seq: bool = True) -> None:
        self.lines = lines
        self.nodes: list[dict[str, Any]] = []
        self.edges: list[dict[str, str]] = []
        self._counter = 0
        self._id_prefix = id_prefix
        self._merge_seq = merge_seq

    def _new_id(self, prefix: str) -> str:
        self._counter += 1
        return f"{self._id_prefix}{prefix}_{self._counter}"

    def _add_node(self, kind: str, label: str, line_start: int, line_end: int) -> str:
        nid = self._new_id(kind[0])
        self.nodes.append({
            "id": nid, "kind": kind, "label": label,
            "lineStart": line_start - 1, "lineEnd": line_end - 1,
        })
        return nid

    def _add_edge(self, from_id: str, to_id: str, label: str = "") -> None:
        self.edges.append({"from": from_id, "to": to_id, "label": label})

    def _seq_label(self, stmts: list[Any]) -> tuple[str, bool]:
        """(label, from_comment) を返す。from_comment=True ならAI生成をスキップしてよい。"""
        first_lineno = stmts[0].lineno
        for back in range(1, 4):
            idx = first_lineno - 1 - back
            if idx < 0:
                break
            raw = self.lines[idx].strip()
            if not raw:
                continue
            if raw.startswith("#"):
                return raw.lstrip("#").strip(), True
            break
        try:
            return ast.unparse(stmts[0])[:40], False
        except Exception:
            return "処理", False

    def build(self, func_node: Any) -> dict[str, Any]:
        args = [a.arg for a in func_node.args.args]
        entry_id = self._add_node(
            "entry", f"{func_node.name}({', '.join(args)})",
            func_node.lineno, func_node.lineno,
        )
        self._process(func_node.body, [(entry_id, "")])
        return {"nodes": self.nodes, "edges": self.edges}

    def build_stmts(self, stmts: list[Any], label: str = "__main__") -> dict[str, Any]:
        """関数の外にある文のリストからCFGを構築する。"""
        first_line = stmts[0].lineno if stmts else 1
        last_line = stmts[-1].end_lineno if stmts and hasattr(stmts[-1], "end_lineno") else first_line
        entry_id = self._add_node("entry", label, first_line, last_line)
        self._process(stmts, [(entry_id, "")])
        return {"nodes": self.nodes, "edges": self.edges}

    def _process(self, stmts: list[Any], incoming: list[tuple[str, str]]) -> list[tuple[str, str]]:
        """incoming/return: [(node_id, edge_label)]"""
        current: list[tuple[str, str]] = list(incoming)
        buf: list[Any] = []

        def flush() -> None:
            if not buf:
                return
            # AI_NOTE: 空行でbufをサブグループに分割し、意味単位ごとに別ノードにする
            groups: list[list[Any]] = [[buf[0]]]
            for i in range(1, len(buf)):
                prev_end = buf[i - 1].end_lineno if hasattr(buf[i - 1], "end_lineno") else buf[i - 1].lineno
                curr_start = buf[i].lineno
                has_blank = any(
                    l < len(self.lines) and not self.lines[l].strip()
                    for l in range(prev_end, curr_start - 1)
                )
                if has_blank:
                    groups.append([buf[i]])
                else:
                    groups[-1].append(buf[i])
            for group in groups:
                first, last = group[0], group[-1]
                label, from_comment = self._seq_label(group)
                end = last.end_lineno if hasattr(last, "end_lineno") else last.lineno
                nid = self._add_node("block", label, first.lineno, end)
                self.nodes[-1]["fromComment"] = from_comment
                for fid, el in current:
                    self._add_edge(fid, nid, el)
                current.clear()
                current.append((nid, ""))
            buf.clear()

        for stmt in stmts:
            if isinstance(stmt, (ast.Return, ast.Raise)):
                flush()
                end = stmt.end_lineno if hasattr(stmt, "end_lineno") else stmt.lineno
                try:
                    label = ast.unparse(stmt)[:50]
                except Exception:
                    label = "return" if isinstance(stmt, ast.Return) else "raise"
                nid = self._add_node("return", label, stmt.lineno, end)
                for fid, el in current:
                    self._add_edge(fid, nid, el)
                current.clear()

            elif isinstance(stmt, ast.If):
                flush()
                end = stmt.end_lineno if hasattr(stmt, "end_lineno") else stmt.lineno
                try:
                    cond_src = ast.unparse(stmt.test)[:40]
                except Exception:
                    cond_src = "condition"

                cond_id = self._add_node("condition", f"if {cond_src}", stmt.lineno, end)
                for fid, el in current:
                    self._add_edge(fid, cond_id, el)
                true_exits = self._process(stmt.body, [(cond_id, "Yes")])
                if stmt.orelse:
                    false_exits = self._process(stmt.orelse, [(cond_id, "No")])
                else:
                    false_exits = [(cond_id, "No")]
                current.clear()
                current.extend(true_exits + false_exits)

            elif isinstance(stmt, (ast.For, ast.While)):
                flush()
                end = stmt.end_lineno if hasattr(stmt, "end_lineno") else stmt.lineno
                try:
                    if isinstance(stmt, ast.For):
                        label = f"for {ast.unparse(stmt.target)} in {ast.unparse(stmt.iter)}"[:50]
                    else:
                        label = f"while {ast.unparse(stmt.test)}"[:50]
                except Exception:
                    label = "loop"
                loop_id = self._add_node("loop", label, stmt.lineno, end)
                for fid, el in current:
                    self._add_edge(fid, loop_id, el)
                body_exits = self._process(stmt.body, [(loop_id, "繰り返し")])
                # AI_NOTE: 本体の末尾からループ先頭へ戻す(これが無いと本体が行き止まりになる)。
                # return/raise で抜けた枝は body_exits に残らないので戻り辺も張られない
                for fid, el in body_exits:
                    self._add_edge(fid, loop_id, el)
                # ループ終了後は loop_id からも抜ける
                current.clear()
                current.append((loop_id, "終了"))

            elif isinstance(stmt, ast.Try):
                flush()
                end = stmt.end_lineno if hasattr(stmt, "end_lineno") else stmt.lineno
                try_id = self._add_node("block", "try", stmt.lineno, end)
                for fid, el in current:
                    self._add_edge(fid, try_id, el)
                try_exits = self._process(stmt.body, [(try_id, "")])
                all_exits = list(try_exits)
                for handler in stmt.handlers:
                    exc = f"except {handler.type.id}" if handler.type and isinstance(handler.type, ast.Name) else "except"
                    all_exits.extend(self._process(handler.body, [(try_id, exc)]))
                current.clear()
                current.extend(all_exits)

            else:
                buf.append(stmt)
                if not self._merge_seq:
                    flush()

        flush()
        return current


def extract_stmt_spans(source: str) -> list[dict[str, int]]:
    # AI_NOTE: 全ast.stmtの行範囲(0-indexed)を返す。LLMが提案したブロック行範囲を
    # 実際の文境界にスナップするための「正解データ」として使う(annotationResolverと同じ発想)。
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    spans: list[dict[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.stmt):
            start = node.lineno - 1
            end = (node.end_lineno - 1) if hasattr(node, "end_lineno") and node.end_lineno else start
            spans.append({"start": start, "end": end})
    return spans


def _is_main_block(node: Any) -> bool:
    """if __name__ == '__main__': かどうかを判定する。"""
    return (
        isinstance(node, ast.If)
        and isinstance(node.test, ast.Compare)
        and isinstance(node.test.left, ast.Name)
        and node.test.left.id == "__name__"
        and len(node.test.comparators) == 1
        and isinstance(node.test.comparators[0], ast.Constant)
        and node.test.comparators[0].value == "__main__"
    )


def _toplevel_group_label(stmts: list[Any]) -> str:
    """連続するトップレベル文を束ねたカードの見出し。代入なら変数名を列挙する(import カードと同じ思想)。

    単独文は従来どおりその文の unparse。複数なら「変数: a, b, c」、代入以外が混じる時は先頭+件数。
    """
    if len(stmts) == 1:
        try:
            return ast.unparse(stmts[0])[:50]
        except Exception:
            return "定義"
    names: list[str] = []
    for s in stmts:
        targets = (
            s.targets if isinstance(s, ast.Assign)
            else [s.target] if isinstance(s, (ast.AnnAssign, ast.AugAssign))
            else []
        )
        for t in targets:
            if isinstance(t, ast.Name) and t.id not in names:
                names.append(t.id)
    if names:
        label = "変数: " + ", ".join(names)
    else:
        try:
            head = ast.unparse(stmts[0])[:30]
        except Exception:
            head = "処理"
        label = f"{head} ほか{len(stmts) - 1}件"
    return label if len(label) <= 50 else label[:47] + "..."


def build_module_map(tree: ast.Module, lines: list[str]) -> dict[str, Any]:
    """モジュールのコールグラフを返す。関数間の実際の呼び出し関係だけを矢印で示す。

    関数選択前（カーソルがどの関数にも属さない位置）に表示するファイル概要用。
    順次定義されているという理由だけの矢印は持たない。
    """
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    relationships: list[dict[str, Any]] = []
    counter = 0

    def new_id(prefix: str) -> str:
        nonlocal counter
        counter += 1
        return f"m{prefix}_{counter}"

    def add_node(kind: str, label: str, line_start: int, line_end: int, parent: Optional[str] = None) -> str:
        nid = new_id(kind[0])
        node: dict[str, Any] = {
            "id": nid, "kind": kind, "label": label,
            "lineStart": line_start - 1, "lineEnd": line_end - 1,
        }
        # AI_NOTE: クラスのメソッド/ネストクラスは親クラスidをparentに持たせ、標準ビューで階層描画する
        if parent:
            node["parent"] = parent
        nodes.append(node)
        return nid

    if not tree.body:
        return {"nodes": [], "edges": []}

    # AI_NOTE: ローカル関数名のセット。呼び出し解析の対象をファイル内定義に限定する
    local_func_names: set[str] = {
        n.name for n in tree.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    }

    # AI_NOTE: ネストした関数定義の内部には入らずローカル呼び出しを収集する。
    # callee名→最初の呼び出し行(1-based)を返す。行は標準ビューで「どのサブブロックから矢印を出すか」に使う。
    def find_local_calls(stmts: list[Any]) -> dict[str, int]:
        result: dict[str, int] = {}

        def walk(node: Any) -> None:
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue  # ネストした関数定義の中は見ない
                if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                    name = child.func.id
                    if name in local_func_names and name not in result:
                        result[name] = child.lineno
                walk(child)

        for stmt in stmts:
            if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                walk(stmt)
        return result

    # AI_NOTE: entry ノードは docstring がある場合のみその行範囲に限定する
    # ファイル全体をspanすると他のノードカードと重なってテキストが隠れるため
    docstring = ast.get_docstring(tree)
    entry_label = docstring.split("\n")[0][:50] if docstring else "モジュール概要"
    if docstring and tree.body and isinstance(tree.body[0], ast.Expr):
        doc_stmt = tree.body[0]
        entry_start = doc_stmt.lineno
        entry_end = getattr(doc_stmt, "end_lineno", doc_stmt.lineno)
    else:
        # docstring なし: 最初の文の1行目だけ（import やdef の先頭行）
        entry_start = tree.body[0].lineno if tree.body else 1
        entry_end = entry_start
    add_node("entry", entry_label, entry_start, entry_end)

    # AI_NOTE: importは脇役カードとして出すだけ。entry→import の矢印は「実際の呼び出し関係だけ示す」という
    # この関数の建前と矛盾し、何からも呼ばれない読込が呼ばれているように誤読させるため張らない。
    import_stmts = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    if import_stmts:
        first_imp, last_imp = import_stmts[0], import_stmts[-1]
        names: list[str] = []
        seen: set[str] = set()
        for n in import_stmts:
            tops = [a.name.split(".")[0] for a in n.names] if isinstance(n, ast.Import) else ([n.module.split(".")[0]] if n.module else [])
            for t in tops:
                if t not in seen:
                    seen.add(t)
                    names.append(t)
        label = "import " + ", ".join(names)
        if len(label) > 50:
            label = label[:47] + "..."
        add_node("block", label, first_imp.lineno, getattr(last_imp, "end_lineno", last_imp.lineno))

    # 関数・クラス・mainノードを作成し name→id マップを保持する
    func_id_map: dict[str, str] = {}
    main_node_id: Optional[str] = None

    # AI_NOTE: 関数/クラスをノード化する。クラスはコンテナとして本体のメソッド・ネストクラスを
    # parent付き子ノードに再帰展開する。モジュール本体とクラス本体は同型({関数,クラス,文})なので
    # 同じ再帰で扱え、ネストクラス(Django Meta / Pydantic Config など)も特別扱いなしで処理される。
    def add_def(stmt: Any, parent: Optional[str]) -> str:
        end = getattr(stmt, "end_lineno", stmt.lineno)
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            try:
                signature = ast.unparse(stmt.args)
            except Exception:
                signature = ", ".join(a.arg for a in stmt.args.args)
            return add_node("function", f"{stmt.name}({signature})", stmt.lineno, end, parent)
        # AI_NOTE: クラスは本体全体をspanする。Enum/dataclass/クラス変数のようにメソッドを持たない
        # クラスでも本体が塗られるようにするため(ヘッダのみだと宣言1行しか色が付かない)。
        # メソッド等の子ノードは背景塗りをスキップする(applyDecorations)ので二重塗りにはならない。
        cid = add_node("class", f"class {stmt.name}", stmt.lineno, end, parent)
        for child in stmt.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                add_def(child, cid)
        return cid

    # AI_NOTE: 連続するトップレベルの単純文(変数定義・設定呼び出し等)は import と同じ思想で1枚のカードに束ねる。
    # 1文=1カードだと変数定義が縦にカード分割され、構造が読めなくなるため。func/class/main/import/docstring に
    # 当たった時点で pending を確定(flush)し、その手前までの連続文だけを1枚にまとめる。
    pending: list[Any] = []

    def flush_pending() -> None:
        if not pending:
            return
        first, last = pending[0], pending[-1]
        end = getattr(last, "end_lineno", last.lineno)
        add_node("block", _toplevel_group_label(pending), first.lineno, end)
        pending.clear()

    for stmt in tree.body:
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
            flush_pending()
            continue  # docstring/文字列文はスキップ(束ねを切る)
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            flush_pending()
            continue  # import は上で1枚に集約済み

        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            flush_pending()
            # AI_NOTE: トップレベルのみ func_id_map に登録しエッジ対象にする。メソッドは呼び出し解析(self.x)
            # 未対応のためマップに入れない(名前衝突でエッジ先が誤る事故も防ぐ)
            func_id_map[stmt.name] = add_def(stmt, None)

        elif _is_main_block(stmt):
            flush_pending()
            # AI_NOTE: blockにすることでLLMが本文を読んで何をやっているかの説明を生成する
            main_node_id = add_node("block", "if __name__ == '__main__'", stmt.lineno, getattr(stmt, "end_lineno", stmt.lineno))

        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            names = [target.id for target in targets if isinstance(target, ast.Name)]
            if names and all(name.isupper() for name in names):
                flush_pending()
                add_node("constant", " = ".join(names), stmt.lineno, getattr(stmt, "end_lineno", stmt.lineno))
            else:
                pending.append(stmt)

        else:
            # AI_NOTE: 変数定義など。個別にカード化せず pending に貯め、連続分を flush_pending で1枚に束ねる
            pending.append(stmt)

    flush_pending()

    # AI_NOTE: 引数・戻り値のアノテーションで参照しているローカルクラス名を返す
    # find_local_calls は本体の呼び出しのみ追跡するため、型アノテーション由来のエッジはここで補完する
    def find_annotation_refs(func_node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
        result: set[str] = set()
        all_args = (
            func_node.args.args
            + func_node.args.posonlyargs
            + func_node.args.kwonlyargs
        )
        for arg in all_args:
            if isinstance(arg.annotation, ast.Name) and arg.annotation.id in local_func_names:
                result.add(arg.annotation.id)
        if isinstance(func_node.returns, ast.Name) and func_node.returns.id in local_func_names:
            result.add(func_node.returns.id)
        return result

    # AI_NOTE: 関数→関数の呼び出し関係をエッジとして追加する。自己再帰は除く
    # アノテーション参照（型ヒント）も同様に追加してクラス依存関係を補完する
    added_edges: set[tuple[str, str]] = set()  # 重複エッジを防ぐ

    # AI_NOTE: from_lineは呼び出し元の呼び出し行(0-based)。展開時にどのサブブロックから矢印を出すか決めるのに使う
    def add_edge_once(from_id: str, to_id: str, from_line: int) -> None:
        key = (from_id, to_id)
        if key not in added_edges:
            added_edges.add(key)
            edges.append({"from": from_id, "to": to_id, "label": "", "fromLine": from_line})

    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            caller_id = func_id_map.get(stmt.name)
            if not caller_id:
                continue
            calls = find_local_calls(stmt.body)
            # AI_NOTE: 呼び出しは呼び出し行、型アノテーション参照は呼び出し行が無いのでdef行を使う
            for callee in set(calls) | find_annotation_refs(stmt):
                if callee != stmt.name:
                    callee_id = func_id_map.get(callee)
                    if callee_id:
                        add_edge_once(caller_id, callee_id, calls.get(callee, stmt.lineno) - 1)

            # Overview needs every concrete call site, even when the graph intentionally
            # deduplicates arrows between the same pair.  Include safety-relevant external
            # operations without turning them into top-level definition cards.
            def collect_relationships(node: Any) -> None:
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        continue
                    if isinstance(child, ast.Call):
                        target: Optional[str] = None
                        if isinstance(child.func, ast.Name):
                            if child.func.id in local_func_names or child.func.id == "open":
                                target = child.func.id
                        elif isinstance(child.func, ast.Attribute) and child.func.attr == "write":
                            target = "write"
                        elif (
                            isinstance(child.func, ast.Subscript)
                            and isinstance(child.func.value, ast.Call)
                            and isinstance(child.func.value.func, ast.Name)
                            and child.func.value.func.id == "globals"
                        ):
                            target = "dynamic globals lookup"
                        if target:
                            relationships.append({"from": stmt.name, "to": target, "line": child.lineno})
                    collect_relationships(child)

            for body_stmt in stmt.body:
                collect_relationships(body_stmt)

        elif _is_main_block(stmt) and main_node_id:
            for callee, line in find_local_calls(stmt.body).items():
                callee_id = func_id_map.get(callee)
                if callee_id:
                    add_edge_once(main_node_id, callee_id, line - 1)

    return {"nodes": nodes, "edges": edges, "relationships": relationships}


def background_nodes(tree: ast.Module, lines: list[str], visible: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return lexical ownership for background generation without changing the visible graph."""
    # AI_NOTE: カード用graphが省略する入れ子定義も拾い、親子の本体を二重生成しないための別配列にする。
    if not lines or not tree.body:
        return []
    module_id = "__background_module__"
    result: list[dict[str, Any]] = [{
        "id": module_id, "kind": "block", "label": "モジュール直下",
        "lineStart": 0, "lineEnd": len(lines) - 1, "scopeKey": "module",
    }]
    definitions = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
    known = {(n["kind"], n["lineStart"]): n for n in visible if n["kind"] in ("function", "class")}
    siblings: dict[tuple[str, str], int] = {}

    def walk(node: ast.AST, parent_id: str, parent_key: str) -> None:
        # AI_NOTE: 条件分岐内の定義もlexical親に属させ、行番号を通常の安定キーに使わない。
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, definitions):
                walk(child, parent_id, parent_key)
                continue
            kind = "class" if isinstance(child, ast.ClassDef) else "function"
            key = (parent_key, child.name)
            ordinal = siblings.get(key, 0)
            siblings[key] = ordinal + 1
            scope = f"{parent_key}/{kind}:{child.name}:{ordinal}"
            existing = known.get((kind, child.lineno - 1))
            first_line = min([child.lineno] + [d.lineno for d in child.decorator_list]) - 1
            body_line = child.body[0].lineno - 1
            # A one-line definition has no declaration-only line; exclude it entirely from the parent prompt.
            header_end = body_line - 1 if body_line > child.lineno - 1 else first_line - 1
            item = {
                "id": existing["id"] if existing else f"__background_{scope}",
                "kind": kind, "label": existing["label"] if existing else child.name,
                "lineStart": first_line, "lineEnd": child.end_lineno - 1,
                "headerEnd": header_end, "parent": parent_id, "scopeKey": scope,
            }
            result.append(item)
            walk(child, item["id"], scope)

    walk(tree, module_id, "module")
    for item in visible:
        if item["kind"] in ("function", "class", "entry"):
            continue
        # AI_NOTE: importカードが離れたimport間の定義までspanする場合は、module側に所有を戻す。
        if item["label"].startswith("import ") and any(n["parent"] == module_id and n["lineStart"] <= item["lineEnd"] and n["lineEnd"] >= item["lineStart"] for n in result[1:]):
            continue
        result.append({**item, "parent": module_id, "scopeKey": f"module/{item['kind']}:{item['label']}"})
    # AI_NOTE: トップレベルif/tryの内部定義はlexical keyを保ったまま、その処理カードへ表示所有を寄せる。
    for item in result[1:]:
        if item["kind"] not in ("function", "class") or item["parent"] != module_id:
            continue
        containers = [n for n in result[1:] if n["kind"] not in ("function", "class")
                      and n["lineStart"] <= item["lineStart"] and item["lineEnd"] <= n["lineEnd"]]
        if containers:
            item["parent"] = min(containers, key=lambda n: n["lineEnd"] - n["lineStart"])["id"]
    return result


def extract_graph(source: str, target_func: str = "") -> dict[str, Any]:
    """関数の制御フローグラフを返す。target_func未指定ならモジュール構造マップを返す。"""
    lines = source.splitlines()
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"error": str(e), "nodes": [], "edges": []}

    if target_func == "__main__":
        # AI_NOTE: if __name__ == "__main__": の本体だけをCFGにする
        for node in ast.walk(tree):
            if _is_main_block(node):
                return CFGBuilder(lines).build_stmts(node.body, label="__main__")
        return {"nodes": [], "edges": []}

    if target_func:
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == target_func:
                return CFGBuilder(lines).build(node)
        return {"nodes": [], "edges": []}

    # AI_NOTE: 関数未選択時はCFGでなくファイル構造マップを返す
    # AI_NOTE: 既存カード形状は保ち、背景生成にだけ全lexical所有範囲を渡す。
    result = build_module_map(tree, lines)
    result["backgroundNodes"] = background_nodes(tree, lines, result["nodes"])
    return result


def extract_graph_detail(source: str) -> dict[str, Any]:
    """全関数の内部CFGをまとめて返す（詳細ビュー用）。
    モジュールマップノード + 各関数の内部ブロックノードを含む。
    内部ブロックは "parent" フィールドで親関数IDを持つ。
    """
    lines = source.splitlines()
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"error": str(e), "nodes": [], "edges": []}

    base = build_module_map(tree, lines)
    all_nodes: list[dict[str, Any]] = list(base["nodes"])
    all_edges: list[dict[str, Any]] = list(base["edges"])

    fn_nodes = [(n, n["id"]) for n in all_nodes if n["kind"] == "function"]
    for i, (fn_node, fn_id) in enumerate(fn_nodes):
        label: str = fn_node["label"]
        if label.startswith("class "):
            continue  # AI_NOTE: クラスはメソッド展開未対応のためスキップ
        fn_name = label.split("(")[0]
        ast_fn = next(
            (s for s in tree.body
             if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name == fn_name),
            None,
        )
        if ast_fn is None:
            continue

        # AI_NOTE: id_prefixでCFGノードIDを関数ごとに分離してID衝突を防ぐ
        builder = CFGBuilder(lines, id_prefix=f"d{i}_")
        cfg = builder.build(ast_fn)

        # AI_NOTE: entryノードは親関数IDにリマップ、それ以外は parent フィールドを付与して追加
        entry_remap: dict[str, str] = {}
        for n in cfg["nodes"]:
            if n["kind"] == "entry":
                entry_remap[n["id"]] = fn_id
            else:
                n["parent"] = fn_id
                all_nodes.append(n)

        for e in cfg["edges"]:
            all_edges.append({
                "from": entry_remap.get(e["from"], e["from"]),
                "to": entry_remap.get(e["to"], e["to"]),
                "label": e["label"],
            })

    return {"nodes": all_nodes, "edges": all_edges}


def extract_project_graph(project_dir: str) -> dict[str, Any]:
    """プロジェクト内のPythonファイル依存グラフを返す。
    各ファイルをノードとし、import関係をエッジとする。
    """
    import os
    from pathlib import Path

    # AI_NOTE: 仮想環境・キャッシュ・テストは除外してプロジェクト本体のみ対象にする
    EXCLUDE_DIRS = {".venv", "venv", "__pycache__", ".git", "node_modules", ".tox", "dist", "build"}

    project_path = Path(project_dir).resolve()
    py_files: list[Path] = []
    for root, dirs, files in os.walk(project_path):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for fname in files:
            if fname.endswith(".py"):
                py_files.append(Path(root) / fname)
    py_files.sort()

    def safe_id(fpath: Path) -> str:
        """ファイルパスをMermaidノードIDに変換する。特殊文字を除去する。"""
        rel = fpath.relative_to(project_path)
        return str(rel).replace("/", "__").replace("\\", "__").replace(".", "_").replace("-", "_")

    py_files_set = set(py_files)

    def resolve_import(module_name: str, importer: Path) -> Optional[Path]:
        """モジュール名をプロジェクト内のファイルパスに解決する。
        AI_NOTE: import元ファイルのディレクトリ→祖先→プロジェクトルートの順に探す。
        `from api import auth_api` は importer が multi_dir/main.py なら multi_dir/api/auth_api.py に解決する。
        """
        parts = module_name.split(".")
        if not parts or parts[0] == "":
            return None
        # 探索基準: importerのディレクトリから project_path まで遡る
        bases: list[Path] = []
        d = importer.parent
        while True:
            bases.append(d)
            if d == project_path:
                break
            d = d.parent
        for base in bases:
            c1 = base / Path(*parts).with_suffix(".py")
            if c1 in py_files_set:
                return c1
            c2 = base / Path(*parts) / "__init__.py"
            if c2 in py_files_set:
                return c2
        return None

    # AI_NOTE: ファイルごとにAST解析してトップレベル関数とimportを収集する
    file_info: dict[Path, dict[str, Any]] = {}
    for fpath in py_files:
        rel_path = str(fpath.relative_to(project_path))
        info: dict[str, Any] = {
            "id": safe_id(fpath),
            "path": str(fpath),
            "rel_path": rel_path,
            "dir": str(fpath.parent.relative_to(project_path)) if fpath.parent != project_path else "",
            "functions": [],
            "symbols": [],
            "imports": [],
        }
        try:
            source = fpath.read_text(encoding="utf-8")
            tree = ast.parse(source)
            info["functions"] = [
                n.name for n in tree.body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            # AI_NOTE: プロジェクト図は例外classなど、メソッドを持たない型自体も質問の
            # 起点になり得る。カード説明用functionsは互換維持し、図の実在照合用symbolsへ
            # トップレベルclassを含めた完全な定義一覧を分離する。
            info["symbols"] = [
                n.name for n in tree.body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            ]
            # クラス内のメソッドも収集
            for node in tree.body:
                if isinstance(node, ast.ClassDef):
                    for item in node.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            info["functions"].append(f"{node.name}.{item.name}")
                            info["symbols"].append(f"{node.name}.{item.name}")
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        info["imports"].append(alias.name)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    info["imports"].append(node.module)
                    # AI_NOTE: from X import Y の Y はサブモジュールの可能性があるので X.Y も候補にする
                    for alias in node.names:
                        info["imports"].append(f"{node.module}.{alias.name}")
        except (OSError, SyntaxError):
            pass
        file_info[fpath] = info

    # AI_NOTE: __init__.pyのdocstringをディレクトリの説明として使う
    dir_descriptions: dict[str, str] = {}
    for fpath in py_files:
        if fpath.name == "__init__.py":
            try:
                source = fpath.read_text(encoding="utf-8")
                tree = ast.parse(source)
                doc = ast.get_docstring(tree)
                if doc:
                    rel_dir = str(fpath.parent.relative_to(project_path))
                    dir_descriptions[rel_dir] = doc.split("\n")[0]
            except (OSError, SyntaxError):
                pass

    # AI_NOTE: 関数が0件の __init__.py はパッケージのマーカーであり、ノードとして表示しても意味がない
    # エッジ解決時もスキップして、パッケージレベルのimportがノイズにならないようにする
    empty_init: set[Path] = {
        fpath for fpath in py_files
        if fpath.name == "__init__.py" and not file_info[fpath]["functions"]
    }

    nodes = [info for fpath, info in file_info.items() if fpath not in empty_init]
    edges: list[dict[str, str]] = []
    for fpath, info in file_info.items():
        if fpath in empty_init:
            continue
        seen: set[str] = set()
        for mod in info["imports"]:
            target = resolve_import(mod, fpath)
            if target and target in file_info and target != fpath and target not in empty_init:
                to_id = file_info[target]["id"]
                if to_id not in seen:
                    seen.add(to_id)
                    edges.append({"from": info["id"], "to": to_id, "label": ""})

    return {"nodes": nodes, "edges": edges, "projectDir": str(project_path), "dirDescriptions": dir_descriptions}


BLOCK_COLORS = [
    {"color": "#4fc1ff", "bg": "rgba(79,193,255,0.12)"},
    {"color": "#f48771", "bg": "rgba(244,135,113,0.12)"},
    {"color": "#4ec9b0", "bg": "rgba(78,201,176,0.12)"},
    {"color": "#dcdcaa", "bg": "rgba(220,220,170,0.12)"},
    {"color": "#c586c0", "bg": "rgba(197,134,192,0.12)"},
    {"color": "#9cdcfe", "bg": "rgba(156,220,254,0.12)"},
]


def _group_by_blanks_and_comments(
    lines: list[str], start: int, end: int
) -> list[dict[str, Any]]:
    """0-indexed。空行をセパレータ、コメント行をラベルとしてブロックを作る。"""
    blocks: list[dict[str, Any]] = []
    current_start: Optional[int] = None
    current_label: Optional[str] = None

    for i in range(start, end + 1):
        raw = lines[i] if i < len(lines) else ""
        stripped = raw.strip()

        if not stripped:
            if current_start is not None:
                blocks.append({
                    "label": current_label or "処理",
                    "lineStart": current_start,
                    "lineEnd": i - 1,
                })
                current_start = None
                current_label = None
        else:
            if current_start is None:
                current_start = i
            if stripped.startswith("#") and current_label is None:
                current_label = stripped.lstrip("#").strip()

    if current_start is not None:
        blocks.append({
            "label": current_label or "処理",
            "lineStart": current_start,
            "lineEnd": end,
        })

    return blocks


def extract_blocks(
    source: str, granularity: str = "normal", target_func: str = ""
) -> list[dict[str, Any]]:
    """コードを処理ブロック単位に分割して返す。"""
    lines = source.splitlines()
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [{"error": str(e)}]

    # 対象の関数/メソッドを収集
    funcs = [
        n for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        and (not target_func or n.name == target_func)
    ]
    if not funcs:
        return []

    # AI_NOTE: coarse=関数1つ1ブロック、function=同じ、detail=各ステートメント、normal=空行+コメント区切り
    blocks: list[dict[str, Any]] = []

    if granularity in ("coarse", "function"):
        for fn in funcs:
            end = (fn.end_lineno - 1) if hasattr(fn, "end_lineno") else fn.lineno - 1
            blocks.append({"label": f"{fn.name}()", "lineStart": fn.lineno - 1, "lineEnd": end})

    elif granularity == "detail":
        for fn in funcs:
            for stmt in fn.body:
                s_end = (stmt.end_lineno - 1) if hasattr(stmt, "end_lineno") else stmt.lineno - 1
                raw = lines[stmt.lineno - 1].strip() if stmt.lineno <= len(lines) else ""
                label = raw.lstrip("#").strip() if raw.startswith("#") else raw[:40]
                blocks.append({"label": label or "処理", "lineStart": stmt.lineno - 1, "lineEnd": s_end})

    else:  # normal
        for fn in funcs:
            fn_end = (fn.end_lineno - 1) if hasattr(fn, "end_lineno") else fn.lineno - 1
            # defの次の行からbody開始。docstringはスキップ
            body_start = fn.lineno  # 0-indexed: defの次行
            sub = _group_by_blanks_and_comments(lines, body_start, fn_end)
            # 空行+コメントのみのブロックは除去
            for b in sub:
                content = [
                    lines[i].strip()
                    for i in range(b["lineStart"], b["lineEnd"] + 1)
                    if i < len(lines) and lines[i].strip() and not lines[i].strip().startswith("#")
                ]
                if content:
                    blocks.append(b)

    # 色を割り当て
    for i, b in enumerate(blocks):
        c = BLOCK_COLORS[i % len(BLOCK_COLORS)]
        b["color"] = c["color"]
        b["bg"] = c["bg"]

    return blocks


def extract_symbol_occurrences(source: str) -> list[dict[str, Any]]:
    """Return every Python name occurrence with a scope-aware description key."""
    source_lines = source.splitlines()
    parsed_source = source
    line_shift = 0
    injected_indent = 0
    dedent_offsets = [0 for _ in source_lines]
    try:
        tree = ast.parse(parsed_source)
    except SyntaxError:
        dedented = textwrap.dedent(source)
        dedented_lines = dedented.splitlines()
        dedent_offsets = [
            max(0, len(original) - len(dedented_line))
            for original, dedented_line in zip(source_lines, dedented_lines)
        ]
        parsed_source = dedented
        try:
            tree = ast.parse(parsed_source)
        except SyntaxError:
            # 選択範囲には return / break など、モジュール直下では構文エラーになる文も入る。
            # 一時関数へ包んで解析し、後段で追加した1行・4列を元の座標へ戻す。
            parsed_source = "def __ai_code_guide_selection__():\n" + textwrap.indent(dedented, "    ")
            line_shift = 1
            injected_indent = 4
            try:
                wrapped_tree = ast.parse(parsed_source)
                synthetic = wrapped_tree.body[0]
                if not isinstance(synthetic, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    return []
                tree = wrapped_tree
            except SyntaxError:
                return []
    parsed_lines = parsed_source.splitlines()
    known_classes = {node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)}
    known_functions = {
        node.name for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    import_bindings: dict[int, set[str]] = {}

    def scope_imports(root: ast.AST) -> set[str]:
        if id(root) in import_bindings:
            return import_bindings[id(root)]
        names: set[str] = set()
        pending = [root]
        while pending:
            current = pending.pop()
            if current is not root and isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if isinstance(current, (ast.Import, ast.ImportFrom)):
                names.update(alias.asname or (alias.name.split(".")[0] if isinstance(current, ast.Import) else alias.name)
                             for alias in current.names)
            pending.extend(ast.iter_child_nodes(current))
        import_bindings[id(root)] = names
        return names

    def char_col(line: str, byte_col: int) -> int:
        return len(line.encode("utf-8")[:byte_col].decode("utf-8", errors="ignore"))

    class SymbolVisitor(ast.NodeVisitor):
        def __init__(self) -> None:
            self.scope: list[str] = []
            self.scope_nodes: list[ast.AST] = []
            self.statement_nodes: list[ast.stmt] = []
            self.items: list[dict[str, Any]] = []

        def visit(self, node: ast.AST) -> Any:
            # AI_NOTE: 名称の代入根拠は最近傍statementの正確な範囲。改行式や文字列を字下げで推測しない。
            if isinstance(node, ast.stmt):
                self.statement_nodes.append(node)
                try:
                    return super().visit(node)
                finally:
                    self.statement_nodes.pop()
            return super().visit(node)

        def add(self, node: ast.AST, name: str, kind: str, start_byte: int, end_byte: int,
                identity: str | None = None, definition: bool = False,
                evidence_node: ast.AST | None = None) -> None:
            parsed_line_index = getattr(node, "lineno", 1) - 1
            line_index = parsed_line_index - line_shift
            if (line_index < 0 or line_index >= len(source_lines)
                    or parsed_line_index >= len(parsed_lines) or not name):
                return
            line = source_lines[line_index]
            parsed_line = parsed_lines[parsed_line_index]
            offset = dedent_offsets[line_index] if line_index < len(dedent_offsets) else 0
            start = char_col(parsed_line, start_byte) - injected_indent + offset
            end = char_col(parsed_line, end_byte) - injected_indent + offset
            if start < 0 or end <= start or line[start:end] != name:
                found = line.find(name, max(0, start))
                if found < 0:
                    return
                start, end = found, found + len(name)
            scope = ".".join(self.scope) or "<module>"
            semantic = identity or name
            scope_node = evidence_node or (self.scope_nodes[-1] if self.scope_nodes else None)
            scope_start = ((getattr(scope_node, "lineno", 1) - 1 - line_shift)
                           if scope_node is not None else 0)
            scope_end = ((getattr(scope_node, "end_lineno", len(source_lines)) - 1 - line_shift)
                         if scope_node is not None else max(0, len(source_lines) - 1))
            scope_start = max(0, min(scope_start, max(0, len(source_lines) - 1)))
            scope_end = max(scope_start, min(scope_end, max(0, len(source_lines) - 1)))
            statement = self.statement_nodes[-1] if self.statement_nodes else node
            statement_start = max(0, getattr(statement, "lineno", 1) - 1 - line_shift)
            statement_end = min(max(0, len(source_lines) - 1),
                                getattr(statement, "end_lineno", statement_start + 1) - 1 - line_shift)
            self.items.append({
                "key": f"{scope}|{kind}|{semantic}",
                "name": name,
                "display": f"{name}()" if kind in {"function", "method"} else name,
                "kind": kind,
                "line": line_index,
                "start_col": start,
                "end_col": end,
                "scope": scope,
                "context": line.strip(),
                "scope_start": scope_start,
                "scope_end": scope_end,
                "is_definition": definition,
                "statement_start": statement_start,
                "statement_end": max(statement_start, statement_end),
                # AI_NOTE: 組込名を隠すimport(別名・star含む)は字句scopeごとに検出し、既知builtinsと誤認しない。
                "import_shadowed": any(name in scope_imports(scope_node) or "*" in scope_imports(scope_node)
                                       for scope_node in [tree, *self.scope_nodes]),
            })

        def definition_name(self, node: ast.AST, name: str, kind: str) -> None:
            parsed_line_index = getattr(node, "lineno", 1) - 1
            line_index = parsed_line_index - line_shift
            if line_index < 0 or line_index >= len(source_lines) or parsed_line_index >= len(parsed_lines):
                return
            line = source_lines[line_index]
            parsed_line = parsed_lines[parsed_line_index]
            offset = dedent_offsets[line_index] if line_index < len(dedent_offsets) else 0
            expected = char_col(parsed_line, getattr(node, "col_offset", 0)) - injected_indent + offset
            start = line.find(name, max(0, expected))
            if start >= 0:
                qualified = ".".join([*self.scope, name])
                self.add(node, name, kind, len(line[:start].encode("utf-8")),
                         len(line[:start + len(name)].encode("utf-8")), qualified,
                         definition=True, evidence_node=node)

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            self.definition_name(node, node.name, "class")
            self.scope.append(node.name)
            self.scope_nodes.append(node)
            for base in node.bases:
                self.visit(base)
            for statement in node.body:
                self.visit(statement)
            self.scope.pop()
            self.scope_nodes.pop()

        def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
            kind = "method" if self.scope and self.scope[-1][:1].isupper() else "function"
            self.definition_name(node, node.name, kind)
            self.scope.append(node.name)
            self.scope_nodes.append(node)
            self.visit(node.args)
            for decorator in node.decorator_list:
                self.visit(decorator)
            if node.returns:
                self.visit(node.returns)
            for statement in node.body:
                self.visit(statement)
            self.scope.pop()
            self.scope_nodes.pop()

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_Call(self, node: ast.Call) -> None:
            if isinstance(node.func, ast.Name):
                kind = "class" if node.func.id in known_classes else "function"
                self.add(node.func, node.func.id, kind, node.func.col_offset,
                         node.func.end_col_offset or node.func.col_offset + len(node.func.id), node.func.id)
            elif isinstance(node.func, ast.Attribute):
                end = node.func.end_col_offset or node.func.col_offset + len(node.func.attr)
                start = end - len(node.func.attr.encode("utf-8"))
                try:
                    identity = ast.unparse(node.func)
                except Exception:
                    identity = node.func.attr
                self.add(node.func, node.func.attr, "method", start, end, identity)
                self.visit(node.func.value)
            else:
                before = len(self.items)
                self.visit(node.func)
                # AI_NOTE: registry[key]() / factory()()などの呼出し先は名称だけでは静的解決しない。
                for item in self.items[before:]:
                    item["uncertain_call"] = True
            for arg in node.args:
                self.visit(arg)
            for keyword in node.keywords:
                self.visit(keyword.value)

        def visit_Attribute(self, node: ast.Attribute) -> None:
            end = node.end_col_offset or node.col_offset + len(node.attr)
            start = end - len(node.attr.encode("utf-8"))
            try:
                identity = ast.unparse(node)
            except Exception:
                identity = node.attr
            self.add(node, node.attr, "variable", start, end, identity)
            self.visit(node.value)

        def visit_Name(self, node: ast.Name) -> None:
            kind = "class" if node.id in known_classes else "function" if node.id in known_functions else "variable"
            self.add(node, node.id, kind, node.col_offset,
                     node.end_col_offset or node.col_offset + len(node.id), node.id,
                     definition=isinstance(node.ctx, ast.Store))

        def visit_arg(self, node: ast.arg) -> None:
            self.add(node, node.arg, "variable", node.col_offset,
                     node.end_col_offset or node.col_offset + len(node.arg), node.arg,
                     definition=True)
            if node.annotation:
                self.visit(node.annotation)

    visitor = SymbolVisitor()
    if line_shift:
        synthetic = tree.body[0]
        for statement in synthetic.body:  # type: ignore[union-attr]
            visitor.visit(statement)
    else:
        visitor.visit(tree)
    seen: set[tuple[int, int, int, str]] = set()
    result = []
    for item in sorted(visitor.items, key=lambda value: (value["line"], value["start_col"], value["end_col"])):
        identity = (item["line"], item["start_col"], item["end_col"], item["kind"])
        if identity in seen:
            continue
        seen.add(identity)
        result.append(item)
    return result


if __name__ == "__main__":
    # Windows may inherit a legacy console code page even though the extension
    # protocol is UTF-8 JSON. Keep non-ASCII labels valid on every platform.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ast_parser.py <command> [args...]"}))
        sys.exit(1)

    command = sys.argv[1]

    if command == "flowchart":
        source = sys.stdin.read()
        granularity = sys.argv[2] if len(sys.argv) > 2 else "normal"
        target_func = sys.argv[3] if len(sys.argv) > 3 else ""
        result = parse(source, granularity, target_func)
        print(json.dumps(result, ensure_ascii=False))

    elif command == "graph":
        source = sys.stdin.read()
        target_func = sys.argv[2] if len(sys.argv) > 2 else ""
        result = extract_graph(source, target_func)
        print(json.dumps(result, ensure_ascii=False))

    elif command == "graph_detail":
        source = sys.stdin.read()
        result = extract_graph_detail(source)
        print(json.dumps(result, ensure_ascii=False))

    elif command == "blocks":
        source = sys.stdin.read()
        granularity = sys.argv[2] if len(sys.argv) > 2 else "normal"
        target_func = sys.argv[3] if len(sys.argv) > 3 else ""
        result = extract_blocks(source, granularity, target_func)
        print(json.dumps(result, ensure_ascii=False))

    elif command == "func_at_line":
        # AI_NOTE: 指定行（0-indexed）を含む関数を返す。メソッドは
        # Class.method にし、同名メソッドの取り違えとモジュール直下関数への誤解決を防ぐ。
        # if __name__ == "__main__": 内なら "__main__" を返す
        source = sys.stdin.read()
        cursor_line = int(sys.argv[2])
        try:
            tree = ast.parse(source)
        except SyntaxError:
            print(json.dumps({"func": ""}))
            sys.exit(0)
        best = {"name": "", "size": float("inf")}

        def visit_functions(body: list[ast.stmt], class_path: list[str]) -> None:
            for node in body:
                if isinstance(node, ast.ClassDef):
                    visit_functions(node.body, [*class_path, node.name])
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    start = node.lineno - 1
                    end = (node.end_lineno - 1) if hasattr(node, "end_lineno") else start
                    if start <= cursor_line <= end:
                        size = end - start
                        if size < best["size"]:
                            best["size"] = size
                            best["name"] = ".".join([*class_path, node.name])

        visit_functions(tree.body, [])
        best_name = best["name"]
        if not best_name:
            for node in ast.walk(tree):
                if _is_main_block(node):
                    start = node.lineno - 1
                    end = (node.end_lineno - 1) if hasattr(node, "end_lineno") else start
                    if start <= cursor_line <= end:
                        best_name = "__main__"
                        break
        print(json.dumps({"func": best_name}))

    elif command == "functions":
        # AI_NOTE: 一括トレースの選択リスト用。トップレベル関数とクラス直下の
        # メソッドを定義順で返す。メソッドは Class.method で一意にする。
        source = sys.stdin.read()
        try:
            tree = ast.parse(source)
        except SyntaxError:
            print(json.dumps([]))
            sys.exit(0)
        funcs = []

        def append_functions(body: list[ast.stmt], class_path: list[str]) -> None:
            for node in body:
                if isinstance(node, ast.ClassDef):
                    append_functions(node.body, [*class_path, node.name])
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    funcs.append({
                        "name": ".".join([*class_path, node.name]),
                        "line_start": node.lineno,
                        "line_end": node.end_lineno or node.lineno,
                    })

        append_functions(tree.body, [])
        funcs.sort(key=lambda item: item["line_start"])
        print(json.dumps(funcs, ensure_ascii=False))

    elif command == "stmt_spans":
        # AI_NOTE: 関数展開ブロックの行範囲検証(blockRangeSnapper)向けに文境界一覧を返す
        source = sys.stdin.read()
        result = extract_stmt_spans(source)
        print(json.dumps(result, ensure_ascii=False))

    elif command == "symbols":
        source = sys.stdin.read()
        print(json.dumps(extract_symbol_occurrences(source), ensure_ascii=False))

    elif command == "project_graph":
        # AI_NOTE: プロジェクトディレクトリを受け取り、Pythonファイル間の依存グラフを返す
        project_dir = sys.argv[2] if len(sys.argv) > 2 else "."
        result = extract_project_graph(project_dir)
        print(json.dumps(result, ensure_ascii=False))

    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))
        sys.exit(1)
