//! The hosts' model (host/model.rs) on a hosting core, typed: a host's handle, its fields read and written by number
//! (host/model.rs `Field`). Nothing here allocates but `margin_model_add` (a host's first open) and a list of times
//! set longer than its room; every call takes a null core or an unknown handle without harm.

use margin_core::geometry::Rect;
use margin_core::host::api::HostCore;
use margin_core::host::model::{Field, Handle};

use crate::MarginRect;

/// No host (`margin_model_add`'s answer for bad input).
pub const MARGIN_MODEL_NONE: u32 = u32::MAX;

/// # Safety
/// `core` null or a live core from `margin_host_new`, used by one thread at a time.
unsafe fn model<'a>(core: *mut HostCore) -> Option<&'a mut HostCore> {
    // SAFETY: the caller's contract.
    unsafe { core.as_mut() }
}

/// # Safety
/// `ptr` null or `len` readable bytes.
unsafe fn text<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() {
        return (len == 0).then_some("");
    }
    // SAFETY: the caller's contract.
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).ok()
}

/// A new host (its id and its app's key, UTF-8; its window and pid) → its handle; `MARGIN_MODEL_NONE`: a null core
/// or text that isn't UTF-8.
///
/// # Safety
/// `core` a live core (one thread at a time); `id`, `app` null or their lengths' readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_add(
    core: *mut HostCore,
    id: *const u8,
    id_len: usize,
    app: *const u8,
    app_len: usize,
    window: i64,
    pid: i64,
) -> u32 {
    // SAFETY: the contract above.
    let (Some(core), Some(id), Some(app)) =
        (unsafe { model(core) }, unsafe { text(id, id_len) }, unsafe { text(app, app_len) })
    else {
        return MARGIN_MODEL_NONE;
    };
    core.model.add(id, app, window, pid)
}

/// The host gone: its handle free for another.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_remove(core: *mut HostCore, h: Handle) {
    // SAFETY: the contract above.
    if let Some(core) = unsafe { model(core) } {
        core.model.remove(h);
    }
}

/// A whole number or a flag (0: none such).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_get(core: *mut HostCore, h: Handle, field: u32) -> i64 {
    // SAFETY: the contract above.
    match (unsafe { model(core) }, Field::from_u32(field)) {
        (Some(core), Some(f)) => core.model.int(h, f),
        _ => 0,
    }
}

/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set(core: *mut HostCore, h: Handle, field: u32, value: i64) {
    // SAFETY: the contract above.
    if let (Some(core), Some(f)) = (unsafe { model(core) }, Field::from_u32(field)) {
        core.model.set_int(h, f, value);
    }
}

/// A time or a length (NaN: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_get_real(core: *mut HostCore, h: Handle, field: u32) -> f64 {
    // SAFETY: the contract above.
    match (unsafe { model(core) }, Field::from_u32(field)) {
        (Some(core), Some(f)) => core.model.real(h, f).unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// Sets a time or a length (NaN: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set_real(core: *mut HostCore, h: Handle, field: u32, value: f64) {
    // SAFETY: the contract above.
    if let (Some(core), Some(f)) = (unsafe { model(core) }, Field::from_u32(field)) {
        core.model.set_real(h, f, (!value.is_nan()).then_some(value));
    }
}

/// A rect into `out`; false: none (`out` untouched).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null (false) or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_get_rect(
    core: *mut HostCore,
    h: Handle,
    field: u32,
    out: *mut MarginRect,
) -> bool {
    if out.is_null() {
        return false;
    }
    // SAFETY: the contract above.
    let Some(r) = (match (unsafe { model(core) }, Field::from_u32(field)) {
        (Some(core), Some(f)) => core.model.rect(h, f),
        _ => None,
    }) else {
        return false;
    };
    // SAFETY: out writable.
    unsafe { *out = r.into() };
    true
}

/// Sets a rect (`value` null: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `value` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set_rect(core: *mut HostCore, h: Handle, field: u32, value: *const MarginRect) {
    // SAFETY: the contract above.
    if let (Some(core), Some(f)) = (unsafe { model(core) }, Field::from_u32(field)) {
        // SAFETY: value null or readable.
        let v: Option<Rect> = unsafe { value.as_ref() }.map(|r| (*r).into());
        core.model.set_rect(h, f, v);
    }
}

/// A list of times: how many it has; the first `cap` of them written into `out`.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null (with `cap` 0) or `cap` writable doubles.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_times(
    core: *mut HostCore,
    h: Handle,
    field: u32,
    out: *mut f64,
    cap: usize,
) -> usize {
    // SAFETY: the contract above.
    let list = match (unsafe { model(core) }, Field::from_u32(field)) {
        (Some(core), Some(f)) => core.model.times(h, f),
        _ => return 0,
    };
    if !out.is_null() {
        let n = list.len().min(cap);
        // SAFETY: out holds cap doubles; n <= cap.
        unsafe { std::ptr::copy_nonoverlapping(list.as_ptr(), out, n) };
    }
    list.len()
}

