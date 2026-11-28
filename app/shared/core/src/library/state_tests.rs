// state.rs against library.ts: targetOf (tests/library.test.ts), stateOf's checks, cuts and orders (arc-data.test.ts's
// splits, the rest from LT:87-137 read line by line), JS's key order. The generated libraries run against library.ts by
// the scratch harness are counted in DECISIONS.md; tests/fixtures/library's snapshot vectors take over once commit 0's
// land. Ties use the stand-in sorter (code points) with ids both orders agree on.

use super::*;
use crate::data::set::{DataItem, DataSet};
use crate::library::js::CodePointOrder;
use serde_json::json;

fn state(v: Value) -> LibState {
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

fn ids<T>(list: &[Rc<T>], id: impl Fn(&T) -> &str) -> Vec<String> {
    list.iter().map(|x| id(x).to_owned()).collect()
}

#[test]
fn targets_as_library_ts_checks_them() {
    let settings = json!({ "kind": "margin", "page": "settings" });
    assert_eq!(target_of(Some(&settings)), Some(LibTarget::Margin { page: "settings".into() }));
    assert_eq!(target_of(Some(&json!({ "kind": "margin", "page": "evil" }))), None, "only Margin's own pages");
    assert_eq!(target_of(Some(&json!({ "kind": "margin", "page": "toString" }))), None, "own keys only");
    assert_eq!(target_of(Some(&json!({ "kind": "margin" }))), None);
    assert_eq!(
        target_of(Some(&json!({ "kind": "app", "bundleId": "com.apple.Notes", "name": "" }))),
        Some(LibTarget::App { bundle_id: "com.apple.Notes".into(), name: "com.apple.Notes".into() }),
        "no name: the bundle id"
    );
    let long = "a".repeat(300);
    match target_of(Some(&json!({ "kind": "app", "bundleId": long, "name": "n".repeat(150) }))) {
        Some(LibTarget::App { bundle_id, name }) => {
            assert_eq!((bundle_id.len(), name.len()), (255, 100), "cut, then checked")
        }
        other => panic!("{other:?}"),
    }
    for bad in ["-x", "", "com.x y", "a_b"] {
        assert_eq!(target_of(Some(&json!({ "kind": "app", "bundleId": bad }))), None, "{bad:?}");
    }
    assert_eq!(target_of(Some(&json!({ "kind": "app", "bundleId": 5 }))), None);
    assert_eq!(
        target_of(Some(&json!({ "kind": "web", "browser": "firefox", "profile": "" }))),
        Some(LibTarget::safari()),
        "another browser: Safari; an empty profile: none"
    );
    match target_of(Some(&json!({ "kind": "web", "browser": "edge", "profile": "é".repeat(300) }))) {
        Some(LibTarget::Web { browser, profile }) => {
            assert_eq!((&*browser, profile.unwrap().chars().count()), ("edge", 256))
        }
        other => panic!("{other:?}"),
    }
    for none in [json!(null), json!("web"), json!([]), json!({ "kind": "WEB" }), json!({})] {
        assert_eq!(target_of(Some(&none)), None, "{none}");
    }
    assert_eq!(target_of(None), None);
}

#[test]
fn places_of_targets() {
    let app = LibTarget::App { bundle_id: "com.apple.Notes".into(), name: "Notes".into() };
    assert_eq!(place_of(&app, Some(&json!("https://x/")), None), ("app://com.apple.Notes".into(), "Notes".into()));
    assert_eq!(place_of(&app, None, Some(&json!("Mine"))).1, "Mine");
    let page = LibTarget::Margin { page: "settings".into() };
    assert_eq!(
        place_of(&page, Some(&json!("https://x/")), Some(&json!("T"))),
        ("margin://settings".into(), "Settings".into())
    );
    let web = LibTarget::safari();
    assert_eq!(
        place_of(&web, Some(&json!("https://x/")), Some(&json!(""))),
        ("https://x/".into(), "https://x/".into())
    );
    assert_eq!(place_of(&web, Some(&json!(5)), Some(&json!("T"))), (String::new(), "T".into()));
}

#[test]
fn spaces_read_cut_and_ordered() {
    let s = state(json!({ "spaces": {
        "c": { "name": "C", "order": 1 },
        "b": { "name": "B", "order": 1, "browser": "chrome", "profile": "Work", "theme": "pixel" },
        "a": { "name": "a😀".repeat(101), "emoji": "a😀😀😀😀😀😀😀😀", "color": 5, "order": "0", "browser": "firefox", "profile": "", "theme": "Pixel" },
        "x": 5,
    } }));
    assert_eq!(ids(&s.spaces, |x| &x.id), ["a", "b", "c"], "order (not a number: 0), then the ids");
    let a = &s.spaces[0];
    assert_eq!(js::len16(&a.name), 199, "200 units, the broken half dropped (Tirth's answer 3)");
    assert_eq!(js::len16(&a.emoji), 15);
    assert_eq!((&*a.color, &*a.browser, a.profile.as_deref(), a.theme.as_deref()), ("", "safari", None, None));
    let b = &s.spaces[1];
    assert_eq!((&*b.browser, b.profile.as_deref(), b.theme.as_deref()), ("chrome", Some("Work"), Some("pixel")));
}

#[test]
fn pins_favorites_rules_folders_archive() {
    let s = state(json!({
        "pins": {
            "p-1": { "spaceId": "a", "url": "https://x/", "title": 5, "customTitle": "", "folderId": "", "pos": "1" },
            "p-2": { "spaceId": "a", "url": 5 },
            "p-3": { "spaceId": "a", "url": "u", "customTitle": "c".repeat(300), "folderId": "f-1", "pos": 2.5, "target": { "kind": "app", "bundleId": "com.a" } },
        },
        "favorites": { "fav-1": { "url": "https://f/", "scope": "" }, "fav-2": { "scope": "profile:Work" } },
        "airTraffic": {
            "atc-b": { "pattern": "b.com", "spaceId": "a" },
            "atc-a": { "pattern": "a.com", "spaceId": "a", "order": 0, "enabled": 0 },
            "atc-c": { "pattern": "c.com", "spaceId": 5 },
            "atc-d": { "pattern": "p".repeat(300), "spaceId": "a", "order": 5, "enabled": false },
        },
        "folders": { "f-1": { "spaceId": "a", "name": "F", "open": 0, "parentId": "" }, "f-2": { "spaceId": "a", "open": false, "pos": 1, "parentId": "f-1" } },
        "archive": {
            "a-1": { "url": "https://one/", "closedAt": 5, "spaceId": "s".repeat(300), "icon": "i".repeat(100_001) },
            "a-0": { "url": "https://zero/", "closedAt": 5 },
            "a-2": { "url": "https://two/", "closedAt": 9, "target": { "kind": "web", "browser": "chrome" } },
            "a-3": { "closedAt": 10 },
        },
    }));
    assert_eq!(ids(&s.pins, |p| &p.id), ["p-1", "p-3"], "an address that isn't a string: no pin");
    let p1 = &s.pins[0];
    assert_eq!((&*p1.title, p1.custom_title.as_deref(), p1.folder_id.as_deref(), p1.pos), ("", None, None, Some(0.0)));
    assert_eq!(p1.target, Some(LibTarget::safari()));
    let p3 = &s.pins[1];
    assert_eq!(
        (p3.custom_title.as_ref().map(|c| c.len()), p3.folder_id.as_deref(), p3.pos),
        (Some(200), Some("f-1"), Some(2.5))
    );
    assert_eq!(ids(&s.favorites, |f| &f.id), ["fav-1"]);
    assert_eq!(&*s.favorites[0].scope, "global");
    assert_eq!(ids(&s.air_traffic, |r| &r.id), ["atc-a", "atc-b", "atc-d"], "by order (none: 0), then the ids");
    let rules: Vec<(bool, Option<f64>, usize)> =
        s.air_traffic.iter().map(|r| (r.enabled, r.order, r.pattern.len())).collect();
    assert_eq!(rules, [(true, Some(0.0), 5), (true, Some(1.0), 5), (false, Some(5.0), 200)], "no order: its place");
    let f: Vec<(bool, Option<f64>, Option<&str>)> =
        s.folders.iter().map(|f| (f.open, f.pos, f.parent_id.as_deref())).collect();
    assert_eq!(f, [(true, Some(0.0), None), (false, Some(1.0), Some("f-1"))], "open unless false");
    assert_eq!(ids(&s.archive, |a| &a.id), ["a-2", "a-0", "a-1"], "newest first, then the ids");
    let a1 = &s.archive[2];
    assert_eq!((a1.space_id.len(), a1.fav_icon_url.len(), &*a1.title), (256, 100_000, ""));
    assert_eq!(s.archive[0].target, Some(LibTarget::web("chrome", None)));
}

#[test]
fn splits_as_read() {
    // tests/arc-data.test.ts: panes that aren't ids dropped with their ratios, ratios one per pane, normalised.
    let s = state(
        json!({ "splits": { "g": { "spaceId": "a", "panes": ["t-1", 5, "t-2", "t-1"], "ratios": [2, 9, 1, 3] } } }),
    );
    assert_eq!(s.splits[0].panes, [Str::from("t-1"), Str::from("t-2")]);
    assert_eq!(s.splits[0].ratios, [0.6667, 0.3333]);
    assert!(
        state(json!({ "splits": { "g": { "spaceId": "a", "panes": ["t-1", 7], "ratios": [1, 1] } } }))
            .splits
            .is_empty()
    );
    let s = state(json!({ "splits": {
        "a": { "spaceId": "a", "panes": ["t-1", "", "t-2", "t-3", "t-4", "t-5"], "ratios": [1, 1], "axis": "vertical", "pinned": "x", "folderId": "f", "pos": "3" },
        "b": { "spaceId": "a", "panes": ["t-1", "t-2", "t-3"], "ratios": [0, -2, 1], "pinned": 0, "pos": -0.0 },
        "c": { "spaceId": "a", "panes": "t-1,t-2" },
        "d": { "spaceId": 5, "panes": ["t-1", "t-2"] },
    } }));
    assert_eq!(ids(&s.splits, |g| &g.id), ["a", "b"]);
    let a = &s.splits[0];
    assert_eq!(a.panes.len(), 5, "an empty one left out");
    assert_eq!(a.ratios, [0.2; 5], "ratios not one per pane given: 1 each");
    assert_eq!((a.axis, a.pinned, a.folder_id.as_deref(), a.pos), (Axis::Vertical, true, Some("f"), None));
    let b = &s.splits[1];
    assert_eq!(b.ratios, [0.3333, 0.3333, 0.3333], "a ratio not above 0: 1");
    assert_eq!((b.axis, b.pinned, b.pos), (Axis::Horizontal, false, Some(0.0)), "a number pos kept");
}

#[test]
fn items_are_kept_tabs() {
    let s = state(json!({ "tabs": {
        "t-b": { "url": "https://b/", "spaceId": "a", "order": 2, "lastUsed": 7, "selected": 1, "pinnedBy": "", "favoriteId": "fav-1",
                 "imported": { "browser": "b".repeat(40), "profile": 5, "id": "i".repeat(300) } },
        "t-a": { "url": "https://a/", "title": "A", "icon": "data:x", "spaceId": "a", "selected": true, "customTitle": "C",
                 "target": { "kind": "app", "bundleId": "com.apple.Notes", "name": "Notes" }, "imported": ["x"] },
        "x-1": { "url": "https://x/", "spaceId": "a" },
        "t-": { "url": "https://x/", "spaceId": "a" },
        "t-c": { "url": 5, "spaceId": "a" },
        "t-d": { "url": "https://d/" },
    } }));
    assert_eq!(s.kept.keys().map(|k| k.to_string()).collect::<Vec<_>>(), ["t-b", "t-a"], "as stored, `t-` ids only");
    let b = s.kept.get("t-b").unwrap();
    assert_eq!((b.order, b.last_active, b.kept_at, b.was_active, &*b.why), (2.0, 7.0, 7.0, false, "library"));
    assert_eq!((b.pinned_by.as_deref(), b.favorite_id.as_deref()), (None, Some("fav-1")));
    let i = b.imported.as_ref().unwrap();
    assert_eq!((i.browser.len(), &*i.profile, i.id.len()), (32, "", 256));
    assert_eq!(b.target, LibTarget::safari());
    let a = s.kept.get("t-a").unwrap();
    assert!(a.was_active);
    assert_eq!((&*a.fav_icon_url, a.custom_title.as_deref()), ("data:x", Some("C")));
    assert!(a.imported.is_none(), "an array isn't an object to isObject");
}

#[test]
fn windows_in_js_key_order() {
    let s = state(json!({ "windows": {
        "w": { "spaceId": "a" }, "10": { "spaceId": "b" }, "2": { "spaceId": "c" }, "007": { "spaceId": "d" },
        "4294967295": { "spaceId": "e" }, "4294967294": { "spaceId": "f" }, "3": { "spaceId": 5 }, "4": 5,
    } }));
    let got: Vec<(String, String)> = s.windows.iter().map(|(w, sp)| (w.to_string(), sp.to_string())).collect();
    let want = [("2", "c"), ("10", "b"), ("4294967294", "f"), ("w", "a"), ("007", "d"), ("4294967295", "e")];
    assert_eq!(
        got,
        want.map(|(a, b)| (a.to_owned(), b.to_owned())),
        "array indexes first, ascending; the rest as stored"
    );
}

#[test]
fn js_objects_keep_js_order() {
    let mut o: JsObject<u32> = JsObject::new();
    for (k, v) in [("b", 1), ("10", 2), ("a", 3), ("2", 4), ("0", 5)] {
        o.insert(k.into(), v);
    }
    assert_eq!(o.keys().map(|k| &**k).collect::<Vec<_>>(), ["0", "2", "10", "b", "a"]);
    assert_eq!(o.insert("b".into(), 9), Some(1), "a key set again stays where it was");
    assert_eq!(o.remove("2"), Some(4));
    o.insert("2".into(), 7);
    assert_eq!(
        o.iter().map(|(k, v)| (&**k, *v)).collect::<Vec<_>>(),
        [("0", 5), ("2", 7), ("10", 2), ("b", 9), ("a", 3)]
    );
    let mut p = o.clone();
    assert_eq!(o, p);
    p.remove("b");
    p.insert("b".into(), 9);
    assert_ne!(o, p, "the same entries in another order are another object's text");
    assert!(is_array_index("0") && is_array_index("4294967294"));
    assert!(
        !is_array_index("4294967295")
            && !is_array_index("01")
            && !is_array_index("-1")
            && !is_array_index("")
            && !is_array_index("1e3")
    );
}

#[test]
fn the_store_set_reads_as_its_values() {
    let values = json!({
        "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } },
        "tabs": { "t-1": { "url": "https://x/", "spaceId": "a" } },
        "windows": { "10": { "spaceId": "b" }, "9": { "spaceId": "a" } },
    });
    let mut set = DataSet::new();
    for (c, list) in values.as_object().unwrap() {
        for (id, v) in list.as_object().unwrap() {
            set.items.entry(c.clone()).or_default().insert(id.clone(), DataItem::live(1.0, v.clone()));
        }
    }
    set.items.entry("tabs".into()).or_default().insert("t-gone".into(), DataItem::tombstone(2.0));
    assert_eq!(state_of(&set, &CodePointOrder), state(values));
}

#[test]
fn a_copy_is_the_same_state_until_a_list_is_made_anew() {
    let s = state(json!({ "spaces": { "a": { "name": "A" } }, "pins": { "p": { "spaceId": "a", "url": "u" } } }));
    let mut next = s.clone();
    assert!(next.same(&s), "`next === s`");
    Rc::make_mut(&mut next.pins).push(Rc::new(Pin { id: "q".into(), ..(*s.pins[0]).clone() }));
    assert!(!next.same(&s));
    assert!(Rc::ptr_eq(&next.pins[0], &s.pins[0]), "the pin it didn't change is the same pin");
    assert!(Rc::ptr_eq(&next.spaces, &s.spaces));
}

#[test]
fn imports_and_the_marker() {
    let v = json!({ "imports": { "b": 1, "2": { "x": 1 }, "done": { "at": 1 } } });
    let imports = imports_of(v.as_object().unwrap());
    assert_eq!(imports.keys().collect::<Vec<_>>(), ["2", "b", "done"]);
    assert!(is_imported(v.as_object().unwrap()));
    for not in [
        json!({ "imports": { "done": [] } }),
        json!({ "imports": { "done": null } }),
        json!({ "imports": 5 }),
        json!({}),
    ] {
        assert!(!is_imported(not.as_object().unwrap()), "{not}");
    }
}

#[test]
fn small_readers() {
    assert!(theme_id_ok("pixel") && theme_id_ok("9-x") && theme_id_ok(&"a".repeat(41)));
    assert!(
        !theme_id_ok("Pixel")
            && !theme_id_ok("-x")
            && !theme_id_ok(&"a".repeat(42))
            && !theme_id_ok("")
            && !theme_id_ok("a_b")
    );
    assert!(is_tab_id("t-a") && is_tab_id(&format!("t-{}", "x".repeat(30))));
    assert!(
        !is_tab_id("t-") && !is_tab_id(&format!("t-{}", "x".repeat(31))) && !is_tab_id("t-a-b") && !is_tab_id("T-a")
    );
    assert_eq!(str_of(Some(&json!("abc")), 2), "ab");
    assert_eq!(str_of(Some(&json!(5)), 2), "");
    assert_eq!(margin_page_title("settings"), Some("Settings"));
    assert_eq!((app_url("com.a"), margin_url("settings")), ("app://com.a".into(), "margin://settings".into()));
}

#[test]
fn a_space_s_background_as_m_reads_it() {
    let bg = |v: Value| background_of(Some(&v)).map(|b| b.value());
    let id = "ab".repeat(32);
    assert_eq!(
        bg(json!({ "colors": ["#F7C7D3", "#cfe8f7"], "wheel": "complementary", "intensity": 0.373, "texture": "denim",
                   "amount": 0.47, "appearance": "dark", "image": { "id": id, "fit": "tile", "focus": [0.12345, 1] } })),
        Some(
            json!({ "colors": ["#f7c7d3", "#cfe8f7"], "wheel": "complementary", "intensity": 0.37, "texture": "denim",
                     "amount": 0.45, "appearance": "dark", "image": { "id": id, "fit": "tile", "focus": [0.123, 1] } })
        ),
        "every field as given: colours lowercased, numbers rounded (hundredths, twentieths, thousandths)"
    );
    assert_eq!(
        bg(json!({ "colors": ["#abc", "f7c7d3", "#12345g", 5, null, "#000000"], "wheel": "triadic", "intensity": "x",
                   "texture": "GRAIN", "amount": null, "appearance": 5, "extra": 1 })),
        Some(json!({ "colors": ["#000000"], "wheel": "analogous", "intensity": 0.5, "texture": "grain", "amount": 0,
                     "appearance": "auto" })),
        "wrong types and values: each its default, unknown keys dropped, only #rrggbb colours"
    );
    let clamped =
        bg(json!({ "colors": ["#111111", "#222222", "#333333", "#444444"], "intensity": 1.5, "amount": -0.0 }));
    assert_eq!(
        clamped,
        Some(
            json!({ "colors": ["#111111", "#222222", "#333333"], "wheel": "analogous", "intensity": 1, "texture": "grain",
                     "amount": 0, "appearance": "auto" })
        ),
        "the first three colours, numbers clamped to 0–1, -0 as 0"
    );
    assert_eq!(
        bg(json!({ "colors": ["#111111"], "intensity": 0.005 })).unwrap()["intensity"],
        json!(0.01),
        "Math.round"
    );
    assert_eq!(
        bg(json!({ "image": { "id": "0".repeat(64), "fit": "stretch", "focus": [2, -1, 0] } })),
        Some(json!({ "colors": [], "wheel": "analogous", "intensity": 0.5, "texture": "grain", "amount": 0,
                     "appearance": "auto", "image": { "id": "0".repeat(64), "fit": "cover", "focus": [0.5, 0.5] } })),
        "a picture alone"
    );
    for v in [
        json!({}),
        json!({ "colors": [], "texture": "dots" }),
        json!({ "colors": "#111111" }),
        json!({ "image": { "id": "AB".repeat(32) } }),
        json!({ "image": { "id": "a".repeat(63) } }),
        json!({ "image": "x" }),
        json!(null),
        json!([{ "colors": ["#111111"] }]),
        json!("x"),
        json!(5),
    ] {
        assert_eq!(bg(v.clone()), None, "{v}: no colour and no picture, or not an object");
    }
    assert!(bg_image_id_ok(&"f".repeat(64)) && !bg_image_id_ok(&"F".repeat(64)) && !bg_image_id_ok(&"g".repeat(64)));

    let s = state(json!({ "spaces": {
        "a": { "name": "A", "order": 0, "background": { "colors": ["#ABCDEF"] } },
        "b": { "name": "B", "order": 1, "background": { "colors": "x" } },
    } }));
    assert_eq!(s.spaces[0].background.as_ref().map(|b| b.colors.clone()), Some(vec![Str::from("#abcdef")]));
    assert_eq!(s.spaces[1].background, None, "stored but none to read: none");
}
