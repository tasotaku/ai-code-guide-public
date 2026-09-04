#!/usr/bin/env node

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { buildDetailAppShell } from "./detailApp";
import { buildCodeEvidenceAppShell } from "./codeEvidenceApp";
import { buildStandardAppShell } from "./standardApp";
import { buildLauncherAppShell } from "./launcherApp";
import { languageIdForPath } from "../flowchart/languageSupport";

type BridgeManifest = {
    version: number;
    baseUrl: string;
    token: string;
    workspaceRoot: string;
    manifestPath: string;
    // AI_NOTE: 無条件フォールバックで複数候補から選んだ時だけ埋める。曖昧な選択をエラー文で説明するための付帯情報。
    candidateRoots?: string[];
};

type BridgeResult = Record<string, unknown>;

const SERVER_NAME = "ai-code-guide";
// MCP App hosts may cache tool/resource metadata by server version. Keep this in
// sync with package.json so a VS Code extension update cannot reuse stale ui://
// registrations from an older bundled server.
const SERVER_VERSION = "0.27.42";
const STANDARD_APP_URI = "ui://ai-code-guide/code-locations-v8.html";
// AI_NOTE: 旧ツール定義を保持する会話ホストにも、軽量化した現行UIを返す。
const STANDARD_APP_URIS = [STANDARD_APP_URI, "ui://ai-code-guide/code-locations-v7.html", "ui://ai-code-guide/code-locations-v6.html", "ui://ai-code-guide/code-locations-v5.html", "ui://ai-code-guide/code-locations-v4.html", "ui://ai-code-guide/code-locations-v3.html", "ui://ai-code-guide/code-locations-v2.html", "ui://ai-code-guide/standard-view.html"] as const;
const DETAIL_APP_URI = "ui://ai-code-guide/detail-view-v3.html";
const DETAIL_APP_URIS = [DETAIL_APP_URI, "ui://ai-code-guide/detail-view-v2.html", "ui://ai-code-guide/detail-view.html"] as const;
const CODE_EVIDENCE_APP_URI = "ui://ai-code-guide/code-evidence-v16.html";
const LAUNCHER_APP_URI = "ui://ai-code-guide/launcher-v16.html";
// AI_NOTE: 旧ツール定義を保持する会話でも読込エラーにせず、現行の全画面対応UIを返す。
const CODE_EVIDENCE_APP_URIS = [
    CODE_EVIDENCE_APP_URI,
    "ui://ai-code-guide/code-evidence-v15.html",
    "ui://ai-code-guide/code-evidence-v14.html",
    "ui://ai-code-guide/code-evidence-v13.html",
    "ui://ai-code-guide/code-evidence-v12.html",
    "ui://ai-code-guide/code-evidence-v11.html",
    "ui://ai-code-guide/code-evidence-v10.html",
    "ui://ai-code-guide/code-evidence-v9.html",
    "ui://ai-code-guide/code-evidence-v8.html",
    "ui://ai-code-guide/code-evidence-v7.html",
    "ui://ai-code-guide/code-evidence-v6.html",
    "ui://ai-code-guide/code-evidence-v5.html",
    "ui://ai-code-guide/code-evidence-v4.html",
    "ui://ai-code-guide/code-evidence-v3.html",
    "ui://ai-code-guide/code-evidence-v2.html",
    "ui://ai-code-guide/code-evidence.html",
] as const;
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

type CliOptions = { workspacePath: string; httpPort?: number; codeCommand?: string; connectTimeoutMs: number };

function cliOptions(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
    const remaining = [...argv];
    const takeValue = (flag: string): string | undefined => {
        const index = remaining.indexOf(flag);
        if (index < 0) return undefined;
        const value = remaining[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
        remaining.splice(index, 2);
        return value;
    };
    const workspace = takeValue("--workspace");
    const httpValue = takeValue("--http") ?? env.AI_CODE_GUIDE_MCP_PORT;
    if (remaining.length > 0) {
        throw new Error("Usage: ai-code-guide-mcp [--workspace <path>] [--http <port>]");
    }
    let httpPort: number | undefined;
    if (httpValue !== undefined) {
        httpPort = Number(httpValue);
        if (!Number.isSafeInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
            throw new Error("HTTP port must be an integer from 0 to 65535");
        }
    }
    return {
        workspacePath: path.resolve(workspace || env.AI_CODE_GUIDE_WORKSPACE || process.cwd()),
        httpPort,
        codeCommand: env.AI_CODE_GUIDE_CODE_COMMAND,
        connectTimeoutMs: /^\d+$/.test(env.AI_CODE_GUIDE_CONNECT_TIMEOUT_MS ?? "")
            ? Math.max(100, Number(env.AI_CODE_GUIDE_CONNECT_TIMEOUT_MS))
            : 20_000,
    };
}

function findManifest(startPath: string): string | null {
    let current = path.resolve(startPath);
    try {
        if (fs.statSync(current).isFile()) current = path.dirname(current);
    } catch { /* loadManifestで分かりやすいエラーにする */ }

    const searchRoot = current;
    while (true) {
        const candidate = path.join(current, ".ai-code-guide", "bridge.json");
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    // Codex / Claude Codeをリポジトリルート、VS Codeをexamples等の
    // 子ワークスペースで開く使い方にも対応する。巨大な親ディレクトリを
    // 無制限に走査しないよう、起点配下だけを深さ・件数とも制限して探す。
    if (path.dirname(searchRoot) === searchRoot) return null;
    const ignored = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);
    const candidates: Array<{ path: string; modified: number }> = [];
    let visited = 0;
    const visit = (directory: string, depth: number): void => {
        if (depth > 4 || visited >= 1000) return;
        visited++;
        const candidate = path.join(directory, ".ai-code-guide", "bridge.json");
        if (fs.existsSync(candidate)) {
            try {
                candidates.push({ path: candidate, modified: fs.statSync(candidate).mtimeMs });
            } catch { /* 走査中に消えたbridgeは無視する */ }
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || ignored.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".ai-code-guide")) continue;
            visit(path.join(directory, entry.name), depth + 1);
        }
    };
    visit(searchRoot, 0);
    candidates.sort((a, b) => b.modified - a.modified);
    return candidates[0]?.path ?? null;
}

function registryManifestPaths(): string[] {
    const directory = process.env.AI_CODE_GUIDE_REGISTRY_DIR
        ? path.resolve(process.env.AI_CODE_GUIDE_REGISTRY_DIR)
        : path.join(os.homedir(), ".ai-code-guide", "bridges");
    let names: string[];
    try {
        names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
    } catch {
        return [];
    }
    return names.map((name) => path.join(directory, name)).sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
}

function readManifest(manifestPath: string): BridgeManifest | null {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
        return null;
    }
    const value = raw as Partial<BridgeManifest>;
    if (value.version !== 1 || typeof value.baseUrl !== "string" || typeof value.token !== "string" || typeof value.workspaceRoot !== "string") {
        return null;
    }
    return { ...value, version: 1, baseUrl: value.baseUrl, token: value.token, workspaceRoot: value.workspaceRoot, manifestPath };
}

function manifestsFor(workspacePath: string): BridgeManifest[] {
    const local = findManifest(workspacePath);
    const paths = [...new Set([...(local ? [local] : []), ...registryManifestPaths()])];
    return paths.map(readManifest).filter((value): value is BridgeManifest => Boolean(value));
}

function matchingManifest(workspacePath: string, file: string): BridgeManifest | null {
    const matching: BridgeManifest[] = [];
    for (const manifest of manifestsFor(workspacePath)) {
        try {
            workspaceFile(file, manifest, workspacePath);
            matching.push(manifest);
        } catch { /* 別ワークスペースの候補は次を試す */ }
    }
    // AI_NOTE: 親repoとその子workspaceが同時に対象ファイルを含む場合、manifestの
    // 発見順ではなく最も具体的なrootを選ぶ。そうしないと子workspace固有の設定・
    // cache・Extension Hostではなく親repoへ誤配送される。
    matching.sort((left, right) => {
        const depth = (root: string): number => {
            try { return fs.realpathSync.native(path.resolve(root)).split(path.sep).filter(Boolean).length; }
            catch { return path.resolve(root).split(path.sep).filter(Boolean).length; }
        };
        return depth(right.workspaceRoot) - depth(left.workspaceRoot);
    });
    return matching[0] ?? null;
}

function sameRealPath(left: string, right: string): boolean {
    try {
        return fs.realpathSync.native(left) === fs.realpathSync.native(right);
    } catch {
        return false;
    }
}

function matchingManifestsForRoot(workspacePath: string, file: string, root: string): BridgeManifest[] {
    return manifestsFor(workspacePath).filter((manifest) => {
        if (!sameRealPath(manifest.workspaceRoot, root)) return false;
        try {
            workspaceFile(file, manifest, workspacePath);
            return true;
        } catch {
            return false;
        }
    });
}

