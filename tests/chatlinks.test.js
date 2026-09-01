// 単体テスト: chatLinks の永続レイヤーと buildLineAnnotation の同定ロジックを検証する。
// 実行: npm test （内部で npm run compile → node tests/chatlinks.test.js）
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildLineAnnotation, stableId, resolveAnnotations, reanchorAnnotations, mergeChatLinkAnnotations } = require("../out/api/annotationResolver.js");
const { ChatLinkStore } = require("../out/view/chatLinkStore.js");

const code = [
    "def binary_search(arr, target):", // 0
    "    lo, hi = 0, len(arr) - 1",    // 1
    "    while lo <= hi:",             // 2
    "        mid = (lo + hi) // 2",    // 3
    "        if arr[mid] == target:",  // 4
    "            return mid",          // 5
    "    return -1",                   // 6
].join("\n");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

// 1. buildLineAnnotation: 単行 → symbol(行全体・トークン無し)
{
    const a = buildLineAnnotation(code, 3, 3, "mid の計算");
    assert.strictEqual(a.kind, "symbol");
    assert.strictEqual(a.anchorText, "        mid = (lo + hi) // 2");
    assert.strictEqual(a.anchorToken, undefined);
    assert.strictEqual(a.startLine, 3);
    assert.strictEqual(a.startCol, 8);      // インデント除いた開始列
    assert.strictEqual(a.label, "mid の計算");
    ok("buildLineAnnotation: 単行=symbol・行全体下線");
}

// 2. buildLineAnnotation: 複数行 → block(先頭/末尾アンカー)
{
    const a = buildLineAnnotation(code, 2, 5, "ループ本体");
    assert.strictEqual(a.kind, "block");
    assert.strictEqual(a.anchorText, "    while lo <= hi:");
    assert.strictEqual(a.anchorEndText, "            return mid");
    assert.deepStrictEqual([a.startLine, a.endLine], [2, 5]);
    ok("buildLineAnnotation: 複数行=block・先頭/末尾アンカー");
}

// 3. 空行・範囲外・逆転は null
{
    const empty = "a\n\nb";
    assert.strictEqual(buildLineAnnotation(empty, 1, 1, "x"), null); // 空行
    assert.strictEqual(buildLineAnnotation(code, 0, 99, "x"), null); // 範囲外
    assert.strictEqual(buildLineAnnotation(code, 5, 2, "x"), null);  // 逆転
    ok("buildLineAnnotation: 空行/範囲外/逆転は null");
}

// 4. id は resolveAnnotations と同一(同じ場所のLLM注釈とマージできる前提)
{
    const built = buildLineAnnotation(code, 3, 3, "any label");
    const resolved = resolveAnnotations([
        { kind: "symbol", line: 3, lineText: "        mid = (lo + hi) // 2", explanation: "計算" },
    ], code);
    // resolver 側はトークン未指定→行全体fallback(anchorToken undefined)。よって id が一致する。
    assert.strictEqual(built.id, resolved[0].id);
    ok("id: 同じ場所なら resolveAnnotations と一致");
}

// 5. buildLineAnnotation の id は stableId と整合
{
    const a = buildLineAnnotation(code, 2, 5, "L");
    const ctx = `${"    lo, hi = 0, len(arr) - 1"}\n${"    return -1"}`;
    assert.strictEqual(a.id, stableId("block", "    while lo <= hi:", "            return mid", ctx));
    ok("id: stableId(block, start, end, ctx) と整合");
}

// 6. reanchor で無関係編集をまたいで生存(先頭に import 行を挿入)
{
    const a = buildLineAnnotation(code, 3, 3, "L");
    const shifted = "import sys\n" + code; // 全行が1つ下へ
    const r = reanchorAnnotations([a], shifted);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].startLine, 4); // 3 → 4 に追従
    assert.strictEqual(r[0].id, a.id);     // id は不変
    ok("reanchor: 無関係編集で座標追従・id不変");
}

// 7. アンカーが消えたら reanchor で落ちる
{
    const a = buildLineAnnotation(code, 3, 3, "L");
    const removed = code.replace("        mid = (lo + hi) // 2", "        mid = lo + (hi - lo) // 2");
    const r = reanchorAnnotations([a], removed);
    assert.strictEqual(r.length, 0);
    ok("reanchor: アンカー行が変わると落ちる");
}

