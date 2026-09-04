const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mergeChatLinkAnnotations, resolveAnnotations } = require("../out/api/annotationResolver.js");
const { ChatLinkStore } = require("../out/view/chatLinkStore.js");

const code = ["def binary_search(arr, target):", "    lo, hi = 0, len(arr) - 1", "    while lo <= hi:", "        mid = (lo + hi) // 2", "        if arr[mid] == target:", "            return mid", "    return -1"].join("\n");
const make = (line, token, label) => {
    const lineText = code.split("\n")[line];
    const item = resolveAnnotations([{ kind: "symbol", line, lineText, token, label, explanation: "説明" }], code)[0];
    assert.ok(item);
    return item;
};
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "chatlinks-"));
let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

{
    const store = new ChatLinkStore(tmpDir());
    const mid = make(3, "mid", "mid");
    store.add("file://x.py", mid, "sess-A");
    store.add("file://x.py", mid, "sess-B");
    store.add("file://x.py", mid, "sess-A");
    assert.deepStrictEqual(store.getForUri("file://x.py")[0].sessionIds, ["sess-A", "sess-B"]);
    ok("同じ名称は会話IDを重複なく追記する");
}
{
    const dir = tmpDir();
    const first = new ChatLinkStore(dir);
    first.add("file://x.py", make(3, "mid", "mid"), "sess-A");
    assert.strictEqual(new ChatLinkStore(dir).getForUri("file://x.py").length, 1);
    ok("名称リンクを再起動後も復元する");
}
{
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "chat-links.json"), JSON.stringify({ "file://x.py": [{ annotation: { kind: "block", id: "old" }, sessionIds: ["sess-A"] }] }));
    assert.deepStrictEqual(new ChatLinkStore(dir).getForUri("file://x.py"), []);
    ok("旧blockリンクを読込時に捨てる");
}
{
    const store = new ChatLinkStore(tmpDir());
    const mid = make(3, "mid", "mid");
    store.add("file://x.py", mid, "sess-A");
    store.update("file://x.py", mid.id, "更新", "更新説明");
    assert.strictEqual(store.getForUri("file://x.py")[0].annotation.label, "更新");
    store.removeSession("sess-A");
    assert.deepStrictEqual(store.getForUri("file://x.py"), []);
    ok("名称リンクを更新し会話削除時に掃除する");
}
{
    const llm = make(3, "mid", "LLM");
    llm.explanation = "元の説明";
    const chat = make(3, "mid", "chat");
    const merged = mergeChatLinkAnnotations([llm], [chat], () => "\n\n[会話へ](command:x)");
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].label, "LLM");
    assert.strictEqual(merged[0].explanation, "元の説明\n\n[会話へ](command:x)");
    ok("同じ名称のHoverへ会話リンクを追記する");
}
{
    const chat = make(4, "target", "target");
    const merged = mergeChatLinkAnnotations([], [chat], () => "\n\nJUMP");
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].explanation, "説明\n\nJUMP");
    ok("辞書にない名称もsymbol Hoverとして合流する");
}

console.log(`\n${passed} symbol-only chat-link tests passed`);
