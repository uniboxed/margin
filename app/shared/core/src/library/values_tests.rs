// values.rs against library.ts: valuesOf over a state the model made (keys left out, targets not checked, numbers not
// finite: library.ts's answer recorded from Node, 2026-11-23), perform's diff (tests/library.test.ts's setSpace), the
// import's diff over values as stored. The generated libraries run against library.ts are counted in DECISIONS.md.

use std::rc::Rc;

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::state::{
    ArchiveEntry, Axis, Favorite, Folder, Imported, Item, JsObject, LibTarget, Pin, Rule, Space, Split, imports_of,
    state_of,
};
use serde_json::json;

fn s(v: &str) -> Str {
    v.into()
}

fn item(id: &str, space: &str) -> Item {
    Item {
        id: s(id),
        url: s("https://one/"),
        title: s("One"),
        fav_icon_url: s(""),
        space_id: s(space),
        order: 0.0,
        last_active: 0.0,
        was_active: false,
        kept_at: 0.0,
        why: s("library"),
        target: LibTarget::safari(),
        pinned_by: None,
        favorite_id: None,
        custom_title: None,
        imported: None,
    }
}

/// tests/../made.ts's state: what the model can hand valuesOf.
fn made() -> LibState {
    let space =
        |id: &str, name: &str, emoji: &str, color: &str, browser: &str, profile: Option<&str>, theme: Option<&str>| {
            Rc::new(Space {
                id: s(id),
                name: s(name),
                emoji: s(emoji),
                color: s(color),
                browser: s(browser),
                profile: profile.map(s),
                theme: theme.map(s),
                background: None,
            })
        };
    let kept: JsObject<Rc<Item>> = [
        Item {
            order: f64::NAN,
            last_active: 5.0,
            was_active: true,
            kept_at: 5.0,
            target: LibTarget::App { bundle_id: "x".repeat(300).into(), name: s("N") },
            pinned_by: Some(s("")),
            favorite_id: Some(s("f1")),
            custom_title: Some(s("C")),
            imported: Some(Imported { browser: s("safari"), profile: s("P"), id: s("t-9") }),
            ..item("t-1", "a")
        },
        Item {
            url: s("https://two/"),
            title: s("Two"),
            fav_icon_url: s("i"),
            order: 2.5,
            last_active: 1e21,
            target: LibTarget::web("edge", Some(&"p".repeat(300))),
            ..item("t-2", "b")
        },
    ]
    .into_iter()
    .map(|k| (k.id.clone(), Rc::new(k)))
    .collect();
    LibState {
        spaces: Rc::new(vec![
            space("b", "B", "✨", "#00b894", "safari", None, Some("Bad")),
            space("a", "A", "", "", "chrome", Some(""), None),
        ]),
        pins: Rc::new(vec![
            Rc::new(Pin {
                id: s("p1"),
                space_id: s("a"),
                url: s("https://x/"),
                title: s("X"),
                custom_title: None,
                folder_id: None,
                pos: None,
                target: None,
            }),
            Rc::new(Pin {
                id: s("p2"),
                space_id: s("a"),
                url: s("u"),
                title: s("t"),
                custom_title: Some(s("")),
                folder_id: Some(s("")),
                pos: Some(f64::NAN),
                target: Some(LibTarget::App { bundle_id: s("com.a"), name: s("") }),
            }),
        ]),
        favorites: Rc::new(vec![
            Rc::new(Favorite {
                id: s("f1"),
                scope: s(""),
                url: s("https://f/"),
                title: s("F"),
                custom_title: None,
                pos: Some(f64::INFINITY),
                target: Some(LibTarget::web("firefox", Some(""))),
            }),
            Rc::new(Favorite {
                id: s("f2"),
                scope: s("global"),
                url: s("g"),
                title: s("G"),
                custom_title: Some(s("Mine")),
                pos: None,
                target: Some(LibTarget::Margin { page: s("evil") }),
            }),
        ]),
        air_traffic: Rc::new(vec![
            Rc::new(Rule { id: s("r1"), pattern: s("a.com"), space_id: s("a"), enabled: false, order: None }),
            Rc::new(Rule { id: s("r2"), pattern: s("b.com"), space_id: s("b"), enabled: true, order: Some(7.0) }),
        ]),
        splits: Rc::new(vec![
            Rc::new(Split {
                id: s("s1"),
                space_id: s("a"),
                axis: Axis::Vertical,
                panes: vec![s("t-1"), s("t-2")],
                ratios: vec![f64::NAN, 0.5],
                tree: None,
                pinned: true,
                folder_id: Some(s("")),
                pos: Some(f64::NAN),
            }),
            Rc::new(Split {
                id: s("s2"),
                space_id: s("a"),
                axis: Axis::Horizontal,
                panes: vec![s("t-3"), s("t-4")],
                ratios: vec![0.25, 0.75],
                tree: None,
                pinned: false,
                folder_id: Some(s("f-1")),
                pos: Some(-0.0),
            }),
        ]),
        folders: Rc::new(vec![
            Rc::new(Folder { id: s("f-1"), space_id: s("a"), name: s("F"), open: true, pos: None, parent_id: None }),
            Rc::new(Folder {
                id: s("f-2"),
                space_id: s("a"),
                name: s("G"),
                open: false,
                pos: Some(3.0),
                parent_id: Some(s("f-1")),
            }),
        ]),
        archive: Rc::new(vec![Rc::new(ArchiveEntry {
            id: s("a1"),
            url: s("https://old/"),
            title: s("Old"),
            space_id: s("a"),
            fav_icon_url: s(""),
            closed_at: 9.0,
            target: None,
        })]),
        kept: Rc::new(kept),
        windows: Rc::new([(s("10"), s("a")), (s("2"), s("b"))].into_iter().collect()),
    }
}

