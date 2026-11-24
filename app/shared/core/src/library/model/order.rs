//! Pins and folders in order (piece 1, with [`super::spaces`]): M:612 `pinForUrl`, M:1161-1197 (`folderIn`,
//! `folderOfPin`, `folderParent`, `folderSubtreeHeight`, `folderHasAncestor`; `posOf` is [`super::pos_of`]), M:1200
//! `pinOrder` (folders first at equal places: the stable sort), M:1218 `writeOrder` (only what moved rewritten), M:1242
//! `placed`, M:1251 `folderName`, M:1253 `uniqueName`, M:1263 `addPin`, M:1270 `removePin`, M:1277 `bindTabToPin` and
//! M:1290 `unbindPinTab` (kept halves), M:1314-1344 `cleanCustomTitle`, `renamePin`, `renameTab` (kept half), M:1346
//! `movePin`, M:1362 `createFolder`, M:1376-1407 `renameFolder`, `setFolderOpen`, `moveFolder` (the cycle guard,
//! [`super::MAX_FOLDER_DEPTH`]), M:1410 `deleteFolder`; PR `folderDepth`.
//!
//! A parameter library.ts fills from an action's payload as it came (`p?.folderId ?? null`, `p?.name`) is an [`Arg`] (model/arg.rs):
//! the JS value, so each rule tests it as M does (`folderId ? …`, `=== id`, `String(name ?? '')`); one library.ts
//! always gives a string (an id it found, a space it checked) is a `&str`.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use serde_json::Value;

use super::{Arg, FOLDER_NAME_MAX, MAX_FOLDER_DEPTH, has_space, pos_of};
use crate::library::js;
use crate::library::state::{Folder, Item, LibState, Pin, Str};

impl<'a> From<Option<&'a str>> for Arg<'a> {
    /// A typed `string | null`.
    fn from(s: Option<&'a str>) -> Arg<'a> {
        s.map_or(Arg::Value(&Value::Null), Arg::Str)
    }
}

// ---- lookups --------------------------------------------------------------------------------------------------------

/// M:612 `pinForUrl(state, url, spaceId)`: the first pin at the address (`normalizeUrl` both), of `space_id` when one is
/// given.
pub fn pin_for_url<'a>(s: &'a LibState, url: &str, space_id: Option<&str>) -> Option<&'a Rc<Pin>> {
    pin_for_url_in(&s.pins, url, space_id)
}

fn pin_for_url_in<'a>(pins: &'a [Rc<Pin>], url: &str, space_id: Option<&str>) -> Option<&'a Rc<Pin>> {
    let key = js::normalize_url(url);
    pins.iter().find(|p| js::normalize_url(&p.url) == key && space_id.is_none_or(|sp| *p.space_id == *sp))
}

/// M:1163 `folderIn(state, folderId, spaceId)`: the folder of that id in that space.
pub fn folder_in<'a>(s: &'a LibState, folder_id: &str, space_id: &str) -> Option<&'a Rc<Folder>> {
    s.folders.iter().find(|f| *f.id == *folder_id && *f.space_id == *space_id)
}

/// `folderIn` for an id that may be none (`f.id === null` never is).
fn folder_in_opt<'a>(s: &'a LibState, folder_id: Option<&str>, space_id: &str) -> Option<&'a Rc<Folder>> {
    folder_in(s, folder_id?, space_id)
}

/// M:1165 `folderOfPin(state, pin)`: its folder, if that folder is in the pin's space (else it's loose).
pub fn folder_of_pin<'a>(s: &'a LibState, pin: &Pin) -> Option<&'a Rc<Folder>> {
    folder_in(s, pin.folder_id.as_deref().filter(|f| !f.is_empty())?, &pin.space_id)
}

/// M:1167 `folderParent(state, folder)`: its parent, if that's in the same space and the walk up doesn't cycle.
pub fn folder_parent<'a>(s: &'a LibState, folder: &Folder) -> Option<&'a Rc<Folder>> {
    let parent_id = folder.parent_id.as_deref().filter(|p| !p.is_empty())?;
    if *parent_id == *folder.id {
        return None;
    }
    let parent = folder_in(s, parent_id, &folder.space_id)?;
    let mut seen: HashSet<&str> = HashSet::from([&*folder.id]);
    let mut cur = Some(parent);
    while let Some(c) = cur {
        if !seen.insert(&c.id) {
            return None;
        }
        cur = c.parent_id.as_deref().filter(|p| !p.is_empty()).and_then(|p| folder_in(s, p, &folder.space_id));
    }
    Some(parent)
}

