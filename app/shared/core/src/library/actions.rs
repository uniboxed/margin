//! The library's 57 actions and `perform` (docs/CORE-REFACTOR.md step 4 part 4): library.ts's `ACTIONS` (LT:283-807),
//! `ACTION_NAMES` (LT:810), `perform` (LT:816-832) and the helpers they share (LT:177-281: `win`, `windowSpace`,
//! `frontOf`, `spaceTarget`, `used`, `pinOfItem`, `addItem`, `archiveItem`, `splitRefusal`, `splitShown`, `splitNext`),
//! each one Rust function with LT's name and its body LT's line by line, over the model's rules ([`super::model`]).
//!
//! The ways every action keeps the TS's:
//! - A payload is read as library.ts reads it: `p` is the payload when it's an object (not an array), else `{}`;
//!   `s.keptTabs[p?.tabId]` looks the item up by the value's property key (`["t-a"]` finds `t-a`, a number `5` finds
//!   `"5"`); `hasSpace(s, p.spaceId)` only of a string; `p?.x ?? null` is [`Arg::or_null`], `p?.title ?? ''` is
//!   [`or_empty`]. A prototype name as an id (`constructor`) finds nothing (open question 4).
//! - A throw of a rule (`createSpace`'s `name?.trim()`, `archiveKept`'s `state.spaces[0].id`) fails the action as LT:825
//!   does: `failed: <JavaScriptCore's words>`. A refusal fails it with LT's words. A failure changes nothing and asks
//!   nothing (its requests are dropped).
//! - A target is written as JS holds it: `targetOfItem(k)` and `targetOf(pin.target)` checked again
//!   ([`checked_target`]), `spaceTarget` as the space has it (a profile of any length, as `createSpace` keeps it).
//! - A request's `windowId` is the payload's as it came (`p.windowId ?? null`), its numbers through a double as JS's.
//! - "The first of several equal" (`Object.values(s.keptTabs).find(…)`) is the items' order (Tirth's answer 10);
//!   `localeCompare` is the caller's sorter (`LocaleCompare`: the system's).
//! - The ids are the env's first (Swift's 4 a perform), then the core's own letters (`js::Ids`).

use std::borrow::Cow;
use std::rc::Rc;

use serde_json::{Map, Value, json};

use super::js::{self, Ids, LocaleCompare};
use super::model::favorites::{self, NewFavorite};
use super::model::kept::{self, ForWhom, Side};
use super::model::{Arg, bound_elsewhere, has_space, links, order, spaces, splits};
use super::state::{
    ArchiveEntry, Axis, BROWSERS, Favorite, ICON_MAX, Item, LibState, LibTarget, MAX_SPLIT_PANES, Pin, Space, Split,
    Str, TEXT_MAX, TargetView, margin_page_title, place_of, str_of, target_of, theme_id_ok,
};
use super::values::{Change, diff};

/// The actions the library takes (LT:810 `ACTION_NAMES`: `Object.keys(ACTIONS).sort()`, UTF-16 order); any other name
/// is refused (`unsupported`).
pub const ACTION_NAMES: [&str; 57] = [
    "activateTab",
    "addAirTrafficRule",
    "addFavorite",
    "addItem",
    "addToSplit",
    "breakOutSplit",
    "clearToday",
    "closeSplitPane",
    "closeTab",
    "createFolder",
    "createSpace",
    "createSplit",
    "deleteFolder",
    "deleteSpace",
    "duplicateTab",
    "forgetWindow",
    "itemClosed",
    "mediaControl",
    "moveFavorite",
    "moveFolder",
    "movePin",
    "moveTab",
    "moveTabToSpace",
    "muteTab",
    "nestFolder",
    "newTab",
    "openFavorite",
    "openMarginPage",
    "openPin",
    "openSplit",
    "orderSpaces",
    "pinTab",
    "removeAirTrafficRule",
    "removeFavorite",
    "removeFromSplit",
    "removeItem",
    "renameFavorite",
    "renameFolder",
    "renamePin",
    "renameSpace",
    "renameTab",
    "resetFavorite",
    "resetPin",
    "resizeSplit",
    "restoreArchive",
    "restoreLastArchive",
    "routeUrl",
    "setFolderOpen",
    "setSpace",
    "setSpaceProfile",
    "setSpaceTheme",
    "swapSplit",
    "toggleAirTrafficRule",
    "toggleSplitAxis",
    "unloadTab",
    "unpin",
    "updateItem",
];

/// What an action is given besides its payload (LT:34 `Env`): the time (`finite(env.now)`) and the ids to use first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Env {
    pub now: f64,
    pub ids: Vec<String>,
}

/// A request for the hosting (LT:33 `Request`): `{ type, windowId?, item?, url?, target?, … }`, keys in LT's order.
pub type Request = Map<String, Value>;

/// One action's outcome (LT:35 `Outcome`): the changes to merge (untimed: the store times them), what it answers, what
/// it asks of the hosting. A failure (`ok` false, `error` its words) has no changes and no requests.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub ok: bool,
    /// `out.result ?? null`; null on a failure.
    pub result: Value,
    pub error: Option<String>,
    pub changes: Vec<Change>,
    pub requests: Vec<Request>,
}

impl Outcome {
    fn failed(error: String) -> Outcome {
        Outcome { ok: false, result: Value::Null, error: Some(error), changes: Vec::new(), requests: Vec::new() }
    }

    /// As LT answers it: `{ ok, result, error?, changes, requests }`.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("ok".into(), Value::Bool(self.ok));
        o.insert("result".into(), self.result.clone());
        if let Some(e) = &self.error {
            o.insert("error".into(), Value::String(e.clone()));
        }
        o.insert("changes".into(), Value::Array(self.changes.iter().map(Change::to_json).collect()));
        o.insert("requests".into(), Value::Array(self.requests.iter().cloned().map(Value::Object).collect()));
        Value::Object(o)
    }
}

/// LT:816 `perform(values, action, payload, env)` on the state read from the values (`stateOf`, the caller's: kept per
/// revision of the set): the action by its name (an unknown one, or a prototype's, `unsupported`), the payload when
/// it's an object, then on success `settleSplits` (LT:830) and the changes from the state to what it became (LT:831,
/// `diff`; `values.imports` passes through on both sides, so it never changes and isn't needed here).
pub fn perform(s: &LibState, action: &str, payload: &Value, env: Env, compare: &dyn LocaleCompare) -> Outcome {
    let empty = Map::new();
    let p = payload.as_object().unwrap_or(&empty);
    let now = if env.now.is_finite() { env.now } else { 0.0 };
    let mut cx = Cx { p, now, ids: Ids::new(env.ids), requests: Vec::new(), compare };
    let Some(done) = act(s, action, &mut cx) else {
        return Outcome::failed("unsupported".into());
    };
    match done {
        Err(Fail::Refused(words)) => Outcome::failed(words.into_owned()),
        Err(Fail::Threw(words)) => Outcome::failed(format!("failed: {words}")),
        Ok((next, result)) => {
            let after = splits::settle_splits(&next);
            Outcome { ok: true, result, error: None, changes: diff(s, &after), requests: cx.requests }
        }
    }
}

// ---- the context ------------------------------------------------------------------------------------------------------

/// LT:242 `Ctx` without the state: the payload, the time, the ids, the requests made so far, the sorter.
struct Cx<'a> {
    p: &'a Map<String, Value>,
    now: f64,
    ids: Ids,
    requests: Vec<Request>,
    compare: &'a dyn LocaleCompare,
}

impl<'a> Cx<'a> {
    /// `p?.field` as it came.
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.p.get(key)
    }

    /// `p?.field` for a rule of M.
    fn arg(&self, key: &str) -> Arg<'a> {
        Arg::of(self.p.get(key))
    }

    /// `typeof p?.field === 'string' ? p.field : …`.
    fn str(&self, key: &str) -> Option<&'a str> {
        self.p.get(key).and_then(Value::as_str)
    }

    /// LT:192 `win(p)`.
    fn win(&self) -> Option<String> {
        win(self.p)
    }

    /// `p.windowId ?? null` (LT's requests), as JS passes it on.
    fn window_id(&self) -> Value {
        js_json(self.p.get("windowId"))
    }

    fn push(&mut self, request: Value) {
        if let Value::Object(o) = request {
            self.requests.push(o);
        }
    }
}

