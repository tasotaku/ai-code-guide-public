// TraceProvider の周回選択ロジック(clampSelections/compute)の回帰テスト。
// vscode をスタブして out/inline/traceProvider.js を直接読む(annotations_smoke.js と同じ手法)。
// データは python/trace_runner.py の merge_wants 実出力(2026-07-24採取)を固定化したもの。
const Module = require("module");
const path = require("path");
const assert = require("assert");

const fakeVscode = {
    window: { createTextEditorDecorationType: () => ({ dispose() {} }), visibleTextEditors: [] },
    commands: { executeCommand: async () => {} },
    MarkdownString: class { constructor() { this.value = ""; } appendMarkdown(s) { this.value += s; } appendCodeblock(s) { this.value += s; } },
    Hover: class { constructor(md, range) { this.contents = [md]; this.range = range; } },
    Range: class { constructor(a, b, c, d) { this.args = [a, b, c, d]; } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
};
const origLoad = Module._load;
Module._load = (req, parent, isMain) => (req === "vscode" ? fakeVscode : origLoad.call(Module, req, parent, isMain));

const { TraceProvider } = require(path.join(__dirname, "..", "out", "inline", "traceProvider.js"));

const v = (s) => ({ short: s, full: s });
const TRACE = {
    loops: [
        { id: 0, header_line: 20, body_start: 21, body_end: 35, parent: null },
        { id: 1, header_line: 21, body_start: 22, body_end: 35, parent: 0 },
    ],
    steps: [
        { line: 18, iter_path: [], changed: { entries: v("[('alice',…), ('bob',…)]") } },
        { line: 19, iter_path: [], changed: { grouped: v("{}") } },
        { line: 20, iter_path: [[0, 1]], changed: { member: v("'alice'"), circles: v("[C(1,5)]") } },
        { line: 21, iter_path: [[0, 1], [1, 1]], changed: { circle: v("C(1,5)") } },
        { line: 22, iter_path: [[0, 1], [1, 1]], changed: { key: v("(1, 5)") } },
        { line: 23, iter_path: [[0, 1], [1, 1]], changed: { existing: v("None") } },
        { line: 25, iter_path: [[0, 1], [1, 1]], changed: { grouped: v("{(1,5): Want({'alice'})}") } },
        { line: 21, iter_path: [[0, 1], [1, 2]], changed: {} },
        { line: 20, iter_path: [[0, 2]], changed: { member: v("'bob'"), circles: v("[C(1,5), C(2,17)]") } },
        { line: 21, iter_path: [[0, 2], [1, 1]], changed: { circle: v("C(1,5)") } },
        { line: 23, iter_path: [[0, 2], [1, 1]], changed: { existing: v("Want({'alice'})") } },
        { line: 31, iter_path: [[0, 2], [1, 1]], changed: { grouped: v("{(1,5): Want({'alice','bob'})}") } },
        { line: 21, iter_path: [[0, 2], [1, 2]], changed: { circle: v("C(2,17)") } },
        { line: 22, iter_path: [[0, 2], [1, 2]], changed: { key: v("(2, 17)") } },
        { line: 23, iter_path: [[0, 2], [1, 2]], changed: { existing: v("None") } },
        { line: 25, iter_path: [[0, 2], [1, 2]], changed: { grouped: v("{(1,5):…, (2,17):…}") } },
        { line: 21, iter_path: [[0, 2], [1, 3]], changed: {} },
        { line: 20, iter_path: [[0, 3]], changed: {} },
    ],
    iter_counts: { "0": { "": 2 }, "1": { "0:1": 1, "0:2": 2 } },
    return_value: v("[Want(…), Want(…)]"),
    func_line_start: 18,
    func_line_end: 36,
    error: null,
};

function makeState(sel) {
    return { trace: TRACE, funcName: "merge_wants", docVersion: 0, selected: new Map(Object.entries(sel).map(([k, x]) => [Number(k), x])) };
}

let passed = 0;
function ok(name, fn) {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
}

const p = new TraceProvider();

ok("外1周目・内1周目: 1周目の値が出て、2周目のelse側(L31)は出ない", () => {
    const { clamped, lineToStep } = p.compute(makeState({ 0: 1, 1: 1 }));
    assert.strictEqual(clamped.get(0).max, 2);
    assert.strictEqual(clamped.get(1).max, 1); // 親が1周目のとき内側は1周だけ
    assert.strictEqual(lineToStep.get(23).changed.existing.short, "None");
    assert.strictEqual(lineToStep.get(25).changed.grouped.short, "{(1,5): Want({'alice'})}");
    assert.strictEqual(lineToStep.get(31), undefined);
    assert.strictEqual(lineToStep.get(20).changed.member.short, "'alice'");
});

ok("外2周目・内1周目: マージの瞬間(L31)が出て、変化しなかったkey(L22)は前周回から持ち越し", () => {
    const { clamped, lineToStep } = p.compute(makeState({ 0: 2, 1: 1 }));
    assert.strictEqual(clamped.get(1).max, 2); // 親が2周目のとき内側は2周
    assert.strictEqual(lineToStep.get(23).changed.existing.short, "Want({'alice'})");
    assert.strictEqual(lineToStep.get(31).changed.grouped.short, "{(1,5): Want({'alice','bob'})}");
    assert.strictEqual(lineToStep.get(22).changed.key.short, "(1, 5)"); // 持ち越し(2周目はreprが同じで未記録)
});

ok("外2周目・内2周目: if側(L25)に2件目追加が出て、L31はマージ時点の値を持ち越す", () => {
    const { lineToStep } = p.compute(makeState({ 0: 2, 1: 2 }));
    assert.strictEqual(lineToStep.get(22).changed.key.short, "(2, 17)");
    assert.strictEqual(lineToStep.get(25).changed.grouped.short, "{(1,5):…, (2,17):…}");
    assert.strictEqual(lineToStep.get(31).changed.grouped.short, "{(1,5): Want({'alice','bob'})}");
});

ok("ループ外の行(def行の入力例)は周回選択に関係なく常に出る", () => {
    for (const sel of [{ 0: 1, 1: 1 }, { 0: 2, 1: 2 }]) {
        const { lineToStep } = p.compute(makeState(sel));
        assert.ok(lineToStep.get(18).changed.entries);
        assert.strictEqual(lineToStep.get(19).changed.grouped.short, "{}");
    }
});

ok("範囲外の周回選択はクランプされる", () => {
    const { clamped } = p.compute(makeState({ 0: 99, 1: 99 }));
    assert.strictEqual(clamped.get(0).iter, 2);
    assert.strictEqual(clamped.get(1).iter, 2); // 親=2周目にクランプ後、その下の実周回数2でクランプ
});

// AI_NOTE: 周回セレクタのボタン(ステータスバー/サイドバー)が読む問い合わせ口の回帰テスト。
// 「ループごとの現在周回・実周回数・ネストの深さが行順で返る」「解除で空になる」を固定する。
const URI = "file:///t.py";
const fakeEditor = (line0) => ({
    document: { uri: { toString: () => URI }, lineCount: 40 },
    selection: { active: { line: line0 } },
});

ok("getLoopSelectors: 行順に外側→内側が並び、周回とネスト深さを返す", () => {
    p.states.set(URI, [makeState({ 0: 2, 1: 2 })]);
    assert.deepStrictEqual(p.getLoopSelectors(URI), [
        { funcName: "merge_wants", loopId: 0, headerLine: 20, iter: 2, max: 2, depth: 0 },
        { funcName: "merge_wants", loopId: 1, headerLine: 21, iter: 2, max: 2, depth: 1 },
    ]);
    p.states.delete(URI);
    assert.deepStrictEqual(p.getLoopSelectors(URI), []); // トレース解除でボタン行も消える
});

ok("getLoopAtCursor: カーソル行の最内ループ・範囲外は先頭ループ・解除でnull", () => {
    p.states.set(URI, [makeState({ 0: 2, 1: 1 })]);
    assert.deepStrictEqual(p.getLoopAtCursor(fakeEditor(24)), { funcName: "merge_wants", loopId: 1, iter: 1, max: 2 }); // 25行目=内側の中
    assert.deepStrictEqual(p.getLoopAtCursor(fakeEditor(18)), { funcName: "merge_wants", loopId: 0, iter: 2, max: 2 }); // 19行目=ループ外→先頭
    p.states.delete(URI);
    assert.strictEqual(p.getLoopAtCursor(fakeEditor(24)), null);
});

// AI_NOTE: 一括トレース(複数関数を同時表示)の回帰テスト。同じファイルに2関数分の状態を置き、
// 「周回の選択が関数ごとに独立している」「カーソル行から正しい関数が選ばれる」を固定する。
// 2つ目は1つ目と離れた行範囲(100行台)の別関数として作る(loopIdは関数ごとに0から振られる)。
const TRACE2 = {
    loops: [{ id: 0, header_line: 102, body_start: 103, body_end: 105, parent: null }],
    steps: [
        { line: 101, iter_path: [], changed: { total: v("0") } },
        { line: 102, iter_path: [[0, 1]], changed: { x: v("1") } },
        { line: 103, iter_path: [[0, 1]], changed: { total: v("1") } },
        { line: 102, iter_path: [[0, 2]], changed: { x: v("2") } },
        { line: 103, iter_path: [[0, 2]], changed: { total: v("3") } },
    ],
    iter_counts: { "0": { "": 2 } },
    return_value: v("3"),
    func_line_start: 100,
    func_line_end: 106,
    error: null,
};

ok("複数関数: 周回セレクタが関数名付きで両方出て、選択は関数ごとに独立する", () => {
    p.states.set(URI, [
        makeState({ 0: 2, 1: 1 }),
        { trace: TRACE2, funcName: "total_sum", docVersion: 0, selected: new Map([[0, 1]]) },
    ]);
    assert.deepStrictEqual(p.getLoopSelectors(URI), [
        { funcName: "merge_wants", loopId: 0, headerLine: 20, iter: 2, max: 2, depth: 0 },
        { funcName: "merge_wants", loopId: 1, headerLine: 21, iter: 1, max: 2, depth: 1 },
        { funcName: "total_sum", loopId: 0, headerLine: 102, iter: 1, max: 2, depth: 0 },
    ]);
    // 同じ loopId=0 でも関数が違えば別のループとして動く
    p.stepIterationFor(URI, "total_sum", 0, 1);
    assert.deepStrictEqual(
        p.getLoopSelectors(URI).map((l) => [l.funcName, l.loopId, l.iter]),
        [["merge_wants", 0, 2], ["merge_wants", 1, 1], ["total_sum", 0, 2]],
    );
    p.states.delete(URI);
});

ok("複数関数: カーソル行を含む関数のループが対象になる", () => {
    p.states.set(URI, [
        makeState({ 0: 2, 1: 1 }),
        { trace: TRACE2, funcName: "total_sum", docVersion: 0, selected: new Map([[0, 2]]) },
    ]);
    assert.deepStrictEqual(p.getLoopAtCursor(fakeEditor(102)), { funcName: "total_sum", loopId: 0, iter: 2, max: 2 }); // 103行目=2つ目の関数の中
    assert.deepStrictEqual(p.getLoopAtCursor(fakeEditor(24)), { funcName: "merge_wants", loopId: 1, iter: 1, max: 2 });
    assert.deepStrictEqual(p.getLoopAtCursor(fakeEditor(0)), { funcName: "merge_wants", loopId: 0, iter: 2, max: 2 }); // どの関数にも入っていない→先頭
    assert.deepStrictEqual(p.getStatus(URI), { funcNames: ["merge_wants", "total_sum"], loopCount: 3 });
    p.states.delete(URI);
});

ok("会話内トレース: 最外ループの各周回を短い行別値として返す", () => {
    const state = makeState({ 0: 1, 1: 1 });
    p.states.set(URI, [state]);
    const [conversation] = p.getConversationTraces(URI);
    assert.deepStrictEqual(conversation.loop, { headerLine: 20, total: 2, actualTotal: 2 });
    assert.strictEqual(conversation.iterations.length, 2);
    assert.ok(conversation.iterations[0].values.find((value) => value.line === 20).text.includes("'alice'"));
    assert.ok(conversation.iterations[1].values.find((value) => value.line === 20).text.includes("'bob'"));
    assert.strictEqual(state.selected.get(0), 1, "会話用の全周回計算でVS Code側の選択を変えない");
    p.states.delete(URI);
});

// AI_NOTE: 右端のafter装飾自体に全文ホバーが付く回帰テスト。表示文字は80幅で省略されても、
// hoverMessageはshortでなくfullを保持し、マウスをトレース文字へ直接合わせて読めることを固定する。
ok("長いトレース文字: 表示は省略し、装飾ホバーには全文を入れる", () => {
    const longFull = `[${Array.from({ length: 30 }, (_, i) => `"item-${i}"`).join(", ")}]`;
    const trace = {
        loops: [],
        steps: [{ line: 1, iter_path: [], changed: { items: { short: longFull, full: longFull } } }],
        iter_counts: {},
        return_value: null,
        func_line_start: 1,
        func_line_end: 2,
        error: null,
    };
    const document = {
        uri: { toString: () => URI },
        lineCount: 2,
        lineAt: (line) => ({ text: line === 0 ? "def sample():" : "    pass", range: {} }),
    };
    const editor = { document };
    const state = { trace, funcName: "sample", docVersion: 0, selected: new Map() };

    const [deco] = p.buildDecorations(editor, state);
    assert.ok(deco.renderOptions.after.contentText.endsWith("…"));
    assert.ok(deco.hoverMessage.value.includes(longFull));
});

ok("トレース装飾の行末位置ではHoverProviderを返さず、全文を二重表示しない", () => {
    const document = {
        uri: { toString: () => URI },
        lineAt: () => ({ text: "value = build()", range: {} }),
    };
    p.states.set(URI, [makeState({ 0: 1, 1: 1 })]);
    assert.strictEqual(p.provideHover(document, new fakeVscode.Position(24, "value = build()".length)), undefined);
    p.states.delete(URI);
});

console.log(`\n${passed} passed`);