#[test]
fn values_of_a_state_the_model_made() {
    let safari = json!({ "kind": "web", "browser": "safari", "profile": null });
    let want = json!({
        "spaces": { "b": { "name": "B", "emoji": "✨", "color": "#00b894", "order": 0, "browser": "safari", "profile": null },
                    "a": { "name": "A", "emoji": "", "color": "", "order": 1, "browser": "chrome", "profile": "" } },
        "pins": { "p1": { "spaceId": "a", "url": "https://x/", "title": "X", "folderId": null, "pos": 0, "target": safari },
                  "p2": { "spaceId": "a", "url": "u", "title": "t", "folderId": "", "pos": 1, "target": { "kind": "app", "bundleId": "com.a", "name": "com.a" } } },
        "favorites": { "f1": { "scope": "global", "url": "https://f/", "title": "F", "pos": 0, "target": safari },
                       "f2": { "scope": "global", "url": "g", "title": "G", "customTitle": "Mine", "pos": 1, "target": safari } },
        "airTraffic": { "r1": { "pattern": "a.com", "spaceId": "a", "enabled": false, "order": 0 },
                        "r2": { "pattern": "b.com", "spaceId": "b", "enabled": true, "order": 7 } },
        "splits": { "s1": { "spaceId": "a", "axis": "vertical", "panes": ["t-1", "t-2"], "ratios": [null, 0.5], "pinned": true },
                    "s2": { "spaceId": "a", "axis": "horizontal", "panes": ["t-3", "t-4"], "ratios": [0.25, 0.75], "folderId": "f-1", "pos": 0 } },
        "folders": { "f-1": { "spaceId": "a", "name": "F", "open": true, "pos": 0 },
                     "f-2": { "spaceId": "a", "name": "G", "open": false, "pos": 3, "parentId": "f-1" } },
        "tabs": { "t-1": { "url": "https://one/", "title": "One", "icon": "", "spaceId": "a", "order": 0, "lastUsed": 5, "selected": true,
                           "target": { "kind": "app", "bundleId": "x".repeat(255), "name": "N" }, "favoriteId": "f1", "customTitle": "C",
                           "imported": { "browser": "safari", "profile": "P", "id": "t-9" } },
                  "t-2": { "url": "https://two/", "title": "Two", "icon": "i", "spaceId": "b", "order": 2.5, "lastUsed": 1e21, "selected": false,
                           "target": { "kind": "web", "browser": "edge", "profile": "p".repeat(256) } } },
        "archive": { "a1": { "url": "https://old/", "title": "Old", "spaceId": "a", "icon": "", "closedAt": 9, "target": safari } },
        "windows": { "2": { "spaceId": "b" }, "10": { "spaceId": "a" } },
        "imports": { "done": { "at": 1 } },
    });
    let imports = json!({ "done": { "at": 1 } }).as_object().unwrap().clone();
    let got = Value::Object(values_of(&made(), &imports));
    // Key order counts (one writer makes every record's): compared as text.
    assert_eq!(got.to_string(), want.to_string());
}

