const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "view", "mainViewProvider.ts"), "utf8");
let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

assert.ok(source.includes("#cmsgs .cmsg, #cmsgs .cmsg * { -webkit-user-select: text; user-select: text; }"));
ok("質問とAI返信の全要素を明示的に文字選択可能にする");

assert.ok(source.includes('class="cmsg-copy"'));
assert.ok(source.includes('class="cmsg-body"'));
assert.ok(source.includes("copyChatMessage(event,this)"));
ok("送信済みの質問とAI返信にコピーボタンを表示する");

assert.ok(source.includes('msg.type === "copyChatMessage"'));
assert.ok(source.includes("await vscode.env.clipboard.writeText(msg.text);"));
assert.ok(source.includes("text: body.innerText"));
ok("表示本文をVS CodeのクリップボードAPIへ渡してコピーする");

assert.ok(source.includes("function insertTextAtCaret(text)"));
assert.ok(source.includes("const node = document.createTextNode(text);"));
assert.ok(source.includes("range.insertNode(node);"));
ok("Webviewで通常テキストをRangeへ直接挿入する");

assert.ok(source.includes("cinput.addEventListener('paste', e => {"));
assert.ok(source.includes("insertTextAtCaret(txt);"));
assert.ok(!source.includes("document.execCommand('insertText', false, txt)"));
ok("通常の貼り付けで失敗するexecCommandを使わない");

assert.ok(source.includes("if (txt && quoteCand && txt.trim() === quoteCand.trim())"));
assert.ok(source.includes("vscode.postMessage({ type: 'quoteSelectionPasted' });"));
ok("エディタからコピーしたコードの引用チップ化を維持する");

assert.ok(source.includes("insertTextAtCaret('\\\\n');"));
assert.ok(!source.includes("document.execCommand('insertText', false, '\\\\n')"));
ok("Shift+Enterの改行も同じ安全な挿入処理を使う");

console.log(`\n${passed}/7 passed`);
