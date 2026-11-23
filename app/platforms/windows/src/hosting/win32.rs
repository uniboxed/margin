//! The adapter's Win32 calls (`WinOs`), one each, on the UI thread (COM single-threaded there: the taskbar list and
//! the virtual desktop manager are made once, on first use). Every coordinate is physical pixels: margin.exe is per-monitor
//! v2 DPI aware (app.rs), so Windows reads and sets other processes' windows in physical pixels too. Every call on
//! another process's window only asks it something; a stale handle answers false or fails, it never touches memory of
//! ours. Windows only; compile-checked, not run yet (docs/windows/UNVERIFIED.md "Hosting").

use std::cell::OnceCell;

use margin_core::geometry::Rect;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::UI::Shell::{ITaskbarList, IVirtualDesktopManager, TaskbarList, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::{
    GW_HWNDPREV, GWL_STYLE, GetWindow, GetWindowLongPtrW, GetWindowPlacement, GetWindowRect, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, IsZoomed, PostMessageW, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED,
    SW_SHOWNOACTIVATE, SW_SHOWNORMAL, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SetWindowPlacement,
    SetWindowPos, ShowWindow, WINDOWPLACEMENT, WM_CLOSE, WS_THICKFRAME,
};

use super::{Hwnd, WinOs, WindowFacts};
use crate::marker::{Kept, Show};

fn hwnd(n: Hwnd) -> HWND {
    HWND(n as isize as *mut core::ffi::c_void)
}

fn rect(r: &RECT) -> Rect {
    Rect::new(r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64)
}

/// How far up the z-order the walk from a hosted window looks for Margin's window (a desktop has hundreds of windows at
/// most; a cycle can't happen, but a bound keeps a bad list from holding the UI thread).
const ORDER_WALK: usize = 4096;

/// Windows' own calls.
#[derive(Default)]
pub struct Win32 {
    taskbar: OnceCell<Option<ITaskbarList>>,
    desktops: OnceCell<Option<IVirtualDesktopManager>>,
    /// Margin's own integrity level (its token's mandatory label).
    own: OnceCell<Option<u32>>,
}

impl Win32 {
    pub fn new() -> Self {
        Self::default()
    }

    fn taskbar_list(&self) -> Option<&ITaskbarList> {
        self.taskbar
            .get_or_init(|| {
                // SAFETY: COM is initialized on this (the UI) thread by app.rs before anything is hosted; the object
                // is released when Margin's Win32 goes.
                let list: Option<ITaskbarList> =
                    unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) }.ok();
                // SAFETY: HrInit once on the object just made, as ITaskbarList asks before any other call.
                list.filter(|l| unsafe { l.HrInit() }.is_ok())
            })
            .as_ref()
    }

    fn desktop_manager(&self) -> Option<&IVirtualDesktopManager> {
        self.desktops
            .get_or_init(|| {
                // SAFETY: as above.
                unsafe { CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_INPROC_SERVER) }.ok()
            })
            .as_ref()
    }

    /// Whether `w` is in front of `margin`: walking up the z-order from `w` (GW_HWNDPREV: the window above) reaches the
    /// top without passing Margin's window.
    fn above(w: HWND, margin: HWND) -> bool {
        let mut at = w;
        for _ in 0..ORDER_WALK {
            // SAFETY: a plain z-order read; an end of the list answers an error.
            match unsafe { GetWindow(at, GW_HWNDPREV) } {
                Ok(prev) if prev == margin => return false,
                Ok(prev) => at = prev,
                Err(_) => return true,
            }
        }
        false
    }
}

impl WinOs for Win32 {
    fn facts(&self, window: Hwnd, pid: u32, margin: Hwnd) -> WindowFacts {
        let w = hwnd(window);
        // SAFETY (the block): reads of another process's window by its handle (see the module's header).
        unsafe {
            if !IsWindow(Some(w)).as_bool() {
                return WindowFacts::default();
            }
            let mut owner = 0u32;
            GetWindowThreadProcessId(w, Some(&mut owner));
            if owner != pid {
                return WindowFacts::default(); // (the number names another process's window now: not ours)
            }
            let mut outer = RECT::default();
            let read = GetWindowRect(w, &mut outer).is_ok();
            let mut frame = RECT::default();
            let framed = DwmGetWindowAttribute(
                w,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut frame as *mut RECT as *mut core::ffi::c_void,
                size_of::<RECT>() as u32,
            )
            .is_ok();
            let style = GetWindowLongPtrW(w, GWL_STYLE) as u32;
            let on_current_desktop = self
                .desktop_manager()
                .and_then(|m| m.IsWindowOnCurrentVirtualDesktop(w).ok())
                .is_none_or(|b| b.as_bool());
            WindowFacts {
                exists: true,
                running: true,
                visible: IsWindowVisible(w).as_bool(),
                minimized: IsIconic(w).as_bool(),
                maximized: IsZoomed(w).as_bool(),
                bounds: if framed {
                    rect(&frame)
                } else if read {
                    rect(&outer)
                } else {
                    Rect::ZERO
                },
                outer: if read { rect(&outer) } else { Rect::ZERO },
                resizable: style & WS_THICKFRAME.0 != 0,
                above_margin: margin != 0 && Self::above(w, hwnd(margin)),
                on_current_desktop,
            }
        }
    }