/// Why an action didn't do what it was asked: LT's words (`fail(s, …)`), or a throw (LT:825: `failed: <its words>`).
enum Fail {
    Refused(Cow<'static, str>),
    Threw(&'static str),
}

/// What an action answers: the state after it and its result (null for none), or why not.
type Done = Result<(LibState, Value), Fail>;

fn refuse<T>(words: &'static str) -> Result<T, Fail> {
    Err(Fail::Refused(Cow::Borrowed(words)))
}

/// `{ s }`: the state (changed or not), no result.
fn done(s: LibState) -> Done {
    Ok((s, Value::Null))
}

/// The action named, or none (`Object.hasOwn(ACTIONS, action)`, LT:817).
fn act(s: &LibState, action: &str, cx: &mut Cx) -> Option<Done> {
    Some(match action {
        "setSpace" => set_space(s, cx),
        "createSpace" => create_space(s, cx),
        "renameSpace" => rename_space(s, cx),
        "setSpaceTheme" => set_space_theme(s, cx),
        "setSpaceProfile" => set_space_profile(s, cx),
        "deleteSpace" => delete_space(s, cx),
        "orderSpaces" => order_spaces(s, cx),
        "newTab" => new_tab(s, cx),
        "addItem" => add_item_action(s, cx),
        "updateItem" => update_item(s, cx),
        "openMarginPage" => open_margin_page(s, cx),
        "activateTab" => activate_tab(s, cx),
        "closeTab" => close_tab(s, cx),
        "unloadTab" => unload_tab(s, cx),
        "duplicateTab" => duplicate_tab(s, cx),
        "muteTab" => mute_tab(s, cx),
        "mediaControl" => media_control(s, cx),
        "itemClosed" => item_closed(s, cx),
        "removeItem" => remove_item(s, cx),
        "moveTabToSpace" => move_tab_to_space(s, cx),
        "moveTab" => move_tab(s, cx),
        "clearToday" => clear_today(s, cx),
        "restoreArchive" => restore_archive(s, cx),
        "restoreLastArchive" => restore_last_archive(s, cx),
        "pinTab" => pin_tab(s, cx),
        "unpin" => unpin(s, cx),
        "openPin" => open_pin(s, cx),
        "resetPin" => reset_pin(s, cx),
        "renamePin" => rename_pin(s, cx),
        "renameTab" => rename_tab(s, cx),
        "movePin" => move_pin(s, cx),
        "addFavorite" => add_favorite(s, cx),
        "removeFavorite" => remove_favorite(s, cx),
        "openFavorite" => open_favorite(s, cx),
        "resetFavorite" => reset_favorite(s, cx),
        "renameFavorite" => rename_favorite(s, cx),
        "moveFavorite" => move_favorite(s, cx),
        "addAirTrafficRule" => add_air_traffic_rule(s, cx),
        "removeAirTrafficRule" => remove_air_traffic_rule(s, cx),
        "toggleAirTrafficRule" => toggle_air_traffic_rule(s, cx),
        "routeUrl" => route_url(s, cx),
        "createSplit" => create_split(s, cx),
        "addToSplit" => add_to_split(s, cx),
        "openSplit" => open_split(s, cx),
        "breakOutSplit" => break_out_split(s, cx),
        "removeFromSplit" => remove_from_split(s, cx),
        "closeSplitPane" => close_tab(s, cx),
        "swapSplit" => swap_split(s, cx),
        "resizeSplit" => resize_split(s, cx),
        "toggleSplitAxis" => toggle_split_axis(s, cx),
        "createFolder" => create_folder(s, cx),
        "renameFolder" => done(order::rename_folder(s, cx.arg("folderId"), cx.arg("name"))),
        "setFolderOpen" => done(order::set_folder_open(s, cx.arg("folderId"), cx.arg("open").truthy())),
        "deleteFolder" => done(order::delete_folder(s, cx.arg("folderId"))),
        "moveFolder" | "nestFolder" => {
            done(order::move_folder(s, cx.arg("folderId"), cx.arg("parentId").or_null(), cx.arg("beforeId").or_null()))
        }
        "forgetWindow" => forget_window(s, cx),
        _ => return None,
    })
}

// ---- library.ts's helpers (LT:192-281) ---------------------------------------------------------------------------------

/// LT:192 `win(p)`: the window's id as a string (`String(p.windowId)` of a number or a string that isn't empty), else
/// none.
fn win(p: &Map<String, Value>) -> Option<String> {
    match p.get("windowId") {
        Some(Value::Number(n)) => Some(js::number_string(n.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(w)) if !w.is_empty() => Some(w.clone()),
        _ => None,
    }
}

/// A payload's value passed on as JS passes it (`p.windowId ?? null`): numbers through a double, written as JS writes
/// them (an integral one as an integer).
fn js_json(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Number(n)) => crate::protocol::number(n.as_f64().unwrap_or(f64::NAN)).unwrap_or(Value::Null),
        Some(Value::Array(list)) => Value::Array(list.iter().map(|x| js_json(Some(x))).collect()),
        Some(Value::Object(o)) => Value::Object(o.iter().map(|(k, x)| (k.clone(), js_json(Some(x)))).collect()),
        Some(other) => other.clone(),
    }
}

/// `x ?? ''`: a nullish payload value as the empty string (LT:573, 577, 641).
fn or_empty(a: Arg<'_>) -> Arg<'_> {
    if a.nullish() { Arg::Str("") } else { a }
}

/// `!x` of an id: none for none and for `""`.
fn some_id(id: Option<&str>) -> Option<&str> {
    id.filter(|x| !x.is_empty())
}

/// LT:193 `hasSpace(s, p.spaceId) ? p.spaceId : …`: the payload's space when it's a string naming one.
fn given_space<'p>(s: &LibState, v: Option<&'p Value>) -> Option<&'p str> {
    v.and_then(Value::as_str).filter(|id| has_space(s, id))
}

/// LT:194 `spaceOf(s, id)`: the first space with this id.
fn space_of<'s>(s: &'s LibState, id: &str) -> Option<&'s Rc<Space>> {
    s.spaces.iter().find(|sp| *sp.id == *id)
}

/// LT:196 `windowSpace(s, w)`: the space the window shows, else the first space's; none with no spaces.
fn window_space<'s>(s: &'s LibState, w: Option<&str>) -> Option<&'s str> {
    w.and_then(|w| s.windows.get(w))
        .filter(|id| has_space(s, id))
        .map(|id| &**id)
        .or_else(|| s.spaces.first().map(|sp| &*sp.id))
}

/// `s.keptTabs[p?.tabId]` (any payload value: its property key).
fn item_of<'s>(s: &'s LibState, v: Option<&Value>) -> Option<&'s Rc<Item>> {
    s.kept.get(&js::property_key(v))
}

/// LT:199 `frontOf(s, spaceId, except)`: front-item.ts's `frontItemOf` over the items.
fn front_of<'s>(s: &'s LibState, space_id: &str, except: Option<&str>, cx: &Cx) -> Option<&'s Rc<Item>> {
    kept::front_item_of(s.kept.values(), space_id, except, cx.compare)
}

/// LT:203 `spaceTarget(s, spaceId)`: a new web item's of the space: its browser and profile (Safari's default for none).
fn space_target(s: &LibState, space_id: &str) -> LibTarget {
    match space_of(s, space_id) {
        Some(sp) => LibTarget::Web { browser: sp.browser.clone(), profile: sp.profile.clone() },
        None => LibTarget::safari(),
    }
}

/// `targetOf(t)` of a typed target: checked and cut again (LT:201 `targetOfItem`, `targetOf(pin.target)`), the same
/// target when it holds already (as every one `stateOf` read does).
fn checked_target(t: &LibTarget) -> LibTarget {
    let same = |a: &str, b: &Str| *a == **b;
    match (TargetView::of(t), t) {
        (TargetView::Web { browser, profile }, LibTarget::Web { browser: b, profile: p })
            if same(browser, b) && profile == p.as_deref() =>
        {
            t.clone()
        }
        (TargetView::App { bundle_id, name }, LibTarget::App { bundle_id: b, name: n })
            if same(bundle_id, b) && same(name, n) =>
        {
            t.clone()
        }
        (TargetView::Margin { .. }, LibTarget::Margin { .. }) => t.clone(),
        (TargetView::Web { browser, profile }, _) => LibTarget::web(browser, profile),
        (TargetView::App { bundle_id, name }, _) => LibTarget::App { bundle_id: bundle_id.into(), name: name.into() },
        (TargetView::Margin { page }, _) => LibTarget::Margin { page: page.into() },
    }
}

/// LT:201 `targetOfItem(k)`.
fn target_of_item(k: &Item) -> LibTarget {
    checked_target(&k.target)
}

/// A target as JS holds it, written as it is (`{ kind, browser, profile }`…: no check, a request's).
fn target_json(t: &LibTarget) -> Value {
    match t {
        LibTarget::Web { browser, profile } => {
            json!({ "kind": "web", "browser": &**browser, "profile": profile.as_deref() })
        }
        LibTarget::App { bundle_id, name } => json!({ "kind": "app", "bundleId": &**bundle_id, "name": &**name }),
        LibTarget::Margin { page } => json!({ "kind": "margin", "page": &**page }),
    }
}

/// `targetOf(x.target)` of a pin's or favorite's: checked, or null.
fn target_of_json(t: Option<&LibTarget>) -> Value {
    t.map_or(Value::Null, |t| target_json(&checked_target(t)))
}

