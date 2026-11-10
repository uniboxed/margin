# Contributing to Margin

Thanks for helping. This page covers setting up, testing and sending a change. How Margin is put together is in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); why things are the way they are is in [DECISIONS.md](DECISIONS.md).

## Setting up

- **macOS** with Xcode (for Margin.app and Safari), **Node 26**, and **Rust** (stable, from [rustup](https://rustup.rs)).
  On Linux or Windows you can work on the extension (Chromium) and the Rust code.
- `npm ci` once. `npm run build` builds the extensions into `dist/` (`webkit/` for Safari, `chromium/` for Chrome and
  Edge) and the host page into `dist/app/`; `npm run safari` builds and installs Margin.app.

## Where things go

- Code every browser shares: `extension/`. What one browser does differently: `extension/engines/<engine>/`, and
  shared code asks what the browser can do (`extension/shared/capabilities.ts`), never which browser it is.
- Margin's app: `app/shared/` for every OS, `app/engines/` per browser, `app/platforms/<os>/` per OS.
- A module's tests go next to it, in its folder's `tests/`; whole-system tests are in `tests/` and `tools/`.

## Testing

| Command | What it runs | When |
|---|---|---|
| `npm run test:quick` | only the tests your change reaches (usually under a few minutes) | before each commit |
| `npm test` | type check and unit tests | any time |
| `npm run test:rust` | Rust: format, clippy, tests, the Windows targets | Rust changes |
| `npm run gate` | everything: unit, Rust, theme, security, the app's checks, end-to-end, the WebKit host | before a pull request is merged |

The browser tests run headless and the Mac app's tests run off screen: nothing should appear on your screen. CI runs
the same checks on every pull request, each only where the change reaches (a theme's folder runs that theme's
browser tests, the UI runtime the theme-agnostic ones in Arcadia: `MARGIN_TEST_THEMES=reference npm run test:theme`
does the same locally), and everything, every theme, every night.

## Commits and pull requests

- **Conventional Commits**, subject line only: `type(scope): what changed`, lower case, for example
  `fix(sleep): a tab playing audio stays awake`. Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`,
  `ci`, `chore`. Release notes are made from `feat`, `fix` and `perf` subjects, so write those for a reader.
- **Branches** are named `type/short-description`, from `main`.
- Keep a pull request to one change, with its tests. Say what you checked, and what you couldn't (another browser or
  OS, for example).
- Behaviour that a test can't reach, or that only a real browser shows, goes in [TESTING.md](TESTING.md) as a check
  to do by hand.

## Privacy rules for code

Margin never sends anything anywhere, and its logs never contain page addresses, titles or page content. Keep it
that way: a change that logs, stores or sends any of those won't be merged.

## License of contributions

Margin is licensed under the [GPL, version 3 or later](LICENSE). By sending a contribution you agree that it's your
own work (or that you may share it) and that it's licensed the same way.

## Working with AI coding agents

`AGENTS.md` and `CLAUDE.md` hold the project's rules for coding agents; the same rules apply to human contributors.
