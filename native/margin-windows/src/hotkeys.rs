//! Margin's hot keys (app/shell/Shortcuts.swift's Carbon part): `RegisterHotKey` for each combination
//! (keys.rs), on Margin's message window, registered all together while the shell's "active" rule holds (a
//! linked browser in front with its overlay shown) and unregistered all together otherwise, so the keys are
//! the browser's the rest of the time. WM_HOTKEY becomes a `HotKeyHit` for the shell. Windows only.
//!
//! Repeats: a key that repeats (next/previous tab and space) is registered without `MOD_NOREPEAT`, so Windows
//! sends WM_HOTKEY again at the keyboard's own repeat delay and rate while it's held; the others with it.
//! WM_HOTKEY doesn't say which is a repeat, so while a hit's key stays down (polled every 30 ms) the next
//! hits of the same combination are marked `repeat` (the copy takes repeats like presses, but a repeat never
//! starts a switch to another profile's space).
//!
//! A combination another app holds fails to register: it's reported (`Failure`) and the rest still work.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, HOT_KEY_MODIFIERS, MAPVK_VSC_TO_VK_EX, MOD_NOREPEAT, MapVirtualKeyExW,
    RegisterHotKey, UnregisterHotKey,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, WM_HOTKEY};

use crate::keys::{Combo, Key, describe};
use crate::msgwin::MessageWindow;
use crate::win::error_text;

/// One combination for one command. `id`: the shell's own number for it (below 0xBFFF, RegisterHotKey's
/// range for applications).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HotKeySpec {
    pub id: u32,
    pub combo: Combo,
    pub repeats: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HotKeyHit {
    pub id: u32,
    pub repeat: bool,
}

/// A combination that didn't register, and Windows' reason (usually: another app holds it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub id: u32,
    pub combo: Combo,
    pub why: String,
}

type OnHit = Rc<RefCell<Box<dyn FnMut(HotKeyHit)>>>;

const HELD_TIMER: usize = 0x484B; // "HK"
const HELD_POLL_MS: u32 = 30;
const MAX_ID: u32 = 0xBFFF;

#[derive(Default)]
struct Inner {
    specs: Vec<HotKeySpec>,
    /// Registered now: id → the virtual key it was registered with.
    registered: HashMap<u32, u32>,
    active: bool,
    /// The hit whose key is still down: its id and virtual key.
    held: Option<(u32, u32)>,
}

pub struct HotKeys {
    window: Weak<MessageWindow>,
    inner: Rc<RefCell<Inner>>,
}

/// The virtual key for a key in the keyboard layout of the window in front (where the keys are typed).
fn virtual_key(key: Key) -> u32 {
    match key {
        Key::Vk(vk) => vk,
        Key::Scan { scan, us_vk } => {
            // SAFETY: plain reads: the foreground window's thread (0 if none: this thread's layout), its layout,
            // and the layout's mapping of a scan code.
            let vk = unsafe {
                let thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
                MapVirtualKeyExW(scan, MAPVK_VSC_TO_VK_EX, Some(GetKeyboardLayout(thread)))
            };
            if vk == 0 { us_vk } else { vk }
        }
    }
}

fn key_down(vk: u32) -> bool {
    // SAFETY: only reads the key's state.
    unsafe { GetAsyncKeyState(vk as i32) < 0 }
}

