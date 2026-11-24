//! Margin's own window's page (docs/CORE-REFACTOR.md step 3 part 11 and part 7's page area; MarginWindowController.swift's
//! decisions): one per Margin window, owned by the OS's window (the Mac's MarginWindowController, through margin-ffi's
//! page object). What its page card shows and when, where the hosted windows show through and what's around them, how
//! it's kept in front of them, and the page area its page's layout makes:
//!
//! - **The page card's state** (`empty`, `loading`, `shown`, `elsewhere`): hosting, with a window hosted and ready
//!   (no slow step, no show under way) `shown`, else `loading`; not hosting, its card when its item is in another
//!   window, else the launcher (`empty`). Into `loading` from neither `loading` nor `elsewhere`, for a show not known to
//!   be slow, what's drawn stays for the loader's grace (a deadline: the caller's one timer calls `grace_over` then);
//!   the engine's own slow step is `loading` at once.
//! - **The holes** ([`holes`]): one host's hole (its window's bounds in the page area, the page area while it follows a
//!   drag, the old hole while the grace runs) or several visible hosts' (each one's window in its rect, a card's whole
//!   rect a cut), the corners rounded where they meet the page card's, the ground's cut-outs, the pointer's slot
//!   ([`PagePointer`]) and the holes the pane click tap reads.
//! - **The ground's colour** ([`fill`]): the colour most of the page card's corners have, while hosting.
//! - **In front** ([`front`]): the window's level and order, and the poll's read at rest.
//! - **The page area** ([`area`]): from the page's layout report (protocol.rs `PageLayout`, its bytes parsed here),
//!   the hosted window's placement, the launcher's, a split's panes.
//!
//! Sans IO: the window server's reads (a hosted window's bounds) are the caller's, made where the Swift made them and
//! handed in before the decision that needs them; the panel, its level and order, the ground's drawing, the keys and
//! the pushes are the caller's, carried out from the answers in their order. Nothing allocated on a drag's frames once
//! the buffers have grown, the layout report's parse among them (report.rs: read into the layout kept, no `Value`).

pub mod area;
pub mod fill;
pub mod front;
pub mod hello;
pub mod holes;
pub mod report;
pub mod said;

use crate::geometry::{Rect, cg};
use crate::host::layout::Placement;
use crate::passthrough::{Cg, Edges, Holes, PagePointer, Placed};
use crate::protocol::{PageLayout, PagePane};
use fill::Rgba;
use front::{Front, FrontOps, KeepFront, Mechanism};
use holes::Piece;

/// The page card's state as its page is told (`m-page-state` on the theme's root).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PageState {
    #[default]
    Empty,
    Loading,
    Shown,
    Elsewhere,
}

impl PageState {
    pub fn as_str(self) -> &'static str {
        match self {
            PageState::Empty => "empty",
            PageState::Loading => "loading",
            PageState::Shown => "shown",
            PageState::Elsewhere => "elsewhere",
        }
    }
}

/// A visible host's roles (HostRole): main, a split's pane, the preview card.
pub mod role {
    pub const MAIN: u8 = 0;
    pub const PANE: u8 = 1;
    pub const CARD: u8 = 2;
}

/// A visible host's window while several are (HostShownWindow, the part the page reads): its window, its rect (its
/// pane, its hole), its place back to front, its role, whether it's the focused one.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct Shown {
    pub window: i64,
    pub rect: Rect,
    pub z: i64,
    pub role: u8,
    pub focused: bool,
}

/// A hole the pointer goes through to while several hosts are visible, with its window (the pane click tap's).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct PaneHole {
    pub rect: Rect,
    pub window: i64,
    pub card: bool,
}

/// One cut-out of the ground (in the content, top left), its corners (none: square).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct GroundHole {
    pub rect: Rect,
    pub radii: [f64; 4],
    pub has_radii: bool,
}

/// The ground as a placing of the holes leaves it: filled with no hole (the panel's own background the fill: the page
/// card covered), filled around one hole, or around several.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Ground {
    #[default]
    None,
    One,
    Several,
}

/// What a placing of the holes did: the ground (its fill the ground colour, else the window's own), the slot and catch
/// region changed.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HolePlaced {
    pub ground: Ground,
    pub fill: Option<Rgba>,
    pub placed: Placed,
}

