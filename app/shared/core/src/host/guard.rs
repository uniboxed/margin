//! The loop guard (docs/ARCHITECTURE-PLAN.md, "Reconciler"): generic, so a quirk nobody has seen yet still ends.
//! Margin corrects what it sees; an app or macOS can answer the correction with a change that asks for the same
//! correction again (2026-11-18 13:30: Weather answered each tile resize with a window whose close re-laid the tiles
//! out, 54 rounds in 18 s; 2026-11-17: parked tiles sized, a window drawn, the tiles laid out again, ~3 a second).
//!
//! Only reactions count: a correction Margin makes because something changed that nobody asked for. What the person
//! does (a drag, a switch, a theme) is never a loop and clears the counts, so three drags in five seconds are three
//! resizes, not a loop. The same reaction for the same host `LIMIT` times within `WITHIN` seconds: the last one isn't
//! applied, the host is stopped (its caller moves it to a safer route and says so), and it stays stopped until its
//! route changes or the person acts on it. Above all of it, `PER_SECOND` reactions a second across every host stops
//! every reaction for a second: whatever runs away, Margin doesn't run with it. Margin's own budgeted corrections
//! (model/budget.rs: a re-entry into full screen, a look off screen, a cut pane's repair) count toward that hold too
//! (`budgeted`), never toward a host's stop: their budgets are their own.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

