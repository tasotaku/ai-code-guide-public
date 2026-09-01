function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pythonのトップレベル関数/classと Class.method を0始まりの実コード行へ解決する。
export function findProjectSymbolLineInLines(lines: string[], symbol: string): number {
    if (!symbol) return -1;
    const parts = symbol.split(".");
    const name = parts.pop() ?? symbol;
    let start = 0;
    let classIndent = -1;
    if (parts.length) {
        const className = parts.join(".");
        const classPattern = new RegExp(`^(\\s*)class\\s+${escapeRegExp(className)}\\b`);
        const classIndex = lines.findIndex((line) => classPattern.test(line));
        if (classIndex < 0) return -1;
        start = classIndex + 1;
        classIndent = (lines[classIndex].match(/^\s*/) ?? [""])[0].length;
    }

    const defPattern = new RegExp(`^(\\s*)(?:async\\s+def|def)\\s+${escapeRegExp(name)}\\s*\\(`);
    const classPattern = new RegExp(`^(\\s*)class\\s+${escapeRegExp(name)}\\b`);
    for (let index = start; index < lines.length; index++) {
        const match = lines[index].match(defPattern) ?? (classIndent < 0 ? lines[index].match(classPattern) : null);
        if (match && (classIndent < 0 || match[1].length > classIndent)) return index;
        if (classIndent >= 0 && lines[index].trim() && (lines[index].match(/^\s*/) ?? [""])[0].length <= classIndent) break;
    }
    return -1;
}

// A diagram node represents a concrete statement inside a symbol, not merely the definition.
// Resolve the model's verbatim anchor only within that symbol and fall back to the definition.
export function findProjectAnchorLineInLines(lines: string[], symbol: string, anchor: string): number {
    const definition = findProjectSymbolLineInLines(lines, symbol);
    if (definition < 0) return -1;
    const definitionIndent = (lines[definition].match(/^\s*/) ?? [""])[0].length;
    let end = lines.length;
    for (let index = definition + 1; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        const indent = (lines[index].match(/^\s*/) ?? [""])[0].length;
        if (indent <= definitionIndent) {
            end = index;
            break;
        }
    }
    const wanted = anchor.trim();
    if (!wanted) return definition;
    for (let index = definition; index < end; index++) {
        if (lines[index].trim() === wanted) return index;
    }
    for (let index = definition; index < end; index++) {
        if (lines[index].includes(wanted)) return index;
    }
    return definition;
}
