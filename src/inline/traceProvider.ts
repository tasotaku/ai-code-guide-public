import * as vscode from "vscode";
import { TraceAssertion, TraceResult, TraceLoop, TraceStep, TraceValue } from "./traceRunner";

// AI_NOTE: 通常行(after装飾)の色。ダークはVSCodeの変数色と同系の明るい水色(視認性の指摘で
// rgba(120,180,255,0.85)から変更)、ライトは濃紺。テーマ別は renderOptions.light/dark で出し分ける。
const NORMAL_DARK = "#9CDCFE";
const NORMAL_LIGHT = "#0451A5";
// AI_NOTE: ループヘッダ行のアクセント色。周回セレクタと値を同色でまとめて目立たせる。
const ACCENT_DARK = "rgba(255,200,80,1)";
const ACCENT_LIGHT = "#B25D00";
// AI_NOTE: 1行のafter表示テキストの上限(全角換算)。超過分は「…」で切り、詳細はホバーへ逃がす。
const MAX_LINE_WIDTH = 80;
// AI_NOTE: ループ全周回テーブルの列数上限(変数が多いループで表が横に広がりすぎるのを防ぐ)。
const MAX_TABLE_COLUMNS = 6;
// AI_NOTE: ループ全周回テーブルの行数上限。超えたら省略メッセージを足す。
const MAX_TABLE_ROWS = 20;

// AI_NOTE: 関数1つ分のトレース表示状態。selected は loopId → 選択中の周回(1-based)。
// loopId は関数ごとに0から振られるため、外部からの指定は必ず funcName とセットで受ける。
interface TraceState {
    trace: TraceResult;
    funcName: string;
    docVersion: number;
    selected: Map<number, number>;
}

// AI_NOTE: uri単位の保持単位。一括トレースで複数関数を同時表示するため配列で持つ(1関数でも配列1件)。
type TraceStates = TraceState[];

export type ConversationTrace = {
    funcName: string;
    runId?: string;
    executedAt?: string;
    arguments?: Record<string, unknown>;
    returnValue?: TraceValue | null;
    error?: string | null;
    stage?: "setup" | "run";
    calls?: TraceResult["calls"];
    finalLocals?: Record<string, TraceValue>;
    controlPoints?: TraceResult["control_points"];
    executedLines?: TraceResult["executed_lines"];
    pathEvents?: TraceResult["path_events"];
    assertions?: TraceResult["assertions"];
    startLine: number;
    endLine: number;
    loop?: {
        headerLine: number;
        total: number;
        actualTotal: number;
    };
    iterations: Array<{
        number: number;
        values: Array<{ line: number; text: string }>;
    }>;
};

// AI_NOTE: ループの実周回数クランプ結果。iter=現在の選択(範囲内に補正済み)/max=このループの実周回数。
interface ClampedIter {
    iter: number;
    max: number;
}

// AI_NOTE: 全角=2/半角=1で表示幅を数える。既存の blockExplanationProvider の displayWidth と同じ考え方。
function displayWidth(text: string): number {
    let width = 0;
    for (const char of text) width += char.charCodeAt(0) > 0xff ? 2 : 1;
    return width;
}

// AI_NOTE: 全角換算で上限を超えたら末尾を「…」で切る。詳細な全文はホバー側(full)で見る前提。
function truncateByWidth(text: string, maxWidth: number): string {
    if (displayWidth(text) <= maxWidth) return text;
    let width = 0;
    let out = "";
    const budget = maxWidth - displayWidth("…");
    for (const char of text) {
        const next = width + displayWidth(char);
        if (next > budget) break;
        out += char;
        width = next;
    }
    return `${out}…`;
}

