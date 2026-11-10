//! The app's copy of one extension copy's state (app/platforms/macos/shell/StateMirror.swift): storage.local's keys, as the
//! extension sends them (a snapshot, then deltas: docs/PROTOCOL.md), each kept as the JSON it came as. An overlay's
//! page gets the whole state from here at once (no round trip, so nothing to wait for before it draws); the app
//! itself reads only the little it needs ([`StateMirror::value`]).
//!
//! One mirror per link (per browser profile): `epoch` is the copy's for this connection, and nothing from another
//! epoch is taken. Snapshots, deltas and window lists count up together (`seq`, from 1 each epoch); on the link
//! they come in order, so a number missed is a bug somewhere, and the state is asked for whole again
//! ([`Outcome::Gap`]: a resync), with what comes before it left. [`Resync`] is Shell.swift's resync timer: the
//! `resync` sent at once and again every 2 s until a snapshot comes.

use crate::json::Object;
use crate::protocol::{Change, Hello, LinkMessage};
use crate::time::Secs;
use serde_json::Value;
use std::collections::BTreeMap;

/// `StateMirror.Outcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    /// Another epoch's, or the state is being asked for again (a resync).
    Ignored,
    /// A number missed: ask for the state again (until it comes, the rest is ignored).
    Gap {
        expected: i64,
        got: i64,
    },
}

/// `StateMirror`.
#[derive(Clone, Debug, Default)]
pub struct StateMirror {
    epoch: Option<String>,
    seq: i64,
    /// The copy of Margin whose ids the state has (its hello).
    origin: Option<String>,
    since: Option<f64>,
    windows: Vec<Object>,
    /// Each stored key's value, as JSON text.
    values: BTreeMap<String, String>,
    /// The site icons by origin (deltas send only those that changed), as JSON text.
    favicons: BTreeMap<String, String>,
    has_favicons: bool,
    snapshotted: bool,
    resyncing: bool,
}

fn json_text(v: &Value) -> Option<String> {
    serde_json::to_string(v).ok()
}

impl StateMirror {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn epoch(&self) -> Option<&str> {
        self.epoch.as_deref()
    }
    pub fn seq(&self) -> i64 {
        self.seq
    }
    pub fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }
    pub fn since(&self) -> Option<f64> {
        self.since
    }
    pub fn windows(&self) -> &[Object] {
        &self.windows
    }
    /// `hasState`: a snapshot has come this epoch.
    pub fn has_state(&self) -> bool {
        self.snapshotted
    }
    /// `isResyncing`: a number missed, and the snapshot asked for not yet come.
    pub fn is_resyncing(&self) -> bool {
        self.resyncing
    }

    /// `begin`: a new connection: nothing from before it is kept.
    pub fn begin(&mut self, hello: &Hello) {
        self.reset();
        self.epoch = Some(hello.epoch.clone());
        self.origin = hello.origin.clone();
        self.since = hello.since;
    }

    /// `askAgain`: a snapshot is asked for again (after a gap): until it comes, deltas are left.
    pub fn ask_again(&mut self) {
        self.resyncing = true;
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn apply(&mut self, message: &LinkMessage) -> Outcome {
        match message {
            LinkMessage::Snapshot { epoch, seq, state, windows } => {
                if self.epoch.as_deref() != Some(epoch.as_str()) {
                    return Outcome::Ignored;
                }
                self.values.clear();
                self.favicons.clear();
                self.has_favicons = false;
                for (key, value) in state {
                    if let (true, Some(icons)) = (key == "favicons", value.as_object()) {
                        self.has_favicons = true;
                        for (site, entry) in icons {
                            if let Some(json) = json_text(entry) {
                                self.favicons.insert(site.clone(), json);
                            }
                        }
                    } else if let Some(json) = json_text(value) {
                        self.values.insert(key.clone(), json);
                    }
                }
                self.windows = windows.clone();
                self.seq = *seq;
                self.snapshotted = true;
                self.resyncing = false;
                Outcome::Applied
            }
            LinkMessage::Delta { epoch, seq, changes, favicons } => {
                let outcome = self.next(epoch, *seq);
                if outcome != Outcome::Applied {
                    return outcome;
                }
                for (key, change) in changes.iter().filter(|(k, _)| k.as_str() != "favicons") {
                    match change.clone() {
                        Change::Set(value) => match json_text(&value) {
                            Some(json) => self.values.insert(key.clone(), json),
                            None => self.values.remove(key),
                        },
                        Change::Removed => self.values.remove(key),
                    };
                }
                if let Some(icons) = favicons {
                    self.has_favicons = true;
                    for (site, entry) in &icons.set {
                        if let Some(json) = json_text(entry) {
                            self.favicons.insert(site.clone(), json);
                        }
                    }
                    for site in &icons.del {
                        self.favicons.remove(site);
                    }
                }
                Outcome::Applied
            }
            LinkMessage::Windows { epoch, seq, list } => {
                let outcome = self.next(epoch, *seq);
                if outcome != Outcome::Applied {
                    return outcome;
                }
                self.windows = list.clone();
                Outcome::Applied
            }
            _ => Outcome::Ignored,
        }
    }

    /// Whether a delta or window list numbered `seq` follows on (counted if so).
    fn next(&mut self, epoch: &str, seq: i64) -> Outcome {
        if self.epoch.as_deref() != Some(epoch) || self.resyncing {
            return Outcome::Ignored;
        }
        let expected = self.seq.saturating_add(1);
        if !self.snapshotted || seq != expected {
            self.resyncing = true;
            return Outcome::Gap { expected, got: seq };
        }
        self.seq = seq;
        Outcome::Applied
    }

    /// `stateJSON`: the whole state as one JSON object (storage.local's keys, as a page's fromStorage reads them);
    /// `None` before the first snapshot.
    pub fn state_json(&self) -> Option<String> {
        if !self.snapshotted {
            return None;
        }
        if !self.has_favicons {
            return Some(object(&self.values));
        }
        let mut entries = self.values.clone();
        entries.insert("favicons".into(), object(&self.favicons));
        Some(object(&entries))
    }

    /// `value`: one stored key, read (for the app's own use).
    pub fn value(&self, key: &str) -> Option<Value> {
        if key == "favicons" {
            return if self.has_favicons { serde_json::from_str(&object(&self.favicons)).ok() } else { None };
        }
        self.values.get(key).and_then(|json| serde_json::from_str(json).ok())
    }

    /// `keys`: the stored keys, sorted (`favicons` among them once any came).
    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.values.keys().cloned().collect();
        if self.has_favicons {
            keys.push("favicons".into());
        }
        keys.sort();
        keys
    }
}

