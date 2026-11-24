//! Layouts and splits (docs/CORE-REFACTOR.md step 3, part 3; HostedSession `showSplit`, `paneRects`,
//! `pageAppMinimums`, `refreshPaneMinimums`, `applyLayout`, `leaveSplit`, `forgetInLayouts`, `prepare`),
//! transliterated as requests.rs is: each decision at the same point between the same awaits, Swift's `defer`s as the
//! after-steps of an inner flow, in reverse order of declaration (`applyLayout`'s are registered part-way: a return
//! before one is registered doesn't run it).
//!
//! - A layout is the window's main item (at the page area, or a split's pane's rect) and the others (a split's panes,
//!   the preview card) each at its rect and role; a profile's first web item uses its main window, a card its card
//!   window, the next ones `#pane1`…`#pane3` (a fourth refused). A web item whose window is there already gets its
//!   tab in front first, out of sight.
//! - A split's panes' rects are the page's `<m-pane>`s, waited for; room is checked before any window moves (the
//!   newcomers leave first, main never: layout.rs `no_room`); panes that didn't come leave the split (the library's
//!   `removeFromSplit`, the person told by a toast); the pane that had the keys keeps them when the one asked for
//!   failed.
//! - Margin's window is made ready first (`prepare`): one window hosts at a time (the other's item parked, pictured
//!   and drawn there as a card), in full screen, its page's full-screen layout, hosting, its page area measured.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::hosting::HostTarget;
use super::page_area::{placement_json, rect_json};
use super::state::{Extra, Layout, host_role_name};
use super::target::Target;
use super::{Core, Field, OpenItem, SAFARI_BUNDLE, object, swift_int};
use crate::geometry::{Rect, cg};
use crate::host::layout::{Placement, Size};
use crate::host::model::Role as HostRole;
use crate::hosted_browser::Role;
use crate::json;

use super::layout::{NO_ROOM_REASON, PANE_LEAST, PaneRoom, is_no_room, no_room};

/// The addresses and items the panes being laid out open at (HostedSession `paneAddress`, `paneItem` by item, kept
/// for `showSplit`'s layout; `paneAddressFor`, `paneItemFor` by profile and role, for `requestSafariWindow`).
#[derive(Debug, Default)]
pub(crate) struct PaneOpens {
    pub(crate) address: BTreeMap<String, Option<String>>,
    item: BTreeMap<String, String>,
    pub(crate) address_for: BTreeMap<(String, Role), String>,
    pub(crate) item_for: BTreeMap<(String, Role), String>,
}

/// One part of a layout (HostedSession `LayoutPart`).
#[derive(Clone, Debug)]
struct Part {
    item: String,
    target: HostTarget,
    profile: Option<String>,
    url: String,
    role: HostRole,
    rect: Option<Rect>,
}

/// What the engine answered for a host of a layout: shown, or failed with its step's words and why; and how the
/// Swift writes the result (`"\(result)"`, for the log).
#[derive(Clone, Debug)]
pub(crate) struct Result {
    pub(crate) shown: bool,
    pub(crate) why: Option<String>,
    pub(crate) said: String,
}

impl Result {
    pub(crate) fn read(v: &Value) -> Result {
        let shown = v.get("shown").and_then(Value::as_str).is_some();
        Result { shown, why: v.get("why").and_then(Value::as_str).map(str::to_string), said: String::new() }
    }
}

/// `Int(x)` as the log lines print a CGFloat.
fn int(x: f64) -> i64 {
    x as i64
}

impl Core {
    // ---- the layouts kept ----

    pub(crate) fn layout_of(&self, w: i64) -> Option<Layout> {
        self.read(|s| s.layouts.get(&w).cloned())
    }

    pub(crate) fn has_layout(&self, w: i64) -> bool {
        self.read(|s| s.layouts.contains_key(&w))
    }

    pub(crate) fn set_layout_of(&self, w: i64, l: Option<Layout>) {
        self.edit(Field::Layouts, |s| match l {
            Some(l) => s.layouts.insert(w, l),
            None => s.layouts.remove(&w),
        });
    }

    /// The Margin windows whose layout has the item (`layout.filter { $0.value.items.contains(item) }`).
    pub(crate) fn layouts_with(&self, item: &str) -> Vec<i64> {
        self.read(|s| s.layouts.iter().filter(|(_, l)| l.has(item)).map(|(w, _)| *w).collect())
    }

    fn host_of(&self, item: &str) -> Option<String> {
        self.read(|s| s.open.get(item).map(|o| o.host.clone()))
    }

    // ---- split view (docs/PEEK-SPLIT.md §4) ----