/// LT:206 `used(s, id, w, now)`: the item used now, selected in its space (the others not), and the window showing its
/// space. The state itself for no such item.
fn used(s: &LibState, id: &str, w: Option<&str>, now: f64) -> LibState {
    let Some(k) = s.kept.get(id) else { return s.clone() };
    let mut next = s.clone();
    let kept = Rc::make_mut(&mut next.kept);
    for other in s.kept.values() {
        if *other.space_id == *k.space_id && *other.id != *id && other.was_active {
            kept.insert(other.id.clone(), Rc::new(Item { was_active: false, ..(**other).clone() }));
        }
    }
    kept.insert(k.id.clone(), Rc::new(Item { last_active: now, was_active: true, ..(**k).clone() }));
    match w {
        Some(w) => spaces::set_active_space(&next, w, &k.space_id),
        None => next,
    }
}

/// LT:219 `pinOfItem(s, k, pinId, folderId, beforeId)`: the item pinned as `pin_id` (the pin takes its address, title,
/// own name and target), and bound to it. The state itself when the space has a pin at that address already.
fn pin_of_item(s: &LibState, k: &Item, pin_id: &str, folder_id: Arg<'_>, before_id: Arg<'_>) -> LibState {
    let mut next = order::add_pin(s, pin_id, &k.space_id, &k.url, Some(&k.title), folder_id, before_id);
    if next.same(s) {
        return next;
    }
    if let Some(c) = k.custom_title.as_deref().filter(|c| !c.is_empty()) {
        next = order::rename_pin(&next, pin_id, Arg::Str(c));
    }
    let target = target_of_item(k);
    let pins: Vec<Rc<Pin>> = next
        .pins
        .iter()
        .map(|pin| {
            if *pin.id == *pin_id {
                Rc::new(Pin { target: Some(target.clone()), ..(**pin).clone() })
            } else {
                pin.clone()
            }
        })
        .collect();
    next.pins = Rc::new(pins);
    order::bind_tab_to_pin(&next, &k.id, Some(pin_id))
}

/// LT:227 `addItem`'s argument: a new item's fields.
struct NewItem<'a> {
    space_id: &'a str,
    url: &'a str,
    title: &'a str,
    icon: &'a str,
    target: LibTarget,
    now: f64,
    pinned_by: Option<&'a str>,
    favorite_id: Option<&'a str>,
}

/// LT:227 `addItem(s, id, …)`: a new item, in the list's newest place (`lastPlace + 1`), not selected.
fn add_item(s: &LibState, id: &str, n: NewItem<'_>) -> LibState {
    let item = Item {
        id: id.into(),
        url: n.url.into(),
        title: n.title.into(),
        fav_icon_url: n.icon.into(),
        space_id: n.space_id.into(),
        order: kept::last_place(s) + 1.0,
        last_active: n.now,
        was_active: false,
        kept_at: n.now,
        why: "library".into(),
        target: n.target,
        pinned_by: some_id(n.pinned_by).map(Str::from),
        favorite_id: some_id(n.favorite_id).map(Str::from),
        custom_title: None,
        imported: None,
    };
    let mut next = s.clone();
    Rc::make_mut(&mut next.kept).insert(id.into(), Rc::new(item));
    next
}

/// LT:234 `archiveItem(s, id, archiveId, now)`: the item to the archive (a web page's, with the item's target) or
/// forgotten (model.ts's `archiveKept`). The state itself for no such item; its throw for an item of a gone space with
/// no space left.
fn archive_item(s: &LibState, id: Arg<'_>, archive_id: &str, now: f64) -> Result<LibState, Fail> {
    let Some(k) = s.kept.get(&id.key()) else { return Ok(s.clone()) };
    let mut next = kept::archive_kept(s, id, archive_id, now).map_err(Fail::Threw)?;
    if !next.archive.iter().any(|a| *a.id == *archive_id) {
        return Ok(next);
    }
    let target = target_of_item(k);
    let archive: Vec<Rc<ArchiveEntry>> = next
        .archive
        .iter()
        .map(|a| {
            if *a.id == *archive_id {
                Rc::new(ArchiveEntry { target: Some(target.clone()), ..(**a).clone() })
            } else {
                a.clone()
            }
        })
        .collect();
    next.archive = Rc::new(archive);
    Ok(next)
}

/// LT:249 `splitRefusal(s, panes, adding, spaceId)`: why `adding` can't join a split of `panes` in the space (none: it
/// can): 4 panes at most, one space, never Margin's own pages, a Mac app once.
fn split_refusal(s: &LibState, panes: &[Str], adding: &[&str], space_id: &str) -> Option<Cow<'static, str>> {
    let mut all: Vec<&str> = panes.iter().map(|x| &**x).collect();
    all.extend(adding.iter().filter(|id| !panes.iter().any(|x| **x == ***id)));
    if all.len() > MAX_SPLIT_PANES {
        return Some(format!("a split has {} panes at most", MAX_SPLIT_PANES).into());
    }
    let mut apps: Vec<&str> = Vec::new();
    for id in all {
        let Some(k) = s.kept.get(id) else { return Some("no such item".into()) };
        if *k.space_id != *space_id {
            return Some("a split's panes are of one space".into());
        }
        match TargetView::of(&k.target) {
            TargetView::Margin { .. } => return Some("Margin's own pages aren't split".into()),
            TargetView::App { bundle_id, name } => {
                if apps.contains(&bundle_id) {
                    return Some(format!("{name} is in this split already").into());
                }
                apps.push(bundle_id);
            }
            TargetView::Web { .. } => {}
        }
    }
    None
}

/// LT:267 `splitShown(s, group, focus, p)`: the hosting's request to show a split, its panes (the items there are) in
/// order, the one focused (none: the window's own choice).
fn split_shown(s: &LibState, group: &Split, focus: Option<&str>, cx: &Cx) -> Value {
    let panes: Vec<Value> = group
        .panes
        .iter()
        .filter_map(|id| s.kept.get(id).map(|k| (id, k)))
        .map(|(id, k)| json!({ "item": &**id, "url": &*k.url, "target": target_json(&target_of_item(k)) }))
        .collect();
    let ratios: Vec<Value> = group.ratios.iter().map(|r| crate::protocol::number(*r).unwrap_or(Value::Null)).collect();
    json!({
        "type": "showSplit", "windowId": cx.window_id(), "splitId": &*group.id, "item": focus,
        "axis": group.axis.as_str(), "ratios": ratios, "panes": panes,
    })
}

/// LT:275 `splitNext(s, id)`: the item shown after `id` closes when it's a split's pane: the split's next pane (after
/// it, else before it); none when it's no pane or none is left.
fn split_next(s: &LibState, id: &str) -> Option<Str> {
    let group = splits::split_for_item(s, id)?;
    let i = group.panes.iter().position(|x| **x == *id)?;
    let rest: Vec<&Str> = group.panes.iter().filter(|x| ***x != *id && s.kept.contains_key(x)).collect();
    // (`rest[Math.min(i, rest.length - 1)]`: none when `rest` is empty.)
    rest.get(i.min(rest.len().checked_sub(1)?)).map(|x| (*x).clone())
}

/// An item's request (`{ type, windowId, item, url, target, spaceId }`, the shape of most).
fn item_request(kind: &str, window_id: Value, k: &Item) -> Value {
    json!({
        "type": kind, "windowId": window_id, "item": &*k.id, "url": &*k.url,
        "target": target_json(&target_of_item(k)), "spaceId": &*k.space_id,
    })
}

// ---- spaces (LT:285-335) -----------------------------------------------------------------------------------------------

/// LT:285 `setSpace`: the window shows the space; the hosting shows its front item.
fn set_space(s: &LibState, cx: &mut Cx) -> Done {
    let (Some(w), Some(space_id)) = (cx.win(), given_space(s, cx.get("spaceId"))) else {
        return refuse("no such window or space");
    };
    let next = spaces::set_active_space(s, &w, space_id);
    let front = front_of(&next, space_id, None, cx);
    let mut request = json!({
        "type": "setSpace", "windowId": cx.window_id(), "spaceId": space_id, "item": front.map(|k| &*k.id),
    });
    if let (Some(k), Value::Object(o)) = (front, &mut request) {
        o.insert("url".into(), Value::from(&*k.url));
        o.insert("target".into(), target_json(&target_of_item(k)));
    }
    let result = json!({ "spaceId": space_id, "shown": front.map(|k| &*k.id) });
    cx.push(request);
    Ok((next, result))
}

