import { SubBlock } from "./claudeClient";

export interface StmtSpan {
    start: number;
    end: number;
}

export interface MeaningRange {
    lineStart: number;
    lineEnd: number;
}

// AI_NOTE: LLMが提案したサブブロックの行範囲(SubBlock.lineStart/lineEnd)は無検証だと
// 複数行文の途中で切れて隙間ができる(annotationResolverと同じ問題)。ここでAST文境界にスナップし、
// 連続性(隙間・重複なし)を機械的に強制する。annotationResolver.ts の設計を踏襲。
export function snapBlocks(
    blocks: SubBlock[],
    stmts: StmtSpan[],
    funcStart: number,
    funcEnd: number,
): SubBlock[] {
    if (blocks.length === 0) return [];

    const sorted = [...blocks]
        .sort((a, b) => a.lineStart - b.lineStart)
        .map(b => ({
            ...b,
            lineStart: Math.max(funcStart, Math.min(funcEnd, b.lineStart)),
            lineEnd: Math.max(funcStart, Math.min(funcEnd, b.lineEnd)),
        }));

    // AI_NOTE: lineEndを含む文スパンのうち最小サイズのものを選ぶ。最大サイズを選ぶとfor/tryなど
    // 外側の複合文に膨らんでブロックが不自然に肥大化するため、最も内側(最小)のスパンだけを見る。
    for (const b of sorted) {
        let best: StmtSpan | null = null;
        for (const s of stmts) {
            if (s.start <= b.lineEnd && b.lineEnd <= s.end) {
                if (!best || (s.end - s.start) < (best.end - best.start)) best = s;
            }
        }
        if (best && best.end > b.lineEnd) {
            b.lineEnd = Math.min(funcEnd, best.end);
        }
    }

    // AI_NOTE: 隙間・重複を機械的に解消する。先頭はfuncStart固定、以降は「直前の生存ブロックのlineEnd+1」を
    // lineStartとする。逆転(lineStart>lineEnd)したブロックは捨てて連鎖を継続する。
    const result: SubBlock[] = [];
    let prevEnd = funcStart - 1;
    for (const b of sorted) {
        const lineStart = result.length === 0 ? funcStart : prevEnd + 1;
        if (lineStart > b.lineEnd) continue;
        const snapped = { ...b, lineStart, lineEnd: b.lineEnd };
        result.push(snapped);
        prevEnd = snapped.lineEnd;
    }

    if (result.length > 0) result[result.length - 1].lineEnd = funcEnd;
    return result;
}

function structuralCopy(line: string, index: number): Pick<SubBlock, "label" | "description"> {
    const text = line.trim();
    if (/^(?:async\s+)?for\b/.test(text)) return { label: "順番に処理", description: "要素を順に取り出して処理する。" };
    if (/^while\b/.test(text)) return { label: "条件付きで反復", description: "条件を満たす間、処理を繰り返す。" };
    if (/^if\b/.test(text)) return { label: "条件で分岐", description: "条件に応じて実行する処理を分ける。" };
    if (/^match\b/.test(text)) return { label: "パターンで分岐", description: "値のパターンに応じて処理を分ける。" };
    if (/^try\b/.test(text)) return { label: "例外を処理", description: "通常処理と失敗時の処理をまとめる。" };
    if (/^with\b/.test(text)) return { label: "資源を扱う", description: "必要な資源を安全に開いて処理する。" };
    if (/^return\b/.test(text)) return { label: "結果を返す", description: "処理結果を呼び出し元へ返す。" };
    if (/^(?:raise|assert)\b/.test(text)) return { label: "条件を検証", description: "成立すべき条件を確認する。" };
    if (/^[A-Za-z_]\w*(?:\s*:\s*[^=]+)?\s*=/.test(text)) return { label: "値を準備", description: "後続の処理で使う値を準備する。" };
    return { label: `処理 ${index + 1}`, description: "まとまりとして実行される処理。" };
}

// AI_NOTE: モデルが中程度以上の関数を全体1ブロックで返した場合も、ASTの直下文を使って
// 意味色を最低2単位へ分ける。内側の文はfor/if等の親文へ含め、構文途中では切らない。
export function splitSingleBlockByTopLevelStatements(
    blocks: SubBlock[],
    stmts: StmtSpan[],
    funcStart: number,
    funcEnd: number,
    sourceLines: string[],
): SubBlock[] {
    if (blocks.length !== 1 || funcEnd - funcStart < 4) return blocks;
    const candidates = stmts
        .filter((span) => span.start >= funcStart && span.end <= funcEnd)
        .filter((span) => !(span.start === funcStart && span.end === funcEnd));
    const direct = candidates
        .filter((span) => !candidates.some((parent) => parent !== span
            && parent.start <= span.start && parent.end >= span.end
            && (parent.start < span.start || parent.end > span.end)))
        .filter((span, index, all) => all.findIndex((candidate) => candidate.start === span.start && candidate.end === span.end) === index)
        .sort((left, right) => left.start - right.start || left.end - right.end);
    if (direct.length < 2) return blocks;
    return direct.map((span, index) => {
        const next = direct[index + 1];
        const copy = structuralCopy(sourceLines[span.start] ?? "", index);
        return {
            ...copy,
            lineStart: index === 0 ? funcStart : span.start,
            lineEnd: next ? next.start - 1 : funcEnd,
        };
    });
}

// AI_NOTE: 背景色は説明生成と独立した既定レイヤーなので、LLMを呼ばずAST直下文だけで
// 関数全体を連続範囲へ分ける。短い関数も必ず1範囲を返し、詳細文はこの結果へ混ぜない。
export function buildDefaultMeaningRanges(
    stmts: StmtSpan[],
    funcStart: number,
    funcEnd: number,
    sourceLines: string[],
): MeaningRange[] {
    const seed: SubBlock = {
        label: "",
        description: "",
        lineStart: funcStart,
        lineEnd: funcEnd,
    };
    return splitSingleBlockByTopLevelStatements(
        [seed], stmts, funcStart, funcEnd, sourceLines,
    ).map(({ lineStart, lineEnd }) => ({ lineStart, lineEnd }));
}
