#!/usr/bin/env node
// 実行トレースのスタンドアロンE2E検証（VSCode不要）。
// 本番の generateTraceExample() → python/trace_runner.py を「そのまま」通すので、プロンプト・契約の乖離が起きない。
// 事前に `npm run compile` 済みであること（out/ を読む）。
//
// 使い方:
//   node scripts/trace_smoke.js <python_file> <func_name> [model]
// 例:
//   node scripts/trace_smoke.js examples/single_file/algorithms.py quicksort            # 既定 codex:gpt-5.6-sol
//   node scripts/trace_smoke.js examples/single_file/algorithms.py quicksort codex:gpt-5.6-sol
//   ACG_API_KEY=sk-ant-... node scripts/trace_smoke.js ... claude-sonnet-4-6
// 注意: cli:* を使う場合はリポ外の cwd から実行する（リポ内だとフック文がJSONに混入する既知問題）。
const Module = require("module");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const file = process.argv[2];
const funcName = process.argv[3];
if (!file || !funcName) {
    console.error("usage: node scripts/trace_smoke.js <python_file> <func_name> [model]");
    process.exit(1);
}
const model = process.argv[4] || "codex:gpt-5.6-sol";

const cfg = {
    inlineAnnotationModel: model,
    useSubscription: model.startsWith("codex:") || model.startsWith("cli:"),
    subscriptionProvider: model.startsWith("cli:") ? "claude" : "codex",
    globalContext: "",
    claudeCliPath: "claude",
    codexCliPath: "codex",
    anthropicApiKey: process.env.ACG_API_KEY || "",
    openaiApiKey: process.env.ACG_API_KEY || "",
    geminiApiKey: process.env.ACG_API_KEY || "",
};
const fakeVscode = { workspace: { getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d) }) } };
const origLoad = Module._load;
Module._load = (req, parent, isMain) => (req === "vscode" ? fakeVscode : origLoad.call(Module, req, parent, isMain));

const { generateTraceExample } = require(path.join(__dirname, "..", "out", "api", "claudeClient.js"));

(async () => {
    const source = fs.readFileSync(file, "utf8");
    const t0 = Date.now();
    const example = await generateTraceExample(source, funcName);
    console.log(`--- LLM (${model}) ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
    if (!example) {
        console.log("RESULT: FAIL (LLM出力なし/JSON崩れ)");
        process.exit(1);
    }
    console.log(`side_effects: ${example.sideEffects} ${example.sideEffectReason}`);
    console.log(`templates: ${JSON.stringify(example.templates)}`);
    console.log(`setup:\n${example.setup}\n`);
    if (example.sideEffects) {
        console.log("RESULT: PASS (副作用判定で実行せず終了)");
        process.exit(0);
    }

    const payload = JSON.stringify({ source, func_name: funcName, setup: example.setup, templates: example.templates });
    const out = spawnSync("python3", [path.join(__dirname, "..", "python", "trace_runner.py")], { input: payload, encoding: "utf8" });
    const result = JSON.parse(out.stdout);
    console.log(`--- trace_runner ---`);
    if (result.error) {
        console.log(`error: ${result.error} (stage=${result.stage ?? "-"})`);
        console.log("RESULT: FAIL");
        process.exit(1);
    }
    console.log(`loops: ${JSON.stringify(result.loops)}`);
    console.log(`iter_counts: ${JSON.stringify(result.iter_counts)}`);
    console.log(`return: ${result.return_value?.short}`);
    for (const st of result.steps) {
        const ch = Object.entries(st.changed).map(([k, v]) => `${k}=${v.short}`).join(", ");
        console.log(`L${String(st.line).padStart(3)} iter=${JSON.stringify(st.iter_path)} ${ch}`);
    }
    const pass = result.steps.length > 0;
    console.log(pass ? "RESULT: PASS" : "RESULT: FAIL (ステップ0件)");
    process.exit(pass ? 0 : 1);
})().catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
});
