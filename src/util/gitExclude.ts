import * as fs from "fs";
import * as path from "path";

export type GitExcludeInfo = { excludePath: string; worktreeRoot: string };

// AI_NOTE: 除外ファイルだけでなくパターンの基準になるworktreeルートも返す。
// サブディレクトリworkspaceでは `examples/.ai-code-guide/...` のような正しい相対パターンを作るため。
export function findGitExcludeInfo(startPath: string): GitExcludeInfo | null {
    let current = path.resolve(startPath);
    while (true) {
        const dotGit = path.join(current, ".git");
        try {
            const stat = fs.statSync(dotGit);
            if (stat.isDirectory()) return { excludePath: path.join(dotGit, "info", "exclude"), worktreeRoot: current };
            if (stat.isFile()) {
                const match = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
                if (match) {
                    const gitDir = path.resolve(current, match[1].trim());
                    const commonDirFile = path.join(gitDir, "commondir");
                    const commonDir = fs.existsSync(commonDirFile)
                        ? path.resolve(gitDir, fs.readFileSync(commonDirFile, "utf8").trim())
                        : gitDir;
                    return { excludePath: path.join(commonDir, "info", "exclude"), worktreeRoot: current };
                }
            }
        } catch { /* この階層に.gitがなければ親を探す */ }
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

export function findGitExcludePath(startPath: string): string | null {
    return findGitExcludeInfo(startPath)?.excludePath ?? null;
}
