//! The window map (app/platforms/macos/shell/WindowMap.swift) and its trace's OS-neutral part (app/platforms/macos/shell/WindowTrace.swift): one
//! place that knows every window Margin cares about, as one snapshot: the browsers' windows and Margin's own
//! (overlays, covers, catchers), each with its bounds, whether it's on screen, its place in the window server's
//! order, its display, its Spaces, and (Safari's, on the Mac) its profile and full screen as Accessibility read
//! them; and every display, with its frame, the Space it shows and its full-screen Spaces.
//!
//! Fed by the shell's reads (the window server's list, already made) and by what it hears (a Space change, a
//! display change). Each update says what changed (`MapChange`). Nothing here decides what Margin shows.
//!
//! **Mac only:** Spaces. They're read through `SpaceReads` (SkyLight on the Mac) for a window when it's new, goes on
//! or off screen or moves, after a Space or display change, and at least every second; the displays after a change
//! and at least every second. Without the reads (`reads` None: tests, Windows), Spaces stay None (unknown), never a
//! guess, and there are no displays unless the shell's `SpaceReads` gives them (a Windows shell can give one per
//! monitor, with no Spaces). Accessibility's `AxKnown` is Safari's; another shell leaves it empty.
//!
//! Only numbers: window numbers, pids, Space ids, display ids, rects. No title, no address.
//!
//! The trace (`TraceLine`, `TraceRecorder`, `load`, `replay`): what the map saw, what the copies said of their
//! windows, where the overlays were and what Margin heard, one JSON line each, in the Swift shell's format, so a
//! session can be read back exactly and become a test. The recorder only makes the lines; writing them (a file of
//! at most `TRACE_MAX_BYTES`, the newest `TRACE_KEEP` kept) is the shell's.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};

use crate::geometry::{Point, Rect};
use crate::system::ServerWindow;
use crate::time::Secs;

