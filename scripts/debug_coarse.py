#!/usr/bin/env python3
"""
モジュールマップの coarse グループ化をVSCode不要で検証するデバッグスクリプト。

使い方:
  python3 scripts/debug_coarse.py examples/single_file/task_manager.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# プロジェクトルートを基準にパスを解決する
ROOT = Path(__file__).parent.parent


def load_api_key() -> str:
    settings_path = Path.home() / "Library/Application Support/Code/User/settings.json"
    raw = settings_path.read_text()
    raw = re.sub(r",\s*([\]}])", r"\1", raw)  # trailing comma 除去
    d = json.loads(raw)
    return d.get("aiCodeGuide.anthropicApiKey", "")


def get_nodes(source: str) -> list[dict]:
    import subprocess
    result = subprocess.run(
        [sys.executable, str(ROOT / "python/ast_parser.py"), "graph"],
        input=source, capture_output=True, text=True
    )
    data = json.loads(result.stdout)
    return data.get("nodes", [])


def call_llm(api_key: str, nodes: list[dict]) -> str:
    import urllib.request

    node_list = "\n".join(
        f"{n['id']} [{'class' if n['label'].startswith('class ') else n['kind']}]"
        f" L{n['lineStart']}-{n['lineEnd']}: {n['label']}"
        for n in nodes
    )

    system_prompt = "\n".join([
        "以下はPythonファイルの構造ノード一覧です。意味的な役割ごとに3〜5グループに分類してください。",
        "グループの例（ファイルの内容に合わせて変えてよい）:",
        "  「データモデル」「バリデーション」「ビジネスロジック」「レポート・集計」「エントリポイント」",
        "ルール:",
        "  - 各グループには最低1ノードを含めること",
        "  - 1つのグループに全ノードの75%以上を入れてはいけない（意味のある分割にすること）",
        "  - 全ノードをいずれかのグループに含めること",
        "  - グループラベルは日本語・15文字以内",
        '回答はJSONのみ: [{"label": "グループ名", "nodeIds": ["id1", "id2"]}, ...]',
    ])

    body = json.dumps({
        "model": "claude-sonnet-4-5",
        "max_tokens": 768,
        "system": system_prompt,
        "messages": [{"role": "user", "content": node_list}],
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["content"][0]["text"]


def parse_groups(text: str, nodes: list[dict]) -> list[dict]:
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end <= start:
        return []
    parsed = json.loads(text[start:end + 1])
    valid_ids = {n["id"] for n in nodes}
    non_empty = [
        g for g in parsed
        if isinstance(g.get("nodeIds"), list) and any(i in valid_ids for i in g["nodeIds"])
    ]
    if len(non_empty) < 2:
        print("  ⚠ 有効グループ2未満 → 失敗")
        return []
    dominated = any(
        sum(1 for i in g["nodeIds"] if i in valid_ids) > len(nodes) * 0.75
        for g in non_empty
    )
    if dominated:
        print("  ⚠ 1グループに75%超集中 → 失敗")
        return []
    return non_empty


def show_coarse_layout(groups: list[dict], nodes: list[dict]) -> None:
    node_map = {n["id"]: n for n in nodes}
    GAP = 20
    print("\n--- coarse カード layout ---")
    for g in groups:
        g_nodes = sorted(
            [node_map[i] for i in g["nodeIds"] if i in node_map],
            key=lambda n: n["lineStart"],
        )
        # 連続範囲に分割
        runs: list[list[dict]] = []
        cur = [g_nodes[0]]
        for n in g_nodes[1:]:
            if n["lineStart"] - cur[-1]["lineEnd"] > GAP:
                runs.append(cur)
                cur = [n]
            else:
                cur.append(n)
        runs.append(cur)

        for i, run in enumerate(runs):
            ls = run[0]["lineStart"]
            le = run[-1]["lineEnd"]
            suffix = f" (run {i+1}/{len(runs)})" if len(runs) > 1 else ""
            print(f"  [{g['label']}{suffix}]  L{ls}-{le}  ({le - ls + 1}行)")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/debug_coarse.py <python_file>")
        sys.exit(1)

    source = Path(sys.argv[1]).read_text()
    api_key = load_api_key()
    if not api_key:
        print("ERROR: aiCodeGuide.anthropicApiKey が VSCode settings に見つかりません")
        sys.exit(1)

    print(f"=== {sys.argv[1]} ===")
    nodes = get_nodes(source)
    print(f"ノード数: {len(nodes)}")
    for n in nodes:
        print(f"  {n['id']:8} [{n['kind']:8}] L{n['lineStart']:3}-{n['lineEnd']:3}  {n['label'][:40]}")

    print("\n--- LLM 呼び出し中 ---")
    raw = call_llm(api_key, nodes)
    print("raw response:")
    print(raw)

    print("\n--- パース結果 ---")
    groups = parse_groups(raw, nodes)
    if groups:
        for g in groups:
            print(f"  {g['label']}: {g['nodeIds']}")
        show_coarse_layout(groups, nodes)
    else:
        print("  グループ化失敗 → 標準表示にフォールバック")


if __name__ == "__main__":
    main()
