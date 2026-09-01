const assert = require("assert");
const vm = require("vm");
const { buildLauncherAppShell } = require("../out/mcp/launcherApp.js");

class Classes {
    constructor() { this.values = new Set(); }
    toggle(value, enabled) { enabled ? this.values.add(value) : this.values.delete(value); }
}

class Element {
    constructor(id = "") {
        this.id = id;
        this.value = "";
        this.textContent = "";
        this.disabled = false;
        this.dataset = {};
        this.listeners = {};
        this.classList = new Classes();
        this.focused = false;
        this.attributes = {};
        this.style = {};
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    dispatch(name) { return this.listeners[name]?.({ currentTarget: this }); }
    focus() { this.focused = true; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
}

function startApp() {
    const html = buildLauncherAppShell();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const elements = new Map(["target", "question", "status", "submit"].map((id) => [id, new Element(id)]));
    const views = ["標準ビュー", "コード図", "実行トレース", "インライン解説"].map((view) => {
        const button = new Element();
        button.dataset.view = view;
        button.setAttribute("aria-pressed", "false");
        return button;
    });
    let onMessage;
    const sent = [];
    const parent = { postMessage: (message) => sent.push(message) };
    const window = { parent, addEventListener: (_name, listener) => { onMessage = listener; } };
    const document = {
        getElementById: (id) => elements.get(id),
        querySelectorAll: (selector) => selector === "[data-view]" ? views : [],
    };
    vm.runInNewContext(script, { window, document, Error, Map, Array, String, Promise });
    const notify = (data) => onMessage({ source: parent, data });
    notify({ jsonrpc: "2.0", id: sent[0].id, result: { hostCapabilities: {} } });
    return { elements, notify, sent, views };
}

(async () => {
    const shell = buildLauncherAppShell();
    for (const text of ["コードの何を見たいですか？", "対象", "知りたいこと", "標準ビュー", "コード図", "処理の流れ・読解順・依存関係", "実行トレース", "インライン解説"]) assert.ok(shell.includes(text));
    assert.ok(!shell.includes('data-view="フロー図"'), "the old flow-only public label must not remain");
    assert.ok(shell.includes("確認したい処理や疑問を入力"));
    assert.ok(shell.includes("<code>$ai-code-guide-request</code>"));
    assert.ok(!shell.includes("<code>/ai-code-guide</code>"), "the old product-name command must not remain a launcher trigger");
    assert.ok(shell.includes("Codexの送信確認"));
    assert.ok(!shell.includes("練習内容を入力"), "the reusable card must not contain an onboarding-only autofill action");
    assert.ok(!shell.includes("自分の言葉"), "the launcher must not prescribe how users phrase a question");
    assert.ok(shell.includes('request("ui/message"'), "the card must post one normal user message");
    assert.ok(!shell.includes("sendFollowUpMessage"), "a rejected message must not trigger a second confirmation through fallback");
    assert.ok(!shell.includes('request("tools/call"'), "the card must not bypass the normal conversation with direct dispatch");
    assert.ok(!shell.includes("dispatch_ai_code_guide_request"));

    const app = startApp();
    app.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { launcher: {} } } });
    assert.strictEqual(app.elements.get("target").value, "", "the task target must not be prefilled");
    assert.strictEqual(app.elements.get("target").focused, true);
    assert.ok(app.views.every((button) => !button.disabled), "view choices remain selectable before text input");
    assert.strictEqual(app.elements.get("submit").disabled, true);

    app.elements.get("target").value = "ingestion/service.py";
    app.elements.get("target").dispatch("input");
    app.elements.get("question").value = "ScannerUnavailable後の後始末と例外伝播";
    app.elements.get("question").dispatch("input");
    assert.strictEqual(app.elements.get("submit").disabled, true, "a view is still required");
    app.views.find((button) => button.dataset.view === "コード図").dispatch("click");
    app.views.find((button) => button.dataset.view === "実行トレース").dispatch("click");
    assert.strictEqual(app.elements.get("submit").disabled, false);
    app.elements.get("submit").dispatch("click");
    await Promise.resolve();

    const messages = app.sent.filter((entry) => entry.method === "ui/message");
    assert.strictEqual(messages.length, 1, "one card submit must request exactly one normal user message");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages[0].params)), {
        role: "user",
        content: [{
            type: "text",
            text: [
                "AI Code Guideを使って、次の依頼をそのまま実行してください。",
                "対象: ingestion/service.py",
                "知りたいこと: ScannerUnavailable後の後始末と例外伝播",
                "表示方法: コード図、実行トレース",
                "指定した表示方法だけを実行してください。候補一覧や確認質問は返さず、必要なコード探索を行って結果を直接示してください。",
            ].join("\n"),
        }],
    });
    assert.ok(app.views.every((button) => button.disabled), "controls remain disabled while the host confirmation is pending");
    assert.ok(app.elements.get("status").textContent.includes("送信確認"));
    assert.ok(!app.sent.some((entry) => entry.method === "tools/call"));

    app.notify({ jsonrpc: "2.0", id: messages[0].id, result: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(app.views.every((button) => !button.disabled), "the same card remains reusable after sending");
    assert.strictEqual(app.elements.get("submit").disabled, false);
    assert.strictEqual(app.elements.get("status").textContent, "コード図・実行トレースをCodexへ送信しました。");

    const failed = startApp();
    failed.notify({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { launcher: {} } } });
    failed.elements.get("target").value = "ingestion/service.py";
    failed.elements.get("target").dispatch("input");
    failed.elements.get("question").value = "正常系の公開処理";
    failed.elements.get("question").dispatch("input");
    failed.views[0].dispatch("click");
    failed.elements.get("submit").dispatch("click");
    await Promise.resolve();
    const failedMessage = failed.sent.find((entry) => entry.method === "ui/message");
    failed.notify({ jsonrpc: "2.0", id: failedMessage.id, error: { code: -32000, message: "cancelled" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(failed.views.every((button) => !button.disabled), "a cancelled host confirmation must leave the card retryable");
    assert.strictEqual(failed.sent.filter((entry) => entry.method === "ui/message").length, 1, "cancellation must not create a second host confirmation");
    assert.ok(!failed.sent.some((entry) => entry.method === "tools/call"));

    console.log("AI Code Guide入力カードの単一ui/message送信・確認待ち・候補抑止・取消後再試行を含めて42件 passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