impl HotKeys {
    /// Hot keys on `window` (none registered until `set` and `set_active`). `on_hit` runs on the UI thread.
    pub fn new(window: &Rc<MessageWindow>, on_hit: impl FnMut(HotKeyHit) + 'static) -> Self {
        let inner = Rc::new(RefCell::new(Inner::default()));
        let on_hit: OnHit = Rc::new(RefCell::new(Box::new(on_hit)));
        let weak_window = Rc::downgrade(window);
        let weak_inner = Rc::downgrade(&inner);
        window.on(WM_HOTKEY, move |wparam, _| {
            let Some(inner) = weak_inner.upgrade() else { return };
            let id = wparam.0 as u32;
            let hit = {
                let Ok(mut s) = inner.try_borrow_mut() else { return };
                let Some(&vk) = s.registered.get(&id) else { return };
                let repeat = s.held.is_some_and(|(held, _)| held == id);
                if !repeat {
                    s.held = Some((id, vk));
                }
                HotKeyHit { id, repeat }
            };
            if !hit.repeat
                && let Some(w) = weak_window.upgrade()
            {
                let inner = Rc::downgrade(&inner);
                let window = weak_window.clone();
                w.set_timer(HELD_TIMER, HELD_POLL_MS, move || {
                    let Some(inner) = inner.upgrade() else { return };
                    let Ok(mut s) = inner.try_borrow_mut() else { return };
                    let up = s.held.is_none_or(|(_, vk)| !key_down(vk));
                    if up {
                        s.held = None;
                        drop(s);
                        if let Some(w) = window.upgrade() {
                            w.kill_timer(HELD_TIMER);
                        }
                    }
                });
            }
            if let Ok(mut f) = on_hit.try_borrow_mut() {
                f(hit);
            }
        });
        Self { window: Rc::downgrade(window), inner }
    }

    /// The combinations from now on. If active, the old ones are let go and these registered.
    pub fn set(&self, specs: Vec<HotKeySpec>) -> Vec<Failure> {
        let active = self.inner.borrow().active;
        self.unregister_all();
        self.inner.borrow_mut().specs = specs;
        if active { self.register_all() } else { Vec::new() }
    }

    /// Registers every combination (on) or lets every one go (off). What failed to register is returned
    /// (only when turned on, and each time it's turned on: another app may have let a key go meanwhile).
    pub fn set_active(&self, on: bool) -> Vec<Failure> {
        if self.inner.borrow().active == on {
            return Vec::new();
        }
        if on {
            self.inner.borrow_mut().active = true;
            self.register_all()
        } else {
            self.unregister_all();
            self.inner.borrow_mut().active = false;
            Vec::new()
        }
    }

    pub fn is_active(&self) -> bool {
        self.inner.borrow().active
    }

    fn register_all(&self) -> Vec<Failure> {
        let Some(window) = self.window.upgrade() else { return Vec::new() };
        let specs = self.inner.borrow().specs.clone();
        let mut failures = Vec::new();
        for spec in specs {
            if spec.id >= MAX_ID {
                failures.push(Failure { id: spec.id, combo: spec.combo, why: "an id out of range".into() });
                continue;
            }
            let vk = virtual_key(spec.combo.key);
            let mut mods = HOT_KEY_MODIFIERS(spec.combo.modifiers);
            if !spec.repeats {
                mods |= MOD_NOREPEAT;
            }
            // SAFETY: our message window, on this thread; the id is in the application range.
            match unsafe { RegisterHotKey(Some(window.hwnd()), spec.id as i32, mods, vk) } {
                Ok(()) => {
                    self.inner.borrow_mut().registered.insert(spec.id, vk);
                }
                Err(e) => failures.push(Failure {
                    id: spec.id,
                    combo: spec.combo,
                    why: format!("{} didn't register: {}", describe(&spec.combo), error_text(e)),
                }),
            }
        }
        failures
    }

    fn unregister_all(&self) {
        let ids: Vec<u32> = self.inner.borrow_mut().registered.drain().map(|(id, _)| id).collect();
        let Some(window) = self.window.upgrade() else { return };
        for id in ids {
            // SAFETY: an id this module registered on our window.
            let _ = unsafe { UnregisterHotKey(Some(window.hwnd()), id as i32) };
        }
        self.inner.borrow_mut().held = None;
        window.kill_timer(HELD_TIMER);
    }
}

impl Drop for HotKeys {
    fn drop(&mut self) {
        self.unregister_all();
        if let Some(w) = self.window.upgrade() {
            w.off(WM_HOTKEY);
        }
    }
}
