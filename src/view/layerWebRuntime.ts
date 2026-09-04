// AI_NOTE: コードのスクロール領域とは別の固定行に置き、完了時も高さを保って読書位置を動かさない。
export const layerProgressCss = `
.layer-progress{flex:none;display:flex;align-items:center;gap:12px;min-height:44px;padding:7px 13px;border-bottom:1px solid var(--border);background:#202020;font-size:12px}
.layer-progress-label{display:flex;flex:1;min-width:0;align-items:center;gap:12px;flex-wrap:wrap}
.layer-progress-summary{flex:none;font-weight:600;color:var(--text);white-space:nowrap}
.layer-progress-items{display:flex;gap:6px 14px;flex-wrap:wrap;color:var(--muted)}
.layer-progress-item{white-space:nowrap}.layer-progress-item[data-status="generating"]{color:var(--focus)}
.layer-progress-item[data-status="error"],.layer-progress[data-status="error"] .layer-progress-summary{color:#f48771}
.layer-progress[data-status="ready"] .layer-progress-summary{color:#4ec9b0}
.layer-progress-actions{display:flex;flex:none;gap:6px}.layer-progress button{white-space:nowrap}
.layer-progress [hidden]{display:none}.layer-progress[data-status="generating"] .layer-progress-summary::before{content:"";display:inline-block;width:10px;height:10px;margin-right:7px;border:2px solid #555;border-top-color:var(--focus);border-radius:50%;animation:layer-spin 1s linear infinite}
@keyframes layer-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.layer-progress[data-status="generating"] .layer-progress-summary::before{animation:none}}
`;

