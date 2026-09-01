const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const root = path.join(__dirname, "..");
const executable = path.join(root, "bin", "ai-code-guide-mcp.mjs");
const packageVersion = require(path.join(root, "package.json")).version;

function waitForUrl(child) {
    return new Promise((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error(`HTTP server did not start: ${stderr}`)), 10000);
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
            const match = stderr.match(/running at (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`HTTP server exited early (${code}): ${stderr}`));
        });
    });
}

(async () => {
    // AI_NOTE: ChatGPT向けHTTP入口を実プロセスで起動し、stdioとは別の配線とMCP App公開を検証する。
    const child = spawn(process.execPath, [executable, "--workspace", root, "--http", "0"], {
        cwd: root,
        stdio: ["ignore", "ignore", "pipe"],
    });
    let client;
    try {
        const mcpUrl = await waitForUrl(child);
        const health = await fetch(new URL("/", mcpUrl));
        assert.strictEqual(health.status, 200);
        assert.strictEqual(await health.text(), "AI Code Guide MCP server");

        client = new Client({ name: "ai-code-guide-http-test", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
        assert.strictEqual(client.getServerVersion().version, packageVersion);
        const tools = await client.listTools();
        const diagram = tools.tools.find((tool) => tool.name === "create_code_diagram");
        const standard = tools.tools.find((tool) => tool.name === "show_standard_view");
        assert.strictEqual(standard._meta?.ui, undefined);
        assert.strictEqual(standard._meta?.["openai/outputTemplate"], undefined);
        assert.strictEqual(diagram._meta?.ui, undefined);
        assert.strictEqual(diagram._meta?.["openai/outputTemplate"], undefined);

        const standardResource = await client.readResource({ uri: "ui://ai-code-guide/code-locations-v4.html" });
        assert.strictEqual(standardResource.contents[0].mimeType, "text/html;profile=mcp-app");
        assert.ok(standardResource.contents[0].text.includes("ui/notifications/tool-result"));
        const staleStandard = await client.readResource({ uri: "ui://ai-code-guide/standard-view.html" });
        assert.strictEqual(staleStandard.contents[0].uri, "ui://ai-code-guide/standard-view.html");
        assert.strictEqual(staleStandard.contents[0].text, standardResource.contents[0].text);
        await assert.rejects(
            () => client.readResource({ uri: "ui://ai-code-guide/code-diagram-v5.html" }),
            /Resource ui:\/\/ai-code-guide\/code-diagram-v5\.html not found/,
        );
        const advertisedAppUris = [...new Set(tools.tools
            .map((tool) => tool._meta?.ui?.resourceUri)
            .filter((uri) => typeof uri === "string"))];
        assert.ok(advertisedAppUris.includes("ui://ai-code-guide/detail-view-v3.html"));
        for (const uri of advertisedAppUris) {
            const advertisedResource = await client.readResource({ uri });
            assert.strictEqual(advertisedResource.contents[0].uri, uri);
            assert.strictEqual(advertisedResource.contents[0].mimeType, "text/html;profile=mcp-app");
        }
        console.log("2/2 HTTP MCP App transport tests passed");
    } finally {
        if (client) await client.close();
        child.kill("SIGTERM");
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
