//! The budgets of Margin's own corrections that outlive a show (docs/CORE-REFACTOR.md step 2 part 4): how many times
//! within how long Margin puts a host back by itself before it gives up and says so. Not the loop guard's counts
//! (guard.rs stops a host for good on 3 within 5 s, until its route changes) nor the driver's tries (they start again
//! at every show): a stray's returns and the off-screen tries deliberately outlive a show, so each keeps its own.
//!
//! - `StrayReturns`: the one shown, found out of Margin's Space and brought back (`returnsMax` within
//!   `returnsWithin`; past it the list cleared and the host parked).
//! - `Reentry`: its window out of full screen by itself, put back into it (`returnsMax` within `returnsWithin`, then
//!   left to the reconciler, said once; a re-entry made resets the said).
//! - `OffInPlace` and `OffElsewhere`: the one shown, not on screen (its own `returnsMax` within `returnsWithin`, one
//!   list for both): in place once a show (said once a show), elsewhere said once (until it's newly visible).
//! - `CutRepair`: a cut pane put back under the panes it lies under (3 within 5 s, or 3 in a row that didn't take;
//!   then said once and held until its order is seen right, `cut_order_right`).
//!
//! Each keeps the Swift's order of filter, check and append (pinned per kind below). Nothing here allocates but a cut
//! pane's first repair (its id kept).

use std::collections::BTreeMap;

use super::{Handle, HostModel, Phase};

/// A cut pane's repairs: this many within `CUT_WITHIN` s, or this many in a row that didn't take.
pub const CUT_LIMIT: usize = 3;
pub const CUT_WITHIN: f64 = 5.0;

/// Which budget (the FFI's number).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    StrayReturns = 0,
    Reentry = 1,
    OffInPlace = 2,
    OffElsewhere = 3,
    CutRepair = 4,
}

impl Kind {
    pub fn from_u8(v: u8) -> Option<Kind> {
        Some(match v {
            0 => Kind::StrayReturns,
            1 => Kind::Reentry,
            2 => Kind::OffInPlace,
            3 => Kind::OffElsewhere,
            4 => Kind::CutRepair,
            _ => return None,
        })
    }
}

/// A budget asked before its action.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Spend {
    /// Go: the action is taken (`count`: the budget's entries now, this one in).
    Go { count: usize },
    /// Spent: not taken. `say`: said now (false: said already, or nothing to say); `count`: the entries counted;
    /// `streak`: a cut pane's, by the ones in a row that didn't take (else by its count within the time).
    Spent { say: bool, count: usize, streak: bool },
}

/// A cut pane's repairs, by its id (kept across its host made again, as the engine's were).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CutRepair {
    tries: Vec<f64>,
    said: bool,
    failed: usize,
}

/// Every cut pane's repairs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CutRepairs(BTreeMap<String, CutRepair>);

/// What the budgets read of the engine's options.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limits {
    pub returns_max: usize,
    pub returns_within: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { returns_max: 3, returns_within: 30.0 }
    }
}

