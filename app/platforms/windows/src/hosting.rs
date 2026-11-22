//! Hosting on Windows (docs/HOSTED-WINDOWS-CHROMIUM.md §4.3): margin-core's reconcile driver (host/driver.rs
//! `HostAdapter`) with Windows's own way of doing each thing, so the decisions are the core's, the same code as the
//! Mac's. Windows has no Spaces and no full screen of the macOS kind: a hosted window is a plain top-level window Margin
//! keeps at its rect in the page area, directly under Margin's window in the z-order (Margin's window is in front, the
//! page area a hole in it: hole.rs); parked, it's hidden (`SW_HIDE`: no taskbar button, not in Alt+Tab; DWM's cloak is
//! refused for another process's windows).
//!
//! What's here, OS-neutral over a small trait of Win32 calls (`WinOs`), so it's tested on any OS against a simulated
//! Windows (the tests below); the Win32 calls themselves are `win32`, `cfg(windows)`:
//! - a host's frame: its rect (a page area, a pane, the card), outset by its own toolbar on the covered route (a
//!   browser whose toolbar lies under Margin's window) and by Windows' invisible borders, at its minimum when it can't be
//!   smaller (`layout::fit`), centred when it can't be resized at all;
//! - placed (`SWP_NOACTIVATE`, after Margin's window: directly under it), checked by reading back (the visible frame
//!   within a pixel), maximized ones restored first;
//! - parked (hidden) and shown again; its taskbar button removed while it's hosted and given back with it;
//! - kept under Margin's window (`keep_order`): a click in the hole raises the hosted window over Margin's, so it's
//!   put back under, the person's click never counted as a loop, an app's own raising counted by the core's loop guard;
//! - what it tells the shell (`Event`): the person minimized or maximized the hosted window (Margin's window should),
//!   its window went, it's on another virtual desktop, a fallback;
//! - refused: an app running at a higher integrity level (an elevated app: Windows refuses Margin's calls on it);
//! - given back: as it was found (its placement, its taskbar button), or closed when Margin made it;
//! - the crash marker's records (marker.rs).
//!
//! Compile-checked for both Windows targets and unit-checked; no real Windows run yet (docs/windows/UNVERIFIED.md).

use std::collections::BTreeMap;

use margin_core::geometry::Rect;
use margin_core::host::driver::{Applied, HostAdapter};
use margin_core::host::guard::{LoopGuard, Verdict};
use margin_core::host::kinds::WindowPlace;
use margin_core::host::layout::{self, Edges, Size};
use margin_core::host::reconciler::{Correction, Desired, Forward, Mode, Phase, Situation};
use margin_core::host::routes::Route;

use crate::marker::{Kept, Record};

/// A window handle as a number (`HWND`'s value).
pub type Hwnd = i64;

/// What Windows says of one hosted window, read in one go.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WindowFacts {
    /// The handle still names a window (IsWindow), and it's still its process's.
    pub exists: bool,
    pub running: bool,
    /// Shown (IsWindowVisible), minimized (IsIconic), maximized (IsZoomed).
    pub visible: bool,
    pub minimized: bool,
    pub maximized: bool,
    /// Its visible frame (DWMWA_EXTENDED_FRAME_BOUNDS) and its window rect (GetWindowRect), physical pixels: the
    /// difference is Windows' invisible resize borders.
    pub bounds: Rect,
    pub outer: Rect,
    /// It has a sizing border (WS_THICKFRAME): it can be resized at all.
    pub resizable: bool,
    /// It's in front of Margin's window in the z-order (a click in the hole raised it).
    pub above_margin: bool,
    /// On the virtual desktop shown now (IsWindowOnCurrentVirtualDesktop; true when it can't be read).
    pub on_current_desktop: bool,
}

