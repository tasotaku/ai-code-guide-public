const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildProjectDiagramSourceExcerpt } = require("../out/view/projectDiagramContext.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acg-diagram-context-"));
const file = path.join(dir, "long.py");
try {
    fs.writeFileSync(file, [
        "import sqlite3",
        `PADDING = ${JSON.stringify("x".repeat(5000))}`,
        "",
        "def early():",
        "    return 'skip'",
        "",
        "def wanted(value):",
        "    prepared = helper(value)",
        "    return prepared",
        "",
        "def helper(value):",
        "    return value + 1",
    ].join("\n"));

    const excerpt = buildProjectDiagramSourceExcerpt(file, ["early", "wanted", "helper"], "wanted() から helper() まで");
    assert.ok(excerpt.includes("def wanted(value):"));
    assert.ok(excerpt.includes("prepared = helper(value)"));
    assert.ok(excerpt.includes("def helper(value):"));
    assert.ok(!excerpt.includes("def early():"));
    console.log("  ok - 1800文字以降でも質問で指定した関数本体と呼び出しを収集する");

    const fallback = buildProjectDiagramSourceExcerpt(file, ["early", "wanted", "helper"], "別の処理");
    assert.ok(fallback.length < 1900);
    assert.ok(fallback.endsWith("# ... (truncated)"));
    console.log("  ok - 関連シンボルが無い長いファイルは従来どおり小さく保つ");
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n2/2 passed");
