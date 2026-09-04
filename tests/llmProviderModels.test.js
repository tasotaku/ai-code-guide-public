const assert = require("assert");
const Module = require("module");

const values = { useSubscription: true, subscriptionProvider: "codex" };
const fakeVscode = {
    workspace: {
        getConfiguration: () => ({ get: (key, fallback) => key in values ? values[key] : fallback }),
    },
};
const originalLoad = Module._load;
Module._load = (request, parent, isMain) => request === "vscode"
    ? fakeVscode
    : originalLoad.call(Module, request, parent, isMain);

const { CODEX_SUBSCRIPTION_MODEL, effectiveModel, needsWindowsCommandShell } = require("../out/api/llmProvider.js");
assert.strictEqual(CODEX_SUBSCRIPTION_MODEL, "codex:gpt-5.6-sol");
for (const configured of [
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "gpt-5.6-terra",
    "gemini-3.6-flash",
    "cli:opus",
    "codex:default",
    "codex:gpt-5.6-luna",
]) {
    assert.strictEqual(
        effectiveModel(configured),
        "codex:gpt-5.6-sol",
        `Codex subscription must force every AI model slot to Sol: ${configured}`,
    );
}

values.useSubscription = false;
assert.strictEqual(effectiveModel("gpt-5.6-terra"), "gpt-5.6-terra", "API mode must preserve explicit models");
assert.strictEqual(needsWindowsCommandShell("C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd", "win32"), true);
assert.strictEqual(needsWindowsCommandShell("C:\\tools\\codex.BAT", "win32"), true);
assert.strictEqual(needsWindowsCommandShell("C:\\tools\\codex.exe", "win32"), false);
assert.strictEqual(needsWindowsCommandShell("/usr/local/bin/codex.cmd", "linux"), false);

console.log("LLM provider model routing: all subscription slots force codex:gpt-5.6-sol");
