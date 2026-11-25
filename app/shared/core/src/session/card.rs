//! The preview card and Quick Tab (HostedPeek.swift; docs/CORE-REFACTOR.md step 3, part 4): the card's default rect,
//! what a web address is and its host (pure), and the card's state machine and flows, transliterated as requests.rs
//! is (each decision at the same point between the same awaits).

use std::cell::Cell;
use std::ops::Range;

use serde_json::{Value, json};

use super::hosting::HostTarget;
use super::items::Split;
use super::state::{Card, Extra, Layout};
use super::target::Target;
use super::{Core, Field, host_id, object, swift_int, swift_max, swift_min};
use crate::geometry::{Rect, cg};
use crate::hosted_browser::Role;
use crate::json::{self, Object};

/// Margin's default card rect in a page area (a theme with no `<m-preview-page>`): centred, 8% each side and 7%
/// above and below at most (at least 420 wide, 320 tall for its page), its page under a 52 pt bar (at least Safari's
/// full-screen toolbar window, which rests just above the card window, never seen through the dim). Rounded half
/// away from zero, as CGFloat's `rounded()`.
pub fn default_card_rect(page: Rect) -> Rect {
    let p = cg::standard(&page);
    let bar = 52.0;
    let w = swift_max(
        swift_min(p.width, 420.0),
        p.width - 2.0 * swift_min(p.width * 0.08, swift_max(0.0, (p.width - 420.0) / 2.0)),
    );
    let h = swift_max(
        swift_min(p.height, 320.0 + bar),
        p.height - 2.0 * swift_min(p.height * 0.07, swift_max(0.0, (p.height - 320.0 - bar) / 2.0)),
    );
    let x = p.x + (p.width - w) / 2.0;
    let y = p.y + (p.height - h) / 2.0;
    Rect::new(x.round(), (y + bar).round(), w.round(), swift_max(0.0, h - bar).round())
}

/// What `web_address_parts` says of a text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebAddress {
    Yes,
    No,
    /// Everything else is one; its host (these bytes of the text) has letters outside ASCII, which the OS's IDNA
    /// (UTS #46, as Foundation runs ICU's) must make an ASCII name of for it to be one.
    Host(Range<usize>),
}

/// The longest web address, in Unicode scalars (the Swift counted `Character`s: a text with combining marks or
/// joined emoji past 2,048 scalars but not 2,048 characters is one there, not here; step 1's rule for every cap).
pub const WEB_ADDRESS_MAX: usize = 2048;

// RFC 3986's allowed characters as Foundation's parser keeps them (swift-foundation URLParser.swift
// `URLComponentAllowedMask`): bit n is ASCII n.
const HOST: u128 = 0x47ff_fffe_87ff_fffe_2bff_7fd2_0000_0000;
const HOST_IP_FUTURE: u128 = 0x47ff_fffe_87ff_fffe_2fff_7fd2_0000_0000;

fn allowed(mask: u128, b: u8) -> bool {
    b < 128 && mask & (1u128 << b) != 0
}

/// Every byte allowed, a `%` only as the start of two hex digits (URLParser `validate(buffer:)`).
fn valid_encoded(bytes: &[u8], mask: u128) -> bool {
    let mut hex = 0;
    for &b in bytes {
        if b >= 128 {
            return false;
        }
        if b == b'%' {
            if hex != 0 {
                return false;
            }
            hex = 2;
        } else if !allowed(mask, b) {
            return false;
        } else if hex > 0 {
            if !b.is_ascii_hexdigit() {
                return false;
            }
            hex -= 1;
        }
    }
    hex == 0
}

/// Whether `s` is an http or https address Foundation's `URL(string:)` makes a URL of (as macOS 14 and later parse
/// it: RFC 3986, invalid characters percent-encoded, so only the authority can refuse it: a port that isn't digits,
/// something after an IP literal but its port, an IP literal with a character it can't have, a host that isn't one).
/// Its parts, with the one question only the OS can answer (`Host`).
pub fn web_address_parts(s: &str) -> WebAddress {
    if s.is_empty() || s.chars().count() > WEB_ADDRESS_MAX {
        return WebAddress::No;
    }
    let b = s.as_bytes();
    // The scheme: up to the first ":", unless a "/", "?", "#", "[", "]" or "@" comes first (a relative reference).
    let Some(colon) =
        b.iter().position(|&c| matches!(c, b':' | b'/' | b'?' | b'#' | b'[' | b']' | b'@')).filter(|&i| b[i] == b':')
    else {
        return WebAddress::No;
    };
    let scheme = &s[..colon];
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return WebAddress::No;
    }
    let rest = colon + 1;
    if !b[rest..].starts_with(b"//") {
        return WebAddress::Yes; // (no authority: the rest is a path, a query and a fragment, encoded as needed)
    }
    let start = rest + 2;
    let end = b[start..].iter().position(|&c| matches!(c, b'/' | b'?' | b'#')).map_or(b.len(), |i| start + i);
    let authority = &b[start..end];
    if authority.is_empty() {
        return WebAddress::Yes;
    }
    // The user and password: up to the last "@" (always encoded as needed).
    let host_start = authority.iter().rposition(|&c| c == b'@').map_or(0, |i| i + 1);
    let mut host_end = authority.len();
    let mut port: Option<&[u8]> = None;
    let literal_end = (authority.get(host_start) == Some(&b'['))
        .then(|| authority[host_start..].iter().position(|&c| c == b']').map(|i| host_start + i))
        .flatten();
    if let Some(close) = literal_end {
        host_end = close + 1;
        if host_end != authority.len() {
            if authority[host_end] != b':' {
                return WebAddress::No; // (something after the IP literal but its port)
            }
            port = Some(&authority[host_end + 1..]);
        }
    } else if let Some(c) = authority[host_start..].iter().position(|&c| c == b':').map(|i| host_start + i) {
        host_end = c;
        port = Some(&authority[c + 1..]); // (an empty port is one: URL allows it)
    }
    if port.is_some_and(|p| !p.iter().all(u8::is_ascii_digit)) {
        return WebAddress::No;
    }
    let host = &authority[host_start..host_end];
    if literal_end.is_some() {
        // An IP literal: what comes before its zone id ("%", encoded if it isn't already) has only the characters an
        // address or IPvFuture can have; the zone id is encoded as needed.
        let inner = &host[1..host.len() - 1];
        let address = inner.iter().position(|&c| c == b'%').map_or(inner, |i| &inner[..i]);
        return if address.iter().all(|&c| allowed(HOST_IP_FUTURE, c)) { WebAddress::Yes } else { WebAddress::No };
    }
    if host.iter().any(|&c| c >= 128) {
        let at = start + host_start;
        return WebAddress::Host(at..at + host.len());
    }
    // An ASCII name: what it may have as it is (IDNA changes no ASCII but its case).
    if valid_encoded(host, HOST) { WebAddress::Yes } else { WebAddress::No }
}

