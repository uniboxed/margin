//! The close's predicates (ported from the engine's: T/host-tests.swift's close cases, their pure parts; the Swift
//! ones stay as the engine's integration tests).

use super::*;

fn app() -> Facts {
    Facts { launched_by_margin: true, an_app: true, ..Facts::default() }
}

#[test]
fn a_row_closed_while_its_app_asks_something_quits_it_at_once() {
    let asking = Facts { asking: true, ..app() };
    assert!(quit_at_once(Exit::Watched, &asking));
    assert!(!quit_at_once(Exit::Waited, &asking), "a failed open: waited as any");
    assert!(!quit_at_once(Exit::AtQuit, &asking));
    assert!(!quit_at_once(Exit::Watched, &app()), "not asking");
    assert!(!quit_at_once(Exit::Watched, &Facts { shares_app: true, ..asking }), "another host shares its app");
    assert!(!quit_at_once(Exit::Watched, &Facts { launched_by_margin: false, ..asking }), "the person's: never quit");
    assert!(!quit_at_once(Exit::Watched, &Facts { copy_window: true, ..asking }));
    assert!(!quit_at_once(Exit::Watched, &Facts { an_app: false, ..asking }), "a Safari window's host");
}

#[test]
fn what_is_given_back_first_and_whether_it_is_seen() {
    assert_eq!(give_back(&Facts { window_mode: true, member: true, ..app() }), GiveBack::Frame);
    assert_eq!(give_back(&Facts { member: true, ..app() }), GiveBack::OutOfFullScreen);
    assert_eq!(give_back(&Facts { shown: true, ..app() }), GiveBack::OutOfFullScreen);
    assert_eq!(give_back(&Facts { own_space: true, ..app() }), GiveBack::OutOfFullScreen);
    assert_eq!(give_back(&app()), GiveBack::Nothing, "parked and out of full screen already");
    // Through its copy: only one mid-way in its own Space now (a member: made normal later).
    assert_eq!(give_back(&Facts { via_copy: true, member: true, shown: true, ..app() }), GiveBack::Nothing);
    assert_eq!(give_back(&Facts { via_copy: true, own_space: true, ..app() }), GiveBack::OutOfFullScreen);
    assert!(freeze(&Facts { shown: true, window_mode: true, ..app() }));
    assert!(freeze(&Facts { window_mode: true, frame_changed: true, ..app() }));
    assert!(!freeze(&Facts { window_mode: true, ..app() }), "parked, its frame given back: nothing seen");
    assert!(freeze(&Facts { member: true, ..app() }));
    assert!(!freeze(&Facts { member: true, via_copy: true, ..app() }), "out through its copy, unseen");
}

#[test]
fn quit_closed_first_home_and_where_before_the_quit() {
    assert!(quits(&app()));
    assert!(!quits(&Facts { shares_app: true, ..app() }));
    assert!(!quits(&Facts { launched_by_margin: false, ..app() }));
    assert!(close_first_asks(true, &app()));
    assert!(!close_first_asks(false, &app()));
    assert!(!close_first_asks(true, &Facts { ax_refused: true, ..app() }), "its button wouldn't be pressed");
    assert!(!close_first_asks(true, &Facts { copy_window: true, ..app() }));
    assert!(!close_first_asks(true, &Facts { an_app: false, ..app() }));
    assert!(home_after(false, &Facts { window_mode: true, ..app() }));
    assert!(home_after(false, &Facts { person: true, ..app() }));
    assert!(!home_after(true, &Facts { window_mode: true, ..app() }), "closed: nothing to take home");
    assert!(!home_after(false, &app()));
    assert!(before_quit_asks(true, false, &app()));
    assert!(!before_quit_asks(true, true, &app()));
    assert!(!before_quit_asks(false, false, &app()));
    let private = Facts { private_space: true, ..app() };
    assert_eq!(before_quit(Exit::Watched, true, &app()), BeforeQuit::Home);
    assert_eq!(before_quit(Exit::AtQuit, false, &private), BeforeQuit::Home);
    assert_eq!(before_quit(Exit::AtQuit, false, &app()), BeforeQuit::Nothing);
    assert_eq!(before_quit(Exit::Waited, true, &app()), BeforeQuit::OutOfSight);
    assert_eq!(before_quit(Exit::Waited, true, &private), BeforeQuit::Nothing, "out of sight already");
    assert_eq!(before_quit(Exit::Waited, false, &app()), BeforeQuit::Nothing);
}

#[test]
fn safaris_windows_left_on_the_desktop() {
    let private = Facts { private_space: true, ..Facts::default() };
    assert!(copy_window_to_desktop(false, false, Exit::Waited, &private));
    assert!(copy_window_to_desktop(false, true, Exit::Watched, &private));
    assert!(!copy_window_to_desktop(false, true, Exit::Waited, &private), "its Safari's quit waited for");
    assert!(!copy_window_to_desktop(true, false, Exit::Watched, &private), "closed by its copy");
    assert!(!copy_window_to_desktop(false, false, Exit::Watched, &Facts::default()), "not in a private Space");
    assert!(left_to_the_person(&Facts { made_by_margin: true, ..private }));
    assert!(left_to_the_person(&Facts { safari: true, shares_app: true, ..private }));
    assert!(!left_to_the_person(&Facts { safari: true, ..private }));
    assert!(!left_to_the_person(&Facts { made_by_margin: true, ..Facts::default() }));
}

#[test]
fn what_the_marker_keeps_of_an_unfinished_close() {
    assert_eq!(unfinished(false, &app()), None, "done");
    assert_eq!(unfinished(true, &app()), Some(false), "left in Margin's Space");
    assert_eq!(unfinished(false, &Facts { private_space: true, ..app() }), Some(false));
    assert_eq!(unfinished(false, &Facts { exit_unconfirmed: true, ..app() }), Some(true), "as a member");
    assert_eq!(unfinished(false, &Facts { exit_unconfirmed: true, via_copy: true, ..app() }), None);
    assert_eq!(unfinished(true, &Facts { copy_window: true, ..app() }), None, "its copy closes it");
    assert_eq!(unfinished(false, &Facts { frame_changed: true, window_mode: true, ..app() }), Some(false));
    assert_eq!(
        unfinished(false, &Facts { frame_changed: true, person: true, copy_window: true, ..app() }),
        Some(false)
    );
    assert_eq!(unfinished(false, &Facts { frame_changed: true, ..app() }), None, "a member's frame isn't given back");
}

#[test]
fn the_ffis_bits_are_the_fields_in_order() {
    assert_eq!(Facts::from_bits(0), Facts::default());
    let all = Facts::from_bits(u32::MAX);
    assert!(all.launched_by_margin && all.exit_unconfirmed && all.ax_refused && all.safari);
    assert_eq!(Facts::from_bits(1 << 8), Facts { member: true, ..Facts::default() });
    assert_eq!(Facts::from_bits(1 << 16), Facts { exit_unconfirmed: true, ..Facts::default() });
}
