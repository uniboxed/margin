//! The session's state the core keeps (HostedSession's fields, HS:385-433), moved in as the flows that read them move:
//! each Margin window's item shown, each item with a page, each Safari profile's hosted windows by role. While Swift
//! flows still write them, the Swift facade reads a field again only when its revision changed, and writes the
//! difference (`put`, `del`), never the whole field.
//!
//! Every list is JSON arrays (an id that's a number stays one): `shown` `[[window, item]]`, `open`
//! `[[item, host, profile | null]]`, `safariWindows` `[[profile, role, windowId]]` (`role`: `main`, `card`, `pane1`…).
//! Commit 5's (the library's requests, the show, the engine's window asks): `requested` `[[window, item]]`,
//! `labels` `[[host, label]]`, `showing` `[[host, item]]`, `marginPages` `[[window, page]]`, `cycledAt`
//! `[[window, seconds]]`, `safariTabs` `[[item, tab]]`, `safariAudio` `[[item, audible, muted]]`; the sets
//! `marginOpen`, `safariMuted`, `requesting` `[[item]]`… and `made` `[[windowId]]`; the one values `hostingWindow`,
//! `preparingWindow` `[[window]]` and `preparingProfile` `[[profile]]` (none: `[]`; a `del` of anything clears one).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::hosted_browser::Role;
use crate::json;

/// Where an item's page is: its host, and for a web item its profile (HostedSession `OpenItem`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenItem {
    pub host: String,
    pub profile: Option<String>,
}

/// The fields with a revision (`margin_session_rev`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Shown = 0,
    Open = 1,
    SafariWindows = 2,
    /// The log lines kept (`done`): its revision is how many were ever kept.
    Done = 3,
    Requested = 4,
    HostingWindow = 5,
    Labels = 6,
    Showing = 7,
    MarginPages = 8,
    MarginOpen = 9,
    CycledAt = 10,
    SafariTabs = 11,
    SafariMuted = 12,
    SafariAudio = 13,
    PreparingWindow = 14,
    PreparingProfile = 15,
    Requesting = 16,
    Made = 17,
}

impl Field {
    pub const COUNT: usize = 18;
    const ALL: [Field; Field::COUNT] = [
        Field::Shown,
        Field::Open,
        Field::SafariWindows,
        Field::Done,
        Field::Requested,
        Field::HostingWindow,
        Field::Labels,
        Field::Showing,
        Field::MarginPages,
        Field::MarginOpen,
        Field::CycledAt,
        Field::SafariTabs,
        Field::SafariMuted,
        Field::SafariAudio,
        Field::PreparingWindow,
        Field::PreparingProfile,
        Field::Requesting,
        Field::Made,
    ];
    pub fn from_index(i: u32) -> Option<Field> {
        Self::ALL.get(i as usize).copied()
    }
    /// Its name in a `state` input (`done` is read on its own).
    pub fn name(self) -> &'static str {
        match self {
            Field::Shown => "shown",
            Field::Open => "open",
            Field::SafariWindows => "safariWindows",
            Field::Done => "done",
            Field::Requested => "requested",
            Field::HostingWindow => "hostingWindow",
            Field::Labels => "labels",
            Field::Showing => "showing",
            Field::MarginPages => "marginPages",
            Field::MarginOpen => "marginOpen",
            Field::CycledAt => "cycledAt",
            Field::SafariTabs => "safariTabs",
            Field::SafariMuted => "safariMuted",
            Field::SafariAudio => "safariAudio",
            Field::PreparingWindow => "preparingWindow",
            Field::PreparingProfile => "preparingProfile",
            Field::Requesting => "requesting",
            Field::Made => "made",
        }
    }
    pub fn of(name: &str) -> Option<Field> {
        Self::ALL.iter().copied().find(|f| *f != Field::Done && f.name() == name)
    }
}

