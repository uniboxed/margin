//! The executor's order (first in first out, a spawned task after its spawner suspends, the serial queue, a start
//! ending the run, a re-entrant call only queuing), deadlines, `wait`'s looks and `first_of`; and the session through
//! a test adapter that calls back into the session on every port call (a borrow held across one panics here), over the
//! core's own library object (its edits the rules', their requests reaching the session through its sink).

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::{Rc, Weak};

use serde_json::{Value, json};

use super::exec::{Either, Exec, first_of};
use super::*;
use crate::host::layout::Size;

type Log = Rc<RefCell<Vec<String>>>;

fn push(log: &Log, s: &str) {
    log.borrow_mut().push(s.to_string());
}

fn names(log: &Log) -> Vec<String> {
    log.borrow().clone()
}

fn ask(n: u32) -> Command {
    Command::Run { job: u64::from(n) }
}

#[test]
fn ready_tasks_run_first_in_first_out_a_spawned_one_after_its_spawner_suspends() {
    let exec = Rc::new(Exec::default());
    let log: Log = Rc::default();
    for name in ["a", "b", "c"] {
        let (log, exec2) = (log.clone(), exec.clone());
        exec.spawn(async move {
            push(&log, &format!("{name}1"));
            if name == "a" {
                let log2 = log.clone();
                exec2.spawn(async move { push(&log2, "spawned") });
                push(&log, "a2 (after the spawn, before its first poll)");
            }
            exec2.sleep(0.0, 1.0).await;
            push(&log, &format!("{name}3"));
        });
    }
    exec.run();
    assert_eq!(names(&log), ["a1", "a2 (after the spawn, before its first poll)", "b1", "c1", "spawned"]);
    assert_eq!(exec.deadline(), Some(1.0));
    exec.tick(1.0);
    exec.run();
    assert_eq!(names(&log)[5..], ["a3", "b3", "c3"], "equal deadlines: in the order they were made");
    assert_eq!(exec.deadline(), None);
}

#[test]
fn the_serial_queue_one_turn_at_a_time_detached_tasks_beside_it() {
    let exec = Rc::new(Exec::default());
    let log: Log = Rc::default();
    let (l, e) = (log.clone(), exec.clone());
    exec.enqueue(async move {
        push(&l, "q1 starts");
        e.command(ask(1)).await;
        push(&l, "q1 ends");
    });
    let l = log.clone();
    exec.enqueue(async move { push(&l, "q2") });
    let l = log.clone();
    exec.spawn(async move { push(&l, "detached") });
    assert!(!exec.idle());
    exec.run();
    assert_eq!(names(&log), ["q1 starts"], "a start ends the run: the detached task waits");
    let started = exec.take_started();
    assert_eq!(started.iter().map(|(_, c)| c.clone()).collect::<Vec<_>>(), [ask(1)]);
    exec.run();
    assert_eq!(names(&log).len(), 1, "held until the start is said to be done");
    exec.release();
    exec.run();
    assert_eq!(names(&log), ["q1 starts", "detached"], "q2's turn only after q1");
    assert!(exec.answer(started[0].0, json!({})));
    assert!(!exec.answer(started[0].0, json!({})), "answered once");
    exec.run();
    assert_eq!(names(&log), ["q1 starts", "detached", "q1 ends", "q2"]);
    assert!(exec.idle());
}

#[test]
fn a_reentrant_call_during_a_poll_only_queues() {
    let exec = Rc::new(Exec::default());
    let log: Log = Rc::default();
    let (l, e) = (log.clone(), exec.clone());
    exec.spawn(async move {
        push(&l, "a polled");
        // (A port's callback calling back in: a task queued, the run asked for: it doesn't run inside the poll.)
        let l2 = l.clone();
        e.spawn(async move { push(&l2, "queued from inside") });
        e.run();
        push(&l, "a goes on");
    });
    exec.run();
    assert_eq!(names(&log), ["a polled", "a goes on", "queued from inside"]);
}

