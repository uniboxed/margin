//! Items' places and the archive (piece 2, with [`super::favorites`]): M:317 `archiveKept`, M:324 `forgetKept`, M:349
//! `keptForUrl`, M:395-531 `placeOf`, `lastPlace`, `TIGHT`, `tight`, `renumber`, `placeKept`, `placeBeside` (kept
//! halves: a midpoint, renumbered when too tight), M:1069 `moveTab` (kept half), M:1777 `archiveTab` (one entry per
//! normalised address, newest first, `ARCHIVE_CAP` 200, M:17), M:1794 `removeArchived`; FI `frontItemOf`.
//!
//! The kept halves: the library's state has no open tabs (`state.tabs` is `{}`, `tabSpace` too, LT:136), so where M
//! walks `Object.values(state.tabs)` beside the kept tabs it walks nothing, and a tab id that's a number (an open tab's)
//! finds nothing; each function here takes the kept tabs' half only, an item's id a string.

use std::cmp::Ordering;
use std::rc::Rc;

use std::borrow::Cow;

use super::{Arg, bound_elsewhere, has_space, held_bindings};
use crate::library::js::{self, LocaleCompare};
use crate::library::state::{ArchiveEntry, Item, LibState, Str};

/// The archive's entries, at most (M:17 `ARCHIVE_CAP`).
pub const ARCHIVE_CAP: usize = 200;
/// Places closer than this are renumbered (M:398 `TIGHT`).
pub const TIGHT: f64 = 1e-6;

/// JavaScriptCore's words where M:321 reads `state.spaces[0].id` and there's no space: an item whose space is gone,
/// archived in a library with no spaces left. The action throws there and fails with them (`failed: …`, LT:825); the
/// built library.js (dist/app/library.js) keeps the source's names, which JSC quotes.
pub const NO_FIRST_SPACE: &str = "undefined is not an object (evaluating 'state.spaces[0].id')";

/// The side of the row a dragged item goes to, as the list shows them, newest at the top (M:516's `side`): `Before` is
/// above (a later place), `After` below. (M reads anything but `'before'` as `'after'`; LT:490 refuses other words.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Before,
    After,
}

/// M:395 `placeOf(k)` for an item: its `order` when that's finite, else 0 (an item has no `index`: `Number(undefined)
/// || 0`).
#[inline]
pub fn place_of(k: &Item) -> f64 {
    if k.order.is_finite() { k.order } else { 0.0 }
}

/// M:396 `lastPlace(state)`, its kept half: the highest place, -1 for none (`Math.max(-1, …)`).
pub fn last_place(s: &LibState) -> f64 {
    s.kept.values().fold(-1.0, |top, k| js::max(top, place_of(k)))
}

/// Every place in order (`.map(placeOf).sort((a, b) => a - b)`).
fn places(s: &LibState) -> Vec<f64> {
    let mut places: Vec<f64> = s.kept.values().map(|k| place_of(k)).collect();
    places.sort_by(|a, b| js::num_cmp(*a, *b));
    places
}

/// M:460 `tight(state)`, its kept half: two places that differ by less than [`TIGHT`].
pub fn tight(s: &LibState) -> bool {
    places(s).windows(2).any(|w| w[1] != w[0] && w[1] - w[0] < TIGHT)
}

/// M:464 `renumber(state)`, its kept half: every item placed 0, 1, 2… in the order of its place (the stable sort: equal
/// places keep the items' order). An item already at its number is kept as it was (the TS makes a copy of every one,
/// which nothing tells apart: the same values).
pub fn renumber(s: &LibState) -> LibState {
    let mut all: Vec<&Rc<Item>> = s.kept.values().collect();
    all.sort_by(|a, b| js::num_cmp(place_of(a), place_of(b)));
    let renumbered: Vec<(Str, Rc<Item>)> = all
        .into_iter()
        .enumerate()
        .filter(|(i, k)| k.order.to_bits() != (*i as f64).to_bits())
        .map(|(i, k)| (k.id.clone(), Rc::new(Item { order: i as f64, ..(**k).clone() })))
        .collect();
    let mut next = s.clone();
    let kept = Rc::make_mut(&mut next.kept);
    for (id, k) in renumbered {
        kept.insert(id, k);
    }
    next
}

