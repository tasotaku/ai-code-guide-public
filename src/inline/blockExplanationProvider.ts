import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SemanticAnnotation, generateSymbolDictionaryAnnotations, symbolDictionaryCacheIdentity } from "../api/claudeClient";
import { extractGraph, extractSymbols } from "../flowchart/astParser";
import { buildSymbolAnnotation, dedupAnnotations, mergeChatLinkAnnotations, reanchorAnnotations } from "../api/annotationResolver";
import { ChatLinkStore } from "../view/chatLinkStore";
import { AnnotationStatusStore } from "./annotationStatusStore";
import { getKeyMissingReason } from "../api/llmProvider";
import { planSymbolDescriptionReuse } from "../api/symbolDictionaryCache";
import { createHash } from "crypto";

// AI_NOTE: インライン解説に使うモデル(設定スロット)を読む。キー未設定の事前判定に使う。
function inlineModel(): string {
    return vscode.workspace.getConfiguration("aiCodeGuide").get<string>("inlineAnnotationModel", "gpt-5.6-sol");
}

// AI_NOTE: 生成系メソッドの結果。チャットペインのボタン状態表示(完了/表示済み/失敗+件数)に使う。
// generated=LLMで新規生成 / cached=既存fullを表示しただけ / empty=結果0件(失敗)。
export type AnnotateResult = { status: "generated" | "cached" | "empty"; count: number };

