//! Every window of an app Margin hosts gets one kind (WindowKinds.swift; docs/HOSTING-CORE.md, principle 2), from
//! generic rules on its layer, size, position, Accessibility's role and subrole, and its history. Never a bundle id.
//!
//! The kinds:
//!
//! ```text
//!   main       the window that is the app (shown at the page area, or parked): one per host
//!   auxiliary  settings, inspectors, floating panels, the app's other windows (a second document, the person's own)
//!   dialog     alerts and sheets (shown on top of the main window)
//!   strip      a full-screen window's toolbar or title band: the page area's width at least, at most 150 pt tall,
//!              its top no lower than 152 pt below the page area's (never Safari's link status bubble at the page's foot)
//!   leftover   restored from an earlier session, or opened by Margin only to wake something: to be closed or parked
//!   helper     a window its app makes in answer to Margin sizing it, at the size Margin just set (Weather's
//!              1264×966 window for 0.2 s after each tile resize, 2026-11-18 13:30): never shown, adopted, parked,
//!              let in front or reacted to; the layout ignores it
//!   transient  menus, tooltips, popovers (above layer 0, or tiny), spares never ordered in, a twin at the main
//!              window's frame, a hosted window its app replaced: nothing to do with them
//!   own        the person's own window of an app the person opened, made before the window Margin hosts: never
//!              Margin's to show; one its app orders into Margin's Space goes back on its Desktop (the reconciler's
//!              `putAway`). Safari started in the background at 07:42 kept its restored window ordered out until its
//!              first activation, Margin's (2026-11-26 10:43:12.700): its AppKit ordered it in under the window Margin
//!              asked for, which put it in Margin's Space, over the page.
//! ```
//!
//! The rules, in order (the first that applies):
//!
//! ```text
//!   1. above layer 0                                                              transient
//!   2. Accessibility's role a menu, a help tag or a popover                       transient
//!  2b. a helper before (it stays one) or new within `HELPER_AFTER` of Margin sizing its app, at a size Margin set
//!                                                                                 helper
//!  2c. closed (its Accessibility element destroyed), still listed by the window server               transient
//!   3. the page area's width at least, at most 150 pt tall, its top within 152 pt below the page area's top
//!                                                                                 strip
//!   4. under 100 pt on a side                                                     transient
//!   5. opened by Margin only to wake its app                                      leftover
//!   6. never ordered in while another of its app's windows is: a spare            transient
//!   7. a sheet: dialog; a floating subrole: auxiliary; a dialog subrole: a dialog, unless its app has no other window
//!      that could be its main one and it's hosted or at least 400×300; anything else: a main candidate
//!   8. a candidate made before the window Margin hosts, in an app Margin started, not hosted: restored   leftover
//!      (never one in Margin's Space that Accessibility hasn't read yet: it may be the app's sheet or alert over the
//!      window shown, Books' "Discover New Books" 2026-11-18, parked as a leftover 70 ms before it read as a sheet:
//!      the app waited on an answer nobody could see. Read, it's decided; elsewhere it can't be in the way.)
//!   9. a candidate that can't go full screen while another can                    auxiliary
//!  8b. a candidate there as the first show of the hosted window ended, in an app Margin started, not hosted
//!      (the same exception as 8)                                                  leftover
//!  10. the mains: each hosted candidate its app didn't replace; none: the best of the candidates
//!  11. the other candidates: at a main window's frame (within 4 pt) a twin (transient); made before the window Margin
//!      hosts, in an app the person opened, not hosted (never one in Margin's Space Accessibility hasn't read: as 8)
//!      own; else auxiliary.
//! ```

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::layout::{Placement, near};
use crate::geometry::Rect;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowKind {
    Main,
    Auxiliary,
    Dialog,
    Strip,
    Leftover,
    Helper,
    Transient,
    Own,
}

