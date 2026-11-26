//! The rows of shell/tests/host-reconciler-tests.swift: one per case of the baseline real-screen run and of his
//! sessions, each with the corrections it must give, most urgent first.

use super::*;
use Correction as C;
use WindowPlace::*;

fn member(edit: impl FnOnce(&mut Situation)) -> Situation {
    let mut s = Situation {
        phase: Phase::Shown,
        member: true,
        window: Some(71918),
        place: Margin,
        on_screen: Some(true),
        full_screen: Some(true),
        can_full_screen: Some(true),
        launched_by_margin: true,
        ..Situation::default()
    };
    edit(&mut s);
    s
}
fn windowed(edit: impl FnOnce(&mut Situation)) -> Situation {
    member(|s| {
        s.member = false;
        s.mode = Mode::Window;
        s.full_screen = Some(false);
        s.can_full_screen = Some(false);
        edit(s)
    })
}
fn first_open(edit: impl FnOnce(&mut Situation)) -> Situation {
    let mut s =
        Situation { phase: Phase::Preparing, window: Some(50), launched_by_margin: true, ..Situation::default() };
    edit(&mut s);
    s
}
fn other(n: i64, place: WindowPlace, on_screen: Option<bool>, closable: bool) -> Other {
    Other { number: n, place, on_screen, closable, home: None }
}
fn own(n: i64, place: WindowPlace, on_screen: Option<bool>, home: Option<u64>) -> Other {
    Other { number: n, place, on_screen, closable: false, home }
}
fn tries(list: &[(&str, u32)]) -> BTreeMap<String, u32> {
    list.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}
fn wait(why: &str) -> Correction {
    C::Wait { why: why.into() }
}
fn fallback(why: &str) -> Correction {
    C::Fallback { why: why.into() }
}

