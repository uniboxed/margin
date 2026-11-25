//! Clicks, scrolling and selection reach the page under an overlay (app/platforms/macos/shell/PassThrough.swift; Spike 1, PLAN.md
//! §6): a transparent window still takes the pointer wherever it is, so the overlay lets the pointer through while
//! it's over the theme's page slot, and takes it everywhere else.
//!
//! Over the slot the theme can still draw things that take the pointer (the palette, a menu, a notice, the sidebar
//! out over the page): the overlay's page reports their boxes (`hits`, app/shared/ui/host-app.ts), and the overlay
//! takes the pointer over them, as the in-page host's pass-through does. While a button is held, nothing changes: a
//! drag that started on the page stays the page's, one that started on Margin stays Margin's.
//!
//! **What the shell does (the Swift `PointerWatch`, left out here: it's the OS's).** It watches the pointer
//! wherever it is, with no special permission: every move and drag, and each press (a press in the browser
//! re-orders the overlays above it), in the window server's coordinates (top left). On each move it asks
//! [`PassThrough::decide`] with whether a button is down and what the overlay does now, and applies the answer:
//! on the Mac `NSWindow.ignoresMouseEvents`; on Windows the overlay's `WS_EX_TRANSPARENT` extended style, turned on
//! (the page gets the pointer) and off (Margin's) with `SetWindowLongPtrW(GWL_EXSTYLE)` from a low-level mouse hook
//! (`WH_MOUSE_LL`) or a timer reading `GetCursorPos` and `GetAsyncKeyState(VK_LBUTTON…)`. It runs only while some
//! overlay is shown (Shell.track: started with the first shown overlay, stopped with the last). The decision is
//! after the fact, so the first move over Margin from the page still reaches the browser: [`CatchRegion`] and
//! [`EdgeGuard`] cover that.
//!
//! **The Mac's Margin window** (MarginWindowController.swift, hosting: the page area a hole the hosted window shows
//! through) reads the same rules with CGRect's edges ([`Cg`]) and keeps its pointer here ([`PagePointer`], margin-ffi's
//! page object): the slot cut to the hole, or to each of several visible hosts' holes; the theme's window buttons
//! while windowed; which cut pane the pointer is over; the positions its page wants. Each pointer event is one typed
//! call that allocates nothing.

use crate::geometry::{Point, Rect, cg};
use crate::host::layout::near;
use crate::json::{self, Object};
use std::collections::BTreeSet;

/// The edge rules a slot's rects are read with. The old overlay's are `Rect`'s own, as they always were ([`Plain`]);
/// the Mac's Margin window's are CoreGraphics' CGRect's, which its pass-through was written and tuned with ([`Cg`]:
/// geometry.rs `cg`, each rect standardized first, CG's null; Swift's `min` and `max`). One rule, two edge
/// semantics, as the hosting core has `Rect` and `cg`.
pub trait Edges {
    /// The rect with a non-negative size (CGRect's `minX`, `width`…).
    fn standard(r: &Rect) -> Rect;
    /// CGRect.contains: the min edges in, the max edges out.
    fn contains(r: &Rect, p: Point) -> bool;
    fn offset(r: &Rect, dx: f64, dy: f64) -> Rect;
    /// What two rects share; None: they're apart (CG's null). `Plain`'s: a zero rect when apart.
    fn intersection(a: &Rect, b: &Rect) -> Option<Rect>;
    fn min(a: f64, b: f64) -> f64;
    /// `v`, or 0 when it's less (or NaN).
    fn at_least_zero(v: f64) -> f64;
}

/// `Rect`'s own edges: the old overlay's (Windows' overlay design, core/shell/overlay.rs), unchanged.
pub enum Plain {}

/// CGRect's edges: the Mac's Margin window (PassThrough.swift, MarginWindowController.swift).
pub enum Cg {}

impl Edges for Plain {
    fn standard(r: &Rect) -> Rect {
        *r
    }
    fn contains(r: &Rect, p: Point) -> bool {
        r.contains(p)
    }
    fn offset(r: &Rect, dx: f64, dy: f64) -> Rect {
        r.offset_by(dx, dy)
    }
    fn intersection(a: &Rect, b: &Rect) -> Option<Rect> {
        Some(a.intersection(b))
    }
    fn min(a: f64, b: f64) -> f64 {
        a.min(b)
    }
    fn at_least_zero(v: f64) -> f64 {
        v.max(0.0)
    }
}

impl Edges for Cg {
    // CGRectStandardize, to the bit: a negative size counted from its other edge, the change added to the origin
    // (so a -0 origin is 0, as CG's is), a size of -0 made 0. (geometry.rs `cg::standard` gives the same answers
    // and keeps a -0: the values these rules keep and hand back are CG's own, so they're made as CG makes them.)
    fn standard(r: &Rect) -> Rect {
        let dx = if r.width < 0.0 { r.width } else { 0.0 };
        let dy = if r.height < 0.0 { r.height } else { 0.0 };
        Rect::new(r.x + dx, r.y + dy, r.width.abs(), r.height.abs())
    }
    fn contains(r: &Rect, p: Point) -> bool {
        Self::standard(r).contains(p)
    }
    // (CGRectOffset standardizes.)
    fn offset(r: &Rect, dx: f64, dy: f64) -> Rect {
        Self::standard(r).offset_by(dx, dy)
    }
    // (CGRectIntersection: each standardized, then `cg::intersection`'s rule.)
    fn intersection(a: &Rect, b: &Rect) -> Option<Rect> {
        cg::intersection(&Self::standard(a), &Self::standard(b))
    }
    // Swift's `min(x, y)`: `y < x ? y : x`.
    fn min(a: f64, b: f64) -> f64 {
        if b < a { b } else { a }
    }
    // Swift's `max(0, v)`: `v >= 0 ? v : 0`.
    fn at_least_zero(v: f64) -> f64 {
        if v >= 0.0 { v } else { 0.0 }
    }
}

/// The page slot of one overlay, in the window server's coordinates (top left).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Slot {
    pub rect: Rect,
    pub radius: f64,
    /// What the theme draws over the slot that takes the pointer.
    pub hits: Vec<Rect>,
    /// The page asked for the whole window (more over the slot than it could list).
    pub capture_all: bool,
    /// Several visible hosts (the Mac's Margin window, docs/PEEK-SPLIT.md §1): the pointer goes through only inside
    /// these (each one's hole; a card's content alone while a card is open), the rest of the slot Margin's. None: the
    /// whole slot, as before (the old overlay's, always).
    pub holes: Option<Vec<Rect>>,
}

impl Slot {
    pub fn new(rect: Rect) -> Self {
        Self { rect, ..Self::default() }
    }

    pub fn view(&self) -> SlotRef<'_> {
        SlotRef {
            rect: self.rect,
            radius: self.radius,
            hits: &self.hits,
            capture_all: self.capture_all,
            holes: self.holes.as_deref(),
        }
    }
}

