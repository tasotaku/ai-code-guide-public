// AI_NOTE: 一時的な生成状態は本文の外へ重ねる。保存済み画面には場所を取らず、単独ビューの更新操作は変更しない。
export const generationNoticeCss = `
.generation-notice{position:fixed;z-index:90;right:12px;bottom:12px;width:320px;max-height:calc(100vh - 70px);overflow:auto;padding:12px;border:1px solid #505050;border-radius:8px;background:#252526;box-shadow:0 4px 18px #0006;font-size:12px;line-height:1.5}
.generation-notice[hidden],.generation-chip[hidden],.generation-notice [hidden]{display:none}
.generation-notice-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.generation-notice-title{font-weight:600}.generation-notice-actions{display:flex;gap:6px}.generation-notice button{padding:3px 7px;font-size:11px;white-space:nowrap}
.generation-items{display:grid;gap:6px;margin-top:9px}.generation-item{display:flex;align-items:center;gap:8px;min-width:0}.generation-item-label{flex:1;min-width:0;overflow-wrap:anywhere}.generation-item[data-status="error"]{color:#f48771}.generation-item[data-status="generating"]{color:var(--focus)}.generation-item[data-status="ready"]{color:#4ec9b0}
.generation-message{margin:7px 0 0;color:var(--muted);overflow-wrap:anywhere}.generation-message:empty{display:none}.generation-chip{flex:none;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--focus)}
`;

