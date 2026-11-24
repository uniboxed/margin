//! The import's pure half (docs/CORE-REFACTOR.md step 4 part 5): library.ts `importValues` (LT:875-935), each
//! profile's data set into the library once, its ids namespaced (`ns_id`, `ns_tab_id`: the same sets give the same ids,
//! so an import run again after a crash merges into itself). Decided by Tirth, 2026-11-15: a set's spaces with the
//! profile as their own, its pins, folders, Margin tabs (web pages only: open or kept, all become items) and archive (a
//! gone space's entries to the profile's first). The order: the library's own spaces first, then the person's
//! (browser.json's, `order`), then the rest as the sets gave them. Nothing in the sets is changed.
//!
//! [`import_values`] is LT:875-931: the values with the import in them and its counts. [`import_changes`] adds LT's
//! last step (LT:932-934: the result read through `stateOf`/`valuesOf`, so what's stored is what the rules give back,
//! and `diff` against `current` for the changes), part 2's `library::state` and `library::values`.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::js::{self, LocaleCompare};
use super::state;
use super::values::{self, Change};
use crate::data::profiles::BrowserProfiles;
use crate::data::sync::DataSync;

/// The browsers a set can be of (LT:39 `BROWSERS`).
const BROWSERS: [&str; 3] = ["safari", "chrome", "edge"];
/// The library's collections (LT:24 `COLLECTIONS`), in its order.
pub const COLLECTIONS: [&str; 10] =
    ["spaces", "pins", "favorites", "airTraffic", "splits", "folders", "tabs", "archive", "windows", "imports"];
/// The longest namespaced id kept as it is (LT:865 `NAME_MAX`), in UTF-16 units.
const NAME_MAX: usize = 256;

/// One profile's data set as the app keeps it (LT:863 `ImportSet`): its own collections' live values.
#[derive(Clone, Debug, PartialEq)]
pub struct ImportSet {
    pub browser: String,
    pub profile: String,
    pub values: Map<String, Value>,
}

impl ImportSet {
    /// A set as LT's filter (LT:881) takes one: a known browser, a profile that's a string and not empty, values that
    /// are an object. `None`: the set is left out (not counted, not in the marker's `sets`).
    pub fn from_json(v: &Value) -> Option<ImportSet> {
        let o = v.as_object()?;
        let browser = o.get("browser")?.as_str().filter(|b| BROWSERS.contains(b))?;
        let profile = o.get("profile")?.as_str().filter(|p| !p.is_empty())?;
        let values = o.get("values")?.as_object()?;
        Some(ImportSet { browser: browser.into(), profile: profile.into(), values: values.clone() })
    }

    fn usable(&self) -> bool {
        BROWSERS.contains(&self.browser.as_str()) && !self.profile.is_empty()
    }
}

/// What came in (LT:878 `counts`), in its keys' order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub spaces: u32,
    pub pins: u32,
    pub folders: u32,
    pub tabs: u32,
    pub archive: u32,
}

