// "Margin full screen" (Chrome; platform.marginFullscreen): the window in
// full screen with no toolbar at all. In Chrome's own full screen (the green
// button, toolbar set to auto-hide), Chrome shows the toolbar for a second on
// every change of the active tab, on purpose and with no setting to stop it
// (BrowserView::RevealTopContainerIfNeeded). In full screen an extension
// starts, Chrome shows no toolbar, so it never comes up; Margin's sidebar and
// palette stand in for it. It has to start from a window that isn't in full
// screen already.
import { platform } from '../shared/platform.js';
import { api } from './store.js';

const KEY = 'marginFullscreen'; // storage.session: { [windowId]: the state to go back to }

async function entered() {
  return (await api.storage.session.get(KEY))[KEY] ?? {};
}

// Until the window reaches `state` (a full-screen change animates), at most `ms`.
async function waitForState(windowId, state, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const win = await api.windows.get(windowId).catch(() => null);
    if (!win || win.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// On, or off again if Margin put this window there. Returns { on }.
export async function toggleMarginFullscreen(windowId) {
  const win = await api.windows.get(windowId);
  const states = await entered();
  if (win.state === 'fullscreen' && states[windowId]) {
    const back = states[windowId] === 'maximized' ? 'maximized' : 'normal';
    delete states[windowId];
    await api.storage.session.set({ [KEY]: states });
    await api.windows.update(windowId, { state: back });
    return { on: false };
  }
  let back = win.state === 'maximized' ? 'maximized' : 'normal';
  if (win.state === 'fullscreen') {
    // The browser's own full screen: leave it first, or the toolbar stays.
    await api.windows.update(windowId, { state: 'normal' });
    await waitForState(windowId, 'normal');
    back = 'normal';
  }
  await api.storage.session.set({ [KEY]: { ...states, [windowId]: back } });
  await api.windows.update(windowId, { state: 'fullscreen' });
  return { on: true };
}

// When the window goes full screen some other way (the green button,
// Globe-F, View → Enter Full Screen, ⌃⌘F), switch it to Margin full screen,
// unless the setting is off (marginFullscreenAuto) or a page or video in it
// went full screen (the Fullscreen API also puts the window in full screen;
// leaving it would end the video's). Called on windows.onBoundsChanged.
const switching = new Set(); // window ids Margin is switching right now
export async function followFullscreen(windowId) {
  if (!platform?.marginFullscreen || switching.has(windowId)) return;
  const win = await api.windows.get(windowId).catch(() => null);
  if (!win) return;
  const states = await entered();
  if (win.state !== 'fullscreen') {
    // Left Margin full screen another way (Esc, the menu): forget it.
    if (states[windowId]) {
      delete states[windowId];
      await api.storage.session.set({ [KEY]: states });
    }
    return;
  }
  if (states[windowId]) return; // Margin's already
  const { settings } = await api.storage.local.get('settings');
  if (settings?.marginFullscreenAuto === false || (await pageFullscreen(windowId))) return;
  switching.add(windowId);
  try {
    await toggleMarginFullscreen(windowId);
  } finally {
    switching.delete(windowId);
  }
}

async function pageFullscreen(windowId) {
  const [tab] = await api.tabs.query({ active: true, windowId }).catch(() => []);
  if (!tab?.id || !api.scripting?.executeScript) return false;
  try {
    const [res] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!document.fullscreenElement });
    return !!res?.result;
  } catch {
    return false; // no access (a browser page): the window's own full screen
  }
}