/// A slot as the rules read it, borrowed (a `Slot`'s, the Mac's page's kept one, or one handed in over the FFI).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SlotRef<'a> {
    pub rect: Rect,
    pub radius: f64,
    pub hits: &'a [Rect],
    pub capture_all: bool,
    pub holes: Option<&'a [Rect]>,
}

/// The page's layout report as the slot needs it: the insets of the page slot from the overlay's edges, and its
/// corner radius (the Swift `PageLayout`'s `left`, `top`, `right`, `bottom`, `radius`; the shell reads the rest).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SlotInsets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub radius: f64,
}

pub struct PassThrough;

impl PassThrough {
    /// Whether the page gets the pointer at `point` (the overlay lets it through there).
    pub fn page_gets(point: Point, slot: Option<&Slot>) -> bool {
        Self::gets::<Plain>(point, slot.map(Slot::view))
    }

    /// The same with these edge rules: no slot, capture-all, out of the rect, on a hit, in none of its holes, outside
    /// a rounded corner of the slot: false.
    pub fn gets<E: Edges>(point: Point, slot: Option<SlotRef<'_>>) -> bool {
        let Some(slot) = slot else { return false };
        if slot.capture_all || !E::contains(&slot.rect, point) {
            return false;
        }
        if slot.hits.iter().any(|h| E::contains(h, point)) {
            return false;
        }
        if let Some(holes) = slot.holes
            && !holes.iter().any(|h| E::contains(h, point))
        {
            return false;
        }
        // Outside a rounded corner of the slot: the theme's.
        let rect = E::standard(&slot.rect);
        let r = E::min(E::min(slot.radius, rect.width / 2.0), rect.height / 2.0);
        if r > 0.0 {
            let (min_x, max_x, min_y, max_y) = (rect.min_x(), rect.max_x(), rect.min_y(), rect.max_y());
            let cx = if point.x < min_x + r {
                Some(min_x + r)
            } else if point.x > max_x - r {
                Some(max_x - r)
            } else {
                None
            };
            let cy = if point.y < min_y + r {
                Some(min_y + r)
            } else if point.y > max_y - r {
                Some(max_y - r)
            } else {
                None
            };
            if let (Some(cx), Some(cy)) = (cx, cy)
                && (point.x - cx).hypot(point.y - cy) > r
            {
                return false;
            }
        }
        true
    }

    /// What the overlay should do now (true: let the pointer through). `ignoring` is what it does; a held button
    /// keeps it.
    pub fn decide(point: Point, slot: Option<&Slot>, buttons_down: bool, ignoring: bool) -> bool {
        Self::decides::<Plain>(point, slot.map(Slot::view), buttons_down, ignoring)
    }

    /// The same with these edge rules.
    pub fn decides<E: Edges>(point: Point, slot: Option<SlotRef<'_>>, buttons_down: bool, ignoring: bool) -> bool {
        if buttons_down { ignoring } else { Self::gets::<E>(point, slot) }
    }

    /// The slot from the page's layout report: the overlay's frame (top left) less the insets. `hits` are in the
    /// overlay's coordinates (top left), as the page reports them.
    pub fn slot(frame: Rect, layout: SlotInsets, hits: &[Rect], capture_all: bool) -> Slot {
        let mut out = Vec::with_capacity(hits.len());
        Self::hits_in::<Plain>(frame, hits, &mut out);
        Slot {
            rect: Self::slot_rect::<Plain>(frame, layout),
            radius: layout.radius,
            hits: out,
            capture_all,
            holes: None,
        }
    }

    /// The slot's rect with these edge rules: the frame less the insets, never a negative size.
    pub fn slot_rect<E: Edges>(frame: Rect, layout: SlotInsets) -> Rect {
        let f = E::standard(&frame);
        Rect::new(
            f.min_x() + layout.left,
            f.min_y() + layout.top,
            E::at_least_zero(f.width - layout.left - layout.right),
            E::at_least_zero(f.height - layout.top - layout.bottom),
        )
    }

    /// The page's `hits` (in the frame) on the screen, added to `out`.
    pub fn hits_in<E: Edges>(frame: Rect, hits: &[Rect], out: &mut Vec<Rect>) {
        let f = E::standard(&frame);
        out.extend(hits.iter().map(|h| E::offset(h, f.min_x(), f.min_y())));
    }
}

/// Whether the pointer at `at` goes through a Margin window whose content is at `content` (to what it hosts: the slot's
/// answer), with these edge rules. Windowed, the window's own buttons are the base window's, under the panel where the
/// theme draws its window controls (`controls`, in the content): through there too. The pointer's way on each move
/// ([`PagePointer::passes`]) and a press's (page/press.rs `press_way`, the Mac's press tap reading a copy of the slot).
pub fn passes<E: Edges>(
    at: Point,
    content: Rect,
    slot: Option<SlotRef<'_>>,
    controls: Option<Rect>,
    full_screen: bool,
) -> bool {
    let c = E::standard(&content);
    let local = Point::new(at.x - c.min_x(), at.y - c.min_y());
    let over_buttons = !full_screen && controls.is_some_and(|b| E::contains(&b, local));
    over_buttons || PassThrough::gets::<E>(at, slot)
}

/// Where the pointer goes through to what one of the Mac's Margin windows hosts (MarginWindowController's
/// `placeHole` and `updateHoles`): one host's hole, or several visible hosts' holes (a split's panes, a card).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Holes<'a> {
    /// One host: its hole, if any (none: the pointer is Margin's everywhere).
    One(Option<Rect>),
    /// Several visible hosts: these holes (a card's content alone while one is open; none: Margin's everywhere).
    Several(&'a [Rect]),
}

/// A slot kept for a window's pointer, its buffers reused (nothing allocated once they're as large as they get).
#[derive(Clone, Debug, Default)]
pub struct SlotBuf {
    present: bool,
    rect: Rect,
    radius: f64,
    hits: Vec<Rect>,
    capture_all: bool,
    has_holes: bool,
    holes: Vec<Rect>,
}

