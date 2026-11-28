//! Splits (piece 3, with [`super::links`]): M:1628-1775 `normalizeSplitRatios`, `paneKey` and `hasMarginTab` (kept
//! halves: a pane is an item's id), `splitForItem`, `withPanes`, `createSplit`, `addToSplit`, `removeFromSplit`,
//! `settleSplits` (after every action that succeeds, LT:830), `swapSplitPanes`, `resizeSplit`, `toggleSplitAxis`.
//! `MAX_SPLIT_PANES` is `state::MAX_SPLIT_PANES`.
//!
//! Each a transliteration with M's names. The library's state has no open tabs (LT:136 `tabs: {}`), so a pane named by
//! a browser's tab id (a number, or a string of digits) is never an item here: `paneKey` answers none for it, as M does
//! with no open tab of that id. M's `find` is the first split with an id and its `map`/`filter` every one with it, as
//! the TS's (two splits never share an id in a state read from the store, but an action given an id twice could make
//! two). A split M remakes (`{ ...g, panes, ratios }`) is a new `Rc`; every other one stays the same `Rc`.

use std::rc::Rc;

use serde_json::Value;

use super::has_space;
use crate::library::js;
use crate::library::state::{Axis, LibState, MAX_SPLIT_PANES, Split, Str};

/// M:1637 `normalizeSplitRatios(ratios, count)` for ratios as numbers (the state's own: always an array): `count`
/// ratios summing to about 1 at 4 decimals, each given one kept relative to the others when there's one per pane (a
/// ratio that isn't a positive finite number is 1), else equal.
pub fn normalize_split_ratios(ratios: Option<&[f64]>, count: usize) -> Vec<f64> {
    let raw = ratios
        .filter(|r| r.len() == count)
        .map(|r| r.iter().map(|&x| if x.is_finite() && x > 0.0 { x } else { 1.0 }).collect());
    normalize(raw, count)
}

/// M:1637 `normalizeSplitRatios(ratios, count)` for a payload's ratios (`p?.ratios`: any JSON; `Number.isFinite(r) && r
/// > 0 ? r : 1`, so `"2"`, `null` and `true` are 1).
pub fn normalize_split_ratios_of(ratios: Option<&[Value]>, count: usize) -> Vec<f64> {
    let raw = ratios
        .filter(|r| r.len() == count)
        .map(|r| r.iter().map(|x| js::finite(Some(x)).filter(|&n| n > 0.0).unwrap_or(1.0)).collect());
    normalize(raw, count)
}

/// M:1641-1643: `raw.reduce((acc, v) => acc + v, 0) || count`, each `Math.round((v / sum) * 10000) / 10000`.
fn normalize(raw: Option<Vec<f64>>, count: usize) -> Vec<f64> {
    if count == 0 {
        return Vec::new();
    }
    let mut raw = raw.unwrap_or_else(|| vec![1.0; count]);
    let total = raw.iter().fold(0.0, |acc, v| acc + v);
    let sum = if total == 0.0 || total.is_nan() { count as f64 } else { total };
    for v in &mut raw {
        *v = js::round((*v / sum) * 10000.0) / 10000.0;
    }
    raw
}

/// M:1648 `paneKey(state, itemId)` for a string, its kept half: the item's id itself; none for `""`, and for a string
/// of digits (`/^\d+$/`: an open tab's browser id, which the library has none of).
#[inline]
pub fn pane_key(item_id: &str) -> Option<&str> {
    if item_id.is_empty() || item_id.bytes().all(|b| b.is_ascii_digit()) { None } else { Some(item_id) }
}

/// M:1648 `paneKey(state, itemId)` for a payload's value (`p?.tabId`): a string's [`pane_key`]; none for a number (an
/// open tab's browser id: none here) and for anything else.
#[inline]
pub fn pane_key_of(item_id: Option<&Value>) -> Option<&str> {
    item_id.and_then(Value::as_str).and_then(pane_key)
}

/// M:1657 `hasMarginTab(state, mid)`, its kept half: an item with this id (`!!state.keptTabs?.[mid]`: an own key only,
/// open question 4).
#[inline]
pub fn has_margin_tab(s: &LibState, mid: &str) -> bool {
    s.kept.contains_key(mid)
}

/// M:1659 `splitForItem(state, itemId)`: the first split with this item as a pane.
pub fn split_for_item<'s>(s: &'s LibState, item_id: &str) -> Option<&'s Rc<Split>> {
    let key = pane_key(item_id)?;
    s.splits.iter().find(|g| g.panes.iter().any(|p| **p == *key))
}

