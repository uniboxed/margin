//! Cut panes and a host's window frame (host/model/panes.rs, step 2 part 3) on a hosting core, typed: `frame` is
//! asked per follower per frame of a drag and every few milliseconds of a placing's wait, the rest per operation and
//! per poll, so no JSON and nothing allocated. Each reading call forgets the hosts noted before it and notes those whose
//! minimum it read as their app's kept one with their version unread (`margin_model_versions_wanted`: the shell
//! reads their versions, sets them, asks again). Every call takes a null core, an unknown handle or null pointers
//! without harm.

use margin_core::host::api::HostCore;
use margin_core::host::model::{Handle, HostModel};

use crate::{MarginPlacement, MarginRect};

/// The model of a live core (None: null), its noted versions forgotten when `fresh`.
///
/// # Safety
/// `core` null or a live core from `margin_host_new`, used by one thread at a time.
unsafe fn model<'a>(core: *mut HostCore, fresh: bool) -> Option<&'a mut HostModel> {
    // SAFETY: the caller's contract.
    let m = &mut unsafe { core.as_mut() }?.model;
    if fresh {
        m.versions_clear();
    }
    Some(m)
}

/// # Safety
/// `p` null or readable.
unsafe fn placement(p: *const MarginPlacement) -> Option<margin_core::host::layout::Placement> {
    // SAFETY: the caller's contract.
    unsafe { p.as_ref() }.map(|p| (*p).into())
}

/// # Safety
/// `r` null or readable.
unsafe fn rect(r: *const MarginRect) -> Option<margin_core::geometry::Rect> {
    // SAFETY: the caller's contract.
    unsafe { r.as_ref() }.map(|r| (*r).into())
}

/// # Safety
/// `out` null or writable.
unsafe fn put<T>(out: *mut T, v: T) {
    if !out.is_null() {
        // SAFETY: the caller's contract.
        unsafe { *out = v };
    }
}

/// # Safety
/// `ptr` null or `len` readable values.
unsafe fn slice<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if ptr.is_null() || len == 0 {
        return &[];
    }
    // SAFETY: the caller's contract.
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

/// # Safety
/// `ptr` null or `cap` writable values.
unsafe fn slice_mut<'a, T>(ptr: *mut T, cap: usize) -> &'a mut [T] {
    if ptr.is_null() || cap == 0 {
        return &mut [];
    }
    // SAFETY: the caller's contract.
    unsafe { std::slice::from_raw_parts_mut(ptr, cap) }
}

/// The page area of a drag being followed (`page` null: none under way).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `page` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set_live_page(core: *mut HostCore, page: *const MarginRect) {
    // SAFETY: the contract above.
    let (Some(m), r) = (unsafe { model(core, false) }, unsafe { rect(page) }) else { return };
    m.set_live_page(r);
}

/// The hosts the last reading call noted (their minimum read as their app's kept one, their version unread) into
/// `out`; how many.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_versions_wanted(core: *mut HostCore, out: *mut u32, cap: usize) -> usize {
    // SAFETY: the contract above.
    let Some(m) = (unsafe { model(core, false) }) else { return 0 };
    // SAFETY: the contract above.
    m.versions_wanted(unsafe { slice_mut(out, cap) })
}

/// Where a host's window goes for a page area (`p` null: its own placement) into `out`.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `p` null or readable; `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_frame(
    core: *mut HostCore,
    h: Handle,
    p: *const MarginPlacement,
    out: *mut MarginRect,
) {
    // SAFETY: the contract above.
    let Some(m) = (unsafe { model(core, true) }) else { return };
    // SAFETY: the contract above.
    let r = m.frame(h, unsafe { placement(p) }.as_ref());
    // SAFETY: the contract above.
    unsafe { put(out, r.into()) };
}

/// Its placement with its window's frame for its page area (`p` null: its own), or (`entry`) as its own full-screen
/// Space reserves it, into `out`.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `p` null or readable; `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_fitted(
    core: *mut HostCore,
    h: Handle,
    p: *const MarginPlacement,
    entry: bool,
    out: *mut MarginPlacement,
) {
    // SAFETY: the contract above.
    let Some(m) = (unsafe { model(core, true) }) else { return };
    // SAFETY: the contract above.
    let f = if entry { m.entry_fitted(h) } else { m.fitted(h, unsafe { placement(p) }.as_ref()) };
    // SAFETY: the contract above.
    unsafe { put(out, f.into()) };
}

/// Its tile's rect for a page area (`p` null: its own) from Margin's own tile `home` into `out`; false: none.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `p` null or readable; `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_tile_rect(
    core: *mut HostCore,
    h: Handle,
    p: *const MarginPlacement,
    home: MarginRect,
    out: *mut MarginRect,
) -> bool {
    // SAFETY: the contract above.
    let Some(m) = (unsafe { model(core, true) }) else { return false };
    // SAFETY: the contract above.
    let Some(r) = m.tile_rect(h, unsafe { placement(p) }.as_ref(), &home.into()) else { return false };
    // SAFETY: the contract above.
    unsafe { put(out, r.into()) };
    true
}