function existingFile(file: string, workspacePath: string): string | null {
    let launchRoot = path.resolve(workspacePath);
    try {
        if (fs.statSync(launchRoot).isFile()) launchRoot = path.dirname(launchRoot);
    } catch { /* 候補ごとに存在確認する */ }
    const candidates = path.isAbsolute(file)
        ? [file]
        : [path.resolve(launchRoot, file), path.resolve(path.dirname(launchRoot), file)];
    for (const candidate of new Set(candidates)) {
        try {
            if (fs.statSync(candidate).isFile()) return fs.realpathSync.native(candidate);
        } catch { /* 次の候補へ */ }
    }
    return null;
}

function projectRootFor(file: string): string | null {
    let directory = path.dirname(file);
    while (true) {
        if ([".git", "pyproject.toml", "setup.py"].some((name) => fs.existsSync(path.join(directory, name)))) {
            return directory;
        }
        const parent = path.dirname(directory);
        if (parent === directory) return null;
        directory = parent;
    }
}

function defaultCodeCommand(): string {
    if (process.platform === "darwin") {
        const bundled = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
        if (fs.existsSync(bundled)) return bundled;
    }
    if (process.platform === "win32") {
        const candidates = [
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
            process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
            process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
        ].filter((candidate): candidate is string => Boolean(candidate));
        const installed = candidates.find((candidate) => fs.existsSync(candidate));
        if (installed) return installed;
    }
    return "code";
}

async function openWorkspace(command: string, root: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        // AI_NOTE: --new-windowは既に同じfolderを開いていても重複ウィンドウを作る。folderだけを渡すと
        // VS Code自身が既存の同一workspaceを再利用し、未起動時だけ新しいウィンドウを作る。
        // A JavaScript launcher is useful for test/dev integrations and is not
        // directly executable on Windows. Invoke it without a command shell so
        // workspace paths cannot be interpreted as shell syntax.
        const isJavaScriptLauncher = path.extname(command).toLowerCase() === ".js";
        const executable = isJavaScriptLauncher ? process.execPath : command;
        const args = isJavaScriptLauncher ? [command, root] : [root];
        const child = spawn(executable, args, { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

async function bridgeResponds(manifest: BridgeManifest): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
        const url = new URL("/status", manifest.baseUrl);
        url.searchParams.set("token", manifest.token);
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return false;
        const body = await response.json() as { ok?: unknown; workspaceRoot?: unknown };
        return body.ok === true && (typeof body.workspaceRoot !== "string" || sameRealPath(body.workspaceRoot, manifest.workspaceRoot));
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

type BridgeWaitResult = { manifest: BridgeManifest | null; sawManifest: boolean };

async function waitForMatchingManifest(
    workspacePath: string,
    file: string,
    root: string,
    timeoutMs: number,
): Promise<BridgeWaitResult> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let sawManifest = false;
    while (Date.now() < deadline) {
        const candidates = matchingManifestsForRoot(workspacePath, file, root);
        sawManifest ||= candidates.length > 0;
        for (const manifest of candidates) {
            if (await bridgeResponds(manifest)) return { manifest, sawManifest: true };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const delay = Math.min(100 * (2 ** attempt), 1_500, remaining);
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return { manifest: null, sawManifest };
}

function extensionActivatedSince(root: string, since: number): boolean {
    const markerPath = path.join(root, ".ai-code-guide", "activation.json");
    try {
        if (fs.statSync(markerPath).mtimeMs < since - 1_000) return false;
        const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { version?: number; workspaceRoot?: string };
        return marker.version === 1 && typeof marker.workspaceRoot === "string" && sameRealPath(marker.workspaceRoot, root);
    } catch {
        return false;
    }
}

// AI_NOTE: 外部ファイルを既存bridgeへ直接渡すと、プロジェクト解析やHTTP境界のworkspace制限が壊れる。
// 対象のプロジェクトを新規VS Codeウィンドウで開いて同じ安全なbridge接続を作ってから表示する。
async function loadManifest(options: CliOptions, file?: string): Promise<BridgeManifest> {
    if (file && path.isAbsolute(file)) {
        const targetFile = existingFile(file, options.workspacePath);
        if (!targetFile) throw new Error(`Target file not found: ${file}`);
        if (!languageIdForPath(targetFile)) throw new Error(`Target file must be Python, JavaScript, or TypeScript: ${file}`);
        const targetRoot = projectRootFor(targetFile);
        if (!targetRoot) {
            // markerのない単純なfolder workspaceは、既存接続がそのファイルを含む場合だけ再利用できる。
            // 未接続時は開くべき境界を安全に決められないため、無関係なbridgeへは流さない。
            const connected = manifestsFor(options.workspacePath)
                .filter((manifest) => {
                    try { workspaceFile(targetFile, manifest, options.workspacePath); return true; } catch { return false; }
                })
                .sort((left, right) => right.workspaceRoot.length - left.workspaceRoot.length);
            for (const current of connected) {
                if (await bridgeResponds(current)) return current;
            }
            const diagnosticManifest = manifestsFor(options.workspacePath)[0];
            if (connected.length === 0 && diagnosticManifest) {
                workspaceFile(targetFile, diagnosticManifest, options.workspacePath);
            }
            throw new Error(`Could not determine the project root for: ${file}`);
        }

        // AI_NOTE: 絶対パスは先にrealpathとプロジェクトルートを確定し、rootが完全一致するbridgeだけを使う。
        // 親workspaceや同名コピーを含む無関係な接続へフォールバックしない。
        for (const current of matchingManifestsForRoot(options.workspacePath, targetFile, targetRoot)) {
            if (await bridgeResponds(current)) return current;
        }

        const launchedAt = Date.now();
        try {
            await openWorkspace(options.codeCommand || defaultCodeCommand(), targetRoot);
        } catch (error) {
            const detail = error instanceof Error ? ` ${error.message}` : "";
            throw new Error(`VS Code could not open the target project.${detail}`);
        }
        const opened = await waitForMatchingManifest(
            options.workspacePath,
            targetFile,
            targetRoot,
            options.connectTimeoutMs,
        );
        if (opened.manifest) return opened.manifest;
        if (opened.sawManifest) {
            throw new Error("AI Code Guide bridge was created for the target project, but it did not respond before the connection timeout.");
        }
        if (extensionActivatedSince(targetRoot, launchedAt)) {
            throw new Error("AI Code Guide extension activated in the target project, but its bridge was not created before the connection timeout.");
        }
        throw new Error("VS Code opened the target project, but the AI Code Guide extension did not activate before the connection timeout. Verify that the extension is installed and enabled in that VS Code profile.");
    }
    if (file) {
        const current = matchingManifest(options.workspacePath, file);
        if (current) return current;
    }
    const manifests = manifestsFor(options.workspacePath);
    if (manifests[0]) {
        // AI_NOTE: 候補が複数ある時、無条件フォールバックでどれを選んだかが分からないと後段のエラーで原因究明できない。他候補のrootを添えておく。
        return manifests.length > 1 ? { ...manifests[0], candidateRoots: manifests.map((m) => m.workspaceRoot) } : manifests[0];
    }
    // AI_NOTE: bridge未検出時、レジストリに何が登録されているかを出し、どのVS Codeウィンドウに繋がるべきかを人が即判断できるようにする。
    const registered = registryManifestPaths().map(readManifest).filter((value): value is BridgeManifest => Boolean(value));
    const registryInfo = registered.length > 0
        ? `Workspaces found in the registry (~/.ai-code-guide/bridges/):\n${registered.map((entry) => `  - ${entry.workspaceRoot}`).join("\n")}`
        : "No workspaces found in the registry (~/.ai-code-guide/bridges/).";
    throw new Error(`AI Code Guide bridge not found. Open the target workspace in VS Code; the extension connects automatically when a Python file or the AI Code Guide view is opened.\n${registryInfo}`);
}

function workspaceFile(file: string, manifest: BridgeManifest, launchPath: string): string {
    const root = fs.realpathSync.native(path.resolve(manifest.workspaceRoot));
    let launchRoot = path.resolve(launchPath);
    try {
        if (fs.statSync(launchRoot).isFile()) launchRoot = path.dirname(launchRoot);
    } catch { /* 存在確認は候補ごとに行う */ }
    const unresolved = path.isAbsolute(file)
        ? [file]
        : [path.resolve(root, file), path.resolve(launchRoot, file), path.resolve(path.dirname(root), file)];
    let foundOutside = false;
    for (const rawCandidate of new Set(unresolved)) {
        let candidate: string;
        try {
            candidate = fs.realpathSync.native(rawCandidate);
        } catch {
            continue;
        }
        const relative = path.relative(root, candidate);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            foundOutside = true;
            continue;
        }
        return relative.split(path.sep).join("/");
    }
    // AI_NOTE: 相対パス解決の失敗は「どのworkspaceに繋がり・何を試したか」が見えないと無駄な再試行や機能封印を招くため、root・候補一覧・絶対パス推奨・曖昧なbridge選択の有無を診断情報として添える。
    const triedList = [...new Set(unresolved)].map((candidate) => `  - ${candidate}`).join("\n");
    const otherRoots = (manifest.candidateRoots ?? []).filter((candidateRoot) => candidateRoot !== manifest.workspaceRoot);
    const ambiguity = manifest.candidateRoots && manifest.candidateRoots.length > 1
        ? `\nMultiple AI Code Guide workspaces are connected (${manifest.candidateRoots.length} candidates); this call used "${root}" because no file argument narrowed the choice. Other candidate roots:\n${otherRoots.map((candidateRoot) => `  - ${candidateRoot}`).join("\n")}`
        : "";
    const hint = "Passing an absolute path resolves reliably regardless of the connected workspace.";
    if (foundOutside) {
        throw new Error(`The file must be inside the active AI Code Guide workspace.\nConnected workspace root: ${root}\nTried:\n${triedList}${ambiguity}\n${hint}`);
    }
    throw new Error(`File not found: ${file}\nConnected workspace root: ${root}\nTried:\n${triedList}${ambiguity}\n${hint}`);
}

async function callBridge(manifest: BridgeManifest, endpoint: string, init?: RequestInit): Promise<BridgeResult> {
    const url = new URL(endpoint, manifest.baseUrl);
    url.searchParams.set("token", manifest.token);
    let response: Response;
    try {
        response = await fetch(url, init);
    } catch {
        throw new Error("AI Code Guide bridge is not responding. Reload VS Code and open the AI Code Guide sidebar.");
    }
    const text = await response.text();
    let body: BridgeResult;
    try {
        body = text ? JSON.parse(text) as BridgeResult : {};
    } catch {
        body = { error: text || `HTTP ${response.status}` };
    }
    if (!response.ok) throw new Error(String(body.error || `AI Code Guide bridge returned HTTP ${response.status}.`));
    return body;
}

async function show(manifest: BridgeManifest, body: Record<string, unknown>): Promise<BridgeResult> {
    // Model-originated MCP calls prepare and synchronize results without changing
    // the user's VS Code selection. Only an explicit conversation-UI jump button
    // sends focusWindow:true, which intentionally activates the destination.
    const backgroundViews = new Set(["standard", "diagram", "inline", "trace"]);
    const backgroundBody = backgroundViews.has(String(body.view))
        ? { ...body, activate: body.focusWindow === true }
        : body;
    return callBridge(manifest, "/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backgroundBody),
    });
}

function success(body: BridgeResult, message: string) {
    const codexView = body.codexView && typeof body.codexView === "object"
        ? body.codexView as Record<string, unknown>
        : null;
    const viewUrl = codexView?.type === "browser" && typeof codexView.url === "string"
        ? codexView.url
        : null;
    const content: Array<
        | { type: "text"; text: string }
        | { type: "resource_link"; uri: string; name: string; title: string; description: string; mimeType: string }
    > = [{
        type: "text",
        text: `${message}${viewUrl ? `\n\n大きい表示: ${viewUrl}` : ""}\n${JSON.stringify(body, null, 2)}`,
    }];
    // AI_NOTE: コード図は広いブラウザWebビューだけを主表示にする。resource_linkも会話上では
    // カードとして描画されるホストがあるため、図についてはtext/structuredContent内のURLだけを返す。
    if (viewUrl && body.view !== "diagram") {
        const isLauncher = body.view === "launcher";
        const isInline = body.view === "inline";
        const isStandard = body.view === "standard";
        const isDiagram = body.view === "diagram";
        const isCombined = body.view === "combined";
        content.push({
            type: "resource_link",
            uri: viewUrl,
            name: isLauncher ? "ai-code-guide-launcher" : isCombined ? "ai-code-guide" : isStandard ? "ai-code-guide-standard" : isInline ? "ai-code-guide-inline" : isDiagram ? "ai-code-guide-diagram" : "ai-code-guide-trace",
            title: isLauncher ? "AI Code Guide操作パネルを開く" : isCombined ? "AI Code Guideを開く" : isStandard ? "標準ビューを開く" : isInline ? "インライン解説を大きく表示" : isDiagram ? "コード図を大きく表示" : "実行トレースを大きく表示",
            description: isLauncher
                ? "Codex内の独立したブラウザパネルで、会話に流されないAI Code Guideの操作ボタンを表示します。"
                : isCombined
                ? "Codex内の一つのコード面で、標準色・実行値・名称辞書と切替可能な標準／コード図サイドバーを表示します。"
                : isStandard
                ? "Codex内のブラウザパネルで、VS Code標準タブと同じ定義順カードと詳しい読解ガイドを表示します。"
                : isInline
                ? "Codex内のブラウザパネルで、コードと解説を横幅広く表示します。"
                : isDiagram
                ? "Codex内のブラウザパネルで、コードとクリック移動できるHTML図を横幅広く表示します。"
                : "Codex内のブラウザパネルで、コードと実行値を横幅広く表示します。",
            mimeType: "text/html",
        });
    }
    return {
        content,
        structuredContent: body,
    };
}

function withViewState(body: BridgeResult, viewMode: "standard" | "overview", resourceUri: string): BridgeResult {
    return { ...body, viewState: { viewMode, resourceUri, resourceVersion: SERVER_VERSION, stateReceiptId: randomUUID(), renderedByAppRequired: true } };
}

function traceSuccess(body: BridgeResult, message: string) {
    const result = success(body, message);
    const codexView = body.codexView && typeof body.codexView === "object"
        ? body.codexView as Record<string, unknown>
        : null;
    const viewUrl = codexView?.type === "browser" && typeof codexView.url === "string"
        ? codexView.url
        : null;
    const finalAnswer = viewUrl
        ? `${message}：[トレースを開く](<${viewUrl}>)`
        : `${message}。ブラウザ用URLは返されませんでした。VS CodeのAI Code Guide「トレース」表示で確認してください。`;
    const text = result.content.find((item) => item.type === "text");
    if (text?.type === "text") {
        text.text = [
            finalAnswer,
            viewUrl
                ? "このブラウザ用リンクはVS Code側の表示とは別です。最終回答にも上のMarkdownリンクをそのまま含めてください。"
                : "URLがない場合だけ、VS Code側の表示を代替の確認方法として案内してください。",
            JSON.stringify(body, null, 2),
        ].join("\n\n");
    }
    return {
        ...result,
        structuredContent: {
            ...body,
            responseGuidance: {
                finalAnswer,
                mustIncludeTraceLink: Boolean(viewUrl),
                openInCodexBrowserWhenAvailable: Boolean(viewUrl),
                vscodeViewIsSeparate: true,
            },
        },
    };
}

function diagramFallbackText(body: BridgeResult): string {
    const diagram = body.diagram && typeof body.diagram === "object"
        ? body.diagram as Record<string, unknown>
        : {};
    const title = typeof diagram.title === "string" ? diagram.title : "コード図";
    const summary = typeof diagram.summary === "string" ? diagram.summary : "";
    const nodes = Array.isArray(diagram.nodes) ? diagram.nodes : [];
    const lines = nodes.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const node = value as Record<string, unknown>;
        const label = typeof node.label === "string" ? node.label : "コード地点";
        const description = typeof node.description === "string" ? node.description : "";
        const emphasis = typeof node.emphasis === "string" ? node.emphasis : "";
        const emphasisReason = typeof node.emphasisReason === "string" ? node.emphasisReason : "";
        const symbol = typeof node.symbol === "string" ? node.symbol : "";
        const file = typeof node.file === "string" ? node.file : "";
        const line = typeof node.line === "number" ? node.line : undefined;
        const location = [symbol, file && line ? `${file}:${line}` : file].filter(Boolean).join(" · ");
        const badge = emphasis === "success" ? " [問題なさそう]" : "";
        const reason = emphasisReason
            ? emphasis === "success"
                ? ` AIの見立て: ${emphasisReason}（実行・テスト未確認）`
                : ` 判断理由: ${emphasisReason}`
            : "";
        return [`- ${label}${badge}${description ? `: ${description}` : ""}${reason}${location ? `（${location}）` : ""}`];
    });
    return [title, summary, ...lines].filter(Boolean).join("\n");
}

