const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");
const { findPython } = require("./pythonCommand");
const { SemanticBackgroundService } = require("../out/api/semanticBackground");
const { GenerationGate } = require("../out/api/generationGate");

const root = path.resolve(__dirname, "..");
const python = findPython();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "acg-default-lifecycle-"));
const settings = {};
const parserCalls = [];
const parsedSources = new Map();
const vscode = {
    workspace: { getConfiguration: () => ({ get: (name, fallback) => settings[name] ?? fallback }) },
    window: { activeTextEditor: undefined, visibleTextEditors: [], createTextEditorDecorationType: options => ({ options, dispose() {} }) },
    Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { this.start = { line: startLine, character: startCharacter }; this.end = { line: endLine, character: endCharacter }; } },
};

function parse(source, command) {
    // AI_NOTE: 外部プロセス境界だけ同期化し、所有ノードと文範囲は本番Pythonパーサーの出力を使う。
    parserCalls.push(command);
    const key = `${command}\0${source}`;
    if (parsedSources.has(key)) return parsedSources.get(key);
    const result = spawnSync(python.command, [...python.args, path.join(root, "python/ast_parser.py"), command], { input: source, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    parsedSources.set(key, value);
    return value;
}

// AI_NOTE: MainViewProvider本体のprepare/refresh/publish/stopを直接呼ぶ。constructorの配布・UI登録だけは実行しない。
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === "vscode") return vscode;
    if (request === "../flowchart/astParser" && parent.filename.endsWith("mainViewProvider.js")) return {
        extractGraph: async (_, source) => parse(source, "graph"),
        listFunctions: async () => { parserCalls.push("functions"); return []; },
        getStmtSpans: async (_, source) => parse(source, "stmt_spans"),
    };
    return originalLoad.call(this, request, parent, isMain);
};
const { MainViewProvider } = require("../out/view/mainViewProvider");
Module._load = originalLoad;

