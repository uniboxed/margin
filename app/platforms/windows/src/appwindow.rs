//! Margin's own window on Windows (docs/HOSTED-WINDOWS-CHROMIUM.md §4.1, §4.2): a top-level app window (its taskbar
//! button, its Alt+Tab entry) whose client area is the whole window, the theme drawing its frame. Windows only.
//!
//! - **The frame:** `WM_NCCALCSIZE` gives the client the whole window (maximized: less the frame Windows lets overhang
//!   the monitor), DWM keeps the shadow and snap (`DwmExtendFrameIntoClientArea`, a 1 px margin). `WM_NCHITTEST` is
//!   hole.rs `chrome_hit` over the theme's drag regions and window controls (the page's `chrome` op): Windows itself then
//!   drags, resizes, minimizes, maximizes (Windows 11's snap layouts on the maximize button) and closes it.
//! - **The holes:** the windows Margin hosts lie under this one at their rects; each rect is cut from this window's
//!   region (hole.rs `region`), so a click there reaches the hosted window, natively. The page draws nothing there.
//! - **Content:** with `web`, the web view's DirectComposition visual (`WS_EX_NOREDIRECTIONBITMAP`: its transparent
//!   pixels show the hosted windows through); the mouse handed to it as the overlays do (overlay.rs `mouse`). Without
//!   (`--host-check`), a plain colour painted by GDI.
//! - **The keyboard:** while a window is hosted in it, a click never takes the keyboard from that window
//!   (`MA_NOACTIVATE`); a field of the page takes it (`take_keyboard`, as an overlay's). With nothing hosted it activates
//!   as any window.
//! - **What it tells the shell** (`AppEvent`): its size and state, a move, the start and end of a move or resize loop,
//!   its monitor's scale, activation, and a close asked (the shell gives every host back, then destroys it).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, ClientToScreen, CombineRgn, CreateRectRgn, CreateSolidBrush, DeleteObject, EndPaint, FillRect,
    GetMonitorInfoW, HGDIOBJ, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow, PAINTSTRUCT, RGN_OR,
    ScreenToClient, SetWindowRgn, ValidateRect,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::MARGINS;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_DBLCLKS, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow, GWLP_USERDATA, GetClientRect,
    GetWindowLongPtrW, HCURSOR, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTCAPTION, HTCLIENT, HTCLOSE, HTLEFT,
    HTMAXBUTTON, HTMINBUTTON, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT, IDC_ARROW, IsZoomed, LoadCursorW, MA_NOACTIVATE,
    NCCALCSIZE_PARAMS, RegisterClassExW, SIZE_MAXIMIZED, SIZE_MINIMIZED, SM_CXPADDEDBORDER, SM_CXSIZEFRAME,
    SM_CYSIZEFRAME, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER, SetCursor,
    SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow, WM_ACTIVATE, WM_CAPTURECHANGED, WM_CLOSE,
    WM_DPICHANGED, WM_ENTERSIZEMOVE, WM_ERASEBKGND, WM_EXITSIZEMOVE, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_MOVE, WM_NCCALCSIZE, WM_NCDESTROY, WM_NCHITTEST, WM_PAINT, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_SETCURSOR, WM_SIZE, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP, WNDCLASSEXW, WS_EX_APPWINDOW,
    WS_EX_NOREDIRECTIONBITMAP, WS_OVERLAPPEDWINDOW,
};
use windows::core::{HSTRING, w};

use crate::hole::{Chrome, Hit, chrome_hit, region};
use crate::overlay::{MouseSink, Pointer, WM_MOUSELEAVE, mouse};
use crate::screens::PxRect;
use crate::win::error_text;

/// How the window is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shown {
    Normal,
    Minimized,
    Maximized,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AppEvent {
    /// Its client size (physical pixels) and how it's shown.
    Resized {
        width: i32,
        height: i32,
        shown: Shown,
    },
    Moved,
    /// A move or resize loop began or ended (the person dragging its frame).
    MoveLoop {
        on: bool,
    },
    /// Its monitor's scale (DPI ÷ 96) changed: Windows' suggested rect taken.
    Scale {
        scale: f64,
    },
    Activated {
        on: bool,
    },
    /// Closed by the person (its close button, Alt+F4): the shell gives every host back, then `destroy`s it.
    CloseAsked,
}

type Listener = RefCell<Option<Box<dyn FnMut(AppEvent)>>>;

#[derive(Default)]
struct State {
    pointer: Pointer,
    listener: Listener,
    chrome: RefCell<Chrome>,
    /// A window is hosted in it: a click never takes the keyboard.
    hosting: Cell<bool>,
    /// The resize border's width (pixels at its scale), none while full screen.
    full_screen: Cell<bool>,
    /// GDI's colour for a window without a web view (`--host-check`).
    paint: Cell<Option<COLORREF>>,
}

