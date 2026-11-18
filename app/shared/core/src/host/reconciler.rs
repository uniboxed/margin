//! The reconciler (HostReconciler.swift; docs/HOSTING-CORE.md, principle 4): what each hosted app should be
//! (`Desired`), what Margin sees of it now (`Situation`), and the corrections from a fixed menu that bring the one to
//! the other, most urgent first. Pure: `step` is a function of the two. The caller applies the first, one at a time,
//! with a budget per app per show, and asks again. No bundle id anywhere.
//!
//! The menu (each idempotent: asked again, it does nothing more than once):
//!   launch, reopen, unhide, wait, placeFromOwnSpace, outThenAsk, askFullScreen, frameWindow, putBack,
//!   bringForward (activate, then reopen), closeItem, placeAgain, sizeTile, adopt, closeLeftover, parkLeftover,
//!   parkStrip, parkAgain, fallback. See HostReconciler.swift's header for each one's meaning.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::kinds::WindowPlace;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    FullScreen,
    Window,
}

/// What an app should be now (the placement itself is the caller's: `Shown` means at the page area).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Desired {
    Shown,
    Parked,
    GivenBack,
}

/// The rungs of `bringForward`, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Forward {
    Activate,
    Reopen,
}

impl Forward {
    pub const ALL: [Forward; 2] = [Forward::Activate, Forward::Reopen];
    pub fn name(self) -> &'static str {
        match self {
            Forward::Activate => "activate",
            Forward::Reopen => "reopen",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Correction {
    Launch,
    Reopen,
    Unhide,
    Wait { why: String },
    PlaceFromOwnSpace { space: u64 },
    OutThenAsk,
    AskFullScreen,
    FrameWindow,
    PutBack,
    BringForward { rung: Forward },
    Adopt { window: i64 },
    CloseLeftover { window: i64 },
    ParkLeftover { window: i64 },
    ParkStrip { window: i64 },
    ParkAgain,
    CloseItem,
    PlaceAgain,
    SizeTile,
    Fallback { why: String },
}

impl Correction {
    /// Its name in the log and its budget's key.
    pub fn name(&self) -> String {
        match self {
            Correction::Launch => "launch".into(),
            Correction::Reopen => "reopen".into(),
            Correction::Unhide => "unhide".into(),
            Correction::Wait { .. } => "wait".into(),
            Correction::PlaceFromOwnSpace { .. } => "place from its own Space".into(),
            Correction::OutThenAsk => "out of full screen, then ask".into(),
            Correction::AskFullScreen => "ask full screen".into(),
            Correction::FrameWindow => "window mode".into(),
            Correction::PutBack => "put back".into(),
            Correction::BringForward { rung } => format!("bring forward ({})", rung.name()),
            Correction::Adopt { .. } => "adopt".into(),
            Correction::CloseLeftover { .. } => "close leftover".into(),
            Correction::ParkLeftover { .. } => "park leftover".into(),
            Correction::ParkStrip { .. } => "park strip".into(),
            Correction::ParkAgain => "park again".into(),
            Correction::CloseItem => "close its item".into(),
            Correction::PlaceAgain => "place again".into(),
            Correction::SizeTile => "size its tile".into(),
            Correction::Fallback { .. } => "fallback".into(),
        }
    }
    pub fn text(&self) -> String {
        match self {
            Correction::Wait { why } => format!("wait ({why})"),
            Correction::PlaceFromOwnSpace { space } => format!("place from its own Space {space}"),
            Correction::Adopt { window } => format!("adopt {window}"),
            Correction::CloseLeftover { window } => format!("close leftover {window}"),
            Correction::ParkLeftover { window } => format!("park leftover {window}"),
            Correction::ParkStrip { window } => format!("park strip {window}"),
            Correction::Fallback { why } => format!("fallback ({why})"),
            other => other.name(),
        }
    }
    /// Its budget's key: per window for the ones that act on one (a leftover's close and park share one).
    pub fn key(&self) -> String {
        match self {
            Correction::CloseLeftover { window } | Correction::ParkLeftover { window } => format!("leftover {window}"),
            Correction::ParkStrip { window } => format!("strip {window}"),
            Correction::Adopt { window } => format!("adopt {window}"),
            other => other.name(),
        }
    }
    /// Each correction's budget per show (tries); `bringForward`'s rungs once each, then the fallback.
    pub fn budget(&self) -> u32 {
        match self {
            Correction::Launch => 1,
            Correction::Reopen => 2,
            Correction::Unhide => 2,
            Correction::Adopt { .. } => 20,
            Correction::FrameWindow => 2,
            Correction::PutBack => 3,
            Correction::ParkAgain => 3,
            Correction::CloseLeftover { .. } | Correction::ParkLeftover { .. } => 2,
            Correction::ParkStrip { .. } => 3,
            Correction::BringForward { .. } => 1,
            Correction::CloseItem => 1,
            Correction::PlaceAgain => 1,
            Correction::SizeTile => 3,
            _ => 1,
        }
    }
    /// A steady-state correction (applied by the poll's reconcile); the others are the first placement's.
    pub fn steady(&self) -> bool {
        matches!(
            self,
            Correction::Adopt { .. }
                | Correction::Reopen
                | Correction::Unhide
                | Correction::BringForward { .. }
                | Correction::CloseLeftover { .. }
                | Correction::ParkLeftover { .. }
                | Correction::ParkStrip { .. }
                | Correction::ParkAgain
                | Correction::FrameWindow
                | Correction::CloseItem
                | Correction::PlaceAgain
                | Correction::SizeTile
                | Correction::Fallback { .. }
        )
    }
}

/// One window other than the main one that the reconciler acts on (a leftover, a strip).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Other {
    pub number: i64,
    pub place: WindowPlace,
    #[serde(default)]
    pub on_screen: Option<bool>,
    /// A leftover only: whether Margin may close it.
    #[serde(default)]
    pub closable: bool,
}

impl Other {
    pub fn in_user_space(&self) -> bool {
        self.place.in_user_space()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    None,
    Preparing,
    Shown,
    Parked,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::None => "none",
            Phase::Preparing => "preparing",
            Phase::Shown => "shown",
            Phase::Parked => "parked",
        }
    }
}