impl SlotBuf {
    pub fn view(&self) -> Option<SlotRef<'_>> {
        self.present.then(|| SlotRef {
            rect: self.rect,
            radius: self.radius,
            hits: &self.hits,
            capture_all: self.capture_all,
            holes: self.has_holes.then_some(self.holes.as_slice()),
        })
    }

    /// The Mac's slot (CGRect's edges): the page area from its layout (`frame` the window's content, top left) with
    /// the page's hits, cut to what shows through. One host: the slot's rect within the hole, its corners rounded only
    /// where the hole is the page card's (within 2 pt of the slot's rect, else square). Several: the slot's rect with
    /// the holes. None at all without a layout or a hole, or with nothing left.
    pub fn place(
        &mut self,
        frame: Rect,
        layout: Option<SlotInsets>,
        hits: &[Rect],
        capture_all: bool,
        holes: Holes<'_>,
    ) {
        self.present = false;
        self.hits.clear();
        self.holes.clear();
        self.has_holes = false;
        let Some(layout) = layout else { return };
        if matches!(holes, Holes::One(None) | Holes::Several([])) {
            return;
        }
        self.rect = PassThrough::slot_rect::<Cg>(frame, layout);
        self.radius = layout.radius;
        PassThrough::hits_in::<Cg>(frame, hits, &mut self.hits);
        self.capture_all = capture_all;
        match holes {
            Holes::One(Some(hole)) => {
                if !near(&Cg::standard(&hole), &Cg::standard(&self.rect), 2.0) {
                    self.radius = 0.0;
                }
                let Some(r) = Cg::intersection(&self.rect, &hole) else { return };
                self.rect = r;
            }
            Holes::Several(list) => {
                self.has_holes = true;
                self.holes.extend_from_slice(list);
            }
            Holes::One(None) => return,
        }
        // (CG's: neither null nor empty.)
        let r = Cg::standard(&self.rect);
        self.present = r.width != 0.0 && r.height != 0.0;
    }

    /// The same slot (Swift's `==` of two `Slot?`: CGRect's own equality, each rect standardized).
    pub fn same(&self, other: &SlotBuf) -> bool {
        match (self.view(), other.view()) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                cg::same(&a.rect, &b.rect)
                    && a.radius == b.radius
                    && same_rects(a.hits, b.hits)
                    && a.capture_all == b.capture_all
                    && same_list(a.holes, b.holes)
            }
            _ => false,
        }
    }
}

fn same_rects(a: &[Rect], b: &[Rect]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| cg::same(a, b))
}

fn same_list(a: Option<&[Rect]>, b: Option<&[Rect]>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => same_rects(a, b),
        _ => false,
    }
}

/// Where the overlay's own windows take the pointer whatever the pointer-following says (seen 2026-11-06: a
/// scroll over the sidebar scrolled the page behind it; sometimes nothing in the layout took a click). The window
/// server passes the pointer through a window's fully transparent pixels, and the overlay follows the pointer after
/// the fact. So the region that isn't the page's, known from the layout (everything but the slot, less its rounded
/// corners, plus what the theme draws over it; all of it with `capture_all` or no layout yet), is filled at alpha
/// 0.01: under the overlay's web view, and in a catcher just below the overlay that never lets the pointer through
/// and hands what it gets to the overlay (Overlay.swift OverlayCatcher; on Windows a layered window's region or
/// alpha). Only the page slot lets the pointer through.
#[derive(Clone, Debug, PartialEq)]
pub struct CatchRegion {
    /// The whole frame.
    pub all: bool,
    /// The slot, in the frame's coordinates (top left), cut out.
    pub hole: Option<Rect>,
    pub radius: f64,
    /// Filled again over the hole.
    pub hits: Vec<Rect>,
    /// Several visible hosts: only these cut out of the hole, the rest of it filled.
    pub holes: Option<Vec<Rect>>,
}

impl CatchRegion {
    pub const ALL: CatchRegion = CatchRegion { all: true, hole: None, radius: 0.0, hits: Vec::new(), holes: None };

    /// For an overlay at `frame` (top left) with this slot (window server coordinates).
    pub fn of(frame: Rect, slot: Option<&Slot>) -> CatchRegion {
        let mut buf = CatchBuf::default();
        buf.of::<Plain>(frame, slot.map(Slot::view));
        CatchRegion {
            all: buf.all,
            hole: buf.hole,
            radius: buf.radius,
            hits: buf.hits,
            holes: buf.has_holes.then_some(buf.holes),
        }
    }

    pub fn view(&self) -> CatchRef<'_> {
        CatchRef { all: self.all, hole: self.hole, radius: self.radius, hits: &self.hits, holes: self.holes.as_deref() }
    }

    /// Whether a point (in the frame, top left) is filled: the same answer as `!PassThrough::page_gets`.
    pub fn contains(&self, p: Point, width: f64, height: f64) -> bool {
        self.view().contains::<Plain>(p, width, height)
    }
}

/// A catch region as the rules read it, borrowed.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CatchRef<'a> {
    pub all: bool,
    pub hole: Option<Rect>,
    pub radius: f64,
    pub hits: &'a [Rect],
    pub holes: Option<&'a [Rect]>,
}

impl CatchRef<'_> {
    /// Whether a point (in the frame, top left) is filled, with these edge rules: the same answer as `!gets`.
    pub fn contains<E: Edges>(&self, p: Point, width: f64, height: f64) -> bool {
        if !E::contains(&Rect::new(0.0, 0.0, width, height), p) {
            return false;
        }
        let Some(hole) = self.hole.filter(|_| !self.all) else { return true };
        if self.hits.iter().any(|h| E::contains(h, p)) {
            return true;
        }
        let slot = SlotRef { rect: hole, radius: self.radius, holes: self.holes, ..SlotRef::default() };
        !PassThrough::gets::<E>(p, Some(slot))
    }
}

/// A catch region kept, its buffers reused.
#[derive(Clone, Debug)]
pub struct CatchBuf {
    all: bool,
    hole: Option<Rect>,
    radius: f64,
    hits: Vec<Rect>,
    has_holes: bool,
    holes: Vec<Rect>,
}

impl Default for CatchBuf {
    fn default() -> Self {
        CatchBuf { all: true, hole: None, radius: 0.0, hits: Vec::new(), has_holes: false, holes: Vec::new() }
    }
}

impl CatchBuf {
    pub fn view(&self) -> CatchRef<'_> {
        CatchRef {
            all: self.all,
            hole: self.hole,
            radius: self.radius,
            hits: &self.hits,
            holes: self.has_holes.then_some(self.holes.as_slice()),
        }
    }

    /// The region for an overlay at `frame` (top left) with this slot (window server coordinates), with these edge
    /// rules: all of it without a slot, with capture-all, or with no hole left inside the frame; several holes each
    /// cut to the slot's hole.
    pub fn of<E: Edges>(&mut self, frame: Rect, slot: Option<SlotRef<'_>>) {
        (self.all, self.hole, self.radius, self.has_holes) = (true, None, 0.0, false);
        self.hits.clear();
        self.holes.clear();
        let Some(slot) = slot.filter(|s| !s.capture_all) else { return };
        let f = E::standard(&frame);
        let (dx, dy) = (-f.min_x(), -f.min_y());
        let hole = E::intersection(&E::offset(&slot.rect, dx, dy), &Rect::new(0.0, 0.0, frame.width, frame.height));
        let Some(hole) = hole.filter(|h| h.width > 0.0 && h.height > 0.0) else { return };
        self.all = false;
        self.hole = Some(hole);
        self.radius = E::min(E::min(slot.radius, hole.width / 2.0), hole.height / 2.0);
        self.hits.extend(slot.hits.iter().map(|h| E::offset(h, dx, dy)));
        if let Some(holes) = slot.holes {
            self.has_holes = true;
            self.holes.extend(
                holes
                    .iter()
                    .filter_map(|h| E::intersection(&E::offset(h, dx, dy), &hole))
                    .filter(|h| h.width > 0.0 && h.height > 0.0),
            );
        }
    }

    /// The same region (Swift's `==` of two `CatchRegion`s: CGRect's own equality).
    pub fn same(&self, other: &CatchBuf) -> bool {
        let (a, b) = (self.view(), other.view());
        a.all == b.all
            && match (a.hole, b.hole) {
                (None, None) => true,
                (Some(a), Some(b)) => cg::same(&a, &b),
                _ => false,
            }
            && a.radius == b.radius
            && same_rects(a.hits, b.hits)
            && same_list(a.holes, b.holes)
    }
}

