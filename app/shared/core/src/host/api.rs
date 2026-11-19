//! The hosting core as a host app's shell calls it (Margin.app's Swift today; any shell that isn't Rust): one
//! object, one call that takes a request and returns its answer, both JSON. Sans IO: the caller passes its clock
//! (`now`, seconds, monotonic) and every fact; the core never reads the OS, a file or the time. The layout's hot path
//! (every frame of a drag) has its own typed calls in the FFI crate, with no JSON.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::causes::{Cause, Causes, Change, Event};
use super::choice::{self, ChoiceRule};
use super::driver::{Admit, Driver, Identity};
use super::guard::Verdict;
use super::kinds::{self, AppFacts, Window};
use super::layout::Placement;
use super::reconciler::{self, Correction, Desired, Situation};
use super::routes::{Route, Routes};
use crate::geometry::Rect;
use crate::system::ServerWindow;

/// A window server window as the caller sends it (system.rs `ServerWindow`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerWin {
    pub number: i64,
    pub pid: u32,
    #[serde(default)]
    pub layer: i32,
    pub bounds: Rect,
    #[serde(default = "yes")]
    pub on_screen: bool,
    #[serde(default = "one")]
    pub alpha: f64,
    #[serde(default)]
    pub order: usize,
}

fn yes() -> bool {
    true
}
fn one() -> f64 {
    1.0
}

