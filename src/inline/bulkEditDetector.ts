// AI_NOTE: 一括変更(AI生成/ペースト等)検知の純粋ロジック。vscode の TextDocumentContentChangeEvent には
// 依存させず、呼び出し側(extension.ts)で BulkChange に変換して渡す形にして単体テスト可能にする(resolver/gitDiff と同じ流儀)。

// AI_NOTE: 1回の change で新テキストがこの行数以上を占めたら「一括変更」とみなす閾値。
// 人間のタイピングは1打鍵=1イベントなので、1回のchangeで複数行が届くのは原理的に手書きでない(計画書の技術的決定事項)。
export const BULK_EDIT_MIN_LINES = 3;

// AI_NOTE: vscode非依存の入力型。startLine=変更開始行(0-based)、text=挿入された新テキスト、
// rangeLineSpan は現状の判定には使わない(新テキスト側の行数だけで一括変更を判定する仕様のため保持のみ)。
export interface BulkChange {
    startLine: number;
    text: string;
    rangeLineSpan: number;
}

// AI_NOTE: change の新テキストが占める行区間(0-based, 終了行含む)を返す。
// 改行数+1 行を占めるとみなす("abc"なら1行、"a\nb"なら2行)。
function lineSpanOf(change: BulkChange): { start: number; end: number; lineCount: number } {
    const newlineCount = (change.text.match(/\n/g) || []).length;
    const lineCount = newlineCount + 1;
    return { start: change.startLine, end: change.startLine + newlineCount, lineCount };
}

// AI_NOTE: 蓄積ロジック本体。
// - 一括変更(lineCount >= BULK_EDIT_MIN_LINES)が1つも無ければ、1文字タイプ等が既存の検知状態を壊さないよう
//   prev をそのまま維持する(null→null、Set→同じSet)。
// - 一括変更が1つでもあれば、prev(nullなら空集合扱い)に行区間の和集合を足した新しいSetを返す。
// - wholeDoc は返す lines がドキュメント行数の80%以上を占めるかどうか(全文リロード検知のシグナル)。
//   docLineCount が 0 以下の場合は判定不能として false を返す。
export function accumulateBulkChange(
    prev: Set<number> | null,
    changes: BulkChange[],
    docLineCount: number
): { lines: Set<number>; wholeDoc: boolean } | null {
    const bulkChanges = changes.filter((c) => lineSpanOf(c).lineCount >= BULK_EDIT_MIN_LINES);
    if (bulkChanges.length === 0) {
        return prev === null ? null : { lines: prev, wholeDoc: isWholeDoc(prev, docLineCount) };
    }

    const lines = new Set<number>(prev ?? []);
    for (const change of bulkChanges) {
        const { start, end } = lineSpanOf(change);
        for (let line = start; line <= end; line++) {
            lines.add(line);
        }
    }

    return { lines, wholeDoc: isWholeDoc(lines, docLineCount) };
}

// AI_NOTE: 検知済み行数がドキュメント行数の80%以上かどうか。docLineCount<=0 は判定不能なので false 固定。
function isWholeDoc(lines: Set<number>, docLineCount: number): boolean {
    if (docLineCount <= 0) return false;
    return lines.size / docLineCount >= 0.8;
}
