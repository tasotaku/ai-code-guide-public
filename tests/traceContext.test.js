const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { collectTraceDependencyContext } = require("../out/inline/traceContext.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "acg-trace-context-"));
try {
    fs.mkdirSync(path.join(root, "tests"));
    fs.mkdirSync(path.join(root, "ingestion"));
    const entry = path.join(root, "tests", "test_ingestion.py");
    const source = "from ingestion.service import DocumentIngestionService\n\ndef test_trace():\n    return DocumentIngestionService\n";
    fs.writeFileSync(entry, source);
    fs.writeFileSync(path.join(root, "ingestion", "service.py"), "from .models import UploadRequest\n\nclass DocumentIngestionService:\n    def ingest(self, request):\n        return request\n");
    fs.writeFileSync(path.join(root, "ingestion", "models.py"), "class UploadRequest:\n    pass\n");

    const context = collectTraceDependencyContext(entry, root, source);
    assert.match(context, /workspace-local dependency: ingestion\/service\.py/);
    assert.match(context, /class DocumentIngestionService/);
    assert.match(context, /workspace-local dependency: ingestion\/models\.py/);

    const bounded = collectTraceDependencyContext(entry, root, source, { maxFiles: 1 });
    assert.match(bounded, /service\.py/);
    assert.doesNotMatch(bounded, /models\.py/);
    assert.strictEqual(collectTraceDependencyContext("C:\\outside\\test.py", root, source), "");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

console.log("trace safety local dependency context 4件 passed");
