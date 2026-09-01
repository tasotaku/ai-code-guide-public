const assert = require("assert");
const { classifyTraceSafety, safetyRetryGuidance } = require("../out/inline/traceContract.js");
const fs = require("fs");
const path = require("path");

const source = [
    "def pure(value):",
    "    return value + 1",
    "",
    "def unsafe_export(path):",
    "    with open(path, 'w') as stream:",
    "        stream.write('x')",
    "",
    "def unknown_dispatch(function_name, value):",
    "    return globals()[function_name](value)",
].join("\n");

assert.strictEqual(classifyTraceSafety(source, "pure", "safe"), "safe");
assert.strictEqual(classifyTraceSafety(source, "unsafe_export", "known-unsafe"), "safe");
assert.strictEqual(classifyTraceSafety(source, "unknown_dispatch", "known-unsafe"), "safety-unknown");
assert.match(safetyRetryGuidance("known-unsafe", "unsafe_export"), /Do not execute unsafe_export/);
assert.match(safetyRetryGuidance("safety-unknown", "unknown_dispatch"), /cannot be proven side-effect-free/);
assert.match(safetyRetryGuidance("safety-unknown", "unknown_dispatch"), /Keep this trace entry open/);
assert.match(safetyRetryGuidance("safety-unknown", "unknown_dispatch"), /preserve this exact rejected target and its arguments/);
assert.match(safetyRetryGuidance("safety-unknown", "unknown_dispatch"), /never silently substitute/);
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
assert.match(extensionSource, /\["entry\/confirm", "processing", result\.error \? "exception" : "success"\]/);

console.log("安全判定3値・明示的実行禁止・same-entry回復案内 6件 passed");
