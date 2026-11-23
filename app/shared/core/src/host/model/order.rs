//! The visible hosts' window order (docs/CORE-REFACTOR.md step 2 part 2; docs/PEEK-SPLIT.md §1, §4b): the order wanted
//! back to front (cut panes lying under others behind the ones they lie under, then the others, the focused one last
//! unless it's cut), the pairs whose order shows (their windows overlap, a full-screen window with its toolbar's room
//! above it), the pairs out of order in the window server's, and which hosts to raise in what order, each over the cut
//! pane it lies over or not. The one place a plan is made up front, as the Mac's own decided everything first and then
//! raised: the OS side reads each window's bounds and the window server's order, asks once, and raises as answered;
//! while it waits for the focused one to show in front it asks `top_behind` (typed: every few milliseconds).
//!
//! "Lies under" is panes.rs's one rule (`lying_under`): the tucked ones, the order among them, the raise over one.

use super::{Handle, HostModel, Mode, Phase};
use crate::geometry::{Rect, cg};

/// The most visible hosts ordered without an allocation (a layout has at most four).
const ROOM: usize = 16;

/// How the focused one's place in front is confirmed after the raises (`FrontPlan`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confirm {
    /// Not at all.
    None,
    /// Read again until it shows in front (the ladder after: the OS side's).
    Wait,
    /// Its window came in with its tile a moment ago: behind at the first read, out and back at once.
    Fresh,
}

/// What `front_plan` decided: the order wanted (back to front), the focused one and whether it's cut, the hosts to
/// raise in that order (each over the cut pane it lies over, else a plain raise), whether the focused one's keys come
/// after (its window raised, or without a raise when it's cut) and the rest is done, how its place in front is
/// confirmed otherwise, and the hosts that overlap it (by their place in `wanted`) for `top_behind`.
#[derive(Clone, Debug, PartialEq)]
pub struct FrontPlan {
    pub wanted: Vec<Handle>,
    pub focused: Option<Handle>,
    pub cut_focused: bool,
    pub raises: Vec<(Handle, Option<Handle>)>,
    pub keys: bool,
    pub confirm: Confirm,
    pub below_top: Vec<usize>,
}

/// The windows of `windows` (back to front as wanted) in the window server's order, back to front, from its on-screen
/// list (front to back), into `out`. None: one of them isn't listed (or one is listed twice).
pub fn server_order(windows: &[i64], screen: &[i64], out: &mut [i64]) -> Option<usize> {
    let mine = |w: &i64| windows.contains(w);
    // (Each window once: the count of distinct ones.)
    let distinct = windows.iter().enumerate().filter(|(i, w)| !windows[..*i].contains(w)).count();
    let mut n = 0;
    for w in screen.iter().rev().filter(|w| mine(w)) {
        if n < out.len() {
            out[n] = *w;
        }
        n += 1;
    }
    let listed = |w: &i64| screen.contains(w);
    (n == distinct && windows.iter().all(listed)).then_some(n)
}

/// Each pair (by place in `windows`, back to front as wanted) whose front one is behind the other in the window
/// server's `order` (back to front; a window not in it at 0).
fn out_of_order(windows: &[i64], order: &[i64], pairs: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let at = |w: i64| order.iter().position(|x| *x == w).unwrap_or(0);
    pairs.iter().copied().filter(|&(i, j)| at(windows[j]) < at(windows[i])).collect()
}

/// Whether the focused one (the last of `windows`) is behind a host it overlaps (`below_top`, by place) in the window
/// server's order now (its on-screen list, front to back). Unread (None, or a window not listed): no.
pub fn top_behind(windows: &[i64], below_top: &[usize], screen: Option<&[i64]>) -> bool {
    let (Some(screen), Some(top)) = (screen, windows.len().checked_sub(1)) else { return false };
    let mut buf = [0; ROOM];
    let mut more = Vec::new();
    let order: &[i64] = match server_order(windows, screen, &mut buf) {
        None => return false,
        Some(n) if n <= ROOM => &buf[..n],
        Some(n) => {
            more.resize(n, 0);
            server_order(windows, screen, &mut more);
            &more
        }
    };
    let at = |w: i64| order.iter().position(|x| *x == w).unwrap_or(0);
    below_top.iter().any(|&i| i < windows.len() && at(windows[top]) < at(windows[i]))
}

impl HostModel {
    /// The one focused, while it's shown.
    fn focused(&self) -> Option<Handle> {
        let h = self.listed(self.shown()?)?;
        self.get(h).is_some_and(|s| s.phase == Phase::Shown).then_some(h)
    }

    /// The visible hosts in the order wanted, back to front, the focused one and whether it's cut: the cut panes lying
    /// under others (the focused one too when it's cut) behind every one they lie under (`tucked_order`), then the
    /// others, then the focused one when it isn't cut.
    fn front_order(&self) -> (Vec<Handle>, Option<Handle>, bool) {
        let focused = self.focused();
        let mut visible = [0; ROOM];
        let n = self.visible_hosts(&mut visible);
        let mut all = vec![0; n];
        if n <= ROOM {
            all.copy_from_slice(&visible[..n]);
        } else {
            self.visible_hosts(&mut all);
        }
        let others: Vec<Handle> = all.into_iter().filter(|h| Some(*h) != focused).collect();
        let cut_focused = focused.is_some_and(|f| self.tucked(f, None));
        let mut tucked: Vec<Handle> = others.iter().copied().filter(|h| self.tucked(*h, None)).collect();
        if cut_focused {
            tucked.extend(focused);
        }
        let mut wanted = vec![0; tucked.len()];
        let k = self.tucked_order(&tucked, &mut wanted);
        wanted.truncate(k);
        wanted.extend(others.iter().copied().filter(|h| !self.tucked(*h, None)));
        if !cut_focused {
            wanted.extend(focused);
        }
        (wanted, focused, cut_focused)
    }

