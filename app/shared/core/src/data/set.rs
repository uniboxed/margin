//! Margin's lasting data set (docs/DATA.md): items, changes and the merge (app/macos/shell/DataSet.swift). The rules are
//! `extension/shared/data-merge.ts` `mergeData`'s (the reference), and this runs the same JSON vectors
//! (`tests/fixtures/data-merge/`):
//!
//! - an item is `{ updatedAt, value }` or a tombstone `{ updatedAt, deleted: true }`;
//! - per item, the later `updatedAt` wins; on the same time a deletion wins over a live item, otherwise the
//!   change wins over what was there;
//! - changes apply in the order given;
//! - collections and items the merge doesn't know are kept as they are; a malformed change is skipped, a
//!   malformed item in the base dropped.
//!
//! Values are kept as JSON (`serde_json::Value`, a JSON null as `Value::Null`).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use super::number;
use crate::json::{self, Object};

pub const FORMAT: i64 = 1;
/// Tombstones are kept 60 days, at most 2,000 per collection (docs/DATA.md, the extension's limits).
pub const TOMBSTONE_MS: f64 = 60.0 * 24.0 * 3600.0 * 1000.0;
pub const TOMBSTONE_CAP: usize = 2000;

/// JSON's `true` (a number 1 isn't).
fn is_true(v: Option<&Value>) -> bool {
    v == Some(&Value::Bool(true))
}

/// A collection's or an item's name: 1–256 UTF-16 units, as the reference (JS `length`) counts them.
fn is_name(v: Option<&Value>) -> bool {
    json::string(v).is_some_and(|s| (1..=256).contains(&s.encode_utf16().count()))
}

#[derive(Clone, Debug, PartialEq)]
pub struct DataItem {
    /// Milliseconds since 1970: the time of the change that made the item what it is.
    pub updated_at: f64,
    /// `None`: a tombstone. A JSON null is `Some(Value::Null)`.
    pub value: Option<Value>,
}

impl DataItem {
    pub fn live(updated_at: f64, value: Value) -> Self {
        Self { updated_at, value: Some(value) }
    }

    pub fn tombstone(updated_at: f64) -> Self {
        Self { updated_at, value: None }
    }

    pub fn deleted(&self) -> bool {
        self.value.is_none()
    }

    /// The reference's `isItem`: an object with a finite `updatedAt`, and either `deleted: true` and no `value`,
    /// or a `value` and no `deleted` at all (not even `deleted: null` or `false`).
    pub fn from_json(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let at = json::num(o.get("updatedAt"))?;
        if is_true(o.get("deleted")) {
            if o.contains_key("value") {
                return None;
            }
            Some(Self::tombstone(at))
        } else {
            if o.contains_key("deleted") {
                return None;
            }
            Some(Self::live(at, o.get("value")?.clone()))
        }
    }

    pub fn to_json(&self) -> Value {
        match &self.value {
            Some(v) => json!({ "updatedAt": number(self.updated_at), "value": v }),
            None => json!({ "updatedAt": number(self.updated_at), "deleted": true }),
        }
    }