impl WindowKind {
    pub const ALL: [WindowKind; 8] = [
        WindowKind::Main,
        WindowKind::Auxiliary,
        WindowKind::Dialog,
        WindowKind::Strip,
        WindowKind::Leftover,
        WindowKind::Helper,
        WindowKind::Transient,
        WindowKind::Own,
    ];
    pub fn name(self) -> &'static str {
        match self {
            WindowKind::Main => "main",
            WindowKind::Auxiliary => "auxiliary",
            WindowKind::Dialog => "dialog",
            WindowKind::Strip => "strip",
            WindowKind::Leftover => "leftover",
            WindowKind::Helper => "helper",
            WindowKind::Transient => "transient",
            WindowKind::Own => "own",
        }
    }
    /// Kept behind Margin's window and never acted on as the app's own: nothing of these is shown or reacted to. (The
    /// person's own window too: never Margin's to show; the reconciler puts one that's in Margin's Space back on its
    /// Desktop, `PutAway`.)
    pub fn kept_behind(self) -> bool {
        matches!(
            self,
            WindowKind::Leftover | WindowKind::Strip | WindowKind::Transient | WindowKind::Helper | WindowKind::Own
        )
    }
}

/// Where a window is: its user Spaces by the window server (mask 7) and Margin's own record of the private Spaces it
/// made (mask 7 lists none: a parked window reads as in no user Space).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowPlace {
    /// Margin's full-screen Space, alone.
    Margin,
    Desktop,
    /// A full-screen Space that isn't Margin's (its own, or another app's).
    FullScreen,
    /// More than one user Space (mid-transition, or a window on every Space).
    Several,
    /// A private Space Margin made.
    Parked,
    /// In no Space at all.
    Nowhere,
    #[default]
    Unread,
}

impl WindowPlace {
    /// In a Space of some kind (a window ordered in somewhere).
    pub fn placed(self) -> bool {
        !matches!(self, WindowPlace::Nowhere | WindowPlace::Unread)
    }
    pub fn in_user_space(self) -> bool {
        matches!(self, WindowPlace::Margin | WindowPlace::Desktop | WindowPlace::FullScreen | WindowPlace::Several)
    }
    pub fn text(self) -> &'static str {
        match self {
            WindowPlace::Margin => "Margin's Space",
            WindowPlace::Desktop => "a Desktop",
            WindowPlace::FullScreen => "a full-screen Space",
            WindowPlace::Several => "several Spaces",
            WindowPlace::Parked => "parked",
            WindowPlace::Nowhere => "no Space",
            WindowPlace::Unread => "Spaces unread",
        }
    }
}

/// One window as the classification reads it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub number: i64,
    #[serde(default)]
    pub layer: i32,
    pub bounds: Rect,
    #[serde(default = "one")]
    pub alpha: f64,
    #[serde(default)]
    pub on_screen: Option<bool>,
    #[serde(default)]
    pub place: WindowPlace,
    /// Seen in a Space (or on screen) at least once.
    #[serde(default)]
    pub ever_placed: bool,
    /// Accessibility's (None: unread).
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub subrole: Option<String>,
    #[serde(default)]
    pub full_screen: Option<bool>,
    #[serde(default)]
    pub can_full_screen: Option<bool>,
    #[serde(default)]
    pub minimized: Option<bool>,
    #[serde(default)]
    pub ax_main: bool,
    #[serde(default)]
    pub ax_focused: bool,
    /// When Margin first saw it (seconds, the caller's clock; None: not known).
    #[serde(default)]
    pub first_seen: Option<f64>,
}

fn one() -> f64 {
    1.0
}

/// In Margin's Space and not read by Accessibility yet: what it is (a sheet, an alert, a restored window) isn't known,
/// and it may be what the app shown is waiting on. Never taken for a leftover until it's read (rules 8 and 8b).
fn unread_here(w: &Window) -> bool {
    w.role.is_none() && w.place == WindowPlace::Margin
}

