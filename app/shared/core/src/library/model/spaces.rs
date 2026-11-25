//! Spaces (piece 1, with [`super::order`]): M:1087 `setActiveSpace`, M:1113 `createSpace`, M:1126 `orderSpaces`,
//! M:1135 `updateSpace`, M:1422 `deleteSpace` (its cascade: items, pins unless the first space left has the address,
//! folders after that space's own, archive, windows, link rules dropped, splits moved, then
//! [`super::settle_bindings`]). `themeIdOk` is `state::theme_id_ok`. Payload values come as [`Arg`]s, as in
//! [`super::order`].

use std::collections::HashMap;
use std::rc::Rc;

use super::Arg;
use super::order::{Entry, Kind, pin_order, write_order};
use super::{has_space, settle_bindings};
use crate::library::js;
use crate::library::state::{
    ArchiveEntry, Background, Folder, Item, LibState, Pin, Space, Split, Str, background_of, theme_id_ok,
};

/// What JavaScriptCore throws in `createSpace` for a `name` that's neither a string nor nullish (`name?.trim()`), the
/// throw survey's one site (tests/fixtures/library/throws.json `createSpace: name?.trim is not a function`); library.ts's
/// `perform` answers it as `failed: <these words>`.
pub const CREATE_SPACE_NAME_THROWS: &str =
    "name?.trim is not a function. (In 'name?.trim()', 'name?.trim' is undefined)";

/// M:1087 `setActiveSpace(state, windowId, spaceId)`: the window shows the space. The state itself when the space
/// isn't one.
pub fn set_active_space(s: &LibState, window_id: &str, space_id: &str) -> LibState {
    if !has_space(s, space_id) {
        return s.clone();
    }
    let mut next = s.clone();
    Rc::make_mut(&mut next.windows).insert(window_id.into(), space_id.into());
    next
}

/// `v || fallback` for a space's emoji or colour. A truthy value that's no string is stored as given by JS (`emoji: 5`);
/// the typed space holds text, so it's `""` here: what the next reading of it is (`str(5, 16)`), so the state after is
/// the same, but the stored change differs from JS's for such a payload (reported with piece 1, not reproduced).
fn text_or<'a>(v: Arg<'a>, fallback: &'a str) -> &'a str {
    if !v.truthy() {
        return fallback;
    }
    v.as_str().unwrap_or("")
}

/// M:1113 `createSpace(state, { id, name, emoji, color, theme })`: a space at the end, named (`name.trim()`, else `New
/// space`), its emoji and colour as given (else `✨`, `#00b894`), its theme when it's a theme's id; its browser and
/// profile none (Safari's default: library.ts sets them after). Throws ([`CREATE_SPACE_NAME_THROWS`]) for a `name`
/// that's neither a string nor nullish, as JS's `name?.trim()`.
pub fn create_space(
    s: &LibState,
    id: &str,
    name: Arg<'_>,
    emoji: Arg<'_>,
    color: Arg<'_>,
    theme: Option<&str>,
) -> Result<LibState, &'static str> {
    let name = if name.nullish() {
        ""
    } else {
        match name.as_str() {
            Some(n) => js::trim(n),
            None => return Err(CREATE_SPACE_NAME_THROWS),
        }
    };
    let space = Space {
        id: id.into(),
        name: if name.is_empty() { "New space" } else { name }.into(),
        emoji: text_or(emoji, "✨").into(),
        color: text_or(color, "#00b894").into(),
        browser: "safari".into(),
        profile: None,
        theme: theme.filter(|t| theme_id_ok(t)).map(Str::from),
        background: None,
    };
    let mut next = s.clone();
    Rc::make_mut(&mut next.spaces).push(Rc::new(space));
    Ok(next)
}

/// M:1126 `orderSpaces(state, ids)`: the spaces in the order given (an id given twice: its last place), the ones it
/// doesn't name after them in their order. The state itself when none moved.
pub fn order_spaces(s: &LibState, ids: &[&str]) -> LibState {
    let mut rank: HashMap<&str, usize> = HashMap::with_capacity(ids.len());
    for (i, id) in ids.iter().enumerate() {
        rank.insert(id, i);
    }
    let mut spaces: Vec<(usize, &Rc<Space>)> =
        s.spaces.iter().enumerate().map(|(i, sp)| (rank.get(&*sp.id).copied().unwrap_or(ids.len() + i), sp)).collect();
    spaces.sort_by_key(|(r, _)| *r);
    if spaces.iter().zip(s.spaces.iter()).all(|((_, a), b)| Rc::ptr_eq(a, b)) {
        return s.clone();
    }
    let mut next = s.clone();
    next.spaces = Rc::new(spaces.into_iter().map(|(_, sp)| sp.clone()).collect());
    next
}

