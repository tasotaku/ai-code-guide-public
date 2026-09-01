// AI_NOTE: package.json の "vscode:uninstall" フックから実行されるスクリプト。
// 実行タイミングは「アンインストール後、次に VS Code を起動したとき」（VS Code の仕様）。
// vscode API は使えない素の Node 環境なので、globalStorage の場所は自前で組み立てる。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const EXT_DIR = "neoai-research.ai-code-guide";

// AI_NOTE: userData の場所は OS × 製品（VS Code / Insiders / VSCodium / Cursor）で違う。
// どの製品から消されたかはフック側から分からないため、主要どころを総当たりで消す
// （存在しないパスは force:true で黙ってスキップされる）。
function userDataBases(): string[] {
    const home = os.homedir();
    const products = ["Code", "Code - Insiders", "VSCodium", "Cursor"];
    if (process.platform === "darwin") {
        return products.map((p) => path.join(home, "Library", "Application Support", p));
    }
    if (process.platform === "win32") {
        const appdata = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
        return products.map((p) => path.join(appdata, p));
    }
    return products.map((p) => path.join(home, ".config", p));
}

for (const base of userDataBases()) {
    const target = path.join(base, "User", "globalStorage", EXT_DIR);
    // AI_NOTE: 消せなくても（権限等）アンインストール自体を妨げないよう、ログだけ出して続行する
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch (e) {
        console.error(`ai-code-guide uninstall: failed to remove ${target}:`, e);
    }
}
