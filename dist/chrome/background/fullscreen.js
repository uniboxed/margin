// "Margin full screen" (Chrome; platform.marginFullscreen): the window in
// full screen with no toolbar at all. In Chrome's own full screen (the green
// button, toolbar set to auto-hide), Chrome shows the toolbar for a second on
// every change of the active tab, on purpose and with no setting to stop it
// (BrowserView::RevealTopContainerIfNeeded). In full screen an extension
// starts, Chrome shows no toolbar, so it never comes up; Margin's sidebar and
// palette stand in for it. It has to start from a window that isn't in full
// screen already.
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
