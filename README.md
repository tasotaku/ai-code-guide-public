# AI Code Guide

## Windows quickstart

Requirements: Windows 10/11, Git, Node.js 20+, Python 3.12+, and the VS Code `code` command in `PATH`.

```powershell
git clone https://github.com/tasotaku/ai-code-guide-public.git
cd ai-code-guide-public
python bootstrap.py install
```

AI-powered code understanding for VS Code — flowchart visualization, project-wide import maps, code diagrams, execution traces, and an interactive symbol dictionary for Python files.

This is the public source edition. Building and packaging it does not require an API key, GitHub login, private repository, private registry, or VPN. AI credentials are optional runtime configuration and stay in VS Code SecretStorage or the selected provider CLI.

The single bootstrap command checks prerequisite versions, installs dependencies from the public npm registry, compiles and bundles the extension, creates `ai-code-guide.vsix`, and installs it into VS Code. It ends with a clear success/failure summary. Recheck later with `python bootstrap.py check`.

macOS and Linux source builds may work through the underlying npm scripts, but this public bootstrap is currently verified only on Windows; support on those platforms is **UNKNOWN**.

## Features

- **Flowchart panel**: View an interactive flowchart of any Python file alongside your editor. Click a node to jump to the corresponding code line; click a code line to highlight the corresponding node.
- **Project view**: Visualize all Python files in your workspace as cards with import dependency arrows. Click a file card to drill into its flowchart.
- **AI descriptions**: Generate AI-written descriptions for each file and function. Appears as a subtitle under each card/node.
- **Granularity control**: Switch between normal and coarse (概要) views, or type natural-language instructions to filter what's shown (e.g. "show only `hash_password`", "more detail").
- **Interactive symbol dictionary**: Deterministically finds names in the selected Python scope, keeps normal code styling, and shows compact explanations on hover. Ask a follow-up to refine an explanation.
- **Follow-up questions**: Click "💬 質問する" on any annotation to ask a follow-up in the chat panel.
- **Global context setting**: Tell the AI your background (e.g. "I'm a Python beginner" or "explain in Japanese") to tailor all explanations.
- **Codex / Claude Code bridge**: Let an external coding agent open the standard, overview, project, diagram, inline, or trace view with one local CLI command. Generated diagram HTML links back to the exact code in VS Code. See [agent usage](docs/agent-usage.md).

## Codex / Claude Codeから使う

拡張起動中は、ワークスペースにローカル専用CLIが作られます。

```bash
node .ai-code-guide/ai-code-guide.mjs status
node .ai-code-guide/ai-code-guide.mjs show standard --file path/to/file.py --line 10
node .ai-code-guide/ai-code-guide.mjs show diagram --question "この機能の処理順"
```

AIとの対話はCodex / Claude Codeに任せ、AI Code Guideは理解に必要な画面を表示します。全コマンドと使い分けは[Codex / Claude Codeからの利用方法](docs/agent-usage.md)を参照してください。

全10タブを含む機能の一覧は[機能カタログ](docs/feature-catalog.md)にまとめています。

ChatGPTデスクトップ、Codex、Claude Code、Claude Desktopから主要機能をMCPツールとして呼ぶ方法は[MCP利用ガイド](docs/mcp-usage.md)を参照してください。

## Requirements

