# Handoff prompt (paste into a local Claude Code session)

Paste everything below the line into Claude Code, run from your local clone of `tirrth/margin`, after `git fetch && git checkout docs/viewport-research`.

---

You're continuing work on **Margin** (repo `tirrth/margin`, cloned in this folder). Margin is an Arc-browser-style vertical sidebar for **Safari on macOS**, built as an MV3 Safari Web Extension, with a secondary Chrome build. Before anything else, read `CLAUDE.md`, `SPEC.md` and `DECISIONS.md`, and run `git log --oneline -15`. Then read the research files listed below. This prompt is a handoff from a cloud session whose machine is going away, so the repo is now the only record.

## Rules (from CLAUDE.md, SPEC.md and me)
- SPEC.md is the source of truth. Conventional Commits, subject line only, no attribution or co-author lines, no assistant or tool names anywhere (branches, commits, PRs, code). Author: Tirth Patel <github@tirth.io>. Branch names: `type/short-description`.
- Shared code is in `extension/`, per-browser manifest overrides in `platform/<browser>/`. `npm run build` regenerates the committed `dist/safari/` and `dist/chrome/`. Run `npm test` and `npm run test:e2e` (Playwright Chromium) before every commit, then push.
- Record ambiguous decisions in DECISIONS.md, and add manual Safari checks to TESTING.md.
- How I want you to work: don't agree by default; stress-test my ideas and say what's wrong first; no glazing; be direct and concise. Verify before claiming. Earlier, wrong untested advice cost me time (for example, recommending Safari's corner-shape flag, which drew square corners).
- I'm on **Safari 27** (macOS). I use **macOS full screen**.

## Where things stand
- `main` is at `307fcc8 fix(ui): drop corner-shape squircles that safari draws as squares`. All features so far are merged: sidebar, spaces, pins, palette, new tab, archive, Arc frame and page card, Keep open push, loader pill, gesture blocking, pull-to-refresh, swipe back/forward, pinch zoom, browser search engine, right-click tab menu.
- Branch `docs/viewport-research` (research only; nothing in `extension/` changed) contains:
  - `research/viewport/`: README.md (overview and index), synthesis.md (the recommendation), reviews.md (2 adversarial reviews; they take precedence over synthesis.md), findings.md (8 raw investigation reports with evidence and file:line references), and artifacts/ (all scripts, test pages, outputs, screenshots, print PDFs and WebKitGTK test profiles).
  - `research/chrome-fullscreen-toolbar/`: README.md (cause and proposed fix) and artifacts/.
  - Path mapping: scripts in artifacts/ use absolute paths like `/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/<folder>/…`. That folder is `research/viewport/artifacts/<folder>/` (or `research/chrome-fullscreen-toolbar/artifacts/<c-*>/`). The cloud tests ran in WebKitGTK 2.52 (Linux, Safari's engine family) and Playwright Chromium. Neither exists on a Mac by default; on the Mac, test in real Safari.
- Open follow-ups in DECISIONS.md: Safari search-engine learning; trackpad gestures v1 polish; squircles later. Also still open: a magenta flash when switching tabs, waiting on my A/B results.

## Goal 1 (main): a true narrower page beside the sidebar, extension-only
**Problem:** with Keep open, Margin pushes the page with `html { margin-left: W; margin-right: 8px; overflow-x: hidden }` (adopted stylesheet). position:fixed elements stay window-relative (under the sidebar), 100vw elements get clipped, and media queries and innerWidth still see the full window. I want a TRUE Arc experience: the page laid out exactly as if the window were narrower, nothing cut off, in macOS full screen, staying a Safari Web Extension.

**Ruled out, with evidence (don't re-propose):**
- A JS "fit" layer that re-anchored fixed and 100vw elements. Built, tested in Chromium and WebKitGTK, then rejected by me in real Safari ("not working properly"). Branch deleted.
- CSS on `<html>` or a wrapper (transform, filter, containment): fixed elements then scroll away. body or wrapper as scroller: breaks window scroll APIs. CSS zoom: WebKit's 100vw ignores it. JS spoofing of innerWidth or matchMedia: layout ignores it. Custom-scrollbar gutter: narrows the page but can't host UI.
- `<meta viewport>`: ignored on macOS. tabs.setZoom, windows.update (leaves full screen), Web Inspector dock: no.
- Safari's extension sidebar API (sidebarAction/sidePanel): compiled out in WebKit and not shipped through Safari 27.
- An iframe on the extension's own page: Safari blocks third-party cookies, so I'd be logged out.
- My constraints rule out: my own browser (maintenance), a native companion window or Accessibility hacks, Split View, Window → Fill instead of full screen.
- DNR header stripping: Safari's declarativeNetRequest accepts responseHeaders but never applies them (WebKit only has ModifyHeadersAction::applyToRequest; MDN BCD says responseHeaders is unsupported in Safari). Pages with X-Frame-Options DENY or frame-ancestors 'none' (about 7-9% and at least 4% of sites) can't be framed by URL in Safari. The page's frame-src CSP also blocks content-script iframes in WebKit.

**The one viable approach found: the "transplant shell"** (details in synthesis.md, corrected by reviews.md; prototype in `research/viewport/artifacts/synth/` (shell5.js, main-wrap5.js) and `artifacts/r-shell/shell-prototype.js`):
1. At document_start (WebKit runs these synchronously when the parser creates `<html>`, before any page script), swap the parser's `<html>` for Margin's shell: sidebar plus a card iframe. The page keeps parsing into the detached tree, where nothing runs.
2. When parsing ends, write that HTML (Element.getHTML with shadow roots, plus the original doctype) with document.open/write into a same-origin srcdoc/about:blank card iframe. Defer the write by one task, or load/onload are lost. The card has a genuinely smaller viewport and the page's own URL and CSP nonces.
3. Cancel every cross-document navigation inside the card with the Navigation API (Safari 26.2+) and redo it as a normal top-level navigation, POSTs included. No URL is ever fetched as a frame, so XFO, frame-ancestors and frame-src never apply, and there's no double fetch. Address bar, back/forward and Safari's loading bar stay native.
4. A guard on the top window's navigate event stops frame-busting reload loops. Mirror title, favicon, theme-color and color-scheme into the shell. Hand focus to the card (iframe.contentWindow.focus()). Never shell popups, POST results, non-HTML, non-UTF-8 or opaque-origin documents.

**Measured costs and losses** (WebKitGTK unless noted):
- First paint waits for the full HTML: +10-30ms normally, about +90ms on 1.2MB; streaming pages lose progressive rendering.
- Without a paint-hold step, navigations flash an empty card.
- Scroll position is lost on reload and on Back without the back-forward cache, and typed form fields are lost on Back without it.
- Navigation-API SPAs become full reloads.
- beforeunload "Leave page?" is asked twice.
- Password save (WebKit's will-submit-form hook) doesn't see the real form.
- Reader, Hide Distracting Items, top-frame-only extensions, menu Print (needs ⌘P interception), Translate (maybe), content-blocker hiding rules keyed on the page URL, text-fragment links, and window.close() all degrade.
- target=_parent from cross-origin iframes silently fails, and page top.location calls can be blocked by WebKit's third-party redirect rule.
- Pages can detect framing (window.top).

Toggling Keep open on an already-loaded page stays in push mode until the next load. A SPEC exception is needed: SPEC lists "iframing other sites" and "header stripping" as out of scope. This is self-framing with no header changes, but I must approve it.

**Next steps for Goal 1, in order:**
1. **GO/NO-GO in real Safari 27:** instrument `extension/content/sidebar.js` logTiming to log `document.documentElement.childNodes.length`, `document.readyState` and navigation `responseStart` at injection. Test google.com, github.com, youtube.com, a slow site, ⌘R, a cached reload, and back/forward. It passes if childNodes is 0 on essentially every load. If it fails, the transplant can't work. The fallback is the fetch-and-write variant (more limits); otherwise keep push or overlay.
2. If it passes, build a minimal Safari test extension from `artifacts/synth/shell5.js` and `main-wrap5.js` (an isolated document_start content script plus a world:'MAIN' script). Run the 10-step real-Safari checklist in synthesis.md ("Must verify on real Safari"): DENY/'none' pages like gist.github.com and pypi.org, the viewport, re-injection into the written document, Navigation API cancel, back/forward after real clicks, frame-bust, SPAs (GitHub/YouTube), Safari UI (URL, title, favicon, tab tint, progress bar), full screen and video fullscreen, password AutoFill and passkeys.
3. Only then decide with me whether to build it into Margin (with paint-hold, scroll persistence, the skip list, and a per-site "show without Margin" switch), as an opt-in mode first.

## Goal 2 (Chrome build): the toolbar stays visible after ⌘T/⌘N in full screen
**Cause** (Chromium source plus Linux Chrome measurements): in Mac full screen, Chrome keeps the toolbar revealed while the omnibox has focus. ⌘T and ⌘N start with omnibox focus, and Margin's hand-off can leave it there. On ⌘N or a failed ping, the palette opens on the chrome://newtab page; if the omnibox had focus before ⌘T, Chrome restores it.

**Proposed fix (not applied),** full code in `research/chrome-fullscreen-toolbar/README.md`, tested build in `artifacts/c-verify/margin-ext-fix2`; strip its 127.0.0.1:8794 test probes:
- The new-tab page `location.replace`s itself to `newtab.html?palette` (Chrome only).
- The hand-off checks `document.hasFocus()` about 150ms after show-palette, and falls back to `tabs.create(newtab.html?palette)`.

It can't remove Chrome's 1-second toolbar flash on every tab switch, or keys typed in the first ~0.1-0.25s. Verify on the Mac using the checklist in that README. Safari is unchanged.

## What I want first
Summarize your understanding in a few lines, then help me run the Goal 1 go/no-go test in Safari 27 (step 1 above). Don't start building the shell into Margin until it passes and I agree.
