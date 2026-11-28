//! Margin's own window's page (docs/CORE-REFACTOR.md step 3 parts 11-12) for the Mac's MarginWindowController: one
//! object per Margin window (`margin_page_new`/`_free`), used on the main thread only: margin-core's `page::Page`
//! (core/page/), with its pointer (`PagePointer`, passthrough.rs). Its page card's state and the loader's grace (a
//! deadline the caller's timer keeps), the holes, the ground and its colour, the slot and catch region placed from
//! its own holes, in front of what it hosts, the page area and the placements; the pointer's calls as before.
//!
//! Typed throughout. Nothing allocated per pointer event nor per placing of the holes once its buffers have grown, nor
//! by a read (ffi tests no_alloc.rs); a layout report's parse is its one JSON. The `margin_pass_*` and the pure
//! `margin_page_*` rules are on no object (any thread: the pane click tap reads a slot on its own). Null pointers and
//! bad input do no harm.

use std::ffi::c_void;

use margin_core::geometry::{Point, Rect};
use margin_core::host::layout::Placement;
use margin_core::page::fill::{self, Rgba};
use margin_core::page::front::{FrontCounts, FrontOp, Mechanism};
use margin_core::page::holes::{self, Piece};
use margin_core::page::press::{self, PressWay};
use margin_core::page::{Ground, GroundHole, HostedSaid, Pace, Page, PageState, Settled, Shown, area};
use margin_core::passthrough::{
    CatchBuf, CatchRef, Cg, Cut, Edges, PassThrough, Push, SlotInsets, SlotRef, Want, WantMode,
};

use crate::session::MarginBytes;
use crate::session_rules::{MarginPageLayout, MarginText, write_layout};
use crate::{MarginPlacement, MarginRect};

// (MarginRect and margin-core's Rect have one layout, both repr(C): a C array of one is read as the other in place.)
// (So do MarginCut and Cut.)
const _: () = assert!(
    std::mem::size_of::<MarginRect>() == std::mem::size_of::<Rect>()
        && std::mem::align_of::<MarginRect>() == std::mem::align_of::<Rect>()
        && std::mem::size_of::<MarginCut>() == std::mem::size_of::<Cut>()
        && std::mem::align_of::<MarginCut>() == std::mem::align_of::<Cut>()
        && std::mem::offset_of!(MarginCut, rect) == std::mem::offset_of!(Cut, rect)
        && std::mem::offset_of!(MarginCut, cut) == std::mem::offset_of!(Cut, cut)
);

/// A point in points, top-left origin.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPoint {
    pub x: f64,
    pub y: f64,
}

impl From<MarginPoint> for Point {
    fn from(p: MarginPoint) -> Self {
        Point::new(p.x, p.y)
    }
}

/// The page's layout as the slot reads it (PageLayout's insets and radius).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginInsets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub radius: f64,
}

impl From<MarginInsets> for SlotInsets {
    fn from(i: MarginInsets) -> Self {
        SlotInsets { left: i.left, top: i.top, right: i.right, bottom: i.bottom, radius: i.radius }
    }
}

/// A slot, its rects borrowed (the caller's, or the page's own until its next placing).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MarginSlotView {
    pub rect: MarginRect,
    pub radius: f64,
    pub hits: *const MarginRect,
    pub hits_len: usize,
    pub capture_all: bool,
    pub has_holes: bool,
    pub holes: *const MarginRect,
    pub holes_len: usize,
}

impl Default for MarginSlotView {
    fn default() -> Self {
        MarginSlotView {
            rect: MarginRect::default(),
            radius: 0.0,
            hits: std::ptr::null(),
            hits_len: 0,
            capture_all: false,
            has_holes: false,
            holes: std::ptr::null(),
            holes_len: 0,
        }
    }
}

/// A catch region, its rects borrowed likewise.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MarginCatchView {
    pub all: bool,
    pub has_hole: bool,
    pub hole: MarginRect,
    pub radius: f64,
    pub hits: *const MarginRect,
    pub hits_len: usize,
    pub has_holes: bool,
    pub holes: *const MarginRect,
    pub holes_len: usize,
}

impl Default for MarginCatchView {
    fn default() -> Self {
        MarginCatchView {
            all: true,
            has_hole: false,
            hole: MarginRect::default(),
            radius: 0.0,
            hits: std::ptr::null(),
            hits_len: 0,
            has_holes: false,
            holes: std::ptr::null(),
            holes_len: 0,
        }
    }
}

/// A visible host's window for the cut panes' arrows: its window number, its rect, whether it's a cut pane.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginCut {
    pub window: i64,
    pub rect: MarginRect,
    pub cut: bool,
}

/// What a pointer event decided: `pass` the panel lets the pointer through (ignores the mouse); `inside` over the
/// content; `hover_said` the cut pane it's over changed (`has_hover` and `hover`: the new one's window, or none);
/// `push` 0 nothing, 1 the position (`pointer`), 2 it left (`pointerLeft`), at `x`, `y` in the content (top left).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPointer {
    pub pass: bool,
    pub inside: bool,
    pub hover_said: bool,
    pub has_hover: bool,
    pub hover: i64,
    pub push: u8,
    pub x: f64,
    pub y: f64,
}

/// One Margin window's page: margin-core's `page::Page`.
#[derive(Default)]
pub struct MarginPage {
    pub(crate) page: Page,
}

/// # Safety
/// `ptr` null or `len` readable rects.
unsafe fn rects<'a>(ptr: *const MarginRect, len: usize) -> &'a [Rect] {
    if ptr.is_null() || len == 0 {
        return &[];
    }
    // SAFETY: the caller's contract; MarginRect and Rect have one layout (the assert above).
    unsafe { std::slice::from_raw_parts(ptr.cast::<Rect>(), len) }
}

/// # Safety
/// `ptr` null or `len` readable cuts.
unsafe fn cuts<'a>(ptr: *const MarginCut, len: usize) -> &'a [Cut] {
    if ptr.is_null() || len == 0 {
        return &[];
    }
    // SAFETY: the caller's contract; MarginCut and Cut have one layout (the assert above).
    unsafe { std::slice::from_raw_parts(ptr.cast::<Cut>(), len) }
}

/// # Safety
/// `view` null or readable, its pointers each null or as long as said.
unsafe fn slot<'a>(view: *const MarginSlotView) -> Option<SlotRef<'a>> {
    // SAFETY: the caller's contract.
    let v = unsafe { view.as_ref() }?;
    Some(SlotRef {
        rect: v.rect.into(),
        radius: v.radius,
        // SAFETY: the caller's contract.
        hits: unsafe { rects(v.hits, v.hits_len) },
        capture_all: v.capture_all,
        // SAFETY: the caller's contract.
        holes: v.has_holes.then(|| unsafe { rects(v.holes, v.holes_len) }),
    })
}

/// # Safety
/// `view` null or readable, its pointers each null or as long as said.
unsafe fn region<'a>(view: *const MarginCatchView) -> Option<CatchRef<'a>> {
    // SAFETY: the caller's contract.
    let v = unsafe { view.as_ref() }?;
    Some(CatchRef {
        all: v.all,
        hole: v.has_hole.then_some(v.hole.into()),
        radius: v.radius,
        // SAFETY: the caller's contract.
        hits: unsafe { rects(v.hits, v.hits_len) },
        // SAFETY: the caller's contract.
        holes: v.has_holes.then(|| unsafe { rects(v.holes, v.holes_len) }),
    })
}

