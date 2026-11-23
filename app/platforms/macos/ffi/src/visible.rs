//! The layout's decisions (host/model/visible.rs, step 2 part 1b) on a hosting core, typed: read dozens of times an
//! operation and every poll (the visible hosts, a host's page area, whether one is visible), so no JSON and nothing
//! allocated. Ids are UTF-8 bytes; a host by its handle. The rare steps (a layout's start, its refusals) are JSON
//! (`margin_host_call`: layoutRefuse, layoutBegin, layout, configure). Every call takes a null core, an unknown
//! handle or bad text without harm.

use margin_core::host::api::HostCore;
use margin_core::host::layout::{self, Placement, Size};
use margin_core::host::model::{BringIn, BringInFacts, BringInPoint, Handle, HoldKind, Role, ShownSet, Visible};

use crate::{MARGIN_MODEL_NONE, MarginPlacement, MarginRect};

/// A host in Margin's page area (host/model/visible.rs `Visible`): its rect (`has_rect` false: the page area), its
/// role (0 main, 1 pane, 2 card), its place back to front.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginVisible {
    pub rect: MarginRect,
    pub has_rect: bool,
    pub role: u8,
    pub z: i64,
}

fn role(v: u8) -> Role {
    match v {
        1 => Role::Pane,
        2 => Role::Card,
        _ => Role::Main,
    }
}

impl From<MarginVisible> for Visible {
    fn from(v: MarginVisible) -> Self {
        Visible { rect: v.has_rect.then(|| v.rect.into()), role: role(v.role), z: v.z }
    }
}
impl From<Visible> for MarginVisible {
    fn from(v: Visible) -> Self {
        MarginVisible {
            rect: v.rect.map(Into::into).unwrap_or_default(),
            has_rect: v.rect.is_some(),
            role: v.role as u8,
            z: v.z,
        }
    }
}

impl From<Placement> for MarginPlacement {
    fn from(p: Placement) -> Self {
        MarginPlacement { page: p.page.into(), area: p.area.into(), display: p.display.into() }
    }
}

/// # Safety
/// `core` null or a live core from `margin_host_new`, used by one thread at a time.
unsafe fn live<'a>(core: *mut HostCore) -> Option<&'a mut HostCore> {
    // SAFETY: the caller's contract.
    unsafe { core.as_mut() }
}

/// # Safety
/// `ptr` null or `len` readable bytes.
unsafe fn id<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    // SAFETY: the caller's contract.
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).ok()
}

fn handle(h: Option<Handle>) -> u32 {
    h.unwrap_or(MARGIN_MODEL_NONE)
}

fn shown_set(s: ShownSet) -> i64 {
    match s {
        ShownSet::Keep => -2,
        ShownSet::Set(None) => -1,
        ShownSet::Set(Some(h)) => i64::from(h),
    }
}

macro_rules! with_core {
    ($core:expr, $none:expr, |$c:ident| $body:expr) => {{
        // SAFETY: the caller's contract (a live core or null, one thread at a time).
        match unsafe { live($core) } {
            Some($c) => $body,
            None => $none,
        }
    }};
}

/// The host the engine holds as `id` (`h` MARGIN_MODEL_NONE: none now).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_list(core: *mut HostCore, id_ptr: *const u8, len: usize, h: u32) {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return };
    with_core!(core, (), |c| c.model.list(i, (h != MARGIN_MODEL_NONE).then_some(h)))
}

/// `id`'s place in the layout into `out` (false: not laid out).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes; `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_layout_get(
    core: *mut HostCore,
    id_ptr: *const u8,
    len: usize,
    out: *mut MarginVisible,
) -> bool {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return false };
    let Some(v) = with_core!(core, None, |c| c.model.layout_get(i)) else { return false };
    if !out.is_null() {
        // SAFETY: out writable.
        unsafe { *out = v.into() };
    }
    true
}

/// `id`'s place in the layout set (`v` null: out of it).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes; `v` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_layout_set(
    core: *mut HostCore,
    id_ptr: *const u8,
    len: usize,
    v: *const MarginVisible,
) {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return };
    // SAFETY: v null or readable.
    let v = unsafe { v.as_ref() }.map(|v| (*v).into());
    with_core!(core, (), |c| c.model.layout_set(i, v))
}

/// How many are laid out.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_layout_count(core: *mut HostCore) -> usize {
    with_core!(core, 0, |c| c.model.layout_len())
}

/// Counts the layout's changes.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_generation(core: *mut HostCore) -> u64 {
    with_core!(core, 0, |c| c.model.generation())
}

/// A page area's change moved a laid-out host's rect (nothing when `id` isn't laid out).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_layout_move(
    core: *mut HostCore,
    id_ptr: *const u8,
    len: usize,
    rect: MarginRect,
) {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return };
    with_core!(core, (), |c| c.model.layout_move(i, rect.into()))
}

