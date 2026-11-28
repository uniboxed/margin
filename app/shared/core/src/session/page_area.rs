//! The page area moving (docs/CORE-REFACTOR.md step 3, part 7; HostedSession `pageRectChanged`, `placeAgain`,
//! `sidebarResizing`, `paneHostRects`), transliterated:
//!
//! - A drag of the sidebar's edge (or a split's divider) the one shown follows live: each frame's page area goes to
//!   the engine at once with the panes' and the card's rects in it (`Ports::follow`), read from the window's page in
//!   the core ([`Frame::Page`]): typed, no JSON, nothing allocated. Else one placing per burst (`placing`), the newest
//!   page area read when its turn comes; nothing placed mid-drag (held till it's let go).
//! - A placing never drops the item: a window that didn't leave full screen stays shown at its frame; one that left
//!   and didn't come back in is shown again once, `refitRetryAfter` later, behind the loader.

use serde_json::{Value, json};

use super::{Core, Field, host_id, layout};
use crate::geometry::Rect;
use crate::host::layout::Placement;
use crate::json;
use crate::page::Pace;
use crate::page::Page;
use crate::protocol::MAX_PANES;

/// The hosts of one frame kept on the stack: a split's panes and a card.
const ROOM: usize = MAX_PANES + 1;

/// Where a frame's page area and its split's panes are read from: the window's page in the core (Margin's own window:
/// its content and display now, as the window reads them), or the ports (a window with no page in the core).
pub enum Frame<'a> {
    /// `card`: where the page draws the preview card's page now (`HostedWindow.cardRect`), as the window reads it.
    Page {
        page: &'a Page,
        content: Rect,
        display: Option<Rect>,
        card: Option<Rect>,
    },
    Ports,
}

/// What a change of a window's page area did: nothing, a drag's frame followed, a placing queued (the caller ticks).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageRect {
    Nothing,
    Followed,
    Queued,
}

impl PageRect {
    pub fn code(self) -> u8 {
        match self {
            PageRect::Nothing => 0,
            PageRect::Followed => 1,
            PageRect::Queued => 2,
        }
    }
}

/// A rect as the Mac's commands carry it (`[x, y, width, height]`).
pub(crate) fn rect_json(r: &Rect) -> Value {
    json!([r.x, r.y, r.width, r.height])
}

/// A placement as the Mac's commands carry it, with the caller's token for it (-1: none).
pub(crate) fn placement_json(p: &Placement, token: i64) -> Value {
    let mut v = json!({ "page": rect_json(&p.page), "area": rect_json(&p.area), "display": rect_json(&p.display) });
    if token >= 0 {
        v["token"] = json!(token);
    }
    v
}

/// The hosts' rects of one frame, their ids copied into a buffer on the stack (a split's panes, [`MAX_PANES`] at most,
/// and a card), so
/// nothing of the session's state is borrowed while the engine is told and nothing is allocated (an id that doesn't
/// fit goes to the heap: never one of Margin's).
pub(crate) struct HostRects {
    text: [u8; 2048],
    used: usize,
    spans: [(usize, usize); ROOM],
    rects: [Rect; ROOM],
    n: usize,
    spill: Vec<(String, Rect)>,
}

impl Default for HostRects {
    fn default() -> Self {
        HostRects {
            text: [0; 2048],
            used: 0,
            spans: [(0, 0); ROOM],
            rects: [Rect::ZERO; ROOM],
            n: 0,
            spill: Vec::new(),
        }
    }
}

impl HostRects {
    /// A host's id given in parts (`safari:`, its profile, `#card`), copied in without making it.
    fn push_parts(&mut self, parts: &[&str], rect: Rect) {
        let len: usize = parts.iter().map(|p| p.len()).sum();
        if self.n < ROOM && self.used + len <= self.text.len() {
            let at = self.used;
            for p in parts {
                self.text[self.used..self.used + p.len()].copy_from_slice(p.as_bytes());
                self.used += p.len();
            }
            self.spans[self.n] = (at, len);
            self.rects[self.n] = rect;
            self.n += 1;
        } else {
            self.spill.push((parts.concat(), rect));
        }
    }

