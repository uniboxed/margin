//! The lasting data on the link (docs/DATA.md "Messages"; app/macos/shell/DataSync.swift): each copy's `data.hello`,
//! `data.snapshot` and `data.changes` taken into its own profile's data set (`store`), and the app's answers:
//! `data.need`, `data.snapshot` (in parts, none over 1 MB), `data.changes` and `data.ack`. A message only ever
//! touches the set of the link it came on (its browser and profile: a `profile` naming another is refused, another
//! `epoch` left).
//!
//! - `data.hello`: the queue merged into the profile's set, stored, the set sent back (`data.snapshot`), then
//!   `data.ack`. If the copy's `rev` is the set's rev from before the merge (it has every item the app had), no
//!   snapshot: the queue's changes that lost come back in `data.changes`, then `data.ack` with the new rev. With no
//!   set for the profile, or one older than what the app confirmed to it (`acked` above the set's: the files
//!   restored from a backup, or a write lost), `data.need { all: true }` instead, and the queue is held until the
//!   copy's `data.snapshot` comes.
//! - `data.snapshot` from the copy (the converter's, first link): with no set, stored as the profile's, then
//!   `data.ack`; with one, merged in, stored, sent back merged, then `data.ack`.
//! - `data.changes` from the copy: merged, stored, `data.ack`; a change that lost to the app's newer item gets that
//!   item back (`data.changes`).
//! - the app's own changes (`change`): merged, stored, sent to the copy if linked.
//! - `data.ack`'s `upTo`: the newest `updatedAt` among the copy's changes stored, never lower than the copy's
//!   `acked`. Sent only once they're on disk.
//! - `rev` (the stored set's revision) goes on the snapshot's part 0, and on `data.ack` once the link is in step
//!   (the copy has had a snapshot, or matched the rev on hello): with everything the app sent before it applied,
//!   the copy then has the set at that rev.
//!
//! Sans-IO for the link: a message comes in as the parsed object (with its `k`) for a [`Link`], and what to send
//! comes back in [`Effects`], each message a JSON object with `k`, `profile` and `epoch`, ready to encode. The
//! store's files are written in the call (see `store`). Swift's callbacks (`onChange`, `onFirstSet`, `onCarried`)
//! are the effects' lists, and Swift's hold timer is the shell's: `next_hold_deadline` says when, `tick` lets go.
//!
//! A profile's set carried to a new id (Safari gives every named profile's copy a new one at a signing change;
//! a Chromium counterpart could map ids the same way later): `carry`. Before `data.need` for a profile with no set,
//! `before_need` is asked: it can hold the hello up to `hold_for` (a read of the browser's profiles may yet map the
//! id), or name the set to carry over at once.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Map, Value, json};

use super::set::{DataChange, DataSet, FORMAT};
use super::store::{DataProfile, DataStore, SaveError, Stored};
use super::{Note, number, random_hex};
use crate::json::{self, Object};

/// The largest message the app sends, as UTF-8 JSON (LinkMessage.swift `LinkProtocol.maxAppMessage`: Chrome
/// closes a native port on a bigger one).
pub const MAX_APP_MESSAGE: usize = 1_000_000;
/// The items' JSON in one message from the app, at most (the envelope fits in the rest of 1 MB).
pub const PART_BYTES: usize = 900_000;

/// One copy's link, as the data needs it: its hello's browser, profile and epoch.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Link {
    pub browser: String,
    pub profile: String,
    pub epoch: String,
}

impl Link {
    pub fn new(browser: impl Into<String>, profile: impl Into<String>, epoch: impl Into<String>) -> Self {
        Self { browser: browser.into(), profile: profile.into(), epoch: epoch.into() }
    }
    pub fn data_profile(&self) -> DataProfile {
        DataProfile::new(self.browser.as_str(), self.profile.as_str())
    }
}

/// A message for one link: send it on the link of `to` whose epoch is `epoch` (it's in the message too).
#[derive(Clone, Debug, PartialEq)]
pub struct Outgoing {
    pub to: DataProfile,
    pub epoch: String,
    pub message: Value,
}

impl Outgoing {
    pub fn kind(&self) -> &str {
        self.message.get("k").and_then(Value::as_str).unwrap_or("")
    }
}

/// What a call did that the shell acts on.
#[derive(Debug, Default)]
pub struct Effects {
    /// The messages to send, in order.
    pub send: Vec<Outgoing>,
    /// A profile's set changed (on disk): which collections (Swift's `onChange`).
    pub changed: Vec<(DataProfile, BTreeSet<String>)>,
    /// A profile's first set stored from its copy (`onFirstSet`).
    pub first_set: Vec<DataProfile>,
    /// A set carried over: old, new, why (`onCarried`).
    pub carried: Vec<(DataProfile, DataProfile, String)>,
    pub log: Vec<Note>,
}

impl Effects {
    /// The kinds sent, in order.
    pub fn kinds(&self) -> Vec<&str> {
        self.send.iter().map(Outgoing::kind).collect()
    }
}

/// What to do for a profile that has no set, before asking its copy for one.
#[derive(Clone, Debug, PartialEq)]
pub enum NeedChoice {
    /// `data.need`, as always.
    Ask,
    /// Wait up to `hold_for` for `carry` or `release`.
    Hold,
    /// That set is this profile's: carried over at once.
    Carry { from: DataProfile, why: String },
}

/// Asked before `data.need` for a profile with no set (see `NeedChoice`).
pub type BeforeNeed = Box<dyn FnMut(&DataProfile) -> NeedChoice + Send>;

/// What one link is in the middle of.
#[derive(Default)]
struct Linked {
    epoch: String,
    /// `data.need` sent, the copy's `data.snapshot` not here yet.
    awaiting: bool,
    /// Its queue and changes while awaiting.
    held: Vec<DataChange>,
    hello_acked: f64,
    acked_sent: f64,
    transfer: Option<String>,
    parts: BTreeMap<i64, Object>,
    parts_count: i64,
    /// The copy has every item of the app's set, but for what the app sent it since (in order) and its own changes
    /// still queued: acks carry the rev.
    synced: bool,
    /// A `data.hello` held before `data.need` (`before_need` said `Hold`), and when the hold ends (ms).
    held_hello: Option<Object>,
    hold_until: Option<f64>,
    /// `carry` under way for it.
    carrying: bool,
    /// The copy's `data.changes` meanwhile.
    held_changes: Vec<DataChange>,
}

pub struct DataSync {
    store: DataStore,
    /// The items' JSON in one message from the app, at most.
    pub part_bytes: usize,
    linked: HashMap<DataProfile, Linked>,
    /// Messages the app couldn't send (over 1 MB, the link down): tests read it.
    unsent: usize,
    pub before_need: Option<BeforeNeed>,
    /// Seconds a hello is held for `before_need`'s `Hold`.
    pub hold_for: f64,
    /// Milliseconds since 1970 (a carried set's tombstones, the hold's end).
    pub now: Box<dyn Fn() -> f64 + Send>,
}

impl DataSync {
    pub fn new(store: DataStore) -> Self {
        Self {
            store,
            part_bytes: PART_BYTES,
            linked: HashMap::new(),
            unsent: 0,
            before_need: None,
            hold_for: 3.0,
            now: Box::new(crate::time::now_ms),
        }
    }

    pub fn store(&self) -> &DataStore {
        &self.store
    }
    pub fn store_mut(&mut self) -> &mut DataStore {
        &mut self.store
    }
    pub fn unsent(&self) -> usize {
        self.unsent
    }

    // ---- the read API ----

    /// Every profile with a data set (of one browser, or all), linked or not.
    pub fn profiles(&self, browser: Option<&str>) -> Vec<DataProfile> {
        self.store.profiles(browser)
    }

    pub fn set(&mut self, p: &DataProfile) -> Option<&DataSet> {
        self.store.load(p).map(|s| &s.set)
    }

    /// A collection's live values: `{ id: value }`.
    pub fn values(&mut self, collection: &str, p: &DataProfile) -> Map<String, Value> {
        self.set(p).map(|s| s.live_values(collection)).unwrap_or_default()
    }

    /// The profile's Margin tabs, open or not, of one space or all, newest first (highest `order`; on the same
    /// order, by id).
    pub fn margin_tabs(&mut self, p: &DataProfile, space: Option<&str>) -> Vec<(String, Object)> {
        let mut out: Vec<(String, Object)> = self
            .values("tabs", p)
            .into_iter()
            .filter_map(|(id, v)| match v {
                Value::Object(o) if space.is_none_or(|s| json::string(o.get("spaceId")) == Some(s)) => Some((id, o)),
                _ => None,
            })
            .collect();
        let order = |o: &Object| json::num(o.get("order")).unwrap_or(0.0);
        out.sort_by(|a, b| order(&b.1).total_cmp(&order(&a.1)).then_with(|| a.0.cmp(&b.0)));
        out
    }

