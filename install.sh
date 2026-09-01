#!/bin/bash
# 普段使い用: バンドル → .vsix 作成 → VS Code にインストール を一発で。
# 配布用に .vsix だけ欲しい場合は PACKAGE_ONLY=1 ./install.sh
set -e
cd "$(dirname "$0")"

echo "▶ バンドル中 (esbuild)..."
npm run bundle

echo "▶ .vsix を作成中..."
# --no-dependencies: 依存は esbuild で out/extension.js に inline 済み。node_modules は同梱しない
npx --yes @vscode/vsce package --no-dependencies -o ai-code-guide.vsix

if [ "${PACKAGE_ONLY:-0}" = "1" ]; then
  echo "✅ ai-code-guide.vsix を作成しました（インストールはスキップ）。"
  exit 0
fi

echo "▶ VS Code にインストール中..."
CODE="code"
command -v code >/dev/null 2>&1 || CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
"$CODE" --install-extension ai-code-guide.vsix --force

echo "✅ 完了。VS Code を再読み込み（Cmd+Shift+P → Reload Window）すると有効になります。"