// ---- ChatLinkStore（永続・append・dedup・roundtrip）----
function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "chatlinks-"));
}

// 8. add: 別idは別リンク、同idは sessionId を追記(上書きしない)
{
    const dir = tmpDir();
    const store = new ChatLinkStore(dir);
    const a1 = buildLineAnnotation(code, 3, 3, "mid");
    const a2 = buildLineAnnotation(code, 2, 5, "loop");
    store.add("file://x.py", a1, "sess-A");
    store.add("file://x.py", a2, "sess-B");
    store.add("file://x.py", a1, "sess-C"); // 同じ場所(a1と同id)→追記
    const list = store.getForUri("file://x.py");
    assert.strictEqual(list.length, 2); // a1, a2 の2リンク
    const link1 = list.find((l) => l.annotation.id === a1.id);
    assert.deepStrictEqual(link1.sessionIds, ["sess-A", "sess-C"]); // 追記されている
    ok("store.add: 同idは追記・別idは新規");
}

// 9. add: 同一 sessionId の重複は弾く
{
    const dir = tmpDir();
    const store = new ChatLinkStore(dir);
    const a1 = buildLineAnnotation(code, 3, 3, "mid");
    store.add("file://x.py", a1, "sess-A");
    store.add("file://x.py", a1, "sess-A"); // 重複
    const list = store.getForUri("file://x.py");
    assert.deepStrictEqual(list[0].sessionIds, ["sess-A"]);
    ok("store.add: 同一sessionIdは重複追記しない");
}

// 10. roundtrip: 別インスタンスでディスクから復元される(再オープン相当)
{
    const dir = tmpDir();
    const s1 = new ChatLinkStore(dir);
    const a1 = buildLineAnnotation(code, 3, 3, "mid");
    s1.add("file://x.py", a1, "sess-A");
    const s2 = new ChatLinkStore(dir); // 同じ場所を新規ロード
    const list = s2.getForUri("file://x.py");
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].annotation.id, a1.id);
    assert.deepStrictEqual(list[0].sessionIds, ["sess-A"]);
    ok("store: ディスク永続→別インスタンスで復元(再オープン相当)");
}

// 11. removeSession: 会話削除で該当sessionIdを外し、空リンクは落とす
{
    const dir = tmpDir();
    const store = new ChatLinkStore(dir);
    const a1 = buildLineAnnotation(code, 3, 3, "mid");
    const a2 = buildLineAnnotation(code, 2, 5, "loop");
    store.add("file://x.py", a1, "sess-A");
    store.add("file://x.py", a1, "sess-B");
    store.add("file://x.py", a2, "sess-A");
    store.removeSession("sess-A");
    const list = store.getForUri("file://x.py");
    const link1 = list.find((l) => l.annotation.id === a1.id);
    assert.deepStrictEqual(link1.sessionIds, ["sess-B"]); // A が外れる
    assert.strictEqual(list.find((l) => l.annotation.id === a2.id), undefined); // 空になり落ちる
    ok("store.removeSession: sessionId除去・空リンク削除");
}

// 12. getForUri: 未知uriは空配列
{
    const dir = tmpDir();
    const store = new ChatLinkStore(dir);
    assert.deepStrictEqual(store.getForUri("file://none.py"), []);
    ok("store.getForUri: 未知uriは空配列");
}

// ---- mergeChatLinkAnnotations（追記 vs 合成の純粋ロジック）----

// 13. merge: id一致のLLM注釈へ追記(合成しない・label保持・原本不変)
{
    const llmAnn = buildLineAnnotation(code, 3, 3, "LLMの見出し");
    llmAnn.explanation = "元の説明";
    const chatLink = buildLineAnnotation(code, 3, 3, "chatの見出し"); // 同じ場所→同id
    assert.strictEqual(llmAnn.id, chatLink.id);
    const jump = "\n\n[💬 会話へ](command:x)";
    const merged = mergeChatLinkAnnotations([llmAnn], [chatLink], (id) => (id === chatLink.id ? jump : undefined));
    assert.strictEqual(merged.length, 1);                       // 合成されない
    assert.strictEqual(merged[0].explanation, "元の説明" + jump); // 追記
    assert.strictEqual(merged[0].label, "LLMの見出し");          // labelは壊さない
    assert.strictEqual(llmAnn.explanation, "元の説明");          // 原本を汚さない(clone)
    ok("merge: id一致は追記・label保持・原本不変");
}

