//! The state back to values, and the changes between two (docs/CORE-REFACTOR.md step 4 part 2): library.ts's
//! `valuesOf` (LT:139-160) and `diff` (LT:163-172).
//!
//! `valuesOf` is written once, as rows: each record as the value it's stored as (borrowed from the state, its numbers
//! and fallbacks worked out: a space's `order` is its place, a pin with no `pos` its index, a target checked again).
//! [`values_of`] writes the rows as JSON; [`diff`] compares two states' rows and writes JSON only for what differs
//! (today's LT runs `valuesOf` twice and `JSON.stringify`s every record twice per action), skipping every collection
//! both states share (the same list: a rule that didn't touch it). Two rows are equal exactly when LT's two
//! `JSON.stringify`s are: the same keys in the same order (one writer makes both), strings the same, numbers the same
//! double (-0 is 0's text; any two non-finite numbers are both `null`).
//!
//! [`diff_values`] is `diff` over values as JSON, for the import (LT:934: the values read from the store against the
//! values the rules give back), where one side wasn't written by the rows.

use std::rc::Rc;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::import::COLLECTIONS;
use super::js;
use super::state::{Imported, Item, LibState, Str, TargetView, js_key_order, theme_id_ok};

/// One change for the store (LT:32 `Change`): a record's new value, or its deletion. Untimed: the store times it.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Set { collection: &'static str, id: String, value: Value },
    Deleted { collection: &'static str, id: String },
}

impl Change {
    pub fn collection(&self) -> &'static str {
        match self {
            Change::Set { collection, .. } | Change::Deleted { collection, .. } => collection,
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Change::Set { id, .. } | Change::Deleted { id, .. } => id,
        }
    }

    /// As LT writes it (and `LibraryStore::apply` takes it): `{ collection, id, value }` or `{ collection, id, deleted:
    /// true }`.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("collection".into(), self.collection().into());
        o.insert("id".into(), self.id().into());
        match self {
            Change::Set { value, .. } => o.insert("value".into(), value.clone()),
            Change::Deleted { .. } => o.insert("deleted".into(), Value::Bool(true)),
        };
        Value::Object(o)
    }
}

// ---- rows ------------------------------------------------------------------------------------------------------------

/// A number as `JSON.stringify` writes it: two are the same text when they're the same double (-0 and 0 both `0`) or
/// both not finite (both `null`).
#[derive(Clone, Copy, Debug)]
struct Num(f64);

impl PartialEq for Num {
    fn eq(&self, other: &Num) -> bool {
        if !self.0.is_finite() && !other.0.is_finite() { true } else { self.0 == other.0 }
    }
}

impl Num {
    /// LT:44 `finite(v, or)` of a typed number: `or` for one that isn't finite.
    fn finite(v: f64, or: f64) -> Num {
        Num(if v.is_finite() { v } else { or })
    }

    /// `finite(v, or)` of a number that may be missing.
    fn finite_opt(v: Option<f64>, or: f64) -> Num {
        Num(v.filter(|n| n.is_finite()).unwrap_or(or))
    }

    fn value(self) -> Value {
        number(self.0)
    }
}

/// A number as JSON: an integer when it's whole (JS writes `5`, not `5.0`), `null` when it isn't finite (as
/// `JSON.stringify` writes NaN and ∞).
fn number(n: f64) -> Value {
    crate::protocol::number(n).unwrap_or(Value::Null)
}

/// A list of numbers compared as `JSON.stringify` compares them.
fn same_numbers(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| Num(*x) == Num(*y))
}

