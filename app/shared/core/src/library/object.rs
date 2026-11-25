//! The library object (docs/CORE-REFACTOR.md step 4 part 7): Library.swift's `Library` (L:89-286) over the store
//! (`LibraryStore`, data/library.rs) with the rules in the core. One per app; Windows uses it directly, the Mac through
//! margin-ffi's `margin_library_*`.
//!
//! - **Its state** is read from the store's set once per revision (`stateOf`, kept with the snapshot's text): a
//!   perform works on that state, a snapshot is the kept text. Only the object writes the set, so its own count of
//!   saves is the revision.
//! - **A perform** (L:205-227): the env asked of the host (`now` and the ids: Swift's `now` and `randomIds`), the
//!   action run, its changes timed at the host's `now` (asked again, as L:233), merged and stored, the host told the
//!   collections that changed (Swift's observers, in their order), the requests kept (the last 100) and each given to
//!   the sink (the session) at the point L:225 gave them to the delegate. With no sink the caller hands them on.
//! - **Re-entrant** as the session is: every entry takes `&self`, the state is in `Cell`/`RefCell`, and no borrow is
//!   held across a call out (the host's env, its clock, its observers, the sink), because a call out comes back in: an
//!   observer is Margin's window redrawing (a snapshot), a request handled by the session reads the library.
//! - **The import** once (L:249-276, [`Library::import_once`]): the sets and the person's order read by the caller
//!   ([`super::import::sources`]), the import's changes stored, its line said.
//! - [`call`]: library.js's entry (LT:939-952, `marginLibrary.call(name, argsJSON)`) over values given whole, the same
//!   functions with the same answers: the shared vectors run through it (with the platform's sorter in margin-ffi's
//!   tests).

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, VecDeque};
use std::rc::{Rc, Weak};

use serde_json::{Map, Value};

use super::actions::{self, ACTION_NAMES, Env, Outcome, Request};
use super::import::{self, Counts, ImportSet};
use super::js::{self, LocaleCompare};
use super::snapshot::{self, Parts};
use super::state::{self, LibState};
use super::values::Change;
use crate::data::Note;
use crate::data::library::{Applied, LibraryStore, key};

/// The requests kept (L:93 `requestsKept`).
pub const REQUESTS_KEPT: usize = 100;

/// What the library asks of the app around an edit (Library.swift's `now`, `randomIds` and `observe`).
pub trait LibraryHost {
    /// An action's env: the time (ms) and the ids to use first (L:206: `now()` and 4 random letters; a test's own).
    fn env(&self) -> Env;
    /// The time (ms) an edit's changes are stored at (L:233's second read of `now`).
    fn now(&self) -> f64;
    /// The collections an edit changed, once they're stored (L:238: every observer, in their order). Free to call back
    /// in.
    fn changed(&self, collections: &BTreeSet<String>);
}

/// Who handles the library's requests (the session: HostedSession's `library(_:wants:)`, the session's
/// `library_request`), given each one inside the perform that made it. Free to call back in.
pub trait RequestSink {
    fn request(&self, request: &Request);
}

/// A perform's outcome as Library.swift's `LibraryOutcome` has it: the rules' (`ok`, `result`, `error`, the changes,
/// the requests) and the collections the store changed.
#[derive(Clone, Debug, PartialEq)]
pub struct Performed {
    pub outcome: Outcome,
    pub changed: BTreeSet<String>,
}

impl Performed {
    /// `{ ok, result, error?, changed, requests }` (the facade's).
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("ok".into(), Value::Bool(self.outcome.ok));
        o.insert("result".into(), self.outcome.result.clone());
        if let Some(e) = &self.outcome.error {
            o.insert("error".into(), Value::String(e.clone()));
        }
        o.insert("changed".into(), Value::Array(self.changed.iter().map(|c| Value::String(c.clone())).collect()));
        o.insert("requests".into(), Value::Array(self.outcome.requests.iter().cloned().map(Value::Object).collect()));
        Value::Object(o)
    }
}

/// The state read at a revision of the set, and what's made of it once (part 6's `Cached`).
struct Cached {
    rev: u64,
    state: Rc<LibState>,
    imported: bool,
    snapshot: Option<Rc<Parts>>,
}

pub struct Library {
    store: RefCell<LibraryStore>,
    host: Box<dyn LibraryHost>,
    compare: Box<dyn LocaleCompare>,
    sink: RefCell<Option<Weak<dyn RequestSink>>>,
    /// The object's saves of the set (only it writes it): the cache's key.
    rev: Cell<u64>,
    cached: RefCell<Option<Cached>>,
    requests: RefCell<VecDeque<Request>>,
    log: RefCell<Vec<Note>>,
}

