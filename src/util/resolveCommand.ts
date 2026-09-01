import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

// AI_NOTE: claude/python3 を「配布先のどの環境でも見つける」ための解決器。
// VS Code を Dock から起動すると拡張ホストの PATH が細く、PATH 依存の spawn("claude"/"python3") が
// ENOENT になる(volta/nvm/pyenv等は ~/.volta/bin 等にあり PATH に乗らない)。手設定なしで動くよう、
// 既知の場所探索→ログインシェルのPATH の順で実体を探す。vscode非依存にしてnodeで単体テスト可能にする。

// AI_NOTE: 解決は fs/プロセス起動を伴うので、同一(設定値,名前)はプロセス内でメモ化して繰り返しを避ける。
const cache = new Map<string, string>();

// AI_NOTE: 別アカウント用の claude 認証ディレクトリ。CLAUDE_CONFIG_DIR にこれを渡すと既定ログイン(キーチェーン)と
// 分離される。ログインボタン(ターミナル)と runCli の両方が同じ場所を指す必要があるので一箇所に固定する。
export function separateClaudeConfigDir(): string {
    return path.join(os.homedir(), ".ai-code-guide-claude");
}

// AI_NOTE: mac/linux でツールが入りがちな場所。ここに <name> を結合して実在を見る。
function knownDirs(): string[] {
    const home = os.homedir();
    if (process.platform === "win32") {
        const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
        const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
        const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
        return [
            path.join(appData, "npm"),
            path.join(localAppData, "Programs", "Python", "Launcher"),
            path.join(localAppData, "Microsoft", "WindowsApps"),
            path.join(programFiles, "nodejs"),
        ];
    }
    return [
        path.join(home, ".volta", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        path.join(home, ".npm-global", "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".pyenv", "shims"),
        "/usr/bin",
        "/bin",
    ];
}

// WindowsのPython公式インストーラーは通常 `python.exe` だけを作る。
// 拡張内部の既存呼び出し名 `python3` を維持しつつ、Windowsだけ実在名へフォールバックする。
export function commandCandidates(name: string, platform = process.platform): string[] {
    return platform === "win32" && name === "python3" ? ["python3", "python"] : [name];
}

function viaWindowsPath(names: string[]): string | null {
    if (process.platform !== "win32") return null;
    for (const name of names) {
        try {
            const out = execFileSync("where.exe", [name], {
                encoding: "utf8",
                timeout: 5000,
                stdio: ["ignore", "pipe", "ignore"],
            }).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
            if (out && fs.existsSync(out)) return out;
        } catch { /* 次の候補へ */ }
    }
    return null;
}

// AI_NOTE: 最終手段。ユーザーのログインシェルでプロファイルを読み込ませ command -v で実体を引く。
// Dock起動でPATHが細い問題をここで吸収する。ハング対策に5秒でタイムアウト、失敗は握り潰してnull。
function viaLoginShell(name: string): string | null {
    if (process.platform === "win32") return null;
    const shell = process.env.SHELL || "/bin/zsh";
    try {
        const out = execFileSync(shell, ["-lic", `command -v ${name}`], {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out && fs.existsSync(out) ? out : null;
    } catch {
        return null;
    }
}

// AI_NOTE: configured=設定値(絶対パス or コマンド名)、name=既定コマンド名(claude/python3)。
// 解決できなければ configured をそのまま返す(従来挙動。spawnのENOENTで呼び出し側が原因を通知する)。
export function resolveCommand(configured: string, name: string): string {
    const key = `${configured}::${name}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const result = ((): string => {
        // 1. 設定が絶対/相対パス指定で実在 → 最優先(ユーザーが明示した値を尊重)
        if ((configured.includes("/") || configured.includes("\\") || path.win32.isAbsolute(configured)) && fs.existsSync(configured)) return configured;
        const names = configured === name ? commandCandidates(name) : [configured];
        // 2. 既知の場所を探索
        for (const dir of knownDirs()) {
            for (const candidate of names) {
                const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
                for (const suffix of suffixes) {
                    const p = path.join(dir, candidate + suffix);
                    if (fs.existsSync(p)) return p;
                }
            }
        }
        // 3. OS標準のPATH探索
        const viaPath = viaWindowsPath(names);
        if (viaPath) return viaPath;
        // 4. macOS/LinuxはログインシェルのPATHも確認
        const viaShell = viaLoginShell(name);
        if (viaShell) return viaShell;
        // 5. 諦め: 設定値のまま返す
        return configured;
    })();

    cache.set(key, result);
    return result;
}
