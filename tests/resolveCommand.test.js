const assert = require("assert");
const { commandCandidates } = require("../out/util/resolveCommand");

assert.deepStrictEqual(commandCandidates("python3", "win32"), ["python3", "python"]);
assert.deepStrictEqual(commandCandidates("python3", "darwin"), ["python3"]);
assert.deepStrictEqual(commandCandidates("claude", "win32"), ["claude"]);

console.log("resolveCommand tests passed");