/// What a settling of the page card's state did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settled {
    /// The grace began (its deadline `grace_until`): what's drawn stays; `hole_again`, it was shown: its hole placed
    /// again (it follows the window shown).
    Grace { hole_again: bool },
    /// The state applied.
    Applied(Applied),
}

/// The state applied: whether it, its label or its app changed (its page told), and whether it's `shown` (the keys let
/// go of, unless a field of Margin's wants them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Applied {
    pub changed: bool,
    pub shown: bool,
}

/// What `set_hosted` found: the same window as before (`Moved`, a window: its bounds read again, as placed again) or
/// none as before, or another.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostedSaid {
    Same,
    Moved,
    Changed,
}

/// A layout report taken: whether it was one, and whether a split's panes changed with it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayoutSaid {
    pub taken: bool,
    pub panes_changed: bool,
}

/// One Margin window's page.
#[derive(Debug)]
pub struct Page {
    /// Its pointer: the slot, the catch region, the way each pointer event goes (passthrough.rs).
    pub pointer: PagePointer,
    pub front: Front,
    grace: f64,
    startup_label: String,
    layout: Option<PageLayout>,
    // (The next report's buffers: the layout before this one.)
    spare: PageLayout,
    layout_ground: Option<Rgba>,
    hits: Vec<Rect>,
    capture_all: bool,
    full_screen: bool,
    hosting: bool,
    hosted: Option<i64>,
    hosted_frame: Option<Rect>,
    loading: Option<String>,
    loading_app: Option<String>,
    showing: Option<String>,
    showing_app: Option<String>,
    showing_slow: bool,
    /// The browser's copy asked to show it is slow (the session's `set_copy_slow`): its loader says so.
    copy_slow: bool,
    elsewhere: Option<String>,
    elsewhere_app: Option<String>,
    stuck: Option<String>,
    state: PageState,
    loader: Option<String>,
    loader_app: Option<String>,
    grace_until: Option<f64>,
    page_rect: Option<Rect>,
    page_radius: f64,
    visible: Vec<Shown>,
    frames: Vec<(i64, Rect)>,
    following: bool,
    hole: Option<Rect>,
    holes: Vec<Rect>,
    pane_holes: Vec<PaneHole>,
    ground: Option<Rgba>,
    ground_hole: GroundHole,
    ground_holes: Vec<GroundHole>,
    // (Scratch, reused: a placing's list of holes, its cuts, the cut-outs' pieces and theirs.)
    list: Vec<(Rect, usize)>,
    cuts: Vec<(Rect, usize)>,
    rects: Vec<Rect>,
    pieces: Vec<Piece>,
    scratch: [Vec<Rect>; 2],
    /// The rects the last op said read (said.rs).
    said_rects: Vec<Rect>,
}

impl Default for Page {
    fn default() -> Self {
        Page::new(0.12, "")
    }
}

impl Page {
    /// A page with the loader's grace (seconds; 0: none) and the start's loader label (its `starting` look).
    pub fn new(grace: f64, startup_label: &str) -> Page {
        Page {
            pointer: PagePointer::default(),
            front: Front::default(),
            grace,
            startup_label: startup_label.to_owned(),
            layout: None,
            spare: PageLayout::default(),
            layout_ground: None,
            hits: Vec::new(),
            capture_all: false,
            full_screen: false,
            hosting: false,
            hosted: None,
            hosted_frame: None,
            loading: None,
            loading_app: None,
            showing: None,
            showing_app: None,
            showing_slow: false,
            copy_slow: false,
            elsewhere: None,
            elsewhere_app: None,
            stuck: None,
            state: PageState::Empty,
            loader: None,
            loader_app: None,
            grace_until: None,
            page_rect: None,
            page_radius: 0.0,
            visible: Vec::new(),
            frames: Vec::new(),
            following: false,
            hole: None,
            holes: Vec::new(),
            pane_holes: Vec::new(),
            ground: None,
            ground_hole: GroundHole::default(),
            ground_holes: Vec::new(),
            list: Vec::new(),
            cuts: Vec::new(),
            rects: Vec::new(),
            pieces: Vec::new(),
            scratch: [Vec::new(), Vec::new()],
            said_rects: Vec::new(),
        }
    }

