const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");

const contributed = pkg.contributes.commands.map((entry) => entry.command);
const config = pkg.contributes.configuration.properties;
const registered = new Set(
    [...extensionSource.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)].map((match) => match[1])
);

assert.ok(pkg.activationEvents.includes("onStartupFinished"), "VS Code起動後にbridgeを自動作成するactivation eventが必要です");
console.log("ok - onStartupFinishedでVS Code起動後にbridgeを自動作成する");

assert.strictEqual(config["aiCodeGuide.useSubscription"]?.default, true);
console.log("ok - 未設定の環境ではサブスク実行を既定にする");

assert.strictEqual(pkg.capabilities?.untrustedWorkspaces?.supported, "limited");
assert.ok(extensionSource.includes("if (!vscode.workspace.isTrusted)"));
assert.ok(extensionSource.includes("ワークスペースが未信頼のため実行トレースは無効"));
console.log("ok - 制限モードでは表示を許可し、対象Pythonの実行トレースを拒否する");

assert.ok(contributed.length > 0, "package.json に公開コマンドが必要です");
assert.strictEqual(new Set(contributed).size, contributed.length, "公開コマンドIDが重複しています");

for (const command of contributed) {
    assert.ok(registered.has(command), `${command} が extension.ts で登録されていません`);
}

const savedTraceStart = extensionSource.indexOf('registerCommand("aiCodeGuide.showSavedTraces"');
const savedTraceEnd = extensionSource.indexOf('registerCommand("aiCodeGuide.traceFunction"', savedTraceStart);
const savedTrace = extensionSource.slice(savedTraceStart, savedTraceEnd);
assert.ok(savedTraceStart >= 0, "保存済みトレース専用コマンドが必要です");
assert.ok(savedTrace.includes("traceCache.get(traceCacheKey"), "保存済みトレースは永続キャッシュを読む必要があります");
assert.ok(extensionSource.includes('const traceValueFormat = "readable-values-v4-handled-assertions"'), "値表現またはassert記録の更新時に古いトレースを再利用しない必要があります");
assert.ok(!savedTrace.includes("traceOne("), "保存済み表示からLLM生成・Python実行へフォールバックしてはいけません");
assert.ok(savedTrace.includes("args?.funcs !== undefined"), "空の複数対象を全関数へ暗黙変換してはいけません");

const inlineCommandStart = extensionSource.indexOf('registerCommand("aiCodeGuide.explainBlockInline"');
const inlineCommandEnd = extensionSource.indexOf('registerCommand("aiCodeGuide.regenerateBlockInline"', inlineCommandStart);
const inlineCommand = extensionSource.slice(inlineCommandStart, inlineCommandEnd);
const selectionCommandStart = extensionSource.indexOf('registerCommand("aiCodeGuide.explainSelection"');
const selectionCommandEnd = extensionSource.indexOf('registerCommand("aiCodeGuide.quoteSelectionToChat"', selectionCommandStart);
const selectionCommand = extensionSource.slice(selectionCommandStart, selectionCommandEnd);
assert.ok(inlineCommand.includes("return await annotationProvider?.annotateFile(editor)"), "全体生成結果をMCPブリッジへ返す必要があります");
assert.ok(selectionCommand.includes("return await annotationProvider?.annotate(editor)"), "範囲生成結果をMCPブリッジへ返す必要があります");
assert.ok(inlineCommand.includes('status: "empty", count: 0'), "全体生成不能を成功扱いにしない必要があります");
assert.ok(selectionCommand.includes('status: "empty", count: 0'), "範囲生成不能を成功扱いにしない必要があります");

console.log(`${contributed.length}/${contributed.length} public commands registered`);
