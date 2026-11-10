//! What the shell keeps per link of what it told the copy (Shell.swift `LayoutOutbox`, `DrawnOutbox`) and of what
//! the copy pushed for overlays made later (`HeldPushes`). Constants, rules and log words are the Swift's.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::json::{self, Object};
use crate::protocol::PageLayout;
use crate::time::Secs;

/// What's been sent of each window's layout: only a change goes again, numbered per window.
#[derive(Clone, Debug, Default)]
pub struct LayoutOutbox {
    sent: HashMap<i64, PageLayout>,
    seq: HashMap<i64, i64>,
}

impl LayoutOutbox {
    /// The next number and the layout to send, or `None` if it's what was sent last (to half a point).
    pub fn offer(&mut self, window_id: i64, layout: &PageLayout) -> Option<(i64, PageLayout)> {
        let rounded = layout.rounded();
        if self.sent.get(&window_id) == Some(&rounded) {
            return None;
        }
        self.sent.insert(window_id, rounded.clone());
        let next = self.seq.get(&window_id).copied().unwrap_or(0) + 1;
        self.seq.insert(window_id, next);
        Some((next, rounded))
    }

    pub fn forget(&mut self, window_id: i64) {
        self.sent.remove(&window_id);
    }

    pub fn reset(&mut self) {
        self.sent.clear();
        self.seq.clear();
    }
}

/// `DrawnOutbox.Grace`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawnGrace {
    /// Covers the full-screen animation.
    pub not_wanted: Secs,
    pub never_bound: Secs,
    /// The binder keeps a window missing from a read for 3 s (WindowBinder).
    pub unbound: Secs,
}

impl Default for DrawnGrace {
    fn default() -> Self {
        Self { not_wanted: 1.5, never_bound: 1.5, unbound: 3.0 }
    }
}

/// What [`DrawnOutbox::offer`] says: what to send (`None`: nothing), why, and when to look again if off is pending.
#[derive(Clone, Debug, PartialEq)]
pub struct DrawnOffer {
    pub send: Option<bool>,
    pub why: String,
    pub due: Option<Secs>,
}

/// Whether the app draws over each of one copy's windows, as the copy is told (`drawn`, docs/PROTOCOL.md). On while
/// the window is bound and wanted (in full screen, or windowed overlays allowed, with the copy's theme here); off only
/// after a grace: not wanted for `not_wanted`, never bound since its copy first reported it for `never_bound`, bound
/// before and unbound now for `unbound`. A closed window that was on: off at once. Only a change is sent.
#[derive(Clone, Debug, Default)]
pub struct DrawnOutbox {
    pub grace: DrawnGrace,
    sent: BTreeMap<i64, bool>,
    ever_bound: BTreeSet<i64>,
    /// When the window stopped being drawn (or was first reported).
    off_since: BTreeMap<i64, Secs>,
}

impl DrawnOutbox {
    pub fn new(grace: DrawnGrace) -> Self {
        Self { grace, ..Self::default() }
    }

    /// The windows it has heard of.
    pub fn windows(&self) -> BTreeSet<i64> {
        self.off_since.keys().chain(self.sent.keys()).chain(self.ever_bound.iter()).copied().collect()
    }

    pub fn sent(&self, window_id: i64) -> Option<bool> {
        self.sent.get(&window_id).copied()
    }

    /// `pending`: not bound, but its window is one of the browser's same-bounds windows off screen, none of them bound
    /// and none on screen: on as if bound.
    pub fn offer(&mut self, id: i64, now: Secs, bound: bool, wanted: bool, pending: bool) -> DrawnOffer {
        let none = |due| DrawnOffer { send: None, why: String::new(), due };
        if bound {
            self.ever_bound.insert(id);
        }
        if (bound || pending) && wanted {
            self.off_since.remove(&id);
            if self.sent.get(&id) == Some(&true) {
                return none(None);
            }
            self.sent.insert(id, true);
            let why = if bound {
                "bound, and in full screen"
            } else {
                "in full screen, not bound yet: its window is one of the browser's same-bounds windows off screen"
            };
            return DrawnOffer { send: Some(true), why: why.into(), due: None };
        }
        let since = *self.off_since.entry(id).or_insert(now);
        let (wait, why) = if !wanted {
            (self.grace.not_wanted, "not in full screen (or no theme yet)")
        } else if self.ever_bound.contains(&id) {
            (self.grace.unbound, "no longer bound to one of the window server's")
        } else {
            (self.grace.never_bound, "not bound to one of the window server's since its copy reported it")
        };
        if self.sent.get(&id) == Some(&false) {
            return none(None);
        }
        let due = since + wait;
        if now < due {
            return none(Some(due));
        }
        self.sent.insert(id, false);
        DrawnOffer { send: Some(false), why: format!("{why} for {:.1} s", now - since), due: None }
    }