// AI_NOTE: 実行トレースの表示層。行末after装飾で各行の変数値を出し、ループはヘッダ行の周回セレクタで
// 選んだ1周分の値を全行へ反映する。編集追従はせず(handleDocEdit で即クリア)、コード側の装飾は一切変更しない。
export class TraceProvider implements vscode.HoverProvider {
    // AI_NOTE: 行ごとの値表示は色以外の見た目を共通化するため、型は1つでrenderOptionsをinstance単位で決める。
    private readonly decoType = vscode.window.createTextEditorDecorationType({});
    private readonly states: Map<string, TraceStates> = new Map();
    // AI_NOTE: 表示状態(トレースの開始/解除/周回変更)の通知。ステータスバーとサイドバーの周回ボタンが購読する。
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTrace = this.changed.event;

    dispose(): void {
        this.decoType.dispose();
        this.changed.dispose();
        this.states.clear();
    }

    // AI_NOTE: 1関数だけを表示する入口(カーソル位置トレース)。既存の表示は置き換える。
    showTrace(editor: vscode.TextEditor, trace: TraceResult, funcName: string): void {
        this.showTraces(editor, [{ trace, funcName }]);
    }

    // AI_NOTE: 一括トレースの表示入口。関数ごとに周回選択を1周目で初期化し、まとめて1回描画する。
    // 表示順は行順に揃える(サイドバーの周回ボタンの並びと合わせるため)。
    showTraces(editor: vscode.TextEditor, traces: { trace: TraceResult; funcName: string }[]): void {
        const states = this.storeTraces(editor.document, traces);
        this.render(editor, states);
        this.changed.fire();
        void vscode.commands.executeCommand("setContext", "aiCodeGuide.traceActive", true);
    }

    // Codex can persist trace state for its browser result without touching the
    // visible editor. An explicit VS Code action can render the same state later.
    storeTraces(document: vscode.TextDocument, traces: { trace: TraceResult; funcName: string }[]): TraceStates {
        const states: TraceStates = traces
            .map(({ trace, funcName }) => ({
                trace,
                funcName,
                docVersion: document.version,
                selected: new Map<number, number>(trace.loops.map((l) => [l.id, 1])),
            }))
            .sort((a, b) => a.trace.func_line_start - b.trace.func_line_start);
        this.states.set(document.uri.toString(), states);
        return states;
    }

    // AI_NOTE: 装飾を消して状態も破棄する(エディタが手元にある通常の終了経路)。
    clear(editor: vscode.TextEditor): void {
        editor.setDecorations(this.decoType, []);
        this.states.delete(editor.document.uri.toString());
        this.changed.fire();
        void vscode.commands.executeCommand("setContext", "aiCodeGuide.traceActive", false);
    }

    // AI_NOTE: エディタが非表示(タブを閉じた等)でも状態だけは破棄する経路。見えていれば装飾も消す。
    clearByUri(uri: string): void {
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
        if (editor) editor.setDecorations(this.decoType, []);
        this.states.delete(uri);
        this.changed.fire();
        void vscode.commands.executeCommand("setContext", "aiCodeGuide.traceActive", false);
    }

    isActive(uri: string): boolean {
        return this.states.has(uri);
    }

    // AI_NOTE: サイドバーのトレースタブの状態表示用。表示中の関数名一覧とループ総数だけ返す(内部状態は渡さない)。
    getStatus(uri: string): { funcNames: string[]; loopCount: number } | null {
        const states = this.states.get(uri);
        if (!states || states.length === 0) return null;
        return {
            funcNames: states.map((s) => s.funcName),
            loopCount: states.reduce((n, s) => n + s.trace.loops.length, 0),
        };
    }

