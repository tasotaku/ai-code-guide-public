// 配布(.vsix)用バンドル。tsc(out/*.js, 開発・テスト用)とは別に、esbuild で
// src/extension.ts を1ファイル out/extension.js に固める。@anthropic-ai/sdk を inline するので
// node_modules を同梱しなくてもAPIモードが動く。vscode は実行時に提供されるため external。
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// AI_NOTE: mermaid は webview が <script> で読む資産。.vsix は node_modules を同梱しないため
// media/ にコピーして同梱する(mermaid.ts は media/ を優先して読む)。
const mermaidSrc = path.join("node_modules", "mermaid", "dist", "mermaid.min.js");
fs.mkdirSync("media", { recursive: true });
fs.copyFileSync(mermaidSrc, path.join("media", "mermaid.min.js"));
console.log("copied mermaid.min.js -> media/");

esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],     // VS Code 本体が提供。バンドルしない
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: true,
  sourcemap: false,
}).then(() => console.log("bundled -> out/extension.js")).catch((e) => {
  console.error(e);
  process.exit(1);
});

// AI_NOTE: vscode:uninstall フック用スクリプト。.vsix 作成(vscode:prepublish)は bundle しか
// 走らせないため、tsc(開発用)とは別にここでもビルドして out/uninstall.js を確実に最新にする。
esbuild.build({
  entryPoints: ["src/uninstall.ts"],
  bundle: true,
  outfile: "out/uninstall.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: true,
  sourcemap: false,
}).then(() => console.log("bundled -> out/uninstall.js")).catch((e) => {
  console.error(e);
  process.exit(1);
});

// AI_NOTE: ChatGPT desktop / Codex / Claude系クライアントがローカルstdio MCPとして起動する単一ファイル。
// SDKとzodをinlineし、利用先ワークスペースへこの1ファイルだけコピーすれば動くようにする。
esbuild.build({
  entryPoints: ["src/mcp/server.ts"],
  bundle: true,
  outfile: "bin/ai-code-guide-mcp.mjs",
  platform: "node",
  format: "esm",
  target: "node18",
  minify: true,
  sourcemap: false,
}).then(() => {
  fs.chmodSync("bin/ai-code-guide-mcp.mjs", 0o755);
  console.log("bundled -> bin/ai-code-guide-mcp.mjs");
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
