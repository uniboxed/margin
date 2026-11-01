// @ts-nocheck
// (c) page-world shim: window.scrollY/scrollTo/innerWidth/matchMedia and friends speak for body.
(()=>{if(top!==window||!window.__G||window.__marginRan.c)return;window.__marginRan.c=true;
 const G=window.__G,dh=G.T+G.B,html=document.documentElement,body=()=>document.body||html;let dw=G.L+G.R;G.on.push(()=>{dw=G.L+G.R});
 const gd=(o,p)=>{for(let x=o;x;x=Object.getPrototypeOf(x)){const d=Object.getOwnPropertyDescriptor(x,p);if(d)return d}};
 const def=(o,p,d)=>Object.defineProperty(o,p,{configurable:true,enumerable:true,...d});
 const ep=Element.prototype,N={};for(const p of ['scrollTop','scrollLeft','scrollHeight','scrollWidth','clientWidth','clientHeight'])N[p]=gd(ep,p);
 const nw=gd(window,'innerWidth'),nh=gd(window,'innerHeight');
 def(window,'innerWidth',{get:()=>nw.get.call(window)-dw,set(){}});def(window,'innerHeight',{get:()=>nh.get.call(window)-dh,set(){}});
 const vp=window.visualViewport;if(vp){const w=gd(vp,'width'),h=gd(vp,'height');def(VisualViewport.prototype,'width',{get(){return w.get.call(this)-dw/this.scale}});def(VisualViewport.prototype,'height',{get(){return h.get.call(this)-dh/this.scale}})}
 for(const p of ['scrollY','pageYOffset'])def(window,p,{get:()=>N.scrollTop.get.call(body()),set(){}});
 for(const p of ['scrollX','pageXOffset'])def(window,p,{get:()=>N.scrollLeft.get.call(body()),set(){}});
 for(const p of ['scrollTop','scrollLeft','scrollHeight','scrollWidth'])def(ep,p,{get(){return N[p].get.call(this===html?body():this)},set(v){N[p].set&&N[p].set.call(this===html?body():this,v)}});
 def(ep,'clientWidth',{get(){return this===html?nw.get.call(window)-dw:N.clientWidth.get.call(this)}});
 def(ep,'clientHeight',{get(){return this===html?nh.get.call(window)-dh:N.clientHeight.get.call(this)}});
 def(Document.prototype,'scrollingElement',{get(){return body()}});
 for(const m of ['scrollTo','scrollBy','scroll']){const f=ep[m];window[m]=function(...a){return f.apply(body(),a)};ep[m]=function(...a){return f.apply(this===html?body():this,a)}}
 // Window sizes in queries: a query about the page's width asks about the window's.
 const fmt=n=>String(Math.round(n*1e3)/1e3),px=(n,u)=>u==='px'?+n:n*16;
 const mq=window.__mq=(t,w=dw,h=dh)=>t&&t.replace(/\(\s*(min|max)-(width|height)\s*:\s*(-?[\d.]+)(px|em|rem)\s*\)/gi,(m,k,d,n,u)=>`(${k}-${d}: ${fmt(px(n,u.toLowerCase())+(d.toLowerCase()==='width'?w:h))}px)`).replace(/(-?[\d.]+)(px|em|rem)(\s*[<>]=?\s*)(width|height)\b/gi,(m,n,u,o,d)=>fmt(px(n,u.toLowerCase())+(d.toLowerCase()==='width'?w:h))+'px'+o+d).replace(/\b(width|height)(\s*[<>]=?\s*)(-?[\d.]+)(px|em|rem)/gi,(m,d,o,n,u)=>d+o+fmt(px(n,u.toLowerCase())+(d.toLowerCase()==='width'?w:h))+'px');
 const nm=window.matchMedia;window.matchMedia=function(q){return nm.call(window,mq(String(q)))};
 // scroll on body is seen on document and window.
 addEventListener('scroll',e=>{if(e.target===document.body&&e.isTrusted)document.dispatchEvent(new Event('scroll',{bubbles:true}))},true);
 // IntersectionObserver: body clips before the viewport, so rootMargin needs body as root.
 const NIO=window.IntersectionObserver;if(NIO){const IO=function IntersectionObserver(cb,o){const p=Object.assign({},o||{});if(p.root==null&&document.body)p.root=document.body;return new NIO(cb,p)};IO.prototype=NIO.prototype;window.IntersectionObserver=IO}
 // Back: a nested scroller isn't in the history item.
 const key=()=>'__sr:'+location.pathname+location.search;
 addEventListener('pagehide',()=>{try{sessionStorage.setItem(key(),N.scrollTop.get.call(body()))}catch{}});
 const nav=()=>{try{return performance.getEntriesByType('navigation')[0]?.type}catch{}};
 addEventListener('load',()=>{if(nav()!=='back_forward'&&nav()!=='reload')return;let y;try{y=+sessionStorage.getItem(key())}catch{}if(y){let n=0;const t=()=>{N.scrollTop.set.call(body(),y);if(++n<10&&N.scrollTop.get.call(body())<y-1)setTimeout(t,100)};t()}});
 // Keyboard paging: nothing is focused, so WebKit tries the (unscrollable) root.
 addEventListener('keydown',e=>{if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey)return;const a=document.activeElement;if(a&&a!==document.body&&a!==html)return;const h=N.clientHeight.get.call(body()),d={' ':e.shiftKey?-h*.9:h*.9,PageDown:h*.9,PageUp:-h*.9,ArrowDown:40,ArrowUp:-40,Home:-1e9,End:1e9}[e.key];if(d==null)return;e.preventDefault();ep.scrollBy.call(body(),0,d)});
})();
