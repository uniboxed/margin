//! The layout's decisions (docs/CORE-REFACTOR.md step 2 part 1b; docs/PEEK-SPLIT.md §1): every host visible in
//! Margin's page area (the layout: each one's rect, role and place back to front), the one focused (`shown`), the
//! focus asked, the hosts the engine holds by id, a whole layout being applied, a layout held while one host is
//! placed on its own; and what each operation decides of them: the visible hosts' order, a host alone at the page area,
//! a page of its own, the one shown before another comes in, a card below its window's minimum, the layout settled
//! at an operation's end, a layout's steps, the hold, how a host is brought in.
//!
//! Each decision is made at the point the OS side makes it today, between the same two waits: it asks one small
//! question there (no plan made up front, since what an earlier step did is read by a later one). The state is the
//! core's; the OS side keeps a copy of nothing here but the one shown's id, which it sets only through `set_shown`.
//! Ids are the shell's (ASCII); the layout names ids that may have no host yet (a layout's new ones, made as it's
//! applied: `list`). Nothing here allocates on a read, nor on a write that changes nothing.

use std::collections::BTreeMap;

use super::{Handle, HostModel, HostState, Minimum, MinimumOf, Mode, Phase, Role};
use crate::geometry::Rect;
use crate::host::layout::{self, Placement, Size};

/// A host in Margin's page area now: its rect (None: the page area), its role, its place back to front (0 the
/// backmost).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Visible {
    pub rect: Option<Rect>,
    pub role: Role,
    pub z: i64,
}

impl Visible {
    pub const MAIN: Visible = Visible { rect: None, role: Role::Main, z: 0 };
}

/// What the decisions read of the engine's options (the Mac's `HostEngine.Options`, sent whenever they change).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelOptions {
    pub tolerance: f64,
    /// A full-screen window's room above it for its own toolbar window, counted in two visible hosts' overlap.
    pub toolbar_room: f64,
}

impl Default for ModelOptions {
    fn default() -> Self {
        ModelOptions { tolerance: 1.0, toolbar_room: layout::TOOLBAR_ROOM }
    }
}

/// A layout held while one host is placed on its own (`hold`): by a placing of one visible host beside others
/// (`Layout`), or by a page area's change placing every visible one again (`Page`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldKind {
    Layout,
    Page,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hold {
    kept: BTreeMap<String, Visible>,
    focus: Option<String>,
    kind: HoldKind,
    id: String,
}

/// A decision's word on the one shown: as it is, or set (None: nothing shown) through the OS side's setter, which
/// asks `set_shown` and tells Margin's window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShownSet {
    Keep,
    Set(Option<Handle>),
}

/// One of a layout's hosts other than main, as asked, with its window's known minimum (a card's, read by the OS side:
/// its own host's, else its app's kept one).
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutExtra {
    pub id: String,
    pub role: Role,
    pub rect: Rect,
    pub min: Option<Size>,
}

/// Why an extra isn't laid out (`layout_refuse`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Refusal {
    /// In the layout twice (main's id, or an extra's before it).
    Twice,
    /// A card below its window's minimum (this one).
    Below(Size),
}

/// A layout's start (`layout_begin`): the hosts visible before it (back to front), the ones coming in (in the
/// layout's order), the ones shown held at their rects until the newcomers are in (back to front), and whether any is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayoutBegun {
    pub before: Vec<Handle>,
    pub arriving: Vec<String>,
    pub held: Vec<String>,
    pub deferring: bool,
}

/// Where `bring_in` is asked (the Mac's `bringIn`, its points in order).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BringInPoint {
    /// Before anything: its window gone while it was parked?
    Start,
    /// A new app's window taken as it is first?
    Take,
    /// Its route: full screen again, window mode, a tile held below tiles, a tile sized first.
    Route,
    /// After its tile's sizing: switched in, or placed.
    Placed,
}

/// The OS side's facts `bring_in` reads (not the model's).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BringInFacts {
    pub is_new: bool,
    pub is_app: bool,
    pub taken: bool,
    pub retrying: bool,
    pub preparing: bool,
}