/// Windows' calls the adapter makes, one each; the real ones are `win32::Win32`.
pub trait WinOs {
    fn facts(&self, window: Hwnd, pid: u32, margin: Hwnd) -> WindowFacts;
    /// Shown without activating (`SW_SHOWNOACTIVATE`, which also restores a minimized or maximized one: `restore`), at
    /// `outer` (its window rect), directly under `margin` in the z-order, never activated.
    fn place(&mut self, window: Hwnd, outer: Rect, margin: Hwnd, restore: bool) -> bool;
    /// Hidden (`SW_HIDE`).
    fn hide(&mut self, window: Hwnd) -> bool;
    /// Moved directly under `margin` in the z-order, nothing else changed (its keyboard kept).
    fn restack(&mut self, window: Hwnd, margin: Hwnd) -> bool;
    /// Its taskbar button: removed (`ITaskbarList::DeleteTab`) or given back (`AddTab`).
    fn taskbar(&mut self, window: Hwnd, shown: bool) -> bool;
    /// Its placement (`GetWindowPlacement` and whether it's visible), before Margin touches it.
    fn placement(&self, window: Hwnd) -> Option<Kept>;
    /// Put back as kept (`SetWindowPlacement`, then shown or hidden as it was).
    fn set_placement(&mut self, window: Hwnd, kept: &Kept) -> bool;
    /// Asked to close (`WM_CLOSE`: its app may ask to save).
    fn close(&mut self, window: Hwnd) -> bool;
    /// Whether its process runs at a higher integrity level than Margin's (None: can't be read).
    fn higher_integrity(&self, pid: u32) -> Option<bool>;
    /// Its process's start time (with the pid, the process itself: marker.rs).
    fn started(&self, pid: u32) -> Option<u64>;
}

/// How a host is held at its rect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinRoute {
    /// A browser's own full screen (no toolbar at all), held at its rect.
    Framed,
    /// A normal window whose page is its rect, its own toolbar lying under Margin's window (`insets`).
    Covered,
    /// Any window, as it is, at its rect.
    Window,
}

impl WinRoute {
    /// The core's rungs, until it has Windows' own (docs/HOSTED-WINDOWS-CHROMIUM.md §10 item 2): framed is a full-screen
    /// window Margin places (`members`), the others plain windows (`window mode`).
    pub fn core(self) -> Route {
        match self {
            WinRoute::Framed => Route::Members,
            WinRoute::Covered | WinRoute::Window => Route::Window,
        }
    }
}

/// One hosted window as Margin keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct WinHost {
    /// margin-core's host id (`chrome:<profile>`, `app:<id>`).
    pub id: String,
    pub window: Hwnd,
    pub pid: u32,
    /// Its app's identity for the routes (an executable's path, or an AppUserModelID) and version.
    pub app: String,
    pub version: String,
    pub route: WinRoute,
    /// The covered route's toolbar: how far its window reaches past its page each side, physical pixels.
    pub insets: Edges,
    /// Its rect while it should be shown (a page area, a pane, the card: screen pixels); None: parked.
    pub rect: Option<Rect>,
    /// Margin made it (a browser window a copy made, an app Margin started): closed when given back.
    pub made_by_margin: bool,
    /// A browser window a copy made: its link and window id (closed by that copy when given back).
    pub browser_window: Option<(String, i64)>,
    /// As it was before Margin touched it (None: Margin made it).
    pub kept: Option<Kept>,
    /// Learned from what it holds: the smallest it was seen at when asked smaller; or, not resizable, its size.
    pub min: Option<Size>,
    pub fixed: Option<Size>,
    placed: bool,
    taskbar_removed: bool,
    off_screen_reads: u32,
    stray_reads: u32,
    gone_since: Option<f64>,
    said_minimized: bool,
    said_maximized: bool,
    said_desktop: bool,
    /// Placements of the framed route that didn't hold by the next look (Chromium refitting its full-screen window).
    misses: u32,
}