/// M:1135 `updateSpace(state, spaceId, patch)`: its name, emoji and colour each when given as a string that isn't
/// blank (trimmed), its emoji removed (stored as `""`: M2.10, Arc's space with no icon) when given as null; its theme when given as a theme's id, none when given as null, else as it was; its background
/// when given as an object (as [`background_of`] reads it: none when that's none), none when given as null, else as it
/// was. A new list of spaces always (M's `map`), the space itself made anew.
pub fn update_space(
    s: &LibState,
    space_id: &str,
    name: Arg<'_>,
    emoji: Arg<'_>,
    color: Arg<'_>,
    theme: Arg<'_>,
    background: Arg<'_>,
) -> LibState {
    let given = |v: Arg<'_>| v.as_str().map(js::trim).filter(|t| !t.is_empty()).map(Str::from);
    // (`emoji: null`: `allowed.emoji = ''`, the icon removed.)
    let emoji = if emoji.is_null() { Some(Str::from("")) } else { given(emoji) };
    let (name, color) = (given(name), given(color));
    // `themeIdOk(t) ? t : t === null ? null : undefined`: Some(Some) set, Some(None) none, None unchanged.
    let theme: Option<Option<Str>> = match theme.as_str() {
        Some(t) if theme_id_ok(t) => Some(Some(t.into())),
        _ if theme.is_null() => Some(None),
        _ => None,
    };
    // `isObject(b) ? backgroundOf(b) : b === null ? null : undefined`, the same three.
    let background: Option<Option<Rc<Background>>> = match background {
        Arg::Value(v @ serde_json::Value::Object(_)) => Some(background_of(Some(v)).map(Rc::new)),
        _ if background.is_null() => Some(None),
        _ => None,
    };
    let mut next = s.clone();
    next.spaces = Rc::new(
        s.spaces
            .iter()
            .map(|sp| {
                if *sp.id != *space_id {
                    return sp.clone();
                }
                let mut out = (**sp).clone();
                if let Some(n) = &name {
                    out.name = n.clone();
                }
                if let Some(e) = &emoji {
                    out.emoji = e.clone();
                }
                if let Some(c) = &color {
                    out.color = c.clone();
                }
                if let Some(t) = &theme {
                    out.theme = t.clone();
                }
                if let Some(b) = &background {
                    out.background = b.clone();
                }
                Rc::new(out)
            })
            .collect(),
    );
    next
}

/// M:1422 `deleteSpace(state, spaceId)`, its kept half: the space gone, what was its the first space left's: its
/// windows, items, archive entries and splits; its folders, after that space's own top level; its pins with them, but
/// those whose address that space has a pin at already (dropped, their items unbound by [`settle_bindings`]); its link
/// rules dropped. The state itself when it's the last space or isn't one.
pub fn delete_space(s: &LibState, space_id: &str) -> LibState {
    if s.spaces.len() < 2 || !has_space(s, space_id) {
        return s.clone();
    }
    let spaces: Vec<Rc<Space>> = s.spaces.iter().filter(|sp| *sp.id != *space_id).cloned().collect();
    let target: Str = spaces[0].id.clone();
    let windows = s
        .windows
        .iter()
        .map(|(w, sid)| (w.clone(), if **sid == *space_id { target.clone() } else { sid.clone() }))
        .collect();

    let moved_top = pin_order(s, space_id, None);
    let folders: Vec<Rc<Folder>> = s
        .folders
        .iter()
        .map(|f| {
            if *f.space_id == *space_id {
                Rc::new(Folder { space_id: target.clone(), ..(**f).clone() })
            } else {
                f.clone()
            }
        })
        .collect();
    let mut pins: Vec<Rc<Pin>> = s.pins.iter().filter(|p| *p.space_id != *space_id).cloned().collect();
    for pin in s.pins.iter().filter(|p| *p.space_id == *space_id) {
        // `pinForUrl({ ...state, pins }, pin.url, target)`: over the list as it grows (a second pin at an address one
        // moved has is dropped too).
        let key = js::normalize_url(&pin.url);
        if !pins.iter().any(|p| js::normalize_url(&p.url) == key && *p.space_id == *target) {
            pins.push(Rc::new(Pin { space_id: target.clone(), ..(**pin).clone() }));
        }
    }
    let kept_pins: std::collections::HashSet<Str> = pins.iter().map(|p| p.id.clone()).collect();

    let mut next = s.clone();
    next.spaces = Rc::new(spaces);
    next.windows = Rc::new(windows);
    next.pins = Rc::new(pins);
    next.folders = Rc::new(folders);
    let mut level: Vec<Entry> = pin_order(s, &target, None);
    level.extend(moved_top.into_iter().filter(|x| x.kind == Kind::Folder || kept_pins.contains(&x.id)));
    let mut next = write_order(&next, None, &level);

    next.archive = Rc::new(
        s.archive
            .iter()
            .map(|a| {
                if *a.space_id == *space_id {
                    Rc::new(ArchiveEntry { space_id: target.clone(), ..(**a).clone() })
                } else {
                    a.clone()
                }
            })
            .collect(),
    );
    // (`Object.fromEntries(Object.entries(…).map(…))`: the same keys in the same order, a new object.)
    let mut kept = (*s.kept).clone();
    for k in s.kept.values().filter(|k| *k.space_id == *space_id) {
        if let Some(slot) = kept.get_mut(&k.id) {
            *slot = Rc::new(Item { space_id: target.clone(), ..(**k).clone() });
        }
    }
    next.kept = Rc::new(kept);
    if !s.air_traffic.is_empty() {
        next.air_traffic = Rc::new(s.air_traffic.iter().filter(|r| *r.space_id != *space_id).cloned().collect());
    }
    if !s.splits.is_empty() {
        next.splits = Rc::new(
            s.splits
                .iter()
                .map(|g| {
                    if *g.space_id == *space_id {
                        Rc::new(Split { space_id: target.clone(), ..(**g).clone() })
                    } else {
                        g.clone()
                    }
                })
                .collect(),
        );
    }
    settle_bindings(&next)
}

#[cfg(test)]
#[path = "spaces_tests.rs"]
mod tests;