    /// The loader's grace and the start's label, and how it's kept in front (the mechanism asked for, the OS's raised
    /// and normal levels).
    pub fn configure(&mut self, grace: f64, startup_label: &str, asked: Mechanism, raised: i64, normal: i64) {
        self.grace = grace;
        startup_label.clone_into(&mut self.startup_label);
        self.front = Front::new(asked, raised, normal);
    }

    // ---- what it holds (read by the caller) ----

    pub fn state(&self) -> PageState {
        self.state
    }
    pub fn loader(&self) -> Option<&str> {
        self.loader.as_deref()
    }
    pub fn loader_app(&self) -> Option<&str> {
        self.loader_app.as_deref()
    }
    pub fn loading(&self) -> Option<&str> {
        self.loading.as_deref()
    }
    pub fn showing(&self) -> Option<&str> {
        self.showing.as_deref()
    }
    pub fn stuck(&self) -> Option<&str> {
        self.stuck.as_deref()
    }
    pub fn hosting(&self) -> bool {
        self.hosting
    }
    pub fn hosted(&self) -> Option<i64> {
        self.hosted
    }
    pub fn hosted_frame(&self) -> Option<Rect> {
        self.hosted_frame
    }
    pub fn following(&self) -> bool {
        self.following
    }
    pub fn hole(&self) -> Option<Rect> {
        self.hole
    }
    pub fn holes(&self) -> &[Rect] {
        &self.holes
    }
    pub fn pane_holes(&self) -> &[PaneHole] {
        &self.pane_holes
    }
    pub fn ground(&self) -> Option<Rgba> {
        self.ground
    }
    pub fn ground_hole(&self) -> &GroundHole {
        &self.ground_hole
    }
    pub fn ground_holes(&self) -> &[GroundHole] {
        &self.ground_holes
    }
    pub fn layout(&self) -> Option<&PageLayout> {
        self.layout.as_ref()
    }
    pub fn page_rect(&self) -> Option<Rect> {
        self.page_rect
    }
    pub fn frame(&self, window: i64) -> Option<Rect> {
        self.frames.iter().find(|(w, _)| *w == window).map(|(_, r)| *r)
    }
    pub fn visible(&self) -> &[Shown] {
        &self.visible
    }
    pub fn grace_until(&self) -> Option<f64> {
        self.grace_until
    }
    /// Margin's start (`starting`): its loader says the start's words, not "Opening …".
    pub fn starting(&self) -> bool {
        self.state == PageState::Loading && self.loader.as_deref() == Some(self.startup_label.as_str())
    }

    // ---- what the page and the window say ----

    /// The page's layout report (`{ geometry }`'s object, its JSON as the page sent it): parsed (protocol.rs
    /// `PageLayout::from_geometry`) and kept; nothing kept if it isn't one.
    pub fn set_layout_bytes(&mut self, bytes: &[u8]) -> LayoutSaid {
        // (Read into the spare layout, its buffers reused: once both have grown, a drag's frame allocates nothing.)
        let mut next = std::mem::take(&mut self.spare);
        if !report::read_into(bytes, &mut next) {
            self.spare = next;
            return LayoutSaid::default();
        }
        self.set_layout(next)
    }

    /// A layout report kept: whether a split's panes changed (another split, or its panes' items or boxes; the first
    /// layout always).
    pub fn set_layout(&mut self, l: PageLayout) -> LayoutSaid {
        let panes_changed =
            self.layout.as_ref().is_none_or(|was| was.split != l.split || !same_panes(&was.panes, &l.panes));
        if self.layout.as_ref().is_none_or(|was| was.fills != l.fills) {
            self.layout_ground = fill::ground(&l.fills);
        }
        // (The layout before kept as the spare, for the next report's buffers.)
        if let Some(was) = self.layout.replace(l) {
            self.spare = was;
        }
        LayoutSaid { taken: true, panes_changed }
    }

    /// What the theme draws over the page area that takes the pointer (`hits`, in the content), and whether it asked
    /// for the whole window.
    pub fn set_hits(&mut self, hits: &[Rect], capture_all: bool) {
        self.hits.clear();
        self.hits.extend_from_slice(hits);
        self.capture_all = capture_all;
    }

    pub fn set_full_screen(&mut self, on: bool) {
        self.full_screen = on;
    }

