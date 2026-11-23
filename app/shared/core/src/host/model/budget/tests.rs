//! Each budget's behaviour, in the Swift's order of filter, check and append (the engine's tests pin it with the
//! stand-in world: T/host-tests.swift's stray and off-screen cases, T/screen-engine-tests.swift's re-entry, the cut
//! order's repair in T/multi-host-tests.swift).

use super::*;
use crate::host::model::{Field, Phase};

fn none() -> Option<f64> {
    None
}

fn model() -> (HostModel, Handle) {
    let mut m = HostModel::new();
    let h = m.add("app:com.apple.MobileSMS", "com.apple.MobileSMS", 41, 500);
    (m, h)
}

#[test]
fn a_strays_returns_three_within_thirty_seconds_the_fourth_parks() {
    let (mut m, h) = model();
    assert_eq!(m.spend(h, Kind::StrayReturns, 0.0, none), Spend::Go { count: 1 });
    assert_eq!(m.spend(h, Kind::StrayReturns, 10.0, none), Spend::Go { count: 2 });
    assert_eq!(m.spend(h, Kind::StrayReturns, 20.0, none), Spend::Go { count: 3 });
    // (Appended before the check: the fourth is counted, said, and the list cleared.)
    assert_eq!(m.spend(h, Kind::StrayReturns, 29.0, none), Spend::Spent { say: true, count: 4, streak: false });
    assert!(m.times(h, Field::Returns).is_empty());
    assert_eq!(m.spend(h, Kind::StrayReturns, 29.5, none), Spend::Go { count: 1 }, "parked, then a fresh budget");
    // 30 s after a return it no longer counts (strictly within).
    let (mut m, h) = model();
    for t in [0.0, 10.0, 20.0] {
        m.spend(h, Kind::StrayReturns, t, none);
    }
    assert_eq!(m.spend(h, Kind::StrayReturns, 30.0, none), Spend::Go { count: 3 });
}

#[test]
fn a_reentry_three_within_thirty_seconds_then_said_once() {
    let (mut m, h) = model();
    for (i, t) in [0.0, 1.0, 2.0].into_iter().enumerate() {
        assert_eq!(m.spend(h, Kind::Reentry, t, none), Spend::Go { count: i + 1 });
    }
    assert_eq!(m.spend(h, Kind::Reentry, 3.0, none), Spend::Spent { say: true, count: 3, streak: false });
    assert_eq!(m.spend(h, Kind::Reentry, 4.0, none), Spend::Spent { say: false, count: 3, streak: false }, "said once");
    // (Filtered before the check: not appended when spent.)
    assert_eq!(m.times(h, Field::Reentries), &[0.0, 1.0, 2.0]);
    assert_eq!(m.spend(h, Kind::Reentry, 30.0, none), Spend::Go { count: 3 }, "the first lapsed");
    assert_eq!(m.int(h, Field::ReentrySaid), 0, "a re-entry resets the said");
    assert_eq!(m.spend(h, Kind::Reentry, 30.5, none), Spend::Spent { say: true, count: 3, streak: false });
}

#[test]
fn off_screen_in_place_once_a_show_said_once_a_show() {
    let (mut m, h) = model();
    m.set_real(h, Field::VisibleAt, Some(100.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 101.0, none), Spend::Go { count: 1 });
    assert_eq!(m.real(h, Field::OffActedFor), Some(100.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 102.0, none), Spend::Spent { say: true, count: 1, streak: false });
    assert_eq!(m.spend(h, Kind::OffInPlace, 103.0, none), Spend::Spent { say: false, count: 1, streak: false });
    // Shown again: once more, said again when spent.
    m.set_real(h, Field::VisibleAt, Some(110.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 111.0, none), Spend::Go { count: 2 });
    assert_eq!(m.spend(h, Kind::OffInPlace, 112.0, none), Spend::Spent { say: true, count: 2, streak: false });
    // The list's budget too: three within 30 s, whatever the shows.
    m.set_real(h, Field::VisibleAt, Some(120.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 121.0, none), Spend::Go { count: 3 });
    m.set_real(h, Field::VisibleAt, Some(122.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 123.0, none), Spend::Spent { say: true, count: 3, streak: false });
    // (Filtered and kept so even when spent: the engine stored the filtered list first.)
    m.set_times(h, Field::OffTries, &[0.0, 200.0]);
    m.set_real(h, Field::VisibleAt, Some(300.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 229.0, none), Spend::Go { count: 2 });
    assert_eq!(m.times(h, Field::OffTries), &[200.0, 229.0]);
}

