#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const VIEWS = new Set(["standard", "overview", "project", "diagram", "inline", "trace"]);

const HELP = `AI Code Guide agent CLI

Usage:
  ai-code-guide status
  ai-code-guide show <view> [--file <path>] [--line <1-based>] [--question <text>] [--run]

Views:
  standard   関数・クラスの標準カード
  overview   ファイル概要
  project    プロジェクト構成
  diagram    質問に合わせたコード図（--question 必須）
  inline     インライン意味解説（--run で生成）
  trace      実行トレース（--file と --line、--run で実行）

The VS Code extension must be active in the current workspace.`;

function fail(message, code = 1, details = {}) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message, ...details })}\n`);
    process.exit(code);
}

function findManifest(startDir) {
    let current = path.resolve(startDir);
    while (true) {
        const candidate = path.join(current, ".ai-code-guide", "bridge.json");
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

function parseOptions(args) {
    const options = {};
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--run") {
            options.run = true;
            continue;
        }
        if (!["--file", "--line", "--question"].includes(arg)) fail(`Unknown option: ${arg}`, 2);
        const value = args[++index];
        if (value === undefined) fail(`Missing value for ${arg}`, 2);
        options[arg.slice(2)] = value;
    }
    return options;
}

function loadManifest() {
    const manifestPath = findManifest(process.cwd());
    if (!manifestPath) fail("AI Code Guide bridge not found. Open this workspace in VS Code and activate the extension.", 3);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
        fail("AI Code Guide bridge manifest is invalid.", 3, { manifestPath });
    }
    if (manifest.version !== 1 || typeof manifest.baseUrl !== "string" || typeof manifest.token !== "string" || typeof manifest.workspaceRoot !== "string") {
        fail("AI Code Guide bridge manifest is incompatible.", 3, { manifestPath });
    }
    return { ...manifest, manifestPath };
}

function relativeWorkspaceFile(file, workspaceRoot) {
    let absolute;
    let absoluteRoot;
    try {
        absolute = fs.realpathSync.native(path.resolve(process.cwd(), file));
        absoluteRoot = fs.realpathSync.native(path.resolve(workspaceRoot));
    } catch {
        fail("--file must point to an existing file.", 2);
    }
    const relative = path.relative(absoluteRoot, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail("--file must point to a file inside the active workspace.", 2);
    }
    return relative.split(path.sep).join("/");
}

async function callBridge(manifest, endpoint, init) {
    const url = new URL(endpoint, manifest.baseUrl);
    url.searchParams.set("token", manifest.token);
    let response;
    try {
        response = await fetch(url, init);
    } catch {
        fail("AI Code Guide bridge is not responding. Reload VS Code and try again.", 4, { manifestPath: manifest.manifestPath });
    }
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) fail(body.error || `HTTP ${response.status}`, 4, { status: response.status });
    return body;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
        process.stdout.write(`${HELP}\n`);
        return;
    }
    const command = args.shift();
    const manifest = loadManifest();
    if (command === "status") {
        if (args.length > 0) fail("status does not accept options", 2);
        const result = await callBridge(manifest, "/status");
        process.stdout.write(`${JSON.stringify({ ...result, manifestPath: manifest.manifestPath })}\n`);
        return;
    }
    if (command !== "show") fail(`Unknown command: ${command}`, 2);
    const view = args.shift();
    if (!view || !VIEWS.has(view)) fail(`Unknown view: ${view ?? ""}`, 2);
    const options = parseOptions(args);
    if (view === "diagram" && !options.question) fail("diagram requires --question", 2);
    const line = options.line === undefined ? undefined : Number(options.line);
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) fail("--line must be a positive integer", 2);
    if (view === "trace" && options.run && (!options.file || line === undefined)) {
        fail("trace --run requires --file and --line", 2);
    }
    const body = {
        view,
        ...(options.file ? { file: relativeWorkspaceFile(options.file, manifest.workspaceRoot) } : {}),
        ...(line !== undefined ? { line } : {}),
        ...(options.question ? { question: options.question } : {}),
        ...(options.run ? { run: true } : {}),
    };
    const result = await callBridge(manifest, "/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