fn slot_view(s: SlotRef<'_>) -> MarginSlotView {
    MarginSlotView {
        rect: s.rect.into(),
        radius: s.radius,
        hits: s.hits.as_ptr().cast(),
        hits_len: s.hits.len(),
        capture_all: s.capture_all,
        has_holes: s.holes.is_some(),
        holes: s.holes.map_or(std::ptr::null(), |h| h.as_ptr().cast()),
        holes_len: s.holes.map_or(0, <[Rect]>::len),
    }
}

fn catch_view(r: CatchRef<'_>) -> MarginCatchView {
    MarginCatchView {
        all: r.all,
        has_hole: r.hole.is_some(),
        hole: r.hole.unwrap_or_default().into(),
        radius: r.radius,
        hits: r.hits.as_ptr().cast(),
        hits_len: r.hits.len(),
        has_holes: r.holes.is_some(),
        holes: r.holes.map_or(std::ptr::null(), |h| h.as_ptr().cast()),
        holes_len: r.holes.map_or(0, <[Rect]>::len),
    }
}

/// # Safety
/// `out` null or writable.
unsafe fn put<T>(out: *mut T, v: T) {
    if !out.is_null() {
        // SAFETY: the caller's contract.
        unsafe { *out = v };
    }
}

fn want(mode: u8, edges: u8, zone: f64) -> Want {
    let mode = match mode {
        0 => WantMode::None,
        1 => WantMode::Edges,
        _ => WantMode::All,
    };
    Want { mode, edges, zone }
}

/// A new page (free it with `margin_page_free`).
#[unsafe(no_mangle)]
pub extern "C" fn margin_page_new() -> *mut MarginPage {
    Box::into_raw(Box::default())
}

/// # Safety
/// `page` null or from `margin_page_new`, not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_free(page: *mut MarginPage) {
    if !page.is_null() {
        // SAFETY: made by Box::into_raw in margin_page_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(page) });
    }
}

/// The positions its page wants handed in at most every `every` seconds.
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_pointer_every(page: *mut MarginPage, every: f64) {
    // SAFETY: the contract above.
    if let Some(p) = unsafe { page.as_mut() } {
        p.page.pointer.set_every(every);
    }
}

/// Its slot into `out` (its rects the page's own, valid until its next placing); false: none.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_slot(page: *const MarginPage, out: *mut MarginSlotView) -> bool {
    // SAFETY: the contract above.
    let Some(s) = (unsafe { page.as_ref() }).and_then(|p| p.page.pointer.slot()) else { return false };
    // SAFETY: the contract above.
    unsafe { put(out, slot_view(s)) };
    true
}

/// Its catch region into `out` (its rects the page's own, valid until its next placing).
///
/// # Safety
/// `page` null or a live page (one thread at a time); `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_catch(page: *const MarginPage, out: *mut MarginCatchView) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }) else { return };
    // SAFETY: the contract above.
    unsafe { put(out, catch_view(p.page.pointer.region())) };
}

/// The theme's window controls (`controls` in the content, null: none drawn) and whether the window is in full
/// screen.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `controls` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_buttons(
    page: *mut MarginPage,
    controls: *const MarginRect,
    full_screen: bool,
) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    // SAFETY: the contract above.
    p.page.pointer.set_buttons(unsafe { controls.as_ref() }.map(|c| (*c).into()), full_screen);
}

/// Which positions its page wants: `mode` 0 none, 1 within `zone` of `edges` (bits: 1 left, 2 right, 4 top, 8
/// bottom), 2 (or any other) every one.
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_want(page: *mut MarginPage, mode: u8, edges: u8, zone: f64) {
    // SAFETY: the contract above.
    if let Some(p) = unsafe { page.as_mut() } {
        p.page.pointer.set_want(want(mode, edges, zone));
    }
}

/// The visible hosts' windows, back to front, each marked when it's a cut pane, and whether any pane is cut. True:
/// the cut pane the pointer was over is forgotten (none cut any more), said to the page.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `list` null or `len` readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_cuts(
    page: *mut MarginPage,
    cutting: bool,
    list: *const MarginCut,
    len: usize,
) -> bool {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return false };
    // SAFETY: the contract above.
    p.page.pointer.set_cuts(cutting, unsafe { cuts(list, len) })
}

/// A pointer event at `at` (the window server's coordinates, top left; `buttons_down` a button held) over a window
/// whose content is at `content`, at `now` (seconds, monotonic): what it decided into `out`.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_pointer(
    page: *mut MarginPage,
    at: MarginPoint,
    content: MarginRect,
    buttons_down: bool,
    now: f64,
    out: *mut MarginPointer,
) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    let d = p.page.pointer.moved(at.into(), content.into(), buttons_down, now);
    let (push, local) = match d.push {
        Push::None => (0, Point::default()),
        Push::At(l) => (1, l),
        Push::Left(l) => (2, l),
    };
    let r = MarginPointer {
        pass: d.pass,
        inside: d.inside,
        hover_said: d.hover.is_some(),
        has_hover: d.hover.flatten().is_some(),
        hover: d.hover.flatten().unwrap_or(0),
        push,
        x: local.x,
        y: local.y,
    };
    // SAFETY: the contract above.
    unsafe { put(out, r) };
}

/// The slot changed under a still pointer at `at` with no button held: its way decided again (true: through).
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_pointer_again(
    page: *mut MarginPage,
    at: MarginPoint,
    content: MarginRect,
) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_mut() }.is_some_and(|p| p.page.pointer.again(at.into(), content.into()))
}

/// Whether the hosted window gets the pointer at `at` (its slot's answer).
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_gets(page: *const MarginPage, at: MarginPoint) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_ref() }.is_some_and(|p| p.page.pointer.gets(at.into()))
}

/// Whether the panel lets the pointer through now.
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_ignoring(page: *const MarginPage) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_ref() }.is_some_and(|p| p.page.pointer.ignoring())
}

/// Whether the page gets the pointer at `at` with this slot (null: none), CGRect's edges.
///
/// # Safety
/// `slot` null or a readable view, its rects as long as said.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_pass_page_gets(at: MarginPoint, slot: *const MarginSlotView) -> bool {
    // SAFETY: the contract above.
    PassThrough::gets::<Cg>(at.into(), unsafe { self::slot(slot) })
}

/// A field of Margin's wants the keys (the page's `focus`, kept as it's read: page/press.rs).
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_field_keys(page: *const MarginPage) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_ref() }.is_some_and(|p| p.page.field_keys())
}

/// Whether a press on Margin's UI leaves the keyboard where it is now (hosting, an app shown, no field of Margin's
/// wanting the keys: page/press.rs `keys_stay`).
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_keys_stay(page: *const MarginPage) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_ref() }.is_some_and(|p| p.page.presses_keep_keys())
}

/// The way of a press at `at` on a Margin window whose content is at `content`, with this slot (null: none), the
/// theme's window controls (in the content; null: none), its full screen and its `keys_stay` (page/press.rs
/// `press_way`): 0 outside it, 1 through to what it hosts, 2 Margin's UI with the keyboard staying, 3 Margin's UI as
/// before. The press tap's, on its own thread, over the copy its scene holds.
///
/// # Safety
/// `slot` null or a readable view, its rects as long as said; `controls` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_press_way(
    at: MarginPoint,
    content: MarginRect,
    slot: *const MarginSlotView,
    controls: *const MarginRect,
    full_screen: bool,
    keys_stay: bool,
) -> u8 {
    // SAFETY: the contract above.
    let (slot, controls) = unsafe { (self::slot(slot), controls.as_ref().map(|&c| Rect::from(c))) };
    press::press_way(at.into(), content.into(), slot, controls, full_screen, keys_stay) as u8
}

const _: () = assert!(
    PressWay::Outside as u8 == 0
        && PressWay::Through as u8 == 1
        && PressWay::Ui as u8 == 2
        && PressWay::Routed as u8 == 3
);

