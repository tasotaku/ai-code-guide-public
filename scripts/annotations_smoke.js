#!/usr/bin/env node
// SemanticAnnotation 生成のスタンドアロン検証（VSCode不要）。
// 本番の generateSemanticAnnotations() を「そのまま」叩くので、プロンプトの乖離が起きない。
//   ※ 旧 scripts/test_annotations.py はプロンプトを Python に再実装しており本番と乖離していたため、
//      この JS ハーネス（out/api/claudeClient.js を import）を正とする。
//
// 事前に `npm run compile` 済みであること（out/ を読む）。
//
// 使い方:
//   node scripts/annotations_smoke.js <python_file> [model] [density]
// 例:
//   node scripts/annotations_smoke.js examples/single_file/algorithms.py            # 既定 codex:gpt-5.6-sol
//   node scripts/annotations_smoke.js examples/single_file/algorithms.py codex:gpt-5.6-sol normal
//   ACG_API_KEY=sk-ant-... node scripts/annotations_smoke.js examples/.../x.py claude-sonnet-4-6
//
// model の選び方:
//   cli:<tier>     … Claude サブスク(claude CLI)。ログイン済みマシン限定・APIキー不要
//   codex:gpt-5.6-sol … ChatGPT サブスク(codex CLI)のSol固定。ログイン済みマシン限定・APIキー不要
//   claude-*/gpt-*/gemini-* … APIキー必須（ACG_API_KEY か VSCode設定 aiCodeGuide.* を使う）
const Module = require("module");
const fs = require("fs");
const path = require("path");

const file = process.argv[2];
if (!file) {
    console.error("usage: node scripts/annotations_smoke.js <python_file> [model] [density]");
    process.exit(1);
}
const model = process.argv[3] || "codex:gpt-5.6-sol";
const density = process.argv[4] || "normal";

// AI_NOTE: 本番コードは vscode.workspace.getConfiguration で設定を読む。ここでは CLI 実行用に
// 最小スタブを差し込み、必要な設定だけ返す。APIキーは ACG_API_KEY 環境変数を優先。
const cfg = {
    inlineAnnotationModel: model,
    useSubscription: model.startsWith("codex:") || model.startsWith("cli:"),
    subscriptionProvider: model.startsWith("cli:") ? "claude" : "codex",
    inlineAnnotationDensity: density,
    globalContext: "",
    claudeCliPath: "claude",
    // AI_NOTE: WindowsApps の実行エイリアスが spawn EPERM になる環境では、doctor が見つけた実体を環境変数で渡す。
    codexCliPath: process.env.ACG_CODEX_CLI_PATH || "codex",
    anthropicApiKey: process.env.ACG_API_KEY || "",
    openaiApiKey: process.env.ACG_API_KEY || "",
    geminiApiKey: process.env.ACG_API_KEY || "",
};
const fakeVscode = { workspace: { getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d) }) } };
const origLoad = Module._load;
Module._load = (req, parent, isMain) => (req === "vscode" ? fakeVscode : origLoad.call(Module, req, parent, isMain));

const compiled = path.join(__dirname, "..", "out", "api", "claudeClient.js");
if (!fs.existsSync(compiled)) {
    console.error("out/ が見つかりません。先に `npm run compile` を実行してください。");
    process.exit(1);
}
const {
    generateSemanticAnnotations,
    getTokenLog,
    missingRequiredAnnotationTargets,
} = require(compiled);

(async () => {
    const code = fs.readFileSync(file, "utf8");
    const lines = code.split("\n");
    const t0 = Date.now();
    const anns = await generateSemanticAnnotations(code);
    const calls = getTokenLog().filter((entry) => entry.operation.startsWith("generateSemanticAnnotations"));
    const missing = missingRequiredAnnotationTargets(code, anns);
    console.log(`model=${model} effective_models=${[...new Set(calls.map((entry) => entry.model))].join(",")} model_calls=${calls.length} density=${density} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s count=${anns.length} required_missing=${missing.length}\n`);
    for (const a of anns) {
        const loc = a.kind === "block" ? `L${a.startLine + 1}-${a.endLine + 1}` : `L${a.startLine + 1} c${a.startCol}-${a.endCol}`;
        console.log(`[${a.kind}/${a.severity}] ${loc}`);
        if (a.kind === "symbol") console.log(`   code : ${lines[a.startLine]}`);
        console.log(`   label: ${a.label}`);
        console.log(`   expl : ${a.explanation}\n`);
    }
    const passed = anns.length > 0 && missing.length === 0;
    if (missing.length > 0) console.error("MISSING:", missing);
    console.log(passed ? "RESULT: PASS" : "RESULT: FAIL (0件、JSON契約崩れ、または必須対象不足)");
    process.exit(passed ? 0 : 1);
})().catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
});
