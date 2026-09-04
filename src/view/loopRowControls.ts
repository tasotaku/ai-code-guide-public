import { projectTracePlayback } from "../inline/tracePlayback";

export const loopRowControlsCss = `
.loop-controls{display:inline-flex;align-items:center;vertical-align:top;height:var(--line-height);max-width:120px;gap:1px;margin-right:6px;padding:1px;border:1px solid #665b35;border-radius:5px;color:#f1d995;background:#2d2a20;box-shadow:inset 0 1px #ffffff0d;white-space:nowrap}
.loop-controls button{width:20px;height:17px;padding:0;border:1px solid #796b3f;border-radius:3px;color:#f4df9d;background:#433b22;font-size:10px;font-weight:700;line-height:15px;cursor:pointer}
.loop-controls button:hover,.loop-controls button:focus-visible{border-color:#e2c96b;background:#5a4d27;box-shadow:0 0 0 1px #e2c96b55;outline:none}
.loop-controls button:active{transform:translateY(1px);background:#6a5929}.loop-controls button:disabled{border-color:#514a36;background:#333027;opacity:.4;cursor:default}.loop-controls button[hidden]{display:none}
.loop-label{min-width:4ch;padding:0 3px;text-align:center;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
.trace-value{vertical-align:top}
`;

// AI_NOTE: 保存記録を親の選択pathごとに射影する。ボタンDOMは再生成せずfocusを保つ。
export const loopRowControlsRuntime = `
const projectTracePlayback=${projectTracePlayback.toString()};
const installLoopRowControls=({functions,afterChange})=>{
 const states=new Map();let projected=[];
 const keyFor=fn=>fn.funcName+":"+fn.startLine;
 const stateFor=fn=>{const key=keyFor(fn);let state=states.get(key);if(!state){state={selected:{},legacyIndex:0};states.set(key,state)}return state};
 const refresh=()=>{projected=functions().map(fn=>{const state=stateFor(fn);if(fn.playback){const result=projectTracePlayback(fn.playback,state.selected);result.loops.forEach(loop=>{state.selected[loop.id]=loop.iteration});return{fn,state,...result}}const index=Math.min(state.legacyIndex,Math.max(0,(fn.iterations?.length||1)-1));state.legacyIndex=index;return{fn,state,values:fn.iterations?.[index]?.values||[],loops:Number.isInteger(fn.loop?.headerLine)?[{id:fn.loop.headerLine,headerLine:fn.loop.headerLine,parent:null,iteration:index+1,total:fn.iterations?.length||0}]:[]}})};
 const noteFor=line=>{const notes=[];projected.forEach(entry=>{const text=entry.values.find(value=>value.line===line)?.text;if(text)notes.push(text);if(!entry.fn.playback){const path=entry.fn.pathEvents?.find(value=>value.line===line);if(path)notes.push("条件: "+(path.outcome?"true":"false"))}});return{text:notes.join(" · "),hit:notes.length>0}};
 const change=(key,id,delta)=>{const entry=projected.find(item=>keyFor(item.fn)===key),loop=entry?.loops.find(item=>item.id===id);if(!loop)return;const next=Math.max(1,Math.min(loop.total,loop.iteration+delta));if(next===loop.iteration)return;if(entry.fn.playback){entry.state.selected[id]=next;const descendants=new Set([id]);let added=true;while(added){added=false;entry.loops.forEach(child=>{if(child.parent!==null&&descendants.has(child.parent)&&!descendants.has(child.id)){descendants.add(child.id);entry.state.selected[child.id]=1;added=true}})}}else entry.state.legacyIndex=next-1;afterChange()};
 const render=(node,line)=>{
  const expected=[];projected.forEach(entry=>entry.loops.filter(loop=>loop.headerLine===line).forEach(loop=>expected.push({entry,loop,key:keyFor(entry.fn)})));
  node.querySelectorAll(".loop-controls").forEach(group=>{if(!expected.some(item=>item.key===group.dataset.functionKey&&String(item.loop.id)===group.dataset.loopId))group.remove()});
  let value=node.querySelector(".trace-value");if(!value){value=document.createElement("span");value.className="trace-value";node.append(value)}
  expected.forEach(({entry,loop,key})=>{
   let group=[...node.querySelectorAll(".loop-controls")].find(item=>item.dataset.functionKey===key&&item.dataset.loopId===String(loop.id));
   if(!group){group=document.createElement("span");group.className="loop-controls";group.dataset.functionKey=key;group.dataset.loopId=String(loop.id);group.setAttribute("role","group");group.setAttribute("aria-label",entry.fn.funcName+" L"+line+" の周回");const previous=document.createElement("button"),label=document.createElement("span"),next=document.createElement("button");previous.className="loop-previous";next.className="loop-next";label.className="loop-label";previous.textContent="◀";next.textContent="▶";previous.type=next.type="button";previous.setAttribute("aria-label",entry.fn.funcName+" L"+line+" の前の周回");next.setAttribute("aria-label",entry.fn.funcName+" L"+line+" の次の周回");previous.onclick=()=>{change(key,loop.id,-1);previous.focus()};next.onclick=()=>{change(key,loop.id,1);next.focus()};group.append(previous,label,next);node.insertBefore(group,value)}
   group.querySelector(".loop-label").textContent=loop.total===0?"0周":loop.iteration+"/"+loop.total;
   group.title="L"+line+" のループ："+(loop.total===0?"実行なし":loop.iteration+"周目 / "+loop.total+"周");
   const previous=group.querySelector(".loop-previous"),next=group.querySelector(".loop-next");previous.disabled=loop.iteration<=1;next.disabled=loop.iteration>=loop.total;previous.hidden=next.hidden=loop.total<=1;
  });
  const note=noteFor(line);if(value.textContent!==note.text)value.textContent=note.text;node.classList.toggle("has-value",note.hit||expected.length>0);
 };
 return{refresh,render};
};
`;
