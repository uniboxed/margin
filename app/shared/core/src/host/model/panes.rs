//! Cut panes (docs/CORE-REFACTOR.md step 2 part 3; docs/PEEK-SPLIT.md §4b): where a visible host's window goes for
//! its page area (`frame`: the page area, a card's rect, a split's pane cut at its window's own minimum, a window held
//! at its minimum), whether a pane is cut, the panes a cut pane's window lies under (kept behind them) and the order
//! that keeps each behind the ones it lies under. (The cut pane's arrows and their slide went 2026-11-28: a pane opens
//! to fit its app in the page instead, docs/FLEX-SPLIT.md step 1.)
//!
//! Each is asked where the Mac asked its own copy: `frame` per follower per frame of a drag (typed, nothing
//! allocated), the others per operation and per poll. CGRect's edge rules (geometry.rs `cg`), as the Mac's were
//! written with. A host's minimum read here may be its app's kept one with its process's version unread: answered
//! with that one (as an unreadable version answers) and the host noted (`versions_wanted`), so the OS side reads its
//! version, sets it and asks again, as its own copy read it at that point.

use std::cell::Cell;

use super::{Handle, HostModel, HostState, Minimum, MinimumOf, Mode, Role};
use crate::geometry::{Rect, cg};
use crate::host::layout::{self, Placement, Size};

/// The hosts whose minimum a decision read as their app's kept one, their versions unread (at most 8 noted a call:
/// more are noted at the next ask).
#[derive(Debug, Default)]
pub(super) struct Wanted {
    list: Cell<[Handle; 8]>,
    n: Cell<usize>,
}

impl Wanted {
    pub(super) fn note(&self, h: Handle) {
        let (mut list, n) = (self.list.get(), self.n.get());
        if list[..n].contains(&h) || n == list.len() {
            return;
        }
        list[n] = h;
        self.list.set(list);
        self.n.set(n + 1);
    }
}

/// A minimum as the Mac's typed layout calls took it: none when both sides are zero or less (or not numbers), each
/// side at least zero (margin-ffi's `margin_layout_fit`/`_cut`).
fn as_taken(m: Option<Size>) -> Option<Size> {
    m.filter(|m| m.width > 0.0 || m.height > 0.0).map(|m| Size::new(m.width.max(0.0), m.height.max(0.0)))
}

/// The most visible hosts read without an allocation (a layout has at most `MAX_PANES` panes and a card).
const ROOM: usize = super::LIVE_ROOM;

impl HostModel {
    // ---- the page area of a drag being followed ----

    /// The page area of a drag of the sidebar's edge as it's followed (None: none under way): a split's panes are
    /// laid out away from each other within it.
    pub fn set_live_page(&mut self, page: Option<Rect>) {
        self.live_page = page;
    }
    pub fn live_page(&self) -> Option<Rect> {
        self.live_page
    }

    // ---- the versions a decision wanted ----

    /// Forgets the hosts noted (each typed call starts so).
    pub fn versions_clear(&self) {
        self.wanted.n.set(0);
    }
    /// The hosts noted since: their minimum read as their app's kept one, their versions unread. Into `out`; how many.
    pub fn versions_wanted(&self, out: &mut [Handle]) -> usize {
        let (list, n) = (self.wanted.list.get(), self.wanted.n.get());
        for (o, h) in out.iter_mut().zip(&list[..n]) {
            *o = *h;
        }
        n
    }

    /// A pane's window's minimum as it's laid out now: its own as read, else its app's kept one.
    fn pane_min(&self, h: Handle) -> Option<Size> {
        match self.minimum(h, MinimumOf::Pane) {
            Minimum::None => None,
            Minimum::Known(m) => Some(m),
            Minimum::NeedsVersion(m) => {
                self.wanted.note(h);
                Some(m)
            }
        }
    }

