// snapshot.rs against library.ts: `JSON.stringify(snapshot(values))` for one library with every record kind, the
// escapes, the numbers' spellings and the windows' key order (library.ts's text recorded from Node, 2026-11-23). The
// generated libraries' texts compared with library.ts's are counted in DECISIONS.md.

use super::*;
use crate::library::js::CodePointOrder;
use crate::session::LiveRow;
use serde_json::{Value, json};

#[test]
fn the_text_library_ts_writes() {
    let values = json!({
        "spaces": { "sp-b": { "name": "B", "emoji": "💼", "color": "#000", "order": 1, "browser": "chrome", "profile": "Work", "theme": "pixel" },
                    "sp-a": { "name": " A\n\"q\"\\ ", "emoji": "", "color": "", "order": 0 } },
        "pins": { "p-1": { "spaceId": "sp-a", "url": "https://mail.example/", "title": "Mail", "customTitle": "M", "folderId": "f-1", "pos": 0.5,
                           "target": { "kind": "app", "bundleId": "com.apple.Notes", "name": "" } } },
        "favorites": { "fav-1": { "url": "https://f.example/", "title": "F", "pos": 1e21 } },
        "airTraffic": { "atc-1": { "pattern": "a.com", "spaceId": "sp-b", "enabled": false } },
        "splits": { "spv-1": { "spaceId": "sp-a", "axis": "vertical", "panes": ["t-a", "t-b"], "ratios": [1, 2], "pinned": 1, "pos": 0.1 + 0.2 } },
        "folders": { "f-1": { "spaceId": "sp-a", "name": "Folder", "open": false, "pos": -0.0, "parentId": "f-0" } },
        "archive": { "a-1": { "url": "https://old/", "title": "Old", "spaceId": "sp-a", "icon": "", "closedAt": 1e-7 },
                     "a-2": { "url": "https://new/", "title": "\u{2028}\u{1}", "spaceId": "sp-a", "icon": "i", "closedAt": 2, "target": { "kind": "margin", "page": "settings" } } },
        "tabs": {
            "t-a": { "url": "https://a/", "title": "A", "icon": "data:x", "spaceId": "sp-a", "order": 2, "lastUsed": 1762000000000u64, "selected": true, "pinnedBy": "p-1",
                     "imported": { "browser": "safari", "profile": "s-default", "id": "t-x" } },
            "t-b": { "url": "https://b/", "title": "B", "icon": "", "spaceId": "sp-a", "order": 1, "lastUsed": 5, "target": { "kind": "web", "browser": "edge", "profile": "Default" },
                     "favoriteId": "fav-1", "customTitle": "Bee" },
        },
        "windows": { "10": { "spaceId": "sp-b" }, "2": { "spaceId": "sp-a" }, "w": { "spaceId": "sp-a" } },
        "imports": { "done": { "at": 1 } },
    });
    let want = concat!(
        r#"{"library":{"v":1,"imported":true},"spaces":[{"id":"sp-a","name":" A\n\"q\"\\ ","emoji":"","color":"","browser":"safari","profile":null},"#,
        r##"{"id":"sp-b","name":"B","emoji":"💼","color":"#000","browser":"chrome","profile":"Work","theme":"pixel"}],"##,
        r#""pins":[{"id":"p-1","spaceId":"sp-a","url":"https://mail.example/","title":"Mail","customTitle":"M","folderId":"f-1","pos":0.5,"target":{"kind":"app","bundleId":"com.apple.Notes","name":"com.apple.Notes"}}],"#,
        r#""favorites":[{"id":"fav-1","scope":"global","url":"https://f.example/","title":"F","pos":1e+21,"target":{"kind":"web","browser":"safari","profile":null}}],"#,
        r#""airTraffic":[{"id":"atc-1","pattern":"a.com","spaceId":"sp-b","enabled":false,"order":0}],"#,
        r#""splits":[{"id":"spv-1","spaceId":"sp-a","axis":"vertical","panes":["t-a","t-b"],"ratios":[0.3333,0.6667],"pinned":true,"pos":0.30000000000000004}],"#,
        r#""folders":[{"id":"f-1","spaceId":"sp-a","name":"Folder","open":false,"pos":0,"parentId":"f-0"}],"#,
        "\"archive\":[{\"id\":\"a-2\",\"url\":\"https://new/\",\"title\":\"\u{2028}\\u0001\",",
        r#""spaceId":"sp-a","favIconUrl":"i","closedAt":2,"target":{"kind":"margin","page":"settings"}},"#,
        r#"{"id":"a-1","url":"https://old/","title":"Old","spaceId":"sp-a","favIconUrl":"","closedAt":1e-7,"target":{"kind":"web","browser":"safari","profile":null}}],"#,
        r#""openTabs":{"origin":"margin-app","since":0,"synced":true,"tabs":{},"tabSpace":{},"activeSpaceByWindow":{"2":"sp-a","10":"sp-b","w":"sp-a"},"awayByWindow":{},"#,
        r#""keptTabs":{"t-a":{"id":"t-a","url":"https://a/","title":"A","favIconUrl":"data:x","spaceId":"sp-a","order":2,"lastActive":1762000000000,"wasActive":true,"#,
        r#""keptAt":1762000000000,"why":"library","target":{"kind":"web","browser":"safari","profile":null},"pinnedBy":"p-1","imported":{"browser":"safari","profile":"s-default","id":"t-x"}},"#,
        r#""t-b":{"id":"t-b","url":"https://b/","title":"B","favIconUrl":"","spaceId":"sp-a","order":1,"lastActive":5,"wasActive":false,"keptAt":5,"why":"library","#,
        r#""target":{"kind":"web","browser":"edge","profile":"Default"},"favoriteId":"fav-1","customTitle":"Bee"}}}}"#,
    );
    let got = snapshot(values.as_object().unwrap(), &CodePointOrder);
    assert_eq!(got, want);
    let parsed: Value = serde_json::from_str(&got).unwrap();
    assert_eq!(parsed["library"]["imported"], json!(true), "valid JSON");
}

