//! Finding and following Chrome's and Edge's windows (app/shell/WindowServer.swift's counterpart). Windows only.
//!
//! The windows: `EnumWindows` gives every top-level window front to back (the z-order), so a window's place
//! in it is its `order`. A browser window is a top-level window of `chrome.exe` or `msedge.exe` with Chrome's
//! frame class `Chrome_WidgetWin_1`, no owner (menus, bubbles and the omnibox popup are owned), not a tool
//! window, and visible (`IsWindowVisible`: minimized ones count, shown as not on screen). A cloaked window
//! (`DWMWA_CLOAKED`: on another virtual desktop, or hidden by the shell) is kept, not on screen, as the Mac
//! keeps another Space's windows.
//!
//! Bounds: `DWMWA_EXTENDED_FRAME_BOUNDS`, the window's visible frame in physical pixels (GetWindowRect would
//! add the invisible resize borders, and a maximized window's 8 px beyond the screen), then DIPs with the
//! monitors' layout (screens.rs). Chrome's `windows.get` reports the window's GetWindowRect in DIPs, which may
//! be larger by those borders: `BrowserWindow::outer` carries that too, for the binder (native/UNVERIFIED.md).
//!
//! The events: `SetWinEventHook`, out of context (no DLL in the browsers; the callbacks come on this thread
//! through its message loop), skipping Margin's own process. Foreground changes are heard for every process
//! (the shell needs to know when another app comes in front); moves, minimizing, the move/size loop,
//! creation, destruction, showing, hiding and cloaking only for the browsers' processes (`watch`), and only
//! for windows themselves (OBJID_WINDOW, CHILDID_SELF): a hook on every process's location changes would hear
//! every caret and cursor move. Each event only tells the shell to read the windows again (its 30 Hz bursts).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use margin_core::geometry::Rect;
use margin_core::system::{ServerWindow, WindowSource};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    CHILDID_SELF, EVENT_OBJECT_CLOAKED, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE,
    EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_SHOW, EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_FOREGROUND,
    EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART,
    EnumWindows, GA_ROOT, GW_HWNDPREV, GW_OWNER, GWL_EXSTYLE, GetAncestor, GetClassNameW, GetForegroundWindow,
    GetLayeredWindowAttributes, GetShellWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};
use windows::core::BOOL;

use crate::screens::{PxRect, ScreenMap};

/// Chrome's (and Edge's) top-level frame class.
pub const FRAME_CLASS: &str = "Chrome_WidgetWin_1";

/// The browser a process is, by its executable's name: `chrome` or `edge`; `None` for any other.
pub fn browser_for_exe(file_name_lower: &str) -> Option<&'static str> {
    match file_name_lower {
        "chrome.exe" => Some("chrome"),
        "msedge.exe" => Some("edge"),
        _ => None,
    }
}

/// One of a browser's windows.
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserWindow {
    pub hwnd: isize,
    pub pid: u32,
    /// `chrome` or `edge`.
    pub browser: &'static str,
    /// The visible frame, in DIPs.
    pub bounds: Rect,
    /// GetWindowRect in DIPs: what `windows.get` reports, invisible borders included.
    pub outer: Rect,
    /// The visible frame, in physical pixels (where an overlay goes).
    pub px: PxRect,
    pub minimized: bool,
    pub cloaked: bool,
    /// Visible, not minimized, not cloaked.
    pub on_screen: bool,
    /// Its place among all top-level windows, front to back.
    pub order: usize,
}

/// What a window is, read once per enumeration.
struct Facts {
    hwnd: HWND,
    pid: u32,
    visible: bool,
    minimized: bool,
    cloaked: bool,
    ex_style: u32,
    owned: bool,
}

fn hwnd_value(h: HWND) -> isize {
    h.0 as isize
}

fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 64];
    // SAFETY: `buf` is a live buffer of the length passed.
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn facts(h: HWND) -> Facts {
    let mut pid = 0u32;
    let mut cloaked = 0u32;
    // SAFETY: plain reads of a window that may have gone since the enumeration: every call then fails or
    // returns 0/false, which is taken as "not visible".
    unsafe {
        GetWindowThreadProcessId(h, Some(&mut pid));
        let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, size_of::<u32>() as u32);
        Facts {
            hwnd: h,
            pid,
            visible: IsWindowVisible(h).as_bool(),
            minimized: IsIconic(h).as_bool(),
            cloaked: cloaked != 0,
            ex_style: GetWindowLongPtrW(h, GWL_EXSTYLE) as u32,
            owned: GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid()),
        }
    }
}