/// CGRect's Codable form, `[[x, y], [width, height]]`, as the Swift shell's traces have it.
mod cg_rect {
    use super::Rect;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(r: &Rect, s: S) -> Result<S::Ok, S::Error> {
        [[r.x, r.y], [r.width, r.height]].serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Rect, D::Error> {
        let [[x, y], [w, h]] = <[[f64; 2]; 2]>::deserialize(d)?;
        Ok(Rect::new(x, y, w, h))
    }

    pub mod option {
        use super::Rect;
        use serde::{Deserialize, Deserializer, Serialize, Serializer};

        pub fn serialize<S: Serializer>(r: &Option<Rect>, s: S) -> Result<S::Ok, S::Error> {
            r.map(|r| [[r.x, r.y], [r.width, r.height]]).serialize(s)
        }
        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Rect>, D::Error> {
            Ok(<Option<[[f64; 2]; 2]>>::deserialize(d)?.map(|[[x, y], [w, h]]| Rect::new(x, y, w, h)))
        }
    }
}

/// Whose a window is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    Browser,
    Margin,
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapWindow {
    pub number: i64,
    pub pid: u32,
    pub owner: Owner,
    pub layer: i32,
    /// Top-left origin.
    #[serde(with = "cg_rect")]
    pub bounds: Rect,
    pub on_screen: bool,
    /// Front to back in the window server's list.
    pub order: i64,
    /// None: not read (or unknown); empty: in no user Space (parked, or gone). Mac only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spaces: Option<Vec<u64>>,
    /// The display holding its centre.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    /// Accessibility's (Safari's windows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_screen: Option<bool>,
    /// The profile its title named (Safari's windows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// Parked by Margin (the Mac's handoff); None in older traces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parked: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDisplay {
    /// "Display Identifier".
    pub id: String,
    /// Top-left origin; None when it isn't one of the screens (or "Main" spanning them).
    #[serde(default, with = "cg_rect::option", skip_serializing_if = "Option::is_none")]
    pub frame: Option<Rect>,
    /// The Space it shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<u64>,
    pub desktops: Vec<u64>,
    pub full_screen: Vec<u64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WindowSnapshot {
    pub at: Secs,
    pub windows: BTreeMap<i64, MapWindow>,
    pub displays: Vec<MapDisplay>,
    pub front_pid: Option<u32>,
}

impl WindowSnapshot {
    /// The Spaces showing now, one per display.
    pub fn showing(&self) -> BTreeSet<u64> {
        self.displays.iter().filter_map(|d| d.current).collect()
    }
    pub fn display(&self, id: Option<&str>) -> Option<&MapDisplay> {
        let id = id?;
        self.displays.iter().find(|d| same_id(&d.id, id))
    }
}

/// Display identifiers matched without case (Swift's caseInsensitiveCompare).
fn same_id(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

#[derive(Clone, Debug, PartialEq)]
pub enum MapChange {
    Appeared(i64),
    Gone(i64),
    OnScreen(i64, bool),
    Bounds(i64, Rect),
    Spaces(i64, Option<Vec<u64>>),
    Display(i64, Option<String>),
    FullScreen(i64, Option<bool>),
    Link(i64, Option<String>),
    Parked(i64, Option<bool>),
    Front(Option<u32>),
    Displays(Vec<MapDisplay>),
}

/// One display's Spaces as the OS reads them (SpaceReads.swift `DisplaySpaces`, with its desktops and full-screen
/// Spaces already picked out). **Mac only** in what it means; another shell may give one per monitor, no Spaces.
#[derive(Clone, Debug, PartialEq)]
pub struct DisplaySpaces {
    pub display: String,
    pub current: Option<u64>,
    pub desktops: Vec<u64>,
    pub full_screen: Vec<u64>,
}

/// The OS's Space reads (SpaceReads.swift, SkyLight on the Mac).
pub trait SpaceReads {
    /// One window's Spaces. Empty: in no user Space. None: unknown.
    fn spaces(&self, window: i64) -> Option<Vec<u64>>;
    /// Every managed display's Spaces, one entry per display. None: can't say.
    fn displays(&self) -> Option<Vec<DisplaySpaces>>;
}

/// What Accessibility knows of the browser's windows (SafariAX.swift `AXKnown`, Safari's): each window's profile
/// (its link) and whether it's full screen.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AxKnown {
    pub profiles: BTreeMap<i64, String>,
    pub full_screen: BTreeMap<i64, bool>,
}

/// How often Spaces and displays are read when nothing changed (seconds).
pub const SPACES_EVERY: Secs = 1.0;

pub struct WindowMap {
    snapshot: WindowSnapshot,
    /// The Space reads; None: Spaces unknown.
    pub reads: Option<Box<dyn SpaceReads>>,
    /// Each display's frame by its identifier (top-left origin). None: none known (the Swift shell asks NSScreen;
    /// a shell here gives its screens).
    pub frames: Option<Box<dyn Fn() -> BTreeMap<String, Rect>>>,
    spaces_read_at: Secs,
    displays_read_at: Secs,
    /// A Space or display change heard.
    dirty_since: Secs,
}

impl Default for WindowMap {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowMap {
    pub fn new() -> Self {
        Self {
            snapshot: WindowSnapshot::default(),
            reads: None,
            frames: None,
            spaces_read_at: f64::NEG_INFINITY,
            displays_read_at: f64::NEG_INFINITY,
            dirty_since: f64::NEG_INFINITY,
        }
    }

    pub fn snapshot(&self) -> &WindowSnapshot {
        &self.snapshot
    }

    /// A Space or display change heard: the next update reads Spaces and displays again.
    pub fn spaces_changed(&mut self, now: Secs) {
        self.dirty_since = now;
    }

    /// One read of the window server (`list`, None when it gave none: the windows kept as they were), with who owns
    /// what and what Accessibility knows. The changes, in a stable order.
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &mut self,
        now: Secs,
        list: Option<&[ServerWindow]>,
        browser_pids: &HashSet<u32>,
        margin_pid: u32,
        front: Option<u32>,
        ax: &AxKnown,
        parked: &BTreeSet<i64>,
    ) -> Vec<MapChange> {
        let before = self.snapshot.clone();
        let mut next = WindowSnapshot {
            at: now,
            windows: before.windows.clone(),
            displays: before.displays.clone(),
            front_pid: front,
        };
        if let Some(list) = list {
            let mut windows = BTreeMap::new();
            for w in list {
                let owner = if browser_pids.contains(&w.pid) {
                    Owner::Browser
                } else if w.pid == margin_pid {
                    Owner::Margin
                } else {
                    Owner::Other
                };
                let old = before.windows.get(&w.number);
                let mut m = MapWindow {
                    number: w.number,
                    pid: w.pid,
                    owner,
                    layer: w.layer,
                    bounds: w.bounds,
                    on_screen: w.on_screen,
                    order: w.order as i64,
                    spaces: old.and_then(|o| o.spaces.clone()),
                    display: old.and_then(|o| o.display.clone()),
                    full_screen: None,
                    link: None,
                    parked: None,
                };
                if owner == Owner::Browser {
                    m.full_screen = ax.full_screen.get(&w.number).copied();
                    m.link = ax.profiles.get(&w.number).cloned();
                    m.parked = Some(parked.contains(&w.number));
                }
                windows.insert(w.number, m);
            }
            next.windows = windows;
        }

        // Displays: after a change heard, or every second.
        let displays_due = self.dirty_since > self.displays_read_at || now - self.displays_read_at >= SPACES_EVERY;
        if displays_due {
            if let Some(reads) = &self.reads {
                self.displays_read_at = now;
                if let Some(read) = reads.displays() {
                    let frames = self.frames.as_ref().map(|f| f()).unwrap_or_default();
                    next.displays = read
                        .into_iter()
                        .map(|d| MapDisplay {
                            frame: frames.iter().find(|(k, _)| same_id(k, &d.display)).map(|(_, r)| *r),
                            id: d.display,
                            current: d.current,
                            desktops: d.desktops,
                            full_screen: d.full_screen,
                        })
                        .collect();
                }
            }
        }
        // Each window's display, from its centre and the displays' frames.
        let only = (next.displays.len() == 1).then(|| next.displays[0].id.clone());
        for w in next.windows.values_mut() {
            let c = Point::new(w.bounds.mid_x(), w.bounds.mid_y());
            w.display = next
                .displays
                .iter()
                .find(|d| d.frame.is_some_and(|f| f.contains(c)))
                .map(|d| d.id.clone())
                .or_else(|| only.clone());
        }
        // Spaces: for the windows that are new or changed, after a change heard, or every second (only the
        // browsers' and Margin's own: another app's Spaces aren't Margin's business).
        if let Some(reads) = &self.reads {
            let all = self.dirty_since > self.spaces_read_at || now - self.spaces_read_at >= SPACES_EVERY;
            if all {
                self.spaces_read_at = now;
            }
            for (n, w) in next.windows.iter_mut() {
                if w.owner == Owner::Other {
                    continue;
                }
                let old = before.windows.get(n);
                let changed = old.is_none_or(|o| o.on_screen != w.on_screen || o.bounds != w.bounds);
                if !(all || changed) {
                    continue;
                }
                w.spaces = reads.spaces(*n);
            }
        }
        let changes = Self::changes(&before, &next);
        self.snapshot = next;
        changes
    }

    /// What changed from `a` to `b`: the front, the displays, then each window by number.
    pub fn changes(a: &WindowSnapshot, b: &WindowSnapshot) -> Vec<MapChange> {
        let mut out = Vec::new();
        if a.front_pid != b.front_pid {
            out.push(MapChange::Front(b.front_pid));
        }
        if a.displays != b.displays {
            out.push(MapChange::Displays(b.displays.clone()));
        }
        let numbers: BTreeSet<i64> = a.windows.keys().chain(b.windows.keys()).copied().collect();
        for n in numbers {
            match (a.windows.get(&n), b.windows.get(&n)) {
                (None, Some(w)) => {
                    out.push(MapChange::Appeared(n));
                    out.push(MapChange::OnScreen(n, w.on_screen));
                    out.push(MapChange::Bounds(n, w.bounds));
                    if w.spaces.is_some() {
                        out.push(MapChange::Spaces(n, w.spaces.clone()));
                    }
                    if w.display.is_some() {
                        out.push(MapChange::Display(n, w.display.clone()));
                    }
                    if w.full_screen.is_some() {
                        out.push(MapChange::FullScreen(n, w.full_screen));
                    }
                    if w.link.is_some() {
                        out.push(MapChange::Link(n, w.link.clone()));
                    }
                    if w.parked == Some(true) {
                        out.push(MapChange::Parked(n, Some(true)));
                    }
                }
                (Some(_), None) => out.push(MapChange::Gone(n)),
                (Some(o), Some(w)) => {
                    if o.on_screen != w.on_screen {
                        out.push(MapChange::OnScreen(n, w.on_screen));
                    }
                    if o.bounds != w.bounds {
                        out.push(MapChange::Bounds(n, w.bounds));
                    }
                    if o.spaces != w.spaces {
                        out.push(MapChange::Spaces(n, w.spaces.clone()));
                    }
                    if o.display != w.display {
                        out.push(MapChange::Display(n, w.display.clone()));
                    }
                    if o.full_screen != w.full_screen {
                        out.push(MapChange::FullScreen(n, w.full_screen));
                    }
                    if o.link != w.link {
                        out.push(MapChange::Link(n, w.link.clone()));
                    }
                    if o.parked.unwrap_or(false) != w.parked.unwrap_or(false) {
                        out.push(MapChange::Parked(n, w.parked));
                    }
                }
                (None, None) => {}
            }
        }
        out
    }
}

// ---- the trace ----

/// A trace file is closed at this size and a new one started (the shell's to do).
pub const TRACE_MAX_BYTES: usize = 5 * 1024 * 1024;
/// The newest this many trace files are kept.
pub const TRACE_KEEP: usize = 5;
/// The whole map is written this often (seconds); between, only what changed.
pub const TRACE_SNAP_EVERY: Secs = 30.0;

/// An overlay as the trace has it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TraceOverlay {
    /// Its WindowKey.
    pub k: String,
    /// Its panel's window number.
    pub n: i64,
    /// The window it's over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub over: Option<i64>,
    pub shown: bool,
    /// In its window's own Space (not every Space).
    pub own: bool,
    #[serde(with = "cg_rect")]
    pub f: Rect,
}

/// A copy's window as the trace has it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TraceExt {
    pub k: String,
    pub state: String,
    #[serde(default, with = "cg_rect::option", skip_serializing_if = "Option::is_none")]
    pub b: Option<Rect>,
    pub focused: bool,
}