/// The same reaction this many times within `WITHIN`: the last isn't applied.
pub const LIMIT: usize = 3;
pub const WITHIN: f64 = 5.0;
/// Reactions a second across every host before all of them wait a second.
pub const PER_SECOND: usize = 12;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "camelCase")]
pub enum Verdict {
    Go,
    /// Not applied: `host` reacted `key` `count` times within `within` s. Its caller moves it to a safer route.
    Stop {
        host: String,
        key: String,
        count: usize,
        within: f64,
    },
    /// Not applied: too many reactions across every host; wait until `until`.
    Hold {
        until: f64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stopped {
    pub key: String,
    pub at: f64,
    pub count: usize,
}

#[derive(Debug, Default)]
pub struct LoopGuard {
    counts: BTreeMap<(String, String), VecDeque<f64>>,
    all: VecDeque<f64>,
    held_until: Option<f64>,
    stopped: BTreeMap<String, Stopped>,
}

impl LoopGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// A reaction about to be applied for `host` (an app's host name, or "margin" for Margin's own window): go, or
    /// stop (this host), or hold (everything).
    pub fn react(&mut self, now: f64, host: &str, key: &str) -> Verdict {
        if let Some(s) = self.stopped.get(host) {
            return Verdict::Stop { host: host.into(), key: s.key.clone(), count: s.count, within: WITHIN };
        }
        if let Some(until) = self.held_until {
            if now < until {
                return Verdict::Hold { until };
            }
            self.held_until = None;
        }
        while self.all.front().is_some_and(|t| now - t >= 1.0) {
            self.all.pop_front();
        }
        if self.all.len() >= PER_SECOND {
            let until = now + 1.0;
            self.held_until = Some(until);
            return Verdict::Hold { until };
        }
        let times = self.counts.entry((host.into(), key.into())).or_default();
        while times.front().is_some_and(|t| now - t > WITHIN) {
            times.pop_front();
        }
        if times.len() + 1 >= LIMIT {
            let count = times.len() + 1;
            times.clear();
            self.stopped.insert(host.into(), Stopped { key: key.into(), at: now, count });
            return Verdict::Stop { host: host.into(), key: key.into(), count, within: WITHIN };
        }
        times.push_back(now);
        self.all.push_back(now);
        Verdict::Go
    }

    /// One of Margin's own budgeted corrections about to be made (host/model/budget.rs: a re-entry into full screen, a
    /// look off screen, a cut pane's repair): counted toward the `PER_SECOND` hold as a reaction is (Tirth,
    /// 2026-11-22: a loop through any of them is held like the others), never toward a host's stop (its budget is its
    /// own). Some(until): held, not made (and not counted).
    pub fn budgeted(&mut self, now: f64) -> Option<f64> {
        if let Some(until) = self.held_until {
            if now < until {
                return Some(until);
            }
            self.held_until = None;
        }
        while self.all.front().is_some_and(|t| now - t >= 1.0) {
            self.all.pop_front();
        }
        if self.all.len() >= PER_SECOND {
            let until = now + 1.0;
            self.held_until = Some(until);
            return Some(until);
        }
        self.all.push_back(now);
        None
    }

    /// When the per-second hold now in force ends (None: nothing held at `now`): a caller that found its step held
    /// waits for this moment instead of asking again at once. Reads only.
    pub fn held_until(&self, now: f64) -> Option<f64> {
        self.held_until.filter(|until| now < *until)
    }

    /// The person acted (on `host`, or on everything: a drag, a theme, a display change): nothing they caused is a
    /// loop, so the counts start again. A stopped host stays stopped until its route changes (`cleared`).
    pub fn person(&mut self, host: Option<&str>) {
        match host {
            Some(h) => self.counts.retain(|(owner, _), _| owner != h),
            None => self.counts.clear(),
        }
    }

    /// `host`'s route changed (moved to a safer one), it was closed, or it starts again: its stop and counts go.
    pub fn cleared(&mut self, host: &str) {
        self.stopped.remove(host);
        self.counts.retain(|(owner, _), _| owner != host);
    }

    pub fn stopped(&self, host: &str) -> Option<&Stopped> {
        self.stopped.get(host)
    }

    /// The earliest time a count lapses (none: nothing to wake for): the guard itself never needs a timer, but a
    /// caller that sleeps until the next event can use it.
    pub fn next_wake(&self) -> Option<f64> {
        let mut out: Option<f64> = self.held_until;
        for t in self.counts.values().filter_map(|v| v.front()) {
            let at = t + WITHIN;
            out = Some(out.map_or(at, |o| o.min(at)));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_third_round_within_five_seconds_stops_that_host() {
        let mut g = LoopGuard::new();
        // Weather's rounds came every ~0.33 s.
        assert_eq!(g.react(0.0, "app:com.apple.weather", "size its tile"), Verdict::Go);
        assert_eq!(g.react(0.33, "app:com.apple.weather", "size its tile"), Verdict::Go);
        let v = g.react(0.66, "app:com.apple.weather", "size its tile");
        assert!(matches!(v, Verdict::Stop { count: 3, .. }), "{v:?}");
        // Stopped: any reaction for it is refused until its route changes.
        assert!(matches!(g.react(10.0, "app:com.apple.weather", "put back"), Verdict::Stop { .. }));
        // Others aren't.
        assert_eq!(g.react(0.7, "app:com.apple.Maps", "size its tile"), Verdict::Go);
        g.cleared("app:com.apple.weather");
        assert_eq!(g.react(11.0, "app:com.apple.weather", "size its tile"), Verdict::Go);
    }

    #[test]
    fn spread_out_reactions_are_not_a_loop() {
        let mut g = LoopGuard::new();
        // Messages strayed every ~6 s: put back each time.
        for i in 0..10 {
            assert_eq!(g.react(i as f64 * 6.0, "app:com.apple.MobileSMS", "put back"), Verdict::Go, "round {i}");
        }
        // Different reactions for one host don't add up.
        assert_eq!(g.react(100.0, "h", "a"), Verdict::Go);
        assert_eq!(g.react(100.1, "h", "b"), Verdict::Go);
        assert_eq!(g.react(100.2, "h", "a"), Verdict::Go);
        assert_eq!(g.react(100.3, "h", "b"), Verdict::Go);
    }

    #[test]
    fn what_the_person_does_starts_the_count_again() {
        let mut g = LoopGuard::new();
        assert_eq!(g.react(0.0, "h", "size its tile"), Verdict::Go);
        assert_eq!(g.react(1.0, "h", "size its tile"), Verdict::Go);
        g.person(None); // a drag's end
        assert_eq!(g.react(2.0, "h", "size its tile"), Verdict::Go);
        assert_eq!(g.react(2.5, "h", "size its tile"), Verdict::Go);
        g.person(Some("h"));
        assert_eq!(g.react(3.0, "h", "size its tile"), Verdict::Go);
        assert_eq!(g.stopped("h"), None);
    }

    #[test]
    fn margins_budgeted_corrections_count_toward_the_hold_never_a_stop() {
        let mut g = LoopGuard::new();
        // Twelve in a second, all one host's: never a stop (its budget is its own), the thirteenth held.
        for i in 0..PER_SECOND {
            assert_eq!(g.budgeted(0.05 * i as f64), None, "{i}");
        }
        assert_eq!(g.stopped("h"), None);
        assert_eq!(g.budgeted(0.7), Some(1.7));
        // Held: every reaction too, until it lapses.
        assert_eq!(g.react(1.0, "other", "k"), Verdict::Hold { until: 1.7 });
        assert_eq!(g.budgeted(1.69), Some(1.7));
        assert_eq!(g.budgeted(1.7), None, "lapsed");
        // Reactions fill the same second: a budgeted one after eleven of them goes, the next is held.
        let mut g = LoopGuard::new();
        for i in 0..PER_SECOND - 1 {
            assert_eq!(g.react(0.01 * i as f64, &format!("h{i}"), "k"), Verdict::Go);
        }
        assert_eq!(g.budgeted(0.5), None);
        assert_eq!(g.budgeted(0.6), Some(1.6));
        // Ten a second, for ten seconds: under the hold, never held.
        let mut g = LoopGuard::new();
        for i in 0..100 {
            assert_eq!(g.budgeted(i as f64 * 0.1), None, "{i}");
        }
        assert_eq!(g.held_until(10.0), None);
    }

    #[test]
    fn the_holds_end_is_answered_until_it_lapses() {
        let mut g = LoopGuard::new();
        assert_eq!(g.held_until(0.0), None, "nothing held");
        for i in 0..PER_SECOND {
            g.react(0.01 * i as f64, &format!("h{i}"), "k");
        }
        assert_eq!(g.held_until(0.5), None, "twelve in, none refused yet: no hold in force");
        assert_eq!(g.budgeted(0.5), Some(1.5));
        assert_eq!(g.held_until(0.5), Some(1.5), "the moment to ask again");
        assert_eq!(g.held_until(1.4999), Some(1.5));
        assert_eq!(g.held_until(1.5), None, "lapsed at its end");
        // Only a read: asking it changes nothing; the next action at the end goes.
        assert_eq!(g.held_until(0.9), Some(1.5));
        assert_eq!(g.budgeted(1.5), None);
        assert_eq!(g.held_until(1.5), None);
    }

    #[test]
    fn too_many_across_every_host_holds_them_all_for_a_second() {
        let mut g = LoopGuard::new();
        for i in 0..PER_SECOND {
            assert_eq!(g.react(0.01 * i as f64, &format!("h{i}"), "k"), Verdict::Go);
        }
        let v = g.react(0.5, "other", "k");
        assert_eq!(v, Verdict::Hold { until: 1.5 });
        assert_eq!(g.react(1.0, "other", "k"), Verdict::Hold { until: 1.5 });
        assert_eq!(g.react(1.6, "other", "k"), Verdict::Go);
        assert!(g.next_wake().is_some());
    }
}