/// What Margin sees of one host (or of an app it's about to host).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Situation {
    pub running: bool,
    pub hidden: Option<bool>,
    pub launched_by_margin: bool,
    pub phase: Phase,
    pub mode: Mode,
    pub member: bool,
    pub window: Option<i64>,
    pub window_gone: bool,
    pub gone_for: Option<f64>,
    pub place: WindowPlace,
    pub on_screen: Option<bool>,
    pub off_screen_reads: u32,
    pub stray_reads: u32,
    pub at_page: Option<bool>,
    pub off_page_reads: u32,
    pub tile: bool,
    pub tile_stale: bool,
    pub dragging: bool,
    pub full_screen: Option<bool>,
    pub can_full_screen: Option<bool>,
    pub own_full_screen_space: Option<u64>,
    pub margin_current: bool,
    pub busy: bool,
    pub replacement: Option<i64>,
    pub leftovers: Vec<Other>,
    pub strips: Vec<Other>,
    /// Corrections tried this show, by key.
    pub tries: BTreeMap<String, u32>,
}

impl Default for Situation {
    fn default() -> Self {
        Situation {
            running: true,
            hidden: None,
            launched_by_margin: false,
            phase: Phase::None,
            mode: Mode::FullScreen,
            member: false,
            window: None,
            window_gone: false,
            gone_for: None,
            place: WindowPlace::Unread,
            on_screen: None,
            off_screen_reads: 0,
            stray_reads: 0,
            at_page: None,
            off_page_reads: 0,
            tile: false,
            tile_stale: false,
            dragging: false,
            full_screen: None,
            can_full_screen: None,
            own_full_screen_space: None,
            margin_current: true,
            busy: false,
            replacement: None,
            leftovers: Vec::new(),
            strips: Vec::new(),
            tries: BTreeMap::new(),
        }
    }
}

impl Situation {
    pub fn tried(&self, c: &Correction) -> u32 {
        self.tries.get(&c.key()).copied().unwrap_or(0)
    }