#[test]
fn deadlines_from_the_later_of_the_clock_and_the_last_tick_a_dropped_sleep_forgotten() {
    let exec = Rc::new(Exec::default());
    let log: Log = Rc::default();
    // (A frozen clock at 10: each sleep counts from the last tick, so a loop of short sleeps never starves a long one.)
    let (l, e) = (log.clone(), exec.clone());
    exec.spawn(async move {
        for i in 0..4 {
            e.sleep(10.0, 0.5).await;
            push(&l, &format!("short {i}"));
        }
    });
    let (l, e) = (log.clone(), exec.clone());
    exec.spawn(async move {
        e.sleep(10.0, 1.2).await;
        push(&l, "long");
    });
    exec.run();
    while let Some(at) = exec.deadline() {
        exec.tick(at);
        exec.release();
        exec.run();
    }
    assert_eq!(names(&log), ["short 0", "short 1", "long", "short 2", "short 3"]);
    // A sleep dropped before its deadline: no deadline left.
    let e = exec.clone();
    exec.spawn(async move {
        let s = e.sleep(0.0, 1.0);
        let a = e.command(ask(9));
        let _ = first_of(a, s).await;
    });
    exec.run();
    let (id, _) = exec.take_started()[0].clone();
    exec.release();
    assert!(exec.deadline().is_some());
    exec.answer(id, json!({}));
    exec.run();
    assert_eq!(exec.deadline(), None, "the losing sleep's deadline dropped");
}

#[test]
fn first_of_the_one_that_came_first_even_when_both_came_before_the_poll() {
    for (answer_first, then_tick) in [(true, false), (false, false), (true, true), (false, true)] {
        let exec = Rc::new(Exec::default());
        let won: Rc<RefCell<Option<&str>>> = Rc::default();
        let (w, e) = (won.clone(), exec.clone());
        exec.spawn(async move {
            let r = first_of(e.command(ask(1)), e.sleep(0.0, 0.4)).await;
            *w.borrow_mut() = Some(match r {
                Either::A(_) => "answer",
                Either::B(()) => "time",
            });
        });
        exec.run();
        let (id, _) = exec.take_started()[0].clone();
        // (Held: both can come before the task is polled again.)
        if answer_first {
            exec.answer(id, json!({}));
        } else {
            exec.tick(0.4);
        }
        if then_tick {
            if answer_first {
                exec.tick(0.4);
            } else {
                exec.answer(id, json!({}));
            }
        }
        exec.release();
        exec.run();
        assert_eq!(*won.borrow(), Some(if answer_first { "answer" } else { "time" }), "{answer_first} {then_tick}");
        assert!(!exec.answer(id, json!({})), "the loser's answer let go");
    }
}

// ---- the session, through a test adapter ----

#[derive(Default)]
struct World {
    now: Cell<f64>,
    windows: RefCell<Vec<i64>>, // (the front one first)
    core: RefCell<Weak<Core>>,
    reentries: Cell<u32>,
    ports: RefCell<Vec<String>>,
    // (The engine's, the links' and the waker's answers; what was done to Margin's windows and the Swift flows asked,
    // in order: `acts`.)
    shown: RefCell<Option<String>>,
    hosted: RefCell<Vec<String>>,
    runs: RefCell<BTreeMap<String, bool>>,
    not_alone: RefCell<Vec<String>>,
    profiles: RefCell<Vec<String>>,
    epochs: RefCell<BTreeMap<String, String>>,
    // (How long each profile's copy has been slow, as its link says: `Link::slow`.)
    slow: RefCell<BTreeMap<String, f64>>,
    windows_of: RefCell<BTreeMap<String, Vec<i64>>>,
    names: RefCell<BTreeMap<String, String>>,
    woken: RefCell<Vec<String>>,
    unopenable: RefCell<Vec<String>>,
    settings: RefCell<Value>,
    acts: RefCell<Vec<Value>>,
    lines: RefCell<Vec<Line>>,
    card_rects: RefCell<BTreeMap<i64, Rect>>,
    pages: RefCell<BTreeMap<i64, Rect>>,
    // (Commit 6's: Margin's windows' facts, the engine's minimums and the drag.)
    not_full_screen: RefCell<Vec<i64>>,
    placement: RefCell<Option<Placement>>,
    panes: RefCell<Option<PaneLayout>>,
    minimums: RefCell<BTreeMap<String, Size>>,
    follows: Cell<bool>,
    // (Margin's windows not in full screen, with no page area while hosting or at their launcher; the engine's
    // full-screen read out of sight and its Space; Margin the active app.)
    no_hosted_place: RefCell<Vec<i64>>,
    no_idle_place: RefCell<Vec<i64>>,
    out_of_sight: Cell<bool>,
    inactive: Cell<bool>,
}

impl World {
    fn act(&self, v: Value) {
        self.acts.borrow_mut().push(v);
    }