#[test]
fn off_screen_elsewhere_three_within_thirty_seconds_said_once() {
    let (mut m, h) = model();
    for (i, t) in [0.0, 1.0, 2.0].into_iter().enumerate() {
        assert_eq!(m.spend(h, Kind::OffElsewhere, t, none), Spend::Go { count: i + 1 });
    }
    assert_eq!(m.spend(h, Kind::OffElsewhere, 3.0, none), Spend::Spent { say: true, count: 3, streak: false });
    assert_eq!(m.spend(h, Kind::OffElsewhere, 4.0, none), Spend::Spent { say: false, count: 3, streak: false });
    // (Its said reset when it's newly visible: the engine's.)
    m.set_int(h, Field::OffSaid, 0);
    assert_eq!(m.spend(h, Kind::OffElsewhere, 5.0, none), Spend::Spent { say: true, count: 3, streak: false });
    // One list for both: in place's tries count here too.
    let (mut m, h) = model();
    m.spend(h, Kind::OffInPlace, 0.0, none);
    assert_eq!(m.spend(h, Kind::OffElsewhere, 1.0, none), Spend::Go { count: 2 });
}

#[test]
fn a_cut_panes_repair_three_within_five_seconds_or_three_that_didnt_take() {
    let (mut m, h) = model();
    for (i, t) in [0.0, 1.0, 2.0].into_iter().enumerate() {
        assert_eq!(m.spend(h, Kind::CutRepair, t, none), Spend::Go { count: i + 1 });
        assert_eq!(m.repair_took(h, true), 0);
    }
    assert_eq!(m.spend(h, Kind::CutRepair, 3.0, none), Spend::Spent { say: true, count: 3, streak: false });
    assert_eq!(m.spend(h, Kind::CutRepair, 30.0, none), Spend::Spent { say: false, count: 0, streak: false }, "held");
    m.cut_order_right(h);
    assert_eq!(m.spend(h, Kind::CutRepair, 30.0, none), Spend::Go { count: 1 }, "seen right: again");
    // Three in a row that didn't take, spread out: the streak.
    let (mut m, h) = model();
    for (i, t) in [0.0, 10.0, 20.0].into_iter().enumerate() {
        assert_eq!(m.spend(h, Kind::CutRepair, t, none), Spend::Go { count: 1 });
        assert_eq!(m.repair_took(h, false), i + 1);
    }
    assert_eq!(m.spend(h, Kind::CutRepair, 30.0, none), Spend::Spent { say: true, count: 0, streak: true });
    // Kept by its id: a host made again with the same id is still held.
    m.remove(h);
    let again = m.add("app:com.apple.MobileSMS", "com.apple.MobileSMS", 42, 500);
    assert_eq!(m.spend(again, Kind::CutRepair, 31.0, none), Spend::Spent { say: false, count: 0, streak: false });
    m.cut_order_right(again);
    assert_eq!(m.spend(again, Kind::CutRepair, 31.0, none), Spend::Go { count: 1 });
    // Another host's are its own.
    let other = m.add("app:x", "x", 43, 501);
    assert_eq!(m.spend(other, Kind::CutRepair, 31.0, none), Spend::Go { count: 1 });
    // An unknown host: spent, nothing said.
    assert_eq!(m.spend(99, Kind::CutRepair, 0.0, none), Spend::Spent { say: false, count: 0, streak: false });
    assert_eq!(m.spend(99, Kind::Reentry, 0.0, none), Spend::Spent { say: false, count: 0, streak: false });
}

