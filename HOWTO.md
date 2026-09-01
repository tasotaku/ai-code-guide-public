# AI Code Guide — はじめかた（研究室メンバー向け）

Python コードの理解を補助する VS Code 拡張です。フローチャート表示・プロジェクト全体のマップ・コード内への AI 解説の3つができます。

このファイルだけ読めばセットアップから最初の動作確認まで完了します。使い方の詳細は拡張内のヘルプに画像付きであります（→ [4. 使い方の続き](#4-使い方の続き)）。

---

## 0. 必要なもの

- **VS Code**
- **Python 3.8+**: ターミナルで `python3 --version` が通ること
- **LLM の認証手段（どれか1つ、自分のもの）**:
  - Claude のサブスク（`claude` CLI にログイン済み）← APIキー不要
  - ChatGPT Plus/Pro（`codex` CLI にログイン済み）← APIキー不要
  - API キー（Anthropic / OpenAI / Gemini のどれか）

> ⚠️ API キーやサブスクのログインは共有できません。各自のアカウントを使ってください。

## 利用上の注意（先に読んでください）

- **開いている Python コードは、解説を生成するたびに LLM プロバイダ（Anthropic / OpenAI / Google）へ送信されます。** 未公開の研究データや共同研究先のコードなど、外部に送ってよいか迷うものに使う前に、研究室のルール・指導教員に確認してください。
- **必ず公式リンクから自分でダウンロードしてください** → https://github.com/tasotaku/ai-code-guide-dist/releases/latest/download/ai-code-guide.vsix 。この vsix は Marketplace の審査や署名を経ていない配布なので、「公式ページから直接落とした」という事実が本物である保証になります。人づてに転送された `.vsix` は、途中で改ざんされたファイルが混ざっていても受け取った人には見分けられません。他人から受け取ったファイルは使わず、上の公式リンクから入手してください。使い方の質問や不具合は配布者（宮内）まで。

## 1. インストール

公式リンクから `ai-code-guide.vsix` をダウンロードしたら、ターミナルで:

```bash
code --install-extension ai-code-guide.vsix --force
```

> `code` は VS Code に付属するターミナル用コマンドです（`code ファイル名` でファイルを開く等に使うもの）。「command not found」になる場合は、VS Code で `Cmd+Shift+P` →「**Shell Command: Install 'code' command in PATH**」を一度実行すると使えるようになります。
>
> ターミナルを使いたくない場合は、拡張機能ビュー（`Cmd+Shift+X`）右上の「…」→「**Install from VSIX...**」から `ai-code-guide.vsix` を選んでも同じです。

インストール後、`Cmd+Shift+P` →「**Reload Window**」でウィンドウを再読み込み。左のアクティビティバーに **AI Code Guide** のアイコンが出れば成功です。

## 2. 認証設定（どれか1つ）

サイドバーの AI Code Guide アイコンをクリック →「**設定**」タブを開きます。

### A. Claude サブスクで使う（APIキー不要）

1. 事前にターミナルで `claude` CLI にログインしておく（`claude` を起動してログイン。未インストールなら https://claude.com/claude-code ）
2. 設定タブ →「バックエンド」→「**サブスクで動かす**」を **ON**、提供元を **Claude** にする

### B. ChatGPT サブスクで使う（APIキー不要）

1. 事前にターミナルで `codex` CLI にログインしておく
2. 設定タブ →「バックエンド」→「**サブスクで動かす**」を **ON**、提供元を **ChatGPT** にする

### C. API キーで使う（Anthropic / OpenAI / Gemini）

1. 「サブスクで動かす」は **OFF** のまま
2. コマンドパレット（`Cmd+Shift+P`）から「**AI Code Guide: APIキーを設定**」を実行 → プロバイダを選んでキーを貼り付ける（キーは settings.json でなく **OS のキーチェーンに安全に保存**されます。削除したいときは同じコマンドで空のまま Enter）
3. **既定モデルは Claude 系**なので、OpenAI / Gemini のキーで使う場合はモデルの切り替えが必要です: サイドバーの「**設定**」タブ →「**モデル**」で、3系統（構造説明・会話・インライン解説）をそれぞれ `gpt-*` / `gemini-*` のモデルに変更する

> モデル名の接頭辞（`claude-*` / `gpt-*` / `gemini-*`）でどのキーを使うか自動判定されます。使うモデルのキーだけあれば OK です。

## 3. 動作確認（1分）

1. 適当な Python ファイルを開く
2. **Cmd+Alt+V** → エディタ横にフローチャートが開けば OK
3. **Cmd+Alt+E** → コード内にオレンジの下線・枠で AI 解説が付けば認証も OK（**Cmd+Alt+C** で消せます）

## 4. 使い方の続き

- サイドバーの「**ヘルプ**」タブ — 実画面のスクリーンショット付きで全機能を説明
- `Cmd+Shift+P` →「**AI Code Guide: ようこそガイド（使い方）を開く**」— VS Code のウォークスルー形式
- 最初に「**AI Code Guide: Set Global Context**」で「Python初心者です」「日本語で説明して」などを設定しておくと、すべての解説がそれに合わせて生成されます

## 5. つまずいたら

| 症状 | 対処 |
|---|---|
| インストールしたのにアイコンが出ない | ウィンドウを再読み込み（`Cmd+Shift+P` → Reload Window） |
| フローチャートが出ない・エラーになる | `python3` が PATH にあるか確認（ターミナルで `python3 --version`） |
| サブスク ON なのに解説が生成されない | そのマシンで `claude`（または `codex`）CLI にログイン済みか確認。インストール場所が特殊なら設定の `aiCodeGuide.claudeCliPath` / `codexCliPath` に絶対パスを入れる |
| Dock から起動した VS Code だと CLI が見つからない | 一度ターミナルから `code` で起動し直すか、上記の CliPath 設定を使う |
| 解説が多すぎる・少なすぎる | 設定タブの密度（minimal / normal / dense）を変えて再生成 |
| 登録した API キーを消したい・入れ替えたい | コマンドパレットから「**AI Code Guide: APIキーを設定**」→ プロバイダを選び、**空のまま Enter で削除**（新しいキーを貼れば上書き）。設定タブの「編集」ボタンからでも同じ |

解決しなければ配布者（宮内）まで。

## 6. 更新

**自動更新はありません。** 新しい `.vsix` を受け取ったら [1. インストール](#1-インストール) をもう一度実行してウィンドウを再読み込みしてください。

## 7. アンインストール（いらなくなったら）

1. 拡張機能ビュー（`Cmd+Shift+X`）で「AI Code Guide」を探し「**アンインストール**」→ ウィンドウを再読み込み
   - ターミナル派は `code --uninstall-extension neoai-research.ai-code-guide` でも同じ
2. API キーを設定していた場合は、アンインストールの**前に**「**AI Code Guide: APIキーを設定**」で該当プロバイダを選び空のまま Enter して削除しておくと確実です（旧版で settings.json に直接キーを書いていた人は、設定（`Cmd+,`）で「AI Code Guide」を検索してキー欄が空か確認）

キャッシュ（AI解説・質問チャット履歴・トークン使用量の記録）は、**アンインストール後に次へ VS Code を起動したとき自動で削除されます**（v0.1.1以降）。それより古い版を使っていた場合や、今すぐ消したい場合はターミナルで:

```bash
rm -rf ~/Library/Application\ Support/Code/User/globalStorage/neoai-research.ai-code-guide
```
