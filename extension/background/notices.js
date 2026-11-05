// Margin's notices for a window, decided by this copy and drawn by Margin.app's
// overlay of that window (Margin 2 Phase 2 step 7; app/PROTOCOL.md `push`
// `notice`): the copy sends only the kind and the tab it's about, the overlay
// has the words (shared/notices.js) and draws them in the theme's guarded
// notice part, and a button comes back as `req noticeAction` (handlers.js).
// Pages draw none of Margin's UI (step 5), so what they used to say goes this
// way.
//
// Each notice about a tab's page is said once per page (its tab and address):
// again only after it went by itself and NOTICE_AGAIN_MS have passed, never
// after the person chose one of its buttons. Decided while the link isn't up
// (a copy starting after an update finds the pages cut off from the copy
// before it before it has linked), it's kept for PENDING_MS and said once
// linked, if its tab is still in front with the same page (the app gives it
// to the window's overlay when that's drawn: app/shell/Shell.swift
// HeldPushes). Not linked by then, nothing is said: there's nowhere to say it.
import { isNotice } from '../shared/notices.js';
import { appLink } from './app-link.js';
import { api } from './store.js';

export const NOTICE_AGAIN_MS = 10 * 60_000;
export const PENDING_MS = 60_000;
/** @type {Map<string, number>} key → when it was last said */
const said = new Map();
/** @type {Set<string>} answered: not said again */
const answered = new Set();
/** @type {Map<string, { windowId: number | null, kind: string, tabId: number | null, url: string | null, at: number }>} decided while not linked */
const pending = new Map();
// The link the notices go on (tests put a stand-in: useLinkForTests).
/** @type {{ linked: () => boolean, push: (windowId: number | null, msg: any) => boolean }} */
let link = appLink;
/** @param {typeof link} stand */
export const useLinkForTests = (stand) => { link = stand; };
const keyOf = (/** @type {string} */ kind, /** @type {number | null} */ tabId, /** @type {string | null} */ url) => `${kind}|${tabId ?? ''}|${url ?? ''}`;

/**
 * Says notice `kind` in `windowId`'s overlay, about tab `tabId` (its page at
 * `url`). Whether it went (linked, not said lately, not answered); not linked,
 * it's kept for when the link comes (linkedAgain).
 * @param {number | null} windowId @param {string} kind @param {{ tabId?: number | null, url?: string | null, now?: number }} [about]
 */
export function tellNotice(windowId, kind, { tabId = null, url = null, now = Date.now() } = {}) {
  if (!isNotice(kind)) return false;
  const key = keyOf(kind, tabId, url);
  if (answered.has(key) || now - (said.get(key) ?? -Infinity) < NOTICE_AGAIN_MS) return false;
  if (!link.linked()) {
    pending.set(key, { windowId, kind, tabId, url, at: now });
    if (pending.size > 20) pending.delete(pending.keys().next().value);
    return false;
  }
  if (!link.push(windowId ?? null, { type: 'notice', kind, ...(Number.isInteger(tabId) ? { tabId } : {}) })) return false;
  pending.delete(key);
  said.set(key, now);
  if (said.size > 200) said.delete(said.keys().next().value);
  return true;
}

/**
 * The link came: the notices decided meanwhile said now, each only if its
 * tab is still in front with the same page (and in the same window). How
 * many were said.
 * @param {{ getTab?: (tabId: number) => Promise<any>, now?: number }} [options]
 */
export async function linkedAgain({ getTab = (tabId) => api.tabs.get(tabId), now = Date.now() } = {}) {
  const waiting = [...pending.values()];
  pending.clear();
  let n = 0;
  for (const p of waiting) {
    if (now - p.at > PENDING_MS) continue;
    if (p.tabId != null) {
      const tab = await Promise.resolve(getTab(p.tabId)).catch(() => null);
      if (!tab?.active || tab.windowId !== p.windowId || (p.url != null && tab.url !== p.url)) continue;
    }
    if (tellNotice(p.windowId, p.kind, { tabId: p.tabId, url: p.url, now })) n++;
  }
  return n;
}

/** A button of the notice was chosen: never said again for that page. @param {string} kind @param {number | null} tabId @param {string | null} url */
export function noticeAnswered(kind, tabId, url) {
  answered.add(keyOf(kind, tabId, url));
  if (answered.size > 200) answered.delete(answered.values().next().value);
}

/** For tests: nothing said yet. */
export function resetNotices() {
  said.clear();
  answered.clear();
  pending.clear();
}