/// `{"key":json,…}`, from JSON already made, the keys sorted.
fn object(parts: &BTreeMap<String, String>) -> String {
    let mut out = String::from("{");
    for (i, (key, json)) in parts.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()));
        out.push(':');
        out.push_str(json);
    }
    out.push('}');
    out
}

/// Shell.swift's resync timer (`resync(_:)`, `options.resyncRetry`): after a gap a `resync` goes at once, and again
/// every [`Resync::RETRY`] seconds while the mirror is still resyncing; anything applied (the snapshot) stops it, as
/// does the link going.
#[derive(Clone, Debug)]
pub struct Resync {
    retry: Secs,
    due: Option<Secs>,
}

impl Default for Resync {
    fn default() -> Self {
        Self::new(Self::RETRY)
    }
}

impl Resync {
    /// `resyncRetry`: 2 s.
    pub const RETRY: Secs = 2.0;

    pub fn new(retry: Secs) -> Self {
        Self { retry, due: None }
    }

    /// After [`StateMirror::apply`]: whether to send a `resync` now (a gap: the retry is set too). Applied stops the
    /// retries; ignored leaves them as they are.
    pub fn after(&mut self, outcome: Outcome, now: Secs) -> bool {
        match outcome {
            Outcome::Applied => {
                self.due = None;
                false
            }
            Outcome::Gap { .. } => {
                self.due = Some(now + self.retry);
                true
            }
            Outcome::Ignored => false,
        }
    }

    /// Whether a `resync` is due again now (the mirror still waiting for its snapshot): the next one is set. A
    /// mirror that isn't resyncing any more ends the retries.
    pub fn tick(&mut self, now: Secs, mirror: &StateMirror) -> bool {
        let Some(due) = self.due else { return false };
        if now < due {
            return false;
        }
        if !mirror.is_resyncing() {
            self.due = None;
            return false;
        }
        self.due = Some(now + self.retry);
        true
    }

    /// When the next retry is due, if one is.
    pub fn due_at(&self) -> Option<Secs> {
        self.due
    }

