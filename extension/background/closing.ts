// Browser tabs Margin closes itself, and what its close is for: heard back
// in tabs.onRemoved (background.ts), a close of Margin's isn't one "on its
// own" (state/model.ts closedTab): 'keep' (put to sleep: the Margin tab
// stays, not open) or 'done' (the close did what it needed already: archived
// the tab, or a ⌘T tab handed off). Kept in memory for CLOSING_MS: the close
// is heard within moments by the same background that asked for it.
import { api } from './store.ts';

const CLOSING_MS = 30_000;
const closing: Map<number, { how: 'keep' | 'done', why?: string, at: number }> = new Map();

export function noteClosing(tabIds: number[], how: 'keep' | 'done', why?: string) {
  const at = Date.now();
  for (const [id, entry] of closing) if (at - entry.at > CLOSING_MS) closing.delete(id);
  for (const id of tabIds) closing.set(id, { how, ...(why ? { why } : {}), at });
}

/** What Margin closed this tab for (once), or null: not Margin's close. */
export function takeClosing(tabId: number) {
  const entry = closing.get(tabId);
  closing.delete(tabId);
  return entry && Date.now() - entry.at <= CLOSING_MS ? { how: entry.how, ...(entry.why ? { why: entry.why } : {}) } : null;
}

/**
 * Closes browser tabs as Margin's own close (`how`), one by one if the
 * browser refuses them together. A tab that didn't close is forgotten here.
 */
export async function closeTabs(ids: number | number[], how: 'keep' | 'done', why?: string) {
  const list = ([] as number[]).concat(ids).filter(Number.isInteger);
  if (!list.length) return;
  noteClosing(list, how, why);
  try {
    await api.tabs.remove(list.length === 1 ? list[0] : list);
  } catch {
    await Promise.all(list.map((id) => Promise.resolve(api.tabs.remove(id)).catch(() => { closing.delete(id); })));
  }
}

/** For tests. */
export const closingNow = () => new Map(closing);
