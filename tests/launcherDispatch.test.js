const assert = require("assert");
const { runUniqueInParallel } = require("../out/mcp/launcherDispatch.js");

(async () => {
    const started = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = runUniqueInParallel(["standard", "diagram", "trace", "inline", "trace"], async (view) => {
        started.push(view);
        await gate;
        return `${view}-done`;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(started, ["standard", "diagram", "trace", "inline"], "all unique views must start before any one finishes");
    release();
    assert.deepStrictEqual(await pending, ["standard-done", "diagram-done", "trace-done", "inline-done"], "results keep the user's selected order");
    console.log("launcher dispatch parallelism and order: 2 passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
