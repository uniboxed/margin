//! When the hosting engine looks again (docs/ARCHITECTURE-PLAN.md, "Scheduler and budgets"). It used to look every
//! 0.25 s whenever anything was hosted, and 20 times more in the 2 s after each show, whatever happened: at rest with
//! three apps hosted that was 3.4% of a CPU (2026-11-18, the idle-cost part). Events say when something changed (an
//! app activated, a Space changed, a window came, went, moved or resized, an engine event); the poll is the net
//! under them, as fast as the moment needs:
//!
//! ```text
//!   just after activity (an event, an operation, a show)   every 0.1 s for 2 s   (macOS's own changes landing late)
//!   something unconfirmed (a read to repeat, a retry due)  every 0.25 s           (the second read of two)
//!   at rest with apps hosted                               every 1.5 s            (a change no event told)
//!   only browser copies linked                             every 2 s
//!   nothing                                                none                   (an event starts it again)
//! ```

use serde::{Deserialize, Serialize};

pub const FAST: f64 = 0.1;
pub const FAST_FOR: f64 = 2.0;
pub const SUSPECT: f64 = 0.25;
pub const REST: f64 = 1.5;
pub const LINKS: f64 = 2.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PollFacts {
    /// Apps hosted (or started by Margin, or Safari windows to close).
    pub hosting: bool,
    /// A browser copy linked (its windows' drawn state, Margin's keys).
    pub links: bool,
    /// Something not settled: a read to confirm, an exit, a retry, a drag, an operation queued.
    pub pending: bool,
    /// Seconds since the last activity (None: none yet).
    pub active_for: Option<f64>,
}

/// Seconds until the next look (None: none until an event).
pub fn next_poll(f: &PollFacts) -> Option<f64> {
    if f.hosting && f.active_for.is_some_and(|a| (0.0..FAST_FOR).contains(&a)) {
        return Some(FAST);
    }
    if f.pending {
        return Some(SUSPECT);
    }
    if f.hosting {
        return Some(REST);
    }
    if f.links {
        return Some(LINKS);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(hosting: bool, links: bool, pending: bool, active_for: Option<f64>) -> PollFacts {
        PollFacts { hosting, links, pending, active_for }
    }

    #[test]
    fn the_cadence() {
        assert_eq!(next_poll(&facts(true, false, false, Some(0.5))), Some(FAST), "just after a show");
        assert_eq!(next_poll(&facts(true, false, false, Some(2.5))), Some(REST), "at rest");
        assert_eq!(next_poll(&facts(true, false, true, Some(5.0))), Some(SUSPECT), "a read to confirm");
        assert_eq!(next_poll(&facts(false, true, false, None)), Some(LINKS), "only a copy linked");
        assert_eq!(next_poll(&facts(false, false, false, None)), None, "nothing: no poll");
        assert_eq!(
            next_poll(&facts(false, false, true, None)),
            Some(SUSPECT),
            "an exit or a retry with nothing hosted"
        );
        assert_eq!(
            next_poll(&facts(false, true, false, Some(0.1))),
            Some(LINKS),
            "activity with nothing hosted isn't a reason"
        );
        assert_eq!(next_poll(&facts(true, true, false, Some(-1.0))), Some(REST), "a clock that went back: at rest");
    }

    // The old engine: 4 a second at rest. The new: 1 every 1.5 s, a sixth.
    const _: () = assert!(REST >= 1.5);
}
