const assert = require("assert");
const vm = require("vm");
const { buildStandardAppShell } = require("../out/mcp/standardApp.js");
const { focusStandardView } = require("../out/view/standardFocus.js");

class Classes {
    constructor() { this.values = new Set(); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
    toggle(value, enabled) { enabled ? this.add(value) : this.remove(value); }
}

class Element {
    constructor() {
        this.classList = new Classes();
        this.textContent = "";
        this.children = [];
        this.disabled = false;
    }
    addEventListener() {}
    setAttribute(name, value) { this[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
}

function startApp() {
    const html = buildStandardAppShell();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, "standard app script must exist");
    const elements = new Map([
        ["status", new Element()],
        ["app", new Element()],
        ["title", new Element()],
        ["summary", new Element()],
        ["open-standard", new Element()],
        ["source", new Element()],
        ["guide", new Element()],
        ["jump-status", new Element()],
        ["view-state", new Element()],
    ]);
    elements.get("status").textContent = "コード構造を読み込んでいます…";
    const body = new Element();
    let onMessage;
    const sent = [];
    const parent = { postMessage: (message) => sent.push(message) };
    const window = {
        parent,
        addEventListener: (name, listener) => {
            if (name === "message") onMessage = listener;
        },
    };
    const document = {
        body,
        createElement: () => new Element(),
        createTextNode: (text) => ({ textContent: text }),
        getElementById: (id) => elements.get(id),
    };
    vm.runInNewContext(script, { window, document, console, Error, Map, Number, Array, Boolean, String });
    const notify = (data) => onMessage({ source: parent, data });
    notify({ jsonrpc: "2.0", id: sent[0].id, result: {} });
    return { body, elements, notify, sent };
}

const outsideError = "The file must be inside the active AI Code Guide workspace.";

{
    const app = startApp();
    app.notify({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { isError: true, content: [{ type: "text", text: outsideError }] },
    });
    assert.strictEqual(app.elements.get("status").textContent, outsideError);
    assert.strictEqual(app.body.classList.contains("error"), true);
    assert.strictEqual(app.body.classList.contains("ready"), false);
}

{
    const app = startApp();
    app.notify({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
            structuredContent: { viewState: { viewMode: "standard", resourceVersion: "0.27.21", stateReceiptId: "standard-1" },
                standard: {
                    file: "main.py",
                    source: [
                        { line: 1, text: "class Runner:" },
                        { line: 2, text: "    return self.run(str(42)) # result" },
                    ],
                    items: [
                        { id: "runner", kind: "class", label: "Runner", line: 1, lineEnd: 7, color: "#4fc1ff" },
                        { id: "run", kind: "function", parent: "runner", label: "run()", line: 2, lineEnd: 4, color: "#4fc1ff" },
                        { id: "main", kind: "function", label: "main()", line: 8, lineEnd: 11, color: "#f48771" },
                        { id: "sample", kind: "constant", label: "SAMPLE_ARGS", line: 12, lineEnd: 12 },
                    ],
                },
            },
            _meta: { standardWorkspaceRoot: "/workspace" },
        },
    });
    assert.strictEqual(app.body.classList.contains("ready"), true);
    assert.strictEqual(app.elements.get("view-state").textContent, "表示: standard · 0.27.21 · receipt standard-1");
    assert.strictEqual(app.body.classList.contains("error"), false);
    assert.strictEqual(app.elements.get("summary").textContent, "意味単位を色で対応づけています。クラス1件、関数・メソッド2件、定数1件。");
    const sourceRows = app.elements.get("source").children;
    assert.strictEqual(sourceRows.length, 2);
    assert.strictEqual(sourceRows[0].children[0].textContent, "1");
    assert.strictEqual(sourceRows[0].children[1].children[0].className, "token-keyword");
    assert.strictEqual(sourceRows[0].children[1].children.some((child) => child.className === "token-type"), true);
    assert.strictEqual(sourceRows[1].children[1].children.some((child) => child.className === "token-name"), true);
    assert.strictEqual(sourceRows[1].children[1].children.filter((child) => child.className === "token-function").length, 1);
    assert.strictEqual(sourceRows[1].children[1].children.filter((child) => child.className === "token-type").length, 1);
    assert.strictEqual(sourceRows[1].children[1].children.some((child) => child.className === "token-number"), true);
    assert.strictEqual(sourceRows[1].children[1].children.some((child) => child.className === "token-comment"), true);
    assert.ok(sourceRows[0].className.includes("in-unit"));
    const rows = app.elements.get("guide").children.slice(2);
    assert.strictEqual(rows.length, 4);
    assert.deepStrictEqual(rows.map((row) => row.children[0].textContent), ["class", "method", "function", "constant"]);
    assert.strictEqual(rows[0].children[2].textContent, "詳しく読む");
    assert.strictEqual(rows[1].children[1].children[0].textContent, "run()");
    assert.strictEqual(rows[1].children[1].children[1].textContent, "L2–4");
    assert.ok(rows[1].className.includes("child"));
    app.elements.get("open-standard").onclick({ currentTarget: app.elements.get("open-standard") });
    const call = app.sent.at(-1);
    assert.strictEqual(call.method, "tools/call");
    assert.strictEqual(call.params.name, "show_standard_view");
    assert.strictEqual(JSON.stringify(call.params.arguments), JSON.stringify({ file: "/workspace/main.py", focusWindow: true }));
    rows[1].children[2].onclick();
    const expandCall = app.sent.at(-1);
    assert.strictEqual(expandCall.method, "tools/call");
    assert.strictEqual(expandCall.params.name, "expand_standard_items");
    assert.strictEqual(JSON.stringify(expandCall.params.arguments), JSON.stringify({ file: "/workspace/main.py", lines: [2], line: 2, activate: false }));
}

{
    const app = startApp();
    app.notify({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: { viewState: { viewMode: "standard", resourceVersion: "0.27.21", stateReceiptId: "standard-empty" }, standard: { file: "empty.py", source: [], items: [] } } },
    });
    assert.strictEqual(app.elements.get("summary").textContent, "意味単位を色で対応づけています。クラス0件、関数・メソッド0件、定数0件。");
    assert.strictEqual(app.elements.get("guide").children[2].textContent, "関数やクラスは見つかりませんでした。");
}