#[derive(Debug, Default)]
pub struct State {
    pub shown: BTreeMap<i64, String>,
    pub open: BTreeMap<String, OpenItem>,
    pub safari_windows: BTreeMap<(String, Role), i64>,
    /// Each Margin window's item asked to be shown and not shown yet (the newest): drawn in front at once.
    pub requested: BTreeMap<i64, String>,
    pub hosting_window: Option<i64>,
    /// What the loading animation names for a host (the app's name; Safari).
    pub labels: BTreeMap<String, String>,
    /// The item each host is being shown for.
    pub showing: BTreeMap<String, String>,
    /// Each Margin window's own page shown (Settings), and the items of Margin's pages shown this session.
    pub margin_pages: BTreeMap<i64, String>,
    pub margin_open: BTreeSet<String>,
    /// When each Margin window's next/previous-tab key was last pressed.
    pub cycled_at: BTreeMap<i64, f64>,
    /// Each web item's tab in its Safari window (the copy's id), the ones muted, and each one's sound.
    pub safari_tabs: BTreeMap<String, i64>,
    pub safari_muted: BTreeSet<String>,
    pub safari_audio: BTreeMap<String, (bool, bool)>,
    /// The Margin window a browser's window is made ready over at launch, and its profile.
    pub preparing_window: Option<i64>,
    pub preparing_profile: Option<String>,
    /// The profiles a window is being asked of right now, and every Safari window Margin made (never swept).
    pub requesting: BTreeSet<String>,
    pub made: BTreeSet<i64>,
}

/// One part of a row (an int as `json::int` reads it, a string, a number, a bool).
trait Part: Sized {
    fn read(v: &Value) -> Option<Self>;
    fn json(&self) -> Value;
}
impl Part for i64 {
    fn read(v: &Value) -> Option<Self> {
        json::int(Some(v))
    }
    fn json(&self) -> Value {
        json!(self)
    }
}
impl Part for String {
    fn read(v: &Value) -> Option<Self> {
        v.as_str().map(str::to_string)
    }
    fn json(&self) -> Value {
        json!(self)
    }
}
impl Part for f64 {
    fn read(v: &Value) -> Option<Self> {
        json::num(Some(v))
    }
    fn json(&self) -> Value {
        crate::protocol::number(*self).unwrap_or(Value::Null)
    }
}
impl Part for bool {
    fn read(v: &Value) -> Option<Self> {
        v.as_bool()
    }
    fn json(&self) -> Value {
        json!(self)
    }
}

/// A row's value after its key.
trait Rest: Sized {
    fn read(cells: &[Value]) -> Option<Self>;
    fn cells(&self) -> Vec<Value>;
}
impl<T: Part> Rest for T {
    fn read(cells: &[Value]) -> Option<Self> {
        T::read(cells.first()?)
    }
    fn cells(&self) -> Vec<Value> {
        vec![self.json()]
    }
}
impl Rest for (bool, bool) {
    fn read(cells: &[Value]) -> Option<Self> {
        Some((<bool as Part>::read(cells.first()?)?, <bool as Part>::read(cells.get(1)?)?))
    }
    fn cells(&self) -> Vec<Value> {
        vec![json!(self.0), json!(self.1)]
    }
}

fn map_json<K: Part, V: Rest>(m: &BTreeMap<K, V>) -> Value {
    Value::Array(
        m.iter()
            .map(|(k, v)| {
                let mut row = vec![k.json()];
                row.extend(v.cells());
                Value::Array(row)
            })
            .collect(),
    )
}

/// A map's edit: its deletions (keys), then its puts (rows). How many weren't one.
fn map_edit<K: Part + Ord, V: Rest>(m: &mut BTreeMap<K, V>, edit: &Value) -> usize {
    let mut bad = 0;
    for d in list(edit.get("del")) {
        match K::read(d) {
            Some(k) => {
                m.remove(&k);
            }
            None => bad += 1,
        }
    }
    for e in list(edit.get("put")) {
        let row = e.as_array().map_or(&[][..], Vec::as_slice);
        match (row.first().and_then(K::read), row.get(1..).and_then(V::read)) {
            (Some(k), Some(v)) => {
                m.insert(k, v);
            }
            _ => bad += 1,
        }
    }
    bad
}

fn set_json<K: Part>(s: &BTreeSet<K>) -> Value {
    Value::Array(s.iter().map(|k| json!([k.json()])).collect())
}

fn set_edit<K: Part + Ord>(s: &mut BTreeSet<K>, edit: &Value) -> usize {
    let mut bad = 0;
    for d in list(edit.get("del")) {
        match K::read(d) {
            Some(k) => {
                s.remove(&k);
            }
            None => bad += 1,
        }
    }
    for e in list(edit.get("put")) {
        match e.get(0).and_then(K::read) {
            Some(k) => {
                s.insert(k);
            }
            None => bad += 1,
        }
    }
    bad
}

fn one_json<K: Part>(v: &Option<K>) -> Value {
    Value::Array(v.iter().map(|k| json!([k.json()])).collect())
}