- Windows 10/11 for the verified bootstrap path
- Node.js 20+, Python 3.12+, Git, and VS Code with `code` in `PATH`
- 認証は次のどちらか（拡張の設定で切替）:
  - [Anthropic API キー](https://console.anthropic.com/)、または
  - Claude のサブスク（`claude` CLI にログイン済み）— APIキー不要

## インストール・更新・配布

Windowsの標準経路は、このREADME冒頭の `python bootstrap.py install` です。ビルド時にAIサービスへのログインやAPIキーは不要です。初回起動後、AI説明を使う場合だけ各自のChatGPT/ClaudeサブスクCLI、またはAnthropic/OpenAI/Google APIキーを設定してください。

### 普段使い（常駐インストール）

Windowsではリポジトリ直下で:

```powershell
python bootstrap.py install
```

macOS/Linux向けの従来ビルド入口は未検証です:

```bash
./install.sh
```

bundle → `.vsix` 作成 → VS Code へインストール まで一発。完了後、VS Code を再読み込み（`Cmd+Shift+P` →「**Reload Window**」）すると有効になります。以降は普通の VS Code ウィンドウで常駐します（`./debug.sh` の開発ホストとは別物）。

### 更新タイミング（重要）

**`.vsix` は自動更新されません。** ソースを変更しても、`git pull` しても、常駐版は変わりません。最新を反映する手順:

1. コードを変更
2. `./install.sh` を再実行（`--force` で上書き）
3. VS Code を**再読み込み**（開いているウィンドウは再読み込みするまで旧版のまま動きます）

### 他の人へ配布（研究室メンバーなど）

1. 配布者: `PACKAGE_ONLY=1 ./install.sh` で `ai-code-guide.vsix` を作り、**[HOWTO.md](HOWTO.md) と一緒に**渡す
2. 受け取った人: HOWTO.md に沿ってインストール・認証設定・動作確認（要点: `code --install-extension ai-code-guide.vsix --force` → ウィンドウ再読み込み）

**自動更新はありません**（Marketplace 公開版だけの機能）。改良したら新しい `.vsix` を配り直し、各自が再インストールします。`package.json` の `version` を上げておくと `code --list-extensions --show-versions` で誰がどの版か分かります。

各メンバーに必要なもの:

- `python3`（PATH に）
- 認証（次のいずれか）: ChatGPTサブスク（`codex` CLI、既定）、Claudeサブスク（`claude` CLI）、または各APIキー
- ※ あなたのキー / サブスクは共有できません

### 認証モード（APIキー / サブスク）の切替

拡張パネル右の「**設定**」タブ → **バックエンド** で切り替えます:

- **OFF**: APIキーを使用（コマンド「AI Code Guide: APIキーを設定」で入力。OSのキーチェーンに保存され settings.json には残らない）
- **ON（サブスク）**: APIキー不要でサブスク認証（ログイン済みマシン限定）。**提供元**を選べます:
  - **Claude**（`claude` CLI）: 選んだ品質ティア（Haiku/Sonnet/Opus）のまま生成。`claude` の場所は `aiCodeGuide.claudeCliPath`
  - **ChatGPT**（`codex` CLI、既定）: ChatGPT(Plus/Pro) のログインで、全AI機能を `gpt-5.6-sol` 固定で生成。`codex` の場所は `aiCodeGuide.codexCliPath`

`claude` / `codex` のパスは未設定でも既知の場所・ログインシェルから自動検出します。

## Development setup

### 1. Install the extension

Open this folder in VSCode and press **F5** to launch a development instance, or package it with `vsce package` and install the `.vsix`.

### 2. Set your API key

Run **AI Code Guide: APIキーを設定** from the Command Palette (`Cmd+Shift+P`), pick a provider, and paste your key. Keys are stored in the OS keychain (VS Code SecretStorage), not in `settings.json`. Keys previously written to `settings.json` are migrated (and wiped from settings) automatically on startup.

### 3. Install Node dependencies

```bash
cd ai-code-guide
npm ci
npm run compile
```

## License

The source is publicly visible, but no reuse license is granted. See [LICENSE](LICENSE). If an open-source license is adopted later, this section and the license file will be updated explicitly.

## Usage

### Flowchart (single file)

1. Open a Python file.
2. Press **Cmd+Alt+V** (Mac) / **Ctrl+Alt+V** (Windows/Linux), or run **AI Code Guide: Show Flowchart** from the Command Palette.
3. The flowchart panel opens beside your editor and auto-updates on save.

**Chat commands** (type in the panel's input box):

| Input | Effect |
|-------|--------|
| `rough` / `ざっくり` | Show only top-level functions/classes |
| `detail` / `細かく` | Show all branches and loops |
| `hash_password だけ` | Show only the `hash_password` function |
| `normal` | Reset to default granularity |

### Project view

1. Open a workspace folder.
2. Run **AI Code Guide: Show Project Flowchart** from the Command Palette (or click a file card from a single-file flowchart).
3. All Python files are shown as cards. Arrows indicate import dependencies: **○ (hollow circle)** marks the importing file, **▶** points to the imported file.
4. Click a file card to drill into that file's flowchart.
5. Click **✨ AI説明** to generate AI descriptions for all files. Switch to **概要** view for a semantically grouped overview (requires one LLM call; result is cached).

### Semantic annotations (always-on inline explanations)

1. Open a Python file and press **Cmd+Alt+E** (Mac) / **Ctrl+Alt+E** (Windows/Linux), or run **AI Code Guide: Explain Block Inline**. (Set `aiCodeGuide.autoInlineAnnotations` to `true` to generate automatically when a file opens.)
2. The AI picks the spots worth explaining and shows them inline, always visible:
   - **Token (symbol)**: a dotted underline on the token, with the explanation on a CodeLens line just **below** the code, indented toward the token.
   - **Block (multi-line)**: the region is framed with a box border, and the explanation flows as a multi-line note in the right margin.
   - Bugs/problems are shown in red; normal explanations in orange.
3. Hover any annotated spot for the full detail, and click **💬 質問する** to ask a follow-up in the chat panel.
4. Press **Cmd+Alt+C** / **Ctrl+Alt+C** (or edit the file) to clear.
5. The sidebar **Chat** tab also has a control panel: **生成 / 範囲 / クリア** buttons, a **density** dropdown (`minimal / normal / dense` — applied on next generation), an **auto** toggle, and a collapsible list of current annotations with jump (`→`) and follow-up chat (`💬`) shortcuts. The keyboard shortcuts above still work.

### Global Context

Run **AI Code Guide: Set Global Context** to set a system-level instruction that applies to all explanations. Examples:

- `I am a Python beginner, please use simple language`
- `Explain everything in Japanese`
- `I am familiar with Django but new to this codebase`

Changing the global context clears the explanation cache so all tooltips and descriptions regenerate with the new context.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aiCodeGuide.useSubscription` | `true` | ON でAPIキーの代わりにサブスクCLI経由で生成。既定はChatGPT/Codex＋GPT-5.6 Sol |
| `aiCodeGuide.subscriptionProvider` | `codex` | `codex`なら全AI機能をChatGPTサブスクのGPT-5.6 Solで生成 |
| `aiCodeGuide.claudeCliPath` | `claude` | `useSubscription` ON 時に叩く `claude` のコマンド/絶対パス |
| `aiCodeGuide.anthropicApiKey` | `""` | Your Anthropic API key |
| `aiCodeGuide.globalContext` | `""` | Global context prepended to all AI explanations |
| `aiCodeGuide.autoDescribe` | `true` | Generate AI descriptions automatically when opening a view. Set to `false` to trigger manually via ✨ AI説明 (reduces API cost during testing) |
| `aiCodeGuide.autoShowOnOpen` | `false` | Auto-open the flowchart panel when a Python file is opened |
| `aiCodeGuide.model` | `gpt-5.6-sol` | Model used for flowchart / description generation |
| `aiCodeGuide.chatModel` | `gpt-5.6-sol` | Model used for chat / file explanations |
| `aiCodeGuide.inlineAnnotationModel` | `gpt-5.6-sol` | Model used for semantic annotations and trace preparation |
| `aiCodeGuide.inlineAnnotationDensity` | `normal` | Criteria depth: `minimal` / `normal` / `dense` / `ultra`（固定件数ではない） |
| `aiCodeGuide.autoInlineAnnotations` | `false` | Generate semantic annotations automatically when a Python file opens |

### Keybindings (Python editor only)

| Mac | Win/Linux | Command |
|-----|-----------|---------|
| `Cmd+Alt+V` | `Ctrl+Alt+V` | Show Flowchart |
| `Cmd+Alt+E` | `Ctrl+Alt+E` | Explain Block Inline (semantic annotations) |
| `Cmd+Alt+C` | `Ctrl+Alt+C` | Clear Block Explanations |

Show Project Flowchart has no default keybinding — run it from the Command Palette, or open it by clicking a file card from the single-file flowchart.

## Architecture

```
[VSCode Extension (TypeScript)]
  ├── extension.ts              — activation, command registration, event wiring
  ├── flowchart/
  │   ├── astParser.ts          — shells out to python/ast_parser.py
  │   ├── flowchartCache.ts     — caches parsed graphs per file
  │   └── mermaid.ts            — renders the graph JSON into Mermaid + CSP'd webview HTML
  ├── inline/
  │   └── blockExplanationProvider.ts — semantic annotations (underline + below-line CodeLens, boxed blocks + sidenote, hover), cache
  ├── view/
  │   ├── mainViewProvider.ts   — sidebar Webview: flowchart + project view + chat + settings panes
  │   ├── chatStore.ts          — follow-up chat state per annotation
  ├── util/
  │   └── resolveCommand.ts     — resolves python3 / claude / codex paths (Dock-launch PATH fix)
  └── api/
      ├── annotationResolver.ts — maps model output to verified line/col by text search (vscode-free, unit-tested)
      ├── claudeClient.ts       — prompts for labels, granularity, descriptions, annotations
      └── llmProvider.ts        — multi-provider adapter (Anthropic / GPT / Gemini / claude CLI / codex CLI), normalized to Anthropic shape

[python/ast_parser.py]
  — Parses Python source via stdlib `ast`
  — Commands: `flowchart <granularity> [func]` | `project_graph`
  — Outputs JSON to stdout
```

## Development

```bash
npm install
npm run watch   # incremental TypeScript compilation
# Press F5 in VSCode to launch Extension Development Host
```
