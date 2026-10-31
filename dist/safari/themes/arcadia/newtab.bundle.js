var __defProp=Object.defineProperty;var __export=(target,all)=>{for(var name in all)__defProp(target,name,{get:all[name],enumerable:!0})};var PROFILES={safari:{name:"safari",fetchFavicons:!0,newTabHint:!0,wakeTabs:!0,keepTabsReady:!0,introduceTabs:!0,restoreTabs:!0,prepareSidebar:!0,compactRail:!1,zoomedWheel:!1,nativeApp:!0,blockGestures:!0,search:"learn",shell:!0,shellPageWrite:!1,marginFullscreen:!1,navigation:{nextTab:"Alt+Meta+ArrowDown",prevTab:"Alt+Meta+ArrowUp",nextSpace:"Ctrl+Meta+ArrowRight",prevSpace:"Ctrl+Meta+ArrowLeft"}},chrome:{name:"chrome",fetchFavicons:!1,newTabHint:!1,wakeTabs:!1,keepTabsReady:!1,introduceTabs:!1,restoreTabs:!1,prepareSidebar:!1,compactRail:!1,zoomedWheel:!0,nativeApp:!1,blockGestures:!1,search:"browser",shell:!0,shellPageWrite:!0,marginFullscreen:!0,navigation:{nextTab:"Ctrl+Meta+ArrowDown",prevTab:"Ctrl+Meta+ArrowUp",nextSpace:"Ctrl+Meta+ArrowRight",prevSpace:"Ctrl+Meta+ArrowLeft"}}},BUILD_TARGET="safari",detect=()=>{try{return(globalThis.browser??globalThis.chrome)?.runtime?.getURL?.("").startsWith("safari-web-extension:")?"safari":"chrome"}catch{return"chrome"}},platform=PROFILES[BUILD_TARGET??detect()];(globalThis.Margin??={}).platform=platform;var FRAME_AWARE=["teams.microsoft.com","teams.cloud.microsoft","teams.live.com","outlook.office.com","outlook.office365.com","outlook.cloud.microsoft","outlook.live.com","office.com","m365.cloud.microsoft","sharepoint.com","login.microsoftonline.com","login.live.com","login.microsoft.com","accounts.google.com","docs.google.com","claude.ai"];function frameAware(url){let host;try{host=new URL(url).hostname}catch{return!1}return FRAME_AWARE.some(d=>host===d||host.endsWith(`.${d}`))}var FRAME_AWARE_PATTERNS=FRAME_AWARE.flatMap(d=>[`*://${d}/*`,`*://*.${d}/*`]);var view_exports={};__export(view_exports,{activeSpaceId:()=>activeSpaceId,cycleSpace:()=>cycleSpace,cycleTab:()=>cycleTab,guessWindow:()=>guessWindow,iconFor:()=>iconFor,isNewTabPage:()=>isNewTabPage,normalizeUrl:()=>normalizeUrl,originOf:()=>originOf,pickIconHref:()=>pickIconHref,pinTabId:()=>pinTabId,revealZone:()=>revealZone,sidebar:()=>sidebar});var posOf=(item,i)=>Number.isFinite(item?.pos)?item.pos:i;function normalizeUrl(url){try{let u=new URL(url),path=u.pathname==="/"?"":u.pathname;return`${u.protocol}//${u.host}${path}${u.search}`}catch{return url??""}}function activeSpaceId(state,windowId){let id=state.activeSpaceByWindow?.[windowId];return state.spaces.some(s=>s.id===id)?id:state.spaces[0].id}function sidebar(state,windowId,currentTabId=null,{newTabPending=!1,switchingTo=null,justShown=!1}={}){let has=id=>id!=null&&state.spaces.some(s=>s.id===id),own=currentTabId!=null?state.tabs?.[currentTabId]:null,going=switchingTo!=null?state.tabs?.[switchingTo]:null,spaceId=going?.windowId===windowId&&has(state.tabSpace?.[going.id])?state.tabSpace[going.id]:justShown&&own?.windowId===windowId&&!own.active&&has(state.tabSpace?.[own.id])?state.tabSpace[own.id]:activeSpaceId(state,windowId),known=own?.windowId===windowId,shown=Object.values(state.tabs??{}).filter(t=>t.windowId===windowId).map(t=>known&&t.active!==(t.id===currentTabId)?{...t,active:t.id===currentTabId}:t),target=switchingTo!=null&&shown.some(t=>t.id===switchingTo&&!t.active)?switchingTo:null,shownNewTab=shown.find(t=>t.active&&isNewTabPage(t.url)),spaceTabs=shown.map(t=>target!=null?t.id===target?{...t,active:!0}:t.active?{...t,active:!1}:t:newTabPending&&t.active?{...t,active:!1,behind:!0}:t).sort((a,b)=>a.index-b.index).filter(t=>state.tabSpace[t.id]===spaceId),folders=(state.folders??[]).filter(f=>f.spaceId===spaceId),folderIds=new Set(folders.map(f=>f.id)),bound=new Map;state.pins.forEach((p,i)=>{if(p.spaceId!==spaceId)return;let key=normalizeUrl(p.url),matches2=spaceTabs.filter(t=>normalizeUrl(t.url)===key),tab=matches2.find(t=>t.active)??matches2.find(t=>t.behind)??matches2[0];bound.set(p.id,{...p,folderId:p.folderId&&folderIds.has(p.folderId)?p.folderId:null,pos:posOf(p,i),tabId:tab?.id??null,active:!!tab?.active,behind:!!tab?.behind,favIconUrl:tab?.favIconUrl??""})});let byPos=(a,b)=>a.pos-b.pos,loose=[...bound.values()].filter(p=>!p.folderId),pinned=[...folders.map((f,i)=>{let inside=[...bound.values()].filter(p=>p.folderId===f.id).sort(byPos);return{kind:"folder",id:f.id,name:f.name,open:f.open!==!1,pos:posOf(f,i),pins:inside,peek:f.open===!1?inside.filter(p=>p.active||p.behind):[]}}),...loose.map(p=>({kind:"pin",...p}))].sort(byPos),pins=pinned.flatMap(item=>item.kind==="folder"?item.pins:[item]),pinnedUrls=new Set(pins.map(p=>normalizeUrl(p.url))),targetIsNewTab=target!=null&&isNewTabPage(shown.find(t=>t.id===target)?.url);return{spaceId,spaces:state.spaces,pins,pinned,newTab:{active:targetIsNewTab||target==null&&(newTabPending||!!shownNewTab),behind:!1},tabs:spaceTabs.filter(t=>!pinnedUrls.has(normalizeUrl(t.url))&&t.id!==shownNewTab?.id&&!(targetIsNewTab&&t.id===target)).reverse()}}function pinTabId(state,pinId,windowId){let pin=state.pins?.find(p=>p.id===pinId);if(!pin)return null;let key=normalizeUrl(pin.url),matches2=Object.values(state.tabs??{}).filter(t=>normalizeUrl(t.url)===key&&state.tabSpace?.[t.id]===pin.spaceId);return(matches2.find(t=>t.windowId===windowId)??matches2[0])?.id??null}var NEW_TAB_PAGE=/^(chrome:\/\/newtab\/?|[a-z-]+-extension:\/\/[^/]+\/newtab\/newtab\.html)(\?[^#]*)?$/i,isNewTabPage=url=>NEW_TAB_PAGE.test(String(url??""));function guessWindow(state,url){let tabs=Object.values(state.tabs??{});if(new Set(tabs.map(t=>t.windowId)).size<=1)return tabs[0]?.windowId??null;let byUrl=tabs.filter(t=>t.url===url),pool=byUrl.length?byUrl:tabs.filter(t=>t.active);return pool.sort((a,b)=>Number(b.active)-Number(a.active)||(b.lastActive??0)-(a.lastActive??0)),pool[0]?.windowId??null}var EDGE_PX=10,FULLSCREEN_EDGE_PX=24;function revealZone({outerWidth,outerHeight,screenWidth,screenHeight}){return outerWidth>=screenWidth&&outerHeight>=screenHeight?FULLSCREEN_EDGE_PX:EDGE_PX}function cycleTab(state,windowId,currentTabId,dir){let v=sidebar(state,windowId,currentTabId),order=[...v.pinned.flatMap(item=>item.kind!=="folder"?[item]:item.open?item.pins:item.peek).filter(p=>p.tabId!=null).map(p=>p.tabId),...v.tabs.map(t=>t.id)];if(!order.length)return null;let at=order.indexOf(currentTabId);if(at<0)return dir>0?order[0]:order[order.length-1];let next=order[(at+dir+order.length)%order.length];return next===currentTabId?null:next}function cycleSpace(state,windowId,dir){if(state.spaces.length<2)return null;let at=state.spaces.findIndex(s=>s.id===activeSpaceId(state,windowId));return state.spaces[(at+dir+state.spaces.length)%state.spaces.length].id}function originOf(url){try{let u=new URL(url);return/^https?:$/.test(u.protocol)?u.origin:null}catch{return null}}function pickIconHref(links,pageUrl){let origin=originOf(pageUrl);if(!origin)return null;let usable=href=>/^https?:/i.test(href??"")||/^data:image\//i.test(href??""),score=l=>{let rel=(l.rel??"").toLowerCase().split(/\s+/);if(!rel.some(r=>r==="icon"||r==="apple-touch-icon"||r==="apple-touch-icon-precomposed")||!usable(l.href))return-1;if(!rel.includes("icon"))return 1;let sizes=(l.sizes??"").toLowerCase();if((l.type??"").includes("svg")||sizes==="any")return 5;let px=Math.max(0,...[...sizes.matchAll(/(\d+)x\d+/g)].map(m=>Number(m[1])));return px>=16&&px<=64?4:px?2:3},best=links.map(l=>({l,s:score(l)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s)[0];return best?best.l.href:`${origin}/favicon.ico`}function iconFor(state,item){if(/^(https?|data):/.test(item?.favIconUrl??""))return item.favIconUrl;let origin=originOf(item?.url);return origin&&state?.favicons?.[origin]?.data||""}var SAFARI_ENGINES={google:{name:"Google",host:/^www\.google(\.[a-z]{2,3}){1,2}$/,path:/^\/search$/,fromSafari:p=>p.get("client")==="safari",template:host=>`https://${host}/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8`},bing:{name:"Bing",host:/^www\.bing\.com$/,path:/^\/search$/,fromSafari:p=>/^AP/.test(p.get("form")??""),template:host=>`https://${host}/search?q=%s&form=APMCS1&PC=APMC`},duckduckgo:{name:"DuckDuckGo",host:/^duckduckgo\.com$/,path:/^\/$/,fromSafari:p=>["osx","iphone","ipad"].includes(p.get("t")),template:host=>`https://${host}/?q=%s&t=osx&ia=web`},ecosia:{name:"Ecosia",host:/^www\.ecosia\.org$/,path:/^\/search$/,fromSafari:p=>(p.get("tts")??"").startsWith("st_asaf_"),template:host=>`https://${host}/search?q=%s&tts=st_asaf_macos`},yahoo:{name:"Yahoo",host:/^([a-z]{2,10}\.)?search\.yahoo(\.[a-z]{2,3}){1,2}$/,path:/^\/search(;[^/]*)?$/,fromSafari:p=>/^(aapl|iphone$|ipad$)/.test(p.get("fr")??"")||p.get(".tsrc")==="apple",template:host=>`https://${host}/search?ei=utf-8&fr=aaplw&p=%s`}},SAFARI_DEFAULT=Object.freeze({id:"google",name:"Google",template:SAFARI_ENGINES.google.template("www.google.com")});var safariEngine=settings=>settings?.safariSearch?.template?.includes("%s")?settings.safariSearch:SAFARI_DEFAULT;var engineLabel=(settings,platform2=platform)=>platform2?.search==="browser"?"Chrome’s search engine":safariEngine(settings).name,WITH_SCHEME=/^(https?|file|ftp):\/\//i,OPAQUE_SCHEME=/^(about|data|mailto|view-source):/i,LOCAL=/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i,DOMAIN=/^([a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(:\d+)?([/?#]\S*)?$/i;function resolveInput(text){let input=(text??"").trim();if(!input)return null;if(WITH_SCHEME.test(input)||OPAQUE_SCHEME.test(input))return{kind:"url",url:input};if(!/\s/.test(input)){if(LOCAL.test(input))return{kind:"url",url:`http://${input}`};if(DOMAIN.test(input))return{kind:"url",url:`https://${input}`}}return{kind:"search",query:input}}var isWordStart=(text,i)=>i===0||/[\s\-_./:]/.test(text[i-1]);function fuzzyScore(query,text){let q=query.toLowerCase(),t=(text??"").toLowerCase();if(!q)return 0;let at=t.indexOf(q);if(at>=0)return 100+(at===0?40:0)+(isWordStart(t,at)?20:0)+q.length*2-at*.1-t.length*.01;let score=0,from=0,prev=-2;for(let ch of q){let found=t.indexOf(ch,from);if(found<0)return-1/0;score+=(found===prev+1?5:1)+(isWordStart(t,found)?3:0),prev=found,from=found+1}return score-t.length*.01}function matchScore(query,item){let total=0;for(let token of query.split(/\s+/).filter(Boolean)){let best=Math.max(fuzzyScore(token,item.title),fuzzyScore(token,item.subtitle)-10);if(best===-1/0)return-1/0;total+=best}return total}var isWebUrl=url=>/^https?:/i.test(url??"");function paletteItems(state,ctx){let view=view_exports,spaceId=view.activeSpaceId(state,ctx.windowId),spaceOf=id=>state.spaces.find(s=>s.id===id),items=[];for(let t of Object.values(state.tabs??{})){let space=spaceOf(state.tabSpace?.[t.id]);items.push({id:`tab:${t.id}`,kind:"tab",title:t.title||t.url||"New Tab",subtitle:t.url,url:t.url,favIconUrl:iconFor(state,t),badge:space?.name??"",boost:(space?.id===spaceId?30:10)+(t.id===ctx.tabId?-25:0),recency:t.lastActive??0,action:{type:"activateTab",tabId:t.id}})}for(let p of state.pins??[]){let space=spaceOf(p.spaceId),folder=p.folderId?(state.folders??[]).find(f=>f.id===p.folderId&&f.spaceId===p.spaceId):null;items.push({id:`pin:${p.id}`,kind:"pin",title:p.title,subtitle:p.url,url:p.url,favIconUrl:iconFor(state,p),badge:folder?`${folder.name} · ${space?.name??"Pinned"}`:space?.name??"Pinned",boost:p.spaceId===spaceId?20:8,action:{type:"openPin",pinId:p.id,windowId:ctx.windowId}})}for(let a of state.archive??[])items.push({id:`archive:${a.id}`,kind:"archive",title:a.title||a.url,subtitle:a.url,url:a.url,favIconUrl:iconFor(state,a),badge:"Archived",boost:0,recency:a.closedAt??0,action:{type:"restoreArchive",archiveId:a.id,windowId:ctx.windowId}});let action=(id,title,act,extra={})=>items.push({id:`action:${id}`,kind:"action",title,subtitle:"",boost:12,action:act,...extra}),current=state.tabs?.[ctx.tabId],currentSpace=state.tabSpace?.[ctx.tabId];current&&isWebUrl(current.url)&&!state.pins.some(p=>p.spaceId===currentSpace&&view.normalizeUrl(p.url)===view.normalizeUrl(current.url))&&action("pin-current","Pin current tab",{type:"pinTab",tabId:ctx.tabId},{emoji:"📌"}),action("new-window","New window",{type:"newWindow"},{emoji:"⧉"}),ctx.inNewTab||action("launcher","Margin start page & settings",{type:"openLauncher",windowId:ctx.windowId},{emoji:"⚙︎"}),ctx.canToggleSidebar&&action("toggle-sidebar","Toggle sidebar",{local:"toggleSidebar"},{emoji:"◧"}),ctx.canFullscreen&&action("fullscreen","Margin full screen (no toolbar) on/off",{type:"toggleFullscreen",windowId:ctx.windowId},{emoji:"⛶"});let origin=current&&isWebUrl(current.url)&&!frameAware(current.url)?view.originOf(current.url):null;origin&&ctx.canFit&&state.settings?.sidebarPinnedOpen&&state.settings?.fitPages!==!1&&((state.settings.fitPagesExcept??[]).includes(origin)?action("fit-site","Fit this site beside the sidebar again",{type:"setFitSite",origin,fit:!0},{emoji:"▣"}):ctx.fitted&&action("unfit-site","Show this site without fitting it beside the sidebar",{type:"setFitSite",origin,fit:!1},{emoji:"▢"}));for(let s of state.spaces)s.id!==spaceId&&action(`space:${s.id}`,`Switch to space ${s.name}`,{type:"setSpace",windowId:ctx.windowId,spaceId:s.id},{emoji:s.emoji});return items}var KIND_ORDER={tab:0,action:1,pin:2,archive:3};function rankPalette(state,query,ctx,limit=40){let q=(query??"").trim(),items=paletteItems(state,ctx),ranked;q?ranked=items.map(item=>({item,score:matchScore(q,item)})).filter(r=>r.score>-1/0).map(r=>({...r,score:r.score+r.item.boost})).sort((a,b)=>b.score-a.score||(b.item.recency??0)-(a.item.recency??0)).map(r=>r.item):ranked=items.filter(i=>i.kind!=="archive"&&i.id!==`tab:${ctx.tabId}`).sort((a,b)=>KIND_ORDER[a.kind]-KIND_ORDER[b.kind]||b.boost-a.boost||(b.recency??0)-(a.recency??0)),ranked=ranked.slice(0,limit);let target=resolveInput(q);if(target){let isUrl=target.kind==="url",go={id:"go",kind:"go",title:isUrl?`Open ${target.url}`:`Search for “${q}”`,badge:isUrl?"Open":"Search",subtitle:isUrl?"":engineLabel(state.settings),emoji:isUrl?"↗":"⌕",action:isUrl?ctx.inNewTab?{local:"navigate",url:target.url}:{type:"newTab",windowId:ctx.windowId,url:target.url}:ctx.inNewTab?{local:"search",query:target.query}:{type:"search",query:target.query,windowId:ctx.windowId}};target.kind==="url"?ranked.unshift(go):ranked.push(go)}return ranked}var MODIFIERS=["Ctrl","Alt","Shift","Meta"],MOD_CODES=/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/,KEY_CODES=/^(Key[A-Z]|Digit\d|F\d{1,2}|Arrow(Up|Down|Left|Right)|Space|Enter|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;function parse(text){let parts=String(text??"").split("+").map(p=>p.trim()).filter(Boolean),code=parts.pop();if(!code||!KEY_CODES.test(code))return null;let mods=new Set(parts);return!mods.size||[...mods].some(m=>!MODIFIERS.includes(m))?null:{ctrl:mods.has("Ctrl"),alt:mods.has("Alt"),shift:mods.has("Shift"),meta:mods.has("Meta"),code}}function matches(event,text){let s=parse(text);return!!s&&event.code===s.code&&event.ctrlKey===s.ctrl&&event.altKey===s.alt&&event.shiftKey===s.shift&&event.metaKey===s.meta}function fromEvent(event){if(MOD_CODES.test(event.code)||!KEY_CODES.test(event.code))return null;let mods=[event.ctrlKey&&"Ctrl",event.altKey&&"Alt",event.shiftKey&&"Shift",event.metaKey&&"Meta"].filter(Boolean);return mods.length?[...mods,event.code].join("+"):null}var SYMBOLS={Ctrl:"⌃",Alt:"⌥",Shift:"⇧",Meta:"⌘"};function format(text){let s=parse(text);if(!s)return"";let key={ArrowUp:"↑",ArrowDown:"↓",ArrowLeft:"←",ArrowRight:"→"}[s.code]??s.code.replace(/^Key|^Digit/,"").replace(/^Slash$/,"/").replace(/^Period$/,".").replace(/^Space$/,"Space");return MODIFIERS.filter(m=>s[m.toLowerCase()]).map(m=>SYMBOLS[m]).join("")+key}var NAVIGATION={...(platform??PROFILES.chrome).navigation},navigationFor=settings=>({...NAVIGATION,...settings?.shortcuts}),ACTIONS={nextTab:"next-tab",prevTab:"prev-tab",nextSpace:"next-space",prevSpace:"prev-space"};function installNavigation({send,getSettings,target=globalThis}){target.addEventListener("keydown",event=>{let settings=getSettings();if(settings===null)return;let keys=navigationFor(settings),name=Object.keys(keys).find(n=>matches(event,keys[n]));name&&(event.preventDefault(),event.stopImmediatePropagation(),!(event.repeat&&name.endsWith("Space"))&&send("navigate",{action:ACTIONS[name]}))},!0)}var AXES={x:{size:"Width",pos:"scrollLeft",overflow:"overflowX"},y:{size:"Height",pos:"scrollTop",overflow:"overflowY"}};function canScroll(node,axis,delta,scrollingElement){if(!delta)return!1;let a=AXES[axis],style=getComputedStyle(node),overflow=style[a.overflow];if(node===scrollingElement?overflow==="hidden"||overflow==="clip":overflow!=="auto"&&overflow!=="scroll")return!1;let max=node[`scroll${a.size}`]-node[`client${a.size}`];if(max<=1)return!1;let[lo,hi]=axis==="x"&&style.direction==="rtl"?[-max,0]:[0,max];return delta<0?node[a.pos]>lo+.5:node[a.pos]<hi-.5}var canScrollX=(node,dx,scrollingElement)=>canScroll(node,"x",dx,scrollingElement);function somethingScrolls(event,axis,{doc,stopAt=null}={}){let delta=axis==="x"?event.deltaX:event.deltaY;if(!delta)return!1;let scrollingElement=doc?doc.scrollingElement??doc.documentElement:null;for(let node of event.composedPath()){if(node.nodeType===1&&canScroll(node,axis,delta,scrollingElement))return!0;if(node===stopAt)return!1}return!!scrollingElement&&canScroll(scrollingElement,axis,delta,scrollingElement)}var sidewaysAnswers=new WeakMap;function pageScrollsX(event,doc){let known=sidewaysAnswers.get(event);if(known&&known.doc===doc)return known.scrolls;let scrolls=somethingScrolls(event,"x",{doc});return sidewaysAnswers.set(event,{doc,scrolls}),scrolls}function containScroll(el2){el2.addEventListener("wheel",event=>{if(!event.cancelable||event.ctrlKey)return;let axis=Math.abs(event.deltaX)>Math.abs(event.deltaY)?"x":"y";somethingScrolls(event,axis,{stopAt:el2})||event.preventDefault()},{passive:!1})}var NO_BOUNCE_CSS=":root { overscroll-behavior-y: none !important; }";function installGestureGuard({getSettings,wanted=void 0,pinch=()=>"block",onPinch=()=>{},onWheelFirst=void 0,win=globalThis.window}){if(!win)return{update(){}};let doc=win.document,enabled=()=>getSettings()?.blockGestures!==!1,wheelWanted=wanted??enabled,zoomedIn=()=>(globalThis.visualViewport?.scale??1)>1,wheelOptions={capture:!0,passive:!1},onWheel=event=>{if(!(!enabled()||!event.cancelable||event.ctrlKey)){if(onWheelFirst?.(event))return event.stopPropagation(),event.preventDefault();Math.abs(event.deltaX)<=Math.abs(event.deltaY)||pageScrollsX(event,doc)||event.preventDefault()}},listening=!1,syncWheel=()=>{let on=wheelWanted();on!==listening&&(listening=on,on?win.addEventListener("wheel",onWheel,wheelOptions):win.removeEventListener?.("wheel",onWheel,wheelOptions))};syncWheel();let ours=!1,options={capture:!0,passive:!1};win.addEventListener("gesturestart",event=>{if(ours=!1,!enabled()||zoomedIn())return;let mode=event.composedPath().some(node=>/^margin-.*-host$/.test(node.localName??""))?"block":pinch();mode==="native"&&event.scale>=1||(event.preventDefault(),mode==="own"&&(event.stopPropagation(),ours=!0,onPinch({phase:"start",scale:event.scale,x:event.clientX,y:event.clientY})))},options),win.addEventListener("gesturechange",event=>{!ours||!enabled()||(event.preventDefault(),event.stopPropagation(),Number.isFinite(event.scale)&&onPinch({phase:"change",scale:event.scale}))},options),win.addEventListener("gestureend",event=>{ours&&(ours=!1,event.preventDefault(),event.stopPropagation(),onPinch({phase:"end",scale:event.scale}))},options);let sheet=null,style=null;function update(){syncWheel();let on=enabled();if(doc?.adoptedStyleSheets&&typeof win.CSSStyleSheet?.prototype.replaceSync=="function"){sheet||(sheet=new win.CSSStyleSheet,sheet.replaceSync(NO_BOUNCE_CSS));let others=doc.adoptedStyleSheets.filter(s=>s!==sheet),has=others.length!==doc.adoptedStyleSheets.length;on!==has&&(doc.adoptedStyleSheets=on?[...others,sheet]:others)}else doc?.documentElement&&(on&&!style?.isConnected?(style??=Object.assign(doc.createElement("style"),{textContent:NO_BOUNCE_CSS}),doc.documentElement.appendChild(style)):on||style?.remove())}return update(),{update}}var OPEN_TABS_KEYS=Object.freeze(["tabs","tabSpace","activeSpaceByWindow"]),OPEN_TABS="openTabs",RENAMED=Object.freeze({lostTabs:"lostTabs2"});function fromStorage(raw){let state={...raw};delete state[OPEN_TABS];let open=raw[OPEN_TABS];for(let key of OPEN_TABS_KEYS)state[key]=open?open[key]:raw[key];state.openTabsBy=open?{origin:open.origin,since:open.since,synced:!!open.synced}:null;for(let[key,name]of Object.entries(RENAMED))state[key]=name in raw?raw[name]:raw[key];return state}function withChanges(state,changes){let next={...state};for(let[key,{newValue}]of Object.entries(changes))if(key===OPEN_TABS){let read=fromStorage({[OPEN_TABS]:newValue});for(let name of[...OPEN_TABS_KEYS,"openTabsBy"])next[name]=read[name]}else{if(OPEN_TABS_KEYS.includes(key)||key in RENAMED)continue;{let renamed=Object.entries(RENAMED).find(([,name])=>name===key)?.[0];next[renamed??key]=newValue}}return next}var takesChanges=(changes,{reading,openTabsBy})=>reading===0&&openTabsBy!=null&&Object.values(changes).every(change=>change&&"newValue"in change);function el(doc,tag,attrs={},...children){let node=doc.createElement(tag);for(let[key,value]of Object.entries(attrs))value==null||value===!1||(key==="class"?node.className=value:key==="text"?node.textContent=value:key==="style"?node.style.cssText=value:node.setAttribute(key,value===!0?"":value));for(let child of children.flat())child&&node.append(child);return node}function adoptStyles(shadow,css){if("adoptedStyleSheets"in shadow&&typeof CSSStyleSheet.prototype.replaceSync=="function"){let sheet=new CSSStyleSheet;sheet.replaceSync(css),shadow.adoptedStyleSheets=[...shadow.adoptedStyleSheets,sheet]}else{let style=shadow.ownerDocument.createElement("style");style.textContent=css,shadow.prepend(style)}}var HOST_CSS=`:host {
  all: initial !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  z-index: 2147483647 !important;
  /* Margin's UI isn't page text (asBrowserUi): inherited by what's inside,
     text fields excepted by their own styles. */
  -webkit-user-select: none !important;
  user-select: none !important;
}
:host([data-margin-off]) { display: none !important; pointer-events: none !important; }`;function createHost(doc,tag){let host=doc.createElement(tag);host.__marginCopy=!0;let shadow=host.attachShadow({mode:"closed"});if(adoptStyles(shadow,HOST_CSS),"adoptedStyleSheets"in shadow){let zoomSheet=new CSSStyleSheet;shadow.adoptedStyleSheets=[...shadow.adoptedStyleSheets,zoomSheet],host.__marginZoom=zoomSheet}return unzoom(host,globalThis.marginPageZoom??1),{host,shadow}}var APP_TAG="margin-app",APP_ROOT=":root > margin-app";function appRoot(doc){let found=doc.querySelector(APP_ROOT);if(found)return found;let root=doc.createElement(APP_TAG),shadow=root.attachShadow({mode:"closed"});return adoptStyles(shadow,":host { all: initial !important; display: contents !important; }"),shadow.append(doc.createElement("slot")),root}function mountHost(host){let doc=host.ownerDocument;if(!doc.documentElement)return;let root=appRoot(doc);host.parentNode!==root&&root.append(host),root.isConnected||doc.documentElement.append(root)}function marginHosts(doc){return[...doc.documentElement?.children??[],...doc.querySelector(APP_ROOT)?.children??[]].filter(node=>/^margin-.*-host$/.test(node.localName))}function mark(host,key,value){globalThis.__marginMarks&&(value===void 0?delete host.dataset[key]:host.dataset[key]=value)}function unzoom(el2,zoom){let sheet=el2.__marginZoom;if(sheet)return sheet.replaceSync(`:host { --page-zoom: ${zoom} !important; zoom: ${1/zoom} !important; }`);if(zoom===1){el2.style.removeProperty("zoom"),el2.style.removeProperty("--page-zoom");return}el2.style.setProperty("zoom",String(1/zoom),"important"),el2.style.setProperty("--page-zoom",String(zoom))}function setPageZoom(doc,zoom){globalThis.marginPageZoom=zoom;for(let node of marginHosts(doc))unzoom(node,zoom)}var TEXT_INPUTS=/^(text|search|url|email|tel|password|number)$/;function asBrowserUi(root,{zoomable=()=>!1}={}){let editable=event=>event.composedPath().some(node=>node instanceof Element&&(node.tagName==="TEXTAREA"||node instanceof HTMLInputElement&&TEXT_INPUTS.test(node.type)&&!node.readOnly||node.isContentEditable)),fromHost=event=>/^margin-.*-host$/.test(event.composedPath()[0]?.localName??""),shadow=!(root instanceof Document);if(root.addEventListener("contextmenu",event=>{fromHost(event)||(editable(event)||event.preventDefault(),shadow&&event.stopPropagation())}),root.addEventListener("selectstart",event=>{!fromHost(event)&&!editable(event)&&event.preventDefault()}),root.addEventListener("dragstart",event=>{let source=event.composedPath()[0];source instanceof Element&&/^(IMG|A)$/.test(source.tagName)&&!source.closest('[draggable="true"]')&&event.preventDefault()}),root.addEventListener("webkitmouseforcewillbegin",event=>event.preventDefault()),root.addEventListener("wheel",event=>{event.ctrlKey&&event.cancelable&&!fromHost(event)&&!zoomable(event)&&event.preventDefault()},{passive:!1}),shadow)for(let type of["gesturestart","gesturechange"])root.addEventListener(type,event=>event.preventDefault(),{passive:!1})}function siteModalOpen(doc){try{return!!doc.querySelector(":modal")}catch{return!1}}function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,"")}catch{return""}}var opensNewTab=(type,payload)=>type==="newTab"&&!!payload?.url||type==="search"&&payload?.tabId==null;function createSwitching({onChange,onSlow,failed=()=>!1,onFailed=()=>{},onBlink=()=>{},doc=document}){let target=null,current=null,slow=!1,timers=[],clearTimers=()=>{timers.forEach(clearTimeout),timers=[]},stopPill=()=>{slow&&(slow=!1,onSlow(!1))};function end(){target!=null&&(target=null,current=null,clearTimers(),stopPill(),onChange(null))}function start(tabId,request=null){if(!Number.isInteger(tabId)||doc.hidden)return;clearTimers();let token={};current=token,target=tabId,onChange(tabId);let mine=()=>current===token;timers.push(setTimeout(()=>{!mine()||slow||(slow=!0,onSlow(!0))},150)),timers.push(setTimeout(()=>mine()&&end(),request?8e3:2500));let didFail=()=>{mine()&&(end(),onFailed(tabId))};request?.then(result=>{if(mine()){if(failed(result))return didFail();clearTimers(),stopPill(),timers.push(setTimeout(()=>mine()&&end(),300))}},didFail)}let when=event=>event?.timeStamp&&globalThis.performance?performance.timeOrigin+event.timeStamp:Date.now(),wasHidden=doc.hidden,hiddenAt=0;return doc.addEventListener("visibilitychange",event=>{let changed=doc.hidden!==wasHidden;if(wasHidden=doc.hidden,doc.hidden)return hiddenAt=target!=null?when(event):0,end();let at=when(event);!changed&&target!=null?onBlink({hiddenAt:at,shownAt:at}):hiddenAt&&at-hiddenAt<100&&onBlink({hiddenAt,shownAt:at}),hiddenAt=0}),doc.defaultView?.addEventListener("pagehide",end),{start,end,target:()=>target}}function backgroundSwitches(){let pending=null;return{begin(tabId,switchId=null){pending?.resolve();let resolve=()=>{},reject=()=>{},request=new Promise((res,rej)=>{resolve=res,reject=rej});return request.catch(()=>{}),pending={tabId,switchId:switchId??null,resolve:()=>resolve({shown:tabId}),reject:()=>reject(new Error("switch failed"))},request},settle({type,tabId,switchId=null}){!pending||pending.tabId!==tabId||pending.switchId!==(switchId??null)||((type==="switch-done"?pending.resolve:pending.reject)(),pending=null)}}}function installNewTabKey(run,target=globalThis,skip=()=>!1){target.addEventListener("keydown",e=>{!e.isTrusted||e.code!=="KeyT"||!e.metaKey||e.ctrlKey||e.altKey||e.shiftKey||skip()||(e.preventDefault(),e.stopImmediatePropagation(),e.repeat||run())},!0)}var SHOWS_ANOTHER_TAB=new Set(["activateTab","newTab","openPin","restoreArchive","search","openLauncher"]);function newTabCloser(setPending,doc=document){let cancel=()=>{};return{onClose:(reason,action)=>{if(cancel(),reason!=="run"||!action||action.local||!SHOWS_ANOTHER_TAB.has(action.type))return setPending(!1);let done=()=>{cancel(),setPending(!1)},onHidden=()=>doc.hidden&&done(),timer=setTimeout(done,1500);doc.addEventListener("visibilitychange",onHidden),cancel=()=>{clearTimeout(timer),doc.removeEventListener("visibilitychange",onHidden),cancel=()=>{}}},cancel:()=>cancel()}}function reportingSwitches(send,getState,onSwitch){return(type,payload)=>{let request=send(type,payload),tabId=type==="activateTab"?payload?.tabId:type==="openPin"&&getState()?pinTabId(getState(),payload?.pinId,payload?.windowId):opensNewTab(type,payload)?-1:null;return Number.isInteger(tabId)&&onSwitch(tabId,request),request}}var WIDTH=Object.freeze({min:160,max:500,default:260,step:10}),clampWidth=w=>Math.min(WIDTH.max,Math.max(WIDTH.min,Number.isFinite(w)?w:WIDTH.default)),snapWidth=w=>clampWidth(Math.round(clampWidth(w)/WIDTH.step)*WIDTH.step);var defaults=Object.freeze({sidebarWidth:WIDTH.default});function settingsOf(settings){let own=settings?.themes?.arcadia??settings?.themes?.arcadium,stored=own&&typeof own=="object"?own:{},width=stored.sidebarWidth??settings?.sidebarWidth??defaults.sidebarWidth;return{...defaults,...stored,sidebarWidth:snapWidth(Number(width))}}var sidebarWidth=settings=>settingsOf(settings).sidebarWidth,theme_default=Object.freeze({id:"arcadia",name:"Arcadia",description:"Arc’s look: a frame around the page, space chips, pins and tabs.",defaults,settingsOf,content:"themes/arcadia/content.bundle.js",newtab:"themes/arcadia/newtab.bundle.js",placeholder:settings=>`themes/arcadia/docked/w-${sidebarWidth(settings)}.css`,closedPlaceholder:"themes/arcadia/docked/closed.css",railPlaceholder:"themes/arcadia/docked/rail.css"});var THEMES=Object.freeze({[theme_default.id]:theme_default}),DEFAULT_THEME=theme_default.id,themeFor=settings=>THEMES[settings?.theme]??THEMES[DEFAULT_THEME];var DEFAULTS={GAP_MS:140,AXIS_PX:6,MAX_STEP:120,MOMENTUM_RUN:5,MIN_EVENTS:4,COMMIT_FRACTION:.3,FLICK_PX:40,FLICK_SPEED:.6};function createSpaceSwipe(options={}){let o={...DEFAULTS,...options},gesture=null,lastTime=-1/0,idle=()=>({phase:"idle",offset:0,speed:0,events:0,counted:!1}),speed=g=>{let run=g.recent.slice(-4);if(run.length<2)return 0;let span=run[run.length-1].t-run[0].t;return span>0?run.slice(1).reduce((sum,r)=>sum+r.d,0)/span:0},decaying=g=>{let run=g.recent.slice(-o.MOMENTUM_RUN).map(r=>Math.abs(r.d));if(run.length<o.MOMENTUM_RUN||run[0]<4)return!1;for(let i=1;i<run.length;i++){let ratio=run[i]/run[i-1];if(!(ratio>=.8&&ratio<.99))return!1}return!0},release=g=>(g.released=!0,g.last=-(g.recent.at(-1)?.d??0),{phase:"release",offset:g.offset,speed:speed(g),events:g.events,counted:!1});function track(g,{deltaX,deltaY,time,ok}){if(!g||g.axis==="y"||g.released)return idle();if(g.axis==null){if(!ok)return g.axis="y",idle();if(g.dx+=Math.abs(deltaX),g.dy+=Math.abs(deltaY),Math.max(g.dx,g.dy)<o.AXIS_PX||(g.axis=g.dx>g.dy*1.2?"x":"y",g.axis==="y"))return idle()}return Math.abs(deltaX)>o.MAX_STEP?{phase:"tracking",offset:g.offset,speed:0,events:g.events,counted:!1}:(g.offset-=deltaX,g.events+=1,g.recent.push({d:-deltaX,t:time}),g.recent.length>8&&g.recent.shift(),decaying(g)?release(g):{phase:"tracking",offset:g.offset,speed:speed(g),events:g.events,counted:!0})}return{wheel({deltaX=0,deltaY=0,deltaMode=0,ctrlKey=!1,shiftKey=!1,mouse=!1,time,usable=!0}){let fresh=time-lastTime>o.GAP_MS;lastTime=time;let g0=gesture;!fresh&&g0?.released&&(Math.abs(deltaX)>=Math.abs(deltaY)&&Math.sign(deltaX)!==-Math.sign(g0.last)&&Math.abs(deltaX)<=Math.abs(g0.last)*1.2+1?g0.last=deltaX:fresh=!0);let unreleased=fresh&&gesture?.axis==="x"&&!gesture.released?release(gesture):null;fresh&&(gesture={axis:null,dx:0,dy:0,offset:0,events:0,released:!1,last:0,recent:[]});let result=track(gesture,{deltaX,deltaY,time,ok:usable&&!ctrlKey&&!shiftKey&&!mouse&&deltaMode===0});return unreleased??result},swiping(time){return!!gesture&&gesture.axis==="x"&&time-lastTime<=o.GAP_MS},end(){let g=gesture;return gesture=null,lastTime=-1/0,!g||g.axis!=="x"||g.released?idle():release(g)},reset(){gesture=null,lastTime=-1/0}}}function settle({offset,speed,events=1/0,width,has},o=DEFAULTS){let dir=offset>0?-1:1;if(!offset||events<o.MIN_EVENTS||!has(dir))return 0;let far=Math.abs(offset)>=width*o.COMMIT_FRACTION,flick=Math.abs(offset)>=o.FLICK_PX&&Math.sign(speed)===Math.sign(offset)&&Math.abs(speed)>=o.FLICK_SPEED,reversed=Math.sign(speed)===-Math.sign(offset)&&Math.abs(speed)>=o.FLICK_SPEED;return(far||flick)&&!reversed?dir:0}function rubberBand(offset,max){let d=Math.abs(offset);return Math.sign(offset)*max*(1-1/(d/max+1))}function hue(text){let h=0;for(let ch of text)h=(h*31+ch.codePointAt(0))%360;return h}function avatar(doc,{title,url,favIconUrl}){let label=hostOf(url)||title||"?";if(!favIconUrl||!/^(https?|data):/.test(favIconUrl))return letterAvatar(doc,label);let img=el(doc,"img",{class:"avatar",src:favIconUrl,alt:"",referrerpolicy:"no-referrer","data-label":label});return letterIfBroken(doc,img),img}var letterAvatar=(doc,label)=>el(doc,"span",{class:"avatar letter",text:label.charAt(0).toUpperCase(),style:`background: hsl(${hue(label)} 55% 48%)`,"aria-hidden":"true"});function letterIfBroken(doc,img){let swap=()=>{img.closest("li")?.setAttribute("data-icon-broken",""),img.replaceWith(letterAvatar(doc,img.dataset.label||"?"))};img.complete&&img.src&&!img.naturalWidth?swap():img.addEventListener("error",swap,{once:!0})}var SPACE_COLORS=["#6c5ce7","#0984e3","#00b894","#fdcb6e","#e17055","#d63031","#e84393","#636e72"],SVG_NS="http://www.w3.org/2000/svg";function svg(doc,viewBox,children,cls){let node=doc.createElementNS(SVG_NS,"svg");node.setAttribute("viewBox",viewBox),node.setAttribute("class",cls),node.setAttribute("aria-hidden","true");for(let[tag,attrs]of children){let child=doc.createElementNS(SVG_NS,tag);for(let[k,v]of Object.entries(attrs))child.setAttribute(k,v);node.append(child)}return node}var ICONS={toggle:doc=>svg(doc,"0 0 19 15",[["rect",{x:"0.75",y:"0.75",width:"17.5",height:"13.5",rx:"3"}],["path",{d:"M6.25 0.75v13.5M2.75 4h1.5M2.75 6.5h1.5M2.75 9h1.5"}]],"line-icon toggle-icon"),archive:doc=>svg(doc,"0 0 14 16.5",[["path",{"fill-rule":"evenodd",d:"M2 7.5H13Q13.5 7.5 13.5 8V13.5Q13.5 16.5 10.5 16.5H4.5Q1.5 16.5 1.5 13.5V8Q1.5 7.5 2 7.5ZM6.5 8.5H8.5A1 1 0 0 1 8.5 10.5H6.5A1 1 0 0 1 6.5 8.5Z"}],["path",{d:"M.9 6.1Q.4 6 .2 5.3L0 4.7Q0 4 .7 3.9L2.8 3.6L4 1.4Q4.35.85 4.75 1.4L5.95 3.1L8.6 3.2Q9.25 3.25 9.05 3.85L8.4 5.7Q8.25 6.1 7.8 6.1Z"}],["path",{d:"M11.4 2.9Q11.8 2.3 12.2 2.9L14 5.2Q14.3 5.7 13.8 5.9L11.3 6.4Q10.6 6.5 10.6 5.8Z"}],["circle",{cx:"9.5",cy:"1",r:"1"}]],"fill-icon archive-icon"),plus:doc=>svg(doc,"0 0 14 14",[["path",{d:"M7 1v12M1 7h12"}]],"line-icon plus-icon"),close:doc=>svg(doc,"0 0 11 11",[["path",{d:"M1 1l9 9M10 1l-9 9"}]],"line-icon close-icon"),folder:(doc,open)=>svg(doc,"0 0 22.5 16.5",open?[["path",{class:"folder-back",d:"M5.2 15.9Q4.4 15.9 4.2 15.1L.75 2.2Q.4.6 2 .6H5.6Q6.3.6 6.8 1.1L8.2 2.6Q8.6 3 9.2 3.05L20.6 4.1Q21.6 4.2 21.4 5.2L17.9 15.9Z"}],["path",{class:"folder-front",d:"M8.7 5.2H21.1Q22 5.2 21.7 6.1L18.6 15.3Q18.4 15.9 17.7 15.9H5Q4.15 15.9 4.4 15.1L7.4 6.3Q7.75 5.2 8.7 5.2Z"}]]:[["path",{class:"folder-back",d:"M1 2.1Q1 .6 2.5 .6H6.6Q7.2.6 7.6 1.1L8.9 2.6H20Q21.5 2.6 21.5 4.1V14.4Q21.5 15.9 20 15.9H2.5Q1 15.9 1 14.4Z"}],["path",{class:"folder-front",d:"M1 6.3Q1 4.8 2.5 4.8H20Q21.5 4.8 21.5 6.3V14.4Q21.5 15.9 20 15.9H2.5Q1 15.9 1 14.4Z"}]],`folder-icon${open?" open":""}`)};function createSidebar({document:doc,send,mode,onNewTab,onArchive,onWidth,onScroll,onSwitch}){let keepOpen=el(doc,"button",{type:"button",class:"keep-open","data-action":"keep-open"},ICONS.toggle(doc)),fitSite=el(doc,"button",{type:"button",class:"fit-site","data-action":"fit-site",hidden:!0}),top=el(doc,"header",{class:"top"},mode==="overlay"?keepOpen:null,el(doc,"span",{class:"spacer"}),fitSite),spaceTitle=el(doc,"div",{class:"space-title"}),nameInput=el(doc,"input",{class:"name",type:"text",placeholder:"Space name","aria-label":"Space name",maxlength:"40"}),emojiInput=el(doc,"input",{class:"emoji",type:"text","aria-label":"Space emoji",maxlength:"8"}),swatches=el(doc,"div",{class:"swatches",role:"radiogroup","aria-label":"Space color"},SPACE_COLORS.map(c=>el(doc,"button",{type:"button",class:"swatch","data-color":c,title:c,style:`--chip-color: ${c}`,role:"radio"}))),deleteButton=el(doc,"button",{type:"button",class:"delete","data-editor":"delete",text:"Delete"}),editor=el(doc,"form",{class:"editor",hidden:!0,"aria-label":"Edit space"},el(doc,"div",{class:"row"},emojiInput,nameInput),swatches,el(doc,"div",{class:"row actions"},deleteButton,el(doc,"span",{class:"spacer"}),el(doc,"button",{type:"button","data-editor":"cancel",text:"Cancel"}),el(doc,"button",{type:"submit",class:"primary",text:"Save"}))),pins=el(doc,"ul",{class:"pins","aria-label":"Pinned"}),listDivider=el(doc,"div",{class:"divider"}),tabs=el(doc,"ul",{class:"tabs","aria-label":"Tabs"}),tabsSection=el(doc,"section",{class:"tabs-section"},el(doc,"div",{class:"pins-section"},pins),listDivider,tabs),chips=el(doc,"nav",{class:"spaces","aria-label":"Spaces"}),footer=el(doc,"footer",{class:"bar"},el(doc,"button",{type:"button",class:"bar-button archive","data-action":"archive",title:"Archived tabs","aria-label":"Archived tabs"},ICONS.archive(doc)),chips,el(doc,"button",{type:"button",class:"bar-button add","data-action":"add-menu",title:"New folder or space","aria-label":"New folder or space"},ICONS.plus(doc))),pane=el(doc,"div",{class:"space-pane"},spaceTitle,editor,tabsSection),root=el(doc,"aside",{class:`margin-sidebar ${mode}`,"aria-label":"Margin"},top,pane,footer);containScroll(root);let settingScroll=!1;tabsSection.addEventListener("scroll",()=>{settingScroll?settingScroll=!1:onScroll?.(tabsSection.scrollTop)},{passive:!0});let resizer=el(doc,"div",{class:"resizer",title:"Drag to resize · double-click to reset","aria-hidden":"true"});root.append(resizer);let resizing=null,saveWidth=sidebarWidth2=>send("updateThemeSettings",{themeId:"arcadia",patch:{sidebarWidth:sidebarWidth2}}),setWidth=px=>root.style.setProperty("--width",`${px}px`),hostScale=()=>{let width=root.getBoundingClientRect().width;return width&&root.offsetWidth?root.offsetWidth/width:1},wheelScale=()=>platform?.zoomedWheel?hostScale():1;resizer.addEventListener("pointerdown",event=>{if(event.button!==0)return;event.preventDefault(),event.stopPropagation(),resizer.setPointerCapture?.(event.pointerId);let startWidth=root.offsetWidth;resizing={startX:event.clientX,startWidth,width:startWidth,scale:hostScale()},root.classList.add("resizing")}),resizer.addEventListener("pointermove",event=>{resizing&&(resizing.width=clampWidth(resizing.startWidth+(event.clientX-resizing.startX)*resizing.scale),setWidth(resizing.width),onWidth?.(resizing.width,{done:!1}))});let endResize=()=>{if(!resizing)return;let width=snapWidth(resizing.width);resizing=null,root.classList.remove("resizing"),setWidth(width),onWidth?.(width,{done:!0}),saveWidth(width)};resizer.addEventListener("pointerup",endResize),resizer.addEventListener("pointercancel",endResize),resizer.addEventListener("lostpointercapture",endResize),resizer.addEventListener("dblclick",event=>{event.stopPropagation();let width=WIDTH.default;setWidth(width),onWidth?.(width,{done:!0}),saveWidth(width)});let state=null,windowId=null,currentTabId=null,pendingEdit=null,fit=null,newTabPending=!1,switchingTo=null,renaming=null,pendingRename=null,rendering=!1,shownSpace=null,shownSince=0,justShown=!1,swiping=null,drawingGhosts=!1,renderPending=!1,viewState=()=>shownSpace&&state?{...state,activeSpaceByWindow:{...state.activeSpaceByWindow,[windowId]:shownSpace}}:state,closeButton=(tabId,label)=>el(doc,"button",{type:"button",class:"icon close","data-action":"close","data-tab-id":String(tabId),"aria-label":label},ICONS.close(doc));function pinRow(p,nested){return el(doc,"li",{class:`pin${nested?" nested":""}${p.active?" active":""}${p.behind?" behind":""}${p.tabId?" open":""}`,"data-action":"open-pin","data-pin-id":p.id,"data-folder-id":p.folderId??null,"aria-label":p.title},avatar(doc,{...p,favIconUrl:iconFor(state,p)}),el(doc,"span",{class:"title",text:p.title}),p.tabId!=null?closeButton(p.tabId,"Close tab (stays pinned)"):null)}function folderRow(f){let editingThis=renaming?.folderId===f.id,name=editingThis?renameField(f):el(doc,"span",{class:"title",text:f.name});return el(doc,"li",{class:`folder${f.open?" open":""}`,"data-action":editingThis?null:"toggle-folder","data-folder-id":f.id},el(doc,"div",{class:"folder-toggle","data-action":editingThis?null:"toggle-folder","data-folder-id":f.id,role:editingThis?null:"button",tabindex:editingThis?null:"0","aria-expanded":editingThis?null:String(f.open)},ICONS.folder(doc,f.open),name))}let renameInput=null;function renameField(f){return renameInput||(renameInput=el(doc,"input",{type:"text",class:"folder-name","aria-label":"Folder name",maxlength:"40",spellcheck:"false"}),renameInput.addEventListener("input",()=>{renaming&&(renaming.draft=renameInput.value)}),renameInput.addEventListener("keydown",event=>{event.key==="Enter"?commitRename():event.key==="Escape"&&cancelRename()}),renameInput.addEventListener("blur",()=>{rendering||commitRename()}),renameInput.addEventListener("click",event=>event.stopPropagation()),renameInput.addEventListener("dblclick",event=>event.stopPropagation())),renameInput.dataset.folderId!==f.id&&(renameInput.dataset.folderId=f.id,renameInput.value=renaming.draft,renameInput.dataset.fresh="true"),renameInput}function startRename(folderId){let folder=state?.folders?.find(f=>f.id===folderId);!folder||root.classList.contains("rail")||(renaming={folderId,draft:folder.name},renameInput&&delete renameInput.dataset.folderId,render())}function commitRename(){if(!renaming)return;let{folderId,draft}=renaming;renaming=null;let name=draft.trim().slice(0,40),folder=state?.folders?.find(f=>f.id===folderId);name&&folder&&name!==folder.name&&(send("renameFolder",{folderId,name}),state={...state,folders:state.folders.map(f=>f.id===folderId?{...f,name}:f)}),render()}function cancelRename(){renaming=null,render()}let lastView=null;function render(){if(!(!state||windowId==null)){if(swiping?.settling){renderPending=!0;return}renderPending=!1,rendering=!0;try{draw(),pressedKey&&rowFor(pressedKey)?.classList.add("pressed");for(let key of gliding)rowFor(key)?.classList.add("landing")}finally{rendering=!1}dragging&&moveDrag(dragging.x,dragging.y),land(),renaming&&renameInput?.isConnected&&(renameInput.dataset.fresh==="true"?(delete renameInput.dataset.fresh,renameInput.focus({preventScroll:!0}),renameInput.select()):renameSelection&&(renameInput.focus({preventScroll:!0}),renameInput.setSelectionRange(...renameSelection)))}}let renameSelection=null,shownSpaceId=null,rowCache=new Map,usedKeys=new Set,drawnFrom=new Map,sameFrom=(a,b)=>!!a&&a.length===b.length&&a.every((v,i)=>v===b[i]);function changed(part,from){return sameFrom(drawnFrom.get(part),from)?!1:(drawnFrom.set(part,from),!0)}function keyed(key,from,build){if(drawingGhosts||usedKeys.has(key))return build();usedKeys.add(key);let kept=rowCache.get(key);if(kept&&sameFrom(kept.from,from)&&!kept.el.hasAttribute("data-icon-broken"))return kept.el;let row=build();return rowCache.set(key,{el:row,from}),row}function place(list,rows){let at=list.firstChild;for(let row of rows){if(row===at){at=at.nextSibling;continue}list.insertBefore(row,at)}for(;at;){let next=at.nextSibling;at.remove(),at=next}}function forgetUnused(){if(!drawingGhosts){for(let key of rowCache.keys())usedKeys.has(key)||rowCache.delete(key);usedKeys.clear()}}let pinFrom=(p,nested)=>[nested,p.active,p.behind,p.tabId,p.folderId,p.title,p.url,iconFor(state,p)];function draw(){let view=lastView=sidebar(viewState(),windowId,currentTabId,{newTabPending,switchingTo,justShown:justShown&&!shownSpace});root.style.setProperty("--space-color",view.spaces.find(s=>s.id===view.spaceId)?.color??""),resizing||setWidth(sidebarWidth(state.settings)),renaming&&!view.pinned.some(item=>item.kind==="folder"&&item.id===renaming.folderId)&&(renaming=null),renameSelection=renaming&&renameInput&&renameInput.getRootNode().activeElement===renameInput?[renameInput.selectionStart,renameInput.selectionEnd]:null;let space=view.spaces.find(s=>s.id===view.spaceId);spaceTitle.dataset.spaceId=space?.id??"",changed("title",[space?.emoji??"",space?.name??""])&&spaceTitle.replaceChildren(el(doc,"span",{class:"emoji","aria-hidden":"true",text:space?.emoji??""}),el(doc,"span",{class:"title",text:space?.name??""})),changed("chips",[view.spaceId,...view.spaces.flatMap(s=>[s.id,s.name,s.emoji,s.color])])&&chips.replaceChildren(...view.spaces.map(s=>el(doc,"button",{type:"button",class:`chip${s.id===view.spaceId?" active":""}`,"data-action":"set-space","data-space-id":s.id,title:s.name,"aria-pressed":String(s.id===view.spaceId),style:`--chip-color: ${s.color}`,text:s.emoji})));let pinRows=[];for(let item of view.pinned){if(item.kind!=="folder"){pinRows.push(keyed(`pin:${item.id}`,pinFrom(item,!1),()=>pinRow(item,!1)));continue}pinRows.push(keyed(`folder:${item.id}`,[item.name,item.open,renaming?.folderId===item.id],()=>folderRow(item)));for(let p of item.open?item.pins:item.peek)pinRows.push(keyed(`pin:${p.id}`,pinFrom(p,!0),()=>pinRow(p,!0)))}place(pins,pinRows),listDivider.hidden=!view.pinned.length;let newTabRow=keyed("new-tab",[view.newTab.active,view.newTab.behind],()=>el(doc,"li",{class:`new-tab-row${view.newTab.active?" active":""}${view.newTab.behind?" behind":""}`,"data-action":"new-tab",role:"button","aria-label":"New Tab","aria-current":view.newTab.active?"page":null},el(doc,"span",{class:"plus","aria-hidden":"true"},ICONS.plus(doc)),el(doc,"span",{class:"title",text:"New Tab"})));place(tabs,[newTabRow,...view.tabs.map(t=>keyed(`tab:${t.id}`,[t.active,t.behind,t.title,t.url,iconFor(state,t)],()=>el(doc,"li",{class:`tab${t.active?" active":""}${t.behind?" behind":""}`,"data-action":"activate","data-tab-id":String(t.id),"aria-label":t.title||t.url||"New Tab"},avatar(doc,{...t,favIconUrl:iconFor(state,t)}),el(doc,"span",{class:"title",text:t.title||t.url||"New Tab"}),closeButton(t.id,"Close tab"))))]),forgetUnused();let pinned=!!state.settings?.sidebarPinnedOpen;keepOpen.title=pinned?"Auto-hide the sidebar":"Keep the sidebar open",keepOpen.setAttribute("aria-label",keepOpen.title),keepOpen.setAttribute("aria-pressed",String(pinned));let excepted=!!fit?.origin&&(state.settings?.fitPagesExcept??[]).includes(fit.origin);if(fitSite.hidden=!(pinned&&fit?.fittable&&state.settings?.fitPages!==!1&&(fit.fitted||excepted)),fitSite.textContent=fit?.fitted?"▢":"▣",fitSite.title=fit?.fitted?"Show this site normally (not fitted beside the sidebar)":"Fit this site beside the sidebar again",fitSite.setAttribute("aria-label",fitSite.title),view.spaceId!==shownSpaceId&&!drawingGhosts){shownSpaceId=view.spaceId;let chip=chips.querySelector(".chip.active");if(chip){let bar=chips.getBoundingClientRect(),box=chip.getBoundingClientRect(),k=hostScale();box.left<bar.left?chips.scrollLeft-=(bar.left-box.left)*k:box.right>bar.right&&(chips.scrollLeft+=(box.right-bar.right)*k)}}}let openOverPage=()=>mode==="overlay"&&root.classList.contains("open")&&(!root.classList.contains("docked")||root.classList.contains("rail-expanded")),rowTab=row=>row.dataset.tabId?Number(row.dataset.tabId):row.classList.contains("open")&&state?pinTabId(state,row.dataset.pinId,windowId):null,pressedKey=null;root.addEventListener("pointerdown",event=>{if(releasePress(),event.button!==0||event.ctrlKey||!event.isPrimary)return;let target=event.target;if(target.closest?.(".icon, input"))return;let row=target.closest?.(".tab, .pin, .folder, .new-tab-row");!row||!root.contains(row)||(pressedKey=keyOf(row),row.classList.add("pressed"))});for(let type of["pointerup","pointercancel"])doc.addEventListener(type,()=>releasePress(),!0);doc.defaultView?.addEventListener("blur",()=>releasePress());function releasePress({instant=!1}={}){if(!pressedKey)return;let row=rowFor(pressedKey);pressedKey=null,row&&(instant&&row.classList.add("instant"),row.classList.remove("pressed"),instant&&requestAnimationFrame(()=>row.classList.remove("instant")))}function switchRow(target){let show=openOverPage();if(target.dataset.action==="activate"){let tabId=Number(target.dataset.tabId);if(switchingTo===tabId)return null;let request2=send("activateTab",{tabId,...show?{show}:{}});return target.classList.contains("active")||onSwitch?.(tabId,request2),request2}let pinTab=rowTab(target);if(pinTab!=null&&switchingTo===pinTab)return null;let request=send("openPin",{pinId:target.dataset.pinId,windowId,...show?{show}:{}});return pinTab!=null&&!target.classList.contains("active")&&onSwitch?.(pinTab,request),request}let pressed=!1,pressedAway=!1;root.addEventListener("pointerdown",event=>{if(pressed=!1,pressedAway=!1,event.button!==0||event.pointerType!=="mouse"||!event.isPrimary||event.ctrlKey||dragging)return;let target=event.target.closest?.("[data-action]");if(!target||!root.contains(target))return;let action=target.dataset.action;if(action!=="activate"&&!(action==="open-pin"&&target.classList.contains("open")))return;pressed=!0;let tab=rowTab(target);pressedAway=tab!=null&&tab!==currentTabId||switchingTo!=null&&switchingTo!==currentTabId,stopHoverWake(),switchRow(target)}),root.addEventListener("click",event=>{let target=event.target.closest("[data-action]");if(!target||!root.contains(target)||(event.stopPropagation(),event.ctrlKey&&target.closest(".tab, .pin, .folder")))return;let tabId=Number(target.dataset.tabId),{spaceId,folderId}=target.dataset,show=openOverPage();if((target.dataset.action==="activate"||target.dataset.action==="open-pin")&&pressed&&event.detail>0){pressed=!1;return}switch(target.dataset.action){case"activate":case"open-pin":return switchRow(target);case"close":return send("closeTab",{tabId,...show?{show}:{}});case"toggle-folder":{if(event.detail>1)return;let folder=state?.folders?.find(f=>f.id===folderId);return folder?(lastToggle={folderId,wasOpen:folder.open!==!1,at:Date.now()},send("setFolderOpen",{folderId,open:folder.open===!1})):void 0}case"set-space":return send("setSpace",{windowId,spaceId,...show?{show}:{}});case"new-tab":return onNewTab?onNewTab():send("newTab",{windowId});case"archive":return onArchive?onArchive():send("openLauncher",{windowId});case"add-menu":{let box=target.getBoundingClientRect();return openAddMenu(box.left,box.top)}case"fit-site":return fit?.origin&&send("setFitSite",{origin:fit.origin,fit:!fit.fitted});case"keep-open":return send("updateSettings",{patch:{sidebarPinnedOpen:!state?.settings?.sidebarPinnedOpen}})}});let lastToggle=null;pins.addEventListener("dblclick",event=>{let row=event.target.closest(".folder");!row||event.target.closest(".folder-name")||(event.stopPropagation(),lastToggle?.folderId===row.dataset.folderId&&Date.now()-lastToggle.at<800&&send("setFolderOpen",{folderId:lastToggle.folderId,open:lastToggle.wasOpen}),lastToggle=null,startRename(row.dataset.folderId))}),pins.addEventListener("keydown",event=>{let toggle=event.target.closest?.(".folder-toggle[data-action]");if(!toggle||event.key!=="Enter"&&event.key!==" ")return;event.preventDefault();let folder=state?.folders?.find(f=>f.id===toggle.dataset.folderId);folder&&send("setFolderOpen",{folderId:folder.id,open:folder.open===!1})}),chips.addEventListener("wheel",event=>{Math.abs(event.deltaY)<=Math.abs(event.deltaX)||chips.scrollWidth<=chips.clientWidth||(chips.scrollLeft+=event.deltaY*wheelScale(),event.preventDefault())},{passive:!1});let SETTLE_MS=220,SHOWN_SPACE_MS=3e3,spaceSwipe=createSpaceSwipe(),swipeEndTimer=null,shownTimer=null,swipeBase={offset:0,events:0},fromBase=result=>({...result,offset:result.offset-swipeBase.offset,events:result.events-swipeBase.events}),recentTabOf=spaceId=>Object.values(state?.tabs??{}).filter(t=>t.windowId===windowId&&state.tabSpace[t.id]===spaceId).sort((a,b)=>(b.lastActive??0)-(a.lastActive??0))[0]??null,scrollsSideways=event=>{for(let node of event.composedPath()){if(node===root)return!1;if(node.nodeType===1&&canScrollX(node,event.deltaX,null))return!0}return!1},swipeUsable=()=>mode!=="overlay"||root.classList.contains("open")&&!root.classList.contains("rail");function startSwipe(){let shown=activeSpaceId(viewState(),windowId),at=state.spaces.findIndex(s=>s.id===shown),neighbours={[-1]:state.spaces[at-1]?.id,1:state.spaces[at+1]?.id},box=root.getBoundingClientRect(),paneBox=pane.getBoundingClientRect(),k=hostScale(),ghosts={},keep={shownSpace,switchingTo,top:tabsSection.scrollTop,left:chips.scrollLeft};rendering=!0,drawingGhosts=!0;try{for(let dir of[-1,1]){if(!neighbours[dir])continue;shownSpace=neighbours[dir],switchingTo=recentTabOf(shownSpace)?.id??null,draw();let ghost=pane.cloneNode(!0);for(let img of ghost.querySelectorAll("img.avatar"))letterIfBroken(doc,img);ghost.classList.add("ghost"),ghost.inert=!0,ghost.setAttribute("aria-hidden","true"),Object.assign(ghost.style,{top:`${(paneBox.top-box.top)*k}px`,left:`${(paneBox.left-box.left)*k}px`,width:`${paneBox.width*k}px`,height:`${paneBox.height*k}px`}),ghosts[dir]=ghost}}finally{({shownSpace,switchingTo}=keep),draw(),drawingGhosts=!1,rendering=!1,chips.scrollLeft=keep.left,tabsSection.scrollTop!==keep.top&&(settingScroll=!0,tabsSection.scrollTop=keep.top)}root.append(...Object.values(ghosts)),root.classList.add("space-swiping"),swiping={neighbours,ghosts,width:box.width*k,offset:0,frame:0,settling:!1,committed:!1}}function placeSwipe(offset){let s=swiping,toward=offset>0?-1:1,shownOffset=s.neighbours[toward]?Math.max(-s.width,Math.min(s.width,offset)):rubberBand(offset,s.width*.2);pane.style.transform=shownOffset?`translateX(${shownOffset}px)`:"";for(let dir of[-1,1])s.ghosts[dir]?.style.setProperty("transform",`translateX(${shownOffset+dir*s.width}px)`)}function moveSwipe(offset){swiping.offset=offset,!swiping.frame&&(swiping.frame=requestAnimationFrame(()=>{swiping&&(swiping.frame=0,placeSwipe(swiping.offset))}))}function endSwipe(){if(!swiping)return;let{committed}=swiping;cancelAnimationFrame(swiping.frame);for(let ghost of Object.values(swiping.ghosts))ghost.remove();pane.style.transform="",pane.classList.remove("settling"),root.classList.remove("space-swiping"),swiping=null,committed&&tabsSection.scrollTop!==0&&(settingScroll=!0,tabsSection.scrollTop=0),(committed||renderPending)&&render()}function releaseSwipe({offset,speed,events}){let s=swiping;if(!s||s.settling)return;cancelAnimationFrame(s.frame),s.frame=0;let dir=settle({offset,speed,events,width:s.width,has:d=>!!s.neighbours[d]});s.settling=!0,pane.classList.add("settling");for(let ghost of Object.values(s.ghosts))ghost.classList.add("settling");if(placeSwipe(dir?-dir*s.width:0),dir){let spaceId=s.neighbours[dir];s.committed=!0,onScroll?.(0);let show=openOverPage(),request=send("setSpace",{windowId,spaceId,...show?{show}:{}});if(state.tabSpace[currentTabId]===spaceId)switchingTo!=null&&send("activateTab",{tabId:currentTabId}),onSwitch?.(currentTabId,request);else{let tab=recentTabOf(spaceId);tab&&onSwitch?.(tab.id,request)}showSpaceNow(spaceId)}setTimeout(()=>{swiping===s&&endSwipe()},SETTLE_MS)}function showSpaceNow(spaceId){shownSpace=spaceId,shownSince=Date.now(),clearTimeout(shownTimer),shownTimer=setTimeout(()=>{shownSpace===spaceId&&(shownSpace=null,render())},SHOWN_SPACE_MS+50)}let mouseWheel=event=>{let legacy=event.wheelDeltaX??0;return legacy!==0&&legacy%120===0&&Math.abs(Math.abs(legacy)-Math.abs(event.deltaX*wheelScale())*3)>3};root.addEventListener("wheel",event=>{let k=wheelScale(),busy=editing!=null||renaming!=null||dragging!=null||resizing!=null||!menu.hidden,usable=!!state&&windowId!=null&&state.spaces.length>1&&!busy&&swipeUsable()&&!scrollsSideways(event),result=spaceSwipe.wheel({deltaX:event.deltaX*k,deltaY:event.deltaY*k,deltaMode:event.deltaMode,ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,mouse:mouseWheel(event),time:event.timeStamp,usable});spaceSwipe.swiping(event.timeStamp)&&event.cancelable&&event.preventDefault(),!swiping?.settling&&(result.phase==="tracking"?(clearTimeout(swipeEndTimer),swiping||(swipeBase=result.counted?{offset:result.offset+event.deltaX*k,events:result.events-1}:{offset:result.offset,events:result.events},startSwipe()),moveSwipe(result.offset-swipeBase.offset),swipeEndTimer=setTimeout(()=>{let end=spaceSwipe.end();releaseSwipe(end.phase==="release"?fromBase(end):end)},DEFAULTS.GAP_MS+20)):result.phase==="release"&&(clearTimeout(swipeEndTimer),releaseSwipe(fromBase(result))))},{passive:!1}),doc.addEventListener("visibilitychange",()=>{!doc.hidden||!swiping||(clearTimeout(swipeEndTimer),spaceSwipe.reset(),endSwipe())});function newSpace(){return send("createSpace",{windowId}).then(res=>{res?.spaceId&&(freshSpace=res.spaceId,state?.spaces.some(s=>s.id===res.spaceId)?openEditor(res.spaceId):pendingEdit=res.spaceId)})}let freshSpace=null;function folderCreated(folderId){folderId&&(state?.folders?.some(f=>f.id===folderId)?startRename(folderId):pendingRename=folderId)}let newFolder=(payload={})=>send("createFolder",{windowId,...payload}).then(folderCreated),HOVER_WAKE_MS=80,HOVER_RENEW_MS=500,HOVER_IDLE_MS=1e4,hoverWake=null,prewakeRow=(row,renew=!1)=>{!row?.isConnected||row.classList.contains("active")||(row.dataset.tabId?send("prewake",{tabId:Number(row.dataset.tabId),renew}):row.dataset.pinId&&row.classList.contains("open")&&send("prewake",{pinId:row.dataset.pinId,windowId,renew}))},stopHoverWake=()=>{hoverWake&&clearTimeout(hoverWake.timer),hoverWake=null};root.addEventListener("pointerover",event=>{let row=event.target.closest?.(".tab, .pin"),key=row&&root.contains(row)?row.dataset.tabId?`tab:${row.dataset.tabId}`:`pin:${row.dataset.pinId}`:null;if(key&&hoverWake?.key===key||(stopHoverWake(),!key||dragging))return;let selector=row.dataset.tabId?`.tab[data-tab-id="${row.dataset.tabId}"]`:`.pin[data-pin-id="${CSS.escape(row.dataset.pinId)}"]`,wake={key,selector,timer:null,until:Date.now()+HOVER_IDLE_MS},first=!0,tick=()=>{if(hoverWake===wake){if(doc.hidden||Date.now()>wake.until)return stopHoverWake();prewakeRow(root.querySelector(selector),!first),first=!1,wake.timer=setTimeout(tick,HOVER_RENEW_MS)}};hoverWake=wake,wake.timer=setTimeout(tick,HOVER_WAKE_MS)}),root.addEventListener("pointermove",()=>{freshHover(),hoverWake&&(hoverWake.until=Date.now()+HOVER_IDLE_MS)},{passive:!0}),root.addEventListener("pointerleave",stopHoverWake),root.addEventListener("click",stopHoverWake,!0),root.addEventListener("pointerdown",event=>{if(pressed||event.button!==0||event.ctrlKey||event.target.closest(".icon"))return;let row=event.target.closest(".tab, .pin");row&&root.contains(row)&&prewakeRow(row)});function staleHover(){stopHoverWake(),root.classList.add("hover-stale")}function freshHover(){root.classList.remove("hover-stale")}doc.hidden&&staleHover(),doc.addEventListener("visibilitychange",()=>{doc.hidden&&staleHover()}),doc.defaultView?.addEventListener("pagehide",staleHover);let editing=null;function openEditor(spaceId){if(root.classList.contains("rail"))return;let space=state?.spaces.find(s=>s.id===spaceId);space&&(editing={spaceId,color:space.color,confirmDelete:!1},nameInput.value=space.name,emojiInput.value=space.emoji,editor.hidden=!1,renderEditor(),nameInput.focus(),nameInput.select())}function closeEditor({deleted=!1}={}){let spaceId=editing?.spaceId;editing=null,editor.hidden=!0,spaceId&&spaceId===freshSpace&&(freshSpace=null,deleted||send("setSpace",{windowId,spaceId}))}function renderEditor(){if(!editing)return;for(let sw of swatches.children)sw.setAttribute("aria-checked",String(sw.dataset.color===editing.color));let only=(state?.spaces.length??0)<2;deleteButton.disabled=only,deleteButton.title=only?"The last space can’t be deleted":"Tabs and pins move to the first space",deleteButton.textContent=editing.confirmDelete?"Really delete?":"Delete"}editor.addEventListener("submit",event=>{event.preventDefault(),editing&&(send("renameSpace",{spaceId:editing.spaceId,name:nameInput.value,emoji:emojiInput.value,color:editing.color}),closeEditor())}),editor.addEventListener("click",event=>{event.stopPropagation();let swatch=event.target.closest(".swatch");if(swatch&&editing)return editing.color=swatch.dataset.color,renderEditor();let action=event.target.closest("[data-editor]")?.dataset.editor;if(action==="cancel"&&closeEditor(),action==="delete"&&editing){if(!editing.confirmDelete)return editing.confirmDelete=!0,renderEditor();send("deleteSpace",{spaceId:editing.spaceId}),closeEditor({deleted:!0})}}),editor.addEventListener("keydown",event=>{event.key==="Escape"&&closeEditor()});for(let where of[chips,spaceTitle]){let spaceOf=event=>event.target.closest(".chip[data-space-id], .space-title")?.dataset.spaceId;where.addEventListener("contextmenu",event=>{let spaceId=spaceOf(event);!spaceId||root.classList.contains("rail")||(event.preventDefault(),event.stopPropagation(),openEditor(spaceId))}),where.addEventListener("dblclick",event=>{let spaceId=spaceOf(event);spaceId&&openEditor(spaceId)})}let menu=el(doc,"div",{class:"tab-menu",role:"menu",tabindex:"-1",hidden:!0});root.append(menu);let menuPopover=typeof menu.showPopover=="function";menuPopover&&menu.setAttribute("popover","manual");let menuFor=null,menuItem=(label,action,data={})=>el(doc,"button",{class:"menu-item",role:"menuitem","data-menu":action,...data,text:label}),separator=()=>el(doc,"div",{class:"menu-separator",role:"separator"}),spaceFolders=()=>(lastView?.pinned??[]).filter(item=>item.kind==="folder");function menuItems(row){let tabId=row.dataset.tabId&&row.classList.contains("tab")?Number(row.dataset.tabId):null,pin=row.dataset.pinId?state?.pins.find(p=>p.id===row.dataset.pinId):null,folder=row.classList.contains("folder")?state?.folders?.find(f=>f.id===row.dataset.folderId):null;if(folder)return menuFor={folderId:folder.id},[menuItem("Rename Folder","rename-folder"),menuItem(folder.open===!1?"Open Folder":"Close Folder","toggle-folder"),separator(),menuItem("Delete Folder (pins stay)","delete-folder")];if(pin){menuFor={pinId:pin.id};let items2=[menuItem("Unpin","unpin"),separator()],shown=lastView?.pins.find(p=>p.id===pin.id);for(let f of spaceFolders())f.id!==shown?.folderId&&items2.push(menuItem(`Move to 📁 ${f.name}`,"move-pin",{"data-folder-id":f.id}));return shown?.folderId&&items2.push(menuItem("Remove from Folder","move-pin")),items2.push(menuItem("New Folder with Pin","new-folder-pin")),shown?.tabId!=null&&items2.push(separator(),menuItem("Close Tab","close",{"data-tab-id":String(shown.tabId)})),items2}if(tabId==null)return[];menuFor={tabId};let items=[menuItem("Pin Tab","pin")];for(let f of spaceFolders())items.push(menuItem(`Pin to 📁 ${f.name}`,"pin",{"data-folder-id":f.id}));items.push(menuItem("New Folder with Tab","new-folder-tab"));let spaceId=state?.tabSpace?.[tabId],others=(state?.spaces??[]).filter(sp=>sp.id!==spaceId);if(others.length){items.push(separator());for(let sp of others)items.push(menuItem(`Move to ${sp.emoji} ${sp.name}`,"move",{"data-space-id":sp.id}))}return items.push(separator(),menuItem("Close Tab","close",{"data-tab-id":String(tabId)})),items}function showMenu(items,x,y,{above=!1}={}){if(!items.length)return;menu.replaceChildren(...items),menu.hidden=!1;let inTopLayer=!1;if(menuPopover&&!siteModalOpen(doc))try{menu.matches(":popover-open")||menu.showPopover(),inTopLayer=!0}catch{}menu.classList.toggle("top-layer",inTopLayer);let k=hostScale();if(x*=k,y*=k,above&&(y-=menu.offsetHeight+6),inTopLayer){let view=doc.defaultView;menu.style.left=`${Math.max(4,Math.min(x,view.innerWidth*k-menu.offsetWidth-4))}px`,menu.style.top=`${Math.max(4,Math.min(y,view.innerHeight*k-menu.offsetHeight-4))}px`}else{let box=root.getBoundingClientRect();menu.style.left=`${Math.max(4,Math.min(x-box.left*k,box.width*k-menu.offsetWidth-4))}px`,menu.style.top=`${Math.max(4,Math.min(y-box.top*k,box.height*k-menu.offsetHeight-4))}px`}menu.focus({preventScroll:!0})}let openMenu=(row,x,y)=>showMenu(menuItems(row),x,y);function openAddMenu(x,y){menuFor={add:!0},showMenu([menuItem("New Folder","new-folder"),menuItem("New Space","new-space")],x,y,{above:!0})}function closeMenu(){if(!menu.hidden){try{menuPopover&&menu.matches(":popover-open")&&menu.hidePopover()}catch{}menu.hidden=!0,menuFor=null}}root.addEventListener("contextmenu",event=>{let row=event.target.closest(".tab, .pin, .folder");if(!row||!root.contains(row)||event.target.closest(".folder-name"))return closeMenu();event.preventDefault(),event.stopPropagation(),openMenu(row,event.clientX,event.clientY)}),menu.addEventListener("click",event=>{event.stopPropagation();let item=event.target.closest(".menu-item");if(!item||!menuFor)return;let target=menuFor;closeMenu();let{folderId}=item.dataset;switch(item.dataset.menu){case"pin":return send("pinTab",{tabId:target.tabId,folderId:folderId??null});case"unpin":return send("unpin",{pinId:target.pinId});case"move":return send("moveTabToSpace",{tabId:target.tabId,spaceId:item.dataset.spaceId});case"move-pin":return send("movePin",{pinId:target.pinId,folderId:folderId??null});case"new-folder-pin":return newFolder({pinIds:[target.pinId]});case"new-folder-tab":return newFolder({tabId:target.tabId});case"new-folder":return newFolder();case"new-space":return newSpace();case"rename-folder":return startRename(target.folderId);case"toggle-folder":{let folder=state?.folders?.find(f=>f.id===target.folderId);return folder&&send("setFolderOpen",{folderId:folder.id,open:folder.open===!1})}case"delete-folder":return send("deleteFolder",{folderId:target.folderId});case"close":return send("closeTab",{tabId:Number(item.dataset.tabId),...openOverPage()?{show:!0}:{}})}}),menu.addEventListener("pointerover",event=>event.target.closest(".menu-item")?.focus({preventScroll:!0})),menu.addEventListener("pointerleave",()=>menu.focus({preventScroll:!0})),menu.addEventListener("keydown",event=>{if(event.key==="Escape")return closeMenu(),globalThis.Margin?.shell?.focusCard();if(event.key!=="ArrowDown"&&event.key!=="ArrowUp")return;event.preventDefault();let items=[...menu.querySelectorAll(".menu-item")],at=items.indexOf(menu.getRootNode().activeElement),step=event.key==="ArrowDown"?1:-1;items[(at+step+items.length)%items.length]?.focus()}),root.addEventListener("pointerdown",event=>{!menu.hidden&&!menu.contains(event.target)&&closeMenu()},!0),doc.addEventListener("pointerdown",event=>{let inSidebar=root.contains(event.target)||event.target===root.getRootNode().host;!menu.hidden&&!inSidebar&&closeMenu()},!0),doc.defaultView?.addEventListener("blur",closeMenu);for(let type of["keydown","keyup","keypress"])root.addEventListener(type,e=>e.stopPropagation());let DRAG_START_PX=4,GLIDE_MS=300,SLIDE_MS=180,LAND_WAIT_MS=1200,EDGE_PX2=36,pendingDrag=null,dragging=null,landing=null,gliding=new Set,MARKS=["drop-before","drop-after","drop-into","drop-target","drop-end","drop-unpin"],clearDrop=()=>{for(let node of root.querySelectorAll(MARKS.map(m=>`.${m}`).join(", ")))node.classList.remove(...MARKS)};function keyOf(row){return row.classList.contains("tab")?`tab:${row.dataset.tabId}`:row.classList.contains("pin")?`pin:${row.dataset.pinId}`:row.classList.contains("folder")?`folder:${row.dataset.folderId}`:row.classList.contains("new-tab-row")?"new-tab":null}function rowFor(key){if(key==="new-tab")return tabs.querySelector(".new-tab-row");let[kind,id]=[key.slice(0,key.indexOf(":")),key.slice(key.indexOf(":")+1)],attr=kind==="tab"?"tab-id":kind==="pin"?"pin-id":"folder-id";return root.querySelector(`.${kind}[data-${attr}="${CSS.escape(id)}"]:not(.drag-ghost)`)}let allRows=()=>[...root.querySelectorAll(".pins > .pin, .pins > .folder, .tabs > .tab")],local=(x,y)=>{let box=root.getBoundingClientRect(),k=hostScale();return{x:(x-box.left)*k-root.clientLeft,y:(y-box.top)*k-root.clientTop}};root.addEventListener("pointerdown",event=>{if(pendingDrag=null,event.button!==0||event.ctrlKey||!event.isPrimary||dragging||landing||renaming||pressedAway)return;let target=event.target;if(target.closest?.(".icon, input, .folder-name"))return;let row=target.closest?.(".tab, .pin, .folder");if(!row||!root.contains(row)||root.classList.contains("rail"))return;let key=keyOf(row);if(!key)return;let kind=key.slice(0,key.indexOf(":")),id=kind==="tab"?Number(row.dataset.tabId):kind==="pin"?row.dataset.pinId:row.dataset.folderId;pendingDrag={kind,id,key,pointerId:event.pointerId,x:event.clientX,y:event.clientY,row}}),root.addEventListener("pointermove",event=>{if(dragging&&event.pointerId===dragging.pointerId)return event.buttons&1?moveDrag(event.clientX,event.clientY):cancelDrag();if(!pendingDrag||event.pointerId!==pendingDrag.pointerId)return;if(!(event.buttons&1))return void(pendingDrag=null);let k=hostScale();Math.hypot(event.clientX-pendingDrag.x,event.clientY-pendingDrag.y)*k<DRAG_START_PX||startDrag(event)}),root.addEventListener("pointerup",event=>{dragging&&event.pointerId===dragging.pointerId&&drop(event.clientX,event.clientY),pendingDrag=null}),root.addEventListener("pointercancel",()=>{pendingDrag=null,dragging&&cancelDrag()}),root.addEventListener("lostpointercapture",()=>{dragging&&cancelDrag()});let dropEverything=()=>{pendingDrag=null,dragging&&cancelDrag()};doc.addEventListener("visibilitychange",()=>{doc.hidden&&dropEverything()}),doc.defaultView?.addEventListener("blur",dropEverything),doc.defaultView?.addEventListener("pagehide",dropEverything),doc.addEventListener("keydown",event=>{dragging&&event.key==="Escape"&&(event.preventDefault(),event.stopPropagation(),cancelDrag())},!0);function startDrag(event){let from=pendingDrag;if(pendingDrag=null,!from)return;let row=from.row.isConnected?from.row:rowFor(from.key);if(!row)return;stopHoverWake(),releasePress({instant:!0});let box=row.getBoundingClientRect(),k=hostScale(),at=local(box.left,box.top),ghost=row.cloneNode(!0);ghost.classList.remove("pressed","nested",...MARKS),ghost.classList.add("drag-ghost"),ghost.removeAttribute("data-action"),ghost.setAttribute("aria-hidden","true"),ghost.style.left=`${at.x}px`,ghost.style.top=`${at.y}px`,ghost.style.width=`${box.width*k}px`,root.append(ghost),dragging={kind:from.kind,id:from.id,key:from.key,pointerId:from.pointerId,ghost,grabX:(from.x-box.left)*k,grabY:(from.y-box.top)*k,x:event.clientX,y:event.clientY,where:null},root.dataset.dragging=from.kind;try{root.setPointerCapture(from.pointerId)}catch{}moveDrag(event.clientX,event.clientY)}function moveDrag(x,y){if(!dragging)return;dragging.x=x,dragging.y=y;let at=local(x,y);dragging.ghost.style.transform=`translate(${at.x-dragging.grabX-parseFloat(dragging.ghost.style.left)}px, ${at.y-dragging.grabY-parseFloat(dragging.ghost.style.top)}px)`;let under=root.getRootNode().elementFromPoint(x,y),where=under&&root.contains(under)?dropTarget({target:under,clientY:y}):null;dragging.where=where,clearDrop(),where?.chip?where.chip.classList.add("drop-target"):where?.unpin?tabs.classList.add("drop-unpin"):where?.into?where.row.classList.add("drop-into"):where?.row?where.row.classList.add(where.side==="before"?"drop-before":"drop-after"):where&&pins.classList.add("drop-end"),autoScroll()}let scrolling=0;function autoScroll(){if(scrolling||!dragging)return;let step=()=>{if(scrolling=0,!dragging)return;let box=tabsSection.getBoundingClientRect(),k=hostScale(),top2=(dragging.y-box.top)*k,bottom=(box.bottom-dragging.y)*k;if(top2<0||bottom<0||dragging.x<box.left||dragging.x>box.right)return;let speed=top2<EDGE_PX2?-(EDGE_PX2-top2)/2:bottom<EDGE_PX2?(EDGE_PX2-bottom)/2:0;if(!speed)return;let before=tabsSection.scrollTop;tabsSection.scrollTop+=Math.max(-16,Math.min(16,speed)),tabsSection.scrollTop!==before&&(moveDrag(dragging.x,dragging.y),scrolling=requestAnimationFrame(step))};scrolling=requestAnimationFrame(step)}function endDrag(){let ended=dragging;dragging=null,delete root.dataset.dragging,clearDrop(),scrolling&&cancelAnimationFrame(scrolling),scrolling=0;try{ended&&root.releasePointerCapture(ended.pointerId)}catch{}return ended}function cancelDrag(){let ended=endDrag();ended&&glideBack(ended.ghost,ended.key)}function levelIds(folderId){let pinned=lastView?.pinned??[];return folderId?pinned.find(item=>item.id===folderId)?.pins.map(p=>p.id)??[]:pinned.map(item=>item.id)}let after=(folderId,id)=>{let ids=levelIds(folderId).filter(x=>x!==dragging?.id);return ids[ids.indexOf(id)+1]??null};function dropTarget(point){if(!dragging||!state)return null;let target=point.target,chip=target.closest?.(".chip[data-space-id]");if(chip)return dragging.kind==="tab"&&chip.dataset.spaceId!==lastView?.spaceId?{chip}:null;if(target.closest?.(".tabs")||target===listDivider){if(dragging.kind==="pin")return{unpin:!0};if(dragging.kind!=="tab")return null;let rows=[...tabs.querySelectorAll(":scope > .tab")],row2=target.closest(".tab")??rows.find(r=>point.clientY<=r.getBoundingClientRect().bottom+2.5)??rows.at(-1)??null;if(!row2)return null;let box2=row2.getBoundingClientRect(),side=(point.clientY-box2.top)/box2.height<.5?"before":"after",id=Number(row2.dataset.tabId),at=rows.indexOf(row2),own=rows.findIndex(r=>Number(r.dataset.tabId)===dragging?.id);return id===dragging.id||side==="before"&&at===own+1||side==="after"&&at===own-1?null:{tab:id,row:row2,side}}if(!target.closest?.(".pins-section"))return null;let row=target.closest(".pin, .folder");if(row||(row=[...pins.children].find(r=>point.clientY<=r.getBoundingClientRect().bottom+2.5)??null),!row)return{folderId:null,beforeId:null,row:null};let box=row.getBoundingClientRect(),y=(point.clientY-box.top)/box.height;if(row.classList.contains("folder")){let folderId=row.dataset.folderId;if(dragging.kind==="folder"){if(folderId===dragging.id)return null;if(y<.5)return stays(null,folderId)?null:{folderId:null,beforeId:folderId,row,side:"before"};let last=[...pins.querySelectorAll(`.pin.nested[data-folder-id="${folderId}"]`)].at(-1),beforeId=after(null,folderId);return stays(null,beforeId)?null:{folderId:null,beforeId,row:last??row,side:"after"}}return y<.25?stays(null,folderId)?null:{folderId:null,beforeId:folderId,row,side:"before"}:dragging.kind==="pin"&&levelIds(folderId).includes(String(dragging.id))?null:{into:folderId,row}}let pinId=row.dataset.pinId,level=row.dataset.folderId||null;if(dragging.kind==="folder"&&level||dragging.kind==="pin"&&pinId===dragging.id)return null;let place2=y<.5?{folderId:level,beforeId:pinId,row,side:"before"}:{folderId:level,beforeId:after(level,pinId),row,side:"after"};return stays(level,place2.beforeId)?null:place2}function stays(level,beforeId){if(!dragging||dragging.kind==="tab")return!1;let ids=levelIds(level),at=ids.indexOf(String(dragging.id));return at>=0&&(ids[at+1]??null)===(beforeId??null)}function drop(x,y){moveDrag(x,y);let before=new Map(allRows().map(row=>[keyOf(row),row.getBoundingClientRect()]));dragging?.kind==="tab"&&dragging.where&&!dragging.where.chip&&!dragging.where.unpin&&dragging.where.tab==null&&(root.dataset.landing="tab");let what=endDrag();if(!what)return;let where=what.where;if(!where)return glideBack(what.ghost,what.key);let key=what.key,newPin=null;if(where.chip)return send("moveTabToSpace",{tabId:Number(what.id),spaceId:where.chip.dataset.spaceId}),fadeOut(what.ghost);if(where.unpin){let tabId=lastView?.pinned.flatMap(item=>item.kind==="folder"?item.pins:[item]).find(p=>p.id===what.id)?.tabId;if(send("unpin",{pinId:String(what.id)}),tabId==null)return fadeOut(what.ghost);key=`tab:${tabId}`}else if(where.tab!=null){let near=state?.tabs?.[where.tab];send("moveTab",{tabId:Number(what.id),nextTo:where.tab,side:where.side,...near?{nextToHint:{url:near.url,index:near.index,title:near.title,from:state?.openTabsBy??null}}:{}}).then(moved=>{moved!==!0&&landing?.ghost===what.ghost&&giveUpLanding()})}else{let folderId=where.into??where.folderId??null,beforeId=where.into?null:where.beforeId??null;if(what.kind==="tab")send("pinTab",{tabId:Number(what.id),folderId,beforeId}),key=null,newPin=new Set(allRows().filter(row=>row.classList.contains("pin")).map(row=>row.dataset.pinId));else if(what.kind==="pin"){if(send("movePin",{pinId:String(what.id),folderId,beforeId}),where.into&&lastView?.pinned.find(item=>item.id===where.into&&item.kind==="folder"&&!item.open)&&!rowFor(what.key)?.classList.contains("active"))return fadeOut(what.ghost)}else send("moveFolder",{folderId:String(what.id),beforeId})}landing={ghost:what.ghost,key,newPin,before,from:what.key,timer:setTimeout(()=>giveUpLanding(),LAND_WAIT_MS)}}function land(){if(!landing)return;let row=landing.key?rowFor(landing.key):null;if(!landing.key&&landing.newPin&&(row=[...pins.querySelectorAll(".pin")].find(r=>!landing?.newPin?.has(r.dataset.pinId))??null),!row)return;let was=landing.before.get(landing.key??""),now=row.getBoundingClientRect();if(was&&landing.key===landing.from&&Math.abs(was.top-now.top)<.5){let rows=allRows(),order=keys=>keys.join(" ");if(order(rows.map(r=>keyOf(r)??""))===order([...landing.before.keys()]))return}let{ghost,before}=landing;clearTimeout(landing.timer),landing=null,delete root.dataset.landing;let k=hostScale();for(let other of allRows()){if(other===row)continue;let from=before.get(keyOf(other)??"");if(!from)continue;let dy=(from.top-other.getBoundingClientRect().top)*k;Math.abs(dy)>.5&&other.animate([{transform:`translateY(${dy}px)`},{transform:"none"}],{duration:SLIDE_MS,easing:"cubic-bezier(0.2, 0.8, 0.2, 1)"})}glideTo(ghost,row)}function giveUpLanding(){if(!landing)return;let{ghost,from}=landing;clearTimeout(landing.timer),landing=null,delete root.dataset.landing,glideBack(ghost,from)}function glideTo(ghost,row){let k=hostScale(),g=ghost.getBoundingClientRect(),r=row.getBoundingClientRect(),list=tabsSection.getBoundingClientRect();if(tabsSection.contains(row)&&(r.bottom<list.top||r.top>list.bottom))return fadeOut(ghost);let dx=(r.left-g.left)*k,dy=(r.top-g.top)*k,start=ghost.style.transform||"none",key=keyOf(row);key&&gliding.add(key),row.classList.add("landing");let done=()=>{ghost.remove(),key&&gliding.delete(key),(key?rowFor(key):row)?.classList.remove("landing"),row.classList.remove("landing")},end=`${start==="none"?"":start} translate(${dx}px, ${dy}px)`.trim(),glide=ghost.animate([{transform:start,opacity:.9},{transform:end,opacity:1}],{duration:GLIDE_MS,easing:"cubic-bezier(0.2, 0.8, 0.2, 1)",fill:"forwards"});glide.onfinish=glide.oncancel=done}function glideBack(ghost,key){let row=rowFor(key);row?glideTo(ghost,row):fadeOut(ghost)}function fadeOut(ghost){let start=ghost.style.transform||"none";delete root.dataset.landing;let fade=ghost.animate([{transform:start,opacity:.9},{transform:`${start==="none"?"":start} scale(0.9)`.trim(),opacity:0}],{duration:180,easing:"ease-out",fill:"forwards"});fade.onfinish=fade.oncancel=()=>ghost.remove()}return{el:root,closeMenu:()=>closeMenu(),isBusy:()=>editing!=null||renaming!=null||pendingRename!=null||dragging!=null||resizing!=null||swiping!=null||!menu.hidden,width:()=>resizing?resizing.width:sidebarWidth(state?.settings),update(nextState,context){if(context?.fit&&(fit=context.fit),context&&"newTabPending"in context&&(newTabPending=!!context.newTabPending),context&&"switchingTo"in context&&(switchingTo=context.switchingTo??null),context&&"justShown"in context&&(justShown=!!context.justShown),state=nextState,shownSpace&&(activeSpaceId(state,windowId)===shownSpace||Date.now()-shownSince>SHOWN_SPACE_MS)&&(shownSpace=null,clearTimeout(shownTimer)),menuFor?.tabId!=null&&!state.tabs?.[menuFor.tabId]&&closeMenu(),menuFor?.pinId&&!state.pins?.some(p=>p.id===menuFor.pinId)&&closeMenu(),menuFor?.folderId&&!state.folders?.some(f=>f.id===menuFor.folderId)&&closeMenu(),context?.windowId!=null&&(windowId=context.windowId),context?.tabId!=null&&(currentTabId=context.tabId),render(),Number.isFinite(context?.scroll)){let before=tabsSection.scrollTop;settingScroll=!0,tabsSection.scrollTop=context.scroll,tabsSection.scrollTop===before&&(settingScroll=!1)}if(pendingRename&&state.folders?.some(f=>f.id===pendingRename)){let folderId=pendingRename;pendingRename=null,startRename(folderId)}pendingEdit&&state.spaces.some(s=>s.id===pendingEdit)&&(openEditor(pendingEdit),pendingEdit=null),editing&&!state.spaces.some(s=>s.id===editing.spaceId)&&closeEditor(),renderEditor()},setColorScheme(scheme){root.dataset.theme=scheme}}}var newtabCss=`:root {
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
/* Zoomed (⌘+), the sidebar and the frame keep their size (newtab.js: the
   sidebar is scaled back by 1/zoom, --page-zoom); the launcher grows. */
#sidebar { grid-area: 1 / 1; height: calc(100vh * var(--page-zoom, 1)); }
#launcher, #page-card { grid-area: 1 / 2; margin: calc(8px / var(--page-zoom, 1)) calc(8px / var(--page-zoom, 1)) calc(8px / var(--page-zoom, 1)) 0; }
#launcher, #page-card { border-radius: 6.25px; }
#launcher, #page-card { border-radius: calc(6.25px / var(--page-zoom, 1)); } /* the same, at any zoom */
#launcher {
  min-width: 0;
  overflow-y: auto;
  background: var(--bg);
}
/* The empty screen over this page while switching to another tab
   (sidebar.css .switch-cover): over the card, as on web pages. */
#page-card .switch-cover { position: absolute; inset: 0; width: auto; height: auto; border-radius: inherit; }
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
/* DEVELOPMENT DIAGNOSTICS: remove before release. */
#switch-log { display: flex; align-items: center; gap: 8px; margin-top: 14px; color: var(--muted); }
#switch-log button { font: inherit; color: var(--muted); background: none; border: 1px solid var(--border); border-radius: 8px; padding: 3px 10px; cursor: pointer; }
#switch-log .help { margin: 0; }
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
/* Not page text (shared/dom.js asBrowserUi; its host isn't selectable): the
   field only. */
img { -webkit-user-drag: none; }
input { -webkit-user-select: text; user-select: text; }
.backdrop, .palette { display: none; }
.backdrop.shown {
  display: block;
  position: fixed;
  inset: 0;
  background: transparent; /* catches clicks outside; Arc doesn't dim the page */
}
.palette.shown { display: flex; }

.palette {
  --space-color: #6c5ce7; /* set to the current space's color when opened */
  --fg: #f2f1f4;
  --muted: rgba(242, 241, 244, 0.55);
  --row-hover: rgba(255, 255, 255, 0.06);
  --border: rgba(255, 255, 255, 0.1);

  position: fixed;
  top: calc(32.25vh * var(--page-zoom, 1));
  left: 50%;
  transform: translateX(-50%);
  width: min(765px, calc(100vw * var(--page-zoom, 1) - 32px));
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
/* Short windows (≤ 507, 418, 357 tall in Margin's px, whatever the page's
   zoom: palette.js sets data-short). */
.palette:is([data-short="1"], [data-short="2"], [data-short="3"]) { top: calc(18vh * var(--page-zoom, 1)); }
.palette:is([data-short="2"], [data-short="3"]) { --rows: 4; }
.palette[data-short="3"] { --rows: 3; }

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
`,sidebarCss=`/* The page's zoom doesn't change Margin's size (shared/dom.js setPageZoom):
   viewport units here are written calc(… * var(--page-zoom, 1)). */

/* On web pages, everything here sits in Margin's host, a fixed box of no
   size at the window's top left, positioned absolutely against it: never
   position: fixed itself. WebKit draws each fixed box that shows something
   again on every step of a scroll a page's script makes (smooth-scrolling
   sites; measured: some 30 times the graphics work with the sidebar kept
   open, and three surfaces kept for it), and an absolute one in the host not
   at all. The window's size, which \`inset: 0\` gave a fixed box, is --vw and
   --vh: the room the page has (without classic scroll bars), measured in
   Margin's own pixels (themes/arcadia/content.js followWindow); until then,
   and on Margin's new-tab page, the viewport's. */
.margin-sidebar, .frame, .rims, .card-edge, .switch-cover, .startup-cover, .loader, .pull, .swipe, .notice {
  --vw: calc(100vw * var(--page-zoom, 1));
  --vh: calc(100vh * var(--page-zoom, 1));
}
/* Each its own stacking context, as a fixed box was: what's raised inside
   (the resize handle, the tab menu, a dragged row's copy) stays inside. */
.margin-sidebar.overlay, .frame, .card-edge, .switch-cover, .startup-cover, .loader, .pull, .swipe { z-index: 0; }
/* What --vw and --vh are measured from: the one fixed box, empty and never
   drawn (so it costs nothing as the page scrolls). */
.window-probe { position: fixed; inset: 0; visibility: hidden; pointer-events: none; }
.margin-sidebar, .frame, .rims, .switch-cover, .startup-cover {
  /* One sidebar background for now (Arc-like neutral gray), the same in
     Light and Dark Mode; not tinted by the space or taken from the page.
     Keep in sync with newtab.css and docked.css. */
  --frame: #9c9da1;
}

.margin-sidebar {
  --width: 260px;
  --space-color: #6c5ce7; /* accents only (editor buttons), set per space */
  /* Arc's sidebar (measured from Tirth's screenshot, DECISIONS.md): warm
     near-black text, muted space name and icons, a faint dark hover and an
     opaque light pill for the tab shown. */
  --fg: #1c1702;
  --muted: rgba(0, 0, 0, 0.48);
  --icon: rgba(0, 0, 0, 0.6);
  --hover: rgba(0, 0, 0, 0.045);
  --press: rgba(0, 0, 0, 0.08);
  --active: #ebebeb;
  --border: rgba(0, 0, 0, 0.1);
  --drop: #0a84ff;

  box-sizing: border-box;
  width: var(--width);
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 8px;
  background: var(--frame);
  color: var(--fg);
  font: 14px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
.margin-sidebar *, .margin-sidebar *::before, .margin-sidebar *::after { box-sizing: border-box; }
/* Margin's UI isn't page text (shared/dom.js asBrowserUi; its host isn't
   selectable): nothing to select or drag out, but text fields. */
.margin-sidebar img { -webkit-user-drag: none; }
:is(input, textarea) { -webkit-user-select: text; user-select: text; }

/* Hover (auto-hide): a floating card over the page, inset from the edges.
   Never moves the page. */
.margin-sidebar.overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  height: calc(100vh * var(--page-zoom, 1) - 16px);
  border-radius: 6.25px; /* the page card's (.frame .hole) */
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
  height: calc(100vh * var(--page-zoom, 1));
  border-radius: 0;
  background: var(--frame);
  box-shadow: none;
}

/* Keep open on a page Margin can't fit (pushed; content/layout.js): a narrow
   rail of icons, the page pushed only by its width (off for now:
   platform.compactRail). Resting the pointer on it expands the full sidebar
   over the page (.rail-expanded), which doesn't move; it folds back when the
   pointer leaves. Titles show as tooltips. */
.margin-sidebar.overlay.rail { width: var(--rail, 52px); padding: 0 8px; }
.margin-sidebar.rail .title, .margin-sidebar.rail .icon, .margin-sidebar.rail .editor, .margin-sidebar.rail .resizer, .margin-sidebar.rail .fit-site, .margin-sidebar.rail .folder-name, .margin-sidebar.rail .tab-menu:not(.top-layer) { display: none; }
.margin-sidebar.rail .tab, .margin-sidebar.rail .pin, .margin-sidebar.rail .new-tab-row, .margin-sidebar.rail .folder, .margin-sidebar.rail .folder-toggle, .margin-sidebar.rail .space-title { justify-content: center; gap: 0; padding: 0; }
.margin-sidebar.rail .pin.nested { margin-left: 0; }
.margin-sidebar.rail .top { justify-content: center; }
.margin-sidebar.rail .top .keep-open { margin-left: 0; }
/* Rail and expanded rail stack the bottom bar the same way (the expanded
   one at the rail's x), so expanding only widens the rows: nothing moves
   from under the pointer. */
.margin-sidebar.rail .bar, .margin-sidebar.rail-expanded .bar { display: flex; flex-direction: column; height: auto; gap: 6px; padding: 8px 0; align-items: center; }
.margin-sidebar.rail-expanded .bar { align-items: flex-start; padding-left: 11px; }
.margin-sidebar.rail .spaces, .margin-sidebar.rail-expanded .spaces { flex-direction: column; gap: 4px; max-height: calc(40vh * var(--page-zoom, 1)); overflow-y: auto; scrollbar-width: none; }
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
  position: absolute;
  top: 0;
  left: 0;
  width: var(--vw);
  height: var(--vh);
  overflow: hidden;
}
/* The strips around the card take the pointer, as a browser's frame does
   (chrome.js); the card's corners, inside them, stay the page's. */
.frame .grip { position: absolute; pointer-events: auto; }
.frame:not(.open) .grip { pointer-events: none; } /* not while it fades out */
.frame .grip.top { top: 0; left: var(--width, 260px); right: 0; height: 8px; }
.frame .grip.right { top: 0; right: 0; bottom: 0; width: 8px; }
.frame .grip.bottom { bottom: 0; left: var(--width, 260px); right: 0; height: 8px; }
.frame .hole, .card-edge {
  position: absolute;
  top: 8px;
  right: 8px;
  bottom: 8px;
  left: var(--width, 260px); /* set from settings.sidebarWidth by sidebar.js */
}
.frame .hole, .card-edge { border-radius: 6.25px; }
.frame .hole { box-shadow: 0 0 0 calc(100vmax * var(--page-zoom, 1)) var(--frame); }
.card-edge {
  right: auto;
  bottom: auto;
  width: calc(var(--vw) - var(--width, 260px) - 8px);
  height: calc(var(--vh) - 16px);
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.24), 0 0 3px rgba(0, 0, 0, 0.06);
}
/* Hidden: the frame alone, around the whole page, and the pointer goes
   through it to the page. Out of Keep open, the card's left edge travels here
   with the sidebar; the page is at its full size underneath from the start,
   so nothing is laid out meanwhile. */
