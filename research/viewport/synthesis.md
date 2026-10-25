# Synthesis (before adversarial review)

Combined recommendation from all eight investigations. **Not yet reviewed:** three independent reviewers are checking it, and the final report may correct it.

## Verdict

Yes, probably, but only with a different shell than the one we started from, and only on Safari 26.2 or later. It also has a single go/no-go test that has to pass on a real Mac first. The leading idea was to stop the page and load the same URL in an iframe (src=location.href). That cannot work as Margin's general mechanism in Safari. Safari's declarativeNetRequest never applies response-header changes: WebKit's ModifyHeadersAction only has applyToRequest, Apple-reviewed MDN data lists responseHeaders as unsupported in every Safari version, and no rule had any effect in WebKitGTK. So pages that send X-Frame-Options DENY or frame-ancestors 'none' can never be framed. The page's own frame-src CSP also blocks the shell's iframe in WebKit, and every page would be fetched twice, which also breaks POST results, SameSite=Strict and the referrer. The variant that works I call the "transplant shell". At document_start, Margin's content script swaps the page's not-yet-parsed <html> for Margin's shell (sidebar plus card iframe). The browser keeps parsing the real response into the detached tree, where nothing runs. When parsing ends, the script writes that same HTML, with document.open/write, into a same-origin srcdoc iframe sized to the card. From then on, every cross-document navigation inside the card is cancelled with the Navigation API (Safari 26.2+) and redone as an ordinary top-level navigation. No document is ever fetched as a frame, so X-Frame-Options, frame-ancestors and frame-src never come into play, and there is no second request. The page gets a genuinely smaller viewport (innerWidth, 100vw, position:fixed and media queries all match a narrower window), and because the shell is ordinary page content it should behave the same in macOS full screen (not tested). Measured in WebKitGTK 2.52: an X-Frame-Options DENY plus frame-ancestors 'none' page rendered in the card from a single document request, the back/forward list had the right URL and title for every page with and without the back-forward cache, and the browser's loading state waited for the card's subresources. The go/no-go test: Safari must run document_start content scripts while <html> still has no children. WebKit's source says it does, synchronously, but Safari itself is untested. If it fails, there is no extension-only way to get a true narrower viewport, and the closest options are today's push mode or the overlay. Even when it works, some Safari features that only look at the top document are lost or degraded (Reader, Hide Distracting Items, other extensions that only run in the top frame, menu-bar Print), and pages can still detect that they are framed through window.top.

## Recommended architecture

TRANSPLANT SHELL. All artifacts are under /tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad. Sources: r-shell/shell-prototype.js (reviewed); synth/shell5.js and synth/main-wrap5.js (my re-verification).

0. CONTRADICTIONS BETWEEN REPORTS, AND HOW THEY RESOLVE
(a) safari-dnr found that srcdoc framing breaks replaceState with a SecurityError; r-shell found srcdoc works. Both are right because they did different things. r-dnr/server2.js put the HTML into the srcdoc attribute, so the frame URL stays about:srcdoc. The transplant uses srcdoc only as an empty container and then calls document.open/write from the top document, which changes the frame URL to the page URL (measured: frameURL equals the page URL in r-shell/wk-proto.jsonl and synth/out-pc1.jsonl).
(b) alternatives and safari-dnr say nonce CSP pages need nonce rewriting; r-shell says nonces match. The fetch+write variant makes a second request, which returns a fresh nonce that does not match the inherited policy. The transplant reuses the same response, so nonces match.
(c) alternatives says Safari has no matchAboutBlank; MDN BCD lists manifest match_about_blank as Safari 18.4, and the 18.4 release notes agree. The 'not supported' line in Apple's doc is about the tabs.executeScript option, not the manifest key.
(d) proto-webkit says the Navigation API in 26.2 is unconfirmed. It is confirmed: Apple's 26.2 notes say 'Added support for the Navigation API. (158642673)' (r-dnr/dl/s26_2.json).
(e) The failures in proto-webkit and proto-chromium (double fetch, POST becoming GET, SameSite=Strict bypass, lost referrer, X-Frame-Options DENY, frame-src block, wrong back-forward labels) all belong to the src=location.href variant. The transplant avoids them, except that document.referrer inside the frame is still wrong (fixable).
(f) prevalence-security's 'DNR set X-Frame-Options: SAMEORIGIN' and safari-dnr's per-tab rules are moot in Safari, which never applies responseHeaders. The transplant does not need them.
(g) r-shell says detached external scripts and stylesheets are not fetched, yet r-shell/wk-proto.jsonl shows no-store ext.js twice and img.gif three times. Those extra requests are not executions in the top document. They come from preloads for the written markup, and they happen only for no-store resources and only intermittently (r-shell/wk-2.jsonl and wk-t2.jsonl).
(h) r-nav proposes overriding window.self to return top. I advise against doing this globally. It is unmeasured on real sites, and webpack and Next.js runtimes store chunks on self (self.webpackChunk*), while self.addEventListener('message') would listen on the wrong window. Use it only per site.