/// What the overlay does now (true: lets the pointer through): `ignoring` while a button is held, else the slot's
/// answer.
///
/// # Safety
/// `slot` null or a readable view, its rects as long as said.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_pass_decide(
    at: MarginPoint,
    slot: *const MarginSlotView,
    buttons_down: bool,
    ignoring: bool,
) -> bool {
    // SAFETY: the contract above.
    PassThrough::decides::<Cg>(at.into(), unsafe { self::slot(slot) }, buttons_down, ignoring)
}

/// The slot's rect for a frame (top left) and a layout; the page's `hits` (in the frame) on the screen into
/// `hits_out` (room for `hits_len`).
///
/// # Safety
/// `hits` null or `hits_len` readable; `hits_out` null or `hits_len` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_pass_slot(
    frame: MarginRect,
    layout: MarginInsets,
    hits: *const MarginRect,
    hits_len: usize,
    hits_out: *mut MarginRect,
) -> MarginRect {
    let frame: Rect = frame.into();
    if !hits_out.is_null() {
        let f = Cg::standard(&frame);
        // SAFETY: the contract above.
        for (i, h) in unsafe { rects(hits, hits_len) }.iter().enumerate() {
            // SAFETY: the contract above (room for hits_len).
            unsafe { *hits_out.add(i) = Cg::offset(h, f.min_x(), f.min_y()).into() };
        }
    }
    PassThrough::slot_rect::<Cg>(frame, layout.into()).into()
}

/// The catch region for a frame (top left) and a slot (null: none) into `out`, its hits and holes written into
/// `hits_out` and `holes_out` (room for the slot's own counts).
///
/// # Safety
/// `slot` null or a readable view, its rects as long as said; `hits_out` and `holes_out` null or writable for the
/// slot's `hits_len` and `holes_len`; `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_pass_catch(
    frame: MarginRect,
    slot: *const MarginSlotView,
    hits_out: *mut MarginRect,
    holes_out: *mut MarginRect,
    out: *mut MarginCatchView,
) {
    let mut buf = CatchBuf::default();
    // SAFETY: the contract above.
    let s = unsafe { self::slot(slot) };
    buf.of::<Cg>(frame.into(), s);
    let r = buf.view();
    let mut v = catch_view(r);
    let copy = |from: &[Rect], to: *mut MarginRect| -> *const MarginRect {
        if to.is_null() {
            return std::ptr::null();
        }
        for (i, h) in from.iter().enumerate() {
            // SAFETY: the contract above (room for the slot's counts, never fewer than the region's).
            unsafe { *to.add(i) = (*h).into() };
        }
        to
    };
    v.hits = copy(r.hits, hits_out);
    v.holes = r.holes.map_or(std::ptr::null(), |h| copy(h, holes_out));
    if v.hits.is_null() {
        v.hits_len = 0;
    }
    if v.holes.is_null() {
        v.holes_len = 0;
    }
    // SAFETY: the contract above.
    unsafe { put(out, v) };
}

/// Whether a catch region fills a point (in its frame, top left; the frame `width` × `height`).
///
/// # Safety
/// `region` null (false) or a readable view, its rects as long as said.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_pass_catch_contains(
    region: *const MarginCatchView,
    p: MarginPoint,
    width: f64,
    height: f64,
) -> bool {
    // SAFETY: the contract above.
    unsafe { self::region(region) }.is_some_and(|r| r.contains::<Cg>(p.into(), width, height))
}

/// Whether a position (in the window's content, top left; the content `width` × `height`) is wanted: `mode`, `edges`
/// and `zone` as `margin_page_set_want`'s.
#[unsafe(no_mangle)]
pub extern "C" fn margin_pass_wants(mode: u8, edges: u8, zone: f64, p: MarginPoint, width: f64, height: f64) -> bool {
    want(mode, edges, zone).wants(p.into(), width, height)
}

// ---- the page (margin-core's page::Page: docs/CORE-REFACTOR.md step 3 part 11 and part 7's page area) ----

/// A colour, sRGB components 0…1.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginRgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl From<Rgba> for MarginRgba {
    fn from(c: Rgba) -> Self {
        MarginRgba { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

/// One cut-out of the ground, in the content (top left): its corners (`has_radii` false: square).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginGroundHole {
    pub rect: MarginRect,
    pub radii: [f64; 4],
    pub has_radii: bool,
}

// (MarginGroundHole and the core's GroundHole have one layout: the page's list is handed out in place. So do
// MarginShown and Shown.)
const _: () = assert!(
    std::mem::size_of::<MarginGroundHole>() == std::mem::size_of::<GroundHole>()
        && std::mem::align_of::<MarginGroundHole>() == std::mem::align_of::<GroundHole>()
        && std::mem::offset_of!(MarginGroundHole, radii) == std::mem::offset_of!(GroundHole, radii)
        && std::mem::offset_of!(MarginGroundHole, has_radii) == std::mem::offset_of!(GroundHole, has_radii)
        && std::mem::size_of::<MarginShown>() == std::mem::size_of::<Shown>()
        && std::mem::align_of::<MarginShown>() == std::mem::align_of::<Shown>()
        && std::mem::offset_of!(MarginShown, rect) == std::mem::offset_of!(Shown, rect)
        && std::mem::offset_of!(MarginShown, z) == std::mem::offset_of!(Shown, z)
        && std::mem::offset_of!(MarginShown, role) == std::mem::offset_of!(Shown, role)
        && std::mem::offset_of!(MarginShown, focused) == std::mem::offset_of!(Shown, focused)
);

/// A visible host's window while several are: its window, its rect, its place back to front, its role (0 main, 1 a
/// pane, 2 the card), whether it's focused.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginShown {
    pub window: i64,
    pub rect: MarginRect,
    pub z: i64,
    pub role: u8,
    pub focused: bool,
}

/// A window's bounds as the window server read them.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginFrame {
    pub window: i64,
    pub rect: MarginRect,
}

/// A hole the pointer goes through to while several hosts are visible, its window (the pane click tap's).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPaneHole {
    pub rect: MarginRect,
    pub window: i64,
    pub card: bool,
}

/// What a placing of the holes did: `slot` and `region` changed (the pointer looked at again, the catch fill drawn
/// again); the ground: 0 no hole (the panel's background the fill), 1 around `hole`, 2 around `holes` (the page's
/// own, valid until its next placing); its fill the ground's colour (`has_fill`), else the window's own.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MarginHolePlaced {
    pub slot: bool,
    pub region: bool,
    pub ground: u8,
    pub has_fill: bool,
    pub fill: MarginRgba,
    pub hole: MarginGroundHole,
    pub holes: *const MarginGroundHole,
    pub holes_len: usize,
}

impl Default for MarginHolePlaced {
    fn default() -> Self {
        MarginHolePlaced {
            slot: false,
            region: false,
            ground: 0,
            has_fill: false,
            fill: MarginRgba::default(),
            hole: MarginGroundHole::default(),
            holes: std::ptr::null(),
            holes_len: 0,
        }
    }
}

/// What a settling of the page card's state did: `grace` the loader's grace began (until `deadline`; `hole_again`:
/// its hole placed again meanwhile); else applied: `changed` (its page told), `shown`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginSettled {
    pub grace: bool,
    pub hole_again: bool,
    pub deadline: f64,
    pub changed: bool,
    pub shown: bool,
}

/// What was done to keep it in front, counted.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginFrontCounts {
    pub level_sets: u64,
    pub front_orders: u64,
    pub yield_orders: u64,
    pub front_restores: u64,
    pub level_probes: u64,
    pub level_backs: u64,
}

