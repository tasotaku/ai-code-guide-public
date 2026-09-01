#!/usr/bin/env node
const { spawnSync } = require("child_process");

const candidates = process.platform === "win32"
  ? [["python", []], ["py", ["-3"]], ["python3", []]]
  : [["python3", []], ["python", []]];

for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, "--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) continue;
  const result = spawnSync(
    command,
    [...prefix, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

console.error("Python 3 was not found. Install Python and ensure python, py, or python3 is available.");
process.exit(1);
