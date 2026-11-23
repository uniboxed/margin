//! The session's pure rules (margin-core's `session`: docs/CORE-REFACTOR.md step 3, commit 1) for the Mac app's
//! Swift, with no object: the rare ones by one JSON call (`margin_session_rule`, `{ rule, … }` → its answer), a
//! split's room, the card's rect and a web address typed, a push for the page with the UI's numbers asked through a
//! C callback, the page's layout report read into a typed answer (Margin's window's every report: its JSON in, read
//! once; the call that keeps it in the window's Page comes with the page area's moving, part 7). Nothing here panics on what it's given: a bad request is `{"error": …}`.

use std::ffi::c_void;

use margin_core::host::layout::Size;
use margin_core::host::model::Role;
use margin_core::json::{self, Object};
use margin_core::protocol::PageLayout;
use margin_core::session::card::{self, WebAddress};
use margin_core::session::layout::{self, PaneRoom};
use margin_core::session::start::{self, Candidate};
use margin_core::session::target::Target;
use margin_core::session::{choice, push, ui};
use serde_json::{Value, json};

use crate::data::{answer, text};
use crate::{MarginRect, MarginSize};

fn strings(v: Option<&Value>) -> Vec<&str> {
    json::array(v).into_iter().flatten().filter_map(Value::as_str).collect()
}

fn rule(req: &Object) -> Value {
    match json::string(req.get("rule")).unwrap_or("") {
        "constants" => json!({
            "paneLeast": [layout::PANE_LEAST.width, layout::PANE_LEAST.height],
            "noRoomReason": layout::NO_ROOM_REASON,
            "pushForwarded": push::FORWARDED.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
            "pushStanding": push::STANDING,
            "imageLimit": push::IMAGE_LIMIT,
        }),
        "resolve" => {
            let linked = strings(req.get("linked"));
            json!({ "profile": choice::resolve(json::string(req.get("profile")), &linked) })
        }
        "loaderApp" => {
            let app = req.get("target").and_then(Target::read).and_then(|t| start::loader_app(&t).map(str::to_owned));
            json!({ "app": app })
        }
        "lastItem" => {
            let items = json::array(req.get("items")).map_or(&[][..], Vec::as_slice);
            let candidates = items.iter().filter_map(|i| {
                let o = i.as_object()?;
                Some(Candidate {
                    id: json::string(o.get("id"))?,
                    value: o.get("value")?,
                    target: o.get("target").and_then(Target::read),
                })
            });
            match start::last_item(candidates) {
                Some(l) => json!({ "item": l.item, "name": l.name, "app": l.app }),
                None => json!({ "item": null }),
            }
        }
        "searchUrl" => {
            json!({ "url": ui::search_url(json::string(req.get("query")).unwrap_or(""), json::string(req.get("template"))) })
        }
        "dragLine" => {
            let n = |k: &str| json::int(req.get(k)).unwrap_or(0);
            let b = |k: &str| json::boolean(req.get(k)).unwrap_or(false);
            json!({ "line": layout::drag_line(b("divider"), n("window"), b("following"), n("follow"), n("visible")) })
        }
        "pushEmpty" => json!({ "push": json::string(req.get("type")).and_then(push::empty) }),
        "target" => json!({ "target": req.get("target").and_then(Target::read).map(|t| t.json()) }),
        "defaultBrowser" => {
            let (name, bundle, supported) = choice::default_browser(json::string(req.get("setting")));
            json!({ "name": name, "bundleId": bundle, "supported": supported })
        }
        other => json!({ "error": format!("no such rule: {other}") }),
    }
}

/// One of the session's rare rules: `{ rule, … }` → its answer (JSON, freed with `margin_buffer_free`): `constants`,
/// `resolve { profile, linked }`, `loaderApp { target }`, `lastItem { items: [{ id, value, target }] }`, `searchUrl
/// { query, template }`, `dragLine { divider, window, following, follow, visible }`, `pushEmpty { type }`, `target
/// { target }` (ItemTarget's JSON read with its rules, written back as it writes it, or null), `defaultBrowser
/// { setting }`.
///
/// # Safety
/// `request` points to `len` readable bytes; `out_len` is writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_rule(request: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    answer(&rule(o), out_len)
}