#[test]
fn an_empty_library() {
    assert_eq!(
        snapshot(&serde_json::Map::new(), &CodePointOrder),
        concat!(
            r#"{"library":{"v":1,"imported":false},"spaces":[],"pins":[],"favorites":[],"airTraffic":[],"splits":[],"folders":[],"archive":[],"#,
            r#""openTabs":{"origin":"margin-app","since":0,"synced":true,"tabs":{},"tabSpace":{},"activeSpaceByWindow":{},"awayByWindow":{},"keptTabs":{}}}"#,
        )
    );
}

#[test]
fn strings_as_json_stringify_escapes_them() {
    let all: String = (0u32..0x80).chain([0x7f, 0x2028, 0x2029, 0xfeff, 0x1f600]).filter_map(char::from_u32).collect();
    let mut out = String::new();
    write_str(&mut out, &all);
    // JSON.stringify's: the six short escapes, other controls as \u00xx (lowercase), the rest as it is.
    let mut want = String::from("\"");
    for c in all.chars() {
        match c {
            '"' => want.push_str("\\\""),
            '\\' => want.push_str("\\\\"),
            '\u{8}' => want.push_str("\\b"),
            '\u{c}' => want.push_str("\\f"),
            '\n' => want.push_str("\\n"),
            '\r' => want.push_str("\\r"),
            '\t' => want.push_str("\\t"),
            c if (c as u32) < 0x20 => want.push_str(&format!("\\u{:04x}", c as u32)),
            c => want.push(c),
        }
    }
    want.push('"');
    assert_eq!(out, want);
    assert!(out.contains("\\u001f") && out.contains("\\u0000"));
    assert_eq!(serde_json::from_str::<String>(&out).unwrap(), all);
    // Each alone in an otherwise plain string (the one-copy path must see it).
    for (s, want) in [("a\\b", r#""a\\b""#), ("a\u{1f}b", r#""a\u001fb""#), ("a\"b", r#""a\"b""#), ("ab", r#""ab""#)] {
        let mut out = String::new();
        write_str(&mut out, &s.repeat(40));
        assert_eq!(out, format!("\"{}\"", want[1..want.len() - 1].repeat(40)), "{s:?}");
    }
}

#[test]
fn a_key_left_out_of_a_record_is_left_out_of_the_text() {
    // A pin the model made has no `pos` yet: JSON.stringify leaves out what's undefined.
    let mut s = crate::library::state::state_of(
        json!({ "pins": { "p": { "spaceId": "a", "url": "u" } } }).as_object().unwrap(),
        &CodePointOrder,
    );
    let pin = crate::library::state::Pin { pos: None, target: None, ..(*s.pins[0]).clone() };
    std::rc::Rc::make_mut(&mut s.pins)[0] = std::rc::Rc::new(pin);
    assert!(snapshot_text(&s, false).contains(r#""pins":[{"id":"p","spaceId":"a","url":"u","title":""}]"#));
}

#[test]
fn an_item_alone_is_its_row_in_the_text() {
    let values = json!({ "tabs": { "t-a": { "url": "https://a/", "spaceId": "a", "customTitle": "C" } } });
    let s = crate::library::state::state_of(values.as_object().unwrap(), &CodePointOrder);
    let mut row = String::new();
    write_item(&mut row, s.kept.get("t-a").unwrap());
    assert!(snapshot_text(&s, false).contains(&format!("\"keptTabs\":{{\"t-a\":{row}}}")));
}

// ---- a window's state (commit 7): the open items moved into `tabs`, the profile's text after ----

/// HostedSession's `live` and `liveTab` (until commit 7), over the snapshot's JSON: each row whose item is a kept tab
/// with a space moves to `tabs` (by its number: its tab) and `tabSpace`, the rest stay kept; the settings and icons
/// set beside.
fn live_reference(snapshot: &str, open: Option<(i64, &[LiveRow])>, tail: Option<(&Value, &Value)>) -> Value {
    let mut s: Value = serde_json::from_str(snapshot).unwrap();
    if let Some((window, rows)) = open {
        let had = s["openTabs"]["keptTabs"].as_object().unwrap().clone();
        let mut kept = had.clone();
        let (mut tabs, mut tab_space) = (serde_json::Map::new(), serde_json::Map::new());
        for r in rows {
            let Some(k) = had.get(&r.item) else { continue };
            let Some(space) = k["spaceId"].as_str() else { continue };
            let mut tab = json!({ "id": r.number, "windowId": window, "index": r.index, "title": k["title"], "url": k["url"],
                                  "favIconUrl": k["favIconUrl"], "active": r.active, "lastActive": k["lastActive"], "mid": r.item,
                                  "order": k["order"] });
            for key in ["pinnedBy", "favoriteId", "customTitle"] {
                if let Some(v) = k[key].as_str().filter(|v| !v.is_empty()) {
                    tab[key] = json!(v);
                }
            }
            for (key, on) in [("audible", r.audible), ("muted", r.muted), ("visible", r.visible)] {
                if on {
                    tab[key] = json!(true);
                }
            }
            tabs.insert(r.number.to_string(), tab);
            tab_space.insert(r.number.to_string(), json!(space));
            kept.remove(&r.item);
        }
        s["openTabs"]["tabs"] = Value::Object(tabs);
        s["openTabs"]["tabSpace"] = Value::Object(tab_space);
        s["openTabs"]["keptTabs"] = Value::Object(kept);
    }
    if let Some((settings, icons)) = tail {
        s["settings"] = settings.clone();
        s["favicons"] = icons.clone();
    }
    s
}

fn row(item: &str, number: i64, index: i64, flags: [bool; 4]) -> LiveRow {
    let [active, visible, audible, muted] = flags;
    LiveRow { item: item.into(), number, index, active, visible, audible, muted }
}

#[test]
fn a_windows_state_is_the_snapshot_with_its_open_items_as_tabs() {
    let values = json!({
        "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } },
        "tabs": {
            "t-a": { "url": "https://a/", "title": "A \"q\"", "icon": "data:x", "spaceId": "a", "order": 2.5, "lastUsed": 1762000000000u64, "pinnedBy": "p-1" },
            "t-b": { "url": "https://b/", "title": "B", "spaceId": "b", "order": 1, "lastUsed": 5, "favoriteId": "fav-1", "customTitle": "Bee" },
            "t-c": { "url": "https://c/", "title": "C", "spaceId": "a", "order": 0 },
            "t-d": { "url": "https://d/", "title": "D", "spaceId": "a", "order": 3, "customTitle": "" },
        },
        "windows": { "2": { "spaceId": "a" } },
    });
    let s = crate::library::state::state_of(values.as_object().unwrap(), &CodePointOrder);
    let parts = Parts::of(&s, false);
    let text = &parts.text;
    // Nothing open: the snapshot itself, with the tail before its last brace or none.
    assert_eq!(parts.state_text(&s, None, ""), *text);
    assert_eq!(parts.state_text(&s, Some((1, &[])), ""), *text);
    let tail = r#""settings":{"theme":"pixel"},"favicons":{"a.com":"data:i"}"#;
    assert_eq!(parts.state_text(&s, None, tail), format!("{},{tail}}}", &text[..text.len() - 1]));
    // Two open (one in front playing, one visible beside it muted), one not kept (left out), in the session's order.
    let rows = [
        row("t-b", 7, 0, [false, true, false, true]),
        row("t-x", 9, 1, [false; 4]),
        row("t-a", 3, 1, [true, false, true, false]),
    ];
    let got = parts.state_text(&s, Some((4, &rows)), tail);
    let want =
        live_reference(text, Some((4, &rows)), Some((&json!({ "theme": "pixel" }), &json!({ "a.com": "data:i" }))));
    assert_eq!(serde_json::from_str::<Value>(&got).unwrap(), want, "{got}");
    // Its text: the rows as written, in their order, and the kept ones left in theirs.
    assert!(
        got.contains(concat!(
            r#""tabs":{"7":{"id":7,"windowId":4,"index":0,"title":"B","url":"https://b/","favIconUrl":"","active":false,"lastActive":5,"mid":"t-b","order":1,"#,
            r#""favoriteId":"fav-1","customTitle":"Bee","muted":true,"visible":true},"3":{"id":3,"windowId":4,"index":1,"title":"A \"q\"","url":"https://a/","#,
            r#""favIconUrl":"data:x","active":true,"lastActive":1762000000000,"mid":"t-a","order":2.5,"pinnedBy":"p-1","audible":true}},"tabSpace":{"7":"b","3":"a"},"#,
            r#""activeSpaceByWindow":{"2":"a"},"awayByWindow":{},"keptTabs":{"t-c":"#
        )),
        "{got}"
    );
    assert!(got.ends_with(&format!(",{tail}}}")) && !got.contains(r#""t-b":{"#));
    // The last kept tab open, the first, every one, two in the middle: the commas right.
    for open in [vec!["t-d"], vec!["t-a"], vec!["t-a", "t-b", "t-c", "t-d"], vec!["t-b", "t-c"]] {
        let rows: Vec<LiveRow> = open
            .iter()
            .enumerate()
            .map(|(i, it)| row(it, i as i64 + 1, i as i64, [i == 0, false, false, false]))
            .collect();
        let got = parts.state_text(&s, Some((1, &rows)), "");
        assert_eq!(
            serde_json::from_str::<Value>(&got).unwrap(),
            live_reference(text, Some((1, &rows)), None),
            "{open:?}"
        );
    }
}

#[test]
fn a_windows_state_on_generated_libraries_is_lives() {
    // Libraries of every size with items of every shape (bound to a pin or favorite or not, a custom title or an empty
    // one, odd strings, a space or none), any of them open in any order with any flags, a row for an item not kept: the
    // text parsed is HostedSession's `live` of the snapshot, the tail where it was set.
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n.max(1)
    };
    let odd = ["", "a", "\"", "\\", "\u{1}", "é", "😀", "\u{2028}", "x y"];
    for case in 0..400 {
        let n = next(12) as usize;
        let mut tabs = serde_json::Map::new();
        for i in 0..n {
            let mut v = json!({ "url": format!("https://{i}.example/{}", odd[next(9) as usize]), "title": odd[next(9) as usize],
                                "spaceId": (["a", "b", ""][next(3) as usize]), "order": next(50) as f64 / 4.0, "lastUsed": next(1_000_000) });
            for key in ["pinnedBy", "favoriteId", "customTitle"] {
                if next(3) == 0 {
                    v[key] = json!((["", "p-1", "fav-x", "Name"][next(4) as usize]));
                }
            }
            tabs.insert(format!("t-{}", next(40)), v);
        }
        let values =
            json!({ "spaces": { "a": { "name": "A" } }, "tabs": tabs, "windows": { "1": { "spaceId": "a" } } });
        let s = crate::library::state::state_of(values.as_object().unwrap(), &CodePointOrder);
        let parts = Parts::of(&s, case % 2 == 0);
        let mut items: Vec<String> = s.kept.keys().map(|k| k.to_string()).collect();
        items.push("t-none".into());
        let mut rows = Vec::new();
        for (i, item) in items.iter().enumerate() {
            if next(2) == 0 {
                let f = next(16);
                rows.push(row(
                    item,
                    (i as i64 + 1) * 3,
                    rows.len() as i64,
                    [f & 1 != 0, f & 2 != 0, f & 4 != 0, f & 8 != 0],
                ));
            }
        }
        if next(2) == 0 {
            rows.reverse();
        }
        let open = (next(4) != 0).then_some((next(5) as i64, rows.as_slice()));
        let with_tail = next(2) == 0;
        let tail = if with_tail { r#""settings":{"k":1},"favicons":{}"# } else { "" };
        let got = parts.state_text(&s, open, tail);
        let want = live_reference(&parts.text, open, with_tail.then_some((&json!({ "k": 1 }), &json!({}))));
        assert_eq!(serde_json::from_str::<Value>(&got).unwrap(), want, "case {case}: {got}");
    }
}

#[test]
fn a_space_s_background_in_the_text_and_the_values() {
    let id = "f".repeat(64);
    let values = json!({ "spaces": { "a": { "name": "A", "emoji": "", "color": "#f7c7d3", "order": 0, "theme": "pixel",
        "background": { "colors": ["#F7C7D3", "#cfe8f7"], "intensity": 0.555, "texture": "tweed", "amount": 1,
                        "appearance": "light", "image": { "id": id, "focus": [0, 0.1] } } } } });
    let text = snapshot(values.as_object().unwrap(), &CodePointOrder);
    let want = format!(
        r##"{{"id":"a","name":"A","emoji":"","color":"#f7c7d3","browser":"safari","profile":null,"theme":"pixel","background":{{"colors":["#f7c7d3","#cfe8f7"],"wheel":"analogous","intensity":0.56,"texture":"tweed","amount":1,"appearance":"light","image":{{"id":"{id}","fit":"cover","focus":[0,0.1]}}}}}}"##
    );
    assert!(text.contains(&want), "{text}");
    let parsed: Value = serde_json::from_str(&text).expect("valid JSON");
    let s = state_of(values.as_object().unwrap(), &CodePointOrder);
    let stored = crate::library::values::values_of(&s, &serde_json::Map::new());
    assert_eq!(stored["spaces"]["a"]["background"], parsed["spaces"][0]["background"], "stored as drawn");
    let none = json!({ "spaces": { "a": { "name": "A", "order": 0, "background": { "colors": [] } } } });
    assert!(!snapshot(none.as_object().unwrap(), &CodePointOrder).contains("background"), "none: no key");
}