    // ---- the page area ----

    /// `updatePage`'s page area (the layout, the window's content or display changed): None, left as it is (a layout
    /// from before a resize; laid out as a split's half for a moment); else the page area and its radius, kept (as the
    /// window keeps it: the same rect and radius are no change).
    pub fn update_page(&mut self, content: Rect, display: Option<Rect>) -> Option<(Option<Rect>, f64)> {
        let next = {
            let Some(l) = &self.layout else { return Some(self.keep_page_rect(None, 0.0)) };
            if self.hosting && area::narrowed(self.full_screen, &content, display.as_ref()) {
                return None;
            }
            if self.hosting {
                (self.hosted_placement(content, display).map(|p| p.page), l.radius)
            } else {
                if !area::measured_at(l.width, l.height, &content) {
                    return None;
                }
                (area::page_rect(area::insets(l), l.width, l.height, content), l.radius)
            }
        };
        Some(self.keep_page_rect(next.0, next.1))
    }

    // (MarginWindow `setPageRect`: a change only when the rect (CGRect's equality) or the radius differs.)
    fn keep_page_rect(&mut self, rect: Option<Rect>, radius: f64) -> (Option<Rect>, f64) {
        let same = match (self.page_rect, rect) {
            (None, None) => true,
            (Some(a), Some(b)) => cg::same(&a, &b),
            _ => false,
        };
        if !same || radius != self.page_radius {
            self.page_rect = rect;
            self.page_radius = radius;
        }
        (rect, radius)
    }

    /// Where the hosted window goes while hosting (area.rs `hosted_placement`).
    pub fn hosted_placement(&self, content: Rect, display: Option<Rect>) -> Option<Placement> {
        area::hosted_placement(self.hosting, self.full_screen, self.layout.as_ref(), content, display)
    }

    /// Where a browser's window made ready out of sight goes (area.rs `idle_placement`).
    pub fn idle_placement(&self, content: Rect) -> Option<Placement> {
        area::idle_placement(self.full_screen, self.layout.as_ref(), content)
    }

    /// A split's panes as its page laid them out, on the screen at whole points (`paneLayout`): hosting, a split with
    /// panes; its id and each pane, in the split's order.
    pub fn panes(&self, content: Rect) -> Option<(&str, impl Iterator<Item = (&str, Rect)> + '_)> {
        let l = self.layout.as_ref().filter(|_| self.hosting)?;
        let split = l.split.as_deref().filter(|_| !l.panes.is_empty())?;
        Some((split, l.panes.iter().map(move |p| (p.item.as_str(), area::pane_rect(&p.rect, &content)))))
    }

    // ---- hosting ----

    /// `setHosting`: Some when it changed (with whether several hosts were visible, now none); off, what it hosted
    /// and its loaders forgotten.
    pub fn set_hosting(&mut self, on: bool) -> Option<bool> {
        if on == self.hosting {
            return None;
        }
        self.hosting = on;
        let mut had = false;
        if !on {
            self.hosted = None;
            self.hosted_frame = None;
            had = !self.visible.is_empty();
            if had {
                self.visible.clear();
                self.frames.clear();
            }
            self.loading = None;
            self.showing = None;
            self.loading_app = None;
            self.showing_app = None;
            self.showing_slow = false;
            self.copy_slow = false;
        }
        Some(had)
    }

    /// `setLoading`: the engine's slow step (the app's name; None: over). False: nothing new (the same label, and
    /// with one the same app).
    pub fn set_loading(&mut self, label: Option<&str>, app: Option<&str>) -> bool {
        if label == self.loading.as_deref() && (label.is_none() || app == self.loading_app.as_deref()) {
            return false;
        }
        self.loading = label.map(str::to_owned);
        self.loading_app = label.and(app).map(str::to_owned);
        true
    }

    /// `setShowing`: an item being shown and not ready yet (`slow`: known to take a while: no grace). False: nothing
    /// new. The same item said slow now (or no longer) is new: its grace, if it's running, is over at the next
    /// settle. Another item, or none: the copy's slowness said for the one before goes.
    pub fn set_showing(&mut self, label: Option<&str>, app: Option<&str>, slow: bool) -> bool {
        let slow = label.is_some() && slow;
        if label == self.showing.as_deref() && (label.is_none() || app == self.showing_app.as_deref()) {
            if slow == self.showing_slow {
                return false;
            }
            self.showing_slow = slow;
            return true;
        }
        self.showing = label.map(str::to_owned);
        self.showing_app = label.and(app).map(str::to_owned);
        self.showing_slow = slow;
        self.copy_slow = false;
        true
    }