/// LT:293 `createSpace`: a new space (its browser, profile and theme as asked, else those of the space the window
/// shows), shown in the window.
fn create_space(s: &LibState, cx: &mut Cx) -> Done {
    let id = cx.ids.other("sp");
    let w = cx.win();
    let from = space_of(s, window_space(s, w.as_deref()).unwrap_or(""));
    let browser: Str = match cx.str("browser").filter(|b| BROWSERS.contains(b)) {
        Some(b) => b.into(),
        None => from.map_or_else(|| "safari".into(), |f| f.browser.clone()),
    };
    let profile: Option<Str> = if cx.p.contains_key("profile") {
        some_id(cx.str("profile")).map(Str::from)
    } else {
        from.and_then(|f| f.profile.clone())
    };
    let theme: Option<&str> = match cx.str("theme").filter(|t| theme_id_ok(t)) {
        Some(t) => Some(t),
        None => from.and_then(|f| f.theme.as_deref()),
    };
    let mut next =
        spaces::create_space(s, &id, cx.arg("name"), cx.arg("emoji"), cx.arg("color"), theme).map_err(Fail::Threw)?;
    let list: Vec<Rc<Space>> = next
        .spaces
        .iter()
        .map(|sp| {
            if *sp.id == *id {
                Rc::new(Space { browser: browser.clone(), profile: profile.clone(), ..(**sp).clone() })
            } else {
                sp.clone()
            }
        })
        .collect();
    next.spaces = Rc::new(list);
    if let Some(w) = &w {
        next = spaces::set_active_space(&next, w, &id);
    }
    Ok((next, json!({ "spaceId": id })))
}

/// LT:307 `renameSpace`: its name, emoji, colour (and theme, and profile, when given).
fn rename_space(s: &LibState, cx: &mut Cx) -> Done {
    let Some(space_id) = given_space(s, cx.get("spaceId")) else { return refuse("no such space") };
    let next = spaces::update_space(s, space_id, cx.arg("name"), cx.arg("emoji"), cx.arg("color"), cx.arg("theme"));
    if !cx.p.contains_key("profile") {
        return done(next);
    }
    // (`ACTIONS.setSpaceProfile({ s: next, p, … }).s`: its state, failed or not.)
    Ok((with_space_profile(&next, cx).unwrap_or(next), Value::Null))
}

/// LT:314 `setSpaceTheme`: a theme's id, or null (none: the profile's).
fn set_space_theme(s: &LibState, cx: &mut Cx) -> Done {
    let Some(space_id) = given_space(s, cx.get("spaceId")) else { return refuse("no such space") };
    let theme = cx.arg("theme");
    if !theme.is_null() && !theme.as_str().is_some_and(theme_id_ok) {
        return refuse("not a theme id");
    }
    done(spaces::update_space(s, space_id, Arg::Undefined, Arg::Undefined, Arg::Undefined, theme))
}

/// LT:320 `setSpaceProfile`: the space's browser profile (null: the browser's default) and browser, for its new web
/// items.
fn set_space_profile(s: &LibState, cx: &mut Cx) -> Done {
    match with_space_profile(s, cx) {
        Some(next) => done(next),
        None => refuse("no such space"),
    }
}

fn with_space_profile(s: &LibState, cx: &Cx) -> Option<LibState> {
    let space_id = given_space(s, cx.get("spaceId"))?;
    let profile: Option<Str> = some_id(cx.str("profile")).map(|x| Str::from(js::slice16(x, 256)));
    let browser: Option<Str> = cx.str("browser").filter(|b| BROWSERS.contains(b)).map(Str::from);
    let list: Vec<Rc<Space>> = s
        .spaces
        .iter()
        .map(|sp| {
            if *sp.id != *space_id {
                return sp.clone();
            }
            let mut out = Space { profile: profile.clone(), ..(**sp).clone() };
            if let Some(b) = &browser {
                out.browser = b.clone();
            }
            Rc::new(out)
        })
        .collect();
    let mut next = s.clone();
    next.spaces = Rc::new(list);
    Some(next)
}

/// LT:326 `deleteSpace`: its items, pins, folders, archive entries and windows to the first space left.
fn delete_space(s: &LibState, cx: &mut Cx) -> Done {
    let Some(space_id) = given_space(s, cx.get("spaceId")) else { return refuse("no such space") };
    if s.spaces.len() < 2 {
        return refuse("the last space");
    }
    let into = s.spaces.iter().find(|sp| *sp.id != *space_id).map(|sp| sp.id.clone());
    Ok((spaces::delete_space(s, space_id), json!({ "into": into.as_deref() })))
}

/// LT:331 `orderSpaces`: the spaces in the order given (the ids that are strings).
fn order_spaces(s: &LibState, cx: &mut Cx) -> Done {
    let Some(list) = cx.get("spaceIds").and_then(Value::as_array) else { return refuse("no order") };
    let ids: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
    done(spaces::order_spaces(s, &ids))
}

// ---- items (LT:337-525) ------------------------------------------------------------------------------------------------

/// LT:337 `newTab`: the page or app asked for opened in the window's space (or `spaceId`, or a link rule's): a new
/// item, shown (the hosting opens it).
fn new_tab(s: &LibState, cx: &mut Cx) -> Done {
    let w = cx.win();
    let given = given_space(s, cx.get("spaceId"));
    let matched = match (given, cx.str("url")) {
        (None, Some(url)) => links::match_air_traffic_rule(url, &s.air_traffic, Some(&s.spaces)),
        _ => None,
    };
    let space_id = given.or_else(|| matched.map(|r| &*r.space_id)).or_else(|| window_space(s, w.as_deref()));
    let Some(space_id) = some_id(space_id) else { return refuse("no space") };
    let target = target_of(cx.get("target")).unwrap_or_else(|| space_target(s, space_id));
    let title = if matches!(target, LibTarget::App { .. }) { None } else { cx.get("title") };
    let (url, title) = place_of(&target, cx.get("url"), title);
    if url.is_empty() {
        return refuse("no address");
    }
    let id = cx.ids.tab();
    let request = json!({
        "type": "newTab", "windowId": cx.window_id(), "item": &id, "url": &url, "target": target_json(&target),
        "spaceId": space_id,
    });
    let next = add_item(
        s,
        &id,
        NewItem {
            space_id,
            url: &url,
            title: &title,
            icon: "",
            target,
            now: cx.now,
            pinned_by: None,
            favorite_id: None,
        },
    );
    let next = used(&next, &id, w.as_deref(), cx.now);
    cx.push(request);
    Ok((next, json!({ "tabId": id })))
}

/// LT:355 `addItem`: an item the hosting opened itself, added (and used now when `front`), not shown by the library.
fn add_item_action(s: &LibState, cx: &mut Cx) -> Done {
    let w = cx.win();
    let space_id = given_space(s, cx.get("spaceId")).or_else(|| window_space(s, w.as_deref()));
    let Some(space_id) = some_id(space_id) else { return refuse("no space") };
    let target = target_of(cx.get("target")).unwrap_or_else(|| space_target(s, space_id));
    let (url, title) = place_of(&target, cx.get("url"), cx.get("title"));
    if url.is_empty() {
        return refuse("no address");
    }
    let id = cx.ids.tab();
    let pinned_by = cx.str("pinnedBy").filter(|by| s.pins.iter().any(|x| *x.id == **by && *x.space_id == *space_id));
    let favorite_id = cx.str("favoriteId").filter(|f| s.favorites.iter().any(|x| *x.id == **f));
    let icon = if matches!(target, LibTarget::Margin { .. }) { "" } else { str_of(cx.get("icon"), ICON_MAX) };
    let mut next = add_item(
        s,
        &id,
        NewItem { space_id, url: &url, title: &title, icon, target, now: cx.now, pinned_by, favorite_id },
    );
    if cx.arg("front").truthy() {
        next = used(&next, &id, w.as_deref(), cx.now);
    }
    Ok((next, json!({ "tabId": id })))
}

/// LT:371 `updateItem`: the page an item's tab shows now (address, title, icon), as the hosting saw it; an app's title
/// only; a Margin page's never.
fn update_item(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    let replaced = |item: Item| {
        let mut next = s.clone();
        Rc::make_mut(&mut next.kept).insert(k.id.clone(), Rc::new(item));
        next
    };
    match TargetView::of(&k.target) {
        TargetView::Margin { .. } => done(s.clone()),
        TargetView::App { .. } => {
            let title = str_of(cx.get("title"), TEXT_MAX);
            if !title.is_empty() && *title != *k.title {
                done(replaced(Item { title: title.into(), ..(**k).clone() }))
            } else {
                done(s.clone())
            }
        }
        TargetView::Web { .. } => {
            let mut item = (**k).clone();
            if let Some(url) = cx.str("url").filter(|u| js::is_web_page(u)) {
                item.url = url.into();
            }
            if let Some(title) = cx.str("title") {
                item.title = js::slice16(title, TEXT_MAX).into();
            }
            if let Some(icon) = cx.str("icon") {
                item.fav_icon_url = js::slice16(icon, ICON_MAX).into();
            }
            done(replaced(item))
        }
    }
}

