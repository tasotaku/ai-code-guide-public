const assert = require("assert");
const vm = require("vm");
const { buildCodeEvidenceAppShell } = require("../out/mcp/codeEvidenceApp.js");
const evidenceShell = buildCodeEvidenceAppShell();
for (const label of ["trace_entry_id", "run_receipt_id", "trace hash", "receipt hash", "呼び出し順（字下げとラベルは親子関係）"]) {
    assert.ok(!evidenceShell.includes(label), `trace card omits ${label}`);
}

class Classes {
    constructor() { this.values = new Set(); }
    add(value) { if (value) this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
    toggle(value, enabled) { enabled ? this.add(value) : this.remove(value); }
}

class Element {
    constructor(tag = "div", text = "") { this.tag = tag; this.textContent = text; this.children = []; this.classList = new Classes(); this.listeners = {}; this.parent = null; this.disabled = false; this.style = {}; }
    set className(value) { this.classList = new Classes(); String(value).split(/\s+/).forEach((name) => this.classList.add(name)); }
    get className() { return [...this.classList.values].join(" "); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    setAttribute(name, value) { this[name] = value; }
    click() { this.listeners.click?.(); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    replaceWith(next) { const index = this.parent.children.indexOf(this); this.parent.children.splice(index, 1, next); next.parent = this.parent; }
    querySelector(selector) { return find(this, selector); }
}

function find(node, selector) {
    const matches = selector.startsWith(".") ? node.classList.contains(selector.slice(1)) : selector.startsWith("#") ? node.id === selector.slice(1) : node.tag === selector;
    if (matches) return node;
    for (const child of node.children) { const match = find(child, selector); if (match) return match; }
    return null;
}

function all(node, selector, found = []) {
    const matches = selector.startsWith(".") ? node.classList.contains(selector.slice(1)) : node.tag === selector;
    if (matches) found.push(node);
    for (const child of node.children) all(child, selector, found);
    return found;
}

function text(node) { return node.textContent + node.children.map(text).join(""); }

function startApp() {
    const html = buildCodeEvidenceAppShell();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const elements = new Map(["status", "app", "title", "kind", "content", "jump-status"].map((id) => [id, new Element()]));
    elements.set("fullscreen", new Element("button", "横に広げる"));
    const body = new Element("body");
    let onMessage;
    const sent = [];
    const displayModes = [];
    const parent = { postMessage: (message) => sent.push(message) };
    const window = { parent, openai: { requestDisplayMode: async (request) => { displayModes.push(request); return request; } }, addEventListener: (_name, listener) => { onMessage = listener; } };
    const document = { body, createElement: (tag) => new Element(tag), createTextNode: (text) => new Element("#text", text), getElementById: (id) => elements.get(id) };
    vm.runInNewContext(script, { window, document, console, Error, Map, Set, Number, Array, Boolean, String, RegExp });
    const notify = (data) => onMessage({ source: parent, data });
    notify({ jsonrpc: "2.0", id: sent[0].id, result: {} });
    return { body, displayModes, elements, notify, sent };
}

{
    const html = buildCodeEvidenceAppShell();
    assert.match(html, /\.trace-grid \{ display:grid; grid-template-columns:minmax\(0,62%\) minmax\(0,38%\)/);
    assert.match(html, /\.trace-pane \{ min-width:0; overflow-x:auto; overflow-y:hidden;/);
    assert.match(html, /\.trace-note-pane \{[^}]*overflow-x:auto;/);
    assert.match(html, /\.trace-note-pane \{[^}]*z-index:1;[^}]*border-left:2px solid #555;[^}]*background:var\(--code\)/);
    assert.match(html, /\.trace-note-row \{[^}]*width:max-content; min-width:100%;[^}]*white-space:nowrap; overflow:visible;/);
    assert.match(html, /--editor-font:Consolas,"Courier New",monospace; --editor-font-size:14px; --editor-line-height:20px;/);
    assert.match(html, /--code:#1f1f1f; --editor-text:#d4d4d4; --editor-muted:#858585;/);
    assert.doesNotMatch(html, /prefers-color-scheme:light/);
    assert.match(html, /\.trace-row \{[^}]*min-height:var\(--editor-line-height\)/);
    assert.match(html, /\.loop \{[^}]*height:var\(--editor-line-height\);[^}]*white-space:nowrap;/);
    assert.match(html, /\.trace-code-row \.code \{[^}]*font:var\(--editor-font-size\)\/var\(--editor-line-height\) var\(--editor-font\)/);
    assert.match(html, /\.trace-note-row \{[^}]*font:var\(--editor-font-size\)\/var\(--editor-line-height\) var\(--editor-font\)/);
    assert.match(html, /\.loop \{[^}]*font:650 var\(--editor-font-size\)\/var\(--editor-line-height\) var\(--editor-font\)/);
    assert.doesNotMatch(html, /\.trace-code-row \.line/);
    assert.match(html, /code \{[^}]*padding:0 9px 0 0;/);
    assert.match(html, /const baseIndent=indents\.length\?Math\.min\(\.\.\.indents\):0/);
    assert.match(html, /codeRow\.append\(python\(line\.text\.slice\(baseIndent\)\)\)/);
    assert.doesNotMatch(html, /python\(line\.text\.trimStart\(\)\)/);
    assert.match(html, /\.code-grid \{ width:100%; overflow-x:auto; overflow-y:hidden;/);
    assert.match(html, /\.code-grid::-webkit-scrollbar \{ height:10px;/);
    assert.match(html, /\.code-row \{ display:grid; grid-template-columns:38px minmax\(720px,1fr\) minmax\(240px,38%\); width:max-content; min-width:100%;/);
    assert.doesNotMatch(html, /\.code \{[^}]*overflow-x:auto/);
}

{
    const app = startApp();
    const attempt = { traceEntryId: "entry-1", runReceiptId: "receipt-1", target: "journey.py::unknown_dispatch", arguments: { value: 7 }, safetyDecision: "safety-unknown", safetyReason: "dynamic globals dispatch", retryGuidance: "Keep this trace entry open and choose a reviewed safe target.", states: ["safety_unknown", "rejected"], invocationCount: 0, sourceSha256: "source-hash", artifactSha256: "artifact-hash" };
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { file: "journey.py", trace: { traceEntryId: "entry-1", entryState: "open", attempts: [attempt], functions: [] } } } });
    const rendered = text(app.elements.get("content"));
    assert.strictEqual(rendered, "実行トレースはありません。");
}

assert.match(evidenceShell, /\.open \{[^}]*min-width:88px; min-height:36px;/);
assert.ok(evidenceShell.includes("result?.structuredContent?.jumpReceipt"));

{
    const app = startApp();
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { file: "order.py", annotations: { items: [{ kind: "symbol", severity: "info", label: "既定値", explanation: "空配列にする。", startLine: 3, endLine: 3, code: [{ line: 1, text: "@dataclass" }, { line: 2, text: "class Order:" }, { line: 3, text: "    def load(self, payload: dict):" }, { line: 4, text: "        return payload.get('items', [])" }] }] } } } });
    assert.strictEqual(app.body.classList.contains("ready"), true);
    assert.ok(all(app.elements.get("content"), ".token-keyword").length >= 2);
    assert.ok(all(app.elements.get("content"), ".token-decorator").length >= 1);
    assert.ok(all(app.elements.get("content"), ".token-type").length >= 2);
    assert.ok(all(app.elements.get("content"), ".token-name").length >= 1);
    assert.strictEqual(all(app.elements.get("content"), ".target").length, 1);
}

{
    const app = startApp();
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { file: "order.py", trace: { functions: [{ funcName: "Order.total", runId: "run-123", executedAt: "2026-08-12T00:00:00Z", arguments: { items: [120, 80] }, returnValue: { short: "200", full: "{\"total\":200,\"complete\":true}" }, calls: [{ depth: 0, function: "Order.total", arguments: { items: { short: "[120,...]", full: "[120,80]" }, ".0": { short: "iterator", full: "<list_iterator object at 0x1234ABCD>" } }, return_value: { short: "200", full: "{\"total\":200,\"complete\":true}" } }], startLine: 1, endLine: 3, code: [{ line: 1, text: "    def total(self, items):" }, { line: 2, text: "        for item in items:" }, { line: 3, text: "            total += item" }], loop: { headerLine: 2, total: 2, actualTotal: 2 }, iterations: [{ number: 1, values: [{ line: 2, text: "item=120" }, { line: 3, text: "total=120" }] }, { number: 2, values: [{ line: 2, text: "item=80" }, { line: 3, text: "total=200" }] }], executedLines: [1, 2, 3], controlPoints: [{ line: 2 }], pathEvents: [{ line: 2, outcome: true }] }] } } } });
    const next = all(app.elements.get("content"), "button").find((button) => button.textContent === "▶");
    assert.ok(next && !next.disabled, text(app.elements.get("status")));
    const loopNote = all(app.elements.get("content"), ".loop")[0].parent;
    assert.strictEqual(all(loopNote, "br").length, 0, "loop controls and values stay on one visual line");
    next.click();
    assert.strictEqual(all(app.elements.get("content"), ".trace-evidence").length, 1);
    assert.strictEqual(all(app.elements.get("content"), ".trace-pane").length, 2, "code and trace use separate scroll panes");
    assert.strictEqual(all(app.elements.get("content"), ".trace-code-row").length, 3);
    assert.strictEqual(all(app.elements.get("content"), ".trace-note-row").length, 3);
    assert.strictEqual(all(app.elements.get("content"), ".trace-code-row").every((row) => all(row, ".line").length === 0), true, "trace rows omit line numbers");
    assert.deepStrictEqual(all(app.elements.get("content"), ".trace-code-row").map((row) => text(row)), ["def total(self, items):", "    for item in items:", "        total += item"], "trace card removes the class-level common indent while preserving relative Python indentation");
    assert.ok(all(app.elements.get("content"), ".value").some((value) => value.textContent === "total=200"));
    assert.strictEqual(all(app.elements.get("content"), ".target").length, 0, "loop selector does not highlight the whole row");
    const rendered = text(app.elements.get("content"));
    assert.ok(rendered.includes("条件: true"), "branch outcome remains visible");
    assert.ok(!rendered.includes("到達") && !rendered.includes("未到達"), "arrival labels are omitted");
    for (const hidden of ["run-123", "[120,80]", "{\"total\":200,\"complete\":true}", "呼び出し順", "反復対象（内部イテレータ）", "trace_entry_id", "run_receipt_id"]) {
        assert.ok(!rendered.includes(hidden), `trace card omits ${hidden}`);
    }
    const openButton = all(app.elements.get("content"), "button").find((button) => button.textContent === "コードへ");
    assert.ok(openButton, "trace card exposes the visible コードへ button");
    assert.strictEqual(openButton.role, "button");
    assert.strictEqual(openButton.tabIndex, 0);
    assert.strictEqual(openButton["aria-label"], "Order.total() のコードへ移動");
    assert.ok(openButton.title.includes("VS Code"));
    openButton.click();
    const jumpCall = app.sent.at(-1);
    assert.strictEqual(jumpCall.params.name, "show_standard_view");
    app.notify({ jsonrpc: "2.0", id: jumpCall.id, result: { structuredContent: { jumpReceipt: { receiptId: "jump-1", acknowledged: true, line: 1, selectionEmpty: true } } } });
    app.elements.get("fullscreen").click();
    assert.strictEqual(app.displayModes.length, 1);
    assert.strictEqual(app.displayModes[0].mode, "fullscreen");
}

{
    const app = startApp();
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { file: "top_level.py", trace: { functions: [{ funcName: "main", startLine: 1, endLine: 3, code: [{ line: 1, text: "def main():" }, { line: 2, text: "    return 1" }, { line: 3, text: "" }], iterations: [{ number: 1, values: [] }], executedLines: [1, 2], controlPoints: [], pathEvents: [] }] } } } });
    assert.deepStrictEqual(all(app.elements.get("content"), ".trace-code-row").map((row) => text(row)), ["def main():", "    return 1", ""], "top-level functions keep their existing relative indentation and blank lines do not alter the baseline");
}

console.log("会話内の色付きコード・左右独立スクロール・トレース専用表示・横幅拡大・周回切替・共通インデント除去を含めて18件 passed");
