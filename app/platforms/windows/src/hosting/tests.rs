//! The Windows adapter against a simulated Windows: windows with Windows' invisible borders, minimum sizes, fixed sizes,
//! the z-order against Margin's window, the taskbar, elevated processes, minimize and maximize, windows that go.

use std::collections::{BTreeMap, BTreeSet};

use margin_core::geometry::Rect;
use margin_core::host::driver::{Applied, Driver};
use margin_core::host::layout::{Edges, Size};
use margin_core::host::reconciler::{Correction, Desired, Situation, step};

use super::*;
use crate::marker::{Kept, Show};

const MARGIN: Hwnd = 1;
const AREA: Rect = Rect::new(0.0, 0.0, 1920.0, 1040.0);
const PAGE: Rect = Rect::new(300.0, 50.0, 1600.0, 980.0);
/// Windows 10/11's invisible resize borders: 7 px left, right and bottom, none at the top.
const BORDERS: Edges = Edges { left: 7.0, right: 7.0, top: 0.0, bottom: 7.0 };

#[derive(Clone, Debug)]
struct SimWin {
    pid: u32,
    visible: bool,
    minimized: bool,
    maximized: bool,
    /// Its visible frame.
    bounds: Rect,
    resizable: bool,
    min: Option<Size>,
    above_margin: bool,
    taskbar: bool,
    desktop: bool,
    /// No sizing border, yet sized by SetWindowPos all the same (a browser's own full screen: WS_POPUP).
    sized_anyway: bool,
}

#[derive(Default)]
struct Sim {
    windows: BTreeMap<Hwnd, SimWin>,
    elevated: BTreeSet<u32>,
    calls: Calls,
}

impl Sim {
    fn with(window: Hwnd, pid: u32, bounds: Rect) -> Sim {
        let mut s = Sim::default();
        s.add(window, pid, bounds);
        s
    }
    fn add(&mut self, window: Hwnd, pid: u32, bounds: Rect) {
        self.windows.insert(
            window,
            SimWin {
                pid,
                visible: true,
                minimized: false,
                maximized: false,
                bounds,
                resizable: true,
                min: None,
                above_margin: true,
                taskbar: true,
                desktop: true,
                sized_anyway: false,
            },
        );
    }
    fn count(&mut self, what: &'static str) {
        *self.calls.entry(what).or_default() += 1;
    }
    fn win(&mut self, w: Hwnd) -> &mut SimWin {
        self.windows.get_mut(&w).unwrap_or_else(|| panic!("no window {w}"))
    }
}

impl WinOs for Sim {
    fn facts(&self, window: Hwnd, pid: u32, _margin: Hwnd) -> WindowFacts {
        let Some(w) = self.windows.get(&window) else { return WindowFacts::default() };
        WindowFacts {
            exists: w.pid == pid,
            running: w.pid == pid,
            visible: w.visible,
            minimized: w.minimized,
            maximized: w.maximized,
            bounds: w.bounds,
            outer: BORDERS.outset(&w.bounds),
            resizable: w.resizable,
            above_margin: w.above_margin && w.visible,
            on_current_desktop: w.desktop,
        }
    }
    fn place(&mut self, window: Hwnd, outer: Rect, _margin: Hwnd, restore: bool) -> bool {
        self.count("place");
        let elevated = self.windows.get(&window).is_some_and(|w| self.elevated.contains(&w.pid));
        let Some(w) = self.windows.get_mut(&window) else { return false };
        if elevated {
            return false;
        }
        if restore {
            w.minimized = false;
            w.maximized = false;
        }
        w.visible = true;
        w.above_margin = false;
        let asked = BORDERS.inset(&outer);
        w.bounds = if !w.resizable && !w.sized_anyway {
            Rect::new(asked.x, asked.y, w.bounds.width, w.bounds.height)
        } else {
            let min = w.min.unwrap_or_default();
            Rect::new(asked.x, asked.y, asked.width.max(min.width), asked.height.max(min.height))
        };
        true
    }
    fn hide(&mut self, window: Hwnd) -> bool {
        self.count("hide");
        self.windows.get_mut(&window).map(|w| w.visible = false).is_some()
    }
    fn restack(&mut self, window: Hwnd, _margin: Hwnd) -> bool {
        self.count("restack");
        self.windows.get_mut(&window).map(|w| w.above_margin = false).is_some()
    }
    fn taskbar(&mut self, window: Hwnd, shown: bool) -> bool {
        self.count(if shown { "taskbar on" } else { "taskbar off" });
        self.windows.get_mut(&window).map(|w| w.taskbar = shown).is_some()
    }
    fn placement(&self, window: Hwnd) -> Option<Kept> {
        let w = self.windows.get(&window)?;
        let show = if w.maximized {
            Show::Maximized
        } else if w.minimized {
            Show::Minimized
        } else if w.visible {
            Show::Normal
        } else {
            Show::Hidden
        };
        Some(Kept { normal: w.bounds, show })
    }
    fn set_placement(&mut self, window: Hwnd, kept: &Kept) -> bool {
        self.count("set placement");
        let Some(w) = self.windows.get_mut(&window) else { return false };
        w.bounds = kept.normal;
        w.maximized = kept.show == Show::Maximized;
        w.minimized = kept.show == Show::Minimized;
        w.visible = kept.show != Show::Hidden;
        true
    }
    fn close(&mut self, window: Hwnd) -> bool {
        self.count("close");
        self.windows.remove(&window).is_some()
    }
    fn higher_integrity(&self, pid: u32) -> Option<bool> {
        Some(self.elevated.contains(&pid))
    }
    fn started(&self, pid: u32) -> Option<u64> {
        Some(pid as u64 * 1000)
    }
}