function standardFallbackText(body: BridgeResult): string {
    const standard = body.standard && typeof body.standard === "object"
        ? body.standard as Record<string, unknown>
        : {};
    const title = typeof standard.title === "string" ? standard.title : "コード構造";
    const items = Array.isArray(standard.items) ? standard.items : [];
    const lines = items.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const label = typeof item.label === "string" ? item.label : "コード地点";
        const kind = item.kind === "class" ? "クラス" : item.parent ? "メソッド" : "関数";
        const line = typeof item.line === "number" ? `:${item.line}` : "";
        return [`- ${kind}: ${label}${line}`];
    });
    return [title, ...lines].join("\n");
}

function compactStandardBody(body: BridgeResult): BridgeResult {
    // AI_NOTE: 全コード用背景はcard外領域も含むため、item単位に加えて共通範囲も残す。
    if (!body.standard || typeof body.standard !== "object") return body;
    const standard = body.standard as Record<string, unknown>;
    const items = Array.isArray(standard.items) ? standard.items : [];
    const source = Array.isArray(standard.source) ? standard.source : [];
    // AI_NOTE: 初期表示は構造情報だけに絞るが、Codex内でコードと意味単位を対応づけるため
    // 行範囲と色は残す。展開要求では目的・入出力・サブブロックも同じAppへ返す。
    const compactItems = items.map((value) => {
        if (!value || typeof value !== "object") return value;
        const item = value as Record<string, unknown>;
        return Object.fromEntries(["id", "kind", "label", "line", "lineEnd", "parent", "color", "meaningRanges", "expanded", "expansion"]
            .filter((key) => item[key] !== undefined)
            .map((key) => [key, item[key]]));
    });
    return {
        ...body,
        standard: {
            ...(typeof standard.title === "string" ? { title: standard.title } : {}),
            ...(typeof standard.file === "string" ? { file: standard.file } : {}),
            source: source.flatMap((value) => {
                if (!value || typeof value !== "object") return [];
                const entry = value as Record<string, unknown>;
                return typeof entry.line === "number" && typeof entry.text === "string"
                    ? [{ line: entry.line, text: entry.text }]
                    : [];
            }),
            items: compactItems,
            ...(Array.isArray(standard.backgroundRanges) ? { backgroundRanges: standard.backgroundRanges } : {}),
        },
    };
}

