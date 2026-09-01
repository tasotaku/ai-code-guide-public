const http = require("node:http");
const { buildCombinedWebView } = require("../out/view/combinedWebView.js");

const source = [
    "def use_them() -> int:",
    "    values = [1, 2, 3]",
    "    values.append(4)",
    "    total = 0",
    "    for value in values:",
    "        total += value",
    "    return total",
].map((text, index) => ({ line: index + 1, text }));

const data = {
    file: "examples/single_file/toplevel_blocks.py",
    standard: {
        title: "toplevel_blocks.py",
        file: "examples/single_file/toplevel_blocks.py",
        source,
        items: [{
            id: "function-1", kind: "function", label: "use_them()", line: 1, lineEnd: 7,
            color: "#4ec9b0", expanded: true,
            expansion: {
                overview: { purpose: "3つの値を順番に合計する。", input: "なし。", output: "合計値6。" },
                blocks: [
                    { label: "値を準備", lineStart: 2, lineEnd: 4, description: "合計対象と初期値を作る。" },
                    { label: "順番に加算", lineStart: 5, lineEnd: 6, description: "各valueをtotalへ足す。" },
                    { label: "結果を返す", lineStart: 7, lineEnd: 7, description: "合計値を呼び出し元へ返す。" },
                ],
            },
        }],
    },
    trace: {
        funcNames: ["use_them"], loopCount: 1,
        functions: [{
            funcName: "use_them", startLine: 1, endLine: 7, code: source,
            loop: { headerLine: 5, total: 3, actualTotal: 3 },
            pathEvents: [],
            iterations: [
                { number: 1, values: [{ line: 5, text: "value=1" }, { line: 6, text: "total=1" }] },
                { number: 2, values: [{ line: 5, text: "value=2" }, { line: 6, text: "total=3" }] },
                { number: 3, values: [{ line: 5, text: "value=3" }, { line: 6, text: "total=6" }, { line: 7, text: "return 6" }] },
            ],
        }],
    },
    annotations: {
        context: { label: "use_them", startLine: 1, endLine: 7, code: source },
        items: [
            { id: "a-values", kind: "symbol", severity: "info", label: "values", explanation: "順番に合計する整数の一覧。", symbolKey: "use_them|variable|values", symbolKind: "variable", startLine: 2, endLine: 2, startCol: 4, endCol: 10, code: [source[1]] },
            { id: "a-append", kind: "symbol", severity: "info", label: "append", explanation: "一覧の末尾へ値を追加するメソッド。", symbolKey: "use_them|method|append", symbolKind: "method", startLine: 3, endLine: 3, startCol: 11, endCol: 17, code: [source[2]] },
            { id: "a-value", kind: "symbol", severity: "info", label: "value", explanation: "現在の周回でtotalへ加える整数。", symbolKey: "use_them|variable|value", symbolKind: "variable", startLine: 5, endLine: 5, startCol: 8, endCol: 13, code: [source[4]] },
            { id: "a-total", kind: "symbol", severity: "info", label: "total", explanation: "ここまでに加えた値の合計。", symbolKey: "use_them|variable|total", symbolKind: "variable", startLine: 6, endLine: 6, startCol: 8, endCol: 13, code: [source[5]] },
        ],
    },
    diagram: {
        kind: "flow", title: "use_themの処理順", summary: "値を準備し、3周のループで合計して返す。",
        nodes: [
            { id: "prepare", file: "examples/single_file/toplevel_blocks.py", symbol: "use_them", anchor: "values =", label: "値を準備", description: "一覧と合計の初期値を作る。", line: 2 },
            { id: "loop", file: "examples/single_file/toplevel_blocks.py", symbol: "use_them", anchor: "for value", label: "順番に加算", description: "valueをtotalへ加える。", line: 5 },
            { id: "return", file: "examples/single_file/toplevel_blocks.py", symbol: "use_them", anchor: "return total", label: "合計を返す", description: "最終的なtotalを返す。", line: 7 },
        ],
        edges: [{ from: "prepare", to: "loop", label: "準備完了" }, { from: "loop", to: "return", label: "3周完了" }],
    },
};

const viewId = "111111111111111111111111111111111111111111111111";
const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === `/view/${viewId}`) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(buildCombinedWebView(data, viewId));
        return;
    }
    if (request.method === "POST" && url.pathname === `/view/${viewId}/expand`) {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ standard: data.standard }));
        return;
    }
    if (request.method === "POST" && url.pathname === `/view/${viewId}/ask`) {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ explanation: "現在の周回で合計へ加える整数。", history: [], canUndo: false }));
        return;
    }
    response.writeHead(404).end("Not Found");
});

server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${address.port}/view/${viewId}` }) + "\n");
});
