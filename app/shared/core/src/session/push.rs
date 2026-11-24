//! The pushes of a browser's copy (its `push { windowId, msg }`, docs/PROTOCOL.md) that reach a Margin window's page
//! (UIPush.swift; docs/CORE-REFACTOR.md step 3, part 9): only the types listed here, and of each only the fields
//! listed, each checked and cut to its size (never the copy's JSON as it came). A copy's tab is never named to the
//! page by its own id: by the UI's number for the item it shows (the caller's `tab`), and an entry whose tab isn't
//! one of Margin's items is dropped.
//!
//! A new one is one line of `FORWARDED`: its type and its fields (and, for a push that says what is now rather than
//! that something happened, its type in `STANDING` too: taken back from a window that no longer gets it).

use serde_json::{Map, Value};

use crate::json::{self, Object};
use crate::protocol::number;

/// One field of a push as the page gets it.
#[derive(Clone, Copy, Debug)]
pub enum Field {
    /// A string, at most that many Unicode scalars ("" when not one). (The Swift counted `Character`s: a text cut here
    /// can keep fewer characters than before when it has combining marks or joined emoji; step 1's rule.)
    Text(usize),
    /// An image data URL (PNG, JPEG, WebP, GIF; base64; at most `IMAGE_LIMIT` bytes, the UI's own limit), else null.
    Image,
    /// true or false (false when not one; a number 1 or 0 is one, as Swift's `as? Bool` reads JSONSerialization's).
    Flag,
    /// A time in ms since 1970 (0 when not one), rounded half away from zero.
    Time,
    /// …or null.
    OptionalTime,
    /// The copy's tab: the UI's number for its item; not one of Margin's items: the entry is dropped.
    Tab,
    /// At most that many objects, each with these fields (no more than twice as many read).
    List(usize, &'static [(&'static str, Field)]),
}

const SOURCE: &[(&str, Field)] = &[
    ("tabId", Field::Tab),
    ("title", Field::Text(140)),
    ("subtitle", Field::Text(100)),
    ("artwork", Field::Image),
    ("playing", Field::Flag),
    ("muted", Field::Flag),
    ("canPrev", Field::Flag),
    ("canNext", Field::Flag),
    ("updatedAt", Field::Time),
    ("pausedAt", Field::OptionalTime),
];

/// The types passed on, and their fields.
pub const FORWARDED: &[(&str, &[(&str, Field)])] = &[
    // The background mini player's sources for one of the copy's windows (background/media.ts, M2.4).
    ("media", &[("sources", Field::List(8, SOURCE))]),
    // A word of Margin's in the theme's toast (overlay.ts `toast`).
    ("toast", &[("text", Field::Text(140))]),
];

/// The pushes that say what is now (the window they were last given to gets the empty one when another gets it).
pub const STANDING: &[&str] = &["media"];

pub const IMAGE_LIMIT: usize = 128 * 1024;

fn fields(kind: &str) -> Option<&'static [(&'static str, Field)]> {
    FORWARDED.iter().find(|(k, _)| *k == kind).map(|(_, f)| *f)
}

/// Whether a type is passed on to the page.
pub fn forwarded(kind: &str) -> bool {
    fields(kind).is_some()
}

/// The push as the page gets it, or `None`: not a type passed on. `tab`: the UI's number for a copy's tab, given the
/// whole entry it's in (its `tabId`, `itemId`, `url`), `None` when it isn't one of Margin's items; asked once for each
/// entry read, in their order (a list's first twice-its-cap objects, those dropped later too).
pub fn page(msg: &Object, tab: &mut dyn FnMut(&Object) -> Option<i64>) -> Option<Object> {
    let kind = json::string(msg.get("type"))?;
    let f = fields(kind)?;
    let mut out = object(msg, f, tab).unwrap_or_default();
    out.insert("type".into(), Value::from(kind));
    Some(out)
}

/// The empty push of a standing type (its lists empty, its flags false): what a window no longer given it gets.
pub fn empty(kind: &str) -> Option<Object> {
    if !STANDING.contains(&kind) {
        return None;
    }
    let mut msg = Map::new();
    msg.insert("type".into(), Value::from(kind));
    page(&msg, &mut |_| None)
}

