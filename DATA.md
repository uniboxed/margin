# Margin's lasting data

What Margin keeps between launches, the shape Margin.app stores it in on the Mac (`PLAN.md` §6, "Where data lives"), and how the extension and the app exchange it. Built on the extension's side in Margin 2, Phase 2 step 1; the app's store and the link's data messages in step 3.

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
| `userThemes` | the theme's id | unused: imported themes belong to the Mac, kept by Margin.app outside the data sets (`app/shell/ThemeStore.swift`); copies get the index by `req userThemes` (`app/PROTOCOL.md` "User themes") |

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
- For each collection it also keeps `dataMeta:<collection>` in `storage.local`: each item's time and a short fingerprint of its value, and the tombstones (`{ items: { id: [updatedAt, fingerprint] }, gone: { id: deletedAt } }`). A change's time is taken as the state keys the collection is made from are written (`background/store.js` flush), and the meta is written in a `set()` of its own 1.5 s later, off a switch's way (in the same `set()`, its larger writes and change events made a carried sidebar miss a page's first frame in the WebKit host). If the background stops before that write, the collection's next write finds the change again, against the stored meta, with that later time. Pages ignore these keys.
- The first time (storage from before this build, or wiped by Safari), every item starts at 0: what the cache had then isn't a change of the extension's, so a wiped cache that started from defaults never overwrites the app's data. Every change after that has its time.
- **The queue** is every item and tombstone with a time after the last change the app took (`pendingChanges(meta, items, since)`, `store.js pendingQueue(since)`). One entry per item: a later change to an item replaces an earlier one, which gives the same merge result.
- Tombstones are kept 60 days, at most 2,000 per collection. A deletion older than that, made while the app was never linked, could come back from the app's copy.
- User themes aren't in the data set: Margin.app keeps them for the whole Mac (`app/PROTOCOL.md` "User themes"). A copy keeps only their index (`storage.local` `userThemes`, from the app). The converter still reads `userTheme:<id>` keys, but no build ever wrote any.

## The converter (first link)

`dataSetFromStorage(raw, { now })` turns all of `storage.local` (as `get(null)` returns it) into a data set, from any earlier build's storage too (records without Margin ids get them, an earlier build's `lostTabs` become kept tabs). Times come from `dataMeta` where it has them, else `now`. The app stores it as the profile's first data set.

## Refilling the cache

`stateFromDataSet(state, set)` gives the extension's state from a data set (the app's, merged with the queue): spaces, pins, folders, the archive, settings, theme settings and site icons from the set; open tabs keep their browser tabs and take their Margin tab's space and place; Margin tabs that aren't open become kept tabs. The live state stays.

## The app's files

Margin.app keeps each profile's data set in `~/Library/Application Support/Margin/data/` (`app/shell/DataStore.swift`):

```text
data/<browser>/<profile>/set.json                  { format, browser, profile, acked, rev, savedAt }
data/<browser>/<profile>/items/<collection>.json   { format, collection, items: { id: item } }
```