/// The one shown set (`id` null: none), `now` its time; the layout follows outside a layout's change.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set_shown(core: *mut HostCore, id_ptr: *const u8, len: usize, now: f64) {
    // SAFETY: the contract above.
    let i = unsafe { id(id_ptr, len) };
    if !id_ptr.is_null() && i.is_none() {
        return;
    }
    with_core!(core, (), |c| c.model.set_shown(i, now))
}

/// When the one shown was last shown or placed.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_shown_at(core: *mut HostCore) -> f64 {
    with_core!(core, 0.0, |c| c.model.shown_at())
}

/// The focus asked (`id` null: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set_focus(core: *mut HostCore, id_ptr: *const u8, len: usize) {
    // SAFETY: the contract above.
    let i = unsafe { id(id_ptr, len) };
    with_core!(core, (), |c| c.model.set_focus(i))
}

/// The engine's placement (the page area and the display's area).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_placement(core: *mut HostCore, out: *mut MarginPlacement) {
    let p = with_core!(core, Placement::ZERO, |c| c.model.placement());
    if !out.is_null() {
        // SAFETY: out writable.
        unsafe { *out = p.into() };
    }
}

/// # Safety
/// `core` null or a live core (one thread at a time); `p` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_set_placement(core: *mut HostCore, p: *const MarginPlacement) {
    // SAFETY: p null or readable.
    let Some(p) = (unsafe { p.as_ref() }) else { return };
    with_core!(core, (), |c| c.model.set_placement((*p).into()))
}

/// A whole layout being applied, or held.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_applying(core: *mut HostCore) -> bool {
    with_core!(core, false, |c| c.model.applying())
}

/// Visible now: laid out and shown.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_is_visible(core: *mut HostCore, id_ptr: *const u8, len: usize) -> bool {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return false };
    with_core!(core, false, |c| c.model.is_visible(i))
}

/// The visible hosts back to front into `out` (`cap` of them at most): how many there are.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null (with `cap` 0) or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_visible(core: *mut HostCore, out: *mut u32, cap: usize) -> usize {
    let out: &mut [u32] = if out.is_null() || cap == 0 {
        &mut []
    } else {
        // SAFETY: out holds cap u32s.
        unsafe { std::slice::from_raw_parts_mut(out, cap) }
    };
    with_core!(core, 0, |c| c.model.visible_hosts(out))
}

/// The visible host at main's role, else the one shown (MARGIN_MODEL_NONE: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_main_host(core: *mut HostCore) -> u32 {
    with_core!(core, MARGIN_MODEL_NONE, |c| handle(c.model.main_host()))
}

/// One host at most visible, main at the page area, and `id` would be too.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_alone(core: *mut HostCore, id_ptr: *const u8, len: usize) -> bool {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return false };
    with_core!(core, false, |c| c.model.alone(i))
}

/// A host's own page area (its rect, else Margin's page area).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_page_of(core: *mut HostCore, h: Handle, out: *mut MarginRect) {
    let r = with_core!(core, Default::default(), |c| c.model.page_of(h));
    if !out.is_null() {
        // SAFETY: out writable.
        unsafe { *out = r.into() };
    }
}

/// Margin's placement with the host's own page area in it.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_placement_for(core: *mut HostCore, h: Handle, out: *mut MarginPlacement) {
    let p = with_core!(core, Placement::ZERO, |c| c.model.placement_for(h));
    if !out.is_null() {
        // SAFETY: out writable.
        unsafe { *out = p.into() };
    }
}

/// 0 the one shown, 1 another visible, 2 the rest.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_rank(core: *mut HostCore, id_ptr: *const u8, len: usize) -> u8 {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return 2 };
    with_core!(core, 2, |c| c.model.rank(i))
}

/// The one shown before `id` comes in, to park as it does (MARGIN_MODEL_NONE: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_before(core: *mut HostCore, id_ptr: *const u8, len: usize) -> u32 {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return MARGIN_MODEL_NONE };
    with_core!(core, MARGIN_MODEL_NONE, |c| handle(c.model.before(i)))
}

/// A card's rect (`rect` null: its own) below its window's minimum: bit 0 below, bit 1 its process's version wanted
/// first (set it and ask again; unreadable, bit 0 holds).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `rect` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_below_minimum(core: *mut HostCore, h: Handle, rect: *const MarginRect) -> u8 {
    // SAFETY: rect null or readable.
    let r = unsafe { rect.as_ref() }.map(|r| (*r).into());
    let (below, needs) = with_core!(core, (false, false), |c| c.model.below_minimum(h, r));
    u8::from(below) | (u8::from(needs) << 1)
}