fn lib(v: Value) -> LibState {
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

#[test]
fn perform_s_diff() {
    // tests/library.test.ts: setSpace changes only its window's value; again: nothing.
    let values = json!({ "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } } });
    let before = lib(values.clone());
    let mut after = before.clone();
    Rc::make_mut(&mut after.windows).insert(s("2"), s("b"));
    let changes = diff(&before, &after);
    assert_eq!(changes, [Change::Set { collection: "windows", id: "2".into(), value: json!({ "spaceId": "b" }) }]);
    assert_eq!(changes[0].to_json(), json!({ "collection": "windows", "id": "2", "value": { "spaceId": "b" } }));
    assert!(diff(&before, &before.clone()).is_empty(), "the same lists: nothing compared, nothing changed");
    assert!(diff(&before, &lib(values)).is_empty(), "equal lists: nothing changed");
    let mut gone = after.clone();
    Rc::make_mut(&mut gone.windows).remove("2");
    assert_eq!(diff(&after, &gone), [Change::Deleted { collection: "windows", id: "2".into() }]);
    assert_eq!(diff(&after, &gone)[0].to_json(), json!({ "collection": "windows", "id": "2", "deleted": true }));
}

#[test]
fn diff_orders_collections_then_ids_in_utf16() {
    let before = lib(json!({
        "spaces": { "a": { "name": "A" } },
        "tabs": { "t-z": { "url": "u", "spaceId": "a" } },
    }));
    let mut after = before.clone();
    // A space whose order moves (its place: valuesOf's `order: i`), two new ones, the item gone.
    let new = |id: &str| Rc::new(Space { id: s(id), ..(*before.spaces[0]).clone() });
    *Rc::make_mut(&mut after.spaces) = vec![new("\u{FFFD}"), new("😀"), before.spaces[0].clone()];
    Rc::make_mut(&mut after.kept).remove("t-z");
    let got: Vec<(String, &str, bool)> = diff(&before, &after)
        .iter()
        .map(|c| (c.id().to_owned(), c.collection(), matches!(c, Change::Deleted { .. })))
        .collect();
    assert_eq!(
        got,
        [
            ("a".into(), "spaces", false),
            ("😀".into(), "spaces", false),
            ("\u{FFFD}".into(), "spaces", false),
            ("t-z".into(), "tabs", true),
        ],
        "UTF-16 units: a surrogate (😀) before U+FFFD, which code points put after"
    );
}

#[test]
fn items_the_same_or_equal_or_under_another_key() {
    let before =
        lib(json!({ "tabs": { "t-1": { "url": "u", "spaceId": "a" }, "t-2": { "url": "v", "spaceId": "a" } } }));
    // An equal item made anew: no change; one moved: its change only.
    let mut after = before.clone();
    let kept = Rc::make_mut(&mut after.kept);
    kept.insert(s("t-1"), Rc::new((**before.kept.get("t-1").unwrap()).clone()));
    kept.insert(s("t-2"), Rc::new(Item { order: 3.0, ..(**before.kept.get("t-2").unwrap()).clone() }));
    let ids: Vec<String> = diff(&before, &after).iter().map(|c| c.id().to_owned()).collect();
    assert_eq!(ids, ["t-2"]);
    // An item under a key not its id: valuesOf writes `out.tabs[k.id]`, the later of two the same id wins.
    let mut odd = before.clone();
    let kept = Rc::make_mut(&mut odd.kept);
    kept.insert(s("t-9"), Rc::new(Item { order: 5.0, ..(**before.kept.get("t-1").unwrap()).clone() }));
    let got: Vec<Value> = diff(&before, &odd).iter().map(Change::to_json).collect();
    assert_eq!(got.len(), 1);
    assert_eq!((&got[0]["id"], &got[0]["value"]["order"]), (&json!("t-1"), &json!(5)));
}

#[test]
fn numbers_compare_as_their_json_text() {
    let base = lib(json!({ "splits": { "g": { "spaceId": "a", "panes": ["t-1", "t-2"], "pos": 0 } } }));
    let with = |ratios: Vec<f64>, pos: Option<f64>| {
        let mut s = base.clone();
        Rc::make_mut(&mut s.splits)[0] = Rc::new(Split { ratios, pos, ..(*base.splits[0]).clone() });
        s
    };
    assert!(
        diff(&with(vec![f64::NAN, 0.5], Some(0.0)), &with(vec![f64::INFINITY, 0.5], Some(-0.0))).is_empty(),
        "null is null, 0 is 0"
    );
    assert_eq!(diff(&with(vec![f64::NAN, 0.5], None), &with(vec![0.5, 0.5], None)).len(), 1);
    assert!(
        diff(&with(vec![0.5, 0.5], Some(f64::NAN)), &with(vec![0.5, 0.5], None)).is_empty(),
        "a pos that isn't finite isn't written"
    );
    let mut o = base.clone();
    Rc::make_mut(&mut o.kept).insert(s("t-1"), Rc::new(Item { order: f64::NAN, ..item("t-1", "a") }));
    let mut p = base.clone();
    Rc::make_mut(&mut p.kept).insert(s("t-1"), Rc::new(Item { order: 0.0, ..item("t-1", "a") }));
    assert!(diff(&o, &p).is_empty(), "finite(NaN) is 0");
}

#[test]
fn a_target_a_rule_made_is_checked_as_written() {
    let base = lib(json!({ "pins": { "p": { "spaceId": "a", "url": "u" } } }));
    let mut none = base.clone();
    Rc::make_mut(&mut none.pins)[0] = Rc::new(Pin { target: None, ..(*base.pins[0]).clone() });
    assert!(diff(&base, &none).is_empty(), "none: Safari's, as stored");
    let mut app = base.clone();
    Rc::make_mut(&mut app.pins)[0] =
        Rc::new(Pin { target: Some(LibTarget::App { bundle_id: s("-bad"), name: s("") }), ..(*base.pins[0]).clone() });
    assert!(diff(&base, &app).is_empty(), "a bundle id that isn't one: Safari's");
}

#[test]
fn values_of_what_state_of_read_and_its_imports() {
    let values = json!({
        "spaces": { "a": { "name": "A", "order": 3, "x": 1 } },
        "imports": { "done": { "at": 5 }, "b": 1 },
        "settings": { "theme": 1 },
    });
    let v = values.as_object().unwrap();
    let out = values_of(&lib(values.clone()), &imports_of(v));
    assert_eq!(out.keys().collect::<Vec<_>>(), COLLECTIONS.iter().collect::<Vec<_>>());
    assert_eq!(
        out["spaces"],
        json!({ "a": { "name": "A", "emoji": "", "color": "", "order": 0, "browser": "safari", "profile": null } })
    );
    assert_eq!(out["imports"], json!({ "done": { "at": 5 }, "b": 1 }));
}

#[test]
fn the_import_s_diff_over_stored_values() {
    let stored = json!({
        "spaces": { "a": { "emoji": "", "name": "A", "color": "", "order": 0, "browser": "safari", "profile": null },
                    "b": { "name": "B", "emoji": "", "color": "", "order": 1.0, "browser": "safari", "profile": null } },
        "tabs": { "x-1": { "url": "u", "spaceId": "a" }, "t-1": 5 },
        "imports": { "done": { "at": 1 } },
        "settings": { "a": 1 },
    });
    let current = stored.as_object().unwrap();
    let normal = values_of(&lib(stored.clone()), &imports_of(current));
    let got: Vec<Value> = diff_values(current, &normal).iter().map(Change::to_json).collect();
    assert_eq!(
        got,
        [
            json!({ "collection": "spaces", "id": "a", "value": { "name": "A", "emoji": "", "color": "", "order": 0, "browser": "safari", "profile": null } }),
            json!({ "collection": "tabs", "id": "t-1", "deleted": true }),
            json!({ "collection": "tabs", "id": "x-1", "deleted": true }),
        ],
        "a value with its keys in another order is rewritten; 1.0 is 1; what the rules don't read goes"
    );
    assert!(
        same_json(Some(&json!({ "2": 1, "a": 2 })), Some(&json!({ "a": 2, "2": 1 }))),
        "JS lists an index key first in both"
    );
    assert!(!same_json(Some(&json!({ "b": 1, "a": 2 })), Some(&json!({ "a": 2, "b": 1 }))));
    assert!(
        same_json(Some(&json!(9007199254740993u64)), Some(&json!(9007199254740992.0))),
        "doubles, as JSON.parse reads them"
    );
    assert!(!same_json(None, Some(&json!(null))) && same_json(None, None));
    assert!(!same_json(Some(&json!({ "a": 1 })), Some(&json!({ "b": 1 }))), "the keys too");
    assert!(!same_json(Some(&json!([{ "a": 1 }])), Some(&json!([{ "b": 1 }]))));
}
