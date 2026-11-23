//! The session (docs/CORE-REFACTOR.md step 3; HostedSession.swift, HostedPeek.swift): the library's items shown in
//! Margin's windows, its flows as Rust `async fn`s, the same on every OS. One object per app, sans IO:
//!
//! - **Ports** (synchronous, answered during the call): what the session reads of the engine, Margin's windows, the
//!   copies' links and the OS, and the clock ([`Ports`]). The Mac's are C callbacks into Swift (margin-ffi
//!   session.rs); Windows implements them in Rust over its adapter.
//! - **Commands** (asynchronous): what a flow awaits, handed out in the answer's `start` and answered by id
//!   ([`Session::answer`]): a copy's request, a library edit (answered in the same turn), a Swift job's turn.
//! - **The library**'s values read straight from its set ([`LibraryView`]: one item by id, never a collection built).
//! - **Inputs** ([`Session::input`]): what happens outside (a request, a window's event, an option changed), and the
//!   Swift facade's reads and writes of the state still shared with Swift flows.
//! - **Time**: the caller's clock through its port; sleeps are deadlines, the earliest in every answer, the caller's
//!   one timer ticks ([`Session::tick`]).
//! - **Log lines** are built here word for word, the last 200 kept (`done`, which the tests read).
//!
//! Re-entrant like the Swift class: every entry takes `&self`, the state is in `Cell`/`RefCell`, no borrow is held
//! across a port call or an await (computed, dropped, then called out), and a call made while the session is
//! already in one (a port's callback calling back in) only changes state and queues tasks: the outer call runs them.
//!
//! Its pure rules (step 3's commit 1), one module each by the part of the design they belong to: a split's room and a
//! drag's line (`layout`), the preview card's rect and a web address (`card`), a web item's profile (`choice`), the
//! item a window showed last and its loader's app (`start`), an item's target (`target`), a search's address (`ui`),
//! the copies' pushes for the page (`push`).

#![deny(clippy::await_holding_refcell_ref)]

pub mod card;
pub mod choice;
mod exec;
pub mod host_id;
pub mod layout;
mod navigate;
pub mod push;
pub mod start;
pub mod state;
pub mod target;
#[cfg(test)]
mod tests;
pub mod ui;
mod unicode;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, VecDeque};
use std::rc::{Rc, Weak};

use serde_json::{Map, Value, json};

use crate::hosted_browser::Role;
use crate::json::{self, Object};
use exec::Exec;
pub use state::{Field, OpenItem, State};

/// The log lines kept (HostedSession `done`).
pub const DONE_KEPT: usize = 200;

/// What the session reads synchronously, answered during the call (HostedSession's protocols' synchronous members:
/// HostedEngine's reads, HostedWindow, HostedLinks' reads, the OS's). Called with no borrow of the session held: an
/// implementation may call back into it.
pub trait Ports {
    /// The monotonic clock, seconds (`ProcessInfo.systemUptime`; a test's own).
    fn now(&self) -> f64;
    /// A Margin window by its id, or (None) the one in front: its id; None: there's none.
    fn window(&self, id: Option<i64>) -> Option<i64>;
    /// Every Margin window's id.
    fn window_ids(&self) -> Vec<i64>;
    /// The engine's host shown in Margin's Space (`HostedEngine.shown`).
    fn engine_shown(&self) -> Option<String>;
    /// Whether the engine hosts it (`HostedEngine.isHosted`).
    fn is_hosted(&self, host: &str) -> bool;
    /// The Safari copies linked now (`HostedLinks.safariProfiles`).
    fn safari_profiles(&self) -> Vec<String>;
    /// The epoch of a profile's link now (`HostedLinks.linkEpoch`), None: not linked.
    fn link_epoch(&self, profile: &str) -> Option<String>;
    /// An installed app's name, the catalog's (`HostedSession.appName`).
    fn app_name(&self, bundle: &str) -> Option<String>;
}

/// The library's values as its set has them now (Library.swift's reads over margin-core's `LibraryStore`).
pub trait LibraryView {
    /// A live item of a collection by its id (`liveValues(collection)[id]`); None: none, or deleted.
    fn item(&self, collection: &str, id: &str) -> Option<Value>;
}

/// What a flow awaits, handed out by id.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// A request of a profile's copy (`HostedLinks.request`): answered `{ result }` or `{ error }`, in the Swift's
    /// words ("not linked", the scrubbed refusal, the thrown error).
    Ask { profile: String, kind: String, payload: Object },
    /// A library edit (`Library.perform`), answered in the same turn `{ ok, result, error }`: its requests reach the
    /// session (re-entrantly, as the Library's delegate) before the flow goes on.
    Perform { action: String, payload: Object },
    /// A Swift job of the session's queue (HostedSession `enqueue`'s body), its turn come: answered when it's over.
    Run { job: u64 },
}