impl From<FrontCounts> for MarginFrontCounts {
    fn from(c: FrontCounts) -> Self {
        MarginFrontCounts {
            level_sets: c.level_sets,
            front_orders: c.front_orders,
            yield_orders: c.yield_orders,
            front_restores: c.front_restores,
            level_probes: c.level_probes,
            level_backs: c.level_backs,
        }
    }
}

/// What the page holds, read at once: its state (0 empty, 1 loading, 2 shown, 3 elsewhere), hosting, the hosted
/// window and its bounds, the hole and how many holes, the visible hosts, whether it follows a drag, its start's look,
/// whether an engine's slow step or a show is under way, the ground's colour, how it's kept in front (0 level, 1
/// order), what it lets in front and covers, the grace's deadline, and the counts.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPageRead {
    pub state: u8,
    pub hosting: bool,
    pub has_hosted: bool,
    pub hosted: i64,
    pub has_frame: bool,
    pub frame: MarginRect,
    pub has_hole: bool,
    pub hole: MarginRect,
    pub holes: usize,
    pub visible: usize,
    pub following: bool,
    pub starting: bool,
    pub has_loading: bool,
    pub has_showing: bool,
    pub has_ground: bool,
    pub ground: MarginRgba,
    pub mechanism: u8,
    pub has_yielding: bool,
    pub yielding: i64,
    pub has_covering: bool,
    pub covering: i64,
    pub has_grace: bool,
    pub grace_until: f64,
    pub counts: MarginFrontCounts,
}

/// `keepFront`'s asks, in this order: `level` 0 none, 1 normal, 2 raised; ordered right above `above`; ordered right
/// below `below` (another app's window let in front).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginKeepFront {
    pub level: u8,
    pub has_above: bool,
    pub above: i64,
    pub has_below: bool,
    pub below: i64,
}

/// One step of a read at rest: `kind` 1 the normal level, 2 the raised level, 3 ordered right above `arg`; said: 4
/// the hosted window above it (`arg` its mechanism, 0 level, 1 order), 5 in front by its level, 6 by its order instead
/// (`arg` the ms between the misses), 7 by its level again.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginFrontOp {
    pub kind: u8,
    pub arg: i64,
}

/// A read at rest's steps, in order.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginFrontOps {
    pub ops: [MarginFrontOp; 8],
    pub len: u8,
}

/// A split's panes on the screen: its id and each pane's item (texts in the caller's buffer) and box.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPagePanes {
    pub split: MarginText,
    pub count: u8,
    pub items: [MarginText; 4],
    pub rects: [MarginRect; 4],
}

/// The caller's clock, read where the decision reads it.
pub type MarginClock = Option<unsafe extern "C" fn(ctx: *mut c_void) -> f64>;

/// # Safety
/// `ptr` null or `len` readable bytes.
unsafe fn opt_text<'a>(ptr: *const u8, len: usize, has: bool) -> Option<&'a str> {
    if !has {
        return None;
    }
    if ptr.is_null() || len == 0 {
        return Some("");
    }
    // SAFETY: the caller's contract.
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).ok()
}

fn clock(ctx: *mut c_void, now: MarginClock) -> impl FnMut() -> f64 {
    move || match now {
        // SAFETY: the caller's clock, with its own context.
        Some(f) => unsafe { f(ctx) },
        None => 0.0,
    }
}

fn mechanism(m: Mechanism) -> u8 {
    match m {
        Mechanism::Level => 0,
        Mechanism::Order => 1,
    }
}

/// The loader's grace and a quick switch's (seconds; 0: none; negative: the core's own), the start's loader label, the
/// mechanism asked for (`order`: the order's way, kept) and the OS's raised and normal window levels.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `label` null or `len` readable bytes.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn margin_page_configure(
    page: *mut MarginPage,
    grace: f64,
    switch_grace: f64,
    label: *const u8,
    len: usize,
    order: bool,
    raised: i64,
    normal: i64,
) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    // SAFETY: the contract above.
    let label = unsafe { opt_text(label, len, true) }.unwrap_or("");
    let asked = if order { Mechanism::Order } else { Mechanism::Level };
    p.page.configure(grace, switch_grace, label, asked, raised, normal);
}

/// The page's layout report: its JSON (the `geometry` object, as the page sent it) parsed and kept. Bits: 1 it was
/// one (kept), 2 a split's panes changed with it.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `bytes` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_layout(page: *mut MarginPage, bytes: *const u8, len: usize) -> u8 {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return 0 };
    if bytes.is_null() {
        return 0;
    }
    // SAFETY: the contract above.
    let said = p.page.set_layout_bytes(unsafe { std::slice::from_raw_parts(bytes, len) });
    u8::from(said.taken) | (u8::from(said.panes_changed) << 1)
}

/// The layout kept, as `margin_page_layout_read` writes one: the bytes its texts take (more than `cap`: nothing
/// written), -1: none yet.
///
/// # Safety
/// `page` null or a live page; `out` writable; `text` `cap` writable bytes (or null with `cap` 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_layout_get(
    page: *const MarginPage,
    out: *mut MarginPageLayout,
    text: *mut u8,
    cap: usize,
) -> isize {
    // SAFETY: the contract above.
    let Some(l) = (unsafe { page.as_ref() }).and_then(|p| p.page.layout()) else { return -1 };
    if out.is_null() {
        return -1;
    }
    // SAFETY: the contract above.
    unsafe { write_layout(l, out, text, cap) }
}

/// What the theme draws over the page area that takes the pointer (`hits`, in the content) and whether it asked for
/// the whole window.
///
/// # Safety
/// `page` null or a live page; `hits` null or `len` readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_hits(
    page: *mut MarginPage,
    hits: *const MarginRect,
    len: usize,
    capture_all: bool,
) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    // SAFETY: the contract above.
    p.page.set_hits(unsafe { rects(hits, len) }, capture_all);
}

/// Whether the window is in full screen.
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_full_screen(page: *mut MarginPage, on: bool) {
    // SAFETY: the contract above.
    if let Some(p) = unsafe { page.as_mut() } {
        p.page.set_full_screen(on);
    }
}

/// The page area again for its content (top left) and its display's frame (null: none): 0 left as it is; 1 none, 2
/// `out` (with `radius`): the window's page area set so.
///
/// # Safety
/// `page` null or a live page; `display` null or readable; `out` and `radius` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_update(
    page: *mut MarginPage,
    content: MarginRect,
    display: *const MarginRect,
    out: *mut MarginRect,
    radius: *mut f64,
) -> u8 {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return 0 };
    // SAFETY: the contract above.
    let display = unsafe { display.as_ref() }.map(|d| (*d).into());
    let Some((rect, r)) = p.page.update_page(content.into(), display) else { return 0 };
    // SAFETY: the contract above.
    unsafe { put(radius, r) };
    match rect {
        None => 1,
        Some(rect) => {
            // SAFETY: the contract above.
            unsafe { put(out, rect.into()) };
            2
        }
    }
}

fn placement(p: Placement) -> MarginPlacement {
    MarginPlacement { page: p.page.into(), area: p.area.into(), display: p.display.into() }
}

/// Where the hosted window goes while hosting (its content and display as `margin_page_update`'s); false: none yet.
///
/// # Safety
/// `page` null or a live page; `display` null or readable; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_hosted_placement(
    page: *const MarginPage,
    content: MarginRect,
    display: *const MarginRect,
    out: *mut MarginPlacement,
) -> bool {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }) else { return false };
    // SAFETY: the contract above.
    let display = unsafe { display.as_ref() }.map(|d| (*d).into());
    let Some(pl) = p.page.hosted_placement(content.into(), display) else { return false };
    // SAFETY: the contract above.
    unsafe { put(out, placement(pl)) };
    true
}