/// Whether a failure's words mean no room for a pane (session/layout.rs `is_no_room`). False: no text.
///
/// # Safety
/// `why` points to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_is_no_room(why: *const u8, len: usize) -> bool {
    text(why, len).is_some_and(layout::is_no_room)
}

/// One pane of a split, as `margin_session_no_room` weighs it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPaneRoom {
    /// 0 main, 1 a pane, 2 a card.
    pub role: u8,
    pub has_rect: bool,
    pub rect: MarginRect,
    pub has_least: bool,
    pub least: MarginSize,
    /// In the split before.
    pub had: bool,
}

/// Which of `n` panes leave a split laid out at their rects in `page` (session/layout.rs `no_room`): true, and
/// `leave[i]` for each pane that does (in the panes' order); false: every pane fits (or no panes).
///
/// # Safety
/// `panes` points to `n` readable panes, `leave` to `n` writable bools (both may be null when `n` is 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_no_room(
    panes: *const MarginPaneRoom,
    n: usize,
    page: MarginRect,
    leave: *mut bool,
) -> bool {
    if n == 0 || panes.is_null() || leave.is_null() {
        return false;
    }
    // SAFETY: the caller's contract above.
    let (panes, leave) = unsafe { (std::slice::from_raw_parts(panes, n), std::slice::from_raw_parts_mut(leave, n)) };
    // (Items as their place in the list: the answer names them by it.)
    let names: Vec<String> = (0..n).map(|i| i.to_string()).collect();
    let rooms: Vec<PaneRoom<'_>> = panes
        .iter()
        .zip(&names)
        .map(|(p, item)| PaneRoom {
            item,
            role: match p.role {
                0 => Role::Main,
                1 => Role::Pane,
                _ => Role::Card,
            },
            rect: p.has_rect.then(|| p.rect.into()),
            least: p.has_least.then(|| Size::from(p.least)),
        })
        .collect();
    let had: Vec<&str> = panes.iter().zip(&names).filter(|(p, _)| p.had).map(|(_, n)| n.as_str()).collect();
    leave.fill(false);
    let Some(out) = layout::no_room(&rooms, page.into(), &had) else { return false };
    for i in out.iter().filter_map(|s| s.parse::<usize>().ok()) {
        if let Some(l) = leave.get_mut(i) {
            *l = true;
        }
    }
    true
}

/// Margin's default card rect in a page area (session/card.rs `default_card_rect`).
#[unsafe(no_mangle)]
pub extern "C" fn margin_card_default_rect(page: MarginRect) -> MarginRect {
    card::default_card_rect(page.into()).into()
}

/// Whether a text is a web address (session/card.rs `web_address_parts`): 0 no, 1 yes, 2 yes if the OS's IDNA makes
/// a valid ASCII name of its host, the `*host_len` bytes at `*host_at` (written only then). Nothing allocated.
///
/// # Safety
/// `s` points to `len` readable bytes; `host_at` and `host_len` are writable (or null: a 2 is then a 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_web_address(s: *const u8, len: usize, host_at: *mut usize, host_len: *mut usize) -> u8 {
    let Some(s) = text(s, len) else { return 0 };
    match card::web_address_parts(s) {
        WebAddress::Yes => 1,
        WebAddress::No => 0,
        WebAddress::Host(r) => {
            if host_at.is_null() || host_len.is_null() {
                return 0;
            }
            // SAFETY: both writable (the contract).
            unsafe {
                *host_at = r.start;
                *host_len = r.len();
            }
            2
        }
    }
}

/// The UI's number for a copy's tab, given the entry it's in (`len` bytes of its JSON): the number, or a negative one
/// when it isn't one of Margin's items.
pub type MarginPushTab = extern "C" fn(ctx: *mut c_void, entry: *const u8, len: usize) -> i64;

