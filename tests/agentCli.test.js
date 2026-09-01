const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const cli = path.join(__dirname, "..", "bin", "ai-code-guide.mjs");
let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

function run(args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [cli, ...args], { cwd });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("close", (code) => resolve({
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
        }));
    });
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acg-agent-cli-"));
    const nested = path.join(root, "src", "nested");
    const source = path.join(root, "src", "main.py");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(source, "def main():\n    return 1\n");
    const received = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, "http://127.0.0.1");
        if (url.searchParams.get("token") !== "cli-token") {
            response.writeHead(403).end(JSON.stringify({ ok: false, error: "Forbidden" }));
            return;
        }
        if (url.pathname === "/status") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true, views: ["standard", "overview", "project", "diagram", "inline", "trace"] }));
            return;
        }
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            received.push(body);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true, view: body.view, file: body.file, line: body.line, htmlPath: body.view === "diagram" ? "/tmp/diagram.html" : undefined }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const manifestDir = path.join(root, ".ai-code-guide");
    fs.mkdirSync(manifestDir);
    fs.writeFileSync(path.join(manifestDir, "bridge.json"), JSON.stringify({
        version: 1,
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "cli-token",
        workspaceRoot: root,
    }));
    try {
        const status = await run(["status"], nested);
        assert.strictEqual(status.code, 0);
        assert.strictEqual(JSON.parse(status.stdout).ok, true);
        assert.ok(
            JSON.parse(status.stdout).manifestPath.endsWith(
                path.join(".ai-code-guide", "bridge.json"),
            ),
        );
        ok("子ディレクトリからワークスペースのブリッジを発見してstatusを返す");

        const standard = await run(["show", "standard", "--file", "../main.py", "--line", "2"], nested);
        assert.strictEqual(standard.code, 0, standard.stderr);
        assert.deepStrictEqual(received[0], { view: "standard", file: "src/main.py", line: 2 });
        ok("対象ファイルをワークスペース相対パスへ正規化して表示する");

        const diagram = await run(["show", "diagram", "--question", "mainの流れ"], root);
        assert.strictEqual(diagram.code, 0);
        assert.strictEqual(JSON.parse(diagram.stdout).htmlPath, "/tmp/diagram.html");
        assert.deepStrictEqual(received[1], { view: "diagram", question: "mainの流れ" });
        ok("図の質問と生成HTMLパスを機械可読JSONで受け渡す");

        const trace = await run(["show", "trace", "--file", "src/main.py", "--line", "1", "--run"], root);
        assert.strictEqual(trace.code, 0);
        assert.deepStrictEqual(received[2], { view: "trace", file: "src/main.py", line: 1, run: true });
        ok("明示runを対象行付きでブリッジへ渡す");

        const missingQuestion = await run(["show", "diagram"], root);
        assert.strictEqual(missingQuestion.code, 2);
        assert.strictEqual(JSON.parse(missingQuestion.stderr).ok, false);
        const missingTraceLocation = await run(["show", "trace", "--run"], root);
        assert.strictEqual(missingTraceLocation.code, 2);
        const outside = await run(["show", "inline", "--file", "../outside.py"], root);
        assert.strictEqual(outside.code, 2);
        assert.strictEqual(received.length, 3);
        ok("不足引数とワークスペース外ファイルをHTTP送信前に拒否する");

        const help = await run(["--help"], root);
        assert.strictEqual(help.code, 0);
        assert.ok(help.stdout.includes("show <view>"));
        assert.ok(help.stdout.includes("--run"));
        ok("エージェントが自己発見できるヘルプを返す");
    } finally {
        server.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(`\n${passed}/6 passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