impl Library {
    /// The library over its store (`LibraryStore` over a flat `DataStore`), the host's env and observers, and the
    /// system's sorter for `localeCompare` (the Mac's libicucore, Windows' icu.dll).
    pub fn new(store: LibraryStore, host: Box<dyn LibraryHost>, compare: Box<dyn LocaleCompare>) -> Library {
        Library {
            store: RefCell::new(store),
            host,
            compare,
            sink: RefCell::new(None),
            rev: Cell::new(0),
            cached: RefCell::new(None),
            requests: RefCell::new(VecDeque::new()),
            log: RefCell::new(Vec::new()),
        }
    }

    /// Who handles the requests from now on (the session), held weakly: it holds the library.
    pub fn set_sink(&self, sink: Option<Weak<dyn RequestSink>>) {
        *self.sink.borrow_mut() = sink;
    }

    pub fn compare(&self) -> &dyn LocaleCompare {
        &*self.compare
    }

    // ---- reading ----

    /// The state at the set's revision now (read once per revision).
    pub fn state(&self) -> Rc<LibState> {
        self.cached(|c| c.state.clone())
    }

    fn cached<T>(&self, f: impl FnOnce(&mut Cached) -> T) -> T {
        let rev = self.rev.get();
        let mut cached = self.cached.borrow_mut();
        if cached.as_ref().is_none_or(|c| c.rev != rev) {
            let mut store = self.store.borrow_mut();
            let (state, imported) = match store.store_mut().load(&key()) {
                Some(stored) => (state::state_of(&stored.set, &*self.compare), state::is_imported(&stored.set)),
                None => (state::state_of(&Map::new(), &*self.compare), false),
            };
            *cached = Some(Cached { rev, state: Rc::new(state), imported, snapshot: None });
        }
        f(cached.as_mut().expect("just made"))
    }

    /// What the UI draws (LT:839 `snapshot`, L:142), as its text with its places for a window's state: made once per
    /// revision.
    pub fn snapshot(&self) -> Rc<Parts> {
        self.cached(|c| c.snapshot.get_or_insert_with(|| Rc::new(Parts::of(&c.state, c.imported))).clone())
    }

    /// What a Margin window draws (step 4 part 6): the kept snapshot with the session's open items as tabs (`open`,
    /// the session's `live_plan`, asked with [`Library::keeps`]) and the profile's settings and icons (`tail`), as
    /// [`Parts::state_text`] writes it. The session's own is [`crate::session::Session::state_text`].
    pub fn state_text(&self, open: Option<(i64, &[crate::session::LiveRow])>, tail: &str) -> String {
        let (state, parts) = self.cached(|c| {
            let parts = c.snapshot.get_or_insert_with(|| Rc::new(Parts::of(&c.state, c.imported))).clone();
            (c.state.clone(), parts)
        });
        parts.state_text(&state, open, tail)
    }

    /// Whether the snapshot keeps an item as a tab in a space (the session's `live_plan` asks it of each open item).
    pub fn keeps(&self, item: &str) -> bool {
        self.cached(|c| c.state.kept.contains_key(item))
    }

    /// The theme of the space a Margin window shows (MarginWindowController `spaceTheme` until step 4's commit 7): its
    /// space's (`activeSpaceByWindow`), else the first space's (a window with none of its own, or one gone, shows the
    /// first: state/model.ts activeSpaceId); None: no spaces, or that space has no theme of its own (the profile's).
    pub fn space_theme(&self, window: i64) -> Option<Rc<str>> {
        self.cached(|c| {
            let s = &c.state;
            let id = s.windows.get(&window.to_string());
            let space = s.spaces.iter().find(|sp| Some(&sp.id) == id).or_else(|| s.spaces.first())?;
            space.theme.clone()
        })
    }