impl Window {
    pub fn new(number: i64, bounds: Rect) -> Self {
        Window {
            number,
            layer: 0,
            bounds,
            alpha: 1.0,
            on_screen: None,
            place: WindowPlace::Unread,
            ever_placed: false,
            role: None,
            subrole: None,
            full_screen: None,
            can_full_screen: None,
            minimized: None,
            ax_main: false,
            ax_focused: false,
            first_seen: None,
        }
    }
    fn placed_now(&self) -> bool {
        self.place.placed() || self.on_screen == Some(true)
    }
}

/// The last time Margin sized one of the app's windows (a tile's rect, a frame), and the rects it set: a new window
/// at one of them right after is the app's answer to the resize (a helper), not a window of its own.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Resized {
    pub at: f64,
    pub rects: Vec<Rect>,
}

/// What Margin knows of the app.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppFacts {
    pub launched_by_margin: bool,
    pub hosted: BTreeSet<i64>,
    /// Windows Margin opened only to wake it.
    pub woken: BTreeSet<i64>,
    /// The mains at the last classification (a tie keeps the main where it was).
    pub previous_mains: BTreeSet<i64>,
    /// Helpers at the last classification (a helper stays one).
    pub previous_helpers: BTreeSet<i64>,
    /// Its windows as the first show of the hosted window ended (an app Margin started).
    pub launch_windows: BTreeSet<i64>,
    /// Its windows Accessibility said were destroyed that the window server still lists.
    pub closed: BTreeSet<i64>,
    pub resized: Option<Resized>,
    /// The rects of its hosts laid out at a rect of their own (docs/PEEK-SPLIT.md §1: a card's, a split pane's, a
    /// split's main pane's): each one's own full-screen toolbar is a strip of that rect's width, not the page area's.
    pub host_rects: Vec<Rect>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Verdict {
    pub kind: WindowKind,
    pub why: String,
}

pub const STRIP_MAX_HEIGHT: f64 = 150.0;
pub const TINY_SIDE: f64 = 100.0;
pub const TWIN_WITHIN: f64 = 4.0;
pub const BIG_DIALOG: (f64, f64) = (400.0, 300.0);
/// How soon after Margin sized an app a new window at that size counts as its answer (Weather's came in 0.1-0.3 s).
pub const HELPER_AFTER: f64 = 0.6;
/// A window first seen this much before the resize can't be its answer (the clocks' and reads' slack).
pub const HELPER_SLACK: f64 = 0.05;
const TRANSIENT_ROLES: [&str; 4] = ["AXMenu", "AXMenuBar", "AXHelpTag", "AXPopover"];
const FLOATING_SUBROLES: [&str; 2] = ["AXFloatingWindow", "AXSystemFloatingWindow"];
const DIALOG_SUBROLES: [&str; 2] = ["AXDialog", "AXSystemDialog"];

/// As the engine's own: the page area's width at least (the display's for one that went full screen on its own), at
/// most 150 pt tall, and at the top: its top edge no lower than `STRIP_MAX_HEIGHT` (and `TOOLBAR_SLACK`) below the
/// page area's top (the area's when there's no page area), as a toolbar's is, resting above or out over its window
/// (`toolbar_of`'s band). Lower down it's no toolbar: Safari's link status bubble (its own window at the page's bottom,
/// 20 pt tall, as wide as the page for a long link: taken for a strip on 2026-11-27 14:07, parked, and its window, the
/// one Margin hosts, pulled out of Margin's Space with it, three times in 5 s: the host stepped down to members).
/// Nothing to measure against (no placement yet): no strip.
pub fn is_strip(b: &Rect, p: &Placement) -> bool {
    if !(b.width > 0.0 && b.height > 0.0 && b.height <= STRIP_MAX_HEIGHT) {
        return false;
    }
    let (wide, top) = match (p.area.width > 0.0, p.page.width > 0.0) {
        (true, true) => ((p.area.width * 0.9).min(p.page.width - 2.0), p.page.min_y()),
        (true, false) => (p.area.width * 0.9, p.area.min_y()),
        (false, true) => (p.page.width - 2.0, p.page.min_y()),
        (false, false) => return false,
    };
    b.width >= wide && b.min_y() <= top + TOOLBAR_SLACK + STRIP_MAX_HEIGHT
}

