import { spawn } from "child_process";
import * as path from "path";
import { resolveCommand } from "../util/resolveCommand";
import { extractJavaScriptGraph, extractJavaScriptProjectGraph, javaScriptFuncAtLine, javaScriptStmtSpans, listJavaScriptFunctions } from "./javascriptParser";
import { languageProfile, SupportedLanguageId } from "./languageSupport";

// AI_NOTE: Python ASTパーサースクリプトのパスを拡張機能ディレクトリからの相対で解決する
function getParserScript(extensionPath: string): string {
    return path.join(extensionPath, "python", "ast_parser.py");
}

export interface AstNode {
    id: string;
    kind: string;
    label: string;
    lineStart: number;
    lineEnd: number;
    children: string[];
}

export interface AstEdge {
    from: string;
    to: string;
    label: string;
}

export interface AstResult {
    nodes: AstNode[];
    edges: AstEdge[];
    error?: string;
}

// AI_NOTE: spawnでPythonスクリプトを起動してstdinにソースを流し、stdoutのJSONを受け取る
function runPython(script: string, args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // AI_NOTE: 配布先のDock起動でPATHが細くても python3 を見つけられるよう実体を解決してから起動する。
        const proc = spawn(resolveCommand("python3", "python3"), [script, ...args]);
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        proc.stdout.on("data", (d: Buffer) => chunks.push(d));
        proc.stderr.on("data", (d: Buffer) => errChunks.push(d));

        proc.on("close", (code) => {
            if (code !== 0) {
                const errMsg = Buffer.concat(errChunks).toString();
                reject(new Error(errMsg || `Process exited with code ${code}`));
            } else {
                resolve(Buffer.concat(chunks).toString());
            }
        });

        proc.on("error", (err) => reject(err));

        proc.stdin.write(input);
        proc.stdin.end();
    });
}

export async function parseFlowchart(
    extensionPath: string,
    sourceCode: string,
    granularity: "coarse" | "normal" | "detail" = "normal",
    targetFunc = ""
): Promise<AstResult> {
    const script = getParserScript(extensionPath);
    const args = ["flowchart", granularity];
    if (targetFunc) {
        args.push(targetFunc);
    }

    try {
        const stdout = await runPython(script, args, sourceCode);
        return JSON.parse(stdout) as AstResult;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { nodes: [], edges: [], error: `AST parse failed: ${message}` };
    }
}

export interface GraphNode {
    id: string;
    kind: "entry" | "block" | "condition" | "return" | "loop" | "function" | "class" | "constant";
    label: string;
    lineStart: number;
    lineEnd: number;
    fromComment?: boolean;
    // AI_NOTE: クラスのメソッド/ネストクラスは親クラスのidをparentに持つ。標準ビューで階層描画する
    parent?: string;
    // AI_NOTE: 背景専用の所有範囲では子本体を除外し、宣言だけを親の文脈に残す。
    headerEnd?: number;
    scopeKey?: string;
}

export interface GraphEdge {
    from: string;
    to: string;
    label: string;
    // AI_NOTE: 呼び出し元の呼び出し行(0-based)。標準ビューで展開時にどのサブブロックから矢印を出すか決めるのに使う。構造エッジには無い。
    fromLine?: number;
}

export interface GraphResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
    relationships?: Array<{ from: string; to: string; line: number }>;
    error?: string;
    backgroundNodes?: GraphNode[];
}

export async function extractGraph(
    extensionPath: string,
    sourceCode: string,
    targetFunc = "",
    languageId: SupportedLanguageId = "python"
): Promise<GraphResult> {
    const profile = languageProfile(languageId);
    if (profile?.family === "javascript") return extractJavaScriptGraph(sourceCode, languageId, targetFunc);
    const script = getParserScript(extensionPath);
    const args = ["graph"];
    if (targetFunc) {
        args.push(targetFunc);
    }
    try {
        const stdout = await runPython(script, args, sourceCode);
        return JSON.parse(stdout) as GraphResult;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { nodes: [], edges: [], error: message };
    }
}

export interface BlockInfo {
    label: string;
    lineStart: number;
    lineEnd: number;
    color: string;
    bg: string;
    // AI_NOTE: coarse 2層表示用。true=グループ背景、false/undefined=個別関数
    groupBorder?: boolean;
    // AI_NOTE: true=展開サブブロック → gutterIcon（左バー）、false/undefined=デフォルトブロック → backgroundColor
    expandSub?: boolean;
}

export async function extractBlocks(
    extensionPath: string,
    sourceCode: string,
    granularity: "coarse" | "normal" | "detail" | "function" = "normal",
    targetFunc = ""
): Promise<BlockInfo[]> {
    const script = getParserScript(extensionPath);
    const args = ["blocks", granularity];
    if (targetFunc) {
        args.push(targetFunc);
    }
    try {
        const stdout = await runPython(script, args, sourceCode);
        return JSON.parse(stdout) as BlockInfo[];
    } catch {
        return [];
    }
}

