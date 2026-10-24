const api = globalThis.browser ?? globalThis.chrome;
const { Margin } = globalThis;

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
document.getElementById('sidebar').append(sidebar.el);

const self = await api.tabs.getCurrent();
let state = null;
let version = 0;

async function refresh() {
  const mine = ++version;
  const next = await api.storage.local.get(null);
  if (mine !== version || !next.spaces?.length) return;
  state = next;
  sidebar.update(state, { windowId: state.tabs?.[self?.id]?.windowId ?? self?.windowId });
}

api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());
refresh();