    /// A split's item picked in `w`: the whole split shown, `focus` with the keys. Its panes are the split's items
    /// that can be hosted (web pages in Safari, Mac apps: each app once); fewer than two: false (the item is shown
    /// alone). Main is the pane that keeps its window (the window's layout of this split already: its main; else the
    /// split's first web pane, which uses its profile's main window, else its first pane). True: shown.
    pub(crate) async fn show_split(&self, split: &super::Split, focus: &str, w: i64) -> bool {
        let (mut panes, mut apps, mut webs) = (Vec::new(), BTreeSet::new(), Vec::new());
        for id in &split.panes {
            match self.target_of(id) {
                Some(Target::App { bundle, .. }) => {
                    if apps.insert(bundle.clone()) {
                        panes.push(id.clone());
                    } else {
                        self.note(format!("split {}: {id}: {bundle} is in it already (an app is one pane)", split.id));
                    }
                }
                Some(Target::Web { browser, .. }) if browser == "safari" => {
                    panes.push(id.clone());
                    webs.push(id.clone());
                }
                _ => self.note(format!("split {}: {id}: can't be a pane (not hosted beside others)", split.id)),
            }
        }
        if panes.len() < 2 || !panes.iter().any(|p| p == focus) {
            self.note(format!("split {}: fewer than two panes to show: {focus} alone", split.id));
            return false;
        }
        if self.requested_in(w).as_deref() != Some(focus) {
            // (The page lays the split out for the item in front.)
            self.set_requested(w, Some(focus));
            self.ports.changed();
        }
        let had = self
            .layout_of(w)
            .and_then(|l| (l.split.as_deref() == Some(split.id.as_str()) && panes.contains(&l.main)).then_some(l.main));
        let main = had.or_else(|| webs.first().cloned()).unwrap_or_else(|| panes[0].clone());
        // (A web pane's window not made yet is opened at its page, or blank when its tab is open elsewhere (moved in,
        // the blank page closed then): never Safari's empty new-tab page, whose address field keeps Safari's toolbar
        // down over the page. Its tab open elsewhere: the window made around that tab by the copy.)
        for id in &webs {
            let address =
                if self.open_item(id).is_none() { self.item_url(id) } else { Some("about:blank".to_string()) };
            self.panes.borrow_mut().address.insert(id.clone(), address);
        }
        for id in &webs {
            if self.open_item(id).is_some() {
                self.panes.borrow_mut().item.insert(id.clone(), id.clone());
            }
        }
        let extras: Vec<Extra> = panes
            .iter()
            .filter(|p| **p != main)
            .map(|p| Extra { item: p.clone(), role: host_role_name(HostRole::Pane).into(), rect: Rect::ZERO })
            .collect();
        self.apply_layout(Some(w), &main, None, extras, Some(focus), Some((split.id.clone(), split.panes.clone())))
            .await;
        // (Its defers, in reverse: the addresses, then the items.)
        self.panes.borrow_mut().address.clear();
        self.panes.borrow_mut().item.clear();
        if self.layout_of(w).and_then(|l| l.split).as_deref() != Some(split.id.as_str()) {
            return false;
        }
        self.refresh_pane_minimums(w);
        true
    }

    /// The split's panes as `w`'s page lays them out now, each pane's rect by its item (`items` in that order: the
    /// split's, as the page has them), waited for (`pageWait`), the page asked to measure again at each look; None:
    /// not laid out so in time.
    async fn pane_rects(&self, w: i64, split: &str, items: &[String]) -> Option<BTreeMap<String, Rect>> {
        let now = || -> Option<BTreeMap<String, Rect>> {
            let (id, panes) = self.ports.pane_layout(w)?;
            if id != split || panes.len() != items.len() || panes.iter().zip(items).any(|(p, i)| &p.0 != i) {
                return None;
            }
            Some(panes.into_iter().collect())
        };
        if let Some(r) = now() {
            return Some(r);
        }
        let page_wait = self.options.borrow().page_wait;
        let came = self
            .wait(page_wait, || {
                if now().is_some() {
                    return true;
                }
                self.ports.remeasure(w);
                false
            })
            .await;
        if !came {
            return None;
        }
        now()
    }

    /// Every app's windows' known minimum as the page names their panes: a web page's (Safari's) as `web`, an app's by
    /// its bundle id, whether a window of it is open or not.
    fn page_app_minimums(&self) -> Vec<(String, Size)> {
        let mut out: BTreeMap<String, Size> = BTreeMap::new();
        for (bundle, m) in self.ports.known_app_minimums() {
            out.insert(if bundle == SAFARI_BUNDLE { "web".into() } else { bundle }, m);
        }
        out.into_iter().collect()
    }

