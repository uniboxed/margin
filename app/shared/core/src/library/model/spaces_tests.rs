// model/spaces.rs against model.ts (M:1087-1155, 1422-1455), read line by line: the spaces' rules and deleteSpace's
// cascade; then the shared vectors' steps of every action library.ts answers with piece 1's rules alone (spaces, pins,
// folders: this file's and order.rs's), as JavaScriptCore answered them.

use super::*;
use crate::library::js::{CodePointOrder, Collation, Ids};
use crate::library::model::Arg;
use crate::library::model::order;
use crate::library::state::{Item, Pin, state_of};
use crate::library::values::{diff, values_of};
use crate::library::vectors;
use serde_json::{Map, Value, json};

fn lib(v: Value) -> LibState {
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

fn space_ids(s: &LibState) -> Vec<&str> {
    s.spaces.iter().map(|sp| &*sp.id).collect()
}

fn three() -> LibState {
    lib(json!({
        "spaces": {
            "a": { "name": "A", "emoji": "🅰", "color": "red", "order": 0, "theme": "pixel" },
            "b": { "name": "B", "order": 1 }, "c": { "name": "C", "order": 2 },
        },
        "windows": { "10": { "spaceId": "a" }, "2": { "spaceId": "b" } },
    }))
}

#[test]
fn set_active_space_keeps_js_key_order() {
    let s = three();
    assert!(set_active_space(&s, "7", "zz").same(&s), "no such space");
    let next = set_active_space(&s, "7", "c");
    assert_eq!(
        next.windows.iter().map(|(w, sp)| (&**w, &**sp)).collect::<Vec<_>>(),
        [("2", "b"), ("7", "c"), ("10", "a")]
    );
    let next = set_active_space(&next, "w", "a");
    assert_eq!(next.windows.keys().map(|k| &**k).collect::<Vec<_>>(), ["2", "7", "10", "w"]);
    let next = set_active_space(&set_active_space(&next, "v", "a"), "w", "b");
    assert_eq!(next.windows.keys().map(|k| &**k).collect::<Vec<_>>(), ["2", "7", "10", "w", "v"], "w kept its place");
    let again = set_active_space(&s, "2", "b");
    assert!(!again.same(&s) && again == s, "made anew though equal, as M's spread");
}

#[test]
fn creating_a_space() {
    let s = three();
    let (null, zero, five, obj) = (json!(null), json!(0), json!(5), json!({}));
    let next =
        create_space(&s, "n", Arg::Str("  Work \u{feff}"), Arg::Undefined, Arg::Value(&zero), Some("arcadia")).unwrap();
    let n = next.spaces.last().unwrap();
    assert_eq!(
        (&*n.id, &*n.name, &*n.emoji, &*n.color, n.theme.as_deref(), &*n.browser, n.profile.as_deref()),
        ("n", "Work", "✨", "#00b894", Some("arcadia"), "safari", None)
    );
    assert_eq!(space_ids(&next), ["a", "b", "c", "n"]);
    let n = create_space(&s, "n", Arg::Value(&null), Arg::Str(" e "), Arg::Str(""), Some("Pixel")).unwrap();
    let n = n.spaces.last().unwrap();
    assert_eq!((&*n.name, &*n.emoji, &*n.color, n.theme.as_deref()), ("New space", " e ", "#00b894", None));
    assert_eq!(
        &*create_space(&s, "n", Arg::Str(" \t"), Arg::Undefined, Arg::Undefined, None).unwrap().spaces[3].name,
        "New space"
    );
    for bad in [&five, &obj, &json!(true), &json!([])] {
        assert_eq!(
            create_space(&s, "n", Arg::Value(bad), Arg::Undefined, Arg::Undefined, None).err(),
            Some(CREATE_SPACE_NAME_THROWS)
        );
    }
    // A truthy emoji that's no string: JS stores it as given; the typed space holds what its next reading is.
    let n = create_space(&s, "n", Arg::Undefined, Arg::Value(&five), Arg::Value(&obj), None).unwrap();
    assert_eq!((&*n.spaces[3].emoji, &*n.spaces[3].color), ("", ""));
}

#[test]
fn ordering_spaces() {
    let s = three();
    assert!(order_spaces(&s, &["a", "b", "c"]).same(&s));
    assert!(order_spaces(&s, &[]).same(&s));
    assert!(order_spaces(&s, &["zz", "a"]).same(&s), "unknown ids rank nothing");
    assert_eq!(space_ids(&order_spaces(&s, &["c"])), ["c", "a", "b"], "the rest after, in their order");
    assert_eq!(space_ids(&order_spaces(&s, &["c", "b", "a", "c"])), ["b", "a", "c"], "twice: its last place");
    let next = order_spaces(&s, &["b", "a"]);
    assert!(Rc::ptr_eq(&next.spaces[1], &s.spaces[0]), "the spaces themselves, moved");
}

#[test]
fn updating_a_space() {
    let s = three();
    let (null, five) = (json!(null), json!(5));
    let next = update_space(&s, "a", Arg::Str(" New "), Arg::Str(" "), Arg::Value(&five), Arg::Undefined);
    let a = &next.spaces[0];
    assert_eq!((&*a.name, &*a.emoji, &*a.color, a.theme.as_deref()), ("New", "🅰", "red", Some("pixel")));
    assert!(Rc::ptr_eq(&next.spaces[1], &s.spaces[1]) && !Rc::ptr_eq(&next.spaces, &s.spaces));
    assert_eq!(
        update_space(&s, "a", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Value(&null)).spaces[0].theme,
        None
    );
    assert_eq!(
        update_space(&s, "a", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Str("Pixel")).spaces[0]
            .theme
            .as_deref(),
        Some("pixel")
    );
    assert_eq!(
        update_space(&s, "a", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Str("")).spaces[0].theme.as_deref(),
        Some("pixel")
    );
    assert_eq!(
        update_space(&s, "b", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Str("liquid-glass")).spaces[1]
            .theme
            .as_deref(),
        Some("liquid-glass")
    );
    let same = update_space(&s, "zz", Arg::Str("x"), Arg::Undefined, Arg::Undefined, Arg::Undefined);
    assert!(!same.same(&s) && same == s, "no such space: a new list all the same (M's map)");
}

/// Space `a` (deleted into `b`, the first left): its pins p1 (b has its address: dropped) and p2 (moved), its folder fa
/// (moved after b's own top level) holding p3; items bound to p1 (unbound) and to p2 (kept); an archive entry, a split, a
/// link rule, windows.
fn cascade() -> LibState {
    lib(json!({
        "spaces": { "b": { "name": "B", "order": 0 }, "a": { "name": "A", "order": 1 }, "c": { "name": "C", "order": 2 } },
        "pins": {
            "pb": { "spaceId": "b", "url": "https://one/", "pos": 0 },
            "p1": { "spaceId": "a", "url": "https://one/", "pos": 0 },
            "p2": { "spaceId": "a", "url": "https://two/", "pos": 2 },
            "p2b": { "spaceId": "a", "url": "https://two/", "pos": 3 },
            "p3": { "spaceId": "a", "url": "https://three/", "pos": 0, "folderId": "fa" },
            "pc": { "spaceId": "c", "url": "https://two/", "pos": 0 },
        },
        "folders": {
            "fb": { "spaceId": "b", "name": "F", "pos": 1 },
            "fa": { "spaceId": "a", "name": "F", "pos": 1 },
        },
        "tabs": {
            "t-1": { "url": "https://one/", "spaceId": "a", "pinnedBy": "p1" },
            "t-2": { "url": "https://two/", "spaceId": "a", "pinnedBy": "p2" },
            "t-3": { "url": "https://x/", "spaceId": "c" },
        },
        "archive": { "a-1": { "url": "https://old/", "spaceId": "a", "closedAt": 2 }, "a-2": { "url": "https://o/", "spaceId": "c", "closedAt": 1 } },
        "splits": { "spv-1": { "spaceId": "a", "panes": ["t-1", "t-2"] } },
        "airTraffic": { "atc-1": { "pattern": "a.com", "spaceId": "a" }, "atc-2": { "pattern": "c.com", "spaceId": "c" } },
        "windows": { "1": { "spaceId": "a" }, "2": { "spaceId": "c" } },
    }))
}

#[test]
fn delete_space_cascades_into_the_first_space_left() {
    let s = cascade();
    assert!(delete_space(&s, "zz").same(&s));
    let one = lib(json!({ "spaces": { "a": {} } }));
    assert!(delete_space(&one, "a").same(&one), "the last space");
    let next = delete_space(&s, "a");
    assert_eq!(space_ids(&next), ["b", "c"]);
    let pins: Vec<(&str, &str, Option<&str>, Option<f64>)> =
        next.pins.iter().map(|p| (&*p.id, &*p.space_id, p.folder_id.as_deref(), p.pos)).collect();
    assert_eq!(
        pins,
        [
            ("pb", "b", None, Some(0.0)),
            ("pc", "c", None, Some(0.0)),
            ("p2", "b", None, Some(3.0)),
            ("p3", "b", Some("fa"), Some(0.0)),
        ],
        "p1 (b has its address) and p2b (p2 took it) dropped; p2 after b's own and fa"
    );
    assert!(Rc::ptr_eq(&next.pins[1], &s.pins[5]), "another space's pin as it was");
    let folders: Vec<(&str, &str, Option<f64>)> = next.folders.iter().map(|f| (&*f.id, &*f.space_id, f.pos)).collect();
    assert_eq!(folders, [("fb", "b", Some(1.0)), ("fa", "b", Some(2.0))]);
    assert_eq!(order::pin_order(&next, "b", None).iter().map(|e| &*e.id).collect::<Vec<_>>(), ["pb", "fb", "fa", "p2"]);
    let k = |id: &str| next.kept.get(id).unwrap().clone();
    assert_eq!((&*k("t-1").space_id, k("t-1").pinned_by.as_deref()), ("b", None), "its pin dropped: unbound");
    assert_eq!((&*k("t-2").space_id, k("t-2").pinned_by.as_deref()), ("b", Some("p2")));
    assert!(Rc::ptr_eq(next.kept.get("t-3").unwrap(), s.kept.get("t-3").unwrap()));
    assert_eq!(next.archive.iter().map(|a| &*a.space_id).collect::<Vec<_>>(), ["b", "c"]);
    assert_eq!(&*next.splits[0].space_id, "b");
    assert_eq!(next.air_traffic.iter().map(|r| &*r.id).collect::<Vec<_>>(), ["atc-2"], "its link rules dropped");
    assert_eq!(next.windows.iter().map(|(w, sp)| (&**w, &**sp)).collect::<Vec<_>>(), [("1", "b"), ("2", "c")]);
    // None to move: the lists made anew all the same, but the link rules and splits when there are none.
    let bare = lib(json!({ "spaces": { "a": {}, "b": {} } }));
    let next = delete_space(&bare, "b");
    assert!(Rc::ptr_eq(&next.air_traffic, &bare.air_traffic) && Rc::ptr_eq(&next.splits, &bare.splits));
    assert!(!Rc::ptr_eq(&next.archive, &bare.archive));
}

// ---- the shared vectors ----------------------------------------------------------------------------------------------

/// The actions library.ts answers with piece 1's rules alone (LT:283-333, 573-581, 529-540, 792-797), written as
/// library.ts writes them; part 4 writes them for real. A step is skipped (`None`) when its action is another's, when a
/// space's emoji or colour is a truthy value that's no string (the typed space's known gap, counted in `gap`), when
/// `renameSpace` sets a profile (library.ts's own `setSpaceProfile`), and when `settleSplits` (piece 3's, run after
/// every success) would change the splits.
#[derive(Default)]
struct Piece1 {
    collation: Collation,
    gap: usize,
    unsettled: usize,
    answered: std::collections::BTreeMap<String, usize>,
}

fn win(p: &Map<String, Value>) -> Option<String> {
    match p.get("windowId") {
        Some(Value::Number(n)) => Some(crate::library::js::number_string(n.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn lt_has_space(s: &LibState, v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|id| has_space(s, id))
}

/// `settleSplits` changes nothing: every split's panes items of the library, none in an earlier split.
fn settled(s: &LibState) -> bool {
    let mut seen = std::collections::HashSet::new();
    s.splits.iter().all(|g| g.panes.iter().all(|p| s.kept.contains_key(p) && seen.insert(p.clone())))
}

/// LT:219 `pinOfItem(s, k, pinId, folderId, beforeId)`: the item pinned (addPin, its own name, its target, bound).
fn pin_of_item(s: &LibState, k: &Item, pin_id: &str, folder_id: Arg<'_>, before_id: Arg<'_>) -> LibState {
    let mut next = order::add_pin(s, pin_id, &k.space_id, &k.url, Some(&k.title), folder_id, before_id);
    if next.same(s) {
        return next;
    }
    if let Some(c) = k.custom_title.as_deref().filter(|c| !c.is_empty()) {
        next = order::rename_pin(&next, pin_id, Arg::Str(c));
    }
    for pin in Rc::make_mut(&mut next.pins).iter_mut() {
        if *pin.id == *pin_id {
            *pin = Rc::new(Pin { target: Some(k.target.clone()), ..(**pin).clone() });
        }
    }
    order::bind_tab_to_pin(&next, &k.id, Some(pin_id))
}

impl vectors::Engine for Piece1 {
    fn perform(
        &mut self,
        values: &Map<String, Value>,
        action: &str,
        payload: &Value,
        env: &vectors::Env,
    ) -> Option<Value> {
        let s = state_of(values, &self.collation);
        let empty = Map::new();
        let p = payload.as_object().unwrap_or(&empty);
        let a = |k: &str| Arg::of(p.get(k));
        let fail = |e: &str| json!({ "ok": false, "result": null, "error": e, "changes": [], "requests": [] });
        let mut ids = Ids::new(env.ids.clone());
        let mut result = Value::Null;
        let mut requests: Vec<Value> = Vec::new();
        let next = match action {
            "createSpace" => {
                let truthy_odd = |k: &str| a(k).truthy() && a(k).as_str().is_none();
                if truthy_odd("emoji") || truthy_odd("color") {
                    self.gap += 1;
                    return None;
                }
                let id = ids.other("sp");
                let w = win(p);
                let shown = w.as_deref().and_then(|w| s.windows.get(w)).filter(|sp| has_space(&s, sp)).cloned();
                let from_id = shown.or_else(|| s.spaces.first().map(|sp| sp.id.clone()));
                let from = from_id.and_then(|id| s.spaces.iter().find(|sp| sp.id == id).cloned());
                let browser = p
                    .get("browser")
                    .and_then(Value::as_str)
                    .filter(|b| crate::library::state::BROWSERS.contains(b))
                    .map(String::from)
                    .or_else(|| from.as_ref().map(|f| f.browser.to_string()))
                    .unwrap_or_else(|| "safari".into());
                let profile: Option<String> = if p.contains_key("profile") {
                    p.get("profile").and_then(Value::as_str).filter(|x| !x.is_empty()).map(String::from)
                } else {
                    from.as_ref().and_then(|f| f.profile.as_deref().map(String::from))
                };
                let theme = p
                    .get("theme")
                    .and_then(Value::as_str)
                    .filter(|t| crate::library::state::theme_id_ok(t))
                    .map(String::from)
                    .or_else(|| from.as_ref().and_then(|f| f.theme.as_deref().map(String::from)));
                let mut next = match create_space(&s, &id, a("name"), a("emoji"), a("color"), theme.as_deref()) {
                    Ok(n) => n,
                    Err(words) => return Some(fail(&format!("failed: {words}"))),
                };
                for sp in Rc::make_mut(&mut next.spaces).iter_mut() {
                    if *sp.id == *id {
                        *sp = Rc::new(Space {
                            browser: browser.as_str().into(),
                            profile: profile.as_deref().map(Into::into),
                            ..(**sp).clone()
                        });
                    }
                }
                if let Some(w) = &w {
                    next = set_active_space(&next, w, &id);
                }
                result = json!({ "spaceId": id });
                next
            }
            "renameSpace" => {
                if !lt_has_space(&s, p.get("spaceId")) {
                    return Some(fail("no such space"));
                }
                if p.contains_key("profile") {
                    return None;
                }
                let theme = if p.contains_key("theme") { a("theme") } else { Arg::Undefined };
                update_space(&s, p["spaceId"].as_str()?, a("name"), a("emoji"), a("color"), theme)
            }
            "setSpaceTheme" => {
                if !lt_has_space(&s, p.get("spaceId")) {
                    return Some(fail("no such space"));
                }
                let t = a("theme");
                if !t.is_null() && !t.as_str().is_some_and(crate::library::state::theme_id_ok) {
                    return Some(fail("not a theme id"));
                }
                update_space(&s, p["spaceId"].as_str()?, Arg::Undefined, Arg::Undefined, Arg::Undefined, t)
            }
            "deleteSpace" => {
                if !lt_has_space(&s, p.get("spaceId")) {
                    return Some(fail("no such space"));
                }
                if s.spaces.len() < 2 {
                    return Some(fail("the last space"));
                }
                let id = p["spaceId"].as_str()?;
                result = json!({ "into": &*s.spaces.iter().find(|sp| *sp.id != *id)?.id });
                delete_space(&s, id)
            }
            "orderSpaces" => {
                let Some(list) = p.get("spaceIds").and_then(Value::as_array) else { return Some(fail("no order")) };
                let ids: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
                order_spaces(&s, &ids)
            }
            "unpin" => {
                let Some(pin) = a("pinId").as_str().and_then(|id| s.pins.iter().find(|x| *x.id == *id)) else {
                    return Some(fail("no such pin"));
                };
                let target = pin.target.as_ref().map_or(Value::Null, |t| t.to_value());
                requests.push(json!({ "type": "unpin", "pin": &*pin.id, "url": &*pin.url, "target": target, "spaceId": &*pin.space_id }));
                order::remove_pin(&s, &pin.id)
            }
            "renamePin" => {
                let Some(id) = a("pinId").as_str().filter(|id| s.pins.iter().any(|x| *x.id == **id)) else {
                    return Some(fail("no such pin"));
                };
                order::rename_pin(&s, id, a("title"))
            }
            "renameTab" => {
                if !s.kept.contains_key(&crate::library::js::property_key(p.get("tabId"))) {
                    return Some(fail("no such item"));
                }
                order::rename_tab(&s, a("tabId"), a("title"))
            }
            "pinTab" => {
                let Some(k) = s.kept.get(&crate::library::js::property_key(p.get("tabId"))).cloned() else {
                    return Some(fail("no such item"));
                };
                let id = ids.other("p");
                let next = pin_of_item(&s, &k, &id, a("folderId").or_null(), a("beforeId").or_null());
                if !next.same(&s) {
                    result = json!(id);
                }
                next
            }
            "createFolder" => {
                let id = ids.other("f");
                let k = a("tabId").as_str().and_then(|t| s.kept.get(t)).cloned();
                let parent = a("parentId").as_str().and_then(|f| s.folders.iter().find(|x| *x.id == *f)).cloned();
                let space_id: Option<String> = if lt_has_space(&s, p.get("spaceId")) {
                    p["spaceId"].as_str().map(String::from)
                } else if let Some(f) = &parent {
                    Some(f.space_id.to_string())
                } else if let Some(k) = &k {
                    Some(k.space_id.to_string())
                } else {
                    let w = win(p);
                    let shown = w.as_deref().and_then(|w| s.windows.get(w)).filter(|sp| has_space(&s, sp)).cloned();
                    shown.or_else(|| s.spaces.first().map(|sp| sp.id.clone())).map(|x| x.to_string())
                };
                let Some(space_id) = space_id.filter(|x| !x.is_empty()) else { return Some(fail("no space")) };
                let pin_ids: Vec<&str> = p
                    .get("pinIds")
                    .and_then(Value::as_array)
                    .map_or_else(Vec::new, |l| l.iter().filter_map(Value::as_str).collect());
                let first =
                    pin_ids.first().and_then(|f| s.pins.iter().find(|x| *x.id == **f && *x.space_id == *space_id));
                let first_loose =
                    first.filter(|f| f.folder_id.as_deref().is_none_or(str::is_empty)).map(|f| f.id.clone());
                let before = if a("beforeId").nullish() { Arg::from(first_loose.as_deref()) } else { a("beforeId") };
                let mut next = order::create_folder(
                    &s,
                    &id,
                    &space_id,
                    a("name"),
                    &pin_ids,
                    parent.as_ref().map(|f| &*f.id),
                    before,
                );
                if let Some(k) = &k {
                    if !next.same(&s) {
                        let pin_id = ids.other("p");
                        next = pin_of_item(&next, k, &pin_id, Arg::Str(&id), Arg::Value(&Value::Null));
                    }
                }
                if !next.same(&s) {
                    result = json!(id);
                }
                next
            }
            "movePin" => order::move_pin(&s, a("pinId"), a("folderId").or_null(), a("beforeId").or_null()),
            "renameFolder" => order::rename_folder(&s, a("folderId"), a("name")),
            "setFolderOpen" => order::set_folder_open(&s, a("folderId"), a("open").truthy()),
            "deleteFolder" => order::delete_folder(&s, a("folderId")),
            "moveFolder" | "nestFolder" => {
                order::move_folder(&s, a("folderId"), a("parentId").or_null(), a("beforeId").or_null())
            }
            _ => return None,
        };
        if !settled(&next) {
            self.unsettled += 1;
            return None;
        }
        *self.answered.entry(action.into()).or_default() += 1;
        let changes: Vec<Value> = diff(&s, &next).iter().map(|c| c.to_json()).collect();
        Some(json!({ "ok": true, "result": result, "changes": changes, "requests": requests }))
    }
}

#[test]
fn the_shared_vectors_of_piece_1s_actions() {
    let mut engine = Piece1::default();
    let report = vectors::run(&mut engine);
    report.assert_ok();
    let checked = report.checked.get("perform").copied().unwrap_or(0);
    assert!(checked > 600, "{checked} perform steps checked");
    assert!(engine.gap > 0 && engine.gap < 40, "{} createSpace steps of the known gap", engine.gap);
    eprintln!(
        "piece 1's vectors: {checked} perform steps checked, {} skipped ({} of the gap, {} with splits to settle); successes {:?}",
        report.skipped.get("perform").copied().unwrap_or(0),
        engine.gap,
        engine.unsettled,
        engine.answered
    );
    let _ = values_of; // (the values' writer: used through `diff`)
}