function overviewFallbackText(body: BridgeResult): string {
    const overview = body.overview && typeof body.overview === "object" ? body.overview as Record<string, unknown> : {};
    const title = typeof overview.title === "string" ? overview.title : "ファイル概要";
    const role = typeof overview.role === "string" ? overview.role : "保存済みの概要はありません。";
    const groups = Array.isArray(overview.groups) ? overview.groups : [];
    const lines = groups.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const group = value as Record<string, unknown>;
        const label = typeof group.label === "string" ? group.label : "グループ";
        const count = Array.isArray(group.items) ? group.items.length : 0;
        return [`- ${label}（${count}件）`];
    });
    return [title, role, ...lines].join("\n");
}

function projectFallbackText(body: BridgeResult): string {
    const project = body.project && typeof body.project === "object" ? body.project as Record<string, unknown> : {};
    const files = Array.isArray(project.files) ? project.files : [];
    const imports = Array.isArray(project.imports) ? project.imports : [];
    return `対応コードファイル ${files.length}件・import関係 ${imports.length}件を表示しました。`;
}

function annotationsFallbackText(body: BridgeResult): string {
    const annotations = body.annotations && typeof body.annotations === "object" ? body.annotations as Record<string, unknown> : {};
    const items = Array.isArray(annotations.items) ? annotations.items : [];
    const lines = items.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const label = typeof item.label === "string" ? item.label : "解説";
        const explanation = typeof item.explanation === "string" ? item.explanation : "";
        const start = typeof item.startLine === "number" ? `L${item.startLine}` : "";
        return [`- ${start}${start ? " " : ""}${label}${explanation ? `: ${explanation}` : ""}`];
    });
    return items.length > 0 ? lines.join("\n") : "保存済みのインライン解説はありません。";
}

function traceFallbackText(
    body: BridgeResult,
    file: string,
    line: number | undefined,
    functions: string[] | undefined,
    executed: boolean,
): string {
    const trace = body.trace && typeof body.trace === "object" ? body.trace as Record<string, unknown> : {};
    const names = Array.isArray(trace.funcNames) ? trace.funcNames.filter((value): value is string => typeof value === "string") : [];
    const requestedNames = functions?.filter((name) => name.length > 0) || [];
    const selectedNames = names.length > 0 ? names : requestedNames;
    const attempts = Array.isArray(trace.attempts) ? trace.attempts.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object") : [];
    const hasBrowserView = Boolean(
        body.codexView
        && typeof body.codexView === "object"
        && (body.codexView as Record<string, unknown>).type === "browser"
        && typeof (body.codexView as Record<string, unknown>).url === "string",
    );
    const target = selectedNames.length > 0
        ? `${file} の ${selectedNames.map((name) => `${name}()`).join(", ")}`
        : line !== undefined
            ? `${file} の ${line}行目を含む関数またはメソッド`
            : file;
    if (executed && attempts.length > 0) {
        const latest = attempts[attempts.length - 1];
        const decision = typeof latest.safetyDecision === "string" ? latest.safetyDecision : "unknown";
        const states = Array.isArray(latest.states) ? latest.states.join(" → ") : "";
        const guidance = typeof latest.retryGuidance === "string" ? ` 次の操作: ${latest.retryGuidance}` : "";
        if (decision !== "safe") return `${decision} のため実行しませんでした（invocation 0、対象: ${target}、状態: ${states}）。${guidance}`;
        const exception = typeof latest.exception === "string" ? latest.exception : "";
        return exception
            ? `トレースは例外で終了しました（対象: ${target}、状態: ${states}、例外: ${exception}）。${guidance}`
            : `トレースを実行しました（対象: ${target}、状態: ${states}）`;
    }
    if (executed) return `トレースを実行しました（対象: ${target}）`;
    return names.length > 0 || hasBrowserView
        ? `保存済みトレースを表示しました（対象: ${target}）`
        : `保存済みの実行トレースはありません（対象: ${target}）`;
}

export function publicDiagramBody(body: BridgeResult): BridgeResult {
    if (!body.diagram || typeof body.diagram !== "object") return body;
    const diagram = body.diagram as Record<string, unknown>;
    const nodes = Array.isArray(diagram.nodes) ? diagram.nodes : [];
    const edges = Array.isArray(diagram.edges) ? diagram.edges : [];
    const objectNodes = nodes.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
    const symbolCounts = new Map<string, number>();
    for (const node of objectNodes) {
        if (typeof node.symbol === "string" && /^[A-Za-z_]\w*$/.test(node.symbol) && !["return", "if", "raise"].includes(node.symbol)) {
            symbolCounts.set(node.symbol, (symbolCounts.get(node.symbol) ?? 0) + 1);
        }
    }
    const primarySymbol = [...symbolCounts].sort((left, right) => right[1] - left[1])[0]?.[0];
    // A bare identifier is not enough to identify relationship context: CFG
    // assignment nodes commonly use the assigned variable as their symbol.
    // Only remove nodes that explicitly describe a non-primary definition or
    // are marked as relationship/context by the bridge.
    const relationshipNodes = primarySymbol
        ? objectNodes.filter((node) => {
            const symbol = typeof node.symbol === "string" ? node.symbol : "";
            if (!symbol || symbol === primarySymbol) return false;
            const kind = typeof node.kind === "string" ? node.kind : "";
            const anchor = typeof node.anchor === "string" ? node.anchor.trim() : "";
            return node.relationship === true
                || kind === "relationship" || kind === "context"
                || /^(?:async\s+def|def|class)\s+/.test(anchor);
        })
        : [];
    const removedIds = new Set(relationshipNodes.flatMap((node) => typeof node.id === "string" ? [node.id] : []));
    const coreNodes = objectNodes.filter((node) => !removedIds.has(String(node.id)));
    const coreEdges = edges.filter((edge): edge is Record<string, unknown> => Boolean(edge && typeof edge === "object"))
        .filter((edge) => !removedIds.has(String(edge.from)) && !removedIds.has(String(edge.to)));
    for (const removedId of removedIds) {
        const incoming = edges.filter((edge): edge is Record<string, unknown> => Boolean(edge && typeof edge === "object") && edge.to === removedId);
        const outgoing = edges.filter((edge): edge is Record<string, unknown> => Boolean(edge && typeof edge === "object") && edge.from === removedId);
        for (const before of incoming) for (const after of outgoing) {
            if (!removedIds.has(String(before.from)) && !removedIds.has(String(after.to))) {
                coreEdges.push({ from: before.from, to: after.to, label: after.label ?? before.label ?? "" });
            }
        }
    }
    const convertLine = (node: Record<string, unknown>) => typeof node.line === "number"
        ? { ...node, line: node.line + 1 }
        : node;
    return {
        ...body,
        diagram: {
            ...diagram,
            // The VS Code bridge uses zero-based editor coordinates. MCP tool
            // results and inputs use one-based source lines, so convert at this
            // public boundary exactly once.
            nodes: coreNodes.map(convertLine),
            edges: coreEdges,
            ...(relationshipNodes.length ? { relationships: relationshipNodes.map(convertLine) } : {}),
        },
    };
}

function failure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function guarded<T extends Record<string, unknown>>(
    handler: (input: T) => Promise<ReturnType<typeof success>>,
) {
    return async (input: T) => {
        try {
            return await handler(input);
        } catch (error) {
            return failure(error);
        }
    };
}

const launcherViews = ["標準ビュー", "コード図", "実行トレース", "インライン解説"] as const;
type LauncherView = typeof launcherViews[number];

function launcherViewId(urlText: string, manifest: BridgeManifest): string {
    let url: URL;
    try {
        url = new URL(urlText);
    } catch {
        throw new Error("結果URLが不正です。");
    }
    if (url.origin !== new URL(manifest.baseUrl).origin) {
        throw new Error("現在のAI Code Guide workspaceとは異なる結果URLです。");
    }
    const match = /^\/view\/([a-f0-9]{48})$/.exec(url.pathname);
    if (!match) throw new Error("AI Code Guideの結果URLではありません。");
    return match[1];
}

