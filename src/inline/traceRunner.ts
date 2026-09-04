import { spawn } from "child_process";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { resolveCommand } from "../util/resolveCommand";

// AI_NOTE: trace_runner.py の出力型。行番号は1-based・ファイル絶対。iter_path は [loopId, 周回] の外側→内側。
export interface TraceLoop {
    id: number;
    header_line: number;
    body_start: number;
    body_end: number;
    parent: number | null;
}

export interface TraceValue {
    short: string;
    full: string;
}

export interface TraceStep {
    line: number;
    iter_path: [number, number][];
    changed: Record<string, TraceValue>;
}

export interface TraceAssertion {
    line: number;
    kind: "assert" | "unittest";
    method: string;
    outcome: boolean;
    arguments?: TraceValue[];
    keyword_arguments?: Record<string, TraceValue>;
    exception?: { type: string; message: string };
    iter_path: [number, number][];
}

export interface TraceResult {
    loops: TraceLoop[];
    steps: TraceStep[];
    // Complete recorded line visits, including unchanged values; old caches may omit this.
    line_steps?: TraceStep[];
    // AI_NOTE: loop_id(str) → 親iter_pathキー("id:iter,id:iter"、最外は"") → 実周回数(終了判定の空周回を除く)
    iter_counts: Record<string, Record<string, number>>;
    return_value: TraceValue | null;
    func_line_start: number;
    func_line_end: number;
    overflow?: boolean;
    error: string | null;
    stage?: "setup" | "run";
    run_id?: string;
    executed_at?: string;
    input_arguments?: Record<string, unknown>;
    safety_decision?: "safe" | "known-unsafe" | "safety-unknown";
    safety_reason?: string;
    retry_guidance?: string;
    state_events?: Array<"entry/confirm" | "processing" | "success" | "exception">;
    control_points?: Array<{ line: number; kind: "if" | "return" | "assert"; body_start?: number; body_end?: number }>;
    executed_lines?: number[];
    path_events?: Array<{ line: number; kind: "if"; outcome: boolean; iter_path: [number, number][] }>;
    calls?: Array<{
        sequence: number;
        depth: number;
        function: string;
        line: number;
        arguments: Record<string, TraceValue>;
        return_value: TraceValue | null;
        exception?: { type: string; message: string } | null;
    }>;
    final_locals?: Record<string, TraceValue>;
    assertions?: TraceAssertion[];
}

const COPY_EXCLUDES = new Set([".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache"]);

interface TracePayload {
    source: string;
    func_name: string;
    setup: string;
    templates: Record<string, string>;
    file_path?: string;
    workspace_root?: string;
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sandboxPayload(
    payload: TracePayload,
    sandboxDir: string,
): TracePayload {
    if (!payload.file_path) return payload;
    const sourceFile = fs.realpathSync.native(path.resolve(payload.file_path));
    const sourceRoot = fs.realpathSync.native(path.resolve(payload.workspace_root || path.dirname(sourceFile)));
    if (!inside(sourceRoot, sourceFile)) throw new Error("トレース対象がワークスペース外にあります");
    const copiedRoot = path.join(sandboxDir, "workspace");
    fs.cpSync(sourceRoot, copiedRoot, {
        recursive: true,
        dereference: false,
        filter: (source) => source === sourceRoot || !COPY_EXCLUDES.has(path.basename(source)),
    });
    const copiedFile = path.join(copiedRoot, path.relative(sourceRoot, sourceFile));
    fs.mkdirSync(path.dirname(copiedFile), { recursive: true });
    fs.writeFileSync(copiedFile, payload.source, "utf8");
    return { ...payload, file_path: copiedFile, workspace_root: copiedRoot };
}

// AI_NOTE: 毎回workspaceを使い捨てコピーし、Python監査フックで外部書込・network・subprocessを止める。
// 対象のimportと相対データはコピー内で通常どおり解決し、完了後は隔離dirごと破棄する。
export async function runTrace(
    extensionPath: string,
    payload: TracePayload,
    timeoutMs = 10000,
): Promise<TraceResult> {
    const script = path.join(extensionPath, "python", "trace_runner.py");
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "acg-trace-"));
    let isolated: typeof payload;
    try {
        isolated = sandboxPayload(payload, sandboxDir);
    } catch (error) {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
        return emptyResult(error instanceof Error ? error.message : String(error));
    }
    const tempDir = path.join(sandboxDir, "tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const cwd = isolated.file_path ? path.dirname(isolated.file_path) : sandboxDir;
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ACG_TRACE_SANDBOX_ROOT: sandboxDir,
        TMP: tempDir,
        TEMP: tempDir,
        TMPDIR: tempDir,
        PYTHONDONTWRITEBYTECODE: "1",
    };
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    return new Promise((resolve) => {
        const proc = spawn(resolveCommand("python3", "python3"), [script], { cwd, env, windowsHide: true });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let settled = false;
        const finish = (result: TraceResult) => {
            if (settled) return;
            settled = true;
            try {
                fs.rmSync(sandboxDir, { recursive: true, force: true });
            } catch { /* 隔離dirの掃除失敗は結果を隠さない */ }
            resolve(result);
        };
        const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            finish(emptyResult(`タイムアウト(${timeoutMs / 1000}秒)。無限ループの可能性があります`));
        }, timeoutMs);

        proc.stdout.on("data", (d: Buffer) => chunks.push(d));
        proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
        proc.on("close", () => {
            clearTimeout(timer);
            const stdout = Buffer.concat(chunks).toString();
            try {
                finish(JSON.parse(stdout) as TraceResult);
            } catch {
                finish(emptyResult(Buffer.concat(errChunks).toString() || "トレーサの出力が読めませんでした"));
            }
        });
        proc.on("error", (err) => {
            clearTimeout(timer);
            finish(emptyResult(err.message));
        });
        proc.stdin.write(JSON.stringify(isolated));
        proc.stdin.end();
    });
}

function emptyResult(error: string): TraceResult {
    return { loops: [], steps: [], iter_counts: {}, return_value: null, func_line_start: 0, func_line_end: 0, error };
}