.frame.around .grip { pointer-events: none; }
.frame.around .hole { transition: left 200ms ease; }
.card-edge.around { transition: opacity 160ms ease, left 200ms ease, width 200ms ease; }
/* Into Keep open, the same the other way: the sidebar comes in from the left
   with the card's edge. Only for these 200ms: nothing runs at rest. */
.frame.arriving .hole { transition: left 200ms ease; }
.card-edge.arriving { transition: opacity 160ms ease, left 200ms ease, width 200ms ease; }
.margin-sidebar.overlay.arriving { transition: transform 200ms ease; }
.margin-sidebar.overlay.leaving {
  top: 0;
  left: 0;
  height: calc(100vh * var(--page-zoom, 1));
  border-radius: 0;
  box-shadow: none;
  transition: transform 200ms ease, visibility 0s linear 200ms;
}
/* At rest, the same picture in four thin strips (chrome.js rims): each clips
   a copy of the card's edge and frame, and is its own small surface, where a
   surface the size of the window would cost every tab some 18 MB. */
.frame.settled, .card-edge.settled { visibility: hidden; transition: none; }
.rims { position: absolute; top: 0; left: 0; z-index: 0; display: none; pointer-events: none; }
.rims.settled { display: block; }
.rim { --edge: 15px; position: absolute; overflow: hidden; will-change: transform; } /* the frame, and the corner's depth */
.rim.top, .rim.bottom { left: 0; width: var(--vw); height: var(--edge); }
.rim.left, .rim.right { top: var(--edge); width: var(--edge); height: calc(var(--vh) - 2 * var(--edge)); }
.rim.top { top: 0; }
.rim.bottom { top: calc(var(--vh) - var(--edge)); }
.rim.left { left: 0; }
.rim.right { left: calc(var(--vw) - var(--edge)); }
.rim .edge {
  position: absolute;
  width: calc(var(--vw) - 16px);
  height: calc(var(--vh) - 16px);
  border-radius: 6.25px;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.24), 0 0 3px rgba(0, 0, 0, 0.06), 0 0 0 calc(100vmax * var(--page-zoom, 1)) var(--frame);
}
.rim.top .edge { top: 8px; left: 8px; }
.rim.bottom .edge { bottom: 8px; left: 8px; }
.rim.left .edge { top: calc(8px - var(--edge)); left: 8px; }
.rim.right .edge { top: calc(8px - var(--edge)); right: 8px; }
@media print { .rims, .frame, .card-edge { display: none !important; } }
@media (prefers-reduced-motion: reduce) {
  .frame.around .hole, .card-edge.around, .margin-sidebar.overlay.leaving,
  .frame.arriving .hole, .card-edge.arriving, .margin-sidebar.overlay.arriving { transition: none; }
}