impl From<&ServerWin> for ServerWindow {
    fn from(w: &ServerWin) -> Self {
        ServerWindow {
            number: w.number,
            pid: w.pid,
            layer: w.layer,
            bounds: w.bounds,
            on_screen: w.on_screen,
            alpha: w.alpha,
            order: w.order,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    /// Every window's kind (kinds.rs).
    #[serde(rename_all = "camelCase")]
    Classify {
        windows: Vec<Window>,
        app: AppFacts,
        placement: Placement,
    },
    /// The corrections for one host (reconciler.rs).
    Step {
        situation: Situation,
        desired: Desired,
    },
    /// Which window to host (choice.rs): from `server` (all of the app's, front to back), the pid, and the excluded.
    #[serde(rename_all = "camelCase")]
    Choose {
        server: Vec<ServerWin>,
        pid: u32,
        #[serde(default)]
        excluded: Vec<i64>,
        #[serde(default)]
        in_space: Vec<i64>,
        main: Option<i64>,
        focused: Option<i64>,
        #[serde(default)]
        standard: Vec<i64>,
        server_allowed: bool,
    },
    /// A reaction about to be applied (guard.rs).
    React {
        now: f64,
        host: String,
        key: String,
    },
    /// The person acted (on a host, or on everything).
    Person {
        now: f64,
        #[serde(default)]
        host: Option<String>,
    },
    /// A host's route changed, it closed, or it starts again: its stop and counts go.
    Cleared {
        host: String,
    },
    /// Something seen, for the causes.
    Note {
        now: f64,
        event: Event,
    },
    /// Why something changed.
    Explain {
        now: f64,
        change: Change,
    },
    /// The best route for an app (routes.rs).
    Route {
        bundle: String,
        version: String,
        available: Vec<Route>,
    },
    /// An app failed on `from`: held lower.
    #[serde(rename_all = "camelCase")]
    StepDown {
        now: f64,
        bundle: String,
        version: String,
        from: Route,
        available: Vec<Route>,
        why: String,
    },
    /// The routes as saved (read at launch).
    LoadRoutes {
        routes: Routes,
    },
    /// The routes to save.
    SaveRoutes,
    /// The earliest time the core has something to do on its own (none: wake it with the next event).
    NextWake,
    /// The windows of `pid` Margin could host, front first (choice.rs `candidates`).
    Candidates {
        server: Vec<ServerWin>,
        pid: u32,
        #[serde(default)]
        excluded: Vec<i64>,
    },
    /// Every correction's budget by its key family, and the reconciler's and the kinds' constants: read once.
    Constants,
    /// Seconds until the engine looks again (schedule.rs).
    NextPoll {
        facts: super::schedule::PollFacts,
    },
    /// The host's next correction of those the loop makes, its tries filled in by the core (driver.rs `decide`).
    #[serde(rename_all = "camelCase")]
    Decide {
        now: f64,
        host: String,
        situation: Situation,
        desired: Desired,
        #[serde(default)]
        put_back: bool,
    },
    /// A correction about to be applied: the guard (when `guarded`), its try counted, a stop's step down (`admit`).
    Admit {
        now: f64,
        host: String,
        correction: Correction,
        guarded: bool,
        identity: Identity,
    },
    /// A try counted outside the loop (`record`); `Tried`: the tries of a key now.
    Record {
        now: f64,
        host: String,
        key: String,
    },
    Tried {
        now: f64,
        host: String,
        key: String,
    },
    /// The host's budgets start again (`reset_tries`); `Forget`: nothing kept of it.
    ResetTries {
        host: String,
    },
    Forget {
        host: String,
    },
}

/// The hosting core's state across calls: the loop (its guard, the routes, the corrections' tries) and the causes.
#[derive(Debug, Default)]
pub struct HostCore {
    pub driver: Driver,
    pub causes: Causes,
}

impl HostCore {
    pub fn new() -> Self {
        Self::default()
    }

    /// One request (JSON) → its answer (JSON). Never panics on bad input: `{"error": …}`.
    pub fn call(&mut self, request: &str) -> String {
        match serde_json::from_str::<Request>(request) {
            Ok(r) => self.handle(r).to_string(),
            Err(e) => json!({ "error": format!("bad request: {e}") }).to_string(),
        }
    }

    pub fn handle(&mut self, r: Request) -> Value {
        match r {
            Request::Classify { windows, app, placement } => {
                let verdicts = kinds::classify(&windows, &app, &placement);
                json!({ "verdicts": verdicts })
            }
            Request::Step { situation, desired } => {
                json!({ "corrections": reconciler::step(&situation, desired) })
            }
            Request::Choose { server, pid, excluded, in_space, main, focused, standard, server_allowed } => {
                let list: Vec<ServerWindow> = server.iter().map(ServerWindow::from).collect();
                let excluded: BTreeSet<i64> = excluded.into_iter().collect();
                let candidates = choice::candidates(&list, pid, |n| excluded.contains(&n));
                let in_space: BTreeSet<i64> = in_space.into_iter().collect();
                let got: Option<(i64, ChoiceRule)> =
                    choice::choose(&candidates, &in_space, main, focused, &standard, server_allowed);
                let numbers: Vec<i64> = candidates.iter().map(|w| w.number).collect();
                json!({
                    "candidates": numbers,
                    "choice": got.map(|(n, rule)| json!({ "number": n, "rule": rule, "text": rule.text() })),
                })
            }
            Request::React { now, host, key } => {
                let v: Verdict = self.driver.guard.react(now, &host, &key);
                serde_json::to_value(v).unwrap_or(Value::Null)
            }
            Request::Person { now, host } => {
                self.driver.guard.person(host.as_deref());
                self.causes.note(now, Event::Person);
                json!({})
            }
            Request::Cleared { host } => {
                self.driver.guard.cleared(&host);
                json!({})
            }
            Request::Note { now, event } => {
                self.causes.note(now, event);
                json!({})
            }
            Request::Explain { now, change } => {
                let c: Cause = self.causes.explain(now, change);
                serde_json::to_value(c).unwrap_or(Value::Null)
            }
            Request::Route { bundle, version, available } => {
                let route = self.driver.routes.route(&bundle, &version, &available);
                let held = self.driver.routes.held_at(&bundle, &version);
                json!({ "route": route, "held": held })
            }
            Request::StepDown { now, bundle, version, from, available, why } => {
                let next = self.driver.routes.step_down(&bundle, &version, from, &available, &why, now);
                json!({ "route": next })
            }
            Request::LoadRoutes { routes } => {
                self.driver.routes = routes;
                json!({})
            }
            Request::SaveRoutes => json!({ "routes": self.driver.routes }),
            Request::NextWake => json!({ "at": self.driver.guard.next_wake() }),
            Request::Candidates { server, pid, excluded } => {
                let list: Vec<ServerWindow> = server.iter().map(ServerWindow::from).collect();
                let excluded: BTreeSet<i64> = excluded.into_iter().collect();
                let numbers: Vec<i64> =
                    choice::candidates(&list, pid, |n| excluded.contains(&n)).iter().map(|w| w.number).collect();
                json!({ "candidates": numbers })
            }
            Request::NextPoll { facts } => json!({ "after": super::schedule::next_poll(&facts) }),
            Request::Decide { now, host, situation, desired, put_back } => {
                json!({ "correction": self.driver.decide(now, &host, situation, desired, put_back) })
            }
            Request::Admit { now, host, correction, guarded, identity } => {
                let a: Admit = self.driver.admit(now, &host, &correction, guarded, &identity);
                serde_json::to_value(a).unwrap_or(Value::Null)
            }
            Request::Record { now, host, key } => json!({ "tried": self.driver.record(now, &host, &key) }),
            Request::Tried { now, host, key } => json!({ "tried": self.driver.tried(now, &host, &key) }),
            Request::ResetTries { host } => {
                self.driver.reset_tries(&host);
                json!({})
            }
            Request::Forget { host } => {
                self.driver.forget(&host);
                json!({})
            }
            Request::Constants => {
                use reconciler::{Correction as C, Forward};
                let budgets: BTreeMap<String, u32> = [
                    C::Launch,
                    C::Reopen,
                    C::Unhide,
                    C::Adopt { window: 0 },
                    C::FrameWindow,
                    C::PutBack,
                    C::ParkAgain,
                    C::ParkLeftover { window: 0 },
                    C::ParkStrip { window: 0 },
                    C::BringForward { rung: Forward::Activate },
                    C::CloseItem,
                    C::PlaceAgain,
                    C::SizeTile,
                ]
                .iter()
                .map(|c| {
                    let family = match c {
                        C::ParkLeftover { .. } => "leftover".to_string(),
                        C::ParkStrip { .. } => "strip".to_string(),
                        C::BringForward { .. } => "bring forward".to_string(),
                        other => other.name(),
                    };
                    (family, c.budget())
                })
                .collect();
                json!({
                    "budgets": budgets,
                    "offScreenAfter": reconciler::OFF_SCREEN_AFTER,
                    "goneGrace": reconciler::GONE_GRACE,
                    "offPageAfter": reconciler::OFF_PAGE_AFTER,
                    "tinySide": kinds::TINY_SIDE,
                    "stripMaxHeight": kinds::STRIP_MAX_HEIGHT,
                    "guardLimit": super::guard::LIMIT,
                    "guardWithin": super::guard::WITHIN,
                })
            }
        }
    }
}

/// Verdicts by number with string keys, as JSON objects have them (a helper for callers that want them typed).
pub type Verdicts = BTreeMap<i64, kinds::Verdict>;

#[cfg(test)]
mod tests {
    use super::*;

    fn call(core: &mut HostCore, v: Value) -> Value {
        serde_json::from_str(&core.call(&v.to_string())).unwrap()
    }

    #[test]
    fn classify_and_step_round_trip() {
        let mut core = HostCore::new();
        let got = call(
            &mut core,
            json!({
                "type": "classify",
                "windows": [
                    { "number": 5, "bounds": { "x": 260, "y": 41, "width": 1244, "height": 933 }, "place": "margin", "onScreen": true },
                    { "number": 6, "bounds": { "x": 0, "y": 0, "width": 80, "height": 20 }, "layer": 3 }
                ],
                "app": { "launchedByMargin": true, "hosted": [5] },
                "placement": { "page": { "x": 260, "y": 41, "width": 1244, "height": 933 }, "area": { "x": 0, "y": 33, "width": 1512, "height": 949 } }
            }),
        );
        assert_eq!(got["verdicts"]["5"]["kind"], "main");
        assert_eq!(got["verdicts"]["6"]["kind"], "transient");
        let got = call(
            &mut core,
            json!({ "type": "step", "desired": "shown", "situation": { "phase": "shown", "member": true, "window": 5, "place": "nowhere" } }),
        );
        assert_eq!(got["corrections"], json!([{ "type": "putBack" }]));
    }

    #[test]
    fn the_guard_and_the_causes_through_calls() {
        let mut core = HostCore::new();
        let h = "app:com.apple.weather";
        for (i, want) in ["go", "go", "stop"].iter().enumerate() {
            let v = call(
                &mut core,
                json!({ "type": "react", "now": i as f64 * 0.3, "host": h, "key": "tiles laid out again" }),
            );
            assert_eq!(v["verdict"], *want, "{v}");
        }
        call(
            &mut core,
            json!({ "type": "note", "now": 5.0, "event": { "type": "closed", "host": h, "window": 9, "kind": "helper" } }),
        );
        let c = call(&mut core, json!({ "type": "explain", "now": 5.02, "change": "tilesRelaidOut" }));
        assert_eq!(c["host"], h);
        assert_eq!(c["kind"], "helper");
    }

    #[test]
    fn routes_through_calls() {
        let mut core = HostCore::new();
        let all = json!(["tiles", "members", "window"]);
        let r = call(&mut core, json!({ "type": "route", "bundle": "b", "version": "1", "available": all }));
        assert_eq!(r["route"], "tiles");
        let r = call(
            &mut core,
            json!({ "type": "stepDown", "now": 1.0, "bundle": "b", "version": "1", "from": "tiles", "available": all, "why": "loop" }),
        );
        assert_eq!(r["route"], "members");
        let saved = call(&mut core, json!({ "type": "saveRoutes" }));
        let mut fresh = HostCore::new();
        call(&mut fresh, json!({ "type": "loadRoutes", "routes": saved["routes"] }));
        let r = call(&mut fresh, json!({ "type": "route", "bundle": "b", "version": "1", "available": all }));
        assert_eq!(r["route"], "members");
        assert_eq!(r["held"]["why"], "loop");
    }

    #[test]
    fn choose_through_a_call() {
        let mut core = HostCore::new();
        let w = |n: i64, on: bool, order: usize| json!({ "number": n, "pid": 7, "bounds": { "x": 0, "y": 0, "width": 1292, "height": 888 }, "onScreen": on, "order": order });
        let got = call(
            &mut core,
            json!({ "type": "choose", "server": [w(10, false, 0), w(13, true, 1)], "pid": 7, "main": 10, "focused": null, "serverAllowed": true }),
        );
        assert_eq!(got["choice"]["number"], 13);
        assert_eq!(got["choice"]["rule"], "onScreen");
    }

    #[test]
    fn constants_and_candidates() {
        let mut core = HostCore::new();
        let c = call(&mut core, json!({ "type": "constants" }));
        assert_eq!(c["budgets"]["size its tile"], 3);
        assert_eq!(c["budgets"]["leftover"], 2);
        assert_eq!(c["budgets"]["bring forward"], 1);
        assert_eq!(c["budgets"]["window mode"], 2);
        assert_eq!(c["goneGrace"], 1.0);
        let w = |n: i64, pid: u32, width: f64| json!({ "number": n, "pid": pid, "bounds": { "x": 0, "y": 0, "width": width, "height": 500 }, "order": n });
        let got = call(
            &mut core,
            json!({ "type": "candidates", "server": [w(3, 7, 800.0), w(1, 7, 800.0), w(2, 8, 800.0), w(4, 7, 50.0)], "pid": 7, "excluded": [3] }),
        );
        assert_eq!(got["candidates"], json!([1]));
    }

    #[test]
    fn next_poll_through_a_call() {
        let mut core = HostCore::new();
        let r = call(&mut core, json!({ "type": "nextPoll", "facts": { "hosting": true, "activeFor": 0.3 } }));
        assert_eq!(r["after"], 0.1);
        let r = call(&mut core, json!({ "type": "nextPoll", "facts": {} }));
        assert!(r["after"].is_null());
    }

    #[test]
    fn the_loop_in_parts_through_calls() {
        let mut core = HostCore::new();
        let situation = json!({ "phase": "shown", "member": true, "window": 1, "place": "margin", "onScreen": true,
                                "launchedByMargin": true, "tile": true, "tileStale": true });
        let decide = |core: &mut HostCore, now: f64| {
            call(
                core,
                json!({ "type": "decide", "now": now, "host": "app:w", "situation": situation, "desired": "shown" }),
            )
        };
        assert_eq!(decide(&mut core, 0.0)["correction"], json!({ "type": "sizeTile" }));
        let admit = |core: &mut HostCore, now: f64, guarded: bool| {
            call(
                core,
                json!({ "type": "admit", "now": now, "host": "app:w", "correction": { "type": "sizeTile" }, "guarded": guarded,
                               "identity": { "bundle": "com.apple.weather", "version": "4.1", "from": "tiles", "available": ["tiles", "members", "window"] } }),
            )
        };
        assert_eq!(admit(&mut core, 0.0, true), json!({ "type": "go", "tried": 1 }));
        assert_eq!(admit(&mut core, 0.3, true), json!({ "type": "go", "tried": 2 }));
        let stop = admit(&mut core, 0.6, true);
        assert_eq!(
            (stop["type"].clone(), stop["from"].clone(), stop["to"].clone()),
            (json!("stopped"), json!("tiles"), json!("members")),
            "{stop}"
        );
        assert!(stop["why"].as_str().is_some_and(|w| w.contains("3 times")), "{stop}");
        // Its budget (3 a show) spent: the old way's placing again next; then a show: its budgets anew.
        assert_eq!(admit(&mut core, 0.9, false)["tried"], 3);
        assert_eq!(decide(&mut core, 1.0)["correction"], json!({ "type": "placeAgain" }));
        call(&mut core, json!({ "type": "resetTries", "host": "app:w" }));
        assert_eq!(decide(&mut core, 1.1)["correction"], json!({ "type": "sizeTile" }));
        assert_eq!(
            call(&mut core, json!({ "type": "record", "now": 2.0, "host": "app:w", "key": "bring forward activate" }))
                ["tried"],
            1
        );
        assert_eq!(
            call(&mut core, json!({ "type": "tried", "now": 2.5, "host": "app:w", "key": "bring forward activate" }))["tried"],
            1
        );
        assert_eq!(
            call(&mut core, json!({ "type": "tried", "now": 40.0, "host": "app:w", "key": "bring forward activate" }))
                ["tried"],
            0
        );
        call(&mut core, json!({ "type": "forget", "host": "app:w" }));
        assert_eq!(
            call(
                &mut core,
                json!({ "type": "decide", "now": 41.0, "host": "app:w", "situation": { "phase": "parked" }, "desired": "parked" })
            )["correction"],
            Value::Null
        );
    }

    #[test]
    fn bad_input_is_an_error_never_a_panic() {
        let mut core = HostCore::new();
        for bad in ["", "{", "null", r#"{"type":"nope"}"#, r#"{"type":"step"}"#, r#"{"type":"react","now":"x"}"#] {
            let v: Value = serde_json::from_str(&core.call(bad)).unwrap();
            assert!(v["error"].is_string(), "{bad}: {v}");
        }
    }
}