/// M:1181 `folderSubtreeHeight(state, folderId, spaceId, seen)`: the levels a folder and the folders under it take (1:
/// none under it), the walk's `seen` shared by every branch as M's.
pub fn folder_subtree_height(s: &LibState, folder_id: &str, space_id: &str) -> usize {
    fn height<'a>(s: &'a LibState, folder_id: &'a str, space_id: &str, seen: &mut HashSet<&'a str>) -> usize {
        if !seen.insert(folder_id) {
            return 0;
        }
        let children: Vec<&'a Rc<Folder>> = s
            .folders
            .iter()
            .filter(|f| *f.space_id == *space_id && f.parent_id.as_deref() == Some(folder_id))
            .collect();
        if children.is_empty() {
            return 1;
        }
        // `1 + Math.max(...children.map(…))`, each child in turn (the order decides what `seen` cuts).
        let mut most = 0;
        for c in children {
            most = most.max(height(s, &c.id, space_id, seen));
        }
        1 + most
    }
    height(s, folder_id, space_id, &mut HashSet::new())
}

/// M:1188 `folderHasAncestor(state, folderId, ancestorId, spaceId)`: whether the walk up from `folder_id` (itself
/// included) meets `ancestor_id`.
pub fn folder_has_ancestor(s: &LibState, folder_id: &str, ancestor_id: &str, space_id: &str) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut cur = folder_in(s, folder_id, space_id);
    while let Some(c) = cur {
        if !seen.insert(&c.id) {
            break;
        }
        if *c.id == *ancestor_id {
            return true;
        }
        cur = c.parent_id.as_deref().filter(|p| !p.is_empty()).and_then(|p| folder_in(s, p, space_id));
    }
    false
}

/// PR `folderDepth(state, folderId, spaceId)`: how many folders a folder is inside (0: at the top), its space's only, a
/// cycle in stored data cut.
pub fn folder_depth(s: &LibState, folder_id: Option<&str>, space_id: &str) -> usize {
    let mut depth = 0;
    let mut seen: HashSet<&str> = HashSet::new();
    let mut cur = folder_in_opt(s, folder_id.filter(|f| !f.is_empty()), space_id);
    while let Some(c) = cur {
        if !seen.insert(&c.id) {
            break;
        }
        let Some(parent) = c.parent_id.as_deref().filter(|p| !p.is_empty()).and_then(|p| folder_in(s, p, space_id))
        else {
            break;
        };
        depth += 1;
        cur = Some(parent);
    }
    depth
}

// ---- one level's order -------------------------------------------------------------------------------------------------

/// What a level of the pinned area holds (`'folder' | 'pin'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Folder,
    Pin,
}

/// One of a level's entries, `pinOrder`'s `{ kind, id }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub kind: Kind,
    pub id: Str,
}

impl Entry {
    pub fn pin(id: &str) -> Entry {
        Entry { kind: Kind::Pin, id: id.into() }
    }

    pub fn folder(id: &str) -> Entry {
        Entry { kind: Kind::Folder, id: id.into() }
    }
}

/// M:1200 `pinOrder(state, spaceId, folderId)`: one level in order, its folders and pins mixed by place (`posOf`); the
/// folders listed first, so the stable sort keeps them first at equal places. `folder_id` `None`: the space's top
/// level.
pub fn pin_order(s: &LibState, space_id: &str, folder_id: Option<&str>) -> Vec<Entry> {
    let mut items: Vec<(Entry, f64)> = Vec::new();
    for (i, f) in s.folders.iter().enumerate() {
        if *f.space_id != *space_id {
            continue;
        }
        if folder_parent(s, f).map(|p| &*p.id) == folder_id {
            items.push((Entry { kind: Kind::Folder, id: f.id.clone() }, pos_of(f.pos, i)));
        }
    }
    for (i, p) in s.pins.iter().enumerate() {
        if *p.space_id != *space_id {
            continue;
        }
        if folder_of_pin(s, p).map(|f| &*f.id) == folder_id {
            items.push((Entry { kind: Kind::Pin, id: p.id.clone() }, pos_of(p.pos, i)));
        }
    }
    items.sort_by(|a, b| js::num_cmp(a.1, b.1));
    items.into_iter().map(|(e, _)| e).collect()
}

