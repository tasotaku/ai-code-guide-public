const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const crypto = require("crypto");
const ts = require("typescript");
const { ProjectDiagramBridge } = require("../out/view/projectDiagramBridge");
const { GenerationGate } = require("../out/api/generationGate");

const vscode = {
    workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
    window: { activeTextEditor: undefined, visibleTextEditors: [], createTextEditorDecorationType: () => ({ dispose() {} }) },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
};
const { MainViewProvider } = require("../out/view/mainViewProvider");
Module._load = originalLoad;

function latch() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(setImmediate);
    assert(predicate(), "asynchronous boundary not reached");
}
const ready = () => ({ status: "ready", completed: 1, total: 1 });
const failed = () => ({ status: "error", completed: 0, total: 1, message: "temporary failure" });
function setup(options = {}) {
    // AI_NOTE: 本番schedulerを直接使い、外部生成境界だけをlatchで決定的に制御する。
    let source = "def main():\n    return 1\n";
    const uri = "file:///retry.py", calls = { background: 0, inline: 0 };
    const document = { uri: { toString: () => uri }, languageId: "python", getText: () => source,
        isDirty: false, isUntitled: false, isClosed: false, setSource: value => { source = value; } };
    const provider = Object.create(MainViewProvider.prototype);
    Object.assign(provider, {
        generationGate: new GenerationGate(), layerJobs: new Map(), layerStates: new Map(), layerRevision: 0,
        parseSource: async () => ({ graph: { nodes: [{ id: "main" }], ...(options.parseError ? { error: "bad syntax" } : {}) }, spans: [] }),
        publishLayerState() { this.layerRevision++; },
        backgroundService: { ensure: async () => {
            calls.background++;
            if (options.backgroundWait) await options.backgroundWait.promise;
            return { errors: calls.background === 1 && options.backgroundFails ? { main: "failed" } : {}, completed: 1, total: 1 };
        } },
        annotationProvider: { restoreCurrentDocument: async () => {}, annotateDocument: async (_, a, b, force) => {
            assert.strictEqual(force, false, "successful symbol cache must not be forced away");
            calls.inline++;
            if (options.inlineWait) await options.inlineWait.promise;
            return { status: "generated", count: 1 };
        } },
    });
    return { provider, document, uri, calls };
}

async function defaults() {
    const hold = latch();
    const s = setup({ backgroundFails: true, inlineWait: hold });
    const first = s.provider.prepareDefaultLayers(s.document, "open");
    await until(() => s.provider.layerStates.get(s.uri)?.layers.background.status === "error");
    const states = s.provider.layerStates.get(s.uri).layers;
    const retry = s.provider.prepareDefaultLayers(s.document, "explicit", true, "background");
    const duplicate = s.provider.prepareDefaultLayers(s.document, "explicit", true, "background");
    assert.strictEqual(states.background.status, "queued");
    assert.strictEqual(states.inline.status, "generating");
    hold.resolve();
    await Promise.all([first, retry, duplicate]);
    assert.deepStrictEqual(s.calls, { background: 2, inline: 1 });
    assert.strictEqual(s.provider.layerStates.get(s.uri).layers, states);
    assert.strictEqual(states.background.status, "ready");
    assert.strictEqual(states.inline.status, "ready");
    assert.strictEqual(s.provider.layerJobs.size, 0);
    await s.provider.prepareDefaultLayers(s.document, "explicit", true, "inline");
    assert.strictEqual(s.calls.inline, 1, "ready layer retry does nothing");

    const concurrent = setup();
    concurrent.provider.layerStates.set(concurrent.uri, { source: concurrent.document.getText(), layers: { background: failed(), inline: failed() } });
    await Promise.all(["background", "inline"].map(layer => concurrent.provider.prepareDefaultLayers(concurrent.document, "explicit", true, layer)));
    assert.deepStrictEqual(concurrent.calls, { background: 1, inline: 1 });
    assert.strictEqual(concurrent.provider.layerStates.get(concurrent.uri).layers.background.status, "ready");
    assert.strictEqual(concurrent.provider.layerStates.get(concurrent.uri).layers.inline.status, "ready");

    for (const reason of ["edit", "stop"]) {
        const pending = latch(), s = setup({ backgroundFails: true, inlineWait: pending });
        const first = s.provider.prepareDefaultLayers(s.document, "open");
        await until(() => s.provider.layerStates.get(s.uri)?.layers.background.status === "error");
        const retry = s.provider.prepareDefaultLayers(s.document, "explicit", true, "background");
        if (reason === "edit") { s.document.setSource("changed"); s.provider.generationGate.edit(s.uri); }
        else s.provider.stopDefaultLayers(s.document);
        pending.resolve();
        await Promise.all([first, retry]);
        assert.strictEqual(s.calls.background, 1, `${reason} invalidates queued retry`);
    }
    const broken = setup({ parseError: true });
    broken.provider.layerStates.set(broken.uri, { source: broken.document.getText(), layers: { background: failed(), inline: ready() } });
    await broken.provider.prepareDefaultLayers(broken.document, "explicit", true, "background");
    assert.strictEqual(broken.provider.layerStates.get(broken.uri).layers.inline.status, "ready", "parse error must not destroy sibling state");
    console.log("PASS defaults: in-flight sibling, duplicate/simultaneous retries, edit/stop, ready preservation, parse failure");
}

