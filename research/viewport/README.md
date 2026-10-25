# Viewport research (in progress)

The question: can Margin, staying a Safari Web Extension, show pages beside its sidebar laid out exactly as if the window were narrower (fixed headers, full-width sections and breakpoints all right), in macOS full screen too? Tirth's Safari: 27.

**Status (2026-10-25):** 7 of 8 investigations are finished. Still running: the WebKit prototype, then a synthesis, three adversarial reviews and a final report. This folder is a safety copy of what's finished. Nothing here is built into Margin.

- [findings.md](findings.md): every finished investigation's report, unedited (evidence, file:line references, measurements, open questions).
- `artifacts/`: the scripts, test pages, outputs, screenshots and print PDFs the investigations wrote, plus the browser data of the test runs. That covers WebKitGTK profile folders (`r-parity/out/wkdata*`: caches, cookies and storage from local test servers only, checked to contain no real sites) and compiled content-rule-list stores (`cfstore*`). Left out: downloaded WebKit/Chromium source (re-fetchable from GitHub at the cited paths) and cloned prior-art repos. Absolute paths in the scripts point at the cloud session's scratch folder; adjust them to re-run.

| Folder | Investigation |
|---|---|
| `vp/` | First probes: margin vs transform vs filter vs body-scroller vs zoom; the dropped "fit" adapter; JS viewport spoofing |
| `r-dnr/` | Safari declarativeNetRequest header modification |
| `r-nav/` | Navigation API, frame-busting, history sync |
| `r-shell/` | Taking over the top-level document early; the "transplant" shell |
| `r-parity/` | Safari features inside a same-origin frame |
| `r-sec/` | How many sites forbid framing; security of header changes |
| `r-alt/` | Every other possible approach; prior art |
| `p-chromium/` | Working prototype as a real MV3 extension in Chromium |
| `p-webkit/` | Prototype in WebKitGTK (snapshot of an unfinished run) |

## Where it stands

**Only one approach can give a truly narrower page from an extension: show the page inside a same-origin frame of its own tab** (a "shell"). The top-level document holds Margin's sidebar; the frame is the page card and gets a real smaller viewport. Everything else was ruled out with evidence:
- Safari's extension sidebar API exists in WebKit's source but is compiled out and hasn't shipped in any Safari up to 27.
- `<meta viewport>` is ignored on macOS, `tabs.setZoom` is whole-page zoom, `windows.update` leaves full screen, and transforms, zoom, scroller tricks and JS spoofing were measured not to work.

**Confirmed blocker for the simple shell (`<iframe src=location.href>`):** about 7–9% of sites send `X-Frame-Options: DENY` and at least about 4% send CSP `frame-ancestors 'none'`. Safari's DNR accepts response-header rules but never applies them: WebKit only implements request-header changes. So in Safari those headers can't be removed, and the simple shell can't show those sites. The page's own CSP `frame-src` can also block it in WebKit.

**Most promising variant so far, the "transplant" shell** (`r-shell/`, measured end-to-end in WebKitGTK):
1. At document_start, before any page script runs, swap the parser's `<html>` for Margin's shell. The page keeps parsing into a detached tree where nothing runs.
2. When parsing ends, write that tree into a same-origin about:blank/srcdoc frame sized to the card. The page's scripts run there in normal order, with its own URL and CSP nonces.
3. Every navigation inside the frame is cancelled with the Navigation API and done as a normal top-level navigation, POSTs included.

Because no URL is ever *fetched* as a frame, framing headers and `frame-src` never apply, and nothing is fetched twice. The address bar, back/forward and Safari's loading bar stay native.

The costs measured so far: the page appears only once its HTML has fully arrived (about +10–30ms normally, about +90ms on a 1.2MB page; pages that stream lose progressive rendering). It also needs Safari 26.2+.

**Known losses inside a frame:** Reader (likely), Hide Distracting Items, other extensions that only act on the top frame, printing (needs interception). Popups must not be shelled. Single-page apps' `pushState` and anti-clickjacking pages need small main-world shims.

**Must be confirmed on real Safari:** password AutoFill and passkeys in the frame, ⌘P/printing, Reader, translation, the Safari 26/27 tab-bar colours, and that content scripts and the Navigation API behave as in WebKitGTK. See the "Open questions" sections in findings.md.
