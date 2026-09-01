const assert = require("assert");
const vm = require("vm");
const { buildDiagramAppShell } = require("../out/mcp/diagramApp.js");

class Classes {
    constructor() { this.values = new Set(); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
    toggle(value, enabled) { enabled ? this.add(value) : this.remove(value); }
}

class Element {
    constructor(tagName = "") { this.tagName = tagName; this.classList = new Classes(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.textContent = ""; this.hidden = false; }
    set className(value) { this._className = value; value.split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name)); }
    get className() { return this._className || ""; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    dispatch(name, event) { return this.listeners.get(name)?.(event); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
}

function startApp() {
    const script = buildDiagramAppShell().match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, "diagram app script must exist");
    const elements = new Map(["status", "title", "summary", "diagram", "jump-status"].map((id) => [id, new Element()]));
    const body = new Element();
    const sent = [];
    const parent = { postMessage: (message) => sent.push(message) };
    let onMessage;
    const window = { parent, addEventListener: (name, listener) => { if (name === "message") onMessage = listener; } };
    const document = { body, createElement: (tagName) => new Element(tagName), createDocumentFragment: () => new Element(), getElementById: (id) => elements.get(id) };
    vm.runInNewContext(script, { window, document, console, Error, Map, Set, Number, Array, Boolean, String });
    const notify = (data) => onMessage({ source: parent, data });
    notify({ jsonrpc: "2.0", id: sent[0].id, result: {} });
    return { body, elements, sent, notify };
}

function findByClass(node, className, found = []) {
    if (node?.classList?.contains(className)) found.push(node);
    for (const child of node?.children ?? []) findByClass(child, className, found);
    return found;
}

{
    const app = startApp();
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { diagram: {
        kind: "flow", title: "注文の流れ", summary: "検査して保存する。",
        nodes: [{ id: "start", file: "web.py", symbol: "receive", label: "受付", description: "入力を受け取る。", line: 1 }, { id: "save", file: "repo.py", symbol: "save", label: "保存", description: "注文を保存する。", emphasis: "success", emphasisReason: "永続化が完了し、後続処理へ進める。", line: 8 }],
        edges: [{ from: "start", to: "save", label: "検査成功" }],
    } } } });
    assert.strictEqual(app.body.classList.contains("ready"), true);
    assert.strictEqual(findByClass(app.elements.get("diagram"), "pd-flow-node").length, 2);
    assert.strictEqual(findByClass(app.elements.get("diagram"), "pd-flow-link").length, 1);
    assert.strictEqual(findByClass(app.elements.get("diagram"), "pd-node-description").length, 2);
    assert.strictEqual(findByClass(app.elements.get("diagram"), "emphasis-success").length, 1);
    assert.strictEqual(findByClass(app.elements.get("diagram"), "pd-emphasis-badge")[0].textContent, "問題なさそう");
    assert.strictEqual(findByClass(app.elements.get("diagram"), "pd-emphasis-badge")[0].title, "AIがコード上の正常な完了経路と推定した箇所です。実行・テスト済みを意味しません。");
    assert.strictEqual(findByClass(app.elements.get("diagram"), "pd-emphasis-reason")[0].textContent, "AIの見立て: 永続化が完了し、後続処理へ進める。（実行・テスト未確認）");
    assert.strictEqual(findByClass(app.elements.get("diagram"), "root").length, 0);
    const node = findByClass(app.elements.get("diagram"), "pd-flow-node")[0];
    assert.strictEqual(node.tagName, "div");
    assert.strictEqual(node.attributes.has("role"), false);
    node.dispatch("click", {});
    assert.strictEqual(app.sent.filter((message) => message.method === "tools/call").length, 0);
    const open = findByClass(node, "pd-open")[0];
    open.dispatch("click", {});
    const calls = app.sent.filter((message) => message.method === "tools/call");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].params.arguments.line, 1, "public one-based node line must be forwarded without another offset");
}

async function serializedJumpRegression() {
    const app = startApp();
    const lines = [11, 13, 14, 15, 16, 17, 17];
    const nodes = lines.map((line, index) => ({
        id: `normalize-${index}`, file: "acceptance/beginner_journey.py",
        symbol: index === 1 ? "raw_value" : index === 2 ? "limit" : "normalize_score",
        label: `core ${index + 1}`, description: `source L${line}`, line,
    }));
    const edges = Array.from({ length: 6 }, (_, index) => ({ from: nodes[index].id, to: nodes[index + 1].id }));
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { diagram: { kind: "flow", nodes, edges } } } });
    const cards = findByClass(app.elements.get("diagram"), "pd-flow-node");
    assert.strictEqual(cards.length, 7, "all seven normalize CFG nodes render as cards");
    const controls = findByClass(app.elements.get("diagram"), "pd-open");
    assert.strictEqual(controls.length, 7, "every core node has an independent code-to control");
    const observed = [];
    for (let index = 0; index < controls.length; index += 1) {
        controls[index].dispatch("click", {});
        controls[(index + 1) % controls.length].dispatch("click", {});
        const calls = app.sent.filter((message) => message.method === "tools/call");
        assert.strictEqual(calls.length, index + 1, "a pending jump disables every other code button");
        const call = calls[index];
        observed.push(call.params.arguments.line);
        assert.ok(controls.every((control) => control.disabled), "all code buttons stay disabled before bridge acknowledgment");
        app.notify({ jsonrpc: "2.0", id: call.id, result: { structuredContent: { jumpReceipt: {
            receiptId: `receipt-${index + 1}`, acknowledged: true, file: "acceptance/beginner_journey.py",
            line: lines[index], selectionEmpty: true,
        } } } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(controls.every((control) => !control.disabled), "the next click is accepted only after exact-line acknowledgment");
        assert.ok(app.elements.get("jump-status").textContent.includes(`receipt-${index + 1}`), "App terminal shows the bridge receipt");
    }
    assert.deepStrictEqual(observed, lines, "all seven exact lines complete in order without rapid-click loss");
}

{
    const app = startApp();
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { diagram: {
        kind: "reading", nodes: [{ id: "one", file: "a.py", label: "入口", line: 0 }, { id: "two", file: "b.py", label: "詳細", line: 1 }], edges: [{ from: "one", to: "two", label: "" }],
    } } } });
    assert.strictEqual(findByClass(app.elements.get("diagram"), "pd-reading-number").length, 2);
}

serializedJumpRegression().then(() => {
    assert.ok(buildDiagramAppShell().includes("pd-flow-link::after"));
    assert.ok(buildDiagramAppShell().includes("pd-dependency-children"));
    assert.ok(buildDiagramAppShell().includes("cursor:text; -webkit-user-select:text; user-select:text;"));
    assert.ok(buildDiagramAppShell().includes("result?.structuredContent?.jumpReceipt"));
    assert.ok(!buildDiagramAppShell().includes(".pd-node:hover"));
    assert.ok(!buildDiagramAppShell().includes(".pd-node.root"));
    assert.ok(!buildDiagramAppShell().includes("pd-copy"));
    console.log("会話内コード図の通常文字選択・直列ack付きコード移動・意味ベース強調・矢印・ノード内説明・読解順を含めて13件 passed");
}).catch((error) => { console.error(error); process.exitCode = 1; });