1. ACTIVATION
The shell is used only while 'Keep open' is on. The decision has to be synchronous at document_start, but storage.local is asynchronous. So the background registers content/shell.js with scripting.registerContentScripts {id:'margin-shell', matches:['<all_urls>'], excludeMatches:<per-site opt-outs>, runAt:'document_start', allFrames:false, world:'ISOLATED'} when Keep open turns on, and unregisters it when it turns off. This is exactly the mechanism Margin already uses for docked.css (DECISIONS.md:133). Safari 26 fixed excludeMatches for registerContentScripts (s26.json, 145489255).
When the sidebar is not pinned, today's overlay stays as it is. When Keep open is turned off on a page that is already shelled, the card simply widens to the full window and the sidebar goes back to overlay/hover, with no reload. When Keep open is turned on for a page that is not shelled, keep today's push until the next navigation, or offer 'Reload into Margin layout'.

2. TOP-FRAME TAKEOVER: content/shell.js, a tiny first script in the isolated world
Skip, leaving today's behaviour, if any of these hold:
- window !== top
- document.contentType is not text/html
- document.documentElement is missing or already has children (injected too late, e.g. the first load after the user grants site access)
- window.opener !== null (popups: measured broken when shelled, r-parity t_popup)
- self.origin === 'null' (CSP sandbox: measured to loop, proto-chromium T7)
- sessionStorage 'margin:noshell' equals location.href
- the re-entrancy flag is already set (WebKit re-runs document_start scripts for any parser-created <html>)
Steps:
(a) Create <html data-margin-shell><head/><body/></html> and document.replaceChild(shell, oldHtml). The parser keeps filling the detached oldHtml, and no page script runs (r-shell/wk-2.jsonl).
(b) Create the card iframe:
  - frame.__marginShellFrame = true. This is an isolated-world expando that page scripts cannot see or forge.
  - frame.name = 'margin-' + random. This is required: measured in synth/out-spa-name0-*.jsonl, without a unique name WebKit restores the frame's child history item on back/forward without the back-forward cache and fetches the page URL as an iframe, which X-Frame-Options DENY blocks.
  - frame.srcdoc = '<!doctype html><title></title>', set before insertion so it adds no history entry and the Navigation API stays enabled.
  - allowfullscreen, plus allow='fullscreen; payment; publickey-credentials-get; publickey-credentials-create; clipboard-read; clipboard-write; geolocation; camera; microphone; display-capture; web-share; autoplay; encrypted-media; picture-in-picture; screen-wake-lock'.
  - No sandbox attribute.
  - Geometry: left = sidebar width, 8px inset top/right/bottom, rounded corners.
  - Style everything with adoptedStyleSheets or CSSOM. A page's style-src blocks <style> elements and style attributes inserted by content scripts in WebKit (p-webkit CSPSTYLE).
(c) A MutationObserver on the detached tree mirrors <title>, link[rel~=icon] and apple-touch-icon, and meta theme-color and color-scheme into the shell head while they stream in. They must be there before parsing ends, because WebKit loads the favicon only once, when main-document parsing finishes (Document.cpp:4493-4509, DocumentLoader.cpp:2526-2544). Measured correct per page in synth/out-pc*.jsonl.
(d) On the shell's DOMContentLoaded (parsing finished), wait for the frame's load, then:
  - Serialize '<!doctype html><html'+attrs+'>' + oldHtml.getHTML({shadowRoots}) + '</html>'.
  - d.open(); d.write(html); d.close(). The frame URL becomes the page URL, the page's CSP and nonces are inherited, and scripts run in their normal order (r-shell/wk-fid2.jsonl).
  - If location.hash is set, call frame.contentWindow.location.replace(location.href). Measured: the fragment is otherwise lost after a transplant during traversal (synth/out-hash-pc0.jsonl, leave-and-back).
  - On traversal (navigation.activation.navigationType === 'traverse'), restore the card's scroll position from top history.state.__scroll.
  - Call frame.contentWindow.focus(). Without it, Space and arrow keys do nothing (p-webkit T9: 0 vs 467px).
  - Drop the oldHtml reference.