async function bridgeRetries() {
    // AI_NOTE: 実HTTP経路から失敗だけを再実行し、ブラウザ入力が保存済み実行内容を置換できないことを確認する。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acg-retry-"));
    fs.writeFileSync(path.join(root, "main.py"), "def main():\n    return 1\n");
    let hash = "a".repeat(64), states = { background: failed(), inline: ready() }, hold;
    const calls = [], counts = { diagram: 0, trace: 0 };
    const bridge = new ProjectDiagramBridge({ getWorkspaceRoot: () => root, openFile: async () => {}, token: "test",
        getManifestPath: () => path.join(root, "bridge.json"), getRegistryPath: () => path.join(root, "registry.json"),
        showView: async request => {
            calls.push(JSON.parse(JSON.stringify(request)));
            if (request.expectedSourceSha256 && request.expectedSourceSha256 !== hash) throw new Error("Source changed; request a new view");
            if (request.view === "diagram" || request.view === "trace") {
                counts[request.view]++;
                if (counts[request.view] === 1) throw new Error("temporary failure");
                if (hold) await hold.promise;
                return { ok: true, view: request.view, file: "main.py", sourceSha256: hash,
                    ...(request.view === "diagram" ? { diagram: { kind: "flow", title: "main", summary: "returns", nodes: [], edges: [] } }
                        : { trace: { funcNames: ["main"], loopCount: 0, functions: [] } }) };
            }
            if (request.retryLayer) states[request.retryLayer] = ready();
            return { ok: true, view: "standard", file: "main.py", sourceSha256: hash, layers: JSON.parse(JSON.stringify(states)), annotations: { items: [] },
                standard: { title: "main", file: "main.py", source: [{ line: 1, text: "def main():" }], items: [] } };
        },
    });
    const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
        const link = await bridge.start();
        const initial = await (await post(`${link.baseUrl}/prepare?token=test`, { file: "main.py", question: "main original", additions: ["diagram", "trace"], functions: ["main"] })).json();
        const url = initial.codexView.url;
        await until(() => bridge.preparationJobs.size === 0);
        hold = latch();
        assert.strictEqual((await post(url + "/retry", { layer: "diagram", question: "untrusted", functions: ["other"] })).status, 200);
        assert.strictEqual((await post(url + "/retry", { layer: "diagram" })).status, 409);
        hold.resolve();
        await until(() => bridge.preparationJobs.size === 0);
        const firstDiagram = calls.find(item => item.view === "diagram");
        assert.deepStrictEqual(calls.filter(item => item.view === "diagram")[1], firstDiagram);
        let result = await (await post(url + "/retry", { layer: "trace" })).json();
        await until(() => bridge.preparationJobs.size === 0);
        assert.strictEqual(result.layers.diagram.status, "ready");
        assert.deepStrictEqual(calls.filter(item => item.view === "trace")[1], calls.find(item => item.view === "trace"));
        assert.deepStrictEqual(counts, { diagram: 2, trace: 2 });
        assert.strictEqual((await post(url + "/retry", { layer: "trace" })).status, 409);
        result = await (await post(url + "/retry", { layer: "background" })).json();
        assert.strictEqual(result.layers.background.status, "ready");
        assert.strictEqual(result.layers.inline.status, "ready");
        assert.strictEqual(calls.filter(item => item.retryLayer).length, 1);
        assert.strictEqual(calls.filter(item => item.backgroundAction === "generate").length, 1);
        assert.strictEqual((await post(url + "/retry", { layer: "inline" })).status, 409);
        assert.strictEqual((await post(url + "/retry", { layer: "unknown" })).status, 400);
        assert.strictEqual((await fetch(url + "/retry")).status, 405);
        states.background = failed();
        hash = "b".repeat(64);
        assert.strictEqual((await post(url + "/retry", { layer: "background" })).status, 409);
        assert.strictEqual((await post(url + "/retry", { layer: "trace" })).status, 409);
        assert.strictEqual(calls.filter(item => item.retryLayer).length, 1);
        assert.deepStrictEqual(counts, { diagram: 2, trace: 2 });
        const before = calls.length;
        await fetch(url + "/state");
        assert(calls.slice(before).every(item => item.backgroundAction === "read" && !item.run && !item.retryLayer));
        const missing = await (await post(`${link.baseUrl}/prepare?token=test`, { file: "main.py", question: "main", additions: ["trace"] })).json();
        assert.strictEqual(missing.layers.trace.retryable, false);
        assert.strictEqual((await post(missing.codexView.url + "/retry", { layer: "trace" })).status, 409);
        console.log("PASS bridge: original requests, selective retry, duplicate/invalid/ready rejection, changed source, read-only reconnect, missing trace target");
    } finally { bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
}

