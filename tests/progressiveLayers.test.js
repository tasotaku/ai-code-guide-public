const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { ProjectDiagramBridge } = require("../out/view/projectDiagramBridge");
const { buildSemanticLineIndex, semanticBackgroundRuntime, SEMANTIC_BACKGROUND_PALETTE } = require("../out/view/semanticBackground");
const { buildStandardWebView } = require("../out/view/standardWebView");
const { buildCombinedWebView } = require("../out/view/combinedWebView");

// AI_NOTE: cacheなし・後着・旧snapshot拒否を公開HTTP境界で確認し、LLMは制御可能な待機で置き換える。
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acg-progressive-"));
    fs.writeFileSync(path.join(root, "main.py"), "def main():\n    return 1\n");
    let currentHash = "a".repeat(64), ready = false, finishDiagram;
    const requests = [];
    const ranges = [{ lineStart: 1, lineEnd: 3 }, { lineStart: 2, lineEnd: 2 }];
    const index = buildSemanticLineIndex(ranges);
    assert.strictEqual(index.get(1).color, SEMANTIC_BACKGROUND_PALETTE[0]);
    assert.strictEqual(index.get(2).color, SEMANTIC_BACKGROUND_PALETTE[1]);
    assert.strictEqual(buildSemanticLineIndex([]).size, 0);
    const existing = { lineStart: 5, lineEnd: 8, colorIndex: 4 };
    assert.strictEqual(buildSemanticLineIndex([existing]).get(5).color, buildSemanticLineIndex([{ lineStart: 1, lineEnd: 3, colorIndex: 0 }, existing]).get(5).color, "arrival order does not change assigned colors");
    const runtimeIndex = vm.runInNewContext(semanticBackgroundRuntime + ";buildSemanticLineIndex([{lineStart:1,lineEnd:3},{lineStart:2,lineEnd:2}]).get(2).color");
    assert.strictEqual(runtimeIndex, index.get(2).color);
    const snapshot = () => ({
        ok: true, view: "standard", file: "main.py", sourceSha256: currentHash, revision: ready ? 2 : 1,
        layers: { background: { status: ready ? "ready" : "generating", completed: ready ? 1 : 0, total: 1 }, inline: { status: "ready", completed: 0, total: 0 } },
        annotations: { items: [] },
        standard: { title: "main.py", file: "main.py", source: [{ line: 1, text: "def main():" }, { line: 2, text: "    return 1" }],
            backgroundRanges: ready ? [{ lineStart: 1, lineEnd: 2, label: "固定値を返す" }] : [],
            items: [{ id: "main", kind: "function", label: "main", line: 1, lineEnd: 2 }] },
    });
    for (const html of [buildStandardWebView(snapshot(), "1".repeat(48)), buildCombinedWebView(snapshot(), "1".repeat(48))]) {
        for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script);
        assert.ok(html.includes('semanticIndex.get(line)'), "rendering uses a per-snapshot index");
        assert.ok(html.includes('document.hidden'), "hidden views pause polling");
        assert.ok(html.includes('decorateInlineNames'), "names attach without replacing source DOM");
        assert.ok(!/\.source-row\.selected\{[^}]*background/.test(html), "selection must preserve semantic background colors");
        assert.ok(!html.includes('unit?.color||itemColor(definition)'), "no definition-color fallback");
    }
    // AI_NOTE: 統合画面は一時通知、単独標準画面は既存操作を維持する。
    const combinedHtml = buildCombinedWebView(snapshot(), "1".repeat(48));
    assert.ok(combinedHtml.includes('installGenerationNotice({initial:data,'));
    assert.ok(combinedHtml.includes('.generation-notice{position:fixed;'));
    assert.ok(!combinedHtml.includes('class="source-head"'));
    assert.ok(!combinedHtml.includes('class="legend"'));
    assert.ok(!combinedHtml.includes('解説を更新'));
    assert.ok(!buildStandardWebView(snapshot(), "1".repeat(48)).includes('progressBar:true'));
    const bridge = new ProjectDiagramBridge({
        getWorkspaceRoot: () => root, openFile: async () => {}, token: "test",
        getManifestPath: () => path.join(root, "bridge.json"), getRegistryPath: () => path.join(root, "registry.json"),
        showView: async request => {
            requests.push(request);
            if (request.expectedSourceSha256 && request.expectedSourceSha256 !== currentHash) throw new Error("Source changed; request a new view");
            if (request.view === "diagram") return new Promise(resolve => { finishDiagram = () => resolve({ ok: true, view: "diagram", file: "main.py", sourceSha256: request.expectedSourceSha256, diagram: { kind: "flow", title: "main", summary: "returns", nodes: [], edges: [] } }); });
            const result = snapshot();
            if (request.backgroundAction === "stop") result.layers.background.status = "stopped";
            if (request.expandLines) result.standard.items[0].expansion = { overview: null, blocks: [{ label: "固定値を返す", lineStart: 1, lineEnd: 2, description: "1を返す" }] };
            return result;
        },
    });
    try {
        const link = await bridge.start();
        const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const prepared = await post(`${link.baseUrl}/prepare?token=test`, { file: "main.py", question: "mainの処理", additions: ["diagram"] });
        assert.strictEqual(prepared.status, 200);
        const initial = await prepared.json();
        assert.strictEqual(initial.standard.source.length, 2);
        assert.strictEqual(initial.standard.backgroundRanges.length, 0);
        assert.strictEqual(initial.layers.diagram.status, "generating");
        assert.ok(finishDiagram, "diagram started but response did not wait for it");
        assert.strictEqual(requests.filter(item => item.backgroundAction === "generate").length, 1);
        ready = true;
        let state = await (await fetch(initial.codexView.url + "/state")).json();
        assert.strictEqual(requests.at(-1).backgroundAction, "read");
        assert.strictEqual(state.standard.backgroundRanges.length, 1);
        finishDiagram();
        await new Promise(resolve => setImmediate(resolve));
        state = await (await fetch(initial.codexView.url + "/state")).json();
        assert.strictEqual(state.layers.diagram.status, "ready");
        assert.ok(state.diagramHtml, "completed diagram is rendered by the shared server renderer");
        const stop = await (await post(initial.codexView.url + "/layers", { action: "stop" })).json();
        assert.strictEqual(stop.layers.background.status, "stopped");
        assert.strictEqual(requests.at(-1).backgroundAction, "stop");
        assert.strictEqual((await post(initial.codexView.url + "/layers", { action: "unknown" })).status, 400);
        currentHash = "b".repeat(64);
        state = await (await fetch(initial.codexView.url + "/state")).json();
        assert.strictEqual(state.sourceChanged, true);
        assert.strictEqual(state.sourceSha256, "a".repeat(64));
        const expanded = await post(initial.codexView.url + "/expand", { line: 1 });
        assert.notStrictEqual(expanded.status, 200, "old snapshot cannot expand current code");
        assert.strictEqual(requests.at(-1).expectedSourceSha256, "a".repeat(64));
        const refreshed = await (await post(initial.codexView.url + "/layers", { action: "generate" })).json();
        assert.notStrictEqual(refreshed.codexView.url, initial.codexView.url);
        assert.strictEqual(refreshed.sourceSha256, currentHash);
        state = await (await fetch(initial.codexView.url + "/state")).json();
        assert.strictEqual(state.sourceSha256, "a".repeat(64), "old URL is immutable even after explicit refresh");
        assert.strictEqual((await post(`${link.baseUrl}/prepare?token=test`, { file: "../escape.py", question: "x", additions: [] })).status, 403);
        assert.strictEqual((await post(`${link.baseUrl}/show?token=test`, { view: "standard", file: "main.py", backgroundAction: "unknown" })).status, 400);
        console.log("PASS - shared palette, script syntax, progressive preparation, read-only polling, stop, stale rejection, fresh URL, boundary validation");
    } finally {
        bridge.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
