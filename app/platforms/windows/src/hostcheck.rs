//! `margin.exe --host-check <program | window>`: the hosted design's Windows mechanism on a real PC, before the session
//! drives it (docs/HOSTED-WINDOWS-CHROMIUM.md §11 step 5, docs/windows/UNVERIFIED.md "Hosting"). Margin's own window
//! (appwindow.rs, painted plainly: no web view) with a sidebar's room on the left and a title band on top; one other
//! window hosted in its page area through the adapter (hosting.rs) and margin-core's reconcile driver, on window events
//! only (nothing polled, no timer at rest); restacked under Margin's window after a click in the hole; parked while
//! Margin's window is minimized; given back when Margin's window closes; its crash marker kept (marker.rs) and given back
//! at the next start of either mode.
//!
//! `<window>`: a window handle (`0x1A2B3C` or decimal) of a window already open: adopted, given back as it was found.
//! `<program>`: started by Margin; its first window to come to the front whose process has the same executable name is
//! hosted (a packaged app's starter process may exit and its window belong to another process), and closed when given
//! back. One line per correction and per pass with its time in margin's `host-check.log`.
//!
//! The OS-neutral half (what's hosted, where the page area is) is tested on any OS; the run is Windows'.

use crate::screens::PxRect;

/// What `--host-check` hosts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Window(i64),
    Program(String),
}

/// The flag.
pub const FLAG: &str = "--host-check";

/// The target as given (a number: a window; anything else: a program).
pub fn target(arg: &str) -> Option<Target> {
    let a = arg.trim();
    if a.is_empty() {
        return None;
    }
    let number = match a.strip_prefix("0x").or_else(|| a.strip_prefix("0X")) {
        Some(hex) => i64::from_str_radix(hex, 16).ok(),
        None => a.parse::<i64>().ok(),
    };
    Some(match number {
        Some(n) if n > 0 => Target::Window(n),
        _ => Target::Program(a.into()),
    })
}

/// The page area in the check's window (client pixels): a sidebar's room on the left (280 pt), a title band (48 pt),
/// 10 pt of frame right and bottom: as a theme's would be.
pub fn page_area(width: i32, height: i32, scale: f64) -> PxRect {
    let s = |pt: f64| (pt * scale).round() as i32;
    PxRect::new(s(280.0).min(width), s(48.0).min(height), (width - s(10.0)).max(0), (height - s(10.0)).max(0))
}

/// The check window's title band, its controls at its right (three of 46 pt): the theme's `chrome` as the page would
/// send it.
pub fn chrome(width: i32, scale: f64) -> crate::hole::Chrome {
    let s = |pt: f64| (pt * scale).round() as i32;
    let controls = PxRect::new((width - s(138.0)).max(0), 0, width, s(36.0));
    crate::hole::Chrome { controls: Some(controls), drags: vec![PxRect::new(0, 0, controls.left, s(48.0))] }
}

#[cfg(windows)]
pub use win::run;

#[cfg(windows)]
mod win {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::time::Instant;

    use margin_core::geometry::Rect;
    use margin_core::host::driver::Driver;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{
        GA_ROOT, GW_OWNER, GWL_EXSTYLE, GetAncestor, GetWindow, GetWindowLongPtrW, GetWindowRect,
        GetWindowThreadProcessId, IsWindowVisible, PostQuitMessage, WS_EX_TOOLWINDOW,
    };

    use super::{Target, chrome, page_area};
    use crate::appwindow::{AppEvent, AppWindow, Shown};
    use crate::browsers::{WindowEventKind, WindowEvents};
    use crate::hosting::win32::Win32;
    use crate::hosting::{Event, Hosting, WinHost, WinOs, WinRoute};
    use crate::log;
    use crate::marker::{Marker, Recover};
    use crate::msgwin::{MessageWindow, message_id};
    use crate::paths::Paths;
    use crate::screens::PxRect;

    const LOOK: u32 = message_id(20);
    const DEADLINE: usize = 0x4843; // "HC"
    const HOST: &str = "app:check";
    /// A person's input this soon before a raise: theirs (a click in the hole), never a loop.
    const PERSON_MS: u32 = 500;

    struct Check {
        app: AppWindow,
        msg: Rc<MessageWindow>,
        hosting: RefCell<Hosting<Win32>>,
        driver: RefCell<Driver>,
        events: RefCell<Option<WindowEvents>>,
        started: Instant,
        root: std::path::PathBuf,
        /// Waiting for a started program's window: its executable's file name.
        waiting: RefCell<Option<String>>,
        looking: Cell<bool>,
        records: RefCell<Vec<crate::marker::Record>>,
    }

