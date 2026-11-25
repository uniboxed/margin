// model/spaces.rs against model.ts (M:1087-1155, 1422-1455), read line by line: the spaces' rules and deleteSpace's
// cascade. The shared vectors' steps of the actions over them run through the real actions (actions_tests.rs).

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::model::Arg;
use crate::library::model::order;
use crate::library::state::state_of;
use serde_json::{Value, json};

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
    let next =
        update_space(&s, "a", Arg::Str(" New "), Arg::Str(" "), Arg::Value(&five), Arg::Undefined, Arg::Undefined);
    let a = &next.spaces[0];
    assert_eq!((&*a.name, &*a.emoji, &*a.color, a.theme.as_deref()), ("New", "🅰", "red", Some("pixel")));
    assert!(Rc::ptr_eq(&next.spaces[1], &s.spaces[1]) && !Rc::ptr_eq(&next.spaces, &s.spaces));
    assert_eq!(
        update_space(&s, "a", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Value(&null), Arg::Undefined).spaces
            [0]
        .theme,
        None
    );
    assert_eq!(
        update_space(&s, "a", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Str("Pixel"), Arg::Undefined).spaces
            [0]
        .theme
        .as_deref(),
        Some("pixel")
    );
    assert_eq!(
        update_space(&s, "a", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Str(""), Arg::Undefined).spaces[0]
            .theme
            .as_deref(),
        Some("pixel")
    );
    assert_eq!(
        update_space(&s, "b", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Str("liquid-glass"), Arg::Undefined)
            .spaces[1]
            .theme
            .as_deref(),
        Some("liquid-glass")
    );
    let same = update_space(&s, "zz", Arg::Str("x"), Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Undefined);
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

#[test]
fn a_space_s_background_set_cleared_or_kept() {
    let s = three();
    let set = |s: &LibState, b: Arg<'_>| {
        update_space(s, "a", Arg::Undefined, Arg::Undefined, Arg::Undefined, Arg::Undefined, b)
    };
    let given = json!({ "colors": ["#F7C7D3"], "amount": 0.47 });
    let next = set(&s, Arg::Value(&given));
    let b = next.spaces[0].background.clone().expect("an object: set");
    assert_eq!(
        (&*b.colors[0], b.amount, b.wheel, b.intensity),
        ("#f7c7d3", 0.45, "analogous", 0.5),
        "as background_of reads it"
    );
    assert_eq!(next.spaces[0].theme, s.spaces[0].theme, "the rest as it was");
    for keep in [json!("x"), json!(5), json!([{ "colors": ["#111111"] }]), json!(true)] {
        assert_eq!(set(&next, Arg::Value(&keep)).spaces[0].background, next.spaces[0].background, "{keep}: kept");
    }
    assert_eq!(set(&next, Arg::Undefined).spaces[0].background, next.spaces[0].background, "left out: kept");
    assert_eq!(set(&next, Arg::Str("{}")).spaces[0].background, next.spaces[0].background, "a string: kept");
    let (null, none) = (json!(null), json!({ "colors": ["nope"] }));
    assert_eq!(set(&next, Arg::Value(&null)).spaces[0].background, None, "null: none, the theme's own");
    assert_eq!(set(&next, Arg::Value(&none)).spaces[0].background, None, "an object with no colour or picture: none");
    let made = create_space(&next, "n", Arg::Str("N"), Arg::Undefined, Arg::Undefined, None).unwrap();
    assert_eq!(made.spaces[3].background, None, "a new space: none, whatever the others have");
}
