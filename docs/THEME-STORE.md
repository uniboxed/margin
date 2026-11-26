# The theme store: share, find and generate themes (plan, 2026-11-25)

Tirth's decisions (2026-11-25):

- People **upload themes from inside Margin** (not by pull requests).
- People can **write a prompt and get a theme**, paid from the monthly API credit of his Ultra plan ($200 of Claude
  Console API credit a month, linked to one Console organization).
- **Everyone** can generate, within a **daily limit**, a **quota plan** and **rate limits**.
- **No accounts** (2026-11-25): nobody signs up. Each Margin install has an anonymous key of its own.
- A small server of Margin's own is fine.
- Also wanted: **"load unpacked"**, a theme folder Margin follows as it's edited, like Chrome's unpacked extensions.

Nothing here changes the security boundary. A theme from the store, from the generator or from a linked folder is a
package like any import, checked by the same code (`ui/theme-import.ts`, `ui/theme-loader.ts` `checkPackage` and
`sanitizeTheme`), shown in the same preview bar before it's used, stored by margin-core (`data::themes`). Themes
still run no JS and load nothing from outside their package.

## What the credit allows

- The Ultra plan's monthly credit is Console API credit "for building your own apps and agents on the Claude Platform"
  (Anthropic's help centre, "Monthly API credits for Max, Ultra and Team plans"). It goes to one linked Console
  organization, everyone with a key in that organization draws from it, and it doesn't roll over.
- When it's used up and the organization has no other credit or auto-reload, API requests stop until next month:
  a hard ceiling. Keep auto-reload off.
- The page links Supplemental Credit Terms and the Commercial Terms, not read here: Tirth to skim them once for
  anything about serving end users.
- Generation uses an API key only (never a plan login), kept on the server only (never in Margin.app), in a Console
  workspace of its own with a spend limit, so other keys in the organization can't drain it.

## The parts

```text
Margin.app ──────────────► themes server (Cloudflare Worker)
  Settings › Themes (Margin's own)       /v1/themes …    D1: users, themes, versions, reports, ledger
  Share, Generate, Load unpacked         /v1/generate ─► Claude API (key in a Worker secret)
  install: verify signature,             R2: packages, screenshots
    the same import check + preview      Browser Rendering: the screenshots, rendered from the package
```

- **Server code in this repo** (`cloud/themes/`, TypeScript, Wrangler), next to the app's code it shares (the zip
  reader's caps, `theme.json`'s schema). Secrets (the API key, the signing key)
  live only in Worker secrets. The repo is public: no names, addresses or keys in code, logs or issues.
- **Cloudflare, on the free plan** (Tirth, 2026-11-25: no $5 plan): Workers (the API), D1 (records), R2 (files),
  Durable Objects (per-person limits, counted exactly: SQLite-backed ones are free since April 2025), Browser Rendering
  (screenshots: 10 minutes of browser time a day, 3 at once), the free `*.workers.dev` address until there's a domain.
  The free plan's daily allowances: 100,000 requests (Workers and Durable Objects each), D1 5 million rows read and
  100,000 written, R2 10 GB. Each is a hard stop (an error until 00:00 UTC), never a bill. Upgrade only when they're
  reached.
- **The free plan gives a request 10 ms of CPU**, and Margin's full theme check takes about 18–35 ms (measured on an M-series
  Mac: Arcadia, Pixel, Material). So the server never runs it. The check that matters already runs on every device:
  Margin checks a theme before it's uploaded and every time it's installed or loaded, and refuses it there. The server
  checks only what's cheap: the size, the zip's shape and caps, `theme.json`'s fields, the sha256. A theme that
  slipped past an altered app is refused on every device that installs it, and review hides it.

## Where each piece goes (docs/HOSTING-CORE.md, "follow the architecture")