/// Sets a list of times (`len` of them from `values`; null with 0: empty).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `values` null (with `len` 0) or `len` readable doubles.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set_times(
    core: *mut HostCore,
    h: Handle,
    field: u32,
    values: *const f64,
    len: usize,
) {
    // SAFETY: the contract above.
    if let (Some(core), Some(f)) = (unsafe { model(core) }, Field::from_u32(field)) {
        let v: &[f64] = if values.is_null() || len == 0 {
            &[]
        } else {
            // SAFETY: values holds len doubles.
            unsafe { std::slice::from_raw_parts(values, len) }
        };
        core.model.set_times(h, f, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{margin_host_free, margin_host_new};

    #[test]
    fn a_host_by_its_handle() {
        let core = margin_host_new();
        let id = "app:com.apple.TextEdit";
        unsafe {
            let h = margin_model_add(core, id.as_ptr(), id.len(), id.as_ptr().add(4), id.len() - 4, 41, 500);
            assert_ne!(h, MARGIN_MODEL_NONE);
            assert_eq!(margin_model_get(core, h, Field::Window as u32), 41);
            assert_eq!(margin_model_get(core, h, Field::Pid as u32), 500);
            assert_eq!((*core).model.get(h).unwrap().app, "com.apple.TextEdit");
            margin_model_set(core, h, Field::Unread as u32, 2);
            assert_eq!(margin_model_get(core, h, Field::Unread as u32), 2);
            assert!(margin_model_get_real(core, h, Field::GoneAt as u32).is_nan());
            margin_model_set_real(core, h, Field::GoneAt as u32, 7.25);
            assert_eq!(margin_model_get_real(core, h, Field::GoneAt as u32), 7.25);
            margin_model_set_real(core, h, Field::GoneAt as u32, f64::NAN);
            assert!(margin_model_get_real(core, h, Field::GoneAt as u32).is_nan());
            let mut r = MarginRect::default();
            assert!(!margin_model_get_rect(core, h, Field::Rect as u32, &mut r));
            let pane = MarginRect { x: 876.0, y: 41.0, width: 628.0, height: 933.0 };
            margin_model_set_rect(core, h, Field::Rect as u32, &pane);
            assert!(margin_model_get_rect(core, h, Field::Rect as u32, &mut r));
            assert_eq!(r, pane);
            margin_model_set_rect(core, h, Field::Rect as u32, std::ptr::null());
            assert!(!margin_model_get_rect(core, h, Field::Rect as u32, &mut r));
            let times = [1.0, 2.0, 3.0];
            margin_model_set_times(core, h, Field::Returns as u32, times.as_ptr(), times.len());
            let mut out = [0.0; 2];
            assert_eq!(
                margin_model_times(core, h, Field::Returns as u32, out.as_mut_ptr(), out.len()),
                3,
                "all counted"
            );
            assert_eq!(out, [1.0, 2.0], "as many as fit");
            assert_eq!(margin_model_times(core, h, Field::Returns as u32, std::ptr::null_mut(), 0), 3);
            margin_model_set_times(core, h, Field::Returns as u32, std::ptr::null(), 0);
            assert_eq!(margin_model_times(core, h, Field::Returns as u32, out.as_mut_ptr(), 2), 0);
            // Unknown fields, unknown handles, a null core: nothing, no harm.
            assert_eq!(margin_model_get(core, h, 999), 0);
            margin_model_set(core, h, 999, 1);
            assert_eq!(margin_model_get(core, h + 7, Field::Window as u32), 0);
            assert_eq!(margin_model_get(std::ptr::null_mut(), h, Field::Window as u32), 0);
            assert!(!margin_model_get_rect(core, h, Field::Rect as u32, std::ptr::null_mut()));
            assert_eq!(
                margin_model_add(std::ptr::null_mut(), id.as_ptr(), id.len(), id.as_ptr(), 0, 1, 1),
                MARGIN_MODEL_NONE
            );
            let bad = [0xff_u8];
            assert_eq!(margin_model_add(core, bad.as_ptr(), 1, id.as_ptr(), 0, 1, 1), MARGIN_MODEL_NONE);
            margin_model_remove(core, h);
            assert_eq!(margin_model_get(core, h, Field::Unread as u32), 0, "gone");
            margin_model_remove(std::ptr::null_mut(), h);
            margin_host_free(core);
        }
    }
}
