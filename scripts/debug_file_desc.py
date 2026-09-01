#!/usr/bin/env python3
"""
generateFileDescriptions の動作検証スクリプト。
TypeScript 側の同関数と同じプロンプト・ロジックを再現して LLM の出力を確認する。

使い方:
  ANTHROPIC_API_KEY=sk-... python3 scripts/debug_file_desc.py
"""

import json
import os
import subprocess
import sys

try:
    import anthropic
except ImportError:
    print("anthropic パッケージが必要です: pip install anthropic")
    sys.exit(1)

MODEL = "claude-sonnet-4-5"


def get_project_nodes(project_dir: str) -> list[dict]:
    result = subprocess.run(
        ["python3", "python/ast_parser.py", "project_graph", project_dir],
        capture_output=True, text=True
    )
    data = json.loads(result.stdout)
    return data.get("nodes", [])


def build_file_list(nodes: list[dict]) -> list[dict]:
    # AI_NOTE: キーは rel_path (例: "api/auth_api.py")。safe_id ではなく人間が読める形を使う
    return [
        {
            "id": n["rel_path"],
            "name": n["rel_path"].split("/")[-1],
            "functions": n["functions"][:15],
        }
        for n in nodes
    ]


def generate_file_descriptions(files: list[dict], api_key: str) -> dict[str, str]:
    client = anthropic.Anthropic(api_key=api_key)

    file_list = "\n\n".join(
        f"[{f['id']}]\n{f['name']}\n関数: {', '.join(f['functions']) or 'なし'}"
        for f in files
    )

    system_prompt = "\n".join([
        "Pythonファイルの役割を日本語で説明してください。",
        "各ファイルについて30文字以内の1行説明を返してください。",
        "ファイル名と関数名から「このファイルが何をするか・どんな責務を持つか」を端的に表現する。",
        "例: 「ユーザー認証・ログイン処理」「商品・在庫データモデル定義」「APIエンドポイント（認証系）」",
        "JSONのキーは入力の各ブロック先頭の [] 内の文字列をそのまま使うこと。",
        '回答はJSONのみ: {"<[]内のID>": "説明", ...}',
    ])

    print("=== LLM への入力 ===")
    print(f"[system]\n{system_prompt}\n")
    print(f"[user]\n以下のファイルを説明してください:\n\n{file_list}\n")

    message = client.messages.create(
        model=MODEL,
        max_tokens=512,
        system=system_prompt,
        messages=[{"role": "user", "content": f"以下のファイルを説明してください:\n\n{file_list}"}],
    )

    raw = message.content[0].text if message.content and message.content[0].type == "text" else ""
    cleaned = raw.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    print("=== LLM の生出力 ===")
    print(raw)
    print()

    try:
        parsed: dict[str, str] = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"[ERROR] JSON パース失敗: {e}")
        return {}

    print("=== パース結果 ===")
    for k, v in parsed.items():
        print(f"  {k!r}: {v!r}")
    print()

    print("=== ID 照合チェック ===")
    expected_ids = {f["id"] for f in files}
    returned_ids = set(parsed.keys())
    matched = expected_ids & returned_ids
    missing = expected_ids - returned_ids
    extra = returned_ids - expected_ids

    print(f"  期待 ID  : {sorted(expected_ids)}")
    print(f"  返却 ID  : {sorted(returned_ids)}")
    print(f"  一致     : {sorted(matched)} ({len(matched)}/{len(expected_ids)})")
    if missing:
        print(f"  [WARN] 欠落: {sorted(missing)}")
    if extra:
        print(f"  [WARN] 余分: {sorted(extra)}")

    return parsed


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("エラー: ANTHROPIC_API_KEY 環境変数を設定してください")
        sys.exit(1)

    # multi_file (flat 構造) と multi_dir (サブディレクトリあり) の両方でテスト
    for project in ["examples/multi_file", "examples/multi_dir"]:
        if not os.path.exists(project):
            continue
        print(f"\n{'='*60}")
        print(f"プロジェクト: {project}")
        print(f"{'='*60}\n")

        nodes = get_project_nodes(project)
        if not nodes:
            print(f"  ノードが見つかりません: {project}")
            continue

        files = build_file_list(nodes)
        generate_file_descriptions(files, api_key)


if __name__ == "__main__":
    main()
