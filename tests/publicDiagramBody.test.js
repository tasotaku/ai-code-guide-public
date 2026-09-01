const assert = require("assert");
const { publicDiagramBody } = require("../out/mcp/server.js");

function diagram(primary, nodeCount, edges) {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
        id: `n${index + 1}`, symbol: primary, label: `core ${index + 1}`, line: index,
    }));
    nodes.splice(1, 0, { id: "context", symbol: "relationship_context", anchor: "def relationship_context", label: "context", line: 20 });
    return publicDiagramBody({ diagram: { nodes, edges } }).diagram;
}

const normalize = diagram("normalize_score", 7, [
    { from: "n1", to: "context", label: "call" },
    { from: "context", to: "n2", label: "return" },
    ...Array.from({ length: 6 }, (_, index) => ({ from: `n${index + 1}`, to: `n${index + 2}`, label: "" })),
]);
assert.strictEqual(normalize.nodes.length, 7);
assert.strictEqual(normalize.edges.length, 7);
assert.strictEqual(normalize.relationships.length, 1);
assert.ok(normalize.edges.some((edge) => edge.from === "n1" && edge.to === "n2"));

const classify = diagram("classify_order", 7, [
    { from: "context", to: "n1", label: "call" },
    ...Array.from({ length: 8 }, (_, index) => ({ from: `n${Math.min(index + 1, 6)}`, to: `n${Math.min(index + 2, 7)}`, label: String(index) })),
]);
assert.strictEqual(classify.nodes.length, 7);
assert.strictEqual(classify.edges.length, 8);
assert.strictEqual(classify.relationships.length, 1);

const assignments = publicDiagramBody({ diagram: {
    nodes: [
        { id: "entry", symbol: "normalize_score", label: "entry", line: 10 },
        { id: "raw", symbol: "raw_value", label: "raw assignment", line: 12 },
        { id: "limit", symbol: "limit", label: "limit assignment", line: 13 },
        { id: "if", symbol: "normalize_score", label: "branch", line: 14 },
        { id: "raise", symbol: "normalize_score", label: "raise", line: 15 },
        { id: "return", symbol: "normalize_score", label: "return", line: 16 },
        { id: "exit", symbol: "normalize_score", label: "exit", line: 16 },
        { id: "helper", symbol: "require_nonnegative", anchor: "def require_nonnegative(value)", label: "relationship", line: 4 },
    ],
    edges: [
        { from: "entry", to: "raw" }, { from: "limit", to: "if" },
        { from: "if", to: "raise", label: "true" }, { from: "if", to: "return", label: "false" },
        { from: "raise", to: "exit" }, { from: "return", to: "exit" },
        { from: "raw", to: "helper" }, { from: "helper", to: "limit" },
    ],
} }).diagram;
assert.deepStrictEqual(assignments.nodes.map((node) => node.line), [11, 13, 14, 15, 16, 17, 17]);
assert.strictEqual(assignments.nodes.length, 7, "assignment nodes remain navigable core cards");
assert.strictEqual(assignments.edges.length, 7);
assert.strictEqual(assignments.relationships.length, 1);

console.log("3/3 public diagram CFG normalization cases passed");