/// A strip for the placement's page area, or for one of the app's hosts' own rects (a card's or a pane's full-screen
/// toolbar is as wide as its own window: `is_strip` against Margin's page area alone took it for a small window).
pub fn is_strip_of_any(b: &Rect, p: &Placement, rects: &[Rect]) -> bool {
    is_strip(b, p) || rects.iter().any(|r| is_strip(b, &Placement { page: *r, ..*p }))
}

/// How far a full-screen window's own toolbar strip may sit from its window's top edge and sides (pt).
pub const TOOLBAR_SLACK: f64 = 2.0;

/// A strip at a full-screen window's top edge (`window`, its bounds): its left edge and width the window's, from just
/// above its top to inside it (at most `STRIP_MAX_HEIGHT` below it), each within `TOOLBAR_SLACK`. A window of no width
/// has none. Its height isn't asked (the caller's: a strip is at most `STRIP_MAX_HEIGHT` tall).
pub fn toolbar_of(b: &Rect, window: &Rect) -> bool {
    let f = window;
    f.width > 0.0
        && (b.min_x() - f.min_x()).abs() <= TOOLBAR_SLACK
        && (b.width - f.width).abs() <= TOOLBAR_SLACK
        && b.max_y() >= f.min_y() - TOOLBAR_SLACK
        && b.min_y() <= f.min_y() + TOOLBAR_SLACK + STRIP_MAX_HEIGHT
}

fn size(b: &Rect) -> String {
    format!("{}×{}", b.width as i64, b.height as i64)
}

fn verdict(kind: WindowKind, why: impl Into<String>) -> Verdict {
    Verdict { kind, why: why.into() }
}

/// A new window that is the app's answer to Margin sizing it: not hosted, first seen within `HELPER_AFTER` of the
/// resize, at (within 4 pt) one of the rects Margin set, while the window Margin hosts is still in a Space (with it
/// gone, a new window is its app's replacement for it, to be adopted: never a helper).
fn helper(w: &Window, app: &AppFacts, hosted_in_place: bool) -> Option<String> {
    if app.hosted.contains(&w.number) || !hosted_in_place {
        return None;
    }
    if app.previous_helpers.contains(&w.number) {
        return Some("its app's answer to a resize (a helper before)".into());
    }
    let r = app.resized.as_ref()?;
    let seen = w.first_seen?;
    let after = seen - r.at;
    if !(-HELPER_SLACK..=HELPER_AFTER).contains(&after) {
        return None;
    }
    let at = r.rects.iter().find(|rect| near(&w.bounds, rect, TWIN_WITHIN))?;
    Some(format!(
        "{} ms after Margin sized its app, at {}: its app's answer to the resize",
        (after * 1000.0).max(0.0).round() as i64,
        size(at)
    ))
}

