//! Favorites (piece 2, with [`super::kept`]): M:1460-1591 `renumberFavorites`, `favoriteUrlOk`, `keptOfFavorite`,
//! `addFavorite` ([`super::FAVORITES_CAP`], the same address refused), `removeFavorite`, `moveFavorite`,
//! `renameFavorite` ([`super::FOLDER_NAME_MAX`]), `bindTabToFavorite` (drops `pinnedBy`) and `unbindFavoriteTab` (kept
//! halves); PR `favoriteScopeOf` (the library's state has no settings: the caller says whether favorites are per
//! profile, as LT:593 builds `settings.favoritesScope` from the payload).
//!
//! An id a payload gives that isn't a string matches no favorite in the TS (`f.id === favoriteId`): the caller doesn't
//! call these with one (the state stays as it is). M's `favoriteForUrl` and `settleFavorite` aren't the library's (LT
//! calls neither) and aren't ported.

use std::rc::Rc;

use super::{Arg, FAVORITES_CAP, FOLDER_NAME_MAX, pos_of};
use crate::library::js::{self, LocaleCompare};
use crate::library::state::{Favorite, Item, LibState, LibTarget, Str, app_url};

/// `f.scope || 'global'`: the scope a favorite is in.
#[inline]
pub fn scope_of(f: &Favorite) -> &str {
    if f.scope.is_empty() { "global" } else { &f.scope }
}

/// PR `favoriteScopeOf(state, spaceId)`: the favorites a space shows: everyone's (`'global'`), or, when favorites are
/// per profile (`settings.favoritesScope === 'profile'`), its browser profile's (`'profile:<id>'`, `'profile:default'`
/// for a space of the default profile, no space, or none found).
pub fn favorite_scope_of(s: &LibState, space_id: Option<&str>, per_profile: bool) -> String {
    if !per_profile {
        return "global".to_owned();
    }
    let sp = space_id.filter(|id| !id.is_empty()).and_then(|id| s.spaces.iter().find(|sp| *sp.id == *id));
    let profile = sp.and_then(|sp| sp.profile.as_deref()).filter(|p| !p.is_empty()).unwrap_or("default");
    format!("profile:{profile}")
}

/// M:1466 `renumberFavorites(list, scope)`: the scope's favorites numbered 0, 1, 2… in the list's order, the others as
/// they were. (A favorite already at its number is kept as it was: the TS's copy has the same values.)
pub fn renumber_favorites(list: &[Rc<Favorite>], scope: &str) -> Vec<Rc<Favorite>> {
    let mut i: f64 = 0.0;
    list.iter()
        .map(|f| {
            if scope_of(f) != scope {
                return f.clone();
            }
            let pos = i;
            i += 1.0;
            if f.pos.is_some_and(|p| p.to_bits() == pos.to_bits()) {
                f.clone()
            } else {
                Rc::new(Favorite { pos: Some(pos), ..(**f).clone() })
            }
        })
        .collect()
}

/// M:1473 `favoriteUrlOk(url, target)`: a web page (`/^https?:\/\/[^\s/]/i`) with no target or a web one, or a Mac app
/// (`app://<bundle id>` with its app target). Never a browser's own page nor one of Margin's.
pub fn favorite_url_ok(url: &str, target: Option<&LibTarget>) -> bool {
    if js::favorite_url_ok(url) {
        return target.is_none_or(|t| matches!(t, LibTarget::Web { .. }));
    }
    matches!(target, Some(LibTarget::App { bundle_id, .. }) if url == app_url(bundle_id))
}

/// M:1480 `keptOfFavorite(state, favoriteId)`: the items bound to a favorite, used last first (then by id, as
/// `localeCompare` orders them).
pub fn kept_of_favorite<'a>(s: &'a LibState, favorite_id: &str, compare: &dyn LocaleCompare) -> Vec<&'a Rc<Item>> {
    let mut list: Vec<&Rc<Item>> = s.kept.values().filter(|k| k.favorite_id.as_deref() == Some(favorite_id)).collect();
    list.sort_by(|a, b| js::num_cmp(b.last_active, a.last_active).then_with(|| compare.compare(&a.id, &b.id)));
    list
}

