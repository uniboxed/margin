//! The windows a browser's copy makes and drives for the app (docs/PROTOCOL.md "Hosted windows",
//! docs/HOSTED-WINDOWS-CHROMIUM.md §3.2): Safari's, Chrome's and Edge's alike. The copy's end is
//! extension/background/hosted.ts and handlers.ts (`newWindow`, `setWindowState`, `closeWindow`, `hostFocusWindow`); this is
//! the app's: each request as the `req`'s type and payload, checked as the copy checks it (so a request the copy would
//! refuse is never sent), and each answer read as untrusted JSON. One place for every app that hosts a browser (the
//! Windows shell now; the Mac's session as it moves to the core). Sans IO: the caller sends the request on the link.
//!
//! Also here: a host's id for a browser window (`<browser>:<profile>[#role]`, the Mac's `safari:<profile>` kept), and a
//! window's mark (`newWindow { mark }`: the window's title then has `Margin <mark>`, how Windows finds its `HWND`).
//!
//! The checks' vectors are shared with the copy's tests: tests/fixtures/hosted-browser.json.

use serde_json::Value;

use crate::geometry::Rect;
use crate::json::{self, Object};

/// The browsers a web item can be hosted in.
pub const BROWSERS: [&str; 3] = ["safari", "chrome", "edge"];
/// The preview card's item (hosted.ts `CARD_ITEM`): its page in the card's window only.
pub const CARD_ITEM: &str = "peek-card";
/// The mini player's buttons (hosted.ts `MEDIA_COMMANDS`).
pub const MEDIA_COMMANDS: [&str; 4] = ["toggle", "prev", "next", "mute"];

/// A library item's id as the copy takes it (hosted.ts `ITEM`): 1 to 256 of `A-Z a-z 0-9 _ . : -`.
pub fn valid_item(id: &str) -> bool {
    (1..=256).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

/// An address an item can show (hosted.ts `SHOWN`): a web page, or a blank page exactly.
pub fn valid_shown_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower == "about:blank"
}

/// A window's mark as the copy takes it (handlers.ts `WINDOW_MARK`): 8 to 40 ASCII letters and numerals.
pub fn valid_mark(mark: &str) -> bool {
    (8..=40).contains(&mark.len()) && mark.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// A new mark: 16 random ASCII letters and numerals (`getrandom`); None if the OS gave no randomness.
pub fn new_mark() -> Option<String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    // (62 letters: the bias of a byte modulo 62 is irrelevant for a mark that only has to be unlikely to repeat.)
    Some(bytes.iter().map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect())
}

/// Whether a window's title carries `mark` (Margin's new-tab page titled `Margin <mark>`, the browser adding its own
/// words after it: "… - Google Chrome", "… - Personal - Microsoft Edge"): the words `Margin <mark>` whole, never part
/// of a longer word.
pub fn title_has_mark(title: &str, mark: &str) -> bool {
    if !valid_mark(mark) {
        return false;
    }
    let needle = format!("Margin {mark}");
    let mut from = 0;
    while let Some(at) = title[from..].find(&needle) {
        let start = from + at;
        let end = start + needle.len();
        let before = title[..start].chars().next_back();
        let after = title[end..].chars().next();
        if before.is_none_or(|c| !c.is_alphanumeric()) && after.is_none_or(|c| !c.is_alphanumeric()) {
            return true;
        }
        from = start + 1;
    }
    false
}

/// A browser window's role among a profile's hosted windows (docs/PEEK-SPLIT.md §1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Role {
    Main,
    Card,
    /// A split's other panes, 1 to 3.
    Pane(u8),
}

impl Role {
    fn suffix(self) -> String {
        match self {
            Role::Main => String::new(),
            Role::Card => "#card".into(),
            Role::Pane(n) => format!("#pane{n}"),
        }
    }
}

