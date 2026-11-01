// @ts-nocheck
// (d) stylesheet rewrite: @media width/height shifted, vw/vh rewritten, readable and CORS-cloneable sheets.
(()=>{if(top!==window||!window.__G||window.__marginRan.d)return;window.__marginRan.d=true;
 const dh=16,st=window.__d={sheets:0,unread:0,cors:0,corsFail:0,media:0,vw:0,ms:0,passes:0};
 const mq=window.__mq||(t=>t),fmt=n=>String(Math.round(n*1e3)/1e3);
 const num='(-?(?:\\d+\\.?\\d*|\\.\\d+))',RE=new RegExp(num+'(s|l|d)?(vw|vh|vmin|vmax)\\b','g');
 const uv=v=>v&&/v(w|h|min|max)\b/.test(v)&&!v.includes('/*m*/')?v.replace(RE,(m,n,sl,u)=>{sl=sl||'';const W=`calc(${n}${sl}vw - ${fmt(n/100)} * var(--margin-dw))`,H=`calc(${n}${sl}vh - ${fmt(n*dh/100)}px)`;return u==='vw'?W:u==='vh'?H:u==='vmin'?`min(${W}, ${H})`:`max(${W}, ${H})`}):v;
 const text=c=>uv(c.replace(/@media([^{]+)\{/g,(m,q)=>'@media'+mq(q)+'{'));
 const seen=new WeakSet(),all=new Set();
 // Media queries take no variables: moved when the width rests, by the difference.
 let from=window.__G.L;
 const moveAll=(d)=>{const go=rs=>{for(const r of Array.from(rs))try{if(r instanceof CSSMediaRule){const t=r.media.mediaText,n=mq(t,d,0);if(n!==t)r.media.mediaText=n}if(r.cssRules&&r.cssRules.length)go(r.cssRules)}catch{}};for(const x of all)try{const t=x.media.mediaText,n=mq(t,d,0);if(n!==t)x.media.mediaText=n;go(x.cssRules)}catch{}};
 (window.__G.settled=window.__G.settled||[]).push(()=>{const d=window.__G.L-from;from=window.__G.L;if(d)moveAll(d)});
 const walk=rs=>{for(const r of Array.from(rs))try{
  if(r instanceof CSSMediaRule){const t=r.media.mediaText,n=mq(t);if(n!==t){r.media.mediaText=n;st.media++}}
  if(r.style&&/v(w|h|min|max)\b/.test(r.style.cssText)){const s=r.style;for(let i=0;i<s.length;i++){const p=s[i],v=s.getPropertyValue(p),n=uv(v);if(n!==v){s.setProperty(p,n,s.getPropertyPriority(p));st.vw++}}}
  if(r.cssRules&&r.cssRules.length)walk(r.cssRules);if(r.styleSheet)proc(r.styleSheet)}catch{}};
 const proc=s=>{if(!s||seen.has(s))return;let rs;try{rs=s.cssRules}catch{rs=null}
  if(!rs){st.unread++;clone(s);return}seen.add(s);all.add(s);st.sheets++;try{const t=s.media.mediaText,n=mq(t);if(n!==t)s.media.mediaText=n}catch{}walk(rs)};
 const cl=new WeakSet();
 const clone=s=>{const l=s.ownerNode;if(!l||l.localName!=='link'||cl.has(l)||l.crossOrigin)return;cl.add(l);const c=document.createElement('link');for(const a of l.attributes)if(!/^(id|on)/i.test(a.name))c.setAttribute(a.name,a.value);c.crossOrigin='anonymous';
  c.addEventListener('load',()=>{try{c.sheet.cssRules;proc(c.sheet);l.disabled=true;st.cors++}catch{st.corsFail++;c.remove()}});c.addEventListener('error',()=>{st.corsFail++;c.remove()});l.after(c)};
 const pass=()=>{const t=performance.now();st.passes++;for(const s of Array.from(document.styleSheets))proc(s);for(const s of document.adoptedStyleSheets)if(s!==window.__sheet)proc(s);st.ms+=performance.now()-t};
 const P=CSSStyleSheet.prototype,ir=P.insertRule,rp=P.replace,rs=P.replaceSync;
 P.insertRule=function(t,i){proc(this);return ir.call(this,typeof t==='string'?text(t):t,i)};
 P.replaceSync=function(t){if(this===window.__sheet)return rs.call(this,t);seen.add(this);all.add(this);return rs.call(this,text(String(t)))};
 P.replace=function(t){seen.add(this);all.add(this);return rp.call(this,text(String(t)))};
 let q;new MutationObserver(()=>{if(q)return;q=requestAnimationFrame(()=>{q=0;pass()})}).observe(document,{childList:true,subtree:true});
 document.addEventListener('DOMContentLoaded',pass);addEventListener('load',pass);
})();
