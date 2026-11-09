//! What the OS's window server says about windows (app/shell/WindowServer.swift `ServerWindow`), the same on
//! every OS: each shell reads its own (CGWindowListCopyWindowInfo on the Mac, EnumWindows and DWM on Windows)
//! and hands the binder these.

use crate::geometry::Rect;

/// One top-level window. `number` is the OS's id for it (CGWindowID; an HWND's value on Windows).
#[derive(Clone, Debug, PartialEq)]
pub struct ServerWindow {
    pub number: i64,
    pub pid: u32,
    /// The window's layer (0: normal windows; Windows: 1 for topmost).
    pub layer: i32,
    /// Top-left origin, in points (as the browser's `windows.get` reports bounds).
    pub bounds: Rect,
    pub on_screen: bool,
    pub alpha: f64,
    /// Its place in the list, front to back: lower is nearer the front.
    pub order: usize,
}

impl ServerWindow {
    pub fn new(number: i64, pid: u32, bounds: Rect) -> Self {
        Self { number, pid, layer: 0, bounds, on_screen: true, alpha: 1.0, order: 0 }
    }
}

/// Where a shell reads its windows from (WindowServer.swift `WindowSource`).
pub trait WindowSource {
    /// Every window of these processes, plus the on-screen windows above them (all processes), front to back.
    /// The overlays' own windows included. `None`: the OS gave no list at all (not the same as an empty one).
    fn read(&self, pids: &std::collections::HashSet<u32>) -> Option<Vec<ServerWindow>>;
    /// The on-screen windows in front of `window`, front to back. `None`: can't say.
    fn above(&self, _window: i64) -> Option<Vec<ServerWindow>> {
        None
    }
}
