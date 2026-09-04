// AI_NOTE: 後着名称を既存の構文tokenへ付ける。ソースDOMを作り直さず選択・scrollを維持する。
export const inlineNameLayerRuntime = `
const decorateInlineNames=(annotations,onShow)=>{
 const byLine=new Map();for(const item of annotations||[]){if(item.kind!=="symbol"||!item.symbolKey)continue;const items=byLine.get(item.startLine)||[];items.push(item);byLine.set(item.startLine,items)}
 document.querySelectorAll(".source-row").forEach(row=>{const code=row.querySelector(".code"),items=byLine.get(Number(row.dataset.line))||[];if(!code)return;const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let offset=0,node;
 while(node=walker.nextNode()){const token=node.parentElement?.closest("[data-code-token]"),start=offset;offset+=node.textContent.length;if(!token)continue;const item=items.find(item=>item.startCol===start&&(item.endCol??offset)>=offset);token.classList.toggle("symbol-anchor",Boolean(item));if(item){token.dataset.symbolKey=item.symbolKey;token.title=item.label+" — "+item.explanation;token.tabIndex=0;token.onmouseenter=()=>onShow?.(token,item,false);token.onfocus=()=>onShow?.(token,item,false);token.onclick=event=>{if(event.detail===1&&!getSelection()?.toString())onShow?.(token,item,true)}}else{delete token.dataset.symbolKey;token.removeAttribute("title");token.removeAttribute("tabindex");token.onmouseenter=token.onfocus=token.onclick=null}}
 });
};
`;
