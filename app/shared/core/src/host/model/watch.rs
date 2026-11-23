//! What the poll and its looks decide of a host that isn't where it should be (docs/CORE-REFACTOR.md step 2 part 7):
//! its window's reads counted (two unread in a row: gone), what's done with a window gone, a stray counted and what's
//! done with it in its turn, and a visible host found off screen. OS-neutral: a window's place is where its Spaces
//! put it (`Place`), Margin's Space being the page area's place on the Mac.
//!
//! Each decision is asked at the point the OS side made it, between the same reads: the OS reads lazily (a read only
//! when the decisions before it pass), so a decision that needs a read the OS hasn't made answers so (`Gone::AskRuns`)
//! and is asked again with it. Nothing here allocates.

use super::budget::{Kind, Spend};
use super::{Handle, HostModel, Phase};

/// Where a window is by its Spaces as read: unread, in no Space, in Margin's Space alone (the page area's place), or
/// elsewhere (another Space, or Margin's and another).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Place {
    Unread = 0,
    Nowhere = 1,
    InPage = 2,
    Elsewhere = 3,
}

impl Place {
    pub fn from_u8(v: u8) -> Place {
        match v {
            1 => Place::Nowhere,
            2 => Place::InPage,
            3 => Place::Elsewhere,
            _ => Place::Unread,
        }
    }
}

/// The poll's read of a host's window this time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Read {
    /// Its app closed it (it said so) and it's in no Space or off screen: gone at once, as two reads that missed.
    Closed = 0,
    /// Its bounds didn't read.
    Unread = 1,
    /// Its bounds read.
    Read = 2,
}

/// What the poll's count of its reads says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Counted {
    /// Twice in a row unread (one read can miss mid-transition): gone (`gone`).
    Gone,
    /// Unread this poll: skipped (gone or mid-transition, never taken for a stray).
    Skip,
    /// Read: where it is looked at (`place`).
    Read,
}

/// A window gone, its host's fate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gone {
    /// Its process to be read again (the OS reads it only now) and asked again.
    AskRuns,
    /// Gone already: nothing more.
    Nothing,
    /// Parked, an app Margin started, still running: reopened at its next show (marked gone now).
    Reopen,
    /// Shown, its app still running: another main window of its app's adopted within the grace, else its item
    /// closed (the reconciler's; marked gone now).
    Shown,
    /// Its window gone as any: the host goes.
    WindowGone,
}

/// A stray in its turn, read again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stray {
    /// Both where they should be now: an operation put it right, or the poll's read was a move landing.
    Nothing,
    /// Margin's window out of its Space too (macOS took it out of full screen): parked with nothing shown.
    Park,
    /// Its returns spent (`count` within the time): parked alone, said.
    ParkOnly { count: usize },
    /// Brought back (through the loop guard's "put back", the OS side's).
    PutBack,
}

/// The one shown (or another visible host) off screen, read again in its turn.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OffScreen {
    /// In Margin's Space, the current one, with Margin's window on screen: its app brought forward, then placed again
    /// (once a show).
    InPlace,
    /// In place, spent for this show or its budget: said (`say`) and left as it is.
    InPlaceSpent { say: bool },
    /// Elsewhere: Margin's Space made current again, its window moved into it, as each says.
    Act { make_current: bool, move_in: bool },
    /// Elsewhere, its budget spent (`count`): said once, left as it is.
    GiveUp { say: bool, count: usize },
    /// Held by the loop guard's per-second hold (until `until`): nothing this time.
    Held { until: f64 },
}

/// What an off-screen look read in its turn: Margin's window on screen (`margin_on`), the host's window on screen by
/// the list (`host_on`), Margin's Space the current one of its display (`current_is_margin`), its window's place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OffFacts {
    pub margin_on: bool,
    pub host_on: bool,
    pub current_is_margin: bool,
    pub place: Place,
}

/// Whether the on-screen look still finds something missing: Margin's window and the host's both listed is fine,
/// and so is Margin's listed with the host's own read on screen (`own_on`: None before that read).
pub fn still_off(margin_on: bool, host_on: bool, own_on: Option<bool>) -> bool {
    !(margin_on && host_on) && !(margin_on && own_on == Some(true))
}