    /// The session called back into (a state read and edit, an answer no task waits for), as each port and the
    /// library's callbacks do.
    fn reenter_session(&self) {
        let Some(core) = self.core.borrow().upgrade() else { return };
        self.reentries.set(self.reentries.get() + 1);
        let get = vec!["shown".into(), "open".into(), "safariWindows".into()];
        let set = json!({ "shown": { "del": [987_654] } }).as_object().cloned();
        let out = core.call(false, |c| c.input(Input::State { get, set }));
        assert!(out.start.is_empty(), "a re-entrant call hands nothing out");
        core.call(true, |c| {
            c.exec.answer(u64::MAX, Value::Null);
            (None, None)
        });
    }
}

/// Ports that call back into the session on every call: a state read and edit, a log line's take, an answer no task
/// waits for. A borrow held across a port call panics.
struct Reentrant(Rc<World>);

impl Reentrant {
    fn reenter(&self, port: &str) {
        self.0.ports.borrow_mut().push(port.to_string());
        self.0.reenter_session();
    }
}

impl Ports for Reentrant {
    fn now(&self) -> f64 {
        self.0.now.get()
    }
    fn window(&self, id: Option<i64>) -> Option<i64> {
        self.reenter("window");
        let w = self.0.windows.borrow();
        match id {
            Some(id) => w.contains(&id).then_some(id),
            None => w.first().copied(),
        }
    }
    fn window_ids(&self) -> Vec<i64> {
        self.reenter("windowIds");
        self.0.windows.borrow().clone()
    }
    fn engine_shown(&self) -> Option<String> {
        self.reenter("engineShown");
        self.0.shown.borrow().clone()
    }
    fn is_hosted(&self, host: &str) -> bool {
        self.reenter("isHosted");
        self.0.hosted.borrow().iter().any(|h| h == host)
    }
    fn safari_profiles(&self) -> Vec<String> {
        self.reenter("safariProfiles");
        self.0.profiles.borrow().clone()
    }
    fn link_epoch(&self, p: &str) -> Option<String> {
        self.reenter("linkEpoch");
        let linked = self.0.profiles.borrow().iter().any(|l| l == p);
        linked.then(|| self.0.epochs.borrow().get(p).cloned().unwrap_or_else(|| "e1".into()))
    }
    fn link_slow(&self, p: &str) -> Option<f64> {
        self.reenter("linkSlow");
        self.0.slow.borrow().get(p).copied()
    }
    fn app_name(&self, bundle: &str) -> Option<String> {
        self.reenter("appName");
        self.0.names.borrow().get(bundle).cloned()
    }
    fn app_runs(&self, bundle: &str) -> Option<bool> {
        self.reenter("appRuns");
        self.0.runs.borrow().get(bundle).copied()
    }
    fn shows_alone(&self, host: &str) -> bool {
        self.reenter("showsAlone");
        !self.0.not_alone.borrow().iter().any(|h| h == host)
    }
    fn stop_hiding_woken(&self, bundle: &str) {
        self.reenter("stopHidingWoken");
        self.0.act(json!(["stopHidingWoken", bundle]));
    }
    fn window_ids_of(&self, p: &str) -> Vec<i64> {
        self.reenter("windowIdsOf");
        self.0.windows_of.borrow().get(p).cloned().unwrap_or_default()
    }
    fn wall(&self) -> f64 {
        self.reenter("wall");
        1_800_000_000.0
    }
    fn set_showing(&self, window: i64, label: Option<&str>, app: Option<&str>, slow: bool) {
        self.reenter("setShowing");
        self.0.act(json!(["setShowing", window, label, app, slow]));
    }
    fn set_margin_page(&self, window: i64, page: Option<&str>) {
        self.reenter("setMarginPage");
        self.0.act(json!(["setMarginPage", window, page]));
    }
    fn push(&self, window: i64, json: &str) {
        self.reenter("push");
        self.0.act(json!(["push", window, json]));
    }
    fn set_loading(&self, window: i64, label: Option<&str>, app: Option<&str>) {
        self.reenter("setLoading");
        self.0.act(json!(["setLoading", window, label, app]));
    }
    fn set_pane_loading(&self, window: i64, item: Option<&str>, label: Option<&str>, app: Option<&str>) {
        self.reenter("setPaneLoading");
        self.0.act(json!(["setPaneLoading", window, item, label, app]));
    }
    fn set_loading_tabs(&self, window: i64, numbers: &[i64]) {
        self.reenter("setLoadingTabs");
        self.0.act(json!(["setLoadingTabs", window, numbers]));
    }
    fn changed(&self) {
        self.reenter("changed");
        self.0.act(json!(["changed"]));
    }
    fn engine_shows(&self) -> bool {
        self.reenter("engineShows");
        self.0.shown.borrow().is_some()
    }
    fn set_elsewhere(&self, window: i64, label: Option<&str>, app: Option<&str>, picture: Option<&str>) {
        self.reenter("setElsewhere");
        self.0.act(json!(["setElsewhere", window, label, app, picture]));
    }
    fn set_startup_stuck(&self, window: i64, why: Option<&str>) {
        self.reenter("setStartupStuck");
        self.0.act(json!(["setStartupStuck", window, why]));
    }
    fn clear_cover(&self, window: i64) {
        self.reenter("clearCover");
        self.0.act(json!(["clearCover", window]));
    }
    fn has_hosted_placement(&self, window: i64) -> bool {
        self.reenter("hasHostedPlacement");
        !self.0.no_hosted_place.borrow().contains(&window)
    }
    fn has_idle_placement(&self, window: i64) -> bool {
        self.reenter("hasIdlePlacement");
        !self.0.no_idle_place.borrow().contains(&window)
    }
    fn prepares_out_of_sight(&self) -> bool {
        self.reenter("preparesOutOfSight");
        self.0.out_of_sight.get()
    }
    fn margin_active(&self) -> bool {
        self.reenter("marginActive");
        !self.0.inactive.get()
    }
    fn activate_margin(&self) {
        self.reenter("activateMargin");
        self.0.act(json!(["activateMargin"]));
    }
    fn woken_by_menu(&self, p: &str) -> bool {
        self.reenter("wokenByMenu");
        self.0.woken.borrow().iter().any(|w| w == p)
    }
    fn unopenable(&self, p: &str) -> bool {
        self.reenter("unopenable");
        self.0.unopenable.borrow().iter().any(|w| w == p)
    }
    fn log(&self, warn: bool, text: &str) {
        self.reenter("log");
        self.0.lines.borrow_mut().push(Line { warn, text: text.to_string() });
    }
    fn swift(&self, call: &str, args: Value) -> Value {
        self.reenter("swift");
        self.0.act(json!(["swift", call, args]));
        Value::Null
    }
    fn settings(&self) -> Value {
        self.reenter("settings");
        self.0.settings.borrow().clone()
    }
    fn card_rect(&self, window: i64) -> Option<Rect> {
        self.reenter("cardRect");
        self.0.card_rects.borrow().get(&window).copied()
    }
    fn hosted_page(&self, window: i64) -> Option<Rect> {
        self.reenter("hostedPage");
        self.0.pages.borrow().get(&window).copied()
    }
    fn idna(&self, host: &str) -> bool {
        self.reenter("idna");
        !host.contains('-')
    }
    fn url_host(&self, url: &str) -> Option<String> {
        self.reenter("urlHost");
        self.0.act(json!(["urlHost", url]));
        Some("xn--host".into())
    }
    fn window_number(&self, window: i64) -> i64 {
        self.reenter("windowNumber");
        100 + window
    }
    fn window_full_screen(&self, window: i64) -> bool {
        self.reenter("windowFullScreen");
        !self.0.not_full_screen.borrow().contains(&window)
    }
    fn window_full_screen_state(&self, _: i64) -> String {
        self.reenter("windowFullScreenState");
        "test".into()
    }
    fn window_why_not(&self, _: i64) -> String {
        self.reenter("windowWhyNot");
        "test".into()
    }
    fn window_layout_mode(&self, _: i64) -> Option<String> {
        self.reenter("windowLayoutMode");
        Some("fullscreen".into())
    }
    fn hosted_placement(&self, _: i64) -> Option<(Placement, i64)> {
        self.reenter("hostedPlacement");
        self.0.placement.borrow().map(|p| (p, -1))
    }
    fn pane_layout(&self, _: i64) -> Option<PaneLayout> {
        self.reenter("paneLayout");
        self.0.panes.borrow().clone()
    }
    fn remeasure(&self, window: i64) {
        self.reenter("remeasure");
        self.0.act(json!(["remeasure", window]));
    }
    fn to_full_screen(&self, window: i64) {
        self.reenter("toFullScreen");
        self.0.act(json!(["toFullScreen", window]));
        self.0.not_full_screen.borrow_mut().retain(|w| *w != window);
    }
    fn window_set_hosting(&self, window: i64, on: bool) {
        self.reenter("setHosting");
        self.0.act(json!(["setHosting", window, on]));
    }
    fn set_hosted(&self, window: i64, number: Option<i64>) {
        self.reenter("setHosted");
        self.0.act(json!(["setHosted", window, number]));
    }
    fn set_app_minimums(&self, window: i64, m: &[(String, Size)]) {
        self.reenter("setAppMinimums");
        self.0.act(json!(["setAppMinimums", window, m.len()]));
    }
    fn set_pane_minimums(&self, window: i64, m: &[(String, Size)]) {
        self.reenter("setPaneMinimums");
        let m: Vec<Value> = m.iter().map(|(i, s)| json!([i, s.width, s.height])).collect();
        self.0.act(json!(["setPaneMinimums", window, m]));
    }
    fn follows_page(&self, window: i64, on: bool) {
        self.reenter("followsPage");
        self.0.act(json!(["followsPage", window, on]));
    }
    fn hosted_moved(&self, window: i64) {
        self.reenter("hostedMoved");
        self.0.act(json!(["hostedMoved", window]));
    }
    fn full_screen_space(&self, _: i64) -> Option<u64> {
        self.reenter("fullScreenSpace");
        Some(7)
    }
    fn known_app_minimums(&self) -> Vec<(String, Size)> {
        self.reenter("knownAppMinimums");
        self.0.minimums.borrow().iter().map(|(b, s)| (b.clone(), *s)).collect()
    }
    fn minimum(&self, host: &str) -> Option<Size> {
        self.reenter("minimum");
        self.0.minimums.borrow().get(host).copied()
    }
    fn dragging(&self, on: bool) -> bool {
        self.reenter("dragging");
        self.0.act(json!(["dragging", on]));
        on && self.0.follows.get()
    }
    fn shown_fills_page(&self) -> bool {
        self.reenter("shownFillsPage");
        true
    }
    fn live_followers(&self) -> (i64, i64) {
        self.reenter("liveFollowers");
        (1, 1)
    }
    fn follow(&self, p: &Placement, rects: &[(&str, Rect)]) {
        // (Per frame: no re-entry from the engine's follow, which calls nothing of the session's back.)
        let rects: Vec<Value> = rects.iter().map(|(h, r)| json!([h, r.x, r.y, r.width, r.height])).collect();
        self.0.act(json!(["follow", p.page.width, rects]));
    }
}