    /// The appearance of the space a Margin window shows (M2.9 step 3: its web view's, MarginWindowController), the
    /// space as [`Self::space_theme`] finds it: its background's when that's `light` or `dark`; None (the system's): no
    /// spaces, no background, or one that follows the system (`auto`).
    pub fn space_appearance(&self, window: i64) -> Option<&'static str> {
        self.cached(|c| {
            let s = &c.state;
            let id = s.windows.get(&window.to_string());
            let space = s.spaces.iter().find(|sp| Some(&sp.id) == id).or_else(|| s.spaces.first())?;
            space.background.as_ref().map(|b| b.appearance).filter(|a| *a == "light" || *a == "dark")
        })
    }

    /// The import ran (L:126 `isImported`: `imports.done` is there).
    pub fn is_imported(&self) -> bool {
        self.cached(|c| c.imported)
    }

    /// One live item's value by its id (the session's reads: a lookup, never a collection built).
    pub fn item(&self, collection: &str, id: &str) -> Option<Value> {
        self.store.borrow_mut().item(collection, id)
    }

    /// A collection's live values (`{ id: value }`).
    pub fn live(&self, collection: &str) -> Map<String, Value> {
        self.store.borrow_mut().live(collection)
    }

    /// Every collection's live values (`{ collection: { id: value } }`).
    pub fn values(&self) -> Map<String, Value> {
        self.store.borrow_mut().values()
    }

    /// The requests made, oldest first (the last 100).
    pub fn requests(&self) -> Vec<Request> {
        self.requests.borrow().iter().cloned().collect()
    }

    /// The actions [`Library::perform`] takes (LT:810).
    pub fn actions() -> &'static [&'static str] {
        &ACTION_NAMES
    }

    /// The store's lines and the library's own since the last call.
    pub fn take_log(&self) -> Vec<Note> {
        let mut log = std::mem::take(&mut *self.log.borrow_mut());
        log.extend(self.store.borrow_mut().take_log());
        log
    }

    /// The saves written since (the writer's wake): what the log says (a failed one).
    pub fn written(&self) -> Vec<Note> {
        self.store.borrow_mut().written()
    }

    /// The set's revision as the store writes it (`rev`), None: never stored.
    pub fn stored_rev(&self) -> Option<String> {
        self.store.borrow_mut().store_mut().load(&key()).map(|s| s.rev.clone())
    }

    // ---- editing ----

    /// One action with its payload (L:205 `perform`): the rules on the state now, the changes stored, the observers
    /// told, then the requests kept and given to the sink, each in turn. A failure changes nothing and asks nothing.
    pub fn perform(&self, action: &str, payload: &Value) -> Performed {
        let state = self.state();
        let env = self.host.env();
        let outcome = actions::perform(&state, action, payload, env, &*self.compare);
        drop(state);
        if !outcome.ok {
            return Performed { outcome, changed: BTreeSet::new() };
        }
        let changed = self.commit(&outcome.changes);
        {
            let mut kept = self.requests.borrow_mut();
            for r in &outcome.requests {
                kept.push_back(r.clone());
            }
            while kept.len() > REQUESTS_KEPT {
                kept.pop_front();
            }
        }
        let sink = self.sink.borrow().as_ref().and_then(Weak::upgrade);
        if let Some(sink) = sink {
            for r in &outcome.requests {
                sink.request(r);
            }
        }
        Performed { outcome, changed }
    }

    /// The rules' changes stored (L:230 `apply`): timed at the host's now, merged, the cache's revision moved on, then
    /// the observers told. The collections changed (none: nothing told).
    fn commit(&self, changes: &[Change]) -> BTreeSet<String> {
        if changes.is_empty() {
            return BTreeSet::new();
        }
        let entries: Vec<Value> = changes.iter().map(Change::to_json).collect();
        let at = self.host.now();
        let applied = self.apply(&entries, at);
        if !applied.changed.is_empty() {
            self.host.changed(&applied.changed);
        }
        applied.changed
    }

    /// Entries (`{ collection, id, value }` or `{ …, deleted: true }`) stored at `at` as they are, no rule run and no
    /// observer told (the store's own `apply`: the tests' libraries made as given).
    pub fn apply(&self, entries: &[Value], at: f64) -> Applied {
        let applied = self.store.borrow_mut().apply(entries, at);
        if !applied.changed.is_empty() {
            self.rev.set(self.rev.get() + 1);
        }
        applied
    }

    /// The import, once (L:249 `importOnce`): the sets and the person's order (each `[browser, profile, space]`,
    /// [`import::sources`]) into the library, its marker in the same save, the counts' line said. None: it had run
    /// already.
    pub fn import_once(&self, sets: &[ImportSet], order: &[(String, String, String)]) -> Option<Counts> {
        if self.is_imported() {
            return None;
        }
        let current = self.values();
        let now = self.host.now();
        let (changes, counts) = import::import_changes(&current, sets, order, now, &*self.compare);
        self.commit(&changes);
        let mut said: Vec<(&str, u32)> = counts.entries().to_vec();
        said.sort_by_key(|(k, _)| *k);
        let said: Vec<String> = said.iter().map(|(k, n)| format!("{k} {n}")).collect();
        self.log.borrow_mut().push(Note::note(format!(
            "library: imported {} profile set(s): {}",
            sets.len(),
            said.join(", ")
        )));
        Some(counts)
    }
}

