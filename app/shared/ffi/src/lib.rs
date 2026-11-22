//! margin-core's hosting core (`margin_core::host`) behind a C interface, for shells that aren't Rust: Margin.app's
//! Swift links it as a static library (include/margin_ffi.h, include/module.modulemap: `import MarginCore`).
//!
//! Two kinds of call:
//! - `margin_host_call`: one request, JSON in, its answer JSON out (host/api.rs `Request`), on a core made by
//!   `margin_host_new`. The answer's bytes are the caller's to free with `margin_buffer_free`.
//! - `margin_layout_*`: the layout's typed calls, no JSON and no allocation (the hot path: every frame of a drag).
//!
//! Every function is safe to call with null or bad input (it answers nothing or an error), never unwinds into the
//! caller (a panic aborts, as `panic = "abort"`), and keeps no global state: each core is its own.

use margin_core::geometry::Rect;
use margin_core::host::api::HostCore;
use margin_core::host::layout::{self, Placement, Size};

/// A rectangle in points, top-left origin.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A full-screen Space's edges.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginEdges {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

/// Where a hosted window goes (host/layout.rs `Placement`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPlacement {
    pub page: MarginRect,
    pub area: MarginRect,
    pub display: MarginRect,
}

impl From<MarginRect> for Rect {
    fn from(r: MarginRect) -> Self {
        Rect::new(r.x, r.y, r.width, r.height)
    }
}
impl From<Rect> for MarginRect {
    fn from(r: Rect) -> Self {
        MarginRect { x: r.x, y: r.y, width: r.width, height: r.height }
    }
}
impl From<MarginPlacement> for Placement {
    fn from(p: MarginPlacement) -> Self {
        Placement { page: p.page.into(), area: p.area.into(), display: p.display.into() }
    }
}

/// A new hosting core (free it with `margin_host_free`).
#[unsafe(no_mangle)]
pub extern "C" fn margin_host_new() -> *mut HostCore {
    Box::into_raw(Box::new(HostCore::new()))
}

/// # Safety
/// `core` is null or a pointer `margin_host_new` returned, not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_host_free(core: *mut HostCore) {
    if !core.is_null() {
        // SAFETY: made by Box::into_raw in margin_host_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(core) });
    }
}

/// One request (`len` bytes of UTF-8 JSON) → its answer, `*out_len` bytes of UTF-8 JSON (free with
/// `margin_buffer_free`). Null: a null core or request. Bad JSON is an answer (`{"error": …}`), not a null.
///
/// # Safety
/// `core` is a live core from `margin_host_new`, used by one thread at a time; `request` points at `len` readable
/// bytes; `out_len` is writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_host_call(
    core: *mut HostCore,
    request: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if core.is_null() || request.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the caller's contract above.
    let (core, bytes) = unsafe { (&mut *core, std::slice::from_raw_parts(request, len)) };
    let answer = match std::str::from_utf8(bytes) {
        Ok(text) => core.call(text),
        Err(_) => r#"{"error":"bad request: not UTF-8"}"#.to_string(),
    };
    let boxed = answer.into_bytes().into_boxed_slice();
    // SAFETY: out_len is writable (the contract).
    unsafe { *out_len = boxed.len() };
    Box::into_raw(boxed) as *mut u8
}

/// # Safety
/// `ptr` and `len` are an answer `margin_host_call` returned, not freed yet (or a null `ptr`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_buffer_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // SAFETY: a Box<[u8]> of exactly `len` bytes made in margin_host_call.
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}

/// The edges that make a full-screen window the page area (host/layout.rs `plan`). False: none.
///
/// # Safety
/// `p` readable, `out` writable (either null: false).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_layout_plan(p: *const MarginPlacement, out: *mut MarginEdges) -> bool {
    if p.is_null() || out.is_null() {
        return false;
    }
    // SAFETY: the contract above.
    let p: Placement = unsafe { *p }.into();
    match layout::plan(&p) {
        Some(e) => {
            // SAFETY: out writable.
            unsafe { *out = MarginEdges { left: e.left, right: e.right, top: e.top, bottom: e.bottom } };
            true
        }
        None => false,
    }
}

