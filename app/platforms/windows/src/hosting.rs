//! Hosting on Windows: margin-core's reconcile driver (host/driver.rs `HostAdapter`) with Windows's own way of doing each
//! thing, so the decisions are the Mac's, the same code. Windows has no Spaces and no full screen of the macOS kind: a
//! hosted window is a plain window Margin keeps at the page area (the route margin-core calls window mode); parked, it's
//! hidden (`ShowWindow` SW_HIDE: no taskbar button, as no Dock icon on the Mac; DWM's cloak is refused for another
//! process's windows). Compile-checked and unit-checked only: no real Windows run yet (docs/windows/UNVERIFIED.md).
//!
//! The OS-neutral half (what a window's facts mean as a situation) is tested on any OS; the Win32 half is `cfg(windows)`.

use margin_core::geometry::Rect;
use margin_core::host::kinds::WindowPlace;
use margin_core::host::reconciler::{Mode, Phase, Situation};

/// What Windows says of one hosted window, read in one go.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WindowFacts {
    /// The handle still names a window (IsWindow).
    pub exists: bool,
    /// Shown (IsWindowVisible), not minimized (IsIconic).
    pub visible: bool,
    pub minimized: bool,
    /// Its frame (DWMWA_EXTENDED_FRAME_BOUNDS, else GetWindowRect), in the page area's coordinates.
    pub bounds: Rect,
    /// Its process still runs.
    pub running: bool,
}

/// One hosted window as Margin keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct WinHost {
    /// margin-core's host name ("app:<exe>", as the Mac's "app:<bundle id>").
    pub id: String,
    pub window: isize,
    pub pid: u32,
    pub shown: bool,
    /// Its app's path (the routes remember a step down by it) and version.
    pub app: String,
    pub version: String,
}

/// Its facts as margin-core's situation: shown at the page area, or parked (hidden), in window mode, no Spaces.
pub fn situation(h: &WinHost, f: &WindowFacts, page: &Rect) -> Situation {
    let near = |a: &Rect, b: &Rect| {
        (a.x - b.x).abs() <= 1.0
            && (a.y - b.y).abs() <= 1.0
            && (a.width - b.width).abs() <= 1.0
            && (a.height - b.height).abs() <= 1.0
    };
    let place = if !f.exists {
        WindowPlace::Nowhere
    } else if f.visible && !f.minimized {
        WindowPlace::Margin // (on screen where Margin shows it: Windows's one "Space")
    } else {
        WindowPlace::Parked
    };
    Situation {
        running: f.running,
        launched_by_margin: true,
        phase: if h.shown { Phase::Shown } else { Phase::Parked },
        mode: Mode::Window,
        window: Some(h.window as i64),
        window_gone: !f.exists,
        place: if h.shown || place != WindowPlace::Margin { place } else { WindowPlace::Desktop },
        on_screen: Some(f.visible && !f.minimized),
        // (Minimized while shown: off screen, brought forward like the Mac's ordered-out window.)
        off_screen_reads: if h.shown && f.exists && (f.minimized || !f.visible) { 2 } else { 0 },
        at_page: Some(near(&f.bounds, page)),
        can_full_screen: Some(false),
        ..Situation::default()
    }
}

#[cfg(windows)]
pub use win::WinAdapter;

