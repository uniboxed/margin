# Margin's themes server

A Cloudflare Worker on the free plan (docs/THEME-STORE.md). It registers each install's anonymous key, takes uploads
with a cheap check, keeps them for review, and serves a signed index and the packages. It isn't deployed yet.

| Route | What |
|---|---|
| `GET /v1/challenge` | a proof-of-work challenge |
| `POST /v1/keys` | register the install's key, the work done, signed by that key |
| `GET /v1/me` | signed: the key as the server knows it |
| `POST /v1/themes` | signed: upload a `.margintheme`; author and tags in `X-Margin-Meta` |
| `POST /v1/reports` | signed: report a theme |
| `GET /v1/index` | the signed index of published themes |
| `GET /v1/packages/<sha256>` | a published package |
| `/admin` | the review page (HTTP Basic, `ADMIN_TOKEN`) |

The formats (the challenge, the work, what a request signs) are written at the top of `src/keys.ts`; what the index
signs is in `src/store.ts`. The limits are one table, `RATES` in `src/limits.ts`.

## Tests

`node --test tests/cloud-themes.test.ts`, on fakes of D1 (Node's SQLite with the migrations here), R2 and the Limiter
Durable Objects (tests/cloud-themes/fakes.ts). `npm test` and `npm run test:quick` run them, and `npm run typecheck`
checks this code.

`vectors.json` holds the formats the server and Margin's client (margin-core's `data::theme_store`) must agree on: a key
and what it signs, the proof of work, a signed index, a shared theme's `.margintheme`. The server's own code makes it
(`npm run themes:vectors`); tests/cloud-themes-vectors.test.ts checks it's still what that code makes, and the Rust tests
must produce the same bytes from it.

`npm run themes:dev` runs the server on this Mac (the Worker's code over Node's HTTP, its bindings the tests' fakes, all
in memory) and prints its address, index key and review password. Margin.app uses it when started with
`MARGIN_THEME_STORE_URL` and `MARGIN_THEME_STORE_KEY` set to the first two; the app's end-to-end checks
(tools/app-tests/e2e-store.swift) start it themselves.

## Deploying (once)

From `cloud/themes/`, logged in with `npx wrangler login`:

1. `npx wrangler d1 create margin-themes`, then put the id it prints into `wrangler.toml`'s `database_id`.
2. `npx wrangler d1 migrations apply margin-themes --remote`.
3. `npx wrangler r2 bucket create margin-themes`.
4. `npm run themes:keys -- SIGNING_KEY CHALLENGE_SECRET ADMIN_TOKEN` (from the repo's root). It makes each secret and
   puts it straight into the Worker's secrets, so none is written down. It prints two things: the index's public key
   and the review page's password (keep it in your password manager). Make `SIGNING_KEY` only once: a new one means
   every Margin before it can no longer verify the index.
5. `npx wrangler deploy`. The address is `https://margin-themes.<your subdomain>.workers.dev` until there's a domain.
   The address and the index's public key go into margin-core's `data::theme_store::STORE`: Settings' Themes says
   "not open yet" until they're there.
6. In the dashboard, add the free plan's one rate-limiting rule for `/v1/index` and `/v1/packages/*` (the public reads),
   and look at the Worker's CPU time for the first uploads.

The Claude API key for generation (step 5) is pasted by hand with `npx wrangler secret put ANTHROPIC_API_KEY`, never
into code or a message.
