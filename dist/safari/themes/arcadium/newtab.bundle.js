var __defProp=Object.defineProperty;var __export=(target,all)=>{for(var name in all)__defProp(target,name,{get:all[name],enumerable:!0})};var PROFILES={safari:{name:"safari",fetchFavicons:!0,blockGestures:!0,search:"learn",shell:!0,shellPageWrite:!1,marginFullscreen:!1,navigation:{nextTab:"Alt+Meta+ArrowDown",prevTab:"Alt+Meta+ArrowUp",nextSpace:"Ctrl+Meta+ArrowRight",prevSpace:"Ctrl+Meta+ArrowLeft"}},chrome:{name:"chrome",fetchFavicons:!1,blockGestures:!1,search:"browser",shell:!0,shellPageWrite:!0,marginFullscreen:!0,navigation:{nextTab:"Ctrl+Meta+ArrowDown",prevTab:"Ctrl+Meta+ArrowUp",nextSpace:"Ctrl+Meta+ArrowRight",prevSpace:"Ctrl+Meta+ArrowLeft"}}},BUILD_TARGET="safari",detect=()=>{try{return(globalThis.browser??globalThis.chrome)?.runtime?.getURL?.("").startsWith("safari-web-extension:")?"safari":"chrome"}catch{return"chrome"}},platform=PROFILES[BUILD_TARGET??detect()];(globalThis.Margin??={}).platform=platform;var FRAME_AWARE=["teams.microsoft.com","teams.cloud.microsoft","teams.live.com","outlook.office.com","outlook.office365.com","outlook.cloud.microsoft","outlook.live.com","office.com","m365.cloud.microsoft","sharepoint.com","login.microsoftonline.com","login.live.com","login.microsoft.com","accounts.google.com","docs.google.com","claude.ai"];function frameAware(url){let host;try{host=new URL(url).hostname}catch{return!1}return FRAME_AWARE.some(d=>host===d||host.endsWith(`.${d}`))}var FRAME_AWARE_PATTERNS=FRAME_AWARE.flatMap(d=>[`*://${d}/*`,`*://*.${d}/*`]);var view_exports={};__export(view_exports,{activeSpaceId:()=>activeSpaceId,cycleSpace:()=>cycleSpace,cycleTab:()=>cycleTab,guessWindow:()=>guessWindow,iconFor:()=>iconFor,isNewTabPage:()=>isNewTabPage,normalizeUrl:()=>normalizeUrl,originOf:()=>originOf,pickIconHref:()=>pickIconHref,revealZone:()=>revealZone,sidebar:()=>sidebar});function normalizeUrl(url){try{let u=new URL(url),path=u.pathname==="/"?"":u.pathname;return`${u.protocol}//${u.host}${path}${u.search}`}catch{return url??""}}function activeSpaceId(state,windowId){let id=state.activeSpaceByWindow?.[windowId];return state.spaces.some(s=>s.id===id)?id:state.spaces[0].id}function sidebar(state,windowId,currentTabId=null,{newTabPending=!1}={}){let spaceId=activeSpaceId(state,windowId),known=currentTabId!=null&&state.tabs?.[currentTabId]?.windowId===windowId,windowTabs=Object.values(state.tabs??{}).filter(t=>t.windowId===windowId).map(t=>known&&t.active!==(t.id===currentTabId)?{...t,active:t.id===currentTabId}:t).map(t=>newTabPending&&t.active?{...t,active:!1,behind:!0}:t).sort((a,b)=>a.index-b.index),spaceTabs=windowTabs.filter(t=>state.tabSpace[t.id]===spaceId),pins=state.pins.filter(p=>p.spaceId===spaceId).map(p=>{let key=normalizeUrl(p.url),tab=spaceTabs.find(t=>normalizeUrl(t.url)===key);return{...p,tabId:tab?.id??null,active:!!tab?.active,behind:!!tab?.behind,favIconUrl:tab?.favIconUrl??""}}),pinnedUrls=new Set(pins.map(p=>normalizeUrl(p.url))),shownNewTab=windowTabs.find(t=>t.active&&isNewTabPage(t.url));return{spaceId,spaces:state.spaces,pins,newTab:{active:newTabPending||!!shownNewTab},tabs:spaceTabs.filter(t=>!pinnedUrls.has(normalizeUrl(t.url))&&t!==shownNewTab).reverse()}}var NEW_TAB_PAGE=/^(chrome:\/\/newtab\/?|[a-z-]+-extension:\/\/[^/]+\/newtab\/newtab\.html)(\?[^#]*)?$/i,isNewTabPage=url=>NEW_TAB_PAGE.test(String(url??""));function guessWindow(state,url){let tabs=Object.values(state.tabs??{});if(new Set(tabs.map(t=>t.windowId)).size<=1)return tabs[0]?.windowId??null;let byUrl=tabs.filter(t=>t.url===url),pool=byUrl.length?byUrl:tabs.filter(t=>t.active);return pool.sort((a,b)=>Number(b.active)-Number(a.active)||(b.lastActive??0)-(a.lastActive??0)),pool[0]?.windowId??null}var EDGE_PX=10,FULLSCREEN_EDGE_PX=24;function revealZone({outerWidth,outerHeight,screenWidth,screenHeight}){return outerWidth>=screenWidth&&outerHeight>=screenHeight?FULLSCREEN_EDGE_PX:EDGE_PX}function cycleTab(state,windowId,currentTabId,dir){let v=sidebar(state,windowId,currentTabId),order=[...v.pins.filter(p=>p.tabId!=null).map(p=>p.tabId),...v.tabs.map(t=>t.id)];if(!order.length)return null;let at=order.indexOf(currentTabId);if(at<0)return dir>0?order[0]:order[order.length-1];let next=order[(at+dir+order.length)%order.length];return next===currentTabId?null:next}function cycleSpace(state,windowId,dir){if(state.spaces.length<2)return null;let at=state.spaces.findIndex(s=>s.id===activeSpaceId(state,windowId));return state.spaces[(at+dir+state.spaces.length)%state.spaces.length].id}function originOf(url){try{let u=new URL(url);return/^https?:$/.test(u.protocol)?u.origin:null}catch{return null}}function pickIconHref(links,pageUrl){let origin=originOf(pageUrl);if(!origin)return null;let usable=href=>/^https?:/i.test(href??"")||/^data:image\//i.test(href??""),score=l=>{let rel=(l.rel??"").toLowerCase().split(/\s+/);if(!rel.some(r=>r==="icon"||r==="apple-touch-icon"||r==="apple-touch-icon-precomposed")||!usable(l.href))return-1;if(!rel.includes("icon"))return 1;let sizes=(l.sizes??"").toLowerCase();if((l.type??"").includes("svg")||sizes==="any")return 5;let px=Math.max(0,...[...sizes.matchAll(/(\d+)x\d+/g)].map(m=>Number(m[1])));return px>=16&&px<=64?4:px?2:3},best=links.map(l=>({l,s:score(l)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s)[0];return best?best.l.href:`${origin}/favicon.ico`}function iconFor(state,item){if(/^(https?|data):/.test(item?.favIconUrl??""))return item.favIconUrl;let origin=originOf(item?.url);return origin&&state?.favicons?.[origin]?.data||""}var SAFARI_ENGINES={google:{name:"Google",host:/^www\.google(\.[a-z]{2,3}){1,2}$/,path:/^\/search$/,fromSafari:p=>p.get("client")==="safari",template:host=>`https://${host}/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8`},bing:{name:"Bing",host:/^www\.bing\.com$/,path:/^\/search$/,fromSafari:p=>/^AP/.test(p.get("form")??""),template:host=>`https://${host}/search?q=%s&form=APMCS1&PC=APMC`},duckduckgo:{name:"DuckDuckGo",host:/^duckduckgo\.com$/,path:/^\/$/,fromSafari:p=>["osx","iphone","ipad"].includes(p.get("t")),template:host=>`https://${host}/?q=%s&t=osx&ia=web`},ecosia:{name:"Ecosia",host:/^www\.ecosia\.org$/,path:/^\/search$/,fromSafari:p=>(p.get("tts")??"").startsWith("st_asaf_"),template:host=>`https://${host}/search?q=%s&tts=st_asaf_macos`},yahoo:{name:"Yahoo",host:/^([a-z]{2,10}\.)?search\.yahoo(\.[a-z]{2,3}){1,2}$/,path:/^\/search(;[^/]*)?$/,fromSafari:p=>/^(aapl|iphone$|ipad$)/.test(p.get("fr")??"")||p.get(".tsrc")==="apple",template:host=>`https://${host}/search?ei=utf-8&fr=aaplw&p=%s`}},SAFARI_DEFAULT=Object.freeze({id:"google",name:"Google",template:SAFARI_ENGINES.google.template("www.google.com")});var safariEngine=settings=>settings?.safariSearch?.template?.includes("%s")?settings.safariSearch:SAFARI_DEFAULT;var engineLabel=(settings,platform2=platform)=>platform2?.search==="browser"?"Chrome’s search engine":safariEngine(settings).name,WITH_SCHEME=/^(https?|file|ftp):\/\//i,OPAQUE_SCHEME=/^(about|data|mailto|view-source):/i,LOCAL=/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i,DOMAIN=/^([a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(:\d+)?([/?#]\S*)?$/i;function resolveInput(text){let input=(text??"").trim();if(!input)return null;if(WITH_SCHEME.test(input)||OPAQUE_SCHEME.test(input))return{kind:"url",url:input};if(!/\s/.test(input)){if(LOCAL.test(input))return{kind:"url",url:`http://${input}`};if(DOMAIN.test(input))return{kind:"url",url:`https://${input}`}}return{kind:"search",query:input}}var isWordStart=(text,i)=>i===0||/[\s\-_./:]/.test(text[i-1]);function fuzzyScore(query,text){let q=query.toLowerCase(),t=(text??"").toLowerCase();if(!q)return 0;let at=t.indexOf(q);if(at>=0)return 100+(at===0?40:0)+(isWordStart(t,at)?20:0)+q.length*2-at*.1-t.length*.01;let score=0,from=0,prev=-2;for(let ch of q){let found=t.indexOf(ch,from);if(found<0)return-1/0;score+=(found===prev+1?5:1)+(isWordStart(t,found)?3:0),prev=found,from=found+1}return score-t.length*.01}function matchScore(query,item){let total=0;for(let token of query.split(/\s+/).filter(Boolean)){let best=Math.max(fuzzyScore(token,item.title),fuzzyScore(token,item.subtitle)-10);if(best===-1/0)return-1/0;total+=best}return total}var isWebUrl=url=>/^https?:/i.test(url??"");function paletteItems(state,ctx){let view=view_exports,spaceId=view.activeSpaceId(state,ctx.windowId),spaceOf=id=>state.spaces.find(s=>s.id===id),items=[];for(let t of Object.values(state.tabs??{})){let space=spaceOf(state.tabSpace?.[t.id]);items.push({id:`tab:${t.id}`,kind:"tab",title:t.title||t.url||"New Tab",subtitle:t.url,url:t.url,favIconUrl:iconFor(state,t),badge:space?.name??"",boost:(space?.id===spaceId?30:10)+(t.id===ctx.tabId?-25:0),recency:t.lastActive??0,action:{type:"activateTab",tabId:t.id}})}for(let p of state.pins??[]){let space=spaceOf(p.spaceId);items.push({id:`pin:${p.id}`,kind:"pin",title:p.title,subtitle:p.url,url:p.url,favIconUrl:iconFor(state,p),badge:space?.name??"Pinned",boost:p.spaceId===spaceId?20:8,action:{type:"openPin",pinId:p.id,windowId:ctx.windowId}})}for(let a of state.archive??[])items.push({id:`archive:${a.id}`,kind:"archive",title:a.title||a.url,subtitle:a.url,url:a.url,favIconUrl:iconFor(state,a),badge:"Archived",boost:0,recency:a.closedAt??0,action:{type:"restoreArchive",archiveId:a.id,windowId:ctx.windowId}});let action=(id,title,act,extra={})=>items.push({id:`action:${id}`,kind:"action",title,subtitle:"",boost:12,action:act,...extra}),current=state.tabs?.[ctx.tabId],currentSpace=state.tabSpace?.[ctx.tabId];current&&isWebUrl(current.url)&&!state.pins.some(p=>p.spaceId===currentSpace&&view.normalizeUrl(p.url)===view.normalizeUrl(current.url))&&action("pin-current","Pin current tab",{type:"pinTab",tabId:ctx.tabId},{emoji:"📌"}),action("new-window","New window",{type:"newWindow"},{emoji:"⧉"}),ctx.inNewTab||action("launcher","Margin start page & settings",{type:"openLauncher",windowId:ctx.windowId},{emoji:"⚙︎"}),ctx.canToggleSidebar&&action("toggle-sidebar","Toggle sidebar",{local:"toggleSidebar"},{emoji:"◧"}),ctx.canFullscreen&&action("fullscreen","Margin full screen (no toolbar) on/off",{type:"toggleFullscreen",windowId:ctx.windowId},{emoji:"⛶"});let origin=current&&isWebUrl(current.url)&&!frameAware(current.url)?view.originOf(current.url):null;origin&&ctx.canFit&&state.settings?.sidebarPinnedOpen&&state.settings?.fitPages!==!1&&((state.settings.fitPagesExcept??[]).includes(origin)?action("fit-site","Fit this site beside the sidebar again",{type:"setFitSite",origin,fit:!0},{emoji:"▣"}):ctx.fitted&&action("unfit-site","Show this site without fitting it beside the sidebar",{type:"setFitSite",origin,fit:!1},{emoji:"▢"}));for(let s of state.spaces)s.id!==spaceId&&action(`space:${s.id}`,`Switch to space ${s.name}`,{type:"setSpace",windowId:ctx.windowId,spaceId:s.id},{emoji:s.emoji});return items}var KIND_ORDER={tab:0,action:1,pin:2,archive:3};function rankPalette(state,query,ctx,limit=40){let q=(query??"").trim(),items=paletteItems(state,ctx),ranked;q?ranked=items.map(item=>({item,score:matchScore(q,item)})).filter(r=>r.score>-1/0).map(r=>({...r,score:r.score+r.item.boost})).sort((a,b)=>b.score-a.score||(b.item.recency??0)-(a.item.recency??0)).map(r=>r.item):ranked=items.filter(i=>i.kind!=="archive"&&i.id!==`tab:${ctx.tabId}`).sort((a,b)=>KIND_ORDER[a.kind]-KIND_ORDER[b.kind]||b.boost-a.boost||(b.recency??0)-(a.recency??0)),ranked=ranked.slice(0,limit);let target=resolveInput(q);if(target){let isUrl=target.kind==="url",go={id:"go",kind:"go",title:isUrl?`Open ${target.url}`:`Search for “${q}”`,badge:isUrl?"Open":"Search",subtitle:isUrl?"":engineLabel(state.settings),emoji:isUrl?"↗":"⌕",action:isUrl?ctx.inNewTab?{local:"navigate",url:target.url}:{type:"newTab",windowId:ctx.windowId,url:target.url}:ctx.inNewTab?{local:"search",query:target.query}:{type:"search",query:target.query,windowId:ctx.windowId}};target.kind==="url"?ranked.unshift(go):ranked.push(go)}return ranked}var MODIFIERS=["Ctrl","Alt","Shift","Meta"],MOD_CODES=/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/,KEY_CODES=/^(Key[A-Z]|Digit\d|F\d{1,2}|Arrow(Up|Down|Left|Right)|Space|Enter|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;function parse(text){let parts=String(text??"").split("+").map(p=>p.trim()).filter(Boolean),code=parts.pop();if(!code||!KEY_CODES.test(code))return null;let mods=new Set(parts);return!mods.size||[...mods].some(m=>!MODIFIERS.includes(m))?null:{ctrl:mods.has("Ctrl"),alt:mods.has("Alt"),shift:mods.has("Shift"),meta:mods.has("Meta"),code}}function matches(event,text){let s=parse(text);return!!s&&event.code===s.code&&event.ctrlKey===s.ctrl&&event.altKey===s.alt&&event.shiftKey===s.shift&&event.metaKey===s.meta}function fromEvent(event){if(MOD_CODES.test(event.code)||!KEY_CODES.test(event.code))return null;let mods=[event.ctrlKey&&"Ctrl",event.altKey&&"Alt",event.shiftKey&&"Shift",event.metaKey&&"Meta"].filter(Boolean);return mods.length?[...mods,event.code].join("+"):null}var SYMBOLS={Ctrl:"⌃",Alt:"⌥",Shift:"⇧",Meta:"⌘"};function format(text){let s=parse(text);if(!s)return"";let key={ArrowUp:"↑",ArrowDown:"↓",ArrowLeft:"←",ArrowRight:"→"}[s.code]??s.code.replace(/^Key|^Digit/,"").replace(/^Slash$/,"/").replace(/^Period$/,".").replace(/^Space$/,"Space");return MODIFIERS.filter(m=>s[m.toLowerCase()]).map(m=>SYMBOLS[m]).join("")+key}var NAVIGATION={...(platform??PROFILES.chrome).navigation},navigationFor=settings=>({...NAVIGATION,...settings?.shortcuts}),ACTIONS={nextTab:"next-tab",prevTab:"prev-tab",nextSpace:"next-space",prevSpace:"prev-space"};function installNavigation({send,getSettings,target=globalThis}){target.addEventListener("keydown",event=>{let settings=getSettings();if(settings===null)return;let keys=navigationFor(settings),name=Object.keys(keys).find(n=>matches(event,keys[n]));name&&(event.preventDefault(),event.stopImmediatePropagation(),!(event.repeat&&name.endsWith("Space"))&&send("navigate",{action:ACTIONS[name]}))},!0)}var AXES={x:{size:"Width",pos:"scrollLeft",overflow:"overflowX"},y:{size:"Height",pos:"scrollTop",overflow:"overflowY"}};function canScroll(node,axis,delta,scrollingElement){let a=AXES[axis],max=node[`scroll${a.size}`]-node[`client${a.size}`];if(max<=1||!delta)return!1;let style=getComputedStyle(node),overflow=style[a.overflow];if(node===scrollingElement?overflow==="hidden"||overflow==="clip":overflow!=="auto"&&overflow!=="scroll")return!1;let[lo,hi]=axis==="x"&&style.direction==="rtl"?[-max,0]:[0,max];return delta<0?node[a.pos]>lo+.5:node[a.pos]<hi-.5}function somethingScrolls(event,axis,{doc,stopAt=null}={}){let delta=axis==="x"?event.deltaX:event.deltaY,scrollingElement=doc?doc.scrollingElement??doc.documentElement:null;for(let node of event.composedPath()){if(node.nodeType===1&&canScroll(node,axis,delta,scrollingElement))return!0;if(node===stopAt)return!1}return!!scrollingElement&&canScroll(scrollingElement,axis,delta,scrollingElement)}function containScroll(el2){el2.addEventListener("wheel",event=>{if(!event.cancelable||event.ctrlKey)return;let axis=Math.abs(event.deltaX)>Math.abs(event.deltaY)?"x":"y";somethingScrolls(event,axis,{stopAt:el2})||event.preventDefault()},{passive:!1})}var NO_BOUNCE_CSS=":root { overscroll-behavior-y: none !important; }";function installGestureGuard({getSettings,onPinch=()=>{},win=globalThis.window}){if(!win)return{update(){}};let doc=win.document,enabled=()=>getSettings()?.blockGestures!==!1,zoomedIn=()=>(win.visualViewport?.scale??1)>1.01;win.addEventListener("wheel",event=>{if(!(!enabled()||!event.cancelable)){if(event.ctrlKey){event.deltaY>0&&!zoomedIn()&&event.preventDefault();return}Math.abs(event.deltaX)<=Math.abs(event.deltaY)||somethingScrolls(event,"x",{doc})||event.preventDefault()}},{capture:!0,passive:!1});let ours=!1,options={capture:!0,passive:!1};win.addEventListener("gesturestart",event=>{ours=enabled()&&!zoomedIn(),ours&&(event.preventDefault(),onPinch({phase:"start",scale:1}))},options),win.addEventListener("gesturechange",event=>{ours&&(event.preventDefault(),Number.isFinite(event.scale)&&onPinch({phase:"change",scale:event.scale}))},options),win.addEventListener("gestureend",event=>{ours&&(ours=!1,event.preventDefault(),onPinch({phase:"end",scale:event.scale}))},options);let sheet=null,style=null;function update(){let on=enabled();if(doc?.adoptedStyleSheets&&typeof win.CSSStyleSheet?.prototype.replaceSync=="function"){sheet||(sheet=new win.CSSStyleSheet,sheet.replaceSync(NO_BOUNCE_CSS));let others=doc.adoptedStyleSheets.filter(s=>s!==sheet),has=others.length!==doc.adoptedStyleSheets.length;on!==has&&(doc.adoptedStyleSheets=on?[...others,sheet]:others)}else doc?.documentElement&&(on&&!style?.isConnected?(style??=Object.assign(doc.createElement("style"),{textContent:NO_BOUNCE_CSS}),doc.documentElement.appendChild(style)):on||style?.remove())}return update(),{update}}function el(doc,tag,attrs={},...children){let node=doc.createElement(tag);for(let[key,value]of Object.entries(attrs))value==null||value===!1||(key==="class"?node.className=value:key==="text"?node.textContent=value:key==="style"?node.style.cssText=value:node.setAttribute(key,value===!0?"":value));for(let child of children.flat())child&&node.append(child);return node}function adoptStyles(shadow,css){if("adoptedStyleSheets"in shadow&&typeof CSSStyleSheet.prototype.replaceSync=="function"){let sheet=new CSSStyleSheet;sheet.replaceSync(css),shadow.adoptedStyleSheets=[...shadow.adoptedStyleSheets,sheet]}else{let style=shadow.ownerDocument.createElement("style");style.textContent=css,shadow.prepend(style)}}function createHost(doc,tag){let host=doc.createElement(tag);for(let[prop,value]of Object.entries({all:"initial",position:"fixed",top:"0",left:"0",width:"0",height:"0","z-index":"2147483647"}))host.style.setProperty(prop,value,"important");return host}function siteModalOpen(doc){try{return!!doc.querySelector(":modal")}catch{return!1}}function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,"")}catch{return""}}function installShortcut(palette,getShortcut,target=globalThis){target.addEventListener("keydown",e=>{matches(e,getShortcut())&&(e.preventDefault(),e.stopImmediatePropagation(),palette.toggle())},!0)}var SHOWS_ANOTHER_TAB=new Set(["activateTab","newTab","openPin","restoreArchive","search","openLauncher"]);function newTabCloser(setPending,doc=document){let cancel=()=>{};return{onClose:(reason,action)=>{if(cancel(),reason!=="run"||!action||action.local||!SHOWS_ANOTHER_TAB.has(action.type))return setPending(!1);let done=()=>{cancel(),setPending(!1)},onHidden=()=>doc.hidden&&done(),timer=setTimeout(done,1500);doc.addEventListener("visibilitychange",onHidden),cancel=()=>{clearTimeout(timer),doc.removeEventListener("visibilitychange",onHidden),cancel=()=>{}}},cancel:()=>cancel()}}var WIDTH=Object.freeze({min:160,max:500,default:260,step:10}),clampWidth=w=>Math.min(WIDTH.max,Math.max(WIDTH.min,Number.isFinite(w)?w:WIDTH.default)),snapWidth=w=>clampWidth(Math.round(clampWidth(w)/WIDTH.step)*WIDTH.step);var defaults=Object.freeze({sidebarWidth:WIDTH.default});function settingsOf(settings){let own=settings?.themes?.arcadium,stored=own&&typeof own=="object"?own:{},width=stored.sidebarWidth??settings?.sidebarWidth??defaults.sidebarWidth;return{...defaults,...stored,sidebarWidth:snapWidth(Number(width))}}var sidebarWidth=settings=>settingsOf(settings).sidebarWidth,theme_default=Object.freeze({id:"arcadium",name:"Arcadium",description:"Arc’s look: a frame around the page, space chips, pins and tabs.",defaults,settingsOf,content:"themes/arcadium/content.bundle.js",newtab:"themes/arcadium/newtab.bundle.js",placeholder:settings=>`themes/arcadium/docked/w-${sidebarWidth(settings)}.css`,railPlaceholder:"themes/arcadium/docked/rail.css"});var THEMES=Object.freeze({[theme_default.id]:theme_default}),DEFAULT_THEME=theme_default.id,themeFor=settings=>THEMES[settings?.theme]??THEMES[DEFAULT_THEME];function hue(text){let h=0;for(let ch of text)h=(h*31+ch.codePointAt(0))%360;return h}function avatar(doc,{title,url,favIconUrl}){let label=hostOf(url)||title||"?",letter=el(doc,"span",{class:"avatar letter",text:label.charAt(0).toUpperCase(),style:`background: hsl(${hue(label)} 55% 48%)`,"aria-hidden":"true"});if(!favIconUrl||!/^(https?|data):/.test(favIconUrl))return letter;let img=el(doc,"img",{class:"avatar",src:favIconUrl,alt:"",referrerpolicy:"no-referrer"});return img.addEventListener("error",()=>img.replaceWith(letter),{once:!0}),img}var SPACE_COLORS=["#6c5ce7","#0984e3","#00b894","#fdcb6e","#e17055","#d63031","#e84393","#636e72"],TAB_MIME="application/x-margin-tab";function createSidebar({document:doc,send,mode,onNewTab,onWidth,onScroll}){let chips=el(doc,"nav",{class:"spaces","aria-label":"Spaces"}),nameInput=el(doc,"input",{class:"name",type:"text",placeholder:"Space name","aria-label":"Space name",maxlength:"40"}),emojiInput=el(doc,"input",{class:"emoji",type:"text","aria-label":"Space emoji",maxlength:"8"}),swatches=el(doc,"div",{class:"swatches",role:"radiogroup","aria-label":"Space color"},SPACE_COLORS.map(c=>el(doc,"button",{type:"button",class:"swatch","data-color":c,title:c,style:`--chip-color: ${c}`,role:"radio"}))),deleteButton=el(doc,"button",{type:"button",class:"delete","data-editor":"delete",text:"Delete"}),editor=el(doc,"form",{class:"editor",hidden:!0,"aria-label":"Edit space"},el(doc,"div",{class:"row"},emojiInput,nameInput),swatches,el(doc,"div",{class:"row actions"},deleteButton,el(doc,"span",{class:"spacer"}),el(doc,"button",{type:"button","data-editor":"cancel",text:"Cancel"}),el(doc,"button",{type:"submit",class:"primary",text:"Save"}))),pins=el(doc,"ul",{class:"pins","aria-label":"Pinned"}),tabs=el(doc,"ul",{class:"tabs","aria-label":"Tabs"}),tabsSection=el(doc,"section",{class:"tabs-section"},tabs),keepOpen=el(doc,"button",{class:"keep-open","data-action":"keep-open",title:"Keep the sidebar open"}),fitSite=el(doc,"button",{class:"fit-site","data-action":"fit-site",hidden:!0}),footer=mode==="overlay"?el(doc,"footer",{},el(doc,"span",{class:"spacer"}),fitSite,keepOpen):null,root=el(doc,"aside",{class:`margin-sidebar ${mode}`,"aria-label":"Margin"},chips,editor,el(doc,"section",{class:"pins-section"},pins),el(doc,"div",{class:"divider"}),tabsSection,footer);containScroll(root);let settingScroll=!1;tabsSection.addEventListener("scroll",()=>{settingScroll?settingScroll=!1:onScroll?.(tabsSection.scrollTop)},{passive:!0});let resizer=el(doc,"div",{class:"resizer",title:"Drag to resize · double-click to reset","aria-hidden":"true"});root.append(resizer);let resizing=null,saveWidth=sidebarWidth2=>send("updateThemeSettings",{themeId:"arcadium",patch:{sidebarWidth:sidebarWidth2}}),setWidth=px=>root.style.setProperty("--width",`${px}px`);resizer.addEventListener("pointerdown",event=>{if(event.button!==0)return;event.preventDefault(),event.stopPropagation(),resizer.setPointerCapture?.(event.pointerId);let startWidth=root.getBoundingClientRect().width;resizing={startX:event.clientX,startWidth,width:startWidth},root.classList.add("resizing")}),resizer.addEventListener("pointermove",event=>{resizing&&(resizing.width=clampWidth(resizing.startWidth+event.clientX-resizing.startX),setWidth(resizing.width),onWidth?.(resizing.width,{done:!1}))});let endResize=()=>{if(!resizing)return;let width=snapWidth(resizing.width);resizing=null,root.classList.remove("resizing"),setWidth(width),onWidth?.(width,{done:!0}),saveWidth(width)};resizer.addEventListener("pointerup",endResize),resizer.addEventListener("pointercancel",endResize),resizer.addEventListener("lostpointercapture",endResize),resizer.addEventListener("dblclick",event=>{event.stopPropagation();let width=WIDTH.default;setWidth(width),onWidth?.(width,{done:!0}),saveWidth(width)});let state=null,windowId=null,currentTabId=null,pendingEdit=null,fit=null,newTabPending=!1;function render(){if(!state||windowId==null)return;let view=sidebar(state,windowId,currentTabId,{newTabPending});root.style.setProperty("--space-color",view.spaces.find(s=>s.id===view.spaceId)?.color??""),resizing||setWidth(sidebarWidth(state.settings)),chips.replaceChildren(...view.spaces.map(s=>el(doc,"button",{class:`chip${s.id===view.spaceId?" active":""}`,"data-action":"set-space","data-space-id":s.id,title:s.name,"aria-pressed":String(s.id===view.spaceId),style:`--chip-color: ${s.color}`,text:s.emoji})),el(doc,"button",{class:"chip add","data-action":"add-space",title:"New space",text:"+"})),pins.replaceChildren(...view.pins.map(p=>el(doc,"li",{class:`pin${p.active?" active":""}${p.behind?" behind":""}${p.tabId?" open":""}`,"data-action":"open-pin","data-pin-id":p.id,title:p.title},avatar(doc,{...p,favIconUrl:iconFor(state,p)}),el(doc,"span",{class:"title",text:p.title}),el(doc,"button",{class:"icon unpin","data-action":"unpin","data-pin-id":p.id,title:"Unpin",text:"×"}))));let newTabRow=el(doc,"li",{class:`new-tab-row${view.newTab.active?" active":""}`,"data-action":"new-tab",title:"New Tab",role:"button","aria-label":"New Tab","aria-current":view.newTab.active?"page":null},el(doc,"span",{class:"plus","aria-hidden":"true",text:"+"}),el(doc,"span",{class:"title",text:"New Tab"}));tabs.replaceChildren(newTabRow,...view.tabs.map(t=>el(doc,"li",{class:`tab${t.active?" active":""}${t.behind?" behind":""}`,"data-action":"activate","data-tab-id":String(t.id),title:t.title||t.url,draggable:"true"},avatar(doc,{...t,favIconUrl:iconFor(state,t)}),el(doc,"span",{class:"title",text:t.title||t.url||"New Tab"}),el(doc,"button",{class:"icon close","data-action":"close","data-tab-id":String(t.id),title:"Close tab",text:"×"}))));let pinned=!!state.settings?.sidebarPinnedOpen;keepOpen.replaceChildren(el(doc,"span",{class:"icon-only",text:pinned?"⇤":"⇥"}),el(doc,"span",{class:"label",text:pinned?" Auto-hide":" Keep open"})),keepOpen.title=pinned?"Auto-hide the sidebar":"Keep the sidebar open",keepOpen.setAttribute("aria-label",keepOpen.title),keepOpen.setAttribute("aria-pressed",String(pinned));let excepted=!!fit?.origin&&(state.settings?.fitPagesExcept??[]).includes(fit.origin);fitSite.hidden=!(pinned&&fit?.fittable&&state.settings?.fitPages!==!1&&(fit.fitted||excepted)),fitSite.textContent=fit?.fitted?"▢":"▣",fitSite.title=fit?.fitted?"Show this site normally (not fitted beside the sidebar)":"Fit this site beside the sidebar again",fitSite.setAttribute("aria-label",fitSite.title)}let openOverPage=()=>mode==="overlay"&&root.classList.contains("open")&&(!root.classList.contains("docked")||root.classList.contains("rail-expanded"));root.addEventListener("click",event=>{let target=event.target.closest("[data-action]");if(!target||!root.contains(target)||(event.stopPropagation(),event.ctrlKey&&target.closest(".tab, .pin")))return;let tabId=Number(target.dataset.tabId),{pinId,spaceId}=target.dataset,show=openOverPage();switch(target.dataset.action){case"activate":return send("activateTab",{tabId,...show?{show}:{}});case"close":return send("closeTab",{tabId,...show?{show}:{}});case"open-pin":return send("openPin",{pinId,windowId,...show?{show}:{}});case"unpin":return send("unpin",{pinId});case"set-space":return send("setSpace",{windowId,spaceId});case"new-tab":return onNewTab?onNewTab():send("newTab",{windowId});case"add-space":return send("createSpace",{windowId}).then(res=>{res?.spaceId&&(state?.spaces.some(s=>s.id===res.spaceId)?openEditor(res.spaceId):pendingEdit=res.spaceId)});case"fit-site":return fit?.origin&&send("setFitSite",{origin:fit.origin,fit:!fit.fitted});case"keep-open":return send("updateSettings",{patch:{sidebarPinnedOpen:!state?.settings?.sidebarPinnedOpen}})}});let editing=null;function openEditor(spaceId){if(root.classList.contains("rail"))return;let space=state?.spaces.find(s=>s.id===spaceId);space&&(editing={spaceId,color:space.color,confirmDelete:!1},nameInput.value=space.name,emojiInput.value=space.emoji,editor.hidden=!1,renderEditor(),nameInput.focus(),nameInput.select())}function closeEditor(){editing=null,editor.hidden=!0}function renderEditor(){if(!editing)return;for(let sw of swatches.children)sw.setAttribute("aria-checked",String(sw.dataset.color===editing.color));let only=(state?.spaces.length??0)<2;deleteButton.disabled=only,deleteButton.title=only?"The last space can’t be deleted":"Tabs and pins move to the first space",deleteButton.textContent=editing.confirmDelete?"Really delete?":"Delete"}editor.addEventListener("submit",event=>{event.preventDefault(),editing&&(send("renameSpace",{spaceId:editing.spaceId,name:nameInput.value,emoji:emojiInput.value,color:editing.color}),closeEditor())}),editor.addEventListener("click",event=>{event.stopPropagation();let swatch=event.target.closest(".swatch");if(swatch&&editing)return editing.color=swatch.dataset.color,renderEditor();let action=event.target.closest("[data-editor]")?.dataset.editor;if(action==="cancel"&&closeEditor(),action==="delete"&&editing){if(!editing.confirmDelete)return editing.confirmDelete=!0,renderEditor();send("deleteSpace",{spaceId:editing.spaceId}),closeEditor()}}),editor.addEventListener("keydown",event=>{event.key==="Escape"&&closeEditor()}),chips.addEventListener("contextmenu",event=>{let chip=event.target.closest(".chip[data-space-id]");!chip||root.classList.contains("rail")||(event.preventDefault(),openEditor(chip.dataset.spaceId))}),chips.addEventListener("dblclick",event=>{let chip=event.target.closest(".chip[data-space-id]");chip&&openEditor(chip.dataset.spaceId)});let menu=el(doc,"div",{class:"tab-menu",role:"menu",tabindex:"-1",hidden:!0});root.append(menu);let menuPopover=typeof menu.showPopover=="function";menuPopover&&menu.setAttribute("popover","manual");let menuFor=null,menuItem=(label,action,data={})=>el(doc,"button",{class:"menu-item",role:"menuitem","data-menu":action,...data,text:label});function openMenu(row,x,y){let tabId=row.dataset.tabId?Number(row.dataset.tabId):null,pin=row.dataset.pinId?state?.pins.find(p=>p.id===row.dataset.pinId):null;if(tabId==null&&!pin)return;let items=[];if(pin){menuFor={pinId:pin.id},items.push(menuItem("Unpin","unpin"));let openTab=sidebar(state,windowId,currentTabId).pins.find(p=>p.id===pin.id)?.tabId;openTab!=null&&items.push(el(doc,"div",{class:"menu-separator",role:"separator"}),menuItem("Close Tab","close",{"data-tab-id":String(openTab)}))}else{menuFor={tabId},items.push(menuItem("Pin Tab","pin"));let spaceId=state?.tabSpace?.[tabId],others=(state?.spaces??[]).filter(sp=>sp.id!==spaceId);if(others.length){items.push(el(doc,"div",{class:"menu-separator",role:"separator"}));for(let sp of others)items.push(menuItem(`Move to ${sp.emoji} ${sp.name}`,"move",{"data-space-id":sp.id}))}items.push(el(doc,"div",{class:"menu-separator",role:"separator"}),menuItem("Close Tab","close",{"data-tab-id":String(tabId)}))}menu.replaceChildren(...items),menu.hidden=!1;let inTopLayer=!1;if(menuPopover&&!siteModalOpen(doc))try{menu.matches(":popover-open")||menu.showPopover(),inTopLayer=!0}catch{}if(menu.classList.toggle("top-layer",inTopLayer),inTopLayer){let view=doc.defaultView;menu.style.left=`${Math.max(4,Math.min(x,view.innerWidth-menu.offsetWidth-4))}px`,menu.style.top=`${Math.max(4,Math.min(y,view.innerHeight-menu.offsetHeight-4))}px`}else{let box=root.getBoundingClientRect();menu.style.left=`${Math.max(4,Math.min(x-box.left,box.width-menu.offsetWidth-4))}px`,menu.style.top=`${Math.max(4,Math.min(y-box.top,box.height-menu.offsetHeight-4))}px`}menu.focus({preventScroll:!0})}function closeMenu(){if(!menu.hidden){try{menuPopover&&menu.matches(":popover-open")&&menu.hidePopover()}catch{}menu.hidden=!0,menuFor=null}}root.addEventListener("contextmenu",event=>{let row=event.target.closest(".tab, .pin");if(!row||!root.contains(row))return closeMenu();event.preventDefault(),event.stopPropagation(),openMenu(row,event.clientX,event.clientY)}),menu.addEventListener("click",event=>{event.stopPropagation();let item=event.target.closest(".menu-item");if(!item||!menuFor)return;let target=menuFor;switch(closeMenu(),item.dataset.menu){case"pin":return send("pinTab",{tabId:target.tabId});case"unpin":return send("unpin",{pinId:target.pinId});case"move":return send("moveTabToSpace",{tabId:target.tabId,spaceId:item.dataset.spaceId});case"close":return send("closeTab",{tabId:Number(item.dataset.tabId),...openOverPage()?{show:!0}:{}})}}),menu.addEventListener("pointerover",event=>event.target.closest(".menu-item")?.focus({preventScroll:!0})),menu.addEventListener("pointerleave",()=>menu.focus({preventScroll:!0})),menu.addEventListener("keydown",event=>{if(event.key==="Escape")return closeMenu(),globalThis.Margin?.shell?.focusCard();if(event.key!=="ArrowDown"&&event.key!=="ArrowUp")return;event.preventDefault();let items=[...menu.querySelectorAll(".menu-item")],at=items.indexOf(menu.getRootNode().activeElement),step=event.key==="ArrowDown"?1:-1;items[(at+step+items.length)%items.length]?.focus()}),root.addEventListener("pointerdown",event=>{!menu.hidden&&!menu.contains(event.target)&&closeMenu()},!0),doc.addEventListener("pointerdown",event=>{let inSidebar=root.contains(event.target)||event.target===root.getRootNode().host;!menu.hidden&&!inSidebar&&closeMenu()},!0),doc.defaultView?.addEventListener("blur",closeMenu);for(let type of["keydown","keyup","keypress"])root.addEventListener(type,e=>e.stopPropagation());let draggingTabId=null;tabs.addEventListener("dragstart",event=>{let row=event.target.closest(".tab");row&&(draggingTabId=Number(row.dataset.tabId),event.dataTransfer.setData(TAB_MIME,row.dataset.tabId),event.dataTransfer.effectAllowed="move")}),tabs.addEventListener("dragend",()=>{draggingTabId=null;for(let c of chips.querySelectorAll(".drop-target"))c.classList.remove("drop-target")});let chipFor=event=>draggingTabId==null?null:event.target.closest?.(".chip[data-space-id]");return chips.addEventListener("dragover",event=>{let chip=chipFor(event);chip&&(event.preventDefault(),event.dataTransfer.dropEffect="move",chip.classList.add("drop-target"))}),chips.addEventListener("dragleave",event=>chipFor(event)?.classList.remove("drop-target")),chips.addEventListener("drop",event=>{let chip=chipFor(event);chip&&(event.preventDefault(),chip.classList.remove("drop-target"),send("moveTabToSpace",{tabId:draggingTabId,spaceId:chip.dataset.spaceId}),draggingTabId=null)}),{el:root,isBusy:()=>editing!=null||draggingTabId!=null||resizing!=null||!menu.hidden,width:()=>resizing?resizing.width:sidebarWidth(state?.settings),update(nextState,context){if(context?.fit&&(fit=context.fit),context&&"newTabPending"in context&&(newTabPending=!!context.newTabPending),state=nextState,menuFor?.tabId!=null&&!state.tabs?.[menuFor.tabId]&&closeMenu(),menuFor?.pinId&&!state.pins?.some(p=>p.id===menuFor.pinId)&&closeMenu(),context?.windowId!=null&&(windowId=context.windowId),context?.tabId!=null&&(currentTabId=context.tabId),render(),Number.isFinite(context?.scroll)){let before=tabsSection.scrollTop;settingScroll=!0,tabsSection.scrollTop=context.scroll,tabsSection.scrollTop===before&&(settingScroll=!1)}pendingEdit&&state.spaces.some(s=>s.id===pendingEdit)&&(openEditor(pendingEdit),pendingEdit=null),editing&&!state.spaces.some(s=>s.id===editing.spaceId)&&closeEditor(),renderEditor()},setColorScheme(scheme){root.dataset.theme=scheme}}}var newtabCss=`:root {
  --bg: #f6f5fa;
  --fg: #1d1b26;
  --muted: #6e6a7c;
  --card: #ffffff;
  --border: rgba(0, 0, 0, 0.08);
  --accent: #6c5ce7;
  --frame: #9c9da1; /* same fixed sidebar color as content/sidebar.css */
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #18171d; --fg: #ecebf2; --muted: #9a97a8; --card: #24232b; --border: rgba(255, 255, 255, 0.08); }
}
html, body { height: 100%; margin: 0; }
/* Same Arc-style layout as the overlay: sidebar and frame are one surface,
   the launcher is the page card inside it. #page-card lies over the
   launcher (same grid cell, above the sidebar) and draws the card's shadow,
   so it also falls on the sidebar's edge. Radius and shadow as in
   content/sidebar.css. */
body {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: 100vh;
  background: var(--frame);
  color: var(--fg);
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
#sidebar { grid-area: 1 / 1; height: 100vh; }
#launcher, #page-card { grid-area: 1 / 2; margin: 8px 8px 8px 0; }
#launcher, #page-card { border-radius: 6.25px; }
#launcher {
  min-width: 0;
  overflow-y: auto;
  background: var(--bg);
}
#page-card {
  position: relative;
  z-index: 1;
  pointer-events: none;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.24), 0 0 3px rgba(0, 0, 0, 0.06);
}