    /// `setCopySlow`: the browser's copy asked for the item being shown is slow (its link says so), or no longer.
    /// Only while an item is being shown. False: nothing new.
    pub fn set_copy_slow(&mut self, on: bool) -> bool {
        let on = on && self.showing.is_some();
        if on == self.copy_slow {
            return false;
        }
        self.copy_slow = on;
        true
    }

    /// The loader says the browser's copy is slow: loading the item being shown (not an engine's slow step, not
    /// Margin's start), its copy slow.
    pub fn copy_slow(&self) -> bool {
        self.copy_slow && self.state == PageState::Loading && self.loading.is_none() && !self.starting()
    }

    /// `setElsewhere`'s card (its item in another Margin window, or parked; None: none). False: nothing new.
    pub fn set_elsewhere(&mut self, label: Option<&str>, app: Option<&str>) -> bool {
        if label == self.elsewhere.as_deref() && app == self.elsewhere_app.as_deref() {
            return false;
        }
        self.elsewhere = label.map(str::to_owned);
        self.elsewhere_app = label.and(app).map(str::to_owned);
        true
    }

    /// `setStartupStuck`: what holds Margin's start up (None: nothing). False: nothing new.
    pub fn set_stuck(&mut self, why: Option<&str>) -> bool {
        if why == self.stuck.as_deref() {
            return false;
        }
        self.stuck = why.map(str::to_owned);
        true
    }

    /// `setHosted`: the hosted window shown in its page area.
    pub fn set_hosted(&mut self, number: Option<i64>) -> HostedSaid {
        if number == self.hosted {
            return if number.is_some() { HostedSaid::Moved } else { HostedSaid::Same };
        }
        self.hosted = number;
        HostedSaid::Changed
    }

    /// The hosted window's bounds as the window server read them (None: unread, or nothing hosted).
    pub fn set_hosted_frame(&mut self, frame: Option<Rect>) {
        self.hosted_frame = frame;
    }

    /// `setVisibleHosts`: every visible host's window while several are (none: one host). Whether anything but their
    /// rects changed (their windows, roles, places, focus).
    pub fn set_visible(&mut self, list: &[Shown]) -> bool {
        let shape =
            |a: &Shown, b: &Shown| a.window == b.window && a.role == b.role && a.z == b.z && a.focused == b.focused;
        let changed = list.len() != self.visible.len() || list.iter().zip(&self.visible).any(|(a, b)| !shape(a, b));
        self.visible.clear();
        self.visible.extend_from_slice(list);
        changed
    }

    /// The visible hosts' windows' bounds as the window server read them (`readVisible`: those it could read).
    pub fn set_frames(&mut self, frames: impl IntoIterator<Item = (i64, Rect)>) {
        self.frames.clear();
        self.frames.extend(frames);
    }

    /// `followsPage`: the hosted window follows a drag live (the hole is the page area meanwhile). False: no change.
    pub fn set_following(&mut self, on: bool) -> bool {
        if on == self.following {
            return false;
        }
        self.following = on;
        true
    }

    // ---- the page card's state ----

    fn target(&self) -> PageState {
        let ready = self.hosting && self.hosted.is_some() && self.loading.is_none() && self.showing.is_none();
        if !self.hosting {
            if self.elsewhere.is_some() { PageState::Elsewhere } else { PageState::Empty }
        } else if ready {
            PageState::Shown
        } else {
            PageState::Loading
        }
    }

    /// `settlePage`: the grace's deadline dropped, then the state the page card should be in: into `loading` from
    /// neither `loading` nor `elsewhere`, for a show not known to be slow (and no slow step of the engine's), the grace
    /// begun (`now` + the grace); else applied.
    pub fn settle(&mut self, now: f64) -> Settled {
        self.grace_until = None;
        let target = self.target();
        if target == PageState::Loading
            && self.state != PageState::Loading
            && self.state != PageState::Elsewhere
            && self.loading.is_none()
            && !self.showing_slow
            && !self.copy_slow
            && self.grace > 0.0
        {
            self.grace_until = Some(now + self.grace);
            return Settled::Grace { hole_again: self.state == PageState::Shown };
        }
        Settled::Applied(self.apply(target))
    }

