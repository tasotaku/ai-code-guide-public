#!/usr/bin/env node
// 一括トレースの同時実行数ベンチ（VSCode不要）。
// extension.ts の traceOne 相当（generateTraceExample → runTrace、失敗時1回リトライ）をそのまま並べ、
// 同時実行数と投入方式（batch=現行のPromise.all区切り / pool=常時N本）で実時間・失敗率を比較する。
// 事前に `npm run compile` 済みであること（out/ を読む）。
// 注意: cli:* モデルはリポ外の cwd から実行する（リポ内だとフック文がJSONに混入する既知問題）。
//
// 使い方:
//   node scripts/trace_concurrency_bench.js <python_file> [model] [runs...]
//   runs は "方式:同時数" のカンマ区切り。既定 "batch:3,pool:3,pool:6,pool:10"
const Module = require("module");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const file = process.argv[2];
if (!file) {
    console.error("usage: node scripts/trace_concurrency_bench.js <python_file> [model] [runs]");
    process.exit(1);
}
const model = process.argv[3] || "codex:gpt-5.6-sol";
const runSpecs = (process.argv[4] || "batch:3,pool:3,pool:6,pool:10")
    .split(",")
    .map((s) => { const [mode, n] = s.split(":"); return { mode, n: Number(n) }; });

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

const { generateTraceExample } = require(path.join(repoRoot, "out", "api", "claudeClient.js"));
const { runTrace } = require(path.join(repoRoot, "out", "inline", "traceRunner.js"));

const absFile = path.resolve(file);
const source = fs.readFileSync(absFile, "utf8");

// AI_NOTE: 関数一覧は本番と同じ ast_parser.py の functions コマンドから取る（正規表現で拾わない）。
function listFunctions() {
    const out = spawnSync("python3", [path.join(repoRoot, "python", "ast_parser.py"), "functions"], {
        input: source, encoding: "utf8",
    });
    return JSON.parse(out.stdout).map((f) => f.name);
}

// AI_NOTE: extension.ts の traceOne と同じ手順（キャッシュだけ無し。毎回素の実時間を測るため）。
async function traceOne(funcName) {
    const t0 = Date.now();
    const paths = { file_path: absFile, workspace_root: repoRoot };
    const fail = (why) => ({ funcName, ok: false, why, sec: (Date.now() - t0) / 1000 });

    const example = await generateTraceExample(source, funcName);
    if (!example) return fail("入力例の生成に失敗");
    if (example.sideEffects) return fail(`副作用あり(${example.sideEffectReason})`);

    let result = await runTrace(repoRoot, { source, func_name: funcName, setup: example.setup, templates: example.templates, ...paths });
    let retried = false;
    if (result.error && (result.stage === "setup" || result.stage === "run")) {
        retried = true;
        const retry = await generateTraceExample(source, funcName, { setup: example.setup, error: result.error });
        if (retry && !retry.sideEffects) {
            result = await runTrace(repoRoot, { source, func_name: funcName, setup: retry.setup, templates: retry.templates, ...paths });
        }
    }
    if (result.error) return { ...fail(result.error), retried };
    return { funcName, ok: true, retried, steps: result.steps.length, sec: (Date.now() - t0) / 1000 };
}

// 現行方式: N件ずつ切り出し、その全完了を待ってから次へ。
async function runBatch(names, n) {
    const results = [];
    for (let i = 0; i < names.length; i += n) {
        results.push(...await Promise.all(names.slice(i, i + n).map(traceOne)));
    }
    return results;
}

// 比較用: 常時N本走らせ、1件終わるたびに次を投入する。
async function runPool(names, n) {
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, names.length) }, async () => {
        while (next < names.length) results.push(await traceOne(names[next++]));
    }));
    return results;
}

(async () => {
    const names = listFunctions();
    console.log(`file=${path.basename(absFile)} funcs=${names.length} model=${model}`);
    console.log(names.join(", ") + "\n");

    const summary = [];
    for (const { mode, n } of runSpecs) {
        const t0 = Date.now();
        const results = await (mode === "batch" ? runBatch(names, n) : runPool(names, n));
        const wall = (Date.now() - t0) / 1000;
        const ok = results.filter((r) => r.ok);
        const slowest = Math.max(...results.map((r) => r.sec));
        console.log(`=== ${mode}:${n} === wall=${wall.toFixed(1)}s ok=${ok.length}/${results.length} retried=${results.filter((r) => r.retried).length} slowest1件=${slowest.toFixed(1)}s`);
        for (const r of results.slice().sort((a, b) => b.sec - a.sec)) {
            console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.sec.toFixed(1).padStart(5)}s ${r.funcName}${r.ok ? ` steps=${r.steps}` : ` — ${r.why}`}`);
        }
        console.log("");
        summary.push({ mode, n, wall, ok: ok.length, total: results.length, slowest });
    }

    console.log("--- まとめ ---");
    for (const s of summary) {
        console.log(`${(s.mode + ":" + s.n).padEnd(9)} wall=${s.wall.toFixed(1).padStart(6)}s  成功=${s.ok}/${s.total}  最遅1件=${s.slowest.toFixed(1)}s`);
    }
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
