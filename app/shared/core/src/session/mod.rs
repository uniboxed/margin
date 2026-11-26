//! The session (docs/CORE-REFACTOR.md step 3; HostedSession.swift, HostedPeek.swift): the library's items shown in
//! Margin's windows, its flows as Rust `async fn`s, the same on every OS. One object per app, sans IO:
//!
//! - **Ports** (synchronous, answered during the call): what the session reads of the engine, Margin's windows, the
//!   copies' links and the OS, and the clock ([`Ports`]). The Mac's are C callbacks into Swift (margin-ffi
//!   session.rs); Windows implements them in Rust over its adapter.
//! - **Commands** (asynchronous): what a flow awaits, handed out in the answer's `start` and answered by id
//!   ([`Session::answer`]): a copy's request, a Swift job's turn, an engine's operation.
//! - **The library**'s values read straight from its set ([`LibraryView`]: one item by id, never a collection built),
//!   and its edits made by a direct call ([`LibraryEdit`]: the core's library object, step 4 part 7), whose requests
//!   reach the session inside the call (the session is the library's sink, [`Session::sink`]).
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
pub mod elsewhere;
mod exec;
pub mod host_id;
mod hosting;
mod items;
pub mod layout;
mod layouts;
mod loading;
mod navigate;
mod page_area;
pub mod push;
mod requests;
pub mod restart;
pub mod route;
pub mod start;
pub mod state;
pub mod target;
#[cfg(test)]
mod tests;
pub mod ui;
pub(crate) mod unicode;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::rc::{Rc, Weak};
use std::task::Poll;

use serde_json::{Map, Value, json};

use crate::geometry::Rect;
use crate::host::layout::{Placement, Size};
use crate::hosted_browser::Role;
use crate::json::{self, Object};
use crate::page::Pace;
use exec::Exec;
pub use hosting::HostTarget;
pub use items::Split;
pub use page_area::{Frame, PageRect};
pub use requests::{By, Request};
pub use start::{STARTUP_LABEL, STARTUP_NO_LINK, STARTUP_SLOW, StartScreen, Startup};
pub use state::{Card, Extra, Field, Layout, OpenItem, Row, State};
pub use target::Target;
pub use ui::LiveRow;

