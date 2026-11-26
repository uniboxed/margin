//! What the UI asks of the session and what it draws (docs/CORE-REFACTOR.md step 3, part 10; HostedSession.swift
//! `LibraryWindowSource.perform`, `searchUrl`, `live`): a request's route (its tab numbers mapped back to items, the
//! settings' own, the pasteboard's, the session's flows, the library's edits), a search's address, and which open
//! items the UI draws as tabs with what numbers (`live_plan`: the Mac shapes them into the library's snapshot until
//! step 4).

use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::unicode::{COMPOSED_EXTEND, GRAPHEME_EXTEND, contains_characters, has};
use super::{Core, swift_int};
use crate::json::{self, Object};

/// Safari's default engine, Google's.
pub const GOOGLE: &str = "https://www.google.com/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8";

/// Whether `text` starts with `prefix` (ASCII) as Swift's `hasPrefix` sees it: as whole characters.
fn has_prefix_characters(text: &str, prefix: &str) -> bool {
    text.starts_with(prefix) && !text[prefix.len()..].chars().next().is_some_and(|c| has(GRAPHEME_EXTEND, c))
}

/// `text` with every `needle` (ASCII) replaced as NSString's `replacingOccurrences(of:with:)` does it: left to right,
/// not where the scalar after it makes one composed sequence with its last.
fn replace_composed(text: &str, needle: &str, with: &str) -> String {
    let mut out = String::with_capacity(text.len() + with.len());
    let mut from = 0;
    for (at, _) in text.match_indices(needle) {
        if text[at + needle.len()..].chars().next().is_some_and(|c| has(COMPOSED_EXTEND, c)) {
            continue;
        }
        out.push_str(&text[from..at]);
        out.push_str(with);
        from = at + needle.len();
    }
    out.push_str(&text[from..]);
    out
}

/// A query percent-encoded as Foundation's `addingPercentEncoding(withAllowedCharacters:)` did with
/// `CharacterSet.alphanumerics` and `-_.!~*'()`: that method ignores whatever of the set isn't ASCII, so ASCII's
/// letters and digits and those marks stay, everything else is its UTF-8 bytes as `%XX` (encodeURIComponent's set).
fn encode(query: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(query.len());
    for &b in query.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 15) as usize] as char);
        }
    }
    out
}

/// The search's address: the engine Safari searches with as the copy learned it (`settings.safariSearch.template`,
/// shared/search.ts safariEngine: an https address with `%s` in it), else Google's, as Safari's default; every `%s`
/// is the query, encoded.
pub fn search_url(query: &str, learned: Option<&str>) -> String {
    let template =
        learned.filter(|t| contains_characters(t, "%s") && has_prefix_characters(t, "https://")).unwrap_or(GOOGLE);
    replace_composed(template, "%s", &encode(query))
}

/// The requests the UI makes that need nothing here (its scroll, the copy's own waking).
pub const QUIET: &[&str] =
    &["sidebarScroll", "setSidebarScroll", "wakeSleeping", "windowState", "cancelNewTab", "noticeAction"];

/// The first `n` characters of a text as Swift's `prefix(_:)` counts them (whole characters: a scalar that extends the
/// one before it stays with it).
fn prefix_characters(text: &str, n: usize) -> String {
    let mut count = 0;
    for (at, c) in text.char_indices() {
        if at > 0 && (has(GRAPHEME_EXTEND, c) || c == '\u{200D}') {
            continue;
        }
        if count == n {
            return text[..at].to_string();
        }
        count += 1;
    }
    text.to_string()
}