/// M:1218 `writeOrder(state, folderId, list)`: `list` as its level's order (0, 1, 2…), its pins in `folder_id` and its
/// folders under it (`None`: the top level; a falsy id writes none). A pin or folder already there at its place is
/// kept as it was (the same `Rc`), and a list none of whose records moved is kept; nothing moved: the state itself.
pub fn write_order(s: &LibState, folder_id: Option<&str>, list: &[Entry]) -> LibState {
    // `new Map(list.map((item, i) => [item.id, i]))`: by id whatever the kind, a later entry's place over an earlier's.
    let mut pos: HashMap<&str, usize> = HashMap::with_capacity(list.len());
    for (i, e) in list.iter().enumerate() {
        pos.insert(&e.id, i);
    }
    let written: Option<Str> = folder_id.filter(|f| !f.is_empty()).map(Str::from);

    let mut pins_changed = false;
    let pins: Vec<Rc<Pin>> = s
        .pins
        .iter()
        .map(|p| match pos.get(&*p.id) {
            Some(&i) if !(p.pos == Some(i as f64) && p.folder_id.as_deref() == folder_id) => {
                pins_changed = true;
                Rc::new(Pin { folder_id: written.clone(), pos: Some(i as f64), ..(**p).clone() })
            }
            _ => p.clone(),
        })
        .collect();

    let mut folders_changed = false;
    let folders: Vec<Rc<Folder>> = s
        .folders
        .iter()
        .map(|f| match pos.get(&*f.id) {
            Some(&i) if !(f.pos == Some(i as f64) && f.parent_id.as_deref() == folder_id) => {
                folders_changed = true;
                Rc::new(Folder { parent_id: written.clone(), pos: Some(i as f64), ..(**f).clone() })
            }
            _ => f.clone(),
        })
        .collect();

    let mut next = s.clone();
    if pins_changed {
        next.pins = Rc::new(pins);
    }
    if folders_changed {
        next.folders = Rc::new(folders);
    }
    next
}

/// M:1242 `placed(list, item, beforeId)`: `list` with `item` moved before the entry `before_id` (the end when there's
/// none; before itself: where it is). The list itself when it already holds it before itself.
pub fn placed(list: Vec<Entry>, item: Entry, before_id: Option<&str>) -> Vec<Entry> {
    if before_id == Some(&*item.id) {
        if list.iter().any(|x| x.id == item.id) {
            return list;
        }
        let mut list = list;
        list.push(item);
        return list;
    }
    let mut rest: Vec<Entry> = list.into_iter().filter(|x| x.id != item.id).collect();
    match before_id.and_then(|b| rest.iter().position(|x| *x.id == *b)) {
        Some(at) => rest.insert(at, item),
        None => rest.push(item),
    }
    rest
}

// ---- names ------------------------------------------------------------------------------------------------------------

/// M:1251 `folderName(name)`: `String(name ?? '').trim().slice(0, FOLDER_NAME_MAX)`.
pub fn folder_name(name: Arg<'_>) -> String {
    js::slice16(js::trim(&name.text()), FOLDER_NAME_MAX).to_owned()
}