    /// Whether `self`, coming in, replaces `current` (docs/DATA.md "The merge").
    pub fn wins(&self, current: Option<&DataItem>) -> bool {
        let Some(current) = current else { return true };
        if self.updated_at != current.updated_at {
            return self.updated_at > current.updated_at;
        }
        if current.deleted() && !self.deleted() {
            return false; // a deletion holds its ground
        }
        true // the same time: the change wins
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DataChange {
    pub collection: String,
    pub id: String,
    pub item: DataItem,
}

impl DataChange {
    pub fn new(collection: impl Into<String>, id: impl Into<String>, item: DataItem) -> Self {
        Self { collection: collection.into(), id: id.into(), item }
    }

    /// The reference's `isChange`: a collection and an id (1–256 UTF-16 units), a finite `updatedAt`, and a value
    /// or `deleted: true` (not both, nothing else in `deleted`).
    pub fn from_json(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        if !is_name(o.get("collection")) || !is_name(o.get("id")) {
            return None;
        }
        let collection = json::string(o.get("collection"))?;
        let id = json::string(o.get("id"))?;
        let item = DataItem::from_json(v)?; // its updatedAt, value and deleted, as an item's
        Some(Self::new(collection, id, item))
    }

    pub fn to_json(&self) -> Value {
        let mut out = self.item.to_json();
        if let Some(o) = out.as_object_mut() {
            o.insert("collection".into(), Value::from(self.collection.as_str()));
            o.insert("id".into(), Value::from(self.id.as_str()));
        }
        out
    }

    /// The good changes of a JSON array (anything else: none).
    pub fn list(v: Option<&Value>) -> Vec<DataChange> {
        json::array(v).map(|a| a.iter().filter_map(DataChange::from_json).collect()).unwrap_or_default()
    }
}

/// collection → id → item. Kept in sorted maps, so every walk (the files, the parts, `changes`) is in a fixed order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DataSet {
    pub items: BTreeMap<String, BTreeMap<String, DataItem>>,
}

impl DataSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// A data set from JSON (`{ format, items }`): collections that aren't objects and items that aren't items
    /// are dropped (mergeData's base). Anything else: an empty set.
    pub fn from_json(v: Option<&Value>) -> Self {
        let mut set = Self::new();
        let Some(collections) = json::object(v).and_then(|o| json::object(o.get("items"))) else { return set };
        set.take_items(collections);
        set
    }

    /// The set from its `items` object alone (`{ collection: { id: item } }`).
    pub fn from_items(collections: &Object) -> Self {
        let mut set = Self::new();
        set.take_items(collections);
        set
    }

    fn take_items(&mut self, collections: &Object) {
        for (collection, list) in collections {
            let Some(list) = list.as_object() else { continue };
            let kept = list.iter().filter_map(|(id, raw)| Some((id.clone(), DataItem::from_json(raw)?))).collect();
            self.items.insert(collection.clone(), kept);
        }
    }

    pub fn to_json(&self) -> Value {
        json!({ "format": FORMAT, "items": self.items_json() })
    }

    /// `{ collection: { id: item } }`.
    pub fn items_json(&self) -> Value {
        Value::Object(self.items.iter().map(|(c, list)| (c.clone(), Self::list_json(list))).collect())
    }

    /// One collection's `{ id: item }`.
    pub fn list_json(list: &BTreeMap<String, DataItem>) -> Value {
        Value::Object(list.iter().map(|(id, item)| (id.clone(), item.to_json())).collect())
    }

    /// The collections, sorted.
    pub fn collections(&self) -> Vec<String> {
        self.items.keys().cloned().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.items.values().all(BTreeMap::is_empty)
    }

    pub fn item(&self, collection: &str, id: &str) -> Option<&DataItem> {
        self.items.get(collection)?.get(id)
    }

    /// Each change in order: whether it won (it's now the item).
    pub fn merge(&mut self, changes: &[DataChange]) -> Vec<bool> {
        changes
            .iter()
            .map(|change| {
                if !change.item.wins(self.item(&change.collection, &change.id)) {
                    return false;
                }
                self.items.entry(change.collection.clone()).or_default().insert(change.id.clone(), change.item.clone());
                true
            })
            .collect()
    }

    /// `mergeData(base, changes)`, from JSON as the vectors give it.
    pub fn merge_json(base: Option<&Value>, changes: Option<&Value>) -> Self {
        let mut set = Self::from_json(base);
        set.merge(&DataChange::list(changes));
        set
    }

    /// Every item as a change (`changesFrom`): by collection, then id.
    pub fn changes(&self) -> Vec<DataChange> {
        self.items
            .iter()
            .flat_map(|(c, list)| {
                list.iter().map(move |(id, item)| DataChange::new(c.clone(), id.clone(), item.clone()))
            })
            .collect()
    }