(e) Top-window navigate guard (window.navigation 'navigate', isolated world):
  - Ignore destination.sameDocument (the shell's own pushState/replaceState fire cancelable navigate events; p-webkit T3 bug), Margin's own navigations, and traversals.
  - preventDefault for cancelable push/replace navigations to location.href that Margin did not start (frame busting: 127 reloads became 1 in r-shell/wk-bust.jsonl).
  - Treat a script reload while the card is still loading as a bust.
  - Let every other top navigation through. In this design, top-level is the correct place for navigations.

3. FRAME SIDE, ISOLATED WORLD: content/frame.js, all_frames, document_start
Active only when window.parent === top, window.frameElement.__marginShellFrame === true, and location.href !== 'about:srcdoc'. WebKit injects it again into the document.write'd <html> (r-shell; synth main-world probe).
(a) navigation 'navigate', cross-document and cancelable, any origin: preventDefault, then call the shell through a function stored as an isolated-world expando on window.top. This channel is unforgeable by the page; do not use postMessage. The shell then:
  - GET: location.assign(dest). The top document's own script must do this, because WebKit blocks some frame-initiated top navigations (Document.cpp:5393-5432).
  - reload: location.reload().
  - formData: rebuild <form method=post enctype=sourceElement.enctype> in the shell and submit it. Measured: a single top-level POST with the body intact (r-shell/wk-proto.jsonl /form).
  Also add a capture-phase click handler on <a href> that performs the same top-level navigation synchronously inside the user gesture. This guards against Safari's Cocoa-only 'back-forward items created by JS without user interaction are skipped' rule (HistoryController.cpp:574-585).
  Skip downloadRequest, mailto: and custom schemes.
(b) Hash links (hashChange && navigationType === 'push'):
  - preventDefault.
  - The shell stores {__scroll: card scrollY} into the current top entry with replaceState, then calls top history.pushState(null, '', dest).
  - Call frame location.replace(dest).
  Measured correct for push, back, forward and leave-and-return (synth/out-hash-pc1.jsonl).
(c) Forward Margin's keyboard shortcuts, gestures (swipe back/forward, pinch, pull to refresh, blocking Safari's swipe) and the hover-edge reveal from the card window to the shell. Keys go only to the focused frame (r-parity t_ui).
(d) A MutationObserver on the card's <head> mirrors title, icon and theme-color changes live.
(e) On ⌘P: preventDefault and call card.contentWindow.print(). Also add a shell beforeprint/afterprint fallback that hides the sidebar and expands the card to its scrollHeight (measured: all content printed, 4 pages vs 3 unshelled; p-webkit PRINT).

4. FRAME SIDE, MAIN WORLD: content/frame-main.js, world:'MAIN' (Safari 18+ per BCD), all_frames, document_start
Active only when parent === top and the top <html> has data-margin-shell. Measured: it runs in the transplanted frame before any page script (synth/out-pc1.jsonl main-world {framed:true, scripts:0}).
(a) Top-owned history:
  - pushState(s, t, u) becomes frame replaceState(s, t, u) plus top pushState({__margin: id, state: s}, '', location.href).
  - replaceState is mirrored the same way.
  - On top popstate: frame replaceState(state, '', top URL) and dispatch a synthetic PopStateEvent. For fragment-only changes, use location.replace when the target has a hash; when it has none, use replaceState plus synthetic popstate and hashchange plus scroll restore.
  Measured: required and sufficient. Without it, Back landed on about:srcdoc or triggered an XFO-blocked iframe refetch (synth/out-spa-name*-wrap0-pc0.jsonl). With it and a random frame name, all steps were correct with and without the page cache (synth/out-spa-name1-wrap1-pc0.jsonl).
(b) Make document.referrer return top.document.referrer. Measured: the frame otherwise sees 'http://localhost:8951/' instead of 'http://127.0.0.1:8951/' (synth/out-pc1.jsonl).
(c) Optional and per site only: frameElement returns null and parent returns window. window.top cannot be redefined; it is [LegacyUnforgeable] (r-nav).

5. ADDRESS BAR, TITLE AND ICON
The URL is native, because every page is a real top-level navigation. SPA URLs come from the history wrapper, the title and icon from mirroring, and the tab tint from the copied theme-color (Page.cpp:3944-3950 reads only the top document).

6. DNR
None for Safari. It cannot help (ContentExtensionActions.h:110,139), and the transplant does not need it. Optional for the Chrome build only: no header stripping either. Chrome's isolated-world document.write runs under the extension's CSP, so the transplant writer must run in the MAIN world there (r-shell/cr-mw.jsonl). Pages that enforce Trusted Types block that writer, so they fall back.

7. FALLBACK LADDER
Transplant, then today's push mode for loads that are skipped (popups, non-HTML, late injection, opaque origin), then the overlay. Add a per-site 'Show without Margin layout' switch that is written into excludeMatches, and a loop breaker: if the shell is built 3 times for the same URL within 5 s (sessionStorage counter), stop shelling that URL.

## Load-bearing claims

- *verified (source + BCD + WebKitGTK); not run on real Safari*: Safari's declarativeNetRequest can never remove or rewrite X-Frame-Options or CSP response headers, so header-based framing is impossible in Safari.  
  Evidence: WebKit main: ContentExtensionActions.h:110,139 (ModifyHeadersAction has only applyToRequest); ContentExtensionsBackend.cpp:476-495 (applyResultsToRequest). MDN BCD (Apple-reviewed commit e3eb956): RuleAction.responseHeaders safari false. WebKitGTK 2.52: modify-headers rules compile but have no effect (artifacts/p-chromium/results/T7-webkitgtk.txt). Three independent reports agree.
- *verified in WebKitGTK 2.52*: The transplant shell never fetches a document as a frame, so pages with X-Frame-Options DENY, frame-ancestors 'none', or a top-level frame-src without 'self' still render in the card, from one document request.  
  Evidence: I re-ran this. The test page sends 'X-Frame-Options: DENY' and "frame-ancestors 'none'". It rendered in the card with frame URL equal to the page URL, innerWidth 724, and one GET (dest=document, Sec-Fetch-Site cross-site, correct Referer): artifacts/synth/out-pc1.jsonl. r-shell also measured DENY and a frame-src-youtube-only + nonce CSP: artifacts/r-shell/wk-proto.jsonl.
