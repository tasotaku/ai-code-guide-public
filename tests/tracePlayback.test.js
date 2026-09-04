const assert = require("assert");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const { findPython } = require("./pythonCommand");
const { buildTracePlayback, projectTracePlayback } = require("../out/inline/tracePlayback");

const python = findPython();
function record(source, funcName = "main") {
    const result = spawnSync(python.command, [...python.args, path.join(__dirname, "../python/trace_runner.py")], {
        input: JSON.stringify({ source, func_name: funcName, setup: "EXAMPLE_ARGS = ()", templates: {} }),
        encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.strictEqual(result.status, 0, String(result.error || result.stderr || result.stdout).slice(0, 1000));
    return JSON.parse(result.stdout);
}

let passed = 0;
function test(name, run) { run(); passed += 1; console.log(`  ok - ${name}`); }
const textAt = (projection, line) => projection.values.find((value) => value.line === line)?.text;
const source = [
    "def main():",
    "    for a in [10, 20, 30]:",
    "        av = a + 1",
    "    w = 0",
    "    while w < 2:",
    "        w += 1",
    "        wv = w * 100",
    "    for outer in [1, 3]:",
    "        for inner in range(outer):",
    "            pair = (outer, inner)",
    "    for once in [7]:",
    "        single = once + 1",
    "    for absent in []:",
    "        never = absent",
    "    while False:",
    "        unused = 0",
    "def other():",
    "    for a in [40, 50]:",
    "        bv = a + 2",
    "    k = 0",
    "    while k < 1:",
    "        k += 1",
].join("\n");
const trace = record(source);
assert.strictEqual(trace.error, null);
const playback = buildTracePlayback(trace);

test("siblings project independently from actual for/while recordings", () => {
    const selected = projectTracePlayback(playback, { 0: 2, 1: 2 });
    assert.deepStrictEqual(selected.loops.map((loop) => loop.total), [3, 2, 2, 1, 1, 0, 0]);
    assert.match(textAt(selected, 2), /a=20/);
    assert.match(textAt(selected, 3), /av=21/);
    assert.match(textAt(selected, 7), /wv=200/);
    const nextFor = projectTracePlayback(playback, { 0: 3, 1: 2 });
    assert.match(textAt(nextFor, 3), /av=31/);
    assert.strictEqual(textAt(nextFor, 7), textAt(selected, 7));
    assert.strictEqual(nextFor.loops[1].iteration, 2);
});

test("variable inner counts clamp within the selected outer path", () => {
    const first = projectTracePlayback(playback, { 2: 1, 3: 3 });
    assert.deepStrictEqual(first.loops[3], { id: 3, headerLine: 9, parent: 2, iteration: 1, total: 1 });
    assert.match(textAt(first, 10), /pair=\(1,\s*0\)/);
    for (let inner = 1; inner <= 3; inner++) {
        const selected = projectTracePlayback(playback, { 2: 2, 3: inner });
        assert.strictEqual(selected.loops[3].total, 3);
        assert.match(textAt(selected, 10), new RegExp(`pair=\\(3,\\s*${inner - 1}\\)`));
    }
    const back = projectTracePlayback(playback, { 2: 1, 3: 3 });
    assert.deepStrictEqual(back, first);
});

test("zero loops have no fake values and one iteration remains readable", () => {
    const result = projectTracePlayback(playback, {});
    assert.match(textAt(result, 12), /single=8/);
    for (const line of [13, 14, 15, 16]) assert.strictEqual(textAt(result, line), undefined);
    for (const loop of result.loops.filter((loop) => loop.total === 0)) assert.strictEqual(loop.iteration, 0);
    const other = projectTracePlayback(buildTracePlayback(record(source, "other")), { 0: 2 });
    assert.match(textAt(other, 19), /bv=52/);
    assert.match(textAt(other, 22), /k=1/);
    assert.match(textAt(result, 3), /av=11/);
});

test("unchanged repeated values and pass-only bodies count recorded visits", () => {
    const repeated = record("def main():\n    for item in [7, 7, 7]:\n        copy = item\n    for nothing in [1, 1, 1]:\n        pass\n    return copy\n");
    assert.deepStrictEqual(repeated.iter_counts, { 0: { "": 3 }, 1: { "": 3 } });
    assert(repeated.line_steps.length > repeated.steps.length);
    assert(!repeated.steps.some((step) => step.line === 3 && step.iter_path[0][1] === 3));
    const result = projectTracePlayback(buildTracePlayback(repeated), { 0: 3, 1: 3 });
    assert.match(textAt(result, 2), /item=7/);
    assert.match(textAt(result, 3), /copy=7/);
    assert.strictEqual(result.loops[1].total, 3);
});

test("skipped branches never borrow an earlier parent's line value", () => {
    const branched = record("def main():\n    for outer in [1, 2]:\n        for inner in range(outer):\n            if outer == 1:\n                only_first = 100\n            pair = (outer, inner)\n    return pair\n");
    const data = buildTracePlayback(branched);
    assert.match(textAt(projectTracePlayback(data, { 0: 1, 1: 1 }), 5), /only_first=100/);
    const second = projectTracePlayback(data, { 0: 2, 1: 2 });
    assert.strictEqual(textAt(second, 5), undefined);
    assert.match(textAt(second, 4), /条件: false/);
    assert.match(textAt(second, 6), /pair=\(2,\s*1\)/);
});

test("zero inner visits under one parent do not leak another invocation", () => {
    const varying = record("def main():\n    for outer in [2, 0, 1]:\n        for inner in range(outer):\n            value = (outer, inner)\n    return outer\n");
    const result = projectTracePlayback(buildTracePlayback(varying), { 0: 2, 1: 2 });
    assert.deepStrictEqual(result.loops[1], { id: 1, headerLine: 3, parent: 0, iteration: 0, total: 0 });
    assert.strictEqual(textAt(result, 4), undefined);
});

test("legacy missing visits remain unknown instead of inferred", () => {
    const old = record("def main():\n    for item in [7, 7]:\n        copy = item\n    return copy\n");
    delete old.line_steps;
    const result = projectTracePlayback(buildTracePlayback(old), { 0: 2 });
    assert.match(textAt(result, 2), /item=7/);
    assert.strictEqual(textAt(result, 3), undefined);
});

test("projection is self-contained and does not mutate its snapshot", () => {
    const before = JSON.stringify(playback);
    const selected = { 0: NaN, 1: -20, 2: 999, 3: 999 };
    const result = projectTracePlayback(playback, selected);
    assert.deepStrictEqual(result.loops.slice(0, 4).map((loop) => loop.iteration), [1, 1, 2, 3]);
    assert(Number.isNaN(selected[0]));
    assert.strictEqual(JSON.stringify(playback), before);
    const embedded = vm.runInNewContext(`(${projectTracePlayback.toString()})`, {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(embedded(playback, {}))), projectTracePlayback(playback, {}));
});

test("assertions follow their own iteration while invocation return stays static", () => {
    const assertions = record("def main():\n    for item in [1, 2]:\n        assert item == 1\n    return item\n");
    assert(assertions.error);
    const data = buildTracePlayback(assertions);
    assert.match(textAt(projectTracePlayback(data, { 0: 1 }), 3), /✓ assert: 成功/);
    assert.match(textAt(projectTracePlayback(data, { 0: 2 }), 3), /✗ assert: 失敗/);
    assert.strictEqual(projectTracePlayback(playback, { 2: 1 }).values.find((value) => value.text.includes("戻り値")).text,
        projectTracePlayback(playback, { 2: 2 }).values.find((value) => value.text.includes("戻り値")).text);
});

test("serialized sibling loops grow with recorded steps, not selection products", () => {
    const lines = ["def main():"];
    for (let loop = 0; loop < 8; loop++) lines.push(`    for item${loop} in range(20):`, `        value${loop} = item${loop}`);
    lines.push("    return 0");
    const recording = record(lines.join("\n"));
    const data = buildTracePlayback(recording);
    assert.strictEqual(data.loops.length, 8);
    assert(data.samples.length <= recording.line_steps.length);
    assert(data.samples.length < 400);
    assert(JSON.stringify(data).length < 50000);
});

test("recording ceiling also bounds unchanged line visits", () => {
    const bounded = record("def main():\n    for item in range(12000):\n        pass\n    return 0\n");
    assert.strictEqual(bounded.overflow, true);
    assert(bounded.line_steps.length <= 20000);
    assert(bounded.steps.length <= 20000);
});

console.log(`trace playback ${passed} tests passed`);
