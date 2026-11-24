//! The copies' messages routed (docs/CORE-REFACTOR.md step 3, parts 9 and 10; Shell.swift `linkReceived`'s pushes
//! and `tellDrawn`, HostedSession.swift `copyPush`, `uiNumber`, `copyTabs`): a copy's push as it came (its JSON's
//! bytes, never a Swift dictionary), by its type: the loading bar's, the preview card's (HostedPeek.swift, the Mac's
//! until part 4 moves), the UI's (UIPush's table, push.rs) to the Margin window it belongs in; which of a copy's
//! windows Margin draws; the copy's tabs' sound.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{Core, Field, push, swift_int};
use crate::json::{self, Object};

/// Which of a copy's windows Margin draws (`drawn`, background/link.ts), as the copy is told on change: true only for
/// the ones in `hosted` (the windows the session hosts for its profile, every role), false for every other (the
/// person's own: their ⌘T and keys stay the browser's). `sent`: what each window was last told, kept for the windows
/// still listed. The changes, in the windows' order.
pub fn drawn(hosted: &[i64], windows: &[i64], sent: &mut BTreeMap<i64, bool>) -> Vec<(i64, bool)> {
    let mut out = Vec::new();
    for &id in windows {
        let on = hosted.contains(&id);
        if sent.get(&id) == Some(&on) {
            continue;
        }
        sent.insert(id, on);
        out.push((id, on));
    }
    sent.retain(|id, _| windows.contains(id));
    out
}

