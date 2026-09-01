// 単体テスト: designParser が設計mdを構造化し、仕様違反をissueとして返すことを確認する。
// 実行: npm test （内部で npm run compile → node tests/design-parser.test.js）
const assert = require("assert");
const { parseDesignFile } = require("../out/design/designParser.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

// メモの md 例そのまま（.claude/design-file-feature.md の「フォーマット（決定）」節）
const SAMPLE_MD = [
    "---",
    "source_file: src/search.py",
    "---",
    "",
    "# ファイル: search.py",
    "## 目的",
    "ユーザー検索のクエリ処理を担う。 <!-- @confirmed 2026-07-16 -->",
    "",
    "## 関数: search_users",
    "### 目的",
    "名前の部分一致でユーザーを探す。",
    "### 要件・制約",
    "- 10万件規模でも1秒以内 <!-- @confirmed -->",
    "- DBはインデックスなしのSQLite <!-- @inferred -->",
    "### 方針",
    "全件走査を避けるため先頭2文字でプレフィルタ。",
    "（捨てた代替: 全文検索エンジン導入 — 依存を増やしたくない）",
    "### 構成",
    '1. 入力の正規化 → anchor: "query = query.strip().lower()"',
    '2. プレフィルタ取得 → anchor: "prefix_rows ="',
    '3. 本検索と整形 → anchor: "results = ["',
].join("\n");

const SAMPLE_SOURCE = [
    "def search_users(query):",
    "    query = query.strip().lower()",
    "    prefix_rows = db.get(query[:2])",
    "    results = [r for r in prefix_rows if query in r.name.lower()]",
    "    return results",
].join("\n");

// 1. メモのmd例がそのまま正しく構造化される
{
    const { file, issues } = parseDesignFile(SAMPLE_MD, SAMPLE_SOURCE);
    assert.strictEqual(file.sourceFile, "src/search.py");
    assert.strictEqual(file.filePurpose.text, "ユーザー検索のクエリ処理を担う。");
    assert.strictEqual(file.filePurpose.provenance, "confirmed");
    assert.strictEqual(file.symbols.length, 1);
    const sym = file.symbols[0];
    assert.strictEqual(sym.kind, "function");
    assert.strictEqual(sym.name, "search_users");
    assert.strictEqual(sym.sections.purpose.text, "名前の部分一致でユーザーを探す。");
    assert.strictEqual(sym.sections.requirements.length, 2);
    assert.ok(sym.sections.policy.text.includes("プレフィルタ"));
    assert.strictEqual(sym.sections.construction.length, 3);
    assert.deepStrictEqual(sym.sections.construction.map((b) => b.order), [1, 2, 3]);
    assert.strictEqual(sym.sections.construction[0].anchor, "query = query.strip().lower()");
    // md例自体は関数の目的/方針に出所タグを付けていない(要件・制約のみ)ため、そこはwarningが出る想定。
    // ここでは「アンカー不明」「必須セクション欠け」に関するissueが出ないことだけを確認する。
    assert.strictEqual(issues.filter((i) => i.message.includes("アンカー")).length, 0, "アンカーは全部見つかりissueなし");
    assert.strictEqual(issues.filter((i) => i.message.includes("必須セクション欠け")).length, 0, "必須セクションはすべて揃っている");
    ok("md例がそのまま正しく構造化される");
}

// 2. confirmed / inferred / untagged の判別
{
    const { file } = parseDesignFile(SAMPLE_MD, SAMPLE_SOURCE);
    const reqs = file.symbols[0].sections.requirements;
    assert.strictEqual(reqs[0].provenance, "confirmed");
    assert.strictEqual(reqs[0].confirmedDate, undefined);
    assert.strictEqual(reqs[1].provenance, "inferred");

    const untaggedMd = SAMPLE_MD.replace(" <!-- @confirmed 2026-07-16 -->", "");
    const { file: file2 } = parseDesignFile(untaggedMd, SAMPLE_SOURCE);
    assert.strictEqual(file2.filePurpose.provenance, "untagged");
    ok("confirmed/inferred/untagged を正しく判別する");
}

// 3. source_file 欠けは error
{
    const md = ["---", "---", "# ファイル: x.py", "## 目的", "x <!-- @confirmed -->"].join("\n");
    const { issues } = parseDesignFile(md);
    const errs = issues.filter((i) => i.severity === "error");
    assert.ok(errs.length >= 1, "source_file欠けはerrorになる");
    assert.ok(errs.some((i) => i.message.includes("source_file")));
    ok("source_file欠けはerror");
}

// 4. 目的セクション欠けは warning（ファイル/関数の両方）
{
    const md = [
        "---",
        "source_file: src/x.py",
        "---",
        "# ファイル: x.py",
        "## 関数: foo",
        "### 要件・制約",
        "- 何か <!-- @confirmed -->",
    ].join("\n");
    const { issues } = parseDesignFile(md);
    const warns = issues.filter((i) => i.severity === "warning" && i.message.includes("必須セクション欠け"));
    assert.ok(warns.some((i) => i.message.includes("ファイル")), "ファイル全体の目的欠けをwarningにする");
    assert.ok(warns.some((i) => i.message.includes("foo")), "関数fooの目的欠けをwarningにする");
    ok("目的セクション欠けはwarning（ファイル/関数）");
}

// 5. アンカーが sourceText に無い = warning
{
    const md = [
        "---",
        "source_file: src/x.py",
        "---",
        "## 目的",
        "x <!-- @confirmed -->",
        "## 関数: foo",
        "### 目的",
        "y <!-- @confirmed -->",
        "### 構成",
        '1. ラベル → anchor: "存在しないコード片"',
    ].join("\n");
    const { issues } = parseDesignFile(md, "def foo():\n    return 1\n");
    const anchorWarns = issues.filter((i) => i.severity === "warning" && i.message.includes("アンカー"));
    assert.strictEqual(anchorWarns.length, 1);
    assert.ok(anchorWarns[0].message.includes("存在しないコード片"));
    ok("アンカーがsourceTextに無い場合はwarning");
}

// 6. アンカーが全部見つかる場合は issue なし（sourceText未指定なら検証自体スキップ）
{
    const { issues } = parseDesignFile(SAMPLE_MD); // sourceText未指定
    assert.strictEqual(issues.filter((i) => i.message.includes("アンカー")).length, 0, "sourceText未指定ならアンカー検証しない");
    const { issues: issues2 } = parseDesignFile(SAMPLE_MD, SAMPLE_SOURCE);
    assert.strictEqual(issues2.filter((i) => i.message.includes("アンカー")).length, 0, "全部見つかればissueなし");
    ok("アンカー全一致/未指定はissueなし");
}

// 7. クラスセクション
{
    const md = [
        "---",
        "source_file: src/x.py",
        "---",
        "## 目的",
        "x <!-- @confirmed -->",
        "## クラス: UserRepository",
        "### 目的",
        "ユーザーの永続化を担う。 <!-- @confirmed -->",
        "### 構成",
        '1. 初期化 → anchor: "def __init__"',
    ].join("\n");
    const { file, issues } = parseDesignFile(md, "class UserRepository:\n    def __init__(self):\n        pass\n");
    assert.strictEqual(file.symbols[0].kind, "class");
    assert.strictEqual(file.symbols[0].name, "UserRepository");
    assert.strictEqual(issues.filter((i) => i.severity === "error").length, 0);
    ok("クラスセクションを正しく構造化する");
}

// 8. 空mdでも例外を投げない
{
    assert.doesNotThrow(() => parseDesignFile(""));
    const { file, issues } = parseDesignFile("");
    assert.strictEqual(file.symbols.length, 0);
    assert.ok(issues.some((i) => i.severity === "error"), "frontmatter欠けはerrorになる");
    ok("空mdでも例外を投げず、frontmatter欠けerrorを返す");
}

console.log(`\n${passed}/8 passed`);