/// The one shown's own minimum width for the sidebar's edge (NaN: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_shown_min_width(core: *mut HostCore) -> f64 {
    with_core!(core, None, |c| c.model.shown_min_width()).unwrap_or(f64::NAN)
}

/// An operation's end settled: -2 nothing (a layout being applied), -1 nothing to show, else the host to show.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_settle_begin(core: *mut HostCore) -> i64 {
    match with_core!(core, None, |c| c.model.settle_begin()) {
        None => -2,
        Some(None) => -1,
        Some(Some(h)) => i64::from(h),
    }
}

/// The focus asked, to show (MARGIN_MODEL_NONE: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_settle_focus(core: *mut HostCore) -> u32 {
    with_core!(core, MARGIN_MODEL_NONE, |c| handle(c.model.settle_focus()))
}

/// The layout held while `id` is placed on its own (`kind` 0: one host's placing, 1: a page area's change): false,
/// nothing to hold.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `id` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_hold(core: *mut HostCore, id_ptr: *const u8, len: usize, kind: u8) -> bool {
    // SAFETY: the contract above.
    let Some(i) = (unsafe { id(id_ptr, len) }) else { return false };
    let kind = if kind == 1 { HoldKind::Page } else { HoldKind::Layout };
    with_core!(core, false, |c| c.model.hold(i, kind))
}

/// The hold let go: -2 the one shown as it is, -1 none shown, else the host to show.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_release(core: *mut HostCore) -> i64 {
    shown_set(with_core!(core, ShownSet::Keep, |c| c.model.release()))
}

/// The held ones laid out again: their hosts back to front into `out`; how many.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null (with `cap` 0) or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_layout_relay_held(core: *mut HostCore, out: *mut u32, cap: usize) -> usize {
    let list = with_core!(core, Vec::new(), |c| c.model.layout_relay_held());
    if !out.is_null() {
        let n = list.len().min(cap);
        // SAFETY: out holds cap u32s; n <= cap.
        unsafe { std::ptr::copy_nonoverlapping(list.as_ptr(), out, n) };
    }
    list.len()
}

/// A layout's end: the host left alone at the page area, to place there (MARGIN_MODEL_NONE: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_layout_end_alone(core: *mut HostCore) -> u32 {
    with_core!(core, MARGIN_MODEL_NONE, |c| handle(c.model.layout_end_alone()))
}

/// The focus a layout ends with (`focused` null: none asked): -2 the one shown as it is, -1 none, else the host to show.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `focused`, `main` null or their lengths' readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_layout_focus(
    core: *mut HostCore,
    focused: *const u8,
    focused_len: usize,
    main: *const u8,
    main_len: usize,
) -> i64 {
    // SAFETY: the contract above.
    let (f, Some(m)) = (unsafe { id(focused, focused_len) }, unsafe { id(main, main_len) }) else { return -2 };
    shown_set(with_core!(core, ShownSet::Keep, |c| c.model.layout_focus(f, m)))
}

/// `bringIn`'s decision at `point` (0 start, 1 take, 2 route, 3 placed) with the shell's facts (bits: 1 new, 2 an
/// app's, 4 taken, 8 retrying, 16 made ready out of sight): 0 go on, 1 reopen, 2 take, 3 full screen again, 4 window
/// mode, 5 placed again (held below tiles), 6 its tile sized first, 7 switched in, 8 placed for another page area,
/// 9 placed full screen.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_bring_in(core: *mut HostCore, h: Handle, point: u8, facts: u32) -> u8 {
    let at = match point {
        0 => BringInPoint::Start,
        1 => BringInPoint::Take,
        2 => BringInPoint::Route,
        _ => BringInPoint::Placed,
    };
    let f = BringInFacts {
        is_new: facts & 1 != 0,
        is_app: facts & 2 != 0,
        taken: facts & 4 != 0,
        retrying: facts & 8 != 0,
        preparing: facts & 16 != 0,
    };
    match with_core!(core, BringIn::Go, |c| c.model.bring_in(h, at, f)) {
        BringIn::Go => 0,
        BringIn::Reopen => 1,
        BringIn::Take => 2,
        BringIn::FullScreenAgain => 3,
        BringIn::Window => 4,
        BringIn::PlacedAgain => 5,
        BringIn::SizeFirst => 6,
        BringIn::SwitchIn => 7,
        BringIn::PlacedElsewhere => 8,
        BringIn::PlaceFullScreen => 9,
    }
}

/// A window of `width`×`height` centred in `page`, at whole points (layout.rs `inside`).
#[unsafe(no_mangle)]
pub extern "C" fn margin_layout_inside(page: MarginRect, width: f64, height: f64) -> MarginRect {
    layout::inside(&page.into(), Size::new(width, height)).into()
}