- *verified for WebKit; whether Safari's injection happens at that point is UNVERIFIED (DECISIONS.md:132 reports Safari injecting at 176-266 ms after navigation start, which r-shell reads as time-to-first-byte)*: In WebKit, document_start content scripts run synchronously when the parser creates <html>, before any page script. Swapping documentElement at that moment stops every page script at the top while the parser keeps filling the detached tree.  
  Evidence: HTMLConstructionSite.cpp:327-345 and LocalFrame.cpp:793-861 (r-shell/wk copies); WebExtensionContext.cpp:1442-1458; measured in artifacts/r-shell/wk-2.jsonl (detach: 0 page scripts, parser keeps filling the old tree).
- *verified (WebKitGTK and Chromium)*: The card gets a true narrower viewport. innerWidth, clientWidth, 100vw, position:fixed left:0/right:0, matchMedia and CSS @media all match a window that is actually the card's size. Scrolling and the fixed header behave normally.  
  Evidence: p-webkit T1 (artifacts/p-webkit/out/summary.txt: 732 everywhere, identical to a real 732px window), p-chromium T1, and transplant innerWidth 724 in synth/out-pc1.jsonl.
- *verified in WebKitGTK; Safari's Cocoa-only 'created by JS without user interaction' skip rule is not exercised by GTK*: With the transplant, cross-document navigations are real top-level navigations, so Safari's session history is native. The back-forward list has the right URL and title for every page, and back, forward and leave-and-return all work with and without the back-forward cache.  
  Evidence: artifacts/synth/out-pc1.jsonl and out-pc0.jsonl: bf lists [start, Page A, Page B, Page C], and every traversal lands on the right page. With the page cache off, each traversal makes 1 document request and transplants again. Compare the src variant's wrong labels (p-webkit T4, p-chromium T4).
- *verified in WebKitGTK*: SPA pushState and hash links need two things: a MAIN-world history wrapper (top-owned history) and a unique iframe name. Without either, entries break after a return without the back-forward cache.  
  Evidence: artifacts/synth/out-spa-name0-wrap0-pc0.jsonl, out-spa-name0-wrap1-pc0.jsonl and out-spa-name1-wrap0-pc0.jsonl: broken (Back reaches about:srcdoc, or WebKit refetches the page as an iframe that XFO blocks). out-spa-name1-wrap1-pc0.jsonl: every step correct. out-hash-pc1.jsonl and out-hash-pc0.jsonl: hash push, back and forward correct; the fragment is lost on re-transplant without the page cache unless it is restored.
- *verified (docs)*: Safari supports the pieces the design needs: the Navigation API (26.2), world MAIN for manifest content_scripts (18), registerContentScripts (16.4; excludeMatches fixed in 26), match_about_blank (18.4), getHTML with shadow roots (18) and Trusted Types (26).  
  Evidence: Apple release notes in artifacts/r-dnr/dl (s26_2.json 158642673, s18.json 125513986, s26.json 145489255, 130065736, s18_4.json 145875291). MDN BCD fetched to artifacts/synth/dl/cs.json (content_scripts.world safari 18).
- *verified in WebKitGTK; unverified in Safari*: A MAIN-world document_start content script runs inside the transplanted frame before any page script, with the page URL. WebKit also re-injects the isolated-world script there.  
  Evidence: synth/out-pc1.jsonl messages: main-world {href: page URL, framed: true, scripts: 0} and frame-cs, both before 'transplanted'. r-shell/wk-3.jsonl (re-injection into any parser-created <html>).
- *verified in WebKitGTK; Safari UI unverified*: The browser's loading state covers the card. The top load event and WebView isLoading wait for subresources inside the transplanted frame.  
  Evidence: In synth/out-pc1.jsonl, with a 1500 ms image in the card: isLoading stays true until about 1470 ms, top-load at 1515 ms. estimated_load_progress stayed at 0.3 until it finished, so the progress bar may not advance smoothly.
- *verified in WebKitGTK and Chromium*: The Navigation API lets the shell catch every cross-document navigation in the card and every frame-busting attempt on the top. It works from an isolated world.  
  Evidence: r-shell/wk-proto.jsonl ('to-top' for link/assign/POST), synth/out-pc1.jsonl ('to-top' type push), r-shell/wk-bust.jsonl (127 reloads became 1), r-nav wk-cs.txt (listener in an isolated world cancels busts), Navigation.cpp:1467.
- *likely (source-read); must be measured on Safari*: In the WebKit source, a real click in the card should keep Safari from skipping these pages on Back, even though the top-level navigation is started by Margin's script.  
  Evidence: HistoryController.cpp:574-585 (Cocoa only: a main-frame load without a user gesture is flagged unless the outgoing document has recent activation); FrameLoader.cpp:2849/2930 runs updateForStandardLoad before DocumentLoader::commitData creates the new document, so it checks the old shell document; LocalDOMWindow.cpp:1731-1742 copies activation to ancestor windows; Document.cpp:9994-10005 uses a 10 s window. p-webkit BFSKIP shows WebKit does flag JS-created entries in some cases.