/// `...(x ? { key: x } : {})` for a string: set and not empty.
#[inline]
fn truthy(s: &Option<Str>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

trait Row: PartialEq {
    fn value(&self) -> Value;
}

fn object(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn opt(o: &mut Map<String, Value>, key: &str, v: Option<&str>) {
    if let Some(v) = v {
        o.insert(key.into(), v.into());
    }
}

/// LT:141: `{ name, emoji, color, order: i, browser, profile, theme? }`.
#[derive(PartialEq)]
struct SpaceRow<'a> {
    name: &'a str,
    emoji: &'a str,
    color: &'a str,
    order: Num,
    browser: &'a str,
    profile: Option<&'a str>,
    theme: Option<&'a str>,
}

impl Row for SpaceRow<'_> {
    fn value(&self) -> Value {
        let mut o = Map::new();
        o.insert("name".into(), self.name.into());
        o.insert("emoji".into(), self.emoji.into());
        o.insert("color".into(), self.color.into());
        o.insert("order".into(), self.order.value());
        o.insert("browser".into(), self.browser.into());
        o.insert("profile".into(), self.profile.map_or(Value::Null, Value::from));
        opt(&mut o, "theme", self.theme);
        Value::Object(o)
    }
}

/// LT:142: `{ spaceId, url, title, customTitle?, folderId, pos, target }`.
#[derive(PartialEq)]
struct PinRow<'a> {
    space_id: &'a str,
    url: &'a str,
    title: &'a str,
    custom_title: Option<&'a str>,
    folder_id: Option<&'a str>,
    pos: Num,
    target: TargetView<'a>,
}

impl Row for PinRow<'_> {
    fn value(&self) -> Value {
        let mut o = Map::new();
        o.insert("spaceId".into(), self.space_id.into());
        o.insert("url".into(), self.url.into());
        o.insert("title".into(), self.title.into());
        opt(&mut o, "customTitle", self.custom_title);
        o.insert("folderId".into(), self.folder_id.map_or(Value::Null, Value::from));
        o.insert("pos".into(), self.pos.value());
        o.insert("target".into(), self.target.to_value());
        Value::Object(o)
    }
}

/// LT:143: `{ scope, url, title, customTitle?, pos, target }`.
#[derive(PartialEq)]
struct FavoriteRow<'a> {
    scope: &'a str,
    url: &'a str,
    title: &'a str,
    custom_title: Option<&'a str>,
    pos: Num,
    target: TargetView<'a>,
}

impl Row for FavoriteRow<'_> {
    fn value(&self) -> Value {
        let mut o = Map::new();
        o.insert("scope".into(), self.scope.into());
        o.insert("url".into(), self.url.into());
        o.insert("title".into(), self.title.into());
        opt(&mut o, "customTitle", self.custom_title);
        o.insert("pos".into(), self.pos.value());
        o.insert("target".into(), self.target.to_value());
        Value::Object(o)
    }
}

/// LT:144: `{ pattern, spaceId, enabled, order }`.
#[derive(PartialEq)]
struct RuleRow<'a> {
    pattern: &'a str,
    space_id: &'a str,
    enabled: bool,
    order: Num,
}

impl Row for RuleRow<'_> {
    fn value(&self) -> Value {
        object([
            ("pattern", self.pattern.into()),
            ("spaceId", self.space_id.into()),
            ("enabled", self.enabled.into()),
            ("order", self.order.value()),
        ])
    }
}

/// LT:145: `{ spaceId, axis, panes, ratios, pinned?, folderId?, pos? }`.
struct SplitRow<'a> {
    space_id: &'a str,
    axis: &'static str,
    panes: &'a [Str],
    ratios: &'a [f64],
    pinned: bool,
    folder_id: Option<&'a str>,
    pos: Option<Num>,
}

impl PartialEq for SplitRow<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.space_id == other.space_id
            && self.axis == other.axis
            && self.panes == other.panes
            && same_numbers(self.ratios, other.ratios)
            && self.pinned == other.pinned
            && self.folder_id == other.folder_id
            && self.pos == other.pos
    }
}