    // AI_NOTE: 会話内では1関数の数行だけをコードと並べるため、VS Code装飾そのものではなく
    // 行番号と短い値を返す。最外ループの先頭20周はUI内で切替でき、それ以上はVS Codeへ委ねる。
    getConversationTraces(uri: string): ConversationTrace[] {
        return (this.states.get(uri) ?? []).map((state) => {
            const loop = state.trace.loops.find((candidate) => candidate.parent === null) ?? state.trace.loops[0];
            const base = this.clampSelections(state);
            const actualTotal = loop ? base.get(loop.id)?.max ?? 1 : 1;
            const total = Math.min(actualTotal, MAX_TABLE_ROWS);
            const iterations = Array.from({ length: total }, (_, index) => {
                const selected = new Map(state.selected);
                if (loop) selected.set(loop.id, index + 1);
                const snapshot: TraceState = { ...state, selected };
                const { lineToStep } = this.compute(snapshot);
                const values = Array.from(
                    { length: state.trace.func_line_end - state.trace.func_line_start + 1 },
                    (_, offset) => state.trace.func_line_start + offset,
                ).flatMap((line) => {
                    const text = this.lineSegments(snapshot, lineToStep, line).join(", ");
                    return text ? [{ line, text }] : [];
                });
                return { number: index + 1, values };
            });
            return {
                funcName: state.funcName,
                ...(state.trace.run_id ? { runId: state.trace.run_id } : {}),
                ...(state.trace.executed_at ? { executedAt: state.trace.executed_at } : {}),
                ...(state.trace.input_arguments ? { arguments: state.trace.input_arguments } : {}),
                returnValue: state.trace.return_value,
                error: state.trace.error,
                ...(state.trace.stage ? { stage: state.trace.stage } : {}),
                ...(state.trace.calls ? { calls: state.trace.calls } : {}),
                ...(state.trace.final_locals ? { finalLocals: state.trace.final_locals } : {}),
                ...(state.trace.control_points ? { controlPoints: state.trace.control_points } : {}),
                ...(state.trace.executed_lines ? { executedLines: state.trace.executed_lines } : {}),
                ...(state.trace.path_events ? { pathEvents: state.trace.path_events } : {}),
                ...(state.trace.assertions ? { assertions: state.trace.assertions } : {}),
                startLine: state.trace.func_line_start,
                endLine: state.trace.func_line_end,
                ...(loop ? { loop: { headerLine: loop.header_line, total, actualTotal } } : {}),
                iterations,
            };
        });
    }

    // AI_NOTE: 編集検知時の入口。トレースは実行時点のコードに紐づくため再アンカーせず、即クリアする。
    handleDocEdit(uri: string): void {
        this.clearByUri(uri);
    }

    // AI_NOTE: カーソル位置の最内ループを±1周する。カーソルがトレース中の関数の外なら先頭の関数・先頭のループを対象にする。
    // 実処理は stepIterationFor に委ねる(ホバーリンクからの直接指定と同じ経路を通す)。
    stepIteration(editor: vscode.TextEditor, delta: 1 | -1): void {
        const uri = editor.document.uri.toString();
        const target = this.getLoopAtCursor(editor);
        if (!target) return;
        this.stepIterationFor(uri, target.funcName, target.loopId, delta);
    }

    // AI_NOTE: ホバーの「前の周回/次の周回」リンクから呼ばれる経路。指定ループの選択周回を±1し、
    // 現在の親選択下での実周回数(1〜max)にクランプする。外側を動かすので内側ループの選択は1へリセットする。
    stepIterationFor(uri: string, funcName: string, loopId: number, delta: 1 | -1): void {
        const state = this.findState(uri, funcName);
        if (!state) return;
        const clamped = this.clampSelections(state);
        const max = clamped.get(loopId)?.max ?? 1;
        const cur = clamped.get(loopId)?.iter ?? state.selected.get(loopId) ?? 1;
        state.selected.set(loopId, Math.min(Math.max(cur + delta, 1), max));
        this.applySelection(uri, state, loopId);
    }

    // AI_NOTE: ホバーの周回リンクから直接周回番号を指定する経路。範囲外の値はrender時のクランプ計算が補正する。
    setIteration(uri: string, funcName: string, loopId: number, iter: number): void {
        const state = this.findState(uri, funcName);
        if (!state) return;
        state.selected.set(loopId, iter);
        this.applySelection(uri, state, loopId);
    }

    // AI_NOTE: 周回を動かした後の共通後処理(内側リセット→再描画→通知)。表示は uri 内の全関数まとめて描き直す。
    private applySelection(uri: string, state: TraceState, loopId: number): void {
        this.resetDescendants(state, loopId);
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
        const states = this.states.get(uri);
        if (editor && states) this.render(editor, states);
        this.changed.fire();
        void vscode.commands.executeCommand("setContext", "aiCodeGuide.traceActive", true);
    }

