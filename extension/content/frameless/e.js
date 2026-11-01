// @ts-nocheck
// (e) client coordinates: the page's origin is its box, not the window, so rect-placed menus land.
(()=>{if(top!==window)return;
 const X=260,Y=8,html=document.documentElement,P=Element.prototype,R=Range.prototype,D=Document.prototype;
 const gd=(o,p)=>{for(let x=o;x;x=Object.getPrototypeOf(x)){const d=Object.getOwnPropertyDescriptor(x,p);if(d)return d}};
 const r=(b)=>new DOMRect(b.x-X,b.y-Y,b.width,b.height),l=L=>{const a=Array.from(L,r);a.item=i=>a[i]??null;return a};
 const n={gb:P.getBoundingClientRect,gc:P.getClientRects,rb:R.getBoundingClientRect,rc:R.getClientRects,ef:D.elementFromPoint,es:D.elementsFromPoint,cr:D.caretRangeFromPoint};
 const st=gd(P,'scrollTop').get,sh=gd(P,'scrollHeight').get,sw=gd(P,'scrollWidth').get;
 P.getBoundingClientRect=function(){if(this===html||this===document.body){const b=document.body;return new DOMRect(0,-st.call(b),sw.call(b),sh.call(b))}return r(n.gb.call(this))};
 P.getClientRects=function(){return l(n.gc.call(this))};R.getBoundingClientRect=function(){return r(n.rb.call(this))};R.getClientRects=function(){return l(n.rc.call(this))};
 D.elementFromPoint=function(x,y){return n.ef.call(this,x+X,y+Y)};D.elementsFromPoint=function(x,y){return n.es.call(this,x+X,y+Y)};if(n.cr)D.caretRangeFromPoint=function(x,y){return n.cr.call(this,x+X,y+Y)};
 const M=MouseEvent.prototype,cx=gd(M,'clientX').get,cy=gd(M,'clientY').get,def=(p,g)=>Object.defineProperty(M,p,{configurable:true,enumerable:true,get:g});
 const b=()=>document.body||html,sl=gd(P,'scrollLeft').get;
 def('clientX',function(){return cx.call(this)-(this.isTrusted?X:0)});def('clientY',function(){return cy.call(this)-(this.isTrusted?Y:0)});def('x',function(){return this.clientX});def('y',function(){return this.clientY});
 def('pageX',function(){return this.clientX+sl.call(b())});def('pageY',function(){return this.clientY+st.call(b())});
 const css=new CSSStyleSheet();css.replaceSync(`:popover-open{translate:${X}px ${Y}px!important}`);document.adoptedStyleSheets=[...document.adoptedStyleSheets,css];
})();