/// A browser window's host id: `<browser>:<profile>` for its main window (Safari's as the Mac has always had it),
/// `#card` and `#pane1`…`#pane3` for the others. None: not a browser Margin hosts, no profile, or a pane out of range.
pub fn host_id(browser: &str, profile: &str, role: Role) -> Option<String> {
    if !BROWSERS.contains(&browser) || profile.is_empty() || matches!(role, Role::Pane(n) if !(1..=3).contains(&n)) {
        return None;
    }
    Some(format!("{browser}:{profile}{}", role.suffix()))
}

/// A host id read back: its browser, profile and role. None: not a browser window's.
pub fn parse_host_id(id: &str) -> Option<(&str, &str, Role)> {
    let (browser, rest) = id.split_once(':')?;
    if !BROWSERS.contains(&browser) {
        return None;
    }
    let (profile, role) = match rest.split_once('#') {
        None => (rest, Role::Main),
        Some((p, "card")) => (p, Role::Card),
        Some((p, pane)) => {
            let n: u8 = pane.strip_prefix("pane")?.parse().ok()?;
            if !(1..=3).contains(&n) {
                return None;
            }
            (p, Role::Pane(n))
        }
    };
    (!profile.is_empty()).then_some((browser, profile, role))
}

/// A window state the app asks of a copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Fullscreen,
    Normal,
}

/// One request to a copy about the windows it makes and drives for the app.
#[derive(Clone, Debug, PartialEq)]
pub enum Ask {
    /// A window for the app (`hosted`: its state the app's from now on; `mark`: titled with it; `url`: an address a
    /// card's or pane's window opens at, never the new-tab page; `item`: a pane's window made around that item's tab).
    NewWindow {
        fullscreen: bool,
        hosted: bool,
        mark: Option<String>,
        url: Option<String>,
        item: Option<String>,
    },
    /// The item's page shown in that window (`role` card: the card's window; `fresh`: a new preview; `pinned`: its
    /// item is a pin's or favorite's, for auto-preview).
    Show {
        window_id: i64,
        item: String,
        url: String,
        card: bool,
        fresh: bool,
        pinned: Option<bool>,
    },
    Close {
        item: String,
    },
    Picture {
        window_id: i64,
        item: String,
    },
    Mute {
        item: String,
        muted: Option<bool>,
    },
    Navigate {
        item: String,
        url: String,
    },
    Media {
        item: String,
        command: String,
        tab_id: Option<i64>,
    },
    PromotePeek {
        from: String,
        to_window: i64,
        to_item: String,
    },
    CardClose,
    /// `not_after`: milliseconds since 1970; past it the copy makes no windows call.
    FocusWindow {
        window_id: i64,
        not_after: f64,
    },
    /// `land`: false for a window the app hosts (answered as the browser takes the ask).
    SetWindowState {
        window_id: i64,
        state: State,
        focused: bool,
        not_after: Option<f64>,
        land: bool,
    },
    CloseWindow {
        window_id: i64,
        not_after: Option<f64>,
    },
}

/// Why a request wasn't made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refused {
    Item,
    Url,
    Mark,
    Window,
    Command,
    Time,
    /// The card's page outside its window, or another page in it (hosted.ts's own rule).
    CardRule,
}