| Piece | Where |
|---|---|
| The store's rules: the index read and its signature checked, versions compared, an update offered, an installed theme's source (`store`, `generated`, `linked`, `file`), a linked folder's reload rule | margin-core (`data::themes` and a new `themes::store`), one copy for the Mac and Windows |
| HTTP, the Keychain (the install's key), the proof of work's hashing, App Attest if it's used, watching a linked folder (FSEvents; Windows: ReadDirectoryChangesW) | each platform: mechanism only |
| The checks (`checkImport`, `sanitizeTheme`) | `app/shared/ui` as today, also run by the server |
| Settings' Themes, Generate, Share, the quota shown | Margin's own UI parts (HTML/CSS, guarded like Settings: only Margin's words), drawn in every theme |
| Generation, uploads, moderation, limits | the server |

## 1. Load unpacked (first: everything else uses it)

- Settings › Themes › **Load Unpacked…** picks a folder. Margin keeps a link to it (not a copy) and draws it as the
  window's theme, marked "linked" in Settings.
- Margin watches the folder. On each save it reads the folder again (the same caps as a folder import), checks it, and
  redraws. A theme that fails keeps the last good version on screen, with the reasons shown in a small panel (file and
  rule, the same words the import uses).
- **Unlink** goes back to the theme from before. A linked theme is per Mac, like imports.
- `npm run theme:check <folder>`: the same check from the command line (for people writing themes and for the skill).

## 2. No accounts: an anonymous key per install

Nobody signs up (Tirth, 2026-11-25). The server still has to tell installs apart, for the daily limits and for who may
update a theme, so each install has a key of its own:

- **The key**: an Ed25519 key pair Margin makes the first time it's needed. Its private half is a file in Margin's own
  data folder (`theme-store/key`, readable by the person only), never sent anywhere. (Not the Keychain, decided
  2026-11-25 while building it: a login-keychain item asks the person again whenever Margin is signed differently, as
  development and release builds are, and iCloud Keychain needs a provisioned keychain group a Developer ID app doesn't
  have. A file never asks, and is backed up with Margin's data. So the key is per Mac for now.) The server knows only
  the public key, and its id (the first 16 bytes of the public key's SHA-256, in hex).
- **Registering it costs a proof of work**: the server hands out a challenge (random, signed by the server, valid 10
  minutes), and the app finds a nonce whose SHA-256 with the challenge and the public key starts with enough zero bits
  (28 zero bits: about 1.6 seconds on an M-series Mac's cores, measured in margin-core, once per install). This is invisible to people, and it makes minting thousands of keys
  slow and costly for a script.
- **Every request after that is signed** with the key: the method, the path, the time and the body's SHA-256. The server
  refuses a time more than 5 minutes away and a signature that doesn't verify.
- **What the key buys**: the daily points (per key), uploads (the key that first uploaded a theme's id owns it; only
  that key publishes new versions), and reports (one per key per theme).
- **What it can't stop, and what bounds it**: someone who wipes their data, or a script that pays the proof of work
  again, gets a fresh key and fresh points. Per-network limits slow that, and the day's budget caps it: the worst case
  is that day's generation running out early for everyone, never a cost beyond the credit.
- **App Attest, if it works for Margin**: Apple's proof that a request comes from the real Margin on a real Mac (macOS
  27 added Macs; whether a Developer ID build gets it is to be tested on Tirth's Mac). If it does, registering a key
  also needs an attestation, and keys from real Macs could get more points.
- **Blocking**: Tirth can block a key from the review page; its uploads are hidden and its requests refused.

## 3. Upload from inside Margin

- **Share Theme…** on an imported, linked or generated theme: name, description, tags, then upload.
- The app sends the `.margintheme` package. The server, in order:
  1. checks the signature, and the key's and the network's rates (5 uploads a day per key, 20 per network);
  2. checks its size, its zip's shape and caps and its `theme.json` (the full check is the app's, before it uploads and
     on every device that installs it: the free plan's 10 ms of CPU is too little for it here);
  3. stores the package in R2 under its sha256;
  4. renders screenshots with Browser Rendering (the theme's own template over a fixed sample state, light and dark:
     never a picture the uploader sent);
  5. records a version, in review.
- **Review**: a key's uploads are reviewed by Tirth (a small admin page behind a secret: screenshots, the cheap checks'
  notes, approve or reject, block the key) until two of them are approved. After that the key is trusted: its new
  versions publish at once and can still be reported. Reports (`POST /v1/reports`, one per key per theme) hide a theme
  after three, pending review.
- **The author's name** is the display name typed when sharing (40 characters at most, controls and bidi characters
  removed), shown with the key's short id so two authors can't pass as each other.
- Names: unique slugs; names that impersonate Margin, Apple or another author are refused in review.

## 4. Themes in Settings (find and install)

- **Settings › Themes** (Tirth, 2026-11-25: a category of Settings, not a page of its own, so every theme draws it with
  the rows it already draws, people's imported themes too): each store theme's name, version, author with its key's
  short id, description, and what it is here (to install, installed, an update, or "you have a theme of your own with
  this id", never replaced from the store), with **Try** (or **Update to x**) and **Report…**; Refresh, and the store's
  state (loading, not open yet, why not). Search, tags and sections (Featured, New, Popular) when there are enough
  themes to need them.
- **No screenshots for now** (Tirth, 2026-11-25): Try draws the theme live in the person's own window, under the
  preview bar Import uses; Use Theme installs it. Server-rendered screenshots can come later.
- **Install** downloads the package and checks its sha256 against the index. The index entries are signed by the
  server (Ed25519; the public key is in Margin, the private key in a Worker secret), so a cache or network in between
  can't swap a theme. Then the usual import check, the preview bar, and storage with source `store`.
- **Updates**: a newer version in the index is offered in Settings (never applied silently): its row says "Update to
  x", and the theme's line in Appearance says the new version is in Themes.
- **Share…** (Appearance, on a theme of the person's own: a copy or linked, never one from the store) asks first, then
  uploads the theme as it's stored, its author from its theme.json. Its line says whether it waits for review.

## 5. Generate a theme from a prompt

- **Generate Theme…** in Settings' Themes: a prompt, and a choice:
  - **Remix**: keep the layout of a built-in theme or an installed one, and Claude writes a new look over it: colours,
    type, shapes, motion, settings. This is the default: about a fifth of the tokens, and far more reliable.
  - **New layout**: Claude writes the whole package.
- The server streams the request to Claude.
  - **System prompt**: the theme guide (from the skill, below), cached.
  - **Context**: for a remix, the base theme's files, also cached.
  - **Output**: the files as structured output.
  - The result is returned to the app, which checks it with `checkImport` and shows it in the preview bar. If the
    check fails, the app sends the reasons back for a fix, at most twice. The server counts the fix rounds as part of
    the same generation, so they cost no points.
- **Follow-ups** ("darker sidebar", "rounder") continue the same conversation, its prefix cached, and cost a remix.
- A generated theme can be kept (source `generated`), edited as a linked folder, or shared.

### The quota plan

The credit is $200 a month, about $6.45 a day. The server records every request's cost from `usage` (input, cache
reads and writes, output) in a ledger, and enforces three limits:

- **The day's budget**: generation pauses for everyone when the day's spend reaches $6.45 plus whatever wasn't used on
  earlier days of the month, capped at 2× the day's share. It resumes at midnight UTC. The page says so.
- **Each person's day**, in points:
  - 10 points a day per key (5 for a key under a day old);
  - a remix or a follow-up costs 1 point, a new layout 5;
  - a fix round costs nothing.
- **Rates**, counted in a Durable Object per key (exact, no races) plus one per network:
  - one generation at a time per key;
  - 6 a minute and 30 an hour per key;
  - 60 an hour per network (the address's /64 for IPv6);
  - 20 new keys a day per network.

Each request also has a ceiling: `max_tokens` 16K for a remix and 64K for a new layout, a 3-minute limit, and the fix
rounds. The page shows the points left and the reset time.

### Cost per generation (rough: the guide and a base theme, about 50K tokens, cached after the first request)

| | Claude Opus 5.5 ($4 / $20 per M tokens) | Claude Sonnet 5.5 ($2 / $10) | Claude Haiku 5.5 ($0.10 / $0.50) |
|---|---|---|---|
| Remix (3–8K tokens out) | $0.07–0.17 | $0.04–0.09 | under $0.01 |
| New layout (about 35K out) | $0.70–0.95 | $0.35–0.50 | about $0.02 |
| Remixes a day within $6.45 | about 40–90 | about 70–160 | about 1,000+ |

The model is Tirth's call. Measure quality on a fixed set of prompts before choosing: build a small eval of about 30
prompts, then check that each result passes the check and judge it from its screenshots. Haiku would let far more
people generate; Opus is likely to write better layouts. A mix is possible too, for example Haiku for remixes and
Opus for new layouts.

## 6. A Claude skill, and later an MCP server

- **The skill** (`skills/margin-theme/`: `SKILL.md`, the theme guide, the schema, a small example theme, and
  `theme:check`). Anyone can make themes with their own Claude (Claude Code, Claude Desktop, claude.ai), at no cost to
  Margin. Its text is also the generator's system prompt: one copy of the guide.
- **An MCP server for Margin** (after step 1), run locally next to Margin.app. Its tools:
  - read the guide;
  - check a folder;
  - link a folder as the window's theme (step 1's mechanism);
  - take a screenshot of the window;
  - share a theme (step 3; it asks in Margin first).

  With these, Claude can see its theme in the real app as it works. Every change goes through Margin's own check and
  preview bar; nothing from the MCP server is trusted.

## Order

1. Load unpacked, and `theme:check`.
2. The skill.
3. The server's skeleton: keys and the proof of work, signed requests, the limits, uploads with their cheap checks,
   reports, the review page, the signed index.
4. Settings' Themes: try, install, update, report, share (no screenshots yet: Try draws the theme live).
5. Generation: remix first, then new layout. Eval the model before launch.
6. The MCP server.

Each step is its own branch with tests: the server's logic with Node's test runner (its SQL on Node's own SQLite, the
engine D1 runs), the app's parts with the theme suite, core with Rust tests. The quota, review and signing rules each get tests that fail first.

## Open

- Tirth: skim the Supplemental Credit Terms; pick the model after the eval; paste the API key into the Worker's secrets
  (never into code or a message); a domain later (the free `*.workers.dev` address until then).
- To test: App Attest from a Developer ID build on macOS 27.
- Pricing later (more points for supporters?) isn't in this plan.
