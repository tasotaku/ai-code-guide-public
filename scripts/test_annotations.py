#!/usr/bin/env python3
"""
[非推奨] このスクリプトはプロンプトを Python に再実装しており、本番(src/api/claudeClient.ts の
generateSemanticAnnotations)と乖離します。スタンドアロン検証には本番関数をそのまま叩く
`node scripts/annotations_smoke.js <file> [model] [density]` を使ってください。

SemanticAnnotation 生成のスタンドアロンテスト。
VSCode / キーボード入力なしで generateSemanticAnnotations() 相当を検証できる。

使い方:
  ANTHROPIC_API_KEY=... python3 scripts/test_annotations.py <python_file> [start_line] [end_line]

例:
  python3 scripts/test_annotations.py examples/single_file/algorithms.py
  python3 scripts/test_annotations.py examples/single_file/algorithms.py 8 16
"""

import sys
import os
import json
import re
import anthropic


def extract_json(text: str) -> str:
    match = re.search(r"\[.*\]", text, re.DOTALL)
    return match.group(0) if match else "[]"


def resolve_api_key() -> str:
    if key := os.environ.get("ANTHROPIC_API_KEY"):
        return key
    # VSCode のユーザー設定から取得（拡張機能と同じ設定を共有）
    import subprocess, platform
    if platform.system() == "Darwin":
        settings_path = os.path.expanduser(
            "~/Library/Application Support/Code/User/settings.json"
        )
        try:
            with open(settings_path, encoding="utf-8") as f:
                text = f.read()
            # コメント・末尾カンマがある JSON-like 形式なので regex で直接抜く
            m = re.search(r'"aiCodeGuide\.anthropicApiKey"\s*:\s*"([^"]+)"', text)
            if m:
                return m.group(1)
        except Exception:
            pass
    raise RuntimeError(
        "API キーが見つかりません。ANTHROPIC_API_KEY 環境変数を設定するか、"
        "VSCode の aiCodeGuide.anthropicApiKey を設定してください。"
    )


def generate_annotations(code: str, global_ctx: str = "") -> list[dict]:
    client = anthropic.Anthropic(api_key=resolve_api_key())

    system_lines = [
        "あなたはPythonコードの解説アシスタントです。",
        "AIが生成したコードを読む開発者が引っかかりそうな箇所を特定し、短い日本語の解説をつけてください。",
        "",
        "解説が必要な箇所の例：",
        "- 慣れないライブラリのメソッド・関数（例: collections.deque, itertools.chain）",
        "- このコードで定義されたクラス・関数・変数の役割",
        "- 非自明なパターン（内包表記、デコレータ、複雑な条件式など）",
        "- 複数行にわたるロジックの意図（ループ本体、if分岐の目的など）",
        "",
        "返却形式（JSONのみ、マークダウン不可）:",
        '[{"startLine":N,"endLine":N,"startCol":N_or_null,"endCol":N_or_null,"kind":"symbol"|"block","explanation":"..."}]',
        "",
        "ルール:",
        "- startLine/endLine/startCol/endCol はすべてスニペット内の0-based",
        "- kind=symbol: 行内の特定トークン。startCol/endColでトークン範囲を指定",
        "- kind=block: 複数行または行全体の意図。startCol/endColはnull",
        "- 解説は10〜25文字の日本語",
        "- 5〜8箇所に厳選（重要度が高いものだけ）",
        "- 自明な箇所（i += 1、return arr など）は含めない",
    ]
    if global_ctx:
        system_lines.append(f"読者のコンテキスト: {global_ctx}")

    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system="\n".join(system_lines),
        messages=[{"role": "user", "content": f"以下のPythonコードに解説をつけてください:\n```python\n{code}\n```"}],
    )

    text = message.content[0].text if message.content else "[]"
    print(f"[tokens] input={message.usage.input_tokens} output={message.usage.output_tokens}", file=sys.stderr)
    return json.loads(extract_json(text))


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    filepath = sys.argv[1]
    with open(filepath, encoding="utf-8") as f:
        lines = f.readlines()

    start = int(sys.argv[2]) - 1 if len(sys.argv) >= 3 else 0
    end = int(sys.argv[3]) - 1 if len(sys.argv) >= 4 else len(lines) - 1
    code = "".join(lines[start : end + 1])

    print(f"=== 対象コード (行 {start+1}〜{end+1}) ===", file=sys.stderr)
    for i, line in enumerate(code.splitlines()):
        print(f"{start+1+i:4d}  {line}", file=sys.stderr)

    print("\n=== アノテーション生成中... ===", file=sys.stderr)
    annotations = generate_annotations(code)

    print("\n=== 結果 ===", file=sys.stderr)
    for a in annotations:
        abs_start = start + a["startLine"] + 1
        kind_label = "symbol" if a["kind"] == "symbol" else "block "
        col_info = f" col {a['startCol']}..{a['endCol']}" if a["startCol"] is not None else ""
        print(f"  [{kind_label}] 行{abs_start}{col_info}: {a['explanation']}", file=sys.stderr)

    # stdout に JSON を出力（パイプ処理用）
    print(json.dumps(annotations, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
