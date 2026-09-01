const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findGitExcludeInfo, findGitExcludePath } = require("../out/util/gitExclude.js");

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "acg-git-exclude-"));

try {
    const repo = path.join(temp, "repo");
    const nested = path.join(repo, "examples", "single_file");
    const expected = path.join(repo, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    assert.strictEqual(findGitExcludePath(nested), expected);
    assert.deepStrictEqual(findGitExcludeInfo(nested), { excludePath: expected, worktreeRoot: repo });
    ok("リポジトリ内のサブディレクトリから親のinfo/excludeを見つける");

    const commonGit = path.join(temp, "main", ".git");
    const worktreeGit = path.join(commonGit, "worktrees", "feature");
    const worktree = path.join(temp, "feature-worktree");
    fs.mkdirSync(worktreeGit, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGit}\n`);
    fs.writeFileSync(path.join(worktreeGit, "commondir"), "../..\n");
    assert.strictEqual(findGitExcludePath(worktree), path.join(commonGit, "info", "exclude"));
    assert.deepStrictEqual(findGitExcludeInfo(worktree), {
        excludePath: path.join(commonGit, "info", "exclude"),
        worktreeRoot: worktree,
    });
    ok("worktreeのgitdir参照から共通Gitディレクトリのinfo/excludeを見つける");

    const plain = path.join(temp, "plain", "nested");
    fs.mkdirSync(plain, { recursive: true });
    assert.strictEqual(findGitExcludePath(plain), null);
    ok("Git管理外では何も変更しない");
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${passed}/3 passed`);