    fn has_parts(&self, parts: &[&str]) -> bool {
        let is = |h: &str| {
            let mut rest = h;
            for p in parts {
                match rest.strip_prefix(p) {
                    Some(r) => rest = r,
                    None => return false,
                }
            }
            rest.is_empty()
        };
        (0..self.n).any(|i| is(self.host(i))) || self.spill.iter().any(|(h, _)| is(h))
    }

    fn push(&mut self, host: &str, rect: Rect) {
        let b = host.as_bytes();
        if self.n < 5 && self.used + b.len() <= self.text.len() {
            self.text[self.used..self.used + b.len()].copy_from_slice(b);
            self.spans[self.n] = (self.used, b.len());
            self.rects[self.n] = rect;
            self.used += b.len();
            self.n += 1;
        } else {
            self.spill.push((host.to_string(), rect));
        }
    }

    fn host(&self, i: usize) -> &str {
        let (at, len) = self.spans[i];
        // (Copied from a str whole: always UTF-8.)
        std::str::from_utf8(&self.text[at..at + len]).unwrap_or("")
    }

    fn is_empty(&self) -> bool {
        self.n == 0 && self.spill.is_empty()
    }

    /// The rects as a list (each host's last: a dictionary's), handed to `f`.
    fn with<R>(&self, f: impl FnOnce(&[(&str, Rect)]) -> R) -> R {
        let mut list: [(&str, Rect); 5] = [("", Rect::ZERO); 5];
        for (i, slot) in list.iter_mut().enumerate().take(self.n) {
            *slot = (self.host(i), self.rects[i]);
        }
        if self.spill.is_empty() {
            return f(&list[..self.n]);
        }
        let mut all: Vec<(&str, Rect)> = list[..self.n].to_vec();
        all.extend(self.spill.iter().map(|(h, r)| (h.as_str(), *r)));
        f(&all)
    }

    /// Each host's rect as a dictionary keeps it (the last said).
    fn get(&self, host: &str) -> Option<Rect> {
        let spilled = self.spill.iter().rev().find(|(h, _)| h == host).map(|(_, r)| *r);
        spilled.or_else(|| (0..self.n).rev().find(|&i| self.host(i) == host).map(|i| self.rects[i]))
    }

    fn rows(&self) -> Value {
        self.with(|l| Value::Array(l.iter().map(|(h, r)| json!([h, r.x, r.y, r.width, r.height])).collect()))
    }
}

impl Frame<'_> {
    fn placement(&self, c: &Core, w: i64) -> Option<Placement> {
        match self {
            Frame::Page { page, content, display, .. } => page.hosted_placement(*content, *display),
            Frame::Ports => c.ports.hosted_placement(w).map(|(p, _)| p),
        }
    }

    fn card_rect(&self, c: &Core, w: i64) -> Option<Rect> {
        match self {
            Frame::Page { card, .. } => *card,
            Frame::Ports => c.ports.card_rect(w),
        }
    }
}

impl Core {
    /// Each visible host's rect in `w`'s split as its page lays it out now (by its item's host), written into `out`:
    /// what a drag's frame and a change of the page area place them at. None: no split shown there, or the page's
    /// isn't it.
    fn pane_host_rects(&self, w: i64, frame: &Frame<'_>, out: &mut HostRects) {
        let has_split = self.read(|s| s.layouts.get(&w).is_some_and(|l| l.split.is_some()));
        if !has_split {
            return;
        }
        let fill = |split: &str, panes: &mut dyn Iterator<Item = (&str, Rect)>, out: &mut HostRects| {
            self.read(|s| {
                let Some(l) = s.layouts.get(&w) else { return };
                if l.split.as_deref() != Some(split) {
                    return;
                }
                for (item, rect) in panes {
                    if !l.has(item) {
                        continue;
                    }
                    if let Some(o) = s.open.get(item) {
                        out.push(&o.host, rect);
                    }
                }
            });
        };
        match frame {
            Frame::Page { page, content, .. } => {
                if let Some((split, mut panes)) = page.panes(*content) {
                    fill(split, &mut panes, out);
                }
            }
            Frame::Ports => {
                if let Some((split, panes)) = self.ports.pane_layout(w) {
                    fill(&split, &mut panes.iter().map(|(i, r)| (i.as_str(), *r)), out);
                }
            }
        }
    }

