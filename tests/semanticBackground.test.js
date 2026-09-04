const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { findPython } = require("./pythonCommand");
const { SemanticBackgroundService, validateMeaningBlocks } = require("../out/api/semanticBackground");

const root = path.resolve(__dirname, "..");
const python = findPython();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "acg-meaning-test-"));
let passed = 0;

function parse(code) {
    // AI_NOTE: 対象の所有関係は本番Pythonパーサーから取り、テスト用に再実装しない。
    const run = (command) => {
        const process = spawnSync(python.command, [...python.args, path.join(root, "python/ast_parser.py"), command], { input: code, encoding: "utf8" });
        assert.equal(process.status, 0, process.stderr);
        return JSON.parse(process.stdout);
    };
    const graph = run("graph");
    assert(!graph.error, graph.error);
    return { nodes: graph.backgroundNodes, stmts: run("stmt_spans") };
}

function setup(name, extra = {}) {
    // AI_NOTE: 生成だけを注入し、キャッシュと検証は本番クラスをそのまま通す。実際のLLM課金は行わない。
    const calls = [];
    const detailCalls = [];
    const identity = { model: "test-model", provider: "mock", globalContext: "reader", schema: "meaning-background/1" };
    const deps = {
        identity: () => ({ ...identity }),
        generate: async (label, lines) => { calls.push({ label, lines }); return [{ lineStart: 0, lineEnd: lines.length - 1, label: "意味のまとまり" }]; },
        details: async (label, lines, kind, blocks) => {
            detailCalls.push({ label, lines, blocks });
            return { overview: { purpose: "目的", input: "入力", output: "出力" }, blocks: blocks.map(b => ({ ...b, description: "同じ意味区分の詳細" })) };
        },
        ...extra,
    };
    const directory = path.join(temporary, name);
    return { service: new SemanticBackgroundService(directory, deps), calls, detailCalls, identity, deps, directory };
}