impl WinHost {
    pub fn new(id: impl Into<String>, window: Hwnd, pid: u32, app: impl Into<String>, route: WinRoute) -> Self {
        WinHost {
            id: id.into(),
            window,
            pid,
            app: app.into(),
            version: String::new(),
            route,
            insets: Edges::ZERO,
            rect: None,
            made_by_margin: false,
            browser_window: None,
            kept: None,
            min: None,
            fixed: None,
            placed: false,
            taskbar_removed: false,
            off_screen_reads: 0,
            stray_reads: 0,
            gone_since: None,
            said_minimized: false,
            said_maximized: false,
            said_desktop: false,
            misses: 0,
        }
    }
}

/// Why a window isn't hosted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Its app runs as administrator (higher integrity): Windows refuses Margin's calls on its windows.
    Elevated,
    AlreadyHosted,
}

/// What the adapter tells the shell (the session decides what Margin does about it).
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The person minimized a shown host (Win+↓ while it had the keys): Margin's window should minimize with it.
    MinimizeMargin { host: String },
    /// The person maximized a shown host (Win+↑): Margin's window should maximize (it's placed again after).
    MaximizeMargin { host: String },
    /// A shown host is on another virtual desktop than Margin's window.
    OtherDesktop { host: String },
    /// Its window went and no other took its place: its item closes (the reconciler's `closeItem`).
    Closed { host: String },
    /// The reconciler gave up on it: parked, nothing shown, said.
    Fallback { host: String, why: String },
    /// Its framed placements didn't hold (the browser kept its full screen at its monitor's size): down to the covered
    /// route; the shell takes it out of full screen through its copy, gives it its toolbar's insets, records the step
    /// down for its app's version (`driver.routes.step_down`) and starts its counts again (`driver.guard.cleared`,
    /// `driver.reset_tries`), as the core does for a route change of its own.
    SteppedDown { host: String, why: String },
    /// The loop guard stopped a correction or a restack.
    Stopped { host: String, why: String },
}

/// How a host was given back.
#[derive(Clone, Debug, PartialEq)]
pub enum GaveBack {
    /// Put back as it was found.
    Restored,
    /// A browser window a copy made: the shell asks that copy's `closeWindow`.
    CloseByCopy {
        link: String,
        window_id: i64,
    },
    /// An app's window Margin made: asked to close.
    Closed,
    NotHosted,
}

/// Placements of the framed route that may fail to hold before it steps down to the covered route.
pub const FRAMED_MISSES: u32 = 2;
/// One read on Windows counts as the reconciler's two (`OFF_SCREEN_AFTER`, the stray rule): no transitions to wait out.
const READS: u32 = 2;

/// A frame within a pixel of another.
fn near(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() <= 1.0
        && (a.y - b.y).abs() <= 1.0
        && (a.width - b.width).abs() <= 1.0
        && (a.height - b.height).abs() <= 1.0
}

/// A window that can't be resized, centred in `rect` when it's smaller; else as `layout::fit` puts a window at its
/// minimum (until margin-core has it: docs/HOSTED-WINDOWS-CHROMIUM.md §10 item 3).
fn inside(rect: &Rect, size: Size, area: &Rect) -> Rect {
    if size.width <= rect.width + 0.5 && size.height <= rect.height + 0.5 {
        let x = (rect.x + (rect.width - size.width) / 2.0).round();
        let y = (rect.y + (rect.height - size.height) / 2.0).round();
        return Rect::new(x, y, size.width, size.height);
    }
    layout::fit(rect, Some(size), area)
}

/// Its frame's invisible borders: the window rect past its visible frame, each side (never negative).
fn borders(f: &WindowFacts) -> Edges {
    if f.outer.width <= 0.0 || f.bounds.width <= 0.0 {
        return Edges::ZERO;
    }
    Edges {
        left: (f.bounds.min_x() - f.outer.min_x()).max(0.0),
        top: (f.bounds.min_y() - f.outer.min_y()).max(0.0),
        right: (f.outer.max_x() - f.bounds.max_x()).max(0.0),
        bottom: (f.outer.max_y() - f.bounds.max_y()).max(0.0),
    }
}