/// M:1659 `splitForItem(state, p?.tabId)` for a payload's value ([`pane_key_of`]).
pub fn split_for_value<'s>(s: &'s LibState, item_id: Option<&Value>) -> Option<&'s Rc<Split>> {
    split_for_item(s, pane_key_of(item_id)?)
}

/// The first split with this id (`(state.splits ?? []).find((g) => g.id === splitId)`).
fn split_of<'s>(s: &'s LibState, split_id: &str) -> Option<&'s Rc<Split>> {
    s.splits.iter().find(|g| *g.id == *split_id)
}

/// The state with every split of this id remade by `remake` (`list.map((g) => (g.id === splitId ? … : g))`), the others
/// the same `Rc`s.
fn map_split(s: &LibState, split_id: &str, mut remake: impl FnMut(&Split) -> Rc<Split>) -> LibState {
    let mut next = s.clone();
    next.splits = Rc::new(s.splits.iter().map(|g| if *g.id == *split_id { remake(g) } else { g.clone() }).collect());
    next
}

/// M:1667 `withPanes(group, panes)`: the split with only `panes` of its own left, in that order, their ratios kept
/// relative to each other; none for fewer than 2 (the split goes).
pub fn with_panes(group: &Split, panes: Vec<Str>) -> Option<Split> {
    if panes.len() < 2 {
        return None;
    }
    let old = normalize_split_ratios(Some(&group.ratios), group.panes.len());
    let kept: Vec<f64> = panes
        .iter()
        .map(|p| group.panes.iter().position(|x| x == p).and_then(|i| old.get(i).copied()).unwrap_or(1.0))
        .collect();
    let ratios = normalize_split_ratios(Some(&kept), panes.len());
    Some(Split { panes, ratios, ..group.clone() })
}

/// M:1673 `createSplit(state, { id, spaceId, panes, axis, ratios })`: a split of the items among `panes` (each once, at
/// most 4; 2 at least, else the state itself), each first taken out of the split it's in, with `ratios` when there's
/// one for every pane asked for and every one is a pane (else equal), appended. `panes` are ids (LT:674 gives the
/// payload's strings that name items); `ratios` the payload's (`p?.ratios`, an array or not).
pub fn create_split(
    s: &LibState,
    id: &str,
    space_id: &str,
    panes: &[&str],
    axis: Axis,
    ratios: Option<&[Value]>,
) -> LibState {
    if !has_space(s, space_id) {
        return s.clone();
    }
    let mut unique: Vec<Str> = Vec::with_capacity(panes.len().min(MAX_SPLIT_PANES));
    for p in panes {
        let Some(key) = pane_key(p) else { continue };
        let Some(item) = s.kept.get(key) else { continue };
        if !unique.iter().any(|u| **u == *key) {
            unique.push(if *item.id == *key { item.id.clone() } else { Str::from(key) });
        }
    }
    unique.truncate(MAX_SPLIT_PANES);
    if unique.len() < 2 {
        return s.clone();
    }
    // Remove any of these panes from existing splits first so a tab belongs to at most one split.
    let mut next = s.clone();
    for p in &unique {
        if let Some(prev) = split_for_item(&next, p).map(|g| g.id.clone()) {
            next = remove_from_split(&next, &prev, p);
        }
    }
    // (Ratios given for every pane asked for, by the same index; else equal.)
    let given = ratios.filter(|r| r.len() == panes.len() && unique.len() == panes.len());
    let ratios = normalize_split_ratios_of(given, unique.len());
    let group = Split {
        id: id.into(),
        space_id: space_id.into(),
        axis,
        panes: unique,
        ratios,
        pinned: false,
        folder_id: None,
        pos: None,
    };
    Rc::make_mut(&mut next.splits).push(Rc::new(group));
    next
}

/// M:1697 `addToSplit(state, splitId, paneId)`: the item last in the split (out of any other first), the ratios made
/// equal; the state itself for no such split or item, a pane already, or a split of 4.
pub fn add_to_split(s: &LibState, split_id: &str, pane_id: &str) -> LibState {
    add_to_split_at(s, split_id, pane_id, None)
}

/// M `addToSplit(state, splitId, paneId, at)`'s place: `at` a JSON number that's a whole number from 0 to `count`
/// (`typeof at === 'number' && Number.isInteger(at) && at >= 0 && at <= count`; -0 is 0), else the end.
pub fn place_of(at: Option<&Value>, count: usize) -> usize {
    match at.and_then(Value::as_f64) {
        Some(x) if x.is_finite() && x.fract() == 0.0 && x >= 0.0 && x <= count as f64 => x as usize,
        _ => count,
    }
}