    /// `graceOver`: the grace is over (its deadline, or a test's own clock): the state applied.
    pub fn grace_over(&mut self) -> Applied {
        self.grace_until = None;
        let target = self.target();
        self.apply(target)
    }

    fn apply(&mut self, state: PageState) -> Applied {
        let (label, app) = match state {
            PageState::Loading if self.loading.is_some() => (self.loading.as_deref(), self.loading_app.as_deref()),
            PageState::Loading => (self.showing.as_deref(), self.showing_app.as_deref()),
            PageState::Elsewhere => (self.elsewhere.as_deref(), self.elsewhere_app.as_deref()),
            _ => (None, None),
        };
        let changed = state != self.state || label != self.loader.as_deref() || app != self.loader_app.as_deref();
        if changed {
            let (label, app) = (label.map(str::to_owned), app.map(str::to_owned));
            self.loader = label;
            self.loader_app = app;
        }
        self.state = state;
        Applied { changed, shown: state == PageState::Shown }
    }

    // ---- the holes ----

    /// `placeHole` (one host) or `updateHoles` (several visible): the hole or holes, the ground around them and its
    /// colour, the pointer's slot and catch region, the pane click tap's holes. `content` the window's content (top
    /// left).
    pub fn place_hole(&mut self, content: Rect) -> HolePlaced {
        self.ground = if self.hosting { self.layout_ground } else { None };
        if self.visible.len() > 1 {
            return self.place_holes(content);
        }
        self.pane_holes.clear();
        let mut next = None;
        if self.state == PageState::Shown {
            if let Some(page) = self.page_rect {
                // (Between two windows in a switch, the grace running: the hole as it was. The new one is under it.)
                let bounds = if self.hosted.is_some() {
                    Some(if self.following { page } else { self.hosted_frame.unwrap_or(page) })
                } else if self.grace_until.is_some() {
                    self.hole
                } else {
                    None
                };
                next = bounds.and_then(|b| Cg::intersection(&b, &page)).filter(|r| r.width >= 1.0 && r.height >= 1.0);
            }
        }
        let mut ground = Ground::None;
        if let (Some(next), Some(page)) = (next, self.page_rect) {
            let radii = holes::hole_radii(&next, &page, self.layout.as_ref().map_or(&[][..], |l| &l.radii));
            let c = Cg::standard(&content);
            self.ground_hole = GroundHole { rect: Cg::offset(&next, -c.min_x(), -c.min_y()), radii, has_radii: true };
            ground = Ground::One;
        }
        self.hole = next;
        self.holes.clear();
        self.holes.extend(next);
        let insets = self.layout.as_ref().map(area::insets);
        let placed = self.pointer.place(content, insets, &self.hits, self.capture_all, Holes::One(next));
        HolePlaced { ground, fill: self.ground, placed }
    }

