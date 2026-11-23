//! The library's values the session's flows read (Library.swift's reads, over margin-core's set in place): an item's
//! target (target.rs), its space, its title, a split and the split an item is a pane of, a Margin window's space, the
//! spaces in order, a space's items newest first.

use std::cmp::Ordering;

use serde_json::{Map, Value};

use super::Core;
use super::target::Target;
use crate::json;

/// A split (Library.swift `Split`): its panes (items, in its order: those still there).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Split {
    pub id: String,
    pub panes: Vec<String>,
}

/// A number as Swift's `num` reads one (never a bool).
fn num(v: Option<&Value>) -> Option<f64> {
    json::num(v)
}

impl Core {
    /// An item's value (`liveValues("tabs")[id] as? JSONObject`).
    pub(crate) fn item_value(&self, item: &str) -> Option<Map<String, Value>> {
        match self.library.item("tabs", item)? {
            Value::Object(o) => Some(o),
            _ => None,
        }
    }

    /// `library.target(ofItem:)`.
    pub(crate) fn target_of(&self, item: &str) -> Option<Target> {
        Target::read(self.item_value(item)?.get("target")?)
    }

    /// `library.space(ofItem:)`.
    pub(crate) fn space_of_item(&self, item: &str) -> Option<String> {
        self.item_value(item)?.get("spaceId")?.as_str().map(str::to_string)
    }

    /// An item's title when it has one (`(… ["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }`).
    pub(crate) fn title_of(&self, item: &str) -> Option<String> {
        self.item_value(item)?.get("title")?.as_str().filter(|t| !t.is_empty()).map(str::to_string)
    }

    /// `library.split(_:)`: its panes still there; None: none, or fewer than two left.
    pub(crate) fn split(&self, id: &str) -> Option<Split> {
        let g = self.library.item("splits", id)?;
        let panes: Vec<String> = json::array(g.as_object()?.get("panes"))
            .map(|l| l.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .filter(|p| self.library.item("tabs", p).is_some())
            .map(str::to_string)
            .collect();
        (panes.len() >= 2).then(|| Split { id: id.to_string(), panes })
    }

    /// `library.split(ofItem:)`: the first split (by id) that has it as a pane still.
    pub(crate) fn split_of_item(&self, item: &str) -> Option<Split> {
        let all = self.library.collection("splits");
        let mut ids: Vec<&String> = all.keys().collect();
        ids.sort();
        for id in ids {
            let g = &all[id.as_str()];
            let has = json::array(g.as_object().and_then(|o| o.get("panes")))
                .is_some_and(|l| l.iter().any(|p| p.as_str() == Some(item)));
            if !has {
                continue;
            }
            if let Some(s) = self.split(id).filter(|s| s.panes.iter().any(|p| p == item)) {
                return Some(s);
            }
        }
        None
    }

    /// `library.space(ofWindow:)`.
    pub(crate) fn space_of_window(&self, window: i64) -> Option<String> {
        let w = self.library.item("windows", &window.to_string())?;
        w.as_object()?.get("spaceId")?.as_str().map(str::to_string)
    }

    /// The spaces in their order (`library.spaces()`: by `order`, then id), as (id, value).
    pub(crate) fn spaces(&self) -> Vec<(String, Map<String, Value>)> {
        let mut out: Vec<(String, Map<String, Value>)> = self
            .library
            .collection("spaces")
            .into_iter()
            .filter_map(|(id, v)| match v {
                Value::Object(o) => Some((id, o)),
                _ => None,
            })
            .collect();
        out.sort_by(|a, b| order(num(a.1.get("order")), num(b.1.get("order"))).then_with(|| a.0.cmp(&b.0)));
        out
    }

    /// A space's items (None: every item), newest first (`library.items(space:)`: the highest `order`, then id).
    pub(crate) fn items_of_space(&self, space: Option<&str>) -> Vec<(String, Map<String, Value>)> {
        let mut out: Vec<(String, Map<String, Value>)> = self
            .library
            .collection("tabs")
            .into_iter()
            .filter_map(|(id, v)| match v {
                Value::Object(o) => Some((id, o)),
                _ => None,
            })
            .collect();
        // (Swift's `(order, $1.id) > (order, $0.id)`: the higher order first, then the smaller id.)
        out.sort_by(|a, b| order(num(b.1.get("order")), num(a.1.get("order"))).then_with(|| a.0.cmp(&b.0)));
        out.retain(|(_, v)| space.is_none() || v.get("spaceId").and_then(Value::as_str) == space);
        out
    }
}

/// Two orders as Swift's tuple compare has them (`num(...) ?? 0`).
fn order(a: Option<f64>, b: Option<f64>) -> Ordering {
    a.unwrap_or(0.0).partial_cmp(&b.unwrap_or(0.0)).unwrap_or(Ordering::Equal)
}