    pub fn is_linked(&self, p: &DataProfile) -> bool {
        self.linked.contains_key(p)
    }

    // ---- the app's own changes ----

    /// Merged into the profile's set, stored, and sent to its copy if it's linked. `None` if the profile has no set.
    pub fn change(&mut self, p: &DataProfile, changes: &[DataChange]) -> Option<Effects> {
        let mut fx = Effects::default();
        let stored = self.store.load(p)?;
        let (mut set, acked) = (stored.set.clone(), stored.acked);
        let won = set.merge(changes);
        let applied: Vec<DataChange> = changes.iter().zip(&won).filter(|(_, w)| **w).map(|(c, _)| c.clone()).collect();
        if applied.is_empty() {
            return Some(self.finish(fx));
        }
        let changed = applied.iter().map(|c| c.collection.clone()).collect();
        if self.save(p, set, acked, Some(changed), &mut fx).is_some() && self.linked.get(p).is_some_and(|l| !l.awaiting)
        {
            self.send_changes(p, &applied, &mut fx);
        }
        Some(self.finish(fx))
    }

    // ---- the link ----

    /// A link up (after its `hello`): a newer one for the same profile replaces the older.
    pub fn link_up(&mut self, link: &Link) {
        self.linked.insert(link.data_profile(), Linked { epoch: link.epoch.clone(), ..Linked::default() });
    }

    pub fn link_down(&mut self, link: &Link) {
        let p = link.data_profile();
        if self.linked.get(&p).is_some_and(|l| l.epoch == link.epoch) {
            self.linked.remove(&p);
        }
    }

    /// The profiles whose `data.hello` is held (`before_need`'s `Hold`).
    pub fn holding(&self) -> Vec<DataProfile> {
        let mut out: Vec<DataProfile> =
            self.linked.iter().filter(|(_, l)| l.held_hello.is_some() && !l.carrying).map(|(p, _)| p.clone()).collect();
        out.sort();
        out
    }

    /// When the next hold runs out (ms since 1970, the `now` clock): call `tick` then.
    pub fn next_hold_deadline(&self) -> Option<f64> {
        self.linked
            .values()
            .filter(|l| l.held_hello.is_some() && !l.carrying)
            .filter_map(|l| l.hold_until)
            .reduce(f64::min)
    }

    /// The holds that ran out let go (`data.need`, as without the hold).
    pub fn tick(&mut self) -> Effects {
        let now = (self.now)();
        let mut due: Vec<DataProfile> = self
            .linked
            .iter()
            .filter(|(_, l)| l.held_hello.is_some() && !l.carrying && l.hold_until.is_some_and(|t| t <= now))
            .map(|(p, _)| p.clone())
            .collect();
        due.sort();
        let mut fx = Effects::default();
        let why = format!("no read mapped it within {} s", self.hold_for);
        for p in due {
            self.release_into(&p, &why, &mut fx);
        }
        self.finish(fx)
    }

    /// A held hello let go: `data.need`, as without the hold.
    pub fn release(&mut self, p: &DataProfile, why: &str) -> Effects {
        let mut fx = Effects::default();
        self.release_into(p, why, &mut fx);
        self.finish(fx)
    }

    fn release_into(&mut self, p: &DataProfile, why: &str, fx: &mut Effects) {
        let Some(l) = self.linked.get_mut(p) else { return };
        if l.carrying {
            return;
        }
        let Some(body) = l.held_hello.take() else { return };
        l.hold_until = None;
        fx.log.push(Note::note(format!("{p}: data.hello no longer held ({why})")));
        self.hello(p, &body, false, fx);
        self.take_held_changes(p, fx);
    }

    /// The copy's changes that came while its hello was held, taken as they would have been.
    fn take_held_changes(&mut self, p: &DataProfile, fx: &mut Effects) {
        let Some(l) = self.linked.get_mut(p) else { return };
        let list = std::mem::take(&mut l.held_changes);
        if !list.is_empty() {
            self.take_changes(p, list, fx);
        }
    }

    /// A message from a link: a JSON object with its `k` (`data.hello`, `data.snapshot`, `data.changes`).
    pub fn received(&mut self, link: &Link, message: &Value) -> Effects {
        let mut fx = Effects::default();
        let p = link.data_profile();
        let Some(body) = message.as_object() else { return fx };
        if self.linked.get(&p).is_none_or(|l| l.epoch != link.epoch) {
            return fx; // a link gone (or replaced): its messages left
        }
        if let Some(named) = body.get("profile")
            && named.as_str() != Some(link.profile.as_str())
        {
            fx.log.push(Note::warn(format!("{p}: {} for another profile ({named}): refused", kind_of(body))));
            return fx;
        }
        if body.get("epoch").is_some_and(|e| e.as_str() != Some(link.epoch.as_str())) {
            return fx;
        }
        match kind_of(body) {
            "data.hello" => self.hello(&p, body, true, &mut fx),
            "data.snapshot" => self.snapshot(&p, body, &mut fx),
            "data.changes" => self.take_changes(&p, DataChange::list(body.get("changes")), &mut fx),
            kind => fx.log.push(Note::note(format!("{p}: {kind} isn't known: left"))),
        }
        self.finish(fx)
    }

    fn hello(&mut self, p: &DataProfile, body: &Object, hold: bool, fx: &mut Effects) {
        if json::int(body.get("format")).unwrap_or(FORMAT) != FORMAT {
            fx.log.push(Note::warn(format!("{p}: data.hello of format {}: left", shown(body.get("format")))));
            return;
        }
        let acked = json::num(body.get("acked")).unwrap_or(0.0).max(0.0);
        let queue = DataChange::list(body.get("queue"));
        let Some(l) = self.linked.get_mut(p) else { return };
        l.hello_acked = acked;
        l.acked_sent = acked;
        l.transfer = None;
        l.parts.clear();
        if hold && self.store.load(p).is_none() {
            let choice = self.before_need.as_mut().map(|f| f(p));
            match choice {
                None | Some(NeedChoice::Ask) => {}
                Some(NeedChoice::Hold) => {
                    let until = (self.now)() + self.hold_for * 1000.0;
                    let Some(l) = self.linked.get_mut(p) else { return };
                    if l.held_hello.is_none() {
                        fx.log.push(Note::note(format!(
                            "{p}: no data set, and no browser profile maps it yet: data.hello held up to {} s for the browser's profiles to be read",
                            self.hold_for
                        )));
                        l.hold_until = Some(until);
                    }
                    l.held_hello = Some(body.clone());
                    return;
                }
                Some(NeedChoice::Carry { from, why }) => {
                    if let Some(l) = self.linked.get_mut(p) {
                        l.held_hello = Some(body.clone());
                    }
                    if self.carry_into(&from, p, &why, fx) {
                        return;
                    }
                    if let Some(l) = self.linked.get_mut(p) {
                        l.held_hello = None;
                    }
                }
            }
        }
        let stored = self.store.load(p).map(|s| (s.acked, s.rev.clone()));
        let Some((stored_acked, rev_before)) = stored.clone().filter(|(a, _)| acked <= *a) else {
            fx.log.push(match stored {
                Some((a, _)) => Note::warn(format!(
                    "{p}: the copy has {} confirmed, the app's files only {}: the whole set asked for",
                    acked as i64, a as i64
                )),
                None => Note::note(format!("{p}: no data set yet: the whole set asked for")),
            });
            if let Some(l) = self.linked.get_mut(p) {
                l.awaiting = true;
                l.held = queue;
            }
            self.send(p, "data.need", json_object(json!({ "all": true })), fx);
            return;
        };
        if let Some(l) = self.linked.get_mut(p) {
            l.awaiting = false;
            l.held.clear();
        }
        // The copy has every item the app has (it says the set's rev): only what its queue lost goes back.
        let in_step = json::string(body.get("rev")).is_some_and(|r| !r.is_empty() && r == rev_before);
        let Some(mut set) = self.store.load(p).map(|s| s.set.clone()) else { return };
        let won = set.merge(&queue);
        let up_to = acked.max(newest(&queue));
        let lost = lost_keys(&queue, &won);
        let changed = won_collections(&queue, &won);
        fx.log.push(Note::note(format!(
            "{p}: data.hello, {} queued ({} taken), {}",
            queue.len(),
            won.iter().filter(|w| **w).count(),
            if in_step { "the copy has the app's set: no snapshot" } else { "the set sent back" }
        )));
        let Some(rev) = self.save(p, set, stored_acked.max(up_to), Some(changed), fx) else { return };
        let sent = if in_step {
            self.answer(p, &lost, fx);
            None
        } else {
            self.send_set(p, fx)
        };
        if let Some(l) = self.linked.get_mut(p) {
            l.synced = true;
        }
        self.send_ack(p, up_to, sent.unwrap_or(rev), fx); // a snapshot is of the set now: its rev
    }

