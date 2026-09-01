const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTrace } = require("../out/inline/traceRunner.js");

const extensionPath = path.resolve(__dirname, "..");

async function trace(workspace, filename, source, funcName) {
    const filePath = path.join(workspace, filename);
    fs.writeFileSync(filePath, source, "utf8");
    return runTrace(extensionPath, {
        source,
        func_name: funcName,
        setup: "EXAMPLE_ARGS = ()",
        templates: {},
        file_path: filePath,
        workspace_root: workspace,
    });
}

(async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acg-trace-test-workspace-"));
    const outside = path.join(os.tmpdir(), `acg-trace-escape-${process.pid}-${Date.now()}.txt`);
    try {
        const localSource = [
            "from pathlib import Path",
            "from tempfile import TemporaryDirectory",
            "",
            "def local_file_flow():",
            "    with TemporaryDirectory() as directory:",
            "        output = Path(directory) / 'result.txt'",
            "        output.write_text('safe result', encoding='utf-8')",
            "        return output.read_text(encoding='utf-8')",
        ].join("\n");
        const local = await trace(workspace, "local_flow.py", localSource, "local_file_flow");
        assert.strictEqual(local.error, null, local.error);
        assert.strictEqual(local.return_value.full, "'safe result'");
        assert.ok(!fs.existsSync(path.join(workspace, "result.txt")), "original workspace must remain unchanged");

        const escapeSource = [
            "from pathlib import Path",
            "",
            "def escape_workspace():",
            `    Path(${JSON.stringify(outside)}).write_text('escaped', encoding='utf-8')`,
        ].join("\n");
        const escape = await trace(workspace, "escape.py", escapeSource, "escape_workspace");
        assert.match(escape.error || "", /trace sandbox blocked file write/);
        assert.ok(!fs.existsSync(outside), "sandbox escape must not create the outside file");

        const networkSource = [
            "import socket",
            "",
            "def open_socket():",
            "    return socket.socket()",
        ].join("\n");
        const network = await trace(workspace, "network.py", networkSource, "open_socket");
        assert.match(network.error || "", /trace sandbox blocked socket\./);

        console.log("trace sandbox: TemporaryDirectory success, outside write/network blocked (3 cases) passed");
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outside, { force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