    private findState(uri: string, funcName: string): TraceState | undefined {
        return this.states.get(uri)?.find((s) => s.funcName === funcName);
    }

    // AI_NOTE: 行を含む関数のトレースを返す(一括トレースでは同じファイルに複数ある)。
    private stateForLine(uri: string, line1: number): TraceState | undefined {
        return this.states
            .get(uri)
            ?.find((s) => line1 >= s.trace.func_line_start && line1 <= s.trace.func_line_end);
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const uri = document.uri.toString();
        const line1 = position.line + 1;
        const state = this.stateForLine(uri, line1);
        if (!state) return undefined;
        // AI_NOTE: after装飾をホバーした時もVS Codeは行末位置でHoverProviderを呼ぶ。装飾自身のhoverMessageと
        // 二重表示になるため行末だけこちらを譲り、コード文字上では従来どおり全文ホバーを返す。
        if (position.character >= document.lineAt(position.line).text.length) return undefined;

        const { clamped, lineToStep } = this.compute(state);
        const loop = state.trace.loops.find((l) => l.header_line === line1);
        const md = this.buildLineHoverMarkdown(uri, state, lineToStep, line1, loop, clamped);
        if (!md) return undefined;
        return new vscode.Hover(md, document.lineAt(position.line).range);
    }

    // AI_NOTE: 祖先チェーン(最外→直親の順)。parent を辿って組み立てる。parentKey/深さ判定/テーブルの
    // 親選択フィルタなど、ループ絡みの計算全部がこれを土台にする。
    private ancestorChain(loop: TraceLoop, loopsById: Map<number, TraceLoop>): TraceLoop[] {
        const chain: TraceLoop[] = [];
        let cur = loop.parent;
        while (cur !== null) {
            const parent = loopsById.get(cur);
            if (!parent) break;
            chain.unshift(parent);
            cur = parent.parent;
        }
        return chain;
    }

    // AI_NOTE: あるループを選択したら、その内側にある全ループの選択を1周目にリセットする
    // (外側を動かした時点で内側の「選んでいた周回」は意味を失うため)。
    private resetDescendants(state: TraceState, loopId: number): void {
        const loopsById = new Map(state.trace.loops.map((l) => [l.id, l]));
        for (const loop of state.trace.loops) {
            if (this.ancestorChain(loop, loopsById).some((a) => a.id === loopId)) {
                state.selected.set(loop.id, 1);
            }
        }
    }

    // AI_NOTE: 各ループの選択周回を実周回数にクランプする。親→子の順で処理しないと子の parentKey が組めないため、
    // 祖先チェーンが浅い順にソートしてから処理する。
    private clampSelections(state: TraceState): Map<number, ClampedIter> {
        const loopsById = new Map(state.trace.loops.map((l) => [l.id, l]));
        const ordered = [...state.trace.loops].sort(
            (a, b) => this.ancestorChain(a, loopsById).length - this.ancestorChain(b, loopsById).length,
        );
        const result = new Map<number, ClampedIter>();
        for (const loop of ordered) {
            const chain = this.ancestorChain(loop, loopsById);
            const parentKey = chain.map((p) => `${p.id}:${result.get(p.id)?.iter ?? 1}`).join(",");
            const max = Math.max(1, state.trace.iter_counts[String(loop.id)]?.[parentKey] ?? 1);
            const want = state.selected.get(loop.id) ?? 1;
            result.set(loop.id, { iter: Math.min(Math.max(want, 1), max), max });
        }
        return result;
    }