- One file per collection, so a change to a space doesn't rewrite every site icon. `set.json` says the profile has a data set, and keeps `acked`: the newest `upTo` the app has confirmed to that profile's copy (`data.ack`), and `rev`, the set's revision (see "Revisions").
- Folder names are the browser's and profile's ids with everything but `a–z`, `0–9`, `_` and `-` written as `%XX` (profile `P1` is `%501`), so no id can be `..`, and two ids that differ only in case stay apart on a case-insensitive disk. Margin's collections keep their names (`themeSettings.json`); any other collection (a later format's) is written the same way after `x-`. The real names are the ones inside the files.
- **Writing:** the whole file goes to a temporary file beside it (`.<name>.<random>.tmp`, flushed with `fsync`), the version it replaces is kept as `<name>.bak` (a hard link, so the file is never missing), then the new one is renamed over it. Only the collections that changed are written, then `set.json`, last. A save that changes the set writes `set.json` first too, with the new `rev` and the `acked` from before, so a crash between the files never leaves new items under a `rev` a copy already has. The copy gets `data.ack` only once all of it is on disk.
- **Reading:** a file that can't be read is taken from its `.bak`; temporary files a crash left are removed. A profile without `set.json` (or its `.bak`) has no data set. A file of a later `format` leaves that profile's data alone: not read, never written over.
- **A crash mid-write** leaves every file whole, each the old version or the new, though the collections can be a mix of both. Nothing was acked, so the copy sends the same queue on its next link, and the merge (which gives the same result applied twice) makes the set whole again. A write the disk lost after the ack (a power cut: macOS's `fsync` doesn't flush the drive's cache), or files restored from an older backup, show up as a copy with more confirmed (`acked`) than `set.json` has: the app then asks for the whole set (`data.need`) and merges it in.
- **A profile under a new id** (a build signed by another team, or unsigned over a signed one: Safari gives each named profile's copy a new id): with Full Disk Access, the app carries the profile's set to the new id once Safari's files map both to the same Safari profile (`browser.json`'s `browserId`), and puts the old folder away as `data/<browser>/.archived/<profile>-<ms>/`, whole. Nothing reads or lists it there. The new copy's own fresh items become deletions, so its copy ends up with the profile's set alone. DECISIONS.md "Margin 2: Safari reliability" › "A profile's spaces follow it across a signing change".
- Tombstones are dropped when a set is saved once they're older than 60 days, and beyond the newest 2,000 in a collection (the extension's limits).
- Tests use a temporary folder (`Shell.Options.dataRoot`; a harness without one gets a new temporary folder), never the real one.