{
    const app = startApp();
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} });
    assert.strictEqual(app.elements.get("status").textContent, "標準ビューの状態確認を受け取れませんでした。");
    assert.strictEqual(app.body.classList.contains("error"), true);
}

assert.ok(buildStandardAppShell().includes("VS Codeで標準ビューを開く"));
assert.ok(buildStandardAppShell().includes("grid-template-columns: minmax(0, 1.45fr) minmax(260px, .9fr)"));
assert.ok(buildStandardAppShell().includes("max-height: 620px"));
assert.ok(buildStandardAppShell().includes("overflow: auto"));
assert.ok(buildStandardAppShell().includes("scrollbar-gutter: stable both-edges"));
assert.ok(buildStandardAppShell().includes('.source::-webkit-scrollbar, .guide::-webkit-scrollbar { width: 13px; height: 14px; }'));
assert.ok(buildStandardAppShell().includes('.source::-webkit-scrollbar-thumb, .guide::-webkit-scrollbar-thumb { min-width: 44px;'));
assert.ok(buildStandardAppShell().includes("width: max-content; min-width: 100%"));
assert.ok(buildStandardAppShell().includes('tabindex="0" role="region"'));
assert.ok(buildStandardAppShell().includes("token-keyword"));
assert.ok(buildStandardAppShell().includes('aria-label="意味単位で色分けしたPythonコード全文"'));
{
    const app = startApp();
    const source = Array.from({ length: 80 }, (_, index) => ({ line: index + 1, text: index === 0 ? '"""full file docstring"""' : index === 10 ? "def normalize_score(raw, max_score):" : `    value_${index + 1} = ${index + 1}` }));
    const items = Array.from({ length: 10 }, (_, index) => ({ kind: index > 7 ? "constant" : "function", label: `item_${index + 1}`, line: index * 7 + 1 }));
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { viewState: { viewMode: "standard", resourceVersion: "0.27.21", stateReceiptId: "standard-beginner" }, standard: { file: "beginner_journey.py", source, items } } } });
    assert.strictEqual(app.elements.get("source").children.length, 80);
    assert.strictEqual(app.elements.get("guide").children.length, 12);
    const visibleText = (node) => [node.textContent, ...(node.children || []).flatMap(visibleText)].join("");
    assert.ok(visibleText(app.elements.get("source").children[0]).includes("full file docstring"));
    assert.ok(visibleText(app.elements.get("source").children[10]).includes("def normalize_score"));
}
assert.ok(buildStandardAppShell().includes("詳しく読む"));
assert.ok(buildStandardAppShell().includes('name: "expand_standard_items"'));
assert.ok(buildStandardAppShell().includes("目的・入出力・処理ブロック"));
assert.ok(buildStandardAppShell().includes("source.scrollLeft = left"));