/// The library the session reads and edits: the core's own object (library/object.rs) over a store in a folder of its
/// own, in place of the stand-in lib that answered canned edits. Values put as given (`put`: the store's own apply, no
/// rule run, as a library read from disk); an edit the rules' own, said as an act (`["perform", action, payload]`), its
/// requests given to the session inside it (the sink, registered as margin_session_new registers it), the session
/// called back into from the library's env and observers meanwhile.
pub(super) struct TestLibrary {
    pub(super) lib: Rc<crate::library::Library>,
    world: Rc<World>,
    _dir: tempfile::TempDir,
}

impl TestLibrary {
    /// A value put as it is (none: deleted).
    pub(super) fn put(&self, collection: &str, id: &str, v: Value) {
        self.lib.apply(&[json!({ "collection": collection, "id": id, "value": v })], 1.0);
    }
    /// A value deleted.
    pub(super) fn delete(&self, collection: &str, id: &str) {
        self.lib.apply(&[json!({ "collection": collection, "id": id, "deleted": true })], 1.5);
    }
    /// Every value gone.
    pub(super) fn clear(&self) {
        let all: Vec<Value> = self
            .lib
            .values()
            .iter()
            .flat_map(|(c, ids)| {
                let ids: Vec<String> = ids.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
                ids.into_iter().map(move |id| json!({ "collection": c, "id": id, "deleted": true }))
            })
            .collect();
        self.lib.apply(&all, 2.0);
    }
}