impl Command {
    pub fn to_json(&self, id: u64) -> Value {
        match self {
            Command::Ask { profile, kind, payload } => {
                json!({ "op": "ask", "id": id, "profile": profile, "kind": kind, "payload": payload })
            }
            Command::Perform { action, payload } => {
                json!({ "op": "perform", "id": id, "action": action, "payload": payload })
            }
            Command::Run { job } => json!({ "op": "run", "id": id, "job": job }),
        }
    }
}

/// A copy's answer to an `Ask`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Asked {
    pub result: Option<Object>,
    pub error: Option<String>,
}

impl Asked {
    pub fn read(v: &Value) -> Asked {
        Asked {
            result: v.get("result").and_then(Value::as_object).cloned(),
            error: v.get("error").and_then(Value::as_str).map(str::to_string),
        }
    }
}

/// A library edit's outcome (`LibraryOutcome`: its `ok`, its `result`, its `error`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Performed {
    pub ok: bool,
    pub result: Value,
    pub error: Option<String>,
}

impl Performed {
    pub fn read(v: &Value) -> Performed {
        Performed {
            ok: v.get("ok").and_then(Value::as_bool) == Some(true),
            result: v.get("result").cloned().unwrap_or(Value::Null),
            error: v.get("error").and_then(Value::as_str).map(str::to_string),
        }
    }
}

/// A line for the app's log (Diagnostics).
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub warn: bool,
    pub text: String,
}

/// A call's answer: the commands its run handed out (start each at once, in order, then `tick`), whether tasks are
/// ready to run (an input's: `tick` once the caller's code that made them is over, as a main-actor `Task` starts after
/// the code that made it), the earliest deadline, the log lines since the last answer, and a read's reply or a bad
/// input's error.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Out {
    pub start: Vec<(u64, Command)>,
    pub ready: bool,
    pub deadline: Option<f64>,
    pub log: Vec<Line>,
    pub reply: Option<Value>,
    pub error: Option<String>,
}

impl Out {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        if !self.start.is_empty() {
            o.insert("start".into(), Value::Array(self.start.iter().map(|(id, c)| c.to_json(*id)).collect()));
        }
        if self.ready {
            o.insert("ready".into(), true.into());
        }
        o.insert("deadline".into(), self.deadline.and_then(crate::protocol::number).unwrap_or(Value::Null));
        if !self.log.is_empty() {
            let log = self.log.iter().map(|l| json!({ "warn": l.warn, "text": l.text })).collect();
            o.insert("log".into(), Value::Array(log));
        }
        if let Some(r) = &self.reply {
            o.insert("reply".into(), r.clone());
        }
        if let Some(e) = &self.error {
            o.insert("error".into(), e.as_str().into());
        }
        Value::Object(o)
    }
}

/// The options the session's flows read (HostedSession `Options`, the Swift struct: sent whole on each change).
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    /// A wait's step (`every`).
    pub every: f64,
}

impl Default for Options {
    fn default() -> Self {
        Options { every: 0.05 }
    }
}

impl Options {
    fn read(v: &Value, was: &Options) -> Options {
        Options { every: json::num(v.get("every")).unwrap_or(was.every) }
    }
}

/// What happens outside, and the facade's reads and writes.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// The options changed (the Swift struct's every field).
    Options(Value),
    /// The facade's read of fields (`get`) and its edit of them (`set`: each field's `put` and `del`).
    State { get: Vec<String>, set: Option<Object> },
    /// A Swift flow's log line.
    Note(String),
    /// A Swift job enqueued (its body the facade's, run when its turn comes).
    Enqueue { job: u64 },
    /// The page's history for the item shown in a Margin window (`goBack`, `goForward`, `reload`).
    Navigate { kind: String, window: Option<i64> },
}

impl Input {
    pub fn read(v: &Value) -> Result<Input, String> {
        let o = v.as_object().ok_or("not an object")?;
        let s = |k: &str| o.get(k).and_then(Value::as_str);
        match s("type").unwrap_or("") {
            "options" => Ok(Input::Options(o.get("options").cloned().unwrap_or(Value::Null))),
            "state" => Ok(Input::State {
                get: json::array(o.get("get"))
                    .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default(),
                set: json::object(o.get("set")).cloned(),
            }),
            "note" => Ok(Input::Note(s("line").ok_or("a note with no line")?.to_string())),
            "enqueue" => Ok(Input::Enqueue { job: o.get("job").and_then(Value::as_u64).ok_or("no job")? }),
            "navigate" => Ok(Input::Navigate {
                kind: s("kind").ok_or("no kind")?.to_string(),
                window: json::int(o.get("window")),
            }),
            other => Err(format!("{other:?} isn't an input")),
        }
    }

