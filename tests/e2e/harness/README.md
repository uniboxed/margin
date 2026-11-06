# The e2e harness

Each e2e file starts one world: the test site, Margin in headless Chromium, and Margin.app's overlays in headless WebKit. `docs/e2e-plan.md` says why it's this shape.

## Use it

```js
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { sidebar, palette, tabRow } from './harness/ui.js';

const m = await startMargin({ name: 'tabs', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
await m.open('shop.test', '/');        // a site page in a new tab, loaded
const ui = await m.ui();               // the front window's overlay (a Playwright page)
await ui.click(tabRow(id));            // drive the overlay
await m.until(async () => (await m.front()).id === id, { what: 'the tab in front' });
await m.shoot(t, 'clicked');           // page.png, overlay.png, window.png
await m.close();
```

- `seed`: what the app's data set holds (spaces, pins, folders, archive, settings). It goes in through the real path: the copy's `data.hello` is answered with it. A function gets the site's `url(host, path)`, for pins and archived tabs of the test site.
- `running: false`: Margin.app isn't running at the start. `m.shell.setRunning(true)` and `m.relay.dispatch('appUp', …)` start it.
- The first window is in full screen, 1440 × 900, and its first tab is the site's index.

## What's real

- The extension: Safari's profile with Chrome's manifest (`build.js`). The test copy adds `nativeMessaging`, a key (a known id), lets the link's socket guard through (one string; it fails loudly if that moves), and hides `favIconUrl` from the background, as Safari does.
- The overlay: `dist/app/overlay.html`, served with the app's Content Security Policy. Anything it loads from the web is recorded (`m.shell.blocked`).

## What stands in

- `native-host.mjs` and `relay.js`: Safari's extension handler. `wantLink` is answered as the handler would; the app's `link` goes into the lasting port.
- `shell.js`: Margin.app's shell, on `tests/fake-app.js`. It keeps the mirror, puts the theme together, makes an overlay per full-screen window, and does the bridge ops. A window is bound when it's in full screen. There's no window server.

## Handles

- `m.shell.key('palette')`, `m.shell.navigate('next-tab')`: the app's hot keys.
- `m.shell.request(type, payload, windowId)`: a `req`, as an overlay sends it.
- `m.shell.drawn(windowId, false)`: the app says it doesn't draw over a window.
- `m.shell.hold(true)`, then `false`: the overlays lag behind (their messages held, then given in order).
- `m.shell.drop()`, `bye()`, `restart()`: the link going.
- `m.shell.setCloudTabs(…)`, `setAcross(…)`: the app's own data for its overlays.
- `m.shell.requests`, `performs`, `layoutsSent`, `drawnSent`, `overlayLogs`, `received`: what happened, for checks.
- `m.leaks`: requests to any host that isn't `.test` or `127.0.0.1`. Search engines are answered locally.

## Rules

- Headless only. Nothing is shown on screen.
- Wait on a condition (`m.until`), never a fixed time, except where the time is the thing tested.
- Screenshots go to `$MARGIN_E2E_SHOTS/<file>-<test>/` (default `$TMPDIR/margin-e2e-shots`), never the repo.
- `MARGIN_E2E_VERBOSE=1` prints what the shell and the relay do.