    fn visible_into(&self, buf: &mut [Handle; ROOM]) -> Result<usize, Vec<Handle>> {
        let n = self.visible_hosts(buf);
        if n <= ROOM {
            return Ok(n);
        }
        let mut all = vec![0; n];
        self.visible_hosts(&mut all);
        Err(all)
    }
    /// Whether any visible host passes `f`.
    fn any_visible(&self, mut f: impl FnMut(Handle, &HostState) -> bool) -> bool {
        let mut buf = [0; ROOM];
        let all = self.visible_into(&mut buf);
        let list = match &all {
            Ok(n) => &buf[..*n],
            Err(v) => &v[..],
        };
        list.iter().any(|&o| self.get(o).is_some_and(|s| f(o, s)))
    }
    /// Another visible host's own page area, its tolerance off each side (CG's: none when that's nothing).
    fn page_within(&self, s: &HostState) -> Option<Rect> {
        let tol = self.opts.tolerance;
        cg::inset(&s.rect.unwrap_or(self.placement.page), tol, tol)
    }

    // ---- a host's window frame ----

    /// Where a host's window goes for a page area (`p`, else its own placement): window mode, a card: the page area;
    /// a split's pane: cut at its window's minimum (`pane_frame`); else the page area, or (its own minimum wider or
    /// taller) that minimum, its right edge and top the page area's (`layout::fit`).
    pub fn frame(&self, h: Handle, p: Option<&Placement>) -> Rect {
        let pl = p.copied().unwrap_or_else(|| self.placement_for(h));
        let Some(s) = self.get(h) else { return pl.page };
        if s.mode == Mode::Window {
            return pl.page;
        }
        if s.rect.is_some() {
            if s.role == Role::Card {
                return pl.page;
            }
            return self.pane_frame(h, &pl.page, &pl.area);
        }
        let min = as_taken(s.min_size.map(|(w, h)| Size::new(w, h)));
        layout::fit(&cg::standard(&pl.page), min, &cg::standard(&pl.area))
    }

    /// A pane's window frame (`layout::cut`, away from the other panes), held within the display while it isn't a tile
    /// in Margin's Space (macOS keeps a tile past the display's edge, never a full-screen Space's reservation).
    pub fn pane_frame(&self, h: Handle, pane: &Rect, area: &Rect) -> Rect {
        let (pane, area) = (cg::standard(pane), cg::standard(area));
        let page = cg::standard(&self.live_page.unwrap_or(self.placement.page));
        let f = layout::cut(&pane, as_taken(self.pane_min(h)), &area, &page, None, None);
        let not_tile = self.get(h).is_none_or(|s| !s.tiled || s.no_tiles);
        if !cg::same(&f, &pane) && not_tile { layout::within(&cg::standard(&f), &area) } else { f }
    }

    /// Its placement with its window's frame for its page area (`p`, else its own).
    pub fn fitted(&self, h: Handle, p: Option<&Placement>) -> Placement {
        let mut pl = p.copied().unwrap_or_else(|| self.placement_for(h));
        pl.page = self.frame(h, Some(&pl));
        pl
    }

    /// Its placement as its own full-screen Space reserves it (its window entering, a member placed): a cut pane's
    /// frame held within the display, whatever its tile's would be.
    pub fn entry_fitted(&self, h: Handle) -> Placement {
        let mut pl = self.fitted(h, None);
        if self.is_cut(h) {
            pl.page = layout::within(&cg::standard(&pl.page), &cg::standard(&pl.area));
        }
        pl
    }

    /// Its tile's rect for a page area (`p`, else its own) from Margin's own tile `home`: never narrower than its
    /// window's minimum (None: none).
    pub fn tile_rect(&self, h: Handle, p: Option<&Placement>, home: &Rect) -> Option<Rect> {
        let f = self.fitted(h, p);
        let f =
            Placement { page: cg::standard(&f.page), area: cg::standard(&f.area), display: cg::standard(&f.display) };
        layout::tile(&f, &cg::standard(home))
    }

    // ---- cut panes ----

    /// Whether a visible pane's window is wider or taller than its pane (cut), and so lies partly under another.
    pub fn is_cut(&self, h: Handle) -> bool {
        let Some(s) = self.get(h) else { return false };
        if s.mode == Mode::Window || s.role == Role::Card {
            return false;
        }
        let Some(r) = s.rect else { return false };
        let (f, r, tol) = (cg::standard(&self.frame(h, None)), cg::standard(&r), self.opts.tolerance);
        f.width > r.width + tol || f.height > r.height + tol
    }