impl Ask {
    /// The `req`'s type.
    pub fn kind(&self) -> &'static str {
        match self {
            Ask::NewWindow { .. } => "newWindow",
            Ask::Show { .. } => "hostShow",
            Ask::Close { .. } => "hostClose",
            Ask::Picture { .. } => "hostPicture",
            Ask::Mute { .. } => "hostMute",
            Ask::Navigate { .. } => "hostNavigate",
            Ask::Media { .. } => "hostMedia",
            Ask::PromotePeek { .. } => "hostPromotePeek",
            Ask::CardClose => "hostCardClose",
            Ask::FocusWindow { .. } => "hostFocusWindow",
            Ask::SetWindowState { .. } => "setWindowState",
            Ask::CloseWindow { .. } => "closeWindow",
        }
    }

    /// The `req`'s payload, checked as the copy checks it.
    pub fn payload(&self) -> Result<Object, Refused> {
        let mut p = Object::new();
        let item = |id: &str| if valid_item(id) { Ok(Value::from(id)) } else { Err(Refused::Item) };
        let url = |u: &str| if valid_shown_url(u) { Ok(Value::from(u)) } else { Err(Refused::Url) };
        let window = |w: i64| if w >= 0 { Ok(Value::from(w)) } else { Err(Refused::Window) };
        let time = |t: f64| if t.is_finite() { Ok(Value::from(t.round())) } else { Err(Refused::Time) };
        match self {
            Ask::NewWindow { fullscreen, hosted, mark, url: address, item: of } => {
                p.insert("fullscreen".into(), (*fullscreen).into());
                if *hosted {
                    p.insert("hosted".into(), true.into());
                }
                if let Some(m) = mark {
                    if !valid_mark(m) {
                        return Err(Refused::Mark);
                    }
                    p.insert("mark".into(), m.as_str().into());
                }
                if let Some(u) = address {
                    // (A card's or pane's page, or a blank window made ready: the copy takes nothing else, 8192 at most.)
                    if !valid_shown_url(u) || u.len() > 8192 {
                        return Err(Refused::Url);
                    }
                    p.insert("url".into(), u.as_str().into());
                }
                if let Some(i) = of {
                    if i.len() > 80 {
                        return Err(Refused::Item);
                    }
                    p.insert("itemId".into(), item(i)?);
                }
            }
            Ask::Show { window_id, item: id, url: address, card, fresh, pinned } => {
                if (id == CARD_ITEM) != *card {
                    return Err(Refused::CardRule);
                }
                p.insert("windowId".into(), window(*window_id)?);
                p.insert("itemId".into(), item(id)?);
                p.insert("url".into(), url(address)?);
                if *card {
                    p.insert("role".into(), "card".into());
                    if *fresh {
                        p.insert("fresh".into(), true.into());
                    }
                }
                if let Some(on) = pinned {
                    p.insert("pinned".into(), (*on).into());
                }
            }
            Ask::Close { item: id } => {
                p.insert("itemId".into(), item(id)?);
            }
            Ask::Picture { window_id, item: id } => {
                p.insert("windowId".into(), window(*window_id)?);
                p.insert("itemId".into(), item(id)?);
            }
            Ask::Mute { item: id, muted } => {
                p.insert("itemId".into(), item(id)?);
                if let Some(m) = muted {
                    p.insert("muted".into(), (*m).into());
                }
            }
            Ask::Navigate { item: id, url: address } => {
                p.insert("itemId".into(), item(id)?);
                p.insert("url".into(), url(address)?);
            }
            Ask::Media { item: id, command, tab_id } => {
                if !MEDIA_COMMANDS.contains(&command.as_str()) {
                    return Err(Refused::Command);
                }
                p.insert("itemId".into(), item(id)?);
                p.insert("command".into(), command.as_str().into());
                if let Some(t) = tab_id {
                    p.insert("tabId".into(), (*t).into());
                }
            }
            Ask::PromotePeek { from, to_window, to_item } => {
                p.insert("fromItemId".into(), item(from)?);
                p.insert("toWindowId".into(), window(*to_window)?);
                p.insert("toItemId".into(), item(to_item)?);
            }
            Ask::CardClose => {}
            Ask::FocusWindow { window_id, not_after } => {
                p.insert("windowId".into(), window(*window_id)?);
                p.insert("notAfter".into(), time(*not_after)?);
            }
            Ask::SetWindowState { window_id, state, focused, not_after, land } => {
                p.insert("windowId".into(), window(*window_id)?);
                let name = match state {
                    State::Fullscreen => "fullscreen",
                    State::Normal => "normal",
                };
                p.insert("state".into(), name.into());
                if *focused {
                    p.insert("focused".into(), true.into());
                }
                if let Some(t) = not_after {
                    p.insert("notAfter".into(), time(*t)?);
                }
                if !*land {
                    p.insert("land".into(), false.into());
                }
            }
            Ask::CloseWindow { window_id, not_after } => {
                p.insert("windowId".into(), window(*window_id)?);
                if let Some(t) = not_after {
                    p.insert("notAfter".into(), time(*t)?);
                }
            }
        }
        Ok(p)
    }
}