/// What `bring_in` decided at its point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BringIn {
    /// Nothing at this point: on to the next.
    Go,
    /// Its window went: its app asked for another (a Dock-icon click).
    Reopen,
    /// A new app's window: its frame and Space taken first.
    Take,
    /// In window mode only because its full screen failed: full screen tried again (its mode full screen now).
    FullScreenAgain,
    Window,
    /// Its tile held below tiles: placed again as a plain member (its placed page forgotten).
    PlacedAgain,
    /// A tile: sized for the page area first.
    SizeFirst,
    /// A member at its page area: switched in.
    SwitchIn,
    /// A member placed for another page area: placed again (said).
    PlacedElsewhere,
    /// Placed full screen.
    PlaceFullScreen,
}

/// The most hosts a layout has (main and three: docs/PEEK-SPLIT.md §1); more are ordered too, with an allocation.
const ROOM: usize = 16;

fn state<'a>(listed: &BTreeMap<String, Handle>, slots: &'a [Option<HostState>], id: &str) -> Option<&'a HostState> {
    listed.get(id).and_then(|h| slots.get(*h as usize)).and_then(Option::as_ref)
}

fn same(a: Option<&str>, b: &str) -> bool {
    a == Some(b)
}

impl HostModel {
    // ---- the engine's hosts by id (its `hosts`) ----

    /// The host the engine holds as `id` (None: it holds none as `id` now). A host made for a layout being applied
    /// takes its role and rect in it from the start (its first placing at its rect).
    pub fn list(&mut self, id: &str, h: Option<Handle>) {
        let Some(h) = h else {
            let was = self.listed.remove(id);
            self.relisted(id, was, None);
            return;
        };
        let was = match self.listed.get_mut(id) {
            Some(v) => Some(std::mem::replace(v, h)),
            None => {
                self.listed.insert(id.to_string(), h);
                None
            }
        };
        self.relisted(id, was, Some(h));
        if self.applying
            && let Some(v) = self.layout.get(id).copied()
            && let Some(s) = self.get_mut(h)
        {
            s.role = v.role;
            s.rect = v.rect;
        }
    }
    pub fn listed(&self, id: &str) -> Option<Handle> {
        self.listed.get(id).copied()
    }
    fn listed_state(&self, id: &str) -> Option<&HostState> {
        state(&self.listed, &self.slots, id)
    }
    fn listed_mut(&mut self, id: &str) -> Option<&mut HostState> {
        let h = self.listed(id)?;
        self.get_mut(h)
    }

    // ---- the layout ----

    pub fn layout_get(&self, id: &str) -> Option<Visible> {
        self.layout.get(id).copied()
    }
    pub fn layout_len(&self) -> usize {
        self.layout.len()
    }
    /// The layout's entries, by id.
    pub fn layout(&self) -> impl Iterator<Item = (&str, &Visible)> {
        self.layout.iter().map(|(k, v)| (k.as_str(), v))
    }
    /// Counts every change of the layout (a caller's "did it change since").
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// One entry set (None: out of the layout).
    pub fn layout_set(&mut self, id: &str, v: Option<Visible>) {
        match v {
            None => {
                if self.layout.remove(id).is_some() {
                    self.generation += 1;
                }
            }
            Some(v) => match self.layout.get_mut(id) {
                Some(was) if *was == v => {}
                Some(was) => {
                    *was = v;
                    self.generation += 1;
                }
                None => {
                    self.layout.insert(id.to_string(), v);
                    self.generation += 1;
                }
            },
        }
    }
    fn replace_layout(&mut self, next: BTreeMap<String, Visible>) {
        if next != self.layout {
            self.layout = next;
            self.generation += 1;
        }
    }
    /// A page area's change moved `id`'s rect with it: its host's and its entry's (nothing when it isn't laid out).
    pub fn layout_move(&mut self, id: &str, rect: Rect) {
        if !self.layout.contains_key(id) {
            return;
        }
        if let Some(s) = self.listed_mut(id) {
            s.rect = Some(rect);
        }
        if let Some(v) = self.layout.get(id).copied() {
            self.layout_set(id, Some(Visible { rect: Some(rect), ..v }));
        }
    }

    // ---- the one shown, the focus asked, the placement, a layout being applied ----

