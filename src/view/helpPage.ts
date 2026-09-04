import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

// AI_NOTE: フル幅の使い方マニュアル。サイドバー(狭い)とは別に、エディタ領域のWebviewPanelで
// 図(SVG)・画像・構造化文章を十分な幅で見せる。パネルは単一インスタンスにし、開いていれば前面化するだけ。
let panel: vscode.WebviewPanel | undefined;

// AI_NOTE: パネルを開く/前面化する唯一の入口。retainContextWhenHidden で背面化しても再描画コストを避ける。
// enableScripts はボタン(設定を開く等)の postMessage 用。localResourceRoots は media/help の画像読み込み用。
export function openHelpPage(extensionPath: string): void {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        return;
    }
    panel = vscode.window.createWebviewPanel(
        "aiCodeGuideHelp",
        "AI Code Guide の使い方",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(extensionPath)] }
    );
    panel.webview.html = buildHelpPageHtml(panel.webview, extensionPath);
    // AI_NOTE: ボタンからのコマンドはホワイトリスト限定(任意コマンド実行を防ぐ)。設定を開くだけ引数付きで分岐。
    panel.webview.onDidReceiveMessage((msg: { type?: string; id?: string; query?: string }) => {
        if (msg?.type !== "cmd") return;
        if (msg.id === "openSettings") {
            vscode.commands.executeCommand("workbench.action.openSettings", msg.query ?? "aiCodeGuide");
            return;
        }
        // AI_NOTE: setApiKey を追加。ホワイトリスト方式(webviewから任意コマンドを呼ばせない)は維持
        const allowed = new Set(["aiCodeGuide.showFlowchart", "aiCodeGuide.explainBlockInline", "aiCodeGuide.openWalkthrough", "aiCodeGuide.setApiKey"]);
        if (msg.id && allowed.has(msg.id)) vscode.commands.executeCommand(msg.id);
    });
    panel.onDidDispose(() => { panel = undefined; });
}

