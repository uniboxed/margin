//! The visible windows' order (host/model/order.rs, step 2 part 2) on a hosting core. The plan is JSON
//! (`margin_host_call`: frontPlan), once a fronting; what's read around it is typed: the order wanted (to read each
//! window's bounds), the window server's order of those windows, and whether the focused one is behind a host it
//! overlaps (read every few milliseconds while it's waited for), nothing allocated.

use margin_core::host::api::HostCore;
use margin_core::host::model::{self, Handle};

/// # Safety
/// `ptr` null or `len` readable values.
unsafe fn slice<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if ptr.is_null() || len == 0 {
        return &[];
    }
    // SAFETY: the caller's contract.
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

/// The visible hosts in the order wanted, back to front, into `out`; how many. The hosts it read a minimum of as
/// their app's kept one with their version unread are noted (`margin_model_versions_wanted`).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_front_wanted(core: *mut HostCore, out: *mut u32, cap: usize) -> usize {
    // SAFETY: the contract above.
    let Some(c) = (unsafe { core.as_mut() }) else { return 0 };
    c.model.versions_clear();
    let out: &mut [Handle] = if out.is_null() || cap == 0 {
        &mut []
    } else {
        // SAFETY: the contract above.
        unsafe { std::slice::from_raw_parts_mut(out, cap) }
    };
    c.model.front_wanted(out)
}

/// `windows` (back to front as wanted) in the window server's order, back to front, from its on-screen list (front
/// to back; null: unread), into `out`; how many, or -1: unread or one of them not listed.
///
/// # Safety
/// `windows` null or `n` readable; `screen` null or `m` readable; `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_order_server(
    windows: *const i64,
    n: usize,
    screen: *const i64,
    m: usize,
    out: *mut i64,
    cap: usize,
) -> i64 {
    if screen.is_null() {
        return -1;
    }
    let out: &mut [i64] = if out.is_null() || cap == 0 {
        &mut []
    } else {
        // SAFETY: the contract above.
        unsafe { std::slice::from_raw_parts_mut(out, cap) }
    };
    // SAFETY: the contract above.
    model::server_order(unsafe { slice(windows, n) }, unsafe { slice(screen, m) }, out).map_or(-1, |k| k as i64)
}

/// Whether the focused one (the last of `windows`, back to front as wanted) is behind a host it overlaps (`below`, by
/// place in `windows`) in the window server's on-screen list (front to back; null: unread, not behind).
///
/// # Safety
/// `windows` null or `n` readable; `below` null or `k` readable; `screen` null or `m` readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_order_top_behind(
    windows: *const i64,
    n: usize,
    below: *const u32,
    k: usize,
    screen: *const i64,
    m: usize,
) -> bool {
    // SAFETY: the contract above.
    let (windows, below) = (unsafe { slice(windows, n) }, unsafe { slice(below, k) });
    let mut idx = [0usize; 16];
    let k = below.len().min(idx.len());
    for (i, b) in below[..k].iter().enumerate() {
        idx[i] = *b as usize;
    }
    // SAFETY: the contract above.
    let screen = (!screen.is_null()).then(|| unsafe { slice(screen, m) });
    model::top_behind(windows, &idx[..k], screen)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_order_typed() {
        let mut out = [0i64; 4];
        // SAFETY: valid buffers.
        unsafe {
            assert_eq!(
                margin_order_server([10i64, 11].as_ptr(), 2, [11i64, 5, 10].as_ptr(), 3, out.as_mut_ptr(), 4),
                2
            );
            assert_eq!(&out[..2], &[10, 11]);
            assert_eq!(margin_order_server([10i64, 11].as_ptr(), 2, std::ptr::null(), 0, out.as_mut_ptr(), 4), -1);
            assert!(margin_order_top_behind([10i64, 11].as_ptr(), 2, [0u32].as_ptr(), 1, [10i64, 11].as_ptr(), 2));
            assert!(!margin_order_top_behind([10i64, 11].as_ptr(), 2, [0u32].as_ptr(), 1, [11i64, 10].as_ptr(), 2));
            assert!(!margin_order_top_behind([10i64, 11].as_ptr(), 2, [0u32].as_ptr(), 1, std::ptr::null(), 0));
            assert_eq!(margin_model_front_wanted(std::ptr::null_mut(), std::ptr::null_mut(), 0), 0);
        }
    }
}
