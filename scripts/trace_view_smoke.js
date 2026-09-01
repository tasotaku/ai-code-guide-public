#!/usr/bin/env node

const http = require("http");
const path = require("path");
const { ProjectDiagramBridge } = require("../out/view/projectDiagramBridge.js");

const workspaceRoot = path.join(__dirname, "..", "examples", "single_file");
const bridge = new ProjectDiagramBridge({
    getWorkspaceRoot: () => workspaceRoot,
    openFile: async (absoluteFile, zeroBasedLine) => {
        console.error(`open-code ${absoluteFile}:${zeroBasedLine + 1}`);
    },
    showView: async (request) => ({
        ok: true,
        view: "trace",
        file: "algorithms.py",
        trace: {
            funcNames: ["summarize_orders"],
            loopCount: 3,
            functions: [{
                funcName: "summarize_orders",
                startLine: 73,
                endLine: 82,
                code: [
                    { line: 73, text: "def summarize_orders(orders, discount_by_customer, quarantine_repository):" },
                    { line: 74, text: "    totals = {}  # customerごとの確定金額を記録する" },
                    { line: 75, text: "    for order in orders:" },
                    { line: 76, text: "        customer_id = order.customer_id" },
                    { line: 77, text: "        subtotal = sum(item.price * item.quantity for item in order.items)" },
                    { line: 78, text: "        discount = discount_by_customer.get(customer_id, Decimal('0'))" },
                    { line: 79, text: "        totals[customer_id] = max(Decimal('0'), subtotal - discount)" },
                    { line: 82, text: "    return totals" },
                ],
                loop: { headerLine: 75, total: 3, actualTotal: 3 },
                iterations: [
                    { number: 1, values: [{ line: 75, text: "order=Order(customer_id='customer-with-a-very-long-identifier-001', items=[…])" }, { line: 76, text: "customer_id='customer-with-a-very-long-identifier-001'" }, { line: 77, text: "subtotal=Decimal('12840')" }, { line: 78, text: "discount=Decimal('840')" }, { line: 79, text: "totals={'customer-with-a-very-long-identifier-001': Decimal('12000')}" }] },
                    { number: 2, values: [{ line: 75, text: "order=Order(customer_id='customer-002', items=[…])" }, { line: 76, text: "customer_id='customer-002'" }, { line: 77, text: "subtotal=Decimal('3500')" }, { line: 78, text: "discount=Decimal('500')" }, { line: 79, text: "totals={'customer-with-a-very-long-identifier-001': Decimal('12000'), 'customer-002': Decimal('3000')}" }] },
                    { number: 3, values: [{ line: 75, text: "order=Order(customer_id='customer-003', items=[…])" }, { line: 76, text: "customer_id='customer-003'" }, { line: 77, text: "subtotal=Decimal('7200')" }, { line: 78, text: "discount=Decimal('0')" }, { line: 79, text: "totals={… 'customer-003': Decimal('7200')}" }] },
                ],
            }],
        },
    }),
});

function requestJson(url, token, body) {
    return new Promise((resolve, reject) => {
        const target = new URL(`/show?token=${encodeURIComponent(token)}`, url);
        const request = http.request(target, { method: "POST", headers: { "Content-Type": "application/json" } }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
                catch (error) { reject(error); }
            });
        });
        request.on("error", reject);
        request.end(JSON.stringify(body));
    });
}

(async () => {
    const link = await bridge.start();
    if (!link) throw new Error("bridgeを起動できませんでした。");
    const result = await requestJson(link.baseUrl, link.token, { view: "trace", file: "algorithms.py", line: 73 });
    console.log(result.codexView.url);
    const keepAlive = setInterval(() => {}, 60_000);
    const shutdown = () => { clearInterval(keepAlive); bridge.dispose(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
})().catch((error) => {
    console.error(error);
    bridge.dispose();
    process.exit(1);
});
