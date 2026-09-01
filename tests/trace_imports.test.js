// trace_runner.py の import 解決の回帰テスト。
// 対象ファイルがプロジェクト内の自作モジュールを import している場合に、通常実行と同じように
// 解決できることを担保する(かつて sys.path を一切通しておらず ModuleNotFoundError で全滅した)。
const { spawnSync } = require("child_process");
const path = require("path");
const { findPython } = require("./pythonCommand");

const SCRIPT = path.join(__dirname, "..", "python", "trace_runner.py");
const ROOT = path.join(__dirname, "fixtures", "trace_pkg");
const python = findPython();

let failed = 0;

// AI_NOTE: file_path を渡した時だけ cwd も実ファイル位置にする(本番 traceRunner.ts と同じ条件)。
function trace(file, { withPath = true } = {}) {
    const target = path.join(ROOT, file);
    const payload = {
        source: require("fs").readFileSync(target, "utf8"),
        func_name: "merge_wants",
        setup: "EXAMPLE_ARGS = ([1, 2],)",
        templates: {},
        ...(withPath ? { file_path: target, workspace_root: ROOT } : {}),
    };
    const cwd = withPath ? path.dirname(target) : require("os").tmpdir();
    const proc = spawnSync(python.command, [...python.args, SCRIPT], { input: JSON.stringify(payload), encoding: "utf8", cwd });
    try {
        return JSON.parse(proc.stdout);
    } catch {
        return { error: `出力が読めない: ${proc.stdout.slice(0, 200)} ${proc.stderr.slice(0, 300)}` };
    }
}

function check(name, result, expectedReturn) {
    const got = result.error ? `error: ${result.error}` : result.return_value?.short;
    if (got === expectedReturn) {
        console.log(`  ok - ${name}`);
        return;
    }
    failed += 1;
    console.log(`  NG - ${name}\n       expected: ${expectedReturn}\n       got:      ${got}`);
}

check(
    "パッケージ内の絶対import(from comiket.models import Circle)が解決される",
    trace("comiket/absolute.py"),
    "[Circle(day=1, serial=2), Circle(day=2, serial=4)]",
);
check(
    "パッケージ内の相対import(from . / from .models)が解決される",
    trace("comiket/relative.py"),
    "[Circle(day=1, serial=11), Circle(day=2, serial=11)]",
);
check(
    "パッケージ外スクリプトからワークスペースルート経由のimportが解決される",
    trace("scripts/outside.py"),
    "[1, 2]",
);
check(
    "file_path 未指定でも従来通り動く(import無しファイル)",
    trace("plain.py", { withPath: false }),
    "3",
);

console.log(failed === 0 ? "\n4/4 passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
