// import.rs against library.ts: its ids (nsId, nsTabId: library.ts's answers), and an import's values. The 2,000
// generated imports run against library.ts by the scratch harness are counted in DECISIONS.md; tests/fixtures/library's
// import vectors take over once part 2's normalising is in.

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::vectors::AsciiCollation;
use serde_json::json;

#[test]
fn namespaced_ids_as_library_ts() {
    let long = "p".repeat(260);
    let id250 = "x".repeat(250);
    for (b, p, id, ns, tab) in [
        ("safari", "s-default", "sp-a", "safari:s-default:sp-a", "t-73bd1dc305324e51"),
        ("chrome", "Default", "t-1", "chrome:Default:t-1", "t-1b2fa4f06764a62a"),
        ("safari", long.as_str(), "sp-a", "safari:2a664435e66448a7:4eb86fc6825e22c4", "t-971bd0f21da8ccf0"),
        ("edge", "é😀", id250.as_str(), "edge:39abf65974df7a6b:d5d8749d420ff44f", "t-ca5407304d3a4c6a"),
        ("safari", "a:b", "c", "safari:a:b:c", "t-69d351b5fd8dd227"),
    ] {
        assert_eq!(ns_id(b, p, id), ns, "{b} {p} {id}");
        assert_eq!(ns_tab_id(b, p, id), tab, "{b} {p} {id}");
    }
    // 256 units kept as they are, 257 hashed (an emoji counts 2).
    let id = "a".repeat(256 - "safari:s:".len() - 2);
    assert_eq!(ns_id("safari", "s", &format!("{id}😀")), format!("safari:s:{id}😀"));
    assert_ne!(ns_id("safari", "s", &format!("{id}a😀")), format!("safari:s:{id}a😀"));
}

fn set(browser: &str, profile: &str, values: Value) -> ImportSet {
    ImportSet { browser: browser.into(), profile: profile.into(), values: values.as_object().unwrap().clone() }
}

#[test]
fn an_import_brings_a_profiles_set() {
    let current =
        json!({ "spaces": { "sp-own": { "name": "Mine", "order": 0, "browser": "safari", "profile": null } } });
    let personal = set(
        "safari",
        "s-default",
        json!({
            "spaces": { "sp-b": { "name": " Work ", "order": 1 }, "sp-a": { "name": "Home", "emoji": "🏠", "order": 1 } },
            "folders": { "f-1": { "spaceId": "sp-a", "name": "Reading", "open": false, "pos": 2, "parentId": "f-0" }, "f-2": { "spaceId": "gone" } },
            "pins": { "p-1": { "spaceId": "sp-a", "url": "https://a.com", "title": "A", "folderId": "f-1", "pos": 0.5 }, "p-2": { "spaceId": "sp-a", "url": 5 } },
            "tabs": {
                "t-1": { "spaceId": "sp-b", "url": "HTTPS://b.com", "title": "B", "icon": "Https://b.com/i.png", "order": 3, "lastUsed": 9, "selected": true },
                "t-2": { "spaceId": "sp-b", "url": "app://com.apple.Notes" },
            },
            "archive": { "a-1": { "spaceId": "sp-gone", "url": "https://c.com", "closedAt": 7, "icon": "data:x" } },
        }),
    );
    let bad = ImportSet::from_json(&json!({ "browser": "firefox", "profile": "x", "values": {} }));
    assert!(bad.is_none());
    let order = [("safari".to_string(), "s-default".to_string(), "sp-b".to_string())];
    let out = import_values(current.as_object().unwrap(), &[personal], &order, 1762000000000.0, &AsciiCollation::new());
    assert_eq!(out.counts, Counts { spaces: 2, pins: 1, folders: 1, tabs: 1, archive: 1 });
    let v = &out.values;
    // The library's own first, then the person's order (sp-b), then the rest (sp-a: equal orders, by localeCompare).
    assert_eq!(v["spaces"]["sp-own"]["order"], 0);
    assert_eq!(
        v["spaces"]["safari:s-default:sp-b"],
        json!({ "name": " Work ", "emoji": "", "color": "", "order": 1, "browser": "safari", "profile": "s-default" })
    );
    assert_eq!(v["spaces"]["safari:s-default:sp-a"]["order"], 2);
    assert_eq!(
        v["folders"]["safari:s-default:f-1"],
        json!({ "spaceId": "safari:s-default:sp-a", "name": "Reading", "open": false, "pos": 2 })
    );
    let target = json!({ "kind": "web", "browser": "safari", "profile": "s-default" });
    assert_eq!(
        v["pins"]["safari:s-default:p-1"],
        json!({ "spaceId": "safari:s-default:sp-a", "url": "https://a.com", "title": "A", "folderId": "safari:s-default:f-1", "pos": 0.5, "target": target })
    );
    let tab = &v["tabs"][&ns_tab_id("safari", "s-default", "t-1")];
    assert_eq!(tab["icon"], ""); // /^(https?|data):/ has no `i`
    assert_eq!(tab["imported"], json!({ "browser": "safari", "profile": "s-default", "id": "t-1" }));
    assert_eq!(tab["selected"], true);
    assert_eq!(v["archive"]["safari:s-default:a-1"]["spaceId"], "safari:s-default:sp-a"); // the profile's first space
    assert_eq!(v["archive"]["safari:s-default:a-1"]["icon"], "data:x");
    assert_eq!(
        v["imports"]["done"],
        json!({ "at": 1762000000000u64, "sets": ["safari:s-default"], "spaces": 2, "pins": 1, "folders": 1, "tabs": 1, "archive": 1 })
    );
    assert_eq!(v.keys().map(String::as_str).collect::<Vec<_>>(), COLLECTIONS);
}

