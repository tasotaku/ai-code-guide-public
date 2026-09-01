const assert = require("assert");
const vm = require("vm");
const { buildDetailAppShell } = require("../out/mcp/detailApp.js");

const shell = buildDetailAppShell();
assert.ok(shell.includes('name:"show_standard_view"'));
assert.ok(shell.includes('data.overview'));
assert.ok(shell.includes('data.project'));
assert.ok(shell.includes('data.annotations'));
assert.ok(shell.includes('data.trace'));
assert.ok(shell.includes('guideWorkspaceRoot'));
assert.ok(shell.includes('VS Codeで見る'));
assert.ok(shell.includes('呼び出し関係'));
assert.ok(shell.includes('推奨する読む順'));
assert.ok(shell.includes('item.kind==="constant"?"定数"'));

class Classes {
    constructor() { this.values = new Set(); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
    toggle(value, enabled) { enabled ? this.add(value) : this.remove(value); }
}

class Element {
    constructor() { this.classList = new Classes(); this.children = []; this.textContent = ""; this.hidden = false; }
    addEventListener() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
}

function startApp() {
    const script = shell.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, "detail app script must exist");
    const elements = new Map(["status", "app", "view-state", "eyebrow", "title", "role", "content", "jump-status"].map((id) => [id, new Element()]));
    const body = new Element();
    const sent = [];
    let onMessage;
    const parent = { postMessage: (message) => sent.push(message) };
    const window = { parent, addEventListener: (_name, listener) => { onMessage = listener; } };
    const document = { body, createElement: () => new Element(), getElementById: (id) => elements.get(id) };
    vm.runInNewContext(script, { window, document, console, Error, Map, Set, Number, Array, Boolean, String });
    const notify = (data) => onMessage({ source: parent, data });
    notify({ jsonrpc: "2.0", id: sent[0].id, result: {} });
    return { body, elements, notify };
}

for (const [name, data] of [
    ["overview", { file: "main.py", overview: { title: "main.py", role: "値を返す。", relationships: [{ from: "main()", to: "helper()", line: 2 }], readingOrder: [{ label: "helper()", line: 4 }, { label: "main()", line: 1 }], groups: [{ label: "入口", items: [{ label: "main()", kind: "function", line: 1 }, { label: "SAMPLE", kind: "constant", line: 8 }] }] } }],
    ["project", { project: { files: [{ path: "main.py", directory: ".", functions: ["main"] }], imports: [], directories: [] } }],
    ["annotations", { file: "main.py", annotations: { items: [{ kind: "symbol", severity: "info", label: "値", explanation: "固定値。", startLine: 1, endLine: 1 }] } }],
    ["trace", { file: "main.py", trace: { funcNames: ["main"], loopCount: 0 } }],
]) {
    const app = startApp();
    const structuredContent = name === "overview" ? { ...data, viewState: { viewMode: "overview", resourceVersion: "0.27.21", stateReceiptId: "overview-1" } } : data;
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent, _meta: { guideWorkspaceRoot: "/workspace" } } });
    assert.strictEqual(app.body.classList.contains("ready"), true, `${name} renders`);
    assert.ok(app.elements.get("content").children.length > 0, `${name} has content`);
    if (name === "overview") assert.strictEqual(app.elements.get("view-state").textContent, "表示: overview · 0.27.21 · receipt overview-1");
}

console.log("会話内の概要・構成・インライン解説と旧トレースカード互換を含めて15件 passed");