/// The favorite [`add_favorite`] adds (M:1492's argument): `title` empty for none (the address stands in),
/// `custom_title` trimmed and cut, `before_id` the favorite it goes before (none, or not in its scope: at the end).
#[derive(Clone, Debug)]
pub struct NewFavorite<'a> {
    pub id: &'a str,
    pub scope: &'a str,
    pub url: &'a str,
    pub title: &'a str,
    pub custom_title: Option<&'a str>,
    pub target: Option<LibTarget>,
    /// `p?.beforeId ?? null` as it came (LT:600).
    pub before_id: Arg<'a>,
}

/// The favorites of `scope` in their order (`posOf(f, 0)`, the stable sort), and the others in the list's order.
fn split_scope<'a>(list: &'a [Rc<Favorite>], scope: &str) -> (Vec<&'a Rc<Favorite>>, Vec<&'a Rc<Favorite>>) {
    let (mut in_scope, others): (Vec<&Rc<Favorite>>, Vec<&Rc<Favorite>>) =
        list.iter().partition(|f| scope_of(f) == scope);
    in_scope.sort_by(|a, b| js::num_cmp(pos_of(a.pos, 0), pos_of(b.pos, 0)));
    (in_scope, others)
}

/// `beforeId ? list.findIndex((f) => f.id === beforeId) : -1` (falsy: none; truthy and no string: no favorite's).
fn index_of(list: &[&Rc<Favorite>], before_id: Arg<'_>) -> Option<usize> {
    let before = before_id.truthy_id().ok().flatten()?;
    list.iter().position(|f| *f.id == *before)
}

/// `{ ...state, favorites: renumberFavorites([...others, ...scope], scope) }`.
fn with_scope(s: &LibState, others: Vec<&Rc<Favorite>>, in_scope: Vec<Rc<Favorite>>, scope: &str) -> LibState {
    let list: Vec<Rc<Favorite>> = others.into_iter().cloned().chain(in_scope).collect();
    LibState { favorites: Rc::new(renumber_favorites(&list, scope)), ..s.clone() }
}

/// M:1492 `addFavorite(state, fav)`: a favorite added to its scope (before `before_id`, else at the end), the scope
/// renumbered. The state itself for an address a favorite can't have ([`favorite_url_ok`]), a full scope
/// ([`FAVORITES_CAP`]) or one with a favorite at the same address (normalised).
pub fn add_favorite(s: &LibState, fav: NewFavorite) -> LibState {
    if !favorite_url_ok(fav.url, fav.target.as_ref()) {
        return s.clone();
    }
    let (in_scope, others) = split_scope(&s.favorites, fav.scope);
    if in_scope.len() >= FAVORITES_CAP {
        return s.clone();
    }
    let key = js::normalize_url(fav.url);
    if in_scope.iter().any(|f| js::normalize_url(&f.url) == key) {
        return s.clone();
    }
    let custom_title =
        fav.custom_title.map(js::trim).filter(|t| !t.is_empty()).map(|t| js::slice16(t, FOLDER_NAME_MAX));
    let at = index_of(&in_scope, fav.before_id);
    let new = Rc::new(Favorite {
        id: fav.id.into(),
        scope: fav.scope.into(),
        url: fav.url.into(),
        title: if fav.title.is_empty() { fav.url } else { fav.title }.into(),
        custom_title: custom_title.map(Str::from),
        pos: Some(in_scope.len() as f64),
        target: fav.target,
    });
    let mut next_scope: Vec<Rc<Favorite>> = in_scope.into_iter().cloned().collect();
    match at {
        Some(i) => next_scope.insert(i, new),
        None => next_scope.push(new),
    }
    with_scope(s, others, next_scope, fav.scope)
}

/// M:1519 `removeFavorite(state, favoriteId)`: the favorite gone, its scope renumbered, its items no longer its
/// ([`unbind_favorite_tab`]). The state itself for no such favorite.
pub fn remove_favorite(s: &LibState, favorite_id: &str) -> LibState {
    let Some(target) = s.favorites.iter().find(|f| *f.id == *favorite_id) else {
        return s.clone();
    };
    let rest: Vec<Rc<Favorite>> = s.favorites.iter().filter(|f| *f.id != *favorite_id).cloned().collect();
    let next = LibState { favorites: Rc::new(renumber_favorites(&rest, scope_of(target))), ..s.clone() };
    unbind_favorite_tab(&next, favorite_id)
}

