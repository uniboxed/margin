//! Margin.app's library as it's stored (app/platforms/macos/shell/Library.swift; DECISIONS.md "Margin.app owns the
//! spaces"): one data set of the app's own, in a flat store (`data/app/set.json` and `items/`), its edit rules the
//! TypeScript library's (app/shared/library). What the rules change comes here as entries (`{ collection, id,
//! value }` or `{ collection, id, deleted: true }`, untimed): each one timed at now, or just after the item's own
//! time (a clock that went back still makes a newer item), merged, and stored (in the background with a store that
//! has a writer: the memory at once). The collections changed come back with their live values, so the shell keeps
//! what it reads without asking again.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

use super::Note;
use super::set::{DataChange, DataItem, DataSet, is_name, is_true};
use super::store::{DataProfile, DataStore, Outcome, Stored};
use crate::json;

/// The library's set's key in its store (flat: it names no folder; its browser and profile are written in set.json).
pub fn key() -> DataProfile {
    DataProfile::new("app", "library")
}

/// What an `apply` changed: the collections, and each one's live values now.
#[derive(Debug, Default, PartialEq)]
pub struct Applied {
    pub changed: BTreeSet<String>,
    pub values: Map<String, Value>,
}

pub struct LibraryStore {
    store: DataStore,
}

impl LibraryStore {
    /// Over a flat store (`DataStore::flat`).
    pub fn new(store: DataStore) -> Self {
        Self { store }
    }

    pub fn store_mut(&mut self) -> &mut DataStore {
        &mut self.store
    }

    /// Every collection's live values: `{ collection: { id: value } }` (none for a library never stored).
    pub fn values(&mut self) -> Map<String, Value> {
        let Some(stored) = self.store.load(&key()) else { return Map::new() };
        stored.set.collections().into_iter().map(|c| (c.clone(), Value::Object(stored.set.live_values(&c)))).collect()
    }

    /// The rules' entries at `at` (ms): timed, merged, stored. Entries that aren't one (a name that isn't a data name,
    /// neither a value nor `deleted: true`) are left out.
    pub fn apply(&mut self, entries: &[Value], at: f64) -> Applied {
        let k = key();
        let mut stored = self.store.load(&k).cloned().unwrap_or_else(|| Stored::new(DataSet::new(), 0.0));
        let mut changes: Vec<DataChange> = Vec::new();
        for entry in entries {
            let Some(o) = entry.as_object() else { continue };
            if !is_name(o.get("collection")) || !is_name(o.get("id")) {
                continue;
            }
            let (Some(collection), Some(id)) = (json::string(o.get("collection")), json::string(o.get("id"))) else {
                continue;
            };
            let time = at.max(stored.set.item(collection, id).map_or(-1.0, |i| i.updated_at) + 1.0);
            if is_true(o.get("deleted")) {
                changes.push(DataChange::new(collection, id, DataItem::tombstone(time)));
            } else if let Some(value) = o.get("value") {
                changes.push(DataChange::new(collection, id, DataItem::live(time, value.clone())));
            }
        }
        if changes.is_empty() {
            return Applied::default();
        }
        stored.set.merge(&changes);
        let changed: BTreeSet<String> = changes.iter().map(|c| c.collection.clone()).collect();
        let values = changed.iter().map(|c| (c.clone(), Value::Object(stored.set.live_values(c)))).collect();
        // (A save that can't be handed over says so in the log; the memory is the store's either way.)
        let _ = self.store.submit(&k, stored, Some(&changed));
        Applied { changed, values }
    }

    /// The saves written since (the writer's wake): nothing to act on but what the log says (a failed one).
    pub fn written(&mut self) -> Vec<Note> {
        let failed = self.store.take_done().into_iter().filter(|d| matches!(d.outcome, Outcome::Failed(_))).count();
        let mut log = self.store.take_log();
        if failed > 0 {
            log.push(Note::warn(format!("library: {failed} save(s) not written")));
        }
        log
    }

    /// One live item's value by its id (the session's reads: a map lookup, never a collection built); None: none,
    /// deleted, or a library never stored.
    pub fn item(&mut self, collection: &str, id: &str) -> Option<Value> {
        self.store.load(&key())?.set.item(collection, id)?.value.clone()
    }

    /// A collection's live values (`{ id: value }`; none for a library never stored).
    pub fn live(&mut self, collection: &str) -> Map<String, Value> {
        self.store.load(&key()).map(|s| s.set.live_values(collection)).unwrap_or_default()
    }

    /// The store's log since the last call.
    pub fn take_log(&mut self) -> Vec<Note> {
        self.store.take_log()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::testing::temp;
    use serde_json::json;

    fn library(root: &std::path::Path) -> LibraryStore {
        let mut store = DataStore::new(root).flat();
        store.now = Box::new(|| 1000.0);
        LibraryStore::new(store)
    }

    #[test]
    fn entries_timed_merged_stored() {
        let dir = temp();
        let mut lib = library(dir.path());
        assert!(lib.values().is_empty(), "never stored: nothing");
        let a = lib.apply(&[json!({ "collection": "spaces", "id": "s1", "value": { "name": "Home" } })], 50.0);
        assert_eq!(a.changed, BTreeSet::from(["spaces".to_string()]));
        assert_eq!(a.values["spaces"]["s1"]["name"], json!("Home"));
        assert!(dir.path().join("items").join("spaces.json").exists(), "in the flat store");
        // A clock that went back: just after the item's own time, still newer.
        let b = lib.apply(&[json!({ "collection": "spaces", "id": "s1", "value": { "name": "Work" } })], 10.0);
        assert_eq!(b.values["spaces"]["s1"]["name"], json!("Work"));
        let set = lib.store_mut().load(&key()).map(|s| s.set.clone()).unwrap_or_default();
        assert_eq!(set.item("spaces", "s1").map(|i| i.updated_at), Some(51.0));
        assert_eq!(lib.item("spaces", "s1"), Some(json!({ "name": "Work" })), "one item read by its id");
        assert_eq!(lib.item("spaces", "none"), None);
        assert_eq!(lib.live("spaces").get("s1"), Some(&json!({ "name": "Work" })), "a collection read");
        assert!(lib.live("pins").is_empty());
        // A deletion, and entries that aren't one.
        let c = lib.apply(
            &[
                json!({ "collection": "spaces", "id": "s1", "deleted": true }),
                json!({ "collection": "__proto__", "id": "x", "value": 1 }),
                json!({ "collection": "tabs", "id": "", "value": 1 }),
                json!({ "collection": "tabs", "id": "t1", "deleted": 1 }),
                json!("not an object"),
            ],
            100.0,
        );
        assert_eq!(c.changed, BTreeSet::from(["spaces".to_string()]), "only the deletion");
        assert!(c.values["spaces"].as_object().is_some_and(Map::is_empty));
        assert_eq!(lib.item("spaces", "s1"), None, "deleted: none");
        assert_eq!(lib.apply(&[], 1.0), Applied::default());
        let mut again = library(dir.path());
        assert!(again.values()["spaces"].as_object().is_some_and(Map::is_empty), "read back: deleted");
    }
}