#launcher {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
  padding: 18vh 32px 48px;
  box-sizing: border-box;
}
#launcher > * { width: min(640px, 100%); }
#query {
  box-sizing: border-box;
  width: 100%;
  height: 52px;
  padding: 0 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--card);
  color: var(--fg);
  font: inherit;
  font-size: 17px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
  outline: none;
}
#query:focus { border-color: var(--accent); }
h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
ul { list-style: none; margin: 0; padding: 0; }
#pin-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 12px; }
.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 8px 12px;
  border-radius: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  cursor: pointer;
}
.tile:hover { border-color: var(--accent); }
.tile .avatar { width: 32px; height: 32px; border-radius: 8px; object-fit: contain; }
.tile .avatar.letter { display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 600; font-size: 16px; }
.tile .title { width: 100%; text-align: center; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#archive-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  cursor: pointer;
}
#archive-list li:hover { background: var(--card); }
#archive-list .avatar { width: 16px; height: 16px; border-radius: 4px; }
#archive-list .avatar.letter { display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; font-weight: 600; }
#archive-list .title { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#archive-list .when { color: var(--muted); font-size: 12px; }
#settings { color: var(--muted); font-size: 13px; }
#settings summary { cursor: pointer; }
#settings label { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 10px; }
#settings select, #settings input { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 4px 8px; }
#settings input[type="checkbox"] { flex: none; width: auto; padding: 0; margin: 0; accent-color: var(--accent); }
#settings .help { margin: 6px 0 0; font-size: 12px; }
.shortcut-input { width: 120px; text-align: center; cursor: pointer; }
.shortcut-input.recording { border-color: var(--accent); }
#shortcuts { border: 0; margin: 10px 0 0; padding: 0; min-width: 0; }
#shortcuts legend { padding: 0; margin-bottom: 2px; }
#shortcuts-reset { margin-top: 8px; font: inherit; color: var(--muted); background: none; border: 1px solid var(--border); border-radius: 8px; padding: 3px 10px; cursor: pointer; }
#shortcut-help.error { color: #d63031; }
#archive-hours { width: 72px; }
#archive-more { margin-top: 6px; padding: 4px 10px; border: 0; border-radius: 8px; background: none; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
#archive-more:hover { background: var(--card); color: var(--fg); }