fn frame_px(h: HWND) -> Option<PxRect> {
    let mut r = RECT::default();
    // SAFETY: `r` is a RECT, the size passed.
    let dwm = unsafe {
        DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, size_of::<RECT>() as u32)
    };
    // SAFETY: as above; GetWindowRect when DWM has no frame for it.
    if dwm.is_err() && unsafe { GetWindowRect(h, &mut r) }.is_err() {
        return None;
    }
    Some(PxRect::new(r.left, r.top, r.right, r.bottom))
}

fn outer_px(h: HWND) -> Option<PxRect> {
    let mut r = RECT::default();
    // SAFETY: `r` is an out-parameter.
    unsafe { GetWindowRect(h, &mut r) }.ok()?;
    Some(PxRect::new(r.left, r.top, r.right, r.bottom))
}

fn alpha(h: HWND, ex_style: u32) -> f64 {
    if ex_style & WS_EX_LAYERED.0 == 0 {
        return 1.0;
    }
    let mut a = 255u8;
    let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
    let mut key = COLORREF(0);
    // SAFETY: out-parameters; a layered window updated with UpdateLayeredWindow makes it fail (then 1.0).
    if unsafe { GetLayeredWindowAttributes(h, Some(&mut key), Some(&mut a), Some(&mut flags)) }.is_ok()
        && flags.0 & LWA_ALPHA.0 != 0
    {
        a as f64 / 255.0
    } else {
        1.0
    }
}

unsafe extern "system" fn collect(h: HWND, data: LPARAM) -> BOOL {
    // SAFETY: `data` is the `&mut Vec<HWND>` `top_level` passed, alive for the whole EnumWindows call.
    let out = unsafe { &mut *(data.0 as *mut Vec<HWND>) };
    out.push(h);
    BOOL(1)
}

/// Every top-level window, front to back.
fn top_level() -> Vec<HWND> {
    let mut out: Vec<HWND> = Vec::with_capacity(256);
    // SAFETY: the callback runs only during this call, with a pointer to `out`, which outlives it.
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut out as *mut Vec<HWND> as isize)) };
    out
}

/// The OS's windows, for the shell and the binder.
#[derive(Default)]
pub struct WinWindowSource {
    /// Each process's executable name (lowercase), read once per process. Pruned at each read.
    names: RefCell<HashMap<u32, String>>,
}

impl WinWindowSource {
    pub fn new() -> Self {
        Self::default()
    }

    fn exe_name(&self, pid: u32) -> String {
        if let Some(n) = self.names.borrow().get(&pid) {
            return n.clone();
        }
        let name = crate::process::image_path(pid).map(|p| crate::paths::file_name_lower(&p)).unwrap_or_default();
        self.names.borrow_mut().insert(pid, name.clone());
        name
    }

    fn prune(&self, seen: &HashSet<u32>) {
        self.names.borrow_mut().retain(|pid, _| seen.contains(pid));
    }

    fn is_frame(&self, f: &Facts) -> Option<&'static str> {
        let browser = browser_for_exe(&self.exe_name(f.pid))?;
        let frame = f.visible && !f.owned && f.ex_style & WS_EX_TOOLWINDOW.0 == 0 && class_name(f.hwnd) == FRAME_CLASS;
        frame.then_some(browser)
    }

    /// Every Chrome and Edge window, front to back.
    pub fn browser_windows(&self) -> Vec<BrowserWindow> {
        let screens = ScreenMap::read();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (order, h) in top_level().into_iter().enumerate() {
            let f = facts(h);
            seen.insert(f.pid);
            let Some(browser) = self.is_frame(&f) else { continue };
            let Some(px) = frame_px(h) else { continue };
            let outer = outer_px(h).unwrap_or(px);
            out.push(BrowserWindow {
                hwnd: hwnd_value(h),
                pid: f.pid,
                browser,
                bounds: screens.to_dip(&px),
                outer: screens.to_dip(&outer),
                px,
                minimized: f.minimized,
                cloaked: f.cloaked,
                on_screen: f.visible && !f.minimized && !f.cloaked,
                order,
            });
        }
        self.prune(&seen);
        out
    }

    /// The processes that have a browser window now.
    pub fn browser_pids(&self) -> HashSet<u32> {
        self.browser_windows().into_iter().map(|w| w.pid).collect()
    }

    /// The window in front (it has the keyboard) and its process.
    pub fn foreground() -> Option<(isize, u32)> {
        // SAFETY: no arguments; a null window when none is in front.
        let h = unsafe { GetForegroundWindow() };
        if h.is_invalid() {
            return None;
        }
        let mut pid = 0;
        // SAFETY: an out-parameter for a window that exists or just went (pid 0 then).
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        Some((hwnd_value(h), pid))
    }

    fn server_window(screens: &ScreenMap, f: &Facts, order: usize) -> Option<ServerWindow> {
        let px = frame_px(f.hwnd)?;
        let mut w = ServerWindow::new(hwnd_value(f.hwnd) as i64, f.pid, screens.to_dip(&px));
        w.layer = i32::from(f.ex_style & WS_EX_TOPMOST.0 != 0);
        w.on_screen = f.visible && !f.minimized && !f.cloaked;
        w.alpha = alpha(f.hwnd, f.ex_style);
        w.order = order;
        Some(w)
    }

    /// Whether a window of another process could be over a browser window: on screen, not the desktop, not empty.
    fn counts_on_screen(f: &Facts, desktop: HWND) -> bool {
        if !f.visible || f.minimized || f.cloaked || f.hwnd == desktop {
            return false;
        }
        let class = class_name(f.hwnd);
        class != "Progman" && class != "WorkerW"
    }
}

