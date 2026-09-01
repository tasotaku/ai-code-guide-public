// AI_NOTE: webviewスクリプト(TSテンプレートリテラル内)のエスケープ回帰テスト。
// テンプレート内の \n や \d は TS が先に解釈して webview には改行や 'd' が届き、
// 文字列/正規表現リテラルが割れて「スクリプト全滅=全ボタン無反応」になる（2026-07-06に実際に発生）。
// webview へバックスラッシュを届けたい場合は必ず \\n のように二重にする。
// 許容する単一バックスラッシュはテンプレート構文用の \` と \${ のみ。
const fs = require("fs");
const path = require("path");

let failed = 0;
function check(file) {
    const src = fs.readFileSync(file, "utf8");
    // <script>〜</script> を全ブロック走査（テンプレートリテラル内のwebview JS）
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const lineBase = src.slice(0, m.index).split("\n").length;
        m[1].split("\n").forEach((line, i) => {
            // 単一バックスラッシュ（\\ の一部でなく、\` \${ でもない）
            for (const hit of line.matchAll(/(?<!\\)\\(?!\\)(?![`$])(.)/g)) {
                console.log(`not ok - ${path.basename(file)}:${lineBase + i} 単一バックスラッシュ \\${hit[1]}（テンプレート内では \\\\${hit[1]} と書く）: ${line.trim().slice(0, 80)}`);
                failed++;
            }
        });
    }
}

check(path.join(__dirname, "..", "src", "view", "mainViewProvider.ts"));

if (failed > 0) {
    console.log(`${failed} 件の危険なエスケープ`);
    process.exit(1);
}
console.log("ok - webviewテンプレート内に単一バックスラッシュなし");
console.log("1/1 passed");
