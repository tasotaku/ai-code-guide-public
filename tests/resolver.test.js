// 単体テスト: resolveAnnotations がモデルの壊れた座標をテキスト探索で補正・検証することを確認する。
// 実行: npm test （内部で npm run compile → node tests/resolver.test.js）
const assert = require("assert");
const { resolveAnnotations, dedupAnnotations, reanchorAnnotations, selectVisibleAnnotations, buildSymbolAnnotation } = require("../out/api/annotationResolver.js");

// 観測した実コードを模した10行スニペット（0-based）
const code = [
    "def quicksort(arr):",            // 0
    "    if len(arr) <= 1:",          // 1
    "        return arr",             // 2
    "    pivot = arr[0]",             // 3
    "    less = [x for x in arr]",    // 4
    "def mergesort(arr):",           // 5
    "    if len(arr) <= 1:",          // 6
    "        return arr",             // 7
    "Graph = dict[str, list[str]]",  // 8
    "    for w in range(cap + 1):",   // 9
].join("\n");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

{
    const item = buildSymbolAnnotation(code, {
        key: "quicksort|variable|pivot", display: "pivot", kind: "variable",
        line: 3, start_col: 4, end_col: 9,
    }, "基準値を保持する変数です。");
    assert.ok(item);
    assert.strictEqual(item.kind, "symbol");
    assert.strictEqual(item.anchorToken, "pivot");
    assert.strictEqual(item.symbolKey, "quicksort|variable|pivot");
    assert.strictEqual(item.symbolKind, "variable");
    assert.strictEqual(buildSymbolAnnotation(code, {
        key: "bad", display: "bad", kind: "variable", line: 99, start_col: 0, end_col: 3,
    }, "bad"), null);
    ok("symbol辞書: AST座標から名称注釈を決定的に構築");
}

// 1. symbol 正常: token から列を算出
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "[x for x in arr]", explanation: "内包表記" },
    ], code);
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual([r[0].startLine, r[0].startCol, r[0].endCol], [4, 11, 27]);
    ok("symbol: token から正しい列範囲");
}

// 2. block 正常: 先頭/末尾テキストから行範囲
{
    const r = resolveAnnotations([
        { kind: "block", startLine: 3, endLine: 4, startLineText: "    pivot = arr[0]", endLineText: "    less = [x for x in arr]", explanation: "分割" },
    ], code);
    assert.deepStrictEqual([r[0].startLine, r[0].endLine, r[0].startCol], [3, 4, null]);
    ok("block: 先頭/末尾テキストから行範囲");
}

// 3. 行番号が大きくズレても lineText で正しい行に補正（Graph 再現: hint=99 を 8 に補正）
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 99, lineText: "Graph = dict[str, list[str]]", token: "Graph", explanation: "型エイリアス" },
    ], code);
    assert.strictEqual(r[0].startLine, 8, "ズレたヒントを無視してテキストで行8に補正");
    assert.deepStrictEqual([r[0].startCol, r[0].endCol], [0, 5], "Graph の5文字に下線");
    ok("symbol: 行番号ズレをテキスト探索で補正");
}

// 4. 重複行（return arr が行2と行7）→ ヒント近接で解決
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 7, lineText: "        return arr", token: "return", explanation: "返却" },
    ], code);
    assert.strictEqual(r[0].startLine, 7, "ヒント7に近い行7を選ぶ");
    ok("symbol: 重複行はヒント近接で解決");
}

// 5. token が行内に無い（空白差異）→ インデント除く行全体にフォールバック
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot=arr[0]", explanation: "代入" },
    ], code);
    // "    pivot = arr[0]" → 先頭4空白を除いた 4..17
    assert.deepStrictEqual([r[0].startCol, r[0].endCol], [4, 18], "トークン不一致時は行全体（インデント除く）");
    ok("symbol: token不一致は行全体フォールバック");
}