/// One line: `snap` (the whole map), `w`/`gone`/`d`/`front` (what changed), `ext` (the copies' windows), `ov` (the
/// overlays), `ev` (an event, by name).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TraceLine {
    pub t: Secs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snap: Option<Vec<MapWindow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<Vec<MapWindow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub d: Option<Vec<MapDisplay>>,
    /// The front app's pid; -1: none in front.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub front: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<Vec<TraceExt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ov: Option<Vec<TraceOverlay>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ev: Option<String>,
}

impl TraceLine {
    /// The line as the file has it (no newline).
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

fn front_value(pid: Option<u32>) -> i64 {
    pid.map(i64::from).unwrap_or(-1)
}

/// Makes the trace's lines from what the shell sees, writing only what changed (WindowTrace.swift's `map`, `ext`,
/// `overlays`, `event`). Each returns the line to write, if any.
#[derive(Debug)]
pub struct TraceRecorder {
    last_snap_at: Secs,
    last_ext: Vec<TraceExt>,
    last_ov: Vec<TraceOverlay>,
}

impl Default for TraceRecorder {
    fn default() -> Self {
        Self { last_snap_at: f64::NEG_INFINITY, last_ext: Vec::new(), last_ov: Vec::new() }
    }
}

impl TraceRecorder {
    /// One map update: the whole map now and then, else what changed.
    pub fn map(&mut self, s: &WindowSnapshot, changes: &[MapChange]) -> Option<TraceLine> {
        if s.at - self.last_snap_at >= TRACE_SNAP_EVERY {
            self.last_snap_at = s.at;
            return Some(TraceLine {
                t: s.at,
                snap: Some(s.windows.values().cloned().collect()),
                d: Some(s.displays.clone()),
                front: Some(front_value(s.front_pid)),
                ..TraceLine::default()
            });
        }
        if changes.is_empty() {
            return None;
        }
        let mut line = TraceLine { t: s.at, ..TraceLine::default() };
        let mut changed = BTreeSet::new();
        let mut gone = Vec::new();
        for c in changes {
            match c {
                MapChange::Appeared(n)
                | MapChange::OnScreen(n, _)
                | MapChange::Bounds(n, _)
                | MapChange::Spaces(n, _)
                | MapChange::Display(n, _)
                | MapChange::FullScreen(n, _)
                | MapChange::Link(n, _)
                | MapChange::Parked(n, _) => {
                    changed.insert(*n);
                }
                MapChange::Gone(n) => gone.push(*n),
                MapChange::Front(pid) => line.front = Some(front_value(*pid)),
                MapChange::Displays(d) => line.d = Some(d.clone()),
            }
        }
        if !changed.is_empty() {
            line.w = Some(changed.iter().filter_map(|n| s.windows.get(n).cloned()).collect());
        }
        if !gone.is_empty() {
            gone.sort_unstable();
            line.gone = Some(gone);
        }
        Some(line)
    }