    // AI_NOTE: 描画・ホバー共通の下ごしらえ。行→表示するstepの決定は3層:
    // ①ループ外の行(iter_pathが絡まない行)は常に自分の最新step(1回しか通らない行が大半。def行の入力例・returnもここ)
    // ②ループ内の行は「選択周回に完全一致するstep」を最優先
    // ③一致stepが無い行(その周回では値が変わらなかった=reprが前周回と同じで記録されない)は、
    //   選択周回の末尾(endIdx)までの持ち越し値で埋める(値としては正しい。例: 2周目のkeyが1周目と同じ(1,5)のケース)
    // 注意: iter_pathが空のstepを「一致」に数えるとendIdxが常に末尾になり周回選択が死ぬ。空pathは①専用。
    private compute(state: TraceState): { clamped: Map<number, ClampedIter>; lineToStep: Map<number, TraceStep> } {
        const clamped = this.clampSelections(state);
        const inLoop = (line: number) =>
            state.trace.loops.some((l) => line >= l.header_line && line <= l.body_end);

        let endIdx = -1;
        const matchByLine = new Map<number, TraceStep>();
        state.trace.steps.forEach((step, i) => {
            if (step.iter_path.length === 0) return;
            if (step.iter_path.every(([lid, it]) => clamped.get(lid)?.iter === it)) {
                matchByLine.set(step.line, step);
                endIdx = i;
            }
        });

        const lineToStep = new Map<number, TraceStep>();
        state.trace.steps.forEach((step, i) => {
            if (!inLoop(step.line)) lineToStep.set(step.line, step);
            else if (i <= endIdx) lineToStep.set(step.line, step);
        });
        for (const [line, step] of matchByLine) lineToStep.set(line, step);
        return { clamped, lineToStep };
    }

    // AI_NOTE: カーソル行を含む最も内側のループを探す。範囲はヘッダ行〜本体末尾。複数候補があれば
    // 祖先チェーンが最も深いもの(=最内)を選ぶ。
    private findLoopForLine(trace: TraceResult, line1: number): TraceLoop | undefined {
        const loopsById = new Map(trace.loops.map((l) => [l.id, l]));
        const candidates = trace.loops.filter((l) => line1 >= l.header_line && line1 <= l.body_end);
        if (candidates.length === 0) return undefined;
        candidates.sort(
            (a, b) => this.ancestorChain(b, loopsById).length - this.ancestorChain(a, loopsById).length,
        );
        return candidates[0];
    }

    private valuesStr(changed: Record<string, TraceValue>): string {
        return Object.entries(changed).map(([name, v]) => `${name}=${v.short}`).join(", ");
    }

    // AI_NOTE: 関数範囲の各行にafter装飾を敷く。ループヘッダ行=周回セレクタ+値(アクセント色)、
    // def行=入力例、func_line_end=戻り値(値と同居する時は戻り値を先に)、それ以外=通常の変更値。
    // 表示列はブロック解説のサイドノートと同様に固定列へ揃える(行末直後だと開始位置がガタガタで読みにくい):
    // 関数内の最長行+2 を目標列とし、各行は margin の ch 単位で不足分を埋める(点字空白は装飾内で点に見えるためCSSで寄せる)。
    private render(editor: vscode.TextEditor, states: TraceStates): void {
        const decos: vscode.DecorationOptions[] = [];
        for (const state of states) decos.push(...this.buildDecorations(editor, state));
        editor.setDecorations(this.decoType, decos);
    }