    pub fn shown(&self) -> Option<&str> {
        self.shown.as_deref()
    }
    /// When the one shown was last shown or placed.
    pub fn shown_at(&self) -> f64 {
        self.shown_at
    }
    /// The one shown set (None: none): a new one's time it was shown (its own `visible_at` too); then, outside a whole
    /// layout's change, the layout follows: it alone at the page area unless it's in it, or the one before out of it.
    pub fn set_shown(&mut self, id: Option<&str>, now: f64) {
        let was = self.shown.take();
        if was.as_deref() == id {
            self.shown = was;
            self.follow_shown(None);
            return;
        }
        self.shown = id.map(str::to_string);
        if let Some(id) = id {
            self.shown_at = now;
            if let Some(s) = self.listed_mut(id) {
                s.visible_at = now;
            }
        }
        self.follow_shown(was.as_deref());
    }
    fn follow_shown(&mut self, was: Option<&str>) {
        if self.applying {
            return;
        }
        if let Some(id) = self.shown.as_deref() {
            if self.layout.contains_key(id) {
                return;
            }
            let id = id.to_string();
            self.replace_layout(BTreeMap::from([(id.clone(), Visible::MAIN)]));
            if let Some(s) = self.listed_mut(&id) {
                s.rect = None;
                s.role = Role::Main;
            }
        } else if let Some(was) = was {
            self.layout_set(was, None);
        }
    }
    /// The focus asked (`focus`, a layout's): kept while it's visible. None: with one visible host, always.
    pub fn set_focus(&mut self, id: Option<&str>) {
        if self.focus_wanted.as_deref() != id {
            self.focus_wanted = id.map(str::to_string);
        }
    }
    pub fn focus_wanted(&self) -> Option<&str> {
        self.focus_wanted.as_deref()
    }
    pub fn placement(&self) -> Placement {
        self.placement
    }
    pub fn set_placement(&mut self, p: Placement) {
        self.placement = p;
    }
    /// A whole layout being applied (or held): the layout is the layout's, not the one shown's, until it's done.
    pub fn applying(&self) -> bool {
        self.applying
    }

    // ---- what the decisions read ----

    /// Visible now: in the layout and shown.
    pub fn is_visible(&self, id: &str) -> bool {
        self.layout.contains_key(id) && self.listed_state(id).is_some_and(|s| s.phase == Phase::Shown)
    }