/// `newWindow`'s answer: the window's id, its state and, when the browser said, its bounds (points, the browser's
/// `windows.get` units: CSS pixels on the Mac, DIPs on Windows).
#[derive(Clone, Debug, PartialEq)]
pub struct WindowMade {
    pub window_id: i64,
    pub state: String,
    pub bounds: Option<Rect>,
}

impl WindowMade {
    pub fn read(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let window_id = json::int(o.get("windowId"))?;
        let state = json::string(o.get("state")).unwrap_or("normal").chars().take(32).collect();
        let bounds = json::object(o.get("bounds")).and_then(|b| {
            let r = Rect::new(
                json::num(b.get("left"))?,
                json::num(b.get("top"))?,
                json::num(b.get("width"))?,
                json::num(b.get("height"))?,
            );
            (r.width > 0.0 && r.height > 0.0).then_some(r)
        });
        Some(Self { window_id, state, bounds })
    }
}

/// `hostShow`'s answer: the item's tab, whether it was made or sent there for it, whether it was moved from another of
/// Margin's windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shown {
    pub tab_id: i64,
    pub created: bool,
    pub moved: bool,
}

impl Shown {
    pub fn read(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        Some(Self {
            tab_id: json::int(o.get("tabId"))?,
            created: json::boolean(o.get("created")).unwrap_or(false),
            moved: json::boolean(o.get("moved")).unwrap_or(false),
        })
    }
}

/// The most a picture can be: a 1600 px wide JPEG is well under this (hosted.ts `PICTURE`).
pub const PICTURE_MAX: usize = 8 * 1024 * 1024;

/// `hostPicture`'s answer: a JPEG or PNG data URL, or none (not the tab in front, nothing captured).
pub fn picture(v: &Value) -> Option<&str> {
    let data = json::string(v.as_object()?.get("data"))?;
    let ok = data.len() <= PICTURE_MAX
        && (data.starts_with("data:image/jpeg;base64,") || data.starts_with("data:image/png;base64,"));
    ok.then_some(data)
}

/// A windows call's answer (`setWindowState`, `closeWindow`, `hostFocusWindow`): made, or refused before anything was
/// called (late: past `notAfter`; busy: another call for that window still pending).
#[derive(Clone, Debug, PartialEq)]
pub enum WindowCall {
    Called,
    Late { past_ms: f64 },
    Busy,
}

