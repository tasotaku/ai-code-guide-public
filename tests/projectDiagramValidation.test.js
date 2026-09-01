const assert = require("assert");
const {
    collapseProjectDiagramEdges,
    isConnectedProjectDiagram,
    missingRequestedProjectDiagramSymbols,
    projectDiagramStepKey,
    projectDiagramConnectivity,
} = require("../out/api/projectDiagramValidation.js");

const nodes = ["start", "success", "failure", "cleanup"].map((id) => ({ id }));

const branched = projectDiagramConnectivity(nodes, [
    { from: "start", to: "success" },
    { from: "start", to: "failure" },
    { from: "failure", to: "cleanup" },
]);
assert.strictEqual(branched.connected, true);
assert.deepStrictEqual(branched.disconnectedNodeIds, []);

const orphaned = projectDiagramConnectivity(nodes, [
    { from: "start", to: "success" },
    { from: "start", to: "failure" },
]);
assert.strictEqual(orphaned.connected, false);
assert.deepStrictEqual(orphaned.disconnectedNodeIds, ["cleanup"]);

assert.strictEqual(isConnectedProjectDiagram({ nodes: [{ id: "only" }], edges: [] }), true);
assert.strictEqual(isConnectedProjectDiagram({
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "missing", to: "b" }],
}), false);

assert.deepStrictEqual(
    missingRequestedProjectDiagramSymbols(
        [{ symbol: "UnsafeContent" }, { symbol: "ScanError" }],
        ["UnsafeContent", "ScannerUnavailable"],
    ),
    ["ScannerUnavailable"],
);

assert.deepStrictEqual(
    collapseProjectDiagramEdges([
        { from: "unsafe", to: "shared-catch", label: "" },
        { from: "unavailable", to: "shared-catch", label: "" },
        { from: "shared-catch", to: "delete", label: "再送出前" },
        { from: "scan", to: "published", label: "正常" },
    ], new Set(["scan", "unsafe", "unavailable", "delete", "published"])),
    [
        { from: "scan", to: "published", label: "正常" },
        { from: "unsafe", to: "delete", label: "再送出前" },
        { from: "unavailable", to: "delete", label: "再送出前" },
    ],
);

const ingestStart = {
    file: "ingestion/service.py",
    symbol: "DocumentIngestionService.ingest",
    label: "文書取り込み",
    description: "文書を隔離して走査を開始する。",
};
const ingestRethrow = {
    ...ingestStart,
    label: "同じ例外を再送出",
    description: "捕捉した走査例外をそのまま再送出する。",
};
assert.notStrictEqual(
    projectDiagramStepKey(ingestStart),
    projectDiagramStepKey(ingestRethrow),
    "同じ関数でも意味が異なる開始と再送出は別ステップとして残す",
);
assert.strictEqual(
    projectDiagramStepKey(ingestStart),
    projectDiagramStepKey({ ...ingestStart }),
    "コード地点と表示上の役割が同じnodeだけを重複扱いする",
);

console.log("project diagram validation: 8/8 passed");