{
    const expansion = { overview: { purpose: "説明" }, blocks: [] };
    const focused = focusStandardView({
        title: "test_ingestion.py",
        file: "tests/test_ingestion.py",
        source: Array.from({ length: 94 }, (_, index) => ({ line: index + 1, text: `line ${index + 1}` })),
        items: [
            { id: "helper", kind: "class", label: "class Helper", line: 8, lineEnd: 19 },
            { id: "tests", kind: "class", label: "class DocumentIngestionServiceTests", line: 40, lineEnd: 90 },
            { id: "safe", parent: "tests", kind: "function", label: "test_safe()", line: 44, lineEnd: 57, expanded: true, expansion },
            { id: "scanner", parent: "tests", kind: "function", label: "test_scanner_error()", line: 73, lineEnd: 90, expanded: true, expansion },
        ],
    }, 40, [73]);
    assert.strictEqual(focused.title, "DocumentIngestionServiceTests · test_ingestion.py");
    assert.strictEqual(focused.role, "L40–90 の定義だけを表示");
    assert.deepStrictEqual(focused.source.map((entry) => entry.line), Array.from({ length: 51 }, (_, index) => index + 40));
    assert.deepStrictEqual(focused.items.map((item) => item.id), ["tests", "safe", "scanner"]);
    assert.strictEqual(focused.items.find((item) => item.id === "safe").expansion, undefined);
    assert.strictEqual(focused.items.find((item) => item.id === "scanner").expansion, expansion);
    assert.throws(() => focusStandardView(focused, 999), /Standard scope not found/);
}

{
    const app = startApp();
    app.notify({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
            structuredContent: {
                viewState: { viewMode: "standard", resourceVersion: "0.27.24", stateReceiptId: "standard-expanded" },
                standard: {
                    file: "main.py",
                    source: [
                        { line: 1, text: "def calculate(value):" },
                        { line: 2, text: "    checked = max(value, 0)" },
                        { line: 3, text: "    return checked * 2" },
                    ],
                    items: [{
                        id: "calculate", kind: "function", label: "calculate(value)", line: 1, lineEnd: 3, color: "#4fc1ff", expanded: true,
                        expansion: {
                            overview: { purpose: "安全な値を2倍する。", input: "数値を受け取る。", output: "0以上の2倍値を返す。" },
                            blocks: [
                                { label: "入力を補正", lineStart: 1, lineEnd: 2, description: "負数を0へ補正する。" },
                                { label: "結果を返す", lineStart: 3, lineEnd: 3, description: "補正値を2倍して返す。" },
                            ],
                        },
                    }],
                },
            },
        },
    });
    const guideText = (node) => [node.textContent, ...(node.children || []).flatMap(guideText)].join(" ");
    const visible = guideText(app.elements.get("guide"));
    assert.ok(visible.includes("calculate(value)"), "a pre-expanded requested function is selected on first render");
    assert.ok(visible.includes("目的"));
    assert.ok(visible.includes("安全な値を2倍する。"));
    assert.ok(visible.includes("入力を補正"));
    assert.ok(visible.includes("結果を返す"));
    assert.ok(app.elements.get("source").children[0].className.includes("selected"));
}

console.log("コード色分け・同一画面の読解ガイド・VS Code連携を含めて12件 passed");