pub struct AppWindow {
    hwnd: HWND,
    state: Rc<State>,
}

const CLASS: windows::core::PCWSTR = w!("MarginAppWindow");

fn register_class() -> Result<windows::Win32::Foundation::HINSTANCE, String> {
    // SAFETY: a static class name and this module's procedure; a second registration fails harmlessly.
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

impl AppWindow {
    /// Margin's window, hidden until `show`. `web`: its content a web view's visual; else `paint`ed plainly.
    pub fn create(title: &str, web: bool, width: i32, height: i32) -> Result<Self, String> {
        let instance = register_class()?;
        let ex = if web { WS_EX_APPWINDOW | WS_EX_NOREDIRECTIONBITMAP } else { WS_EX_APPWINDOW };
        // SAFETY: the class is registered above; a top-level window of this thread, hidden.
        let hwnd = unsafe {
            CreateWindowExW(
                ex,
                CLASS,
                &HSTRING::from(title),
                WS_OVERLAPPEDWINDOW,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                width,
                height,
                None,
                None,
                Some(instance),
                None,
            )
            .map_err(error_text)?
        };
        let state = Rc::new(State::default());
        // SAFETY: USERDATA holds one strong count, taken back in WM_NCDESTROY (as msgwin.rs and overlay.rs).
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, Rc::into_raw(state.clone()) as isize) };
        // SAFETY: a system cursor; shared, never destroyed.
        state.pointer.cursor.set(unsafe { LoadCursorW(None, IDC_ARROW) }.ok());
        // The shadow and snap: DWM's frame extended 1 px into the client (the theme draws the rest).
        let margins = MARGINS { cxLeftWidth: 0, cxRightWidth: 0, cyTopHeight: 1, cyBottomHeight: 0 };
        // SAFETY: our window; a MARGINS read for the call.
        if let Err(e) = unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) } {
            crate::log::note(format!("app window: DWM's frame not extended ({})", error_text(e)));
        }
        // (The frame recalculated now that WM_NCCALCSIZE gives the client the whole window.)
        // SAFETY: our window; no move, no size, no z-order change.
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                windows::Win32::UI::WindowsAndMessaging::SWP_FRAMECHANGED
                    | windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                    | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE
                    | SWP_NOZORDER
                    | SWP_NOACTIVATE,
            )
        };
        Ok(Self { hwnd, state })
    }

    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }

    pub fn show(&self) {
        // SAFETY: our window.
        let _ = unsafe { ShowWindow(self.hwnd, SW_SHOW) };
    }
    pub fn minimize(&self) {
        // SAFETY: our window.
        let _ = unsafe { ShowWindow(self.hwnd, SW_MINIMIZE) };
    }
    pub fn maximize(&self) {
        // SAFETY: our window.
        let _ = unsafe { ShowWindow(self.hwnd, SW_MAXIMIZE) };
    }
    pub fn restore(&self) {
        // SAFETY: our window.
        let _ = unsafe { ShowWindow(self.hwnd, SW_RESTORE) };
    }

    pub fn set_listener(&self, f: impl FnMut(AppEvent) + 'static) {
        *self.state.listener.borrow_mut() = Some(Box::new(f));
    }
    pub fn set_mouse_sink(&self, sink: Box<dyn MouseSink>) {
        *self.state.pointer.sink.borrow_mut() = Some(sink);
    }
    pub fn set_cursor(&self, cursor: HCURSOR) {
        self.state.pointer.cursor.set(Some(cursor));
        if self.state.pointer.tracking.get() {
            // SAFETY: a cursor handle the web view gave.
            unsafe { SetCursor(Some(cursor)) };
        }
    }
    /// The theme's drag regions and window controls (the page's `chrome` op), client pixels.
    pub fn set_chrome(&self, chrome: Chrome) {
        *self.state.chrome.borrow_mut() = chrome;
    }
    /// Whether a window is hosted in it (a click then never takes the keyboard from it).
    pub fn set_hosting(&self, on: bool) {
        self.state.hosting.set(on);
    }
    /// A plain colour for a window without a web view.
    pub fn set_paint(&self, rgb: (u8, u8, u8)) {
        self.state.paint.set(Some(COLORREF(rgb.0 as u32 | (rgb.1 as u32) << 8 | (rgb.2 as u32) << 16)));
    }

    /// The holes (client pixels) cut from its region, each one's corners (`radius`) kept; none: no region at all.
    pub fn set_holes(&self, holes: &[PxRect], radius: i32) -> bool {
        let (w, h) = self.client_size();
        if holes.is_empty() {
            // SAFETY: our window; no region (the whole window).
            return unsafe { SetWindowRgn(self.hwnd, None, true) } != 0;
        }
        let parts = region(w, h, holes, radius);
        // SAFETY (the block): a region made from rectangles, owned by the system once SetWindowRgn takes it; the
        // pieces combined into it are deleted here.
        unsafe {
            let all = CreateRectRgn(0, 0, 0, 0);
            if all.is_invalid() {
                return false;
            }
            for p in &parts {
                let piece = CreateRectRgn(p.left, p.top, p.right, p.bottom);
                if piece.is_invalid() {
                    continue;
                }
                CombineRgn(Some(all), Some(all), Some(piece), RGN_OR);
                let _ = DeleteObject(HGDIOBJ(piece.0));
            }
            if SetWindowRgn(self.hwnd, Some(all), true) == 0 {
                let _ = DeleteObject(HGDIOBJ(all.0));
                return false;
            }
        }
        true
    }

    pub fn client_size(&self) -> (i32, i32) {
        let mut r = RECT::default();
        // SAFETY: our window; an out-parameter.
        let _ = unsafe { GetClientRect(self.hwnd, &mut r) };
        (r.right - r.left, r.bottom - r.top)
    }

    /// Its client area's top left on the screen (physical pixels).
    pub fn client_origin(&self) -> (i32, i32) {
        let mut p = POINT { x: 0, y: 0 };
        // SAFETY: our window; an in/out POINT.
        let _ = unsafe { ClientToScreen(self.hwnd, &mut p) };
        (p.x, p.y)
    }

    /// Its monitor's scale (DPI ÷ 96).
    pub fn scale(&self) -> f64 {
        // SAFETY: our window.
        let dpi = unsafe { GetDpiForWindow(self.hwnd) };
        if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
    }

    /// The work area of its monitor (physical pixels): where a hosted window at its minimum stays.
    pub fn work_area(&self) -> PxRect {
        // SAFETY: our window; MONITORINFO with its size set, as the call asks.
        unsafe {
            let m = MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(m, &mut info).as_bool() {
                let r = info.rcWork;
                PxRect::new(r.left, r.top, r.right, r.bottom)
            } else {
                PxRect::default()
            }
        }
    }

    /// The keyboard to it (a field of the page has the focus): allowed while Margin had the last input.
    pub fn take_keyboard(&self) -> bool {
        // SAFETY: our window.
        unsafe { SetForegroundWindow(self.hwnd) }.as_bool()
    }

    pub fn set_full_screen(&self, on: bool) {
        self.state.full_screen.set(on);
    }

    pub fn destroy(&self) {
        // SAFETY: our window, on its thread.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

impl Drop for AppWindow {
    fn drop(&mut self) {
        self.destroy();
    }
}

fn tell(state: &State, e: AppEvent) {
    if let Ok(mut l) = state.listener.try_borrow_mut()
        && let Some(f) = l.as_mut()
    {
        f(e);
    }
}

fn lo(l: isize) -> i32 {
    (l & 0xFFFF) as u16 as i16 as i32
}
fn hi(l: isize) -> i32 {
    ((l >> 16) & 0xFFFF) as u16 as i16 as i32
}

fn hit_code(h: Hit) -> u32 {
    match h {
        Hit::Client => HTCLIENT,
        Hit::Caption => HTCAPTION,
        Hit::Minimize => HTMINBUTTON,
        Hit::Maximize => HTMAXBUTTON,
        Hit::Close => HTCLOSE,
        Hit::Left => HTLEFT,
        Hit::Right => HTRIGHT,
        Hit::Top => HTTOP,
        Hit::Bottom => HTBOTTOM,
        Hit::TopLeft => HTTOPLEFT,
        Hit::TopRight => HTTOPRIGHT,
        Hit::BottomLeft => HTBOTTOMLEFT,
        Hit::BottomRight => HTBOTTOMRIGHT,
    }
}

unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: USERDATA is 0 or the pointer `create` stored, valid until WM_NCDESTROY takes it back.
    let raw = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const State;
    if raw.is_null() {
        // SAFETY: plain default handling (WM_NCCREATE and the like, before USERDATA is set).
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
    // SAFETY: a live Rc's pointer; the clone keeps the state alive through a listener that drops the window.
    let state = unsafe {
        Rc::increment_strong_count(raw);
        Rc::from_raw(raw)
    };
    // SAFETY: our window, on its thread.
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    match msg {
        WM_NCCALCSIZE if wparam.0 != 0 => {
            // The client is the whole window; maximized, less the frame Windows lets overhang the monitor.
            // SAFETY: with wparam TRUE, lparam is an NCCALCSIZE_PARAMS the system owns for this call.
            unsafe {
                if IsZoomed(hwnd).as_bool() {
                    let p = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
                    let pad = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
                    let fx = GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + pad;
                    let fy = GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + pad;
                    let r = &mut p.rgrc[0];
                    r.left += fx;
                    r.right -= fx;
                    r.top += fy;
                    r.bottom -= fy;
                }
            }
            LRESULT(0)
        }
        WM_NCHITTEST => {
            let mut p = POINT { x: lo(lparam.0), y: hi(lparam.0) };
            // SAFETY: our window; an in/out POINT.
            let _ = unsafe { ScreenToClient(hwnd, &mut p) };
            let mut r = RECT::default();
            // SAFETY: our window; an out-parameter.
            let _ = unsafe { GetClientRect(hwnd, &mut r) };
            // SAFETY: our window.
            let zoomed = unsafe { IsZoomed(hwnd) }.as_bool();
            let border = (8.0 * dpi as f64 / 96.0).round() as i32;
            let sizable = !zoomed && !state.full_screen.get();
            let hit = chrome_hit(p.x, p.y, r.right, r.bottom, border, sizable, &state.chrome.borrow());
            LRESULT(hit_code(hit) as isize)
        }
        WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK | WM_RBUTTONDOWN | WM_RBUTTONUP
        | WM_RBUTTONDBLCLK | WM_MBUTTONDOWN | WM_MBUTTONUP | WM_MBUTTONDBLCLK | WM_XBUTTONDOWN | WM_XBUTTONUP
        | WM_XBUTTONDBLCLK | WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_MOUSELEAVE => {
            mouse(hwnd, &state.pointer, msg, wparam, lparam);
            LRESULT(if matches!(msg, WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK) { 1 } else { 0 })
        }
        WM_CAPTURECHANGED => {
            state.pointer.buttons_down.set(0);
            LRESULT(0)
        }
        WM_SETCURSOR if (lparam.0 & 0xFFFF) as u32 == HTCLIENT => {
            if let Some(c) = state.pointer.cursor.get() {
                // SAFETY: a cursor handle from the system or the web view.
                unsafe { SetCursor(Some(c)) };
            }
            LRESULT(1)
        }
        // While a window is hosted here, a click never takes the keyboard from it (the press itself still comes).
        WM_MOUSEACTIVATE if state.hosting.get() => LRESULT(MA_NOACTIVATE as isize),
        WM_SIZE => {
            let shown = match wparam.0 as u32 {
                SIZE_MINIMIZED => Shown::Minimized,
                SIZE_MAXIMIZED => Shown::Maximized,
                _ => Shown::Normal,
            };
            tell(&state, AppEvent::Resized { width: lo(lparam.0), height: hi(lparam.0), shown });
            LRESULT(0)
        }
        WM_MOVE => {
            tell(&state, AppEvent::Moved);
            LRESULT(0)
        }
        WM_ENTERSIZEMOVE | WM_EXITSIZEMOVE => {
            tell(&state, AppEvent::MoveLoop { on: msg == WM_ENTERSIZEMOVE });
            LRESULT(0)
        }
        WM_DPICHANGED => {
            // Windows' suggested rect for the new monitor's scale, as asked of a per-monitor-v2 window.
            // SAFETY: lparam is a RECT the system owns for this call; our window.
            unsafe {
                let r = &*(lparam.0 as *const RECT);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            tell(&state, AppEvent::Scale { scale: (wparam.0 & 0xFFFF) as f64 / 96.0 });
            LRESULT(0)
        }
        WM_ACTIVATE => {
            tell(&state, AppEvent::Activated { on: (wparam.0 & 0xFFFF) != 0 });
            // SAFETY: plain default handling (the caption's active look).
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CLOSE => {
            tell(&state, AppEvent::CloseAsked);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            match state.paint.get() {
                Some(colour) => {
                    let mut ps = PAINTSTRUCT::default();
                    // SAFETY (the block): our window's paint cycle; the brush made and deleted here.
                    unsafe {
                        let dc = BeginPaint(hwnd, &mut ps);
                        let brush = CreateSolidBrush(colour);
                        FillRect(dc, &ps.rcPaint, brush);
                        let _ = DeleteObject(HGDIOBJ(brush.0));
                        let _ = EndPaint(hwnd, &ps);
                    }
                }
                None => {
                    // Nothing to paint: DirectComposition draws the content.
                    // SAFETY: our window; validates the whole client area.
                    let _ = unsafe { ValidateRect(Some(hwnd), None) };
                }
            }
            LRESULT(0)
        }
        // SAFETY: plain default handling.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Margin's window and its web view wired together (as overlay.rs's `connect`): the mouse to the page, the page's
/// cursor to the window. The page's ops (`layout`, `chrome`) are the shell's: hole.rs `page_layout`, `Chrome::from_op`.
pub fn attach(app: &Rc<AppWindow>, webview: &crate::webview::WebView) {
    app.set_mouse_sink(webview.mouse_sink());
    let weak = Rc::downgrade(app);
    webview.on_cursor(move |c| {
        if let Some(a) = weak.upgrade() {
            a.set_cursor(c);
        }
    });
}