The rest of the app reads the data through `Shell.data` (`DataSync`): `profiles(browser:)`, `set(of:)`, `values(_:of:)` (a collection's live values), `marginTabs(of:space:)`, `onChange`, and `change(_:_:)` for the app's own changes; `Shell.notOpenTabs(_:space:)` gives a profile's Margin tabs that aren't open (all of them for a profile that isn't linked).

## Messages

On the link (`app/PROTOCOL.md`), next to the state messages, any time after `hello`. Each names the `profile`; the app's also carry the link's `epoch`. A message only ever touches the data set of the link it came on (its browser and profile): one naming another profile, or another epoch, is ignored.

| Message | From | Body |
|---|---|---|
| `data.hello` | extension | `format`, `acked` (the newest `upTo` the app has confirmed, 0 for never), `rev` (the last `rev` it took from the app; left out if it has none: never linked, or its storage wiped), `queue` (the changes after `acked`, oldest first) |
| `data.need` | app | `all: true`: the app has no data set for this profile, or one older than the copy's `acked`; the extension answers with `data.snapshot` |
| `data.snapshot` | either | `format`, `set` (a whole data set, or one part of one), `transfer`, `part`, `parts`; from the app, `rev` on part 0 (the set's revision) and `omitted` on part 0 when it left anything out |
| `data.changes` | either | `changes` (per-item changes, oldest first): the extension's as they're made while linked; the app's own, and its answers to changes that lost |
| `data.ack` | app | `upTo` (below), and `rev` when the link is in step (see "Revisions"); the extension keeps `upTo` as `acked`, and `rev` if there is one |

What the app does with each:

- **`data.hello`:** if it has the profile's set and `acked` isn't above the set's own `acked`, it merges the queue and stores the set. Then, if the copy's `rev` is the set's `rev` from before the merge (the copy has every item the app had), no snapshot: the queue's changes that lost the merge are answered with the app's items in `data.changes`, then `data.ack` with the new `rev`. If the copy's `rev` is another one or missing (an app-side change it hasn't had, files restored from an older backup, another Mac's), the app sends the set back whole (`data.snapshot`), then `data.ack`. If it has no set, or `acked` is above the set's, it sends `data.need` and holds the queue until the copy's `data.snapshot` comes.
- **`data.snapshot` from the extension** (the converter's, `dataSetFromStorage`): with no set for the profile, the held queue and then the snapshot are merged into nothing and stored as the profile's set, then `data.ack`; nothing is sent back (the copy has it all). With a set (a copy with more `acked` than the app's files, or a snapshot the app didn't ask for), it's merged into the app's set, stored, sent back merged, then `data.ack`.
- **`data.changes` from the extension:** merged, stored, then `data.ack`. A change that lost to a newer item of the app's (or to a tombstone of the same time) is answered with that item in `data.changes` before the ack, so the copy's cache follows. Changes that come while the app waits for a snapshot, or before it has a set, are held and merged after it.
- **The app's own changes** (its UI, step 4): merged, stored (a new `rev`), and sent in `data.changes`, with no `rev`, to the profile's copy if it's linked; the copy's next `data.hello` then names an older `rev` and gets the snapshot. A later `data.ack` with a `rev` covers them too.
- **`upTo`:** the newest `updatedAt` among the extension's changes the app has stored (its queue, its snapshot, its `data.changes`; one that lost the merge counts too, as it's settled), never lower than the copy's `acked`. Sent only once the set is on disk: a write that fails sends nothing, and the copy keeps its queue.

**Parts.** Nothing from the app is over 1 MB (a bigger message kills Chrome's and Edge's port: `PLAN.md` §14, spike 3), so the app's `data.snapshot` is split by collection and item: each part is a data set of its own with at most about 900 KB of items, the parts of one snapshot share a `transfer` (any string) and are numbered `part` from 0 of `parts` (1 when it fits). Every collection of the set is named in part 0, an empty one too (`{}`), so the copy learns that a collection is now empty. The whole is the union of the parts' items. An item whose JSON alone is over the limit (a user theme package can be 4.5 MB) can't go: it's left out and listed in part 0's `omitted: [[collection, id]]`, and the extension keeps its own copy (user themes will go as `theme` pieces, Phase 6). A long `data.changes` from the app goes as several, in order. The extension may send its `data.snapshot` whole (the app takes messages up to 64 MB) or in parts the same way.

**Revisions.** Each profile's stored set has a `rev`, a string: a number counting up, a dash, then random hex (`12-3f9a0c1b7e`), new at every save that changes the set (the extension's changes, the app's own, a snapshot taken, tombstones pruned) and kept as it is by one that changes nothing. The random part means a set restored from an older backup, or another Mac's, never has a `rev` a copy holds for something else. Compare `rev`s only for being the same string. The app sends `rev` on its `data.snapshot` (part 0: the set it's sending) and on `data.ack` once the link is in step: the copy has had a snapshot on this link, or its `data.hello` named the set's `rev`, or it's the first link (the set is the copy's own). Then, with everything the app sent before the ack applied, the copy has every item of the set at that `rev`. A `data.ack` without `rev` (changes before `data.hello` on a new link) leaves the copy's `rev` as it was. The app's `data.changes` carry no `rev`.

**For the extension's end:**

- Take the app's `data.snapshot` as the cache (`stateFromDataSet`) once all its parts are here, with any change made after the `data.hello` was sent merged into it first, so a snapshot crossing a change doesn't undo it.
- Keep the `rev` from the app's `data.snapshot` (part 0) once the snapshot is applied, and the `rev` of each `data.ack` that has one; send it in `data.hello`. Drop it whenever the cache stops being the app's set plus the copy's own queued changes (storage wiped, defaults written, a cache refilled from anything but the app), so the next `data.hello` gets the snapshot.
- A refill isn't the copy's own change: its meta (`dataMeta:<collection>`) should take the set's times, or the next queue sends the app's items back as new ones.

## Spaces across profiles

Margin 2, Phase 2 step 4 (`PLAN.md` §15). Each space belongs to one browser profile: the profile whose data set has it. Nothing in a set names its profile, so a space can't be in two, and a profile's copy needs nothing new to keep its own.

What spans profiles is kept by the app, one file per browser, beside its profiles' sets (`app/shell/BrowserProfiles.swift`):

```text
data/<browser>/browser.json   { format: 1, browser, order: [[profile, spaceId]], profiles: { id: info }, savedAt }
```

- **`order`:** every profile's spaces in the one order the person controls (the sidebar's chips, next/previous space, the swipe). It's read against the sets each time ("the slots rule"): a space no set has any more is left out; each profile's spaces fill the places its spaces have in the order, in that profile's own order (its spaces' `order`), so a reorder made in one profile while the app wasn't there still shows; a new space goes right after the one before it in its profile's order (the profile's first: before the others); a profile not in the order yet comes last. A move in the whole order that changes a profile's own order is written into that profile's set too (`orderSpaces` to its copy, or the set's `order` fields when it isn't linked), so the copy alone (the in-page host) shows the same order.
- **`profiles`:** per profile id, `name`, `emoji`, `color`, `named` (the person named it), `firstSeen`, `lastSeen` (linked last), `hidden` (forgotten by the person), and, once Safari's name for it has been read, `browserId` (Safari's id for the profile: its `server_id`, `DefaultProfile` for the default one) and `browserName` (the name Safari last gave it). Browsers don't give extensions profile names, so without Full Disk Access the person names each one once; until then Safari's default profile (`s-default`) is "Default" and the others "Profile 2", "Profile 3"… by when Margin first saw them, each with a color of its own.
- **Safari's own names (Phase 2 step 9):** with Full Disk Access, Margin.app reads Safari's names and symbols for its profiles, read only (`app/shell/SafariProfiles.swift`, below), and shows them over a typed name, kept in step with Safari as it runs; they're never written into `name`, so without the permission (or if it's withdrawn) the typed names come back. Edit Profile then changes only the emoji and color. A profile Safari no longer has (`browserId` gone from Safari's database after a good read) keeps the name Safari last gave it, as a typed name (unless one was typed), and its `browserId` is cleared; its spaces and data stay as for any profile not seen.
- **What Margin.app reads of Safari's (read only, never written):** `~/Library/Containers/com.apple.Safari/Data/Library/Safari/SafariTabs.db` (SQLite, opened `mode=ro`, or `mode=ro&immutable=1` with no `-wal` beside it so nothing is made there; a 200 ms busy timeout; open, read, closed), table `bookmarks`, rows with `type = 1`, `subtype = 2`, `parent = 0`, `deleted = 0`: `title`, `external_uuid`, `server_id`, and `SymbolImageName` from `extra_attributes` (a property list). And, for each of those, `Profiles/<server_id>/WebExtensions/Extensions.plist`, Margin's own entry only (`io.tirth.margin.Extension (<team>)`): its `ProfileIdentifier`, the UUID Safari sends Margin's handler as `SFExtensionProfileKey`, which is how a copy (`s-<uuid>`) is linked to its profile. The default profile's copy (`s-default`) is always `DefaultProfile`. Never a tab, a tab group, an address or another extension's settings; the log says names and ids only.
- **A profile not seen for a long time** stays as it is: its data set and spaces are kept, never deleted by Margin. Not linked for 30 days, its menu says so ("Forget … (not seen for a month)"). **Forgetting** one (only one that isn't linked) takes its spaces out of the order and leaves its data alone; its copy linking again brings it back.
- **A profile's last space** can't be deleted (each copy needs a space), as before with one profile.
- Written like the sets' files (a temporary file, `fsync`, `.bak`, rename), at once (it's a few KB).

**Not-open tabs of a profile with no window** are the app's (`Shell.notOpenTabs`: all of a profile's Margin tabs when it isn't linked) and the copy's own kept tabs (`keptTabs`): a window closed by the switch keeps its tabs there (step 1's rule for a window closing), and the profile's copy opens them again when the space is switched back to (`state/model.js spaceWindowTabs`: in front, the space's tab used last; behind it, the others that were open with it in that window, in their old order). They start fresh, with no Back history.

What each overlay is sent (`across`, `ui/host-app.js`, `shared/across.js`): `{ v: 1, profile, profiles: [{ id, name, emoji, color, named, nameFrom?, symbol?, here, linked, lastSeen, stale, spaces }], spaces: [{ profile, id, name, emoji, color, tabCount }], switching? }`, in the overlay's `hello` and again (`{ type: 'across' }`) whenever it changes. `nameFrom: "safari"`: the name is Safari's own (above), and `symbol` its SF Symbol drawn by the app as a small white PNG (a `data:` URL, about 24 px, for a theme's profile mark as an `m-icon`); a page takes only a PNG data URL there. `tabCount` is the space's Margin tabs in the app's set, open or not. `switching`: the cross-profile switch under way (`profile`, `space`, `phase`) and, when the person has something to do or it failed, `notice` (Margin's words).