    /// An app's known minimum changed (the engine's `onAppMinimums`): told to the Margin window hosting (none: the
    /// front one, as `window(nil)` is).
    pub(crate) fn app_minimums_changed(&self) {
        if let Some(w) = self.ports.window(self.hosting()) {
            let m = self.page_app_minimums();
            self.ports.set_app_minimums(w, &m);
        }
    }

    /// Each pane's window's minimum told to `w`'s page (its divider stops there): the engine's, as learnt.
    pub(crate) fn refresh_pane_minimums(&self, w: i64) {
        let mut out: BTreeMap<String, Size> = BTreeMap::new();
        if let Some(l) = self.layout_of(w).filter(|l| l.split.is_some()) {
            for item in l.items() {
                if let Some(h) = self.host_of(item)
                    && let Some(m) = self.ports.minimum(&h)
                {
                    out.insert(item.to_string(), m);
                }
            }
        }
        self.ports.set_pane_minimums(w, &out.into_iter().collect::<Vec<_>>());
    }

    // ---- several visible items (docs/PEEK-SPLIT.md §1) ----

    /// A whole layout of a Margin window's page area at once (`applyLayout`): `main` (at the page area, or
    /// `main_rect`: a split's pane), each of `extras` at its rect in its role (back to front), `focused` with the keys
    /// (None: main); a split's panes at its page's `<m-pane>`s.
    pub(crate) async fn apply_layout(
        &self,
        window: Option<i64>,
        main: &str,
        main_rect: Option<Rect>,
        extras: Vec<Extra>,
        focused: Option<&str>,
        split: Option<SplitAsked>,
    ) {
        let Some(w) = self.ports.window(window) else {
            return self.note("layout: no Margin window to lay it out in".into());
        };
        let mut after = After::default();
        self.apply_layout_in(w, main, main_rect, extras, focused, split.as_ref(), &mut after).await;
        // (Its defers, in reverse order of declaration, each only if it was reached.)
        if after.reveal {
            self.release_reveal(w);
        }
        if after.laying {
            self.edit(Field::PanesLaying, |s| s.panes_laying.remove(&w));
        }
        if after.pane_opens {
            let mut p = self.panes.borrow_mut();
            p.address_for.clear();
            p.item_for.clear();
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn apply_layout_in(
        &self,
        w: i64,
        main: &str,
        main_rect: Option<Rect>,
        extras: Vec<Extra>,
        focused: Option<&str>,
        split: Option<&SplitAsked>,
        after: &mut After,
    ) {
        let had = self.layout_of(w);
        let had_items: Vec<String> = had.as_ref().map(|l| l.items().map(str::to_string).collect()).unwrap_or_default();
        let had_focus = had.map(|l| l.focused);
        let mut parts: Vec<Part> = Vec::new();
        let (mut main_used, mut panes) = (BTreeSet::<String>::new(), BTreeMap::<String, u8>::new());
        let asked: Vec<(String, HostRole, Option<Rect>)> =
            std::iter::once((main.to_string(), HostRole::Main, main_rect))
                .chain(
                    extras.into_iter().map(|e| (e.host_role(), e.item, e.rect)).map(|(r, i, rect)| (i, r, Some(rect))),
                )
                .collect();
        for (i, (item, role, rect)) in asked.into_iter().enumerate() {
            // (The preview card: its profile's card window at the card's page, HostedPeek.swift.)
            if i > 0 {
                if let Some((p, url)) = self.card_part(&item) {
                    let target = HostTarget::Safari(p.clone(), Role::Card);
                    self.edit(Field::Labels, |s| s.labels.insert(target.id(), "Safari".into()));
                    parts.push(Part { item, target, profile: Some(p), url, role: HostRole::Card, rect });
                    continue;
                }
            }
            let Some(t) = self.target_of(&item) else {
                self.note(format!("layout: {item}: no target"));
                if i == 0 {
                    return;
                }
                continue;
            };
            let url = self.item_url(&item).unwrap_or_default();
            match t {
                Target::App { bundle, name } => {
                    let id = HostTarget::App(bundle.clone()).id();
                    let label =
                        self.ports.app_name(&bundle).or((!name.is_empty()).then_some(name)).unwrap_or(bundle.clone());
                    self.edit(Field::Labels, |s| s.labels.insert(id, label));
                    parts.push(Part { item, target: HostTarget::App(bundle), profile: None, url, role, rect });
                }
                Target::Web { browser, profile } => {
                    if browser != "safari" {
                        self.note(format!("layout: {item}: {browser} isn't hosted yet"));
                        if i == 0 {
                            return;
                        }
                        continue;
                    }
                    let space = self.space_of_item(&item);
                    let p = self.profile_fallback(&self.resolve(profile.as_deref()), space.as_deref()).await;
                    let safari_role = if role == HostRole::Card {
                        Role::Card
                    } else if !main_used.contains(&p) {
                        main_used.insert(p.clone());
                        Role::Main
                    } else {
                        let n = panes.get(&p).copied().unwrap_or(0) + 1;
                        if n > 3 {
                            self.note(format!("layout: {item}: a profile's fourth pane: not laid out (three at most)"));
                            continue;
                        }
                        panes.insert(p.clone(), n);
                        Role::Pane(n)
                    };
                    if let Role::Pane(_) = safari_role {
                        let mut o = self.panes.borrow_mut();
                        if let Some(Some(address)) = o.address.get(&item).cloned() {
                            o.address_for.insert((p.clone(), safari_role), address);
                        }
                        match o.item.get(&item).cloned() {
                            Some(at) => o.item_for.insert((p.clone(), safari_role), at),
                            None => o.item_for.remove(&(p.clone(), safari_role)),
                        };
                    }
                    let target = HostTarget::Safari(p.clone(), safari_role);
                    self.edit(Field::Labels, |s| s.labels.insert(target.id(), "Safari".into()));
                    parts.push(Part { item, target, profile: Some(p), url, role, rect });
                }
                Target::Margin { .. } => {
                    self.note(format!("layout: {item}: Margin's own page isn't laid out beside others"));
                    if i == 0 {
                        return;
                    }
                }
            }
        }
        if parts.first().is_none_or(|lead| lead.item != main) {
            return;
        }
        let mut tabbed: BTreeSet<String> = BTreeSet::new();
        for part in parts.clone() {
            if part.profile.is_some() && self.ports.is_hosted(&part.target.id()) && self.show_tab(&part).await {
                tabbed.insert(part.item.clone());
            }
        }
        after.pane_opens = true;
        let Some((placement, token, space)) = self.prepare(w, &parts[0].target).await else {
            self.settle_hosting();
            return;
        };
        // (A split: every pane's rect as the page lays the split out, docs/PEEK-SPLIT.md §4.)
        if let Some((split_id, items)) = split {
            let Some(rects) = self.pane_rects(w, split_id, items).await else {
                let wait = super::hosting::swift_double(self.options.borrow().page_wait);
                self.note(format!(
                    "layout: split {split_id}: Margin's window {w}'s page didn't lay its panes out within {wait} s: not shown"
                ));
                self.settle_hosting();
                return;
            };
            // (The preview card over the split keeps its own rect, its <m-preview-page>'s: it's no pane.)
            for p in parts.iter_mut().filter(|p| p.role != HostRole::Card) {
                p.rect = rects.get(&p.item).copied();
            }
            if parts.iter().any(|p| p.rect.is_none()) {
                self.note(format!("layout: split {split_id}: a pane with no rect from the page: not shown"));
                self.settle_hosting();
                return;
            }
            // (Room, before any window moves: every pane within the page area and at its window's known minimum.)
            let had: Vec<&str> = had_items.iter().map(String::as_str).collect();
            let rooms: Vec<PaneRoom<'_>> = parts
                .iter()
                .map(|p| PaneRoom { item: &p.item, role: p.role, rect: p.rect, least: Some(PANE_LEAST) })
                .collect();
            if let Some(out) = no_room(&rooms, placement.page, &had) {
                let page = cg::standard(&placement.page);
                let list: Vec<String> = parts
                    .iter()
                    .filter(|p| p.role != HostRole::Card)
                    .map(|p| {
                        let r = p.rect.map(|r| cg::standard(&r)).map_or("-".to_string(), |r| {
                            format!("{}…{}×{}", int(r.min_x()), int(r.max_x()), int(r.height))
                        });
                        format!("{} {r} ", p.item)
                    })
                    .collect();
                self.note(format!(
                    "layout: split {split_id}: no room in the page area {}×{} ({}, each pane 220 at least): nothing moved",
                    int(page.width),
                    int(page.height),
                    list.join(", ")
                ));
                let keep = had_focus
                    .as_ref()
                    .filter(|f| parts.iter().any(|p| &p.item == *f) && !out.contains(f))
                    .cloned()
                    .unwrap_or_else(|| main.to_string());
                let failed: Vec<(String, Option<String>)> =
                    out.into_iter().map(|i| (i, Some(NO_ROOM_REASON.to_string()))).collect();
                self.leave_split(split_id, &failed, &keep, w).await;
                self.settle_hosting();
                return;
            }
        }
        let first = parts[0].clone();
        let wanted: Vec<Value> = parts[1..]
            .iter()
            .filter_map(|p| {
                let r = p.rect?;
                Some(json!({ "target": p.target.json(), "role": host_role_name(p.role), "rect": rect_json(&r) }))
            })
            .collect();
        let focus_part = focused.and_then(|f| parts.iter().find(|p| p.item == f));
        // (A split's pane opened or placed again beside the panes shown: its loader over its own box, not the page
        // area's; main's too when this split is what the window shows already. The loading bar's `paneLoadingStep`.)
        let mut laying = false;
        if let Some((split_id, _)) = split
            && self.ports.engine_shown().is_some()
        {
            let again = self.layout_of(w).and_then(|l| l.split).as_deref() == Some(split_id.as_str());
            // (By host, the first part of a host kept: Swift's `uniquingKeysWith: { a, _ in a }`.)
            let mut list: BTreeMap<String, String> = BTreeMap::new();
            for (i, p) in parts.iter().enumerate() {
                if if i > 0 { p.role == HostRole::Pane } else { again } {
                    list.entry(p.target.id()).or_insert_with(|| p.item.clone());
                }
            }
            self.edit(Field::PanesLaying, |s| s.panes_laying.insert(w, list));
            laying = true;
        }
        after.laying = true;
        // (A pane whose window is made now: its loader kept over its box until its tab is in and its window's own
        // full-screen toolbar rests: `revealHeld`.)
        let made: Vec<String> = if !laying {
            Vec::new()
        } else {
            let mut made = Vec::new();
            for p in &parts[1..] {
                if p.role == HostRole::Pane && p.profile.is_some() && !self.ports.is_hosted(&p.target.id()) {
                    made.push(p.target.id());
                }
            }
            made
        };
        if !made.is_empty() {
            self.edit(Field::RevealHeld, |s| s.reveal_held.insert(w));
        }
        after.reveal = true;
        let args = json!({
            "main": first.target.json(),
            "mainRect": first.rect.map(|r| rect_json(&r)),
            "extras": wanted,
            "focused": focus_part.map(|p| p.target.id()),
            "placement": placement_json(&placement, token),
            "window": self.ports.window_number(w),
            "space": space,
        });
        let answer = self.engine("setLayout", args).await;
        let results = read_results(&answer);
        let mut shown_items: Vec<String> = Vec::new();
        for part in &parts {
            let r = results.get(&part.target.id());
            if !r.is_some_and(|r| r.shown) {
                let said = r.map_or("not laid out".to_string(), |r| r.said.clone());
                self.note(format!("layout: {}: not shown ({said})", part.item));
                continue;
            }
            if part.profile.is_some() && !tabbed.contains(&part.item) && !self.show_tab(part).await {
                continue;
            }
            if part.profile.is_none() {
                let o = OpenItem { host: part.target.id(), profile: None };
                self.edit(Field::Open, |s| s.open.insert(part.item.clone(), o));
            }
            shown_items.push(part.item.clone());
        }
        if !made.is_empty() {
            let new: Vec<&String> = made
                .iter()
                .filter(|id| parts.iter().any(|p| &p.target.id() == *id && shown_items.contains(&p.item)))
                .collect();
            // (Its page given the keys first, under its loader: a window Safari made keeps them in its address field
            // and its toolbar down over the page whatever made it.)
            self.engine("focusPages", json!({ "hosts": new })).await;
            self.engine("toolbarsRest", json!({ "hosts": new })).await;
            self.release_reveal(w);
        }
        let main_failed_why = results.get(&first.target.id()).filter(|r| !r.shown).and_then(|r| r.why.clone());
        if !shown_items.iter().any(|i| i == main) {
            // (A split's main that found no room beside the panes coming in: they go, so main is laid out again alone.)
            if let Some((split_id, _)) = split
                && main_failed_why.as_deref().is_some_and(is_no_room)
            {
                let incoming: Vec<&Part> =
                    parts[1..].iter().filter(|p| p.role == HostRole::Pane && !had_items.contains(&p.item)).collect();
                let keep = had_focus
                    .as_ref()
                    .filter(|f| parts.iter().any(|p| &p.item == *f) && !incoming.iter().any(|p| &p.item == *f))
                    .cloned()
                    .unwrap_or_else(|| main.to_string());
                if !incoming.is_empty() {
                    let failed: Vec<(String, Option<String>)> =
                        incoming.iter().map(|p| (p.item.clone(), Some(NO_ROOM_REASON.to_string()))).collect();
                    self.leave_split(split_id, &failed, &keep, w).await;
                }
            }
            self.settle_hosting();
            self.ports.changed();
            return;
        }
        let focus =
            focused.filter(|f| shown_items.iter().any(|i| i == f)).map_or_else(|| main.to_string(), str::to_string);
        // (A split's pane that didn't come: out of it, the rest laid out again: `leave_split`.)
        if let Some((split_id, _)) = split {
            // (The ones coming in first: a pane shown before that failed only beside a newcomer goes back to its rect
            // once the newcomer is out.)
            let failed: Vec<&Part> =
                parts[1..].iter().filter(|p| p.role == HostRole::Pane && !shown_items.contains(&p.item)).collect();
            let new: Vec<&Part> = failed.iter().copied().filter(|p| !had_items.contains(&p.item)).collect();
            let out = if new.is_empty() { failed } else { new };
            // (The pane that had the keys before keeps them, when the one asked to have them is what failed.)
            let asked_failed = focused.is_some_and(|f| out.iter().any(|p| p.item == f));
            let keep = if asked_failed {
                had_focus.clone().filter(|h| shown_items.contains(h)).unwrap_or_else(|| focus.clone())
            } else {
                focus.clone()
            };
            if !out.is_empty() {
                let failed: Vec<(String, Option<String>)> = out
                    .iter()
                    .map(|p| {
                        let why = results.get(&p.target.id()).filter(|r| !r.shown).and_then(|r| r.why.clone());
                        (p.item.clone(), why)
                    })
                    .collect();
                self.leave_split(split_id, &failed, &keep, w).await;
            }
        }
        let others: Vec<&Part> = parts[1..].iter().filter(|p| shown_items.contains(&p.item)).collect();
        let layout = (!others.is_empty()).then(|| Layout {
            main: main.to_string(),
            main_rect: first.rect,
            extras: others
                .iter()
                .map(|p| Extra {
                    item: p.item.clone(),
                    role: host_role_name(p.role).into(),
                    rect: p.rect.unwrap_or(Rect::ZERO),
                })
                .collect(),
            focused: focus.clone(),
            split: split.map(|(id, _)| id.clone()),
        });
        let none_left = others.is_empty();
        self.set_layout_of(w, layout);
        if split.is_some() && none_left {
            self.ports.set_pane_minimums(w, &[]);
        }
        if self.read(|s| s.margin_pages.contains_key(&w)) {
            self.edit(Field::MarginPages, |s| s.margin_pages.remove(&w));
            self.ports.set_margin_page(w, None);
        }
        // (A card focused: the item under it stays the window's item shown, the sidebar's highlight (a split's focused
        // pane, as it was); the card isn't one.)
        let next = if self.is_card_item(&focus) {
            self.shown_in(w)
                .filter(|s| shown_items.contains(s) && !self.is_card_item(s))
                .unwrap_or_else(|| main.to_string())
        } else {
            focus.clone()
        };
        self.edit(Field::Shown, |s| s.shown.insert(w, next));
        if let Some(r) = self.requested_in(w)
            && (r == main || r == focus)
        {
            self.set_requested(w, None);
        }
        self.ports.changed();
        self.note(format!("layout: {} item(s) shown in Margin's window {w}, {focus} focused", shown_items.len()));
        if self.hosting() == Some(w) {
            self.swift("paneCuts", json!({ "window": w }));
        }
    }

    fn is_card_item(&self, item: &str) -> bool {
        super::card::is_card_item(item)
    }

    /// A card in a layout (`card:<profile>`, HostedPeek `cardPart`): its profile and its address; None: not a card's,
    /// or no such card.
    fn card_part(&self, item: &str) -> Option<(String, String)> {
        let p = item.strip_prefix(super::card::CARD_PREFIX)?;
        let c = self.card(p)?;
        Some((p.to_string(), c.url))
    }

    /// The copy's hostShow for the card's page (HostedPeek `cardShowPayload`): in the card's window only (`role`), at
    /// its address when it's a new one.
    fn card_show_payload(&self, item: &str, window_id: i64) -> Option<json::Object> {
        let p = item.strip_prefix(super::card::CARD_PREFIX)?;
        let c = self.card(p)?;
        let url = if c.url.is_empty() { "about:blank".to_string() } else { c.url };
        let mut out =
            object(json!({ "windowId": window_id, "itemId": super::card::CARD_TAG, "url": url, "role": "card" }));
        if c.fresh {
            out.insert("fresh".into(), json!(true));
        }
        Some(out)
    }

    /// A web item whose window is there already: its tab in front, out of sight, as a show does (`showTab`).
    async fn show_tab(&self, part: &Part) -> bool {
        let (Some(p), HostTarget::Safari(_, role)) = (&part.profile, &part.target) else { return false };
        let Some(window_id) = self.safari_window(p, *role) else { return false };
        let payload = match self.card_show_payload(&part.item, window_id) {
            Some(o) => o,
            None => {
                let url = if part.url.is_empty() { "about:blank" } else { part.url.as_str() };
                let pinned = self.pinned_or_favorite(&part.item);
                object(json!({ "windowId": window_id, "itemId": part.item, "url": url, "pinned": pinned }))
            }
        };
        let shown = self.ask(p, "hostShow", payload).await;
        let Some(result) = shown.result else {
            let why = shown.error.as_deref().unwrap_or("no answer");
            self.note(format!("layout: {}: its tab wasn't shown ({why})", part.item));
            return false;
        };
        let o = OpenItem { host: part.target.id(), profile: Some(p.clone()) };
        self.edit(Field::Open, |s| s.open.insert(part.item.clone(), o));
        if let Some(tab) = swift_int(result.get("tabId")) {
            self.edit(Field::SafariTabs, |s| s.safari_tabs.insert(part.item.clone(), tab));
        }
        true
    }

    /// Panes of a split shown in `w` that didn't come (their window refused its rect, below its app's minimum; or it
    /// didn't open): out of the split at once, in the library (its `removeFromSplit`: the page lays out the library's
    /// split, so a pane only marked failed would stay an empty box), the person told why (a toast), the rest laid out
    /// again by the show the removal asks for, `focus` keeping the keys.
    async fn leave_split(&self, split: &str, failed: &[(String, Option<String>)], focus: &str, w: i64) {
        let mut room = false;
        let mut names: Vec<String> = Vec::new();
        for (item, why) in failed {
            let why = why.clone().unwrap_or_else(|| "not laid out".into());
            let no_room = is_no_room(&why);
            room = room || no_room;
            let title = self.title_of(item);
            names.push(title.unwrap_or_else(|| if no_room { "that pane" } else { "a pane" }.into()));
            let how = if no_room { "no room for it" } else { "it didn't open" };
            self.note(format!("split {split}: {item}: out of the split ({how}: {why}); the rest laid out again"));
            self.perform("removeFromSplit", object(json!({ "windowId": w, "tabId": item, "focus": focus })));
        }
        // (Its 60 Characters counted as Unicode scalars, as step 1's caps.)
        let name = if names.len() == 1 {
            format!("“{}”", names[0].chars().take(60).collect::<String>())
        } else {
            format!("{} panes", names.len())
        };
        let text = if room {
            format!("Not enough room for {name} in Split View")
        } else {
            format!("{name} couldn't open in Split View")
        };
        self.ports.push(w, &json!({ "type": "toast", "text": text }).to_string());
    }

    /// A host gone, or parked with nothing in its place: out of every layout (one that was main ends that layout).
    pub(crate) fn forget_in_layouts(&self, host: &str) {
        self.edit(Field::Layouts, |s| {
            let open = &s.open;
            let is = |item: &str| open.get(item).is_some_and(|o| o.host == host);
            s.layouts.retain(|_, l| !is(&l.main));
            let mut gone = Vec::new();
            for (w, l) in s.layouts.iter_mut() {
                let before = l.extras.len();
                l.extras.retain(|e| !is(&e.item));
                if l.extras.len() == before {
                    continue;
                }
                if !l.has(&l.focused.clone()) {
                    l.focused = l.main.clone();
                }
                if l.extras.is_empty() {
                    gone.push(*w);
                }
            }
            for w in gone {
                s.layouts.remove(&w);
            }
        });
    }

    // ---- Margin's window ready to host ----

    /// Margin's window ready to host in its page area: in full screen (it always is; asked once more if it isn't, a
    /// safety check), its page drawing its own layout for hosting, its page area measured. None: it couldn't be.
    pub(crate) async fn prepare(&self, w: i64, _target: &HostTarget) -> Option<(Placement, i64, u64)> {
        if let Some(other) = self.hosting().filter(|o| *o != w)
            && let Some(was) = self.ports.window(Some(other))
        {
            // (One Margin window hosts at a time: the one shown in the other parked first. That window keeps its item
            // as a card, faded, and takes it back once it's in front. A web item's page pictured first, while its
            // window still shows it: its card there is that, faded.)
            let item = self.shown_in(other);
            let mut picture = None;
            if let Some(item) = &item {
                picture = self.page_picture(item).await;
            }
            self.engine("parkShown", json!({ "why": "another Margin window hosts" })).await;
            self.edit(Field::Shown, |s| s.shown.remove(&other));
            self.set_hosting(None);
            self.ports.set_hosted(was, None);
            self.ports.set_showing(was, None, None, false);
            self.ports.window_set_hosting(was, false);
            if let Some(item) = item {
                self.show_elsewhere(&item, was, picture.as_deref());
            }
        }
        // (This window's own card stays until it hosts (below): cleared before, its launcher was drawn in between.)
        if !self.ports.window_full_screen(w) {
            let state = self.ports.window_full_screen_state(w);
            self.note(format!(
                "Margin's window {w} not in full screen (it always is while hosting is on: {state}): asked"
            ));
            self.ports.to_full_screen(w);
            let wait = self.options.borrow().full_screen_wait;
            if !self.wait(wait, || self.ports.window_full_screen(w)).await {
                let state = self.ports.window_full_screen_state(w);
                self.note(format!("Margin's window {w} didn't go full screen ({state}): nothing hosted"));
                return None;
            }
        }
        if !self.wait(1.5, || self.ports.window_layout_mode(w).as_deref() == Some("fullscreen")).await {
            let mode = self.ports.window_layout_mode(w).unwrap_or_else(|| "none".into());
            self.note(format!(
                "Margin's window {w}: no full-screen layout from its page in 1.5 s ({mode}): its last one is used"
            ));
        }
        self.ports.window_set_hosting(w, true);
        self.set_hosting(Some(w));
        let m = self.page_app_minimums();
        self.ports.set_app_minimums(w, &m);
        // (Its card, if it had one, goes now that it hosts: straight to the loader, never its launcher for a frame.)
        self.clear_elsewhere(w);
        // (Asked to measure again at every look: a size the window took may not have been drawn yet.)
        let wait = self.options.borrow().page_wait;
        let measured = self
            .wait(wait, || {
                if self.ports.hosted_placement(w).is_some() {
                    return true;
                }
                self.ports.remeasure(w);
                false
            })
            .await;
        let placement = if measured { self.ports.hosted_placement(w) } else { None };
        let Some((placement, token)) = placement else {
            let why = self.ports.window_why_not(w);
            self.note(format!("Margin's window {w}: no page area ({why})"));
            return None;
        };
        let number = self.ports.window_number(w);
        Some((placement, token, self.ports.full_screen_space(number).unwrap_or(0)))
    }
}

/// A layout as a Swift caller asks for it (`applyLayout`'s call: `mainRect` `[x, y, w, h]` or null, `extras`
/// `[[item, role, x, y, w, h]]`, `split` `{ id, items }` or null).
pub(crate) fn layout_args(args: &json::Object) -> (Option<Rect>, Vec<Extra>, Option<SplitAsked>) {
    let rect = |v: &[Value]| match v {
        [x, y, w, h] => {
            Some(Rect::new(json::num(Some(x))?, json::num(Some(y))?, json::num(Some(w))?, json::num(Some(h))?))
        }
        _ => None,
    };
    let main_rect = json::array(args.get("mainRect")).and_then(|r| rect(r));
    let extras = json::array(args.get("extras"))
        .map(|l| {
            l.iter()
                .filter_map(|e| {
                    let e = e.as_array()?;
                    let item = e.first()?.as_str()?.to_string();
                    let role = super::state::host_role_named(e.get(1)?.as_str()?)?;
                    Some(Extra { item, role: host_role_name(role).into(), rect: rect(e.get(2..)?)? })
                })
                .collect()
        })
        .unwrap_or_default();
    let split = json::object(args.get("split")).and_then(|s| {
        let id = s.get("id")?.as_str()?.to_string();
        let items = json::array(s.get("items"))?.iter().filter_map(Value::as_str).map(str::to_string).collect();
        Some((id, items))
    });
    (main_rect, extras, split)
}

/// A split laid out: its id and its panes as the library has them (the page's `<m-pane>` order).
pub(crate) type SplitAsked = (String, Vec<String>);

/// Which of `apply_layout`'s defers were reached.
#[derive(Default)]
struct After {
    pane_opens: bool,
    laying: bool,
    reveal: bool,
}

/// The engine's results of a layout, by host.
fn read_results(answer: &Value) -> BTreeMap<String, Result> {
    let mut out = BTreeMap::new();
    for row in json::array(answer.get("results")).map_or(&[][..], Vec::as_slice) {
        let Some([host, result, said]) =
            row.as_array().map(Vec::as_slice).and_then(|r| <&[Value; 3]>::try_from(r).ok())
        else {
            continue;
        };
        let Some(host) = host.as_str() else { continue };
        let mut r = Result::read(result);
        r.said = said.as_str().unwrap_or("").to_string();
        out.insert(host.to_string(), r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engines_results_read() {
        let r = read_results(&json!({ "results": [
            ["safari:p", { "shown": "safari:p", "placed": true }, "shown(safari:p1, placed: true)"],
            ["app:x", { "failed": "place", "why": "below its window's minimum" }, "failed(M.HostStep.place, \"below\")"],
            ["bad"], [1, {}, ""],
        ] }));
        assert_eq!(r.len(), 2);
        assert!(r["safari:p"].shown && r["safari:p"].why.is_none());
        assert!(!r["app:x"].shown && r["app:x"].why.as_deref() == Some("below its window's minimum"));
        assert_eq!(r["app:x"].said, "failed(M.HostStep.place, \"below\")");
    }
}