fn object(raw: &Object, fields: &[(&str, Field)], tab: &mut dyn FnMut(&Object) -> Option<i64>) -> Option<Object> {
    let mut out = Map::new();
    for &(key, field) in fields {
        let v = if let Field::Tab = field { Value::from(tab(raw)?) } else { value(raw.get(key), field, tab) };
        out.insert(key.into(), v);
    }
    Some(out)
}

fn value(v: Option<&Value>, field: Field, tab: &mut dyn FnMut(&Object) -> Option<i64>) -> Value {
    match field {
        Field::Text(max) => Value::from(json::string(v).map_or(String::new(), |s| s.chars().take(max).collect())),
        Field::Image => json::string(v).filter(|s| is_image(s)).map_or(Value::Null, Value::from),
        Field::Flag => Value::from(json::flag(v).unwrap_or(false)),
        Field::Time => time(v).unwrap_or_else(|| Value::from(0)),
        Field::OptionalTime => time(v).unwrap_or(Value::Null),
        Field::Tab => Value::Null, // (an object's: `object`)
        Field::List(max, fields) => {
            let raw = json::array(v).map_or(&[][..], Vec::as_slice);
            let objects = raw.iter().take(max * 2).filter_map(Value::as_object);
            // (Every object read is weighed, its tab asked, before the cap: as the Swift's compactMap did.)
            let all: Vec<Value> = objects.filter_map(|o| object(o, fields, tab)).map(Value::Object).collect();
            Value::Array(all.into_iter().take(max).collect())
        }
    }
}

fn time(v: Option<&Value>) -> Option<Value> {
    let d = json::num(v).filter(|d| *d >= 0.0 && *d < 1e15)?;
    number(d.round())
}