/// Where a browser's window made ready out of sight goes; false: none yet.
///
/// # Safety
/// `page` null or a live page; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_idle_placement(
    page: *const MarginPage,
    content: MarginRect,
    out: *mut MarginPlacement,
) -> bool {
    // SAFETY: the contract above.
    let Some(pl) = (unsafe { page.as_ref() }).and_then(|p| p.page.idle_placement(content.into())) else { return false };
    // SAFETY: the contract above.
    unsafe { put(out, placement(pl)) };
    true
}

/// A split's panes on the screen (hosting, a split laid out): the bytes their texts take (more than `cap`: nothing
/// written), -1: none.
///
/// # Safety
/// `page` null or a live page; `out` writable; `text` `cap` writable bytes (or null with `cap` 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_panes(
    page: *const MarginPage,
    content: MarginRect,
    out: *mut MarginPagePanes,
    text: *mut u8,
    cap: usize,
) -> isize {
    // SAFETY: the contract above.
    let Some((split, panes)) = (unsafe { page.as_ref() }).and_then(|p| p.page.panes(content.into())) else { return -1 };
    if out.is_null() {
        return -1;
    }
    let mut o = MarginPagePanes::default();
    let mut list = [("", Rect::ZERO); 4];
    let mut n = 0;
    for (item, rect) in panes.take(4) {
        list[n] = (item, rect);
        n += 1;
    }
    let need = split.len() + list[..n].iter().map(|(i, _)| i.len()).sum::<usize>();
    if need > cap || (need > 0 && text.is_null()) {
        return need as isize;
    }
    // SAFETY: `text` has `cap` writable bytes (the contract), `need` of them used.
    let buffer = if need == 0 { &mut [][..] } else { unsafe { std::slice::from_raw_parts_mut(text, need) } };
    let mut at = 0;
    let mut put_text = |s: &str| {
        buffer[at..at + s.len()].copy_from_slice(s.as_bytes());
        at += s.len();
        MarginText { at: at - s.len(), len: s.len() }
    };
    o.split = put_text(split);
    o.count = n as u8;
    for (i, (item, rect)) in list[..n].iter().enumerate() {
        o.items[i] = put_text(item);
        o.rects[i] = (*rect).into();
    }
    // SAFETY: the contract above.
    unsafe { put(out, o) };
    need as isize
}

/// Hosting another app's window in its page area, or not: 0 no change; bit 1 changed, bit 2 several hosts were
/// visible (none now).
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_hosting(page: *mut MarginPage, on: bool) -> u8 {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return 0 };
    match p.page.set_hosting(on) {
        None => 0,
        Some(had) => 1 | (u8::from(had) << 1),
    }
}

/// Whether the hosted window lies in a tile of Margin's Space (the engine's word, with each window it says).
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_hosted_tile(page: *mut MarginPage, on: bool) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    p.page.set_hosted_tile(on);
}

/// Whether the page area may pass the window's edge, when it differs from what the page was last told (`pageSlides`):
/// 0 no change, 1 now no, 2 now yes.
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_slides_change(page: *mut MarginPage) -> u8 {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }) else { return 0 };
    match p.page.slides_change() {
        None => 0,
        Some(on) => 1 + u8::from(on),
    }
}

/// The engine's slow step (its app's name; `has_label` false: over) and the app whose icon its loader shows. False:
/// nothing new.
///
/// # Safety
/// `page` null or a live page; the texts null or as long as said.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_loading(
    page: *mut MarginPage,
    label: *const u8,
    label_len: usize,
    has_label: bool,
    app: *const u8,
    app_len: usize,
    has_app: bool,
) -> bool {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return false };
    // SAFETY: the contract above.
    let (label, app) = unsafe { (opt_text(label, label_len, has_label), opt_text(app, app_len, has_app)) };
    p.page.set_loading(label, app)
}

/// An item being shown and not ready yet, and how long that's expected to take (`pace`: 0 as usual, 1 a quick switch,
/// 2 known to take a while; anything else as usual). False: nothing new.
///
/// # Safety
/// As `margin_page_set_loading`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn margin_page_set_showing(
    page: *mut MarginPage,
    label: *const u8,
    label_len: usize,
    has_label: bool,
    app: *const u8,
    app_len: usize,
    has_app: bool,
    pace: u8,
) -> bool {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return false };
    // SAFETY: the contract above.
    let (label, app) = unsafe { (opt_text(label, label_len, has_label), opt_text(app, app_len, has_app)) };
    let pace = match pace {
        1 => Pace::Quick,
        2 => Pace::Slow,
        _ => Pace::Usual,
    };
    p.page.set_showing(label, app, pace)
}

/// The browser's copy asked for the item being shown is slow, or no longer (only while one is shown). False: nothing
/// new.
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_copy_slow(page: *mut MarginPage, on: bool) -> bool {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return false };
    p.page.set_copy_slow(on)
}

/// The loader says the browser's copy is slow (`Page::copy_slow`).
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_copy_slow(page: *const MarginPage) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_ref() }.is_some_and(|p| p.page.copy_slow())
}

/// Its card while its item is in another Margin window or parked (none: no card). False: nothing new.
///
/// # Safety
/// As `margin_page_set_loading`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_elsewhere(
    page: *mut MarginPage,
    label: *const u8,
    label_len: usize,
    has_label: bool,
    app: *const u8,
    app_len: usize,
    has_app: bool,
) -> bool {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return false };
    // SAFETY: the contract above.
    let (label, app) = unsafe { (opt_text(label, label_len, has_label), opt_text(app, app_len, has_app)) };
    p.page.set_elsewhere(label, app)
}

/// What holds Margin's start up (none: nothing). False: nothing new.
///
/// # Safety
/// `page` null or a live page; `why` null or as long as said.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_stuck(page: *mut MarginPage, why: *const u8, len: usize, has: bool) -> bool {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return false };
    // SAFETY: the contract above.
    p.page.set_stuck(unsafe { opt_text(why, len, has) })
}

/// The hosted window shown in its page area (`has` false: none): 0 the same none as before, 1 the same window
/// (placed again: its bounds read again), 2 another.
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_hosted(page: *mut MarginPage, has: bool, number: i64) -> u8 {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return 0 };
    match p.page.set_hosted(has.then_some(number)) {
        HostedSaid::Same => 0,
        HostedSaid::Moved => 1,
        HostedSaid::Changed => 2,
    }
}

/// The hosted window's bounds as the window server read them (null: unread, or none hosted).
///
/// # Safety
/// `page` null or a live page; `frame` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_hosted_frame(page: *mut MarginPage, frame: *const MarginRect) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    // SAFETY: the contract above.
    p.page.set_hosted_frame(unsafe { frame.as_ref() }.map(|f| (*f).into()));
}

/// Every visible host's window while several are (none: one host). True: more than their rects changed.
///
/// # Safety
/// `page` null or a live page; `list` null or `len` readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_visible(page: *mut MarginPage, list: *const MarginShown, len: usize) -> bool {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return false };
    let list: &[Shown] = if list.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: the contract above; MarginShown and Shown have one layout (the assert above).
        unsafe { std::slice::from_raw_parts(list.cast::<Shown>(), len) }
    };
    p.page.set_visible(list)
}

/// The visible hosts' windows' bounds as the window server read them.
///
/// # Safety
/// `page` null or a live page; `list` null or `len` readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_frames(page: *mut MarginPage, list: *const MarginFrame, len: usize) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    let list: &[MarginFrame] = if list.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: the contract above.
        unsafe { std::slice::from_raw_parts(list, len) }
    };
    p.page.set_frames(list.iter().map(|f| (f.window, f.rect.into())));
}

