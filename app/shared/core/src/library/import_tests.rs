// import.rs against library.ts: its ids (nsId, nsTabId: library.ts's answers), and an import's values. The 2,000
// generated imports run against library.ts by the scratch harness are counted in DECISIONS.md; tests/fixtures/library's
// import vectors take over once part 2's normalising is in.

use super::*;
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
    let out = import_values(current.as_object().unwrap(), &[personal], &order, 1762000000000.0, &Collation::default());
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