    fn kind(v: &Value) -> String {
        v.get("type").and_then(Value::as_str).unwrap_or("?").to_string()
    }
}

/// A whole number as Swift's `int(_:)` reads JSONSerialization's numbers (LinkMessage.swift): a number (never a bool)
/// that's whole, under 9e15 either way.
pub(crate) fn swift_int(v: Option<&Value>) -> Option<i64> {
    let d = json::num(v)?;
    (d.round() == d && d.abs() < 9e15).then_some(d as i64)
}

pub(crate) struct Core {
    me: Weak<Core>,
    ports: Box<dyn Ports>,
    library: Box<dyn LibraryView>,
    exec: Exec,
    state: RefCell<State>,
    revs: [Cell<u64>; Field::COUNT],
    done: RefCell<VecDeque<String>>,
    log: RefCell<Vec<Line>>,
    options: RefCell<Options>,
    errors_said: RefCell<BTreeSet<String>>,
    depth: Cell<u32>,
}

/// The session: one per app. Every entry takes `&self` (re-entrant).
pub struct Session(Rc<Core>);

impl Drop for Session {
    fn drop(&mut self) {
        // (The tasks hold the session; let them go so it goes.)
        self.0.exec.clear();
    }
}

impl Session {
    pub fn new(ports: Box<dyn Ports>, library: Box<dyn LibraryView>, options: &Value) -> Session {
        let options = Options::read(options, &Options::default());
        Session(Rc::new_cyclic(|me| Core {
            me: me.clone(),
            ports,
            library,
            exec: Exec::default(),
            state: RefCell::default(),
            revs: Default::default(),
            done: RefCell::default(),
            log: RefCell::default(),
            options: RefCell::new(options),
            errors_said: RefCell::default(),
            depth: Cell::new(0),
        }))
    }

    /// An input (`{ type, … }`); a bad one is an `error`, logged once a kind. What it makes ready doesn't run in
    /// the call (`ready`: the caller ticks once its own code is over).
    pub fn input(&self, input: &Value) -> Out {
        self.0.call(false, |c| match Input::read(input) {
            Ok(i) => c.input(i),
            Err(why) => {
                c.refused(&Input::kind(input), &why);
                (None, Some(format!("bad input: {why}")))
            }
        })
    }

    /// A command's answer (its id from `start`): its task goes on. One no task waits for is let go.
    pub fn answer(&self, id: u64, answer: Value) -> Out {
        self.0.call(true, |c| {
            c.exec.answer(id, answer);
            (None, None)
        })
    }

    /// The commands handed out are started, and the deadlines up to `due` are over (the caller's timer, at the
    /// earliest deadline: the later of its clock and that deadline; 0 to say the commands are started, or to run
    /// what an input made ready); then what's ready runs.
    pub fn tick(&self, due: f64) -> Out {
        self.0.call(true, |c| {
            c.exec.release();
            c.exec.tick(due);
            (None, None)
        })
    }

    /// The log lines kept, oldest first.
    pub fn done(&self) -> Vec<String> {
        self.0.done.borrow().iter().cloned().collect()
    }

    /// Nothing enqueued is left to do.
    pub fn idle(&self) -> bool {
        self.0.exec.idle()
    }

    /// A field's revision (a change of it since: read it again).
    pub fn rev(&self, f: Field) -> u64 {
        self.0.revs[f as usize].get()
    }

    #[cfg(test)]
    fn core(&self) -> &Rc<Core> {
        &self.0
    }
}

impl Core {
    fn rc(&self) -> Option<Rc<Core>> {
        self.me.upgrade()
    }

    /// One entry: what it does, then (`run`, the outermost call only) what's ready runs, then its answer.
    fn call(&self, run: bool, f: impl FnOnce(&Core) -> (Option<Value>, Option<String>)) -> Out {
        let depth = self.depth.get() + 1;
        self.depth.set(depth);
        let (reply, error) = f(self);
        if run && depth == 1 {
            self.exec.run();
        }
        self.depth.set(depth - 1);
        Out {
            start: if depth == 1 { self.exec.take_started() } else { Vec::new() },
            ready: self.exec.has_ready(),
            deadline: self.exec.deadline(),
            log: std::mem::take(&mut *self.log.borrow_mut()),
            reply,
            error,
        }
    }