/// A hosted window's tile rect in Margin's Space (host/layout.rs `tile`). False: none.
///
/// # Safety
/// `p` readable, `out` writable (either null: false).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_layout_tile(p: *const MarginPlacement, home: MarginRect, out: *mut MarginRect) -> bool {
    if p.is_null() || out.is_null() {
        return false;
    }
    // SAFETY: the contract above.
    let p: Placement = unsafe { *p }.into();
    match layout::tile(&p, &home.into()) {
        Some(r) => {
            // SAFETY: out writable.
            unsafe { *out = r.into() };
            true
        }
        None => false,
    }
}

/// Where a window that can't be smaller than `min_width`×`min_height` goes (host/layout.rs `fit`); a minimum of
/// zero (or less) on both sides: none.
#[unsafe(no_mangle)]
pub extern "C" fn margin_layout_fit(page: MarginRect, min_width: f64, min_height: f64, area: MarginRect) -> MarginRect {
    let min = (min_width > 0.0 || min_height > 0.0).then_some(Size::new(min_width.max(0.0), min_height.max(0.0)));
    layout::fit(&page.into(), min, &area.into()).into()
}

/// A split pane's window frame (host/layout.rs `cut`): at its minimum, at its start or end along each axis (`end_x`,
/// `end_y`: 0 its start, 1 its end, anything else away from the other panes of `page`, the split's page area); a
/// minimum of zero (or less) on both sides: none (the pane).
#[unsafe(no_mangle)]
pub extern "C" fn margin_layout_cut(
    pane: MarginRect,
    min_width: f64,
    min_height: f64,
    area: MarginRect,
    page: MarginRect,
    end_x: i8,
    end_y: i8,
) -> MarginRect {
    let min = (min_width > 0.0 || min_height > 0.0).then_some(Size::new(min_width.max(0.0), min_height.max(0.0)));
    let end = |v: i8| match v {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    layout::cut(&pane.into(), min, &area.into(), &page.into(), end(end_x), end(end_y)).into()
}

/// A frame held within the area, moved, never resized (host/layout.rs `within`).
#[unsafe(no_mangle)]
pub extern "C" fn margin_layout_within(frame: MarginRect, area: MarginRect) -> MarginRect {
    layout::within(&frame.into(), &area.into()).into()
}

/// Margin's own tile (host/layout.rs `home`). False: the display isn't known.
///
/// # Safety
/// `p` readable, `out` writable (either null: false).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_layout_home(p: *const MarginPlacement, out: *mut MarginRect) -> bool {
    if p.is_null() || out.is_null() {
        return false;
    }
    // SAFETY: the contract above.
    let p: Placement = unsafe { *p }.into();
    match layout::home(&p) {
        Some(r) => {
            // SAFETY: out writable.
            unsafe { *out = r.into() };
            true
        }
        None => false,
    }
}