/// Where a host's visible frame should be for its rect: outset by its own toolbar (the covered route), at its
/// minimum or its fixed size within `area` (its monitor's work area).
pub fn wanted(h: &WinHost, rect: &Rect, area: &Rect) -> Rect {
    let page = if h.route == WinRoute::Covered { h.insets.outset(rect) } else { *rect };
    match h.fixed {
        Some(size) => inside(&page, size, area),
        None => layout::fit(&page, h.min, area),
    }
}

/// A host's facts as margin-core's situation (window mode: Windows has one "Space", the desktop Margin's window is on).
pub fn situation(h: &WinHost, f: &WindowFacts, area: &Rect) -> Situation {
    let place = if !f.exists {
        WindowPlace::Nowhere
    } else if f.visible && !f.minimized {
        if h.rect.is_some() { WindowPlace::Margin } else { WindowPlace::Desktop }
    } else {
        WindowPlace::Parked
    };
    Situation {
        running: f.running || !f.exists,
        launched_by_margin: h.made_by_margin,
        phase: match (h.rect.is_some(), h.placed) {
            (true, true) => Phase::Shown,
            (true, false) => Phase::Preparing,
            (false, _) => Phase::Parked,
        },
        mode: Mode::Window,
        window: Some(h.window),
        window_gone: !f.exists,
        place,
        on_screen: Some(f.visible && !f.minimized),
        off_screen_reads: h.off_screen_reads,
        stray_reads: h.stray_reads,
        at_page: h.rect.map(|r| near(&f.bounds, &wanted(h, &r, area))),
        can_full_screen: Some(false),
        margin_current: true,
        gone_for: None,
        ..Situation::default()
    }
}

/// The windows Margin hosts in one Margin window, and Windows' calls for them.
pub struct Hosting<O: WinOs> {
    pub os: O,
    /// Margin's window: every shown host lies directly under it.
    pub margin: Hwnd,
    /// The work area of the monitor Margin's window is on (physical pixels): a window at its minimum stays within it.
    pub area: Rect,
    pub hosts: Vec<WinHost>,
    /// What happened since the shell last took it.
    pub events: Vec<Event>,
    /// Lines for the log.
    pub said: Vec<String>,
    /// Restacks the app caused itself (never the person's click), through the core's loop guard.
    guard: LoopGuard,
    /// Margin's window is minimized: every host parked whatever its rect.
    minimized: bool,
    now: f64,
}

impl<O: WinOs> Hosting<O> {
    pub fn new(os: O, margin: Hwnd, area: Rect) -> Self {
        Hosting {
            os,
            margin,
            area,
            hosts: Vec::new(),
            events: Vec::new(),
            said: Vec::new(),
            guard: LoopGuard::new(),
            minimized: false,
            now: 0.0,
        }
    }

    /// The clock the next pass reads (seconds, monotonic): set by the shell before `reconcile`.
    pub fn at(&mut self, now: f64) {
        self.now = now;
    }

    fn get(&self, id: &str) -> Option<&WinHost> {
        self.hosts.iter().find(|h| h.id == id)
    }
    fn get_mut(&mut self, id: &str) -> Option<&mut WinHost> {
        self.hosts.iter_mut().find(|h| h.id == id)
    }

    /// A window to host: refused for an elevated app; recorded as it is first (its placement), unless Margin made it.
    pub fn host(&mut self, mut h: WinHost) -> Result<(), Refusal> {
        if self.get(&h.id).is_some() {
            return Err(Refusal::AlreadyHosted);
        }
        if self.os.higher_integrity(h.pid) == Some(true) {
            self.said.push(format!("{}: runs as administrator: Margin can't hold its window", h.id));
            return Err(Refusal::Elevated);
        }
        if !h.made_by_margin && h.kept.is_none() {
            h.kept = self.os.placement(h.window);
        }
        self.hosts.push(h);
        Ok(())
    }

