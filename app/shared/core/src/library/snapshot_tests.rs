// snapshot.rs against library.ts: `JSON.stringify(snapshot(values))` for one library with every record kind, the
// escapes, the numbers' spellings and the windows' key order (library.ts's text recorded from Node, 2026-11-23). The
// generated libraries' texts compared with library.ts's are counted in DECISIONS.md.

use super::*;
use crate::library::js::CodePointOrder;
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