/// M `addToSplit(state, splitId, paneId, at)` (docs/FLEX-SPLIT.md step 2): as [`add_to_split`], the item at `at`
/// ([`place_of`]) among the panes.
pub fn add_to_split_at(s: &LibState, split_id: &str, pane_id: &str, at: Option<&Value>) -> LibState {
    let key = pane_key(pane_id);
    let group = split_of(s, split_id);
    let (Some(group), Some(key)) = (group, key) else { return s.clone() };
    if !has_margin_tab(s, key) || group.panes.iter().any(|p| **p == *key) || group.panes.len() >= MAX_SPLIT_PANES {
        return s.clone();
    }
    let group = group.clone();
    let mut next = s.clone();
    if let Some(other) = split_for_item(&next, key).filter(|o| *o.id != *split_id).map(|o| o.id.clone()) {
        next = remove_from_split(&next, &other, key);
    }
    let mut panes = group.panes.clone();
    let place = place_of(at, panes.len());
    panes.insert(
        place,
        s.kept.get(key).map(|k| k.id.clone()).filter(|id| **id == *key).unwrap_or_else(|| Str::from(key)),
    );
    let ratios = normalize_split_ratios(None, panes.len());
    map_split(&next, split_id, |g| Rc::new(Split { panes: panes.clone(), ratios: ratios.clone(), ..g.clone() }))
}

/// M `replaceInSplit(state, splitId, outId, paneId)` (docs/FLEX-SPLIT.md step 2): the item in the place of the split's
/// pane `out_id`, its ratio, the other panes as they are (out of any other split first); `out_id` out of the split. The
/// state itself for no such split, `out_id` not a pane of it, or the item none or a pane of it already.
pub fn replace_in_split(s: &LibState, split_id: &str, out_id: &str, pane_id: &str) -> LibState {
    let key = pane_key(pane_id);
    let group = split_of(s, split_id);
    let (Some(group), Some(key)) = (group, key) else { return s.clone() };
    if !has_margin_tab(s, key) || group.panes.iter().any(|p| **p == *key) || !group.panes.iter().any(|p| **p == *out_id)
    {
        return s.clone();
    }
    let group = group.clone();
    let mut next = s.clone();
    if let Some(other) = split_for_item(&next, key).filter(|o| *o.id != *split_id).map(|o| o.id.clone()) {
        next = remove_from_split(&next, &other, key);
    }
    let id = s.kept.get(key).map(|k| k.id.clone()).filter(|id| **id == *key).unwrap_or_else(|| Str::from(key));
    let panes: Vec<Str> = group.panes.iter().map(|p| if **p == *out_id { id.clone() } else { p.clone() }).collect();
    map_split(&next, split_id, |g| Rc::new(Split { panes: panes.clone(), ..g.clone() }))
}

/// M:1709 `removeFromSplit(state, splitId, paneId)`: the pane out, the others' ratios kept relative to each other; one
/// left: the split goes. The state itself for no such split or a pane not in it.
pub fn remove_from_split(s: &LibState, split_id: &str, pane_id: &str) -> LibState {
    let key = pane_key(pane_id);
    let group = split_of(s, split_id);
    let (Some(group), Some(key)) = (group, key) else { return s.clone() };
    if !group.panes.iter().any(|p| **p == *key) {
        return s.clone();
    }
    // Fewer than 2 panes remaining: dissolve the split group automatically.
    let left = with_panes(group, group.panes.iter().filter(|p| ***p != *key).cloned().collect()).map(Rc::new);
    match left {
        Some(left) => map_split(s, split_id, |_| left.clone()),
        None => {
            let mut next = s.clone();
            next.splits = Rc::new(s.splits.iter().filter(|g| *g.id != *split_id).cloned().collect());
            next
        }
    }
}

