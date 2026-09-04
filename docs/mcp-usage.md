# ChatGPT / ClaudeからAI Code Guideを使う

AI Code Guideは、ローカルのstdio MCPサーバーとして主要な理解支援機能を公開します。Webアプリや公開サーバーは使いません。MCPクライアントとVS Code拡張は同じMac上で動き、既存のlocalhostブリッジを通じて画面を開きます。

## 普段の使い方

自動利用の設定後は、AI Code Guideの名前やMCPツール名を指定する必要はありません。CodexやClaude Codeへ普段どおり話しかけます。

```text
task_manager.pyにはどんな関数がある？
このファイルは何をしている？
注文確定から保存までの流れを図にして
このリポジトリの構成を見せて
```

Python・JavaScript・TypeScriptコード理解の依頼では、エージェント用スキルが最小の表示ツールから始め、返された構造化結果を見て次の操作を0〜複数選びます。標準表示はCodex内の広いブラウザパネルで開き、VS Code標準タブと同じ定義順カード、クラス配下、カード内展開で、コード範囲と目的・入出力・状態・処理ブロックを確認できます。VS Codeの標準ビューも同じ内容へ同期します。実行トレースだけはPython限定です。

表示だけで足りる場合は追加操作を行いません。図・概要・プロジェクト説明・インライン解説の新規生成や実行トレースは、その結果を利用者が求めた時だけ使います。

## 公開するツール

| MCPツール | 動作 | LLM・実行 |
|---|---|---|
| `get_ai_code_guide_status` | VS Codeとの接続と利用可能ビューを確認 | なし |
| `show_standard_view` | Codexのブラウザパネルへ、VS Codeと同じ定義順カード式の標準Webviewを開く。VS Codeにも同期する | なし |
| `expand_standard_items` | 選んだ0〜複数の関数・クラス内部をCodex WebviewとVS Codeで展開。`scopeLine`で一つの定義だけを表示し、`replaceExpanded: true`で今回の対象だけを開ける | 未保存分はLLMを使用 |
| `show_file_overview` | 保存済みファイル概要を返す | なし |
| `generate_file_overview` | ファイルの役割・意味グループを生成 | LLMを使用 |
| `show_project_structure` | ファイル・ディレクトリ・import構成を返す | なし |
| `generate_project_explanations` | ファイル・ディレクトリの役割を生成 | LLMを使用 |
| `create_code_diagram` | 質問に合わせたコード図を生成・表示 | LLMを使用 |
| `show_inline_annotations` | 保存済みインライン解説を表示 | なし |
| `generate_inline_annotations` | ファイル全体または指定行範囲の解説を生成 | LLMを使用 |
| `revise_inline_annotations` | 指定した解説だけを削除・非表示にし、必要なら指定範囲へ代わりの解説を生成 | 範囲生成時のみLLMを使用 |
| `show_saved_trace` | 0〜複数関数の保存済みトレースだけを表示 | なし |
| `run_trace` | 0〜複数関数の入力例を作り、実行トレース | LLM＋Python実行 |

`activate: false` を指定すると、複数の根拠を準備する途中でそのビューを最終表示にしません。AIは最後に最も重要なビューだけをアクティブにできます。空の対象配列は「対象なし」であり、全件指定には変換されません。

内蔵チャット、使用量、設定、ヘルプはMCPツールにしていません。ChatGPT／Claude自身が会話を担当し、運用画面は引き続きVS Codeで人が操作するという分担です。

## 前提

AI Code Guide拡張がインストールされていれば、MCPツールへ**別プロジェクト内の絶対パスのPython・JavaScript・TypeScriptファイル**を渡した時は、そのファイルのプロジェクトをVS Codeで開き、接続を待ってから表示します。プロジェクトルートは、シンボリックリンクを解決した絶対パスから親方向の `.git`、`pyproject.toml`、`setup.py` で判定します。

すでに対象リポジトリをVS Codeで開いている場合は、その接続をそのまま使い、重複ウィンドウを作りません。未接続の場合も、VS Codeの起動完了後に拡張が自動起動するため、対象ファイルやAI Code Guideサイドバーを手動で開く必要はありません。接続待ちは間隔を段階的に広げながら行い、応答確認後に元のMCP要求を再開します。ワークスペース直下には次の一時ファイルが作られます。

```text
.ai-code-guide/ai-code-guide-mcp.mjs
.ai-code-guide/activation.json
.ai-code-guide/bridge.json
```

`activation.json` は拡張起動とbridge作成のどちらで止まったかを区別する、tokenを含まない一時状態です。`bridge.json` はランダムtokenを含む一時接続情報です。どちらも拡張を閉じると削除されます。MCPサーバーは固定ポートや保存済みトークンを持たず、起動中の拡張が作った接続だけを使います。