#[cfg(windows)]
mod win {
    use super::{WinHost, WindowFacts, situation};
    use margin_core::geometry::Rect;
    use margin_core::host::driver::{Applied, HostAdapter};
    use margin_core::host::reconciler::{Correction, Desired, Forward, Situation};
    use margin_core::host::routes::Route;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, GetWindowThreadProcessId, HWND_TOP, IsIconic, IsWindow, IsWindowVisible, SW_HIDE,
        SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SetWindowPos, ShowWindow,
    };

    /// The hosted windows of one Margin window and its page area, in the order the driver goes through them.
    #[derive(Debug, Default)]
    pub struct WinAdapter {
        pub hosts: Vec<WinHost>,
        pub page: Rect,
        /// Items whose window went (the shell closes them: margin-core's `closeItem`).
        pub closed: Vec<String>,
        pub said: Vec<String>,
    }

    fn hwnd(n: isize) -> HWND {
        HWND(n as *mut core::ffi::c_void)
    }

    impl WinAdapter {
        fn facts(h: &WinHost) -> WindowFacts {
            let w = hwnd(h.window);
            // SAFETY: plain reads of a window handle; a stale one answers false or fails, never touches memory of ours.
            unsafe {
                let exists = IsWindow(Some(w)).as_bool();
                let mut r = RECT::default();
                let read = exists && GetWindowRect(w, &mut r).is_ok();
                let mut pid = 0u32;
                if exists {
                    GetWindowThreadProcessId(w, Some(&mut pid));
                }
                WindowFacts {
                    exists,
                    visible: exists && IsWindowVisible(w).as_bool(),
                    minimized: exists && IsIconic(w).as_bool(),
                    bounds: if read {
                        Rect::new(r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64)
                    } else {
                        Rect::ZERO
                    },
                    running: exists && pid == h.pid,
                }
            }
        }

        // At the page area, shown, not activated (the person's own click activates it).
        fn place(&self, h: &WinHost) -> bool {
            let w = hwnd(h.window);
            let p = self.page;
            // SAFETY: SetWindowPos and ShowWindow on another process's window: asks it, can't harm ours.
            unsafe {
                let _ = ShowWindow(w, SW_SHOWNOACTIVATE);
                SetWindowPos(
                    w,
                    Some(HWND_TOP),
                    p.x as i32,
                    p.y as i32,
                    p.width as i32,
                    p.height as i32,
                    SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                )
                .is_ok()
            }
        }

        fn park(h: &WinHost) -> bool {
            // SAFETY: as above.
            unsafe { ShowWindow(hwnd(h.window), SW_HIDE).as_bool() }
        }
    }

    impl HostAdapter for WinAdapter {
        fn hosts(&self) -> Vec<String> {
            let mut list: Vec<&WinHost> = self.hosts.iter().collect();
            list.sort_by_key(|h| !h.shown);
            list.into_iter().map(|h| h.id.clone()).collect()
        }
        fn desired(&self, host: &str) -> Desired {
            if self.hosts.iter().any(|h| h.id == host && h.shown) { Desired::Shown } else { Desired::Parked }
        }
        fn situation(&mut self, host: &str) -> Situation {
            let Some(h) = self.hosts.iter().find(|h| h.id == host) else { return Situation::default() };
            situation(h, &Self::facts(h), &self.page)
        }
        fn apply(&mut self, host: &str, c: &Correction) -> Applied {
            let Some(h) = self.hosts.iter().find(|h| h.id == host).cloned() else {
                return Applied::Failed("not hosted".into());
            };
            let ok = match c {
                Correction::FrameWindow | Correction::PlaceAgain | Correction::PutBack | Correction::Unhide => {
                    self.place(&h)
                }
                Correction::BringForward { rung: Forward::Activate } => self.place(&h),
                Correction::ParkAgain => Self::park(&h),
                Correction::Adopt { window } => {
                    if let Some(x) = self.hosts.iter_mut().find(|x| x.id == host) {
                        x.window = *window as isize;
                    }
                    let h = self.hosts.iter().find(|x| x.id == host).cloned();
                    h.is_some_and(|h| if h.shown { self.place(&h) } else { Self::park(&h) })
                }
                Correction::CloseItem => {
                    self.closed.push(host.to_string());
                    true
                }
                other => return Applied::Failed(format!("{} isn't done on Windows yet", other.name())),
            };
            if ok { Applied::Done } else { Applied::Failed(format!("Windows refused {}", c.name())) }
        }
        fn route(&self, _: &str) -> Route {
            Route::Window
        }
        fn available(&self, _: &str) -> Vec<Route> {
            vec![Route::Window]
        }
        fn identity(&self, host: &str) -> (String, String) {
            self.hosts.iter().find(|h| h.id == host).map(|h| (h.app.clone(), h.version.clone())).unwrap_or_default()
        }
        fn moved(&mut self, host: &str, from: Route, to: Option<Route>, why: &str) {
            self.said.push(format!(
                "{host}: {why}: on {}, {}",
                from.name(),
                to.map_or("nothing safer".to_string(), |r| r.name().to_string())
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use margin_core::host::reconciler::{Correction, Desired, step};

    fn host(shown: bool) -> WinHost {
        WinHost {
            id: "app:notepad.exe".into(),
            window: 0x1234,
            pid: 42,
            shown,
            app: "C:\\Windows\\notepad.exe".into(),
            version: "11".into(),
        }
    }
    const PAGE: Rect = Rect::new(260.0, 41.0, 1244.0, 933.0);
    fn facts(visible: bool, minimized: bool, bounds: Rect) -> WindowFacts {
        WindowFacts { exists: true, visible, minimized, bounds, running: true }
    }

    #[test]
    fn a_shown_window_at_the_page_is_settled() {
        let s = situation(&host(true), &facts(true, false, PAGE), &PAGE);
        assert_eq!(step(&s, Desired::Shown), vec![]);
    }

    #[test]
    fn moved_off_the_page_it_is_framed_again() {
        let s = situation(&host(true), &facts(true, false, Rect::new(100.0, 100.0, 800.0, 600.0)), &PAGE);
        assert_eq!(step(&s, Desired::Shown), vec![Correction::FrameWindow]);
    }

    #[test]
    fn minimized_while_shown_it_is_put_back() {
        // (Out of its place: put back, which shows it where it belongs without activating it (SW_SHOWNOACTIVATE restores a
        // minimized window).)
        let s = situation(&host(true), &facts(false, true, PAGE), &PAGE);
        assert_eq!(step(&s, Desired::Shown), vec![Correction::PutBack]);
    }

    #[test]
    fn a_parked_window_seen_again_is_parked_again() {
        let mut s = situation(&host(false), &facts(true, false, PAGE), &PAGE);
        assert_eq!(s.place, WindowPlace::Desktop, "parked but on screen: in a user Space, as the Mac would say");
        s.stray_reads = 2;
        assert_eq!(step(&s, Desired::Parked), vec![Correction::ParkAgain]);
        let hidden = situation(&host(false), &facts(false, false, PAGE), &PAGE);
        assert_eq!(step(&hidden, Desired::Parked), vec![], "hidden: parked as it should be");
    }

    #[test]
    fn its_window_gone_its_item_closes_after_the_grace() {
        let mut s = situation(&host(true), &WindowFacts::default(), &PAGE);
        assert!(s.window_gone);
        s.gone_for = Some(1.5);
        s.running = true;
        assert_eq!(step(&s, Desired::Shown), vec![Correction::CloseItem]);
    }
}
