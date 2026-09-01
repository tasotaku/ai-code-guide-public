# Codex / Claude Code から AI Code Guide を使う

> この文書はCLIを直接呼ぶ場合の説明です。AIアプリへツールとして登録する場合は [MCP利用ガイド](mcp-usage.md) を参照してください。

AIとの会話は Codex / Claude Code が担当し、AI Code Guide はコード理解に必要な画面と、画面からVS Codeへ戻る導線を提供します。AI Code Guide内のチャットへ会話を移す必要はありません。

## 準備

1. 対象ワークスペースをVS Codeで開きます。
2. AI Code Guide拡張をインストールして有効にします。VS Codeの起動完了後に自動起動するため、Pythonファイルやサイドバーを手動で開く必要はありません。
3. 拡張が `.ai-code-guide/ai-code-guide.mjs`、`.ai-code-guide/activation.json`、`.ai-code-guide/bridge.json` を作ります。いずれもローカルGit除外へ追加され、コミット対象にはなりません。

接続確認:

```bash
node .ai-code-guide/ai-code-guide.mjs status
```

成功時は、外部AIが利用できる6つのビューをJSONで返します。MCP経由では各ビューに加えて、複数カード展開、概要生成、構成説明生成、範囲解説、複数関数トレースまで文脈に応じて制御できます。

## コマンド

```bash
# 関数・クラスのカード。特定行を中央に表示する
node .ai-code-guide/ai-code-guide.mjs show standard \
  --file examples/single_file/task_manager.py --line 91

# 1ファイルの概要
node .ai-code-guide/ai-code-guide.mjs show overview \
  --file examples/single_file/task_manager.py

# リポジトリ全体のファイル・import構成
node .ai-code-guide/ai-code-guide.mjs show project

# 質問に合わせたコード図を生成し、会話の横で開けるHTMLを返す
node .ai-code-guide/ai-code-guide.mjs show diagram \
  --question "タスク追加から保存までの処理順"

# 生成済みインライン解説を表示する
node .ai-code-guide/ai-code-guide.mjs show inline \
  --file examples/single_file/task_manager.py

# インライン解説を生成して表示する（LLMを使用）
node .ai-code-guide/ai-code-guide.mjs show inline \
  --file examples/single_file/task_manager.py --run

# 生成済みトレースを表示する
node .ai-code-guide/ai-code-guide.mjs show trace \
  --file examples/single_file/task_manager.py --line 103

# カーソル位置の関数をトレースして表示する（LLMで入力例を作り、隔離実行する）
node .ai-code-guide/ai-code-guide.mjs show trace \
  --file examples/single_file/task_manager.py --line 103 --run
```

すべての成功・失敗は1行JSONです。外部AIは終了コードと `ok` を確認でき、`diagram` の成功時は `htmlPath` を取得できます。

## どのビューを使うか

| 知りたいこと | view |
|---|---|
| このファイルに何があるか | `standard` |
| このファイルの役割・大枠 | `overview` |
| どのファイルが関係するか | `project` |
| 特定機能の処理順・読解順・依存 | `diagram` |
| 非自明な記述や注意点 | `inline` |
| 具体例で変数値がどう変わるか | `trace` |

`--run` は明示された時だけLLM生成または実行を開始します。付けなければ対象画面を開くだけです。文脈に応じた0〜複数対象の制御と構造化結果の取得には、上位互換のMCPツールを使用します。

## 外部AIへ渡す指示例

プロジェクトの `AGENTS.md` や `CLAUDE.md` に次を追加すると、AIが必要な時だけ画面を選びやすくなります。

```markdown
コードの構造・処理順・非自明な箇所・実行時の値を説明する際は、必要に応じて
`node .ai-code-guide/ai-code-guide.mjs status` で接続を確認し、
`show standard|overview|project|diagram|inline|trace` の最小画面から始め、返された結果に応じて0〜複数の追加操作を選ぶ。
`--run` は利用者が生成・実行を求めた場合だけ付ける。
diagramが返したhtmlPathは、利用者が会話内ブラウザで開けるよう提示する。
```

## 安全境界

- サーバーは `127.0.0.1` のランダムポートだけで待ち受けます。
- 起動ごとのランダムトークンが一致しない要求は拒否します。
- 公開する操作は6ビューだけです。任意のVS Codeコマンドは実行できません。
- ファイルは現在のワークスペース内にある実在ファイルだけを受け付けます。
- マニフェストは所有者だけが読める権限で作り、拡張終了時に削除します。