    /// Shown at `rect` (screen pixels), or parked (None): hidden at once (a park is Margin's own change, never
    /// waited for), shown by the next reconcile.
    pub fn set_rect(&mut self, id: &str, rect: Option<Rect>) {
        let Some(h) = self.get_mut(id) else { return };
        let show = h.rect.is_none() && rect.is_some();
        if show {
            h.placed = false; // (a new show: placed again, its budgets the driver's `shown`)
            h.misses = 0;
        }
        let park = h.rect.is_some() && rect.is_none();
        h.rect = rect;
        let window = h.window;
        if park {
            self.os.hide(window);
        }
        if show {
            self.guard.cleared(id); // (a restack stopped at its last show is tried again at this one)
        }
    }

    /// Margin's window minimized or restored: every host parked, or shown again at its rect.
    pub fn margin_minimized(&mut self, on: bool) {
        self.minimized = on;
        if !on {
            for h in &mut self.hosts {
                h.placed = false;
                h.said_minimized = false;
                h.said_maximized = false;
            }
        }
    }

    fn desired_of(&self, h: &WinHost) -> Desired {
        if h.rect.is_some() && !self.minimized { Desired::Shown } else { Desired::Parked }
    }

    /// A look after Windows said something changed (a window event): what the person did to a shown host, said once
    /// each, and the read counters the reconciler goes by.
    pub fn observe(&mut self) {
        let margin = self.margin;
        let minimized = self.minimized;
        for i in 0..self.hosts.len() {
            let f = self.os.facts(self.hosts[i].window, self.hosts[i].pid, margin);
            let h = &mut self.hosts[i];
            let shown = h.rect.is_some() && !minimized;
            if !f.exists {
                h.gone_since.get_or_insert(self.now);
                continue;
            }
            h.gone_since = None;
            if shown
                && h.placed
                && h.route == WinRoute::Framed
                && f.visible
                && !f.minimized
                && let Some(rect) = h.rect
                && !near(&f.bounds, &wanted(h, &rect, &self.area))
            {
                h.misses += 1;
                h.placed = false;
                if h.misses >= FRAMED_MISSES {
                    let why = format!("its full screen didn't hold at its rect {} times", h.misses);
                    h.route = WinRoute::Covered;
                    h.misses = 0;
                    self.said.push(format!("{}: {why}: the covered route", h.id));
                    self.events.push(Event::SteppedDown { host: h.id.clone(), why });
                }
            }
            if shown && h.placed {
                if f.minimized && !h.said_minimized {
                    h.said_minimized = true;
                    self.events.push(Event::MinimizeMargin { host: h.id.clone() });
                } else if f.maximized && !h.said_maximized {
                    h.said_maximized = true;
                    self.events.push(Event::MaximizeMargin { host: h.id.clone() });
                }
                if !f.on_current_desktop && !h.said_desktop {
                    h.said_desktop = true;
                    self.events.push(Event::OtherDesktop { host: h.id.clone() });
                } else if f.on_current_desktop {
                    h.said_desktop = false;
                }
            }
            // (Windows' reads are final, with no Space transition to wait out: one read is the Mac's two.)
            let off = shown && h.placed && (!f.visible || f.minimized) && !h.said_minimized;
            h.off_screen_reads = if off { READS } else { 0 };
            let stray = !shown && f.visible && !f.minimized;
            h.stray_reads = if stray { READS } else { 0 };
        }
    }

    /// Every shown host put back directly under Margin's window if something raised it over. `person`: the person's
    /// input just came before (a click in the hole): never counted as a loop. Else the app raised its own window: the
    /// loop guard's (three times within 5 s stops that host's restacks, said once).
    pub fn keep_order(&mut self, person: bool) -> usize {
        let margin = self.margin;
        let mut done = 0;
        for i in 0..self.hosts.len() {
            let (id, window, pid, shown) = {
                let h = &self.hosts[i];
                (h.id.clone(), h.window, h.pid, h.rect.is_some() && h.placed && !self.minimized)
            };
            if !shown || !self.os.facts(window, pid, margin).above_margin {
                continue;
            }
            if person {
                self.guard.person(Some(&id));
            }
            match self.guard.react(self.now, &id, "restack") {
                Verdict::Go => {
                    if self.os.restack(window, margin) {
                        done += 1;
                    }
                }
                Verdict::Hold { .. } => {}
                Verdict::Stop { key, count, within, .. } => {
                    if !self.events.iter().any(|e| matches!(e, Event::Stopped { host, .. } if *host == id)) {
                        let why = format!("{key} {count} times within {within} s: left in front");
                        self.said.push(format!("{id}: {why}"));
                        self.events.push(Event::Stopped { host: id, why });
                    }
                }
            }
        }
        done
    }