- *verified for the src frame; likely for the transplant frame*: Most features gated on subframes pass in a same-origin frame: notifications and push, geolocation, camera and microphone, screen capture, clipboard, element fullscreen, WebAuthn (scope SameOrigin), Apple Pay, storage and cookies, find-in-page, zoom, downloads, beforeunload.  
  Evidence: r-parity measurements (artifacts/r-parity/out/results.txt) and sources such as Notification.cpp:438-447, PermissionsPolicy.cpp:227-262 and AuthenticatorCoordinator.cpp:106-125. These were measured with src frames; the transplanted frame has the same origin and URL.
- *likely; Reader uncertain*: Some things are tied to the top document and get worse under any iframe shell: Reader, Hide Distracting Items, top-frame-only content scripts of other extensions, menu-bar Print, the sampled top colour, and window.top === window checks.  
  Evidence: ElementTargetingController.cpp:1031-1043; WebExtension.cpp:1502-1505 (all_frames default false); WebExtensionAPIScriptingCocoa.mm:395-396; WKWebView.mm:2000-2005; PageColorSampler.cpp:108-109; measured print 1 page vs 4-6 (p-webkit PRINT, p-chromium T12). Reader is closed source.
- *verified*: No extension-only alternative to an iframe shell exists in shipping Safari. sidebarAction/sidePanel is compiled out and only testable; obscuredContentInsets is embedder-only; meta viewport, @viewport, tabs.setZoom and windows.update fail; the scrollbar-gutter trick cannot host UI.  
  Evidence: PlatformEnableCocoa.h:1115-1117; UnifiedWebPreferences.yaml:7290-7297; WKWebView.h:748-760; WebPage.cpp:3500-3521; r-alt measurements (artifacts/r-alt/meas).
- *verified (Web Almanac data)*: The src=location.href shell would leave many common sites unshelled in Safari, which is why the transplant is needed: X-Frame-Options DENY is 24.6% of XFO values, and "block-all-mixed-content; frame-ancestors 'none'; upgrade-insecure-requests" is the most common CSP value (18-20%).  
  Evidence: artifacts/r-sec/almanac/security-2025.md:262-314, 940-981; measured headers for gist.github.com, pypi.org, bitbucket.org and accounts.google.com (r-sec/hdr).
- *verified (the fix itself is untested)*: Inside the transplanted frame, document.referrer is the page's own origin, not the real referrer. A MAIN-world override from the top document's referrer fixes it.  
  Evidence: synth/out-pc1.jsonl: top topRef 'http://127.0.0.1:8951/' (correct), frame ref 'http://localhost:8951/'.
- *verified in WebKitGTK*: Page CSP still applies to Margin's shell UI in WebKit. A <style> element or style attribute inserted by a content script is blocked under style-src or default-src 'self'; adoptedStyleSheets and CSSOM are not.  
  Evidence: p-webkit CSPPROBE and CSPSTYLE (iframe 304x154 with <style> vs 732x584 with adopted sheets); ContentSecurityPolicy.cpp:190-192.
- *verified (loopback)*: The transplant adds latency. DOMContentLoaded rises 8-17 ms on normal pages and about 93 ms on a 1.2 MB page. On pages that stream their HTML, the first page script waits for the whole HTML (+300 ms with a 300 ms body gap).  
  Evidence: artifacts/r-shell/timing-table.txt (wk tblank vs none; wkbig tsrcdoc2 321.9 vs 228.9 ms).

## What works

- The viewport is genuinely narrower: innerWidth, clientWidth, 100vw, position:fixed edges, matchMedia and CSS media queries all match the card width, and sidebar resizing fires real resize events (p-webkit T1; p-chromium T1).
- Sites that forbid framing (X-Frame-Options DENY, frame-ancestors 'none', top-level frame-src 'none' or limited to youtube, nonce CSP) render in the card, because no document is fetched as a frame (synth/out-pc1.jsonl; r-shell/wk-proto.jsonl).
- Each navigation makes one document request, with the correct Sec-Fetch-Site, Referer and SameSite=Strict behaviour on that request. The src variant's double fetch and Strict-cookie bypass are gone (synth/out-pc1.jsonl server log).
- POSTs keep their body. A top-level POST response is transplanted as is, and a form POST inside the card is resubmitted top-level once with the body intact (r-shell/wk-proto.jsonl /form).
- Native session history: correct URL and title per back-forward entry; back, forward and leave-and-return all work with and without the back-forward cache (synth/out-pc0.jsonl, out-pc1.jsonl).
- SPA pushState and hash links work with the MAIN-world top-owned-history wrapper and a unique iframe name (synth/out-spa-name1-wrap1-pc0.jsonl, out-hash-pc1.jsonl).
- Frame-busting scripts are cancelled by the top window's navigate guard (127 reloads became 1 in r-shell/wk-bust.jsonl; p-webkit T6; p-chromium T6).
- Cross-origin links, location.assign and GET/POST forms in the card become top-level navigations in 29-234 ms (p-webkit T5, measured with the src variant; the same handler is used in the transplant).
- Title, favicon and theme-color are mirrored into the top document, which is what Safari reads (synth/out-pc*.jsonl icons per page; Page.cpp:3944-3950).
- The browser's loading state waits for the card's subresources (synth/out-pc1.jsonl isLoading trace).
- Cookies, localStorage, sessionStorage, IndexedDB, service-worker control and hasStorageAccess match a top-level visit, also with ITP and third-party cookie blocking on (r-parity t_storage).
- Notifications, push, geolocation, camera and microphone, screen capture, clipboard, element fullscreen covering the whole window, downloads, window.open from clicks, beforeunload prompts, find-in-page across frames, and page zoom all work (r-parity; p-webkit FS; p-chromium T13).
- Keyboard focus after frame.contentWindow.focus(): Space and arrow keys scroll the page; typing in the sidebar input still works (p-webkit T9; p-chromium T9).
- Print with a ⌘P intercept, plus a beforeprint expansion fallback that printed all content (p-webkit PRINT: 4 pages vs 3 unshelled).
- macOS full screen: expected to work because the shell is ordinary page content. This follows from how it is built and was not measured.