/// A copy's push as a Margin window's page gets it (session/push.rs `page`): `{ push }`, `null` when its type isn't
/// passed on. `tab` is asked during the call, once for each entry read, in their order.
///
/// # Safety
/// `msg` points to `len` readable bytes; `out_len` is writable; `ctx` is the callback's own.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_push_page(
    msg: *const u8,
    len: usize,
    ctx: *mut c_void,
    tab: MarginPushTab,
    out_len: *mut usize,
) -> *mut u8 {
    let Some(v) = text(msg, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = v.as_object() else { return answer(&json!({ "push": null }), out_len) };
    let mut ask = |entry: &Object| {
        let bytes = Value::Object(entry.clone()).to_string();
        let n = tab(ctx, bytes.as_ptr(), bytes.len());
        (n >= 0).then_some(n)
    };
    answer(&json!({ "push": push::page(o, &mut ask) }), out_len)
}

/// A text the core wrote: `len` bytes at `at` of the caller's buffer.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarginText {
    pub at: usize,
    pub len: usize,
}

/// The page's layout report as the core read it (protocol.rs `PageLayout`): its numbers, its four radii, what it was
/// measured for, and its texts (the mode, up to four fills, a split and up to four panes' items) in the caller's
/// buffer.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPageLayout {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub radius: f64,
    pub radii: [f64; 4],
    pub width: f64,
    pub height: f64,
    pub outside: bool,
    pub hosted: bool,
    pub mode: MarginText,
    /// 0 or 4.
    pub fill_count: u8,
    pub fills: [MarginText; 4],
    pub has_split: bool,
    pub split: MarginText,
    /// 0, or 2 to 4.
    pub pane_count: u8,
    pub pane_items: [MarginText; 4],
    pub pane_rects: [MarginRect; 4],
}