/// Whether `s` is a web address (HostedPeek `webAddress`): `idna` answers for a host with letters outside ASCII
/// (whether the OS's IDNA makes a valid ASCII name of it).
pub fn web_address(s: &str, idna: impl FnOnce(&str) -> bool) -> bool {
    match web_address_parts(s) {
        WebAddress::Yes => true,
        WebAddress::No => false,
        WebAddress::Host(r) => idna(&s[r]),
    }
}

/// The host of a web address as Foundation's `URL.host` says it: percent-decoded (None when that isn't UTF-8), an IP
/// literal without its brackets, nothing but the authority's host (no user, no port); None with no authority. A host
/// with letters outside ASCII is the OS's (`os`: its IDNA's ASCII name, as `URL(string:)` makes it).
pub fn web_host(s: &str, os: impl FnOnce() -> Option<String>) -> Option<String> {
    let b = s.as_bytes();
    let colon = b
        .iter()
        .position(|&c| matches!(c, b':' | b'/' | b'?' | b'#' | b'[' | b']' | b'@'))
        .filter(|&i| b[i] == b':')?;
    let rest = colon + 1;
    if !b[rest..].starts_with(b"//") {
        return None;
    }
    let start = rest + 2;
    let end = b[start..].iter().position(|&c| matches!(c, b'/' | b'?' | b'#')).map_or(b.len(), |i| start + i);
    let authority = &b[start..end];
    if authority.is_empty() {
        return None;
    }
    let host_start = authority.iter().rposition(|&c| c == b'@').map_or(0, |i| i + 1);
    let after = &authority[host_start..];
    let host = if after.first() == Some(&b'[')
        && let Some(close) = after.iter().position(|&c| c == b']')
    {
        &after[1..close]
    } else {
        let end = after.iter().position(|&c| c == b':').unwrap_or(after.len());
        &after[..end]
    };
    if host.iter().any(|&c| c >= 128) {
        return os();
    }
    // (Percent-decoded: a "%" with two hex digits is its byte, anything else stays.)
    let mut out = Vec::with_capacity(host.len());
    let mut i = 0;
    while i < host.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if host[i] == b'%'
            && let (Some(h), Some(l)) = (host.get(i + 1).copied().and_then(hex), host.get(i + 2).copied().and_then(hex))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(host[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

// ---- the flows (HostedPeek.swift): the card's state machine ----
//
// One card per profile, attached to a Margin window: opened (`open`, not `ready`, `fresh`) → laid out (`ready`, its
// `rect`) → hidden with its opener by a pick (not `open`, `hidden_by`) → shown again when the opener is (unless the
// pick was the opener itself) → closed (forgotten, its window parked, its tab closed by `hostCardClose` after the page
// covered it), expanded (a new item, its tab moved, `hostPromotePeek`) or dropped (no room, no page area). Quick Tab's
// field is `little_arcs[window]`.
//
// The layout itself is part 3's (layouts.rs `apply_layout`: the card a part of it, at its rect, in its card window).

/// The copy's tag for the card's page (background/hosted.ts CARD_ITEM), and the card's item in a layout.
pub const CARD_TAG: &str = "peek-card";
pub const CARD_PREFIX: &str = "card:";
/// A card window unused this long is closed; the page's <m-preview-page> waited for this long, then Margin's default
/// rect; the page given this long to cover the card's page area before its window goes.
pub const CARD_IDLE: f64 = 15.0 * 60.0;
pub const CARD_RECT_WAIT: f64 = 0.3;
pub const CARD_COVER_WAIT: f64 = 0.05;

/// A profile's card in a layout (`card:<profile>`).
pub fn card_item(profile: &str) -> String {
    format!("{CARD_PREFIX}{profile}")
}

pub fn is_card_item(item: &str) -> bool {
    item.starts_with(CARD_PREFIX)
}

/// A rect's edges moved by more than a point (CGRect's `minX`, `minY`, `width`, `height`: standardized).
fn moved(a: &Rect, b: &Rect) -> bool {
    let (a, b) = (cg::standard(a), cg::standard(b));
    (a.x - b.x).abs() > 1.0
        || (a.y - b.y).abs() > 1.0
        || (a.width - b.width).abs() > 1.0
        || (a.height - b.height).abs() > 1.0
}

impl Core {
    // ---- the state (each borrow dropped before it returns) ----

    pub(crate) fn card(&self, profile: &str) -> Option<Card> {
        self.read(|s| s.cards.get(profile).cloned())
    }

    pub(crate) fn set_card(&self, profile: &str, c: Option<Card>) {
        self.edit(Field::Cards, |s| match c {
            Some(c) => s.cards.insert(profile.to_string(), c),
            None => s.cards.remove(profile),
        });
    }

    fn card_used(&self, profile: &str, at: Option<f64>) {
        let mut s = self.state.borrow_mut();
        match at {
            Some(t) => s.card_used_at.insert(profile.to_string(), t),
            None => s.card_used_at.remove(profile),
        };
    }

    fn set_little_arc(&self, w: i64, space: Option<String>) {
        self.edit(Field::LittleArcs, |s| match space {
            Some(sp) => s.little_arcs.insert(w, sp),
            None => s.little_arcs.remove(&w),
        });
    }

    /// The card a Margin window shows or keeps (open or hidden with its opener); its open one. (Of several, the
    /// lowest profile: Swift's dictionary had no order, and one window has one in practice.)
    fn card_in(&self, w: i64) -> Option<Card> {
        self.read(|s| s.cards.values().find(|c| c.window == w).cloned())
    }

    pub(crate) fn open_card_in(&self, w: i64) -> Option<Card> {
        self.read(|s| s.cards.values().find(|c| c.window == w && c.open).cloned())
    }

    /// A web address (card.rs `web_address`; a host outside ASCII by the OS's IDNA).
    pub(crate) fn web_address(&self, s: &str) -> bool {
        web_address(s, |host| self.ports.idna(host))
    }

    /// Its card's address when it's a web one: the card window opened at the card's page (`request_window`).
    pub(crate) fn card_url(&self, profile: &str) -> Option<String> {
        self.card(profile).map(|c| c.url).filter(|u| self.web_address(u))
    }

    /// An item that's a pin's or a favourite's tab (the library's `pinnedBy`, `favoriteId`): its page's links to other
    /// sites open in a card (auto-preview). Told to the copy with each hostShow (`pinned`).
    pub(crate) fn pinned_or_favorite(&self, item: &str) -> bool {
        let Some(v) = self.item_value(item) else { return false };
        let has = |k: &str| v.get(k).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
        has("pinnedBy") || has("favoriteId")
    }

    /// A space the library has (`library.spaces().contains { $0.id == s }`).
    fn has_space(&self, id: &str) -> bool {
        self.library.item("spaces", id).is_some_and(|v| v.is_object())
    }

    /// The space a card's or Quick Tab's choice goes to: the one named if the library has it, else `or`.
    fn space_named(&self, named: Option<&str>, or: impl FnOnce() -> Option<String>) -> Option<String> {
        named.filter(|s| self.has_space(s)).map(str::to_string).or_else(or)
    }

    /// The split a window's layout shows, for laying it out again with or without the card (`splitOf`).
    fn split_of_layout(&self, l: &Layout) -> Option<Split> {
        self.split(l.split.as_deref()?)
    }

    // ---- the page ----

    fn push_peek(&self, w: i64, peek: Option<Value>) {
        let body = json!({ "type": "peek", "peek": peek });
        self.ports.push(w, &body.to_string());
    }

    fn tell_page(&self, c: &Card) {
        let Some(w) = self.ports.window(Some(c.window)) else { return };
        self.tell_page_in(w, c);
    }

    /// ...to a window just looked up, nothing between (the lookup Swift's `tellPage` made again answers the same).
    fn tell_page_in(&self, w: i64, c: &Card) {
        let title = if c.title.is_empty() {
            web_host(&c.url, || self.ports.url_host(&c.url)).unwrap_or_default()
        } else {
            c.title.clone()
        };
        self.push_peek(w, Some(json!({ "url": c.url, "title": title, "loading": !c.ready, "spaceId": c.space })));
    }

    // ---- the copy's word ----

    /// A page's click (the copy's `peekOpen { id, url, source, tabId, notAfter }` for one of its windows): answered at
    /// once. Taken only from a window Margin hosts for that profile (main's, a pane's, or the card's own: a preview
    /// inside the card replaces its page) whose Margin window shows one of its items, by the click's time; anything
    /// else is refused and the page opens the link as it would have.
    pub(crate) fn peek_open(&self, profile: &str, window_id: Option<i64>, msg: &Object) {
        let id = msg.get("id").and_then(Value::as_str).unwrap_or("");
        let url = msg.get("url").and_then(Value::as_str).unwrap_or("");
        let not_after = json::num(msg.get("notAfter")).unwrap_or(0.0);
        self.peek_open_click(profile, window_id, id, url, not_after);
    }

    /// ...its parts read (the id and the address, empty when the push had none; its time, 0 when none): the Mac's
    /// typed call (`margin_session_peek_open`), as the JSON input reads them.
    pub(crate) fn peek_open_click(&self, profile: &str, window_id: Option<i64>, id: &str, url: &str, not_after: f64) {
        let (id, url) = (id.to_string(), url.to_string());
        let answer = |ok: bool, why: &str| {
            // (Its 80 Characters counted as Unicode scalars, as step 1's caps.)
            if !id.is_empty()
                && id.chars().count() <= 80
                && let Some(c) = self.rc()
            {
                let (p, payload) = (profile.to_string(), object(json!({ "id": id, "ok": ok })));
                self.exec.spawn(async move {
                    c.ask(&p, "peekAnswer", payload).await;
                });
            }
            let said = if ok { "shown".to_string() } else { format!("refused ({why})") };
            self.note(format!("Preview asked by a page: {said}"));
        };
        // (A click's push has both: anything else isn't one, and is never a card.)
        if id.is_empty() || not_after <= 0.0 {
            return self.note("Preview: a push that isn't a page's click (no id or time): left".into());
        }
        if !self.web_address(&url) {
            return answer(false, "not a web address");
        }
        if self.ports.wall() * 1000.0 > not_after {
            return answer(false, "too late: the page opened it");
        }
        let Some(window_id) = window_id else { return answer(false, "no window") };
        // (Its window: any Margin hosts for that profile, main's, a split's pane's or the card's.)
        let role = self.read(|s| {
            s.safari_windows.iter().find(|((p, _), id)| p == profile && **id == window_id).map(|((_, r), _)| *r)
        });
        let Some(role) = role else { return answer(false, "not a window Margin hosts") };
        let from_card = role == Role::Card;
        let Some(wid) = self.hosting() else { return answer(false, "nothing hosted") };
        let Some(w) = self.ports.window(Some(wid)) else { return answer(false, "nothing hosted") };
        let layout = self.layout_of(wid);
        let main = layout.as_ref().map(|l| l.main.clone()).or_else(|| self.shown_in(wid));
        let Some(main) = main.filter(|m| !is_card_item(m) && self.open_item(m).is_some()) else {
            return answer(false, "nothing shown under it");
        };
        // (The item the clicked page shows: the one in that window (a split's pane), else main (the card's own clicks).)
        let host = HostTarget::Safari(profile.to_string(), role).id();
        let hosted_by = |i: &str| self.open_item(i).is_some_and(|o| o.host == host);
        let clicked = if from_card {
            Some(main.clone())
        } else {
            let first = match &layout {
                Some(l) => l.items().find(|i| hosted_by(i)).map(str::to_string),
                None => hosted_by(&main).then(|| main.clone()),
            };
            first.or_else(|| hosted_by(&main).then(|| main.clone()))
        };
        let Some(opener) = clicked else { return answer(false, "the page isn't one Margin shows") };
        answer(true, "");
        let space = self.space_of_item(&opener).or_else(|| self.space_of_window(wid));
        self.show_card(w, profile, &url, &opener, space, Some(id.clone()));
    }

    /// The copy gave up on a click before the app's word reached it (`peekCancel`): its card, if shown, closed again.
    pub(crate) fn peek_cancel(&self, profile: &str, msg: &Object) {
        let Some(id) = msg.get("id").and_then(Value::as_str) else { return };
        let Some(c) = self.card(profile).filter(|c| c.click.as_deref() == Some(id)) else { return };
        self.close_card(Some(c.window), "the page opened the link itself (no answer in time)", true);
    }

    /// The card's page now (the copy's `cardPage { url, title }`): its bar follows.
    pub(crate) fn card_page(&self, profile: &str, window_id: Option<i64>, msg: &Object) {
        let Some(mut c) = self.card(profile) else { return };
        if window_id.is_some() && self.safari_window(profile, Role::Card) != window_id {
            return;
        }
        let was = c.clone();
        if let Some(url) = msg.get("url").and_then(Value::as_str)
            && self.web_address(url)
        {
            c.url = url.to_string();
        }
        if let Some(title) = msg.get("title").and_then(Value::as_str) {
            // (Its 300 Characters counted as Unicode scalars, as step 1's caps.)
            c.title = title.chars().take(300).collect();
        }
        c.fresh = false;
        if c == was {
            return;
        }
        self.set_card(profile, Some(c.clone()));
        if c.open {
            self.tell_page(&c);
        }
    }

    /// Esc or ⌘↩ in the card's page (the copy's `cardKey { key }`).
    pub(crate) fn card_key(&self, profile: &str, window_id: Option<i64>, key: &str) {
        let Some(c) = self.card(profile).filter(|c| c.open) else { return };
        if self.safari_window(profile, Role::Card) != window_id {
            return;
        }
        if key == "close" {
            self.close_card(Some(c.window), "Esc in its page", true);
        }
        if key == "expand" {
            self.expand_card(Some(c.window), None);
        }
    }

    // ---- the page's word (`peek.*`) ----

    /// Quick Tab's field up in window `window` (no window yet): ⌘W and a press around it close it there.
    pub(crate) fn little_arc_opened(&self, window: Option<i64>, space: Option<&str>) {
        let Some(w) = self.ports.window(window) else { return };
        if self.open_card_in(w).is_some() {
            self.close_card(Some(w), "Quick Tab opened over it", false);
        }
        let space = space.map(str::to_string).or_else(|| self.space_of_window(w)).unwrap_or_default();
        self.set_little_arc(w, Some(space));
        self.note(format!("Quick Tab open in Margin's window {w}"));
    }

    /// Quick Tab's choice: the card at that address over the window's item; nothing hosted there: the space's new tab.
    pub(crate) fn little_arc_go(&self, window: Option<i64>, url: &str, space: Option<&str>) {
        let Some(w) = self.ports.window(window) else { return };
        if !self.web_address(url) {
            return;
        }
        self.set_little_arc(w, None);
        let space = self.space_named(space, || self.space_of_window(w));
        let main = if Some(w) == self.hosting() {
            self.layout_of(w).map(|l| l.main).or_else(|| self.shown_in(w))
        } else {
            None
        };
        let Some(main) = main.filter(|m| self.open_item(m).is_some() && !is_card_item(m)) else {
            self.note("Quick Tab: nothing hosted under it: opened as the space's new tab".into());
            self.push_peek(w, None);
            let mut payload = object(json!({ "windowId": w, "url": url }));
            if let Some(space) = &space {
                payload.insert("spaceId".into(), json!(space));
            }
            self.library.perform("newTab", &payload);
            return;
        };
        // (Its profile: the space's, as a new tab there would have.)
        let of_space = space
            .as_deref()
            .and_then(|s| self.library.item("spaces", s))
            .and_then(|v| v.get("profile")?.as_str().map(str::to_string))
            .filter(|p| !p.is_empty());
        let profile = self.resolve(of_space.as_deref());
        self.show_card(w, &profile, url, &main, space, None);
    }

    // ---- open, hide, show again ----

    fn show_card(&self, w: i64, profile: &str, url: &str, opener: &str, space: Option<String>, click: Option<String>) {
        // (One card in a window: another profile's there goes, its page kept for its own next preview.)
        let others: Vec<String> = self.read(|s| {
            s.cards.iter().filter(|(p, c)| *p != profile && c.window == w && c.open).map(|(p, _)| p.clone()).collect()
        });
        for _ in others {
            self.close_card(Some(w), "another profile's card replaces it", false);
        }
        let was = self.card(profile);
        let mut c = Card::new(profile, w, opener, space, url, click);
        c.rect = was.as_ref().filter(|was| was.window == w).and_then(|was| was.rect);
        self.set_card(profile, Some(c.clone()));
        self.card_used(profile, Some(self.ports.now()));
        self.set_little_arc(w, None);
        let how = match &was {
            None => String::new(),
            Some(was) if was.window == w => " (its page replaced)".into(),
            Some(was) => format!(" (moved from Margin's window {})", was.window),
        };
        self.note(format!("Preview: a card in Margin's window {w} over {opener}{how}"));
        self.tell_page_in(w, &c);
        self.enqueue_place(profile);
    }

    fn enqueue_place(&self, profile: &str) {
        let Some(core) = self.rc() else { return };
        let p = profile.to_string();
        self.exec.enqueue(async move { core.place_card(&p).await });
    }

    /// The card laid out over its opener: at the page's <m-preview-page> (waited for a moment), else Margin's default
    /// rect; a split's panes kept as they are. Then the page told it's in place (or it's gone: refused, failed).
    async fn place_card(&self, profile: &str) {
        let Some(c) = self.card(profile).filter(|c| c.open) else { return };
        let Some(w) = self.ports.window(Some(c.window)) else { return };
        // (Its last look is the rect read after it: nothing comes between.)
        let page_rect = Cell::new(None);
        self.wait(CARD_RECT_WAIT, || {
            page_rect.set(self.ports.card_rect(w));
            page_rect.get().is_some() || self.card(profile).map(|c| c.open) != Some(true)
        })
        .await;
        let page_rect = page_rect.get();
        let Some(mut c) = self.card(profile).filter(|c| c.open && c.window == w) else { return };
        let Some(rect) = page_rect.or_else(|| self.ports.hosted_page(w).map(default_card_rect)) else {
            self.note("Preview: no page area to lay the card out in".into());
            return self.drop_card(profile, w);
        };
        if page_rect.is_none() {
            self.note("Preview: the theme has no <m-preview-page>: Margin's default place for the card".into());
        }
        let base = self.layout_of(w);
        let main = base.as_ref().map_or(c.opener.clone(), |b| b.main.clone());
        let item = card_item(profile);
        let mut extras: Vec<Extra> =
            base.as_ref().map(|b| b.extras.iter().filter(|e| e.role != "card").cloned().collect()).unwrap_or_default();
        extras.push(Extra { item: item.clone(), role: "card".into(), rect });
        // (Over a split: the split's own layout kept, its panes at their <m-pane>s, the card above them.)
        let split = base.as_ref().and_then(|b| self.split_of_layout(b));
        let main_rect = base.as_ref().and_then(|b| b.main_rect);
        self.apply_layout(Some(w), &main, main_rect, extras, Some(&item), split.map(|s| (s.id, s.panes))).await;
        let Some(after) = self.card(profile).filter(|a| a.open && a.window == w) else { return };
        if !self.layout_of(w).is_some_and(|l| l.extras.iter().any(|e| e.item == item)) {
            self.note("Preview: the card wasn't shown (refused or failed: see the layout's line)".into());
            self.ports.push(w, r#"{"type":"toast","text":"Not enough room for that card"}"#);
            return self.drop_card(profile, w);
        }
        c = after;
        c.ready = true;
        c.fresh = false;
        c.rect = Some(rect);
        self.set_card(profile, Some(c.clone()));
        self.card_used(profile, Some(self.ports.now()));
        self.tell_page(&c);
    }

    /// A card that couldn't be shown: gone from the page, forgotten (its window, if any, stays parked).
    fn drop_card(&self, profile: &str, w: i64) {
        self.set_card(profile, None);
        self.push_peek(w, None);
    }

    /// A pick in window `w` (the library's show requests): its card hides with its opener (parked by the show
    /// itself, which lays the item out alone), kept for when the opener's shown again.
    pub(crate) fn card_leaving(&self, w: i64, item: Option<&str>) {
        self.set_little_arc(w, None);
        let Some(mut c) = self.card_in(w) else { return };
        if c.open {
            c.open = false;
            c.ready = false;
            c.hidden_by = item.map(str::to_string);
            let p = c.profile.clone();
            self.set_card(&p, Some(c));
            self.card_used(&p, Some(self.ports.now()));
            self.push_peek(w, None);
            self.note("Preview: the card hidden with its opener (another item picked)".into());
        } else if item != Some(c.opener.as_str()) {
            c.hidden_by = None;
            let p = c.profile.clone();
            self.set_card(&p, Some(c));
        }
    }

    /// An item shown in window `w`: its own card (hidden when another was picked) shown again over it.
    pub(crate) fn card_returning(&self, w: i64, item: &str) {
        let Some(mut c) = self.card_in(w) else { return };
        if c.open || c.opener != item || c.hidden_by.as_deref() == Some(item) || Some(w) != self.hosting() {
            return;
        }
        c.open = true;
        c.ready = false;
        self.set_card(&c.profile, Some(c.clone()));
        self.note("Preview: back to its opener: the card shown again".into());
        self.tell_page(&c);
        self.enqueue_place(&c.profile);
    }

    /// The page's <m-preview-page> moved (a resize, another theme): the card laid out there again.
    pub(crate) fn card_rect_changed(&self, w: i64) {
        let Some(c) = self.open_card_in(w).filter(|c| c.ready) else { return };
        let Some(rect) = self.ports.card_rect(w) else { return };
        let Some(was) = c.rect else { return };
        if moved(&rect, &was) {
            self.enqueue_place(&c.profile);
        }
    }

    // ---- close, expand, history ----

    /// The card in window `window` closed (or Quick Tab's field): the page told first (it covers the card's page area
    /// at once and animates it out; `tell_page` false: it closed it itself), then the card parked and its tab closed.
    /// False: no card there.
    pub(crate) fn close_card(&self, window: Option<i64>, why: &str, tell_page: bool) -> bool {
        let Some(w) = self.ports.window(window) else { return false };
        let had_arc = self.read(|s| s.little_arcs.contains_key(&w));
        if had_arc {
            self.set_little_arc(w, None);
        }
        if had_arc && self.open_card_in(w).is_none() {
            if tell_page {
                self.push_peek(w, None);
            }
            self.note(format!("Quick Tab closed ({why})"));
            return true;
        }
        let Some(c) = self.open_card_in(w) else { return false };
        let p = c.profile.clone();
        self.set_card(&p, None);
        self.card_used(&p, Some(self.ports.now()));
        if tell_page {
            self.push_peek(w, None);
        }
        self.note(format!("Preview: the card closed ({why})"));
        let Some(core) = self.rc() else { return true };
        self.exec.enqueue(async move {
            core.sleep(CARD_COVER_WAIT).await;
            let item = card_item(&p);
            if let Some(base) = core.layout_of(w).filter(|b| b.extras.iter().any(|e| e.item == item)) {
                // (The rest as it was: a split goes on, its focused pane (the window's item shown) focused again.)
                let extras: Vec<Extra> = base.extras.iter().filter(|e| e.item != item).cloned().collect();
                let main = base.main.clone();
                let under = core
                    .shown_in(w)
                    .filter(|s| *s == main || extras.iter().any(|e| &e.item == s))
                    .unwrap_or_else(|| main.clone());
                let split = core.split_of_layout(&base);
                core.apply_layout(Some(w), &main, base.main_rect, extras, Some(&under), split.map(|s| (s.id, s.panes)))
                    .await;
            }
            core.tell(&p, "hostCardClose", Object::new()).await;
        });
        true
    }

    /// ⌘W in window `window` (Margin's own Close Tab, a hosted app's ⌘W): the card there, or Quick Tab's field,
    /// closed; never the item under it. False: neither there (the item's own ⌘W).
    pub(crate) fn close_card_for_key(&self, window: Option<i64>) -> bool {
        let Some(w) = self.ports.window(window) else { return false };
        if self.open_card_in(w).is_none() && !self.read(|s| s.little_arcs.contains_key(&w)) {
            return false;
        }
        self.close_card(Some(w), "⌘W", true)
    }

    /// Expand: the card's page a new item of its space, its tab moved into the profile's main window (its page kept),
    /// shown as main; the card window parked for the next preview.
    pub(crate) fn expand_card(&self, window: Option<i64>, space: Option<&str>) {
        let Some(w) = self.ports.window(window) else { return };
        let Some(c) = self.open_card_in(w) else { return };
        let p = c.profile.clone();
        self.set_card(&p, None);
        self.card_used(&p, Some(self.ports.now()));
        self.push_peek(w, None);
        let space = self.space_named(space, || c.space.clone().or_else(|| self.space_of_window(w)));
        let target = Target::Web { browser: "safari".into(), profile: Some(p.clone()) };
        let mut payload =
            object(json!({ "windowId": w, "url": c.url, "title": c.title, "target": target.json(), "front": true }));
        if let Some(space) = &space {
            payload.insert("spaceId".into(), json!(space));
        }
        let out = self.library.perform("addItem", &payload);
        let made = if out.ok { out.result.get("tabId").and_then(Value::as_str).map(str::to_string) } else { None };
        let Some(item) = made else {
            self.note(format!(
                "Preview: Expand made no item ({}): the card closed instead",
                out.error.as_deref().unwrap_or("?")
            ));
            self.set_card(&p, Some(c));
            self.close_card(Some(w), "Expand failed", false);
            return;
        };
        self.note(format!("Preview: expanded into item {item}"));
        self.set_requested(w, Some(&item));
        self.ports.changed();
        let Some(core) = self.rc() else { return };
        let url = c.url.clone();
        self.exec.enqueue(async move {
            if let Some(main) = core.safari_window(&p, Role::Main) {
                let payload = object(json!({ "fromItemId": CARD_TAG, "toWindowId": main, "toItemId": item }));
                let moved = core.ask_aside(&p, "hostPromotePeek", payload).await;
                if moved.result.as_ref().and_then(|r| json::flag(r.get("ok"))) != Some(true) {
                    let why = moved.error.as_deref().unwrap_or("refused");
                    core.note(format!(
                        "Preview: the card's tab not moved ({why}): opened at its address in the main window"
                    ));
                    core.tell(&p, "hostCardClose", Object::new()).await;
                }
            }
            // (Shown alone, as any item picked outside a split: a split under the card stays, for its next pick.)
            core.show(&item, Some(&url), None, Some(w)).await;
            core.settle_hosting();
        });
    }

    /// The card's Back and Forward: its page's history (the copy's goBack/goForward for the card's window's tab).
    pub(crate) fn card_history(&self, window: Option<i64>, back: bool) {
        let Some(w) = self.ports.window(window) else { return };
        let Some(c) = self.open_card_in(w) else { return };
        let Some(card_window) = self.safari_window(&c.profile, Role::Card) else { return };
        let Some(core) = self.rc() else { return };
        let kind = if back { "goBack" } else { "goForward" };
        self.exec.spawn(async move {
            core.ask(&c.profile, kind, object(json!({ "windowId": card_window }))).await;
        });
    }

    // ---- the card windows' own lives ----

    /// A host gone (closed, quit, its window closed): a card window's card forgotten; a profile's main window's: its
    /// card window closed with it.
    pub(crate) fn card_host_gone(&self, id: &str) {
        let gone: Vec<(String, i64)> = self.read(|s| {
            s.cards
                .iter()
                .filter(|(p, _)| HostTarget::Safari((*p).clone(), Role::Card).id() == id)
                .map(|(p, c)| (p.clone(), c.window))
                .collect()
        });
        for (p, window) in gone {
            self.set_card(&p, None);
            if let Some(w) = self.ports.window(Some(window)) {
                self.push_peek(w, None);
            }
        }
        let used: Vec<String> = self.read(|s| s.card_used_at.keys().cloned().collect());
        for p in used {
            if HostTarget::Safari(p.clone(), Role::Card).id() == id {
                self.card_used(&p, None);
            }
        }
        if host_id::safari_role(id) != Role::Main || !id.starts_with("safari:") {
            return;
        }
        let profile = &id["safari:".len()..];
        let card_id = HostTarget::Safari(profile.to_string(), Role::Card).id();
        if !self.ports.is_hosted(&card_id) {
            return;
        }
        self.note("Preview: its profile's main window went: the card window closed with it".into());
        if let Some(c) = self.card(profile)
            && let Some(w) = self.ports.window(Some(c.window))
        {
            self.set_card(profile, None);
            self.push_peek(w, None);
        }
        self.card_used(profile, None);
        let Some(core) = self.rc() else { return };
        self.exec.enqueue(async move {
            core.engine("close", json!({ "host": card_id })).await;
        });
    }

    /// Card windows not used for `CARD_IDLE` (parked, no card open): closed (the shell's poll, through the sweep).
    pub(crate) fn close_idle_cards(&self) {
        let t = self.ports.now();
        let used: Vec<(String, f64)> = self.read(|s| s.card_used_at.iter().map(|(p, at)| (p.clone(), *at)).collect());
        for (p, at) in used {
            if self.card(&p).map(|c| c.open) == Some(true) || t - at < CARD_IDLE {
                continue;
            }
            self.card_used(&p, None);
            if self.card(&p).is_some_and(|c| !c.open) {
                self.set_card(&p, None);
            }
            let id = HostTarget::Safari(p.clone(), Role::Card).id();
            if !self.ports.is_hosted(&id) {
                continue;
            }
            self.note(format!("Preview: the card window unused for {} minutes: closed", (CARD_IDLE / 60.0) as i64));
            let Some(core) = self.rc() else { continue };
            self.exec.enqueue(async move {
                core.engine("close", json!({ "host": id })).await;
            });
        }
    }

    /// The page's and the copy's word for the card (`{ type: peek, kind, … }`): its reply, for the ones that answer.
    pub(crate) fn peek_input(&self, kind: &str, a: &Object) -> Result<Option<Value>, String> {
        let s = |k: &str| a.get(k).and_then(Value::as_str);
        let window = swift_int(a.get("window"));
        let msg = || json::object(a.get("msg")).cloned().unwrap_or_default();
        let profile = || s("profile").unwrap_or("").to_string();
        match kind {
            "open" => self.peek_open(&profile(), window, &msg()),
            "cancel" => self.peek_cancel(&profile(), &msg()),
            "page" => self.card_page(&profile(), window, &msg()),
            "key" => self.card_key(&profile(), window, s("key").unwrap_or("")),
            "quickTab" => self.little_arc_opened(window, s("space")),
            "quickTabGo" => self.little_arc_go(window, s("url").unwrap_or(""), s("space")),
            "close" => {
                let tell = a.get("tellPage").and_then(Value::as_bool) != Some(false);
                return Ok(Some(json!(self.close_card(window, s("why").unwrap_or(""), tell))));
            }
            "closeForKey" => return Ok(Some(json!(self.close_card_for_key(window)))),
            "expand" => self.expand_card(window, s("space")),
            "history" => self.card_history(window, a.get("back").and_then(Value::as_bool) == Some(true)),
            "hostGone" => self.card_host_gone(s("host").unwrap_or("")),
            "idle" => self.close_idle_cards(),
            "rect" => {
                if let Some(w) = window {
                    self.card_rect_changed(w);
                }
            }
            other => return Err(format!("{other:?} isn't the card's")),
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- T/peek-session-tests.swift 193-199 ----

    #[test]
    fn the_default_card_rect() {
        let page = Rect::new(260.0, 41.0, 1244.0, 933.0);
        let r = default_card_rect(page);
        // (Arcadia's page area: 8% each side is 99.52, under the 412 the 420 least leaves; 7% above and below.)
        assert_eq!(r, Rect::new(360.0, 158.0, 1045.0, 750.0), "{r:?}");
        let small = default_card_rect(Rect::new(0.0, 0.0, 500.0, 400.0));
        assert_eq!(small, Rect::new(40.0, 66.0, 420.0, 320.0), "{small:?}");
        let tiny = default_card_rect(Rect::new(10.0, 10.0, 300.0, 40.0));
        assert_eq!(tiny, Rect::new(10.0, 62.0, 300.0, 0.0), "the page's whole area, under the bar: no height");
        assert_eq!(
            default_card_rect(Rect::new(0.0, 0.0, -500.0, 400.0)),
            Rect::new(-460.0, 66.0, 420.0, 320.0),
            "standardized"
        );
        // (Half away from zero, as CGFloat's rounded().)
        assert_eq!(default_card_rect(Rect::new(0.5, 0.0, 420.0, 372.0)).x, 1.0);
        assert_eq!(default_card_rect(Rect::new(-0.5, 0.0, 420.0, 372.0)).x, -1.0);
    }

    // ---- T/session-rules-tests.swift webAddressTests: Foundation's answers on macOS 27.2 ----

    fn ok(s: &str) -> bool {
        // (The OS's IDNA as Foundation's for the hosts these vectors have.)
        web_address(s, |host| !matches!(host, "-é" | "aש" | "a\u{200D}b"))
    }

    #[test]
    fn web_addresses() {
        for s in [
            "http:",
            "https://",
            "HTTP://A",
            "http://a/b c",
            "http://a/%zz",
            "http://a:80/",
            "http://[::1]/",
            "http://[zz]/",
            "http://a%20b/",
            "http://a/é",
            "http://a/\n",
            "http://u:p@@a/",
            "http://u@a@b/",
            "http://a:/",
            "http://a:99999999999/",
            "http://:80/",
            "http://[::1%en0]/",
            "http://[]/",
            "https:x y",
            "http://a!$&'()*+,;=b/",
            "https://docs.example.org/guide?q=1#top",
            "http://a?b",
            "http://a#b",
            "http://@/",
            "http://u a@b/",
            "http://[::1]:80/",
            "http://[::1]:/",
            "http://[v1.a]/",
            "http://[::1%25en0]/",
            "http://[a%zz]/",
            "http://u:p:q@a/",
        ] {
            assert!(ok(s), "{s:?} is one");
        }
        for s in [
            "",
            " http://a/",
            "http://a b",
            "http://a:xx/",
            "http://a:-1/",
            "http://[::1/",
            "http://a]b/",
            "http://a%zzb/",
            "http://a\\b/",
            "http://a^b/",
            "http://[::1]x/",
            "http://[::1]:x/",
            "http://a:80:80/",
            "http://a:８０/",
            "http://[é]/",
            "http://[a b]/",
            "javascript:alert(1)",
            "about:blank",
            "ftp://a/",
            "file:///etc/hosts",
            ":http://a",
            "http//a",
            "ht+tp://a",
            "http://a%/",
            "http://a<b/",
            "http://a\u{7f}b/",
            "http://a\u{0}b/",
            "http://-é/",
            "http://aש/",
            "http://a\u{200D}b/",
        ] {
            assert!(!ok(s), "{s:?} isn't one");
        }
    }

    #[test]
    fn a_non_ascii_host_is_the_os_s_question() {
        assert_eq!(web_address_parts("http://é.com/x"), WebAddress::Host(7..13));
        assert_eq!(web_address_parts("https://u:é@a/"), WebAddress::Yes, "a user's letters are encoded");
        assert_eq!(web_address_parts("http://a/é"), WebAddress::Yes);
        assert_eq!(web_address_parts("http://u@é:8/"), WebAddress::Host(9..11));
        assert_eq!(web_address_parts("http://é:x/"), WebAddress::No, "the port first");
        let mut asked = None;
        assert!(!web_address("http://ab.שלום:80/", |h| {
            asked = Some(h.to_owned());
            false
        }));
        assert_eq!(asked.as_deref(), Some("ab.שלום"));
    }

    #[test]
    fn at_most_2048_scalars() {
        let head = "https://a/";
        let at = format!("{head}{}", "x".repeat(WEB_ADDRESS_MAX - head.len()));
        assert!(ok(&at));
        assert!(!ok(&format!("{at}x")));
        // (2,048 characters, 2,049 scalars: one in the Swift, not here: the accepted edge.)
        let marks = format!("{head}{}e\u{301}", "x".repeat(WEB_ADDRESS_MAX - 1 - head.len()));
        assert!(!ok(&marks));
    }
}
