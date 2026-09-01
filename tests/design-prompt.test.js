// 単体テスト: buildDesignPrompt が3種のscopeそれぞれで正しい文言を出し、
// 埋め込んだmd記入例が designParser の文法と乖離していないこと(error issue 0件)を確認する。
// 実行: npm test （内部で npm run compile → node tests/design-prompt.test.js）
const assert = require("assert");
const { buildDesignPrompt } = require("../out/design/designPrompt.js");
const { parseDesignFile } = require("../out/design/designParser.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

// 1. 最重要: 埋め込んだmd記入例をparseDesignFileに通してerror issueが0件であること
//    (プロンプトとパーサの文法乖離を機械的に防ぐ)
{
    const prompt = buildDesignPrompt({ kind: "file", relPath: "src/search.py" });
    const fenceMatch = prompt.match(/```markdown\n([\s\S]*?)\n```/);
    assert.ok(fenceMatch, "プロンプト中にmarkdownフェンスの記入例があること");
    const { issues } = parseDesignFile(fenceMatch[1]);
    const errors = issues.filter((i) => i.severity === "error");
    assert.deepStrictEqual(errors, [], "記入例はparseDesignFileでerror issueを出さない");
    ok("埋め込みmd記入例がdesignParserの文法と一致(error 0件)");
}

// 2. パス規則(.ai-code-guide/design/)が本文に含まれること
{
    const prompt = buildDesignPrompt({ kind: "repo" });
    assert.ok(prompt.includes(".ai-code-guide/design/"), "置き場のパス規則が本文にあること");
    ok("パス規則(.ai-code-guide/design/)が本文に含まれる");
}

// 3. scope: repo → リポ全体向けの文言・_repo.md / _dir.md パスが入ること
{
    const prompt = buildDesignPrompt({ kind: "repo" });
    assert.ok(prompt.includes("_repo.md"), "repo scopeで_repo.mdに触れる");
    assert.ok(prompt.includes("_dir.md"), "repo scopeで_dir.mdにも触れる（主要ディレクトリ分）");
    ok("scope=repo: リポ全体の対象範囲・パスが明記される");
}

// 4. scope: directory → 指定したディレクトリの相対パスと_dir.mdが入ること
{
    const prompt = buildDesignPrompt({ kind: "directory", relPath: "src/design" });
    assert.ok(prompt.includes("src/design"), "directory scopeで指定relPathに触れる");
    assert.ok(prompt.includes(".ai-code-guide/design/src/design/_dir.md"), "directory scopeの出力先パス例が正しい");
    ok("scope=directory: 対象ディレクトリと出力先パスが明記される");
}

// 5. scope: file → 指定したファイルの相対パスと <relpath>.md 形式のパスが入ること
{
    const prompt = buildDesignPrompt({ kind: "file", relPath: "src/design/designParser.ts" });
    assert.ok(prompt.includes("src/design/designParser.ts"), "file scopeで指定relPathに触れる");
    assert.ok(
        prompt.includes(".ai-code-guide/design/src/design/designParser.ts.md"),
        "file scopeの出力先パス例が「相対パス+.md」形式である"
    );
    ok("scope=file: 対象ファイルと出力先パス(相対パス+.md)が明記される");
}

// 6. scope: repo → Context層の必須2セクションとヒアリング強制(@confirmed)の指示が入り、
//    file/directory scopeには混入しないこと
{
    const repoPrompt = buildDesignPrompt({ kind: "repo" });
    assert.ok(repoPrompt.includes("誰のどんな問題を解くか"), "repo scopeで「誰のどんな問題を解くか」セクションを要求する");
    assert.ok(repoPrompt.includes("主要ユースケース"), "repo scopeで「主要ユースケース」セクションを要求する");
    assert.ok(repoPrompt.includes("この2つは必ず確認にかけ"), "repo scopeの手順にContext層の確認必須指示がある");
    // フォーマット仕様節(_repo.mdの必須セクション説明)は全scope共通なので、
    // 混入チェックはrepo専用の確認指示文だけを対象にする
    const filePrompt = buildDesignPrompt({ kind: "file", relPath: "src/a.py" });
    assert.ok(!filePrompt.includes("この2つは必ず確認にかけ"), "file scopeにはrepo用の確認指示が混入しない");
    ok("scope=repo: Context層の必須セクションと確認必須指示が入る");
}

// 7. 手順が下書き→確認方式であること(白紙ヒアリング先行への回帰防止)
{
    const prompt = buildDesignPrompt({ kind: "file", relPath: "src/a.py" });
    assert.ok(prompt.includes("あなたがコード・README・コミット履歴を読み"), "手順1がAIの下書きから始まる");
    assert.ok(prompt.includes("下書きを開発者に見せ"), "手順2で開発者の正誤判定を求める");
    assert.ok(prompt.includes("@inferred\\` のまま残します") || prompt.includes("@inferred` のまま残します"), "開発者にも分からない項目は@inferredのまま残す");
    ok("手順が下書き→開発者確認の順である");
}

// 8. 更新モード: 既存mdを渡すと更新ルール(@confirmed維持)と既存md全文が埋め込まれ、
//    渡さなければ更新セクションが出ないこと
{
    const existing = "# ファイル: a.py\n## 目的\n既存の目的。 <!-- @confirmed 2026-07-16 -->";
    const updatePrompt = buildDesignPrompt({ kind: "file", relPath: "src/a.py" }, existing);
    assert.ok(updatePrompt.includes("今回は更新"), "更新モードで更新セクションが入る");
    assert.ok(updatePrompt.includes("原則そのまま維持"), "@confirmed維持ルールが入る");
    assert.ok(updatePrompt.includes("既存の目的。 <!-- @confirmed 2026-07-16 -->"), "既存mdが原文のまま埋め込まれる");
    const newPrompt = buildDesignPrompt({ kind: "file", relPath: "src/a.py" });
    assert.ok(!newPrompt.includes("今回は更新"), "既存md無しでは更新セクションが出ない");
    ok("更新モード: 既存md埋め込みと@confirmed維持ルール");
}

// 9. designRelPathForScope: 3種のscopeで置き場パス規則どおりの相対パスを返すこと
{
    const { designRelPathForScope } = require("../out/design/designPrompt.js");
    assert.strictEqual(designRelPathForScope({ kind: "repo" }), ".ai-code-guide/design/_repo.md");
    assert.strictEqual(designRelPathForScope({ kind: "directory", relPath: "src/design" }), ".ai-code-guide/design/src/design/_dir.md");
    assert.strictEqual(designRelPathForScope({ kind: "file", relPath: "src/a.py" }), ".ai-code-guide/design/src/a.py.md");
    ok("designRelPathForScope: 3種のscopeでパス規則どおり");
}

// 10. 手順0(上の層からの導出)と手順5(疑問リスト)が全scopeの手順に入っていること
{
    const prompt = buildDesignPrompt({ kind: "file", relPath: "src/a.py" });
    assert.ok(prompt.includes("対象より上の層の設計ファイル"), "手順0: 上位層の設計を先に読む指示がある");
    assert.ok(prompt.includes("上の層から導いた目的にコードが合っているか"), "手順0: 導出→突き合わせの向きを規定している");
    assert.ok(prompt.includes("疑問リスト"), "手順5: 設計への疑問リストを出す指示がある");
    assert.ok(prompt.includes("意図的ですか"), "手順5: 質問形(断定しない)を指定している");
    ok("手順0(上位層からの導出)と手順5(疑問リスト)が入る");
}

console.log(`\n${passed}/10 passed`);