impl WindowSource for WinWindowSource {
    /// The windows of `pids` (a browser's: its frames only; any other's, Margin's own included: its visible
    /// windows), plus every on-screen window of other processes, front to back. Never `None` on Windows:
    /// EnumWindows always gives a list.
    fn read(&self, pids: &HashSet<u32>) -> Option<Vec<ServerWindow>> {
        let screens = ScreenMap::read();
        // SAFETY: no arguments.
        let desktop = unsafe { GetShellWindow() };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (order, h) in top_level().into_iter().enumerate() {
            let f = facts(h);
            seen.insert(f.pid);
            let take = if pids.contains(&f.pid) {
                if browser_for_exe(&self.exe_name(f.pid)).is_some() { self.is_frame(&f).is_some() } else { f.visible }
            } else {
                Self::counts_on_screen(&f, desktop)
            };
            if take && let Some(w) = Self::server_window(&screens, &f, order) {
                out.push(w);
            }
        }
        self.prune(&seen);
        Some(out)
    }

    /// The on-screen windows in front of `window`, front to back (walking the z-order up from it).
    fn above(&self, window: i64) -> Option<Vec<ServerWindow>> {
        let screens = ScreenMap::read();
        // SAFETY: no arguments.
        let desktop = unsafe { GetShellWindow() };
        let mut h = HWND(window as isize as *mut _);
        let mut up = Vec::new();
        for _ in 0..4096 {
            // SAFETY: GetWindow on a window that may have gone fails: the walk ends there.
            match unsafe { GetWindow(h, GW_HWNDPREV) } {
                Ok(prev) if !prev.is_invalid() => {
                    up.push(prev);
                    h = prev;
                }
                _ => break,
            }
        }
        // `up` runs nearest first; front to back is the other way.
        let out = up
            .into_iter()
            .rev()
            .enumerate()
            .filter_map(|(i, h)| {
                let f = facts(h);
                if !Self::counts_on_screen(&f, desktop) {
                    return None;
                }
                Self::server_window(&screens, &f, i)
            })
            .collect::<Vec<_>>();
        Some(out)
    }
}

// The events.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowEventKind {
    Foreground,
    Moved,
    Created,
    Destroyed,
    Shown,
    Hidden,
    MinimizeStart,
    MinimizeEnd,
    MoveSizeStart,
    MoveSizeEnd,
    Cloaked,
    Uncloaked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowEvent {
    pub kind: WindowEventKind,
    pub hwnd: isize,
    pub pid: u32,
}

fn kind_of(event: u32) -> Option<WindowEventKind> {
    use WindowEventKind::*;
    Some(match event {
        EVENT_SYSTEM_FOREGROUND => Foreground,
        EVENT_OBJECT_LOCATIONCHANGE => Moved,
        EVENT_OBJECT_CREATE => Created,
        EVENT_OBJECT_DESTROY => Destroyed,
        EVENT_OBJECT_SHOW => Shown,
        EVENT_OBJECT_HIDE => Hidden,
        EVENT_SYSTEM_MINIMIZESTART => MinimizeStart,
        EVENT_SYSTEM_MINIMIZEEND => MinimizeEnd,
        EVENT_SYSTEM_MOVESIZESTART => MoveSizeStart,
        EVENT_SYSTEM_MOVESIZEEND => MoveSizeEnd,
        EVENT_OBJECT_CLOAKED => Cloaked,
        EVENT_OBJECT_UNCLOAKED => Uncloaked,
        _ => return None,
    })
}