    /// The app's items for changes of the copy's that lost to them, in `data.changes`.
    fn answer(&mut self, p: &DataProfile, lost: &BTreeSet<(String, String)>, fx: &mut Effects) {
        let back: Vec<DataChange> = match self.store.load(p) {
            Some(s) => lost
                .iter()
                .filter_map(|(c, id)| Some(DataChange::new(c.as_str(), id.as_str(), s.set.item(c, id)?.clone())))
                .collect(),
            None => return,
        };
        if !back.is_empty() {
            self.send_changes(p, &back, fx);
        }
    }

    fn snapshot(&mut self, p: &DataProfile, body: &Object, fx: &mut Effects) {
        let format_ok = |o: &Object| json::int(o.get("format")).unwrap_or(FORMAT) == FORMAT;
        let Some(set) = json::object(body.get("set")).filter(|s| format_ok(body) && format_ok(s)) else {
            fx.log.push(Note::warn(format!("{p}: a data.snapshot that isn't format {FORMAT}'s: left")));
            return;
        };
        let piece = json::object(set.get("items")).cloned().unwrap_or_default();
        let mut whole = piece.clone();
        if let Some(parts) = json::int(body.get("parts")) {
            let part = json::int(body.get("part")).filter(|n| (1..=10_000).contains(&parts) && (0..parts).contains(n));
            let Some(part) = part else {
                fx.log.push(Note::warn(format!("{p}: a data.snapshot part that doesn't add up: left")));
                return;
            };
            let transfer = json::string(body.get("transfer")).map(str::to_string);
            let Some(l) = self.linked.get_mut(p) else { return };
            if l.transfer != transfer || l.parts_count != parts {
                l.transfer = transfer;
                l.parts_count = parts;
                l.parts.clear();
            }
            l.parts.insert(part, piece);
            if l.parts.len() as i64 != parts {
                return;
            }
            whole = Object::new();
            for i in 0..parts {
                for (collection, list) in l.parts.get(&i).into_iter().flatten() {
                    let mut into = json::object(whole.get(collection)).cloned().unwrap_or_default();
                    if let Some(list) = list.as_object() {
                        into.extend(list.iter().map(|(k, v)| (k.clone(), v.clone())));
                    }
                    whole.insert(collection.clone(), Value::Object(into));
                }
            }
            l.transfer = None;
            l.parts.clear();
        }
        let incoming = DataSet::from_items(&whole);
        let stored = self.store.load(p).map(|s| (s.set.clone(), s.acked));
        let had = stored.is_some();
        let (mut merged, stored_acked) = stored.unwrap_or_default();
        let held = self.linked.get_mut(p).map(|l| std::mem::take(&mut l.held)).unwrap_or_default();
        merged.merge(&held);
        merged.merge(&incoming.changes());
        for collection in incoming.items.keys() {
            merged.items.entry(collection.clone()).or_default();
        }
        let hello_acked = self.linked.get(p).map_or(0.0, |l| l.hello_acked);
        let up_to = hello_acked.max(newest(&held)).max(incoming.newest());
        if let Some(l) = self.linked.get_mut(p) {
            l.awaiting = false;
        }
        let count: usize = incoming.items.values().map(BTreeMap::len).sum();
        fx.log.push(Note::note(format!(
            "{p}: data.snapshot from the copy ({count} items){}",
            if had { "" } else { ": the profile's first data set" }
        )));
        let Some(rev) = self.save(p, merged, stored_acked.max(up_to), None, fx) else { return };
        let sent = if had { self.send_set(p, fx) } else { None }; // the copy lacks what the app had
        if let Some(l) = self.linked.get_mut(p) {
            l.synced = true;
        }
        self.send_ack(p, up_to, sent.unwrap_or(rev), fx);
        if !had {
            fx.first_set.push(p.clone());
        }
    }

    fn take_changes(&mut self, p: &DataProfile, changes: Vec<DataChange>, fx: &mut Effects) {
        if changes.is_empty() {
            return;
        }
        let has_set = self.store.load(p).is_some();
        let Some(l) = self.linked.get_mut(p) else { return };
        // Its hello held (or being carried over): kept, and taken once the hello is answered.
        if l.held_hello.is_some() || l.carrying {
            l.held_changes.extend(changes);
            return;
        }
        if l.awaiting || !has_set {
            l.held.extend(changes);
            if !l.awaiting {
                l.awaiting = true;
                self.send(p, "data.need", json_object(json!({ "all": true })), fx);
            }
            return;
        }
        let acked_sent = l.acked_sent;
        let Some((mut set, stored_acked)) = self.store.load(p).map(|s| (s.set.clone(), s.acked)) else { return };
        let won = set.merge(&changes);
        let lost = lost_keys(&changes, &won);
        let up_to = acked_sent.max(newest(&changes));
        let changed = won_collections(&changes, &won);
        let Some(rev) = self.save(p, set, stored_acked.max(up_to), Some(changed), fx) else { return };
        self.answer(p, &lost, fx); // the app's newer items, for the changes that lost to them
        self.send_ack(p, up_to, rev, fx);
    }

    // ---- carried over ----

    /// `old`'s set becomes `new`'s (the same browser profile under a new id: a signing change). Only while `old`
    /// isn't linked, and only if `new` has no set or just its first, untouched one (rev 1: stored from its copy's
    /// snapshot, nothing changed since), and its copy isn't sending one now. `new`'s own items that `old`'s set
    /// doesn't have (the new copy's fresh defaults, in its first set or its held hello's queue) become deletions,
    /// so its copy ends up with `old`'s set alone; items both have stay `old`'s (a fresh copy's defaults are
    /// newer, and would win). Stored, then `old`'s folder put away (`DataStore::archive`), then the copy told: its
    /// held hello answered as a relink, or the set sent to it. `None` if it can't be done (or the save failed).
    pub fn carry(&mut self, old: &DataProfile, new: &DataProfile, why: &str) -> Option<Effects> {
        let mut fx = Effects::default();
        let ok = self.carry_into(old, new, why, &mut fx);
        let fx = self.finish(fx);
        ok.then_some(fx)
    }

    fn carry_into(&mut self, old: &DataProfile, new: &DataProfile, why: &str, fx: &mut Effects) -> bool {
        if old == new || old.browser != new.browser || self.is_linked(old) {
            return false;
        }
        let Some(source) = self.store.load(old).cloned() else { return false };
        let target = self.store.load(new).cloned();
        if target.as_ref().is_some_and(|t| !t.rev.starts_with("1-")) {
            return false; // changed since its first set: it's the person's now
        }
        if self.linked.get(new).is_some_and(|l| l.awaiting || l.carrying) {
            return false; // its copy's snapshot is on its way: after it's stored (first_set)
        }
        let held = self.linked.get(new).and_then(|l| l.held_hello.clone());
        let mut set = source.set.clone();
        let t = (self.now)();
        let mut theirs: Vec<(String, String, f64)> = Vec::new();
        for (c, list) in target.as_ref().map(|t| &t.set.items).into_iter().flatten() {
            for (id, item) in list.iter().filter(|(_, i)| !i.deleted()) {
                theirs.push((c.clone(), id.clone(), item.updated_at));
            }
        }
        for change in DataChange::list(held.as_ref().and_then(|h| h.get("queue"))) {
            if !change.item.deleted() {
                theirs.push((change.collection, change.id, change.item.updated_at));
            }
        }
        let mut dropped = 0;
        for (c, id, at) in theirs {
            if let std::collections::btree_map::Entry::Vacant(e) = set.items.entry(c).or_default().entry(id) {
                e.insert(super::set::DataItem::tombstone(t.max(at + 1.0)));
                dropped += 1;
            }
        }
        for c in target.as_ref().map(|t| t.set.collections()).unwrap_or_default() {
            set.items.entry(c).or_default();
        }
        let acked = source.acked.max(target.map_or(0.0, |t| t.acked));
        let items: usize = source.set.items.values().map(|l| l.values().filter(|i| !i.deleted()).count()).sum();
        if let Some(l) = self.linked.get_mut(new) {
            l.carrying = true;
        }
        let saved = self.save(new, set, acked, None, fx);
        if let Some(l) = self.linked.get_mut(new) {
            l.carrying = false;
        }
        let Some(rev) = saved else { return false };
        let archived = self.store.archive(old);
        fx.log.push(Note::note(format!(
            "{}: {} → {} ({why}): data carried over ({items} items{}; the old set {})",
            new.browser,
            old.profile,
            new.profile,
            if dropped > 0 { format!(", {dropped} of the new copy's own left out") } else { String::new() },
            if archived.is_none() { "not put away" } else { "put away" }
        )));
        fx.carried.push((old.clone(), new.clone(), why.to_string()));
        let Some(l) = self.linked.get_mut(new) else { return true };
        if let Some(mut body) = l.held_hello.take() {
            // The held hello answered as a relink with nothing queued: the set goes to the copy.
            l.hold_until = None;
            body.insert("queue".into(), json!([]));
            self.hello(new, &body, false, fx);
        } else if !l.awaiting {
            let acked_sent = l.acked_sent;
            let sent = self.send_set(new, fx);
            self.send_ack(new, acked_sent, sent.unwrap_or(rev), fx);
        }
        self.take_held_changes(new, fx);
        true
    }