async function readLauncherViewDocument(manifest: BridgeManifest, urlText: string): Promise<{ viewId: string; html: string }> {
    const viewId = launcherViewId(urlText, manifest);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetch(urlText, { signal: controller.signal });
        if (!response.ok) throw new Error(`AI Code Guideの結果を取得できませんでした（HTTP ${response.status}）。`);
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("text/html")) throw new Error("AI Code Guideの結果がHTMLではありません。");
        const html = await response.text();
        if (!html.trim()) throw new Error("AI Code Guideの結果が空です。");
        if (html.length > 2_000_000) throw new Error("AI Code Guideの結果が大きすぎてカード内へ表示できません。");
        return { viewId, html };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("AI Code Guideの結果取得がタイムアウトしました。");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function launcherPythonFile(target: string): string {
    const cleaned = target.trim().split("`").join("");
    const match = cleaned.match(/(?:[A-Za-z]:[\\/][^,，\n]+?\.py|(?:\.{0,2}[\\/])?[\w.@()\- \\/]+?\.py)(?=\s*[·:：,，)]|\s*$)/i);
    if (!match) throw new Error("対象にPythonファイル（例: src/example.py）を含めてください。");
    return match[0].trim();
}

function launcherFunction(target: string, question: string): string | undefined {
    for (const text of [question, target]) {
        const match = text.match(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(\s*\)/);
        if (match) return match[1];
    }
    return undefined;
}

// AI_NOTE: launcherの生成所有をbridgeへ移したため、MCP内のURL再合成と並列待機は不要。