/// A one value's edit: any `del` clears it, then a `put` (`[[value]]`) sets it.
fn one_edit<K: Part>(v: &mut Option<K>, edit: &Value) -> usize {
    let mut bad = 0;
    if !list(edit.get("del")).is_empty() {
        *v = None;
    }
    for e in list(edit.get("put")) {
        match e.get(0).and_then(K::read) {
            Some(k) => *v = Some(k),
            None => bad += 1,
        }
    }
    bad
}

/// A role as Swift's `SafariRole.description` says it.
pub fn role_name(role: Role) -> String {
    match role {
        Role::Main => "main".into(),
        Role::Card => "card".into(),
        Role::Pane(n) => format!("pane{n}"),
    }
}

pub fn role_named(name: &str) -> Option<Role> {
    match name {
        "main" => Some(Role::Main),
        "card" => Some(Role::Card),
        _ => name.strip_prefix("pane")?.parse::<u8>().ok().map(Role::Pane),
    }
}

fn list(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

impl State {
    pub fn field_json(&self, f: Field) -> Value {
        match f {
            Field::Shown => Value::Array(self.shown.iter().map(|(w, i)| json!([w, i])).collect()),
            Field::Open => Value::Array(self.open.iter().map(|(i, o)| json!([i, o.host, o.profile])).collect()),
            Field::SafariWindows => {
                Value::Array(self.safari_windows.iter().map(|((p, r), id)| json!([p, role_name(*r), id])).collect())
            }
            Field::Done => Value::Null,
            Field::Requested => map_json(&self.requested),
            Field::HostingWindow => one_json(&self.hosting_window),
            Field::Labels => map_json(&self.labels),
            Field::Showing => map_json(&self.showing),
            Field::MarginPages => map_json(&self.margin_pages),
            Field::MarginOpen => set_json(&self.margin_open),
            Field::CycledAt => map_json(&self.cycled_at),
            Field::SafariTabs => map_json(&self.safari_tabs),
            Field::SafariMuted => set_json(&self.safari_muted),
            Field::SafariAudio => map_json(&self.safari_audio),
            Field::PreparingWindow => one_json(&self.preparing_window),
            Field::PreparingProfile => one_json(&self.preparing_profile),
            Field::Requesting => set_json(&self.requesting),
            Field::Made => set_json(&self.made),
        }
    }

    /// One field's edit (`{ put: [...], del: [...] }`): the fields it changed, and how many entries weren't one.
    pub fn edit(&mut self, name: &str, edit: &Value) -> (Option<Field>, usize) {
        let Some(f) = Field::of(name) else { return (None, 1) };
        let bad = match f {
            Field::Requested => Some(map_edit(&mut self.requested, edit)),
            Field::HostingWindow => Some(one_edit(&mut self.hosting_window, edit)),
            Field::Labels => Some(map_edit(&mut self.labels, edit)),
            Field::Showing => Some(map_edit(&mut self.showing, edit)),
            Field::MarginPages => Some(map_edit(&mut self.margin_pages, edit)),
            Field::MarginOpen => Some(set_edit(&mut self.margin_open, edit)),
            Field::CycledAt => Some(map_edit(&mut self.cycled_at, edit)),
            Field::SafariTabs => Some(map_edit(&mut self.safari_tabs, edit)),
            Field::SafariMuted => Some(set_edit(&mut self.safari_muted, edit)),
            Field::SafariAudio => Some(map_edit(&mut self.safari_audio, edit)),
            Field::PreparingWindow => Some(one_edit(&mut self.preparing_window, edit)),
            Field::PreparingProfile => Some(one_edit(&mut self.preparing_profile, edit)),
            Field::Requesting => Some(set_edit(&mut self.requesting, edit)),
            Field::Made => Some(set_edit(&mut self.made, edit)),
            Field::Shown | Field::Open | Field::SafariWindows | Field::Done => None,
        };
        if let Some(bad) = bad {
            return (Some(f), bad);
        }
        let mut bad = 0;
        let del = list(edit.get("del"));
        let put = list(edit.get("put"));
        for d in del {
            let ok = match f {
                Field::Shown => json::int(Some(d)).map(|w| self.shown.remove(&w)).is_some(),
                Field::Open => d.as_str().map(|i| self.open.remove(i)).is_some(),
                Field::SafariWindows => match (d.get(0).and_then(Value::as_str), d.get(1).and_then(Value::as_str)) {
                    (Some(p), Some(r)) => {
                        role_named(r).map(|r| self.safari_windows.remove(&(p.to_string(), r))).is_some()
                    }
                    _ => false,
                },
                _ => false,
            };
            bad += usize::from(!ok);
        }
        for e in put {
            let ok = match f {
                Field::Shown => match (json::int(e.get(0)), e.get(1).and_then(Value::as_str)) {
                    (Some(w), Some(i)) => {
                        self.shown.insert(w, i.to_string());
                        true
                    }
                    _ => false,
                },
                Field::Open => match (e.get(0).and_then(Value::as_str), e.get(1).and_then(Value::as_str), e.get(2)) {
                    (Some(i), Some(h), Some(p)) if p.is_null() || p.is_string() => {
                        let profile = p.as_str().map(str::to_string);
                        self.open.insert(i.to_string(), OpenItem { host: h.to_string(), profile });
                        true
                    }
                    _ => false,
                },
                Field::SafariWindows => {
                    match (e.get(0).and_then(Value::as_str), e.get(1).and_then(Value::as_str), json::int(e.get(2))) {
                        (Some(p), Some(r), Some(id)) => match role_named(r) {
                            Some(r) => {
                                self.safari_windows.insert((p.to_string(), r), id);
                                true
                            }
                            None => false,
                        },
                        _ => false,
                    }
                }
                _ => false,
            };
            bad += usize::from(!ok);
        }
        (Some(f), bad)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_and_reads() {
        let mut s = State::default();
        assert_eq!(s.edit("shown", &json!({ "put": [[1, "a"], [2, "b"]] })), (Some(Field::Shown), 0));
        assert_eq!(s.edit("shown", &json!({ "del": [2, "x"], "put": [["1", "c"]] })), (Some(Field::Shown), 2));
        assert_eq!(s.field_json(Field::Shown), json!([[1, "a"]]));
        s.edit("open", &json!({ "put": [["a", "app:x", null], ["b", "safari:p", "p"], ["c", "h", 3]] }));
        assert_eq!(s.field_json(Field::Open), json!([["a", "app:x", null], ["b", "safari:p", "p"]]));
        s.edit("safariWindows", &json!({ "put": [["p", "main", 90], ["p", "pane2", 91], ["p", "nope", 1]] }));
        assert_eq!(s.safari_windows.get(&("p".into(), Role::Pane(2))), Some(&91));
        s.edit("safariWindows", &json!({ "del": [["p", "main"]] }));
        assert_eq!(s.field_json(Field::SafariWindows), json!([["p", "pane2", 91]]));
        assert_eq!(s.edit("nope", &json!({})), (None, 1));
        assert_eq!(role_named(&role_name(Role::Card)), Some(Role::Card));
    }

    #[test]
    fn commit_fives_fields_edited_and_read() {
        let mut s = State::default();
        assert_eq!(s.edit("requested", &json!({ "put": [[1, "a"], ["x", "b"]] })), (Some(Field::Requested), 1));
        assert_eq!(s.field_json(Field::Requested), json!([[1, "a"]]));
        s.edit("hostingWindow", &json!({ "put": [[4]] }));
        assert_eq!((s.hosting_window, s.field_json(Field::HostingWindow)), (Some(4), json!([[4]])));
        s.edit("hostingWindow", &json!({ "del": [null] }));
        assert_eq!((s.hosting_window, s.field_json(Field::HostingWindow)), (None, json!([])));
        s.edit("safariAudio", &json!({ "put": [["t1", true, false], ["t2", 1, 0]] }));
        assert_eq!(s.field_json(Field::SafariAudio), json!([["t1", true, false]]));
        s.edit("marginOpen", &json!({ "put": [["m1"], ["m2"]], "del": ["m0"] }));
        s.edit("marginOpen", &json!({ "del": ["m1"] }));
        assert_eq!(s.field_json(Field::MarginOpen), json!([["m2"]]));
        s.edit("cycledAt", &json!({ "put": [[1, 2.5]] }));
        assert_eq!(s.cycled_at.get(&1), Some(&2.5));
        s.edit("made", &json!({ "put": [[90], [91]] }));
        assert_eq!(s.field_json(Field::Made), json!([[90], [91]]));
        s.edit("preparingProfile", &json!({ "put": [["s-default"]] }));
        assert_eq!(s.preparing_profile.as_deref(), Some("s-default"));
        assert_eq!(Field::of("done"), None);
        for i in 0..Field::COUNT as u32 {
            let f = Field::from_index(i).expect("a field");
            assert_eq!(f as u32, i);
            assert!(f == Field::Done || Field::of(f.name()) == Some(f));
        }
    }
}