impl Counts {
    /// The counts in LT's keys' order.
    pub fn entries(&self) -> [(&'static str, u32); 5] {
        [
            ("spaces", self.spaces),
            ("pins", self.pins),
            ("folders", self.folders),
            ("tabs", self.tabs),
            ("archive", self.archive),
        ]
    }

    pub fn to_json(&self) -> Value {
        Value::Object(self.entries().iter().map(|(k, n)| ((*k).to_owned(), Value::from(*n))).collect())
    }
}

/// [`import_values`]'s answer: every collection's values with the import in them (LT:877 `next`), and the counts.
#[derive(Clone, Debug, PartialEq)]
pub struct Imported {
    pub values: Map<String, Value>,
    pub counts: Counts,
}

/// LT:866 `nsId`: `<browser>:<profile>:<id>`, or with fingerprints of the profile and the id when that's longer than
/// 256 units.
pub fn ns_id(browser: &str, profile: &str, id: &str) -> String {
    let name = format!("{browser}:{profile}:{id}");
    if js::len16(&name) <= NAME_MAX {
        return name;
    }
    let fp = js::fingerprint;
    format!("{browser}:{}{}:{}{}", fp(profile), fp(&format!("{profile}\n")), fp(id), fp(&format!("{id}\n")))
}

/// LT:870 `nsTabId`: an item's id, `t-` and two fingerprints of the browser, profile and id (the model takes only `t-`
/// ids for items).
pub fn ns_tab_id(browser: &str, profile: &str, id: &str) -> String {
    let key = format!("{browser}\n{profile}\n{id}");
    format!("t-{}{}", js::fingerprint(&key), js::fingerprint(&format!("{key}\n")))
}

/// LT:43 `str(v, max)`: a string cut at `max` units, else empty.
fn text(v: Option<&Value>, max: usize) -> Value {
    Value::String(v.and_then(Value::as_str).map(|s| js::slice16(s, max)).unwrap_or("").to_owned())
}

/// LT:44 `finite(v)`: a finite JSON number, else 0, as JSON.
fn finite(v: Option<&Value>) -> Value {
    number(js::finite(v).unwrap_or(0.0))
}

/// A finite number as JSON: an integer when it's whole (`5`, as JS writes it), else its double.
fn number(n: f64) -> Value {
    crate::protocol::number(n).unwrap_or(Value::Null)
}

/// LT:85 `sorted(list)`: an object's entries whose values are objects, in its order (the store's: ids in code-point
/// order); nothing for anything else.
fn entries(list: Option<&Value>) -> Vec<(&str, &Map<String, Value>)> {
    match list {
        Some(Value::Object(o)) => o.iter().filter_map(|(id, v)| v.as_object().map(|v| (id.as_str(), v))).collect(),
        _ => Vec::new(),
    }
}

fn order_of(v: &Map<String, Value>) -> f64 {
    js::finite(v.get("order")).unwrap_or(0.0)
}

/// LT:875 `importValues` up to its last step: the sets (each as [`ImportSet::from_json`] takes them) into `current`'s
/// values, the spaces in the person's `order` (`[browser, profile, space]` each), the marker `imports.done` at `now`.
pub fn import_values(
    current: &Map<String, Value>,
    sets: &[ImportSet],
    order: &[(String, String, String)],
    now: f64,
    collation: &dyn LocaleCompare,
) -> Imported {
    let now = if now.is_finite() { now } else { 0.0 };
    let mut next: Map<String, Value> = COLLECTIONS
        .iter()
        .map(|&c| {
            ((*c).to_owned(), Value::Object(current.get(c).and_then(Value::as_object).cloned().unwrap_or_default()))
        })
        .collect();
    let mut counts = Counts::default();
    let mut placed: Vec<String> = Vec::new(); // space ids in the order they go
    // `new Map(order.map(...))`: a key given twice keeps its last place.
    let mut rank: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, (b, p, id)) in order.iter().enumerate() {
        rank.insert(ns_id(b, p, id), i);
    }
    let ok: Vec<&ImportSet> = sets.iter().filter(|s| s.usable()).collect();
    for set in &ok {
        let (browser, profile) = (set.browser.as_str(), set.profile.as_str());
        let target = || {
            let mut t = Map::new();
            t.insert("kind".into(), "web".into());
            t.insert("browser".into(), browser.into());
            t.insert("profile".into(), profile.into());
            Value::Object(t)
        };
        let mut space_ids: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
        let mut own = entries(set.values.get("spaces"));
        own.sort_by(|a, b| js::num_cmp(order_of(a.1), order_of(b.1)).then_with(|| collation.compare(a.0, b.0)));
        for (id, sp) in &own {
            let lib = ns_id(browser, profile, id);
            space_ids.insert(id, lib.clone());
            placed.push(lib.clone());
            let mut v = Map::new();
            v.insert("name".into(), text(sp.get("name"), 200));
            v.insert("emoji".into(), text(sp.get("emoji"), 16));
            v.insert("color".into(), text(sp.get("color"), 32));
            v.insert("order".into(), Value::from(0));
            v.insert("browser".into(), browser.into());
            v.insert("profile".into(), profile.into());
            insert(&mut next, "spaces", lib, Value::Object(v));
            counts.spaces += 1;
        }
        let space_of = |v: &Map<String, Value>, key: &str| {
            v.get(key).and_then(Value::as_str).and_then(|s| space_ids.get(s)).cloned()
        };
        let mut folder_ids: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
        for (id, f) in entries(set.values.get("folders")) {
            let Some(space_id) = space_of(f, "spaceId") else { continue };
            let lib = ns_id(browser, profile, id);
            folder_ids.insert(id, lib.clone());
            let mut v = Map::new();
            v.insert("spaceId".into(), space_id.into());
            v.insert("name".into(), text(f.get("name"), 200));
            v.insert("open".into(), Value::Bool(f.get("open") != Some(&Value::Bool(false))));
            v.insert("pos".into(), finite(f.get("pos")));
            insert(&mut next, "folders", lib, Value::Object(v));
            counts.folders += 1;
        }
        for (id, pin) in entries(set.values.get("pins")) {
            let Some(space_id) = space_of(pin, "spaceId") else { continue };
            let Some(url) = pin.get("url").and_then(Value::as_str) else { continue };
            let folder =
                pin.get("folderId").and_then(Value::as_str).and_then(|f| folder_ids.get(f)).filter(|f| !f.is_empty());
            let mut v = Map::new();
            v.insert("spaceId".into(), space_id.into());
            v.insert("url".into(), url.into());
            v.insert("title".into(), text(pin.get("title"), 2000));
            v.insert("folderId".into(), folder.map_or(Value::Null, |f| f.as_str().into()));
            v.insert("pos".into(), finite(pin.get("pos")));
            v.insert("target".into(), target());
            insert(&mut next, "pins", ns_id(browser, profile, id), Value::Object(v));
            counts.pins += 1;
        }
        for (id, t) in entries(set.values.get("tabs")) {
            let Some(space_id) = space_of(t, "spaceId") else { continue };
            let Some(url) = t.get("url").and_then(Value::as_str).filter(|u| js::is_web_page(u)) else { continue };
            // /^(https?|data):/ (no `i`: case matters); a value that isn't a string gives '' either way.
            let icon = t
                .get("icon")
                .and_then(Value::as_str)
                .filter(|i| i.starts_with("http:") || i.starts_with("https:") || i.starts_with("data:"));
            let mut imported = Map::new();
            imported.insert("browser".into(), browser.into());
            imported.insert("profile".into(), profile.into());
            imported.insert("id".into(), id.into());
            let mut v = Map::new();
            v.insert("url".into(), url.into());
            v.insert("title".into(), text(t.get("title"), 2000));
            v.insert("icon".into(), icon.map_or(Value::String(String::new()), |i| js::slice16(i, 100_000).into()));
            v.insert("spaceId".into(), space_id.into());
            v.insert("order".into(), finite(t.get("order")));
            v.insert("lastUsed".into(), finite(t.get("lastUsed")));
            v.insert("selected".into(), Value::Bool(t.get("selected") == Some(&Value::Bool(true))));
            v.insert("target".into(), target());
            v.insert("imported".into(), Value::Object(imported));
            insert(&mut next, "tabs", ns_tab_id(browser, profile, id), Value::Object(v));
            counts.tabs += 1;
        }
        for (id, a) in entries(set.values.get("archive")) {
            let Some(url) = a.get("url").and_then(Value::as_str) else { continue };
            // An entry of a space the set no longer has: the profile's first.
            let Some(space_id) =
                space_of(a, "spaceId").or_else(|| own.first().and_then(|(first, _)| space_ids.get(first)).cloned())
            else {
                continue;
            };
            let mut v = Map::new();
            v.insert("url".into(), url.into());
            v.insert("title".into(), text(a.get("title"), 2000));
            v.insert("spaceId".into(), space_id.into());
            v.insert("icon".into(), text(a.get("icon"), 100_000));
            v.insert("closedAt".into(), finite(a.get("closedAt")));
            v.insert("target".into(), target());
            insert(&mut next, "archive", ns_id(browser, profile, id), Value::Object(v));
            counts.archive += 1;
        }
    }
    // The order: what the library had first (by its order alone, ties as stored), then the person's order, then the
    // rest as the sets gave them.
    let mut had = entries(current.get("spaces"));
    had.sort_by(|a, b| js::num_cmp(order_of(a.1), order_of(b.1)));
    let had: Vec<String> = had.into_iter().map(|(id, _)| id.to_owned()).filter(|id| !placed.contains(id)).collect();
    let mut incoming: Vec<(usize, &String)> = placed.iter().enumerate().collect();
    incoming.sort_by_key(|(i, id)| rank.get(id.as_str()).copied().unwrap_or(order.len() + i));
    let spaces = next.get_mut("spaces").and_then(Value::as_object_mut).expect("made above");
    for (i, id) in had.iter().chain(incoming.into_iter().map(|(_, id)| id)).enumerate() {
        // `{ ...next.spaces[id], order: i }`: its keys where they were, `order` replaced or added last.
        let mut v = spaces.get(id).and_then(Value::as_object).cloned().unwrap_or_default();
        v.insert("order".into(), Value::from(i));
        spaces.insert(id.clone(), Value::Object(v));
    }
    let mut done = Map::new();
    done.insert("at".into(), number(now));
    done.insert(
        "sets".into(),
        Value::Array(ok.iter().map(|s| Value::String(format!("{}:{}", s.browser, s.profile))).collect()),
    );
    for (k, n) in counts.entries() {
        done.insert(k.into(), Value::from(n));
    }
    insert(&mut next, "imports", "done".into(), Value::Object(done));
    Imported { values: next, counts }
}

