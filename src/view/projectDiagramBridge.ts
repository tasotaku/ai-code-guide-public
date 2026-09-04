import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { LocatedProjectDiagram } from "./projectDiagram";
import type { TracePlayback } from "../inline/tracePlayback";
import { buildProjectDiagramHtml } from "./projectDiagram";
import { buildTraceWebView, type TraceWebViewData } from "./traceWebView";
import { buildInlineWebView, type InlineWebViewData } from "./inlineWebView";
import { buildStandardWebView, type StandardWebViewData } from "./standardWebView";
import { buildDiagramWebView, type DiagramWebViewData } from "./diagramWebView";
import { buildCombinedWebView, type CombinedWebViewData } from "./combinedWebView";
import { focusStandardView } from "./standardFocus";

export type ProjectDiagramBridgeLink = { baseUrl: string; token: string };

export const AGENT_VIEWS = ["standard", "overview", "project", "diagram", "inline", "trace"] as const;
export type AgentView = typeof AGENT_VIEWS[number];
export type AgentCodeLine = { line: number; text: string };
export type AgentTraceAttempt = {
    traceEntryId: string;
    attemptNumber: number;
    runReceiptId: string;
    target: string;
    arguments?: Record<string, unknown>;
    safetyDecision: "safe" | "known-unsafe" | "safety-unknown";
    safetyReason: string;
    retryGuidance?: string;
    states: string[];
    startedAt: string;
    endedAt: string;
    invocationCount: 0 | 1;
    runId?: string;
    returnValue?: { short: string; full: string } | null;
    exception?: string | null;
    sourceSha256: string;
    traceSha256: string;
    artifactSha256: string;
    surfaces: string[];
};
export type AgentShowRequest = {
    view: AgentView;
    absoluteFile?: string;
    line?: number;
    scopeLine?: number;
    expandLines?: number[];
    visibleExpandLines?: number[];
    functions?: string[];
    arguments?: Record<string, unknown>;
    traceEntryId?: string;
    startLine?: number;
    endLine?: number;
    removeAnnotationIds?: string[];
    hideAnnotationIds?: string[];
    question?: string;
    run?: boolean;
    activate?: boolean;
    focusWindow?: boolean;
    backgroundAction?: "read" | "generate" | "stop";
    retryLayer?: "background" | "inline";
    expectedSourceSha256?: string;
};
export type AgentLayerState = {
    status: "idle" | "queued" | "generating" | "ready" | "stale" | "stopped" | "error";
    completed: number;
    total: number;
    message?: string;
    retryable?: boolean;
};
export type AgentShowResult = {
    ok: true;
    view: AgentView;
    file?: string;
    line?: number;
    sourceSha256?: string;
    revision?: number;
    sourceChanged?: boolean;
    layers?: Partial<Record<"background" | "inline" | "diagram" | "trace", AgentLayerState>>;
    jumpReceipt?: {
        receiptId: string;
        acknowledged: true;
        file: string;
        line: number;
        selectionEmpty: true;
    };
    htmlPath?: string;
    codexView?: { type: "browser"; url: string; view: AgentView };
    question?: string;
    diagram?: LocatedProjectDiagram;
    standard?: {
        title: string;
        file: string;
        role?: string;
        source: AgentCodeLine[];
        backgroundRanges?: Array<{ lineStart: number; lineEnd: number; label?: string; colorIndex?: number }>;
        items: Array<{
            id: string;
            kind: "function" | "class" | "constant";
            label: string;
            line: number;
            lineEnd: number;
            parent?: string;
            color?: string;
            meaningRanges?: Array<{
                lineStart: number;
                lineEnd: number;
                label?: string;
                colorIndex?: number;
            }>;
            description?: string;
            expanded?: boolean;
            expansion?: {
                overview: {
                    purpose: string;
                    input: string;
                    output: string;
                    state?: string;
                    behavior?: string;
                    note?: string;
                } | null;
                blocks: Array<{
                    label: string;
                    lineStart: number;
                    lineEnd: number;
                    description: string;
                }>;
            };
        }>;
    };
    overview?: {
        title: string;
        file: string;
        kind?: string;
        role?: string;
        relationships: Array<{ from: string; to: string; line?: number }>;
        readingOrder: Array<{ id: string; label: string; kind: "function" | "class" | "constant"; line: number }>;
        groups: Array<{
            label: string;
            items: Array<{ id: string; label: string; kind: "function" | "class" | "constant"; line: number; description?: string }>;
        }>;
    };
    project?: {
        files: Array<{ id: string; path: string; directory: string; functions: string[]; description?: string }>;
        imports: Array<{ from: string; to: string; label: string }>;
        directories: Array<{ path: string; description?: string }>;
    };
    annotations?: {
        generatedAt?: string;
        changes?: { removedIds: string[]; hiddenIds: string[] };
        context?: {
            label: string;
            startLine: number;
            endLine: number;
            code: AgentCodeLine[];
        };
        items: Array<{
            id: string;
            kind: "symbol";
            label: string;
            explanation: string;
            startLine: number;
            endLine: number;
            startCol?: number | null;
            endCol?: number | null;
            scope?: "full" | "range";
            symbolKey?: string;
            symbolKind?: "variable" | "function" | "method" | "class";
            code: AgentCodeLine[];
        }>;
        conversations?: Record<string, Array<{ role: "user" | "assistant"; content: string }>>;
    };
    trace?: {
        traceEntryId?: string;
        entryState?: "open" | "closed";
        attempts?: AgentTraceAttempt[];
        funcNames: string[];
        loopCount: number;
            functions: Array<{
                funcName: string;
                color?: string;
                sourceSha256?: string;
            runReceiptId?: string;
            role?: string;
            location?: string;
            controlPath?: Array<{ line: number; outcome: boolean }>;
            keyValues?: Array<{ line: number; text: string }>;
            safetyDecision?: "safe" | "known-unsafe" | "safety-unknown";
            runId?: string;
            executedAt?: string;
            arguments?: Record<string, unknown>;
            returnValue?: { short: string; full: string } | null;
            error?: string | null;
            stage?: "setup" | "run";
            calls?: Array<{
                sequence: number;
                depth: number;
                function: string;
                line: number;
                arguments: Record<string, { short: string; full: string }>;
                return_value: { short: string; full: string } | null;
                exception?: { type: string; message: string } | null;
            }>;
            controlPoints?: Array<{ line: number; kind: "if" | "return" | "assert"; body_start?: number; body_end?: number }>;
            assertions?: Array<{
                line: number;
                kind: "assert" | "unittest";
                method: string;
                outcome: boolean;
                arguments?: Array<{ short: string; full: string }>;
                keyword_arguments?: Record<string, { short: string; full: string }>;
                exception?: { type: string; message: string };
                iter_path: [number, number][];
            }>;
            executedLines?: number[];
            pathEvents?: Array<{ line: number; kind: "if"; outcome: boolean; iter_path: [number, number][] }>;
            startLine: number;
            endLine: number;
            code: AgentCodeLine[];
            playback?: TracePlayback;
            loop?: { headerLine: number; total: number; actualTotal: number };
            iterations: Array<{ number: number; values: Array<{ line: number; text: string }> }>;
        }>;
    };
};