/// LT:387 `openMarginPage`: one of Margin's own pages in the window: the space's item of it used last, shown again,
/// else a new one.
fn open_margin_page(s: &LibState, cx: &mut Cx) -> Done {
    let Some(page) = cx.str("page").filter(|x| margin_page_title(x).is_some()) else {
        return refuse("no such page");
    };
    let w = cx.win();
    let Some(space_id) = some_id(window_space(s, w.as_deref())) else { return refuse("no space") };
    let target = LibTarget::Margin { page: page.into() };
    // (`.filter(…).sort((a, b) => finite(b.lastActive) - finite(a.lastActive) || a.id.localeCompare(b.id))[0]`: the
    // stable sort's first.)
    let finite = |x: f64| if x.is_finite() { x } else { 0.0 };
    let mut had: Option<&Rc<Item>> = None;
    for k in s.kept.values() {
        if *k.space_id != *space_id || !matches!(TargetView::of(&k.target), TargetView::Margin { page: p } if p == page)
        {
            continue;
        }
        let first = had.is_none_or(|b| {
            js::num_cmp(finite(b.last_active), finite(k.last_active))
                .then_with(|| cx.compare.compare(&k.id, &b.id))
                .is_lt()
        });
        if first {
            had = Some(k);
        }
    }
    if let Some(had) = had {
        cx.push(json!({
            "type": "activateTab", "windowId": cx.window_id(), "item": &*had.id, "url": &*had.url,
            "target": target_json(&target), "spaceId": space_id,
        }));
        return Ok((used(s, &had.id, w.as_deref(), cx.now), json!({ "tabId": &*had.id })));
    }
    let id = cx.ids.tab();
    let (url, title) = place_of(&target, None, None);
    let request = json!({
        "type": "newTab", "windowId": cx.window_id(), "item": &id, "url": &url, "target": target_json(&target),
        "spaceId": space_id,
    });
    let next = add_item(
        s,
        &id,
        NewItem {
            space_id,
            url: &url,
            title: &title,
            icon: "",
            target,
            now: cx.now,
            pinned_by: None,
            favorite_id: None,
        },
    );
    let next = used(&next, &id, w.as_deref(), cx.now);
    cx.push(request);
    Ok((next, json!({ "tabId": id })))
}

/// LT:405 `activateTab`: the item shown (the hosting shows it), used now.
fn activate_tab(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    cx.push(item_request("activateTab", cx.window_id(), k));
    Ok((used(s, &k.id, cx.win().as_deref(), cx.now), json!({ "shown": &*k.id })))
}

/// LT:414 `closeTab` (and LT:752 `closeSplitPane`): closed from Margin: to the archive (a web page's), forgotten when
/// it's a pin's or favorite's (they stay, not open); out of its split first, the split's next pane (else the space's
/// front item) shown after it.
fn close_tab(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    let sticky = bound_elsewhere(s, k, &k.space_id, None, None);
    let existing = splits::split_for_item(s, &k.id);
    let pane_next = split_next(s, &k.id);
    let mut next = match existing {
        Some(g) => splits::remove_from_split(s, &g.id, &k.id),
        None => s.clone(),
    };
    next = if sticky {
        kept::forget_kept(&next, Arg::Str(&k.id))
    } else {
        let archive_id = cx.ids.other("a");
        archive_item(&next, Arg::Str(&k.id), &archive_id, cx.now)?
    };
    let after =
        pane_next.as_deref().and_then(|id| next.kept.get(id)).or_else(|| front_of(&next, &k.space_id, None, cx));
    cx.push(json!({
        "type": "closeTab", "item": &*k.id, "url": &*k.url, "target": target_json(&target_of_item(k)),
        "spaceId": &*k.space_id, "next": after.map(|a| &*a.id),
    }));
    done(next)
}

/// LT:429 `unloadTab`: the live page closed or the app asked to quit, the item kept; the space's next front item named.
fn unload_tab(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    let after = front_of(s, &k.space_id, Some(&k.id), cx);
    let mut request = item_request("unloadTab", cx.window_id(), k);
    if let Value::Object(o) = &mut request {
        o.insert("next".into(), after.map_or(Value::Null, |a| Value::from(&*a.id)));
    }
    cx.push(request);
    Ok((s.clone(), json!({ "item": &*k.id })))
}

/// LT:437 `duplicateTab`: a web item copied right beside it (above) in its space, and opened.
fn duplicate_tab(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    let target = target_of_item(k);
    if !matches!(target, LibTarget::Web { .. }) {
        return refuse("only web items can be duplicated");
    }
    let id = cx.ids.tab();
    let w = cx.win();
    let request = json!({
        "type": "newTab", "windowId": cx.window_id(), "item": &id, "url": &*k.url, "target": target_json(&target),
        "spaceId": &*k.space_id,
    });
    let next = add_item(
        s,
        &id,
        NewItem {
            space_id: &k.space_id,
            url: &k.url,
            title: &k.title,
            icon: &k.fav_icon_url,
            target,
            now: cx.now,
            pinned_by: None,
            favorite_id: None,
        },
    );
    let next = kept::place_kept(&next, &id, &k.id, Side::Before, &k.space_id);
    let next = used(&next, &id, w.as_deref(), cx.now);
    cx.push(request);
    Ok((next, json!({ "tabId": id })))
}

/// LT:451 `muteTab`: the live item's sound toggled by the hosting.
fn mute_tab(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    cx.push(item_request("muteTab", cx.window_id(), k));
    Ok((s.clone(), json!({ "item": &*k.id })))
}

/// LT:460 `mediaControl`: the mini player's buttons for a web item's page (play or pause, previous, next) done by the
/// hosting; `focus` is `activateTab`, `mute` is `muteTab`.
fn media_control(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    let command = cx.str("command");
    match command {
        Some("focus") => return activate_tab(s, cx),
        Some("mute") => return mute_tab(s, cx),
        Some("toggle" | "prev" | "next") => {}
        _ => return refuse("not a media command"),
    }
    if !matches!(TargetView::of(&k.target), TargetView::Web { .. }) {
        return refuse("only a web item plays in the mini player");
    }
    let mut request = item_request("mediaControl", cx.window_id(), k);
    if let Value::Object(o) = &mut request {
        o.insert("command".into(), Value::from(command));
    }
    cx.push(request);
    Ok((s.clone(), json!({ "item": &*k.id })))
}

/// LT:474 `itemClosed`: its page closed outside Margin: archived as `closeTab` archives it, nothing asked.
fn item_closed(s: &LibState, cx: &mut Cx) -> Done {
    if item_of(s, cx.get("tabId")).is_none() {
        return refuse("no such item");
    }
    let archive_id = cx.ids.other("a");
    done(archive_item(s, cx.arg("tabId"), &archive_id, cx.now)?)
}

/// LT:479 `removeItem`: gone without a trace (not archived).
fn remove_item(s: &LibState, cx: &mut Cx) -> Done {
    if item_of(s, cx.get("tabId")).is_none() {
        return refuse("no such item");
    }
    done(kept::forget_kept(s, cx.arg("tabId")))
}

/// LT:483 `moveTabToSpace`: the item into another space.
fn move_tab_to_space(s: &LibState, cx: &mut Cx) -> Done {
    let space_id = given_space(s, cx.get("spaceId"));
    let (Some(_), Some(space_id), Some(tab_id)) = (item_of(s, cx.get("tabId")), space_id, cx.get("tabId")) else {
        return refuse("no such item or space");
    };
    done(kept::move_tab(s, &js::to_string(tab_id), space_id))
}

/// LT:488 `moveTab`: dragged in the list beside another item (`before`: above); whether its place changed.
fn move_tab(s: &LibState, cx: &mut Cx) -> Done {
    let k = item_of(s, cx.get("tabId"));
    let side = match cx.str("side") {
        Some("before") => Some(Side::Before),
        Some("after") => Some(Side::After),
        _ => None,
    };
    let (Some(k), Some(next_to), Some(side)) = (k, cx.str("nextTo"), side) else { return refuse("no such item") };
    let next = kept::place_kept(s, &k.id, next_to, side, &k.space_id);
    let moved = next.kept.get(&k.id).is_none_or(|n| n.order != k.order);
    Ok((next, Value::Bool(moved)))
}

/// LT:495 `clearToday`: the window's space's items to the archive (in their ids' order); the hosting closes their pages.
fn clear_today(s: &LibState, cx: &mut Cx) -> Done {
    let Some(space_id) = some_id(window_space(s, cx.win().as_deref())) else { return Ok((s.clone(), json!([]))) };
    let mut closing: Vec<&Str> = s.kept.values().filter(|k| *k.space_id == *space_id).map(|k| &k.id).collect();
    closing.sort_by(|a, b| js::cmp16(a, b));
    let mut next = s.clone();
    for id in &closing {
        let archive_id = cx.ids.other("a");
        next = archive_item(&next, Arg::Str(id), &archive_id, cx.now)?;
    }
    let items: Vec<&str> = closing.iter().map(|x| &***x).collect();
    if !items.is_empty() {
        cx.push(json!({ "type": "clearToday", "windowId": cx.window_id(), "spaceId": space_id, "items": &items }));
    }
    Ok((next, json!(items)))
}

/// LT:503 `restoreArchive`: an archive entry back as an item of its space (else the window's), shown.
fn restore_archive(s: &LibState, cx: &mut Cx) -> Done {
    let archive_id = cx.str("archiveId");
    restore_entry(s, archive_id, cx)
}