impl LibraryView for TestLibrary {
    fn item(&self, collection: &str, id: &str) -> Option<Value> {
        self.lib.item(collection, id)
    }
    fn collection(&self, collection: &str) -> serde_json::Map<String, Value> {
        self.lib.live(collection)
    }
}

impl LibraryEdit for TestLibrary {
    fn perform(&self, action: &str, payload: &Object) -> Performed {
        self.world.act(json!(["perform", action, payload]));
        LibraryEdit::perform(&*self.lib, action, payload)
    }
}

impl LibraryView for Rc<TestLibrary> {
    fn item(&self, collection: &str, id: &str) -> Option<Value> {
        (**self).item(collection, id)
    }
    fn collection(&self, collection: &str) -> serde_json::Map<String, Value> {
        (**self).collection(collection)
    }
}

impl LibraryEdit for Rc<TestLibrary> {
    fn perform(&self, action: &str, payload: &Object) -> Performed {
        (**self).perform(action, payload)
    }
}

/// The library's env (its ids `lib<n>x<i>`, numbered by perform), its clock and its observers: each calls the session
/// back, as Swift's do (an observer is Margin's window drawing again).
struct TestHost {
    world: Rc<World>,
    n: Cell<u32>,
}

impl crate::library::LibraryHost for TestHost {
    fn env(&self) -> crate::library::actions::Env {
        self.world.reenter_session();
        let n = self.n.get() + 1;
        self.n.set(n);
        crate::library::actions::Env { now: f64::from(1000 + n), ids: (0..4).map(|i| format!("lib{n}x{i}")).collect() }
    }
    fn now(&self) -> f64 {
        self.world.reenter_session();
        f64::from(1000 + self.n.get())
    }
    fn changed(&self, collections: &std::collections::BTreeSet<String>) {
        self.world.reenter_session();
        self.world.act(json!(["libraryChanged", collections]));
    }
}

