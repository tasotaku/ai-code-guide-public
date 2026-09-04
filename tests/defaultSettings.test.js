const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const properties = manifest.contributes.configuration.properties;
assert.strictEqual(properties["aiCodeGuide.useSubscription"].default, true);
assert.strictEqual(properties["aiCodeGuide.subscriptionProvider"].default, "codex");
assert.strictEqual(properties["aiCodeGuide.model"].default, "gpt-5.6-sol");
assert.strictEqual(properties["aiCodeGuide.chatModel"].default, "gpt-5.6-sol");
assert.strictEqual(properties["aiCodeGuide.inlineAnnotationModel"].default, "gpt-5.6-sol");
assert.strictEqual(properties["aiCodeGuide.autoInlineAnnotations"].default, true);
for (const removed of [
    "inlineAnnotationDensity", "hideResolvedAnnotations", "warningsOnly", "showHiddenAnnotations",
    "showSymbolAnnotations", "showBlockAnnotations", "symbolAnnotationPlacement",
    "showAnnotationStatusButtons", "autoAnnotateOnAiEdit",
]) assert.ok(!(`aiCodeGuide.${removed}` in properties), `${removed} remains in settings`);

const provider = fs.readFileSync(path.join(root, "src/inline/blockExplanationProvider.ts"), "utf8");
const view = fs.readFileSync(path.join(root, "src/view/mainViewProvider.ts"), "utf8");
const client = fs.readFileSync(path.join(root, "src/api/claudeClient.ts"), "utf8");
const llmProvider = fs.readFileSync(path.join(root, "src/api/llmProvider.ts"), "utf8");
assert.ok(!provider.includes("createTextEditorDecorationType"));
assert.ok(!provider.includes("provideCodeLenses"));
assert.ok(!provider.includes("toggleBlockLayer"));
assert.ok(!view.includes("symbolAnnotationPlacement"));
assert.ok(view.includes('id="ann-run-btn"'));
assert.ok(view.includes(">名称辞書</button>"));
assert.ok(view.includes('id="ann-regen-btn"'));
assert.ok(view.includes('get<boolean>("autoInlineAnnotations", true)'));
assert.ok(view.includes(">説明を再生成</button>"));
assert.ok(view.includes("ファイル内の変数・関数・メソッド・クラスをすべて辞書化する"));
assert.ok(!view.includes('class="default-layer-controls"'));
assert.ok(!view.includes('id="default-layer-status"'));
assert.ok(!view.includes("ブロックの解説"));
assert.ok(client.includes("対象選定はLLMへ任せずAST結果を全件使う"));
assert.ok(client.includes("入力された全keyへ1件ずつ返してください"));
assert.ok(client.includes("variable: 何の値を保持するか"));
assert.ok(client.includes("function/method: 何を受け取り、何をして、何を返すか"));
assert.ok(client.includes("class: 何を表すか、または何を担当するか"));
assert.ok(provider.includes('md.appendMarkdown(`[質問する](command:aiCodeGuide.openAnnotationChat?${args})\\n\\n${ann.explanation}`)'));
assert.ok(!provider.includes('md.appendCodeblock(block, document.languageId)'));
assert.ok(!provider.includes('const kind = ann.symbolKind'));
assert.ok(!view.includes("e.data.warn"));
assert.ok(!view.includes("ann-density"));
assert.ok(!view.includes("ann-seg"));
assert.ok(llmProvider.includes('CODEX_SUBSCRIPTION_MODEL = "codex:gpt-5.6-sol"'));
assert.ok(llmProvider.includes("return CODEX_SUBSCRIPTION_MODEL"));
assert.ok(client.includes("その対象のentry、対象本体にある全条件分岐と各outcome、全return/raise、最後のexit"));
assert.ok(client.includes("helper内部の分岐・return・raiseを混ぜない"));

console.log("default annotation settings: symbol-only hover surface passed");