/// A split as a page lays it out: its id, and each pane's item and box on the screen, in the split's order.
pub type PaneLayout = (String, Vec<(String, Rect)>);

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
    /// Whether the engine shows one (`HostedEngine.shown != nil`: the Safari waker's look, nothing allocated).
    fn engine_shows(&self) -> bool;
    /// Whether the engine hosts it (`HostedEngine.isHosted`).
    fn is_hosted(&self, host: &str) -> bool;
    /// The Safari copies linked now (`HostedLinks.safariProfiles`).
    fn safari_profiles(&self) -> Vec<String>;
    /// The epoch of a profile's link now (`HostedLinks.linkEpoch`), None: not linked.
    fn link_epoch(&self, profile: &str) -> Option<String>;
    /// How long a profile's copy has been slow (`Link::slow`: the age, in seconds, of its oldest request it hasn't
    /// acked: alive but not reading), None: not slow, or not linked. Feedback only: nothing is decided by it.
    fn link_slow(&self, profile: &str) -> Option<f64>;
    /// An installed app's name, the catalog's (`HostedSession.appName`).
    fn app_name(&self, bundle: &str) -> Option<String>;
    /// Whether an app runs at all (`HostedEngine.appRuns`), None: not known.
    fn app_runs(&self, bundle: &str) -> Option<bool>;
    /// The host would be shown today's one-host way (`HostedEngine.showsAlone`).
    fn shows_alone(&self, host: &str) -> bool;
    /// The windows an app opens to wake a profile no longer parked (`HostedEngine.stopHidingWoken`).
    fn stop_hiding_woken(&self, bundle: &str);
    /// A profile's windows as its copy lists them (`HostedLinks.windowIds`).
    fn window_ids_of(&self, profile: &str) -> Vec<i64>;
    /// The wall clock, seconds since 1970 (a request's `notAfter`).
    fn wall(&self) -> f64;
    /// A Margin window told an item is being shown and not ready yet (`HostedWindow.setShowing`; None: it is), and how
    /// long that's expected to take (`pace`: its page's grace, page/mod.rs). The window as the flow had it: one closed
    /// since is still told (Swift's flows held the window).
    fn set_showing(&self, window: i64, label: Option<&str>, app: Option<&str>, pace: Pace);
    /// The browser's copy asked to show a Margin window's item is slow, or no longer (`HostedWindow.setCopySlow`: its
    /// loader says so; the window forgets it with the item). Feedback only.
    fn set_copy_slow(&self, window: i64, on: bool);
    /// One of Margin's own pages in a Margin window's page area, None: the launcher (`HostedWindow.setMarginPage`).
    fn set_margin_page(&self, window: i64, page: Option<&str>);
    /// A message for a Margin window's page (`HostedWindow.push`).
    fn push(&self, window: i64, json: &str);
    /// The page card's loader (`HostedWindow.setLoading`: the label and the app's icon; None: none), a split's pane's
    /// own (`setPaneLoading`: its item, label and icon; None: none), the items loading by the UI's numbers
    /// (`setLoadingTabs`).
    fn set_loading(&self, window: i64, label: Option<&str>, app: Option<&str>);
    fn set_pane_loading(&self, window: i64, item: Option<&str>, label: Option<&str>, app: Option<&str>);
    fn set_loading_tabs(&self, window: i64, numbers: &[i64]);
    /// What the windows draw changed (HostedSession `onChange`).
    fn changed(&self);
    /// A Margin window's card for its item hosted in another window (`HostedWindow.setElsewhere`; None: no card).
    fn set_elsewhere(&self, window: i64, label: Option<&str>, app: Option<&str>, picture: Option<&str>);
    /// What the start screen says is wrong now (`HostedWindow.setStartupStuck`; None: nothing).
    fn set_startup_stuck(&self, window: i64, why: Option<&str>);
    /// None of the engine's windows under a Margin window (`cover(nil)`); its page area measured while hosting and at
    /// its launcher (`hostedPlacement`, `idlePlacement` there or not: nothing kept for them).
    fn clear_cover(&self, window: i64);
    fn has_hosted_placement(&self, window: i64) -> bool;
    fn has_idle_placement(&self, window: i64) -> bool;
    /// The engine can make a window ready with nothing seen (`preparesOutOfSight`).
    fn prepares_out_of_sight(&self) -> bool;
    /// Margin the active app (`marginActive`), and made so again (`activateMargin`).
    fn margin_active(&self) -> bool;
    fn activate_margin(&self);
    /// The Safari waker's: a profile woken through Safari's menu (`wokenByMenu[p] != nil`), and one its menu has no
    /// item for (`unopenable`).
    fn woken_by_menu(&self, profile: &str) -> bool;
    fn unopenable(&self, profile: &str) -> bool;
    /// The running Safari Margin hosts (HostEngine `safariRun`: its process, whether it has Margin's hosting arguments,
    /// whether Margin hosts any window of it now); None: none runs. Read once a Safari show (restart.rs).
    fn safari_run(&self) -> Option<restart::SafariRun>;
    /// A line for the app's log (Diagnostics), said at once.
    fn log(&self, warn: bool, text: &str);
    /// The one Swift step left that the core calls by name, synchronously: `paneCuts` `{ window }` (a split's cut panes
    /// said again, from the engine's visible windows: the Mac's list, kept Swift).
    fn swift(&self, call: &str, args: Value) -> Value;
    /// The profile's settings as Margin's windows draw them (`DataSetWindowSource.drawnSettings`: each theme's own under
    /// `themes`, what was changed in the UI over them), null: none: a search's engine, the favorites' scope. Rare (a UI
    /// request's), JSON.
    fn settings(&self) -> Value;
    /// Where a Margin window's page draws the preview card's page (the theme's `<m-preview-page>`,
    /// `HostedWindow.cardRect`), None: none drawn. The window as the flow had it.
    fn card_rect(&self, window: i64) -> Option<Rect>;
    /// A Margin window's page area while it hosts (`HostedWindow.hostedPlacement`'s page), None: not measured.
    fn hosted_page(&self, window: i64) -> Option<Rect>;
    /// Whether the OS's IDNA (UTS #46) makes a valid ASCII name of a host with letters outside ASCII (the Mac:
    /// Foundation's `URL(string:)`), and a web address's host as the OS's URL says it (its ASCII name: asked only for
    /// such a host).
    fn idna(&self, host: &str) -> bool;
    fn url_host(&self, url: &str) -> Option<String>;

    // ---- commit 6's (layouts and splits, the page area moving) ----

    /// A Margin window's facts as the flow reads them (the window as the flow had it): the window server's number,
    /// whether it's in full screen, its full-screen state and why it has no page area (for the log), its page's last
    /// layout's mode.
    fn window_number(&self, window: i64) -> i64;
    fn window_full_screen(&self, window: i64) -> bool;
    fn window_full_screen_state(&self, window: i64) -> String;
    fn window_why_not(&self, window: i64) -> String;
    fn window_layout_mode(&self, window: i64) -> Option<String>;
    /// Where the hosted window goes while hosting (`hostedPlacement`), None until measured; and the caller's token for
    /// it (-1: none), passed back with it to the engine's operations so the caller hands them its own value.
    fn hosted_placement(&self, window: i64) -> Option<(Placement, i64)>;
    /// A split as its page lays it out now (`paneLayout`): its id and each pane's item and box on the screen, in the
    /// split's order; None: none.
    fn pane_layout(&self, window: i64) -> Option<PaneLayout>;
    /// Its page asked to measure again; into full screen; hosting or not; the hosted window shown in it (None: none);
    /// every app's known minimum and a split's panes' (by the page's names: `web`, a bundle id, an item); the hosted
    /// window following a drag; the hosted window placed again (its bounds read again).
    fn remeasure(&self, window: i64);
    fn to_full_screen(&self, window: i64);
    fn window_set_hosting(&self, window: i64, on: bool);
    fn set_hosted(&self, window: i64, number: Option<i64>);
    fn set_app_minimums(&self, window: i64, minimums: &[(String, Size)]);
    fn set_pane_minimums(&self, window: i64, minimums: &[(String, Size)]);
    fn follows_page(&self, window: i64, on: bool);
    fn hosted_moved(&self, window: i64);
    /// The engine's: a Margin window's full-screen Space, every app's windows' known minimum (by bundle id), a host's
    /// window's minimum, a drag begun (true: the one shown follows it live) or over, the one shown fills the page area
    /// (a tile), how many visible hosts follow a drag of all visible.
    fn full_screen_space(&self, number: i64) -> Option<u64>;
    fn known_app_minimums(&self) -> Vec<(String, Size)>;
    fn minimum(&self, host: &str) -> Option<Size>;
    fn dragging(&self, on: bool) -> bool;
    fn shown_fills_page(&self) -> bool;
    fn live_followers(&self) -> (i64, i64);
    /// A frame of a drag the one shown follows (`HostedEngine.follow`): the page area, and the other visible hosts'
    /// rects in it (none: the one shown alone, `follow(placement)`). Per frame: typed, nothing allocated.
    fn follow(&self, placement: &Placement, rects: &[(&str, Rect)]);
}

/// The library's values as its set has them now (the core's library object's reads of its `LibraryStore`).
pub trait LibraryView {
    /// A live item of a collection by its id (`liveValues(collection)[id]`); None: none, or deleted.
    fn item(&self, collection: &str, id: &str) -> Option<Value>;
    /// A collection's live values (`liveValues(collection)`): for the reads that look through one (the splits, the
    /// spaces, a space's items), never per frame.
    fn collection(&self, collection: &str) -> Map<String, Value>;
}

/// The library's edits (`Library::perform`, step 4 part 7): an action run now, its requests given to the session (its
/// sink) inside the call, re-entrantly, after its observers ran (Margin's windows drawing again), before it returns, as
/// Library.swift's delegate had them; then the flow that made it goes on.
pub trait LibraryEdit: LibraryView {
    fn perform(&self, action: &str, payload: &Object) -> Performed;
}