/// Which pointer positions an overlay's page wants handed in (app/shared/host/overlay.ts reportWant; only peek uses
/// them): none while its sidebar is docked, those within `zone` points of its peek edges while the sidebar is
/// hidden, every one while it's out over the page. Before 2026-11-05 every move over an overlay went in, at 30 a
/// second.
#[derive(Clone, Debug, PartialEq)]
pub struct PointerWant {
    pub mode: WantMode,
    /// "left", "right", "top", "bottom".
    pub edges: BTreeSet<String>,
    pub zone: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WantMode {
    None,
    Edges,
    All,
}

impl WantMode {
    pub fn parse(s: &str) -> Option<WantMode> {
        match s {
            "none" => Some(WantMode::None),
            "edges" => Some(WantMode::Edges),
            "all" => Some(WantMode::All),
            _ => None,
        }
    }
}

impl Default for PointerWant {
    fn default() -> Self {
        Self::ALL
    }
}

impl PointerWant {
    pub const DEFAULT_ZONE: f64 = 24.0;
    pub const ALL: PointerWant = PointerWant { mode: WantMode::All, edges: BTreeSet::new(), zone: Self::DEFAULT_ZONE };

    /// From the page's `pointerWant` body: a mode not known (or none) is `all`, as before the page says.
    pub fn from_json(body: &Object) -> Self {
        let mode = json::string(body.get("mode")).and_then(WantMode::parse).unwrap_or(WantMode::All);
        let edges = json::array(body.get("edges"))
            .map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        let zone = json::num(body.get("zone")).unwrap_or(Self::DEFAULT_ZONE);
        PointerWant { mode, edges, zone }
    }

    /// Its typed form (the edges as bits).
    pub fn want(&self) -> Want {
        let bit = |name: &str, b: u8| if self.edges.contains(name) { b } else { 0 };
        let edges =
            bit("left", Want::LEFT) | bit("right", Want::RIGHT) | bit("top", Want::TOP) | bit("bottom", Want::BOTTOM);
        Want { mode: self.mode, edges, zone: self.zone }
    }

    /// Whether a position (in the overlay, top left) is wanted.
    pub fn wants(&self, p: Point, width: f64, height: f64) -> bool {
        self.want().wants(p, width, height)
    }
}

/// A `PointerWant` typed: its edges as bits (the Mac's, handed in over the FFI).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Want {
    pub mode: WantMode,
    pub edges: u8,
    pub zone: f64,
}

impl Want {
    pub const LEFT: u8 = 1;
    pub const RIGHT: u8 = 2;
    pub const TOP: u8 = 4;
    pub const BOTTOM: u8 = 8;
    pub const ALL: Want = Want { mode: WantMode::All, edges: 0, zone: PointerWant::DEFAULT_ZONE };

    /// Whether a position (in the overlay, top left) is wanted: none, all, or within `zone` of a wanted edge.
    pub fn wants(&self, p: Point, width: f64, height: f64) -> bool {
        match self.mode {
            WantMode::None => false,
            WantMode::All => true,
            WantMode::Edges => {
                let has = |e: u8| self.edges & e != 0;
                (has(Self::LEFT) && p.x <= self.zone)
                    || (has(Self::RIGHT) && p.x >= width - self.zone)
                    || (has(Self::TOP) && p.y <= self.zone)
                    || (has(Self::BOTTOM) && p.y >= height - self.zone)
            }
        }
    }
}

/// What keeps the browser's own edge reveal from the pointer (seen 2026-11-05: in full-screen Safari the pointer
/// at the left edge also opened Safari's sidebar behind Margin's). The overlay follows the pointer after the fact,
/// so the first moves at the edge, coming from over the page, still reached the browser. A thin panel at the
/// window's left edge that never lets the pointer through takes them first. Always while its overlay is shown,
/// docked sidebar or not: a quick move from over the page can reach the edge in one step. Not while the overlay
/// takes the whole window anyway (`capture_all`). (Windows: Chrome's full screen has no edge reveal on the left,
/// but its top edge shows the "exit full screen" button; whether a guard is wanted there is unverified.)
pub struct EdgeGuard;

impl EdgeGuard {
    pub const WIDTH: f64 = 4.0;

    /// Its frame (top left) for an overlay at `frame` with this slot, or `None` when none is needed.
    pub fn frame(frame: Rect, slot: Option<&Slot>, width: f64) -> Option<Rect> {
        if width.is_nan() || width <= 0.0 || slot.is_some_and(|s| s.capture_all) {
            return None;
        }
        Some(Rect::new(frame.min_x(), frame.min_y(), width, frame.height))
    }
}

/// A visible host's window for the cut panes' arrows (MarginWindowController `hoverCut`): its window, its rect, and
/// whether it's one of the cut panes. (repr(C): margin-ffi's MarginCut has its layout.)
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct Cut {
    pub window: i64,
    pub rect: Rect,
    pub cut: bool,
}

/// What a pointer event pushes into the Margin window's page (the positions it wants: `pointer`, `pointerLeft`), in
/// its content's coordinates (top left).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Push {
    None,
    At(Point),
    Left(Point),
}

/// What one pointer event decided (MarginWindowController `pointerMoved`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pointer {
    /// The panel lets the pointer through (ignores the mouse).
    pub pass: bool,
    /// The pointer is over the window's content.
    pub inside: bool,
    /// The cut pane it's over changed: the new one (None: none), said to the page.
    pub hover: Option<Option<i64>>,
    pub push: Push,
}

/// One of the Mac's Margin windows' pointer (MarginWindowController's pointer and its slot): what its slot and catch
/// region are, the theme's window buttons, the positions its page wants, which cut pane the pointer is over and
/// whether the panel lets the pointer through now. Owned by margin-ffi's page object (the Page of
/// docs/CORE-REFACTOR.md step 3 part 11 from its commit 3). Nothing allocated per pointer event, nor per placing once
/// its buffers are as large as they get.
#[derive(Clone, Debug)]
pub struct PagePointer {
    slot: SlotBuf,
    was: SlotBuf,
    region: CatchBuf,
    region_was: CatchBuf,
    controls: Option<Rect>,
    full_screen: bool,
    want: Want,
    every: f64,
    ignoring: bool,
    inside: bool,
    last_push: f64,
    cutting: bool,
    cuts: Vec<Cut>,
    hovered: Option<i64>,
}

