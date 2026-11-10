//! The pointer, wherever it is (app/platforms/macos/shell/PassThrough.swift `PointerWatch`'s counterpart). Windows has no
//! global mouse monitor without a hook, and a low-level mouse hook would sit in every mouse event's path, so
//! the pointer is polled instead: `GetCursorPos` and the buttons' state at about 60 Hz, only while the shell
//! runs it (a browser in front). Each change is handed to the shell, which decides whether each overlay lets
//! the mouse through (overlay.rs `set_pass_through`).
//!
//! The change detection is OS-neutral and tested on the Mac; the polling is Windows'.

/// Where the pointer is (physical pixels of the virtual screen) and whether any mouse button is down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PointerSample {
    pub x: i32,
    pub y: i32,
    pub buttons: bool,
    /// A button went down since the last sample (the Mac's `onPress`: a press in the browser re-orders the
    /// overlays above it).
    pub pressed: bool,
}

/// Turns polls into changes: a sample only when the place or the buttons changed.
#[derive(Clone, Debug, Default)]
pub struct PointerDiff {
    last: Option<(i32, i32, bool)>,
}

impl PointerDiff {
    pub fn next(&mut self, x: i32, y: i32, buttons: bool) -> Option<PointerSample> {
        let was = self.last.replace((x, y, buttons));
        match was {
            Some(w) if w == (x, y, buttons) => None,
            Some((_, _, b)) => Some(PointerSample { x, y, buttons, pressed: buttons && !b }),
            None => Some(PointerSample { x, y, buttons, pressed: false }),
        }
    }

    /// Forgets the last sample: the next poll is reported whatever it is.
    pub fn reset(&mut self) {
        self.last = None;
    }
}

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use std::cell::RefCell;
    use std::rc::{Rc, Weak};

    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON, VK_XBUTTON1, VK_XBUTTON2,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    use super::{PointerDiff, PointerSample};
    use crate::msgwin::MessageWindow;

    /// The polling period: SetTimer rounds it to the system timer (about 15.6 ms: ~64 Hz).
    pub const PERIOD_MS: u32 = 16;
    const TIMER: usize = 0x5054; // "PT"

    /// The pointer now, in physical pixels; `None` on the secure desktop (or another failure).
    pub fn location() -> Option<(i32, i32)> {
        let mut p = POINT::default();
        // SAFETY: an out-parameter.
        unsafe { GetCursorPos(&mut p) }.ok().map(|_| (p.x, p.y))
    }

    /// Whether any mouse button is down now (physical buttons: swapped buttons make no difference here).
    pub fn buttons_down() -> bool {
        [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2]
            .iter()
            // SAFETY: GetAsyncKeyState only reads the key's state.
            .any(|vk| unsafe { GetAsyncKeyState(vk.0 as i32) } < 0)
    }

    type Sink = Rc<RefCell<Box<dyn FnMut(PointerSample)>>>;

    /// Polls the pointer on the UI thread while started.
    pub struct PointerWatch {
        window: Weak<MessageWindow>,
        diff: Rc<RefCell<PointerDiff>>,
        sink: Sink,
        started: bool,
    }

    impl PointerWatch {
        pub fn new(window: &Rc<MessageWindow>, sink: impl FnMut(PointerSample) + 'static) -> Self {
            Self {
                window: Rc::downgrade(window),
                diff: Rc::new(RefCell::new(PointerDiff::default())),
                sink: Rc::new(RefCell::new(Box::new(sink))),
                started: false,
            }
        }

        pub fn start(&mut self) {
            let Some(window) = self.window.upgrade() else { return };
            if self.started {
                return;
            }
            self.diff.borrow_mut().reset();
            let (diff, sink) = (self.diff.clone(), self.sink.clone());
            self.started = window.set_timer(TIMER, PERIOD_MS, move || {
                let Some((x, y)) = location() else { return };
                let Some(sample) = diff.borrow_mut().next(x, y, buttons_down()) else { return };
                // Busy: the sink is running already (it pumped messages): this sample is skipped.
                if let Ok(mut f) = sink.try_borrow_mut() {
                    f(sample);
                }
            });
        }

        pub fn stop(&mut self) {
            if let Some(window) = self.window.upgrade() {
                window.kill_timer(TIMER);
            }
            self.started = false;
        }

        pub fn is_started(&self) -> bool {
            self.started
        }
    }

    impl Drop for PointerWatch {
        fn drop(&mut self) {
            self.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_changes() {
        let mut d = PointerDiff::default();
        assert_eq!(d.next(1, 2, false), Some(PointerSample { x: 1, y: 2, buttons: false, pressed: false }));
        assert_eq!(d.next(1, 2, false), None);
        assert_eq!(d.next(1, 3, false), Some(PointerSample { x: 1, y: 3, buttons: false, pressed: false }));
        assert_eq!(d.next(1, 3, true), Some(PointerSample { x: 1, y: 3, buttons: true, pressed: true }));
        assert_eq!(d.next(2, 3, true), Some(PointerSample { x: 2, y: 3, buttons: true, pressed: false }));
        assert_eq!(d.next(2, 3, false), Some(PointerSample { x: 2, y: 3, buttons: false, pressed: false }));
        d.reset();
        assert!(d.next(2, 3, false).is_some());
    }

    #[test]
    fn the_first_sample_is_no_press() {
        let mut d = PointerDiff::default();
        assert!(!d.next(0, 0, true).unwrap().pressed);
    }
}
