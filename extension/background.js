// State owner. Non-persistent: every handler reads state through load(),
// which rehydrates from storage.local after the worker is unloaded.
import * as M from './state/model.js';

const api = globalThis.browser ?? globalThis.chrome;

let cache = null;
let queue = Promise.resolve();

async function load() {
  if (cache) return cache;
  const raw = await api.storage.local.get(M.STATE_KEYS);
  cache = M.normalizeState(raw);
  // First run: persist defaults so readers (content scripts) see a full state.
  const missing = M.STATE_KEYS.filter((key) => !(key in raw));
  if (missing.length) await api.storage.local.set(Object.fromEntries(missing.map((key) => [key, cache[key]])));
  return cache;
}

// Serialize every read-modify-write so concurrent tab events can't clobber
// each other, and persist only the keys that changed.
function mutate(fn) {
  const run = queue.then(async () => {
    const prev = await load();
    const next = (await fn(prev)) ?? prev;
    const changes = {};
    for (const key of M.STATE_KEYS) if (next[key] !== prev[key]) changes[key] = next[key];
    cache = next;
    if (Object.keys(changes).length) await api.storage.local.set(changes);
    return next;
  });
  queue = run.catch((err) => console.error('[margin]', err));
  return run;
}

const newId = () => crypto.randomUUID().slice(0, 8);
const now = () => Date.now();

// A browser restart gives every tab and window a new id. storage.session is
// cleared on restart, so an empty one means "fresh"; without it we fall back
// to runtime.onStartup.
async function isFreshSession() {
  if (!api.storage.session) return false;
  const { alive } = await api.storage.session.get('alive');
  if (alive) return false;
  await api.storage.session.set({ alive: true });
  return true;
}

function resync({ fresh } = {}) {
  return mutate(async (s) => {
    const tabs = await api.tabs.query({});
    const isFresh = fresh ?? (await isFreshSession());
    return M.syncTabs(s, tabs, { fresh: isFresh, now: now() });
  });
}

// ---- lifecycle ------------------------------------------------------------

api.runtime.onInstalled.addListener((details) => {
  console.log('[margin] installed', details.reason);
});

if (!api.storage.session) {
  api.runtime.onStartup.addListener(() => resync({ fresh: true }));
}

resync();

// ---- tab events -----------------------------------------------------------

const TRACKED_CHANGES = ['title', 'url', 'favIconUrl'];

api.tabs.onCreated.addListener((tab) => mutate((s) => M.upsertTab(s, tab, now())));
api.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (TRACKED_CHANGES.some((k) => k in change) || change.status === 'complete') {
    mutate((s) => M.upsertTab(s, tab, now()));
  }
});
api.tabs.onRemoved.addListener((tabId) => mutate((s) => M.removeTab(s, tabId)));
api.tabs.onActivated.addListener(({ tabId, windowId }) => mutate((s) => M.activateTab(s, tabId, windowId, now())));
api.tabs.onMoved.addListener(() => resync({ fresh: false }));
api.tabs.onAttached.addListener(() => resync({ fresh: false }));
api.tabs.onDetached?.addListener(() => resync({ fresh: false }));
api.windows?.onRemoved.addListener((windowId) =>
  mutate((s) => {
    if (!(windowId in s.activeSpaceByWindow)) return s;
    const activeSpaceByWindow = { ...s.activeSpaceByWindow };
    delete activeSpaceByWindow[windowId];
    return { ...s, activeSpaceByWindow };
  }),
);

// ---- actions --------------------------------------------------------------

async function focusTab(tabId) {
  const tab = await api.tabs.update(tabId, { active: true });
  if (tab && api.windows) await api.windows.update(tab.windowId, { focused: true });
}

async function openTab({ windowId, url, spaceId }) {
  const tab = await api.tabs.create({ windowId, url, active: true });
  if (spaceId) await mutate((s) => M.moveTab(M.upsertTab(s, tab, now()), tab.id, spaceId));
  return tab;
}

const handlers = {
  async hello(_, sender) {
    return { tabId: sender.tab?.id ?? null, windowId: sender.tab?.windowId ?? null };
  },
  async activateTab({ tabId }) {
    await focusTab(tabId);
  },
  async closeTab({ tabId }) {
    await api.tabs.remove(tabId);
  },
  async newTab({ windowId, url, spaceId }) {
    const tab = await openTab({ windowId, url, spaceId });
    return { tabId: tab.id };
  },
  async pinTab({ tabId }) {
    const s = await load();
    const tab = s.tabs[tabId];
    if (!tab) return;
    await mutate((st) => M.addPin(st, { id: newId(), spaceId: st.tabSpace[tabId], url: tab.url, title: tab.title }));
  },
  async unpin({ pinId }) {
    await mutate((s) => M.removePin(s, pinId));
  },
  async openPin({ pinId, windowId }) {
    const s = await load();
    const pin = s.pins.find((p) => p.id === pinId);
    if (!pin) return;
    const key = M.normalizeUrl(pin.url);
    const matches = Object.values(s.tabs).filter((t) => M.normalizeUrl(t.url) === key);
    const existing = matches.find((t) => t.windowId === windowId) ?? matches[0];
    if (existing) await focusTab(existing.id);
    else await openTab({ windowId, url: pin.url, spaceId: pin.spaceId });
  },
  async setSpace({ windowId, spaceId }) {
    await mutate((s) => M.setActiveSpace(s, windowId, spaceId));
  },
  async createSpace({ windowId, name, emoji, color }) {
    const id = newId();
    await mutate((s) => {
      const next = M.createSpace(s, { id, name, emoji, color });
      return windowId == null ? next : M.setActiveSpace(next, windowId, id);
    });
    return { spaceId: id };
  },
  async renameSpace({ spaceId, name, emoji, color }) {
    await mutate((s) => M.updateSpace(s, spaceId, { name, emoji, color }));
  },
  async deleteSpace({ spaceId }) {
    await mutate((s) => M.deleteSpace(s, spaceId));
  },
  async moveTabToSpace({ tabId, spaceId }) {
    await mutate((s) => M.moveTab(s, tabId, spaceId));
  },
  async updateSettings({ patch }) {
    await mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  },
};

// sendResponse + `return true` works in both Safari and Chrome (Chrome
// ignores promises returned from onMessage listeners).
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

// ---- commands -------------------------------------------------------------

api.commands?.onCommand.addListener(async (command) => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await api.tabs.sendMessage(tab.id, { type: 'command', command });
  } catch {
    // No content script here (Safari internal page, extension page, PDF).
  }
});