/// M:1724 `settleSplits(state)`: every split checked against the items there are now: a pane whose item is gone leaves
/// (the others' ratios kept relative to each other), as does one already in an earlier split or twice in this one, and
/// a 5th; a split of fewer than 2 goes. The state itself when every split holds (no allocation then: perform runs this
/// after every action that succeeds, LT:830).
pub fn settle_splits(s: &LibState) -> LibState {
    let list = &s.splits;
    if list.is_empty() {
        return s.clone();
    }
    // The splits so far: `None` while every one before was kept as it was (they're `list[..at]`).
    let mut out: Option<Vec<Rc<Split>>> = None;
    for (at, g) in list.iter().enumerate() {
        let raw = &g.panes;
        let seen = |k: &str| match &out {
            Some(done) => done.iter().any(|d| d.panes.iter().any(|p| **p == *k)),
            None => list[..at].iter().any(|d| d.panes.iter().any(|p| **p == *k)),
        };
        // The panes kept, by their place in `raw`.
        let mut kept = [0usize; MAX_SPLIT_PANES];
        let mut n = 0;
        for (i, p) in raw.iter().enumerate() {
            let Some(k) = pane_key(p) else { continue };
            if seen(k) || kept[..n].iter().any(|&j| *raw[j] == *k) || !has_margin_tab(s, k) || n >= MAX_SPLIT_PANES {
                continue;
            }
            kept[n] = i;
            n += 1;
        }
        // (The kept places rise, so `n` of them for `raw.len()` panes are every pane in its place.)
        let same = n == raw.len() && g.ratios.len() == raw.len();
        if same && n >= 2 {
            if let Some(done) = &mut out {
                done.push(g.clone());
            }
            continue;
        }
        let done = out.get_or_insert_with(|| list[..at].to_vec());
        if n < 2 {
            continue;
        }
        let old = normalize_split_ratios(Some(&g.ratios), raw.len());
        let panes: Vec<Str> = kept[..n].iter().map(|&i| raw[i].clone()).collect();
        let ratios: Vec<f64> = kept[..n].iter().map(|&i| old[i]).collect();
        let ratios = normalize_split_ratios(Some(&ratios), n);
        done.push(Rc::new(Split { panes, ratios, ..(**g).clone() }));
    }
    match out {
        Some(splits) => {
            let mut next = s.clone();
            next.splits = Rc::new(splits);
            next
        }
        None => s.clone(),
    }
}

/// M:1754 `swapSplitPanes(state, splitId, indexA, indexB)`: two panes (and their ratios) trade places; the state itself
/// for no such split, the same place twice or a place out of range. The places are integers as doubles (LT:758
/// `Number.isInteger`, else 0 and 1; `-0` is 0); a fraction, which LT never gives (M would set an array's `"0.5"`), is
/// refused.
pub fn swap_split_panes(s: &LibState, split_id: &str, index_a: f64, index_b: f64) -> LibState {
    let Some(group) = split_of(s, split_id) else { return s.clone() };
    let len = group.panes.len() as f64;
    if index_a == index_b
        || index_a < 0.0
        || index_b < 0.0
        || index_a >= len
        || index_b >= len
        || index_a.fract() != 0.0
        || index_b.fract() != 0.0
    {
        return s.clone();
    }
    let (a, b) = (index_a as usize, index_b as usize);
    let mut panes = group.panes.clone();
    let mut ratios = normalize_split_ratios(Some(&group.ratios), panes.len());
    panes.swap(a, b);
    ratios.swap(a, b);
    map_split(s, split_id, |g| Rc::new(Split { panes: panes.clone(), ratios: ratios.clone(), ..g.clone() }))
}

/// M:1765 `resizeSplit(state, splitId, ratios)`: the payload's ratios (`p?.ratios`), one per pane, normalised; the state
/// itself for no such split or ratios that aren't an array of one per pane.
pub fn resize_split(s: &LibState, split_id: &str, ratios: Option<&[Value]>) -> LibState {
    let Some(group) = split_of(s, split_id) else { return s.clone() };
    let Some(ratios) = ratios.filter(|r| r.len() == group.panes.len()) else { return s.clone() };
    let norm = normalize_split_ratios_of(Some(ratios), group.panes.len());
    map_split(s, split_id, |g| Rc::new(Split { ratios: norm.clone(), ..g.clone() }))
}

/// M:1773 `toggleSplitAxis(state, splitId)`: side by side ↔ stacked (the first split of the id decides, every one of it
/// takes it); the state itself for no such split.
pub fn toggle_split_axis(s: &LibState, split_id: &str) -> LibState {
    let Some(group) = split_of(s, split_id) else { return s.clone() };
    let axis = if group.axis == Axis::Vertical { Axis::Horizontal } else { Axis::Vertical };
    map_split(s, split_id, |g| Rc::new(Split { axis, ..g.clone() }))
}

#[cfg(test)]
#[path = "splits_tests.rs"]
mod tests;