    // ---- storing ----

    /// The rev this save wrote, or `None` if it wasn't stored (nothing is confirmed to the copy then).
    fn save(
        &mut self,
        p: &DataProfile,
        set: DataSet,
        acked: f64,
        changed: Option<BTreeSet<String>>,
        fx: &mut Effects,
    ) -> Option<String> {
        let all: BTreeSet<String> = set.items.keys().cloned().collect();
        match self.store.save(p, Stored::new(set, acked), changed.as_ref()) {
            Ok(rev) => {
                if changed.as_ref().is_none_or(|c| !c.is_empty()) {
                    fx.changed.push((p.clone(), changed.unwrap_or(all)));
                }
                Some(rev)
            }
            Err(SaveError::Crashed) => None, // a dead app says nothing
            Err(_) => {
                fx.log.push(Note::warn(format!("{p}: not stored: nothing confirmed to the copy")));
                None
            }
        }
    }

    /// The store's log, after the call's own.
    fn finish(&mut self, mut fx: Effects) -> Effects {
        fx.log.extend(self.store.take_log());
        fx
    }

    // ---- sending ----

    fn send(&mut self, p: &DataProfile, kind: &str, body: Object, fx: &mut Effects) {
        let Some(l) = self.linked.get(p) else {
            self.unsent += 1;
            return;
        };
        let mut message = Object::new();
        message.insert("k".into(), Value::from(kind));
        message.extend(body);
        message.insert("profile".into(), Value::from(p.profile.as_str()));
        message.insert("epoch".into(), Value::from(l.epoch.as_str()));
        let message = Value::Object(message);
        if serde_json::to_vec(&message).map_or(true, |b| b.len() > MAX_APP_MESSAGE) {
            self.unsent += 1;
            fx.log.push(Note::warn(format!("{p}: {kind} not sent")));
            return;
        }
        fx.send.push(Outgoing { to: p.clone(), epoch: l.epoch.clone(), message });
    }

    /// With the rev only while the link is in step: then the copy has the set at that rev.
    fn send_ack(&mut self, p: &DataProfile, up_to: f64, rev: String, fx: &mut Effects) {
        let Some(l) = self.linked.get_mut(p) else { return };
        l.acked_sent = l.acked_sent.max(up_to);
        let body =
            if l.synced { json!({ "upTo": number(up_to), "rev": rev }) } else { json!({ "upTo": number(up_to) }) };
        self.send(p, "data.ack", json_object(body), fx);
    }

    /// The profile's whole set as it is now, in parts. Its rev.
    fn send_set(&mut self, p: &DataProfile, fx: &mut Effects) -> Option<String> {
        let budget = self.part_bytes;
        let (parts, omitted, rev) = {
            let stored = self.store.load(p)?;
            let (parts, omitted) = Self::parts(&stored.set, budget);
            (parts, omitted, stored.rev.clone())
        };
        let transfer = uuid();
        let count = parts.len();
        for (i, items) in parts.into_iter().enumerate() {
            let mut body = json_object(json!({
                "format": FORMAT, "set": { "format": FORMAT, "items": items }, "transfer": transfer, "part": i, "parts": count,
            }));
            if i == 0 {
                body.insert("rev".into(), Value::from(rev.as_str()));
                if !omitted.is_empty() {
                    body.insert("omitted".into(), omitted.iter().map(|(c, id)| json!([c, id])).collect());
                }
            }
            self.send(p, "data.snapshot", body, fx);
        }
        if !omitted.is_empty() {
            fx.log.push(Note::warn(format!(
                "{p}: {} items too big for a message left out of data.snapshot",
                omitted.len()
            )));
        }
        Some(rev)
    }

    fn send_changes(&mut self, p: &DataProfile, changes: &[DataChange], fx: &mut Effects) {
        let (batches, omitted) = Self::batches(changes, self.part_bytes);
        for batch in batches {
            self.send(p, "data.changes", json_object(json!({ "changes": batch })), fx);
        }
        if !omitted.is_empty() {
            fx.log.push(Note::warn(format!("{} changes too big for a message not sent", omitted.len())));
        }
    }

    /// A set's items in parts of at most `budget` bytes of JSON, split by collection and item; every collection
    /// named in the first part (an empty one too: the copy then knows it's empty). An item bigger than the budget
    /// alone is left out (omitted).
    pub fn parts(set: &DataSet, budget: usize) -> (Vec<Object>, Vec<(String, String)>) {
        let mut parts = Vec::new();
        let mut current: Object = set.items.keys().map(|c| (c.clone(), json!({}))).collect();
        let mut size = set.items.keys().fold(16, |n, c| n + c.len() + 8);
        let mut omitted = Vec::new();
        for (collection, list) in &set.items {
            for (id, item) in list {
                let json = item.to_json();
                let bytes = json_len(&json) + id.len() * 2 + 8;
                if bytes + collection.len() + 64 > budget {
                    omitted.push((collection.clone(), id.clone()));
                    continue;
                }
                let opening = if current.contains_key(collection) { 0 } else { collection.len() + 8 };
                if size + bytes + opening > budget {
                    parts.push(std::mem::take(&mut current));
                    size = 16;
                }
                if !current.contains_key(collection) {
                    size += collection.len() + 8;
                }
                let into = current.entry(collection.clone()).or_insert_with(|| json!({}));
                if let Some(o) = into.as_object_mut() {
                    o.insert(id.clone(), json);
                }
                size += bytes;
            }
        }
        parts.push(current);
        (parts, omitted)
    }

    /// Changes in batches of at most `budget` bytes of JSON, in order. A change bigger than the budget alone is
    /// left out.
    pub fn batches(changes: &[DataChange], budget: usize) -> (Vec<Vec<Value>>, Vec<DataChange>) {
        let mut batches = Vec::new();
        let mut current = Vec::new();
        let mut size = 16;
        let mut omitted = Vec::new();
        for change in changes {
            let json = change.to_json();
            let bytes = json_len(&json) + 2;
            if bytes + 64 > budget {
                omitted.push(change.clone());
                continue;
            }
            if size + bytes > budget && !current.is_empty() {
                batches.push(std::mem::take(&mut current));
                size = 16;
            }
            current.push(json);
            size += bytes;
        }
        if !current.is_empty() {
            batches.push(current);
        }
        (batches, omitted)
    }
}

fn kind_of(body: &Object) -> &str {
    json::string(body.get("k")).unwrap_or("")
}

fn shown(v: Option<&Value>) -> String {
    v.map_or_else(|| "?".to_string(), Value::to_string)
}

fn json_object(v: Value) -> Object {
    match v {
        Value::Object(o) => o,
        _ => Object::new(),
    }
}

fn json_len(v: &Value) -> usize {
    serde_json::to_vec(v).map_or(usize::MAX / 4, |b| b.len())
}

/// The newest `updatedAt` among changes (0 if none).
fn newest(changes: &[DataChange]) -> f64 {
    changes.iter().map(|c| c.item.updated_at).fold(0.0, f64::max)
}

/// The (collection, id) of each change that lost.
fn lost_keys(changes: &[DataChange], won: &[bool]) -> BTreeSet<(String, String)> {
    changes.iter().zip(won).filter(|(_, w)| !**w).map(|(c, _)| (c.collection.clone(), c.id.clone())).collect()
}

fn won_collections(changes: &[DataChange], won: &[bool]) -> BTreeSet<String> {
    changes.iter().zip(won).filter(|(_, w)| **w).map(|(c, _)| c.collection.clone()).collect()
}

