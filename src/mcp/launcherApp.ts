// AI_NOTE: 初見利用者が4機能を覚えていなくても、対象と理解目的を自然文で指定してCodexへ依頼できる入口にする。
// 表示形式は複数選択でき、最後にまとめてCodexの通常メッセージとして送る。
export function buildLauncherAppShell(): string {
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme:light dark; --accent:#4fc1ff; --line:color-mix(in srgb,CanvasText 18%,transparent); --soft:color-mix(in srgb,CanvasText 6%,Canvas); --muted:color-mix(in srgb,CanvasText 64%,transparent); --danger:#f14c4c; }
  * { box-sizing:border-box; } body { margin:0; min-height:280px; padding:16px; color:CanvasText; background:Canvas; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .eyebrow { margin:0 0 3px; color:var(--accent); font-size:10px; font-weight:800; letter-spacing:.08em; }
  h1 { margin:0; font-size:18px; line-height:1.3; } .lead { margin:6px 0 14px; color:var(--muted); font-size:12px; line-height:1.5; }
  label { display:block; margin:10px 0 5px; font-size:11px; font-weight:700; }
  input,textarea { width:100%; border:1px solid var(--line); border-radius:8px; padding:9px 10px; color:CanvasText; background:var(--soft); font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  input { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; } textarea { min-height:72px; resize:vertical; }
  input:focus,textarea:focus { outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent); outline-offset:1px; border-color:var(--accent); }
  .actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:12px; }
  button { min-height:52px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; color:CanvasText; background:var(--soft); text-align:left; cursor:pointer; font:inherit; }
  button:hover,button:focus-visible { border-color:var(--accent); outline:2px solid color-mix(in srgb,var(--accent) 35%,transparent); outline-offset:1px; }
  button[aria-pressed="true"] { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 16%,Canvas); box-shadow:inset 0 0 0 1px var(--accent); }
  button:disabled { opacity:.48; cursor:not-allowed; } button strong,button span { display:block; } button strong { font-size:12px; } button span { margin-top:2px; color:var(--muted); font-size:10px; line-height:1.35; }
  .submit { width:100%; min-height:40px; margin-top:10px; text-align:center; color:Canvas; background:var(--accent); border-color:var(--accent); font-weight:800; }
  #status { min-height:18px; margin:9px 1px 0; color:var(--muted); font-size:11px; } #status.error { color:var(--danger); }
  .recall { margin:2px 1px 0; color:var(--muted); font-size:10px; line-height:1.4; } .recall code { color:CanvasText; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  @media(max-width:520px){body{padding:13px}.actions{grid-template-columns:1fr}}
</style></head><body>
  <p id="eyebrow" class="eyebrow">AI CODE GUIDE</p><h1 id="title">コードの何を見たいですか？</h1>
  <p id="lead" class="lead">対象と知りたいことを入力し、必要な見せ方を複数選べます。</p>
  <section id="request-form"><label for="target">対象</label><input id="target" type="text" autocomplete="off" aria-describedby="status" placeholder="ファイル、クラス、関数などを指定">
  <label for="question">知りたいこと</label><textarea id="question" aria-describedby="status" placeholder="確認したい処理や疑問を入力"></textarea>
  <div class="actions" aria-label="表示方法">
    <button data-view="標準ビュー" type="button" aria-pressed="false"><strong>標準ビュー</strong><span>定義順とコードの役割</span></button>
    <button data-view="コード図" type="button" aria-pressed="false"><strong>コード図</strong><span>処理の流れ・読解順・依存関係</span></button>
    <button data-view="実行トレース" type="button" aria-pressed="false"><strong>実行トレース</strong><span>具体例で値の変化を追跡</span></button>
    <button data-view="インライン解説" type="button" aria-pressed="false"><strong>インライン解説</strong><span>難しい記述をコード上で説明</span></button>
  </div>
  <button id="submit" class="submit" type="button" disabled>選んだ見せ方で依頼する</button>
  <p id="status" role="status">対象・知りたいこと・見せ方を指定してください。</p></section>
  <p class="recall">このカードが上へ流れた場合だけ、通常の入力欄へ <code>$ai-code-guide-request</code> と送信すると再表示できます。</p>
<script>
  const pending=new Map();let nextId=1;
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=nextId++;pending.set(id,{resolve,reject});window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*");});
  const notify=(method,params)=>window.parent.postMessage({jsonrpc:"2.0",method,params},"*");
  const target=document.getElementById("target"),question=document.getElementById("question"),status=document.getElementById("status"),submit=document.getElementById("submit"),buttons=[...document.querySelectorAll("[data-view]")];
  const setStatus=(message,error=false)=>{status.textContent=message;status.classList.toggle("error",error);};
  const selectedViews=()=>buttons.filter(button=>button.getAttribute("aria-pressed")==="true").map(button=>button.dataset.view);
  const updateState=(showHint=true)=>{const missing=[];if(!target.value.trim())missing.push("対象");if(!question.value.trim())missing.push("知りたいこと");if(!selectedViews().length)missing.push("見せ方");submit.disabled=missing.length>0;if(showHint)setStatus(missing.length?missing.join("・")+"を指定してください。":"選んだ見せ方で依頼できます。");};
  const promptFor=(views)=>[
    "AI Code Guideを使って、次の依頼をそのまま実行してください。",
    "対象: "+target.value.trim(),
    "知りたいこと: "+question.value.trim(),
    "表示方法: "+views.join("、"),
    "指定した表示方法だけを実行してください。候補一覧や確認質問は返さず、必要なコード探索を行って結果を直接示してください。"
  ].join("\\n");
  const send=async()=>{const views=selectedViews(),label=views.join("・");buttons.forEach(button=>{button.disabled=true;});submit.disabled=true;setStatus("Codexの送信確認で内容を確認し、「送信」を押してください。");try{await request("ui/message",{role:"user",content:[{type:"text",text:promptFor(views)}]});setStatus(label+"をCodexへ送信しました。");buttons.forEach(button=>{button.disabled=false;});updateState(false);}catch(error){setStatus(error?.message||"Codexへ依頼を送れませんでした。",true);buttons.forEach(button=>{button.disabled=false;});updateState(false);}};
  buttons.forEach(button=>button.addEventListener("click",()=>{button.setAttribute("aria-pressed",button.getAttribute("aria-pressed")!=="true"?"true":"false");updateState();}));
  submit.addEventListener("click",send);target.addEventListener("input",updateState);question.addEventListener("input",updateState);
  const renderLauncher=()=>{target.value="";question.value="";buttons.forEach(button=>{button.disabled=false;button.setAttribute("aria-pressed","false");});updateState();target.focus();};
  window.addEventListener("message",event=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.id!==undefined&&pending.has(message.id)){const entry=pending.get(message.id);pending.delete(message.id);message.error?entry.reject(new Error(message.error.message||"依頼が拒否されました。")):entry.resolve(message.result);return;}if(message.method==="ui/notifications/tool-result")renderLauncher(message.params);},{passive:true});
  request("ui/initialize",{appInfo:{name:"ai-code-guide-launcher",version:"0.8.0"},appCapabilities:{},protocolVersion:"2026-01-26"}).then(()=>notify("ui/notifications/initialized",{})).catch(()=>setStatus("入力カードを初期化できませんでした。",true));
</script></body></html>`;
}