    // AI_NOTE: 関数1つ分の装飾。表示列は関数ごとに算出する(離れた関数どうしを同じ列に揃えると、
    // 長い行を持つ関数に引きずられて他の関数の値が遠くなるため)。
    private buildDecorations(editor: vscode.TextEditor, state: TraceState): vscode.DecorationOptions[] {
        const uri = editor.document.uri.toString();
        const { clamped, lineToStep } = this.compute(state);
        const headerByLine = new Map(state.trace.loops.map((l) => [l.header_line, l]));
        const decos: vscode.DecorationOptions[] = [];
        const noteCol = this.noteColumn(editor.document, state);

        for (let line1 = state.trace.func_line_start; line1 <= state.trace.func_line_end; line1++) {
            const line0 = line1 - 1;
            if (line0 < 0 || line0 >= editor.document.lineCount) continue;
            const loop = headerByLine.get(line1);
            const values = this.lineSegments(state, lineToStep, line1).join(", ");
            if (!loop && values.length === 0) continue;
            // AI_NOTE: ループヘッダ行は周回セレクタを前置し、値と同じアクセント色でまとめる。
            const c = loop ? clamped.get(loop.id) ?? { iter: 1, max: 1 } : null;
            const text = c ? `◀ ${c.iter}周目/全${c.max}周 ▶ ${values}`.trimEnd() : values;

            const lineText = editor.document.lineAt(line0).text;
            const pad = Math.max(2, noteCol - displayWidth(lineText));
            decos.push({
                range: new vscode.Range(line0, lineText.length, line0, lineText.length),
                // AI_NOTE: after装飾は文書外の仮想文字だが、DecorationOptions.hoverMessage なら表示文字そのものを
                // ホバー対象にできる。元コード行のHoverProviderと同じ本文を使い、どちらからでも全文へ届かせる。
                hoverMessage: this.buildLineHoverMarkdown(uri, state, lineToStep, line1, loop, clamped),
                renderOptions: {
                    after: {
                        contentText: truncateByWidth(text, MAX_LINE_WIDTH),
                        margin: `0 0 0 ${pad}ch`,
                        fontStyle: "normal",
                    },
                    dark: { after: { color: loop ? ACCENT_DARK : NORMAL_DARK } },
                    light: { after: { color: loop ? ACCENT_LIGHT : NORMAL_LIGHT } },
                },
            });
        }
        return decos;
    }

    // AI_NOTE: 行末のトレース装飾と元コード行の両方で共有するホバー本文。画面上は short と80幅制限で
    // 省略しても、ここでは full を使う。return行だけの時も全文を出し、ループ行には周回操作を続けて載せる。
    private buildLineHoverMarkdown(
        uri: string,
        state: TraceState,
        lineToStep: Map<number, TraceStep>,
        line1: number,
        loop: TraceLoop | undefined,
        clamped: Map<number, ClampedIter>,
    ): vscode.MarkdownString | undefined {
        const lines: string[] = [];
        if (line1 === state.trace.func_line_end && state.trace.return_value) {
            lines.push(`戻り値 = ${state.trace.return_value.full}`);
        }
        const step = lineToStep.get(line1);
        if (step) {
            for (const [name, value] of Object.entries(step.changed)) {
                lines.push(`${name} = ${value.full}`);
            }
        }
        for (const assertion of this.assertionsForLine(state, line1)) {
            lines.push(this.assertionText(assertion, true));
        }
        if (lines.length === 0 && !loop) return undefined;

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        if (lines.length > 0) {
            md.appendCodeblock(lines.join("\n"), "text");
        }
        if (loop) {
            if (lines.length > 0) md.appendMarkdown("\n\n---\n\n");
            md.appendMarkdown(this.buildLoopHoverMarkdown(uri, state, loop, clamped).value);
        }
        return md;
    }

    // AI_NOTE: 値の表示開始列(関数内の最長行+2)。装飾のmargin計算とインレイヒントの字下げで同じ値を使う。
    private noteColumn(document: vscode.TextDocument, state: TraceState): number {
        let col = 0;
        for (let line1 = state.trace.func_line_start; line1 <= state.trace.func_line_end; line1++) {
            if (line1 - 1 >= document.lineCount) break;
            col = Math.max(col, displayWidth(document.lineAt(line1 - 1).text));
        }
        return col + 2;
    }

    // AI_NOTE: 1行に出す値の断片。def行=入力例/最終行=戻り値(値と同居する時は戻り値が先)/それ以外=変更値。
    private lineSegments(state: TraceState, lineToStep: Map<number, TraceStep>, line1: number): string[] {
        const segments: string[] = [];
        if (line1 === state.trace.func_line_end && state.trace.return_value) {
            segments.push(`▶ 戻り値: ${state.trace.return_value.short}`);
        }
        const step = lineToStep.get(line1);
        if (step && Object.keys(step.changed).length > 0) {
            const vs = this.valuesStr(step.changed);
            segments.push(line1 === state.trace.func_line_start ? `◀ 入力例: ${vs}` : vs);
        }
        segments.push(...this.assertionsForLine(state, line1).map((assertion) => this.assertionText(assertion, false)));
        return segments;
    }