impl Default for PagePointer {
    fn default() -> Self {
        PagePointer {
            slot: SlotBuf::default(),
            was: SlotBuf::default(),
            region: CatchBuf::default(),
            region_was: CatchBuf::default(),
            controls: None,
            full_screen: false,
            want: Want::ALL,
            every: 1.0 / 30.0,
            ignoring: false,
            inside: false,
            last_push: 0.0,
            cutting: false,
            cuts: Vec::new(),
            hovered: None,
        }
    }
}

/// What a placing changed (`PagePointer::place`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Placed {
    /// The slot: the pointer's way is looked at again (`again`).
    pub slot: bool,
    /// The catch region: drawn again.
    pub region: bool,
}

impl PagePointer {
    /// The positions its page wants handed in at most every `every` seconds (MarginWindowController's
    /// `pointerEvery`).
    pub fn set_every(&mut self, every: f64) {
        self.every = every;
    }

    /// Its slot and catch region for its content at `frame` (top left) and the page's layout, hits and holes.
    pub fn place(
        &mut self,
        frame: Rect,
        layout: Option<SlotInsets>,
        hits: &[Rect],
        capture_all: bool,
        holes: Holes<'_>,
    ) -> Placed {
        std::mem::swap(&mut self.slot, &mut self.was);
        std::mem::swap(&mut self.region, &mut self.region_was);
        self.slot.place(frame, layout, hits, capture_all, holes);
        self.region.of::<Cg>(frame, self.slot.view());
        Placed { slot: !self.slot.same(&self.was), region: !self.region.same(&self.region_was) }
    }