## Known losses

- HIGH (likely): Safari Reader probably becomes unavailable or empty, because the top document holds only the shell (closed source; uncertain).
- HIGH (likely): 'Hide Distracting Items' treats the whole card as one element (ElementTargetingController.cpp:1031-1043, 1165).
- HIGH (likely): other Safari extensions with all_frames:false content scripts, or that call scripting.executeScript without frameIds, act on Margin's shell instead of the page. Clippers, summarizers and some dark-mode tools break; password managers with all_frames:true keep working (WebExtension.cpp:1502-1505).
- HIGH: pages that check window.top !== window (window.top cannot be overridden) can refuse to render or try to bust. They need the per-site 'Show without Margin layout' switch. The OWASP display:none pattern stays blank after a cancelled bust, so it needs detection and fallback.
- MEDIUM (measured): first paint waits for the complete HTML. Streaming pages (search results, SSR streaming) lose progressive rendering: the first page script is about +300 ms with a 300 ms body gap, and DOMContentLoaded is +93 ms on a 1.2 MB page (r-shell/timing-table.txt). A progressive transplant could recover part of this.
- MEDIUM (measured): menu-bar File > Print and Export as PDF print the top document (1 clipped page) unless the beforeprint fallback expands the card. Pagination is slightly worse (p-webkit PRINT; p-chromium T12).
- MEDIUM: navigation timing and RUM inside the card describe about:srcdoc, with a later time origin. navigation.currentEntry.url stays about:srcdoc in WebKit, which can confuse SPAs built on the Navigation API (r-shell/wk-h3.jsonl).
- MEDIUM (measured): document.referrer in the card is wrong unless the MAIN-world override is installed (synth/out-pc1.jsonl).
- MEDIUM (unverified): password AutoFill and save, passkey conditional UI, Apple Pay sheet and webpage Translate inside a document.write'd same-origin frame. The WebKit gates pass, but Safari's own code is closed.
- LOW-MEDIUM: Safari 26 edge and toolbar colour sampling and fixed-container edge effects come from the shell (PageColorSampler.cpp:108-109). Copying theme-color fixes the tab tint only.
- LOW (measured, intermittent): no-store subresources were sometimes requested twice (preloads for the written markup; r-shell/wk-proto.jsonl). Cacheable resources were not affected.
- LOW: closed declarative shadow roots in the server HTML are lost unless they can be reached for getHTML({shadowRoots}).
- LOW: outerWidth - innerWidth grows by the sidebar width (can trip devtools-detection heuristics); screen and outerWidth still report the full window.
- LOW: service workers see two window clients for the tab (shell and page; r-parity t_swclients, measured with src frames).
- LOW: clicking the sidebar blurs the page's window, so pages that pause on blur will pause (r-parity t_focus).
- NOT SHELLED (fall back to push or overlay): popups with an opener, non-HTML documents (PDF, images, XML), CSP-sandboxed (opaque-origin) pages, the first load after the user grants site access (BCD content_scripts note), and any load where Safari injects after <html> already has children.

## Fallbacks

- Per load, automatic: if any skip condition holds (not HTML, opener, opaque origin, <html> already has children, loop breaker tripped), leave the page unshelled and use today's 'Keep open' push stylesheet (DECISIONS.md:18) or the overlay.
- Per site, user choice: a 'Show without Margin layout' switch in the sidebar context menu. It adds the origin to the registered script's excludeMatches and reloads. Offer it for Reader, Hide Distracting Items, other extensions, and sites that detect framing.
- Loop breaker: if the shell is built 3 or more times for the same URL within 5 s (sessionStorage), set 'margin:noshell' and stop shelling it for that tab session.
- Safari older than 26.2 (no window.navigation): do not register the shell at all and keep push mode. The sandbox-based bust blocking leaks in WebKit, because top.location.replace() still looped (r-nav wk-sandbox.txt).
- If the go/no-go test fails in real Safari (document_start runs after <html> has children), no extension-only true viewport is possible. Keep push mode or overlay, and file Apple Feedback asking for sidebarAction/sidePanel or an extension-settable obscuredContentInsets (WKWebView.h:748-760; r-alt).
- Chrome build: write the transplant from the MAIN world (Chromium's isolated world applies the extension's CSP to written scripts). Pages that enforce Trusted Types block that writer and fall back to push mode. Do not ship DNR header stripping: it was measured to open a same-site clickjacking hole (r-dnr chrome-test.mjs, r-sec cr-matrix).