/// A window-mode window's frame in `page` from where it is (`now`) into `out`; false: there already (nothing set).
///
/// # Safety
/// `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_layout_window_frame(
    page: MarginRect,
    now: MarginRect,
    resizable: bool,
    placed_before: bool,
    tolerance: f64,
    out: *mut MarginRect,
) -> bool {
    let Some(r) = layout::window_frame(&page.into(), &now.into(), resizable, placed_before, tolerance) else {
        return false;
    };
    if !out.is_null() {
        // SAFETY: out writable.
        unsafe { *out = r.into() };
    }
    true
}

/// Whether a window-mode window's bounds are where `margin_layout_window_frame` puts it.
#[unsafe(no_mangle)]
pub extern "C" fn margin_layout_at_page_area(bounds: MarginRect, area: MarginRect, tolerance: f64) -> bool {
    layout::at_page_area(&bounds.into(), &area.into(), tolerance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{margin_host_free, margin_host_new, margin_model_add, margin_model_set};

    fn add(core: *mut HostCore, id: &str) -> u32 {
        // SAFETY: a live core, valid buffers.
        unsafe {
            let h = margin_model_add(core, id.as_ptr(), id.len(), id.as_ptr(), id.len(), 1, 1);
            margin_model_list(core, id.as_ptr(), id.len(), h);
            margin_model_set(core, h, 3, 1); // shown
            h
        }
    }

    #[test]
    fn the_layout_typed() {
        let core = margin_host_new();
        let (a, b) = ("app:a", "app:b");
        unsafe {
            let ha = add(core, a);
            let hb = add(core, b);
            margin_model_set_shown(core, a.as_ptr(), a.len(), 3.0);
            assert_eq!(margin_model_shown_at(core), 3.0);
            assert_eq!(margin_model_layout_count(core), 1);
            let pane = MarginVisible {
                rect: MarginRect { x: 876.0, y: 41.0, width: 628.0, height: 933.0 },
                has_rect: true,
                role: 1,
                z: 1,
            };
            margin_model_layout_set(core, b.as_ptr(), b.len(), &pane);
            let mut v = MarginVisible::default();
            assert!(margin_model_layout_get(core, b.as_ptr(), b.len(), &mut v));
            assert_eq!(v, pane);
            let mut out = [0u32; 4];
            assert_eq!(margin_model_visible(core, out.as_mut_ptr(), out.len()), 2);
            assert_eq!(&out[..2], &[ha, hb]);
            assert!(margin_model_is_visible(core, b.as_ptr(), b.len()));
            assert_eq!(margin_model_rank(core, a.as_ptr(), a.len()), 0);
            assert_eq!(margin_model_main_host(core), ha);
            assert_eq!(margin_model_before(core, b.as_ptr(), b.len()), MARGIN_MODEL_NONE);
            assert!(!margin_model_alone(core, a.as_ptr(), a.len()));
            assert!(margin_model_hold(core, b.as_ptr(), b.len(), 0));
            assert!(margin_model_applying(core));
            assert_eq!(margin_model_release(core), -2);
            margin_model_set_shown(core, std::ptr::null(), 0, 4.0);
            assert_eq!(margin_model_settle_begin(core), i64::from(hb));
            margin_model_layout_set(core, b.as_ptr(), b.len(), std::ptr::null());
            assert_eq!(margin_model_layout_count(core), 0, "a out with none shown, then b");
            let p = MarginPlacement { page: pane.rect, area: pane.rect, display: MarginRect::default() };
            margin_model_set_placement(core, &p);
            let mut q = MarginPlacement::default();
            margin_model_placement(core, &mut q);
            assert_eq!(q, p);
            let mut r = MarginRect::default();
            margin_model_page_of(core, ha, &mut r);
            assert_eq!(r, pane.rect);
            assert_eq!(margin_model_bring_in(core, ha, 3, 0), 9);
            assert!(margin_model_shown_min_width(core).is_nan());
            // Bad input, a null core: nothing, no harm.
            assert_eq!(margin_model_layout_count(std::ptr::null_mut()), 0);
            assert!(!margin_model_is_visible(core, std::ptr::null(), 0));
            let bad = [0xff_u8];
            assert!(!margin_model_is_visible(core, bad.as_ptr(), 1));
            margin_host_free(core);
        }
        let page = MarginRect { x: 240.0, y: 41.0, width: 1264.0, height: 933.0 };
        assert_eq!(
            margin_layout_inside(page, 600.0, 400.0),
            MarginRect { x: 572.0, y: 308.0, width: 600.0, height: 400.0 }
        );
        let mut out = MarginRect::default();
        // SAFETY: out writable.
        assert!(unsafe { margin_layout_window_frame(page, MarginRect::default(), true, false, 1.0, &mut out) });
        assert_eq!(out, page);
        assert!(margin_layout_at_page_area(page, page, 1.0));
    }
}