#[test]
fn every_row() {
    use Desired::{Parked as P, Shown as S};
    let rows: Vec<(&str, Situation, Desired, Vec<Correction>)> = vec![
        ("not running: launched", Situation { running: false, ..Situation::default() }, S, vec![C::Launch]),
        (
            "not running, launched once: the fallback",
            Situation { running: false, tries: tries(&[("launch", 1)]), ..Situation::default() },
            S,
            vec![fallback("it doesn't start")],
        ),
        ("running with no window: reopened", Situation::default(), S, vec![C::Reopen]),
        (
            "no window, hidden: unhidden, then reopened",
            Situation { hidden: Some(true), ..Situation::default() },
            S,
            vec![C::Unhide, C::Reopen],
        ),
        (
            "no window, reopened twice: the fallback",
            Situation { tries: tries(&[("reopen", 2)]), ..Situation::default() },
            S,
            vec![fallback("no window to host")],
        ),
        (
            "shown, its window gone a moment ago: waited for",
            member(|s| {
                s.window_gone = true;
                s.gone_for = Some(0.5)
            }),
            S,
            vec![wait("its window went: another main window of its app's waited for")],
        ),
        (
            "shown, its window gone past the grace: its item closed",
            member(|s| {
                s.window_gone = true;
                s.gone_for = Some(1.2)
            }),
            S,
            vec![C::CloseItem],
        ),
        (
            "window mode, gone past the grace: closed too",
            windowed(|s| {
                s.window_gone = true;
                s.gone_for = Some(3.0)
            }),
            S,
            vec![C::CloseItem],
        ),
        (
            "its window gone, a new main: adopted",
            member(|s| {
                s.window_gone = true;
                s.replacement = Some(72046)
            }),
            S,
            vec![C::Adopt { window: 72046 }],
        ),
        (
            "replaced: adopted before anything else",
            member(|s| {
                s.replacement = Some(72210);
                s.leftovers = vec![other(72197, Margin, None, false)]
            }),
            S,
            vec![C::Adopt { window: 72210 }],
        ),
        (
            "parked and replaced: adopted",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.replacement = Some(72210)
            }),
            P,
            vec![C::Adopt { window: 72210 }],
        ),
        (
            "the person's app parked, a new window of it: never taken",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.replacement = Some(72210);
                s.launched_by_margin = false
            }),
            P,
            vec![],
        ),
        (
            "parked, its window gone: nothing now",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.window_gone = true
            }),
            P,
            vec![],
        ),
        (
            "first open, in a full-screen Space of its own: placed from there",
            first_open(|s| {
                s.own_full_screen_space = Some(8054);
                s.place = FullScreen
            }),
            S,
            vec![C::PlaceFromOwnSpace { space: 8054 }],
        ),
        (
            "first open, full screen with no Space of its own: out, then asked",
            first_open(|s| {
                s.full_screen = Some(true);
                s.place = Margin
            }),
            S,
            vec![C::OutThenAsk],
        ),
        (
            "first open, a normal window: asked",
            first_open(|s| {
                s.full_screen = Some(false);
                s.can_full_screen = Some(true);
                s.place = Desktop
            }),
            S,
            vec![C::AskFullScreen],
        ),
        (
            "first open, can't go full screen: window mode",
            first_open(|s| {
                s.full_screen = Some(false);
                s.can_full_screen = Some(false);
                s.place = Margin
            }),
            S,
            vec![C::FrameWindow],
        ),
        (
            "first open, window mode since its full screen failed: window mode",
            first_open(|s| {
                s.mode = Mode::Window;
                s.can_full_screen = Some(true)
            }),
            S,
            vec![C::FrameWindow],
        ),
        (
            "macOS's transition still running: wait",
            member(|s| {
                s.busy = true;
                s.place = Several
            }),
            S,
            vec![wait("macOS's transition is still running")],
        ),
        ("shown as it should be: settled", member(|_| {}), S, vec![]),
        ("shown, in no Space: put back", member(|s| s.place = Nowhere), S, vec![C::PutBack]),
        ("shown, on a Desktop: put back", member(|s| s.place = Desktop), S, vec![C::PutBack]),
        (
            "shown, out three times in 30 s: no more put back",
            member(|s| {
                s.place = Nowhere;
                s.tries = tries(&[("put back", 3)])
            }),
            S,
            vec![],
        ),
        (
            "shown, Margin's Space not current: nothing",
            member(|s| {
                s.place = Desktop;
                s.margin_current = false
            }),
            S,
            vec![],
        ),
        ("window mode, not where framed: framed again", windowed(|s| s.at_page = Some(false)), S, vec![C::FrameWindow]),
        (
            "…framed twice already: left as it is",
            windowed(|s| {
                s.at_page = Some(false);
                s.tries = tries(&[("window mode", 2)])
            }),
            S,
            vec![],
        ),
        ("a member off the page one read: nothing yet", member(|s| s.off_page_reads = 1), S, vec![]),
        ("a member off the page two reads: placed again", member(|s| s.off_page_reads = 2), S, vec![C::PlaceAgain]),
        (
            "…placed again once already: left",
            member(|s| {
                s.off_page_reads = 4;
                s.tries = tries(&[("place again", 1)])
            }),
            S,
            vec![],
        ),
        (
            "window mode, off screen one read: nothing yet",
            windowed(|s| {
                s.on_screen = Some(false);
                s.off_screen_reads = 1
            }),
            S,
            vec![],
        ),
        (
            "window mode, off screen two reads: activated",
            windowed(|s| {
                s.on_screen = Some(false);
                s.off_screen_reads = 2
            }),
            S,
            vec![C::BringForward { rung: Forward::Activate }],
        ),
        (
            "…activated already: a Dock-icon click",
            windowed(|s| {
                s.on_screen = Some(false);
                s.off_screen_reads = 4;
                s.tries = tries(&[("bring forward (activate)", 1)])
            }),
            S,
            vec![C::BringForward { rung: Forward::Reopen }],
        ),
        (
            "…both rungs tried: the fallback",
            windowed(|s| {
                s.on_screen = Some(false);
                s.off_screen_reads = 6;
                s.tries = tries(&[("bring forward (activate)", 1), ("bring forward (reopen)", 1)])
            }),
            S,
            vec![fallback("its window stays off screen in Margin's Space")],
        ),
        (
            "restored windows on screen, kept at quit: parked",
            member(|s| s.leftovers = vec![other(71919, Margin, Some(true), false)]),
            S,
            vec![C::ParkLeftover { window: 71919 }],
        ),
        (
            "…discarded at quit, readable: closed",
            member(|s| s.leftovers = vec![other(71919, Margin, Some(true), true)]),
            S,
            vec![C::CloseLeftover { window: 71919 }],
        ),
        (
            "Safari's restored windows: all parked",
            member(|s| {
                s.leftovers = vec![
                    other(72450, FullScreen, None, false),
                    other(72457, FullScreen, None, false),
                    other(72468, Desktop, Some(true), false),
                ]
            }),
            S,
            vec![
                C::ParkLeftover { window: 72450 },
                C::ParkLeftover { window: 72457 },
                C::ParkLeftover { window: 72468 },
            ],
        ),
        (
            "a leftover parked already: nothing",
            member(|s| s.leftovers = vec![other(71919, WindowPlace::Parked, None, false)]),
            S,
            vec![],
        ),
        (
            "a leftover tried twice: left",
            member(|s| {
                s.leftovers = vec![other(71919, Margin, None, false)];
                s.tries = tries(&[("leftover 71919", 2)])
            }),
            S,
            vec![],
        ),
        (
            "a strip on screen: parked",
            member(|s| s.strips = vec![other(72279, Margin, Some(true), false)]),
            S,
            vec![C::ParkStrip { window: 72279 }],
        ),
        (
            "a strip parked: nothing",
            member(|s| s.strips = vec![other(72279, WindowPlace::Parked, Some(false), false)]),
            S,
            vec![],
        ),
        (
            "put back before its leftovers",
            member(|s| {
                s.place = Nowhere;
                s.leftovers = vec![other(7, Margin, None, false)]
            }),
            S,
            vec![C::PutBack, C::ParkLeftover { window: 7 }],
        ),
        (
            "parked as it should be: nothing",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked
            }),
            P,
            vec![],
        ),
        (
            "parked, on a Desktop one read: nothing yet",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = Desktop;
                s.stray_reads = 1
            }),
            P,
            vec![],
        ),
        (
            "parked, on a Desktop two reads: parked again",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = Desktop;
                s.stray_reads = 2
            }),
            P,
            vec![C::ParkAgain],
        ),
        (
            "parked, its leftovers and strips in user Spaces: parked too",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.leftovers = vec![other(5, Margin, None, false)];
                s.strips = vec![other(6, FullScreen, None, false)]
            }),
            P,
            vec![C::ParkLeftover { window: 5 }, C::ParkStrip { window: 6 }],
        ),
        // The real Mac, 2026-11-26 10:43:12: the person's own Safari window (25059), ordered into Margin's Space by
        // Safari's activation, sat over the page area until Margin quit. Put back on its Desktop, never closed or parked.
        (
            "the person's own window in Margin's Space (its app's activation ordered it in): put away onto the Desktop",
            member(|s| {
                s.launched_by_margin = false;
                s.own_windows = vec![own(25059, Margin, Some(true), None)]
            }),
            S,
            vec![C::PutAway { window: 25059, home: None }],
        ),
        (
            "…its Desktop known: put back there",
            member(|s| {
                s.launched_by_margin = false;
                s.own_windows = vec![own(25059, Margin, Some(true), Some(1))]
            }),
            S,
            vec![C::PutAway { window: 25059, home: Some(1) }],
        ),
        (
            "…while its app's host is parked (another app shown): put away too",
            member(|s| {
                s.launched_by_margin = false;
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.own_windows = vec![own(25059, Margin, Some(true), None)]
            }),
            P,
            vec![C::PutAway { window: 25059, home: None }],
        ),
        (
            "…on its Desktop, in a full-screen Space of its own, on several Spaces or in none: left where it is",
            member(|s| {
                s.launched_by_margin = false;
                s.own_windows = vec![
                    own(1, Desktop, Some(false), Some(1)),
                    own(2, FullScreen, None, None),
                    own(3, Several, Some(true), None),
                    own(4, Nowhere, None, None),
                ]
            }),
            S,
            vec![],
        ),
        (
            "…its budget used this show (it came back each time): left",
            member(|s| {
                s.launched_by_margin = false;
                s.own_windows = vec![own(25059, Margin, Some(true), None)];
                s.tries = tries(&[("own 25059", 3)])
            }),
            S,
            vec![],
        ),
        (
            "…macOS's transition still running: waited for first",
            member(|s| {
                s.launched_by_margin = false;
                s.busy = true;
                s.own_windows = vec![own(25059, Margin, Some(true), None)]
            }),
            S,
            vec![wait("macOS's transition is still running")],
        ),
        (
            "…parked and an operation running: nothing yet",
            member(|s| {
                s.launched_by_margin = false;
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.busy = true;
                s.own_windows = vec![own(25059, Margin, Some(true), None)]
            }),
            P,
            vec![],
        ),
        (
            "parked, its process gone: nothing",
            member(|s| {
                s.phase = Phase::Parked;
                s.running = false;
                s.place = Desktop;
                s.stray_reads = 3
            }),
            P,
            vec![],
        ),
        ("a tile shown at the page: nothing", member(|s| s.tile = true), S, vec![]),
        (
            "a tile shown placed for another page area: sized",
            member(|s| {
                s.tile = true;
                s.tile_stale = true
            }),
            S,
            vec![C::SizeTile],
        ),
        (
            "a tile shown, not taken three times: placed again",
            member(|s| {
                s.tile = true;
                s.tile_stale = true;
                s.tries = tries(&[("size its tile", 3)])
            }),
            S,
            vec![C::PlaceAgain],
        ),
        (
            "a tile shown mid-drag: nothing",
            member(|s| {
                s.tile = true;
                s.tile_stale = true;
                s.dragging = true
            }),
            S,
            vec![],
        ),
        ("a member, not a tile, off the page: placed again", member(|s| s.off_page_reads = 2), S, vec![C::PlaceAgain]),
        (
            "a tile off the page: sized, never placed again",
            member(|s| {
                s.tile = true;
                s.tile_stale = true;
                s.off_page_reads = 2
            }),
            S,
            vec![C::SizeTile],
        ),
        (
            "a tile parked for another page area: sized out of sight",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.tile = true;
                s.tile_stale = true
            }),
            P,
            vec![C::SizeTile],
        ),
        (
            "a tile parked mid-drag: nothing yet",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.tile = true;
                s.tile_stale = true;
                s.dragging = true
            }),
            P,
            vec![],
        ),
        (
            "a tile parked, its budget spent: nothing",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = WindowPlace::Parked;
                s.tile = true;
                s.tile_stale = true;
                s.tries = tries(&[("size its tile", 3)])
            }),
            P,
            vec![],
        ),
        (
            "a tile parked on a Desktop: parked again, then sized",
            member(|s| {
                s.phase = Phase::Parked;
                s.place = Desktop;
                s.stray_reads = 2;
                s.tile = true;
                s.tile_stale = true
            }),
            P,
            vec![C::ParkAgain, C::SizeTile],
        ),
        (
            "given back: the engine's own steps",
            member(|s| s.leftovers = vec![other(5, Margin, None, false)]),
            Desired::GivenBack,
            vec![],
        ),
    ];
    for (name, s, d, want) in rows {
        let got = step(&s, d);
        assert_eq!(got, want, "{name}");
        assert_eq!(step(&s, d), got, "{name}: pure");
    }
}

