//! The rows of shell/tests/host-model-tests.swift `windowKindsTests` (each a case a real session showed), and the
//! helper kind's own (Weather, 2026-11-18 13:30).

use super::*;

fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect::new(x, y, w, h)
}

// His display (15:19): the full-screen area and the page area beside a 260 pt sidebar.
const AREA: Rect = Rect::new(0.0, 33.0, 1512.0, 949.0);
const PAGE: Rect = Rect::new(260.0, 41.0, 1244.0, 933.0);
const DESK: Rect = Rect::new(100.0, 100.0, 1200.0, 800.0);

fn placement() -> Placement {
    Placement { page: PAGE, area: AREA, display: Rect::ZERO }
}

fn std(n: i64, b: Rect, place: WindowPlace, on_screen: Option<bool>, full: Option<bool>) -> Window {
    Window {
        on_screen,
        place,
        ever_placed: place.placed(),
        role: Some("AXWindow".into()),
        subrole: Some("AXStandardWindow".into()),
        can_full_screen: full,
        ..Window::new(n, b)
    }
}
fn s(n: i64, b: Rect, place: WindowPlace) -> Window {
    std(n, b, place, None, Some(true))
}
fn unread(n: i64, b: Rect, place: WindowPlace, on_screen: Option<bool>) -> Window {
    Window { on_screen, place, ever_placed: place.placed(), ..Window::new(n, b) }
}
fn w(n: i64, b: Rect) -> Window {
    Window::new(n, b)
}
fn app(launched: bool, hosted: &[i64]) -> AppFacts {
    AppFacts { launched_by_margin: launched, hosted: hosted.iter().copied().collect(), ..AppFacts::default() }
}

use WindowKind::*;
use WindowPlace::*;