async function test(name, run) {
    // AI_NOTE: 非同期ケースを直列に実行し、失敗箇所をケース名で特定できるようにする。
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

const code = "def a(value):\n    result = value + 1\n    return result\n\ndef b(value):\n    return value * 2\n";
const parsed = parse(code);
const uri = "file:///semantic-test.py";

(async () => {
    await test("single LLM block is preserved without AST subdivision", () => {
        const lines = code.split("\n");
        assert.equal(validateMeaningBlocks([{ lineStart: 0, lineEnd: lines.length - 1, label: "一つ" }], lines, parsed.stmts).length, 1);
    });
    await test("invalid coordinates and uncovered gaps fail closed", () => {
        for (const raw of [[], [{ lineStart: 0, lineEnd: 99, label: "x" }], [{ lineStart: 1, lineEnd: 1, label: "x" }], [{ lineStart: 0, lineEnd: 0.5, label: "x" }]]) {
            assert.throws(() => validateMeaningBlocks(raw, ["a", "b"]));
        }
    });
    await test("multiline statement correction keeps LLM partition count", () => {
        const blocks = validateMeaningBlocks([{ lineStart: 0, lineEnd: 1, label: "準備" }, { lineStart: 2, lineEnd: 4, label: "利用" }], ["x = (", "  1 +", "  2)", "print(x)", "print('done')"], [{ start: 0, end: 2 }, { start: 3, end: 3 }, { start: 4, end: 4 }]);
        assert.deepEqual(blocks.map(b => [b.lineStart, b.lineEnd]), [[0, 2], [3, 4]]);
    });
    await test("a blank after a complete statement is a valid meaning boundary", () => {
        const lines = ["def f():", "    x = 1", "", "    return x"];
        const result = validateMeaningBlocks([{ lineStart: 0, lineEnd: 2, label: "準備" }, { lineStart: 3, lineEnd: 3, label: "結果" }], lines, [{ start: 0, end: 3 }, { start: 1, end: 1 }, { start: 3, end: 3 }]);
        assert.deepEqual(result.map(b => b.lineEnd), [2, 3]);
    });
    await test("first generation, unchanged reuse, one-function edit, outer line shift", async () => {
        const s = setup("selective");
        const initial = await s.service.ensure(uri, code, parsed.nodes, parsed.stmts);
        assert.equal(initial.total, 2);
        assert.equal(initial.completed, 2);
        assert.equal(s.calls.length, 2);
        await s.service.ensure(uri, code, parsed.nodes, parsed.stmts);
        assert.equal(s.calls.length, 2);
        const changed = code.replace("value + 1", "value + 2");
        const cp = parse(changed);
        assert.equal(s.service.getSnapshot(uri, changed, cp.nodes).completed, 1);
        await s.service.ensure(uri, changed, cp.nodes, cp.stmts);
        assert.equal(s.calls.length, 3);
        assert(s.calls[2].label.startsWith("a("));
        const shifted = "\n\n" + changed;
        const sp = parse(shifted);
        const before = s.service.peek(uri, changed, cp.nodes);
        const after = await s.service.ensure(uri, shifted, sp.nodes, sp.stmts);
        assert.equal(s.calls.length, 3);
        for (const id of Object.keys(before)) assert.equal(after.ranges[id][0].lineStart, before[id][0].lineStart + 2);
        await s.service.flush();
        const restart = new SemanticBackgroundService(s.directory, s.deps);
        await restart.ensure(uri, shifted, sp.nodes, sp.stmts);
        assert.equal(s.calls.length, 3, "restart must not regenerate");
    });
    await test("comments inside owner invalidate only that owner", async () => {
        const s = setup("comments");
        await s.service.ensure(uri, code, parsed.nodes, parsed.stmts);
        const changed = code.replace("    result", "    # calculation\n    result");
        const cp = parse(changed);
        await s.service.ensure(uri, changed, cp.nodes, cp.stmts);
        assert.equal(s.calls.length, 3);
    });
    await test("three blank lines before a function do not regenerate module or function details", async () => {
        const s = setup("module-gap");
        const initial = '\"\"\"Module purpose\"\"\"\n\ndef a(value):\n    return value + 1\n';
        const p = parse(initial);
        const first = await s.service.ensure(uri, initial, p.nodes, p.stmts);
        assert.equal(first.total, 2, "fixture must include a generated synthetic module");
        for (const id of Object.keys(first.ranges)) await s.service.details(uri, initial, p.nodes, p.stmts, id);
        const changed = initial.replace("def a", "\n\n\ndef a");
        const cp = parse(changed);
        const next = await s.service.ensure(uri, changed, cp.nodes, cp.stmts);
        for (const id of Object.keys(next.ranges)) {
            assert(s.service.peekDetails(uri, changed, cp.nodes, id));
            await s.service.details(uri, changed, cp.nodes, cp.stmts, id);
        }
        assert.equal(s.calls.length, 2, "outside blank lines must not regenerate any background");
        assert.equal(s.detailCalls.length, 2, "outside blank lines must not regenerate any detail");
        const functionId = p.nodes.find(n => n.kind === "function").id;
        assert.equal(next.ranges[functionId][0].lineStart, first.ranges[functionId][0].lineStart + 3);
    });
    await test("generation identity and URI are part of cache identity", async () => {
        const s = setup("identity");
        await s.service.ensure(uri, code, parsed.nodes, parsed.stmts);
        for (const field of ["model", "provider", "globalContext", "schema"]) {
            s.identity[field] += "-changed";
            assert.equal(s.service.getSnapshot(uri, code, parsed.nodes).completed, 0);
            await s.service.ensure(uri, code, parsed.nodes, parsed.stmts);
        }
        assert.equal(s.calls.length, 10);
        assert.equal(s.service.getSnapshot("file:///another.py", code, parsed.nodes).completed, 0);
    });
    await test("background requests and opening details share one pending background", async () => {
        let release;
        let calls = 0;
        const barrier = new Promise(resolve => { release = resolve; });
        const s = setup("concurrent", { generate: async (_, lines) => { calls++; await barrier; return [{ lineStart: 0, lineEnd: lines.length - 1, label: "役割" }]; } });
        const one = "def f():\n    return 1";
        const p = parse(one);
        const id = p.nodes.find(n => n.kind === "function").id;
        const first = s.service.ensure(uri, one, p.nodes, p.stmts);
        const second = s.service.ensure(uri, one, p.nodes, p.stmts);
        const detail = s.service.details(uri, one, p.nodes, p.stmts, id);
        await Promise.resolve();
        release();
        const [a, b, d] = await Promise.all([first, second, detail]);
        assert.equal(calls, 1);
        assert.deepEqual(a.ranges, b.ranges);
        assert.deepEqual(d.blocks.map(({ description, ...block }) => block), a.ranges[id]);
        await s.service.details(uri, one, p.nodes, p.stmts, id);
        assert.equal(s.detailCalls.length, 1);
    });
    await test("different source never shares inflight or publishes stale result", async () => {
        let release;
        let current = true;
        let calls = 0;
        const barrier = new Promise(resolve => { release = resolve; });
        const s = setup("stale", { generate: async (_, lines) => { calls++; if (calls === 1) await barrier; return [{ lineStart: 0, lineEnd: lines.length - 1, label: "役割" }]; } });
        const one = "def f():\n    return 1";
        const two = one.replace("1", "2");
        const p = parse(one);
        let updates = 0;
        const first = s.service.ensure(uri, one, p.nodes, p.stmts, { isCurrent: () => current, onUpdate: () => updates++ });
        await Promise.resolve();
        current = false;
        const second = s.service.ensure(uri, two, p.nodes, p.stmts);
        release();
        const [old, latest] = await Promise.all([first, second]);
        assert.equal(calls, 2);
        assert.equal(updates, 0);
        assert.equal(old.completed, 0);
        assert.equal(latest.completed, 1);
    });
    await test("stopped queued work starts no LLM; shared live waiter still receives result", async () => {
        const s = setup("stop");
        let live = true;
        const promise = s.service.ensure(uri, code, parsed.nodes, parsed.stmts, { isCurrent: () => live });
        live = false;
        await promise;
        assert.equal(s.calls.length, 0);
        let firstLive = true;
        const one = "def f():\n    return 1";
        const p = parse(one);
        const first = s.service.ensure(uri, one, p.nodes, p.stmts, { isCurrent: () => firstLive });
        const second = s.service.ensure(uri, one, p.nodes, p.stmts);
        firstLive = false;
        const results = await Promise.all([first, second]);
        assert.equal(s.calls.length, 1);
        assert.equal(results[1].completed, 1);
    });
    await test("target errors do not fake colors, poison retry, or block other targets", async () => {
        let failure = true;
        const s = setup("failure", { generate: async (name, lines) => {
            if (name.startsWith("a(") && failure) throw new Error("provider failed");
            return [{ lineStart: 0, lineEnd: lines.length - 1, label: "意味" }];
        } });
        const result = await s.service.ensure(uri, code, parsed.nodes, parsed.stmts);
        assert.equal(result.completed, 1);
        assert.equal(Object.keys(result.errors).length, 1);
        assert.equal(Object.keys(result.ranges).length, 1);
        failure = false;
        const retry = await s.service.ensure(uri, code, parsed.nodes, parsed.stmts);
        assert.equal(retry.completed, 2);
        assert.deepEqual(retry.errors, {});
    });
    await test("nested methods, module code and parent ranges have exclusive ownership", async () => {
        const nested = '"""module"""\nRATE = 2\nclass Box:\n    factor = 2\n    def run(self, value):\n        def add(x):\n            return x + 1\n        return add(value)\n\nif RATE:\n    def helper():\n        return RATE\n    print(helper())';
        const p = parse(nested);
        const s = setup("nested");
        const first = await s.service.ensure(uri, nested, p.nodes, p.stmts);
        assert.equal(first.completed, first.total);
        const ranges = Object.values(first.ranges).flat();
        nested.split("\n").forEach((line, i) => {
            if (line.trim()) assert.equal(ranges.filter(r => r.lineStart <= i && i <= r.lineEnd).length, 1, `line ${i} ownership`);
        });
        const before = s.calls.length;
        const changed = nested.replace("return x + 1", "y = x + 2\n            return y");
        const cp = parse(changed);
        await s.service.ensure(uri, changed, cp.nodes, cp.stmts);
        assert.equal(s.calls.length - before, 1, "parent input must omit nested child body");
        assert.equal(s.calls[s.calls.length - 1].label, "add");
    });
    await test("decorators and one-line functions remain owned once", async () => {
        const decorated = "@decorator\ndef one(): return 1\n\nclass C:\n    @staticmethod\n    def two(): return 2";
        const p = parse(decorated);
        const s = setup("decorator");
        const result = await s.service.ensure(uri, decorated, p.nodes, p.stmts);
        const ranges = Object.values(result.ranges).flat();
        decorated.split("\n").forEach((line, i) => {
            if (line.trim()) assert.equal(ranges.filter(r => r.lineStart <= i && i <= r.lineEnd).length, 1);
        });
    });
    await test("details reject changed boundary and stale code before API submission", async () => {
        const s = setup("invalid-details", { details: async (_, lines, kind, blocks) => ({ overview: { purpose: "x" }, blocks: blocks.map(b => ({ ...b, lineEnd: b.lineEnd + 1, description: "x" })) }) });
        const id = parsed.nodes.find(n => n.kind === "function").id;
        await assert.rejects(s.service.details(uri, code, parsed.nodes, parsed.stmts, id), /一致/);
        await assert.rejects(s.service.details(uri, code, parsed.nodes, parsed.stmts, id, () => false), /変更/);
    });
    await test("cached open details rebase after outside edits without generation", async () => {
        const s = setup("detail-rebase");
        const id = parsed.nodes.find(n => n.kind === "function").id;
        const first = await s.service.details(uri, code, parsed.nodes, parsed.stmts, id);
        const shifted = "\n" + code;
        const p = parse(shifted);
        const rebased = s.service.peekDetails(uri, shifted, p.nodes, id);
        assert.equal(rebased.blocks[0].lineStart, first.blocks[0].lineStart + 1);
        const changed = shifted.replace("value + 1", "value + 8");
        assert.equal(s.service.peekDetails(uri, changed, p.nodes, id), undefined);
        assert.equal(s.calls.length, 1);
        assert.equal(s.detailCalls.length, 1);
    });
    await test("clear during generation prevents result repopulating persisted cache", async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const s = setup("clear", { generate: async (_, lines) => { await gate; return [{ lineStart: 0, lineEnd: lines.length - 1, label: "x" }]; } });
        const one = "def f():\n    return 1";
        const p = parse(one);
        const pending = s.service.ensure(uri, one, p.nodes, p.stmts);
        await Promise.resolve();
        s.service.clear();
        release();
        const old = await pending;
        assert.equal(old.completed, 0, "cleared in-flight result must not be published");
        await s.service.flush();
        assert.equal(s.service.getSnapshot(uri, one, p.nodes).completed, 0);
        assert.equal(JSON.parse(fs.readFileSync(path.join(s.directory, "semantic-backgrounds.json"))).entries.length, 0);
    });
    await test("persistent LRU stays within 200 targets and 16 MiB", async () => {
        const s = setup("limits");
        const one = "def f():\n    return 1";
        const p = parse(one);
        for (let i = 0; i < 202; i++) await s.service.ensure(`file:///test-${i}.py`, one, p.nodes, p.stmts);
        await s.service.flush();
        const file = path.join(s.directory, "semantic-backgrounds.json");
        const cache = JSON.parse(fs.readFileSync(file));
        assert.equal(cache.entries.length, 200);
        assert(fs.statSync(file).size <= 16 * 1024 * 1024);
        assert.equal(s.service.getSnapshot("file:///test-0.py", one, p.nodes).completed, 0);
        assert.equal(s.service.getSnapshot("file:///test-201.py", one, p.nodes).completed, 1);
        assert.deepEqual(fs.readdirSync(s.directory), ["semantic-backgrounds.json"]);
    });
    await test("malformed persisted anchors cannot become trusted background", async () => {
        const s = setup("bad-cache");
        await s.service.ensure(uri, code, parsed.nodes, parsed.stmts);
        await s.service.flush();
        const file = path.join(s.directory, "semantic-backgrounds.json");
        const cache = JSON.parse(fs.readFileSync(file));
        cache.entries.forEach(pair => { pair[1].anchors = [["wrong", "wrong"]]; });
        fs.writeFileSync(file, JSON.stringify(cache));
        const restart = new SemanticBackgroundService(s.directory, s.deps);
        assert.equal(restart.getSnapshot(uri, code, parsed.nodes).completed, 0);
    });
    await test("oversized target is displayed but never evicts reusable cache entries", async () => {
        const s = setup("oversized");
        const one = "def f():\n    return 1";
        const p = parse(one);
        await s.service.ensure(uri, one, p.nodes, p.stmts);
        s.deps.generate = async (_, lines) => [{ lineStart: 0, lineEnd: lines.length - 1, label: "x".repeat(16 * 1024 * 1024) }];
        const result = await s.service.ensure("file:///huge.py", one, p.nodes, p.stmts);
        assert.equal(result.completed, 1);
        assert.equal(s.service.getSnapshot(uri, one, p.nodes).completed, 1);
        assert.equal(s.service.getSnapshot("file:///huge.py", one, p.nodes).completed, 0);
        await s.service.flush();
        assert(fs.statSync(path.join(s.directory, "semantic-backgrounds.json")).size <= 16 * 1024 * 1024);
    });
    await test("production prompts generate partitions only and bind detail descriptions to saved IDs", async () => {
        // AI_NOTE: provider境界をmockし、本番プロンプトとJSON検証を実API利用なしで通す。
        const Module = require("module");
        const load = Module._load;
        const requests = [];
        let response = { blocks: [{ lineStart: 0, lineEnd: 1, label: "意味" }] };
        let authenticated = true;
        Module._load = function(request, parent, isMain) {
            if (request === "vscode") return { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
            if (request === "./llmProvider" && parent.filename.endsWith("claudeClient.js")) return {
                effectiveModel: model => model, providerOf: () => "mock", hasKeyForModel: () => authenticated,
                createMessage: async params => { requests.push(params); return { model: params.model, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: JSON.stringify(response) }] }; },
            };
            return load.call(this, request, parent, isMain);
        };
        try {
            const client = require("../out/api/claudeClient");
            const lines = ["def f():", "    return 1"];
            const blocks = await client.generateMeaningBackground("f", lines, "function");
            assert(requests[0].system.includes("詳細説明は生成しない"));
            assert(requests[0].system.includes("1区分で構いません"));
            response = { overview: { purpose: "目的" }, blocks: [{ id: 0, description: "詳細", lineStart: 999, lineEnd: 999 }] };
            const details = await client.generateMeaningDetails("f", lines, "function", blocks);
            assert.deepEqual(details.blocks.map(({ description, ...b }) => b), blocks, "LLM coordinates cannot overwrite fixed bounds");
            assert(requests[1].system.includes("区分の増減・結合・分割は禁止"));
            response = { overview: { purpose: "目的" }, blocks: [{ id: 8, description: "詳細" }] };
            await assert.rejects(client.generateMeaningDetails("f", lines, "function", blocks), /区分ID/);
            const before = requests.length;
            authenticated = false;
            await assert.rejects(client.generateMeaningBackground("f", lines, "function"), /認証/);
            assert.equal(requests.length, before);
        } finally { Module._load = load; }
    });
    console.log(`semanticBackground: ${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