/// Each window's kind and why, by its number.
pub fn classify(windows: &[Window], app: &AppFacts, placement: &Placement) -> BTreeMap<i64, Verdict> {
    let mut out = BTreeMap::new();
    let hosted_in_place =
        windows.iter().any(|w| app.hosted.contains(&w.number) && w.placed_now() && !app.closed.contains(&w.number));
    let mut sorted: Vec<&Window> = windows.iter().collect();
    sorted.sort_by_key(|w| w.number);
    let mut rest: Vec<&Window> = Vec::new();
    for w in sorted {
        if w.layer != 0 {
            out.insert(w.number, verdict(WindowKind::Transient, format!("layer {}", w.layer)));
            continue;
        }
        if let Some(role) = w.role.as_deref().filter(|r| TRANSIENT_ROLES.contains(r)) {
            out.insert(w.number, verdict(WindowKind::Transient, format!("role {role}")));
            continue;
        }
        if let Some(why) = helper(w, app, hosted_in_place) {
            out.insert(w.number, verdict(WindowKind::Helper, why));
            continue;
        }
        if app.closed.contains(&w.number) {
            out.insert(
                w.number,
                verdict(WindowKind::Transient, "closed (Accessibility: destroyed), still listed by the window server"),
            );
            continue;
        }
        if is_strip_of_any(&w.bounds, placement, &app.host_rects) {
            out.insert(
                w.number,
                verdict(
                    WindowKind::Strip,
                    format!("{}: the page area's width, at most {} pt tall", size(&w.bounds), STRIP_MAX_HEIGHT as i64),
                ),
            );
            continue;
        }
        if w.bounds.width < TINY_SIDE || w.bounds.height < TINY_SIDE {
            out.insert(
                w.number,
                verdict(WindowKind::Transient, format!("{}: under {} pt on a side", size(&w.bounds), TINY_SIDE as i64)),
            );
            continue;
        }
        if app.woken.contains(&w.number) {
            out.insert(w.number, verdict(WindowKind::Leftover, "opened by Margin only to wake its app"));
            continue;
        }
        rest.push(w);
    }
    // 6. Spares: never ordered in while another is.
    let ordered_in = rest.iter().filter(|w| w.placed_now() || w.ever_placed).count();
    rest.retain(|w| {
        if w.placed_now() || w.ever_placed || app.hosted.contains(&w.number) || ordered_in == 0 {
            return true;
        }
        out.insert(
            w.number,
            verdict(
                WindowKind::Transient,
                format!(
                    "never ordered in (in no Space, off screen) while {ordered_in} of its app's windows {}: a spare",
                    if ordered_in == 1 { "is" } else { "are" }
                ),
            ),
        );
        false
    });
    // 7. Accessibility's role and subrole.
    let mut candidates: Vec<&Window> = Vec::new();
    let mut dialogs: Vec<&Window> = Vec::new();
    for w in rest {
        if w.role.as_deref() == Some("AXSheet") {
            out.insert(w.number, verdict(WindowKind::Dialog, "a sheet"));
            continue;
        }
        if let Some(s) = w.subrole.as_deref().filter(|s| FLOATING_SUBROLES.contains(s)) {
            out.insert(w.number, verdict(WindowKind::Auxiliary, format!("a floating panel ({s})")));
            continue;
        }
        if w.subrole.as_deref().is_some_and(|s| DIALOG_SUBROLES.contains(&s)) {
            dialogs.push(w);
            continue;
        }
        candidates.push(w);
    }
    // 8. Restored: made before the window Margin hosts, in an app Margin started.
    if app.launched_by_margin
        && let Some(&first) = app.hosted.iter().next()
    {
        candidates.retain(|w| {
            if app.hosted.contains(&w.number) || w.number >= first || unread_here(w) {
                return true;
            }
            out.insert(
                w.number,
                verdict(
                    WindowKind::Leftover,
                    format!(
                        "made before the window Margin hosts ({first}) in an app Margin started: restored, in {}",
                        w.place.text()
                    ),
                ),
            );
            false
        });
    }
    // (A dialog-subrole window as the main one: only with no other window that could be.)
    let mut promoted = BTreeSet::new();
    if candidates.is_empty() {
        for w in &dialogs {
            if app.hosted.contains(&w.number) || (w.bounds.width >= BIG_DIALOG.0 && w.bounds.height >= BIG_DIALOG.1) {
                candidates.push(w);
                promoted.insert(w.number);
            }
        }
    }
    for w in &dialogs {
        if !promoted.contains(&w.number) {
            out.insert(
                w.number,
                verdict(WindowKind::Dialog, format!("a dialog ({})", w.subrole.as_deref().unwrap_or("?"))),
            );
        }
    }
    // 9. Can't go full screen while another can.
    let can_full = candidates.iter().filter(|w| w.can_full_screen == Some(true)).count();
    if can_full > 0 {
        candidates.retain(|w| {
            if w.can_full_screen != Some(false) || app.hosted.contains(&w.number) {
                return true;
            }
            out.insert(
                w.number,
                verdict(
                    WindowKind::Auxiliary,
                    format!(
                        "can't go full screen while {can_full} of its app's windows can (a settings or utility window)"
                    ),
                ),
            );
            false
        });
    }
    // 8b. Made as its app launched, in an app Margin started, not hosted.
    if app.launched_by_margin && !app.hosted.is_empty() {
        candidates.retain(|w| {
            if app.hosted.contains(&w.number) || !app.launch_windows.contains(&w.number) || unread_here(w) {
                return true;
            }
            out.insert(
                w.number,
                verdict(
                    WindowKind::Leftover,
                    format!(
                        "there as its app launched, before Margin showed the window it hosts, in an app Margin started: restored, in {}",
                        w.place.text()
                    ),
                ),
            );
            false
        });
    }
    // 10. The mains.
    let replacement = |h: &Window| -> Option<i64> {
        candidates
            .iter()
            .find(|c| {
                if app.hosted.contains(&c.number) || !c.placed_now() {
                    return false;
                }
                // Taken by its app into a full-screen Space of its own while the hosted one is still in Margin's: a
                // second window of its own (Teams' meeting, 2026-11-19, at the hosted one's full-screen frame and
                // Accessibility's main), never the hosted one's replacement.
                if c.place == WindowPlace::FullScreen && h.place == WindowPlace::Margin {
                    return false;
                }
                if near(&c.bounds, &h.bounds, TWIN_WITHIN) {
                    return h.place == WindowPlace::Nowhere || (c.ax_main && !h.ax_main);
                }
                h.place == WindowPlace::Margin
                    && h.on_screen == Some(false)
                    && c.on_screen == Some(true)
                    && c.ax_main
                    && !h.ax_main
                    && c.number > h.number
            })
            .map(|c| c.number)
    };
    let mut mains: BTreeMap<i64, String> = BTreeMap::new();
    let mut replaced: BTreeMap<i64, i64> = BTreeMap::new();
    for h in candidates.iter().filter(|h| app.hosted.contains(&h.number)) {
        if let Some(c) = replacement(h) {
            replaced.insert(h.number, c);
            continue;
        }
        let dialog = if promoted.contains(&h.number) {
            ", a dialog-subrole window: its app's only one that could be main"
        } else {
            ""
        };
        let ax = if h.ax_main { ", Accessibility's main window too" } else { "" };
        mains.insert(h.number, format!("the window Margin hosts{ax}{dialog}"));
    }
    if mains.is_empty() {
        let pool: Vec<&Window> = candidates.iter().copied().filter(|w| !replaced.contains_key(&w.number)).collect();
        if let Some((best, why)) = best_of(&pool, app) {
            let dialog = if promoted.contains(&best.number) {
                " (a dialog-subrole window: its app's only one that could be main)"
            } else {
                ""
            };
            if let Some((&old, _)) = replaced.iter().find(|(_, by)| **by == best.number) {
                let nowhere =
                    candidates.iter().find(|w| w.number == old).is_some_and(|w| w.place == WindowPlace::Nowhere);
                let how = if nowhere {
                    format!("in no Space, this one at its frame in {}", best.place.text())
                } else {
                    "this one at its frame is Accessibility's main window".to_string()
                };
                mains.insert(best.number, format!("replaces {old}, the window Margin hosts ({how})"));
            } else {
                mains.insert(best.number, format!("{why}{dialog}"));
            }
        }
    }
    for (n, why) in &mains {
        out.insert(*n, verdict(WindowKind::Main, why.clone()));
    }
    // 11. The rest of the candidates.
    let main_windows: Vec<&&Window> = candidates.iter().filter(|w| mains.contains_key(&w.number)).collect();
    for w in candidates.iter().filter(|w| !mains.contains_key(&w.number)) {
        if let Some(by) = replaced.get(&w.number) {
            let is_main = if mains.contains_key(by) { " is main" } else { "" };
            out.insert(
                w.number,
                verdict(WindowKind::Transient, format!("replaced by its app: {by} at its frame{is_main}")),
            );
        } else if let Some(twin) = main_windows.iter().find(|m| {
            // (A full-screen Space of its own and Margin's: two windows at the one full-screen frame, never twins.)
            near(&m.bounds, &w.bounds, TWIN_WITHIN)
                && !(w.place == WindowPlace::FullScreen && m.place == WindowPlace::Margin)
        }) {
            out.insert(
                w.number,
                verdict(WindowKind::Transient, format!("a twin of the main window {}, at its frame", twin.number)),
            );
        } else if let Some(first) = own_before(w, app) {
            out.insert(
                w.number,
                verdict(
                    WindowKind::Own,
                    format!(
                        "the person's own: made before the window Margin hosts ({first}) in an app the person opened ({}, in {})",
                        size(&w.bounds),
                        w.place.text()
                    ),
                ),
            );
        } else {
            let whose = if app.launched_by_margin || app.hosted.is_empty() {
                "another window of its app"
            } else {
                "another window of an app the person opened"
            };
            out.insert(w.number, verdict(WindowKind::Auxiliary, format!("{whose} ({})", size(&w.bounds))));
        }
    }
    out
}