fn session() -> (Session, Rc<World>, Rc<TestLibrary>) {
    let world = Rc::new(World::default());
    world.windows.borrow_mut().push(1);
    // (Margin's window's page area, measured: what `prepare` waits for.)
    *world.placement.borrow_mut() = Some(Placement {
        page: Rect::new(260.0, 8.0, 1244.0, 933.0),
        area: Rect::new(0.0, 0.0, 1512.0, 949.0),
        display: Rect::new(0.0, 0.0, 1512.0, 982.0),
    });
    let dir = crate::data::testing::temp();
    let lib = Rc::new(crate::library::Library::new(
        crate::data::library::LibraryStore::new(crate::data::store::DataStore::new(dir.path()).flat()),
        Box::new(TestHost { world: world.clone(), n: Cell::new(0) }),
        Box::new(crate::library::js::CodePointOrder),
    ));
    let lib = Rc::new(TestLibrary { lib, world: world.clone(), _dir: dir });
    let s = Session::new(Box::new(Reentrant(world.clone())), Box::new(lib.clone()), &json!({ "every": 0.05 }));
    *world.core.borrow_mut() = Rc::downgrade(s.core());
    lib.lib.set_sink(Some(s.sink()));
    (s, world, lib)
}

fn set(s: &Session, edit: Value) {
    let out = s.input(&json!({ "type": "state", "set": edit }));
    assert_eq!(out.error, None);
}