export function createServer(workspacePath: string, codeCommand?: string, connectTimeoutMs = 20_000): McpServer {
    const options: CliOptions = { workspacePath, codeCommand, connectTimeoutMs };
    const openTraceEntries = new Map<string, { id: string; functionName: string; absoluteFile: string }>();
    // AI_NOTE: MCP Apps対応ホストでは同じui://リソースを会話内iframeとして表示する。
    // 非対応ホスト向けにはツールのtext/structuredContentを残し、UIを必須にしない。
    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
            instructions: "These tools exist to show code to the person, not to feed code to you. Call them only when the user wants to see, open, navigate, or visualize code, or asks for AI Code Guide by name. When the user's entire request is `$ai-code-guide-request`, or they ask to show, open, or redisplay the AI Code Guide input card, call show_ai_code_guide_launcher immediately and do not substitute an explanation-only response. `$ai-code-guide-request` is the dedicated public skill entry for this input-card feature; AI Code Guide is the product name, so do not treat `/ai-code-guide` as a launcher command. Each call creates a fresh card at the current conversation position. The card posts the entered target, question, and selected views as one normal user message after the host's single send confirmation. For a launcher request, call dispatch_ai_code_guide_request once so Codex returns one integrated browser view; do not call the individual view tools as well. Standard meaning-range backgrounds and whole-file inline symbol explanations are implicit default layers, while selected code diagrams and execution traces are additions. Never pre-expand Standard purpose, input, output, or block details; those are generated only after the person presses a triangle for one target. Never call these tools to read code for yourself, to check your own edits, to confirm an implementation you just wrote, or to gather context for an answer you will write in text; use ordinary file reading and search for that. When in doubt, do not call them. They also never take over the user's screen: leave focusWindow unset, since only the conversation UI's own code-location button may set it. Outside the launcher workflow, call only the directly requested individual view. The standard view is never a prerequisite or discovery step for trace, diagram, overview, inline, project, explanation, investigation, testing, or implementation requests. Resolve files, functions, classes, and methods for those requests with ordinary file reading or search, then call only the requested view. Use show_standard_view only when the user explicitly asks for the standard view, a definition-order list, or code locations. In Codex it returns a wide browser URL instead of an inline MCP App card; open it immediately when the native browser-panel opener is available and include [標準ビューを開く](<codexView.url>) in the final answer. Use expand_standard_items only when the user wants selected definitions expanded in the current Codex standard view or its mirrored VS Code view. Use overview for file purpose, project for repository shape/imports, diagram for a named behavior, inline for difficult details, and trace for runtime values. Display-only tools are only for an explicit request to show saved, cached, or existing results. A normal request to see or use an execution trace is an explicit request for runtime evidence: use run_trace unless the user specifically asks for saved results only. A normal request to see or use inline explanations is an explicit request to generate them: use generate_inline_annotations unless the user specifically asks for saved results only. If a saved-only display tool was tried for a general trace or inline request and returned no result, continue in the same turn with run_trace or generate_inline_annotations. Never call other create, generate, or run tools unless the user requested the corresponding generated diagram, explanation, or execution evidence; run_trace executes code after a side-effect check. For a requested safety-unknown trace, pass the exact requested function and arguments (including an unknown dynamic target such as mystery); the tool must record the rejection, so never replace them with a known-safe function or value. Do not expand an empty target list into all targets. After show_saved_trace or run_trace succeeds with codexView.url, the same turn's final answer MUST briefly identify the target and include a clickable Markdown link exactly in the form [トレースを開く](<codexView.url>). A VS Code view being shown does not satisfy or replace this browser link. In Codex Desktop, also open codexView.url immediately in the built-in browser panel with the native open-in-Codex capability when available; do not ask the user to copy the URL or start another model turn. Only when codexView.url is absent, say that no browser URL was returned and direct the user to the VS Code AI Code Guide trace view instead. Other hosts may present the resource link directly.",
        },
    );

    for (const [index, uri] of STANDARD_APP_URIS.entries()) {
        server.registerResource(index === 0 ? "code-locations-app" : `code-locations-app-legacy-${index}`, uri, {
            title: "AI Code Guide code locations",
            description: index === 0
                ? "Python source and a definition-order reading guide rendered side by side, with optional semantic expansion."
                : "Backward-compatible alias for the previous conversation standard view.",
        }, async () => ({
            contents: [{
                uri,
                mimeType: MCP_APP_MIME_TYPE,
                text: buildStandardAppShell(),
                _meta: { ui: { prefersBorder: true } },
            }],
        }));
    }

    // AI_NOTE: 4つの補助ビューは同じカード基盤で描けるため、MCP Appを1つにまとめる。
    // 各ツールが返すstructuredContentだけで描き分け、VS Code側の解析・生成経路は変えない。
    for (const [index, uri] of DETAIL_APP_URIS.entries()) {
        server.registerResource(index === 0 ? "detail-view-app" : `detail-view-app-legacy-${index}`, uri, {
            title: "AI Code Guide detail view",
            description: "Code overview, project structure, inline explanations, and Python traces rendered inside the conversation.",
        }, async () => ({
            contents: [{
                uri,
                mimeType: MCP_APP_MIME_TYPE,
                text: buildDetailAppShell(),
                _meta: { ui: { prefersBorder: true } },
            }],
        }));
    }

    // AI_NOTE: インライン解説とトレースはコードが無いと意味が薄いため、数行のソースと説明・実値を
    // 横に並べる専用Appへ分離する。概要・構成の一覧Appは従来のまま保つ。
    for (const [index, uri] of CODE_EVIDENCE_APP_URIS.entries()) {
        server.registerResource(index === 0 ? "code-evidence-app" : `code-evidence-app-legacy-${index}`, uri, {
            title: "AI Code Guide code evidence",
            description: index === 0
                ? "Focused source code with inline explanations or Python runtime values rendered inside the conversation."
                : "Backward-compatible alias for the previous code evidence view.",
        }, async () => ({
            contents: [{
                uri,
                mimeType: MCP_APP_MIME_TYPE,
                text: buildCodeEvidenceAppShell(),
                _meta: { ui: { prefersBorder: true } },
            }],
        }));
    }

    server.registerResource("ai-code-guide-launcher-app", LAUNCHER_APP_URI, {
        title: "AI Code Guide request launcher",
        description: "A guided prompt card for choosing the target, understanding goal, and AI Code Guide view.",
    }, async () => ({
        contents: [{
            uri: LAUNCHER_APP_URI,
            mimeType: MCP_APP_MIME_TYPE,
            text: buildLauncherAppShell(),
            _meta: { ui: { prefersBorder: true } },
        }],
    }));

    const annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    const fileInput = { file: z.string().min(1).describe("Python, JavaScript, or TypeScript file path. An absolute path in another project opens that project in VS Code and waits for its AI Code Guide connection.") };
    const activateInput = { activate: z.boolean().optional().describe("Set false to prepare this result without selecting its AI Code Guide tab") };
    const targetLinesInput = z.array(z.number().int().positive()).max(50)
        .describe("Zero, one, or many 1-based lines selected from a previous structured result; an empty list means expand nothing");
    const functionsInput = z.array(z.string().min(1).max(200)).max(50)
        .describe("Zero, one, or many Python function names or Class.method names; an empty list means target nothing");

    server.registerTool("show_ai_code_guide_launcher", {
        title: "Open AI Code Guide controls",
        description: "Show a fresh conversation MCP App card where the person enters a target and understanding goal, then chooses standard view, code diagram (flow, reading order, or dependencies), execution trace, or inline explanation. Use this immediately for `$ai-code-guide-request` and requests to show or redisplay the AI Code Guide input card. This skill entry opens one product feature; do not treat `/ai-code-guide` as a launcher command. The card posts one normal user message after the host's single send confirmation.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: {
            ui: { resourceUri: LAUNCHER_APP_URI },
            "openai/outputTemplate": LAUNCHER_APP_URI,
            "openai/toolInvocation/invoking": "AI Code Guideを準備しています…",
            "openai/toolInvocation/invoked": "AI Code Guide入力カードを表示しました。",
        },
    }, guarded(async () => success(
        { launcher: {} },
        "AI Code Guide入力カードを表示しました。",
    )));

    server.registerTool("dispatch_ai_code_guide_request", {
        title: "Run selected AI Code Guide views",
        description: "Resolve one Python file and return one integrated Codex browser view. Standard meaning-range background colors and whole-file inline symbol explanations are always prepared as default layers without expanding Standard details. Prepare any additionally selected Code Diagram or Execution Trace in parallel. Purpose, input, output, and block details remain collapsed until the person presses a Standard View triangle.",
        inputSchema: {
            target: z.string().min(1).max(500),
            question: z.string().min(1).max(2000),
            views: z.array(z.enum(launcherViews)).min(1).max(4),
        },
        annotations,
        _meta: {
            "openai/widgetAccessible": true,
            "openai/toolInvocation/invoking": "選んだ見せ方を準備しています…",
            "openai/toolInvocation/invoked": "AI Code Guideの結果を準備しました。",
        },
    }, guarded(async ({ target, question, views }: { target: string; question: string; views: LauncherView[] }) => {
        const requestedFile = launcherPythonFile(target);
        const manifest = await loadManifest(options, requestedFile);
        const relative = workspaceFile(requestedFile, manifest, workspacePath);
        const functionName = launcherFunction(target, question);
        // AI_NOTE: 背景と名称辞書は選択式の追加ビューではなく常設レイヤー。標準詳細だけは
        // ここで先行生成せず、統合画面の三角トグルから対象単位で生成する。
        const effectiveViews = [...new Set<LauncherView>(["標準ビュー", "インライン解説", ...views])];
        // AI_NOTE: 長いLLMジョブは拡張bridgeが所有し、MCPはコードsnapshotのURLを直ちに返す。
        const presentation = await callBridge(manifest, "/prepare", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: relative, question,
                additions: views.flatMap(view => view === "コード図" ? ["diagram"] : view === "実行トレース" ? ["trace"] : []),
                ...(functionName ? { functions: [functionName] } : {}),
            }),
        });
        const items = effectiveViews.map(view => ({ view, label: view, status: "preparing", message: "コードを先に表示し、完成した解説を追加します。" }));
        return success({
            ...presentation,
            dispatch: {
                target: relative,
                question,
                items,
            },
        }, `${items.filter((item) => item.status === "completed").length}/${items.length}件を一つの画面に準備しました。`);
    }));

    server.registerTool("read_ai_code_guide_result_document", {
        title: "Read an AI Code Guide result document",
        description: "Component-only loader used by the launcher card to render a generated result inside Codex without relying on host link opening.",
        inputSchema: { url: z.string().url().max(2000) },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: {
            ui: { visibility: ["app"] },
            "openai/widgetAccessible": true,
        },
    }, guarded(async ({ url }: { url: string }) => {
        const manifest = await loadManifest(options);
        const document = await readLauncherViewDocument(manifest, url);
        return success({ document }, "結果画面をカード内表示用に読み込みました。");
    }));

    server.registerTool("get_ai_code_guide_status", {
        title: "Check AI Code Guide",
        description: "Check whether the active VS Code workspace is connected and list the available understanding views.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, guarded(async () => {
        const manifest = await loadManifest(options);
        const body = await callBridge(manifest, "/status");
        return success({ ...body, workspaceRoot: manifest.workspaceRoot }, "AI Code Guide is connected.");
    }));

    server.registerTool("show_standard_view", {
        title: "Show code locations",
        description: "Use this when the user wants to read a Python, JavaScript, or TypeScript file by function or class, see its definition-order structure, or open the mirrored standard view in VS Code. Do not use it to read a file for yourself. In Codex, it returns a wide browser Webview instead of an inline MCP App card. Open codexView.url in the built-in browser panel when available and include [標準ビューを開く](<codexView.url>) in the final answer. The Webview mirrors the VS Code standard tab with definition-order cards, collapsible class children, and in-card expansions for purpose, input/output or class state/behavior, notes, and semantic reading blocks.",
        inputSchema: {
            ...fileInput,
            ...activateInput,
            line: z.number().int().positive().optional().describe("Optional 1-based line to focus"),
            savedOnly: z.boolean().optional().describe("Only when explicitly requested: read cached backgrounds and inline explanations without starting LLM generation."),
            focusWindow: z.boolean().optional().describe("Reserved for the conversation UI's own code-location button. Never set this; it takes over the user's screen"),
        },
        annotations,
        _meta: {
            "openai/toolInvocation/invoking": "コード地点を読み込んでいます…",
            "openai/toolInvocation/invoked": "標準ビューを準備しました。",
        },
    }, guarded(async ({ file, line, activate, focusWindow, savedOnly }: { file: string; line?: number; activate?: boolean; focusWindow?: boolean; savedOnly?: boolean }) => {
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        // AI_NOTE: 通常の表示要求は背後のVS Codeを更新するだけにし、会話内図のノードだけが前面化を明示する。
        const body = compactStandardBody(await show(manifest, {
            view: "standard",
            file: relative,
            backgroundAction: savedOnly ? "read" : "generate",
            ...(line ? { line } : {}),
            ...(activate === false ? { activate: false } : {}),
            ...(focusWindow ? { focusWindow: true } : {}),
        }));
        return {
            ...success(body, standardFallbackText(body)),
            _meta: { standardWorkspaceRoot: manifest.workspaceRoot },
        };
    }));

    server.registerTool("expand_standard_items", {
        title: "Expand selected reading blocks",
        description: "After show_standard_view, use this only when the user wants selected function or class internals explained. It returns purpose, input, output, notes, and semantic blocks for the current Codex standard Webview and mirrors the expansion in VS Code. Select zero, one, or many lines from the returned items. To show only one returned class or function, pass its line as scopeLine. Set replaceExpanded true when only the requested lines should appear open in that focused Codex view; saved VS Code expansions are preserved. An empty list expands nothing. Uncached expansions use the configured LLM.",
        inputSchema: {
            ...fileInput,
            ...activateInput,
            lines: targetLinesInput,
            line: z.number().int().positive().optional().describe("Optional 1-based line to focus after expanding"),
            scopeLine: z.number().int().positive().optional().describe("Optional 1-based line of one returned class or function to show by itself"),
            replaceExpanded: z.boolean().optional().describe("When true, only lines from this request appear expanded in the focused Codex view"),
            focusWindow: z.boolean().optional().describe("Reserved for the conversation UI's own code-location button. Never set this; it takes over the user's screen"),
        },
        annotations,
        _meta: {
            "openai/toolInvocation/invoking": "選んだコードを詳しく調べています…",
            "openai/toolInvocation/invoked": "選んだコードを展開しました。",
        },
    }, guarded(async ({ file, lines, line, scopeLine, replaceExpanded, activate, focusWindow }: { file: string; lines: number[]; line?: number; scopeLine?: number; replaceExpanded?: boolean; activate?: boolean; focusWindow?: boolean }) => {
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        // AI_NOTE: replaceExpandedは保存キャッシュを消さず、今回返すCodexスナップショットだけを単独展開にする。
        const body = await show(manifest, {
            view: "standard",
            file: relative,
            expandLines: lines,
            ...(line ? { line } : {}),
            ...(scopeLine ? { scopeLine } : {}),
            ...(replaceExpanded ? { visibleExpandLines: lines } : {}),
            ...(activate === false ? { activate: false } : {}),
            ...(focusWindow ? { focusWindow: true } : {}),
        });
        return {
            ...success(body, standardFallbackText(body)),
            _meta: { standardWorkspaceRoot: manifest.workspaceRoot },
        };
    }));

    server.registerTool("show_file_overview", {
        title: "Show file overview",
        description: "Use this when the user wants to see a supported code file's purpose or semantic groups. It returns and opens saved overview data only; it does not start a new LLM call.",
        inputSchema: { ...fileInput, ...activateInput },
        annotations,
        _meta: { ui: { resourceUri: DETAIL_APP_URI }, "openai/outputTemplate": DETAIL_APP_URI },
    }, guarded(async ({ file, activate }: { file: string; activate?: boolean }) => {
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        const body = withViewState(await show(manifest, { view: "overview", file: relative, ...(activate === false ? { activate: false } : {}) }), "overview", DETAIL_APP_URI);
        return { ...success(body, overviewFallbackText(body)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    server.registerTool("generate_file_overview", {
        title: "Generate file overview",
        description: "Generate and open a supported code file's role and semantic groups with the configured LLM. Use only when the user asks for a newly generated overview and saved data is insufficient.",
        inputSchema: { ...fileInput, ...activateInput },
        annotations,
        _meta: { ui: { resourceUri: DETAIL_APP_URI }, "openai/outputTemplate": DETAIL_APP_URI },
    }, guarded(async ({ file, activate }: { file: string; activate?: boolean }) => {
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        const body = await show(manifest, { view: "overview", file: relative, run: true, ...(activate === false ? { activate: false } : {}) });
        return { ...success(body, overviewFallbackText(body)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    server.registerTool("show_project_structure", {
        title: "Show project structure",
        description: "Use this when the user wants to see the repository's shape or find relevant Python, JavaScript, and TypeScript files themselves; do not use it as your own file search. It returns supported files, directories, and import edges and opens the project view without generating new AI descriptions.",
        inputSchema: activateInput,
        annotations,
        _meta: { ui: { resourceUri: DETAIL_APP_URI }, "openai/outputTemplate": DETAIL_APP_URI },
    }, guarded(async ({ activate }: { activate?: boolean }) => {
        const manifest = await loadManifest(options);
        const body = await show(manifest, { view: "project", ...(activate === false ? { activate: false } : {}) });
        return { ...success(body, projectFallbackText(body)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    server.registerTool("generate_project_explanations", {
        title: "Generate project explanations",
        description: "Generate concise AI descriptions for the files and directories already returned by show_project_structure. Use only when the user asks for semantic project explanations beyond raw structure and imports.",
        inputSchema: activateInput,
        annotations,
        _meta: { ui: { resourceUri: DETAIL_APP_URI }, "openai/outputTemplate": DETAIL_APP_URI },
    }, guarded(async ({ activate }: { activate?: boolean }) => {
        const manifest = await loadManifest(options);
        const body = await show(manifest, { view: "project", run: true, ...(activate === false ? { activate: false } : {}) });
        return { ...success(body, projectFallbackText(body)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    server.registerTool("create_code_diagram", {
        title: "Create a code diagram",
        description: "Use when the user asks to visualize or explain the flow, reading order, or dependencies of a named behavior. Always pass an absolute entry Python, JavaScript, or TypeScript file so the correct workspace is selected. The result opens only as the same wide HTML Webview used by other AI Code Guide modes, without attaching an MCP App card: nodes navigate the shared code pane, and VS Code receives a mirrored view.",
        inputSchema: {
            question: z.string().min(1).max(1000).describe("What the user wants to understand about this codebase"),
            file: z.string().min(1).refine(path.isAbsolute, "Entry file must be an absolute path").describe("Absolute entry Python, JavaScript, or TypeScript file; its project opens in VS Code if it is not connected yet"),
            ...activateInput,
        },
        annotations,
        _meta: {
            "openai/toolInvocation/invoking": "コード図を作成しています…",
            "openai/toolInvocation/invoked": "コード図を作成しました。",
        },
    }, guarded(async ({ question, file, activate }: { question: string; file: string; activate?: boolean }) => {
        // AI_NOTE: 質問文内のパスは接続先選択に使えない。同名の相対パスが別workspaceにもあり得るため、
        // 絶対入口fileを既存の安全なworkspaceFile検証へ通し、そのファイルを含むbridgeだけへ送る。
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        const body = publicDiagramBody(await show(manifest, {
            view: "diagram", question, file: relative, run: true,
            ...(activate === false ? { activate: false } : {}),
        }));
        const { htmlPath: _htmlPath, ...conversationBody } = body;
        return {
            ...success(conversationBody, diagramFallbackText(conversationBody)),
            // component専用_metaだけに絶対workspaceを置き、モデルへローカルパスを渡さない。
            // UIはこれとnode.fileを組み合わせ、既存show_standard_viewをtools/callして安全に移動する。
            _meta: { diagramWorkspaceRoot: manifest.workspaceRoot },
        };
    }));

    server.registerTool("show_inline_annotations", {
        title: "Show saved inline explanations",
        description: "Use only when the user explicitly asks for saved, cached, or existing inline explanations. Return previously generated explanations without starting a new LLM call or attaching a narrow inline MCP App card. For a normal request to see inline explanations, use generate_inline_annotations instead; if this saved-only lookup was used and returns no explanations, continue with generation in the same turn. The result includes a wide Codex browser URL; open it in the built-in browser panel when available and include [解説を開く](<codexView.url>) in the final answer. VS Code remains available as a separate synchronized view.",
        inputSchema: { ...fileInput, ...activateInput },
        annotations,
    }, guarded(async ({ file, activate }: { file: string; activate?: boolean }) => {
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        const body = await show(manifest, { view: "inline", file: relative, ...(activate === false ? { activate: false } : {}) });
        return { ...success(body, annotationsFallbackText(body)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    server.registerTool("generate_inline_annotations", {
        title: "Generate inline explanations",
        description: "Use the configured LLM to build a hover dictionary for variables, functions, methods, and classes without attaching a narrow inline MCP App card. A normal request to see or use inline explanations counts as a request to generate them unless the user explicitly asks for saved results only. Omit startLine/endLine for the whole file, or provide both to merge explanations into that contextual range; already-open browser previews for the same file update automatically. On success, open the returned wide Codex browser URL when available and include [解説を開く](<codexView.url>) in the final answer.",
        inputSchema: {
            ...fileInput,
            ...activateInput,
            startLine: z.number().int().positive().optional().describe("Optional 1-based first line of a selected range"),
            endLine: z.number().int().positive().optional().describe("Optional 1-based last line of a selected range"),
        },
        annotations,
    }, guarded(async ({ file, startLine, endLine, activate }: { file: string; startLine?: number; endLine?: number; activate?: boolean }) => {
        if ((startLine === undefined) !== (endLine === undefined) || (startLine !== undefined && endLine! < startLine)) {
            throw new Error("startLine and endLine must be provided together in ascending order.");
        }
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        const body = await show(manifest, {
            view: "inline", file: relative, run: true,
            ...(startLine !== undefined ? { startLine, endLine } : {}),
            ...(activate === false ? { activate: false } : {}),
        });
        return { ...success(body, annotationsFallbackText(body)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    server.registerTool("revise_inline_annotations", {
        title: "Revise inline explanations",
        description: "Apply conversational feedback to saved inline explanations. First use show_inline_annotations to obtain exact annotation ids. Pass removeAnnotationIds to permanently remove only those explanations, or hideAnnotationIds to keep them saved but omit them from VS Code and Codex views. Optionally provide startLine/endLine to generate replacement explanations for that range in the same operation; if generation fails, removals are rolled back. Open the returned wide Codex browser URL when available and include [解説を開く](<codexView.url>) in the final answer.",
        inputSchema: {
            ...fileInput,
            ...activateInput,
            removeAnnotationIds: z.array(z.string().min(1).max(200)).max(50).optional().describe("Exact saved annotation ids to permanently remove"),
            hideAnnotationIds: z.array(z.string().min(1).max(200)).max(50).optional().describe("Exact saved annotation ids to hide without deleting"),
            startLine: z.number().int().positive().optional().describe("Optional 1-based first line for replacement generation"),
            endLine: z.number().int().positive().optional().describe("Optional 1-based last line for replacement generation"),
        },
        annotations,
    }, guarded(async ({ file, removeAnnotationIds, hideAnnotationIds, startLine, endLine, activate }: {
        file: string;
        removeAnnotationIds?: string[];
        hideAnnotationIds?: string[];
        startLine?: number;
        endLine?: number;
        activate?: boolean;
    }) => {
        if ((startLine === undefined) !== (endLine === undefined) || (startLine !== undefined && endLine! < startLine)) {
            throw new Error("startLine and endLine must be provided together in ascending order.");
        }
        if (!(removeAnnotationIds?.length || hideAnnotationIds?.length || startLine !== undefined)) {
            throw new Error("Provide annotation ids to remove or hide, or a replacement line range.");
        }
        const overlap = removeAnnotationIds?.find((id) => hideAnnotationIds?.includes(id));
        if (overlap) throw new Error(`Annotation ${overlap} cannot be removed and hidden together.`);
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        const body = await show(manifest, {
            view: "inline",
            file: relative,
            ...(removeAnnotationIds?.length ? { removeAnnotationIds } : {}),
            ...(hideAnnotationIds?.length ? { hideAnnotationIds } : {}),
            ...(startLine !== undefined ? { startLine, endLine, run: true } : {}),
            ...(activate === false ? { activate: false } : {}),
        });
        return { ...success(body, annotationsFallbackText(body)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    server.registerTool("show_saved_trace", {
        title: "Show saved execution trace",
        description: "Use only when the user explicitly asks for a saved, cached, or existing execution trace. Return cached traces directly in a wide Codex browser view, without attaching a narrow inline MCP App card. For a normal request to see an execution trace, use run_trace instead; if this saved-only lookup was used and returns no trace, continue with run_trace in the same turn. Provide one line for a single function or method, or zero, one, or many function/Class.method names. Cache misses never generate examples or execute Python by themselves. On success with codexView.url, the same turn's final answer MUST name the target briefly and include [トレースを開く](<codexView.url>); showing the VS Code view is separate and does not replace the link. In Codex, also open that URL with the native browser-panel opener when available. Only if the URL is absent, report that and suggest the VS Code AI Code Guide trace view.",
        inputSchema: {
            ...fileInput,
            ...activateInput,
            line: z.number().int().positive().optional().describe("Optional 1-based line inside one function"),
            functions: functionsInput.optional(),
            arguments: z.record(z.string(), z.unknown()).optional().describe("Exact keyword arguments used for the saved single-function trace"),
        },
        annotations,
    }, guarded(async ({ file, line, functions, arguments: callArguments, activate }: { file: string; line?: number; functions?: string[]; arguments?: Record<string, unknown>; activate?: boolean }) => {
        if (line === undefined && functions === undefined) throw new Error("Provide line or functions.");
        if (callArguments !== undefined && functions?.length !== 1) throw new Error("arguments requires exactly one function.");
        if (languageIdForPath(file) !== "python") throw new Error("Execution traces currently support Python files only.");
        const manifest = await loadManifest(options, file);
        const relative = workspaceFile(file, manifest, workspacePath);
        const body = await show(manifest, {
            view: "trace", file: relative,
            ...(line === undefined ? {} : { line }),
            ...(functions === undefined ? {} : { functions }),
            ...(callArguments === undefined ? {} : { arguments: callArguments }),
            ...(activate === false ? { activate: false } : {}),
        });
        return { ...traceSuccess(body, traceFallbackText(body, relative, line, functions, false)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    server.registerTool("run_trace", {
        title: "Run a concrete execution trace",
        description: "Ask the configured LLM for an example, execute selected Python functions or class methods in a disposable workspace copy, and return line-by-line values directly in a wide Codex browser view without attaching a narrow inline MCP App card. Local file and TemporaryDirectory operations may run inside the sandbox; writes outside it, network, subprocess, and unresolved dynamic execution are blocked. Preserve the exact requested function and arguments even when safety is unknown: return its rejected attempt and never silently substitute a safer target. A normal request to see or use an execution trace counts as an explicit request for runtime values and concrete execution evidence; use this tool unless the user specifically asks for saved results only. On success with codexView.url, the same turn's final answer MUST name the target briefly and include [トレースを開く](<codexView.url>); showing the VS Code view is separate and does not replace the link. In Codex, also open that URL with the native browser-panel opener when available. Only if the URL is absent, report that and suggest the VS Code AI Code Guide trace view.",
        inputSchema: {
            file: z.union([z.string().min(1), z.null()]).optional().describe("Python file path. Omit or send null only for an arguments-only retry when exactly one trace entry is open."),
            ...activateInput,
            line: z.union([z.number().int().positive(), z.null()]).optional().describe("Optional 1-based line inside one function"),
            functions: z.union([functionsInput, z.null()]).optional(),
            arguments: z.record(z.string(), z.unknown()).optional().describe("Exact JSON keyword arguments for one function. When supplied, these values are executed exactly and are never replaced by generated examples."),
            newEntry: z.boolean().optional().describe("Set true only when the user explicitly asks to abandon an open recovery journey and start a new trace entry."),
        },
        annotations,
    }, guarded(async ({ file, line, functions, arguments: callArguments, activate, newEntry }: { file?: string | null; line?: number | null; functions?: string[] | null; arguments?: Record<string, unknown>; activate?: boolean; newEntry?: boolean }) => {
        if (newEntry && file == null) throw new Error("newEntry requires an explicit file and function or line.");
        const soleOpenEntry = file == null ? [...openTraceEntries.values()] : [];
        if (file == null && soleOpenEntry.length !== 1) {
            throw new Error(`An arguments-only retry without file requires exactly one open trace entry; found ${soleOpenEntry.length}.`);
        }
        const requestedFile = file ?? soleOpenEntry[0].absoluteFile;
        if (languageIdForPath(requestedFile) !== "python") throw new Error("Execution traces currently support Python files only.");
        const manifest = await loadManifest(options, requestedFile);
        const relative = workspaceFile(requestedFile, manifest, workspacePath);
        const entryKey = `${path.resolve(manifest.workspaceRoot).toLowerCase()}::${relative.toLowerCase()}`;
        if (newEntry) openTraceEntries.delete(entryKey);
        const openEntry = openTraceEntries.get(entryKey);
        const effectiveFunctions = functions ?? (callArguments !== undefined && openEntry ? [openEntry.functionName] : undefined);
        if (line == null && effectiveFunctions === undefined) throw new Error("Provide line or functions, or arguments for the file's open trace entry.");
        if (callArguments !== undefined && effectiveFunctions?.length !== 1) throw new Error("arguments requires exactly one function or an open single-function trace entry.");
        const body = await show(manifest, {
            view: "trace", file: relative, run: true,
            ...(line == null ? {} : { line }),
            ...(effectiveFunctions === undefined ? {} : { functions: effectiveFunctions }),
            ...(callArguments === undefined ? {} : { arguments: callArguments }),
            ...(openEntry ? { traceEntryId: openEntry.id } : {}),
            ...(activate === false ? { activate: false } : {}),
        });
        const trace = body.trace && typeof body.trace === "object" ? body.trace as Record<string, unknown> : null;
        const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
        if (trace?.entryState === "open" && attempts.length > 0 && typeof trace.traceEntryId === "string" && effectiveFunctions?.length === 1) {
            openTraceEntries.set(entryKey, {
                id: trace.traceEntryId,
                functionName: effectiveFunctions[0],
                absoluteFile: path.resolve(manifest.workspaceRoot, relative),
            });
        } else if (trace?.entryState === "closed") {
            openTraceEntries.delete(entryKey);
        }
        return { ...traceSuccess(body, traceFallbackText(body, relative, line ?? undefined, effectiveFunctions, true)), _meta: { guideWorkspaceRoot: manifest.workspaceRoot } };
    }));

    return server;
}

async function main(): Promise<void> {
    const options = cliOptions(process.argv.slice(2), process.env);
    const { workspacePath, httpPort, codeCommand, connectTimeoutMs } = options;
    if (httpPort !== undefined) {
        // AI_NOTE: ChatGPT/ClaudeのリモートコネクタはStreamable HTTPを要求する。
        // loopbackだけで待ち受け、公開が必要な時は利用者が明示したHTTPSトンネルへ委ねる。
        const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
        const httpServer = http.createServer(async (request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (request.method === "OPTIONS" && url.pathname === "/mcp") {
                response.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version",
                    "Access-Control-Expose-Headers": "Mcp-Session-Id",
                });
                response.end();
                return;
            }
            if (request.method === "GET" && url.pathname === "/") {
                response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("AI Code Guide MCP server");
                return;
            }
            if (url.pathname !== "/mcp" || !request.method || !["POST", "GET", "DELETE"].includes(request.method)) {
                response.writeHead(404).end("Not Found");
                return;
            }
            response.setHeader("Access-Control-Allow-Origin", "*");
            response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
            try {
                let parsedBody: unknown;
                if (request.method === "POST") {
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    for await (const chunk of request) {
                        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        bytes += value.length;
                        if (bytes > 1024 * 1024) throw new Error("MCP request body is too large");
                        chunks.push(value);
                    }
                    parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                }
                const sessionId = typeof request.headers["mcp-session-id"] === "string"
                    ? request.headers["mcp-session-id"]
                    : undefined;
                let session = sessionId ? sessions.get(sessionId) : undefined;
                if (!session && request.method === "POST" && isInitializeRequest(parsedBody)) {
                    let transport!: StreamableHTTPServerTransport;
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: randomUUID,
                        enableJsonResponse: true,
                        onsessioninitialized: (initializedId) => {
                            sessions.set(initializedId, { transport, server: sessionServer });
                        },
                    });
                    const sessionServer = createServer(workspacePath, codeCommand, connectTimeoutMs);
                    transport.onclose = () => {
                        const initializedId = transport.sessionId;
                        if (initializedId) sessions.delete(initializedId);
                    };
                    await sessionServer.connect(transport);
                    session = { transport, server: sessionServer };
                }
                if (!session) {
                    response.writeHead(400, { "Content-Type": "application/json" });
                    response.end(JSON.stringify({
                        jsonrpc: "2.0",
                        error: { code: -32000, message: "No valid MCP session" },
                        id: null,
                    }));
                    return;
                }
                await session.transport.handleRequest(request, response, parsedBody);
            } catch (error) {
                console.error("AI Code Guide MCP HTTP request failed:", error);
                if (!response.headersSent) response.writeHead(500).end("Internal Server Error");
            }
        });
        await new Promise<void>((resolve, reject) => {
            httpServer.once("error", reject);
            httpServer.listen(httpPort, "127.0.0.1", resolve);
        });
        const address = httpServer.address();
        const actualPort = typeof address === "object" && address ? address.port : httpPort;
        console.error(`AI Code Guide MCP HTTP server ${SERVER_VERSION} running at http://127.0.0.1:${actualPort}/mcp for ${workspacePath}`);
        return;
    }
    const server = createServer(workspacePath, codeCommand, connectTimeoutMs);
    await server.connect(new StdioServerTransport());
    console.error(`AI Code Guide MCP server ${SERVER_VERSION} running for ${workspacePath}`);
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