/// A snapshot's `transfer`: any string; a random UUID's shape, as Swift's.
fn uuid() -> String {
    let h = random_hex(16);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::set::DataItem;
    use crate::data::testing::{same, temp};
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_store(root: &Path) -> DataStore {
        let mut s = DataStore::new(root);
        s.now = Box::new(|| 1000.0);
        s
    }

    fn space(name: &str, order: i64) -> Value {
        json!({ "name": name, "emoji": "", "color": "#000", "order": order })
    }

    fn change(c: &str, id: &str, at: f64, value: Option<Value>) -> DataChange {
        DataChange::new(c, id, value.map_or_else(|| DataItem::tombstone(at), |v| DataItem::live(at, v)))
    }

    fn cj(c: &str, id: &str, at: f64, value: Option<Value>) -> Value {
        change(c, id, at, value).to_json()
    }

    fn sp(p: &str) -> DataProfile {
        DataProfile::new("safari", p)
    }

    fn msg(k: &str, body: Value) -> Value {
        let mut o = json_object(body);
        o.insert("k".into(), Value::from(k));
        Value::Object(o)
    }

    fn name(sync: &mut DataSync, p: &DataProfile, c: &str, id: &str) -> Option<String> {
        sync.values(c, p).get(id)?.get("name")?.as_str().map(str::to_string)
    }

    fn rev(sync: &mut DataSync, p: &DataProfile) -> String {
        sync.store_mut().load(p).map(|s| s.rev.clone()).unwrap_or_default()
    }

    fn acked(sync: &mut DataSync, p: &DataProfile) -> f64 {
        sync.store_mut().load(p).map_or(-1.0, |s| s.acked)
    }

    /// The whole set from data.snapshot parts (the last transfer's), and how many parts.
    fn assembled(sent: &[Outgoing]) -> Option<(Value, usize)> {
        let snaps: Vec<&Outgoing> = sent.iter().filter(|o| o.kind() == "data.snapshot").collect();
        let transfer = snaps.last()?.message.get("transfer")?.clone();
        let mine: Vec<&&Outgoing> = snaps.iter().filter(|o| o.message.get("transfer") == Some(&transfer)).collect();
        let parts = mine.first()?.message.get("parts")?.as_u64()? as usize;
        if mine.len() != parts {
            return None;
        }
        let mut items = Object::new();
        for m in mine {
            for (c, list) in m.message["set"]["items"].as_object()? {
                let into = items.entry(c.clone()).or_insert_with(|| json!({}));
                if let (Some(into), Some(list)) = (into.as_object_mut(), list.as_object()) {
                    into.extend(list.clone());
                }
            }
        }
        Some((json!({ "format": 1, "items": items }), parts))
    }

    fn body(o: &Outgoing, key: &str) -> Value {
        o.message.get(key).cloned().unwrap_or(Value::Null)
    }

    #[test]
    fn the_messages() {
        let root = temp();
        let mut sync = DataSync::new(test_store(root.path()));
        let (p1, p2) = (sp("P1"), sp("P2"));

        // ---- the first link ----
        let a = Link::new("safari", "P1", "e1");
        sync.link_up(&a);
        let fx = sync.received(&a, &msg("data.hello", json!({ "profile": "P1", "format": 1, "acked": 0, "queue": [cj("settings", "x", 50.0, Some(json!(1)))] })));
        assert_eq!(fx.kinds(), ["data.need"], "first link: no set, so data.need");
        assert_eq!(body(&fx.send[0], "all"), json!(true));
        assert!(body(&fx.send[0], "profile") == "P1" && body(&fx.send[0], "epoch") == "e1" && fx.send[0].epoch == "e1");
        assert!(sync.set(&p1).is_none());
        let fx = sync.received(&a, &msg("data.snapshot", json!({ "profile": "P1", "format": 1, "transfer": "t1", "part": 1, "parts": 2,
            "set": { "format": 1, "items": { "spaces": { "personal": { "updatedAt": 0, "value": space("Personal", 0) }, "work": { "updatedAt": 40, "value": space("Work", 1) } } } } })));
        assert!(fx.send.is_empty() && sync.set(&p1).is_none(), "a part of the copy's snapshot: waits for the rest");
        let fx = sync.received(
            &a,
            &msg(
                "data.snapshot",
                json!({ "profile": "P1", "format": 1, "transfer": "t1", "part": 0, "parts": 2,
            "set": { "format": 1, "items": { "pins": {}, "settings": { "x": { "updatedAt": 0, "value": 0 } } } } }),
            ),
        );
        assert_eq!(sync.values("spaces", &p1).len(), 2);
        assert!(sync.set(&p1).is_some_and(|s| s.items["pins"].is_empty()));
        assert_eq!(sync.values("settings", &p1)["x"], 1, "the held queue under it");
        assert_eq!(fx.kinds(), ["data.ack"], "no snapshot back");
        assert_eq!(body(&fx.send[0], "upTo"), 50);
        assert_eq!(acked(&mut sync, &p1), 50.0);
        let r = rev(&mut sync, &p1);
        assert!(body(&fx.send[0], "rev") == r.as_str() && r.starts_with("1-"));
        assert_eq!(
            fx.changed,
            [(p1.clone(), BTreeSet::from(["pins".into(), "settings".into(), "spaces".into()]))],
            "the app's UI told"
        );
        assert_eq!(fx.first_set, std::slice::from_ref(&p1));

        // ---- linked: changes both ways ----
        let fx = sync.received(&a, &msg("data.changes", json!({ "profile": "P1", "changes": [cj("spaces", "work", 60.0, Some(space("Job", 1))), cj("spaces", "personal", -5.0, Some(space("Old", 0)))] })));
        assert_eq!(fx.kinds(), ["data.changes", "data.ack"], "one older than the app's sent back, then ack");
        assert_eq!(body(&fx.send[0], "changes")[0]["id"], "personal");
        assert_eq!(body(&fx.send[0], "changes")[0]["updatedAt"], 0);
        assert_eq!(body(&fx.send[1], "upTo"), 60);
        assert_eq!(name(&mut sync, &p1, "spaces", "work").as_deref(), Some("Job"));
        let fx = sync.change(&p1, &[change("spaces", "personal", 70.0, Some(space("Home", 0)))]).expect("a set");
        assert_eq!(fx.kinds(), ["data.changes"], "the app's own change: stored and sent to the copy");
        assert_eq!(acked(&mut sync, &p1), 60.0);
        let fx = sync.change(&p1, &[change("spaces", "personal", 1.0, Some(space("Nope", 0)))]).expect("a set");
        assert!(fx.send.is_empty() && fx.changed.is_empty(), "one that loses: nothing sent");
        assert!(sync.change(&p2, &[change("spaces", "x", 1.0, Some(space("X", 0)))]).is_none(), "no set: refused");

        // ---- another profile ----
        let b = Link::new("safari", "P2", "e2");
        sync.link_up(&b);
        let fx = sync.received(
            &b,
            &msg(
                "data.changes",
                json!({ "profile": "P1", "changes": [cj("spaces", "work", 999.0, Some(space("Hijacked", 1)))] }),
            ),
        );
        assert!(fx.send.is_empty() && fx.log.iter().any(|n| n.warn), "a message naming another profile: refused");
        assert_eq!(name(&mut sync, &p1, "spaces", "work").as_deref(), Some("Job"));
        let fx = sync.received(
            &b,
            &msg(
                "data.changes",
                json!({ "profile": "P2", "changes": [cj("spaces", "work", 100.0, Some(space("P2 work", 0)))] }),
            ),
        );
        assert_eq!(fx.kinds(), ["data.need"], "changes before a set: the whole set asked for, the changes held");
        let fx = sync.received(&b, &msg("data.snapshot", json!({ "profile": "P2", "format": 1, "set": { "format": 1, "items": { "spaces": { "work": { "updatedAt": 90, "value": space("W", 0) } } } } })));
        assert_eq!(
            name(&mut sync, &p2, "spaces", "work").as_deref(),
            Some("P2 work"),
            "its snapshot with the held change on top"
        );
        assert!(fx.kinds() == ["data.ack"] && body(&fx.send[0], "upTo") == 100);
        assert!(
            name(&mut sync, &p1, "spaces", "work").as_deref() == Some("Job") && sync.values("spaces", &p1).len() == 2,
            "P1's untouched"
        );
        sync.received(&b, &msg("data.changes", json!({ "profile": "P2", "epoch": "e1", "changes": [cj("spaces", "work", 200.0, Some(space("other epoch", 0)))] })));
        assert_eq!(name(&mut sync, &p2, "spaces", "work").as_deref(), Some("P2 work"), "another epoch's message: left");

        // ---- relinking with a queue ----
        sync.link_down(&a);
        let a2 = Link::new("safari", "P1", "e3");
        sync.link_up(&a2);
        sync.received(
            &a,
            &msg(
                "data.changes",
                json!({ "profile": "P1", "changes": [cj("spaces", "work", 999.0, Some(space("Stale link", 1)))] }),
            ),
        );
        assert_eq!(name(&mut sync, &p1, "spaces", "work").as_deref(), Some("Job"), "a link gone: its messages left");
        let fx = sync.received(&a2, &msg("data.hello", json!({ "profile": "P1", "format": 1, "acked": 60, "queue": [cj("pins", "p1", 80.0, Some(json!({ "url": "https://p.test/" }))), cj("spaces", "work", 65.0, None)] })));
        let kinds = fx.kinds();
        assert!(
            kinds.last() == Some(&"data.ack") && kinds[..kinds.len() - 1].iter().all(|k| *k == "data.snapshot"),
            "{kinds:?}"
        );
        let back = assembled(&fx.send).expect("a snapshot");
        assert!(same(&back.0, &sync.set(&p1).expect("a set").to_json()), "the whole set sent back");
        assert_eq!(body(fx.send.last().expect("an ack"), "upTo"), 80);
        assert!(
            sync.set(&p1).is_some_and(|s| s.item("spaces", "work").is_some_and(DataItem::deleted)),
            "the deletion kept"
        );
        assert!(sync.values("pins", &p1).contains_key("p1") && sync.values("spaces", &p1).contains_key("personal"));
        let now = sync.set(&p1).expect("a set").to_json();
        let reread = test_store(root.path()).load(&p1).cloned().expect("on disk");
        assert!(same(&reread.set.to_json(), &now) && reread.acked == 80.0, "on disk too");

        // ---- the app's files older than what it confirmed ----
        let fx = sync.received(&a2, &msg("data.hello", json!({ "profile": "P1", "format": 1, "acked": 500, "queue": [cj("pins", "p2", 501.0, Some(json!({ "url": "https://q.test/" })))] })));
        assert_eq!(fx.kinds(), ["data.need"], "the copy confirmed more than the app's files have");
        let fx = sync.received(&a2, &msg("data.snapshot", json!({ "profile": "P1", "format": 1, "set": { "format": 1, "items": { "pins": { "p3": { "updatedAt": 400, "value": { "url": "https://r.test/" } } } } } })));
        assert_eq!(sync.values("pins", &p1).keys().collect::<Vec<_>>(), ["p1", "p2", "p3"]);
        assert!(sync.values("spaces", &p1).contains_key("personal"));
        assert!(fx.kinds().last() == Some(&"data.ack") && body(fx.send.last().expect("ack"), "upTo") == 501);
        assert!(same(&assembled(&fx.send).expect("sent back merged").0, &sync.set(&p1).expect("set").to_json()));
        assert_eq!(acked(&mut sync, &p1), 501.0);

        // ---- a wiped cache: acked 0, a queue of what's new ----
        let fx = sync.received(&a2, &msg("data.hello", json!({ "profile": "P1", "format": 1, "acked": 0, "queue": [cj("tabs", "t-new0000001", 600.0, Some(json!({ "url": "https://new.test/", "spaceId": "personal", "order": 0 })))] })));
        assert_eq!(assembled(&fx.send).map(|s| s.0["items"]["pins"].as_object().map(Map::len)), Some(Some(3)));
        assert!(
            sync.values("tabs", &p1).contains_key("t-new0000001") && body(fx.send.last().expect("ack"), "upTo") == 600
        );

        // ---- parts ----
        let mut big = DataSet::new();
        let mut changes: Vec<DataChange> = (0..60)
            .map(|n| {
                change(
                    "siteIcons",
                    &format!("https://site{n}.test"),
                    n as f64,
                    Some(json!({ "data": format!("data:image/png;base64,{}", "A".repeat(300)) })),
                )
            })
            .collect();
        changes.push(change("archive", "huge", 1.0, Some(json!({ "blob": "B".repeat(5000) }))));
        big.merge(&changes);
        big.items.insert("folders".into(), BTreeMap::new());
        let (parts, omitted) = DataSync::parts(&big, 2000);
        assert!(
            parts.len() > 5 && parts.iter().all(|p| json_len(&Value::Object(p.clone())) <= 2000),
            "a set in parts within the budget"
        );
        assert!(
            parts[0]["folders"].as_object().is_some_and(Map::is_empty)
                && parts[0].contains_key("siteIcons")
                && parts[0].contains_key("archive"),
            "every collection in the first"
        );
        assert_eq!(omitted, [("archive".to_string(), "huge".to_string())], "an item too big: left out, named");
        let icons: usize = parts.iter().filter_map(|p| p.get("siteIcons")?.as_object().map(Map::len)).sum();
        assert_eq!(icons, 60, "the parts add up to the set");
        let (batches, _) = DataSync::batches(&big.changes(), 3000);
        assert!(
            batches.len() > 5
                && batches.iter().all(|b| json_len(&Value::Array(b.clone())) <= 3000)
                && batches.iter().map(Vec::len).sum::<usize>() == 60
        );
        sync.part_bytes = 2000;
        let c = Link::new("safari", "P7", "e7");
        sync.link_up(&c);
        sync.store_mut().save(&sp("P7"), Stored::new(big, 0.0), None).expect("saved");
        let fx =
            sync.received(&c, &msg("data.hello", json!({ "profile": "P7", "format": 1, "acked": 0, "queue": [] })));
        assert!(assembled(&fx.send).is_some_and(|s| s.1 > 5));
        assert!(fx.send.iter().all(|o| json_len(&o.message) < 2300), "each under the budget plus its envelope");
        assert_eq!(body(&fx.send[0], "omitted"), json!([["archive", "huge"]]), "the left-out item named in part 0");
        sync.part_bytes = PART_BYTES;
        let huge = Link::new("safari", "P8", "e1");
        sync.link_up(&huge);
        let mut icons = DataSet::new();
        icons.merge(
            &(0..40)
                .map(|n| {
                    change("siteIcons", &format!("https://s{n}.test"), 1.0, Some(json!({ "data": "C".repeat(60_000) })))
                })
                .collect::<Vec<_>>(),
        );
        sync.store_mut().save(&sp("P8"), Stored::new(icons, 0.0), None).expect("saved");
        let fx =
            sync.received(&huge, &msg("data.hello", json!({ "profile": "P8", "format": 1, "acked": 0, "queue": [] })));
        let whole = assembled(&fx.send).expect("whole");
        assert!(
            whole.1 >= 3 && sync.unsent() == 0 && whole.0["items"]["siteIcons"].as_object().map(Map::len) == Some(40),
            "2.4 MB: in parts, none refused"
        );

        // ---- revisions: no snapshot for a copy that has the app's set ----
        sync.link_down(&a2);
        let a3 = Link::new("safari", "P1", "e4");
        sync.link_up(&a3);
        let fx =
            sync.received(&a3, &msg("data.hello", json!({ "profile": "P1", "format": 1, "acked": 600, "queue": [] })));
        let rev_now = rev(&mut sync, &p1);
        assert!(fx.kinds()[0] == "data.snapshot" && body(&fx.send[0], "rev") == rev_now.as_str());
        assert!(
            fx.kinds().last() == Some(&"data.ack") && body(fx.send.last().expect("ack"), "rev") == rev_now.as_str()
        );
        assert!(
            fx.send[1..fx.send.len() - 1].iter().all(|o| o.message.get("rev").is_none()),
            "only part 0 has the rev"
        );
        let fx = sync.received(
            &a3,
            &msg("data.hello", json!({ "profile": "P1", "format": 1, "acked": 600, "rev": rev_now, "queue": [] })),
        );
        assert!(
            fx.kinds() == ["data.ack"]
                && body(&fx.send[0], "rev") == rev_now.as_str()
                && rev(&mut sync, &p1) == rev_now,
            "the set's rev: only the ack"
        );
        let fx = sync.received(&a3, &msg("data.hello", json!({ "profile": "P1", "format": 1, "acked": 600, "rev": rev_now,
            "queue": [cj("pins", "p9", 700.0, Some(json!({ "url": "https://p9.test/" }))), cj("spaces", "personal", 2.0, Some(space("Older", 0)))] })));
        let rev_queued = rev(&mut sync, &p1);
        assert_eq!(fx.kinds(), ["data.changes", "data.ack"], "the change that lost answered, then the ack");
        assert!(body(&fx.send[0], "changes")[0]["id"] == "personal" && body(&fx.send[1], "upTo") == 700);
        assert!(
            body(&fx.send[1], "rev") == rev_queued.as_str()
                && rev_queued != rev_now
                && sync.values("pins", &p1).contains_key("p9")
        );
        let fx = sync.received(
            &a3,
            &msg(
                "data.hello",
                json!({ "profile": "P1", "format": 1, "acked": 700, "rev": "3-00000000ff", "queue": [] }),
            ),
        );
        assert!(
            fx.kinds()[0] == "data.snapshot" && fx.kinds().last() == Some(&"data.ack"),
            "a rev the app doesn't know: the snapshot"
        );
        let fx = sync.received(
            &a3,
            &msg(
                "data.changes",
                json!({ "profile": "P1", "changes": [cj("folders", "fb", 710.0, Some(json!({ "name": "B" })))] }),
            ),
        );
        let rev_changed = rev(&mut sync, &p1);
        assert!(
            fx.kinds() == ["data.ack"] && body(&fx.send[0], "rev") == rev_changed.as_str() && rev_changed != rev_queued,
            "in step: the ack has the new rev"
        );
        let fx = sync.change(&p1, &[change("folders", "fa", 720.0, Some(json!({ "name": "A" })))]).expect("a set");
        assert!(
            fx.kinds() == ["data.changes"]
                && fx.send[0].message.get("rev").is_none()
                && rev(&mut sync, &p1) != rev_changed,
            "the app's own: no rev"
        );
        let fx = sync.received(
            &a3,
            &msg("data.hello", json!({ "profile": "P1", "format": 1, "acked": 710, "rev": rev_changed, "queue": [] })),
        );
        assert!(
            fx.kinds()[0] == "data.snapshot"
                && same(&assembled(&fx.send).expect("set").0, &sync.set(&p1).expect("set").to_json()),
            "after an app-side change: the snapshot"
        );
        let unsynced = Link::new("safari", "P1", "e5");
        sync.link_down(&a3);
        sync.link_up(&unsynced);
        let fx = sync.received(
            &unsynced,
            &msg(
                "data.changes",
                json!({ "profile": "P1", "changes": [cj("folders", "fc", 730.0, Some(json!({ "name": "C" })))] }),
            ),
        );
        assert!(
            fx.kinds() == ["data.ack"] && fx.send[0].message.get("rev").is_none(),
            "no data.hello on this link: acked without a rev"
        );

        // ---- a write that fails: nothing confirmed ----
        let d = Link::new("safari", "P1", "e9");
        sync.link_down(&unsynced);
        sync.link_up(&d);
        sync.store_mut().crash_after_writes = Some(0);
        let fx = sync.received(
            &d,
            &msg(
                "data.changes",
                json!({ "profile": "P1", "changes": [cj("spaces", "personal", 9999.0, Some(space("Lost", 0)))] }),
            ),
        );
        assert!(fx.send.is_empty(), "a crash mid-write: no data.ack");
        let mut after = test_store(root.path());
        let s = after.load(&p1).expect("a set");
        assert!(
            s.set.live_values("spaces")["personal"]["name"] == "Home" && s.acked == 730.0,
            "the files as before it"
        );
    }

    #[test]
    fn odd_messages() {
        let root = temp();
        let mut sync = DataSync::new(test_store(root.path()));
        let a = Link::new("chrome", "p-1", "e1");
        assert!(
            sync.received(&a, &msg("data.hello", json!({ "format": 1, "acked": 0, "queue": [] }))).send.is_empty(),
            "not linked: left"
        );
        sync.link_up(&a);
        assert!(sync.received(&a, &json!([1])).send.is_empty());
        assert!(
            sync.received(&a, &msg("data.hello", json!({ "format": 2, "acked": 0, "queue": [] }))).send.is_empty(),
            "a later format: left"
        );
        assert!(sync.received(&a, &msg("data.what", json!({}))).send.is_empty());
        let fx = sync.received(&a, &msg("data.hello", json!({ "profile": 5, "format": 1 })));
        assert!(fx.send.is_empty(), "a profile that isn't a string: refused");
        let fx = sync.received(&a, &msg("data.hello", json!({ "format": 1, "acked": "x", "queue": "y" })));
        assert_eq!(fx.kinds(), ["data.need"], "what isn't a number or a list: 0 and none");
        let fx = sync.received(
            &a,
            &msg("data.snapshot", json!({ "format": 1, "set": { "format": 1, "items": {} }, "part": 3, "parts": 2 })),
        );
        assert!(fx.send.is_empty() && sync.set(&a.data_profile()).is_none(), "a part that doesn't add up: left");
        let fx = sync.received(&a, &msg("data.snapshot", json!({ "format": 1, "set": { "format": 2, "items": {} } })));
        assert!(fx.send.is_empty(), "a later format's set: left");
        // A new transfer starts the parts over.
        sync.received(&a, &msg("data.snapshot", json!({ "format": 1, "transfer": "t1", "part": 0, "parts": 2, "set": { "format": 1, "items": { "pins": { "old": { "updatedAt": 1, "value": 1 } } } } })));
        sync.received(&a, &msg("data.snapshot", json!({ "format": 1, "transfer": "t2", "part": 0, "parts": 2, "set": { "format": 1, "items": { "spaces": {} } } })));
        let fx = sync.received(&a, &msg("data.snapshot", json!({ "format": 1, "transfer": "t2", "part": 1, "parts": 2, "set": { "format": 1, "items": { "spaces": { "s": { "updatedAt": 2, "value": space("S", 0) } } } } })));
        assert_eq!(fx.kinds(), ["data.ack"]);
        let p = a.data_profile();
        assert!(
            sync.values("pins", &p).is_empty() && sync.values("spaces", &p).contains_key("s"),
            "the older transfer dropped"
        );
        // Over 1 MB: refused, counted.
        sync.part_bytes = 2_000_000;
        let fx = sync
            .change(&p, &[change("siteIcons", "big", 9.0, Some(json!("x".repeat(MAX_APP_MESSAGE))))])
            .expect("a set");
        assert!(fx.send.is_empty() && sync.unsent() == 1, "a data message from the app over 1 MB: refused");
    }

    #[test]
    fn margin_tabs_newest_first() {
        let root = temp();
        let mut sync = DataSync::new(test_store(root.path()));
        let p = sp("P1");
        let mut set = DataSet::new();
        set.merge(&[
            change("tabs", "t-b", 1.0, Some(json!({ "spaceId": "s1", "order": 2 }))),
            change("tabs", "t-a", 1.0, Some(json!({ "spaceId": "s1", "order": 2 }))),
            change("tabs", "t-c", 1.0, Some(json!({ "spaceId": "s2", "order": 5 }))),
            change("tabs", "t-d", 1.0, Some(json!({ "spaceId": "s1", "order": 1 }))),
            change("tabs", "t-x", 1.0, None),
            change("tabs", "t-y", 1.0, Some(json!("not an object"))),
        ]);
        sync.store_mut().save(&p, Stored::new(set, 0.0), None).expect("saved");
        let ids = |v: Vec<(String, Object)>| v.into_iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(ids(sync.margin_tabs(&p, None)), ["t-c", "t-a", "t-b", "t-d"]);
        assert_eq!(ids(sync.margin_tabs(&p, Some("s1"))), ["t-a", "t-b", "t-d"]);
        assert!(sync.margin_tabs(&sp("none"), None).is_empty());
        assert_eq!(sync.profiles(Some("safari")), [p]);
    }

    #[test]
    fn carried_over() {
        let root = temp();
        let mut sync = DataSync::new(test_store(root.path()));
        let clock = Arc::new(AtomicU64::new(5000f64.to_bits()));
        let c2 = clock.clone();
        sync.now = Box::new(move || f64::from_bits(c2.load(Ordering::SeqCst)));
        let (pa, pb) = (sp("s-aaaa"), sp("s-bbbb"));
        let seed = |sync: &mut DataSync, p: &DataProfile, changes: &[DataChange]| {
            let mut set = DataSet::new();
            set.merge(changes);
            sync.store_mut().save(p, Stored::new(set, 100.0), None).expect("seeded");
        };
        seed(
            &mut sync,
            &pa,
            &[
                change("spaces", "work", 100.0, Some(space("Deep Work", 0))),
                change("spaces", "side", 90.0, Some(space("Side", 1))),
                change("settings", "theme", 100.0, Some(json!("arcadia"))),
            ],
        );
        let old_dir = sync.store().directory(&pa);

        // ---- a hello before the browser's read: held, then carried over ----
        let b = Link::new("safari", "s-bbbb", "e1");
        sync.link_up(&b);
        let asked = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let asked2 = asked.clone();
        sync.before_need = Some(Box::new(move |p| {
            asked2.lock().map(|mut a| a.push(p.profile.clone())).ok();
            NeedChoice::Hold
        }));
        let fresh = json!([
            cj("spaces", "space1", 200.0, Some(space("Space 1", 0))),
            cj("settings", "theme", 300.0, Some(json!("neo")))
        ]);
        let fx = sync
            .received(&b, &msg("data.hello", json!({ "profile": "s-bbbb", "format": 1, "acked": 0, "queue": fresh })));
        assert!(
            fx.send.is_empty() && sync.holding() == [pb.clone()] && sync.set(&pb).is_none(),
            "held: nothing sent yet"
        );
        assert_eq!(asked.lock().map(|a| a.clone()).unwrap_or_default(), ["s-bbbb"]);
        assert_eq!(sync.next_hold_deadline(), Some(8000.0), "3 s on the clock");
        let a = Link::new("safari", "s-aaaa", "ea");
        sync.link_up(&a);
        assert!(sync.carry(&pa, &pb, "x").is_none(), "not from a linked profile");
        sync.link_down(&a);
        let fx = sync.received(&b, &msg("data.changes", json!({ "profile": "s-bbbb", "changes": [cj("pins", "pnew", 700.0, Some(json!({ "url": "https://new.test/" })))] })));
        assert!(fx.send.is_empty() && sync.set(&pb).is_none(), "a change while held: kept, nothing sent");
        let fx = sync.carry(&pa, &pb, "Safari profile X").expect("under way");
        assert!(
            sync.values("pins", &pb).contains_key("pnew")
                && fx.kinds().last() == Some(&"data.ack")
                && body(fx.send.last().expect("ack"), "upTo") == 700,
            "{:?}",
            fx.kinds()
        );
        assert_eq!(name(&mut sync, &pb, "spaces", "work").as_deref(), Some("Deep Work"));
        assert_eq!(sync.values("spaces", &pb).len(), 2);
        assert_eq!(sync.values("settings", &pb)["theme"], "arcadia");
        let s1 = sync.set(&pb).and_then(|s| s.item("spaces", "space1")).cloned().expect("a tombstone");
        assert!(s1.deleted() && s1.updated_at > 200.0, "the new copy's own defaults left out (deleted)");
        assert_eq!(sync.set(&pb).and_then(|s| s.item("settings", "theme")).map(|i| i.updated_at), Some(100.0));
        let kinds = fx.kinds();
        assert!(
            kinds.len() >= 3
                && kinds[kinds.len() - 2..] == ["data.ack", "data.ack"]
                && kinds[..kinds.len() - 2].iter().all(|k| *k == "data.snapshot"),
            "{kinds:?}"
        );
        assert!(
            assembled(&fx.send).is_some_and(|s| s.0["items"]["spaces"]["work"].is_object())
                && !kinds.contains(&"data.need")
        );
        assert!(
            sync.profiles(Some("safari")) == [pb.clone()] && !old_dir.exists() && sync.set(&pa).is_none(),
            "the old set put away"
        );
        assert_eq!(std::fs::read_dir(root.path().join("safari/.archived")).map(Iterator::count).unwrap_or(0), 1);
        assert!(fx.carried == [(pa.clone(), pb.clone(), "Safari profile X".to_string())] && sync.holding().is_empty());
        assert_eq!(acked(&mut sync, &pb), 700.0, "acked: the old set's, then the held change's");
        assert!(sync.carry(&pa, &pb, "x").is_none(), "again: nothing (the old set is gone)");

        // ---- the hold runs out: data.need, as without it ----
        sync.hold_for = 0.05;
        let c = Link::new("safari", "s-cccc", "e1");
        sync.link_up(&c);
        assert!(
            sync.received(&c, &msg("data.hello", json!({ "profile": "s-cccc", "format": 1, "acked": 0, "queue": [] })))
                .send
                .is_empty()
        );
        assert!(sync.tick().send.is_empty(), "not yet");
        clock.store(5100f64.to_bits(), Ordering::SeqCst);
        assert_eq!(sync.tick().kinds(), ["data.need"], "run out: data.need");
        sync.hold_for = 3.0;

        // ---- no read: data.need at once ----
        sync.before_need = None;
        let g = Link::new("safari", "s-gggg", "e1");
        sync.link_up(&g);
        assert_eq!(
            sync.received(&g, &msg("data.hello", json!({ "profile": "s-gggg", "format": 1, "acked": 0, "queue": [] })))
                .kinds(),
            ["data.need"]
        );

        // ---- after the new copy's first set: carried if it's untouched ----
        let (pe, pf, pd) = (sp("s-eeee"), sp("s-ffff"), sp("s-dddd"));
        seed(
            &mut sync,
            &pe,
            &[
                change("spaces", "home", 100.0, Some(space("Home E", 0))),
                change("pins", "pe", 100.0, Some(json!({ "url": "https://e.test/" }))),
            ],
        );
        let f = Link::new("safari", "s-ffff", "e1");
        sync.link_up(&f);
        assert_eq!(
            sync.received(&f, &msg("data.hello", json!({ "profile": "s-ffff", "format": 1, "acked": 0, "queue": [] })))
                .kinds(),
            ["data.need"]
        );
        let fx = sync.received(&f, &msg("data.snapshot", json!({ "profile": "s-ffff", "format": 1, "set": { "format": 1, "items": { "spaces": { "d1": { "updatedAt": 400, "value": space("Space 1", 0) } }, "pins": {} } } })));
        assert_eq!(fx.first_set, std::slice::from_ref(&pf));
        let mut sent = fx.send;
        let fx = sync.carry(&pe, &pf, "Safari profile Y").expect("carried after its first set");
        sent.extend(fx.send);
        assert_eq!(name(&mut sync, &pf, "spaces", "home").as_deref(), Some("Home E"));
        assert!(
            sync.set(&pf).is_some_and(|s| s.item("spaces", "d1").is_some_and(DataItem::deleted))
                && sync.values("pins", &pf).len() == 1
                && sync.set(&pe).is_none()
        );
        let kinds: Vec<&str> = sent.iter().map(Outgoing::kind).collect();
        assert!(
            kinds[0] == "data.ack" && kinds.last() == Some(&"data.ack") && kinds.contains(&"data.snapshot"),
            "{kinds:?}"
        );
        assert!(same(&assembled(&sent).expect("set").0, &sync.set(&pf).expect("set").to_json()));
        assert_eq!(body(sent.last().expect("ack"), "rev"), rev(&mut sync, &pf).as_str());
        // A copy that has sent changes since its first set: never.
        seed(&mut sync, &pe, &[change("spaces", "home", 100.0, Some(space("Home E", 0)))]);
        let d = Link::new("safari", "s-dddd", "e1");
        sync.link_up(&d);
        sync.received(&d, &msg("data.hello", json!({ "profile": "s-dddd", "format": 1, "acked": 0, "queue": [] })));
        sync.received(&d, &msg("data.snapshot", json!({ "profile": "s-dddd", "format": 1, "set": { "format": 1, "items": { "spaces": { "d1": { "updatedAt": 400, "value": space("Space 1", 0) } } } } })));
        assert!(rev(&mut sync, &pd).starts_with("1-"), "the first set is rev 1");
        sync.received(
            &d,
            &msg(
                "data.changes",
                json!({ "profile": "s-dddd", "changes": [cj("spaces", "d1", 500.0, Some(space("Mine", 0)))] }),
            ),
        );
        assert!(
            sync.carry(&pe, &pd, "x").is_none()
                && name(&mut sync, &pd, "spaces", "d1").as_deref() == Some("Mine")
                && sync.set(&pe).is_some()
        );
        // While its copy's snapshot is on its way: not yet.
        let h = Link::new("safari", "s-hhhh", "e1");
        sync.link_up(&h);
        sync.received(&h, &msg("data.hello", json!({ "profile": "s-hhhh", "format": 1, "acked": 0, "queue": [] })));
        assert!(sync.carry(&pe, &sp("s-hhhh"), "x").is_none(), "awaiting its copy's snapshot: not yet");

        // ---- the switch back: the old id links again, the set comes back ----
        sync.link_down(&b);
        let a2 = Link::new("safari", "s-aaaa", "e9");
        sync.link_up(&a2);
        let (pa2, pb2) = (pa.clone(), pb.clone());
        sync.before_need = Some(Box::new(move |p| {
            if *p == pa2 {
                NeedChoice::Carry { from: pb2.clone(), why: "Safari profile X".into() }
            } else {
                NeedChoice::Ask
            }
        }));
        let fx = sync.received(&a2, &msg("data.hello", json!({ "profile": "s-aaaa", "format": 1, "acked": 0, "queue": [cj("spaces", "space1b", 600.0, Some(space("Space 1", 0)))] })));
        assert_eq!(name(&mut sync, &pa, "spaces", "work").as_deref(), Some("Deep Work"));
        assert!(sync.set(&pa).is_some_and(|s| s.item("spaces", "space1b").is_some_and(DataItem::deleted)));
        assert!(
            fx.kinds().last() == Some(&"data.ack")
                && fx.kinds().contains(&"data.snapshot")
                && !fx.kinds().contains(&"data.need"),
            "{:?}",
            fx.kinds()
        );
        assert!(
            sync.set(&pb).is_none()
                && sync.profiles(Some("safari")).contains(&pa)
                && !sync.profiles(Some("safari")).contains(&pb)
        );
        assert_eq!(fx.carried.last().map(|c| (c.0.profile.as_str(), c.1.profile.as_str())), Some(("s-bbbb", "s-aaaa")));
    }
}
