//! Each budget's behaviour, in the Swift's order of filter, check and append (the engine's tests pin it with the
//! stand-in world: T/host-tests.swift's stray and off-screen cases, T/screen-engine-tests.swift's re-entry, the cut
//! order's repair in T/multi-host-tests.swift).

use super::*;
use crate::host::model::{Field, Phase};

fn model() -> (HostModel, Handle) {
    let mut m = HostModel::new();
    let h = m.add("app:com.apple.MobileSMS", "com.apple.MobileSMS", 41, 500);
    (m, h)
}

#[test]
fn a_strays_returns_three_within_thirty_seconds_the_fourth_parks() {
    let (mut m, h) = model();
    assert_eq!(m.spend(h, Kind::StrayReturns, 0.0), Spend::Go { count: 1 });
    assert_eq!(m.spend(h, Kind::StrayReturns, 10.0), Spend::Go { count: 2 });
    assert_eq!(m.spend(h, Kind::StrayReturns, 20.0), Spend::Go { count: 3 });
    // (Appended before the check: the fourth is counted, said, and the list cleared.)
    assert_eq!(m.spend(h, Kind::StrayReturns, 29.0), Spend::Spent { say: true, count: 4, streak: false });
    assert!(m.times(h, Field::Returns).is_empty());
    assert_eq!(m.spend(h, Kind::StrayReturns, 29.5), Spend::Go { count: 1 }, "parked, then a fresh budget");
    // 30 s after a return it no longer counts (strictly within).
    let (mut m, h) = model();
    for t in [0.0, 10.0, 20.0] {
        m.spend(h, Kind::StrayReturns, t);
    }
    assert_eq!(m.spend(h, Kind::StrayReturns, 30.0), Spend::Go { count: 3 });
}

#[test]
fn a_reentry_three_within_thirty_seconds_then_said_once() {
    let (mut m, h) = model();
    for (i, t) in [0.0, 1.0, 2.0].into_iter().enumerate() {
        assert_eq!(m.spend(h, Kind::Reentry, t), Spend::Go { count: i + 1 });
    }
    assert_eq!(m.spend(h, Kind::Reentry, 3.0), Spend::Spent { say: true, count: 3, streak: false });
    assert_eq!(m.spend(h, Kind::Reentry, 4.0), Spend::Spent { say: false, count: 3, streak: false }, "said once");
    // (Filtered before the check: not appended when spent.)
    assert_eq!(m.times(h, Field::Reentries), &[0.0, 1.0, 2.0]);
    assert_eq!(m.spend(h, Kind::Reentry, 30.0), Spend::Go { count: 3 }, "the first lapsed");
    assert_eq!(m.int(h, Field::ReentrySaid), 0, "a re-entry resets the said");
    assert_eq!(m.spend(h, Kind::Reentry, 30.5), Spend::Spent { say: true, count: 3, streak: false });
}

#[test]
fn off_screen_in_place_once_a_show_said_once_a_show() {
    let (mut m, h) = model();
    m.set_real(h, Field::VisibleAt, Some(100.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 101.0), Spend::Go { count: 1 });
    assert_eq!(m.real(h, Field::OffActedFor), Some(100.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 102.0), Spend::Spent { say: true, count: 1, streak: false });
    assert_eq!(m.spend(h, Kind::OffInPlace, 103.0), Spend::Spent { say: false, count: 1, streak: false });
    // Shown again: once more, said again when spent.
    m.set_real(h, Field::VisibleAt, Some(110.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 111.0), Spend::Go { count: 2 });
    assert_eq!(m.spend(h, Kind::OffInPlace, 112.0), Spend::Spent { say: true, count: 2, streak: false });
    // The list's budget too: three within 30 s, whatever the shows.
    m.set_real(h, Field::VisibleAt, Some(120.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 121.0), Spend::Go { count: 3 });
    m.set_real(h, Field::VisibleAt, Some(122.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 123.0), Spend::Spent { say: true, count: 3, streak: false });
    // (Filtered and kept so even when spent: the engine stored the filtered list first.)
    m.set_times(h, Field::OffTries, &[0.0, 200.0]);
    m.set_real(h, Field::VisibleAt, Some(300.0));
    assert_eq!(m.spend(h, Kind::OffInPlace, 229.0), Spend::Go { count: 2 });
    assert_eq!(m.times(h, Field::OffTries), &[200.0, 229.0]);
}