/// Whether a window of these bounds is a full-screen window's strip for this placement (host/kinds.rs `is_strip`).
///
/// # Safety
/// `p` readable (null: false).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_kinds_is_strip(bounds: MarginRect, p: *const MarginPlacement) -> bool {
    if p.is_null() {
        return false;
    }
    // SAFETY: the contract above.
    let p: Placement = unsafe { *p }.into();
    margin_core::host::kinds::is_strip(&bounds.into(), &p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(core: *mut HostCore, request: &str) -> String {
        let mut len = 0usize;
        // SAFETY: a live core, a valid buffer, a writable len.
        let ptr = unsafe { margin_host_call(core, request.as_ptr(), request.len(), &mut len) };
        assert!(!ptr.is_null());
        // SAFETY: the answer's bytes, freed right after.
        let text = unsafe { String::from_utf8(std::slice::from_raw_parts(ptr, len).to_vec()).unwrap() };
        unsafe { margin_buffer_free(ptr, len) };
        text
    }

    #[test]
    fn a_core_answers_and_frees() {
        let core = margin_host_new();
        let answer = call(core, r#"{"type":"react","now":0,"host":"h","key":"k"}"#);
        assert_eq!(answer, r#"{"verdict":"go"}"#);
        assert!(call(core, "not json").contains("error"));
        assert!(call(core, "").contains("error"));
        let mut len = 0usize;
        // Null inputs: a null answer, nothing read.
        unsafe {
            assert!(margin_host_call(std::ptr::null_mut(), b"{}".as_ptr(), 2, &mut len).is_null());
            assert!(margin_host_call(core, std::ptr::null(), 0, &mut len).is_null());
            margin_buffer_free(std::ptr::null_mut(), 0);
            margin_host_free(core);
            margin_host_free(std::ptr::null_mut());
        }
    }

    #[test]
    fn not_utf8_is_an_error_answer() {
        let core = margin_host_new();
        let bytes = [0xff_u8, 0xfe];
        let mut len = 0usize;
        unsafe {
            let ptr = margin_host_call(core, bytes.as_ptr(), bytes.len(), &mut len);
            let text = String::from_utf8(std::slice::from_raw_parts(ptr, len).to_vec()).unwrap();
            assert!(text.contains("not UTF-8"));
            margin_buffer_free(ptr, len);
            margin_host_free(core);
        }
    }

    #[test]
    fn the_layout_calls() {
        let p = MarginPlacement {
            page: MarginRect { x: 248.0, y: 41.0, width: 1256.0, height: 933.0 },
            area: MarginRect { x: 0.0, y: 33.0, width: 1512.0, height: 949.0 },
            display: MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 },
        };
        let (mut edges, mut home, mut tile) = (MarginEdges::default(), MarginRect::default(), MarginRect::default());
        unsafe {
            assert!(margin_layout_plan(&p, &mut edges));
            assert!(margin_layout_home(&p, &mut home));
            assert!(margin_layout_tile(&p, home, &mut tile));
            assert!(!margin_layout_plan(std::ptr::null(), &mut edges));
        }
        assert_eq!(edges, MarginEdges { left: 248.0, right: 8.0, top: 8.0, bottom: 8.0 });
        assert_eq!(tile, MarginRect { x: 248.0, y: 8.0, width: 1256.0, height: 966.0 });
        let page = MarginRect { x: 504.0, y: 41.0, width: 1000.0, height: 933.0 };
        assert_eq!(margin_layout_fit(page, 0.0, 0.0, p.area), page);
        let strip = MarginRect { x: 0.0, y: 33.0, width: 1512.0, height: 88.0 };
        unsafe {
            assert!(margin_kinds_is_strip(strip, &p));
            assert!(!margin_kinds_is_strip(page, &p));
            assert!(!margin_kinds_is_strip(strip, std::ptr::null()));
        }
        assert_eq!(
            margin_layout_fit(page, 1048.0, 640.0, p.area),
            MarginRect { x: 456.0, y: 41.0, width: 1048.0, height: 933.0 }
        );
        let right = MarginRect { x: 876.0, y: 41.0, width: 628.0, height: 933.0 };
        let page = MarginRect { x: 240.0, y: 41.0, width: 1264.0, height: 933.0 };
        assert_eq!(margin_layout_cut(right, 0.0, 0.0, p.area, page, -1, -1), right);
        assert_eq!(
            margin_layout_cut(right, 701.0, 53.0, p.area, page, 1, 0),
            MarginRect { x: 803.0, y: 41.0, width: 701.0, height: 933.0 }
        );
        assert_eq!(
            margin_layout_cut(right, 701.0, 53.0, p.area, page, -1, -1),
            MarginRect { x: 876.0, y: 41.0, width: 701.0, height: 933.0 },
            "not asked: past the page's end, the display's edge"
        );
        assert_eq!(
            margin_layout_within(MarginRect { x: 876.0, y: 41.0, width: 701.0, height: 933.0 }, p.area),
            MarginRect { x: 811.0, y: 41.0, width: 701.0, height: 933.0 }
        );
    }
}