/// Whether a visible pane's window is wider or taller than its pane.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_is_cut(core: *mut HostCore, h: Handle) -> bool {
    // SAFETY: the contract above.
    unsafe { model(core, true) }.is_some_and(|m| m.is_cut(h))
}

/// The visible panes a cut pane's window (at `at`, null: its frame) lies under, back to front, into `out`; how many.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `at` null or readable; `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_lying_under(
    core: *mut HostCore,
    h: Handle,
    at: *const MarginRect,
    out: *mut u32,
    cap: usize,
) -> usize {
    // SAFETY: the contract above.
    let Some(m) = (unsafe { model(core, true) }) else { return 0 };
    // SAFETY: the contract above.
    m.lying_under(h, unsafe { rect(at) }, unsafe { slice_mut(out, cap) })
}

/// Whether a cut pane's window (at `at`, null: its frame) lies under another visible pane.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `at` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_tucked(core: *mut HostCore, h: Handle, at: *const MarginRect) -> bool {
    // SAFETY: the contract above.
    unsafe { model(core, true) }.is_some_and(|m| m.tucked(h, unsafe { rect(at) }))
}

/// Whether a visible cut pane's window is over a pane it lies under in the on-screen list (window numbers, front to
/// back).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `list` null or `n` readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_over_under(core: *mut HostCore, h: Handle, list: *const i64, n: usize) -> bool {
    // SAFETY: the contract above.
    unsafe { model(core, true) }.is_some_and(|m| m.over_under(h, unsafe { slice(list, n) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{margin_host_free, margin_host_new, margin_model_add, margin_model_list, margin_model_set};
    use crate::{margin_model_layout_set, margin_model_set_placement, margin_model_set_rect};

    #[test]
    fn a_cut_pane_typed() {
        let core = margin_host_new();
        let page = MarginRect { x: 276.0, y: 41.0, width: 1228.0, height: 933.0 };
        let area = MarginRect { x: 0.0, y: 33.0, width: 1512.0, height: 949.0 };
        let p = MarginPlacement { page, area, display: MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 } };
        let left = MarginRect { width: 610.0, ..page };
        let right = MarginRect { x: 894.0, width: 610.0, ..page };
        let mut hs = [0u32; 2];
        // SAFETY: a live core, valid buffers.
        unsafe {
            margin_model_set_placement(core, &p);
            for (i, (id, r)) in [("edit", left), ("notes", right)].into_iter().enumerate() {
                let h = margin_model_add(core, id.as_ptr(), id.len(), id.as_ptr(), id.len(), 10 + i as i64, 1);
                margin_model_list(core, id.as_ptr(), id.len(), h);
                margin_model_set(core, h, 3, 1); // shown
                margin_model_set(core, h, 2, 1); // a pane
                margin_model_set(core, h, 7, 1); // a tile
                margin_model_set_rect(core, h, 64, &r);
                let v = crate::MarginVisible { rect: r, has_rect: true, role: 1, z: i as i64 };
                margin_model_layout_set(core, id.as_ptr(), id.len(), &v);
                hs[i] = h;
            }
            margin_model_set_rect(core, hs[1], 66, &MarginRect { x: 0.0, y: 0.0, width: 700.0, height: 400.0 });
            let mut f = MarginRect::default();
            margin_model_frame(core, hs[1], std::ptr::null(), &mut f);
            assert_eq!(f, MarginRect { x: 894.0, width: 700.0, ..page });
            assert!(margin_model_is_cut(core, hs[1]));
            assert!(!margin_model_is_cut(core, hs[0]));
            assert!(!margin_model_tucked(core, hs[1], std::ptr::null()));
            let mut out = [0u32; 4];
            assert_eq!(
                margin_model_lying_under(
                    core,
                    hs[1],
                    &MarginRect { x: 804.0, width: 700.0, ..page },
                    out.as_mut_ptr(),
                    4
                ),
                1
            );
            assert_eq!(out[0], hs[0]);
            assert!(!margin_model_over_under(core, hs[1], [11i64, 10].as_ptr(), 2));
            let mut q = MarginPlacement::default();
            margin_model_fitted(core, hs[1], std::ptr::null(), true, &mut q);
            assert_eq!(q.page, MarginRect { x: 812.0, width: 700.0, ..page });
            assert!(margin_model_tile_rect(core, hs[1], std::ptr::null(), p.display, &mut f));
            margin_model_set_live_page(core, &left);
            margin_model_set_live_page(core, std::ptr::null());
            assert_eq!(margin_model_versions_wanted(core, out.as_mut_ptr(), 4), 0);
            // A null core: nothing, no harm.
            margin_model_frame(std::ptr::null_mut(), 0, std::ptr::null(), std::ptr::null_mut());
            assert!(!margin_model_is_cut(std::ptr::null_mut(), 0));
            margin_host_free(core);
        }
    }
}