#[test]
fn off_screen_elsewhere_three_within_thirty_seconds_said_once() {
    let (mut m, h) = model();
    for (i, t) in [0.0, 1.0, 2.0].into_iter().enumerate() {
        assert_eq!(m.spend(h, Kind::OffElsewhere, t), Spend::Go { count: i + 1 });
    }
    assert_eq!(m.spend(h, Kind::OffElsewhere, 3.0), Spend::Spent { say: true, count: 3, streak: false });
    assert_eq!(m.spend(h, Kind::OffElsewhere, 4.0), Spend::Spent { say: false, count: 3, streak: false });
    // (Its said reset when it's newly visible: the engine's.)
    m.set_int(h, Field::OffSaid, 0);
    assert_eq!(m.spend(h, Kind::OffElsewhere, 5.0), Spend::Spent { say: true, count: 3, streak: false });
    // One list for both: in place's tries count here too.
    let (mut m, h) = model();
    m.spend(h, Kind::OffInPlace, 0.0);
    assert_eq!(m.spend(h, Kind::OffElsewhere, 1.0), Spend::Go { count: 2 });
}

#[test]
fn a_cut_panes_repair_three_within_five_seconds_or_three_that_didnt_take() {
    let (mut m, h) = model();
    for (i, t) in [0.0, 1.0, 2.0].into_iter().enumerate() {
        assert_eq!(m.spend(h, Kind::CutRepair, t), Spend::Go { count: i + 1 });
        assert_eq!(m.repair_took(h, true), 0);
    }
    assert_eq!(m.spend(h, Kind::CutRepair, 3.0), Spend::Spent { say: true, count: 3, streak: false });
    assert_eq!(m.spend(h, Kind::CutRepair, 30.0), Spend::Spent { say: false, count: 0, streak: false }, "held");
    m.cut_order_right(h);
    assert_eq!(m.spend(h, Kind::CutRepair, 30.0), Spend::Go { count: 1 }, "seen right: again");
    // Three in a row that didn't take, spread out: the streak.
    let (mut m, h) = model();
    for (i, t) in [0.0, 10.0, 20.0].into_iter().enumerate() {
        assert_eq!(m.spend(h, Kind::CutRepair, t), Spend::Go { count: 1 });
        assert_eq!(m.repair_took(h, false), i + 1);
    }
    assert_eq!(m.spend(h, Kind::CutRepair, 30.0), Spend::Spent { say: true, count: 0, streak: true });
    // Kept by its id: a host made again with the same id is still held.
    m.remove(h);
    let again = m.add("app:com.apple.MobileSMS", "com.apple.MobileSMS", 42, 500);
    assert_eq!(m.spend(again, Kind::CutRepair, 31.0), Spend::Spent { say: false, count: 0, streak: false });
    m.cut_order_right(again);
    assert_eq!(m.spend(again, Kind::CutRepair, 31.0), Spend::Go { count: 1 });
    // Another host's are its own.
    let other = m.add("app:x", "x", 43, 501);
    assert_eq!(m.spend(other, Kind::CutRepair, 31.0), Spend::Go { count: 1 });
    // An unknown host: spent, nothing said.
    assert_eq!(m.spend(99, Kind::CutRepair, 0.0), Spend::Spent { say: false, count: 0, streak: false });
    assert_eq!(m.spend(99, Kind::Reentry, 0.0), Spend::Spent { say: false, count: 0, streak: false });
}

#[test]
fn the_limits_are_the_engines_options() {
    let (mut m, h) = model();
    m.limits = Limits { returns_max: 1, returns_within: 5.0 };
    assert_eq!(m.spend(h, Kind::Reentry, 0.0), Spend::Go { count: 1 });
    assert_eq!(m.spend(h, Kind::Reentry, 4.9), Spend::Spent { say: true, count: 1, streak: false });
    assert_eq!(m.spend(h, Kind::Reentry, 5.0), Spend::Go { count: 1 });
    assert_eq!(m.spend(h, Kind::StrayReturns, 0.0), Spend::Go { count: 1 });
    assert_eq!(m.spend(h, Kind::StrayReturns, 1.0), Spend::Spent { say: true, count: 2, streak: false });
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
