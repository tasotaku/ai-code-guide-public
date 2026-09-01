import type { AgentTraceAttempt } from "./projectDiagramBridge";

import { sharedCodeSurfaceCss, sharedCodeSurfaceRuntime } from "./sharedCodeSurface";

type CodeLine = { line: number; text: string };
type TraceFunction = {
    funcName: string;
    color?: string;
    sourceSha256?: string;
    runReceiptId?: string;
    role?: string;
    location?: string;
    controlPath?: Array<{ line: number; outcome: boolean }>;
    keyValues?: Array<{ line: number; text: string }>;
    safetyDecision?: "safe" | "known-unsafe" | "safety-unknown";
    runId?: string;
    executedAt?: string;
    arguments?: Record<string, unknown>;
    finalLocals?: Record<string, { short: string; full: string }>;
    returnValue?: { short: string; full: string } | null;
    error?: string | null;
    calls?: Array<{
        sequence: number;
        depth: number;
        function: string;
        line: number;
        arguments: Record<string, { short: string; full: string }>;
        return_value: { short: string; full: string } | null;
        exception?: { type: string; message: string } | null;
    }>;
    controlPoints?: Array<{ line: number; kind: "if" | "return" | "assert" }>;
    executedLines?: number[];
    pathEvents?: Array<{ line: number; kind: "if"; outcome: boolean }>;
    startLine: number;
    endLine: number;
    code: CodeLine[];
    loop?: { headerLine: number; total: number; actualTotal: number };
    iterations: Array<{ number: number; values: Array<{ line: number; text: string }> }>;
};

export type TraceWebViewData = {
    file?: string;
    trace: {
        traceEntryId?: string;
        entryState?: "open" | "closed";
        attempts?: AgentTraceAttempt[];
        funcNames: string[];
        loopCount: number;
        functions: TraceFunction[];
    };
};

