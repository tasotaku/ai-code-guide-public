const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const fakeVscode = { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
const originalLoad = Module._load;
Module._load = (request, parent, isMain) => request === "vscode"
    ? fakeVscode
    : originalLoad.call(Module, request, parent, isMain);

const { parseChatConclusion } = require("../out/api/claudeClient.js");
const { resolveAnnotations } = require("../out/api/annotationResolver.js");

const code = [
    "def total(values):",
    "    useful = [value for value in values if value > 0]",
    "    return sum(useful)",
].join("\n");

const parsed = parseChatConclusion([
    "正の値だけを残す",
    "内包表記で正の値だけをusefulへ集める",
    "後続のsumへ不要な0以下を渡さない。",
    '[{"kind":"symbol","line":1,"lineText":"    useful = [value for value in values if value > 0]","token":"value > 0"}]',
].join("\n"));
assert.strictEqual(parsed.targets.length, 1);
const resolved = resolveAnnotations(parsed.targets.map((target) => ({
    ...target,
    label: parsed.symbolLabel,
    explanation: parsed.explanation,
})), code);
assert.strictEqual(resolved.length, 1);
assert.strictEqual(resolved[0].startLine, 1);
assert.strictEqual(code.split("\n")[1].slice(resolved[0].startCol, resolved[0].endCol), "value > 0");
console.log("ok - 引用なしのコード質問をexact-textで解決する");

const general = parseChatConclusion("一般的な説明\n一般的な説明です\nコード位置は特定しない。\n[]");
assert.deepStrictEqual(general.targets, []);
console.log("ok - 一般質問はインライン対象を追加しない");
const malformed = parseChatConclusion("要点\n詳しい要点\n補足\n[{broken]");
assert.deepStrictEqual(malformed.targets, []);
console.log("ok - 壊れた対象JSONは安全に追加しない");

const invented = resolveAnnotations([{
    kind: "symbol",
    line: 1,
    lineText: "    missing = invented_call(values)",
    token: "invented_call",
    label: "存在しない対象",
    explanation: "モデルが捏造したアンカー",
}], code);
assert.deepStrictEqual(invented, []);
console.log("ok - 捏造anchorはresolverが破棄して追加しない");

const tooMany = parseChatConclusion([
    "要点", "詳しい要点", "補足", "```json",
    JSON.stringify(Array.from({ length: 5 }, () => ({ kind: "symbol", lineText: "    return sum(useful)", token: "sum" }))),
    "```",
].join("\n"));
assert.strictEqual(tooMany.targets.length, 3);

const providerSource = fs.readFileSync(path.join(__dirname, "..", "src", "view", "mainViewProvider.ts"), "utf8");
assert.ok(providerSource.includes("const documentUri = document.uri.toString()"));
assert.ok(providerSource.includes("resolveAnnotations(targets.map"));
assert.ok(providerSource.includes("this.chatLinkStore.add(documentUri, ann, session.id)"));
assert.ok(!providerSource.includes("if (existing.length === 0 && newTargets.length === 0) return"));
console.log("ok - 検証済み対象をChatLinkへ保存する経路が接続されている");

console.log("chat auto annotations: parser, exact target resolution, safe fallback, and wiring passed");