/// The changes merged into values as the store does (a value or a deletion; the times are the store's).
fn merged(values: &Map<String, Value>, changes: &[Change]) -> Map<String, Value> {
    let mut out = values.clone();
    for c in changes {
        let list = out.entry(c.collection()).or_insert_with(|| json!({})).as_object_mut().unwrap();
        match c {
            Change::Set { id, value, .. } => {
                list.insert(id.clone(), value.clone());
            }
            Change::Deleted { id, .. } => {
                list.remove(id);
            }
        }
    }
    out
}

#[test]
fn the_import_whole_as_library_ts() {
    // tests/library.test.ts: every profile's set once, ids namespaced, the person's order kept; run again: nothing.
    let def = set(
        "safari",
        "s-default",
        json!({
            "spaces": { "personal": { "name": "Personal", "emoji": "🏠", "color": "#6c5ce7", "order": 0 }, "work": { "name": "Work", "emoji": "💼", "color": "#000", "order": 1 } },
            "pins": { "p-1": { "spaceId": "work", "url": "https://mail.example/", "title": "Mail", "folderId": "f-1", "pos": 0 } },
            "folders": { "f-1": { "spaceId": "work", "name": "F", "open": true, "pos": 0 } },
            "tabs": { "t-aaaa": { "url": "https://a.example/", "title": "A", "icon": "", "spaceId": "personal", "order": 3, "lastUsed": 50, "selected": true }, "t-nope": { "url": "about:blank", "spaceId": "personal", "order": 1 } },
            "archive": { "a-1": { "url": "https://old.example/", "title": "Old", "spaceId": "gone", "icon": "", "closedAt": 9 } },
            "settings": { "theme": { "updatedAt": 1, "value": "x" } },
        }),
    );
    let other = set(
        "safari",
        "s-OTHER",
        json!({
            "spaces": { "personal": { "name": "Home", "emoji": "🏡", "color": "#fff", "order": 0 } },
            "tabs": { "t-aaaa": { "url": "https://b.example/", "title": "B", "spaceId": "personal", "order": 0, "lastUsed": 60 } },
        }),
    );
    let sets = [def, other];
    let o = |b: &str, p: &str, id: &str| (b.to_owned(), p.to_owned(), id.to_owned());
    let order =
        [o("safari", "s-default", "work"), o("safari", "s-OTHER", "personal"), o("safari", "s-default", "personal")];
    let sorter = CodePointOrder;
    let (changes, counts) = import_changes(&Map::new(), &sets, &order, 77.0, &sorter);
    assert_eq!(counts, Counts { spaces: 3, pins: 1, folders: 1, tabs: 2, archive: 1 });
    let lib = merged(&Map::new(), &changes);
    let mut spaces: Vec<(&String, f64)> =
        lib["spaces"].as_object().unwrap().iter().map(|(id, v)| (id, v["order"].as_f64().unwrap())).collect();
    spaces.sort_by(|a, b| a.1.total_cmp(&b.1));
    assert_eq!(
        spaces.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
        ["safari:s-default:work", "safari:s-OTHER:personal", "safari:s-default:personal"]
    );
    assert_eq!(
        lib["spaces"]["safari:s-OTHER:personal"],
        json!({ "name": "Home", "emoji": "🏡", "color": "#fff", "order": 1, "browser": "safari", "profile": "s-OTHER" })
    );
    let web = |p: &str| json!({ "kind": "web", "browser": "safari", "profile": p });
    let a = ns_tab_id("safari", "s-default", "t-aaaa");
    assert_eq!(
        lib["tabs"][&a],
        json!({ "url": "https://a.example/", "title": "A", "icon": "", "spaceId": "safari:s-default:personal", "order": 3, "lastUsed": 50, "selected": true,
                "target": web("s-default"), "imported": { "browser": "safari", "profile": "s-default", "id": "t-aaaa" } })
    );
    assert_eq!(lib["tabs"].as_object().unwrap().len(), 2, "a page that isn't a web page isn't an item");
    assert_eq!(
        lib["pins"]["safari:s-default:p-1"],
        json!({ "spaceId": "safari:s-default:work", "url": "https://mail.example/", "title": "Mail", "folderId": "safari:s-default:f-1", "pos": 0, "target": web("s-default") })
    );
    assert_eq!(lib["archive"]["safari:s-default:a-1"]["spaceId"], "safari:s-default:personal");
    assert_eq!(
        lib["imports"]["done"],
        json!({ "at": 77, "sets": ["safari:s-default", "safari:s-OTHER"], "spaces": 3, "pins": 1, "folders": 1, "tabs": 2, "archive": 1 })
    );
    assert!(lib.get("settings").is_none(), "settings aren't the library's");
    // Run again (a crash before the marker reached the disk): the same ids, nothing new.
    assert_eq!(import_changes(&lib, &sets, &order, 77.0, &sorter).0, []);
    // What was imported is as the rules read it: read and written again, nothing changes.
    let state = crate::library::state::state_of(&lib, &sorter);
    let normal = crate::library::values::values_of(&state, &crate::library::state::imports_of(&lib));
    assert_eq!(crate::library::values::diff_values(&lib, &normal), []);
    assert!(crate::library::state::is_imported(&lib));
}

#[test]
fn the_import_normalises_what_the_library_had() {
    // `current` read as stored: a value the rules write otherwise is rewritten, a record they don't read is deleted
    // (LT:934 diffs the stored values, not their reading).
    let current = json!({
        "spaces": { "sp-own": { "order": 0, "name": "Mine" } },
        "tabs": { "nope": { "url": "https://x/", "spaceId": "sp-own" } },
    });
    let (changes, _) = import_changes(current.as_object().unwrap(), &[], &[], 5.0, &CodePointOrder);
    let got: Vec<Value> = changes.iter().map(Change::to_json).collect();
    assert_eq!(
        got,
        [
            json!({ "collection": "spaces", "id": "sp-own", "value": { "name": "Mine", "emoji": "", "color": "", "order": 0, "browser": "safari", "profile": null } }),
            json!({ "collection": "tabs", "id": "nope", "deleted": true }),
            json!({ "collection": "imports", "id": "done", "value": { "at": 5, "sets": [], "spaces": 0, "pins": 0, "folders": 0, "tabs": 0, "archive": 0 } }),
        ]
    );
}
