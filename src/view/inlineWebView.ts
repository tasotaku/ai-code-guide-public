import { sharedCodeSurfaceCss, sharedCodeSurfaceRuntime } from "./sharedCodeSurface";

type CodeLine = { line: number; text: string };
type ConversationMessage = { role: "user" | "assistant"; content: string };

export type InlineWebViewData = {
    file?: string;
    annotations: {
        generatedAt?: string;
        context?: { label: string; startLine: number; endLine: number; code: CodeLine[] };
        conversations?: Record<string, ConversationMessage[]>;
        items: Array<{
            id: string;
            kind: "symbol" | "block";
            severity: "info" | "warning";
            label: string;
            explanation: string;
            symbolKey?: string;
            symbolKind?: "variable" | "function" | "method" | "class";
            startLine: number;
            endLine: number;
            startCol?: number | null;
            endCol?: number | null;
            code: CodeLine[];
        }>;
    };
};

function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function buildInlineWebView(data: InlineWebViewData, viewId: string): string {
    const initial = safeJson(data);
    const encodedViewId = JSON.stringify(viewId);
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Code Guide · 名称辞書</title>
  <style>
    :root{color-scheme:light dark;--surface:Canvas;--text:CanvasText;--muted:color-mix(in srgb,CanvasText 64%,transparent);--border:color-mix(in srgb,CanvasText 18%,transparent);--code:#1f1f1f;--editor-text:#d4d4d4;--editor-muted:#858585;--accent:#4f7cff;--keyword:#c586c0;--function:#dcdcaa;--string:#ce9178;--number:#b5cea8;--comment:#6a9955;--name:#9cdcfe;--type:#4ec9b0;--decorator:#dcdcaa;--editor-font:Consolas,"Courier New",monospace;--editor-font-size:14px;--editor-line-height:20px}
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;color:var(--text);background:var(--surface);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{padding:14px}.page{width:100%;margin:0 auto}.header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:14px;margin:-14px -14px 12px;padding:12px 14px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--surface) 94%,transparent);backdrop-filter:blur(8px)}.heading{min-width:0}.eyebrow{margin:0 0 2px;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em}h1{margin:0;font-size:17px;line-height:1.35;overflow-wrap:anywhere}.summary{margin:0;color:var(--muted);font-size:11px}.scope{overflow:hidden;border:1px solid var(--border);border-radius:10px;background:var(--code)}.scope-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:46px;padding:9px 11px;border-bottom:1px solid var(--border);background:var(--surface)}.title-row{display:flex;min-width:0;align-items:center;gap:7px}.scope-title{min-width:0;margin:0;font-size:14px}.scope-count{flex:0 0 auto;padding:2px 7px;border-radius:999px;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);font-size:10px;font-weight:700}.actions{display:flex;align-items:center;gap:8px}.location{color:var(--muted);font-size:10px;white-space:nowrap}button{border:1px solid var(--border);border-radius:7px;padding:6px 9px;color:var(--text);background:var(--surface);font:inherit;font-size:11px;cursor:pointer}button:hover,button:focus-visible{border-color:var(--accent);color:var(--accent);outline:none}button:disabled{cursor:wait;opacity:.55}.code-pane{min-width:0;overflow:auto;scrollbar-width:thin}.code-lines{display:grid;width:max-content;min-width:100%;padding-top:var(--pinned-card-offset,0px)}.code-row{display:flex;align-items:center;width:100%;height:var(--editor-line-height);min-height:var(--editor-line-height);border-bottom:1px solid color-mix(in srgb,var(--editor-text) 5%,transparent)}.line-no{flex:0 0 40px;padding-right:8px;color:var(--editor-muted);font:12px/var(--editor-line-height) var(--editor-font);text-align:right;user-select:none}.code-cell{position:relative;min-width:max-content;padding-right:14px;font:var(--editor-font-size)/var(--editor-line-height) var(--editor-font)}.code{min-width:max-content;font:inherit}.gap{height:var(--editor-line-height);padding-left:12px;color:var(--editor-muted);font:12px/var(--editor-line-height) var(--editor-font)}
    /* 名称は通常コードと同じ外観。下線・背景・行間ラベルは付けない。 */
    .symbol-anchor{display:inline;color:inherit;text-decoration:none;background:none;outline:none;cursor:pointer}.symbol-anchor:focus-visible{outline:1px solid var(--accent);outline-offset:1px}
    .symbol-card{position:fixed;z-index:100;width:min(430px,calc(100vw - 16px));max-height:min(560px,calc(100vh - 16px));overflow:auto;padding:12px;border:1px solid #454545;border-radius:7px;color:#d4d4d4;background:#252526;box-shadow:0 8px 28px rgba(0,0,0,.55);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.symbol-card[hidden]{display:none}.symbol-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.symbol-card h2{margin:0;color:#f0f0f0;font-size:14px}.symbol-kind{margin:2px 0 0;color:#9a9a9a;font-size:10px}.symbol-description{margin:10px 0 0;color:#d0d0d0;overflow-wrap:anywhere}.chat{display:grid;gap:7px;margin-top:12px;padding-top:10px;border-top:1px solid #454545}.chat-log{display:grid;gap:6px;max-height:190px;overflow:auto}.message{margin:0;padding:7px 9px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{margin-left:34px;background:#26354d}.message.assistant{margin-right:18px;background:#333}.ask-row{display:grid;grid-template-columns:1fr auto;gap:7px}.ask-row input{min-width:0;border:1px solid #555;border-radius:6px;padding:8px;color:#eee;background:#1e1e1e;font:inherit}.ask-row input:focus{border-color:var(--accent);outline:none}.loading::before{content:"";display:inline-block;width:11px;height:11px;margin-right:6px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-2px;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.card-actions{display:flex;justify-content:space-between;gap:8px;margin-top:8px}.card-actions .quiet{color:#bbb;background:transparent}.status{min-height:18px;margin:8px 2px 0;color:var(--accent);font-size:11px}.status.error{color:#f48771}.empty{padding:28px 16px;border:1px dashed var(--border);border-radius:10px;color:var(--muted);text-align:center}
    ${sharedCodeSurfaceCss}
  </style>
</head>
<body>
  <main class="page"><header class="header"><div class="heading"><p class="eyebrow">AI CODE GUIDE · 名称辞書</p><h1 id="title"></h1></div><p class="summary" id="summary"></p></header><section id="content"></section><p class="status" id="status" role="status"></p></main>
  <script>
    const data=${initial};const viewId=${encodedViewId};
    const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node};
    ${sharedCodeSurfaceRuntime}
    const items=(data.annotations?.items||[]).filter(item=>item.kind==="symbol"&&item.symbolKey);
    const conversations=data.annotations?.conversations||{};let initialItems=JSON.stringify(items);let pinnedKey=null;let activeAnchor=null;let hoverHideTimer=null;
    const card=element("aside","symbol-card");card.hidden=true;document.body.append(card);
    const setStatus=(text,error=false)=>{const node=document.getElementById("status");node.textContent=text;node.classList.toggle("error",error)};
    const kindLabel=kind=>({variable:"変数",function:"関数",method:"メソッド",class:"クラス"}[kind]||"名称");
    const itemFor=key=>items.find(item=>item.symbolKey===key);
    const clearPinnedOffset=()=>document.querySelector(".code-lines")?.style.removeProperty("--pinned-card-offset");
    const positionCard=(anchor,pinned=false)=>{const bounds=card.getBoundingClientRect();const lines=anchor.closest?.(".code-lines");let target=anchor.getBoundingClientRect();if(pinned&&lines){const current=Number.parseFloat(lines.style.getPropertyValue("--pinned-card-offset"))||0;const baseTop=target.top-current;const desired=Math.max(0,bounds.height+16-baseTop);lines.style.setProperty("--pinned-card-offset",desired+"px");target=anchor.getBoundingClientRect()}const left=Math.max(8,Math.min(window.innerWidth-bounds.width-8,target.left));const above=target.top-bounds.height-8;card.style.left=left+"px";card.style.top=(pinned?Math.max(8,above):(above>=8?above:Math.min(window.innerHeight-bounds.height-8,target.bottom+8)))+"px"};
    const cancelHoverHide=()=>{if(hoverHideTimer!==null){window.clearTimeout(hoverHideTimer);hoverHideTimer=null}};
    const hideCard=()=>{cancelHoverHide();if(pinnedKey)return;card.hidden=true;card.replaceChildren();activeAnchor=null};
    const scheduleHoverHide=()=>{cancelHoverHide();hoverHideTimer=window.setTimeout(hideCard,180)};
    const closePinned=()=>{cancelHoverHide();clearPinnedOffset();pinnedKey=null;hideCard()};
    const renderMessages=(parent,key)=>{const log=element("div","chat-log");(conversations[key]||[]).forEach(message=>log.append(element("p","message "+message.role,message.content)));if(log.childNodes.length)parent.append(log)};
    const updateItemExplanation=(key,explanation)=>{items.filter(item=>item.symbolKey===key).forEach(item=>item.explanation=explanation);document.querySelectorAll('[data-symbol-key="'+CSS.escape(key)+'"]').forEach(node=>{node.setAttribute("aria-label",(itemFor(key)?.label||"")+"。"+explanation)});initialItems=JSON.stringify(items)};
    const ask=async(key,input,button,mode="ask")=>{const originalLabel=button.textContent;button.disabled=true;button.classList.add("loading");button.setAttribute("aria-busy","true");button.textContent=mode==="undo"?"戻しています":"回答待ち";input.disabled=true;setStatus(mode==="undo"?"前の説明へ戻しています…":"回答を作り、説明を更新しています…");try{const response=await fetch("/view/"+viewId+"/ask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbolKey:key,question:input.value,mode})});if(!response.ok)throw new Error(await response.text()||"説明を更新できませんでした。");const result=await response.json();conversations[key]=result.history||[];updateItemExplanation(key,result.explanation);showCard(activeAnchor,itemFor(key),true,result.canUndo);setStatus(mode==="undo"?"前の説明へ戻しました。":"回答を説明へ反映しました。")}catch(error){setStatus(error?.message||"説明を更新できませんでした。",true)}finally{button.disabled=false;button.classList.remove("loading");button.removeAttribute("aria-busy");button.textContent=originalLabel;input.disabled=false}};
    const showCard=(anchor,item,pinned=false,canUndo=false)=>{if(!anchor||!item)return;cancelHoverHide();activeAnchor=anchor;card.replaceChildren();card.classList.toggle("hovering",!pinned);const head=element("div","symbol-card-head");const names=element("div","");names.append(element("h2","",item.label),element("p","symbol-kind",kindLabel(item.symbolKind)));head.append(names);if(pinned){const close=element("button","quiet","閉じる");close.type="button";close.addEventListener("click",closePinned);head.append(close)}else{const question=element("button","","質問する");question.type="button";question.addEventListener("click",event=>{event.stopPropagation();pin(anchor,item)});head.append(question)}card.append(head,element("p","symbol-description",item.explanation));if(pinned){const chat=element("div","chat");renderMessages(chat,item.symbolKey);const row=element("form","ask-row");const input=element("input","");input.type="text";input.maxLength=1000;input.placeholder="この名前について質問";input.setAttribute("aria-label",item.label+"について質問");const send=element("button","","質問する");send.type="submit";row.append(input,send);row.addEventListener("submit",event=>{event.preventDefault();if(input.value.trim())ask(item.symbolKey,input,send)});chat.append(row);const actions=element("div","card-actions");const undo=element("button","quiet","前の説明に戻す");undo.type="button";undo.disabled=!canUndo;undo.addEventListener("click",()=>ask(item.symbolKey,input,undo,"undo"));actions.append(undo);chat.append(actions);card.append(chat);requestAnimationFrame(()=>input.focus())}card.hidden=false;requestAnimationFrame(()=>positionCard(anchor,pinned))};
    const pin=(anchor,item)=>{cancelHoverHide();clearPinnedOffset();pinnedKey=item.symbolKey;showCard(anchor,item,true,(conversations[item.symbolKey]||[]).length>0)};
    const appendHighlighted=(parent,text)=>codeSurface.appendPython(parent,text);
    const annotatedPython=(text,symbols,baseIndent)=>{const root=element("code","code");let cursor=0;const entries=symbols.map(item=>{const start=Math.max(0,Math.min(text.length,(item.startCol??baseIndent)-baseIndent));const end=Math.max(start+1,Math.min(text.length,(item.endCol??item.startCol??baseIndent+1)-baseIndent));return{item,start,end}}).sort((a,b)=>a.start-b.start||a.end-b.end);entries.forEach(({item,start,end})=>{if(start<cursor)return;appendHighlighted(root,text.slice(cursor,start));const anchor=element("span","symbol-anchor");anchor.tabIndex=0;anchor.dataset.symbolKey=item.symbolKey;anchor.setAttribute("aria-label",item.label+"。"+item.explanation);appendHighlighted(anchor,text.slice(start,end));anchor.addEventListener("mouseenter",()=>{if(!pinnedKey)showCard(anchor,item)});anchor.addEventListener("mouseleave",scheduleHoverHide);anchor.addEventListener("focus",()=>{if(!pinnedKey)showCard(anchor,item)});anchor.addEventListener("blur",scheduleHoverHide);anchor.addEventListener("click",event=>{if(event.detail===1&&!window.getSelection()?.toString())pin(anchor,item)});root.append(anchor);cursor=end});appendHighlighted(root,text.slice(cursor));return root};
    const fallbackCode=()=>{const lines=new Map();items.forEach(item=>(item.code||[]).forEach(row=>lines.set(row.line,row)));return[...lines.values()].sort((a,b)=>a.line-b.line)};
    const fallbackStart=items.length?Math.min(...items.map(item=>item.startLine)):1;const fallbackEnd=items.length?Math.max(...items.map(item=>item.endLine)):fallbackStart;
    const context=data.annotations?.context||{label:"辞書対象",startLine:fallbackStart,endLine:fallbackEnd,code:fallbackCode()};
    const openCode=async(button,line)=>{button.disabled=true;setStatus("VS Codeでコードを開いています…");try{const response=await fetch("/view/"+viewId+"/open",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file:data.file,line})});if(!response.ok)throw new Error(await response.text()||"コードを開けませんでした。");setStatus("VS Codeで "+data.file+":"+line+" を開きました。")}catch(error){setStatus(error?.message||"コードを開けませんでした。",true)}finally{button.disabled=false}};
    const renderScope=()=>{const scope=element("article","scope");const head=element("header","scope-head");const titleRow=element("div","title-row");titleRow.append(element("h2","scope-title",context.label));titleRow.append(element("span","scope-count",new Set(items.map(item=>item.symbolKey)).size+"個の名称"));const actions=element("div","actions");actions.append(element("span","location","L"+context.startLine+"–"+context.endLine));const open=element("button","","範囲をVS Codeで開く");open.type="button";open.addEventListener("click",()=>openCode(open,context.startLine));actions.append(open);head.append(titleRow,actions);const pane=element("div","code-pane");const lines=element("div","code-lines");let previous=0;const visible=context.code||[];const indents=visible.filter(line=>line.text.trim()).map(line=>(line.text.match(/^[ \\t]*/)||[""])[0].length);const baseIndent=indents.length?Math.min(...indents):0;visible.forEach(rowData=>{if(previous&&rowData.line>previous+1)lines.append(element("div","gap","… 省略 …"));const row=element("div","code-row");row.dataset.line=String(rowData.line);row.append(element("span","line-no",rowData.line));const cell=element("span","code-cell");cell.append(annotatedPython(rowData.text.slice(baseIndent),items.filter(item=>item.startLine===rowData.line),baseIndent));row.append(cell);lines.append(row);previous=rowData.line});pane.append(lines);scope.append(head,pane);return scope};
    document.getElementById("title").textContent=data.file||"Pythonコード";document.getElementById("summary").textContent=new Set(items.map(item=>item.symbolKey)).size+"個の名称";const content=document.getElementById("content");if(items.length===0)content.append(element("div","empty","この範囲に調べられる名称はありません。"));else content.append(renderScope());
    card.addEventListener("mouseenter",cancelHoverHide);card.addEventListener("mouseleave",scheduleHoverHide);document.addEventListener("click",event=>{if(!pinnedKey)return;const target=event.target;if(target?.closest?.(".symbol-card")||target?.closest?.(".symbol-anchor"))return;closePinned()});document.addEventListener("keydown",event=>{if(event.key==="Escape"&&pinnedKey)closePinned()});window.addEventListener("scroll",()=>{if(!pinnedKey)hideCard()},true);window.addEventListener("resize",()=>{if(activeAnchor&&!card.hidden)positionCard(activeAnchor,Boolean(pinnedKey))});
    window.setInterval(async()=>{if(document.hidden)return;try{const response=await fetch("/view/"+viewId+"/state",{cache:"no-store"});if(!response.ok)return;const latest=await response.json();const next=(latest.annotations?.items||[]).filter(item=>item.kind==="symbol"&&item.symbolKey);if(JSON.stringify(next)!==initialItems)window.location.reload()}catch{/* bridge再起動中は次回確認 */}},1200);
  </script>
</body>
</html>`;
}
