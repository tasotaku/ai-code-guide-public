const http = require("http");
const { buildCodeEvidenceAppShell } = require("../out/mcp/codeEvidenceApp.js");

const orderTrace = {
    file: "examples/order_trace.py",
    trace: {
        functions: [{
            funcName: "summarize_orders",
            startLine: 1,
            endLine: 9,
            code: [
                { line: 1, text: "    def summarize_orders(self, orders: list[dict]) -> dict[str, int]:" },
                { line: 2, text: "        # 顧客ごとの合計を作る" },
                { line: 3, text: "        totals: dict[str, int] = {}" },
                { line: 4, text: "        for order in orders:" },
                { line: 5, text: "            customer_id = str(order['customer_id'])" },
                { line: 6, text: "            subtotal = int(order.get('subtotal', 0))" },
                { line: 7, text: "            totals[customer_id] = totals.get(customer_id, 0) + subtotal" },
                { line: 8, text: "        return totals" },
                { line: 9, text: "" },
            ],
            loop: { headerLine: 4, total: 2, actualTotal: 2 },
            iterations: [
                { number: 1, values: [
                    { line: 4, text: "order={'customer_id': 'customer-001', 'subtotal': 12840}" },
                    { line: 5, text: "customer_id='customer-001'" },
                    { line: 6, text: "subtotal=12840" },
                    { line: 7, text: "totals={'customer-001': 12840}" },
                ] },
                { number: 2, values: [
                    { line: 4, text: "order={'customer_id': 'customer-002', 'subtotal': 3500}" },
                    { line: 5, text: "customer_id='customer-002'" },
                    { line: 6, text: "subtotal=3500" },
                    { line: 7, text: "totals={'customer-001': 12840, 'customer-002': 3500}" },
                ] },
            ],
            executedLines: [1, 3, 4, 5, 6, 7, 8],
            controlPoints: [{ line: 4 }],
            pathEvents: [{ line: 4, outcome: true }],
        }],
    },
};

const valueTrace = {
    file: "tests/test_ingestion.py",
    trace: {
        functions: [{
            funcName: "DocumentIngestionServiceTests.test_safe_document_is_published_and_quarantine_is_kept",
            startLine: 44,
            endLine: 55,
            code: [
                { line: 44, text: "    def test_safe_document_is_published_and_quarantine_is_kept(self) -> None:" },
                { line: 45, text: "        quarantine = RecordingQuarantine()" },
                { line: 46, text: "        repository = RecordingRepository()" },
                { line: 47, text: "        service = DocumentIngestionService(...)" },
                { line: 48, text: "" },
                { line: 49, text: "        result = service.ingest(self.request)" },
            ],
            iterations: [{ number: 1, values: [
                { line: 45, text: "quarantine=RecordingQuarantine(stored=[], deleted=[])" },
                { line: 46, text: "repository=RecordingRepository(published=[])" },
                { line: 49, text: "quarantine=RecordingQuarantine(stored=[QuarantinedFile(...)], deleted=[])" },
            ] }],
            executedLines: [44, 45, 46, 47, 49],
            controlPoints: [],
            pathEvents: [],
        }],
    },
};

const trace = process.env.ACG_VALUE_SMOKE === "1" ? valueTrace : orderTrace;

const payload = JSON.stringify({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: trace },
}).replace(/</g, "\\u003c");

const injected = `<script>
window.addEventListener("load",()=>setTimeout(()=>window.dispatchEvent(new MessageEvent("message",{source:window,data:${payload}})),20));
</script>`;
const page = buildCodeEvidenceAppShell().replace("</body>", `${injected}</body>`);

const server = http.createServer((request, response) => {
    if (request.url !== "/") {
        response.writeHead(404).end("Not found");
        return;
    }
    response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
    });
    response.end(page);
});

server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(`http://127.0.0.1:${address.port}/\n`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
