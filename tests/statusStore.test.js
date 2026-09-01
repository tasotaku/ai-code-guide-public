// 単体テスト: AnnotationStatusStore が id 単位の状態を get/set/永続化できることを確認する。
// vscode 非依存(storageDir 文字列を受ける)なのでそのまま node で実行できる。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AnnotationStatusStore } = require("../out/inline/annotationStatusStore.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acg-status-"));

// 1. 未設定は undefined（未読）
{
    const s = new AnnotationStatusStore(dir);
    assert.strictEqual(s.get("file://a.py", "id1"), undefined, "未設定は未読(undefined)");
    ok("未設定は undefined(未読)");
}

// 2. set した状態が get で返る
{
    const s = new AnnotationStatusStore(dir);
    s.set("file://a.py", "id1", "resolved");
    assert.strictEqual(s.get("file://a.py", "id1"), "resolved", "保存した状態が返る");
    ok("set した状態が get で返る");
}

// 3. ディスクに永続化され、別インスタンスでも読める
{
    const s2 = new AnnotationStatusStore(dir);
    assert.strictEqual(s2.get("file://a.py", "id1"), "resolved", "再構築後も状態が残る");
    ok("永続化: 別インスタンスでも読める");
}

// 4. null で未読へ戻す（削除）
{
    const s = new AnnotationStatusStore(dir);
    s.set("file://a.py", "id1", null);
    assert.strictEqual(s.get("file://a.py", "id1"), undefined, "null で未読に戻る");
    const s2 = new AnnotationStatusStore(dir);
    assert.strictEqual(s2.get("file://a.py", "id1"), undefined, "削除も永続化される");
    ok("null で未読へ戻し、削除も永続化");
}

// 5. uri で名前空間が分かれる（別ファイルの同一 id は混ざらない）
{
    const s = new AnnotationStatusStore(dir);
    s.set("file://a.py", "same", "read");
    s.set("file://b.py", "same", "later");
    assert.strictEqual(s.get("file://a.py", "same"), "read", "a.py は read");
    assert.strictEqual(s.get("file://b.py", "same"), "later", "b.py は later");
    ok("uri で名前空間が分かれる");
}

// 6. 上限(MAX_ENTRIES=5000)超過で最古が捨てられ、最近のものは残る(FIFO eviction)
{
    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), "acg-status-cap-"));
    const s = new AnnotationStatusStore(dir6);
    // 5001件入れると最古(id0)が1件押し出される
    for (let i = 0; i < 5001; i++) s.set("file://cap.py", `id${i}`, "read");
    assert.strictEqual(s.get("file://cap.py", "id0"), undefined, "最古(id0)は eviction で消える");
    assert.strictEqual(s.get("file://cap.py", "id5000"), "read", "最新(id5000)は残る");
    // 既存キーの再setは「最近使った」扱いで生き残る(delete→set し直すため)
    const s2 = new AnnotationStatusStore(dir6);
    s2.set("file://cap.py", "id1", "read"); // 触れて末尾へ寄せる
    s2.set("file://cap.py", "idNew", "read"); // 1件追加 → 最古(id2)が押し出される
    assert.strictEqual(s2.get("file://cap.py", "id1"), "read", "再set した id1 は生き残る");
    ok("上限超過で最古を捨て、最近のものは残る(FIFO)");
    fs.rmSync(dir6, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed}/6 passed`);
process.exit(passed === 6 ? 0 : 1);