    /// One line of what's observed, for the log (numbers and kinds only).
    pub fn text(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !self.running {
            parts.push("not running".into());
        }
        if self.hidden == Some(true) {
            parts.push("hidden".into());
        }
        if let Some(window) = self.window {
            let how = if self.mode == Mode::Window {
                "window mode"
            } else if self.member {
                "a member"
            } else {
                "full screen asked"
            };
            let at = if self.window_gone {
                " gone".to_string()
            } else {
                let screen = match self.on_screen {
                    Some(true) => ", on screen",
                    Some(false) => ", off screen",
                    None => "",
                };
                let reads = if self.off_screen_reads > 1 {
                    format!(" ({} reads)", self.off_screen_reads)
                } else {
                    String::new()
                };
                format!(" {}{screen}{reads}", self.place.text())
            };
            parts.push(format!("{}, {how} window {window}{at}", self.phase.name()));
            if let Some(s) = self.own_full_screen_space {
                parts.push(format!("in a full-screen Space of its own ({s})"));
            }
            if self.full_screen == Some(true) && self.own_full_screen_space.is_none() && !self.member {
                parts.push("full screen with no Space of its own".into());
            }
        } else {
            parts.push("no window".into());
        }
        if let Some(r) = self.replacement {
            parts.push(format!("its app's main window now {r}"));
        }
        if self.tile && self.tile_stale {
            parts.push("its tile not at the page area".into());
        }
        let left: Vec<&Other> = self.leftovers.iter().filter(|o| o.in_user_space()).collect();
        if !left.is_empty() {
            let list: Vec<String> = left
                .iter()
                .map(|o| {
                    format!(
                        "{} ({}{})",
                        o.number,
                        o.place.text(),
                        if o.on_screen == Some(true) { ", on screen" } else { "" }
                    )
                })
                .collect();
            parts.push(format!("leftover{} {}", if left.len() == 1 { "" } else { "s" }, list.join(", ")));
        }
        let st: Vec<&Other> = self.strips.iter().filter(|o| o.in_user_space() || o.on_screen == Some(true)).collect();
        if !st.is_empty() {
            let list: Vec<String> = st.iter().map(|o| o.number.to_string()).collect();
            parts.push(format!("strip{} {}", if st.len() == 1 { "" } else { "s" }, list.join(", ")));
        }
        if !self.margin_current {
            parts.push("Margin's Space not current".into());
        }
        parts.join("; ")
    }
}

/// Reads in a row a shown window has to be off screen before it's brought forward.
pub const OFF_SCREEN_AFTER: u32 = 2;
/// How long a shown window that went is given for its app to show another main window before its item is closed.
pub const GONE_GRACE: f64 = 1.0;
/// Reads in a row a shown member has to be off the page area before it's placed again.
pub const OFF_PAGE_AFTER: u32 = 2;