/// The page's layout report (`geometry`'s JSON, as the page sends it) read (protocol.rs `PageLayout::from_geometry`)
/// into `out`, its texts into `text` (`cap` bytes): the bytes its texts take (more than `cap`: nothing written, ask
/// again with that much room), or -1 when it isn't one. Its JSON is read once; nothing else is allocated.
///
/// # Safety
/// `geometry` points to `len` readable bytes; `out` is writable; `text` points to `cap` writable bytes (or is null
/// with `cap` 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_layout_read(
    geometry: *const u8,
    len: usize,
    out: *mut MarginPageLayout,
    text: *mut u8,
    cap: usize,
) -> isize {
    if out.is_null() {
        return -1;
    }
    let parsed = crate::data::text(geometry, len).and_then(|t| serde_json::from_str::<Value>(t).ok());
    let Some(l) = parsed.as_ref().and_then(Value::as_object).and_then(PageLayout::from_geometry) else { return -1 };
    let texts = std::iter::once(l.mode.as_str())
        .chain(l.fills.iter().map(String::as_str))
        .chain(l.split.as_deref())
        .chain(l.panes.iter().map(|p| p.item.as_str()));
    let need: usize = texts.clone().map(str::len).sum();
    if need > cap || (need > 0 && text.is_null()) {
        return need as isize;
    }
    // SAFETY: `text` has `cap` writable bytes (the contract), `need` of them used.
    let buffer = if need == 0 { &mut [][..] } else { unsafe { std::slice::from_raw_parts_mut(text, need) } };
    let mut at = 0;
    let mut put = |s: &str| {
        buffer[at..at + s.len()].copy_from_slice(s.as_bytes());
        at += s.len();
        MarginText { at: at - s.len(), len: s.len() }
    };
    let mut o = MarginPageLayout {
        left: l.left,
        top: l.top,
        right: l.right,
        bottom: l.bottom,
        radius: l.radius,
        width: l.width,
        height: l.height,
        outside: l.outside,
        hosted: l.hosted,
        ..MarginPageLayout::default()
    };
    for (i, r) in l.radii.iter().take(4).enumerate() {
        o.radii[i] = *r;
    }
    o.mode = put(&l.mode);
    o.fill_count = l.fills.len().min(4) as u8;
    for (i, f) in l.fills.iter().take(4).enumerate() {
        o.fills[i] = put(f);
    }
    if let Some(split) = &l.split {
        o.has_split = true;
        o.split = put(split);
    }
    o.pane_count = l.panes.len().min(4) as u8;
    for (i, p) in l.panes.iter().take(4).enumerate() {
        o.pane_items[i] = put(&p.item);
        o.pane_rects[i] = p.rect.into();
    }
    // SAFETY: out writable (checked non-null; the contract).
    unsafe { *out = o };
    need as isize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(req: Value) -> Value {
        let t = req.to_string();
        let mut len = 0;
        // SAFETY: the request's bytes, a writable length.
        let out = unsafe { margin_session_rule(t.as_ptr(), t.len(), &mut len) };
        // SAFETY: a buffer margin_session_rule made, `len` bytes.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: as made.
        unsafe { crate::margin_buffer_free(out, len) };
        v
    }

    #[test]
    fn the_rules_by_json() {
        assert_eq!(call(json!({"rule":"constants"}))["paneLeast"], json!([220.0, 220.0]));
        assert_eq!(call(json!({"rule":"resolve","profile":null,"linked":["b","a"]}))["profile"], json!("a"));
        assert_eq!(call(json!({"rule":"loaderApp","target":{"kind":"margin","page":"settings"}}))["app"], Value::Null);
        assert_eq!(
            call(json!({"rule":"loaderApp","target":{"kind":"web","browser":"safari","profile":null}}))["app"],
            json!("com.apple.Safari")
        );
        let last = call(json!({"rule":"lastItem","items":[
            {"id":"b","value":{"selected":true,"lastUsed":5},"target":{"kind":"app","bundleId":"com.x","name":""}},
            {"id":"a","value":{"selected":true,"lastUsed":5},"target":{"kind":"app","bundleId":"com.y","name":"Y"}}]}));
        assert_eq!(last, json!({"item":"a","name":"Y","app":"com.y"}));
        assert_eq!(call(json!({"rule":"lastItem","items":[]})), json!({"item":null}));
        assert_eq!(
            call(json!({"rule":"searchUrl","query":"a b","template":"https://e/?q=%s"}))["url"],
            json!("https://e/?q=a%20b")
        );
        assert_eq!(
            call(json!({"rule":"dragLine","divider":true,"window":1,"following":true,"follow":2,"visible":2}))["line"],
            json!("a split's divider dragged in Margin's window 1: 2 hosted windows follow it live")
        );
        assert_eq!(call(json!({"rule":"pushEmpty","type":"media"}))["push"], json!({"type":"media","sources":[]}));
        assert!(call(json!({"rule":"nope"}))["error"].is_string());
        assert!(call(json!([1]))["error"].is_string());
    }

    #[test]
    fn typed_ones() {
        let pane = |role, x: f64, w: f64, had| MarginPaneRoom {
            role,
            has_rect: true,
            rect: MarginRect { x, y: 41.0, width: w, height: 933.0 },
            has_least: true,
            least: MarginSize { width: 220.0, height: 220.0 },
            had,
        };
        let page = MarginRect { x: 240.0, y: 41.0, width: 1264.0, height: 933.0 };
        let panes = [pane(0, 240.0, 836.0, true), pane(1, 1084.0, 200.0, true), pane(1, 1292.0, 212.0, false)];
        let mut leave = [true; 3];
        // SAFETY: three panes, three bools.
        assert!(unsafe { margin_session_no_room(panes.as_ptr(), 3, page, leave.as_mut_ptr()) });
        assert_eq!(leave, [false, false, true]);
        let fits = [pane(0, 240.0, 628.0, true), pane(1, 876.0, 628.0, false)];
        // SAFETY: two panes, two bools.
        assert!(!unsafe { margin_session_no_room(fits.as_ptr(), 2, page, leave.as_mut_ptr()) });
        // SAFETY: nothing given.
        assert!(!unsafe { margin_session_no_room(std::ptr::null(), 0, page, std::ptr::null_mut()) });
        let why = "below its window's minimum";
        // SAFETY: the text's bytes.
        assert!(unsafe { margin_session_is_no_room(why.as_ptr(), why.len()) });
        let card = margin_card_default_rect(MarginRect { x: 0.0, y: 0.0, width: 500.0, height: 400.0 });
        assert_eq!(card, MarginRect { x: 40.0, y: 66.0, width: 420.0, height: 320.0 });
        let (mut at, mut n) = (0, 0);
        for (s, want) in [("https://a/", 1), ("about:blank", 0), ("http://é.com/", 2)] {
            // SAFETY: the text's bytes, two writable lengths.
            assert_eq!(unsafe { margin_web_address(s.as_ptr(), s.len(), &mut at, &mut n) }, want, "{s}");
        }
        assert_eq!((at, n), (7, 6));
    }

    extern "C" fn plus_thousand(_ctx: *mut c_void, entry: *const u8, len: usize) -> i64 {
        // SAFETY: the entry's bytes, during the call.
        let v: Value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(entry, len) }).unwrap_or(Value::Null);
        json::int(v.get("tabId")).map_or(-1, |t| t + 1000)
    }

    #[test]
    fn a_push_and_a_layout() {
        let msg = json!({"type":"media","sources":[{"tabId":3,"title":"x"},{"title":"no tab"}]}).to_string();
        let mut len = 0;
        // SAFETY: the message's bytes, a writable length, a callback that reads only what it's given.
        let out = unsafe { margin_push_page(msg.as_ptr(), msg.len(), std::ptr::null_mut(), plus_thousand, &mut len) };
        // SAFETY: as made.
        let v: Value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: as made.
        unsafe { crate::margin_buffer_free(out, len) };
        assert_eq!(v["push"]["sources"].as_array().map(Vec::len), Some(1));
        assert_eq!(v["push"]["sources"][0]["tabId"], json!(1003));
        let g = json!({"insets":{"left":260,"top":8,"right":8,"bottom":8},"container":{"width":1512,"height":949},"radius":6,"fills":["a","b","c","dd"],"split":"s","panes":[{"id":"a","rect":[0,0,1,1]},{"id":"bc","rect":[2,0,1.5,1]}]}).to_string();
        let mut l = MarginPageLayout::default();
        // SAFETY: the report's bytes, a writable layout, no room for its texts.
        let need = unsafe { margin_page_layout_read(g.as_ptr(), g.len(), &mut l, std::ptr::null_mut(), 0) };
        assert_eq!(need, "fullscreen".len() as isize + 5 + 1 + 3, "the room its texts take");
        assert_eq!(l, MarginPageLayout::default(), "nothing written without the room");
        let mut text = [0u8; 64];
        // SAFETY: the report's bytes, a writable layout, 64 writable bytes.
        let used = unsafe { margin_page_layout_read(g.as_ptr(), g.len(), &mut l, text.as_mut_ptr(), text.len()) };
        assert_eq!(used, need);
        let t = |m: MarginText| std::str::from_utf8(&text[m.at..m.at + m.len]).unwrap_or("?").to_owned();
        assert_eq!((l.left, l.radius, l.radii, l.width, l.hosted), (260.0, 6.0, [6.0; 4], 1512.0, false));
        assert_eq!(
            (t(l.mode), l.fill_count, t(l.fills[3]), l.has_split, t(l.split), l.pane_count),
            ("fullscreen".into(), 4, "dd".into(), true, "s".into(), 2)
        );
        assert_eq!(
            (t(l.pane_items[1]), l.pane_rects[1]),
            ("bc".into(), MarginRect { x: 2.0, y: 0.0, width: 1.5, height: 1.0 })
        );
        let bad = "{\"insets\":1}";
        // SAFETY: the bytes, a writable layout, the buffer.
        assert_eq!(
            unsafe { margin_page_layout_read(bad.as_ptr(), bad.len(), &mut l, text.as_mut_ptr(), text.len()) },
            -1
        );
    }
}