    /// At its rect, under Margin's window, its taskbar button removed the first time; what it holds learned.
    fn place(&mut self, id: &str) -> bool {
        let margin = self.margin;
        let area = self.area;
        let Some(h) = self.get(id).cloned() else { return false };
        let Some(rect) = h.rect else { return false };
        let f = self.os.facts(h.window, h.pid, margin);
        let visible = wanted(&h, &rect, &area);
        let outer = borders(&f).outset(&visible);
        let ok = self.os.place(h.window, outer, margin, f.maximized || f.minimized);
        let removed = !h.taskbar_removed && ok && self.os.taskbar(h.window, false);
        // What it holds now: larger than asked is its minimum; not the size asked and with no sizing border, its own size
        // (a window without one that took the size asked, as a browser's own full screen, is sized as any).
        let after = self.os.facts(h.window, h.pid, margin);
        let missed =
            (after.bounds.width - visible.width).abs() > 1.0 || (after.bounds.height - visible.height).abs() > 1.0;
        let Some(h) = self.get_mut(id) else { return ok };
        h.placed = ok;
        h.taskbar_removed |= removed;
        if ok && after.exists && missed && h.route != WinRoute::Framed {
            if !after.resizable {
                h.fixed = Some(Size::new(after.bounds.width, after.bounds.height));
            } else if after.bounds.width > visible.width + 1.0 || after.bounds.height > visible.height + 1.0 {
                let min = h.min.unwrap_or_default();
                h.min = Some(Size::new(
                    min.width.max(if after.bounds.width > visible.width + 1.0 { after.bounds.width } else { 0.0 }),
                    min.height.max(if after.bounds.height > visible.height + 1.0 { after.bounds.height } else { 0.0 }),
                ));
            }
        }
        ok
    }

    /// Given back: put back as it was found (or closed, if Margin made it), its taskbar button back. Gone from the list.
    pub fn give_back(&mut self, id: &str) -> GaveBack {
        let Some(at) = self.hosts.iter().position(|h| h.id == id) else { return GaveBack::NotHosted };
        let h = self.hosts.remove(at);
        if h.taskbar_removed {
            self.os.taskbar(h.window, true);
        }
        if let Some((link, window_id)) = h.browser_window.clone() {
            return GaveBack::CloseByCopy { link, window_id };
        }
        if h.made_by_margin {
            self.os.close(h.window);
            return GaveBack::Closed;
        }
        match &h.kept {
            Some(kept) => {
                self.os.set_placement(h.window, kept);
            }
            None => {
                self.os.place(h.window, self.os.facts(h.window, h.pid, self.margin).outer, 0, true);
            }
        }
        GaveBack::Restored
    }

    /// Every host given back (Margin's quit), the browser windows a copy has to close listed.
    pub fn give_back_all(&mut self) -> Vec<(String, GaveBack)> {
        let ids: Vec<String> = self.hosts.iter().map(|h| h.id.clone()).collect();
        ids.into_iter()
            .map(|id| {
                let g = self.give_back(&id);
                (id, g)
            })
            .collect()
    }

    /// The crash marker's records for what's hosted now (marker.rs).
    pub fn records(&self) -> Vec<Record> {
        self.hosts
            .iter()
            .map(|h| Record {
                host: h.id.clone(),
                hwnd: h.window,
                pid: h.pid,
                started: self.os.started(h.pid).unwrap_or(0),
                kept: h.kept,
                taskbar_removed: h.taskbar_removed,
                hidden: h.rect.is_none() || self.minimized,
                browser_window: h.browser_window.clone(),
            })
            .collect()
    }
}