/// LT:503's body for an entry's id (`p.archiveId`, or LT:524's `entry.id`).
fn restore_entry(s: &LibState, archive_id: Option<&str>, cx: &mut Cx) -> Done {
    let Some(entry) = archive_id.and_then(|id| s.archive.iter().find(|a| *a.id == *id)) else {
        return refuse("no such entry");
    };
    let w = cx.win();
    let space_id = Some(&*entry.space_id).filter(|id| has_space(s, id)).or_else(|| window_space(s, w.as_deref()));
    let Some(space_id) = some_id(space_id) else { return refuse("no space") };
    let id = cx.ids.tab();
    let target = entry.target.as_ref().map_or_else(|| space_target(s, space_id), checked_target);
    let request = json!({
        "type": "restoreArchive", "windowId": cx.window_id(), "item": &id, "url": &*entry.url,
        "target": target_json(&target), "spaceId": space_id,
    });
    let next = add_item(
        &kept::remove_archived(s, &entry.id),
        &id,
        NewItem {
            space_id,
            url: &entry.url,
            title: &entry.title,
            icon: &entry.fav_icon_url,
            target,
            now: cx.now,
            pinned_by: None,
            favorite_id: None,
        },
    );
    let next = used(&next, &id, w.as_deref(), cx.now);
    cx.push(request);
    Ok((next, json!({ "tabId": id })))
}

/// LT:516 `restoreLastArchive` (⇧⌘T): the space's newest archive entry back (else the newest of all).
fn restore_last_archive(s: &LibState, cx: &mut Cx) -> Done {
    let space_id = some_id(window_space(s, cx.win().as_deref()));
    let entry = space_id.and_then(|sp| s.archive.iter().find(|a| *a.space_id == *sp)).or_else(|| s.archive.first());
    let Some(entry) = entry else { return done(s.clone()) };
    restore_entry(s, Some(&entry.id), cx)
}

// ---- pins (LT:527-582) -------------------------------------------------------------------------------------------------

/// LT:527 `pinTab`: an item pinned in its space (the item stays, the pin's tab); the pin's id, or null when the space
/// has a pin at its address.
fn pin_tab(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    let id = cx.ids.other("p");
    let next = pin_of_item(s, k, &id, cx.arg("folderId").or_null(), cx.arg("beforeId").or_null());
    if next.same(s) { done(next) } else { Ok((next, json!(id))) }
}

/// LT:535 `unpin`: the pin gone; its item stays, unbound.
fn unpin(s: &LibState, cx: &mut Cx) -> Done {
    let Some(pin) = cx.str("pinId").and_then(|id| s.pins.iter().find(|x| *x.id == *id)) else {
        return refuse("no such pin");
    };
    cx.push(json!({
        "type": "unpin", "pin": &*pin.id, "url": &*pin.url, "target": target_of_json(pin.target.as_ref()),
        "spaceId": &*pin.space_id,
    }));
    done(order::remove_pin(s, &pin.id))
}

/// The pin's item in its space: the one bound to it, else one at its address no other pin or favorite has (LT:546,
/// 562).
fn pin_item<'s>(s: &'s LibState, pin: &Pin) -> Option<&'s Rc<Item>> {
    let bound = s.kept.values().find(|k| k.pinned_by.as_deref() == Some(&*pin.id) && *k.space_id == *pin.space_id);
    bound.or_else(|| {
        kept::kept_for_url(s, &pin.url, &pin.space_id, Some(ForWhom { pin_id: Some(&pin.id), favorite_id: None }))
    })
}

/// LT:542 `openPin`: shown in the window: its item (bound to it now), else the hosting opens it.
fn open_pin(s: &LibState, cx: &mut Cx) -> Done {
    let Some(pin) = cx.str("pinId").and_then(|id| s.pins.iter().find(|x| *x.id == *id)) else {
        return refuse("no such pin");
    };
    let w = cx.win();
    let item = pin_item(s, pin);
    let mut next = match &w {
        Some(w) => spaces::set_active_space(s, w, &pin.space_id),
        None => s.clone(),
    };
    if let Some(item) = item {
        if item.pinned_by.as_deref() != Some(&*pin.id) {
            next = order::bind_tab_to_pin(&next, &item.id, Some(&pin.id));
        }
        next = used(&next, &item.id, w.as_deref(), cx.now);
    }
    cx.push(json!({
        "type": "openPin", "windowId": cx.window_id(), "pin": &*pin.id, "item": item.map(|k| &*k.id),
        "url": item.map_or(&*pin.url, |k| &*k.url), "target": target_of_json(pin.target.as_ref()),
        "spaceId": &*pin.space_id,
    }));
    Ok((next, json!({ "pin": &*pin.id, "item": item.map(|k| &*k.id) })))
}

/// LT:558 `resetPin`: a drifted pin's item back at the pin's address (and title), shown.
fn reset_pin(s: &LibState, cx: &mut Cx) -> Done {
    let Some(pin) = cx.str("pinId").and_then(|id| s.pins.iter().find(|x| *x.id == *id)) else {
        return refuse("no such pin");
    };
    let w = cx.win();
    let item = pin_item(s, pin);
    let mut next = match &w {
        Some(w) => spaces::set_active_space(s, w, &pin.space_id),
        None => s.clone(),
    };
    if let Some(item) = item {
        next = reset_to(&next, &item.id, &pin.url, &pin.title);
        next = used(&next, &item.id, w.as_deref(), cx.now);
    }
    cx.push(json!({
        "type": "resetPin", "windowId": cx.window_id(), "pin": &*pin.id, "item": item.map(|k| &*k.id),
        "url": &*pin.url, "target": target_of_json(pin.target.as_ref()), "spaceId": &*pin.space_id,
    }));
    Ok((next, json!({ "pin": &*pin.id, "item": item.map(|k| &*k.id) })))
}

/// `{ ...k, url, title: title || k.title }` for the item `id` (LT:566, 633).
fn reset_to(s: &LibState, id: &str, url: &Str, title: &Str) -> LibState {
    let Some(k) = s.kept.get(id) else { return s.clone() };
    let title = if title.is_empty() { k.title.clone() } else { title.clone() };
    let mut next = s.clone();
    Rc::make_mut(&mut next.kept).insert(id.into(), Rc::new(Item { url: url.clone(), title, ..(**k).clone() }));
    next
}

/// LT:572 `renamePin`.
fn rename_pin(s: &LibState, cx: &mut Cx) -> Done {
    let Some(id) = cx.str("pinId").filter(|id| s.pins.iter().any(|x| *x.id == **id)) else {
        return refuse("no such pin");
    };
    done(order::rename_pin(s, id, or_empty(cx.arg("title"))))
}

/// LT:576 `renameTab`.
fn rename_tab(s: &LibState, cx: &mut Cx) -> Done {
    if item_of(s, cx.get("tabId")).is_none() {
        return refuse("no such item");
    }
    done(order::rename_tab(s, cx.arg("tabId"), or_empty(cx.arg("title"))))
}

/// LT:580 `movePin`.
fn move_pin(s: &LibState, cx: &mut Cx) -> Done {
    done(order::move_pin(s, cx.arg("pinId"), cx.arg("folderId").or_null(), cx.arg("beforeId").or_null()))
}

// ---- favorites (LT:584-646) --------------------------------------------------------------------------------------------

/// LT:584 `addFavorite`: an item, a pin (no longer one) or an address as a favorite of the scope the window shows; its
/// id, or null when the scope can't take it.
fn add_favorite(s: &LibState, cx: &mut Cx) -> Done {
    let k = cx.str("tabId").and_then(|id| s.kept.get(id));
    let pin = match (k, cx.str("pinId")) {
        (None, Some(id)) => s.pins.iter().find(|x| *x.id == *id),
        _ => None,
    };
    let w = cx.win();
    let space_id: Option<&str> = match (k, pin) {
        (Some(k), _) => Some(&k.space_id),
        (None, Some(x)) => Some(&x.space_id),
        _ => window_space(s, w.as_deref()),
    };
    // (The setting `favoritesScope` as the app gives it; the space the window shows, else the item's.)
    let shown = w.as_deref().and_then(|w| s.windows.get(w)).filter(|id| has_space(s, id)).map(|id| &**id).or(space_id);
    let scope = favorites::favorite_scope_of(s, shown, cx.str("favoritesScope") == Some("profile"));
    let target = match (k, pin) {
        (Some(k), _) => target_of_item(k),
        (None, Some(x)) => x.target.as_ref().map_or_else(LibTarget::safari, checked_target),
        _ => target_of(cx.get("target")).unwrap_or_else(|| match some_id(space_id) {
            Some(sp) => space_target(s, sp),
            None => LibTarget::safari(),
        }),
    };
    let (url, title, custom): (&str, &str, Option<&str>) = match (k, pin) {
        (Some(k), _) => (&k.url, &k.title, k.custom_title.as_deref()),
        (None, Some(x)) => (&x.url, &x.title, x.custom_title.as_deref()),
        _ => (str_of(cx.get("url"), TEXT_MAX), str_of(cx.get("title"), TEXT_MAX), None),
    };
    if url.is_empty() {
        return refuse("no address");
    }
    let id = cx.ids.other("fav");
    let next = favorites::add_favorite(
        s,
        NewFavorite {
            id: &id,
            scope: &scope,
            url,
            title,
            custom_title: custom,
            target: Some(target),
            before_id: cx.arg("beforeId").or_null(),
        },
    );
    if next.same(s) {
        return done(next);
    }
    let next = match k {
        Some(k) => favorites::bind_tab_to_favorite(&next, &k.id, &id),
        None => next,
    };
    let next = match pin {
        Some(x) => order::remove_pin(&next, &x.id),
        None => next,
    };
    Ok((next, json!(id)))
}