// 6. block の末尾テキストが見つからない → endIdx=startIdx
{
    const r = resolveAnnotations([
        { kind: "block", startLine: 3, endLine: 9, startLineText: "    pivot = arr[0]", endLineText: "存在しない行", explanation: "x" },
    ], code);
    assert.deepStrictEqual([r[0].startLine, r[0].endLine], [3, 3], "末尾不明なら単行に縮める");
    ok("block: 末尾不明は単行化");
}

// 7. lineText がどこにも無い → 捨てる
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 0, lineText: "まったく存在しない行", token: "x", explanation: "y" },
    ], code);
    assert.strictEqual(r.length, 0, "見つからない注釈は表示しない");
    ok("error: 行が見つからない注釈を捨てる");
}

// 8. explanation 空 → 捨てる
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot", explanation: "" },
    ], code);
    assert.strictEqual(r.length, 0);
    ok("error: explanation空を捨てる");
}

// 9. block の span が異常に大きい → startIdx に潰す（末尾誤一致対策）
{
    const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const r = resolveAnnotations([
        { kind: "block", startLine: 0, endLine: 55, startLineText: "line 0", endLineText: "line 55", explanation: "z" },
    ], big);
    assert.deepStrictEqual([r[0].startLine, r[0].endLine], [0, 0], "40行超のブロックは単行化");
    ok("error: 暴走ブロックを単行化");
}

// 10. severity 既定は info、warning は通る（dedup回避のため別々の行を使う）
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot", explanation: "既定" },
        { kind: "symbol", severity: "warning", line: 8, lineText: "Graph = dict[str, list[str]]", token: "Graph", explanation: "バグ" },
        { kind: "symbol", severity: "bogus", line: 4, lineText: "    less = [x for x in arr]", token: "less", explanation: "不正値" },
    ], code);
    const by = (exp) => r.find(a => a.explanation === exp);
    assert.strictEqual(by("既定").severity, "info", "severity未指定はinfo");
    assert.strictEqual(by("バグ").severity, "warning", "warningは通る");
    assert.strictEqual(by("不正値").severity, "info", "不正なseverityはinfoに丸める");
    ok("severity: 既定info / warning / 不正値の丸め");
}

// 11. label: 指定時はそのまま、未指定時は explanation から導出（句点切り/切り詰め）。別々の行を使う
{
    const longExp = "とても長い説明がここに続いて三十二文字を超える場合は末尾を切り詰めて見出しにするはずだ";
    const r = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot", label: "見出し", explanation: "詳しい説明" },
        { kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "less", explanation: "句点まで。これは無視される" },
        { kind: "symbol", line: 8, lineText: "Graph = dict[str, list[str]]", token: "Graph", explanation: longExp },
    ], code);
    const by = (exp) => r.find(a => a.explanation === exp);
    assert.strictEqual(by("詳しい説明").label, "見出し", "label指定はそのまま");
    assert.strictEqual(by("句点まで。これは無視される").label, "句点まで", "label未指定は句点で切る");
    assert.ok(by(longExp).label.endsWith("…") && by(longExp).label.length <= 32, "長文は…で切り詰め");
    ok("label: 指定/句点切り/切り詰め");
}

// 12. 同じ行でも非重複なら複数許可。列順に並ぶ
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "arr", explanation: "右のトークン" },
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot", explanation: "左のトークン" },
    ], code);
    assert.strictEqual(r.length, 2, "同じ行でも非重複なら複数残す");
    assert.deepStrictEqual(r.map(a => a.startCol), [4, 12], "列の左→右順に並ぶ");
    ok("同一行: 非重複の複数symbolを許可＆列順");
}

// 12b. 重なる（入れ子）トークンは1つに絞る。warning 優先
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "arr", explanation: "info" },
        { kind: "symbol", severity: "warning", line: 3, lineText: "    pivot = arr[0]", token: "arr[0]", explanation: "バグ" },
    ], code);
    assert.strictEqual(r.length, 1, "範囲が重なるトークンは1つに絞る");
    assert.strictEqual(r[0].severity, "warning", "重なり時はwarningを優先");
    ok("同一行: 重なりは1つ＋warning優先");
}