/// ICU's line terminators (NSRegularExpression's `.` stops at them, its `$` matches before one that ends the text).
fn terminator(c: char) -> bool {
    matches!(c, '\n' | '\u{0B}' | '\u{0C}' | '\r' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

/// Whether `rest` is nothing, or one line terminator (CR LF as one): where NSRegularExpression's `$` matches.
fn ends(rest: &str) -> bool {
    let mut c = rest.chars();
    match c.next() {
        None => true,
        Some('\r') => matches!(c.as_str(), "" | "\n"),
        Some(t) if terminator(t) => c.as_str().is_empty(),
        _ => false,
    }
}

/// An address without its fragment and a last slash, as `uiNumber` compared them: NSRegularExpression's
/// `#.*$` replaced by nothing, then `/$`.
pub fn plain(u: &str) -> String {
    // (`#.*$`: a `#`, then what's up to the line's end, matched only when that end ends the text.)
    let mut out = String::with_capacity(u.len());
    let mut from = 0;
    let mut i = 0;
    while let Some(at) = u[i..].find('#').map(|a| a + i) {
        let line = u[at + 1..].find(terminator).map_or(u.len(), |e| at + 1 + e);
        if ends(&u[line..]) {
            out.push_str(&u[from..at]);
            from = line;
            break;
        }
        i = at + 1;
    }
    out.push_str(&u[from..]);
    // (`/$`: a slash at the end, or before one line terminator that ends the text.)
    let mut cut = String::with_capacity(out.len());
    let mut from = 0;
    for (at, _) in out.match_indices('/') {
        if ends(&out[at + 1..]) {
            cut.push_str(&out[from..at]);
            from = at + 1;
        }
    }
    cut.push_str(&out[from..]);
    cut
}

impl Core {
    /// A Safari copy's push (Shell.linkReceived's `.push`), its message as the copy sent it: the loading bar's
    /// (`loading`); the preview card's (card.rs: a page's click, answered at once, the copy giving up on one, the
    /// card's page as it changes, Esc and ⌘↩ in it: the session's own, never passed to a page as they come); the UI's
    /// (push.rs's table) for the Margin window it belongs in. Any other: left.
    pub(crate) fn copy_message(&self, browser: &str, profile: &str, window: Option<i64>, msg: &Object) {
        if browser != "safari" {
            return;
        }
        let Some(kind) = json::string(msg.get("type")) else { return };
        match kind {
            "loading" => {
                let tabs: Vec<i64> = json::array(msg.get("tabIds"))
                    .map(|l| l.iter().filter_map(|t| swift_int(Some(t))).collect())
                    .unwrap_or_default();
                self.copy_loading(profile, window, &tabs);
            }
            "peekOpen" => self.peek_open(profile, window, msg),
            "peekCancel" => self.peek_cancel(profile, msg),
            "cardPage" => self.card_page(profile, window, msg),
            "cardKey" => self.card_key(profile, window, json::string(msg.get("key")).unwrap_or("")),
            k if push::forwarded(k) => self.copy_push(profile, window, msg),
            _ => {}
        }
    }

    /// A push of a Safari profile's copy for its UI (only the types passed on, checked and cut: push.rs), for a
    /// window Margin hosts for that profile, any role (the person's own windows: not Margin's), to the Margin window it
    /// belongs in. Its tabs named by the UI's numbers for their items (`ui_number`); one that isn't an item open in
    /// Margin is left out. Which window (DECISIONS.md, the mini player): the Margin window showing the space of the
    /// item it's about (the first source: the copy lists playing ones first, the newest first), the hosting one or
    /// the one in front first among several; none showing it: the hosting window, else the one in front. A standing
    /// push (`media`) is taken back from the window that had it when another gets it (its empty one).
    pub(crate) fn copy_push(&self, profile: &str, window: Option<i64>, msg: &Object) {
        let Some(window) = window else { return };
        let ours = self.read(|s| s.safari_windows.iter().any(|((p, _), id)| p == profile && *id == window));
        let Some(kind) = json::string(msg.get("type")) else { return };
        if !ours {
            return;
        }
        let mut items: Vec<String> = Vec::new();
        let Some(page) = push::page(msg, &mut |entry| {
            let (item, n) = self.ui_number(profile, entry)?;
            items.push(item);
            Some(n)
        }) else {
            return;
        };
        let ids = self.ports.window_ids();
        let showing: Vec<i64> = match items.first().and_then(|i| self.space_of_item(i)) {
            Some(space) => {
                ids.into_iter().filter(|w| self.space_of_window(*w).as_deref() == Some(space.as_str())).collect()
            }
            None => Vec::new(),
        };
        let front = self.ports.window(None);
        let hosting = self.read(|s| s.hosting_window);
        let pick = showing
            .iter()
            .find(|w| Some(**w) == hosting)
            .or_else(|| showing.iter().find(|w| Some(**w) == front))
            .copied()
            .or_else(|| showing.iter().min().copied())
            .or(hosting)
            .or(front);
        let Some(pick) = pick else { return };
        let Some(target) = self.ports.window(Some(pick)) else { return };
        let empty = page.values().filter_map(Value::as_array).all(Vec::is_empty);
        let text = Value::Object(page).to_string();
        if push::STANDING.contains(&kind) {
            let had = self.read(|s| s.standing_to.get(kind).copied());
            if let Some(had) = had
                && had != pick
                && let Some(empty) = push::empty(kind)
                && let Some(w) = self.ports.window(Some(had))
            {
                self.ports.push(w, &Value::Object(empty).to_string());
            }
            let mut s = self.state.borrow_mut();
            if empty {
                s.standing_to.remove(kind);
            } else {
                s.standing_to.insert(kind.to_string(), pick);
            }
        }
        self.ports.push(target, &text);
    }

    /// The item a copy's tab shows, and the UI's number for it: the item the copy names (its tag:
    /// background/hosted.ts), else the item whose tab it is (hostShow's answer), else the open item of that profile at
    /// its address (a copy started again knows no tags until the next hostShow, and Safari's tab ids change as it
    /// restarts). The tab is kept as that item's (`hostMedia` names it). None: not one of Margin's items open in that
    /// profile. (Several items with that tab: the first by id, where Swift took its dictionary's first.)
    fn ui_number(&self, profile: &str, entry: &Object) -> Option<(String, i64)> {
        let tab = swift_int(entry.get("tabId"));
        let of_profile =
            |item: &str| self.read(|s| s.open.get(item).is_some_and(|o| o.profile.as_deref() == Some(profile)));
        let mut item = json::string(entry.get("itemId")).filter(|i| of_profile(i)).map(str::to_string);
        if item.is_none()
            && let Some(tab) = tab
        {
            let tabs: Vec<String> =
                self.read(|s| s.safari_tabs.iter().filter(|(_, t)| **t == tab).map(|(i, _)| i.clone()).collect());
            item = tabs.into_iter().find(|i| of_profile(i));
        }
        if item.is_none()
            && let Some(url) = json::string(entry.get("url")).filter(|u| !u.is_empty())
        {
            let want = plain(url);
            let open: Vec<String> = self.read(|s| s.open.keys().cloned().collect());
            item =
                open.into_iter().find(|i| of_profile(i) && self.item_url(i).map(|u| plain(&u)) == Some(want.clone()));
        }
        let item = item?;
        if let Some(tab) = tab {
            self.edit(Field::SafariTabs, |s| s.safari_tabs.insert(item.clone(), tab));
        }
        let n = self.number(&item);
        Some((item, n))
    }

    /// A Safari copy's tabs, as its state says them now (`openTabs.tabs`): for each item with a tab in that profile's
    /// hosted window (`safariTabs`), whether it plays sound and is muted. The windows draw again when that changed.
    pub(crate) fn copy_tabs(&self, profile: &str, tabs: &Object) {
        let mine: Vec<(String, i64)> = self.read(|s| {
            s.safari_tabs
                .iter()
                .filter(|(i, _)| s.open.get(*i).is_some_and(|o| o.profile.as_deref() == Some(profile)))
                .map(|(i, t)| (i.clone(), *t))
                .collect()
        });
        let mut changed = false;
        for (item, tab) in mine {
            let now = json::object(tabs.get(&tab.to_string()))
                .map(|r| (json::flag(r.get("audible")) == Some(true), json::flag(r.get("muted")) == Some(true)));
            let had = self.read(|s| s.safari_audio.get(&item).copied());
            if now.map(|n| n.0) != had.map(|h| h.0) || now.map(|n| n.1) != had.map(|h| h.1) {
                self.edit(Field::SafariAudio, |s| match now {
                    Some(n) => s.safari_audio.insert(item.clone(), n),
                    None => s.safari_audio.remove(&item),
                });
                changed = true;
            }
        }
        if changed {
            self.ports.changed();
        }
    }

    /// The windows Margin draws of a copy's (`drawn`'s `hosted`): a Safari copy's every role's hosted window for its
    /// profile; none of another browser's.
    pub(crate) fn drawn_windows(&self, browser: &str, profile: &str) -> Vec<i64> {
        if browser != "safari" {
            return Vec::new();
        }
        self.read(|s| s.safari_windows.iter().filter(|((p, _), _)| p == profile).map(|(_, id)| *id).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_plain() {
        for (u, want) in [
            ("https://a.example/", "https://a.example"),
            ("https://a.example/#t=3", "https://a.example"),
            ("https://a.example/x#a#b", "https://a.example/x"),
            ("https://a.example//", "https://a.example/"),
            ("https://a.example/\n", "https://a.example\n"),
            ("https://a.example/#x\n", "https://a.example\n"),
            ("https://a.example/#x\r\n", "https://a.example\r\n"),
            ("a#b\nc#d", "a#b\nc"),
            ("a#b\n\n", "a#b\n\n"),
            ("a/\n\n", "a/\n\n"),
            ("a/\u{2029}", "a\u{2029}"),
            ("#", ""),
            ("/", ""),
            ("", ""),
        ] {
            assert_eq!(plain(u), want, "{u:?}");
        }
    }

    #[test]
    fn drawn_only_on_change_for_the_windows_listed() {
        let mut sent = BTreeMap::new();
        assert_eq!(drawn(&[90], &[90, 91, 91], &mut sent), [(90, true), (91, false)]);
        assert!(drawn(&[90], &[90, 91], &mut sent).is_empty());
        assert_eq!(drawn(&[], &[90], &mut sent), [(90, false)]);
        assert_eq!(sent.len(), 1, "a window no longer listed forgotten");
        assert_eq!(drawn(&[91], &[91], &mut sent), [(91, true)], "told again once it's back");
    }
}
