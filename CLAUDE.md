# CLAUDE.md

- `SPEC.md` is the source of truth. Follow it, including its Working rules (Conventional Commits, subject line only, no attribution of any kind).
- Before starting, check progress: read `DECISIONS.md` and run `git log --oneline`. Commits are scoped per milestone (e.g. `feat(m3): ...`).
- Shared code lives in `extension/`, what differs per browser in `extension/engines/<engine>/` (manifest, profile, own modules), Margin.app in `app/` (`shared/`, `platforms/` with `macos/` and `windows/`, and `engines/<engine>/` for its per-browser side), the Rust workspace in the root `Cargo.toml`. `npm run build` generates `dist/` (`webkit/`, `chromium/`, `app/`, one build per engine); it's not committed (ignored since 2026-11-06), and the test scripts and `npm run safari` build it first.
- Continue from the next unfinished milestone. While working, run `npm run test:quick` before each commit: it runs only the tests the change reaches (usually under a minute). Run the full gate, `npm run gate` (unit, theme, security, app, e2e, WebKit host), once before merging to `main`.
- Playwright: use the preinstalled Chromium (`/opt/pw-browsers`) if present; do not run `playwright install`. If no Chromium is available, keep unit tests, skip E2E, and record it in `DECISIONS.md`.
- Never put `claude/` (or any assistant/tool name) in a branch name, commit, or PR. Name branches `type/short-description`.