    /// The preview card's window at its <m-preview-page> as the page lays it out now (HostedPeek `cardHostRects`): the
    /// window's open card, once in place, at the window's card rect; a pane's rect for the same host kept (the
    /// panes' are merged first). Nothing allocated.
    fn card_host_rect(&self, w: i64, frame: &Frame<'_>, out: &mut HostRects) {
        let ready = self.read(|s| s.cards.values().find(|c| c.window == w && c.open).is_some_and(|c| c.ready));
        if !ready {
            return;
        }
        let Some(r) = frame.card_rect(self, w) else { return };
        self.read(|s| {
            let Some(c) = s.cards.values().find(|c| c.window == w && c.open) else { return };
            let parts = ["safari:", c.profile.as_str(), "#card"];
            if !out.has_parts(&parts) {
                out.push_parts(&parts, r);
            }
        });
    }

    /// A Margin window's page area changed (the sidebar's width, another theme, another display; a split's panes
    /// laid out again): taken once per run of changes, the newest placement when its turn comes; held while the
    /// sidebar's edge is dragged (one placing when it's over). A drag the one shown follows live: each page area of it
    /// to the engine at once, with a split's panes and the preview card at their rects in this frame.
    pub(crate) fn page_rect_changed(&self, w: i64, frame: &Frame<'_>) -> PageRect {
        let hosting = self.hosting();
        if self.following.get()
            && self.resizing.get() == Some(w)
            && hosting == Some(w)
            && let Some(p) = frame.placement(self, w)
        {
            let mut rects = HostRects::default();
            self.pane_host_rects(w, frame, &mut rects);
            self.card_host_rect(w, frame, &mut rects);
            rects.with(|l| self.ports.follow(&p, l));
            return PageRect::Followed;
        }
        // (The engine's one shown read after the drag's hold: a read, the same answer either way.)
        if hosting != Some(w) || self.resizing.get() == Some(w) || self.placing.get() {
            return PageRect::Nothing;
        }
        if self.ports.engine_shown().is_none() {
            return PageRect::Nothing;
        }
        self.placing.set(true);
        let Some(c) = self.rc() else { return PageRect::Nothing };
        self.exec.enqueue(async move {
            c.placing.set(false);
            // (Asked before a drag began, its turn come during it: the drag's end places.)
            if c.resizing.get() == Some(w) {
                return;
            }
            c.place_again(w).await;
        });
        PageRect::Queued
    }

