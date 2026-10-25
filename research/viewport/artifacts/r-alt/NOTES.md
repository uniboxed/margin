# r-alt: completeness sweep (other ways to get a narrower layout viewport in a Safari Web Extension)

Scratch: /tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-alt
  meas/       WebKitGTK 2.52.6 + Chromium measurements (sb.html, gut.html, srv.js, srv2.js, reopen.html, wkrun*.py, wkpoll.py, cr.mjs)
  bcd/        MDN browser-compat-data JSON (sidebarAction, sidePanel, manifest keys)
  apple/      Apple "Assessing your Safari web extension's browser compatibility" (compat.json, compat.txt)
  prior/      gorvis + tkdailey11 Safari vertical-tab extensions, Hypothesis side-by-side, Apache Ripple source

## 1. Extension sidebar API (sidebarAction / sidePanel)
- WebKit main (2026-10-24): ENABLE_WK_WEB_EXTENSIONS_SIDEBAR defined `0 && ENABLE_WK_WEB_EXTENSIONS` (Source/WTF/wtf/PlatformEnableCocoa.h:1115-1117)
- runtime pref WebExtensionSidebarEnabled: status `testable`, default false ("not ready to ship... Enabled in test infrastructure only")
- API namespace only exposed when that pref is on (WebExtensionAPINamespace.cpp ~109-117)
- active work: _WKWebExtensionSidebarSide Left/Right with WK_MAC_TBA (WKWebExtensionControllerDelegatePrivate.h:33-37,166)
- Safari release notes 17.0 through 27.0 (27.0 shipped 2026-09-14): no sidebar/sidePanel entries
- MDN BCD main: safari version_added false for sidebarAction, sidePanel, sidebar_action, side_panel
- Apple compat doc: no sidebar keys or APIs listed
=> Not available. If Safari ships it, the browser app decides placement (NSViewController in a pane); it would probably narrow the page like Chrome's side panel, but that can't be verified.

## 2. meta viewport / @viewport / zoom / window bounds / Responsive Design Mode
- macOS WebPage::viewportPropertiesDidChange is UNUSED_PARAM (only iOS family, and GTK/WPE with fixed layout, use it) (WebPage.cpp:3500-3521)
- measured on WebKitGTK: meta viewport width=600 leaves innerWidth 1000; the @viewport rule is dropped (cssRules.length 0)
- tabs.setZoom maps to WKWebView.pageZoom (WebExtensionTabCocoa.mm:633-642): it scales the whole page and frees no space
- windows.update with a frame forces state Normal, which means leaving full screen (WebExtensionContextAPIWindowsCocoa.mm:298-302)
- Responsive Design Mode and _setFixedLayoutSize/_layoutMode are embedder or Web Inspector only. No extension IDL exposes viewport, layout or insets (37 IDLs grepped)
- WKWebView.obscuredContentInsets (macOS 26) "shrink the bounds of the layout viewport" (WKWebView.h:748-758). This is exactly the right primitive, but only Safari.app (the embedder) can set it.

## 3. Web Inspector docked left + devtools panel
- AttachmentSide::Left resizes the inspected WKWebView (WebInspectorUIProxyMac.mm:833-845), so it really does narrow the page
- minimum attached width is 500px (InspectorFrontendClientLocal.cpp:78,443-445)
- the user has to open it manually for each tab; there is no extension API to open it (devtools IDL has only inspectedWindow, network, panels)
- inspector chrome stays visible
=> not viable

## 4. Custom root scrollbar gutter (NEW candidate; measured, then ruled out)
- html{overflow-y:scroll; direction:rtl} body{direction:ltr} ::-webkit-scrollbar{width:300px}
- WebKitGTK result: clientWidth, visualViewport.width, the fixed containing block, % widths and media queries (WebKit MQ width = frameView.layoutWidth(), MediaQueryFeatures.cpp:752-764) all become 700. innerWidth and 100vw stay 1000.
- source: usesLegacyScrollbarStyle / shouldPlaceVerticalScrollbarOnLeft = !isAnyLeftToRight (StyleComputedStyle+GettersInlines.h:101-109)
- BUT the gutter is a scrollbar:
  - fixed and top-layer (popover) content is clipped at its edge (meas/wk-gut-x.png)
  - elementFromPoint returns null over it
  - clicks reach the DOM only as target=HTML, and the track scrolls the page (scrollY 0 -> 1700 -> 2200)
  => it cannot host the sidebar UI

## 5. iframe-shell variant: about:blank iframe + fetch + document.open/write (measured, both engines)
- with XFO DENY + frame-ancestors 'none': iframe src, <object> and <embed> are all blocked
- document.open from the shell works:
  - the frame URL becomes the shell's URL
  - innerWidth 700, cookies present, scripts run, pushState works, relative URLs resolve
- caveats (measured):
  - (a) the frame inherits the shell's CSP. Strict-nonce sites are blocked unless nonces are rewritten (rewriting works)
  - (b) real in-frame navigations (link click) are still blocked by XFO, so they must be intercepted (Navigation API: Safari 26.2+) or the headers stripped
  - (c) re-running document.open in the same realm throws "Can't create duplicate variable", so every navigation needs a fresh iframe
- unmeasured caveats:
  - the request is a fetch (Sec-Fetch-Dest: empty), not a navigation
  - service worker navigation semantics
  - POST results can't be re-fetched
  - streaming and preload behaviour

## 6. Prior art
- Safari App Store vertical tabs: gorvis "Vertical Tabs" (content.js: html{margin-left:50px;width:calc(100%-50px)}) and tkdailey11 (body margin) both push the page with margins and have the same breakage
- DigitalN Side Tabs: a native app using AX that resizes Safari's window; in full screen it can only overlay (DockController.swift:158-210)
- Hypothesis client: push approach plus a heuristic main-content finder (html.ts:26,201-230)
- Apache Ripple Chrome extension = same-origin self-iframe shell:
  - document.open/write at document_start (targets/chrome.extension/bootstrap.js)
  - document.URL loaded in iframe#document (pkg/hosted/ripple.js _post/_createFrame)
- Split-Screen Workspace (Firefox) / Responsive Viewer: DNR strips XFO, but frames sit on an extension page (third-party cookies)