    fn input(&self, input: Input) -> (Option<Value>, Option<String>) {
        match input {
            Input::Options(v) => {
                let next = Options::read(&v, &self.options.borrow());
                *self.options.borrow_mut() = next;
            }
            Input::State { get, set } => {
                let mut bad = 0;
                if let Some(set) = set {
                    for (name, edit) in &set {
                        let (f, n) = self.state.borrow_mut().edit(name, edit);
                        bad += n;
                        if let Some(f) = f {
                            self.bump(f);
                        }
                    }
                }
                if bad > 0 {
                    self.refused("state", &format!("{bad} entr(ies) not one"));
                }
                let mut reply = Map::new();
                let state = self.state.borrow();
                for name in &get {
                    let f = match name.as_str() {
                        "shown" => Field::Shown,
                        "open" => Field::Open,
                        "safariWindows" => Field::SafariWindows,
                        _ => continue,
                    };
                    reply.insert(name.clone(), state.field_json(f));
                }
                drop(state);
                reply.insert("revs".into(), json!(self.revs.iter().map(Cell::get).collect::<Vec<_>>()));
                return (Some(Value::Object(reply)), None);
            }
            Input::Note(line) => self.note(line),
            Input::Enqueue { job } => {
                if let Some(c) = self.rc() {
                    self.exec.enqueue(async move {
                        c.exec.command(Command::Run { job }, false).await;
                    });
                }
            }
            Input::Navigate { kind, window } => self.navigate(&kind, window),
        }
        (None, None)
    }

    fn bump(&self, f: Field) {
        let r = &self.revs[f as usize];
        r.set(r.get() + 1);
    }

    /// A bad input or edit, said once a kind.
    fn refused(&self, kind: &str, why: &str) {
        if self.errors_said.borrow_mut().insert(kind.to_string()) {
            let text = format!("session: a {kind} input refused: {why} (said once a kind)");
            self.log.borrow_mut().push(Line { warn: true, text });
        }
    }

    /// A line of what was done (HostedSession `note`): kept (the last 200) and logged.
    pub(crate) fn note(&self, line: String) {
        self.log.borrow_mut().push(Line { warn: false, text: format!("hosted: {line}") });
        let mut done = self.done.borrow_mut();
        done.push_back(line);
        while done.len() > DONE_KEPT {
            done.pop_front();
        }
        drop(done);
        self.bump(Field::Done);
    }

    // ---- the state's reads (each borrow dropped before it returns) ----

    pub(crate) fn shown_in(&self, window: i64) -> Option<String> {
        self.state.borrow().shown.get(&window).cloned()
    }

    pub(crate) fn open_item(&self, item: &str) -> Option<OpenItem> {
        self.state.borrow().open.get(item).cloned()
    }

    pub(crate) fn safari_window(&self, profile: &str, role: Role) -> Option<i64> {
        self.state.borrow().safari_windows.get(&(profile.to_string(), role)).copied()
    }

    /// An item's address as the library has it (`library.items().first { $0.id == item }?.value["url"] as? String`).
    pub(crate) fn item_url(&self, item: &str) -> Option<String> {
        let v = self.library.item("tabs", item)?;
        v.as_object()?.get("url")?.as_str().map(str::to_string)
    }

    // ---- what a flow awaits ----

    /// A request of a profile's copy.
    pub(crate) async fn ask(&self, profile: &str, kind: &str, payload: Object) -> Asked {
        let command = Command::Ask { profile: profile.to_string(), kind: kind.to_string(), payload };
        Asked::read(&self.exec.command(command, false).await)
    }

    /// A library edit, answered in the same turn (its requests reach the session before the flow goes on).
    #[allow(dead_code)] // (the first flows that edit come with parts 1 and 3)
    pub(crate) async fn perform(&self, action: &str, payload: Object) -> Performed {
        let command = Command::Perform { action: action.to_string(), payload };
        Performed::read(&self.exec.command(command, true).await)
    }

    /// A sleep (HostedSession `sleep`): a deadline the caller's timer ticks.
    #[allow(dead_code)]
    pub(crate) fn sleep(&self, seconds: f64) -> exec::Sleep<'_> {
        self.exec.sleep(self.ports.now(), seconds)
    }

    /// HostedSession `wait`: `done` read at each step of `every` until true (true) or `seconds` are used up (false),
    /// the steps counted, not the clock read: the same number of looks as the Swift.
    #[allow(dead_code)]
    pub(crate) async fn wait(&self, seconds: f64, mut done: impl FnMut() -> bool) -> bool {
        let every = self.options.borrow().every;
        let mut left = seconds;
        loop {
            if done() {
                return true;
            }
            if left <= 0.0 {
                return false;
            }
            self.sleep(every).await;
            left -= every;
        }
    }
}

/// Swift's `min` (`y < x ? y : x`) and `max` (`y >= x ? y : x`), which CGFloat's arithmetic in the Swift used: the
/// same answer to the bit, a zero's sign included (Rust's `f64::min`/`max` may pick either zero).
pub(crate) fn swift_min(x: f64, y: f64) -> f64 {
    if y < x { y } else { x }
}
pub(crate) fn swift_max(x: f64, y: f64) -> f64 {
    if y >= x { y } else { x }
}