## Risks

- Go/no-go: Safari might run Margin's document_start content scripts after the parser has already added children to <html>. Then the transplant cannot happen. WebKit's source says injection is synchronous at <html> creation, but DECISIONS.md:132 notes Safari injecting at 176-266 ms, and Safari's extension host might differ. Unverified.
- Safari's Cocoa-only back-forward rule (HistoryController.cpp:574-585) could flag Margin-initiated top-level navigations as 'created by JS without user interaction', so Back would skip pages. The source suggests real clicks are covered through activation propagation, and the synchronous click-handler path adds a second safeguard, but WebKitGTK cannot exercise this rule.
- Safari 27 changed document.open() security-origin aliasing (s27.json 173369038). The transplant depends on document.open from the top document's isolated world, so behaviour on 26.2-26.5 and 27 must both be checked.
- Real-site fidelity: the round trip through the detached DOM, getHTML and document.write may differ from a direct load on heavy apps (Gmail, Google Docs, Figma with COOP/COEP and crossOriginIsolated, YouTube, banks). Examples are legacy encodings, closed declarative shadow roots, scripts that read navigation timing, and Navigation-API SPAs.
- Pages that detect framing via window.top are unfixable; how common they are is unknown.
- Same-origin exposure: page scripts in the card can reach the shell document (parent.document). This is no worse than today, when Margin's UI lives inside the page document behind a closed shadow root. All shell-frame control must stay on isolated-world expandos or extension messaging, never on window.postMessage.
- The r-nav suggestion to override window.self to return top could break webpack/Next.js runtimes (self.webpackChunk*) and message listeners. This is reasoning only, not measured. Ship it only per site.
- Interactions with Margin's existing features (gestures, pinch, pull to refresh, blocking Safari's swipe, the loading pill, shortcuts) all need porting into the frame-side script. Regressions are likely during migration.
- Performance and memory on very large pages: the detached tree, the serialized string and the frame DOM briefly exist at the same time.
- WebKit's navigate rate limiter (200 events per 10 s, Navigation.cpp:1445-1456) could abort legitimate navigations on pages that spam navigations.
- Unknown Safari UI behaviour: whether the progress bar advances smoothly (estimated progress stayed at 0.3 in WebKitGTK), whether paint-holding during navigations causes an empty-card flash, and session restore after quitting Safari.

## Must verify on real Safari

- 1. GO/NO-GO, injection timing (Safari 26.2+ on macOS). Add to sidebar.js logTiming: document.documentElement.childNodes.length and document.readyState at injection, plus navigation responseStart. Test google.com, github.com, youtube.com, a slow site, ⌘R, a cached reload, and back/forward without the back-forward cache. Pass: childNodes is 0 on essentially every load.
- 2. Transplant smoke test as a real Safari Web Extension, using artifacts/synth/shell5.js plus main-wrap5.js as manifest content scripts (isolated world, all_frames; and world:'MAIN'). On a page that sends X-Frame-Options DENY and frame-ancestors 'none' with a nonce CSP (e.g. gist.github.com, pypi.org): does it render in the card; are innerWidth, 100vw, the fixed header and media queries correct; are there no top-level page-script side effects; is the frame location.href the page URL.
- 3. In Safari, are the isolated and MAIN-world document_start scripts injected again into the document.write'd <html>, and is the frameElement.__marginShellFrame expando visible to the frame's isolated world?
- 4. Navigation API in the card: does 'navigate' fire and can it be cancelled for link click, location.assign, form GET and POST, meta refresh, reload and target=_top? Does a top-level location.assign from the shell work? Does a POST resubmitted from the shell keep its body?
- 5. Back-forward list after REAL mouse clicks A to B to C in the card, and after keyboard Enter on a link: Back and Forward land on each page with no skipped entries (the Cocoa wasCreatedByJSWithoutUserInteraction rule). Check the long-press back menu titles, the History menu entries, and leave-and-return.
- 6. Frame-bust guard: a page running 'if (top !== self) top.location = self.location' loads once. Also test the OWASP display:none pattern.
- 7. SPA and hash history on real SPAs (GitHub, YouTube, an app using a Next.js router) with the MAIN-world wrapper and a random frame name: push, back, forward, and leave-and-return with Safari's back-forward cache on and off.
- 8. Safari UI: correct address bar URL, tab title, favicon, Safari 26 tab tint from the copied theme-color, the progress bar and stop button during a page load in the card, Share and Add Bookmark URLs.
- 9. Enter macOS full screen (green button): layout is unchanged and the sidebar sits beside the card. Element fullscreen on a video inside the card fills the screen. Picture in Picture works.
- 10. Password AutoFill (fill and save prompt) and passkeys (conditional UI and modal) on real login pages in the card; the Apple Pay sheet on a test merchant; notification and location prompts showing the right site name.
- 11. Print with ⌘P intercepted and with File > Print; Reader availability; Find; Translate; Hide Distracting Items; one popular top-frame-only extension.
- 12. Performance on heavy or streaming pages (Gmail, Google search, YouTube, Google Docs, Figma for crossOriginIsolated): first paint and interaction delay compared with unshelled.
- 13. scripting.registerContentScripts on Safari: does the registered shell script inject on the very next navigation at document_start, and does excludeMatches work?
- 14. Repeat steps 2-7 on both Safari 26.x and 27 (the document.open origin change, 173369038).