impl Row for SplitRow<'_> {
    fn value(&self) -> Value {
        let mut o = Map::new();
        o.insert("spaceId".into(), self.space_id.into());
        o.insert("axis".into(), self.axis.into());
        o.insert("panes".into(), Value::Array(self.panes.iter().map(|p| Value::from(&**p)).collect()));
        o.insert("ratios".into(), Value::Array(self.ratios.iter().map(|r| number(*r)).collect()));
        if self.pinned {
            o.insert("pinned".into(), Value::Bool(true));
        }
        opt(&mut o, "folderId", self.folder_id);
        if let Some(pos) = self.pos {
            o.insert("pos".into(), pos.value());
        }
        Value::Object(o)
    }
}

/// LT:146: `{ spaceId, name, open, pos, parentId? }`.
#[derive(PartialEq)]
struct FolderRow<'a> {
    space_id: &'a str,
    name: &'a str,
    open: bool,
    pos: Num,
    parent_id: Option<&'a str>,
}

impl Row for FolderRow<'_> {
    fn value(&self) -> Value {
        let mut o = Map::new();
        o.insert("spaceId".into(), self.space_id.into());
        o.insert("name".into(), self.name.into());
        o.insert("open".into(), self.open.into());
        o.insert("pos".into(), self.pos.value());
        opt(&mut o, "parentId", self.parent_id);
        Value::Object(o)
    }
}

/// LT:147-155: `{ url, title, icon, spaceId, order, lastUsed, selected, target, pinnedBy?, favoriteId?, customTitle?,
/// imported? }`.
#[derive(PartialEq)]
struct ItemRow<'a> {
    url: &'a str,
    title: &'a str,
    icon: &'a str,
    space_id: &'a str,
    order: Num,
    last_used: Num,
    selected: bool,
    target: TargetView<'a>,
    pinned_by: Option<&'a str>,
    favorite_id: Option<&'a str>,
    custom_title: Option<&'a str>,
    imported: Option<&'a Imported>,
}

impl Row for ItemRow<'_> {
    fn value(&self) -> Value {
        let mut o = Map::new();
        o.insert("url".into(), self.url.into());
        o.insert("title".into(), self.title.into());
        o.insert("icon".into(), self.icon.into());
        o.insert("spaceId".into(), self.space_id.into());
        o.insert("order".into(), self.order.value());
        o.insert("lastUsed".into(), self.last_used.value());
        o.insert("selected".into(), self.selected.into());
        o.insert("target".into(), self.target.to_value());
        opt(&mut o, "pinnedBy", self.pinned_by);
        opt(&mut o, "favoriteId", self.favorite_id);
        opt(&mut o, "customTitle", self.custom_title);
        if let Some(i) = self.imported {
            o.insert(
                "imported".into(),
                object([("browser", (*i.browser).into()), ("profile", (*i.profile).into()), ("id", (*i.id).into())]),
            );
        }
        Value::Object(o)
    }
}

/// LT:157: `{ url, title, spaceId, icon, closedAt, target }`.
#[derive(PartialEq)]
struct ArchiveRow<'a> {
    url: &'a str,
    title: &'a str,
    space_id: &'a str,
    icon: &'a str,
    closed_at: Num,
    target: TargetView<'a>,
}

impl Row for ArchiveRow<'_> {
    fn value(&self) -> Value {
        object([
            ("url", self.url.into()),
            ("title", self.title.into()),
            ("spaceId", self.space_id.into()),
            ("icon", self.icon.into()),
            ("closedAt", self.closed_at.value()),
            ("target", self.target.to_value()),
        ])
    }
}

/// LT:158: `{ spaceId }`.
#[derive(PartialEq)]
struct WindowRow<'a> {
    space_id: &'a str,
}

impl Row for WindowRow<'_> {
    fn value(&self) -> Value {
        object([("spaceId", self.space_id.into())])
    }
}

/// One collection's rows by id (`out[c][id] = …`: a later record of the same id replaces the earlier's value, its key
/// where the first put it).
type Rows<'a, R> = IndexMap<&'a str, R>;

