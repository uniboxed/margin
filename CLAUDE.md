# CLAUDE.md

- `SPEC.md` is the source of truth. Follow it, including its Working rules (Conventional Commits, subject line only, no attribution of any kind).
- Before starting, check progress: read `DECISIONS.md` and run `git log --oneline`. Commits are scoped per milestone (e.g. `feat(m3): ...`).
- Shared code lives in `extension/`, per-browser manifest overrides in `platform/<browser>/`. `npm run build` generates `dist/` (`safari/`, `chrome/`, `app/`); it's not committed (ignored since 2026-11-06), and the test scripts and `npm run safari` build it first.
- Continue from the next unfinished milestone. Run `npm test` (unit) and `npm run test:e2e` (Playwright, headless Chromium) before each commit, then push.
- Playwright: use the preinstalled Chromium (`/opt/pw-browsers`) if present; do not run `playwright install`. If no Chromium is available, keep unit tests, skip E2E, and record it in `DECISIONS.md`.
- Never put `claude/` (or any assistant/tool name) in a branch name, commit, or PR. Name branches `type/short-description`.
