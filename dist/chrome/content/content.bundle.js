(()=>{var __defProp=Object.defineProperty;var __export=(target,all)=>{for(var name in all)__defProp(target,name,{get:all[name],enumerable:!0})};var view_exports={};__export(view_exports,{WIDTH:()=>WIDTH,activeSpaceId:()=>activeSpaceId,clampWidth:()=>clampWidth,cycleSpace:()=>cycleSpace,cycleTab:()=>cycleTab,guessWindow:()=>guessWindow,iconFor:()=>iconFor,normalizeUrl:()=>normalizeUrl,originOf:()=>originOf,pickIconHref:()=>pickIconHref,revealZone:()=>revealZone,sidebar:()=>sidebar,sidebarWidth:()=>sidebarWidth,snapWidth:()=>snapWidth});function normalizeUrl(url){try{let u=new URL(url),path=u.pathname==="/"?"":u.pathname;return`${u.protocol}//${u.host}${path}${u.search}`}catch{return url??""}}function activeSpaceId(state,windowId){let id=state.activeSpaceByWindow?.[windowId];return state.spaces.some(s=>s.id===id)?id:state.spaces[0].id}function sidebar(state,windowId,currentTabId=null){let spaceId=activeSpaceId(state,windowId),known=currentTabId!=null&&state.tabs?.[currentTabId]?.windowId===windowId,spaceTabs=Object.values(state.tabs??{}).filter(t=>t.windowId===windowId).map(t=>known&&t.active!==(t.id===currentTabId)?{...t,active:t.id===currentTabId}:t).sort((a,b)=>a.index-b.index).filter(t=>state.tabSpace[t.id]===spaceId),pins=state.pins.filter(p=>p.spaceId===spaceId).map(p=>{let key=normalizeUrl(p.url),tab=spaceTabs.find(t=>normalizeUrl(t.url)===key);return{...p,tabId:tab?.id??null,active:!!tab?.active,favIconUrl:tab?.favIconUrl??""}}),pinnedUrls=new Set(pins.map(p=>normalizeUrl(p.url)));return{spaceId,spaces:state.spaces,pins,tabs:spaceTabs.filter(t=>!pinnedUrls.has(normalizeUrl(t.url)))}}function guessWindow(state,url){let tabs=Object.values(state.tabs??{});if(new Set(tabs.map(t=>t.windowId)).size<=1)return tabs[0]?.windowId??null;let byUrl=tabs.filter(t=>t.url===url),pool=byUrl.length?byUrl:tabs.filter(t=>t.active);return pool.sort((a,b)=>Number(b.active)-Number(a.active)||(b.lastActive??0)-(a.lastActive??0)),pool[0]?.windowId??null}var EDGE_PX=10,FULLSCREEN_EDGE_PX=24;function revealZone({outerWidth:outerWidth2,outerHeight:outerHeight2,screenWidth,screenHeight}){return outerWidth2>=screenWidth&&outerHeight2>=screenHeight?FULLSCREEN_EDGE_PX:EDGE_PX}function cycleTab(state,windowId,currentTabId,dir){let v=sidebar(state,windowId,currentTabId),order=[...v.pins.filter(p=>p.tabId!=null).map(p=>p.tabId),...v.tabs.map(t=>t.id)];if(!order.length)return null;let at=order.indexOf(currentTabId);if(at<0)return dir>0?order[0]:order[order.length-1];let next=order[(at+dir+order.length)%order.length];return next===currentTabId?null:next}function cycleSpace(state,windowId,dir){if(state.spaces.length<2)return null;let at=state.spaces.findIndex(s=>s.id===activeSpaceId(state,windowId));return state.spaces[(at+dir+state.spaces.length)%state.spaces.length].id}function originOf(url){try{let u=new URL(url);return/^https?:$/.test(u.protocol)?u.origin:null}catch{return null}}function pickIconHref(links,pageUrl){let origin=originOf(pageUrl);if(!origin)return null;let usable=href=>/^https?:/i.test(href??"")||/^data:image\//i.test(href??""),score=l=>{let rel=(l.rel??"").toLowerCase().split(/\s+/);if(!rel.some(r=>r==="icon"||r==="apple-touch-icon"||r==="apple-touch-icon-precomposed")||!usable(l.href))return-1;if(!rel.includes("icon"))return 1;let sizes=(l.sizes??"").toLowerCase();if((l.type??"").includes("svg")||sizes==="any")return 5;let px=Math.max(0,...[...sizes.matchAll(/(\d+)x\d+/g)].map(m=>Number(m[1])));return px>=16&&px<=64?4:px?2:3},best=links.map(l=>({l,s:score(l)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s)[0];return best?best.l.href:`${origin}/favicon.ico`}function iconFor(state,item){if(/^(https?|data):/.test(item?.favIconUrl??""))return item.favIconUrl;let origin=originOf(item?.url);return origin&&state?.favicons?.[origin]?.data||""}var WIDTH={min:160,max:500,default:260,step:10},clampWidth=w=>Math.min(WIDTH.max,Math.max(WIDTH.min,Number.isFinite(w)?w:WIDTH.default)),snapWidth=w=>clampWidth(Math.round(clampWidth(w)/WIDTH.step)*WIDTH.step),sidebarWidth=state=>snapWidth(Number(state?.settings?.sidebarWidth??WIDTH.default));var AXES={x:{size:"Width",pos:"scrollLeft",overflow:"overflowX"},y:{size:"Height",pos:"scrollTop",overflow:"overflowY"}};function canScroll(node,axis,delta,scrollingElement){let a=AXES[axis],max=node[`scroll${a.size}`]-node[`client${a.size}`];if(max<=1||!delta)return!1;let style=getComputedStyle(node),overflow=style[a.overflow];if(node===scrollingElement?overflow==="hidden"||overflow==="clip":overflow!=="auto"&&overflow!=="scroll")return!1;let[lo,hi]=axis==="x"&&style.direction==="rtl"?[-max,0]:[0,max];return delta<0?node[a.pos]>lo+.5:node[a.pos]<hi-.5}function somethingScrolls(event,axis,{doc,stopAt=null}={}){let delta=axis==="x"?event.deltaX:event.deltaY,scrollingElement=doc?doc.scrollingElement??doc.documentElement:null;for(let node of event.composedPath()){if(node.nodeType===1&&canScroll(node,axis,delta,scrollingElement))return!0;if(node===stopAt)return!1}return!!scrollingElement&&canScroll(scrollingElement,axis,delta,scrollingElement)}function containScroll(el2){el2.addEventListener("wheel",event=>{if(!event.cancelable||event.ctrlKey)return;let axis=Math.abs(event.deltaX)>Math.abs(event.deltaY)?"x":"y";somethingScrolls(event,axis,{stopAt:el2})||event.preventDefault()},{passive:!1})}function atPageTop(event,doc){let scrollingElement=doc.scrollingElement??doc.documentElement;if(scrollingElement.scrollTop>0)return!1;for(let node of event.composedPath()){if(node.nodeType!==1||node===scrollingElement||node===doc.body)continue;let overflow=getComputedStyle(node).overflowY;if((overflow==="auto"||overflow==="scroll")&&node.scrollHeight-node.clientHeight>1)return!1}return!0}var NO_BOUNCE_CSS=":root { overscroll-behavior-y: none !important; }",ZOOM_LEVELS=[.5,.75,.85,1,1.15,1.25,1.5,1.75,2,2.5,3];function zoomForPinch(start,scale){let target=start*scale,floor=Math.min(start,1)-1e-9;return ZOOM_LEVELS.filter(z=>z>=floor).reduce((best,z)=>Math.abs(Math.log(z/target))<Math.abs(Math.log(best/target))?z:best)}function installGestureGuard({getSettings,onPinch=()=>{},win=globalThis.window}){if(!win)return{update(){}};let doc=win.document,enabled=()=>getSettings()?.blockGestures!==!1,zoomedIn=()=>(win.visualViewport?.scale??1)>1.01;win.addEventListener("wheel",event=>{if(!(!enabled()||!event.cancelable)){if(event.ctrlKey){event.deltaY>0&&!zoomedIn()&&event.preventDefault();return}Math.abs(event.deltaX)<=Math.abs(event.deltaY)||somethingScrolls(event,"x",{doc})||event.preventDefault()}},{capture:!0,passive:!1});let ours=!1,options={capture:!0,passive:!1};win.addEventListener("gesturestart",event=>{ours=enabled()&&!zoomedIn(),ours&&(event.preventDefault(),onPinch({phase:"start",scale:1}))},options),win.addEventListener("gesturechange",event=>{ours&&(event.preventDefault(),Number.isFinite(event.scale)&&onPinch({phase:"change",scale:event.scale}))},options),win.addEventListener("gestureend",event=>{ours&&(ours=!1,event.preventDefault(),onPinch({phase:"end",scale:event.scale}))},options);let sheet=null,style=null;function update(){let on=enabled();if(doc?.adoptedStyleSheets&&typeof win.CSSStyleSheet?.prototype.replaceSync=="function"){sheet||(sheet=new win.CSSStyleSheet,sheet.replaceSync(NO_BOUNCE_CSS));let others=doc.adoptedStyleSheets.filter(s=>s!==sheet),has=others.length!==doc.adoptedStyleSheets.length;on!==has&&(doc.adoptedStyleSheets=on?[...others,sheet]:others)}else doc?.documentElement&&(on&&!style?.isConnected?(style??=Object.assign(doc.createElement("style"),{textContent:NO_BOUNCE_CSS}),doc.documentElement.appendChild(style)):on||style?.remove())}return update(),{update}}var canSwipe=(event,doc)=>!somethingScrolls(event,"x",{doc});function el(doc,tag,attrs={},...children){let node=doc.createElement(tag);for(let[key,value]of Object.entries(attrs))value==null||value===!1||(key==="class"?node.className=value:key==="text"?node.textContent=value:key==="style"?node.style.cssText=value:node.setAttribute(key,value===!0?"":value));for(let child of children.flat())child&&node.append(child);return node}function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,"")}catch{return""}}function hue(text){let h=0;for(let ch of text)h=(h*31+ch.codePointAt(0))%360;return h}function avatar(doc,{title,url,favIconUrl}){let label=hostOf(url)||title||"?",letter=el(doc,"span",{class:"avatar letter",text:label.charAt(0).toUpperCase(),style:`background: hsl(${hue(label)} 55% 48%)`,"aria-hidden":"true"});if(!favIconUrl||!/^(https?|data):/.test(favIconUrl))return letter;let img=el(doc,"img",{class:"avatar",src:favIconUrl,alt:"",referrerpolicy:"no-referrer"});return img.addEventListener("error",()=>img.replaceWith(letter),{once:!0}),img}function adoptStyles(shadow,css){if("adoptedStyleSheets"in shadow&&typeof CSSStyleSheet.prototype.replaceSync=="function"){let sheet=new CSSStyleSheet;sheet.replaceSync(css),shadow.adoptedStyleSheets=[...shadow.adoptedStyleSheets,sheet]}else{let style=shadow.ownerDocument.createElement("style");style.textContent=css,shadow.prepend(style)}}function createHost(doc,tag){let host=doc.createElement(tag);for(let[prop,value]of Object.entries({all:"initial",position:"fixed",top:"0",left:"0",width:"0",height:"0","z-index":"2147483647"}))host.style.setProperty(prop,value,"important");return host}function siteModalOpen(doc){try{return!!doc.querySelector(":modal")}catch{return!1}}var SPACE_COLORS=["#6c5ce7","#0984e3","#00b894","#fdcb6e","#e17055","#d63031","#e84393","#636e72"],TAB_MIME="application/x-margin-tab";function createSidebar({document:doc,send,mode,onNewTab,onWidth}){let chips=el(doc,"nav",{class:"spaces","aria-label":"Spaces"}),nameInput=el(doc,"input",{class:"name",type:"text",placeholder:"Space name","aria-label":"Space name",maxlength:"40"}),emojiInput=el(doc,"input",{class:"emoji",type:"text","aria-label":"Space emoji",maxlength:"8"}),swatches=el(doc,"div",{class:"swatches",role:"radiogroup","aria-label":"Space color"},SPACE_COLORS.map(c=>el(doc,"button",{type:"button",class:"swatch","data-color":c,title:c,style:`--chip-color: ${c}`,role:"radio"}))),deleteButton=el(doc,"button",{type:"button",class:"delete","data-editor":"delete",text:"Delete"}),editor=el(doc,"form",{class:"editor",hidden:!0,"aria-label":"Edit space"},el(doc,"div",{class:"row"},emojiInput,nameInput),swatches,el(doc,"div",{class:"row actions"},deleteButton,el(doc,"span",{class:"spacer"}),el(doc,"button",{type:"button","data-editor":"cancel",text:"Cancel"}),el(doc,"button",{type:"submit",class:"primary",text:"Save"}))),pins=el(doc,"ul",{class:"pins","aria-label":"Pinned"}),tabs=el(doc,"ul",{class:"tabs","aria-label":"Tabs"}),keepOpen=el(doc,"button",{class:"keep-open","data-action":"keep-open",title:"Keep the sidebar open"}),footer=el(doc,"footer",{},el(doc,"button",{class:"new-tab","data-action":"new-tab",text:"+ New tab"}),mode==="overlay"?keepOpen:null),root=el(doc,"aside",{class:`margin-sidebar ${mode}`,"aria-label":"Margin"},chips,editor,el(doc,"section",{class:"pins-section"},pins),el(doc,"div",{class:"divider"}),el(doc,"section",{class:"tabs-section"},tabs),footer);containScroll(root);let resizer=el(doc,"div",{class:"resizer",title:"Drag to resize · double-click to reset","aria-hidden":"true"});root.append(resizer);let resizing=null,setWidth=px=>root.style.setProperty("--width",`${px}px`);resizer.addEventListener("pointerdown",event=>{if(event.button!==0)return;event.preventDefault(),event.stopPropagation(),resizer.setPointerCapture?.(event.pointerId);let startWidth=root.getBoundingClientRect().width;resizing={startX:event.clientX,startWidth,width:startWidth},root.classList.add("resizing")}),resizer.addEventListener("pointermove",event=>{resizing&&(resizing.width=clampWidth(resizing.startWidth+event.clientX-resizing.startX),setWidth(resizing.width),onWidth?.(resizing.width,{done:!1}))});let endResize=()=>{if(!resizing)return;let width=snapWidth(resizing.width);resizing=null,root.classList.remove("resizing"),setWidth(width),onWidth?.(width,{done:!0}),send("updateSettings",{patch:{sidebarWidth:width}})};resizer.addEventListener("pointerup",endResize),resizer.addEventListener("pointercancel",endResize),resizer.addEventListener("lostpointercapture",endResize),resizer.addEventListener("dblclick",event=>{event.stopPropagation();let width=WIDTH.default;setWidth(width),onWidth?.(width,{done:!0}),send("updateSettings",{patch:{sidebarWidth:width}})});let state=null,windowId=null,currentTabId=null,pendingEdit=null;function render(){if(!state||windowId==null)return;let view=sidebar(state,windowId,currentTabId);root.style.setProperty("--space-color",view.spaces.find(s=>s.id===view.spaceId)?.color??""),resizing||setWidth(sidebarWidth(state)),chips.replaceChildren(...view.spaces.map(s=>el(doc,"button",{class:`chip${s.id===view.spaceId?" active":""}`,"data-action":"set-space","data-space-id":s.id,title:s.name,"aria-pressed":String(s.id===view.spaceId),style:`--chip-color: ${s.color}`,text:s.emoji})),el(doc,"button",{class:"chip add","data-action":"add-space",title:"New space",text:"+"})),pins.replaceChildren(...view.pins.map(p=>el(doc,"li",{class:`pin${p.active?" active":""}${p.tabId?" open":""}`,"data-action":"open-pin","data-pin-id":p.id,title:p.title},avatar(doc,{...p,favIconUrl:iconFor(state,p)}),el(doc,"span",{class:"title",text:p.title}),el(doc,"button",{class:"icon unpin","data-action":"unpin","data-pin-id":p.id,title:"Unpin",text:"×"})))),tabs.replaceChildren(...view.tabs.map(t=>el(doc,"li",{class:`tab${t.active?" active":""}`,"data-action":"activate","data-tab-id":String(t.id),title:t.title||t.url,draggable:"true"},avatar(doc,{...t,favIconUrl:iconFor(state,t)}),el(doc,"span",{class:"title",text:t.title||t.url||"New Tab"}),el(doc,"button",{class:"icon close","data-action":"close","data-tab-id":String(t.id),title:"Close tab",text:"×"}))));let pinned=!!state.settings?.sidebarPinnedOpen;keepOpen.replaceChildren(el(doc,"span",{class:"icon-only",text:pinned?"⇤":"⇥"}),el(doc,"span",{class:"label",text:pinned?" Auto-hide":" Keep open"})),keepOpen.title=pinned?"Auto-hide the sidebar":"Keep the sidebar open",keepOpen.setAttribute("aria-pressed",String(pinned))}root.addEventListener("click",event=>{let target=event.target.closest("[data-action]");if(!target||!root.contains(target)||(event.stopPropagation(),event.ctrlKey&&target.closest(".tab, .pin")))return;let tabId=Number(target.dataset.tabId),{pinId,spaceId}=target.dataset;switch(target.dataset.action){case"activate":return send("activateTab",{tabId});case"close":return send("closeTab",{tabId});case"open-pin":return send("openPin",{pinId,windowId});case"unpin":return send("unpin",{pinId});case"set-space":return send("setSpace",{windowId,spaceId});case"new-tab":return onNewTab?onNewTab():send("newTab",{windowId});case"add-space":return send("createSpace",{windowId}).then(res=>{res?.spaceId&&(state?.spaces.some(s=>s.id===res.spaceId)?openEditor(res.spaceId):pendingEdit=res.spaceId)});case"keep-open":return send("updateSettings",{patch:{sidebarPinnedOpen:!state?.settings?.sidebarPinnedOpen}})}});let editing=null;function openEditor(spaceId){let space=state?.spaces.find(s=>s.id===spaceId);space&&(editing={spaceId,color:space.color,confirmDelete:!1},nameInput.value=space.name,emojiInput.value=space.emoji,editor.hidden=!1,renderEditor(),nameInput.focus(),nameInput.select())}function closeEditor(){editing=null,editor.hidden=!0}function renderEditor(){if(!editing)return;for(let sw of swatches.children)sw.setAttribute("aria-checked",String(sw.dataset.color===editing.color));let only=(state?.spaces.length??0)<2;deleteButton.disabled=only,deleteButton.title=only?"The last space can’t be deleted":"Tabs and pins move to the first space",deleteButton.textContent=editing.confirmDelete?"Really delete?":"Delete"}editor.addEventListener("submit",event=>{event.preventDefault(),editing&&(send("renameSpace",{spaceId:editing.spaceId,name:nameInput.value,emoji:emojiInput.value,color:editing.color}),closeEditor())}),editor.addEventListener("click",event=>{event.stopPropagation();let swatch=event.target.closest(".swatch");if(swatch&&editing)return editing.color=swatch.dataset.color,renderEditor();let action=event.target.closest("[data-editor]")?.dataset.editor;if(action==="cancel"&&closeEditor(),action==="delete"&&editing){if(!editing.confirmDelete)return editing.confirmDelete=!0,renderEditor();send("deleteSpace",{spaceId:editing.spaceId}),closeEditor()}}),editor.addEventListener("keydown",event=>{event.key==="Escape"&&closeEditor()}),chips.addEventListener("contextmenu",event=>{let chip=event.target.closest(".chip[data-space-id]");chip&&(event.preventDefault(),openEditor(chip.dataset.spaceId))}),chips.addEventListener("dblclick",event=>{let chip=event.target.closest(".chip[data-space-id]");chip&&openEditor(chip.dataset.spaceId)});let menu=el(doc,"div",{class:"tab-menu",role:"menu",tabindex:"-1",hidden:!0});root.append(menu);let menuPopover=typeof menu.showPopover=="function";menuPopover&&menu.setAttribute("popover","manual");let menuFor=null,menuItem=(label,action,data={})=>el(doc,"button",{class:"menu-item",role:"menuitem","data-menu":action,...data,text:label});function openMenu(row,x,y){let tabId=row.dataset.tabId?Number(row.dataset.tabId):null,pin=row.dataset.pinId?state?.pins.find(p=>p.id===row.dataset.pinId):null;if(tabId==null&&!pin)return;let items=[];if(pin){menuFor={pinId:pin.id},items.push(menuItem("Unpin","unpin"));let openTab=sidebar(state,windowId,currentTabId).pins.find(p=>p.id===pin.id)?.tabId;openTab!=null&&items.push(el(doc,"div",{class:"menu-separator",role:"separator"}),menuItem("Close Tab","close",{"data-tab-id":String(openTab)}))}else{menuFor={tabId},items.push(menuItem("Pin Tab","pin"));let spaceId=state?.tabSpace?.[tabId],others=(state?.spaces??[]).filter(sp=>sp.id!==spaceId);if(others.length){items.push(el(doc,"div",{class:"menu-separator",role:"separator"}));for(let sp of others)items.push(menuItem(`Move to ${sp.emoji} ${sp.name}`,"move",{"data-space-id":sp.id}))}items.push(el(doc,"div",{class:"menu-separator",role:"separator"}),menuItem("Close Tab","close",{"data-tab-id":String(tabId)}))}menu.replaceChildren(...items),menu.hidden=!1;let inTopLayer=!1;if(menuPopover&&!siteModalOpen(doc))try{menu.matches(":popover-open")||menu.showPopover(),inTopLayer=!0}catch{}if(menu.classList.toggle("top-layer",inTopLayer),inTopLayer){let view=doc.defaultView;menu.style.left=`${Math.max(4,Math.min(x,view.innerWidth-menu.offsetWidth-4))}px`,menu.style.top=`${Math.max(4,Math.min(y,view.innerHeight-menu.offsetHeight-4))}px`}else{let box=root.getBoundingClientRect();menu.style.left=`${Math.max(4,Math.min(x-box.left,box.width-menu.offsetWidth-4))}px`,menu.style.top=`${Math.max(4,Math.min(y-box.top,box.height-menu.offsetHeight-4))}px`}menu.focus({preventScroll:!0})}function closeMenu(){if(!menu.hidden){try{menuPopover&&menu.matches(":popover-open")&&menu.hidePopover()}catch{}menu.hidden=!0,menuFor=null}}root.addEventListener("contextmenu",event=>{let row=event.target.closest(".tab, .pin");if(!row||!root.contains(row))return closeMenu();event.preventDefault(),event.stopPropagation(),openMenu(row,event.clientX,event.clientY)}),menu.addEventListener("click",event=>{event.stopPropagation();let item=event.target.closest(".menu-item");if(!item||!menuFor)return;let target=menuFor;switch(closeMenu(),item.dataset.menu){case"pin":return send("pinTab",{tabId:target.tabId});case"unpin":return send("unpin",{pinId:target.pinId});case"move":return send("moveTabToSpace",{tabId:target.tabId,spaceId:item.dataset.spaceId});case"close":return send("closeTab",{tabId:Number(item.dataset.tabId)})}}),menu.addEventListener("pointerover",event=>event.target.closest(".menu-item")?.focus({preventScroll:!0})),menu.addEventListener("pointerleave",()=>menu.focus({preventScroll:!0})),menu.addEventListener("keydown",event=>{if(event.key==="Escape")return closeMenu(),globalThis.Margin?.shell?.focusCard();if(event.key!=="ArrowDown"&&event.key!=="ArrowUp")return;event.preventDefault();let items=[...menu.querySelectorAll(".menu-item")],at=items.indexOf(menu.getRootNode().activeElement),step=event.key==="ArrowDown"?1:-1;items[(at+step+items.length)%items.length]?.focus()}),root.addEventListener("pointerdown",event=>{!menu.hidden&&!menu.contains(event.target)&&closeMenu()},!0),doc.addEventListener("pointerdown",event=>{let inSidebar=root.contains(event.target)||event.target===root.getRootNode().host;!menu.hidden&&!inSidebar&&closeMenu()},!0),doc.defaultView?.addEventListener("blur",closeMenu);for(let type of["keydown","keyup","keypress"])root.addEventListener(type,e=>e.stopPropagation());let draggingTabId=null;tabs.addEventListener("dragstart",event=>{let row=event.target.closest(".tab");row&&(draggingTabId=Number(row.dataset.tabId),event.dataTransfer.setData(TAB_MIME,row.dataset.tabId),event.dataTransfer.effectAllowed="move")}),tabs.addEventListener("dragend",()=>{draggingTabId=null;for(let c of chips.querySelectorAll(".drop-target"))c.classList.remove("drop-target")});let chipFor=event=>draggingTabId==null?null:event.target.closest?.(".chip[data-space-id]");return chips.addEventListener("dragover",event=>{let chip=chipFor(event);chip&&(event.preventDefault(),event.dataTransfer.dropEffect="move",chip.classList.add("drop-target"))}),chips.addEventListener("dragleave",event=>chipFor(event)?.classList.remove("drop-target")),chips.addEventListener("drop",event=>{let chip=chipFor(event);chip&&(event.preventDefault(),chip.classList.remove("drop-target"),send("moveTabToSpace",{tabId:draggingTabId,spaceId:chip.dataset.spaceId}),draggingTabId=null)}),{el:root,isBusy:()=>editing!=null||draggingTabId!=null||resizing!=null||!menu.hidden,width:()=>resizing?resizing.width:sidebarWidth(state),update(nextState,context){state=nextState,menuFor?.tabId!=null&&!state.tabs?.[menuFor.tabId]&&closeMenu(),menuFor?.pinId&&!state.pins?.some(p=>p.id===menuFor.pinId)&&closeMenu(),context?.windowId!=null&&(windowId=context.windowId),context?.tabId!=null&&(currentTabId=context.tabId),render(),pendingEdit&&state.spaces.some(s=>s.id===pendingEdit)&&(openEditor(pendingEdit),pendingEdit=null),editing&&!state.spaces.some(s=>s.id===editing.spaceId)&&closeEditor(),renderEditor()},setTheme(theme){root.dataset.theme=theme}}}var DEFAULTS={THRESHOLD:150,GAP_MS:140,MIN_EVENTS:8,MIN_MS:160,MAX_STEP:80,MOMENTUM_RUN:5},SWIPE_DEFAULTS={...DEFAULTS,THRESHOLD:110,MIN_EVENTS:6,MIN_MS:100};function createTracker(axis,options){let o=options,gesture=null,lastTime=-1/0,idle=()=>({state:"idle",progress:0,direction:0}),view=g=>{let progress=Math.min(g.pull/o.THRESHOLD,1.5);return{state:g.pull>=o.THRESHOLD&&g.events>=o.MIN_EVENTS&&g.last-g.start>=o.MIN_MS?"armed":g.pull>0?"pulling":"idle",progress,direction:g.direction}},decaying=recent=>{if(recent.length<o.MOMENTUM_RUN)return!1;let run=recent.slice(-o.MOMENTUM_RUN);if(run[0]<3)return!1;for(let i=1;i<run.length;i++){let ratio=run[i]/run[i-1];if(!(ratio>=.72&&ratio<.995))return!1}return!0};return{wheel({deltaY=0,deltaX=0,time,eligible,atTop}){let ok=eligible??atTop,primary=axis==="y"?deltaY:deltaX,cross=axis==="y"?deltaX:deltaY,fresh=time-lastTime>o.GAP_MS;lastTime=time,fresh&&(gesture={start:time,last:time,events:0,pull:0,direction:axis==="y"?-1:0,eligible:ok,momentum:!1,recent:[]});let g=gesture;if(!g?.eligible)return idle();if(g.last=time,!ok)return g.eligible=!1,idle();let along=Math.abs(primary)>=Math.abs(cross);return g.recent.push(Math.abs(along?primary:0)),g.recent.length>o.MOMENTUM_RUN&&g.recent.shift(),!g.momentum&&decaying(g.recent)&&(g.momentum=!0,view(g).state==="armed")?(g.eligible=!1,{...view(g),state:"trigger"}):g.momentum?idle():(!along||Math.abs(primary)>o.MAX_STEP||(!g.direction&&Math.abs(primary)>=1&&(g.direction=Math.sign(primary)),!g.direction)||(g.events+=1,g.pull=Math.max(0,g.pull+primary*g.direction)),view(g))},end(){let g=gesture;return gesture=null,lastTime=-1/0,!g?.eligible||g.momentum?idle():view(g).state==="armed"?{...view(g),state:"trigger"}:idle()},reset(){gesture=null,lastTime=-1/0}}}var createPullTracker=(options={})=>createTracker("y",{...DEFAULTS,...options}),createSwipeTracker=(options={})=>createTracker("x",{...SWIPE_DEFAULTS,...options});var PROFILES={safari:{name:"safari",fetchFavicons:!0,blockGestures:!0,search:"learn",shell:!0,navigation:{nextTab:"Alt+Meta+ArrowDown",prevTab:"Alt+Meta+ArrowUp",nextSpace:"Ctrl+Meta+ArrowRight",prevSpace:"Ctrl+Meta+ArrowLeft"}},chrome:{name:"chrome",fetchFavicons:!1,blockGestures:!1,search:"browser",shell:!1,navigation:{nextTab:"Ctrl+Meta+ArrowDown",prevTab:"Ctrl+Meta+ArrowUp",nextSpace:"Ctrl+Meta+ArrowRight",prevSpace:"Ctrl+Meta+ArrowLeft"}}},BUILD_TARGET="chrome",detect=()=>{try{return(globalThis.browser??globalThis.chrome)?.runtime?.getURL?.("").startsWith("safari-web-extension:")?"safari":"chrome"}catch{return"chrome"}},platform=PROFILES[BUILD_TARGET??detect()];(globalThis.Margin??={}).platform=platform;var MODIFIERS=["Ctrl","Alt","Shift","Meta"];var KEY_CODES=/^(Key[A-Z]|Digit\d|F\d{1,2}|Arrow(Up|Down|Left|Right)|Space|Enter|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;function parse(text){let parts=String(text??"").split("+").map(p=>p.trim()).filter(Boolean),code=parts.pop();if(!code||!KEY_CODES.test(code))return null;let mods=new Set(parts);return!mods.size||[...mods].some(m=>!MODIFIERS.includes(m))?null:{ctrl:mods.has("Ctrl"),alt:mods.has("Alt"),shift:mods.has("Shift"),meta:mods.has("Meta"),code}}function matches(event,text){let s=parse(text);return!!s&&event.code===s.code&&event.ctrlKey===s.ctrl&&event.altKey===s.alt&&event.shiftKey===s.shift&&event.metaKey===s.meta}var NAVIGATION={...(platform??PROFILES.chrome).navigation},navigationFor=settings=>({...NAVIGATION,...settings?.shortcuts}),ACTIONS={nextTab:"next-tab",prevTab:"prev-tab",nextSpace:"next-space",prevSpace:"prev-space"};function installNavigation({send,getSettings,target=globalThis}){target.addEventListener("keydown",event=>{let settings=getSettings();if(settings===null)return;let keys=navigationFor(settings),name=Object.keys(keys).find(n=>matches(event,keys[n]));name&&(event.preventDefault(),event.stopImmediatePropagation(),!(event.repeat&&name.endsWith("Space"))&&send("navigate",{action:ACTIONS[name]}))},!0)}var sidebar2=`.margin-sidebar, .frame {
  /* One sidebar background for now (Arc-like neutral gray), the same in
     Light and Dark Mode; not tinted by the space or taken from the page.
     Keep in sync with newtab.css and docked.css. */
  --frame: #9c9da1;
}

.margin-sidebar {
  --width: 260px;
  --space-color: #6c5ce7; /* accents only (editor buttons), set per space */
  /* Dark text on the mid-gray; secondary text dark enough to stay readable. */
  --fg: #1c1c1e;
  --muted: #2f3033;
  --hover: rgba(255, 255, 255, 0.2);
  --active: rgba(255, 255, 255, 0.55);
  --border: rgba(0, 0, 0, 0.1);

  box-sizing: border-box;
  width: var(--width);
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 8px;
  background: var(--frame);
  color: var(--fg);
  font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
.margin-sidebar *, .margin-sidebar *::before, .margin-sidebar *::after { box-sizing: border-box; }

/* Hover (auto-hide): a floating card over the page, inset from the edges.
   Never moves the page. */
.margin-sidebar.overlay {
  position: fixed;
  top: 8px;
  left: 8px;
  height: calc(100vh - 16px);
  border-radius: 12px;
  background: var(--frame);
  box-shadow: 0 0 0 1px var(--border), 0 12px 40px rgba(0, 0, 0, 0.22);
  transform: translateX(calc(-100% - 16px));
  visibility: hidden;
  transition: transform 160ms ease, visibility 0s linear 160ms;
}
.margin-sidebar.overlay.open {
  transform: none;
  visibility: visible;
  transition: transform 160ms ease;
}
/* Keep open: docked flush to the window and opaque, so sidebar and frame
   read as one surface around the (pushed) page. */
.margin-sidebar.overlay.docked {
  top: 0;
  left: 0;
  height: 100vh;
  border-radius: 0;
  background: var(--frame);
  box-shadow: none;
}

/* First render after page load: appear without animating. */
.instant, .instant * { transition: none !important; }

/* Frame: covers the page edges around the page "card" whose left edge is
   the sidebar's right edge. Two layers, both pointer-events: none so the
   page stays usable:
   - .frame (below the sidebar): the solid color around the rounded card.
   - .card-edge (above the sidebar): the card's soft shadow, which also falls
     on the sidebar's edge.
   Corner radius and shadow measured from Arc (DECISIONS.md); keep them the
   same in docked.template.css and newtab.css (a unit test checks). */
.frame, .card-edge {
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 160ms ease, visibility 0s linear 160ms;
}
.frame.open, .card-edge.open {
  opacity: 1;
  visibility: visible;
  transition: opacity 160ms ease;
}
.frame {
  position: fixed;
  inset: 0;
  overflow: hidden;
}
.frame .hole, .card-edge {
  position: absolute;
  top: 8px;
  right: 8px;
  bottom: 8px;
  left: var(--width, 260px); /* set from settings.sidebarWidth by sidebar.js */
}
.frame .hole, .card-edge { border-radius: 6.25px; }
.frame .hole { box-shadow: 0 0 0 100vmax var(--frame); }
.card-edge {
  position: fixed;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.24), 0 0 3px rgba(0, 0, 0, 0.06);
}

button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}

.spaces { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 2px 6px; }
.chip {
  min-width: 32px;
  height: 28px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 15px;
  opacity: 0.6;
}
.chip:hover { background: var(--hover); opacity: 1; }
.chip.active { opacity: 1; background: color-mix(in srgb, var(--chip-color) 22%, transparent); box-shadow: inset 0 0 0 1.5px var(--chip-color); }
.chip.drop-target { outline: 2px dashed var(--chip-color); }

ul { list-style: none; margin: 0; padding: 0; }
.pins-section:empty, .pins:empty { display: none; }
.pins { display: flex; flex-direction: column; gap: 1px; }
.tabs-section { flex: 1; overflow-y: auto; min-height: 0; overscroll-behavior: none; } /* never scrolls the page; no bounce */
.divider { height: 1px; background: var(--border); margin: 2px 6px; }

.tab, .pin {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 6px 0 8px;
  border-radius: 8px;
  cursor: default;
}
.tab:hover, .pin:hover { background: var(--hover); }
.tab.active, .pin.active { background: var(--active); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.pin:not(.open) .title { color: var(--muted); }
.title { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.avatar {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  object-fit: contain;
}
.avatar.letter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}
.icon {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 22px;
  color: var(--muted);
  visibility: hidden;
}
.tab:hover .icon, .pin:hover .icon { visibility: visible; }
.icon:hover { background: var(--hover); color: var(--fg); }

/* Right-click menu on tabs and pins (macOS-style). */
.tab-menu {
  position: absolute;
  z-index: 5;
  min-width: 180px;
  max-width: calc(100% - 8px);
  padding: 5px;
  border-radius: 8px;
  background: rgba(246, 246, 246, 0.97);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.18), 0 8px 24px rgba(0, 0, 0, 0.22);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  color: #1c1c1e;
}
.tab-menu[hidden] { display: none; }
/* In the top layer (popover): fixed to the viewport, none of the browser's
   popover defaults (margin: auto, border, inset: 0, overflow). */
.tab-menu[popover] { margin: 0; border: 0; inset: auto; overflow: visible; color: #1c1c1e; }
.tab-menu.top-layer { position: fixed; }
.tab-menu[popover]:not(:popover-open):not(.top-layer):not([hidden]) { display: block; } /* no top layer: as before */
.menu-item {
  display: block;
  width: 100%;
  height: 24px;
  padding: 0 10px;
  border-radius: 5px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: left;
  font-size: 13px;
  outline: none;
  cursor: default;
}
.tab-menu:focus { outline: none; }
.menu-item:focus { background: #0a84ff; color: #fff; }
.menu-separator { height: 1px; margin: 5px 10px; background: rgba(0, 0, 0, 0.12); }

footer { display: flex; gap: 4px; padding-top: 4px; border-top: 1px solid var(--border); }
.new-tab, .keep-open { height: 30px; padding: 0 8px; border-radius: 8px; color: var(--muted); text-align: left; }
.new-tab { flex: 1; }
/* Narrow sidebars (down to 160px): one line, never wrap; below 230px the
   Keep open / Auto-hide button shows only its icon (full label on hover). */
.margin-sidebar { container-type: inline-size; }
.new-tab, .keep-open { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.keep-open { flex: none; }
@container (max-width: 229px) {
  .keep-open .label { display: none; }
}
.new-tab:hover, .keep-open:hover { background: var(--hover); color: var(--fg); }

.chip.add { font-size: 16px; color: var(--muted); }

.editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 2px 4px;
  padding: 8px;
  border-radius: 10px;
  background: var(--hover);
}
.editor[hidden] { display: none; }
.editor .row { display: flex; gap: 6px; align-items: center; }
.editor input {
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--active);
  color: var(--fg);
  font: inherit;
  outline: none;
}
.editor input:focus { border-color: var(--space-color); }
.editor .emoji { width: 40px; flex: none; text-align: center; font-size: 15px; }
.editor .name { flex: 1; }
.swatches { display: flex; gap: 6px; flex-wrap: wrap; }
.swatch { width: 20px; height: 20px; border-radius: 50%; background: var(--chip-color); }
.swatch[aria-checked="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--chip-color); }
.editor .actions button { height: 26px; padding: 0 10px; border-radius: 7px; color: var(--muted); }
.editor .actions button:hover { background: var(--hover); color: var(--fg); }
.editor .actions .primary { background: var(--space-color); color: #fff; }
.editor .delete { color: #d63031 !important; }
.editor .delete:disabled { opacity: 0.4; cursor: default; }
.spacer { flex: 1; }

/* Resize handle: the right edge of the sidebar (160–500px). */
.margin-sidebar.newtab { position: relative; }
/* Resize handle (Arc): on hover or while dragging, a soft light pill runs the
   height of the page card, just inside the sidebar's edge, 2px from the page.
   The hit area (12px) straddles the edge; the pill is 4px wide, at
   width-6 … width-2, inset 8px top and bottom like the page card. */
.resizer {
  position: absolute;
  top: 0;
  right: -4px;
  width: 12px;
  height: 100%;
  cursor: col-resize;
  z-index: 2;
  touch-action: none;
}
.resizer::after {
  content: "";
  position: absolute;
  top: 8px;
  bottom: 8px;
  right: 6px;
  width: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.6);
  opacity: 0;
  transition: opacity 120ms ease;
}
.resizer:hover::after, .resizing .resizer::after { opacity: 1; }
.margin-sidebar.resizing { user-select: none; cursor: col-resize; }
.margin-sidebar.resizing, .margin-sidebar.resizing * { transition: none !important; }

/* Pull-to-refresh (Safari builds; content/sidebar.js, shared/pull.js): a
   dark round badge, centered over the page like the loading pill, that
   slides down with the pull (--pull: 0 … 1.2), its ring filling to the
   threshold; the arrow flips to point up once letting go will reload
   ("armed"), then it spins while the page reloads. Follows the fingers
   without easing while tracking, eases back when let go. */
.pull {
  --pull: 0;
  position: fixed;
  top: 0;
  left: 50%;
  width: 36px;
  height: 36px;
  margin-left: -18px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(28, 28, 30, 0.9);
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.3), 0 4px 14px rgba(0, 0, 0, 0.25);
  pointer-events: none;
  opacity: clamp(0, calc((var(--pull) - 0.12) * 3), 1);
  transform: translateY(calc(-44px + min(var(--pull), 1.2) * 60px)) scale(calc(0.75 + min(var(--pull), 1) * 0.25));
  transition: opacity 200ms ease, transform 240ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.pull.in-frame { left: calc(var(--width, 260px) + (100vw - var(--width, 260px) - 8px) / 2); }
.pull.tracking { transition: none; }
.pull.armed:not(.refreshing) { transform: translateY(calc(-44px + min(var(--pull), 1.2) * 60px)) scale(1.06); transition: transform 120ms ease; }
.pull svg { display: block; overflow: visible; }
.pull .track, .pull .ring { fill: none; stroke-width: 2.5; }
.pull .track { stroke: rgba(255, 255, 255, 0.22); }
.pull .ring {
  stroke: #fff;
  stroke-linecap: round;
  stroke-dasharray: 100;
  stroke-dashoffset: calc(100 - min(var(--pull), 1) * 100);
  transform: rotate(-90deg);
  transform-origin: 14px 14px;
}
.pull .arrow {
  fill: none;
  stroke: #fff;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform-origin: 14px 14px;
  transition: transform 160ms ease;
}
.pull.armed .arrow { transform: rotate(180deg); } /* points up: let go to reload */
.pull.refreshing .arrow { opacity: 0; }
.pull.refreshing .ring { stroke-dasharray: 28 72; stroke-dashoffset: 0; }
.pull.refreshing svg { animation: margin-pull-spin 0.8s linear infinite; }
@keyframes margin-pull-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .pull, .pull.armed:not(.refreshing) { transition: opacity 150ms linear; }
  .pull.refreshing svg { animation: none; }
  .pull.refreshing .ring { stroke-dasharray: 100; }
}

/* Swipe back/forward badge (Safari builds; measured from Tirth's Arc
   recording): a 148px dark circle centered on the page's left edge (back) or
   right edge (forward), vertically centered, half of it over the frame or
   sidebar; a bold white arrow in its visible half. It fades in and darkens
   with the swipe (--swipe: 0 … 1), fully dark once letting go will navigate.
   Drawn over everything Margin draws, never taking clicks. */
.swipe {
  --swipe: 0;
  position: fixed;
  top: 50%;
  left: 0;
  width: 148px;
  height: 148px;
  margin: -74px 0 0 -74px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(38, 38, 38, calc(0.45 + var(--swipe) * 0.4));
  pointer-events: none;
  opacity: 0;
  transition: opacity 180ms ease, background-color 120ms linear;
}
.swipe.in-frame { left: var(--width, 260px); } /* the page card's left edge */
.swipe.forward { left: auto; right: 0; margin: -74px -74px 0 0; }
.swipe.forward.in-frame { right: 8px; } /* the page card's right edge */
.swipe.active { opacity: clamp(0, calc(var(--swipe) * 5), 1); }
.swipe.tracking { transition: none; }
.swipe.armed { background: rgba(38, 38, 38, 0.88); }
.swipe svg { display: block; overflow: visible; transform: translateX(36px); }
.swipe.forward svg { transform: translateX(-36px) rotate(180deg); }
.swipe path { fill: none; stroke: #fff; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }

/* Pinch-to-zoom readout (Safari builds): "125%" in a small dark pill
   centered at the top of the page while pinching. */
.zoom-hud {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(28, 28, 30, 0.9);
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.3), 0 4px 14px rgba(0, 0, 0, 0.25);
  color: #fff;
  font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
}
.zoom-hud.in-frame { left: calc(var(--width, 260px) + (100vw - var(--width, 260px) - 8px) / 2); }
.zoom-hud.show { opacity: 1; transition-duration: 80ms; }
@media (prefers-reduced-motion: reduce) {
  .swipe, .zoom-hud { transition: opacity 120ms linear; }
}

/* Page-load indicator (Arc): a small dark pill centered over the page. With
   "Keep open" it sits in the frame's 8px top strip; otherwise at the top of
   the page. Fades and widens in, pulses gently while loading, fades out. */
.loader {
  position: fixed;
  top: 2px;
  left: 50%;
  width: 48px;
  height: 4px;
  transform: translateX(-50%) scaleX(0.85);
  opacity: 0;
  pointer-events: none;
  transition: opacity 250ms ease, transform 250ms ease;
}
.loader.in-frame { left: calc(var(--width, 260px) + (100vw - var(--width, 260px) - 8px) / 2); }
.loader.on { opacity: 1; transform: translateX(-50%) scaleX(1); }
.loader.instant { transition: none; }
.loader .bar {
  width: 100%;
  height: 100%;
  border-radius: 2px;
  background: rgba(28, 28, 30, 0.88);
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.3);
}
.loader.on .bar { animation: margin-loader-pulse 1.2s ease-in-out 250ms infinite; }
@keyframes margin-loader-pulse { 50% { opacity: 0.55; } }
@media (prefers-reduced-motion: reduce) {
  .loader { transition: opacity 150ms linear; }
  .loader.on .bar { animation: none; }
}
`,palette=`/* Arc-style command bar (measured from Tirth's Arc screenshot): a dark,
   translucent panel about half the window wide, a third of the way down;
   one-line rows with the space name and an arrow button; the selected row
   takes the current space's color. */
.backdrop, .palette { display: none; }
:host([data-open="true"]) .backdrop {
  display: block;
  position: fixed;
  inset: 0;
  background: transparent; /* catches clicks outside; Arc doesn't dim the page */
}
:host([data-open="true"]) .palette { display: flex; }

.palette {
  --space-color: #6c5ce7; /* set to the current space's color when opened */
  --fg: #f2f1f4;
  --muted: rgba(242, 241, 244, 0.55);
  --row-hover: rgba(255, 255, 255, 0.06);
  --border: rgba(255, 255, 255, 0.1);

  position: fixed;
  top: 33vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(760px, calc(100vw - 32px));
  max-height: min(62vh, 560px);
  flex-direction: column;
  box-sizing: border-box;
  background: rgba(36, 32, 36, 0.86);
  backdrop-filter: blur(28px) saturate(1.5);
  -webkit-backdrop-filter: blur(28px) saturate(1.5);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45), 0 0 0 0.5px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  font: 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.palette *, .palette *::before, .palette *::after { box-sizing: border-box; }
@media (max-height: 640px) { .palette { top: 18vh; } }

.search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 60px;
  padding: 0 22px;
  border-bottom: 1px solid var(--border);
}
.search-icon {
  flex: none;
  width: 18px;
  height: 18px;
  fill: none;
  stroke: var(--muted);
  stroke-width: 2;
  stroke-linecap: round;
}
.query {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 18px;
  outline: none;
}
.query::placeholder { color: var(--muted); }

.results { list-style: none; margin: 0; padding: 8px; overflow-y: auto; overscroll-behavior: none; }
.results li {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 44px;
  padding: 0 10px 0 14px;
  border-radius: 10px;
  cursor: default;
}
.results li + li { margin-top: 2px; }
.results li:hover { background: var(--row-hover); }
.results li[aria-selected="true"] {
  background: var(--space-color);
  background: color-mix(in srgb, var(--space-color) 82%, #000);
}
.results .empty { color: var(--muted); justify-content: center; }

.avatar { flex: none; width: 18px; height: 18px; border-radius: 4px; object-fit: contain; }
.avatar.letter { display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 11px; font-weight: 600; }
.avatar.emoji { display: inline-flex; align-items: center; justify-content: center; font-size: 15px; }
.title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; }
.badge { flex: none; color: var(--muted); font-size: 13px; }
[aria-selected="true"] .badge { color: rgba(255, 255, 255, 0.92); }

.go-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.1);
}
.arrow-icon { width: 15px; height: 15px; fill: none; stroke: var(--fg); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
[aria-selected="true"] .go-button { background: #f2f0e8; }
[aria-selected="true"] .arrow-icon { stroke: #1c1c1e; }
`;function startSidebar(){let api=globalThis.browser??globalThis.chrome,timing={injected:Math.round(performance.now())};if(location.href.startsWith(api.runtime.getURL("")))return!1;let Margin=globalThis.Margin??={};if(Margin.content)return!1;Margin.content={api,startedAt:Date.now()};let replacing=!!document.querySelector("margin-sidebar-host");if(replacing){for(let stale of document.querySelectorAll("margin-sidebar-host, margin-palette-host"))stale.style.setProperty("display","none","important"),stale.remove();reloadWhenSafe()}function reloadWhenSafe(){let inUse=(doc,depth=0)=>{if(!doc||depth>4)return!1;let active=doc.activeElement;if(active&&(active.isContentEditable||active.matches?.("textarea, select, input:not([type=hidden], [type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=image])")))return!0;for(let el2 of doc.querySelectorAll("textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]"))if(el2.value.trim())return!0;for(let el2 of doc.querySelectorAll("[contenteditable]:not([contenteditable=false])"))if(el2.isContentEditable&&el2.textContent.trim())return!0;for(let el2 of doc.querySelectorAll("select"))if([...el2.options].some(o=>o.selected!==o.defaultSelected))return!0;for(let el2 of doc.querySelectorAll("input[type=checkbox], input[type=radio]"))if(el2.checked!==el2.defaultChecked)return!0;for(let el2 of doc.querySelectorAll("audio, video"))if(!el2.paused&&!el2.ended||typeof MediaStream<"u"&&el2.srcObject instanceof MediaStream)return!0;for(let frame2 of doc.querySelectorAll("iframe, frame")){let inner;try{inner=frame2.contentDocument}catch{continue}if(inUse(inner,depth+1))return!0}return!1},busy=()=>{try{return navigator.mediaSession?.playbackState==="playing"||inUse(document)}catch{return!0}},retry=null,go=()=>{if(!document.hidden||busy())return;let KEY="margin-reloaded-for-update";try{let wait=3e4-(Date.now()-(Number(sessionStorage.getItem(KEY))||0));if(wait>0){clearTimeout(retry),retry=setTimeout(go,wait+100);return}sessionStorage.setItem(KEY,String(Date.now()))}catch{}document.removeEventListener("visibilitychange",go),clearTimeout(retry),console.info("[margin] Margin was updated while this page was open: loading it again"),api.runtime.sendMessage({type:"reloadForUpdate"}).catch(()=>{})};document.addEventListener("visibilitychange",go),setTimeout(go,500+Math.random()*3e3)}let cardHooks=[];Margin.content.onCard=fn=>{cardHooks.push(fn),Margin.shell?.card&&fn(Margin.shell.card)},Margin.content.cardReady=win=>{for(let fn of cardHooks)fn(win)};let edgePx=()=>revealZone({outerWidth,outerHeight,screenWidth:screen.width,screenHeight:screen.height}),HIDE_DELAY_MS=300,FRAME_PX=8,host=createHost(document,"margin-sidebar-host"),shadow=host.attachShadow({mode:"closed"}),attach=()=>{!host.isConnected&&document.documentElement&&document.documentElement.appendChild(host)};attach();let observer=new MutationObserver(attach);observer.observe(document,{childList:!0}),document.documentElement&&observer.observe(document.documentElement,{childList:!0}),document.addEventListener("DOMContentLoaded",attach);async function send(type,payload={},retry=!0){try{let res=await api.runtime.sendMessage({type,...payload});if(res?.ok)return res.result;if(res)return void console.warn("[margin]",type,res.error)}catch(err){if(!retry)return void console.warn("[margin]",type,err)}if(retry)return await new Promise(r=>setTimeout(r,250)),send(type,payload,!1)}Margin.content.send=send;let sidebar3=createSidebar({document,send,mode:"overlay",onNewTab:()=>Margin.content.openPalette?Margin.content.openPalette():send("newTab",{windowId}),onWidth:(width,{done})=>{if(liveWidth=width,done)return applyLiveWidth();widthFrame??=requestAnimationFrame(applyLiveWidth)}}),liveWidth=null,widthFrame=null;function applyLiveWidth(){widthFrame=null,frame.style.setProperty("--width",`${liveWidth}px`),cardEdge.style.setProperty("--width",`${liveWidth}px`),loader.style.setProperty("--width",`${liveWidth}px`),pull.style.setProperty("--width",`${liveWidth}px`),swipe.style.setProperty("--width",`${liveWidth}px`),zoomHud.style.setProperty("--width",`${liveWidth}px`),pushed&&setPushed(!0,liveWidth),Margin.shell?.setLayout({width:liveWidth})}let frame=el(document,"div",{class:"frame","aria-hidden":"true"},el(document,"div",{class:"hole"})),cardEdge=el(document,"div",{class:"card-edge","aria-hidden":"true"}),loader=el(document,"div",{class:"loader","aria-hidden":"true"},el(document,"div",{class:"bar"})),SVG_NS2="http://www.w3.org/2000/svg",svg=(tag,attrs)=>{let node=document.createElementNS(SVG_NS2,tag);for(let[key,value]of Object.entries(attrs))node.setAttribute(key,String(value));return node},pullRing=svg("circle",{class:"ring",cx:14,cy:14,r:10,pathLength:100}),pullArrow=svg("path",{class:"arrow",d:"M14 8.5v10M9.75 14.5 14 18.75l4.25-4.25"}),pullIcon=svg("svg",{viewBox:"0 0 28 28",width:28,height:28});pullIcon.append(svg("circle",{class:"track",cx:14,cy:14,r:10}),pullRing,pullArrow);let pull=el(document,"div",{class:"pull","aria-hidden":"true"},pullIcon),swipeIcon=svg("svg",{viewBox:"0 0 36 36",width:36,height:36});swipeIcon.append(svg("path",{d:"M28 18H8.5M17 9.5 8.5 18l8.5 8.5"}));let swipe=el(document,"div",{class:"swipe","aria-hidden":"true"},swipeIcon),zoomHud=el(document,"div",{class:"zoom-hud","aria-hidden":"true"});shadow.append(frame,sidebar3.el,cardEdge,loader,pull,swipe,zoomHud),adoptStyles(shadow,sidebar2),sidebar3.el.classList.add("instant"),frame.classList.add("instant"),cardEdge.classList.add("instant");let firstRender=!0,systemDark=matchMedia("(prefers-color-scheme: dark)"),pageTheme=()=>systemDark.matches?"dark":"light";Margin.content.theme=pageTheme;let applyTheme=()=>{let theme=pageTheme();sidebar3.setTheme(theme),frame.dataset.theme=theme};applyTheme(),systemDark.addEventListener?.("change",applyTheme);let state=null,guardWindow=win=>installGestureGuard({getSettings:()=>state?.settings,onPinch:pinch=>handlePinch(pinch),win}),gestureGuard=platform?.blockGestures?guardWindow(window):null,cardGuards=[];gestureGuard&&Margin.content.onCard(win=>cardGuards.push(guardWindow(win)));let updateGestureGuards=()=>{gestureGuard?.update();for(let guard of cardGuards)guard.update()},reason=null,hideTimer=null,pinnedOpen=()=>!!state?.settings?.sidebarPinnedOpen;function setOpen(open){let docked=open&&pinnedOpen();sidebar3.el.classList.toggle("open",open),sidebar3.el.classList.toggle("docked",docked),frame.classList.toggle("open",docked),cardEdge.classList.toggle("open",docked),loader.classList.toggle("in-frame",docked),pull.classList.toggle("in-frame",docked),swipe.classList.toggle("in-frame",docked),zoomHud.classList.toggle("in-frame",docked),host.dataset.open=String(open),setPushed(docked),Margin.shell?.setLayout({docked,width:sidebar3.width()}),state&&syncPlaceholder(),frame.style.setProperty("--width",`${sidebar3.width()}px`),cardEdge.style.setProperty("--width",`${sidebar3.width()}px`),loader.style.setProperty("--width",`${sidebar3.width()}px`),pull.style.setProperty("--width",`${sidebar3.width()}px`),swipe.style.setProperty("--width",`${sidebar3.width()}px`),zoomHud.style.setProperty("--width",`${sidebar3.width()}px`)}let LOADER_MIN_MS=500,LOADER_MAX_MS=15e3,loaderShownAt=null,loaderMaxTimer=null,loaderHideTimer=null,placeholderTookOver=!1,showPill=()=>{clearTimeout(loaderHideTimer),loader.classList.add("on"),host.dataset.loading="true"},hidePill=(delay=0)=>{clearTimeout(loaderHideTimer),loaderHideTimer=setTimeout(()=>{loader.classList.remove("on"),host.dataset.loading="false"},delay)},pageComplete=()=>Margin.shell?Margin.shell.card?.document.readyState==="complete":document.readyState==="complete";function startLoader(){let complete=pageComplete();if(!(loaderShownAt!=null||complete&&!placeholderTookOver)){if(loaderShownAt=performance.now(),placeholderTookOver?(loader.classList.add("instant"),showPill(),requestAnimationFrame(()=>requestAnimationFrame(()=>loader.classList.remove("instant")))):showPill(),complete)return stopLoader();Margin.shell||addEventListener("load",stopLoader,{once:!0}),loaderMaxTimer=setTimeout(stopLoader,LOADER_MAX_MS)}}Margin.content.onCard(win=>win.addEventListener("load",()=>stopLoader(),{once:!0}));function stopLoader(){clearTimeout(loaderMaxTimer),!(loaderShownAt==null||leaving)&&hidePill(Math.max(0,LOADER_MIN_MS-(performance.now()-loaderShownAt)))}let LEAVING_MAX_MS=1e4,leaving=!1,leavingTimer=null;function stayed(){leaving&&(leaving=!1,clearTimeout(leavingTimer),hidePill())}addEventListener("beforeunload",event=>{firstRender||pullRefreshing||(leaving=!0,showPill(),clearTimeout(leavingTimer),leavingTimer=setTimeout(stayed,LEAVING_MAX_MS),setTimeout(()=>{(event.defaultPrevented||typeof event.returnValue=="string"&&event.returnValue!=="")&&stayed()}))}),addEventListener("pageshow",event=>{event.persisted&&stayed()});for(let type of["pointerdown","keydown"])addEventListener(type,stayed,!0);Margin.content.onCard(win=>{for(let type of["pointerdown","keydown"])win.addEventListener(type,stayed,!0)});let TRANSITION_PILL_MS=150,watchTransitions=navigation=>navigation?.addEventListener?.("navigate",()=>{setTimeout(()=>{let transition=navigation.transition;if(!transition?.finished||firstRender)return;let done=!1,shownAt=null,timer=setTimeout(()=>{done||leaving||(shownAt=performance.now(),showPill())},TRANSITION_PILL_MS),finish=()=>{done=!0,clearTimeout(timer),shownAt!=null&&!leaving&&hidePill(Math.max(0,LOADER_MIN_MS-(performance.now()-shownAt)))};transition.finished.then(finish,finish)})});watchTransitions(globalThis.navigation),Margin.content.onCard(win=>watchTransitions(win.navigation));let pullRefreshing=!1,pullStuckTimer=null,pullEnabled=()=>!replacing&&state?.settings?.blockGestures!==!1&&state?.settings?.pullToRefresh!==!1;function showPull({state:phase,progress}){if(!pullRefreshing){if(phase==="trigger")return refreshFromPull();if(phase==="idle"){pull.classList.remove("tracking","armed"),pull.style.removeProperty("--pull");return}pull.classList.add("tracking"),pull.classList.toggle("armed",phase==="armed"),pull.style.setProperty("--pull",String(Math.min(progress,1.2)))}}function refreshFromPull(){pullRefreshing=!0,pull.classList.remove("tracking"),pull.classList.add("armed","refreshing"),pull.style.setProperty("--pull","1"),host.dataset.pullRefresh="true",setTimeout(()=>{location.reload();for(let target of[window,Margin.shell?.card].filter(Boolean))for(let type of["pointerdown","keydown"])target.addEventListener(type,resetPull,{capture:!0,once:!0})},300),pullStuckTimer=setTimeout(resetPull,1e4)}function resetPull(){pullRefreshing&&(pullRefreshing=!1,clearTimeout(pullStuckTimer),pull.classList.remove("armed","refreshing","tracking"),pull.style.removeProperty("--pull"),delete host.dataset.pullRefresh)}addEventListener("pageshow",event=>{event.persisted&&resetPull()});let swipeEnabled=()=>!replacing&&state?.settings?.blockGestures!==!1&&state?.settings?.swipeNavigation!==!1,swipeHideTimer=null;function showSwipe({state:phase,progress,direction}){if(phase==="trigger")return navigateBySwipe(direction);if(phase==="idle"||!direction){swipe.classList.remove("active","tracking","armed"),swipe.style.removeProperty("--swipe");return}clearTimeout(swipeHideTimer),swipe.classList.add("active","tracking"),swipe.classList.toggle("forward",direction>0),swipe.classList.toggle("armed",phase==="armed"),swipe.style.setProperty("--swipe",String(Math.min(progress,1)))}function navigateBySwipe(direction){swipe.classList.remove("tracking"),swipe.classList.add("active","armed"),swipe.classList.toggle("forward",direction>0),swipe.style.setProperty("--swipe","1"),host.dataset.swipe=direction>0?"forward":"back",direction>0?history.forward():history.back(),clearTimeout(swipeHideTimer),swipeHideTimer=setTimeout(()=>showSwipe({state:"idle"}),450)}addEventListener("pageshow",event=>{event.persisted&&showSwipe({state:"idle"})});let nav=globalThis.navigation,historyAllows=dx=>!dx||typeof nav?.canGoBack!="boolean"?!0:dx<0?nav.canGoBack:nav.canGoForward;if(gestureGuard){let pullTracker=createPullTracker(),swipeTracker=createSwipeTracker(),endTimer=null,watchWheel=(win,doc)=>win.addEventListener("wheel",event=>{if(event.ctrlKey)return;let path=event.composedPath(),usable=event.deltaMode===0&&!path.some(node=>node===host||node.localName==="margin-palette-host"),wheel={deltaY:event.deltaY,deltaX:event.deltaX,time:event.timeStamp},pulling=pullEnabled()&&!pullRefreshing,swiping=swipeEnabled();pulling&&showPull(pullTracker.wheel({...wheel,eligible:usable&&atPageTop(event,doc)})),swiping&&showSwipe(swipeTracker.wheel({...wheel,eligible:usable&&historyAllows(event.deltaX)&&canSwipe(event,doc)})),!(!pulling&&!swiping)&&(clearTimeout(endTimer),endTimer=setTimeout(()=>{pulling&&showPull(pullTracker.end()),swiping&&showSwipe(swipeTracker.end())},DEFAULTS.GAP_MS+20))},{capture:!0,passive:!0});watchWheel(window,document),Margin.content.onCard(win=>watchWheel(win,win.document))}let pageZoom=1,pinchStart=1,pinchMoved=!1,zoomHudTimer=null,readZoom=()=>send("getZoom",{},!1).then(z=>Number.isFinite(z)?z:null);gestureGuard&&readZoom().then(z=>{z&&(pageZoom=z)});function showZoomHud(){clearTimeout(zoomHudTimer),zoomHud.textContent=`${Math.round(pageZoom*100)}%`,zoomHud.classList.add("show"),host.dataset.zoom=String(pageZoom)}function handlePinch({phase,scale}){if(phase==="start")return pinchStart=pageZoom,pinchMoved=!1,readZoom().then(z=>{z&&!pinchMoved&&(pinchStart=pageZoom=z)}),showZoomHud();if(phase==="change"){let zoom=zoomForPinch(pinchStart,scale);return zoom!==pageZoom&&(pageZoom=zoom,pinchMoved=!0,send("setZoom",{factor:zoom},!1)),showZoomHud()}zoomHudTimer=setTimeout(()=>zoomHud.classList.remove("show"),700)}let pushCss=width=>`@media screen {
    html {
      margin-left: ${width}px !important;
      margin-right: ${FRAME_PX}px !important;
      width: auto !important;
      overflow-x: hidden !important;
    }
  }`,canPush=document.documentElement instanceof HTMLHtmlElement,pushed=!1,pushedWidth=null,pushSheet=null,pushStyle=null;function setPushed(on,width=sidebar3.width()){if(!(!canPush||Margin.shell||on===pushed&&(!on||width===pushedWidth))){if(pushed=on,pushedWidth=on?width:null,"adoptedStyleSheets"in document&&typeof CSSStyleSheet.prototype.replaceSync=="function"){pushSheet??=new CSSStyleSheet,pushSheet.replaceSync(pushCss(width));let others=document.adoptedStyleSheets.filter(s=>s!==pushSheet);document.adoptedStyleSheets=on?[...others,pushSheet]:others}else on?(pushStyle??=document.createElement("style"),pushStyle.textContent=pushCss(width),pushStyle.isConnected||document.documentElement.appendChild(pushStyle)):pushStyle?.remove();host.dataset.pushed=String(on)}}function syncPlaceholder(){let html=document.documentElement;!canPush||html.dataset.marginDocked==="off"||getComputedStyle(html,"::after").content!=="none"&&(html.dataset.marginDocked="off",placeholderTookOver=!0)}function show(why){clearTimeout(hideTimer),hideTimer=null,(!reason||reason==="peek"||why==="toggle")&&(reason=why),setOpen(!0)}function hide(){clearTimeout(hideTimer),hideTimer=null,reason=null,setOpen(pinnedOpen())}function scheduleHide(){reason!=="hover"||hideTimer||sidebar3.isBusy()||(hideTimer=setTimeout(hide,HIDE_DELAY_MS))}let lastToggle=0;function toggle(){let now=Date.now();if(!(now-lastToggle<200))return lastToggle=now,pinnedOpen()?(state={...state,settings:{...state.settings,sidebarPinnedOpen:!1}},send("updateSettings",{patch:{sidebarPinnedOpen:!1}}),hide()):reason?hide():show("toggle")}Margin.content.sidebar={show,hide,toggle},Margin.content.uiBusy=()=>sidebar3.isBusy()||!!Margin.content.paletteOpen?.();let peekTimer=null;function peek(){pinnedOpen()||reason&&reason!=="peek"||(show("peek"),clearTimeout(peekTimer),peekTimer=setTimeout(()=>reason==="peek"&&hide(),1200))}installNavigation({send,getSettings:()=>state?.settings}),Margin.content.onCard(win=>installNavigation({send,getSettings:()=>state?.settings,target:win})),Margin.content.peek=peek;let watchToggleKey=win=>win.addEventListener("keydown",e=>{!e.isTrusted||!matches(e,state?.settings?.sidebarShortcut??"Alt+KeyS")||(e.preventDefault(),e.stopImmediatePropagation(),toggle())},!0);watchToggleKey(window),Margin.content.onCard(watchToggleKey);function watchPointer(target,offsetX=()=>0){target.addEventListener("mousemove",e=>{let x=e.clientX+offsetX();x<=edgePx()?show("hover"):x>sidebar3.width()+FRAME_PX?scheduleHide():hideTimer&&sidebar3.el.classList.contains("open")&&(clearTimeout(hideTimer),hideTimer=null)},{capture:!0,passive:!0}),target.addEventListener("mouseout",e=>{!e.relatedTarget&&e.clientX+offsetX()>edgePx()&&scheduleHide()}),target.addEventListener("keydown",e=>{e.key==="Escape"&&reason==="toggle"&&hide()},!0),target.addEventListener("mousedown",e=>{reason==="toggle"&&e.target!==host&&hide()},!0)}watchPointer(document),Margin.content.onCard(win=>watchPointer(win,()=>Margin.shell?.cardLeft()??0));let tabId=null,helloWindowId=null,windowId=null;function render(){state&&(windowId=state.tabs?.[tabId]?.windowId??helloWindowId??guessWindow(state,location.href),sidebar3.update(state,{windowId,tabId}),Margin.content.onState?.(state,{tabId,windowId}),reason||setOpen(pinnedOpen()),updateGestureGuards(),firstRender&&(firstRender=!1,startLoader(),timing.rendered=Math.round(performance.now()),requestAnimationFrame(()=>requestAnimationFrame(()=>{sidebar3.el.classList.remove("instant"),frame.classList.remove("instant"),cardEdge.classList.remove("instant")}))))}let version=0;async function refresh(){let mine=++version,next=await api.storage.local.get(null);timing.storage??=Math.round(performance.now()),!(mine!==version||!next.spaces?.length)&&(state=next,render())}Margin.content.getState=()=>({state,tabId,windowId}),api.storage.onChanged.addListener((_,area)=>area==="local"&&refresh());function logTiming(){let nav2=performance.getEntriesByType?.("navigation")?.[0],fmt=n=>n==null?"–":`${Math.round(n)}`;console.debug(`[margin] timing (ms) injected=${fmt(timing.injected)} storage=${fmt(timing.storage)} rendered=${fmt(timing.rendered)} | page DOMContentLoaded=${fmt(nav2?.domContentLoadedEventStart)} load=${fmt(nav2?.loadEventStart)} keepOpen=${pinnedOpen()} fitted=${!!Margin.shell}`)}document.readyState==="complete"?setTimeout(logTiming):addEventListener("load",()=>setTimeout(logTiming),{once:!0}),refresh(),send("hello").then(ctx=>{ctx&&(tabId=ctx.tabId,Margin.content.instanceId=ctx.instanceId,helloWindowId=ctx.windowId,render())});let reportedIcon=null;function reportIcon(){if(!platform?.fetchFavicons)return;let links=[...document.querySelectorAll("link[rel]")].map(l=>({rel:l.rel,href:l.href,sizes:l.getAttribute("sizes")??"",type:l.type})),href=pickIconHref(links,location.href);!href||href===reportedIcon||(reportedIcon=href,send("pageIcon",{href}))}return document.readyState==="loading"?document.addEventListener("DOMContentLoaded",reportIcon,{once:!0}):reportIcon(),addEventListener("load",reportIcon,{once:!0}),Margin.content.onCard(win=>win.addEventListener("load",()=>setTimeout(reportIcon),{once:!0})),api.runtime.onMessage.addListener((message,_,sendResponse)=>{if(message?.type==="ping")return sendResponse("pong");message?.type==="command"&&(message.command==="toggle-sidebar"?Margin.content.sidebar.toggle():message.command==="peek"?Margin.content.peek?.():Margin.content.onCommand?.(message.command))}),!0}var SAFARI_ENGINES={google:{name:"Google",host:/^www\.google(\.[a-z]{2,3}){1,2}$/,path:/^\/search$/,fromSafari:p=>p.get("client")==="safari",template:host=>`https://${host}/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8`},bing:{name:"Bing",host:/^www\.bing\.com$/,path:/^\/search$/,fromSafari:p=>/^AP/.test(p.get("form")??""),template:host=>`https://${host}/search?q=%s&form=APMCS1&PC=APMC`},duckduckgo:{name:"DuckDuckGo",host:/^duckduckgo\.com$/,path:/^\/$/,fromSafari:p=>["osx","iphone","ipad"].includes(p.get("t")),template:host=>`https://${host}/?q=%s&t=osx&ia=web`},ecosia:{name:"Ecosia",host:/^www\.ecosia\.org$/,path:/^\/search$/,fromSafari:p=>(p.get("tts")??"").startsWith("st_asaf_"),template:host=>`https://${host}/search?q=%s&tts=st_asaf_macos`},yahoo:{name:"Yahoo",host:/^([a-z]{2,10}\.)?search\.yahoo(\.[a-z]{2,3}){1,2}$/,path:/^\/search(;[^/]*)?$/,fromSafari:p=>/^(aapl|iphone$|ipad$)/.test(p.get("fr")??"")||p.get(".tsrc")==="apple",template:host=>`https://${host}/search?ei=utf-8&fr=aaplw&p=%s`}},SAFARI_DEFAULT=Object.freeze({id:"google",name:"Google",template:SAFARI_ENGINES.google.template("www.google.com")});var safariEngine=settings=>settings?.safariSearch?.template?.includes("%s")?settings.safariSearch:SAFARI_DEFAULT;var engineLabel=(settings,platform2=platform)=>platform2?.search==="browser"?"Chrome’s search engine":safariEngine(settings).name,WITH_SCHEME=/^(https?|file|ftp):\/\//i,OPAQUE_SCHEME=/^(about|data|mailto|view-source):/i,LOCAL=/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i,DOMAIN=/^([a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(:\d+)?([/?#]\S*)?$/i;function resolveInput(text){let input=(text??"").trim();if(!input)return null;if(WITH_SCHEME.test(input)||OPAQUE_SCHEME.test(input))return{kind:"url",url:input};if(!/\s/.test(input)){if(LOCAL.test(input))return{kind:"url",url:`http://${input}`};if(DOMAIN.test(input))return{kind:"url",url:`https://${input}`}}return{kind:"search",query:input}}var isWordStart=(text,i)=>i===0||/[\s\-_./:]/.test(text[i-1]);function fuzzyScore(query,text){let q=query.toLowerCase(),t=(text??"").toLowerCase();if(!q)return 0;let at=t.indexOf(q);if(at>=0)return 100+(at===0?40:0)+(isWordStart(t,at)?20:0)+q.length*2-at*.1-t.length*.01;let score=0,from=0,prev=-2;for(let ch of q){let found=t.indexOf(ch,from);if(found<0)return-1/0;score+=(found===prev+1?5:1)+(isWordStart(t,found)?3:0),prev=found,from=found+1}return score-t.length*.01}function matchScore(query,item){let total=0;for(let token of query.split(/\s+/).filter(Boolean)){let best=Math.max(fuzzyScore(token,item.title),fuzzyScore(token,item.subtitle)-10);if(best===-1/0)return-1/0;total+=best}return total}var isWebUrl=url=>/^https?:/i.test(url??"");function paletteItems(state,ctx){let view=view_exports,spaceId=view.activeSpaceId(state,ctx.windowId),spaceOf=id=>state.spaces.find(s=>s.id===id),items=[];for(let t of Object.values(state.tabs??{})){let space=spaceOf(state.tabSpace?.[t.id]);items.push({id:`tab:${t.id}`,kind:"tab",title:t.title||t.url||"New Tab",subtitle:t.url,url:t.url,favIconUrl:iconFor(state,t),badge:space?.name??"",boost:(space?.id===spaceId?30:10)+(t.id===ctx.tabId?-25:0),recency:t.lastActive??0,action:{type:"activateTab",tabId:t.id}})}for(let p of state.pins??[]){let space=spaceOf(p.spaceId);items.push({id:`pin:${p.id}`,kind:"pin",title:p.title,subtitle:p.url,url:p.url,favIconUrl:iconFor(state,p),badge:space?.name??"Pinned",boost:p.spaceId===spaceId?20:8,action:{type:"openPin",pinId:p.id,windowId:ctx.windowId}})}for(let a of state.archive??[])items.push({id:`archive:${a.id}`,kind:"archive",title:a.title||a.url,subtitle:a.url,url:a.url,favIconUrl:iconFor(state,a),badge:"Archived",boost:0,recency:a.closedAt??0,action:{type:"restoreArchive",archiveId:a.id,windowId:ctx.windowId}});let action=(id,title,act,extra={})=>items.push({id:`action:${id}`,kind:"action",title,subtitle:"",boost:12,action:act,...extra}),current=state.tabs?.[ctx.tabId],currentSpace=state.tabSpace?.[ctx.tabId];current&&isWebUrl(current.url)&&!state.pins.some(p=>p.spaceId===currentSpace&&view.normalizeUrl(p.url)===view.normalizeUrl(current.url))&&action("pin-current","Pin current tab",{type:"pinTab",tabId:ctx.tabId},{emoji:"📌"}),action("new-window","New window",{type:"newWindow"},{emoji:"⧉"}),ctx.inNewTab||action("launcher","Margin start page & settings",{type:"openLauncher",windowId:ctx.windowId},{emoji:"⚙︎"}),ctx.canToggleSidebar&&action("toggle-sidebar","Toggle sidebar",{local:"toggleSidebar"},{emoji:"◧"});let origin=current&&isWebUrl(current.url)?view.originOf(current.url):null;origin&&ctx.canFit&&state.settings?.sidebarPinnedOpen&&state.settings?.fitPages!==!1&&((state.settings.fitPagesExcept??[]).includes(origin)?action("fit-site","Fit this site beside the sidebar again",{type:"setFitSite",origin,fit:!0},{emoji:"▣"}):ctx.fitted&&action("unfit-site","Show this site without fitting it beside the sidebar",{type:"setFitSite",origin,fit:!1},{emoji:"▢"}));for(let s of state.spaces)s.id!==spaceId&&action(`space:${s.id}`,`Switch to space ${s.name}`,{type:"setSpace",windowId:ctx.windowId,spaceId:s.id},{emoji:s.emoji});return items}var KIND_ORDER={tab:0,action:1,pin:2,archive:3};function rankPalette(state,query,ctx,limit=40){let q=(query??"").trim(),items=paletteItems(state,ctx),ranked;q?ranked=items.map(item=>({item,score:matchScore(q,item)})).filter(r=>r.score>-1/0).map(r=>({...r,score:r.score+r.item.boost})).sort((a,b)=>b.score-a.score||(b.item.recency??0)-(a.item.recency??0)).map(r=>r.item):ranked=items.filter(i=>i.kind!=="archive"&&i.id!==`tab:${ctx.tabId}`).sort((a,b)=>KIND_ORDER[a.kind]-KIND_ORDER[b.kind]||b.boost-a.boost||(b.recency??0)-(a.recency??0)),ranked=ranked.slice(0,limit);let target=resolveInput(q);if(target){let isUrl=target.kind==="url",go={id:"go",kind:"go",title:isUrl?`Open ${target.url}`:`Search for “${q}”`,badge:isUrl?"Open":"Search",subtitle:isUrl?"":engineLabel(state.settings),emoji:isUrl?"↗":"⌕",action:isUrl?ctx.inNewTab?{local:"navigate",url:target.url}:{type:"newTab",windowId:ctx.windowId,url:target.url}:ctx.inNewTab?{local:"search",query:target.query}:{type:"search",query:target.query,windowId:ctx.windowId}};target.kind==="url"?ranked.unshift(go):ranked.push(go)}return ranked}var SVG_NS="http://www.w3.org/2000/svg";function icon(paths,cls){let svg=document.createElementNS(SVG_NS,"svg");svg.setAttribute("viewBox","0 0 24 24"),svg.setAttribute("aria-hidden","true"),svg.setAttribute("class",cls);for(let d of paths){let path=document.createElementNS(SVG_NS,"path");path.setAttribute("d",d),svg.append(path)}return svg}var searchIcon=()=>icon(["M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z","M15.5 15.5 20 20"],"search-icon"),arrowIcon=()=>icon(["M5 12h13","M13 6l6 6-6 6"],"arrow-icon"),GOES=new Set(["tab","pin","archive","go"]);function createPalette({send,getState,getContext,onLocal,theme}){let host=null,panel,input,list,items=[],selected=0,open=!1,restoreFocus=null;function build(){host=createHost(document,"margin-palette-host");let shadow=host.attachShadow({mode:"closed"});adoptStyles(shadow,palette),input=el(document,"input",{type:"text",class:"query",placeholder:"Search or Enter URL…","aria-label":"Command palette",spellcheck:"false",autocomplete:"off",role:"combobox","aria-expanded":"true","aria-controls":"margin-results"}),list=el(document,"ul",{class:"results",id:"margin-results",role:"listbox"}),panel=el(document,"div",{class:"palette",role:"dialog","aria-label":"Margin command palette"},el(document,"div",{class:"search"},searchIcon(),input),list);let backdrop=el(document,"div",{class:"backdrop"});shadow.append(backdrop,panel);for(let node of[backdrop,panel])containScroll(node);backdrop.addEventListener("mousedown",e=>{e.preventDefault(),close()}),input.addEventListener("input",()=>{selected=0,refresh()});for(let type of["keydown","keyup","keypress"])panel.addEventListener(type,e=>e.stopPropagation());input.addEventListener("keydown",e=>{if(!e.isComposing){if(e.key==="ArrowDown"||e.key==="n"&&e.ctrlKey)move(1);else if(e.key==="ArrowUp"||e.key==="p"&&e.ctrlKey)move(-1);else if(e.key==="Enter")run(items[selected]);else if(e.key==="Escape")close();else return;e.preventDefault()}}),list.addEventListener("mousemove",e=>{let row=e.target.closest("[data-index]");row&&Number(row.dataset.index)!==selected&&(selected=Number(row.dataset.index),paintSelection())}),list.addEventListener("mousedown",e=>e.preventDefault()),list.addEventListener("click",e=>{let row=e.target.closest("[data-index]");row&&run(items[Number(row.dataset.index)])})}function move(delta){items.length&&(selected=(selected+delta+items.length)%items.length,paintSelection())}function paintSelection(){for(let row of list.children){let on=Number(row.dataset.index)===selected;row.setAttribute("aria-selected",String(on)),on&&row.scrollIntoView({block:"nearest"})}}function refresh(){let state=getState();state&&(items=rankPalette(state,input.value,getContext()),selected=Math.min(selected,Math.max(items.length-1,0)),list.replaceChildren(...items.map((item,index)=>el(document,"li",{role:"option","data-index":String(index),"data-id":item.id,class:item.kind,title:item.subtitle||item.title},item.emoji?el(document,"span",{class:"avatar emoji",text:item.emoji}):avatar(document,item),el(document,"span",{class:"title",text:item.title}),item.badge?el(document,"span",{class:"badge",text:item.badge}):null,GOES.has(item.kind)?el(document,"span",{class:"go-button"},arrowIcon()):null))),items.length||list.append(el(document,"li",{class:"empty",text:"No matches"})),paintSelection())}function run(item){if(!item)return;if(close(),item.action.local)return onLocal?.(item.action);let{type,...payload}=item.action;send(type,payload)}function show(){if(host||build(),host.isConnected||document.documentElement.appendChild(host),typeof host.showPopover=="function"&&!siteModalOpen(document)){host.hasAttribute("popover")||host.setAttribute("popover","manual");try{host.matches(":popover-open")||host.showPopover()}catch{}}restoreFocus=document.activeElement;let state=getState(),ctx=getContext(),spaceId=state?activeSpaceId(state,ctx.windowId):null,color=state?.spaces?.find(s=>s.id===spaceId)?.color;color&&panel.style.setProperty("--space-color",color),host.dataset.open="true",open=!0,input.value="",selected=0,refresh(),input.focus()}function close(){if(!open)return;open=!1,host.dataset.open="false";try{host.matches?.(":popover-open")&&host.hidePopover()}catch{}input.blur();let shell=globalThis.Margin?.shell;shell?.card&&(!restoreFocus?.isConnected||restoreFocus===document.body)?shell.focusCard():restoreFocus?.isConnected&&restoreFocus.focus?.({preventScroll:!0})}let lastToggle=0;function toggle(){let now=Date.now();now-lastToggle<200||(lastToggle=now,open?close():show())}return{open:show,close,toggle,isOpen:()=>open,refresh:()=>open&&refresh()}}function installShortcut(palette2,getShortcut,target=globalThis){target.addEventListener("keydown",e=>{matches(e,getShortcut())&&(e.preventDefault(),e.stopImmediatePropagation(),palette2.toggle())},!0)}function wirePalette(c){let palette2=createPalette({send:c.send,getState:()=>c.getState().state,getContext:()=>({...c.getState(),canToggleSidebar:!0,canFit:!!platform?.shell,fitted:!!globalThis.Margin.shell}),onLocal:action=>action.local==="toggleSidebar"&&c.sidebar.toggle(),theme:c.theme}),paletteKey=()=>c.getState().state?.settings?.paletteShortcut??"Alt+KeyK";installShortcut(palette2,paletteKey),c.onCard?.(win=>installShortcut(palette2,paletteKey,win)),c.onCommand=command=>{command==="open-palette"&&palette2.toggle(),command==="show-palette"&&palette2.open()},c.openPalette=()=>palette2.open(),c.paletteOpen=()=>palette2.isOpen();let prev=c.onState;c.onState=(...args)=>{prev?.(...args),palette2.refresh()}}startSidebar()&&wirePalette(globalThis.Margin.content);})();