// AI_NOTE: サイドバー「ヘルプに質問」の文脈用。フルページ本文をテキスト化して返し、説明の二重管理をしない
// (タブは2026-07-02にランチャー化して説明を持たなくなった)。画像URIは文脈に不要なので webview はダミーで足りる。
export function helpPlainText(extensionPath: string): string {
    const fake = { cspSource: "", asWebviewUri: (u: vscode.Uri) => u } as unknown as vscode.Webview;
    return buildHelpPageHtml(fake, extensionPath)
        .replace(/<style>[\s\S]*?<\/style>/, " ")
        .replace(/<script>[\s\S]*?<\/script>/, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// AI_NOTE: media/help/<name> があれば <img> を返す(無ければ空)。撮影前でも壊れ表示にならない。
function shot(webview: vscode.Webview, extensionPath: string, name: string, caption: string): string {
    const p = path.join(extensionPath, "media", "help", name);
    if (!fs.existsSync(p)) return "";
    const uri = webview.asWebviewUri(vscode.Uri.file(p));
    return `<figure class="shot"><img src="${uri}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>`;
}

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// AI_NOTE: マニュアル本体HTML。CSPで既定遮断し、ローカル資源(cspSource)＋インラインstyle/scriptだけ許可。
// 概念図は撮影に依存しないSVGで描き、実スクショ(インライン系)は shot() で併用する。
function buildHelpPageHtml(webview: vscode.Webview, extensionPath: string): string {
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; font-src ${webview.cspSource};`;

    // AI_NOTE: 2軸概要図。この拡張が「①構造を見る ②注釈を出す」の2本柱だと一目で伝える。
    const axisDiagram = `
    <svg class="diagram" viewBox="0 0 720 200" role="img" aria-label="2軸の概要図">
      <rect x="280" y="12" width="160" height="40" rx="8" class="d-box d-accent"/>
      <text x="360" y="37" class="d-title">AI Code Guide</text>
      <path d="M360 52 L200 92" class="d-line"/><path d="M360 52 L520 92" class="d-line"/>
      <rect x="70" y="92" width="260" height="92" rx="8" class="d-box"/>
      <text x="200" y="118" class="d-h">① 構造を見る</text>
      <text x="200" y="140" class="d-s">フローチャート / マップ</text>
      <text x="200" y="162" class="d-s">関数・呼び出し・依存を図で把握</text>
      <rect x="390" y="92" width="260" height="92" rx="8" class="d-box"/>
      <text x="520" y="118" class="d-h">② 注釈を出す</text>
      <text x="520" y="140" class="d-s">インライン意味解説</text>
      <text x="520" y="162" class="d-s">コード中に「これは何か」を表示</text>
    </svg>`;

    const kbd = (k: string) => `<span class="kbd">${k}</span>`;

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { --maxw: 900px; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 24px 80px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); line-height: 1.7; font-size: 14px; }
  .wrap { max-width: var(--maxw); margin: 0 auto; }
  header.hero { padding: 32px 0 8px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 19px; margin: 40px 0 4px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); }
  h3 { font-size: 15px; margin: 20px 0 4px; }
  p { margin: 6px 0; }
  .lead { color: var(--vscode-descriptionForeground); font-size: 15px; }
  .toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 8px; }
  .toc a { text-decoration: none; font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); color: var(--vscode-foreground); }
  .toc a:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
  /* AI_NOTE: 機能行=左に説明・右に図/画像の2カラム。狭い時は1カラムに落とす。 */
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; margin: 14px 0; }
  @media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
  /* AI_NOTE: 機能の説明(左・可変幅)＋縦長スクショ(右・画像実寸)を横並びにして、中央寄せ画像の左右スカスカを解消。狭い時は縦積み。 */
  .frow { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: start; margin: 18px 0; }
  @media (max-width: 720px) { .frow { grid-template-columns: 1fr; } }
  .frow figure.shot { margin: 0; }
  .card { background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08)); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 8px; padding: 14px 16px; }
  ul { margin: 6px 0; padding-left: 20px; }
  li { margin: 4px 0; }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; background: rgba(128,128,128,0.18); padding: 1px 5px; border-radius: 4px; }
  .kbd { display: inline-block; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4)); background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17)); white-space: nowrap; }
  .btn { display: inline-block; cursor: pointer; font-size: 12.5px; padding: 5px 12px; border-radius: 6px; margin: 4px 6px 0 0; border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.5)); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.22)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .btn:hover { filter: brightness(1.12); }
  /* AI_NOTE: 「埋もれない仕組み」を、実際の操作UI(チップ/トグル/セグメント/右クリック項目)の見た目で見せて「押せる」と直感させる。装飾のみ(押下機能なし)。 */
  .ctrls { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0; }
  @media (max-width: 720px) { .ctrls { grid-template-columns: 1fr; } }
  .ctrl { background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08)); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 8px; padding: 12px 14px; }
  .ctrl-ui { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
  .ctrl-t { font-size: 12.5px; line-height: 1.5; }
  .chip { font-size: 12px; padding: 3px 11px; border-radius: 999px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.5)); color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .chip.act { background: var(--vscode-button-background); color: #fff; border-color: var(--vscode-button-background); }
  .segbar { display: inline-flex; }
  .seg { font-size: 12px; padding: 4px 12px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.5)); border-left: none; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .seg:first-child { border-left: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.5)); border-radius: 6px 0 0 6px; }
  .seg:last-child { border-radius: 0 6px 6px 0; }
  .seg.act { background: var(--vscode-button-background); color: #fff; border-color: var(--vscode-button-background); }
  .tgl { display: inline-flex; align-items: stretch; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.5)); border-radius: 6px; overflow: hidden; font-size: 12px; }
  .tgl-k { padding: 4px 10px; }
  .tgl-v { padding: 4px 10px; background: var(--vscode-button-background); color: #fff; font-weight: 600; }
  .mitem { font-size: 12px; padding: 5px 12px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.5)); border-radius: 6px; background: var(--vscode-editor-background, #1e1e1e); white-space: nowrap; }
  /* AI_NOTE: トリアージ(読んだ/後で/解決)が「押せるボタン」だと気づかれにくいので、そのカードだけ強調＋クリック誘導のヒントを付ける。 */
  .ctrl.hl { border-color: var(--vscode-focusBorder, #4f8fd7); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #4f8fd7) inset; }
  .click-hint { font-size: 11px; font-weight: 600; color: var(--vscode-focusBorder, #4f8fd7); white-space: nowrap; }
  .chip.clickable { cursor: pointer; }
  /* AI_NOTE: 縦長の実スクショ(カード/フロー図/参照)が全幅で巨大化するのを防ぐ。高さ上限＋幅autoで縮小し中央寄せ。横長のインライン画像はmax-widthで全幅に収まる。 */
  figure.shot { margin: 12px 0 0; text-align: center; }
  figure.shot img { display: inline-block; max-width: min(100%, 680px); max-height: 400px; width: auto; height: auto; border-radius: 8px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); }
  /* AI_NOTE: 横並び(.frow)の中の画像はさらに小さめにし、左のテキストに幅を残す。 */
  .frow figure.shot img { max-width: min(100%, 460px); }
  figure.shot figcaption { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 5px; }
  /* AI_NOTE: SVG概念図の配色はテーマ変数に寄せ、強調のみ固定色(橙/ティール)。 */
  svg.diagram { width: 100%; height: auto; margin: 10px 0; background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.06)); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 8px; }
  .d-box { fill: var(--vscode-editor-background, #1e1e1e); stroke: var(--vscode-widget-border, rgba(160,160,160,0.5)); stroke-width: 1.2; }
  .d-accent { stroke: var(--vscode-focusBorder, #4f8fd7); stroke-width: 1.8; }
  .d-orange { stroke: #d7943a; } .d-teal { stroke: #3fae9f; }
  .d-chip { fill: rgba(128,128,128,0.28); }
  .d-node { fill: var(--vscode-editor-background,#1e1e1e); stroke: #4f8fd7; stroke-width: 1.5; }
  .d-title, .d-h, .d-h2, .d-s { fill: var(--vscode-foreground); font-family: var(--vscode-font-family); text-anchor: middle; }
  .d-title { font-size: 13px; font-weight: 600; } .d-h { font-size: 13px; font-weight: 600; }
  .d-h2 { font-size: 12px; font-weight: 600; } .d-s { font-size: 11px; fill: var(--vscode-descriptionForeground); }
  .d-line { stroke: var(--vscode-widget-border, rgba(160,160,160,0.6)); stroke-width: 1.4; fill: none; }
  .d-arrow { stroke: var(--vscode-foreground); stroke-width: 1.6; fill: none; }
  .d-arrow-orange { stroke: #d7943a; stroke-width: 2; fill: none; }
  .d-arrow-teal { stroke: #3fae9f; stroke-width: 2; fill: none; }
  .d-fill { fill: var(--vscode-foreground); } .d-fill-orange { fill: #d7943a; } .d-fill-teal { fill: #3fae9f; }
  .note { font-size: 12.5px; color: var(--vscode-descriptionForeground); }
  table.keys { border-collapse: collapse; margin: 8px 0; width: 100%; max-width: 520px; }
  table.keys td { padding: 6px 10px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); font-size: 13px; }
  table.keys td:last-child { text-align: right; white-space: nowrap; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 4px; margin-right: 4px; }
  .tag.info { background: rgba(215,148,58,0.18); color: #e0a95c; } .tag.warn { background: rgba(220,80,80,0.18); color: #e07a7a; }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); color: var(--vscode-descriptionForeground); font-size: 12.5px; }
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <h1>AI Code Guide の使い方</h1>
    <p class="lead">Python・JavaScript・TypeScriptコードの理解を助ける拡張機能です。構造・解説・コード図を共通の画面で扱います。</p>
    ${axisDiagram}
    <div class="toc">
      <a href="#setup">1. 認証（セットアップ）</a>
      <a href="#flow">2. フローチャート / マップ</a>
      <a href="#inline">3. インライン意味解説</a>
      <a href="#keys">ショートカット</a>
      <a href="#trouble">困ったとき</a>
    </div>
  </header>

  <section id="setup">
    <h2>1. 認証（セットアップ）</h2>
    <p>解説の生成には LLM が必要です。次のどちらかを設定すれば動きます。</p>
    <div class="row">
      <div class="card">
        <h3>A. APIキー方式</h3>
        <p>Anthropic / OpenAI / Google のいずれかのキーを、コマンド「AI Code Guide: APIキーを設定」（設定タブの「編集」ボタンと同じ）から入力します。使うモデルのプロバイダのキーだけでOK。モデル名の接頭辞（<code>claude-*</code> / <code>gpt-*</code> / <code>gemini-*</code>）で自動判定されます。削除は同じコマンドで空のまま Enter。</p>
      </div>
      <div class="card">
        <h3>B. サブスク方式（APIキー不要）</h3>
        <p>ログイン済みの <code>claude</code>（または <code>codex</code>）CLI を使います。<b>このマシンでログイン済みのときだけ</b>動きます。設定タブ →「バックエンド」→「サブスクで動かす」をONに。</p>
      </div>
    </div>
    <p class="note">APIキーは機微情報なので画面上では値を扱わず、settings.json でなく OS のキーチェーン（SecretStorage）に保存されます。設定ファイルの共有や Settings Sync で漏れることはありません。</p>
    <button class="btn primary" data-cmd="aiCodeGuide.setApiKey">APIキーを設定 / 削除</button>
    <button class="btn" data-cmd="openSettings" data-query="aiCodeGuide">拡張の設定を開く</button>
    <button class="btn" data-cmd="aiCodeGuide.openWalkthrough">初回セットアップのガイドを開く</button>
  </section>

  <section id="flow">
    <h2>2. フローチャート / マップ</h2>
    <p>コードの構造をカードと図で見る機能です。対応コードファイルを開いて ${kbd("⌘⌥V")}（Win/Linux: ${kbd("Ctrl+Alt+V")}）。保存すると自動更新されます。</p>

    <div class="frow">
      <div>
        <h3>標準タブ：関数・クラスのカードを縦に一覧</h3>
        <p>ファイルの中の関数・クラスがカードとして縦に並びます。各カードでできること：</p>
        <ul>
          <li><b>カードをクリック</b> → 対応する<b>コードにジャンプ</b>します。</li>
          <li><b>「図」ボタン</b> → その関数の処理の流れ（フローチャート）を表示します。</li>
          <li><b>「参照」ボタン</b> → 呼び出し関係を色で強調します（下記）。</li>
          <li><b>▼</b> → そのコードをAIがさらに細かいまとまりに分解（ツールバーの <code>▼全て</code>/<code>▶全て</code> で一括）。</li>
        </ul>
      </div>
      <div>${shot(webview, extensionPath, "flowchart-cards.png", "標準タブ：関数・クラスが縦に並んだカード一覧（各カードに 図 / 参照 ボタン）")}</div>
    </div>

    <div class="frow">
      <div>
        <h3>「図」ボタンで見えるフローチャート</h3>
        <p>カードの「図」ボタンを押すと、その関数の中の<b>分岐やループを処理の流れとして図</b>にしたものが見られます。ノードをクリックすると対応するコード行へジャンプします。</p>
      </div>
      <div>${shot(webview, extensionPath, "flowchart-flow.png", "「図」ボタンで開いた、関数のフローチャート")}</div>
    </div>

    <div class="frow">
      <div>
        <h3>「参照」ボタンで呼び出し関係を強調</h3>
        <p>あるカードの「参照」を押すと、縦に並んだカードのうち<b>その関数が呼ぶ先＝オレンジ</b>／<b>呼ぶ元＝ティール</b>で色づき、無関係なカードは暗くなります（もう一度押すと解除）。ツールバーの<b>「矢印 ON/OFF」</b>にするとカード間に矢印も表示されます。</p>
      </div>
      <div>${shot(webview, extensionPath, "flowchart-ref.png", "参照：関係するカードだけ色づけ（他は暗く）＋矢印")}</div>
    </div>

    <h3>その他のタブ</h3>
    <ul>
      <li><b>概要</b>：ファイルを意味のグループでまとめた俯瞰ビュー。</li>
      <li><b>プロジェクト</b>：ワークスペース全体の対応コードファイルと <b>import 依存</b>（○→▶）。参照を押すと関連ファイルが強調されます。</li>
    </ul>
    <p><button class="btn" data-cmd="aiCodeGuide.showFlowchart">いま開いているファイルで表示</button></p>
  </section>

  <section id="inline">
    <h2>3. 名称辞書</h2>
    <p>Python ファイルで ${kbd("⌘⌥E")}（Win/Linux: ${kbd("Ctrl+Alt+E")}）を押すと、変数・関数・メソッド・クラスの短い説明を生成します。</p>
    <p>コードの見た目は変わりません。知りたい名称へマウスを置くと、種類・説明・質問ボタンがポップアップします。</p>
    <ul>
      <li><b>名称辞書</b>：ファイル全体を生成。保存済みの説明は再利用します。</li>
      <li><b>範囲を解析</b>：選択した範囲だけを追加生成します。</li>
      <li><b>説明を再生成</b>：名称は変えず、説明文を作り直します。</li>
      <li><b>名称辞書を表示</b>：生成結果を消さずに Hover の ON/OFF を切り替えます。</li>
    </ul>
    <p>実行トレースと同時に使えます。トレースを消さなくても名称へ Hover できます。</p>
    <p><button class="btn" data-cmd="aiCodeGuide.explainBlockInline">いま開いているファイルで生成</button></p>
  </section>

  <section id="keys">
    <h2>ショートカット（対応コードのエディタ）</h2>
    <table class="keys">
      <tr><td>フローチャートを表示</td><td>${kbd("⌘⌥V")} / ${kbd("Ctrl+Alt+V")}</td></tr>
      <tr><td>インライン解説を生成</td><td>${kbd("⌘⌥E")} / ${kbd("Ctrl+Alt+E")}</td></tr>
      <tr><td>インライン解説をクリア</td><td>${kbd("⌘⌥C")} / ${kbd("Ctrl+Alt+C")}</td></tr>
    </table>
    <p class="note">すべて ${kbd("⌘⇧P")}（コマンドパレット）から「AI Code Guide:」で検索しても実行できます。</p>
    <h3>グローバル文脈（説明のカスタマイズ）</h3>
    <p>「私はPython初心者です」「日本語で説明して」などを設定すると、全ての説明の前置きに使われます（設定タブ）。変更するとキャッシュが消えて再生成されます。</p>
  </section>

  <section id="trouble">
    <h2>困ったとき</h2>
    <ul>
      <li><b>解説が出ない／「分解できませんでした」</b>：認証が未設定か通信失敗の可能性。設定タブで APIキー / サブスクを確認。</li>
      <li><b>Pythonだけ解析されない</b>：<code>python3</code> が PATH にあるか確認。JavaScript/TypeScript解析器は拡張へ同梱されています。</li>
      <li><b>実行トレースが使えない</b>：現在はPythonだけに対応しています。他言語では構造・概要・図・解説・チャットを利用できます。</li>
      <li><b>更新したのに変わらない</b>：<code>.vsix</code> は自動更新されません。新しい版を入れたら VS Code を再読み込み（${kbd("⌘⇧P")} →「Reload Window」）。</li>
    </ul>
  </section>

  <footer>この説明は、サイドバーの「ヘルプ」タブからいつでも開けます。</footer>
</div>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.btn[data-cmd]').forEach(function (b) {
    b.addEventListener('click', function () {
      vscode.postMessage({ type: 'cmd', id: b.getAttribute('data-cmd'), query: b.getAttribute('data-query') || undefined });
    });
  });
</script>
</body>
</html>`;
}
