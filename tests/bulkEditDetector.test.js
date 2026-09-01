// 単体テスト: accumulateBulkChange が一括変更(3行以上のchange)を正しく検知・蓄積することを確認する。
const assert = require("assert");
const { accumulateBulkChange, BULK_EDIT_MIN_LINES } = require("../out/inline/bulkEditDetector.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

assert.strictEqual(BULK_EDIT_MIN_LINES, 3, "閾値定数は3");
ok("BULK_EDIT_MIN_LINES: 3");

// 1. 3行未満のchangeのみ、prev=nullなら null を返す(未検知)
{
    const changes = [{ startLine: 5, text: "x = 1\ny = 2", rangeLineSpan: 1 }]; // 2行
    const r = accumulateBulkChange(null, changes, 100);
    assert.strictEqual(r, null, "2行のchangeは閾値未満のためnull");
    ok("accumulateBulkChange: 3行未満のchangeのみ→null(prev=null)");
}

// 2. 3行以上のchangeで検知され、行集合が正しい
{
    const changes = [{ startLine: 10, text: "a\nb\nc", rangeLineSpan: 1 }]; // 3行(10,11,12)
    const r = accumulateBulkChange(null, changes, 100);
    assert.notStrictEqual(r, null, "3行以上は検知される");
    assert.deepStrictEqual([...r.lines].sort((a, b) => a - b), [10, 11, 12], "行区間は10〜12");
    assert.strictEqual(r.wholeDoc, false, "3行/100行はwholeDocではない");
    ok("accumulateBulkChange: 3行以上のchangeを検知し行集合を返す");
}

// 3. 1文字タイプの連続(複数回呼び出し): prevがnullならnullのまま、prevがあれば維持される
{
    const typing = [{ startLine: 3, text: "x", rangeLineSpan: 1 }]; // 1行
    let state = null;
    state = accumulateBulkChange(state, typing, 100);
    assert.strictEqual(state, null, "1文字タイプはprev=nullのままnull");

    const bulk = [{ startLine: 0, text: "p\nq\nr", rangeLineSpan: 1 }];
    const afterBulk = accumulateBulkChange(null, bulk, 100);
    const afterTyping = accumulateBulkChange(afterBulk.lines, typing, 100);
    assert.deepStrictEqual(
        [...afterTyping.lines].sort((a, b) => a - b),
        [...afterBulk.lines].sort((a, b) => a - b),
        "1文字タイプは既存の検知済みlinesを変えず維持する"
    );
    ok("accumulateBulkChange: 1文字タイプの連続はprevを維持する(null維持/既存Set維持)");
}

// 4. 複数changeの和集合
{
    const changes = [
        { startLine: 0, text: "a\nb\nc", rangeLineSpan: 1 }, // 0,1,2
        { startLine: 20, text: "d\ne\nf\ng", rangeLineSpan: 1 }, // 20,21,22,23
    ];
    const r = accumulateBulkChange(null, changes, 100);
    assert.deepStrictEqual(
        [...r.lines].sort((a, b) => a - b),
        [0, 1, 2, 20, 21, 22, 23],
        "複数changeの行区間が和集合される"
    );
    ok("accumulateBulkChange: 複数changeの和集合");
}

// 5. 全文置換で wholeDoc=true、80%境界のケース
{
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const changes = [{ startLine: 0, text: lines, rangeLineSpan: 100 }]; // 100行
    const r = accumulateBulkChange(null, changes, 100);
    assert.strictEqual(r.wholeDoc, true, "100/100行は全文置換としてwholeDoc=true");
    ok("accumulateBulkChange: 全文置換でwholeDoc=true");

    // 80%ちょうど(80/100)は80%以上に含まれるためtrue
    const boundaryChanges = [{ startLine: 0, text: Array.from({ length: 80 }, (_, i) => `l${i}`).join("\n"), rangeLineSpan: 80 }];
    const boundary = accumulateBulkChange(null, boundaryChanges, 100);
    assert.strictEqual(boundary.lines.size, 80, "80行分検知される");
    assert.strictEqual(boundary.wholeDoc, true, "80/100=80%は境界含みでwholeDoc=true");
    ok("accumulateBulkChange: 80%境界でwholeDoc=true");

    // 79/100は80%未満でfalse
    const belowChanges = [{ startLine: 0, text: Array.from({ length: 79 }, (_, i) => `l${i}`).join("\n"), rangeLineSpan: 79 }];
    const below = accumulateBulkChange(null, belowChanges, 100);
    assert.strictEqual(below.wholeDoc, false, "79/100は80%未満でwholeDoc=false");
    ok("accumulateBulkChange: 80%未満はwholeDoc=false");
}

console.log(`\n${passed}/8 passed`);
process.exit(passed === 8 ? 0 : 1);
