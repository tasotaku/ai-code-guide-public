// 単体テスト: snapBlocks がLLMの無検証な行範囲をAST文境界にスナップし、
// 隙間・重複・逆転を機械的に解消することを確認する。
// 実行: npm test （内部で npm run compile → node tests/blockSnapper.test.js）
const assert = require("assert");
const { buildDefaultMeaningRanges, snapBlocks, splitSingleBlockByTopLevelStatements } = require("../out/api/blockRangeSnapper.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

const blk = (label, lineStart, lineEnd) => ({ label, lineStart, lineEnd, description: "" });

// 1. 文の途中切断が文末へ延長される（atoms.py実例を模す）
// 0-idx 50〜53 の複数行文(conn.execute INSERT)が52で切断されているケース
{
    const blocks = [
        blk("a", 36, 47),
        blk("b", 48, 52),
        blk("c", 54, 57),
        blk("d", 58, 61),
    ];
    const stmts = [
        { start: 36, end: 47 },
        { start: 48, end: 49 },
        { start: 50, end: 53 }, // 複数行文(INSERT)。52はこのスパンに含まれる
        { start: 54, end: 55 },
        { start: 56, end: 57 },
        { start: 58, end: 61 },
    ];
    const r = snapBlocks(blocks, stmts, 36, 61);
    const b = r.find(x => x.label === "b");
    const c = r.find(x => x.label === "c");
    assert.strictEqual(b.lineEnd, 53, "bの末尾が文末53まで延長される");
    assert.strictEqual(c.lineStart, 54, "cの開始は54のまま隙間ゼロ");
    ok("文の途中切断が文末へ延長され隙間ゼロになる");
}

// 2. 隙間の吸収: 連続していないブロック列を渡すと連続性が機械的に強制される
{
    const blocks = [blk("a", 0, 3), blk("b", 6, 9)]; // 4,5が隙間
    const stmts = [{ start: 0, end: 3 }, { start: 6, end: 9 }];
    const r = snapBlocks(blocks, stmts, 0, 9);
    assert.strictEqual(r[0].lineStart, 0);
    assert.strictEqual(r[1].lineStart, r[0].lineEnd + 1, "bのlineStartはaのlineEnd+1(隙間吸収)");
    ok("隙間が機械的に吸収される");
}

// 3. 重複の解消: 重なったブロック列を渡すと解消される
{
    const blocks = [blk("a", 0, 5), blk("b", 3, 9)]; // 3-5が重複
    const stmts = [{ start: 0, end: 5 }, { start: 6, end: 9 }];
    const r = snapBlocks(blocks, stmts, 0, 9);
    assert.strictEqual(r[1].lineStart, r[0].lineEnd + 1, "bのlineStartはaのlineEnd+1(重複解消)");
    ok("重複が機械的に解消される");
}

// 4. 逆転ブロック(lineStart > lineEnd)の削除。捨てても後続の連鎖は正しく続く
{
    // aの後、bのlineEndがaのlineEndより手前になり、b算出後 lineStart(=prevEnd+1) > lineEnd になるケース
    const blocks = [blk("a", 0, 5), blk("b", 2, 3), blk("c", 6, 9)];
    const stmts = [{ start: 0, end: 5 }, { start: 6, end: 9 }];
    const r = snapBlocks(blocks, stmts, 0, 9);
    assert.strictEqual(r.length, 2, "逆転したbは捨てられ2件残る");
    assert.deepStrictEqual(r.map(x => x.label), ["a", "c"], "aとcが残る");
    assert.strictEqual(r[1].lineStart, r[0].lineEnd + 1, "cはaのlineEnd+1から連鎖する");
    ok("逆転ブロックは削除され後続の連鎖は正しく続く");
}

// 5. 空配列: blocks=[] で呼ぶと空配列が返る
{
    const r = snapBlocks([], [{ start: 0, end: 5 }], 0, 5);
    assert.deepStrictEqual(r, [], "空配列を返す");
    ok("空配列入力は空配列を返す");
}

// 6. 最終ブロックがfuncEndまで延びる
{
    const blocks = [blk("a", 0, 3), blk("b", 4, 7)];
    const stmts = [{ start: 0, end: 3 }, { start: 4, end: 7 }];
    const r = snapBlocks(blocks, stmts, 0, 9); // funcEnd=9だがbは7まで
    assert.strictEqual(r[r.length - 1].lineEnd, 9, "最終ブロックはfuncEndまで延長される");
    ok("最終ブロックがfuncEndまで延びる");
}

// 7. 最小スパン選択: 内側の小さいスパンと外側の大きいスパン(for/try等)がある場合、最小が選ばれる
// (最終ブロックはfuncEndまで強制延長されるため、非最終ブロックで検証する)
{
    const blocks = [blk("a", 0, 2), blk("b", 3, 8)];
    const stmts = [
        { start: 0, end: 8 },  // 外側の大きいスパン(for文全体など)。aのlineEnd=2もこの範囲に入る
        { start: 0, end: 2 },  // 内側の最小スパン
        { start: 3, end: 8 },
    ];
    const r = snapBlocks(blocks, stmts, 0, 8);
    assert.strictEqual(r[0].lineEnd, 2, "外側の大きいスパンに膨らまず最小スパンが選ばれ延長なし");
    ok("最小スパン選択で外側の複合文に膨らまない");
}

// 8. 中程度の関数をモデルが1ブロックで返しても、AST直下文で意味単位へ分ける
{
    const source = [
        "def calculate_total(prices, coupon=None):",
        "    subtotal = 0",
        "    for price in prices:",
        "        subtotal += price",
        "    if coupon == 'SAVE10':",
        "        subtotal *= 0.9",
        "    return round(subtotal)",
    ];
    const stmts = [
        { start: 0, end: 6 },
        { start: 1, end: 1 },
        { start: 2, end: 3 }, { start: 3, end: 3 },
        { start: 4, end: 5 }, { start: 5, end: 5 },
        { start: 6, end: 6 },
    ];
    const r = splitSingleBlockByTopLevelStatements([blk("全体", 0, 6)], stmts, 0, 6, source);
    assert.deepStrictEqual(r.map(({ label, lineStart, lineEnd }) => ({ label, lineStart, lineEnd })), [
        { label: "値を準備", lineStart: 0, lineEnd: 1 },
        { label: "順番に処理", lineStart: 2, lineEnd: 3 },
        { label: "条件で分岐", lineStart: 4, lineEnd: 5 },
        { label: "結果を返す", lineStart: 6, lineEnd: 6 },
    ]);
    ok("単一の粗い関数ブロックをAST直下文の意味単位へ分ける");
}

// 9. 短い関数または既に複数ブロックならモデル結果を保つ
{
    const one = [blk("短い処理", 0, 3)];
    assert.strictEqual(splitSingleBlockByTopLevelStatements(one, [], 0, 3, ["def f():", "    return 1"]), one);
    const many = [blk("準備", 0, 2), blk("返却", 3, 5)];
    assert.strictEqual(splitSingleBlockByTopLevelStatements(many, [], 0, 5, []), many);
    ok("短い関数と既存の複数ブロックを変更しない");
}

// 10. 既定背景はLLM説明を持たず、同じAST境界を全行連続の座標だけとして返す
{
    const source = [
        "def calculate_total(prices, coupon=None):",
        "    subtotal = 0",
        "    for price in prices:",
        "        subtotal += price",
        "    if coupon == 'SAVE10':",
        "        subtotal *= 0.9",
        "    return round(subtotal)",
    ];
    const stmts = [
        { start: 0, end: 6 }, { start: 1, end: 1 },
        { start: 2, end: 3 }, { start: 3, end: 3 },
        { start: 4, end: 5 }, { start: 5, end: 5 }, { start: 6, end: 6 },
    ];
    assert.deepStrictEqual(buildDefaultMeaningRanges(stmts, 0, 6, source), [
        { lineStart: 0, lineEnd: 1 },
        { lineStart: 2, lineEnd: 3 },
        { lineStart: 4, lineEnd: 5 },
        { lineStart: 6, lineEnd: 6 },
    ]);
    assert.deepStrictEqual(buildDefaultMeaningRanges([], 0, 2, source), [
        { lineStart: 0, lineEnd: 2 },
    ]);
    ok("既定背景範囲を説明生成なしで全行連続に構築する");
}

console.log(`\n${passed}/10 passed`);
