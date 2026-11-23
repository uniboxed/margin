//! The poll's counting and its order, each verdict's tree (ported from the engine's: T/host-tests.swift's gone,
//! stray and off-screen cases, their pure parts; the Swift ones stay as the engine's integration tests).

use super::*;
use crate::host::model::Field;

fn model(phase: Phase) -> (HostModel, Handle) {
    let mut m = HostModel::new();
    let h = m.add("app:com.apple.Notes", "com.apple.Notes", 41, 500);
    m.set_int(h, Field::Phase, phase as i64);
    (m, h)
}

#[test]
fn two_unread_reads_in_a_row_are_gone_one_skips_a_read_resets() {
    let (mut m, h) = model(Phase::Shown);
    assert_eq!(m.poll_read(h, Read::Unread), Counted::Skip, "one read can miss mid-transition");
    assert_eq!(m.poll_read(h, Read::Unread), Counted::Gone);
    assert_eq!(m.poll_read(h, Read::Unread), Counted::Gone, "and stays so");
    m.set_int(h, Field::Gone, 1);
    assert_eq!(m.poll_read(h, Read::Read), Counted::Read);
    assert_eq!((m.int(h, Field::Unread), m.int(h, Field::Gone)), (0, 0), "a read resets the count and its gone");
    // Closed by its app: as two reads that missed, at once; counted on from there.
    assert_eq!(m.poll_read(h, Read::Closed), Counted::Gone);
    assert_eq!(m.int(h, Field::Unread), 2);
    assert_eq!(m.poll_read(h, Read::Closed), Counted::Gone);
    assert_eq!(m.int(h, Field::Unread), 3);
    assert_eq!(m.poll_read(99, Read::Unread), Counted::Skip, "an unknown host: nothing");
}

#[test]
fn a_window_gone_by_its_hosts_phase_and_its_app() {
    // Shown, its app running: marked gone (the reconciler adopts or closes), its process read only then.
    let (mut m, h) = model(Phase::Shown);
    assert_eq!(m.poll_gone(h, 10.0, None, false), Gone::AskRuns);
    assert_eq!(m.int(h, Field::Gone), 0, "nothing marked before the read");
    assert_eq!(m.poll_gone(h, 10.0, Some(true), false), Gone::Shown);
    assert_eq!((m.int(h, Field::Gone), m.real(h, Field::GoneAt)), (1, Some(10.0)));
    assert_eq!(m.poll_gone(h, 11.0, None, false), Gone::Nothing, "gone already: no read, nothing");
    // Parked, an app Margin started: reopened at its next show.
    let (mut m, h) = model(Phase::Parked);
    assert_eq!(m.poll_gone(h, 5.0, Some(true), true), Gone::Reopen);
    assert_eq!(m.real(h, Field::GoneAt), Some(5.0));
    // Parked, the person's app (or a Safari window): its window gone as any.
    let (mut m, h) = model(Phase::Parked);
    assert_eq!(m.poll_gone(h, 5.0, Some(true), false), Gone::WindowGone);
    assert_eq!(m.int(h, Field::Gone), 0);
    // Its app not running: gone as any, whatever its phase.
    let (mut m, h) = model(Phase::Shown);
    assert_eq!(m.poll_gone(h, 5.0, Some(false), true), Gone::WindowGone);
    // Being made: gone as any, its process never read.
    let (mut m, h) = model(Phase::Preparing);
    assert_eq!(m.poll_gone(h, 5.0, None, true), Gone::WindowGone);
}

#[test]
fn a_stray_counted_twice_in_a_row_or_at_once_in_no_space() {
    let (mut m, h) = model(Phase::Shown);
    assert!(!m.poll_place(h, Place::Elsewhere, true), "one read can miss");
    assert!(m.poll_place(h, Place::Elsewhere, true), "twice in a row: brought back");
    assert_eq!(m.int(h, Field::Strays), 0, "its count started again");
    assert!(!m.poll_place(h, Place::Elsewhere, true));
    assert!(!m.poll_place(h, Place::InPage, true), "in place: the count reset");
    assert!(!m.poll_place(h, Place::Elsewhere, true));
    // Margin's window out of its Space: the one shown is a stray too, wherever it reads.
    assert!(m.poll_place(h, Place::InPage, false));
    assert!(!m.poll_place(h, Place::Unread, true), "unread Spaces: not a stray");
    // In no Space, Margin's window in its own: at once.
    assert!(m.poll_place(h, Place::Nowhere, true));
    // Margin's window out too: counted as any.
    assert!(!m.poll_place(h, Place::Nowhere, false));
    assert!(m.poll_place(h, Place::Nowhere, false));
    // Parked: counted in any Space (the reconciler's `parkAgain`), never brought back by the poll.
    let (mut m, h) = model(Phase::Parked);
    for place in [Place::InPage, Place::Elsewhere, Place::InPage] {
        assert!(!m.poll_place(h, place, true));
    }
    assert_eq!(m.int(h, Field::Strays), 3);
    assert!(!m.poll_place(h, Place::Nowhere, true));
    assert_eq!(m.int(h, Field::Strays), 0, "parked in no Space: where it belongs");
    // Being made: never.
    let (mut m, h) = model(Phase::Preparing);
    assert!(!m.poll_place(h, Place::Elsewhere, false));
    assert_eq!(m.int(h, Field::Strays), 0);
}

