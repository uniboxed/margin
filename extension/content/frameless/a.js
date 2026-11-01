// @ts-nocheck
// TEST BUILD ONLY (branch test/frameless-layout): the page narrowed with no iframe. See DECISIONS.md.
// (a) containing block on html, not body: fixed elements stay put while body scrolls.
(()=>{if(top!==window)return;
 const G=window.__G={L:260,T:8,R:8,B:8},{L,T,R,B}=G;
 document.documentElement.setAttribute('data-margin-frameless','');
 const box=`html{position:absolute!important;left:0!important;top:0!important;transform:translate(${L}px,${T}px)!important;width:calc(100vw - ${L+R}px)!important;height:calc(100vh - ${T+B}px)!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;margin:0!important;padding:0!important;overflow:hidden!important;box-sizing:border-box!important;--margin-shift-x:-${L}px;--margin-shift-y:-${T}px;--margin-out-r:-${R}px;--margin-out-b:-${B}px}
 :modal,::backdrop{inset:${T}px ${R}px ${B}px ${L}px!important}
 body{position:relative!important;height:100%!important;min-height:0!important;max-height:none!important;width:auto!important;max-width:none!important;overflow-x:hidden!important;overflow-y:auto!important;box-sizing:border-box!important;scroll-padding:inherit!important;scroll-behavior:inherit!important;scroll-snap-type:inherit!important;overscroll-behavior:inherit!important;`;
 const s=window.__sheet=new CSSStyleSheet();s.replaceSync(box+'margin:0!important}');
 const put=()=>{const d=Object.getOwnPropertyDescriptor(Document.prototype,'adoptedStyleSheets');document.adoptedStyleSheets=[...document.adoptedStyleSheets,s];
  Object.defineProperty(document,'adoptedStyleSheets',{configurable:true,get(){return d.get.call(this)},set(v){d.set.call(this,v.includes(s)?v:[...v,s])}})};put();
 // body's own margin becomes padding: the scroller must fill html exactly.
 const mg=()=>{const b=document.body;if(!b)return;s.disabled=true;const c=getComputedStyle(b);const v=['Top','Right','Bottom','Left'].map(k=>parseFloat(c['margin'+k])+parseFloat(c['padding'+k])+'px').join(' ');s.disabled=false;s.replaceSync(box+`margin:0!important;padding:${v}!important}`)};
 document.addEventListener('DOMContentLoaded',mg,{once:true});
})();