async function traceSnapshot() {
    // AI_NOTE: 本番TSの関数をASTで選び、その場で変換する。bundleの整形やimport名・コメントに依存しない。
    const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
    const file = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.ES2020, true);
    let command, traceFunction;
    function visit(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === "registerCommand" && node.arguments[0]
            && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "aiCodeGuide.traceFunctions") command = node.arguments[1];
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "traceOne") traceFunction = node.initializer;
        ts.forEachChild(node, visit);
    }
    visit(file);
    assert(command && traceFunction, "production trace command and runner must exist");
    const expression = node => ts.transpileModule("(" + node.getText(file) + ")", {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    let text = "old", executions = 0;
    const document = { languageId: "python", getText: () => text, uri: { toString: () => "file:///main.py" } };
    const api = { workspace: { openTextDocument: async () => document, isTrusted: true },
        window: { visibleTextEditors: [] }, Uri: { parse: value => value } };
    const handler = vm.runInNewContext(expression(command), { vscode: api,
        createHash: crypto.createHash, traceOne: async () => { executions++; }, Error });
    await assert.rejects(handler({ uri: "file:///main.py", funcs: ["main"], background: true,
        expectedSourceSha256: crypto.createHash("sha256").update("different").digest("hex") }), /Source changed/);
    assert.strictEqual(executions, 0);
    const wait = latch();
    const traceOne = vm.runInNewContext(expression(traceFunction), {
        vscode: { workspace: { isTrusted: true, getWorkspaceFolder: () => undefined } }, traceCacheKey: () => "key", traceCache: new Map(),
        collectTraceDependencyContext: () => ({}),
        generateTraceExample: async () => { await wait.promise; return { safetyDecision: "safe", setup: "", templates: [] }; },
        classifyTraceSafety: () => "safe",
        runTrace: async () => { executions++; return {}; }, extensionPath: "test", Date, Error,
    });
    const pending = traceOne(document, "old", "main", false, undefined, () => {}, () => text === "old");
    text = "new"; wait.resolve();
    await assert.rejects(pending, /Source changed/);
    assert.strictEqual(executions, 0);
    console.log("PASS trace: changed snapshot rejected after document open and before Python dispatch");
}

(async () => { await defaults(); await bridgeRetries(); await traceSnapshot(); })().catch(error => { console.error(error); process.exitCode = 1; });
