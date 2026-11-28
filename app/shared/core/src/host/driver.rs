//! The reconcile loop against an OS's adapter (docs/ARCHITECTURE-PLAN.md, "The shape"): what every OS shares of the
//! steady state, so a shell only says how its OS does each thing. The core decides what (the reconciler's corrections,
//! their budgets, the loop guard, the routes); the adapter reports each host's situation and applies a correction its
//! own way (macOS: Spaces, tiles, Accessibility; Windows: window positions, showing and hiding).
//!
//! One correction at a time, the shown host first: the next is decided on what the adapter reads after the last one. A
//! correction's budget counts its tries within `BUDGET_WITHIN` (a window's framing: since the host's last show, never
//! again and again for one that can't be); the loop guard counts reactions (all of these are) and moves a host that
//! keeps asking for the same one down a route.
//!
//! Two ways in. An OS whose steps are plain calls (Windows) hands the driver its adapter: `reconcile`. One whose steps
//! are its own async work (the Mac's engine, through the JSON API) asks the same in parts: `decide` (the host's next
//! correction, its tries filled in), then in that correction's turn `decide` again and `admit` (the guard; the try
//! counted; a stop's step down), then applies it itself.

use std::collections::BTreeMap;

use super::guard::{LoopGuard, Verdict};
use super::reconciler::{self, Correction, Desired, Situation};
use super::routes::{Route, Routes};

/// How long a correction's tries count against its budget.
pub const BUDGET_WITHIN: f64 = 30.0;

/// What applying a correction came to.
#[derive(Clone, Debug, PartialEq)]
pub enum Applied {
    Done,
    /// Not done (the OS refused it, or this OS doesn't do it): said, its try counted.
    Failed(String),
}

/// One OS's side: its hosts, what each should be and is, and how it does each correction and each route.
pub trait HostAdapter {
    /// Every host, the one shown first.
    fn hosts(&self) -> Vec<String>;
    fn desired(&self, host: &str) -> Desired;
    /// What's seen of it now (`tries` is the driver's: whatever the adapter puts there is replaced).
    fn situation(&mut self, host: &str) -> Situation;
    fn apply(&mut self, host: &str, c: &Correction) -> Applied;
    /// Its route now, and the ones it could take on this OS for this window.
    fn route(&self, host: &str) -> Route;
    fn available(&self, host: &str) -> Vec<Route>;
    /// Its app's identity for the routes: bundle id (or its OS's equivalent) and version.
    fn identity(&self, host: &str) -> (String, String);
    /// The loop guard stopped it: moved to `to` (None: nothing safer: left as it is), `why` said.
    fn moved(&mut self, host: &str, from: Route, to: Option<Route>, why: &str);
}

/// What one pass did: the host, the correction, what it came to (None: nothing to do, or held).
pub type Pass = Option<(String, Correction, Applied)>;

/// A correction about to be applied, through the guard.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Admit {
    /// Apply it: its try counted (`tried`: its tries now, this one in).
    Go { tried: u32 },
    /// Not now: too many reactions this second across every host.
    Held { until: f64 },
    /// The guard stopped the host: moved to `to` (None: nothing safer), `why` said; the guard's counts for it cleared.
    Stopped { why: String, from: Route, to: Option<Route> },
}

/// Who the host is for the routes, and where it could go.
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize)]
pub struct Identity {
    pub bundle: String,
    pub version: String,
    pub from: Option<Route>,
    #[serde(default)]
    pub available: Vec<Route>,
}

/// The tries counted since the host's last show rather than within `BUDGET_WITHIN`.
fn per_show(key: &str) -> bool {
    key == Correction::FrameWindow.key()
}

#[derive(Debug, Default)]
pub struct Driver {
    pub guard: LoopGuard,
    pub routes: Routes,
    /// Apps that go full screen only with their Dock icon (docked.rs), per version.
    pub docked: super::docked::DockedApps,
    tries: BTreeMap<String, BTreeMap<String, Vec<f64>>>,
}