/// Rule 11's `own`: a window of an app the person opened, made before the window Margin hosts (window numbers only
/// grow: it was there before Margin asked for or took that one), not hosted, read by Accessibility if it's in Margin's
/// Space (unread there it may be the app's sheet or alert over the window shown, as rule 8 keeps). The first window
/// Margin hosts, when it is.
fn own_before(w: &Window, app: &AppFacts) -> Option<i64> {
    let first = *app.hosted.iter().next()?;
    (!app.launched_by_margin && !app.hosted.contains(&w.number) && w.number < first && !unread_here(w)).then_some(first)
}

type Criterion = (&'static str, fn(&Window, &AppFacts) -> f64);

const CRITERIA: [Criterion; 9] = [
    ("the one in a Space", |w, _| if w.placed_now() { 1.0 } else { 0.0 }),
    ("Accessibility's main window", |w, _| if w.ax_main { 1.0 } else { 0.0 }),
    ("the one on screen", |w, _| if w.on_screen == Some(true) && w.alpha > 0.0 { 1.0 } else { 0.0 }),
    ("main before", |w, a| if a.previous_mains.contains(&w.number) { 1.0 } else { 0.0 }),
    ("Accessibility's focused window", |w, _| if w.ax_focused { 1.0 } else { 0.0 }),
    ("not minimized", |w, _| if w.minimized == Some(true) { 0.0 } else { 1.0 }),
    ("a standard window", |w, _| if w.subrole.as_deref() == Some("AXStandardWindow") { 1.0 } else { 0.0 }),
    ("the bigger", |w, _| w.bounds.width * w.bounds.height),
    ("the newer", |w, _| w.number as f64),
];

/// The main window among `pool` when Margin hosts none of them (or its app replaced it), and the criterion that told
/// it from the next one.
fn best_of<'a>(pool: &[&'a Window], app: &AppFacts) -> Option<(&'a Window, String)> {
    let first = *pool.first()?;
    if pool.len() == 1 {
        return Some((first, "its app's only window that could be main".into()));
    }
    let mut sorted: Vec<&Window> = pool.to_vec();
    // Stable, as Swift's sort on this input: ties keep the number order.
    sorted.sort_by(|a, b| {
        for (_, key) in CRITERIA {
            let (x, y) = (key(a, app), key(b, app));
            if x != y {
                return y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal);
            }
        }
        std::cmp::Ordering::Equal
    });
    let (winner, next) = (sorted[0], sorted[1]);
    let why =
        CRITERIA.iter().find(|(_, key)| key(winner, app) != key(next, app)).map(|(n, _)| *n).unwrap_or("the first");
    Some((winner, format!("{why} (of {})", pool.len())))
}

#[cfg(test)]
mod tests;
