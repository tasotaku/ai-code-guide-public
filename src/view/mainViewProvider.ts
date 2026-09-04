import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { extractGraph, funcAtLine, extractProjectGraph, getStmtSpans, listFunctions, GraphNode, GraphEdge, FuncInfo, ProjectFileNode } from "../flowchart/astParser";
import { isSupportedLanguage, languageProfile, SupportedLanguageId } from "../flowchart/languageSupport";
import { MeaningRange } from "../api/blockRangeSnapper";
import { SemanticBackgroundService } from "../api/semanticBackground";
import { GenerationGate, GenerationTrigger } from "../api/generationGate";
import { buildSemanticLineIndex, SEMANTIC_BACKGROUND_PALETTE } from "./semanticBackground";
import { generateNodeLabels, generateBlockDescriptions, chatAboutCode, summarizeChatConclusion, answerHelpQuestion, generateModuleGroups, generateBlockBreakdown, generateFileDescriptions, generateDirDescriptions, generateFileOverview, generateProjectDiagram, refineSymbolDictionaryExplanation, ModuleGroup, BlockExpansion, BlockOverview, FileOverview, FileKind, getUsageStats, getDailyUsage, getAllTimeUsage } from "../api/claudeClient";
import { PersistentCache, fnv1a } from "../flowchart/flowchartCache";
import { buildMermaidCode, assignNodeColors, mermaidHead } from "../flowchart/mermaid";
import { ChatStore, ChatSession, ChatQuote } from "./chatStore";
import { ChatLinkStore } from "./chatLinkStore";
import { ProjectDiagramHistoryEntry, ProjectDiagramStore } from "./projectDiagramStore";
import { buildProjectDiagramHtml, buildStandaloneProjectDiagramHtml, LocatedProjectDiagram, projectFlowchartCss, projectFlowchartRuntime } from "./projectDiagram";
import { buildProjectDiagramSourceExcerpt } from "./projectDiagramContext";
import { collapseProjectDiagramEdges, projectDiagramConnectivity, projectDiagramStepKey } from "../api/projectDiagramValidation";
import { ProjectDiagramBridge } from "./projectDiagramBridge";
import { findProjectAnchorLineInLines, findProjectSymbolLineInLines } from "./projectSymbolLocation";
import type { AgentShowRequest, AgentShowResult, ProjectDiagramBridgeLink } from "./projectDiagramBridge";
import { AnnotateResult, SemanticAnnotationProvider } from "../inline/blockExplanationProvider";
import { SemanticAnnotation } from "../api/claudeClient";
import { resolveAnnotations } from "../api/annotationResolver";
import { providerOf, effectiveModel } from "../api/llmProvider";
import { findGitExcludeInfo } from "../util/gitExclude";
import { getSecretKey, settingToProvider } from "../api/secretKeys";
import { helpPlainText } from "./helpPage";
import { resolveCommand, separateClaudeConfigDir } from "../util/resolveCommand";
import { loadDesignForSource, DesignLookup, loadRepoDesign, loadDirDesign, designFileExists, FreeformDesign, readExistingDesignMd } from "../design/designStore";
import { DesignSymbol, DesignIssue, Provenance } from "../design/designParser";
import { buildDesignPrompt, DesignScope } from "../design/designPrompt";
import type { ConversationTrace } from "../inline/traceProvider";
import { createHash, randomUUID } from "node:crypto";
import type { AgentTraceAttempt } from "./projectDiagramBridge";
import { focusStandardView } from "./standardFocus";

// AI_NOTE: #14 サイドバー常駐の統合パネル。WebviewView なので隠しても破棄されず状態が保たれる
// （WebviewPanel と違い「閉じる=破棄」が起きない＝ #7/#8 セッション/キャッシュ消失の構造的解消）。
// Phase 1a: 標準タブにアクティブPythonファイルのモジュールマップ(カード一覧)を実描画する。
// バックエンド(astParser)は流用。装飾/クリック/AI説明/概要は後続スライスで足す。
// AI_NOTE: extension.ts から注入される TraceProvider の見え方(循環importを避けるため構造的型で受ける)。
interface TraceView {
    isActive(uri: string): boolean;
    clear(editor: vscode.TextEditor): void;
    getStatus(uri: string): { funcNames: string[]; loopCount: number } | null;
    getConversationTraces(uri: string): ConversationTrace[];
    getLoopSelectors(
        uri: string,
    ): { funcName: string; loopId: number; headerLine: number; iter: number; max: number; depth: number }[];
}

type DefaultLayerState = { status: "idle" | "queued" | "generating" | "ready" | "stale" | "stopped" | "error"; completed: number; total: number; message?: string; retryable?: boolean };
type DefaultLayers = { background: DefaultLayerState; inline: DefaultLayerState };

export class MainViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "aiCodeGuide.mainView";

    private view?: vscode.WebviewView;
    private readonly extensionPath: string;
    private readonly globalStoragePath: string;
    private readonly projectDiagramBridge: ProjectDiagramBridge;
    private readonly projectDiagramBridgeReady: Promise<ProjectDiagramBridgeLink | null>;
    // AI_NOTE: 直近に解析した内容。アクティブエディタ変更/保存で更新し、webviewを描き直す
    private currentDoc: vscode.TextDocument | null = null;
    private graphNodes: GraphNode[] = [];
    private graphEdges: GraphEdge[] = [];
    private graphRelationships: Array<{ from: string; to: string; line: number }> = [];
    // AI_NOTE: #5 ノードごとに異なる色(assignNodeColorsのパレット回転)。kind別の同色だと隣接ブロックの境界が分からないため。
    private nodeColors = new Map<string, { color: string; bg: string; mermaidFill: string }>();
    // AI_NOTE: #14 エディタ装飾(背景色)。webviewとは別チャネルでエディタに付く。
    // 図(タブ)を隠しても残る＝#11「色は残してコード全幅」の土台。ノードごとに型を作り直す。
    private decorationTypes: vscode.TextEditorDecorationType[] = [];
    private coloringEnabled = true;
    private readonly backgroundService: SemanticBackgroundService;
    private readonly generationGate = new GenerationGate();
    private backgroundNodes: GraphNode[] = [];
    private readonly sourceParses = new Map<string, Promise<{ graph: Awaited<ReturnType<typeof extractGraph>>; funcs: FuncInfo[]; spans: Awaited<ReturnType<typeof getStmtSpans>> }>>();
    private readonly layerStates = new Map<string, { source: string; layers: DefaultLayers }>();
    private readonly layerJobs = new Map<string, { source: string; revision: number; automatic: boolean; task: Promise<void> }>();
    private readonly saveReasons = new Map<string, vscode.TextDocumentSaveReason>();
    private readonly expandedSources = new Map<string, string>();
    private readonly staleExpansions = new Set<string>();
    private readonly expansionTickets = new Map<string, symbol>();
    private decorationIndexKey = "";
    private decorationIndex: ReturnType<typeof buildSemanticLineIndex> = new Map();
    private readonly layerStatus: vscode.StatusBarItem;
    private layerRevision = 0;
    private refreshedSource = "";

    private colorBackgrounds(ranges: Record<string, MeaningRange[]>, nodes: GraphNode[]) {
        // AI_NOTE: 未完了対象も含むAST所有順を色の基点にし、後着結果やトグルで既存色を回さない。
        return Object.fromEntries(Object.entries(ranges).map(([id, blocks]) => [id, blocks.map((block, index) => ({
            ...block, colorIndex: Math.max(0, nodes.findIndex(node => node.id === id)) + index,
        }))]));
    }
    // AI_NOTE: #14 ② 標準ビューの呼び出し関係の矢印 ON/OFF(#5: 矢印は邪魔なので既定OFF・幅も自動調整)。
    private arrowsEnabled = false;
    // AI_NOTE: 概要タブの呼び出し矢印 ON/OFF。畳んだグループはメイン(group-block)、開いたら関数(inner-card)を指す。
    private overviewArrows = false;
    // AI_NOTE: 矢印をカードの左右どちらに描くか。パネルを右に置くとコードが左に来るので右側が見やすい→設定で切替。
    private get arrowSide(): "left" | "right" {
        return vscode.workspace.getConfiguration("aiCodeGuide").get<"left" | "right">("arrowSide", "left");
    }
    // AI_NOTE: #14 AI説明。旧FlowchartPanelと同じ内容ハッシュkeyの永続キャッシュを共有するので、
    // どちらで生成しても再利用され追加トークンを使わない。descMap は現在表示中の nodeId→説明。
    private readonly llmCache: PersistentCache;
    private descMap: Record<string, string> = {};
    // AI_NOTE: ファイル全体の型+役割ヘッダー。descMapと同じ内容ハッシュキーで永続キャッシュし、標準/概要タブ上部に出す。
    private fileOverview: FileOverview | null = null;
    private generating = false;
    // AI_NOTE: #14 ⑤ チャットはセッション式・ディスク永続(ChatStore)。複数の過去チャットに戻れ、再起動後も残る。
    // currentChatId が現在表示中のセッション。chatThinking 中は応答待ちインジケータ。
    private readonly chatStore: ChatStore;
    private currentChatId: string | null = null;
    private chatThinking = false;
    // AI_NOTE: 生成中の応答を中断するための AbortController。runChat 中だけ非null。中止ボタン→abort()で実リクエストを止める。
    private chatAbort: AbortController | null = null;
    // AI_NOTE: 返信待ち(chatThinking)中に届いた送信をためるFIFO。早期returnで捨てず、返信完了後に順に runChat へ流す。
    private chatQueue: Array<{ sessionId: string; text: string; quotes?: ChatQuote[] }> = [];
    // AI_NOTE: エディタで最後に選択した非空範囲。チャット欄への貼り付けがこの内容と一致したら引用チップに変換する
    // （クリップボードのテキストにはファイル/行情報が無いため、拡張側で覚えた選択と突き合わせて場所参照を復元する）。
    private lastQuoteCandidate: ChatQuote | null = null;
    // AI_NOTE: #14 概要(coarse)グループ。旧FlowchartPanelと同じ coarse::{内容ハッシュ} キーで共有キャッシュ。
    private coarseGroups: ModuleGroup[] | null = null;
    private groupGenerating = false;
    // AI_NOTE: #14 単一関数ドリルイン。targetFunc が空なら標準=モジュールマップ、関数名が入れば mermaid 表示。
    // graphNodes は常に全体(カード/装飾/カーソル連動)に使い、funcGraph は単一関数の描画専用に持つ。
    private targetFunc = "";
    private funcGraph: { nodes: GraphNode[]; edges: GraphEdge[] } | null = null;
    // AI_NOTE: 単一関数フローチャートの文言切り替え。既定はコード(機械生成のまま)、ボタンでLLM言い換えの日本語へ。
    // naturalLabels は nodeId→日本語文言(関数ソースの内容ハッシュで永続キャッシュ)。ドリルインのたびにOFFへ戻す。
    private naturalMode = false;
    private naturalLabels: Record<string, string> | null = null;
    private naturalGenerating = false;
    // AI_NOTE: 標準背景は詳細説明と別レイヤー。LLMが確定した意味区分を保持し、
    // expandedDataが空でもVS Code/Codexのコード面へ常時適用する。
    private meaningRanges: Record<string, MeaningRange[]> = {};
    // AI_NOTE: #14 カードの展開ブロック分解。nodeId→概要+サブブロック配列(表示中のもの)。旧パネルとexpand::キー共有。
    private expandedData: Record<string, BlockExpansion> = {};
    // AI_NOTE: #1 生成中のnodeId。これで「分解中…(生成中)」と「分解できませんでした(空結果)」を区別する。
    private expandGenerating = new Set<string>();
    // AI_NOTE: ヘルプタブの「ヘルプに質問」。直近の質問・回答・生成中フラグを保持し、html再生成をまたいで表示を保つ。
    private helpQuestion = "";
    private helpAnswer = "";
    private helpAsking = false;
    // AI_NOTE: #14 プロジェクトビュー(import依存)。明示ボタンで解析(大きいと重いため)。
    private projectData: { nodes: ProjectFileNode[]; edges: Array<{ from: string; to: string; label: string }> } | null = null;
    // AI_NOTE: 設計フェーズ1・ステップ3後半。解析対象dirの絶対パス(=.ai-code-guide/design/の起点)。プロジェクトタブの設計表示に使う。
    private projectRoot: string | null = null;
    private projectAnalyzing = false;
    // AI_NOTE: 自動解析とMCP表示要求が重なった時は同じ解析完了を待つ。
    // booleanだけだと後発要求が空データのまま即時応答してしまう。
    private projectAnalysisTask: Promise<void> | null = null;
    // AI_NOTE: #6 プロジェクトビュー: ファイル/ディレクトリのAI解説と、import矢印トグル。
    private projectFileDescs: Record<string, string> = {};
    private projectDirDescs: Record<string, string> = {};
    private projectDescGenerating = false;
    private projectArrows = false;
    // AI_NOTE: 質問に必要な地点と関係だけを持つ図。読解順は常設せず、質問の意味に合うグラフをそのまま表示する。
    private projectDiagram: { question: string; diagram: LocatedProjectDiagram } | null = null;
    // AI_NOTE: 同じ質問文でも生成結果は別履歴になり得るため、選択表示は質問文ではなく履歴固有IDで管理する。
    private selectedProjectDiagramHistoryId: string | null = null;
    // AI_NOTE: 図を閉じても履歴は消さない。選び直した時に現在のコードへ位置を再照合する。
    private readonly projectDiagramStore: ProjectDiagramStore;
    private projectDiagramHistory: ProjectDiagramHistoryEntry[] = [];
    private projectDiagramGenerating = false;
    private projectDiagramGeneration: Promise<void> | null = null;
    private projectDiagramError = "";
    // AI_NOTE: Webview HTML差し替え中はpostMessageのタブ切替が消えるため、
    // エージェント表示だけ完成HTMLへ初期タブを直接埋め込む。
    private initialTabOverride: string | null = null;

    // AI_NOTE: 実行トレースの状態参照(トレースタブの状態行用)。extension.ts が生成後に注入する(循環importを避ける構造的型)。
    private traceProvider: TraceView | null = null;
    // AI_NOTE: 一括トレースのチェックリスト用。refresh() でファイル切替時に取り直す。
    private traceFuncs: FuncInfo[] = [];

    setTraceProvider(p: TraceView): void {
        this.traceProvider = p;
    }

    // AI_NOTE: 周回ボタン行のHTML。ループごとに「行番号+その行のコード / ◀ n/m ▶」を出す。
    // 行のコードはトレース実行時点の文書から取る(トレースは編集で即クリアされるのでズレない)。
    // 一括トレースでは複数関数のループが並ぶため、loopId は関数名とセットで送る。
    private traceLoopRows(): string {
        const doc = this.currentDoc;
        const loops = doc ? this.traceProvider?.getLoopSelectors(doc.uri.toString()) ?? [] : [];
        if (!doc || loops.length === 0) return "";
        const rows = loops.map((l) => {
            const code = l.headerLine - 1 < doc.lineCount ? doc.lineAt(l.headerLine - 1).text.trim() : "";
            const step = (delta: number) =>
                `vscode.postMessage({type:'traceIterStep',funcName:'${escapeHtml(l.funcName)}',loopId:${l.loopId},delta:${delta}})`;
            return `<div class="trace-loop" style="padding-left:${l.depth * 12}px">
        <span class="trace-loop-code" title="${escapeHtml(code)}">${l.headerLine} ${escapeHtml(code)}</span>
        <button class="tbtn trace-iter" onclick="${step(-1)}" title="前の周回へ">◀</button>
        <span class="trace-iter-label">${l.iter}/${l.max}</span>
        <button class="tbtn trace-iter" onclick="${step(1)}" title="次の周回へ">▶</button>
      </div>`;
        });
        return `<div class="ann-sec">ループの周回</div>${rows.join("")}`;
    }

    // AI_NOTE: 一括トレースの対象を選ぶチェックリスト。トップレベル関数と
    // Class.method を行順で並べる。トップレベル関数だけを既定選択する。
    private traceFuncRows(): string {
        if (this.traceFuncs.length === 0) return "";
        const items = this.traceFuncs.map((f) => {
            const name = escapeHtml(f.name);
            // メソッドはコンストラクタ準備やテスト実行を伴うので、一括実行の既定対象にはしない。
            const checked = f.name.includes(".") ? "" : " checked";
            return `<label class="trace-func-row"><input type="checkbox" class="trace-func" value="${name}"${checked}>
        <span class="trace-func-name">${name}()</span><span class="trace-func-line">${f.line_start}行〜</span></label>`;
        });
        return `<div class="ann-sec">トレースする関数（${this.traceFuncs.length}個）</div>
      <div class="trace-func-tools">
        <button class="tbtn trace-iter" onclick="traceCheckAll(true)">全選択</button>
        <button class="tbtn trace-iter" onclick="traceCheckAll(false)">全解除</button>
      </div>${items.join("")}`;
    }

    private traceStatusText(): string {
        const status = this.currentDoc ? this.traceProvider?.getStatus(this.currentDoc.uri.toString()) ?? null : null;
        if (!status) return "トレースなし — 関数を選んで「選んだ関数をトレース」を押してください";
        const names = status.funcNames.map((n) => `${n}()`).join(", ");
        return `トレース表示中: ${names}${status.loopCount > 0 ? ` ・ ループ${status.loopCount}個` : ""}`;
    }

    // AI_NOTE: トレース表示/解除の直後に extension.ts から呼ぶ。状態行だけ postMessage で更新し、
    // HTML全再描画(タブ位置が標準へ巻き戻る)を避ける。
    refreshTraceStatus(): void {
        this.view?.webview.postMessage({
            type: "traceStatus",
            text: this.traceStatusText(),
            loopsHtml: this.traceLoopRows(),
        });
    }

    // AI_NOTE: #14 コマンド/ショートカット/ホバーからサイドバーを前面化し、必要ならタブを切り替える(#13)。
    // 旧パネルのコマンド(Cmd+Alt+V等)の振り替え先。
    // AI_NOTE: preserveFocus=true は外部AI経由の表示用。既存ビューを show(true) で出すだけにして
    // VS Codeへキーボードフォーカス(＝macOSのウィンドウ前面化)を渡さない。
    // ビュー未生成時だけは focus コマンドしか生成手段が無いためフォールバックする。
    async reveal(tab?: string, preserveFocus = false): Promise<void> {
        if (preserveFocus && this.view) this.view.show(true);
        else await vscode.commands.executeCommand("aiCodeGuide.mainView.focus");
        // The focus command can resolve before VS Code calls resolveWebviewView.
        // Agent requests issued immediately after startup must wait for the real
        // view instead of silently returning an empty project result.
        const deadline = Date.now() + 3000;
        while (!this.view && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        if (!this.view) throw new Error("AI Code Guide view did not initialize");
        if (tab) this.view?.webview.postMessage({ type: "activateTab", tab });
    }

    // AI_NOTE: 会話内コード図の明示クリック時だけ、処理を担当したVS CodeウィンドウをOS前面へ出す。
    // 通常の図生成・ビュー表示では呼ばない。
    private async focusHostWindow(): Promise<void> {
        try {
            await vscode.commands.executeCommand("workbench.action.focusWindow");
        } catch (error) {
            console.warn("[AI Code Guide] VS Code window focus failed:", error);
        }
    }

    // AI_NOTE: 接続トークンを含むランタイムファイルだけをローカルGit除外へ加える。
    // 設計資料が置かれる `.ai-code-guide/` 全体は共有対象になり得るため、ディレクトリごとは除外しない。
    private excludeAgentBridgeManifest(): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return;
        const git = findGitExcludeInfo(root);
        if (!git) return;
        const workspacePrefix = path.relative(git.worktreeRoot, root).split(path.sep).join("/");
        const runtimePrefix = `${workspacePrefix ? `${workspacePrefix}/` : ""}.ai-code-guide`;
        const entries = [`${runtimePrefix}/bridge.json`, `${runtimePrefix}/activation.json`, `${runtimePrefix}/ai-code-guide.mjs`, `${runtimePrefix}/ai-code-guide-mcp.mjs`];
        try {
            const current = fs.readFileSync(git.excludePath, "utf8");
            const lines = new Set(current.split(/\r?\n/));
            const missing = entries.filter((entry) => !lines.has(entry));
            if (missing.length === 0) return;
            fs.appendFileSync(git.excludePath, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${missing.join("\n")}\n`, "utf8");
        } catch (error) {
            console.error("[AI Code Guide] bridge git exclude failed:", error);
        }
    }

    // AI_NOTE: VSIX内のCLIを各ワークスペースへ複製し、外部AIが拡張のインストール場所を
    // 探さなくても固定コマンドで呼べるようにする。毎起動時に上書きして拡張更新へ追従する。
    private installAgentCli(): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return;
        try {
            const targetDir = path.join(root, ".ai-code-guide");
            fs.mkdirSync(targetDir, { recursive: true });
            for (const name of ["ai-code-guide.mjs", "ai-code-guide-mcp.mjs"]) {
                const source = path.join(this.extensionPath, "bin", name);
                if (!fs.existsSync(source)) continue;
                const target = path.join(targetDir, name);
                fs.copyFileSync(source, target);
                fs.chmodSync(target, 0o700);
            }

            // AI_NOTE: ChatGPT/Codex/ClaudeのMCP設定は、ワークスペース内コピーではなく
            // ユーザー共通の固定パスを参照する。ここも拡張起動ごとに同期しないと、
            // 会話内UIだけ古いまま残り、新しいクリック引数などがVS Codeへ届かない。
            const sharedBase = process.platform === "darwin"
                ? path.join(os.homedir(), "Library", "Application Support")
                : process.platform === "win32"
                    ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
                    : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
            const sharedMcpDir = path.join(sharedBase, "AI Code Guide", "mcp");
            const sharedMcpSource = path.join(this.extensionPath, "bin", "ai-code-guide-mcp.mjs");
            if (fs.existsSync(sharedMcpSource)) {
                fs.mkdirSync(sharedMcpDir, { recursive: true, mode: 0o700 });
                const sharedMcpTarget = path.join(sharedMcpDir, "ai-code-guide-mcp.mjs");
                fs.copyFileSync(sharedMcpSource, sharedMcpTarget);
                fs.chmodSync(sharedMcpTarget, 0o700);
            }
        } catch (error) {
            console.error("[AI Code Guide] agent runtime install failed:", error);
        }
    }

    // AI_NOTE: 外部AIには任意VS Codeコマンドを公開せず、理解支援6ビューだけを既存処理へ対応付ける。
    // ファイル検証はHTTP境界で済んでいるため、ここではVS Code表示状態の組み立てだけを担う。
    // AI_NOTE: ASTの同内容要求は共有するが、ここではLLMを呼ばない。失敗を成功キャッシュに残さない。
    private parseSource(source: string) {
        const key = createHash("sha256").update(source).digest("hex");
        const hit = this.sourceParses.get(key);
        if (hit) return hit;
        const task = Promise.all([
            extractGraph(this.extensionPath, source), listFunctions(this.extensionPath, source), getStmtSpans(this.extensionPath, source),
        ]).then(([graph, funcs, spans]) => {
            if (graph.error) this.sourceParses.delete(key);
            return { graph, funcs, spans };
        }).catch((error) => { this.sourceParses.delete(key); throw error; });
        this.sourceParses.set(key, task);
        while (this.sourceParses.size > 32) this.sourceParses.delete(this.sourceParses.keys().next().value!);
        return task;
    }

    // AI_NOTE: 課金状態をコード本文と別に示し、背景待ちでもコードを読めるようにする。
    private publishLayerState(document: vscode.TextDocument): void {
        this.layerRevision++;
        if (this.currentDoc?.uri.toString() !== document.uri.toString()) return;
        const state = this.layerStates.get(document.uri.toString());
        if (!state) return;
        const text = Object.entries(state.layers).map(([name, value]) =>
            `${name === "background" ? "背景" : "名称"}: ${value.message ?? `${value.completed}/${value.total}`}`,
        ).join(" / ");
        this.layerStatus.text = `$(symbol-color) ${text}`;
        this.layerStatus.tooltip = "解説を更新（未保存コードも対象）";
        this.layerStatus.show();
        if (document.getText() === this.refreshedSource) {
            this.meaningRanges = this.colorBackgrounds(this.backgroundService.peek(document.uri.toString(), this.refreshedSource, this.backgroundNodes), this.backgroundNodes);
            this.applyDecorations();
        }
    }

    stopDefaultLayers(document: vscode.TextDocument): void {
        // AI_NOTE: 未開始の要求と表示への適用を止める。送信済み課金の取消を成功扱いしない。
        const uri = document.uri.toString();
        this.generationGate.stop(uri);
        const old = this.layerStates.get(uri)?.layers;
        this.layerStates.set(uri, { source: document.getText(), layers: {
            background: { ...(old?.background ?? { completed: 0, total: 0 }), status: "stopped", message: "停止中" },
            inline: { ...(old?.inline ?? { completed: 0, total: 0 }), status: "stopped", message: "停止中" },
        } });
        this.publishLayerState(document);
    }

    async clearBackgroundCache(): Promise<void> {
        // AI_NOTE: 利用者による消去で未送信の旧要求も失効。消した直後に勝手に再課金しない。
        for (const uri of this.layerStates.keys()) this.generationGate.stop(uri);
        this.backgroundService.clear();
        this.meaningRanges = {};
        this.expandedData = {};
        this.staleExpansions.clear();
        this.expansionTickets.clear();
        this.expandGenerating.clear();
        this.applyDecorations();
        for (const state of this.layerStates.values()) {
            state.layers.background = { status: "stopped", completed: 0, total: 0, message: "キャッシュ消去済み。解説を更新で再生成" };
            if (["queued", "generating"].includes(state.layers.inline.status)) state.layers.inline = {
                ...state.layers.inline, status: "stopped", message: "生成を停止しました",
            };
        }
        if (this.currentDoc) this.publishLayerState(this.currentDoc);
        if (this.view) this.view.webview.html = this.buildHtml();
        await this.backgroundService.flush();
    }

    async prepareDefaultLayers(document: vscode.TextDocument, trigger: GenerationTrigger = "open", respectSettings = false, retryLayer?: keyof DefaultLayers): Promise<void> {
        // AI_NOTE: 自動保存・入力停止はこの許可を発行しない。明示操作以外はdirtyと編集待ちを尊重する。
        if (document.languageId !== "python") return;
        const uri = document.uri.toString();
        const saved = this.layerStates.get(uri);
        // AI_NOTE: 再試行の許可は失敗した同一コードだけ。成功層や停止を暗黙に再開しない。
        if (retryLayer && (saved?.source !== document.getText() || saved.layers[retryLayer].status !== "error")) return;
        if (!this.generationGate.allow(uri, document.isDirty || document.isUntitled, trigger)) {
            await this.annotationProvider.restoreCurrentDocument(document);
            return;
        }
        const source = document.getText();
        const previous = this.layerJobs.get(uri);
        const revision = this.generationGate.revision(uri);
        if (!retryLayer && previous?.source === source && previous.revision === revision) return previous.task;
        const current = () => !document.isClosed && document.getText() === source
            && this.generationGate.revision(uri) === revision && !this.generationGate.isStopped(uri);
        const config = vscode.workspace.getConfiguration("aiCodeGuide", document.uri);
        const backgroundEnabled = retryLayer ? retryLayer === "background" : (!respectSettings && trigger === "explicit") || config.get<boolean>("autoSemanticBackgrounds", true);
        const inlineEnabled = retryLayer ? retryLayer === "inline" : (!respectSettings && trigger === "explicit") || config.get<boolean>("autoInlineAnnotations", true);
        // AI_NOTE: 兄弟層の実行中closureと同じ状態を保持し、その後着完了を失わない。
        const states: DefaultLayers = retryLayer ? saved!.layers : {
            background: { status: backgroundEnabled ? "queued" : "idle", completed: 0, total: 0, message: backgroundEnabled ? "準備中" : "自動生成OFF" },
            inline: { status: inlineEnabled ? "queued" : "idle", completed: 0, total: 0, message: inlineEnabled ? "準備中" : "自動生成OFF" },
        };
        if (retryLayer) states[retryLayer] = { ...states[retryLayer], status: "queued", message: "再試行を準備中" };
        this.layerStates.set(uri, { source, layers: states });
        this.publishLayerState(document);
        const task = (async () => {
            if (previous) await previous.task;
            if (!current()) return;
            if (vscode.window.activeTextEditor?.document.uri.toString() === uri) await this.refresh(document);
            const { graph, spans } = await this.parseSource(source);
            if (!current()) return;
            if (graph.error) throw new Error(`構文を確認してください: ${graph.error}`);
            const nodes = graph.backgroundNodes ?? graph.nodes;
            const background = async () => {
                if (!backgroundEnabled) return;
                states.background = { status: "generating", completed: 0, total: nodes.length, message: "生成中" };
                const result = await this.backgroundService.ensure(uri, source, nodes, spans, {
                    isCurrent: current,
                    onUpdate: (snapshot) => {
                        if (!current()) return;
                        states.background = { status: "generating", completed: snapshot.completed, total: snapshot.total, message: `生成中 ${snapshot.completed}/${snapshot.total}` };
                        this.publishLayerState(document);
                    },
                });
                if (!current()) return;
                const errors = Object.values(result.errors);
                states.background = { status: errors.length ? "error" : "ready", completed: result.completed, total: result.total,
                    message: errors.length ? errors.join(" / ") : `完了 ${result.completed}/${result.total}` };
                this.publishLayerState(document);
            };
            const inline = async () => {
                if (!inlineEnabled) { if (!retryLayer) await this.annotationProvider.restoreCurrentDocument(document); return; }
                states.inline = { status: "generating", completed: 0, total: 0, message: "生成中" };
                this.publishLayerState(document);
                const result = await this.annotationProvider.annotateDocument(document, undefined, undefined, false, { isCurrent: current });
                if (!current()) return;
                await this.annotationProvider.restoreCurrentDocument(document);
                states.inline = { status: result.status === "empty" ? "error" : "ready", completed: result.count, total: result.count,
                    message: result.status === "empty" ? "生成結果を確認してください" : `完了 ${result.count}件` };
                this.publishLayerState(document);
            };
            await Promise.all([background().catch((error) => {
                if (current()) { states.background = { ...states.background, status: "error", message: String(error.message ?? error) }; this.publishLayerState(document); }
            }), inline().catch((error) => {
                if (current()) { states.inline = { ...states.inline, status: "error", message: String(error.message ?? error) }; this.publishLayerState(document); }
            })]);
        })().catch((error) => {
            if (!current()) return;
            if (!retryLayer || retryLayer === "background") states.background = { ...states.background, status: "error", message: String(error.message ?? error) };
            if (!retryLayer || retryLayer === "inline") states.inline = { ...states.inline, status: "error", message: "構文・生成設定を確認してください" };
            this.publishLayerState(document);
        });
        this.layerJobs.set(uri, { source, revision, automatic: trigger !== "explicit", task });
        await task;
        if (this.layerJobs.get(uri)?.task === task) this.layerJobs.delete(uri);
    }

    // AI_NOTE: 全公開結果に同じ内容識別を付ける。非同期生成中の編集で異なるコードの結果を混ぜない。
    private async showAgentView(request: AgentShowRequest): Promise<AgentShowResult> {
        const document = request.absoluteFile ? await vscode.workspace.openTextDocument(request.absoluteFile) : this.currentDoc;
        const source = document?.getText();
        const hash = source === undefined ? undefined : createHash("sha256").update(source).digest("hex");
        if (request.expectedSourceSha256 && request.expectedSourceSha256 !== hash) throw new Error("Source changed; request a new view");
        if (document && request.view === "standard") {
            // AI_NOTE: 非同期再試行はここで失敗状態を検証し、HTTP応答後も拡張が所有する。
            if (request.retryLayer) {
                const state = this.layerStates.get(document.uri.toString());
                if (!state || state.source !== source || state.layers[request.retryLayer].status !== "error") throw new Error("Layer is not retryable");
                void this.prepareDefaultLayers(document, "explicit", true, request.retryLayer);
            }
            if (request.backgroundAction === "stop") this.stopDefaultLayers(document);
            if (request.backgroundAction === "generate") void this.prepareDefaultLayers(document, "explicit", true);
        }
        const result = await this.buildAgentView(request);
        if (document && document.getText() !== source) throw new Error("Source changed; request a new view");
        if (request.view === "standard" && document) {
            const inline = await this.buildAgentView({ view: "inline", absoluteFile: document.uri.fsPath, activate: false });
            result.annotations = inline.annotations;
            const state = this.layerStates.get(document.uri.toString());
            if (state && state.source === source) result.layers = state.layers;
            else result.layers = {
                background: { status: "stale", completed: 0, total: 0, message: "保存後に更新" },
                inline: { status: "stale", completed: 0, total: 0, message: "保存後に更新" },
            };
        }
        if (document && document.getText() !== source) throw new Error("Source changed; request a new view");
        return { ...result, sourceSha256: hash, revision: this.layerRevision };
    }

    private async buildAgentView(request: AgentShowRequest): Promise<AgentShowResult> {
        const tabByView = {
            standard: "standard",
            overview: "overview",
            project: "project",
            diagram: "process",
            inline: "inline",
            trace: "trace",
        } as const;
        const activate = request.activate !== false;
        // AI_NOTE: 明示クリック(focusWindow)以外は、表示更新でVS Codeを前面に出さない。
        const preserveFocus = !request.focusWindow;
        if (activate) await this.reveal(undefined, preserveFocus);
        let relativeFile: string | undefined;
        let preparedGraphNodes: GraphNode[] | null = null;
        let preparedGraphEdges: GraphEdge[] | null = null;
        let preparedGraphRelationships: Array<{ from: string; to: string; line: number }> | null = null;
        let preparedDescriptions: Record<string, string> | null = null;
        let preparedFileOverview: FileOverview | null = null;
        let preparedCoarseGroups: ModuleGroup[] | null = null;
        let preparedMeaningRanges: Record<string, MeaningRange[]> | null = null;
        let preparedExpandedData: Record<string, BlockExpansion> | null = null;
        let targetDocument: vscode.TextDocument | undefined;
        let inlineResult: AnnotateResult | undefined;
        let traceRun: {
            funcNames: string[];
            skipped: string[];
            attempts?: Array<{
                funcName: string;
                arguments?: Record<string, unknown>;
                decision: "safe" | "known-unsafe" | "safety-unknown";
                reason: string;
                guidance?: string;
                states: string[];
                startedAt: string;
                endedAt: string;
                runId?: string;
                returnValue?: { short: string; full: string } | null;
                exception?: string | null;
            }>;
        } | undefined;
        if (request.absoluteFile) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.absoluteFile));
            targetDocument = document;
            if (!isSupportedLanguage(document.languageId)) throw new Error("Supported code files only");
            const zeroBasedLine = Math.min((request.line ?? 1) - 1, Math.max(0, document.lineCount - 1));
            const position = new vscode.Position(zeroBasedLine, 0);
            const rangeStart = request.startLine === undefined
                ? position
                : new vscode.Position(Math.min(request.startLine - 1, document.lineCount - 1), 0);
            const rangeEndLine = request.endLine === undefined
                ? rangeStart.line
                : Math.min(request.endLine - 1, document.lineCount - 1);
            const requestedSelection = request.startLine === undefined
                ? new vscode.Range(position, position)
                : new vscode.Range(rangeStart, document.lineAt(rangeEndLine).range.end);
            if (activate && request.view === "standard" && request.line) {
                // AI_NOTE: 会話内ボタンからの移動は、HTML再生成後のreadyまで対象を保持する。
                // これにより別ファイルでも解析待ち・親クラス展開・中央表示・強調を自動で完了できる。
                this.pendingStandardFocus = {
                    uri: document.uri.toString(),
                    line: zeroBasedLine,
                    // 「内部を展開」は操作直後の確認なので、対象カードまでの移動を演出せず即時にする。
                    instant: Boolean(request.expandLines?.length),
                };
            }
            const isolatedRead = !activate && !request.run
                && (request.view === "standard" || request.view === "overview");
            const backgroundDocumentRequest = !activate
                && (request.view === "inline" || request.view === "trace" || request.view === "diagram");
            if (isolatedRead) {
                // AI_NOTE: activate:false の参照要求は、要求対象だけをローカル解析する。
                // currentDoc/graphNodes/webviewを書き換えると、並列で最後に完了した背景要求が
                // foregroundのエディタと標準タブを別ファイルへ分離してしまうため。
                const source = document.getText();
                const { graph: result, spans: stmtSpans } = await this.parseSource(source);
                preparedGraphNodes = result.error ? [] : result.nodes;
                preparedGraphEdges = result.error ? [] : result.edges;
                preparedGraphRelationships = result.error ? [] : (result.relationships ?? []);
                const lines = source.split("\n");
                preparedMeaningRanges = this.colorBackgrounds(this.backgroundService.peek(document.uri.toString(), source, result.backgroundNodes ?? preparedGraphNodes), result.backgroundNodes ?? preparedGraphNodes);
                preparedDescriptions = {};
                for (const node of preparedGraphNodes) {
                    const cached = this.llmCache.get<string>(this.nodeDescKey(node, lines));
                    if (cached !== undefined) preparedDescriptions[node.id] = cached;
                }
                preparedFileOverview = this.llmCache.get<FileOverview>(this.fileOverviewKeyForNodes(preparedGraphNodes)) ?? null;
                preparedCoarseGroups = this.llmCache.get<ModuleGroup[]>(this.coarseKey(source)) ?? null;
                if (request.view === "standard" && request.expandLines !== undefined) {
                    preparedExpandedData = await this.prepareStandardExpansions(
                        document, result.backgroundNodes ?? preparedGraphNodes, request.expandLines
                    );
                    preparedMeaningRanges = this.colorBackgrounds(this.backgroundService.peek(document.uri.toString(), source, result.backgroundNodes ?? preparedGraphNodes), result.backgroundNodes ?? preparedGraphNodes);
                }
            } else if (backgroundDocumentRequest && request.view === "trace") {
                const result = await extractGraph(this.extensionPath, document.getText());
                preparedGraphNodes = result.error ? [] : result.nodes;
                preparedGraphEdges = result.error ? [] : result.edges;
                preparedGraphRelationships = result.error ? [] : (result.relationships ?? []);
            } else if (!backgroundDocumentRequest) {
                this.suppressActiveEditorRefresh = true;
                try {
                    // AI_NOTE: 生成・実行系は既存コマンドがvisible editorを必要とするため、run時は
                    // 対象文書を表示してから処理する。参照だけのactivate:falseは上で隔離済み。
                    if (activate) {
                        const editor = await vscode.window.showTextDocument(document, {
                            preview: false,
                            selection: requestedSelection,
                            preserveFocus,
                        });
                        editor.revealRange(requestedSelection, vscode.TextEditorRevealType.InCenter);
                        // AI_NOTE: 会話内の「VS Codeで開いて詳細を見る」は、生成の完了を待たずに
                        // 先に該当行を見せる。詳細の生成はこの後も同じ要求内で続ける。
                        if (request.focusWindow && activate) await this.focusHostWindow();
                    }
                    await this.refresh(document);
                } finally {
                    this.suppressActiveEditorRefresh = false;
                }
            }
            const targetRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
            if (targetRoot && this.projectRoot && path.resolve(targetRoot) !== path.resolve(this.projectRoot)) {
                // AI_NOTE: multi-rootで別folderの入口を指定した時、前のprojectDataを再利用すると
                // 実在照合が全落ちするため、入口側のrootへ切り替える前に解析結果だけ破棄する。
                this.projectData = null;
                this.projectRoot = null;
            }
            const root = this.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root) relativeFile = path.relative(root, request.absoluteFile);
        }
        if ((request.view === "project" || request.view === "diagram") && !this.projectData) {
            await this.analyzeProject(activate);
        }
        if (activate && request.view === "standard" && request.expandLines) {
            await this.ensureStandardExpansions(request.expandLines);
        } else if (request.view === "overview" && request.run) {
            await this.generateAgentOverview();
        } else if (request.view === "project" && request.run) {
            await this.generateProjectDescs();
        }
        if (activate) await this.reveal(tabByView[request.view], preserveFocus);
        if (request.view === "inline") {
            const document = targetDocument;
            const editor = document
                ? vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === document.uri.toString())
                : undefined;
            if (!document) throw new Error("Inline explanations require a file");
            const removeIds = request.removeAnnotationIds ?? [];
            const hideIds = request.hideAnnotationIds ?? [];
            const revisionIds = [...removeIds, ...hideIds];
            const before = this.annotationProvider.getSavedAnnotationsForDocument(document).items;
            const knownIds = new Set(before.map((item) => item.id));
            const missingIds = revisionIds.filter((id) => !knownIds.has(id));
            if (missingIds.length > 0) throw new Error(`指定されたインライン解説が見つかりません: ${missingIds.join(", ")}`);
            if (editor && removeIds.length > 0) {
                // AI_NOTE: 同じアンカーへ新しい解説を作る場合も旧full注釈がdedupで勝たないよう、生成前に対象だけ外す。
                // LLM失敗時は下のcatchで完全な保存集合へ戻すため、「置き換え」の途中状態は残らない。
                const removed = new Set(removeIds);
                this.annotationProvider.replaceSavedAnnotations(editor, before.filter((item) => !removed.has(item.id)));
            } else if (removeIds.length > 0) {
                const removed = new Set(removeIds);
                this.annotationProvider.replaceSavedAnnotationsForDocument(document, before.filter((item) => !removed.has(item.id)));
            }
            try {
                if (request.run) {
                    inlineResult = activate
                        ? await vscode.commands.executeCommand<AnnotateResult>(request.startLine === undefined
                            ? "aiCodeGuide.explainBlockInline"
                            : "aiCodeGuide.explainSelection")
                        : await this.annotationProvider.annotateDocument(
                            document, request.startLine, request.endLine
                        );
                    if (!inlineResult || inlineResult.status === "empty" || inlineResult.count === 0) {
                        throw new Error("インライン解説を生成できませんでした。VS Code の通知と AI Code Guide 出力を確認してください。");
                    }
                }
            } catch (error) {
                if (editor && removeIds.length > 0) this.annotationProvider.replaceSavedAnnotations(editor, before);
                else if (removeIds.length > 0) this.annotationProvider.replaceSavedAnnotationsForDocument(document, before);
                throw error;
            }
            if (editor) {
                const uri = editor.document.uri.toString();
                for (const id of removeIds) this.annotationProvider.setAnnotationStatus(uri, id, null);
                for (const id of hideIds) this.annotationProvider.setAnnotationStatus(uri, id, "hidden");
            } else {
                const uri = document.uri.toString();
                for (const id of removeIds) this.annotationProvider.setAnnotationStatus(uri, id, null);
                for (const id of hideIds) this.annotationProvider.setAnnotationStatus(uri, id, "hidden");
            }
            if (activate && !request.run && editor) {
                this.annotationProvider.restoreFromCache(editor);
            }
        } else if (request.view === "trace") {
            if (!request.absoluteFile) throw new Error("Trace requires a file");
            if (!targetDocument) throw new Error("Trace document is unavailable");
            if (request.run) {
                traceRun = await vscode.commands.executeCommand("aiCodeGuide.traceFunctions", {
                    uri: targetDocument.uri.toString(),
                    background: !activate,
                    ...(request.expectedSourceSha256 ? { expectedSourceSha256: request.expectedSourceSha256 } : {}),
                    ...(request.functions === undefined ? {} : { funcs: request.functions }),
                    ...(request.line === undefined ? {} : { line: request.line }),
                    ...(request.arguments === undefined ? {} : { arguments: request.arguments, force: true }),
                });
            } else {
                await vscode.commands.executeCommand("aiCodeGuide.showSavedTraces", {
                    uri: targetDocument.uri.toString(),
                    background: !activate,
                    ...(request.functions === undefined ? {} : { funcs: request.functions }),
                    ...(request.line === undefined ? {} : { line: request.line }),
                    ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
                });
            }
        }
        if (request.view === "diagram") {
            if (activate) this.initialTabOverride = tabByView[request.view];
            try {
                await this.generateProjectDiagram(request.question ?? "", activate);
            } finally {
                if (activate) this.initialTabOverride = null;
            }
            if (!this.projectDiagram || this.projectDiagram.question !== request.question?.trim()) {
                throw new Error(this.projectDiagramError || "Diagram generation failed");
            }
            // AI_NOTE: 完成HTML自身が図タブを初期選択する。ここでの再送は、既にreadyなら即時反映する補助。
            if (activate) await this.reveal(tabByView[request.view], preserveFocus);
            // AI_NOTE: エージェント経由では会話内MCP Appを本体とし、同じ内容をVS Codeにも同期する。
            // 外部ブラウザは利用者が「HTMLで開く」を押した時だけ開く。
            const htmlPath = await this.writeProjectDiagramHtml(false, false);
            return {
                ok: true,
                view: request.view,
                file: relativeFile,
                line: request.line,
                htmlPath,
                question: this.projectDiagram.question,
                diagram: this.projectDiagram.diagram,
            };
        }
        if (request.view === "standard" && request.absoluteFile && relativeFile) {
            let jumpReceipt: AgentShowResult["jumpReceipt"];
            if (request.focusWindow && request.line) {
                // AI_NOTE: 標準カードを再生成・表示した後、Webview側のカード強調だけで終わると
                // エディタのactive lineが以前の位置へ戻ることがある。会話内「コードへ」の
                // 最終状態として要求行へ空selectionを再設定し、status bar/cursorも一致させる。
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.absoluteFile));
                const zeroBasedLine = Math.min(request.line - 1, Math.max(0, document.lineCount - 1));
                const position = new vscode.Position(zeroBasedLine, 0);
                const editor = await vscode.window.showTextDocument(document, {
                    preview: false,
                    preserveFocus: false,
                    selection: new vscode.Range(position, position),
                });
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                await this.focusHostWindow();
                // Windows can deliver the focus/activation event after showTextDocument resolves.
                // The active-editor refresh triggered by that event may briefly restore the
                // previous cursor (often L1).  Do not report the App jump as complete until the
                // requested empty selection has won that final activation race.
                await new Promise<void>((resolve) => setTimeout(resolve, 120));
                const settledEditor = await vscode.window.showTextDocument(document, {
                    preview: false,
                    preserveFocus: false,
                    selection: new vscode.Range(position, position),
                });
                settledEditor.selection = new vscode.Selection(position, position);
                settledEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                const settledPath = path.resolve(settledEditor.document.uri.fsPath);
                const requestedPath = path.resolve(request.absoluteFile);
                if (settledPath !== requestedPath
                    || settledEditor.selection.active.line !== zeroBasedLine
                    || !settledEditor.selection.isEmpty) {
                    throw new Error(`VS Code did not acknowledge the requested code location: ${relativeFile}:${request.line}`);
                }
                jumpReceipt = {
                    receiptId: randomUUID(),
                    acknowledged: true,
                    file: relativeFile.split(path.sep).join("/"),
                    line: request.line,
                    selectionEmpty: true,
                };
            }
            const standardNodes = preparedGraphNodes ?? this.graphNodes;
            const standardDescriptions = preparedDescriptions ?? this.descMap;
            const standardOverview = preparedGraphNodes === null ? this.fileOverview : preparedFileOverview;
            const standardMeaningRanges = preparedMeaningRanges ?? this.meaningRanges;
            // AI_NOTE: Codexの標準WebviewでもVS Codeと同じ意味単位を色で対応づけるため、トップレベルの
            // 関数・クラス色と、子メソッドが継承する親クラス色を表示データとして返す。
            const standardColors = assignNodeColors(standardNodes, new Set(["function", "class"]), true);
            const standardNodesById = new Map(standardNodes.map((node) => [node.id, node]));
            const standardDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(request.absoluteFile));
            const standardLineCount = standardDocument.lineCount > 1
                && standardDocument.lineAt(standardDocument.lineCount - 1).text === ""
                ? standardDocument.lineCount - 1
                : standardDocument.lineCount;
            const standardView: NonNullable<AgentShowResult["standard"]> = {
                title: path.basename(request.absoluteFile),
                file: relativeFile.split(path.sep).join("/"),
                backgroundRanges: Object.values(standardMeaningRanges).flat().map((range) => ({
                    ...range, lineStart: range.lineStart + 1, lineEnd: range.lineEnd + 1,
                })),
                ...(standardOverview?.role ? { role: standardOverview.role } : {}),
                source: Array.from({ length: standardLineCount }, (_, index) => ({
                    line: index + 1,
                    text: standardDocument.lineAt(index).text,
                })),
                items: standardNodes
                    .filter((node): node is GraphNode & { kind: "function" | "class" | "constant" } => node.kind === "function" || node.kind === "class" || node.kind === "constant")
                    .sort((a, b) => a.lineStart - b.lineStart)
                    .map((node) => {
                        const parentColor = node.parent
                            ? standardColors.get(standardNodesById.get(node.parent)?.id ?? "")?.color
                            : undefined;
                        const color = standardColors.get(node.id)?.color ?? parentColor;
                        // AI_NOTE: activate:falseの初期Codex標準表示へ、別表示中の展開状態をID一致だけで
                        // 混ぜない。明示expandLinesがある要求だけpreparedExpandedDataを公開する。
                        const expansion = preparedGraphNodes !== null
                            ? preparedExpandedData?.[node.id]
                            : this.expandedData[node.id];
                        // AI_NOTE: 拡張内部はVS Codeの0始まり座標を保持している。MCP公開境界では
                        // コード全文・定義位置と同じ1始まりに揃え、App側の色範囲を1行ずらさない。
                        const publicExpansion = expansion ? {
                            overview: expansion.overview,
                            blocks: expansion.blocks.map((block) => ({
                                ...block,
                                lineStart: block.lineStart + 1,
                                lineEnd: block.lineEnd + 1,
                            })),
                        } : undefined;
                        return {
                            id: node.id,
                            kind: node.kind,
                            label: node.label,
                            line: node.lineStart + 1,
                            lineEnd: node.lineEnd + 1,
                            ...(node.parent ? { parent: node.parent } : {}),
                            ...(color ? { color } : {}),
                            ...(standardMeaningRanges[node.id]?.length ? {
                                meaningRanges: standardMeaningRanges[node.id].map((range) => ({
                                    ...range,
                                    lineStart: range.lineStart + 1,
                                    lineEnd: range.lineEnd + 1,
                                })),
                            } : {}),
                            ...(standardDescriptions[node.id] ? { description: standardDescriptions[node.id] } : {}),
                            ...(publicExpansion ? { expanded: true, expansion: publicExpansion } : {}),
                        };
                    }),
            };
            return {
                ok: true,
                view: request.view,
                file: relativeFile,
                line: request.line,
                ...(jumpReceipt ? { jumpReceipt } : {}),
                standard: focusStandardView(standardView, request.scopeLine, request.visibleExpandLines),
            };
        }
        if (request.view === "overview" && request.absoluteFile && relativeFile) {
            const overviewNodes = preparedGraphNodes ?? this.graphNodes;
            const overviewDescriptions = preparedDescriptions ?? this.descMap;
            const overviewFile = preparedGraphNodes === null ? this.fileOverview : preparedFileOverview;
            const overviewGroups = preparedGraphNodes === null ? this.coarseGroups : preparedCoarseGroups;
            const nodesById = new Map(overviewNodes.map((node) => [node.id, node]));
            const overviewEdges = preparedGraphEdges ?? this.graphEdges;
            const overviewRelationships = preparedGraphRelationships ?? this.graphRelationships;
            const overviewItems = overviewNodes
                .filter((node): node is GraphNode & { kind: "function" | "class" | "constant" } => node.kind === "function" || node.kind === "class" || node.kind === "constant")
                .sort((a, b) => a.lineStart - b.lineStart);
            const dependencyIds = new Map<string, string[]>();
            for (const edge of overviewEdges) {
                const values = dependencyIds.get(edge.from) ?? [];
                values.push(edge.to);
                dependencyIds.set(edge.from, values);
            }
            const orderedIds: string[] = [];
            const visitedIds = new Set<string>();
            const visit = (id: string): void => {
                if (visitedIds.has(id)) return;
                visitedIds.add(id);
                for (const dependency of dependencyIds.get(id) ?? []) visit(dependency);
                if (nodesById.has(id)) orderedIds.push(id);
            };
            for (const node of overviewItems) visit(node.id);
            return {
                ok: true,
                view: request.view,
                file: relativeFile,
                overview: {
                    title: path.basename(request.absoluteFile),
                    file: relativeFile.split(path.sep).join("/"),
                    ...(overviewFile ? { kind: overviewFile.kind, role: overviewFile.role } : {}),
                    relationships: overviewRelationships.map((relationship) => ({ ...relationship })),
                    readingOrder: orderedIds.flatMap((id) => {
                        const node = nodesById.get(id);
                        if (!node || (node.kind !== "function" && node.kind !== "class" && node.kind !== "constant")) return [];
                        return [{ id: node.id, label: node.label, kind: node.kind, line: node.lineStart + 1 }];
                    }),
                    groups: (overviewGroups ?? []).map((group) => ({
                        label: group.label,
                        items: group.nodeIds.flatMap((id) => {
                            const node = nodesById.get(id);
                            if (!node || (node.kind !== "function" && node.kind !== "class" && node.kind !== "constant")) return [];
                            return [{
                                id: node.id,
                                label: node.label,
                                kind: node.kind,
                                line: node.lineStart + 1,
                                ...(overviewDescriptions[node.id] ? { description: overviewDescriptions[node.id] } : {}),
                            }];
                        }),
                    })),
                },
            };
        }
        if (request.view === "project" && this.projectData) {
            const directories = [...new Set(this.projectData.nodes.map((node) => node.dir || "."))].sort();
            return {
                ok: true,
                view: request.view,
                project: {
                    files: this.projectData.nodes.map((node) => ({
                        id: node.id,
                        path: node.rel_path,
                        directory: node.dir || ".",
                        functions: node.functions,
                        ...(this.projectFileDescs[node.id] ? { description: this.projectFileDescs[node.id] } : {}),
                    })),
                    imports: this.projectData.edges.map((edge) => ({ ...edge })),
                    directories: directories.map((directory) => ({
                        path: directory,
                        ...(this.projectDirDescs[directory] ? { description: this.projectDirDescs[directory] } : {}),
                    })),
                },
            };
        }
        if (request.view === "inline" && request.absoluteFile) {
            const document = targetDocument;
            if (!document) throw new Error("Inline document is unavailable");
            // AI_NOTE: 会話へ返すのは画面上の可視集合ではなく保存済み成果。トレース表示中や「解説を隠す」設定でも
            // generate/show の結果を0件と誤報せず、activate=false の背景取得も画面を切り替えず成立させる。
            const saved = this.annotationProvider.getSavedAnnotationsForDocument(document);
            const contextStart = Math.max(1, Math.min(request.startLine ?? 1, document.lineCount));
            const contextEnd = Math.max(contextStart, Math.min(request.endLine ?? document.lineCount, document.lineCount));
            let contextLabel = request.startLine === undefined ? "ファイル全体" : "選択範囲";
            if (request.startLine !== undefined) {
                // AI_NOTE: 選択範囲が1つの関数/メソッド/クラス内に収まる場合は、Webプレビューの
                // 主単位をその名前で示す。注釈kindではなく「何を理解しているか」を見出しにする。
                for (let index = contextStart - 1; index >= 0; index -= 1) {
                    const text = document.lineAt(index).text;
                    const match = /^(\s*)(?:(async)\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(text);
                    if (!match) continue;
                    const indent = match[1].replace(/\t/g, "    ").length;
                    let blockEnd = document.lineCount;
                    for (let next = index + 1; next < document.lineCount; next += 1) {
                        const candidate = document.lineAt(next).text;
                        if (!candidate.trim()) continue;
                        const candidateIndent = (candidate.match(/^[ \t]*/) ?? [""])[0].replace(/\t/g, "    ").length;
                        if (candidateIndent <= indent) {
                            blockEnd = next;
                            break;
                        }
                    }
                    if (contextEnd <= blockEnd) {
                        const kind = match[3] === "class" ? "クラス" : indent > 0 ? "メソッド" : "関数";
                        contextLabel = `${kind} ${match[4]}`;
                        break;
                    }
                }
            }
            const visibleSaved = saved.items.filter((item) => !this.annotationProvider.isAnnotationHidden(document.uri.toString(), item.id));
            const scopedItems = request.startLine === undefined
                ? visibleSaved
                : visibleSaved.filter((item) => item.endLine + 1 >= contextStart && item.startLine + 1 <= contextEnd);
            return {
                ok: true,
                view: request.view,
                file: relativeFile,
                annotations: {
                    ...(saved.generatedAt ? { generatedAt: saved.generatedAt.toISOString() } : {}),
                    ...((request.removeAnnotationIds?.length || request.hideAnnotationIds?.length) ? {
                        changes: {
                            removedIds: request.removeAnnotationIds ?? [],
                            hiddenIds: request.hideAnnotationIds ?? [],
                        },
                    } : {}),
                    context: {
                        label: contextLabel,
                        startLine: contextStart,
                        endLine: contextEnd,
                        code: Array.from(
                            { length: contextEnd - contextStart + 1 },
                            (_, offset) => {
                                const line = contextStart + offset;
                                return { line, text: document.lineAt(line - 1).text };
                            },
                        ),
                    },
                    items: scopedItems.map((item) => {
                        // AI_NOTE: 会話内は対象の前後だけを返す。長いblockは先頭/末尾を残し、
                        // 全体を読む操作は既存のVS Codeジャンプへ委ねる。
                        const first = Math.max(0, item.startLine - 1);
                        const last = Math.min(document.lineCount - 1, item.endLine + 1);
                        const all = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
                        const indexes = all.length <= 12 ? all : [...all.slice(0, 6), ...all.slice(-6)];
                        return {
                            id: item.id,
                            kind: item.kind,
                            label: item.label,
                            explanation: item.explanation,
                            startLine: item.startLine + 1,
                            endLine: item.endLine + 1,
                            startCol: item.startCol,
                            endCol: item.endCol,
                            ...(item.scope ? { scope: item.scope } : {}),
                            ...(item.symbolKey ? { symbolKey: item.symbolKey } : {}),
                            ...(item.symbolKind ? { symbolKind: item.symbolKind } : {}),
                            code: indexes.map((index) => ({ line: index + 1, text: document.lineAt(index).text })),
                        };
                    }),
                },
            };
        }
        if (request.view === "trace" && request.absoluteFile) {
            if (request.run && traceRun && traceRun.funcNames.length === 0 && !(traceRun.attempts?.length)) {
                throw new Error(`実行トレースを作成できませんでした: ${traceRun.skipped.join(" / ") || "理由不明"}`);
            }
            let entryReceipt: { id: string; attempts: AgentTraceAttempt[]; state: "open" | "closed" } | undefined;
            const entryKey = path.resolve(request.absoluteFile);
            const receiptKey = this.traceReceiptKey(entryKey, request.functions, request.arguments);
            if (request.run && traceRun?.attempts?.length) {
                const key = entryKey;
                const active = this.activeTraceEntries.get(key);
                const entry = active && (!request.traceEntryId || active.id === request.traceEntryId)
                    ? active
                    : { id: request.traceEntryId ?? randomUUID(), attempts: [] as AgentTraceAttempt[] };
                const sourceSha256 = createHash("sha256").update(fs.readFileSync(request.absoluteFile)).digest("hex");
                for (const attempt of traceRun.attempts) {
                    const receiptBase = {
                        traceEntryId: entry.id,
                        attemptNumber: entry.attempts.length + 1,
                        runReceiptId: attempt.runId ?? randomUUID(),
                        target: `${key}::${attempt.funcName}`,
                        ...(attempt.arguments === undefined ? {} : { arguments: attempt.arguments }),
                        safetyDecision: attempt.decision,
                        safetyReason: attempt.reason,
                        ...(attempt.guidance ? { retryGuidance: attempt.guidance } : {}),
                        states: [...attempt.states],
                        startedAt: attempt.startedAt,
                        endedAt: attempt.endedAt,
                        invocationCount: (attempt.decision === "safe" ? 1 : 0) as 0 | 1,
                        ...(attempt.runId ? { runId: attempt.runId } : {}),
                        ...(attempt.returnValue !== undefined ? { returnValue: attempt.returnValue } : {}),
                        ...(attempt.exception ? { exception: attempt.exception } : {}),
                        sourceSha256,
                        surfaces: ["codex-app", "in-app-browser", "vscode"],
                    };
                    const traceSha256 = createHash("sha256").update(JSON.stringify({
                        target: receiptBase.target,
                        arguments: receiptBase.arguments,
                        states: receiptBase.states,
                        returnValue: receiptBase.returnValue,
                        exception: receiptBase.exception,
                        runId: receiptBase.runId,
                    })).digest("hex");
                    const receiptWithTrace = { ...receiptBase, traceSha256 };
                    entry.attempts.push({
                        ...receiptWithTrace,
                        artifactSha256: createHash("sha256").update(JSON.stringify(receiptWithTrace)).digest("hex"),
                    });
                }
                const succeeded = traceRun.attempts.some((attempt) => attempt.states.at(-1) === "success");
                if (succeeded) {
                    this.activeTraceEntries.delete(key);
                    this.latestTraceEntries.set(receiptKey, { id: entry.id, attempts: [...entry.attempts], state: "closed" });
                } else {
                    this.activeTraceEntries.set(key, entry);
                    this.latestTraceEntries.set(receiptKey, { id: entry.id, attempts: [...entry.attempts], state: "open" });
                }
                entryReceipt = { id: entry.id, attempts: [...entry.attempts], state: succeeded ? "closed" : "open" };
            } else if (!request.run) {
                entryReceipt = this.latestTraceEntries.get(receiptKey);
            }
            if (!targetDocument) throw new Error("Trace document is unavailable");
            const traceUri = targetDocument.uri.toString();
            const status = this.traceProvider?.getStatus(traceUri) ?? null;
            const allTraces = this.traceProvider?.getConversationTraces(traceUri) ?? [];
            const currentRunIds = new Set(traceRun?.attempts?.flatMap((attempt) => attempt.runId ? [attempt.runId] : []) ?? []);
            const traces = request.run ? allTraces.filter((trace) => trace.runId && currentRunIds.has(trace.runId)) : allTraces;
            // AI_NOTE: トレースでも標準タブの意味単位色をコード面へ重ねる。色は別パレットを
            // 作らず、トップレベル関数・クラスへ割り当てた標準タブと同じ値を引き継ぐ。
            const traceGraphNodes = preparedGraphNodes ?? this.graphNodes;
            const traceStandardColors = assignNodeColors(traceGraphNodes, new Set(["function", "class"]), true);
            const traceNodesById = new Map(traceGraphNodes.map((node) => [node.id, node]));
            const traceColorAt = (line: number): string | undefined => {
                let node: GraphNode | undefined = traceGraphNodes
                    .filter((candidate) => (candidate.kind === "function" || candidate.kind === "class")
                        && line >= candidate.lineStart + 1 && line <= candidate.lineEnd + 1)
                    .sort((left, right) => (left.lineEnd - left.lineStart) - (right.lineEnd - right.lineStart))[0];
                while (node?.parent) node = traceNodesById.get(node.parent);
                return node ? traceStandardColors.get(node.id)?.color : undefined;
            };
            return {
                ok: true,
                view: request.view,
                file: relativeFile,
                line: request.line,
                trace: {
                    ...(request.run ? { funcNames: traceRun?.funcNames ?? [], loopCount: traces.reduce((count, trace) => count + (trace.loop ? 1 : 0), 0) } : (status ?? { funcNames: [], loopCount: 0 })),
                    ...(traceRun?.skipped.length ? { skipped: traceRun.skipped } : {}),
                    ...(entryReceipt ? { traceEntryId: entryReceipt.id, entryState: entryReceipt.state, attempts: entryReceipt.attempts } : {}),
                    functions: traces.map((trace) => {
                        const document = targetDocument;
                        const attempt = entryReceipt?.attempts.find((candidate) => candidate.runId === trace.runId)
                            ?? entryReceipt?.attempts.find((candidate) => candidate.target.endsWith(`::${trace.funcName}`));
                        // AI_NOTE: 値が変わった行だけへ間引くと、条件式やreturnの開始行が
                        // 「実行されなかったコード」に見え、しかも会話内で復元できない。
                        // 実行対象の関数は全行を渡し、コード理解を表示最適化より優先する。
                        const first = Math.max(1, trace.startLine);
                        const last = Math.min(document.lineCount, trace.endLine);
                        const lines = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
                        const color = traceColorAt(first);
                        return {
                            ...trace,
                            ...(color ? { color } : {}),
                            sourceSha256: attempt?.sourceSha256 ?? createHash("sha256").update(fs.readFileSync(request.absoluteFile!)).digest("hex"),
                            ...(attempt ? { runReceiptId: attempt.runReceiptId, safetyDecision: attempt.safetyDecision } : {}),
                            role: `${trace.funcName}() の具体的な実行結果`,
                            location: `${relativeFile ?? request.absoluteFile}:L${first}–L${last}`,
                            controlPath: (trace.pathEvents ?? []).map((event) => ({ line: event.line, outcome: event.outcome })),
                            keyValues: Object.entries(trace.finalLocals ?? {}).filter(([name]) => !["service", "error", "raised"].includes(name)).map(([name, value]) => ({
                                line: trace.endLine,
                                text: `${name} = ${value.full}`,
                            })),
                            code: lines.map((line) => ({ line, text: document.lineAt(line - 1).text })),
                        };
                    }),
                },
            };
        }
        return { ok: true, view: request.view, file: relativeFile, line: request.line };
    }

    // Generate standard-card details for Codex without replacing the VS Code
    // sidebar's current document, expanded cards, selection, or decorations.
    private async prepareStandardExpansions(
        document: vscode.TextDocument,
        graphNodes: GraphNode[],
        lines: number[],
    ): Promise<Record<string, BlockExpansion>> {
        const source = document.getText();
        const targets = [...new Set(lines)].flatMap((oneBasedLine) => {
            const line = oneBasedLine - 1;
            const node = graphNodes
                .filter((candidate) => line >= candidate.lineStart && line <= candidate.lineEnd)
                .sort((left, right) => (left.lineEnd - left.lineStart) - (right.lineEnd - right.lineStart))[0];
            return node ? [node] : [];
        }).filter((node, index, all) => all.findIndex((candidate) => candidate.id === node.id) === index);
        const result: Record<string, BlockExpansion> = {};
        const { spans: stmtSpans } = await this.parseSource(source);
        for (const node of targets) {
            // AI_NOTE: 背景の区切りを固定して説明だけ追加。閉じた対象や他関数の詳細は生成しない。
            result[node.id] = await this.backgroundService.details(document.uri.toString(), source, graphNodes, stmtSpans, node.id,
                () => document.getText() === source);
        }
        return result;
    }

    // AI_NOTE: AIが選んだ0〜複数カードを「必ず開いた状態」にする。toggleExpandを直接連打すると
    // 既に開いているカードを閉じるため、実在ノードへ解決して未展開だけ既存生成経路へ渡す。
    private async ensureStandardExpansions(lines: number[]): Promise<void> {
        const nodes = [...new Set(lines)]
            .map((line) => this.nodeAtLine(line - 1))
            .filter((node): node is GraphNode => Boolean(node))
            .filter((node, index, all) => all.findIndex((candidate) => candidate.id === node.id) === index);
        for (const node of nodes) {
            if (this.expandedData[node.id]) continue;
            await this.toggleExpand(node.id, node.lineStart, node.lineEnd, node.label);
        }
    }

    // AI_NOTE: エディタの現在行に対応する標準カードへ移る入口。最も内側のノードを選び、クラスを畳んでいても
    // webview側で開いてから中央へ寄せるため、関数やクラスが多いファイルでもカードを目で探さなくてよい。
    async revealCurrentStandardCard(): Promise<void> {
        const editor = this.getCurrentEditor() ?? vscode.window.activeTextEditor;
        if (!editor || editor.document !== this.currentDoc) {
            vscode.window.showInformationMessage("AI Code Guide: 表示中の対応コードで、移動したい場所にカーソルを置いてください。");
            return;
        }
        const line = editor.selection.active.line;
        const node = this.nodeAtLine(line);
        if (!node) {
            vscode.window.showInformationMessage("AI Code Guide: この行に対応する標準カードはありません。");
            return;
        }
        // 単一関数の図を表示中でも、カード一覧へ戻して対象を示す。
        if (this.targetFunc || this.funcGraph) {
            this.targetFunc = "";
            this.funcGraph = null;
            this.rerender();
        }
        await this.reveal("standard");
        this.view?.webview.postMessage({ type: "focusStandardCard", nodeId: node.id });
    }

    private nodeAtLine(line: number): GraphNode | undefined {
        return this.graphNodes
            .filter((node) => line >= node.lineStart && line <= node.lineEnd)
            .sort((a, b) => (a.lineEnd - a.lineStart) - (b.lineEnd - b.lineStart))[0];
    }

    // AI_NOTE: チャットペインのインライン解説コントロール用。注釈変化で webview を再描画して件数/一覧を最新化する
    private readonly annotationProvider: SemanticAnnotationProvider;
    // AI_NOTE: chatLinks(チャット引用→過去チャットのリンク)の永続レイヤー。runChat 完了時に引用箇所へリンクを追記する(Step2)。
    // annotationProvider と同一インスタンスを共有し、生成した直後の再描画に載るようにする。
    private readonly chatLinkStore: ChatLinkStore;
    // AI_NOTE: 「選択範囲を解析」を未選択状態で押した時のモードフラグ。次の非空選択を待って自動で annotate を発火する。
    // 学習コストを下げるための導線(ボタン→選択待ち→自動実行)で、複雑な分岐挙動の代わりに「説明とともに次のアクションが残る」UXを作る。
    private awaitingSelection = false;
    // AI_NOTE: 選択ドラッグ中は何度も発火するためデバウンス。確定とみなす待ち時間
    private selectionDebounce: NodeJS.Timeout | null = null;
    // AI_NOTE: 編集(手入力/外部書き込み)ごとに onDidChangeTextDocument が1文字単位で発火するため、
    // 入力が止まってから(500ms)まとめて refresh する。保存不要でフローチャートを最新に追従させる。
    private refreshDebounce: NodeJS.Timeout | null = null;
    // AI_NOTE: エージェント表示は showTextDocument 後に同じ文書を明示refreshする。
    // onDidChangeActiveTextEditor側まで並走すると、遅い方のHTMLが要求タブを上書きするため抑止する。
    private suppressActiveEditorRefresh = false;
    // AI_NOTE: 図ノードからコードを開く途中は、エディタ選択イベントよりPython解析完了が後になる。
    // 解析後のWebviewがreadyを返すまで移動先を保持し、描き直された標準カードへ確実にハイライトを付け直す。
    private pendingStandardFocus: { uri: string; line: number; instant?: boolean } | null = null;
    // A rejected or failed attempt leaves the public trace entry open. The next run for the
    // same file continues that entry; a successful terminal attempt closes it.
    private static readonly sharedActiveTraceEntries = new Map<string, { id: string; attempts: AgentTraceAttempt[] }>();
    private readonly activeTraceEntries = MainViewProvider.sharedActiveTraceEntries;
    // A saved trace must retain the identity of the run that produced it so
    // App and Browser evidence can be compared by receipt, not just by value.
    private readonly latestTraceEntries = new Map<string, { id: string; attempts: AgentTraceAttempt[]; state: "open" | "closed" }>();

    private traceReceiptKey(file: string, functions?: string[], callArguments?: Record<string, unknown>): string {
        const sort = (value: unknown): unknown => Array.isArray(value)
            ? value.map(sort)
            : value && typeof value === "object"
                ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, nested]) => [key, sort(nested)]))
                : value;
        return JSON.stringify({ file, functions: functions ?? [], arguments: sort(callArguments ?? null) });
    }

    constructor(context: vscode.ExtensionContext, annotationProvider: SemanticAnnotationProvider, chatLinkStore: ChatLinkStore) {
        this.extensionPath = context.extensionPath;
        this.globalStoragePath = context.globalStorageUri.fsPath;
        this.backgroundService = new SemanticBackgroundService(this.globalStoragePath);
        this.layerStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
        this.layerStatus.command = "aiCodeGuide.updateDefaultLayers";
        context.subscriptions.push(this.layerStatus, { dispose: () => { void this.backgroundService.flush(); } });
        this.projectDiagramBridge = new ProjectDiagramBridge({
            getWorkspaceRoot: () => this.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            getManifestPath: () => {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                return root ? path.join(root, ".ai-code-guide", "bridge.json") : undefined;
            },
            getRegistryPath: () => {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                return root ? path.join(os.homedir(), ".ai-code-guide", "bridges", `${fnv1a(path.resolve(root))}.json`) : undefined;
            },
            getActivationPath: () => {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                return root ? path.join(root, ".ai-code-guide", "activation.json") : undefined;
            },
            openFile: async (absolutePath, zeroBasedLine) => {
                await this.openProjectSymbol(absolutePath, zeroBasedLine);
            },
            showView: async (request) => this.showAgentView(request),
            refineSymbol: async (args) => {
                const root = this.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!root) throw new Error("Workspace unavailable");
                const document = await vscode.workspace.openTextDocument(path.resolve(root, args.file));
                if (args.expectedSourceSha256 && createHash("sha256").update(document.getText()).digest("hex") !== args.expectedSourceSha256) {
                    throw new Error("Source changed; request a new view");
                }
                return refineSymbolDictionaryExplanation({
                    code: document.getText(),
                    display: args.display,
                    kind: args.kind,
                    current: args.current,
                    question: args.question,
                    history: args.history,
                });
            },
            updateSymbolExplanation: async (file, symbolKey, explanation, expectedSourceSha256) => {
                const root = this.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!root) throw new Error("Workspace unavailable");
                const document = await vscode.workspace.openTextDocument(path.resolve(root, file));
                if (expectedSourceSha256 && createHash("sha256").update(document.getText()).digest("hex") !== expectedSourceSha256) {
                    throw new Error("Source changed; request a new view");
                }
                if (this.annotationProvider.updateSymbolExplanationForDocument(document, symbolKey, explanation) === 0) {
                    throw new Error("更新対象の名称が見つかりませんでした。");
                }
            },
        });
        this.excludeAgentBridgeManifest();
        this.installAgentCli();
        this.projectDiagramBridgeReady = this.projectDiagramBridge.start();
        context.subscriptions.push(this.projectDiagramBridge);
        this.llmCache = new PersistentCache(context.globalStorageUri.fsPath);
        this.chatStore = new ChatStore(context.globalStorageUri.fsPath);
        this.projectDiagramStore = new ProjectDiagramStore(context.globalStorageUri.fsPath);
        // AI_NOTE: 構成を解析する前でも、ワークスペース別の図の履歴は表示できる。
        this.projectDiagramHistory = this.projectDiagramStore.list(this.projectDiagramWorkspaceKey());
        this.annotationProvider = annotationProvider;
        this.chatLinkStore = chatLinkStore;
        // AI_NOTE: 拡張の生存期間ずっと購読する。アクティブPythonに追従してサイドバーを更新する
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor((e) => {
                const activeUri = e?.document.uri.toString();
                for (const [uri, job] of this.layerJobs) {
                    if (job.automatic && uri !== activeUri && job.revision === this.generationGate.revision(uri)) {
                        // AI_NOTE: 別ファイルへ移ったら未送信だけ休止。停止ボタンとは異なり、戻った時は不足分を再開できる。
                        this.generationGate.pause(uri);
                        const state = this.layerStates.get(uri);
                        if (state) for (const layer of Object.values(state.layers)) {
                            if (layer.status === "queued" || layer.status === "generating") {
                                layer.status = "idle"; layer.message = "別ファイルへ移動したため休止中";
                            }
                        }
                    }
                }
                if (!this.suppressActiveEditorRefresh) void this.refresh(e?.document);
            }),
            vscode.workspace.onWillSaveTextDocument((event) => {
                this.saveReasons.set(event.document.uri.toString(), event.reason);
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                // AI_NOTE: 手動保存の通知だけが課金許可。自動保存・focus移動保存は表示更新に留める。
                const uri = doc.uri.toString();
                const reason = this.saveReasons.get(uri);
                this.saveReasons.delete(uri);
                if (this.currentDoc?.uri.toString() === uri) void this.refresh(doc);
                if (reason === vscode.TextDocumentSaveReason.Manual) void this.prepareDefaultLayers(doc, "save");
            }),
            // AI_NOTE: 保存を待たず、編集中(手入力/Claude Codeの外部書き込み)にもフローチャートを追従させる。
            // 表示中の currentDoc かつ Python のときだけ、入力が止まってから(500ms デバウンス)refresh する。
            // refresh は AST パースのみでLLMは叩かない(説明はキャッシュ読取)ためトークンコストは無い。
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.languageId !== "python" || !e.contentChanges.length) return;
                const uri = e.document.uri.toString();
                this.generationGate.edit(uri);
                if (!this.currentDoc || uri !== this.currentDoc.uri.toString()) return;
                this.meaningRanges = {};
                this.applyDecorations();
                for (const id of Object.keys(this.expandedData)) this.staleExpansions.add(id);
                this.layerStates.set(uri, { source: e.document.getText(), layers: {
                    background: { status: "stale", completed: 0, total: 0, message: "保存後に更新" },
                    inline: { status: "stale", completed: 0, total: 0, message: "保存後に更新" },
                } });
                this.publishLayerState(e.document);
                if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
                this.refreshDebounce = setTimeout(() => this.refresh(e.document), 500);
            }),
            // AI_NOTE: 別エディタで同じファイルを表示した時も装飾を貼り直す
            vscode.window.onDidChangeVisibleTextEditors(() => this.applyDecorations()),
            // AI_NOTE: エディタのカーソル位置に対応するカードをサイドバーで強調する(エディタ連動)。
            // 加えて「選択待ち」モード中なら、非空選択が500ms安定したら自動で annotate を発火する。
            vscode.window.onDidChangeTextEditorSelection((e) => {
                if (e.textEditor.document !== this.currentDoc || !this.view) return;
                const line = e.selections[0].active.line;
                const node = this.nodeAtLine(line);
                this.view.webview.postMessage({ type: "highlightCard", nodeId: node?.id ?? "" });
                if (this.awaitingSelection && !e.selections[0].isEmpty) this.scheduleAwaitingFire(e.textEditor);
                // AI_NOTE: 非空のPython選択を「引用候補」として覚え、コードだけwebviewへ送る。
                // webview はチャット欄への貼り付けがこのコードと一致したらチップ化する（貼り付け=引用のCursor風導線）。
                const sel = e.selections[0];
                if (!sel.isEmpty && isSupportedLanguage(e.textEditor.document.languageId)) {
                    const code = e.textEditor.document.getText(sel);
                    this.lastQuoteCandidate = {
                        code,
                        fileName: e.textEditor.document.fileName.split("/").pop() ?? "unknown",
                        lineStart: sel.start.line + 1,
                        lineEnd: sel.end.line + 1,
                    };
                    // AI_NOTE: fileName/lineStart/lineEndも渡す。webview側がペースト直後にチップラベルを組み立てる(html再生成無しで正確な表記にするため)。
                    this.view.webview.postMessage({ type: "quoteCandidate", code, fileName: this.lastQuoteCandidate.fileName, lineStart: this.lastQuoteCandidate.lineStart, lineEnd: this.lastQuoteCandidate.lineEnd });
                }
            }),
            // AI_NOTE: #12 設定が(設定タブ/標準設定UIどちらで)変わってもUIを最新値に追従させる
            vscode.workspace.onDidChangeConfiguration((e) => {
                const generationSettingChanged = ["globalContext", "model", "inlineAnnotationModel", "useSubscription", "subscriptionProvider", "autoSemanticBackgrounds", "autoInlineAnnotations"]
                    .some(key => e.affectsConfiguration(`aiCodeGuide.${key}`));
                if (generationSettingChanged) {
                    for (const uri of this.layerStates.keys()) this.generationGate.edit(uri);
                    for (const state of this.layerStates.values()) for (const layer of Object.values(state.layers)) {
                        layer.status = "stale"; layer.message = "設定変更後の更新待ち";
                    }
                    if (this.currentDoc) {
                        for (const id of Object.keys(this.expandedData)) this.staleExpansions.add(id);
                        void this.annotationProvider.restoreCurrentDocument(this.currentDoc);
                        this.publishLayerState(this.currentDoc);
                    }
                }
                if (e.affectsConfiguration("aiCodeGuide") && this.view) this.view.webview.html = this.buildHtml();
            }),
            // AI_NOTE: インライン解説の生成/クリアで件数バッジだけを更新する。
            // HTML全再描画にすると直後に出すボタンの完了フラッシュ(✓N件/表示済み)が消えてしまうため、postMessage で軽量更新する。
            annotationProvider.onDidChangeAnnotations((uri) => {
                if (!this.view || !this.currentDoc || uri.toString() !== this.currentDoc.uri.toString()) return;
                const editor = this.getCurrentEditor();
                const items = editor ? this.annotationProvider.getAnnotations(editor).items : [];
                const time = editor ? this.annotationProvider.getAnnotations(editor).generatedAt : null;
                this.view.webview.postMessage({
                    type: "annCount", count: items.length,
                    time: time ? time.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "",
                });
            }),
            { dispose: () => { if (this.refreshDebounce) clearTimeout(this.refreshDebounce); this.disposeDecorations(); } }
        );
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(this.extensionPath)],
        };
        webviewView.webview.onDidReceiveMessage(async (msg: { type?: string; line?: number; lineStart?: number; lineEnd?: number; key?: string; value?: unknown; text?: string; nodeId?: string; label?: string; command?: string; ids?: string[]; funcs?: string[]; funcName?: string; loopId?: number; delta?: number }) => {
            // AI_NOTE: #4 カード本体クリックは常にエディタの該当行へジャンプする(ドリルインしない)。
            // 単一関数フローチャート(mermaid)へは関数カードの「図」ボタン(type:'drill')で明示的に入る。
            if (msg.type === "nodeClick" && msg.lineStart !== undefined) {
                this.jumpToLine(msg.lineStart, msg.lineEnd ?? msg.lineStart);
            } else if (msg.type === "drill" && msg.lineStart !== undefined) {
                this.drillIntoLine(msg.lineStart).catch((e) => console.error("[AI Code Guide] drill failed:", e));
            } else if (msg.type === "jumpCode" && msg.lineStart !== undefined) {
                // AI_NOTE: サブブロック等は常にコードへジャンプ(ドリルインしない)
                this.jumpToLine(msg.lineStart, msg.lineEnd ?? msg.lineStart);
            } else if (msg.type === "backToOverview") {
                this.targetFunc = "";
                this.funcGraph = null;
                this.resetNaturalLabels();
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "toggleNaturalLabels") {
                this.toggleNaturalLabels().catch((e) => console.error("[AI Code Guide] natural labels failed:", e));
            } else if (msg.type === "generateDesc") {
                this.generateDescriptions().catch((e) => console.error("[AI Code Guide] desc gen failed:", e));
            } else if (msg.type === "toggleArrows") {
                this.arrowsEnabled = !this.arrowsEnabled;
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "toggleOverviewArrows") {
                this.overviewArrows = !this.overviewArrows;
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "updateDefaultLayers") {
                if (this.currentDoc) void this.prepareDefaultLayers(this.currentDoc, "explicit");
            } else if (msg.type === "stopDefaultLayers") {
                if (this.currentDoc) this.stopDefaultLayers(this.currentDoc);
            } else if (msg.type === "toggleColoring") {
                this.coloringEnabled = !this.coloringEnabled;
                this.applyDecorations();
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "setConfig" && msg.key !== undefined) {
                // AI_NOTE: #12 設定タブからの変更。VS Codeのグローバル設定を更新し、UIを最新値で描き直す
                vscode.workspace.getConfiguration("aiCodeGuide").update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
            } else if (msg.type === "openApiKeySetting") {
                // AI_NOTE: APIキーは機微情報。webviewで値を扱わず、SecretStorage保存のコマンド(setApiKey)に飛ばす。
                // 入力/削除の完了後にタブを描き直して「設定済み/未設定」を最新化する。
                const provider = settingToProvider(typeof msg.key === "string" ? msg.key : "anthropicApiKey") ?? "anthropic";
                vscode.commands.executeCommand("aiCodeGuide.setApiKey", provider).then(() => {
                    if (this.view) this.view.webview.html = this.buildHtml();
                });
            } else if (msg.type === "runCommand" && typeof msg.command === "string") {
                // AI_NOTE: ヘルプタブのボタンから拡張コマンドを起動する。webviewから任意コマンドを呼べると危険なので、
                // ヘルプで案内するコマンドだけのホワイトリストに限定する。
                // AI_NOTE: ヘルプタブの「よく使う操作」追加に伴い clear/setApiKey を許可。ホワイトリスト方式は維持
                const allowed = new Set(["aiCodeGuide.showFlowchart", "aiCodeGuide.explainBlockInline", "aiCodeGuide.clearBlockExplanations", "aiCodeGuide.setApiKey", "aiCodeGuide.openWalkthrough", "aiCodeGuide.openHelpPage"]);
                if (allowed.has(msg.command)) vscode.commands.executeCommand(msg.command);
            } else if (msg.type === "helpAsk" && typeof msg.text === "string") {
                // AI_NOTE: ヘルプタブの質問送信。ヘルプ本文を文脈にLLMへ投げ、回答をペインに表示する。
                this.handleHelpAsk(msg.text).catch((e) => console.error("[AI Code Guide] help ask failed:", e));
            } else if (msg.type === "separateLogin" || msg.type === "separateLogout") {
                // AI_NOTE: 専用CONFIG_DIRで `claude auth login/logout` をターミナル実行。env で CLAUDE_CONFIG_DIR を渡し
                // 既定ログイン(キーチェーン)と分離する。完全ログイン＝profileスコープなので後で名前/メールも確認できる。
                // 起動引数方式(キー入力を注入しない)＋先頭 -i 無しでユーザー環境の pyenv 60秒ハングを踏まない。claudeは絶対パス。
                const claudePath = resolveCommand(vscode.workspace.getConfiguration("aiCodeGuide").get<string>("claudeCliPath", "claude") ?? "claude", "claude");
                const sub = msg.type === "separateLogin" ? "login" : "logout";
                const shell = vscode.env.shell || "/bin/zsh";
                const opts: vscode.TerminalOptions = { name: `Claude ${sub} (別アカウント)`, env: { CLAUDE_CONFIG_DIR: separateClaudeConfigDir() } };
                const posix = /\/(zsh|bash|sh)$/.test(shell);
                if (posix) { opts.shellPath = shell; opts.shellArgs = ["-c", `${claudePath} auth ${sub}; exec ${shell} -i`]; }
                const term = vscode.window.createTerminal(opts);
                term.show();
                if (!posix) term.sendText(`${claudePath} auth ${sub}`);
            } else if (msg.type === "verifyAccount") {
                // AI_NOTE: 専用ログインのアカウント情報(メール/名前/プラン/組織)を `claude auth status --json` で取得して表示。
                this.verifySeparateAccount().catch((e) => console.error("[AI Code Guide] verify account failed:", e));
            } else if (msg.type === "createDesignFile" && typeof msg.text === "string") {
                // AI_NOTE: 空欄入口ボタン。見ている場所=範囲としてkind+relPathをそのままscopeへ組み立てる
                // (aiCodeGuide.copyDesignPromptコマンドと違いQuickPickを経由しない専用配線)。
                const kind = msg.text as DesignScope["kind"];
                const relPath = typeof msg.label === "string" ? msg.label : "";
                const scope: DesignScope = kind === "repo" ? { kind: "repo" } : kind === "directory" ? { kind: "directory", relPath } : { kind: "file", relPath };
                // AI_NOTE: 既存の設計mdがあれば更新モード(@confirmed維持+既存md埋め込み)のプロンプトに切り替える
                // (「設計を更新」リンクと空欄入口ボタンで同じメッセージを使うため、有無はここで判定する)。
                const root = this.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
                const existingMd = root ? readExistingDesignMd(root, scope) : null;
                vscode.env.clipboard.writeText(buildDesignPrompt(scope, existingMd ?? undefined));
                vscode.window.showInformationMessage(`AI Code Guide: 設計ファイル${existingMd ? "更新" : "作成"}プロンプトをコピーしました。コピーしたプロンプトを Claude Code / codex に貼ると、確認の後に設計ファイルが${existingMd ? "更新" : "作成"}されます。`);
            } else if (msg.type === "copyText" && typeof msg.text === "string") {
                // AI_NOTE: コード欄の「コピー」。webviewのclipboard書込はCSPで不安定なので拡張側で確実に書く。
                vscode.env.clipboard.writeText(msg.text);
                vscode.window.showInformationMessage(`AI Code Guide: コピーしました: ${msg.text}`);
            } else if (msg.type === "chatSend" && msg.text) {
                this.handleChat(msg.text).catch((e) => console.error("[AI Code Guide] chat failed:", e));
            } else if (msg.type === "chatStop") {
                // AI_NOTE: 中止ボタン。生成中リクエストを abort する。await が reject し runChat の catch が中止表示＋キュー破棄を行う。
                this.chatAbort?.abort();
            } else if (msg.type === "chatNew") {
                this.currentChatId = null;
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "chatSelect") {
                // AI_NOTE: ⑤ 過去チャットに戻る(空文字なら新規状態)
                this.currentChatId = msg.text || null;
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "chatClearQuote") {
                // AI_NOTE: ⑤ 引用チップの×。text にインデックスが来ればその1件だけ外す。無ければ全消し(後方互換)。
                // チップDOM自体はwebview側が自前で除去済み(入力中の内容と競合するためhtml再生成はしない)。ここは状態(contexts)だけ同期する。
                const s = this.currentChatId ? this.chatStore.get(this.currentChatId) : undefined;
                if (s) {
                    const idx = Number(msg.text);
                    if (Number.isInteger(idx) && idx >= 0 && idx < s.contexts.length) s.contexts.splice(idx, 1);
                    else s.contexts = [];
                    this.chatStore.save();
                }
            } else if (msg.type === "pickChatModel") {
                // AI_NOTE: ② チャットのモデルバッジをクリック → QuickPick で chatModel を選ばせて即反映
                this.pickChatModel().catch((e) => console.error("[AI Code Guide] pickChatModel failed:", e));
            } else if (msg.type === "pickChatEffort") {
                // AI_NOTE: ② チャットの思考バッジをクリック → QuickPick で chatEffort を選ばせて即反映
                this.pickChatEffort().catch((e) => console.error("[AI Code Guide] pickChatEffort failed:", e));
            } else if (msg.type === "quoteSelectionPasted") {
                // AI_NOTE: チャット欄に「直前のエディタ選択」と一致する内容が貼られた → 生貼りせず引用チップに変換する
                if (this.lastQuoteCandidate) {
                    const q = this.lastQuoteCandidate;
                    void this.quoteSelectionToChat(q.code, q.lineStart ?? 0, q.lineEnd ?? 0, false);
                }
            } else if (msg.type === "requestQuoteCandidate") {
                // AI_NOTE: webview 再生成後に候補を復元する（貼り付け一致判定用のコード+ラベル用情報を送り直す）
                if (this.lastQuoteCandidate && this.view) {
                    const q = this.lastQuoteCandidate;
                    this.view.webview.postMessage({ type: "quoteCandidate", code: q.code, fileName: q.fileName, lineStart: q.lineStart, lineEnd: q.lineEnd });
                }
            } else if (msg.type === "webviewError") {
                // AI_NOTE: webviewスクリプトの実行時エラーの受け口。既定では闇に消えて「ボタン無反応」の症状だけが残るため、
                // 拡張ホストのconsoleへ常設で転送する（パースエラーは拾えない→tests/webviewEscapes.test.jsが担当）。
                console.error("[AI Code Guide] webview error:", msg.text);
            } else if (msg.type === "refreshUsage") {
                // AI_NOTE: 使用量タブの「更新」。最新の永続記録でHTMLを作り直す（タブのアクティブ状態はJS側で復元される）
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "generateGroups") {
                this.generateGroups().catch((e) => console.error("[AI Code Guide] group gen failed:", e));
            } else if (msg.type === "expand" && msg.nodeId) {
                this.toggleExpand(msg.nodeId, msg.lineStart ?? 0, msg.lineEnd ?? 0, msg.label ?? "").catch((e) => console.error("[AI Code Guide] expand failed:", e));
            } else if (msg.type === "retryExpand" && msg.nodeId) {
                // AI_NOTE: #1 失敗した分解を再試行(空状態を消してから再生成)
                const n = this.graphNodes.find((x) => x.id === msg.nodeId);
                if (n) { delete this.expandedData[n.id]; this.toggleExpand(n.id, n.lineStart, n.lineEnd, n.label).catch((e) => console.error("[AI Code Guide] retry failed:", e)); }
            } else if (msg.type === "expandRange" && Array.isArray(msg.ids)) {
                // AI_NOTE: ② サイドバーで範囲選択したカードだけを一括分解する。対象の絞り込み・確認はメソッド側。
                this.expandRange(msg.ids as string[]).catch((e) => console.error("[AI Code Guide] expand range failed:", e));
            } else if (msg.type === "expandAllCards") {
                // AI_NOTE: 標準タブの「▼全て」。展開可能カードを順にLLM分解する(トークン消費)。確認はメソッド側で取る。
                this.expandAllCards().catch((e) => console.error("[AI Code Guide] expand all failed:", e));
            } else if (msg.type === "collapseAllCards") {
                // AI_NOTE: 標準タブの「▶全て」。展開状態を全消去するだけ(LLM不要)。再描画で未展開カードに戻す。
                // サブブロック塗りも消すため rerender でエディタ背景も塗り直す。
                this.expandedData = {};
                this.rerender();
            } else if (msg.type === "analyzeProject") {
                this.analyzeProject().catch((e) => console.error("[AI Code Guide] project analyze failed:", e));
            } else if (msg.type === "ensureProject") {
                this.ensureProject();
            } else if (msg.type === "generateProjectDescs") {
                this.generateProjectDescs().catch((e) => console.error("[AI Code Guide] project desc failed:", e));
            } else if (msg.type === "toggleProjectArrows") {
                this.projectArrows = !this.projectArrows;
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "findProjectDiagram" && typeof msg.text === "string") {
                this.generateProjectDiagram(msg.text).catch((e) => console.error("[AI Code Guide] project diagram failed:", e));
            } else if (msg.type === "openProjectDiagramHtml") {
                this.openProjectDiagramHtml().catch((e) => {
                    console.error("[AI Code Guide] project diagram HTML export failed:", e);
                    vscode.window.showErrorMessage(`AI Code Guide: HTMLを開けませんでした（${String(e)}）`);
                });
            } else if (msg.type === "clearProjectDiagram") {
                this.projectDiagram = null;
                this.selectedProjectDiagramHistoryId = null;
                this.projectDiagramError = "";
                if (this.view) this.view.webview.html = this.buildHtml();
            } else if (msg.type === "selectProjectDiagramHistory" && typeof msg.text === "string") {
                this.selectProjectDiagramHistory(msg.text);
            } else if (msg.type === "deleteProjectDiagramHistory" && typeof msg.text === "string") {
                this.deleteProjectDiagramHistory(msg.text);
            } else if (msg.type === "openProjectSymbol" && typeof msg.text === "string") {
                this.openProjectSymbol(msg.text, Number(msg.line) || 0);
            } else if (msg.type === "webviewReady") {
                // AI_NOTE: html代入直後のpostMessageは新しいWebviewスクリプトの受信準備前に消えることがある。
                // readyを受けてから「標準を開く→カード強調」の順で送り、図からの遷移を一度の操作で完結させる。
                const pending = this.pendingStandardFocus;
                if (pending && this.currentDoc?.uri.toString() === pending.uri) {
                    const node = this.nodeAtLine(pending.line);
                    this.pendingStandardFocus = null;
                    this.view?.webview.postMessage({ type: "activateTab", tab: "standard" });
                    this.view?.webview.postMessage({ type: "focusStandardCard", nodeId: node?.id ?? "", instant: pending.instant === true });
                }
            } else if (msg.type === "copyChatMessage" && typeof msg.text === "string") {
                // AI_NOTE: WebviewのClipboard API権限に依存させず、VS Code拡張API経由で確実にコピーする。
                await vscode.env.clipboard.writeText(msg.text);
            } else if (msg.type === "openFile" && msg.text) {
                vscode.window.showTextDocument(vscode.Uri.file(msg.text), { preview: false });
            } else if (msg.type === "chatRename" && msg.text) {
                // AI_NOTE: 履歴の✎。VS Code標準のinputBoxでタイトル変更を受ける(undefined=キャンセル)
                const id = msg.text;
                const cur = typeof msg.label === "string" ? msg.label : "";
                vscode.window.showInputBox({ prompt: "チャットのタイトルを変更", value: cur }).then((next) => {
                    if (next === undefined) return;
                    this.chatStore.rename(id, next);
                    if (this.view) this.view.webview.html = this.buildHtml();
                });
            } else if (msg.type === "chatDelete" && msg.text) {
                // AI_NOTE: 履歴の🗑。誤削除防止のため警告付きで確認する
                const id = msg.text;
                const cur = typeof msg.label === "string" ? msg.label : "";
                vscode.window.showWarningMessage(`「${cur}」を削除しますか？`, { modal: true }, "削除").then((pick) => {
                    if (pick !== "削除") return;
                    this.chatStore.remove(id);
                    // AI_NOTE: 会話を消したら、その会話へのchatLink(注釈のジャンプ先)も掃除する。放置すると宙ぶらりんの
                    // リンク注釈が残りクリックしても無反応になるため。掃除後、表示中エディタの注釈も即再描画する。
                    this.chatLinkStore.removeSession(id);
                    if (this.currentDoc) this.annotationProvider.refreshEditorByUri(this.currentDoc.uri.toString());
                    if (this.currentChatId === id) this.currentChatId = null;
                    if (this.view) this.view.webview.html = this.buildHtml();
                });
            } else if (msg.type === "annotateRun" || msg.type === "annotateRegen") {
                // AI_NOTE: 生成(全体)/再生成。ボタンの状態表示(スピナー/件数)のため executeCommand ではなく直接呼び、結果を受けて webview に通知する。
                // regen=キャッシュ無視で full を作り直す(range 注釈は provider 側で吸収して残る)。
                const force = msg.type === "annotateRegen";
                const editor = this.getCurrentEditor() ?? vscode.window.activeTextEditor;
                if (!editor || !isSupportedLanguage(editor.document.languageId)) {
                    vscode.window.showWarningMessage("AI Code Guide: Python・JavaScript・TypeScriptファイルを開いてください。");
                } else {
                    this.runAnnotate(force ? "regen" : "run", () => this.annotationProvider.annotateFile(editor, force));
                }
            } else if (msg.type === "annotateClear") {
                vscode.commands.executeCommand("aiCodeGuide.clearBlockExplanations");
            } else if (msg.type === "traceRun") {
                // AI_NOTE: 実行トレース。エディタ解決やLLM/実行/キャッシュの流れはコマンド側(extension.ts)に集約されている。
                vscode.commands.executeCommand("aiCodeGuide.traceFunction");
            } else if (msg.type === "traceRunMulti") {
                // AI_NOTE: チェックした関数をまとめてトレース。空チェックはコマンド側の「全関数」扱いにならないよう弾く。
                const funcs = Array.isArray(msg.funcs) ? (msg.funcs as string[]) : [];
                if (funcs.length === 0) {
                    vscode.window.showWarningMessage("AI Code Guide: トレースする関数にチェックを入れてください。");
                } else {
                    vscode.commands.executeCommand("aiCodeGuide.traceFunctions", { funcs });
                }
            } else if (msg.type === "traceRegen") {
                // AI_NOTE: 表示中の関数すべてを入力例から作り直す(一括トレース中に1関数だけ差し替わるのを避ける)。
                const shown = this.currentDoc ? this.traceProvider?.getStatus(this.currentDoc.uri.toString()) ?? null : null;
                if (shown && shown.funcNames.length > 0) {
                    vscode.commands.executeCommand("aiCodeGuide.traceFunctions", { funcs: shown.funcNames, force: true });
                } else {
                    vscode.commands.executeCommand("aiCodeGuide.traceFunction", { force: true });
                }
            } else if (msg.type === "traceIterStep") {
                vscode.commands.executeCommand("aiCodeGuide.traceIterStep", {
                    uri: this.currentDoc?.uri.toString(),
                    funcName: msg.funcName,
                    loopId: msg.loopId,
                    delta: msg.delta,
                });
            } else if (msg.type === "traceClear") {
                vscode.commands.executeCommand("aiCodeGuide.traceClear");
            } else if (msg.type === "annotateSelection") {
                // AI_NOTE: 選択範囲ボタン。3つの状態を取る:
                //   ・選択待ち中に押された → キャンセル
                //   ・既に範囲選択がある → そのまま解析
                //   ・未選択 → 選択待ちモードへ。エディタにフォーカスを移してドラッグ選択を誘導する
                this.handleAnnotateSelectionClick().catch((e) => console.error("[AI Code Guide] annotateSelection failed:", e));
            } else if (msg.type === "toggleAutoAnnotate") {
                const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
                const cur = cfg.get<boolean>("autoInlineAnnotations", true);
                cfg.update("autoInlineAnnotations", !cur, vscode.ConfigurationTarget.Global);
            } else if (msg.type === "toggleShowAnnotations") {
                // AI_NOTE: 名称Hoverの表示だけを切り替える。再生成はしない。
                const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
                const cur = cfg.get<boolean>("showAnnotations", true);
                await cfg.update("showAnnotations", !cur, vscode.ConfigurationTarget.Global);
                const editor = this.getCurrentEditor();
                if (editor) this.annotationProvider.refreshVisibility(editor);
                this.refresh(this.activeCodeDoc());
            }
        });
        // AI_NOTE: ビューが(再)表示されたら現在のPythonに追従して描き直す。
        // アクティブエディタが既に開いている場合 onDidChangeActiveTextEditor は発火しないため、
        // 可視化のたびに自前で拾い直す(アクティベーション競合対策)。
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) this.refresh(this.activeCodeDoc());
        });
        // 初回表示: activeTextEditor が未確定でも visibleTextEditors から Python を拾う
        this.refresh(this.activeCodeDoc());
    }

    // AI_NOTE: currentDoc に対応する可視 TextEditor を返す。比較は uri 文字列で行う:
    // VS Code は activate のタイミングで同一URIに対し別TextDocumentインスタンスを生成しうるため、
    // 参照比較(===)だと debug 起動直後など、Editor の document と currentDoc が別物になり find が失敗する。
    private getCurrentEditor(): vscode.TextEditor | undefined {
        if (!this.currentDoc) return undefined;
        const uri = this.currentDoc.uri.toString();
        return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
    }

    // AI_NOTE: 設計ファイル(.ai-code-guide/design/**/*.md)の変更監視(extension.ts側FileSystemWatcher)からの
    // 再読込フック。currentDesign()/loadRepoDesign()等は毎回fsから読み直す実装で専用キャッシュを持たないため、
    // ここはHTML再描画だけでよい(新しい更新機構は発明しない=既存refresh()と同じ再描画1行)。
    public refreshDesignFiles(): void {
        if (this.view) this.view.webview.html = this.buildHtml();
    }

    // AI_NOTE: 解析対象の対応言語文書を決める。activeが対象外なら可視エディタから探す。
    private activeCodeDoc(): vscode.TextDocument | undefined {
        const active = vscode.window.activeTextEditor?.document;
        if (isSupportedLanguage(active?.languageId)) return active;
        return vscode.window.visibleTextEditors.find((e) => isSupportedLanguage(e.document.languageId))?.document;
    }

    // AI_NOTE: アクティブなPythonファイルを解析してカード一覧を描き直す。
    // サイドバーが閉じていてもエディタ背景の座標とキャッシュを更新する。
    private async refresh(doc?: vscode.TextDocument): Promise<void> {
        if (doc && doc.languageId === "python") {
            // AI_NOTE: 別ファイルに切り替わったら表示中チャットと単一関数ドリルインをリセット(セッション自体はChatStoreに残る)
            if (this.currentDoc !== doc) {
                this.currentChatId = null;
                this.targetFunc = "";
                this.funcGraph = null;
                this.resetNaturalLabels();
                this.meaningRanges = {};
                this.expandedData = {};
                this.expandedSources.clear();
                this.staleExpansions.clear();
            }
            this.currentDoc = doc;
            const source = doc.getText();
            // AI_NOTE: トレースタブの関数チェックリスト用の一覧も同時に取り直す(グラフ解析と並列で待ち時間を増やさない)。
            const { graph: result, funcs } = await this.parseSource(source);
            if (this.currentDoc?.uri.toString() !== doc.uri.toString() || doc.getText() !== source) return;
            this.refreshedSource = source;
            this.traceFuncs = funcs;
            this.graphNodes = result.error ? [] : result.nodes;
            this.graphEdges = result.error ? [] : result.edges;
            this.graphRelationships = result.error ? [] : (result.relationships ?? []);
            this.backgroundNodes = result.error ? [] : (result.backgroundNodes ?? result.nodes);
            this.meaningRanges = this.colorBackgrounds(this.backgroundService.peek(doc.uri.toString(), source, this.backgroundNodes), this.backgroundNodes);
            for (const id of Object.keys(this.expandedData)) {
                const cached = this.backgroundService.peekDetails(doc.uri.toString(), source, this.backgroundNodes, id);
                if (cached) { this.expandedData[id] = cached; this.staleExpansions.delete(id); }
                else this.staleExpansions.add(id);
            }
            // AI_NOTE: 標準ビューはトップレベルの構造(クラス/関数)だけ色を回す。import/実行/その他ブロックは
            // 色を持たせずグレー化(buildCardHtmlのfallback)。連結グループでメソッドはクラス色に塗るので個別色は不要。
            this.nodeColors = assignNodeColors(this.graphNodes, new Set(["function", "class"]), true);
            // AI_NOTE: 永続キャッシュにAI説明/概要グループがあれば即表示(ボタン無し・再起動後も)。
            // 説明はノード単位キーで個別に引き直す→他所が編集されても中身が同じノードはヒットする。
            const lines = source.split("\n");
            this.descMap = {};
            for (const n of this.graphNodes) {
                const cached = this.llmCache.get<string>(this.nodeDescKey(n, lines));
                if (cached !== undefined) this.descMap[n.id] = cached;
            }
            this.fileOverview = this.llmCache.get<FileOverview>(this.fileOverviewKey()) ?? null;
            this.coarseGroups = this.llmCache.get<ModuleGroup[]>(this.coarseKey(source)) ?? null;
            if (this.view) this.view.webview.html = this.buildHtml(result.error);
            this.applyDecorations();
            return;
        }
        // 非Python or エディタ無し: ノードは保持したまま(直近ファイル)再描画
        if (this.view) this.view.webview.html = this.buildHtml();
    }

    // AI_NOTE: カードクリックで対応コードへジャンプ。currentDoc を表示しているエディタを探して選択・スクロール
    private jumpToLine(lineStart: number, lineEnd: number): void {
        const editor = this.getCurrentEditor();
        if (!editor) return;
        const start = new vscode.Position(lineStart, 0);
        const end = editor.document.lineAt(Math.min(lineEnd, editor.document.lineCount - 1)).range.end;
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
    }

    // AI_NOTE: 関数カードから単一関数フローチャート(mermaid)へドリルインする。
    // funcAtLine で行番号→関数名を確定し(座標はモデルを信用しない方針)、その関数のグラフを取って描画。
    // 関数名が取れない場合はコードへジャンプして位置だけ示す(classカード等)。
    private async drillIntoLine(line: number): Promise<void> {
        if (!this.currentDoc || !this.view) return;
        const source = this.currentDoc.getText();
        const languageId = this.currentDoc.languageId as SupportedLanguageId;
        const funcName = await funcAtLine(this.extensionPath, source, line, languageId);
        if (!funcName) {
            this.jumpToLine(line, line);
            return;
        }
        const result = await extractGraph(this.extensionPath, source, funcName, languageId);
        if (result.error || result.nodes.length === 0) {
            this.jumpToLine(line, line);
            return;
        }
        this.targetFunc = funcName;
        this.funcGraph = { nodes: result.nodes, edges: result.edges };
        this.resetNaturalLabels();
        this.view.webview.html = this.buildHtml();
    }

    private resetNaturalLabels(): void {
        this.naturalMode = false;
        this.naturalLabels = null;
    }

    // AI_NOTE: 文言切り替えのキャッシュキー。関数ソース全体の内容ハッシュ。ノードidはソースが同じなら
    // パーサが同じ並びで振るため、id→文言のマップをそのまま保存してよい。ソースが1文字でも変われば
    // idと文言の対応が保証できないので全体で作り直す(部分再利用はしない)。
    private naturalLabelKey(funcSource: string): string {
        const ctx = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("globalContext", "");
        return `flownl::${fnv1a(ctx + "\0" + this.targetFunc + "\0" + funcSource)}`;
    }

    // AI_NOTE: ドリルイン中の関数ソース(ノードの行範囲の和)。LLMへの文脈とキャッシュキーの素を兼ねる。
    private funcSourceSlice(): string {
        if (!this.currentDoc || !this.funcGraph) return "";
        const lines = this.currentDoc.getText().split("\n");
        const start = Math.min(...this.funcGraph.nodes.map((n) => n.lineStart));
        const end = Math.max(...this.funcGraph.nodes.map((n) => n.lineEnd));
        return lines.slice(start, end + 1).join("\n");
    }

    // AI_NOTE: 「文言: コード⇄日本語」トグル本体。日本語側は初回のみLLM生成し内容ハッシュで永続キャッシュ。
    // entryノードは関数名がコードとの対応アンカーなので言い換え対象から外す。生成失敗(空)ならコード表示のまま通知。
    private async toggleNaturalLabels(): Promise<void> {
        if (!this.funcGraph || !this.view || this.naturalGenerating) return;
        if (this.naturalMode) {
            this.naturalMode = false;
            this.view.webview.html = this.buildHtml();
            return;
        }
        if (!this.naturalLabels) {
            const src = this.funcSourceSlice();
            const key = this.naturalLabelKey(src);
            const cached = this.llmCache.get<Record<string, string>>(key);
            if (cached) {
                this.naturalLabels = cached;
            } else {
                this.naturalGenerating = true;
                this.view.webview.html = this.buildHtml();
                try {
                    const targets = this.funcGraph.nodes
                        .filter((n) => n.kind !== "entry")
                        .map((n) => ({ id: n.id, kind: n.kind, label: n.label }));
                    const map = await generateNodeLabels(this.targetFunc, src, targets);
                    if (map.size > 0) {
                        this.naturalLabels = Object.fromEntries(map);
                        this.llmCache.set(key, this.naturalLabels);
                    } else {
                        vscode.window.showWarningMessage("AI Code Guide: 文言の言い換えを生成できませんでした（APIキー/CLI設定を確認してください）");
                    }
                } finally {
                    this.naturalGenerating = false;
                }
            }
        }
        if (this.naturalLabels) this.naturalMode = true;
        this.view.webview.html = this.buildHtml();
    }

    // AI_NOTE: graphNodes をエディタ背景色として塗る。kind別の淡い色。coloringEnabled=false なら全消し。
    // ノードごとに型を作り直して行範囲に適用する(旧FlowchartPanelと同方式)。
    private applyDecorations(): void {
        // AI_NOTE: LLMで確定した背景だけを共通パレットで塗る。未生成時に定義色へ代替しない。
        if (!this.decorationTypes.length) {
            this.decorationTypes = SEMANTIC_BACKGROUND_PALETTE.map((color) => vscode.window.createTextEditorDecorationType({
                backgroundColor: hexToRgba(color, 0.15), isWholeLine: true,
            }));
        }
        const ranges = this.coloringEnabled ? Object.values(this.meaningRanges).flat().map((range) => ({
            ...range, lineStart: range.lineStart + 1, lineEnd: range.lineEnd + 1,
        })) : [];
        const key = JSON.stringify(ranges);
        if (this.decorationIndexKey !== key) {
            this.decorationIndexKey = key;
            this.decorationIndex = buildSemanticLineIndex(ranges);
        }
        const index = this.decorationIndex;
        const grouped = SEMANTIC_BACKGROUND_PALETTE.map(() => [] as vscode.Range[]);
        for (const [line, unit] of index) {
            const palette = SEMANTIC_BACKGROUND_PALETTE.findIndex(color => color === unit.color);
            if (palette >= 0) grouped[palette].push(new vscode.Range(line - 1, 0, line - 1, 0));
        }
        for (const editor of vscode.window.visibleTextEditors) {
            const current = editor.document.uri.toString() === this.currentDoc?.uri.toString();
            this.decorationTypes.forEach((type, slot) => editor.setDecorations(type, current ? grouped[slot] : []));
        }
    }

    private disposeDecorations(): void {
        for (const t of this.decorationTypes) t.dispose();
        this.decorationTypes = [];
    }

    // AI_NOTE: ノードに渡すコードスライス。function/classはシグネチャ+docstring先頭8行、blockは全行。
    // このスライスがそのままLLM入力かつキャッシュキーの素なので、生成(generateDescriptions)と厳密に一致させる。
    private nodeSlice(n: GraphNode, lines: string[]): string {
        return n.kind === "function" || n.kind === "class"
            ? lines.slice(n.lineStart, n.lineStart + 8).join("\n")
            : lines.slice(n.lineStart, n.lineEnd + 1).join("\n");
    }

    // AI_NOTE: カード説明のノード単位キャッシュキー。旧descKeyは全文ハッシュ1個に全カードを束ねており、
    // ファイルのどこか1文字でも変わると全カード再生成になっていた。説明はそのノード自身のコードだけで
    // 決まるので、コードスライス(+kind+globalContext)でcontent-addressする。他所が変わっても中身が同じ
    // ノードはヒットし、本体が変わったカードだけ再生成される。位置依存の通し番号idにも依存しない。
    private nodeDescKey(n: GraphNode, lines: string[]): string {
        const ctx = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("globalContext", "");
        return `descnode::${fnv1a(ctx + "\0" + n.kind + "\0" + this.nodeSlice(n, lines))}`;
    }

    // AI_NOTE: ファイル全体ヘッダーのキャッシュキー。旧実装は全文ハッシュ依存で関数本体を触っただけでも
    // 再生成していた。ヘッダーはトップレベルの(label,kind)一覧だけで決まるので、その構造署名をキーにして
    // 「構造が変わった時だけ」再生成に絞る。
    private fileOverviewKeyForNodes(nodes: GraphNode[]): string {
        const ctx = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("globalContext", "");
        const sig = nodes.map((n) => `${n.kind}:${n.label}`).join("\n");
        return `fileov::${fnv1a(ctx + "\0" + sig)}`;
    }

    private fileOverviewKey(): string {
        return this.fileOverviewKeyForNodes(this.graphNodes);
    }

    // AI_NOTE: ファイル概要だけが必要な外部AI要求で、全カード説明まで生成しないための最小生成口。
    // 保存済みなら即returnし、表示ツールと生成ツールのコスト境界を崩さない。
    private async ensureFileOverview(): Promise<void> {
        if (this.fileOverview || !this.currentDoc) return;
        const filename = path.basename(this.currentDoc.uri.fsPath || this.currentDoc.uri.path) || "code-file";
        const overview = await generateFileOverview(
            filename,
            this.graphNodes.map((node) => ({ label: node.label, kind: node.kind })),
        );
        if (!overview) return;
        this.fileOverview = overview;
        this.llmCache.set(this.fileOverviewKey(), overview);
    }

    // AI_NOTE: 「AI説明」押下時。未キャッシュの function/block ノードだけLLMに渡し、結果を永続キャッシュへ保存して再描画する。
    private async generateDescriptions(): Promise<void> {
        if (this.generating || !this.currentDoc || !this.view) return;
        const source = this.currentDoc.getText();
        const lines = source.split("\n");
        // AI_NOTE: クラスにも概要説明を付ける(見出しが名前だけで素っ気ないため)。function/class/block が対象
        const uncached = this.graphNodes.filter(
            (n) => (n.kind === "function" || n.kind === "class" || n.kind === "block") && !this.descMap[n.id]
        );
        // AI_NOTE: ノード説明が全キャッシュ済みでも、ファイル全体ヘッダーが未生成なら生成は走らせる。
        if (uncached.length === 0 && this.fileOverview) return;

        this.generating = true;
        this.view.webview.html = this.buildHtml();
        try {
            // AI_NOTE: ファイル全体ヘッダー(型+役割)を1回だけ生成。トップレベル要素のラベルと種類だけ渡す軽量呼び出し。
            await this.ensureFileOverview();
            // AI_NOTE: functionはシグネチャ+docstring(先頭8行)のみ渡す。blockは全行。旧パネルと同じ渡し方。
            if (uncached.length > 0) {
                // AI_NOTE: function/class はシグネチャ+docstring(先頭8行)を渡す。クラスは見出し行のみspanなので
                // lineStartから8行取り、class定義+docstring(+先頭メソッド)を概要判断の材料にする。blockは全行
                const blocks = uncached.map((n) => ({
                    id: n.id,
                    kind: n.kind,
                    code: this.nodeSlice(n, lines),
                }));
                const results = await generateBlockDescriptions(blocks, "");
                // AI_NOTE: 生成結果はノード単位キーで個別に永続化する(全カード束ねの旧descKeyは廃止)。
                const byId = new Map(uncached.map((n) => [n.id, n]));
                for (const [id, desc] of results) {
                    this.descMap[id] = desc;
                    const n = byId.get(id);
                    if (n) this.llmCache.set(this.nodeDescKey(n, lines), desc);
                }
            }
        } finally {
            this.generating = false;
            if (this.view) this.view.webview.html = this.buildHtml();
        }
    }

    // AI_NOTE: タブ枠 + 各タブ本体。標準タブにカード一覧、他は後続フェーズのプレースホルダ。
    // タブ切替はクライアント側のCSS/JSで完結し、setStateで選択を保持する(html再設定でも復元)。
    private buildHtml(error?: string): string {
        // AI_NOTE: タブ8個は幅に収まらず2段化して縦を圧迫するため、低頻度の使用量/設定/ヘルプは「…」メニューへ退避(常時1段)。
        // 完全に隠すと入口が発見されない(memory)ので、見える「⋯」ボタン経由で必ず到達できる形にする。
        // AI_NOTE: 1段タブに5個収めるため長い2つ(プロジェクト/インライン解説)だけ2字へ短縮。fullはホバーで元の意味を出すtitle用。
        // AI_NOTE: タブは全て .tab として #tabbar に置き、幅に収まらない分だけ JS(reflowTabs)が ⋯ メニューへ動的に退避する。
        // 以前は後半3つ(使用量/設定/ヘルプ)を固定で⋯へ入れており「幅に余裕があっても⋯」だったのを、幅測定ベースへ変更。
        // 並び順=優先順(先頭ほど残す)。⋯ボタン・メニューは初期は空/非表示で、reflowTabs があふれた分を入れる。
        const allTabs = [
            { id: "standard", label: "標準" },
            { id: "overview", label: "概要" },
            { id: "project", label: "構成", full: "プロジェクト" },
            { id: "process", label: "図", full: "質問に合わせたコード図" },
            { id: "inline", label: "辞書", full: "名称辞書" },
            { id: "trace", label: "トレース", full: "実行トレース" },
            { id: "chat", label: "チャット" },
            { id: "usage", label: "使用量" },
            { id: "settings", label: "設定" },
            { id: "help", label: "ヘルプ" },
        ];
        const tabButtons = allTabs
            .map((t, i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${t.id}"${(t as { full?: string }).full ? ` title="${(t as { full?: string }).full}"` : ""}>${t.label}</button>`)
            .join("")
            + `<div id="tab-more-wrap" style="display:none"><button class="tab" id="tab-more" title="表示しきれないタブ">⋯</button>`
            + `<div id="tab-more-menu"></div></div>`;

        const toolbar = `<div id="toolbar">
          <button class="tbtn${this.generating ? " busy" : ""}" onclick="vscode.postMessage({type:'generateDesc'})" ${this.generating ? "disabled" : ""}>${this.generating ? "生成中…" : "AI説明"}</button>
          <button class="tbtn${this.arrowsEnabled ? " on" : ""}" onclick="vscode.postMessage({type:'toggleArrows'})" title="呼び出し関係の矢印を表示/非表示">矢印: ${this.arrowsEnabled ? "ON" : "OFF"}</button>
          <button class="tbtn${this.coloringEnabled ? " on" : ""}" onclick="vscode.postMessage({type:'toggleColoring'})">色: ${this.coloringEnabled ? "ON" : "OFF"}</button>
          <button class="tbtn" onclick="vscode.postMessage({type:'expandAllCards'})" title="展開できるカードをすべてAIで分解（トークン消費）">▼全て</button>
          <button class="tbtn" onclick="vscode.postMessage({type:'collapseAllCards'})">▶全て</button>
          <button class="tbtn" id="range-mode-btn" onclick="toggleRangeMode()" title="複数カードの範囲をクリックで選んでまとめて展開する">▤ 範囲展開</button>
        </div>`;
        // AI_NOTE: targetFunc が入っていれば単一関数フローチャート(mermaid)。空ならモジュールマップ(カード)。
        const drilled = this.targetFunc !== "" && this.funcGraph;
        let standardBody: string;
        if (error) {
            standardBody = `<div class="msg">解析に失敗しました:\n${escapeHtml(error)}</div>`;
        } else if (!this.currentDoc) {
            standardBody = `<div class="msg">Python・JavaScript・TypeScriptファイルを開くと構造を表示します</div>`;
        } else if (drilled) {
            standardBody = this.buildFuncFlowchart();
        } else {
            standardBody = toolbar + this.buildCards();
        }

        // AI_NOTE: 質問別コード図はサイドバー専用HTMLで描画する。Mermaidは単一関数フローの時だけ読む。
        const mermaid = drilled && this.view ? mermaidHead(this.view.webview, this.extensionPath) : "";
        const processDiagramTargets = Object.fromEntries((this.projectDiagram?.diagram.nodes ?? []).flatMap((node, index) => {
            const file = this.projectData?.nodes.find((candidate) => candidate.rel_path === node.file);
            return file ? [[`pd${index}`, { path: file.path, line: node.line }]] : [];
        }));

        // AI_NOTE: [レビュー] "メイン webview に CSP が無い(mermaid 側だけにあった)" → ここで唯一の CSP を出す。
        // default-src 'none' で既定遮断し、ローカル資源(cspSource)と、インライン script/style(onclick・<style>・style属性で多用)を許可。
        // mermaid は実行時 eval を使うので 'unsafe-eval' を含める(読み込むのはローカル同梱の mermaid のみ)。エスケープ漏れ時の最後の砦。
        const cspSource = this.view?.webview.cspSource ?? "";
        const csp = `default-src 'none'; script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:; font-src ${cspSource} data:;`;
        return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${mermaid}
<style>
  /* AI_NOTE: 矢印用ガターの絶対幅を1箇所に集約。矢印は横幅に意味がない要素なので割合(42%)ではなく固定pxにし、CSS(ガター予約)とJS(bulge上限)で同じ値を共有する。 */
  :root { --arrow-gutter: 60px; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    display: flex; flex-direction: column; height: 100vh;
  }
  /* AI_NOTE: nowrap+overflow:hidden で1段固定。あふれたタブは折り返さず reflowTabs が⋯へ退避する(display:none)。 */
  #tabbar {
    display: flex; flex-wrap: nowrap; overflow: hidden; gap: 2px; flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    padding: 4px 4px 0 4px;
  }
  .tab {
    background: transparent; color: var(--vscode-foreground);
    border: none; border-bottom: 2px solid transparent;
    padding: 6px 8px; cursor: pointer; font-family: inherit; font-size: 12px; opacity: 0.7;
    flex-shrink: 0; white-space: nowrap;
  }
  .tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #0e639c); font-weight: 600; }
  /* AI_NOTE: 「…」あふれメニュー。#tabbarがoverflow:hiddenのため絶対配置だとメニューが切り取られて見えない。
     fixed(ビューポート基準)にしてクリップを回避し、位置は開く時にJSが⋯ボタンのrectから決める。 */
  #tab-more-wrap { position: relative; }
  #tab-more-menu { display: none; position: fixed; z-index: 50; flex-direction: column; min-width: 96px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
    border: 1px solid var(--vscode-menu-border, rgba(128,128,128,0.35)); border-radius: 4px; padding: 3px;
    box-shadow: 0 4px 10px rgba(0,0,0,0.35); }
  #tab-more-menu.open { display: flex; }
  .tab-menu-item { background: transparent; border: none; color: var(--vscode-menu-foreground, var(--vscode-foreground));
    text-align: left; padding: 5px 10px; cursor: pointer; font-family: inherit; font-size: 12px; border-radius: 3px; }
  .tab-menu-item:hover { background: var(--vscode-menu-selectionBackground, rgba(255,255,255,0.08)); }
  .tab-menu-item.active { color: var(--vscode-focusBorder, #0e639c); font-weight: 600; }
  #panes { flex: 1; overflow: auto; }
  .pane { display: none; padding: 8px; }
  /* AI_NOTE: 標準/概要/構成/処理マップのカード面は横幅が命なので左右余白を持たない（カードが端まで届く。他タブは読みやすさ優先で8pxのまま） */
  .pane[data-pane="standard"], .pane[data-pane="overview"], .pane[data-pane="project"], .pane[data-pane="process"] { padding-left: 0; padding-right: 0; }
  .pane.active { display: block; }
  .msg { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 16px; text-align: center; white-space: pre-wrap; }
  /* AI_NOTE: ファイル全体ヘッダー。2行構成=型の説明文(1行目)+役割(2行目)。型をバッジでなく独立行にして「何の分類か」を伝え、役割に横幅を渡す。左罫色で型を色分け(flow青/def緑)。標準/概要タブ共用 */
  .file-header { padding: 8px 10px; margin-bottom: 10px; border-radius: 5px; background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1)); border-left: 3px solid #4fc1ff; }
  .file-header.fh-def    { border-left-color: #4ec9b0; }
  .file-header.fh-flow   { border-left-color: #4fc1ff; }
  .file-header.fh-entry  { border-left-color: #f0a500; }
  .file-header.fh-model  { border-left-color: #c586c0; }
  .file-header.fh-config { border-left-color: #d7ba7d; }
  .file-header.fh-test   { border-left-color: #ce9178; }
  .fh-type { font-size: 11px; font-weight: 600; margin-bottom: 3px; }
  .file-header.fh-def    .fh-type { color: #4ec9b0; }
  .file-header.fh-flow   .fh-type { color: #4fc1ff; }
  .file-header.fh-entry  .fh-type { color: #f0a500; }
  .file-header.fh-model  .fh-type { color: #c586c0; }
  .file-header.fh-config .fh-type { color: #d7ba7d; }
  .file-header.fh-test   .fh-type { color: #ce9178; }
  .fh-role { font-size: 12px; color: var(--vscode-foreground); line-height: 1.4; }
  /* AI_NOTE: 設計フェーズ1・ステップ3前半。ファイル粒度の設計ブロック(概要タブ・関数一覧カードの上)。file-headerとは別の枠にして「設計由来」と分かるようにする */
  .design-block { padding: 7px 9px; margin-bottom: 8px; border-radius: 4px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08)); }
  .design-purpose-row, .design-symbol-row { display: flex; align-items: baseline; gap: 6px; font-size: 11px; line-height: 1.5; }
  .design-symbol-row { margin: 2px 0 3px; }
  .design-purpose-text { color: var(--vscode-foreground); }
  .design-issue { font-size: 10px; color: var(--vscode-editorWarning-foreground, #cca700); margin-top: 2px; }
  /* AI_NOTE: 出所タグ。confirmed=緑系/inferred=グレー/untagged=橙系。装飾絵文字は使わず色+短いラベルのみで区別する */
  .dtag { flex-shrink: 0; font-size: 9px; font-weight: 600; line-height: 1.6; padding: 0 6px; border-radius: 8px; white-space: nowrap; }
  .dtag-confirmed { color: var(--vscode-terminal-ansiGreen, #4ec9b0); background: color-mix(in srgb, var(--vscode-terminal-ansiGreen, #4ec9b0) 16%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-terminal-ansiGreen, #4ec9b0) 35%, transparent); }
  .dtag-inferred { color: var(--vscode-descriptionForeground); background: rgba(128,128,128,0.16); border: 1px solid rgba(128,128,128,0.35); }
  .dtag-untagged { color: var(--vscode-editorWarning-foreground, #cca700); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 16%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 35%, transparent); }
  /* AI_NOTE: プロジェクトタブのファイルカード「設計あり」印。出所(confirmed/inferred)ではなく有無だけを示すため紫系(design-heading)で統一 */
  .dtag-has-design { color: var(--vscode-charts-purple, #c586c0); background: color-mix(in srgb, var(--vscode-charts-purple, #c586c0) 16%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-charts-purple, #c586c0) 35%, transparent); }
  /* AI_NOTE: 設計フェーズ1・ステップ3中盤。標準タブ(関数/クラスカード)のフル設計サブブロック。
     AI生成説明(.subover/.desc/.grp-desc、accent色の左罫)と紛れないよう固定の紫系左罫にして「人が確認した設計」を視覚的に分離する。 */
  .design-block-full { border-left: 3px solid var(--vscode-charts-purple, #c586c0); margin-bottom: 6px; }
  .design-heading { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: var(--vscode-charts-purple, #c586c0); margin-bottom: 3px; }
  .design-section-label { font-size: 10px; font-weight: 600; color: var(--vscode-descriptionForeground); margin: 6px 0 2px; }
  .design-section-label:first-of-type { margin-top: 0; }
  .design-construction { margin: 0; padding-left: 18px; font-size: 11px; line-height: 1.5; color: var(--vscode-foreground); }
  .design-construction li { margin: 1px 0; }
  /* AI_NOTE: 空欄入口ボタン(設計ファイルが無いタブ枠に出す常設の案内)。警告ではないので破線枠+控えめ配色にする */
  .design-entry { padding: 8px 9px; margin-bottom: 8px; border-radius: 4px; border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4)); background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.05)); text-align: center; }
  .design-entry-hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 5px; line-height: 1.4; }
  /* AI_NOTE: プロジェクトタブのディレクトリ見出し用の小さい入口。ボタン乱立を避けるためリンク風にする */
  .design-dir-link { font-size: 10px; color: var(--vscode-charts-purple, #c586c0); cursor: pointer; text-decoration: underline; margin-left: 8px; }
  .design-dir-link:hover { opacity: 0.8; }
  .card {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 9px; margin-bottom: 4px; border-radius: 4px;
    border-left: 3px solid var(--accent, #4fc1ff);
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
    cursor: pointer;
  }
  .card:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08)); }
  /* AI_NOTE: ②③ 矢印ON時はカードを片側に寄せ、反対側に固定幅(--arrow-gutter)の矢印スペースを空ける。widthはautoにして残り全部をカードが使う(パネルを広げてもカードだけ伸び、矢印幅は不変)。OFFで全幅。 */
  #cards-area { position: relative; }
  /* AI_NOTE: ② 範囲選択のハイライトと上部バナー。選択カードは青枠。バナーは選択モード中だけ上部sticky。 */
  .card.range-sel { outline: 2px solid #4fc1ff; outline-offset: -2px; }
  #range-mode-btn.on { background: #4fc1ff; color: #1e1e1e; }
  /* AI_NOTE: top はツールバー(sticky)高さ分下げ、範囲展開モード時にツールバーと重ならないようにする。z-indexはツールバー(20)より下＝重なってもツールバーが上に来て隠れない。 */
  #range-banner { position: sticky; top: 32px; z-index: 10; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; justify-content: space-between; margin-bottom: 8px; padding: 7px 9px; font-size: 11px; background: color-mix(in srgb, #4fc1ff 18%, var(--vscode-editorWidget-background)); border: 1px solid #4fc1ff; border-radius: 5px; }
  #range-banner .range-actions { display: flex; gap: 6px; align-items: center; }
  #range-run-btn:disabled { opacity: 0.5; cursor: default; }
  /* AI_NOTE: 標準カードは .crow でラップされるので矢印ガターは .crow に付ける(下部のCSS)。ここでは個別cardに付けない(二重インデント防止) */
  #arrow-svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 5; }
  /* AI_NOTE: ② 参照アクティブ時、関連しないカードを暗くして該当だけ浮かせる */
  #cards-area.ref-active .card:not(.ref-self):not(.ref-out):not(.ref-in) { opacity: 0.25; }
  /* AI_NOTE: 概要の矢印オーバーレイ。畳んだグループ=メイン、開いた関数=サブを指す(JSで解決) */
  #ov-area { position: relative; }
  #ov-area.arrows-on .group-block { margin-left: var(--arrow-gutter); width: auto; }
  #ov-area.arrows-on.side-right .group-block { margin-left: 0; margin-right: var(--arrow-gutter); width: auto; }
  #ov-svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 5; }
  /* AI_NOTE: #6 プロジェクトビュー: 階層インデント・ディレクトリ見出し・解説・import矢印 */
  #proj-area { position: relative; }
  .odir { margin: 8px 0 3px; }
  .odir-name { font-size: 11px; font-weight: 600; color: var(--vscode-foreground); }
  .odir-desc { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 1px; line-height: 1.4; }
  .ofile-desc { flex-basis: 100%; margin-left: 28px; margin-top: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: normal; line-height: 1.4; }
  .odep { flex-basis: 100%; margin-left: 28px; margin-top: 1px; font-size: 10px; opacity: 0.6; white-space: normal; }
  .card.pfile { flex-wrap: wrap; }
  #proj-area.arrows-on .card.pfile { margin-left: var(--arrow-gutter) !important; width: auto; }
  #proj-area.arrows-on.side-right .card.pfile { margin-left: 0 !important; margin-right: var(--arrow-gutter); width: auto; }
  #proj-svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 5; }
  #proj-area.ref-active .pfile:not(.ref-self):not(.ref-out):not(.ref-in) { opacity: 0.25; }
  /* AI_NOTE: 質問欄と図以外の常設情報を置かず、狭いサイドバーでも図そのものへ幅を渡す。 */
  .process-map-finder { margin: 8px 8px 10px; padding: 9px; border-left: 3px solid #e2b93d; background: color-mix(in srgb, #e2b93d 10%, var(--vscode-sideBar-background)); }
  details.process-map-finder.compact { padding: 0; }
  details.process-map-finder.compact > summary { padding: 6px 9px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 10px; list-style-position: inside; }
  .process-map-finder-body { padding: 2px 9px 8px; }
  .process-map-title { font-size: 11px; font-weight: 600; margin-bottom: 5px; }
  .process-map-empty { margin: 24px 14px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.6; text-align: center; }
  .project-diagram-history { margin-top: 8px; font-size: 11px; }
  .project-diagram-history summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
  .project-diagram-history-row { display: flex; gap: 4px; align-items: center; margin-top: 5px; }
  .project-diagram-history-row .tbtn:first-child { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .project-diagram-history-date { color: var(--vscode-descriptionForeground); font-size: 10px; white-space: nowrap; }
  .process-diagram-head { display: flex; align-items: center; gap: 8px; margin: 5px 8px 2px; }
  .process-diagram-title { flex: 1; min-width: 0; font-size: 12px; font-weight: 650; line-height: 1.4; }
  .process-diagram-summary { margin: 4px 8px 5px; padding: 5px 7px; border-left: 2px solid #e2b93d; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, #e2b93d 6%, var(--vscode-sideBar-background)); font-size: 10px; line-height: 1.45; }
  .process-diagram { padding: 4px 8px 8px; overflow-x: visible; }
  .pd-layout { width: 100%; display: flex; flex-direction: column; --pd-line: #e2b93d; }
  ${projectFlowchartCss}
  .pd-node { position: relative; z-index: 1; width: 100%; min-width: 0; border: 0; color: var(--vscode-foreground); background: transparent; font: inherit; text-align: left; cursor: pointer; }
  .pd-node:hover { background: color-mix(in srgb, #2d5265 58%, var(--vscode-sideBar-background)); }
  .pd-node.reference { opacity: 0.76; border-style: dashed; }
  .pd-node-main { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
  .pd-node-heading { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .pd-node-label { min-width: 0; font-size: 11px; font-weight: 650; line-height: 1.3; white-space: normal; overflow-wrap: anywhere; }
  .pd-emphasis-badge { flex: none; padding: 0 4px; border: 1px solid var(--pd-accent); border-radius: 999px; color: var(--pd-accent); font-size: 8px; font-weight: 700; line-height: 1.35; }
  .pd-node-symbol { min-width: 0; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 9px; line-height: 1.25; overflow-wrap: anywhere; }
  .pd-node-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .pd-node-description { min-width: 0; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.35; overflow-wrap: anywhere; }
  .pd-emphasis-reason { min-width: 0; color: var(--pd-accent); font-size: 9px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
  .pd-edge-label { position: relative; z-index: 2; display: inline-block; max-width: calc(100% - 12px); padding: 1px 5px; border-radius: 8px; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); font-size: 9px; line-height: 1.3; white-space: normal; }

  /* 処理順: ラベルとコード位置を横に使い、直列区間の矢印間隔を小さくする。 */
  .pd-layout-flow { gap: 0; }
  .pd-flow-route-summary { margin: 0 0 8px; padding: 7px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-textBlockQuote-background); }
  .pd-flow-route-title { margin-bottom: 4px; color: var(--muted); font-size: 9px; font-weight: 700; letter-spacing: .04em; }
  .pd-flow-route { display: grid; grid-template-columns: minmax(48px, auto) minmax(0, 1fr); gap: 6px; padding: 3px 0; border-top: 1px solid var(--vscode-panel-border); font-size: 9px; line-height: 1.4; }
  .pd-flow-route:first-of-type { border-top: 0; }
  .pd-flow-route-label { color: var(--fg); font-weight: 700; }
  .pd-flow-route-steps { color: var(--muted); overflow-wrap: anywhere; }
  .pd-flow-node, .pd-reading-node, .pd-dependency-node { --pd-accent: var(--pd-line); }
  .pd-flow-node { display: grid; grid-template-columns: minmax(105px, 0.85fr) minmax(120px, 1.15fr); align-items: center; gap: 8px; padding: 5px 7px; border-left: 2px solid var(--pd-accent); border-bottom: 1px solid color-mix(in srgb, var(--pd-accent) 38%, transparent); }
  .pd-node.emphasis-important { --pd-accent: #d5a900; background: color-mix(in srgb, #d5a900 10%, transparent); }
  .pd-node.emphasis-warning { --pd-accent: #d94b4b; background: color-mix(in srgb, #d94b4b 10%, transparent); }
  .pd-node.emphasis-success { --pd-accent: #2f9d63; background: color-mix(in srgb, #2f9d63 10%, transparent); }
  .pd-node.emphasis-note { --pd-accent: #3986c7; background: color-mix(in srgb, #3986c7 10%, transparent); }
  .pd-flow-node.no-description { grid-template-columns: minmax(0, 1fr); }
  .pd-flow-node.no-description .pd-node-main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(100px, 42%); align-items: center; gap: 8px; }
  .pd-flow-node.no-description .pd-node-symbol { text-align: right; }
  .pd-flow-link { position: relative; height: 14px; margin-left: 6px; display: flex; align-items: center; padding-left: 16px; }
  .pd-flow-link::before { content: ""; position: absolute; left: 5px; top: 0; bottom: 5px; width: 1px; background: var(--pd-line); }
  .pd-flow-link::after { content: ""; position: absolute; left: 2px; bottom: 0; width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 6px solid var(--pd-line); }
  .pd-flow-branches { display: flex; flex-direction: column; gap: 3px; margin: 2px 0 2px 9px; padding-left: 10px; border-left: 1px solid var(--pd-line); }
  .pd-flow-branch { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .pd-flow-branch::before { content: ""; position: absolute; left: -10px; top: 13px; width: 9px; height: 1px; background: var(--pd-line); }
  .pd-flow-branch > .pd-edge-label { align-self: flex-start; margin: 0 0 -2px 2px; }

  /* 読解順: 並べ方の理由は図全体の概要へ置き、各行はコード地点とその地点の動作説明に分ける。 */
  .pd-layout-reading { gap: 0; }
  .pd-reading-row { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 5px; padding: 2px 0; }
  .pd-reading-row:not(:last-child)::after { content: ""; position: absolute; z-index: 0; left: 12px; top: 26px; bottom: -4px; width: 1px; background: var(--pd-line); }
  .pd-reading-number { position: relative; z-index: 1; align-self: start; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #1e1e1e; background: var(--pd-line); font-size: 10px; font-weight: 750; }
  .pd-reading-node { display: grid; grid-template-columns: minmax(105px, 0.85fr) minmax(120px, 1.15fr); align-items: center; gap: 8px; padding: 4px 6px; border-bottom: 1px solid color-mix(in srgb, var(--pd-accent) 32%, transparent); }
  .pd-reading-node.no-description { grid-template-columns: minmax(0, 1fr); }

  /* 依存関係: カードを入れ子にせず、細い枝線とコンパクトなアウトライン行で階層を示す。 */
  .pd-dependency-branch { display: flex; flex-direction: column; min-width: 0; }
  .pd-dependency-node { display: grid; grid-template-columns: minmax(110px, 0.9fr) minmax(120px, 1.1fr); align-items: center; gap: 7px; padding: 5px 6px; border-left: 2px solid var(--pd-accent); border-bottom: 1px solid color-mix(in srgb, var(--pd-accent) 30%, transparent); }
  .pd-dependency-node.no-description { grid-template-columns: minmax(0, 1fr); }
  .pd-dependency-node.no-description .pd-node-main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(100px, 42%); align-items: center; gap: 7px; }
  .pd-dependency-node.no-description .pd-node-symbol { text-align: right; }
  .pd-dependency-children { display: flex; flex-direction: column; gap: 0; margin-left: 12px; padding-left: 10px; border-left: 1px solid var(--pd-line); }
  .pd-dependency-child { position: relative; display: flex; flex-direction: column; min-width: 0; }
  .pd-dependency-child::before { content: ""; position: absolute; left: -10px; top: 14px; width: 9px; height: 1px; background: var(--pd-line); }
  .pd-dependency-child > .pd-edge-label { align-self: flex-start; margin: 1px 0 -1px 2px; }
  .pd-node.reference { padding-left: 24px; }
  .pd-reference-mark { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--pd-line); font-size: 14px; }
  @media (max-width: 420px) {
    .pd-flow-node, .pd-reading-node, .pd-dependency-node { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .pd-flow-node.no-description .pd-node-main, .pd-dependency-node.no-description .pd-node-main { grid-template-columns: minmax(0, 1fr); gap: 1px; }
    .pd-flow-node.no-description .pd-node-symbol, .pd-dependency-node.no-description .pd-node-symbol { text-align: left; }
  }
  .process-diagram-hint { margin: 0 10px 8px; color: var(--vscode-descriptionForeground); font-size: 10px; text-align: center; }
  .card.hl, .group-block.hl { outline: 2px solid var(--vscode-focusBorder, #0e639c); outline-offset: -2px; }
  .drill-btn { flex-shrink: 0; font-size: 10px; opacity: 0.55; cursor: pointer; padding: 0 3px; }
  .drill-btn:hover { opacity: 1; color: #4fc1ff; }
  /* AI_NOTE: ▶トグルは判定が小さく押しづらい→padding大+負marginで行高を変えず当たり判定だけ拡大(font 9→11) */
  .exp-btn { flex-shrink: 0; font-size: 11px; line-height: 1; opacity: 0.6; cursor: pointer; padding: 7px 7px; margin: -7px -4px; }
  .exp-btn:hover { opacity: 1; }
  .exp-btn.on { opacity: 1; color: #4fc1ff; }
  /* AI_NOTE: 子メソッドを畳む三角とクラス概要を開く操作が同じ記号だと区別できないため、クラス側だけ「概要」と明示する。 */
  .class-overview-btn { margin-left: auto; flex-shrink: 0; border: 0; color: inherit; background: transparent; font: inherit; font-size: 10px; opacity: 0.75; cursor: pointer; padding: 5px 6px; }
  .class-overview-btn:hover, .class-overview-btn.on { opacity: 1; color: #4fc1ff; }
  /* AI_NOTE: 左インデントは廃止。所属は各サブカード自身の親accent混色背景で表現する */
  .subwrap { margin: 0 0 6px 0; display: flex; flex-direction: column; gap: 2px; }
  .submsg { font-size: 11px; opacity: 0.6; padding: 4px 8px; }
  /* AI_NOTE: サブカードはメインと同格の寸法(同じpadding/左罫3px/全幅)。背景は「親色の薄い版」で、
     濃い親色のメイン(グループ見出し)の配下だと色の濃淡で読めるようにする。未展開カードの無色グレーとも区別が付く */
  /* AI_NOTE: 親色12%まで上げたら継ぎ目(32%)との差が縮み境目が曖昧に→各カードに親色40%の1px枠で輪郭を付ける(左罫3pxは維持) */
  .subcard { padding: 7px 9px; border: 1px solid color-mix(in srgb, var(--accent, #4fc1ff) 40%, var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e))); border-left: 3px solid var(--saccent, #4fc1ff); background: color-mix(in srgb, var(--accent, #4fc1ff) 12%, var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e))); cursor: pointer; }
  .subcard:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
  .sublabel { font-size: 11px; font-weight: 600; }
  .subdesc { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; margin-top: 1px; }
  /* AI_NOTE: サブカード群の前に出す関数概要(目的/入力/出力/補足)。サブカードと見分けが付くよう控えめな箱にする */
  .subover { padding: 7px 8px 8px; margin-bottom: 4px; border-left: 2px solid color-mix(in srgb, var(--accent, #4fc1ff) 55%, transparent); background: rgba(128,128,128,0.08); border-radius: 4px; }
  /* AI_NOTE: 「単なる改行でなく装飾で見やすく」の要望→見出しを項目別カラーの小タグ(ピル)にし、本文はその下に全幅で流す。
     色は --sok で行ごとに注入(目的=青/入力=緑/出力=黄/補足=オレンジ)。装飾絵文字は使わない方針のため色タグで区別する */
  .so-row { font-size: 11px; line-height: 1.5; }
  .so-row + .so-row { margin-top: 6px; }
  .so-k { display: inline-block; font-size: 9px; font-weight: 600; line-height: 1.6; padding: 0 7px; border-radius: 8px;
    color: var(--sok, #4fc1ff); background: color-mix(in srgb, var(--sok, #4fc1ff) 16%, transparent); border: 1px solid color-mix(in srgb, var(--sok, #4fc1ff) 35%, transparent); }
  .so-v { margin-top: 2px; }
  /* AI_NOTE: 展開グループは概要タブのgroup-blockと同じ文法にする: メイン=濃い親色(見出し)・サブ=薄い親色・隙間ゼロ(1px区切りのみ)。
     「同じ色の濃淡がひとかたまりに並ぶ」ことで所属を示し、枠もインデントも使わない。角丸はグループの上下端だけ */
  /* AI_NOTE: グループ背景=親色の継ぎ目(1px隙間にだけ見える)。カード背景を不透明にしたのでここは隙間以外に現れない。
     transparent混色だと半透明カードに透けて全体がビビッドになった(パキパキ指摘)ため、サイドバー背景との不透明混色に統一 */
  .card-block { margin-bottom: 4px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, var(--accent, #4fc1ff) 32%, var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e))); }
  /* AI_NOTE: !important はカードHTMLがインラインstyleで半透明accent背景(15%等)を直書きしているため。
     展開中は下に32%の継ぎ目帯があり、半透明のまま重なると実効40%相当の強い色になる(パキパキ報告の真因)。
     ここで不透明混色に強制上書きし、帯は1px隙間以外に現れないようにする */
  .card-block .card { margin-bottom: 1px; border-radius: 0; background: color-mix(in srgb, var(--accent, #4fc1ff) 12%, var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e))) !important; }
  /* AI_NOTE: ラッパ余白なし(全幅)・カード間1pxの継ぎ目。下だけ3px帯をはみ出させてグループの底を閉じる
     (隙間の線だけでは「同じグループ」に見えないという指摘への対応)。角丸はcard-blockのoverflow:hiddenが受け持つ */
  .card-block .subwrap { margin: 0; padding: 0 0 3px 0; gap: 1px; }
  .card-block .subcard, .card-block .subover { border-radius: 0; }
  /* AI_NOTE: overview箱もグループ内では同じ親色トーンにして、灰色の箱が挟まって分離して見えないようにする */
  .card-block .subover { margin-bottom: 0; border: 1px solid color-mix(in srgb, var(--accent, #4fc1ff) 40%, var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e))); border-left: 2px solid color-mix(in srgb, var(--accent, #4fc1ff) 55%, transparent); background: color-mix(in srgb, var(--accent, #4fc1ff) 12%, var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e))); }
  /* AI_NOTE: クラス(子=メソッドを持つカード)の階層表示は概要タブのグループ実装を共有する
     (.group-block/.group-title/.grp-toggle/.group-body + toggleGroup)。子持ちカードの開閉トグルとサブ表示の
     見た目を標準・概要で統一するため、専用クラスは作らず同じCSS/関数を参照する。下は標準側の矢印ガターのみ。 */
  #cards-area.arrows-on > .card, #cards-area.arrows-on > .card-block, #cards-area.arrows-on > .group-block { margin-left: var(--arrow-gutter); }
  #cards-area.arrows-on.side-right > .card, #cards-area.arrows-on.side-right > .card-block, #cards-area.arrows-on.side-right > .group-block { margin-left: 0; margin-right: var(--arrow-gutter); }
  .card .kind {
    font-size: 10px; letter-spacing: 0.02em;
    color: var(--vscode-descriptionForeground); flex-shrink: 0; width: 34px;
  }
  /* AI_NOTE: 脇役(概要/import)。色(枠・タグ)は残したまま、背景塗りを消し軽く減光して本筋から少し引っ込める */
  .card.muted {
    border-left-width: 2px;
    background: transparent;
    opacity: 0.82;
  }
  .card.muted:hover { opacity: 1; background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08)); }
  .card { flex-wrap: wrap; }
  .card .label { font-size: 12px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .desc {
    flex-basis: 100%; margin-left: 34px; margin-top: 3px;
    font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground); white-space: normal;
  }
  /* AI_NOTE: 子なしクラスのleafカード内に置く設計サブブロック。カードがflexコンテナなのでdescと同じくflex-basis:100%で改行させる */
  .card .design-block-full { flex-basis: 100%; margin: 3px 0 3px 34px; }
  #fc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .fc-title { font-size: 11px; opacity: 0.7; }
  .fc-zoom { margin-left: auto; display: flex; align-items: center; gap: 4px; }
  .fc-zoom .tbtn { min-width: 22px; padding: 1px 6px; }
  #fc-zoom-lbl { font-size: 11px; opacity: 0.7; min-width: 40px; text-align: center; }
  .mermaid { overflow: auto; }
  .mermaid svg { max-width: 100%; height: auto !important; }
  /* AI_NOTE: グループ(クラス/意味まとまり)。標準・概要で共有。枠箱+本体パディングは子を字下げして横幅を食うので不使用。
     代わりに「色付きタイトルバー(=見出し)＋本体は薄い同色地で全幅」にし、字下げゼロのまま所属を示す。 */
  .group-block { border-radius: 5px; overflow: hidden; margin-bottom: 6px; }
  .group-block:hover { filter: brightness(1.05); }
  .group-title { display: flex; align-items: center; gap: 5px; padding: 5px 8px; font-weight: 600; font-size: 11px; cursor: pointer; background: color-mix(in srgb, var(--accent, #4fc1ff) 22%, transparent); }
  .grp-toggle { flex-shrink: 0; font-size: 10px; opacity: 0.7; user-select: none; }
  .grp-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grp-count { font-size: 9px; opacity: 0.55; margin-left: auto; flex-shrink: 0; }
  /* AI_NOTE: クラス概要説明(AI)。タイトルバーと同じ濃さの地にして「クラス名＋説明=1枚のヘッダカード」に見せる
     (別背景だと下のメソッドと分離して浮く)。group-bodyの外なので折りたたみ時も残り「何のクラスか」を保つ。 */
  .grp-desc { font-size: 11px; line-height: 1.4; color: var(--vscode-foreground); opacity: 0.85; padding: 0 8px 6px 8px; background: color-mix(in srgb, var(--accent, #4fc1ff) 22%, transparent); }
  /* AI_NOTE: 本体は左右パディング0で子を全幅(top-levelと同じ左端)。子は隙間ゼロで地続きにし(margin/gap除去・角丸なし)、
     行間はヘアラインのみで区切る。薄い同色地でグループ全体を1つの塊に見せる(隙間があると別グループに見えるため)。 */
  .group-body { display: flex; flex-direction: column; gap: 0; padding: 0; background: color-mix(in srgb, var(--accent, #4fc1ff) 8%, transparent); }
  .group-body.collapsed { display: none; }
  .group-body > .card, .group-body > .inner-card, .group-body > .card-block, .group-body > .group-block { margin: 0; border-radius: 0; }
  /* AI_NOTE: 一体感は背景で出しつつ、行(サブカード)同士の境界はヘアラインを濃いめにして見分けられるようにする */
  .group-body > .card:not(:last-child), .group-body > .inner-card:not(:last-child) { border-bottom: 1px solid color-mix(in srgb, var(--accent, #4fc1ff) 45%, transparent); }
  /* AI_NOTE: 概要サブ(関数)カード。標準subcardと体裁統一=縦積み(見出し/説明)。横並びflexをやめ改行の喧嘩を解消する */
  .inner-card { display: block; border-left: 3px solid var(--accent, #4fc1ff); border-radius: 3px; padding: 5px 8px; cursor: pointer; background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.1)); }
  .inner-card:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.07)); }
  .inner-card.hl { outline: 1px solid var(--vscode-focusBorder, #0e639c); outline-offset: -1px; }
  /* AI_NOTE: サブカード見出し頭の種別バッジ(関数/クラス)。見出し行に小さく前置。標準subcardと共通フォーマット */
  .inner-card .kind { font-size: 10px; opacity: 0.7; margin-right: 5px; }
  /* AI_NOTE: 参照ボタン。クリックで呼び出し関係のカードを強調(out=この関数が呼ぶ / in=この関数を呼ぶ) */
  .ref-btn { flex-shrink: 0; font-size: 9px; opacity: 0.5; cursor: pointer; padding: 0 4px; }
  .ref-btn:hover { opacity: 1; }
  .ref-btn.active { opacity: 1; color: #f0a500; }
  .card.ref-self { outline: 2px solid rgba(255,255,255,0.7); outline-offset: -2px; }
  .card.ref-out { outline: 2px solid #f0a500; outline-offset: -2px; }
  .card.ref-in { outline: 2px solid #4ec9b0; outline-offset: -2px; }
  /* AI_NOTE: ボタンが増えサイドバーが狭いと画面外にはみ出るので、折り返さず横スクロールで全ボタンに届くようにする(縦は出さない・スクロールバー分の余白を下に確保) */
  /* AI_NOTE: 下にスクロールしても矢印/色/範囲展開などにすぐ届くよう、スクロール容器(#panes)の上端に貼り付ける。カードが下を通るので背景を敷いて透けを防ぐ。z-indexは矢印SVG(5)/範囲バナー(10)より上。 */
  #toolbar { position: sticky; top: 0; z-index: 20; display: flex; gap: 4px; margin-bottom: 8px; padding: 6px 0 2px 0; overflow-x: auto; overflow-y: hidden; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .tbtn {
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.22));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    /* AI_NOTE: テーマによっては背景がパネル色と一体化して枠が見えないため、明示的に枠線を付ける */
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, rgba(128,128,128,0.5)));
    border-radius: 3px; padding: 3px 9px; font-size: 11px; cursor: pointer;
    /* AI_NOTE: 狭い幅で改行・省略されないようにする(サイドバーは縦長で横が狭い) */
    white-space: nowrap; flex-shrink: 0;
  }
  .tbtn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.35)); border-color: var(--vscode-focusBorder, rgba(128,128,128,0.8)); }
  .tbtn.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .tbtn.busy { opacity: 0.7; cursor: default; }
  .tbtn:disabled { cursor: default; }
  .settings { display: flex; flex-direction: column; gap: 14px; }
  .sgroup { display: flex; flex-direction: column; gap: 6px; }
  .sgroup:not(:first-child) { border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); padding-top: 14px; }
  .stitle { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  .srow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .slabel { font-size: 12px; }
  .snote { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
  /* AI_NOTE: ヘルプタブ用。設定タブの .settings/.sgroup 系を流用しつつ、手順リスト・キー表記・本文段落だけ足す。 */
  .help p { font-size: 12px; line-height: 1.5; margin: 2px 0; }
  .help ol, .help ul { font-size: 12px; line-height: 1.5; margin: 4px 0 4px 0; padding-left: 18px; }
  .help li { margin-bottom: 5px; }
  .help .btnrow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .kbd { display: inline-block; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; padding: 1px 6px; border-radius: 4px;
         border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4)); background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17)); white-space: nowrap; }
  /* AI_NOTE: ヘルプ質問の回答欄。改行保持で読みやすく、本文と区別するため枠+薄い背景。 */
  .help-answer { margin-top: 8px; padding: 8px 10px; border-radius: 5px; font-size: 12px; line-height: 1.5; white-space: pre-wrap;
                 background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1)); border-left: 3px solid var(--vscode-focusBorder, #0e639c); }
  /* AI_NOTE: 機能スクショ。狭いサイドバー幅に合わせ幅100%・枠付き、下にキャプション。 */
  /* AI_NOTE: 狭いサイドバーは横並びにできないので、画像は列幅いっぱい(width:100%)で表示し左右の余白を作らない。縦長でもスクロール前提で許容。 */
  .help-shot { margin: 8px 0 0 0; }
  .help-shot img { display: block; width: 100%; border-radius: 5px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); }
  .help-shot figcaption { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .row { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
  select, textarea {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
    border-radius: 4px; padding: 4px 6px; font-family: inherit; font-size: 12px; width: 100%;
  }
  textarea { resize: vertical; }
  .ok { color: var(--vscode-testing-iconPassed, #4ec9b0); font-size: 12px; }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 12px; }
  /* AI_NOTE: チャットペインだけ縦いっぱいにして入力欄を下部固定にする */
  .pane.active[data-pane="chat"] { height: 100%; }
  .pane.active[data-pane="usage"] { height: 100%; }
  .chat { display: flex; flex-direction: column; height: 100%; }
  /* AI_NOTE: 上部のツールバー+履歴をまとめる箱。高さが詰まったら自身が縮んで内部スクロールし、下部の入力欄を枠外へ押し出さない。
     通常高さでは flex-grow:0 なので中身のぶんだけの高さで今までと同じ。min-height:0 が無いと縮まないので必須。 */
  .chat-top { flex-shrink: 1; min-height: 0; overflow-y: auto; }
  #chat-head { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; flex-shrink: 0; }
  /* AI_NOTE: ② チャットのモデルバッジ。入力欄直上に控えめに置き、クリックで切替できることを ▾ で示す。 */
  #cmodel-bar { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 4px; margin: 2px 0; }
  #cmodel, #ceffort { font-size: 10px; color: var(--vscode-descriptionForeground); background: transparent; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); border-radius: 10px; padding: 1px 8px; cursor: pointer; }
  #cmodel:hover, #ceffort:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder, #0e639c); }
  .chat-context { border-left: 2px solid #f0a500; background: rgba(240,165,0,0.08); border-radius: 0 4px 4px 0; padding: 6px 8px; }
  .cc-label { font-size: 9px; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .cc-code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }
  .cc-exp { font-size: 11px; margin-top: 7px; padding-top: 7px; border-top: 1px solid rgba(240,165,0,0.25); }
  /* AI_NOTE: エディタ選択の引用チップ。場所参照(file L行-行)を主表示し、コードは折りたたみ。×で外す。 */
  /* AI_NOTE: ⑤→Cursor風に変更。#cinput(contenteditable)の文中にインラインアトムとして埋め込むピル。場所参照＋×だけ。 */
  .quote-chip { display: inline-flex; align-items: center; gap: 4px; background: rgba(79,193,255,0.12); border: 1px solid rgba(79,193,255,0.35); border-radius: 4px; padding: 1px 4px 1px 6px; max-width: 100%; }
  .qc-loc { font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .qc-x { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 12px; line-height: 1; padding: 0 1px; }
  .qc-x:hover { color: var(--vscode-foreground); }
  .cc-item { margin-top: 7px; padding-top: 7px; border-top: 1px solid rgba(240,165,0,0.25); }
  .cc-item:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .cc-head { font-weight: 600; color: var(--vscode-foreground); line-height: 1.4; }
  .cc-body { color: var(--vscode-descriptionForeground); margin-top: 2px; white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
  #cmsgs { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-bottom: 8px; }
  .cmsg { padding: 7px 10px; border-radius: 6px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  /* AI_NOTE: VS Code Webviewの既定CSSに依存せず、質問・返信とその子要素を常にドラッグ選択できるよう明示する。 */
  #cmsgs .cmsg, #cmsgs .cmsg * { -webkit-user-select: text; user-select: text; }
  /* AI_NOTE: 吹き出しの色分け。テーマ変数依存だと両方青く見えるテーマがあるため、user=青系/assistant=グレー系の固定rgbaで分離する */
  .cmsg.user { background: rgba(79,193,255,0.13); border: 1px solid rgba(79,193,255,0.4); align-self: flex-end; max-width: 92%; }
  .cmsg.assistant { background: rgba(128,128,128,0.10); border: 1px solid rgba(128,128,128,0.28); align-self: flex-start; max-width: 95%; white-space: normal; }
  /* AI_NOTE: 返信待ち中にキューへ積まれた送信待ちバブル。薄くして「まだ送っていない」ことを見せる */
  .cmsg.user.queued { opacity: 0.55; }
  /* AI_NOTE: userバブル内の添付引用ミニチップ（×なし）。pendingチップ(.quote-chip)とは役割が違うのでクラスを分ける。
     本文中で参照されなかった引用だけがここに残る(renderUserContent参照)。*/
  .bq-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  /* AI_NOTE: 本文中「(引用N)」の位置にそのままインライン埋め込みされる。baselineだと行に対して浮いて見える指摘があったためmiddleで行中央に揃える */
  .bq-chip { display: inline-block; vertical-align: middle; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); background: rgba(79,193,255,0.12); border: 1px solid rgba(79,193,255,0.35); border-radius: 4px; padding: 1px 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* AI_NOTE: renderMarkdown が出す要素のスタイル。<br>で改行するので white-space は normal にしている */
  .cmsg code { background: rgba(128,128,128,0.22); padding: 0 3px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .cmsg .cmd-code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 6px 8px; border-radius: 4px; overflow-x: auto; white-space: pre; margin: 5px 0; }
  .cmsg .cmd-code code { background: none; padding: 0; }
  .cmsg ul { margin: 4px 0; padding-left: 18px; }
  .cmsg a { color: var(--vscode-textLink-foreground); }
  .cmsg-head { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
  .crole { flex: 1; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .cmsg-copy { border: 0; background: transparent; color: var(--vscode-textLink-foreground); font: inherit; font-size: 10px; cursor: pointer; padding: 0 2px; }
  .cmsg-copy:hover { text-decoration: underline; }
  .thinking { color: var(--vscode-descriptionForeground); font-style: italic; }
  .cstop-btn { margin-left: 8px; padding: 1px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .cstop-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  /* AI_NOTE: 使用量タブ */
  .usage { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; height: 100%; padding-bottom: 8px; }
  .u-head { display: flex; align-items: center; justify-content: space-between; }
  .u-title { font-size: 13px; font-weight: 600; }
  .u-cards { display: flex; gap: 6px; }
  .u-card { flex: 1; background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12)); border-radius: 6px; padding: 8px; text-align: center; }
  .u-card .u-k { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .u-card .u-v { font-size: 15px; font-weight: 600; margin: 2px 0; }
  .u-card .u-c { font-size: 10px; color: var(--vscode-charts-orange, #e8a33d); }
  .u-sec { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-top: 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); padding-bottom: 2px; }
  .u-bars { display: flex; flex-direction: column; gap: 3px; }
  .u-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .u-date { width: 40px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .u-track { flex: 1; height: 12px; background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12)); border-radius: 3px; overflow: hidden; }
  .u-bar { height: 100%; background: var(--vscode-charts-orange, #e8a33d); border-radius: 3px; min-width: 0; }
  .u-amt { width: 96px; text-align: right; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
  .u-models { display: flex; flex-direction: column; gap: 2px; }
  .u-mrow { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 3px 0; }
  .u-mname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .u-mtok { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .u-mcost { color: var(--vscode-charts-orange, #e8a33d); flex-shrink: 0; width: 110px; text-align: right; }
  .u-note { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.8; margin-top: 4px; }
  /* AI_NOTE: チャットペイン上部のインライン解説パネル(生成/範囲/クリア/密度/自動 + 件数 + 一覧) */
  .ann-panel { flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); padding-bottom: 6px; margin-bottom: 6px; display: flex; flex-direction: column; gap: 4px; }
  .ann-rows { display: flex; flex-direction: column; gap: 4px; }
  /* 初期viewportに通常生成と強制再生成を必ず並べる。説明文を各ボタンの横へ置くと、
     狭いサイドバーで折り返して1行目だけが高さを占有し、再生成が画面外へ落ちる。 */
  .ann-primary-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; }
  .ann-primary-actions > .tbtn { min-width: 0; width: 100%; padding-left: 5px; padding-right: 5px; text-align: center; }
  .ann-primary-desc { font-size: 10px; line-height: 1.35; color: var(--vscode-descriptionForeground); }
  .ann-row { display: flex; align-items: center; gap: 8px; }
  /* AI_NOTE: ボタン列は固定幅で説明の開始位置を縦に整列(ON↔OFFで幅が変わっても説明が動かない)。
     width指定はグローバル select{width:100%}(設定タブ用)の打ち消しも兼ねる */
  .ann-row > .tbtn { flex-shrink: 0; width: 150px; text-align: left; }
  .ann-desc { font-size: 11px; color: var(--vscode-descriptionForeground); flex: 1; min-width: 0; }
  /* AI_NOTE: トレースタブは操作名(ボタン・キー)が短いので左列を狭くする。解説タブと同じ150pxだと
     説明文が右半分へ押し込まれて何行にも折り返る(ユーザー指摘)。幅は最長ラベル「別の入力例で再実行」が
     枠に触れずに収まる120px。 */
  .trace-rows .ann-row > .tbtn { width: 120px; }
  .trace-rows .ann-row > .ann-desc:first-child { flex: 0 0 120px; }
  /* サイドバーが狭い時は固定2列をやめる。説明欄が数文字幅になって縦書きのように
     崩れるのを防ぎ、操作名の下へ通常の文章として流す。 */
  @media (max-width: 360px) {
    .trace-rows .ann-row { flex-direction: column; align-items: stretch; gap: 4px; }
    .trace-rows .ann-row > .tbtn { width: 100%; }
    .trace-rows .ann-row > .ann-desc,
    .trace-rows .ann-row > .ann-desc:first-child { flex: none; width: auto; }
  }
  /* AI_NOTE: トレースタブの周回ボタン行。左=行番号+ループのコード(長ければ省略)、右=◀ n/m ▶ を固定幅で右端に揃える */
  .trace-loop { display: flex; align-items: center; gap: 6px; }
  .trace-loop-code { font-family: var(--vscode-editor-font-family); font-size: 11px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trace-loop > .tbtn.trace-iter { flex-shrink: 0; width: auto; min-width: 24px; padding: 1px 6px; text-align: center; }
  .trace-iter-label { font-size: 11px; min-width: 34px; text-align: center; flex-shrink: 0; }
  /* AI_NOTE: 一括トレースの関数チェックリスト。関数名は等幅、行番号は右端に薄く出す */
  .trace-func-tools { display: flex; gap: 6px; }
  .trace-func-tools > .tbtn { width: auto; padding: 1px 8px; }
  .trace-func-row { display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; }
  .trace-func-row > input { margin: 0; flex-shrink: 0; }
  .trace-func-name { font-family: var(--vscode-editor-font-family); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trace-func-line { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .ann-sec { font-size: 11px; font-weight: 600; opacity: 0.85; margin-top: 4px; }
  .ann-status { font-size: 11px; color: var(--vscode-descriptionForeground); }
  /* AI_NOTE: 選択待ちモード中のボタン強調と上部バナー */
  .tbtn.awaiting { background: #f0a500; color: #1e1e1e; border-color: #f0a500; }
  .tbtn.awaiting:hover { background: #ffba2e; }
  /* AI_NOTE: 押下フィードバック。全ボタン共通。押した瞬間に凹み(scale)＋表面が一瞬パッと明るく光る(brightness)。
     何も起きない操作でも「押した」が必ずボタン自体で分かるようにする。外側リング(box-shadow)も補助で出す。 */
  button { transition: transform 0.05s ease; }
  button:active { transform: scale(0.92); }
  @keyframes btn-pulse {
    0%   { filter: brightness(1.7); box-shadow: 0 0 0 0 rgba(120,170,255,0.6); }
    100% { filter: brightness(1);   box-shadow: 0 0 0 7px rgba(120,170,255,0); }
  }
  .btn-pulse { animation: btn-pulse 0.4s ease-out; }
  /* AI_NOTE: 生成中スピナー。busy の間 ⟳ を回す。テキストはJSが「⟳ 生成中…」へ差し替える */
  @keyframes tbtn-spin { to { transform: rotate(360deg); } }
  .tbtn .spin { display: inline-block; animation: tbtn-spin 0.7s linear infinite; }
  /* AI_NOTE: 完了/表示済み=緑、失敗=赤の一瞬のフラッシュ。状態を色でも区別する */
  .tbtn.flash-ok { background: var(--vscode-testing-iconPassed, #4ec9b0); color: #1e1e1e; border-color: var(--vscode-testing-iconPassed, #4ec9b0); }
  .tbtn.flash-err { background: var(--vscode-errorForeground, #f14c4c); color: #fff; border-color: var(--vscode-errorForeground, #f14c4c); }
  .ann-await { font-size: 11px; padding: 5px 8px; border-left: 3px solid #f0a500; background: rgba(240,165,0,0.12); border-radius: 0 4px 4px 0; }
  .ann-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 3px; border-left: 2px solid #f0a500; }
  .ann-row:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
  /* AI_NOTE: 受信箱型のチャット履歴リスト */
  .chat-current-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 6px; }
  .chist { font-size: 11px; margin-bottom: 6px; }
  .chist > summary { cursor: pointer; color: var(--vscode-descriptionForeground); padding: 3px 0; user-select: none; }
  .chist-more > summary { cursor: pointer; color: var(--vscode-textLink-foreground); padding: 4px 0; user-select: none; font-size: 10px; }
  /* AI_NOTE: 各履歴を独立カードに見せる。全周1px枠＋行間marginで隣との切れ目を明示（枠なしだと連続して1件の区切りが読めない指摘への対応）。現在チャットは左3px accent＋背景で強調 */
  .chist-row { display: flex; gap: 6px; padding: 6px 7px; margin-bottom: 5px; border-radius: 5px; cursor: pointer; align-items: flex-start;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28)); border-left: 3px solid transparent;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.06)); }
  .chist-row:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); border-color: var(--vscode-focusBorder, #0e639c); }
  .chist-row.current { border-left-color: var(--vscode-focusBorder, #0e639c); border-color: var(--vscode-focusBorder, #0e639c); background: var(--vscode-list-activeSelectionBackground, rgba(14,99,156,0.18)); }
  .chist-main { flex: 1; min-width: 0; }
  .chist-title { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chist-meta { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chist-preview { font-size: 10px; opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .chist-actions { display: flex; flex-direction: column; gap: 2px; opacity: 0; transition: opacity 0.1s; }
  .chist-row:hover .chist-actions { opacity: 1; }
  .chist-act { cursor: pointer; font-size: 11px; opacity: 0.7; padding: 0 3px; }
  .chist-act:hover { opacity: 1; color: #4fc1ff; }
  /* AI_NOTE: ⑤ Cursor風の入力ボックス。枠は箱側が持ち、中に「引用チップ列＋入力欄」を縦に積む。textarea自身は枠なしで箱に溶け込ませる。 */
  /* AI_NOTE: 存在感を上げる。多くのテーマで input-background が背景と同色で薄枠だけでは沈むため、
     常時うっすらのaccentハロー(0 0 0 1px)＋持ち上げ影で「ここが入力欄」を常に見せる。focusで青リングを強め、影も残す。 */
  #cinput-box {
    flex-shrink: 0; display: flex; flex-direction: column; gap: 5px;
    background: var(--vscode-input-background); border: 1.5px solid var(--vscode-input-border, rgba(140,140,140,0.55));
    border-radius: 8px; padding: 7px 9px;
    box-shadow: 0 0 0 1px rgba(120,170,255,0.22), 0 2px 10px rgba(0,0,0,0.28);
  }
  #cinput-box:focus-within { border-color: var(--vscode-focusBorder, #0e639c); box-shadow: 0 0 0 3px rgba(14,99,156,0.38), 0 2px 10px rgba(0,0,0,0.28); }
  /* AI_NOTE: 新規チャット押下時に入力欄へ視線を誘導するワンショットのパルス。JS側で .attn を一時付与して再生する（3回・青リング拡大）。 */
  @keyframes cinput-attn {
    0%   { box-shadow: 0 0 0 0 rgba(88,166,255,0.85), 0 2px 10px rgba(0,0,0,0.28); }
    70%  { box-shadow: 0 0 0 11px rgba(88,166,255,0), 0 2px 10px rgba(0,0,0,0.28); }
    100% { box-shadow: 0 0 0 0 rgba(88,166,255,0), 0 2px 10px rgba(0,0,0,0.28); }
  }
  #cinput-box.attn { animation: cinput-attn 0.6s ease-out 3; border-color: var(--vscode-focusBorder, #0e639c); }
  #cinput-row { display: flex; gap: 6px; align-items: flex-end; }
  /* AI_NOTE: ⑤ contenteditable化(旧textarea)。引用チップを文中にインラインで埋め込むため、resize/valueを持てるtextareaでなくdivにした。
     高さはmax-height+overflow-yで抑える(旧autoGrowInputのJS計測は不要)。 */
  #cinput {
    flex: 1; background: transparent; color: var(--vscode-input-foreground);
    border: none; border-radius: 0; padding: 2px 2px; font-family: inherit; font-size: 12px;
    min-height: 24px; max-height: 30vh; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
    outline: none; line-height: 1.6;
  }
  /* AI_NOTE: プレースホルダは折り返すと入力欄が2行に膨らむ(サイドバー幅依存)ので、1行固定+…で切る */
  #cinput:empty::before { content: attr(data-placeholder); color: var(--vscode-descriptionForeground); pointer-events: none; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #cinput .quote-chip { user-select: none; vertical-align: middle; margin: 0 2px; }
</style>
</head>
<body>
<div id="tabbar">${tabButtons}</div>
<div id="panes">
  <div class="pane active" data-pane="standard">${standardBody}</div>
  <div class="pane" data-pane="overview">${this.buildOverviewPane()}</div>
  <div class="pane" data-pane="project">${this.buildProjectPane()}</div>
  <div class="pane" data-pane="process">${this.buildProcessPane()}</div>
  <div class="pane" data-pane="inline">${this.buildInlinePane()}</div>
  <div class="pane" data-pane="trace">${this.buildTracePane()}</div>
  <div class="pane" data-pane="chat">${this.buildChatPane()}</div>
  <div class="pane" data-pane="usage">${this.buildUsagePane()}</div>
  <div class="pane" data-pane="settings">${this.buildSettingsPane()}</div>
  <div class="pane" data-pane="help">${this.buildHelpPane()}</div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  // AI_NOTE: webviewスクリプトの実行時エラーは既定ではどこにも出ず「全ボタン無反応」になる。拡張側へ転送して可視化する。
  window.onerror = (msg, src, line, col) => { vscode.postMessage({ type: 'webviewError', text: msg + ' @' + line + ':' + col }); return false; };
  // AI_NOTE: pending引用(未送信)のラベル一覧。webview初期化時にチップDOMを組み立て#cinputへ復元するために使う。
  const pendingQuotes = ${JSON.stringify((this.currentChatId ? this.chatStore.get(this.currentChatId)?.contexts ?? [] : []).map((c, i) => this.quoteLabel(c, i + 1)))};
  const PROCESS_DIAGRAM_TARGETS = ${JSON.stringify(processDiagramTargets)};
  ${projectFlowchartRuntime}
  // AI_NOTE: 質問別コード図のHTMLノードidを、拡張側で実在確認済みのファイルと行へ変換する。
  function processDiagramNodeClick(nodeId) {
    const target = PROCESS_DIAGRAM_TARGETS[nodeId];
    if (target) vscode.postMessage({type:'openProjectSymbol',text:target.path,line:target.line});
  }
  // AI_NOTE: Mermaid callbackではなく通常のHTMLボタンなので、webview全体の委譲イベントで接続する。
  // inner spanを押した場合もclosestでカード本体へ戻し、再描画後も個別listenerの再登録を不要にする。
  document.addEventListener('click', event => {
    const shape = event.target instanceof Element ? event.target.closest('.pd-flow-shape[data-node-id]') : null;
    if (shape) { selectProjectDiagramShape(shape); return; }
    const jump = event.target instanceof Element ? event.target.closest('.pd-detail-jump[data-node-id]') : null;
    if (jump) { processDiagramNodeClick(jump.dataset.nodeId); return; }
    const clicked = event.target instanceof Element ? event.target.closest('.pd-node[data-node-id]:not(.pd-flow-shape)') : null;
    if (clicked) processDiagramNodeClick(clicked.dataset.nodeId);
  });
  const REF_EDGES = ${JSON.stringify(this.graphEdges.map((e) => ({ from: e.from, to: e.to })))};
  const ARROW_EDGES = ${JSON.stringify(this.graphEdges.map((e) => ({ from: e.from, to: e.to, fromLine: e.fromLine })))};
  // AI_NOTE: 矢印を描く側(left/right)。設定値。アンカー位置(カードの左端/右端)とふくらみ方向の分岐に使う。
  const ARROW_SIDE = '${this.arrowSide}';
  // AI_NOTE: 矢印の膨らみ上限。CSSの--arrow-gutterと同じ固定px幅を共有し、予約スペースと実際の描画幅を一致させる(はみ出し・余り防止)。少しだけ内側に収めるため-8。
  function arrowGutter() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--arrow-gutter')) || 96; }
  // AI_NOTE: drawCallArrows/onRefClickが参照するため先頭で宣言(早期activateからの呼び出しでTDZにならないように)
  let activeRefNodeId = null;
  // AI_NOTE: ②③ 矢印ON時、各カードの左端から呼出先カードの左端へ左側のベジェ矢印を描く(コードの反対側)。
  // 参照アクティブ時は、その関数に繋がる矢印だけ色付け(out=橙/in=ティール)し、他は薄くする。
  // AI_NOTE: 標準の端点解決(概要と同じ思想)。展開中=サブカード、未展開=メインカードを指す。
  // FROM: 展開中なら呼び出し行(fromLine)を含むサブカード。TO: 展開中なら先頭サブカード(関数の入口)。
  function stdFromEl(area, e) {
    const card = area.querySelector('.card[data-id="' + e.from + '"]');
    if (!card) return null;
    if (e.fromLine != null) {
      const subs = area.querySelectorAll('.subcard[data-parent="' + e.from + '"]');
      for (const s of subs) {
        const ls = +s.getAttribute('data-line-start'), le = +s.getAttribute('data-line-end');
        if (e.fromLine >= ls && e.fromLine <= le) return s;
      }
    }
    return card;
  }
  function stdToEl(area, e) {
    const card = area.querySelector('.card[data-id="' + e.to + '"]');
    if (!card) return null;
    const sub = area.querySelector('.subcard[data-parent="' + e.to + '"]');
    return sub || card;
  }
  function drawCallArrows() {
    const svg = document.getElementById('arrow-svg');
    const area = document.getElementById('cards-area');
    if (!svg || !area) return;
    Array.prototype.slice.call(svg.children).forEach(function(c){ if (c.tagName !== 'defs') svg.removeChild(c); });
    const ar = area.getBoundingClientRect();
    // AI_NOTE: サブカードは.subwrap内に入れ子でoffsetParentが不定なのでrectでarea相対に正規化する
    const right = ARROW_SIDE === 'right';
    function anchor(el) { const r = el.getBoundingClientRect(); return { x: (right ? r.right : r.left) - ar.left, y: r.top - ar.top + r.height / 2 }; }
    for (const e of ARROW_EDGES) {
      const fe = stdFromEl(area, e), te = stdToEl(area, e);
      if (!fe || !te || fe === te) continue;
      const a = anchor(fe), b = anchor(te);
      // AI_NOTE: 横幅は固定ガター内に収め、その範囲で縦距離に応じてだけ膨らませる(離れた矢印同士を見分けるため)。
      const bulge = Math.min(arrowGutter() - 8, 20 + Math.abs(b.y - a.y) * 0.09);
      const cpX = right ? Math.min(a.x + bulge, area.clientWidth - 6) : Math.max(a.x - bulge, 6);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + cpX + ' ' + a.y + ', ' + cpX + ' ' + b.y + ', ' + b.x + ' ' + b.y);
      p.setAttribute('stroke-width', '1.5'); p.setAttribute('fill', 'none');
      if (activeRefNodeId && e.from === activeRefNodeId) { p.setAttribute('stroke', '#f0a500'); p.setAttribute('opacity', '0.95'); p.setAttribute('marker-end', 'url(#arr-head-out)'); }
      else if (activeRefNodeId && e.to === activeRefNodeId) { p.setAttribute('stroke', '#4ec9b0'); p.setAttribute('opacity', '0.95'); p.setAttribute('marker-end', 'url(#arr-head-in)'); }
      else { p.setAttribute('stroke', '#4fc1ff'); p.setAttribute('opacity', activeRefNodeId ? '0.12' : '0.55'); p.setAttribute('marker-end', 'url(#arr-head)'); }
      svg.appendChild(p);
    }
  }
  window.addEventListener('resize', drawCallArrows);

  // AI_NOTE: #6 プロジェクトのimport依存矢印(左側)。ファイルカードの左端から依存先カードの左端へ。
  const PROJ_EDGES = ${JSON.stringify((this.projectData?.edges ?? []).map((e) => ({ from: e.from, to: e.to })))};
  let activeProjRefId = null;
  function drawProjectArrows() {
    const svg = document.getElementById('proj-svg');
    const area = document.getElementById('proj-area');
    if (!svg || !area) return;
    Array.prototype.slice.call(svg.children).forEach(function(c){ if (c.tagName !== 'defs') svg.removeChild(c); });
    for (const e of PROJ_EDGES) {
      const f = area.querySelector('.pfile[data-id="' + e.from + '"]');
      const t = area.querySelector('.pfile[data-id="' + e.to + '"]');
      if (!f || !t) continue;
      // AI_NOTE: 標準と同じく right側ならカード右端アンカー・右ふくらみ
      const right = ARROW_SIDE === 'right';
      const fx = right ? f.offsetLeft + f.offsetWidth : f.offsetLeft, fy = f.offsetTop + f.offsetHeight / 2;
      const tx = right ? t.offsetLeft + t.offsetWidth : t.offsetLeft, ty = t.offsetTop + t.offsetHeight / 2;
      const bulge = Math.min(arrowGutter() - 8, 20 + Math.abs(ty - fy) * 0.09);
      const cpX = right ? Math.min(fx + bulge, area.clientWidth - 6) : Math.max(fx - bulge, 6);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M ' + fx + ' ' + fy + ' C ' + cpX + ' ' + fy + ', ' + cpX + ' ' + ty + ', ' + tx + ' ' + ty);
      p.setAttribute('stroke-width', '1.3'); p.setAttribute('fill', 'none');
      if (activeProjRefId && e.from === activeProjRefId) { p.setAttribute('stroke', '#f0a500'); p.setAttribute('opacity', '0.95'); }
      else if (activeProjRefId && e.to === activeProjRefId) { p.setAttribute('stroke', '#4ec9b0'); p.setAttribute('opacity', '0.95'); }
      else { p.setAttribute('stroke', '#4fc1ff'); p.setAttribute('opacity', activeProjRefId ? '0.1' : '0.5'); }
      p.setAttribute('marker-end', 'url(#parr-head)');
      svg.appendChild(p);
    }
  }
  window.addEventListener('resize', drawProjectArrows);

  // AI_NOTE: 概要の呼び出し矢印。各エッジ端点(関数id)を「可視の最小要素」へ解決する:
  // グループが開いていれば inner-card(サブ)、畳んでいれば group-block(メイン)を指す。
  // 同じ畳んだグループ内同士は同一要素に解決されるので自己ループは描かない。
  function ovEndpoint(area, fid) {
    const card = area.querySelector('.inner-card[data-id="' + fid + '"]');
    if (!card) return null;
    const gb = card.closest('.group-block');
    const body = gb && gb.querySelector('.group-body');
    if (body && body.classList.contains('collapsed')) return gb; // 畳んでいる→メイン
    return card; // 開いている→サブ
  }
  function drawOverviewArrows() {
    const svg = document.getElementById('ov-svg');
    const area = document.getElementById('ov-area');
    if (!svg || !area) return;
    Array.prototype.slice.call(svg.children).forEach(function(c){ if (c.tagName !== 'defs') svg.removeChild(c); });
    const ar = area.getBoundingClientRect();
    const right = ARROW_SIDE === 'right';
    // AI_NOTE: 入れ子要素はoffsetParentが不定なのでgetBoundingClientRectでarea相対に正規化する
    function anchor(el) {
      const r = el.getBoundingClientRect();
      return { x: (right ? r.right : r.left) - ar.left, y: r.top - ar.top + r.height / 2 };
    }
    for (const e of ARROW_EDGES) {
      const fe = ovEndpoint(area, e.from), te = ovEndpoint(area, e.to);
      if (!fe || !te || fe === te) continue;
      const a = anchor(fe), b = anchor(te);
      const bulge = Math.min(arrowGutter() - 8, 20 + Math.abs(b.y - a.y) * 0.09);
      const cpX = right ? Math.min(a.x + bulge, area.clientWidth - 6) : Math.max(a.x - bulge, 6);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' C ' + cpX + ' ' + a.y + ', ' + cpX + ' ' + b.y + ', ' + b.x + ' ' + b.y);
      p.setAttribute('stroke', '#4fc1ff'); p.setAttribute('stroke-width', '1.4'); p.setAttribute('fill', 'none');
      p.setAttribute('opacity', '0.55'); p.setAttribute('marker-end', 'url(#ov-head)');
      svg.appendChild(p);
    }
  }
  window.addEventListener('resize', drawOverviewArrows);

  // AI_NOTE: #3 プロジェクトの参照: import関係(out=橙/in=ティール)を強調し、関連外ファイルを暗くする
  function onProjRefClick(event, nodeId) {
    const area = document.getElementById('proj-area');
    document.querySelectorAll('.pfile.ref-self,.pfile.ref-out,.pfile.ref-in').forEach(c => c.classList.remove('ref-self','ref-out','ref-in'));
    document.querySelectorAll('#proj-area .ref-btn.active').forEach(b => b.classList.remove('active'));
    if (activeProjRefId === nodeId) { activeProjRefId = null; if (area) area.classList.remove('ref-active'); drawProjectArrows(); return; }
    activeProjRefId = nodeId;
    event.currentTarget.classList.add('active');
    if (area) area.classList.add('ref-active');
    const self = document.querySelector('.pfile[data-id="' + nodeId + '"]'); if (self) self.classList.add('ref-self');
    for (const e of PROJ_EDGES) {
      if (e.from === nodeId) { const c = document.querySelector('.pfile[data-id="' + e.to + '"]'); if (c) c.classList.add('ref-out'); }
      if (e.to === nodeId) { const c = document.querySelector('.pfile[data-id="' + e.from + '"]'); if (c) c.classList.add('ref-in'); }
    }
    drawProjectArrows();
  }
  // AI_NOTE: バグ③ 未処理かつ「可視」の .mermaid だけ描画する。
  //   - 処理済み(data-processed)を再パースすると Syntax error になるので除外。
  //   - display:none のペイン(offsetParent===null)で描画すると mermaid が寸法を測れず
  //     "Syntax error in text" SVG を書き込んで data-processed を立ててしまう。標準タブが
  //     隠れている間(チャット中のHTML再生成など)に描画すると、標準に戻ってもエラーSVGが残る。
  //     可視になってから描画すればよいので、隠れている要素はスキップ(activate時に再度呼ばれる)。
  let mermaidInited = false;
  function renderMermaid() {
    if (!window.mermaid) return;
    if (!mermaidInited) { mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' }); mermaidInited = true; }
    const els = Array.prototype.slice.call(document.querySelectorAll('.mermaid'))
      .filter(function(e){ return e.getAttribute('data-processed') !== 'true' && e.offsetParent !== null; });
    if (els.length) { try { mermaid.init(undefined, els); } catch (e) { console.error('mermaid render failed', e); } }
  }

  // AI_NOTE: ② 単一関数フロー図(mermaid)の拡大縮小。SVGの実幅(baseW)を1度だけ記録し、scale倍して
  // 幅を上書きする(transform:scaleだと親のscrollWidthが変わらずスクロールできないため width で拡げる)。
  // 図はドリルインの度に新HTMLで再生成されるので fcScale は自然に1へ戻る。
  let fcScale = 1;
  function fcMermaidSvg() {
    var m = document.querySelector('.pane[data-pane="standard"] .mermaid');
    return m ? m.querySelector('svg') : null;
  }
  function fcApplyZoom() {
    var svg = fcMermaidSvg(); if (!svg) return;
    if (!svg.dataset.baseW) { svg.dataset.baseW = String(svg.getBoundingClientRect().width || svg.clientWidth || 0); }
    var base = parseFloat(svg.dataset.baseW) || 0;
    svg.style.maxWidth = 'none';
    svg.style.width = base ? (base * fcScale) + 'px' : (fcScale * 100) + '%';
    svg.style.height = 'auto';
    var lbl = document.getElementById('fc-zoom-lbl');
    if (lbl) lbl.textContent = Math.round(fcScale * 100) + '%';
  }
  function fcZoom(d) {
    fcScale = Math.min(3, Math.max(0.4, Math.round((fcScale + d) * 100) / 100));
    fcApplyZoom();
  }
  function fcZoomReset() { fcScale = 1; fcApplyZoom(); }

  // AI_NOTE: タブは全て #tabbar に置き、幅に収まらない分だけ ⋯ メニューへ動的に退避する(reflowTabs)。
  // 以前の「後半3つを固定で⋯」を廃し、パネル幅に応じて出し入れする(幅に余裕がある間は全部タブ表示)。
  const moreWrap = document.getElementById('tab-more-wrap');
  const moreBtn = document.getElementById('tab-more');
  const moreMenu = document.getElementById('tab-more-menu');
  const tabbar = document.getElementById('tabbar');

  // AI_NOTE: アクティブタブが⋯へ退避中なら⋯ボタンに「⋯ 設定」と現在地を出し、見失わせない。
  function updateMoreBtnLabel() {
    const active = document.querySelector('.tab[data-tab].active');
    const hidden = active && active.style.display === 'none';
    moreBtn.textContent = hidden ? '⋯ ' + active.textContent : '⋯';
    moreBtn.classList.toggle('active', !!hidden);
  }

  // AI_NOTE: 幅測定でタブを出し入れ。全タブを自然幅で測り(⋯は一旦隠す)、収まればそのまま。あふれたら⋯を出し、
  // その幅を引いた予算で先頭から詰め、あふれた1個目以降は全部⋯へ回す(優先順=先頭を残す)。
  function reflowTabs() {
    const tabs = Array.from(document.querySelectorAll('.tab[data-tab]'));
    tabs.forEach(t => { t.style.display = ''; });
    moreWrap.style.display = 'none';
    // 再配置で中身を作り直すので、開いたままだと空メニューが宙に残る(fixed)。閉じてから詰め直す。
    moreMenu.classList.remove('open');
    moreMenu.innerHTML = '';
    const cs = getComputedStyle(tabbar);
    const gap = parseFloat(cs.gap) || 0;
    const avail = tabbar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let total = 0;
    tabs.forEach((t, i) => { total += t.offsetWidth + (i ? gap : 0); });
    if (total <= avail) { updateMoreBtnLabel(); return; }
    moreWrap.style.display = '';
    const budget = avail - moreWrap.offsetWidth - gap;
    let used = 0, over = false;
    tabs.forEach(t => {
      if (!over) {
        const w = t.offsetWidth + (used ? gap : 0);
        if (used + w <= budget) { used += w; return; }
        over = true;
      }
      t.style.display = 'none';
      const item = document.createElement('button');
      item.className = 'tab-menu-item' + (t.classList.contains('active') ? ' active' : '');
      item.dataset.tab = t.dataset.tab;
      item.textContent = t.textContent;
      item.addEventListener('click', (e) => { e.stopPropagation(); moreMenu.classList.remove('open'); activate(t.dataset.tab); });
      moreMenu.appendChild(item);
    });
    updateMoreBtnLabel();
  }

  const forcedInitialTab = ${JSON.stringify(this.initialTabOverride)};
  const prev = vscode.getState();
  if (forcedInitialTab) activate(forcedInitialTab);
  else if (prev && prev.tab) activate(prev.tab);
  function activate(tabId) {
    document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-menu-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tabId));
    updateMoreBtnLabel();
    // AI_NOTE: stateはtab以外(chatDraft等)も持つようになったため、マージして既存キーを潰さない
    vscode.setState({ ...(vscode.getState()||{}), tab: tabId });
    // 隠れていた標準タブのmermaid/矢印が未描画なら、表示時に描画する(幅確定後に呼ぶ必要があるため)
    if (tabId === 'standard') { renderMermaid(); drawCallArrows(); }
    if (tabId === 'overview') drawOverviewArrows();
    if (tabId === 'project') { drawProjectArrows(); vscode.postMessage({type:'ensureProject'}); }
    if (tabId === 'process') vscode.postMessage({type:'ensureProject'});
  }
  document.querySelectorAll('.tab[data-tab]').forEach(btn => btn.addEventListener('click', () => activate(btn.dataset.tab)));
  // AI_NOTE: メニューはfixedなので、開く度に⋯ボタンの直下へ実座標で置く(右端揃え・左は0未満にしない)。
  function openMoreMenu() {
    const r = moreBtn.getBoundingClientRect();
    moreMenu.classList.add('open');
    moreMenu.style.top = r.bottom + 'px';
    moreMenu.style.left = Math.max(2, r.right - moreMenu.offsetWidth) + 'px';
  }
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moreMenu.classList.contains('open')) moreMenu.classList.remove('open'); else openMoreMenu();
  });
  // メニュー外クリックで閉じる
  document.addEventListener('click', () => moreMenu.classList.remove('open'));
  // AI_NOTE: 初回＋パネル幅変化で再配置。子のdisplay変更はtabbar幅を変えないので無限ループしない。ResizeObserver未対応環境はresizeで代替。
  if (window.ResizeObserver) { new ResizeObserver(reflowTabs).observe(tabbar); } else { reflowTabs(); window.addEventListener('resize', reflowTabs); }

  // AI_NOTE: グループ折り畳み。概要・標準で共有(標準クラスカードも .group-block を使う)。
  // 畳み状態で端点/位置が変わるので両タブの矢印を引き直す(各drawは対象area無しなら早期return)
  function toggleGroup(groupEl) {
    const body = groupEl.querySelector('.group-body');
    const toggle = groupEl.querySelector('.grp-toggle');
    const collapsed = body.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▶' : '▼';
    drawOverviewArrows();
    drawCallArrows();
  }
  // AI_NOTE: トレースタブの関数チェックリスト操作。チェック済みの関数名だけを拡張側へ送る(空なら拡張側が警告を出す)
  function traceRunSelected() {
    const funcs = Array.from(document.querySelectorAll('.trace-func')).filter(c => c.checked).map(c => c.value);
    vscode.postMessage({ type: 'traceRunMulti', funcs: funcs });
  }
  function traceCheckAll(on) {
    document.querySelectorAll('.trace-func').forEach(c => { c.checked = on; });
  }
  function expandAll() {
    document.querySelectorAll('.group-body').forEach(b => { b.classList.remove('collapsed'); b.closest('.group-block').querySelector('.grp-toggle').textContent = '▼'; });
    drawOverviewArrows();
  }
  function collapseAll() {
    document.querySelectorAll('.group-body').forEach(b => { b.classList.add('collapsed'); b.closest('.group-block').querySelector('.grp-toggle').textContent = '▶'; });
    drawOverviewArrows();
  }

  // AI_NOTE: 参照ボタン。同ノード再クリックで解除。呼び出し関係のカードを色分け強調(矢印は出さない=narrow+#5)
  function clearRef() {
    document.querySelectorAll('.ref-self,.ref-out,.ref-in').forEach(c => c.classList.remove('ref-self','ref-out','ref-in'));
    document.querySelectorAll('.ref-btn.active').forEach(b => b.classList.remove('active'));
    const area = document.getElementById('cards-area'); if (area) area.classList.remove('ref-active');
  }
  function onRefClick(event, nodeId) {
    if (activeRefNodeId === nodeId) { activeRefNodeId = null; clearRef(); drawCallArrows(); return; }
    clearRef();
    activeRefNodeId = nodeId;
    event.currentTarget.classList.add('active');
    // AI_NOTE: ② 関連しないカードを暗くするフラグ
    const area = document.getElementById('cards-area'); if (area) area.classList.add('ref-active');
    const self = document.querySelector('.card[data-id="' + nodeId + '"]');
    if (self) self.classList.add('ref-self');
    for (const e of REF_EDGES) {
      if (e.from === nodeId) { const c = document.querySelector('.card[data-id="' + e.to + '"]'); if (c) c.classList.add('ref-out'); }
      if (e.to === nodeId) { const c = document.querySelector('.card[data-id="' + e.from + '"]'); if (c) c.classList.add('ref-in'); }
    }
    drawCallArrows();
  }

  // AI_NOTE: ② カードのクリック。範囲展開モード(またはShift)なら範囲選択、通常はジャンプ(既存)＋選択解除。
  // モードはツールバー「▤ 範囲展開」で入る(発見性対策)。範囲は #cards-area 内の .card を DOM 順で anchor..クリックまで選ぶ。
  let rangeMode = false;
  let rangeAnchor = null;
  let rangeSelected = [];
  function cardEls() { return Array.prototype.slice.call(document.querySelectorAll('#cards-area .card')); }
  function toggleRangeMode() {
    rangeMode = !rangeMode;
    const btn = document.getElementById('range-mode-btn');
    const banner = document.getElementById('range-banner');
    if (btn) btn.classList.toggle('on', rangeMode);
    if (banner) banner.style.display = rangeMode ? 'flex' : 'none';
    clearRangeSel();
  }
  function onCardClick(event, id, ls, le) {
    if (rangeMode || event.shiftKey) { event.preventDefault(); rangeSelect(id); return; }
    clearRangeSel();
    vscode.postMessage({ type: 'nodeClick', lineStart: ls, lineEnd: le });
  }
  function rangeSelect(id) {
    const cards = cardEls();
    const ids = cards.map(function(c){ return c.getAttribute('data-id'); });
    if (rangeAnchor === null || ids.indexOf(rangeAnchor) === -1) rangeAnchor = id;
    const i1 = ids.indexOf(rangeAnchor), i2 = ids.indexOf(id);
    if (i1 === -1 || i2 === -1) return;
    const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
    cards.forEach(function(c){ c.classList.remove('range-sel'); });
    rangeSelected = [];
    for (let i = lo; i <= hi; i++) { cards[i].classList.add('range-sel'); rangeSelected.push(ids[i]); }
    updateRangeBar();
  }
  function clearRangeSel() {
    rangeAnchor = null; rangeSelected = [];
    cardEls().forEach(function(c){ c.classList.remove('range-sel'); });
    updateRangeBar();
  }
  // AI_NOTE: 選択中の展開可能カード数でバナーの「実行 (N)」を更新する。件数の実体は run ボタンの dataset に持つ。
  function updateRangeBar() {
    const run = document.getElementById('range-run-btn'); if (!run) return;
    const cards = cardEls();
    const expandable = rangeSelected.filter(function(id){
      const c = cards.find(function(x){ return x.getAttribute('data-id') === id; });
      return c && c.getAttribute('data-exp') === '1';
    });
    run.textContent = '実行 (' + expandable.length + ')';
    run.disabled = expandable.length === 0;
    run.dataset.ids = JSON.stringify(expandable);
  }
  function doExpandRange() {
    const run = document.getElementById('range-run-btn');
    const ids = run && run.dataset.ids ? JSON.parse(run.dataset.ids) : [];
    if (ids.length) vscode.postMessage({ type: 'expandRange', ids: ids });
    clearRangeSel();
  }

  renderMermaid();
  drawCallArrows();
  drawProjectArrows();
  drawOverviewArrows();

  // AI_NOTE: エディタのカーソルに対応するカードを強調する(拡張側から highlightCard を受信)
  // AI_NOTE: 直前のエディタ選択のコード+場所参照。チャット欄への貼り付けがこれと一致したら引用チップに変換する。
  // 場所参照はpaste時にチップラベルを組み立てる(拡張のquoteLabel()と同じ書式をJS側に再現し、html再生成無しで正確な表記にする)ために持つ。
  let quoteCand = null;
  let quoteCandMeta = null;
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'quoteCandidate') {
      quoteCand = e.data.code || null;
      quoteCandMeta = { fileName: e.data.fileName, lineStart: e.data.lineStart, lineEnd: e.data.lineEnd };
      return;
    }
    if (e.data && (e.data.type === 'highlightCard' || e.data.type === 'focusStandardCard')) {
      document.querySelectorAll('#cards-area [data-id].hl').forEach(c => c.classList.remove('hl'));
      if (e.data.nodeId) {
        const card = document.querySelector('#cards-area [data-id="' + e.data.nodeId + '"]');
        if (card) {
          card.classList.add('hl');
          if (e.data.type === 'focusStandardCard') {
            let collapsed = card.closest('.group-body.collapsed');
            while (collapsed) {
              toggleGroup(collapsed.closest('.group-block'));
              collapsed = card.closest('.group-body.collapsed');
            }
            card.scrollIntoView({ block: 'center', behavior: e.data.instant ? 'auto' : 'smooth' });
          }
        }
      }
    } else if (e.data && e.data.type === 'activateTab' && e.data.tab) {
      activate(e.data.tab);
    } else if (e.data && e.data.type === 'awaitingState') {
      // AI_NOTE: 選択待ちモードの切替を JS のみで反映(全HTML再生成を避けてレスポンス改善)
      const btn = document.getElementById('ann-sel-btn');
      const banner = document.getElementById('ann-await-banner');
      if (btn) {
        const on = !!e.data.on;
        btn.classList.toggle('awaiting', on);
        btn.textContent = on ? '✕ キャンセル' : '範囲を解析';
        btn.title = on ? 'クリックでキャンセル' : '選択中ならその範囲を解析。未選択で押すと選択モードに入り、ドラッグで範囲を決めると自動実行';
      }
      if (banner) banner.style.display = e.data.on ? 'block' : 'none';
    } else if (e.data && e.data.type === 'traceStatus') {
      // AI_NOTE: トレースタブの状態行だけ更新(HTML全再描画はタブ位置を巻き戻すので避ける)
      const ts = document.getElementById('trace-status');
      if (ts) ts.textContent = e.data.text || '';
      // AI_NOTE: 周回ボタン行は行数がループ数で変わるのでHTMLごと差し替える(タブ位置は巻き戻さない)
      const tl = document.getElementById('trace-loops');
      if (tl) tl.innerHTML = e.data.loopsHtml || '';
    } else if (e.data && e.data.type === 'annCount') {
      // AI_NOTE: 件数バッジだけ更新(HTML全再描画を避けてボタンの完了フラッシュを潰さない)
      const s = document.getElementById('ann-status');
      if (s) s.textContent = e.data.count === 0
        ? '解説 0件 — 「生成 (全体)」または「範囲を解析」を押してください'
        : '名称 ' + e.data.count + '箇所' + (e.data.time ? ' ・ ' + e.data.time : '');
    } else if (e.data && (e.data.type === 'annBusy' || e.data.type === 'annResult')) {
      // AI_NOTE: 生成系ボタンの状態表示。which→対象ボタンを引く(run=生成全体 / regen=再生成 / sel=範囲を解析)
      const id = e.data.which === 'regen' ? 'ann-regen-btn' : e.data.which === 'sel' ? 'ann-sel-btn' : 'ann-run-btn';
      const b = document.getElementById(id);
      if (b) {
        if (e.data.type === 'annBusy') {
          // AI_NOTE: 生成中はスピナー＋無効化。元ラベルを dataset に退避して後で戻す
          if (!b.dataset.orig) b.dataset.orig = b.textContent;
          b.classList.add('busy'); b.disabled = true;
          b.innerHTML = '<span class="spin">⟳</span> 生成中…';
        } else {
          // AI_NOTE: 完了/表示済み=緑、失敗=赤を一瞬出してから元ラベルへ戻す。バッジ件数(解説 N件)は別経路で更新される
          b.classList.remove('busy'); b.disabled = false;
          const orig = b.dataset.orig || b.textContent;
          const st = e.data.status;
          const ok = st === 'generated' || st === 'cached';
          b.textContent = st === 'generated' ? ('✓ ' + e.data.count + '件')
            : st === 'cached' ? '✓ 表示済み'
            : st === 'empty' ? '⚠ 失敗' : '⚠ エラー';
          b.classList.add(ok ? 'flash-ok' : 'flash-err');
          setTimeout(() => { b.classList.remove('flash-ok', 'flash-err'); b.textContent = orig; delete b.dataset.orig; }, ok ? 1200 : 1700);
        }
      }
    } else if (e.data && e.data.type === 'oauthVerifyResult') {
      // AI_NOTE: トークン確認結果を #oauth-verify に表示。ok=true→緑/false→赤/null→既定色
      const el = document.getElementById('oauth-verify');
      if (el) { el.textContent = e.data.text || ''; el.className = 'snote ' + (e.data.ok === true ? 'ok' : e.data.ok === false ? 'warn' : ''); }
    }
  });

  // AI_NOTE: 全ボタン共通の押下フィードバック。クリックで .btn-pulse を一瞬付ける。
  // 何も視覚変化が起きない操作でも「押された」が必ず伝わるようにする(委譲なので再描画後の新ボタンにも効く)。
  document.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn) return;
    btn.classList.remove('btn-pulse');
    void btn.offsetWidth; // reflow で連打時もアニメを再発火させる
    btn.classList.add('btn-pulse');
    setTimeout(() => btn.classList.remove('btn-pulse'), 360);
  });

  // AI_NOTE: チャット履歴の✎/🗑。webviewのpromptはVS Codeで使えないため、postMessage で input/確認を拡張側に委ねる
  function chatRename(id, currentTitle) {
    vscode.postMessage({ type: 'chatRename', text: id, label: currentTitle });
  }
  function chatDelete(id, currentTitle) {
    vscode.postMessage({ type: 'chatDelete', text: id, label: currentTitle });
  }

  // AI_NOTE: マウス選択に加えて各吹き出しを一発でコピーできる導線を置く。innerTextを使い、Markdown記号ではなく画面で読める本文をコピーする。
  function copyChatMessage(event, button) {
    event.stopPropagation();
    const body = button.closest('.cmsg').querySelector('.cmsg-body');
    if (!body) return;
    vscode.postMessage({ type: 'copyChatMessage', text: body.innerText });
    button.textContent = 'コピー済み';
    setTimeout(() => { button.textContent = 'コピー'; }, 1200);
  }

  // AI_NOTE: チャット入力。#1 日本語IME変換中のEnter(確定)では送信しない(compositionstart/end)
  // ⑤→Cursor風にcontenteditable化。引用チップは文中にインラインアトムとして埋め込み、番号は
  // 「現存チップの左からの並び順」で常に1..kへ振り直す(削除・挿入で欠番/重複が出ないようにする)。
  const cinput = document.getElementById('cinput');
  const csend = document.getElementById('csend');
  const cmsgs = document.getElementById('cmsgs');
  if (cmsgs) cmsgs.scrollTop = cmsgs.scrollHeight;

  // AI_NOTE: 拡張側 quoteLabel() と同じ書式をJS側に再現する(paste直後はhtml再生成無しでチップを作るため、
  // サーバ生成のescape済みラベルが届いていない。素材(quoteCandMeta)から自前で組み立てる)。
  function jsEscapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function quoteCandLabel(n) {
    const file = jsEscapeHtml((quoteCandMeta && quoteCandMeta.fileName) || 'コード片');
    const ls = quoteCandMeta && quoteCandMeta.lineStart;
    const le = quoteCandMeta && quoteCandMeta.lineEnd;
    if (ls == null) return '引用' + n + ' ' + file;
    if (ls === le) return '引用' + n + ' ' + file + ' L' + ls + ' 「' + jsEscapeHtml(quoteCand.replace(/\\n/g, ' ').trim().slice(0, 20)) + '」';
    return '引用' + n + ' ' + file + ' L' + ls + '-' + le;
  }

  // AI_NOTE: チップ1個ぶんのDOM片。ラベルHTMLはquoteLabel()相当(escape済み)のものをそのまま挿す。
  function makeChip(n, labelHtml) {
    const chip = document.createElement('span');
    chip.className = 'quote-chip';
    chip.contentEditable = 'false';
    chip.dataset.qi = String(n);
    chip.innerHTML = '<span class="qc-loc">' + labelHtml + '</span><button class="qc-x" title="この引用を外す">×</button>';
    return chip;
  }

  // AI_NOTE: #cinputのDOMを送信用プレーンテキストへ変換する。チップは(引用N)というプレースホルダに戻し、
  // 拡張側は無変更のまま(pending contextsを添付=renderUserContentが同じ番号で再度チップ化して表示する)。
  function serialize() {
    let out = '';
    if (!cinput) return out;
    cinput.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
      else if (node.classList && node.classList.contains('quote-chip')) out += '(引用' + node.dataset.qi + ')';
      else if (node.tagName === 'BR') out += '\\n';
      else out += node.textContent;
    });
    // AI_NOTE: キャレット置き場のゼロ幅スペース(チップ挿入時に足す)は送信テキストから除去する
    return out.replace(/\\u200B/g, '').trim();
  }

  function saveDraft() {
    if (!cinput) return;
    vscode.setState({ ...(vscode.getState()||{}), chatDraftHtml: cinput.innerHTML });
  }

  // AI_NOTE: チップ削除・整合のたびに呼ぶ。現存チップを左から1..kへ振り直し(data-qi・ラベル先頭の「引用N」表記を書き換え)、
  // 消えた元番号は拡張側contextsからも大きい順にspliceさせる(小さい順だと後続のindexがずれて誤削除する)。
  // pendingQuotes.length はローカルカウンタとして減算していく(拡張側はhtml再生成しないため件数を追い直す唯一の場所)。
  function reconcileQuotes() {
    if (!cinput) return;
    const chips = Array.prototype.slice.call(cinput.querySelectorAll('.quote-chip'));
    const kept = new Set(chips.map(c => Number(c.dataset.qi)));
    for (let qi = pendingQuotes.length; qi >= 1; qi--) {
      if (!kept.has(qi)) { vscode.postMessage({ type: 'chatClearQuote', text: String(qi - 1) }); pendingQuotes.splice(qi - 1, 1); }
    }
    chips.forEach((chip, idx) => {
      const n = idx + 1;
      chip.dataset.qi = String(n);
      const loc = chip.querySelector('.qc-loc');
      if (loc) loc.textContent = loc.textContent.replace(/^引用\\d+/, '引用' + n);
    });
    saveDraft();
  }

  // AI_NOTE: 通常の貼り付けとShift+Enterは execCommand('insertText') に依存させない。
  // VS Code Webviewではpasteイベント中のexecCommandが成功扱いでも文字が入らない実測があるため、Rangeへテキストノードを直接挿す。
  function insertTextAtCaret(text) {
    if (!cinput || !text) return;
    const node = document.createTextNode(text);
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && cinput.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      cinput.appendChild(node);
    }
    cinput.focus();
    reconcileQuotes();
  }

  function sendChat() {
    if (!cinput) return;
    const t = serialize();
    if (!t) return;
    cinput.innerHTML = '';
    vscode.postMessage({ type: 'chatSend', text: t });
    // AI_NOTE: 送信済みの下書きはstateから消す（次のhtml再設定で復元されないように）
    vscode.setState({ ...(vscode.getState()||{}), chatDraftHtml: '' });
  }
  // AI_NOTE: 送信ボタンは考え中の間だけ「中止」に変わる(data-mode=stop)。同じ#csendを使い回し、モードで送信/中止を分岐。
  // 常時DOMに存在するので張り直しの取りこぼしが無い（考え中の一瞬だけ出る別ボタンだとwiring漏れの恐れがあった）。
  if (csend) csend.addEventListener('click', () => {
    if (csend.dataset.mode === 'stop') vscode.postMessage({ type: 'chatStop' });
    else sendChat();
  });
  // AI_NOTE: 「+新規チャット」。chatNewは拡張側がhtml全体を作り直すため、パルスはstate経由の1回フラグで再生する
  // (押下時に立て、再構築後の初期化で入力欄を光らせて消す)。既に新規状態でも視覚反応が出るので「押しても何も起きない」を防ぐ。
  const cnew = document.getElementById('cnew');
  if (cnew) cnew.addEventListener('click', () => {
    vscode.setState({ ...(vscode.getState() || {}), pulseInput: true });
    vscode.postMessage({ type: 'chatNew' });
  });
  if (cinput) {
    // AI_NOTE: thinking終了時のhtml再設定で入力途中のテキストが消えるため、下書きをwebview stateへ退避し初期化時に復元する
    const st = vscode.getState() || {};
    if (st.chatDraftHtml) cinput.innerHTML = st.chatDraftHtml;
    // AI_NOTE: 復元後の整合。ホバー「質問する」経由などhtml再生成をまたいだpending引用は入力欄内に無いため末尾へ追記し、
    // 逆に(下書きが古い等で)存在しない番号を指すチップは除去する。
    const have = new Set(Array.prototype.map.call(cinput.querySelectorAll('.quote-chip'), c => Number(c.dataset.qi)));
    cinput.querySelectorAll('.quote-chip').forEach(c => { if (Number(c.dataset.qi) > pendingQuotes.length) c.remove(); });
    for (let qi = 1; qi <= pendingQuotes.length; qi++) {
      if (!have.has(qi)) cinput.appendChild(makeChip(qi, pendingQuotes[qi - 1]));
    }
    let composing = false;
    cinput.addEventListener('compositionstart', () => { composing = true; });
    cinput.addEventListener('compositionend', () => { composing = false; });
    // AI_NOTE: Backspace/Deleteでチップが消えた時も×と同じ整合(拡張側contexts削除+番号振り直し)を通す。
    // reconcileQuotesは末尾でsaveDraftするので、通常入力の下書き保存も兼ねる。
    cinput.addEventListener('input', reconcileQuotes);
    cinput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !composing) { e.preventDefault(); sendChat(); return; }
      // AI_NOTE: このテンプレート内では改行等のエスケープは二重バックスラッシュで書く(TS側が先に解釈すると
      // webviewに生の改行が届いて文字列リテラルが割れ、スクリプト全滅=全ボタン無反応になる。実際に発生した)
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insertTextAtCaret('\\n'); }
    });
    // AI_NOTE: ×ボタンはチップ生成のたびにリスナーを付け直さず、#cinputへのクリック委譲1本にまとめる。
    cinput.addEventListener('click', e => {
      const x = e.target && e.target.closest ? e.target.closest('.qc-x') : null;
      if (!x) return;
      const chip = x.closest('.quote-chip');
      if (chip) { chip.remove(); reconcileQuotes(); }
    });
    // AI_NOTE: エディタでコピーした範囲をチャット欄に貼ると引用チップに変換する（Cursor風）。
    // 貼り付けテキストが直前のエディタ選択(quoteCand)と一致した時だけ生貼りを止め、生コードの代わりに
    // キャレット位置へチップ要素を直接挿入する。不一致時もHTML混入を避けるためプレーンテキストとして挿入する。
    cinput.addEventListener('paste', e => {
      e.preventDefault();
      const cd = e.clipboardData || window.clipboardData;
      const txt = cd ? cd.getData('text') : '';
      if (txt && quoteCand && txt.trim() === quoteCand.trim()) {
        const n = cinput.querySelectorAll('.quote-chip').length + 1;
        const chip = makeChip(n, quoteCandLabel(n));
        // AI_NOTE: contenteditable=false要素の直後はキャレットを置けず「クリックし直すまで打てない」状態になるため、
        // チップの後ろにゼロ幅スペースのテキストノードを挿し、その後ろへキャレットを置く(serializeで除去する)。
        const pad = document.createTextNode('\\u200B');
        const sel = document.getSelection();
        if (sel && sel.rangeCount > 0 && cinput.contains(sel.anchorNode)) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(chip);
          chip.after(pad);
          range.setStartAfter(pad);
          range.setEndAfter(pad);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          cinput.appendChild(chip);
          cinput.appendChild(pad);
        }
        cinput.focus();
        pendingQuotes.push(quoteCandLabel(n)); // AI_NOTE: reconcileQuotesのローカルカウンタ(pendingQuotes.length)と実チップ数を一致させる
        saveDraft();
        vscode.postMessage({ type: 'quoteSelectionPasted' });
      } else {
        insertTextAtCaret(txt);
      }
    });
    cinput.focus();
    // AI_NOTE: 新規チャット押下フラグが立っていれば入力欄をパルスさせて視線誘導し、フラグは即消す(1回きり)。
    const st3 = vscode.getState() || {};
    if (st3.pulseInput) {
      vscode.setState({ ...st3, pulseInput: false });
      const box = document.getElementById('cinput-box');
      if (box) { box.classList.remove('attn'); void box.offsetWidth; box.classList.add('attn'); }
    }
  }
  // AI_NOTE: webview再生成後に引用候補を復元（貼り付け一致判定用のコードを拡張へ要求）
  vscode.postMessage({ type: 'requestQuoteCandidate' });
  // AI_NOTE: 受信listenerを含む初期化がすべて終わってからreadyを返す。拡張からの初期強調メッセージを取りこぼさない。
  vscode.postMessage({type:'webviewReady'});

</script>
</body>
</html>`;
    }

    // AI_NOTE: 概要グループの永続キャッシュキー。旧FlowchartPanelと同じ(内容のみ・globalContext非依存)で共有する
    private coarseKey(source: string): string {
        return `coarse::${fnv1a(source)}`;
    }

    // AI_NOTE: 展開ブロック分解の永続キャッシュキー(旧パネルと共有)。説明文を含むのでglobalContextもキーに入れる。
    // AI_NOTE: v1は無検証な行範囲(文途中切断あり)を含む不良キャッシュのため、AST検証層導入に合わせてv2で無効化した。
    // v3は関数専用の目的/入力/出力だった。クラス用の役割/状態/機能を追加したためv4で旧キャッシュを無効化する。
    private expandKey(nodeId: string, source: string): string {
        const ctx = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("globalContext", "");
        return `expandv5::${fnv1a(ctx + "\0" + source)}::${nodeId}`;
    }

    // AI_NOTE: カードの▶トグル。展開中なら畳む。未展開ならキャッシュ→無ければLLMで分解し永続保存して再描画。
    // AI_NOTE: webview再描画とエディタ背景塗りを必ずセットで行う。展開状態が変わると
    // サブブロック色も塗り直す必要があるため、両者を1メソッドに束ねて塗り忘れを防ぐ。
    private rerender(): void {
        if (this.view) this.view.webview.html = this.buildHtml();
        this.applyDecorations();
    }

    private async toggleExpand(nodeId: string, lineStart: number, lineEnd: number, label: string): Promise<void> {
        // AI_NOTE: 背景と同じ区切りに説明だけ追加し、編集中の古い応答は表示へ反映しない。
        if (!this.currentDoc || !this.view) return;
        if (this.expandedData[nodeId]) {
            delete this.expandedData[nodeId];
            this.staleExpansions.delete(nodeId);
            this.rerender();
            return;
        }
        const document = this.currentDoc;
        const source = document.getText();
        const ticket = Symbol(nodeId);
        this.expansionTickets.set(nodeId, ticket);
        this.expandedData[nodeId] = { overview: null, blocks: [] };
        this.staleExpansions.delete(nodeId);
        this.expandGenerating.add(nodeId);
        this.rerender();
        const current = () => document.getText() === source
            && this.currentDoc?.uri.toString() === document.uri.toString()
            && this.expansionTickets.get(nodeId) === ticket;
        try {
            const { graph, spans } = await this.parseSource(source);
            if (graph.error) throw new Error(graph.error);
            const nodes = graph.backgroundNodes ?? graph.nodes;
            const result = await this.backgroundService.details(document.uri.toString(), source, nodes, spans, nodeId, current);
            if (!current()) return;
            this.expandedData[nodeId] = result;
            this.expandedSources.set(nodeId, source.split("\n").slice(lineStart, lineEnd + 1).join("\n"));
            this.meaningRanges = this.colorBackgrounds(this.backgroundService.peek(document.uri.toString(), source, nodes), nodes);
        } catch (error) {
            if (current()) {
                this.expandedData[nodeId] = { overview: null, blocks: [] };
                console.error("[AI Code Guide] detail:", error);
            }
        } finally {
            if (this.expansionTickets.get(nodeId) === ticket) {
                this.expandGenerating.delete(nodeId);
                this.expansionTickets.delete(nodeId);
                this.rerender();
            }
        }
    }

    // AI_NOTE: 標準タブの「▼全て」。展開可能(関数/クラス/block)かつ未展開のカードを順にLLM分解する。
    // toggleExpand を順に await するので開いた順にカードが増え、進捗が見える(キャッシュ済みは即時)。
    // 件数分だけAPIを呼びトークンを消費するため、走らせる前にモーダルで件数を見せて確認を取る。
    private async expandAllCards(): Promise<void> {
        if (!this.currentDoc || !this.view) return;
        const targets = this.graphNodes.filter(
            (n) => (n.kind === "function" || n.kind === "class" || n.kind === "block") && !this.expandedData[n.id]
        );
        if (targets.length === 0) return;
        const ok = await vscode.window.showInformationMessage(
            `${targets.length}個のカードをAIで分解します（トークンを消費します）。実行しますか？`,
            { modal: true }, "実行"
        );
        if (ok !== "実行") return;
        for (const n of targets) await this.toggleExpand(n.id, n.lineStart, n.lineEnd, n.label);
    }

    // AI_NOTE: ② サイドバーで範囲選択したカードのうち、展開可能(関数/クラス/block)かつ未展開だけを順に分解する。
    // ▼全てと同じく件数をモーダルで見せてから実行(トークン消費のため)。expandAllCards と対象集合だけ違う。
    private async expandRange(ids: string[]): Promise<void> {
        if (!this.currentDoc || !this.view) return;
        const idset = new Set(ids);
        const targets = this.graphNodes.filter(
            (n) => idset.has(n.id) && (n.kind === "function" || n.kind === "class" || n.kind === "block") && !this.expandedData[n.id]
        );
        if (targets.length === 0) return;
        const ok = await vscode.window.showInformationMessage(
            `選択した${targets.length}個のカードをAIで分解します（トークンを消費します）。実行しますか？`,
            { modal: true }, "実行"
        );
        if (ok !== "実行") return;
        for (const n of targets) await this.toggleExpand(n.id, n.lineStart, n.lineEnd, n.label);
    }

    // AI_NOTE: 「概要を生成」押下時。LLMに関数一覧を渡して意味的グループを作り、永続キャッシュへ保存して再描画する
    private async generateGroups(): Promise<void> {
        if (this.groupGenerating || !this.currentDoc || !this.view) return;
        const source = this.currentDoc.getText();
        this.groupGenerating = true;
        this.view.webview.html = this.buildHtml();
        try {
            const groups = await generateModuleGroups(
                // AI_NOTE: 概要グループはトップレベル(関数/クラス)単位。メソッドは標準ビューの階層側で見せるため概要には流さない
                this.graphNodes
                    .filter((n) => !n.parent)
                    .map((n) => ({ id: n.id, label: n.label, kind: n.kind, lineStart: n.lineStart, lineEnd: n.lineEnd }))
            );
            if (groups.length > 0) {
                this.coarseGroups = groups;
                this.llmCache.set(this.coarseKey(source), groups);
            }
        } finally {
            this.groupGenerating = false;
            if (this.view) this.view.webview.html = this.buildHtml();
        }
    }

    // AI_NOTE: 外部AIの「概要を生成」は、ファイル役割と意味グループだけを揃える。
    // 標準カード説明は別目的なので生成せず、最小のLLM利用に留める。
    private async generateAgentOverview(): Promise<void> {
        await this.ensureFileOverview();
        if (!this.coarseGroups) await this.generateGroups();
        if (this.view) this.view.webview.html = this.buildHtml();
    }

    // AI_NOTE: 概要タブ本体。グループ未生成なら生成ボタン、生成済みならグループ見出し+所属カードを描く。
    private buildOverviewPane(): string {
        if (!this.currentDoc) {
            return `<div class="msg">Python・JavaScript・TypeScriptファイルを開くと概要を表示します</div>`;
        }
        if (this.groupGenerating) {
            return `<div class="msg">概要グループを生成中…</div>`;
        }
        // AI_NOTE: 設計フェーズ1・ステップ3前半。ファイル粒度の設計情報(目的/検証警告)は
        // グループ生成前でも見えるべきなので、この2分岐の両方に差し込む。
        const design = this.currentDesign();
        const designFileRelPath = this.currentFileRelPath();
        if (!this.coarseGroups) {
            return `${this.buildFileHeader()}${this.buildDesignFileBlock(design, designFileRelPath)}<div class="msg">関数を意味のまとまりにグループ化します（AI・トークン消費）。</div>
              <div style="text-align:center;margin-top:10px;"><button class="tbtn on" onclick="vscode.postMessage({type:'generateGroups'})">概要を生成</button></div>`;
        }
        // AI_NOTE: 旧概要ビューと同じ。グループ(メイン)=group-block、▼トグルで関数(サブ)=inner-cardを開閉。
        // グループ分けの基準は generateModuleGroups(LLM)。関数ラベルはAI説明があれば置換(cardLabel)。
        const byId = new Map(this.graphNodes.map((n) => [n.id, n]));
        // AI_NOTE: ▼/▶全ては既存。矢印ボタンを追加=概要の呼び出し矢印ON/OFF(標準と同じトグル思想)
        const toolbar = `<div id="toolbar">
          <button class="tbtn" onclick="expandAll()">▼全て</button>
          <button class="tbtn" onclick="collapseAll()">▶全て</button>
          <button class="tbtn${this.overviewArrows ? " on" : ""}" onclick="vscode.postMessage({type:'toggleOverviewArrows'})" title="呼び出し関係の矢印を表示/非表示。畳んだグループはメイン、開いた関数はサブを指す">矢印: ${this.overviewArrows ? "ON" : "OFF"}</button>
        </div>`;
        // AI_NOTE: 矢印ON時のみSVGオーバーレイ。drawOverviewArrowsが各エッジを最適な可視要素へ引く
        const svg = this.overviewArrows
            ? `<svg id="ov-svg" xmlns="http://www.w3.org/2000/svg"><defs>
                 <marker id="ov-head" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4fc1ff"/></marker>
               </defs></svg>`
            : "";
        // AI_NOTE: 名前→設計シンボルの索引。関数名はクラス/関数で衝突しない前提(design mdの規約通り一意に書く運用)
        const designSymbolByName = new Map((design?.file.symbols ?? []).map((s) => [s.name, s]));
        const groups = this.coarseGroups
            .map((g) => {
                const fns = g.nodeIds
                    .map((id) => byId.get(id))
                    // AI_NOTE: クラスもkind="class"になったので概要に出るよう許可。メソッドはトップレベルでなく除外済み
                    .filter((n): n is GraphNode => !!n && (n.kind === "function" || n.kind === "class" || n.kind === "constant"));
                const accent = fns[0] ? (this.nodeColors.get(fns[0].id)?.color ?? colorFor(fns[0].kind)) : "#4fc1ff";
                // AI_NOTE: 概要サブ=関数。体裁を標準subcardに統一し縦積みにする:見出し(種別+関数名)→AI説明(あれば)。
                // 旧実装はkindとlabelをspanで横並びにしていて、幅が足りず変な改行が起きていた。行を分けて解消する。
                const inner = fns
                    .map((n) => {
                        const ov = this.descMap[n.id];
                        const name = n.label.split("(")[0];
                        const designRow = this.buildDesignSymbolRow(designSymbolByName.get(name), design?.issues ?? []);
                        return `<div class="inner-card" data-id="${escapeHtml(n.id)}" style="--accent:${this.nodeColors.get(n.id)?.color ?? colorFor(n.kind)}"
                      onclick="event.stopPropagation();vscode.postMessage({type:'nodeClick',lineStart:${n.lineStart},lineEnd:${n.lineEnd}})">
                      <div class="sublabel"><span class="kind">${tagFor(n.kind, n.label)}</span>${escapeHtml(name)}</div>
                      ${designRow}
                      ${ov ? `<div class="subdesc">${escapeHtml(ov).substring(0, 120)}</div>` : ""}
                    </div>`;
                    })
                    .join("");
                return `<div class="group-block" style="--accent:${accent}">
                  <div class="group-title" onclick="toggleGroup(this.closest('.group-block'))">
                    <span class="grp-toggle">▼</span>
                    <span class="grp-label">${escapeHtml(g.label)}</span>
                    <span class="grp-count">${fns.length}fn</span>
                  </div>
                  <div class="group-body">${inner}</div>
                </div>`;
            })
            .join("");
        // AI_NOTE: 矢印ON時はov-areaにarrows-on(+side-right)を付け、カードを片側に寄せて矢印の溝を作る
        const areaCls = `${this.overviewArrows ? "arrows-on" : ""}${this.arrowSide === "right" ? " side-right" : ""}`;
        // AI_NOTE: ツールバー→ファイル全体ヘッダー→本体の順。ヘッダーをボタンの下に置きたいという要望でtoolbarを先頭にした
        return `${toolbar}${this.buildFileHeader()}${this.buildDesignFileBlock(design, designFileRelPath)}<div id="ov-area" class="${areaCls}">${svg}${groups}</div>`;
    }

    // AI_NOTE: エディタで選択した任意範囲をチャットに「引用」する。生コードを直接貼らず、
    // 現在(なければ新規)セッションのpending引用(contexts)に場所参照付きで載せ、入力欄内にチップとして表示する。
    // html再生成はしない(webview側が自前でチップDOMを追記するため。再生成すると入力中の内容とレースする)。
    // AI_NOTE: revealChat=false は入力欄への貼り付け経路（既にチャットタブで入力中。revealするとフォーカスが
    // 奪われてキャレットが死ぬ）。エディタからのコマンド(⌘⌥Q/右クリック)経路だけ true でタブを前面化する。
    async quoteSelectionToChat(code: string, lineStart: number, lineEnd: number, revealChat = true): Promise<void> {
        const fileName = this.currentDoc?.fileName.split("/").pop() ?? "unknown";
        const session = this.ensureChatSession();
        if (!session) return;
        // AI_NOTE: 置き換えでなく追記。本文中の(引用N)はwebview側がその時点のチップ数から番号を採番するため、
        // ここでdedupすると採番した番号とcontexts配列のインデックスがずれる。重複でも常にpushして番号整合を保つ。
        session.contexts.push({ code, fileName, lineStart, lineEnd });
        this.chatStore.save();
        if (revealChat) await this.reveal("chat");
    }

    // AI_NOTE: ⑤ 現在のチャットセッションを取得。無ければ現在ファイルで新規作成する。
    private ensureChatSession(context?: ChatQuote): ChatSession | null {
        if (this.currentChatId) {
            const s = this.chatStore.get(this.currentChatId);
            if (s) return s;
        }
        const fileName = this.currentDoc?.fileName.split("/").pop() ?? "unknown";
        const s = this.chatStore.create(fileName, context);
        this.currentChatId = s.id;
        return s;
    }

    // AI_NOTE: 「質問する」(ホバー)から呼ばれる。引用コード付きの新規チャットを開いてチャットタブを前面化する。
    async openChatWithContext(code: string, explanation: string): Promise<void> {
        const s = this.chatStore.create(this.currentDoc?.fileName.split("/").pop() ?? "unknown", { code, explanation });
        this.currentChatId = s.id;
        if (this.view) this.view.webview.html = this.buildHtml();
        await this.reveal("chat");
    }

    // AI_NOTE: chatLinks注釈のホバー「💬 会話へ」から呼ぶ。既存の過去チャットを id で開く(新規作成しない=chatSelectと同じ経路)。
    // 該当セッションが削除済みなら何もしない(存在しないidで空チャットを作らない)。
    async openChatById(sessionId: string): Promise<void> {
        if (!this.chatStore.get(sessionId)) return;
        this.currentChatId = sessionId;
        if (this.view) this.view.webview.html = this.buildHtml();
        await this.reveal("chat");
    }

    // AI_NOTE: チャット送信の入口。pending引用(contexts)をこの送信に添付して取り出し、
    // 返信待ち中ならキューへ積む（早期returnで捨てない）。通常時は runChat へ渡す。
    private async handleChat(text: string): Promise<void> {
        if (!this.currentDoc || !this.view) return;
        const session = this.ensureChatSession();
        if (!session) return;
        const pending = session.contexts.splice(0);
        const quotes = pending.length > 0 ? pending : undefined;
        if (this.chatThinking) {
            this.chatQueue.push({ sessionId: session.id, text, quotes });
            this.chatStore.save();
            this.view.webview.html = this.buildHtml();
            return;
        }
        await this.runChat(session, text, quotes);
    }

    // AI_NOTE: 1往復の実行。ユーザー発話(引用添付)を積み、考え中表示→LLM応答→再描画。
    // 失敗はエラーをアシスタント発話として出す(握りつぶさない)。完了後キューに残りがあれば再帰で次を処理する。
    private async runChat(session: ChatSession, text: string, quotes?: ChatQuote[]): Promise<void> {
        if (!this.currentDoc || !this.view) return;
        session.messages.push({ role: "user", content: text, quotes });
        // AI_NOTE: タイトルの種。引用なしの最初の送信だけ本文から採る（引用付き新規は create() 由来のタイトルを守る=旧挙動維持）
        if (session.messages.length === 1 && !quotes) session.title = text.slice(0, 24);
        this.chatStore.save();
        this.chatThinking = true;
        this.view.webview.html = this.buildHtml();
        // AI_NOTE: 応答待ち中に別ファイルへ移っても、質問開始時のコードとURIへ注釈を保存する。currentDocをawait後に読み直さない。
        const document = this.currentDoc;
        const code = document.getText();
        const fileName = document.fileName.split(/[\\/]/).pop() ?? "unknown";
        const documentUri = document.uri.toString();
        // AI_NOTE: この往復専用のAbortController。中止ボタン→handler が abort() する。signal をLLM呼び出しまで通す。
        const controller = new AbortController();
        this.chatAbort = controller;
        try {
            const reply = await chatAboutCode(session.messages, code, fileName, controller.signal);
            session.messages.push({ role: "assistant", content: reply });
            // AI_NOTE: 返信後に chatLinks を更新。今回の引用箇所へ新規作成＋このセッションに紐づく既存注釈の結論を最新化する。
            await this.updateChatLinks(session, quotes, code, documentUri, fileName);
        } catch (e) {
            // AI_NOTE: 中止はエラーではないので分けて表示する。中断判定はエラー種別でなく signal.aborted で確実に見る
            // （プロバイダにより abort が network/APIUserAbortError 等バラつくため）。
            if (controller.signal.aborted) {
                session.messages.push({ role: "assistant", content: "（中止しました）" });
            } else {
                const errMsg = e instanceof Error ? e.message : String(e);
                session.messages.push({ role: "assistant", content: `エラー: ${errMsg}` });
            }
        } finally {
            this.chatAbort = null;
            this.chatThinking = false;
            // AI_NOTE: 中止時は送信待ちキューも破棄する（連続で走り出すのを止めるのが中止の意図）。再描画前に消して送信待ちバブルも消す。
            if (controller.signal.aborted) this.chatQueue = [];
            this.chatStore.save();
            if (this.view) this.view.webview.html = this.buildHtml();
            // AI_NOTE: 送信待ちキューをFIFOで処理。セッションが消えていた項目は捨てて次へ。見つかったら再帰1回で継続。中止時は空なので回らない。
            while (this.chatQueue.length > 0) {
                const next = this.chatQueue.shift();
                if (!next) break;
                const s = this.chatStore.get(next.sessionId);
                if (s) { await this.runChat(s, next.text, next.quotes); break; }
            }
        }
    }

    // AI_NOTE: chatLinks生成/更新フック。毎回の返信後に呼ぶ。
    // (1)行情報付き引用があればその箇所、無ければ最新Q&Aから検証できたコード箇所へ新規chatLinkを作る。
    // (2)このセッションに紐づく既存chatLink(過去に作った箇所)は、会話が進んだ結論で label/explanation を最新へ更新する。
    // 結論要約と自動対象検出は会話全体(直近10発話)から1回だけ計算し、新規・既存の両方に使う。
    // 失敗しても再throwしない(チャット応答は既に成功済み。注釈生成の失敗で会話を壊さない)。
    private async updateChatLinks(
        session: ChatSession,
        quotes: ChatQuote[] | undefined,
        code: string,
        documentUri: string,
        documentFileName: string,
    ): Promise<void> {
        const existing = this.chatLinkStore.getLinksForSession(session.id);
        const newTargets = (quotes ?? []).filter((q) => q.fileName && q.lineStart != null && q.lineEnd != null);
        try {
            const transcript = session.messages.slice(-10).map((m) => `${m.role === "user" ? "質問" : "回答"}: ${m.content}`).join("\n");
            const { label, explanation, targets } = await summarizeChatConclusion(transcript, code);
            const touched = new Set<string>();
            // AI_NOTE: 会話リンクも名称Hoverだけに限定する。行範囲の引用から行全体・block注釈は作らず、
            // モデルが返した名称をresolverで実コードへ再照合できた場合だけ追加する。
            const inferred = resolveAnnotations(targets.map((target) => ({
                ...target,
                label,
                explanation,
            })), code).filter((annotation) => annotation.kind === "symbol");
            for (const ann of inferred) {
                this.chatLinkStore.add(documentUri, ann, session.id);
                touched.add(documentUri);
            }
            // (2)既存のsymbolリンクだけを最新の結論へ更新する。
            for (const { uri: u, link } of existing) {
                if (link.annotation.kind !== "symbol") continue;
                this.chatLinkStore.update(u, link.annotation.id, label, explanation);
                touched.add(u);
            }
            for (const u of touched) this.annotationProvider.refreshEditorByUri(u);
        } catch (e) {
            console.warn("updateChatLinks failed:", e);
        }
    }

    // AI_NOTE: 引用チップの表示ラベル（escape済みHTML）。pendingチップとuserバブル内ミニチップで共通の書式。
    // 単一行選択はどのトークンか分かるようコード先頭も見せる。lineStart無し(解説由来)は場所句なし。
    private quoteLabel(c: ChatQuote, n: number): string {
        if (c.lineStart == null) return `引用${n} ${escapeHtml(c.fileName ?? "コード片")}`;
        const file = escapeHtml(c.fileName ?? "");
        if (c.lineStart === c.lineEnd) return `引用${n} ${file} L${c.lineStart} 「${escapeHtml(c.code.replace(/\n/g, " ").trim().slice(0, 20))}」`;
        return `引用${n} ${file} L${c.lineStart}-${c.lineEnd}`;
    }

    // AI_NOTE: user本文中の「(引用N)」「引用N」をその位置のインラインチップに置換する（Nは添付quotesの1始まり番号）。
    // 本文で参照されなかった引用だけ従来のチップ行(.bq-chips)に出す。番号の大きい方から置換し、さらに (?!\d) で
    // 「引用1」が「引用10」(挿入済みchipラベル内を含む)の先頭に部分一致する事故を防ぐ。
    private renderUserContent(content: string, quotes?: ChatQuote[]): string {
        let html = escapeHtml(content);
        const referenced = new Set<number>();
        const list = quotes ?? [];
        for (let i = list.length; i >= 1; i--) {
            const chip = `<span class="bq-chip">${this.quoteLabel(list[i - 1], i)}</span>`;
            const before = html;
            html = html.replace(new RegExp(`[（(]?引用${i}(?!\\d)[）)]?`, "g"), chip);
            if (html !== before) referenced.add(i);
        }
        const rest = list.map((q, idx) => referenced.has(idx + 1) ? "" : `<span class="bq-chip">${this.quoteLabel(q, idx + 1)}</span>`).join("");
        return `${rest ? `<div class="bq-chips">${rest}</div>` : ""}${html}`;
    }

    // AI_NOTE: ⑤ チャットタブ本体。上部にインライン解説コントロール+一覧、[新規]+過去チャット選択、pending引用、吹き出し、下部に入力。#1 IME対策込み。
    // AI_NOTE: インライン解説の操作パネル専用タブ。以前はチャットタブ先頭に同居していたが、
    // 機能が別物（注釈生成の操作 vs 会話）なので独立タブに分離した（ユーザー要望）。
    private buildInlinePane(): string {
        if (!this.currentDoc) {
            return `<div class="msg">Python・JavaScript・TypeScriptファイルを開くとインライン解説を生成できます</div>`;
        }
        return this.buildAnnotationsPanel();
    }

    // AI_NOTE: 実行トレース専用タブ。解説タブと同じ行スタイル(.ann-rows等)を使い回す。
    // 状態行はhtml再構築時点のスナップショット(トレース表示/解除で refresh が走るタイミングに描き直される)。
    private buildTracePane(): string {
        if (!this.currentDoc) {
            return `<div class="msg">Pythonファイルを開くと関数を実行トレースできます</div>`;
        }
        if (!languageProfile(this.currentDoc.languageId)?.canTrace) {
            return `<div class="msg">実行トレースは現在Pythonだけに対応しています。構造・概要・図・解説・チャットはこの言語でも利用できます。</div>`;
        }
        const row = (control: string, desc: string) => `<div class="ann-row">${control}<span class="ann-desc">${desc}</span></div>`;
        const statusHtml = `<div id="trace-status" class="ann-status">${escapeHtml(this.traceStatusText())}</div>`;
        return `<div class="ann-panel"><div class="ann-rows trace-rows">
      <div class="ann-sec">実行トレース — 関数を具体例で実際に動かし、各行に変数の実値を表示</div>
      ${row(`<button class="tbtn on" onclick="traceRunSelected()">選んだ関数をトレース</button>`, "下でチェックした関数をまとめて実行（1つずつでも可・実行済みなら即表示）")}
      ${row(`<button class="tbtn" onclick="vscode.postMessage({type:'traceRun'})">カーソルの関数だけ</button>`, "カーソルを置いた関数1つだけをトレースする")}
      ${row(`<button class="tbtn" onclick="vscode.postMessage({type:'traceRegen'})">別の入力例で再実行</button>`, "キャッシュを無視して入力例から作り直す（表示中の関数すべて）")}
      ${row(`<button class="tbtn" onclick="vscode.postMessage({type:'traceClear'})">トレースを消す</button>`, "エディタの実行値だけを消す")}
      ${this.traceFuncRows()}
      <div class="ann-sec">ショートカット</div>
      ${row(`<span class="ann-desc">⌥⌘T</span>`, "トレース実行（カーソルのある関数）")}
      ${row(`<span class="ann-desc">⌥⌘← / ⌥⌘→</span>`, "前の周回 / 次の周回（カーソルのあるループが対象）")}
      <div class="ann-sec">見かた・操作</div>
      ${row(`<span class="ann-desc">◀ n周目/全m周 ▶</span>`, "ループ行の周回表示。切り替えは下の「ループの周回」ボタン、画面左下のステータスバーの「トレース n周目/全m周」、⌥⌘←/→のどれでも。行にホバーすると全周回の表")}
      ${row(`<span class="ann-desc">値が…で切れている</span>`, "その行にホバーすると全文が見えます")}
      ${row(`<span class="ann-desc">実行しない場合</span>`, "ファイル書き込み・通信など副作用のある関数は安全のため実行を断ります")}
      <div id="trace-loops">${this.traceLoopRows()}</div>
    </div>${statusHtml}</div>`;
    }

    private buildChatPane(): string {
        if (!this.currentDoc) {
            return `<div class="msg">Python・JavaScript・TypeScriptファイルを開くとそのコードについて質問できます</div>`;
        }
        const sessions = this.chatStore.list();
        const session = this.currentChatId ? this.chatStore.get(this.currentChatId) : undefined;
        const header = this.buildChatHistoryPanel(sessions);
        // AI_NOTE: pending引用は上部チップ行(#cquotes)を廃止し、入力欄内にピルとして埋め込む方式に変更。
        // ラベル配列は buildHtml 側の pendingQuotes(script埋め込み)で渡すため、ここでは何もしない。
        // AI_NOTE: AI返信はmarkdown描画、ユーザー発話は本文中の(引用N)をインラインチップに置換(renderUserContent)。役割で描画を分ける。
        const msgs = (session?.messages ?? [])
            .map((m) => {
                const body = m.role === "assistant" ? renderMarkdown(m.content) : this.renderUserContent(m.content, m.quotes);
                return `<div class="cmsg ${m.role}"><div class="cmsg-head"><div class="crole">${m.role === "user" ? "あなた" : "AI"}</div><button class="cmsg-copy" onclick="copyChatMessage(event,this)">コピー</button></div><div class="cmsg-body">${body}</div></div>`;
            })
            .join("");
        const thinking = this.chatThinking ? `<div class="cmsg assistant"><span class="thinking">考え中…</span></div>` : "";
        // AI_NOTE: 返信待ち中に積まれた送信待ちバブル。表示中セッション宛てのキュー項目だけを薄く見せる。本文中の(引用N)もrenderUserContentでインライン化する。
        const queued = this.chatQueue
            .filter((q) => q.sessionId === session?.id)
            .map((q) => `<div class="cmsg user queued"><div class="cmsg-head"><div class="crole">あなた（送信待ち）</div></div><div class="cmsg-body">${this.renderUserContent(q.text, q.quotes)}</div></div>`)
            .join("");
        const empty = (!session || session.messages.length === 0) && !this.chatThinking ? `<div class="msg">このファイルについて質問してください</div>` : "";
        // AI_NOTE: annパネルは「インライン」タブへ分離した。chat-top は履歴のみだが、詰まった時の内部スクロールは維持。
        // AI_NOTE: ② 実効モデルのバッジ。入力欄の直上に置き「今どのモデルで話しているか」を常時見せ、クリックで切替。
        const modelBadge = `<div id="cmodel-bar"><button id="cmodel" title="チャットのモデルを変更" onclick="vscode.postMessage({type:'pickChatModel'})">◇ ${escapeHtml(this.chatModelLabel())} ▾</button><button id="ceffort" title="思考の深さ（選択モデルのAPIパラメータ）を変更" onclick="vscode.postMessage({type:'pickChatEffort'})">${escapeHtml(this.chatEffortParam())} ${escapeHtml(this.chatEffortLevel())} ▾</button></div>`;
        return `<div class="chat">
  <div class="chat-top">${header}</div>
  <div id="cmsgs">${empty}${msgs}${thinking}${queued}</div>
  ${modelBadge}
  <div id="cinput-box">
    <div id="cinput-row">
      <div id="cinput" contenteditable="true" data-placeholder="質問を入力…（コードを貼ると引用チップとして文中に入ります）"></div>
      ${this.chatThinking
        ? `<button class="tbtn cstop-btn" id="csend" data-mode="stop" title="生成を中止">中止</button>`
        : `<button class="tbtn on" id="csend" data-mode="send">送信</button>`}
    </div>
  </div>
</div>`;
    }

    // AI_NOTE: ② チャットが実際に使うモデルの表示ラベル。effectiveModel と同じ分岐で「サブスク時は CLI/ティア表記」に落とす。
    // chatModel(API版の指定) をそのまま出さず、useSubscription/subscriptionProvider を織り込んで“実際に動くもの”を見せる。
    private chatModelLabel(): string {
        const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
        const chatModel = cfg.get<string>("chatModel", "gpt-5.6-sol");
        if (cfg.get<boolean>("useSubscription", true)) {
            if (cfg.get<string>("subscriptionProvider", "codex") === "codex") return "GPT-5.6 Sol（Codexサブスク）";
            const tier = /haiku/i.test(chatModel) ? "Haiku" : /opus/i.test(chatModel) ? "Opus" : "Sonnet";
            return `Claude ${tier}（サブスク）`;
        }
        return PRETTY_MODEL[chatModel] ?? chatModel;
    }

    // AI_NOTE: ② バッジのクリックで発火。chatModel(会話系モデル) を QuickPick で選ばせて即反映する。
    // 肝: 「実際に使えるモデルだけ」出す。サブスクON=そのCLIのモデルのみ / OFF=APIキーが登録済みのプロバイダのみ。
    // 使えない選択肢（Claudeサブスク中のGPT等、キー未登録プロバイダ）は最初から出さない。書き換えは chatModel のみ。
    private async pickChatModel(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
        const current = cfg.get<string>("chatModel", "gpt-5.6-sol");
        const claude = [
            { label: "Claude Haiku 4.5", description: "低コスト・高速", model: "claude-haiku-4-5" },
            { label: "Claude Sonnet 5", description: "バランス（推奨）", model: "claude-sonnet-5" },
            { label: "Claude Opus 5", description: "最高品質", model: "claude-opus-5" },
        ];
        const gpt = [
            { label: "GPT-5.6 Luna", description: "OpenAI・低コスト・高速", model: "gpt-5.6-luna" },
            { label: "GPT-5.6 Terra", description: "OpenAI・バランス", model: "gpt-5.6-terra" },
            { label: "GPT-5.6 Sol", description: "OpenAI・最高品質", model: "gpt-5.6-sol" },
        ];
        const gemini = [
            { label: "Gemini 3.5 Flash-Lite", description: "Google・低コスト・高速", model: "gemini-3.5-flash-lite" },
            { label: "Gemini 3.6 Flash", description: "Google・高品質", model: "gemini-3.6-flash" },
        ];
        let items: Array<{ label: string; description: string; model: string }> = [];
        if (cfg.get<boolean>("useSubscription", true)) {
            // AI_NOTE: サブスクON時は effectiveModel が全モデルをそのCLIへ振り替える。codexはティア概念が無く固定なので選択不可を明示。
            if (cfg.get<string>("subscriptionProvider", "codex") === "codex") {
                vscode.window.showInformationMessage("AI Code Guide: ChatGPT(codex)サブスクの全AI機能は GPT-5.6 Sol 固定です。");
                return;
            }
            items = claude; // サブスクはClaude CLIのティア（Haiku/Sonnet/Opus）だけ
        } else {
            // AI_NOTE: キー未登録のプロバイダは選択肢に出さない（選んでも動かないため）。settings と同じ判定経路。
            const hasKey = (setting: string) => {
                const p = settingToProvider(setting);
                return p !== undefined && getSecretKey(p).length > 0;
            };
            if (hasKey("anthropicApiKey")) items.push(...claude);
            if (hasKey("openaiApiKey")) items.push(...gpt);
            if (hasKey("geminiApiKey")) items.push(...gemini);
        }
        if (items.length === 0) {
            vscode.window.showWarningMessage("AI Code Guide: 使えるモデルがありません。設定タブでサブスクをONにするか、APIキーを登録してください。");
            return;
        }
        const picked = await vscode.window.showQuickPick(
            items.map((it) => ({ ...it, label: it.model === current ? `$(check) ${it.label}` : `      ${it.label}` })),
            { title: "AI Code Guide: チャットのモデルを選択", placeHolder: "会話に使うモデル（今使える認証のものだけ表示）" },
        );
        if (!picked) return;
        await cfg.update("chatModel", picked.model, vscode.ConfigurationTarget.Global);
        if (this.view) this.view.webview.html = this.buildHtml();
    }

    // AI_NOTE: ② effort の表示は「速い/標準/じっくり」でなくAPI準拠(low/medium/high)にし、パラメータ名を選択モデルのプロバイダで変える。
    // Claude=effort / GPT・codex=reasoning / Gemini=thinking。effectiveModel でサブスク振替(cli/codex)も込みで判定する。
    private chatEffortParam(): string {
        const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
        const p = providerOf(effectiveModel(cfg.get<string>("chatModel", "gpt-5.6-sol")));
        if (p === "openai" || p === "codex") return "reasoning";
        if (p === "gemini") return "thinking";
        return "effort";
    }
    private chatEffortLevel(): string {
        const v = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("chatEffort", "low");
        return v === "medium" || v === "high" ? v : "low";
    }

    // AI_NOTE: ② effortバッジのクリックで発火。API準拠の low/medium/high を QuickPick で選ばせて即反映。値は3社共通で保持する。
    private async pickChatEffort(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
        const current = cfg.get<string>("chatEffort", "low");
        const param = this.chatEffortParam();
        const items = [
            { label: "low", description: "既定・速い（思考を足さない）", value: "low" },
            { label: "medium", description: "そこそこ考える", value: "medium" },
            { label: "high", description: "深く考える（遅い・高コスト）", value: "high" },
        ].map((it) => ({ ...it, label: it.value === current ? `$(check) ${it.label}` : `      ${it.label}` }));
        const picked = await vscode.window.showQuickPick(items, {
            title: `AI Code Guide: ${param}（思考の深さ）`,
            placeHolder: "深いほど賢いが遅く高コスト（非対応モデルでは無視）",
        });
        if (!picked) return;
        await cfg.update("chatEffort", picked.value, vscode.ConfigurationTarget.Global);
        if (this.view) this.view.webview.html = this.buildHtml();
    }

    // AI_NOTE: 「選択範囲を解析」ボタンの click ハンドラ本体。awaitingSelection の状態遷移を担う
    private async handleAnnotateSelectionClick(): Promise<void> {
        const editor = this.getCurrentEditor() ?? vscode.window.activeTextEditor;
        if (!editor || !isSupportedLanguage(editor.document.languageId)) {
            vscode.window.showWarningMessage("AI Code Guide: Python・JavaScript・TypeScriptファイルを開いてください。");
            return;
        }
        if (this.awaitingSelection) {
            this.cancelAwaitingSelection();
            return;
        }
        if (!editor.selection.isEmpty) {
            await this.runAnnotate("sel", () => this.annotationProvider.annotate(editor));
            return;
        }
        this.awaitingSelection = true;
        // AI_NOTE: 切替は postMessage で軽量に。HTML全再生成は他タブのmermaid等まで再構築されて遅い
        this.view?.webview.postMessage({ type: "awaitingState", on: true });
        // AI_NOTE: エディタにフォーカスを移してドラッグ選択を即始められるようにする
        await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    }

    // AI_NOTE: 選択ドラッグ中の連続発火を抑える。短すぎるとドラッグ途中で発火、長すぎると待たされ感が出る。200msがバランス点
    private scheduleAwaitingFire(editor: vscode.TextEditor): void {
        if (this.selectionDebounce) clearTimeout(this.selectionDebounce);
        this.selectionDebounce = setTimeout(() => {
            this.selectionDebounce = null;
            if (!this.awaitingSelection) return;
            if (editor.selection.isEmpty) return;
            this.awaitingSelection = false;
            // AI_NOTE: 待ち中→実行へ。HTML全再生成は重いので JS で対象要素だけ更新する。annotate 完了時の件数更新は別経路(annotationsEmitter)
            this.view?.webview.postMessage({ type: "awaitingState", on: false });
            this.runAnnotate("sel", () => this.annotationProvider.annotate(editor));
        }, 200);
    }

    // AI_NOTE: 生成系を実行し、ボタンの状態表示(生成中スピナー→完了/表示済み/失敗)を webview へ通知する横断ヘルパー。
    // which=どのボタンを光らせるか("run"|"regen"|"sel")。例外は失敗として通知し、握りつぶさずログにも残す。
    private async runAnnotate(which: string, task: () => Promise<{ status: string; count: number }>): Promise<void> {
        this.view?.webview.postMessage({ type: "annBusy", which, on: true });
        try {
            const r = await task();
            this.view?.webview.postMessage({ type: "annResult", which, status: r.status, count: r.count });
        } catch (e) {
            console.error("[AI Code Guide] annotate failed:", e);
            this.view?.webview.postMessage({ type: "annResult", which, status: "error", count: 0 });
        }
    }

    private cancelAwaitingSelection(): void {
        this.awaitingSelection = false;
        if (this.selectionDebounce) { clearTimeout(this.selectionDebounce); this.selectionDebounce = null; }
        this.view?.webview.postMessage({ type: "awaitingState", on: false });
    }

    // 名称辞書パネル。対象選定・密度・block/symbol別配置は廃止し、全名称を無装飾Hoverへ載せる。
    // 注釈一覧は廃止: コードを見ながら名称へホバーして読む運用が中心で、サイドバーから「行へ飛ぶ」需要がほぼ無かったため。
    // 件数バッジは「生成済みかどうか」「警告が混じっているか」だけ即見えればよいので 1行に集約する。
    private buildAnnotationsPanel(): string {
        if (!this.currentDoc) return "";
        const editor = this.getCurrentEditor();
        const data = editor ? this.annotationProvider.getAnnotations(editor) : { items: [] as SemanticAnnotation[], generatedAt: null as Date | null };
        const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
        const autoOn = cfg.get<boolean>("autoInlineAnnotations", true);
        const showAnnotations = cfg.get<boolean>("showAnnotations", true);
        // AI_NOTE: 「範囲」ボタンの状態は本来カーソル/選択状態で変わるべきだが、選択変化のたび HTML 全再描画は重いので
        // 静的に「選択中→その範囲 / 未選択→カーソル上の関数」を tooltip に書いて伝える(annotate 側が実行時に分岐する)。

        const items = data.items;
        const uniqueCount = new Set(items.map((item) => item.symbolKey ?? item.label)).size;
        const timeStr = data.generatedAt ? data.generatedAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";

        // AI_NOTE: 「選択範囲を解析」ボタンの3状態。
        //   ・awaiting=true → ボタンは「✕ 選択待ち...」へ、上にバナー表示
        //   ・選択あり → 「選択範囲を解析」即実行モード
        //   ・選択なし → 「選択範囲を解析…」押すと awaiting に入る(ヒント tooltip 付き)
        // AI_NOTE: クリアは画面表示だけ消す(キャッシュは永続。同じ内容ならLLM呼び出し無しで再表示できる)
        const clearTip = "画面の解説表示だけクリアします (キャッシュは保持。再生成は無料)";

        // AI_NOTE: ボタン/バナーは常に同一DOMで描画し、awaitingStateメッセージでクラスとtextContent/表示を JS で切替(再生成を避ける)
        const awaiting = this.awaitingSelection;
        const selBtn = `<button id="ann-sel-btn" class="tbtn${awaiting ? " awaiting" : ""}" onclick="vscode.postMessage({type:'annotateSelection'})" title="${awaiting ? "クリックでキャンセル" : "選択中ならその範囲を解析。未選択で押すと選択モードに入り、ドラッグで範囲を決めると自動実行"}">${awaiting ? "✕ キャンセル" : "範囲を解析"}</button>`;

        // AI_NOTE: 横詰め(flex-wrap)はON↔OFFの文字数変化でボタン幅が変わり折り返し位置が動いて誤クリックを誘発した
        // (ユーザー指摘)ので、1行=1ボタン+説明の縦並びへ変更。説明を常時見せて「何のボタンか」を名前だけに頼らない。
        const row = (control: string, desc: string) => `<div class="ann-row">${control}<span class="ann-desc">${desc}</span></div>`;
        const toggle = (msgType: string, on: boolean, label: string) =>
            `<button class="tbtn${on ? " on" : ""}" onclick="vscode.postMessage({type:'${msgType}'})">${label}: ${on ? "ON" : "OFF"}</button>`;
        const toolbar = `<div class="ann-rows">
      <div class="ann-sec">生成</div>
      <div class="ann-primary-actions">
        <button id="ann-run-btn" class="tbtn on" onclick="vscode.postMessage({type:'annotateRun'})" title="ファイル内の変数・関数・メソッド・クラスをすべて辞書化する。Cmd+Alt+E でも実行できます">名称辞書</button>
        <button id="ann-regen-btn" class="tbtn" onclick="vscode.postMessage({type:'annotateRegen'})" title="名称は変えず、短い説明だけをすべて作り直す">説明を再生成</button>
      </div>
      <div class="ann-primary-desc">名称辞書は未生成分だけ作成・再利用。再生成は全説明を作り直します。</div>
      ${row(selBtn, "選択範囲内の全名称を辞書化する")}
      ${row(`<button class="tbtn" onclick="vscode.postMessage({type:'annotateClear'})" title="${clearTip}">表示クリア</button>`, "Hover対象を消す（キャッシュは残る）")}
      ${row(toggle("toggleAutoAnnotate", autoOn, "自動生成"), "Pythonファイルを開いたら名称辞書を生成する")}
      <div class="ann-sec">表示</div>
      ${row(toggle("toggleShowAnnotations", showAnnotations, "名称辞書を表示"), "コードの見た目は変えず、名称へのHoverだけを有効/無効にする")}
    </div>`;

        // AI_NOTE: 選択待ち中のバナー。常にDOMを置き、display で出し分け(JSで即トグルできるように)
        const banner = `<div id="ann-await-banner" class="ann-await" style="display:${awaiting ? "block" : "none"}">📐 エディタでコードをドラッグ選択してください。選択した範囲が自動で解析されます。</div>`;

        const status = items.length === 0
            ? `<div id="ann-status" class="ann-status">名称 0個 — 「名称辞書 (全体)」または「範囲を解析」を押してください</div>`
            : `<div id="ann-status" class="ann-status">名称 ${uniqueCount}個・出現 ${items.length}箇所${timeStr ? ` ・ ${escapeHtml(timeStr)}` : ""}</div>`;

        return `<div class="ann-panel">${toolbar}${banner}${status}</div>`;
    }

    // AI_NOTE: チャット履歴を受信箱型のリストで出す。各行=タイトル/ファイル名/最後の発話プレビュー、ホバーで✎🗑。
    // 旧 <select> ドロップダウンだとタイトルしか見えず、文脈の取り戻しに弱かったので置き換えた。
    // 折り畳み式 <details> で常時広く取らず、必要な時だけ開く。現在選択中のチャットはハイライト。
    private buildChatHistoryPanel(sessions: ChatSession[]): string {
        const head = `<div id="chat-head">
      <button class="tbtn on" id="cnew">+ 新規チャット</button>
      ${this.currentChatId ? `<span class="chat-current-label">↓ 現在のチャット</span>` : `<span class="chat-current-label">↓ 履歴 (${sessions.length})</span>`}
    </div>`;
        if (sessions.length === 0) {
            return head;
        }
        const rowHtmls = sessions.map((s) => {
            const last = s.messages.length > 0 ? s.messages[s.messages.length - 1].content : "(まだメッセージなし)";
            const preview = last.replace(/\s+/g, " ").slice(0, 60);
            const safeTitle = escapeHtml(s.title).replace(/'/g, "\\'");
            const isCurrent = s.id === this.currentChatId;
            return `<div class="chist-row${isCurrent ? " current" : ""}" data-id="${escapeHtml(s.id)}"
        onclick="vscode.postMessage({type:'chatSelect',text:'${escapeHtml(s.id)}'})">
        <div class="chist-main">
          <div class="chist-title">${escapeHtml(s.title)}</div>
          <div class="chist-meta">${escapeHtml(s.fileName)}</div>
          <div class="chist-preview">${escapeHtml(preview)}</div>
        </div>
        <div class="chist-actions">
          <span class="chist-act" title="名前を変更" onclick="event.stopPropagation();chatRename('${escapeHtml(s.id)}','${safeTitle}')">変更</span>
          <span class="chist-act" title="このチャットを削除" onclick="event.stopPropagation();chatDelete('${escapeHtml(s.id)}','${safeTitle}')">削除</span>
        </div>
      </div>`;
        });
        // AI_NOTE: 履歴が縦に伸びすぎないよう直近6件だけ常時表示し、残りは入れ子の <details> に畳む。
        const RECENT = 6;
        const visible = rowHtmls.slice(0, RECENT).join("");
        const overflow = rowHtmls.length > RECENT
            ? `<details class="chist-more"><summary>+ 他 ${rowHtmls.length - RECENT} 件</summary>${rowHtmls.slice(RECENT).join("")}</details>`
            : "";
        // AI_NOTE: 現在チャットがあるときは履歴を畳んでおき、無いときは展開して選びやすくする
        const openAttr = this.currentChatId ? "" : " open";
        return `${head}<details class="chist"${openAttr}><summary>履歴 (${sessions.length}件)</summary>${visible}${overflow}</details>`;
    }

    // AI_NOTE: #3/#12 散在する設定を1画面に集約。現在値を表示し、その場で変更できる。
    // モデルは「どこで何が使われるか」を明記して #3 の混乱を解消する。APIキーは値を扱わず状態のみ。
    // AI_NOTE: 使用量タブ。永続記録(token-usage.jsonl)から 期間サマリ / 日別棒グラフ / モデル別コスト を描く。
    // データは getDailyUsage(日別) + getAllTimeUsage(全期間累計) + getUsageStats(モデル別)。コストは概算。
    private buildUsagePane(): string {
        const daily = getDailyUsage(14);
        const all = getAllTimeUsage();
        const byModel = getUsageStats().byModel;
        const sum = (x: { in: number; out: number }) => x.in + x.out;
        const kfmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
        const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;
        const usd = (n: number) => `$${n.toFixed(2)}`;

        // AI_NOTE: 期間集計は日別データから導く（今日=末尾、週=末尾7日）。全期間はメモリ累計を使う。
        const today = daily[daily.length - 1] ?? { in: 0, out: 0, jpy: 0, usd: 0 };
        const week = daily.slice(-7).reduce((a, d) => ({ tok: a.tok + sum(d), jpy: a.jpy + d.jpy, usd: a.usd + d.usd }), { tok: 0, jpy: 0, usd: 0 });
        const allTok = all.input + all.output;

        const card = (title: string, tok: number, jpy: number, dollar: number) =>
            `<div class="u-card"><div class="u-k">${title}</div><div class="u-v">${kfmt(tok)} tok</div><div class="u-c">${yen(jpy)} / ${usd(dollar)}</div></div>`;
        const cards = `<div class="u-cards">
          ${card("今日", sum(today), today.jpy, today.usd)}
          ${card("直近7日", week.tok, week.jpy, week.usd)}
          ${card("全期間", allTok, all.costJpy, all.costUsd)}
        </div>`;

        // AI_NOTE: 日別棒グラフ。コスト(¥)で棒幅を正規化。活動の無い日は "—"。
        const maxJpy = Math.max(1, ...daily.map((d) => d.jpy));
        const bars = daily.map((d) => {
            const w = Math.round((d.jpy / maxJpy) * 100);
            const empty = sum(d) === 0;
            return `<div class="u-row">
              <div class="u-date">${d.date.slice(5)}</div>
              <div class="u-track"><div class="u-bar" style="width:${empty ? 0 : Math.max(2, w)}%"></div></div>
              <div class="u-amt">${empty ? "—" : `${kfmt(sum(d))} / ${yen(d.jpy)}`}</div>
            </div>`;
        }).join("");

        const models = byModel.length
            ? byModel.map((m) => `<div class="u-mrow">
                <span class="u-mname">${m.model.replace("claude-", "").replace("-20251001", "")}</span>
                <span class="u-mtok">${kfmt(m.in + m.out)} tok</span>
                <span class="u-mcost">${yen(m.usd * 150)} / ${usd(m.usd)}</span>
              </div>`).join("")
            : `<div class="msg">まだ記録がありません。コードを解析するとここに溜まります。</div>`;

        return `<div class="usage">
          <div class="u-head">
            <span class="u-title">トークン使用量・コスト</span>
            <button class="tbtn" onclick="vscode.postMessage({type:'refreshUsage'})">↻ 更新</button>
          </div>
          ${cards}
          <div class="u-sec">日別（直近14日 / 棒は¥で正規化）</div>
          <div class="u-bars">${bars}</div>
          <div class="u-sec">モデル別（全期間）</div>
          <div class="u-models">${models}</div>
          <div class="u-note">※ コストは概算（モデル単価 × 固定レート ¥150/＄）。正確な請求額ではありません。</div>
        </div>`;
    }

    // AI_NOTE: 専用CONFIG_DIRのログインアカウントを `claude auth status --json` で取得し、メール/組織/プランを表示する。
    // 完全ログインなので profile スコープがあり email まで返る(setup-tokenと違う)。結果は webview の #oauth-verify バッジへ返す。
    private async verifySeparateAccount(): Promise<void> {
        const post = (text: string, ok: boolean | null) =>
            this.view?.webview.postMessage({ type: "oauthVerifyResult", text, ok });
        post("確認中…", null);
        const claude = resolveCommand(vscode.workspace.getConfiguration("aiCodeGuide").get<string>("claudeCliPath", "claude") ?? "claude", "claude");
        // AI_NOTE: I/O境界。CLAUDE_CONFIG_DIR で専用ログインを参照。失敗(spawn不可/JSON崩れ)は握り潰さずバッジに出す。
        const env = { ...process.env, CLAUDE_CONFIG_DIR: separateClaudeConfigDir() };
        const child = spawn(claude, ["auth", "status", "--json"], { env });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => post(`確認失敗: ${e instanceof Error ? e.message : String(e)}`, false));
        child.on("close", () => {
            try {
                const d = JSON.parse(out) as { loggedIn?: boolean; email?: string; orgName?: string; subscriptionType?: string };
                if (!d.loggedIn) { post("未ログイン — 「別アカウントでログイン」から先にログインしてください", false); return; }
                const parts = [d.email, d.subscriptionType, d.orgName].filter(Boolean);
                post(`✓ ${parts.join(" / ") || "ログイン済み"}`, true);
            } catch {
                post(`確認失敗: ${(err || out).slice(0, 200) || "応答なし"}`, false);
            }
        });
    }

    // AI_NOTE: ヘルプタブ。.vsix 手渡し配布で Marketplace の説明ページが無いので、使い方・認証手順・操作・ショートカットを
    // 拡張内に常設する。設定タブの .settings/.sgroup スタイルを流用し、ボタンは既存メッセージ(activate/openApiKeySetting)と
    // 新設の runCommand ホワイトリストだけで完結させる(任意コマンド実行はしない)。
    private buildHelpPane(): string {
        const asking = this.helpAsking;
        // AI_NOTE: 回答は改行保持(pre-wrap)でそのまま出す。HTMLは流し込まずescapeして安全側に倒す。
        const ans = this.helpAnswer ? `<div class="help-answer">${escapeHtml(this.helpAnswer)}</div>` : "";
        // AI_NOTE: 質問ボックスはタブ最下部(困ったとき節の直後)。送信時に textarea の現在値を helpAsk で拾う。
        // 回答の根拠はフルページ本文(helpDocText→helpPlainText)。
        const ask = `<div class="sgroup">
    <div class="stitle">ヘルプに質問</div>
    <p class="snote">使い方でわからないことを書くと、フルページの説明内容から答えます。</p>
    <textarea id="helpq" rows="2" placeholder="例: 解説を消すには？ / 依存関係はどこで見れる？">${escapeHtml(this.helpQuestion)}</textarea>
    <div class="btnrow">
      <button class="tbtn on${asking ? " busy" : ""}" ${asking ? "disabled" : ""} onclick="vscode.postMessage({type:'helpAsk',text:document.getElementById('helpq').value})">${asking ? "回答中…" : "質問する"}</button>
    </div>
    ${ans}
  </div>`;
        return `<div class="settings help">${this.buildHelpSections()}${ask}</div>`;
    }

    // AI_NOTE: ヘルプタブは「読む場所」でなく「跳ぶ・引く場所」(2026-07-02 再設計)。長文説明・画像は
    // フルページ(helpPage.ts)に一本化し、ここは1画面で収まるランチャー＋クイックリファレンスに限定する。
    private buildHelpSections(): string {
        const macKey = (mac: string) => `<span class="kbd">${mac}</span>`;
        return `<div class="sgroup">
    <div class="stitle">はじめに</div>
    <p><b>基本操作・使い方を知りたいときは「使い方をフルページで開く」へ。</b>図・画像入りで全機能を説明しています。</p>
    <p class="snote">AI Code Guide は ① フローチャート/マップで構造を見る、② インライン解説でコードに注釈を出す、の2軸の拡張です。このタブはショートカットとよく使う操作の置き場です。</p>
    <div class="btnrow">
      <button class="tbtn on" onclick="vscode.postMessage({type:'runCommand',command:'aiCodeGuide.openHelpPage'})">使い方をフルページで開く</button>
      <button class="tbtn" onclick="vscode.postMessage({type:'runCommand',command:'aiCodeGuide.openWalkthrough'})">ようこそガイド（初回セットアップ）</button>
    </div>
  </div>

  <div class="sgroup">
    <div class="stitle">ショートカット（Pythonエディタ）</div>
    <div class="srow"><span class="slabel">フローチャートを表示</span><span>${macKey("⌘⌥V")} / ${macKey("Ctrl+Alt+V")}</span></div>
    <div class="srow"><span class="slabel">インライン解説を生成</span><span>${macKey("⌘⌥E")} / ${macKey("Ctrl+Alt+E")}</span></div>
    <div class="srow"><span class="slabel">インライン解説をクリア</span><span>${macKey("⌘⌥C")} / ${macKey("Ctrl+Alt+C")}</span></div>
    <p class="snote">${macKey("⌘⇧P")}（コマンドパレット）から「AI Code Guide:」で検索しても実行できます。</p>
  </div>

  <div class="sgroup">
    <div class="stitle">よく使う操作</div>
    <div class="btnrow">
      <button class="tbtn" onclick="vscode.postMessage({type:'runCommand',command:'aiCodeGuide.showFlowchart'})">フローチャートを表示</button>
      <button class="tbtn" onclick="vscode.postMessage({type:'runCommand',command:'aiCodeGuide.explainBlockInline'})">インライン解説を生成</button>
      <button class="tbtn" onclick="vscode.postMessage({type:'runCommand',command:'aiCodeGuide.clearBlockExplanations'})">解説をクリア</button>
      <button class="tbtn" onclick="vscode.postMessage({type:'runCommand',command:'aiCodeGuide.setApiKey'})">APIキーを設定 / 削除</button>
      <button class="tbtn" onclick="activate('settings')">設定タブを開く</button>
    </div>
  </div>

  <div class="sgroup">
    <div class="stitle">困ったとき</div>
    <ul>
      <li><b>解説が出ない</b>: 認証未設定か通信失敗。設定タブで APIキー / サブスクを確認。</li>
      <li><b>何も解析されない</b>: <code>python3</code> が PATH にあるか確認。</li>
      <li><b>更新したのに変わらない</b>: 新しい .vsix を入れたら VS Code を再読み込み（${macKey("⌘⇧P")} →「Reload Window」）。</li>
    </ul>
    <p class="snote">解決しないときは下の質問欄へ。詳しい説明はフルページ版にあります。</p>
  </div>`;
    }

    // AI_NOTE: 質問回答の文脈はフルページ本文(helpPlainText)から作る。タブをランチャー化して説明を
    // 持たなくなったため、タブHTML由来では根拠が足りない。フルページの表示と回答根拠を一致させる。
    private helpDocText(): string {
        return helpPlainText(this.extensionPath);
    }

    // AI_NOTE: 質問→回答の本体。生成中フラグを立てて即再描画(「回答中…」)→LLM→回答格納で再描画。
    // 失敗は握り潰さず、認証/通信を疑う定型文を回答欄に出して空のまま固まらせない(I/O境界の最小例外処理)。
    private async handleHelpAsk(question: string): Promise<void> {
        const q = question.trim();
        if (!q || this.helpAsking) return;
        this.helpQuestion = q;
        this.helpAsking = true;
        this.helpAnswer = "";
        if (this.view) this.view.webview.html = this.buildHtml();
        try {
            this.helpAnswer = await answerHelpQuestion(q, this.helpDocText())
                || "回答が空でした。設定タブで APIキー / サブスクを確認してください。";
        } catch (e) {
            this.helpAnswer = "回答の生成に失敗しました（認証が未設定か通信失敗の可能性）。設定タブで APIキー / サブスクを確認してください。";
            console.error("[AI Code Guide] help ask error:", e);
        } finally {
            this.helpAsking = false;
            if (this.view) this.view.webview.html = this.buildHtml();
        }
    }

    private buildSettingsPane(): string {
        const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
        const model = cfg.get<string>("model", "gpt-5.6-sol");
        const chatModel = cfg.get<string>("chatModel", "gpt-5.6-sol");
        const inlineModel = cfg.get<string>("inlineAnnotationModel", "gpt-5.6-sol");
        const globalContext = cfg.get<string>("globalContext", "");
        const arrowSide = cfg.get<string>("arrowSide", "left");
        const subProvider = cfg.get<string>("subscriptionProvider", "codex");
        // AI_NOTE: 別アカウント(専用ログイン)で動かす設定がONか。状態表示とトグルに使う。
        const separateLoginOn = cfg.get<boolean>("useSeparateClaudeLogin", false);

        // AI_NOTE: APIキーはプロバイダごとに別設定。状態表示とジャンプ先を切り替えるため3つ並べる。
        // AI_NOTE: キーはSecretStorage保存に移行。settingsでなくメモリキャッシュ(getSecretKey)で状態判定する
        const keyStatus = (key: string) => {
            const provider = settingToProvider(key);
            return provider !== undefined && getSecretKey(provider).length > 0;
        };

        // AI_NOTE: モデル選択はプロバイダ別 optgroup。モデル名接頭辞でプロバイダを自動判定するため混在可。
        // 設定値がリスト外(settings.jsonで自由入力)でも選択が消えないよう、未知の値は先頭に補う。
        const modelGroups: Array<{ g: string; opts: Array<{ v: string; l: string }> }> = [
            { g: "Claude", opts: [
                { v: "claude-haiku-4-5", l: "Haiku 4.5（低コスト・高速）" },
                { v: "claude-sonnet-5", l: "Sonnet 5（バランス）" },
                { v: "claude-opus-5", l: "Opus 5（最高品質）" },
            ] },
            { g: "GPT", opts: [
                { v: "gpt-5.6-luna", l: "GPT-5.6 Luna（低コスト・高速）" },
                { v: "gpt-5.6-terra", l: "GPT-5.6 Terra（バランス）" },
                { v: "gpt-5.6-sol", l: "GPT-5.6 Sol（最高品質）" },
            ] },
            { g: "Gemini", opts: [
                { v: "gemini-3.5-flash-lite", l: "Gemini 3.5 Flash-Lite（低コスト・高速）" },
                { v: "gemini-3.6-flash", l: "Gemini 3.6 Flash（高品質）" },
            ] },
        ];
        const known = new Set(modelGroups.flatMap((grp) => grp.opts.map((o) => o.v)));
        const sel = (cur: string, key: string) => {
            const custom = !known.has(cur)
                ? `<optgroup label="設定値"><option value="${cur}" selected>${cur}</option></optgroup>`
                : "";
            const groups = modelGroups.map((grp) =>
                `<optgroup label="${grp.g}">` +
                grp.opts.map((o) => `<option value="${o.v}"${o.v === cur ? " selected" : ""}>${o.l}</option>`).join("") +
                `</optgroup>`).join("");
            return `<select onchange="vscode.postMessage({type:'setConfig',key:'${key}',value:this.value})">${custom}${groups}</select>`;
        };
        const check = (key: string, on: boolean, label: string) =>
            `<label class="row"><input type="checkbox" ${on ? "checked" : ""} onchange="vscode.postMessage({type:'setConfig',key:'${key}',value:this.checked})"> ${label}</label>`;
        return `<div class="settings">
  <div class="sgroup">
    <div class="stitle">モデル</div>
    <div class="srow"><span class="slabel">構造系（フローチャート/AI説明/概要/分解）</span>${sel(model, "model")}</div>
    <div class="srow"><span class="slabel">会話系（チャット/ファイル説明）</span>${sel(chatModel, "chatModel")}</div>
    <div class="srow"><span class="slabel">インライン解説／実行トレース</span>${sel(inlineModel, "inlineAnnotationModel")}</div>
    <div class="snote">サブスクON＋ChatGPTでは3系統すべてGPT-5.6 Sol固定です。サブスクOFF時だけ各モデル選択を使います。</div>
  </div>
  <div class="sgroup">
    <div class="stitle">自動実行</div>
    ${check("autoShowOnOpen", cfg.get<boolean>("autoShowOnOpen", false), "ファイルを開いたらパネルを自動表示")}
    ${check("autoDescribe", cfg.get<boolean>("autoDescribe", false), "マップ表示時にAI説明を自動生成（トークン消費）")}
    ${check("autoInlineAnnotations", cfg.get<boolean>("autoInlineAnnotations", true), "ファイルを開いたらインライン解説を自動生成（トークン消費）")}
  </div>
  <div class="sgroup">
    <div class="stitle">グローバル文脈</div>
    <div class="snote">全説明の前置きに使われます（例: 私はPython初心者です）。</div>
    <textarea id="gctx" rows="3">${escapeHtml(globalContext)}</textarea>
    <button class="tbtn" onclick="vscode.postMessage({type:'setConfig',key:'globalContext',value:document.getElementById('gctx').value})">保存</button>
  </div>
  <div class="sgroup">
    <div class="stitle">表示</div>
    <div class="srow"><span class="slabel">矢印を描く側</span>
      <select onchange="vscode.postMessage({type:'setConfig',key:'arrowSide',value:this.value})">
        <option value="left"${arrowSide === "left" ? " selected" : ""}>左側（パネルが左・コードが右）</option>
        <option value="right"${arrowSide === "right" ? " selected" : ""}>右側（パネルが右・コードが左）</option>
      </select>
    </div>
    <div class="snote">呼び出し・依存の矢印をカードのどちら側に描くか。コードと反対側にすると見やすい。</div>
  </div>
  <div class="sgroup">
    <div class="stitle">バックエンド</div>
    ${check("useSubscription", cfg.get<boolean>("useSubscription", true), "サブスクで動かす — APIキー不要")}
    <div class="srow"><span class="slabel">サブスク提供元</span>
      <select onchange="vscode.postMessage({type:'setConfig',key:'subscriptionProvider',value:this.value})">
        <option value="claude"${subProvider === "claude" ? " selected" : ""}>Claude（claude CLI）</option>
        <option value="codex"${subProvider === "codex" ? " selected" : ""}>ChatGPT（codex CLI / GPT-5.6 Sol）</option>
      </select>
    </div>
    <div class="snote">ON でAPIキーの代わりにサブスクで生成（ログイン済みマシン限定）。Claude は選んだ品質ティアのまま、ChatGPT(codex) は codex 既定モデルを使います。OFF なら下のAPIキーを使用。</div>
  </div>
  <div class="sgroup">
    <div class="stitle">別のClaudeアカウントで使う</div>
    ${check("useSeparateClaudeLogin", separateLoginOn, "別アカウント（専用ログイン）で動かす")}
    <div class="snote">ONにすると ai-code-guide が呼ぶ <code>claude</code> だけ専用ログインを使います（ターミナルや他拡張は既定のまま）。先に下の「別アカウントでログイン」を一度実行してください。</div>
    <div class="srow" style="margin-top:6px;">
      <button class="tbtn on" onclick="vscode.postMessage({type:'separateLogin'})" title="専用の認証ディレクトリで claude にログイン（ブラウザ認証）。ターミナルの既定ログインは変わりません">別アカウントでログイン</button>
      <button class="tbtn" onclick="vscode.postMessage({type:'verifyAccount'})" title="専用ログインのアカウント（メール/プラン/組織）を表示します">アカウントを確認</button>
      <button class="tbtn" onclick="vscode.postMessage({type:'separateLogout'})" title="専用ログインからログアウト">ログアウト</button>
    </div>
    <div id="oauth-verify" class="snote" style="margin-top:6px;"></div>
    <details style="margin-top:8px;">
      <summary style="cursor:pointer;">使い方</summary>
      <ol class="snote" style="margin:8px 0 0 0;padding-left:18px;">
        <li style="margin-bottom:8px;"><b>「別アカウントでログイン」</b>を押す → ターミナルで <code>claude auth login</code> が走るので、ブラウザで<b>使いたいアカウント（Max等）</b>を選んで認証（既定ログインとは別枠なので影響しません）</li>
        <li style="margin-bottom:8px;">上の<b>「別アカウント（専用ログイン）で動かす」をON</b>にする</li>
        <li><b>「アカウントを確認」</b>でメール・プラン・組織が表示されれば成功。違うアカウントだったら「ログアウト」して入れ直し</li>
      </ol>
    </details>
  </div>
  <div class="sgroup">
    <div class="stitle">APIキー</div>
    ${[
        { name: "Claude", key: "anthropicApiKey" },
        { name: "GPT", key: "openaiApiKey" },
        { name: "Gemini", key: "geminiApiKey" },
    ].map((p) => {
        const on = keyStatus(p.key);
        return `<div class="srow"><span class="slabel">${p.name}</span>` +
            `<span class="${on ? "ok" : "warn"}">${on ? "設定済み" : "未設定"}</span>` +
            `<button class="tbtn" onclick="vscode.postMessage({type:'openApiKeySetting',key:'${p.key}'})">編集</button></div>`;
    }).join("")}
    <div class="snote">モデル名の接頭辞でプロバイダを自動判定します（claude-* / gpt-* / gemini-*）。使うモデルのキーだけ設定すればOKです。削除・入れ替えは「編集」から: 空のまま Enter で削除、新しいキーを貼れば上書き。</div>
  </div>
</div>`;
    }

    // AI_NOTE: ワークスペースのPythonファイルとimport依存を解析する。currentDocのフォルダを優先。
    private ensureProject(): void {
        // AI_NOTE: Webviewの再描画でも構成タブの選択状態は復元される。そこで毎回解析を始めると、
        // 完了後の再描画→自動解析が無限に続くため、初回だけ解析する。
        if (this.projectData || this.projectAnalyzing) return;
        this.analyzeProject().catch((e) => console.error("[AI Code Guide] project auto-analyze failed:", e));
    }

    private async analyzeProject(render = true): Promise<void> {
        if (this.projectAnalysisTask) {
            await this.projectAnalysisTask;
            return;
        }
        if (render && !this.view) return;
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return;
        let dir = folders[0].uri.fsPath;
        if (this.currentDoc) {
            const wf = vscode.workspace.getWorkspaceFolder(this.currentDoc.uri);
            if (wf) dir = wf.uri.fsPath;
        }
        const analysis = (async () => {
            this.projectAnalyzing = true;
            if (render && this.view) this.view.webview.html = this.buildHtml();
            try {
                const result = await extractProjectGraph(this.extensionPath, dir);
                if (!result.error) {
                    this.projectData = { nodes: result.nodes, edges: result.edges };
                    this.projectRoot = result.projectDir;
                    this.projectDiagramHistory = this.projectDiagramStore.list(this.projectDiagramWorkspaceKey());
                    // AI_NOTE: 最後に開いていた図そのものは復元せず、履歴から利用者が選ぶ。意図しない表示復活を避ける。
                    // AI_NOTE: #6 永続キャッシュからファイル/ディレクトリ解説を復元(あればボタン無しで表示)
                    const key = this.projectDescKey();
                    const cached = this.llmCache.get<{ files: Record<string, string>; dirs: Record<string, string> }>(key);
                    if (cached) { this.projectFileDescs = cached.files ?? {}; this.projectDirDescs = cached.dirs ?? {}; }
                }
            } finally {
                this.projectAnalyzing = false;
                if (render && this.view) this.view.webview.html = this.buildHtml();
            }
        })();
        this.projectAnalysisTask = analysis;
        try {
            await analysis;
        } finally {
            if (this.projectAnalysisTask === analysis) this.projectAnalysisTask = null;
        }
    }

    // AI_NOTE: #6 プロジェクト解説の永続キャッシュキー。ファイル構成(rel_path+関数)のハッシュで内容変化に追従する。
    private projectDescKey(): string {
        const sig = (this.projectData?.nodes ?? [])
            .map((n) => `${n.rel_path}:${n.functions.join(",")}`)
            .join("|");
        return `projdesc::${fnv1a(sig)}`;
    }

    // AI_NOTE: #6 「AI説明」押下時。全ファイル+全ディレクトリの役割をLLMで生成し永続キャッシュへ保存して再描画する。
    private async generateProjectDescs(): Promise<void> {
        if (this.projectDescGenerating || !this.projectData || !this.view) return;
        const { nodes } = this.projectData;
        this.projectDescGenerating = true;
        this.view.webview.html = this.buildHtml();
        try {
            const fileRes = await generateFileDescriptions(nodes.map((n) => ({ id: n.id, name: n.rel_path, functions: n.functions })));
            for (const [id, d] of fileRes) this.projectFileDescs[id] = d;
            // ディレクトリ別に関数を集約して解説生成
            const byDir = new Map<string, string[]>();
            for (const n of nodes) {
                const d = n.dir || ".";
                if (!byDir.has(d)) byDir.set(d, []);
                byDir.get(d)!.push(...n.functions);
            }
            const dirRes = await generateDirDescriptions(Array.from(byDir.entries()).map(([name, fns]) => ({ name, functions: fns.slice(0, 20) })));
            for (const [name, d] of dirRes) this.projectDirDescs[name] = d;
            this.llmCache.set(this.projectDescKey(), { files: this.projectFileDescs, dirs: this.projectDirDescs });
        } finally {
            this.projectDescGenerating = false;
            if (this.view) this.view.webview.html = this.buildHtml();
        }
    }

    // AI_NOTE: LLMが選んだ地点は解析済み一覧と実ファイルへ照合する。照合できたノード同士の線だけ残すことで、
    // 自由な図生成を許しつつ、クリック先のない架空コードを表示しない。
    private async generateProjectDiagram(question: string, render = true): Promise<void> {
        const normalizedQuestion = question.trim();
        if (!normalizedQuestion) return;
        if (this.projectDiagramGeneration) {
            await this.projectDiagramGeneration;
            // 同じ要求の同時実行は先行結果を共有する。先行が失敗した場合だけ、この呼び出しが再試行する。
            if (this.projectDiagram?.question === normalizedQuestion) return;
        }
        const generation = this.runProjectDiagramGeneration(normalizedQuestion, render);
        this.projectDiagramGeneration = generation;
        try {
            await generation;
        } finally {
            if (this.projectDiagramGeneration === generation) this.projectDiagramGeneration = null;
        }
    }

    private async runProjectDiagramGeneration(question: string, render = true): Promise<void> {
        if (this.projectDiagramGenerating || !question.trim()) return;
        if (!this.projectData) await this.analyzeProject(render);
        if (!this.projectData) return;
        this.projectDiagramGenerating = true;
        this.projectDiagramError = "";
        if (render && this.view) this.view.webview.html = this.buildHtml();
        try {
            const nodes = this.projectData.nodes;
            const pathById = new Map(nodes.map((node) => [node.id, node.rel_path]));
            const raw = await generateProjectDiagram(question.trim(), nodes.map((n) => {
                const symbols = n.symbols ?? n.functions;
                return {
                    path: n.rel_path,
                    symbols,
                    anchors: this.projectSymbolAnchors(n.path, symbols),
                    imports: this.projectData!.edges
                        .filter((edge) => edge.from === n.id)
                        .flatMap((edge) => pathById.get(edge.to) ?? []),
                    source: buildProjectDiagramSourceExcerpt(n.path, symbols, question),
                };
            }));
            if (!raw) throw new Error("図にできる関係が見つかりませんでした");
            const byPath = new Map(nodes.map((n) => [n.rel_path, n]));
            const located: LocatedProjectDiagram["nodes"] = [];
            const usedSteps = new Set<string>();
            const usedIds = new Set<string>();
            for (const candidate of raw.nodes) {
                const file = byPath.get(candidate.file);
                if (!file || (candidate.symbol && !(file.symbols ?? file.functions).includes(candidate.symbol))) continue;
                const source = fs.readFileSync(file.path, "utf8");
                if (candidate.symbol && (!candidate.anchor || !source.includes(candidate.anchor))) continue;
                const key = projectDiagramStepKey({ ...candidate, file: file.rel_path });
                if (!candidate.id || usedIds.has(candidate.id) || usedSteps.has(key)) continue;
                usedIds.add(candidate.id);
                usedSteps.add(key);
                located.push({
                    ...candidate,
                    file: file.rel_path,
                    label: candidate.label.trim().slice(0, 28),
                    description: candidate.description?.trim().slice(0, 60) ?? "",
                    emphasis: candidate.emphasis,
                    emphasisReason: candidate.emphasis ? candidate.emphasisReason?.trim().slice(0, 90) ?? "" : "",
                    line: this.findProjectAnchorLine(file.path, candidate.symbol, candidate.anchor),
                });
            }
            const validIds = new Set(located.map((node) => node.id));
            const edgeKeys = new Set<string>();
            const edges = collapseProjectDiagramEdges(raw.edges, validIds).filter((edge) => {
                const key = `${edge.from}->${edge.to}`;
                if (edge.from === edge.to || edgeKeys.has(key)) return false;
                edgeKeys.add(key);
                return true;
            }).map((edge) => ({ ...edge, label: edge.label.trim().slice(0, 12) }));
            if (located.length === 0) throw new Error("コード上で確認できる地点がありませんでした");
            const connectivity = projectDiagramConnectivity(located, edges);
            if (!connectivity.connected) {
                throw new Error(`コード照合後に未接続の地点があります: ${connectivity.disconnectedNodeIds.join(", ")}`);
            }
            const diagram: LocatedProjectDiagram = {
                kind: raw.kind,
                title: raw.title.trim().slice(0, 40) || question.trim().slice(0, 40),
                summary: raw.summary?.trim().slice(0, 140) ?? "",
                nodes: located,
                edges,
            };
            const normalizedQuestion = question.trim();
            const historyEntry = this.projectDiagramStore.add(this.projectDiagramWorkspaceKey(), normalizedQuestion, diagram);
            this.projectDiagram = { question: normalizedQuestion, diagram };
            this.selectedProjectDiagramHistoryId = historyEntry.id;
            this.projectDiagramHistory = this.projectDiagramStore.list(this.projectDiagramWorkspaceKey());
        } catch (error) {
            this.projectDiagram = null;
            this.selectedProjectDiagramHistoryId = null;
            this.projectDiagramError = `図を作れませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.projectDiagramGenerating = false;
            if (render && this.view) this.view.webview.html = this.buildHtml();
        }
    }

    private projectDiagramWorkspaceKey(): string {
        return this.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    }

    // AI_NOTE: 保存時の行番号はヒントに留め、履歴を開くたびにシンボルから現在位置を取り直す。
    // 消えたノードと、そのノードへ接続していた線は図から同時に外す。
    private restoreProjectDiagram(entry: ProjectDiagramHistoryEntry): { question: string; diagram: LocatedProjectDiagram } | null {
        const projectNodes = this.projectData?.nodes ?? [];
        const nodes = entry.diagram.nodes.flatMap((saved) => {
            const file = projectNodes.find((candidate) => candidate.rel_path === saved.file);
            if (!file || (saved.symbol && !(file.symbols ?? file.functions).includes(saved.symbol))) return [];
            return [{ ...saved, line: saved.symbol ? this.findProjectAnchorLine(file.path, saved.symbol, saved.anchor) : 0 }];
        });
        if (nodes.length === 0) return null;
        const ids = new Set(nodes.map((node) => node.id));
        const edges = entry.diagram.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
        return { question: entry.question, diagram: { ...entry.diagram, nodes, edges } };
    }

    private selectProjectDiagramHistory(id: string): void {
        const entry = this.projectDiagramHistory.find((item) => item.id === id);
        if (!entry) return;
        this.projectDiagram = this.restoreProjectDiagram(entry);
        this.selectedProjectDiagramHistoryId = this.projectDiagram ? entry.id : null;
        this.projectDiagramError = this.projectDiagram ? "" : "この図のコードは変更・削除されたため、表示できる地点がありません。";
        if (this.view) this.view.webview.html = this.buildHtml();
    }

    private deleteProjectDiagramHistory(id: string): void {
        this.projectDiagramStore.remove(this.projectDiagramWorkspaceKey(), id);
        if (this.selectedProjectDiagramHistoryId === id) this.selectedProjectDiagramHistoryId = null;
        this.projectDiagramHistory = this.projectDiagramStore.list(this.projectDiagramWorkspaceKey());
        if (this.view) this.view.webview.html = this.buildHtml();
    }

    private findProjectSymbolLine(filePath: string, symbol: string): number {
        if (!symbol) return 0;
        try {
            const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
            const match = findProjectSymbolLineInLines(lines, symbol);
            return match >= 0 ? match : 0;
        } catch { return 0; }
    }

    private findProjectAnchorLine(filePath: string, symbol: string, anchor: string): number {
        if (!symbol) return 0;
        try {
            const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
            const match = findProjectAnchorLineInLines(lines, symbol, anchor);
            return match >= 0 ? match : 0;
        } catch { return 0; }
    }

    private projectSymbolAnchors(filePath: string, symbols: string[]): string[] {
        try {
            const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
            return symbols.map((symbol) => {
                const index = findProjectSymbolLineInLines(lines, symbol);
                return index >= 0 ? lines[index].trim() : "";
            }).filter(Boolean);
        } catch { return []; }
    }

    private projectSymbolLineInLines(lines: string[], symbol: string): number {
        const parts = symbol.split(".");
        const name = parts.pop() ?? symbol;
        let start = 0;
        let classIndent = -1;
        if (parts.length) {
            const className = parts.join(".");
            const classIndex = lines.findIndex((line) => new RegExp(`^(\\s*)class\\s+${escapeRegExp(className)}\\b`).test(line));
            if (classIndex < 0) return -1;
            start = classIndex + 1;
            classIndent = (lines[classIndex].match(/^\\s*/) ?? [""])[0].length;
        }
        const def = new RegExp(`^(\\s*)(?:async\\s+def|def)\\s+${escapeRegExp(name)}\\s*\\(`);
        const classDef = new RegExp(`^(\\s*)class\\s+${escapeRegExp(name)}\\b`);
        for (let i = start; i < lines.length; i++) {
            const match = lines[i].match(def) ?? (classIndent < 0 ? lines[i].match(classDef) : null);
            if (match && (classIndent < 0 || match[1].length > classIndent)) return i;
            if (classIndent >= 0 && lines[i].trim() && (lines[i].match(/^\\s*/) ?? [""])[0].length <= classIndent) break;
        }
        return -1;
    }

    private async openProjectSymbol(filePath: string, line: number): Promise<vscode.TextEditor | undefined> {
        const uri = vscode.Uri.file(filePath);
        const targetUri = uri.toString();
        const currentUri = this.currentDoc?.uri.toString();
        // AI_NOTE: 同じファイルは解析済みカードをそのまま使う。再解析するとactive editor側のrefreshと競合し、
        // 後から終わった再描画が青い強調を消すため、別ファイルへ移る時だけready待ちへ渡す。
        this.pendingStandardFocus = currentUri === targetUri ? null : { uri: targetUri, line };
        const editor = await vscode.window.showTextDocument(uri, { preview: false });
        if (line >= 0 && line < editor.document.lineCount) {
            const range = new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length);
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
        if (currentUri === targetUri) {
            const node = this.nodeAtLine(line);
            await this.reveal("standard");
            this.view?.webview.postMessage({ type: "focusStandardCard", nodeId: node?.id ?? "" });
        } else if (this.currentDoc?.uri.toString() !== targetUri) {
            // active editor変更イベントが発火しない状態でも、図からの移動だけでカード表示まで完結させる。
            await this.refresh(editor.document);
        }
        return editor;
    }

    private buildProjectDiagramFinder(): string {
        const historyHtml = this.projectDiagramHistory.length
            ? `<details class="project-diagram-history"><summary>過去の図（${this.projectDiagramHistory.length}件）</summary>${this.projectDiagramHistory.map((entry) => {
                const selected = this.selectedProjectDiagramHistoryId === entry.id;
                const date = new Date(entry.createdAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
                const id = escapeHtml(entry.id).replace(/'/g, "\\'");
                return `<div class="project-diagram-history-row"><button class="tbtn${selected ? " on" : ""}" onclick="vscode.postMessage({type:'selectProjectDiagramHistory',text:'${id}'})">${escapeHtml(entry.question)}</button><span class="project-diagram-history-date">${date}</span><button class="tbtn" title="この履歴を削除" onclick="vscode.postMessage({type:'deleteProjectDiagramHistory',text:'${id}'})">×</button></div>`;
            }).join("")}</details>`
            : `<div class="project-diagram-history"><div>過去の図（0件）</div><div class="odir-desc">まだありません。ここで作った図は次回から残ります。</div></div>`;
        const controls = `<div style="display:flex;gap:6px"><input id="project-diagram-query" placeholder="例: 注文が保存されるまで" style="flex:1;min-width:0" onkeydown="if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229)vscode.postMessage({type:'findProjectDiagram',text:this.value})"><button class="tbtn${this.projectDiagramGenerating ? " busy" : ""}" ${this.projectDiagramGenerating ? "disabled" : ""} onclick="vscode.postMessage({type:'findProjectDiagram',text:document.getElementById('project-diagram-query').value})">${this.projectDiagramGenerating ? "作成中…" : "図にする"}</button></div>${this.projectDiagramError ? `<div class="odir-desc">${escapeHtml(this.projectDiagramError)}</div>` : ""}${historyHtml}`;
        if (this.projectDiagram) {
            return `<details class="process-map-finder compact"${this.projectDiagramGenerating ? " open" : ""}><summary>別の図を作る・履歴（${this.projectDiagramHistory.length}件）</summary><div class="process-map-finder-body">${controls}</div></details>`;
        }
        return `<div class="process-map-finder"><div class="process-map-title">知りたいことを図にする</div>${controls}</div>`;
    }

    // AI_NOTE: 外部AIへ図を渡す試作では、安定した1つのパスを毎回更新する。
    // 既定ブラウザで即確認しつつ絶対パスもコピーし、Codex / Claude Codeの会話へそのまま貼れるようにする。
    private async openProjectDiagramHtml(): Promise<void> {
        if (!this.projectDiagram) {
            vscode.window.showInformationMessage("AI Code Guide: 先に質問からコード図を作成してください。");
            return;
        }
        await this.writeProjectDiagramHtml(true, true);
    }

    // AI_NOTE: UIボタンとエージェントCLIで同じ自己完結HTMLを使う。CLI経路は利用者の
    // クリップボードを上書きせず、戻り値のパスを機械可読JSONへ載せる。
    private async writeProjectDiagramHtml(openExternal: boolean, copyPath: boolean): Promise<string> {
        if (!this.projectDiagram) {
            throw new Error("先に質問からコード図を作成してください");
        }
        await fs.promises.mkdir(this.globalStoragePath, { recursive: true });
        const filePath = path.join(this.globalStoragePath, "project-diagram-preview.html");
        const workspaceRoot = this.projectRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const bridge = await this.projectDiagramBridgeReady;
        const html = buildStandaloneProjectDiagramHtml(this.projectDiagram.question, this.projectDiagram.diagram, workspaceRoot, bridge);
        await fs.promises.writeFile(filePath, html, "utf8");
        if (copyPath) await vscode.env.clipboard.writeText(filePath);
        const opened = openExternal ? await vscode.env.openExternal(vscode.Uri.file(filePath)) : false;
        if (copyPath) {
            const message = opened
                ? "AI Code Guide: HTMLを開き、ファイルパスをコピーしました。"
                : "AI Code Guide: HTMLを作成し、ファイルパスをコピーしました。";
            vscode.window.showInformationMessage(message);
        }
        return filePath;
    }

    // AI_NOTE: 図の種類や凡例を常設せず、質問に必要なノードと線だけをサイドバー用の縦長HTMLへ渡す。
    // 各ノードのクリックは実在確認済みのファイル・行へ移動する。
    private buildProcessPane(): string {
        const finderHtml = this.buildProjectDiagramFinder();
        if (!this.projectData) {
            return `${finderHtml}<div class="process-map-empty">${this.projectAnalyzing ? "プロジェクトを解析中…" : "対応コードの構成を解析すると、質問に合う図を作成できます。"}</div>`;
        }
        if (!this.projectDiagram) {
            return `${finderHtml}<div class="process-map-empty">処理の流れや機能の依存関係など、コードについて知りたいことを入力してください。</div>`;
        }
        const diagramHtml = buildProjectDiagramHtml(this.projectDiagram.diagram);
        const summary = this.projectDiagram.diagram.summary?.trim();
        const summaryHtml = summary
            ? `<div class="process-diagram-summary">${escapeHtml(summary)}</div>`
            : "";
        const interactionHint = this.projectDiagram.diagram.kind === "flow"
            ? "図形を選ぶと詳細を表示し、「コードへ」から移動します"
            : "ノードを押すとコードへ移動します";
        return `${finderHtml}<div class="process-diagram-head"><div class="process-diagram-title">${escapeHtml(this.projectDiagram.diagram.title)}</div><button class="tbtn" title="ブラウザで開き、Codex / Claude Codeへ渡せるパスをコピー" onclick="vscode.postMessage({type:'openProjectDiagramHtml'})">HTMLで開く</button><button class="tbtn" onclick="vscode.postMessage({type:'clearProjectDiagram'})">閉じる</button></div>${summaryHtml}<div class="process-diagram">${diagramHtml}</div><div class="process-diagram-hint">${interactionHint}</div>`;
    }

    // AI_NOTE: プロジェクトタブ本体。ディレクトリ別にファイルカードを並べ、各ファイルのimport先を示す。クリックで開く。
    private buildProjectPane(): string {
        if (!this.projectData) {
            // AI_NOTE: リポジトリ設計はPython構成の解析を待たずに読める。検索後だけ急に現れるのを避け、初期画面から出す。
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
            const repoDesign = root ? loadRepoDesign(root) : null;
            const initialDesignHtml = repoDesign
                ? this.buildFreeformDesignBlock(repoDesign, "設計: リポジトリ") + this.buildDesignUpdateLink("repo", "")
                : (root ? this.buildDesignEntryButton("repo", "") : "");
            const analyzeHtml = this.projectAnalyzing
                ? `<div class="msg">構成を解析中…</div>`
                : `<div style="text-align:center;margin-top:10px;"><button class="tbtn" onclick="vscode.postMessage({type:'analyzeProject'})">構成だけ解析</button></div>`;
            return `${initialDesignHtml}${analyzeHtml}`;
        }
        if (this.projectAnalyzing) return `<div class="msg">プロジェクトを解析中…</div>`;
        const { nodes, edges } = this.projectData;
        if (nodes.length === 0) return `<div class="msg">対応するコードファイルが見つかりませんでした</div>`;
        const idToRel = new Map(nodes.map((n) => [n.id, n.rel_path]));
        const importsOf = new Map<string, string[]>();
        for (const e of edges) {
            if (!importsOf.has(e.from)) importsOf.set(e.from, []);
            const rel = idToRel.get(e.to);
            if (rel) importsOf.get(e.from)!.push((rel.split("/").pop() ?? rel));
        }
        // AI_NOTE: #6 ディレクトリ別にグループ化し、パス順(階層順)に並べる。深さでインデントして階層を見せる。
        const byDir = new Map<string, ProjectFileNode[]>();
        for (const n of nodes) {
            const d = n.dir || ".";
            if (!byDir.has(d)) byDir.set(d, []);
            byDir.get(d)!.push(n);
        }
        const palette = ["#4ec9b0", "#c586c0", "#dcdcaa", "#4fc1ff", "#f48771", "#9cdcfe", "#569cd6"];
        let colorIdx = 0;
        const dirNames = Array.from(byDir.keys()).sort();

        const groups = dirNames
            .map((d) => {
                const depth = d === "." ? 0 : d.split("/").length;
                const indent = depth * 10;
                const dirDesign = this.projectRoot ? loadDirDesign(this.projectRoot, d) : null;
                const dirDesignHtml = dirDesign
                    ? this.buildFreeformDesignBlock(dirDesign, "設計: ディレクトリ") + this.buildDesignUpdateLink("directory", d)
                    : (this.projectRoot ? this.buildDesignDirLink(d) : "");
                const dirDesc = this.projectDirDescs[d];
                const dirHeader = `<div class="odir" style="margin-left:${indent}px">
                  <span class="odir-name">${escapeHtml(d === "." ? "(ルート)" : (d.split("/").pop() ?? d))}</span>
                  ${dirDesignHtml}
                  ${dirDesc ? `<div class="odir-desc">${escapeHtml(dirDesc)}</div>` : ""}
                </div>`;
                const cards = byDir.get(d)!
                    .map((n) => {
                        const accent = palette[colorIdx++ % palette.length];
                        const fileDesc = this.projectFileDescs[n.id];
                        const deps = importsOf.get(n.id) ?? [];
                        const depLine = deps.length > 0 ? `<div class="odep">→ ${escapeHtml(deps.join(", "))}</div>` : "";
                        const descLine = fileDesc ? `<div class="ofile-desc">${escapeHtml(fileDesc)}</div>` : "";
                        const safePath = escapeHtml(n.path).replace(/'/g, "\\'");
                        const hasProjEdge = edges.some((e) => e.from === n.id || e.to === n.id);
                        const pRefBtn = hasProjEdge ? `<span class="ref-btn" title="import関係を強調" onclick="event.stopPropagation();onProjRefClick(event,'${escapeHtml(n.id)}')">参照</span>` : "";
                        // AI_NOTE: 対応する設計md(<relpath>.md)が存在するファイルだけ「設計」バッジを出す(中身は概要タブで読む。ここは有無のみ)。
                        const hasDesign = this.projectRoot ? designFileExists(this.projectRoot, n.rel_path) : false;
                        const designBadge = hasDesign ? `<span class="dtag dtag-has-design" title="設計ファイルあり">設計</span>` : "";
                        return `<div class="card pfile" data-id="${escapeHtml(n.id)}" style="--accent:${accent};margin-left:${indent + 10}px" onclick="vscode.postMessage({type:'openFile',text:'${safePath}'})">
                          <span class="kind">PY</span>
                          <span class="label">${escapeHtml(n.rel_path.split("/").pop() ?? n.rel_path)}</span>
                          ${designBadge}${pRefBtn}${descLine}${depLine}
                        </div>`;
                    })
                    .join("");
                return dirHeader + cards;
            })
            .join("");

        const repoDesign = this.projectRoot ? loadRepoDesign(this.projectRoot) : null;
        const repoDesignHtml = repoDesign
            ? this.buildFreeformDesignBlock(repoDesign, "設計: リポジトリ") + this.buildDesignUpdateLink("repo", "")
            : (this.projectRoot ? this.buildDesignEntryButton("repo", "") : "");
        const toolbar = `<div id="toolbar">
          <button class="tbtn${this.projectDescGenerating ? " busy" : ""}" onclick="vscode.postMessage({type:'generateProjectDescs'})" ${this.projectDescGenerating ? "disabled" : ""}>${this.projectDescGenerating ? "生成中…" : "AI説明"}</button>
          <button class="tbtn${this.projectArrows ? " on" : ""}" onclick="vscode.postMessage({type:'toggleProjectArrows'})">矢印: ${this.projectArrows ? "ON" : "OFF"}</button>
          <button class="tbtn" onclick="vscode.postMessage({type:'analyzeProject'})">再解析</button>
        </div>`;
        const svg = this.projectArrows
            ? `<svg id="proj-svg" xmlns="http://www.w3.org/2000/svg"><defs><marker id="parr-head" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4fc1ff"/></marker></defs></svg>`
            : "";
        const projAreaCls = `${this.projectArrows ? "arrows-on" : ""}${this.arrowSide === "right" ? " side-right" : ""}`;
        return `${toolbar}${repoDesignHtml}<div id="proj-area" class="${projAreaCls}">${svg}${groups}</div>`;
    }

    // AI_NOTE: overviewがあればサブカード群の前に関数=目的/入力/出力、クラス=役割/状態/主な機能の箱を出す。行ジャンプ対象ではないためクリック無し。
    private buildOverviewBox(overview: BlockOverview, kind: GraphNode["kind"]): string {
        // AI_NOTE: クラスは入出力で説明すると責務がぼやけるため、インスタンスの役割・保持状態・提供機能に置き換える。
        const rows: Array<[string, string, string]> = kind === "class"
            ? [
                ["役割", overview.purpose, "#4fc1ff"],
                ["状態", overview.state ?? "", "#73c991"],
                ["主な機能", overview.behavior ?? "", "#e2b93d"],
            ]
            : [
                ["目的", overview.purpose, "#4fc1ff"],
                ["入力", overview.input, "#73c991"],
                ["出力", overview.output, "#e2b93d"],
            ];
        const visibleRows = [
            ...rows.filter(([, value]) => value.trim() !== ""),
            ...(overview.note ? [["補足", overview.note, "#f0a500"] as [string, string, string]] : []),
        ];
        const rowsHtml = visibleRows.map(([k, v, c]) => `<div class="so-row"><span class="so-k" style="--sok:${c}">${escapeHtml(k)}</span><div class="so-v">${escapeHtml(v)}</div></div>`).join("");
        return `<div class="subover">${rowsHtml}</div>`;
    }

    // AI_NOTE: ▶展開時の内容。生成中(空)は「分解中…」、overviewがあれば先頭に目的/入力/出力を出し、続けてサブカード群。
    // 設計サブブロック(designBlock)はAI概要(overview)の生成状態と無関係(設計ファイルは人が確認した別ソースのため)、
    // 常に先頭に出す(生成中・失敗表示の前段にも見えるべき)。
    private buildSubCards(nodeId: string, sym: DesignSymbol | undefined, designIssues: DesignIssue[], includeDesign = true): string {
        const designBlock = includeDesign ? this.buildDesignSymbolBlock(sym, designIssues) : "";
        const data = this.expandedData[nodeId];
        // AI_NOTE: 開いた詳細も保存で勝手に再生成しない。旧本文を最新の座標に対応させない。
        if (this.staleExpansions.has(nodeId)) {
            return `<div class="subwrap"><div class="submsg">編集前の説明です。<button class="tbtn" onclick="vscode.postMessage({type:'retryExpand',nodeId:'${escapeHtml(nodeId)}'})">詳細を更新</button></div><div>${escapeHtml(data?.overview?.purpose ?? "")}</div></div>`;
        }
        if (this.expandGenerating.has(nodeId)) {
            return `<div class="subwrap">${designBlock}<div class="submsg">分解中…</div></div>`;
        }
        const subs = data?.blocks ?? [];
        const overview = data?.overview ?? null;
        if (subs.length === 0 && overview === null) {
            // AI_NOTE: #1 生成完了で空 = 失敗。APIキー未設定/通信失敗の可能性。再試行可。
            return `<div class="subwrap">${designBlock}<div class="submsg">分解できませんでした（APIキー未設定や通信失敗の可能性）。<a href="#" onclick="event.preventDefault();vscode.postMessage({type:'retryExpand',nodeId:'${escapeHtml(nodeId)}'})">再試行</a></div></div>`;
        }
        const kind = this.graphNodes.find((n) => n.id === nodeId)?.kind ?? "block";
        const overviewHtml = overview ? this.buildOverviewBox(overview, kind) : "";
        const cards = subs
            .map((b, i) => `<div class="subcard" style="--saccent:${SUB_PALETTE[i % SUB_PALETTE.length]}"
              data-parent="${escapeHtml(nodeId)}" data-line-start="${b.lineStart}" data-line-end="${b.lineEnd}"
              onclick="vscode.postMessage({type:'jumpCode',lineStart:${b.lineStart},lineEnd:${b.lineEnd}})">
              <div class="sublabel">${escapeHtml(b.label)}</div>
              <div class="subdesc">${escapeHtml(b.description)}</div>
            </div>`)
            .join("");
        return `<div class="subwrap">${designBlock}${overviewHtml}${cards}</div>`;
    }

    // AI_NOTE: 単一関数のフローチャート本体。「↩ 全体」で概要へ戻れる(#4方針)。mermaidソースをdivに入れ、webview側で描画。
    private buildFuncFlowchart(): string {
        if (!this.funcGraph) return "";
        const colorMap = assignNodeColors(this.funcGraph.nodes);
        // AI_NOTE: 文言トグルがONの時だけ日本語文言を labelOverrides で差し込む。グラフ構造・色は共通(既定=コードのまま)。
        const overrides = this.naturalMode && this.naturalLabels
            ? new Map(Object.entries(this.naturalLabels))
            : new Map<string, string>();
        const code = buildMermaidCode(this.funcGraph.nodes, this.funcGraph.edges, colorMap, overrides);
        const naturalBtn = this.naturalGenerating
            ? `<button class="tbtn busy" disabled>言い換え中…</button>`
            : `<button class="tbtn${this.naturalMode ? " on" : ""}" title="ノードの文言をコード⇄日本語で切り替える（日本語は初回のみAI生成・トークン消費）" onclick="vscode.postMessage({type:'toggleNaturalLabels'})">文言: ${this.naturalMode ? "日本語" : "コード"}</button>`;
        return `<div id="fc-head">
      <button class="tbtn" onclick="vscode.postMessage({type:'backToOverview'})">↩ 全体</button>
      <span class="fc-title">⑂ ${escapeHtml(this.targetFunc)}()</span>
      ${naturalBtn}
      <span class="fc-zoom">
        <button class="tbtn" title="縮小" onclick="fcZoom(-0.2)">−</button>
        <span id="fc-zoom-lbl">100%</span>
        <button class="tbtn" title="拡大" onclick="fcZoom(0.2)">＋</button>
        <button class="tbtn" title="等倍に戻す" onclick="fcZoomReset()">リセット</button>
      </span>
    </div>
    <div class="mermaid">${escapeForMermaid(code)}</div>`;
    }

    // AI_NOTE: graphNodes をカード化。kind別に左ボーダー色を割り当てて種類を一目で分かるようにする
    // AI_NOTE: ④ 見出しは関数名のみ(引数を落とす。概要タブと統一)。クラス/blockはそのまま。
    // AI説明はラベルに詰め込まず buildCardHtml で独立行(.desc)に出す(クラスの grp-desc と体裁統一)。
    private cardLabel(n: GraphNode): string {
        return n.kind === "function" ? n.label.split("(")[0] : n.label;
    }

    // AI_NOTE: ファイル全体ヘッダーHTML。1行目=型の自然な説明文(バッジでなく文にして「何の分類か」を伝える)、2行目=役割。未生成なら空文字。
    // 文言・色クラスは kind ごとに FILE_TYPE_META が持つ(分類器側 FileKind と1対1)。
    private buildFileHeader(): string {
        if (!this.fileOverview) return "";
        const { kind, role } = this.fileOverview;
        const meta = FILE_TYPE_META[kind] ?? FILE_TYPE_META.definitions;
        return `<div class="file-header ${meta.cls}">
          <div class="fh-type">${meta.text}</div>
          <div class="fh-role">${escapeHtml(role)}</div>
        </div>`;
    }

    // AI_NOTE: 設計フェーズ1・ステップ3前半。currentDocのworkspaceRootから .ai-code-guide/design/<相対パス>.md を
    // 都度読む(キャッシュ不要=1回のファイル読みは軽い)。workspaceFolderが取れない/対象外なら null。
    private currentDesign(): DesignLookup | null {
        if (!this.currentDoc) return null;
        const wf = vscode.workspace.getWorkspaceFolder(this.currentDoc.uri);
        if (!wf) return null;
        return loadDesignForSource(wf.uri.fsPath, this.currentDoc.uri.fsPath);
    }

    // AI_NOTE: 設計フェーズ1・ステップ3後半。リポ/ディレクトリ粒度の自由記述設計(_repo.md/_dir.md)を段落表示する。
    // designParser前提のセクション構造は無いため、改行を保った本文をそのままescapeして出す(構造化レンダリング不要という合意どおり)。
    private buildFreeformDesignBlock(design: FreeformDesign | null, heading: string): string {
        if (!design || !design.text) return "";
        // AI_NOTE: [磨き] "# 見出し"の#記号が生のまま出ていた問題の修正。行頭の#〜######を剥がし見出し行は太字にする。
        // それ以外の行(- 箇条書き含む)はそのままescapeして流す(構造化レンダリングはしない合意のため)。
        const body = design.text
            .split("\n")
            .map((line) => {
                const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
                return headingMatch ? `<strong>${escapeHtml(headingMatch[1])}</strong>` : escapeHtml(line);
            })
            .join("<br>");
        return `<div class="design-block design-block-full">
          <div class="design-heading">${escapeHtml(heading)}</div>
          <div class="design-purpose-row">${provenanceBadge(design.provenance)}<span class="design-purpose-text">${body}</span></div>
        </div>`;
    }

    // AI_NOTE: currentDocのworkspace相対パス(スラッシュ区切り)。空欄入口ボタンのscope=fileに使う。取れなければnull。
    private currentFileRelPath(): string | null {
        if (!this.currentDoc) return null;
        const wf = vscode.workspace.getWorkspaceFolder(this.currentDoc.uri);
        if (!wf) return null;
        return path.relative(wf.uri.fsPath, this.currentDoc.uri.fsPath).split(path.sep).join("/");
    }

    // AI_NOTE: 空欄入口ボタン(4番)。設計ファイルが無いタブ枠に「作る」導線を出す。QuickPickは経由せず、
    // 見ている場所=範囲としてscope(kind+relPath)をそのままメッセージへ積む(createDesignFileハンドラ側でbuildDesignPrompt)。
    private buildDesignEntryButton(kind: DesignScope["kind"], relPath: string): string {
        const safe = relPath.replace(/'/g, "\\'");
        return `<div class="design-entry">
          <button class="tbtn on" onclick="vscode.postMessage({type:'createDesignFile',text:'${kind}',label:'${safe}'})">設計ファイルを作る（プロンプトをコピー）</button>
          <div class="design-entry-hint">コピーしたプロンプトを Claude Code / codex に貼ると、ヒアリングの後に設計ファイルが作られます。</div>
        </div>`;
    }

    // AI_NOTE: プロジェクトタブの各ディレクトリ見出し用。ボタンを乱立させないため小さいリンク風にする(合意どおり)。
    private buildDesignDirLink(relPath: string): string {
        const safe = relPath.replace(/'/g, "\\'");
        return `<span class="design-dir-link" title="このディレクトリの設計ファイルを作る" onclick="event.stopPropagation();vscode.postMessage({type:'createDesignFile',text:'directory',label:'${safe}'})">設計を作る</span>`;
    }

    // AI_NOTE: 設計が既にある箇所用の更新入口。createDesignFileと同じメッセージを送り、ハンドラ側が
    // 既存mdの有無で更新モードに切り替える(入口を分けず判定を1箇所に寄せる)。見た目は既存のリンク風を流用。
    private buildDesignUpdateLink(kind: DesignScope["kind"], relPath: string): string {
        const safe = relPath.replace(/'/g, "\\'");
        return `<span class="design-dir-link" title="既存の設計ファイルを更新するプロンプトをコピー（確認済みの記述は維持されます）" onclick="event.stopPropagation();vscode.postMessage({type:'createDesignFile',text:'${kind}',label:'${safe}'})">設計を更新</span>`;
    }

    // AI_NOTE: ファイル粒度の設計ブロック。概要タブの関数一覧カードの上に置く。設計mdが無ければ空欄入口ボタンに切り替える
    // (relPathが取れない=workspace外等のときはボタンも出さない)。
    private buildDesignFileBlock(design: DesignLookup | null, relPath: string | null): string {
        if (!design) return relPath ? this.buildDesignEntryButton("file", relPath) : "";
        // AI_NOTE: issueメッセージにシンボル名を含まないものをファイル粒度とみなす簡易分類
        // (parseDesignFileはissueをシンボル別に構造化して返さないため、メッセージ文言で判定する判断)。
        const fileIssues = design.issues.filter((i) => i.message.includes("frontmatter") || i.message.includes("ファイルの「目的」"));
        const purpose = design.file.filePurpose;
        if ((!purpose || !purpose.text) && fileIssues.length === 0) return "";
        const purposeRow = purpose && purpose.text
            ? `<div class="design-purpose-row">${provenanceBadge(purpose.provenance)}<span class="design-purpose-text">${escapeHtml(purpose.text)}</span></div>`
            : "";
        const warnings = fileIssues.map((i) => `<div class="design-issue">⚠ ${escapeHtml(i.message)}</div>`).join("");
        const updateLink = relPath ? this.buildDesignUpdateLink("file", relPath) : "";
        return `<div class="design-block">${purposeRow}${warnings}${updateLink}</div>`;
    }

    // AI_NOTE: 関数/クラスカード用の1行。同名シンボルの設計セクションが無ければ空文字(=何も出さない)。
    private buildDesignSymbolRow(sym: DesignSymbol | undefined, issues: DesignIssue[]): string {
        if (!sym?.sections.purpose?.text) return "";
        const { text, provenance } = sym.sections.purpose;
        const symIssues = issues.filter((i) => i.message.includes(sym.name));
        const warnings = symIssues.map((i) => `<div class="design-issue">⚠ ${escapeHtml(i.message)}</div>`).join("");
        return `<div class="design-symbol-row">${provenanceBadge(provenance)}<span class="design-purpose-text">${escapeHtml(text)}</span></div>${warnings}`;
    }

    // AI_NOTE: 設計フェーズ1・ステップ3中盤。標準タブ用フル表示(目的/要件・制約/方針/構成)。概要タブの
    // buildDesignSymbolRow(目的のみの1行)とは違い、設計ファイルにある全セクションをそのまま出す。
    // 構成はラベルのみ(アンカー文字列は出さない。コードへのジャンプはフェーズ2)。セクション単位で無ければ行ごと省略する。
    private buildDesignSymbolBlock(sym: DesignSymbol | undefined, issues: DesignIssue[]): string {
        if (!sym) return "";
        const { purpose, requirements, policy, construction } = sym.sections;
        const hasContent = !!purpose?.text || requirements.length > 0 || !!policy?.text || construction.length > 0;
        if (!hasContent) return "";
        const purposeRow = purpose?.text
            ? `<div class="design-purpose-row">${provenanceBadge(purpose.provenance)}<span class="design-purpose-text">${escapeHtml(purpose.text)}</span></div>`
            : "";
        const reqRows = requirements.length > 0
            ? `<div class="design-section-label">要件・制約</div>${requirements
                  .map((r) => `<div class="design-symbol-row">${provenanceBadge(r.provenance)}<span class="design-purpose-text">${escapeHtml(r.text)}</span></div>`)
                  .join("")}`
            : "";
        // AI_NOTE: 方針は「捨てた代替」等の補足行も含めて1段落として parseDesignFile が丸ごと text に集めている前提なので、そのまま全文を出す(要約・切り詰めしない)。
        const policyRow = policy?.text
            ? `<div class="design-section-label">方針</div><div class="design-symbol-row">${provenanceBadge(policy.provenance)}<span class="design-purpose-text">${escapeHtml(policy.text)}</span></div>`
            : "";
        const constructionRows = construction.length > 0
            ? `<div class="design-section-label">構成</div><ol class="design-construction">${construction
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((b) => `<li>${escapeHtml(b.label)}</li>`)
                  .join("")}</ol>`
            : "";
        const symIssues = issues.filter((i) => i.message.includes(sym.name));
        const warnings = symIssues.map((i) => `<div class="design-issue">⚠ ${escapeHtml(i.message)}</div>`).join("");
        return `<div class="design-block design-block-full">
          <div class="design-heading">設計</div>
          ${purposeRow}${reqRows}${policyRow}${constructionRows}${warnings}
        </div>`;
    }

    private buildCards(): string {
        if (this.graphNodes.length === 0) {
            return `<div class="msg">表示できる構造がありません</div>`;
        }
        // AI_NOTE: ② 矢印ON時は呼び出し関係のSVG矢印を重ねる。OFF時は全幅カード(現状)。
        const svg = this.arrowsEnabled
            ? `<svg id="arrow-svg" xmlns="http://www.w3.org/2000/svg"><defs>
                 <marker id="arr-head" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4fc1ff"/></marker>
                 <marker id="arr-head-out" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#f0a500"/></marker>
                 <marker id="arr-head-in" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4ec9b0"/></marker>
               </defs></svg>`
            : "";
        // AI_NOTE: parentで親→子をひく索引。クラスはコンテナとして子(メソッド/ネストクラス)を内包描画する。
        const childrenOf = new Map<string, GraphNode[]>();
        for (const n of this.graphNodes) {
            if (!n.parent) continue;
            const list = childrenOf.get(n.parent) ?? [];
            list.push(n);
            childrenOf.set(n.parent, list);
        }
        // AI_NOTE: 定義行順(ls)でトップレベルから再帰描画する。子を持つクラスは概要と共有の group-block
        // (タイトルバー+トグル+ボディ)で子(メソッド/ネストクラス)をぶら下げる。
        const roots = this.graphNodes
            .filter((n) => !n.parent)
            .sort((a, b) => a.lineStart - b.lineStart);
        // AI_NOTE: 設計フェーズ1・ステップ3中盤。標準タブの各カードに設計サブブロックを出すため、
        // 概要タブ(buildOverviewPane)と同様に名前→設計シンボルの索引をここで1回だけ作りrenderNodeへ流す。
        const design = this.currentDesign();
        const designSymbolByName = new Map((design?.file.symbols ?? []).map((s) => [s.name, s]));
        const designIssues = design?.issues ?? [];
        const cards = roots.map((n) => this.renderNode(n, childrenOf, designSymbolByName, designIssues)).join("");
        const areaCls = `${this.arrowsEnabled ? "arrows-on" : ""}${this.arrowSide === "right" ? " side-right" : ""}`;
        // AI_NOTE: ② 範囲展開バナー。ツールバー「▤ 範囲展開」で選択モードに入ると上部に出る(下部だと気づけない対策)。
        // モード中はカードを普通クリックで開始→終了を選び(Shift不要)、実行で一括分解。件数はJSが更新する。
        const rangeBanner = `<div id="range-banner" style="display:none">
      <span id="range-banner-msg">展開したいカードの<b>開始</b>と<b>終了</b>をクリックで選んでください</span>
      <span class="range-actions">
        <button class="tbtn on" id="range-run-btn" onclick="doExpandRange()" disabled>実行 (0)</button>
        <button class="tbtn" onclick="toggleRangeMode()">やめる</button>
      </span>
    </div>`;
        return `${rangeBanner}${this.buildFileHeader()}<div id="cards-area" class="${areaCls}">${svg}${cards}</div>`;
    }

    // AI_NOTE: 1ノードを描く。子を持つクラスは概要と共有の group-block(タイトルバー+トグル+ボディ)にする。
    // 子は同じ renderNode で再帰描画するためネストクラスもそのままグループ入れ子になる。
    // クラスも▶展開で役割・状態・主な機能とメソッド単位の分解を表示する。フロー図(図)は関数だけに保つ。
    private renderNode(
        n: GraphNode,
        childrenOf: Map<string, GraphNode[]>,
        designSymbolByName: Map<string, DesignSymbol>,
        designIssues: DesignIssue[],
        inherit?: string,
    ): string {
        const sym = designSymbolByName.get(this.cardLabel(n));
        const { html: cardHtml, accent } = this.buildCardHtml(n, sym, designIssues, inherit);
        if (n.kind === "class") {
            const kids = (childrenOf.get(n.id) ?? []).sort((a, b) => a.lineStart - b.lineStart);
            // AI_NOTE: メソッド/ネストクラスを持たないクラス(enum/dataclass等)も▶展開で概要を出す。
            // 従来はexpandedDataだけ更新して描画先が無く、背景色だけ変わる状態になっていた。
            // 設計情報はcardHtmlに既にあるため、展開側では重複させない。
            if (kids.length === 0) {
                return this.expandedData[n.id]
                    ? `<div class="card-block" style="--accent:${accent}">${cardHtml}${this.buildSubCards(n.id, sym, designIssues, false)}</div>`
                    : cardHtml;
            }
            // AI_NOTE: 子(メソッド/ネストクラス)はクラス色を継承させ、左罫・薄塗りを所属クラスと同色にする
            const body = kids.map((c) => this.renderNode(c, childrenOf, designSymbolByName, designIssues, accent)).join("");
            const name = escapeHtml(n.label).substring(0, 80);
            // AI_NOTE: クラスの概要説明(AI)。あれば見出し下に1行で出し「何のクラスか」を伝える(名前だけだと素っ気ないため)
            const desc = this.descMap[n.id];
            const descLine = desc ? `<div class="grp-desc">${escapeHtml(desc).substring(0, 120)}</div>` : "";
            // AI_NOTE: 設計サブブロックはAI生成説明(descLine)の上に置く(設計=人が確認した意図を先に見せる優先順位)。
            const designBlock = this.buildDesignSymbolBlock(sym, designIssues);
            const expanded = !!this.expandedData[n.id];
            const safeLabel = escapeHtml(n.label).replace(/'/g, "\\'");
            // AI_NOTE: 子を持つクラスはcardHtmlを使わないため、ここで▶を置く。クリックを止めて子一覧の開閉と競合させない。
            const expandBtn = `<button type="button" class="class-overview-btn${expanded ? " on" : ""}" title="クラスの役割・状態・主な機能を表示"
                onclick="event.stopPropagation();vscode.postMessage({type:'expand',nodeId:'${escapeHtml(n.id)}',lineStart:${n.lineStart},lineEnd:${n.lineEnd},label:'${safeLabel}'})">概要 ${expanded ? "▼" : "▶"}</button>`;
            // AI_NOTE: 設計情報はクラスの直下に既に表示するため、展開側では重複させずAI概要と処理単位だけを追加する。
            const expansion = expanded ? this.buildSubCards(n.id, sym, designIssues, false) : "";
            // AI_NOTE: 概要グループと同一構造(.group-block + タイトルバー全体クリックで toggleGroup 開閉)。
            // 子持ちカードのトグル・サブ表示を標準/概要で統一するため専用実装を作らず共有する。
            return `<div class="group-block" data-id="${escapeHtml(n.id)}" style="--accent:${accent}">
              <div class="group-title" onclick="toggleGroup(this.closest('.group-block'))">
                <span class="grp-toggle">▼</span>
                <span class="grp-label">${name}</span>
                <span class="grp-count">${kids.length}</span>
                ${expandBtn}
              </div>
              ${designBlock}${descLine}
              ${expansion}
              <div class="group-body">${body}</div>
            </div>`;
        }
        const expanded = !!this.expandedData[n.id];
        return expanded
            ? `<div class="card-block" style="--accent:${accent}">${cardHtml}${this.buildSubCards(n.id, sym, designIssues)}</div>`
            : cardHtml;
    }

    // AI_NOTE: 1ノードの素のカードHTMLと枠色を作る(行ラップ・展開は呼び出し側)。子持ちクラスのヘッダは
    // group-block(概要と共有)で別途組むので、ここは leaf カード(関数/block/子なしクラス)用。
    // inherit=所属クラス色。メソッド等は色を割当てないので、これを使って左罫・塗りをクラスと同色にする。
    private buildCardHtml(n: GraphNode, sym: DesignSymbol | undefined, designIssues: DesignIssue[], inherit?: string): { html: string; accent: string } {
        const label = escapeHtml(this.cardLabel(n)).substring(0, 80);
        const canExpand = n.kind === "function" || n.kind === "class" || n.kind === "block";
        const expanded = !!this.expandedData[n.id];
        const safeLabel = escapeHtml(n.label).replace(/'/g, "\\'");
        const expandBtn = canExpand
            ? `<span class="exp-btn${expanded ? " on" : ""}" title="内部を分解"
                onclick="event.stopPropagation();vscode.postMessage({type:'expand',nodeId:'${escapeHtml(n.id)}',lineStart:${n.lineStart},lineEnd:${n.lineEnd},label:'${safeLabel}'})">${expanded ? "▼" : "▶"}</span>`
            : "";
        // AI_NOTE: 参照(エッジ)があるノードに参照ボタン。クリックで呼び出し関係のカードを強調する(旧#5: 矢印は出さずカード強調)
        const hasEdge = this.graphEdges.some((e) => e.from === n.id || e.to === n.id);
        const refBtn = hasEdge
            ? `<span class="ref-btn" title="参照関係を強調" onclick="event.stopPropagation();onRefClick(event,'${escapeHtml(n.id)}')">参照</span>`
            : "";
        // AI_NOTE: #4 関数のみ「図」ボタンで制御フロー図にドリルイン(本体クリックはジャンプ専用にしたため)
        const drillBtn = n.kind === "function"
            ? `<span class="drill-btn" title="この関数のフロー図" onclick="event.stopPropagation();vscode.postMessage({type:'drill',lineStart:${n.lineStart}})">図</span>`
            : "";
        // AI_NOTE: 色は構造(トップレベルのクラス/関数)だけに割当てる。メソッド等は inherit(所属クラス色)を使い、
        // それも無い import/実行/その他ブロックはグレーに退かせてクラス色と混同しないようにする。
        const accent = this.nodeColors.get(n.id)?.color ?? inherit ?? "#9d9d9d";
        // AI_NOTE: タグは常にkind色。背景塗りもaccent色に連動させkindごとに見分く。概要/importは固定で薄いmuted(faint tint)。汎用block(処理)は行数で塗り濃度をランプ。関数/クラス/実行は主役の濃度
        const flatMuted = isFlatMuted(n);
        const isGenericBlock = n.kind === "block" && !flatMuted && !n.label.startsWith("if __name__");
        let style = `--accent:${accent}`;
        if (isGenericBlock) {
            const { opacity, fillAlpha, borderPx } = blockEmphasis(n.lineEnd - n.lineStart + 1);
            style += `;opacity:${opacity};background:${hexToRgba(accent, fillAlpha)};border-left-width:${borderPx}px`;
        } else if (flatMuted) {
            style += `;background:${hexToRgba(accent, 0.06)}`;
        } else {
            style += `;background:${hexToRgba(accent, 0.15)}`;
        }
        // AI_NOTE: ④ AI説明があればラベル下に独立行(.desc)で出す。クラス(子持ち)は group-block 側の
        // grp-desc で出すため、ここは leaf カード(関数/block/子なしクラス)に効く。flex-basis:100%で改行。
        const desc = this.descMap[n.id];
        const descLine = desc ? `<div class="desc">${escapeHtml(desc).substring(0, 200)}</div>` : "";
        // AI_NOTE: 子なしクラス(leafカード)向けの設計サブブロック。関数/blockは▶展開時のbuildSubCards側で
        // 出す(AI概要ボックスの上に置くという指示のため)ので、ここではclassのみ対象にする。
        // クラスが子持ちの場合もここで計算はするが、呼び出し元(renderNode)がcardHtmlごと捨てて
        // group-block側で別途design-blockを組むため重複表示にはならない。
        const designLine = n.kind === "class" ? this.buildDesignSymbolBlock(sym, designIssues) : "";
        // AI_NOTE: ② data-exp=展開可(関数/クラス/block)。Shift+クリックの範囲選択で「展開対象」を数える印。
        const html = `<div class="card${flatMuted ? " muted" : ""}" data-id="${escapeHtml(n.id)}"${canExpand ? ' data-exp="1"' : ""} style="${style}"
      onclick="onCardClick(event,'${escapeHtml(n.id)}',${n.lineStart},${n.lineEnd})">
      <span class="kind" style="color:${kindColorFor(n.kind, n.label)}">${tagFor(n.kind, n.label)}</span>
      <span class="label">${label}</span>
      ${drillBtn}${expandBtn}${refBtn}${designLine}${descLine}
    </div>`;
        return { html, accent };
    }
}

// AI_NOTE: ファイル型ヘッダーの kind→表示文言+色クラス対応表。分類器の FileKind と1対1。
// 1行目に出す固定文(LLM生成ではない)と、左罫/文字色を決めるCSSクラスをここで一元管理する。
const FILE_TYPE_META: Record<FileKind, { text: string; cls: string }> = {
    definitions: { text: "クラス・関数の定義が中心", cls: "fh-def" },
    flow: { text: "上から順に実行する処理", cls: "fh-flow" },
    entrypoint: { text: "プログラムの実行起点", cls: "fh-entry" },
    model: { text: "データ構造・型の定義", cls: "fh-model" },
    config: { text: "設定値の定義", cls: "fh-config" },
    test: { text: "テストコード", cls: "fh-test" },
};

// AI_NOTE: mermaidソースをdivに入れる前の最小エスケープ(<>のみ。&はmermaid構文で使う)
function escapeForMermaid(s: string): string {
    return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// AI_NOTE: kind別のカード左ボーダー色。標準/概要タブ共通で使う
function colorFor(kind: string): string {
    switch (kind) {
        case "function": return "#4ec9b0";
        case "class": return "#c586c0";
        case "entry": return "#569cd6";
        case "condition": return "#c586c0";
        case "loop": return "#dcdcaa";
        case "return": return "#f48771";
        default: return "#4fc1ff";
    }
}

// AI_NOTE: 日本語タグ。kindだけでは粗いので、function→クラス/関数、block→読込/実行/処理 をlabelで判別する
function tagFor(kind: string, label: string): string {
    if (kind === "entry") return "概要";
    if (kind === "class") return "クラス";
    if (kind === "function") return label.startsWith("class ") ? "クラス" : "関数";
    if (label.startsWith("import ")) return "読込";
    if (label.startsWith("if __name__")) return "実行";
    if (kind === "condition") return "分岐";
    if (kind === "loop") return "反復";
    if (kind === "return") return "戻り";
    return "処理";
}

// AI_NOTE: 概要/importは性質上つねに脇役(固定で薄い)。色は残すので下のflatMuted扱い
function isFlatMuted(n: { kind: string; label: string }): boolean {
    return n.kind === "entry" || n.label.startsWith("import ");
}

// AI_NOTE: 種類ごとに固定の色。タグに使い「関数/クラス/処理…」のカテゴリを色で示す。カード枠/塗りのノード色(識別用)とは別軸の2色目
function kindColorFor(kind: string, label: string): string {
    if (kind === "entry") return "#569cd6";
    if (kind === "class") return "#c586c0";
    if (kind === "function") return label.startsWith("class ") ? "#c586c0" : "#4ec9b0";
    if (label.startsWith("import ")) return "#9cdcfe";
    if (label.startsWith("if __name__")) return "#dcdcaa";
    if (kind === "condition") return "#c586c0";
    if (kind === "loop") return "#dcdcaa";
    if (kind === "return") return "#ce9178";
    return "#9d9d9d";
}

// AI_NOTE: 汎用block(処理)を行数で連続的に強調する。1行=最も薄く、FULL_LINES行で主役と同じ濃さに達する。
// FULL_LINES=5: 「数行を超える塊は関数に抽出すべき」という定石の閾値。これを超えた未抽出ブロックは実質無名の手続きなので主役級に見せる。
// 1〜5行で1行=1段階(5段階)になり、1行差が必ず濃さに出る。コントラストは opacity/塗りとも広めにとって段差を視認できるようにする。
function blockEmphasis(span: number): { opacity: string; fillAlpha: number; borderPx: number } {
    const FULL_LINES = 5;
    const e = Math.min(Math.max((span - 1) / (FULL_LINES - 1), 0), 1);
    return {
        opacity: (0.5 + 0.5 * e).toFixed(3),
        fillAlpha: 0.15 * e,
        borderPx: e < 0.5 ? 2 : 3,
    };
}

// AI_NOTE: アクセント色(hex)をカード背景の半透明塗りに変換する。borderだけでなく塗りも色連動させ、関数/クラス/処理を塗りでも見分けられるようにする
// AI_NOTE: 標準タブ▼展開のサブブロック配色。subcardの左罫(--saccent)とエディタ背景塗りで
// 同じ色・同じ並び順を使い、トグルを開いた中身の色と実コードの背景色を一致させる。
const SUB_PALETTE = ["#4fc1ff", "#f48771", "#4ec9b0", "#dcdcaa", "#c586c0", "#9cdcfe", "#d7ba7d", "#b8a1e3", "#8fbc8f", "#e87ea1", "#75beff", "#ce9178"];

// AI_NOTE: ② モデルIDの人間向け表記。未知IDは生のIDをそのまま出すので、ここは既知の別名だけでよい。
// 最新世代（Opus 5 / Sonnet 5 / Haiku 4.5、GPT-5.6系、Gemini 3系）を主にし、旧既定値も表示崩れ防止に残す。
const PRETTY_MODEL: Record<string, string> = {
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-opus-5": "Claude Opus 5",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-opus-4-8": "Claude Opus 4.8",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5": "GPT-5",
    "gpt-5-mini": "GPT-5 mini",
    "gemini-3.6-flash": "Gemini 3.6 Flash",
    "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
    "gemini-2.5-pro": "Gemini 2.5 Pro",
    "gemini-2.5-flash": "Gemini 2.5 Flash",
};

function hexToRgba(hex: string, alpha: number): string {
    const m = hex.replace("#", "");
    const r = parseInt(m.slice(0, 2), 16);
    const g = parseInt(m.slice(2, 4), 16);
    const b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// AI_NOTE: kind別のエディタ背景色(淡いalpha)。カード左ボーダー色と同系統。
function bgFor(kind: string): string {
    switch (kind) {
        case "function": return "rgba(78,201,176,0.12)";
        case "class": return "rgba(197,134,192,0.12)";
        case "entry": return "rgba(86,156,214,0.12)";
        case "condition": return "rgba(197,134,192,0.12)";
        case "loop": return "rgba(220,220,170,0.12)";
        case "return": return "rgba(244,135,113,0.12)";
        default: return "rgba(79,193,255,0.12)";
    }
}

// AI_NOTE: webviewに値を埋める前にHTML特殊文字を無害化する(コードラベルに <,>,& が混ざるため)
function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// AI_NOTE: 出所タグの見せ方。装飾絵文字は使わずVSCodeテーマ変数のみの小バッジにする(design-file-feature.md「未決」の解決)。
const PROVENANCE_META: Record<Provenance, { text: string; cls: string }> = {
    confirmed: { text: "確認済", cls: "dtag-confirmed" },
    inferred: { text: "推測", cls: "dtag-inferred" },
    untagged: { text: "未確認", cls: "dtag-untagged" },
};
function provenanceBadge(p: Provenance): string {
    const meta = PROVENANCE_META[p];
    return `<span class="dtag ${meta.cls}">${meta.text}</span>`;
}

// AI_NOTE: LLM返信のmarkdownを最小限HTML化する。先に escapeHtml してから記法を適用するのでHTML注入は起きない。
// 対応: コードブロック/インラインコード/見出し/太字/斜体/リンク/箇条書き/改行。完全なmd実装はしない（よく出る記法に絞る）。
function renderMarkdown(src: string): string {
    const codeBlocks: string[] = [];
    // AI_NOTE: コードブロックを先に退避し、中身に他の記法変換がかからないようにする（プレースホルダに置換）
    let s = escapeHtml(src).replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_m, code: string) => {
        codeBlocks.push(`<pre class="cmd-code"><code>${code.replace(/\n$/, "")}</code></pre>`);
        return ` CB${codeBlocks.length - 1} `;
    });
    s = s
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/^#{1,4}\s+(.+)$/gm, "<strong>$1</strong>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
    // AI_NOTE: 連続する箇条書き行(- / *)を1つの <ul> にまとめる
    s = s.replace(/(?:^[-*]\s+.+(?:\n|$))+/gm, (block) => {
        const items = block.trimEnd().split("\n").map((l) => `<li>${l.replace(/^[-*]\s+/, "")}</li>`).join("");
        return `<ul>${items}</ul>`;
    });
    // AI_NOTE: 残った改行は <br>。ブロック要素(ul/pre/li)の境界に出る余分な <br> は消す
    s = s.replace(/\n/g, "<br>")
        .replace(/<br>\s*(<\/?(?:ul|pre|li))/g, "$1")
        .replace(/(<\/(?:ul|pre)>)\s*<br>/g, "$1");
    return s.replace(/ CB(\d+) /g, (_m, i: string) => codeBlocks[Number(i)]);
}

// AI_NOTE: 引用の説明文を見やすいHTMLに整形する。
// 入力は quoteText 由来: 項目を空行(\n\n)で区切り、各項目の1行目=見出し(label, ①②付きも)・2行目以降=本文(explanation)。
// 出力: 項目ごとに .cc-item（見出し太字＋本文）。①② が別々のブロックに分かれて読みやすくなる。
function formatQuoteExplanation(explanation: string): string {
    return explanation
        .split("\n\n")
        .map((item) => {
            const nl = item.indexOf("\n");
            const head = nl >= 0 ? item.slice(0, nl) : item;
            const body = nl >= 0 ? item.slice(nl + 1) : "";
            const bodyHtml = body ? `<div class="cc-body">${escapeHtml(body)}</div>` : "";
            return `<div class="cc-item"><div class="cc-head">${escapeHtml(head)}</div>${bodyHtml}</div>`;
        })
        .join("");
}
