const { spawnSync } = require("child_process");

function findPython() {
    const candidates = process.platform === "win32"
        ? [["python", []], ["py", ["-3"]], ["python3", []]]
        : [["python3", []], ["python", []]];
    for (const [command, args] of candidates) {
        const probe = spawnSync(command, [...args, "--version"], { encoding: "utf8" });
        if (!probe.error && probe.status === 0) return { command, args };
    }
    throw new Error("Python 3 was not found. Install Python and ensure python, py, or python3 is available.");
}

module.exports = { findPython };