/// What a flow awaits, handed out by id.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// A request of a profile's copy (`HostedLinks.request`): answered `{ result }` or `{ error }`, in the Swift's
    /// words ("not linked", the scrubbed refusal, the thrown error).
    Ask { profile: String, kind: String, payload: Object },
    /// A Swift job of the session's queue (HostedSession `enqueue`'s body), its turn come: answered when it's over.
    Run { job: u64 },
    /// An engine operation (`open` `{ target, placement, space, window, item }` → `{ shown, placed }` or
    /// `{ failed, why }`, `parkShown` `{ why }`, `close` `{ host }`, `show` `{ host }` → a result as `open`'s,
    /// `setLayout` `{ main, mainRect, extras: [{ target, role, rect }], focused, placement, window, space }` →
    /// `{ results: [[host, result, said]] }` (`said`: the result as the Swift writes it), `focusPages` and
    /// `toolbarsRest` `{ hosts }`, `pageRectChanged` `{ placement, rects? }` → `{ placed }`, `start` `{ bundle }` → `{ started }`,
    /// `prepare` `{ target, window, space }` → as `open`'s, at that window's launcher's page area): answered when it's
    /// over.
    Engine { op: String, args: Object },
    /// The Safari waker's (Safari's own window mechanics, the Mac's): `ensureLinked` `{ profile }` → `{ linked }`
    /// (woken through Safari's menu if it has no window, `margin_session_link_wanted` read at each look),
    /// `closeWoken` `{ profile, except, why }`. (The launch's preparation's `ensureLinked` says `prepare`: its look
    /// is `margin_session_prepare_wanted`.)
    Waker { op: String, args: Object },
    /// An `Ask` given up (its pick overtaken): `id` is that ask's command id. Carried out like it (`HostedLinks.cancel`:
    /// the link's `cancel`, the copy told), answered at once; the ask's own answer, if it still comes, is let go.
    Cancel { profile: String, id: u64 },
    /// The answer to a Swift caller (an engine's ask, a Swift flow's call of one of these): its continuation resumed,
    /// and the run goes on once that caller had its turn (the next main-actor turn).
    Reply { to: u64, value: Value },
    /// A Swift callback given with an input (a closing window's `done`), called now: answered at once.
    Done { then: u64 },
}

impl Command {
    pub fn to_json(&self, id: u64) -> Value {
        match self {
            Command::Ask { profile, kind, payload } => {
                json!({ "op": "ask", "id": id, "profile": profile, "kind": kind, "payload": payload })
            }
            Command::Cancel { profile, id: ask } => json!({ "op": "cancel", "id": id, "profile": profile, "ask": ask }),
            Command::Run { job } => json!({ "op": "run", "id": id, "job": job }),
            Command::Engine { op, args } => json!({ "op": "engine", "id": id, "name": op, "args": args }),
            Command::Waker { op, args } => json!({ "op": "waker", "id": id, "name": op, "args": args }),
            Command::Reply { to, value } => json!({ "op": "reply", "id": id, "to": to, "value": value }),
            Command::Done { then } => json!({ "op": "done", "id": id, "then": then }),
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

/// How a request raced against its pick being overtaken ended (`Core::ask_until`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Until {
    /// The copy's answer.
    Answered(Asked),
    /// Overtaken first: the request cancelled, its answer let go (`asked`: false, overtaken already: never asked).
    Overtaken { asked: bool },
    /// Its `limit` came first (Margin's quit: `quitWait` after it began): cancelled, its answer let go.
    Limit,
}

/// What woke an `ask_until`.
enum Woke {
    Answer(Value),
    Changed,
    Look,
    Limit,
}

/// A library edit's outcome (`LibraryOutcome`: its `ok`, its `result`, its `error`: a refusal's words).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Performed {
    pub ok: bool,
    pub result: Value,
    pub error: Option<String>,
}

/// A line for the app's log (Diagnostics).
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub warn: bool,
    pub text: String,
}

/// A call's answer: the commands its run handed out (start each at once, in order, then `tick`), whether tasks are
/// ready to run (an input's: `tick` once the caller's code that made them is over, as a main-actor `Task` starts after
/// the code that made it), the earliest deadline, the warnings since the last answer (a bad input's: the notes go out
/// through the `log` port as they're made), and a read's reply or a bad input's error.
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
    /// A profile's copy still not linked: said this often.
    pub link_say_every: f64,
    /// A pick this soon after the next/previous-tab key in its window is a cycle's; an app not running yet is held
    /// this long before it's started.
    pub cycle_window: f64,
    pub cycle_hold: f64,
    /// Safari's bundle ids (an app picked that is one: a new web item).
    pub safari_bundles: Vec<String>,
    /// Margin's window into full screen; its page area measured; a placing again that left the window out of full
    /// screen: shown again once, this long after.
    pub full_screen_wait: f64,
    pub page_wait: f64,
    pub refit_retry_after: f64,
    /// A web item's picture for its card in the other window: asked before its window leaves, never waited for longer.
    pub picture_wait: f64,
    /// At launch: the item a window showed last shown again; the default browser made ready first, the start screen
    /// held this long before it says it's taking longer; a Margin window in full screen with its page area this soon.
    pub resumes_last: bool,
    pub prepares_browser: bool,
    pub startup_wait: f64,
    pub prepare_window_wait: f64,
    /// A copy slow this long (`Ports::link_slow`) while a show waits for it: its loader says so (`slow`). Paces the
    /// feedback only: nothing is decided by it.
    pub slow_say: f64,
    /// At Margin's quit, how long after it began a copy's request an engine operation waits for may go unanswered (the
    /// engine's own `quitWait`, sent with these: none until it is, no bound then).
    pub quit_wait: Option<f64>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            every: 0.05,
            link_say_every: 5.0,
            cycle_window: 1.0,
            cycle_hold: 0.35,
            safari_bundles: vec![SAFARI_BUNDLE.into(), "com.apple.SafariTechnologyPreview".into()],
            full_screen_wait: 6.0,
            page_wait: 3.0,
            refit_retry_after: 1.5,
            picture_wait: 0.4,
            resumes_last: true,
            prepares_browser: true,
            startup_wait: 15.0,
            prepare_window_wait: 30.0,
            slow_say: 3.0,
            quit_wait: None,
        }
    }
}