/// `^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$` as NSRegularExpression matches it (its `$` also
/// before one line terminator that ends the text), at most `IMAGE_LIMIT` bytes.
pub fn is_image(s: &str) -> bool {
    if s.len() > IMAGE_LIMIT {
        return false;
    }
    let Some(rest) = s.strip_prefix("data:image/") else { return false };
    let Some(rest) = ["png", "jpeg", "webp", "gif"].iter().find_map(|k| rest.strip_prefix(k)) else { return false };
    let Some(rest) = rest.strip_prefix(";base64,") else { return false };
    let body = rest.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/').count();
    if body == 0 {
        return false;
    }
    let rest = &rest[body..];
    let pad = rest.bytes().take_while(|b| *b == b'=').count();
    if pad > 2 {
        return false;
    }
    matches!(&rest[pad..], "" | "\n" | "\r" | "\r\n" | "\u{0B}" | "\u{0C}" | "\u{85}" | "\u{2028}" | "\u{2029}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Object {
        v.as_object().cloned().unwrap_or_default()
    }
    fn tab(entry: &Object) -> Option<i64> {
        json::int(entry.get("tabId")).map(|t| t + 1000)
    }

    // ---- T/session-rules-tests.swift uiPushCapTests, T/hosted-tests.swift 880-926 ----

    #[test]
    fn a_toast() {
        let t = page(&obj(json!({"type":"toast","text":"a".repeat(141),"extra":1})), &mut tab).unwrap_or_default();
        assert_eq!(t.get("text").and_then(Value::as_str).map(|s| s.chars().count()), Some(140));
        assert_eq!(t.len(), 2, "its text and type only");
        assert_eq!(
            page(&obj(json!({"type":"toast","text":5})), &mut tab).and_then(|t| t.get("text").cloned()),
            Some(json!(""))
        );
        assert_eq!(page(&obj(json!({"type":"secret"})), &mut tab), None);
        assert_eq!(page(&obj(json!({"text":"x"})), &mut tab), None);
        // (Scalars: a letter and its mark are two; 280 of them cut at 140, 70 characters.)
        let marks = "e\u{301}".repeat(141);
        let cut = page(&obj(json!({"type":"toast","text":marks})), &mut tab)
            .and_then(|t| t.get("text").and_then(Value::as_str).map(str::to_owned));
        assert_eq!(cut.map(|s| s.chars().count()), Some(140));
    }

    fn source(i: i64) -> Value {
        json!({"tabId": i, "title": format!("t{i}"), "subtitle": "s", "artwork": format!("data:image/png;base64,{}", "A".repeat(IMAGE_LIMIT - 22)),
               "playing": true, "muted": false, "canPrev": 1, "canNext": "yes", "updatedAt": 1_700_000_000_000.5_f64, "pausedAt": null})
    }

    #[test]
    fn the_mini_players_sources() {
        let mut list: Vec<Value> = (0..20).map(source).collect();
        list.push(json!("not an object"));
        let mut seen = 0;
        let m = page(&obj(json!({"type":"media","sources":list})), &mut |e| {
            seen += 1;
            tab(e)
        })
        .unwrap_or_default();
        let sources = m.get("sources").and_then(Value::as_array).cloned().unwrap_or_default();
        assert_eq!((sources.len(), seen), (8, 16), "8 passed, 16 read, each one's tab asked");
        let first = sources.first().and_then(Value::as_object).cloned().unwrap_or_default();
        assert_eq!(first.get("tabId"), Some(&json!(1000)));
        assert_eq!(first.get("canPrev"), Some(&json!(true)));
        assert_eq!(first.get("canNext"), Some(&json!(false)));
        assert_eq!(first.get("updatedAt"), Some(&json!(1_700_000_000_001_i64)), "half away from zero");
        assert_eq!(first.get("pausedAt"), Some(&Value::Null));
        assert!(first.get("artwork").is_some_and(Value::is_string), "an image at the limit kept");
        assert_eq!(first.len(), 10);
        let mut big = source(1);
        big["artwork"] = json!(format!("data:image/png;base64,{}", "A".repeat(IMAGE_LIMIT - 21)));
        big["updatedAt"] = json!(-1);
        big["pausedAt"] = json!(1e15);
        big["subtitle"] = json!("b".repeat(101));
        let one = page(&obj(json!({"type":"media","sources":[big]})), &mut tab).unwrap_or_default();
        let one = &one["sources"][0];
        assert_eq!(
            (one["artwork"].clone(), one["updatedAt"].clone(), one["pausedAt"].clone()),
            (Value::Null, json!(0), Value::Null)
        );
        assert_eq!(one["subtitle"].as_str().map(str::len), Some(100));
        let dropped =
            page(&obj(json!({"type":"media","sources":[source(1), {"title":"no tab"}, source(2)]})), &mut |e| {
                if json::int(e.get("tabId")) == Some(1) { None } else { tab(e) }
            })
            .unwrap_or_default();
        assert_eq!(
            dropped["sources"].as_array().map(|a| a.iter().map(|s| s["tabId"].clone()).collect::<Vec<_>>()),
            Some(vec![json!(1002)])
        );
        assert_eq!(
            page(&obj(json!({"type":"media","sources":"x"})), &mut tab).map(|m| m["sources"].clone()),
            Some(json!([]))
        );
    }

    #[test]
    fn images() {
        let ok = [
            "data:image/jpeg;base64,AAAA",
            "data:image/webp;base64,AA==",
            "data:image/gif;base64,A",
            "data:image/png;base64,AA==\n",
            "data:image/png;base64,A=\r\n",
            "data:image/png;base64,AA\u{2029}",
        ];
        let no = [
            "data:image/svg+xml;base64,AAAA",
            "data:image/png;base64,AA=A",
            "data:image/png;base64,",
            "DATA:image/png;base64,AA",
            "data:image/png;base64,AA===",
            "data:image/png;base64,AA\n\n",
            "data:image/png;base64,AA\n\r",
            "data:image/png;base64,AA ",
            "\ndata:image/png;base64,AA",
            "data:image/PNG;base64,AA",
        ];
        assert!(ok.iter().all(|s| is_image(s)), "{ok:?}");
        assert!(!no.iter().any(|s| is_image(s)), "{no:?}");
    }

    #[test]
    fn standing_ones() {
        assert_eq!(empty("media").map(|m| m["sources"].clone()), Some(json!([])));
        assert_eq!(empty("toast"), None);
        assert!(forwarded("media") && forwarded("toast") && !forwarded("peekOpen"));
    }
}
