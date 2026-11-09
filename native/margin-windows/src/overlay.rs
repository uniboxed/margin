//! One overlay window over one browser window (app/shell/Overlay.swift's counterpart). Windows only.
//!
//! A top-level `WS_POPUP` with `WS_EX_TOOLWINDOW` (not in Alt+Tab or the taskbar), `WS_EX_NOACTIVATE` (a click
//! doesn't take the keyboard from the browser), `WS_EX_NOREDIRECTIONBITMAP` (its content is the web view's
//! DirectComposition visual: webview.rs) and `WS_EX_LAYERED` (with alpha 255: so `WS_EX_TRANSPARENT`, turned
//! on and off by the shell from the pointer's place, really lets clicks through to the window below).
//!
//! Not owned by the browser window, though ownership would keep it above that window for free: an owner in
//! another process attaches the two threads' input queues (as AttachThreadInput does), so a browser that
//! hangs could hang Margin's UI thread, and the other way round. Instead it's placed just above its browser
//! window (`SetWindowPos` after the window directly above the browser's, never activating), and the shell
//! places it again whenever the browser's window moves in the z-order (the foreground events, browsers.rs).
//!
//! The keyboard: a click never takes it. Only while Margin's UI needs typing (a field of the page has the
//! focus: the palette, an input) does the overlay become the foreground window (`take_keyboard`), and it
//! gives it back to its browser window as soon as that's over (`hand_back`). Unlike the Mac's key panel
//! (whose app never becomes active), the browser's window shows as inactive meanwhile: Windows has no
//! non-activating key window.
//!
//! Mouse input arrives here (the web view under visual hosting has no window of its own) and is handed,
//! in client pixels, to a `MouseSink` (the web view: webview.rs `connect`), with the capture held while a
//! button is down; the cursor shown is the one the sink last asked for.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{ScreenToClient, ValidateRect};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_DBLCLKS, CreateWindowExW, DefWindowProcW, DestroyWindow, GW_HWNDPREV, GWL_EXSTYLE, GWLP_USERDATA, GetClientRect,
    GetForegroundWindow, GetWindow, GetWindowLongPtrW, HCURSOR, HTCLIENT, HWND_TOP, IDC_ARROW, IsWindowVisible,
    LWA_ALPHA, LoadCursorW, MA_NOACTIVATE, RegisterClassExW, SET_WINDOW_POS_FLAGS, SWP_FRAMECHANGED, SWP_HIDEWINDOW,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SetCursor,
    SetForegroundWindow, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, WM_ACTIVATE, WM_CAPTURECHANGED,
    WM_CLOSE, WM_DPICHANGED, WM_ERASEBKGND, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCDESTROY,
    WM_PAINT, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETCURSOR, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN,
    WM_XBUTTONUP, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::w;

use crate::screens::PxRect;
use crate::win::error_text;

/// One mouse event, as the window got it: `msg` is the WM_ message (WebView2's mouse event kinds have the
/// same values), `keys` the MK_ flags, `data` the wheel delta (signed, as u32) or the X button, and the point
/// in client pixels (0, 0 for a leave).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MouseInput {
    pub msg: u32,
    pub keys: u32,
    pub data: u32,
    pub x: i32,
    pub y: i32,
}

/// Where an overlay's mouse input goes.
pub trait MouseSink {
    fn mouse(&self, input: &MouseInput);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayEvent {
    /// It became the foreground window (it has the keyboard).
    Activated,
    /// It stopped being the foreground window: the page should let go of its focus (the Mac's `blur`).
    Deactivated,
}

/// A callback kept in a cell (taken by `try_borrow_mut` while it runs).
type Callback<T> = RefCell<Option<Box<dyn FnMut(T)>>>;

#[derive(Default)]
struct State {
    sink: RefCell<Option<Box<dyn MouseSink>>>,
    listener: Callback<OverlayEvent>,
    cursor: Cell<Option<HCURSOR>>,
    tracking: Cell<bool>,
    buttons_down: Cell<u32>,
}

pub struct Overlay {
    hwnd: HWND,
    state: Rc<State>,
}

const CLASS: windows::core::PCWSTR = w!("MarginOverlay");
/// WM_MOUSELEAVE (winuser.h; the windows crate files it under Controls).
pub const WM_MOUSELEAVE: u32 = 0x02A3;

fn register_class() -> Result<windows::Win32::Foundation::HINSTANCE, String> {
    // SAFETY: a static class name and this module's window procedure; a second registration fails harmlessly
    // (ERROR_CLASS_ALREADY_EXISTS) and is ignored.
    unsafe {
        let instance = GetModuleHandleW(None).map_err(error_text)?;
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            style: CS_DBLCLKS,
            lpfnWndProc: Some(proc_),
            hInstance: instance.into(),
            lpszClassName: CLASS,
            ..Default::default()
        };
        RegisterClassExW(&class);
        Ok(instance.into())
    }
}