impl<O: WinOs> HostAdapter for Hosting<O> {
    fn hosts(&self) -> Vec<String> {
        let mut list: Vec<&WinHost> = self.hosts.iter().collect();
        list.sort_by_key(|h| h.rect.is_none());
        list.into_iter().map(|h| h.id.clone()).collect()
    }
    fn desired(&self, host: &str) -> Desired {
        self.get(host).map_or(Desired::Parked, |h| self.desired_of(h))
    }
    fn situation(&mut self, host: &str) -> Situation {
        let Some(h) = self.get(host) else { return Situation::default() };
        let f = self.os.facts(h.window, h.pid, self.margin);
        let mut s = situation(h, &f, &self.area);
        if self.minimized {
            s.phase = Phase::Parked;
        }
        s.gone_for = h.gone_since.map(|t| self.now - t);
        s
    }
    fn apply(&mut self, host: &str, c: &Correction) -> Applied {
        let Some(h) = self.get(host).cloned() else { return Applied::Failed("not hosted".into()) };
        let ok = match c {
            Correction::FrameWindow
            | Correction::PlaceAgain
            | Correction::PutBack
            | Correction::Unhide
            | Correction::BringForward { rung: Forward::Activate } => self.place(host),
            Correction::ParkAgain => self.os.hide(h.window),
            Correction::Adopt { window } => {
                if let Some(x) = self.get_mut(host) {
                    x.window = *window;
                    x.placed = false;
                    x.taskbar_removed = false;
                }
                if h.rect.is_some() { self.place(host) } else { self.os.hide(*window) }
            }
            Correction::CloseItem => {
                // (Its window is gone: nothing of it to give back.)
                self.hosts.retain(|x| x.id != host);
                self.events.push(Event::Closed { host: host.into() });
                true
            }
            Correction::Fallback { why } => {
                self.os.hide(h.window);
                if let Some(x) = self.get_mut(host) {
                    x.rect = None;
                }
                self.said.push(format!("{host}: fallback: {why}"));
                self.events.push(Event::Fallback { host: host.into(), why: why.clone() });
                true
            }
            other => return Applied::Failed(format!("{} isn't done on Windows", other.name())),
        };
        if ok { Applied::Done } else { Applied::Failed(format!("Windows refused {}", c.name())) }
    }
    fn route(&self, host: &str) -> Route {
        self.get(host).map_or(Route::Window, |h| h.route.core())
    }
    fn available(&self, host: &str) -> Vec<Route> {
        match self.get(host).map(|h| h.route) {
            Some(WinRoute::Framed) => vec![Route::Members, Route::Window],
            _ => vec![Route::Window],
        }
    }
    fn identity(&self, host: &str) -> (String, String) {
        self.get(host).map(|h| (h.app.clone(), h.version.clone())).unwrap_or_default()
    }
    fn moved(&mut self, host: &str, from: Route, to: Option<Route>, why: &str) {
        // Framed (a browser's own full screen) down to covered: its toolbar under Margin's window (the shell takes it
        // out of full screen through its copy and sets its insets).
        if let (Some(Route::Window), Some(h)) = (to, self.get_mut(host))
            && h.route == WinRoute::Framed
        {
            h.route = WinRoute::Covered;
            h.placed = false;
        }
        let line = format!(
            "{host}: {why}: on {}, now {}",
            from.name(),
            to.map_or("nothing safer".to_string(), |r| r.name().to_string())
        );
        self.said.push(line.clone());
        self.events.push(Event::Stopped { host: host.into(), why: line });
    }
}

/// The counts of what a simulated Windows was asked, for the tests (and a log line on a real one).
pub type Calls = BTreeMap<&'static str, u32>;

#[cfg(windows)]
pub mod win32;

#[cfg(test)]
mod tests;
