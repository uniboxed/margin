// Dock-window experiment: the sidebar in its own window, glued to the left
// of one Safari window (the "target"). Safari has no window-moved event for
// extensions, so this page polls the target's bounds and re-docks.
const api = globalThis.browser ?? globalThis.chrome;
const { Margin } = globalThis;
const D = Margin.dock;
const $ = (id) => document.getElementById(id);

const FOLLOW_MS = 500;
const targetWindowId = Number(new URLSearchParams(location.search).get('target'));

async function send(type, payload = {}) {
  const res = await api.runtime.sendMessage({ type, ...payload });
  if (res && !res.ok) console.warn('[margin]', type, res.error);
  return res?.result;
}

const dark = matchMedia('(prefers-color-scheme: dark)');
const sidebar = Margin.ui.createSidebar({ document, send, mode: 'newtab' });
const applyTheme = () => sidebar.setTheme(dark.matches ? 'dark' : 'light');
applyTheme();
dark.addEventListener('change', applyTheme);
$('sidebar').append(sidebar.el);
$('undock').addEventListener('click', () => send('setDock', { on: false }));

let state = null;
let version = 0;
async function refresh() {
  const mine = ++version;
  const next = await api.storage.local.get(null);
  if (mine !== version || !next.spaces?.length) return;
  state = next;
  // Shows the target window's tabs and spaces; clicks act on that window.
  sidebar.update(state, { windowId: targetWindowId });
  document.documentElement.style.setProperty('--space-color', sidebar.el.style.getPropertyValue('--space-color'));
  const d = state.dock;
  if (d?.actual) {
    const ok = (r, a) => D.describe(r, a).startsWith('✓');
    const placed = ok(d.requested.dock, d.actual.dock) && !d.actual.targetError && ok(d.requested.target, d.actual.target);
    const follow = d.lastFollow ? (ok(d.lastFollow.requested, d.lastFollow.actual) ? ' · follows ✓' : ' · follow ✗') : '';
    $('status').textContent = `${placed ? '✓ Placed as asked' : '✗ Not placed as asked'}${follow} (hover)`;
    $('status').title = `Dock window: ${D.describe(d.requested.dock, d.actual.dock)} (type ${d.actual.dockType})\nSafari window: ${
      d.actual.targetError ? `resize refused: ${d.actual.targetError}` : D.describe(d.requested.target, d.actual.target)
    }`;
  }
}
api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());
refresh();

// ---- follow the target window -------------------------------------------------

const self = await api.windows.getCurrent();
let following = false;
async function follow() {
  if (following) return;
  following = true;
  try {
    const [target, me] = await Promise.all([api.windows.get(targetWindowId), api.windows.get(self.id)]);
    if (target.state === 'minimized' || target.state === 'fullscreen') return;
    const want = D.followLayout(D.box(target), D.box(me));
    if (!want) return;
    await api.windows.update(self.id, want);
    const got = D.box(await api.windows.get(self.id));
    send('dockReport', { requested: want, actual: got });
  } catch {
    // Target closed: the background closes this window.
  } finally {
    following = false;
  }
}
setInterval(follow, FOLLOW_MS);
