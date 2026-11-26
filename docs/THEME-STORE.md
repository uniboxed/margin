# The theme store: share, find and generate themes (plan, 2026-11-25)

Tirth's decisions (2026-11-25):

- People **upload themes from inside Margin** (not by pull requests).
- People can **write a prompt and get a theme**, paid from the monthly API credit of his Ultra plan ($200 of Claude
  Console API credit a month, linked to one Console organization).
- **Everyone** can generate, within a **daily limit**, a **quota plan** and **rate limits**.
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
  Themes page (Margin's own part)        /v1/themes …    D1: users, themes, versions, reports, ledger
  Share, Generate, Load unpacked         /v1/generate ─► Claude API (key in a Worker secret)
  install: verify signature,             R2: packages, screenshots
    the same import check + preview      Browser Rendering: the screenshots, rendered from the package
```

- **Server code in this repo** (`cloud/themes/`, TypeScript, Wrangler), so it uses the same validator files as the
  app: one copy of the check, run on upload and again by the app on install. Secrets (the API key, the signing key)
  live only in Worker secrets. The repo is public: no names, addresses or keys in code, logs or issues.
- **Cloudflare**: Workers (the API), D1 (records), R2 (files), Durable Objects (per-person limits, counted exactly),
  Browser Rendering (screenshots). Tirth's account is already set up with these. The paid Workers plan ($5 a month)
  is needed for Durable Objects and Browser Rendering.

## Where each piece goes (docs/HOSTING-CORE.md, "follow the architecture")

| Piece | Where |
|---|---|
| The store's rules: the index read and its signature checked, versions compared, an update offered, an installed theme's source (`store`, `generated`, `linked`, `file`), a linked folder's reload rule | margin-core (`data::themes` and a new `themes::store`), one copy for the Mac and Windows |
| HTTP, the keychain (the sign-in token), Sign in with Apple's sheet, watching a linked folder (FSEvents; Windows: ReadDirectoryChangesW) | each platform: mechanism only |
| The checks (`checkImport`, `sanitizeTheme`) | `app/shared/ui` as today, also run by the server |
| The Themes page, Generate, Share, the quota shown | Margin's own UI parts (HTML/CSS, guarded like Settings: only Margin's words), drawn in every theme |
| Generation, uploads, moderation, limits | the server |

## 1. Load unpacked (first: everything else uses it)

- Settings › Themes › **Load Unpacked…** picks a folder. Margin keeps a link to it (not a copy) and draws it as the
  window's theme, marked "linked" in Settings.
- Margin watches the folder. On each save it reads the folder again (the same caps as a folder import), checks it, and
  redraws. A theme that fails keeps the last good version on screen, with the reasons shown in a small panel (file and
  rule, the same words the import uses).
- **Unlink** goes back to the theme from before. A linked theme is per Mac, like imports.
- `npm run theme:check <folder>`: the same check from the command line (for people writing themes and for the skill).

## 2. Accounts

- Uploading and generating need a sign-in, so limits are per person and every upload has an author.
- **Sign in with Apple** first: native on the Mac, no password, and the person can hide their email. To confirm it's
  available for a Developer ID build; if not, the web flow. Windows later uses the web flow.
- The server keeps only a hash of Apple's user id, a display name the person picks, and trust (new, trusted, blocked).
  The session token is stored in the Keychain.

## 3. Upload from inside Margin

- **Share Theme…** on an imported, linked or generated theme: name, description, tags, then upload.
- The app sends the `.margintheme` package. The server, in order:
  1. checks size and rate (5 uploads a day per person);
  2. runs `checkImport` on it (refused with the reasons if it fails);
  3. stores the package in R2 under its sha256;
  4. renders screenshots with Browser Rendering (the theme's own template over a fixed sample state, light and dark:
     never a picture the uploader sent);
  5. records a version, in review.
- **Review**: a person's first upload is reviewed by Tirth (a small admin page: screenshots, the check's notes,
  approve or reject). After two approved uploads, an author is trusted: new versions publish at once and can be
  reported. Reports (`POST /v1/reports`) hide a theme after three, pending review.
- Names: unique slugs; names that impersonate Margin, Apple or another author are refused in review.

## 4. The Themes page (find and install)

- `margin://themes`: Margin's own page (like Settings), sections for Featured, New and Popular, plus search and tags.
  Each card has the screenshots, name, author and installs.
- **Install** downloads the package and checks its sha256 against the index. The index entries are signed by the
  server (Ed25519; the public key is in Margin, the private key in a Worker secret), so a cache or network in between
  can't swap a theme. Then the usual import check, the preview bar, and storage with source `store`.
- **Updates**: a newer version in the index is offered in Settings (never applied silently).

## 5. Generate a theme from a prompt

- **Generate Theme…** on the Themes page: a prompt, and a choice:
  - **Remix**: keep the layout of a built-in theme or an installed one, and Claude writes a new look over it: colours,
    type, shapes, motion, settings. This is the default: about a fifth of the tokens, and far more reliable.
  - **New layout**: Claude writes the whole package.
- The server streams the request to Claude.
  - **System prompt**: the theme guide (from the skill, below), cached.
  - **Context**: for a remix, the base theme's files, also cached.
  - **Output**: the files as structured output.
  - The server runs `checkImport`. If that fails, the reasons go back to Claude for one fix, then at most one more.
  - The result is returned to the app, which checks it again and shows it in the preview bar.
- **Follow-ups** ("darker sidebar", "rounder") continue the same conversation, its prefix cached, and cost a remix.
- A generated theme can be kept (source `generated`), edited as a linked folder, or shared.

### The quota plan

The credit is $200 a month, about $6.45 a day. The server records every request's cost from `usage` (input, cache
reads and writes, output) in a ledger, and enforces three limits:

- **The day's budget**: generation pauses for everyone when the day's spend reaches $6.45 plus whatever wasn't used on
  earlier days of the month, capped at 2× the day's share. It resumes at midnight UTC. The page says so.
- **Each person's day**, in points:
  - 10 points a day (5 for an account under a day old);
  - a remix or a follow-up costs 1 point, a new layout 5;
  - a fix round costs nothing.
- **Rates**, counted in a Durable Object per person (exact, no races) plus a per-IP bucket:
  - one generation at a time per person;
  - 6 a minute and 30 an hour per person;
  - 60 an hour per IP.

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
3. The server's skeleton: accounts, uploads, the review page, screenshots, the signed index.
4. Margin's Themes page: install, update, share.
5. Generation: remix first, then new layout. Eval the model before launch.
6. The MCP server.

Each step is its own branch with tests: the server's routes and limits with Miniflare, the app's parts with the theme
suite, core with Rust tests. The quota, review and signing rules each get tests that fail first.

## Open

- Tirth: skim the Supplemental Credit Terms; pick the model after the eval; confirm Sign in with Apple for Developer
  ID; a domain for the server (for example `themes.<margin's domain>`).
- Pricing later (more points for supporters?) isn't in this plan.