/// `(s.favorites ?? []).find((x) => x.id === p?.favoriteId)`.
fn favorite_of<'s>(s: &'s LibState, cx: &Cx) -> Option<&'s Rc<Favorite>> {
    cx.str("favoriteId").and_then(|id| s.favorites.iter().find(|f| *f.id == *id))
}

/// LT:606 `removeFavorite`.
fn remove_favorite(s: &LibState, cx: &mut Cx) -> Done {
    let Some(fav) = favorite_of(s, cx) else { return refuse("no such favorite") };
    done(favorites::remove_favorite(s, &fav.id))
}

/// The target an opened or reset favorite's request names (LT:622, 636): its own, else the space's.
fn favorite_target(s: &LibState, t: Option<&LibTarget>, space_id: Option<&str>) -> LibTarget {
    match t {
        Some(t) => checked_target(t),
        None => some_id(space_id).map_or_else(LibTarget::safari, |sp| space_target(s, sp)),
    }
}

/// LT:610 `openFavorite`: its item (the one used last), else one at its address no pin or other favorite has (bound to
/// it now), used; the hosting shows it or opens the address.
fn open_favorite(s: &LibState, cx: &mut Cx) -> Done {
    let Some(fav) = favorite_of(s, cx) else { return refuse("no such favorite") };
    let space_id = window_space(s, cx.win().as_deref());
    let bound = favorites::kept_of_favorite(s, &fav.id, cx.compare).first().copied();
    let item = bound.or_else(|| {
        let key = js::normalize_url(&fav.url);
        s.kept
            .values()
            .find(|k| js::normalize_url(&k.url) == key && !bound_elsewhere(s, k, &k.space_id, None, Some(&fav.id)))
    });
    let mut next = s.clone();
    if let Some(item) = item {
        if item.favorite_id.as_deref() != Some(&*fav.id) {
            next = favorites::bind_tab_to_favorite(&next, &item.id, &fav.id);
        }
        next = used(&next, &item.id, None, cx.now);
    }
    cx.push(json!({
        "type": "openFavorite", "windowId": cx.window_id(), "favorite": &*fav.id, "item": item.map(|k| &*k.id),
        "url": item.map_or(&*fav.url, |k| &*k.url),
        "target": target_json(&favorite_target(s, fav.target.as_ref(), space_id)), "spaceId": space_id,
    }));
    Ok((next, json!({ "favorite": &*fav.id, "item": item.map(|k| &*k.id) })))
}

/// LT:626 `resetFavorite`: its item back at the favorite's address (and title), used.
fn reset_favorite(s: &LibState, cx: &mut Cx) -> Done {
    let Some(fav) = favorite_of(s, cx) else { return refuse("no such favorite") };
    let space_id = window_space(s, cx.win().as_deref());
    let item = favorites::kept_of_favorite(s, &fav.id, cx.compare).first().copied();
    let mut next = s.clone();
    if let Some(item) = item {
        next = reset_to(&next, &item.id, &fav.url, &fav.title);
        next = used(&next, &item.id, None, cx.now);
    }
    cx.push(json!({
        "type": "resetFavorite", "windowId": cx.window_id(), "favorite": &*fav.id, "item": item.map(|k| &*k.id),
        "url": &*fav.url, "target": target_json(&favorite_target(s, fav.target.as_ref(), space_id)),
        "spaceId": space_id,
    }));
    Ok((next, json!({ "favorite": &*fav.id, "item": item.map(|k| &*k.id) })))
}

/// LT:640 `renameFavorite`.
fn rename_favorite(s: &LibState, cx: &mut Cx) -> Done {
    let Some(fav) = favorite_of(s, cx) else { return refuse("no such favorite") };
    done(favorites::rename_favorite(s, &fav.id, or_empty(cx.arg("title"))))
}

/// LT:644 `moveFavorite`.
fn move_favorite(s: &LibState, cx: &mut Cx) -> Done {
    done(favorites::move_favorite(s, cx.arg("favoriteId"), cx.arg("beforeId").or_null()))
}

// ---- link rules (LT:648-671) -------------------------------------------------------------------------------------------

/// LT:648 `addAirTrafficRule`: a rule sending the pattern's pages to the space (else the window's); its id.
fn add_air_traffic_rule(s: &LibState, cx: &mut Cx) -> Done {
    let space_id = given_space(s, cx.get("spaceId")).or_else(|| window_space(s, cx.win().as_deref()));
    let Some(space_id) = some_id(space_id) else { return refuse("no space") };
    let id = cx.ids.other("atc");
    let enabled = cx.get("enabled") != Some(&Value::Bool(false));
    let next = links::add_air_traffic_rule(s, &id, str_of(cx.get("pattern"), 200), space_id, enabled);
    if next.same(s) {
        return refuse("bad pattern");
    }
    Ok((next, json!(id)))
}

/// LT:656 `removeAirTrafficRule`.
fn remove_air_traffic_rule(s: &LibState, cx: &mut Cx) -> Done {
    done(links::remove_air_traffic_rule(s, str_of(cx.get("ruleId"), 128)))
}

/// LT:659 `toggleAirTrafficRule`.
fn toggle_air_traffic_rule(s: &LibState, cx: &mut Cx) -> Done {
    let enabled = cx.get("enabled").and_then(Value::as_bool);
    done(links::toggle_air_traffic_rule(s, str_of(cx.get("ruleId"), 128), enabled))
}

/// LT:662 `routeUrl`: the link rule an address matches (parsed as the browsers parse it, `js::RULES_PARSE_URLS`), and
/// the target its space opens it in.
fn route_url(s: &LibState, cx: &mut Cx) -> Done {
    let url = str_of(cx.get("url"), TEXT_MAX);
    let Some(rule) = links::match_air_traffic_rule(url, &s.air_traffic, Some(&s.spaces)) else {
        return done(s.clone());
    };
    let result = json!({
        "ruleId": &*rule.id, "pattern": &*rule.pattern, "spaceId": &*rule.space_id,
        "target": target_json(&space_target(s, &rule.space_id)),
    });
    Ok((s.clone(), result))
}

// ---- split view (LT:673-778) -------------------------------------------------------------------------------------------

/// LT:673 `createSplit`: a split of the payload's items (2-4 of one space), shown with its last pane (or `focus`)
/// focused.
fn create_split(s: &LibState, cx: &mut Cx) -> Done {
    let raw: Vec<&str> = cx.get("panes").and_then(Value::as_array).map_or_else(Vec::new, |list| {
        list.iter().filter_map(Value::as_str).filter(|x| s.kept.contains_key(x)).collect()
    });
    let space_id = cx.get("spaceId");
    let focus = cx.str("focus");
    split_of_items(s, &raw, space_id.and_then(Value::as_str), focus, cx)
}

/// LT:673's body for the panes given (the payload's, or LT:713's two), the space asked for and the pane to focus.
fn split_of_items(s: &LibState, raw: &[&str], space_id: Option<&str>, focus: Option<&str>, cx: &mut Cx) -> Done {
    if raw.len() < 2 {
        return refuse("need at least 2 items");
    }
    let space_id: Str = match space_id.filter(|id| has_space(s, id)) {
        Some(id) => id.into(),
        None => match s.kept.get(raw[0]) {
            Some(k) => k.space_id.clone(),
            None => return refuse("need at least 2 items"),
        },
    };
    if let Some(why) = split_refusal(s, &[], raw, &space_id) {
        return Err(Fail::Refused(why));
    }
    let id = cx.ids.other("spv");
    let axis = if cx.str("axis") == Some("vertical") { Axis::Vertical } else { Axis::Horizontal };
    let ratios = cx.get("ratios").and_then(Value::as_array).map(Vec::as_slice);
    let next = splits::create_split(s, &id, &space_id, raw, axis, ratios);
    let Some(group) = next.splits.iter().find(|g| *g.id == *id).cloned() else { return refuse("not a split") };
    let focus: Str = match focus.filter(|f| group.panes.iter().any(|x| **x == **f)) {
        Some(f) => f.into(),
        None => match group.panes.last() {
            Some(last) => last.clone(),
            None => return refuse("not a split"),
        },
    };
    let next = used(&next, &focus, cx.win().as_deref(), cx.now);
    let request = split_shown(&next, &group, Some(&focus), cx);
    cx.push(request);
    Ok((next, json!({ "splitId": id })))
}

