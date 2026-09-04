const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const root = path.join(__dirname, "..");
const packageVersion = require(path.join(root, "package.json")).version;
let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

function writeNodeLauncher(directory, name, source) {
    const script = path.join(directory, `${name}.js`);
    fs.writeFileSync(script, `#!/usr/bin/env node\n${source}`);
    if (process.platform !== "win32") fs.chmodSync(script, 0o700);
    return script;
}

(async () => {
    const launchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acg-mcp-"));
    const workspace = path.join(launchRoot, "examples");
    const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "acg-mcp-cwd-"));
    const registryDir = path.join(launchRoot, "registry");
    const sourceDir = path.join(workspace, "src");
    const sourceFile = path.join(sourceDir, "main.py");
    const targetWorkspace = path.join(launchRoot, "target-project");
    const targetSourceDir = path.join(targetWorkspace, "src");
    const targetSourceFile = path.join(targetSourceDir, "target.py");
    const targetCopyWorkspace = path.join(launchRoot, "copy", "target-project");
    const targetCopySourceFile = path.join(targetCopyWorkspace, "src", "target.py");
    const launchLog = path.join(launchRoot, "vscode-launches.jsonl");
    const diagramPreview = path.join(workspace, "project-diagram-preview.html");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourceFile, "def main():\n    return 1\n");
    fs.mkdirSync(targetSourceDir, { recursive: true });
    fs.writeFileSync(path.join(targetWorkspace, "pyproject.toml"), "[project]\nname = 'target-project'\n");
    fs.writeFileSync(targetSourceFile, "def target():\n    return 2\n");
    fs.mkdirSync(path.dirname(targetCopySourceFile), { recursive: true });
    fs.writeFileSync(path.join(targetCopyWorkspace, "pyproject.toml"), "[project]\nname = 'target-project'\n");
    fs.writeFileSync(targetCopySourceFile, "def target():\n    return 2\n");
    fs.writeFileSync(diagramPreview, "<!doctype html><html><body>MCP_APP_DIAGRAM</body></html>");
    const requests = [];
    let openedViewIds = [];

    const bridge = http.createServer((request, response) => {
        const url = new URL(request.url, "http://127.0.0.1");
        if (/^\/view\/[a-f0-9]{48}$/.test(url.pathname)) {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end("<!doctype html><html><body><h1>AI Code Guide test result</h1></body></html>");
            return;
        }
        if (url.searchParams.get("token") !== "mcp-token") {
            response.writeHead(403).end(JSON.stringify({ error: "Forbidden" }));
            return;
        }
        if (url.pathname === "/status") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true, views: ["standard", "overview", "project", "diagram", "inline", "trace"], openedViews: openedViewIds.map((id) => ({ id, openedAt: new Date().toISOString() })) }));
            return;
        }
        if (url.pathname === "/prepare") {
            const chunks = [];
            request.on("data", (chunk) => chunks.push(chunk));
            request.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                requests.push(body);
                assert.deepStrictEqual(body.additions, ["diagram"]);
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({
                    ok: true,
                    view: "combined",
                    file: "src/main.py",
                    codexView: {
                        type: "browser",
                        view: "combined",
                        url: `http://127.0.0.1:${address.port}/view/999999999999999999999999999999999999999999999999`,
                    },
                }));
            });
            return;
        }
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requests.push(body);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({
                ok: true,
                view: body.view,
                file: body.file,
                line: body.line,
                ...(body.view === "standard" ? {
                    standard: {
                        title: body.file === "src/target.py" ? "target.py" : "main.py",
                        file: body.file,
                        role: "固定値を返すサンプル。",
                        source: [{ line: 1, text: "class Runner:" }, { line: 2, text: "    return 1" }],
                        items: [
                            { id: "class_1", kind: "class", label: "class Runner", line: 1, lineEnd: 2, color: "#4fc1ff" },
                            {
                                id: "func_2", kind: "function", label: "main()", line: 2, lineEnd: 2,
                                parent: "class_1", color: "#4fc1ff", description: "固定値1を返す。",
                                meaningRanges: [{ lineStart: 2, lineEnd: 2 }],
                                ...(body.expandLines ? {
                                    expanded: true,
                                    expansion: {
                                        overview: { purpose: "固定値を返す。", input: "入力なし。", output: "1を返す。" },
                                        blocks: [{ label: "値を返す", lineStart: 2, lineEnd: 2, description: "1を返す。" }],
                                    },
                                } : {}),
                            },
                        ],
                    },
                    codexView: {
                        type: "browser",
                        view: "standard",
                        url: `http://127.0.0.1:${address.port}/view/abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef`,
                    },
                } : {}),
                ...(body.view === "diagram" ? {
                    htmlPath: diagramPreview,
                    question: body.question,
                    diagram: {
                        kind: "flow",
                        title: "mainの処理順",
                        summary: "mainが値を返す。",
                        nodes: [
                            { id: "normalize-raw", label: "rawを検査", description: "rawを検査する。", file: "src/main.py", symbol: "require_nonnegative(raw)", line: 12 },
                            { id: "normalize-max", label: "maxを検査", description: "maxを検査する。", file: "src/main.py", symbol: "require_nonnegative(max_score)", line: 13 },
                            { id: "normalize-if", label: "0上限を判定", description: "limitが0か判定する。", file: "src/main.py", symbol: "if limit == 0", line: 14 },
                            { id: "normalize-return", label: "正規化値を返す", description: "正規化値を返す。", file: "src/main.py", symbol: "return", line: 16 },
                            { id: "classify-vip", label: "VIPを判定", description: "vipの場合を判定する。", file: "src/main.py", symbol: "if vip", line: 21 },
                            { id: "classify-vip-return", label: "VIP分類を返す", description: "VIP分類を返す。", file: "src/main.py", symbol: "return", line: 22 },
                            { id: "classify-total", label: "合計を判定", description: "totalが基準以上か判定する。", file: "src/main.py", symbol: "if total >= 80", line: 23 },
                            { id: "classify-preferred-return", label: "preferredを返す", description: "preferredを返す。", file: "src/main.py", symbol: "return", line: 24 },
                            { id: "classify-return", label: "分類を返す", description: "分類結果を返す。", file: "src/main.py", symbol: "return", line: 25 },
                        ],
                        edges: [],
                    },
                    codexView: {
                        type: "browser",
                        view: "diagram",
                        url: `http://127.0.0.1:${address.port}/view/13579bdf13579bdf13579bdf13579bdf13579bdf13579bdf`,
                    },
                } : {}),
                ...(body.view === "overview" ? {
                    overview: { title: "main.py", file: "src/main.py", kind: "definitions", role: "固定値を返す。", relationships: [], readingOrder: [], groups: [] },
                } : {}),
                ...(body.view === "project" ? {
                    project: {
                        files: [{ id: "f1", path: "src/main.py", directory: "src", functions: ["main"] }],
                        imports: [], directories: [{ path: "src" }],
                    },
                } : {}),
                ...(body.view === "inline" ? {
                    annotations: {
                        items: [{ id: "a1", kind: "symbol", severity: "info", label: "固定値", explanation: "固定値を返す。", startLine: 2, endLine: 2 }],
                    },
                    codexView: {
                        type: "browser",
                        view: "inline",
                        url: `http://127.0.0.1:${address.port}/view/fedcba9876543210fedcba9876543210fedcba9876543210`,
                    },
                } : {}),
                ...(body.view === "trace" ? {
                    trace: {
                        funcNames: body.run ? (body.functions || ["main"]) : [], loopCount: 0,
                        ...(body.run ? {
                            traceEntryId: body.traceEntryId || "entry-public-continuation",
                            entryState: body.arguments?.value === 7 || body.functions?.includes("normalize_score") || body.functions?.includes("main") ? "closed" : "open",
                            attempts: body.functions?.some((name) => ["unsafe_export", "unknown_dispatch", "require_nonnegative"].includes(name)) ? [{ states: [body.arguments?.value === -1 ? "exception" : "rejected"] }] : [],
                        } : {}),
                    },
                    ...(body.functions?.includes("without_url") ? {} : { codexView: {
                        type: "browser",
                        view: "trace",
                        url: `http://127.0.0.1:${address.port}/view/0123456789abcdef0123456789abcdef0123456789abcdef`,
                    } }),
                } : {}),
            }));
        });
    });

    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const address = bridge.address();
    const runtimeDir = path.join(workspace, ".ai-code-guide");
    fs.mkdirSync(runtimeDir);
    const manifest = {
        version: 1,
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "mcp-token",
        workspaceRoot: workspace,
    };
    fs.writeFileSync(path.join(runtimeDir, "bridge.json"), JSON.stringify(manifest));
    fs.mkdirSync(registryDir);
    fs.writeFileSync(path.join(registryDir, "workspace.json"), JSON.stringify(manifest));
    const launcher = writeNodeLauncher(launchRoot, "open-target-workspace", `
const fs = require("fs");
const path = require("path");
const workspaceRoot = process.argv[2];
fs.appendFileSync(process.env.ACG_LAUNCH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const runtime = path.join(workspaceRoot, ".ai-code-guide");
fs.mkdirSync(runtime, { recursive: true });
fs.writeFileSync(path.join(runtime, "activation.json"), JSON.stringify({ version: 1, workspaceRoot, pid: process.pid }));
setTimeout(() => fs.writeFileSync(path.join(process.env.AI_CODE_GUIDE_REGISTRY_DIR, Buffer.from(workspaceRoot).toString("hex") + ".json"), JSON.stringify({
  version: 1, baseUrl: process.env.ACG_TARGET_BASE_URL, token: "mcp-token", workspaceRoot,
})), 120);
`);

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, "bin", "ai-code-guide-mcp.mjs"), "--workspace", unrelatedCwd],
        env: {
            ...process.env,
            AI_CODE_GUIDE_REGISTRY_DIR: registryDir,
            AI_CODE_GUIDE_CODE_COMMAND: launcher,
            ACG_TARGET_BASE_URL: `http://127.0.0.1:${address.port}`,
            ACG_LAUNCH_LOG: launchLog,
        },
        stderr: "pipe",
    });
    const client = new Client({ name: "ai-code-guide-test", version: "1.0.0" });

    try {
        await client.connect(transport);
        assert.strictEqual(client.getServerVersion().version, packageVersion);
        ok("MCPサーバー版を拡張版と同期してリソースキャッシュを更新する");
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name);
        assert.deepStrictEqual(names, [
            "show_ai_code_guide_launcher",
            "dispatch_ai_code_guide_request",
            "read_ai_code_guide_result_document",
            "get_ai_code_guide_status",
            "show_standard_view",
            "expand_standard_items",
            "show_file_overview",
            "generate_file_overview",
            "show_project_structure",
            "generate_project_explanations",
            "create_code_diagram",
            "show_inline_annotations",
            "generate_inline_annotations",
            "revise_inline_annotations",
            "show_saved_trace",
            "run_trace",
        ]);
        assert.ok(listed.tools.every((tool) => tool.title && tool.description && tool.inputSchema));
        const diagramTool = listed.tools.find((tool) => tool.name === "create_code_diagram");
        const launcherTool = listed.tools.find((tool) => tool.name === "show_ai_code_guide_launcher");
        const launcherDispatchTool = listed.tools.find((tool) => tool.name === "dispatch_ai_code_guide_request");
        const standardTool = listed.tools.find((tool) => tool.name === "show_standard_view");
        const overviewTool = listed.tools.find((tool) => tool.name === "show_file_overview");
        const projectTool = listed.tools.find((tool) => tool.name === "show_project_structure");
        const inlineTool = listed.tools.find((tool) => tool.name === "show_inline_annotations");
        const reviseInlineTool = listed.tools.find((tool) => tool.name === "revise_inline_annotations");
        const traceTool = listed.tools.find((tool) => tool.name === "show_saved_trace");
        const runTraceTool = listed.tools.find((tool) => tool.name === "run_trace");
        assert.match(runTraceTool.description, /never silently substitute a safer target/);
        assert.match(runTraceTool.description, /normal request to see or use an execution trace counts as an explicit request/);
        assert.match(traceTool.description, /only when the user explicitly asks for a saved, cached, or existing execution trace/);
        assert.match(traceTool.description, /continue with run_trace in the same turn/);
        assert.match(inlineTool.description, /only when the user explicitly asks for saved, cached, or existing inline explanations/);
        const generateInlineTool = listed.tools.find((tool) => tool.name === "generate_inline_annotations");
        assert.match(generateInlineTool.description, /normal request to see or use inline explanations counts as a request to generate/);
        assert.strictEqual(launcherTool._meta.ui.resourceUri, "ui://ai-code-guide/launcher-v16.html");
        assert.strictEqual(launcherTool._meta["openai/outputTemplate"], "ui://ai-code-guide/launcher-v16.html");
        assert.deepStrictEqual(Object.keys(launcherTool.inputSchema.properties), []);
        assert.match(launcherTool.description, /conversation MCP App card/);
        assert.match(launcherTool.description, /understanding goal/);
        assert.match(launcherTool.description, /\$ai-code-guide-request/);
        assert.ok(!launcherTool.description.includes("for `/ai-code-guide`"), "the old product-name command must not trigger the launcher");
        assert.strictEqual(launcherDispatchTool._meta["openai/widgetAccessible"], true);
        assert.deepStrictEqual(launcherDispatchTool.inputSchema.required, ["target", "question", "views"]);
        assert.ok(!(runTraceTool.inputSchema.required || []).includes("file"), "built MCP schema must not require file for a retry");
        for (const field of ["file", "line", "functions"]) {
            const published = JSON.stringify(runTraceTool.inputSchema.properties[field]);
            assert.ok(published.includes('"type":"null"'), `built MCP tools/list schema must publish null for ${field}: ${published}`);
        }
        const serverSource = fs.readFileSync(path.join(root, "src", "mcp", "server.ts"), "utf8");
        assert.ok(!serverSource.includes("entire request is `/ai-code-guide`,"), "server instructions must not route the old product-name command to the launcher");
        assert.match(serverSource, /including an unknown dynamic target such as mystery/);
        assert.match(serverSource, /The standard view is never a prerequisite or discovery step for trace/);
        assert.match(serverSource, /Resolve files, functions, classes, and methods for those requests with ordinary file reading or search/);
        assert.match(serverSource, /normal request to see or use an execution trace is an explicit request for runtime evidence/);
        assert.match(serverSource, /normal request to see or use inline explanations is an explicit request to generate them/);
        assert.ok(!standardTool.inputSchema.properties.notes);
        assert.strictEqual(standardTool.title, "Show code locations");
        assert.match(standardTool.description, /wide browser Webview instead of an inline MCP App card/);
        assert.ok(standardTool.description.includes("[標準ビューを開く](<codexView.url>)"));
        const expandStandardTool = listed.tools.find((tool) => tool.name === "expand_standard_items");
        assert.strictEqual(expandStandardTool.title, "Expand selected reading blocks");
        assert.match(expandStandardTool.description, /current Codex standard Webview/);
        assert.ok(expandStandardTool.inputSchema.properties.scopeLine);
        assert.ok(expandStandardTool.inputSchema.properties.replaceExpanded);
        assert.strictEqual(standardTool._meta?.ui, undefined, "standard calls must not attach an inline MCP App card");
        assert.strictEqual(standardTool._meta?.["openai/outputTemplate"], undefined, "standard calls must not attach an OpenAI output template");
        assert.strictEqual(diagramTool._meta?.ui, undefined, "diagram calls must use the wide browser Webview instead of an inline MCP App card");
        assert.strictEqual(diagramTool._meta?.["openai/outputTemplate"], undefined);
        assert.match(diagramTool.description, /same wide HTML Webview/);
        assert.match(diagramTool.description, /without attaching an MCP App card/);
        for (const tool of [overviewTool, projectTool]) {
            assert.strictEqual(tool._meta.ui.resourceUri, "ui://ai-code-guide/detail-view-v3.html");
            assert.strictEqual(tool._meta["openai/outputTemplate"], "ui://ai-code-guide/detail-view-v3.html");
        }
        assert.strictEqual(inlineTool._meta?.ui, undefined, "inline calls must not attach an inline MCP App card");
        assert.strictEqual(inlineTool._meta?.["openai/outputTemplate"], undefined, "inline calls must not attach an OpenAI output template");
        assert.match(inlineTool.description, /without .*attaching a narrow inline MCP App card/);
        assert.ok(inlineTool.description.includes("wide Codex browser URL"));
        assert.ok(inlineTool.description.includes("[解説を開く](<codexView.url>)"));
        assert.ok(reviseInlineTool.description.includes("removeAnnotationIds"));
        assert.ok(reviseInlineTool.description.includes("hideAnnotationIds"));
        assert.ok(reviseInlineTool.description.includes("rolled back"));
        for (const tool of [traceTool, runTraceTool]) {
            assert.strictEqual(tool._meta?.ui, undefined, "new trace calls must not attach an inline MCP App card");
            assert.strictEqual(tool._meta?.["openai/outputTemplate"], undefined, "new trace calls must not attach an OpenAI output template");
            assert.ok(tool.description.includes("without attaching a narrow inline MCP App card"));
            assert.ok(tool.description.includes("same turn's final answer MUST"));
            assert.ok(tool.description.includes("[トレースを開く](<codexView.url>)"));
            assert.ok(tool.description.includes("VS Code view is separate"));
        }
        ok("初期化して16個の説明・スキーマ付きツールを公開する");

        const launcher = await client.callTool({
            name: "show_ai_code_guide_launcher",
            arguments: {},
        });
        assert.strictEqual(launcher.isError, undefined);
        assert.deepStrictEqual(launcher.structuredContent.launcher, {});
        assert.strictEqual(launcher.structuredContent.codexView, undefined);
        assert.strictEqual(launcher.content.some((item) => item.type === "resource_link"), false);
        assert.strictEqual(launcher._meta?.launcher, undefined);
        const dispatched = await client.callTool({
            name: "dispatch_ai_code_guide_request",
            arguments: {
                target: "src/main.py · main()",
                question: "main() は何をする関数？",
                views: ["コード図"],
            },
        });
        assert.notStrictEqual(dispatched.isError, true, JSON.stringify(dispatched.content));
        assert.strictEqual(dispatched.structuredContent.dispatch.target, "src/main.py");
        assert.deepStrictEqual(
            dispatched.structuredContent.dispatch.items.map((item) => [item.label, item.status, Boolean(item.url)]),
            [["標準ビュー", "preparing", false], ["インライン解説", "preparing", false], ["コード図", "preparing", false]],
        );
        assert.strictEqual(dispatched.structuredContent.view, "combined");
        assert.strictEqual(dispatched.structuredContent.codexView.view, "combined");
        assert.ok(!requests.some((request) => request.view === "standard"
            && Array.isArray(request.expandLines)), "Standard details stay collapsed until the person presses a triangle");
        const combinedLink = dispatched.content.find((item) => item.type === "resource_link");
        assert.strictEqual(combinedLink?.title, "AI Code Guideを開く");
        assert.strictEqual(combinedLink?.uri, dispatched.structuredContent.codexView.url);
        const firstResultUrl = dispatched.structuredContent.codexView.url;
        const resultDocument = await client.callTool({
            name: "read_ai_code_guide_result_document",
            arguments: { url: firstResultUrl },
        });
        assert.match(resultDocument.structuredContent.document.html, /AI Code Guide test result/);
        assert.match(resultDocument.structuredContent.document.viewId, /^[a-f0-9]{48}$/);

        const status = await client.callTool({ name: "get_ai_code_guide_status", arguments: {} });
        assert.strictEqual(status.structuredContent.ok, true);
        assert.strictEqual(status.structuredContent.workspaceRoot, workspace);
        ok("起動ディレクトリと無関係でもユーザー領域registryからVS Codeブリッジを発見する");

        const calls = [
            ["show_standard_view", { file: "examples/src/main.py", line: 2 }],
            ["expand_standard_items", { file: "src/main.py", lines: [2] }],
            ["show_file_overview", { file: sourceFile }],
            ["generate_file_overview", { file: sourceFile }],
            ["show_project_structure", {}],
            ["generate_project_explanations", {}],
            ["create_code_diagram", { question: "mainの処理順", file: sourceFile }],
            ["show_inline_annotations", { file: "src/main.py" }],
            ["generate_inline_annotations", { file: "src/main.py", startLine: 1, endLine: 2 }],
            ["revise_inline_annotations", { file: "src/main.py", removeAnnotationIds: ["a1"], startLine: 2, endLine: 2 }],
            ["show_saved_trace", { file: "src/main.py", line: 1 }],
            ["run_trace", { file: "src/main.py", functions: ["main"], arguments: { value: -1 } }],
        ];
        for (const [name, args] of calls) {
            const result = await client.callTool({ name, arguments: args });
            assert.notStrictEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
            assert.strictEqual(result.structuredContent.ok, true);
            if (name === "show_standard_view" || name === "expand_standard_items") {
                assert.strictEqual(result.structuredContent.standard.items.length, 2);
                assert.ok(result.content[0].text.includes("メソッド: main()"));
                assert.strictEqual(result._meta.standardWorkspaceRoot, workspace);
                assert.strictEqual(result.structuredContent.codexView.type, "browser");
                assert.strictEqual(result.structuredContent.codexView.view, "standard");
                const link = result.content.find((item) => item.type === "resource_link");
                assert.strictEqual(link?.uri, result.structuredContent.codexView.url);
                assert.strictEqual(link?.name, "ai-code-guide-standard");
                assert.strictEqual(link?.title, "標準ビューを開く");
            }
            if (name === "show_standard_view") assert.ok(!result.content[0].text.includes("固定値1を返す。"));
            if (name === "expand_standard_items") {
                assert.strictEqual(result.structuredContent.standard.items[1].expansion.overview.purpose, "固定値を返す。");
                assert.strictEqual(result.structuredContent.standard.items[1].expansion.blocks[0].lineStart, 2);
            }
            if (name === "create_code_diagram") {
                assert.strictEqual(result.structuredContent.htmlPath, undefined);
                assert.strictEqual(result.structuredContent.diagram.title, "mainの処理順");
                assert.strictEqual(result.structuredContent.codexView.type, "browser");
                assert.strictEqual(result.structuredContent.codexView.view, "diagram");
                assert.strictEqual(
                    result.content.find((item) => item.type === "resource_link"),
                    undefined,
                    "diagram results must not attach a resource card",
                );
                assert.ok(result.content[0].text.includes(result.structuredContent.codexView.url));
                assert.deepStrictEqual(
                    result.structuredContent.diagram.nodes.map((node) => [node.id, node.line]),
                    [["normalize-raw", 13], ["normalize-max", 14], ["normalize-if", 15], ["normalize-return", 17], ["classify-vip", 22], ["classify-vip-return", 23], ["classify-total", 24], ["classify-preferred-return", 25], ["classify-return", 26]],
                    "public diagram lines must be one-based source anchors",
                );
                assert.ok(result.content[0].text.includes("rawを検査する。"));
                assert.strictEqual(result._meta.diagramWorkspaceRoot, workspace);
            }
            if (name === "show_inline_annotations" || name === "generate_inline_annotations" || name === "revise_inline_annotations") {
                assert.strictEqual(result.structuredContent.codexView.type, "browser");
                assert.strictEqual(result.structuredContent.codexView.view, "inline");
                const link = result.content.find((item) => item.type === "resource_link");
                assert.strictEqual(link?.uri, result.structuredContent.codexView.url);
                assert.strictEqual(link?.name, "ai-code-guide-inline");
                assert.strictEqual(link?.title, "インライン解説を大きく表示");
            }
            if (name === "show_saved_trace" || name === "run_trace") {
                assert.strictEqual(result.structuredContent.codexView.type, "browser");
                assert.strictEqual(result.structuredContent.codexView.view, "trace");
                const expectedLink = `[トレースを開く](<${result.structuredContent.codexView.url}>)`;
                assert.ok(result.content[0].text.includes(expectedLink), `${name} must return a final-answer-ready Markdown link`);
                assert.ok(result.content[0].text.includes("VS Code側の表示とは別"));
                assert.strictEqual(result.structuredContent.responseGuidance.mustIncludeTraceLink, true);
                assert.strictEqual(result.structuredContent.responseGuidance.openInCodexBrowserWhenAvailable, true);
                assert.strictEqual(result.structuredContent.responseGuidance.vscodeViewIsSeparate, true);
                assert.ok(result.structuredContent.responseGuidance.finalAnswer.includes(expectedLink));
                assert.ok(result.structuredContent.responseGuidance.finalAnswer.includes("src/main.py"));
                assert.ok(result.structuredContent.responseGuidance.finalAnswer.includes(name === "run_trace" ? "main()" : "1行目"));
                const link = result.content.find((item) => item.type === "resource_link");
                assert.strictEqual(link?.uri, result.structuredContent.codexView.url);
                assert.strictEqual(link?.title, "実行トレースを大きく表示");
            }
        }
        for (const name of ["show_saved_trace", "run_trace"]) {
            const result = await client.callTool({ name, arguments: { file: "src/main.py", functions: ["without_url"] } });
            assert.notStrictEqual(result.isError, true);
            assert.strictEqual(result.structuredContent.codexView, undefined);
            assert.strictEqual(result.structuredContent.responseGuidance.mustIncludeTraceLink, false);
            assert.strictEqual(result.structuredContent.responseGuidance.openInCodexBrowserWhenAvailable, false);
            assert.ok(result.content[0].text.includes("ブラウザ用URLは返されませんでした"));
            assert.ok(result.content[0].text.includes("VS CodeのAI Code Guide「トレース」表示で確認"));
            assert.strictEqual(result.content.some((item) => item.type === "resource_link"), false);
        }
        ok("トレースURLがない場合だけVS Code表示を代替案内する");
        const standardResource = await client.readResource({ uri: "ui://ai-code-guide/code-locations-v4.html" });
        assert.strictEqual(standardResource.contents[0].mimeType, "text/html;profile=mcp-app");
        assert.ok(standardResource.contents[0].text.includes("VS Codeで標準ビューを開く"));
        assert.ok(standardResource.contents[0].text.includes("関数・メソッド"));
        assert.ok(standardResource.contents[0].text.includes('name: "show_standard_view"'));
        assert.ok(standardResource.contents[0].text.includes('name: "expand_standard_items"'));
        assert.ok(standardResource.contents[0].text.includes("詳しく読む"));
        assert.ok(standardResource.contents[0].text.includes("目的・入出力・処理ブロック"));
        assert.ok(standardResource.contents[0].text.includes("standardWorkspaceRoot"));
        assert.ok(standardResource.contents[0].text.includes("focusWindow: true"));
        assert.ok(standardResource.contents[0].text.includes("entry.parent ? \" child\""));
        assert.ok(!standardResource.contents[0].text.includes("standard.absoluteFile"));
        const legacyStandard = await client.readResource({ uri: "ui://ai-code-guide/standard-view.html" });
        assert.strictEqual(legacyStandard.contents[0].text, standardResource.contents[0].text);
        const previousStandard = await client.readResource({ uri: "ui://ai-code-guide/code-locations-v2.html" });
        assert.strictEqual(previousStandard.contents[0].text, standardResource.contents[0].text);
        ok("会話内でコードと選択した読解ガイドを対応表示し、VS Codeへの移動も維持する");
        const resourceUris = (await client.listResources()).resources.map((resource) => resource.uri);
        assert.ok(resourceUris.includes("ui://ai-code-guide/launcher-v16.html"));
        assert.ok(!resourceUris.some((uri) => uri.includes("code-diagram")));
        for (const uri of [
            "ui://ai-code-guide/code-diagram-v5.html",
            "ui://ai-code-guide/code-diagram-v3.html",
            "ui://ai-code-guide/code-diagram.html",
        ]) {
            await assert.rejects(client.readResource({ uri }), /Resource .* not found/);
        }
        ok("コード図のMCP Appリソースを公開せず広いWebviewだけを返す");
        const detailResource = await client.readResource({ uri: "ui://ai-code-guide/detail-view-v3.html" });
        assert.strictEqual(detailResource.contents[0].mimeType, "text/html;profile=mcp-app");
        assert.ok(detailResource.contents[0].text.includes("import 関係"));
        const launcherResource = await client.readResource({ uri: "ui://ai-code-guide/launcher-v16.html" });
        assert.strictEqual(launcherResource.contents[0].mimeType, "text/html;profile=mcp-app");
        assert.ok(launcherResource.contents[0].text.includes("コードの何を見たいですか？"));
        assert.ok(!launcherResource.contents[0].text.includes('request("tools/call"'));
        assert.ok(!launcherResource.contents[0].text.includes("dispatch_ai_code_guide_request"));
        assert.ok(launcherResource.contents[0].text.includes('request("ui/message"'));
        assert.ok(!launcherResource.contents[0].text.includes("sendFollowUpMessage"));
        const evidenceResource = await client.readResource({ uri: "ui://ai-code-guide/code-evidence-v10.html" });
        assert.strictEqual(evidenceResource.contents[0].mimeType, "text/html;profile=mcp-app");
        assert.ok(evidenceResource.contents[0].text.includes("token-keyword"));
        assert.ok(evidenceResource.contents[0].text.includes("周目 / 全"));
        assert.ok(evidenceResource.contents[0].text.includes("横に広げる"));
        for (const uri of [
            "ui://ai-code-guide/code-evidence-v9.html",
            "ui://ai-code-guide/code-evidence-v7.html",
            "ui://ai-code-guide/code-evidence-v6.html",
            "ui://ai-code-guide/code-evidence-v2.html",
            "ui://ai-code-guide/code-evidence-v3.html",
            "ui://ai-code-guide/code-evidence-v4.html",
            "ui://ai-code-guide/code-evidence.html",
        ]) {
            const legacyResource = await client.readResource({ uri });
            assert.strictEqual(legacyResource.contents[0].uri, uri);
            assert.strictEqual(legacyResource.contents[0].text, evidenceResource.contents[0].text);
        }
        ok("概要・構成は会話内App、図・インライン・トレースは広いブラウザ表示で返す");
        const canonical = (values) => values.map((value) => JSON.stringify(value)).sort();
        assert.deepStrictEqual(requests[0], { file: "src/main.py", question: "main() は何をする関数？", additions: ["diagram"], functions: ["main"] }, "launcher delegates generation lifetime to bridge without awaiting LLM results");
        assert.deepStrictEqual(requests.slice(1), [
            { view: "standard", file: "src/main.py", line: 2, backgroundAction: "generate" },
            { view: "standard", file: "src/main.py", expandLines: [2] },
            { view: "overview", file: "src/main.py" },
            { view: "overview", file: "src/main.py", run: true },
            { view: "project" },
            { view: "project", run: true },
            { view: "diagram", question: "mainの処理順", file: "src/main.py", run: true },
            { view: "inline", file: "src/main.py" },
            { view: "inline", file: "src/main.py", run: true, startLine: 1, endLine: 2 },
            { view: "inline", file: "src/main.py", removeAnnotationIds: ["a1"], startLine: 2, endLine: 2, run: true },
            { view: "trace", file: "src/main.py", line: 1 },
            { view: "trace", file: "src/main.py", run: true, functions: ["main"], arguments: { value: -1 } },
            { view: "trace", file: "src/main.py", functions: ["without_url"] },
            { view: "trace", file: "src/main.py", run: true, functions: ["without_url"] },
        ].map((request) => ["standard", "diagram", "inline", "trace"].includes(request.view)
            ? { ...request, activate: false }
            : request));
        assert.strictEqual(requests.slice(0, 1).filter((request) => request.view === "standard" && Array.isArray(request.expandLines)).length, 0);
        ok("12個の表示・生成・実行ツールを既存ブリッジへ正しく対応付ける");

        const focusedJump = await client.callTool({
            name: "show_standard_view",
            arguments: { file: "src/main.py", line: 1, focusWindow: true },
        });
        assert.notStrictEqual(focusedJump.isError, true);
        assert.deepStrictEqual(requests.at(-1), {
            view: "standard", file: "src/main.py", line: 1, focusWindow: true, activate: true, backgroundAction: "generate",
        });
        requests.pop();
        ok("会話内図の明示クリックだけ前面化フラグをVS Codeへ渡す");
        // AI_NOTE: 保存済みだけの明示要求は生成を許可しない。
        const cachedStandard = await client.callTool({ name: "show_standard_view", arguments: { file: "src/main.py", savedOnly: true } });
        assert.notStrictEqual(cachedStandard.isError, true);
        assert.deepStrictEqual(requests.at(-1), { view: "standard", file: "src/main.py", backgroundAction: "read", activate: false });
        requests.pop();

        const focusedExpansion = await client.callTool({
            name: "expand_standard_items",
            arguments: { file: "src/main.py", lines: [2], line: 2, scopeLine: 1, replaceExpanded: true, focusWindow: true },
        });
        assert.notStrictEqual(focusedExpansion.isError, true);
        assert.deepStrictEqual(requests.at(-1), {
            view: "standard", file: "src/main.py", expandLines: [2], line: 2,
            scopeLine: 1, visibleExpandLines: [2], focusWindow: true, activate: true,
        });
        const expansionTool = (await client.listTools()).tools.find((tool) => tool.name === "expand_standard_items");
        assert.ok(!expansionTool._meta.ui, "会話内の既存ビューを待たせる表示テンプレートを返さない");
        ok("会話内の展開は対象行への移動を同時に依頼し、二重の表示初期化を起こさない");

        const nestedWorkspace = path.join(workspace, "packages", "nested");
        const nestedSource = path.join(nestedWorkspace, "nested.py");
        fs.mkdirSync(nestedWorkspace, { recursive: true });
        fs.writeFileSync(nestedSource, "def nested():\n    return 3\n");
        const nestedRequests = [];
        const nestedBridge = http.createServer((request, response) => {
            const url = new URL(request.url, "http://127.0.0.1");
            if (url.pathname === "/status") {
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ ok: true, workspaceRoot: nestedWorkspace }));
                return;
            }
            const chunks = [];
            request.on("data", (chunk) => chunks.push(chunk));
            request.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                nestedRequests.push(body);
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({
                    ok: true,
                    view: body.view,
                    file: body.file,
                    standard: { title: "nested.py", file: body.file, role: "nested", source: [], items: [] },
                }));
            });
        });
        await new Promise((resolve) => nestedBridge.listen(0, "127.0.0.1", resolve));
        const nestedAddress = nestedBridge.address();
        const nestedRegistry = path.join(registryDir, "nested.json");
        fs.writeFileSync(nestedRegistry, JSON.stringify({
            version: 1,
            baseUrl: `http://127.0.0.1:${nestedAddress.port}`,
            token: "mcp-token",
            workspaceRoot: nestedWorkspace,
        }));
        const parentRequestCount = requests.length;
        try {
            const nestedResult = await client.callTool({ name: "show_standard_view", arguments: { file: nestedSource } });
            assert.notStrictEqual(nestedResult.isError, true, JSON.stringify(nestedResult.content));
            assert.strictEqual(nestedResult.structuredContent.standard.title, "nested.py");
            assert.deepStrictEqual(nestedRequests, [{ view: "standard", file: "nested.py", activate: false, backgroundAction: "generate" }]);
            assert.strictEqual(requests.length, parentRequestCount);
            ok("親repoと子workspaceの両方が対象を含む時は最も具体的なbridgeを選ぶ");
        } finally {
            nestedBridge.close();
            fs.rmSync(nestedRegistry, { force: true });
        }

        const wrongRequests = [];
        const wrongBridge = http.createServer((request, response) => {
            const url = new URL(request.url, "http://127.0.0.1");
            if (url.pathname === "/show") wrongRequests.push(url.pathname);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true, views: ["diagram"] }));
        });
        await new Promise((resolve) => wrongBridge.listen(0, "127.0.0.1", resolve));
        const wrongAddress = wrongBridge.address();
        const localRuntime = path.join(unrelatedCwd, ".ai-code-guide");
        fs.mkdirSync(localRuntime);
        fs.writeFileSync(path.join(localRuntime, "bridge.json"), JSON.stringify({
            version: 1,
            baseUrl: `http://127.0.0.1:${wrongAddress.port}`,
            token: "wrong-workspace",
            workspaceRoot: unrelatedCwd,
        }));
        try {
            const selected = await client.callTool({
                name: "create_code_diagram",
                arguments: { question: "mainの処理順", file: sourceFile },
            });
            assert.notStrictEqual(selected.isError, true);
            assert.strictEqual(wrongRequests.length, 0);
            assert.deepStrictEqual(requests.at(-1), {
                view: "diagram", question: "mainの処理順", file: "src/main.py", run: true, activate: false,
            });
            requests.pop();
            ok("入口ファイルを含まないローカルbridgeより対象workspaceのbridgeを優先する");
        } finally {
            wrongBridge.close();
            fs.rmSync(localRuntime, { recursive: true, force: true });
        }

        const openedTarget = await client.callTool({ name: "show_standard_view", arguments: { file: targetSourceFile } });
        assert.notStrictEqual(openedTarget.isError, true, JSON.stringify(openedTarget.content));
        assert.strictEqual(openedTarget.structuredContent.standard.title, "target.py");
        assert.deepStrictEqual(requests.at(-1), { view: "standard", file: "src/target.py", activate: false, backgroundAction: "generate" });
        requests.pop();
        assert.deepStrictEqual(fs.readFileSync(launchLog, "utf8").trim().split("\n").map(JSON.parse), [[fs.realpathSync.native(targetWorkspace)]]);
        assert.ok(fs.existsSync(path.join(targetWorkspace, ".ai-code-guide", "activation.json")));
        ok("無関係な接続へ送らず、対象workspaceを開いて拡張起動後のbridgeへ要求を再開する");

        const launchCount = fs.readFileSync(launchLog, "utf8").trim().split("\n").length;
        const reusedTarget = await client.callTool({ name: "show_standard_view", arguments: { file: targetSourceFile } });
        assert.notStrictEqual(reusedTarget.isError, true);
        assert.strictEqual(fs.readFileSync(launchLog, "utf8").trim().split("\n").length, launchCount);
        requests.pop();
        ok("対象workspaceの応答済み接続を再利用し、VS Codeを再起動しない");

        const copiedTarget = await client.callTool({
            name: "create_code_diagram",
            arguments: { question: "targetの処理順", file: targetCopySourceFile, activate: false },
        });
        assert.notStrictEqual(copiedTarget.isError, true, JSON.stringify(copiedTarget.content));
        assert.strictEqual(copiedTarget._meta.diagramWorkspaceRoot, fs.realpathSync.native(targetCopyWorkspace));
        assert.deepStrictEqual(requests.at(-1), {
            view: "diagram", question: "targetの処理順", file: "src/target.py", run: true, activate: false,
        });
        requests.pop();
        assert.deepStrictEqual(fs.readFileSync(launchLog, "utf8").trim().split("\n").map(JSON.parse).at(-1), [fs.realpathSync.native(targetCopyWorkspace)]);
        ok("同名・同内容のコピーでも指定絶対パス側だけを使い、activate:falseをbridgeへ維持する");

        if (process.platform !== "win32") {
            const linkedTarget = path.join(launchRoot, "target-link.py");
            fs.symlinkSync(targetSourceFile, linkedTarget);
            try {
                const linked = await client.callTool({ name: "show_standard_view", arguments: { file: linkedTarget } });
                assert.notStrictEqual(linked.isError, true);
                assert.strictEqual(linked._meta.standardWorkspaceRoot, fs.realpathSync.native(targetWorkspace));
                requests.pop();
            } finally {
                fs.unlinkSync(linkedTarget);
            }
            ok("シンボリックリンクをrealpathへ解決して対象workspace境界を維持する");
        } else {
            console.log("  skip - file symlink realpath test requires Windows Developer Mode");
        }
        const invalidLine = await client.callTool({ name: "run_trace", arguments: { file: "src/main.py", line: 0 } });
        assert.strictEqual(invalidLine.isError, true);
        const missingTraceTarget = await client.callTool({ name: "show_saved_trace", arguments: { file: "src/main.py" } });
        assert.strictEqual(missingTraceTarget.isError, true);
        const invalidRange = await client.callTool({
            name: "generate_inline_annotations", arguments: { file: "src/main.py", startLine: 3, endLine: 2 },
        });
        assert.strictEqual(invalidRange.isError, true);
        const emptyRevision = await client.callTool({ name: "revise_inline_annotations", arguments: { file: "src/main.py" } });
        assert.strictEqual(emptyRevision.isError, true);
        const conflictingRevision = await client.callTool({
            name: "revise_inline_annotations", arguments: { file: "src/main.py", removeAnnotationIds: ["a1"], hideAnnotationIds: ["a1"] },
        });
        assert.strictEqual(conflictingRevision.isError, true);
        const missingEntry = await client.callTool({ name: "create_code_diagram", arguments: { question: "mainの処理順" } });
        assert.strictEqual(missingEntry.isError, true);
        const relativeEntry = await client.callTool({
            name: "create_code_diagram", arguments: { question: "mainの処理順", file: "src/main.py" },
        });
        assert.strictEqual(relativeEntry.isError, true);
        const outside = path.join(os.tmpdir(), "outside.py");
        fs.writeFileSync(outside, "print('outside')\n");
        try {
            const invalidFile = await client.callTool({ name: "show_standard_view", arguments: { file: outside } });
            assert.strictEqual(invalidFile.isError, true);
            assert.ok(invalidFile.content[0].text.startsWith("The file must be inside the active AI Code Guide workspace."));
            assert.match(invalidFile.content[0].text, /Connected workspace root: /);
            assert.ok(
                invalidFile.content[0].text.includes(fs.realpathSync.native(outside)),
            );
            assert.match(invalidFile.content[0].text, /Passing an absolute path resolves reliably/);
            if (process.platform !== "win32") {
                const symlink = path.join(sourceDir, "outside-link.py");
                fs.symlinkSync(outside, symlink);
                const invalidSymlink = await client.callTool({ name: "show_standard_view", arguments: { file: "src/outside-link.py" } });
                assert.strictEqual(invalidSymlink.isError, true);
            }
        } finally {
            fs.unlinkSync(outside);
        }
        assert.strictEqual(requests.length, 16);
        ok("不正行・入口なし・相対入口・ワークスペース外ファイルをブリッジ送信前に拒否する");

        const missingRelative = await client.callTool({ name: "show_standard_view", arguments: { file: "does/not/exist.py" } });
        assert.strictEqual(missingRelative.isError, true);
        const missingText = missingRelative.content[0].text;
        assert.ok(missingText.startsWith("File not found: does/not/exist.py"));
        assert.match(missingText, /Connected workspace root: /);
        assert.match(missingText, /Tried:\n(  - .+\n?)+/);
        assert.match(missingText, /Passing an absolute path resolves reliably/);
        assert.match(missingText, /Multiple AI Code Guide workspaces are connected/);
        ok("相対パス解決失敗のエラーに接続中workspaceRoot・試した候補パス・複数bridge候補の曖昧さを含める");

        const unsafe = await client.callTool({ name: "run_trace", arguments: { file: "src/main.py", functions: ["unsafe_export"], arguments: { path: "blocked.txt" }, activate: false } });
        const unknown = await client.callTool({ name: "run_trace", arguments: { file: "src/main.py", functions: ["unknown_dispatch"], arguments: { function_name: "mystery", value: 1 }, activate: false } });
        const recovery = await client.callTool({ name: "run_trace", arguments: { file: "src/main.py", functions: ["normalize_score"], arguments: { raw: 42, max_score: 50 }, activate: false } });
        assert.strictEqual(unsafe.structuredContent.trace.traceEntryId, "entry-public-continuation");
        assert.strictEqual(unknown.structuredContent.trace.traceEntryId, "entry-public-continuation");
        assert.strictEqual(recovery.structuredContent.trace.traceEntryId, "entry-public-continuation");
        assert.strictEqual(requests.at(-2).traceEntryId, "entry-public-continuation");
        assert.deepStrictEqual(requests.at(-2).arguments, { function_name: "mystery", value: 1 });

        const exception = await client.callTool({ name: "run_trace", arguments: { file: "src/main.py", functions: ["require_nonnegative"], arguments: { value: -1 }, newEntry: true, activate: false } });
        const recoveredArgsOnly = await client.callTool({ name: "run_trace", arguments: { file: null, line: null, functions: null, arguments: { value: 7 }, activate: false } });
        assert.strictEqual(exception.structuredContent.trace.traceEntryId, "entry-public-continuation");
        assert.notStrictEqual(recoveredArgsOnly.isError, true);
        assert.strictEqual(recoveredArgsOnly.structuredContent.trace.traceEntryId, "entry-public-continuation");
        assert.deepStrictEqual(requests.at(-1).functions, ["require_nonnegative"]);
        assert.deepStrictEqual(requests.at(-1).arguments, { value: 7 });
        ok("MC12 target変更とMC14 args-only retryを同じ公開trace entryで継続する");

        const noOpenRetry = await client.callTool({ name: "run_trace", arguments: { file: null, arguments: { value: 8 }, activate: false } });
        assert.strictEqual(noOpenRetry.isError, true);
        assert.match(noOpenRetry.content[0].text, /exactly one open trace entry; found 0/);
        const ambiguousNewEntry = await client.callTool({ name: "run_trace", arguments: { arguments: { value: 9 }, newEntry: true } });
        assert.strictEqual(ambiguousNewEntry.isError, true);
        assert.match(ambiguousNewEntry.content[0].text, /newEntry requires an explicit file/);
    } finally {
        await client.close();
        bridge.close();
        fs.rmSync(launchRoot, { recursive: true, force: true });
        fs.rmSync(unrelatedCwd, { recursive: true, force: true });
    }

    async function expectLaunchFailure(label, launcherSource, expected) {
        const failureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acg-mcp-stage-"));
        const failureWorkspace = path.join(failureRoot, "project");
        const failureFile = path.join(failureWorkspace, "main.py");
        const failureRegistry = path.join(failureRoot, "registry");
        const failureLauncher = writeNodeLauncher(
            failureRoot,
            "code-launcher",
            launcherSource,
        );
        fs.mkdirSync(failureWorkspace, { recursive: true });
        fs.mkdirSync(failureRegistry);
        fs.writeFileSync(path.join(failureWorkspace, "pyproject.toml"), "[project]\nname='failure'\n");
        fs.writeFileSync(failureFile, "print('failure')\n");
        const failureTransport = new StdioClientTransport({
            command: process.execPath,
            args: [path.join(root, "bin", "ai-code-guide-mcp.mjs"), "--workspace", failureRoot],
            env: {
                ...process.env,
                AI_CODE_GUIDE_REGISTRY_DIR: failureRegistry,
                AI_CODE_GUIDE_CODE_COMMAND: failureLauncher,
                AI_CODE_GUIDE_CONNECT_TIMEOUT_MS: "800",
            },
            stderr: "pipe",
        });
        const failureClient = new Client({ name: `ai-code-guide-test-${label}`, version: "1.0.0" });
        try {
            await failureClient.connect(failureTransport);
            const result = await failureClient.callTool({ name: "show_standard_view", arguments: { file: failureFile } });
            assert.strictEqual(result.isError, true);
            assert.match(result.content[0].text, expected);
            ok(label);
        } finally {
            await failureClient.close();
            fs.rmSync(failureRoot, { recursive: true, force: true });
        }
    }

    await expectLaunchFailure(
        "拡張が起動しない失敗段階を明示し、別workspaceへフォールバックしない",
        "",
        /extension did not activate/,
    );
    await expectLaunchFailure(
        "拡張起動後にbridgeが作られない失敗段階を明示する",
        `const fs=require("fs"),path=require("path");const root=process.argv[2];const dir=path.join(root,".ai-code-guide");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"activation.json"),JSON.stringify({version:1,workspaceRoot:root}));`,
        /extension activated.*bridge was not created/,
    );
    await expectLaunchFailure(
        "bridgeが応答しない失敗段階を明示する",
        `const fs=require("fs"),path=require("path");const root=process.argv[2];const registry=process.env.AI_CODE_GUIDE_REGISTRY_DIR;fs.writeFileSync(path.join(registry,"target.json"),JSON.stringify({version:1,baseUrl:"http://127.0.0.1:9",token:"dead",workspaceRoot:root}));`,
        /bridge was created.*did not respond/,
    );

    {
        const failureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acg-mcp-open-failure-"));
        const failureWorkspace = path.join(failureRoot, "project");
        const failureFile = path.join(failureWorkspace, "main.py");
        fs.mkdirSync(failureWorkspace, { recursive: true });
        fs.writeFileSync(path.join(failureWorkspace, "pyproject.toml"), "[project]\nname='failure'\n");
        fs.writeFileSync(failureFile, "print('failure')\n");
        const failureTransport = new StdioClientTransport({
            command: process.execPath,
            args: [path.join(root, "bin", "ai-code-guide-mcp.mjs"), "--workspace", failureRoot],
            env: { ...process.env, AI_CODE_GUIDE_REGISTRY_DIR: path.join(failureRoot, "registry"), AI_CODE_GUIDE_CODE_COMMAND: path.join(failureRoot, "missing-code") },
            stderr: "pipe",
        });
        const failureClient = new Client({ name: "ai-code-guide-test-open-failure", version: "1.0.0" });
        try {
            await failureClient.connect(failureTransport);
            const result = await failureClient.callTool({ name: "show_standard_view", arguments: { file: failureFile } });
            assert.strictEqual(result.isError, true);
            assert.match(result.content[0].text, /VS Code could not open the target project/);
            ok("VS Codeを開けない失敗段階を明示する");
        } finally {
            await failureClient.close();
            fs.rmSync(failureRoot, { recursive: true, force: true });
        }
    }

    {
        const emptyRegistryDir = fs.mkdtempSync(path.join(os.tmpdir(), "acg-mcp-empty-registry-"));
        const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "acg-mcp-empty-workspace-"));
        const emptyTransport = new StdioClientTransport({
            command: process.execPath,
            args: [path.join(root, "bin", "ai-code-guide-mcp.mjs"), "--workspace", emptyWorkspace],
            env: { ...process.env, AI_CODE_GUIDE_REGISTRY_DIR: emptyRegistryDir },
            stderr: "pipe",
        });
        const emptyClient = new Client({ name: "ai-code-guide-test-empty", version: "1.0.0" });
        try {
            await emptyClient.connect(emptyTransport);
            const noBridge = await emptyClient.callTool({ name: "show_standard_view", arguments: { file: "does/not/exist.py" } });
            assert.strictEqual(noBridge.isError, true);
            const noBridgeText = noBridge.content[0].text;
            assert.match(noBridgeText, /AI Code Guide bridge not found\./);
            assert.match(noBridgeText, /No workspaces found in the registry \(~\/\.ai-code-guide\/bridges\/\)\./);
            ok("bridge未検出時のエラーにレジストリ登録が0件である旨を含める");
        } finally {
            await emptyClient.close();
            fs.rmSync(emptyRegistryDir, { recursive: true, force: true });
            fs.rmSync(emptyWorkspace, { recursive: true, force: true });
        }
    }

    const expected = process.platform === "win32" ? 24 : 25;
    console.log(`\n${passed}/${expected} passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