    /// A palette the app couldn't show over the window: off now, whatever the grace. True if that's a change to send.
    pub fn not_shown(&mut self, id: i64, now: Secs) -> bool {
        if self.sent.get(&id) == Some(&false) {
            return false;
        }
        self.sent.insert(id, false);
        self.off_since.entry(id).or_insert(now);
        true
    }

    /// The window closed (its copy no longer reports it): off, if it was on; forgotten.
    pub fn closed(&mut self, id: i64) -> Option<bool> {
        let was_on = self.sent.remove(&id) == Some(true);
        self.ever_bound.remove(&id);
        self.off_since.remove(&id);
        was_on.then_some(false)
    }
}

/// What a copy pushed for a window that an overlay made later still needs (docs/PROTOCOL.md "Notices, loading and
/// gestures"): its last notice, for [`HeldPushes::NOTICE_FOR`], and its last set of tabs loading, given to each
/// overlay's page with its hello (`held`).
#[derive(Clone, Debug, Default)]
pub struct HeldPushes {
    /// Window (`None`: every window) → type → the last push and when.
    held: BTreeMap<Option<i64>, BTreeMap<String, (Object, Secs)>>,
}

impl HeldPushes {
    pub const TYPES: [&'static str; 2] = ["notice", "loading"];
    pub const NOTICE_FOR: Secs = 60.0;

    pub fn offer(&mut self, window_id: Option<i64>, msg: &Object, at: Secs) {
        let Some(kind) = json::string(msg.get("type")).filter(|t| Self::TYPES.contains(t)) else { return };
        self.held.entry(window_id).or_default().insert(kind.to_owned(), (msg.clone(), at));
    }

    /// A window's, oldest first: every window's and its own; a notice only while it's recent.
    pub fn messages(&self, window_id: i64, now: Secs) -> Vec<Object> {
        let mut entries: Vec<(&str, &Object, Secs)> = [None, Some(window_id)]
            .iter()
            .filter_map(|w| self.held.get(w))
            .flat_map(|m| m.iter().map(|(k, (msg, at))| (k.as_str(), msg, *at)))
            .filter(|(k, _, at)| *k != "notice" || now - at <= Self::NOTICE_FOR)
            .collect();
        entries.sort_by(|a, b| a.2.total_cmp(&b.2));
        entries.into_iter().map(|(_, m, _)| m.clone()).collect()
    }

    pub fn forget(&mut self, window_id: i64) {
        self.held.remove(&Some(window_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layout(left: f64) -> PageLayout {
        PageLayout {
            left,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
            radius: 8.0,
            radii: vec![8.0; 4],
            width: 1000.0,
            height: 800.0,
            mode: "fullscreen".into(),
        }
    }

    #[test]
    fn a_layout_goes_once_numbered() {
        let mut o = LayoutOutbox::default();
        assert_eq!(o.offer(1, &layout(280.0)).map(|x| x.0), Some(1));
        assert_eq!(o.offer(1, &layout(280.2)), None, "the same to half a point");
        assert_eq!(o.offer(1, &layout(300.0)).map(|x| x.0), Some(2));
        assert_eq!(o.offer(2, &layout(300.0)).map(|x| x.0), Some(1), "per window");
    }

    #[test]
    fn drawn_on_at_once_off_after_the_grace() {
        let mut d = DrawnOutbox::default();
        assert_eq!(d.offer(1, 0.0, true, true, false).send, Some(true));
        assert_eq!(d.offer(1, 0.1, true, true, false).send, None);
        let r = d.offer(1, 1.0, false, true, false);
        assert_eq!((r.send, r.due), (None, Some(4.0)), "unbound: 3 s");
        let r = d.offer(1, 4.0, false, true, false);
        assert_eq!(r.send, Some(false));
        assert!(r.why.starts_with("no longer bound"), "{}", r.why);
        assert_eq!(d.offer(2, 0.0, false, true, false).due, Some(1.5), "never bound: 1.5 s");
        assert_eq!(d.offer(1, 5.0, true, true, false).send, Some(true));
        assert_eq!(d.closed(1), Some(false));
        assert_eq!(d.closed(1), None);
        assert!(d.not_shown(3, 0.0));
        assert!(!d.not_shown(3, 0.1));
    }

    #[test]
    fn held_pushes_for_a_later_overlay() {
        let mut h = HeldPushes::default();
        let notice = json!({ "type": "notice", "kind": "not-responding" }).as_object().cloned().unwrap_or_default();
        let loading = json!({ "type": "loading", "tabIds": [3] }).as_object().cloned().unwrap_or_default();
        let other = json!({ "type": "switching" }).as_object().cloned().unwrap_or_default();
        h.offer(Some(7), &notice, 10.0);
        h.offer(None, &loading, 5.0);
        h.offer(Some(7), &other, 11.0);
        assert_eq!(h.messages(7, 12.0), vec![loading.clone(), notice]);
        assert_eq!(h.messages(7, 100.0), vec![loading.clone()], "a notice only for 60 s");
        assert_eq!(h.messages(8, 12.0), vec![loading]);
    }
}