/// The corrections that bring `s` to `d`, most urgent first (the caller applies the first, then looks again).
/// Empty: settled. A correction whose budget is used up is skipped; the first open's path ends in `fallback`.
pub fn step(s: &Situation, d: Desired) -> Vec<Correction> {
    let mut out: Vec<Correction> = Vec::new();
    let add = |out: &mut Vec<Correction>, c: Correction| {
        if s.tried(&c) < c.budget() {
            out.push(c);
        }
    };
    match d {
        Desired::GivenBack => return out,
        Desired::Parked => {
            if !s.running || s.window.is_none() || s.window_gone {
                return out;
            }
            if let Some(r) = s.replacement
                && s.launched_by_margin
            {
                add(&mut out, Correction::Adopt { window: r });
                if !out.is_empty() {
                    return out;
                }
            }
            if s.place.placed() && s.place != WindowPlace::Parked && s.stray_reads >= 2 && !s.busy {
                add(&mut out, Correction::ParkAgain);
            }
            if s.tile && s.tile_stale && !s.busy && !s.dragging {
                add(&mut out, Correction::SizeTile);
            }
            for l in s.leftovers.iter().filter(|l| l.in_user_space()) {
                add(&mut out, Correction::ParkLeftover { window: l.number });
            }
            for st in s.strips.iter().filter(|st| st.in_user_space()) {
                add(&mut out, Correction::ParkStrip { window: st.number });
            }
            return out;
        }
        Desired::Shown => {}
    }
    // 1. The app: running, unhidden, with a window.
    if !s.running {
        add(&mut out, Correction::Launch);
        return if out.is_empty() { vec![Correction::Fallback { why: "it doesn't start".into() }] } else { out };
    }
    if s.window_gone && s.phase == Phase::Shown {
        if let Some(r) = s.replacement {
            add(&mut out, Correction::Adopt { window: r });
            if !out.is_empty() {
                return out;
            }
        }
        if s.gone_for.unwrap_or(0.0) < GONE_GRACE {
            return vec![Correction::Wait {
                why: "its window went: another main window of its app's waited for".into(),
            }];
        }
        return vec![Correction::CloseItem];
    }
    if s.window.is_none() || s.window_gone {
        if let Some(r) = s.replacement {
            add(&mut out, Correction::Adopt { window: r });
            if !out.is_empty() {
                return out;
            }
        }
        if s.hidden == Some(true) {
            add(&mut out, Correction::Unhide);
        }
        add(&mut out, Correction::Reopen);
        return if out.is_empty() { vec![Correction::Fallback { why: "no window to host".into() }] } else { out };
    }
    // 2. Replaced by its app: the new one hosted, never fought.
    if let Some(r) = s.replacement {
        add(&mut out, Correction::Adopt { window: r });
        if !out.is_empty() {
            return out;
        }
    }
    // 3. The main window where it should be.
    if s.busy {
        return vec![Correction::Wait { why: "macOS's transition is still running".into() }];
    }
    match s.phase {
        Phase::None | Phase::Preparing => {
            out.push(first_placement(s));
            return out;
        }
        Phase::Parked => return out,
        Phase::Shown => {
            if s.margin_current {
                if s.place != WindowPlace::Margin && s.place != WindowPlace::Unread {
                    add(&mut out, Correction::PutBack);
                } else if s.place == WindowPlace::Margin && s.off_screen_reads >= OFF_SCREEN_AFTER {
                    let rung = Forward::ALL.into_iter().find(|f| s.tried(&Correction::BringForward { rung: *f }) < 1);
                    match rung {
                        Some(rung) => out.push(Correction::BringForward { rung }),
                        None => out
                            .push(Correction::Fallback { why: "its window stays off screen in Margin's Space".into() }),
                    }
                    return out;
                } else if s.place == WindowPlace::Margin && s.mode == Mode::Window && s.at_page == Some(false) {
                    add(&mut out, Correction::FrameWindow);
                } else if s.place == WindowPlace::Margin && s.tile && s.tile_stale && !s.dragging {
                    add(&mut out, Correction::SizeTile);
                    if out.is_empty() {
                        add(&mut out, Correction::PlaceAgain);
                    }
                } else if s.place == WindowPlace::Margin && s.member && !s.tile && s.off_page_reads >= OFF_PAGE_AFTER {
                    add(&mut out, Correction::PlaceAgain);
                }
            }
        }
    }
    // 4. Nothing else of it in sight: leftovers closed or parked, strips parked.
    for l in s.leftovers.iter().filter(|l| l.in_user_space()) {
        let c = if l.closable {
            Correction::CloseLeftover { window: l.number }
        } else {
            Correction::ParkLeftover { window: l.number }
        };
        add(&mut out, c);
    }
    for st in s.strips.iter().filter(|st| st.in_user_space() || st.on_screen == Some(true)) {
        add(&mut out, Correction::ParkStrip { window: st.number });
    }
    out
}

/// How a window not placed yet is placed, from where it is.
pub fn first_placement(s: &Situation) -> Correction {
    if let Some(own) = s.own_full_screen_space
        && s.full_screen != Some(false)
    {
        return Correction::PlaceFromOwnSpace { space: own };
    }
    if s.mode == Mode::Window || s.can_full_screen == Some(false) {
        return Correction::FrameWindow;
    }
    if s.full_screen == Some(true) && !s.member {
        return Correction::OutThenAsk;
    }
    Correction::AskFullScreen
}

#[cfg(test)]
mod tests;
