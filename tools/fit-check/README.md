# Fit check

Every site of the top 10 000 (Tranco's list) loaded through Margin's page box, and compared with the same site loaded plain. Headless only: nothing shows on screen, sound is muted.

## Every night

```sh
npm run fit-check                 # before bed: starts in the background, stops starting sites at 07:30
npm run fit-check -- --status     # how far it is, whether it's running
npm run fit-check -- --stop       # stop it now (the sites under way finish, the data is stored)
npm run fit-check -- --publish    # commit and push the data now (it's done at the end of every night)
```

It goes on from where the last night stopped. When every site of the list is done (a round), the next round begins, so each site gets a history and a site that changes with Margin's code shows up as worse or better.

- `--until 07:30` (local time) or `--hours 6`: when to stop starting sites. `--workers 3`.
- `--code main` (the default): Margin's code tested is `main`'s commit, checked out and built in a checkout of its own (`~/Library/Caches/margin-fit-check/code`), whatever this checkout is doing. A branch or a commit works too; `--code here` tests this checkout as it is. Each row says which commit it tested.
- `--wait`: stay in the foreground. `--data DIR`: another data folder.
- `--no-publish`: leave the night's data unpublished. `--store`: make `sites/`, `all-sites.csv` and `summary.md` again from the rounds (it's done after every night anyway).
- `--import DIR --import-commit SHA [--list CSV]`: an earlier `check.mjs --out` folder taken in as round 1.
- The Mac has to stay awake. If it sleeps, the night stops there and the next start goes on.

## The data: `tools/fit-check/data/`, published on the branch `data/fit-check`

The folder is git-ignored on the code branches (it changes every night). At the end of each night it's committed to the branch `data/fit-check` and pushed, so anyone with the repo can read it on GitHub. That branch holds the data alone, at the same path, with no code. It's committed from a checkout of its own (`~/Library/Caches/margin-fit-check/publish`), so this checkout and its branch are never touched.

Published: everything in the table below, but of the pictures only each flagged or margin-failed site's latest. Locally, a round's pictures are kept until the round after next begins, so the round before stays to compare.

| File | What's in it |
| --- | --- |
| `summary.md`, `summary.json` | every site at its latest: verdicts, flags, worse and better since the round before, the margin-failed and flagged sites |
| `all-sites.csv` | a row per site, its latest (opens in Numbers) |
| `sites/<domain>.json` | one site: its latest result in full, every round's verdict, flags, load times, commit and pictures, and its last change |
| `rounds/NNNN/` | a round as it was crawled: `results.jsonl` (a line per site, as it's done), `log.txt`, `progress.json`, `shots/`, `summary.md`, `finished.txt` once it's done |
| `list.csv` | the sites, `rank,domain` (downloaded the first time; kept, so the rounds compare) |
| `nightly.log` | what each night did |
| `running.json` | who's running now (only on this Mac) |

`sites/`, `all-sites.csv` and the summaries are made from the rounds' `results.jsonl`, which is the record: delete them and `--store` makes them again.

## What it does with a site

- Margin's side is the e2e harness (`tests/e2e/harness/margin.js`, `web: true`): the test build of the extension in headless Chromium, linked to the stand-in Margin.app, a full-screen window with Arcadia's overlay and the sidebar kept open, so each site is shrunk into the slot as in Safari. The plain side is headless Chromium at the slot's size, with no extension, launched the same way and in the same color scheme. Each Margin world has its own plain browser, and both are made again after 150 sites or a site that hangs.
- Verdicts:
  - `ok`.
  - `flagged`: it loaded both ways, and something shows only in Margin's load: `no-box`, `drawn-off-slot`, `wrong-width`, `sideways-overflow`, `content-cut-off`, `text-missing`, `elements-missing`, `blank`, `looks-different`, `more-errors`.
  - `margin-failed`: it loaded plain, not through Margin.
  - `blocked`: the site turned the plain browser away too (401, 403 or 429, or a captcha page). It says nothing about Margin.
  - `plain-failed`: the site doesn't load by itself (it's down, or an API host).
  - `skipped`: an adult word is in its domain.
  - `error`: the crawler's own trouble. The site is tried again, up to 3 times a round.
- `looks-different` compares two small greyscale grids of the first screen. A moving page (ads, a carousel, a video) can differ by itself, so it's a hint to look, not a finding.
- Pictures, in `shots/`: both loads of every flagged or failed site, and of every 100th.
- It's Chromium, not WebKit, so Safari-only behaviour isn't seen here (WebKit's own layout, Safari's content blockers).

## By hand

```sh
npm run build
node tools/fit-check/check.mjs --list list.csv --out some/folder --workers 3 [--limit N] [--until ISO]
node tools/fit-check/summarize.mjs --out some/folder
```