/// The hosted window follows a drag live (the hole the page area meanwhile). False: no change.
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_following(page: *mut MarginPage, on: bool) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_mut() }.is_some_and(|p| p.page.set_following(on))
}

fn settled(s: Settled, deadline: Option<f64>) -> MarginSettled {
    match s {
        Settled::Grace { hole_again } => {
            MarginSettled { grace: true, hole_again, deadline: deadline.unwrap_or(0.0), ..MarginSettled::default() }
        }
        Settled::Applied(a) => MarginSettled { changed: a.changed, shown: a.shown, ..MarginSettled::default() },
    }
}

/// The page card's state settled at `now`: the grace begun (its deadline) or the state applied.
///
/// # Safety
/// `page` null or a live page; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_settle(page: *mut MarginPage, now: f64, out: *mut MarginSettled) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    let s = p.page.settle(now);
    // SAFETY: the contract above.
    unsafe { put(out, settled(s, p.page.grace_until())) };
}

/// The grace over: the state applied.
///
/// # Safety
/// `page` null or a live page; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_grace_over(page: *mut MarginPage, out: *mut MarginSettled) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    let a = p.page.grace_over();
    // SAFETY: the contract above.
    unsafe { put(out, settled(Settled::Applied(a), None)) };
}

/// The holes placed for its content (top left): the ground, the slot and catch region, the pane click tap's holes.
///
/// # Safety
/// `page` null or a live page; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_place_hole(
    page: *mut MarginPage,
    content: MarginRect,
    out: *mut MarginHolePlaced,
) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    let placed = p.page.place_hole(content.into());
    let g = p.page.ground_hole();
    let list = p.page.ground_holes();
    let o = MarginHolePlaced {
        slot: placed.placed.slot,
        region: placed.placed.region,
        ground: match placed.ground {
            Ground::None => 0,
            Ground::One => 1,
            Ground::Several => 2,
        },
        has_fill: placed.fill.is_some(),
        fill: placed.fill.map(MarginRgba::from).unwrap_or_default(),
        hole: MarginGroundHole { rect: g.rect.into(), radii: g.radii, has_radii: g.has_radii },
        holes: list.as_ptr().cast(),
        holes_len: list.len(),
    };
    // SAFETY: the contract above.
    unsafe { put(out, o) };
}

/// What the page holds, at once.
///
/// # Safety
/// `page` null or a live page; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_read(page: *const MarginPage, out: *mut MarginPageRead) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }).map(|p| &p.page) else { return };
    let f = &p.front;
    let r = MarginPageRead {
        state: match p.state() {
            PageState::Empty => 0,
            PageState::Loading => 1,
            PageState::Shown => 2,
            PageState::Elsewhere => 3,
        },
        hosting: p.hosting(),
        has_hosted: p.hosted().is_some(),
        hosted: p.hosted().unwrap_or(0),
        has_frame: p.hosted_frame().is_some(),
        frame: p.hosted_frame().unwrap_or_default().into(),
        has_hole: p.hole().is_some(),
        hole: p.hole().unwrap_or_default().into(),
        holes: p.holes().len(),
        visible: p.visible().len(),
        following: p.following(),
        starting: p.starting(),
        has_loading: p.loading().is_some(),
        has_showing: p.showing().is_some(),
        has_ground: p.ground().is_some(),
        ground: p.ground().map(MarginRgba::from).unwrap_or_default(),
        mechanism: mechanism(f.mechanism),
        has_yielding: f.yielding.is_some(),
        yielding: f.yielding.unwrap_or(0),
        has_covering: f.covering.is_some(),
        covering: f.covering.unwrap_or(0),
        has_grace: p.grace_until().is_some(),
        grace_until: p.grace_until().unwrap_or(0.0),
        counts: f.counts.into(),
    };
    // SAFETY: the contract above.
    unsafe { put(out, r) };
}

/// One of its texts into `buf` (`cap` bytes): `which` 0 the loader's label, 1 the loader's app, 2 the engine's slow
/// step, 3 the show under way, 4 what holds the start up. Its length (more than `cap`: nothing written), -1: none.
///
/// # Safety
/// `page` null or a live page; `buf` `cap` writable bytes (or null with `cap` 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_text(page: *const MarginPage, which: u8, buf: *mut u8, cap: usize) -> isize {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }).map(|p| &p.page) else { return -1 };
    let t = match which {
        0 => p.loader(),
        1 => p.loader_app(),
        2 => p.loading(),
        3 => p.showing(),
        4 => p.stuck(),
        _ => None,
    };
    let Some(t) = t else { return -1 };
    if t.len() <= cap && !buf.is_null() {
        // SAFETY: the contract above.
        unsafe { std::ptr::copy_nonoverlapping(t.as_ptr(), buf, t.len()) };
    }
    t.len() as isize
}

/// Its holes into `out` (room for `cap`): how many there are.
///
/// # Safety
/// `page` null or a live page; `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_holes(page: *const MarginPage, out: *mut MarginRect, cap: usize) -> usize {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }) else { return 0 };
    let list = p.page.holes();
    if !out.is_null() {
        for (i, h) in list.iter().take(cap).enumerate() {
            // SAFETY: the contract above.
            unsafe { *out.add(i) = (*h).into() };
        }
    }
    list.len()
}

/// Where folded panes' windows are blurred (`Page::blurs`, docs/FLEX-SPLIT.md step 1), on the screen, into `out` (room
/// for `cap`): how many there are.
///
/// # Safety
/// `page` null or a live page; `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_blurs(
    page: *const MarginPage,
    content: MarginRect,
    out: *mut MarginRect,
    cap: usize,
) -> usize {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }) else { return 0 };
    let list = p.page.blurs(content.into());
    if !out.is_null() {
        for (i, r) in list.iter().take(cap).enumerate() {
            // SAFETY: the contract above.
            unsafe { *out.add(i) = (*r).into() };
        }
    }
    list.len()
}

/// The pane click tap's holes into `out` (room for `cap`): how many there are.
///
/// # Safety
/// `page` null or a live page; `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_pane_holes(
    page: *const MarginPage,
    out: *mut MarginPaneHole,
    cap: usize,
) -> usize {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }) else { return 0 };
    let list = p.page.pane_holes();
    if !out.is_null() {
        for (i, h) in list.iter().take(cap).enumerate() {
            // SAFETY: the contract above.
            unsafe { *out.add(i) = MarginPaneHole { rect: h.rect.into(), window: h.window, card: h.card } };
        }
    }
    list.len()
}

/// A visible host's window's bounds as read (false: unread).
///
/// # Safety
/// `page` null or a live page; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_frame(page: *const MarginPage, window: i64, out: *mut MarginRect) -> bool {
    // SAFETY: the contract above.
    let Some(f) = (unsafe { page.as_ref() }).and_then(|p| p.page.frame(window)) else { return false };
    // SAFETY: the contract above.
    unsafe { put(out, f.into()) };
    true
}

/// Another app's window let in front (`has` false: none any more). False: the same as before.
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_yielding(page: *mut MarginPage, has: bool, number: i64) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_mut() }.is_some_and(|p| p.page.front.set_yielding(has.then_some(number)))
}

/// A window of the engine's not shown yet (`has` false: none). False: the same as before.
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_set_covering(page: *mut MarginPage, has: bool, number: i64) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_mut() }.is_some_and(|p| p.page.front.set_covering(has.then_some(number)))
}