// AI_NOTE: 後着する解説だけを更新し、非表示中と終端状態ではpollを止める。旧URLのコードは差し替えない。
export const layerWebRuntime = `
const installLayerUpdates=({initial,onState,progressBar=false})=>{
 let state=initial,timer=null,busy=false,disposed=false,pollFailed=false;
 const panel=document.createElement("div");panel.className=progressBar?"layer-controls layer-progress":"layer-controls";
 if(!progressBar)panel.style.cssText="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px";
 const label=document.createElement("span"),update=document.createElement("button"),stop=document.createElement("button");
 const summary=document.createElement("span"),items=document.createElement("span"),actions=document.createElement("span"),chips=new Map();
 label.setAttribute("role","status");label.setAttribute("aria-live","polite");label.setAttribute("aria-atomic","true");
 update.type=stop.type="button";update.className=stop.className="tbtn header-button";update.textContent="解説を更新";stop.textContent="生成を停止";
 if(progressBar){label.className="layer-progress-label";summary.className="layer-progress-summary";items.className="layer-progress-items";actions.className="layer-progress-actions";label.append(summary,items);actions.append(update,stop);panel.append(label,actions);document.querySelector(".header")?.after(panel)}else{panel.append(label,update,stop);document.querySelector(".header")?.append(panel)}
 const pending=()=>Object.values(state.layers||{}).some(layer=>layer&&["queued","generating"].includes(layer.status));
 const describe=layer=>{if(!layer)return"";const names={idle:"未生成",queued:"生成待ち",generating:"生成中",ready:"準備済み",stale:"保存後に更新",stopped:"停止中",error:"生成失敗"};return(names[layer.status]||layer.status)+(layer.total?" "+layer.completed+"/"+layer.total:"")+(layer.message?" — "+layer.message:"")};
 // AI_NOTE: 成功数だけを数える。失敗・停止・未生成・古いコードを全件成功としてまとめない。
 const render=()=>{
  const entries=Object.entries(state.layers||{}).filter(([,layer])=>layer);
  if(progressBar){
   const complete=entries.length>0&&entries.every(([,layer])=>layer.status==="ready"),failed=entries.some(([,layer])=>layer.status==="error"),done=entries.filter(([,layer])=>layer.status==="ready").length;
   const text=state.sourceChanged?"コード変更あり · 旧コードを表示中":pollFailed?"進捗の取得に失敗":complete?"すべて完了":failed?(pending()?"生成中 · 一部失敗":"一部生成失敗"):pending()?"生成中 · "+done+"/"+entries.length+" 完了":entries.some(([,layer])=>layer.status==="stopped")?"生成停止":entries.some(([,layer])=>layer.status==="stale")?"更新待ち":"未生成";
   if(summary.textContent!==text)summary.textContent=text;
   panel.dataset.status=state.sourceChanged?"stale":pollFailed||failed?"error":complete?"ready":pending()?"generating":"idle";
   items.hidden=complete&&!state.sourceChanged&&!pollFailed;
   const names={background:"背景",inline:"名称解説",diagram:"コード図",trace:"実行トレース"},statuses={idle:"未生成",queued:"生成待ち",generating:"生成中",ready:"完了",stale:"更新待ち",stopped:"停止",error:"生成失敗"};
   for(const [name,layer]of entries){let chip=chips.get(name);if(!chip){chip=document.createElement("span");chip.className="layer-progress-item";chips.set(name,chip);items.append(chip)}const count=layer.status==="generating"&&layer.total>1?" "+layer.completed+"/"+layer.total:"";const value=(names[name]||name)+"："+(statuses[layer.status]||layer.status)+count;if(chip.textContent!==value)chip.textContent=value;chip.dataset.status=layer.status;chip.title=layer.message||""}
   for(const [name,chip]of chips)if(!entries.some(([key])=>key===name)){chip.remove();chips.delete(name)}
  }else label.textContent=state.sourceChanged?"コードが変更されています。旧コードを表示中です。":entries.map(([name,layer])=>({background:"背景",inline:"インライン解説",diagram:"コード図",trace:"実行トレース"}[name]||name)+": "+describe(layer)).join(" · ");
  stop.hidden=!pending()||state.sourceChanged;update.textContent=state.sourceChanged?"最新表示を開く":"解説を更新";
 };
 const schedule=()=>{if(timer!==null)clearTimeout(timer);timer=null;if(!disposed&&!pollFailed&&!document.hidden&&pending()&&!state.sourceChanged)timer=setTimeout(poll,750)};
 const accept=next=>{if(state.sourceSha256&&next.sourceSha256&&state.sourceSha256!==next.sourceSha256){state={...state,sourceChanged:true};render();return}state={...state,...next};onState(next);render()};
 const poll=async()=>{if(busy||document.hidden||disposed)return;busy=true;try{const response=await fetch("/view/"+viewId+"/state");if(!response.ok)throw new Error(await response.text());accept(await response.json())}catch(error){pollFailed=true;if(progressBar){render();summary.title=error?.message||"状態を取得できませんでした。"}else label.textContent=error?.message||"状態を取得できませんでした。"}finally{busy=false;schedule()}};
 const action=async value=>{update.disabled=stop.disabled=true;try{const response=await fetch("/view/"+viewId+"/layers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:value})});if(!response.ok)throw new Error(await response.text());const next=await response.json();if(next.codexView?.url){location.assign(next.codexView.url);return}pollFailed=false;summary.title="";accept(next);schedule()}catch(error){if(progressBar){summary.textContent="解説の操作に失敗";summary.title=error?.message||"解説を更新できませんでした。";panel.dataset.status="error"}else label.textContent=error?.message||"解説を更新できませんでした。"}finally{update.disabled=stop.disabled=false}};
 update.onclick=()=>action("generate");stop.onclick=()=>action("stop");
 document.addEventListener("visibilitychange",()=>{if(document.hidden){if(timer!==null)clearTimeout(timer);timer=null}else if(pending())poll()});window.addEventListener("pagehide",()=>{disposed=true;if(timer!==null)clearTimeout(timer)});render();schedule();return{accept};
};
`;