/// M:1529 `moveFavorite(state, favoriteId, { beforeId })`: the favorite before `before_id` in its scope (none, or not
/// there: at the end), the scope renumbered. The state itself for no such favorite, or when its scope's order is as
/// it was.
pub fn move_favorite(s: &LibState, favorite_id: Arg<'_>, before_id: Arg<'_>) -> LibState {
    let Some(fav) = favorite_id.as_str().and_then(|id| s.favorites.iter().find(|f| *f.id == *id)) else {
        return s.clone();
    };
    let scope = scope_of(fav);
    let (in_scope, others) = split_scope(&s.favorites, scope);
    let mut rest: Vec<&Rc<Favorite>> = in_scope.iter().copied().filter(|f| f.id != fav.id).collect();
    match index_of(&rest, before_id) {
        Some(i) => rest.insert(i, fav),
        None => rest.push(fav),
    }
    if rest.iter().enumerate().all(|(i, f)| in_scope.get(i).is_some_and(|g| g.id == f.id)) {
        return s.clone();
    }
    with_scope(s, others, rest.into_iter().cloned().collect(), scope)
}

/// M:1545 `renameFavorite(state, favoriteId, customTitle)`: its own name (spaces squashed, trimmed, cut at
/// [`FOLDER_NAME_MAX`]; `None`, a payload that isn't a string, or empty: none, its title shown). The state itself for
/// no such favorite or the name it has.
pub fn rename_favorite(s: &LibState, favorite_id: &str, custom_title: Arg<'_>) -> LibState {
    let Some(fav) = s.favorites.iter().find(|f| *f.id == *favorite_id) else {
        return s.clone();
    };
    let squashed = custom_title.as_str().map(js::squash_spaces);
    let trimmed = squashed.as_deref().map_or("", js::trim);
    let clean = js::slice16(trimmed, FOLDER_NAME_MAX);
    // A cut through an emoji: JS's `clean` ends in half of it, which no name it has equals (none can hold half a
    // pair), so the TS renames, its broken half dropped (Tirth's answer 3), even to the name it has.
    let broke = js::len16(clean) < js::len16(trimmed).min(FOLDER_NAME_MAX);
    if !broke && fav.custom_title.as_deref().unwrap_or("") == clean {
        return s.clone();
    }
    let custom_title = if clean.is_empty() { None } else { Some(Str::from(clean)) };
    let favorites: Vec<Rc<Favorite>> = s
        .favorites
        .iter()
        .map(|f| {
            if *f.id == *favorite_id {
                Rc::new(Favorite { custom_title: custom_title.clone(), ..(**f).clone() })
            } else {
                f.clone()
            }
        })
        .collect();
    LibState { favorites: Rc::new(favorites), ..s.clone() }
}

/// M:1560 `bindTabToFavorite(state, tabId, favoriteId)`, its kept half (a string id): the item is the favorite's (and
/// no pin's). The state itself for no such favorite or item, or one that's the favorite's already.
pub fn bind_tab_to_favorite(s: &LibState, tab_id: &str, favorite_id: &str) -> LibState {
    if !s.favorites.iter().any(|f| *f.id == *favorite_id) {
        return s.clone();
    }
    let Some(k) = s.kept.get(tab_id) else {
        return s.clone();
    };
    if k.favorite_id.as_deref() == Some(favorite_id) {
        return s.clone();
    }
    let bound = Rc::new(Item { pinned_by: None, favorite_id: Some(favorite_id.into()), ..(**k).clone() });
    let mut next = s.clone();
    Rc::make_mut(&mut next.kept).insert(tab_id.into(), bound);
    next
}

/// M:1574 `unbindFavoriteTab(state, favoriteId)`, its kept half: every item bound to the favorite unbound. The state
/// itself when none is.
pub fn unbind_favorite_tab(s: &LibState, favorite_id: &str) -> LibState {
    let bound: Vec<Str> = s
        .kept
        .iter()
        .filter(|(_, k)| k.favorite_id.as_deref() == Some(favorite_id))
        .map(|(id, _)| id.clone())
        .collect();
    if bound.is_empty() {
        return s.clone();
    }
    let mut next = s.clone();
    let kept = Rc::make_mut(&mut next.kept);
    for id in bound {
        if let Some(k) = kept.get_mut(&id) {
            *k = Rc::new(Item { favorite_id: None, ..(**k).clone() });
        }
    }
    next
}

#[cfg(test)]
#[path = "favorites_tests.rs"]
mod tests;