fn space_rows(s: &LibState) -> Rows<'_, SpaceRow<'_>> {
    s.spaces
        .iter()
        .enumerate()
        .map(|(i, sp)| {
            (
                &*sp.id,
                SpaceRow {
                    name: &sp.name,
                    emoji: &sp.emoji,
                    color: &sp.color,
                    order: Num(i as f64),
                    browser: &sp.browser,
                    profile: sp.profile.as_deref(),
                    theme: sp.theme.as_deref().filter(|t| theme_id_ok(t)),
                },
            )
        })
        .collect()
}

fn pin_rows(s: &LibState) -> Rows<'_, PinRow<'_>> {
    s.pins
        .iter()
        .enumerate()
        .map(|(i, p)| {
            (
                &*p.id,
                PinRow {
                    space_id: &p.space_id,
                    url: &p.url,
                    title: &p.title,
                    custom_title: truthy(&p.custom_title),
                    folder_id: p.folder_id.as_deref(),
                    pos: Num::finite_opt(p.pos, i as f64),
                    target: TargetView::checked(p.target.as_ref()),
                },
            )
        })
        .collect()
}

fn favorite_rows(s: &LibState) -> Rows<'_, FavoriteRow<'_>> {
    s.favorites
        .iter()
        .enumerate()
        .map(|(i, f)| {
            (
                &*f.id,
                FavoriteRow {
                    scope: if f.scope.is_empty() { "global" } else { &f.scope },
                    url: &f.url,
                    title: &f.title,
                    custom_title: truthy(&f.custom_title),
                    pos: Num::finite_opt(f.pos, i as f64),
                    target: TargetView::checked(f.target.as_ref()),
                },
            )
        })
        .collect()
}

fn rule_rows(s: &LibState) -> Rows<'_, RuleRow<'_>> {
    s.air_traffic
        .iter()
        .enumerate()
        .map(|(i, r)| {
            (
                &*r.id,
                RuleRow {
                    pattern: &r.pattern,
                    space_id: &r.space_id,
                    enabled: r.enabled,
                    order: Num::finite_opt(r.order, i as f64),
                },
            )
        })
        .collect()
}

fn split_rows(s: &LibState) -> Rows<'_, SplitRow<'_>> {
    s.splits
        .iter()
        .map(|g| {
            (
                &*g.id,
                SplitRow {
                    space_id: &g.space_id,
                    axis: g.axis.as_str(),
                    panes: &g.panes,
                    ratios: &g.ratios,
                    pinned: g.pinned,
                    folder_id: truthy(&g.folder_id),
                    pos: g.pos.filter(|p| p.is_finite()).map(Num),
                },
            )
        })
        .collect()
}

fn folder_rows(s: &LibState) -> Rows<'_, FolderRow<'_>> {
    s.folders
        .iter()
        .enumerate()
        .map(|(i, f)| {
            (
                &*f.id,
                FolderRow {
                    space_id: &f.space_id,
                    name: &f.name,
                    open: f.open,
                    pos: Num::finite_opt(f.pos, i as f64),
                    parent_id: truthy(&f.parent_id),
                },
            )
        })
        .collect()
}

fn item_row(k: &Item) -> ItemRow<'_> {
    ItemRow {
        url: &k.url,
        title: &k.title,
        icon: &k.fav_icon_url,
        space_id: &k.space_id,
        order: Num::finite(k.order, 0.0),
        last_used: Num::finite(k.last_active, 0.0),
        selected: k.was_active,
        target: TargetView::of(&k.target),
        pinned_by: truthy(&k.pinned_by),
        favorite_id: truthy(&k.favorite_id),
        custom_title: truthy(&k.custom_title),
        imported: k.imported.as_ref(),
    }
}

fn item_rows(s: &LibState) -> Rows<'_, ItemRow<'_>> {
    s.kept.values().map(|k| (&*k.id, item_row(k))).collect()
}

