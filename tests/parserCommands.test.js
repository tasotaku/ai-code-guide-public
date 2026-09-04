const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const { findPython } = require("./pythonCommand");

const root = path.join(__dirname, "..");
const parser = path.join(root, "python", "ast_parser.py");
const python = findPython();
const source = [
    "import os",
    "",
    "def choose(value):",
    "    if value > 0:",
    "        return value",
    "    return 0",
    "",
    "async def load():",
    "    return 1",
    "",
    "class Picker:",
    "    def choose(self, value):",
    "        return value + 1",
    "",
].join("\n");

function run(command, args = [], input = source) {
    const result = spawnSync(python.command, [...python.args, parser, command, ...args], {
        cwd: root,
        input,
        encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
}

for (const granularity of ["coarse", "normal", "detail"]) {
    const result = run("flowchart", [granularity]);
    assert.ok(Array.isArray(result.nodes) && result.nodes.length > 0, `flowchart ${granularity}`);
    assert.ok(Array.isArray(result.edges), `flowchart ${granularity} edges`);
}

const inventory = run("flowchart", ["coarse"], [
    "def score(raw, limit=100):",
    "    return raw / limit",
    "",
    "SAMPLE_ITEMS = [1, 2]",
    "SAMPLE_ARGS = {\"raw\": 1}",
    "local_value = 3",
    "",
].join("\n"));
assert.deepStrictEqual(
    inventory.nodes.map((node) => [node.kind, node.label, node.lineStart, node.lineEnd]),
    [
        ["function", "score(raw, limit=100)", 0, 1],
        ["constant", "SAMPLE_ITEMS", 3, 3],
        ["constant", "SAMPLE_ARGS", 4, 4],
    ],
    "coarse inventoryはmodule直下の関数signatureと名前付き定数だけをコード順で返す",
);

const graph = run("graph", ["choose"]);
assert.ok(graph.nodes.some((node) => node.kind === "entry" && node.label.startsWith("choose(")), "graph は対象関数を含む");
assert.ok(Array.isArray(graph.edges));

const moduleGraph = run("graph", [], [
    "SAMPLE_ITEMS = [1, 2]",
    "def use():",
    "    LOCAL_VALUE = 3",
    "    return SAMPLE_ITEMS",
    "SAMPLE_ARGS: dict = {\"raw\": 1}",
    "",
].join("\n"));
assert.deepStrictEqual(
    moduleGraph.nodes.filter((node) => node.kind === "constant").map((node) => [node.label, node.lineStart, node.lineEnd]),
    [["SAMPLE_ITEMS", 0, 0], ["SAMPLE_ARGS", 4, 4]],
    "normal graphはmodule定数を含み、関数内部の大文字代入はtop-level inventoryへ混ぜない",
);

const relationshipGraph = run("graph", [], [
    "def validate(value):",
    "    return value",
    "def calculate(raw, limit):",
    "    first = validate(raw)",
    "    second = validate(limit)",
    "    return first + second",
    "def unsafe_export(path):",
    "    with open(path, 'w') as handle:",
    "        handle.write('x')",
    "def unknown_dispatch(name, value):",
    "    return globals()[name](value)",
].join("\n"));
assert.deepStrictEqual(relationshipGraph.relationships, [
    { from: "calculate", to: "validate", line: 4 },
    { from: "calculate", to: "validate", line: 5 },
    { from: "unsafe_export", to: "open", line: 8 },
    { from: "unsafe_export", to: "write", line: 9 },
    { from: "unknown_dispatch", to: "dynamic globals lookup", line: 11 },
]);

const nonAsciiSource = [
    "def ingest(request):",
    "    # 隔離ファイルを再検査対象として残す",
    "    return request",
    "",
].join("\n");
const nonAsciiResult = spawnSync(python.command, [...python.args, parser, "graph"], {
    cwd: root,
    input: nonAsciiSource,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "cp932" },
});
assert.strictEqual(nonAsciiResult.status, 0, nonAsciiResult.stderr || nonAsciiResult.stdout);
assert.ok(
    JSON.parse(nonAsciiResult.stdout).nodes.some((node) => node.label.startsWith("ingest(")),
    "WindowsのANSIコードページ設定でもUTF-8の日本語コメントを解析できる",
);

const detail = run("graph_detail");
assert.ok(Array.isArray(detail.nodes) && detail.nodes.some((node) => node.kind === "function"), "graph_detail は詳細構造を返す");

const blocks = run("blocks", ["normal", "choose"]);
assert.ok(Array.isArray(blocks) && blocks.length > 0, "blocks は対象関数のブロックを返す");

assert.deepStrictEqual(run("func_at_line", ["3"]), { func: "choose" });
assert.deepStrictEqual(run("func_at_line", ["12"]), { func: "Picker.choose" });

const functions = run("functions");
assert.deepStrictEqual(functions.map((item) => item.name), ["choose", "load", "Picker.choose"]);

const spans = run("stmt_spans");
assert.ok(Array.isArray(spans) && spans.length > 0, "stmt_spans は文境界を返す");

const symbols = run("symbols", [], [
    "class Scanner:",
    "    def scan(self, path):",
    "        report = self.backend.inspect(path)",
    "        return report",
    "",
    "scanner = Scanner()",
    "result = scanner.scan('sample.txt')",
].join("\n"));
assert.ok(symbols.every((item) => item.kind !== "block"), "symbols は名称だけを返す");
assert.ok(symbols.some((item) => item.name === "report" && item.kind === "variable"), "ローカル変数を含む");
assert.ok(symbols.some((item) => item.name === "scan" && item.kind === "method"), "メソッド定義・呼出を含む");
assert.ok(symbols.some((item) => item.name === "Scanner" && item.kind === "class"), "クラス定義・利用を含む");
assert.strictEqual(symbols.filter((item) => item.line === 2 && item.name === "inspect").length, 1, "同じ出現位置を重複しない");
const scanDefinition = symbols.find((item) => item.name === "scan" && item.is_definition);
assert.deepStrictEqual(
    [scanDefinition.scope_start, scanDefinition.scope_end],
    [1, 3],
    "method定義の説明fingerprintはmethod本体だけを意味scopeにする",
);
assert.ok(
    symbols.filter((item) => item.key === "Scanner.scan|variable|path").every((item) => item.scope_start === 1 && item.scope_end === 3),
    "引数と利用箇所は同じ最内側scopeを共有する",
);

const selectedSymbols = run("symbols", [], [
    "        report = scanner.scan(path)",
    "        return report",
].join("\n"));
assert.ok(selectedSymbols.some((item) => item.name === "scan" && item.start_col === 25), "字下げされた選択範囲の列を保持する");
assert.ok(selectedSymbols.some((item) => item.name === "report" && item.line === 1 && item.start_col === 15), "returnを含む部分コードも一時関数内で解析する");

const project = run("project_graph", [path.join(root, "examples", "single_file")], "");
assert.ok(Array.isArray(project.nodes) && project.nodes.length > 0, "project_graph はPythonファイルを列挙する");
assert.ok(Array.isArray(project.edges), "project_graph は依存関係を返す");
assert.ok(project.nodes.every((node) => Array.isArray(node.symbols)), "project_graph はクラスを含む図用symbolsを返す");
assert.ok(project.nodes.some((node) => node.symbols.includes("ConfigError")), "メソッドのない例外classも図用symbolsへ含める");

console.log("10/10 parser commands passed");