fn asks(out: &Out) -> Vec<(u64, String, String, Value)> {
    out.start
        .iter()
        .filter_map(|(id, c)| match c {
            Command::Ask { profile, kind, payload } => {
                Some((*id, profile.clone(), kind.clone(), Value::Object(payload.clone())))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn navigate_its_tab_by_host_show_then_the_copys_own_request() {
    let (s, world, lib) = session();
    lib.put("tabs", "t1", json!({ "url": "https://a.example/", "title": "A" }));
    set(
        &s,
        json!({ "shown": { "put": [[1, "t1"]] }, "open": { "put": [["t1", "safari:s-default", "s-default"]] },
                "safariWindows": { "put": [["s-default", "main", 90]] } }),
    );
    let queued = s.input(&json!({ "type": "navigate", "kind": "goBack", "window": 1 }));
    assert!(queued.ready && queued.start.is_empty(), "run after the caller's code that asked, as a Task");
    let out = s.tick(0.0);
    let a = asks(&out);
    assert_eq!(a.len(), 1);
    assert_eq!(
        (a[0].1.as_str(), a[0].2.as_str(), &a[0].3),
        ("s-default", "hostShow", &json!({ "windowId": 90, "itemId": "t1", "url": "https://a.example/" }))
    );
    assert!(!s.idle());
    assert!(s.tick(0.0).start.is_empty());
    let out = s.answer(a[0].0, json!({ "result": { "tabId": 501, "created": false }, "error": null }));
    let b = asks(&out);
    assert_eq!((b[0].2.as_str(), &b[0].3), ("goBack", &json!({ "tabId": 501 })));
    s.tick(0.0);
    s.answer(b[0].0, json!({ "result": {} }));
    assert!(s.idle(), "its turn over");
    assert!(world.reentries.get() > 0 && world.ports.borrow().iter().all(|p| p == "window" || p == "log"));

    // The front window's, with no window named; a pane's window by its role; no address: about:blank; no window of
    // that role: -1.
    lib.clear();
    set(&s, json!({ "open": { "put": [["t1", "safari:s-default#pane2", "s-default"]] } }));
    s.input(&json!({ "type": "navigate", "kind": "reload", "window": null }));
    let out = s.tick(0.0);
    assert_eq!(asks(&out)[0].3, json!({ "windowId": -1, "itemId": "t1", "url": "about:blank" }));
    s.tick(0.0);
    set(&s, json!({ "safariWindows": { "put": [["s-default", "pane2", 93]] } }));
    // (Its window read at its turn, not when it was asked: the first one still waits for its answer.)
    let queued = s.input(&json!({ "type": "navigate", "kind": "reload", "window": 1 }));
    assert!(queued.start.is_empty() && !queued.ready, "behind the one under way");
    let first = asks(&out)[0].0;
    let out = s.answer(first, json!({ "result": { "tabId": 2.5 } }));
    assert_eq!(asks(&out)[0].3["windowId"], json!(93), "a tab id that isn't whole: nothing more; the next one's turn");
    s.tick(0.0);
    let out = s.answer(asks(&out)[0].0, json!({ "error": "not linked" }));
    assert!(out.start.is_empty() && s.idle());

    // Nothing for: a window that isn't there, no item shown, an app's item (no profile).
    for (window, edit) in [
        (json!(2), json!({})),
        (json!(1), json!({ "shown": { "del": [1] } })),
        (
            json!(1),
            json!({ "shown": { "put": [[1, "app"]] }, "open": { "put": [["app", "app:com.apple.Notes", null]] } }),
        ),
    ] {
        set(&s, edit);
        let out = s.input(&json!({ "type": "navigate", "kind": "goBack", "window": window }));
        assert!(out.start.is_empty() && s.idle());
    }
}

#[test]
fn swift_ints_as_the_swift_reads_them() {
    for (v, want) in [
        (json!(501), Some(501)),
        (json!(501.0), Some(501)),
        (json!(2.5), None),
        (json!(true), None),
        (json!("501"), None),
        (json!(8.999e15), Some(8_999_000_000_000_000)),
        (json!(9e15), None),
        (json!(-9e15), None),
        (json!(-3), Some(-3)),
        (Value::Null, None),
    ] {
        assert_eq!(swift_int(Some(&v)), want, "{v}");
    }
}

#[test]
fn wait_looks_as_many_times_as_the_swift() {
    // (HostedSession.wait's looks for a predicate never true, from the Swift: 0.3 s is 8, 3 s 62, by its arithmetic.)
    for (seconds, every, swift) in [
        (0.2, 0.05, 6),
        (1.5, 0.05, 31),
        (3.0, 0.05, 62),
        (0.3, 0.05, 8),
        (0.0, 0.05, 1),
        (0.05, 0.05, 2),
        (6.0, 0.05, 122),
        (30.0, 0.05, 601),
        (0.4, 0.05, 10),
        (1.0, 0.1, 12),
    ] {
        let (s, world, _) = session();
        s.input(&json!({ "type": "options", "options": { "every": every } }));
        let looks = Rc::new(Cell::new(0));
        let said: Rc<Cell<Option<bool>>> = Rc::default();
        let (c, l, out) = (s.core().clone(), looks.clone(), said.clone());
        s.core().exec.spawn(async move {
            let r = c
                .wait(seconds, || {
                    l.set(l.get() + 1);
                    false
                })
                .await;
            out.set(Some(r));
        });
        let mut o = s.tick(0.0);
        while let Some(at) = o.deadline {
            world.now.set(at);
            o = s.tick(at);
        }
        assert_eq!((looks.get(), said.get()), (swift, Some(false)), "{seconds} s every {every}");
    }
    // True at the third look: two sleeps.
    let (s, _, _) = session();
    let looks = Rc::new(Cell::new(0));
    let (c, l) = (s.core().clone(), looks.clone());
    s.core().exec.spawn(async move {
        assert!(
            c.wait(1.0, || {
                l.set(l.get() + 1);
                l.get() == 3
            })
            .await
        );
    });
    let mut o = s.tick(0.0);
    let mut ticks = 0;
    while let Some(at) = o.deadline {
        ticks += 1;
        o = s.tick(at);
    }
    assert_eq!((looks.get(), ticks), (3, 2));
}

#[test]
fn notes_kept_the_last_two_hundred_and_logged_bad_inputs_said_once() {
    let (s, world, _) = session();
    for i in 0..205 {
        let out = s.input(&json!({ "type": "note", "line": format!("line {i}") }));
        assert!(out.log.is_empty(), "logged at once, through the port");
        assert_eq!(world.lines.borrow_mut().pop(), Some(Line { warn: false, text: format!("hosted: line {i}") }));
    }
    let done = s.done();
    assert_eq!((done.len(), done[0].as_str(), done[199].as_str()), (200, "line 5", "line 204"));
    assert_eq!(s.rev(Field::Done), 205);
    let a = s.input(&json!({ "type": "nope" }));
    let b = s.input(&json!({ "type": "nope" }));
    assert!(a.error.is_some() && b.error.is_some());
    assert_eq!((a.log.len(), b.log.len()), (1, 0), "said once a kind");
    assert!(a.log[0].warn);
    assert!(s.input(&json!("not an object")).error.is_some());
    assert!(s.input(&json!({ "type": "enqueue" })).error.is_some());
}

#[test]
fn the_state_read_and_edited_by_revision() {
    let (s, _, _) = session();
    assert_eq!(s.rev(Field::Shown), 0);
    set(&s, json!({ "shown": { "put": [[1, "a"]] } }));
    assert_eq!((s.rev(Field::Shown), s.rev(Field::Open)), (1, 0));
    let out = s.input(&json!({ "type": "state", "get": ["shown", "open", "safariWindows"] }));
    let mut revs = vec![0; Field::COUNT];
    revs[0] = 1;
    assert_eq!(out.reply, Some(json!({ "shown": [[1, "a"]], "open": [], "safariWindows": [], "revs": revs })));
}

#[test]
fn swift_jobs_take_their_turn_in_the_queue() {
    let (s, _, _) = session();
    assert!(s.input(&json!({ "type": "enqueue", "job": 7 })).ready);
    let out = s.tick(0.0);
    assert_eq!(out.start.iter().map(|(_, c)| c.clone()).collect::<Vec<_>>(), [Command::Run { job: 7 }]);
    let first = out.start[0].0;
    s.tick(0.0);
    let out = s.input(&json!({ "type": "enqueue", "job": 8 }));
    assert!(out.start.is_empty() && !out.ready, "behind job 7");
    let out = s.answer(first, json!({}));
    assert_eq!(out.start.iter().map(|(_, c)| c.clone()).collect::<Vec<_>>(), [Command::Run { job: 8 }]);
    s.tick(0.0);
    assert!(!s.idle());
    s.answer(out.start[0].0, json!({}));
    assert!(s.idle());
    assert_eq!(
        Out { start: vec![(3, Command::Run { job: 8 })], ..Out::default() }.to_json(),
        json!({ "start": [{ "op": "run", "id": 3, "job": 8 }], "deadline": null })
    );
}

#[test]
fn a_library_edit_made_now_its_requests_handled_in_the_queue_after_the_flow() {
    // (The session's edit is the library's perform, called directly: its requests reach the session, the sink, inside
    // it, after its observers; the flow goes on at once, and what the requests queued runs after it.)
    let (s, world, lib) = session();
    lib.put("spaces", "sp", json!({ "name": "A", "order": 0 }));
    let got: Rc<RefCell<Option<Performed>>> = Rc::default();
    let (c, g) = (s.core().clone(), got.clone());
    s.core().exec.enqueue(async move {
        let p = c.perform("newTab", object(json!({ "url": "https://x/", "spaceId": "sp", "windowId": 1 })));
        c.note(format!("after the edit: {}", c.requested_in(1).unwrap_or_default()));
        *g.borrow_mut() = Some(p);
    });
    let out = s.tick(0.0);
    let p = got.borrow().clone().expect("made in the flow's turn");
    let item = p.result["tabId"].as_str().expect("an item").to_string();
    assert!(p.ok && p.error.is_none(), "{p:?}");
    assert_eq!(s.done()[0], format!("after the edit: {item}"), "in front at once, inside the edit");
    // (No command for the edit: its request's show, queued inside it, ran after the flow, in the same run.)
    let first = out.start.first().map(|(_, c)| c.clone());
    let opens = matches!(&first, Some(Command::Engine { op, args }) if op == "open" && args["item"] == json!(item));
    assert!(opens, "{first:?}");
    let a = std::mem::take(&mut *world.acts.borrow_mut());
    let names: Vec<&str> = a.iter().filter_map(|v| v[0].as_str()).collect();
    let at = |n: &str| names.iter().position(|x| *x == n).unwrap_or(usize::MAX);
    assert!(at("perform") < at("libraryChanged"), "{names:?}");
    let refused = s.core().perform("deleteSpace", object(json!({ "spaceId": "nope" })));
    assert!(!refused.ok && refused.result == Value::Null && refused.error.is_some(), "{refused:?}");
}

#[path = "requests_tests.rs"]
mod requests_tests;

#[path = "card_tests.rs"]
mod card_tests;
#[path = "routing_tests.rs"]
mod routing_tests;

#[path = "layouts_tests.rs"]
mod layouts_tests;
#[path = "start_tests.rs"]
mod start_tests;