impl Driver {
    pub fn new() -> Self {
        Self::default()
    }

    /// `host` was shown (a person's switch, a first open): its budgets start again, and the guard's counts for it.
    pub fn shown(&mut self, host: &str) {
        self.tries.remove(host);
        self.guard.person(Some(host));
    }

    /// Its budgets start again (a show of the engine's own, the guard's counts left as they are).
    pub fn reset_tries(&mut self, host: &str) {
        self.tries.remove(host);
    }

    /// The host's next correction of those the loop makes (`steady`, and `PutBack` where `put_back`: an OS with no step
    /// of its own for a window out of its place), its tries filled in; None: nothing to do.
    pub fn decide(&mut self, now: f64, host: &str, mut s: Situation, d: Desired, put_back: bool) -> Option<Correction> {
        s.tries = self.counted(now, host);
        reconciler::step(&s, d).into_iter().find(|c| c.steady() || (put_back && *c == Correction::PutBack))
    }

    /// `c` about to be applied for `host`: through the guard (`guarded`: a reaction; false: Margin's own plan, a
    /// person's operation), its try counted on a go.
    pub fn admit(&mut self, now: f64, host: &str, c: &Correction, guarded: bool, who: &Identity) -> Admit {
        if guarded {
            match self.guard.react(now, host, &c.key()) {
                Verdict::Go => {}
                Verdict::Hold { until } => return Admit::Held { until },
                Verdict::Stop { key, count, within, .. } => {
                    let why = format!("{key} {count} times within {within} s");
                    let from = who.from.unwrap_or(Route::Window);
                    let to = self.routes.step_down(&who.bundle, &who.version, from, &who.available, &why, now);
                    self.guard.cleared(host);
                    return Admit::Stopped { why, from, to };
                }
            }
        }
        Admit::Go { tried: self.record(now, host, &c.key()) }
    }

    /// A try of `key` counted for `host` outside the loop (a show's own ladder); its tries now.
    pub fn record(&mut self, now: f64, host: &str, key: &str) -> u32 {
        let list = self.tries.entry(host.to_string()).or_default().entry(key.to_string()).or_default();
        list.push(now);
        list.len() as u32
    }

    /// The tries of `key` counted for `host` now.
    pub fn tried(&mut self, now: f64, host: &str, key: &str) -> u32 {
        self.counted(now, host).get(key).copied().unwrap_or(0)
    }

    /// `host` is gone (closed, its app quit): nothing kept of it.
    pub fn forget(&mut self, host: &str) {
        self.tries.remove(host);
        self.guard.cleared(host);
    }

    /// One pass: the first host with a correction to make gets it, through the guard. (A window back where it belongs
    /// is one more correction here: the Mac's engine has a step of its own for that, `strayed`.)
    pub fn reconcile(&mut self, now: f64, a: &mut impl HostAdapter) -> Pass {
        for host in a.hosts() {
            let s = a.situation(&host);
            let d = a.desired(&host);
            let Some(c) = self.decide(now, &host, s, d, true) else { continue };
            let (bundle, version) = a.identity(&host);
            let who = Identity { bundle, version, from: Some(a.route(&host)), available: a.available(&host) };
            let applied = match self.admit(now, &host, &c, true, &who) {
                Admit::Go { .. } => a.apply(&host, &c),
                Admit::Held { .. } => Applied::Failed("held: too many reactions this second".into()),
                Admit::Stopped { why, from, to } => {
                    a.moved(&host, from, to, &why);
                    Applied::Failed(format!("stopped: {why}"))
                }
            };
            return Some((host, c, applied));
        }
        None
    }