    pub fn slot(&self) -> Option<SlotRef<'_>> {
        self.slot.view()
    }

    pub fn region(&self) -> CatchRef<'_> {
        self.region.view()
    }

    /// The theme's window controls (in the content, top left; None: none drawn) and whether the window is in full
    /// screen (windowed, the window's buttons under them take the pointer).
    pub fn set_buttons(&mut self, controls: Option<Rect>, full_screen: bool) {
        (self.controls, self.full_screen) = (controls, full_screen);
    }

    pub fn set_want(&mut self, want: Want) {
        self.want = want;
    }

    /// The visible hosts' windows, back to front, each marked when it's a cut pane, and whether any pane is cut. True
    /// when the cut pane the pointer was over is forgotten (none cut any more): said to the page.
    pub fn set_cuts(&mut self, cutting: bool, cuts: &[Cut]) -> bool {
        self.cutting = cutting;
        self.cuts.clear();
        self.cuts.extend_from_slice(cuts);
        if !cutting && self.hovered.is_some() {
            self.hovered = None;
            return true;
        }
        false
    }

    /// Whether the panel lets the pointer through now.
    pub fn ignoring(&self) -> bool {
        self.ignoring
    }

    /// Whether the hosted window gets the pointer at `at` (the slot's answer).
    pub fn gets(&self, at: Point) -> bool {
        PassThrough::gets::<Cg>(at, self.slot.view())
    }

    /// Whether the pointer at `at` goes through Margin's panel (to what it hosts). Windowed, the window's buttons are
    /// the base's, under the panel where the theme draws its window controls.
    pub fn passes(&self, at: Point, content: Rect) -> bool {
        passes::<Cg>(at, content, self.slot.view(), self.controls, self.full_screen)
    }

    /// The theme's window controls (in the content; None: none) and whether the window is in full screen, as set.
    pub fn buttons(&self) -> (Option<Rect>, bool) {
        (self.controls, self.full_screen)
    }

    /// The slot changed under a still pointer at `at` with no button held: its way decided again (true: through).
    pub fn again(&mut self, at: Point, content: Rect) -> bool {
        self.ignoring = self.passes(at, content);
        self.ignoring
    }

    /// A pointer event at `at` (the window server's coordinates, top left) over a window whose content is at
    /// `content`: its way (a held button keeps it), the cut pane it's over (with no button held), and the positions
    /// its page wants (at most every `every` seconds of `now`, and its leaving).
    pub fn moved(&mut self, at: Point, content: Rect, buttons_down: bool, now: f64) -> Pointer {
        let c = Cg::standard(&content);
        let local = Point::new(at.x - c.min_x(), at.y - c.min_y());
        self.ignoring = if buttons_down { self.ignoring } else { self.passes(at, content) };
        let inside = Cg::contains(&content, at);
        let hover = if buttons_down { None } else { self.hover_cut(at) };
        let push = if inside {
            self.inside = true;
            if self.want.wants(local, content.width, content.height) && now - self.last_push >= self.every {
                self.last_push = now;
                Push::At(local)
            } else {
                Push::None
            }
        } else if self.inside {
            self.inside = false;
            Push::Left(local)
        } else {
            Push::None
        };
        Pointer { pass: self.ignoring, inside, hover, push }
    }

    // The cut pane the pointer is over (the frontmost), said as it enters and leaves one: nothing per move, nothing
    // at all while none is cut.
    fn hover_cut(&mut self, at: Point) -> Option<Option<i64>> {
        if !self.cutting {
            return None;
        }
        let over = self.cuts.iter().rev().find(|c| c.cut && Cg::contains(&c.rect, at)).map(|c| c.window);
        if over == self.hovered {
            return None;
        }
        self.hovered = over;
        Some(over)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(x: f64, y: f64) -> Point {
        Point::new(x, y)
    }
    const FRAME: Rect = Rect::new(100.0, 50.0, 1280.0, 800.0);
    const DOCKED: SlotInsets = SlotInsets { left: 260.0, top: 8.0, right: 8.0, bottom: 8.0, radius: 10.0 };

    // app/platforms/macos/shell/tests/tests.swift passThrough()
    #[test]
    fn the_slot_and_who_gets_the_pointer() {
        let slot = PassThrough::slot(FRAME, DOCKED, &[], false);
        assert_eq!(slot.rect, Rect::new(360.0, 58.0, 1012.0, 784.0), "the slot from the insets, in screen points");
        let s = Some(&slot);
        assert!(PassThrough::page_gets(p(800.0, 400.0), s), "over the page: the page's");
        assert!(!PassThrough::page_gets(p(200.0, 400.0), s), "over the sidebar: Margin's");
        assert!(!PassThrough::page_gets(p(800.0, 54.0), s), "on the frame above the page: Margin's");
        assert!(!PassThrough::page_gets(p(361.0, 59.0), s), "just inside the slot's corner: Margin's (rounded)");
        assert!(PassThrough::page_gets(p(364.0, 62.0), s), "inside the rounding: the page's");
        assert!(PassThrough::page_gets(p(361.0, 400.0), s), "along an edge, past the corner: the page's");
        assert!(!PassThrough::page_gets(p(800.0, 400.0), None), "no slot reported: Margin's everywhere");
        let palette = PassThrough::slot(FRAME, DOCKED, &[Rect::new(400.0, 100.0, 480.0, 300.0)], false);
        assert_eq!(palette.hits, vec![Rect::new(500.0, 150.0, 480.0, 300.0)], "hits from the overlay's coordinates");
        assert!(!PassThrough::page_gets(p(600.0, 200.0), Some(&palette)), "over the palette: Margin's");
        assert!(PassThrough::page_gets(p(1200.0, 600.0), Some(&palette)), "beside the palette: the page's");
        let all = Slot { capture_all: true, ..slot.clone() };
        assert!(!PassThrough::page_gets(p(800.0, 400.0), Some(&all)), "too much to list: Margin's everywhere");
        assert!(PassThrough::decide(p(200.0, 400.0), s, true, true), "a drag from the page stays the page's");
        assert!(!PassThrough::decide(p(800.0, 400.0), s, true, false), "a drag from Margin stays Margin's");
        assert!(PassThrough::decide(p(800.0, 400.0), s, false, false), "let go: decided again");
    }

    #[test]
    fn insets_wider_than_the_frame_give_an_empty_slot() {
        let slot = PassThrough::slot(
            Rect::new(0.0, 0.0, 100.0, 100.0),
            SlotInsets { left: 80.0, right: 80.0, ..SlotInsets::default() },
            &[],
            false,
        );
        assert_eq!(slot.rect.width, 0.0);
        assert!(!PassThrough::page_gets(p(50.0, 50.0), Some(&slot)));
        assert_eq!(CatchRegion::of(Rect::new(0.0, 0.0, 100.0, 100.0), Some(&slot)), CatchRegion::ALL);
    }

    #[test]
    fn the_catch_region_is_exactly_what_isnt_the_pages() {
        let slot = PassThrough::slot(FRAME, DOCKED, &[], false);
        let region = CatchRegion::of(FRAME, Some(&slot));
        let local = |q: Point| p(q.x - FRAME.x, q.y - FRAME.y);
        let probes = [
            (800.0, 400.0),
            (200.0, 400.0),
            (800.0, 54.0),
            (361.0, 59.0),
            (364.0, 62.0),
            (361.0, 400.0),
            (1300.0, 845.0),
        ];
        assert!(!region.all);
        for (x, y) in probes {
            assert_eq!(
                region.contains(local(p(x, y)), FRAME.width, FRAME.height),
                !PassThrough::page_gets(p(x, y), Some(&slot)),
                "probe {x},{y}"
            );
        }
        let palette = PassThrough::slot(FRAME, DOCKED, &[Rect::new(400.0, 100.0, 480.0, 300.0)], false);
        let pr = CatchRegion::of(FRAME, Some(&palette));
        assert!(pr.contains(local(p(600.0, 200.0)), FRAME.width, FRAME.height), "the palette caught too");
        assert!(!pr.contains(local(p(1200.0, 600.0)), FRAME.width, FRAME.height));
        let all = Slot { capture_all: true, ..slot.clone() };
        assert!(CatchRegion::of(FRAME, None).all && CatchRegion::of(FRAME, Some(&all)).all, "everything before a slot");
        assert!(!region.contains(p(-1.0, 10.0), FRAME.width, FRAME.height), "nothing outside the overlay");
    }

    // app/platforms/macos/shell/tests/tests.swift edgeAndPointer()
    #[test]
    fn the_edge_guard() {
        let hidden = PassThrough::slot(FRAME, SlotInsets::default(), &[], false);
        let docked = PassThrough::slot(FRAME, DOCKED, &[], false);
        let edge = Rect::new(100.0, 50.0, EdgeGuard::WIDTH, 800.0);
        assert_eq!(EdgeGuard::frame(FRAME, Some(&hidden), EdgeGuard::WIDTH), Some(edge), "the sidebar hidden");
        assert_eq!(EdgeGuard::frame(FRAME, Some(&docked), EdgeGuard::WIDTH), Some(edge), "docked too");
        assert_eq!(EdgeGuard::frame(FRAME, None, EdgeGuard::WIDTH), Some(edge), "before a layout");
        let all = Slot { capture_all: true, ..hidden.clone() };
        assert_eq!(EdgeGuard::frame(FRAME, Some(&all), EdgeGuard::WIDTH), None, "the overlay takes the window");
        assert_eq!(EdgeGuard::frame(FRAME, Some(&hidden), 0.0), None, "no width");
    }

    #[test]
    fn pointer_wants() {
        let obj = |v: serde_json::Value| v.as_object().cloned().unwrap_or_default();
        let (w, h) = (1280.0, 800.0);
        let edges = PointerWant::from_json(&obj(json!({"mode": "edges", "edges": ["left"], "zone": 24})));
        assert!(edges.wants(p(3.0, 400.0), w, h) && edges.wants(p(24.0, 400.0), w, h));
        assert!(!edges.wants(p(25.0, 400.0), w, h) && !edges.wants(p(1279.0, 400.0), w, h));
        let right = PointerWant::from_json(&obj(json!({"mode": "edges", "edges": ["right"], "zone": 10})));
        assert!(right.wants(p(1275.0, 1.0), w, h), "a right-hand theme's");
        assert!(!PointerWant::from_json(&obj(json!({"mode": "none"}))).wants(p(0.0, 0.0), w, h), "none while docked");
        assert!(PointerWant::from_json(&obj(json!({"mode": "all"}))).wants(p(600.0, 400.0), w, h));
        assert_eq!(PointerWant::from_json(&obj(json!({}))).mode, WantMode::All, "before the page says");
        let odd = PointerWant::from_json(&obj(json!({"mode": 3, "edges": "left", "zone": "x"})));
        assert_eq!(odd, PointerWant::ALL, "nothing usable: every position");
        let typed = Want { mode: WantMode::Edges, edges: Want::TOP | Want::BOTTOM, zone: 5.0 };
        assert!(
            typed.wants(p(600.0, 5.0), w, h) && typed.wants(p(600.0, 795.0), w, h) && !typed.wants(p(600.0, 6.0), w, h)
        );
        assert_eq!(edges.want(), Want { mode: WantMode::Edges, edges: Want::LEFT, zone: 24.0 }, "its bits");
    }

    // The Mac's: a split of two panes and a card (app/platforms/macos/shell/tests/multi-host-tests.swift).
    const PAGE: Rect = Rect::new(276.0, 41.0, 1228.0, 933.0);
    const LEFT: Rect = Rect::new(276.0, 41.0, 610.0, 933.0);
    const RIGHT: Rect = Rect::new(894.0, 41.0, 610.0, 933.0);
    const CARD: Rect = Rect::new(374.0, 106.0, 1032.0, 803.0);
    const DISPLAY: Rect = Rect::new(0.0, 33.0, 1512.0, 949.0);

    fn gets(at: Point, slot: &Slot) -> bool {
        PassThrough::gets::<Cg>(at, Some(slot.view()))
    }

    #[test]
    fn several_holes_let_the_pointer_through_only_inside_them() {
        let holes = Some(vec![LEFT, RIGHT]);
        let slot =
            Slot { rect: PAGE, radius: 10.0, hits: vec![Rect::new(300.0, 50.0, 20.0, 20.0)], holes, ..Slot::default() };
        assert!(gets(p(500.0, 500.0), &slot) && gets(p(1000.0, 500.0), &slot), "each pane's hole");
        assert!(!gets(p(890.0, 500.0), &slot), "not the gap between them");
        assert!(!gets(p(305.0, 55.0), &slot), "nor a hit over one");
        assert!(
            gets(p(500.0, 500.0), &Slot { rect: PAGE, radius: 10.0, ..Slot::default() }),
            "no holes: the whole slot"
        );
        assert!(
            !gets(p(500.0, 500.0), &Slot { rect: PAGE, holes: Some(vec![]), ..Slot::default() }),
            "an empty list: none"
        );
        // (A hole's edges as CGRect's: its max edges out, a zero-size one never in.)
        let edge = Slot { rect: PAGE, holes: Some(vec![LEFT, Rect::new(1000.0, 500.0, 0.0, 10.0)]), ..Slot::default() };
        assert!(gets(p(276.0, 41.0), &edge) && !gets(p(886.0, 100.0), &edge) && !gets(p(1000.0, 505.0), &edge));
        assert!(
            PassThrough::gets::<Plain>(p(500.0, 500.0), Some(slot.view())),
            "the old overlay's edges read holes too"
        );
    }

    #[test]
    fn the_catch_region_with_holes() {
        let card_only = Slot { rect: PAGE, radius: 10.0, holes: Some(vec![CARD]), ..Slot::default() };
        let mut region = CatchBuf::default();
        region.of::<Cg>(DISPLAY, Some(card_only.view()));
        let r = region.view();
        let (w, h) = (DISPLAY.width, DISPLAY.height);
        assert!(r.contains::<Cg>(p(300.0, 500.0 - 33.0), w, h), "the page around the card caught");
        assert!(!r.contains::<Cg>(p(CARD.mid_x(), CARD.mid_y() - 33.0), w, h), "its content not");
        assert_eq!(r.holes, Some(&[CARD.offset_by(0.0, -33.0)][..]), "each hole in the frame, cut to the slot's");
        // A hole partly out of the slot is cut to it; one wholly out, or touching it, goes.
        let odd = Slot {
            rect: PAGE,
            holes: Some(vec![Rect::new(200.0, 100.0, 200.0, 50.0), Rect::new(0.0, 100.0, 276.0, 50.0)]),
            ..Slot::default()
        };
        region.of::<Cg>(DISPLAY, Some(odd.view()));
        assert_eq!(region.view().holes, Some(&[Rect::new(276.0, 67.0, 124.0, 50.0)][..]));
        let mut probes = 0;
        for x in (0..1512).step_by(37) {
            for y in (33..982).step_by(29) {
                let at = p(f64::from(x) + 0.5, f64::from(y));
                let local = p(at.x, at.y - 33.0);
                assert_eq!(region.view().contains::<Cg>(local, w, h), !gets(at, &odd), "{at:?}");
                probes += 1;
            }
        }
        assert!(probes > 1000);
        assert_eq!(
            CatchRegion::of(DISPLAY, Some(&card_only)).holes,
            Some(vec![CARD.offset_by(0.0, -33.0)]),
            "the old type keeps them"
        );
    }

    fn insets(left: f64, radius: f64) -> Option<SlotInsets> {
        Some(SlotInsets { left, top: 8.0, right: 8.0, bottom: 8.0, radius })
    }

    #[test]
    fn one_hosts_slot_is_the_page_area_within_its_hole() {
        let mut s = SlotBuf::default();
        let page = PassThrough::slot_rect::<Cg>(DISPLAY, insets(248.0, 12.0).unwrap_or_default());
        // The hole the page area itself: its corners the card's.
        s.place(DISPLAY, insets(248.0, 12.0), &[], false, Holes::One(Some(page)));
        assert_eq!(s.view().map(|v| (v.rect, v.radius)), Some((page, 12.0)));
        // Within 2 pt of it, still the card's corners; the rect is the two's common part.
        let near_by = Rect::new(page.x + 2.0, page.y, page.width - 2.0, page.height);
        s.place(DISPLAY, insets(248.0, 12.0), &[], false, Holes::One(Some(near_by)));
        assert_eq!(s.view().map(|v| (v.rect, v.radius)), Some((near_by, 12.0)));
        // A smaller window (window mode): square, the rect its hole.
        let small = Rect::new(page.x + 100.0, page.y + 50.0, 600.0, 400.0);
        s.place(DISPLAY, insets(248.0, 12.0), &[Rect::new(10.0, 20.0, 30.0, 40.0)], true, Holes::One(Some(small)));
        let v = s.view().unwrap_or_default();
        assert_eq!((v.rect, v.radius, v.capture_all, v.holes), (small, 0.0, true, None));
        assert_eq!(v.hits, &[Rect::new(10.0, 53.0, 30.0, 40.0)], "the hits on the screen");
        // Just past 2 pt: square.
        let past = Rect::new(page.x + 2.5, page.y, page.width - 2.5, page.height);
        s.place(DISPLAY, insets(248.0, 12.0), &[], false, Holes::One(Some(past)));
        assert_eq!(s.view().map(|v| v.radius), Some(0.0));
        // No hole, no layout, a hole apart from the page area or only touching it: no slot.
        s.place(DISPLAY, insets(248.0, 12.0), &[], false, Holes::One(None));
        assert!(s.view().is_none());
        s.place(DISPLAY, None, &[], false, Holes::One(Some(page)));
        assert!(s.view().is_none());
        s.place(DISPLAY, insets(248.0, 12.0), &[], false, Holes::One(Some(Rect::new(0.0, 33.0, 248.0, 900.0))));
        assert!(s.view().is_none(), "touching: CG's zero-width rect, empty");
        s.place(DISPLAY, insets(248.0, 12.0), &[], false, Holes::One(Some(Rect::new(0.0, 33.0, 100.0, 900.0))));
        assert!(s.view().is_none(), "apart: CG's null");
    }

    #[test]
    fn several_hosts_slot_keeps_the_page_area_and_the_holes() {
        let mut s = SlotBuf::default();
        s.place(DISPLAY, insets(276.0, 10.0), &[], false, Holes::Several(&[LEFT, RIGHT]));
        let v = s.view().unwrap_or_default();
        assert_eq!(
            (v.rect, v.radius, v.holes),
            (
                PassThrough::slot_rect::<Cg>(DISPLAY, insets(276.0, 10.0).unwrap_or_default()),
                10.0,
                Some(&[LEFT, RIGHT][..])
            )
        );
        s.place(DISPLAY, insets(276.0, 10.0), &[], false, Holes::Several(&[]));
        assert!(s.view().is_none(), "no holes: none");
        s.place(
            DISPLAY,
            Some(SlotInsets { left: 1600.0, ..SlotInsets::default() }),
            &[],
            false,
            Holes::Several(&[LEFT]),
        );
        assert!(s.view().is_none(), "nothing left of the page area: none");
    }

    #[test]
    fn the_windowed_buttons_take_the_pointer_and_a_held_button_keeps_the_way() {
        let content = Rect::new(100.0, 200.0, 1200.0, 800.0);
        let mut ptr = PagePointer::default();
        let page =
            PassThrough::slot_rect::<Cg>(content, SlotInsets { top: 0.0, ..insets(260.0, 10.0).unwrap_or_default() });
        ptr.place(
            content,
            Some(SlotInsets { top: 0.0, ..insets(260.0, 10.0).unwrap_or_default() }),
            &[],
            false,
            Holes::One(Some(page)),
        );
        let controls = Rect::new(270.0, 4.0, 60.0, 14.0); // (drawn over the page area's top edge)
        let on = p(content.x + 280.0, content.y + 10.0);
        assert!(ptr.passes(on, content), "the page area's there: through");
        ptr.set_buttons(Some(controls), false);
        assert!(ptr.passes(on, content), "windowed: the buttons are the base's, the panel lets them through");
        assert!(ptr.passes(p(content.x + 30.0 + 250.0, content.y + 300.0), content), "the page area still");
        ptr.set_buttons(Some(Rect::new(6.0, 7.0, 60.0, 14.0)), false);
        assert!(ptr.passes(p(content.x + 10.0, content.y + 10.0), content), "over the buttons in the sidebar: through");
        ptr.set_buttons(Some(Rect::new(6.0, 7.0, 60.0, 14.0)), true);
        assert!(!ptr.passes(p(content.x + 10.0, content.y + 10.0), content), "full screen: no buttons");
        let sidebar = p(content.x + 100.0, content.y + 400.0);
        let middle = p(page.mid_x(), page.mid_y());
        assert!(ptr.moved(middle, content, false, 1.0).pass);
        assert!(ptr.moved(sidebar, content, true, 1.1).pass, "a drag from the page stays the page's");
        assert!(!ptr.moved(sidebar, content, false, 1.2).pass, "let go: Margin's");
        assert!(!ptr.moved(middle, content, true, 1.3).pass, "a drag from Margin stays Margin's");
        assert!(ptr.again(middle, content) && ptr.ignoring(), "looked at again: the page's");
    }

    #[test]
    fn the_positions_its_page_wants_and_its_leaving() {
        let content = Rect::new(0.0, 33.0, 1512.0, 949.0);
        let mut ptr = PagePointer::default();
        ptr.set_every(0.1);
        let at = |x: f64| p(x, 500.0);
        assert_eq!(ptr.moved(at(10.0), content, false, 1.0).push, Push::At(p(10.0, 467.0)), "every position, at first");
        assert_eq!(ptr.moved(at(11.0), content, false, 1.05).push, Push::None, "not again within `every`");
        assert_eq!(
            ptr.moved(at(12.0), content, true, 1.1).push,
            Push::At(p(12.0, 467.0)),
            "at `every`, a button held too"
        );
        ptr.set_want(Want { mode: WantMode::Edges, edges: Want::LEFT, zone: 24.0 });
        assert_eq!(ptr.moved(at(30.0), content, false, 2.0).push, Push::None, "past the edge's zone");
        assert_eq!(ptr.moved(at(24.0), content, false, 2.0).push, Push::At(p(24.0, 467.0)));
        let out = ptr.moved(p(10.0, 10.0), content, false, 2.5);
        assert_eq!((out.inside, out.push), (false, Push::Left(p(10.0, -23.0))), "left: said once");
        assert_eq!(ptr.moved(p(10.0, 11.0), content, false, 2.6).push, Push::None);
        ptr.set_want(Want { mode: WantMode::None, edges: 0, zone: 24.0 });
        let back = ptr.moved(at(10.0), content, false, 3.0);
        assert_eq!((back.inside, back.push), (true, Push::None), "none wanted while docked");
        assert_eq!(
            ptr.moved(p(1512.0, 500.0), content, false, 3.1).push,
            Push::Left(p(1512.0, 467.0)),
            "the max edge is out"
        );
    }

    #[test]
    fn the_cut_pane_under_the_pointer_said_as_it_changes() {
        let content = Rect::new(0.0, 33.0, 1512.0, 949.0);
        let mut ptr = PagePointer::default();
        let cuts = [Cut { window: 7, rect: LEFT, cut: false }, Cut { window: 8, rect: RIGHT, cut: true }];
        assert!(!ptr.set_cuts(false, &cuts));
        assert_eq!(ptr.moved(p(1000.0, 500.0), content, false, 1.0).hover, None, "nothing while none is cut");
        assert!(!ptr.set_cuts(true, &cuts));
        assert_eq!(ptr.moved(p(1000.0, 500.0), content, false, 1.0).hover, Some(Some(8)), "entered the cut pane");
        assert_eq!(ptr.moved(p(1001.0, 500.0), content, false, 1.0).hover, None, "nothing per move");
        assert_eq!(ptr.moved(p(500.0, 500.0), content, true, 1.0).hover, None, "a button held: nothing");
        assert_eq!(ptr.moved(p(500.0, 500.0), content, false, 1.0).hover, Some(None), "left it for one not cut");
        // Overlapping: the frontmost.
        let over = [Cut { window: 7, rect: PAGE, cut: true }, Cut { window: 9, rect: CARD, cut: true }];
        ptr.set_cuts(true, &over);
        assert_eq!(ptr.moved(p(CARD.mid_x(), CARD.mid_y()), content, false, 1.0).hover, Some(Some(9)));
        assert!(ptr.set_cuts(false, &over), "none cut any more: the one it was over forgotten, said");
        assert!(!ptr.set_cuts(false, &over), "once");
    }

    #[test]
    fn a_placing_says_what_changed() {
        let mut ptr = PagePointer::default();
        let none = ptr.place(DISPLAY, insets(276.0, 10.0), &[], false, Holes::One(None));
        assert_eq!(none, Placed::default(), "nothing to nothing");
        let first = ptr.place(DISPLAY, insets(276.0, 10.0), &[], false, Holes::Several(&[LEFT, RIGHT]));
        assert_eq!(first, Placed { slot: true, region: true });
        assert_eq!(
            ptr.place(DISPLAY, insets(276.0, 10.0), &[], false, Holes::Several(&[LEFT, RIGHT])),
            Placed::default()
        );
        let moved = Rect::new(0.0, 40.0, 1512.0, 949.0);
        let m = ptr.place(moved, insets(276.0, 10.0), &[], false, Holes::Several(&[LEFT, RIGHT]));
        assert!(m.slot && m.region, "the window moved");
        // The region alone: the same slot from another frame with the hole outside it.
        assert!(ptr.region().hole.is_some());
        assert_eq!(ptr.slot().map(|s| s.holes), Some(Some(&[LEFT, RIGHT][..])));
        let gone = ptr.place(moved, insets(276.0, 10.0), &[], false, Holes::Several(&[]));
        assert_eq!(gone, Placed { slot: true, region: true });
        assert!(ptr.slot().is_none() && ptr.region().all);
    }
}
