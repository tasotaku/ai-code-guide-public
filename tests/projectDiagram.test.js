const assert = require("assert");
const path = require("path");
const { buildProjectDiagramHtml, buildStandaloneProjectDiagramHtml } = require("../out/view/projectDiagram.js");
const { buildStandardWebView } = require("../out/view/standardWebView.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

const flowDiagram = {
    kind: "flow",
    title: "認証結果の流れ",
    summary: "ログイン受付後、認証結果に応じてセッション生成またはエラー応答へ分岐する。",
    nodes: [
        { id: "entry", file: "api/auth.py", symbol: "login", anchor: "def login", label: "ログイン受付", role: "start", description: "入力された認証情報を受け付ける", line: 4 },
        { id: "decision", file: "api/auth.py", symbol: "login", anchor: "if authenticated:", label: "認証できたか", role: "decision", description: "認証結果によって処理を分ける", line: 8 },
        { id: "ok", file: "services/auth.py", symbol: "create_session", anchor: "def create_session", label: "セッション生成", role: "process", description: "認証済みユーザーのセッションを生成する", line: 18 },
        { id: "ng", file: "api/auth.py", symbol: "error_response", anchor: "def error_response", label: "エラー応答", role: "process", description: "認証失敗を示す応答を返す", line: 30 },
        { id: "done", file: "api/auth.py", symbol: "login", anchor: "return response", label: "応答を返す", role: "end", description: "作成した応答を呼び出し元へ返す", line: 34 },
    ],
    edges: [
        { from: "entry", to: "decision", label: "" },
        { from: "decision", to: "ok", label: "はい" },
        { from: "decision", to: "ng", label: "いいえ" },
        { from: "ok", to: "done", label: "" },
        { from: "ng", to: "done", label: "" },
        { from: "decision", to: "ok", label: "重複" },
        { from: "entry", to: "entry", label: "" },
        { from: "missing", to: "ok", label: "" },
    ],
};

const flowHtml = buildProjectDiagramHtml(flowDiagram);
assert.ok(flowHtml.includes('class="pd-layout pd-layout-flow pd-flowchart"'));
assert.ok(flowHtml.includes('class="pd-flow-scroll"'));
assert.ok(flowHtml.includes('class="pd-flow-canvas"'));
assert.ok(flowHtml.includes('width="328"'));
assert.ok(flowHtml.includes('aria-label="フローチャート。横に収まらない場合はスクロールできます"'));
assert.ok(flowHtml.includes('<polygon class="pd-shape-body"'));
assert.strictEqual((flowHtml.match(/class="pd-node pd-flow-shape/g) ?? []).length, 5);
assert.ok(flowHtml.includes('role-decision'));
assert.ok(flowHtml.includes('role-start'));
assert.ok(flowHtml.includes('role-end'));
assert.ok(flowHtml.includes('data-node-id="pd0"'));
assert.ok(flowHtml.includes('data-file="api/auth.py"'));
assert.ok(flowHtml.includes('data-line="5"'));
assert.ok(flowHtml.includes("ログイン受付"));
assert.ok(flowHtml.includes("入力された認証情報を受け付ける"));
assert.ok(flowHtml.includes("はい"));
assert.ok(flowHtml.includes("いいえ"));
assert.ok(!flowHtml.includes("重複"));
assert.ok(!flowHtml.includes("missing"));
assert.ok(flowHtml.includes('data-detail-id="pd1" hidden'));
assert.ok(flowHtml.includes("図形を選ぶと説明とコード位置を表示します。"));
ok("処理順を開始・判断・処理・終了の図形と分岐・合流線へ変換する");

const loopFlowHtml = buildProjectDiagramHtml({
    kind: "flow",
    title: "価格を合計するループ",
    nodes: [
        { id: "start", file: "price.py", symbol: "total", anchor: "subtotal = 0", label: "小計を初期化", role: "start", description: "小計を初期化する", line: 1 },
        { id: "loop", file: "price.py", symbol: "total", anchor: "for price in prices:", label: "次の価格を確認", role: "decision", description: "次の価格があるか確認する", line: 2 },
        { id: "add", file: "price.py", symbol: "total", anchor: "subtotal += price", label: "価格を加算", role: "process", description: "価格を小計へ足す", line: 3 },
        { id: "done", file: "price.py", symbol: "total", anchor: "return subtotal", label: "小計を返す", role: "end", description: "合計を返す", line: 4 },
    ],
    edges: [
        { from: "start", to: "loop", label: "" },
        { from: "loop", to: "add", label: "価格あり" },
        { from: "add", to: "loop", label: "次へ" },
        { from: "loop", to: "done", label: "加算完了" },
    ],
});
assert.strictEqual((loopFlowHtml.match(/pd-flow-edge-back/g) ?? []).length, 1);
assert.ok(loopFlowHtml.includes('data-edge-from="add" data-edge-to="loop"'));
assert.ok(loopFlowHtml.includes('class="pd-flow-back-label"'));
ok("ループの戻り線を外周レーンへ分離して通常分岐との重なりを避ける");

const standardHtml = buildStandardWebView({
    file: "price.py",
    standard: {
        title: "price.py",
        file: "price.py",
        source: [{ line: 1, text: "def total():" }],
        items: [{ id: "fn", kind: "function", label: "total()", line: 1, lineEnd: 1, color: "#4ec9b0" }],
    },
}, "view-1");
assert.ok(standardHtml.includes('item.expansion&&item.expanded!==false?"▼":"▶"'));
assert.ok(!standardHtml.includes('"詳しく読む"'));
ok("公開標準ビューの関数カードは三角トグルで詳細を開く");

const selectableFlowHtml = buildProjectDiagramHtml(flowDiagram, undefined, undefined, { selectableNodes: true });
assert.ok(selectableFlowHtml.includes('class="pd-node pd-flow-shape role-start"'));
assert.ok(selectableFlowHtml.includes('class="pd-flow-details"'));
assert.ok(selectableFlowHtml.includes('class="pd-detail-jump"'));
assert.ok(selectableFlowHtml.includes('aria-label="コードへ移動: ログイン受付"'));
assert.ok(!selectableFlowHtml.includes('<button type="button" class="pd-node'));
ok("図形の選択と詳細ペイン内のコード移動を別要素にする");

assert.ok(flowHtml.includes('data-node-id="pd0"'));
assert.ok(flowHtml.includes('data-node-id="pd1"'));
assert.ok(!flowHtml.includes("onclick="));
assert.ok(!flowHtml.includes("pd-reading-number"));
ok("処理順には番号を足さず、各ノードへ安全なクリック識別子を付ける");

const readingHtml = buildProjectDiagramHtml({
    kind: "reading",
    title: "注文機能の読解順",
    summary: "入口で全体像を把握し、中核の判断を追ってから、最後に保存の副作用を確認する。",
    nodes: [
        { id: "repository", file: "repository.py", symbol: "save", anchor: "def save", label: "保存処理", description: "注文データを永続化する", line: 30 },
        { id: "entry", file: "main.py", symbol: "run", anchor: "def run", label: "処理の入口", description: "注文処理全体を開始する", line: 4 },
        { id: "service", file: "service.py", symbol: "place_order", anchor: "def place_order", label: "中核処理", description: "注文可否を判断して処理を振り分ける", line: 12 },
    ],
    edges: [
        { from: "entry", to: "service", label: "" },
        { from: "service", to: "repository", label: "" },
    ],
});
assert.ok(readingHtml.includes('class="pd-layout pd-layout-reading"'));
assert.strictEqual((readingHtml.match(/pd-reading-number/g) ?? []).length, 3);
assert.strictEqual((readingHtml.match(/pd-reading-row/g) ?? []).length, 3);
assert.ok(!readingHtml.includes("pd-reading-link"));
assert.ok(readingHtml.indexOf("処理の入口") < readingHtml.indexOf("中核処理"));
assert.ok(readingHtml.indexOf("中核処理") < readingHtml.indexOf("保存処理"));
assert.ok(readingHtml.includes("注文処理全体を開始する"));
assert.ok(readingHtml.includes("注文可否を判断して処理を振り分ける"));
ok("読解順を番号・コード地点・各地点の説明を持つタイムラインへ変換する");

const dependencyHtml = buildProjectDiagramHtml({
    kind: "dependency",
    title: "注文保存の依存関係",
    summary: "注文処理は在庫確保、決済、永続化の3機能に依存する。",
    nodes: [
        { id: "order", file: "service.py", symbol: "place_order", anchor: "def place_order", label: "注文処理", description: "在庫確認から保存までを制御する", line: 12 },
        { id: "stock", file: "stock.py", symbol: "reserve", anchor: "def reserve", label: "在庫確保", description: "商品の在庫数を確認して確保する", line: 8 },
        { id: "payment", file: "payment.py", symbol: "charge", anchor: "def charge", label: "決済", description: "注文金額の支払いを確定する", line: 9 },
        { id: "save", file: "repository.py", symbol: "save", anchor: "def save", label: "注文保存", description: "注文データを永続化する", line: 30 },
    ],
    edges: [
        { from: "order", to: "stock", label: "" },
        { from: "order", to: "payment", label: "" },
        { from: "order", to: "save", label: "" },
    ],
});
assert.ok(dependencyHtml.includes('class="pd-layout pd-layout-dependency"'));
assert.ok(dependencyHtml.includes('class="pd-dependency-children"'));
assert.strictEqual((dependencyHtml.match(/class="pd-dependency-child"/g) ?? []).length, 3);
assert.ok(dependencyHtml.indexOf("在庫確保") < dependencyHtml.indexOf("決済"));
assert.ok(dependencyHtml.includes("商品の在庫数を確認して確保する"));
assert.ok(dependencyHtml.includes("reserve · stock.py"));
ok("依存先を説明・コード位置付きのアウトラインとして縦に積む");

const escaped = buildProjectDiagramHtml({
    title: "",
    nodes: [{ id: "x", file: "a.py", symbol: "", anchor: "", label: 'A < B & "C"', reason: "旧形式の目的句を表示するため", line: 0 }],
    edges: [],
});
assert.ok(escaped.includes('data-diagram-kind="flow"'));
assert.ok(escaped.includes('A &lt; B &amp; "C"'));
assert.ok(escaped.includes('<div class="pd-flow-detail-location">a.py:1</div>'));
assert.ok(!escaped.includes("旧形式の目的句を表示するため"));
ok("旧履歴は処理順として復元し、旧reasonを表示せずモデル文字列をHTMLとして解釈させない");

const emphasized = buildProjectDiagramHtml({
    kind: "flow",
    title: "強調",
    nodes: [
        { id: "start", file: "a.py", symbol: "start", anchor: "def start", label: "開始", description: "開始する。", line: 0 },
        { id: "risk", file: "a.py", symbol: "risk", anchor: "def risk", label: "失敗処理", description: "失敗を処理する。", emphasis: "warning", emphasisReason: "例外を捕捉せず、失敗時に後続処理が止まる。", line: 4 },
    ],
    edges: [{ from: "start", to: "risk", label: "失敗" }],
});
assert.ok(!emphasized.includes(" root"));
assert.ok(emphasized.includes("emphasis-warning"));
assert.ok(emphasized.includes('<span class="pd-flow-detail-badge">注意</span>'));
assert.ok(emphasized.includes('<p class="pd-flow-detail-reason">判断理由: 例外を捕捉せず、失敗時に後続処理が止まる。</p>'));
ok("起点を自動強調せず、AIが指定した地点の判断理由を選択詳細に保持する");

const successEmphasis = buildProjectDiagramHtml({
    kind: "flow",
    title: "推定された完了経路",
    nodes: [
        { id: "done", file: "a.py", symbol: "save", anchor: "def save", label: "保存", description: "データを保存する。", emphasis: "success", emphasisReason: "保存処理を終えて結果を返す。", line: 8 },
    ],
    edges: [],
});
assert.ok(successEmphasis.includes('class="pd-flow-detail-badge" title="AIがコード上の正常な完了経路と推定した箇所です。実行・テスト済みを意味しません。">問題なさそう</span>'));
assert.ok(successEmphasis.includes('<p class="pd-flow-detail-reason">AIの見立て: 保存処理を終えて結果を返す。（実行・テスト未確認）</p>'));
ok("成功強調をAIの推定と明示し、実行・テスト結果と区別する");

const standalone = buildStandaloneProjectDiagramHtml('認証 < 結果 & "確認"', flowDiagram);
assert.ok(standalone.startsWith("<!doctype html>"));
assert.ok(standalone.includes('<meta name="viewport"'));
assert.ok(standalone.includes("AI Code Guide preview"));
assert.ok(standalone.includes('質問: 認証 &lt; 結果 &amp; "確認"'));
assert.ok(standalone.includes("ログイン受付後、認証結果に応じて"));
assert.ok(standalone.includes("navigator.clipboard.writeText(location)"));
assert.ok(standalone.includes('node.dataset.file + ":" + node.dataset.line'));
assert.ok(!standalone.includes("https://"));
assert.ok(!standalone.includes("vscode.postMessage"));
assert.ok(!standalone.includes('href="vscode://'));
assert.ok(standalone.includes('class="pd-node pd-flow-shape'));
assert.ok(standalone.includes('class="pd-detail-jump"'));
assert.ok(standalone.includes('.pd-flow-canvas{display:block;width:auto;max-width:none'));
assert.ok(standalone.includes('font:650 13px/1.25'));
assert.ok(standalone.includes('font:700 12px/1.2'));
assert.ok(!standalone.includes('.pd-flow-canvas{width:100%'));
assert.ok(standalone.includes('scroll.scrollLeft=Math.max(0,(scroll.scrollWidth-scroll.clientWidth)/2)'));
ok("外部サービスなしの自己完結HTMLへ質問・概要・図・コード位置コピーをまとめる");

const vscodeWorkspace = path.resolve("test-workspaces", "My Project");
const vscodeLinked = buildStandaloneProjectDiagramHtml("認証結果を確認", flowDiagram, vscodeWorkspace);
const vscodeTarget = path.resolve(vscodeWorkspace, "api/auth.py").replace(/\\/g, "/");
const vscodeUrlPath = vscodeTarget.startsWith("/") ? vscodeTarget : `/${vscodeTarget}`;
const expectedVscodeHref = `href="vscode://file${encodeURI(vscodeUrlPath)}:5:1"`;
assert.ok(vscodeLinked.includes('<a class="pd-detail-jump"'));
assert.ok(vscodeLinked.includes(expectedVscodeHref));
assert.ok(vscodeLinked.includes("図形を選ぶと詳細を表示し、「コードへ」からVS Codeの該当行を開きます"));
assert.ok(!vscodeLinked.includes('document.addEventListener("click", async'));
assert.ok(!vscodeLinked.includes("await navigator.clipboard"));
assert.ok(!vscodeLinked.includes("window.location.href"));
assert.ok(vscodeLinked.includes("a要素の既定遷移を妨げない"));
assert.ok(vscodeLinked.includes('node.matches("a[href]")'));
assert.ok(vscodeLinked.indexOf('node.matches("a[href]")') < vscodeLinked.indexOf("navigator.clipboard.writeText(location)"));
ok("ワークスペース指定時はノードをVS Codeの実ファイル・行へ接続する");

const bridged = buildStandaloneProjectDiagramHtml(
    "認証結果を確認",
    flowDiagram,
    "/Users/test/My Project",
    { baseUrl: "http://127.0.0.1:43123", token: "secret-token" },
);
assert.ok(bridged.includes('href="http://127.0.0.1:43123/open?token=secret-token&amp;file=api%2Fauth.py&amp;line=5"'));
assert.ok(!bridged.includes('href="vscode://'));
ok("ブリッジ利用時は外部プロトコルでなくloopback HTTPへ接続する");

console.log(`\n${passed}/${passed} passed`);