    /// The link went (Shell.linkDown).
    pub fn cancel(&mut self) {
        self.due = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Favicons;
    use serde_json::json;

    fn obj(v: Value) -> Object {
        v.as_object().cloned().unwrap_or_default()
    }

    fn hello(epoch: &str, origin: &str, since: f64) -> Hello {
        Hello {
            epoch: epoch.into(),
            profile: "P1".into(),
            browser: "safari".into(),
            ext: None,
            owner: true,
            instance_id: None,
            origin: Some(origin.into()),
            since: Some(since),
            pid: None,
            sockets_off: None,
        }
    }

    fn snapshot(epoch: &str, seq: i64, state: Value, windows: Vec<Value>) -> LinkMessage {
        LinkMessage::Snapshot {
            epoch: epoch.into(),
            seq,
            state: obj(state),
            windows: windows.into_iter().map(obj).collect(),
        }
    }

    fn delta(epoch: &str, seq: i64, changes: Vec<(&str, Change)>, favicons: Option<Favicons>) -> LinkMessage {
        LinkMessage::Delta {
            epoch: epoch.into(),
            seq,
            changes: changes.into_iter().map(|(k, c)| (k.to_owned(), c)).collect(),
            favicons,
        }
    }

    fn windows(epoch: &str, seq: i64, n: i64) -> LinkMessage {
        LinkMessage::Windows { epoch: epoch.into(), seq, list: (1..=n).map(|i| obj(json!({"windowId": i}))).collect() }
    }

    fn state(m: &StateMirror) -> Value {
        m.state_json().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
    }

    // ---- tests.swift mirror() ----

    #[test]
    fn mirror() {
        let mut m = StateMirror::new();
        let snap = snapshot(
            "e1",
            1,
            json!({"spaces":[{"id":"a"}],"settings":{"sidebarPinnedOpen":true},"favicons":{"https://a.example":{"icon":"A"},"https://b.example":{"icon":"B"}}}),
            vec![json!({"windowId":1})],
        );
        assert_eq!(m.apply(&snap), Outcome::Ignored, "nothing before hello");
        assert!(!m.has_state());
        assert_eq!(m.state_json(), None);

        m.begin(&hello("e1", "o", 5.0));
        assert_eq!(
            m.apply(&delta("e1", 1, vec![], None)),
            Outcome::Gap { expected: 1, got: 1 },
            "a delta before the snapshot"
        );
        assert_eq!(m.apply(&snap), Outcome::Applied, "a snapshot ends the resync");
        assert!(m.has_state());
        assert_eq!((m.seq(), m.windows().len(), m.origin(), m.since()), (1, 1, Some("o"), Some(5.0)));
        assert_eq!(
            state(&m),
            json!({"spaces":[{"id":"a"}],"settings":{"sidebarPinnedOpen":true},"favicons":{"https://a.example":{"icon":"A"},"https://b.example":{"icon":"B"}}}),
            "the state as it came"
        );

        let d = delta(
            "e1",
            2,
            vec![("pins", Change::Set(json!([{"id":"p"}]))), ("settings", Change::Removed)],
            Some(Favicons {
                set: obj(json!({"https://c.example":{"icon":"C"},"https://a.example":{"icon":"A2"}})),
                del: vec!["https://b.example".into()],
            }),
        );
        assert_eq!(m.apply(&d), Outcome::Applied);
        assert_eq!(m.seq(), 2);
        assert_eq!(
            state(&m),
            json!({"spaces":[{"id":"a"}],"pins":[{"id":"p"}],"favicons":{"https://a.example":{"icon":"A2"},"https://c.example":{"icon":"C"}}}),
            "set, removed, icons diffed"
        );

        assert_eq!(m.apply(&windows("e1", 3, 2)), Outcome::Applied, "windows count with the rest");
        assert_eq!((m.windows().len(), m.seq()), (2, 3));
        assert_eq!(m.apply(&windows("e0", 4, 0)), Outcome::Ignored, "another epoch's: left");
        assert_eq!((m.windows().len(), m.seq()), (2, 3));

        assert_eq!(
            m.apply(&delta("e1", 5, vec![("pins", Change::Set(json!([])))], None)),
            Outcome::Gap { expected: 4, got: 5 }
        );
        assert_eq!(
            m.apply(&delta("e1", 6, vec![("pins", Change::Set(json!([])))], None)),
            Outcome::Ignored,
            "left until the state comes"
        );
        assert_eq!(m.apply(&windows("e1", 4, 0)), Outcome::Ignored, "even the number that was missed");
        assert!(m.is_resyncing());
        assert_eq!(
            m.apply(&snapshot("e1", 7, json!({"pins":[]}), vec![])),
            Outcome::Applied,
            "a resync's snapshot, numbered on"
        );
        assert_eq!((m.keys(), m.seq(), m.is_resyncing()), (vec!["pins".to_owned()], 7, false));
        assert_eq!(
            m.apply(&delta("e1", 8, vec![("spaces", Change::Set(json!([])))], None)),
            Outcome::Applied,
            "and on from it"
        );
        assert_eq!(m.keys(), vec!["pins".to_owned(), "spaces".to_owned()]);
        assert_eq!(m.apply(&delta("e1", 9, vec![("archive", Change::Set(Value::Null))], None)), Outcome::Applied);
        assert_eq!(state(&m).get("archive"), Some(&Value::Null), "a stored null kept");

        m.begin(&hello("e2", "o2", 6.0));
        assert!(!m.has_state() && m.keys().is_empty() && m.seq() == 0 && m.windows().is_empty());
        assert_eq!(m.origin(), Some("o2"), "a new connection: nothing kept");
        assert_eq!(
            m.apply(&snapshot("e1", 1, json!({"a":1}), vec![])),
            Outcome::Ignored,
            "the old epoch's snapshot: left"
        );
    }

    #[test]
    fn a_snapshot_may_come_with_any_seq() {
        let mut m = StateMirror::new();
        m.begin(&hello("e", "o", 1.0));
        assert_eq!(m.apply(&snapshot("e", 41, json!({}), vec![])), Outcome::Applied);
        assert_eq!(m.apply(&windows("e", 42, 1)), Outcome::Applied);
        assert_eq!(m.apply(&windows("e", 42, 1)), Outcome::Gap { expected: 43, got: 42 }, "a number again: a gap too");
    }

    #[test]
    fn favicons_in_deltas() {
        let mut m = StateMirror::new();
        m.begin(&hello("e", "o", 1.0));
        m.apply(&snapshot("e", 1, json!({"spaces":[]}), vec![]));
        assert_eq!(m.value("favicons"), None, "no icons yet");
        assert_eq!(m.keys(), vec!["spaces".to_owned()]);
        // A `favicons` key in changes is left: icons go only as the diff.
        m.apply(&delta("e", 2, vec![("favicons", Change::Set(json!({"x":1})))], None));
        assert_eq!(m.value("favicons"), None);
        m.apply(&delta("e", 3, vec![], Some(Favicons { set: obj(json!({"https://a":{"icon":"A"}})), del: vec![] })));
        assert_eq!(m.value("favicons"), Some(json!({"https://a":{"icon":"A"}})));
        assert_eq!(m.keys(), vec!["favicons".to_owned(), "spaces".to_owned()]);
        m.apply(&delta("e", 4, vec![], Some(Favicons { set: Object::new(), del: vec!["https://a".into()] })));
        assert_eq!(m.value("favicons"), Some(json!({})), "every icon gone: still an object");
        assert_eq!(state(&m), json!({"spaces":[],"favicons":{}}));
    }

    #[test]
    fn values_read_back() {
        let mut m = StateMirror::new();
        m.begin(&hello("e", "o", 1.0));
        m.apply(&snapshot("e", 1, json!({"settings":{"theme":"arcadia"},"n":3,"s":"x"}), vec![]));
        assert_eq!(m.value("settings"), Some(json!({"theme":"arcadia"})));
        assert_eq!(m.value("n"), Some(json!(3)));
        assert_eq!(m.value("s"), Some(json!("x")));
        assert_eq!(m.value("none"), None);
        // A key with characters JSON escapes, kept as a key.
        m.apply(&delta("e", 2, vec![("a\"b", Change::Set(json!(1)))], None));
        assert_eq!(state(&m).get("a\"b"), Some(&json!(1)));
    }

    #[test]
    fn resync_every_2_s_until_a_snapshot() {
        let mut m = StateMirror::new();
        let mut r = Resync::default();
        m.begin(&hello("e", "o", 1.0));
        assert!(!r.tick(100.0, &m), "nothing to retry");
        let gap = m.apply(&windows("e", 1, 1));
        assert!(r.after(gap, 10.0), "a gap: resync at once");
        assert_eq!(r.due_at(), Some(12.0));
        assert!(!r.tick(11.9, &m));
        assert!(r.tick(12.0, &m), "2 s on: again");
        assert!(!r.tick(13.0, &m));
        assert!(r.tick(14.5, &m), "and every 2 s");
        assert_eq!(r.due_at(), Some(16.5));
        let ignored = m.apply(&windows("e", 2, 1));
        assert!(!r.after(ignored, 15.0), "deltas while resyncing: ignored, the retry left as it is");
        assert_eq!(r.due_at(), Some(16.5));
        let applied = m.apply(&snapshot("e", 9, json!({}), vec![]));
        assert!(!r.after(applied, 15.5), "the snapshot: no more");
        assert!(!r.tick(100.0, &m));
        // A retry due after the mirror stopped resyncing some other way (a new epoch): ends.
        let gap = m.apply(&windows("e", 20, 1));
        assert!(r.after(gap, 200.0));
        m.begin(&hello("e2", "o", 1.0));
        assert!(!r.tick(202.0, &m));
        assert_eq!(r.due_at(), None);
        let gap = m.apply(&windows("e2", 3, 1));
        assert!(r.after(gap, 300.0));
        r.cancel();
        assert!(!r.tick(302.0, &m), "the link gone: no more");
    }
}