impl Options {
    fn read(v: &Value, was: &Options) -> Options {
        let n = |k: &str, was: f64| json::num(v.get(k)).unwrap_or(was);
        let b = |k: &str, was: bool| v.get(k).and_then(Value::as_bool).unwrap_or(was);
        Options {
            every: n("every", was.every),
            link_say_every: n("linkSayEvery", was.link_say_every),
            cycle_window: n("cycleWindow", was.cycle_window),
            cycle_hold: n("cycleHold", was.cycle_hold),
            safari_bundles: json::array(v.get("safariBundles"))
                .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_else(|| was.safari_bundles.clone()),
            full_screen_wait: n("fullScreenWait", was.full_screen_wait),
            page_wait: n("pageWait", was.page_wait),
            refit_retry_after: n("refitRetryAfter", was.refit_retry_after),
            picture_wait: n("pictureWait", was.picture_wait),
            resumes_last: b("resumesLast", was.resumes_last),
            prepares_browser: b("preparesBrowser", was.prepares_browser),
            startup_wait: n("startupWait", was.startup_wait),
            prepare_window_wait: n("prepareWindowWait", was.prepare_window_wait),
            slow_say: n("slowSay", was.slow_say),
            quit_wait: json::num(v.get("quitWait")).filter(|w| w.is_finite() && *w >= 0.0).or(was.quit_wait),
        }
    }
}

/// Safari's bundle id (`safariIdentifier`).
pub const SAFARI_BUNDLE: &str = "com.apple.Safari";

/// What happens outside, and the facade's reads and writes.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// The options changed (the Swift struct's every field).
    Options(Value),
    /// The facade's read of fields (`get`) and its edit of them (`set`: each field's `put` and `del`).
    State {
        get: Vec<String>,
        set: Option<Object>,
    },
    /// A Swift flow's log line.
    Note(String),
    /// A Swift job enqueued (its body the facade's, run when its turn comes).
    Enqueue {
        job: u64,
    },
    /// The page's history for the item shown in a Margin window (`goBack`, `goForward`, `reload`).
    Navigate {
        kind: String,
        window: Option<i64>,
    },
    /// A library request (the library's sink takes them inside its `perform`, [`Session::sink`]; as an input, an
    /// adapter's or a test's with no library object): its item drawn in front at once, then handled in the session's
    /// queue.
    Library(Object),
    /// A library edit Swift made itself, outside a call of the session's (a UI request, a test): its requests reached the
    /// session inside it, as the sink's; this answers what they left (their lines, what they made ready: run at the
    /// caller's tick), as the `library` input answered them for the delegate.
    Edited,
    /// A flow called by Swift (an engine's ask, a Swift flow's call; `openApp` from the palette): run now, as Swift's
    /// call ran its first part at once, its answer (`id`: a caller that awaits it) a `Reply`.
    Call {
        id: Option<u64>,
        flow: String,
        args: Object,
    },
    /// A show overtaken before it started (a Swift flow's check), answered in `reply`.
    Overtaken {
        item: String,
        window: Option<i64>,
    },
    /// The next/previous-tab key pressed in a Margin window (each press and repeat).
    Cycled {
        window: i64,
    },
    /// The preview card's and Quick Tab's word (the copy's pushes, the page's `peek.*`, ⌘W, a host gone, the poll):
    /// card.rs `peek_input`, its reply for the ones that answer.
    Peek {
        kind: String,
        args: Object,
    },
    /// A request the UI makes (`LibraryWindowSource.perform`), its route in `reply`.
    Ui {
        kind: String,
        payload: Object,
    },
    /// What the loading bar kept for a Margin window gone (`standing`: its standing pushes' window; `said`: what it
    /// was told), or for a profile's copy whose main window went.
    LoadingForget {
        window: Option<i64>,
        standing: bool,
        said: bool,
        profile: Option<String>,
    },
    /// A change of a Margin window's sidebar's width began (a drag of its edge, or of a split's divider) or is over.
    SidebarResizing {
        window: i64,
        on: bool,
        divider: bool,
    },
    /// A Margin window's page area changed, read through the ports (a window with no page in the core: the tests').
    PageRect {
        window: i64,
    },
    /// A host gone, or parked with nothing in its place: out of every layout.
    ForgetInLayouts {
        host: String,
    },
    /// The one shown's minimum changed (each pane's told to the hosting window's page) and an app's known minimum
    /// changed (every app's told).
    RefreshPaneMinimums {
        window: i64,
    },
    AppMinimumsChanged,
    /// A Margin window made, before its page loads (the first of a run: the item it showed last, the start screen).
    WindowOpened {
        window: i64,
    },
    /// A Margin window brought in front (its item from another window shown here again).
    WindowFocused {
        window: i64,
    },
    /// A Margin window closing (its close button), `then` Swift's `done`: answered in `reply`, true when it's called
    /// later (what it shows parked first), false: close it now.
    WindowClosing {
        window: i64,
        then: u64,
    },
    /// A Margin window closed.
    WindowClosed {
        window: i64,
    },
    /// The start screen's Try again and Continue without Safari; the preparation over (ready, or not done).
    StartupRetry,
    StartupSkip,
    PreparationOver,
    /// The item a Margin window showed last (a read: `reply` `{ item, name, target }`, or null).
    LastItem {
        window: i64,
    },
    /// A browser copy's link came up or went down (the shell's `linkUp`/`linkDown`): the waits for a profile's link
    /// look again (a show waiting for its copy to come back: evidence, never a look on a timer).
    Linked {
        profile: String,
    },
    /// Margin quits (the engine's `quitAll` began): a copy's request made for it isn't waited for once its copy isn't
    /// reading it (`ask_held`).
    Quitting,
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
            "library" => Ok(Input::Library(json::object(o.get("request")).ok_or("no request")?.clone())),
            "edited" => Ok(Input::Edited),
            "call" => Ok(Input::Call {
                id: o.get("id").and_then(Value::as_u64),
                flow: s("flow").ok_or("no flow")?.to_string(),
                args: json::object(o.get("args")).cloned().unwrap_or_default(),
            }),
            "overtaken" => Ok(Input::Overtaken {
                item: s("item").ok_or("no item")?.to_string(),
                window: swift_int(o.get("window")),
            }),
            "cycled" => Ok(Input::Cycled { window: swift_int(o.get("window")).ok_or("no window")? }),
            "peek" => Ok(Input::Peek { kind: s("kind").ok_or("no kind")?.to_string(), args: o.clone() }),
            "ui" => Ok(Input::Ui {
                kind: s("kind").ok_or("no kind")?.to_string(),
                payload: json::object(o.get("payload")).cloned().unwrap_or_default(),
            }),
            "loadingForget" => Ok(Input::LoadingForget {
                window: json::int(o.get("window")),
                standing: o.get("standing").and_then(Value::as_bool) == Some(true),
                said: o.get("said").and_then(Value::as_bool) == Some(true),
                profile: s("profile").map(str::to_string),
            }),
            "sidebarResizing" => Ok(Input::SidebarResizing {
                window: swift_int(o.get("window")).ok_or("no window")?,
                on: o.get("on").and_then(Value::as_bool).ok_or("no on")?,
                divider: o.get("divider").and_then(Value::as_bool) == Some(true),
            }),
            "pageRect" => Ok(Input::PageRect { window: swift_int(o.get("window")).ok_or("no window")? }),
            "forgetInLayouts" => Ok(Input::ForgetInLayouts { host: s("host").ok_or("no host")?.to_string() }),
            "refreshPaneMinimums" => {
                Ok(Input::RefreshPaneMinimums { window: swift_int(o.get("window")).ok_or("no window")? })
            }
            "appMinimumsChanged" => Ok(Input::AppMinimumsChanged),
            "windowOpened" => Ok(Input::WindowOpened { window: swift_int(o.get("window")).ok_or("no window")? }),
            "windowFocused" => Ok(Input::WindowFocused { window: swift_int(o.get("window")).ok_or("no window")? }),
            "windowClosing" => Ok(Input::WindowClosing {
                window: swift_int(o.get("window")).ok_or("no window")?,
                then: o.get("then").and_then(Value::as_u64).ok_or("no then")?,
            }),
            "windowClosed" => Ok(Input::WindowClosed { window: swift_int(o.get("window")).ok_or("no window")? }),
            "startupRetry" => Ok(Input::StartupRetry),
            "startupSkip" => Ok(Input::StartupSkip),
            "preparationOver" => Ok(Input::PreparationOver),
            "lastItem" => Ok(Input::LastItem { window: swift_int(o.get("window")).ok_or("no window")? }),
            "linked" => Ok(Input::Linked { profile: s("profile").ok_or("no profile")?.to_string() }),
            "quitting" => Ok(Input::Quitting),
            other => Err(format!("{other:?} isn't an input")),
        }
    }

    fn kind(v: &Value) -> String {
        v.get("type").and_then(Value::as_str).unwrap_or("?").to_string()
    }

    /// What it makes ready runs in the call: a flow Swift called (its first part ran at once, as a Swift call).
    fn runs_now(&self) -> bool {
        matches!(self, Input::Call { .. }) || matches!(self, Input::Ui { kind, .. } if kind == "app.open")
    }
}