function latch() {
    // AI_NOTE: 実時間sleepではなく開始/完了を明示的に制御して競合順を固定する。
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function waitUntil(predicate) {
    // AI_NOTE: 準備処理のmicrotaskを最大100回進めるだけで、時間依存の成功判定を避ける。
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(setImmediate);
    assert(predicate(), "expected asynchronous boundary was not reached");
}

function setup(name, source, options = {}) {
    // AI_NOTE: backgroundは本番キャッシュへmock生成器を注入。名称は呼出し契約だけを測り、生成品質をここで模擬しない。
    for (const key of Object.keys(settings)) delete settings[key];
    Object.assign(settings, options.settings);
    const uri = `file:///lifecycle-${name}.py`;
    const document = {
        uri: { toString: () => uri, fsPath: `/lifecycle-${name}.py`, path: `/lifecycle-${name}.py` },
        languageId: "python", isDirty: false, isUntitled: false, isClosed: false,
        getText: () => source,
        setSource: value => { source = value; },
    };
    const backgroundCalls = [];
    const nameCalls = [];
    const restoreCalls = [];
    const decorations = [];
    const editor = { document, setDecorations: (type, ranges) => decorations.push({ source, ranges }) };
    vscode.window.activeTextEditor = editor;
    vscode.window.visibleTextEditors = [editor];
    const background = new SemanticBackgroundService(path.join(temporary, name), {
        identity: () => ({ model: "mock", provider: "mock", globalContext: "", schema: "meaning-background/1" }),
        generate: async (label, lines) => {
            backgroundCalls.push({ label, lines });
            if (options.backgroundWait) await options.backgroundWait.promise;
            return [{ lineStart: 0, lineEnd: lines.length - 1, label: "意味" }];
        },
        details: async () => { throw new Error("default layers must not generate details"); },
    });
    const provider = Object.create(MainViewProvider.prototype);
    Object.assign(provider, {
        extensionPath: root, generationGate: new GenerationGate(), backgroundService: background,
        sourceParses: new Map(), layerStates: new Map(), layerJobs: new Map(), saveReasons: new Map(),
        expandedSources: new Map(), staleExpansions: new Set(), expansionTickets: new Map(),
        layerStatus: { text: "", show() {} }, layerRevision: 0, refreshedSource: "",
        graphNodes: [], graphEdges: [], backgroundNodes: [], meaningRanges: {}, expandedData: {},
        decorationTypes: [], decorationIndexKey: "", decorationIndex: new Map(), coloringEnabled: true,
        llmCache: { get: () => undefined },
        annotationProvider: {
            restoreCurrentDocument: async doc => { restoreCalls.push(doc.getText()); },
            annotateDocument: async (doc, selection, progress, force, control) => {
                nameCalls.push({ source: doc.getText(), force, control });
                if (options.nameWait) await options.nameWait.promise;
                return { status: "generated", count: 1 };
            },
        },
    });
    return { provider, document, uri, backgroundCalls, nameCalls, restoreCalls, decorations };
}

let passed = 0;
async function test(name, action) {
    // AI_NOTE: 各ケースで新しい生成状態を使い、他ケースのcache hitを成功根拠に混ぜない。
    await action();
    console.log(`PASS ${name}`);
    passed++;
}

const one = "def a(value):\n    return value + 1\n";
const two = one + "\ndef b(value):\n    return value * 2\n";

(async () => {
    await test("first open starts both layers once while sidebar is closed", async () => {
        const s = setup("first", one);
        assert.equal(s.provider.view, undefined);
        await s.provider.prepareDefaultLayers(s.document, "open");
        assert.equal(s.backgroundCalls.length, 1);
        assert.equal(s.nameCalls.length, 1);
        assert.equal(s.provider.layerStates.get(s.uri).layers.background.status, "ready");
        assert.equal(s.provider.layerStates.get(s.uri).layers.inline.status, "ready");
        assert(s.provider.graphNodes.length > 0, "refresh must run without a sidebar");
        assert(Object.values(s.provider.meaningRanges).flat().length > 0);
        assert(s.decorations.some(call => call.ranges.length), "real applyDecorations receives generated rows");
    });
    await test("same-source concurrent opens share the whole pending layer job", async () => {
        const wait = latch();
        const s = setup("shared", one, { backgroundWait: wait, nameWait: wait });
        const first = s.provider.prepareDefaultLayers(s.document, "open");
        const second = s.provider.prepareDefaultLayers(s.document, "open");
        await waitUntil(() => s.backgroundCalls.length === 1 && s.nameCalls.length === 1);
        wait.resolve();
        await Promise.all([first, second]);
        assert.equal(s.backgroundCalls.length, 1);
        assert.equal(s.nameCalls.length, 1);
        assert.equal(s.provider.layerJobs.size, 0);
    });
    await test("dirty edits, tab reopening and local refresh do not generate", async () => {
        const s = setup("dirty", two);
        await s.provider.prepareDefaultLayers(s.document, "open");
        s.document.setSource(two.replace("+ 1", "+ 3"));
        s.document.isDirty = true;
        s.provider.generationGate.edit(s.uri);
        await s.provider.prepareDefaultLayers(s.document, "open");
        await s.provider.refresh(s.document);
        assert.equal(s.backgroundCalls.length, 2);
        assert.equal(s.nameCalls.length, 1);
        assert.equal(Object.keys(s.provider.meaningRanges).length, 1, "unchanged B stays available, changed A is removed");
        s.document.isDirty = false; // Automatic save does not issue the manual-save trigger.
        await s.provider.prepareDefaultLayers(s.document, "open");
        assert.equal(s.backgroundCalls.length, 2);
        assert.equal(s.nameCalls.length, 1);
    });
    await test("manual save generates only the changed background owner and permits inline reuse", async () => {
        const s = setup("save", two);
        await s.provider.prepareDefaultLayers(s.document, "open");
        s.document.setSource(two.replace("+ 1", "+ 4"));
        s.provider.generationGate.edit(s.uri);
        s.document.isDirty = false;
        await s.provider.prepareDefaultLayers(s.document, "save");
        assert.equal(s.backgroundCalls.length, 3);
        assert(s.backgroundCalls[2].label.startsWith("a("));
        assert.equal(s.nameCalls.length, 2);
        assert.equal(s.nameCalls[1].force, false, "manual save must not force a whole-name regeneration");
        assert.equal(Object.keys(s.provider.meaningRanges).length, 2);
    });
    await test("stop prevents late results becoming ready or repainted", async () => {
        const wait = latch();
        const s = setup("stop", one, { backgroundWait: wait, nameWait: wait });
        const task = s.provider.prepareDefaultLayers(s.document, "open");
        await waitUntil(() => s.backgroundCalls.length === 1 && s.nameCalls.length === 1);
        s.provider.stopDefaultLayers(s.document);
        const publishedRevision = s.provider.layerRevision;
        const restored = s.restoreCalls.length;
        wait.resolve();
        await task;
        assert.equal(s.provider.layerStates.get(s.uri).layers.background.status, "stopped");
        assert.equal(s.provider.layerStates.get(s.uri).layers.inline.status, "stopped");
        assert.equal(s.provider.layerRevision, publishedRevision);
        assert.equal(s.restoreCalls.length, restored);
        assert.equal(Object.keys(s.provider.meaningRanges).length, 0);
        assert.equal(s.nameCalls[0].control.isCurrent(), false);
        await s.provider.refresh(s.document);
        assert.equal(Object.keys(s.provider.meaningRanges).length, 0, "cache-only refresh must not resurrect the stopped response");
    });
    await test("same source with a changed revision resumes rather than sharing an obsolete job", async () => {
        const wait = latch();
        const s = setup("revision", one, { backgroundWait: wait, nameWait: wait });
        const old = s.provider.prepareDefaultLayers(s.document, "open");
        await waitUntil(() => s.backgroundCalls.length === 1 && s.nameCalls.length === 1);
        s.provider.generationGate.pause(s.uri);
        const restarted = s.provider.prepareDefaultLayers(s.document, "open");
        wait.resolve();
        await Promise.all([old, restarted]);
        assert.equal(s.provider.layerStates.get(s.uri).layers.background.status, "ready");
        assert.equal(s.provider.layerStates.get(s.uri).layers.inline.status, "ready");
        assert.equal(s.nameCalls.length, 2, "new revision must execute a fresh coordinator job");
        assert.equal(s.backgroundCalls.length, 2, "a response with no live reader is not stored after cancellation");
        assert.equal(s.nameCalls[0].control.isCurrent(), false);
        assert.equal(s.nameCalls[1].control.isCurrent(), true);
    });
    await test("explicit OFF is respected by automatic and settings-respecting explicit entries", async () => {
        const s = setup("off", one, { settings: { autoSemanticBackgrounds: false, autoInlineAnnotations: false } });
        await s.provider.prepareDefaultLayers(s.document, "open");
        await s.provider.prepareDefaultLayers(s.document, "explicit", true);
        assert.equal(s.backgroundCalls.length, 0);
        assert.equal(s.nameCalls.length, 0);
        assert.equal(s.provider.layerStates.get(s.uri).layers.background.status, "idle");
        assert.equal(s.provider.layerStates.get(s.uri).layers.inline.status, "idle");
    });
    await test("untitled and dirty initial documents wait until explicitly requested", async () => {
        const s = setup("untitled", one);
        s.document.isUntitled = true;
        s.document.isDirty = true;
        await s.provider.prepareDefaultLayers(s.document, "open");
        assert.equal(s.backgroundCalls.length, 0);
        assert.equal(s.nameCalls.length, 0);
        await s.provider.prepareDefaultLayers(s.document, "explicit");
        assert.equal(s.backgroundCalls.length, 1);
        assert.equal(s.nameCalls.length, 1);
    });
    console.log(`defaultLayerLifecycle: ${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
