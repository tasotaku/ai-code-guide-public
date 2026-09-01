// AI_NOTE: 会話内の図は、VS Codeの「図」タブと同じ3種類のレイアウト規則（処理順・読解順・依存関係）で描く。
// MCP AppsではVS Code APIを直接使えないため、ノードを押した時だけshow_standard_viewを呼んで移動を委譲する。
export function buildDiagramAppShell(): string {
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; --line:#d5a900; --soft:color-mix(in srgb,var(--line) 10%,Canvas); --border:color-mix(in srgb,CanvasText 16%,transparent); --control-hover:color-mix(in srgb,CanvasText 8%,Canvas); }
    * { box-sizing:border-box; }
    body { margin:0; min-height:180px; color:CanvasText; background:Canvas; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    #status { margin:0; padding:22px 16px; text-align:center; opacity:.7; }
    #app { display:none; padding:16px; }
    body.ready #status { display:none; }
    body.ready #app { display:block; }
    body.error #status { color:#c33; opacity:1; }
    .diagram-header { margin-bottom:14px; }
    .diagram-title { margin:0; font-size:18px; line-height:1.35; }
    .diagram-summary { margin:8px 0 0; padding:9px 11px; border-left:3px solid var(--line); background:var(--soft); font-size:13px; line-height:1.6; }
    .diagram-guide,.jump-status { min-height:18px; margin:10px 2px 0; font-size:11px; color:color-mix(in srgb,CanvasText 66%,transparent); text-align:center; }
    .jump-status { color:CanvasText; }
    .jump-status.error { color:#c33; }
    .diagram-card { padding:10px; border:1px solid var(--border); border-radius:12px; overflow:hidden; }
    .pd-layout { width:100%; display:flex; flex-direction:column; --pd-line:var(--line); }
    .pd-node { position:relative; z-index:1; width:100%; min-width:0; border:0; color:CanvasText; background:transparent; font:inherit; text-align:left; cursor:text; -webkit-user-select:text; user-select:text; }
    .pd-node.reference { opacity:.76; }
    .pd-node-main { display:flex; flex-direction:column; min-width:0; gap:1px; }
    .pd-node-heading { display:flex; align-items:center; gap:6px; min-width:0; }
    .pd-node-label { min-width:0; font-size:13px; font-weight:650; line-height:1.35; overflow-wrap:anywhere; }
    .pd-emphasis-badge { flex:none; padding:1px 5px; border:1px solid var(--pd-accent); border-radius:999px; color:var(--pd-accent); font-size:9px; font-weight:700; line-height:1.3; }
    .pd-node-symbol { min-width:0; color:color-mix(in srgb,CanvasText 63%,transparent); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; line-height:1.35; overflow-wrap:anywhere; }
    .pd-node-copy { display:flex; flex-direction:column; gap:3px; min-width:0; }
    .pd-node-description { min-width:0; color:color-mix(in srgb,CanvasText 73%,transparent); font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
    .pd-emphasis-reason { min-width:0; color:var(--pd-accent); font-size:11px; font-weight:600; line-height:1.4; overflow-wrap:anywhere; }
    .pd-open { position:absolute; z-index:3; right:6px; top:5px; padding:2px 6px; border:1px solid var(--border); border-radius:5px; color:color-mix(in srgb,CanvasText 72%,transparent); background:Canvas; font:inherit; font-size:10px; line-height:1.4; cursor:pointer; -webkit-user-select:none; user-select:none; }
    .pd-open:hover,.pd-open:focus-visible { color:CanvasText; background:var(--control-hover); outline:1px solid color-mix(in srgb,CanvasText 34%,transparent); }
    .pd-open.busy,.pd-open:disabled { pointer-events:none; opacity:.72; cursor:wait; }
    .pd-node-main,.pd-node-copy { padding-right:56px; }
    .pd-edge-label { position:relative; z-index:2; display:inline-block; max-width:calc(100% - 12px); padding:1px 6px; border-radius:8px; color:color-mix(in srgb,CanvasText 63%,transparent); background:Canvas; font-size:10px; line-height:1.3; }
    .pd-layout-flow,.pd-layout-reading { gap:0; }
    .pd-flow-node,.pd-reading-node,.pd-dependency-node { --pd-accent:var(--pd-line); display:grid; grid-template-columns:minmax(130px,.85fr) minmax(150px,1.15fr); align-items:center; gap:12px; padding:9px 10px; border-left:2px solid var(--pd-accent); border-bottom:1px solid color-mix(in srgb,var(--pd-accent) 35%,transparent); }
    .pd-node.emphasis-important { --pd-accent:#b98500; background:color-mix(in srgb,#d5a900 10%,Canvas); }
    .pd-node.emphasis-warning { --pd-accent:#d94b4b; background:color-mix(in srgb,#d94b4b 10%,Canvas); }
    .pd-node.emphasis-success { --pd-accent:#2f9d63; background:color-mix(in srgb,#2f9d63 10%,Canvas); }
    .pd-node.emphasis-note { --pd-accent:#3986c7; background:color-mix(in srgb,#3986c7 10%,Canvas); }
    .pd-flow-node.no-description,.pd-reading-node.no-description,.pd-dependency-node.no-description { grid-template-columns:minmax(0,1fr); }
    .pd-flow-node.no-description .pd-node-main,.pd-dependency-node.no-description .pd-node-main { display:grid; grid-template-columns:minmax(0,1fr) minmax(120px,42%); align-items:center; gap:8px; }
    .pd-flow-node.no-description .pd-node-symbol,.pd-dependency-node.no-description .pd-node-symbol { text-align:right; }
    .pd-flow-link { position:relative; height:20px; margin-left:8px; display:flex; align-items:center; padding-left:20px; }
    .pd-flow-link::before { content:""; position:absolute; left:6px; top:0; bottom:6px; width:1px; background:var(--pd-line); }
    .pd-flow-link::after { content:""; position:absolute; left:3px; bottom:0; border-left:4px solid transparent; border-right:4px solid transparent; border-top:6px solid var(--pd-line); }
    .pd-flow-branches { display:flex; flex-direction:column; gap:5px; margin:3px 0 3px 11px; padding-left:13px; border-left:1px solid var(--pd-line); }
    .pd-flow-branch,.pd-dependency-child { position:relative; display:flex; flex-direction:column; gap:2px; min-width:0; }
    .pd-flow-branch::before,.pd-dependency-child::before { content:""; position:absolute; left:-13px; top:18px; width:12px; height:1px; background:var(--pd-line); }
    .pd-flow-branch>.pd-edge-label,.pd-dependency-child>.pd-edge-label { align-self:flex-start; margin:0 0 -2px 2px; }
    .pd-reading-row { position:relative; display:grid; grid-template-columns:34px minmax(0,1fr); gap:7px; padding:3px 0; }
    .pd-reading-row:not(:last-child)::after { content:""; position:absolute; z-index:0; left:15px; top:32px; bottom:-5px; width:1px; background:var(--pd-line); }
    .pd-reading-number { position:relative; z-index:1; align-self:start; width:30px; height:30px; display:inline-flex; align-items:center; justify-content:center; border-radius:50%; color:#1e1e1e; background:var(--pd-line); font-size:11px; font-weight:750; }
    .pd-dependency-branch { display:flex; flex-direction:column; min-width:0; }
    .pd-dependency-children { display:flex; flex-direction:column; margin-left:15px; padding-left:13px; border-left:1px solid var(--pd-line); }
    .pd-reference-mark { position:absolute; left:8px; top:50%; transform:translateY(-50%); color:var(--pd-line); font-size:15px; }
    .pd-node.reference { padding-left:28px; }
    @media (max-width:520px) { #app{padding:10px}.diagram-card{padding:7px}.pd-flow-node,.pd-reading-node,.pd-dependency-node{grid-template-columns:minmax(0,1fr);gap:3px}.pd-flow-node.no-description .pd-node-main,.pd-dependency-node.no-description .pd-node-main{grid-template-columns:minmax(0,1fr)}.pd-flow-node.no-description .pd-node-symbol,.pd-dependency-node.no-description .pd-node-symbol{text-align:left} }
  </style>
</head>
<body>
  <p id="status" role="status">コード図を作成しています…</p>
  <main id="app" aria-live="polite">
    <header class="diagram-header">
      <h2 class="diagram-title" id="title"></h2>
      <p class="diagram-summary" id="summary"></p>
      <p class="diagram-guide">文字は選択できます。右端の「コードへ」でVS Codeの該当箇所へ移動します。</p>
    </header>
    <section class="diagram-card" aria-label="コード図"><div id="diagram"></div></section>
    <p class="jump-status" id="jump-status" role="status"></p>
  </main>
  <script>
    const pending = new Map(); const jumpControls = new Set(); let nextId = 1; let workspaceRoot = ""; let activeJump = null;
    const rpcRequest = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); window.parent.postMessage({ jsonrpc:"2.0", id, method, params }, "*"); });
    const rpcNotify = (method, params) => window.parent.postMessage({ jsonrpc:"2.0", method, params }, "*");
    const absoluteFile = (file) => { const windowsAbsolute = file.length > 2 && file[1] === ":" && (file[2] === "/" || file.charCodeAt(2) === 92); if (!workspaceRoot || file.startsWith("/") || windowsAbsolute) return file; return workspaceRoot.replace(/[\\/]$/, "") + "/" + file.replace(/^[\\/]/, ""); };
    const setJumpStatus = (message, error) => { const element = document.getElementById("jump-status"); element.textContent = message; element.classList.toggle("error", Boolean(error)); };
    const setJumpControlsPending = (pendingState, owner) => { jumpControls.forEach((button) => { button.disabled = pendingState; button.classList.toggle("busy", pendingState && button === owner); if (pendingState) button.setAttribute("aria-disabled", "true"); else button.removeAttribute("aria-disabled"); }); };
    const openNode = async (node, control) => { if (activeJump) return; const file = typeof node.file === "string" ? node.file : ""; const sourceLine = Number(node.line); if (!file || !Number.isSafeInteger(sourceLine) || sourceLine < 1) { setJumpStatus("このノードには移動先がありません。", true); return; } const targetFile = absoluteFile(file); const jump = { file, targetFile, line:sourceLine }; activeJump = jump; setJumpControlsPending(true, control); setJumpStatus("VS Codeでコードを開いています…", false); try { const result = await rpcRequest("tools/call", { name:"show_standard_view", arguments:{ file:targetFile, line:sourceLine, focusWindow:true } }); if (result?.isError) throw new Error(result?.content?.[0]?.text || "コードを開けませんでした。"); const receipt = result?.structuredContent?.jumpReceipt; if (!receipt || receipt.acknowledged !== true || receipt.line !== sourceLine || receipt.selectionEmpty !== true || typeof receipt.receiptId !== "string" || !receipt.receiptId) throw new Error("VS Codeの対象行への到達確認を受け取れませんでした。"); setJumpStatus("VS Codeで " + file + ":" + sourceLine + " を開きました。確認: " + receipt.receiptId, false); } catch (error) { setJumpStatus(error?.message || "コードを開けませんでした。", true); } finally { if (activeJump === jump) activeJump = null; setJumpControlsPending(false, control); } };
    const element = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text) value.textContent = text; return value; };
    const kindOf = (value) => value === "reading" || value === "dependency" ? value : "flow";
    const renderDiagram = (diagram) => {
      const kind = kindOf(diagram.kind); const nodes = Array.isArray(diagram.nodes) ? diagram.nodes : [];
      const byId = new Map(nodes.filter((node) => node && typeof node.id === "string").map((node) => [node.id, node]));
      const seenEdges = new Set(); const edges = (Array.isArray(diagram.edges) ? diagram.edges : []).filter((edge) => { const key = edge?.from + "->" + edge?.to; if (!edge || !byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to || seenEdges.has(key)) return false; seenEdges.add(key); return true; });
      const outgoing = new Map(); const indegree = new Map(nodes.map((node) => [node.id, 0]));
      edges.forEach((edge) => { const list = outgoing.get(edge.from) || []; list.push(edge); outgoing.set(edge.from, list); indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1); });
      const nodeButton = (id, options = {}) => { const node = byId.get(id); const card = element("div", "pd-node pd-" + kind + "-node", ""); if (!node) return card; const description = typeof node.description === "string" ? node.description.trim() : ""; const emphasisLabels = { important:"重要", warning:"注意", success:"問題なさそう", note:"補足" }; const emphasis = typeof node.emphasis === "string" && emphasisLabels[node.emphasis] ? node.emphasis : ""; const emphasisReason = emphasis && typeof node.emphasisReason === "string" ? node.emphasisReason.trim() : ""; if (emphasis) card.classList.add("emphasis-" + emphasis); card.classList.toggle("reference", Boolean(options.reference)); card.classList.toggle("no-description", !description && !emphasisReason); const main = element("span", "pd-node-main", ""); const heading = element("span", "pd-node-heading", ""); const labelText = node.label || node.symbol || "コード地点"; heading.append(element("span", "pd-node-label", labelText)); if (emphasis) { const badge = element("span", "pd-emphasis-badge", emphasisLabels[emphasis]); if (emphasis === "success") badge.title = "AIがコード上の正常な完了経路と推定した箇所です。実行・テスト済みを意味しません。"; heading.append(badge); } const fileName = typeof node.file === "string" ? node.file.split("/").pop() : ""; const location = [node.symbol, fileName].filter(Boolean).join(" · "); main.append(heading, element("span", "pd-node-symbol", location)); if (options.reference) card.append(element("span", "pd-reference-mark", "↳")); card.append(main); if (description || emphasisReason) { const copy = element("span", "pd-node-copy", ""); if (description) copy.append(element("span", "pd-node-description", description)); if (emphasisReason) copy.append(element("span", "pd-emphasis-reason", (emphasis === "success" ? "AIの見立て: " + emphasisReason + "（実行・テスト未確認）" : "判断理由: " + emphasisReason))); card.append(copy); } const open = element("button", "pd-open", "コードへ"); open.type = "button"; open.title = "VS Codeの該当箇所へ移動"; jumpControls.add(open); /* AI_NOTE: ファイル名や説明を通常の文字選択に戻すため、コード移動は独立ボタンだけが担う。 */ open.addEventListener("click", () => { if (!open.disabled && !activeJump) openNode(node, open); }); card.append(open); return card; };
      const edgeLabel = (labelText) => typeof labelText === "string" && labelText.trim() ? element("span", "pd-edge-label", labelText.trim()) : null;
      const layout = element("div", "pd-layout pd-layout-" + kind, "");
      const roots = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id); if (!roots.length && nodes[0]) roots.push(nodes[0].id);
      if (kind === "reading") { const index = new Map(nodes.map((node, i) => [node.id, i])); const remaining = new Map(nodes.map((node) => [node.id, indegree.get(node.id) || 0])); const ready = nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id); const order = []; while (ready.length) { ready.sort((a, b) => index.get(a) - index.get(b)); const id = ready.shift(); order.push(id); (outgoing.get(id) || []).forEach((edge) => { const next = (remaining.get(edge.to) || 1) - 1; remaining.set(edge.to, next); if (next === 0) ready.push(edge.to); }); } nodes.forEach((node) => { if (!order.includes(node.id)) order.push(node.id); }); order.forEach((id, index) => { const row = element("div", "pd-reading-row", ""); row.append(element("span", "pd-reading-number", String(index + 1)), nodeButton(id)); layout.append(row); }); return layout; }
      const rendered = new Set();
      const dependency = (id, path) => { if (path.has(id) || rendered.has(id)) return nodeButton(id, { reference:true }); rendered.add(id); const branch = element("div", "pd-dependency-branch", ""); branch.append(nodeButton(id)); const children = outgoing.get(id) || []; if (children.length) { const list = element("div", "pd-dependency-children", ""); children.forEach((edge) => { const child = element("div", "pd-dependency-child", ""); const label = edgeLabel(edge.label); if (label) child.append(label); const nextPath = new Set(path); nextPath.add(id); child.append(dependency(edge.to, nextPath)); list.append(child); }); branch.append(list); } return branch; };
      const flow = (id, path) => { if (path.has(id) || rendered.has(id)) return nodeButton(id, { reference:true }); rendered.add(id); const current = nodeButton(id); const children = outgoing.get(id) || []; if (!children.length) return current; const nextPath = new Set(path); nextPath.add(id); if (children.length === 1) { const wrapper = document.createDocumentFragment(); wrapper.append(current); const link = element("div", "pd-flow-link", ""); const label = edgeLabel(children[0].label); if (label) link.append(label); wrapper.append(link, flow(children[0].to, nextPath)); return wrapper; } const wrapper = document.createDocumentFragment(); wrapper.append(current); const branches = element("div", "pd-flow-branches", ""); children.forEach((edge) => { const branch = element("div", "pd-flow-branch", ""); const label = edgeLabel(edge.label); if (label) branch.append(label); branch.append(flow(edge.to, nextPath)); branches.append(branch); }); wrapper.append(branches); return wrapper; };
      roots.forEach((id) => layout.append(kind === "dependency" ? dependency(id, new Set()) : flow(id, new Set()))); nodes.forEach((node) => { if (!rendered.has(node.id)) layout.append(kind === "dependency" ? dependency(node.id, new Set()) : flow(node.id, new Set())); }); return layout;
    };
    const showLoadError = (message) => { document.getElementById("status").textContent = message || "コード図を表示できませんでした。"; document.body.classList.remove("ready"); document.body.classList.add("error"); };
    const render = (result) => { try { const value = result?.result ?? result; if (value?.isError) throw new Error(value?.content?.find((item) => item?.type === "text")?.text || "コード図を作成できませんでした。"); const structured = value?.structuredContent; const meta = value?._meta ?? value?.meta; const diagram = structured?.diagram; if (!diagram || !Array.isArray(diagram.nodes)) throw new Error("コード図の表示データを受け取れませんでした。"); workspaceRoot = typeof meta?.diagramWorkspaceRoot === "string" ? meta.diagramWorkspaceRoot : ""; document.getElementById("title").textContent = diagram.title || "コード図"; const summary = document.getElementById("summary"); summary.textContent = diagram.summary || ""; summary.hidden = !diagram.summary; const target = document.getElementById("diagram"); target.replaceChildren(renderDiagram(diagram)); document.body.classList.remove("error"); document.body.classList.add("ready"); } catch (error) { showLoadError(error?.message || "コード図を表示できませんでした。"); } };
    window.addEventListener("message", (event) => { if (event.source !== window.parent) return; const message = event.data; if (!message || message.jsonrpc !== "2.0") return; if (message.id !== undefined && pending.has(message.id)) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request.reject(message.error); else request.resolve(message.result); return; } if (message.method === "ui/notifications/tool-result") render(message.params); }, { passive:true });
    rpcRequest("ui/initialize", { appInfo:{ name:"ai-code-guide-diagram", version:"0.5.0" }, appCapabilities:{}, protocolVersion:"2026-01-26" }).then(() => rpcNotify("ui/notifications/initialized", {})).catch(() => showLoadError("コード図の表示を初期化できませんでした。"));
  </script>
</body>
</html>`;
}