/* Outside full screen, when Margin is used only there (Chrome). */
#fullscreen-note { max-width: 440px; margin: 22vh auto 0; padding: 28px; border-radius: 12px; background: var(--card); color: var(--fg); text-align: center; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }
#fullscreen-note h1 { margin: 0 0 8px; font-size: 20px; }
#fullscreen-note p { margin: 0 0 18px; color: var(--muted); }
#fullscreen-note .actions { display: flex; gap: 8px; justify-content: center; }
#fullscreen-note button { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
#fullscreen-note button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
`,paletteCss=`/* Arc-style command bar: a dark, translucent panel centered on the window,
   a third of the way down; one-line rows with the space name and an arrow
   button; the selected row takes the current space's color. Sizes measured
   from Tirth's Arc screenshot (14" display, 1pt = 1px; DECISIONS.md): 765
   wide, five rows tall, the top 306 below the window's top in a 949-high
   window. English and laid out as Arc's on every page, right-to-left too. */
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
  top: 32.25vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(765px, calc(100vw - 32px));
  /* Five rows, as Arc (border, search, list padding, rows and the gaps
     between them); more scroll, the selection followed. */
  --rows: 5;
  max-height: calc(2px + 63px + 6px + var(--rows) * 46px + (var(--rows) - 1) * 4px + 10.4px);
  direction: ltr;
  flex-direction: column;
  box-sizing: border-box;
  background: rgba(36, 32, 36, 0.86);
  backdrop-filter: blur(28px) saturate(1.5);
  -webkit-backdrop-filter: blur(28px) saturate(1.5);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45), 0 0 0 0.5px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.palette *, .palette *::before, .palette *::after { box-sizing: border-box; }