    /// A collection's live items' values (`liveValues`): `{ id: value }`.
    pub fn live_values(&self, collection: &str) -> Map<String, Value> {
        let Some(list) = self.items.get(collection) else { return Map::new() };
        list.iter().filter_map(|(id, item)| Some((id.clone(), item.value.clone()?))).collect()
    }

    /// The newest `updatedAt` in the set (0 if none).
    pub fn newest(&self) -> f64 {
        self.items
            .values()
            .flat_map(BTreeMap::values)
            .map(|i| i.updated_at)
            .fold(None, |m: Option<f64>, t| Some(m.map_or(t, |m| m.max(t))))
            .unwrap_or(0.0)
    }

    /// Without tombstones older than `before`, and at most `cap` per collection (the newest kept; on the same
    /// time, the lower id). The collections that lost any.
    pub fn prune_tombstones(&mut self, before: f64, cap: usize) -> BTreeSet<String> {
        let mut touched = BTreeSet::new();
        for (collection, list) in &mut self.items {
            let mut tombstones: Vec<(&String, f64)> =
                list.iter().filter(|(_, i)| i.deleted()).map(|(id, i)| (id, i.updated_at)).collect();
            tombstones.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
            let drop: Vec<String> = tombstones
                .iter()
                .enumerate()
                .filter(|(n, (_, at))| *n >= cap || *at < before)
                .map(|(_, (id, _))| (*id).clone())
                .collect();
            if drop.is_empty() {
                continue;
            }
            for id in &drop {
                list.remove(id);
            }
            touched.insert(collection.clone());
        }
        touched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::testing::same;
    use std::path::PathBuf;

    fn space(name: &str) -> Value {
        json!({ "name": name, "emoji": "", "color": "#000", "order": 0 })
    }

    fn change(c: &str, id: &str, at: f64, value: Option<Value>) -> DataChange {
        DataChange::new(c, id, value.map_or_else(|| DataItem::tombstone(at), |v| DataItem::live(at, v)))
    }

    fn vectors() -> Vec<(String, Value)> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/data-merge");
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .expect("the vectors' folder")
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        names
            .into_iter()
            .map(|n| {
                let text = std::fs::read_to_string(dir.join(&n)).expect("a vector");
                (n, serde_json::from_str(&text).expect("a vector's JSON"))
            })
            .collect()
    }

    #[test]
    fn the_vectors() {
        let all = vectors();
        assert!(all.len() >= 8, "the merge's vectors found: {}", all.len());
        for (name, v) in all {
            let base = v.get("base").filter(|b| !b.is_null());
            let got = DataSet::merge_json(base, v.get("changes"));
            let expected = &v["expected"];
            assert!(same(&got.to_json(), expected), "vector {name}: {}", got.to_json());
            // Its result as changes into nothing gives it again (a snapshot taken whole).
            let again = DataSet::from_json(Some(expected));
            let changes = Value::Array(again.changes().iter().map(DataChange::to_json).collect());
            assert!(same(&DataSet::merge_json(None, Some(&changes)).to_json(), expected), "vector {name} as changes");
        }
    }