/// The current Space changed, at `now`.
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_space_changed(page: *mut MarginPage, now: f64) {
    // SAFETY: the contract above.
    if let Some(p) = unsafe { page.as_mut() } {
        p.page.front.space_changed(now);
    }
}

/// `keepFront` (the caller checked its window is open and on the current Space): the window's level now `level`, the
/// clock read at each change.
///
/// # Safety
/// `page` null or a live page; `now` null or a function taking `ctx`; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_keep_front(
    page: *mut MarginPage,
    level: i64,
    ctx: *mut c_void,
    now: MarginClock,
    out: *mut MarginKeepFront,
) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    let k = p.page.keep_front(level, &mut clock(ctx, now));
    let o = MarginKeepFront {
        level: match k.level {
            None => 0,
            Some(false) => 1,
            Some(true) => 2,
        },
        has_above: k.above.is_some(),
        above: k.above.unwrap_or(0),
        has_below: k.below.is_some(),
        below: k.below.unwrap_or(0),
    };
    // SAFETY: the contract above.
    unsafe { put(out, o) };
}

/// Whether the poll's read of `hosted` is this window's to look at (in full screen, nothing let in front, its hosted
/// window or a visible host's).
///
/// # Safety
/// `page` null or a live page.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_front_reads(page: *const MarginPage, hosted: i64) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_ref() }.is_some_and(|p| p.page.front_reads(hosted))
}

/// The poll's read at rest of this window (its `layer`, `above` the hosted window `hosted`; its window level now
/// `level`), the clock read once: the steps, in order.
///
/// # Safety
/// `page` null or a live page; `now` null or a function taking `ctx`; `out` writable.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn margin_page_front_read(
    page: *mut MarginPage,
    hosted: i64,
    layer: i64,
    above: bool,
    level: i64,
    ctx: *mut c_void,
    now: MarginClock,
    out: *mut MarginFrontOps,
) {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return };
    let ops = p.page.front_read(hosted, layer, above, level, &mut clock(ctx, now));
    let mut o = MarginFrontOps::default();
    for op in ops.iter() {
        let (kind, arg) = match op {
            FrontOp::Level(false) => (1, 0),
            FrontOp::Level(true) => (2, 0),
            FrontOp::Above(w) => (3, w),
            FrontOp::Wrong(m) => (4, i64::from(mechanism(m))),
            FrontOp::Held => (5, 0),
            FrontOp::FellBack(ms) => (6, ms),
            FrontOp::Back => (7, 0),
        };
        o.ops[usize::from(o.len)] = MarginFrontOp { kind, arg };
        o.len += 1;
    }
    // SAFETY: the contract above.
    unsafe { put(out, o) };
}

// ---- the pure rules (any thread, no object) ----

/// The page area on the screen for a layout's insets, measured at `width` × `height`, and the window's content (top
/// left); false: none (not measured at its size, or no area left).
///
/// # Safety
/// `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_rect(
    insets: MarginInsets,
    width: f64,
    height: f64,
    content: MarginRect,
    out: *mut MarginRect,
) -> bool {
    let Some(r) = area::page_rect(SlotInsets::from(insets), width, height, content.into()) else { return false };
    // SAFETY: the contract above.
    unsafe { put(out, r.into()) };
    true
}

/// In full screen and narrower than its display (null: none) by more than 2 pt: laid out as a split's half for a
/// moment by a tile change in its Space.
///
/// # Safety
/// `display` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_narrowed(
    full_screen: bool,
    content: MarginRect,
    display: *const MarginRect,
) -> bool {
    // SAFETY: the contract above.
    let display: Option<Rect> = unsafe { display.as_ref() }.map(|d| (*d).into());
    area::narrowed(full_screen, &content.into(), display.as_ref())
}

/// Whether a layout measured at `width` × `height` was measured at the content's size (within a point each way).
#[unsafe(no_mangle)]
pub extern "C" fn margin_page_measured_at(width: f64, height: f64, content: MarginRect) -> bool {
    area::measured_at(width, height, &content.into())
}

/// A CSS colour as the page computes it, read (false: none, or see-through).
///
/// # Safety
/// `css` null or `len` readable bytes; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_fill_color(css: *const u8, len: usize, out: *mut MarginRgba) -> bool {
    // SAFETY: the contract above.
    let Some(c) = (unsafe { opt_text(css, len, true) }).and_then(fill::color) else { return false };
    // SAFETY: the contract above.
    unsafe { put(out, c.into()) };
    true
}

/// The colour most of these have, the first on a tie (false: none).
///
/// # Safety
/// `list` null or `len` readable; `out` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_fill_common(list: *const MarginRgba, len: usize, out: *mut MarginRgba) -> bool {
    let list: Vec<Rgba> = if list.is_null() || len == 0 {
        Vec::new()
    } else {
        // SAFETY: the contract above.
        unsafe { std::slice::from_raw_parts(list, len) }
            .iter()
            .map(|c| Rgba { r: c.r, g: c.g, b: c.b, a: c.a })
            .collect()
    };
    let Some(c) = fill::common(&list) else { return false };
    // SAFETY: the contract above.
    unsafe { put(out, c.into()) };
    true
}

/// `r` less `cut` into `out` (room for 4): how many rects.
///
/// # Safety
/// `out` null or 4 writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_subtract(r: MarginRect, cut: MarginRect, out: *mut MarginRect) -> usize {
    let mut v = Vec::with_capacity(4);
    holes::subtract(&r.into(), &cut.into(), &mut v);
    if !out.is_null() {
        for (i, x) in v.iter().enumerate() {
            // SAFETY: the contract above (at most 4).
            unsafe { *out.add(i) = (*x).into() };
        }
    }
    v.len()
}

/// A piece of the ground's cut-outs: its rect, the hole it's of, whether it's that hole whole.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginPiece {
    pub rect: MarginRect,
    pub from: usize,
    pub whole: bool,
}

/// The ground's cut-outs for holes that may overlap, into `out` (room for `cap`): how many pieces (more than `cap`:
/// nothing written).
///
/// # Safety
/// `list` null or `len` readable; `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_ground_holes(
    list: *const MarginRect,
    len: usize,
    out: *mut MarginPiece,
    cap: usize,
) -> usize {
    let mut pieces: Vec<Piece> = Vec::new();
    // SAFETY: the contract above.
    holes::ground_holes(unsafe { rects(list, len) }, &mut pieces, &mut [Vec::new(), Vec::new()]);
    if pieces.len() <= cap && !out.is_null() {
        for (i, p) in pieces.iter().enumerate() {
            // SAFETY: the contract above.
            unsafe { *out.add(i) = MarginPiece { rect: p.rect.into(), from: p.from, whole: p.whole } };
        }
    }
    pieces.len()
}

// ---- what the page says, and its hello (core/page/said.rs, hello.rs: step 3, part 10) ----

/// An op's route (page/said.rs `Said`): `kind` 0 nothing, 1 ready, 2 layout (`flag` taken, `flag2` a split's panes
/// changed), 3 the card's rect (`has_rect`: `rect`, in the window), 4 hits (`flag`: all; the rects: `rects` of them,
/// `margin_page_said_rects`), 5 chrome (`has_rect`: the controls' `rect`; the drag regions as the hits'), 6 focus
/// (`flag`), 7 counts (`a` spaces, `b` items), 8 the pointer's wants (kept), 9 full screen, 10 resizing (`flag` on,
/// `flag2` a divider), 11 the haptic tick (`flag`: a level's change, else the alignment), 12 unused (a cut pane's slide,
/// removed 2026-11-28), 13 a request of the source (`text`: `{ name, arg }`'s JSON), 14 a log line (`flag` a warning; `text`).
/// `text` is allocated (free it with `margin_buffer_free`), null when there's none.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MarginSaid {
    pub kind: u8,
    pub flag: bool,
    pub flag2: bool,
    pub has_rect: bool,
    pub a: i64,
    pub b: i64,
    pub rect: MarginRect,
    pub rects: usize,
    pub text: *mut u8,
    pub text_len: usize,
}

