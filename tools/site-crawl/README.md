# Site crawl

Every site of a top-sites list loaded through Margin's page box, and compared with the same site loaded plain. Headless only: nothing shows on screen, sound is muted.

```sh
npm run build                      # the overlay (dist/app); the extension is built from source by the harness
node tools/site-crawl/crawl.mjs --list ~/margin-crawl/top-10000.csv --out ~/margin-crawl/run --workers 3
node tools/site-crawl/summarize.mjs --out ~/margin-crawl/run
```

- The list: `rank,domain` lines (Tranco's top-1m, its first 10 000: `curl -sSfL https://tranco-list.eu/top-1m.csv.zip | …`).
- Margin's side is the e2e harness (`tests/e2e/harness/margin.js`, `web: true`): the test build of the extension in headless Chromium, linked to the stand-in Margin.app, a full-screen window with Arcadia's overlay and the sidebar kept open, so each site is shrunk into the slot as in Safari. The plain side is headless Chromium at the slot's size, with no extension.
- Each site goes in `results.jsonl` as it's done. Run it again with the same `--out` and it goes on from there. `--limit N` for a trial.
- Verdicts: `ok`; `flagged` (loaded both ways, something only Margin's load shows: `no-box`, `drawn-off-slot`, `wrong-width`, `sideways-overflow`, `content-cut-off`, `text-missing`, `elements-missing`, `blank`, `looks-different`, `more-errors`); `margin-failed` (loaded plain, not through Margin); `plain-failed` (the site doesn't load by itself: down, an API host, blocked); `skipped` (an adult word in its domain); `error` (the crawler's own trouble with it).
- `looks-different` compares two small greyscale grids of the first screen: a moving page (ads, a carousel, a video) can differ by itself, so it's a hint to look, not a finding.
- Pictures, in `shots/`: both loads of every flagged or failed site, and of every 100th.
- It's Chromium, not WebKit: Safari-only behaviour (WebKit's own layout, Safari's content blockers) isn't seen here.