    private assertionsForLine(state: TraceState, line1: number): TraceAssertion[] {
        return (state.trace.assertions ?? []).filter((assertion) =>
            assertion.line === line1
            && assertion.iter_path.every(([loopId, iteration]) => state.selected.get(loopId) === iteration),
        );
    }

    private assertionText(assertion: TraceAssertion, full: boolean): string {
        const value = (index: number): string | undefined => {
            const rendered = assertion.arguments?.[index];
            return rendered ? (full ? rendered.full : rendered.short) : undefined;
        };
        const details: string[] = [];
        if (/^assert(?:Not)?Equal/.test(assertion.method)) {
            if (value(0) !== undefined) details.push(`実際=${value(0)}`);
            if (value(1) !== undefined) details.push(`期待=${value(1)}`);
        } else if (/^assert(?:True|False)$/.test(assertion.method)) {
            if (value(0) !== undefined) details.push(`条件=${value(0)}`);
        } else if (/^assertRaises/.test(assertion.method)) {
            if (value(0) !== undefined) details.push(`期待例外=${value(0)}`);
            if (assertion.exception) details.push(`実際=${assertion.exception.type}`);
        } else if (/^assert(?:Not)?In$/.test(assertion.method)) {
            if (value(0) !== undefined) details.push(`対象=${value(0)}`);
            if (value(1) !== undefined) details.push(`容器=${value(1)}`);
        } else {
            (assertion.arguments ?? []).forEach((argument, index) => {
                details.push(`引数${index + 1}=${full ? argument.full : argument.short}`);
            });
        }
        if (!assertion.outcome && assertion.exception?.message) {
            details.push(`${assertion.exception.type}: ${assertion.exception.message}`);
        }
        return `${assertion.outcome ? "✓" : "✗"} ${assertion.method}: ${assertion.outcome ? "成功" : "失敗"}${details.length ? ` · ${details.join(" · ")}` : ""}`;
    }

    // AI_NOTE: ステータスバー/サイドバーの周回ボタン用。表示中の全関数のループを行順で返す。
    // 内部状態は渡さず、表示に要るものだけの配列にする(loopIdは関数ごとに独立なのでfuncNameを必ず添える)。
    getLoopSelectors(
        uri: string,
    ): { funcName: string; loopId: number; headerLine: number; iter: number; max: number; depth: number }[] {
        const states = this.states.get(uri) ?? [];
        return states
            .flatMap((state) => {
                const clamped = this.clampSelections(state);
                const loopsById = new Map(state.trace.loops.map((l) => [l.id, l]));
                return state.trace.loops.map((loop) => ({
                    funcName: state.funcName,
                    loopId: loop.id,
                    headerLine: loop.header_line,
                    iter: clamped.get(loop.id)?.iter ?? 1,
                    max: clamped.get(loop.id)?.max ?? 1,
                    depth: this.ancestorChain(loop, loopsById).length,
                }));
            })
            .sort((a, b) => a.headerLine - b.headerLine);
    }

    // AI_NOTE: ステータスバーの表示対象。カーソルのある関数の最内ループを返す。カーソルがどのトレース中の
    // 関数にも無ければ、先頭の関数の先頭ループにフォールバックする(押した時に何も起きないのを避ける)。
    getLoopAtCursor(editor: vscode.TextEditor): { funcName: string; loopId: number; iter: number; max: number } | null {
        const uri = editor.document.uri.toString();
        const line1 = editor.selection.active.line + 1;
        const inCursor = this.stateForLine(uri, line1);
        const state = inCursor?.trace.loops.length
            ? inCursor
            : this.states.get(uri)?.find((s) => s.trace.loops.length > 0);
        if (!state) return null;
        const loop = this.findLoopForLine(state.trace, line1) ?? state.trace.loops[0];
        if (!loop) return null;
        const c = this.clampSelections(state).get(loop.id);
        return { funcName: state.funcName, loopId: loop.id, iter: c?.iter ?? 1, max: c?.max ?? 1 };
    }