    fn rect(p: &PxRect) -> Rect {
        Rect::new(p.left as f64, p.top as f64, p.width() as f64, p.height() as f64)
    }

    fn person_just_acted() -> bool {
        let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: a LASTINPUTINFO with its size set; GetTickCount has no arguments.
        unsafe { GetLastInputInfo(&mut info).as_bool() && GetTickCount().wrapping_sub(info.dwTime) <= PERSON_MS }
    }

    /// A window that can be hosted: top-level, visible, not owned, not a tool window, at least 200 × 200.
    fn hostable(hwnd: isize) -> bool {
        let w = HWND(hwnd as *mut core::ffi::c_void);
        // SAFETY: plain reads of a window that may be gone (then false).
        unsafe {
            if GetAncestor(w, GA_ROOT) != w || !IsWindowVisible(w).as_bool() || GetWindow(w, GW_OWNER).is_ok() {
                return false;
            }
            if GetWindowLongPtrW(w, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                return false;
            }
            let mut r = windows::Win32::Foundation::RECT::default();
            GetWindowRect(w, &mut r).is_ok() && r.right - r.left >= 200 && r.bottom - r.top >= 200
        }
    }

    fn pid_of(hwnd: isize) -> u32 {
        let mut pid = 0;
        // SAFETY: a plain read.
        unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut core::ffi::c_void), Some(&mut pid)) };
        pid
    }

    /// The crash marker of an earlier run given back, before anything else.
    fn recover(root: &std::path::Path) {
        let Some(marker) = Marker::read(root) else { return };
        let mut os = Win32::new();
        for r in crate::marker::recover(&marker, |hwnd| {
            let pid = pid_of(hwnd as isize);
            (pid != 0).then(|| (pid, crate::process::started_at(pid).unwrap_or(0)))
        }) {
            match r {
                Recover::GiveBack(rec) => {
                    if rec.taskbar_removed {
                        os.taskbar(rec.hwnd, true);
                    }
                    let ok = match &rec.kept {
                        Some(kept) => os.set_placement(rec.hwnd, kept),
                        None => os.place(rec.hwnd, os.facts(rec.hwnd, rec.pid, 0).outer, 0, true),
                    };
                    log::note(format!("recovery: window {:#x} of {} given back: {ok}", rec.hwnd, rec.host));
                }
                Recover::CloseByCopy(rec) => {
                    // (No copy linked in a check: shown again where it is, for the person to close.)
                    os.place(rec.hwnd, os.facts(rec.hwnd, rec.pid, 0).outer, 0, true);
                    os.taskbar(rec.hwnd, true);
                    log::note(format!("recovery: browser window {:#x} of {} shown again", rec.hwnd, rec.host));
                }
                Recover::Drop(rec) => {
                    log::note(format!("recovery: window {:#x} of {}: gone, nothing touched", rec.hwnd, rec.host))
                }
            }
        }
        let _ = Marker::new(vec![]).write(root);
    }

    impl Check {
        fn now(&self) -> f64 {
            self.started.elapsed().as_secs_f64()
        }

        /// The page area from Margin's window as it is now: the hole cut, the host's rect set.
        fn layout(&self) {
            let (w, h) = self.app.client_size();
            let scale = self.app.scale();
            let page = page_area(w, h, scale);
            self.app.set_chrome(chrome(w, scale));
            self.app.set_holes(&[page], (10.0 * scale).round() as i32);
            let (ox, oy) = self.app.client_origin();
            let screen = PxRect::new(page.left + ox, page.top + oy, page.right + ox, page.bottom + oy);
            let mut hosting = self.hosting.borrow_mut();
            hosting.area = rect(&self.app.work_area());
            if hosting.hosts.iter().any(|x| x.id == HOST) {
                hosting.set_rect(HOST, Some(rect(&screen)));
            }
        }

        /// One look: what Windows says, every correction until settled, what to tell the person; timed.
        fn look(self: &Rc<Self>) {
            self.looking.set(false);
            let t0 = Instant::now();
            let now = self.now();
            let mut done = Vec::new();
            {
                let mut hosting = self.hosting.borrow_mut();
                let mut driver = self.driver.borrow_mut();
                hosting.at(now);
                hosting.observe();
                let restacked = hosting.keep_order(person_just_acted());
                if restacked > 0 {
                    done.push(format!("restacked {restacked}"));
                }
                for _ in 0..8 {
                    let Some((host, c, applied)) = driver.reconcile(now, &mut *hosting) else { break };
                    done.push(format!("{host}: {} → {applied:?}", c.text()));
                }
                for line in hosting.said.drain(..) {
                    log::note(format!("host: {line}"));
                }
            }
            let events: Vec<Event> = std::mem::take(&mut self.hosting.borrow_mut().events);
            for e in events {
                log::note(format!("host: event {e:?}"));
                match e {
                    Event::MinimizeMargin { .. } => self.app.minimize(),
                    Event::MaximizeMargin { .. } => self.app.maximize(),
                    Event::SteppedDown { host, why } => {
                        let mut d = self.driver.borrow_mut();
                        let (app, version) = self
                            .hosting
                            .borrow()
                            .hosts
                            .iter()
                            .find(|h| h.id == host)
                            .map(|h| (h.app.clone(), h.version.clone()))
                            .unwrap_or_default();
                        let routes =
                            [margin_core::host::routes::Route::Members, margin_core::host::routes::Route::Window];
                        d.routes.step_down(
                            &app,
                            &version,
                            margin_core::host::routes::Route::Members,
                            &routes,
                            &why,
                            now,
                        );
                        d.guard.cleared(&host);
                        d.reset_tries(&host);
                    }
                    Event::Closed { host } => {
                        self.driver.borrow_mut().forget(&host);
                        log::note("host check: the hosted window went: done");
                        // SAFETY: ends this thread's message loop.
                        unsafe { PostQuitMessage(0) };
                    }
                    _ => {}
                }
            }
            self.app.set_hosting(self.hosting.borrow().hosts.iter().any(|h| h.rect.is_some()));
            self.keep_marker();
            if !done.is_empty() {
                log::note(format!("host check: {} in {} µs", done.join("; "), t0.elapsed().as_micros()));
            }
        }

        /// The marker written only when what it would say changed (never per placement).
        fn keep_marker(&self) {
            let now = self.hosting.borrow().records();
            if *self.records.borrow() != now {
                if let Err(e) = Marker::new(now.clone()).write(&self.root) {
                    log::warn(format!("host check: the crash marker wasn't written: {e}"));
                }
                *self.records.borrow_mut() = now;
            }
        }

        /// Asks for a look soon (events coalesced: one look for a burst).
        fn soon(&self) {
            if !self.looking.replace(true) {
                (self.msg.waker(LOOK))();
            }
        }

        fn adopt(self: &Rc<Self>, hwnd: isize, made: bool) {
            let pid = pid_of(hwnd);
            let exe = crate::process::image_path(pid).unwrap_or_default();
            let mut host = WinHost::new(HOST, hwnd as i64, pid, exe.clone(), WinRoute::Window);
            host.made_by_margin = made;
            let hosted = self.hosting.borrow_mut().host(host);
            match hosted {
                Ok(()) => {
                    log::note(format!(
                        "host check: hosting window {hwnd:#x} of {}",
                        crate::paths::file_name_lower(&exe)
                    ));
                    if let Some(ev) = self.events.borrow_mut().as_mut() {
                        ev.watch(&[pid].into());
                    }
                    self.driver.borrow_mut().shown(HOST);
                    self.layout();
                    self.soon();
                }
                Err(e) => {
                    log::warn(format!("host check: window {hwnd:#x} not hosted: {e:?}"));
                    // SAFETY: ends this thread's message loop.
                    unsafe { PostQuitMessage(1) };
                }
            }
        }

        fn close(self: &Rc<Self>) {
            let back = self.hosting.borrow_mut().give_back_all();
            for (id, g) in back {
                log::note(format!("host check: {id} given back: {g:?}"));
            }
            self.keep_marker();
            // SAFETY: ends this thread's message loop.
            unsafe { PostQuitMessage(0) };
        }
    }

    /// The check, until Margin's window closes or the hosted window goes. Its exit code.
    pub fn run(target: Target) -> i32 {
        // SAFETY: process-wide, before any window (as app.rs).
        let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let Some(paths) = Paths::for_user() else { return 1 };
        let _ = paths.create_all();
        log::init(&paths.logs, "host-check");
        log::note(format!("host check of {target:?}"));
        // SAFETY: once, on this (the UI) thread: the taskbar list and the virtual desktop manager are COM objects.
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        recover(&paths.root);
        let msg = match MessageWindow::new() {
            Ok(m) => Rc::new(m),
            Err(e) => {
                log::warn(format!("host check: no message window: {e}"));
                return 1;
            }
        };
        let app = match AppWindow::create("Margin (host check)", false, 1400, 900) {
            Ok(a) => a,
            Err(e) => {
                log::warn(format!("host check: Margin's window wasn't made: {e}"));
                return 1;
            }
        };
        app.set_paint((32, 33, 40));
        let margin = app.hwnd().0 as isize as i64;
        let area = rect(&app.work_area());
        let check = Rc::new(Check {
            hosting: RefCell::new(Hosting::new(Win32::new(), margin, area)),
            driver: RefCell::new(Driver::new()),
            events: RefCell::new(None),
            started: Instant::now(),
            root: paths.root.clone(),
            waiting: RefCell::new(None),
            looking: Cell::new(false),
            records: RefCell::new(Vec::new()),
            msg: msg.clone(),
            app,
        });
        let weak = Rc::downgrade(&check);
        msg.on(LOOK, move |_, _| {
            if let Some(c) = weak.upgrade() {
                c.look();
            }
        });
        let weak = Rc::downgrade(&check);
        check.app.set_listener(move |e| {
            let Some(c) = weak.upgrade() else { return };
            match e {
                AppEvent::Resized { shown, .. } => {
                    c.hosting.borrow_mut().margin_minimized(shown == Shown::Minimized);
                    if shown != Shown::Minimized {
                        c.driver.borrow_mut().shown(HOST);
                        c.layout();
                    }
                    c.soon();
                }
                AppEvent::Moved | AppEvent::Scale { .. } => {
                    c.layout();
                    c.soon();
                }
                AppEvent::MoveLoop { on } => {
                    log::note(format!("host check: Margin's window {}", if on { "being moved" } else { "moved" }))
                }
                AppEvent::Activated { .. } => c.soon(),
                AppEvent::CloseAsked => c.close(),
            }
        });
        let weak = Rc::downgrade(&check);
        let started = WindowEvents::start(move |e| {
            let Some(c) = weak.upgrade() else { return };
            let waiting = c.waiting.borrow().clone();
            if let Some(name) = waiting
                && matches!(e.kind, WindowEventKind::Foreground | WindowEventKind::Shown)
                && hostable(e.hwnd)
                && crate::process::image_path(e.pid).is_some_and(|p| crate::paths::file_name_lower(&p) == name)
            {
                *c.waiting.borrow_mut() = None;
                c.msg.kill_timer(DEADLINE);
                c.adopt(e.hwnd, true);
                return;
            }
            c.soon();
        });
        match started {
            Ok(ev) => *check.events.borrow_mut() = Some(ev),
            Err(e) => log::warn(format!("host check: no window events ({e}): nothing would follow")),
        }
        check.app.show();
        match target {
            Target::Window(hwnd) => check.adopt(hwnd as isize, false),
            Target::Program(program) => {
                let name = crate::paths::file_name_lower(&program);
                *check.waiting.borrow_mut() = Some(name.clone());
                if let Err(e) = std::process::Command::new(&program).spawn() {
                    log::warn(format!("host check: {program} didn't start: {e}"));
                    return 1;
                }
                // (Its window waited for on the window events, with one deadline: a timer only while waiting.)
                let weak = Rc::downgrade(&check);
                check.msg.set_timer(DEADLINE, 10_000, move || {
                    let Some(c) = weak.upgrade() else { return };
                    c.msg.kill_timer(DEADLINE);
                    if c.waiting.borrow_mut().take().is_some() {
                        log::warn(format!("host check: no window of {name} within 10 s"));
                        // SAFETY: ends this thread's message loop.
                        unsafe { PostQuitMessage(1) };
                    }
                });
            }
        }
        let code = crate::app::message_loop();
        check.events.borrow_mut().take();
        log::note(format!("host check ends ({code})"));
        code
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_number_is_a_window_anything_else_a_program() {
        assert_eq!(target("0x1A2B"), Some(Target::Window(0x1A2B)));
        assert_eq!(target("6699"), Some(Target::Window(6699)));
        assert_eq!(
            target("C:\\Windows\\System32\\charmap.exe"),
            Some(Target::Program("C:\\Windows\\System32\\charmap.exe".into()))
        );
        assert_eq!(target("notepad"), Some(Target::Program("notepad".into())));
        assert_eq!(target("0"), Some(Target::Program("0".into())));
        assert_eq!(target("  "), None);
    }

    #[test]
    fn the_page_area_and_the_title_band_as_a_themes_would_be() {
        assert_eq!(page_area(1400, 900, 1.0), PxRect::new(280, 48, 1390, 890));
        assert_eq!(page_area(2800, 1800, 2.0), PxRect::new(560, 96, 2780, 1780));
        assert_eq!(page_area(100, 20, 1.0), PxRect::new(100, 20, 90, 10), "a tiny window: an empty page area");
        let c = chrome(1400, 1.0);
        assert_eq!(c.controls, Some(PxRect::new(1262, 0, 1400, 36)));
        assert_eq!(c.drags, vec![PxRect::new(0, 0, 1262, 48)]);
    }
}