プロジェクトごとに固定登録する場合は、以下の例のように対象リポジトリのルートへ移動します。複数プロジェクトで自動利用する場合は、配布物の `bin/ai-code-guide-mcp.mjs` を引数なしでユーザースコープへ1回登録し、Codex用スキルを `~/.agents/skills/ai-code-guide`、Claude Code用スキルを `~/.claude/skills/ai-code-guide` に配置します。引数なしのサーバーは、エージェントを起動したディレクトリから `.ai-code-guide/bridge.json` を探索します。

## ChatGPTデスクトップ / Codex

現在のChatGPTデスクトップ、Codex CLI、Codex IDE拡張は同じMCP設定を共有できます。ターミナルから登録する場合:

```bash
cd /path/to/your-project
codex mcp add ai-code-guide -- node "$PWD/.ai-code-guide/ai-code-guide-mcp.mjs" --workspace "$PWD"
codex mcp list
```

ChatGPTデスクトップの画面から登録する場合は、Settings → MCP servers → Add serverでSTDIOを選び、次を指定して再起動します。

- command: `node`
- args: `/絶対パス/.ai-code-guide/ai-code-guide-mcp.mjs --workspace /絶対パス`

会話欄で `/mcp` を入力すると、接続中のサーバーとツールを確認できます。ChatGPTのWeb版はローカル設定ファイルを読めないため、このローカルstdio方式の対象外です。

公式情報: [OpenAI Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)

## Claude Code

```bash
cd /path/to/your-project
claude mcp add ai-code-guide --scope local -- node "$PWD/.ai-code-guide/ai-code-guide-mcp.mjs" --workspace "$PWD"
claude mcp list
```

Claude Code内では `/mcp` で接続状態を確認できます。`--scope local` は、そのプロジェクトだけで使う個人設定です。

## Claude Desktop

Claude DesktopのMCP設定へ、絶対パスでstdioサーバーを追加します。設定JSONの形は次のとおりです。

```json
{
  "mcpServers": {
    "ai-code-guide": {
      "command": "node",
      "args": [
        "/絶対パス/.ai-code-guide/ai-code-guide-mcp.mjs",
        "--workspace",
        "/絶対パス"
      ]
    }
  }
}
```

保存後にClaude Desktopを再起動し、ツール一覧に `ai-code-guide` が現れることを確認します。

公式情報: [Anthropic Model Context Protocol](https://docs.anthropic.com/en/docs/mcp)

## ツールを明示したい場合

```text
このリポジトリの構成をAI Code Guideで見せて
```

→ `show_project_structure`

```text
注文確定から保存までの処理順を図にして、VS Codeにも表示して
```

→ `create_code_diagram`

```text
examples/single_file/algorithms.py のquicksortを具体例でトレースして
```

→ `run_trace`

生成・実行系のツールは、ユーザーがその種類の結果を求めた場合だけ使うようサーバー指示にも記載しています。一方、「注文処理の流れと金額の変化」のように複数種類の根拠が必要な質問では、AIが構成・図・トレースを連続して利用します。

## 安全境界

- 既存のVS Code接続へ外部ファイルを渡すことはせず、外部の絶対Pythonパスは対象プロジェクトを開いた後の別接続へ送る。シンボリックリンクを解決した後にも、その接続のワークスペース外は拒否する
- localhostブリッジのランダムトークンはMCP結果へ返さない
- MCPの標準出力にはプロトコルメッセージだけを出し、診断は標準エラーへ出す
- 表示だけのツールと、LLMを使う生成ツールを分ける
- `run_trace` はAI Code Guideの副作用判定、`__main__` 非実行、10秒タイムアウトを使うが、完全なサンドボックスではない
- ChatGPT／ClaudeのWebサービスへローカルコード全体を常設公開するサーバーではない。ただしLLM生成ツールを使うと、既存設定に従って対象コードが選択したAIプロバイダへ送られる

## 接続できないとき

- `VS Code could not open...`: VS CodeのCLIがインストールされているか、対象パスを開けるかを確認する
- `extension did not activate...`: 対象ウィンドウのVS CodeプロファイルでAI Code Guideがインストール・有効化されているか確認する
- `bridge was not created...`: VS Codeの出力パネルでAI Code Guideの起動エラーを確認し、Reload Windowする
- `bridge ... did not respond...`: VS CodeをReload Windowし、MCPクライアントも再起動する
- ツールが見えない: `codex mcp list`、`claude mcp list`、またはアプリのMCP設定を確認する
- 別リポジトリを開いてしまう: 登録した `--workspace` の絶対パスを確認する
- 拡張更新後に古いツールが出る: VS Codeを再読み込みして `.ai-code-guide/ai-code-guide-mcp.mjs` を再配置し、MCPクライアントを再起動する