// AI_NOTE: 内容と生成条件には衝突耐性のあるハッシュを使い、異なるソースの説明を混ぜない。
function fnv1a(str: string): string {
    return createHash("sha256").update(str).digest("hex");
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
    // anchor-v1: 名称に anchorText/anchorToken/id(位置由来の安定ID)を追加。
    //            旧データはこれらを欠くため版を上げて一掃する(編集追従・ステータス永続化の土台)。
    // anchor-v2: id に前後行(context)を加えて衝突回避。旧 id を持つキャッシュを一掃して付け直す。
    // hover-v1: symbol の explanation を「単体で完結するホバー本文」に再定義（旧版は label の続きで単体だと前段が抜ける）。
    //           文の役割が変わるだけで型は同じ＝欠落検知ができないので、版を上げて旧文を使わせない。
    private static readonly PROMPT_VERSION = "symbol-dictionary-evidence-v3";

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
            fs.writeFileSync(`${this.diskPath}.tmp`, JSON.stringify(obj), "utf8");
            fs.renameSync(`${this.diskPath}.tmp`, this.diskPath);
        } catch {
            // ディスク書き込み失敗はサイレントに無視
        }
    }

    private prefix(uri: string, generationIdentity: string): string {
        return `${uri}::${AnnotationCache.PROMPT_VERSION}::${fnv1a(generationIdentity)}::`;
    }

    get(uri: string, code: string, generationIdentity: string): SemanticAnnotation[] | undefined {
        const key = `${this.prefix(uri, generationIdentity)}${fnv1a(code)}`;
        const val = this.cache.get(key);
        if (val !== undefined) {
            this.cache.delete(key);
            this.cache.set(key, val);
        }
        return val;
    }

    // AI_NOTE: ファイル内容が変わった時だけ直前versionを探し、symbol fingerprint一致分の説明を再利用する。
    // generationIdentityが違うモデル・global context・prompt版のentryは候補にしない。
    getLatest(uri: string, generationIdentity: string): SemanticAnnotation[] {
        const prefix = this.prefix(uri, generationIdentity);
        const entries = [...this.cache.entries()];
        for (let index = entries.length - 1; index >= 0; index--) {
            const [key, value] = entries[index];
            if (!key.startsWith(prefix)) continue;
            this.cache.delete(key);
            this.cache.set(key, value);
            return value;
        }
        return [];
    }

    set(uri: string, code: string, generationIdentity: string, annotations: SemanticAnnotation[]): void {
        const key = `${this.prefix(uri, generationIdentity)}${fnv1a(code)}`;
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

// AI_NOTE: 名称辞書はコードを装飾せず、symbol の座標と説明をHoverへ提供する。
export class SemanticAnnotationProvider implements vscode.HoverProvider {

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

    // AI_NOTE: チャットペインの注釈一覧用。applyAnnotations / clearEditor で fire し、サイドバーWebviewを再描画させる
    private readonly _annotationsEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChangeAnnotations = this._annotationsEmitter.event;

    // AI_NOTE: エディタ URI → 適用済みアノテーション一覧。ホバー判定に使う
    private activeAnnotations: Map<string, AppliedAnnotation[]> = new Map();

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

    private async generateDictionary(
        code: string,
        reusable: SemanticAnnotation[] = [],
        force = false,
        options: { isCurrent?: () => boolean; uri?: string; fullDocument?: boolean } = {},
    ): Promise<SemanticAnnotation[]> {
        const identity = symbolDictionaryCacheIdentity();
        const key = JSON.stringify([options.uri, code, identity, force, !!options.fullDocument]);
        const guard = options.isCurrent ?? (() => true);
        const pending = this.dictionaryJobs.get(key);
        if (pending) {
            pending.guards.add(guard);
            try { return await pending.promise; }
            finally { pending.guards.delete(guard); }
        }
        const guards = new Set([guard]);
        // AI_NOTE: 同内容の画面要求だけ共有。1画面の停止は他の待機者を止めず、新版とは共有しない。
        const promise = (async () => {
            if (options.fullDocument) {
                const graph = await extractGraph(this.extensionPath, code);
                if (graph.error) throw new Error(`Pythonの構文を確認してください: ${graph.error}`);
            }
            const occurrences = await extractSymbols(this.extensionPath, code);
            if (!Array.isArray(occurrences)) throw new Error("Pythonの構文を確認してください。");
            return generateSymbolDictionaryAnnotations(code, occurrences, reusable, force, {
                isCurrent: () => [...guards].some(current => current()),
                onProgress: options.fullDocument && options.uri ? annotations => {
                    // AI_NOTE: 完了batchだけ永続化する。range印で未完了をfull cacheと誤認させない。
                    this.cache.set(options.uri!, code, identity, annotations.map(item => ({ ...item, scope: "range" as const })));
                    if ([...guards].some(current => current()) && symbolDictionaryCacheIdentity() === identity) {
                        // AI_NOTE: 他scopeの完了を待たず、同じスナップショットを表示中のeditorへ完了分だけ反映する。
                        for (const editor of vscode.window.visibleTextEditors) {
                            if (editor.document.uri.toString() === options.uri && editor.document.getText() === code) {
                                this.applyWithStatus(editor, annotations);
                            }
                        }
                        this._annotationsEmitter.fire(vscode.Uri.parse(options.uri!));
                    }
                } : undefined,
            });
        })();
        this.dictionaryJobs.set(key, { promise, guards });
        try { return await promise; }
        finally { if (this.dictionaryJobs.get(key)?.promise === promise) this.dictionaryJobs.delete(key); }
    }

    private readonly dictionaryJobs = new Map<string, {
        promise: Promise<SemanticAnnotation[]>;
        guards: Set<() => boolean>;
    }>();

    // AI_NOTE: 名称辞書は symbol だけを保持し、唯一の表示設定がOFFならHover対象を空にする。
    private applyWithStatus(editor: vscode.TextEditor, annotations: SemanticAnnotation[]): void {
        const uri = editor.document.uri.toString();
        annotations = annotations.filter((annotation) => annotation.kind === "symbol");
        // AI_NOTE: lastFull は「LLM注釈のみ」を保つ(chatLinksは混ぜない)。混ぜると状態トグル時に再merge→二重付与になるため。
        // chatLinks は描画のたびに store から取り直して合流する(reanchorで座標も毎回取り直すので編集にも追従)。
        this.lastFull.set(uri, annotations);
        const merged = this.mergeChatLinks(editor, annotations).filter((annotation) => annotation.kind === "symbol");
        const visible = vscode.workspace.getConfiguration("aiCodeGuide").get<boolean>("showAnnotations", true)
            ? merged
            : [];
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

    // AI_NOTE: Codex側で名称カードを一時的に隠す状態だけを保存する。VS Codeには状態UIを描かない。
    setAnnotationStatus(uri: string, id: string, status: "hidden" | null): void {
        this.statusStore.set(uri, id, status);
        const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === uri);
        const full = this.lastFull.get(uri);
        if (editor && full) this.applyWithStatus(editor, full);
    }

    // AI_NOTE: 表示設定の変更後に、表示中エディタを再生成せず再描画する。
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

        if (position.character >= document.lineAt(position.line).text.length) return undefined;
        const target = applied.find(a => this.containsPosition(a, position));
        if (!target) return undefined;

        const { annotation: ann, absStartLine, absEndLine, absStartCol, absEndCol } = target;

        const md = this.buildHoverMarkdown(document, ann, absStartLine, absEndLine);
        const hoverRange = new vscode.Range(
            absStartLine, absStartCol ?? 0,
            absEndLine, absEndCol ?? document.lineAt(absEndLine).text.length,
        );
        return new vscode.Hover(md, hoverRange);
    }

    // AI_NOTE: コード上の対象自体と重複する名称・種類・コード引用は表示せず、質問リンクと説明だけを出す。
    // 質問先へ渡す文脈にはコードと名称を残すため、回答品質は落とさない。
    private buildHoverMarkdown(
        document: vscode.TextDocument,
        ann: SemanticAnnotation,
        absStartLine: number,
        absEndLine: number,
    ): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true; // AI_NOTE: command: リンクを有効にするため必須
        const codeSnippet = this.getCodeSnippet(document, absStartLine, absEndLine);
        const args = encodeURIComponent(JSON.stringify({ codeSnippet, explanation: this.quoteText(ann) }));
        md.appendMarkdown(`[質問する](command:aiCodeGuide.openAnnotationChat?${args})\n\n${ann.explanation}`);
        return md;
    }

    // AI_NOTE: チャット引用に渡す説明文。単一クリック/連結クリック/ホバーの💬 で必ずこれを通し、入口で文がブレないようにする。
    // 見出し(label)＋詳細(explanation)を両方含める（ホバー表示と同じ情報量）。
    private quoteText(ann: SemanticAnnotation): string {
        return `${ann.label}\n${ann.explanation}`;
    }

    // AI_NOTE: 自動トリガー用。ファイル全体を解析対象にする
    // AI_NOTE: ファイル全体を解析する。force=true（再生成ボタン）のときだけキャッシュを無視してLLMを再呼び出しする。
    // 既存の range 注釈は full 再生成でも資産として残し、新 full と重なる範囲だけ dedup で吸収する。
    async annotateFile(editor: vscode.TextEditor, force = false, options: { isCurrent?: () => boolean } = {}): Promise<AnnotateResult> {
        const doc = editor.document;
        const code = doc.getText();
        const uri = doc.uri.toString();
        const generationIdentity = symbolDictionaryCacheIdentity();
        const isCurrent = () => doc.getText() === code && symbolDictionaryCacheIdentity() === generationIdentity
            && (!options.isCurrent || options.isCurrent());
        if (!isCurrent()) return { status: "empty", count: 0 };

        const cached = this.cache.get(uri, code, generationIdentity) ?? [];
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
                    const reusable = force ? [] : this.cache.getLatest(uri, generationIdentity);
                    annotations = await this.generateDictionary(code, reusable, force, { uri, isCurrent, fullDocument: true });
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
                this.cache.set(uri, code, generationIdentity, merged);
                if (isCurrent()) this.applyGenerated(editor, merged);
                return { status: "generated", count: merged.length };
            }
        );
    }

    // AI_NOTE: ① 起動/ファイル切替時の無料復元。キャッシュに full があればLLMを呼ばず表示するだけ。
    // annotateFile と違い「無ければ生成せず黙って return」する点が肝（自動生成=有料 と キャッシュ復元=無料 を分離）。
    restoreFromCache(editor: vscode.TextEditor): boolean {
        const doc = editor.document;
        const uri = doc.uri.toString();
        const generationIdentity = symbolDictionaryCacheIdentity();
        const cached = this.cache.get(uri, doc.getText(), generationIdentity) ?? [];
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

    // AI_NOTE: 編集中はLLMを呼ばない。現在のscope/参照証拠が一致する辞書本文だけ現在AST座標へ移す。
    // 部分復元をfull cacheへ書くと不足生成を阻むため、表示専用の復元として扱う。
    async restoreCurrentDocument(document: vscode.TextDocument): Promise<void> {
        const code = document.getText();
        const uri = document.uri.toString();
        const identity = symbolDictionaryCacheIdentity();
        const cached = this.cache.get(uri, code, identity)
            ?? this.cache.getLatest(uri, identity);
        const base = cached.length ? cached : this.baseFull.get(uri) ?? [];
        const graph = await extractGraph(this.extensionPath, code);
        const occurrences = graph.error ? [] : await extractSymbols(this.extensionPath, code);
        if (document.getText() !== code || symbolDictionaryCacheIdentity() !== identity) return;
        const reuse = planSymbolDescriptionReuse(code, Array.isArray(occurrences) ? occurrences : [], base);
        const restored = (Array.isArray(occurrences) ? occurrences : []).flatMap(item => {
            const explanation = reuse.reusedDescriptions.get(item.key);
            if (!explanation) return [];
            const annotation = buildSymbolAnnotation(code, item, explanation);
            return annotation ? [{ ...annotation, symbolFingerprint: reuse.fingerprints.get(item.key), scope: "full" as const }] : [];
        });
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === uri && editor.document.getText() === code) this.applyWithStatus(editor, restored);
        }
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
        const generationIdentity = symbolDictionaryCacheIdentity();

        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "AI Code Guide: 解説を生成中..." },
            async (): Promise<AnnotateResult> => {
                // AI_NOTE: API起因のエラーは握り潰さず原因を表示する(生成0件と区別)。
                let annotations: SemanticAnnotation[];
                try {
                    const current = this.cache.get(uri, fullCode, generationIdentity) ?? [];
                    const reusable = current.length > 0 ? current : this.cache.getLatest(uri, generationIdentity);
                    annotations = await this.generateDictionary(rangeCode, reusable, false, {
                        uri, isCurrent: () => editor.document.getText() === fullCode,
                    });
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
                const existing = this.cache.get(uri, fullCode, generationIdentity) ?? [];
                const merged = dedupAnnotations([...fresh, ...existing]);
                this.cache.set(uri, fullCode, generationIdentity, merged);
                if (editor.document.getText() === fullCode) this.applyGenerated(editor, merged);
                // AI_NOTE: count はファイル全体の表示総数(union)。バッジ件数と一致させる。
                return { status: "generated", count: merged.length };
            }
        );
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
        options: { isCurrent?: () => boolean } = {},
    ): Promise<AnnotateResult> {
        const code = document.getText();
        const uri = document.uri.toString();
        const generationIdentity = symbolDictionaryCacheIdentity();
        const isCurrent = () => document.getText() === code && symbolDictionaryCacheIdentity() === generationIdentity
            && (!options.isCurrent || options.isCurrent());
        if (!isCurrent()) return { status: "empty", count: 0 };
        const cached = this.cache.get(uri, code, generationIdentity) ?? [];
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
        const reusable = force ? [] : (cached.length > 0 ? cached : this.cache.getLatest(uri, generationIdentity));
        const generated = await this.generateDictionary(source, reusable, force, { uri, isCurrent, fullDocument: startLine === undefined });
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
        this.cache.set(uri, code, generationIdentity, merged);
        if (isCurrent()) {
            this.lastGeneratedAt.set(uri, new Date());
            this._annotationsEmitter.fire(document.uri);
        }
        return { status: "generated", count: merged.length };
    }

    // AI_NOTE: MCPの保存済み一覧は、表示ON/OFFに左右されない永続キャッシュを正とする。
    // activeAnnotations は「今Hover可能」な対象だけなので、背景生成した結果を0件と誤報しないため入口を分ける。
    getSavedAnnotations(editor: vscode.TextEditor): { items: SemanticAnnotation[]; generatedAt: Date | null } {
        return this.getSavedAnnotationsForDocument(editor.document);
    }

    getSavedAnnotationsForDocument(document: vscode.TextDocument): { items: SemanticAnnotation[]; generatedAt: Date | null } {
        const uri = document.uri.toString();
        return {
            items: (this.cache.get(uri, document.getText(), symbolDictionaryCacheIdentity()) ?? [])
                .filter((item) => item.kind === "symbol"),
            generatedAt: this.lastGeneratedAt.get(uri) ?? null,
        };
    }

    // AI_NOTE: Codexの会話からの部分修正は、ファイル全体を再生成せず現在内容ハッシュの保存結果だけを置換する。
    // 生成失敗時のロールバックにも同じ入口を使い、ディスク・VS Code表示・再アンカー原本を必ず揃える。
    replaceSavedAnnotations(editor: vscode.TextEditor, annotations: SemanticAnnotation[]): void {
        const uri = editor.document.uri.toString();
        this.cache.set(uri, editor.document.getText(), symbolDictionaryCacheIdentity(), annotations);
        this.applyGenerated(editor, annotations);
    }

    replaceSavedAnnotationsForDocument(document: vscode.TextDocument, annotations: SemanticAnnotation[]): void {
        this.cache.set(document.uri.toString(), document.getText(), symbolDictionaryCacheIdentity(), annotations);
        this._annotationsEmitter.fire(document.uri);
    }

    updateSymbolExplanationForDocument(document: vscode.TextDocument, symbolKey: string, explanation: string): number {
        const uri = document.uri.toString();
        const code = document.getText();
        const generationIdentity = symbolDictionaryCacheIdentity();
        const cached = this.cache.get(uri, code, generationIdentity) ?? [];
        let updated = 0;
        const next = cached.map((annotation) => {
            if (annotation.kind !== "symbol" || annotation.symbolKey !== symbolKey) return annotation;
            updated++;
            return { ...annotation, explanation };
        });
        if (updated === 0) return 0;
        this.cache.set(uri, code, generationIdentity, next);
        const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === uri);
        if (editor) this.applyGenerated(editor, next);
        else this._annotationsEmitter.fire(document.uri);
        return updated;
    }

    isAnnotationHidden(uri: string, id: string): boolean {
        return this.statusStore.get(uri, id) === "hidden";
    }

    clearEditor(editor: vscode.TextEditor): void {
        this.activeAnnotations.delete(editor.document.uri.toString());
        this.lastFull.delete(editor.document.uri.toString());
        this.baseFull.delete(editor.document.uri.toString()); // AI_NOTE: 明示クリアは原本も捨てる(復活させない)
        this.lastGeneratedAt.delete(editor.document.uri.toString());
        // AI_NOTE: チャットペインの一覧も空に更新するため fire
        this._annotationsEmitter.fire(editor.document.uri);
    }

    clearAll(): void {
        this.activeAnnotations.clear();
        this.lastFull.clear();
        this.baseFull.clear(); // AI_NOTE: 明示クリアは原本も捨てる(復活させない)
        this.lastGeneratedAt.clear();
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
        // AI_NOTE: 文字アンカー一致だけでは変更済み関数の古い意味を残すため、AST照合まで一旦表示を外す。
        void this.restoreCurrentDocument(editor.document).catch(error => console.warn("名称解説の位置復元に失敗:", error));
        const reanchored: SemanticAnnotation[] = [];
        if (reanchored.length === 0 && !hasChatLinks) {
            // AI_NOTE: 表示・状態だけ消し、原本(baseFull)は残す。全アンカーが一時的に外れただけならテキスト復帰で戻せるようにする。
            this.activeAnnotations.delete(uri);
            this.lastFull.delete(uri);
            this._annotationsEmitter.fire(editor.document.uri);
            return true;
        }
        this.applyWithStatus(editor, reanchored);
        return true;
    }

    dispose(): void {
        this._annotationsEmitter.dispose();
    }

    // AI_NOTE: symbol以外を入口で捨て、コードの見た目を変えずHover判定用の座標だけを保持する。
    // トレースとは表示面が競合しないため、実行中でも同じactiveAnnotationsを維持する。
    private applyAnnotations(editor: vscode.TextEditor, annotations: SemanticAnnotation[], startLine: number): void {
        const uri = editor.document.uri.toString();
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
        this.lastGeneratedAt.set(uri, new Date());
        this._annotationsEmitter.fire(editor.document.uri);
    }
    private containsPosition(a: AppliedAnnotation, pos: vscode.Position): boolean {
        return pos.line === a.absStartLine
            && a.absStartCol !== null
            && a.absEndCol !== null
            && pos.character >= a.absStartCol
            && pos.character <= a.absEndCol;
    }

    private getCodeSnippet(doc: vscode.TextDocument, startLine: number, endLine: number): string {
        const clampedEnd = Math.min(endLine, doc.lineCount - 1);
        return doc.getText(new vscode.Range(startLine, 0, clampedEnd, doc.lineAt(clampedEnd).text.length));
    }
}