#[test]
fn a_stray_in_its_turn_read_again() {
    let (mut m, h) = model(Phase::Shown);
    assert_eq!(m.stray(h, 0.0, Place::InPage, false, true), Stray::Nothing, "put right meanwhile");
    assert_eq!(m.stray(h, 0.0, Place::InPage, true, false), Stray::Park, "Margin's window left its Space now");
    assert_eq!(m.stray(h, 0.0, Place::Elsewhere, false, true), Stray::Park, "and at the poll's read");
    assert!(m.times(h, Field::Returns).is_empty(), "parked: no return counted");
    for t in [0.0, 1.0, 2.0] {
        assert_eq!(m.stray(h, t, Place::Elsewhere, true, true), Stray::PutBack);
    }
    assert_eq!(m.stray(h, 3.0, Place::Nowhere, true, true), Stray::ParkOnly { count: 4 }, "its returns spent");
    assert_eq!(m.stray(h, 4.0, Place::Unread, true, true), Stray::PutBack, "a fresh budget after");
}

#[test]
fn off_screen_in_place_or_elsewhere_and_what_moves() {
    let none = || None;
    let (mut m, h) = model(Phase::Shown);
    m.set_real(h, Field::VisibleAt, Some(1.0));
    // In Margin's Space, the current one, Margin's window on screen: in place, once a show.
    assert_eq!(
        m.off_screen(
            h,
            2.0,
            &OffFacts { margin_on: true, host_on: false, current_is_margin: true, place: Place::InPage },
            none
        ),
        OffScreen::InPlace
    );
    assert_eq!(
        m.off_screen(
            h,
            3.0,
            &OffFacts { margin_on: true, host_on: false, current_is_margin: true, place: Place::InPage },
            none
        ),
        OffScreen::InPlaceSpent { say: true }
    );
    assert_eq!(
        m.off_screen(
            h,
            4.0,
            &OffFacts { margin_on: true, host_on: false, current_is_margin: true, place: Place::InPage },
            none
        ),
        OffScreen::InPlaceSpent { say: false }
    );
    // Elsewhere: what's made current and moved, each by what's missing.
    let (mut m, h) = model(Phase::Shown);
    let act = |m: &mut HostModel, margin_on, host_on, current_is_margin, place| {
        m.off_screen(h, 0.0, &OffFacts { margin_on, host_on, current_is_margin, place }, none)
    };
    assert_eq!(
        act(&mut m, true, false, false, Place::InPage),
        OffScreen::Act { make_current: true, move_in: false },
        "the display on another Space: made current, nothing moved"
    );
    m.set_times(h, Field::OffTries, &[]);
    assert_eq!(
        act(&mut m, true, false, true, Place::Elsewhere),
        OffScreen::Act { make_current: false, move_in: true },
        "out of Margin's Space: moved in"
    );
    m.set_times(h, Field::OffTries, &[]);
    assert_eq!(
        act(&mut m, false, false, true, Place::InPage),
        OffScreen::Act { make_current: true, move_in: true },
        "Margin's own window off screen too: both"
    );
    m.set_times(h, Field::OffTries, &[]);
    assert_eq!(
        act(&mut m, false, true, true, Place::InPage),
        OffScreen::Act { make_current: true, move_in: false },
        "its window listed: never moved"
    );
    m.set_times(h, Field::OffTries, &[]);
    assert_eq!(act(&mut m, true, false, true, Place::Unread), OffScreen::Act { make_current: false, move_in: true });
    // Spent: said once.
    act(&mut m, true, false, false, Place::InPage);
    act(&mut m, true, false, false, Place::InPage);
    assert_eq!(act(&mut m, true, false, false, Place::InPage), OffScreen::GiveUp { say: true, count: 3 });
    assert_eq!(act(&mut m, true, false, false, Place::InPage), OffScreen::GiveUp { say: false, count: 3 });
    // Held by the guard: nothing spent.
    let (mut m, h) = model(Phase::Shown);
    assert_eq!(
        m.off_screen(
            h,
            0.0,
            &OffFacts { margin_on: true, host_on: false, current_is_margin: true, place: Place::InPage },
            || Some(1.0)
        ),
        OffScreen::Held { until: 1.0 }
    );
    assert_eq!(
        m.off_screen(
            h,
            0.0,
            &OffFacts { margin_on: true, host_on: false, current_is_margin: false, place: Place::InPage },
            || Some(1.0)
        ),
        OffScreen::Held { until: 1.0 }
    );
    assert!(m.times(h, Field::OffTries).is_empty());
}

#[test]
fn the_look_still_finds_it_missing() {
    assert!(!still_off(true, true, None), "both listed");
    assert!(still_off(true, false, None), "its window missing: read its own");
    assert!(!still_off(true, false, Some(true)), "on screen by its own read");
    assert!(still_off(true, false, Some(false)));
    assert!(still_off(false, true, Some(true)), "Margin's own window missing: its own read doesn't help");
    assert!(still_off(false, false, None));
}