impl crate::session::LibraryView for Library {
    fn item(&self, collection: &str, id: &str) -> Option<Value> {
        Library::item(self, collection, id)
    }
    fn collection(&self, collection: &str) -> Map<String, Value> {
        self.live(collection)
    }
}

/// The session's edits (step 4 part 7): the perform, its requests given to the sink inside it, the outcome as the
/// session reads it (a refusal with no words: "refused", as Library.swift's `LibraryOutcome` had it).
impl crate::session::LibraryEdit for Library {
    fn perform(&self, action: &str, payload: &Map<String, Value>) -> crate::session::Performed {
        Library::perform(self, action, &Value::Object(payload.clone())).session()
    }
}

impl Performed {
    /// The outcome as the session reads it (`ok`, `result`, `error`).
    pub fn session(&self) -> crate::session::Performed {
        let o = &self.outcome;
        crate::session::Performed {
            ok: o.ok,
            result: if o.ok { o.result.clone() } else { Value::Null },
            error: (!o.ok).then(|| o.error.clone().unwrap_or_else(|| "refused".into())),
        }
    }
}

// ---- library.js's entry ----------------------------------------------------------------------------------------------

/// LT:939 `call(name, args)`: one of library.js's functions (`perform`, `snapshot`, `importValues`, `actions`) on the
/// JSON arguments it's given, its answer as LT's text (`{ value }`, or `{ error }`), each value of the shape LT's
/// function gives (a failed perform has no `result`). The values are read as given, the ids in their order.
pub fn call(name: &str, args: &str, compare: &dyn LocaleCompare) -> String {
    let list = match serde_json::from_str::<Value>(args) {
        Ok(Value::Array(list)) => list,
        Ok(_) => Vec::new(),
        Err(e) => return error(&e.to_string()),
    };
    let arg = |i: usize| list.get(i).unwrap_or(&Value::Null);
    let empty = Map::new();
    let values = |i: usize| arg(i).as_object().unwrap_or(&empty);
    let value = match name {
        "perform" => {
            let payload = list.get(2).cloned().unwrap_or_else(|| Value::Object(Map::new()));
            let s = state::state_of(values(0), compare);
            let out = actions::perform(&s, arg(1).as_str().unwrap_or("undefined"), &payload, env_of(arg(3)), compare);
            outcome_json(&out)
        }
        "snapshot" => {
            return format!("{{\"value\":{}}}", snapshot::snapshot(values(0), compare));
        }
        "importValues" => {
            let sets: Vec<ImportSet> =
                arg(1).as_array().map(|l| l.iter().filter_map(ImportSet::from_json).collect()).unwrap_or_default();
            let order: Vec<(String, String, String)> = arg(2)
                .as_array()
                .map(|l| {
                    l.iter()
                        .filter_map(|e| {
                            let e = e.as_array()?;
                            let part =
                                |i: usize| e.get(i).map_or_else(|| "undefined".into(), |v| js::to_string(v).into());
                            Some((part(0), part(1), part(2)))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let now = js::finite(arg(3).get("now")).unwrap_or(0.0);
            let (changes, counts) = import::import_changes(values(0), &sets, &order, now, compare);
            let mut o = Map::new();
            o.insert("changes".into(), Value::Array(changes.iter().map(Change::to_json).collect()));
            o.insert("counts".into(), counts.to_json());
            Value::Object(o)
        }
        "actions" => Value::Array(ACTION_NAMES.iter().map(|&n| Value::String(n.into())).collect()),
        other => return error(&format!("no function {other}")),
    };
    let mut o = Map::new();
    o.insert("value".into(), value);
    Value::Object(o).to_string()
}

fn error(words: &str) -> String {
    let mut o = Map::new();
    o.insert("error".into(), Value::String(words.into()));
    Value::Object(o).to_string()
}

/// `env` as LT reads it (`finite(env?.now)`, `idMaker(env)`): an id that isn't a string is used up as one that
/// doesn't pass.
fn env_of(v: &Value) -> Env {
    let ids = v
        .get("ids")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |l| l.iter().map(|id| id.as_str().map_or_else(String::new, str::to_owned)).collect());
    Env { now: js::finite(v.get("now")).unwrap_or(0.0), ids }
}

/// LT:816's answer: `{ ok, result, changes, requests }`, a failure `{ ok, error, changes, requests }`.
fn outcome_json(out: &Outcome) -> Value {
    let mut v = out.to_json();
    if let Value::Object(o) = &mut v
        && !out.ok
    {
        o.remove("result");
    }
    v
}

#[cfg(test)]
#[path = "object_tests.rs"]
mod tests;
