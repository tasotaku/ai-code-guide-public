import * as fs from "fs";

function indentOf(line: string): number {
    return (line.match(/^\s*/) ?? [""])[0].length;
}

function symbolName(symbol: string): string {
    return symbol.split(".").pop() ?? symbol;
}

function definitionBlock(lines: string[], symbol: string): string {
    const name = symbolName(symbol).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const definition = new RegExp(`^(\\s*)(?:async\\s+def|def|class)\\s+${name}\\b`);
    const start = lines.findIndex((line) => definition.test(line));
    if (start < 0) return "";
    const indent = indentOf(lines[start]);
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
        const trimmed = lines[index].trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;
        if (indentOf(lines[index]) <= indent) {
            end = index;
            break;
        }
    }
    return lines.slice(start, end).join("\n").trimEnd();
}

// AI_NOTE: 長いファイルの先頭だけでは入口やcalleeが欠落する。質問に実名で出た関数の
// 定義ブロックを優先し、import/定数の前置きと一緒に予算内へ収めて横断図の根拠にする。
export function buildProjectDiagramSourceExcerpt(
    filePath: string,
    symbols: string[],
    question: string,
    maxChars = 32000,
): string {
    let source: string;
    try {
        source = fs.readFileSync(filePath, "utf8");
    } catch {
        return "";
    }
    if (source.length <= 4000) return source;

    const requested = symbols.filter((symbol) => {
        const name = symbolName(symbol);
        return question.includes(symbol) || question.includes(`${name}(`) || question.includes(`${name}()`);
    });
    if (requested.length === 0) return `${source.slice(0, 1800)}\n# ... (truncated)`;

    const lines = source.split(/\r?\n/);
    const firstDefinition = lines.findIndex((line) => /^(?:async\s+def|def|class)\s+/.test(line));
    const preamble = lines.slice(0, firstDefinition < 0 ? Math.min(lines.length, 80) : firstDefinition).join("\n").slice(0, 2400);
    const blocks = requested.map((symbol) => definitionBlock(lines, symbol)).filter(Boolean);
    const excerpt = [preamble, ...blocks].filter(Boolean).join("\n\n# --- selected definition ---\n");
    return excerpt.length <= maxChars ? excerpt : `${excerpt.slice(0, maxChars)}\n# ... (selected definitions truncated)`;
}
