// 単体テスト: parseChangedLines が unified diff から「新側の変更行(0-based)」を正しく拾うことを確認する。
const assert = require("assert");
const { parseChangedLines } = require("../out/util/gitDiff.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

// 1. 追加2行＋置換1行のdiff(-U0想定)
{
    const diff = [
        "diff --git a/f.py b/f.py",
        "index 1111111..2222222 100644",
        "--- a/f.py",
        "+++ b/f.py",
        "@@ -3,0 +4,2 @@ def foo():",
        "+    x = 1",
        "+    y = 2",
        "@@ -10 +12 @@",
        "-    old line",
        "+    new line",
    ].join("\n");
    const r = parseChangedLines(diff);
    assert.deepStrictEqual([...r].sort((a, b) => a - b), [3, 4, 11], "新側0-basedで {3,4,11}");
    ok("parseChangedLines: 追加2行＋置換1行を新側座標で拾う");
}

// 2. 純粋な削除(新側に追加行なし)は変更行を増やさない
{
    const diff = [
        "--- a/f.py",
        "+++ b/f.py",
        "@@ -5,2 +4,0 @@",
        "-    gone1",
        "-    gone2",
    ].join("\n");
    const r = parseChangedLines(diff);
    assert.strictEqual(r.size, 0, "削除のみは新側変更行ゼロ");
    ok("parseChangedLines: 削除のみは変更行を増やさない");
}

// 3. 空diff(変更なし)は空集合
{
    assert.strictEqual(parseChangedLines("").size, 0, "空は空");
    ok("parseChangedLines: 空diffは空集合");
}

console.log(`\n${passed}/3 passed`);
process.exit(passed === 3 ? 0 : 1);
