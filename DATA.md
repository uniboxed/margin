# Margin's lasting data

What Margin keeps between launches, the shape Margin.app stores it in on the Mac (`PLAN.md` §6, "Where data lives"), and how the extension and the app exchange it. Built on the extension's side in Margin 2, Phase 2 step 1; the app's store and the link use it in step 3.

## What's lasting and what's live

- **Lasting (the data set):** spaces, pins (by address), folders, Margin's tabs (open or not), the archive, settings, each theme's settings, site icons, user themes. Margin.app owns it, one data set per browser and profile.
- **Live (the extension only):** browser tab and window ids, which Margin tab is open in which browser tab and window, each window's space, the owner lease between Margin's copies. These exist only in the running browser and change at every relaunch, so they never go in the data set. The app learns them from the state messages (`PLAN.md` §5: `snapshot`, `delta`, `windows`).
- **This device's, not kept:** a site's page zoom, the sidebar's scroll per window, the cached copy of the active theme's package.

## The data set

```json
{
  "format": 1,
  "items": {
    "spaces": { "personal": { "updatedAt": 1730000000000, "value": { "name": "Personal", "emoji": "🏠", "color": "#6c5ce7", "order": 0 } } },
    "pins": { "p-1": { "updatedAt": 1730000000000, "deleted": true } }
  }
}
```

Every item is `{ updatedAt, value }`, or a tombstone `{ updatedAt, deleted: true }` for one that was deleted. `updatedAt` is milliseconds since 1970, the time of the change that made the item what it is. Item ids are strings.

| Collection | Id | Value |
|---|---|---|
| `spaces` | the space's id | `name`, `emoji`, `color`, `order` (its place among spaces, 0 first) |
| `pins` | the pin's id | `spaceId`, `url`, `title`, `folderId` (or null), `pos` (its place at its level) |
| `folders` | the folder's id | `spaceId`, `name`, `open`, `pos` |
| `tabs` | the Margin tab's own id (`t-` and ten letters or digits) | `url`, `title`, `icon` (an address or `data:` image the browser gave, else empty), `spaceId`, `order` (its place in the list: higher is newer, shown higher), `lastUsed` |
| `archive` | the entry's id | `url`, `title`, `spaceId`, `icon`, `closedAt` |
| `settings` | the setting's name | the setting's value (any JSON); every setting but `themes` |
| `themeSettings` | the theme's id | that theme's settings object |
| `siteIcons` | the site's origin | `data` (a `data:` image), `href`, `at` |
| `userThemes` | the theme's id | the stored package (`ui/theme-loader.js`: `format`, `id`, `version`, `manifest`, `html`, `css`, `files`) |

Only web pages are Margin tabs worth keeping: a new-tab page or an extension page isn't in `tabs`. In the extension, an open Margin tab is a browser tab's record with its Margin id (`mid`) and place (`order`); one that isn't open is in `keptTabs` (`state/model.js`).

## The merge

`extension/shared/data-merge.js` `mergeData(base, changes)` is the reference; the app's Swift store runs the same test vectors (`tests/fixtures/data-merge/*.json`). Per item:

- The later `updatedAt` wins (last write wins).
- The same `updatedAt`: a deletion wins over a live item; otherwise the change wins over what was there.
- Changes apply in the order given. A tombstone keeps a deletion against any older change, so a deleted item doesn't come back from a copy that hadn't heard.
- Items and collections the merge doesn't know are kept as they are. A malformed change is skipped.

A change is `{ collection, id, updatedAt, value }` or `{ collection, id, updatedAt, deleted: true }`.

## The extension's cache and its queue

- The extension's storage keeps working as before (`spaces`, `pins`, `folders`, `archive`, `settings`, `favicons`, the open tabs and `keptTabs` in `openTabs`): that is its cache of the data set.
- For each collection it also keeps `dataMeta:<collection>` in `storage.local`: each item's time and a short fingerprint of its value, and the tombstones (`{ items: { id: [updatedAt, fingerprint] }, gone: { id: deletedAt } }`). It's written in the same `set()` as the state keys the collection is made from (`background/store.js` flush), so a change and its time are stored together.
- The first time (storage from before this build, or wiped by Safari), every item starts at 0: what the cache had then isn't a change of the extension's, so a wiped cache that started from defaults never overwrites the app's data. Every change after that has its time.
- **The queue** is every item and tombstone with a time after the last change the app took (`pendingChanges(meta, items, since)`, `store.js pendingQueue(since)`). One entry per item: a later change to an item replaces an earlier one, which gives the same merge result.
- Tombstones are kept 60 days, at most 2,000 per collection. A deletion older than that, made while the app was never linked, could come back from the app's copy.
- User themes are stored under keys of their own; the converter reads them, but their changes aren't queued until Phase 6 builds importing.

## The converter (first link)

`dataSetFromStorage(raw, { now })` turns all of `storage.local` (as `get(null)` returns it) into a data set, from any earlier build's storage too (records without Margin ids get them, an earlier build's `lostTabs` become kept tabs). Times come from `dataMeta` where it has them, else `now`. The app stores it as the profile's first data set.

## Refilling the cache

`stateFromDataSet(state, set)` gives the extension's state from a data set (the app's, merged with the queue): spaces, pins, folders, the archive, settings, theme settings and site icons from the set; open tabs keep their browser tabs and take their Margin tab's space and place; Margin tabs that aren't open become kept tabs. The live state stays.

## Messages (step 3)

On the link (`PLAN.md` §5), next to the state messages. Each names the `profile`.

| Message | From | Body |
|---|---|---|
| `data.hello` | extension | `format`, `acked` (the newest `updatedAt` the app has confirmed, 0 for never), `queue` (the changes after `acked`) |
| `data.need` | app | `{ all: true }`: the app has no data set for this profile; the extension answers with `data.snapshot` |
| `data.snapshot` | either | `format`, `set` (a whole data set). From the extension: the converter's, for the first link. From the app: its data set merged with the queue, which the extension takes as its cache (`stateFromDataSet`) |
| `data.changes` | either | `changes` (per-item changes, oldest first): the extension's as they're made while linked, the app's own (its UI, another window's copy) |
| `data.ack` | app | `upTo`: the newest `updatedAt` it has stored; the extension keeps it as `acked` |

On link: the extension sends `data.hello`; the app merges the queue into its data set (or asks for `data.snapshot` with `data.need`), stores it, sends `data.snapshot` back, then `data.ack`. A message from the app to Chrome's or Edge's extension over 1 MB kills the port (`PLAN.md` §14, spike 3), so a large `data.snapshot` goes in parts: `part` and `parts` on each, the set split by collection and item.