    /// The copies' windows, when they changed.
    pub fn ext(&mut self, list: &[TraceExt], t: Secs) -> Option<TraceLine> {
        let mut sorted = list.to_vec();
        sorted.sort_by(|a, b| a.k.cmp(&b.k));
        if sorted == self.last_ext {
            return None;
        }
        self.last_ext = sorted.clone();
        Some(TraceLine { t, ext: Some(sorted), ..TraceLine::default() })
    }

    /// The overlays, when they changed.
    pub fn overlays(&mut self, list: &[TraceOverlay], t: Secs) -> Option<TraceLine> {
        let mut sorted = list.to_vec();
        sorted.sort_by(|a, b| a.k.cmp(&b.k));
        if sorted == self.last_ov {
            return None;
        }
        self.last_ov = sorted.clone();
        Some(TraceLine { t, ov: Some(sorted), ..TraceLine::default() })
    }

    pub fn event(&mut self, name: &str, t: Secs) -> TraceLine {
        TraceLine { t, ev: Some(name.to_string()), ..TraceLine::default() }
    }
}

/// A trace read back: one line per line of text; a line that doesn't read is left out (as Swift's `load`).
pub fn load(text: &str) -> Vec<TraceLine> {
    text.split('\n').filter(|l| !l.is_empty()).filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// The map as it was after each line that changed it, rebuilt from a trace (from its first `snap` on).
pub fn replay(lines: &[TraceLine]) -> Vec<WindowSnapshot> {
    replay_with_overlays(lines).into_iter().map(|(m, _)| m).collect()
}

fn front_pid(front: i64) -> Option<u32> {
    u32::try_from(front).ok()
}

/// The same, each with the overlays as the trace last said them by then (empty before its first `ov`).
pub fn replay_with_overlays(lines: &[TraceLine]) -> Vec<(WindowSnapshot, Vec<TraceOverlay>)> {
    let mut out = Vec::new();
    let mut ov: Vec<TraceOverlay> = Vec::new();
    let mut s: Option<WindowSnapshot> = None;
    for line in lines {
        if let Some(o) = &line.ov {
            ov = o.clone();
        }
        if let Some(snap) = &line.snap {
            let mut windows = BTreeMap::new();
            for w in snap {
                windows.entry(w.number).or_insert_with(|| w.clone());
            }
            let map = WindowSnapshot {
                at: line.t,
                windows,
                displays: line.d.clone().unwrap_or_default(),
                front_pid: line.front.and_then(front_pid),
            };
            out.push((map.clone(), ov.clone()));
            s = Some(map);
            continue;
        }
        let Some(cur) = s.as_mut() else { continue };
        if line.w.is_none() && line.gone.is_none() && line.d.is_none() && line.front.is_none() {
            continue;
        }
        cur.at = line.t;
        for w in line.w.iter().flatten() {
            cur.windows.insert(w.number, w.clone());
        }
        for n in line.gone.iter().flatten() {
            cur.windows.remove(n);
        }
        if let Some(d) = &line.d {
            cur.displays = d.clone();
        }
        if let Some(f) = line.front {
            cur.front_pid = front_pid(f);
        }
        out.push((cur.clone(), ov.clone()));
    }
    out
}

// The Swift's tests (app/platforms/macos/shell/tests/window-tests.swift `windowMap`), and Tirth's recorded session
// (tests/fixtures/traces/2026-11-07-sidebar-on-desktop.jsonl, as `overlaySpace` replays it).
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Default)]
    struct World {
        displays: Option<Vec<DisplaySpaces>>,
        spaces: BTreeMap<i64, Vec<u64>>,
    }
    struct Fake(Rc<RefCell<World>>);
    impl SpaceReads for Fake {
        fn spaces(&self, window: i64) -> Option<Vec<u64>> {
            self.0.borrow().spaces.get(&window).cloned()
        }
        fn displays(&self) -> Option<Vec<DisplaySpaces>> {
            self.0.borrow().displays.clone()
        }
    }

    const LEFT: Rect = Rect::new(0.0, 0.0, 1512.0, 982.0);
    const RIGHT: Rect = Rect::new(1512.0, 0.0, 1920.0, 1080.0);

    fn display(id: &str, current: u64, desktops: &[u64], full: &[u64]) -> DisplaySpaces {
        DisplaySpaces {
            display: id.into(),
            current: Some(current),
            desktops: desktops.to_vec(),
            full_screen: full.to_vec(),
        }
    }
    fn sw(number: i64, pid: u32, bounds: Rect, on: bool, order: usize) -> ServerWindow {
        ServerWindow { on_screen: on, order, ..ServerWindow::new(number, pid, bounds) }
    }
    fn pids() -> HashSet<u32> {
        [50].into_iter().collect()
    }
    fn world() -> Rc<RefCell<World>> {
        // Two displays, each with its own current Space: a full-screen window on each, one more in a Space not showing.
        let w = Rc::new(RefCell::new(World::default()));
        w.borrow_mut().displays =
            Some(vec![display("D-LEFT", 10, &[1], &[10, 11]), display("D-RIGHT", 20, &[2], &[20])]);
        w.borrow_mut().spaces =
            [(100, vec![10]), (101, vec![11]), (200, vec![20]), (900, vec![10])].into_iter().collect();
        w
    }
    fn list() -> Vec<ServerWindow> {
        vec![
            sw(900, 7, Rect::new(0.0, 0.0, 300.0, 982.0), true, 0),
            sw(100, 50, LEFT, true, 1),
            sw(200, 50, RIGHT, true, 2),
            sw(101, 50, LEFT, false, 3),
            sw(300, 99, LEFT, true, 4),
        ]
    }
    // A swipe on the left display: 101's Space shows, 100's doesn't.
    fn list2() -> Vec<ServerWindow> {
        list()
            .into_iter()
            .map(|w| match w.number {
                100 => sw(100, 50, LEFT, false, 3),
                101 => sw(101, 50, LEFT, true, 1),
                _ => w,
            })
            .collect()
    }
    fn ax() -> AxKnown {
        AxKnown {
            profiles: [(100, "safari:s-a".to_string())].into_iter().collect(),
            full_screen: [(100, true)].into_iter().collect(),
        }
    }
    fn new_map(w: &Rc<RefCell<World>>, frames: &[(&str, Rect)]) -> WindowMap {
        let mut map = WindowMap::new();
        map.reads = Some(Box::new(Fake(w.clone())));
        let frames: BTreeMap<String, Rect> = frames.iter().map(|(k, r)| (k.to_string(), *r)).collect();
        map.frames = Some(Box::new(move || frames.clone()));
        map
    }

    #[test]
    fn the_map() {
        let w = world();
        let mut map = new_map(&w, &[("d-left", LEFT), ("D-RIGHT", RIGHT)]); // (identifiers matched without case)
        let none = BTreeSet::new();
        let first = map.update(1.0, Some(&list()), &pids(), 7, Some(50), &ax(), &none);
        let s = map.snapshot().clone();
        assert_eq!(s.windows[&100].owner, Owner::Browser);
        assert_eq!(s.windows[&900].owner, Owner::Margin);
        assert_eq!(s.windows[&300].owner, Owner::Other);
        assert_eq!(s.displays.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["D-LEFT", "D-RIGHT"]);
        assert_eq!(s.showing(), [10, 20].into_iter().collect());
        assert_eq!(s.windows[&100].display.as_deref(), Some("D-LEFT"), "each window on its display, by its centre");
        assert_eq!(s.windows[&200].display.as_deref(), Some("D-RIGHT"));
        assert_eq!(s.windows[&101].display.as_deref(), Some("D-LEFT"));
        assert_eq!(s.display(Some("d-right")).map(|d| d.id.as_str()), Some("D-RIGHT"));
        assert_eq!(s.windows[&100].spaces, Some(vec![10]));
        assert_eq!(s.windows[&101].spaces, Some(vec![11]));
        assert_eq!(s.windows[&200].spaces, Some(vec![20]));
        assert_eq!(s.windows[&900].spaces, Some(vec![10]));
        assert_eq!(s.windows[&300].spaces, None, "another app's not read");
        assert_eq!(s.windows[&100].link.as_deref(), Some("safari:s-a"));
        assert_eq!(s.windows[&100].full_screen, Some(true));
        assert_eq!(s.windows[&200].link, None);
        assert!(first.contains(&MapChange::Appeared(100)) && first.contains(&MapChange::Front(Some(50))));
        assert!(first.iter().any(|c| matches!(c, MapChange::Displays(_))));

        if let Some(d) = w.borrow_mut().displays.as_mut() {
            d[0].current = Some(11);
        }
        map.spaces_changed(1.1);
        let swipe = map.update(1.2, Some(&list2()), &pids(), 7, Some(50), &ax(), &none);
        assert_eq!(map.snapshot().showing(), [11, 20].into_iter().collect());
        assert!(swipe.contains(&MapChange::OnScreen(100, false)) && swipe.contains(&MapChange::OnScreen(101, true)));
        assert!(!swipe.iter().any(|c| matches!(c, MapChange::OnScreen(200, _))), "{swipe:?}");

        // Nothing moving: no Space read until a second has passed.
        w.borrow_mut().spaces.insert(200, vec![2]);
        let quiet = map.update(1.5, Some(&list2()), &pids(), 7, Some(50), &ax(), &none);
        assert!(quiet.is_empty() && map.snapshot().windows[&200].spaces == Some(vec![20]), "{quiet:?}");
        let later = map.update(2.3, Some(&list2()), &pids(), 7, Some(50), &ax(), &none);
        assert_eq!(later, [MapChange::Spaces(200, Some(vec![2]))], "a second on, Spaces read again");
        let l3: Vec<ServerWindow> = list2().into_iter().filter(|w| w.number != 101).collect();
        let gone = map.update(2.4, Some(&l3), &pids(), 7, None, &ax(), &none);
        assert_eq!(gone, [MapChange::Front(None), MapChange::Gone(101)]);
        let parked_now = map.update(2.45, Some(&l3), &pids(), 7, None, &ax(), &[200].into_iter().collect());
        assert_eq!(parked_now, [MapChange::Parked(200, Some(true))]);
        assert_eq!(map.snapshot().windows[&200].parked, Some(true));
        let shown_now = map.update(2.46, Some(&l3), &pids(), 7, None, &ax(), &none);
        assert_eq!(shown_now, [MapChange::Parked(200, Some(false))]);
        let older: MapWindow = serde_json::from_str(
            r#"{"number":1,"pid":2,"owner":"browser","layer":0,"bounds":[[0,0],[10,10]],"onScreen":true,"order":0}"#,
        )
        .expect("a trace line from before parking was kept");
        assert_eq!(older.parked, None);
        let no_list = map.update(2.5, None, &pids(), 7, None, &ax(), &none);
        assert!(no_list.is_empty() && map.snapshot().windows.len() == 4, "a read with no list keeps the windows");

        // Without the Space reads: Spaces and displays unknown, never guessed.
        let mut blind = WindowMap::new();
        blind.update(1.0, Some(&list()), &pids(), 7, Some(50), &AxKnown::default(), &none);
        assert!(blind.snapshot().windows[&100].spaces.is_none() && blind.snapshot().displays.is_empty());
        assert_eq!(blind.snapshot().windows[&100].parked, Some(false));
        assert_eq!(blind.snapshot().windows[&900].parked, None, "only the browser's windows say parked");
    }

    #[test]
    fn the_trace_round_trip() {
        let w = world();
        let mut m2 = new_map(&w, &[("D-LEFT", LEFT), ("D-RIGHT", RIGHT)]);
        let mut rec = TraceRecorder::default();
        let mut lines: Vec<TraceLine> = Vec::new();
        let mut seen: Vec<WindowSnapshot> = Vec::new();
        let l3: Vec<ServerWindow> = list2().into_iter().filter(|w| w.number != 101).collect();
        for (t, l, f) in [(100.0, list(), 50), (100.2, list2(), 50), (100.4, l3.clone(), 50), (100.6, l3, 0)] {
            if t == 100.2 {
                if let Some(d) = w.borrow_mut().displays.as_mut() {
                    d[0].current = Some(11);
                }
                m2.spaces_changed(t);
            }
            let ch = m2.update(t, Some(&l), &pids(), 7, (f != 0).then_some(f), &ax(), &BTreeSet::new());
            lines.extend(rec.map(m2.snapshot(), &ch));
            if !ch.is_empty() || seen.is_empty() {
                seen.push(m2.snapshot().clone());
            }
        }
        lines.push(rec.event("Space changed", 100.2));
        let ov = TraceOverlay {
            k: "safari:s-a#1".into(),
            n: 900,
            over: Some(100),
            shown: true,
            own: true,
            f: Rect::new(0.0, 0.0, 300.0, 982.0),
        };
        lines.extend(rec.overlays(std::slice::from_ref(&ov), 100.3));
        lines.extend(rec.overlays(&[ov], 100.35));
        let text: String = lines.iter().map(|l| l.to_json() + "\n").collect();
        let back = load(&text);
        assert_eq!(back.len(), 6, "read back line by line:\n{text}");
        assert_eq!(back, lines);
        assert_eq!(replay(&back), seen, "the maps rebuilt from it are the maps it saw");
        assert_eq!(back.iter().filter(|l| l.ov.is_some()).count(), 1, "an overlay state written once while unchanged");
        assert!(back.iter().any(|l| l.ev.as_deref() == Some("Space changed")));
        assert!(!text.contains("title"), "numbers and Margin's own keys only");
        assert!(text.contains(r#""bounds":[[0.0,0.0],[1512.0,982.0]]"#), "CGRect's form: {text}");
        let ext = TraceExt { k: "safari:s-a#1".into(), state: "fullscreen".into(), b: None, focused: true };
        assert!(rec.ext(std::slice::from_ref(&ext), 1.0).is_some() && rec.ext(&[ext], 2.0).is_none());
        assert!(load("not json\n{\"t\": 1}\n").len() == 1, "a line that doesn't read is left out");
    }

    // Tirth's session (2026-11-07 11:32:51): the sidebar left in the Desktop's Space after a switch brought its
    // window back into a new full-screen Space.
    #[test]
    fn tirths_session_replayed() {
        let text = include_str!("../../../../tests/fixtures/traces/2026-11-07-sidebar-on-desktop.jsonl");
        let lines = load(text);
        assert_eq!(lines.len(), text.lines().filter(|l| !l.is_empty()).count(), "every line of the trace reads");
        let maps = replay_with_overlays(&lines);
        assert!(maps.len() > 50, "replayed from its trace ({} maps)", maps.len());
        let (overlay, window) = (63556, 63548);
        let mut wrong = 0;
        let mut window_spaces = BTreeSet::new();
        for (m, ov) in &maps {
            if !ov.iter().any(|o| o.n == overlay && o.shown && o.over == Some(window)) {
                continue;
            }
            let (Some(o), Some(w)) = (m.windows.get(&overlay), m.windows.get(&window)) else { continue };
            if let (true, Some(ws)) = (w.on_screen, &w.spaces) {
                if o.spaces.as_ref() != Some(ws) {
                    wrong += 1;
                    window_spaces.extend(ws.iter().copied());
                    assert_eq!(o.spaces, Some(vec![1]), "the sidebar in the Desktop (Space 1)");
                }
            }
        }
        assert!(wrong > 0, "the sidebar in another Space while its window showed");
        assert_eq!(window_spaces, [3046].into_iter().collect(), "its window in Space 3046");
        // Written back, each line reads the same.
        for l in &lines {
            assert_eq!(load(&l.to_json()), std::slice::from_ref(l));
        }
    }
}