/* Short windows: higher up, then fewer whole rows (never half of one). */
@media (max-height: 507px) { .palette { top: 18vh; } }
@media (max-height: 418px) { .palette { --rows: 4; } }
@media (max-height: 357px) { .palette { --rows: 3; } }

/* 62 high above a divider inset from the sides; the magnifier (12 of ink)
   centered on the row icons' column, the text where the titles start. */
.search {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 11.5px;
  height: 63px;
  padding: 0 0 2.5px 22.5px; /* content a little above center, as Arc */
}
.search::after {
  content: "";
  position: absolute;
  left: 10.7px;
  right: 10.7px;
  bottom: 0;
  height: 1px;
  background: var(--border);
}
.search-icon {
  flex: none;
  width: 16px;
  height: 16px;
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
  font-size: 18.5px;
  outline: none;
}
.query::placeholder { color: var(--muted); }

.results {
  list-style: none;
  margin: 0;
  padding: 6px 8.5px 10.4px;
  overflow-y: auto;
  overscroll-behavior: none;
  scrollbar-width: none;
  scroll-padding: 6px 0 10.4px; /* the selection scrolled into view keeps the padding */
}
.results li {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 13px 0 10px;
  border-radius: 6px;
  cursor: default;
}
.results li + li { margin-top: 4px; }
.results li:hover { background: var(--row-hover); }
.results li[aria-selected="true"] {
  background: var(--space-color);
  background: color-mix(in srgb, var(--space-color) 82%, #000);
}
.results .empty { color: var(--muted); justify-content: center; }

/* Each icon fills a 24px slot: favicons 14px in it (on a white tile when
   selected, as Arc), letters on a 16px tile, emoji at 15px. */
.avatar { flex: none; width: 24px; height: 24px; border-radius: 4px; object-fit: contain; }
img.avatar { box-sizing: content-box; width: 14px; height: 14px; padding: 5px; }
[aria-selected="true"] img.avatar { background: #fff; }
.avatar.letter { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin: 0 4px; color: #fff; font-size: 10px; font-weight: 600; }
.avatar.emoji { display: inline-flex; align-items: center; justify-content: center; font-size: 15px; }
.title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; }
.badge { flex: none; margin-right: 0.5px; color: var(--muted); font-weight: 500; }
[aria-selected="true"] .badge { color: rgba(255, 255, 255, 0.92); }

.go-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
}
.arrow-icon { width: 18px; height: 18px; fill: none; stroke: var(--fg); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
[aria-selected="true"] .go-button { background: #f2f0e8; }
[aria-selected="true"] .arrow-icon { stroke: #1c1c1e; }
`,sidebarCss=`.margin-sidebar, .frame {
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

/* Keep open on a page Margin can't fit (pushed; content/layout.js): a narrow
   rail of icons, the page pushed only by its width. Resting the pointer on it
   expands the full sidebar over the page (.rail-expanded), which doesn't
   move; it folds back when the pointer leaves. Titles show as tooltips. */
.margin-sidebar.overlay.rail { width: var(--rail, 52px); padding: 10px 8px; }
.rail .title, .rail .icon, .rail .chip.add, .rail .editor, .rail .resizer, .rail .label, .rail .tab-menu:not(.top-layer) { display: none; }
.rail .chip { min-width: 0; width: 36px; padding: 0; }
.rail .tab, .rail .pin, .rail .new-tab-row { justify-content: center; gap: 0; padding: 0; }
.rail .keep-open { flex: none; width: 36px; padding: 0; text-align: center; }
.rail footer .spacer { display: none; }
/* Rail and expanded rail stack everything the same way, so expanding only
   widens the rows: nothing moves from under the pointer. Spaces and pins
   scroll on their own in a short window; the footer always shows. */
.rail .spaces, .rail-expanded .spaces { flex-direction: column; flex-wrap: nowrap; align-items: center; padding: 2px 0 6px; }
.rail-expanded .spaces { align-items: flex-start; }
.rail-expanded .chip.add { display: none; }
.rail .spaces, .rail .pins-section, .rail-expanded .spaces, .rail-expanded .pins-section { flex: 0 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: none; overscroll-behavior: none; }
.rail .divider, .rail-expanded .divider { margin: 2px 4px; }
.rail footer, .rail-expanded footer { flex: none; flex-direction: column; }
.rail footer { align-items: center; }
.rail-expanded footer { align-items: stretch; }
.rail .tabs-section, .rail-expanded .tabs-section { min-height: 64px; } /* a few tabs always show */
/* Above the page card's edge (.card-edge, drawn over the docked sidebar),
   which stays at the rail. */
.margin-sidebar.overlay.rail-expanded { z-index: 1; box-shadow: 0 0 0 1px var(--border), 0 12px 40px rgba(0, 0, 0, 0.22); }
.rail-expanded .resizer { display: none; } /* its width is the setting; the page stays at the rail */

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

.tab, .pin, .new-tab-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 6px 0 8px;
  border-radius: 8px;
  cursor: default;
}
.tab:hover, .pin:hover, .new-tab-row:hover { background: var(--hover); }
.tab.active, .pin.active, .new-tab-row.active { background: var(--active); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
/* While a new tab is being chosen (⌘T, "+ New Tab"): the tab whose page is
   still on screen under the palette, softly; "+ New Tab" fully. */
.tab.behind, .pin.behind { background: rgba(255, 255, 255, 0.28); }
/* "+ New Tab", the first row of the tab list (Arc). */
.new-tab-row { color: var(--muted); }
.new-tab-row.active { color: var(--fg); }
.new-tab-row .plus { flex: none; width: 16px; text-align: center; font-size: 16px; line-height: 16px; }
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
.keep-open { height: 30px; padding: 0 8px; border-radius: 8px; color: var(--muted); text-align: left; }
/* Narrow sidebars (down to 160px): one line, never wrap; below 230px the
   Keep open / Auto-hide button shows only its icon (full label on hover). */
.margin-sidebar { container-type: inline-size; }
.keep-open { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.keep-open { flex: none; }
.fit-site { flex: none; width: 30px; height: 30px; border-radius: 8px; color: var(--muted); font-size: 15px; }
.fit-site[hidden] { display: none; }
.fit-site:hover { background: var(--hover); color: var(--fg); }
@container (max-width: 229px) {
  .keep-open .label { display: none; }
}
.keep-open:hover { background: var(--hover); color: var(--fg); }

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

/* A notice near the left edge (content/core.js: "Margin works in full
   screen"), above the page, never in the way for long. */
.notice {
  position: fixed; top: 12px; left: 12px; z-index: 3;
  display: flex; align-items: center; gap: 8px; max-width: min(420px, calc(100vw - 24px));
  padding: 8px 8px 8px 12px; border-radius: 10px;
  background: rgba(28, 28, 30, 0.92); color: #fff; font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25); pointer-events: auto;
}
.notice[hidden] { display: none; }
.notice .text { flex: 1; }
.notice button { height: 26px; padding: 0 10px; border-radius: 7px; color: #fff; background: rgba(255, 255, 255, 0.12); white-space: nowrap; }
.notice button:hover { background: rgba(255, 255, 255, 0.2); }
.notice button.primary { background: #6c5ce7; }
.notice button.primary:hover { background: #7d6ff0; }
`,newtabHtml=`  <div id="sidebar"></div>
  <main id="launcher">
    <form id="search" role="search" autocomplete="off">
      <input id="query" name="q" type="text" placeholder="Search or enter address" aria-label="Search or enter address" autofocus spellcheck="false">
    </form>
    <section id="pins-section" hidden>
      <h2>Pinned</h2>
      <ul id="pin-tiles"></ul>
    </section>
    <section id="archive-section" hidden>
      <h2>Recently archived</h2>
      <ul id="archive-list"></ul>
      <button id="archive-more" type="button" hidden></button>
    </section>
    <details id="settings">
      <summary>Settings</summary>
      <label id="theme-setting">Theme
        <select id="theme"></select>
      </label>
      <p id="engine-info" class="help"></p>
      <label>Archive tabs not used for (hours, 0 = never)
        <input id="archive-hours" type="number" min="0" max="720" step="1">
      </label>
      <label id="gestures-setting" hidden>Use Margin's trackpad gestures instead of Safari's (pinch zooms the page; no all-tabs pinch, no bounce)
        <input id="block-gestures" type="checkbox" switch>
      </label>
      <label id="swipe-setting" hidden>Swipe sideways with two fingers to go back or forward
        <input id="swipe-navigation" type="checkbox" switch>
      </label>
      <label id="pull-setting" hidden>Pull down at the top of a page to reload
        <input id="pull-to-refresh" type="checkbox" switch>
      </label>
      <label id="fullscreen-setting" hidden>In full screen, hide Chrome’s toolbar (it otherwise shows on every tab change)
        <input id="margin-fullscreen" type="checkbox" switch>
      </label>
      <label id="fullscreen-only-setting" hidden>Use Margin only in full screen (in a window, it offers full screen instead)
        <input id="fullscreen-only" type="checkbox" switch>
      </label>
      <label id="fit-setting" hidden>With “Keep open”, fit pages beside the sidebar, laid out as in a narrower window
        <input id="fit-pages" type="checkbox" switch>
      </label>
      <label>With “Keep open”, on pages that can’t be fitted, show a narrow sidebar of icons (it opens fully when you rest the pointer on it)
        <input id="compact-pushed" type="checkbox" switch>
      </label>
      <fieldset id="shortcuts" aria-describedby="shortcut-help">
        <legend>Keyboard shortcuts</legend>
        <label>Command palette
          <input id="shortcut" class="shortcut-input" data-shortcut="paletteShortcut" type="text" readonly placeholder="Press keys…">
        </label>
        <label>Show or hide the sidebar
          <input class="shortcut-input" data-shortcut="sidebarShortcut" type="text" readonly placeholder="Press keys…">
        </label>
        <label>Next tab
          <input class="shortcut-input" data-shortcut="nextTab" type="text" readonly placeholder="Press keys…">
        </label>
        <label>Previous tab
          <input class="shortcut-input" data-shortcut="prevTab" type="text" readonly placeholder="Press keys…">
        </label>
        <label>Next space
          <input class="shortcut-input" data-shortcut="nextSpace" type="text" readonly placeholder="Press keys…">
        </label>
        <label>Previous space
          <input class="shortcut-input" data-shortcut="prevSpace" type="text" readonly placeholder="Press keys…">
        </label>
        <button id="shortcuts-reset" type="button">Reset shortcuts</button>
      </fieldset>
      <p id="shortcut-help" class="help">Click a field, then press a key with ⌘, ⌥, ⌃ or ⇧. Esc cancels. If a combination shows nothing when you press it, Safari or macOS keeps it for itself (⌘⌥← / ⌘⌥→ switch Safari's tabs), so pick another.</p>
    </details>
  </main>
  <div id="page-card" aria-hidden="true"></div>
`;var SVG_NS="http://www.w3.org/2000/svg";function icon(paths,cls){let svg=document.createElementNS(SVG_NS,"svg");svg.setAttribute("viewBox","0 0 24 24"),svg.setAttribute("aria-hidden","true"),svg.setAttribute("class",cls);for(let d of paths){let path=document.createElementNS(SVG_NS,"path");path.setAttribute("d",d),svg.append(path)}return svg}var searchIcon=()=>icon(["M10.5 3.3a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z","M15.6 15.6 19.5 19.5"],"search-icon"),arrowIcon=()=>icon(["M4.5 12h14.5","M12 4.5l7.5 7.5-7.5 7.5"],"arrow-icon"),GOES=new Set(["tab","pin","archive","go"]);function createPalette({send,getState,getContext,onLocal,colorScheme,onClose=void 0}){let host=null,panel,input,list,items=[],selected=0,open=!1,restoreFocus=null;function build(){host=createHost(document,"margin-palette-host");let shadow=host.attachShadow({mode:"closed"});adoptStyles(shadow,paletteCss),input=el(document,"input",{type:"text",class:"query",placeholder:"Search or Enter URL…","aria-label":"Command palette",spellcheck:"false",autocomplete:"off",role:"combobox","aria-expanded":"true","aria-controls":"margin-results"}),list=el(document,"ul",{class:"results",id:"margin-results",role:"listbox"}),panel=el(document,"div",{class:"palette",role:"dialog","aria-label":"Margin command palette"},el(document,"div",{class:"search"},searchIcon(),input),list);let backdrop=el(document,"div",{class:"backdrop"});shadow.append(backdrop,panel);for(let node of[backdrop,panel])containScroll(node);backdrop.addEventListener("mousedown",e=>{e.preventDefault(),close()}),input.addEventListener("input",()=>{selected=0,refresh()});for(let type of["keydown","keyup","keypress"])panel.addEventListener(type,e=>e.stopPropagation());input.addEventListener("keydown",e=>{if(!e.isComposing){if(e.key==="ArrowDown"||e.key==="n"&&e.ctrlKey)move(1);else if(e.key==="ArrowUp"||e.key==="p"&&e.ctrlKey)move(-1);else if(e.key==="Enter")run(items[selected]);else if(e.key==="Escape")close("escape");else return;e.preventDefault()}}),list.addEventListener("mousemove",e=>{let row=e.target.closest("[data-index]");row&&Number(row.dataset.index)!==selected&&(selected=Number(row.dataset.index),paintSelection())}),list.addEventListener("mousedown",e=>e.preventDefault()),list.addEventListener("click",e=>{let row=e.target.closest("[data-index]");row&&run(items[Number(row.dataset.index)])})}function move(delta){items.length&&(selected=(selected+delta+items.length)%items.length,paintSelection())}function paintSelection(){for(let row of list.children){let on=Number(row.dataset.index)===selected;row.setAttribute("aria-selected",String(on)),on&&row.scrollIntoView({block:"nearest"})}}function refresh(){let state=getState();state&&(items=rankPalette(state,input.value,getContext()),selected=Math.min(selected,Math.max(items.length-1,0)),list.replaceChildren(...items.map((item,index)=>el(document,"li",{role:"option","data-index":String(index),"data-id":item.id,class:item.kind,title:item.subtitle||item.title},item.emoji?el(document,"span",{class:"avatar emoji",text:item.emoji}):avatar(document,item),el(document,"span",{class:"title",text:item.title}),item.badge?el(document,"span",{class:"badge",text:item.badge}):null,GOES.has(item.kind)?el(document,"span",{class:"go-button"},arrowIcon()):null))),items.length||list.append(el(document,"li",{class:"empty",text:"No matches"})),paintSelection())}function run(item){if(!item)return;if(close("run",item.action),item.action.local)return onLocal?.(item.action);let{type,...payload}=item.action;send(type,payload)}function show(){if(host||build(),host.isConnected||document.documentElement.appendChild(host),typeof host.showPopover=="function"&&!siteModalOpen(document)){host.hasAttribute("popover")||host.setAttribute("popover","manual");try{host.matches(":popover-open")||host.showPopover()}catch{}}restoreFocus=document.activeElement;let state=getState(),ctx=getContext(),spaceId=state?activeSpaceId(state,ctx.windowId):null,color=state?.spaces?.find(s=>s.id===spaceId)?.color;color&&panel.style.setProperty("--space-color",color),host.dataset.open="true",open=!0,input.value="",selected=0,refresh(),input.focus()}function close(reason=void 0,action=void 0){if(!open)return;open=!1,host.dataset.open="false";try{host.matches?.(":popover-open")&&host.hidePopover()}catch{}input.blur();let shell=globalThis.Margin?.shell;shell?.card&&(!restoreFocus?.isConnected||restoreFocus===document.body)?shell.focusCard():restoreFocus?.isConnected&&restoreFocus.focus?.({preventScroll:!0}),onClose?.(reason,action)}let lastToggle=0;function toggle(){let now=Date.now();now-lastToggle<200||(lastToggle=now,open?close():show())}return{open:show,close,toggle,isOpen:()=>open,refresh:()=>open&&refresh()}}var $=id=>document.getElementById(id);function mount({api,self,send,windowed=!1}){if(windowed)return mountNote({self,send});let sheet=css=>{let s=new CSSStyleSheet;return s.replaceSync(css),s};document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet(sidebarCss),sheet(newtabCss)],document.body.innerHTML=newtabHtml;let dark=matchMedia("(prefers-color-scheme: dark)"),scrollTimer=null,scrollTop=0,scrollGen=0,flushScroll=()=>{scrollTimer!=null&&(clearTimeout(scrollTimer),scrollTimer=null,send("setSidebarScroll",{top:scrollTop}))},onScroll=top=>{scrollGen++,scrollTop=top,scrollTimer??=setTimeout(flushScroll,150)},SWITCHES=new Set(["activateTab","openPin","closeTab"]),sidebarSend=(type,...rest)=>(SWITCHES.has(type)&&flushScroll(),send(type,...rest)),isLauncher=location.hash==="#launcher",newTabPending=!1,setNewTabPending=on=>{newTabPending!==on&&(newTabPending=on,state&&sidebar2.update(state,{windowId:windowId(),tabId:self?.id,newTabPending}))},closer=newTabCloser(setNewTabPending),sidebar2=createSidebar({document,send:sidebarSend,mode:"newtab",onNewTab:()=>{isLauncher&&(closer.cancel(),setNewTabPending(!0)),palette.open()},onScroll}),applyColorScheme=()=>sidebar2.setColorScheme(dark.matches?"dark":"light");applyColorScheme(),dark.addEventListener("change",applyColorScheme),$("sidebar").append(sidebar2.el);let state=null,windowId=()=>state?.tabs?.[self?.id]?.windowId??self?.windowId,go=url=>api.tabs.update(self.id,{url});function renderSearchEngine(){let learned=state?.settings?.safariSearch,text=platform?.search==="browser"?"Searches use Chrome’s search engine (Chrome Settings → Search engine).":learned?`Searches use Safari’s search engine: ${learned.name} (seen in Safari’s address bar ${new Date(learned.at).toLocaleString()}). Margin follows it: after changing it in Safari → Settings → Search, search once from Safari’s address bar.`:`Searches use Safari’s default search engine (${SAFARI_DEFAULT.name}) until you search once from Safari’s address bar; from then on, whatever Safari uses (Safari → Settings → Search).`;$("engine-info").textContent=text}$("search").addEventListener("submit",event=>{event.preventDefault();let target=resolveInput($("query").value);target?.kind==="url"?go(target.url):target&&send("search",{query:target.query,tabId:self.id})}),$("query").focus(),$("pin-tiles").addEventListener("click",event=>{let tile=event.target.closest("[data-pin-id]"),pin=state?.pins.find(p=>p.id===tile?.dataset.pinId);if(!pin)return;let key=normalizeUrl(pin.url),open=Object.values(state.tabs).find(t=>t.id!==self.id&&normalizeUrl(t.url)===key);open?send("activateTab",{tabId:open.id}):go(pin.url)}),$("archive-list").addEventListener("click",event=>{let row=event.target.closest("[data-archive-id]");row&&send("restoreArchive",{archiveId:row.dataset.archiveId,replaceTabId:self.id})});let showAllArchived=!1;$("archive-more").addEventListener("click",()=>{showAllArchived=!showAllArchived,renderLauncher()});let hours=$("archive-hours");hours.addEventListener("change",()=>{let value=Number(hours.value);Number.isFinite(value)&&value>=0&&send("updateSettings",{patch:{archiveAfterHours:value}})});let blockGestures=$("block-gestures"),pullToRefresh=$("pull-to-refresh"),swipeNavigation=$("swipe-navigation"),gestureGuard=null;platform?.blockGestures&&($("gestures-setting").hidden=!1,$("pull-setting").hidden=!1,$("swipe-setting").hidden=!1,gestureGuard=installGestureGuard({getSettings:()=>state?.settings}),blockGestures.addEventListener("change",()=>send("updateSettings",{patch:{blockGestures:blockGestures.checked}})),pullToRefresh.addEventListener("change",()=>send("updateSettings",{patch:{pullToRefresh:pullToRefresh.checked}})),swipeNavigation.addEventListener("change",()=>send("updateSettings",{patch:{swipeNavigation:swipeNavigation.checked}})));let themeSelect=$("theme");themeSelect.replaceChildren(...Object.values(THEMES).map(t=>el(document,"option",{value:t.id,text:t.name,title:t.description}))),themeSelect.addEventListener("change",async()=>{await send("updateSettings",{patch:{theme:themeSelect.value}}),location.reload()});let marginFullscreen=$("margin-fullscreen"),fullscreenOnly=$("fullscreen-only");platform?.marginFullscreen&&($("fullscreen-setting").hidden=!1,marginFullscreen.addEventListener("change",()=>send("updateSettings",{patch:{marginFullscreenAuto:marginFullscreen.checked}})),$("fullscreen-only-setting").hidden=!1,fullscreenOnly.addEventListener("change",()=>send("updateSettings",{patch:{fullscreenOnly:fullscreenOnly.checked}})));let fitPages=$("fit-pages");platform?.shell&&($("fit-setting").hidden=!1,fitPages.addEventListener("change",()=>send("updateSettings",{patch:{fitPages:fitPages.checked}})));let compactPushed=$("compact-pushed");compactPushed.addEventListener("change",()=>send("updateSettings",{patch:{compactWhenPushed:compactPushed.checked}})),installNavigation({send,getSettings:()=>recording?null:state?.settings});let fresh=!1,cancelOnClose=!1,LEAVES=new Set(["activateTab","openPin","newWindow"]),paletteSend=async(type,payload)=>{if(!fresh)return send(type,payload);if(fresh=!1,type==="restoreArchive")return send(type,{...payload,replaceTabId:self?.id});let result=await send(type,payload);return LEAVES.has(type)&&self?.id!=null&&api.tabs.remove(self.id).catch(()=>{}),result};addEventListener("pagehide",()=>{fresh=!1,cancelOnClose=!1});let palette=createPalette({send:paletteSend,onClose:(reason,action)=>{newTabPending&&closer.onClose(reason,action),reason!=="run"&&cancelOnClose&&send("cancelNewTab"),reason!=="run"&&(fresh=!1),cancelOnClose=!1},getState:()=>state,getContext:()=>({windowId:windowId(),tabId:self?.id,inNewTab:!newTabPending,canToggleSidebar:!1,canFullscreen:!!platform?.marginFullscreen}),onLocal:action=>{action.local==="navigate"&&go(action.url),action.local==="search"&&send("search",{query:action.query,tabId:self.id})},colorScheme:()=>dark.matches?"dark":"light"});installShortcut(palette,()=>recording?null:state?.settings?.paletteShortcut??"Alt+KeyK"),api.runtime.onMessage.addListener(message=>{message?.type==="command"&&message.tabId===self?.id&&message.command==="open-palette"&&palette.toggle()});let shortcutInputs=[...document.querySelectorAll(".shortcut-input")],shortcutHelp=$("shortcut-help"),defaultHelp=shortcutHelp.textContent,SHORTCUT_NAMES={paletteShortcut:"Command palette",sidebarShortcut:"Show or hide the sidebar",nextTab:"Next tab",prevTab:"Previous tab",nextSpace:"Next space",prevSpace:"Previous space"},recording=!1;function currentShortcuts(){return{paletteShortcut:state?.settings?.paletteShortcut??"Alt+KeyK",sidebarShortcut:state?.settings?.sidebarShortcut??"Alt+KeyS",...navigationFor(state?.settings)}}function saveShortcut(name,combo){return name==="paletteShortcut"||name==="sidebarShortcut"?send("updateSettings",{patch:{[name]:combo}}):send("updateSettings",{patch:{shortcuts:{...navigationFor(state?.settings),[name]:combo}}})}function showHelp(text,error=!1){shortcutHelp.textContent=text,shortcutHelp.classList.toggle("error",error)}for(let input of shortcutInputs)input.addEventListener("focus",()=>{recording=!0,input.value="",input.classList.add("recording")}),input.addEventListener("blur",()=>{recording=!1,input.classList.remove("recording"),renderLauncher()});addEventListener("keydown",event=>{let input=shortcutInputs.find(i=>i===event.target);if(!recording||!input)return;if(event.preventDefault(),event.stopImmediatePropagation(),event.key==="Escape")return input.blur();let combo=fromEvent(event);if(!combo||!parse(combo))return;let name=input.dataset.shortcut,taken=Object.entries(currentShortcuts()).find(([other,value])=>other!==name&&value===combo);if(taken)return showHelp(`${format(combo)} is already used for “${SHORTCUT_NAMES[taken[0]]}”.`,!0);showHelp(defaultHelp),saveShortcut(name,combo),input.blur()},!0),$("shortcuts-reset").addEventListener("click",()=>{showHelp(defaultHelp),send("updateSettings",{patch:{paletteShortcut:"Alt+KeyK",sidebarShortcut:"Alt+KeyS",shortcuts:{...NAVIGATION}}})});function ago(ts){let minutes=Math.round((Date.now()-ts)/6e4);if(minutes<1)return"just now";if(minutes<60)return`${minutes}m ago`;let hours2=Math.round(minutes/60);return hours2<48?`${hours2}h ago`:`${Math.round(hours2/24)}d ago`}function renderLauncher(){let view=sidebar(state,windowId());$("pins-section").hidden=view.pins.length===0,$("pin-tiles").replaceChildren(...view.pins.map(p=>el(document,"li",{class:"tile","data-pin-id":p.id,title:p.url},avatar(document,{...p,favIconUrl:iconFor(state,p)}),el(document,"span",{class:"title",text:p.title}))));let all=state.archive??[],archive=showAllArchived?all:all.slice(0,12);if($("archive-section").hidden=all.length===0,$("archive-more").hidden=all.length<=12,$("archive-more").textContent=showAllArchived?"Show fewer":`Show all ${all.length}`,$("archive-list").replaceChildren(...archive.map(a=>el(document,"li",{"data-archive-id":a.id,title:a.url},avatar(document,{...a,favIconUrl:iconFor(state,a)}),el(document,"span",{class:"title",text:a.title||a.url}),el(document,"span",{class:"when",text:ago(a.closedAt)})))),renderSearchEngine(),blockGestures.checked=state.settings.blockGestures!==!1,pullToRefresh.checked=state.settings.pullToRefresh!==!1,pullToRefresh.disabled=!blockGestures.checked,swipeNavigation.checked=state.settings.swipeNavigation!==!1,swipeNavigation.disabled=!blockGestures.checked,fitPages.checked=state.settings.fitPages!==!1,compactPushed.checked=state.settings.compactWhenPushed!==!1,marginFullscreen.checked=state.settings.marginFullscreenAuto!==!1,fullscreenOnly.checked=state.settings.fullscreenOnly!==!1,document.activeElement!==themeSelect&&(themeSelect.value=themeFor(state.settings).id),gestureGuard?.update(),document.activeElement!==hours&&(hours.value=String(state.settings.archiveAfterHours)),!recording){let values=currentShortcuts();for(let input of shortcutInputs)input.value=format(values[input.dataset.shortcut])}}let version=0,firstDrawn,firstState=new Promise(resolve=>{firstDrawn=resolve}),pendingScroll=null;async function refresh(){let mine=++version,next=await api.storage.local.get(null);mine!==version||!next.spaces?.length||(state=next,sidebar2.update(state,{windowId:windowId(),tabId:self?.id,newTabPending,...pendingScroll!=null?{scroll:pendingScroll}:{}}),pendingScroll=null,renderLauncher(),palette.refresh(),firstDrawn())}api.storage.onChanged.addListener((_,area)=>area==="local"&&(!document.hidden||!state)&&refresh());let shown=()=>{let gen=scrollGen;send("sidebarScroll").then(top=>{!Number.isFinite(top)||gen!==scrollGen||(pendingScroll=top,refresh())}),refresh()};return document.addEventListener("visibilitychange",()=>document.visibilityState==="visible"?shown():flushScroll()),addEventListener("pagehide",flushScroll),addEventListener("pageshow",event=>event.persisted&&shown()),shown(),{openPalette:({fresh:isFresh=!1}={})=>firstState.then(()=>{fresh=isFresh,cancelOnClose=isFresh,palette.open()})}}function mountNote({self,send}){let sheet=new CSSStyleSheet;sheet.replaceSync(newtabCss),document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];let go=el(document,"button",{type:"button",class:"primary",text:"Go full screen"}),always=el(document,"button",{type:"button",text:"Use in windows too"});return go.addEventListener("click",()=>send("toggleFullscreen",{windowId:self?.windowId})),always.addEventListener("click",async()=>{await send("updateSettings",{patch:{fullscreenOnly:!1}}),location.reload()}),document.body.replaceChildren(el(document,"main",{id:"fullscreen-note"},el(document,"h1",{text:"Margin works in full screen"}),el(document,"p",{text:"There Chrome’s toolbar stays out of the way: Margin’s sidebar and palette take its place."}),el(document,"div",{class:"actions"},go,always))),{openPalette(){}}}export{mount};