impl WindowCall {
    /// `closeWindow` answers null once called; the others an object without `refused` or `busy`.
    pub fn read(v: &Value) -> Self {
        let Some(o) = v.as_object() else { return WindowCall::Called };
        if json::string(o.get("refused")) == Some("late") {
            return WindowCall::Late { past_ms: json::num(o.get("pastMs")).unwrap_or(0.0) };
        }
        if json::boolean(o.get("busy")) == Some(true) {
            return WindowCall::Busy;
        }
        WindowCall::Called
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vectors() -> Value {
        let path =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/hosted-browser.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("the shared vectors")).expect("their JSON")
    }
    fn strings<'a>(v: &'a Value, path: &[&str]) -> Vec<&'a str> {
        let mut at = v;
        for p in path {
            at = &at[*p];
        }
        at.as_array().expect("a list").iter().map(|s| s.as_str().expect("a string")).collect()
    }

    #[test]
    fn the_checks_agree_with_the_copys_vectors() {
        let v = vectors();
        for s in strings(&v, &["items", "valid"]) {
            assert!(valid_item(s), "{s}");
        }
        for s in strings(&v, &["items", "invalid"]) {
            assert!(!valid_item(s), "{s}");
        }
        for s in strings(&v, &["urls", "valid"]) {
            assert!(valid_shown_url(s), "{s}");
        }
        for s in strings(&v, &["urls", "invalid"]) {
            assert!(!valid_shown_url(s), "{s}");
        }
        for s in strings(&v, &["marks", "valid"]) {
            assert!(valid_mark(s), "{s}");
        }
        for s in strings(&v, &["marks", "invalid"]) {
            assert!(!valid_mark(s), "{s}");
        }
        for t in v["titles"].as_array().expect("titles") {
            let (title, mark, has) =
                (t["title"].as_str().unwrap_or(""), t["mark"].as_str().unwrap_or(""), t["has"] == true);
            assert_eq!(title_has_mark(title, mark), has, "{title}");
        }
        assert!(!valid_item(&"a".repeat(257)));
    }

    #[test]
    fn a_new_mark_is_one_the_copy_takes_and_never_the_same_twice() {
        let a = new_mark().expect("randomness");
        let b = new_mark().expect("randomness");
        assert!(valid_mark(&a) && valid_mark(&b));
        assert_ne!(a, b);
        assert!(title_has_mark(&format!("Margin {a} - Google Chrome"), &a));
    }

    #[test]
    fn host_ids_keep_safaris_and_give_chrome_and_edge_the_same_shape() {
        assert_eq!(host_id("safari", "s-abc", Role::Main).as_deref(), Some("safari:s-abc"));
        assert_eq!(host_id("chrome", "p-x1", Role::Card).as_deref(), Some("chrome:p-x1#card"));
        assert_eq!(host_id("edge", "p-y", Role::Pane(3)).as_deref(), Some("edge:p-y#pane3"));
        assert_eq!(host_id("firefox", "p", Role::Main), None);
        assert_eq!(host_id("chrome", "", Role::Main), None);
        assert_eq!(host_id("chrome", "p", Role::Pane(4)), None);
        for role in [Role::Main, Role::Card, Role::Pane(1), Role::Pane(2), Role::Pane(3)] {
            let id = host_id("edge", "p-1", role).expect("an id");
            assert_eq!(parse_host_id(&id), Some(("edge", "p-1", role)));
        }
        assert_eq!(parse_host_id("app:com.apple.Notes"), None);
        assert_eq!(parse_host_id("chrome:p#pane9"), None);
        assert_eq!(parse_host_id("chrome:#card"), None);
    }

    #[test]
    fn requests_as_the_copy_takes_them() {
        let made =
            Ask::NewWindow { fullscreen: false, hosted: true, mark: Some("m1A2b3C4d5".into()), url: None, item: None };
        assert_eq!(made.kind(), "newWindow");
        assert_eq!(
            Value::Object(made.payload().unwrap()),
            json!({ "fullscreen": false, "hosted": true, "mark": "m1A2b3C4d5" })
        );
        let bad = Ask::NewWindow { fullscreen: false, hosted: true, mark: Some("x".into()), url: None, item: None };
        assert_eq!(bad.payload(), Err(Refused::Mark));

        let show = Ask::Show {
            window_id: 7,
            item: "t-aaaa".into(),
            url: "https://a.example/".into(),
            card: false,
            fresh: false,
            pinned: Some(true),
        };
        assert_eq!(
            Value::Object(show.payload().unwrap()),
            json!({ "windowId": 7, "itemId": "t-aaaa", "url": "https://a.example/", "pinned": true })
        );
        let card = Ask::Show {
            window_id: 8,
            item: CARD_ITEM.into(),
            url: "about:blank".into(),
            card: true,
            fresh: true,
            pinned: None,
        };
        assert_eq!(
            Value::Object(card.payload().unwrap()),
            json!({ "windowId": 8, "itemId": "peek-card", "url": "about:blank", "role": "card", "fresh": true })
        );
        let wrong_card = Ask::Show {
            window_id: 8,
            item: "t-a".into(),
            url: "about:blank".into(),
            card: true,
            fresh: false,
            pinned: None,
        };
        assert_eq!(wrong_card.payload(), Err(Refused::CardRule));
        let file = Ask::Show {
            window_id: 8,
            item: "t-a".into(),
            url: "file:///etc/hosts".into(),
            card: false,
            fresh: false,
            pinned: None,
        };
        assert_eq!(file.payload(), Err(Refused::Url));

        let state = Ask::SetWindowState {
            window_id: 4,
            state: State::Fullscreen,
            focused: true,
            not_after: Some(1000.4),
            land: false,
        };
        assert_eq!(
            Value::Object(state.payload().unwrap()),
            json!({ "windowId": 4, "state": "fullscreen", "focused": true, "notAfter": 1000.0, "land": false })
        );
        let never = Ask::SetWindowState {
            window_id: 4,
            state: State::Normal,
            focused: false,
            not_after: Some(f64::NAN),
            land: true,
        };
        assert_eq!(never.payload(), Err(Refused::Time));
        assert_eq!(
            Ask::Media { item: "t-a".into(), command: "eject".into(), tab_id: None }.payload(),
            Err(Refused::Command)
        );
        assert_eq!(Ask::CloseWindow { window_id: -1, not_after: None }.payload(), Err(Refused::Window));
        assert_eq!(Ask::CardClose.payload(), Ok(Object::new()));
        for (ask, kind) in [
            (Ask::Close { item: "t-a".into() }, "hostClose"),
            (Ask::Picture { window_id: 1, item: "t-a".into() }, "hostPicture"),
            (Ask::Mute { item: "t-a".into(), muted: None }, "hostMute"),
            (Ask::Navigate { item: "t-a".into(), url: "http://x/".into() }, "hostNavigate"),
            (Ask::PromotePeek { from: CARD_ITEM.into(), to_window: 2, to_item: "t-b".into() }, "hostPromotePeek"),
            (Ask::FocusWindow { window_id: 1, not_after: 5.0 }, "hostFocusWindow"),
        ] {
            assert_eq!(ask.kind(), kind);
            assert!(ask.payload().is_ok(), "{kind}");
        }
    }

    #[test]
    fn answers_read_as_untrusted() {
        let made = WindowMade::read(
            &json!({ "windowId": 12, "state": "normal", "bounds": { "left": 10, "top": 20, "width": 800, "height": 600 } }),
        );
        assert_eq!(
            made,
            Some(WindowMade {
                window_id: 12,
                state: "normal".into(),
                bounds: Some(Rect::new(10.0, 20.0, 800.0, 600.0))
            })
        );
        let no_bounds =
            WindowMade::read(&json!({ "windowId": 12, "bounds": { "left": 1, "top": 2, "width": 0, "height": 5 } }));
        assert_eq!(no_bounds.map(|m| m.bounds), Some(None));
        assert_eq!(WindowMade::read(&json!({ "windowId": "12" })), None);
        assert_eq!(WindowMade::read(&Value::Null), None);

        assert_eq!(
            Shown::read(&json!({ "tabId": 5, "created": true })),
            Some(Shown { tab_id: 5, created: true, moved: false })
        );
        assert_eq!(Shown::read(&json!({ "created": true })), None);

        assert_eq!(picture(&json!({ "data": "data:image/jpeg;base64,AAAA" })), Some("data:image/jpeg;base64,AAAA"));
        assert_eq!(picture(&json!({ "data": "data:text/html;base64,AAAA" })), None);
        assert_eq!(picture(&json!({ "data": null })), None);

        assert_eq!(WindowCall::read(&Value::Null), WindowCall::Called, "closeWindow's null");
        assert_eq!(
            WindowCall::read(&json!({ "windowId": 4, "state": "fullscreen", "asked": true })),
            WindowCall::Called
        );
        assert_eq!(WindowCall::read(&json!({ "refused": "late", "pastMs": 210 })), WindowCall::Late { past_ms: 210.0 });
        assert_eq!(WindowCall::read(&json!({ "busy": true })), WindowCall::Busy);
    }
}