type BridgeOptions = {
    getWorkspaceRoot: () => string | undefined;
    openFile: (absolutePath: string, zeroBasedLine: number) => Promise<void>;
    showView?: (request: AgentShowRequest) => Promise<AgentShowResult>;
    refineSymbol?: (args: {
        file: string;
        symbolKey: string;
        display: string;
        kind: "variable" | "function" | "method" | "class";
        current: string;
        question: string;
        history: Array<{ role: "user" | "assistant"; content: string }>;
        expectedSourceSha256?: string;
    }) => Promise<{ answer: string; explanation: string }>;
    updateSymbolExplanation?: (file: string, symbolKey: string, explanation: string, expectedSourceSha256?: string) => Promise<void>;
    getManifestPath?: () => string | undefined;
    getRegistryPath?: () => string | undefined;
    getActivationPath?: () => string | undefined;
    token?: string;
};

type CombinedCodexView = {
    file?: string;
    standard?: AgentShowResult;
    diagram?: AgentShowResult;
    inline?: AgentShowResult;
    trace?: AgentShowResult;
    layers?: AgentShowResult["layers"];
    additionRequests?: Partial<Record<"diagram" | "trace", AgentShowRequest>>;
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_AGENT_TARGETS = 50;
const MAX_CODEX_VIEWS = 30;

// AI_NOTE: file://ページからvscode://を直接開く挙動は埋め込みブラウザごとに不安定なため、
// loopback HTTPを拡張が受け、検証済みワークスペース内ファイルだけをVS Code APIで開く。
export class ProjectDiagramBridge {
    private readonly token: string;
    private server: http.Server | null = null;
    private startPromise: Promise<ProjectDiagramBridgeLink | null> | null = null;
    private link: ProjectDiagramBridgeLink | null = null;
    private readonly writtenManifestPaths = new Set<string>();
    private readonly codexViews = new Map<string, AgentShowResult>();
    private readonly codexSources = new Map<string, AgentShowRequest>();
    private readonly preparationJobs = new Set<Promise<void>>();
    private readonly combinedCodexViews = new Map<string, CombinedCodexView>();
    private readonly openedCodexViews = new Map<string, { view: AgentView | "combined"; openedAt: string }>();
    private readonly symbolVersions = new Map<string, string[]>();

    constructor(private readonly options: BridgeOptions) {
        this.token = options.token ?? crypto.randomBytes(24).toString("hex");
    }

    start(): Promise<ProjectDiagramBridgeLink | null> {
        if (this.startPromise) return this.startPromise;
        this.writeActivationMarker();
        this.startPromise = new Promise((resolve) => {
            const server = http.createServer((request, response) => {
                void this.handle(request, response);
            });
            this.server = server;
            server.once("error", (error) => {
                console.error("[AI Code Guide] project diagram bridge failed:", error);
                resolve(null);
            });
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    resolve(null);
                    return;
                }
                server.unref();
                const link = { baseUrl: `http://127.0.0.1:${address.port}`, token: this.token };
                this.link = link;
                void this.writeManifest(link).finally(() => resolve(link));
            });
        });
        return this.startPromise;
    }

    dispose(): void {
        this.server?.close();
        this.server = null;
        this.link = null;
        this.codexViews.clear();
        this.codexSources.clear();
        this.combinedCodexViews.clear();
        this.openedCodexViews.clear();
        this.removeManifest();
        this.removeActivationMarker();
    }

    // AI_NOTE: MCP側が「拡張未起動」と「拡張は起動したがbridge作成失敗」を区別できるよう、
    // tokenを含まない起動印をbridge listen前に書く。mtimeは今回のVS Code起動より新しい印だけを診断に使う。
    private writeActivationMarker(): void {
        const markerPath = this.options.getActivationPath?.();
        const workspaceRoot = this.options.getWorkspaceRoot();
        if (!markerPath || !workspaceRoot) return;
        const tempPath = `${markerPath}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
            fs.writeFileSync(tempPath, JSON.stringify({
                version: 1,
                workspaceRoot: path.resolve(workspaceRoot),
                pid: process.pid,
                activatedAt: new Date().toISOString(),
            }, null, 2), { encoding: "utf8", mode: 0o600 });
            fs.renameSync(tempPath, markerPath);
            fs.chmodSync(markerPath, 0o600);
        } catch (error) {
            console.error("[AI Code Guide] activation marker failed:", error);
            try { fs.unlinkSync(tempPath); } catch { /* 未作成なら何もしない */ }
        }
    }

    private removeActivationMarker(): void {
        const markerPath = this.options.getActivationPath?.();
        if (!markerPath) return;
        try {
            const current = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { pid?: number };
            if (current.pid === process.pid) fs.unlinkSync(markerPath);
        } catch { /* 既に削除済み、または別プロセスが置換済みなら触らない */ }
    }

    // AI_NOTE: CLIとデスクトップアプリの両方が起動cwdに依存せず拡張を発見できるよう、
    // ワークスペース内マニフェストとユーザー領域レジストリへ同じ接続情報を原子的に書く。
    // トークンを含むため、ディレクトリは所有者だけ、ファイルも所有者だけに制限する。
    private async writeManifest(link: ProjectDiagramBridgeLink): Promise<void> {
        const workspaceRoot = this.options.getWorkspaceRoot();
        if (!workspaceRoot) return;
        const body = JSON.stringify({
            version: 1,
            ...link,
            workspaceRoot: path.resolve(workspaceRoot),
            pid: process.pid,
            startedAt: new Date().toISOString(),
        }, null, 2);
        const paths = [this.options.getManifestPath?.(), this.options.getRegistryPath?.()]
            .filter((value): value is string => Boolean(value));
        for (const manifestPath of new Set(paths)) {
            const dir = path.dirname(manifestPath);
            const tempPath = `${manifestPath}.${process.pid}.tmp`;
            try {
                await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
                await fs.promises.chmod(dir, 0o700);
                await fs.promises.writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
                await fs.promises.rename(tempPath, manifestPath);
                await fs.promises.chmod(manifestPath, 0o600);
                this.writtenManifestPaths.add(manifestPath);
            } catch (error) {
                console.error("[AI Code Guide] agent bridge manifest failed:", error);
                try { await fs.promises.unlink(tempPath); } catch { /* 未作成なら何もしない */ }
            }
        }
    }

    private removeManifest(): void {
        for (const manifestPath of this.writtenManifestPaths) {
            try {
                const current = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { token?: string };
                if (current.token === this.token) fs.unlinkSync(manifestPath);
            } catch { /* 既に削除済み、または別プロセスが置換済みなら触らない */ }
        }
        this.writtenManifestPaths.clear();
    }

    private reply(response: http.ServerResponse, status: number, message = ""): void {
        response.writeHead(status, {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
        });
        response.end(message);
    }

    private replyJson(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
        response.writeHead(status, {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
        });
        response.end(JSON.stringify(body));
    }

    private replyHtml(response: http.ServerResponse, status: number, html: string): void {
        response.writeHead(status, {
            "Cache-Control": "no-store",
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        });
        response.end(html);
    }

    private itemOverlaps(
        item: NonNullable<AgentShowResult["annotations"]>["items"][number],
        startLine: number,
        endLine: number,
    ): boolean {
        return item.endLine >= startLine && item.startLine <= endLine;
    }

    private symbolOnlyInlineResult(result: AgentShowResult): AgentShowResult {
        if (result.view !== "inline" || !result.annotations) return result;
        return {
            ...result,
            annotations: {
                ...result.annotations,
                items: result.annotations.items.filter((item) => item.kind === "symbol" && Boolean(item.symbolKey)),
            },
        };
    }

    // AI_NOTE: 範囲生成は永続キャッシュ上で既存注釈へマージされる。同じファイルの既存Webプレビューも
    // スナップショットのまま取り残さず、更新範囲だけを最新応答へ差し替える。全体要求は全件を正とする。
    private updateStoredInlineViews(result: AgentShowResult, source: AgentShowRequest | undefined): void {
        // AI_NOTE: 同じファイル名でも別snapshotへの説明移植はしない。
        if (result.view !== "inline" || !result.file || !result.annotations || !source) return;
        const updateStart = source.startLine;
        const updateEnd = source.endLine;
        const omittedIds = new Set([
            ...(result.annotations.changes?.removedIds ?? []),
            ...(result.annotations.changes?.hiddenIds ?? []),
        ]);
        for (const [id, stored] of this.codexViews) {
            if (stored.view !== "inline" || stored.file !== result.file || !stored.annotations) continue;
            if (stored.sourceSha256 !== result.sourceSha256) continue;
            const retained = stored.annotations.items.filter((item) => !omittedIds.has(item.id));
            const merged = updateStart === undefined || updateEnd === undefined
                ? result.annotations.items
                : [
                    ...retained.filter((item) => !this.itemOverlaps(item, updateStart, updateEnd)),
                    ...result.annotations.items,
                ];
            const context = stored.annotations.context;
            const visible = context
                ? merged.filter((item) => this.itemOverlaps(item, context.startLine, context.endLine))
                : merged;
            const deduped = [...new Map(visible.map((item) => [item.id, item])).values()]
                .sort((left, right) => left.startLine - right.startLine || (left.startCol ?? 0) - (right.startCol ?? 0));
            this.codexViews.set(id, {
                ...stored,
                annotations: {
                    ...stored.annotations,
                    ...(result.annotations.generatedAt ? { generatedAt: result.annotations.generatedAt } : {}),
                    items: deduped,
                },
            });
        }
    }

    private updateStoredSymbol(
        file: string,
        symbolKey: string,
        explanation: string,
        conversation: Array<{ role: "user" | "assistant"; content: string }>,
        sourceSha256?: string,
    ): void {
        // AI_NOTE: 質問による更新もコードidentityで分離し、旧URLから最新コードへ書き戻さない。
        for (const [id, stored] of this.codexViews) {
            if (stored.file !== file || !stored.annotations || stored.sourceSha256 !== sourceSha256) continue;
            this.codexViews.set(id, {
                ...stored,
                annotations: {
                    ...stored.annotations,
                    items: stored.annotations.items.map((item) => item.symbolKey === symbolKey
                        ? { ...item, explanation }
                        : item),
                    conversations: {
                        ...(stored.annotations.conversations ?? {}),
                        [symbolKey]: conversation,
                    },
                },
            });
        }
        for (const combined of this.combinedCodexViews.values()) {
            const key = combined.inline?.annotations ? "inline" : "standard";
            const stored = combined[key];
            if (!stored || stored.file !== file || !stored.annotations || stored.sourceSha256 !== sourceSha256) continue;
            combined[key] = {
                ...stored,
                annotations: {
                    ...stored.annotations,
                    items: stored.annotations.items.map((item) => item.symbolKey === symbolKey
                        ? { ...item, explanation }
                        : item),
                    conversations: {
                        ...(stored.annotations.conversations ?? {}),
                        [symbolKey]: conversation,
                    },
                },
            };
        }
    }

    private storeCodexView(result: AgentShowResult, source?: AgentShowRequest): AgentShowResult {
        // AI_NOTE: UIの開閉状態や後着更新が他URLへ漏れないようsnapshotを複製する。
        const publicResult = JSON.parse(JSON.stringify(this.symbolOnlyInlineResult(result))) as AgentShowResult;
        const supported = (publicResult.view === "trace" && publicResult.trace)
            || (publicResult.view === "inline" && publicResult.annotations)
            || (publicResult.view === "standard" && publicResult.standard)
            || (publicResult.view === "diagram" && publicResult.diagram);
        if (!this.link || !supported) return publicResult;
        this.updateStoredInlineViews(publicResult, source);
        const id = crypto.randomBytes(24).toString("hex");
        this.codexViews.set(id, publicResult);
        if (source) this.codexSources.set(id, { ...source });
        while (this.codexViews.size > MAX_CODEX_VIEWS) {
            const oldest = this.codexViews.keys().next().value as string | undefined;
            if (!oldest) break;
            this.codexViews.delete(oldest);
            this.codexSources.delete(oldest);
        }
        return {
            ...publicResult,
            codexView: { type: "browser", url: `${this.link.baseUrl}/view/${id}`, view: publicResult.view },
        };
    }

    private async refreshSnapshot(result: AgentShowResult, action: "read" | "generate" | "stop", source?: AgentShowRequest, retryLayer?: "background" | "inline"): Promise<AgentShowResult> {
        // AI_NOTE: /stateはcache読取だけ。古いコードを現在の文書へ無言で置換しない。
        if (!result.sourceSha256 || !result.file || !this.options.showView) return result;
        const resolved = this.resolveWorkspaceFile(result.file);
        if (!("absoluteFile" in resolved)) throw new Error(resolved.message);
        try {
            const next = await this.options.showView({
                view: "standard", absoluteFile: resolved.absoluteFile, activate: false,
                backgroundAction: action, expectedSourceSha256: result.sourceSha256,
                ...(retryLayer ? { retryLayer } : {}),
            });
            if (next.sourceSha256 !== result.sourceSha256) throw new Error("Source changed; request a new view");
            const standard = next.standard && result.standard ? {
                ...focusStandardView(next.standard, source?.scopeLine, source?.visibleExpandLines),
                items: focusStandardView(next.standard, source?.scopeLine, source?.visibleExpandLines).items.map(item => {
                    const previous = result.standard!.items.find(candidate => candidate.id === item.id);
                    const sameRanges = JSON.stringify(previous?.meaningRanges ?? result.standard?.backgroundRanges) === JSON.stringify(item.meaningRanges ?? next.standard?.backgroundRanges);
                    return previous?.expansion && sameRanges ? { ...item, expansion: previous.expansion, expanded: previous.expanded } : item;
                }),
            } : result.standard;
            return { ...result, ...next, view: result.view, standard, sourceChanged: false };
        } catch (error) {
            if (error instanceof Error && error.message.includes("Source changed")) return { ...result, sourceChanged: true };
            throw error;
        }
    }

    private combinedData(combined: CombinedCodexView): CombinedWebViewData {
        // AI_NOTE: 既定二層は標準snapshotから同時に届き、追加ジョブは独立した進捗を持つ。
        return {
            file: combined.file, standard: combined.standard?.standard,
            sourceSha256: combined.standard?.sourceSha256, revision: combined.standard?.revision,
            sourceChanged: combined.standard?.sourceChanged,
            layers: { ...combined.standard?.layers, ...combined.layers },
            diagram: combined.diagram?.diagram,
            ...(combined.diagram?.diagram ? { diagramHtml: buildProjectDiagramHtml(combined.diagram.diagram, undefined, undefined, { selectableNodes: true }) } : {}),
            annotations: combined.inline?.annotations ?? combined.standard?.annotations,
            trace: combined.trace?.trace,
        };
    }

    private async handleLayers(request: http.IncomingMessage, response: http.ServerResponse, id: string, result: AgentShowResult, combined?: CombinedCodexView): Promise<void> {
        // AI_NOTE: 生成は明示操作だけ。変更済みsnapshotからの更新は別URLを作り元コードを保持する。
        if (request.method !== "POST") { this.reply(response, 405, "Method Not Allowed"); return; }
        if (!result.standard) { this.reply(response, 400, "Standard view unavailable"); return; }
        let body: Record<string, unknown>;
        try { body = await this.readJsonBody(request); } catch { this.reply(response, 400, "Invalid JSON"); return; }
        if (body.action !== "generate" && body.action !== "stop") { this.reply(response, 400, "Invalid layer action"); return; }
        try {
            const next = await this.refreshSnapshot(result, body.action, this.codexSources.get(id));
            if (next.sourceChanged && body.action === "generate" && result.file && this.options.showView) {
                const resolved = this.resolveWorkspaceFile(result.file);
                if (!("absoluteFile" in resolved)) throw new Error(resolved.message);
                const source: AgentShowRequest = { view: "standard", absoluteFile: resolved.absoluteFile, backgroundAction: "generate", activate: false };
                this.replyJson(response, 200, this.storeCodexView(await this.options.showView(source), source));
                return;
            }
            if (combined) combined.standard = next; else this.codexViews.set(id, next);
            this.replyJson(response, 200, combined ? this.combinedData(combined) : next);
        } catch (error) { this.reply(response, 500, error instanceof Error ? error.message : "Layer action failed"); }
    }

    private startAddition(id: string, combined: CombinedCodexView, addition: "diagram" | "trace"): void {
        // AI_NOTE: 初回と再試行は同じ保存済み要求で実行し、成功層や別snapshotへ作用しない。
        const source = combined.additionRequests?.[addition];
        if (!source || !this.options.showView) return;
        combined.layers ??= {};
        combined.layers[addition] = { status: "generating", completed: 0, total: 1 };
        const job = Promise.resolve().then(() => this.options.showView!({ ...source })).then(result => {
            if (this.combinedCodexViews.get(id) !== combined) return;
            if (source.expectedSourceSha256 && result.sourceSha256 !== source.expectedSourceSha256) throw new Error("Source changed; request a new view");
            combined[addition] = JSON.parse(JSON.stringify(result));
            combined.layers![addition] = { status: "ready", completed: 1, total: 1 };
        }).catch(error => {
            if (this.combinedCodexViews.get(id) !== combined) return;
            const message = error instanceof Error ? error.message : "Generation failed";
            const changed = message.includes("Source changed");
            if (changed && combined.standard) combined.standard.sourceChanged = true;
            combined.layers![addition] = { status: "error", completed: 0, total: 1, message, retryable: !!source.expectedSourceSha256 && !changed };
        });
        this.preparationJobs.add(job);
        void job.finally(() => this.preparationJobs.delete(job));
    }

    private async handleRetry(request: http.IncomingMessage, response: http.ServerResponse, id: string, result: AgentShowResult, combined?: CombinedCodexView): Promise<void> {
        // AI_NOTE: capability URLに保存した対象だけを再試行。変更済みコードへの新URL生成は行わない。
        if (request.method !== "POST") { this.reply(response, 405, "Method Not Allowed"); return; }
        let body: Record<string, unknown>;
        try { body = await this.readJsonBody(request); } catch { this.reply(response, 400, "Invalid JSON"); return; }
        const layer = body.layer;
        if (layer !== "background" && layer !== "inline" && layer !== "diagram" && layer !== "trace") { this.reply(response, 400, "Invalid retry layer"); return; }
        if (!result.standard || !result.file || !result.sourceSha256 || !this.options.showView) { this.reply(response, 400, "Snapshot unavailable"); return; }
        try {
            const next = await this.refreshSnapshot(result, "read", this.codexSources.get(id));
            if (combined) combined.standard = next; else this.codexViews.set(id, next);
            if (next.sourceChanged) { this.reply(response, 409, "Source changed; request a new view"); return; }
            const state = layer === "background" || layer === "inline" ? next.layers?.[layer] : combined?.layers?.[layer];
            if (state?.status !== "error" || state.retryable === false) { this.reply(response, 409, "Layer is not retryable"); return; }
            if (layer === "diagram" || layer === "trace") {
                if (!combined?.additionRequests?.[layer]) { this.reply(response, 409, "Original request unavailable"); return; }
                this.startAddition(id, combined, layer);
            } else {
                const refreshed = await this.refreshSnapshot(next, "read", this.codexSources.get(id), layer);
                if (refreshed.sourceChanged) throw new Error("Source changed; request a new view");
                if (combined) combined.standard = refreshed; else this.codexViews.set(id, refreshed);
            }
            this.replyJson(response, 200, combined ? this.combinedData(combined) : this.codexViews.get(id)!);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Retry failed";
            this.reply(response, message.includes("Source changed") || message.includes("not retryable") ? 409 : 500, message);
        }
    }

    private diagramSources(diagram: LocatedProjectDiagram): Record<string, AgentCodeLine[]> {
        const sources: Record<string, AgentCodeLine[]> = {};
        for (const file of new Set(diagram.nodes.map((node) => node.file).filter(Boolean))) {
            const resolved = this.resolveWorkspaceFile(file);
            if (!("absoluteFile" in resolved)) continue;
            try {
                sources[file] = fs.readFileSync(resolved.absoluteFile, "utf8")
                    .split(/\r?\n/)
                    .map((text, index) => ({ line: index + 1, text }));
            } catch {
                // 読めない関連ファイルだけを空欄にし、図全体の表示は維持する。
            }
        }
        return sources;
    }

    private async handlePrepare(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        // AI_NOTE: MCP応答後も生成を拡張側が所有する。コードだけ先に返し、追加図/traceは同じsnapshotへ後着する。
        if (!this.options.showView) { this.reply(response, 501, "Agent views unavailable"); return; }
        let body: Record<string, unknown>;
        try { body = await this.readJsonBody(request); } catch { this.reply(response, 400, "Invalid JSON"); return; }
        const additions = Array.isArray(body.additions) ? [...new Set(body.additions)] : [];
        if (typeof body.file !== "string" || !Array.isArray(body.additions) || additions.some(value => value !== "diagram" && value !== "trace")
            || typeof body.question !== "string" || !body.question.trim() || body.question.length > 2000
            || (body.functions !== undefined && (!Array.isArray(body.functions) || body.functions.length !== 1 || typeof body.functions[0] !== "string" || !body.functions[0].trim() || body.functions[0].length > 200))) {
            this.reply(response, 400, "Invalid preparation request"); return;
        }
        const resolved = this.resolveWorkspaceFile(body.file);
        if (!("absoluteFile" in resolved)) { this.reply(response, resolved.status, resolved.message); return; }
        try {
            const initial = await this.options.showView({ view: "standard", absoluteFile: resolved.absoluteFile, backgroundAction: "generate", activate: false });
            if (!initial.standard) throw new Error("Standard snapshot unavailable");
            const id = crypto.randomBytes(24).toString("hex");
            const combined: CombinedCodexView = { file: initial.file, standard: JSON.parse(JSON.stringify(initial)), layers: {}, additionRequests: {} };
            this.combinedCodexViews.set(id, combined);
            while (this.combinedCodexViews.size > MAX_CODEX_VIEWS) this.combinedCodexViews.delete(this.combinedCodexViews.keys().next().value!);
            for (const addition of additions as Array<"diagram" | "trace">) {
                if (addition === "trace" && !body.functions) {
                    combined.layers!.trace = { status: "error", completed: 0, total: 1, retryable: false, message: "質問か対象に、実行する関数名を example() の形で含めてください。" };
                    continue;
                }
                combined.additionRequests![addition] = {
                    view: addition, absoluteFile: resolved.absoluteFile, activate: false, run: true,
                    question: body.question, ...(addition === "trace" ? { functions: body.functions as string[] } : {}),
                    expectedSourceSha256: initial.sourceSha256,
                };
                this.startAddition(id, combined, addition);
            }
            this.replyJson(response, 200, {
                ok: true, view: "combined", ...this.combinedData(combined),
                codexView: { type: "browser", view: "combined", url: `${this.link!.baseUrl}/view/${id}` },
            });
        } catch (error) { this.reply(response, 500, error instanceof Error ? error.message : "Preparation failed"); }
    }

    // AI_NOTE: MCPが並列生成したビューIDだけを合成対象にし、任意データを受け取らない。
    // 個別URLは互換用に残し、統合URLは同じ保存済みスナップショットを参照する。
    private async handleCombine(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        let body: Record<string, unknown>;
        try {
            body = await this.readJsonBody(request);
        } catch (error) {
            const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
            this.replyJson(response, status, { ok: false, error: error instanceof Error ? error.message : "Invalid request" });
            return;
        }
        const ids = Array.isArray(body.viewIds) ? [...new Set(body.viewIds)] : [];
        if (ids.length < 2 || ids.length > 4 || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{48}$/.test(id))) {
            this.replyJson(response, 400, { ok: false, error: "Invalid view ids" });
            return;
        }
        const combined: CombinedCodexView = {};
        for (const id of ids as string[]) {
            const result = this.codexViews.get(id);
            if (!result || !["standard", "diagram", "inline", "trace"].includes(result.view)) {
                this.replyJson(response, 410, { ok: false, error: "A source view has expired" });
                return;
            }
            const key = result.view as "standard" | "diagram" | "inline" | "trace";
            if (combined[key]) {
                this.replyJson(response, 400, { ok: false, error: "Duplicate view type" });
                return;
            }
            combined[key] = JSON.parse(JSON.stringify(result)) as AgentShowResult;
            combined.file ??= result.file;
            if (combined.file && result.file && combined.file !== result.file) {
                this.replyJson(response, 400, { ok: false, error: "Views must use the same file" });
                return;
            }
            const knownHashes = Object.values(combined).filter(value => value && typeof value === "object" && "sourceSha256" in value)
                .map(value => (value as AgentShowResult).sourceSha256).filter(Boolean);
            if (new Set(knownHashes).size > 1) { this.reply(response, 409, "Source changed; request a new view"); return; }
        }
        const id = crypto.randomBytes(24).toString("hex");
        this.combinedCodexViews.set(id, combined);
        while (this.combinedCodexViews.size > MAX_CODEX_VIEWS) {
            const oldest = this.combinedCodexViews.keys().next().value as string | undefined;
            if (!oldest) break;
            this.combinedCodexViews.delete(oldest);
        }
        this.replyJson(response, 200, {
            ok: true,
            view: "combined",
            file: combined.file,
            codexView: { type: "browser", url: `${this.link!.baseUrl}/view/${id}`, view: "combined" },
        });
    }

    private async handleCombinedCodexView(
        request: http.IncomingMessage,
        response: http.ServerResponse,
        id: string,
        action: string | undefined,
        combined: CombinedCodexView,
    ): Promise<void> {
        // AI_NOTE: 状態取得は生成を開始せず、元snapshotに一致するcache結果だけを合成する。
        if (action === "/layers" && combined.standard) { await this.handleLayers(request, response, id, combined.standard, combined); return; }
        if (action === "/retry" && combined.standard) { await this.handleRetry(request, response, id, combined.standard, combined); return; }
        if (action === "/state") {
            if (request.method !== "GET") {
                this.reply(response, 405, "Method Not Allowed");
                return;
            }
            try {
                if (combined.standard) combined.standard = await this.refreshSnapshot(combined.standard, "read");
                this.replyJson(response, 200, { view: "combined", ...this.combinedData(combined) });
            } catch (error) { this.reply(response, 500, error instanceof Error ? error.message : "State unavailable"); }
            return;
        }
        if (!action) {
            if (request.method !== "GET") {
                this.reply(response, 405, "Method Not Allowed");
                return;
            }
            this.openedCodexViews.delete(id);
            this.openedCodexViews.set(id, { view: "combined", openedAt: new Date().toISOString() });
            const data = this.combinedData(combined);
            this.replyHtml(response, 200, buildCombinedWebView(data, id));
            return;
        }
        if (action === "/expand") {
            if (request.method !== "POST" || !combined.standard?.standard || !combined.standard.file || !this.options.showView) {
                this.reply(response, request.method === "POST" ? 400 : 405, request.method === "POST" ? "Standard view unavailable" : "Method Not Allowed");
                return;
            }
            let body: Record<string, unknown>;
            try { body = await this.readJsonBody(request); } catch { this.reply(response, 400, "Invalid JSON"); return; }
            const line = Number(body.line);
            const target = combined.standard.standard.items.find((item) => item.line === line);
            if (!Number.isSafeInteger(line) || line < 1 || !target) {
                this.reply(response, 400, "Invalid standard item");
                return;
            }
            const resolved = this.resolveWorkspaceFile(combined.standard.file);
            if (!("absoluteFile" in resolved)) {
                this.reply(response, resolved.status, resolved.message);
                return;
            }
            try {
                const expanded = await this.options.showView({ view: "standard", absoluteFile: resolved.absoluteFile, line, expandLines: [line], activate: false, ...(combined.standard.sourceSha256 ? { expectedSourceSha256: combined.standard.sourceSha256 } : {}) });
                if (!expanded.standard) throw new Error("Standard expansion unavailable");
                if (combined.standard.sourceSha256 && combined.standard.sourceSha256 !== expanded.sourceSha256) throw new Error("Source changed; request a new view");
                combined.standard = expanded;
                this.replyJson(response, 200, { standard: expanded.standard });
            } catch (error) {
                this.reply(response, 500, error instanceof Error ? error.message : "Expansion failed");
            }
            return;
        }
        if (action === "/ask") {
            const inline = combined.inline ?? combined.standard;
            if (request.method !== "POST" || !inline?.annotations || !inline.file || !this.options.updateSymbolExplanation) {
                this.reply(response, request.method === "POST" ? 400 : 405, request.method === "POST" ? "Symbol dictionary unavailable" : "Method Not Allowed");
                return;
            }
            let body: Record<string, unknown>;
            try { body = await this.readJsonBody(request); } catch { this.reply(response, 400, "Invalid JSON"); return; }
            const symbolKey = typeof body.symbolKey === "string" ? body.symbolKey : "";
            const mode = body.mode === "undo" ? "undo" : "ask";
            const question = typeof body.question === "string" ? body.question.trim() : "";
            const item = inline.annotations.items.find((candidate) => candidate.symbolKey === symbolKey);
            if (!item?.symbolKey || !item.symbolKind || (mode === "ask" && (!question || question.length > 1000))) {
                this.reply(response, 400, "Invalid symbol question");
                return;
            }
            const history = [...(inline.annotations.conversations?.[symbolKey] ?? [])];
            const versionKey = `${inline.file}\0${inline.sourceSha256 ?? ""}\0${symbolKey}`;
            const versions = this.symbolVersions.get(versionKey) ?? [];
            try {
                let explanation: string;
                if (mode === "undo") {
                    const previous = versions.pop();
                    if (!previous) { this.reply(response, 409, "元に戻せる説明がありません。"); return; }
                    explanation = previous;
                } else {
                    if (!this.options.refineSymbol) { this.reply(response, 400, "Symbol chat unavailable"); return; }
                    const refined = await this.options.refineSymbol({ file: inline.file, symbolKey, display: item.label, kind: item.symbolKind, current: item.explanation, question, history, ...(inline.sourceSha256 ? { expectedSourceSha256: inline.sourceSha256 } : {}) });
                    versions.push(item.explanation);
                    history.push({ role: "user", content: question }, { role: "assistant", content: refined.answer });
                    explanation = refined.explanation;
                }
                this.symbolVersions.set(versionKey, versions);
                await this.options.updateSymbolExplanation(inline.file, symbolKey, explanation, inline.sourceSha256);
                this.updateStoredSymbol(inline.file, symbolKey, explanation, history, inline.sourceSha256);
                this.replyJson(response, 200, { explanation, history, canUndo: versions.length > 0 });
            } catch (error) {
                this.reply(response, 500, error instanceof Error ? error.message : "Symbol refinement failed");
            }
            return;
        }
        if (action !== "/open" || request.method !== "POST") {
            this.reply(response, action === "/open" ? 405 : 404, action === "/open" ? "Method Not Allowed" : "Not Found");
            return;
        }
        let body: Record<string, unknown>;
        try { body = await this.readJsonBody(request); } catch { this.reply(response, 400, "Invalid JSON"); return; }
        if (typeof body.file !== "string" || body.file !== combined.file || !Number.isSafeInteger(body.line) || Number(body.line) < 1) {
            this.reply(response, 400, "Invalid location");
            return;
        }
        const resolved = this.resolveWorkspaceFile(body.file);
        if (!("absoluteFile" in resolved)) { this.reply(response, resolved.status, resolved.message); return; }
        await this.options.openFile(resolved.absoluteFile, Number(body.line) - 1);
        this.reply(response, 204);
    }

    private async handleCodexView(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<boolean> {
        // AI_NOTE: capability URLの状態更新にもsnapshot identityを適用する。
        const match = /^\/view\/([a-f0-9]{48})(\/open|\/state|\/expand|\/ask|\/layers|\/retry)?$/.exec(url.pathname);
        if (!match) return false;
        const [, id, action] = match;
        const combined = this.combinedCodexViews.get(id);
        if (combined) {
            await this.handleCombinedCodexView(request, response, id, action, combined);
            return true;
        }
        const result = this.codexViews.get(id);
        const supported = result && (
            (result.view === "trace" && result.trace)
            || (result.view === "inline" && result.annotations)
            || (result.view === "standard" && result.standard)
            || (result.view === "diagram" && result.diagram)
        );
        if (!result || !supported) {
            this.replyHtml(response, 410, "<!doctype html><meta charset=\"utf-8\"><title>表示期限切れ</title><p>この表示は期限切れです。会話からAI Code Guideの表示をもう一度開いてください。</p>");
            return true;
        }
        if (action === "/layers") { await this.handleLayers(request, response, id, result); return true; }
        if (action === "/retry") { await this.handleRetry(request, response, id, result); return true; }
        if (action === "/state") {
            if (request.method !== "GET") {
                this.reply(response, 405, "Method Not Allowed");
                return true;
            }
            try {
                const next = result.view === "standard" ? await this.refreshSnapshot(result, "read", this.codexSources.get(id)) : result;
                this.codexViews.set(id, next);
                this.replyJson(response, 200, next);
            } catch (error) { this.reply(response, 500, error instanceof Error ? error.message : "State unavailable"); }
            return true;
        }
        if (!action) {
            if (request.method !== "GET") {
                this.reply(response, 405, "Method Not Allowed");
                return true;
            }
            this.openedCodexViews.delete(id);
            this.openedCodexViews.set(id, { view: result.view, openedAt: new Date().toISOString() });
            while (this.openedCodexViews.size > MAX_CODEX_VIEWS) {
                const oldest = this.openedCodexViews.keys().next().value as string | undefined;
                if (!oldest) break;
                this.openedCodexViews.delete(oldest);
            }
            if (result.view === "trace" && result.trace) {
                const data: TraceWebViewData = { ...(result.file ? { file: result.file } : {}), trace: result.trace };
                this.replyHtml(response, 200, buildTraceWebView(data, id));
            } else if (result.view === "standard" && result.standard) {
                const data: StandardWebViewData = {
                    ...(result.file ? { file: result.file } : {}),
                    ...(result.line ? { line: result.line } : {}),
                    standard: result.standard,
                    sourceSha256: result.sourceSha256, revision: result.revision,
                    layers: result.layers, annotations: result.annotations,
                    sourceChanged: result.sourceChanged,
                };
                this.replyHtml(response, 200, buildStandardWebView(data, id));
            } else if (result.view === "diagram" && result.diagram) {
                const data: DiagramWebViewData = {
                    ...(result.file ? { file: result.file } : {}),
                    ...(result.question ? { question: result.question } : {}),
                    diagram: result.diagram,
                    sources: this.diagramSources(result.diagram),
                };
                this.replyHtml(response, 200, buildDiagramWebView(data, id));
            } else {
                const data: InlineWebViewData = {
                    ...(result.file ? { file: result.file } : {}),
                    annotations: result.annotations!,
                };
                this.replyHtml(response, 200, buildInlineWebView(data, id));
            }
            return true;
        }
        if (action === "/ask") {
            if (request.method !== "POST") {
                this.reply(response, 405, "Method Not Allowed");
                return true;
            }
            if (!["inline", "standard"].includes(result.view) || !result.annotations || !result.file
                || !this.options.updateSymbolExplanation) {
                this.reply(response, 400, "Symbol dictionary unavailable");
                return true;
            }
            let body: Record<string, unknown>;
            try {
                body = await this.readJsonBody(request);
            } catch (error) {
                const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
                this.reply(response, status, error instanceof Error ? error.message : "Invalid request");
                return true;
            }
            const symbolKey = typeof body.symbolKey === "string" ? body.symbolKey : "";
            const mode = body.mode === "undo" ? "undo" : "ask";
            const question = typeof body.question === "string" ? body.question.trim() : "";
            const item = result.annotations.items.find((candidate) => candidate.symbolKey === symbolKey);
            if (!item || !item.symbolKey || !item.symbolKind || (mode === "ask" && (!question || question.length > 1000))) {
                this.reply(response, 400, "Invalid symbol question");
                return true;
            }
            const history = [...(result.annotations.conversations?.[symbolKey] ?? [])];
            const versionKey = `${result.file}\0${result.sourceSha256 ?? ""}\0${symbolKey}`;
            const versions = this.symbolVersions.get(versionKey) ?? [];
            try {
                let explanation: string;
                if (mode === "undo") {
                    const previous = versions.pop();
                    if (!previous) {
                        this.reply(response, 409, "元に戻せる説明がありません。");
                        return true;
                    }
                    explanation = previous;
                } else {
                    if (!this.options.refineSymbol) {
                        this.reply(response, 400, "Symbol chat unavailable");
                        return true;
                    }
                    const refined = await this.options.refineSymbol({
                        file: result.file,
                        symbolKey,
                        display: item.label,
                        kind: item.symbolKind,
                        current: item.explanation,
                        question,
                        history,
                        ...(result.sourceSha256 ? { expectedSourceSha256: result.sourceSha256 } : {}),
                    });
                    versions.push(item.explanation);
                    history.push({ role: "user", content: question }, { role: "assistant", content: refined.answer });
                    explanation = refined.explanation;
                }
                this.symbolVersions.set(versionKey, versions);
                await this.options.updateSymbolExplanation(result.file, symbolKey, explanation, result.sourceSha256);
                this.updateStoredSymbol(result.file, symbolKey, explanation, history, result.sourceSha256);
                this.replyJson(response, 200, { explanation, history, canUndo: versions.length > 0 });
            } catch (error) {
                console.error("[AI Code Guide] symbol refinement failed:", error);
                this.reply(response, 500, error instanceof Error ? error.message : "Symbol refinement failed");
            }
            return true;
        }
        if (action === "/expand") {
            if (request.method !== "POST") {
                this.reply(response, 405, "Method Not Allowed");
                return true;
            }
            if (result.view !== "standard" || !result.standard || !result.file || !this.options.showView) {
                this.reply(response, 400, "Standard view unavailable");
                return true;
            }
            let body: Record<string, unknown>;
            try {
                body = await this.readJsonBody(request);
            } catch (error) {
                const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
                this.reply(response, status, error instanceof Error ? error.message : "Invalid request");
                return true;
            }
            const line = Number(body.line);
            const target = result.standard.items.find((item) => item.line === line);
            if (!Number.isSafeInteger(line) || line < 1 || !target) {
                this.reply(response, 400, "Invalid standard item");
                return true;
            }
            const resolved = this.resolveWorkspaceFile(result.file);
            if (!("absoluteFile" in resolved)) {
                this.reply(response, resolved.status, resolved.message);
                return true;
            }
            try {
                const expanded = await this.options.showView({
                    view: "standard",
                    absoluteFile: resolved.absoluteFile,
                    line,
                    expandLines: [line],
                    activate: false,
                    ...(result.sourceSha256 ? { expectedSourceSha256: result.sourceSha256 } : {}),
                });
                if (!expanded.standard) throw new Error("Standard expansion unavailable");
                if (result.sourceSha256 && expanded.sourceSha256 !== result.sourceSha256) throw new Error("Source changed; request a new view");
                this.codexViews.set(id, expanded);
                this.replyJson(response, 200, { standard: expanded.standard });
            } catch (error) {
                console.error("[AI Code Guide] Codex standard expansion failed:", error);
                this.reply(response, 500, error instanceof Error ? error.message : "Expansion failed");
            }
            return true;
        }
        if (request.method !== "POST") {
            this.reply(response, 405, "Method Not Allowed");
            return true;
        }
        let body: Record<string, unknown>;
        try {
            body = await this.readJsonBody(request);
        } catch (error) {
            const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
            this.reply(response, status, error instanceof Error ? error.message : "Invalid request");
            return true;
        }
        if (typeof body.file !== "string" || body.file !== result.file || !Number.isSafeInteger(body.line) || Number(body.line) < 1) {
            this.reply(response, 400, "Invalid location");
            return true;
        }
        const resolved = this.resolveWorkspaceFile(body.file);
        if (!("absoluteFile" in resolved)) {
            this.reply(response, resolved.status, resolved.message);
            return true;
        }
        try {
            await this.options.openFile(resolved.absoluteFile, Number(body.line) - 1);
            response.writeHead(204, { "Cache-Control": "no-store" });
            response.end();
        } catch (error) {
            console.error("[AI Code Guide] Codex trace view open failed:", error);
            this.reply(response, 500, "VS Code unavailable");
        }
        return true;
    }

    private resolveWorkspaceFile(relativeFile: string): { absoluteFile: string } | { status: number; message: string } {
        const workspaceRoot = this.options.getWorkspaceRoot();
        if (!workspaceRoot) return { status: 503, message: "Workspace unavailable" };
        if (!relativeFile || path.isAbsolute(relativeFile)) return { status: 400, message: "Invalid location" };
        const absoluteRoot = path.resolve(workspaceRoot);
        const absoluteFile = path.resolve(absoluteRoot, relativeFile);
        const insideRoot = path.relative(absoluteRoot, absoluteFile);
        if (!insideRoot || insideRoot.startsWith(`..${path.sep}`) || insideRoot === ".." || path.isAbsolute(insideRoot)) {
            return { status: 403, message: "Outside workspace" };
        }
        let stat: fs.Stats;
        try {
            stat = fs.statSync(absoluteFile);
        } catch {
            return { status: 404, message: "File not found" };
        }
        if (!stat.isFile()) return { status: 404, message: "File not found" };
        return { absoluteFile };
    }

    private readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            request.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    reject(Object.assign(new Error("Payload too large"), { status: 413 }));
                    return;
                }
                chunks.push(chunk);
            });
            request.on("end", () => {
                if (size > MAX_BODY_BYTES) return;
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON");
                    resolve(parsed as Record<string, unknown>);
                } catch {
                    reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
                }
            });
            request.on("error", reject);
        });
    }

    private async handleShow(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        // AI_NOTE: 生成意図とsnapshot識別はHTTP境界で検証し、readをgenerateへ昇格しない。
        if (!this.options.showView) {
            this.replyJson(response, 501, { ok: false, error: "Agent views unavailable" });
            return;
        }
        let body: Record<string, unknown>;
        try {
            body = await this.readJsonBody(request);
        } catch (error) {
            const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
            this.replyJson(response, status, { ok: false, error: error instanceof Error ? error.message : "Invalid request" });
            return;
        }
        const view = typeof body.view === "string" && (AGENT_VIEWS as readonly string[]).includes(body.view)
            ? body.view as AgentView
            : null;
        if (!view) {
            this.replyJson(response, 400, { ok: false, error: "Invalid view" });
            return;
        }
        if ((body.backgroundAction !== undefined && !["read", "generate", "stop"].includes(String(body.backgroundAction)))
            || (body.expectedSourceSha256 !== undefined && (typeof body.expectedSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedSourceSha256)))) {
            this.reply(response, 400, "Invalid background action or source identity"); return;
        }
        const line = body.line === undefined ? undefined : Number(body.line);
        if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) {
            this.replyJson(response, 400, { ok: false, error: "Invalid line" });
            return;
        }
        const scopeLine = body.scopeLine === undefined ? undefined : Number(body.scopeLine);
        if (scopeLine !== undefined && (
            view !== "standard" || !Number.isSafeInteger(scopeLine) || scopeLine < 1
        )) {
            this.replyJson(response, 400, { ok: false, error: "Invalid standard scope line" });
            return;
        }
        // AI_NOTE: 外部AIは文脈から0〜複数の対象を選べる。配列は件数と各値を境界で検証し、
        // 空配列を「全件」へ暗黙変換しないことで、対象なしというAI判断をそのまま保持する。
        const expandLines = body.expandLines === undefined ? undefined : body.expandLines;
        if (expandLines !== undefined && (
            view !== "standard" || !Array.isArray(expandLines) || expandLines.length > MAX_AGENT_TARGETS
            || expandLines.some((value) => !Number.isSafeInteger(value) || Number(value) < 1)
        )) {
            this.replyJson(response, 400, { ok: false, error: "Invalid expand lines" });
            return;
        }
        const functions = body.functions === undefined ? undefined : body.functions;
        if (functions !== undefined && (
            view !== "trace" || !Array.isArray(functions) || functions.length > MAX_AGENT_TARGETS
            || functions.some((value) => typeof value !== "string" || !value.trim() || value.length > 200)
        )) {
            this.replyJson(response, 400, { ok: false, error: "Invalid functions" });
            return;
        }
        const callArguments = body.arguments === undefined ? undefined : body.arguments;
        if (callArguments !== undefined && (
            view !== "trace" || !callArguments || typeof callArguments !== "object" || Array.isArray(callArguments)
            || functions === undefined || functions.length !== 1
        )) {
            this.replyJson(response, 400, { ok: false, error: "Arguments require exactly one trace function" });
            return;
        }
        const traceEntryId = body.traceEntryId === undefined ? undefined : body.traceEntryId;
        if (traceEntryId !== undefined && (view !== "trace" || typeof traceEntryId !== "string" || !traceEntryId.trim() || traceEntryId.length > 200)) {
            this.replyJson(response, 400, { ok: false, error: "Invalid trace entry id" });
            return;
        }
        const startLine = body.startLine === undefined ? undefined : Number(body.startLine);
        const endLine = body.endLine === undefined ? undefined : Number(body.endLine);
        if ((startLine === undefined) !== (endLine === undefined) || (
            startLine !== undefined && (
                view !== "inline" || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
                || startLine < 1 || endLine! < startLine
            )
        )) {
            this.replyJson(response, 400, { ok: false, error: "Invalid line range" });
            return;
        }
        const visibleExpandLines = body.visibleExpandLines === undefined ? undefined : body.visibleExpandLines;
        if (visibleExpandLines !== undefined && (
            view !== "standard" || !Array.isArray(visibleExpandLines) || visibleExpandLines.length > MAX_AGENT_TARGETS
            || visibleExpandLines.some((value) => !Number.isSafeInteger(value) || Number(value) < 1)
        )) {
            this.replyJson(response, 400, { ok: false, error: "Invalid visible expansion lines" });
            return;
        }
        const validateAnnotationIds = (value: unknown): value is string[] => Array.isArray(value)
            && value.length <= MAX_AGENT_TARGETS
            && value.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 200);
        const removeAnnotationIds = body.removeAnnotationIds;
        const hideAnnotationIds = body.hideAnnotationIds;
        if ((removeAnnotationIds !== undefined && (view !== "inline" || !validateAnnotationIds(removeAnnotationIds)))
            || (hideAnnotationIds !== undefined && (view !== "inline" || !validateAnnotationIds(hideAnnotationIds)))) {
            this.replyJson(response, 400, { ok: false, error: "Invalid annotation ids" });
            return;
        }
        if (removeAnnotationIds && hideAnnotationIds
            && removeAnnotationIds.some((id) => hideAnnotationIds.includes(id))) {
            this.replyJson(response, 400, { ok: false, error: "An annotation cannot be removed and hidden together" });
            return;
        }
        const question = typeof body.question === "string" ? body.question.trim() : undefined;
        if (view === "diagram" && !question) {
            this.replyJson(response, 400, { ok: false, error: "Diagram question is required" });
            return;
        }
        if (question && question.length > 2000) {
            this.replyJson(response, 400, { ok: false, error: "Question too long" });
            return;
        }
        let absoluteFile: string | undefined;
        if (body.file !== undefined) {
            if (typeof body.file !== "string") {
                this.replyJson(response, 400, { ok: false, error: "Invalid file" });
                return;
            }
            const resolved = this.resolveWorkspaceFile(body.file);
            if (!("absoluteFile" in resolved)) {
                this.replyJson(response, resolved.status, { ok: false, error: resolved.message });
                return;
            }
            absoluteFile = resolved.absoluteFile;
        }
        try {
            const agentRequest: AgentShowRequest = {
                view,
                absoluteFile,
                line,
                ...(scopeLine ? { scopeLine } : {}),
                ...(expandLines ? { expandLines: expandLines.map(Number) } : {}),
                ...(visibleExpandLines ? { visibleExpandLines: visibleExpandLines.map(Number) } : {}),
                ...(functions ? { functions: functions.map((value) => value.trim()) } : {}),
                ...(callArguments ? { arguments: callArguments as Record<string, unknown> } : {}),
                ...(traceEntryId ? { traceEntryId } : {}),
                ...(startLine !== undefined ? { startLine, endLine } : {}),
                ...(removeAnnotationIds ? { removeAnnotationIds: removeAnnotationIds.map((id) => id.trim()) } : {}),
                ...(hideAnnotationIds ? { hideAnnotationIds: hideAnnotationIds.map((id) => id.trim()) } : {}),
                question,
                run: body.run === true,
                ...(body.activate === false ? { activate: false } : {}),
                ...(body.focusWindow === true ? { focusWindow: true } : {}),
                ...(body.backgroundAction ? { backgroundAction: body.backgroundAction as AgentShowRequest["backgroundAction"] } : {}),
                ...(body.expectedSourceSha256 ? { expectedSourceSha256: body.expectedSourceSha256 as string } : {}),
            };
            const result = await this.options.showView(agentRequest);
            // AI_NOTE: Codex向けの限定表示は公開境界でも適用する。showView実装が完全な
            // 標準スナップショットを返す経路でも、クラス外や以前の展開を会話へ漏らさない。
            const publicResult = result.view === "standard" && result.standard
                ? {
                    ...result,
                    standard: focusStandardView(result.standard, agentRequest.scopeLine, agentRequest.visibleExpandLines),
                }
                : result;
            this.replyJson(response, 200, this.storeCodexView(publicResult, agentRequest));
        } catch (error) {
            console.error("[AI Code Guide] agent view failed:", error);
            this.replyJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "Show failed" });
        }
    }

    private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        // AI_NOTE: preparation要求は既存の認証済みbridge境界内に限定する。
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (await this.handleCodexView(request, response, url)) return;
        if (url.searchParams.get("token") !== this.token) {
            this.reply(response, 403, "Forbidden");
            return;
        }
        if (url.pathname === "/status" && request.method === "GET") {
            this.replyJson(response, 200, {
                ok: true,
                workspaceRoot: this.options.getWorkspaceRoot() ?? null,
                views: AGENT_VIEWS,
                capabilities: ["llm-background-layers-v1", "source-snapshot-v1", "progressive-prepare-v1"],
                openedViews: [...this.openedCodexViews].map(([id, receipt]) => ({ id, ...receipt })),
            });
            return;
        }
        if (url.pathname === "/show" && request.method === "POST") {
            await this.handleShow(request, response);
            return;
        }
        if (url.pathname === "/prepare" && request.method === "POST") { await this.handlePrepare(request, response); return; }
        if (url.pathname === "/combine" && request.method === "POST") {
            await this.handleCombine(request, response);
            return;
        }
        if (url.pathname !== "/open") {
            this.reply(response, 404, "Not Found");
            return;
        }
        if (request.method !== "GET") {
            this.reply(response, 405, "Method Not Allowed");
            return;
        }
        const relativeFile = url.searchParams.get("file") ?? "";
        const lineText = url.searchParams.get("line") ?? "";
        if (!/^\d+$/.test(lineText)) {
            this.reply(response, 400, "Invalid location");
            return;
        }
        const oneBasedLine = Number(lineText);
        if (!Number.isSafeInteger(oneBasedLine) || oneBasedLine < 1) {
            this.reply(response, 400, "Invalid line");
            return;
        }
        const resolved = this.resolveWorkspaceFile(relativeFile);
        if (!("absoluteFile" in resolved)) {
            this.reply(response, resolved.status, resolved.message);
            return;
        }
        try {
            await this.options.openFile(resolved.absoluteFile, oneBasedLine - 1);
            // 204のトップレベル遷移は元の図を置き換えないため、クリック後も同じ図を続けて使える。
            response.writeHead(204, { "Cache-Control": "no-store" });
            response.end();
        } catch (error) {
            console.error("[AI Code Guide] project diagram bridge open failed:", error);
            this.reply(response, 500, "Open failed");
        }
    }
}
