import { execFile } from "child_process";
import { resolveCommand } from "./resolveCommand";

// AI_NOTE: unified diff を解析して「変更後ファイルで追加/変更された行番号(0-based)」の集合を返す純粋関数。
// vscode/子プロセス非依存にして単体テスト可能にする(parser だけ切り出す)。
// ハンクヘッダ @@ -a,b +c,d @@ の c が新側の開始行。'+'行=追加(新側に存在), '-'行=削除(新側に無い),
// それ以外=文脈行(新側に存在)として新側カウンタを進める。+++/--- のファイルヘッダは除外。
export function parseChangedLines(diff: string): Set<number> {
    const changed = new Set<number>();
    let newLine = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
            newLine = parseInt(hunk[1], 10) - 1; // 0-based へ
            continue;
        }
        if (line.startsWith("+")) {
            changed.add(newLine);
            newLine++;
        } else if (line.startsWith("-") || line.startsWith("\\")) {
            // 削除行は新側に無い / "\ No newline at end of file" は行ではない → 新側カウンタを進めない
        } else {
            newLine++; // 文脈行
        }
    }
    return changed;
}

// AI_NOTE: 対象ファイルの未コミット変更(HEAD との差分)の変更行集合を返す。git が無い/リポジトリ外/HEAD無しは
// reject せず空集合で返さず、呼び出し側で原因を出せるよう例外を投げる(I/O境界の最小例外)。
export function getChangedLines(filePath: string, cwd: string): Promise<Set<number>> {
    const git = resolveCommand("git", "git");
    return new Promise((resolve, reject) => {
        // AI_NOTE: -U0 で文脈行0=変更行だけのハンクにし、解析を変更箇所に絞る。HEAD 比較で staged+unstaged 両方を見る。
        execFile(git, ["diff", "-U0", "HEAD", "--", filePath], { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr?.trim() || err.message));
                return;
            }
            resolve(parseChangedLines(stdout));
        });
    });
}