    fn place_holes(&mut self, content: Rect) -> HolePlaced {
        self.list.clear();
        self.cuts.clear();
        let page = self.page_rect.filter(|_| self.state == PageState::Shown);
        if let Some(page) = page {
            for (i, v) in self.visible.iter().enumerate() {
                let bounds = if self.following {
                    v.rect
                } else {
                    self.frames.iter().find(|(w, _)| *w == v.window).map_or(v.rect, |(_, r)| *r)
                };
                let r = Cg::intersection(&bounds, &v.rect).and_then(|r| Cg::intersection(&r, &page));
                if let Some(r) = r.filter(|r| r.width >= 1.0 && r.height >= 1.0) {
                    self.list.push((r, i));
                }
            }
        }
        // (A card open: its whole page box cut out of the ground, whatever its window's frame reads and whatever is
        // under it, a split's gap or a toolbar's band: Margin's ground is never drawn across the card's page.)
        let card = |p: &Page, i: usize| p.visible[i].role == role::CARD;
        for k in 0..self.list.len() {
            let (r, i) = self.list[k];
            if !card(self, i) {
                self.cuts.push((r, i));
            }
        }
        if let Some(page) = page {
            for (i, v) in self.visible.iter().enumerate() {
                if v.role != role::CARD {
                    continue;
                }
                if let Some(r) = Cg::intersection(&v.rect, &page).filter(|r| r.width >= 1.0 && r.height >= 1.0) {
                    self.cuts.push((r, i));
                }
            }
        }
        self.holes.clear();
        self.holes.extend(self.cuts.iter().map(|(r, _)| *r));
        let next = self.list.iter().find(|(_, i)| self.visible[*i].focused).or(self.list.last()).map(|(r, _)| *r);
        let mut ground = Ground::None;
        self.ground_holes.clear();
        if let (false, Some(page)) = (self.cuts.is_empty(), self.page_rect) {
            let c = Cg::standard(&content);
            self.rects.clear();
            self.rects.extend(self.cuts.iter().map(|(r, _)| Cg::offset(r, -c.min_x(), -c.min_y())));
            holes::ground_holes(&self.rects, &mut self.pieces, &mut self.scratch);
            let radii = self.layout.as_ref().map_or(&[][..], |l| &l.radii[..]);
            for p in &self.pieces {
                let whole = p.whole.then(|| holes::hole_radii(&self.cuts[p.from].0, &page, radii));
                self.ground_holes.push(GroundHole {
                    rect: p.rect,
                    radii: whole.unwrap_or_default(),
                    has_radii: whole.is_some(),
                });
            }
            ground = Ground::Several;
        }
        self.hole = next;
        // (A card open: its content only; the dimmed page around it Margin's.)
        let card_last = self.list.iter().rev().find(|(_, i)| card(self, *i)).copied();
        self.rects.clear();
        match card_last {
            Some((r, _)) => self.rects.push(r),
            None => self.rects.extend(self.list.iter().map(|(r, _)| *r)),
        }
        let insets = self.layout.as_ref().map(area::insets);
        let placed = self.pointer.place(content, insets, &self.hits, self.capture_all, Holes::Several(&self.rects));
        // (The same holes for the pane click tap, each with its window: a card's alone while one is open.)
        self.pane_holes.clear();
        if self.pointer.slot().is_some() {
            let one = card_last.map(|c| [c]);
            let list = one.as_ref().map_or(&self.list[..], |c| &c[..]);
            for (r, i) in list {
                let v = &self.visible[*i];
                self.pane_holes.push(PaneHole { rect: *r, window: v.window, card: v.role == role::CARD });
            }
        }
        HolePlaced { ground, fill: self.ground, placed }
    }

    // ---- in front ----

    /// The frontmost visible host's window (the focused one, else the last of the highest place; Swift's `max(by:)`
    /// keeps the first of several), else the hosted window: what this window is ordered above.
    fn front_target(&self) -> Option<i64> {
        let focused = self.visible.iter().find(|v| v.focused).map(|v| v.window);
        let top = self.visible.iter().fold(None::<&Shown>, |best, v| match best {
            Some(b) if !(b.z < v.z) => Some(b),
            _ => Some(v),
        });
        focused.or(top.map(|v| v.window)).or(self.hosted)
    }

    /// `keepFront` (the caller checked its window is open and on the current Space): the window's level `level` now.
    pub fn keep_front(&mut self, level: i64, now: &mut dyn FnMut() -> f64) -> KeepFront {
        let target = self.front_target();
        self.front.keep(self.full_screen, level, target, now)
    }

    /// Whether the poll's read of `hosted` is this window's (in full screen, nothing let in front, its hosted window
    /// or a visible host's).
    pub fn front_reads(&self, hosted: i64) -> bool {
        let ours = self.hosted == Some(hosted) || self.visible.iter().any(|v| v.window == hosted);
        self.front.reads(self.full_screen, ours)
    }

    /// `frontRead` (the caller checked `front_reads`, its window open and on the current Space).
    pub fn front_read(
        &mut self,
        hosted: i64,
        layer: i64,
        above: bool,
        level: i64,
        now: &mut dyn FnMut() -> f64,
    ) -> FrontOps {
        self.front.read(hosted, layer, above, level, now)
    }
}

fn same_panes(a: &[PagePane], b: &[PagePane]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| a.item == b.item && cg::same(&a.rect, &b.rect))
}

#[cfg(test)]
mod tests;