export async function funcAtLine(
    extensionPath: string,
    sourceCode: string,
    line: number,
    languageId: SupportedLanguageId = "python"
): Promise<string> {
    const profile = languageProfile(languageId);
    if (profile?.family === "javascript") return javaScriptFuncAtLine(sourceCode, languageId, line);
    const script = getParserScript(extensionPath);
    try {
        const stdout = await runPython(script, ["func_at_line", String(line)], sourceCode);
        const result = JSON.parse(stdout) as { func: string };
        return result.func ?? "";
    } catch {
        return "";
    }
}

export interface FuncInfo {
    name: string;
    line_start: number;
    line_end: number;
}

// AI_NOTE: 一括トレースの選択リスト用。トップレベル関数とクラスメソッドを行順で返す。
// 失敗時は空配列(UI側で一覧を出さない)
export async function listFunctions(extensionPath: string, sourceCode: string, languageId: SupportedLanguageId = "python"): Promise<FuncInfo[]> {
    const profile = languageProfile(languageId);
    if (profile?.family === "javascript") return listJavaScriptFunctions(sourceCode, languageId);
    const script = getParserScript(extensionPath);
    try {
        const stdout = await runPython(script, ["functions"], sourceCode);
        return JSON.parse(stdout) as FuncInfo[];
    } catch {
        return [];
    }
}

export interface StmtSpan {
    start: number;
    end: number;
}

export interface SymbolOccurrence {
    key: string;
    name: string;
    display: string;
    kind: "variable" | "function" | "method" | "class";
    line: number;
    start_col: number;
    end_col: number;
    scope: string;
    context: string;
    scope_start: number;
    scope_end: number;
    is_definition: boolean;
    /** AI_NOTE: 正確な代入根拠の抽出用。旧parserとの互換性のため省略可、0-based。 */
    statement_start?: number;
    statement_end?: number;
    /** AI_NOTE: 添字・呼出し結果などを呼ぶ動的dispatchは定義を断定しない。 */
    uncertain_call?: boolean;
    /** AI_NOTE: 字句scopeのimportまたはstar importが同名builtinを隠す可能性。 */
    import_shadowed?: boolean;
}

export async function extractSymbols(extensionPath: string, sourceCode: string): Promise<SymbolOccurrence[]> {
    const script = getParserScript(extensionPath);
    try {
        const stdout = await runPython(script, ["symbols"], sourceCode);
        return JSON.parse(stdout) as SymbolOccurrence[];
    } catch {
        return [];
    }
}

// AI_NOTE: blockRangeSnapper向けにAST文境界一覧を取得する。失敗時は空配列(呼び出し側でスナップをスキップする)
export async function getStmtSpans(extensionPath: string, sourceCode: string, languageId: SupportedLanguageId = "python"): Promise<StmtSpan[]> {
    const profile = languageProfile(languageId);
    if (profile?.family === "javascript") return javaScriptStmtSpans(sourceCode, languageId);
    const script = getParserScript(extensionPath);
    try {
        const stdout = await runPython(script, ["stmt_spans"], sourceCode);
        return JSON.parse(stdout) as StmtSpan[];
    } catch {
        return [];
    }
}

export interface ProjectFileNode {
    id: string;
    path: string;
    rel_path: string;
    dir: string;
    functions: string[];
    symbols?: string[];
    imports: string[];
}

export interface ProjectGraphResult {
    nodes: ProjectFileNode[];
    edges: Array<{ from: string; to: string; label: string }>;
    projectDir: string;
    // AI_NOTE: __init__.py のdocstring から抽出したディレクトリ説明。キー = 相対パス
    dirDescriptions?: Record<string, string>;
    error?: string;
}

// AI_NOTE: stdinは使わない。プロジェクトディレクトリをargsで渡してPythonに走査させる
export async function extractProjectGraph(
    extensionPath: string,
    projectDir: string
): Promise<ProjectGraphResult> {
    const script = getParserScript(extensionPath);
    const javascriptResult = extractJavaScriptProjectGraph(projectDir);
    try {
        const stdout = await runPython(script, ["project_graph", projectDir], "");
        const pythonResult = JSON.parse(stdout) as ProjectGraphResult;
        if (pythonResult.error && javascriptResult.error) return pythonResult;
        return {
            nodes: [...(pythonResult.error ? [] : pythonResult.nodes), ...(javascriptResult.error ? [] : javascriptResult.nodes)],
            edges: [...(pythonResult.error ? [] : pythonResult.edges), ...(javascriptResult.error ? [] : javascriptResult.edges)],
            projectDir: pythonResult.projectDir || javascriptResult.projectDir,
            dirDescriptions: pythonResult.dirDescriptions,
        };
    } catch (err) {
        if (!javascriptResult.error) return javascriptResult;
        const message = err instanceof Error ? err.message : String(err);
        return { nodes: [], edges: [], projectDir, error: message };
    }
}