/// LT:691 `addToSplit`: the item into the split of the item in front of its space (`nextTo`: that item; `splitId`: that
/// split), or a new split of the two; a pane already: the split shown, it focused.
fn add_to_split(s: &LibState, cx: &mut Cx) -> Done {
    let Some(k) = item_of(s, cx.get("tabId")) else { return refuse("no such item") };
    let w = cx.win();
    let given = cx.str("nextTo").filter(|x| *x != &*k.id).and_then(|x| s.kept.get(x));
    let front = given.or_else(|| front_of(s, &k.space_id, Some(&k.id), cx));
    let existing = cx
        .str("splitId")
        .and_then(|id| s.splits.iter().find(|g| *g.id == *id))
        .or_else(|| front.and_then(|f| splits::split_for_item(s, &f.id)));
    if let Some(existing) = existing {
        if existing.panes.iter().any(|x| *x == k.id) {
            let request = split_shown(s, existing, Some(&k.id), cx);
            cx.push(request);
            return Ok((used(s, &k.id, w.as_deref(), cx.now), json!({ "splitId": &*existing.id })));
        }
        if let Some(why) = split_refusal(s, &existing.panes, &[&k.id], &existing.space_id) {
            return Err(Fail::Refused(why));
        }
        let next = splits::add_to_split(s, &existing.id, &k.id);
        let group = next.splits.iter().find(|g| *g.id == *existing.id).cloned();
        let Some(group) = group.filter(|g| g.panes.iter().any(|x| *x == k.id)) else { return refuse("not added") };
        let request = split_shown(&next, &group, Some(&k.id), cx);
        cx.push(request);
        return Ok((used(&next, &k.id, w.as_deref(), cx.now), json!({ "splitId": &*existing.id })));
    }
    let Some(front) = front else { return refuse("no second item to split with") };
    // (`ACTIONS.createSplit({ p: { ...p, panes: [front.id, k.id], spaceId: k.spaceId, focus: k.id } })`.)
    split_of_items(s, &[&front.id, &k.id], Some(&k.space_id), Some(&k.id), cx)
}

/// LT:715 `openSplit`: the split shown, `focus` (else its first pane with an item) focused.
fn open_split(s: &LibState, cx: &mut Cx) -> Done {
    let Some(group) = cx.str("splitId").and_then(|id| s.splits.iter().find(|g| *g.id == *id)) else {
        return refuse("no such split");
    };
    let Some(first) = group.panes.iter().find(|x| s.kept.contains_key(x)) else {
        return refuse("split has no items");
    };
    let focus: &str = cx.str("focus").filter(|f| group.panes.iter().any(|x| **x == **f)).unwrap_or(first);
    let next = used(s, focus, cx.win().as_deref(), cx.now);
    let request = split_shown(&next, group, Some(focus), cx);
    cx.push(request);
    Ok((next, json!({ "splitId": &*group.id })))
}

/// LT:726 `breakOutSplit`: the item out of its split, shown alone.
fn break_out_split(s: &LibState, cx: &mut Cx) -> Done {
    let group = splits::split_for_value(s, cx.get("tabId"));
    let (Some(group), Some(k)) = (group, item_of(s, cx.get("tabId"))) else { return done(s.clone()) };
    let next = used(&splits::remove_from_split(s, &group.id, &k.id), &k.id, cx.win().as_deref(), cx.now);
    cx.push(item_request("activateTab", cx.window_id(), k));
    done(next)
}

/// LT:737 `removeFromSplit`: the item out of its split, the rest shown (`focus` when it's one of the rest, else its
/// next pane; one left: that one, alone).
fn remove_from_split(s: &LibState, cx: &mut Cx) -> Done {
    let group = splits::split_for_value(s, cx.get("tabId"));
    let (Some(group), Some(k)) = (group, item_of(s, cx.get("tabId"))) else { return done(s.clone()) };
    let kept_focus = cx
        .str("focus")
        .filter(|f| *f != &*k.id && group.panes.iter().any(|x| **x == **f) && s.kept.contains_key(f))
        .map(Str::from);
    let after = kept_focus.or_else(|| split_next(s, &k.id));
    let mut next = splits::remove_from_split(s, &group.id, &k.id);
    let left = next.splits.iter().find(|g| *g.id == *group.id).cloned();
    if let Some(after) = some_id(after.as_deref()).filter(|a| next.kept.contains_key(a)) {
        next = used(&next, after, cx.win().as_deref(), cx.now);
        let request = match &left {
            Some(left) => split_shown(&next, left, Some(after), cx),
            None => match next.kept.get(after) {
                Some(a) => item_request("activateTab", cx.window_id(), a),
                None => Value::Null,
            },
        };
        cx.push(request);
    }
    done(next)
}

/// The first split with the payload's `splitId`.
fn split_given<'s>(s: &'s LibState, cx: &Cx) -> Option<&'s Rc<Split>> {
    cx.str("splitId").and_then(|id| s.splits.iter().find(|g| *g.id == *id))
}

/// LT:755 `swapSplit`: two panes trade places (`a`, `b`: integers, else 0 and 1); shown again when they did.
fn swap_split(s: &LibState, cx: &mut Cx) -> Done {
    let Some(group) = split_given(s, cx) else { return refuse("no such split") };
    // (`Number.isInteger(p?.a) ? p.a : 0`.)
    let int = |v: Option<&Value>, or: f64| js::finite(v).filter(|n| n.fract() == 0.0).unwrap_or(or);
    let next = splits::swap_split_panes(s, &group.id, int(cx.get("a"), 0.0), int(cx.get("b"), 1.0));
    if !next.same(s) {
        if let Some(after) = next.splits.iter().find(|g| *g.id == *group.id) {
            let request = split_shown(&next, after, None, cx);
            cx.push(request);
        }
    }
    done(next)
}

/// LT:765 `resizeSplit`: the panes' ratios as dragged (nothing asked: the page placed them).
fn resize_split(s: &LibState, cx: &mut Cx) -> Done {
    let Some(group) = split_given(s, cx) else { return refuse("no such split") };
    done(splits::resize_split(s, &group.id, cx.get("ratios").and_then(Value::as_array).map(Vec::as_slice)))
}

/// LT:770 `toggleSplitAxis`: side by side ↔ stacked, shown again.
fn toggle_split_axis(s: &LibState, cx: &mut Cx) -> Done {
    let Some(group) = split_given(s, cx) else { return refuse("no such split") };
    let next = splits::toggle_split_axis(s, &group.id);
    if let Some(after) = next.splits.iter().find(|g| *g.id == *group.id) {
        let request = split_shown(&next, after, None, cx);
        cx.push(request);
    }
    done(next)
}

// ---- folders and windows (LT:780-806) ----------------------------------------------------------------------------------

/// LT:780 `createFolder`: a folder in the space (`spaceId`, else the parent's, the item's, the window's) holding
/// `pinIds`, or the item `tabId` pinned into it; its id, or null when none was made.
fn create_folder(s: &LibState, cx: &mut Cx) -> Done {
    let id = cx.ids.other("f");
    let k = cx.str("tabId").and_then(|t| s.kept.get(t));
    let parent = cx.str("parentId").and_then(|f| s.folders.iter().find(|x| *x.id == *f));
    let space_id: Option<&str> = match (given_space(s, cx.get("spaceId")), parent, k) {
        (Some(id), _, _) => Some(id),
        (None, Some(f), _) => Some(&f.space_id),
        (None, None, Some(k)) => Some(&k.space_id),
        _ => window_space(s, cx.win().as_deref()),
    };
    let Some(space_id) = some_id(space_id) else { return refuse("no space") };
    let pin_ids: Vec<&str> = cx
        .get("pinIds")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |l| l.iter().filter_map(Value::as_str).collect());
    let first = pin_ids.first().and_then(|f| s.pins.iter().find(|x| *x.id == **f && *x.space_id == *space_id));
    let loose = first.filter(|f| f.folder_id.as_deref().is_none_or(str::is_empty)).map(|f| &*f.id);
    let before = if cx.arg("beforeId").nullish() { Arg::from(loose) } else { cx.arg("beforeId") };
    let mut next = order::create_folder(s, &id, space_id, cx.arg("name"), &pin_ids, parent.map(|f| &*f.id), before);
    if let Some(k) = k {
        if !next.same(s) {
            let pin_id = cx.ids.other("p");
            next = pin_of_item(&next, k, &pin_id, Arg::Str(&id), Arg::Value(&Value::Null));
        }
    }
    if next.same(s) { done(next) } else { Ok((next, json!(id))) }
}

/// LT:800 `forgetWindow`: a Margin window closed for good: its space forgotten.
fn forget_window(s: &LibState, cx: &mut Cx) -> Done {
    let Some(w) = cx.win().filter(|w| s.windows.contains_key(w)) else { return done(s.clone()) };
    let mut next = s.clone();
    Rc::make_mut(&mut next.windows).remove(&w);
    done(next)
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
