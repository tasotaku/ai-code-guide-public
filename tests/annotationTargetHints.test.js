const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const fakeVscode = { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
const originalLoad = Module._load;
Module._load = (request, parent, isMain) => request === "vscode"
    ? fakeVscode
    : originalLoad.call(Module, request, parent, isMain);

const {
    annotationTargetHints,
    requiredAnnotationTargets,
    missingRequiredAnnotationTargets,
} = require("../out/api/claudeClient.js");
const { resolveAnnotations } = require("../out/api/annotationResolver.js");
const fixture = path.join(__dirname, "fixtures", "annotation_target_hints.py");
const code = fs.readFileSync(fixture, "utf8");
const lines = code.replace(/\r\n/g, "\n").split("\n");
const hints = annotationTargetHints(code);
const required = requiredAnnotationTargets(code);

const includes = (text) => hints.some((hint) => hint.includes(text));
for (const text of [
    "from sample.models import Item, ProcessReport, ProcessRequest",
    "from sample.ports import ServiceUnavailable, InvalidInput",
    "from sample.service import ProcessingService",
    "store = RecordingStore()",
    "repository = RecordingRepository()",
    "service = ProcessingService(",
    "with self.assertRaises(ValueError):",
    "service.process(self.request)",
]) {
    assert.ok(includes(text), `mandatory annotation hint is missing: ${text}`);
}
assert.ok(hints.find((hint) => hint.includes("with self.assertRaises"))?.includes("withが管理する範囲"));
assert.ok(hints.find((hint) => hint.includes("self.assertRaises"))?.includes("assertRaisesが検証する条件"));
assert.strictEqual(hints.filter((hint) => hint.includes("self.assertEqual")).length, 1, "each assertXxx kind is hinted once");

for (const token of [
    "Item", "ProcessReport", "ProcessRequest", "ServiceUnavailable",
    "InvalidInput", "ProcessingService",
]) {
    assert.ok(required.some((target) => target.kind === "import" && target.token === token), `required import token missing: ${token}`);
}
for (const text of [
    "store = RecordingStore()",
    "repository = RecordingRepository()",
    "service = ProcessingService(",
]) {
    const line = lines.findIndex((source) => source.includes(text));
    assert.ok(required.some((target) => target.kind === "constructor" && target.line === line), `required constructor missing: ${text}`);
}

const rawCoverage = [];
for (const target of required) {
    if (target.kind === "assert" && required.some((candidate) => candidate.kind === "with" && candidate.line === target.line)) continue;
    if (target.kind === "with") {
        rawCoverage.push({
            kind: "block", startLine: target.line, endLine: target.line + 1,
            startLineText: lines[target.line], endLineText: lines[target.line + 1],
            label: "context manager", explanation: target.description,
        });
    } else {
        rawCoverage.push({
            kind: "symbol", line: target.line, lineText: lines[target.line], token: target.token,
            label: target.description, explanation: target.description,
        });
    }
}
const complete = resolveAnnotations(rawCoverage, code);
assert.deepStrictEqual(missingRequiredAnnotationTargets(code, complete), [], "complete mandatory coverage must pass");
const withoutInvalidInput = complete.filter((annotation) => annotation.anchorToken !== "InvalidInput");
assert.ok(
    missingRequiredAnnotationTargets(code, withoutInvalidInput)
        .some((target) => target.kind === "import" && target.token === "InvalidInput"),
    "a missing imported symbol must be detected after generation",
);

console.log(`annotation target hints: ${hints.length} candidates, ${required.length} required targets, coverage gate passed`);