## Implementation plan

- M-shell-0 (probe, no user-facing change): add injection diagnostics to logTiming (childNodes at injection, responseStart) and a hidden developer setting that registers the prototype transplant (synth/shell5.js, main-wrap5.js). Tirth runs must-verify steps 1-4 on Safari. Record the result in DECISIONS.md, and stop here if step 1 fails.
- M-shell-1 (core takeover): add extension/content/shell.js (skip conditions; documentElement swap; card iframe with an isolated-world expando, random name, srcdoc and allow list; adoptedStyleSheets styling; head mirroring; transplant at DOMContentLoaded; fragment and scroll restore; focus handoff; top navigate bust guard). Register and unregister it from background.js with registerContentScripts, tied to Keep open, following the docked.css pattern.
- M-shell-2 (frame side): add extension/content/frame.js (isolated world, all_frames): navigate routing to top-level, including POST rebuild and a synchronous click-path navigation; hash-link handling; live head mirroring; ⌘P. Add extension/content/frame-main.js (world MAIN): top-owned history wrapper, document.referrer override, optional per-site parent and frameElement overrides. Use an expando-based API between frame and shell, never postMessage.
- M-shell-3 (move the sidebar UI into the shell): render the existing sidebar and palette into the shell document. Card geometry follows sidebar width and resize. Keep open off widens the card to full width and switches to overlay/hover without a reload. Forward shortcuts, gestures (swipe, pinch, pull to refresh, Safari swipe blocking), hover-edge reveal and the loading pill from the card window.
- M-shell-4 (fallbacks and parity glue): per-site 'Show without Margin layout' (excludeMatches), sessionStorage loop breaker, push-mode fallback for skipped loads, print fallback (beforeprint expansion), theme-color tint, scroll save and restore on traversal.
- M-shell-5 (tests): unit tests for the skip logic, serialization and history wrapper. Playwright Chromium E2E with a MAIN-world writer for the Chrome build. Add a WebKitGTK harness modelled on artifacts/synth/run.py, run3.py and run5.py, and r-shell/wkrun.py, as an optional local check, because Chromium hides WebKit-specific behaviour (page CSP vs content-script iframes, history restore). Record in DECISIONS.md which Safari checks are still manual.
- M-shell-6 (performance): measure first paint on streaming pages and, if needed, implement a progressive transplant (write completed body children into the open frame document as they arrive).

## Alternatives, ranked

- 1. RECOMMENDED: the transplant shell (described above). It is the only option that gives a true narrower viewport on X-Frame-Options DENY and frame-ancestors 'none' sites without header changes, and with native history, single fetches and working POST. It needs Safari 26.2+ and must pass the injection-timing go/no-go.
- 2. The src=location.href iframe shell (window.stop, then an iframe of the same URL), optionally with a per-site fallback. It double-fetches every page, breaks POST, bypasses SameSite=Strict and loses the referrer. It fails on X-Frame-Options DENY and frame-ancestors 'none' (about 7-9% or more of all sites; 'none' is the most common CSP value) and on pages whose own frame-src CSP lacks 'self'. Safari has no DNR fix for any of this. Strictly worse than option 1.
- 3. Fetch + document.write into an about:blank iframe (safari-dnr, alternatives). It makes a second request with Sec-Fetch-Dest empty and CORS mode, nonces don't match, every navigation needs a fresh iframe, and history must be emulated. Option 1 does better on all of these.
- 4. Today's push mode (an adopted stylesheet with margin-left on <html>). Fixed elements, 100vw and media queries are wrong; this is what Tirth rejected. Keep it only as the fallback for loads that are not shelled.
- 5. Overlay-only sidebar (no layout change). This is what every App Store vertical-tabs extension effectively ships.
- 6. Wait for Safari to ship sidebarAction/sidePanel (compiled out, testable-only in WebKit main) or an extension-settable obscuredContentInsets (embedder-only API); file Feedback. A future option only.
- 7. Not viable: DNR response-header stripping (Safari never applies it), the custom scrollbar gutter (narrows the page but cannot host UI), meta viewport and @viewport (ignored on macOS), tabs.setZoom, windows.update bounds (leaves full screen), the Web Inspector dock (500px minimum, manual), CSS zoom/transform/containment on <html>, JS innerWidth spoofing, and an extension-page iframe (cross-site, so logged out everywhere).
