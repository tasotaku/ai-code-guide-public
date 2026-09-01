// trace_runner.py のクラスメソッド実行回帰テスト。
// unittest.TestCase は setUp/tearDown を自動実行し、通常メソッドは
// LLM準備コード相当の EXAMPLE_INSTANCE を利用することを固定する。
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");
const { findPython } = require("./pythonCommand");

const script = path.join(__dirname, "..", "python", "trace_runner.py");
const python = findPython();

function trace(source, funcName, setup, templates = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acg-trace-method-"));
    const filePath = path.join(tempDir, "target.py");
    fs.writeFileSync(filePath, source);
    try {
        const payload = { source, func_name: funcName, setup, templates, file_path: filePath, workspace_root: tempDir };
        const proc = spawnSync(python.command, [...python.args, script], { input: JSON.stringify(payload), encoding: "utf8" });
        assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
        return JSON.parse(proc.stdout);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

const unittestSource = [
    "import unittest",
    "",
    "events = []",
    "",
    "class SampleTests(unittest.TestCase):",
    "    def setUp(self):",
    "        self.base = 4",
    "        events.append('setUp')",
    "",
    "    def tearDown(self):",
    "        events.append('tearDown')",
    "",
    "    def test_double(self):",
    "        values = []",
    "        for item in (1, 2):",
    "            values.append(self.base * item)",
    "        self.assertEqual(values, [4, 8])",
].join("\n");

const unittestResult = trace(unittestSource, "SampleTests.test_double", "EXAMPLE_ARGS = ()");
assert.strictEqual(unittestResult.error, null);
assert.strictEqual(unittestResult.func_line_start, 13);
assert.ok(unittestResult.steps.some((step) => step.line === 16), "test method body is traced");
assert.strictEqual(unittestResult.iter_counts["0"][""], 2, "test method loop iterations are counted");
assert.match(unittestResult.final_locals.values.full, /\[4, 8\]/, "final local state is directly observable");
assert.deepStrictEqual(unittestResult.assertions.map(({ line, method, outcome }) => ({ line, method, outcome })), [
    { line: 17, method: "assertEqual", outcome: true },
], "unittest assertions expose their executed outcome");
assert.strictEqual(unittestResult.assertions[0].arguments[0].full, "[4, 8]");
assert.strictEqual(unittestResult.assertions[0].arguments[1].full, "[4, 8]");

const assertionSource = [
    "import unittest",
    "",
    "class AssertionTests(unittest.TestCase):",
    "    def test_expectations(self):",
    "        value = 6",
    "        assert value > 0",
    "        with self.assertRaises(ValueError):",
    "            raise ValueError('invalid input')",
].join("\n");
const assertionResult = trace(assertionSource, "AssertionTests.test_expectations", "EXAMPLE_ARGS = ()");
assert.strictEqual(assertionResult.error, null);
assert.deepStrictEqual(assertionResult.assertions.map(({ line, method, outcome }) => ({ line, method, outcome })), [
    { line: 6, method: "assert", outcome: true },
    { line: 7, method: "assertRaises", outcome: true },
]);
assert.strictEqual(assertionResult.assertions[1].arguments[0].full, "<class 'ValueError'>");
assert.deepStrictEqual(assertionResult.assertions[1].exception, { type: "ValueError", message: "invalid input" });
assert.strictEqual(assertionResult.calls[0].exception, null, "an expected assertRaises exception does not mark the completed test method as failed");
assert.strictEqual(assertionResult.calls[0].return_value.full, "None", "the completed test method keeps its normal return after handling the expected exception");

const failedAssertionResult = trace("def check(value):\n    assert value > 0, 'positive required'\n", "check", "EXAMPLE_ARGS = (0,)");
assert.match(failedAssertionResult.error, /AssertionError: positive required/);
assert.deepStrictEqual(failedAssertionResult.assertions.map(({ line, method, outcome, exception }) => ({ line, method, outcome, exception })), [{
    line: 2,
    method: "assert",
    outcome: false,
    exception: { type: "AssertionError", message: "positive required" },
}], "failed language asserts remain visible in the failed trace envelope");

const loopAssertionResult = trace([
    "def check_all(values):",
    "    for value in values:",
    "        assert value > 0",
].join("\n"), "check_all", "EXAMPLE_ARGS = ([1, 2],)");
assert.deepStrictEqual(loopAssertionResult.assertions.map(({ line, outcome, iter_path }) => ({ line, outcome, iter_path })), [
    { line: 3, outcome: true, iter_path: [[0, 1]] },
    { line: 3, outcome: true, iter_path: [[0, 2]] },
], "loop assertions remain attached to the iteration in which they executed");

const failedUnittestResult = trace([
    "import unittest",
    "class FailureTests(unittest.TestCase):",
    "    def test_mismatch(self):",
    "        self.assertEqual(3, 4)",
].join("\n"), "FailureTests.test_mismatch", "EXAMPLE_ARGS = ()");
assert.match(failedUnittestResult.error, /AssertionError/);
assert.deepStrictEqual(failedUnittestResult.assertions.map(({ line, method, outcome }) => ({ line, method, outcome })), [
    { line: 4, method: "assertEqual", outcome: false },
], "failed unittest assertions expose the written outer assertion once");

const visibleStateSource = [
    "class Store:",
    "    def __init__(self):",
    "        self.kept = []",
    "",
    "def check():",
    "    store = Store()",
    "    assert store.kept == []",
].join("\n");
const visibleStateResult = trace(visibleStateSource, "check", "EXAMPLE_ARGS = ()");
assert.match(visibleStateResult.final_locals.store.full, /Store.*kept.*\[\]/, "public object state is directly observable");
assert.strictEqual(visibleStateResult.final_locals.store.short, "Store(kept=[])", "opaque objects show their public state instead of a runtime address");

const nestedStateSource = [
    "class UploadRequest:",
    "    def __init__(self, document_id, filename, content):",
    "        self.document_id = document_id",
    "        self.filename = filename",
    "        self.content = content",
    "",
    "class QuarantinedFile:",
    "    def __init__(self, quarantine_id, filename):",
    "        self.quarantine_id = quarantine_id",
    "        self.filename = filename",
    "",
    "class PublishedDocument:",
    "    def __init__(self, request, quarantined_file):",
    "        self.request = request",
    "        self.quarantined_file = quarantined_file",
    "",
    "class RecordingQuarantine:",
    "    def __init__(self):",
    "        self.stored = []",
    "        self.deleted = []",
    "",
    "def inspect_nested():",
    "    request = UploadRequest('document-1', 'report.pdf', b'contents')",
    "    quarantined = QuarantinedFile('quarantine-1', request.filename)",
    "    quarantine = RecordingQuarantine()",
    "    quarantine.stored.append(quarantined)",
    "    result = PublishedDocument(request, quarantined)",
    "    return result",
].join("\n");
const nestedStateResult = trace(nestedStateSource, "inspect_nested", "EXAMPLE_ARGS = ()", {
    PublishedDocument: "Published({request}, {quarantined_file})",
});
assert.strictEqual(nestedStateResult.final_locals.quarantine.short, "RecordingQuarantine(stored=1, deleted=0)", "state-holder objects use collection counts instead of recursively expanding their contents");
assert.strictEqual(nestedStateResult.final_locals.result.short, "PublishedDocument(document_id='document-1', filename='report.pdf', quarantine_id='quarantine-1')", "nested domain objects keep the identifying fields that fit without recursively expanding whole objects");
assert.ok(nestedStateResult.final_locals.result.short.endsWith(")"), "semantic summaries remain syntactically closed instead of clipping mid-value");

const opaqueValueSource = [
    "class Token:",
    "    __slots__ = ()",
    "",
    "def inspect_values():",
    "    token = Token()",
    "    iterator = iter([1, 2])",
    "    return token",
].join("\n");
const opaqueValueResult = trace(opaqueValueSource, "inspect_values", "EXAMPLE_ARGS = ()");
assert.strictEqual(opaqueValueResult.final_locals.token.short, "Token()", "stateless default objects keep only a stable type name");
assert.match(opaqueValueResult.final_locals.iterator.short, /^<list_iterator>$/, "iterators keep their kind without a runtime address");
assert.doesNotMatch(JSON.stringify(opaqueValueResult), /\sat 0x[0-9a-fA-F]+/, "trace output does not leak unstable runtime addresses");

const reprBehaviorSource = [
    "class Useful:",
    "    def __repr__(self):",
    "        return 'Useful<ready>'",
    "",
    "class Broken:",
    "    def __repr__(self):",
    "        raise RuntimeError('repr failed')",
    "",
    "def inspect_repr():",
    "    useful = Useful()",
    "    broken = Broken()",
    "    return useful",
].join("\n");
const reprBehaviorResult = trace(reprBehaviorSource, "inspect_repr", "EXAMPLE_ARGS = ()");
assert.strictEqual(reprBehaviorResult.final_locals.useful.short, "Useful<ready>", "a useful custom repr remains unchanged");
assert.strictEqual(reprBehaviorResult.final_locals.broken.short, "<Broken>", "broken repr falls back to a stable type label");

const teardownSource = [
    "import unittest",
    "",
    "class CleanupTests(unittest.TestCase):",
    "    def tearDown(self):",
    "        raise RuntimeError('cleanup ran')",
    "",
    "    def test_ok(self):",
    "        value = 1",
].join("\n");
const teardownResult = trace(teardownSource, "CleanupTests.test_ok", "EXAMPLE_ARGS = ()");
assert.strictEqual(teardownResult.stage, "run");
assert.match(teardownResult.error, /cleanup ran/, "tearDown is executed after the test method");
assert.strictEqual(teardownResult.func_line_start, 7, "failed traces retain their source start");
assert.strictEqual(teardownResult.func_line_end, 8, "failed traces retain their source end");
assert.deepStrictEqual(teardownResult.iter_counts, {}, "failed traces retain a complete trace envelope");
assert.strictEqual(teardownResult.return_value, null);

const instanceSource = [
    "class Calculator:",
    "    def __init__(self, offset):",
    "        self.offset = offset",
    "",
    "    def add(self, value):",
    "        result = self.offset + value",
    "        return result",
].join("\n");

const instanceResult = trace(
    instanceSource,
    "Calculator.add",
    "EXAMPLE_INSTANCE = Calculator(3)\nEXAMPLE_ARGS = (4,)",
);
assert.strictEqual(instanceResult.error, null);
assert.strictEqual(instanceResult.return_value.short, "7");
const instanceInput = instanceResult.steps.find((step) => step.line === 5);
assert.deepStrictEqual(Object.keys(instanceInput.changed), ["value"], "the input example contains explicit arguments but not the implicit self receiver");
assert.ok(instanceResult.calls.every((call) => !("self" in call.arguments) && !("cls" in call.arguments)), "call arguments omit implicit method receivers everywhere");

const missingInstance = trace(instanceSource, "Calculator.add", "EXAMPLE_ARGS = (4,)");
assert.strictEqual(missingInstance.stage, "setup");
assert.match(missingInstance.error, /EXAMPLE_INSTANCE/);

const staticSource = [
    "class Calculator:",
    "    @staticmethod",
    "    def add(left, right):",
    "        return left + right",
].join("\n");
const staticResult = trace(staticSource, "Calculator.add", "EXAMPLE_ARGS = (2, 5)");
assert.strictEqual(staticResult.error, null);
assert.strictEqual(staticResult.return_value.short, "7");

const nestedSource = [
    "def inner(value):",
    "    return value + 1",
    "",
    "def outer(value):",
    "    return inner(value) * 2",
].join("\n");
const nestedResult = trace(nestedSource, "outer", "EXAMPLE_ARGS = (4,)");
assert.deepStrictEqual(nestedResult.calls.map((call) => call.function), ["outer", "inner"]);
assert.strictEqual(nestedResult.calls[0].arguments.value.full, "4");
assert.strictEqual(nestedResult.calls[1].return_value.full, "5");
assert.strictEqual(nestedResult.calls[0].return_value.full, "10");

const branchSource = [
    "def choose(total, vip):",
    "    if total >= 200:",
    "        return 'priority'",
    "    if vip and total >= 100:",
    "        return 'preferred'",
    "    return 'regular'",
].join("\n");
const branchResult = trace(branchSource, "choose", "EXAMPLE_ARGS = (100, True)");
assert.deepStrictEqual(branchResult.executed_lines, [2, 4, 5]);
assert.deepStrictEqual(branchResult.path_events.map(({ line, outcome }) => ({ line, outcome })), [
    { line: 2, outcome: false },
    { line: 4, outcome: true },
]);
assert.deepStrictEqual(branchResult.control_points.map(({ line, kind }) => ({ line, kind })), [
    { line: 2, kind: "if" },
    { line: 3, kind: "return" },
    { line: 4, kind: "if" },
    { line: 5, kind: "return" },
    { line: 6, kind: "return" },
]);

const exceptionSource = [
    "def require_positive(value):",
    "    if value <= 0:",
    "        raise ValueError(f'positive required: {value}')",
    "    return value",
].join("\n");
const exceptionResult = trace(exceptionSource, "require_positive", "EXAMPLE_ARGS = (-1,)");
assert.strictEqual(exceptionResult.calls[0].return_value, null, "exception unwind is not a None return");
assert.deepStrictEqual(exceptionResult.calls[0].exception, {
    type: "ValueError",
    message: "positive required: -1",
});

const nestedExceptionSource = [
    "def scan():",
    "    raise RuntimeError('offline')",
    "",
    "def ingest():",
    "    try:",
    "        scan()",
    "    except RuntimeError:",
    "        raise",
].join("\n");
const nestedExceptionResult = trace(nestedExceptionSource, "ingest", "EXAMPLE_ARGS = ()");
const scanCall = nestedExceptionResult.calls.find((call) => call.function === "scan");
assert.strictEqual(scanCall.return_value, null);
assert.deepStrictEqual(scanCall.exception, { type: "RuntimeError", message: "offline" });

const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), "acg-trace-monitor-"));
try {
    const monitorFile = path.join(monitorDir, "sitecustomize.py");
    const ledger = path.join(monitorDir, "ledger.jsonl");
    fs.writeFileSync(monitorFile, [
        "import json, os, sys",
        "ledger = os.environ.get('ACG_TEST_PROFILE_LEDGER')",
        "def observe(frame, event, arg):",
        "    if event == 'call' and frame.f_code.co_filename == os.environ.get('ACG_TEST_PROFILE_TARGET'):",
        "        with open(ledger, 'a', encoding='utf-8') as stream:",
        "            stream.write(json.dumps({'function': frame.f_code.co_name}) + '\\n')",
        "    return observe",
        "sys.setprofile(observe)",
    ].join("\n"));
    const targetFile = path.join(monitorDir, "target.py");
    const source = "def monitored(value):\n    return value + 1\n";
    fs.writeFileSync(targetFile, source);
    const payload = { source, func_name: "monitored", setup: "EXAMPLE_ARGS = (7,)", templates: {}, file_path: targetFile, workspace_root: monitorDir };
    const proc = spawnSync(python.command, [...python.args, script], {
        input: JSON.stringify(payload), encoding: "utf8",
        env: { ...process.env, PYTHONPATH: monitorDir, ACG_TEST_PROFILE_LEDGER: ledger, ACG_TEST_PROFILE_TARGET: targetFile },
    });
    assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
    assert.ok(fs.readFileSync(ledger, "utf8").split(/\r?\n/).some((line) => line.includes('"function": "monitored"')), "pre-existing profile observes the traced target call");
} finally {
    fs.rmSync(monitorDir, { recursive: true, force: true });
}

// Windows の Node.js は文字列を UTF-8 で pipe へ書く一方、Python の stdin は
// 既定で cp932 + surrogateescape になる。日本語を含むソースでも protocol が
// UTF-8 のまま読まれ、孤立 surrogate を ast.parse へ渡さないことを固定する。
const unicodeSource = [
    "def annotated():",
    "    # AI_NOTE: ScanError の各契約を確認する。",
    "    value = '正常'",
    "    return value",
].join("\n");
const unicodeResult = trace(unicodeSource, "annotated", "EXAMPLE_ARGS = ()");
assert.strictEqual(unicodeResult.error, null);
assert.strictEqual(unicodeResult.return_value.short, "'正常'");

console.log("21/21 trace method cases passed");