function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
        const code = character.charCodeAt(0).toString(16).padStart(4, "0");
        return `\\u${code}`;
    });
}
// AI_NOTE: CodexのMCP App fullscreenは会話内iframeを隠して右パネルへ移すため、
// 横幅が必要なトレースだけは同じloopback bridge上の通常HTMLとして描画する。
// 表示データはページへ埋め込み、外部通信は検証済みコード移動POSTだけに限定する。
export function buildTraceWebView(data: TraceWebViewData, viewId: string): string {
    // Keep operational receipts, hashes, safety bookkeeping, and call trees in
    // the internal record. The user-facing trace page only receives fields
    // required for the line-by-line execution view.
    const initial = safeJson({
        file: data.file,
        trace: {
            functions: data.trace.functions.map((fn) => ({
                funcName: fn.funcName,
                color: fn.color,
                startLine: fn.startLine,
                endLine: fn.endLine,
                code: fn.code,
                loop: fn.loop,
                iterations: fn.iterations,
                pathEvents: fn.pathEvents,
            })),
        },
    });
    const encodedViewId = JSON.stringify(viewId);
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Code Guide · 実行トレース</title>
  <style>
    :root { color-scheme:light dark; --surface:Canvas; --text:CanvasText; --muted:color-mix(in srgb,CanvasText 64%,transparent); --border:color-mix(in srgb,CanvasText 18%,transparent); --code:#1f1f1f; --editor-text:#d4d4d4; --editor-muted:#858585; --accent:#4f7cff; --trace:#9cdcfe; --warning:#f48771; --keyword:#c586c0; --function:#dcdcaa; --string:#ce9178; --number:#b5cea8; --comment:#6a9955; --name:#9cdcfe; --type:#4ec9b0; --decorator:#dcdcaa; --info:#e2b93d; --editor-font:Consolas,"Courier New",monospace; --editor-font-size:14px; --editor-line-height:20px; }
    * { box-sizing:border-box; }
    html,body { margin:0; min-height:100%; color:var(--text); background:var(--surface); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    body { padding:14px; }
    .page { width:100%; max-width:none; margin:0 auto; }
    .header { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between; gap:14px; margin:-14px -14px 12px; padding:12px 14px; border-bottom:1px solid var(--border); background:color-mix(in srgb,var(--surface) 94%,transparent); backdrop-filter:blur(8px); }
    .heading { min-width:0; }
    .eyebrow { margin:0 0 2px; color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.06em; }
    h1 { margin:0; font-size:17px; line-height:1.35; overflow-wrap:anywhere; }
    .hint { flex:0 0 auto; margin:0; color:var(--muted); font-size:11px; }
    .list { display:flex; flex-direction:column; gap:12px; }
    .evidence { overflow:hidden; border:1px solid var(--border); border-radius:10px; background:var(--code); }
    .evidence-head { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:42px; padding:8px 10px; border-bottom:1px solid var(--border); background:var(--surface); }
    .evidence-title { min-width:0; margin:0; font:650 13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    .evidence-actions { display:flex; align-items:center; gap:8px; }
    .location { color:var(--muted); font-size:10px; white-space:nowrap; }
    button { font:inherit; }
    .open-code,.loop button { border:1px solid var(--border); border-radius:7px; color:var(--text); background:var(--surface); cursor:pointer; }
    .open-code { padding:5px 8px; font-size:10px; white-space:nowrap; }
    .open-code:hover,.open-code:focus-visible,.loop button:hover:not(:disabled),.loop button:focus-visible { border-color:var(--accent); color:var(--accent); outline:none; }
    .open-code:disabled { cursor:wait; opacity:.55; }
    .trace-grid { --split-default:62%; display:grid; grid-template-columns:minmax(0,var(--trace-split,var(--split-default))) 8px minmax(0,1fr); min-width:0; }
    .splitter { position:relative; z-index:3; width:8px; min-width:8px; cursor:col-resize; touch-action:none; background:color-mix(in srgb,var(--editor-text) 12%,transparent); }
    .splitter::after { content:""; position:absolute; top:0; bottom:0; left:3px; width:2px; background:color-mix(in srgb,var(--editor-text) 42%,transparent); }
    .splitter:hover,.splitter:focus-visible { outline:none; background:color-mix(in srgb,var(--accent) 24%,transparent); }
    .splitter:hover::after,.splitter:focus-visible::after { background:var(--accent); }
    .trace-pane { min-width:0; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--editor-text) 34%,transparent) transparent; }
    .trace-pane::-webkit-scrollbar { height:8px; }
    .trace-pane::-webkit-scrollbar-track { background:transparent; }
    .trace-pane::-webkit-scrollbar-thumb { border-radius:999px; background:color-mix(in srgb,var(--editor-text) 34%,transparent); }
    .trace-note-pane { position:relative; z-index:1; overflow-x:scroll; scrollbar-gutter:stable; scrollbar-color:#9b9b9b #2d2d2d; background:var(--code); }
    .trace-note-pane::-webkit-scrollbar { height:12px; background:#2d2d2d; }
    .trace-note-pane::-webkit-scrollbar-track { background:#2d2d2d; }
    .trace-note-pane::-webkit-scrollbar-thumb { min-width:48px; border:2px solid #2d2d2d; border-radius:999px; background:#9b9b9b; background-clip:padding-box; }
    .trace-lines { display:grid; width:max-content; min-width:100%; }
    .trace-note-pane .trace-lines { width:100%; min-width:0; }
    .trace-row { display:flex; align-items:center; width:100%; height:var(--editor-line-height); min-height:var(--editor-line-height); border-bottom:1px solid color-mix(in srgb,var(--editor-text) 5%,transparent); white-space:nowrap; }
    .code { min-width:max-content; padding:0 9px 0 0; font:var(--editor-font-size)/var(--editor-line-height) var(--editor-font); }
    .note { width:max-content; min-width:100%; padding:0 10px; color:var(--editor-muted); font:var(--editor-font-size)/var(--editor-line-height) var(--editor-font); white-space:nowrap; overflow:visible; }
    .value { color:var(--trace); }
    .gap { min-height:var(--editor-line-height); justify-content:center; padding:0 12px; color:var(--editor-muted); font-size:10px; }
    ${sharedCodeSurfaceCss}
    .loop { display:inline-flex; flex:0 0 auto; align-items:center; gap:3px; height:var(--editor-line-height); margin-right:5px; color:var(--info); font:650 var(--editor-font-size)/var(--editor-line-height) var(--editor-font); white-space:nowrap; }
    .loop button { width:18px; height:18px; padding:0; font-size:9px; line-height:16px; }
    .loop button:disabled { cursor:default; opacity:.35; }
    .limit { padding:7px 10px; border-top:1px solid var(--border); color:var(--muted); background:var(--surface); font-size:10px; }
    .status { min-height:18px; margin:8px 2px 0; color:var(--accent); font-size:11px; }
    .status.error { color:var(--warning); }
    .empty { padding:28px 16px; border:1px dashed var(--border); border-radius:10px; color:var(--muted); text-align:center; }
    @media (max-width:700px) { body{padding:9px}.header{margin:-9px -9px 9px;padding:10px}.hint{display:none}.trace-grid{--split-default:58%}.evidence-head{align-items:flex-start}.evidence-actions{flex-direction:column;align-items:flex-end;gap:4px} }
  </style>
</head>
<body>
  <main class="page">
    <header class="header">
      <div class="heading"><p class="eyebrow">AI CODE GUIDE · 実行トレース</p><h1 id="title"></h1></div>
      <p class="hint">右上の閉じる操作で会話へ戻れます</p>
    </header>
    <section class="list" id="content"></section>
    <p class="status" id="status" role="status"></p>
  </main>
  <script>
    const data=${initial};
    const viewId=${encodedViewId};
    const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;};
    ${sharedCodeSurfaceRuntime}
    // AI_NOTE: 複数メソッドを同じWebビューへ出すため、左右比率は関数ごとに独立して保持する。周回再描画でも同じ関数だけ復元する。
    const splitStorageKey=(functionKey)=>"ai-code-guide:trace-split:"+viewId+":"+functionKey;
    const clampSplit=(value)=>Math.max(20,Math.min(80,value));
    const readSplit=(key)=>{try{const value=Number(sessionStorage.getItem(key));return Number.isFinite(value)&&value>=20&&value<=80?value:null;}catch{return null;}};
    const defaultSplit=(grid)=>Number.parseFloat(getComputedStyle(grid).getPropertyValue("--split-default"))||62;
    const splitterFor=(grid,functionKey)=>{const storageKey=splitStorageKey(functionKey);let splitRatio=readSplit(storageKey);if(splitRatio!==null)grid.style.setProperty("--trace-split",splitRatio+"%");const handle=element("div","splitter");handle.tabIndex=0;handle.setAttribute("role","separator");handle.setAttribute("aria-orientation","vertical");handle.setAttribute("aria-label","コードと実行値の幅を調整");handle.setAttribute("aria-valuemin","20");handle.setAttribute("aria-valuemax","80");handle.setAttribute("aria-valuenow",String(Math.round(splitRatio??defaultSplit(grid))));const setSplit=(value)=>{splitRatio=clampSplit(value);grid.style.setProperty("--trace-split",splitRatio+"%");handle.setAttribute("aria-valuenow",String(Math.round(splitRatio)));try{sessionStorage.setItem(storageKey,String(splitRatio));}catch{/* storage無効時もドラッグ操作は維持する */}};let pointerId=null;let mouseDragging=false;const update=(clientX)=>{const bounds=grid.getBoundingClientRect();if(bounds.width>0)setSplit((clientX-bounds.left)/bounds.width*100);};const move=(event)=>{if(event.pointerId===pointerId)update(event.clientX);};const stop=(event)=>{if(event.pointerId!==pointerId)return;pointerId=null;if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);};handle.addEventListener("pointerdown",event=>{pointerId=event.pointerId;handle.setPointerCapture(event.pointerId);event.preventDefault();update(event.clientX);});handle.addEventListener("pointermove",move);handle.addEventListener("pointerup",stop);handle.addEventListener("pointercancel",stop);handle.addEventListener("mousedown",event=>{mouseDragging=true;event.preventDefault();update(event.clientX);});window.addEventListener("mousemove",event=>{if(mouseDragging)update(event.clientX);});window.addEventListener("mouseup",()=>{mouseDragging=false;});handle.addEventListener("keydown",event=>{const current=splitRatio??defaultSplit(grid);let next;if(event.key==="ArrowLeft")next=current-2;else if(event.key==="ArrowRight")next=current+2;else if(event.key==="Home")next=20;else if(event.key==="End")next=80;else return;event.preventDefault();setSplit(next);});return handle;};
    const setStatus=(text,error=false)=>{const node=document.getElementById("status");node.textContent=text;node.classList.toggle("error",error);};
    const openCode=async(button,line)=>{button.disabled=true;setStatus("VS Codeでコードを開いています…");try{const response=await fetch("/view/"+viewId+"/open",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file:data.file,line})});if(!response.ok)throw new Error(await response.text()||"コードを開けませんでした。");setStatus("VS Codeで "+data.file+":"+line+" を開きました。");}catch(error){setStatus(error?.message||"コードを開けませんでした。",true);}finally{button.disabled=false;}};
    const rows=(lines,noteFor,functionKey)=>{const visible=lines||[];const indents=visible.filter(line=>line.text.trim()).map(line=>(line.text.match(/^[ \\t]*/)||[""])[0].length);const baseIndent=indents.length?Math.min(...indents):0;const grid=element("div","trace-grid");const codePane=element("div","trace-pane trace-code-pane");const notePane=element("div","trace-pane trace-note-pane");codePane.tabIndex=0;notePane.tabIndex=0;const codeLines=element("div","trace-lines");const noteLines=element("div","trace-lines");let previous=0;visible.forEach(item=>{if(previous&&item.line>previous+1){codeLines.append(element("div","trace-row gap","… 省略 …"));noteLines.append(element("div","trace-row gap","… 省略 …"));}const codeRow=element("div","trace-row");codeRow.append(codeSurface.python(item.text.slice(baseIndent)));const note=noteFor(item.line);const noteRow=element("div","trace-row note");if(note.loop)noteRow.append(note.loop);if(note.text)noteRow.append(element("span",note.value?"value":"",note.text));codeLines.append(codeRow);noteLines.append(noteRow);previous=item.line;});codePane.append(codeLines);notePane.append(noteLines);grid.append(codePane,splitterFor(grid,functionKey),notePane);return grid;};
    const renderFunction=(fn)=>{const article=element("article","evidence");const functionKey=fn.funcName+":"+fn.startLine+":"+fn.endLine;const head=element("header","evidence-head");head.append(element("h2","evidence-title",fn.funcName+"()"));const actions=element("div","evidence-actions");actions.append(element("span","location","L"+fn.startLine+"–"+fn.endLine));const open=element("button","open-code","VS Codeで開く");open.type="button";open.addEventListener("click",()=>openCode(open,fn.startLine));actions.append(open);head.append(actions);article.append(head);let index=0;const draw=()=>{const old=article.querySelector(".trace-grid");const iteration=fn.iterations[index]||{values:[]};const values=new Map((iteration.values||[]).map(value=>[value.line,value.text]));const paths=new Map((fn.pathEvents||[]).map(event=>[event.line,event.outcome]));const grid=rows(fn.code,line=>{const value=values.get(line)||"";const path=paths.has(line)?"条件: "+(paths.get(line)?"true":"false"):"";const text=[path,value].filter(Boolean).join(" · ");if(!fn.loop||line!==fn.loop.headerLine)return{text,value:Boolean(value)};const control=element("span","loop");const previous=element("button","","◀");const label=element("span","",(index+1)+"周目 / 全"+fn.loop.actualTotal+"周");const next=element("button","","▶");previous.type=next.type="button";previous.disabled=index===0;next.disabled=index>=fn.iterations.length-1;previous.addEventListener("click",()=>{index--;draw();});next.addEventListener("click",()=>{index++;draw();});control.append(previous,label,next);return{loop:control,text,value:Boolean(value)};},functionKey,fn.color);if(old)old.replaceWith(grid);else article.append(grid);};draw();if(fn.loop&&fn.loop.actualTotal>fn.loop.total)article.append(element("div","limit","最初の"+fn.loop.total+"周を表示しています。残りはVS Codeで確認できます。"));return article;};
    document.getElementById("title").textContent=data.file||"Pythonコード";
    const content=document.getElementById("content");
    const functions=data.trace?.functions||[];
    if(functions.length===0)content.append(element("div","empty","実行トレースはありません。"));
    else functions.forEach(fn=>content.append(renderFunction(fn)));
  </script>
</body>
</html>`;
}