fn archive_rows(s: &LibState) -> Rows<'_, ArchiveRow<'_>> {
    s.archive
        .iter()
        .map(|a| {
            (
                &*a.id,
                ArchiveRow {
                    url: &a.url,
                    title: &a.title,
                    space_id: &a.space_id,
                    icon: &a.fav_icon_url,
                    closed_at: Num::finite(a.closed_at, 0.0),
                    target: TargetView::checked(a.target.as_ref()),
                },
            )
        })
        .collect()
}

fn window_rows(s: &LibState) -> Rows<'_, WindowRow<'_>> {
    s.windows.iter().map(|(w, space_id)| (&**w, WindowRow { space_id })).collect()
}

fn rows_value<R: Row>(rows: &Rows<'_, R>) -> Value {
    Value::Object(rows.iter().map(|(id, r)| ((*id).to_owned(), r.value())).collect())
}

// ---- valuesOf --------------------------------------------------------------------------------------------------------

/// LT:139 `valuesOf(state, imports)`: every collection as it's stored (`COLLECTIONS`' order), `imports` passed through
/// as given (`{ ...imports }`).
pub fn values_of(s: &LibState, imports: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("spaces".into(), rows_value(&space_rows(s)));
    out.insert("pins".into(), rows_value(&pin_rows(s)));
    out.insert("favorites".into(), rows_value(&favorite_rows(s)));
    out.insert("airTraffic".into(), rows_value(&rule_rows(s)));
    out.insert("splits".into(), rows_value(&split_rows(s)));
    out.insert("folders".into(), rows_value(&folder_rows(s)));
    out.insert("tabs".into(), rows_value(&item_rows(s)));
    out.insert("archive".into(), rows_value(&archive_rows(s)));
    out.insert("windows".into(), rows_value(&window_rows(s)));
    out.insert("imports".into(), Value::Object(imports.clone()));
    out
}

/// One item as it's stored (LT:147-155's value for it).
pub fn item_value(k: &Item) -> Value {
    item_row(k).value()
}

// ---- diff ------------------------------------------------------------------------------------------------------------

/// `Object.keys(o).sort()`: UTF-16 units' order.
fn sort16(ids: &mut [&str]) {
    ids.sort_by(|a, b| js::cmp16(a, b));
}

fn diff_rows<R: Row>(collection: &'static str, a: &Rows<'_, R>, b: &Rows<'_, R>, out: &mut Vec<Change>) {
    let mut changed: Vec<&str> = b.iter().filter(|(id, r)| a.get(*id) != Some(*r)).map(|(id, _)| *id).collect();
    sort16(&mut changed);
    for id in changed {
        out.push(Change::Set { collection, id: id.to_owned(), value: b[id].value() });
    }
    let mut gone: Vec<&str> = a.keys().filter(|id| !b.contains_key(*id)).copied().collect();
    sort16(&mut gone);
    out.extend(gone.into_iter().map(|id| Change::Deleted { collection, id: id.to_owned() }));
}

/// The items' changes: [`diff_rows`]'s, with an item both states hold as the same `Rc` taken as unchanged without its
/// row (an item's row depends on the item alone, not on its place). Only when every item is under its own id, as every
/// rule keeps them (otherwise `out.tabs[k.id]` could take a later item's value: the rows decide).
fn diff_kept(before: &LibState, after: &LibState, out: &mut Vec<Change>) {
    let keyed = |s: &LibState| s.kept.iter().all(|(key, k)| **key == *k.id);
    if !keyed(before) || !keyed(after) {
        return diff_rows("tabs", &item_rows(before), &item_rows(after), out);
    }
    let mut changed: Vec<(&str, &Item)> = after
        .kept
        .iter()
        .filter(|(id, k)| before.kept.get(id).is_none_or(|old| !Rc::ptr_eq(old, k) && item_row(old) != item_row(k)))
        .map(|(id, k)| (&**id, &**k))
        .collect();
    changed.sort_by(|a, b| js::cmp16(a.0, b.0));
    for (id, k) in changed {
        out.push(Change::Set { collection: "tabs", id: id.to_owned(), value: item_row(k).value() });
    }
    let mut gone: Vec<&str> = before.kept.keys().filter(|id| !after.kept.contains_key(id)).map(|id| &**id).collect();
    sort16(&mut gone);
    out.extend(gone.into_iter().map(|id| Change::Deleted { collection: "tabs", id: id.to_owned() }));
}