struct Row {
    name: &'static str,
    windows: Vec<Window>,
    app: AppFacts,
    want: Vec<(i64, WindowKind)>,
    why: Vec<(i64, &'static str)>,
}

fn rows() -> Vec<Row> {
    let mut axmain_twin = s(71300, PAGE, Margin);
    axmain_twin.on_screen = Some(true);
    axmain_twin.ax_main = true;
    let mut replaced_new = std(73494, r(350.0, 33.0, 1154.0, 869.0), Margin, Some(true), Some(true));
    replaced_new.ax_main = true;
    let mut extra_main = std(73494, r(216.0, 250.0, 900.0, 560.0), Margin, Some(true), Some(true));
    extra_main.ax_main = true;
    let mut ax3 = s(3, DESK, Desktop);
    ax3.ax_main = true;
    vec![
        Row {
            name: "Safari Margin started: its restored windows leftovers, the one Margin asked for main",
            windows: vec![
                unread(71150, AREA, FullScreen, None),
                unread(71151, AREA, FullScreen, None),
                unread(71152, DESK, Desktop, None),
                s(71157, PAGE, Parked),
            ],
            app: app(true, &[71157]),
            want: vec![(71150, Leftover), (71151, Leftover), (71152, Leftover), (71157, Main)],
            why: vec![(71150, "restored"), (71157, "the window Margin hosts")],
        },
        Row {
            name: "Safari the person opened: their own windows auxiliary, the one Margin asked for main",
            windows: vec![
                unread(71150, AREA, FullScreen, None),
                unread(71152, DESK, Desktop, Some(true)),
                std(71157, PAGE, Margin, Some(true), Some(true)),
            ],
            app: app(false, &[71157]),
            want: vec![(71150, Auxiliary), (71152, Auxiliary), (71157, Main)],
            why: vec![(71152, "the person opened")],
        },
        Row {
            name: "Maps' window restored in full screen in a Space of its own, hosted: main",
            windows: vec![unread(1563, AREA, FullScreen, None)],
            app: app(true, &[1563]),
            want: vec![(1563, Main)],
            why: vec![],
        },
        Row {
            name: "...before Margin hosts it: its only window, main",
            windows: vec![unread(1563, AREA, FullScreen, None)],
            app: app(true, &[]),
            want: vec![(1563, Main)],
            why: vec![(1563, "only window")],
        },
        Row {
            name: "the Phone's only window, a dialog-subrole one 1024×768: main",
            windows: vec![Window {
                on_screen: Some(false),
                place: Margin,
                ever_placed: true,
                role: Some("AXWindow".into()),
                subrole: Some("AXDialog".into()),
                can_full_screen: Some(false),
                ..w(71265, r(370.0, 124.0, 1024.0, 768.0))
            }],
            app: app(true, &[71265]),
            want: vec![(71265, Main)],
            why: vec![(71265, "dialog-subrole")],
        },
        Row {
            name: "...not hosted yet: still main",
            windows: vec![Window {
                place: Desktop,
                ever_placed: true,
                role: Some("AXWindow".into()),
                subrole: Some("AXDialog".into()),
                can_full_screen: Some(false),
                ..w(71265, r(370.0, 124.0, 1024.0, 768.0))
            }],
            app: app(true, &[]),
            want: vec![(71265, Main)],
            why: vec![],
        },
        Row {
            name: "Dictionary's spares transient, its real window main",
            windows: vec![
                Window {
                    place: Nowhere,
                    role: Some("AXWindow".into()),
                    subrole: Some("AXDialog".into()),
                    ..w(10, r(110.0, 60.0, 1292.0, 888.0))
                },
                Window {
                    place: Nowhere,
                    role: Some("AXWindow".into()),
                    subrole: Some("AXDialog".into()),
                    ..w(11, r(110.0, 60.0, 1292.0, 888.0))
                },
                Window { place: Nowhere, ..w(12, r(110.0, 60.0, 500.0, 500.0)) },
                Window {
                    on_screen: Some(true),
                    place: Desktop,
                    ever_placed: true,
                    role: Some("AXWindow".into()),
                    subrole: Some("AXDialog".into()),
                    ..w(13, r(110.0, 60.0, 1292.0, 888.0))
                },
            ],
            app: app(true, &[13]),
            want: vec![(10, Transient), (11, Transient), (12, Transient), (13, Main)],
            why: vec![(10, "a spare")],
        },
        Row {
            name: "Messages' twin at the same frame: the hosted one main, the twin transient",
            windows: vec![
                std(71192, PAGE, Margin, Some(true), Some(true)),
                std(71300, PAGE, Margin, Some(false), Some(true)),
            ],
            app: app(true, &[71192]),
            want: vec![(71192, Main), (71300, Transient)],
            why: vec![(71300, "twin")],
        },
        Row {
            name: "Messages' hosted window in no Space, its twin at its frame: the twin main",
            windows: vec![
                Window {
                    on_screen: Some(false),
                    place: Nowhere,
                    ever_placed: true,
                    role: Some("AXWindow".into()),
                    subrole: Some("AXStandardWindow".into()),
                    ..w(71192, PAGE)
                },
                std(71300, PAGE, Margin, Some(true), Some(true)),
            ],
            app: app(true, &[71192]),
            want: vec![(71192, Transient), (71300, Main)],
            why: vec![(71300, "replaces 71192"), (71192, "replaced")],
        },
        Row {
            name: "Messages' twin Accessibility calls its main window: the twin main",
            windows: vec![std(71192, PAGE, Margin, Some(true), Some(true)), axmain_twin],
            app: app(true, &[71192]),
            want: vec![(71192, Transient), (71300, Main)],
            why: vec![],
        },
        Row {
            name: "replaced off its frame: a newer one on screen Accessibility's main: the newer one main",
            windows: vec![std(73491, r(350.0, 73.0, 1154.0, 869.0), Margin, Some(false), Some(true)), replaced_new],
            app: app(true, &[73491]),
            want: vec![(73491, Transient), (73494, Main)],
            why: vec![(73494, "replaces 73491")],
        },
        Row {
            name: "...the hosted one on screen: still main, the extra auxiliary",
            windows: vec![std(73491, r(350.0, 73.0, 1154.0, 869.0), Margin, Some(true), Some(true)), extra_main],
            app: app(true, &[73491]),
            want: vec![(73491, Main), (73494, Auxiliary)],
            why: vec![],
        },
        Row {
            name: "Messages' hosted window in no Space, no other window: still main",
            windows: vec![Window { on_screen: Some(false), place: Nowhere, ever_placed: true, ..w(71192, PAGE) }],
            app: app(true, &[71192]),
            want: vec![(71192, Main)],
            why: vec![],
        },
        Row {
            name: "Mail's 1512×88 toolbar strip: strip",
            windows: vec![
                std(69767, AREA, Margin, Some(true), Some(true)),
                Window {
                    on_screen: Some(true),
                    place: Margin,
                    ever_placed: true,
                    role: Some("AXWindow".into()),
                    subrole: Some("AXUnknown".into()),
                    ..w(69769, r(0.0, 33.0, 1512.0, 88.0))
                },
            ],
            app: app(true, &[69767]),
            want: vec![(69767, Main), (69769, Strip)],
            why: vec![],
        },
        Row {
            name: "a strip as wide as the page area only: strip",
            windows: vec![
                s(69767, PAGE, Margin),
                Window { place: Margin, ever_placed: true, ..w(69770, r(260.0, 41.0, 1244.0, 52.0)) },
            ],
            app: app(true, &[69767]),
            want: vec![(69767, Main), (69770, Strip)],
            why: vec![],
        },
        Row {
            name: "Mail's Settings window: auxiliary",
            windows: vec![
                std(69767, PAGE, Margin, Some(true), Some(true)),
                std(69800, r(500.0, 200.0, 800.0, 600.0), Margin, Some(true), Some(false)),
            ],
            app: app(true, &[69767]),
            want: vec![(69767, Main), (69800, Auxiliary)],
            why: vec![(69800, "can't go full screen")],
        },
        Row {
            name: "a sheet on the main window: dialog",
            windows: vec![
                s(5, PAGE, Margin),
                Window {
                    place: Margin,
                    ever_placed: true,
                    role: Some("AXSheet".into()),
                    ..w(6, r(600.0, 41.0, 500.0, 300.0))
                },
            ],
            app: app(true, &[5]),
            want: vec![(5, Main), (6, Dialog)],
            why: vec![(6, "a sheet")],
        },
        Row {
            name: "an alert beside the main window: dialog",
            windows: vec![
                s(5, PAGE, Margin),
                Window {
                    place: Margin,
                    ever_placed: true,
                    role: Some("AXWindow".into()),
                    subrole: Some("AXDialog".into()),
                    ..w(7, r(600.0, 300.0, 260.0, 300.0))
                },
            ],
            app: app(true, &[5]),
            want: vec![(5, Main), (7, Dialog)],
            why: vec![],
        },
        Row {
            name: "a tooltip, a menu, a popover, a tiny window: transient",
            windows: vec![
                s(5, PAGE, Margin),
                Window { layer: 3, ..w(8, r(400.0, 400.0, 120.0, 22.0)) },
                Window { layer: 101, ..w(9, r(300.0, 60.0, 220.0, 400.0)) },
                Window { place: Margin, role: Some("AXPopover".into()), ..w(10, r(300.0, 60.0, 320.0, 240.0)) },
                Window { place: Margin, ..w(11, r(0.0, 0.0, 80.0, 20.0)) },
            ],
            app: app(true, &[5]),
            want: vec![(5, Main), (8, Transient), (9, Transient), (10, Transient), (11, Transient)],
            why: vec![(8, "layer 3"), (11, "under 100 pt")],
        },
        Row {
            name: "an inspector: auxiliary",
            windows: vec![
                s(5, PAGE, Margin),
                Window {
                    place: Margin,
                    ever_placed: true,
                    role: Some("AXWindow".into()),
                    subrole: Some("AXFloatingWindow".into()),
                    ..w(12, r(1100.0, 100.0, 300.0, 500.0))
                },
            ],
            app: app(true, &[5]),
            want: vec![(5, Main), (12, Auxiliary)],
            why: vec![],
        },
        Row {
            name: "a window its app closed, still listed, the new one on screen: transient, the new one main",
            windows: vec![std(5, PAGE, Margin, Some(false), Some(true)), std(9, PAGE, Margin, Some(true), Some(true))],
            app: AppFacts { closed: [5].into(), ..app(true, &[5]) },
            want: vec![(5, Transient), (9, Main)],
            why: vec![(5, "closed")],
        },
        Row {
            name: "Safari's window opened only to wake a profile: leftover",
            windows: vec![s(69700, PAGE, Margin), s(69750, DESK, Parked)],
            app: AppFacts { woken: [69750].into(), ..app(false, &[69700]) },
            want: vec![(69700, Main), (69750, Leftover)],
            why: vec![(69750, "wake")],
        },
        Row {
            name: "Calculator (its only window can't go full screen): main",
            windows: vec![std(40, r(400.0, 300.0, 230.0, 408.0), Margin, None, Some(false))],
            app: app(true, &[40]),
            want: vec![(40, Main)],
            why: vec![],
        },
        Row {
            name: "a second document window after Margin hosted the app: auxiliary",
            windows: vec![s(5, PAGE, Margin), s(9, DESK, Margin)],
            app: app(true, &[5]),
            want: vec![(5, Main), (9, Auxiliary)],
            why: vec![],
        },
        Row {
            name: "its hosted window gone, a new one in its place: the new one main",
            windows: vec![s(9, PAGE, Margin)],
            app: app(true, &[5]),
            want: vec![(9, Main)],
            why: vec![(9, "only window")],
        },
        Row {
            name: "nothing hosted, two windows: the one in a Space main",
            windows: vec![
                Window { place: Nowhere, ever_placed: true, ..w(3, DESK) },
                unread(4, r(150.0, 150.0, 1200.0, 800.0), Desktop, None),
            ],
            app: app(true, &[]),
            want: vec![(3, Auxiliary), (4, Main)],
            why: vec![(4, "the one in a Space")],
        },
        Row {
            name: "nothing hosted, two in a Space: Accessibility's main window main",
            windows: vec![ax3, s(4, r(150.0, 150.0, 1200.0, 800.0), Desktop)],
            app: app(true, &[]),
            want: vec![(3, Main), (4, Auxiliary)],
            why: vec![(3, "Accessibility's main window")],
        },
        Row {
            name: "nothing hosted, a tie: the one that was main stays main",
            windows: vec![s(3, DESK, Desktop), s(4, r(150.0, 150.0, 1200.0, 800.0), Desktop)],
            app: AppFacts { previous_mains: [3].into(), ..app(true, &[]) },
            want: vec![(3, Main), (4, Auxiliary)],
            why: vec![(3, "main before")],
        },
        Row { name: "an app with no window: nothing", windows: vec![], app: app(true, &[]), want: vec![], why: vec![] },
    ]
}

#[test]
fn every_row() {
    for row in rows() {
        let got = classify(&row.windows, &row.app, &placement());
        let kinds: BTreeMap<i64, WindowKind> = got.iter().map(|(n, v)| (*n, v.kind)).collect();
        let want: BTreeMap<i64, WindowKind> = row.want.iter().copied().collect();
        assert_eq!(kinds, want, "{}: {got:?}", row.name);
        for (n, part) in &row.why {
            assert!(got[n].why.contains(part), "{}: {n} why {:?} lacks {part:?}", row.name, got[n].why);
        }
    }
}

#[test]
fn no_placement_no_strip() {
    let got = classify(
        &[Window { place: Margin, ..w(1, r(0.0, 33.0, 1512.0, 88.0)) }],
        &AppFacts::default(),
        &Placement::ZERO,
    );
    assert_eq!(got[&1].kind, Transient);
}

#[test]
fn every_window_gets_one_kind() {
    let all: Vec<Window> = rows()
        .into_iter()
        .flat_map(|r| r.windows)
        .enumerate()
        .map(|(i, mut w)| {
            w.number = i as i64 + 1;
            w
        })
        .collect();
    let once = classify(&all, &app(true, &[1]), &placement());
    assert_eq!(once.len(), all.len());
    assert!(once.values().any(|v| v.kind == Main));
}

// Weather, 2026-11-18 13:30: its tile set to 240,8 1264×966 (its window at 240,41 1264×933), and 0.1-0.3 s later a
// new 1264×966 window of its own in Margin's Space, closed 0.2 s after: once an auxiliary (another window of its app),
// whose close re-laid the tiles out, every rect set again, another made: 54 rounds in 18 s.
fn weather() -> (Vec<Window>, AppFacts) {
    let hosted =
        Window { first_seen: Some(100.0), ..std(91084, r(240.0, 41.0, 1264.0, 933.0), Margin, Some(true), Some(true)) };
    let answer = Window { first_seen: Some(200.2), ..unread(91222, r(240.0, 8.0, 1264.0, 966.0), Margin, Some(true)) };
    let facts = AppFacts {
        resized: Some(Resized { at: 200.0, rects: vec![r(240.0, 8.0, 1264.0, 966.0), r(240.0, 41.0, 1264.0, 933.0)] }),
        ..app(true, &[91084])
    };
    (vec![hosted, answer], facts)
}

#[test]
fn weathers_answer_to_a_resize_is_a_helper() {
    let (windows, facts) = weather();
    let got = classify(&windows, &facts, &placement());
    assert_eq!(got[&91084].kind, Main);
    assert_eq!(got[&91222].kind, Helper, "{:?}", got[&91222]);
    assert!(got[&91222].why.contains("200 ms after Margin sized its app"), "{}", got[&91222].why);
}

#[test]
fn a_helper_stays_one_even_closed() {
    let (windows, mut facts) = weather();
    facts.previous_helpers.insert(91222);
    facts.closed.insert(91222);
    facts.resized = None;
    let got = classify(&windows, &facts, &placement());
    assert_eq!(got[&91222].kind, Helper);
}

#[test]
fn not_a_helper_too_late_elsewhere_or_hosted() {
    let (mut windows, facts) = weather();
    windows[1].first_seen = Some(201.0); // a second after
    assert_eq!(classify(&windows, &facts, &placement())[&91222].kind, Auxiliary);
    let (mut windows, facts) = weather();
    windows[1].bounds = r(500.0, 200.0, 800.0, 600.0); // not a size Margin set
    assert_eq!(classify(&windows, &facts, &placement())[&91222].kind, Auxiliary);
    let (mut windows, facts) = weather();
    windows[1].first_seen = Some(199.0); // there before the resize
    assert_eq!(classify(&windows, &facts, &placement())[&91222].kind, Auxiliary);
    let (windows, mut facts) = weather();
    facts.hosted.insert(91222); // hosted: never a helper
    assert_ne!(classify(&windows, &facts, &placement())[&91222].kind, Helper);
}

#[test]
fn with_the_hosted_window_gone_a_new_one_is_its_replacement_not_a_helper() {
    let (mut windows, facts) = weather();
    windows[0].place = Nowhere;
    windows[0].on_screen = Some(false);
    let got = classify(&windows, &facts, &placement());
    assert_ne!(got[&91222].kind, Helper, "{got:?}");
    // At the hosted window's own frame, it's the replacement (main).
    let (mut windows, facts) = weather();
    windows[0].place = Nowhere;
    windows[0].on_screen = Some(false);
    windows[1].bounds = windows[0].bounds;
    assert_eq!(classify(&windows, &facts, &placement())[&91222].kind, Main);
}

#[test]
fn kept_behind_kinds() {
    assert!(Helper.kept_behind() && Transient.kept_behind() && Strip.kept_behind() && Leftover.kept_behind());
    assert!(!Main.kept_behind() && !Auxiliary.kept_behind() && !Dialog.kept_behind());
}