    fn counted(&mut self, now: f64, host: &str) -> BTreeMap<String, u32> {
        let Some(tries) = self.tries.get_mut(host) else { return BTreeMap::new() };
        for (key, list) in tries.iter_mut() {
            if !per_show(key) {
                list.retain(|t| now - t < BUDGET_WITHIN);
            }
        }
        tries.retain(|_, l| !l.is_empty());
        tries.iter().map(|(k, l)| (k.clone(), l.len() as u32)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::kinds::WindowPlace;
    use crate::host::reconciler::Phase;

    /// A stand-in OS: one host each, its place and tile as the corrections leave them, and an app that answers each
    /// sizing of its tile by laying it out again (Weather's loop, in the driver's terms).
    #[derive(Default)]
    struct Sim {
        hosts: Vec<(String, Situation, Route)>,
        answers_resize: bool,
        applied: Vec<(String, Correction)>,
        moved: Vec<(String, Route, Option<Route>)>,
    }

    impl Sim {
        fn member(name: &str, place: WindowPlace) -> (String, Situation, Route) {
            let s = Situation {
                phase: Phase::Shown,
                member: true,
                window: Some(1),
                place,
                on_screen: Some(true),
                launched_by_margin: true,
                ..Situation::default()
            };
            (name.to_string(), s, Route::Tiles)
        }
    }

    impl HostAdapter for Sim {
        fn hosts(&self) -> Vec<String> {
            self.hosts.iter().map(|h| h.0.clone()).collect()
        }
        fn desired(&self, _: &str) -> Desired {
            Desired::Shown
        }
        fn situation(&mut self, host: &str) -> Situation {
            self.hosts.iter().find(|h| h.0 == host).map(|h| h.1.clone()).unwrap_or_default()
        }
        fn apply(&mut self, host: &str, c: &Correction) -> Applied {
            self.applied.push((host.to_string(), c.clone()));
            let answers = self.answers_resize;
            let Some(h) = self.hosts.iter_mut().find(|h| h.0 == host) else { return Applied::Failed("gone".into()) };
            match c {
                Correction::PutBack => h.1.place = WindowPlace::Margin,
                // (Its rect set; its app answers it by laying it out again: stale again at the next read.)
                Correction::SizeTile => h.1.tile_stale = answers,
                _ => {}
            }
            Applied::Done
        }
        fn route(&self, host: &str) -> Route {
            self.hosts.iter().find(|h| h.0 == host).map(|h| h.2).unwrap_or(Route::Window)
        }
        fn available(&self, _: &str) -> Vec<Route> {
            Route::LADDER.to_vec()
        }
        fn identity(&self, host: &str) -> (String, String) {
            (host.to_string(), "1.0".into())
        }
        fn moved(&mut self, host: &str, from: Route, to: Option<Route>, _: &str) {
            self.moved.push((host.to_string(), from, to));
            if let Some(h) = self.hosts.iter_mut().find(|h| h.0 == host) {
                h.1.tile = false;
                h.1.tile_stale = false;
                h.2 = to.unwrap_or(from);
            }
        }
    }

    #[test]
    fn a_stray_put_back_once_then_settled() {
        let mut sim = Sim { hosts: vec![Sim::member("app:messages", WindowPlace::Desktop)], ..Sim::default() };
        let mut d = Driver::new();
        let pass = d.reconcile(0.0, &mut sim);
        assert_eq!(pass, Some(("app:messages".into(), Correction::PutBack, Applied::Done)));
        assert_eq!(d.reconcile(0.25, &mut sim), None, "settled: nothing more");
    }

    #[test]
    fn weathers_loop_stops_at_the_third_round_and_it_moves_to_members() {
        let (name, mut s, route) = Sim::member("app:weather", WindowPlace::Margin);
        s.tile = true;
        s.tile_stale = true;
        let mut sim = Sim { hosts: vec![(name, s, route)], answers_resize: true, ..Sim::default() };
        let mut d = Driver::new();
        let mut t = 0.0;
        let mut passes = Vec::new();
        while let Some(p) = d.reconcile(t, &mut sim) {
            passes.push(p);
            t += 0.33;
            assert!(passes.len() < 10, "it ends");
        }
        let sized = sim.applied.iter().filter(|(_, c)| *c == Correction::SizeTile).count();
        assert_eq!(sized, 2, "two sizings let through, the third stopped");
        assert_eq!(sim.moved, vec![("app:weather".to_string(), Route::Tiles, Some(Route::Members))]);
        assert_eq!(
            d.routes.route("app:weather", "1.0", &Route::LADDER),
            Some(Route::Members),
            "remembered for that version"
        );
    }

    #[test]
    fn in_parts_decide_then_admit_as_the_macs_engine_asks() {
        let (_, mut s, _) = Sim::member("app:w", WindowPlace::Margin);
        s.tile = true;
        s.tile_stale = true;
        let mut d = Driver::new();
        let who = Identity {
            bundle: "app:w".into(),
            version: "2".into(),
            from: Some(Route::Tiles),
            available: Route::LADDER.to_vec(),
        };
        let mut admitted = Vec::new();
        for i in 0..4 {
            let now = i as f64 * 0.3;
            let c = d.decide(now, "app:w", s.clone(), Desired::Shown, false).expect("its tile to size");
            assert_eq!(c, Correction::SizeTile);
            admitted.push(d.admit(now, "app:w", &c, true, &who));
        }
        assert_eq!(admitted[0], Admit::Go { tried: 1 });
        assert_eq!(admitted[1], Admit::Go { tried: 2 });
        assert!(
            matches!(&admitted[2], Admit::Stopped { from: Route::Tiles, to: Some(Route::Members), .. }),
            "{:?}",
            admitted[2]
        );
        assert_eq!(d.routes.route("app:w", "2", &Route::LADDER), Some(Route::Members));
        // (Cleared at the stop: the next one goes, counted as the third try.)
        assert_eq!(admitted[3], Admit::Go { tried: 3 });
        // Unguarded (Margin's own plan): never held or stopped, still counted.
        let mut p = Driver::new();
        for i in 0..6 {
            assert!(matches!(p.admit(i as f64 * 0.1, "app:w", &Correction::SizeTile, false, &who), Admit::Go { .. }));
        }
        assert_eq!(p.tried(1.0, "app:w", &Correction::SizeTile.key()), 6);
    }

    #[test]
    fn put_back_only_where_asked_and_framing_counted_per_show() {
        let (_, s, _) = Sim::member("app:m", WindowPlace::Desktop);
        let mut d = Driver::new();
        assert_eq!(d.decide(0.0, "app:m", s.clone(), Desired::Shown, false), None, "the Mac's `strayed` puts it back");
        assert_eq!(d.decide(0.0, "app:m", s, Desired::Shown, true), Some(Correction::PutBack));
        let key = Correction::FrameWindow.key();
        d.record(0.0, "app:x", &key);
        d.record(0.0, "app:x", "bring forward activate");
        assert_eq!(d.tried(100.0, "app:x", &key), 1, "a framing: kept until a show");
        assert_eq!(d.tried(100.0, "app:x", "bring forward activate"), 0, "others: within the budget's window");
        d.reset_tries("app:x");
        assert_eq!(d.tried(100.0, "app:x", &key), 0);
    }

    #[test]
    fn budgets_count_within_their_window_and_start_again_at_a_show() {
        let (name, mut s, route) = Sim::member("app:x", WindowPlace::Margin);
        s.tile = true;
        s.tile_stale = true;
        let mut sim = Sim { hosts: vec![(name, s, route)], answers_resize: true, ..Sim::default() };
        let mut d = Driver::new();
        // Spread out (no loop): the budget (3 a show) ends them, then placed again the old way once.
        for i in 0..5 {
            d.reconcile(i as f64 * 6.0, &mut sim);
        }
        let sized = sim.applied.iter().filter(|(_, c)| *c == Correction::SizeTile).count();
        let again = sim.applied.iter().filter(|(_, c)| *c == Correction::PlaceAgain).count();
        assert_eq!((sized, again), (3, 1), "{:?}", sim.applied);
        // A show: the budgets start again.
        d.shown("app:x");
        d.reconcile(40.0, &mut sim);
        assert_eq!(sim.applied.last().map(|(_, c)| c.clone()), Some(Correction::SizeTile));
        d.forget("app:x");
        assert!(d.tries.is_empty());
    }
}