impl Default for MarginSaid {
    fn default() -> Self {
        MarginSaid {
            kind: 0,
            flag: false,
            flag2: false,
            has_rect: false,
            a: 0,
            b: 0,
            rect: MarginRect::default(),
            rects: 0,
            text: std::ptr::null_mut(),
            text_len: 0,
        }
    }
}

fn owned(text: String, out: &mut MarginSaid) {
    let boxed = text.into_bytes().into_boxed_slice();
    out.text_len = boxed.len();
    out.text = Box::into_raw(boxed) as *mut u8;
}

/// An op the page said (`op`), its body's JSON (`body`; a layout's: its report), the window's content rect: its
/// route in `out`. Its kind back.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `op` and `body` null or their lengths' readable bytes; `out`
/// writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_said(
    page: *mut MarginPage,
    op: *const u8,
    op_len: usize,
    body: *const u8,
    body_len: usize,
    content: MarginRect,
    out: *mut MarginSaid,
) -> u8 {
    use margin_core::page::said::Said;
    // SAFETY: the contract above.
    let (Some(p), Some(out)) = (unsafe { page.as_mut() }, unsafe { out.as_mut() }) else { return 0 };
    *out = MarginSaid::default();
    let Some(op) = crate::data::text(op, op_len) else { return 0 };
    let body: &[u8] = if body.is_null() || body_len == 0 {
        &[]
    } else {
        // SAFETY: the contract above.
        unsafe { std::slice::from_raw_parts(body, body_len) }
    };
    let said = p.page.said(op, body, content.into());
    let rects = p.page.said_rects().len();
    out.kind = match said {
        Said::None => 0,
        Said::Ready => 1,
        Said::Layout(l) => {
            (out.flag, out.flag2) = (l.taken, l.panes_changed);
            2
        }
        Said::PeekRect(r) => {
            if let Some(r) = r {
                (out.has_rect, out.rect) = (true, r.into());
            }
            3
        }
        Said::Hits { all } => {
            (out.flag, out.rects) = (all, rects);
            4
        }
        Said::Chrome { controls } => {
            if let Some(r) = controls {
                (out.has_rect, out.rect) = (true, r.into());
            }
            out.rects = rects;
            5
        }
        Said::Focus { on, was } => {
            (out.flag, out.flag2) = (on, was);
            6
        }
        Said::Counts { spaces, items } => {
            (out.a, out.b) = (spaces, items);
            7
        }
        Said::Want => 8,
        Said::FullScreen => 9,
        Said::Resizing { on, divider } => {
            (out.flag, out.flag2) = (on, divider);
            10
        }
        Said::Haptic { level } => {
            out.flag = level;
            11
        }
        Said::Ask { name, arg } => {
            owned(serde_json::json!({ "name": name, "arg": arg }).to_string(), out);
            13
        }
        Said::Log { warn, text } => {
            out.flag = warn;
            owned(text, out);
            14
        }
    };
    out.kind
}

/// The rects the last op read (the hits kept, or the drag regions): the first `cap` into `out`; how many there are.
///
/// # Safety
/// `page` null or a live page; `out` `cap` writable rects (or null with 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_said_rects(page: *const MarginPage, out: *mut MarginRect, cap: usize) -> usize {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_ref() }) else { return 0 };
    let list = p.page.said_rects();
    if !out.is_null() {
        for (i, r) in list.iter().take(cap).enumerate() {
            // SAFETY: `cap` writable (the contract).
            unsafe { *out.add(i) = (*r).into() };
        }
    }
    list.len()
}

/// What the window reads for its page's hello (core/page/hello.rs `HelloFacts`: texts as bytes, a null pointer
/// none; `page_minimum` NaN: none).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MarginHelloFacts {
    pub window_id: i64,
    pub page_minimum: f64,
    pub browser: MarginBytes,
    pub mode: MarginBytes,
    pub state: MarginBytes,
    pub windows: MarginBytes,
    pub themes: MarginBytes,
    pub apps: MarginBytes,
    pub margin_page: MarginBytes,
    pub pane_min: MarginBytes,
    pub app_min: MarginBytes,
    pub pane_loading: MarginBytes,
    pub pane_cut: MarginBytes,
    pub picture: MarginBytes,
    pub hosted_frame: MarginBytes,
    pub hosted_frames: MarginBytes,
    pub theme: MarginBytes,
}

/// The page's hello: its JSON text (freed with `margin_buffer_free`); null for a null page or facts.
///
/// # Safety
/// `page` null or a live page; `facts` null or readable, each text its length's readable bytes; `out_len` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_hello(
    page: *const MarginPage,
    facts: *const MarginHelloFacts,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: the contract above.
    let (Some(p), Some(f)) = (unsafe { page.as_ref() }, unsafe { facts.as_ref() }) else {
        return std::ptr::null_mut();
    };
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    let facts = margin_core::page::hello::HelloFacts {
        window_id: f.window_id,
        browser: f.browser.text().unwrap_or(""),
        mode: f.mode.text().unwrap_or(""),
        state: f.state.text().unwrap_or("null"),
        windows: f.windows.text().unwrap_or("[]"),
        themes: f.themes.text().unwrap_or("[]"),
        apps: f.apps.text().unwrap_or("[]"),
        margin_page: f.margin_page.text(),
        page_minimum: (!f.page_minimum.is_nan()).then_some(f.page_minimum),
        pane_min: f.pane_min.text().unwrap_or(""),
        app_min: f.app_min.text().unwrap_or(""),
        pane_loading: f.pane_loading.text().unwrap_or(""),
        pane_cut: f.pane_cut.text().unwrap_or(""),
        picture: f.picture.text(),
        hosted_frame: f.hosted_frame.text().unwrap_or("null"),
        hosted_frames: f.hosted_frames.text().unwrap_or("[]"),
        theme: f.theme.text(),
    };
    let text = p.page.hello(&facts).into_bytes().into_boxed_slice();
    // SAFETY: writable (the contract).
    unsafe { *out_len = text.len() };
    Box::into_raw(text) as *mut u8
}

/// The positions a page wants, read from its `pointerWant` body's JSON as the Mac reads it (page/said.rs
/// `pointer_want`): its mode (0 none, 1 edges, 2 all), its edges' bits, its zone.
///
/// # Safety
/// `body` null or `len` readable bytes; the outs writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_pointer_want(
    body: *const u8,
    len: usize,
    mode: *mut u8,
    bits: *mut u8,
    zone: *mut f64,
) {
    let o = if body.is_null() {
        None
    } else {
        // SAFETY: the contract above.
        serde_json::from_slice::<serde_json::Value>(unsafe { std::slice::from_raw_parts(body, len) }).ok()
    };
    let empty = margin_core::json::Object::new();
    let want = margin_core::page::said::pointer_want(o.as_ref().and_then(|v| v.as_object()).unwrap_or(&empty)).want();
    // SAFETY: writable (the contract).
    unsafe {
        if let Some(m) = mode.as_mut() {
            *m = match want.mode {
                WantMode::None => 0,
                WantMode::Edges => 1,
                WantMode::All => 2,
            };
        }
        if let Some(b) = bits.as_mut() {
            *b = want.edges;
        }
        if let Some(z) = zone.as_mut() {
            *z = want.zone;
        }
    }
}