impl Overlay {
    /// A hidden overlay. Call on the UI thread.
    pub fn create() -> Result<Self, String> {
        let instance = register_class()?;
        let ex = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP | WS_EX_LAYERED;
        // SAFETY: the class is registered above; no parent or owner (see the module's note); hidden.
        let hwnd = unsafe {
            CreateWindowExW(ex, CLASS, w!("Margin"), WS_POPUP, 0, 0, 1, 1, None, None, Some(instance), None)
                .map_err(error_text)?
        };
        // SAFETY: our window. A layered window is drawn only once its attributes are set: opaque (255) here,
        // the transparency being the web view's own pixels.
        if let Err(e) = unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA) } {
            crate::log::warn(format!("overlay: SetLayeredWindowAttributes failed: {}", error_text(e)));
        }
        let state = Rc::new(State::default());
        // SAFETY: as in msgwin.rs: USERDATA holds one strong count, taken back in WM_NCDESTROY.
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, Rc::into_raw(state.clone()) as isize) };
        // SAFETY: a system cursor; shared, never destroyed.
        state.cursor.set(unsafe { LoadCursorW(None, IDC_ARROW) }.ok());
        Ok(Self { hwnd, state })
    }

    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }

    pub fn set_mouse_sink(&self, sink: Box<dyn MouseSink>) {
        *self.state.sink.borrow_mut() = Some(sink);
    }

    pub fn set_listener(&self, f: impl FnMut(OverlayEvent) + 'static) {
        *self.state.listener.borrow_mut() = Some(Box::new(f));
    }

    /// The cursor shown over it (the web view's, as it changes).
    pub fn set_cursor(&self, cursor: HCURSOR) {
        self.state.cursor.set(Some(cursor));
        // While the pointer is over it (it gets the mouse), show it now rather than at the next move.
        if self.state.tracking.get() {
            // SAFETY: a cursor handle the web view gave; SetCursor only shows it.
            unsafe { SetCursor(Some(cursor)) };
        }
    }

    /// The window to put this one after so it's just above `browser`; `None` when it's there already.
    fn slot_above(&self, browser: HWND) -> Option<HWND> {
        // SAFETY: plain reads; a window gone since makes GetWindow fail: then the top of the normal band.
        unsafe {
            match GetWindow(browser, GW_HWNDPREV) {
                Ok(prev) if prev == self.hwnd => None,
                Ok(prev) if !prev.is_invalid() => {
                    // After a topmost window would make this one topmost too: the top of the normal band instead
                    // (which is just above `browser`: nothing normal is above it).
                    let topmost = GetWindowLongPtrW(prev, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0;
                    Some(if topmost { HWND_TOP } else { prev })
                }
                _ => Some(HWND_TOP),
            }
        }
    }

    fn set_pos(&self, after: Option<HWND>, frame: Option<PxRect>, extra: SET_WINDOW_POS_FLAGS) -> bool {
        let mut flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | extra;
        if after.is_none() {
            flags |= SWP_NOZORDER;
        }
        let (x, y, cx, cy) = match frame {
            Some(f) => (f.left, f.top, f.width().max(1), f.height().max(1)),
            None => {
                flags |= SWP_NOMOVE | SWP_NOSIZE;
                (0, 0, 0, 0)
            }
        };
        // SAFETY: our window; `after` is a window handle or HWND_TOP; never activates.
        match unsafe { SetWindowPos(self.hwnd, after, x, y, cx, cy, flags) } {
            Ok(()) => true,
            Err(e) => {
                crate::log::warn(format!("overlay: SetWindowPos failed: {}", error_text(e)));
                false
            }
        }
    }

    /// Moves it over `frame` (physical pixels) and just above `browser`, shown.
    pub fn show(&self, frame: PxRect, browser: isize) -> bool {
        let after = self.slot_above(HWND(browser as *mut _));
        self.set_pos(after, Some(frame), SWP_SHOWWINDOW)
    }

    /// Moves it over `frame`, keeping it just above `browser` (shown or not, as it is).
    pub fn place(&self, frame: PxRect, browser: isize) -> bool {
        let after = self.slot_above(HWND(browser as *mut _));
        self.set_pos(after, Some(frame), SET_WINDOW_POS_FLAGS(0))
    }

    /// Back just above `browser` in the z-order (after the browser's window was brought forward).
    pub fn restack(&self, browser: isize) -> bool {
        match self.slot_above(HWND(browser as *mut _)) {
            None => true,
            after => self.set_pos(after, None, SET_WINDOW_POS_FLAGS(0)),
        }
    }

    /// Hidden. Hand the keyboard back first if it has it (`hand_back`): hiding the foreground window lets
    /// Windows pick the next one, which may not be the browser's.
    pub fn hide(&self) -> bool {
        self.set_pos(None, None, SWP_HIDEWINDOW)
    }

    pub fn is_shown(&self) -> bool {
        // SAFETY: a plain read of our window.
        unsafe { IsWindowVisible(self.hwnd) }.as_bool()
    }

    /// Clicks and the wheel go through it to the window below (true), or to it (false).
    pub fn set_pass_through(&self, on: bool) {
        // SAFETY: our window's extended style, read and written on its own thread.
        unsafe {
            let ex = GetWindowLongPtrW(self.hwnd, GWL_EXSTYLE) as u32;
            let want = if on { ex | WS_EX_TRANSPARENT.0 } else { ex & !WS_EX_TRANSPARENT.0 };
            if want != ex {
                SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, want as isize);
                self.set_pos(None, None, SWP_FRAMECHANGED);
            }
        }
    }

    pub fn pass_through(&self) -> bool {
        // SAFETY: a plain read of our window.
        let ex = unsafe { GetWindowLongPtrW(self.hwnd, GWL_EXSTYLE) } as u32;
        ex & WS_EX_TRANSPARENT.0 != 0
    }

    /// The overlay becomes the foreground window, so the page's field gets the keys (then focus the web view:
    /// webview.rs `focus`). Windows allows it while Margin received the last input (a hot key, a click in the
    /// overlay); otherwise it refuses, and this says false.
    pub fn take_keyboard(&self) -> bool {
        // SAFETY: plain calls on our window.
        unsafe {
            let _ = SetForegroundWindow(self.hwnd);
            GetForegroundWindow() == self.hwnd
        }
    }

    /// The keyboard back to `browser`'s window, if the overlay has it (being in front, Margin may move it).
    pub fn hand_back(&self, browser: isize) -> bool {
        if !self.has_keyboard() {
            return false;
        }
        // SAFETY: a window handle that may have gone (then the call fails and says so).
        unsafe { SetForegroundWindow(HWND(browser as *mut _)) }.as_bool()
    }

    pub fn has_keyboard(&self) -> bool {
        // SAFETY: no arguments.
        unsafe { GetForegroundWindow() == self.hwnd }
    }

    /// Its client area's size, in physical pixels.
    pub fn client_size(&self) -> (i32, i32) {
        let mut r = RECT::default();
        // SAFETY: our window; an out-parameter.
        let _ = unsafe { GetClientRect(self.hwnd, &mut r) };
        (r.right - r.left, r.bottom - r.top)
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        // SAFETY: our window, on its own thread; WM_NCDESTROY releases the state's count in USERDATA.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

fn lo(l: isize) -> i32 {
    (l & 0xFFFF) as u16 as i16 as i32
}

fn hi(l: isize) -> i32 {
    ((l >> 16) & 0xFFFF) as u16 as i16 as i32
}

fn is_down(msg: u32) -> bool {
    matches!(
        msg,
        WM_LBUTTONDOWN
            | WM_RBUTTONDOWN
            | WM_MBUTTONDOWN
            | WM_XBUTTONDOWN
            | WM_LBUTTONDBLCLK
            | WM_RBUTTONDBLCLK
            | WM_MBUTTONDBLCLK
            | WM_XBUTTONDBLCLK
    )
}

fn is_up(msg: u32) -> bool {
    matches!(msg, WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP)
}

fn mouse(hwnd: HWND, state: &State, msg: u32, wparam: WPARAM, lparam: LPARAM) {
    let keys = (wparam.0 & 0xFFFF) as u32;
    let (mut x, mut y) = (lo(lparam.0), hi(lparam.0));
    let mut data = 0u32;
    match msg {
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
            // The wheel's point is on the screen: into client pixels.
            let mut p = POINT { x, y };
            // SAFETY: our window; an in/out POINT.
            let _ = unsafe { ScreenToClient(hwnd, &mut p) };
            (x, y) = (p.x, p.y);
            data = hi(wparam.0 as isize) as u32;
        }
        WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK => data = ((wparam.0 >> 16) & 0xFFFF) as u32,
        WM_MOUSELEAVE => (x, y) = (0, 0),
        _ => {}
    }
    if msg == WM_MOUSEMOVE && !state.tracking.get() {
        let mut t = TRACKMOUSEEVENT {
            cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        // SAFETY: a filled TRACKMOUSEEVENT for our window.
        if unsafe { TrackMouseEvent(&mut t) }.is_ok() {
            state.tracking.set(true);
        }
    }
    if msg == WM_MOUSELEAVE {
        state.tracking.set(false);
    }
    if is_down(msg) {
        if state.buttons_down.get() == 0 {
            // SAFETY: our window, while a button is down over it: drags leaving it still come here.
            unsafe { SetCapture(hwnd) };
        }
        state.buttons_down.set(state.buttons_down.get() + 1);
    }
    let input = MouseInput { msg, keys, data, x, y };
    if let Ok(sink) = state.sink.try_borrow()
        && let Some(sink) = sink.as_ref()
    {
        sink.mouse(&input);
    }
    if is_up(msg) {
        let left = state.buttons_down.get().saturating_sub(1);
        state.buttons_down.set(left);
        if left == 0 {
            // SAFETY: releases our own capture (harmless when there's none).
            let _ = unsafe { ReleaseCapture() };
        }
    }
}

fn tell(state: &State, event: OverlayEvent) {
    if let Ok(mut l) = state.listener.try_borrow_mut()
        && let Some(f) = l.as_mut()
    {
        f(event);
    }
}

unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: USERDATA is 0 or the pointer `create` stored, valid until WM_NCDESTROY takes it back.
    let raw = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const State;
    if raw.is_null() {
        // SAFETY: plain default handling.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    if msg == WM_NCDESTROY {
        // SAFETY: the count `create` gave USERDATA, taken back once; USERDATA cleared first.
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            drop(Rc::from_raw(raw));
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
    }
    // SAFETY: a live Rc's pointer; the clone keeps the state alive through a sink or listener that drops the
    // Overlay.
    let state = unsafe {
        Rc::increment_strong_count(raw);
        Rc::from_raw(raw)
    };
    match msg {
        WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK | WM_RBUTTONDOWN | WM_RBUTTONUP
        | WM_RBUTTONDBLCLK | WM_MBUTTONDOWN | WM_MBUTTONUP | WM_MBUTTONDBLCLK | WM_XBUTTONDOWN | WM_XBUTTONUP
        | WM_XBUTTONDBLCLK | WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_MOUSELEAVE => {
            mouse(hwnd, &state, msg, wparam, lparam);
            // X buttons: TRUE says it was handled (no browser back/forward from them).
            LRESULT(if matches!(msg, WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK) { 1 } else { 0 })
        }
        WM_CAPTURECHANGED => {
            state.buttons_down.set(0);
            LRESULT(0)
        }
        WM_SETCURSOR if (lparam.0 & 0xFFFF) as u32 == HTCLIENT => {
            if let Some(c) = state.cursor.get() {
                // SAFETY: a cursor handle from the system or the web view.
                unsafe { SetCursor(Some(c)) };
            }
            LRESULT(1)
        }
        // A click never activates it (as WS_EX_NOACTIVATE), the press itself still delivered.
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_ACTIVATE => {
            let active = (wparam.0 & 0xFFFF) != 0;
            tell(&state, if active { OverlayEvent::Activated } else { OverlayEvent::Deactivated });
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            // Nothing to paint: DirectComposition draws the content.
            // SAFETY: our window; validates the whole client area.
            let _ = unsafe { ValidateRect(Some(hwnd), None) };
            LRESULT(0)
        }
        // The shell places it in pixels itself; Windows' suggested rectangle is ignored.
        WM_DPICHANGED => LRESULT(0),
        // Alt+F4 while it has the keyboard: the overlay lives as long as its browser window, not closed.
        WM_CLOSE => LRESULT(0),
        // SAFETY: plain default handling.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

impl std::fmt::Debug for Overlay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Overlay({:?})", self.hwnd.0)
    }
}
