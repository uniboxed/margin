// @ts-nocheck
// TEST BUILD ONLY (branch test/frameless-layout): the page narrowed with no iframe. See DECISIONS.md.
// (a) containing block on html, not body: fixed elements stay put while body scrolls.
(()=>{if(top!==window||window.__marginRan?.a)return;(window.__marginRan??={}).a=true; // registering again runs it again in open pages
 const G=window.__G={L:window.__marginWidth||260,T:8,R:8,B:8,on:[]},{T,R,B}=G;
 document.documentElement.setAttribute('data-margin-frameless','');
 let pad='';
 const box=()=>{const L=G.L;return `html{position:absolute!important;left:0!important;top:0!important;transform:translate(${L}px,${T}px)!important;width:calc(100vw - ${L+R}px)!important;height:calc(100vh - ${T+B}px)!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;margin:0!important;padding:0!important;overflow:hidden!important;box-sizing:border-box!important;--margin-shift-x:-${L}px;--margin-left:${L}px;--margin-dw:${L+R}px;--margin-shift-y:-${T}px;--margin-out-r:-${R}px;--margin-out-b:-${B}px}
 :modal,::backdrop{inset:${T}px ${R}px ${B}px ${L}px!important}
 body{position:relative!important;height:100%!important;min-height:0!important;max-height:none!important;width:auto!important;max-width:none!important;overflow-x:hidden!important;overflow-y:auto!important;box-sizing:border-box!important;scroll-padding:inherit!important;scroll-behavior:inherit!important;scroll-snap-type:inherit!important;overscroll-behavior:inherit!important;`};
 const css=()=>box()+`margin:0!important;${pad}}`;
 const s=window.__sheet=new CSSStyleSheet();s.replaceSync(css());
 const put=()=>{const d=Object.getOwnPropertyDescriptor(Document.prototype,'adoptedStyleSheets');document.adoptedStyleSheets=[...document.adoptedStyleSheets,s];
  Object.defineProperty(document,'adoptedStyleSheets',{configurable:true,get(){return d.get.call(this)},set(v){d.set.call(this,v.includes(s)?v:[...v,s])}})};put();
 // body's own margin becomes padding: the scroller must fill html exactly.
 const mg=()=>{const b=document.body;if(!b)return;s.disabled=true;const c=getComputedStyle(b);const v=['Top','Right','Bottom','Left'].map(k=>parseFloat(c['margin'+k])+parseFloat(c['padding'+k])+'px').join(' ');s.disabled=false;pad=`padding:${v}!important;`;s.replaceSync(css())};
 document.addEventListener('DOMContentLoaded',mg,{once:true});
 // The sidebar's width, live from Margin (content/layout.js): the box at once, the rest when it rests.
 let rest=0;const html=document.documentElement;
 new MutationObserver(()=>{const L=Number(html.getAttribute('data-margin-left'));if(!(L>0)||L===G.L)return;const was=G.L;G.L=L;s.replaceSync(css());for(const f of G.on)f(L,was);clearTimeout(rest);rest=setTimeout(()=>{for(const f of G.settled||[])f();dispatchEvent(new Event('resize'))},150)}).observe(html,{attributes:true,attributeFilter:['data-margin-left']});
})();