// 13. 異なる行は両方残り、startLine 昇順
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "less", explanation: "後の行" },
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot", explanation: "前の行" },
    ], code);
    assert.deepStrictEqual(r.map(a => a.startLine), [3, 4], "異なる行は両方残り昇順");
    ok("異なる行は保持＆行順ソート");
}

// --- dedupAnnotations: full/range スコープ統合の優先度（生成全体と範囲解析のマージ） ---
const sym = (line, c0, c1, scope, sev = "info", label = "x") => ({ startLine: line, endLine: line, startCol: c0, endCol: c1, kind: "symbol", severity: sev, label, explanation: "e", scope });
const blk = (s, e, scope, sev = "info", label = "b") => ({ startLine: s, endLine: e, startCol: null, endCol: null, kind: "block", severity: sev, label, explanation: "e", scope });

// 14. symbol 重なり: full が range に勝つ（全体生成が範囲解析を吸収）
{
    const r = dedupAnnotations([sym(0, 0, 5, "range", "info", "R"), sym(0, 2, 4, "full", "info", "F")]);
    assert.deepStrictEqual(r.map(a => a.label), ["F"], "重なりは full を残す");
    ok("scope: symbol重なりは full>range");
}

// 15. 非重複の range は full と共存する（範囲解析の資産が残る）
{
    const r = dedupAnnotations([sym(0, 0, 3, "full", "info", "F"), sym(5, 0, 3, "range", "info", "R")]);
    assert.deepStrictEqual(r.map(a => a.label), ["F", "R"], "重ならない range は残す");
    ok("scope: 非重複の range は共存");
}

// 16. 同じ場所の range 再解析: 配列先頭(新しい方)が勝つ
{
    const r = dedupAnnotations([sym(0, 0, 5, "range", "info", "NEW"), sym(0, 1, 4, "range", "info", "OLD")]);
    assert.deepStrictEqual(r.map(a => a.label), ["NEW"], "同じ場所は新しい range を残す");
    ok("scope: range再解析は新しい方優先");
}

// 17. warning は full にも勝つ（block同一開始行）
{
    const r = dedupAnnotations([blk(0, 5, "full", "info", "F"), blk(0, 3, "full", "warning", "W")]);
    assert.deepStrictEqual(r.map(a => a.label), ["W"], "同一開始行は warning 優先");
    ok("scope: block同一開始行は warning優先");
}

// 19. symbol: anchorText/anchorToken/id を持つ（編集追従・ステータスの土台）
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "arr", explanation: "e" },
    ], code);
    assert.strictEqual(r[0].anchorText, "    less = [x for x in arr]", "symbol anchorText=対象行");
    assert.strictEqual(r[0].anchorToken, "arr", "symbol anchorToken=下線トークン");
    assert.ok(typeof r[0].id === "string" && r[0].id.length > 0, "symbol id 付与");
    ok("anchor: symbol が anchorText/anchorToken/id を持つ");
}

// 20. block: anchorText/anchorEndText/id を持つ
{
    const r = resolveAnnotations([
        { kind: "block", startLine: 3, endLine: 4, startLineText: "    pivot = arr[0]", endLineText: "    less = [x for x in arr]", explanation: "e" },
    ], code);
    assert.strictEqual(r[0].anchorText, "    pivot = arr[0]", "block anchorText=先頭行");
    assert.strictEqual(r[0].anchorEndText, "    less = [x for x in arr]", "block anchorEndText=末尾行");
    assert.ok(r[0].id.length > 0, "block id 付与");
    ok("anchor: block が anchorText/anchorEndText/id を持つ");
}

// 21. symbol token不一致のfallbackでは anchorToken を持たない
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "NOTHERE", explanation: "e" },
    ], code);
    assert.strictEqual(r[0].anchorToken, undefined, "fallback時 anchorToken は持たない");
    ok("anchor: token不一致fallbackは anchorToken なし");
}