/// LT:163 `diff(valuesOf(before), valuesOf(after))` as `perform` runs it (LT:820, 831): by collection in `COLLECTIONS`'
/// order, each one's changed records (ids in UTF-16 order), then its deleted ones. `imports` is passed through on both
/// sides (`values.imports`), so it never changes here. A collection both states hold as the same list is skipped.
pub fn diff(before: &LibState, after: &LibState) -> Vec<Change> {
    let mut out = Vec::new();
    macro_rules! each {
        ($field:ident, $name:literal, $rows:ident) => {
            if !Rc::ptr_eq(&before.$field, &after.$field) {
                diff_rows($name, &$rows(before), &$rows(after), &mut out);
            }
        };
    }
    each!(spaces, "spaces", space_rows);
    each!(pins, "pins", pin_rows);
    each!(favorites, "favorites", favorite_rows);
    each!(air_traffic, "airTraffic", rule_rows);
    each!(splits, "splits", split_rows);
    each!(folders, "folders", folder_rows);
    if !Rc::ptr_eq(&before.kept, &after.kept) {
        diff_kept(before, after, &mut out);
    }
    each!(archive, "archive", archive_rows);
    each!(windows, "windows", window_rows);
    out
}

/// JS's own-key order of an object's entries: array indexes first, ascending; then the rest as they came.
fn js_entries(o: &Map<String, Value>) -> Vec<(&str, &Value)> {
    let mut list: Vec<(&str, &Value)> = o.iter().map(|(k, v)| (k.as_str(), v)).collect();
    js_key_order(&mut list);
    list
}

/// `JSON.stringify(a) === JSON.stringify(b)` for two JSON values (`None`: undefined, whose stringify is undefined): the
/// same keys in the same (JS) order, numbers the same double.
pub fn same_json(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => same_value(a, b),
        _ => false,
    }
}

fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => {
            Num(x.as_f64().unwrap_or(f64::NAN)) == Num(y.as_f64().unwrap_or(f64::NAN))
        }
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same_value(x, y)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && js_entries(x)
                    .into_iter()
                    .zip(js_entries(y))
                    .all(|((kx, vx), (ky, vy))| kx == ky && same_value(vx, vy))
        }
        _ => false,
    }
}

/// LT:163 `diff(before, after)` over values as JSON (the import's: LT:934, the values read from the store against what
/// the rules give back). A collection that isn't an object is none (the store's always are).
pub fn diff_values(before: &Map<String, Value>, after: &Map<String, Value>) -> Vec<Change> {
    fn list<'a>(values: &'a Map<String, Value>, c: &str) -> Option<&'a Map<String, Value>> {
        values.get(c)?.as_object()
    }
    let empty = Map::new();
    let mut out = Vec::new();
    for collection in COLLECTIONS {
        let a = list(before, collection).unwrap_or(&empty);
        let b = list(after, collection).unwrap_or(&empty);
        let mut changed: Vec<&str> =
            b.iter().filter(|(id, v)| !same_json(a.get(id.as_str()), Some(v))).map(|(id, _)| id.as_str()).collect();
        sort16(&mut changed);
        for id in changed {
            out.push(Change::Set { collection, id: id.to_owned(), value: b[id].clone() });
        }
        let mut gone: Vec<&str> = a.keys().filter(|id| !b.contains_key(id.as_str())).map(String::as_str).collect();
        sort16(&mut gone);
        out.extend(gone.into_iter().map(|id| Change::Deleted { collection, id: id.to_owned() }));
    }
    out
}

#[cfg(test)]
#[path = "values_tests.rs"]
mod tests;
