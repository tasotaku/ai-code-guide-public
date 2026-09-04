const palette = ["#4ec9b0", "#d7ba7d", "#c586c0", "#569cd6", "#ce9178", "#b5cea8"] as const;
export const SEMANTIC_BACKGROUND_PALETTE = palette;

export type SemanticBackgroundRange = { lineStart: number; lineEnd: number; label?: string; colorIndex?: number };
export type SemanticBackgroundLine = SemanticBackgroundRange & { color: string };

function indexSemanticRanges(ranges: SemanticBackgroundRange[], colors: readonly string[]): Map<number, SemanticBackgroundLine> {
    // AI_NOTE: 色の割当と重なりの優先順位を全surfaceで共有し、LLMの区切り以外は追加しない。
    const lines = new Map<number, SemanticBackgroundLine>();
    const sorted = ranges.filter(range => Number.isSafeInteger(range.lineStart) && Number.isSafeInteger(range.lineEnd)
        && range.lineStart > 0 && range.lineEnd >= range.lineStart)
        .sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
    sorted.forEach((range, index) => {
        const colorIndex = Number.isSafeInteger(range.colorIndex) && range.colorIndex! >= 0 ? range.colorIndex! : index;
        const unit = { ...range, color: colors[colorIndex % colors.length] };
        for (let line = range.lineStart; line <= range.lineEnd; line++) {
            const previous = lines.get(line);
            if (!previous || range.lineEnd - range.lineStart < previous.lineEnd - previous.lineStart) lines.set(line, unit);
        }
    });
    return lines;
}

export function buildSemanticLineIndex(ranges: SemanticBackgroundRange[]): Map<number, SemanticBackgroundLine> {
    // AI_NOTE: bundleでの変数renameに依存しない純粋関数へ共通paletteを明示して渡す。
    return indexSemanticRanges(ranges, SEMANTIC_BACKGROUND_PALETTE);
}

// AI_NOTE: ブラウザでも同じ純粋関数を実行し、トグルやhoverではindexを作り直さない。
export const semanticBackgroundRuntime = `
const SEMANTIC_BACKGROUND_PALETTE=${JSON.stringify(SEMANTIC_BACKGROUND_PALETTE)};
const buildSemanticLineIndex=ranges=>(${indexSemanticRanges.toString()})(ranges,SEMANTIC_BACKGROUND_PALETTE);
const backgroundRanges=standard=>standard.backgroundRanges??(standard.items||[]).flatMap(item=>item.meaningRanges||[]);
let semanticIndex=new Map(),semanticFingerprint="";
const updateSemanticIndex=standard=>{const ranges=backgroundRanges(standard),fingerprint=JSON.stringify(ranges);if(fingerprint===semanticFingerprint)return;semanticFingerprint=fingerprint;semanticIndex=buildSemanticLineIndex(ranges)};
`;