impl HostModel {
    /// `h`'s budget of `kind` asked at `now`, before its action; spent when it says so. An unknown host: spent,
    /// nothing said.
    pub fn spend(&mut self, h: Handle, kind: Kind, now: f64) -> Spend {
        let Limits { returns_max: max, returns_within: within } = self.limits;
        let none = Spend::Spent { say: false, count: 0, streak: false };
        if kind == Kind::CutRepair {
            let Some(Some(s)) = self.slots.get(h as usize) else { return none };
            if !self.repairs.0.contains_key(s.id.as_str()) {
                self.repairs.0.insert(s.id.clone(), CutRepair::default());
            }
            let Some(r) = self.repairs.0.get_mut(s.id.as_str()) else { return none };
            if r.said {
                return none;
            }
            // (The tries within the time, kept so only when one is made: as the engine's.)
            let within_now = r.tries.iter().filter(|t| now - **t < CUT_WITHIN).count();
            if within_now >= CUT_LIMIT || r.failed >= CUT_LIMIT {
                r.said = true;
                return Spend::Spent { say: true, count: within_now, streak: r.failed >= CUT_LIMIT };
            }
            r.tries.retain(|t| now - *t < CUT_WITHIN);
            r.tries.push(now);
            return Spend::Go { count: r.tries.len() };
        }
        let Some(s) = self.get_mut(h) else { return none };
        match kind {
            Kind::StrayReturns => {
                // (Filtered, this one in, then checked: past the most, cleared and parked; said each time.)
                s.returns.retain(|t| now - *t < within);
                s.returns.push(now);
                let count = s.returns.len();
                if count > max {
                    s.returns.clear();
                    return Spend::Spent { say: true, count, streak: false };
                }
                Spend::Go { count }
            }
            Kind::Reentry => {
                s.reentries.retain(|t| now - *t < within);
                let count = s.reentries.len();
                if count >= max {
                    let say = !s.reentry_said;
                    s.reentry_said = true;
                    return Spend::Spent { say, count, streak: false };
                }
                s.reentries.push(now);
                s.reentry_said = false;
                Spend::Go { count: count + 1 }
            }
            Kind::OffInPlace => {
                // (In place: once a show, within the same list's budget; said once a show.)
                s.off_tries.retain(|t| now - *t < within);
                let count = s.off_tries.len();
                if s.off_acted_for == Some(s.visible_at) || count >= max {
                    let say = s.off_in_place_said != Some(s.visible_at);
                    s.off_in_place_said = Some(s.visible_at);
                    return Spend::Spent { say, count, streak: false };
                }
                s.off_acted_for = Some(s.visible_at);
                s.off_tries.push(now);
                Spend::Go { count: count + 1 }
            }
            Kind::OffElsewhere => {
                s.off_tries.retain(|t| now - *t < within);
                let count = s.off_tries.len();
                if count >= max {
                    let say = !s.off_said;
                    s.off_said = true;
                    return Spend::Spent { say, count, streak: false };
                }
                s.off_tries.push(now);
                Spend::Go { count: count + 1 }
            }
            Kind::CutRepair => none,
        }
    }

    /// A cut pane's repair done: whether it took (its window behind the panes it lies under). The ones in a row that
    /// didn't take, now (0: it took).
    pub fn repair_took(&mut self, h: Handle, took: bool) -> usize {
        let Some(Some(s)) = self.slots.get(h as usize) else { return 0 };
        let Some(r) = self.repairs.0.get_mut(s.id.as_str()) else { return 0 };
        r.failed = if took { 0 } else { r.failed + 1 };
        r.failed
    }

    /// A cut pane seen behind the panes it lies under, or out of the split: its repairs' say and streak start again
    /// (its tries within the time kept). Nothing allocated (the poll asks it).
    pub fn cut_order_right(&mut self, h: Handle) {
        let Some(Some(s)) = self.slots.get(h as usize) else { return };
        if let Some(r) = self.repairs.0.get_mut(s.id.as_str()) {
            r.said = false;
            r.failed = 0;
        }
    }

    // ---- the retry-once full-screen ladder: per host, per run (Tirth, 2026-11-22: not routes.rs's) ----

    /// A full-screen show failed and was backed out into window mode: tried again at its next show the first time,
    /// window mode from then on. True: tried again.
    pub fn full_screen_failed(&mut self, h: Handle) -> bool {
        let Some(s) = self.get_mut(h) else { return false };
        s.full_screen_failures += 1;
        s.retry_full_screen = s.full_screen_failures == 1;
        s.retry_full_screen
    }

    /// Another window of its app's adopted in its place, in window mode: a full-screen member shown has its failures
    /// forgotten (its app's own doing, not a failure); full screen tried again at its next show when its window can
    /// go full screen and it never failed. Asked before the host's fields change (it reads its phase and member).
    pub fn adopted(&mut self, h: Handle, can_full_screen: bool) {
        let Some(s) = self.get_mut(h) else { return };
        if s.phase == Phase::Shown && s.member {
            s.full_screen_failures = 0;
        }
        s.retry_full_screen = can_full_screen && s.full_screen_failures == 0;
    }

    /// The loop guard moved it to window mode: never tried in full screen again this run.
    pub fn moved_to_window(&mut self, h: Handle) {
        let Some(s) = self.get_mut(h) else { return };
        s.retry_full_screen = false;
        s.full_screen_failures = s.full_screen_failures.max(2);
    }
}

#[cfg(test)]
mod tests;