// AI_NOTE: /stateは読取のみ。生成失敗の再試行と通信の再接続を分離し、同じsnapshotの後着結果だけを受け入れる。
export const generationNoticeRuntime = `
const installGenerationNotice=({initial,onState})=>{
 let state=initial,timer=null,hideTimer=null,busy=false,disposed=false,connectionFailed=false,seenRunning=false,finished=false,collapsed=false,dismissed="",lastFailure="",actionError="";
 const names={background:"背景",inline:"名称解説",diagram:"コード図",trace:"実行トレース"};
 const pending=()=>Object.values(state.layers||{}).some(layer=>layer&&["queued","generating"].includes(layer.status));
 const make=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text)node.textContent=text;return node};
 const button=(id,text)=>{const node=make("button","header-button",text);node.id=id;node.type="button";return node};
 const panel=make("section","generation-notice"),head=make("div","generation-notice-head"),title=make("span","generation-notice-title"),actions=make("div","generation-notice-actions"),items=make("div","generation-items"),message=make("p","generation-message"),rows=new Map();
 panel.id="generation-notice";panel.hidden=true;panel.setAttribute("aria-label","生成状況");
 title.setAttribute("role","status");title.setAttribute("aria-live","polite");
 const fold=button("generation-fold","畳む"),close=button("generation-close","閉じる"),reconnect=button("generation-reconnect","再接続"),chip=button("generation-chip","生成中");chip.classList.add("generation-chip");chip.hidden=true;
 actions.append(fold,close);head.append(title,actions);panel.append(head,items,message,reconnect);document.body.append(panel);document.getElementById("toggle-sidebar").before(chip);
 const failures=()=>Object.entries(state.layers||{}).filter(([,layer])=>layer?.status==="error");
 const signature=()=>JSON.stringify([connectionFailed,state.sourceChanged,failures().map(([key,layer])=>[key,layer.message])]);
 const hide=()=>{panel.hidden=true;chip.hidden=true};
 const place=()=>{
  const sidebar=document.getElementById("sidebar"),rect=sidebar.getBoundingClientRect(),available=getComputedStyle(sidebar).display!=="none"&&rect.width>=200;
  const active=!finished&&(pending()||seenRunning||failures().length||connectionFailed||state.sourceChanged)&&dismissed!==signature();
  panel.hidden=!active||collapsed||!available;chip.hidden=!active||(!collapsed&&available);
  if(available){panel.style.width=Math.max(160,Math.min(340,rect.width-24))+"px";panel.style.right=Math.max(12,innerWidth-rect.right+12)+"px";panel.style.maxHeight=Math.max(100,rect.height-24)+"px"}
 };
 const render=()=>{
  const running=pending(),errors=failures(),key=signature();
  if(running){seenRunning=true;finished=false;if(hideTimer!==null)clearTimeout(hideTimer);hideTimer=null}
  if(errors.length||connectionFailed||state.sourceChanged){finished=false;if(hideTimer!==null)clearTimeout(hideTimer);hideTimer=null;if(key!==lastFailure){collapsed=false;dismissed=""}lastFailure=key}
  const complete=Object.values(state.layers||{}).length>0&&Object.values(state.layers).every(layer=>layer?.status==="ready");
  title.textContent=state.sourceChanged?"コードが変更されています":connectionFailed?"接続が切れました":errors.length?"一部の生成に失敗":running?"生成中":complete?"生成が完了しました":"生成を終了しました";
  chip.textContent=connectionFailed?"接続エラー":errors.length?"生成失敗":running?"生成中":complete?"生成完了":"生成状況";chip.title=title.textContent;
  message.textContent=state.sourceChanged?"この画面は以前のコードです。最新コードの表示を改めて依頼してください。":connectionFailed?"保存済みの結果は引き続き読めます。接続を確認して再接続してください。":actionError;
  reconnect.hidden=!connectionFailed;fold.hidden=!running;close.hidden=running&&!errors.length&&!connectionFailed;
  items.hidden=complete&&!connectionFailed;
  const statuses={queued:"待機中",generating:"生成中",ready:"完了",idle:"未生成",stale:"状態未確認",stopped:"停止",error:"失敗"};
  for(const [key,layer] of Object.entries(state.layers||{})){
   if(!layer)continue;let row=rows.get(key);
   if(!row){const node=make("div","generation-item"),label=make("span","generation-item-label"),retry=button("generation-retry-"+key,"再試行");retry.setAttribute("aria-label",(names[key]||key)+"を再試行");retry.onclick=()=>retryLayer(key,retry);node.append(label,retry);items.append(node);row={node,label,retry};rows.set(key,row)}
   row.node.dataset.status=layer.status;row.label.textContent=(names[key]||key)+"："+(statuses[layer.status]||layer.status)+(layer.status==="generating"&&layer.total>1?" "+layer.completed+"/"+layer.total:"");row.label.title=layer.message||"";row.retry.hidden=layer.status!=="error"||layer.retryable===false||!!state.sourceChanged||connectionFailed;
  }
  for(const [key,row]of rows)if(!state.layers?.[key]){row.node.remove();rows.delete(key)}
  if(!running&&!errors.length&&!connectionFailed&&!state.sourceChanged&&seenRunning&&!finished&&hideTimer===null){hideTimer=setTimeout(()=>{finished=true;hide()},3000)}
  place();
 };
 const schedule=()=>{if(timer!==null)clearTimeout(timer);timer=null;if(!disposed&&!document.hidden&&!connectionFailed&&pending()&&!state.sourceChanged)timer=setTimeout(poll,500)};
 const accept=next=>{if(state.sourceSha256&&next.sourceSha256&&state.sourceSha256!==next.sourceSha256){state={...state,sourceChanged:true}}else{state={...state,...next};onState(next)}render()};
 const poll=async()=>{if(busy||disposed||document.hidden)return;busy=true;try{const response=await fetch("/view/"+viewId+"/state");if(!response.ok)throw new Error("接続先を確認してください");connectionFailed=false;accept(await response.json())}catch{connectionFailed=true;render()}finally{busy=false;schedule()}};
 const retryLayer=async(key,control)=>{if(control.disabled)return;control.disabled=true;document.getElementById("source").focus({preventScroll:true});actionError="";try{const response=await fetch("/view/"+viewId+"/retry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({layer:key})});if(!response.ok)throw new Error(response.status===409?"コードや生成状態が変わりました。最新の表示を改めて依頼してください。":"再試行できませんでした。接続または生成設定を確認してください。");dismissed="";finished=false;accept(await response.json());schedule()}catch(error){actionError=error.message;render()}finally{control.disabled=false}};
 fold.onclick=()=>{collapsed=true;place();document.getElementById("source").focus({preventScroll:true})};close.onclick=()=>{dismissed=signature();hide()};
 chip.onclick=()=>{if(document.getElementById("workspace").classList.contains("sidebar-hidden"))document.getElementById("toggle-sidebar").click();collapsed=false;place();document.getElementById("source").focus({preventScroll:true})};reconnect.onclick=()=>{document.getElementById("source").focus({preventScroll:true});connectionFailed=false;return poll()};
 const observer=new MutationObserver(place);observer.observe(document.getElementById("workspace"),{attributes:true,attributeFilter:["class"]});window.addEventListener("resize",place);
 document.addEventListener("visibilitychange",()=>{if(document.hidden){if(timer!==null)clearTimeout(timer);timer=null}else if(pending()&&!connectionFailed)poll()});
 window.addEventListener("pagehide",()=>{disposed=true;clearTimeout(timer);clearTimeout(hideTimer);observer.disconnect();window.removeEventListener("resize",place)});
 render();schedule();return{accept};
};
`;
