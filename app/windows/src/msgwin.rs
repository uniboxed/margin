//! Margin's message-only window on the UI thread: where other threads' wakes (queue.rs), the hot keys'
//! WM_HOTKEY and the timers arrive. A window, not the thread's own queue, because thread messages are lost
//! while a modal loop runs (a menu, a window being moved). Windows only.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GWLP_USERDATA, GetWindowLongPtrW, HWND_MESSAGE, KillTimer,
    PostMessageW, RegisterClassExW, SetTimer, SetWindowLongPtrW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_NCDESTROY,
    WM_TIMER, WNDCLASSEXW,
};
use windows::core::w;

use crate::queue::Wake;
use crate::win::error_text;

type Handler = Box<dyn FnMut(WPARAM, LPARAM)>;

#[derive(Default)]
struct State {
    by_message: HashMap<u32, Handler>,
    by_timer: HashMap<usize, Box<dyn FnMut()>>,
    // Taken off (`off`, `kill_timer`) while their own handler ran: not put back.
    gone_messages: HashSet<u32>,
    gone_timers: HashSet<usize>,
}

/// The message window. Dropping it destroys the window (its handlers with it).
pub struct MessageWindow {
    hwnd: HWND,
    state: Rc<RefCell<State>>,
}

/// The first of the messages handed out by `message_id` (WM_APP and up are the application's own).
const FIRST_APP_MESSAGE: u32 = WM_APP + 16;

impl MessageWindow {
    pub fn new() -> Result<Self, String> {
        // SAFETY: the class is registered once per process with a static name and this module's window
        // procedure; registering it again fails harmlessly (ERROR_CLASS_ALREADY_EXISTS), which is ignored.
        let hwnd = unsafe {
            let instance = GetModuleHandleW(None).map_err(error_text)?;
            let class = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(proc_),
                hInstance: instance.into(),
                lpszClassName: w!("MarginMessages"),
                ..Default::default()
            };
            RegisterClassExW(&class);
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("MarginMessages"),
                w!("Margin"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance.into()),
                None,
            )
            .map_err(error_text)?
        };
        let state = Rc::new(RefCell::new(State::default()));
        // SAFETY: the window is ours; USERDATA holds one strong count of `state` (Rc::into_raw), taken back in
        // WM_NCDESTROY.
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, Rc::into_raw(state.clone()) as isize) };
        Ok(Self { hwnd, state })
    }

    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }

    /// Runs `f` for every `msg` this window gets (one handler per message; a new one replaces the old).
    pub fn on(&self, msg: u32, f: impl FnMut(WPARAM, LPARAM) + 'static) {
        let mut s = self.state.borrow_mut();
        s.gone_messages.remove(&msg);
        s.by_message.insert(msg, Box::new(f));
    }

    pub fn off(&self, msg: u32) {
        let mut s = self.state.borrow_mut();
        if s.by_message.remove(&msg).is_none() {
            s.gone_messages.insert(msg);
        }
    }

    /// Runs `f` every `ms` milliseconds (at the system's timer resolution, ~15.6 ms) until `kill_timer(id)`.
    pub fn set_timer(&self, id: usize, ms: u32, f: impl FnMut() + 'static) -> bool {
        {
            let mut s = self.state.borrow_mut();
            s.gone_timers.remove(&id);
            s.by_timer.insert(id, Box::new(f));
        }
        // SAFETY: the window is ours and alive; no TIMERPROC: WM_TIMER comes to this window's procedure.
        unsafe { SetTimer(Some(self.hwnd), id, ms, None) != 0 }
    }

    pub fn kill_timer(&self, id: usize) {
        // SAFETY: as above; killing a timer that isn't set fails harmlessly.
        let _ = unsafe { KillTimer(Some(self.hwnd), id) };
        let mut s = self.state.borrow_mut();
        if s.by_timer.remove(&id).is_none() {
            s.gone_timers.insert(id);
        }
    }

    /// A wake for queue.rs: posts `msg` to this window from any thread.
    pub fn waker(&self, msg: u32) -> Wake {
        let hwnd = self.hwnd.0 as isize;
        Arc::new(move || {
            // SAFETY: PostMessageW may be called from any thread; a window that's gone makes it fail, which
            // is fine (the UI side has stopped).
            let _ = unsafe { PostMessageW(Some(HWND(hwnd as *mut _)), msg, WPARAM(0), LPARAM(0)) };
        })
    }
}

/// A message number of Margin's own, for `on` and `waker`: `MessageWindow::message_id(n)` for n = 0, 1, ….
pub const fn message_id(n: u32) -> u32 {
    FIRST_APP_MESSAGE + n
}

impl Drop for MessageWindow {
    fn drop(&mut self) {
        // SAFETY: the window is ours, on this thread; WM_NCDESTROY releases the state's count in USERDATA.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: USERDATA is 0 or the pointer `new` stored, which stays valid until WM_NCDESTROY takes it back.
    let raw = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const RefCell<State>;
    if raw.is_null() {
        // SAFETY: plain default handling.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    if msg == WM_NCDESTROY {
        // SAFETY: the count `new` gave USERDATA, taken back once; USERDATA is cleared so it isn't used again.
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            drop(Rc::from_raw(raw));
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
    }
    // SAFETY: `raw` is a live Rc's pointer (above); a clone keeps it alive while a handler runs, even if the
    // handler drops the MessageWindow.
    let state = unsafe {
        Rc::increment_strong_count(raw);
        Rc::from_raw(raw)
    };
    if msg == WM_TIMER {
        let id = wparam.0;
        // Taken out while it runs, so it may set or kill timers itself; put back unless it was replaced.
        let taken = state.try_borrow_mut().ok().and_then(|mut s| s.by_timer.remove(&id));
        if let Some(mut f) = taken {
            f();
            if let Ok(mut s) = state.try_borrow_mut() {
                if !s.gone_timers.remove(&id) {
                    s.by_timer.entry(id).or_insert(f);
                }
            }
        }
        return LRESULT(0);
    }
    let taken = state.try_borrow_mut().ok().and_then(|mut s| s.by_message.remove(&msg));
    match taken {
        Some(mut f) => {
            f(wparam, lparam);
            if let Ok(mut s) = state.try_borrow_mut() {
                if !s.gone_messages.remove(&msg) {
                    s.by_message.entry(msg).or_insert(f);
                }
            }
            LRESULT(0)
        }
        // SAFETY: plain default handling.
        None => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}