// 22. id は空白差・説明差に不変（再突合の同定が安定）＝ 同じ場所なら同一id
{
    const a = resolveAnnotations([{ kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "arr", explanation: "e" }], code)[0];
    const code2 = code.replace("    less = [x for x in arr]", "      less  =  [x for x in arr]");
    const b = resolveAnnotations([{ kind: "symbol", line: 4, lineText: "      less  =  [x for x in arr]", token: "arr", explanation: "別の説明" }], code2)[0];
    assert.strictEqual(a.id, b.id, "空白差・説明差があっても同じ場所なら同一id");
    ok("anchor: id は空白/説明差に不変(再突合の同定が安定)");
}

// 23. 異なる場所は異なるid
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot", explanation: "e" },
        { kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "arr", explanation: "e" },
    ], code);
    assert.notStrictEqual(r[0].id, r[1].id, "異なる場所は異なるid");
    ok("anchor: 異なる場所は異なるid");
}

// 23b. id衝突回避: 同一行テキスト＋同一トークンでも、前後行(文脈)が違えば別id
// （code の行1と行6はどちらも "    if len(arr) <= 1:"。前後が quicksort/mergesort で異なる）
{
    const r = resolveAnnotations([
        { kind: "symbol", line: 1, lineText: "    if len(arr) <= 1:", token: "len", explanation: "e" },
        { kind: "symbol", line: 6, lineText: "    if len(arr) <= 1:", token: "len", explanation: "e" },
    ], code);
    assert.strictEqual(r.length, 2, "同一行テキストの2箇所が両方残る");
    assert.notStrictEqual(r[0].id, r[1].id, "前後行が違えば id は衝突しない(状態の取り違え防止)");
    ok("anchor: 同一行テキストでも文脈が違えば別id(衝突回避)");
}

// --- reanchorAnnotations: 編集後の増分再突合（座標を捨ててアンカーで取り直す） ---

// 24. 上に行が挿入されてズレても、アンカーで同じコードを追従する
{
    const orig = resolveAnnotations([
        { kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "arr", explanation: "e" },
    ], code);
    const edited = "# new comment\n# another\n" + code; // 2行挿入で全体が下にズレる
    const r = reanchorAnnotations(orig, edited);
    assert.strictEqual(r.length, 1, "アンカーが残れば追従して残る");
    assert.strictEqual(r[0].startLine, 6, "2行挿入分(4→6)に座標が更新される");
    assert.strictEqual(r[0].id, orig[0].id, "id は不変(同じ注釈として同定)");
    ok("reanchor: 行挿入でズレても追従して座標更新");
}

// 25. アンカー行そのものを編集すると、その注釈だけ落ちる
{
    const orig = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "    pivot = arr[0]", token: "pivot", explanation: "e" },
        { kind: "symbol", line: 4, lineText: "    less = [x for x in arr]", token: "arr", explanation: "e" },
    ], code);
    const edited = code.replace("    pivot = arr[0]", "    pivot = arr[-1]  # 末尾に変更");
    const r = reanchorAnnotations(orig, edited);
    assert.strictEqual(r.length, 1, "編集した行の注釈だけ落ち、もう一方は残る");
    assert.strictEqual(r[0].anchorToken, "arr", "残るのは編集していない less 行の注釈");
    ok("reanchor: 編集された行の注釈だけ落ちる");
}

// 26. block も先頭/末尾アンカーで追従する
{
    const orig = resolveAnnotations([
        { kind: "block", startLine: 3, endLine: 4, startLineText: "    pivot = arr[0]", endLineText: "    less = [x for x in arr]", explanation: "e" },
    ], code);
    const edited = "import os\n" + code;
    const r = reanchorAnnotations(orig, edited);
    assert.deepStrictEqual([r[0].startLine, r[0].endLine], [4, 5], "1行挿入でblock範囲が下へ追従");
    ok("reanchor: block が先頭/末尾アンカーで追従");
}

// 27. 空入力は空（注釈ゼロのファイルで安全）
{
    assert.strictEqual(reanchorAnnotations([], code).length, 0, "空ならそのまま空");
    ok("reanchor: 空入力は空");
}

