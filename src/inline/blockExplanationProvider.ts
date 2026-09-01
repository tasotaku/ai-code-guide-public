import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SemanticAnnotation, generateSymbolDictionaryAnnotations } from "../api/claudeClient";
import { extractSymbols } from "../flowchart/astParser";
import { reanchorAnnotations, selectVisibleAnnotations, mergeChatLinkAnnotations } from "../api/annotationResolver";
import { ChatLinkStore } from "../view/chatLinkStore";
import { AnnotationStatusStore, AnnotationStatus } from "./annotationStatusStore";
import { getChangedLines } from "../util/gitDiff";
import { getKeyMissingReason } from "../api/llmProvider";

// AI_NOTE: 状態の日本語表記。ホバーのアクション表示とトースト通知で共用する。
const STATUS_LABEL: Record<AnnotationStatus, string> = { read: "読んだ", later: "後で見る", resolved: "解決済み", hidden: "非表示" };

// AI_NOTE: インライン解説に使うモデル(設定スロット)を読む。キー未設定の事前判定に使う。
function inlineModel(): string {
    return vscode.workspace.getConfiguration("aiCodeGuide").get<string>("inlineAnnotationModel", "gpt-5.6-sol");
}
import { dedupAnnotations } from "../api/annotationResolver";

// AI_NOTE: 生成系メソッドの結果。チャットペインのボタン状態表示(完了/表示済み/失敗+件数)に使う。
// generated=LLMで新規生成 / cached=既存fullを表示しただけ / empty=結果0件(失敗)。
export type AnnotateResult = { status: "generated" | "cached" | "empty"; count: number };

// AI_NOTE: FNV-1a 32bit ハッシュ。コード内容をキーにして行番号非依存のキャッシュを実現する
function fnv1a(str: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16);
}

// AI_NOTE: 同一行に下線が2つ以上あるとき、下線(after装飾)と解説(CodeLens)を同じ丸数字で対応付ける。
// 列順の index を渡す。下線側と解説側で必ず同じ index を使うこと。9個超は実質起きないが (n) にフォールバック。
function circledMarker(index: number): string {
    return index < 9 ? "①②③④⑤⑥⑦⑧⑨"[index] : `(${index + 1})`;
}

// AI_NOTE: ↑CodeLensの点字空白の幅補正。U+2800幅はエディタ等幅の約0.954倍(2026-07-06ピクセル実測)なので
// 必要表示列×1.048(=1/0.954)個を敷く。過去の実測ノートにあった「CodeLens左端は常に列0」は空行直上だけの
// 観測で誤り。正しい原点は lensOriginCol を参照(VS Code本体がアンカー行の非空白開始列に置く)。
const LENS_PAD_RATIO = 1.048;

// AI_NOTE: サイドノートの折り返し補助。CSSのch幅と同じ半角=1/全角=2の目安で、枠と本文の計算を揃える。
function displayWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        width += char.charCodeAt(0) > 0xff ? 2 : 1;
    }
    return width;
}

// AI_NOTE: 固定幅の説明欄に収まるところで切る。外枠はCSSで必ず隠すので、ここは表示幅を超えない保証だけを持つ。
function takeByWidth(text: string, maxWidth: number): { head: string; tail: string } {
    let width = 0;
    let head = "";
    for (const char of text) {
        const nextWidth = width + displayWidth(char);
        if (head && nextWidth > maxWidth) break;
        head += char;
        width = nextWidth;
    }
    return { head, tail: text.slice(head.length) };
}

// AI_NOTE: 文字index(UTF-16)を画面上の表示列へ変換する。タブは次のタブストップまで進み、全角(>0xff)は2セル。
// absStartCol(文字数)を直接padに使うとタブ/全角を含む行で下線と↑が食い違うため、pad計算は必ずこれを通す。
function displayColumn(text: string, charIndex: number, tabSize: number): number {
    let col = 0;
    for (const char of text.slice(0, charIndex)) {
        col = char === "\t" ? (Math.floor(col / tabSize) + 1) * tabSize : col + displayWidth(char);
    }
    return col;
}

function cleanNoteText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function isNaturalBreak(char: string): boolean {
    return /\s|[、。，．,.!?！？:：;；)\]）】」』-]/u.test(char);
}