#[test]
fn the_limits_are_the_engines_options() {
    let (mut m, h) = model();
    m.limits = Limits { returns_max: 1, returns_within: 5.0 };
    assert_eq!(m.spend(h, Kind::Reentry, 0.0, none), Spend::Go { count: 1 });
    assert_eq!(m.spend(h, Kind::Reentry, 4.9, none), Spend::Spent { say: true, count: 1, streak: false });
    assert_eq!(m.spend(h, Kind::Reentry, 5.0, none), Spend::Go { count: 1 });
    assert_eq!(m.spend(h, Kind::StrayReturns, 0.0, none), Spend::Go { count: 1 });
    assert_eq!(m.spend(h, Kind::StrayReturns, 1.0, none), Spend::Spent { say: true, count: 2, streak: false });
}

#[test]
fn the_full_screen_ladder_once_per_host_per_run() {
    let (mut m, h) = model();
    assert!(m.full_screen_failed(h), "the first failure: tried again at its next show");
    assert!(!m.full_screen_failed(h), "again: window mode from then on");
    assert_eq!(m.int(h, Field::FullScreenFailures), 2);
    // Adopted: a shown member's failures forgotten (its app's own doing), tried again if it can go full screen.
    m.set_int(h, Field::Phase, Phase::Shown as i64);
    m.set_int(h, Field::Member, 1);
    m.adopted(h, true);
    assert_eq!((m.int(h, Field::FullScreenFailures), m.int(h, Field::RetryFullScreen)), (0, 1));
    m.adopted(h, false);
    assert_eq!(m.int(h, Field::RetryFullScreen), 0, "it can't go full screen");
    // Not a shown member: its failures kept, not tried again.
    let (mut m, h) = model();
    m.full_screen_failed(h);
    m.adopted(h, true);
    assert_eq!((m.int(h, Field::FullScreenFailures), m.int(h, Field::RetryFullScreen)), (1, 0));
    // The loop guard's move to window mode: never again; a failure after it stays window mode.
    let (mut m, h) = model();
    m.set_int(h, Field::RetryFullScreen, 1);
    m.moved_to_window(h);
    assert_eq!((m.int(h, Field::FullScreenFailures), m.int(h, Field::RetryFullScreen)), (2, 0));
    assert!(!m.full_screen_failed(h));
    m.set_int(h, Field::FullScreenFailures, 5);
    m.moved_to_window(h);
    assert_eq!(m.int(h, Field::FullScreenFailures), 5, "at least 2, never fewer");
}

// ---- each budget's action counts toward the loop guard's per-second hold (Tirth, 2026-11-22) ----

use crate::host::api::HostCore;
use crate::host::guard::{PER_SECOND, Verdict};

fn core_of(n: usize) -> (HostCore, Vec<Handle>) {
    let mut c = HostCore::new();
    let hs = (0..n).map(|i| c.model.add(&format!("app:{i}"), "x", i as i64, i as i64)).collect();
    (c, hs)
}

