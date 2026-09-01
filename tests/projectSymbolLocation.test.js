const assert = require("assert");
const { findProjectAnchorLineInLines, findProjectSymbolLineInLines } = require("../out/view/projectSymbolLocation.js");

const lines = [
    "from typing import Protocol",
    "",
    "class Quarantine(Protocol):",
    "    def store(self, request):",
    "        ...",
    "",
    "    def delete(self, quarantine_id):",
    "        ...",
    "",
    "def module_function():",
    "    pass",
    "",
    "class ScannerUnavailable(Exception):",
    "    pass",
];

assert.strictEqual(findProjectSymbolLineInLines(lines, "Quarantine"), 2);
assert.strictEqual(findProjectSymbolLineInLines(lines, "Quarantine.store"), 3);
assert.strictEqual(findProjectSymbolLineInLines(lines, "Quarantine.delete"), 6);
assert.strictEqual(findProjectSymbolLineInLines(lines, "module_function"), 9);
assert.strictEqual(findProjectSymbolLineInLines(lines, "ScannerUnavailable"), 12);
assert.strictEqual(findProjectSymbolLineInLines(lines, "Missing.method"), -1);

console.log("project symbol locations: 6/6 passed");

const branchLines = [
    "def classify_order(total, vip):",
    "    if total >= 200:",
    "        return 'priority'",
    "    if vip and total >= 100:",
    "        return 'preferred'",
    "    return 'regular'",
    "",
    "def other():",
    "    return 'preferred'",
];
assert.strictEqual(findProjectAnchorLineInLines(branchLines, "classify_order", "if total >= 200:"), 1);
assert.strictEqual(findProjectAnchorLineInLines(branchLines, "classify_order", "return 'preferred'"), 4);
assert.strictEqual(findProjectAnchorLineInLines(branchLines, "classify_order", "missing anchor"), 0);
console.log("project anchor locations: 3/3 passed");