    fn place(&mut self, window: Hwnd, outer: Rect, margin: Hwnd, restore: bool) -> bool {
        let w = hwnd(window);
        // SAFETY: asks of another process's window (see the module's header).
        unsafe {
            if restore || !IsWindowVisible(w).as_bool() {
                // (SW_SHOWNOACTIVATE also restores a minimized or maximized window: SetWindowPos alone keeps it so.)
                let _ = ShowWindow(w, SW_SHOWNOACTIVATE);
            }
            let after = if margin != 0 { Some(hwnd(margin)) } else { None };
            SetWindowPos(
                w,
                after,
                outer.x.round() as i32,
                outer.y.round() as i32,
                outer.width.round() as i32,
                outer.height.round() as i32,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            )
            .is_ok()
        }
    }

    fn hide(&mut self, window: Hwnd) -> bool {
        // SAFETY: as above. (ShowWindow answers whether it was visible before: hidden either way.)
        unsafe {
            let _ = ShowWindow(hwnd(window), SW_HIDE);
            !IsWindowVisible(hwnd(window)).as_bool()
        }
    }

    fn restack(&mut self, window: Hwnd, margin: Hwnd) -> bool {
        // SAFETY: as above: only its place in the z-order, under Margin's window; it keeps the keyboard.
        unsafe {
            SetWindowPos(
                hwnd(window),
                Some(hwnd(margin)),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            )
            .is_ok()
        }
    }

    fn taskbar(&mut self, window: Hwnd, shown: bool) -> bool {
        let Some(list) = self.taskbar_list() else { return false };
        // SAFETY: the taskbar's own list (Explorer's), told about a window by its handle.
        unsafe { if shown { list.AddTab(hwnd(window)) } else { list.DeleteTab(hwnd(window)) } }.is_ok()
    }

    fn placement(&self, window: Hwnd) -> Option<Kept> {
        let w = hwnd(window);
        let mut wp = WINDOWPLACEMENT { length: size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
        // SAFETY: `wp` is a WINDOWPLACEMENT with its length set, as the call asks.
        unsafe { GetWindowPlacement(w, &mut wp) }.ok()?;
        // SAFETY: a plain read.
        let visible = unsafe { IsWindowVisible(w) }.as_bool();
        let show = if !visible {
            Show::Hidden
        } else if wp.showCmd == SW_SHOWMAXIMIZED.0 as u32 {
            Show::Maximized
        } else if wp.showCmd == SW_SHOWMINIMIZED.0 as u32 {
            Show::Minimized
        } else {
            Show::Normal
        };
        Some(Kept { normal: rect(&wp.rcNormalPosition), show })
    }

    fn set_placement(&mut self, window: Hwnd, kept: &Kept) -> bool {
        let n = kept.normal;
        let show = match kept.show {
            Show::Normal => SW_SHOWNORMAL,
            Show::Maximized => SW_SHOWMAXIMIZED,
            Show::Minimized => SW_SHOWMINIMIZED,
            Show::Hidden => SW_HIDE,
        };
        let wp = WINDOWPLACEMENT {
            length: size_of::<WINDOWPLACEMENT>() as u32,
            showCmd: show.0 as u32,
            rcNormalPosition: RECT {
                left: n.x.round() as i32,
                top: n.y.round() as i32,
                right: n.max_x().round() as i32,
                bottom: n.max_y().round() as i32,
            },
            ..Default::default()
        };
        // SAFETY: a WINDOWPLACEMENT with its length set; asks of another process's window.
        unsafe { SetWindowPlacement(hwnd(window), &wp) }.is_ok()
    }

    fn close(&mut self, window: Hwnd) -> bool {
        // SAFETY: a message posted to another process's window (its app decides: it may ask to save).
        unsafe { PostMessageW(Some(hwnd(window)), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok()
    }

    fn higher_integrity(&self, pid: u32) -> Option<bool> {
        let own = (*self.own.get_or_init(crate::process::own_integrity))?;
        Some(crate::process::integrity(pid)? > own)
    }

    fn started(&self, pid: u32) -> Option<u64> {
        crate::process::started_at(pid)
    }
}