// --- selectVisibleAnnotations: 状態/表示モードで表示を絞る（hide-resolved / warnings-only） ---
{
    const anns = [
        { id: "i1", severity: "info" },
        { id: "i2", severity: "info" },
        { id: "w1", severity: "warning" },
    ];
    const statusOf = (id) => (id === "i2" ? "resolved" : undefined);

    // 28. 既定(hideResolved=true, warningsOnly=false): 解決済みだけ落ちる
    {
        const r = selectVisibleAnnotations(anns, statusOf, { hideResolved: true, warningsOnly: false });
        assert.deepStrictEqual(r.map(a => a.id), ["i1", "w1"], "解決済みi2が落ち、他は残る");
        ok("visible: hideResolved で解決済みを除外");
    }
    // 29. warningsOnly: warning だけ
    {
        const r = selectVisibleAnnotations(anns, statusOf, { hideResolved: false, warningsOnly: true });
        assert.deepStrictEqual(r.map(a => a.id), ["w1"], "warningのみ残る");
        ok("visible: warningsOnly で警告だけ");
    }
    // 30. 両方ON: warning かつ未解決
    {
        const anns2 = [...anns, { id: "w2", severity: "warning" }];
        const statusOf2 = (id) => (id === "w2" ? "resolved" : undefined);
        const r = selectVisibleAnnotations(anns2, statusOf2, { hideResolved: true, warningsOnly: true });
        assert.deepStrictEqual(r.map(a => a.id), ["w1"], "解決済みwarningは隠れ、未解決warningだけ残る");
        ok("visible: 両モードANDで効く");
    }
    // 31. 両方OFF: 全部出る
    {
        const r = selectVisibleAnnotations(anns, statusOf, { hideResolved: false, warningsOnly: false });
        assert.strictEqual(r.length, 3, "両OFFなら全件");
        ok("visible: 両OFFは全件表示");
    }
}

// 32. diffモード: 変更行に重なる注釈だけ残す
{
    const anns = [
        { id: "a", severity: "info", startLine: 2, endLine: 2 },      // 変更行2に重なる→残る
        { id: "b", severity: "info", startLine: 5, endLine: 8 },      // 範囲に変更行7を含む→残る
        { id: "c", severity: "info", startLine: 20, endLine: 20 },    // 変更行に無い→落ちる
    ];
    const changedLines = new Set([2, 7]);
    const r = selectVisibleAnnotations(anns, () => undefined, { hideResolved: false, warningsOnly: false, changedLines });
    assert.deepStrictEqual(r.map(a => a.id), ["a", "b"], "変更行に重なる注釈だけ残る");
    ok("visible: changedLines(diffモード)で変更行に重なる注釈だけ");
}

// 33. 粒度別トグル: showSymbol=false で下線(symbol)だけ落ち、枠(block)は残る
{
    const anns = [
        { id: "s1", kind: "symbol", severity: "info" },
        { id: "b1", kind: "block", severity: "info" },
        { id: "s2", kind: "symbol", severity: "warning" },
    ];
    const statusOf = () => undefined;

    {
        const r = selectVisibleAnnotations(anns, statusOf, { hideResolved: false, warningsOnly: false, showSymbol: false });
        assert.deepStrictEqual(r.map(a => a.id), ["b1"], "symbolが全て落ち、blockだけ残る");
        ok("visible: showSymbol=false で下線だけ隠す");
    }
    // 34. showBlock=false で枠(block)だけ落ち、下線(symbol)は残る
    {
        const r = selectVisibleAnnotations(anns, statusOf, { hideResolved: false, warningsOnly: false, showBlock: false });
        assert.deepStrictEqual(r.map(a => a.id), ["s1", "s2"], "blockが落ち、symbolだけ残る");
        ok("visible: showBlock=false でブロックだけ隠す");
    }
    // 35. 未指定(undefined)は既定表示=両方残る
    {
        const r = selectVisibleAnnotations(anns, statusOf, { hideResolved: false, warningsOnly: false });
        assert.strictEqual(r.length, 3, "showSymbol/showBlock未指定なら全件");
        ok("visible: 粒度トグル未指定は全件表示");
    }
}

console.log(`\n${passed} resolver tests passed`);
