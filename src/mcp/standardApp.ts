// AI_NOTE: Codex内ではコードと読解ガイドを同じ面に置く。初期表示は軽い構造マップに留め、
// 利用者が選んだ関数・クラスだけ既存expand_standard_itemsで目的・入出力・意味ブロックを生成する。
export function buildStandardAppShell(): string {
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; --accent: #4f7cff; --class: #c586c0; --function: #4ec9b0; --keyword:#c586c0; --call:#dcdcaa; --string:#ce9178; --number:#b5cea8; --comment:#6a9955; --name:#9cdcfe; --type:#4ec9b0; --decorator:#dcdcaa; --line: color-mix(in srgb, CanvasText 18%, transparent); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 150px; color: CanvasText; background: Canvas; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #status { margin: 0; padding: 24px 16px; text-align: center; opacity: .7; }
    #app { display: none; padding: 12px 14px 14px; }
    body.ready #status { display: none; }
    body.ready #app { display: block; }
    body.error #status { color: #c33; opacity: 1; }
    .header { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 9px; }
    .title { margin: 0; font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
    .summary { margin: 3px 0 0; font-size: 11px; line-height: 1.4; opacity: .72; }
    .view-state { margin: 0 0 7px; opacity: .58; font: 10px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    button { font: inherit; }
    .open-standard { flex: 0 0 auto; padding: 7px 10px; border: 1px solid var(--accent); border-radius: 8px; color: Canvas; background: var(--accent); cursor: pointer; font-size: 11px; font-weight: 650; }
    .open-standard:hover, .open-standard:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 28%, transparent); outline-offset: 2px; }
    .open-standard:disabled, .detail-button:disabled { cursor: wait; opacity: .65; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(260px, .9fr); min-height: 430px; max-height: 620px; border-block: 1px solid var(--line); }
    .source { min-width: 0; margin: 0; overflow: auto; overscroll-behavior: contain; border-right: 1px solid var(--line); background: color-mix(in srgb, CanvasText 3%, Canvas); font: 11px/1.58 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; scrollbar-gutter: stable both-edges; scrollbar-width: auto; scrollbar-color: color-mix(in srgb, var(--accent) 72%, CanvasText) color-mix(in srgb, CanvasText 12%, Canvas); }
    .source::-webkit-scrollbar, .guide::-webkit-scrollbar { width: 13px; height: 14px; }
    .source::-webkit-scrollbar-track, .guide::-webkit-scrollbar-track { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, Canvas); }
    .source::-webkit-scrollbar-thumb, .guide::-webkit-scrollbar-thumb { min-width: 44px; border: 3px solid color-mix(in srgb, CanvasText 8%, Canvas); border-radius: 999px; background: color-mix(in srgb, var(--accent) 72%, CanvasText); background-clip: padding-box; }
    .source-line { display: grid; grid-template-columns: 43px minmax(max-content, 1fr); width: max-content; min-width: 100%; min-height: 18px; border-left: 3px solid transparent; cursor: default; }
    .source-line.in-unit { border-left-color: var(--unit-color); background: color-mix(in srgb, var(--unit-color) 12%, transparent); }
    .source-line.selected { background: color-mix(in srgb, var(--unit-color) 24%, transparent); }
    .source-line:hover { filter: brightness(1.08); }
    .source-number { padding-right: 10px; color: color-mix(in srgb, CanvasText 45%, transparent); text-align: right; user-select: none; }
    .source-code { min-width: max-content; padding-right: 14px; white-space: pre; }
    .token-keyword { color: var(--keyword); font-weight: 600; }
    .token-function { color: var(--call); }
    .token-string { color: var(--string); }
    .token-comment { color: var(--comment); }
    .token-number { color: var(--number); }
    .token-type { color: var(--type); }
    .token-decorator { color: var(--decorator); }
    .token-name { color: var(--name); }
    .guide { min-width: 0; overflow: auto; overscroll-behavior: contain; padding: 12px; scrollbar-gutter: stable; }
    .guide-heading { margin: 0 0 4px; font-size: 13px; }
    .guide-lead { margin: 0 0 11px; font-size: 11px; line-height: 1.5; opacity: .7; }
    .item { display: grid; grid-template-columns: 58px minmax(0, 1fr) auto; gap: 7px; align-items: center; min-height: 42px; margin-bottom: 6px; padding: 7px 7px 7px 9px; border: 1px solid var(--line); border-left: 4px solid var(--item-color, #9d9d9d); border-radius: 7px; background: color-mix(in srgb, var(--item-color, #9d9d9d) 8%, transparent); }
    .item.child { margin-left: 14px; }
    .kind { color: var(--function); font-size: 10px; }
    .item.class .kind { color: var(--class); }
    .name { margin: 0; font: 650 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .location { display: block; margin-top: 2px; font: 9px/1.2 ui-monospace, monospace; opacity: .55; }
    .detail-button, .back, .jump { padding: 5px 7px; border: 1px solid var(--line); border-radius: 6px; color: CanvasText; background: transparent; cursor: pointer; font-size: 10px; white-space: nowrap; }
    .detail-button:hover, .detail-button:focus-visible, .back:hover, .jump:hover { border-color: var(--item-color, var(--accent)); color: var(--item-color, var(--accent)); outline: none; }
    .detail-head { display: flex; gap: 7px; align-items: center; margin-bottom: 10px; }
    .detail-title { min-width: 0; flex: 1; margin: 0; font: 700 13px/1.35 ui-monospace, monospace; overflow-wrap: anywhere; }
    .overview { margin-bottom: 11px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .overview-row { display: grid; grid-template-columns: 58px minmax(0, 1fr); border-bottom: 1px solid var(--line); font-size: 11px; line-height: 1.5; }
    .overview-row:last-child { border-bottom: 0; }
    .overview-key { padding: 7px; border-left: 4px solid var(--row-color); font-weight: 700; }
    .overview-value { padding: 7px 8px; }
    .blocks-title { margin: 0 0 6px; font-size: 11px; opacity: .72; }
    .block { margin-bottom: 7px; padding: 8px 9px; border: 1px solid var(--line); border-left: 5px solid var(--block-color); border-radius: 7px; background: color-mix(in srgb, var(--block-color) 9%, transparent); cursor: pointer; }
    .block.active { background: color-mix(in srgb, var(--block-color) 19%, transparent); border-color: var(--block-color); }
    .block-label { margin: 0 0 3px; font-size: 11px; font-weight: 700; }
    .block-description { margin: 0; font-size: 11px; line-height: 1.48; opacity: .85; }
    .block-lines { float: right; margin-left: 6px; font: 9px/1.4 ui-monospace, monospace; opacity: .55; }
    .empty, .detail-error { padding: 14px 4px; text-align: center; font-size: 11px; opacity: .68; }
    .detail-error { color: #c33; opacity: 1; }
    .jump-status { margin: 8px 2px 0; font-size: 11px; color: var(--accent); }
    .jump-status:empty { display: none; }
    .jump-status.error { color: #c33; }
    @media (max-width: 720px) {
      .header { display: block; }
      .open-standard { display: block; width: 100%; margin-top: 9px; }
      .workspace { display: block; max-height: none; }
      .source { height: 330px; border-right: 0; border-bottom: 1px solid var(--line); }
      .guide { max-height: 360px; }
    }
  </style>
</head>
<body>
  <p id="status" role="status">コード読解ビューを読み込んでいます…</p>
  <main id="app" aria-live="polite">
    <p class="view-state" id="view-state" role="status"></p>
    <header class="header">
      <div><h2 class="title" id="title"></h2><p class="summary" id="summary"></p></div>
      <button type="button" class="open-standard" id="open-standard">VS Codeで標準ビューを開く</button>
    </header>
    <section class="workspace" aria-label="コードと読解ガイド">
      <section class="source" id="source" tabindex="0" role="region" aria-label="意味単位で色分けしたPythonコード全文"></section>
      <aside class="guide" id="guide" aria-label="目的・入出力・処理ブロック"></aside>
    </section>
    <p class="jump-status" id="jump-status" role="status"></p>
  </main>
  <script>
    const pending = new Map();
    const blockPalette = ["#4fc1ff", "#f48771", "#4ec9b0", "#dcdcaa", "#c586c0", "#9cdcfe"];
    let nextId = 1, sourceFile = "", workspaceRoot = "", currentStandard = null, selectedItemId = "", selectedBlockIndex = -1;
    const sourceRows = new Map();
    const rpcRequest = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*"); });
    const rpcNotify = (method, params) => window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
    const absoluteFile = (file) => {
      const windowsAbsolute = file.length > 2 && file[1] === ":" && (file[2] === "/" || file.charCodeAt(2) === 92);
      if (!workspaceRoot || file.startsWith("/") || windowsAbsolute) return file;
      const rootEndsWithSeparator = workspaceRoot.endsWith("/") || workspaceRoot.charCodeAt(workspaceRoot.length - 1) === 92;
      const fileStartsWithSeparator = file.startsWith("/") || file.charCodeAt(0) === 92;
      return (rootEndsWithSeparator ? workspaceRoot.slice(0, -1) : workspaceRoot) + "/" + (fileStartsWithSeparator ? file.slice(1) : file);
    };
    const setJumpStatus = (message, error) => { const element = document.getElementById("jump-status"); element.textContent = message; element.classList.toggle("error", Boolean(error)); };
    const showLoadError = (message) => { document.getElementById("status").textContent = message || "コード読解ビューを表示できませんでした。"; document.body.classList.remove("ready"); document.body.classList.add("error"); };
    const toolValue = (result) => result?.result ?? result;
    const structuredStandard = (result) => toolValue(result)?.structuredContent?.standard;
    const openStandard = async (button) => {
      if (!sourceFile) return setJumpStatus("移動先のファイルがありません。", true);
      button.disabled = true; setJumpStatus("VS Codeの標準ビューを準備しています…", false);
      try { const result = await rpcRequest("tools/call", { name: "show_standard_view", arguments: { file: absoluteFile(sourceFile), focusWindow: true } }); if (result?.isError) throw new Error(result?.content?.[0]?.text || "標準ビューを開けませんでした。"); setJumpStatus("VS Codeで標準ビューを開きました。", false); }
      catch (error) { setJumpStatus(error?.message || "標準ビューを開けませんでした。", true); } finally { button.disabled = false; }
    };
    const jumpToLine = async (button, line) => {
      button.disabled = true; setJumpStatus("コードへ移動しています…", false);
      try { const result = await rpcRequest("tools/call", { name: "show_standard_view", arguments: { file: absoluteFile(sourceFile), line, focusWindow: true } }); if (result?.isError) throw new Error(result?.content?.[0]?.text || "コードへ移動できませんでした。"); setJumpStatus("VS Codeでコード地点を開きました。", false); }
      catch (error) { setJumpStatus(error?.message || "コードへ移動できませんでした。", true); } finally { button.disabled = false; }
    };
    const pythonKeywords = new Set(["and","as","assert","async","await","break","case","class","continue","def","del","elif","else","except","False","finally","for","from","global","if","import","in","is","lambda","match","None","nonlocal","not","or","pass","raise","return","True","try","while","with","yield"]);
    const pythonTypes = new Set(["bool","bytes","dict","float","frozenset","int","list","object","set","str","tuple","type"]);
    const appendToken = (parent, text, className) => { if (!text) return; if (!className) return parent.append(document.createTextNode(text)); const span = document.createElement("span"); span.className = className; span.textContent = text; parent.append(span); };
    // AI_NOTE: Codexの旧App経路もwide標準Webviewと同じ分類へ揃え、入口による色の欠落を防ぐ。
    const appendPython = (parent, text) => {
      const pattern = /(@[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*|#[^\\n]*|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\b\\d+(?:\\.\\d+)?\\b|\\b[A-Za-z_]\\w*(?=\\s*\\()|\\b[A-Za-z_]\\w*\\b)/g;
      let last = 0;
      for (const match of text.matchAll(pattern)) {
        appendToken(parent, text.slice(last, match.index), "");
        const token = match[0], before = text.slice(0, match.index); let className = "";
        if (token.startsWith("@")) className = "token-decorator";
        else if (token.startsWith("#")) className = "token-comment";
        else if (token.startsWith('"') || token.startsWith("'")) className = "token-string";
        else if (/^\\d/.test(token)) className = "token-number";
        else if (pythonKeywords.has(token)) className = "token-keyword";
        else if (/\\bclass\\s*$/.test(before) || pythonTypes.has(token) || /^[A-Z]\\w*$/.test(token)) className = "token-type";
        else if (/\\bdef\\s*$/.test(before) || /^\\s*\\(/.test(text.slice(match.index + token.length))) className = "token-function";
        else if (token === "self" || token === "cls") className = "token-name";
        appendToken(parent, token, className); last = match.index + token.length;
      }
      appendToken(parent, text.slice(last), "");
    };
    const selectedItem = () => currentStandard?.items?.find((item) => item.id === selectedItemId) ?? null;
    const unitForLine = (line) => (currentStandard?.items ?? []).filter((item) => line >= item.line && line <= (item.lineEnd ?? item.line)).sort((left, right) => ((left.lineEnd ?? left.line) - left.line) - ((right.lineEnd ?? right.line) - right.line))[0] ?? null;
    const blockForLine = (line) => (selectedItem()?.expansion?.blocks ?? []).findIndex((block) => line >= block.lineStart && line <= block.lineEnd);
    const applySourceColors = () => {
      const item = selectedItem();
      sourceRows.forEach((row, line) => {
        const unit = unitForLine(line), blockIndex = blockForLine(line), inSelected = item && line >= item.line && line <= (item.lineEnd ?? item.line);
        const color = blockIndex >= 0 ? blockPalette[blockIndex % blockPalette.length] : unit?.color ?? "#9d9d9d";
        const selected = inSelected && (selectedBlockIndex < 0 || blockIndex === selectedBlockIndex);
        row.className = "source-line" + (unit ? " in-unit" : "") + (selected ? " selected" : ""); row.setAttribute("style", "--unit-color:" + color);
      });
    };
    // AI_NOTE: 行へ縦移動する時もコード欄の横位置は保持する。scrollIntoView任せだと長い行に合わせて
    // 横スクロールまで動き、別関数の先頭が欠けてコードと説明を比較しづらくなる。
    const focusLines = (start) => { const row = sourceRows.get(start), source = document.getElementById("source"), left = source.scrollLeft; if (row?.scrollIntoView) row.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }); source.scrollLeft = left; selectedBlockIndex = blockForLine(start); applySourceColors(); };
    const renderSource = (source) => {
      const container = document.getElementById("source"); container.replaceChildren(); sourceRows.clear();
      source.forEach((entry) => { const row = document.createElement("div"), number = document.createElement("span"), code = document.createElement("code"); number.className = "source-number"; number.textContent = String(entry.line); code.className = "source-code"; appendPython(code, entry.text); row.append(number, code); row.onclick = () => { const item = unitForLine(entry.line); if (item) { selectedItemId = item.id; selectedBlockIndex = blockForLine(entry.line); renderGuide(); applySourceColors(); } }; sourceRows.set(entry.line, row); container.append(row); });
      applySourceColors();
    };
    const kindLabel = (item) => item.kind === "class" ? "class" : item.kind === "constant" ? "constant" : item.parent ? "method" : "function";
    const showList = () => { selectedItemId = ""; selectedBlockIndex = -1; renderGuide(); applySourceColors(); };
    const expandItem = async (item, button) => {
      selectedItemId = item.id; selectedBlockIndex = -1; button.disabled = true; button.textContent = "読解中…"; applySourceColors();
      try {
        const result = await rpcRequest("tools/call", { name: "expand_standard_items", arguments: { file: absoluteFile(sourceFile), lines: [item.line], line: item.line, activate: false } });
        if (result?.isError) throw new Error(result?.content?.[0]?.text || "詳しい読解ガイドを作れませんでした。");
        const next = structuredStandard(result); if (!next || !Array.isArray(next.items)) throw new Error("展開結果を受け取れませんでした。");
        currentStandard = next; renderSource(next.source ?? []); renderGuide(); focusLines(item.line);
      } catch (error) { const guide = document.getElementById("guide"); guide.replaceChildren(); const message = document.createElement("p"); message.className = "detail-error"; message.textContent = error?.message || "詳しい読解ガイドを作れませんでした。"; guide.append(message); }
    };
    const addOverviewRow = (container, key, value, color) => { if (!value) return; const row = document.createElement("div"), label = document.createElement("div"), body = document.createElement("div"); row.className = "overview-row"; label.className = "overview-key"; label.setAttribute("style", "--row-color:" + color); label.textContent = key; body.className = "overview-value"; body.textContent = value; row.append(label, body); container.append(row); };
    const renderDetail = (guide, item) => {
      const head = document.createElement("div"), back = document.createElement("button"), title = document.createElement("h3"), jump = document.createElement("button"); head.className = "detail-head"; back.className = "back"; back.textContent = "← 一覧"; back.onclick = showList; title.className = "detail-title"; title.textContent = item.label; jump.className = "jump"; jump.textContent = "VS Code"; jump.onclick = () => jumpToLine(jump, item.line); head.append(back, title, jump); guide.append(head);
      const expansion = item.expansion;
      if (!expansion || (!expansion.overview && !(expansion.blocks ?? []).length)) { const error = document.createElement("p"); error.className = "detail-error"; error.textContent = "読解ガイドを生成できませんでした。設定を確認してもう一度お試しください。"; guide.append(error); return; }
      if (expansion.overview) {
        const box = document.createElement("section"), overview = expansion.overview; box.className = "overview";
        if (item.kind === "class") { addOverviewRow(box, "役割", overview.purpose, "#4fc1ff"); addOverviewRow(box, "状態", overview.state, "#73c991"); addOverviewRow(box, "主な機能", overview.behavior, "#e2b93d"); }
        else { addOverviewRow(box, "目的", overview.purpose, "#4fc1ff"); addOverviewRow(box, "入力", overview.input, "#73c991"); addOverviewRow(box, "出力", overview.output, "#e2b93d"); }
        addOverviewRow(box, "補足", overview.note, "#f0a500"); guide.append(box);
      }
      const blocks = expansion.blocks ?? [];
      if (blocks.length) {
        const heading = document.createElement("h4"); heading.className = "blocks-title"; heading.textContent = "この順に読む"; guide.append(heading);
        blocks.forEach((block, index) => { const card = document.createElement("article"), lines = document.createElement("span"), label = document.createElement("h5"), description = document.createElement("p"); card.className = "block" + (selectedBlockIndex === index ? " active" : ""); card.setAttribute("style", "--block-color:" + blockPalette[index % blockPalette.length]); lines.className = "block-lines"; lines.textContent = "L" + block.lineStart + "–" + block.lineEnd; label.className = "block-label"; label.textContent = block.label; description.className = "block-description"; description.textContent = block.description; card.append(lines, label, description); card.onclick = () => { selectedBlockIndex = index; renderGuide(); focusLines(block.lineStart); }; guide.append(card); });
      }
    };
    const renderGuide = () => {
      const guide = document.getElementById("guide"); guide.replaceChildren(); const item = selectedItem(); if (item?.expansion) return renderDetail(guide, item);
      const heading = document.createElement("h3"), lead = document.createElement("p"); heading.className = "guide-heading"; heading.textContent = "どの単位を読む？"; lead.className = "guide-lead"; lead.textContent = "関数またはクラスを選ぶと、目的・入出力と意味のある処理単位をコードの色に対応させて表示します。"; guide.append(heading, lead);
      const items = currentStandard?.items ?? []; if (!items.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "関数やクラスは見つかりませんでした。"; guide.append(empty); return; }
      items.forEach((entry) => {
        const row = document.createElement("div"), kind = document.createElement("span"), middle = document.createElement("div"), name = document.createElement("p"), location = document.createElement("span"); row.className = "item " + entry.kind + (entry.parent ? " child" : ""); row.setAttribute("style", "--item-color:" + (entry.color ?? "#9d9d9d")); kind.className = "kind"; kind.textContent = kindLabel(entry); name.className = "name"; name.textContent = entry.label; location.className = "location"; location.textContent = "L" + entry.line + "–" + (entry.lineEnd ?? entry.line); middle.append(name, location);
        if (entry.kind === "constant") row.append(kind, middle);
        else { const detail = document.createElement("button"); detail.className = "detail-button"; detail.textContent = entry.expansion ? "開く" : "詳しく読む"; detail.onclick = () => entry.expansion ? (selectedItemId = entry.id, renderGuide(), focusLines(entry.line)) : expandItem(entry, detail); row.append(kind, middle, detail); }
        row.onclick = (event) => { if (event?.target?.className === "detail-button") return; selectedItemId = entry.id; selectedBlockIndex = -1; applySourceColors(); focusLines(entry.line); }; guide.append(row);
      });
    };
    const render = (result) => {
      try {
        const value = toolValue(result); if (value?.isError) throw new Error(value?.content?.find?.((item) => item?.type === "text")?.text || "コード読解ビューを読み込めませんでした。");
        const structured = value?.structuredContent, appMeta = value?._meta ?? value?.meta, standard = structured?.standard, viewState = structured?.viewState;
        if (!viewState || viewState.viewMode !== "standard" || typeof viewState.stateReceiptId !== "string" || !viewState.stateReceiptId) throw new Error("標準ビューの状態確認を受け取れませんでした。");
        if (!standard || !Array.isArray(standard.items) || !Array.isArray(standard.source)) throw new Error("コード読解データを受け取れませんでした。");
        currentStandard = standard; selectedItemId = standard.items.find((item) => item?.expansion)?.id ?? ""; selectedBlockIndex = -1; sourceFile = typeof standard.file === "string" ? standard.file : ""; workspaceRoot = typeof appMeta?.standardWorkspaceRoot === "string" ? appMeta.standardWorkspaceRoot : ""; document.getElementById("view-state").textContent = "表示: standard · " + viewState.resourceVersion + " · receipt " + viewState.stateReceiptId; document.getElementById("title").textContent = standard.title || standard.file || "コード読解";
        const classes = standard.items.filter((item) => item?.kind === "class").length, constants = standard.items.filter((item) => item?.kind === "constant").length, functions = standard.items.length - classes - constants;
        document.getElementById("summary").textContent = "意味単位を色で対応づけています。クラス" + classes + "件、関数・メソッド" + functions + "件、定数" + constants + "件。"; document.getElementById("open-standard").onclick = (event) => openStandard(event.currentTarget); renderSource(standard.source); renderGuide(); document.body.classList.remove("error"); document.body.classList.add("ready");
      } catch (error) { showLoadError(error?.message || "コード読解ビューを表示できませんでした。"); }
    };
    window.addEventListener("message", (event) => { if (event.source !== window.parent) return; const message = event.data; if (!message || message.jsonrpc !== "2.0") return; if (message.id !== undefined && pending.has(message.id)) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request.reject(message.error); else request.resolve(message.result); return; } if (message.method === "ui/notifications/tool-result") render(message.params); }, { passive: true });
    rpcRequest("ui/initialize", { appInfo: { name: "ai-code-guide-reading-map", version: "0.5.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" }).then(() => rpcNotify("ui/notifications/initialized", {})).catch((error) => { showLoadError("コード読解ビューを初期化できませんでした。"); console.error(error); });
  </script>
</body>
</html>`;
}