    // AI_NOTE: ループヘッダのホバー本文。見出し+前後周回リンク+全周回テーブルを組み立てる。
    private buildLoopHoverMarkdown(
        uri: string,
        state: TraceState,
        loop: TraceLoop,
        clamped: Map<number, ClampedIter>,
    ): vscode.MarkdownString {
        const c = clamped.get(loop.id) ?? { iter: 1, max: 1 };
        const md = new vscode.MarkdownString();
        md.isTrusted = true; // AI_NOTE: command: リンクを有効にするため必須
        md.appendMarkdown(`**${c.iter}周目/全${c.max}周**\n\n`);
        const prevArg = encodeURIComponent(JSON.stringify({ uri, funcName: state.funcName, loopId: loop.id, delta: -1 }));
        const nextArg = encodeURIComponent(JSON.stringify({ uri, funcName: state.funcName, loopId: loop.id, delta: 1 }));
        md.appendMarkdown(
            `[◀ 前の周回](command:aiCodeGuide.traceIterStep?${prevArg}) · ` +
                `[次の周回 ▶](command:aiCodeGuide.traceIterStep?${nextArg})\n\n`,
        );
        const loopsById = new Map(state.trace.loops.map((l) => [l.id, l]));
        md.appendMarkdown(this.buildLoopTable(uri, state, loop, clamped, this.ancestorChain(loop, loopsById)));
        return md;
    }

    // AI_NOTE: 現在の親選択下での全周回テーブル。列=そのループのヘッダ行+本体行のstepsに現れる変数名(出現順・最大6列)、
    // 行=周回ごとの最後の値(最大20周・超過は省略メッセージ)。周回番号セルはsetIterationへのリンクにする。
    private buildLoopTable(
        uri: string,
        state: TraceState,
        loop: TraceLoop,
        clamped: Map<number, ClampedIter>,
        ancestors: TraceLoop[],
    ): string {
        const columns: string[] = [];
        const rows = new Map<number, Map<string, string>>();

        for (const step of state.trace.steps) {
            if (step.line < loop.header_line || step.line > loop.body_end) continue;
            const ancestorOk = ancestors.every((a) => {
                const entry = step.iter_path.find(([lid]) => lid === a.id);
                return entry !== undefined && entry[1] === clamped.get(a.id)?.iter;
            });
            if (!ancestorOk) continue;
            const own = step.iter_path.find(([lid]) => lid === loop.id);
            if (!own) continue;
            const iter = own[1];

            const row = rows.get(iter) ?? new Map<string, string>();
            for (const [name, v] of Object.entries(step.changed)) {
                if (!columns.includes(name)) {
                    if (columns.length >= MAX_TABLE_COLUMNS) continue;
                    columns.push(name);
                }
                row.set(name, v.short);
            }
            rows.set(iter, row);
        }

        const max = clamped.get(loop.id)?.max ?? 1;
        const shown = Math.min(max, MAX_TABLE_ROWS);
        const header = `| 周回 | ${columns.join(" | ")} |`;
        const sep = `| --- | ${columns.map(() => "---").join(" | ")} |`;
        const lines = [header, sep];
        for (let n = 1; n <= shown; n++) {
            const row = rows.get(n);
            const cells = columns.map((c) => row?.get(c) ?? "");
            const arg = encodeURIComponent(JSON.stringify({ uri, funcName: state.funcName, loopId: loop.id, iter: n }));
            lines.push(`| [${n}](command:aiCodeGuide.traceIterSet?${arg}) | ${cells.join(" | ")} |`);
        }
        const table = lines.join("\n");
        return max > MAX_TABLE_ROWS ? `${table}\n\n…以降省略` : table;
    }
}