// 14. merge: id不一致は合成注釈として追加(先頭の空行を除去)
{
    const llmAnn = buildLineAnnotation(code, 1, 1, "LLM");
    const chatLink = buildLineAnnotation(code, 4, 4, "chatの見出し"); // 別の場所→別id
    const jump = "\n\n[💬 会話へ](command:y)";
    const merged = mergeChatLinkAnnotations([llmAnn], [chatLink], (id) => (id === chatLink.id ? jump : undefined));
    assert.strictEqual(merged.length, 2);
    const synth = merged.find((a) => a.id === chatLink.id);
    assert.strictEqual(synth.label, "chatの見出し");
    assert.strictEqual(synth.explanation, "[💬 会話へ](command:y)"); // 先頭の\n\n除去
    ok("merge: id不一致は合成追加・先頭空行除去");
}

// 15. merge: LLM側explanationが空なら追記でも先頭空行を除去
{
    const llmAnn = buildLineAnnotation(code, 3, 3, "L"); // explanation ""
    const merged = mergeChatLinkAnnotations([llmAnn], [buildLineAnnotation(code, 3, 3, "c")], () => "\n\nJUMP");
    assert.strictEqual(merged[0].explanation, "JUMP");
    ok("merge: LLM explanation空なら追記も先頭空行除去");
}

// 16. merge: 合成注釈は結論(explanation)を保持し、その下にジャンプを足す
{
    const chatLink = buildLineAnnotation(code, 4, 4, "見出し");
    chatLink.explanation = "この行で配列長を比較している"; // 会話の結論
    const merged = mergeChatLinkAnnotations([], [chatLink], () => "\n\nJUMP");
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].explanation, "この行で配列長を比較している\n\nJUMP"); // 結論＋ジャンプ
    ok("merge: 合成注釈は結論を保持しジャンプを追記");
}

// 17. store.getLinksForSession: sessionを含むリンクをuri付きで返す
{
    const dir = tmpDir();
    const store = new ChatLinkStore(dir);
    const a1 = buildLineAnnotation(code, 3, 3, "mid");
    const a2 = buildLineAnnotation(code, 2, 5, "loop");
    store.add("file://x.py", a1, "sess-A");
    store.add("file://y.py", a2, "sess-A");
    store.add("file://x.py", buildLineAnnotation(code, 6, 6, "other"), "sess-B");
    const links = store.getLinksForSession("sess-A");
    assert.strictEqual(links.length, 2);
    assert.deepStrictEqual(links.map((l) => l.uri).sort(), ["file://x.py", "file://y.py"]);
    ok("store.getLinksForSession: 該当セッションのリンクをuri付きで返す");
}

// 18. store.update: label/explanationを最新へ差し替え(id=場所は不変)
{
    const dir = tmpDir();
    const store = new ChatLinkStore(dir);
    const a1 = buildLineAnnotation(code, 3, 3, "初期見出し");
    a1.explanation = "初期の結論";
    store.add("file://x.py", a1, "sess-A");
    store.update("file://x.py", a1.id, "更新後の見出し", "更新後の結論");
    const link = store.getForUri("file://x.py")[0];
    assert.strictEqual(link.annotation.label, "更新後の見出し");
    assert.strictEqual(link.annotation.explanation, "更新後の結論");
    assert.strictEqual(link.annotation.id, a1.id); // idは不変
    // 永続もされる(再ロードで残る)
    const reloaded = new ChatLinkStore(dir).getForUri("file://x.py")[0];
    assert.strictEqual(reloaded.annotation.label, "更新後の見出し");
    ok("store.update: label/explanation差し替え・id不変・永続");
}

console.log(`\n${passed} tests passed`);