    /// The visible hosts in the order wanted, back to front, into `out`; how many (`out` holds the first of them when
    /// it's shorter). The OS side reads each one's window bounds, then asks `front_plan`.
    pub fn front_wanted(&self, out: &mut [Handle]) -> usize {
        let (wanted, _, _) = self.front_order();
        for (o, h) in out.iter_mut().zip(&wanted) {
            *o = *h;
        }
        wanted.len()
    }

    /// The pairs of `wanted` (back to front, by place) whose order shows: their windows overlap past the tolerance,
    /// each as it is (`bounds`, None: unread) and where the layout puts it, a full-screen window with its toolbar's
    /// room above it (Safari's toolbar window rests just above its window: a stacked pane's against the pane above).
    pub fn overlapping(&self, wanted: &[Handle], bounds: &[Option<Rect>]) -> Vec<(usize, usize)> {
        let (tol, room) = (self.opts.tolerance, self.opts.toolbar_room);
        let zones: Vec<Rect> = wanted
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let mut r = self.frame(*h, None);
                if let Some(b) = bounds.get(i).copied().flatten() {
                    r = cg::union(&r, &b);
                }
                if self.get(*h).is_some_and(|s| s.mode == Mode::FullScreen) {
                    let s = cg::standard(&r);
                    r = Rect::new(s.min_x(), s.min_y() - room, s.width, s.height + room);
                }
                r
            })
            .collect();
        let mut out = Vec::new();
        for i in 0..zones.len() {
            for j in i + 1..zones.len() {
                if let Some(x) = cg::intersection(&zones[i], &zones[j])
                    && x.width > tol
                    && x.height > tol
                {
                    out.push((i, j));
                }
            }
        }
        out
    }

    /// The window order's plan, from each wanted host's window bounds (in `front_wanted`'s order; None: unread), the
    /// window server's order of their windows back to front (`server_order`; None: unread) and the hosts whose window
    /// came in with its tile a moment ago (`fresh`). In the order that shows already, or nothing overlapping: only the
    /// focused one's keys. The focused one in front of every host it overlaps: none of those raised over it; two others
    /// out of order between them only when neither overlaps it, then its keys. Else every one from the first out of
    /// place that overlaps another raised, back to front, the focused one last (cut ones too when two cut ones are out
    /// of order, else not), then the keys for a cut focused one, or its place in front confirmed.
    pub fn front_plan(&self, bounds: &[Option<Rect>], order: Option<&[i64]>, fresh: &[Handle]) -> FrontPlan {
        let (wanted, focused, cut_focused) = self.front_order();
        let mut plan = FrontPlan {
            wanted,
            focused,
            cut_focused,
            raises: Vec::new(),
            keys: false,
            confirm: Confirm::None,
            below_top: Vec::new(),
        };
        let Some(top) = plan.wanted.len().checked_sub(1) else { return plan };
        let wanted = &plan.wanted;
        let windows: Vec<i64> = wanted.iter().map(|h| self.get(*h).map_or(0, |s| s.window)).collect();
        let pairs = self.overlapping(wanted, bounds);
        plan.below_top = pairs.iter().filter(|p| p.1 == top).map(|p| p.0).collect();
        let bad = match order {
            Some(o) => out_of_order(&windows, o, &pairs),
            None => pairs.clone(),
        };
        if bad.is_empty() {
            plan.keys = true;
            return plan;
        }
        let tucked = |k: usize| self.tucked(wanted[k], None);
        // (A pane raised over a cut one lying under it: over it, else a plain raise.)
        let raise = |k: usize| {
            let h = wanted[k];
            let below = wanted[..k].iter().rev().find(|b| self.tucked(**b, None) && self.lies_under(**b, h));
            (h, below.copied())
        };
        let tucked_pair = bad.iter().any(|&(i, j)| tucked(i) && tucked(j));
        if !tucked_pair && !bad.iter().any(|p| p.1 == top) {
            let under = &plan.below_top;
            let mut fix: Vec<usize> = bad
                .iter()
                .filter(|p| !under.contains(&p.0) && !under.contains(&p.1))
                .flat_map(|p| [p.0, p.1])
                .collect();
            fix.sort_unstable();
            fix.dedup();
            plan.raises = fix.into_iter().filter(|k| !tucked(*k)).map(raise).collect();
            plan.keys = true;
            return plan;
        }
        let involved = |k: usize| pairs.iter().any(|p| p.0 == k || p.1 == k);
        let from = bad.iter().map(|p| p.0).min().unwrap_or(0);
        plan.raises = (from..wanted.len())
            .filter(|&k| (k == top || involved(k)) && (tucked_pair || !tucked(k)))
            .map(raise)
            .collect();
        if cut_focused {
            plan.keys = true;
        } else if wanted.len() > 1 && Some(wanted[top]) == focused {
            plan.confirm = if fresh.contains(&wanted[top]) { Confirm::Fresh } else { Confirm::Wait };
        }
        plan
    }
}

#[cfg(test)]
mod tests;
