const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { ProjectDiagramBridge } = require("../out/view/projectDiagramBridge.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };
const assertUnixMode = (filePath, mode) => {
    if (process.platform !== "win32") {
        assert.strictEqual(fs.statSync(filePath).mode & 0o777, mode);
    }
};

function request(url, method = "GET", body) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
    });
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acg-diagram-bridge-"));
    const sourceDir = path.join(root, "src");
    const sourceFile = path.join(sourceDir, "main.py");
    const manifestPath = path.join(root, ".ai-code-guide", "bridge.json");
    const activationPath = path.join(root, ".ai-code-guide", "activation.json");
    const registryPath = path.join(root, "registry", "workspace.json");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(sourceFile, "class Runner:\n    def main(self):\n        return 1\n");
    const opened = [];
    const shown = [];
    const symbolUpdates = [];
    let failOpen = false;
    const bridge = new ProjectDiagramBridge({
        getWorkspaceRoot: () => root,
        openFile: async (absolutePath, line) => {
            if (failOpen) throw new Error("VS Code unavailable");
            opened.push({ absolutePath, line });
        },
        showView: async (input) => {
            shown.push(input);
            if (input.view === "standard") {
                const expanded = Boolean(input.expandLines?.includes(2));
                return {
                    ok: true,
                    view: "standard",
                    file: "src/main.py",
                    line: input.line,
                    standard: {
                        title: "main.py",
                        file: "src/main.py",
                        source: [
                            { line: 1, text: "class Runner:" },
                            { line: 2, text: "    def main(self):" },
                            { line: 3, text: "        return 1" },
                        ],
                        items: [{ id: "class-1", kind: "class", label: "class Runner", line: 1, lineEnd: 3 }, {
                            id: "method-2", kind: "function", label: "main", parent: "class-1", line: 2, lineEnd: 3,
                            meaningRanges: [{ lineStart: 2, lineEnd: 3 }],
                            ...(expanded ? {
                                expanded: true,
                                expansion: {
                                    overview: { purpose: "固定値を返す。", input: "なし。", output: "1。", note: "読み取り専用。" },
                                    blocks: [{ label: "値を返す", lineStart: 3, lineEnd: 3, description: "1を返す。" }],
                                },
                            } : {}),
                        }],
                    },
                };
            }
            if (input.view === "trace") {
                return {
                    ok: true,
                    view: input.view,
                    file: "src/main.py",
                    line: input.line,
                    trace: {
                        funcNames: ["main"],
                        loopCount: 1,
                        functions: [{
                            funcName: "main",
                            color: "#c586c0",
                            runId: "run-123",
                            executedAt: "2026-08-12T00:00:00.000Z",
                            arguments: { items: ["first", "second"] },
                            returnValue: { short: "{'items': 2}", full: "{'items': 2, 'complete': True}" },
                            calls: [{
                                sequence: 1,
                                depth: 0,
                                function: "main",
                                line: 1,
                                arguments: { items: { short: "['first', ...]", full: "['first', 'second']" } },
                                return_value: { short: "{'items': 2}", full: "{'items': 2, 'complete': True}" },
                            }],
                            startLine: 1,
                            endLine: 3,
                            code: [
                                { line: 1, text: "def main(items):" },
                                { line: 2, text: "    for item in items:" },
                                { line: 3, text: "        self.assertEqual(len(items), 2)" },
                            ],
                            assertions: [{
                                line: 3,
                                kind: "unittest",
                                method: "assertEqual",
                                outcome: true,
                                arguments: [{ short: "2", full: "2" }, { short: "2", full: "2" }],
                                iter_path: [[0, 1]],
                            }],
                            loop: { headerLine: 2, total: 2, actualTotal: 2 },
                            iterations: [
                                { number: 1, values: [{ line: 2, text: "item='first'" }, { line: 3, text: "✓ assertEqual: 成功 · 実際=2 · 期待=2" }] },
                                { number: 2, values: [{ line: 2, text: "item='second'" }] },
                            ],
                        }],
                    },
                };
            }
            if (input.view === "inline") {
                if (input.removeAnnotationIds || input.hideAnnotationIds) {
                    return {
                        ok: true,
                        view: "inline",
                        file: "src/main.py",
                        annotations: {
                            generatedAt: "2026-08-21T00:02:00.000Z",
                            changes: {
                                removedIds: input.removeAnnotationIds || [],
                                hiddenIds: input.hideAnnotationIds || [],
                            },
                            context: {
                                label: "選択範囲",
                                startLine: 3,
                                endLine: 3,
                                code: [{ line: 3, text: "        print(item)" }],
                            },
                            items: [{
                                id: "annotation-3",
                                kind: "symbol",
                                symbolKey: "main|variable|item",
                                symbolKind: "variable",
                                severity: "info",
                                label: "反復中の値",
                                explanation: "置き換え後はitemの役割を説明する。",
                                startLine: 3,
                                endLine: 3,
                                startCol: 14,
                                endCol: 18,
                                code: [{ line: 3, text: "        print(item)" }],
                            }],
                        },
                    };
                }
                if (input.startLine !== undefined) {
                    return {
                        ok: true,
                        view: "inline",
                        file: "src/main.py",
                        annotations: {
                            generatedAt: "2026-08-21T00:01:00.000Z",
                            context: {
                                label: "選択範囲",
                                startLine: 3,
                                endLine: 3,
                                code: [{ line: 3, text: "        print(item)" }],
                            },
                            items: [{
                                id: "annotation-1",
                                kind: "block",
                                severity: "info",
                                label: "繰り返し処理",
                                explanation: "各要素を順番に表示する。",
                                startLine: 2,
                                endLine: 3,
                                code: [{ line: 3, text: "        print(item)" }],
                            }, {
                                id: "annotation-2",
                                kind: "symbol",
                                symbolKey: "main|function|print",
                                symbolKind: "function",
                                severity: "warning",
                                label: "出力先",
                                explanation: "標準出力へ値を書き出す。",
                                startLine: 3,
                                endLine: 3,
                                startCol: 8,
                                endCol: 13,
                                code: [{ line: 3, text: "        print(item)" }],
                            }, {
                                id: "annotation-3",
                                kind: "symbol",
                                symbolKey: "main|variable|item",
                                symbolKind: "variable",
                                severity: "info",
                                label: "反復中の値",
                                explanation: "現在処理しているitemを渡す。",
                                startLine: 3,
                                endLine: 3,
                                startCol: 14,
                                endCol: 18,
                                code: [{ line: 3, text: "        print(item)" }],
                            }],
                        },
                    };
                }
                return {
                    ok: true,
                    view: "inline",
                    file: "src/main.py",
                    annotations: {
                        generatedAt: "2026-08-21T00:00:00.000Z",
                        context: {
                            label: "関数 main",
                            startLine: 1,
                            endLine: 3,
                            code: [
                                { line: 1, text: "def main(items):" },
                                { line: 2, text: "    for item in items:" },
                                { line: 3, text: "        print(item)" },
                            ],
                        },
                        items: [{
                            id: "annotation-1",
                            kind: "block",
                            severity: "info",
                            label: "繰り返し処理",
                            explanation: "各要素を順番に表示する。",
                            startLine: 2,
                            endLine: 3,
                            code: [
                                { line: 1, text: "def main(items):" },
                                { line: 2, text: "    for item in items:" },
                                { line: 3, text: "        print(item)" },
                            ],
                        }, {
                            id: "annotation-2",
                            kind: "symbol",
                            symbolKey: "main|function|print",
                            symbolKind: "function",
                            severity: "warning",
                            label: "出力先",
                            explanation: "標準出力へ値を書き出す。",
                            startLine: 3,
                            endLine: 3,
                            startCol: 8,
                            endCol: 13,
                            code: [{ line: 3, text: "        print(item)" }],
                        }],
                    },
                };
            }
            if (input.view === "diagram") {
                return {
                    ok: true,
                    view: "diagram",
                    file: "src/main.py",
                    question: input.question,
                    diagram: {
                        kind: "flow",
                        title: "mainの処理順",
                        summary: "mainが固定値を返す。",
                        nodes: [
                            { id: "start", file: "src/main.py", symbol: "Runner.main", anchor: "def main", label: "処理開始", description: "mainを開始する。", line: 1 },
                            { id: "return", file: "src/main.py", symbol: "Runner.main", anchor: "return 1", label: "値を返す", description: "固定値1を返す。", line: 2 },
                        ],
                        edges: [{ from: "start", to: "return", label: "次へ" }],
                    },
                };
            }
            return { ok: true, view: input.view, file: input.absoluteFile, line: input.line };
        },
        refineSymbol: async ({ question }) => ({
            answer: `回答: ${question}`,
            explanation: "print() は受け取った値を標準出力へ表示する関数です。",
        }),
        updateSymbolExplanation: async (file, symbolKey, explanation) => {
            symbolUpdates.push({ file, symbolKey, explanation });
        },
        getManifestPath: () => manifestPath,
        getRegistryPath: () => registryPath,
        getActivationPath: () => activationPath,
        token: "test-token",
    });
    try {
        const link = await bridge.start();
        assert.ok(link);
        assert.strictEqual(link.token, "test-token");
        assert.ok(link.baseUrl.startsWith("http://127.0.0.1:"));
        ok("loopbackのランダムポートで起動する");

        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        assert.strictEqual(manifest.baseUrl, link.baseUrl);
        assert.strictEqual(manifest.token, "test-token");
        assert.strictEqual(manifest.workspaceRoot, root);
        assertUnixMode(manifestPath, 0o600);
        const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
        assert.strictEqual(registry.workspaceRoot, root);
        assertUnixMode(registryPath, 0o600);
        assertUnixMode(path.dirname(registryPath), 0o700);
        const activation = JSON.parse(fs.readFileSync(activationPath, "utf8"));
        assert.strictEqual(activation.workspaceRoot, root);
        assert.strictEqual(activation.pid, process.pid);
        assertUnixMode(activationPath, 0o600);
        ok("ワークスペースとユーザー領域へ所有者限定マニフェストを書く");

        const valid = `${link.baseUrl}/open?token=test-token&file=src%2Fmain.py&line=1`;
        assert.strictEqual((await request(valid)).status, 204);
        assert.deepStrictEqual(opened, [{ absolutePath: sourceFile, line: 0 }]);
        ok("認証済みのワークスペース内ファイルを0始まり行へ変換して開く");

        assert.strictEqual((await request(`${link.baseUrl}/open?token=wrong&file=src%2Fmain.py&line=1`)).status, 403);
        assert.strictEqual(opened.length, 1);
        ok("不正トークンを拒否する");

        assert.strictEqual((await request(`${link.baseUrl}/open?token=test-token&file=..%2Foutside.py&line=1`)).status, 403);
        assert.strictEqual(opened.length, 1);
        ok("ワークスペース外へのパストラバーサルを拒否する");

        assert.strictEqual((await request(`${link.baseUrl}/open?token=test-token&file=src%2Fmain.py&line=0`)).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/open?token=test-token&file=src%2Fmain.py&line=abc`)).status, 400);
        ok("不正な行番号を拒否する");

        assert.strictEqual((await request(valid, "POST")).status, 405);
        assert.strictEqual((await request(`${link.baseUrl}/open?token=test-token&file=src%2Fmissing.py&line=1`)).status, 404);
        ok("GET以外と存在しないファイルを開かない");

        failOpen = true;
        assert.strictEqual((await request(valid)).status, 500);
        assert.strictEqual(opened.length, 1);
        ok("VS Code APIの失敗を成功扱いにしない");

        const status = await request(`${link.baseUrl}/status?token=test-token`);
        assert.strictEqual(status.status, 200);
        assert.deepStrictEqual(JSON.parse(status.body).views, ["standard", "overview", "project", "diagram", "inline", "trace"]);
        ok("認証済みクライアントへ利用可能な理解支援ビューを返す");

        const show = await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "trace", file: "src/main.py", line: 1, functions: ["main", "helper"], run: true, activate: false, focusWindow: true,
        });
        assert.strictEqual(show.status, 200);
        const showBody = JSON.parse(show.body);
        assert.strictEqual(showBody.codexView.type, "browser");
        assert.strictEqual(showBody.codexView.view, "trace");
        assert.ok(showBody.codexView.url.startsWith(`${link.baseUrl}/view/`));
        assert.deepStrictEqual(showBody.trace.functions[0].assertions.map(({ method, outcome }) => ({ method, outcome })), [
            { method: "assertEqual", outcome: true },
        ]);
        assert.deepStrictEqual(shown, [{
            view: "trace", absoluteFile: sourceFile, line: 1, functions: ["main", "helper"], question: undefined,
            run: true, activate: false, focusWindow: true,
        }]);

        const exactArgs = await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "trace", file: "src/main.py", functions: ["main"], arguments: { value: -1 }, run: true,
        });
        assert.strictEqual(exactArgs.status, 200);
        assert.deepStrictEqual(shown.at(-1), {
            view: "trace", absoluteFile: sourceFile, line: undefined, functions: ["main"], arguments: { value: -1 }, question: undefined,
            run: true,
        });
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "trace", file: "src/main.py", functions: ["main", "helper"], arguments: { value: -1 }, run: true,
        })).status, 400);
        ok("検証済み要求を画面表示へ渡し、トレースだけCodexブラウザURLを返す");

        const traceView = await request(showBody.codexView.url);
        assert.strictEqual(traceView.status, 200);
        const openedStatus = JSON.parse((await request(`${link.baseUrl}/status?token=test-token`)).body);
        assert.ok(openedStatus.openedViews.some((receipt) => showBody.codexView.url.endsWith(`/view/${receipt.id}`)));
        assert.strictEqual(traceView.headers["content-type"], "text/html; charset=utf-8");
        assert.ok(traceView.headers["content-security-policy"].includes("connect-src 'self'"));
        assert.ok(traceView.body.includes("AI CODE GUIDE · 実行トレース"));
        assert.ok(traceView.body.includes("✓ assertEqual: 成功 · 実際=2 · 期待=2"), "Codex trace page keeps assertion outcomes and compared values");
        assert.ok(traceView.body.includes("grid-template-columns:minmax(0,var(--trace-split,var(--split-default))) 8px minmax(0,1fr)"));
        assert.ok(traceView.body.includes('role","separator"'));
        assert.ok(traceView.body.includes('handle.setPointerCapture(event.pointerId)'));
        assert.ok(traceView.body.includes('window.addEventListener("mousemove"'));
        assert.ok(traceView.body.includes('event.key==="ArrowLeft"'));
        assert.ok(traceView.body.includes('sessionStorage.setItem(storageKey'));
        assert.ok(traceView.body.includes('const functionKey=fn.funcName+":"+fn.startLine+":"+fn.endLine'));
        assert.ok(traceView.body.includes('grid.style.setProperty("--trace-split"'));
        assert.ok(!traceView.body.includes('document.documentElement.style.setProperty("--trace-split"'));
        assert.ok(traceView.body.includes("--editor-font-size:14px"));
        assert.ok(traceView.body.includes("--editor-line-height:20px"));
        assert.ok(traceView.body.includes("--trace:#9cdcfe"));
        assert.ok(traceView.body.includes("--keyword:#c586c0"));
        assert.ok(traceView.body.includes("--function:#dcdcaa"));
        assert.ok(!traceView.body.includes("prefers-color-scheme:light"));
        assert.ok(traceView.body.includes("trace-note-pane { position:relative; z-index:1; overflow-x:scroll; scrollbar-gutter:stable"));
        assert.ok(!traceView.body.includes("trace-note-pane { position:relative; z-index:1; border-left"));
        assert.ok(traceView.body.includes(".trace-note-pane::-webkit-scrollbar { height:12px; background:#2d2d2d; }"));
        assert.ok(!traceView.body.includes('aria-label","実行値を横にスクロール"'));
        assert.ok(!traceView.body.includes('class","trace-scroll"'));
        assert.ok(!traceView.body.includes("const syncRange="));
        assert.ok(traceView.body.includes("周目 / 全"));
        assert.ok(traceView.body.includes("token-keyword"));
        assert.ok(traceView.body.includes("token-type"));
        assert.ok(traceView.body.includes(".code-token-match"));
        assert.ok(traceView.body.includes('document.documentElement.dataset.codeSurface="shared-v2"'));
        assert.ok(!traceView.body.includes(".trace-code-pane .trace-row.semantic-unit"));
        assert.ok(!traceView.body.includes('codeRow.style.setProperty("--unit-color",unitColor)'));
        assert.ok(traceView.body.includes('"color":"#c586c0"'));
        assert.ok(traceView.body.includes("span.dataset.codeToken=token"));
        assert.ok(traceView.body.includes('document.addEventListener("dblclick"'));
        assert.ok(traceView.body.includes("range.selectNodeContents(target)"));
        assert.ok(traceView.body.includes('document.addEventListener("copy"'));
        assert.ok(traceView.body.includes('event.clipboardData?.setData("text/plain",target.textContent||"")'));
        assert.ok(traceView.body.includes("selection.toString()!==target.textContent"));
        assert.ok(traceView.body.includes('event.key!=="Escape"'));
        assert.ok(traceView.body.includes("item.text.slice(baseIndent)"));
        assert.ok(!traceView.body.includes('element("span","line",item.line)'));
        assert.ok(!traceView.body.includes('executed.has(line)?"到達"'));
        assert.ok(!traceView.body.includes('"未到達"'));
        for (const hidden of ["run-123", "run_receipt_id", "source_sha256", "役割", "位置", "制御経路", "主要値", "安全性", "2026-08-12T00:00:00.000Z", "{'items': 2, 'complete': True}", "呼び出し順", "call-list", "trace_entry_id", "trace hash", "receipt hash"]) {
            assert.ok(!traceView.body.includes(hidden), `trace view omits ${hidden}`);
        }
        assert.ok(traceView.body.includes("… 省略 …"));
        assert.ok(!traceView.body.includes("height:36px; border-bottom:1px"));
        ok("能力URLだけでトレース実行部分に絞った自己完結HTMLを返し、2列・VS Code相当の文字・左右スクロール・dedent・周回操作を含める");

        failOpen = false;
        const traceOpen = await request(`${showBody.codexView.url}/open`, "POST", { file: "src/main.py", line: 2 });
        assert.strictEqual(traceOpen.status, 204);
        assert.deepStrictEqual(opened.at(-1), { absolutePath: sourceFile, line: 1 });
        assert.strictEqual((await request(`${showBody.codexView.url}/open`, "POST", { file: "../outside.py", line: 2 })).status, 400);
        assert.strictEqual((await request(`${showBody.codexView.url}/open`, "POST", { file: "src/main.py", line: 0 })).status, 400);
        ok("トレースHTMLから保存済み対象ファイルの正しい行だけをVS Codeで開く");

        const inline = await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "inline", file: "src/main.py", activate: false,
        });
        assert.strictEqual(inline.status, 200);
        const inlineBody = JSON.parse(inline.body);
        assert.strictEqual(inlineBody.codexView.type, "browser");
        assert.strictEqual(inlineBody.codexView.view, "inline");
        assert.ok(inlineBody.codexView.url.startsWith(`${link.baseUrl}/view/`));
        const inlineView = await request(inlineBody.codexView.url);
        assert.strictEqual(inlineView.status, 200);
        assert.ok(inlineView.body.includes("AI CODE GUIDE · 名称辞書"));
        for (const syntaxColor of ["--keyword:#c586c0", "--function:#dcdcaa", "--string:#ce9178", "--number:#b5cea8", "--comment:#6a9955", "--name:#9cdcfe", "--type:#4ec9b0", "--decorator:#dcdcaa"]) {
            assert.ok(inlineView.body.includes(syntaxColor), `inline view defines ${syntaxColor}`);
        }
        assert.ok(!inlineView.body.includes("各要素を順番に表示する。"));
        assert.ok(inlineView.body.includes("標準出力へ値を書き出す。"));
        assert.ok(inlineView.body.includes("関数 main"));
        assert.ok(inlineView.body.includes('content.append(renderScope())'));
        assert.ok(!inlineView.body.includes('blockLane'));
        assert.ok(!inlineView.body.includes('note-lane'));
        assert.ok(!inlineView.body.includes('text-decoration-style:dotted'));
        assert.ok(inlineView.body.includes('.symbol-anchor{display:inline;color:inherit;text-decoration:none;background:none'));
        assert.ok(inlineView.body.includes('anchor.tabIndex=0'));
        assert.ok(inlineView.body.includes('const showCard=(anchor,item,pinned=false,canUndo=false)=>'));
        assert.ok(inlineView.body.includes('const positionCard=(anchor,pinned=false)=>'));
        assert.ok(inlineView.body.includes('pinned?Math.max(8,above)'));
        assert.ok(inlineView.body.includes('requestAnimationFrame(()=>positionCard(anchor,pinned))'));
        assert.ok(inlineView.body.includes('anchor.addEventListener("mouseenter",()=>{if(!pinnedKey)showCard(anchor,item)})'));
        assert.ok(inlineView.body.includes('question.addEventListener("click",event=>{event.stopPropagation();pin(anchor,item)}'));
        assert.ok(inlineView.body.includes('anchor.addEventListener("mouseleave",scheduleHoverHide)'));
        assert.ok(inlineView.body.includes('card.addEventListener("mouseenter",cancelHoverHide);card.addEventListener("mouseleave",scheduleHoverHide)'));
        assert.ok(!inlineView.body.includes('.symbol-card.hovering{pointer-events:none}'));
        assert.ok(inlineView.body.includes('const pin=(anchor,item)=>'));
        assert.ok(inlineView.body.includes('placeholder="この名前について質問"'));
        assert.ok(inlineView.body.includes('"質問する"'));
        assert.ok(inlineView.body.includes('.loading::before{content:""'));
        assert.ok(inlineView.body.includes('animation:spin .7s linear infinite'));
        assert.ok(inlineView.body.includes('button.setAttribute("aria-busy","true")'));
        assert.ok(inlineView.body.includes('button.textContent=mode==="undo"?"戻しています":"回答待ち"'));
        assert.ok(inlineView.body.includes('button.classList.remove("loading")'));
        assert.ok(inlineView.body.includes('button.removeAttribute("aria-busy")'));
        assert.ok(inlineView.body.includes('button.textContent=originalLabel'));
        assert.ok(inlineView.body.includes('"前の説明に戻す"'));
        assert.ok(inlineView.body.includes('fetch("/view/"+viewId+"/ask"'));
        assert.ok(inlineView.body.includes(".code-token-match"));
        assert.ok(inlineView.body.includes('document.documentElement.dataset.codeSurface="shared-v2"'));
        assert.ok(inlineView.body.includes("span.dataset.codeToken=token"));
        assert.ok(inlineView.body.includes('document.addEventListener("dblclick"'));
        assert.ok(inlineView.body.includes("range.selectNodeContents(target)"));
        assert.ok(inlineView.body.includes('anchor.addEventListener("click"'));
        assert.ok(inlineView.body.includes('event.key==="Escape"&&pinnedKey'));
        assert.ok(inlineView.body.includes('document.addEventListener("click",event=>{if(!pinnedKey)return'));
        assert.ok(inlineView.body.includes('target?.closest?.(".symbol-card")||target?.closest?.(".symbol-anchor")'));
        assert.ok(inlineView.body.includes('.code-lines{display:grid;width:max-content;min-width:100%;padding-top:var(--pinned-card-offset,0px)}'));
        assert.ok(inlineView.body.includes('const clearPinnedOffset=()=>document.querySelector(".code-lines")?.style.removeProperty("--pinned-card-offset")'));
        assert.ok(inlineView.body.includes('const baseTop=target.top-current;const desired=Math.max(0,bounds.height+16-baseTop)'));
        assert.ok(inlineView.body.includes('lines.style.setProperty("--pinned-card-offset",desired+"px");target=anchor.getBoundingClientRect()'));
        assert.ok(inlineView.body.includes('const closePinned=()=>{cancelHoverHide();clearPinnedOffset();pinnedKey=null;hideCard()}'));
        assert.ok(inlineView.body.includes('const pin=(anchor,item)=>{cancelHoverHide();clearPinnedOffset();pinnedKey=item.symbolKey'));
        assert.ok(inlineView.body.includes('event.detail===1&&!window.getSelection()?.toString()'));
        assert.ok(!inlineView.body.includes('anchor.title='));
        assert.ok(inlineView.body.includes('cell.append(annotatedPython(rowData.text.slice(baseIndent),items.filter(item=>item.startLine===rowData.line),baseIndent))'));
        assert.ok(inlineView.body.includes('anchor.dataset.symbolKey=item.symbolKey'));
        assert.ok(inlineView.body.includes('.code-cell{position:relative;min-width:max-content;padding-right:14px'));
        assert.ok(!inlineView.body.includes('symbol-note'));
        assert.ok(!inlineView.body.includes('items.forEach(item=>content.append(render(item)))'));
        assert.ok(inlineView.body.includes("範囲をVS Codeで開く"));
        assert.ok(inlineView.body.includes("textContent=String(text)"));
        assert.ok(!inlineView.body.includes("innerHTML"));
        assert.ok(inlineView.body.includes('fetch("/view/"+viewId+"/state"'));
        const inlineUpdate = await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "inline", file: "src/main.py", startLine: 3, endLine: 3, run: true,
        });
        assert.strictEqual(inlineUpdate.status, 200);
        const inlineState = await request(`${inlineBody.codexView.url}/state`);
        assert.strictEqual(inlineState.status, 200);
        assert.deepStrictEqual(
            JSON.parse(inlineState.body).annotations.items.map((item) => item.id),
            ["annotation-2", "annotation-3"],
        );
        const refreshedInlineView = await request(inlineBody.codexView.url);
        assert.ok(refreshedInlineView.body.includes("現在処理しているitemを渡す。"));
        const asked = await request(`${inlineBody.codexView.url}/ask`, "POST", {
            symbolKey: "main|function|print", question: "何を出力する？",
        });
        assert.strictEqual(asked.status, 200);
        const askedBody = JSON.parse(asked.body);
        assert.strictEqual(askedBody.explanation, "print() は受け取った値を標準出力へ表示する関数です。");
        assert.deepStrictEqual(askedBody.history, [
            { role: "user", content: "何を出力する？" },
            { role: "assistant", content: "回答: 何を出力する？" },
        ]);
        assert.deepStrictEqual(symbolUpdates.at(-1), {
            file: "src/main.py",
            symbolKey: "main|function|print",
            explanation: "print() は受け取った値を標準出力へ表示する関数です。",
        });
        assert.strictEqual(
            JSON.parse((await request(`${inlineBody.codexView.url}/state`)).body).annotations.items
                .find((item) => item.symbolKey === "main|function|print").explanation,
            askedBody.explanation,
        );
        const undone = await request(`${inlineBody.codexView.url}/ask`, "POST", {
            symbolKey: "main|function|print", mode: "undo",
        });
        assert.strictEqual(undone.status, 200);
        assert.strictEqual(JSON.parse(undone.body).explanation, "標準出力へ値を書き出す。");
        assert.strictEqual((await request(`${inlineBody.codexView.url}/ask`, "POST", {
            symbolKey: "missing", question: "これは何？",
        })).status, 400);
        const inlineRevision = await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "inline", file: "src/main.py", startLine: 3, endLine: 3, run: true,
            removeAnnotationIds: ["annotation-2"], hideAnnotationIds: ["annotation-1"],
        });
        assert.strictEqual(inlineRevision.status, 200);
        const revisedState = JSON.parse((await request(`${inlineBody.codexView.url}/state`)).body);
        assert.deepStrictEqual(revisedState.annotations.items.map((item) => item.id), ["annotation-3"]);
        assert.strictEqual(revisedState.annotations.items[0].explanation, "置き換え後はitemの役割を説明する。");
        assert.deepStrictEqual(shown.at(-1), {
            view: "inline", absoluteFile: sourceFile, line: undefined, startLine: 3, endLine: 3,
            removeAnnotationIds: ["annotation-2"], hideAnnotationIds: ["annotation-1"],
            question: undefined, run: true,
        });
        assert.strictEqual((await request(`${inlineBody.codexView.url}/state`, "POST")).status, 405);
        const inlineOpen = await request(`${inlineBody.codexView.url}/open`, "POST", { file: "src/main.py", line: 2 });
        assert.strictEqual(inlineOpen.status, 204);
        assert.deepStrictEqual(opened.at(-1), { absolutePath: sourceFile, line: 1 });
        ok("名称だけを無装飾コード上へ載せ、質問・説明更新・undo・既存表示同期を自己完結表示する");

        const diagram = await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "diagram", file: "src/main.py", question: "mainの処理順", run: true, activate: false,
        });
        assert.strictEqual(diagram.status, 200);
        const diagramBody = JSON.parse(diagram.body);
        assert.strictEqual(diagramBody.codexView.type, "browser");
        assert.strictEqual(diagramBody.codexView.view, "diagram");
        const diagramView = await request(diagramBody.codexView.url);
        assert.strictEqual(diagramView.status, 200);
        assert.ok(diagramView.body.includes("AI CODE GUIDE · 図"));
        assert.ok(diagramView.body.includes('aria-label="ノードに対応するPythonコード"'));
        assert.ok(diagramView.body.includes('class="pd-flow-canvas"'));
        assert.ok(diagramView.body.includes('class="pd-node pd-flow-shape'));
        assert.ok(diagramView.body.includes('class="pd-flow-details"'));
        assert.ok(diagramView.body.includes('data-file="src/main.py"'));
        assert.ok(diagramView.body.includes('data-line="2"'));
        assert.ok(diagramView.body.includes("class Runner:"));
        assert.ok(diagramView.body.includes('document.documentElement.dataset.codeSurface="shared-v2"'));
        assert.ok(diagramView.body.includes('document.querySelector(".diagram-pane").addEventListener("click"'));
        assert.ok(diagramView.body.includes('event.target.closest(".pd-flow-shape")'));
        assert.ok(diagramView.body.includes('event.target.closest(".pd-detail-jump,.pd-node-jump")'));
        assert.ok(!diagramView.body.includes('event.target.closest(".pd-node[data-file]");if(!node)return;event.preventDefault();focusNode(node)'));
        assert.ok(diagramView.body.includes('if(workspace.classList.contains("code-hidden"))setCodeHidden(false)'));
        assert.ok(diagramView.body.includes('row.scrollIntoView({block:"center",inline:"nearest"})'));
        assert.ok(!diagramView.body.includes('sourceLines.addEventListener("click"'));
        assert.ok(diagramView.body.includes('role="separator"'));
        assert.ok(diagramView.body.includes('aria-label="コードと図の幅を調整"'));
        assert.ok(diagramView.body.includes('splitter.setPointerCapture(pointerId)'));
        assert.ok(diagramView.body.includes('sessionStorage.setItem(splitKey'));
        assert.ok(diagramView.body.includes('event.key==="ArrowRight"'));
        assert.ok(diagramView.body.includes('id="toggle-code"'));
        assert.ok(diagramView.body.includes('class="diagram-overview"'), "Codex diagram shows its semantic overview immediately above the diagram");
        assert.ok(diagramView.body.includes("対象コード"), "diagram overview identifies the concrete function or method scope");
        assert.ok(diagramView.body.includes('document.getElementById("diagram-scope").textContent=data.scopeText'), "diagram renders the derived code scope separately from its semantic summary");
        assert.ok(diagramView.body.includes('"scopeText":"src/main.py · Runner.main()"'), "diagram scope contains the implementation file and callable name");
        assert.ok(diagramView.body.includes('"このフロー図が表す処理"'), "flow diagrams label the whole-flow explanation explicitly");
        assert.ok(diagramView.body.includes('document.getElementById("summary").textContent=data.diagram.summary||data.question'), "generated summary remains the primary explanation with the question as fallback");
        assert.ok(!diagramView.body.includes('<div class="header-actions"><p class="summary"'), "diagram meaning is not relegated to small header text");
        assert.ok(diagramView.body.includes('workspace.classList.toggle("code-hidden",hidden)'));
        assert.ok(diagramView.body.includes('hidden?"コードを表示":"コードを隠す"'));
        assert.ok(diagramView.body.includes('.workspace.code-hidden{grid-template-columns:minmax(0,1fr)}'));
        assert.ok(diagramView.body.includes('.workspace.code-hidden .diagram-pane{grid-column:1}'));
        assert.ok(diagramView.body.includes('grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr)'));
        assert.ok(diagramView.body.includes('.pd-node{max-width:100%;overflow:hidden;overflow-wrap:anywhere}'));
        assert.ok(diagramView.body.includes('.pd-node.selectable{grid-template-columns:minmax(0,1fr) auto'));
        assert.ok(diagramView.body.includes('.pd-flow-shape[aria-current="true"] .pd-shape-body'));
        assert.ok(diagramView.body.includes('.pd-detail-jump{display:inline-flex'));
        const diagramState = JSON.parse((await request(`${diagramBody.codexView.url}/state`)).body);
        assert.strictEqual(diagramState.diagram.title, "mainの処理順");
        ok("コード図を共通コード面付きHTMLで返し、図形選択後の詳細操作だけが該当実装へ移動する");

        const missingView = await request(`${link.baseUrl}/view/${"a".repeat(48)}`);
        assert.strictEqual(missingView.status, 410);
        assert.ok(missingView.body.includes("期限切れ"));
        ok("失効した表示URLを無言の404にせず再表示手順へ案内する");

        const standardTargets = await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "standard", file: "src/main.py", expandLines: [],
        });
        assert.strictEqual(standardTargets.status, 200);
        const standardBody = JSON.parse(standardTargets.body);
        assert.strictEqual(standardBody.codexView.type, "browser");
        assert.strictEqual(standardBody.codexView.view, "standard");
        const standardView = await request(standardBody.codexView.url);
        assert.strictEqual(standardView.status, 200);
        assert.ok(standardView.body.includes("AI CODE GUIDE · 標準"));
        assert.ok(standardView.body.includes("--function:#dcdcaa"));
        assert.ok(standardView.body.includes(".token-function{color:var(--function)}"));
        assert.ok(standardView.body.includes(".token-type{color:var(--type)}"));
        assert.ok(standardView.body.includes(".token-name{color:var(--name)}"));
        assert.ok(standardView.body.includes('const types=new Set("Array bigint bool'));
        assert.ok(standardView.body.includes("catch class const"));
        assert.ok(standardView.body.includes('cls="token-function"'));
        assert.ok(standardView.body.includes('aria-label="VS Code標準タブと同じカード一覧"'));
        assert.ok(standardView.body.includes("▼ クラスを開く"));
        assert.ok(standardView.body.includes("▶ クラスを閉じる"));
        assert.ok(!standardView.body.includes('<h2 class="standard-title">標準</h2>'));
        assert.ok(!standardView.body.includes('class="count" id="count"'));
        assert.ok(!standardView.body.includes("定義順にクラス・関数を表示"));
        assert.ok(standardView.body.includes('el("div","group-body")'));
        assert.ok(standardView.body.includes('el("div","card-block")'));
        assert.ok(standardView.body.includes("概要 "));
        assert.ok(!standardView.body.includes('class="tabs"'));
        assert.ok(!standardView.body.includes('"open-code","VS Code"'));
        assert.ok(standardView.body.includes("15%,transparent"));
        assert.ok(standardView.body.includes("22%,transparent"));
        assert.ok(standardView.body.includes("8%,transparent"));
        assert.ok(standardView.body.includes("32%,var(--side)"));
        assert.ok(standardView.body.includes("12%,var(--side)"));
        assert.ok(standardView.body.includes("pointer-events:none"));
        assert.ok(standardView.body.includes("let statusTimer=0"));
        assert.ok(standardView.body.includes("clearTimeout(statusTimer)"));
        assert.ok(standardView.body.includes("user-select:text;cursor:text"));
        assert.ok(standardView.body.includes('const applyCardSelection=()=>'));
        assert.ok(standardView.body.includes('card.onclick=()=>focusItem(item)'));
        assert.ok(standardView.body.includes("selectableDoubleClick(event,card)"));
        assert.ok(standardView.body.includes("range.selectNodeContents(target)"));
        assert.ok(!standardView.body.includes("nameClickTimer"));
        assert.ok(!standardView.body.includes("selectedId=item.id;renderCards();applySource()"));
        assert.ok(!standardView.body.includes("row.onclick=()=>{const unit=unitForLine(entry.line)"));
        assert.ok(standardView.body.includes("card.onclick=()=>focusItem(item)"));
        assert.ok(standardView.body.includes("white-space:pre;user-select:text;cursor:text"));
        assert.ok(standardView.body.includes(".code-token-match"));
        assert.ok(standardView.body.includes("span.dataset.codeToken=token"));
        assert.ok(standardView.body.includes('document.documentElement.dataset.codeSurface="shared-v2"'));
        assert.ok(standardView.body.includes('codeSurface.appendPython(code,entry.text)'));
        assert.ok(standardView.body.includes('" の説明を展開しました。",false,2400'));
        assert.ok(standardView.body.includes('"分解できませんでした。",true,6000'));
        assert.ok(standardView.body.includes('(inside&&meaning?" selected":"")'));
        assert.ok(standardView.body.includes('meaning?.color||"transparent"'), "uncached source never falls back to definition colors");
        assert.ok(standardView.body.includes("scrollIntoView({block:\"center\",inline:\"nearest\"})"));
        assert.ok(standardView.body.includes(".label{min-width:0;flex:1;overflow-wrap:anywhere;white-space:normal"));
        assert.ok(!standardView.body.includes(".label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis"));
        assert.ok(standardView.body.includes('var(--unit-color) 12%,transparent'));
        assert.ok(standardView.body.includes('box-shadow:inset 2px 0 var(--unit-color)'), 'selection marks the edge without overwriting semantic fill');
        const vscodeStandardSource = fs.readFileSync(path.join(__dirname, "../src/view/mainViewProvider.ts"), "utf8");
        for (const sharedTone of ["0.15", "22%", "8%", "32%", "12%", "0.06"]) {
            assert.ok(vscodeStandardSource.includes(sharedTone), `VS Code標準タブに共通配色 ${sharedTone} がある`);
        }
        assert.deepStrictEqual(shown.at(-1), {
            view: "standard", absoluteFile: sourceFile, line: undefined, expandLines: [], question: undefined, run: false,
        });
        const focusedStandard = await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "standard", file: "src/main.py", expandLines: [2], scopeLine: 1, visibleExpandLines: [2],
        });
        assert.strictEqual(focusedStandard.status, 200);
        const focusedStandardBody = JSON.parse(focusedStandard.body);
        assert.deepStrictEqual(focusedStandardBody.standard.source.map((entry) => entry.line), [1, 2, 3]);
        assert.deepStrictEqual(focusedStandardBody.standard.items.map((item) => item.id), ["class-1", "method-2"]);
        assert.strictEqual(focusedStandardBody.standard.items[1].expanded, true);
        assert.strictEqual(focusedStandardBody.standard.title, "Runner · main.py");
        assert.deepStrictEqual(shown.at(-1), {
            view: "standard", absoluteFile: sourceFile, line: undefined, scopeLine: 1, expandLines: [2],
            visibleExpandLines: [2], question: undefined, run: false,
        });
        const standardExpand = await request(`${standardBody.codexView.url}/expand`, "POST", { line: 2 });
        assert.strictEqual(standardExpand.status, 200);
        assert.strictEqual(JSON.parse(standardExpand.body).standard.items[1].expansion.overview.purpose, "固定値を返す。");
        assert.deepStrictEqual(shown.at(-1), {
            view: "standard", absoluteFile: sourceFile, line: 2, expandLines: [2], activate: false,
        });
        const standardState = JSON.parse((await request(`${standardBody.codexView.url}/state`)).body);
        assert.strictEqual(standardState.standard.items[1].expansion.blocks[0].label, "値を返す");
        assert.strictEqual((await request(`${standardBody.codexView.url}/expand`, "GET")).status, 405);
        assert.strictEqual((await request(`${standardBody.codexView.url}/expand`, "POST", { line: 99 })).status, 400);
        const standardOpen = await request(`${standardBody.codexView.url}/open`, "POST", { file: "src/main.py", line: 2 });
        assert.strictEqual(standardOpen.status, 204);
        assert.deepStrictEqual(opened.at(-1), { absolutePath: sourceFile, line: 1 });
        ok("標準ビューの対象0件を全件化せず、VS Code準拠カード・詳細生成・コード移動を同じブラウザURLで提供する");

        const combined = await request(`${link.baseUrl}/combine?token=test-token`, "POST", {
            viewIds: [standardBody, diagramBody, showBody, inlineBody].map((body) => body.codexView.url.split("/").at(-1)),
        });
        assert.strictEqual(combined.status, 200);
        const combinedBody = JSON.parse(combined.body);
        assert.strictEqual(combinedBody.view, "combined");
        assert.strictEqual(combinedBody.codexView.view, "combined");
        const combinedView = await request(combinedBody.codexView.url);
        assert.ok(combinedView.body.includes('const appendPython=(parent,text,beforeContext="",afterContext="")=>codeSurface.appendPython(parent,text,beforeContext,afterContext)'));
        assert.ok(combinedView.body.includes("appendPython(anchor,text.slice(start,end),text.slice(0,start),text.slice(end))"));
        assert.strictEqual(combinedView.status, 200);
        assert.ok(!combinedView.body.includes('class="eyebrow"'), "combined header omits redundant product branding");
        assert.ok(combinedView.body.includes("min-height:38px;padding:5px 8px 5px 13px"), "single shared header preserves vertical code space");
        for (const marker of [
            "サイドバーをしまう", "サイドバーを開く", "標準ビュー", "コード図",
            ".source-row.in-unit", "trace-note", "symbol-anchor", "fetch(\"/view/\"+viewId+\"/expand\"",
            "fetch(\"/view/\"+viewId+\"/ask\"",
        ]) assert.ok(combinedView.body.includes(marker), `combined view includes ${marker}`);
        assert.ok(combinedView.body.includes("mainが固定値を返す。"));
        assert.ok(combinedView.body.includes('blockColors=["#4ec9b0","#d7ba7d","#c586c0"'));
        assert.ok(combinedView.body.includes("--pd-line:#d7ba7d"), "dark unified diagram keeps edges and arrowheads visible");
        assert.ok(combinedView.body.includes("item.meaningRanges"));
        assert.ok(!combinedView.body.includes("trace-hit"), "trace values must not add a dot beside the line number");
        assert.ok(combinedView.body.includes('class="panel trace-panel"'), "trace shares the sidebar frame");
        assert.ok(combinedView.body.includes('class="header-tools"><div class="tabs" id="tabs"'), "shared-view tabs stay in the common header");
        assert.ok(!combinedView.body.includes("sidebar-head"), "sidebar content starts level with code content");
        assert.ok(combinedView.body.includes('addTab("trace","実行トレース")'), "trace is a sidebar tab");
        assert.ok(!combinedView.body.includes(".source-lines{display:grid;grid-template-columns"), "source uses the full code column");
        assert.ok(combinedView.body.includes(".source-pane{min-width:0;min-height:0;overflow:auto"), "both panes own their horizontal scroll");
        assert.ok(combinedView.body.includes("height:var(--line-height);padding:0 12px;color:var(--muted);white-space:pre"), "long trace notes stay on one fixed-height row");
        assert.ok(!combinedView.body.includes("trace-line"), "aligned trace does not need duplicate line numbers");
        assert.ok(combinedView.body.includes("const syncVertical=(from,to)=>"), "independent panes keep corresponding rows vertically aligned");
        assert.ok(combinedView.body.includes("値を返す"), "prepared standard details start expanded");
        const combinedState = JSON.parse((await request(`${combinedBody.codexView.url}/state`)).body);
        assert.strictEqual(combinedState.view, "combined");
        assert.strictEqual(combinedState.standard.items.length, 2);
        assert.strictEqual(combinedState.trace.functions[0].funcName, "main");
        assert.strictEqual(combinedState.annotations.items.length, 1);
        const combinedExpand = await request(`${combinedBody.codexView.url}/expand`, "POST", { line: 2 });
        assert.strictEqual(combinedExpand.status, 200);
        assert.strictEqual(JSON.parse(combinedExpand.body).standard.items[1].expansion.overview.purpose, "固定値を返す。");
        const combinedAsk = await request(`${combinedBody.codexView.url}/ask`, "POST", {
            symbolKey: combinedState.annotations.items[0].symbolKey, question: "どこへ出ますか？",
        });
        assert.strictEqual(combinedAsk.status, 200);
        assert.ok(JSON.parse(combinedAsk.body).explanation.includes("標準出力"));
        ok("4ビューを一つのコード面へ合成し、右ペイン切替・格納・標準展開・名称質問を維持する");

        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "settings" })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "diagram" })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "inline", file: "../outside.py" })).status, 403);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "standard", expandLines: [0] })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "standard", scopeLine: 0 })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "overview", scopeLine: 1 })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "standard", visibleExpandLines: [0] })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "overview", expandLines: [1] })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "trace", functions: [""] })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "inline", startLine: 3, endLine: 2 })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", { view: "inline", startLine: 1 })).status, 400);
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", {
            view: "inline", file: "src/main.py", removeAnnotationIds: ["same"], hideAnnotationIds: ["same"],
        })).status, 400);
        assert.strictEqual(shown.length, 10);
        ok("非公開ビュー・質問なしの図・ワークスペース外ファイルを拒否する");

        const oversized = JSON.stringify({ view: "standard", padding: "x".repeat(70 * 1024) });
        assert.strictEqual((await request(`${link.baseUrl}/show?token=test-token`, "POST", oversized)).status, 413);
        ok("過大なリクエスト本文を拒否する");
    } finally {
        bridge.dispose();
        assert.strictEqual(fs.existsSync(manifestPath), false);
        assert.strictEqual(fs.existsSync(registryPath), false);
        assert.strictEqual(fs.existsSync(activationPath), false);
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(`\n${passed}/19 passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