button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}
.spacer { flex: 1; }
ul { list-style: none; margin: 0; padding: 0; }

/* Arc's icons (sidebar.js ICONS), one flat gray: drawn black and faded as a
   whole, so overlapping strokes don't come out darker. */
.margin-sidebar .line-icon { display: block; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.margin-sidebar .fill-icon { display: block; fill: currentColor; }
.margin-sidebar .keep-open, .margin-sidebar .bar-button, .margin-sidebar .icon, .margin-sidebar .new-tab-row .plus { color: #000; }
.margin-sidebar :is(.keep-open, .bar-button, .icon, .new-tab-row .plus) :is(.line-icon, .fill-icon) { opacity: 0.6; }

/* The top: the sidebar toggle (Keep open / Auto-hide) where Arc has it, and
   the fit-this-site switch at the right. */
.margin-sidebar .top { flex: none; display: flex; align-items: flex-start; height: 43px; padding-top: 8.75px; }
.margin-sidebar :is(.keep-open, .fit-site, .bar-button) {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 28px;
  border-radius: 7px;
}
.margin-sidebar .keep-open { margin-left: 6px; }
.margin-sidebar .toggle-icon { width: 18.5px; height: 14.5px; }
.margin-sidebar :is(.keep-open, .fit-site, .bar-button):hover { background: var(--hover); }
.margin-sidebar :is(.keep-open, .fit-site, .bar-button):active { background: var(--press); }
.margin-sidebar .fit-site { font-size: 15px; color: var(--icon); }
.margin-sidebar .fit-site[hidden] { display: none; }

/* The space's name (Arc): its emoji and name, muted. */
.margin-sidebar .space-title {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  margin-bottom: 5px;
  padding-left: 10.5px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}
.margin-sidebar .space-title .emoji { flex: none; position: relative; top: -1px; width: 17px; margin: 0 -0.5px; font-size: 17px; line-height: 17px; text-align: center; color: initial; }

/* The space's part (name, editor, list), which a sideways swipe drags; its
   neighbours' pictures (.ghost) slide in beside it, clipped to the sidebar
   (themes/arcadia/sidebar.js "swipe between spaces"). */
.margin-sidebar .space-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.margin-sidebar .space-pane.ghost { position: absolute; pointer-events: none; }
.margin-sidebar.space-swiping { overflow: clip; }
.margin-sidebar.space-swiping .space-pane { will-change: transform; }
.margin-sidebar .space-pane.settling { transition: transform 220ms cubic-bezier(0.25, 1, 0.5, 1); }
@media (prefers-reduced-motion: reduce) {
  .margin-sidebar .space-pane.settling { transition: none; }
}

/* One list for the pinned area and the tabs; it scrolls under the top and
   the bottom bar, never the page; no bounce. */
.margin-sidebar .tabs-section { flex: 1; min-height: 0; margin: 0 -8px; padding: 0 8px 8px; overflow-y: auto; overscroll-behavior: none; }
.margin-sidebar :is(.pins, .tabs) { display: flex; flex-direction: column; gap: 5px; }
.margin-sidebar .pins:empty { display: none; }
.margin-sidebar .divider { height: 1px; margin: 10px 10px; background: var(--border); }
.margin-sidebar .divider[hidden] { display: none; }

/* Rows (Arc): 36 high, 5 apart, radius 12; favicon 16, 10 before the title. */
.tab, .pin, .new-tab-row, .folder {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 6px 0 10px;
  border-radius: 12px;
  cursor: default;
}
.tab:hover, .pin:hover, .new-tab-row:hover, .folder:hover { background: var(--hover); }
/* A press (Arc, sidebar.js): the row shrinks a little while the button is
   down, and springs back as it comes up. */
.tab, .pin, .new-tab-row, .folder { transition: transform 300ms cubic-bezier(0.3, 1.5, 0.5, 1); }
.tab.pressed, .pin.pressed, .new-tab-row.pressed, .folder.pressed { transform: scale(0.97); transition: transform 100ms cubic-bezier(0.2, 0, 0.3, 1); }
@media (prefers-reduced-motion: reduce) {
  .tab.pressed, .pin.pressed, .new-tab-row.pressed, .folder.pressed { transform: none; }
}
.tab.active, .pin.active, .new-tab-row.active {
  background: linear-gradient(#efefef, rgba(239, 239, 239, 0) 2px), var(--active);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
/* While a new tab is being chosen (⌘T, "+ New Tab"): the tab whose page is
   still on screen under the palette, softly; "+ New Tab" fully. */
.tab.behind, .pin.behind, .new-tab-row.behind { background: rgba(255, 255, 255, 0.4); }
/* A page shown again: no hover until the pointer moves (sidebar.js). */
.margin-sidebar.hover-stale :is(.tab, .pin, .new-tab-row, .folder):not(.active):not(.behind):not(.drop-into):hover { background: none; }
.margin-sidebar.hover-stale :is(.tab, .pin):hover .icon { visibility: hidden; }
.margin-sidebar.hover-stale :is(.chip, .bar-button, .keep-open, .fit-site):hover { background: none; }
.margin-sidebar.hover-stale .chip:not(.active):hover { opacity: 0.55; }
/* A folder: its icon, then its name in semibold; its pins indented beneath. */
.margin-sidebar .folder { padding-left: 8px; font-weight: 600; }
.margin-sidebar .folder-toggle { flex: 1; min-width: 0; height: 100%; display: flex; align-items: center; gap: 6px; border-radius: 10px; outline: none; }
.margin-sidebar .folder-toggle:focus-visible { box-shadow: inset 0 0 0 2px var(--drop); }
.margin-sidebar .folder-icon { flex: none; position: relative; top: 1px; width: 22.5px; height: 16.5px; overflow: visible; }
/* Arc's colors: a golden back panel, an off-white front, a dark brown outline. */
.margin-sidebar .folder-icon .folder-back { fill: #d0a004; stroke: #5f4904; stroke-width: 1.2; stroke-linejoin: round; }
.margin-sidebar .folder-icon .folder-front { fill: #f2ecd9; stroke: #5f4904; stroke-width: 1.2; stroke-linejoin: round; }
.margin-sidebar .folder-name {
  flex: 1;
  min-width: 0;
  height: 26px;
  margin-right: 2px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.75);
  color: var(--fg);
  font: inherit;
  outline: 2px solid var(--drop);
  user-select: text;
}
.margin-sidebar .pin.nested { margin-left: 16px; }
/* "+ New Tab", the first row of the tab list (Arc). */
.new-tab-row { color: var(--muted); }
.new-tab-row.active { color: var(--fg); }
.margin-sidebar .new-tab-row .plus { flex: none; display: grid; place-items: center; width: 16px; height: 16px; }
.margin-sidebar .new-tab-row .plus-icon { width: 12px; height: 12px; stroke-width: 1.75; }
.margin-sidebar .title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
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
/* × on a row: shown on hover (Arc). */
.margin-sidebar .icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  visibility: hidden;
}
.margin-sidebar .icon .close-icon { width: 11px; height: 11px; stroke-width: 1.75; }
.tab:hover .icon, .pin:hover .icon { visibility: visible; }
.margin-sidebar .icon:hover { background: var(--press); }

/* Drag and drop (Arc, sidebar.js): a copy of the row follows the pointer
   (the row stays), and glides into its new place once dropped, the row
   hidden under it meanwhile. Where it goes: a line in the space's color, a
   ring at its start, between the rows (measured from Arc: 2px, an 8px ring
   8px in from the row's edge, out to the sidebar's edge); a folder it goes
   into; the tabs while a pin dropped there unpins. An empty pinned area shows
   where a tab can go. */
.margin-sidebar.newtab { position: relative; }
.margin-sidebar .drag-ghost {
  position: absolute;
  z-index: 30;
  margin: 0;
  pointer-events: none;
  opacity: 0.9;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16), 0 1px 2px rgba(0, 0, 0, 0.12);
  transition: none;
  will-change: transform;
}
.margin-sidebar .drag-ghost:not(.active) { background: rgba(255, 255, 255, 0.6); }
.margin-sidebar .drag-ghost .icon { visibility: hidden; }
.margin-sidebar .landing { visibility: hidden; }
.margin-sidebar[data-dragging] :is(.tab, .pin, .folder, .new-tab-row):hover:not(.active) { background: none; }
.margin-sidebar .drop-before::before, .margin-sidebar .drop-after::after, .margin-sidebar .pins.drop-end::after {
  content: "";
  position: absolute;
  z-index: 1;
  left: 8px;
  right: -8px;
  height: 8px;
  background:
    radial-gradient(circle at 4px 50%, transparent 2px, var(--space-color) 2.4px, var(--space-color) 3.6px, transparent 4px) no-repeat 0 0 / 8px 8px,
    linear-gradient(var(--space-color), var(--space-color)) no-repeat 7.5px 50% / calc(100% - 7.5px) 2px;
  pointer-events: none;
}
.margin-sidebar .drop-before::before { top: -6.5px; }
.margin-sidebar .pins > :first-child.drop-before::before { top: -2px; } /* the list's top edge would clip it */
.margin-sidebar .drop-after::after { bottom: -6.5px; }
.margin-sidebar .pins { position: relative; }
.margin-sidebar .pins.drop-end::after { bottom: -6.5px; }
.margin-sidebar .folder.drop-into { background: rgba(10, 132, 255, 0.16); box-shadow: inset 0 0 0 2px rgba(10, 132, 255, 0.6); }
.margin-sidebar .tabs.drop-unpin { border-radius: 12px; box-shadow: 0 0 0 2px rgba(10, 132, 255, 0.45); }
.margin-sidebar:is([data-dragging="tab"], [data-landing="tab"]) .pins:empty {
  display: block;
  height: 36px;
  border: 1.5px dashed rgba(0, 0, 0, 0.25);
  border-radius: 12px;
}
.margin-sidebar:is([data-dragging="tab"], [data-landing="tab"]) .pins:empty::before { content: "Drop to pin"; display: block; line-height: 33px; text-align: center; color: var(--muted); font-size: 13px; }

/* Right-click menu on tabs, pins and folders, and "+" (macOS-style). */
.tab-menu {
  position: absolute;
  z-index: 5;
  min-width: 180px;
  max-width: calc(100% - 8px);
  /* Many folders, many items: it scrolls, its last ones stay reachable. */
  max-height: calc(100vh * var(--page-zoom, 1) - 8px);
  overflow-y: auto;
  overscroll-behavior: contain;
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
.tab-menu[popover] { margin: 0; border: 0; inset: auto; overflow-x: hidden; overflow-y: auto; color: #1c1c1e; }
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
  font-weight: 400;
  outline: none;
  cursor: default;
}
.tab-menu:focus { outline: none; }
.menu-item:focus { background: #0a84ff; color: #fff; }
.menu-separator { height: 1px; margin: 5px 10px; background: rgba(0, 0, 0, 0.12); }

/* The bottom bar (Arc): archive at the left, the spaces in the middle (the
   current one in color, the others faded to gray), "+" at the right. */
.margin-sidebar .bar {
  flex: none;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  column-gap: 4px;
  align-items: center;
  height: 51px; /* 50 under the 1px line */
  margin: 0 -8px;
  padding: 0 9px;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
}
.margin-sidebar .bar .archive { justify-self: start; }
.margin-sidebar .bar .add { justify-self: end; }
.margin-sidebar .bar .archive-icon { width: 14px; height: 16.5px; }
.margin-sidebar .bar .plus-icon { width: 14px; height: 14px; stroke-width: 1.75; }
.margin-sidebar .spaces { display: flex; align-items: center; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
/* An emoji's ink sits at the start of its advance: nudged to look centered. */
.margin-sidebar .chip {
  flex: none;
  position: relative;
  top: -1px;
  width: 30px;
  height: 28px;
  padding: 0 0 0 4px;
  border-radius: 7px;
  font-size: 15px;
  line-height: 28px;
  filter: grayscale(1);
  opacity: 0.55;
}
.margin-sidebar .chip:hover { opacity: 0.85; background: var(--hover); }
.margin-sidebar .chip.active { filter: none; opacity: 1; }
.margin-sidebar .chip.drop-target { outline: 2px dashed var(--chip-color); }

.editor {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 2px 8px;
  padding: 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.2);
  font-size: 13px;
}
.editor[hidden] { display: none; }
.editor .row { display: flex; gap: 6px; align-items: center; }
.editor input {
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.55);
  color: var(--fg);
  font: inherit;
  outline: none;
}
.editor input:focus { border-color: var(--space-color); }
.editor .emoji { width: 40px; flex: none; text-align: center; font-size: 15px; }
.editor .name { flex: 1; }
.swatches { display: flex; gap: 6px; flex-wrap: wrap; }
.swatch { width: 20px; height: 20px; border-radius: 50%; background: var(--chip-color); }
.swatch[aria-checked="true"] { box-shadow: 0 0 0 2px var(--frame), 0 0 0 4px var(--chip-color); }
.editor .actions button { height: 26px; padding: 0 10px; border-radius: 7px; color: var(--muted); }
.editor .actions button:hover { background: var(--hover); color: var(--fg); }
.editor .actions .primary { background: var(--space-color); color: #fff; }
.editor .delete { color: #d63031 !important; }
.editor .delete:disabled { opacity: 0.4; cursor: default; }

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
  position: absolute;
  top: 0;
  left: calc(var(--vw) / 2);
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
  visibility: hidden; /* not drawn at all while idle (below) */
  transition: opacity 200ms ease, transform 240ms cubic-bezier(0.2, 0.9, 0.3, 1.2), visibility 0s linear 240ms;
}
.pull.tracking, .pull.armed, .pull.refreshing { visibility: visible; }
.pull.in-frame { left: calc(var(--width, 260px) + (var(--vw) - var(--width, 260px) - 8px) / 2); }
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
  .pull { transition: opacity 150ms linear, visibility 0s linear 150ms; }
  .pull.armed:not(.refreshing) { transition: opacity 150ms linear; }
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
  position: absolute;
  top: calc(var(--vh) / 2);
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
  visibility: hidden;
  transition: opacity 180ms ease, background-color 120ms linear, visibility 0s linear 180ms;
}
.swipe.active { visibility: visible; transition: opacity 180ms ease, background-color 120ms linear; }
.swipe.in-frame { left: var(--width, 260px); } /* the page card's left edge */
.swipe.forward { left: var(--vw); }
.swipe.forward.in-frame { left: calc(var(--vw) - 8px); } /* the page card's right edge */
.swipe.active { opacity: clamp(0, calc(var(--swipe) * 5), 1); }
.swipe.tracking { transition: none; }
.swipe.armed { background: rgba(38, 38, 38, 0.88); }
.swipe svg { display: block; overflow: visible; transform: translateX(36px); }
.swipe.forward svg { transform: translateX(-36px) rotate(180deg); }
.swipe path { fill: none; stroke: #fff; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }

@media (prefers-reduced-motion: reduce) {
  .swipe { transition: opacity 120ms linear, visibility 0s linear 120ms; }
  .swipe.active:not(.tracking) { transition: opacity 120ms linear; }
}

/* While switching to another tab (shared/switching.js, chrome.js): an empty
   screen over the page, as Arc shows a tab not drawn yet (the card while
   docked; the whole page under a hovered sidebar), with a spinner in the
   middle once the switch takes a moment. On at once with the highlight;
   gone when the new tab is in front (without a fade on the hidden page; a
   short one if the switch failed and this page stays).
   It takes the clicks meant for the page being left. */
.switch-cover {
  position: absolute;
  top: 0;
  left: 0;
  width: var(--vw);
  height: var(--vh);
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--frame) 92%, #fff);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 90ms ease-out, visibility 0s linear 90ms;
}
.switch-cover.in-frame { top: 8px; left: var(--width, 260px); width: calc(var(--vw) - var(--width, 260px) - 8px); height: calc(var(--vh) - 16px); border-radius: 6.25px; }
.switch-cover.on { opacity: 1; visibility: visible; pointer-events: auto; transition: none; }
.switch-cover.instant { transition: none; }
.switch-cover .spinner { overflow: visible; opacity: 0; }
.switch-cover.on .spinner { animation: margin-cover-spin 0.8s linear infinite, margin-cover-show 1ms linear 160ms forwards; }
.switch-cover.on.spinner-now .spinner { opacity: 1; animation: margin-cover-spin 0.8s linear infinite; }
.switch-cover .spinner circle { fill: none; stroke-width: 2.5; }
.switch-cover .spinner .track { stroke: rgba(0, 0, 0, 0.12); }
.switch-cover .spinner .arc { stroke: rgba(0, 0, 0, 0.45); stroke-linecap: round; stroke-dasharray: 28 72; }
@keyframes margin-cover-spin { to { transform: rotate(360deg); } }
@keyframes margin-cover-show { to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .switch-cover.on .spinner { animation: margin-cover-show 1ms linear 160ms forwards, margin-loader-pulse 1.2s ease-in-out 160ms infinite; }
}

/* Margin getting ready after Safari starts or Margin is updated
   (content/ready.js): the whole window, the sidebar too, in the frame's
   color, with the switch cover's spinner and a line of text. */
.startup-cover {
  position: absolute;
  top: 0;
  left: 0;
  width: var(--vw);
  height: var(--vh);
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 14px;
  background: color-mix(in srgb, var(--frame) 92%, #fff);
  color: rgba(0, 0, 0, 0.55);
  font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  letter-spacing: 0.01em;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 180ms ease-out, visibility 0s linear 180ms;
}
.startup-cover.on { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity 120ms ease-out; }
.startup-cover .spinner { overflow: visible; }
.startup-cover.on .spinner { animation: margin-cover-spin 0.8s linear infinite; }
.startup-cover .spinner circle { fill: none; stroke-width: 2.5; }
.startup-cover .spinner .track { stroke: rgba(0, 0, 0, 0.12); }
.startup-cover .spinner .arc { stroke: rgba(0, 0, 0, 0.45); stroke-linecap: round; stroke-dasharray: 28 72; }
@media (prefers-reduced-motion: reduce) {
  .startup-cover.on .spinner { animation: margin-loader-pulse 1.2s ease-in-out infinite; }
}

/* Page-load indicator (Arc): a small dark pill centered over the page. With
   "Keep open" it sits in the frame's 8px top strip; otherwise at the top of
   the page. Fades and widens in, pulses gently while loading, fades out. */
.loader {
  position: absolute;
  top: 2px;
  left: calc(var(--vw) / 2);
  width: 48px;
  height: 4px;
  transform: translateX(-50%) scaleX(0.85);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 250ms ease, transform 250ms ease, visibility 0s linear 250ms;
}
.loader.in-frame { left: calc(var(--width, 260px) + (var(--vw) - var(--width, 260px) - 8px) / 2); }
.loader.on { opacity: 1; visibility: visible; transform: translateX(-50%) scaleX(1); transition: opacity 250ms ease, transform 250ms ease; }
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
  .loader { transition: opacity 150ms linear, visibility 0s linear 150ms; }
  .loader.on { transition: opacity 150ms linear; }
  .loader.on .bar { animation: none; }
}

/* A notice near the left edge (content/core.js: "Margin works in full
   screen"), above the page, never in the way for long. */
.notice {
  position: absolute; top: 12px; left: 12px; z-index: 3;
  display: flex; align-items: center; gap: 8px; max-width: min(420px, calc(var(--vw) - 24px));
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
      <label id="keep-ready-setting" hidden>Keep the tabs of the space you're in ready to show, with no flash, until this long after you last used Safari (minutes, 0 = off; uses a little more battery)
        <input id="keep-ready-minutes" type="number" min="0" max="480" step="5">
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
      <label>With the sidebar hidden, keep the frame around pages
        <input id="frame-when-hidden" type="checkbox" switch>
      </label>
      <label id="fit-setting" hidden>With “Keep open”, fit pages beside the sidebar, laid out as in a narrower window
        <input id="fit-pages" type="checkbox" switch>
      </label>
      <label>With “Keep open”, on pages that can’t be fitted, show a narrow sidebar of icons (it opens fully when you rest the pointer on it)
        <input id="compact-pushed" type="checkbox" switch>
      </label>
      <label id="newtab-hint-setting" hidden>Tell me when ⌘T seems to open Safari’s homepage instead of Margin (Safari Settings → General → “New tabs open with” should be Margin)
        <input id="newtab-hint" type="checkbox" switch>
      </label>
      <fieldset id="shortcuts" aria-describedby="shortcut-help">
        <legend>Keyboard shortcuts</legend>
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
      <!-- DEVELOPMENT DIAGNOSTICS: remove before release (background/diagnostics.js). -->
      <div id="switch-log">
        <span>Switch log (development)</span>
        <button id="switch-log-copy" type="button">Copy</button>
        <button id="switch-log-clear" type="button">Clear</button>
        <span id="switch-log-status" class="help" role="status"></span>
      </div>
    </details>
  </main>
  <div id="page-card" aria-hidden="true"></div>
`;var SVG_NS2="http://www.w3.org/2000/svg";function icon(paths,cls){let svg2=document.createElementNS(SVG_NS2,"svg");svg2.setAttribute("viewBox","0 0 24 24"),svg2.setAttribute("aria-hidden","true"),svg2.setAttribute("class",cls);for(let d of paths){let path=document.createElementNS(SVG_NS2,"path");path.setAttribute("d",d),svg2.append(path)}return svg2}var searchIcon=()=>icon(["M10.5 3.3a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z","M15.6 15.6 19.5 19.5"],"search-icon"),arrowIcon=()=>icon(["M4.5 12h14.5","M12 4.5l7.5 7.5-7.5 7.5"],"arrow-icon"),PREWAKE_DWELL_MS=120,GOES=new Set(["tab","pin","archive","go"]);function createPalette({send,getState,getContext,onLocal,colorScheme,onClose=void 0}){let host=null,panel,input,list,items=[],selected=0,open=!1,restoreFocus=null,backdrop=null,setShown=on=>{backdrop.classList.toggle("shown",on),panel.classList.toggle("shown",on),mark(host,"open",String(on))};function build(){let made=createHost(document,"margin-palette-host");host=made.host;let{shadow}=made;adoptStyles(shadow,paletteCss),asBrowserUi(shadow),input=el(document,"input",{type:"text",class:"query",placeholder:"Search or Enter URL…","aria-label":"Command palette",spellcheck:"false",autocomplete:"off",role:"combobox","aria-expanded":"true","aria-controls":"margin-results"}),list=el(document,"ul",{class:"results",id:"margin-results",role:"listbox"}),panel=el(document,"div",{class:"palette",role:"dialog","aria-label":"Margin command palette"},el(document,"div",{class:"search"},searchIcon(),input),list),backdrop=el(document,"div",{class:"backdrop"}),shadow.append(backdrop,panel);for(let node of[backdrop,panel])containScroll(node);backdrop.addEventListener("mousedown",e=>{e.preventDefault(),close()}),input.addEventListener("input",()=>{selected=0,refresh()});for(let type of["keydown","keyup","keypress"])panel.addEventListener(type,e=>e.stopPropagation());input.addEventListener("keydown",e=>{if(!e.isComposing){if(e.key==="ArrowDown"||e.key==="n"&&e.ctrlKey)move(1);else if(e.key==="ArrowUp"||e.key==="p"&&e.ctrlKey)move(-1);else if(e.key==="Enter")run(items[selected]);else if(e.key==="Escape")close("escape");else return;e.preventDefault()}}),list.addEventListener("mousemove",e=>{let row=e.target.closest("[data-index]");row&&Number(row.dataset.index)!==selected&&(selected=Number(row.dataset.index),paintSelection())}),list.addEventListener("mousedown",e=>e.preventDefault()),list.addEventListener("click",e=>{let row=e.target.closest("[data-index]");row&&run(items[Number(row.dataset.index)])})}function move(delta){items.length&&(selected=(selected+delta+items.length)%items.length,paintSelection())}function paintSelection(){for(let row of list.children){let on=Number(row.dataset.index)===selected;row.setAttribute("aria-selected",String(on)),on&&row.scrollIntoView({block:"nearest"})}prewakeSelected()}let prewakeTimer=null,prewoken=null;function prewakeSelected(){clearTimeout(prewakeTimer);let action=items[selected]?.action;!open||action?.type!=="activateTab"&&action?.type!=="openPin"||(prewakeTimer=setTimeout(()=>{if(!open||items[selected]?.action!==action)return;let key=action.type==="openPin"?`pin:${action.pinId}`:`tab:${action.tabId}`;key!==prewoken&&(prewoken=key,action.type==="openPin"?send("prewake",{pinId:action.pinId,windowId:action.windowId}):action.tabId!==getContext().tabId&&send("prewake",{tabId:action.tabId}))},PREWAKE_DWELL_MS))}function refresh(){let state=getState();state&&(items=rankPalette(state,input.value,getContext()),selected=Math.min(selected,Math.max(items.length-1,0)),list.replaceChildren(...items.map((item,index)=>el(document,"li",{role:"option","data-index":String(index),"data-id":item.id,class:item.kind,title:item.subtitle||item.title},item.emoji?el(document,"span",{class:"avatar emoji",text:item.emoji}):avatar(document,item),el(document,"span",{class:"title",text:item.title}),item.badge?el(document,"span",{class:"badge",text:item.badge}):null,GOES.has(item.kind)?el(document,"span",{class:"go-button"},arrowIcon()):null))),items.length||list.append(el(document,"li",{class:"empty",text:"No matches"})),paintSelection())}function run(item){if(!item)return;if(close("run",item.action),item.action.local)return onLocal?.(item.action);let{type,...payload}=item.action;send(type,payload)}function fitWindow(){let zoom=globalThis.marginPageZoom??1;unzoom(host,zoom);let tall=innerHeight*zoom;panel.dataset.short=tall<=357?"3":tall<=418?"2":tall<=507?"1":""}addEventListener("resize",()=>{open&&host&&fitWindow()});function show(){if(host||build(),fitWindow(),host.isConnected||mountHost(host),typeof host.showPopover=="function"&&!siteModalOpen(document)){host.hasAttribute("popover")||host.setAttribute("popover","manual");try{host.matches(":popover-open")||host.showPopover()}catch{}}restoreFocus=document.activeElement;let state=getState(),ctx=getContext(),spaceId=state?activeSpaceId(state,ctx.windowId):null,color=state?.spaces?.find(s=>s.id===spaceId)?.color;color&&panel.style.setProperty("--space-color",color),setShown(!0),open=!0,prewoken=null,input.value="",selected=0,refresh(),input.focus()}function close(reason=void 0,action=void 0){if(!open)return;open=!1,clearTimeout(prewakeTimer),setShown(!1);try{host.matches?.(":popover-open")&&host.hidePopover()}catch{}input.blur();let shell=globalThis.Margin?.shell;reason==="run"&&action&&opensNewTab(action.type,action)?restoreFocus=null:shell?.card&&(!restoreFocus?.isConnected||restoreFocus===document.body)?shell.focusCard():restoreFocus?.isConnected&&restoreFocus.focus?.({preventScroll:!0}),onClose?.(reason,action)}let lastToggle=0;function toggle(){let now=Date.now();now-lastToggle<200||(lastToggle=now,open?close():show())}return{open:show,close,toggle,isOpen:()=>open,refresh:()=>open&&refresh()}}var SVG_NS3="http://www.w3.org/2000/svg",svgIn=doc=>(tag,attrs)=>{let node=doc.createElementNS(SVG_NS3,tag);for(let[key,value]of Object.entries(attrs))node.setAttribute(key,String(value));return node};function createSwitchCover(doc){let svg2=svgIn(doc),spinner=svg2("svg",{class:"spinner",viewBox:"0 0 28 28",width:28,height:28});spinner.append(svg2("circle",{class:"track",cx:14,cy:14,r:11}),svg2("circle",{class:"arc",cx:14,cy:14,r:11,pathLength:100}));let cover=el(doc,"div",{class:"switch-cover","aria-hidden":"true"},spinner);return{el:cover,set(on,{instant=!1,spinnerNow=!1}={}){cover.classList.toggle("instant",instant),cover.classList.toggle("spinner-now",on&&spinnerNow),cover.classList.toggle("on",on)}}}var $=id=>document.getElementById(id);function mount({api,self,send,windowed=!1}){if(windowed)return mountNote({self,send});let sheet=css=>{let s=new CSSStyleSheet;return s.replaceSync(css),s};document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet(sidebarCss),sheet(newtabCss)],document.body.innerHTML=newtabHtml,asBrowserUi(document,{zoomable:event=>!!event.target.closest?.("#launcher, #page-card")});let pageZoom=1,applyZoom=z=>{!Number.isFinite(z)||z<=0||Math.abs(z-pageZoom)<.001||(pageZoom=z,document.documentElement.style.setProperty("--page-zoom",String(z)),$("sidebar").style.setProperty("zoom",String(1/z)),setPageZoom(document,z))},zoomAnswered=!1,readZoom=()=>(self?.id!=null?api.tabs.getZoom(self.id):Promise.reject()).then(z=>{Number.isFinite(Number(z))&&(zoomAnswered=!0,applyZoom(Number(z)))},()=>{}),zoomTimer=null;addEventListener("resize",()=>{clearTimeout(zoomTimer),zoomTimer=setTimeout(readZoom,60)}),readZoom();let dark=matchMedia("(prefers-color-scheme: dark)"),scrollTimer=null,scrollTop=0,scrollGen=0,flushScroll=()=>{scrollTimer!=null&&(clearTimeout(scrollTimer),scrollTimer=null,send("setSidebarScroll",{top:scrollTop}))},onScroll=top=>{scrollGen++,scrollTop=top,scrollTimer??=setTimeout(flushScroll,150)},SWITCHES=new Set(["activateTab","openPin","closeTab","setSpace"]),withHint=(type,payload)=>{if(!SWITCHES.has(type)||payload?.hint)return payload;type!=="closeTab"&&(lastShown=0);let tab=Number.isInteger(payload?.tabId)&&payload.tabId!==self?.id?state?.tabs?.[payload.tabId]:null;return{...payload,...tab?{hint:{url:tab.url,index:tab.index,title:tab.title,from:state?.openTabsBy??null}}:{},...type==="closeTab"?{}:{deadline:Date.now()+7e3}}},sidebarSend=(type,payload,...rest)=>{if(!SWITCHES.has(type))return send(type,payload,...rest);let sidebarTop=scrollTimer==null?null:scrollTop;return flushScroll(),send(type,withHint(type,{...payload,...Number.isFinite(sidebarTop)?{sidebarTop}:{}}),...rest)},isLauncher=location.hash==="#launcher",newTabPending=!1,setNewTabPending=on=>{newTabPending!==on&&(newTabPending=on,state&&sidebar2.update(state,{windowId:windowId(),tabId:self?.id,newTabPending,switchingTo}))},closer=newTabCloser(setNewTabPending),switchingTo=null,when="now",cover=createSwitchCover(document);$("page-card").append(cover.el);let switching=createSwitching({onChange:id=>{switchingTo=id,(id==null||when==="now")&&cover.set(id!=null,{instant:document.hidden}),state&&sidebar2.update(state,{windowId:windowId(),tabId:self?.id,newTabPending,switchingTo})},onSlow:slow=>slow&&when==="slow"&&cover.set(!0),failed:result=>result===void 0,onFailed:()=>{refresh()},onBlink:times=>{send("pageBlinked",times)}}),fromBackground=backgroundSwitches(),onSwitch=(id,request,{cover:mode="now",inWindow=null}={})=>{if(id===self?.id)return switching.end();id!==-1&&(state?.tabs?.[id]?.windowId??inWindow)!==windowId()||(when=mode,switching.start(id,request))},onNewTab=()=>{isLauncher&&(closer.cancel(),setNewTabPending(!0)),palette.open()},archiveAsked=!1,sidebar2=createSidebar({document,send:sidebarSend,mode:"newtab",onNewTab,onArchive:()=>{archiveAsked=!0,state&&renderLauncher(),$("archive-section").scrollIntoView({behavior:"smooth",block:"start"})},onScroll,onSwitch}),applyColorScheme=()=>sidebar2.setColorScheme(dark.matches?"dark":"light");applyColorScheme(),dark.addEventListener("change",applyColorScheme),$("sidebar").append(sidebar2.el);let state=null,windowId=()=>state?.tabs?.[self?.id]?.windowId??self?.windowId,go=url=>api.tabs.update(self.id,{url});function renderSearchEngine(){let learned=state?.settings?.safariSearch,text=platform?.search==="browser"?"Searches use Chrome’s search engine (Chrome Settings → Search engine).":learned?`Searches use Safari’s search engine: ${learned.name} (seen in Safari’s address bar ${new Date(learned.at).toLocaleString()}). Margin follows it: after changing it in Safari → Settings → Search, search once from Safari’s address bar.`:`Searches use Safari’s default search engine (${SAFARI_DEFAULT.name}) until you search once from Safari’s address bar; from then on, whatever Safari uses (Safari → Settings → Search).`;$("engine-info").textContent=text}$("search").addEventListener("submit",event=>{event.preventDefault();let target=resolveInput($("query").value);target?.kind==="url"?go(target.url):target&&send("search",{query:target.query,tabId:self.id})}),$("query").focus(),$("pin-tiles").addEventListener("click",event=>{let tile=event.target.closest("[data-pin-id]"),pin=state?.pins.find(p=>p.id===tile?.dataset.pinId);if(!pin)return;let key=normalizeUrl(pin.url),open=Object.values(state.tabs).find(t=>t.id!==self.id&&normalizeUrl(t.url)===key);open?send("activateTab",withHint("activateTab",{tabId:open.id})):go(pin.url)}),$("archive-list").addEventListener("click",event=>{let row=event.target.closest("[data-archive-id]");row&&send("restoreArchive",{archiveId:row.dataset.archiveId,replaceTabId:self.id})});let showAllArchived=!1;$("archive-more").addEventListener("click",()=>{showAllArchived=!showAllArchived,renderLauncher()});let usedSaidAt=0,onUse=event=>{!platform?.keepTabsReady||!(Number(state?.settings?.keepTabsReadyMinutes)>0)||!event.isTrusted||Date.now()-usedSaidAt<6e4||(usedSaidAt=Date.now(),send("used"))};for(let type of["pointerdown","keydown","wheel"])addEventListener(type,onUse,{capture:!0,passive:!0});let keepReady=$("keep-ready-minutes");platform?.keepTabsReady&&($("keep-ready-setting").hidden=!1,keepReady.addEventListener("change",()=>{let value=Number(keepReady.value);Number.isFinite(value)&&value>=0&&send("updateSettings",{patch:{keepTabsReadyMinutes:Math.round(value)}})}));let hours=$("archive-hours");hours.addEventListener("change",()=>{let value=Number(hours.value);Number.isFinite(value)&&value>=0&&send("updateSettings",{patch:{archiveAfterHours:value}})});let blockGestures=$("block-gestures"),pullToRefresh=$("pull-to-refresh"),swipeNavigation=$("swipe-navigation"),gestureGuard=null;platform?.blockGestures&&($("gestures-setting").hidden=!1,$("pull-setting").hidden=!1,$("swipe-setting").hidden=!1,gestureGuard=installGestureGuard({getSettings:()=>state?.settings}),blockGestures.addEventListener("change",()=>send("updateSettings",{patch:{blockGestures:blockGestures.checked}})),pullToRefresh.addEventListener("change",()=>send("updateSettings",{patch:{pullToRefresh:pullToRefresh.checked}})),swipeNavigation.addEventListener("change",()=>send("updateSettings",{patch:{swipeNavigation:swipeNavigation.checked}})));let themeSelect=$("theme");themeSelect.replaceChildren(...Object.values(THEMES).map(t=>el(document,"option",{value:t.id,text:t.name,title:t.description}))),themeSelect.addEventListener("change",async()=>{await send("updateSettings",{patch:{theme:themeSelect.value}}),location.reload()});let marginFullscreen=$("margin-fullscreen"),fullscreenOnly=$("fullscreen-only");platform?.marginFullscreen&&($("fullscreen-setting").hidden=!1,marginFullscreen.addEventListener("change",()=>send("updateSettings",{patch:{marginFullscreenAuto:marginFullscreen.checked}})),$("fullscreen-only-setting").hidden=!1,fullscreenOnly.addEventListener("change",()=>send("updateSettings",{patch:{fullscreenOnly:fullscreenOnly.checked}})));let frameWhenHidden=$("frame-when-hidden");frameWhenHidden.addEventListener("change",()=>send("updateSettings",{patch:{frameWhenHidden:frameWhenHidden.checked}}));let fitPages=$("fit-pages");platform?.shell&&($("fit-setting").hidden=!1,fitPages.addEventListener("change",()=>send("updateSettings",{patch:{fitPages:fitPages.checked}})));let compactPushed=$("compact-pushed");compactPushed.closest("label").hidden=!platform?.compactRail,compactPushed.addEventListener("change",()=>send("updateSettings",{patch:{compactWhenPushed:compactPushed.checked}}));let newTabHint=$("newtab-hint");platform?.newTabHint&&($("newtab-hint-setting").hidden=!1,newTabHint.addEventListener("change",()=>send("updateSettings",{patch:{newTabHint:newTabHint.checked}}))),installNavigation({send,getSettings:()=>recording?null:state?.settings});let fresh=!1,cancelOnClose=!1,LEAVES=new Set(["activateTab","openPin","newWindow"]),paletteSend=async(type,payload)=>{if(type!=="prewake"&&(payload=withHint(type,payload)),!fresh||type==="prewake")return send(type,payload);if(fresh=!1,type==="restoreArchive")return send(type,{...payload,replaceTabId:self?.id});let result=await send(type,payload),left=type==="newWindow"||result?.shown!=null;return LEAVES.has(type)&&left&&self?.id!=null&&api.tabs.remove(self.id).catch(()=>{}),result};addEventListener("pagehide",()=>{fresh=!1,cancelOnClose=!1});let palette=createPalette({send:reportingSwitches(paletteSend,()=>state,onSwitch),onClose:(reason,action)=>{newTabPending&&closer.onClose(reason,action),reason!=="run"&&cancelOnClose&&send("cancelNewTab"),reason!=="run"&&(fresh=!1),cancelOnClose=!1},getState:()=>state,getContext:()=>({windowId:windowId(),tabId:self?.id,inNewTab:!newTabPending,canToggleSidebar:!1,canFullscreen:!!platform?.marginFullscreen}),onLocal:action=>{action.local==="navigate"&&go(action.url),action.local==="search"&&send("search",{query:action.query,tabId:self.id})},colorScheme:()=>dark.matches?"dark":"light"});installNewTabKey(()=>{send("newTabKeyUsed"),onNewTab()},globalThis,()=>recording),api.runtime.onMessage.addListener((message,_,sendResponse)=>{message?.type==="command"&&message.tabId===self?.id&&message.command==="open-palette"&&palette.toggle(),message?.type==="command"&&message.tabId===self?.id&&message.command==="new-tab"&&!recording&&onNewTab(),message?.type==="switching"&&message.from===self?.id&&Number.isInteger(message.tabId)&&(onSwitch(message.tabId,fromBackground.begin(message.tabId,message.switchId),{cover:message.cover??(message.passing?"none":"slow"),inWindow:message.windowId??null}),sendResponse(switching.target()===message.tabId&&when==="now")),(message?.type==="switch-done"||message?.type==="switch-failed")&&message.from===self?.id&&fromBackground.settle(message)});let shortcutInputs=[...document.querySelectorAll(".shortcut-input")],shortcutHelp=$("shortcut-help"),defaultHelp=shortcutHelp.textContent,SHORTCUT_NAMES={newTab:"New tab (the command palette)",sidebarShortcut:"Show or hide the sidebar",nextTab:"Next tab",prevTab:"Previous tab",nextSpace:"Next space",prevSpace:"Previous space"},recording=!1;function currentShortcuts(){return{newTab:"Meta+KeyT",sidebarShortcut:state?.settings?.sidebarShortcut??"Alt+KeyS",...navigationFor(state?.settings)}}function saveShortcut(name,combo){return name==="sidebarShortcut"?send("updateSettings",{patch:{[name]:combo}}):send("updateSettings",{patch:{shortcuts:{...navigationFor(state?.settings),[name]:combo}}})}function showHelp(text,error=!1){shortcutHelp.textContent=text,shortcutHelp.classList.toggle("error",error)}for(let input of shortcutInputs)input.addEventListener("focus",()=>{recording=!0,input.value="",input.classList.add("recording")}),input.addEventListener("blur",()=>{recording=!1,input.classList.remove("recording"),renderLauncher()});addEventListener("keydown",event=>{let input=shortcutInputs.find(i=>i===event.target);if(!recording||!input)return;if(event.preventDefault(),event.stopImmediatePropagation(),event.key==="Escape")return input.blur();let combo=fromEvent(event);if(!combo||!parse(combo))return;let name=input.dataset.shortcut,taken=Object.entries(currentShortcuts()).find(([other,value])=>other!==name&&value===combo);if(taken)return showHelp(`${format(combo)} is already used for “${SHORTCUT_NAMES[taken[0]]}”.`,!0);showHelp(defaultHelp),saveShortcut(name,combo),input.blur()},!0),$("shortcuts-reset").addEventListener("click",()=>{showHelp(defaultHelp),send("updateSettings",{patch:{sidebarShortcut:"Alt+KeyS",shortcuts:{...NAVIGATION}}})});let logStatus=$("switch-log-status");$("switch-log-copy").addEventListener("click",async()=>{let count=0,text=send("switchLog",{}).then(entries=>{if(!Array.isArray(entries))throw new Error("no log");return count=entries.length,new Blob([JSON.stringify({version:api.runtime.getManifest().version,platform:platform?.name,entries})],{type:"text/plain"})});try{await navigator.clipboard.write([new ClipboardItem({"text/plain":text})]),logStatus.textContent=`Copied ${count} entries.`}catch{logStatus.textContent=await text.then(()=>!0,()=>!1)?"Couldn’t copy.":"Couldn’t read the log."}}),$("switch-log-clear").addEventListener("click",async()=>{await send("switchLog",{clear:!0}),logStatus.textContent="Cleared."});function ago(ts){let minutes=Math.round((Date.now()-ts)/6e4);if(minutes<1)return"just now";if(minutes<60)return`${minutes}m ago`;let hours2=Math.round(minutes/60);return hours2<48?`${hours2}h ago`:`${Math.round(hours2/24)}d ago`}function renderLauncher(){let view=sidebar(state,windowId());$("pins-section").hidden=view.pins.length===0,$("pin-tiles").replaceChildren(...view.pins.map(p=>el(document,"li",{class:"tile","data-pin-id":p.id,title:p.url},avatar(document,{...p,favIconUrl:iconFor(state,p)}),el(document,"span",{class:"title",text:p.title}))));let all=state.archive??[],archive=showAllArchived?all:all.slice(0,12);if($("archive-section").hidden=all.length===0&&!archiveAsked,$("archive-more").hidden=all.length<=12,$("archive-more").textContent=showAllArchived?"Show fewer":`Show all ${all.length}`,$("archive-list").replaceChildren(...all.length?[]:[el(document,"li",{class:"empty",text:"Nothing archived yet"})],...archive.map(a=>el(document,"li",{"data-archive-id":a.id,title:a.url},avatar(document,{...a,favIconUrl:iconFor(state,a)}),el(document,"span",{class:"title",text:a.title||a.url}),el(document,"span",{class:"when",text:ago(a.closedAt)})))),renderSearchEngine(),blockGestures.checked=state.settings.blockGestures!==!1,pullToRefresh.checked=state.settings.pullToRefresh!==!1,pullToRefresh.disabled=!blockGestures.checked,swipeNavigation.checked=state.settings.swipeNavigation!==!1,swipeNavigation.disabled=!blockGestures.checked,fitPages.checked=state.settings.fitPages!==!1,frameWhenHidden.checked=state.settings.frameWhenHidden!==!1,compactPushed.checked=state.settings.compactWhenPushed!==!1,newTabHint.checked=state.settings.newTabHint!==!1,marginFullscreen.checked=state.settings.marginFullscreenAuto!==!1,fullscreenOnly.checked=state.settings.fullscreenOnly!==!1,document.activeElement!==themeSelect&&(themeSelect.value=themeFor(state.settings).id),gestureGuard?.update(),document.activeElement!==hours&&(hours.value=String(state.settings.archiveAfterHours)),document.activeElement!==keepReady&&(keepReady.value=String(state.settings.keepTabsReadyMinutes??30)),!recording){let values=currentShortcuts();for(let input of shortcutInputs)input.value=format(values[input.dataset.shortcut])}}let version=0,firstDrawn,firstState=new Promise(resolve=>{firstDrawn=resolve}),pendingScroll=null,lastShown=Date.now(),JUST_SHOWN_MS=2e3,reading=0;async function refresh(){let mine=++version;reading++;let raw;try{raw=await api.storage.local.get(null)}finally{reading--}let next=fromStorage(raw);mine!==version||!next.spaces?.length||draw(next)}function draw(next){state=next,zoomAnswered||applyZoom(Number((next.pageZoom?.[location.origin]??next.pageZoom?.["*"])?.[0]??1));let justShown=Date.now()-lastShown<JUST_SHOWN_MS;sidebar2.update(state,{windowId:windowId(),tabId:self?.id,newTabPending,switchingTo,justShown,...pendingScroll!=null?{scroll:pendingScroll}:{}}),pendingScroll=null,renderLauncher(),palette.refresh(),firstDrawn()}api.storage.onChanged.addListener((changes,area)=>{if(area!=="local"||document.hidden&&state)return;if(!state)return void refresh();if(Object.keys(changes).every(key=>key==="showing"))return;if(!takesChanges(changes,{reading,openTabsBy:state.openTabsBy}))return void refresh();let next=withChanges(state,changes);if(!next.spaces?.length)return void refresh();version++,draw(next)});let shown=()=>{lastShown=Date.now();let gen=scrollGen;send("sidebarScroll").then(top=>{!Number.isFinite(top)||gen!==scrollGen||(pendingScroll=top,refresh())}),refresh()};return document.addEventListener("visibilitychange",()=>document.visibilityState==="visible"?shown():flushScroll()),addEventListener("pagehide",flushScroll),addEventListener("pageshow",event=>event.persisted&&shown()),shown(),{openPalette:({fresh:isFresh=!1}={})=>firstState.then(()=>{fresh=isFresh,cancelOnClose=isFresh,palette.open()})}}function mountNote({self,send}){let sheet=new CSSStyleSheet;sheet.replaceSync(newtabCss),document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];let go=el(document,"button",{type:"button",class:"primary",text:"Go full screen"}),always=el(document,"button",{type:"button",text:"Use in windows too"});return go.addEventListener("click",()=>send("toggleFullscreen",{windowId:self?.windowId})),always.addEventListener("click",async()=>{await send("updateSettings",{patch:{fullscreenOnly:!1}}),location.reload()}),document.body.replaceChildren(el(document,"main",{id:"fullscreen-note"},el(document,"h1",{text:"Margin works in full screen"}),el(document,"p",{text:"There Chrome’s toolbar stays out of the way: Margin’s sidebar and palette take its place."}),el(document,"div",{class:"actions"},go,always))),{openPalette(){}}}export{mount};
