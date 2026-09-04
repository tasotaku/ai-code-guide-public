const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    extractJavaScriptGraph,
    extractJavaScriptProjectGraph,
    javaScriptFuncAtLine,
    javaScriptStmtSpans,
    listJavaScriptFunctions,
} = require("../out/flowchart/javascriptParser.js");
const { languageIdForPath, isSupportedLanguage } = require("../out/flowchart/languageSupport.js");

const source = [
    'import { save } from "./store";',
    "const LIMIT = 3;",
    "const normalize = (value) => value.trim();",
    "async function load(value) {",
    "  const clean = normalize(value);",
    "  if (!clean) {",
    "    return null;",
    "  }",
    "  await save(clean);",
    "  return clean;",
    "}",
    "class Planner {",
    "  run(value) {",
    "    return load(value);",
    "  }",
    "}",
].join("\n");

const graph = extractJavaScriptGraph(source, "javascript");
assert.strictEqual(graph.error, undefined);
assert.ok(graph.nodes.some((node) => node.kind === "function" && node.label.startsWith("normalize(")));
assert.ok(graph.nodes.some((node) => node.kind === "function" && node.label.startsWith("load(")));
assert.ok(graph.nodes.some((node) => node.kind === "constant" && node.label === "LIMIT"));
const classNode = graph.nodes.find((node) => node.kind === "class" && node.label === "class Planner");
const methodNode = graph.nodes.find((node) => node.kind === "function" && node.label.startsWith("run("));
assert.ok(classNode && methodNode && methodNode.parent === classNode.id, "class method should retain its parent card");
const loadNode = graph.nodes.find((node) => node.label.startsWith("load("));
const normalizeNode = graph.nodes.find((node) => node.label.startsWith("normalize("));
assert.ok(graph.edges.some((edge) => edge.from === loadNode.id && edge.to === normalizeNode.id));
assert.ok(graph.relationships.some((item) => item.from === "load" && item.to === "save"));

assert.strictEqual(javaScriptFuncAtLine(source, "javascript", 13), "Planner.run");
assert.deepStrictEqual(listJavaScriptFunctions(source, "javascript").map((item) => item.name), ["normalize", "load", "Planner.run"]);
assert.ok(javaScriptStmtSpans(source, "javascript").some((span) => span.start === 5 && span.end === 7));

const flow = extractJavaScriptGraph(source, "javascript", "load");
assert.ok(flow.nodes.some((node) => node.kind === "condition" && node.label.includes("!clean")));
assert.ok(flow.nodes.filter((node) => node.kind === "return").length >= 2);
assert.strictEqual(
    new Set(flow.edges.map((edge) => `${edge.from}\0${edge.to}\0${edge.label}`)).size,
    flow.edges.length,
    "function control-flow edges must not be duplicated",
);

const tsx = [
    "interface Props { title: string }",
    "export const Card = ({ title }: Props) => <h1>{title}</h1>;",
].join("\n");
const tsxGraph = extractJavaScriptGraph(tsx, "typescriptreact");
assert.ok(tsxGraph.nodes.some((node) => node.label === "interface Props"));
assert.ok(tsxGraph.nodes.some((node) => node.kind === "function" && node.label.startsWith("Card(")));
assert.ok(extractJavaScriptGraph("function broken(", "javascript").error, "syntax errors should be returned through the common error contract");
assert.strictEqual(languageIdForPath("src/widget.tsx"), "typescriptreact");
assert.strictEqual(languageIdForPath("src/readme.md"), undefined);
assert.strictEqual(isSupportedLanguage("javascript"), true);
assert.strictEqual(isSupportedLanguage("ruby"), false);

const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-code-guide-js-"));
try {
    fs.mkdirSync(path.join(project, "src"));
    fs.writeFileSync(path.join(project, "src", "main.js"), 'import { save } from "./store";\nexport function run(value) { return save(value); }\n');
    fs.writeFileSync(path.join(project, "src", "store.ts"), "export const save = (value: string) => value;\n");
    const projectGraph = extractJavaScriptProjectGraph(project);
    assert.deepStrictEqual(projectGraph.nodes.map((node) => node.rel_path), ["src/main.js", "src/store.ts"]);
    assert.strictEqual(projectGraph.edges.length, 1);
    assert.strictEqual(projectGraph.edges[0].label, "./store");
} finally {
    fs.rmSync(project, { recursive: true, force: true });
}

console.log("ok - JavaScript/TypeScript share the common graph contract");