#[test]
fn budgets_and_keys() {
    for c in [
        C::Launch,
        C::Reopen,
        C::Unhide,
        C::PutBack,
        C::BringForward { rung: Forward::Activate },
        C::Adopt { window: 1 },
        C::CloseLeftover { window: 1 },
        C::ParkLeftover { window: 1 },
        C::ParkStrip { window: 1 },
        C::ParkAgain,
        C::CloseItem,
        C::PlaceAgain,
        C::SizeTile,
    ] {
        assert!(c.budget() >= 1, "{}", c.name());
    }
    assert_eq!(C::CloseLeftover { window: 5 }.key(), C::ParkLeftover { window: 5 }.key());
}

#[test]
fn the_observed_line() {
    let text = member(|s| {
        s.leftovers = vec![other(71919, Margin, Some(true), false)];
        s.replacement = Some(72210)
    })
    .text();
    assert_eq!(
        text,
        "shown, a member window 71918 Margin's Space, on screen; its app's main window now 72210; leftover 71919 (Margin's Space, on screen)"
    );
    let off = windowed(|s| {
        s.on_screen = Some(false);
        s.off_screen_reads = 3
    })
    .text();
    assert_eq!(off, "shown, window mode window 71918 Margin's Space, off screen (3 reads)");
}

#[test]
fn json_shape() {
    let c = C::BringForward { rung: Forward::Reopen };
    assert_eq!(serde_json::to_string(&c).unwrap(), r#"{"type":"bringForward","rung":"reopen"}"#);
    let back: Correction = serde_json::from_str(r#"{"type":"parkStrip","window":7}"#).unwrap();
    assert_eq!(back, C::ParkStrip { window: 7 });
    let s: Situation = serde_json::from_str(r#"{"phase":"shown","window":5,"place":"margin"}"#).unwrap();
    assert!(s.running && s.margin_current, "defaults: running, Margin current");
}
