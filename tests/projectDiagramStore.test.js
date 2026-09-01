const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ProjectDiagramStore } = require("../out/view/projectDiagramStore.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acg-project-diagrams-"));
const diagram = {
    kind: "flow",
    title: "注文が保存されるまで",
    nodes: [
        { id: "n1", file: "src/orders.py", symbol: "create_order", anchor: "def create_order", label: "注文を受け付ける", line: 12 },
        { id: "n2", file: "src/repository.py", symbol: "save", anchor: "def save", label: "注文を保存する", line: 28 },
    ],
    edges: [{ from: "n1", to: "n2", label: "" }],
};

{
    const store = new ProjectDiagramStore(dir);
    const entry = store.add("/work/a", "注文が保存されるまで", diagram);
    assert.strictEqual(store.list("/work/a").length, 1);
    assert.strictEqual(store.list("/work/a")[0].id, entry.id);
    assert.deepStrictEqual(store.list("/work/a")[0].diagram, diagram);
    ok("図をワークスペース別に保存する");
}

{
    const store = new ProjectDiagramStore(dir);
    assert.strictEqual(store.list("/work/a")[0].question, "注文が保存されるまで");
    assert.strictEqual(store.list("/work/b").length, 0);
    ok("再構築後も図が残り、別ワークスペースと混ざらない");
}

{
    const store = new ProjectDiagramStore(dir);
    const id = store.list("/work/a")[0].id;
    store.remove("/work/a", id);
    assert.strictEqual(new ProjectDiagramStore(dir).list("/work/a").length, 0);
    ok("指定した図だけを削除する");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed}/3 passed`);
process.exit(passed === 3 ? 0 : 1);