fn hosting(sim: Sim) -> Hosting<Sim> {
    Hosting::new(sim, MARGIN, AREA)
}

/// The driver's passes until nothing's left to do (at most 20), the shell's look before each.
fn settle(d: &mut Driver, h: &mut Hosting<Sim>, t: &mut f64) -> Vec<(String, Correction, Applied)> {
    let mut passes = Vec::new();
    for _ in 0..20 {
        h.at(*t);
        h.observe();
        match d.reconcile(*t, h) {
            Some(p) => passes.push(p),
            None => return passes,
        }
        *t += 0.05;
    }
    panic!("never settled: {passes:?}");
}

fn host(id: &str, window: Hwnd, pid: u32) -> WinHost {
    WinHost::new(id, window, pid, "C:\\Windows\\notepad.exe", WinRoute::Window)
}

#[test]
fn hosted_at_its_rect_under_margins_window_its_taskbar_button_gone_then_settled() {
    let mut h = hosting(Sim::with(10, 42, Rect::new(100.0, 100.0, 800.0, 600.0)));
    h.host(host("app:notepad", 10, 42)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("app:notepad", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    d.shown("app:notepad");
    let passes = settle(&mut d, &mut h, &mut t);
    assert_eq!(passes.iter().map(|p| p.1.clone()).collect::<Vec<_>>(), vec![Correction::FrameWindow]);
    let w = &h.os.windows[&10];
    assert_eq!(w.bounds, PAGE, "its visible frame exactly the page area (its invisible borders outside it)");
    assert!(!w.above_margin && !w.taskbar && w.visible);
    assert_eq!(h.os.calls.get("place"), Some(&1));
    assert_eq!(settle(&mut d, &mut h, &mut t), vec![], "nothing more: no poll, no second placing");
    // As found first, for the give-back.
    assert_eq!(h.hosts[0].kept, Some(Kept { normal: Rect::new(100.0, 100.0, 800.0, 600.0), show: Show::Normal }));
}

#[test]
fn parked_hidden_and_shown_again() {
    let mut h = hosting(Sim::with(10, 42, PAGE));
    h.host(host("app:notepad", 10, 42)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("app:notepad", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    settle(&mut d, &mut h, &mut t);
    // Parked: hidden at once; a window its app shows again is parked again.
    h.set_rect("app:notepad", None);
    assert_eq!(h.desired("app:notepad"), Desired::Parked);
    assert!(!h.os.windows[&10].visible, "hidden as it's parked, nothing waited for");
    h.os.win(10).visible = true;
    let passes = settle(&mut d, &mut h, &mut t);
    assert_eq!(passes.last().map(|p| p.1.clone()), Some(Correction::ParkAgain), "{passes:?}");
    assert!(!h.os.windows[&10].visible);
    // Shown again at another rect (a pane).
    let pane = Rect::new(300.0, 50.0, 790.0, 980.0);
    h.set_rect("app:notepad", Some(pane));
    d.shown("app:notepad");
    settle(&mut d, &mut h, &mut t);
    assert_eq!(h.os.windows[&10].bounds, pane);
    assert!(h.os.windows[&10].visible);
}

#[test]
fn a_click_in_the_hole_is_put_back_under_every_time_an_apps_own_raising_is_a_loop_stopped_at_the_third() {
    let mut h = hosting(Sim::with(10, 42, PAGE));
    h.host(host("app:notepad", 10, 42)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("app:notepad", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    settle(&mut d, &mut h, &mut t);
    for i in 0..6 {
        h.os.win(10).above_margin = true;
        h.at(10.0 + i as f64 * 0.3);
        assert_eq!(h.keep_order(true), 1, "the person's click {i}: under Margin's window again");
    }
    assert!(h.events.is_empty());
    assert_eq!(h.keep_order(false), 0, "nothing in front: nothing done");
    for i in 0..4 {
        h.os.win(10).above_margin = true;
        h.at(20.0 + i as f64 * 0.3);
        h.keep_order(false);
    }
    assert_eq!(h.os.calls.get("restack"), Some(&8), "six clicks and two of the app's own, the third stopped");
    assert!(matches!(&h.events[..], [Event::Stopped { host, .. }] if host == "app:notepad"), "{:?}", h.events);
}

#[test]
fn the_person_minimizing_or_maximizing_the_hosted_window_is_margins_to_follow() {
    let mut h = hosting(Sim::with(10, 42, PAGE));
    h.host(host("app:notepad", 10, 42)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("app:notepad", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    settle(&mut d, &mut h, &mut t);
    h.os.win(10).minimized = true;
    h.observe();
    h.observe();
    assert_eq!(h.events, vec![Event::MinimizeMargin { host: "app:notepad".into() }], "said once");
    // Margin's window minimizes too: parked, nothing brought back meanwhile.
    h.margin_minimized(true);
    assert_eq!(settle(&mut d, &mut h, &mut t), vec![]);
    // Restored: shown again, out of its minimize.
    h.margin_minimized(false);
    d.shown("app:notepad");
    settle(&mut d, &mut h, &mut t);
    assert!(!h.os.windows[&10].minimized && h.os.windows[&10].visible);
    assert_eq!(h.os.windows[&10].bounds, PAGE);
    // Maximized by the person: said; placed back (restored first) until the shell maximizes Margin's window.
    h.events.clear();
    h.os.win(10).maximized = true;
    h.os.win(10).bounds = AREA;
    let passes = settle(&mut d, &mut h, &mut t);
    assert_eq!(h.events, vec![Event::MaximizeMargin { host: "app:notepad".into() }]);
    assert_eq!(passes.iter().map(|p| p.1.clone()).collect::<Vec<_>>(), vec![Correction::FrameWindow]);
    assert!(!h.os.windows[&10].maximized);
    assert_eq!(h.os.windows[&10].bounds, PAGE);
}

#[test]
fn a_window_that_cant_be_that_small_at_its_minimum_and_one_that_cant_be_resized_centred() {
    let mut sim = Sim::with(10, 42, PAGE);
    sim.win(10).min = Some(Size::new(1800.0, 500.0));
    sim.add(20, 43, Rect::new(0.0, 0.0, 400.0, 300.0));
    sim.win(20).resizable = false;
    let mut h = hosting(sim);
    h.host(host("app:wide", 10, 42)).unwrap_or_else(|e| panic!("{e:?}"));
    h.host(host("app:calc", 20, 43)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("app:wide", Some(PAGE));
    h.set_rect("app:calc", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    let passes = settle(&mut d, &mut h, &mut t);
    assert!(passes.len() <= 4, "learned from one read back each, placed again once: {passes:?}");
    let wide = h.os.windows[&10].bounds;
    assert_eq!(
        (wide.width, wide.max_x(), wide.y),
        (1800.0, PAGE.max_x(), PAGE.y),
        "right edge and top the page area's"
    );
    let calc = h.os.windows[&20].bounds;
    assert_eq!((calc.width, calc.height), (400.0, 300.0), "its own size");
    assert_eq!((calc.x, calc.y), (PAGE.x + 600.0, PAGE.y + 340.0), "centred in the page area");
    assert_eq!(settle(&mut d, &mut h, &mut t), vec![], "settled: no fight with what it holds");
}

#[test]
fn a_browser_on_the_covered_route_its_toolbar_under_margins_window() {
    let mut h = hosting(Sim::with(10, 42, PAGE));
    let mut b = WinHost::new("chrome:p-1", 10, 42, "chrome.exe", WinRoute::Covered);
    b.insets = Edges { left: 0.0, right: 0.0, top: 86.0, bottom: 0.0 };
    b.made_by_margin = true;
    b.browser_window = Some(("chrome:p-1".into(), 77));
    h.host(b).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("chrome:p-1", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    settle(&mut d, &mut h, &mut t);
    assert_eq!(h.os.windows[&10].bounds, Rect::new(PAGE.x, PAGE.y - 86.0, PAGE.width, PAGE.height + 86.0));
    assert_eq!(h.hosts[0].kept, None, "Margin made it: nothing to put back");
    assert_eq!(h.give_back("chrome:p-1"), GaveBack::CloseByCopy { link: "chrome:p-1".into(), window_id: 77 });
    assert!(h.os.windows[&10].taskbar, "its taskbar button back");
}

#[test]
fn framed_placements_that_dont_hold_step_down_to_covered_which_holds() {
    // Chromium refitting its full-screen window to its monitor after each placing (the real-PC question, §4.4): two
    // placings that didn't hold by the next look, then the covered route, which holds (no full screen to refit).
    let mut h = hosting(Sim::with(10, 42, PAGE));
    h.host(WinHost::new("chrome:p-1", 10, 42, "chrome.exe", WinRoute::Framed)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("chrome:p-1", Some(PAGE));
    let mut d = Driver::new();
    d.shown("chrome:p-1");
    let mut placings = 0;
    for i in 0..12 {
        let t = i as f64 * 0.3;
        h.at(t);
        h.observe();
        // (The shell, on a step down: a new route, so the guard's counts and the budgets start again, as the core's
        // own route change does: `guard.cleared`.)
        if h.events.iter().any(|e| matches!(e, Event::SteppedDown { .. })) && h.hosts[0].misses == 0 && placings == 2 {
            d.guard.cleared("chrome:p-1");
            d.reset_tries("chrome:p-1");
        }
        if let Some((_, _, Applied::Done)) = d.reconcile(t, &mut h) {
            placings += 1;
            if h.hosts[0].route == WinRoute::Framed {
                h.os.win(10).bounds = AREA; // (it went back to the whole monitor)
            }
        }
    }
    assert_eq!(h.hosts[0].route, WinRoute::Covered, "{:?}", h.said);
    assert!(matches!(&h.events[..], [Event::SteppedDown { host, .. }] if host == "chrome:p-1"), "{:?}", h.events);
    assert_eq!(placings, 3, "two that didn't hold, one that did");
    assert_eq!(h.os.windows[&10].bounds, PAGE);
}

#[test]
fn an_elevated_app_is_never_hosted() {
    let mut sim = Sim::with(10, 42, PAGE);
    sim.elevated.insert(42);
    let mut h = hosting(sim);
    assert_eq!(h.host(host("app:regedit", 10, 42)), Err(Refusal::Elevated));
    assert!(h.hosts.is_empty());
    assert_eq!(h.os.calls.get("place"), None, "nothing asked of it");
}

#[test]
fn its_window_gone_its_item_closes_after_the_grace() {
    let mut h = hosting(Sim::with(10, 42, PAGE));
    h.host(host("app:notepad", 10, 42)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("app:notepad", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    settle(&mut d, &mut h, &mut t);
    h.os.windows.remove(&10);
    let first = settle(&mut d, &mut h, &mut t);
    assert!(
        first.iter().all(|p| matches!(p.1, Correction::Wait { .. })),
        "within the grace: waited for another: {first:?}"
    );
    t += 1.5;
    let later = settle(&mut d, &mut h, &mut t);
    assert!(later.iter().any(|p| p.1 == Correction::CloseItem), "{later:?}");
    assert!(h.events.contains(&Event::Closed { host: "app:notepad".into() }));
}

#[test]
fn given_back_as_found_and_its_record_for_a_crash() {
    let mut sim = Sim::with(10, 42, Rect::new(10.0, 10.0, 500.0, 400.0));
    sim.win(10).maximized = true;
    let mut h = hosting(sim);
    h.host(host("app:notepad", 10, 42)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("app:notepad", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    settle(&mut d, &mut h, &mut t);
    assert!(!h.os.windows[&10].maximized, "restored to be placed");
    let records = h.records();
    assert_eq!(records.len(), 1);
    assert_eq!((records[0].hwnd, records[0].pid, records[0].started), (10, 42, 42_000));
    assert!(records[0].taskbar_removed && !records[0].hidden);
    assert_eq!(records[0].kept.map(|k| k.show), Some(Show::Maximized));
    assert_eq!(h.give_back("app:notepad"), GaveBack::Restored);
    let w = &h.os.windows[&10];
    assert!(w.maximized && w.taskbar, "maximized again, its taskbar button back");
    assert_eq!(w.bounds, Rect::new(10.0, 10.0, 500.0, 400.0));
    assert!(h.hosts.is_empty());
    assert_eq!(h.give_back("app:notepad"), GaveBack::NotHosted);
}

#[test]
fn an_app_window_margin_made_is_closed_when_given_back() {
    let mut h = hosting(Sim::with(10, 42, PAGE));
    let mut made = host("app:notepad", 10, 42);
    made.made_by_margin = true;
    h.host(made).unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(h.give_back_all(), vec![("app:notepad".to_string(), GaveBack::Closed)]);
    assert_eq!(h.os.calls.get("close"), Some(&1));
}

#[test]
fn another_desktop_said_once() {
    let mut h = hosting(Sim::with(10, 42, PAGE));
    h.host(host("app:notepad", 10, 42)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("app:notepad", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    settle(&mut d, &mut h, &mut t);
    h.os.win(10).desktop = false;
    h.observe();
    h.observe();
    assert_eq!(h.events, vec![Event::OtherDesktop { host: "app:notepad".into() }]);
}

#[test]
fn a_hosts_situation_as_the_core_reads_it() {
    let h = WinHost { rect: Some(PAGE), ..WinHost::new("app:x", 1, 1, "x", WinRoute::Window) };
    let at = WindowFacts {
        exists: true,
        running: true,
        visible: true,
        bounds: PAGE,
        resizable: true,
        on_current_desktop: true,
        ..WindowFacts::default()
    };
    let s: Situation = situation(&h, &at, &AREA);
    assert_eq!(step(&s, Desired::Shown), vec![Correction::FrameWindow], "not placed yet: placed once");
    let placed = WinHost { placed: true, ..h.clone() };
    assert_eq!(step(&situation(&placed, &at, &AREA), Desired::Shown), vec![]);
    let off = WindowFacts { bounds: Rect::new(0.0, 0.0, 100.0, 100.0), ..at };
    assert_eq!(step(&situation(&placed, &off, &AREA), Desired::Shown), vec![Correction::FrameWindow]);
}

#[test]
fn a_browsers_own_full_screen_has_no_sizing_border_and_still_follows_the_page_area() {
    // (Chromium's full-screen window is WS_POPUP: no WS_THICKFRAME, yet SetWindowPos sizes it. Taking it for a
    // fixed-size window would keep it at its first size when Margin's window is resized.)
    let mut sim = Sim::with(10, 42, AREA);
    sim.win(10).resizable = false;
    sim.win(10).sized_anyway = true;
    let mut h = hosting(sim);
    h.host(WinHost::new("chrome:p-1", 10, 42, "chrome.exe", WinRoute::Framed)).unwrap_or_else(|e| panic!("{e:?}"));
    h.set_rect("chrome:p-1", Some(PAGE));
    let (mut d, mut t) = (Driver::new(), 0.0);
    settle(&mut d, &mut h, &mut t);
    assert_eq!(h.os.windows[&10].bounds, PAGE);
    assert_eq!(h.hosts[0].fixed, None);
    let narrower = Rect::new(500.0, 50.0, 1400.0, 980.0);
    h.set_rect("chrome:p-1", None);
    h.set_rect("chrome:p-1", Some(narrower));
    d.shown("chrome:p-1");
    settle(&mut d, &mut h, &mut t);
    assert_eq!(h.os.windows[&10].bounds, narrower, "at the new page area, not its first size");
}