impl HostModel {
    /// The poll's read of `h`'s window: its unread polls counted (its app's close counts as two), a read resets the
    /// count and its "gone".
    pub fn poll_read(&mut self, h: Handle, read: Read) -> Counted {
        let Some(s) = self.get_mut(h) else { return Counted::Skip };
        match read {
            Read::Closed => s.unread = (s.unread + 1).max(2),
            Read::Unread => s.unread += 1,
            Read::Read => {
                s.unread = 0;
                s.gone = false;
            }
        }
        if s.unread >= 2 {
            Counted::Gone
        } else if s.unread > 0 {
            Counted::Skip
        } else {
            Counted::Read
        }
    }

    /// Its window gone (`poll_read`): what's done. `runs`: its process read again (None: not yet; asked for only when
    /// it decides). `parked_own`: an app Margin started, its host parked. Marks it gone (at `now`) when it waits.
    pub fn poll_gone(&mut self, h: Handle, now: f64, runs: Option<bool>, parked_own: bool) -> Gone {
        let Some(s) = self.get_mut(h) else { return Gone::Nothing };
        if s.gone {
            return Gone::Nothing;
        }
        if s.phase == Phase::Preparing {
            return Gone::WindowGone;
        }
        let Some(runs) = runs else { return Gone::AskRuns };
        if !runs {
            return Gone::WindowGone;
        }
        if parked_own {
            s.gone = true;
            s.gone_at = Some(now);
            return Gone::Reopen;
        }
        if s.phase == Phase::Shown {
            s.gone = true;
            s.gone_at = Some(now);
            return Gone::Shown;
        }
        Gone::WindowGone
    }

    /// Its window read, where it is (`margin_here`: Margin's window in its Space): where it mustn't be counted (the one
    /// shown outside Margin's Space or with Margin's window out of it, a parked one in a Space), twice in a row a
    /// stray; the one shown in no Space at once (nothing puts a window there but a Space destroyed under it). True:
    /// the one shown, brought back in its turn (`stray`), its count started again.
    pub fn poll_place(&mut self, h: Handle, place: Place, margin_here: bool) -> bool {
        let Some(s) = self.get_mut(h) else { return false };
        let strayed = match s.phase {
            Phase::Shown => !margin_here || matches!(place, Place::Nowhere | Place::Elsewhere),
            Phase::Parked => matches!(place, Place::InPage | Place::Elsewhere),
            Phase::Preparing => false,
        };
        s.strays = if strayed { s.strays + 1 } else { 0 };
        let nowhere = s.phase == Phase::Shown && margin_here && place == Place::Nowhere;
        if s.phase == Phase::Shown && (s.strays >= 2 || nowhere) {
            s.strays = 0;
            return true;
        }
        false
    }

    /// A stray (the one shown, visible) in its turn, read again: its window's place now, Margin's window in its Space
    /// as the poll read it (`margin_here`) and now (`margin_now`). Its returns' budget spent when it's brought back.
    pub fn stray(&mut self, h: Handle, now: f64, place: Place, margin_here: bool, margin_now: bool) -> Stray {
        if margin_now && place == Place::InPage {
            return Stray::Nothing;
        }
        if !(margin_here && margin_now) {
            return Stray::Park;
        }
        match self.spend(h, Kind::StrayReturns, now, || None) {
            Spend::Spent { count, .. } => Stray::ParkOnly { count },
            _ => Stray::PutBack,
        }
    }

    /// A visible host off screen in its turn, read again (`f`). Its own budget (a split's other panes' tries never use
    /// it up), each action through `hold`.
    pub fn off_screen(&mut self, h: Handle, now: f64, f: &OffFacts, hold: impl FnOnce() -> Option<f64>) -> OffScreen {
        let OffFacts { margin_on, host_on, current_is_margin, place } = *f;
        if margin_on && current_is_margin && place == Place::InPage {
            return match self.spend(h, Kind::OffInPlace, now, hold) {
                Spend::Go { .. } => OffScreen::InPlace,
                Spend::Held { until } => OffScreen::Held { until },
                Spend::Spent { say, .. } => OffScreen::InPlaceSpent { say },
            };
        }
        match self.spend(h, Kind::OffElsewhere, now, hold) {
            Spend::Go { .. } => OffScreen::Act {
                make_current: !current_is_margin || !margin_on,
                move_in: !host_on && (place != Place::InPage || !margin_on),
            },
            Spend::Held { until } => OffScreen::Held { until },
            Spend::Spent { say, count, .. } => OffScreen::GiveUp { say, count },
        }
    }
}

#[cfg(test)]
mod tests;