/// A JSON object's fields (none for another value).
pub(crate) fn object(v: Value) -> Object {
    match v {
        Value::Object(o) => o,
        _ => Object::new(),
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
    library: Box<dyn LibraryEdit>,
    exec: Exec,
    state: RefCell<State>,
    revs: [Cell<u64>; Field::COUNT],
    done: RefCell<VecDeque<String>>,
    log: RefCell<Vec<Line>>,
    options: RefCell<Options>,
    errors_said: RefCell<BTreeSet<String>>,
    depth: Cell<u32>,
    /// Commit 6's (layouts and splits, the page area moving): the addresses and items the panes being laid out open
    /// at (`paneAddress`, `paneItem` by item; `paneAddressFor`, `paneItemFor` by profile and role); the Margin window
    /// whose sidebar's edge is dragged, whether the one shown follows it live, a placing queued.
    panes: RefCell<layouts::PaneOpens>,
    resizing: Cell<Option<i64>>,
    following: Cell<bool>,
    placing: Cell<bool>,
    /// Hosts asked for (`host`, any window's), counted: a show that waited for its copy outside the queue reads
    /// whether another window's show took the engine meanwhile.
    hosts_asked: Cell<u64>,
    /// When Margin began to quit (`Input::Quitting`), on the caller's clock.
    quit_at: Cell<Option<f64>>,
    /// The question about a Safari the person opened (restart.rs): the process it was asked for, how far it went.
    restart_ask: Cell<Option<(i64, restart::Asked)>>,
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
    pub fn new(ports: Box<dyn Ports>, library: Box<dyn LibraryEdit>, options: &Value) -> Session {
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
            panes: RefCell::default(),
            resizing: Cell::new(None),
            following: Cell::new(false),
            placing: Cell::new(false),
            hosts_asked: Cell::new(0),
            quit_at: Cell::new(None),
            restart_ask: Cell::new(None),
        }))
    }

    /// An input (`{ type, … }`); a bad one is an `error`, logged once a kind. What it makes ready doesn't run in
    /// the call (`ready`: the caller ticks once its own code is over).
    pub fn input(&self, input: &Value) -> Out {
        match Input::read(input) {
            Ok(i) => self.0.call(i.runs_now(), |c| c.input(i)),
            Err(why) => self.0.call(false, |c| {
                c.refused(&Input::kind(input), &why);
                (None, Some(format!("bad input: {why}")))
            }),
        }
    }

    /// A page's click for a preview (the copy's `peekOpen` push, card.rs `peek_open`), its parts typed: the id and
    /// the address (empty: none), its time (0: none). As the `peek` input's `open`.
    pub fn peek_open(&self, profile: &str, window: Option<i64>, id: &str, url: &str, not_after: f64) -> Out {
        self.0.call(false, |c| {
            c.peek_open_click(profile, window, id, url, not_after);
            (None, None)
        })
    }

    /// The session as the library's requests' sink (`Library::set_sink`, held weakly: the session holds the library).
    pub fn sink(&self) -> Weak<dyn crate::library::RequestSink> {
        let me: Weak<Core> = Rc::downgrade(&self.0);
        me
    }

    /// Whether a show waiting on profile `p`'s link is still wanted (HostedSession `linkWanted`; the Safari waker
    /// reads it at each look: typed, nothing allocated).
    pub fn link_wanted(&self, profile: &str) -> bool {
        self.0.link_wanted(profile)
    }

    /// Whether an item is a pin's or a favourite's tab (card.rs `pinned_or_favorite`: typed, read by Swift's layout).
    pub fn pinned_or_favorite(&self, item: &str) -> bool {
        self.0.pinned_or_favorite(item)
    }

    /// A new app's open, awaiting its window, still wanted for `item` in Margin window `window` (the engine's
    /// `wanted`): no other item asked for there since, and the window still there.
    pub fn open_wanted(&self, window: i64, item: &str) -> bool {
        !self.0.superseded(window, item) && self.0.ports.window(Some(window)).is_some()
    }

    // ---- commit 9's typed entries (the loading bar, the copies' messages, the UI's numbers and rows) ----

    /// The engine's slow step for a host started (None: over): the page card's loader, a split's pane's, the bar.
    pub fn loading(&self, host: Option<&str>) -> Out {
        self.0.call(false, |c| {
            c.loading(host);
            (None, None)
        })
    }

    /// The loading bar told again (a Swift flow of a later part changed what it reads).
    pub fn refresh_loading(&self) -> Out {
        self.0.call(false, |c| {
            c.refresh_loading();
            (None, None)
        })
    }

    /// A copy's push as it came (`msg`: its JSON), routed (the loading bar's, the preview card's, the UI's).
    pub fn copy_message(&self, browser: &str, profile: &str, window: Option<i64>, msg: &[u8]) -> Out {
        self.0.call(false, |c| {
            match serde_json::from_slice::<Value>(msg) {
                Ok(Value::Object(m)) => c.copy_message(browser, profile, window, &m),
                _ => c.refused("push", "a push that isn't an object"),
            }
            (None, None)
        })
    }

    /// A Safari copy's `openTabs` as its state has it (`state`: that key's JSON): its items' tabs' sound.
    pub fn copy_tabs(&self, profile: &str, state: &[u8]) -> Out {
        self.0.call(false, |c| {
            if let Ok(Value::Object(open)) = serde_json::from_slice::<Value>(state)
                && let Some(tabs) = json::object(open.get("tabs"))
            {
                c.copy_tabs(profile, tabs);
            }
            (None, None)
        })
    }

    /// The UI's number for an item (given now if it has none), the item of a number, an open item's row.
    pub fn number(&self, item: &str) -> i64 {
        self.0.number(item)
    }
    pub fn item_of_tab(&self, n: i64) -> Option<String> {
        self.0.item_of_tab(n)
    }
    pub fn open_row(&self, item: &str) -> Option<i64> {
        self.0.open_row(item)
    }

    /// The open items the UI draws (`kept`: the library's snapshot keeps it as a tab in a space).
    pub fn live_plan(&self, kept: &mut dyn FnMut(&str) -> bool) -> Option<(i64, Vec<LiveRow>)> {
        self.0.live_plan(kept)
    }

    /// What a Margin window draws (step 4 part 6, one call a draw): `library`'s kept snapshot with the items this
    /// session has open as the window's open tabs (`live_plan`), `tail` (the profile's `"settings":…,"favicons":…`)
    /// spliced in. Nothing of the library is parsed or written again.
    pub fn state_text(&self, library: &crate::library::Library, tail: &str) -> String {
        let plan = self.0.live_plan(&mut |item| library.keeps(item));
        library.state_text(plan.as_ref().map(|(w, rows)| (*w, rows.as_slice())), tail)
    }

    /// The windows of a copy's Margin draws (`drawn`'s `hosted`).
    pub fn drawn_windows(&self, browser: &str, profile: &str) -> Vec<i64> {
        self.0.drawn_windows(browser, profile)
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

    /// Margin's window hosts only while the engine shows something in it (HostedSession `settleHosting`, called by
    /// the Swift flows of later parts and the engine's events).
    pub fn settle(&self) -> Out {
        self.0.call(false, |c| {
            c.settle_hosting();
            (None, None)
        })
    }

    /// The start screen is up: nothing of Margin's usable (read per key press and menu check: nothing allocated).
    pub fn start_screen(&self) -> bool {
        self.0.state.try_borrow().is_ok_and(|s| s.start.shown)
    }

    /// The launch's preparation may still wake its profile (the Safari waker's look, every 0.05 s: nothing allocated).
    pub fn prepare_wanted(&self) -> bool {
        self.0.prepare_wanted()
    }

    /// Tasks are ready to run (a facade's edit woke one: tick in the next turn).
    pub fn ready(&self) -> bool {
        self.0.exec.has_ready()
    }

    /// Nothing enqueued is left to do.
    pub fn idle(&self) -> bool {
        self.0.exec.idle()
    }

    /// A field's revision (a change of it since: read it again).
    pub fn rev(&self, f: Field) -> u64 {
        self.0.revs[f as usize].get()
    }

    /// A field's rows, typed (the facade's read, no JSON). `emit` must not call back into the session (it's given
    /// each row while the state is read); a read made during an edit of the state gives none.
    pub fn rows(&self, f: Field, emit: &mut dyn FnMut(&Row)) {
        if let Ok(state) = self.0.state.try_borrow() {
            state.rows(f, emit);
        }
    }

    /// One row of a field put or taken out (the facade's write, no JSON): whether it was one, and the field's
    /// revision after it.
    pub fn edit_row(&self, f: Field, del: bool, row: &Row) -> (bool, u64) {
        let ok = match self.0.state.try_borrow_mut() {
            Ok(mut state) => state.edit_row(f, del, row),
            Err(_) => false,
        };
        if ok {
            self.0.bump(f);
        }
        (ok, self.rev(f))
    }

    /// Whether an answer has more than its readiness and deadline to say (commands to start, warnings, a reply, an
    /// error): the Mac reads its JSON only then.
    pub fn has_more(out: &Out) -> bool {
        !out.start.is_empty() || !out.log.is_empty() || out.reply.is_some() || out.error.is_some()
    }

    /// A Margin window's page area changed (MarginWindow `setPageRect`'s, a split's panes laid out again): a drag's
    /// frame the one shown follows goes to the engine at once (`Ports::follow`); else one placing per burst, queued.
    /// Per frame of a drag: nothing allocated, no JSON; what it queued runs at the caller's next tick (`ready`), as an
    /// input's.
    pub fn page_rect(&self, window: i64, frame: &Frame<'_>) -> PageRect {
        let c = &self.0;
        let depth = c.depth.get() + 1;
        c.depth.set(depth);
        let r = c.page_rect_changed(window, frame);
        c.depth.set(depth - 1);
        r
    }

    /// The Margin window whose sidebar's edge is being dragged, and whether the one shown follows it live.
    pub fn drag(&self) -> (Option<i64>, bool) {
        (self.0.resizing.get(), self.0.following.get())
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
                    let Some(f) = Field::of(name) else { continue };
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
                        c.exec.command(Command::Run { job }).await;
                    });
                }
            }
            Input::Navigate { kind, window } => self.navigate(&kind, window),
            Input::Library(request) => self.library_request(&request),
            Input::Edited => {}
            Input::Call { id, flow, args } => self.call_flow(id, &flow, args),
            Input::Overtaken { item, window } => return (Some(json!(self.overtaken(&item, window))), None),
            Input::Cycled { window } => {
                let now = self.ports.now();
                self.edit(Field::CycledAt, |s| s.cycled_at.insert(window, now));
            }
            Input::Peek { kind, args } => match self.peek_input(&kind, &args) {
                Ok(reply) => return (reply, None),
                Err(why) => {
                    self.refused("peek", &why);
                    return (None, Some(format!("bad input: {why}")));
                }
            },
            Input::Ui { kind, payload } => return (Some(self.ui_request(&kind, payload)), None),
            Input::LoadingForget { window, standing, said, profile } => {
                self.loading_forget(window, standing, said, profile.as_deref());
            }
            Input::SidebarResizing { window, on, divider } => self.sidebar_resizing(window, on, divider),
            Input::PageRect { window } => {
                self.page_rect_changed(window, &Frame::Ports);
            }
            Input::ForgetInLayouts { host } => {
                self.forget_in_layouts(&host);
                // (A host gone: a show waiting for its window's copy looks again.)
                self.exec.notify();
            }
            Input::RefreshPaneMinimums { window } => self.refresh_pane_minimums(window),
            Input::AppMinimumsChanged => self.app_minimums_changed(),
            Input::WindowOpened { window } => self.resume_last(window),
            Input::WindowFocused { window } => self.focused(window),
            Input::WindowClosing { window, then } => return (Some(json!(self.window_closing(window, then))), None),
            Input::WindowClosed { window } => self.window_closed(window),
            Input::StartupRetry => self.startup_retry(),
            Input::StartupSkip => self.startup_skip(),
            Input::PreparationOver => self.preparation_over(),
            Input::LastItem { window } => {
                let last = self
                    .last_item_of(window)
                    .map(|(item, target, name)| json!({ "item": item, "name": name, "target": target.json() }));
                return (Some(last.unwrap_or(Value::Null)), None);
            }
            Input::Linked { profile: _ } => self.exec.notify(),
            Input::Quitting => {
                // (Every wait's bound read again at once: `ask_held`'s `quitWait` from now.)
                if self.quit_at.get().is_none() {
                    self.quit_at.set(Some(self.ports.now()));
                }
                self.exec.notify();
            }
        }
        (None, None)
    }

    /// A field changed by a flow: its revision bumped (the facade reads it again).
    pub(crate) fn edit<R>(&self, f: Field, change: impl FnOnce(&mut State) -> R) -> R {
        let r = change(&mut self.state.borrow_mut());
        self.bump(f);
        r
    }

    /// A read of the state (the borrow dropped before it returns).
    pub(crate) fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.state.borrow())
    }

    fn bump(&self, f: Field) {
        let r = &self.revs[f as usize];
        r.set(r.get() + 1);
        // (A card's address and freshness are read on their own, typed: `cards`' changes are theirs.)
        if f == Field::Cards {
            self.bump(Field::CardPages);
        }
        // (What the start screen held up reads: its own state and a window's item asked for. Every change of them is
        // made here, in an input, an answer, a tick or the facade's edit: it re-checks then, never on a look.)
        if matches!(f, Field::Start | Field::Requested) {
            self.exec.notify();
        }
    }

    /// A bad input or edit, said once a kind.
    fn refused(&self, kind: &str, why: &str) {
        if self.errors_said.borrow_mut().insert(kind.to_string()) {
            let text = format!("session: a {kind} input refused: {why} (said once a kind)");
            self.log.borrow_mut().push(Line { warn: true, text });
        }
    }

    /// A line of what was done (HostedSession `note`): kept (the last 200) and logged at once, so it's in the app's
    /// log among the lines of what the flow called meanwhile, in the Swift's order.
    pub(crate) fn note(&self, line: String) {
        let text = format!("hosted: {line}");
        let mut done = self.done.borrow_mut();
        done.push_back(line);
        while done.len() > DONE_KEPT {
            done.pop_front();
        }
        drop(done);
        self.bump(Field::Done);
        self.ports.log(false, &text);
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
        Asked::read(&self.exec.command(command).await)
    }

    /// A request of a profile's copy that ends on its answer, or once `overtaken` (docs/LINK-RESILIENCE.md §1 rule 7),
    /// with no time limit of its own: the link ends it when it goes down. `overtaken` is read each time what the
    /// session's flows read changes (`exec.changed()`, never on a look); true, the request is cancelled
    /// (`Command::Cancel`) and its answer, if it still comes, does nothing (rule 10); true already, it isn't asked.
    /// Meanwhile how slow the copy is (`Ports::link_slow`) is looked at `slowSay` after the ask, then once a `slowSay`
    /// or when it would reach it, and `slow` told each change (true: slow for `slowSay` at least): feedback only,
    /// nothing is decided by it (rule 8).
    pub(crate) async fn ask_until(
        &self,
        profile: &str,
        kind: &str,
        payload: Object,
        overtaken: impl Fn() -> bool,
        slow: impl Fn(bool),
        limit: impl Fn() -> Option<f64>,
    ) -> Until {
        if overtaken() {
            return Until::Overtaken { asked: false };
        }
        // (The time it may not outlast, on the caller's clock, read again at each wake: Margin's quit begins later.)
        let mut bound: Option<(f64, exec::Sleep<'_>)> = None;
        let mut answer =
            self.exec.command(Command::Ask { profile: profile.to_string(), kind: kind.to_string(), payload });
        let mut changed = self.exec.changed();
        let say = self.options.borrow().slow_say;
        let paced = say.is_finite() && say > 0.0;
        let mut look = paced.then(|| self.sleep(say));
        let mut said = false;
        loop {
            let at = limit();
            if at != bound.as_ref().map(|(t, _)| *t) {
                bound = at.map(|t| (t, self.sleep((t - self.ports.now()).max(0.0))));
            }
            let woke = std::future::poll_fn(|cx| {
                if let Poll::Ready(v) = Pin::new(&mut answer).poll(cx) {
                    return Poll::Ready(Woke::Answer(v));
                }
                if let Some((_, b)) = bound.as_mut()
                    && Pin::new(b).poll(cx).is_ready()
                {
                    return Poll::Ready(Woke::Limit);
                }
                if Pin::new(&mut changed).poll(cx).is_ready() {
                    return Poll::Ready(Woke::Changed);
                }
                if let Some(l) = look.as_mut()
                    && Pin::new(l).poll(cx).is_ready()
                {
                    return Poll::Ready(Woke::Look);
                }
                Poll::Pending
            })
            .await;
            match woke {
                Woke::Answer(v) => return Until::Answered(Asked::read(&v)),
                Woke::Changed if overtaken() => {
                    // (Its wait let go first: an answer that comes now is no task's.)
                    let id = answer.id();
                    drop(answer);
                    if let Some(id) = id {
                        self.exec.command(Command::Cancel { profile: profile.to_string(), id }).await;
                    }
                    return Until::Overtaken { asked: true };
                }
                Woke::Limit => {
                    let id = answer.id();
                    drop(answer);
                    if let Some(id) = id {
                        self.exec.command(Command::Cancel { profile: profile.to_string(), id }).await;
                    }
                    return Until::Limit;
                }
                Woke::Changed => {}
                Woke::Look => {
                    let age = self.ports.link_slow(profile);
                    let now = age.is_some_and(|a| a >= say);
                    if now != said {
                        said = now;
                        slow(now);
                    }
                    let next = match age {
                        Some(a) if a < say => say - a,
                        _ => say,
                    };
                    look = Some(self.sleep(next));
                }
            }
        }
    }

    /// A copy's request whose answer nothing needs: handed out now, in order with what the flow asks next on the same
    /// link (the socket keeps it), waited for by nothing (its answer, when it comes, let go). It ends on the link's own
    /// evidence (its reply, the link down, lost).
    pub(crate) async fn tell(&self, profile: &str, kind: &str, payload: Object) {
        let mut answer =
            self.exec.command(Command::Ask { profile: profile.to_string(), kind: kind.to_string(), payload });
        exec::begin(&mut answer).await;
    }

    /// A copy's request made from the session's queue whose answer only its own flow needs: the queue's turn given up
    /// while the copy works on it (what's queued behind goes on), taken again for what the flow does with the answer.
    pub(crate) async fn ask_aside(&self, profile: &str, kind: &str, payload: Object) -> Asked {
        let left = self.exec.leave_turn();
        let answer = self.ask(profile, kind, payload).await;
        if left {
            self.exec.rejoin().await;
        }
        answer
    }

    /// A copy's request an engine operation waits for (a window made, put in full screen, brought in front, closed):
    /// given up (cancelled, a `given up` error) once it's no longer `wanted`, judged when what the flows read changes (a
    /// pick, Margin's quit, the link down); never on a timer (the feedback's pace only paces words). Otherwise it ends on
    /// the link's evidence (its reply, the link down, lost: read past twice), and at Margin's quit no later than
    /// `quitWait` after the quit began, the engine's own bound. A request not acked yet as Margin quits isn't given up
    /// for that alone: one sent a moment before may be read the next (the merge review, 2026-11-25).
    pub(crate) async fn ask_held(
        &self,
        profile: &str,
        kind: &str,
        payload: Object,
        wanted: impl Fn() -> bool,
    ) -> Asked {
        let gone = || !wanted();
        // (At Margin's quit, as the engine's own quit decides: no longer than `quitWait` after it began.)
        let limit = || Some(self.quit_at.get()? + self.options.borrow().quit_wait?);
        match self.ask_until(profile, kind, payload, gone, |_| {}, limit).await {
            Until::Answered(a) => a,
            Until::Overtaken { .. } => Asked { result: None, error: Some("given up (no longer wanted)".into()) },
            Until::Limit => {
                let wait = self.options.borrow().quit_wait.unwrap_or(0.0);
                let left = if kind == "closeWindow" { "left in the marker" } else { "given up" };
                self.note(format!(
                    "at quit: {kind} for {profile} unanswered after quitWait ({} s): {left}",
                    hosting::secs(wait)
                ));
                Asked { result: None, error: Some("given up (unanswered at Margin's quit)".into()) }
            }
        }
    }

    /// A library edit, made now (its requests reach the session, the library's sink, before the flow goes on).
    pub(crate) fn perform(&self, action: &str, payload: Object) -> Performed {
        self.library.perform(action, &payload)
    }

    /// An engine operation, or the Safari waker's, answered when it's over.
    pub(crate) async fn engine(&self, op: &str, args: Value) -> Value {
        let command = Command::Engine { op: op.to_string(), args: object(args) };
        self.exec.command(command).await
    }

    /// The Safari waker's operation handed out now and waited for by nothing (`closeWoken`: its own closes end on their
    /// links' evidence; one left is tried again by its poll): nothing of the session's held for a copy's answer.
    pub(crate) async fn waker_tell(&self, op: &str, args: Value) {
        let mut command = self.exec.command(Command::Waker { op: op.to_string(), args: object(args) });
        exec::begin(&mut command).await;
    }

    pub(crate) async fn waker(&self, op: &str, args: Value) -> Value {
        let command = Command::Waker { op: op.to_string(), args: object(args) };
        self.exec.command(command).await
    }

    /// The Swift step called by name, synchronous (`Ports::swift`: `paneCuts`).
    pub(crate) fn swift(&self, call: &str, args: Value) -> Value {
        self.ports.swift(call, args)
    }

    /// A sleep (HostedSession `sleep`): a deadline the caller's timer ticks.
    pub(crate) fn sleep(&self, seconds: f64) -> exec::Sleep<'_> {
        self.exec.sleep(self.ports.now(), seconds)
    }

    /// HostedSession `wait`: `done` read at each step of `every` until true (true) or `seconds` are used up (false),
    /// the steps counted, not the clock read: the same number of looks as the Swift.
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