/// M:1253 `uniqueName(state, spaceId, name)`: `name`, else `name 2`, `name 3`… the first no folder of the space has.
pub fn unique_name(s: &LibState, space_id: &str, name: &str) -> String {
    let taken: HashSet<&str> = s.folders.iter().filter(|f| *f.space_id == *space_id).map(|f| &*f.name).collect();
    if !taken.contains(name) {
        return name.to_owned();
    }
    let mut n: u64 = 2;
    loop {
        let candidate = format!("{name} {n}");
        if !taken.contains(candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

/// The most a pin's or item's own name holds (M:1313 `CUSTOM_TITLE_MAX`), in UTF-16 units.
pub const CUSTOM_TITLE_MAX: usize = 80;

/// M:1314 `cleanCustomTitle(name)`: `String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, CUSTOM_TITLE_MAX)`.
pub fn clean_custom_title(name: Arg<'_>) -> String {
    let text = name.text();
    js::slice16(js::trim(&js::squash_spaces(&text)), CUSTOM_TITLE_MAX).to_owned()
}

// ---- pins -------------------------------------------------------------------------------------------------------------

/// M:1263 `addPin(state, { id, spaceId, url, title, folderId, beforeId })`: a pin at the address in the space, in the
/// folder `folder_id` of that space (else the top level), before `before_id` (else the end). The state itself when the
/// address is empty, the space isn't one or has a pin at the address already.
pub fn add_pin(
    s: &LibState,
    id: &str,
    space_id: &str,
    url: &str,
    title: Option<&str>,
    folder_id: Arg<'_>,
    before_id: Arg<'_>,
) -> LibState {
    if url.is_empty() || !has_space(s, space_id) || pin_for_url(s, url, Some(space_id)).is_some() {
        return s.clone();
    }
    let mut next = s.clone();
    Rc::make_mut(&mut next.pins).push(Rc::new(Pin {
        id: id.into(),
        space_id: space_id.into(),
        url: url.into(),
        title: title.filter(|t| !t.is_empty()).unwrap_or(url).into(),
        custom_title: None,
        folder_id: None,
        pos: None,
        target: None,
    }));
    // `folderId ? folderIn(state, folderId, spaceId) : null`: a truthy id that's no string finds none.
    let folder = folder_in_opt(s, folder_id.truthy_id().ok().flatten(), space_id);
    let folder_id: Option<&str> = folder.map(|f| &*f.id);
    move_pin(&next, Arg::Str(id), Arg::from(folder_id), before_id)
}

/// M:1270 `removePin(state, pinId)`: the pin gone and every item bound to it unbound. The state itself when there's
/// none.
pub fn remove_pin(s: &LibState, pin_id: &str) -> LibState {
    if !s.pins.iter().any(|p| *p.id == *pin_id) {
        return s.clone();
    }
    let mut next = s.clone();
    next.pins = Rc::new(s.pins.iter().filter(|p| *p.id != *pin_id).cloned().collect());
    unbind_pin_tab(&next, pin_id)
}

/// M:1277 `bindTabToPin(state, tabId, pinId)`, its kept half: the item bound to `pin_id` (`None` or empty: to none).
/// The state itself when there's no such item or it's bound so already.
pub fn bind_tab_to_pin(s: &LibState, tab_id: &str, pin_id: Option<&str>) -> LibState {
    let Some(k) = s.kept.get(tab_id) else { return s.clone() };
    if k.pinned_by.as_deref() == pin_id {
        return s.clone();
    }
    let item = Item { pinned_by: pin_id.filter(|p| !p.is_empty()).map(Str::from), ..(**k).clone() };
    let mut next = s.clone();
    Rc::make_mut(&mut next.kept).insert(k.id.clone(), Rc::new(item));
    next
}

/// M:1290 `unbindPinTab(state, pinId)`, its kept half: every item bound to the pin unbound. The state itself when none
/// is.
pub fn unbind_pin_tab(s: &LibState, pin_id: &str) -> LibState {
    if !s.kept.values().any(|k| k.pinned_by.as_deref() == Some(pin_id)) {
        return s.clone();
    }
    let mut next = s.clone();
    // (Every item where it was: M's rebuilt object has the same keys in the same order.)
    let bound: Vec<Rc<Item>> = s.kept.values().filter(|k| k.pinned_by.as_deref() == Some(pin_id)).cloned().collect();
    let kept = Rc::make_mut(&mut next.kept);
    for k in bound {
        if let Some(slot) = kept.get_mut(&k.id) {
            *slot = Rc::new(Item { pinned_by: None, ..(*k).clone() });
        }
    }
    next
}

/// M:1315 `renamePin(state, pinId, title)`: the pin's own name (`cleanCustomTitle`; empty: none, its title shows). The
/// state itself when there's no such pin or the name is the same.
pub fn rename_pin(s: &LibState, pin_id: &str, title: Arg<'_>) -> LibState {
    let Some(pin) = s.pins.iter().find(|p| *p.id == *pin_id) else { return s.clone() };
    let clean = clean_custom_title(title);
    if pin.custom_title.as_deref().unwrap_or("") == clean {
        return s.clone();
    }
    let custom: Option<Str> = (!clean.is_empty()).then(|| Str::from(clean.as_str()));
    let mut next = s.clone();
    next.pins = Rc::new(
        s.pins
            .iter()
            .map(|p| {
                if *p.id != *pin_id {
                    return p.clone();
                }
                Rc::new(Pin { custom_title: custom.clone(), ..(**p).clone() })
            })
            .collect(),
    );
    next
}

/// M:1330 `renameTab(state, tabId, title)`, its kept half: an item's own name (`cleanCustomTitle`; empty: none). A
/// `tab_id` that's no string is an open tab's, which the library has none of. The state itself when there's no such item
/// or the name is the same.
pub fn rename_tab(s: &LibState, tab_id: Arg<'_>, title: Arg<'_>) -> LibState {
    let clean = clean_custom_title(title);
    let Some(k) = tab_id.as_str().and_then(|id| s.kept.get(id)) else { return s.clone() };
    if k.custom_title.as_deref().unwrap_or("") == clean {
        return s.clone();
    }
    let item = Item { custom_title: (!clean.is_empty()).then(|| Str::from(clean.as_str())), ..(**k).clone() };
    let mut next = s.clone();
    Rc::make_mut(&mut next.kept).insert(k.id.clone(), Rc::new(item));
    next
}

/// M:1346 `movePin(state, pinId, { folderId, beforeId })`: a pin into a folder of its space (a falsy `folder_id`: out
/// of folders), before `before_id` there (else the end). The state itself when there's no such pin or folder.
pub fn move_pin(s: &LibState, pin_id: Arg<'_>, folder_id: Arg<'_>, before_id: Arg<'_>) -> LibState {
    let Some(pin) = pin_id.as_str().and_then(|id| s.pins.iter().find(|p| *p.id == *id)) else { return s.clone() };
    let folder = match folder_id.truthy_id() {
        Ok(None) => None,
        Ok(Some(f)) => match folder_in(s, f, &pin.space_id) {
            Some(folder) => Some(folder),
            None => return s.clone(),
        },
        Err(()) => return s.clone(),
    };
    let from: Option<Str> = folder_of_pin(s, pin).map(|f| f.id.clone());
    let to: Option<Str> = folder.map(|f| f.id.clone());
    let mut next = s.clone();
    if from != to {
        let level: Vec<Entry> =
            pin_order(&next, &pin.space_id, from.as_deref()).into_iter().filter(|x| *x.id != *pin.id).collect();
        next = write_order(&next, from.as_deref(), &level);
    }
    let level = placed(pin_order(&next, &pin.space_id, to.as_deref()), Entry::pin(&pin.id), before_id.as_str());
    write_order(&next, to.as_deref(), &level)
}

// ---- folders ----------------------------------------------------------------------------------------------------------

/// M:1362 `createFolder(state, { id, spaceId, name, pinIds, parentId, beforeId })`: an open folder in the space, under
/// `parent_id` (a folder of the space; `None`: the top level) before `before_id` (else the end), named (`folderName`,
/// else `New Folder`, made unique in the space), holding the pins of `pin_ids` of that space in that order. The state
/// itself when the space isn't one, the id is taken, the parent isn't the space's or is [`MAX_FOLDER_DEPTH`] deep
/// already.
pub fn create_folder(
    s: &LibState,
    id: &str,
    space_id: &str,
    name: Arg<'_>,
    pin_ids: &[&str],
    parent_id: Option<&str>,
    before_id: Arg<'_>,
) -> LibState {
    if !has_space(s, space_id) || s.folders.iter().any(|f| *f.id == *id) {
        return s.clone();
    }
    let parent_id = parent_id.filter(|p| !p.is_empty());
    let parent = folder_in_opt(s, parent_id, space_id);
    if parent_id.is_some() && parent.is_none() {
        return s.clone();
    }
    if let Some(parent) = parent {
        if folder_depth(s, Some(&parent.id), space_id) + 1 >= MAX_FOLDER_DEPTH {
            return s.clone();
        }
    }
    let target_parent: Option<Str> = parent.map(|p| p.id.clone());
    // (`name = 'New Folder'` for undefined: the same as `folderName(undefined ?? '') || 'New Folder'`.)
    let named = folder_name(name);
    let named = unique_name(s, space_id, if named.is_empty() { "New Folder" } else { &named });
    let mut next = s.clone();
    Rc::make_mut(&mut next.folders).push(Rc::new(Folder {
        id: id.into(),
        space_id: space_id.into(),
        name: named.into(),
        open: true,
        pos: None,
        parent_id: target_parent.clone(),
    }));
    let level = placed(pin_order(&next, space_id, target_parent.as_deref()), Entry::folder(id), before_id.as_str());
    next = write_order(&next, target_parent.as_deref(), &level);
    for pin_id in pin_ids {
        if next.pins.iter().any(|p| *p.id == **pin_id && *p.space_id == *space_id) {
            next = move_pin(&next, Arg::Str(pin_id), Arg::Str(id), Arg::Value(&Value::Null));
        }
    }
    next
}

/// M:1376 `renameFolder(state, folderId, name)`: its name (`folderName`). The state itself when the name is empty, the
/// folder isn't one or has that name.
pub fn rename_folder(s: &LibState, folder_id: Arg<'_>, name: Arg<'_>) -> LibState {
    let clean = folder_name(name);
    let Some(id) = folder_id.as_str() else { return s.clone() };
    let Some(folder) = s.folders.iter().find(|f| *f.id == *id) else { return s.clone() };
    if clean.is_empty() || *folder.name == *clean {
        return s.clone();
    }
    let name: Str = clean.into();
    let mut next = s.clone();
    next.folders = Rc::new(
        s.folders
            .iter()
            .map(|f| if *f.id == *id { Rc::new(Folder { name: name.clone(), ..(**f).clone() }) } else { f.clone() })
            .collect(),
    );
    next
}

/// M:1383 `setFolderOpen(state, folderId, open)`. The state itself when the folder isn't one or is so already.
pub fn set_folder_open(s: &LibState, folder_id: Arg<'_>, open: bool) -> LibState {
    let Some(id) = folder_id.as_str() else { return s.clone() };
    let Some(folder) = s.folders.iter().find(|f| *f.id == *id) else { return s.clone() };
    if folder.open == open {
        return s.clone();
    }
    let mut next = s.clone();
    next.folders = Rc::new(
        s.folders
            .iter()
            .map(|f| if *f.id == *id { Rc::new(Folder { open, ..(**f).clone() }) } else { f.clone() })
            .collect(),
    );
    next
}

/// M:1391 `moveFolder(state, folderId, { parentId, beforeId })`: a folder under `parent_id` of its space (null: the top
/// level; undefined: where it is), before `before_id` there (else the end). The state itself when there's no such
/// folder or parent, the parent is the folder or under it (a cycle), or the folder and what's under it would go past
/// [`MAX_FOLDER_DEPTH`].
pub fn move_folder(s: &LibState, folder_id: Arg<'_>, parent_id: Arg<'_>, before_id: Arg<'_>) -> LibState {
    let Some(folder) = folder_id.as_str().and_then(|id| s.folders.iter().find(|f| *f.id == *id)) else {
        return s.clone();
    };
    let from: Option<Str> = folder_parent(s, folder).map(|p| p.id.clone());
    // `parentId === undefined ? from : parentId`, then `to != null`: any value but null, to be found (a string).
    let to: Option<Str> = match parent_id {
        Arg::Undefined => from.clone(),
        p if p.nullish() => None,
        p => {
            let Some(to) = p.as_str() else { return s.clone() };
            Some(to.into())
        }
    };
    if let Some(to) = to.as_deref() {
        if folder_in(s, to, &folder.space_id).is_none() {
            return s.clone();
        }
        if folder_has_ancestor(s, to, &folder.id, &folder.space_id) {
            return s.clone();
        }
        let depth = folder_depth(s, Some(to), &folder.space_id) + 1;
        let height = folder_subtree_height(s, &folder.id, &folder.space_id);
        // (`newDepth + height - 1 >= MAX_FOLDER_DEPTH`, depth ≥ 1.)
        if depth + height > MAX_FOLDER_DEPTH {
            return s.clone();
        }
    }
    let mut next = s.clone();
    if from != to {
        let level: Vec<Entry> =
            pin_order(&next, &folder.space_id, from.as_deref()).into_iter().filter(|x| *x.id != *folder.id).collect();
        next = write_order(&next, from.as_deref(), &level);
    }
    let level =
        placed(pin_order(&next, &folder.space_id, to.as_deref()), Entry::folder(&folder.id), before_id.as_str());
    write_order(&next, to.as_deref(), &level)
}

/// M:1410 `deleteFolder(state, folderId)`: the folder gone, what was in it (pins and folders) put at its parent's level
/// in its place. The state itself when there's no such folder.
pub fn delete_folder(s: &LibState, folder_id: Arg<'_>) -> LibState {
    let Some(folder) = folder_id.as_str().and_then(|id| s.folders.iter().find(|f| *f.id == *id)) else {
        return s.clone();
    };
    let parent: Option<Str> = folder_parent(s, folder).map(|p| p.id.clone());
    let inside = pin_order(s, &folder.space_id, Some(&folder.id));
    let mut level: Vec<Entry> = Vec::new();
    for x in pin_order(s, &folder.space_id, parent.as_deref()) {
        if *x.id == *folder.id {
            level.extend(inside.iter().cloned());
        } else {
            level.push(x);
        }
    }
    let mut next = s.clone();
    next.folders = Rc::new(s.folders.iter().filter(|f| *f.id != *folder.id).cloned().collect());
    write_order(&next, parent.as_deref(), &level)
}

#[cfg(test)]
#[path = "order_tests.rs"]
mod tests;
