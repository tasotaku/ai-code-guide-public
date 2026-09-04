const assert = require("assert");
const { buildSymbolAnnotation, dedupAnnotations, reanchorAnnotations, resolveAnnotations, stableId } = require("../out/api/annotationResolver.js");

const code = [
    "def quicksort(arr):",
    "    if len(arr) <= 1:",
    "        return arr",
    "    pivot = arr[0]",
    "    less = [x for x in arr if x < pivot]",
    "    return quicksort(less)",
].join("\n");
let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

{
    const result = resolveAnnotations([{ kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot", explanation: "基準値" }], code);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual([result[0].startLine, result[0].startCol, result[0].endCol], [3, 4, 9]);
    assert.strictEqual(result[0].kind, "symbol");
    ok("symbolだけを実コードの列へ解決する");
}
{
    const result = resolveAnnotations([{ kind: "symbol", line: 0, lineText: "    pivot = arr[0]", token: "pivot", explanation: "基準値" }], code);
    assert.strictEqual(result[0].startLine, 3);
    ok("誤った行番号を実テキストで補正する");
}
{
    const result = resolveAnnotations([
        { kind: "symbol", lineText: "    pivot = arr[0]", token: "missing", explanation: "不正" },
        { kind: "symbol", lineText: "存在しない行", token: "pivot", explanation: "不正" },
        { kind: "symbol", lineText: "    pivot = arr[0]", token: "pivot", explanation: "" },
    ], code);
    assert.deepStrictEqual(result, []);
    ok("名称・行・説明が検証できない候補を捨てる");
}
{
    const result = resolveAnnotations([{ kind: "block", startLineText: "    pivot = arr[0]", endLineText: "    return quicksort(less)", explanation: "旧block" }], code);
    assert.deepStrictEqual(result, []);
    ok("旧block入力を公開しない");
}
{
    const result = resolveAnnotations([
        { kind: "symbol", lineText: "    less = [x for x in arr if x < pivot]", token: "x", explanation: "左" },
        { kind: "symbol", lineText: "    less = [x for x in arr if x < pivot]", token: "pivot", explanation: "右" },
    ], code);
    assert.strictEqual(result.length, 2);
    assert.ok(result[0].startCol < result[1].startCol);
    ok("同じ行の非重複名称を列順で残す");
}

const symbol = (line, startCol, endCol, scope, label = "x") => ({
    startLine: line, endLine: line, startCol, endCol, kind: "symbol",
    label, explanation: "e", scope, anchorText: `line ${line}`, anchorToken: label,
    id: `${line}:${startCol}:${endCol}:${label}`,
});
{
    const result = dedupAnnotations([
        symbol(1, 4, 10, "range", "new-range"),
        symbol(1, 4, 10, "full", "full"),
        symbol(1, 12, 15, "range", "other"),
    ]);
    assert.deepStrictEqual(result.map((item) => item.label), ["full", "other"]);
    ok("重複はfullを優先し非重複rangeを残す");
}
{
    const raw = { kind: "symbol", lineText: "    pivot = arr[0]", token: "pivot", explanation: "基準値" };
    const first = resolveAnnotations([raw], code)[0];
    const second = resolveAnnotations([{ ...raw, explanation: "別説明" }], code)[0];
    assert.strictEqual(first.id, second.id);
    assert.strictEqual(first.anchorText, "    pivot = arr[0]");
    assert.strictEqual(first.anchorToken, "pivot");
    ok("位置由来IDは説明差に影響されない");
}
{
    const item = resolveAnnotations([{ kind: "symbol", lineText: "    pivot = arr[0]", token: "pivot", explanation: "基準値" }], code)[0];
    const moved = reanchorAnnotations([item], `import math\n${code}`);
    assert.strictEqual(moved.length, 1);
    assert.strictEqual(moved[0].startLine, 4);
    assert.strictEqual(moved[0].id, item.id);
    ok("無関係な行挿入後も名称へ再アンカーする");
}
{
    const item = resolveAnnotations([{ kind: "symbol", lineText: "    pivot = arr[0]", token: "pivot", explanation: "基準値" }], code)[0];
    assert.deepStrictEqual(reanchorAnnotations([item], code.replace("pivot =", "base =")), []);
    ok("対象名称が消えた注釈を落とす");
}
{
    const built = buildSymbolAnnotation(code, { key: "quicksort::pivot", display: "pivot", kind: "variable", line: 3, start_col: 4, end_col: 9 }, "分割の基準値");
    assert.ok(built);
    assert.strictEqual(built.symbolKey, "quicksort::pivot");
    assert.strictEqual(built.symbolKind, "variable");
    assert.strictEqual(built.id, stableId("symbol", "    pivot = arr[0]", "pivot", "        return arr\n    less = [x for x in arr if x < pivot]"));
    ok("AST座標から名称辞書項目を構築する");
}

console.log(`\n${passed} symbol-only resolver tests passed`);
