const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");
const { findPython } = require("./pythonCommand");
const python = findPython();
const root = path.join(__dirname, "..");
const parser = path.join(root, "python", "ast_parser.py");
function parse(command, code) {
    const result = spawnSync(python.command, [...python.args, parser, command], { input: code, encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}
const symbols = code => parse("symbols", code);
let calls = [];
let handler;
let available = true;
const fakeVscode = {
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    Uri: { parse: value => ({ toString: () => value }) },
    OverviewRulerLane: { Full: 7 },
    ProgressLocation: { Notification: 1 },
    EventEmitter: class { event() {} fire() {} dispose() {} },
    window: {
        createTextEditorDecorationType: () => ({ dispose() {} }),
        visibleTextEditors: [],
        withProgress: (_options, callback) => callback(),
        showErrorMessage: () => {}, showWarningMessage: () => {},
    },
};
const provider = {
    effectiveModel: model => model,
    hasKeyForModel: () => available,
    createMessage: async request => {
        calls.push(request);
        return handler ? handler(request) : reply(request);
    },
};
function reply(request) {
    const input = JSON.parse(request.messages[0].content);
    return { model: "test", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify({
        items: input.targets.map(target => ({ key: target.key, explanation: `${target.name}の説明です。` })),
    }) }] };
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === "vscode") return fakeVscode;
    if (request.endsWith("/llmProvider") || request === "./llmProvider") return provider;
    if (request.endsWith("/flowchart/astParser")) return {
        extractSymbols: async (_path, code) => symbols(code),
        extractGraph: async (_path, code) => parse("graph", code),
    };
    return originalLoad.call(this, request, parent, isMain);
};
const { generateSymbolDictionaryAnnotations } = require("../out/api/claudeClient.js");
const { buildSymbolFingerprints } = require("../out/api/symbolDictionaryCache.js");
const { SemanticAnnotationProvider } = require("../out/inline/blockExplanationProvider.js");
const fixture = "def calculate_total(price):\n    total = price * 2\n    return total\n\ndef independent(name):\n    return name";
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "acg-symbol-cache-test-"));
function document(code, name = "test.py") {
    return { code, uri: { toString: () => `file:///${name}` }, getText() { return this.code; },
        get lineCount() { return this.code.split("\n").length; } };
}
function newProvider(suffix) {
    const instance = new SemanticAnnotationProvider({ fsPath: path.join(storage, suffix) }, { getForUri: () => [] }, root);
    instance.applied = [];
    instance.applyGenerated = (_editor, annotations) => { instance.applied = annotations; };
    instance.applyWithStatus = (_editor, annotations) => { instance.applied = annotations; };
    return instance;
}
(async () => {
    const occurrences = symbols(fixture);
    const initial = await generateSymbolDictionaryAnnotations(fixture, occurrences);
    assert.strictEqual(calls.length, 2, "two independent scopes are two calls, not one per name");
    const fingerprints = buildSymbolFingerprints(fixture, occurrences);
    for (const call of calls) {
        const input = call.messages[0].content;
        const hash = require("crypto").createHash("sha256").update(input).digest("hex");
        for (const target of JSON.parse(input).targets) assert.strictEqual(fingerprints.get(target.key), hash);
    }
    calls = [];
    await generateSymbolDictionaryAnnotations(fixture, occurrences, initial);
    assert.strictEqual(calls.length, 0);
    const edited = fixture.replace("price * 2", "price * 3");
    await generateSymbolDictionaryAnnotations(edited, symbols(edited), initial);
    assert.strictEqual(calls.length, 1);
    assert(!calls[0].messages[0].content.includes("def independent"));
    handler = request => ({ ...reply(request), content: [{ type: "text", text: '{"items":[]}' }] });
    await assert.rejects(generateSymbolDictionaryAnnotations(fixture, occurrences), /出力が不正/);
    handler = () => { throw new Error("provider failed"); };
    await assert.rejects(generateSymbolDictionaryAnnotations(fixture, occurrences), /provider failed/);
    handler = undefined;
    available = false;
    await assert.rejects(generateSymbolDictionaryAnnotations(fixture, occurrences), /モデル接続/);
    available = true;

    const pipeline = "def normalize(values):\n    cleaned = [value.strip().lower() for value in values]\n    nonempty = [value for value in cleaned if value]\n    unique = list(dict.fromkeys(nonempty))\n    return sorted(unique)";
    calls = [];
    const pipelineAnnotations = await generateSymbolDictionaryAnnotations(pipeline, symbols(pipeline));
    assert.strictEqual(calls.length, 1, "builtin pipeline generates in one scope request");
    assert(pipelineAnnotations.every(item => !item.explanation.startsWith("文脈の再確認が必要:")));
    assert(calls[0].system.includes("文字列の場合は"), "production prompt permits conditional standard method meaning");
    assert(calls[0].system.includes("ユーザー定義がないだけで処理・戻り値不明としない"));

    const dynamic = "def dispatch(handlers, name):\n    result = handlers[name]()\n    return result\n\ndef invoke(callback):\n    result = callback()\n    return result";
    const dynamicAnnotations = await generateSymbolDictionaryAnnotations(dynamic, symbols(dynamic));
    for (const key of ["dispatch|variable|result", "invoke|variable|result", "invoke|function|callback"]) {
        assert(dynamicAnnotations.some(item => item.symbolKey === key && item.explanation.startsWith("文脈の再確認が必要:")),
            `${key}: dynamic call cannot silently claim a known result`);
    }

    const concurrent = newProvider("concurrent");
    const doc = document(fixture);
    calls = [];
    await Promise.all([concurrent.annotateFile({ document: doc }), concurrent.annotateDocument(doc)]);
    assert.strictEqual(calls.length, 2, "editor and background request share scope generation");
    calls = [];
    const restarted = newProvider("concurrent");
    await restarted.annotateDocument(doc);
    assert.strictEqual(calls.length, 0, "successful exact cache survives restart");

    const progressive = newProvider("progressive");
    const progressiveDoc = document(fixture, "progressive.py");
    fakeVscode.window.visibleTextEditors = [{ document: progressiveDoc }];
    let releaseRemaining;
    let markRemaining;
    const remainingStarted = new Promise(resolve => { markRemaining = resolve; });
    calls = [];
    handler = request => {
        if (calls.length === 1) return reply(request);
        return new Promise(resolve => { releaseRemaining = () => resolve(reply(request)); markRemaining(); });
    };
    const progressiveRequest = progressive.annotateDocument(progressiveDoc);
    await remainingStarted;
    assert(progressive.applied.length > 0, "first batch is visible while next scope is still pending");
    assert(progressive.applied.every(item => !item.symbolKey.includes("independent")));
    assert(progressive.getSavedAnnotationsForDocument(progressiveDoc).items.every(item => item.scope !== "full"));
    handler = undefined;
    releaseRemaining();
    await progressiveRequest;
    fakeVscode.window.visibleTextEditors = [];

    const mixedCode = "RATE = 2\ndef calculate(price):\n    subtotal = price * RATE\n    unrelated = 3\n    return subtotal + unrelated";
    const mixed = newProvider("same-scope-multiple-batches");
    const mixedDoc = document(mixedCode, "mixed.py");
    calls = [];
    handler = request => {
        if (calls.length === 3) throw new Error("remaining scope batch unavailable");
        return reply(request);
    };
    await assert.rejects(mixed.annotateDocument(mixedDoc), /remaining scope batch/);
    assert(mixed.getSavedAnnotationsForDocument(mixedDoc).items.length > 0);
    assert(mixed.getSavedAnnotationsForDocument(mixedDoc).items.every(item => item.scope !== "full"), "same-scope batch success never claims file completion");
    calls = [];
    handler = undefined;
    await mixed.annotateDocument(mixedDoc);
    assert(calls.length > 0, "remaining batch in same scope is generated on retry");

    const recovering = newProvider("partial-failure");
    const recoverDoc = document(fixture, "recover.py");
    calls = [];
    handler = request => {
        if (calls.length === 2) throw new Error("second scope unavailable");
        return reply(request);
    };
    await assert.rejects(recovering.annotateDocument(recoverDoc), /second scope/);
    assert(recovering.getSavedAnnotationsForDocument(recoverDoc).items.length > 0);
    assert(recovering.getSavedAnnotationsForDocument(recoverDoc).items.every(item => item.scope !== "full"), "partial progress never claims complete");
    handler = undefined;
    calls = [];
    await recovering.annotateDocument(recoverDoc);
    assert.strictEqual(calls.length, 1, "completed scope survives later provider failure");

    const shared = newProvider("shared-stop");
    const sharedDoc = document(fixture, "shared.py");
    let continueAutomatic = true;
    let unblockShared;
    let markSharedStarted;
    const sharedStarted = new Promise(resolve => { markSharedStarted = resolve; });
    handler = request => new Promise(resolve => { unblockShared = () => resolve(reply(request)); markSharedStarted(); });
    calls = [];
    const automatic = shared.annotateDocument(sharedDoc, undefined, undefined, false, { isCurrent: () => continueAutomatic });
    await sharedStarted;
    const explicit = shared.annotateDocument(sharedDoc);
    continueAutomatic = false;
    handler = undefined;
    unblockShared();
    await Promise.all([automatic, explicit]);
    assert.strictEqual(calls.length, 2, "stopping automatic consumer does not cancel explicit consumer's shared job");

    // A delayed old result can be persisted for its own snapshot, never applied to the edited document.
    const stale = newProvider("stale");
    const changing = document(fixture, "changing.py");
    let release;
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    handler = request => new Promise(resolve => { release = () => resolve(reply(request)); started(); });
    const pending = stale.annotateFile({ document: changing });
    await begun;
    changing.code = edited;
    handler = undefined;
    release();
    await pending;
    assert.strictEqual(stale.applied.length, 0, "old generation never decorates new text");
    assert.strictEqual(stale.getSavedAnnotationsForDocument(changing).items.length, 0);
    calls = [];
    await stale.annotateDocument(changing);
    assert.strictEqual(calls.length, 2, "different source is not satisfied by stale in-flight/partial cache");

    const restored = newProvider("concurrent");
    doc.code = `\n${edited}`;
    const editor = { document: doc };
    fakeVscode.window.visibleTextEditors = [editor];
    calls = [];
    await restored.restoreCurrentDocument(doc);
    assert.strictEqual(calls.length, 0, "editing restore is local only");
    assert(restored.applied.length > 0);
    assert(restored.applied.every(annotation => !annotation.symbolKey.includes("calculate_total")));
    assert(restored.applied.some(annotation => annotation.startLine === 5), "unchanged scope moves to its current line");
    assert.strictEqual(restored.getSavedAnnotationsForDocument(doc).items.length, 0, "partial restore is not a complete cache snapshot");

    const invalid = document("def broken(:\n    value = 1", "invalid.py");
    calls = [];
    await assert.rejects(restored.annotateDocument(invalid), /構文/);
    assert.strictEqual(calls.length, 0, "syntax error sends no LLM requests");
    console.log("symbol dictionary generation: batching, exact inputs, failures, concurrency, restart, stale edits, relocation, syntax PASS");
})().catch(error => { console.error(error); process.exitCode = 1; });