/// `state.keptTabs?.[keptId]`'s key for an id as library.ts passes it (`p.tabId` as it came, LT:476, 481): ToPropertyKey
/// (`["t-a"]` looks up `"t-a"`, a missing one `"undefined"`).
fn key_of(id: Arg<'_>) -> Cow<'_, str> {
    match id {
        Arg::Str(s) => Cow::Borrowed(s),
        Arg::Value(v) => js::property_key(Some(v)),
        Arg::Undefined => js::property_key(None),
    }
}

/// M:324 `forgetKept(state, keptId)`: the item gone (not archived); the state itself when there's none.
pub fn forget_kept(s: &LibState, kept_id: Arg<'_>) -> LibState {
    let key = key_of(kept_id);
    if !s.kept.contains_key(&key) {
        return s.clone();
    }
    let mut next = s.clone();
    Rc::make_mut(&mut next.kept).remove(&key);
    next
}

/// M:317 `archiveKept(state, keptId, { id, closedAt })`: the item gone, and a web page's (`/^https?:/i`) in the archive
/// as entry `id` ([`archive_tab`]: its space, else the first space's). The state itself when there's no such item.
/// `Err` where the TS throws: an item of a space that's gone, in a library with no spaces ([`NO_FIRST_SPACE`]).
pub fn archive_kept(s: &LibState, kept_id: Arg<'_>, id: &str, closed_at: f64) -> Result<LibState, &'static str> {
    let Some(k) = s.kept.get(&key_of(kept_id)) else {
        return Ok(s.clone());
    };
    let next = forget_kept(s, kept_id);
    if !js::is_http(&k.url) {
        return Ok(next);
    }
    let space_id =
        if has_space(s, &k.space_id) { k.space_id.clone() } else { s.spaces.first().ok_or(NO_FIRST_SPACE)?.id.clone() };
    let entry = ArchiveEntry {
        id: id.into(),
        url: k.url.clone(),
        title: k.title.clone(),
        space_id,
        fav_icon_url: k.fav_icon_url.clone(),
        closed_at,
        target: None,
    };
    Ok(archive_tab(&next, entry, ARCHIVE_CAP))
}

/// M:1777 `archiveTab(state, entry, cap)`: `entry` first (its title the address when it has none), every other entry
/// at its normalised address dropped, at most `cap`. The state itself for an entry with no address. (`entry.target` is
/// as given: M's entry has none, LT:239 gives it the item's.)
pub fn archive_tab(s: &LibState, entry: ArchiveEntry, cap: usize) -> LibState {
    if entry.url.is_empty() {
        return s.clone();
    }
    let entry = if entry.title.is_empty() { ArchiveEntry { title: entry.url.clone(), ..entry } } else { entry };
    let key = js::normalize_url(&entry.url).into_owned();
    let mut archive = Vec::with_capacity((s.archive.len() + 1).min(cap));
    archive.push(Rc::new(entry));
    archive.extend(s.archive.iter().filter(|a| js::normalize_url(&a.url) != *key).cloned());
    archive.truncate(cap);
    LibState { archive: Rc::new(archive), ..s.clone() }
}

/// M:1794 `removeArchived(state, archiveId)`: the archive without that entry. Always a new list, as the TS's `filter`
/// (never the state itself, even with no such entry).
pub fn remove_archived(s: &LibState, archive_id: &str) -> LibState {
    let archive: Vec<Rc<ArchiveEntry>> = s.archive.iter().filter(|a| *a.id != *archive_id).cloned().collect();
    LibState { archive: Rc::new(archive), ..s.clone() }
}

/// Whose an item found by address is for (M:349's `forWhom`, PR `boundElsewhere`'s `{ pinId, favoriteId }`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ForWhom<'a> {
    pub pin_id: Option<&'a str>,
    pub favorite_id: Option<&'a str>,
}

/// M:349 `keptForUrl(state, url, spaceId, forWhom)`: the space's item at this address (normalised) used last (the first
/// of several equal: the items' order), none bound to another pin or favorite when `for_whom` is given.
pub fn kept_for_url<'a>(s: &'a LibState, url: &str, space_id: &str, for_whom: Option<ForWhom>) -> Option<&'a Rc<Item>> {
    let key = js::normalize_url(url);
    let mut best: Option<&Rc<Item>> = None;
    for k in s.kept.values() {
        if *k.space_id != *space_id || js::normalize_url(&k.url) != key {
            continue;
        }
        if for_whom.is_some_and(|w| bound_elsewhere(s, k, space_id, w.pin_id, w.favorite_id)) {
            continue;
        }
        // (`.sort((a, b) => b.lastActive - a.lastActive)[0]`: the stable sort's first.)
        if best.is_none_or(|b| js::num_cmp(k.last_active, b.last_active) == Ordering::Greater) {
            best = Some(k);
        }
    }
    best
}

