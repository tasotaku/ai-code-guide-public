// 単体テスト: token-usage.jsonl のロールアップ剪定が「全期間累計を保つ」不変条件を検証する。
// claudeClient.ts は vscode を import するので、smoke スクリプトと同じく Module._load で最小スタブを差す。
// 事前に `npm run compile` 済みであること(out/ を読む)。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// AI_NOTE: token 系関数は設定を読まないが、モジュール読み込み時の import "vscode" を解決するためにスタブを差す。
const fakeVscode = { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };
const origLoad = Module._load;
Module._load = (req, parent, isMain) => (req === "vscode" ? fakeVscode : origLoad.call(Module, req, parent, isMain));

const { initTokenLog, getAllTimeUsage, getUsageStats, resetAllTimeUsage } = require("../out/api/claudeClient.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acg-token-"));
const jsonl = path.join(dir, "token-usage.jsonl");
const rollup = path.join(dir, "token-usage-rollup.json");

// RAW_MAX_LINES=24000 / RAW_KEEP_LINES=20000。25000件入れて剪定を強制する。
// 評価対象外(古い5000件)は2020年、直近20000件は今にしておき、全期間累計とtoday集計を区別して検証する。
const OLD = 5000, RECENT = 20000, TOTAL = OLD + RECENT;
const IN = 10, OUT = 20, MODEL = "claude-haiku-4-5-20251001";
{
    const lines = [];
    const oldTs = new Date("2020-01-01T00:00:00Z").toISOString();
    const nowTs = new Date().toISOString();
    for (let i = 0; i < TOTAL; i++) {
        const ts = i < OLD ? oldTs : nowTs;
        lines.push(JSON.stringify({ ts, op: "test", model: MODEL, in: IN, out: OUT }));
    }
    fs.writeFileSync(jsonl, lines.join("\n") + "\n");
}

// 1. 剪定後も全期間累計は全件分(=ロールアップ+生ログ)で一致する
{
    initTokenLog(dir);
    const a = getAllTimeUsage();
    assert.strictEqual(a.input, TOTAL * IN, "全期間 input は全25000件分");
    assert.strictEqual(a.output, TOTAL * OUT, "全期間 output は全25000件分");
    ok("剪定しても全期間累計は全件分で保たれる");
}

// 2. 生ログは RAW_KEEP_LINES まで剪定され、ロールアップに古い分が退避される
{
    const remaining = fs.readFileSync(jsonl, "utf8").split("\n").filter((l) => l.trim()).length;
    assert.strictEqual(remaining, RECENT, "生ログは直近20000行へ剪定される");
    assert.ok(fs.existsSync(rollup), "ロールアップファイルが作られる");
    const r = JSON.parse(fs.readFileSync(rollup, "utf8"));
    assert.strictEqual(r.in, OLD * IN, "ロールアップには退避した5000件分が入る");
    assert.strictEqual(r.byModel[MODEL].out, OLD * OUT, "機種別にも退避分が積まれる");
    ok("生ログ剪定＋古い分のロールアップ退避");
}

// 3. getUsageStats: all は全件、today は直近の生ログのみ(設計どおり)。byModel は rollup+raw 合算
{
    const s = getUsageStats();
    assert.strictEqual(s.all.in, TOTAL * IN, "all は全件分");
    assert.strictEqual(s.today.in, RECENT * IN, "today は直近の生ログのみ");
    const m = s.byModel.find((x) => x.model === MODEL);
    assert.strictEqual(m.in, TOTAL * IN, "byModel は rollup+raw で全件分");
    ok("getUsageStats が rollup と生ログを正しく合算する");
}

// 4. 再起動(別 init)でも全期間累計が同じ(rollup を読み戻して二重計上しない)
{
    initTokenLog(dir);
    const a = getAllTimeUsage();
    assert.strictEqual(a.input, TOTAL * IN, "再 init でも input は全件分(二重計上なし)");
    ok("再 init で rollup を読み戻し二重計上しない");
}

// 5. resetAllTimeUsage は生ログ・ロールアップの両方を消し累計を0にする
{
    resetAllTimeUsage();
    const a = getAllTimeUsage();
    assert.strictEqual(a.input, 0, "リセット後 input=0");
    assert.strictEqual(a.output, 0, "リセット後 output=0");
    assert.ok(!fs.existsSync(jsonl), "生ログが消える");
    assert.ok(!fs.existsSync(rollup), "ロールアップが消える");
    ok("resetAllTimeUsage が生ログ・ロールアップ両方を消す");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed}/5 passed`);
process.exit(passed === 5 ? 0 : 1);
