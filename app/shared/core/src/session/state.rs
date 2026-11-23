//! The session's state the core keeps (HostedSession's fields, HS:385-433), moved in as the flows that read them move:
//! each Margin window's item shown, each item with a page, each Safari profile's hosted windows by role. While Swift
//! flows still write them, the Swift facade reads a field again only when its revision changed, and writes the
//! difference (`put`, `del`), never the whole field.
//!
//! Every list is JSON arrays (an id that's a number stays one): `shown` `[[window, item]]`, `open`
//! `[[item, host, profile | null]]`, `safariWindows` `[[profile, role, windowId]]` (`role`: `main`, `card`, `pane1`…).

use std::collections::BTreeMap;

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
}

impl Field {
    pub const COUNT: usize = 4;
    pub fn from_index(i: u32) -> Option<Field> {
        [Field::Shown, Field::Open, Field::SafariWindows, Field::Done].get(i as usize).copied()
    }
    fn of(name: &str) -> Option<Field> {
        match name {
            "shown" => Some(Field::Shown),
            "open" => Some(Field::Open),
            "safariWindows" => Some(Field::SafariWindows),
            _ => None,
        }
    }
}

#[derive(Debug, Default)]
pub struct State {
    pub shown: BTreeMap<i64, String>,
    pub open: BTreeMap<String, OpenItem>,
    pub safari_windows: BTreeMap<(String, Role), i64>,
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
        }
    }

    /// One field's edit (`{ put: [...], del: [...] }`): the fields it changed, and how many entries weren't one.
    pub fn edit(&mut self, name: &str, edit: &Value) -> (Option<Field>, usize) {
        let Some(f) = Field::of(name) else { return (None, 1) };
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
                Field::Done => false,
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
                Field::Done => false,
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
}