    /// The visible panes a cut pane's window (at `at`, else its frame) lies under (it passes its own pane into
    /// theirs), back to front: it's kept behind them. None for one that isn't cut, or whose rest is past the display's
    /// edge or under Margin's window. Into `out` (the first of them when it's shorter); how many.
    pub fn lying_under(&self, h: Handle, at: Option<Rect>, out: &mut [Handle]) -> usize {
        if !self.is_cut(h) {
            return 0;
        }
        let f = at.unwrap_or_else(|| self.frame(h, None));
        let mut n = 0;
        self.any_visible(|o, s| {
            if o != h && s.role != Role::Card && self.page_within(s).is_some_and(|x| cg::meets(&x, &f)) {
                if n < out.len() {
                    out[n] = o;
                }
                n += 1;
            }
            false
        });
        n
    }

    /// Whether a cut pane's window (at `at`, else its frame) lies under another visible pane.
    pub fn tucked(&self, h: Handle, at: Option<Rect>) -> bool {
        self.lying_under(h, at, &mut []) > 0
    }

    /// Whether `h`'s window lies under `o`'s pane: the one rule of it (`tucked_order`'s chain, a raise over a cut pane
    /// in the window order's plan, `over_under`), all through `lying_under`.
    pub fn lies_under(&self, h: Handle, o: Handle) -> bool {
        let mut buf = [0; ROOM];
        let n = self.lying_under(h, None, &mut buf);
        if n <= ROOM {
            return buf[..n].contains(&o);
        }
        let mut all = vec![0; n];
        self.lying_under(h, None, &mut all);
        all.contains(&o)
    }

    /// Cut panes lying under others (`list`), back to front: each behind every one it lies under, else as given (the
    /// focused one, given last, as far in front as that lets it). A loop (two over each other's): the rest as
    /// given. Into `out` (as long as `list`); how many.
    pub fn tucked_order(&self, list: &[Handle], out: &mut [Handle]) -> usize {
        let n = list.len().min(out.len());
        if n <= 1 {
            out[..n].copy_from_slice(&list[..n]);
            return n;
        }
        let mut left = [0; ROOM];
        let mut more = Vec::new();
        let left: &mut [Handle] = if n <= ROOM {
            left[..n].copy_from_slice(&list[..n]);
            &mut left[..n]
        } else {
            more.extend_from_slice(&list[..n]);
            &mut more[..]
        };
        let (mut len, mut done) = (n, 0);
        while len > 0 {
            // (The first one no other left lies under: nothing left must be behind it.)
            let first = (0..len).find(|&i| {
                let h = left[i];
                !(0..len).any(|j| left[j] != h && self.lies_under(left[j], h))
            });
            let Some(i) = first else {
                out[done..done + len].copy_from_slice(&left[..len]);
                return n;
            };
            out[done] = left[i];
            done += 1;
            left.copy_within(i + 1..len, i);
            len -= 1;
        }
        n
    }

    /// Whether a visible cut pane's window is over a pane it lies under, by the window server's on-screen list
    /// (window numbers, front to back). False: it isn't, it lies under none, or a window isn't listed.
    pub fn over_under(&self, h: Handle, front_to_back: &[i64]) -> bool {
        let Some(mine) = self.get(h).map(|s| s.window) else { return false };
        let at = |w: i64| front_to_back.iter().position(|x| *x == w);
        let mut buf = [0; ROOM];
        let n = self.lying_under(h, None, &mut buf);
        let behind = |o: &Handle| match (self.get(*o).and_then(|s| at(s.window)), at(mine)) {
            (Some(a), Some(b)) => a > b,
            _ => false,
        };
        if n <= ROOM {
            return buf[..n].iter().any(behind);
        }
        let mut all = vec![0; n];
        self.lying_under(h, None, &mut all);
        all.iter().any(behind)
    }
}

#[cfg(test)]
mod tests;