    #[test]
    fn what_is_a_change() {
        let c = |v: Value| DataChange::from_json(&v);
        assert!(
            c(json!({ "collection": "a", "id": "b", "updatedAt": 1, "deleted": 1 })).is_none(),
            "deleted: 1 isn't a deletion"
        );
        assert!(
            c(json!({ "collection": "a", "id": "x".repeat(257), "updatedAt": 1, "value": 1 })).is_none(),
            "an id of 257"
        );
        assert!(
            c(json!({ "collection": "a", "id": "x".repeat(256), "updatedAt": 1, "value": 1 })).is_some(),
            "an id of 256"
        );
        // 128 emoji are 256 UTF-16 units; 129 are 258.
        assert!(c(json!({ "collection": "a", "id": "😀".repeat(128), "updatedAt": 1, "value": 1 })).is_some());
        assert!(c(json!({ "collection": "a", "id": "😀".repeat(129), "updatedAt": 1, "value": 1 })).is_none());
        assert!(c(json!({ "collection": "a", "id": "b", "updatedAt": true, "value": 1 })).is_none(), "updatedAt true");
        assert_eq!(
            c(json!({ "collection": "a", "id": "b", "updatedAt": 1, "value": null })).map(|c| c.item.deleted()),
            Some(false),
            "a value of null is a value"
        );
        assert!(
            c(json!({ "collection": "a", "id": "b", "updatedAt": 1, "value": 1, "deleted": null })).is_none(),
            "deleted: null"
        );
        assert!(
            c(json!({ "collection": "a", "id": "b", "updatedAt": 1, "deleted": true, "value": null })).is_none(),
            "both"
        );
        assert!(c(json!([1])).is_none());
        assert_eq!(DataChange::list(Some(&json!("not a list"))), vec![]);
    }

    #[test]
    fn changes_live_values_newest() {
        let mut set = DataSet::new();
        set.merge(&[change("spaces", "b", 2.0, None), change("spaces", "a", 1.0, Some(space("A")))]);
        assert_eq!(set.changes().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["a", "b"], "a fixed order");
        assert_eq!(set.live_values("spaces").keys().collect::<Vec<_>>(), ["a"]);
        assert_eq!(set.newest(), 2.0);
        assert_eq!(DataSet::new().newest(), 0.0);
        assert!(set.items_json()["spaces"]["a"]["updatedAt"].is_i64(), "whole times written as integers");
    }

    #[test]
    fn same_time_rules() {
        let mut set = DataSet::new();
        set.merge(&[change("pins", "p", 5.0, None)]);
        assert_eq!(set.merge(&[change("pins", "p", 5.0, Some(json!(1)))]), [false], "a deletion holds its ground");
        assert_eq!(
            set.merge(&[change("pins", "q", 5.0, Some(json!(1))), change("pins", "q", 5.0, Some(json!(2)))]),
            [true, true]
        );
        assert_eq!(
            set.item("pins", "q").and_then(|i| i.value.clone()),
            Some(json!(2)),
            "the same time: the change wins"
        );
        assert_eq!(set.merge(&[change("pins", "q", 5.0, None)]), [true], "a deletion over a live item");
        assert_eq!(set.merge(&[change("pins", "q", 4.0, Some(json!(3)))]), [false], "older loses");
    }

    #[test]
    fn tombstones_pruned() {
        let mut set = DataSet::new();
        let mut changes: Vec<DataChange> =
            (0..2005).map(|n| change("pins", &format!("p{n}"), 1000.0 + n as f64, None)).collect();
        changes.push(change("pins", "live", 1.0, Some(json!({ "url": "x" }))));
        changes.push(change("folders", "old", 5.0, None));
        changes.push(change("folders", "new", 500.0, None));
        set.merge(&changes);
        let touched = set.prune_tombstones(100.0, TOMBSTONE_CAP);
        assert!(
            set.item("folders", "old").is_none() && set.item("folders", "new").is_some(),
            "older than the limit go"
        );
        let pins = &set.items["pins"];
        assert_eq!(pins.values().filter(|i| i.deleted()).count(), 2000, "2,000 a collection");
        assert!(pins.contains_key("p2004") && pins.contains_key("p5") && !pins.contains_key("p4"), "the newest kept");
        assert!(pins.contains_key("live"), "live items stay");
        assert_eq!(touched, BTreeSet::from(["folders".to_string(), "pins".to_string()]));
        assert!(set.prune_tombstones(100.0, TOMBSTONE_CAP).is_empty(), "nothing more the second time");
        assert_eq!(TOMBSTONE_MS, 5_184_000_000.0);
    }
}