struct Hooks {
    sink: Box<dyn FnMut(WindowEvent)>,
    pids: HashSet<u32>,
}

thread_local! {
    // The one WindowEvents' state on the UI thread (the hooks' callbacks come on the thread that set them).
    static HOOKS: RefCell<Option<Hooks>> = const { RefCell::new(None) };
}

unsafe extern "system" fn on_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    let Some(kind) = kind_of(event) else { return };
    if hwnd.is_invalid() || id_object != OBJID_WINDOW.0 || id_child != CHILDID_SELF as i32 {
        return;
    }
    // SAFETY: plain reads of a window that may be gone (then 0s, and the event is dropped below).
    let (top, pid) = unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (GetAncestor(hwnd, GA_ROOT), pid)
    };
    // Child windows' events (Chrome's render widgets move with their frame) say nothing new.
    if kind != WindowEventKind::Destroyed && top != hwnd {
        return;
    }
    HOOKS.with(|h| {
        // Busy: the sink itself is running (it pumped messages). The event is dropped; the next one, or the
        // shell's own polling, catches up.
        let Ok(mut h) = h.try_borrow_mut() else { return };
        let Some(h) = h.as_mut() else { return };
        if kind != WindowEventKind::Foreground && !h.pids.contains(&pid) && pid != 0 {
            return;
        }
        (h.sink)(WindowEvent { kind, hwnd: hwnd_value(hwnd), pid });
    });
}

/// The hooks; dropping it unhooks them. One at a time per thread (a second `start` replaces the first's sink).
pub struct WindowEvents {
    global: Vec<HWINEVENTHOOK>,
    per_pid: HashMap<u32, Vec<HWINEVENTHOOK>>,
}

fn hook(min: u32, max: u32, pid: u32) -> Option<HWINEVENTHOOK> {
    // SAFETY: out-of-context: no module; `on_event` is a plain function that lives as long as the process.
    let h = unsafe {
        SetWinEventHook(min, max, None, Some(on_event), pid, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
    };
    (!h.is_invalid()).then_some(h)
}

fn unhook(h: HWINEVENTHOOK) {
    // SAFETY: a hook this module set and hasn't unhooked.
    let _ = unsafe { UnhookWinEvent(h) };
}

impl WindowEvents {
    /// Hooks foreground changes and the move/size and minimize events of every process (the latter filtered
    /// to the watched pids). Call on the UI thread; `sink` runs there.
    pub fn start(sink: impl FnMut(WindowEvent) + 'static) -> Result<Self, String> {
        HOOKS.with(|h| *h.borrow_mut() = Some(Hooks { sink: Box::new(sink), pids: HashSet::new() }));
        let global: Vec<HWINEVENTHOOK> = [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
        ]
        .into_iter()
        .filter_map(|(a, b)| hook(a, b, 0))
        .collect();
        if global.is_empty() {
            HOOKS.with(|h| *h.borrow_mut() = None);
            return Err("no window event hook could be set".into());
        }
        Ok(Self { global, per_pid: HashMap::new() })
    }

    /// The browsers' processes to hear object events of (created, gone, shown, hidden, moved, cloaked):
    /// hooks for new pids, none kept for pids no longer given.
    pub fn watch(&mut self, pids: &HashSet<u32>) {
        self.per_pid.retain(|pid, hooks| {
            let keep = pids.contains(pid);
            if !keep {
                hooks.drain(..).for_each(unhook);
            }
            keep
        });
        for &pid in pids {
            if pid == 0 || self.per_pid.contains_key(&pid) {
                continue;
            }
            let hooks: Vec<HWINEVENTHOOK> =
                [(EVENT_OBJECT_CREATE, EVENT_OBJECT_LOCATIONCHANGE), (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED)]
                    .into_iter()
                    .filter_map(|(a, b)| hook(a, b, pid))
                    .collect();
            self.per_pid.insert(pid, hooks);
        }
        HOOKS.with(|h| {
            if let Ok(mut h) = h.try_borrow_mut()
                && let Some(h) = h.as_mut()
            {
                h.pids = pids.clone();
            }
        });
    }
}

impl Drop for WindowEvents {
    fn drop(&mut self) {
        self.global.drain(..).for_each(unhook);
        for (_, hooks) in self.per_pid.drain() {
            hooks.into_iter().for_each(unhook);
        }
        HOOKS.with(|h| {
            if let Ok(mut h) = h.try_borrow_mut() {
                *h = None;
            }
        });
    }
}
