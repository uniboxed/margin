//! Margin's own window's page (docs/CORE-REFACTOR.md step 3 parts 11-12) for the Mac's MarginWindowController: one
//! object per Margin window (`margin_page_new`/`_free`), used on the main thread only. For now it holds the window's
//! pointer (margin-core's `PagePointer`, passthrough.rs): its slot and catch region placed as its holes change, the
//! theme's window buttons, the positions its page wants, the cut panes, and the way each pointer event goes. From
//! step 3's commit 3 the object is margin-core's `page::Page`, which owns a `PagePointer`: every call here keeps its
//! signature (the C type stays `MarginPage`), and the Page places the slot from its own holes.
//!
//! Typed throughout, nothing allocated per pointer event nor per placing once its buffers have grown (ffi tests
//! no_alloc.rs). The `margin_pass_*` calls are pure, on no object (any thread: the pane click tap reads a slot on its
//! own): the same rules over a slot the caller holds. Null pointers and bad input do no harm.

use margin_core::geometry::{Point, Rect};
use margin_core::passthrough::{
    CatchBuf, CatchRef, Cg, Cut, Edges, Holes, PagePointer, PassThrough, Push, SlotInsets, SlotRef, Want, WantMode,
};

use crate::MarginRect;

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

/// One Margin window's page (for now its pointer; margin-core's `page::Page` from step 3's commit 3).
#[derive(Default)]
pub struct MarginPage {
    pointer: PagePointer,
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
        p.pointer.set_every(every);
    }
}

/// Its slot and catch region placed for its content at `content` (top left) and its page's `layout` (null: none
/// yet), `hits` (in the content) and `capture_all`: one host's `hole` (null: none) or, `several`, these `holes`.
/// Answers what changed: bit 1 the slot (the pointer's way looked at again), bit 2 the catch region.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `layout` and `hole` null or readable; `hits` and `holes` null
/// or as long as said.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_place_slot(
    page: *mut MarginPage,
    content: MarginRect,
    layout: *const MarginInsets,
    hits: *const MarginRect,
    hits_len: usize,
    capture_all: bool,
    hole: *const MarginRect,
    holes: *const MarginRect,
    holes_len: usize,
    several: bool,
) -> u8 {
    // SAFETY: the contract above.
    let Some(p) = (unsafe { page.as_mut() }) else { return 0 };
    // SAFETY: the contract above.
    let (layout, hits) = (unsafe { layout.as_ref() }.map(|l| (*l).into()), unsafe { rects(hits, hits_len) });
    let holes = if several {
        // SAFETY: the contract above.
        Holes::Several(unsafe { rects(holes, holes_len) })
    } else {
        // SAFETY: the contract above.
        Holes::One(unsafe { hole.as_ref() }.map(|h| (*h).into()))
    };
    let placed = p.pointer.place(content.into(), layout, hits, capture_all, holes);
    u8::from(placed.slot) | (u8::from(placed.region) << 1)
}

/// Its slot into `out` (its rects the page's own, valid until its next placing); false: none.
///
/// # Safety
/// `page` null or a live page (one thread at a time); `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_slot(page: *const MarginPage, out: *mut MarginSlotView) -> bool {
    // SAFETY: the contract above.
    let Some(s) = (unsafe { page.as_ref() }).and_then(|p| p.pointer.slot()) else { return false };
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
    unsafe { put(out, catch_view(p.pointer.region())) };
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
    p.pointer.set_buttons(unsafe { controls.as_ref() }.map(|c| (*c).into()), full_screen);
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
        p.pointer.set_want(want(mode, edges, zone));
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
    p.pointer.set_cuts(cutting, unsafe { cuts(list, len) })
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
    let d = p.pointer.moved(at.into(), content.into(), buttons_down, now);
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
    unsafe { page.as_mut() }.is_some_and(|p| p.pointer.again(at.into(), content.into()))
}

/// Whether the hosted window gets the pointer at `at` (its slot's answer).
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_gets(page: *const MarginPage, at: MarginPoint) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_ref() }.is_some_and(|p| p.pointer.gets(at.into()))
}

/// Whether the panel lets the pointer through now.
///
/// # Safety
/// `page` null or a live page (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_page_ignoring(page: *const MarginPage) -> bool {
    // SAFETY: the contract above.
    unsafe { page.as_ref() }.is_some_and(|p| p.pointer.ignoring())
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
