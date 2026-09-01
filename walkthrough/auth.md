## 認証の2つの方式

AI Code Guide は解説の生成に LLM を使います。次のどちらかを設定すれば動きます。

### A. APIキー方式
コマンドパレット（Cmd+Shift+P）から「**AI Code Guide: APIキーを設定**」を実行し、プロバイダを選んでキーを貼り付けます。使うモデルのプロバイダのキーだけでOKです。

| プロバイダ | モデル接頭辞 |
|---|---|
| Anthropic (Claude) | `claude-*` |
| OpenAI (GPT) | `gpt-*` |
| Google (Gemini) | `gemini-*` |

モデル名の接頭辞でプロバイダを自動判定します。

### B. サブスク方式（APIキー不要）
ログイン済みの `claude`（または `codex`）CLI を使います。**このマシンでログイン済みのときだけ**動きます。

設定タブ →「バックエンド」→「サブスクで動かす」を ON にします。

> APIキーは settings.json（平文・Settings Sync でクラウド同期され得る）には保存されず、OS のキーチェーン（SecretStorage）に保存されます。削除はもう一度コマンドを実行して空のまま Enter。