#[test]
fn a_budgets_actions_past_twelve_a_second_are_held() {
    // Thirteen hosts each leaving full screen within one second (a loop through the re-entry): twelve go, the
    // thirteenth held, nothing of its budget spent.
    let (mut c, hs) = core_of(PER_SECOND + 1);
    for (i, h) in hs.iter().take(PER_SECOND).enumerate() {
        assert_eq!(c.spend(*h, Kind::Reentry, 0.05 * i as f64, true), Spend::Go { count: 1 }, "{i}");
    }
    let last = hs[PER_SECOND];
    assert_eq!(c.spend(last, Kind::Reentry, 0.9, true), Spend::Held { until: 1.9 });
    assert!(c.model.times(last, Field::Reentries).is_empty(), "held: nothing spent");
    // Held: every kind, and the guard's reactions too, until it lapses.
    assert_eq!(c.spend(hs[0], Kind::OffElsewhere, 1.0, true), Spend::Held { until: 1.9 });
    assert_eq!(c.spend(hs[0], Kind::OffInPlace, 1.0, true), Spend::Held { until: 1.9 });
    assert_eq!(c.spend(hs[0], Kind::CutRepair, 1.0, true), Spend::Held { until: 1.9 });
    assert_eq!(c.model.real(hs[0], Field::OffActedFor), None, "in place: not acted for this show");
    assert!(c.model.times(hs[0], Field::OffTries).is_empty());
    assert_eq!(c.driver.guard.react(1.5, "app:0", "size its tile"), Verdict::Hold { until: 1.9 });
    assert_eq!(c.spend(last, Kind::Reentry, 1.9, true), Spend::Go { count: 1 }, "lapsed");
    // A budget already spent says so as before (the hold asked only with room).
    let (mut c, hs) = core_of(1);
    for t in [0.0, 1.0, 2.0] {
        c.spend(hs[0], Kind::Reentry, t, true);
    }
    for i in 0..PER_SECOND {
        c.driver.guard.react(3.0 + 0.01 * i as f64, &format!("h{i}"), "k");
    }
    assert_eq!(c.spend(hs[0], Kind::Reentry, 3.5, true), Spend::Spent { say: true, count: 3, streak: false });
}

#[test]
fn a_loop_through_one_budget_and_the_reactions_is_held_together() {
    // Cut panes repaired and tiles sized in the same second: one count across them.
    let (mut c, hs) = core_of(4);
    let mut went = 0;
    for i in 0..20 {
        let t = 0.04 * i as f64;
        if c.driver.guard.react(t, &format!("r{i}"), "size its tile") == Verdict::Go {
            went += 1;
        }
        if matches!(c.spend(hs[i % 4], Kind::CutRepair, t, true), Spend::Go { .. }) {
            went += 1;
        }
    }
    assert_eq!(went, PER_SECOND, "twelve in the second, then held");
}

#[test]
fn normal_use_is_well_under_the_hold() {
    // A split of four, every pane taken out by its app each second, put back by one budget or another, and four tiles
    // sized beside (eight a second, each budget at its own limits): never held.
    let (mut c, hs) = core_of(4);
    let kinds = [Kind::Reentry, Kind::OffInPlace, Kind::OffElsewhere, Kind::CutRepair];
    for round in 0..120 {
        let t = round as f64;
        for (i, h) in hs.iter().enumerate() {
            c.model.set_real(*h, Field::VisibleAt, Some(t));
            let kind = kinds[(round + i) % 4];
            let s = c.spend(*h, kind, t + 0.01 * i as f64, true);
            assert!(!matches!(s, Spend::Held { .. }), "round {round}: {kind:?} {s:?}");
            c.model.repair_took(*h, true);
            let v = c.driver.guard.react(t + 0.5 + 0.01 * i as f64, &format!("app:{i}:{round}"), "size its tile");
            assert_eq!(v, Verdict::Go, "round {round}");
        }
    }
    // A stray's returns never ask the hold (their action is the guard's "put back"), and the guard off never holds.
    let (mut c, hs) = core_of(PER_SECOND + 2);
    for (i, h) in hs.iter().enumerate() {
        assert!(matches!(c.spend(*h, Kind::StrayReturns, 0.01 * i as f64, true), Spend::Go { .. }));
    }
    for (i, h) in hs.iter().enumerate() {
        assert!(matches!(c.spend(*h, Kind::Reentry, 0.2 + 0.01 * i as f64, false), Spend::Go { .. }), "{i}");
    }
    assert_eq!(c.driver.guard.react(0.5, "x", "k"), Verdict::Go, "nothing counted by either");
}
