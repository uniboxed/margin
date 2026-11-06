# The test site

Pages for the e2e suite that look and behave like real sites. All local: one server, one port, a host name per site under `.test`.

## Use it

```js
import { HOST_RULES, startSite, searchResults } from './site/server.js';

const site = await startSite();                  // { port, url(host, path), sites, close }
site.url('dispatch.test', '/2026/11/the-quiet-city');
```

- Start Chromium with `--host-resolver-rules=${HOST_RULES}`. `*.test` goes to the server. Every other host fails to resolve.
- A search engine's address: answer it with `searchResults(q, site.port)` (a `context.route`). It lists this site's own pages.
- `site.sites` has every site: `host`, `name`, `look` (colours), `pages` (`path`, `title`, `what`).
- To look at every page: `node tests/e2e/site/shoot.mjs [out dir]`.
- `tests/e2e/site.test.js` checks the site itself.

## On every site

- `/missing`, or any path a site doesn't have: that site's 404 page, status 404.
- `?fp` on any page: a recorder at the top of `<head>` notes where `<html>` sits in each of the first 40 frames (`window.__fp`). `&late=N` holds Margin's word to the box back until N ms.
- `/media/art/<kind>.svg?…`: drawn pictures (`art.js`).
- Nothing is logged unless `MARGIN_E2E_VERBOSE` is set.

## The sites

| Address | What it is | Icon | Handles for tests |
|---|---|---|---|
| `margin.test/` | The index: a card per page | SVG | |
| `dispatch.test/2026/11/the-quiet-city` | Magazine article: hero, drop cap, pull quotes, sticky section bar with reading progress, sticky share rail | SVG | `theme-color` |
| `dispatch.test/longread` | Same layout, a 180-character title | SVG | `site.sites[…].longTitle` |
| `dispatch.test/` | The magazine's front page | SVG | |
| `shop.test/` | Shop grid: filters, 24 products, a sideways carousel | PNG | `#carousel` (scrolls sideways, `overscroll-behavior-x: contain`) |
| `shop.test/p/canvas-tote` | Product page | PNG | `#add`: title becomes `(1) Bag · Canvas Tote — Common Goods`. Every product has `/p/<slug>` |
| `reel.test/watch` | Video page, the local clip | PNG | `#big-play` or `video.play()`; loops, muted |
| `docs.test/guide/getting-started` | Docs: sticky nav, TOC with scroll spy, code with Copy, anchors, tabs | ICO | `#install`, `#first-store`, … (hash links); media queries at 1180 and 860 px; `vw` in `h1` |
| `murmur.test/home` | Social feed, infinite scroll | SVG | Title `(3) Murmur`; more posts from `/api/feed` near the end (5 pages); Notifications clears the count; `?live=<ms>` adds a post that often |
| `metrics.test/` | Dashboard: KPIs, SVG and canvas charts, a live number | none linked, `/favicon.ico` | "Active now" changes every 2 s |
| `post.test/inbox` | Mail: folders, list, reading pane, compose | data: URL, redrawn with the count | Title `Inbox (4) — Post`; clicking an unread `.m` lowers it; `#compose`, `#c-to`, `#c-subject`, `#c-body`: typing adds a `beforeunload` guard; `#c-send` and `#c-discard` clear it |
| `noir.test/` | Dark portfolio, Archivo Black and Space Grotesk | SVG | Dark `theme-color`, `color-scheme: dark` |
| `accounts.test/signin` | Sign-in form | SVG | `#email`, `#password`; POST `/signin`: `wrong` as the password gives the form again (200 from a POST); anything else 302 to `/welcome` |
| `embed.test/` | A post of frames | none (a letter) | `#f-weather` (same site), `#f-map` (maps.test, text field `#find`), `#f-poll` (srcdoc), `#f-comments` (sandboxed, textarea `#comment`) |
| `maps.test/` | Map site; also framed at `/embed` | a bad one: `/pin.png` is an HTML page | `#find` |
| `slow.test/report` | Report sent in parts over about 3 s, pictures last | PNG | `?ms=<total>` changes the pace; `load` comes at the end |
| `harbor.test/` | Travel site: fixed nav, sticky sub-nav, cookie bar, chat bubble, a modal | ICO | `#open-dates` opens the modal and locks scroll (`body.locked`, overflow hidden); Escape closes; `#cookie-ok`; `#chat` |
| `focus.test/` | Timer: title counts down each second | data: URL, redrawn each second | `?paused`, `?from=<seconds>` |
| `radio.test/` | Podcast player, `<audio>` with a made-up tune, chapters | ICO | `#play` or `audio.play()`; Media Session metadata |
| `app.test/` | Single-page app | SVG | Links move by `pushState`; `/reports` is intercepted by the Navigation API and takes 700 ms (`.report-ready` when drawn) |
| `search.test/search?q=…` | Results page (the search stand-in) | SVG | |

## Files

- `server.js`: the server.
- `sites/`: one module per site; `index.js` lists them.
- `art.js`: the drawn pictures.
- `make-media.mjs`: PNG and ICO icons and the tune, made in memory at start.
- `make-video.mjs`: makes `files/reel/clip.webm`. Run it by hand; the clip is committed.
- `shoot.mjs`: screenshots of every page.
- `SOURCES.txt`: where everything comes from.