/// M:516 `placeBeside(state, moving, nextTo, side, spaceId)`, its kept half: the place beside item `next_to` on `side`
/// in the space's list as shown (its items but `moving`, by place), for item `moving`: between it and its neighbour on
/// that side, else one past it. `None` when either isn't an item, they're one, or `next_to` isn't in the space.
pub fn place_beside(s: &LibState, moving: &str, next_to: &str, side: Side, space_id: &str) -> Option<f64> {
    let moving = s.kept.get(moving)?;
    let other = s.kept.get(next_to)?;
    if Rc::ptr_eq(other, moving) {
        return None;
    }
    let mut list: Vec<&Rc<Item>> =
        s.kept.values().filter(|x| *x.space_id == *space_id && !Rc::ptr_eq(x, moving)).collect();
    list.sort_by(|a, b| js::num_cmp(place_of(a), place_of(b)));
    let at = list.iter().position(|x| Rc::ptr_eq(x, other))?;
    let o = place_of(other);
    let neighbour = match side {
        Side::Before => list.get(at + 1),
        Side::After => at.checked_sub(1).and_then(|i| list.get(i)),
    };
    Some(match (neighbour, side) {
        (None, Side::Before) => o + 1.0,
        (None, Side::After) => o - 1.0,
        (Some(n), _) => (o + place_of(n)) / 2.0,
    })
}

/// M:491 `placeKept(state, keptId, nextTo, side, spaceId)`: item `kept_id` placed beside `next_to` ([`place_beside`]),
/// every item renumbered when places got too close ([`tight`]). The state itself when there's no such place.
pub fn place_kept(s: &LibState, kept_id: &str, next_to: &str, side: Side, space_id: &str) -> LibState {
    let Some(order) = place_beside(s, kept_id, next_to, side, space_id) else {
        return s.clone();
    };
    let Some(k) = s.kept.get(kept_id) else {
        return s.clone();
    };
    let mut next = s.clone();
    Rc::make_mut(&mut next.kept).insert(k.id.clone(), Rc::new(Item { order, ..(**k).clone() }));
    if tight(&next) { renumber(&next) } else { next }
}

/// M:1069 `moveTab(state, tabId, spaceId)`, its kept half (a string id): the item in another space, without a pin's
/// binding of the space it left ([`held_bindings`]). The state itself for no such item or space, or its own space.
pub fn move_tab(s: &LibState, tab_id: &str, space_id: &str) -> LibState {
    let Some(k) = s.kept.get(tab_id) else {
        return s.clone();
    };
    if !has_space(s, space_id) || *k.space_id == *space_id {
        return s.clone();
    }
    let moved = Rc::new(Item { space_id: space_id.into(), ..(**k).clone() });
    let held = held_bindings(s, &moved, space_id);
    let mut next = s.clone();
    Rc::make_mut(&mut next.kept).insert(k.id.clone(), held);
    next
}

/// FI `frontItemOf(items, spaceId, except)`: the space's item used last (the selected one breaks a tie, then the id
/// `localeCompare` puts first), but `except`; none for a space with none.
pub fn front_item_of<'a>(
    items: impl IntoIterator<Item = &'a Rc<Item>>,
    space_id: &str,
    except: Option<&str>,
    compare: &dyn LocaleCompare,
) -> Option<&'a Rc<Item>> {
    let finite = |x: f64| if x.is_finite() { x } else { 0.0 };
    let mut best: Option<&Rc<Item>> = None;
    for k in items {
        if *k.space_id != *space_id || Some(&*k.id) == except {
            continue;
        }
        let Some(b) = best else {
            best = Some(k);
            continue;
        };
        // (`d = Δ lastActive || Δ wasActive || best.id.localeCompare(k.id)`; `d > 0`: k.)
        let d = js::num_cmp(finite(k.last_active), finite(b.last_active))
            .then(k.was_active.cmp(&b.was_active))
            .then_with(|| compare.compare(&b.id, &k.id));
        if d == Ordering::Greater {
            best = Some(k);
        }
    }
    best
}

#[cfg(test)]
#[path = "kept_tests.rs"]
mod tests;