    /// The layout's ids back to front (`z`), the one shown last among equals, then by id.
    fn with_order<R>(&self, f: impl FnOnce(&[&str]) -> R) -> R {
        let shown = self.shown.as_deref();
        fn key<'a>(shown: Option<&str>, id: &'a str, v: &Visible) -> (i64, bool, &'a [u8]) {
            (v.z, same(shown, id), id.as_bytes())
        }
        if self.layout.len() <= ROOM {
            let mut buf: [(&str, &Visible); ROOM] = [("", &Visible::MAIN); ROOM];
            let mut n = 0;
            for (id, v) in &self.layout {
                buf[n] = (id.as_str(), v);
                n += 1;
            }
            buf[..n].sort_unstable_by(|a, b| key(shown, a.0, a.1).cmp(&key(shown, b.0, b.1)));
            let mut ids: [&str; ROOM] = [""; ROOM];
            for (i, (id, _)) in buf[..n].iter().enumerate() {
                ids[i] = id;
            }
            return f(&ids[..n]);
        }
        let mut all: Vec<(&str, &Visible)> = self.layout.iter().map(|(k, v)| (k.as_str(), v)).collect();
        all.sort_unstable_by(|a, b| key(shown, a.0, a.1).cmp(&key(shown, b.0, b.1)));
        let ids: Vec<&str> = all.into_iter().map(|(k, _)| k).collect();
        f(&ids)
    }

    /// The hosts visible now, back to front (`z`), the focused one last among equals, then by id: into `out`, how
    /// many there are (`out` holds the first of them when it's shorter).
    pub fn visible_hosts(&self, out: &mut [Handle]) -> usize {
        self.with_order(|ids| {
            let mut n = 0;
            for id in ids {
                if let Some(h) = self.listed(id)
                    && self.get(h).is_some_and(|s| s.phase == Phase::Shown)
                {
                    if n < out.len() {
                        out[n] = h;
                    }
                    n += 1;
                }
            }
            n
        })
    }
    fn last_visible(&self) -> Option<Handle> {
        let mut out = [0; ROOM];
        let n = self.visible_hosts(&mut out);
        if n == 0 {
            return None;
        }
        if n <= ROOM {
            return Some(out[n - 1]);
        }
        let mut all = vec![0; n];
        self.visible_hosts(&mut all);
        all.last().copied()
    }
    /// The visible host at the page area's own role (main), else the focused one (whatever its phase).
    pub fn main_host(&self) -> Option<Handle> {
        let first = self.with_order(|ids| {
            ids.iter()
                .filter_map(|id| self.listed(id))
                .find(|h| self.get(*h).is_some_and(|s| s.phase == Phase::Shown && s.role == Role::Main))
        });
        first.or_else(|| self.shown.as_deref().and_then(|s| self.listed(s)))
    }
    /// One host at most is visible, main at the page area, and `id` would be too (or isn't held): the one-host way.
    pub fn alone(&self, id: &str) -> bool {
        self.layout.len() <= 1
            && self.layout.values().all(|v| v.role == Role::Main && v.rect.is_none())
            && self.listed_state(id).is_none_or(|s| s.role == Role::Main && s.rect.is_none())
    }
    /// A host's own page area: its rect in its role, else Margin's page area (kept while it's parked).
    pub fn page_of(&self, h: Handle) -> Rect {
        self.get(h).and_then(|s| s.rect).unwrap_or(self.placement.page)
    }
    /// Margin's placement with the host's own page area in it.
    pub fn placement_for(&self, h: Handle) -> Placement {
        Placement { page: self.page_of(h), ..self.placement }
    }
    /// The order hosts are looked at in: 0 the focused one, 1 the others visible, 2 the rest.
    pub fn rank(&self, id: &str) -> u8 {
        if same(self.shown.as_deref(), id) {
            0
        } else if self.is_visible(id) {
            1
        } else {
            2
        }
    }
    /// The one shown before `id` comes in, to be parked as it does: none while both are in the layout (a card or a
    /// pane comes in beside main, never in its place), or when it's `id` itself or not held.
    pub fn before(&self, id: &str) -> Option<Handle> {
        let s = self.shown.as_deref()?;
        if s == id {
            return None;
        }
        let h = self.listed(s)?;
        if self.layout.contains_key(id) && self.layout.contains_key(s) {
            return None;
        }
        Some(h)
    }
    /// A card's rect (`rect`, else its own) narrower or lower than its window's minimum: never laid out so. (A split's
    /// pane never is: its window is cut.) Answers whether it is, and whether its process's version is wanted first
    /// (the minimum its app's kept one, its version unread: read it, set it, ask again; unreadable, this answer holds).
    pub fn below_minimum(&self, h: Handle, rect: Option<Rect>) -> (bool, bool) {
        let Some(s) = self.get(h) else { return (false, false) };
        if s.mode == Mode::Window || s.role != Role::Card {
            return (false, false);
        }
        let m = self.minimum(h, MinimumOf::Pane);
        let needs = matches!(m, Minimum::NeedsVersion(_));
        let (Some(m), Some(r)) = (m.size(), rect.or(s.rect)) else { return (false, needs) };
        (layout::below(&r, m, self.opts.tolerance), needs)
    }
    /// The one shown's own minimum width, the sidebar's edge stopping there (None: none, or nothing shown; several
    /// visible: main's, at the page area; a card's or a pane's never).
    pub fn shown_min_width(&self) -> Option<f64> {
        let s = self.get(self.main_host()?)?;
        if s.phase == Phase::Shown && s.mode != Mode::Window && s.rect.is_none() {
            s.min_size.map(|m| m.0)
        } else {
            None
        }
    }

    // ---- an operation's end ----

    /// The layout as it is at an operation's end: hosts parked or gone out of it (never the one shown), the focus
    /// asked forgotten with one visible host, and the one to show when none is (the frontmost left). None: a layout
    /// is being applied (nothing settled). The caller sets the one shown it answers, then asks `settle_focus`.
    pub fn settle_begin(&mut self) -> Option<Option<Handle>> {
        if self.applying {
            return None;
        }
        self.prune();
        if self.layout.len() <= 1 {
            self.focus_wanted = None;
        }
        Some(if self.shown.is_none() { self.last_visible() } else { None })
    }
    /// The focus asked, when it's visible and isn't the one shown: to show.
    pub fn settle_focus(&self) -> Option<Handle> {
        let f = self.focus_wanted.as_deref()?;
        if same(self.shown.as_deref(), f) || !self.is_visible(f) {
            return None;
        }
        self.listed(f)
    }
    fn prune(&mut self) {
        let n = self.layout.len();
        let (listed, slots, shown) = (&self.listed, &self.slots, self.shown.as_deref());
        self.layout.retain(|k, _| same(shown, k) || state(listed, slots, k).is_some_and(|s| s.phase != Phase::Parked));
        if self.layout.len() != n {
            self.generation += 1;
        }
    }

    // ---- the hold: the layout as it is while one host is placed on its own ----

    /// Holds the layout (true), or there's nothing to hold (false). `Layout`: `id` visible beside others, no layout
    /// being applied; `Page`: several visible. The focus is kept for `Layout`'s release.
    pub fn hold(&mut self, id: &str, kind: HoldKind) -> bool {
        let several = self.layout.len() > 1;
        let ok = match kind {
            HoldKind::Layout => !self.applying && several && self.layout.contains_key(id),
            HoldKind::Page => several,
        };
        if !ok {
            return false;
        }
        let focus = match kind {
            HoldKind::Layout => self.focus_wanted.clone().or_else(|| self.shown.clone()),
            HoldKind::Page => None,
        };
        self.hold = Some(Hold { kept: self.layout.clone(), focus, kind, id: id.to_string() });
        self.applying = true;
        true
    }

    /// The hold let go: each host held that's still shown back in the layout (`Layout`: at its rect and role as held;
    /// `Page`: those still laid out), and the one to show: `Layout` the focus where it was asked (asked again with
    /// several), else the frontmost when the one shown isn't laid out; `Page` the host placed, when nothing is shown.
    pub fn release(&mut self) -> ShownSet {
        let Some(hold) = self.hold.take() else { return ShownSet::Keep };
        self.applying = false;
        let (listed, slots) = (&self.listed, &self.slots);
        let next: BTreeMap<String, Visible> = match hold.kind {
            HoldKind::Layout => hold
                .kept
                .into_iter()
                .filter(|(k, _)| state(listed, slots, k).is_some_and(|s| s.phase == Phase::Shown))
                .collect(),
            HoldKind::Page => hold
                .kept
                .into_iter()
                .filter(|(k, _)| {
                    self.layout.contains_key(k) && state(listed, slots, k).is_some_and(|s| s.phase == Phase::Shown)
                })
                .collect(),
        };
        self.replace_layout(next);
        match hold.kind {
            HoldKind::Layout => {
                let (listed, slots) = (&self.listed, &mut self.slots);
                for (k, v) in &self.layout {
                    if let Some(s) = listed.get(k).and_then(|h| slots.get_mut(*h as usize)).and_then(Option::as_mut) {
                        s.role = v.role;
                        s.rect = v.rect;
                    }
                }
                if let Some(f) = hold.focus.as_deref()
                    && self.is_visible(f)
                {
                    if self.focus_wanted.is_none() && self.layout.len() > 1 {
                        self.focus_wanted = Some(f.to_string());
                    }
                    return if same(self.shown.as_deref(), f) { ShownSet::Keep } else { ShownSet::Set(self.listed(f)) };
                }
                if self.shown.as_deref().is_none_or(|s| !self.layout.contains_key(s)) {
                    return ShownSet::Set(self.last_visible());
                }
                ShownSet::Keep
            }
            HoldKind::Page => {
                if self.shown.is_none() && self.is_visible(&hold.id) {
                    return ShownSet::Set(self.listed(&hold.id));
                }
                ShownSet::Keep
            }
        }
    }

    // ---- a whole layout's steps (`setLayout`) ----

    /// Each extra refused before anything is made for it: one in the layout twice (main's id, or an extra's before
    /// it), a card below its window's known minimum (a pane never: its window is cut). By the extra's index.
    pub fn layout_refuse(&self, main: &str, extras: &[LayoutExtra]) -> Vec<(usize, Refusal)> {
        let mut out = Vec::new();
        let mut accepted: Vec<&str> = Vec::with_capacity(extras.len());
        for (i, x) in extras.iter().enumerate() {
            if x.id == main || accepted.contains(&x.id.as_str()) {
                out.push((i, Refusal::Twice));
                continue;
            }
            if x.role == Role::Card
                && let Some(m) = x.min
                && layout::below(&x.rect, m, self.opts.tolerance)
            {
                out.push((i, Refusal::Below(m)));
                continue;
            }
            accepted.push(&x.id);
        }
        out
    }

    /// A layout's start, the extras accepted: main at `main_rect` (None: the page area), each extra at its rect back
    /// to front. The ones shown already keep their rects until the newcomers are in (`held`), only when every one laid
    /// out again can be in place (a tile's rect, a window's frame) and main stays shown; the others take their role and
    /// rect now. The layout is the layout's from now (`applying`) until `layout_end_alone`.
    pub fn layout_begin(&mut self, main: &str, main_rect: Option<Rect>, extras: &[LayoutExtra]) -> LayoutBegun {
        let mut before = [0; ROOM];
        let n = self.visible_hosts(&mut before);
        let before: Vec<Handle> = if n <= ROOM {
            before[..n].to_vec()
        } else {
            let mut all = vec![0; n];
            self.visible_hosts(&mut all);
            all
        };
        let was = |id: &str| self.listed(id).is_some_and(|h| before.contains(&h));
        let mut next: BTreeMap<String, Visible> = BTreeMap::new();
        next.insert(main.to_string(), Visible { rect: main_rect, role: Role::Main, z: 0 });
        for (i, x) in extras.iter().enumerate() {
            next.insert(x.id.clone(), Visible { rect: Some(x.rect), role: x.role, z: i as i64 + 1 });
        }
        let shown_now = |id: &str| was(id) && self.listed_state(id).is_some_and(|s| s.phase == Phase::Shown);
        let order = std::iter::once(main).chain(extras.iter().map(|x| x.id.as_str()));
        let arriving: Vec<String> = order.filter(|id| !shown_now(id)).map(str::to_string).collect();
        let moved = |id: &str, v: &Visible| self.listed_state(id).is_some_and(|s| s.rect != v.rect || s.role != v.role);
        let in_place = next
            .iter()
            .filter(|(id, v)| shown_now(id) && moved(id, v))
            .all(|(id, _)| self.listed_state(id).is_some_and(|s| (s.tiled && !s.no_tiles) || s.mode == Mode::Window));
        let deferring = !arriving.is_empty() && shown_now(main) && in_place;
        let mut held: Vec<(String, Visible)> = Vec::new();
        let mut apply: Vec<(Handle, Visible)> = Vec::new();
        for (id, v) in &next {
            let Some(h) = self.listed(id) else { continue }; // (a new one's as it's made: `list`)
            if deferring && shown_now(id) && moved(id, v) {
                held.push((id.clone(), *v));
                continue;
            }
            apply.push((h, *v));
        }
        for (h, v) in apply {
            if let Some(s) = self.get_mut(h) {
                s.role = v.role;
                s.rect = v.rect;
            }
        }
        self.applying = true;
        self.replace_layout(next);
        for (id, v) in &held {
            let (rect, role) = self.listed_state(id).map_or((None, v.role), |s| (s.rect, s.role));
            self.layout_set(id, Some(Visible { rect, role, z: v.z }));
        }
        held.sort_by_key(|(_, v)| v.z);
        let held_ids = held.iter().map(|(id, _)| id.clone()).collect();
        self.held = held;
        LayoutBegun { before, arriving, held: held_ids, deferring }
    }

    /// The ones held, laid out again now the others came in: each at its role and rect as asked; their hosts back
    /// to front.
    pub fn layout_relay_held(&mut self) -> Vec<Handle> {
        let held = std::mem::take(&mut self.held);
        let mut out = Vec::with_capacity(held.len());
        for (id, v) in held {
            if let Some(s) = self.listed_mut(&id) {
                s.role = v.role;
                s.rect = v.rect;
            }
            self.layout_set(&id, Some(v));
            if let Some(h) = self.listed(&id) {
                out.push(h);
            }
        }
        out
    }

    /// A layout's end: no longer applied; the layout what's visible of it; one left of several asked: it alone, at
    /// the page area (its host to place there again).
    pub fn layout_end_alone(&mut self) -> Option<Handle> {
        self.applying = false;
        self.held.clear();
        let n = self.layout.len();
        let (listed, slots) = (&self.listed, &self.slots);
        self.layout.retain(|k, _| state(listed, slots, k).is_some_and(|s| s.phase == Phase::Shown));
        if self.layout.len() != n {
            self.generation += 1;
        }
        if self.layout.len() != 1 {
            return None;
        }
        let id = self.layout.keys().next()?.clone();
        let h = self.listed(&id)?;
        let s = self.get(h)?;
        if s.rect.is_none() && s.role == Role::Main {
            return None;
        }
        self.layout_set(&id, Some(Visible::MAIN));
        let s = self.get_mut(h)?;
        s.rect = None;
        s.role = Role::Main;
        Some(h)
    }

    /// The focus a layout ends with: the one asked when it's visible, else main, else the frontmost (asked again
    /// with several; with one, none asked); the one shown set to it, or to none when the one shown isn't laid out.
    pub fn layout_focus(&mut self, focused: Option<&str>, main: &str) -> ShownSet {
        let want = match focused.filter(|f| self.layout.contains_key(*f)) {
            Some(f) => self.listed(f),
            None if self.layout.contains_key(main) => self.listed(main),
            None => self.last_visible(),
        };
        let several = self.layout.len() > 1;
        let want_id = want.and_then(|h| self.get(h)).map(|s| s.id.clone());
        self.set_focus(if several { want_id.as_deref() } else { None });
        match want_id {
            Some(w) if !same(self.shown.as_deref(), &w) => ShownSet::Set(want),
            Some(_) => ShownSet::Keep,
            None if self.shown.as_deref().is_some_and(|s| !self.layout.contains_key(s)) => ShownSet::Set(None),
            None => ShownSet::Keep,
        }
    }

    // ---- a host brought in (`bringIn`) ----

    /// What's done with a host being shown, at each of `bringIn`'s points in turn (between them its waits: a
    /// reopen, a take, a tile's sizing). At `Route`, full screen again sets its mode back to full screen; a tile held
    /// below tiles forgets the page it was placed for.
    pub fn bring_in(&mut self, h: Handle, at: BringInPoint, f: BringInFacts) -> BringIn {
        let tol = self.opts.tolerance;
        let page = self.page_of(h);
        let Some(s) = self.get_mut(h) else { return BringIn::Go };
        match at {
            BringInPoint::Start if s.gone => BringIn::Reopen,
            BringInPoint::Take if f.is_new && f.is_app && !f.taken => BringIn::Take,
            BringInPoint::Route => {
                if s.mode == Mode::Window && s.retry_full_screen && !f.is_new && !f.retrying && !f.preparing {
                    s.retry_full_screen = false;
                    s.mode = Mode::FullScreen;
                    BringIn::FullScreenAgain
                } else if s.mode == Mode::Window {
                    BringIn::Window
                } else if s.member && s.tiled && s.no_tiles {
                    s.placed_page = None;
                    BringIn::PlacedAgain
                } else if s.member && s.tiled {
                    BringIn::SizeFirst
                } else {
                    BringIn::Go
                }
            }
            BringInPoint::Placed => {
                if s.member && s.placed_page.is_some_and(|p| layout::near(&p, &page, tol)) {
                    BringIn::SwitchIn
                } else if s.member {
                    BringIn::PlacedElsewhere
                } else {
                    BringIn::PlaceFullScreen
                }
            }
            _ => BringIn::Go,
        }
    }
}

#[cfg(test)]
mod tests;