    /// The hosted window placed for the page area as it is now. Never at the cost of the item: the engine keeps a
    /// window that didn't leave full screen shown at the frame it had; one that left full screen and didn't come back
    /// in at the new size is hosted still, out of sight: shown again once, `refitRetryAfter` later, behind the loader;
    /// failing that too, the launcher, its item kept in the sidebar.
    pub(crate) async fn place_again(&self, w: i64) {
        if self.hosting() != Some(w) {
            return;
        }
        let Some(id) = self.ports.engine_shown() else { return };
        let Some((placement, token)) = self.ports.hosted_placement(w) else { return };
        // (A split shown: each pane's window at its `<m-pane>` as laid out now, its rects kept with the layout; the
        // preview card over it too, at its <m-preview-page>.)
        let mut rects = HostRects::default();
        self.pane_host_rects(w, &Frame::Ports, &mut rects);
        self.card_host_rect(w, &Frame::Ports, &mut rects);
        // (The card placed there: its rect kept, its own <m-preview-page> report then changes nothing.)
        if let Some(mut c) = self.open_card_in(w)
            && let Some(r) = rects.get(&format!("safari:{}#card", c.profile))
        {
            c.rect = Some(r);
            let p = c.profile.clone();
            self.set_card(&p, Some(c));
        }
        if !rects.is_empty() && self.has_layout(w) {
            self.edit(Field::Layouts, |s| {
                let open = &s.open;
                let Some(l) = s.layouts.get_mut(&w) else { return };
                let at = |item: &str| open.get(item).and_then(|o| rects.get(&o.host));
                if let Some(r) = at(&l.main) {
                    l.main_rect = Some(r);
                }
                for e in &mut l.extras {
                    if let Some(r) = at(&e.item) {
                        e.rect = r;
                    }
                }
            });
        }
        let mut args = json!({ "placement": placement_json(&placement, token) });
        if !rects.is_empty() {
            args["rects"] = rects.rows();
        }
        let placed = json::flag(self.engine("pageRectChanged", args).await.get("placed")) == Some(true);
        self.ports.hosted_moved(w);
        let kept = !placed && self.ports.engine_shown().as_deref() == Some(id.as_str());
        let page = crate::geometry::cg::standard(&placement.page);
        let how = if placed {
            ""
        } else if kept {
            " (not fitted: shown at the frame it had)"
        } else {
            " (not fitted)"
        };
        self.note(format!("page area changed: {}×{}{how}", page.width as i64, page.height as i64));
        if placed || self.ports.engine_shown().is_some() || !self.ports.is_hosted(&id) {
            return;
        }
        let label = self.label(&id).unwrap_or_else(|| host_id::logged(&id));
        self.ports.set_showing(w, Some(&label), Some(super::loading::icon_app(&id)), Pace::Usual);
        self.place_again_retry(w, &id).await;
        // (Its defer: the loader's words cleared, the hosting settled.)
        self.ports.set_showing(w, None, None, Pace::Usual);
        self.settle_hosting();
    }

    async fn place_again_retry(&self, w: i64, id: &str) {
        let after = self.options.borrow().refit_retry_after;
        self.sleep(after).await;
        if self.hosting() != Some(w)
            || self.ports.engine_shown().is_some()
            || !self.ports.is_hosted(id)
            || self.requested_in(w).is_some()
        {
            return;
        }
        let result = self.engine("show", json!({ "host": id })).await;
        let logged = host_id::logged(id);
        match result.get("failed").and_then(Value::as_str) {
            Some(step) => {
                let why = result.get("why").and_then(Value::as_str).unwrap_or("");
                self.note(format!(
                    "{logged}: not shown again after its placing failed ({step}: {why}): hosted still, out of sight; its item is kept"
                ));
            }
            None => self.note(format!("{logged}: shown again after its placing failed")),
        }
    }

    /// A change of a Margin window's sidebar's width began (a drag of its edge: the page says so at the first change of
    /// the width), or is over (its last layout reported first). Begun: the page area's changes are held from now on
    /// (or followed live: the engine says whether); over: the hosted window placed once, at the page area as it is now.
    pub(crate) fn sidebar_resizing(&self, w: i64, on: bool, divider: bool) {
        if on {
            if self.resizing.get().is_some() {
                return;
            }
            self.resizing.set(Some(w));
            if self.hosting() != Some(w) || self.ports.engine_shown().is_none() {
                return;
            }
            let following = self.ports.dragging(true);
            self.following.set(following);
            // (A split's panes follow too: the holes are their rects meanwhile, the engine says them each frame.)
            let follows = following
                && (self.ports.shown_fills_page()
                    || self.read(|s| s.layouts.get(&w).is_some_and(|l| l.split.is_some())));
            self.ports.follows_page(w, follows);
            let (follow, visible) = self.ports.live_followers();
            self.note(layout::drag_line(divider, w, following, follow, visible));
            return;
        }
        if self.resizing.get() != Some(w) {
            return;
        }
        self.resizing.set(None);
        if self.following.get() {
            self.following.set(false);
            self.ports.dragging(false);
            self.ports.follows_page(w, false);
        }
        if self.hosting() != Some(w) || self.ports.engine_shown().is_none() {
            return;
        }
        let Some(c) = self.rc() else { return };
        self.exec.enqueue(async move { c.place_again(w).await });
    }
}
