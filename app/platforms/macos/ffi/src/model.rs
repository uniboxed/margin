//! The hosts' model (host/model.rs) on a hosting core, typed: a host's handle, its fields read and written by number
//! (host/model.rs `Field`). Nothing here allocates but `margin_model_add` (a host's first open) and a list of times
//! set longer than its room; every call takes a null core or an unknown handle without harm.

use margin_core::geometry::Rect;
use margin_core::host::api::HostCore;
use margin_core::host::model::{Field, Handle, Learnt, Minimum, MinimumOf};

use crate::{MarginRect, MarginSize};

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

// ---- the minimums (host/minimums.rs, part 5): typed, read per frame of a drag (a pane's minimum) ----

/// Its process's app version (UTF-8), as the OS side read it.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `v` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set_version(core: *mut HostCore, h: Handle, v: *const u8, len: usize) {
    // SAFETY: the contract above.
    if let (Some(core), Some(v)) = (unsafe { model(core) }, unsafe { text(v, len) }) {
        core.model.set_version(h, v);
    }
}

/// A host's minimum (`of` 0: a pane's, its own else its app's; 1: a target's known one, none in window mode) into
/// `out`: 0 none, 1 known, 2 its app's kept one with its version not read yet (`out` holds it: read the version,
/// `margin_model_set_version`, ask again; unreadable, it holds).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_minimum(core: *mut HostCore, h: Handle, of: u8, out: *mut MarginSize) -> u8 {
    // SAFETY: the contract above.
    let Some(core) = (unsafe { model(core) }) else { return 0 };
    let of = if of == 1 { MinimumOf::Known } else { MinimumOf::Pane };
    let m = core.model.minimum(h, of);
    if let (Some(s), false) = (m.size(), out.is_null()) {
        // SAFETY: out writable.
        unsafe { *out = s.into() };
    }
    match m {
        Minimum::None => 0,
        Minimum::Known(_) => 1,
        Minimum::NeedsVersion(_) => 2,
    }
}

/// Its tile's minimum as just read (`read` null: it said none): 0 nothing new, 1 its own from now (rounded up), 2 the
/// tile said none, one read before kept: say it (once).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `read` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_learn_min(core: *mut HostCore, h: Handle, read: *const MarginSize) -> u8 {
    // SAFETY: the contract above.
    let Some(core) = (unsafe { model(core) }) else { return 0 };
    // SAFETY: read null or readable.
    let read = unsafe { read.as_ref() }.map(|s| (*s).into());
    match core.model.learn_min(h, read) {
        Learnt::Same => 0,
        Learnt::Changed => 1,
        Learnt::UnreadSay => 2,
    }
}

/// Its own minimum kept as its app's for `version` (null: unread, kept as "?"): true when new (save, say, tell).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `version` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_remember_min(
    core: *mut HostCore,
    h: Handle,
    version: *const u8,
    len: usize,
) -> bool {
    // SAFETY: the contract above.
    let Some(core) = (unsafe { model(core) }) else { return false };
    // SAFETY: the contract above.
    let v = if version.is_null() { None } else { unsafe { text(version, len) } };
    core.model.remember_min(h, v)
}

/// The width its window was seen holding in its tile (the narrowest kept).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_held(core: *mut HostCore, h: Handle, width: f64) {
    // SAFETY: the contract above.
    if let Some(core) = unsafe { model(core) } {
        core.model.held(h, width);
    }
}

/// It left its tile with no minimum said: the narrowest it held taken for its minimum width; that width (NaN: none
/// taken).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_learn_from_leaving(core: *mut HostCore, h: Handle) -> f64 {
    // SAFETY: the contract above.
    unsafe { model(core) }.and_then(|c| c.model.learn_from_leaving(h)).unwrap_or(f64::NAN)
}

/// Whether a minimum is kept for `app` (any version).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `app` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_minimums_has(core: *mut HostCore, app: *const u8, len: usize) -> bool {
    // SAFETY: the contract above.
    match (unsafe { model(core) }, unsafe { text(app, len) }) {
        (Some(core), Some(app)) => core.model.minimums.has(app),
        _ => false,
    }
}

/// `app`'s kept minimum for the version running (`version` null: not known) into `out`; false: none.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `app`, `version` null or their lengths' readable bytes; `out`
/// null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_minimums_known(
    core: *mut HostCore,
    app: *const u8,
    app_len: usize,
    version: *const u8,
    version_len: usize,
    out: *mut MarginSize,
) -> bool {
    // SAFETY: the contract above.
    let (Some(core), Some(app)) = (unsafe { model(core) }, unsafe { text(app, app_len) }) else { return false };
    // SAFETY: the contract above.
    let v = if version.is_null() { None } else { unsafe { text(version, version_len) } };
    let Some(s) = core.model.minimums.known(app, v) else { return false };
    if !out.is_null() {
        // SAFETY: out writable.
        unsafe { *out = s.into() };
    }
    true
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

    #[test]
    fn minimums_typed() {
        let core = margin_host_new();
        let (id, app, v) = ("app:com.apple.Notes", "com.apple.Notes", "4.12 (2700)");
        unsafe {
            let h = margin_model_add(core, id.as_ptr(), id.len(), app.as_ptr(), app.len(), 41, 500);
            let mut out = MarginSize::default();
            assert_eq!(margin_model_minimum(core, h, 0, &mut out), 0);
            assert!(!margin_minimums_has(core, app.as_ptr(), app.len()));
            assert_eq!(margin_model_learn_min(core, h, &MarginSize { width: 699.5, height: 400.0 }), 1);
            assert_eq!(margin_model_learn_min(core, h, std::ptr::null()), 2);
            assert_eq!(margin_model_learn_min(core, h, std::ptr::null()), 0);
            assert!(margin_model_remember_min(core, h, v.as_ptr(), v.len()));
            assert!(!margin_model_remember_min(core, h, v.as_ptr(), v.len()));
            assert!(margin_minimums_has(core, app.as_ptr(), app.len()));
            assert!(margin_minimums_known(core, app.as_ptr(), app.len(), v.as_ptr(), v.len(), &mut out));
            assert_eq!(out, MarginSize { width: 700.0, height: 400.0 });
            let other = "4.13";
            assert!(!margin_minimums_known(core, app.as_ptr(), app.len(), other.as_ptr(), other.len(), &mut out));
            assert!(margin_minimums_known(core, app.as_ptr(), app.len(), std::ptr::null(), 0, &mut out));
            // A second window of it: its app's, once its version is read.
            let g = margin_model_add(core, id.as_ptr(), id.len(), app.as_ptr(), app.len(), 42, 501);
            assert_eq!(margin_model_minimum(core, g, 1, &mut out), 2);
            margin_model_set_version(core, g, other.as_ptr(), other.len());
            assert_eq!(margin_model_minimum(core, g, 1, &mut out), 0);
            margin_model_held(core, g, 640.2);
            assert_eq!(margin_model_learn_from_leaving(core, g), 640.2);
            assert!(margin_model_learn_from_leaving(core, g).is_nan());
            assert_eq!(margin_model_minimum(core, g, 1, &mut out), 1);
            assert_eq!(out, MarginSize { width: 641.0, height: 0.0 });
            // A null core: nothing, no harm.
            assert_eq!(margin_model_minimum(std::ptr::null_mut(), g, 0, &mut out), 0);
            assert!(!margin_minimums_has(std::ptr::null_mut(), app.as_ptr(), app.len()));
            margin_host_free(core);
        }
    }
}