// AI_NOTE: 禁則処理。行頭に置けない文字(句読点・閉じ括弧・小書き仮名・長音・中黒など)と、行末に置けない文字(開き括弧)。
// 折り返し位置がこれらに当たると読みづらいので、前後の行へ1文字寄せて調整する。
const LINE_START_FORBIDDEN = /[、。，．・：；！？!?)\]｝）】」』〕〉》ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョ々…]/u;
const LINE_END_FORBIDDEN = /[(\[｛（【「『〔〈《]/u;

// AI_NOTE: 折り返した head/tail に禁則を適用する。①tail 先頭が行頭禁則文字なら head 末尾へぶら下げる(最大2字)。
// ②head 末尾が開き括弧(行末禁則)なら tail 先頭へ送る。表示幅を1〜2字超えうるが、外枠CSSで隠れるので読みやすさを優先。
function applyKinsoku(head: string, tail: string): { head: string; tail: string } {
    let h = head;
    let t = tail;
    let moved = 0;
    while (t && LINE_START_FORBIDDEN.test(t[0]) && moved < 2) {
        h += t[0];
        t = t.slice(1);
        moved++;
    }
    if (h.length > 1 && t && LINE_END_FORBIDDEN.test(h[h.length - 1])) {
        t = h[h.length - 1] + t;
        h = h.slice(0, -1);
    }
    return { head: h.trimEnd(), tail: t.trimStart() };
}

// AI_NOTE: 日本語の短い語尾だけが次行に孤立すると読みづらいので、直前行から1文字戻してまとまりで読ませる。
function avoidShortTail(head: string, tail: string): { head: string; tail: string } {
    if (!tail || displayWidth(tail) > 2) return { head, tail };
    const chars = [...head];
    if (chars.length <= 1) return { head, tail };
    const last = chars.pop()!;
    return { head: chars.join("").trimEnd(), tail: `${last}${tail}`.trimStart() };
}

// AI_NOTE: 英単語や句読点の途中で切れる不自然さを減らすため、幅内の最後の空白・句読点を優先して1行を取り出す。
function takeNaturalLine(text: string, maxWidth: number): { head: string; tail: string } {
    const chars = [...text.trimStart()];
    let width = 0;
    let lastBreak = 0;

    for (let i = 0; i < chars.length; i++) {
        const nextWidth = width + displayWidth(chars[i]);
        if (nextWidth > maxWidth) break;
        width = nextWidth;
        if (isNaturalBreak(chars[i])) lastBreak = i + 1;
    }

    if (width === displayWidth(chars.join(""))) return { head: chars.join("").trimEnd(), tail: "" };
    if (lastBreak > 0) {
        const breakHead = chars.slice(0, lastBreak).join("").trimEnd();
        if (displayWidth(breakHead) < maxWidth * 0.45) {
            const part = takeByWidth(chars.join(""), maxWidth);
            return avoidShortTail(part.head.trimEnd(), part.tail.trimStart());
        }
        return avoidShortTail(
            breakHead,
            chars.slice(lastBreak).join("").trimStart()
        );
    }

    const part = takeByWidth(chars.join(""), maxWidth);
    return avoidShortTail(part.head.trimEnd(), part.tail.trimStart());
}

function ellipsizeByWidth(text: string, maxWidth: number): string {
    const clean = cleanNoteText(text);
    if (displayWidth(clean) <= maxWidth) return clean;
    const ellipsis = "…";
    const width = Math.max(1, maxWidth - displayWidth(ellipsis));
    return `${takeByWidth(clean, width).head.trimEnd()}${ellipsis}`;
}

// AI_NOTE: 説明文は自然な区切りで折り返す。長い日本語は区切り文字なしでも表示幅で切り、英単語は空白優先にする。
function wrapByWidth(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let rest = cleanNoteText(text);
    let guard = 0;
    while (rest && guard++ < 100) {
        const part = takeNaturalLine(rest, maxWidth);
        const short = avoidShortTail(part.head, part.tail);
        // AI_NOTE: 短尾回避の後に禁則を当てる。行頭/行末に来てはいけない文字を前後行へ寄せて読みやすくする。
        const fixed = applyKinsoku(short.head, short.tail);
        // AI_NOTE: head が空＝進まない異常時は無限ループ防止に残りを丸ごと出して終わる。
        if (!fixed.head) {
            lines.push(rest);
            break;
        }
        lines.push(fixed.head);
        rest = fixed.tail;
    }
    return lines.length ? lines : [""];
}

// AI_NOTE: block の常時表示は step1（流れ＝label/要約）にする。なぜ（step2=explanation）はホバー側に退ける。
// 以前は explanation を流していたが、流れ理解には要約の方が要るので label に変更（要約は冗長ではなく step1 の本体）。
// warning は先頭に ⚠ を織り込んで一緒に折り返す。高さに収まらない分は最後の可視行を … で省略（全文はホバー）。
function buildSidenoteLines(label: string, warn: boolean, height: number, width: number): string[] {
    if (height <= 0) return [];
    const text = (warn ? "⚠ " : "") + label;
    const body = wrapByWidth(text, width);
    const visible = body.slice(0, height);
    if (body.length > visible.length && visible.length > 0) {
        visible[visible.length - 1] = ellipsizeByWidth(`${visible[visible.length - 1]}…`, width);
    }
    return visible;
}

// AI_NOTE: LRU上限付きのアノテーションキャッシュ。ディスクに永続化して再起動後も維持する
class AnnotationCache {
    private cache: Map<string, SemanticAnnotation[]> = new Map();
    private readonly diskPath: string;
    private static readonly MAX_ENTRIES = 200;
    // AI_NOTE: LLMプロンプトの意味が変わった時 or キャッシュ形式が変わった時は版数を上げ、古い注釈を再利用しない。
    // scope-v1: 注釈に scope(full/range) を持たせ、ファイル全文キーで full/range を統合保存する形式へ移行。
    //           旧 warning-v2 は full/range 混在・不完全結果が詰まる問題があったため版を上げて一掃する。
    // layer-v1: label=step1(流れ)/explanation=step2(なぜ)に役割を割り直したため、旧 step2偏重の注釈を一掃する。
    // layer-v2: 変数/引数/属性の「値の意味」(capacity等)を step1 として拾う方針を追加したため再生成させる。
    // layer-v3: __main__/デモ実行部も step1 解説の対象に含めたため再生成させる。
    // anchor-v1: 注釈に anchorText/anchorToken/anchorEndText/id(位置由来の安定ID)を追加。
    //            旧データはこれらを欠くため版を上げて一掃する(編集追従・ステータス永続化の土台)。
    // anchor-v2: id に前後行(context)を加えて衝突回避。旧 id を持つキャッシュを一掃して付け直す。
    // hover-v1: symbol の explanation を「単体で完結するホバー本文」に再定義（旧版は label の続きで単体だと前段が抜ける）。
    //           文の役割が変わるだけで型は同じ＝欠落検知ができないので、版を上げて旧文を使わせない。
    private static readonly PROMPT_VERSION = "symbol-dictionary-v1";

    constructor(storageUri: vscode.Uri) {
        this.diskPath = path.join(storageUri.fsPath, "semantic-annotations.json");
        this.loadFromDisk();
    }

    private loadFromDisk(): void {
        try {
            const raw = fs.readFileSync(this.diskPath, "utf8");
            const obj = JSON.parse(raw) as Record<string, SemanticAnnotation[]>;
            for (const [k, v] of Object.entries(obj)) {
                this.cache.set(k, v);
            }
        } catch {
            // ファイルなし・破損はサイレントに空スタート
        }
    }

    private saveToDisk(): void {
        try {
            fs.mkdirSync(path.dirname(this.diskPath), { recursive: true });
            const obj: Record<string, SemanticAnnotation[]> = {};
            for (const [k, v] of this.cache) {
                obj[k] = v;
            }
            fs.writeFileSync(this.diskPath, JSON.stringify(obj), "utf8");
        } catch {
            // ディスク書き込み失敗はサイレントに無視
        }
    }

    get(uri: string, code: string): SemanticAnnotation[] | undefined {
        const key = `${uri}::${AnnotationCache.PROMPT_VERSION}::${fnv1a(code)}`;
        const val = this.cache.get(key);
        if (val !== undefined) {
            this.cache.delete(key);
            this.cache.set(key, val);
        }
        return val;
    }

    set(uri: string, code: string, annotations: SemanticAnnotation[]): void {
        const key = `${uri}::${AnnotationCache.PROMPT_VERSION}::${fnv1a(code)}`;
        this.cache.delete(key);
        this.cache.set(key, annotations);
        if (this.cache.size > AnnotationCache.MAX_ENTRIES) {
            this.cache.delete(this.cache.keys().next().value!);
        }
        this.saveToDisk();
    }

    clearFile(uri: string): void {
        for (const k of this.cache.keys()) {
            if (k.startsWith(`${uri}::`)) this.cache.delete(k);
        }
    }
}

// AI_NOTE: 実際に適用済みのアノテーション（絶対行で保持）
interface AppliedAnnotation {
    annotation: SemanticAnnotation;
    absStartLine: number;
    absEndLine: number;
    absStartCol: number | null;
    absEndCol: number | null;
}

interface BlockNote {
    applied: AppliedAnnotation;
    startLine: number;
    endLine: number;
    // AI_NOTE: サイドノートに常時表示するのは step1=label。explanation(step2)は applied 経由でホバーから出す。
    label: string;
    warn: boolean;
    read: boolean; // AI_NOTE: 読んだ=薄いグレー表示(de-emphasize)
}

interface BlockGroup {
    id: string;
    blocks: BlockNote[];
    activeIndex: number;
}

function blockRangesOverlap(a: BlockNote, b: BlockNote): boolean {
    return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function getBlockGroupId(blocks: BlockNote[]): string {
    return blocks
        .map(b => `${b.startLine}-${b.endLine}-${b.warn ? "w" : "i"}`)
        .sort()
        .join("|");
}

// AI_NOTE: 重なった block を connected component にまとめる。親子だけでなく部分重なりも1つの切替単位にする。
export function buildBlockGroups(blocks: BlockNote[], activeByGroup: Map<string, number>): BlockGroup[] {
    const groups: BlockGroup[] = [];
    const seen = new Set<BlockNote>();
    const ordered = [...blocks].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);

    for (const block of ordered) {
        if (seen.has(block)) continue;
        const group: BlockNote[] = [];
        const stack = [block];
        seen.add(block);

        while (stack.length > 0) {
            const current = stack.pop()!;
            group.push(current);
            for (const other of ordered) {
                if (seen.has(other) || !blockRangesOverlap(current, other)) continue;
                seen.add(other);
                stack.push(other);
            }
        }

        group.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
        const id = getBlockGroupId(group);
        const activeIndex = (activeByGroup.get(id) ?? 0) % group.length;
        groups.push({ id, blocks: group, activeIndex });
    }
    return groups;
}

// AI_NOTE: SemanticAnnotationProvider はアノテーション生成・キャッシュ・表示・ホバー・CodeLensを一括管理する。
// severity=info（解説）はオレンジ、severity=warning（バグ指摘）は赤で系統を分ける。
// 場所の印: symbol → 点線下線、block → 薄い背景 + 左ボーダー。
// 解説本文（ハイブリッド配置）:
//   symbol → 該当行の「上」に CodeLens で表示（クリックでチャット）。単行なので上に出すのが自然。
//   block  → 先頭行の「右余白」にゴーストで表示。背景で範囲が見えているので上に行を足さず横に出す。
// 1行1注釈（resolver で担保）なので対応は常に明確。
// HoverProvider → 補助。ホバーすると label＋詳細＋💬 も出る（Pylanceも併出するが読むのに必須ではない）。
export class SemanticAnnotationProvider implements vscode.HoverProvider, vscode.CodeLensProvider {
    // AI_NOTE: symbol info 用 — オレンジ点線下線。cursor は text（I-beam）で編集の邪魔をしない
    // AI_NOTE: symbol info 用 — オレンジ点線下線。wavy はVSCodeのエラー表示と被るため点線にする
    private readonly symbolDecorationType = vscode.window.createTextEditorDecorationType({
        textDecoration: "underline dotted rgba(255,180,0,1.0) 3px",
        cursor: "text",
    });

    // AI_NOTE: symbol warning 用 — 赤点線下線
    private readonly symbolWarnDecorationType = vscode.window.createTextEditorDecorationType({
        textDecoration: "underline dotted rgba(255,80,80,1.0) 3px",
        cursor: "text",
    });

    // AI_NOTE: symbol read(読んだ)用 — グレーで薄い点線下線。「処理済み」を de-emphasize する。severity より read を優先。
    private readonly symbolReadDecorationType = vscode.window.createTextEditorDecorationType({
        textDecoration: "underline dotted rgba(140,140,140,0.7) 2px",
        cursor: "text",
    });

    // AI_NOTE: 右モード用 — symbol解説を行末(EOL)の右余白に after 実テキストで出す(下CodeLensの代わり)。
    // 色は severity/read で出し分けるため per-instance renderOptions で決める(型は1つで足りる)。
    // after は EOL 起点の in-flow なのでコード幅に追従し、CJK行でもドリフトしない(block本文の 没E とは前提が違う)。
    private readonly symbolRightType = vscode.window.createTextEditorDecorationType({});

    // AI_NOTE: ブロックの「枠」をbefore擬似要素で描く。isWholeLineは使わない。
    // [変更] コードは囲わず、解説欄(サイドノート)だけを枠で囲う。before を left=noteCol 始まりの
    // 透明な箱にし、borderWidth "上 右 下 左" を行位置で出し分け、先頭=∩、末尾=∪、中間=‖、単行=□、を作る。
    // 型は severity(info/warn)で分け、辺の組み合わせは per-instance renderOptions で決める。
    private readonly boxInfoType = vscode.window.createTextEditorDecorationType({});
    private readonly boxWarnType = vscode.window.createTextEditorDecorationType({});

    // AI_NOTE: block 用ラベル(サイドノート本文) — before の position:absolute 仮想テキストで描く(CJK行でもドリフトしない)。
    // 仮想テキストには当たり判定が無いので、ホバーは下の noteHoverType が担当する。
    private readonly labelDecorationType = vscode.window.createTextEditorDecorationType({});

    // AI_NOTE: サイドノート余白(行末より右)に hoverMessage だけ載せる不可視デコ。本文(labelDecorationType)は
    // position:absolute の仮想テキストでホバー判定が無いため、ここで余白の実レンジに当たり判定を足し、ノートのホバーでも step2 を出す。
    // 開始列を行末(EOL)にしてコード本体に被せない＝provideHover(コード側)との二重表示を避ける。
    // ※ 過去 605a3fa で本文を after実テキスト化した際に一度不要化したが、結論F(eb33c6c)で本文を before絶対へ戻した時に
    //    復活させ忘れてノートのホバーが消えていた。本デコで復活させる。
    private readonly noteHoverType = vscode.window.createTextEditorDecorationType({});

    // AI_NOTE: AI編集検知の提案ハイライト。isWholeLine+ごく薄いオレンジ(info系と同系統)で「候補範囲」を控えめに示し、
    // overviewRuler にも同系色を出して画面外の検知でも気付けるようにする。一時表示なのでFC連動ハイライトとの重なりは許容。
    private readonly suggestionHighlightType = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: "rgba(230,150,60,0.07)",
        overviewRulerColor: "rgba(230,150,60,0.5)",
        overviewRulerLane: vscode.OverviewRulerLane.Full,
    });

    private readonly cache: AnnotationCache;

    // AI_NOTE: 注釈のトリアージ状態(読んだ/後で見る/解決済み)を id 単位で永続化する。
    private readonly statusStore: AnnotationStatusStore;

    // AI_NOTE: 状態フィルタ前の「絶対座標・全注釈」。状態変更や「解決済みを隠す」トグル時に、
    // 再生成せず resolved を出し入れして再描画するために保持する(resolved は activeAnnotations から外れるため別に持つ)。
    private lastFull: Map<string, SemanticAnnotation[]> = new Map();

    // AI_NOTE: [レビュー] "reanchor が lastFull を上書きするので、タイピング途中の一過性の不一致で注釈が恒久消失する"
    // → 生成時の注釈集合を「不変の突合元」として別に保持する。reanchor は毎回ここ(原本)からアンカー文字列で位置を取り直す。
    // アンカーが一時的に見つからない瞬間は表示から外れるだけで原本には残り、テキストが戻れば次のキーストロークで復活する。
    private baseFull: Map<string, SemanticAnnotation[]> = new Map();

    // AI_NOTE: diffモードの変更行(新側0-based)。uri が居れば diffモードON=変更行に重なる注釈だけ表示。
    private diffLines: Map<string, Set<number>> = new Map();

    // AI_NOTE: AI編集検知の提案中範囲(0-based行、bulkEditDetector由来)。uri が居れば提案UI(ハイライト+CodeLens)表示中。
    // 蓄積は extension 側で発火時に消えるため、クリック時に行集合を引けるのは本Mapだけ(唯一の保持者)。
    private pendingSuggestion = new Map<string, Set<number>>();

    // AI_NOTE: ブロックの noteCol(サイドノート開始列)を startLine 毎に保持。provideCodeLenses が状態CodeLensを
    // 点字空白パディングで noteCol まで寄せ、コメント(サイドノート)の真上にボタンを出すのに使う。
    private blockNoteCol: Map<string, Map<number, number>> = new Map();

    // AI_NOTE: CodeLens の再描画通知。applyAnnotations 後に fire して上の専用行を出す
    private readonly _codeLensEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._codeLensEmitter.event;

    // AI_NOTE: チャットペインの注釈一覧用。applyAnnotations / clearEditor で fire し、サイドバーWebviewを再描画させる
    private readonly _annotationsEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChangeAnnotations = this._annotationsEmitter.event;

    // AI_NOTE: エディタ URI → 適用済みアノテーション一覧。ホバー判定に使う
    private activeAnnotations: Map<string, AppliedAnnotation[]> = new Map();

    // AI_NOTE: エディタ URI → 重なりグループID → 前面に出している block index。切替操作だけで変わる表示状態。
    private activeBlockLayer: Map<string, Map<string, number>> = new Map();

    // AI_NOTE: エディタ URI → 注釈を表示し始めた時刻。チャットペインの「最終生成」表示に使う
    private lastGeneratedAt: Map<string, Date> = new Map();

    // AI_NOTE: chatLinkStore は「チャット引用→過去チャット」リンクの独立永続レイヤー。extension.ts が生成し
    // mainViewProvider と共有注入する(同一インスタンスで生成と描画を突き合わせるため)。描画時に mergeChatLinks で合流する。
    private readonly chatLinkStore: ChatLinkStore;
    private readonly extensionPath: string;

    constructor(storageUri: vscode.Uri, chatLinkStore: ChatLinkStore, extensionPath: string) {
        this.cache = new AnnotationCache(storageUri);
        this.statusStore = new AnnotationStatusStore(storageUri.fsPath);
        this.chatLinkStore = chatLinkStore;
        this.extensionPath = extensionPath;
    }

    // 名称辞書は対象範囲の全名称を保証する。旧注釈の状態・警告・diff・粒度フィルタは適用せず、
    // 利用者が「名称辞書を表示」をOFFにした場合だけ全体を隠す。
    private visibilityOpts(uri: string): { hideResolved: boolean; warningsOnly: boolean; changedLines: Set<number> | null; allHidden: boolean; showHidden: boolean; showSymbol: boolean; showBlock: boolean } {
        const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
        return {
            hideResolved: false,
            warningsOnly: false,
            changedLines: null,
            allHidden: !cfg.get<boolean>("showAnnotations", true),
            showHidden: true,
            showSymbol: true,
            showBlock: false,
        };
    }

    private async generateDictionary(code: string): Promise<SemanticAnnotation[]> {
        const occurrences = await extractSymbols(this.extensionPath, code);
        return generateSymbolDictionaryAnnotations(code, occurrences);
    }

    // AI_NOTE: 下線(symbol)解説の置き場所。below=対象行の下にCodeLens(既定) / right=行末の右余白にラベル+ホバー /
    // hover=常時表示は下線だけで解説はホバー時のみ(下CodeLensも右ラベルも出さない)。未知値は既定のbelowへ倒す。
    private symbolPlacement(): "below" | "right" | "hover" {
        const v = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("symbolAnnotationPlacement", "hover");
        return v === "right" || v === "hover" ? v : "below";
    }

    // AI_NOTE: 実行トレース表示中かの問い合わせ口(extension.ts が TraceProvider を挿す)。トレースと注釈は
    // 右余白の同じ場所を使うため排他。トレース中に生成が終わった注釈を描くと値の上に文字が重なる。
    private isTraceActive: (uri: string) => boolean = () => false;

    setTraceActiveCheck(check: (uri: string) => boolean): void {
        this.isTraceActive = check;
    }

    // AI_NOTE: diffモードの ON/OFF を表示用に返す(サイドバーのボタン状態に使う)。
    isDiffMode(uri: string): boolean {
        return this.diffLines.has(uri);
    }

    // AI_NOTE: 表示の単一入口。状態フィルタ前の全注釈(絶対座標)を lastFull に保存し、状態/表示モードで
    // 絞って applyAnnotations へ渡す。全表示パスはここを通す。フィルタ判定は純粋関数 selectVisibleAnnotations に委譲。
    private applyWithStatus(editor: vscode.TextEditor, annotations: SemanticAnnotation[]): void {
        const uri = editor.document.uri.toString();
        annotations = annotations.filter((annotation) => annotation.kind === "symbol");
        // AI_NOTE: lastFull は「LLM注釈のみ」を保つ(chatLinksは混ぜない)。混ぜると状態トグル時に再merge→二重付与になるため。
        // chatLinks は描画のたびに store から取り直して合流する(reanchorで座標も毎回取り直すので編集にも追従)。
        this.lastFull.set(uri, annotations);
        const merged = this.mergeChatLinks(editor, annotations).filter((annotation) => annotation.kind === "symbol");
        const visible = selectVisibleAnnotations(merged, (id) => this.statusStore.get(uri, id), this.visibilityOpts(uri));
        this.applyAnnotations(editor, visible, 0);
    }

    // AI_NOTE: chatLinks(チャット引用由来のリンク)をLLM注釈集合へ合流する。
    // (a)同じ場所(id一致)のLLM注釈があれば、そのexplanation(ホバー)に会話ジャンプを「追記」する(labelは壊さない)。
    // (b)一致するLLM注釈が無ければ、保存labelを見出しにした注釈を合成して足す。
    // 座標は保存時のヒントを信用せず reanchorAnnotations で現在テキストから取り直す(アンカーが消えたリンクは自然に落ちる)。
    private mergeChatLinks(editor: vscode.TextEditor, llm: SemanticAnnotation[]): SemanticAnnotation[] {
        const uri = editor.document.uri.toString();
        const links = this.chatLinkStore.getForUri(uri);
        if (links.length === 0) return llm;

        const sessionsById = new Map<string, string[]>();
        for (const l of links) sessionsById.set(l.annotation.id, l.sessionIds);
        // AI_NOTE: 保存注釈を現在コードへ再アンカー。id/label/anchorは保たれ、座標だけ今の行に合う。
        const reanchored = reanchorAnnotations(links.map((l) => l.annotation), editor.document.getText());

        const jumpById = new Map<string, string>();
        for (const a of reanchored) {
            const ids = sessionsById.get(a.id);
            if (ids && ids.length > 0) jumpById.set(a.id, this.buildChatJumpMarkdown(ids));
        }
        // AI_NOTE: 追記/合成の判定は純粋関数(annotationResolver.mergeChatLinkAnnotations)に委譲=単体テスト可能にする。
        return mergeChatLinkAnnotations(llm, reanchored, (id) => jumpById.get(id));
    }

    // AI_NOTE: ホバーに埋める会話ジャンプリンク。command:openChatById に sessionId を渡す。複数会話は「·」区切りで並べる。
    private buildChatJumpMarkdown(sessionIds: string[]): string {
        const links = sessionIds.map((id, i) => {
            const arg = encodeURIComponent(JSON.stringify({ sessionId: id }));
            const label = sessionIds.length === 1 ? "この箇所の会話へ" : `会話${i + 1}`;
            return `[💬 ${label}](command:aiCodeGuide.openChatById?${arg})`;
        });
        return `\n\n${links.join(" · ")}`;
    }

    // AI_NOTE: 生成(全体/範囲)の確定結果を適用する入口。lastFull の表示更新に加え、reanchor の不変な突合元として
    // baseFull にも保存する。状態トグルや reanchor 経由の applyWithStatus は baseFull を更新しない(原本を汚さない)。
    private applyGenerated(editor: vscode.TextEditor, annotations: SemanticAnnotation[]): void {
        this.baseFull.set(editor.document.uri.toString(), annotations);
        this.applyWithStatus(editor, annotations);
    }

    // AI_NOTE: 行内インレイの状態チップから呼ぶ。状態を保存→再描画する。
    // フィードバックと取り消しは「行内のインレイチップ」が担う: applyWithStatus→applyAnnotations が inlay を再fireするので、
    // 押すとその場のチップ表示(状態:○○)が即更新され、「戻す」も同じ場所に出る(クリック不要・常時表示・ホバーと被らない)。
    setAnnotationStatus(uri: string, id: string, status: AnnotationStatus | null): void {
        this.statusStore.set(uri, id, status);
        const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === uri);
        const full = this.lastFull.get(uri);
        if (editor && full) this.applyWithStatus(editor, full);
    }

    // AI_NOTE: 「解決済みを隠す」トグル後に、表示中エディタを再生成せず再描画する。
    refreshVisibility(editor: vscode.TextEditor): void {
        const full = this.lastFull.get(editor.document.uri.toString());
        if (full) this.applyWithStatus(editor, full);
    }

    // AI_NOTE: chatLink 追加後などに uri 指定で再描画する(LLM再生成なし)。チャットはサイドバー由来で対象エディタが
    // 非フォーカスのこともあるため editor でなく uri で引く。baseFull(LLM原本)があれば座標を取り直して合流、
    // 無ければ chatLinks 単独で描画する(applyWithStatus 経由で mergeChatLinks が合流)。
    refreshEditorByUri(uri: string): void {
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
        if (!editor) return;
        if ((this.baseFull.get(uri)?.length ?? 0) > 0) this.reanchorEditor(editor);
        else this.applyWithStatus(editor, []);
    }

    // AI_NOTE: HoverProvider 実装。カーソル位置がアノテーション範囲内かチェックしてポップアップを返す
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Hover | undefined {
        const applied = this.activeAnnotations.get(document.uri.toString());
        if (!applied) return undefined;

        // AI_NOTE: 二重表示の防止。サイドノートは行末(EOL)より右の余白に透明 after で描き、その上を
        // ホバーすると VS Code は after を実レイアウトとして拾い provideHover も発火する。だがその余白は
        // noteHoverType デコの hoverMessage が担当する。ここで「col >= 行末」は undefined を返して provideHover を
        // コード本体(col < 行末)だけに限定し、余白(ノート)はデコ側に一本化する＝同じ場所で2枚出るのを防ぐ。
        if (position.character >= document.lineAt(position.line).text.length) return undefined;

        // AI_NOTE: block は行全体一致・symbol は列範囲一致。下線(symbol)はブロック内に重なるので、
        // 一致した中で「最も具体的=列範囲を持つ symbol」を block より優先する（広い block に狭い下線が食われるのを防ぐ）。
        const matches = applied.filter(a => this.containsPosition(a, position));
        // AI_NOTE: block が重なっている場所では、表示されている(枠とサイドノートが出ている)前面ブロックを選ぶ。
        // 素の matches[0] は重なり順の先頭＝背面のこともあり、画面に見えている解説と別の文が出てしまっていた。
        const fronts = new Set(this.getBlockGroups(document.uri.toString(), applied).map(g => g.blocks[g.activeIndex].applied));
        const target = matches.find(a => a.absStartCol !== null) ?? matches.find(a => fronts.has(a)) ?? matches[0];
        if (!target) return undefined;

        const { annotation: ann, absStartLine, absEndLine, absStartCol, absEndCol } = target;

        // AI_NOTE: コード側のホバーでも切替リンクを出す(サイドノート側と内容を揃える)。symbol は重なり切替の対象外。
        const md = this.buildHoverMarkdown(
            document, ann, absStartLine, absEndLine,
            this.findLayer(document.uri.toString(), target),
            absStartCol !== null && absEndCol !== null ? { start: absStartCol, end: absEndCol } : undefined,
        );
        const hoverRange = new vscode.Range(
            absStartLine, absStartCol ?? 0,
            absEndLine, absEndCol ?? document.lineAt(absEndLine).text.length,
        );
        return new vscode.Hover(md, hoverRange);
    }

    // AI_NOTE: この注釈が重なりグループの前面ブロックなら、その切替情報を返す(それ以外は undefined)。
    // 表示中の前面だけを対象にするのは、背面ブロックには枠もサイドノートも出ない＝ホバーの的が無いため。
    private findLayer(uri: string, target: AppliedAnnotation): { groupId: string; index: number; total: number } | undefined {
        if (target.annotation.kind !== "block") return undefined;
        const applied = this.activeAnnotations.get(uri);
        if (!applied) return undefined;
        for (const group of this.getBlockGroups(uri, applied)) {
            if (group.blocks.length < 2) continue;
            if (group.blocks[group.activeIndex].applied !== target) continue;
            return { groupId: group.id, index: group.activeIndex, total: group.blocks.length };
        }
        return undefined;
    }

    // AI_NOTE: ホバー本文(label見出し＋explanation＋💬リンク)を組み立てるヘルパー。provideHover から使う。
    private buildHoverMarkdown(
        document: vscode.TextDocument,
        ann: SemanticAnnotation,
        absStartLine: number,
        absEndLine: number,
        layer?: { groupId: string; index: number; total: number },
        cols?: { start: number; end: number },
    ): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true; // AI_NOTE: command: リンクを有効にするため必須
        const prefix = ann.severity === "warning" ? "⚠ " : "";
        const codeSnippet = this.getCodeSnippet(document, absStartLine, absEndLine);
        const args = encodeURIComponent(JSON.stringify({ codeSnippet, explanation: this.quoteText(ann) }));
        if (ann.kind === "symbol") {
            const kind = ann.symbolKind
                ? ({ variable: "変数", function: "関数", method: "メソッド", class: "クラス" } as const)[ann.symbolKind]
                : "名称";
            // AI_NOTE: Codex名称カードと同じ順序にする。名称のすぐ右へ明示操作を置き、コード自体のクリックは奪わない。
            md.appendMarkdown(`**${prefix}${ann.label}**　[質問する](command:aiCodeGuide.openAnnotationChat?${args})\n\n_${kind}_\n\n`);
        }
        // AI_NOTE: ホバーのポップアップが対象コードに被って「解説は読めるがコードが見えない」状態になるので、
        // symbol だけ対象行1行を先頭に載せて単体で読み切れるようにする。block はサイドノートで範囲が見えており
        // 行数も多いので載せない。インデントは幅を食うだけなので落とす。
        // AI_NOTE: 行全体だけだと「行のどこが下線か」が消えるので、コンパイラのエラー表示と同じ形で
        // 対象トークンの真下に ^ を敷く。列は displayWidth(全角=2)で数え、行頭インデントを落とした分だけ左へ寄せる。
        if (ann.kind === "symbol") {
            const raw = document.lineAt(absStartLine).text;
            const indent = raw.length - raw.trimStart().length;
            let block = raw.trim();
            if (cols && cols.start >= indent) {
                const pad = displayWidth(raw.slice(indent, cols.start));
                const len = Math.max(1, displayWidth(raw.slice(cols.start, cols.end)));
                block += `\n${" ".repeat(pad)}${"^".repeat(len)}`;
            }
            md.appendCodeblock(block, document.languageId);
        }
        // AI_NOTE: symbol の explanation は「単体で完結するホバー本文」として生成する(claudeClient のプロンプト)ので、
        // label(常時表示用の短い見出し)を頭に付けない=同じ内容が二度出るのを防ぐ。警告だけは⚠が要るので記号のみ残す。
        // block は label が枠の右に常時見えている前提で explanation を「一段深い理解」に絞っているため、従来どおり見出しを付ける。
        md.appendMarkdown(ann.kind === "symbol"
            ? ann.explanation
            : `**${prefix}${ann.label}**\n\n${ann.explanation}\n\n[質問する](command:aiCodeGuide.openAnnotationChat?${args})`);
        // AI_NOTE: 重なりブロックの切替は CodeLens を廃してここへ移した(CodeLensを使わない方針)。
        // 何枚目を見ているかが分からないと切替の意味が伝わらないので、位置(N/M)とリンクを同じ行に出す。
        if (layer && layer.total > 1) {
            const arg = encodeURIComponent(JSON.stringify([document.uri.toString(), layer.groupId]));
            md.appendMarkdown(`\n\n重なった説明 ${layer.index + 1}/${layer.total} ・ [次を表示](command:aiCodeGuide.toggleBlockLayer?${arg})`);
        }
        md.appendMarkdown(this.buildStatusActions(document.uri.toString(), ann));
        return md;
    }

    // AI_NOTE: ホバーは現在状態の「表示」だけに留める(操作はしない)。
    // 操作と即時フィードバックは「行内のインレイチップ」(buildStatusParts)へ一本化し、ホバーは状態の確認だけにする。
    private buildStatusActions(uri: string, ann: SemanticAnnotation): string {
        // AI_NOTE: 状態ボタンOFF時はチップが存在しないので、案内ごと出さない(存在しないUIへの誘導を防ぐ)。
        if (!vscode.workspace.getConfiguration("aiCodeGuide").get<boolean>("showAnnotationStatusButtons", false)) return "";
        const cur = this.statusStore.get(uri, ann.id);
        const state = cur ? STATUS_LABEL[cur] : "未読";
        // AI_NOTE: symbol のチップは下CodeLens行にしか無いので、below以外(right/hover)では存在しない。
        // 同じ理由で案内文だけ落とし、状態の表示は残す(存在しないUIへ誘導しない)。block のチップは常に出るので従来どおり。
        const hasChip = ann.kind === "block" || this.symbolPlacement() === "below";
        return `\n\n---\n状態: **${state}**${hasChip ? " （変更は行末の「読んだ／後で／解決」チップから）" : ""}`;
    }

    // AI_NOTE: CodeLensProvider 実装。symbol（下線）の解説と、重なった block の前面/背面切替を表示する。
    // 同一行に symbol が複数あるときの扱い:
    //   1個 → 直下(line+1)に1つ、`↑` でコードを指す。
    //   2個以上 → 直下(line+1)の1行に連結（トークン名前置で対応を示す）。
    //   縦積みは VSCode が同一アンカー行の複数 CodeLens を横並びにする仕様で対象行の真下に重ねられず、
    //   別アンカーへずらすと対応関係がズレて読めなくなるため採用しない。常に連結に寄せる。
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const uri = document.uri.toString();
        // AI_NOTE: AI編集検知の提案CodeLensは注釈の有無と独立に出す。既存の「注釈なし=[]」早期returnの
        // 後ろに置くと注釈未生成ファイルで提案が出なくなるため、必ずこの位置で先に積む。
        const suggestionLenses = this.buildSuggestionLenses(document);
        const applied = this.activeAnnotations.get(uri) ?? [];
        // symbol辞書はコードの行間を増やさない。クリック質問はCodex表示、VS Codeでは標準Hoverを使う。
        return suggestionLenses;
        /* legacy annotation lenses retained below until the old block renderer is removed */

        const symbols = applied
            .filter(a => a.annotation.kind === "symbol")
            .sort((a, b) => a.absStartLine - b.absStartLine || (a.absStartCol ?? 0) - (b.absStartCol ?? 0));

        // AI_NOTE: 行 → その行に乗っている symbol 一覧（列順）
        const byLine = new Map<number, AppliedAnnotation[]>();
        for (const a of symbols) {
            const arr = byLine.get(a.absStartLine) ?? [];
            arr.push(a);
            byLine.set(a.absStartLine, arr);
        }

        // AI_NOTE: 1個は単独 CodeLens、2個以上は line+1 の1行に連結。縦積みは廃止したので衝突予約は不要。
        // 提案CodeLensを先頭に積む(状態CodeLens(▭/↑)と同行に来てもVS Codeが横並びにするので衝突対策は不要)。
        // 右モードでは applyAnnotations が全symbol行を右余白に出すので、下CodeLens・原点固定フィラーは一切出さない。
        // hoverモードは常時表示が下線だけ＝下CodeLensも右ラベルも出さない(解説・状態はホバーへ集約)。below以外は同じ扱い。
        const placement = this.symbolPlacement();
        const belowLines: number[] = []; // AI_NOTE: 下CodeLensを出した行=末尾フィラーで原点固定が要る行
        const blockStatusLines: number[] = []; // AI_NOTE: ブロック状態行(▭)を出した行=同じく原点固定フィラーが要る
        const lenses: vscode.CodeLens[] = [...suggestionLenses];
        for (const [line, arr] of byLine) {
            if (placement !== "below") continue;
            const anchorLine = Math.min(line + 1, document.lineCount - 1);
            belowLines.push(line);
            if (arr.length === 1) {
                lenses.push(this.buildSymbolLens(document, arr[0], anchorLine));
                // AI_NOTE: 単一symbolの解説行に状態ボタンを横並びで足す(解説にボタン=ユーザー要望)。
                lenses.push(...this.buildStatusLenses(uri, arr[0], anchorLine));
                continue;
            }
            lenses.push(this.buildCombinedLens(document, arr, anchorLine));
            // AI_NOTE: 1行に複数symbolの時も各symbolに状態ボタンを足す(以前は連結CodeLensだけで状態が無かった)。
            // どのsymbolの状態か分かるよう、連結解説と同じ丸数字(①②…)をマーカーに使う。
            arr.forEach((a, i) => lenses.push(...this.buildStatusLenses(uri, a, anchorLine, `${circledMarker(i)} `)));
        }
        const noteColMap = this.blockNoteCol.get(uri);
        for (const group of this.getBlockGroups(uri, applied)) {
            // AI_NOTE: [変更] 重なりブロックの前面/背面切替は CodeLens を廃止し、block のホバー内リンクへ移した
            // (buildHoverMarkdown の layer 引数)。CodeLensを表示手段として使わない方針のため。
            // AI_NOTE: 前面ブロックの状態操作を CodeLens でブロック真上に出す(▭マーカー)。普通クリックで発火。
            // CodeLensは行頭(インデント位置)起点なので、noteCol-インデント分だけ点字空白で右へ寄せ、コメント(サイドノート)の真上に並べる。
            // symbol解説CodeLensと同じ行に同居しても、symbol="↑…"/block="▭…" で区別できる(VS Codeが横並びにする)。
            const front = group.blocks[group.activeIndex];
            const noteCol = noteColMap?.get(front.startLine);
            // AI_NOTE: コメント本文は noteCol+INSET 列(CSS ch厳密)に出る。状態行はCodeLensの点字空白U+2800(≈0.954ch)で寄せるので、
            // 目標列にLENS_PAD_RATIO(=1/0.954)を掛けて敷かないと noteCol×0.046 ぶん左に届かない。単独行なら下のフィラーで
            // 原点=列0にクランプされ target×RATIO の点字数でぴったり乗る。
            // [変更] 衝突時(下線状態行や layers lens と同一アンカー行)は、VSCodeが先行lensを " | " で左から連結し、▭の点字は
            //   列0でなく先行lensの右端から数え始まる。よって target から先行lensの実表示幅(consumed)を引いてから点字数に直す
            //   =可能な限りサイドノート列へ寄せる(先行幅>targetなら pad=0=これ以上は寄せられない)。
            const target = (noteCol ?? 0) + SemanticAnnotationProvider.SIDENOTE_TEXT_INSET;
            const consumed = this.rowConsumedColumns(lenses, front.startLine);
            const padCols = noteCol !== undefined ? Math.max(0, Math.round((target - consumed) * LENS_PAD_RATIO)) : 0;
            // AI_NOTE: 状態ボタンOFFのときは行自体が空になるので、原点固定フィラーも撒かない
            // (撒くと点字空白だけのCodeLens行=見た目まっさらな1行がブロックの上に増える)。
            const statusLenses = this.buildStatusLenses(uri, front.applied, front.startLine, "▭ ", padCols);
            if (statusLenses.length === 0) continue;
            lenses.push(...statusLenses);
            blockStatusLines.push(front.startLine);
        }
        // AI_NOTE: CodeLens行のx原点を列0に固定する透明フィラー(行の最後に積む)。VS Code本体はCodeLens行を
        // 「アンカー行の非空白開始列」に置くが、行ウィジェット全幅がビューポートを超えると left=scrollLeft(=列0)へ
        // クランプする(contentWidgets._layoutBoxInViewport)。原点が「アンカー行のインデント or 0」で揺れるのが
        // ズレ方に法則が見えなかった真因なので、フィラーで常に幅超過させ原点=列0を確定させる。
        // [変更] 旧「▭行は巨大padで元々常時クランプ」は誤り。padが浅い(noteColが小さい)ブロック状態行は幅超過せず
        // 原点=そのブロック先頭行のインデント列になり、状態行がインデント分だけ右へズレていた(下線と非同居でも発生)。
        // → 下線行(line+1)に加えブロック状態行(front.startLine)にも必ずフィラーを撒く。Set で dedup し二重に積まない。
        const fillerLines = new Set<number>([
            ...belowLines.map(line => Math.min(line + 1, document.lineCount - 1)),
            ...blockStatusLines,
        ]);
        for (const anchorLine of fillerLines) {
            lenses.push(new vscode.CodeLens(new vscode.Range(anchorLine, 0, anchorLine, 0), {
                title: "⠀".repeat(800), command: "aiCodeGuide.noop", arguments: [],
            }));
        }
        return lenses;
    }

    // AI_NOTE: AI編集検知の提案CodeLens(実行/閉じる)。アンカーは検知行集合の最小行=範囲先頭
    // (編集で行数が縮んだ直後に備えて文書末へクランプ)。arguments は extension.ts のコマンド登録が
    // {uri} オブジェクトで受ける契約なので形を合わせる。装飾絵文字は使わない(memory: 装飾絵文字禁止)。
    private buildSuggestionLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const uri = document.uri.toString();
        const lines = this.pendingSuggestion.get(uri);
        if (!lines || lines.size === 0) return [];
        const anchorLine = Math.min(Math.min(...lines), document.lineCount - 1);
        const range = new vscode.Range(anchorLine, 0, anchorLine, 0);
        return [
            new vscode.CodeLens(range, {
                title: `AI編集を検知(${lines.size}行) — この範囲を解説する`,
                command: "aiCodeGuide.annotateDetectedEdit",
                arguments: [{ uri }],
                tooltip: "検知した変更範囲に絞ってインライン解説を生成する",
            }),
            new vscode.CodeLens(range, {
                title: "閉じる",
                command: "aiCodeGuide.dismissDetectedEdit",
                arguments: [{ uri }],
                tooltip: "この提案を消す(解説は生成しない)",
            }),
        ];
    }

    // AI_NOTE: 衝突アンカー行で「▭状態行より先に置かれた lens」が食う表示幅(列)を見積もる。
    // VSCodeは同一アンカー行のCodeLensを " | " 区切りで左から連結するので、▭の点字パディングは列0でなく
    // この幅の右端から数え始まる。点字U+2800は約0.954ch(=1/LENS_PAD_RATIO)、他は displayWidth、区切りは約3ch で加算。
    // count=0(単独行)なら 0 を返す＝従来通り target×RATIO で列0からぴったり乗る。
    private rowConsumedColumns(lenses: vscode.CodeLens[], line: number): number {
        const SEP = 3; // " | " ぶん(VSCodeのlens区切り)
        const ICON = 2; // $(layers)等のアイコン記法は生文字列長でなく1グリフ≈2ch でレンダリングされる
        let cols = 0;
        let count = 0;
        for (const l of lenses) {
            if (l.range.start.line !== line) continue;
            const raw = l.command?.title ?? "";
            const icons = (raw.match(/\$\([^)]+\)/g) ?? []).length;
            // AI_NOTE: $(...) を除いた実文字だけ幅計上し、アイコンは実レンダリング幅(ICON)で足す。生文字列長で数えると過大→引きすぎで左へ寄りすぎる。
            const title = raw.replace(/\$\([^)]+\)/g, "");
            for (const ch of title) cols += ch === "⠀" ? 1 / LENS_PAD_RATIO : displayWidth(ch);
            cols += icons * ICON;
            count++;
        }
        return count === 0 ? 0 : cols + count * SEP;
    }

    // AI_NOTE: 状態操作を CodeLens で出す(クリック可能=普通クリックで発火)。「状態:○○」ラベル(表示専用 noop)＋
    // 各アクション(setAnnotationStatus)を別々の CodeLens にし VS Code が横並びにする。
    // marker: symbolは""(解説の隣に並ぶ) / blockは"▭ "(ブロック真上。同じ行にsymbol解説が同居しても▭で区別できる)。
    // padCols: 先頭ラベルに点字空白を前置して右へ寄せる量(0=左寄せ)。block は noteCol まで寄せてコメント(サイドノート)の真上に置く。
    private buildStatusLenses(uri: string, a: AppliedAnnotation, anchorLine: number, marker = "", padCols = 0): vscode.CodeLens[] {
        // AI_NOTE: トリアージ(状態)機能を使わない人向け。OFFなら状態チップを丸ごと出さない(解説CodeLens自体は残る)。
        if (!vscode.workspace.getConfiguration("aiCodeGuide").get<boolean>("showAnnotationStatusButtons", false)) return [];
        const range = new vscode.Range(anchorLine, 0, anchorLine, 0);
        const cur = this.statusStore.get(uri, a.annotation.id);
        const lenses: vscode.CodeLens[] = [
            new vscode.CodeLens(range, { title: `${"⠀".repeat(padCols)}${marker}状態:${cur ? STATUS_LABEL[cur] : "未読"}`, command: "aiCodeGuide.noop", arguments: [] }),
        ];
        const add = (status: AnnotationStatus | null, text: string) =>
            lenses.push(new vscode.CodeLens(range, { title: text, command: "aiCodeGuide.setAnnotationStatus", arguments: [{ uri, id: a.annotation.id, status }] }));
        if (cur) add(null, "戻す");
        if (cur !== "read") add("read", "読んだ");
        if (cur !== "later") add("later", "後で");
        if (cur !== "resolved") add("resolved", "解決");
        // AI_NOTE: ③ この注釈だけ非表示にする。hidden中は「隠した注釈も表示」ONのときだけ行が出るので、そこで「戻す」で復帰。
        if (cur !== "hidden") add("hidden", "隠す");
        return lenses;
    }

    // AI_NOTE: チャット引用に渡す説明文。単一クリック/連結クリック/ホバーの💬 で必ずこれを通し、入口で文がブレないようにする。
    // 見出し(label)＋詳細(explanation)を両方含める（ホバー表示と同じ情報量）。
    private quoteText(ann: SemanticAnnotation): string {
        return `${ann.label}\n${ann.explanation}`;
    }

    // AI_NOTE: ↑padの一元計算。pad=下線開始の表示列×LENS_PAD_RATIO(U+2800実測幅補正)。
    // 原点は本来「アンカー行の非空白開始列」(codelensWidget.updatePosition)だが、provideCodeLenses末尾の
    // 透明フィラーで行幅を常にビューポート超にし、クランプ(left=列0)を強制して原点=列0に固定している。
    // この前提が崩れる(フィラーを外す)と、原点が下の行のインデントに揺れてpadが合わなくなる。
    private symbolPadCount(document: vscode.TextDocument, a: AppliedAnnotation): number {
        if (a.absStartCol === null) return 0;
        const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
        const tabSize = typeof editor?.options.tabSize === "number" ? editor.options.tabSize : 4;
        const target = displayColumn(document.lineAt(a.absStartLine).text, a.absStartCol, tabSize);
        return Math.round(target * LENS_PAD_RATIO);
    }

    // AI_NOTE: 単一 symbol → 1 CodeLens を組み立てる。直下アンカーから `↑` で1行上のトークンを指す。
    // 1個だけの行はどの下線か自明なのでマーカー・トークン名なし。💬は廃止し warning だけ ⚠ を残す。
    private buildSymbolLens(
        document: vscode.TextDocument,
        a: AppliedAnnotation,
        anchorLine: number,
    ): vscode.CodeLens {
        const warnIcon = a.annotation.severity === "warning" ? "$(warning) " : "";
        // AI_NOTE: タイトル先頭の空白は CodeLens が削るので点字パターン空白(U+2800)で字下げする。
        // pad量は symbolPadCount(原点相対×幅補正)に一元化。連結版(buildCombinedLens)と揃える。
        const blank = "⠀";
        const padCount = this.symbolPadCount(document, a);
        const title = `${blank.repeat(padCount)}↑ ${warnIcon}${a.annotation.label}`;
        const codeSnippet = this.getCodeSnippet(document, a.absStartLine, a.absEndLine);
        // AI_NOTE: 詳細(explanation)はコードの下線ホバー(provideHover, 即時・markdown)に一本化する。
        // CodeLens の tooltip は string のみ＆VS Code制御の遅延で即時/装飾を合わせられないため、操作ヒントだけに留める。
        return new vscode.CodeLens(new vscode.Range(anchorLine, 0, anchorLine, 0), {
            title,
            command: "aiCodeGuide.openAnnotationChat",
            arguments: [{ codeSnippet, explanation: this.quoteText(a.annotation) }],
            tooltip: "クリックで質問（詳細は下線にホバー）",
        });
    }

    // AI_NOTE: 同一行2個以上の連結 CodeLens。番号(①②…)を列順で振り、どの下線の解説かを示す（トークン名前置・コード側マーカーは廃止）。
    // クリックは「行全体＋①②両方の解説」をまとめて引用する。1行に対しクリックは1つしか張れず、per-token 分割は縦積みに逆戻りするため敢えて統合。
    // 字下げは「先頭 symbol の列」基準。💬は廃止し warning だけ ⚠ を残す。
    private buildCombinedLens(
        document: vscode.TextDocument,
        arr: AppliedAnnotation[],
        anchorLine: number,
    ): vscode.CodeLens {
        const blank = "⠀";
        // AI_NOTE: pad=先頭symbol基準の symbolPadCount で ↑ が①の真下を指す(単独版buildSymbolLensと同じ計算)。
        const first = arr[0];
        const padCount = this.symbolPadCount(document, first);
        const parts = arr.map((a, i) => {
            const warnIcon = a.annotation.severity === "warning" ? "$(warning) " : "";
            return `${circledMarker(i)} ${warnIcon}${a.annotation.label}`;
        });
        const title = `${blank.repeat(padCount)}↑ ${parts.join("  ／  ")}`;
        // AI_NOTE: 引用は行全体（symbol は単行なので first の行 = 全 symbol 共通の行）。explanation は ①② を見出しに両方連結。
        const codeSnippet = this.getCodeSnippet(document, first.absStartLine, first.absEndLine);
        const explanation = arr.map((a, i) => `${circledMarker(i)} ${this.quoteText(a.annotation)}`).join("\n\n");
        // AI_NOTE: 詳細は各下線のホバー(provideHover, 即時)に集約。tooltip は string＋VS Code遅延で即時/装飾を合わせられないため操作ヒントのみ。
        return new vscode.CodeLens(new vscode.Range(anchorLine, 0, anchorLine, 0), {
            title,
            command: "aiCodeGuide.openAnnotationChat",
            arguments: [{ codeSnippet, explanation }],
            tooltip: "クリックで①②すべてを引用して質問（詳細は各下線にホバー）",
        });
    }

    // AI_NOTE: 自動トリガー用。ファイル全体を解析対象にする
    // AI_NOTE: ファイル全体を解析する。force=true（再生成ボタン）のときだけキャッシュを無視してLLMを再呼び出しする。
    // 既存の range 注釈は full 再生成でも資産として残し、新 full と重なる範囲だけ dedup で吸収する。
    async annotateFile(editor: vscode.TextEditor, force = false): Promise<AnnotateResult> {
        const doc = editor.document;
        const code = doc.getText();
        const uri = doc.uri.toString();

        const cached = this.cache.get(uri, code) ?? [];
        // AI_NOTE: full 由来の注釈が既にあれば「全体生成済み」とみなし再生成しない（無料・高速）。force 時のみ作り直す。
        const hasFull = cached.some(a => a.scope === "full");
        if (hasFull && !force) {
            this.applyGenerated(editor, cached);
            return { status: "cached", count: cached.length };
        }
        // AI_NOTE: withProgress の戻り値をそのまま返し、呼び出し側(ボタン状態表示)へ結果を伝える。
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "AI Code Guide: 解説を生成中..." },
            async (): Promise<AnnotateResult> => {
                // AI_NOTE: API起因のエラー(無効キー/失効/レート超過)は握り潰さず原因を表示する。生成0件とは区別する。
                let annotations: SemanticAnnotation[];
                try {
                    annotations = await this.generateDictionary(code);
                } catch (e) {
                    vscode.window.showErrorMessage(`AI Code Guide: ${e instanceof Error ? e.message : String(e)}`);
                    return { status: "empty", count: 0 };
                }
                if (annotations.length === 0) {
                    // AI_NOTE: 0件の主因はAI出力のJSON破損。生出力は出力パネルに残してあるので、その場所を必ず案内する。
                    vscode.window.showWarningMessage(
                        "AI Code Guide: 解説を生成できませんでした。AIの出力が壊れている可能性があります（表示 > 出力 > AI Code Guide に生の出力が残ります）。もう一度お試しください。",
                    );
                    return { status: "empty", count: 0 };
                }
                // AI_NOTE: 新 full で full を総入れ替え、既存 range は残してマージ。dedup の優先度で full が range に勝つ。
                const fresh = annotations.map(a => ({ ...a, scope: "full" as const }));
                const keptRanges = cached.filter(a => a.scope === "range");
                const merged = dedupAnnotations([...fresh, ...keptRanges]);
                this.cache.set(uri, code, merged);
                this.applyGenerated(editor, merged);
                return { status: "generated", count: merged.length };
            }
        );
    }

    // AI_NOTE: ① 起動/ファイル切替時の無料復元。キャッシュに full があればLLMを呼ばず表示するだけ。
    // annotateFile と違い「無ければ生成せず黙って return」する点が肝（自動生成=有料 と キャッシュ復元=無料 を分離）。
    restoreFromCache(editor: vscode.TextEditor): boolean {
        const doc = editor.document;
        const uri = doc.uri.toString();
        const cached = this.cache.get(uri, doc.getText()) ?? [];
        if (cached.some(a => a.scope === "full")) {
            this.applyGenerated(editor, cached);
            return true;
        }
        // AI_NOTE: LLM注釈キャッシュが無くても chatLinks があれば単独で描画する(再オープンで会話リンクを復元する経路)。
        // applyWithStatus(空配列)経由で mergeChatLinks が chatLinks を合流→表示する。baseFull は空のまま。
        if (this.chatLinkStore.getForUri(uri).length > 0) {
            this.applyWithStatus(editor, []);
            return true;
        }
        return false;
    }

    // AI_NOTE: diffモードON。git の未コミット変更行を取り、diffLines に保存してから annotateFile を回す。
    // annotateFile は applyWithStatus 経由で表示するので、visibilityOpts.changedLines により変更行に重なる注釈だけが出る
    // (生成自体はファイル全体。コスト削減のハンク限定送信は将来課題)。変更が無ければ何もせず知らせる。
    async annotateDiff(editor: vscode.TextEditor): Promise<AnnotateResult> {
        const uri = editor.document.uri.toString();
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const cwd = folder?.uri.fsPath ?? path.dirname(editor.document.uri.fsPath);
        let changed: Set<number>;
        try {
            changed = await getChangedLines(editor.document.uri.fsPath, cwd);
        } catch (e) {
            vscode.window.showErrorMessage(`AI Code Guide: git 差分の取得に失敗しました（gitリポジトリか確認してください）。${e instanceof Error ? e.message : String(e)}`);
            return { status: "empty", count: 0 };
        }
        if (changed.size === 0) {
            vscode.window.showInformationMessage("AI Code Guide: 未コミットの変更行がありません（diffモードにしませんでした）。");
            return { status: "empty", count: 0 };
        }
        this.diffLines.set(uri, changed);
        return this.annotateFile(editor);
    }

    // AI_NOTE: diffモードOFF。変更行フィルタを外し、再生成せず全件へ戻す。
    exitDiffMode(editor: vscode.TextEditor): void {
        this.diffLines.delete(editor.document.uri.toString());
        this.refreshVisibility(editor);
    }

    // AI_NOTE: 一括変更検知(extension.ts側)からの提案表示口。pendingSuggestion へ上書き保存するので、
    // 提案表示中に再検知が来たら範囲を更新して出し直す形になる(古い提案は消える)。LLMはまだ呼ばない。
    showSuggestion(editor: vscode.TextEditor, lines: Set<number>): void {
        this.pendingSuggestion.set(editor.document.uri.toString(), lines);
        this.applySuggestionHighlight(editor);
        this._codeLensEmitter.fire();
    }

    // AI_NOTE: 提案UI(ハイライト+CodeLens)を消す。「閉じる」/解説実行時/clearEditor から呼ばれる。
    // エディタが visible でない(タブ切替済み等)場合は decoration を触れないが、pendingSuggestion が消えていれば
    // 再表示時に applyAnnotations 系が張り直すことはないので実害なし。
    dismissSuggestion(uri: string): void {
        if (!this.pendingSuggestion.delete(uri)) return;
        const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === uri);
        if (editor) editor.setDecorations(this.suggestionHighlightType, []);
        this._codeLensEmitter.fire();
    }

    // AI_NOTE: CodeLens「この範囲を解説する」の実行口。行集合の取得→提案UIを先に消してから生成へ渡す
    // (生成は数十秒かかるため、押した瞬間に提案が消えないと二度押しされる)。提案が無い/エディタ不在なら何もしない。
    async acceptSuggestion(uri: string): Promise<void> {
        const lines = this.pendingSuggestion.get(uri);
        if (!lines) return;
        const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === uri);
        if (!editor) return;
        this.dismissSuggestion(uri);
        await this.annotateSuggested(editor, lines);
    }

    // AI_NOTE: 検知範囲に絞った生成口(suggest承諾/autoモード共通)。diffLines に検知行を入れてから annotateFile を回すことで、
    // 既存の visibilityOpts.changedLines → selectVisibleAnnotations が無改修で効き、検知範囲に重なる注釈だけが表示される
    // (生成・キャッシュはファイル全体)。autoモードから直接呼ばれた場合に備え、残っている提案UIを冒頭で片付ける。
    async annotateSuggested(editor: vscode.TextEditor, lines: Set<number>): Promise<void> {
        const uri = editor.document.uri.toString();
        if (this.pendingSuggestion.has(uri)) this.dismissSuggestion(uri);
        this.diffLines.set(uri, lines);
        await this.annotateFile(editor);
    }

    // AI_NOTE: pendingSuggestion の行集合を連続区間へ潰して提案ハイライトを張り直す(uri不在なら空=クリア)。
    // isWholeLine デコなので Range は各区間の先頭行〜末尾行の col0 で足りる。文書外の行番号(全文リロード直後の
    // 行数減など)は Range 生成前に落とし、VS Code 側の暗黙クランプに頼らない。
    private applySuggestionHighlight(editor: vscode.TextEditor): void {
        const raw = this.pendingSuggestion.get(editor.document.uri.toString());
        const lines = [...(raw ?? [])].filter(l => l < editor.document.lineCount).sort((a, b) => a - b);
        const ranges: vscode.Range[] = [];
        for (const line of lines) {
            const last = ranges[ranges.length - 1];
            if (last && line === last.end.line + 1) ranges[ranges.length - 1] = new vscode.Range(last.start.line, 0, line, 0);
            else ranges.push(new vscode.Range(line, 0, line, 0));
        }
        editor.setDecorations(this.suggestionHighlightType, ranges);
    }

    // AI_NOTE: 手動トリガー用。選択範囲のみを解析する(関数自動検出は廃止: 隠し機能化していて発見性が悪かった)。
    // 未選択時は警告して即return。MainViewProvider 側がボタン押下時に「選択モード」へ誘導するUXを担う。
    async annotate(editor: vscode.TextEditor): Promise<AnnotateResult> {
        if (editor.selection.isEmpty) {
            vscode.window.showWarningMessage(
                "AI Code Guide: コードを範囲選択してから実行してください。"
            );
            return { status: "empty", count: 0 };
        }
        const startLine = editor.selection.start.line;
        const endLine = editor.selection.end.line;
        const rangeCode = editor.document.getText(
            new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length)
        );
        // AI_NOTE: キャッシュはファイル全文キーに統一し、full と同じバケツに range を貯める（互いに上書きしないため）。
        const fullCode = editor.document.getText();
        const uri = editor.document.uri.toString();

        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "AI Code Guide: 解説を生成中..." },
            async (): Promise<AnnotateResult> => {
                // AI_NOTE: API起因のエラーは握り潰さず原因を表示する(生成0件と区別)。
                let annotations: SemanticAnnotation[];
                try {
                    annotations = await this.generateDictionary(rangeCode);
                } catch (e) {
                    vscode.window.showErrorMessage(`AI Code Guide: ${e instanceof Error ? e.message : String(e)}`);
                    return { status: "empty", count: 0 };
                }
                if (annotations.length === 0) {
                    // AI_NOTE: 0件の主因はAI出力のJSON破損。生出力は出力パネルに残してあるので、その場所を必ず案内する。
                    vscode.window.showWarningMessage(
                        "AI Code Guide: 解説を生成できませんでした。AIの出力が壊れている可能性があります（表示 > 出力 > AI Code Guide に生の出力が残ります）。もう一度お試しください。",
                    );
                    return { status: "empty", count: 0 };
                }
                // AI_NOTE: 範囲解析の座標はスニペット相対なので startLine を足して絶対行に直し、scope=range で既存にマージする。
                const fresh = annotations.map(a => ({
                    ...a, scope: "range" as const,
                    startLine: a.startLine + startLine, endLine: a.endLine + startLine,
                }));
                // AI_NOTE: 新 range を先頭に置く。dedup 優先度は full>range なので full は守られ、同じ場所の旧 range には新 range が勝つ（再解析で更新）。
                const existing = this.cache.get(uri, fullCode) ?? [];
                const merged = dedupAnnotations([...fresh, ...existing]);
                this.cache.set(uri, fullCode, merged);
                this.applyGenerated(editor, merged);
                // AI_NOTE: count はファイル全体の表示総数(union)。バッジ件数と一致させる。
                return { status: "generated", count: merged.length };
            }
        );
    }

    // AI_NOTE: 全装飾タイプをまとめる。クリア・破棄で1つずつ列挙する重複を避ける
    private get allDecorationTypes(): vscode.TextEditorDecorationType[] {
        return [
            this.symbolDecorationType, this.symbolWarnDecorationType, this.symbolReadDecorationType,
            this.symbolRightType,
            this.boxInfoType, this.boxWarnType,
            this.labelDecorationType, this.noteHoverType,
            this.suggestionHighlightType, // AI_NOTE: 提案ハイライトもここに含め、clearEditor/clearAll/dispose の既存経路で一括処理する
        ];
    }

    // AI_NOTE: チャットペインの注釈一覧/件数/最終生成時刻に使う。表示中のアノテーション(applied)を生データ(SemanticAnnotation[])で返す
    getAnnotations(editor: vscode.TextEditor): { items: SemanticAnnotation[]; generatedAt: Date | null } {
        const uri = editor.document.uri.toString();
        const applied = this.activeAnnotations.get(uri) ?? [];
        return {
            items: applied.map(a => a.annotation),
            generatedAt: this.lastGeneratedAt.get(uri) ?? null,
        };
    }

    // AI_NOTE: Codex/MCP background requests generate and persist annotations for
    // an explicit document without selecting a VS Code tab or applying decorations.
    // Lines are 1-based at the public bridge boundary.
    async annotateDocument(
        document: vscode.TextDocument,
        startLine?: number,
        endLine?: number,
        force = false,
    ): Promise<AnnotateResult> {
        const code = document.getText();
        const uri = document.uri.toString();
        const cached = this.cache.get(uri, code) ?? [];
        if (startLine === undefined && cached.some((item) => item.scope === "full") && !force) {
            return { status: "cached", count: cached.length };
        }
        const first = startLine === undefined
            ? 0
            : Math.max(0, Math.min(startLine - 1, document.lineCount - 1));
        const last = endLine === undefined
            ? document.lineCount - 1
            : Math.max(first, Math.min(endLine - 1, document.lineCount - 1));
        const source = startLine === undefined
            ? code
            : document.getText(new vscode.Range(first, 0, last, document.lineAt(last).text.length));
        const generated = await this.generateDictionary(source);
        if (generated.length === 0) return { status: "empty", count: 0 };
        const fresh = generated.map((item) => startLine === undefined
            ? { ...item, scope: "full" as const }
            : {
                ...item,
                scope: "range" as const,
                startLine: item.startLine + first,
                endLine: item.endLine + first,
            });
        const merged = startLine === undefined
            ? dedupAnnotations([...fresh, ...cached.filter((item) => item.scope === "range")])
            : dedupAnnotations([...fresh, ...cached]);
        this.cache.set(uri, code, merged);
        this.lastGeneratedAt.set(uri, new Date());
        this._annotationsEmitter.fire(document.uri);
        return { status: "generated", count: merged.length };
    }

    // AI_NOTE: MCPの保存済み一覧は、トレースとの排他表示や表示フィルタに左右されない永続キャッシュを正とする。
    // activeAnnotations は「今描画中」だけなので、トレース中に生成・保存できた結果を0件と誤報しないため入口を分ける。
    getSavedAnnotations(editor: vscode.TextEditor): { items: SemanticAnnotation[]; generatedAt: Date | null } {
        return this.getSavedAnnotationsForDocument(editor.document);
    }

    getSavedAnnotationsForDocument(document: vscode.TextDocument): { items: SemanticAnnotation[]; generatedAt: Date | null } {
        const uri = document.uri.toString();
        return {
            items: this.cache.get(uri, document.getText()) ?? [],
            generatedAt: this.lastGeneratedAt.get(uri) ?? null,
        };
    }

    // AI_NOTE: Codexの会話からの部分修正は、ファイル全体を再生成せず現在内容ハッシュの保存結果だけを置換する。
    // 生成失敗時のロールバックにも同じ入口を使い、ディスク・VS Code表示・再アンカー原本を必ず揃える。
    replaceSavedAnnotations(editor: vscode.TextEditor, annotations: SemanticAnnotation[]): void {
        const uri = editor.document.uri.toString();
        this.cache.set(uri, editor.document.getText(), annotations);
        this.applyGenerated(editor, annotations);
    }

    replaceSavedAnnotationsForDocument(document: vscode.TextDocument, annotations: SemanticAnnotation[]): void {
        this.cache.set(document.uri.toString(), document.getText(), annotations);
        this._annotationsEmitter.fire(document.uri);
    }

    updateSymbolExplanationForDocument(document: vscode.TextDocument, symbolKey: string, explanation: string): number {
        const uri = document.uri.toString();
        const code = document.getText();
        const cached = this.cache.get(uri, code) ?? [];
        let updated = 0;
        const next = cached.map((annotation) => {
            if (annotation.kind !== "symbol" || annotation.symbolKey !== symbolKey) return annotation;
            updated++;
            return { ...annotation, explanation };
        });
        if (updated === 0) return 0;
        this.cache.set(uri, code, next);
        const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === uri);
        if (editor) this.applyGenerated(editor, next);
        else this._annotationsEmitter.fire(document.uri);
        return updated;
    }

    isAnnotationHidden(uri: string, id: string): boolean {
        return this.statusStore.get(uri, id) === "hidden";
    }

    clearEditor(editor: vscode.TextEditor): void {
        for (const t of this.allDecorationTypes) editor.setDecorations(t, []);
        this.activeAnnotations.delete(editor.document.uri.toString());
        this.activeBlockLayer.delete(editor.document.uri.toString());
        this.lastFull.delete(editor.document.uri.toString());
        this.baseFull.delete(editor.document.uri.toString()); // AI_NOTE: 明示クリアは原本も捨てる(復活させない)
        this.diffLines.delete(editor.document.uri.toString());
        // AI_NOTE: 提案中の一括変更検知も明示クリアで破棄する(decoration は上の allDecorationTypes 一括で消えている)。
        // CodeLens の fire は直下の既存処理が兼ねるので dismissSuggestion は呼ばず二重発火を避ける。
        this.pendingSuggestion.delete(editor.document.uri.toString());
        this.lastGeneratedAt.delete(editor.document.uri.toString());
        this._codeLensEmitter.fire();
        // AI_NOTE: チャットペインの一覧も空に更新するため fire
        this._annotationsEmitter.fire(editor.document.uri);
    }

    clearAll(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            for (const t of this.allDecorationTypes) editor.setDecorations(t, []);
        }
        this.activeAnnotations.clear();
        this.activeBlockLayer.clear();
        this.lastFull.clear();
        this.baseFull.clear(); // AI_NOTE: 明示クリアは原本も捨てる(復活させない)
        this.diffLines.clear();
        this.pendingSuggestion.clear(); // AI_NOTE: 全クリアでは提案状態も残さない(decoration は上の一括クリアで消えている)
        this.lastGeneratedAt.clear();
        this._codeLensEmitter.fire();
    }

    // AI_NOTE: 重なった block の前面表示を循環させる。再生成せず、保持済みの適用済み注釈を再描画する。
    toggleBlockLayer(uri: string, groupId: string): void {
        const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === uri);
        const applied = this.activeAnnotations.get(uri);
        if (!editor || !applied) return;

        const group = this.getBlockGroups(uri, applied).find(g => g.id === groupId);
        if (!group || group.blocks.length <= 1) return;

        const state = this.getBlockLayerState(uri);
        state.set(group.id, (group.activeIndex + 1) % group.blocks.length);
        const annotations = applied.map(a => ({
            ...a.annotation,
            startLine: a.absStartLine,
            endLine: a.absEndLine,
            startCol: a.absStartCol,
            endCol: a.absEndCol,
        }));
        this.applyAnnotations(editor, annotations, 0);
    }

    // AI_NOTE: 編集時の増分再突合。表示中の注釈を新コードのアンカーで取り直し、全消し→再生成(数十秒+課金)を避ける。
    // 適用済みが無ければ false(=元から無いので呼び出し側は何もしない)。アンカーが全滅したら clearEditor、
    // 1件でも残れば座標を更新して再適用する。LLMは呼ばない。
    reanchorEditor(editor: vscode.TextEditor): boolean {
        const uri = editor.document.uri.toString();
        // AI_NOTE: 突合元は不変の原本(baseFull)。lastFull(前回の reanchor 結果)を源にすると、一過性の不一致で
        // 落ちた注釈が二度と戻らない。原本から毎回取り直せば、テキストが戻った瞬間に注釈も復活する。
        // 原本は隠れた resolved も含む絶対座標なのでそのまま reanchor に渡せる。
        const base = this.baseFull.get(uri) ?? [];
        // AI_NOTE: chatLinks があれば LLM注釈ゼロ(baseFull空)でも描画経路に入る(編集追従＋会話リンク単独表示のため)。
        const hasChatLinks = this.chatLinkStore.getForUri(uri).length > 0;
        if (base.length === 0 && !hasChatLinks) return false;
        const reanchored = base.length > 0 ? reanchorAnnotations(base, editor.document.getText()) : [];
        if (reanchored.length === 0 && !hasChatLinks) {
            // AI_NOTE: 表示・状態だけ消し、原本(baseFull)は残す。全アンカーが一時的に外れただけならテキスト復帰で戻せるようにする。
            for (const t of this.allDecorationTypes) editor.setDecorations(t, []);
            // AI_NOTE: 上の一括クリアは提案ハイライトも巻き込むが、提案(pendingSuggestion)は注釈と独立の状態なので
            // ここで張り直す。消さないと CodeLens だけ残ってハイライトが無い中途半端なUIになる。
            this.applySuggestionHighlight(editor);
            this.activeAnnotations.delete(uri);
            this.lastFull.delete(uri);
            this._codeLensEmitter.fire();
            this._annotationsEmitter.fire(editor.document.uri);
            return true;
        }
        this.applyWithStatus(editor, reanchored);
        return true;
    }

    dispose(): void {
        for (const t of this.allDecorationTypes) t.dispose();
        this._codeLensEmitter.dispose();
        this._annotationsEmitter.dispose();
    }

    // AI_NOTE: ハイブリッド表示。
    // symbol（下線）→ 解説はコードに近い「行の上の CodeLens」（案A）。場所の印は点線下線。
    // block（複数行）→ コード領域と右サイドノートを1つの枠に入れ、内部仕切り線で読み分ける。
    // 色系統は severity（info=オレンジ / warning=赤）。
    private static readonly SIDENOTE_GAP = 4;
    private static readonly SIDENOTE_MIN_COL = 50;
    private static readonly SIDENOTE_MAX_COL = 88; // AI_NOTE: 短いブロックの右余白が広がりすぎない上限。長いコード行があるブロックだけ上限を超えて逃がす
    private static readonly SIDENOTE_TEXT_INSET = 2; // AI_NOTE: 仕切り線と説明本文が密着しないよう、本文開始だけ右にずらす
    private static readonly SIDENOTE_WIDTH = 48;     // AI_NOTE: 説明欄の表示幅(半角=1/全角=2、≒日本語24字)。横に余裕があるので40→48に拡幅し改行を減らす。長文はこの幅内で折り返し/省略
    private static readonly RANGE_BAR_TICK_PX = 6;   // AI_NOTE: 縦線の上端/下端から左へ出す爪の長さ(px)。範囲の始端/終端を示す。境目の余白に収まる短さ
    // AI_NOTE: 右モードの下線ラベルは省略しない(実質上限なし)。CodeLens(下)がlabelを切らないのに右だけ切ると
    // 常時表示テキストが痩せる(labelとexplanationは別内容なので切ると情報が消える)。長い分はA1でブロック列を押し出して収める。
    private static readonly SYMBOL_RIGHT_MAX_WIDTH = 1000; // 実質無制限。生成labelは高々数十桁なので runaway しない
    private static readonly SYMBOL_RIGHT_GAP = 2;         // AI_NOTE: コード末尾とラベル開始の間隔(ch)。before絶対配置の left で作る(空白文字を挟まない=点字glyph化を避ける)
    private static readonly SYMBOL_RIGHT_MIN_WIDTH = 4;   // AI_NOTE: block列手前に確保できる幅の下限(A1で全幅確保済みなので通常は使わない安全弁)

    private applyAnnotations(editor: vscode.TextEditor, annotations: SemanticAnnotation[], startLine: number): void {
        const uri = editor.document.uri.toString();
        // AI_NOTE: トレース中は描かない(生成がトレース開始後に終わった場合の重なり防止)。キャッシュには残るので
        // 「解説表示に戻る」の restoreFromCache で出る。
        if (this.isTraceActive(uri)) return;
        {
            // 名称辞書は見た目を一切変更しない。座標だけをHover判定用に保持する。
            const doc = editor.document;
            const applied = annotations.flatMap((annotation): AppliedAnnotation[] => {
                if (annotation.kind !== "symbol" || annotation.startCol === null || annotation.endCol === null) return [];
                const line = startLine + annotation.startLine;
                if (line < 0 || line >= doc.lineCount) return [];
                const lineLength = doc.lineAt(line).text.length;
                const startCol = Math.max(0, Math.min(annotation.startCol, lineLength));
                const endCol = Math.max(startCol, Math.min(annotation.endCol, lineLength));
                if (endCol <= startCol) return [];
                return [{
                    annotation,
                    absStartLine: line,
                    absEndLine: line,
                    absStartCol: startCol,
                    absEndCol: endCol,
                }];
            });
            this.activeAnnotations.set(uri, applied);
            for (const decoration of this.allDecorationTypes) editor.setDecorations(decoration, []);
            this.applySuggestionHighlight(editor);
            this._codeLensEmitter.fire();
            this._annotationsEmitter.fire(editor.document.uri);
            return;
        }

        /* legacy block/symbol decoration implementation retained temporarily for migration history */
        const doc = editor.document;
        const applied: AppliedAnnotation[] = [];
        const symbolDecos: vscode.DecorationOptions[] = [];
        const symbolWarnDecos: vscode.DecorationOptions[] = [];
        const symbolReadDecos: vscode.DecorationOptions[] = [];
        // AI_NOTE: ブロックの枠は targetCol 確定後に行ごとに renderOptions を組むため、ここでは範囲だけ集める
        const blockNotes: BlockNote[] = [];
        for (const ann of annotations) {
            const warn = ann.severity === "warning";
            // AI_NOTE: read(読んだ)は「処理済み」として薄いグレーで de-emphasize する。severity より優先(read なら赤でもグレー)。
            const read = this.statusStore.get(uri, ann.id) === "read";
            const absStart = startLine + ann.startLine;
            const absEnd = startLine + ann.endLine;
            if (absStart >= doc.lineCount) continue;
            const clampedEnd = Math.min(absEnd, doc.lineCount - 1);

            if (ann.kind === "symbol" && ann.startCol !== null && ann.endCol !== null) {
                // AI_NOTE: インデント空白への下線を防ぐため、行の最初の非空白列を startCol の下限にする
                // AI_NOTE: 下線はコードに字を足さない（①②はコードを汚すので廃止）。対応は CodeLens 側の番号と列順で示す。
                const firstNonWs = doc.lineAt(absStart).firstNonWhitespaceCharacterIndex;
                const effectiveStart = Math.max(ann.startCol!, firstNonWs);
                const deco = { range: new vscode.Range(absStart, effectiveStart, absStart, ann.endCol!) };
                (read ? symbolReadDecos : warn ? symbolWarnDecos : symbolDecos).push(deco);
                applied.push({
                    annotation: ann,
                    absStartLine: absStart, absEndLine: absStart,
                    absStartCol: effectiveStart, absEndCol: ann.endCol,
                });
            } else {
                const item = {
                    annotation: ann,
                    absStartLine: absStart, absEndLine: clampedEnd,
                    absStartCol: null, absEndCol: null,
                };
                // AI_NOTE: 常時表示は step1=label。なぜ(step2)は applied.annotation.explanation としてホバーで出す。
                blockNotes.push({ applied: item, startLine: absStart, endLine: clampedEnd, label: ann.label, warn, read });
                applied.push(item);
            }
        }

        // AI_NOTE: [変更] 枠は前面ブロックの解説欄だけに付ける。裏(重なり)ブロックの枠は廃止したので
        // backBlocks の収集はしない。重なりの切替・存在表示は layers CodeLens が担う。
        const blockGroups = this.getBlockGroupsForNotes(uri, blockNotes);
        const frontBlocks = new Set<BlockNote>();
        // AI_NOTE: 前面ブロック → そのグループの切替情報。ホバーに「重なった説明 N/M・次を表示」を出すのに使う。
        const layerByBlock = new Map<BlockNote, { groupId: string; index: number; total: number }>();
        for (const group of blockGroups) {
            const front = group.blocks[group.activeIndex];
            frontBlocks.add(front);
            layerByBlock.set(front, { groupId: group.id, index: group.activeIndex, total: group.blocks.length });
        }

        // AI_NOTE: サイドノートは「縦線」と「本文」を別デコにする。両方とも列基準を ch に統一して交差を防ぐ。
        // 「線にめり込む」と「線が途切れる」両方を踏まえた最終形。過去の試行（再履行しないこと）:
        //   - 没A: 本文を after の margin "だけ" で字下げ → 当時は NBSP個数併用で実描画がズレた（最初期）
        //   - 案B: 本文も線も before の position:absolute(ch) に固定 → 列は揃うが仮想テキストにホバー判定が無い（33376ca）
        //   - 没C: ホバー優先で本文を after の "NBSP個数" 字下げに → 線(before ch絶対)と二重基準になり全角/⚠/端数で交差（605a3fa）
        //   - 没D: 線を本文と同じ after 要素の border-left に統合 → 交差はしないが、border が文字の行ボックス高さしか無く
        //          行間に隙間ができて縦線が途切れて見える（2026-06-28、本コミットで撤回）
        //   - 没E: 線=before絶対(height:100%で1本) / 本文=after の margin ch。ASCII行は揃うが、after は「コード行末」基準で
        //          全角を含むコード行(日本語docstring等)はエディタのCJK実描画幅≠displayWidthでドリフトし、その行の本文だけ線を超える
        //   → 結論F: 案B に戻す。線も本文も before の position:absolute(ch) で固定する。
        //      本文は left=(noteCol+INSET)ch 固定なので「コード行の幅」に一切依存しない＝CJK行でもドリフトしない。線は height:100% で1本。
        //      ホバー: 仮想テキスト自体に当たり判定は無いが、下で余白に不可視の noteHoverType を重ねて当たり判定を作るので、
        //      ノートの上をホバーしても step2＋状態操作が出る（コード本体は従来どおり provideHover が担当）。
        const INSET = SemanticAnnotationProvider.SIDENOTE_TEXT_INSET;
        interface NoteLine { text: string; warn: boolean; read: boolean; noteCol: number; top: boolean; bottom: boolean }
        const noteLines = new Map<number, NoteLine>(); // 全行（縦線用）
        const textLines = new Map<number, NoteLine>(); // 本文がある行のみ
        // AI_NOTE: サイドノート余白(行末〜noteCol+幅)に当たり判定を置き、ノートのホバーでも step2＋状態操作を出す。
        const noteHoverDecos: vscode.DecorationOptions[] = [];
        // AI_NOTE: ブロック状態は CodeLens(▭)でブロック真上に出す(provideCodeLenses)。よってここでは状態チップを行内に出さず、
        // 説明は1行目から通常通り流す。noteCol は最長コード幅+gap(min/max クランプ)で、チップ用の確保はしない。
        // noteCol は blockNoteCol に保存し、provideCodeLens が状態CodeLensを noteCol まで寄せて「コメント真上」に置く。
        const noteColMap = new Map<number, number>();
        this.blockNoteCol.set(uri, noteColMap);
        // AI_NOTE: 右モードの下線ラベルが「その行のブロック列」を手前で避けるための、行→noteCol の全行マップ。
        // noteColMap は startLine キーのみなので、ブロック内の任意行から列を引くにはこちらを使う。
        const blockLineNoteCol = new Map<number, number>();
        // AI_NOTE: 右モードの下線ラベル(行→表示テキスト/幅)を先に確定する。ブロック列(noteCol)は下でこの幅を内側レーンに
        // 確保して右へ押し出す(潰さず全部見せる=A1: 下線=内側/ブロック=外側)。noteCol計算より前に必要なのでここで作る。
        const rightMode = this.symbolPlacement() === "right";
        const symbolRight = new Map<number, { text: string; warn: boolean; read: boolean; width: number }>();
        if (rightMode) {
            const symByLine = new Map<number, AppliedAnnotation[]>();
            for (const a of applied) {
                if (a.annotation.kind !== "symbol" || a.absStartCol === null) continue;
                const arr = symByLine.get(a.absStartLine) ?? [];
                arr.push(a);
                symByLine.set(a.absStartLine, arr);
            }
            for (const [line, arr] of symByLine) {
                arr.sort((x, y) => (x.absStartCol ?? 0) - (y.absStartCol ?? 0));
                const warn = arr.some(a => a.annotation.severity === "warning");
                const read = arr.every(a => this.statusStore.get(uri, a.annotation.id) === "read");
                const raw = arr.length === 1
                    ? (warn ? "⚠ " : "") + arr[0].annotation.label
                    : arr.map((a, i) => `${circledMarker(i)} ${a.annotation.label}`).join("  ");
                const text = ellipsizeByWidth(raw, SemanticAnnotationProvider.SYMBOL_RIGHT_MAX_WIDTH);
                symbolRight.set(line, { text, warn, read, width: displayWidth(text) });
            }
        }
        for (const b of frontBlocks) {
            const height = b.endLine - b.startLine + 1;
            let maxLineWidth = 0;
            for (let ln = b.startLine; ln <= b.endLine; ln++) {
                maxLineWidth = Math.max(maxLineWidth, displayWidth(doc.lineAt(ln).text));
            }
            let rawNoteCol = maxLineWidth + SemanticAnnotationProvider.SIDENOTE_GAP;
            // AI_NOTE: A1。右モードでブロック行に下線ラベルがあるなら、その行の内側レーン(コード末尾+GAP+ラベル幅+1)分だけ
            // noteCol を右へ押し出して場所を作る。これでラベルは潰れず全表示、ブロック列はその外側に分離する。
            if (rightMode) {
                for (let ln = b.startLine; ln <= b.endLine; ln++) {
                    const s = symbolRight.get(ln);
                    if (!s) continue;
                    const need = displayWidth(doc.lineAt(ln).text) + SemanticAnnotationProvider.SYMBOL_RIGHT_GAP + s!.width + 1;
                    rawNoteCol = Math.max(rawNoteCol, need);
                }
            }
            const noteCol = rawNoteCol > SemanticAnnotationProvider.SIDENOTE_MAX_COL
                ? rawNoteCol
                : Math.max(SemanticAnnotationProvider.SIDENOTE_MIN_COL, rawNoteCol);
            noteColMap.set(b.startLine, noteCol);
            for (let ln = b.startLine; ln <= b.endLine; ln++) blockLineNoteCol.set(ln, noteCol);

            const parts = buildSidenoteLines(b.label, b.warn, height, SemanticAnnotationProvider.SIDENOTE_WIDTH);
            // AI_NOTE: ホバー本文は block 全体で1つ。provideHover(コード側)と同じ buildHoverMarkdown を使い内容を揃える。
            const hover = this.buildHoverMarkdown(doc, b.applied.annotation, b.startLine, b.endLine, layerByBlock.get(b));
            for (let ln = b.startLine; ln <= b.endLine; ln++) {
                const v: NoteLine = {
                    text: parts[ln - b.startLine] ?? "",
                    warn: b.warn,
                    read: b.read,
                    noteCol,
                    top: ln === b.startLine,
                    bottom: ln === b.endLine,
                };
                noteLines.set(ln, v);
                if (!v.text) continue;
                textLines.set(ln, v);
                // AI_NOTE: ホバーの的。EOLレンジだけでは VS Code にクランプされ的が無いので、実レイアウトに乗る
                // 透明な after 実テキストを重ねる(見える本文は before絶対のまま)。pad=noteCol+INSET-表示幅。
                const lineStr = doc.lineAt(ln).text;
                const padCount = Math.max(0, Math.round(noteCol + INSET - displayWidth(lineStr)));
                const eol = lineStr.length;
                noteHoverDecos.push({
                    range: new vscode.Range(ln, eol, ln, eol),
                    hoverMessage: hover,
                    renderOptions: { after: { contentText: "⠀".repeat(padCount) + v.text, color: "transparent" } },
                });
            }
        }

        // AI_NOTE: 縦線＋上下の爪（案A）。要素を left=noteCol-TICKpx・width=TICKpx に置き、border-right(=noteCol)を縦線にする。
        //   height:100% で隣接行と繋がり1本になる。先頭行に border-top・末尾行に border-bottom を足すと、縦線の上端/下端から
        //   左へ TICKpx の短い横線（爪）が出て、ノートが指すコード範囲の始端/終端が分かる。border-width は "上 右 下 左"。
        //   left を px 込みの calc にするのは爪を「線の左」に出すため。pointer-events:none でカーソル計算に影響させない。
        const TICK = SemanticAnnotationProvider.RANGE_BAR_TICK_PX;
        const lineInfoDecos: vscode.DecorationOptions[] = [];
        const lineWarnDecos: vscode.DecorationOptions[] = [];
        for (const [line, v] of noteLines) {
            // AI_NOTE: read(読んだ)は severity より優先で薄いグレー。色は inline css なのでバケツ(info/warn型)は read を info 側に寄せる。
            const color = v.read ? "rgba(140,140,140,0.5)" : v.warn ? "rgba(245,90,90,0.8)" : "rgba(255,165,0,0.7)";
            const css = `none; position: absolute; pointer-events: none; box-sizing: border-box; left: calc(${v.noteCol}ch - ${TICK}px); top: 0; width: ${TICK}px; height: 100%; border-style: solid; border-color: ${color}; border-width: ${v.top ? 2 : 0}px 2px ${v.bottom ? 2 : 0}px 0;`;
            (v.warn && !v.read ? lineWarnDecos : lineInfoDecos).push({
                range: new vscode.Range(line, 0, line, 0),
                renderOptions: { before: { contentText: "", textDecoration: css } },
            });
        }

        // AI_NOTE: 本文。before の position:absolute; left=(noteCol+INSET)ch でコード行幅に依存せず固定配置する（CJK行でもドリフトしない）。
        //   線(before, left=noteCol ch)と同じ ch 基準・同じ行頭起点なので、線の INSET 右にぴったり収まり交差しない。
        //   white-space:pre で折返し済みテキストをそのまま1行で出す。pointer-events:none でカーソル計算に影響させない。
        const labelDecos: vscode.DecorationOptions[] = [...textLines].map(([line, v]) => {
            const css = `none; position: absolute; pointer-events: none; left: ${v.noteCol + INSET}ch; white-space: pre;`;
            return {
                range: new vscode.Range(line, 0, line, 0),
                renderOptions: {
                    before: {
                        contentText: v.text,
                        // AI_NOTE: read(読んだ)は薄いグレーで de-emphasize(severityより優先)。
                        color: v.read ? "rgba(155,155,155,0.6)" : v.warn ? "rgba(245,110,110,0.95)" : "rgba(255,180,90,0.9)",
                        fontStyle: "italic",
                        textDecoration: css,
                    },
                },
            };
        });

        // AI_NOTE: 右モード。下線の解説を対象行の右余白に before の position:absolute で出す(下CodeLensの代わり)。
        // ・空白文字を挟まず left(ch) で間隔を作る＝点字空白(U+2800)がフォントで可視glyph化する問題を回避。
        // ・block行でも右に出す(ここが要件の肝)。コード直後(eol+GAP)の「内側レーン」に置き、その行のブロック列(noteCol)の
        //   手前で幅を打ち切る＝ブロックのサイドノート(noteCol以降=外側レーン)と列が分かれ重ならない。
        // ・同一行に複数下線があれば①②で連結。ホバー詳細はコードの下線(provideHover)が担うのでラベルには当たり判定不要。
        // ・CJKを含むコード行はeol実描画幅≠displayWidthでややドリフトするが、下線が付くのは識別子=ほぼASCII行なので許容。
        const symbolRightDecos: vscode.DecorationOptions[] = [];
        if (rightMode) {
            for (const [line, s] of symbolRight) {
                // AI_NOTE: 内側レーンの開始列=コード末尾+GAP。block行は上でnoteColをラベル幅分だけ押し出し済みなので、
                // noteCol手前(blockCol-1)まで=ラベル全幅が必ず収まる。非block行は最大幅までに収める(念のためellipsize)。
                const innerLeft = displayWidth(doc.lineAt(line).text) + SemanticAnnotationProvider.SYMBOL_RIGHT_GAP;
                const blockCol = blockLineNoteCol.get(line);
                const room = blockCol !== undefined
                    ? Math.max(SemanticAnnotationProvider.SYMBOL_RIGHT_MIN_WIDTH, blockCol! - 1 - innerLeft)
                    : SemanticAnnotationProvider.SYMBOL_RIGHT_MAX_WIDTH;
                const label = ellipsizeByWidth(s.text, room);
                const color = s.read ? "rgba(150,150,150,0.7)" : s.warn ? "rgba(245,110,110,0.95)" : "rgba(255,180,90,0.9)";
                const css = `none; position: absolute; pointer-events: none; left: ${innerLeft}ch; white-space: pre;`;
                symbolRightDecos.push({
                    range: new vscode.Range(line, 0, line, 0),
                    renderOptions: { before: { contentText: label, color, fontStyle: "italic", textDecoration: css } },
                });
            }
        }

        // 辞書対象は見た目を変えない。rangeはHoverProviderの当たり判定だけに使う。
        editor.setDecorations(this.symbolDecorationType, []);
        editor.setDecorations(this.symbolWarnDecorationType, []);
        editor.setDecorations(this.symbolReadDecorationType, []);
        editor.setDecorations(this.symbolRightType, []);
        editor.setDecorations(this.boxInfoType, []);
        editor.setDecorations(this.boxWarnType, []);
        editor.setDecorations(this.labelDecorationType, []);
        editor.setDecorations(this.noteHoverType, []);
        this.activeAnnotations.set(uri, applied);
        this.lastGeneratedAt.set(uri, new Date()); // AI_NOTE: チャットペインの「最終生成」表示用
        this._codeLensEmitter.fire(); // AI_NOTE: CodeLens(symbol解説/block状態)を再描画
        this._annotationsEmitter.fire(editor.document.uri); // AI_NOTE: チャットペイン一覧更新用
    }

    private getBlockLayerState(uri: string): Map<string, number> {
        const state = this.activeBlockLayer.get(uri) ?? new Map<string, number>();
        this.activeBlockLayer.set(uri, state);
        return state;
    }

    private getBlockGroups(uri: string, applied: AppliedAnnotation[]): BlockGroup[] {
        return this.getBlockGroupsForNotes(uri, this.getBlockNotes(uri, applied));
    }

    private getBlockGroupsForNotes(uri: string, notes: BlockNote[]): BlockGroup[] {
        return buildBlockGroups(notes, this.getBlockLayerState(uri));
    }

    // AI_NOTE: read は色付けにしか使わずグループ化(重なり判定)には無関係だが、型を満たすため status を引いて埋める。
    private getBlockNotes(uri: string, applied: AppliedAnnotation[]): BlockNote[] {
        return applied
            .filter(a => a.annotation.kind === "block")
            .map(a => ({
                applied: a,
                startLine: a.absStartLine,
                endLine: a.absEndLine,
                label: a.annotation.label,
                warn: a.annotation.severity === "warning",
                read: this.statusStore.get(uri, a.annotation.id) === "read",
            }));
    }

    private containsPosition(a: AppliedAnnotation, pos: vscode.Position): boolean {
        if (pos.line < a.absStartLine || pos.line > a.absEndLine) return false;
        if (a.absStartCol !== null && a.absEndCol !== null) {
            return pos.character >= a.absStartCol && pos.character <= a.absEndCol;
        }
        return true; // block: 行全体
    }

    private getCodeSnippet(doc: vscode.TextDocument, startLine: number, endLine: number): string {
        const clampedEnd = Math.min(endLine, doc.lineCount - 1);
        return doc.getText(new vscode.Range(startLine, 0, clampedEnd, doc.lineAt(clampedEnd).text.length));
    }
}