/// An app's bundle id as the catalog takes one (AppCatalog.swift `isBundleId`): 1 to 255 bytes, ASCII letters,
/// digits, `.`, `-` and `_`, a letter or digit first.
pub fn is_bundle_id(id: &str) -> bool {
    (1..=255).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// Foundation's `CharacterSet.whitespacesAndNewlines`: the tab, Unicode's space separators and U+200B (its
/// `.whitespaces`, choice.rs's), and the line ends (U+000A–U+000D, U+0085, U+2028, U+2029).
fn white(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | '\u{85}'
            | '\u{2028}'
            | '\u{2029}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200b}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}

/// A typed query as the Swift trimmed it (`trimmingCharacters(in: .whitespacesAndNewlines)`, scalar by scalar).
pub fn trimmed(q: &str) -> &str {
    q.trim_matches(white)
}

/// One open item as the UI draws it (`live`'s tab): its item, the UI's number, its place among them, whether it's
/// the one in front, visible beside it (a split's pane, the card), playing, muted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRow {
    pub item: String,
    pub number: i64,
    pub index: i64,
    pub active: bool,
    pub visible: bool,
    pub audible: bool,
    pub muted: bool,
}

impl Core {
    /// A request the UI makes (`LibraryWindowSource.perform`): its route, as the reply (`{ route, … }`): `answer`
    /// (`value`, the request's answer), `none` (nothing to answer), `perform` (`action`, `payload`: a library edit,
    /// answered as the library answers), `settings` (`kind`, `payload`: the profile source's), with `pasteboard` (a
    /// text to put there) beside an answer. The session's flows it asks for run here (openApp at once, the history's
    /// in the queue, the start screen's, the launcher's, the preview card's); the settings a search and `addFavorite`
    /// read through the `settings` port.
    pub(crate) fn ui_request(&self, kind: &str, mut payload: Object) -> Value {
        payload.remove("hint");
        let window = swift_int(payload.get("windowId"));
        // (An open item's row: the UI's number for it, the item's id here.)
        for key in ["tabId", "nextTo"] {
            if let Some(item) = swift_int(payload.get(key)).and_then(|n| self.item_of_tab(n)) {
                payload.insert(key.into(), item.into());
            }
        }
        let ok = || json!({ "route": "answer", "value": { "ok": true, "result": true } });
        let none = || json!({ "route": "none" });
        let perform = |action: &str, p: Object| json!({ "route": "perform", "action": action, "payload": p });
        match kind {
            "updateSettings" | "updateThemeSettings" => {
                return json!({ "route": "settings", "kind": kind, "payload": payload });
            }
            // The themes a person imports or links (docs/THEME-STORE.md §1; the shell's ShellThemes.swift: its pickers,
            // the theme store, a linked folder followed): the shell's, for the window that asked. Never the library's.
            "theme.import" | "theme.link" | "theme.save" | "theme.remove" | "theme.unlink" => {
                return json!({ "route": "theme", "name": kind, "payload": payload, "window": window });
            }
            "copyUrl" => {
                let mut out = ok();
                if let Some(url) = json::string(payload.get("url")).filter(|u| !u.is_empty()) {
                    out["pasteboard"] = url.into();
                }
                return out;
            }
            "app.open" => {
                let Some(id) = json::string(payload.get("bundleId")).filter(|b| is_bundle_id(b)) else {
                    return json!({ "route": "answer", "value": { "ok": false, "error": "not a bundle id" } });
                };
                let args = json!({ "bundle": id, "window": window }).as_object().cloned().unwrap_or_default();
                self.call_flow(None, "openApp", args);
                return none();
            }
            "search" => {
                let query = trimmed(json::string(payload.get("query")).unwrap_or("")).to_string();
                if query.is_empty() {
                    return none();
                }
                let settings = self.ports.settings();
                let learned = settings.get("safariSearch").and_then(|s| s.get("template")).and_then(Value::as_str);
                let url = search_url(&query, learned);
                let p = json!({ "windowId": window, "url": url, "title": query });
                return perform("newTab", p.as_object().cloned().unwrap_or_default());
            }
            "goBack" | "goForward" | "reload" => {
                self.navigate(kind, window);
                return none();
            }
            "startup.retry" => {
                self.startup_retry();
                return none();
            }
            "startup.skip" => {
                self.startup_skip();
                return none();
            }
            "openLauncher" => {
                let settings = json::flag(payload.get("settings")) == Some(true);
                let args = json!({ "window": window, "settings": settings }).as_object().cloned().unwrap_or_default();
                self.call_flow(None, "openLauncher", args);
                return none();
            }
            "addFavorite" => {
                // (Which favorites it joins: the person's setting, whatever the page sent; the library takes the
                // scope from it and the window's space (library.ts addFavorite), never a scope a page names.)
                let settings = self.ports.settings();
                let scope = if settings.get("favoritesScope").and_then(Value::as_str) == Some("profile") {
                    "profile"
                } else {
                    "global"
                };
                payload.insert("favoritesScope".into(), scope.into());
                payload.remove("scope");
            }
            // (The preview card and Quick Tab, ui/behaviors/card.ts: card.rs's.)
            "peek.close" => {
                self.close_card(window, "its close", false);
                return ok();
            }
            "peek.expand" => {
                self.expand_card(window, json::string(payload.get("spaceId")));
                return ok();
            }
            "peek.back" | "peek.forward" => {
                self.card_history(window, kind == "peek.back");
                return ok();
            }
            "peek.littleArc" => {
                self.little_arc_opened(window, json::string(payload.get("spaceId")));
                return ok();
            }
            "peek.go" => {
                // (An address as it was typed, or a search: its address from the engine Safari searches with.)
                let query = trimmed(json::string(payload.get("query")).unwrap_or("")).to_string();
                let typed = json::string(payload.get("url")).filter(|u| self.web_address(u)).map(str::to_string);
                let url = typed.or_else(|| {
                    (!query.is_empty()).then(|| {
                        let settings = self.ports.settings();
                        let learned =
                            settings.get("safariSearch").and_then(|s| s.get("template")).and_then(Value::as_str);
                        search_url(&prefix_characters(&query, 1000), learned)
                    })
                });
                let Some(url) = url else {
                    return json!({ "route": "answer", "value": { "ok": false, "error": "no address" } });
                };
                self.little_arc_go(window, &url, json::string(payload.get("spaceId")));
                return ok();
            }
            "closeTab" if !payload.contains_key("tabId") => {
                // (⌘W: the card in that window (or Quick Tab's field), never the item under it; else the item shown.)
                if self.close_card_for_key(window) {
                    return ok();
                }
                let Some(item) = window.and_then(|w| self.shown_in(w)) else { return none() };
                payload.insert("tabId".into(), item.into());
            }
            k if QUIET.contains(&k) => {
                return json!({ "route": "answer", "value": { "ok": true, "result": null } });
            }
            _ => {}
        }
        perform(kind, payload)
    }

    /// Which open items the UI draws as open tabs of the Margin window hosting them (`live`): the items with a page,
    /// Margin's own pages shown, and the one in front (asked for and not shown yet, else the one shown), by their ids;
    /// of them each the library keeps as a tab in a space (`kept`, the Mac's snapshot's), numbered then. The window
    /// they're drawn in, and its rows; None: none listed (the snapshot drawn as it is).
    pub(crate) fn live_plan(&self, kept: &mut dyn FnMut(&str) -> bool) -> Option<(i64, Vec<LiveRow>)> {
        let (window, front, listed) = self.read(|s| {
            let window = s
                .hosting_window
                .or_else(|| s.shown.keys().next().copied())
                .or_else(|| s.requested.keys().next().copied())
                .unwrap_or(1);
            let front = s.requested.get(&window).or_else(|| s.shown.get(&window)).cloned();
            let mut listed: BTreeSet<String> = s.open.keys().cloned().collect();
            listed.extend(s.margin_open.iter().cloned());
            listed.extend(front.iter().cloned());
            (window, front, listed)
        });
        if listed.is_empty() {
            return None;
        }
        let beside: Vec<String> =
            self.layout_of(window).map(|l| l.items().map(str::to_string).collect()).unwrap_or_default();
        let mut rows = Vec::new();
        for item in listed {
            if !kept(&item) {
                continue;
            }
            let number = self.number(&item);
            let (audio, muted) = self.read(|s| (s.safari_audio.get(&item).copied(), s.safari_muted.contains(&item)));
            let active = front.as_deref() == Some(item.as_str());
            rows.push(LiveRow {
                visible: !active && beside.contains(&item),
                index: rows.len() as i64,
                number,
                active,
                audible: audio.is_some_and(|a| a.0),
                muted: audio.map_or(muted, |a| a.1),
                item,
            });
        }
        Some((window, rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_ids_and_trimming() {
        for (id, ok) in [
            ("com.apple.Notes", true),
            ("a", true),
            ("9-x_y", true),
            ("", false),
            (".a", false),
            ("a b", false),
            ("café", false),
            ("a/b", false),
        ] {
            assert_eq!(is_bundle_id(id), ok, "{id:?}");
        }
        assert!(is_bundle_id(&"a".repeat(255)) && !is_bundle_id(&"a".repeat(256)));
        assert_eq!(trimmed(" \t\n\u{3000}a b\u{2029}\u{85}\u{200b}"), "a b");
        assert_eq!(trimmed("\u{301}a"), "\u{301}a");
    }

    fn q(query: &str) -> String {
        search_url(query, None)
            .replace("https://www.google.com/search?client=safari&rls=en&q=", "")
            .replace("&ie=UTF-8&oe=UTF-8", "")
    }

    // ---- T/session-rules-tests.swift searchUrlTests, T/hosted-tests.swift 1902-1905 ----

    #[test]
    fn a_search_address() {
        assert_eq!(search_url("x", None), GOOGLE.replace("%s", "x"));
        assert!(search_url("a b&c", None).contains("q=a%20b%26c"));
        assert_eq!(q("aZ09-_.!~*'()"), "aZ09-_.!~*'()");
        assert_eq!(
            q(" &=+/?#%:@\"<>[]\\^`{|}$,;"),
            "%20%26%3D%2B%2F%3F%23%25%3A%40%22%3C%3E%5B%5D%5C%5E%60%7B%7C%7D%24%2C%3B"
        );
        assert_eq!(q("\t\n\u{7f}"), "%09%0A%7F");
        assert_eq!(q("café"), "caf%C3%A9");
        assert_eq!(q("e\u{301}"), "e%CC%81");
        assert_eq!(q("١٢"), "%D9%A1%D9%A2");
        assert_eq!(q("😀"), "%F0%9F%98%80");
        assert_eq!(q("%s"), "%25s");
        assert_eq!(q(""), "");
    }

    #[test]
    fn a_learned_template() {
        assert_eq!(
            search_url("a b", Some("https://e.example/?q=%s&again=%s")),
            "https://e.example/?q=a%20b&again=a%20b"
        );
        for t in ["https://e.example/?q=", "http://e.example/?q=%s", "javascript:%s", ""] {
            assert!(search_url("x", Some(t)).starts_with("https://www.google.com/"), "{t:?}");
        }
        assert_eq!(search_url("x", Some("https://duckduckgo.com/?q=%s")), "https://duckduckgo.com/?q=x");
    }

    // ---- what Swift and NSString make of marks beside a template's "%s" and "https://" (probed, macOS 27.2) ----

    #[test]
    fn marks_beside_the_template_as_the_swift() {
        let t = |s: &str| search_url("Q", Some(s));
        assert_eq!(
            t("https://e/?q=%s\u{301}"),
            GOOGLE.replace("%s", "Q"),
            "a mark on its s: not a %s (Swift's characters)"
        );
        assert_eq!(t("https://e/?q=\u{301}%s"), "https://e/?q=\u{301}Q");
        assert_eq!(t("https://\u{301}e/?q=%s"), GOOGLE.replace("%s", "Q"), "a mark on the prefix's last /");
        assert_eq!(t("https://e/?q=\u{600}%s"), GOOGLE.replace("%s", "Q"), "a prepended mark before its %");
        assert_eq!(t("https://e/?q=%s%s\u{301}%s"), "https://e/?q=Q%s\u{301}Q", "NSString's: not the one a mark joins");
        assert_eq!(
            t("https://e/?q=%s\u{200D}x%s"),
            "https://e/?q=Q\u{200D}xQ",
            "a joiner: Swift's character, not NSString's"
        );
        assert_eq!(t("https://e/?q=\r\n%s"), "https://e/?q=\r\nQ");
        assert_eq!(t("https://e/?q=%S"), GOOGLE.replace("%s", "Q"));
    }
}