/// LT:875 `importValues` whole: [`import_values`], then its last step (LT:932-934): the result read through the rules
/// once (`valuesOf(stateOf(next), next.imports)`), so what's stored is what the rules give back and the next action
/// changes nothing, and the changes from `current` (the values as stored) to that. With its counts.
pub fn import_changes(
    current: &Map<String, Value>,
    sets: &[ImportSet],
    order: &[(String, String, String)],
    now: f64,
    collation: &dyn LocaleCompare,
) -> (Vec<Change>, Counts) {
    let Imported { values: next, counts } = import_values(current, sets, order, now, collation);
    let state = state::state_of(&next, collation);
    let imports = next.get("imports").and_then(Value::as_object).cloned().unwrap_or_default();
    let normal = values::values_of(&state, &imports);
    (values::diff_values(current, &normal), counts)
}

/// What the import reads (L:249-267 `importOnce`'s reading): every profile's set the data has (Safari's first, then
/// the other browsers by name; each browser's profiles in the data's order), each as its `spaces`, `pins`, `folders`,
/// `tabs` and `archive`; and each browser's spaces in the person's order (data/<browser>/browser.json, read only: the
/// slots rule, `BrowserProfiles::resolve`, over each set's spaces by their `order` and id), `[browser, profile,
/// space]` each. Nothing written.
pub fn sources(data: &mut DataSync) -> (Vec<ImportSet>, Vec<(String, String, String)>) {
    let all = data.profiles(None);
    let mut browsers: Vec<&str> = all.iter().map(|p| p.browser.as_str()).collect();
    browsers.sort_by(|a, b| (*a != "safari", *a).cmp(&(*b != "safari", *b)));
    browsers.dedup();
    let root = data.store().root().to_path_buf();
    let mut sets = Vec::new();
    let mut order = Vec::new();
    for browser in browsers {
        let mut spaces: HashMap<String, Vec<String>> = HashMap::new();
        for p in all.iter().filter(|p| p.browser == browser) {
            if data.set(p).is_none() {
                continue;
            }
            let mut values = Map::new();
            for c in ["spaces", "pins", "folders", "tabs", "archive"] {
                values.insert(c.into(), Value::Object(data.values(c, p)));
            }
            // The spaces by `order` (a number, else 0), then their ids.
            let mut own: Vec<(f64, &String)> = values["spaces"]
                .as_object()
                .map(|l| l.iter().map(|(id, v)| (crate::json::num(v.get("order")).unwrap_or(0.0), id)).collect())
                .unwrap_or_default();
            own.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.cmp(b.1)));
            spaces.insert(p.profile.clone(), own.into_iter().map(|(_, id)| id.clone()).collect());
            sets.push(ImportSet { browser: browser.to_owned(), profile: p.profile.clone(), values });
        }
        let known = BrowserProfiles::new(browser, Some(&root));
        for k in BrowserProfiles::resolve(known.stored(), &spaces, &known.profiles()) {
            order.push((browser.to_owned(), k.profile, k.space));
        }
    }
    (sets, order)
}

fn insert(values: &mut Map<String, Value>, collection: &str, id: String, value: Value) {
    if let Some(Value::Object(c)) = values.get_mut(collection) {
        c.insert(id, value);
    }
}

#[cfg(test)]
#[path = "import_tests.rs"]
mod tests;
