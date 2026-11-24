//! model.ts's rules on the library's typed state (docs/CORE-REFACTOR.md step 4 part 3): M's ~45 functions library.ts
//! calls, with pinned-rules.ts (PR), air-traffic.ts (AT) and front-item.ts (FI), one Rust function each with M's name
//! (`place_kept`, `write_order`, `settle_splits`…), its doc naming its TS line.
//!
//! The ways every rule here keeps the TS's:
//! - A rule is `fn(&LibState, …) -> LibState` (or answers a lookup). One that changes nothing answers `s.clone()`, the
//!   same lists (`LibState::same`: the TS's `next === s`, which decides `result: null` against an id in LT:532, 601,
//!   791). One that changes a collection makes it anew (`Rc::make_mut` on the state's copy) and keeps every record it
//!   doesn't change as it was (the same `Rc`: the TS's `p === state.pins[i]`, M:1130, `held !== k`, M:645).
//! - A record the TS makes with a key left out (`{ id, spaceId, url, title }` M:1265, no `pos`) is `None` there, so
//!   `valuesOf`'s fallbacks see what JS sees; `delete o.k` and `{ k: _, ...rest }` are `None` too.
//! - The open-tab halves of M's functions (`state.tabs`, `tabSpace`: the extension's open tabs) aren't ported: the
//!   library's state has none (LT:136 `tabs: {}`); each port takes the kept half only, and its doc says so.
//! - `localeCompare` is the caller's `&dyn LocaleCompare` (the system's sorter); `normalizeUrl` is `js::normalize_url`
//!   (WHATWG, as the browsers' copies: `RULES_PARSE_URLS`), every cut `js::slice16`, every `trim` `js::trim`, every
//!   `Math.round`/`Math.max` `js::round`/`js::max`, every sort a stable `sort_by` over `js::num_cmp`.
//! - `Object.values(s.keptTabs)` walks `s.kept` in its order (`JsObject`: the ids' order as stored; "the first of
//!   several equal" is that one, Tirth's answer 10).
//!
//! The files, each its own piece (three can be written at once; nothing in one calls another's but this file's):
//! - [`spaces`] and [`order`]: spaces (M:1087-1155, 1422-1455) and pins and folders' order (M:612, 1161-1419, PR
//!   `folderDepth`).
//! - [`kept`] and [`favorites`]: items' places and the archive (M:317-355, 395-531, 1069-1083, 1777-1796, FI) and
//!   favorites (M:1460-1591, PR `favoriteScopeOf`).
//! - [`splits`] and [`links`]: splits (M:1628-1775) and link rules (AT, M:1594-1624).
//!
//! What more than one of them needs is here: [`has_space`], [`pos_of`], the bindings ([`pin_of_space`],
//! [`has_favorite`], [`bound_elsewhere`], [`held_bindings`], [`settle_bindings`]) and the shared limits.

use std::rc::Rc;

use super::state::{Item, LibState};

mod arg;
pub mod favorites;
pub mod kept;
pub mod links;
pub mod order;
pub mod spaces;
pub mod splits;

pub use arg::Arg;

/// A folder's name and a favorite's custom title, at most (M:1250 `FOLDER_NAME_MAX`), in UTF-16 units.
pub const FOLDER_NAME_MAX: usize = 40;
/// Folders nest this many levels deep, the top one counted (PR `MAX_FOLDER_DEPTH`).
pub const MAX_FOLDER_DEPTH: usize = 4;
/// Favorites in one scope, at most (PR `FAVORITES_CAP`).
pub const FAVORITES_CAP: usize = 12;

/// M:604 `hasSpace`: a space with this id.
pub fn has_space(s: &LibState, space_id: &str) -> bool {
    s.spaces.iter().any(|sp| *sp.id == *space_id)
}

/// M:1161 `posOf(item, i)`: its `pos` when that's a number, else its place in the list.
#[inline]
pub fn pos_of(pos: Option<f64>, i: usize) -> f64 {
    pos.filter(|p| p.is_finite()).unwrap_or(i as f64)
}

/// M:620 / PR `pinOfSpace`: a pin with this id (a string, not empty) in this space.
pub fn pin_of_space(s: &LibState, pin_id: &str, space_id: &str) -> bool {
    !pin_id.is_empty() && s.pins.iter().any(|p| *p.id == *pin_id && *p.space_id == *space_id)
}

/// M:621 / PR `hasFavorite`: a favorite with this id (a string, not empty).
pub fn has_favorite(s: &LibState, favorite_id: &str) -> bool {
    !favorite_id.is_empty() && s.favorites.iter().any(|f| *f.id == *favorite_id)
}

/// PR `boundElsewhere(state, r, spaceId, { pinId, favoriteId })`: whether an item of `space_id` belongs to a pin other
/// than `pin_id` or a favorite other than `favorite_id` (a pin's or favorite's search by address never takes another's).
pub fn bound_elsewhere(
    s: &LibState,
    r: &Item,
    space_id: &str,
    pin_id: Option<&str>,
    favorite_id: Option<&str>,
) -> bool {
    let pin = r.pinned_by.as_deref().filter(|p| !p.is_empty());
    if pin.is_some_and(|p| Some(p) != pin_id && pin_of_space(s, p, space_id)) {
        return true;
    }
    let fav = r.favorite_id.as_deref().filter(|f| !f.is_empty());
    fav.is_some_and(|f| Some(f) != favorite_id && has_favorite(s, f))
}

/// M:624 `heldBindings(state, r, spaceId)` for an item: without a binding that no longer holds in `space_id` (its pin
/// gone or in another space, its favorite gone). The item itself (the same `Rc`) when both hold.
pub fn held_bindings(s: &LibState, item: &Rc<Item>, space_id: &str) -> Rc<Item> {
    let drop_pin = item.pinned_by.as_deref().is_some_and(|p| !p.is_empty() && !pin_of_space(s, p, space_id));
    let drop_fav = item.favorite_id.as_deref().is_some_and(|f| !f.is_empty() && !has_favorite(s, f));
    if !drop_pin && !drop_fav {
        return item.clone();
    }
    let mut out = (**item).clone();
    if drop_pin {
        out.pinned_by = None;
    }
    if drop_fav {
        out.favorite_id = None;
    }
    Rc::new(out)
}

/// M:635 `settleBindings(state)`, its kept half: every item's bindings checked again (after a space is deleted: its
/// duplicate pins dropped). The state itself when none changed.
pub fn settle_bindings(s: &LibState) -> LibState {
    let mut next: Option<LibState> = None;
    for (id, k) in s.kept.iter() {
        let held = held_bindings(s, k, &k.space_id);
        if !Rc::ptr_eq(&held, k) {
            let state = next.get_or_insert_with(|| s.clone());
            if let Some(slot) = Rc::make_mut(&mut state.kept).get_mut(id) {
                *slot = held;
            }
        }
    }
    next.unwrap_or_else(|| s.clone())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
