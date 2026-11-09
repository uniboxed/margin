// The merge of Margin's lasting data set (DATA.md), the reference the app's
// Swift store follows (step 3 runs the same JSON vectors:
// tests/fixtures/data-merge/*.json). Pure: no browser APIs, no clock.
//
// A data set: { format: 1, items: { [collection]: { [id]: Item } } }, where an
// Item is { updatedAt, value } (a live item: `value` is any JSON) or
// { updatedAt, deleted: true } (a tombstone: the item was deleted then, and
// stays deleted against anything older). `updatedAt`: milliseconds since
// 1970, the time of the change that made the item what it is.
//
// A change: { collection, id, updatedAt, value } or { collection, id,
// updatedAt, deleted: true }, as queued by the extension while it isn't linked
// to the app (shared/data-set.ts pendingChanges) and as either side sends one
// on the link (DATA.md "Messages").
//
// The rule, per item: the later `updatedAt` wins (last write wins). On the
// same `updatedAt`, a deletion wins over a live item; between two live items
// (or two deletions), the change wins over what was there. Changes apply in
// the order given. Collections and items the merge doesn't know are kept as
// they are; a malformed change (no collection or id, a time that isn't a
// finite number, neither a value nor `deleted: true`) is skipped.

export const DATA_FORMAT = 1;

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isName = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256;

export function isItem(item: any): boolean {
  return isObject(item) && Number.isFinite(item.updatedAt) && (item.deleted === true ? !('value' in item) : 'value' in item && item.deleted === undefined);
}

export function isChange(change: any): boolean {
  if (!isObject(change) || !isName(change.collection) || !isName(change.id) || !Number.isFinite(change.updatedAt)) return false;
  return change.deleted === true ? !('value' in change) : 'value' in change && change.deleted === undefined;
}

/** Whether `incoming` replaces `current` (both items, current may be missing). */
function wins(incoming: { updatedAt: any; deleted: boolean; value?: undefined; } | { deleted?: undefined; updatedAt: any; value: any; }, current) {
  if (!current) return true;
  if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt > current.updatedAt;
  if (current.deleted === true && incoming.deleted !== true) return false; // a deletion holds its ground
  return true; // the same time: the change wins (a deletion over a live item, or the newer word)
}

const itemOf = (change) => (change.deleted === true ? { updatedAt: change.updatedAt, deleted: true } : { updatedAt: change.updatedAt, value: change.value });

/**
 * `base` with `changes` applied, item by item. Neither input is changed; the
 * result shares the items that didn't change.
 * */
export function mergeData(base: { format?: number, items?: Record<string, Record<string, any>> } | null | undefined, changes: any[] = []): { format: number, items: Record<string, Record<string, any>> } {
  const items = {};
  for (const [collection, list] of Object.entries(isObject(base?.items) ? base.items : {})) {
    if (!isObject(list)) continue;
    items[collection] = {};
    for (const [id, item] of Object.entries(list)) if (isItem(item)) items[collection][id] = item;
  }
  const copied = new Set<any>();
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!isChange(change)) continue;
    const { collection, id } = change;
    const incoming = itemOf(change);
    if (!wins(incoming, items[collection]?.[id])) continue;
    if (!copied.has(collection)) {
      items[collection] = { ...items[collection] };
      copied.add(collection);
    }
    items[collection][id] = incoming;
  }
  return { format: DATA_FORMAT, items };
}

/**
 * Every item of a data set as a change (to merge one whole set into another:
 * `mergeData(a, changesFrom(b))`), in a fixed order (collection, then id).
 * */
export function changesFrom(set: { items?: Record<string, Record<string, any>> } | null | undefined) {
  const out: ({ collection: string, id: string, updatedAt: any, deleted: true } | { collection: string, id: string, updatedAt: any, value: any })[] = [];
  for (const collection of Object.keys(isObject(set?.items) ? set.items : {}).sort()) {
    // (The keys are set.items's: it's an object.)
    const list = set!.items![collection];
    if (!isObject(list)) continue;
    for (const id of Object.keys(list).sort()) {
      const item = list[id];
      if (!isItem(item)) continue;
      out.push(item.deleted === true ? { collection, id, updatedAt: item.updatedAt, deleted: true } : { collection, id, updatedAt: item.updatedAt, value: item.value });
    }
  }
  return out;
}

/**
 * The same set without tombstones older than `before` (ms since 1970): once
 * every copy has had them, a deletion needs no more keeping.
 * */
export function pruneTombstones(set: { format?: number, items?: Record<string, Record<string, any>> }, before: number) {
  const items = {};
  for (const [collection, list] of Object.entries(isObject(set?.items) ? set.items : {})) {
    items[collection] = Object.fromEntries(Object.entries(list ?? {}).filter(([, item]) => isItem(item) && !(item.deleted === true && item.updatedAt < before)));
  }
  return { format: DATA_FORMAT, items };
}

/** The live items' values of one collection: { id: value }. */
export function liveValues(set: any, collection: string) {
  const list = isObject(set?.items?.[collection]) ? set.items[collection] : {};
  return Object.fromEntries(Object.entries(list).filter(([, item]) => isItem(item) && item.deleted !== true).map(([id, item]) => [id, item.value]));
}
