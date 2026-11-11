//! Which window server window is which of the extension's windows (PLAN.md §5), as lasting bindings learned from
//! evidence, never guessed (`WindowBinder`), and whether an overlay is stacked just above its browser window
//! (`stacked_above`). The port of app/platforms/macos/shell/WindowMatcher.swift, rule for rule, in the same order and with the
//! same constants: the same inputs give the same decisions and the same log lines.
//!
//! The extension knows its windows by id (per copy, so per profile), with their bounds, state, which one its copy
//! calls focused, and when its copy heard each one focused and created (`focusedAt`, `createdAt`: the same
//! machine's clock). The window server knows them by number, with bounds, whether each is on screen and the order
//! front to back, but not whose they are: every profile's windows are one process's. Two full-screen windows on
//! one display have the same bounds, and copies' `focused` flags lag and disagree while a Space changes (a real
//! session's log, 2026-11-05: two profiles' windows swapped for 650 ms when focus broke the tie). So:
//!
//!  - A binding, once made, holds while both windows exist. It never changes on a focus flag. It goes when the
//!    extension's window closes, the window server's goes, the copy goes (or a new copy of Margin starts, whose
//!    ids may be new), and it moves only on strong evidence: two separate focus changes both saying so, or its
//!    bounds matching one other free window alone, steadily, while its own don't.
//!  - Bindings are learned only from evidence, between windows not bound yet: made by Margin (`expect`); created
//!    together (a copy's windows.onCreated and a new window server window, each alone then); focus moved (a copy's
//!    onFocusChanged and the browser's front window changing at about that time, each alone); the only free window
//!    with its bounds (on both sides); visible (the only window on screen with its bounds, every window with them a
//!    reported one, and its page alone saying it's shown); settled focus (within one copy: the only window it calls
//!    focused, the same front window for a while). A copy's focused flag is about its own windows only, so it never
//!    tells one profile's window from another's: their pages do.
//!  - A window it can't tell yet gets no binding, so no overlay is drawn over it (logged once per reason).
//!  - A binding its pages contradict goes after `hidden_drop`.
//!  - The window server's list blips: a bound window missing from a read keeps its binding (`absent_numbers`) for
//!    `Timing::absent`. A read that lost every window the last one had (or every bound one), or that has no list at
//!    all, tells nothing: nothing is learned or forgotten from it. No binding is made by elimination on a read where
//!    a window listed just before is missing.
//!  - Parked windows (docs/HANDOFF.md §2.2, the Mac's handoff): kept bound while missing, off screen or their copy not
//!    linked a while; left out of every rule. **Mac only**: Windows has no parking, so `parked` stays empty there.
//!
//! **Mac-only parts, kept so the port stays comparable:** Spaces (`space_changed_at`, the transitions a Space change
//! makes) never happen on Windows: pass `-inf`. Safari's full-screen toolbar window (`full_screen_toolbar`) and
//! Accessibility's profile names (`exact`) are Safari's. On Windows the shell lists other processes' windows only
//! when on screen (as the Mac's does), and the browser's windows of other virtual desktops as off screen.
//!
//! Every binding made, moved or dropped is one log line with why. Times are only those passed in (`now`, the
//! copies' times): nothing here reads a clock.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

use crate::geometry::Rect;
use crate::json;
use crate::system::ServerWindow;
use crate::time::Secs;

/// One of an extension copy's windows: its link (Hello.key) and its id there. Ordered by link, then id.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WindowKey {
    pub link: String,
    pub window_id: i64,
}

impl WindowKey {
    pub fn new(link: impl Into<String>, window_id: i64) -> Self {
        Self { link: link.into(), window_id }
    }
}

impl std::fmt::Display for WindowKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}#{}", self.link, self.window_id)
    }
}

/// When the page was resized, said its area, and its copy heard it (seconds since 1970; None: not said).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ViewportTimes {
    pub resized: Option<Secs>,
    pub said: Option<Secs>,
    pub heard: Option<Secs>,
}

/// A window as the extension reports it (`windows`, docs/PROTOCOL.md).
#[derive(Clone, Debug, PartialEq)]
pub struct ExtWindow {
    pub key: WindowKey,
    pub bounds: Option<Rect>,
    /// normal, fullscreen, maximized, minimized
    pub state: String,
    pub focused: bool,
    pub active_tab_id: Option<i64>,
    /// Seconds since 1970 (the copy's Date.now(), the same clock as the app's): when its copy last heard
    /// windows.onFocusChanged name it, and windows.onCreated (None: not heard since the copy started).
    pub focused_at: Option<Secs>,
    pub created_at: Option<Secs>,
    /// Where its tab in front's page area sits in it (top left, from the window's corner), when that's less than
    /// the whole window (a docked inspector or the browser's sidebar takes the rest). None: the whole window.
    pub viewport: Option<Rect>,
    /// The page measured where its area starts (a pointer event) rather than taking the missing width to be on the left.
    pub viewport_measured: bool,
    pub viewport_times: Option<ViewportTimes>,
    /// A window its copy had parked before the browser quit, restored as a normal window (the Mac's handoff).
    pub was_parked: bool,
    /// Its tab in front in full screen (a page's own, or video full screen).
    pub page_fullscreen: bool,
    /// Whether its tab in front's page says it's shown (document.visibilityState), and when it last said so.
    /// None: not known (no word from that page), never taken as hidden.
    pub visible: Option<bool>,
    pub visible_at: Option<Secs>,
    /// When its copy last heard windows.onFocusChanged with WINDOW_ID_NONE (none of its windows focused).
    pub blurred_at: Option<Secs>,
}

impl ExtWindow {
    pub fn new(key: WindowKey, bounds: Option<Rect>, state: &str, focused: bool) -> Self {
        Self {
            key,
            bounds,
            state: state.to_string(),
            focused,
            active_tab_id: None,
            focused_at: None,
            created_at: None,
            viewport: None,
            viewport_measured: false,
            viewport_times: None,
            was_parked: false,
            page_fullscreen: false,
            visible: None,
            visible_at: None,
            blurred_at: None,
        }
    }

    fn viewport_of(v: Option<&Value>) -> Option<Rect> {
        let o = json::object(v)?;
        let (x, y) = (json::num(o.get("x"))?, json::num(o.get("y"))?);
        let (w, h) = (json::num(o.get("width"))?, json::num(o.get("height"))?);
        (w > 0.0 && h > 0.0).then_some(Rect::new(x, y, w, h))
    }

    /// The copy's `windows` list (objects; anything else is left out). Its milliseconds become seconds (a time of 0
    /// or less is none), and a window without a whole `windowId` (or `id`) isn't one.
    pub fn parse(list: &[Value], link: &str) -> Vec<ExtWindow> {
        let ms = |v: Option<&Value>| json::num(v).and_then(|n| (n > 0.0).then_some(n / 1000.0));
        list.iter()
            .filter_map(|v| v.as_object())
            .filter_map(|w| {
                let id = json::int(w.get("windowId").or_else(|| w.get("id")))?;
                let mut bounds = None;
                if let (Some(l), Some(t), Some(width), Some(height)) = (
                    json::num(w.get("left")),
                    json::num(w.get("top")),
                    json::num(w.get("width")),
                    json::num(w.get("height")),
                ) {
                    if width > 0.0 && height > 0.0 {
                        bounds = Some(Rect::new(l, t, width, height));
                    }
                }
                let visible_at = ms(w.get("visibleAt"));
                let visible = if visible_at.is_none() { None } else { json::boolean(w.get("visible")) };
                let mut e = ExtWindow::new(
                    WindowKey::new(link, id),
                    bounds,
                    json::string(w.get("state")).unwrap_or("normal"),
                    json::boolean(w.get("focused")).unwrap_or(false),
                );
                e.active_tab_id = json::int(w.get("activeTabId"));
                e.focused_at = ms(w.get("focusedAt"));
                e.created_at = ms(w.get("createdAt"));
                e.viewport = Self::viewport_of(w.get("viewport"));
                e.visible = visible;
                e.visible_at = if visible.is_none() { None } else { visible_at };
                e.blurred_at = ms(w.get("blurredAt"));
                e.viewport_measured = e.viewport.is_some()
                    && json::object(w.get("viewport")).and_then(|o| json::boolean(o.get("measured"))) == Some(true);
                e.was_parked = json::boolean(w.get("wasParked")) == Some(true);
                e.page_fullscreen = json::boolean(w.get("pageFullscreen")) == Some(true);
                if e.viewport.is_some() {
                    if let Some(t) = json::object(w.get("viewportTimes")) {
                        e.viewport_times = Some(ViewportTimes {
                            resized: ms(t.get("resized")),
                            said: ms(t.get("said")),
                            heard: ms(t.get("heard")),
                        });
                    }
                }
                Some(e)
            })
            .collect()
    }
}

// ---- WindowMatcher: the helpers ----

/// How far each edge may be off (points): browsers round, and a window being animated lags a poll.
pub const TOLERANCE: f64 = 8.0;
/// The smallest window that can be a browser window (not a popover, a sheet, a tooltip).
pub const MIN_SIZE: f64 = 120.0;
/// The tallest a full-screen toolbar window can be (`full_screen_toolbar`).
pub const TOOLBAR_MAX_HEIGHT: f64 = 160.0;

/// Each edge within `TOLERANCE`.
pub fn close(a: &Rect, b: &Rect) -> bool {
    close_within(a, b, TOLERANCE)
}

pub fn close_within(a: &Rect, b: &Rect, tolerance: f64) -> bool {
    (a.min_x() - b.min_x()).abs() <= tolerance
        && (a.min_y() - b.min_y()).abs() <= tolerance
        && (a.max_x() - b.max_x()).abs() <= tolerance
        && (a.max_y() - b.max_y()).abs() <= tolerance
}

/// The browser's windows a binding can be: normal ones (layer 0), drawn, browser-sized.
pub fn candidates(server: &[ServerWindow], pids: &HashSet<u32>) -> Vec<ServerWindow> {
    server
        .iter()
        .filter(|w| {
            pids.contains(&w.pid)
                && w.layer == 0
                && w.alpha > 0.0
                && w.bounds.width >= MIN_SIZE
                && w.bounds.height >= MIN_SIZE
        })
        .cloned()
        .collect()
}

/// **Mac only (Safari).** A full-screen browser window's toolbar, which Safari draws as a window of its own: the
/// same process, layer 0, the window's left edge and width, short, parked just above the window's top (y = top −
/// its height) and sliding down over it when revealed; listed above the window. Margin's overlay goes between the
/// two. The nearest such window above it (the first of the highest order, as Swift's `max(by:)`), if any.
pub fn full_screen_toolbar(list: &[ServerWindow], browser: &ServerWindow) -> Option<ServerWindow> {
    let b = browser.bounds;
    let mut best: Option<&ServerWindow> = None;
    for w in list.iter().filter(|w| {
        w.number != browser.number
            && w.pid == browser.pid
            && w.layer == 0
            && w.order < browser.order
            && (w.bounds.min_x() - b.min_x()).abs() <= 1.0
            && (w.bounds.width - b.width).abs() <= 1.0
            && w.bounds.height > 0.0
            && w.bounds.height <= TOOLBAR_MAX_HEIGHT
            && w.bounds.min_y() >= b.min_y() - w.bounds.height - 1.0
            && w.bounds.min_y() <= b.min_y() + 1.0
    }) {
        if best.is_none_or(|x| x.order < w.order) {
            best = Some(w);
        }
    }
    best.cloned()
}

/// A window between an overlay and its browser window that counts against it: not the overlay's own, normal or
/// higher, drawn, not the browser's own small window (a popover above its window), over the browser window.
fn in_between(w: &ServerWindow, own: &BTreeSet<i64>, browser_pid: u32, browser: &Rect) -> bool {
    !own.contains(&w.number)
        && w.layer >= 0
        && w.alpha > 0.0
        && !(w.pid == browser_pid && w.layer > 0)
        && w.bounds.intersects(browser)
}

/// Whether `overlay` is just above `browser` in the window server's list: both on screen, the overlay nearer the
/// front, and no other normal or higher window (any app's, another overlay) between them. And below the browser
/// window's full-screen toolbar (`toolbar`), when it has one. `own`: the overlay's own windows that go between it
/// and the browser window (its catcher).
pub fn stacked_above(
    list: &[ServerWindow],
    overlay: i64,
    browser: i64,
    toolbar: Option<i64>,
    own: &BTreeSet<i64>,
) -> bool {
    if let Some(toolbar) = toolbar {
        let mut all: Vec<&ServerWindow> = list.iter().collect();
        all.sort_by_key(|w| w.order);
        let t = all.iter().position(|w| w.number == toolbar);
        let o = all.iter().position(|w| w.number == overlay);
        if let (Some(t), Some(o)) = (t, o) {
            if t > o {
                return false;
            }
        }
    }
    let mut shown: Vec<&ServerWindow> = list.iter().filter(|w| w.on_screen).collect();
    shown.sort_by_key(|w| w.order);
    let (Some(o), Some(b)) =
        (shown.iter().position(|w| w.number == overlay), shown.iter().position(|w| w.number == browser))
    else {
        return false;
    };
    if o >= b {
        return false;
    }
    let (pid, bounds) = (shown[b].pid, shown[b].bounds);
    !shown[o + 1..b].iter().any(|w| in_between(w, own, pid, &bounds))
}

/// The same question asked exactly: `above_browser`, the on-screen windows in front of the browser's window (front
/// to back), `above_toolbar` the same for its full-screen toolbar. The overlay is in front of its window, behind
/// the toolbar, with nothing but its own windows, the browser's small ones and see-through ones between.
pub fn stacked_above_exactly(
    above_browser: &[ServerWindow],
    above_toolbar: Option<&[ServerWindow]>,
    overlay: i64,
    browser: &Rect,
    browser_pid: u32,
    own: &BTreeSet<i64>,
) -> bool {
    let Some(o) = above_browser.iter().position(|w| w.number == overlay) else { return false };
    if above_toolbar.is_some_and(|t| t.iter().any(|w| w.number == overlay)) {
        return false;
    }
    !above_browser[o + 1..].iter().any(|w| in_between(w, own, browser_pid, browser))
}

/// "x,y w×h" in whole points.
pub fn describe(r: &Rect) -> String {
    r.describe()
}

/// A time as the log shows it, to the millisecond: HH:mm:ss.SSS, `offset` seconds from UTC (Swift's shows the
/// local time; nothing here reads the time zone, so the shell gives it: `WindowBinder::clock_offset`).
pub fn clock(t: Secs, offset: Secs) -> String {
    if !t.is_finite() {
        return "--:--:--.---".to_string();
    }
    let ms = ((t + offset) * 1000.0).floor() as i64;
    let day = ms.rem_euclid(86_400_000);
    format!("{:02}:{:02}:{:02}.{:03}", day / 3_600_000, day / 60_000 % 60, day / 1000 % 60, day % 1000)
}

/// A Double as Swift's string interpolation writes it ("0.5", "1.0").
fn swift_double(x: f64) -> String {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 1e16 { format!("{x:.1}") } else { format!("{x}") }
}

fn keys_joined<'a>(list: impl IntoIterator<Item = &'a ExtWindow>) -> String {
    list.into_iter().map(|e| e.key.to_string()).collect::<Vec<_>>().join(", ")
}

fn fits(e: &ExtWindow, w: &ServerWindow) -> bool {
    e.bounds.is_some_and(|b| close(&b, &w.bounds))
}

// ---- the binder ----

/// The binder's times, in seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct Timing {
    /// A focus or a creation and the window server's change it goes with: this far apart at most, beyond the reads
    /// either side of the change.
    pub slack: f64,
    /// Nothing else of the kind this near it (another focus, another front window, another new window).
    pub alone: f64,
    /// A change seen across a longer gap between reads says too little about when it happened.
    pub max_gap: f64,
    /// Across reads that told nothing (or that missed the front window), a shorter one.
    pub blind: f64,
    /// A copy's report may come this late: an event is weighed only once this has passed after `alone`.
    pub report_lag: f64,
    /// Settled focus: the same only-focused window and front window this long…
    pub settle: f64,
    /// …with the front window the same this long (copies' flags may lag a switch by about a second).
    pub quiet: f64,
    /// A new window's bounds may take this long to agree with its new extension window's (full screen opening).
    pub created: f64,
    /// A bound window whose bounds match another free window, not its own, this long (both still): moved.
    pub moved: f64,
    /// A focus change against a binding is remembered this long, for a second one to move it.
    pub conflict: f64,
    /// Events kept this long.
    pub history: f64,
    /// A window missing from the window server's list this long is gone; shorter, a blip: the same window when back.
    pub absent: f64,
    /// A copy that reported and now neither reports nor is held is taken as away this long, then forgotten.
    pub away: f64,
    /// No front window for less than this, between two reads with one: a blip, not a front change.
    pub front_blip: f64,
    /// The visible rule: a page's word may come this long after the change that caused it; only a word said after
    /// the last change, and this long after the one before, is taken as about the windows now.
    pub visible_lag: f64,
    /// What the pages say holds this long, over reads that told something, before a window is bound by it.
    pub visible_hold: f64,
    /// A page that has said nothing doesn't stop the one that says it's shown, once this long has passed after
    /// `visible_lag` from the last change (a real session's log, 2026-11-06 21:24: one page never spoke, nothing drawn).
    pub visible_quiet: f64,
    /// A bound window on screen whose page has said it's hidden this long, while another profile's same-bounds
    /// window's page says it's shown: not its window, the binding goes.
    pub hidden_drop: f64,
    /// ...but not this soon after a Space change.
    pub hidden_quiet: f64,
    /// Visible at once: a page's word that it's shown counts for a window come on screen if said no more than this
    /// before the read the window was first seen on screen after.
    pub visible_fresh: f64,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            slack: 0.5,
            alone: 1.0,
            max_gap: 1.0,
            blind: 0.3,
            report_lag: 1.0,
            settle: 1.0,
            quiet: 5.0,
            created: 5.0,
            moved: 2.0,
            conflict: 120.0,
            history: 20.0,
            absent: 3.0,
            away: 5.0,
            front_blip: 0.5,
            visible_lag: 1.0,
            visible_hold: 0.3,
            visible_quiet: 1.0,
            hidden_drop: 2.0,
            hidden_quiet: 1.0,
            visible_fresh: 0.1,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub number: i64,
    pub why: String,
    pub at: Secs,
}

/// One read for `WindowBinder::update`.
#[derive(Clone, Debug)]
pub struct Update {
    /// Seconds since 1970 (the extension's clock).
    pub now: Secs,
    /// The windows of the copies that report (their state is here).
    pub ext: Vec<ExtWindow>,
    /// Those copies' links.
    pub reporting: BTreeSet<String>,
    /// Each reporting link's copy (its instanceId): a new one may have new window ids, so its bindings go.
    pub copies: BTreeMap<String, String>,
    /// Links whose bindings stay as they are though they say nothing now (dropped a moment ago, or linked again
    /// without their state yet).
    pub held: BTreeSet<String>,
    /// The window server's list (`WindowSource::read`), empty with `listed` false when it gave none.
    pub server: Vec<ServerWindow>,
    /// The browser's processes (empty: it isn't running).
    pub pids: HashSet<u32>,
    /// The browser is the active app.
    pub browser_in_front: bool,
    pub listed: bool,
    /// **Mac only.** When the active Space last changed (the same clock as `now`); `-inf`: not since start, always
    /// on Windows.
    pub space_changed_at: Secs,
    /// **Mac only.** The parking registry's window numbers: kept bound while missing or off screen, left out of
    /// every rule.
    pub parked: BTreeSet<i64>,
    /// **Mac only (Safari's Accessibility).** Window number → the link of the profile its title names.
    pub exact: BTreeMap<i64, String>,
}

impl Default for Update {
    fn default() -> Self {
        Self {
            now: 0.0,
            ext: Vec::new(),
            reporting: BTreeSet::new(),
            copies: BTreeMap::new(),
            held: BTreeSet::new(),
            server: Vec::new(),
            pids: HashSet::new(),
            browser_in_front: false,
            listed: true,
            space_changed_at: f64::NEG_INFINITY,
            parked: BTreeSet::new(),
            exact: BTreeMap::new(),
        }
    }
}

/// First listed between `after` and `at`; `before`: there at the first read.
#[derive(Clone, Copy, Debug)]
struct Seen {
    at: Secs,
    after: Secs,
    before: bool,
}

/// A front window change. `timed`: false for one seen across reads that told nothing (or with the front window
/// missing) for longer than `blind`.
#[derive(Clone, Copy, Debug)]
struct Change {
    at: Secs,
    after: Secs,
    number: Option<i64>,
    timed: bool,
}

/// A focus or creation heard. `contradicted`: the copy's report that carried it called another of its windows focused.
#[derive(Clone, Debug)]
struct Event {
    key: WindowKey,
    at: Secs,
    contradicted: bool,
    decided: bool,
}

#[derive(Clone, Debug)]
struct Pending {
    key: WindowKey,
    number: i64,
    until: Secs,
    why: String,
}

/// A window Margin's own request made. `bounds`: as the request's answer gave them, used until its copy's list has
/// it; `answered`: when the answer came.
#[derive(Clone, Debug)]
struct Made {
    key: WindowKey,
    since: Secs,
    answered: Secs,
    until: Secs,
    why: String,
    bounds: Option<Rect>,
}

/// A parked window the parking registry knows again after a new copy. `until`: set at the first read after it was asked.
#[derive(Clone, Debug)]
struct ParkedExpect {
    key: WindowKey,
    number: i64,
    why: String,
    until: Option<Secs>,
}

/// A change that changes which pages are shown: the browser's windows coming on or going off screen, and Space
/// changes (not the front window alone: that shows and hides no page). `at`: when it may have begun; `latest`: the
/// latest it can have happened. A Space change heard within `visible_lag` after windows came or went is taken as
/// the same one; windows going off screen within `visible_lag` of the last change are the end of it (a slide).
/// `front`: seen in the window server's list; `went`: the windows gone off screen in it.
#[derive(Clone, Debug)]
struct Transition {
    at: Secs,
    latest: Secs,
    space: bool,
    front: bool,
    went: BTreeSet<i64>,
}

/// What one read knows that the rules share.
struct Frame {
    now: Secs,
    t: Timing,
    reporting: BTreeSet<String>,
    held: BTreeSet<String>,
    parked: BTreeSet<i64>,
    present: BTreeMap<i64, ServerWindow>,
    candidates: Vec<ServerWindow>,
    /// Keys the registry is about to bind (expectParked), as at the read's start.
    expected_parked: BTreeSet<WindowKey>,
    by_key: BTreeMap<WindowKey, ExtWindow>,
    in_front: bool,
    /// The visible rule's: a page's word newer than this is about the windows now.
    threshold: Secs,
    settled_pages: bool,
}

impl Frame {
    fn gone(&self, key: &WindowKey) -> bool {
        self.reporting.contains(&key.link) && !self.by_key.contains_key(key)
    }
    fn said_since(&self, e: &ExtWindow) -> bool {
        e.visible_at.unwrap_or(f64::NEG_INFINITY) > self.threshold && e.visible.is_some()
    }
    /// Hidden: said since the last change, or before it once every page has had its time to say since.
    fn hidden_now(&self, e: &ExtWindow) -> bool {
        e.visible == Some(false) && (self.said_since(e) || self.settled_pages)
    }
}

pub type Log = Box<dyn FnMut(&str) + Send>;

/// One browser's bindings (Safari's, Chrome's, Edge's): each extension window to the number of the window server
/// window it is. `update` once per read of the window server; it returns every binding.
pub struct WindowBinder {
    pub browser: String,
    pub timing: Timing,
    /// Seconds added to UTC for the log's times (the local time zone's offset).
    pub clock_offset: Secs,
    log: Log,
    bindings: BTreeMap<WindowKey, Binding>,
    // This read's profile identities constrain every weaker binding rule.
    exact_profiles: BTreeMap<i64, String>,

    reads: u64,
    last_read: Secs,
    seen: BTreeMap<i64, Seen>,
    /// A window server window whose extension window closed: never bound again.
    retired: BTreeSet<i64>,
    server_moved: BTreeMap<i64, (Rect, Secs)>,
    ext_moved: BTreeMap<WindowKey, (Rect, Secs)>,
    front: Option<i64>,
    /// When the front window last changed (the first read, for one in front from before).
    front_since: Option<Secs>,
    changes: Vec<Change>,
    focus_heard: BTreeMap<WindowKey, Secs>,
    create_heard: BTreeMap<WindowKey, Secs>,
    focus_events: Vec<Event>,
    create_events: Vec<Event>,
    pending: Vec<Pending>,
    conflicts: BTreeMap<WindowKey, (i64, Secs)>,
    settling: Option<(WindowKey, i64, Secs)>,
    drift: BTreeMap<WindowKey, (i64, Secs)>,
    made: Vec<Made>,
    /// Bound from an answer's bounds before the copy listed the window: not taken as closed until this time.
    awaiting_list: BTreeMap<WindowKey, Secs>,
    parked_expects: Vec<ParkedExpect>,
    /// Each parked binding's reason for being kept that the log said last.
    parked_kept: BTreeMap<WindowKey, String>,
    /// Each link's copy (instanceId), last seen.
    copy_of: BTreeMap<String, String>,
    waiting_said: BTreeMap<WindowKey, String>,
    /// Blips: a number listed before and missing since this read (bound, closed or only seen).
    unlisted: BTreeMap<i64, Secs>,
    absent_said: BTreeSet<i64>,
    /// The browser-sized windows of the last read that told something.
    reliable_big: BTreeSet<i64>,
    last_reliable: Secs,
    collapsed_since: Option<Secs>,
    collapsed_reads: u64,
    /// The browser's layer-0 windows in the last read that told something (for the collapse's line).
    last_mine_count: Option<usize>,
    /// When a browser-sized window never listed before was last first listed.
    fresh_at: Secs,
    /// The front window missing (and nothing else in front) since the read after this.
    front_missing_after: Option<Secs>,
    /// Each window server window's settled bounds: the last it kept for `moved` with no Space change meanwhile.
    settled_bounds: BTreeMap<i64, Rect>,
    /// Each link that has reported, and when it last reported or was held. Forgotten when the browser isn't running.
    links_seen: BTreeMap<String, Secs>,
    first_read_at: Option<Secs>,
    /// Reads that told something (whole lists, nothing missing), in a row since.
    steady_since: Option<Secs>,
    steady_reads: u64,
    transitions: Vec<Transition>,
    last_space_change: Secs,
    /// The browser's windows on screen in the last read that told something.
    last_on_screen: BTreeSet<i64>,
    /// Since when each has been on screen (the read before it was first seen there; -inf: at the first read), and
    /// the latest each may have been on screen.
    on_screen_since: BTreeMap<i64, Secs>,
    last_on: BTreeMap<i64, Secs>,
    /// The visible rule's evidence for each free window on screen, held since; why it didn't bind (said once).
    seeing: BTreeMap<i64, (WindowKey, Secs)>,
    visible_said: BTreeMap<i64, String>,
    hidden_since: BTreeMap<WindowKey, Secs>,
    settled_said: Option<String>,
    visible_off_said: Option<String>,
    /// The front window's changes not logged yet (logged at most once a second).
    front_noted: Vec<String>,
    front_noted_at: Secs,
    absent_numbers: BTreeSet<i64>,
    last_read_collapsed: bool,
}

impl WindowBinder {
    pub fn new(browser: &str, timing: Timing, log: Log) -> Self {
        Self {
            browser: browser.to_string(),
            timing,
            clock_offset: 0.0,
            log,
            bindings: BTreeMap::new(),
            exact_profiles: BTreeMap::new(),
            reads: 0,
            last_read: 0.0,
            seen: BTreeMap::new(),
            retired: BTreeSet::new(),
            server_moved: BTreeMap::new(),
            ext_moved: BTreeMap::new(),
            front: None,
            front_since: None,
            changes: Vec::new(),
            focus_heard: BTreeMap::new(),
            create_heard: BTreeMap::new(),
            focus_events: Vec::new(),
            create_events: Vec::new(),
            pending: Vec::new(),
            conflicts: BTreeMap::new(),
            settling: None,
            drift: BTreeMap::new(),
            made: Vec::new(),
            awaiting_list: BTreeMap::new(),
            parked_expects: Vec::new(),
            parked_kept: BTreeMap::new(),
            copy_of: BTreeMap::new(),
            waiting_said: BTreeMap::new(),
            unlisted: BTreeMap::new(),
            absent_said: BTreeSet::new(),
            reliable_big: BTreeSet::new(),
            last_reliable: 0.0,
            collapsed_since: None,
            collapsed_reads: 0,
            last_mine_count: None,
            fresh_at: f64::NEG_INFINITY,
            front_missing_after: None,
            settled_bounds: BTreeMap::new(),
            links_seen: BTreeMap::new(),
            first_read_at: None,
            steady_since: None,
            steady_reads: 0,
            transitions: Vec::new(),
            last_space_change: f64::NEG_INFINITY,
            last_on_screen: BTreeSet::new(),
            on_screen_since: BTreeMap::new(),
            last_on: BTreeMap::new(),
            seeing: BTreeMap::new(),
            visible_said: BTreeMap::new(),
            hidden_since: BTreeMap::new(),
            settled_said: None,
            visible_off_said: None,
            front_noted: Vec::new(),
            front_noted_at: f64::NEG_INFINITY,
            absent_numbers: BTreeSet::new(),
            last_read_collapsed: false,
        }
    }

    /// Every binding, with why and when.
    pub fn bindings(&self) -> &BTreeMap<WindowKey, Binding> {
        &self.bindings
    }
    /// Every binding's number.
    pub fn numbers(&self) -> BTreeMap<WindowKey, i64> {
        self.bindings.iter().map(|(k, b)| (k.clone(), b.number)).collect()
    }
    /// The front window's changes it has noted (for the tests).
    pub fn front_changes(&self) -> Vec<Option<i64>> {
        self.changes.iter().map(|c| c.number).collect()
    }
    /// Bound windows the last read didn't list (kept, for `Timing::absent`): the shell keeps their overlays where
    /// they are, unseen.
    pub fn absent_numbers(&self) -> &BTreeSet<i64> {
        &self.absent_numbers
    }
    /// The last read told nothing (no list, or none of the browser's windows in it): bindings kept as they were.
    pub fn last_read_collapsed(&self) -> bool {
        self.last_read_collapsed
    }

    fn note(&mut self, line: String) {
        (self.log)(&line);
    }
    fn clock(&self, t: Secs) -> String {
        clock(t, self.clock_offset)
    }

    /// The app's own request made this window (asked at `since`, answered `now` with its id): it's bound to the one
    /// new window the window server lists from about then, once their bounds agree: its copy's list's bounds, or the
    /// bounds the answer gave (`bounds`), so it binds before the copy's list catches up.
    pub fn expect(&mut self, key: WindowKey, since: Secs, now: Secs, why: &str, bounds: Option<Rect>) {
        if self.bindings.contains_key(&key) {
            return;
        }
        self.made.retain(|m| m.key != key);
        let until = now + self.timing.created;
        self.made.push(Made { key, since, answered: now, until, why: why.to_string(), bounds });
    }

    /// **Mac only.** A parked window (`number`, the parking registry's) is this key: its copy's new id after a new
    /// copy. Bound at the next read whose copy lists the key, unless the window is a closed one's, the key is already
    /// another window's, or the number stays another key's for `Timing::created`. Each outcome is one log line.
    pub fn expect_parked(&mut self, key: WindowKey, number: i64, why: &str) {
        self.parked_expects.retain(|p| p.key != key && p.number != number);
        self.parked_expects.push(ParkedExpect { key, number, why: why.to_string(), until: None });
    }

    /// What the parking registry's rebind returned, each expected as above (in key order).
    pub fn expect_parked_all(&mut self, rebound: &BTreeMap<WindowKey, i64>, why: &str) {
        for (key, number) in rebound {
            self.expect_parked(key.clone(), *number, why);
        }
    }

    fn profile_allows(&self, key: &WindowKey, number: i64) -> bool {
        self.exact_profiles.get(&number).is_none_or(|link| *link == key.link)
    }

    fn bind(&mut self, key: &WindowKey, number: i64, now: Secs, why: String, was: Option<i64>) -> bool {
        if !self.profile_allows(key, number) {
            return false;
        }
        let was = was.map(|n| format!(" (was {n})")).unwrap_or_default();
        self.note(format!("{key} is window {number}{was}: {why}"));
        self.bindings.insert(key.clone(), Binding { number, why, at: now });
        self.conflicts.remove(key);
        self.drift.remove(key);
        self.waiting_said.remove(key);
        self.pending.retain(|p| p.key != *key && p.number != number);
        true
    }

    fn drop_binding(&mut self, key: &WindowKey, why: String) {
        let Some(b) = self.bindings.remove(key) else { return };
        self.absent_said.remove(&b.number);
        self.conflicts.remove(key);
        self.drift.remove(key);
        self.parked_kept.remove(key);
        self.awaiting_list.remove(key);
        self.note(format!("{key} is no longer window {}: {why}", b.number));
    }

    // ---- the rules' shared questions (the Swift's nested functions) ----

    fn bound(&self) -> BTreeSet<i64> {
        self.bindings.values().map(|b| b.number).collect()
    }
    fn holder_of(&self, number: i64, not: &WindowKey) -> Option<WindowKey> {
        self.bindings.iter().find(|(k, b)| b.number == number && *k != not).map(|(k, _)| k.clone())
    }
    fn missing(&self, f: &Frame, n: i64) -> bool {
        !f.present.contains_key(&n) && self.unlisted.get(&n).is_some_and(|since| f.now - since < f.t.absent)
    }
    /// A key bound to a parked window, or one the registry is about to bind: its window is in no user Space, so the
    /// reported windows' side of every rule leaves it out too.
    fn parked_key(&self, f: &Frame, key: &WindowKey) -> bool {
        f.expected_parked.contains(key) || self.bindings.get(key).is_some_and(|b| f.parked.contains(&b.number))
    }
    /// Free: not bound (a missing bound window is still bound), not a closed window's.
    fn free_server(&self, f: &Frame) -> Vec<ServerWindow> {
        let b = self.bound();
        f.candidates.iter().filter(|w| !b.contains(&w.number) && !self.retired.contains(&w.number)).cloned().collect()
    }
    fn free_ext(&self, f: &Frame) -> Vec<ExtWindow> {
        f.by_key
            .values()
            .filter(|e| {
                !self.bindings.contains_key(&e.key)
                    && !self.parked_key(f, &e.key)
                    && e.state != "minimized"
                    && e.bounds.is_some()
            })
            .cloned()
            .collect()
    }
    /// Free windows missing from this read, by the bounds they were last listed with (not one gone before a new
    /// window came: that's a window replaced).
    fn missing_free(&self, f: &Frame, r: &Rect) -> usize {
        let b = self.bound();
        self.unlisted
            .iter()
            .filter(|&(&n, &since)| {
                since > self.fresh_at
                    && self.missing(f, n)
                    && !b.contains(&n)
                    && !self.retired.contains(&n)
                    && self.server_moved.get(&n).is_some_and(|m| close(&m.0, r))
            })
            .count()
    }
    /// A window has bounds `r` if it's there now, or it settled there and hasn't settled anywhere else since (a
    /// window offset for a moment, in a swipe or Mission Control, still has its own).
    fn has(&self, f: &Frame, n: i64, r: &Rect) -> bool {
        f.present.get(&n).is_some_and(|w| close(&w.bounds, r))
            || self.settled_bounds.get(&n).is_some_and(|s| close(s, r))
    }
    /// How many of the browser's windows have `r` (bound ones too, missing ones by their last bounds); equal to
    /// `ext_fitting(r).len()`, every window with those bounds is a reported one.
    fn server_having(&self, f: &Frame, r: &Rect) -> usize {
        let b = self.bound();
        let listed = f.candidates.iter().filter(|w| self.has(f, w.number, r)).count();
        let gone = self
            .unlisted
            .iter()
            .filter(|&(&n, &since)| {
                self.missing(f, n)
                    && !f.present.contains_key(&n)
                    && !self.retired.contains(&n)
                    && (b.contains(&n) || since > self.fresh_at)
                    && self.server_moved.get(&n).is_some_and(|m| close(&m.0, r))
            })
            .count();
        listed + gone
    }
    fn ext_fitting(&self, f: &Frame, r: &Rect) -> Vec<ExtWindow> {
        f.by_key
            .values()
            .filter(|e| !self.parked_key(f, &e.key) && e.state != "minimized" && e.bounds.is_some_and(|b| close(&b, r)))
            .cloned()
            .collect()
    }
    /// The pages say `e` isn't `w`: its page hidden (said since the last change) while `w` is the one on screen with
    /// its bounds, and another profile's window with them says it's shown.
    fn pages_deny(&self, f: &Frame, e: &ExtWindow, w: &ServerWindow) -> bool {
        e.visible == Some(false)
            && f.said_since(e)
            && w.on_screen
            && f.candidates.iter().filter(|c| c.on_screen && close(&c.bounds, &w.bounds)).count() == 1
            && self
                .ext_fitting(f, &w.bounds)
                .iter()
                .any(|x| x.key.link != e.key.link && x.visible == Some(true) && f.said_since(x))
    }
    fn unsteady_missing(&self, f: &Frame) -> bool {
        self.unlisted.keys().any(|&n| self.missing(f, n) && !self.retired.contains(&n))
    }

    /// One read of the window server and what the copies say: every binding after it. See `Update` for the inputs.
    pub fn update(&mut self, u: &Update) -> BTreeMap<WindowKey, i64> {
        self.exact_profiles =
            u.exact.iter().filter(|(n, _)| !u.parked.contains(n)).map(|(n, l)| (*n, l.clone())).collect();
        let out = self.update_read(u);
        self.last_read = u.now;
        self.note_front(u.now);
        out
    }

    fn update_read(&mut self, u: &Update) -> BTreeMap<WindowKey, i64> {
        let now = u.now;
        let first = self.reads == 0; // the first read that told something
        let t = self.timing.clone();
        if self.first_read_at.is_none() {
            self.first_read_at = Some(now);
        }
        if u.pids.is_empty() {
            self.links_seen.clear();
        }
        for link in &u.reporting {
            self.links_seen.insert(link.clone(), now);
        }
        for link in &u.held {
            if let Some(v) = self.links_seen.get_mut(link) {
                *v = now; // (kept while held)
            }
        }
        self.links_seen.retain(|_, v| now - *v < t.away);
        // A Space change: the same transition as a new front window just before it, or one of its own.
        if u.space_changed_at > self.last_space_change {
            let at = u.space_changed_at;
            self.last_space_change = at;
            match self.transitions.last_mut() {
                Some(last) if last.front && !last.space && at - last.latest <= t.visible_lag => {
                    last.space = true;
                    last.latest = last.latest.max(at);
                }
                _ => {
                    self.transitions.push(Transition {
                        at,
                        latest: at,
                        space: true,
                        front: false,
                        went: BTreeSet::new(),
                    });
                    self.keep_last_transitions();
                }
            }
        }

        // ---- the window server's side ----
        let mine: Vec<&ServerWindow> = u.server.iter().filter(|w| u.pids.contains(&w.pid) && w.layer == 0).collect();
        let mut present: BTreeMap<i64, ServerWindow> = BTreeMap::new();
        for w in &mine {
            present.entry(w.number).or_insert_with(|| (*w).clone());
        }
        // (Parked windows are no rule's: never a candidate, never counted among the browser-sized ones.)
        let cands: Vec<ServerWindow> =
            candidates(&u.server, &u.pids).into_iter().filter(|w| !u.parked.contains(&w.number)).collect();
        let big: BTreeSet<i64> = mine
            .iter()
            .filter(|w| !u.parked.contains(&w.number) && w.bounds.width >= MIN_SIZE && w.bounds.height >= MIN_SIZE)
            .map(|w| w.number)
            .collect();
        let bound_before = self.bound();
        let mut f = Frame {
            now,
            t: t.clone(),
            reporting: u.reporting.clone(),
            held: u.held.clone(),
            parked: u.parked.clone(),
            present,
            candidates: cands,
            expected_parked: self.parked_expects.iter().map(|p| p.key.clone()).collect(),
            by_key: BTreeMap::new(),
            in_front: u.browser_in_front,
            threshold: f64::NEG_INFINITY,
            settled_pages: true,
        };

        // A read that tells nothing (a real session's log, 2026-11-05: reads without any of Safari's windows, next to Space
        // changes, each back a read later): no list at all, or none of the browser-sized windows the last read that
        // told something had, or none of the bound ones, or none at all, and no new one, while the browser runs and
        // its copies still have windows. Nothing is learned or forgotten from it, for `absent` at most.
        let reported: BTreeSet<WindowKey> =
            u.ext.iter().filter(|e| u.reporting.contains(&e.key.link)).map(|e| e.key.clone()).collect();
        let ext_has = !u.held.is_empty()
            || u.ext
                .iter()
                .any(|e| u.reporting.contains(&e.key.link) && e.state != "minimized" && !self.parked_key(&f, &e.key));
        let live_bound: BTreeSet<i64> = self
            .bindings
            .iter()
            .filter(|(k, b)| !u.parked.contains(&b.number) && (!u.reporting.contains(&k.link) || reported.contains(*k)))
            .map(|(_, b)| b.number)
            .collect();
        let fresh = big.iter().any(|n| !self.seen.contains_key(n));
        let lost_all = big.is_empty()
            || (!self.reliable_big.is_empty() && self.reliable_big.is_disjoint(&big))
            || (!live_bound.is_empty() && live_bound.iter().all(|n| !f.present.contains_key(n)));
        let mut collapsed = !u.pids.is_empty() && ext_has && (!u.listed || (lost_all && !fresh));
        if collapsed {
            if let Some(since) = self.collapsed_since {
                if now - since >= t.absent {
                    if self.last_read_collapsed {
                        let line = format!(
                            "{}: the window server's list has been without the browser's windows for {} s: taken as it is",
                            self.browser, t.absent as i64
                        );
                        self.note(line);
                    }
                    collapsed = false;
                }
            } else {
                self.collapsed_since = Some(now);
                let theirs = u.server.iter().filter(|w| u.pids.contains(&w.pid)).count();
                let each: Vec<String> = bound_before
                    .iter()
                    .map(|n| match u.server.iter().find(|w| w.number == *n) {
                        None => format!("window {n} not listed"),
                        Some(w) => format!(
                            "window {n} at layer {}, alpha {:.2}, {} screen",
                            w.layer,
                            w.alpha,
                            if w.on_screen { "on" } else { "off" }
                        ),
                    })
                    .collect();
                let was = self
                    .last_mine_count
                    .map(|c| format!("; the last read that told something had {c} at layer 0"))
                    .unwrap_or_default();
                let source = if !u.listed {
                    "nil"
                } else if u.server.is_empty() {
                    "an empty list"
                } else {
                    "a list"
                };
                let line = format!(
                    "{}: {} ({} entries, {} the browser's, {} at layer 0{}): bindings kept, nothing learned from it{}; the source gave {}",
                    self.browser,
                    if u.listed {
                        "a read of the window server without the browser's windows"
                    } else {
                        "the window server gave no list"
                    },
                    u.server.len(),
                    theirs,
                    mine.len(),
                    if each.is_empty() { String::new() } else { format!("; {}", each.join(", ")) },
                    was,
                    source
                );
                self.note(line);
            }
            self.collapsed_reads += 1;
        } else {
            // The end of an episode of reads that told nothing: how long it lasted, one line.
            if let Some(since) = self.collapsed_since {
                let n = self.collapsed_reads;
                let line = format!(
                    "{}: the window server's list has the browser's windows again after {} ms ({} read{} told nothing)",
                    self.browser,
                    ((now - since) * 1000.0).round() as i64,
                    n,
                    if n == 1 { "" } else { "s" }
                );
                self.note(line);
            }
            self.collapsed_since = None;
            self.collapsed_reads = 0;
        }
        self.last_read_collapsed = collapsed;
        if !collapsed {
            self.reads += 1;
            self.last_mine_count = Some(mine.len());
        }
        // Since when something may have changed: the last read that told something.
        let after = if first { now } else { self.last_reliable };
        // A window listed before and missing now: since when. Back, it's the same window (its number is the
        // window's for the login session); missing `absent`, it's gone. (Not a parked window.)
        self.unlisted.retain(|n, _| !u.parked.contains(n));
        let listed_before: BTreeSet<i64> =
            self.seen.keys().chain(self.retired.iter()).chain(bound_before.iter()).copied().collect();
        for n in listed_before {
            if !f.present.contains_key(&n) && !self.unlisted.contains_key(&n) && !u.parked.contains(&n) {
                self.unlisted.insert(n, now);
            }
        }
        let back: Vec<i64> = f.present.keys().copied().filter(|n| self.unlisted.contains_key(n)).collect();
        for n in back {
            // A bound window the log said was missing: when it's back (a blip), one line.
            if self.absent_said.contains(&n) {
                let since = self.unlisted.get(&n).copied();
                let key = self.bindings.iter().find(|(_, b)| b.number == n).map(|(k, _)| k.clone());
                if let (Some(since), Some(key)) = (since, key) {
                    self.note(format!("{key}: window {n} back after {} ms", ((now - since) * 1000.0).round() as i64));
                }
            }
            self.unlisted.remove(&n);
            self.absent_said.remove(&n);
        }
        if !collapsed {
            // A parked window is kept as seen however long it's missing: shown again it's the same window, never a
            // new one. One never listed is taken as there before.
            for w in &mine {
                self.seen.entry(w.number).or_insert(Seen { at: now, after, before: first });
            }
            for n in &u.parked {
                self.seen.entry(*n).or_insert(Seen { at: now, after, before: true });
            }
            let (present, unlisted, parked) = (&f.present, &self.unlisted, &u.parked);
            let keep = |n: i64| {
                present.contains_key(&n) || unlisted.get(&n).is_some_and(|s| now - s < t.absent) || parked.contains(&n)
            };
            self.seen.retain(|n, _| keep(*n));
            self.retired.retain(|n| keep(*n));
            for w in &mine {
                if self.server_moved.get(&w.number).map(|m| m.0) != Some(w.bounds) {
                    self.server_moved.insert(w.number, (w.bounds, now));
                }
            }
            self.server_moved.retain(|n, _| keep(*n));
            for (n, m) in &self.server_moved {
                if now - m.1.max(u.space_changed_at) >= t.moved {
                    self.settled_bounds.insert(*n, m.0);
                }
            }
            self.settled_bounds.retain(|n, _| keep(*n));
        }

        let now_front = if u.browser_in_front {
            f.candidates.iter().filter(|w| w.on_screen).min_by_key(|w| w.order).map(|w| w.number)
        } else {
            None
        };
        if collapsed {
            // Nothing learned.
        } else if first {
            // In front since before the first read: when isn't known, so taken as now (settled focus waits `quiet`).
            self.front = now_front;
            self.front_since = Some(now);
            // A change at some time before, which no focus can be told against.
            if now_front.is_some() {
                self.changes.push(Change { at: now, after: now - t.history, number: now_front, timed: true });
            }
        } else if now_front != self.front {
            if now_front.is_none() && self.front.is_some_and(|fr| self.missing(&f, fr)) {
                // The front window missing from this read and nothing else in front: not a change until it's back
                // (none) or gone (a change some time since it was last listed).
                if self.front_missing_after.is_none() {
                    self.front_missing_after = Some(after);
                }
            } else {
                let since = self.front_missing_after.unwrap_or(after);
                let unseen = self.front_missing_after.is_some() || self.last_reliable < self.last_read;
                self.changes.push(Change {
                    at: now,
                    after: since,
                    number: now_front,
                    timed: !unseen || now - since <= t.blind,
                });
                self.front = now_front;
                self.front_since = Some(now);
                self.front_missing_after = None;
                let noted = format!(
                    "{} at {}",
                    now_front.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    self.clock(now)
                );
                self.front_noted.push(noted);
            }
        } else {
            self.front_missing_after = None;
        }
        if !collapsed {
            // The browser's windows on screen (one missing from this read as it was). One come on screen: a
            // transition from when it may have begun; a Space change heard since then may have come after it: the
            // same transition, from the earlier of the two (a real session's log, 2026-11-05 21:53:03). Only gone off screen:
            // the end of the last change if it's that near (a slide), else a transition of its own.
            let mut on_now: BTreeSet<i64> = f.candidates.iter().filter(|w| w.on_screen).map(|w| w.number).collect();
            for n in &self.last_on_screen {
                if !f.present.contains_key(n) && self.missing(&f, *n) {
                    on_now.insert(*n);
                }
            }
            if !first {
                let gone: BTreeSet<i64> = self.last_on_screen.difference(&on_now).copied().collect();
                let came = on_now.difference(&self.last_on_screen).next().is_some();
                let went = !gone.is_empty();
                if came || went {
                    let joins = self
                        .transitions
                        .last()
                        .is_some_and(|tr| if came { after <= tr.latest } else { after <= tr.latest + t.visible_lag });
                    if let (true, Some(tr)) = (joins, self.transitions.last_mut()) {
                        tr.front = true;
                        if came {
                            tr.at = tr.at.min(after);
                        }
                        tr.latest = tr.latest.max(now);
                        tr.went.extend(gone);
                    } else {
                        self.transitions.push(Transition {
                            at: after,
                            latest: now,
                            space: false,
                            front: true,
                            went: gone,
                        });
                        self.keep_last_transitions();
                    }
                }
            }
            for n in &on_now {
                self.on_screen_since.entry(*n).or_insert(if first { f64::NEG_INFINITY } else { after });
            }
            self.on_screen_since.retain(|n, _| on_now.contains(n));
            for n in on_now.union(&self.last_on_screen) {
                self.last_on.insert(*n, now);
            }
            let keep: BTreeSet<i64> =
                self.last_on.keys().copied().filter(|n| f.present.contains_key(n) || self.missing(&f, *n)).collect();
            self.last_on.retain(|n, _| keep.contains(n));
            self.last_on_screen = on_now;
        }

        // ---- the extension's side ----
        for e in &u.ext {
            if u.reporting.contains(&e.key.link) {
                f.by_key.insert(e.key.clone(), e.clone());
            }
        }
        let by_key_list: Vec<ExtWindow> = f.by_key.values().cloned().collect();
        for e in &by_key_list {
            if let Some(b) = e.bounds {
                if self.ext_moved.get(&e.key).map(|m| m.0) != Some(b) {
                    self.ext_moved.insert(e.key.clone(), (b, now));
                }
            }
            if let Some(at) = e.focused_at {
                if self.focus_heard.get(&e.key) != Some(&at) {
                    self.focus_heard.insert(e.key.clone(), at);
                    let other = by_key_list.iter().any(|o| o.key.link == e.key.link && o.key != e.key && o.focused);
                    self.focus_events.push(Event { key: e.key.clone(), at, contradicted: other, decided: false });
                }
            }
            if let Some(at) = e.created_at {
                if self.create_heard.get(&e.key) != Some(&at) {
                    self.create_heard.insert(e.key.clone(), at);
                    self.create_events.push(Event { key: e.key.clone(), at, contradicted: false, decided: false });
                }
            }
        }
        self.ext_moved.retain(|k, _| !f.gone(k));
        self.focus_heard.retain(|k, _| !f.gone(k));
        self.create_heard.retain(|k, _| !f.gone(k));
        self.changes.retain(|c| c.at >= now - t.history);
        self.focus_events.retain(|e| e.at >= now - t.history);
        self.create_events.retain(|e| e.at >= now - t.history);

        // ---- bindings that no longer hold ----
        // (The extension's own word holds on any read: a window closed, a copy gone or new.)
        for (link, copy) in &u.copies {
            if !u.reporting.contains(link) {
                continue;
            }
            if self.copy_of.get(link).is_some_and(|before| before != copy) {
                let keys: Vec<WindowKey> = self.bindings.keys().filter(|k| k.link == *link).cloned().collect();
                for key in keys {
                    self.drop_binding(
                        &key,
                        "a new copy of Margin started in its profile (its window ids may be new)".into(),
                    );
                }
            }
            self.copy_of.insert(link.clone(), copy.clone());
        }
        let snapshot: Vec<(WindowKey, Binding)> = self.bindings.iter().map(|(k, b)| (k.clone(), b.clone())).collect();
        for (key, b) in snapshot {
            let n = b.number;
            // Bound from its answer's bounds, its copy's list not caught up yet: not closed.
            if f.gone(&key) && self.awaiting_list.get(&key).is_some_and(|until| now < *until) {
                continue;
            }
            let linked = u.reporting.contains(&key.link) || u.held.contains(&key.link);
            if u.parked.contains(&n) {
                // Parked: only the copy's word, the browser gone, or a new copy (above) drops it.
                let mut kept: Option<&str> = None;
                if u.pids.is_empty() {
                    self.drop_binding(&key, format!("window {n}, parked, is gone (the browser isn't running)"));
                } else if !linked {
                    kept = Some("its copy isn't linked");
                } else if f.gone(&key) {
                    self.retired.insert(n);
                    self.drop_binding(&key, format!("closed in the browser (window {n} was parked)"));
                } else if !f.present.contains_key(&n) {
                    kept = Some("not listed by the window server");
                } else if f.present.get(&n).is_some_and(|w| !w.on_screen) {
                    kept = Some("off screen");
                }
                if let Some(kept) = kept {
                    if self.parked_kept.get(&key).map(String::as_str) != Some(kept) {
                        self.parked_kept.insert(key.clone(), kept.to_string());
                        self.note(format!("{key}: window {n} kept while parked: {kept}"));
                    }
                } else {
                    self.parked_kept.remove(&key);
                }
                continue;
            }
            if !linked {
                self.drop_binding(&key, "its copy isn't linked".into());
            } else if f.gone(&key) {
                self.retired.insert(n);
                self.drop_binding(&key, "closed in the browser".into());
            } else if !f.present.contains_key(&n) {
                if u.pids.is_empty() {
                    self.drop_binding(
                        &key,
                        format!("window {n} is gone from the window server (the browser isn't running)"),
                    );
                } else if !collapsed && !self.missing(&f, n) {
                    self.drop_binding(
                        &key,
                        format!("window {n} is gone from the window server (not listed for {} s)", t.absent as i64),
                    );
                } else if !self.absent_said.contains(&n) {
                    self.absent_said.insert(n);
                    self.note(format!("{key}: window {n} missing from one read (kept for {} s)", t.absent as i64));
                }
            }
        }
        let bindings = &self.bindings;
        self.awaiting_list.retain(|k, _| !(f.by_key.contains_key(k) || !bindings.contains_key(k)));
        self.parked_kept.retain(|k, _| bindings.get(k).is_some_and(|b| u.parked.contains(&b.number)));
        self.conflicts.retain(|k, c| f.by_key.contains_key(k) && now - c.1 < t.conflict);
        if !collapsed {
            self.unlisted.retain(|_, since| now - *since < t.absent);
            let unlisted = &self.unlisted;
            self.absent_said.retain(|n| unlisted.contains_key(n));
        }

        // ---- parked windows the registry knows again (expectParked) ----
        // Its own record, not the window server's read: so on any read, after the drops above.
        let mut expecting = Vec::new();
        for mut p in std::mem::take(&mut self.parked_expects) {
            let until = p.until.unwrap_or(now + t.created);
            p.until = Some(until);
            let line = format!("{}: parked window {} ({})", p.key, p.number, p.why);
            let holder = self.holder_of(p.number, &p.key);
            if self.bindings.get(&p.key).is_some_and(|b| b.number == p.number) {
                continue;
            } else if u.pids.is_empty() {
                self.note(format!("{line} not bound: the browser isn't running"));
            } else if self.retired.contains(&p.number) {
                self.note(format!("{line} not bound: it's a closed window's"));
            } else if let Some(b) = self.bindings.get(&p.key) {
                let n = b.number;
                self.note(format!("{line} not bound: it's window {n}"));
            } else if u.reporting.contains(&p.key.link) && !f.by_key.contains_key(&p.key) {
                self.note(format!("{line} not bound: its copy doesn't list it"));
            } else if !f.by_key.contains_key(&p.key) || holder.is_some() {
                if now >= until {
                    let why = holder
                        .map(|h| format!("window {} is {h}'s", p.number))
                        .unwrap_or_else(|| "its copy hasn't reported".into());
                    self.note(format!("{line} not bound in {} s: {why}", t.created as i64));
                } else {
                    expecting.push(p);
                }
            } else {
                self.bind(&p.key, p.number, now, format!("parked: {}", p.why), None);
            }
        }
        self.parked_expects = expecting;
        let bindings = &self.bindings;
        self.parked_kept.retain(|k, _| bindings.get(k).is_some_and(|b| u.parked.contains(&b.number)));

        // (A parked window missing isn't a blip kept for `absent`: it isn't counted here.)
        self.set_absent_numbers(&f);
        if collapsed {
            self.steady_since = None;
            self.steady_reads = 0;
            return self.numbers();
        }
        // A browser-sized window the last read listed is missing: no binding by elimination this read (unless a new
        // one came with it: a window replaced, a real change).
        let lost_some = self.reliable_big.difference(&big).next().is_some() && !fresh;
        if fresh {
            self.fresh_at = now;
        }
        self.reliable_big = big;
        self.last_reliable = now;
        // Reads that told something and missed nothing, in a row: steady, over `visible_hold`.
        if !lost_some && !self.unsteady_missing(&f) {
            if self.steady_since.is_none() {
                self.steady_since = Some(now);
                self.steady_reads = 0;
            }
            self.steady_reads += 1;
        } else {
            self.steady_since = None;
            self.steady_reads = 0;
        }
        let steady = self.steady_reads >= 2 && now - self.steady_since.unwrap_or(now) >= t.visible_hold;

        self.rule_moved(&f);
        self.rule_exact(&f, &u.exact);
        self.rule_made(&f);
        self.rule_created(&f);
        self.rule_focus(&f);

        // What the pages say (the visible rule, below), as of now: only a word said after the last Space change or
        // new front window (and `visible_lag` after the one before: a page's word may come that late), or, with
        // none since Margin.app started, any word.
        let last_change = self.transitions.last().cloned();
        f.threshold = last_change
            .as_ref()
            .map(|c| {
                let before = self.transitions.iter().rev().nth(1).map(|p| p.latest + t.visible_lag);
                c.at.max(before.unwrap_or(f64::NEG_INFINITY))
            })
            .unwrap_or(f64::NEG_INFINITY);
        f.settled_pages = last_change.as_ref().is_none_or(|c| now - c.latest >= t.visible_lag);

        // ---- the only free window with its bounds ----
        // (Not on a read that lost a window the last one listed. Full-screen bounds, which every profile's
        // full-screen window on a display shares: only while every window with them is a reported one, no link is
        // held and no copy has stopped reporting in the last `away`. Otherwise at once, as ever.)
        let copies_away = !u.held.is_empty() || self.links_seen.keys().any(|l| !u.reporting.contains(l));
        self.eliminate(&f, lost_some, copies_away);

        self.rule_visible_at_once(&f, lost_some);
        self.rule_visible(&f, steady, last_change.as_ref());
        self.rule_hidden(&f, steady, u.space_changed_at);
        self.rule_settled(&f);
        self.eliminate(&f, lost_some, copies_away);

        // ---- what can't be told yet ----
        // (Not said while a window is missing: it's said, if it still holds, when the list is whole again.)
        if !lost_some && !self.unsteady_missing(&f) {
            let server = self.free_server(&f);
            for e in self.free_ext(&f) {
                let mut windows: Vec<i64> = server.iter().filter(|w| fits(&e, w)).map(|w| w.number).collect();
                windows.sort_unstable();
                let reason = match windows.len() {
                    0 => "no free window of the browser has its bounds".to_string(),
                    1 => {
                        format!("window {} has its bounds, but so does another of the extension's windows", windows[0])
                    }
                    c => format!(
                        "{c} windows have its bounds ({}): waiting for a focus change or a creation to tell them apart",
                        windows.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")
                    ),
                };
                if self.waiting_said.get(&e.key) != Some(&reason) {
                    self.waiting_said.insert(e.key.clone(), reason.clone());
                    let b = e.bounds.map(|b| b.describe()).unwrap_or_default();
                    self.note(format!("{} ({}, {b}) isn't bound: {reason}; nothing drawn over it", e.key, e.state));
                }
            }
        }
        let bindings = &self.bindings;
        self.waiting_said.retain(|k, _| f.by_key.contains_key(k) && !bindings.contains_key(k));
        self.set_absent_numbers(&f);
        self.numbers()
    }

    fn keep_last_transitions(&mut self) {
        let n = self.transitions.len();
        if n > 4 {
            self.transitions.drain(..n - 4);
        }
    }

    fn set_absent_numbers(&mut self, f: &Frame) {
        self.absent_numbers = self
            .bindings
            .values()
            .map(|b| b.number)
            .filter(|n| !f.present.contains_key(n) && !f.parked.contains(n))
            .collect();
    }

    // ---- moved: a bound window whose bounds match one other free window alone, steadily ----
    // Only when the extension's window itself moved since it was bound (a window offset by the window server alone
    // is in a swipe, Mission Control or full screen's animation), its own window has settled elsewhere, the other
    // has kept those bounds all along, and every window with them is a reported one.
    fn rule_moved(&mut self, f: &Frame) {
        let t = &f.t;
        let now = f.now;
        let snapshot: Vec<(WindowKey, Binding)> = self.bindings.iter().map(|(k, b)| (k.clone(), b.clone())).collect();
        for (key, b) in snapshot {
            let e = f.by_key.get(&key);
            let (Some(e), Some(own)) = (e, f.present.get(&b.number)) else {
                self.drift.remove(&key);
                continue;
            };
            let Some(eb) = e.bounds else {
                self.drift.remove(&key);
                continue;
            };
            if f.parked.contains(&b.number) || e.state == "minimized" {
                self.drift.remove(&key);
                continue;
            }
            if close(&eb, &own.bounds) {
                self.drift.remove(&key);
                continue;
            }
            let others: Vec<ServerWindow> = self
                .free_server(f)
                .into_iter()
                .filter(|w| self.profile_allows(&key, w.number) && close(&eb, &w.bounds))
                .collect();
            let moved_at = self.ext_moved.get(&key).map(|m| m.1);
            if others.len() != 1
                || self.missing_free(f, &eb) != 0
                || !self.free_ext(f).iter().all(|x| !fits(x, &others[0]))
                || moved_at.unwrap_or(f64::NEG_INFINITY) <= b.at
            {
                self.drift.remove(&key);
                continue;
            }
            let other = &others[0];
            match self.drift.get(&key) {
                Some(d) if d.0 == other.number => {}
                _ => {
                    self.drift.insert(key.clone(), (other.number, now));
                    continue;
                }
            }
            let since = self.drift.get(&key).map(|d| d.1).unwrap_or(now);
            let still = now - moved_at.unwrap_or(now) >= t.moved
                && now - self.server_moved.get(&other.number).map(|m| m.1).unwrap_or(now) >= t.moved;
            if !(now - since >= t.moved && still) {
                continue;
            }
            let own_settled = self.settled_bounds.get(&b.number).is_some_and(|s| !close(s, &eb));
            let other_kept = self.settled_bounds.get(&other.number).is_some_and(|s| close(s, &eb));
            if !(own_settled && other_kept && self.server_having(f, &eb) == self.ext_fitting(f, &eb).len()) {
                continue;
            }
            self.drift.remove(&key);
            self.bindings.remove(&key);
            let why = format!(
                "its bounds ({}) have matched window {} alone for {} s, not window {}'s ({})",
                eb.describe(),
                other.number,
                t.moved as i64,
                b.number,
                own.bounds.describe()
            );
            self.bind(&key, other.number, now, why, Some(b.number));
        }
    }

    // ---- exact: Accessibility names each window's profile (Mac only: Safari's titles) ----
    // A binding to another profile's key is wrong and goes; a window is bound to its profile's one free window
    // there (or the one free window of its profile with its bounds, when the profile has several).
    fn rule_exact(&mut self, f: &Frame, exact: &BTreeMap<i64, String>) {
        if exact.is_empty() {
            return;
        }
        let now = f.now;
        for (number, link) in exact {
            if f.parked.contains(number) || !f.present.contains_key(number) {
                continue;
            }
            let held = self.bindings.iter().find(|(_, b)| b.number == *number).map(|(k, _)| k.clone());
            if let Some(key) = held.filter(|k| k.link != *link) {
                self.drop_binding(&key, format!("Accessibility says window {number} is {link}'s"));
            }
        }
        for (number, link) in exact {
            if f.parked.contains(number) || self.retired.contains(number) {
                continue;
            }
            let Some(w) = f.present.get(number) else { continue };
            if self.bound().contains(number) {
                continue;
            }
            let free: Vec<ExtWindow> = f
                .by_key
                .values()
                .filter(|e| {
                    e.key.link == *link
                        && !self.bindings.contains_key(&e.key)
                        && !self.parked_key(f, &e.key)
                        && e.state != "minimized"
                })
                .cloned()
                .collect();
            // The profile's windows the window server lists and no binding has: one, and one of its copy's free.
            let bound = self.bound();
            let unbound = exact
                .iter()
                .filter(|(n, l)| *l == link && f.present.contains_key(n) && !f.parked.contains(n) && !bound.contains(n))
                .count();
            // A profile title is not an extension-window identity: an older
            // normal report can precede a newly created full-screen window.
            if free.len() == 1 && unbound == 1 && free[0].bounds.is_some_and(|b| self.has(f, *number, &b)) {
                let why = format!("Accessibility: its title names {link}, the profile's one window");
                self.bind(&free[0].key, *number, now, why, None);
            } else if free.len() > 1 {
                let fitting: Vec<&ExtWindow> = free
                    .iter()
                    .filter(|e| {
                        e.bounds.is_some_and(|b| close(&b, &w.bounds))
                            || e.bounds.is_some_and(|b| self.has(f, *number, &b))
                    })
                    .collect();
                let same_size = exact
                    .iter()
                    .filter(|(n, l)| {
                        *l == link
                            && !bound.contains(n)
                            && f.present.get(n).is_some_and(|p| close(&p.bounds, &w.bounds))
                    })
                    .count();
                if fitting.len() == 1 && same_size == 1 {
                    let key = fitting[0].key.clone();
                    let why =
                        format!("Accessibility: its title names {link}, the one of its windows with these bounds");
                    self.bind(&key, *number, now, why, None);
                }
            }
        }
    }

    // ---- made by Margin's own request ----
    fn rule_made(&mut self, f: &Frame) {
        let t = &f.t;
        let now = f.now;
        for m in self.made.clone() {
            if self.bindings.contains_key(&m.key) {
                continue;
            }
            // Its copy's list may lag the answer: the bounds the answer gave stand in until it lists it.
            let e = f.by_key.get(&m.key);
            if e.is_none() && !(m.bounds.is_some() && f.reporting.contains(&m.key.link)) {
                continue;
            }
            let new: Vec<ServerWindow> = self
                .free_server(f)
                .into_iter()
                .filter(|w| self.seen.get(&w.number).is_some_and(|s| !s.before && s.at >= m.since - t.slack))
                .collect();
            let rivals =
                self.made.iter().any(|o| o.key != m.key && !self.bindings.contains_key(&o.key) && now < o.until);
            let fits_made = |r: Option<Rect>, w: &ServerWindow| r.is_some_and(|r| close(&r, &w.bounds));
            let e_bounds = e.and_then(|e| e.bounds);
            if new.len() != 1 || rivals || !(fits_made(e_bounds, &new[0]) || fits_made(m.bounds, &new[0])) {
                continue;
            }
            let w = &new[0];
            let by = if fits_made(e_bounds, w) {
                String::new()
            } else {
                format!(
                    " (by the bounds its answer gave, {}{})",
                    m.bounds.map(|b| b.describe()).unwrap_or_default(),
                    if e.is_none() { ", before its copy listed it" } else { "" }
                )
            };
            let first_listed = self.seen.get(&w.number).map(|s| s.at).unwrap_or(now);
            let why = format!(
                "{} at {}, and window {}, first listed at {}, is the only new window since{by}",
                m.why,
                self.clock(m.since),
                w.number,
                self.clock(first_listed)
            );
            let listed = e.is_some();
            self.bind(&m.key, w.number, now, why, None);
            if !listed {
                self.awaiting_list.insert(m.key.clone(), m.answered + t.alone + t.report_lag);
            }
        }
        for m in self.made.clone() {
            if !self.bindings.contains_key(&m.key) && now >= m.until {
                self.note(format!(
                    "{}: {}, but no one new window with its bounds came in {} s: left to the other rules",
                    m.key, m.why, t.created as i64
                ));
            }
        }
        let bindings = &self.bindings;
        self.made.retain(|m| {
            !(bindings.contains_key(&m.key)
                || now >= m.until
                || (f.gone(&m.key) && now > m.since + t.alone + t.report_lag))
        });
    }

    // ---- created together ----
    fn rule_created(&mut self, f: &Frame) {
        let t = &f.t;
        let now = f.now;
        for i in 0..self.create_events.len() {
            let ev = self.create_events[i].clone();
            if ev.decided || now < ev.at + t.alone + t.report_lag {
                continue;
            }
            self.create_events[i].decided = true;
            if self.bindings.contains_key(&ev.key) || !f.by_key.contains_key(&ev.key) || self.parked_key(f, &ev.key) {
                continue;
            }
            let bound = self.bound();
            let new: Vec<(i64, Seen)> = self
                .seen
                .iter()
                .filter(|&(n, s)| {
                    !s.before
                        && s.at - s.after <= t.max_gap
                        && !bound.contains(n)
                        && !self.retired.contains(n)
                        && !f.parked.contains(n)
                })
                .map(|(n, s)| (*n, *s))
                .collect();
            let near: Vec<&(i64, Seen)> =
                new.iter().filter(|(_, s)| ev.at >= s.after - t.alone && ev.at <= s.at + t.alone).collect();
            let at: Vec<&&(i64, Seen)> =
                near.iter().filter(|(_, s)| ev.at >= s.after - t.slack && ev.at <= s.at + t.slack).collect();
            let others =
                self.create_events.iter().filter(|o| o.key != ev.key && (o.at - ev.at).abs() <= t.alone).count();
            if near.len() != 1 || at.len() != 1 || others != 0 {
                if !near.is_empty() || others != 0 {
                    self.note(format!(
                        "{}: created at {} with {} new window(s) and {} other new browser window(s) about then: not told apart that way",
                        ev.key,
                        self.clock(ev.at),
                        near.len(),
                        others
                    ));
                }
                continue;
            }
            let &(number, s) = *at[0];
            let why = format!(
                "created together: its copy heard it created at {}, and window {number} was first listed by {}, each alone then",
                self.clock(ev.at),
                self.clock(s.at)
            );
            self.pending.push(Pending { key: ev.key.clone(), number, until: now + t.created, why });
        }
        for p in self.pending.clone() {
            if self.bindings.contains_key(&p.key)
                || self.bound().contains(&p.number)
                || self.retired.contains(&p.number)
            {
                continue;
            }
            let (Some(e), Some(w)) = (f.by_key.get(&p.key), f.present.get(&p.number)) else { continue };
            if f.candidates.iter().any(|c| c.number == p.number) && fits(e, w) {
                self.bind(&p.key, p.number, now, p.why.clone(), None);
            } else if now >= p.until {
                let eb = e.bounds.map(|b| b.describe()).unwrap_or_else(|| "none".into());
                self.note(format!(
                    "{}: created with window {}, but their bounds never agreed ({eb} and {}): not bound",
                    p.key,
                    p.number,
                    w.bounds.describe()
                ));
            }
        }
        let bound = self.bound();
        let pending = std::mem::take(&mut self.pending);
        let kept: Vec<Pending> = pending
            .into_iter()
            .filter(|p| {
                !(self.bindings.contains_key(&p.key)
                    || bound.contains(&p.number)
                    || !f.by_key.contains_key(&p.key)
                    || (!f.present.contains_key(&p.number) && !self.missing(f, p.number))
                    || self.retired.contains(&p.number)
                    || f.parked.contains(&p.number)
                    || now >= p.until)
            })
            .collect();
        self.pending = kept;
    }

    // ---- focus moved ----
    fn rule_focus(&mut self, f: &Frame) {
        let t = &f.t;
        let now = f.now;
        // The front changes it's weighed against, less blips: no front window for under `front_blip` between two
        // with one, and the change back to the window that was in front before it.
        let ch = &self.changes;
        let blip =
            |j: usize| j > 0 && j + 1 < ch.len() && ch[j].number.is_none() && ch[j + 1].at - ch[j].at < t.front_blip;
        let mut steady_changes: Vec<Change> = Vec::new();
        for (i, c) in ch.iter().enumerate() {
            if blip(i) {
                continue;
            }
            if i >= 2 && blip(i - 1) && c.number == ch[i - 2].number {
                continue;
            }
            steady_changes.push(*c);
        }
        let fronts = |list: &[&Change]| {
            list.iter()
                .map(|c| c.number.map(|n| n.to_string()).unwrap_or_else(|| "none".into()))
                .collect::<Vec<_>>()
                .join(", ")
        };
        for i in 0..self.focus_events.len() {
            let ev = self.focus_events[i].clone();
            if ev.decided || now < ev.at + t.alone + t.report_lag {
                continue;
            }
            self.focus_events[i].decided = true;
            let heard = format!("{}: focus heard at {} not used", ev.key, self.clock(ev.at));
            let e = match f.by_key.get(&ev.key) {
                Some(e) if e.state != "minimized" => e,
                other => {
                    let why = if other.is_none() { "its copy no longer reports it" } else { "it's minimized" };
                    self.note(format!("{heard}: {why}"));
                    continue;
                }
            };
            // A parked window focused stays parked and unseen: its focus says nothing of which window is in front.
            if self.parked_key(f, &ev.key) {
                self.note(format!("{heard}: its window is parked"));
                continue;
            }
            if ev.contradicted {
                self.note(format!(
                    "{heard}: contradicted (its copy called another of its windows focused in that report)"
                ));
                continue;
            }
            let near: Vec<&Change> =
                steady_changes.iter().filter(|c| ev.at >= c.after - t.alone && ev.at <= c.at + t.alone).collect();
            let at: Vec<&Change> = steady_changes
                .iter()
                .filter(|c| c.timed && c.at - c.after <= t.max_gap)
                .filter(|c| c.number.is_some() && ev.at >= c.after - t.slack && ev.at <= c.at + t.slack)
                .collect();
            let mut others: Vec<String> = self
                .focus_events
                .iter()
                .filter(|o| o.key != ev.key && (o.at - ev.at).abs() <= t.alone)
                .map(|o| o.key.to_string())
                .collect();
            if !others.is_empty() {
                others.sort();
                self.note(format!(
                    "{heard}: others ({} other focus change(s) heard within {} s: {})",
                    others.len(),
                    t.alone as i64,
                    others.join(", ")
                ));
                continue;
            }
            if near.len() != 1 {
                self.note(format!(
                    "{heard}: near count {} (front changes within {} s: {})",
                    near.len(),
                    t.alone as i64,
                    fronts(&near)
                ));
                continue;
            }
            let (1, Some(number)) = (at.len(), at.first().and_then(|c| c.number)) else {
                self.note(format!(
                    "{heard}: at count {} (no one timed front change to a window within {} s; near: {})",
                    at.len(),
                    swift_double(t.slack),
                    fronts(&near)
                ));
                continue;
            };
            let change = *at[0];
            if self.retired.contains(&number) {
                self.note(format!("{heard}: window {number}, in front then, was a closed window's"));
                continue;
            }
            // Its window missing from this read: weighed again when it's back (or gone).
            let Some(w) = f.present.get(&number) else {
                if self.missing(f, number) {
                    self.focus_events[i].decided = false;
                }
                continue;
            };
            if !self.profile_allows(&ev.key, number) {
                continue;
            }
            // (Its bounds, or the ones it settled in: a window offset for a moment, in a Space's slide, still has
            // its own. A real session's log, 2026-11-06 21:25:22.)
            if !(fits(e, w) || e.bounds.is_some_and(|b| self.has(f, number, &b))) {
                let eb = e.bounds.map(|b| b.describe()).unwrap_or_else(|| "no bounds".into());
                self.note(format!("{heard}: doesn't fit window {number} ({eb} and {})", w.bounds.describe()));
                continue;
            }
            let why = format!(
                "focus moved to it at {} and window {number} came to the front by {}, each alone then",
                self.clock(ev.at),
                self.clock(change.at)
            );
            let holder = self.holder_of(number, &ev.key);
            let mine = self.bindings.get(&ev.key).map(|b| b.number);
            if mine == Some(number) {
                self.conflicts.remove(&ev.key);
                self.note(format!(
                    "{}: focus heard at {} agrees with its binding (window {number} came to the front by {})",
                    ev.key,
                    self.clock(ev.at),
                    self.clock(change.at)
                ));
            } else if mine.is_none() && holder.is_none() {
                self.bind(&ev.key, number, now, why, None);
            } else if let Some(c) =
                self.conflicts.get(&ev.key).copied().filter(|c| c.0 == number && ev.at - c.1 > t.alone)
            {
                self.conflicts.remove(&ev.key);
                if let Some(holder) = &holder {
                    self.drop_binding(holder, format!("two focus changes say window {number} is {}'s", ev.key));
                }
                self.bindings.remove(&ev.key);
                let why =
                    format!("two focus changes said so ({}, {}); the last: {why}", self.clock(c.1), self.clock(ev.at));
                self.bind(&ev.key, number, now, why, mine);
            } else {
                self.conflicts.insert(ev.key.clone(), (number, ev.at));
                let mine = mine.map(|n| format!("it is window {n}")).unwrap_or_else(|| "it isn't bound".into());
                let theirs = holder.map(|h| format!(" and window {number} is {h}'s")).unwrap_or_default();
                self.note(format!(
                    "{}: {why}, but {mine}{theirs}: kept (a second focus change saying so would move it)",
                    ev.key
                ));
            }
        }
    }

    fn eliminate(&mut self, f: &Frame, lost_some: bool, copies_away: bool) {
        if lost_some {
            return;
        }
        let mut changed = true;
        while changed {
            changed = false;
            let server = self.free_server(f);
            let free = self.free_ext(f);
            for e in &free {
                let Some(eb) = e.bounds else { continue };
                let windows: Vec<&ServerWindow> = server
                    .iter()
                    .filter(|w| self.profile_allows(&e.key, w.number) && self.has(f, w.number, &eb))
                    .collect();
                if windows.len() != 1 {
                    continue;
                }
                let w = windows[0];
                if !fits(e, w)
                    || free.iter().filter(|x| fits(x, w)).count() != 1
                    || self.missing_free(f, &eb) != 0
                    || self.pages_deny(f, e, w)
                {
                    continue;
                }
                let group = self.ext_fitting(f, &w.bounds);
                if group.iter().any(|g| g.state == "fullscreen")
                    && (copies_away || self.server_having(f, &w.bounds) != group.len())
                {
                    continue;
                }
                let others = self
                    .bindings
                    .values()
                    .filter(|b| {
                        !f.parked.contains(&b.number)
                            && f.present.get(&b.number).is_some_and(|p| close(&p.bounds, &w.bounds))
                    })
                    .count();
                let also =
                    if others > 0 { format!("; {others} other(s) with them already bound") } else { String::new() };
                let why = format!("the only free window with its bounds ({}){also}", w.bounds.describe());
                if self.bind(&e.key, w.number, f.now, why, None) {
                    changed = true;
                    break;
                }
            }
        }
    }

    // ---- visible at once: a window come on screen, and the one page that newly says it's shown ----
    // (a real session's log, 2026-11-06 23:30:19-29: macOS says the Space changed only once a slide is over, and a page says
    // it's shown as its window starts sliding in.) A page is said shown only while its window is on screen. So a
    // free window `w` on screen is bound to the free page with its bounds that said it's shown since `w` came on
    // screen (`visible_fresh` before the read before it was seen there), when: that page is the only free one saying
    // it's shown, every other free page with those bounds said it's hidden, no other free window with them has been
    // on screen within `visible_lag` before that page's word, `w` is the only free window on screen with them, every
    // window with them is a reported one, no link is held, the read misses nothing, and no bound window's page says
    // it's shown while its window isn't on screen. A window offset in a slide is weighed by the bounds it settled
    // in. Only a window seen coming on screen: one on screen since before the first read is left to the rule below.
    fn rule_visible_at_once(&mut self, f: &Frame, lost_some: bool) {
        let t = &f.t;
        if !(f.held.is_empty() && !lost_some && !self.unsteady_missing(f)) || !f.in_front {
            return;
        }
        let on: Vec<ServerWindow> = self.free_server(f).into_iter().filter(|w| w.on_screen).collect();
        for w in on {
            if self.bound().contains(&w.number) {
                continue;
            }
            let Some(&since) = self.on_screen_since.get(&w.number) else { continue };
            if since.is_nan() || since == f64::NEG_INFINITY {
                continue;
            }
            let r = if !self.ext_fitting(f, &w.bounds).is_empty() {
                w.bounds
            } else if let Some(s) =
                self.settled_bounds.get(&w.number).copied().filter(|s| !self.ext_fitting(f, s).is_empty())
            {
                s
            } else {
                continue;
            };
            let rivals: Vec<ServerWindow> =
                self.free_server(f).into_iter().filter(|x| x.number != w.number && self.has(f, x.number, &r)).collect();
            if rivals.iter().any(|x| x.on_screen) {
                continue;
            }
            let group = self.ext_fitting(f, &r);
            if self.server_having(f, &r) != group.len() {
                continue;
            }
            let free: Vec<&ExtWindow> = group.iter().filter(|e| !self.bindings.contains_key(&e.key)).collect();
            let fresh: Vec<&&ExtWindow> = free
                .iter()
                .filter(|e| {
                    e.visible == Some(true) && e.visible_at.unwrap_or(f64::NEG_INFINITY) >= since - t.visible_fresh
                })
                .collect();
            let (1, Some(said)) = (fresh.len(), fresh.first().and_then(|x| x.visible_at)) else { continue };
            let x = (*fresh[0]).clone();
            if !free.iter().all(|e| e.key == x.key || e.visible == Some(false)) {
                continue;
            }
            if !rivals
                .iter()
                .all(|r| self.last_on.get(&r.number).copied().unwrap_or(f64::NEG_INFINITY) < said - t.visible_lag)
            {
                continue;
            }
            let pages_settled = group.iter().all(|e| {
                e.visible != Some(true)
                    || e.key == x.key
                    || self.bindings.get(&e.key).map(|b| f.present.get(&b.number).map(|p| p.on_screen) == Some(true))
                        == Some(true)
            });
            if !pages_settled {
                continue;
            }
            let why = format!(
                "visible at once: its page alone says it's shown (since {}), window {} on screen since {} the only free one with its bounds ({}; {} window(s) with them, all reported), the other free pages hidden",
                self.clock(said),
                w.number,
                self.clock(since),
                r.describe(),
                group.len()
            );
            self.bind(&x.key, w.number, f.now, why, None);
        }
    }

    // ---- visible: the only page with its bounds that says it's shown, the only window on screen with them ----
    // Each copy knows its own windows only, and their pages say whether they're shown. Bound when, for
    // `visible_hold` over steady reads, with the browser in front and no link held: the window is the only one on
    // screen with its bounds, every window with them is a reported one, its page alone says it's shown (said as of
    // now), and every other free window's page with them says it's hidden, or has said nothing at all once
    // `visible_quiet` has passed after the last change's `visible_lag`, or at once when every window the change took
    // off screen is bound. Not in Margin.app's first `visible_lag`. With nothing said, nothing is bound.
    fn rule_visible(&mut self, f: &Frame, steady: bool, last_change: Option<&Transition>) {
        let t = &f.t;
        let now = f.now;
        let since_text = last_change
            .map(|c| format!("since {}", self.clock(c.at)))
            .unwrap_or_else(|| "since Margin.app started".into());
        let mut now_seeing: BTreeMap<i64, (WindowKey, Secs)> = BTreeMap::new();
        // The rule not weighed at all on this read: why, once per change of reason, while a window is free.
        let visible_off = if !f.in_front {
            Some("the browser isn't in front".to_string())
        } else if !f.held.is_empty() {
            Some(format!("links held ({})", f.held.iter().cloned().collect::<Vec<_>>().join(", ")))
        } else {
            None
        };
        match &visible_off {
            Some(why) if !self.free_ext(f).is_empty() => {
                if self.visible_off_said.as_ref() != Some(why) {
                    self.visible_off_said = Some(why.clone());
                    self.note(format!("{}: the visible rule not weighed: {why}", self.browser));
                }
            }
            Some(_) => {}
            None => self.visible_off_said = None,
        }
        let first_read_at = self.first_read_at.unwrap_or(now);
        if f.in_front && f.held.is_empty() && now - first_read_at >= t.visible_lag {
            let on: Vec<ServerWindow> = self.free_server(f).into_iter().filter(|w| w.on_screen).collect();
            for w in on {
                let group = self.ext_fitting(f, &w.bounds);
                if group.is_empty() {
                    continue;
                }
                let shown = f.candidates.iter().filter(|c| c.on_screen && close(&c.bounds, &w.bounds)).count();
                let visible: Vec<&ExtWindow> =
                    group.iter().filter(|e| e.visible == Some(true) && f.said_since(e)).collect();
                let unsure: Vec<&ExtWindow> = group
                    .iter()
                    .filter(|e| {
                        !self.bindings.contains_key(&e.key)
                            && !visible.iter().any(|v| v.key == e.key)
                            && !f.hidden_now(e)
                    })
                    .collect();
                // Only pages that have said nothing, and the pages long settled since the last change.
                let silent = !unsure.is_empty() && unsure.iter().all(|e| e.visible.is_none());
                let bound = self.bound();
                let went_known = last_change
                    .is_some_and(|c| c.front && !c.went.is_empty() && c.went.iter().all(|n| bound.contains(n)));
                let quiet_from = if went_known {
                    f64::NEG_INFINITY
                } else {
                    last_change.map(|c| c.latest).unwrap_or(first_read_at) + t.visible_lag + t.visible_quiet
                };
                let same_server = self.server_having(f, &w.bounds);
                let reason = if !steady {
                    Some("the window server's reads aren't steady yet".to_string())
                } else if shown != 1 {
                    Some(format!("{shown} windows with its bounds are on screen"))
                } else if same_server != group.len() {
                    Some(format!(
                        "{same_server} window(s) have its bounds, {} reported (a Private window, or a profile without Margin?)",
                        group.len()
                    ))
                } else if visible.len() != 1 {
                    Some(if visible.is_empty() {
                        format!("no page with its bounds says it's shown {since_text}")
                    } else {
                        format!(
                            "{} pages say they're shown {since_text} ({})",
                            visible.len(),
                            keys_joined(visible.iter().copied())
                        )
                    })
                } else if self.bindings.contains_key(&visible[0].key) {
                    Some(format!("{} says it's shown, but it's bound to another window", visible[0].key))
                } else if !unsure.is_empty() && !silent {
                    Some(format!("{} said nothing of being hidden {since_text}", keys_joined(unsure.iter().copied())))
                } else if silent && now < quiet_from {
                    Some(format!(
                        "{} said nothing yet (the pages settling after the last change)",
                        keys_joined(unsure.iter().copied())
                    ))
                } else {
                    None
                };
                if let Some(reason) = reason {
                    // Said once per window per change, once the pages have had their time to say.
                    let key = format!("{} {reason}", swift_double(last_change.map(|c| c.at).unwrap_or(0.0)));
                    if now - f.threshold >= t.visible_lag + t.visible_hold
                        && now - first_read_at >= t.visible_lag + t.visible_hold
                        && self.visible_said.get(&w.number) != Some(&key)
                    {
                        self.visible_said.insert(w.number, key);
                        self.note(format!(
                            "{}: window {} (on screen, {}) not bound from its page: {reason}",
                            self.browser,
                            w.number,
                            w.bounds.describe()
                        ));
                    }
                    continue;
                }
                let x = visible[0].clone();
                let holding = self.seeing.get(&w.number).filter(|s| s.0 == x.key).map(|s| s.1).unwrap_or(now);
                now_seeing.insert(w.number, (x.key.clone(), holding));
                if now - holding < t.visible_hold {
                    continue;
                }
                now_seeing.remove(&w.number);
                self.visible_said.remove(&w.number);
                let quiet = if silent {
                    format!("; {} said nothing, the others hidden", keys_joined(unsure.iter().copied()))
                } else {
                    String::new()
                };
                let why = format!(
                    "visible: its page alone says it's shown (since {}), window {} the only one on screen with its bounds ({same_server} window(s) with them, all reported){quiet}",
                    self.clock(x.visible_at.unwrap_or(now)),
                    w.number
                );
                self.bind(&x.key, w.number, now, why, None);
            }
        }
        self.seeing = now_seeing;
        let bound = self.bound();
        self.visible_said
            .retain(|n, _| f.candidates.iter().any(|c| c.number == *n && c.on_screen) && !bound.contains(n));
    }

    // A binding its pages say is wrong: its window on screen and its page hidden (said since the last change) for
    // `hidden_drop`, while another profile's same-bounds window's page says it's shown. Never on pages that said
    // nothing, nor within `hidden_quiet` of a Space change.
    fn rule_hidden(&mut self, f: &Frame, steady: bool, space_changed_at: Secs) {
        let t = &f.t;
        let now = f.now;
        let mut hidden: BTreeMap<WindowKey, Secs> = BTreeMap::new();
        if f.in_front && steady && now - space_changed_at >= t.hidden_quiet {
            let snapshot: Vec<(WindowKey, Binding)> =
                self.bindings.iter().map(|(k, b)| (k.clone(), b.clone())).collect();
            for (key, b) in snapshot {
                if f.parked.contains(&b.number) {
                    continue;
                }
                let (Some(e), Some(w)) = (f.by_key.get(&key), f.present.get(&b.number)) else { continue };
                if !self.pages_deny(f, e, w) {
                    continue;
                }
                let Some(other) = self
                    .ext_fitting(f, &w.bounds)
                    .into_iter()
                    .find(|x| x.key.link != key.link && x.visible == Some(true) && f.said_since(x))
                else {
                    continue;
                };
                let from = self.hidden_since.get(&key).copied().unwrap_or(now);
                hidden.insert(key.clone(), from);
                if now - from >= t.hidden_drop {
                    hidden.remove(&key);
                    let other_at = self.clock(other.visible_at.unwrap_or(now));
                    let why = format!(
                        "its page has said it's hidden since {} while window {} is on screen, and {}'s page says it's shown (since {other_at}): not its window",
                        self.clock(e.visible_at.unwrap_or(now)),
                        b.number,
                        other.key
                    );
                    self.drop_binding(&key, why);
                    // And the window whose page says it's shown, bound to one not on screen: not that one either.
                    if let Some(ob) = self.bindings.get(&other.key).map(|b| b.number) {
                        if f.present.get(&ob).map(|p| p.on_screen) != Some(true) {
                            let why = format!(
                                "its page says it's shown (since {other_at}) while window {ob} isn't on screen, and window {}, the only one on screen with its bounds, isn't {key}'s: not its window",
                                b.number
                            );
                            self.drop_binding(&other.key, why);
                        }
                    }
                }
            }
        }
        self.hidden_since = hidden;
    }

    // ---- settled focus ----
    // Within one copy only: its focused flag orders its own windows, never another profile's. So only when every
    // window the copies report with the front window's bounds is that one copy's.
    fn rule_settled(&mut self, f: &Frame) {
        let t = &f.t;
        let now = f.now;
        let mut settled_why: Option<String> = None;
        let front0 = self.front.and_then(|fr| f.present.get(&fr).map(|w| (fr, w.clone())));
        let bound = self.bound();
        match front0 {
            Some((fr, fw)) if f.in_front && !bound.contains(&fr) && !self.retired.contains(&fr) => {
                let group: Vec<ExtWindow> = f
                    .by_key
                    .values()
                    .filter(|e| e.state != "minimized" && !self.parked_key(f, &e.key) && fits(e, &fw))
                    .cloned()
                    .collect();
                let free = group.iter().filter(|e| !self.bindings.contains_key(&e.key)).count();
                let links: BTreeSet<&str> = group.iter().map(|e| e.key.link.as_str()).collect();
                let focused: Vec<&ExtWindow> = group.iter().filter(|e| e.focused).collect();
                let same_server = f.candidates.iter().filter(|c| close(&c.bounds, &fw.bounds)).count()
                    + self.missing_free(f, &fw.bounds);
                let newest = group.iter().filter_map(|e| e.focused_at).fold(None, |m: Option<f64>, x| {
                    Some(match m {
                        Some(m) if m >= x => m,
                        _ => x,
                    })
                });
                if free == 0 {
                    settled_why = None;
                } else if !f.held.is_empty() {
                    settled_why =
                        Some(format!("links held ({})", f.held.iter().cloned().collect::<Vec<_>>().join(", ")));
                } else if links.len() != 1 {
                    settled_why = Some(format!(
                        "the windows with its bounds are {} copies' ({}): a copy's focus flags only order its own windows",
                        links.len(),
                        links.iter().copied().collect::<Vec<_>>().join(", ")
                    ));
                } else if focused.len() != 1 {
                    settled_why =
                        Some(format!("focused count {} ({})", focused.len(), keys_joined(focused.iter().copied())));
                } else {
                    let x = focused[0];
                    if self.bindings.contains_key(&x.key) {
                        settled_why = Some(format!("{}, called focused, is bound to another window", x.key));
                    } else if let Some(blurred) =
                        x.blurred_at.filter(|b| *b > x.focused_at.unwrap_or(f64::NEG_INFINITY))
                    {
                        settled_why = Some(format!(
                            "its copy heard none of its windows focused (at {}) after {}",
                            self.clock(blurred),
                            x.key
                        ));
                    } else if self.pages_deny(f, x, &fw) {
                        settled_why = Some(format!("{}'s page says it's hidden", x.key));
                    } else if same_server != group.len() {
                        settled_why = Some(format!("sameServer {same_server} vs sameExt {}", group.len()));
                    } else if !(newest.is_none() || x.focused_at == newest) {
                        settled_why = Some(format!("{} is not the newest focus its copy heard", x.key));
                    }
                }
                if settled_why.is_none() && free != 0 && focused.len() == 1 {
                    let x = focused[0].key.clone();
                    let recent = self.front_since.is_some_and(|s| now - s < t.quiet);
                    match &self.settling {
                        Some((k, n, since)) if *k == x && *n == fr => {
                            let since = *since;
                            if now - since >= t.settle && !recent {
                                let why = format!(
                                    "settled focus: the only window its copy calls focused for {:.1} s, window {fr} in front for {:.1} s ({same_server} window(s) with its bounds, all its copy's)",
                                    now - since,
                                    now - self.front_since.unwrap_or(now)
                                );
                                self.bind(&x, fr, now, why, None);
                                self.settling = None;
                            }
                        }
                        _ => self.settling = Some((x, fr, now)),
                    }
                } else {
                    self.settling = None;
                }
            }
            _ => self.settling = None,
        }
        match (settled_why, self.front) {
            (Some(why), Some(fr)) => {
                let line = format!("{}: settled focus can't bind window {fr}: {why}", self.browser);
                if self.settled_said.as_ref() != Some(&line) {
                    self.settled_said = Some(line.clone());
                    self.note(line);
                }
            }
            _ => self.settled_said = None,
        }
    }

    /// The front window's changes, one line at most a second (each as its number, or none, and when it was seen).
    fn note_front(&mut self, now: Secs) {
        if self.front_noted.is_empty() || now - self.front_noted_at < 1.0 {
            return;
        }
        let n = self.front_noted.len();
        let last = self.front_noted[n.saturating_sub(12)..].join(", ");
        let before = if n > 12 { format!(" ({} before)", n - 12) } else { String::new() };
        let line = format!("{}: the front window: {last}{before}", self.browser);
        self.note(line);
        self.front_noted.clear();
        self.front_noted_at = now;
    }
}

// The Swift's tests (app/platforms/macos/shell/tests/window-tests.swift `windowBinding`, `parkedWindowBinding`, `axBinding`,
// `stackingExact`), read after read against the same made-up browser, with the same seeds for the randomized runs.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};

    const A: &str = "safari:A";
    const B: &str = "safari:B";
    const C: &str = "safari:C";
    const T0: f64 = 1_800_000_000.0;
    const SCREEN: Rect = Rect::new(0.0, 0.0, 1512.0, 982.0);
    const SECOND: Rect = Rect::new(1512.0, -100.0, 1920.0, 1080.0); // another display's full screen
    const LEFT: Rect = Rect::new(40.0, 60.0, 900.0, 700.0);
    const RIGHT: Rect = Rect::new(600.0, 120.0, 820.0, 640.0);

    fn k(link: &str, id: i64) -> WindowKey {
        WindowKey::new(link, id)
    }
    fn map(pairs: &[(WindowKey, i64)]) -> BTreeMap<WindowKey, i64> {
        pairs.iter().cloned().collect()
    }
    fn set_of(n: &[i64]) -> BTreeSet<i64> {
        n.iter().copied().collect()
    }

    type PageLag = Box<dyn FnMut(&WindowKey, bool) -> f64>;
    type Due = Vec<(f64, usize, Box<dyn FnOnce(&mut World)>)>;

    // One browser as both sides see it, with a clock. Each `read` is one read of the window server.
    struct World {
        t: f64,
        server: Vec<ServerWindow>,
        ext: BTreeMap<String, Vec<ExtWindow>>, // per link (its copy's last report)
        copies: BTreeMap<String, String>,
        held: BTreeSet<String>,
        in_front: bool,
        pids: HashSet<u32>,
        log: Arc<Mutex<Vec<String>>>,
        binder: WindowBinder,
        truth: BTreeMap<WindowKey, i64>,
        wrong: Vec<String>,
        // Blips of the window server's list: these numbers left out of a read; `collapse`, every one of the
        // browser's left out; `no_list`, no list at all.
        blipped: BTreeSet<i64>,
        collapse: bool,
        no_list: bool,
        // The pages: with `pages` on, each extension window the truth names has its page say it's shown while its
        // window is on screen, hidden while not, `page_lag` after the window server changed; `silent` ones never say.
        pages: bool,
        page_lag: PageLag,
        silent: BTreeSet<WindowKey>,
        space_at: f64,
        parked: BTreeSet<i64>,
        exact: BTreeMap<i64, String>,
        page_target: BTreeMap<WindowKey, bool>,
        page_due: Vec<(f64, WindowKey, bool)>,
        page_last: BTreeMap<WindowKey, f64>,
        // When each window server window was last in a read, and every binding dropped for a window missing from
        // the reads less than `Timing::absent`.
        last_listed: BTreeMap<i64, f64>,
        early_drops: Vec<String>,
    }

    impl World {
        fn new() -> Self {
            let log = Arc::new(Mutex::new(Vec::new()));
            let sink = log.clone();
            let binder = WindowBinder::new(
                "safari",
                Timing::default(),
                Box::new(move |l: &str| {
                    if let Ok(mut v) = sink.lock() {
                        v.push(l.to_string());
                    }
                }),
            );
            Self {
                t: T0,
                server: Vec::new(),
                ext: BTreeMap::new(),
                copies: BTreeMap::new(),
                held: BTreeSet::new(),
                in_front: true,
                pids: [1].into_iter().collect(),
                log,
                binder,
                truth: BTreeMap::new(),
                wrong: Vec::new(),
                blipped: BTreeSet::new(),
                collapse: false,
                no_list: false,
                pages: false,
                page_lag: Box::new(|_, _| 0.0),
                silent: BTreeSet::new(),
                space_at: f64::NEG_INFINITY,
                parked: BTreeSet::new(),
                exact: BTreeMap::new(),
                page_target: BTreeMap::new(),
                page_due: Vec::new(),
                page_last: BTreeMap::new(),
                last_listed: BTreeMap::new(),
                early_drops: Vec::new(),
            }
        }

        fn lines(&self) -> Vec<String> {
            self.log.lock().map(|v| v.clone()).unwrap_or_default()
        }
        fn said(&self) -> String {
            self.lines().join("\n")
        }
        fn count(&self, text: &str) -> usize {
            self.lines().iter().filter(|l| l.contains(text)).count()
        }
        fn numbers(&self) -> BTreeMap<WindowKey, i64> {
            self.binder.numbers()
        }

        fn read(&mut self, dt: f64) -> BTreeMap<WindowKey, i64> {
            let before = self.t;
            self.t += dt;
            if self.pages {
                // A page sees its window shown or hidden a moment after the window server's change.
                for (key, n) in self.truth.clone() {
                    if self.get(&key).is_none() || self.silent.contains(&key) {
                        continue;
                    }
                    let on = self.server.iter().find(|w| w.number == n).is_some_and(|w| w.on_screen);
                    if self.page_target.get(&key) != Some(&on) {
                        self.page_target.insert(key.clone(), on);
                        // One page says things in order: a word never overtakes the one before it.
                        let lag = (self.page_lag)(&key, on);
                        let at = (before + 0.001 + lag)
                            .max(self.page_last.get(&key).copied().unwrap_or(f64::NEG_INFINITY) + 0.001);
                        self.page_last.insert(key.clone(), at);
                        self.page_due.push((at, key, on));
                    }
                }
                self.page_due.sort_by(|a, b| a.0.total_cmp(&b.0));
                while self.page_due.first().is_some_and(|d| d.0 <= self.t) {
                    let (at, key, visible) = self.page_due.remove(0);
                    self.say(&key, Some(visible), Some(at));
                }
            }
            let listed: Vec<ServerWindow> = if self.no_list {
                Vec::new()
            } else if self.collapse {
                self.server.iter().filter(|w| !self.pids.contains(&w.pid)).cloned().collect()
            } else {
                self.server.iter().filter(|w| !self.blipped.contains(&w.number)).cloned().collect()
            };
            let said = self.lines().len();
            let u = Update {
                now: self.t,
                ext: self.ext.values().flatten().cloned().collect(),
                reporting: self.ext.keys().cloned().collect(),
                copies: self.copies.clone(),
                held: self.held.clone(),
                server: listed.clone(),
                pids: self.pids.clone(),
                browser_in_front: self.in_front,
                listed: !self.no_list,
                space_changed_at: self.space_at,
                parked: self.parked.clone(),
                exact: self.exact.clone(),
            };
            let out = self.binder.update(&u);
            // Measured, not read from the line's words: how long the window had been out of the reads.
            for line in self.lines()[said..].iter().filter(|l| l.contains(" is gone from the window server")) {
                let Some(i) = line.find("is no longer window ") else { continue };
                let digits: String =
                    line[i + "is no longer window ".len()..].chars().take_while(|c| c.is_ascii_digit()).collect();
                let Ok(n) = digits.parse::<i64>() else { continue };
                if self.pids.is_empty() {
                    continue;
                }
                let away = self.t - self.last_listed.get(&n).copied().unwrap_or(f64::NEG_INFINITY);
                if away < self.binder.timing.absent - 1e-9 {
                    self.early_drops.push(format!("window {n} dropped {away:.2} s after it was last listed: {line}"));
                }
            }
            for w in listed.iter().filter(|w| self.pids.contains(&w.pid)) {
                self.last_listed.insert(w.number, self.t);
            }
            for (key, n) in &out {
                if let Some(truth) = self.truth.get(key).filter(|t| *t != n) {
                    self.wrong.push(format!("{key} bound to {n}, is {truth} (t+{:.2})", self.t - T0));
                }
            }
            out
        }
        fn read0(&mut self) -> BTreeMap<WindowKey, i64> {
            self.read(0.25)
        }
        fn run(&mut self, seconds: f64) {
            self.run_every(seconds, 0.25)
        }
        fn run_every(&mut self, seconds: f64, every: f64) {
            let mut left = seconds;
            while left > 1e-9 {
                self.read(every.min(left));
                left -= every;
            }
        }

        // The window server's windows.
        fn add(&mut self, n: i64, r: Rect, on: bool) {
            self.add_window(n, r, on, 1, 0, 1.0);
        }
        fn add_window(&mut self, n: i64, r: Rect, on: bool, pid: u32, layer: i32, alpha: f64) {
            let order = self.server.len() + 10;
            self.server.push(ServerWindow { number: n, pid, layer, bounds: r, on_screen: on, alpha, order });
        }
        fn remove(&mut self, n: i64) {
            self.server.retain(|w| w.number != n);
        }
        fn mv(&mut self, n: i64, r: Rect) {
            for w in self.server.iter_mut().filter(|w| w.number == n) {
                w.bounds = r;
            }
        }
        // The Space showing `n` (and `also`): those on screen, `n` in front; the rest of the browser's off screen.
        fn show(&mut self, n: Option<i64>, also: &[i64]) {
            for w in self.server.iter_mut() {
                let on = Some(w.number) == n || also.contains(&w.number);
                w.on_screen = on;
                w.order = if Some(w.number) == n {
                    0
                } else if on {
                    1
                } else {
                    w.number as usize
                };
            }
        }
        fn show1(&mut self, n: i64) {
            self.show(Some(n), &[]);
        }
        fn front(&self) -> Option<i64> {
            candidates(&self.server, &self.pids)
                .into_iter()
                .filter(|w| w.on_screen)
                .min_by_key(|w| w.order)
                .map(|w| w.number)
        }

        // The extension's windows: fullscreen and not focused unless changed through the returned window.
        fn put(&mut self, link: &str, id: i64, r: Option<Rect>) -> &mut ExtWindow {
            let w = ExtWindow::new(k(link, id), r, "fullscreen", false);
            self.copies.entry(link.to_string()).or_insert_with(|| format!("copy-{link}"));
            let list = self.ext.entry(link.to_string()).or_default();
            let i = match list.iter().position(|e| e.key.window_id == id) {
                Some(i) => {
                    list[i] = w;
                    i
                }
                None => {
                    list.push(w);
                    list.len() - 1
                }
            };
            &mut list[i]
        }
        fn close(&mut self, link: &str, id: i64) {
            if let Some(list) = self.ext.get_mut(link) {
                list.retain(|e| e.key.window_id != id);
            }
        }
        fn get(&self, key: &WindowKey) -> Option<&ExtWindow> {
            self.ext.get(&key.link)?.iter().find(|e| e.key == *key)
        }
        fn set(&mut self, key: &WindowKey, f: impl FnOnce(&mut ExtWindow)) {
            if let Some(e) = self.ext.get_mut(&key.link).and_then(|l| l.iter_mut().find(|e| e.key == *key)) {
                f(e);
            }
        }
        // A window's page in front saying it's shown or hidden (None: it said nothing, or its word was forgotten).
        fn say(&mut self, key: &WindowKey, visible: Option<bool>, at: Option<f64>) {
            let t = self.t;
            self.set(key, |e| {
                e.visible = visible;
                e.visible_at = if visible.is_none() { None } else { Some(at.unwrap_or(t)) };
            });
        }
        // Margin.app hearing the active Space changed (now, or `ago` seconds back).
        fn space_changed(&mut self, ago: f64) {
            self.space_at = self.t - ago;
        }
        // A window's word forgotten (another tab shown in it), its new tab saying it again `after` seconds later.
        fn forget(&mut self, key: &WindowKey, after: f64) {
            self.say(key, None, None);
            let Some(&n) = self.truth.get(key) else { return };
            if self.silent.contains(key) {
                return;
            }
            let on = self.server.iter().find(|w| w.number == n).is_some_and(|w| w.on_screen);
            let at = (self.t + after).max(self.page_last.get(key).copied().unwrap_or(f64::NEG_INFINITY) + 0.001);
            self.page_last.insert(key.clone(), at);
            self.page_target.insert(key.clone(), on);
            self.page_due.push((at, key.clone(), on));
        }
        // A copy's flags: `key` focused, its other windows not (each copy says only of its own).
        fn flags(&mut self, link: &str, focused: Option<&WindowKey>) {
            for e in self.ext.get_mut(link).into_iter().flatten() {
                e.focused = Some(&e.key) == focused;
            }
        }
        // The focus moving to `key`: heard by its copy at `at` (default now), its flag with it.
        fn focus(&mut self, key: &WindowKey, at: Option<f64>) {
            let when = at.unwrap_or(self.t);
            self.flags(&key.link.clone(), Some(key));
            self.set(key, |e| e.focused_at = Some(when));
        }
        // Each focus change after showing a window, as the tests do it.
        fn show_and_focus(&mut self, n: i64, key: &WindowKey) {
            self.show1(n);
            self.read(0.05);
            let at = self.t - 0.02;
            self.focus(key, Some(at));
            self.run_every(2.4, 0.1);
        }
    }

    // A tiny seeded generator (SplitMix64): the same seed, the same run, as the Swift's.
    struct Seeded {
        state: u64,
    }
    impl Seeded {
        fn new(state: u64) -> Self {
            Self { state }
        }
        fn next(&mut self) -> u64 {
            self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
        fn unit(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
        fn range(&mut self, a: f64, b: f64) -> f64 {
            a + (b - a) * self.unit()
        }
        fn pick<T: Clone>(&mut self, list: &[T]) -> T {
            let i = (self.next() % list.len() as u64) as usize;
            list[i].clone()
        }
        fn chance(&mut self, p: f64) -> bool {
            self.unit() < p
        }
    }
    type Rng = Rc<RefCell<Seeded>>;
    fn rng(state: u64) -> Rng {
        Rc::new(RefCell::new(Seeded::new(state)))
    }

    fn env_runs(name: &str, default: u64) -> u64 {
        std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
    }
    // One run (WINDOW_SEED, as the Swift's), or the first `runs`.
    fn seeds(runs: u64) -> std::ops::RangeInclusive<u64> {
        match std::env::var("WINDOW_SEED").ok().and_then(|v| v.parse().ok()) {
            Some(seed) => seed..=seed,
            None => 1..=runs,
        }
    }
    // The log of a failed run: all of it for one seed (WINDOW_SEED), else its end.
    fn tail(w: &World, n: usize) -> String {
        let lines = w.lines();
        let n = if std::env::var("WINDOW_SEED").is_ok() { lines.len() } else { n };
        lines[lines.len().saturating_sub(n)..].join("\n")
    }

    // ---- parsing ----
    #[test]
    fn parsing() {
        let list = vec![
            json!({"windowId": 7, "left": 0, "top": 0, "width": 1512, "height": 982, "state": "fullscreen", "focused": true,
                   "activeTabId": 3, "focusedAt": 1_800_000_000_500u64, "createdAt": 1_800_000_000_000u64}),
            json!({"id": 8, "state": "minimized"}),
            json!({"nope": 1}),
            json!("not a window"),
        ];
        let p = ExtWindow::parse(&list, A);
        assert_eq!(p.len(), 2, "windows parsed (id or windowId; none without one)");
        assert_eq!(p[0].bounds, Some(SCREEN));
        assert!(p[0].focused);
        assert_eq!(p[0].active_tab_id, Some(3));
        assert_eq!(p[0].focused_at, Some(1_800_000_000.5));
        assert_eq!(p[0].created_at, Some(1_800_000_000.0));
        assert_eq!(p[1].bounds, None);
        assert_eq!(p[1].state, "minimized");
        assert_eq!(p[1].focused_at, None);
        // The rest of the protocol's fields.
        let q = ExtWindow::parse(
            &[json!({"windowId": 2.0, "left": 0, "top": 0, "width": 10, "height": 0, "visible": true,
                     "viewport": {"x": 0, "y": 20, "width": 800, "height": 600, "measured": true},
                     "viewportTimes": {"resized": 1000, "said": 0}, "blurredAt": -5, "wasParked": true})],
            B,
        );
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].bounds, None, "no bounds without a width and height");
        assert_eq!(q[0].visible, None, "visible without visibleAt is unknown");
        assert_eq!(q[0].viewport, Some(Rect::new(0.0, 20.0, 800.0, 600.0)));
        assert!(q[0].viewport_measured && q[0].was_parked && !q[0].page_fullscreen);
        assert_eq!(q[0].viewport_times, Some(ViewportTimes { resized: Some(1.0), said: None, heard: None }));
        assert_eq!(q[0].blurred_at, None);
        let v =
            ExtWindow::parse(&[json!({"windowId": 3, "visible": false, "visibleAt": 2000, "viewport": {"x": 1}})], B);
        assert_eq!((v[0].visible, v[0].visible_at, v[0].viewport), (Some(false), Some(2.0), None));
        assert!(ExtWindow::parse(&[json!({"windowId": "3"}), json!({"windowId": 2.5})], B).is_empty());
    }

    // ---- one window: its bounds ----
    #[test]
    fn one_window_by_its_bounds() {
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.put(A, 7, Some(SCREEN)).focused = true;
        w.truth = map(&[(k(A, 7), 100)]);
        assert_eq!(w.read0(), map(&[(k(A, 7), 100)]), "one window: bound by its bounds at the first read");
        assert!(
            w.lines().len() == 1
                && w.said().contains("safari:A#7 is window 100: the only free window with its bounds (0,0 1512×982)"),
            "{}",
            w.said()
        );
        let before = w.lines().len();
        w.run(5.0);
        assert_eq!(w.lines().len(), before, "reads that change nothing log nothing: {}", w.said());

        let mut w = World::new();
        w.server = vec![ServerWindow::new(100, 1, SCREEN.offset_by(3.0, -2.0))];
        w.put(A, 7, Some(SCREEN));
        assert_eq!(w.read0(), map(&[(k(A, 7), 100)]), "a few points off: still it");

        let cases = [
            ("far off: not it", ServerWindow::new(100, 1, SCREEN.inset_by(40.0, 40.0)), "fullscreen"),
            ("another app's window with the same bounds: not it", ServerWindow::new(100, 2, SCREEN), "fullscreen"),
            (
                "a browser window of another layer: not it",
                ServerWindow { layer: 25, ..ServerWindow::new(100, 1, SCREEN) },
                "fullscreen",
            ),
            (
                "an invisible one: not it",
                ServerWindow { alpha: 0.0, ..ServerWindow::new(100, 1, SCREEN) },
                "fullscreen",
            ),
            ("a minimized window: not bound", ServerWindow::new(100, 1, SCREEN), "minimized"),
        ];
        for (label, server, state) in cases {
            let mut w = World::new();
            w.server = vec![server];
            w.put(A, 7, Some(SCREEN)).state = state.into();
            assert!(w.read0().is_empty(), "{label}");
        }
        let pids: HashSet<u32> = [1].into_iter().collect();
        assert!(
            candidates(&[ServerWindow::new(1, 1, Rect::new(0.0, 0.0, 300.0, 80.0))], &pids).is_empty(),
            "a popover-sized window isn't a browser window"
        );
    }

    #[test]
    fn two_profiles_same_id_and_displays() {
        let mut w = World::new();
        w.add(300, RIGHT, true);
        w.add(301, LEFT, true);
        w.put(A, 7, Some(LEFT)).state = "normal".into();
        w.put(B, 7, Some(RIGHT)).state = "normal".into();
        assert_eq!(w.read0(), map(&[(k(A, 7), 301), (k(B, 7), 300)]), "told apart by link and bounds");

        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(101, LEFT, true);
        w.add(102, SECOND, true);
        w.put(A, 1, Some(SCREEN));
        w.put(A, 2, Some(LEFT)).state = "normal".into();
        w.put(B, 3, Some(SECOND));
        w.truth = map(&[(k(A, 1), 100), (k(A, 2), 101), (k(B, 3), 102)]);
        assert_eq!(w.read0(), w.truth, "one full screen on another Space, one not, one on another display");
    }

    // ---- two full-screen windows, same bounds, from a relaunch ----
    #[test]
    fn relaunch_same_bounds_then_pages() {
        let mut w = World::new();
        w.add(12812, SCREEN, true);
        w.add(12881, SCREEN, false);
        w.show1(12812);
        w.put(A, 74, Some(SCREEN)).focused = true;
        w.put(B, 1169, Some(SCREEN));
        w.truth = map(&[(k(A, 74), 12812), (k(B, 1169), 12881)]);
        assert!(w.read0().is_empty(), "relaunched, two same-bounds full-screen windows: none bound at once");
        assert!(
            w.count("isn't bound") == 2 && w.said().contains("2 windows have its bounds (12812, 12881)"),
            "{}",
            w.said()
        );
        w.run(10.0);
        assert!(w.numbers().is_empty() && w.wrong.is_empty(), "settled focus doesn't bind across copies");
        assert!(
            w.count("settled focus can't bind window 12812") == 1
                && w.said().contains("safari: settled focus can't bind window 12812: the windows with its bounds are 2 copies' (safari:A, safari:B): a copy's focus flags only order its own windows"),
            "{}",
            w.said()
        );
        w.pages = true;
        let seen_at = w.t + 0.25;
        w.run(1.5);
        assert_eq!(w.numbers(), w.truth, "the front one bound (visible), then the other by elimination: {}", w.said());
        let at = w.binder.bindings().get(&k(A, 74)).map(|b| b.at).unwrap_or(f64::INFINITY);
        assert!(at - seen_at <= 0.55, "within about half a second of the pages' word");
        let said = w.said();
        assert!(
            said.contains("safari:A#74 is window 12812: visible: its page alone says it's shown (since "),
            "{said}"
        );
        assert!(
            said.contains("window 12812 the only one on screen with its bounds (2 window(s) with them, all reported)")
        );
        assert!(said.contains(
            "safari:B#1169 is window 12881: the only free window with its bounds (0,0 1512×982); 1 other(s) with them already bound"
        ));
        assert!(w.wrong.is_empty(), "{:?}", w.wrong);
    }

    #[test]
    fn settled_focus_within_one_copy() {
        let mut w = World::new();
        w.add(12812, SCREEN, false);
        w.add(12881, SCREEN, false);
        w.show1(12812);
        w.put(A, 74, Some(SCREEN)).focused = true;
        w.put(A, 75, Some(SCREEN));
        w.truth = map(&[(k(A, 74), 12812), (k(A, 75), 12881)]);
        w.run(4.0);
        assert!(w.numbers().is_empty(), "not before the front window has been the same for 5 s");
        w.run(1.5);
        assert!(
            w.numbers() == w.truth
                && w.said()
                    .contains("safari:A#74 is window 12812: settled focus: the only window its copy calls focused"),
            "{}",
            w.said()
        );

        // The copy heard none of its windows focused after its flag's focus.
        let mut w = World::new();
        w.add(12812, SCREEN, false);
        w.add(12881, SCREEN, false);
        w.show1(12812);
        let t = w.t;
        let e = w.put(A, 74, Some(SCREEN));
        e.focused = true;
        e.focused_at = Some(t - 20.0);
        e.blurred_at = Some(t - 10.0);
        w.put(A, 75, Some(SCREEN));
        w.run(8.0);
        assert!(
            w.numbers().is_empty()
                && w.said()
                    .contains("settled focus can't bind window 12812: its copy heard none of its windows focused"),
            "{}",
            w.said()
        );
    }

    #[test]
    fn focus_moved_binds() {
        let mut w = World::new();
        w.add(12812, SCREEN, false);
        w.add(12881, SCREEN, false);
        w.show1(12812);
        w.put(A, 74, Some(SCREEN)).focused = true;
        w.put(B, 1169, Some(SCREEN)).focused = true; // each copy calls its own window focused
        w.truth = map(&[(k(A, 74), 12812), (k(B, 1169), 12881)]);
        w.run(3.0);
        assert!(w.numbers().is_empty() && w.wrong.is_empty(), "both calling their window focused: nothing guessed");
        w.show1(12881);
        w.read(0.03);
        let at = w.t - 0.01;
        w.focus(&k(B, 1169), Some(at));
        w.read(0.03);
        w.run_every(2.2, 0.1);
        assert_eq!(w.numbers(), w.truth, "B's bound by focus; then A's by elimination: {}", w.said());
        assert!(
            w.said().contains("safari:B#1169 is window 12881: focus moved to it at")
                && w.said().contains("came to the front by")
        );

        // A window of a profile with no linked copy has the same bounds.
        let mut w = World::new();
        w.add(12812, SCREEN, false);
        w.add(12881, SCREEN, false);
        w.add(13000, SCREEN, false);
        w.show1(12812);
        w.put(A, 74, Some(SCREEN)).focused = true;
        w.put(B, 1169, Some(SCREEN));
        w.truth = map(&[(k(A, 74), 12812), (k(B, 1169), 12881)]);
        w.run(4.0);
        assert!(w.numbers().is_empty() && w.wrong.is_empty(), "settled focus doesn't bind (it could be that one)");
        w.show_and_focus(12881, &k(B, 1169));
        assert!(w.numbers() == map(&[(k(B, 1169), 12881)]) && w.wrong.is_empty(), "{:?}", w.numbers());
        w.show_and_focus(12812, &k(A, 74));
        assert!(w.numbers() == w.truth && w.wrong.is_empty(), "and the next binds the other");
    }

    // ---- the swap in a real session's log, replayed (14:32:20) ----
    #[test]
    fn the_swap_replayed() {
        let mut w = World::new();
        w.add(12812, SCREEN, false);
        w.add(12881, SCREEN, false);
        w.show1(12812);
        w.put(A, 74, Some(SCREEN)).focused = true;
        w.put(B, 1169, Some(SCREEN));
        w.truth = map(&[(k(A, 74), 12812), (k(B, 1169), 12881)]);
        w.pages = true;
        w.run(6.0);
        assert_eq!(w.numbers(), w.truth, "the replay starts bound right");
        for round in 0..6 {
            let (to, from) = if round % 2 == 0 { (12881, 12812) } else { (12812, 12881) };
            let (gain, lose) = if round % 2 == 0 { (k(B, 1169), k(A, 74)) } else { (k(A, 74), k(B, 1169)) };
            w.show(Some(to), &[from]);
            w.read(0.033); // mid-swipe: both on screen, the new one in front
            let switched = w.t;
            w.run_every(0.3, 0.033);
            w.show1(to);
            w.run_every(0.35, 0.033); // 650 ms of flags saying the old window is focused
            w.set(&gain, |e| {
                e.focused = true;
                e.focused_at = Some(switched + 0.02)
            });
            w.read(0.033);
            w.run_every(0.2, 0.033);
            w.set(&lose, |e| e.focused = false);
            w.read(0.033);
            if round == 4 {
                w.set(&lose, |e| e.focused = true);
                w.run(0.5);
            }
            w.run_every(1.5, 0.1);
        }
        assert!(
            w.wrong.is_empty() && w.numbers() == w.truth,
            "no swap at any read: {:?}",
            &w.wrong[..w.wrong.len().min(3)]
        );
        assert!(!w.said().contains("no longer") && !w.said().contains("(was "), "{}", w.said());
    }

    // ---- focus evidence against a binding ----
    #[test]
    fn two_focus_changes_move_a_binding() {
        let mut w = World::new();
        w.add(12812, SCREEN, false);
        w.add(12881, SCREEN, false);
        w.show1(12812);
        w.put(A, 74, Some(SCREEN)).focused = true;
        w.put(B, 1169, Some(SCREEN));
        w.truth = map(&[(k(A, 74), 12812), (k(B, 1169), 12881)]);
        w.pages = true;
        w.run(6.0);
        w.pages = false;
        // Suppose the bindings were wrong: swap the truth.
        w.truth = map(&[(k(A, 74), 12881), (k(B, 1169), 12812)]);
        w.wrong.clear();
        let swap = |w: &mut World, n: i64, key: WindowKey| {
            w.show1(n);
            w.read(0.05);
            let at = w.t - 0.02;
            w.focus(&key, Some(at));
            w.run_every(2.2, 0.1);
        };
        swap(&mut w, 12881, k(A, 74));
        assert!(
            w.numbers() == map(&[(k(A, 74), 12812), (k(B, 1169), 12881)])
                && w.said().contains("kept (a second focus change saying so would move it)"),
            "one focus change against a binding: kept: {}",
            w.said()
        );
        swap(&mut w, 12812, k(B, 1169));
        swap(&mut w, 12881, k(A, 74));
        assert_eq!(w.numbers(), w.truth, "a second one: moved, the other then by elimination: {}", w.said());
        assert!(w.said().contains("(was 12812): two focus changes said so"), "{}", w.said());
    }

    // ---- windows closed, created, the one-window profile switch ----
    #[test]
    fn closed_and_created() {
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(200, SCREEN, false);
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(A, 2, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(A, 2), 200)]);
        w.run(6.0);
        assert_eq!(w.numbers(), w.truth, "settled, then elimination");
        w.close(A, 2);
        w.read0();
        assert!(
            w.numbers() == map(&[(k(A, 1), 100)])
                && w.said().contains("safari:A#2 is no longer window 200: closed in the browser")
        );
        let t = w.t;
        w.put(A, 3, Some(SCREEN)).created_at = Some(t);
        w.truth.insert(k(A, 3), 300);
        w.run(0.5);
        assert!(!w.numbers().contains_key(&k(A, 3)) && w.wrong.is_empty(), "not bound to the closing window");
        w.add(300, SCREEN, false);
        w.remove(200);
        w.run(0.5);
        assert!(w.numbers().get(&k(A, 3)) == Some(&300) && w.wrong.is_empty(), "{}", w.said());
    }

    #[test]
    fn created_together() {
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(200, SCREEN, false);
        w.add(300, SCREEN, false);
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(A, 2, Some(SCREEN)).focused = true; // two focused: no settling
        w.put(B, 9, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(A, 2), 200), (k(B, 9), 300), (k(B, 5), 500)]);
        w.run(2.0);
        assert!(w.numbers().is_empty(), "nothing told yet");
        w.add(500, SCREEN, false); // opened in full screen (its own Space)
        w.read(0.1);
        let t = w.t;
        let e = w.put(B, 5, Some(Rect::new(0.0, 0.0, 1000.0, 700.0)));
        e.state = "normal".into();
        e.created_at = Some(t - 0.05);
        w.read(0.1);
        w.run(0.8);
        w.set(&k(B, 5), |e| {
            e.bounds = Some(SCREEN);
            e.state = "fullscreen".into()
        });
        w.run(1.5);
        assert!(w.numbers().get(&k(B, 5)) == Some(&500) && w.wrong.is_empty(), "{}", w.said());
        assert!(w.said().contains("safari:B#5 is window 500: created together: its copy heard it created at"));

        // Two windows created at once with the same bounds: creation can't tell them apart.
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.run(1.0);
        let at = w.t;
        w.add(200, SCREEN, false);
        w.add(201, SCREEN, false);
        w.put(A, 2, Some(SCREEN)).created_at = Some(at + 0.05);
        w.put(B, 3, Some(SCREEN)).created_at = Some(at + 0.08);
        w.truth = map(&[(k(A, 1), 100), (k(A, 2), 200), (k(B, 3), 201)]);
        w.run(6.0);
        assert!(w.numbers() == map(&[(k(A, 1), 100)]) && w.wrong.is_empty(), "neither bound on a guess");
    }

    #[test]
    fn one_window_profile_switch() {
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.truth = map(&[(k(A, 1), 100), (k(B, 4), 400)]);
        w.run(1.0);
        let small = Rect::new(0.0, 0.0, 1200.0, 800.0);
        w.add(400, small, false);
        w.read(0.05);
        let t = w.t;
        let e = w.put(B, 4, Some(small));
        e.state = "normal".into();
        e.created_at = Some(t - 0.02);
        w.read(0.05);
        w.mv(400, SCREEN);
        w.show(Some(400), &[100]);
        w.run_every(0.3, 0.05);
        w.set(&k(B, 4), |e| {
            e.bounds = Some(SCREEN);
            e.state = "fullscreen".into()
        });
        let at = w.t - 0.25;
        w.focus(&k(B, 4), Some(at));
        w.run_every(0.3, 0.05);
        w.show1(400);
        w.close(A, 1);
        w.run_every(0.2, 0.05);
        w.remove(100);
        w.run_every(1.5, 0.1);
        assert!(w.numbers() == map(&[(k(B, 4), 400)]) && w.wrong.is_empty(), "{}", w.said());
    }

    // ---- full screen left and entered again; Space swipes and Mission Control moving windows ----
    #[test]
    fn full_screen_and_mission_control_hold() {
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(200, SCREEN, false);
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(B, 2, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(B, 2), 200)]);
        w.pages = true;
        w.run(6.0);
        let windowed = Rect::new(200.0, 100.0, 1000.0, 700.0);
        w.mv(100, Rect::new(100.0, 50.0, 1300.0, 900.0));
        w.run(0.3);
        w.mv(100, windowed);
        w.run(0.8);
        w.set(&k(A, 1), |e| {
            e.bounds = Some(windowed);
            e.state = "normal".into()
        });
        w.run(1.0);
        w.mv(100, SCREEN);
        w.run(1.2);
        w.set(&k(A, 1), |e| {
            e.bounds = Some(SCREEN);
            e.state = "fullscreen".into()
        });
        w.run(1.0);
        assert!(w.numbers() == w.truth && w.wrong.is_empty() && !w.said().contains("no longer"), "{}", w.said());
        w.show(Some(100), &[200]);
        w.mv(100, Rect::new(50.0, 300.0, 600.0, 390.0));
        w.mv(200, Rect::new(800.0, 300.0, 600.0, 390.0));
        w.run(4.0);
        w.mv(100, SCREEN);
        w.mv(200, SCREEN);
        w.show1(200);
        w.read0();
        let at = w.t - 0.1;
        w.focus(&k(B, 2), Some(at));
        w.run(2.0);
        assert!(w.numbers() == w.truth && w.wrong.is_empty() && !w.said().contains("no longer"), "{}", w.said());
    }

    #[test]
    fn moved_rule() {
        let mut w = World::new();
        w.add(100, LEFT, true);
        w.put(A, 1, Some(LEFT)).state = "normal".into();
        w.run(1.0);
        w.add(101, RIGHT, true);
        w.mv(100, Rect::new(1000.0, 500.0, 400.0, 300.0));
        w.set(&k(A, 1), |e| e.bounds = Some(RIGHT));
        w.run(1.0);
        assert_eq!(w.numbers(), map(&[(k(A, 1), 100)]), "matching another free window for a moment: kept");
        w.run(2.0);
        assert!(
            w.numbers() == map(&[(k(A, 1), 101)])
                && w.said().contains("safari:A#1 is window 101 (was 100): its bounds"),
            "{}",
            w.said()
        );
    }

    // ---- links: dropped a moment, a new copy, gone; the browser quitting ----
    #[test]
    fn links_held_new_copy_gone() {
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(200, SCREEN, false);
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(B, 2, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(B, 2), 200)]);
        w.pages = true;
        w.run(6.0);
        let a = w.ext.remove(A);
        w.held = [A.to_string()].into_iter().collect();
        w.run(2.0);
        assert_eq!(w.numbers(), w.truth, "a link dropped a moment (held): kept");
        w.held.clear();
        if let Some(a) = a {
            w.ext.insert(A.into(), a);
        }
        w.run(1.0);
        assert!(w.numbers() == w.truth && !w.said().contains("no longer"), "back, the same copy: kept");
        w.copies.insert(A.into(), "copy-A-2".into());
        w.read0();
        assert!(w.said().contains("safari:A#1 is no longer window 100: a new copy of Margin started"), "{}", w.said());
        w.run(0.5);
        assert_eq!(w.numbers(), w.truth, "then learned again");
        w.ext.remove(B);
        w.read0();
        assert!(
            w.numbers() == map(&[(k(A, 1), 100)])
                && w.said().contains("safari:B#2 is no longer window 200: its copy isn't linked")
        );
        w.server.clear();
        w.pids.clear();
        w.read0();
        assert!(
            w.numbers().is_empty()
                && w.said().contains("safari:A#1 is no longer window 100: window 100 is gone from the window server"),
            "{}",
            w.said()
        );
    }

    // ---- the app's profile switch, both ways: openSpaceWindow's window bound as Margin made it ----
    #[test]
    fn made_by_margin_switch() {
        for lingering in [false, true] {
            let mut w = World::new();
            w.add(100, SCREEN, false);
            w.show1(100);
            w.put(A, 7, Some(SCREEN)).focused = true;
            w.truth = map(&[(k(A, 7), 100), (k(B, 90), 400), (k(A, 91), 500)]);
            w.run(1.0);
            assert_eq!(w.numbers(), map(&[(k(A, 7), 100)]));
            let small = Rect::new(0.0, 0.0, 1100.0, 760.0);
            let mut made = Vec::new();
            for (from_key, from_n, to_key, to_n) in [(k(A, 7), 100, k(B, 90), 400), (k(B, 90), 400, k(A, 91), 500)] {
                let asked = w.t;
                w.add(to_n, small, false);
                w.read(0.05);
                let now = w.t;
                w.binder.expect(to_key.clone(), asked, now, "made by Margin's openSpaceWindow", None);
                w.read(0.05);
                let e = w.put(&to_key.link, to_key.window_id, Some(small));
                e.state = "normal".into();
                e.created_at = Some(asked + 0.02);
                w.read(0.05);
                w.mv(to_n, SCREEN);
                w.show(Some(to_n), &[from_n]);
                w.read(0.05);
                let early = w.numbers().get(&to_key).copied();
                w.run_every(0.3, 0.05);
                w.set(&to_key, |e| {
                    e.bounds = Some(SCREEN);
                    e.state = "fullscreen".into()
                });
                w.read(0.05);
                made.push(w.numbers().get(&to_key) == Some(&to_n) && early == Some(to_n));
                w.show1(to_n);
                w.run_every(0.2, 0.05);
                let at = w.t - 0.5;
                w.focus(&to_key, Some(at));
                w.close(&from_key.link, from_key.window_id);
                w.read(0.05);
                if lingering {
                    w.run_every(1.0, 0.1);
                }
                w.remove(from_n);
                w.run_every(2.5, 0.1);
            }
            assert_eq!(made, [true, true], "lingering {lingering}: bound as soon as its bounds agreed: {}", w.said());
            assert!(
                w.numbers() == map(&[(k(A, 91), 500)])
                    && w.wrong.is_empty()
                    && w.said().contains("safari:A#7 is no longer window 100: closed in the browser")
                    && w.said().contains("safari:B#90 is no longer window 400: closed in the browser"),
                "{}",
                w.said()
            );
            assert!(w.said().contains("safari:B#90 is window 400: made by Margin's openSpaceWindow at"));
        }
    }

    // ---- the window server's list blips (a real session's log, 2026-11-05 21:53:39) ----
    fn three() -> World {
        let mut w = World::new();
        w.add(18278, SCREEN, false);
        w.add(18285, SCREEN, false);
        w.add(18342, SCREEN, false);
        w.show1(18278);
        w.put(A, 155, Some(SCREEN)).focused = true;
        w.put(B, 153, Some(SCREEN)).focused = true;
        w.put(C, 795, Some(SCREEN)).focused = true;
        w.truth = map(&[(k(A, 155), 18278), (k(B, 153), 18285), (k(C, 795), 18342)]);
        w.run(2.0);
        w.show_and_focus(18342, &k(C, 795));
        w
    }

    #[test]
    fn blips() {
        let mut w = three();
        let bound = map(&[(k(C, 795), 18342)]);
        assert_eq!(w.numbers(), bound, "the third profile's window bound by its focus change: {}", w.said());
        let before = w.lines().len();
        w.blipped = set_of(&[18342]);
        w.read(0.25);
        assert!(w.numbers() == bound && *w.binder.absent_numbers() == set_of(&[18342]), "missing from one read: kept");
        let since: Vec<String> = w.lines()[before..].to_vec();
        assert!(
            since.iter().filter(|l| l.contains("missing from one read")).count() == 1
                && w.said().contains("safari:C#795: window 18342 missing from one read (kept for 3 s)"),
            "{}",
            w.said()
        );
        w.blipped.clear();
        w.read(0.042);
        assert!(w.numbers() == bound && w.binder.absent_numbers().is_empty(), "listed again 42 ms later");
        assert_eq!(w.lines().last().map(String::as_str), Some("safari:C#795: window 18342 back after 42 ms"));
        w.collapse = true;
        w.read(0.25);
        assert!(
            w.numbers() == bound && w.binder.last_read_collapsed() && *w.binder.absent_numbers() == set_of(&[18342])
        );
        w.read(0.033);
        w.read(0.033);
        w.collapse = false;
        w.read(0.033);
        assert!(w.binder.absent_numbers().is_empty() && !w.binder.last_read_collapsed());
        let lines: Vec<String> = w.lines()[before..].to_vec();
        let collapsed: Vec<&String> = lines.iter().filter(|l| l.contains("without the browser's windows")).collect();
        assert_eq!(collapsed.len(), 2, "{collapsed:?}");
        assert!(collapsed[0].starts_with("safari: a read of the window server without the browser's windows (2 entries, 2 the browser's, 2 at layer 0; window 18342 not listed): bindings kept"), "{collapsed:?}");
        assert!(collapsed[1].starts_with("safari: a read of the window server without the browser's windows (0 entries, 0 the browser's, 0 at layer 0; window 18342 not listed): bindings kept"), "{collapsed:?}");
        assert!(collapsed[0].ends_with("; the last read that told something had 3 at layer 0; the source gave a list"));
        assert!(
            collapsed[1]
                .ends_with("; the last read that told something had 3 at layer 0; the source gave an empty list")
        );
        let whole: Vec<&String> = lines.iter().filter(|l| l.contains("has the browser's windows again")).collect();
        assert_eq!(
            whole,
            [
                "safari: the window server's list has the browser's windows again after 42 ms (1 read told nothing)",
                "safari: the window server's list has the browser's windows again after 99 ms (3 reads told nothing)",
            ]
        );
        let back: Vec<&String> =
            lines.iter().filter(|l| l.starts_with("safari:C#795: window 18342 back after")).collect();
        assert_eq!(
            back,
            ["safari:C#795: window 18342 back after 42 ms", "safari:C#795: window 18342 back after 99 ms"]
        );
        w.run(20.0);
        assert!(w.numbers() == bound && !w.said().contains("is no longer") && w.wrong.is_empty(), "{}", w.said());
        assert!(!w.lines()[before..].iter().any(|l| l.contains("isn't bound")), "no 'can't be told' lines churned");
    }

    #[test]
    fn focus_events_logged_and_visible_off() {
        let mut w = three();
        w.show1(18278);
        w.run(2.0);
        w.show_and_focus(18342, &k(C, 795));
        assert!(
            w.lines().iter().any(|l| l.starts_with("safari:C#795: focus heard at ")
                && l.contains(" agrees with its binding (window 18342 came to the front by ")),
            "{}",
            w.said()
        );
        w.show1(18278);
        w.run(2.0);
        w.show1(18342);
        w.read(0.05);
        let at = w.t - 0.02;
        w.focus(&k(C, 795), Some(at));
        w.read(0.05);
        w.close(C, 795);
        w.run_every(2.4, 0.1);
        assert!(
            w.lines().iter().any(|l| l.starts_with("safari:C#795: focus heard at ")
                && l.ends_with(" not used: its copy no longer reports it")),
            "{}",
            w.said()
        );
        let n = w.lines().len();
        w.in_front = false;
        w.run(1.0);
        w.in_front = true;
        w.run(1.0);
        w.in_front = false;
        w.run(1.0);
        let off: Vec<String> =
            w.lines()[n..].iter().filter(|l| l.contains("the visible rule not weighed")).cloned().collect();
        assert_eq!(off, vec!["safari: the visible rule not weighed: the browser isn't in front".to_string(); 2]);
    }

    #[test]
    fn collapse_episode() {
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(200, SCREEN, false);
        w.add(300, SCREEN, false);
        w.add(900, SCREEN, false); // a profile with no linked copy
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(B, 2, Some(SCREEN));
        w.put(C, 3, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(B, 2), 200), (k(C, 3), 300)]);
        w.run(2.0);
        w.show_and_focus(200, &k(B, 2));
        w.show_and_focus(100, &k(A, 1));
        let two = map(&[(k(A, 1), 100), (k(B, 2), 200)]);
        assert_eq!(w.numbers(), two, "two bound by focus changes, the third can't be told");
        let (changes, lines) = (w.binder.front_changes().len(), w.lines().len());
        w.collapse = true;
        for i in 0..12 {
            w.no_list = i % 4 == 3;
            w.read(0.033);
        }
        w.no_list = false;
        assert!(w.numbers() == two && *w.binder.absent_numbers() == set_of(&[100, 200]), "every binding kept");
        assert_eq!(w.binder.front_changes().len(), changes, "no front change noted");
        w.collapse = false;
        w.run(3.0);
        assert!(w.numbers() == two && w.wrong.is_empty() && !w.said().contains("no longer"), "{}", w.said());
        assert_eq!(w.binder.front_changes().len(), changes);
        let episode = w.lines()[lines..]
            .iter()
            .filter(|l| l.contains("without the browser's windows") || l.contains("gave no list"))
            .count();
        assert_eq!(episode, 1, "one line for the episode");
        w.no_list = true;
        w.read(0.25);
        w.no_list = false;
        w.read(0.25);
        assert!(w.said().contains("safari: the window server gave no list (0 entries"), "{}", w.said());
    }

    fn two_shown() -> World {
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(200, SCREEN, false);
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(B, 2, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(B, 2), 200)]);
        w.pages = true;
        w.run(6.0);
        w
    }

    #[test]
    fn absent_front_and_grace() {
        let mut w = two_shown();
        let changes = w.binder.front_changes().len();
        w.blipped = set_of(&[100]);
        w.run_every(0.3, 0.1);
        w.blipped.clear();
        w.read(0.1);
        assert!(w.binder.front_changes().len() == changes && w.numbers() == w.truth, "the front window missing 0.3 s");

        let mut w = two_shown();
        w.remove(200);
        w.run_every(2.9, 0.1);
        assert_eq!(w.numbers(), w.truth, "2.9 s missing: still bound");
        w.run_every(0.3, 0.1);
        assert!(
            w.numbers() == map(&[(k(A, 1), 100)])
                && w.count("is no longer window 200") == 1
                && w.said().contains(
                    "safari:B#2 is no longer window 200: window 200 is gone from the window server (not listed for 3 s)"
                ),
            "{}",
            w.said()
        );
        w.run(5.0);
        assert!(w.numbers() == map(&[(k(A, 1), 100)]) && w.wrong.is_empty());
    }

    #[test]
    fn retired_numbers() {
        // Closed in the browser while missing: dropped at once, its number retired.
        let setup = || {
            let mut w = World::new();
            w.add(100, SCREEN, false);
            w.add(200, SCREEN, false);
            w.show1(100);
            w.put(A, 1, Some(SCREEN)).focused = true;
            w.put(A, 2, Some(SCREEN));
            w.truth = map(&[(k(A, 1), 100), (k(A, 2), 200)]);
            w.run(6.0);
            w
        };
        let mut w = setup();
        w.blipped = set_of(&[200]);
        w.read(0.05);
        w.close(A, 2);
        w.read(0.05);
        assert!(
            w.numbers() == map(&[(k(A, 1), 100)])
                && w.said().contains("safari:A#2 is no longer window 200: closed in the browser")
        );
        w.blipped.clear();
        w.put(A, 3, Some(SCREEN));
        w.truth.insert(k(A, 3), 300);
        w.run(2.0);
        assert!(!w.numbers().contains_key(&k(A, 3)) && w.wrong.is_empty(), "its number listed again isn't bound");
        w.remove(200);
        w.add(300, SCREEN, false);
        w.run(1.0);
        assert!(w.numbers().get(&k(A, 3)) == Some(&300) && w.wrong.is_empty());

        // A closed window's number that blips stays closed.
        let mut w = setup();
        w.close(A, 2);
        w.read0();
        w.blipped = set_of(&[200]);
        w.read(0.033);
        w.blipped.clear();
        w.read(0.033);
        w.put(A, 3, Some(SCREEN));
        w.truth.insert(k(A, 3), 300);
        w.run(1.5);
        assert!(!w.numbers().contains_key(&k(A, 3)) && w.wrong.is_empty(), "{}", w.said());
        w.remove(200);
        w.add(300, SCREEN, false);
        w.run(0.5);
        assert!(w.numbers().get(&k(A, 3)) == Some(&300) && w.wrong.is_empty());
    }

    #[test]
    fn blips_as_windows_are_made() {
        // A blip as a new window is created: the window back from the blip isn't the new one.
        let mut w = World::new();
        for n in [100, 200, 900, 901] {
            w.add(n, SCREEN, false);
        }
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(B, 2, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(B, 2), 200), (k(B, 3), 300)]);
        w.run(2.0);
        w.show_and_focus(200, &k(B, 2));
        w.show_and_focus(100, &k(A, 1));
        assert_eq!(w.numbers(), map(&[(k(A, 1), 100), (k(B, 2), 200)]));
        w.blipped = set_of(&[900]);
        w.read(0.1);
        let t = w.t;
        w.put(B, 3, Some(SCREEN)).created_at = Some(t);
        w.read(0.1);
        w.blipped.clear();
        w.read(0.05);
        w.run_every(2.4, 0.1);
        w.add(300, SCREEN, false);
        w.run(3.0);
        assert!(w.wrong.is_empty(), "{:?}\n{}", w.wrong, w.said());

        // A blip during openSpaceWindow: the window back from it isn't Margin's new one.
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(900, SCREEN, false);
        w.show1(100);
        w.put(A, 7, Some(SCREEN)).focused = true;
        w.truth = map(&[(k(A, 7), 100), (k(B, 90), 400)]);
        w.run(2.0);
        let asked = w.t;
        w.blipped = set_of(&[900]);
        w.read(0.05);
        let now = w.t;
        w.binder.expect(k(B, 90), asked, now, "made by Margin's openSpaceWindow", None);
        w.blipped.clear();
        w.read(0.05);
        w.put(B, 90, Some(SCREEN)).created_at = Some(asked + 0.02);
        w.run_every(0.5, 0.05);
        assert!(!w.numbers().contains_key(&k(B, 90)) && w.wrong.is_empty(), "{}", w.said());
        w.add(400, Rect::new(0.0, 0.0, 1100.0, 760.0), false);
        w.read(0.05);
        w.mv(400, SCREEN);
        w.run_every(0.5, 0.05);
        assert!(
            w.numbers().get(&k(B, 90)) == Some(&400)
                && w.wrong.is_empty()
                && w.said().contains("safari:B#90 is window 400: made by Margin's openSpaceWindow"),
            "{}",
            w.said()
        );
    }

    #[test]
    fn real_goings() {
        let mut w = World::new();
        w.add(14375, SCREEN, true);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.truth = map(&[(k(A, 1), 14375)]);
        w.run(1.0);
        w.remove(14375);
        w.read(0.25);
        assert_eq!(w.numbers(), map(&[(k(A, 1), 14375)]), "the window gone, kept a moment");
        w.ext.remove(A);
        w.read(0.003);
        assert!(
            w.numbers().is_empty() && w.said().contains("safari:A#1 is no longer window 14375: its copy isn't linked")
        );
        w.run(0.5);
        w.copies.insert(A.into(), "copy-A-2".into());
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.truth = map(&[(k(A, 1), 15910)]);
        w.add(15910, SCREEN, true);
        w.read(0.1);
        assert!(w.numbers() == map(&[(k(A, 1), 15910)]) && w.wrong.is_empty(), "{}", w.said());

        // A window replaced in one read: bound to the new one at once.
        let mut w = World::new();
        w.add(15875, SCREEN, true);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.run(1.0);
        w.remove(15875);
        w.add(15910, SCREEN, true);
        w.close(A, 1);
        w.put(A, 2, Some(SCREEN)).focused = true;
        w.truth = map(&[(k(A, 2), 15910)]);
        w.read(0.25);
        assert!(w.numbers() == map(&[(k(A, 2), 15910)]) && w.wrong.is_empty(), "{}", w.said());

        // The browser quitting with its links held: its bindings go after the grace.
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.run(1.0);
        w.ext.remove(A);
        w.held = [A.to_string()].into_iter().collect();
        w.server.clear();
        w.run(2.5);
        assert_eq!(w.numbers(), map(&[(k(A, 1), 100)]), "held, its window gone: kept for the grace");
        w.run(1.0);
        assert!(
            w.numbers().is_empty()
                && w.said().contains(
                    "safari:A#1 is no longer window 100: window 100 is gone from the window server (not listed for 3 s)"
                )
        );
    }

    // ---- the pages say which window is shown (a real session's log, 2026-11-05 21:52-21:56) ----
    fn three_shown(lag: PageLag) -> World {
        let mut w = World::new();
        w.add(18278, SCREEN, false);
        w.add(18285, SCREEN, false);
        w.add(18342, SCREEN, false);
        w.show1(18285);
        w.put(A, 155, Some(SCREEN)).focused = true;
        w.put(B, 153, Some(SCREEN)).focused = true;
        w.put(C, 795, Some(SCREEN)).focused = true;
        w.truth = map(&[(k(A, 155), 18278), (k(B, 153), 18285), (k(C, 795), 18342)]);
        w.page_lag = lag;
        w
    }
    fn no_lag() -> PageLag {
        Box::new(|_, _| 0.0)
    }
    // A Space switch to window `n`: both on screen as macOS slides, then `n` alone; the Space change heard at the end.
    fn swipe(w: &mut World, to: i64, from: Option<i64>, slide: f64) {
        let also: Vec<i64> = from.into_iter().collect();
        w.show(Some(to), &also);
        w.read(0.033);
        w.run_every(slide, 0.033);
        w.show1(to);
        w.read(0.033);
        w.space_changed(0.0);
    }

    #[test]
    fn visible_relaunch() {
        let mut w = three_shown(no_lag());
        w.pages = true;
        w.run(0.75);
        assert!(w.numbers().is_empty(), "nothing bound in Margin.app's first second");
        w.run(1.0);
        assert!(w.numbers() == map(&[(k(B, 153), 18285)]) && w.wrong.is_empty(), "{}", w.said());
        assert!(w.said().contains("safari:B#153 is window 18285: visible: its page alone says it's shown (since "));
        assert!(
            w.said()
                .contains("window 18285 the only one on screen with its bounds (3 window(s) with them, all reported)")
        );
        for (n, from) in [(18342, 18285), (18278, 18342)] {
            swipe(&mut w, n, Some(from), 0.3);
            w.run_every(1.6, 0.1);
        }
        assert!(w.numbers() == w.truth && w.wrong.is_empty(), "{}", w.said());
        assert!(!w.said().contains("focus moved"), "no focus change needed");
    }

    #[test]
    fn visible_at_once_as_it_slides_in() {
        let mut w = three_shown(Box::new(|_, visible| if visible { 0.05 } else { 0.15 }));
        w.pages = true;
        w.run(3.0);
        let start = w.numbers();
        w.show(Some(18342), &[18285]);
        for step in 1..=12 {
            let dx = step as f64 * 120.0;
            w.mv(18342, SCREEN.offset_by(SCREEN.width - dx, 0.0));
            w.mv(18285, SCREEN.offset_by(-dx, 0.0));
            w.read(0.1);
        }
        let sliding = w.numbers().get(&k(C, 795)).copied();
        w.mv(18342, SCREEN);
        w.mv(18285, SCREEN);
        w.show1(18342);
        w.read(0.033);
        w.space_changed(0.0);
        w.run_every(1.0, 0.1);
        assert!(
            start == map(&[(k(B, 153), 18285)])
                && sliding == Some(18342)
                && w.wrong.is_empty()
                && w.said().contains("safari:C#795 is window 18342: visible at once: its page alone says it's shown"),
            "{start:?} {sliding:?} {:?}\n{}",
            w.wrong,
            w.said()
        );
        assert!(w.numbers() == w.truth && w.wrong.is_empty(), "and the last one by elimination");

        let b = k(B, 153);
        let mut v = three_shown(Box::new(move |key, visible| {
            if visible {
                0.05
            } else if *key == b {
                3.0
            } else {
                0.15
            }
        }));
        v.pages = true;
        v.run(3.0);
        v.show(Some(18342), &[18285]);
        v.run_every(0.3, 0.033);
        let early = v.numbers().get(&k(C, 795)).copied();
        v.show1(18342);
        v.read(0.033);
        v.space_changed(0.0);
        v.run_every(4.0, 0.1);
        assert!(early == Some(18342) && v.numbers() == v.truth && v.wrong.is_empty(), "{early:?}\n{}", v.said());
    }

    #[test]
    fn visible_fast_switches() {
        for seed in 1..=40u64 {
            let r = rng(seed * 7919);
            let lag = r.clone();
            let mut w = three_shown(Box::new(move |_, _| lag.borrow_mut().range(0.0, 0.6)));
            w.pages = true;
            w.run(2.0);
            let mut current = 18285;
            for _ in 0..10 {
                let others: Vec<i64> = [18278, 18285, 18342].into_iter().filter(|n| *n != current).collect();
                let next = others[(r.borrow_mut().next() % 2) as usize];
                let slide = r.borrow_mut().range(0.0, 0.4);
                swipe(&mut w, next, Some(current), slide);
                let rest = r.borrow_mut().range(0.05, 0.5);
                w.run_every(rest, 0.033);
                current = next;
            }
            let order: Vec<i64> =
                [18278, 18285, 18342].into_iter().filter(|n| *n != current).chain([current]).collect();
            for n in order {
                swipe(&mut w, n, Some(current), 0.3);
                current = n;
                w.run_every(2.0, 0.1);
            }
            assert!(
                w.wrong.is_empty() && w.numbers() == w.truth,
                "seed {seed}: {:?} {:?}\n{}",
                &w.wrong[..w.wrong.len().min(3)],
                w.numbers(),
                w.lines()[w.lines().len().saturating_sub(30)..].join("\n")
            );
        }
    }

    #[test]
    fn visible_nothing_said() {
        let mut w = three_shown(no_lag());
        w.run(10.0);
        assert!(w.numbers().is_empty() && w.wrong.is_empty(), "with no page saying, nothing bound");
        w.silent = [k(B, 153)].into_iter().collect();
        w.pages = true;
        w.run(3.0);
        assert!(w.numbers().is_empty() && w.wrong.is_empty(), "the shown window's page silent: nothing bound");
        assert!(
            w.said().contains("safari: window 18285 (on screen, 0,0 1512×982) not bound from its page: no page with its bounds says it's shown since Margin.app started"),
            "{}",
            w.said()
        );
        let mut s = three_shown(no_lag());
        s.silent = [k(A, 155)].into_iter().collect();
        s.pages = true;
        s.run(2.4);
        assert!(s.numbers().is_empty(), "one page off screen saying nothing: not while the pages may be settling");
        assert!(
            s.said().contains(
                "not bound from its page: safari:A#155 said nothing yet (the pages settling after the last change)"
            ),
            "{}",
            s.said()
        );
        s.run(1.2);
        assert!(s.numbers() == map(&[(k(B, 153), 18285)]) && s.wrong.is_empty(), "{}", s.said());
        assert!(
            s.said().contains("safari:B#153 is window 18285: visible: its page alone says it's shown (since ")
                && s.said().contains("; safari:A#155 said nothing, the others hidden"),
            "{}",
            s.said()
        );
    }

    // A real session's log, 2026-11-06 21:24:30-21:25:05: Safari reopened with five profiles, one full-screen window each.
    const FS: Rect = Rect::new(0.0, 33.0, 1512.0, 949.0);
    const D: &str = "safari:s-default";
    const P2: &str = "safari:s-4282";
    const P3: &str = "safari:s-defee";
    const P4: &str = "safari:s-27f6";
    const P5: &str = "safari:s-8d45";

    fn startup() -> World {
        let mut w = World::new();
        for n in [50775, 50782, 50790, 50798, 50802] {
            w.add(n, FS, false);
        }
        w.show1(50802);
        w.truth = map(&[
            (k(D, 85), 50775),
            (k(P2, 117), 50782),
            (k(P3, 167), 50790),
            (k(P4, 199), 50798),
            (k(P5, 140), 50802),
        ]);
        let t0 = w.t;
        w.space_changed(1.4);
        w.run(1.0);
        // The first two copies link (held for a read, then their state), each calling its own window focused.
        w.held = [P2.to_string()].into_iter().collect();
        w.read(0.05);
        w.held.clear();
        let e = w.put(P2, 117, Some(FS));
        e.focused = true;
        e.visible = Some(false);
        e.visible_at = Some(t0 - 1.4);
        w.held = [D.to_string()].into_iter().collect();
        w.read(0.1);
        w.held.clear();
        let e = w.put(D, 85, Some(FS));
        e.focused = true;
        e.focused_at = Some(t0 - 0.9);
        w.run(1.9);
        // A Space slide to s-default's window, Safari not in front: its page shown as the slide begins.
        w.in_front = false;
        w.show(Some(50775), &[50802]);
        w.read(0.03);
        let shown_at = w.t;
        w.run_every(0.1, 0.03);
        w.show1(50775);
        w.read(0.03);
        w.space_changed(0.0);
        w.run(2.4);
        w.say(&k(D, 85), Some(true), Some(shown_at)); // heard 3 s late
        w.in_front = true; // Safari to the front, over the Space already showing
        w.run(2.0);
        w.held = [P3.to_string()].into_iter().collect();
        w.read(0.05);
        w.held.clear();
        let e = w.put(P3, 167, Some(FS));
        e.focused_at = Some(t0 - 1.5);
        e.visible = Some(false);
        e.visible_at = Some(t0 - 1.5);
        e.blurred_at = Some(t0 - 1.5);
        w.run(2.7);
        // The last two: one hidden, one that never says.
        w.held = [P4.to_string(), P5.to_string()].into_iter().collect();
        w.read(0.05);
        w.held.clear();
        let e = w.put(P4, 199, Some(FS));
        e.focused_at = Some(t0 - 1.6);
        e.blurred_at = Some(t0 + 5.0);
        let e = w.put(P5, 140, Some(FS));
        e.focused = true;
        e.visible = Some(false);
        e.visible_at = Some(t0 - 1.4);
        w
    }

    #[test]
    fn startup_five_profiles() {
        let mut w = startup();
        let reported = w.t;
        w.run_every(0.6, 0.05);
        assert!(
            w.numbers() == map(&[(k(D, 85), 50775)]) && w.wrong.is_empty(),
            "bound within 0.6 s ({:.2}): {}",
            w.t - reported,
            w.said()
        );
        assert!(
            w.said().contains("safari:s-default#85 is window 50775: visible: its page alone says it's shown (since ")
                && w.said().contains("; safari:s-27f6#199 said nothing, the others hidden"),
            "{}",
            w.said()
        );
        w.pages = true;
        w.silent = [k(P4, 199)].into_iter().collect();
        w.page_lag = Box::new(|_, visible| if visible { 0.1 } else { 0.25 });
        let mut from = 50775;
        for (key, n, within) in
            [(k(P3, 167), 50790, 1.5), (k(P4, 199), 50798, 3.0), (k(P2, 117), 50782, 2.5), (k(P5, 140), 50802, 1.5)]
        {
            swipe(&mut w, n, Some(from), 0.3);
            from = n;
            let start = w.t;
            while !w.numbers().contains_key(&key) && w.t - start < 3.0 {
                w.read(0.05);
            }
            if key == k(P4, 199) {
                assert!(
                    !w.numbers().contains_key(&key) && w.wrong.is_empty(),
                    "the silent page's window shown: not bound"
                );
            } else {
                assert!(
                    w.numbers().get(&key) == Some(&n) && w.t - start <= within && w.wrong.is_empty(),
                    "{key}'s Space shown: bound by its page within {within} s ({:.2}): {}",
                    w.t - start,
                    w.lines()[w.lines().len().saturating_sub(12)..].join("\n")
                );
            }
            w.run_every(0.5, 0.05);
        }
    }

    #[test]
    fn startup_safari_to_the_front_at_various_times() {
        for seed in 1..=30u64 {
            let mut r = Seeded::new(seed * 15485863);
            let mut v = startup();
            if r.chance(0.5) {
                v.in_front = false;
                let s = r.range(0.0, 2.0);
                v.run(s);
                v.in_front = true;
            }
            v.run_every(1.5, 0.05);
            assert!(
                v.wrong.is_empty() && v.numbers() == map(&[(k(D, 85), 50775)]),
                "seed {seed}: {:?}\n{}",
                v.wrong,
                v.said()
            );
        }
        // The window on screen is the silent page's: nothing bound to it by the others' word.
        let mut q = startup();
        q.truth = map(&[
            (k(D, 85), 50798),
            (k(P2, 117), 50782),
            (k(P3, 167), 50790),
            (k(P4, 199), 50775),
            (k(P5, 140), 50802),
        ]);
        let at = q.t - 2.0;
        q.say(&k(D, 85), Some(false), Some(at));
        q.run(4.0);
        assert!(q.numbers().is_empty() && q.wrong.is_empty(), "{}", q.said());
        // A page newly shown as its free window slid away, its hidden word late, the new window's page silent.
        for late_by in [0.3, 0.9, 1.5] {
            let mut o = three_shown(Box::new(|_, _| 0.1));
            o.show1(18278);
            o.silent = [k(C, 795)].into_iter().collect();
            o.pages = true;
            o.run(1.25);
            o.pages = false;
            let free = o.numbers().is_empty();
            o.show(Some(18342), &[18278]);
            o.read(0.03);
            let t = o.t;
            o.say(&k(A, 155), Some(true), Some(t));
            o.run_every(0.2, 0.03);
            o.show1(18342);
            o.read(0.03);
            o.space_changed(0.0);
            let end = o.t;
            o.run_every(late_by, 0.05);
            o.say(&k(A, 155), Some(false), Some(end + 0.05));
            o.run_every(3.0, 0.05);
            assert!(
                free && o.wrong.is_empty() && o.numbers().get(&k(A, 155)) != Some(&18342),
                "slid away, {late_by} s late: {:?}\n{}",
                o.numbers(),
                o.said()
            );
        }
    }

    #[test]
    fn focus_moved_with_its_window_offset() {
        // A real session's log, 2026-11-06 21:25:20: no page can say, the focus change says which, but the window was offset
        // by a swipe begun when it was weighed: still bound by its settled bounds.
        let (d, p2, p3) = ("safari:s-default", "safari:s-4282", "safari:s-defee");
        let mut w = World::new();
        for n in [50775, 50782, 50802] {
            w.add(n, FS, false);
        }
        w.in_front = false;
        w.show1(50782);
        w.put(d, 828, Some(FS)).focused = true;
        w.put(p2, 825, Some(FS)).focused = true;
        w.put(p3, 842, Some(FS)).focused = true;
        w.truth = map(&[(k(d, 828), 50775), (k(p2, 825), 50782), (k(p3, 842), 50802)]);
        w.run(3.0);
        w.show1(50775);
        w.in_front = true;
        w.read(0.05);
        w.space_changed(0.0);
        let at = w.t + 0.02;
        w.focus(&k(d, 828), Some(at));
        w.run_every(1.6, 0.1);
        w.mv(50775, FS.offset_by(3115.0, 0.0));
        w.show(Some(50802), &[50775]);
        w.run_every(0.8, 0.1);
        assert!(w.numbers().get(&k(d, 828)) == Some(&50775) && w.wrong.is_empty(), "{}", w.said());
    }

    #[test]
    fn visible_a_private_window() {
        for seed in 1..=40u64 {
            let r = rng(seed * 104729);
            let slow_hide = Rc::new(Cell::new(false));
            let (lag, slow) = (r.clone(), slow_hide.clone());
            let mut w = three_shown(Box::new(move |_, visible| {
                let mut r = lag.borrow_mut();
                if visible {
                    r.range(0.0, 0.6)
                } else if slow.get() {
                    r.range(0.0, 3.0)
                } else {
                    r.range(0.0, 0.6)
                }
            }));
            w.add(900, SCREEN, false); // the Private window
            w.pages = true;
            w.run(2.0);
            let mut current = 18285;
            for _ in 0..8 {
                let next = if r.borrow_mut().chance(0.5) {
                    900
                } else {
                    let others: Vec<i64> = [18278, 18285, 18342].into_iter().filter(|n| *n != current).collect();
                    others[(r.borrow_mut().next() % 2) as usize]
                };
                slow_hide.set(next == 900);
                let slide = r.borrow_mut().range(0.0, 0.4);
                swipe(&mut w, next, Some(current), slide);
                let rest = r.borrow_mut().range(0.2, 3.5);
                w.run_every(rest, 0.05);
                current = next;
            }
            slow_hide.set(false);
            w.run_every(1.5, 0.1);
            // (The window in front last: one already in front doesn't come forward.)
            let in_front_now = w.front();
            let mut order: Vec<(WindowKey, i64)> = w.truth.clone().into_iter().collect();
            order.sort_by_key(|(key, n)| (Some(*n) == in_front_now, key.clone()));
            for (key, n) in order {
                w.show1(n);
                w.read(0.05);
                w.space_changed(0.0);
                let at = w.t - 0.03;
                w.focus(&key, Some(at));
                w.run_every(2.5, 0.1);
            }
            assert!(
                w.wrong.is_empty() && !w.numbers().values().any(|n| *n == 900) && w.numbers() == w.truth,
                "seed {seed}: {:?} {:?}\n{}",
                &w.wrong[..w.wrong.len().min(3)],
                w.numbers(),
                w.lines()[w.lines().len().saturating_sub(30)..].join("\n")
            );
        }
        let mut w = three_shown(no_lag());
        w.add(900, SCREEN, false);
        w.pages = true;
        w.run(2.0);
        swipe(&mut w, 900, Some(18285), 0.3);
        w.run(4.0);
        assert!(
            !w.numbers().values().any(|n| *n == 900)
                && w.said().contains("safari: window 900 (on screen, 0,0 1512×982) not bound from its page: 4 window(s) have its bounds, 3 reported (a Private window, or a profile without Margin?)"),
            "{}",
            w.said()
        );
    }

    #[test]
    fn visible_one_transition() {
        // The front window and the Space change seen in one read: one transition, from the read before.
        let c = k(C, 795);
        let lag = move |key: &WindowKey, visible: bool| if *key == c && visible { 0.1 } else { 0.05 };
        let mut w = three_shown(no_lag());
        w.pages = true;
        w.run(2.0);
        assert_eq!(w.numbers(), map(&[(k(B, 153), 18285)]), "set up: {}", w.said());
        w.page_lag = Box::new(lag.clone());
        w.show1(18342);
        w.space_changed(-0.2); // heard before the read that first sees the new front window
        w.read(0.25);
        w.run_every(1.5, 0.1);
        assert!(w.numbers().get(&k(C, 795)) == Some(&18342) && w.wrong.is_empty(), "{}", w.said());
        // A front change first seen after reads that told nothing, the Space change heard among them.
        let mut v = three_shown(no_lag());
        v.pages = true;
        v.run(2.0);
        v.page_lag = Box::new(lag);
        v.show1(18342);
        v.collapse = true;
        v.read(0.1);
        v.space_changed(0.0);
        v.read(0.05);
        v.collapse = false;
        v.read(0.1);
        v.run_every(1.5, 0.1);
        assert!(v.numbers().get(&k(C, 795)) == Some(&18342) && v.wrong.is_empty(), "{}", v.said());
    }

    #[test]
    fn visible_one_page_silent_with_focus_changes() {
        let mut w = three_shown(no_lag());
        w.silent = [k(A, 155)].into_iter().collect();
        w.pages = true;
        w.run(2.0);
        for (key, n) in [(k(C, 795), 18342), (k(B, 153), 18285)] {
            w.show1(n);
            w.read(0.05);
            w.space_changed(0.0);
            let at = w.t - 0.03;
            w.focus(&key, Some(at));
            w.run_every(2.5, 0.1);
        }
        assert!(
            w.numbers().get(&k(C, 795)) == Some(&18342)
                && w.numbers().get(&k(B, 153)) == Some(&18285)
                && w.wrong.is_empty(),
            "{}",
            w.said()
        );
        let mut p = three_shown(no_lag());
        p.add(900, SCREEN, false);
        p.pages = true;
        p.run(2.0);
        for (key, n) in [(k(C, 795), 18342), (k(B, 153), 18285), (k(A, 155), 18278)] {
            p.show1(n);
            p.read(0.05);
            p.space_changed(0.0);
            let at = p.t - 0.03;
            p.focus(&key, Some(at));
            p.run_every(2.5, 0.1);
        }
        assert!(p.numbers() == p.truth && p.wrong.is_empty(), "{}", p.said());
    }

    #[test]
    fn copies_away() {
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.add(300, SECOND, false);
        w.put(A, 1, Some(SCREEN));
        w.put(C, 3, Some(SECOND));
        w.truth = map(&[(k(A, 1), 100), (k(C, 3), 300)]);
        w.in_front = false; // no page or focus rule: elimination alone
        w.run(1.0);
        assert_eq!(w.numbers(), w.truth, "set up: {}", w.said());
        w.ext.remove(C);
        w.remove(300);
        w.close(A, 1);
        w.remove(100);
        w.run(1.0);
        w.add(101, SCREEN, true);
        w.put(A, 2, Some(SCREEN));
        w.truth = map(&[(k(A, 2), 101)]);
        w.run(1.0);
        assert!(w.numbers().is_empty(), "a copy just gone: a new full-screen window waits");
        w.run(Timing::default().away);
        assert!(w.numbers() == w.truth && w.wrong.is_empty(), "a copy gone for good: bound: {}", w.said());

        let mut q = World::new();
        q.add(100, SCREEN, true);
        q.add(200, SECOND, false);
        q.put(A, 1, Some(SCREEN));
        q.put(B, 2, Some(SECOND));
        q.run(1.0);
        q.ext.clear();
        q.server.clear();
        q.pids.clear();
        q.run(1.0);
        q.pids = [2].into_iter().collect();
        q.add_window(101, SCREEN, true, 2, 0, 1.0);
        q.put(A, 5, Some(SCREEN));
        q.truth = map(&[(k(A, 5), 101)]);
        q.run(0.5);
        assert!(q.numbers() == q.truth && q.wrong.is_empty(), "Safari quit and opened again: {}", q.said());
    }

    #[test]
    fn hidden_drops_a_contradicted_binding() {
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(200, SCREEN, false);
        w.show1(100);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(B, 2, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(B, 2), 200)]);
        w.pages = true;
        w.run(3.0);
        assert_eq!(w.numbers(), w.truth, "set up (bound by the pages)");
        w.truth = map(&[(k(A, 1), 200), (k(B, 2), 100)]); // wrong all along
        w.wrong.clear();
        w.run(1.9);
        assert_eq!(w.numbers().get(&k(A, 1)), Some(&100), "kept under 2 s");
        w.run(0.5);
        let said = w.said();
        assert!(
            said.contains("safari:A#1 is no longer window 100: its page has said it's hidden since")
                && said.contains("and safari:B#2's page says it's shown (since")
                && said.contains("safari:B#2 is no longer window 200: its page says it's shown (since"),
            "{said}"
        );
        w.wrong.clear();
        w.run(1.0);
        assert!(w.numbers() == w.truth && w.wrong.is_empty(), "{}", w.said());
        let lines = w.lines();
        let after: Vec<&String> =
            lines.iter().skip_while(|l| !l.contains("safari:A#1 is no longer window 100")).collect();
        assert!(
            !after
                .iter()
                .any(|l| l.starts_with("safari:A#1 is window 100") || l.starts_with("safari:B#2 is window 200"))
                && after.iter().any(|l| l.starts_with("safari:B#2 is window 100: visible"))
                && after.iter().any(|l| l.starts_with("safari:A#1 is window 200: the only free window")),
            "{after:?}"
        );
        // Pages that say nothing never drop a binding.
        let mut q = World::new();
        q.add(100, SCREEN, false);
        q.add(200, SCREEN, false);
        q.show1(100);
        q.put(A, 1, Some(SCREEN)).focused = true;
        q.put(B, 2, Some(SCREEN));
        q.truth = map(&[(k(A, 1), 100), (k(B, 2), 200)]);
        q.pages = true;
        q.run(3.0);
        q.pages = false;
        q.say(&k(A, 1), None, None);
        q.say(&k(B, 2), None, None);
        q.run(5.0);
        assert!(q.numbers() == q.truth && !q.said().contains("no longer"));
    }

    #[test]
    fn moved_and_elimination_with_unreported_windows() {
        for offset_for in [2.5, 5.0] {
            let mut w = World::new();
            w.add(101, SCREEN, false);
            w.add(102, SCREEN, false);
            w.show1(101);
            w.put(A, 1, Some(SCREEN));
            w.truth = map(&[(k(A, 1), 101)]);
            w.show1(102);
            w.run(2.0);
            w.show_and_focus(101, &k(A, 1));
            assert_eq!(w.numbers(), w.truth, "set up: {}", w.said());
            w.mv(101, SCREEN.offset_by(300.0, 0.0));
            w.show(Some(101), &[102]);
            w.run(offset_for);
            w.mv(101, SCREEN);
            w.show1(101);
            w.run(3.0);
            assert!(w.numbers() == w.truth && w.wrong.is_empty() && !w.said().contains("(was "), "{}", w.said());
        }
        // Elimination with a copy held and a read missing a window: never wrong.
        let mut w = World::new();
        w.add(100, SCREEN, false);
        w.add(200, SCREEN, false);
        w.show1(200);
        w.put(A, 1, Some(SCREEN));
        w.put(B, 2, Some(SCREEN));
        w.truth = map(&[(k(A, 1), 100), (k(B, 2), 200)]);
        w.blipped = set_of(&[100]);
        w.read0();
        w.ext.remove(B);
        w.held = [B.to_string()].into_iter().collect();
        w.run(4.0);
        assert!(w.wrong.is_empty() && w.numbers().is_empty(), "{}", w.said());
        w.held.clear();
        w.run(2.0);
        assert!(w.wrong.is_empty() && w.numbers().is_empty(), "B's copy seen and not reporting: still not");
        w.blipped.clear();
        w.put(B, 2, Some(SCREEN));
        w.run(1.0);
        assert!(w.wrong.is_empty(), "{:?}", w.numbers());
        let mut one = World::new();
        one.add(100, LEFT, true);
        one.put(A, 1, Some(LEFT)).state = "normal".into();
        one.add(200, SCREEN, false);
        one.put(B, 2, Some(SCREEN));
        one.held = [C.to_string()].into_iter().collect();
        assert_eq!(one.read0(), map(&[(k(A, 1), 100)]), "a normal window with bounds of its own, a link held or not");
        one.held.clear();
        assert_eq!(one.read0(), map(&[(k(A, 1), 100), (k(B, 2), 200)]), "the full-screen one with none held");
    }

    #[test]
    fn what_the_log_says() {
        let mut w = three_shown(no_lag());
        w.run(2.0);
        assert!(
            w.count("settled focus can't bind") == 1
                && w.said().contains("safari: settled focus can't bind window 18285: the windows with its bounds are 3 copies' (safari:A, safari:B, safari:C)"),
            "{}",
            w.said()
        );
        let before = w.lines().len();
        w.show1(18342);
        w.read(0.05);
        w.show1(18278);
        w.read(0.05);
        w.show1(18342);
        w.read(0.05);
        let at = w.t - 0.02;
        w.focus(&k(C, 795), Some(at));
        w.run_every(2.4, 0.1);
        let new: Vec<String> = w.lines()[before..].to_vec();
        let fronts: Vec<&String> = new.iter().filter(|l| l.starts_with("safari: the front window: ")).collect();
        assert!(
            fronts.len() == 2
                && new.iter().any(|l| l.starts_with("safari: the front window: 18342 at "))
                && new.iter().any(|l| l.contains("18278 at ") && l.contains(", 18342 at ")),
            "{}",
            new.join("\n")
        );
        assert!(
            new.iter().any(|l| l.starts_with("safari:C#795: focus heard at ")
                && l.contains("not used: near count 3 (front changes within 1 s: 18342, 18278, 18342)")),
            "{}",
            new.join("\n")
        );
        w.in_front = false;
        w.read(0.05);
        w.in_front = true;
        w.read(0.05);
        assert!(w.said().contains(": none at "), "{}", w.said());
    }

    #[test]
    fn front_blips_after_a_focus_change() {
        let mut w = three_shown(no_lag());
        w.run(2.0);
        w.show1(18342);
        w.read(0.05);
        let at = w.t - 0.02;
        w.focus(&k(C, 795), Some(at));
        w.read(0.1);
        w.in_front = false;
        w.read(0.1);
        w.read(0.1);
        w.in_front = true;
        w.read(0.1);
        w.run_every(2.2, 0.1);
        assert!(
            w.numbers() == map(&[(k(C, 795), 18342)]) && w.wrong.is_empty(),
            "a 0.2 s blip doesn't count: {}",
            w.said()
        );
        let mut l = three_shown(no_lag());
        l.run(2.0);
        l.show1(18342);
        l.read(0.05);
        let at = l.t - 0.02;
        l.focus(&k(C, 795), Some(at));
        l.read(0.1);
        l.in_front = false;
        l.run_every(0.6, 0.1);
        l.in_front = true;
        l.read(0.1);
        l.run_every(2.2, 0.1);
        assert!(l.numbers().is_empty(), "no front window for 0.6 s after it: not used: {:?}", l.numbers());
    }

    // ---- randomized: the pages' word, lagging, missing, a Private window, Space changes heard late ----
    #[test]
    fn randomized_pages() {
        // (The Swift's 1000 runs; 250 in a debug build, for speed: VISIBLE_RUNS=1000 for all of them.)
        let runs = env_runs("VISIBLE_RUNS", if cfg!(debug_assertions) { 250 } else { 1000 });
        let (mut wrong_runs, mut unbound_runs) = (0, 0);
        let (mut first_wrong, mut first_unbound) = (String::new(), String::new());
        let (mut by_pages, mut by_focus) = (0, 0);
        for seed in seeds(runs) {
            let r = rng(seed.wrapping_mul(0x9E37_79B9).wrapping_add(17));
            let mut w = World::new();
            let fs = [(k(A, 1), 101), (k(A, 2), 102), (k(B, 1), 201), (k(C, 1), 301)];
            for (_, n) in &fs {
                w.add(*n, SCREEN, false);
            }
            let private_window = r.borrow_mut().chance(0.4);
            if private_window {
                w.add(900, SCREEN, false);
            }
            w.add(207, LEFT, false);
            for (key, _) in &fs {
                w.put(&key.link, key.window_id, Some(SCREEN)).focused = true;
            }
            w.put(B, 7, Some(LEFT)).state = "normal".into();
            w.truth = fs.iter().cloned().chain([(k(B, 7), 207)]).collect();
            for (key, _) in &fs {
                if r.borrow_mut().chance(0.15) {
                    w.silent.insert(key.clone());
                }
            }
            let slow_hide = Rc::new(Cell::new(false));
            let (lag, slow) = (r.clone(), slow_hide.clone());
            w.page_lag = Box::new(move |_, visible| {
                let mut r = lag.borrow_mut();
                if !visible && slow.get() { r.range(0.0, 3.0) } else { r.range(0.0, 0.6) }
            });
            let mut targets: Vec<i64> = fs.iter().map(|f| f.1).collect();
            if private_window {
                targets.extend([900, 900]);
            }
            let mut current = r.borrow_mut().pick(&targets);
            w.show1(current);
            w.pages = true;
            let mut due: Due = Vec::new();
            let mut blip_reads: BTreeMap<i64, (i64, i64)> = BTreeMap::new();
            let mut collapse: Option<(f64, f64)> = None;
            if r.borrow_mut().chance(0.5) {
                let s = r.borrow_mut().range(0.0, 3.0);
                w.run(s);
            }
            for _ in 0..20 {
                let rest: Vec<i64> = targets.iter().copied().filter(|n| *n != current).collect();
                let next = r.borrow_mut().pick(&rest);
                let swipe = r.borrow_mut().range(0.0, 0.5);
                let start = w.t;
                if r.borrow_mut().chance(0.4) {
                    let mut all = targets.clone();
                    all.push(207);
                    let mut rr = r.borrow_mut();
                    let n = rr.pick(&all);
                    let after = (rr.next() % 6) as i64;
                    let reads = 1 + (rr.next() % 15) as i64;
                    blip_reads.insert(n, (after, reads));
                }
                if r.borrow_mut().chance(0.4) {
                    let mut rr = r.borrow_mut();
                    let from = start + rr.range(-0.1, 0.4);
                    collapse = Some((from, from + rr.range(0.2, 1.1)));
                }
                if swipe > 0.05 {
                    w.show(Some(next), &[current])
                } else {
                    w.show(Some(next), &[])
                }
                let slow = next == 900 && r.borrow_mut().chance(0.6);
                slow_hide.set(slow);
                if swipe > 0.05 {
                    let seq = due.len();
                    due.push((start + swipe, seq, Box::new(move |w: &mut World| w.show1(next))));
                }
                let at = start + r.borrow_mut().range(-0.1, 0.8);
                let seq = due.len();
                due.push((at, seq, Box::new(|w: &mut World| w.space_changed(0.0))));
                if r.borrow_mut().chance(0.15) {
                    let a = start + r.borrow_mut().range(0.0, 1.0);
                    let seq = due.len();
                    due.push((a, seq, Box::new(|w: &mut World| w.in_front = false)));
                    let b = start + r.borrow_mut().range(1.0, 1.5);
                    let seq = due.len();
                    due.push((b, seq, Box::new(|w: &mut World| w.in_front = true)));
                }
                if r.borrow_mut().chance(0.2) {
                    let key = r.borrow_mut().pick(&fs).0;
                    let at = start + r.borrow_mut().range(0.0, 2.0);
                    let rr = r.clone();
                    let seq = due.len();
                    due.push((
                        at,
                        seq,
                        Box::new(move |w: &mut World| {
                            let after = rr.borrow_mut().range(0.05, 0.6);
                            w.forget(&key, after)
                        }),
                    ));
                }
                let mut left = r.borrow_mut().range(0.1, 3.0);
                while left > 0.0 {
                    let dt = r.borrow_mut().pick(&[0.033, 0.033, 0.1, 0.25]);
                    left -= dt;
                    let at = w.t + dt;
                    due.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                    while due.first().is_some_and(|d| d.0 <= at) {
                        let (_, _, f) = due.remove(0);
                        f(&mut w);
                    }
                    w.blipped = blip_reads.iter().filter(|(_, v)| v.0 == 0 && v.1 > 0).map(|(n, _)| *n).collect();
                    w.collapse = collapse.is_some_and(|(from, until)| at >= from && at < until);
                    w.no_list = w.collapse && r.borrow_mut().chance(0.25);
                    w.read(dt);
                    blip_reads = blip_reads
                        .into_iter()
                        .map(
                            |(n, (after, reads))| if after > 0 { (n, (after - 1, reads)) } else { (n, (0, reads - 1)) },
                        )
                        .filter(|(_, v)| v.1 > 0)
                        .collect();
                }
                current = next;
            }
            due.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            for (_, _, f) in due {
                f(&mut w);
            }
            w.in_front = true;
            w.blipped.clear();
            w.collapse = false;
            w.no_list = false;
            slow_hide.set(false);
            // Then each window shown in turn, calmly, its Space change heard; with a silent page or a Private window,
            // each with its focus change too.
            let pages_alone = !private_window && w.silent.is_empty();
            w.run_every(1.5, 0.1);
            let in_front_now = w.front();
            let order: Vec<(WindowKey, i64)> = fs
                .iter()
                .filter(|f| Some(f.1) != in_front_now)
                .chain(fs.iter().filter(|f| Some(f.1) == in_front_now))
                .cloned()
                .collect();
            for (key, n) in order {
                w.show1(n);
                w.read(0.05);
                w.space_changed(0.0);
                if !pages_alone {
                    let at = w.t - 0.03;
                    w.focus(&key, Some(at));
                }
                w.run_every(2.5, 0.1);
            }
            if pages_alone {
                by_pages += 1
            } else {
                by_focus += 1
            }
            if fs.iter().any(|(key, n)| w.numbers().get(key) != Some(n)) {
                unbound_runs += 1;
                if first_unbound.is_empty() {
                    first_unbound = format!("seed {seed}: {:?}\n{}", w.numbers(), tail(&w, 25));
                }
            }
            if !w.wrong.is_empty() {
                wrong_runs += 1;
                if first_wrong.is_empty() {
                    first_wrong = format!("seed {seed}: {}\n{}", w.wrong[0], tail(&w, 25));
                }
            }
        }
        assert_eq!(wrong_runs, 0, "never bound wrong: {first_wrong}");
        assert_eq!(unbound_runs, 0, "every full-screen window bound once each was shown calmly: {first_unbound}");
        assert!(runs < 50 || (by_pages > 0 && by_focus > 0));
    }

    // ---- randomized: Space switches among several windows, flags lagging and disagreeing ----
    #[test]
    fn randomized_switches() {
        let lag = std::env::var("WINDOW_LAG").ok().and_then(|v| v.parse().ok()).unwrap_or(1.2);
        let runs = env_runs("WINDOW_RUNS", 300);
        for blips in [false, true] {
            let (mut wrong_runs, mut unbound_runs, mut blip_drops) = (0, 0, 0);
            let (mut first_wrong, mut first_drop) = (String::new(), String::new());
            for seed in seeds(runs) {
                let mut r = Seeded::new(seed);
                let mut w = World::new();
                // A: two full-screen windows; B: one full-screen, one windowed on the desktop.
                let fs = [(k(A, 1), 101), (k(A, 2), 102), (k(B, 1), 201)];
                let desk = (k(B, 7), 207);
                for (_, n) in &fs {
                    w.add(*n, SCREEN, false);
                }
                w.add(desk.1, LEFT, false);
                for (key, _) in &fs {
                    w.put(&key.link, key.window_id, Some(SCREEN));
                }
                w.put(B, 7, Some(LEFT)).state = "normal".into();
                w.truth = fs.iter().cloned().chain([desk.clone()]).collect();
                let per_profile = r.chance(0.5); // each profile's last focused, or only the key window
                let mut current = r.pick(&fs);
                w.show1(current.1);
                let at = w.t - 5.0;
                w.focus(&current.0, Some(at));
                if !per_profile {
                    for (key, _) in &fs {
                        if key.link != current.0.link {
                            w.set(key, |e| e.focused = false);
                        }
                    }
                }
                if r.chance(0.5) {
                    w.run(6.0); // bound before the switches start, or from nothing during them
                }
                let mut due: Due = Vec::new();
                let mut last_report: BTreeMap<String, f64> = BTreeMap::new();
                let seq_base = 1000 * seed as usize;
                let mut blip_reads: BTreeMap<i64, (i64, i64)> = BTreeMap::new();
                let mut collapse: Option<(f64, f64)> = None;
                for _ in 0..12 {
                    let rest: Vec<(WindowKey, i64)> = fs.iter().filter(|f| f.0 != current.0).cloned().collect();
                    let next = r.pick(&rest);
                    let swipe = r.range(0.0, 0.5);
                    let start = w.t;
                    if blips && r.chance(0.5) {
                        let all: Vec<i64> = fs.iter().map(|f| f.1).chain([desk.1]).collect();
                        let n = r.pick(&all);
                        let after = (r.next() % 6) as i64;
                        let reads = 1 + (r.next() % 15) as i64;
                        blip_reads.insert(n, (after, reads));
                    }
                    if blips && r.chance(0.5) {
                        let from = start + r.range(-0.1, 0.4);
                        collapse = Some((from, from + r.range(0.2, 1.1)));
                    }
                    if swipe > 0.05 {
                        w.show(Some(next.1), &[current.1])
                    } else {
                        w.show(Some(next.1), &[])
                    }
                    let heard = start + r.range(0.0, 0.35);
                    let (lag_target, lag_others) = (r.range(0.0, lag), r.range(0.0, lag));
                    let target = next.0.clone();
                    // One copy's reports come in the order it sent them.
                    let mut report = |due: &mut Due, link: &str, at: f64, f: Box<dyn FnOnce(&mut World)>| {
                        let when = at.max(last_report.get(link).copied().unwrap_or(0.0));
                        last_report.insert(link.to_string(), when);
                        let seq = due.len() + seq_base;
                        due.push((when, seq, f));
                    };
                    let tk = target.clone();
                    report(&mut due, &target.link, heard + lag_target, Box::new(move |w| w.focus(&tk, Some(heard))));
                    if !per_profile {
                        for link in [A, B] {
                            if link != target.link {
                                report(&mut due, link, start + lag_others, Box::new(move |w| w.flags(link, None)));
                            }
                        }
                    }
                    if swipe > 0.05 {
                        let n = next.1;
                        let seq = due.len() + seq_base;
                        due.push((start + swipe, seq, Box::new(move |w| w.show1(n))));
                    }
                    if r.chance(0.15) {
                        let a = start + r.range(0.0, 1.0);
                        let seq = due.len() + seq_base;
                        due.push((a, seq, Box::new(|w| w.in_front = false)));
                        let b = start + r.range(1.0, 1.5);
                        let seq = due.len() + seq_base;
                        due.push((b, seq, Box::new(|w| w.in_front = true)));
                    }
                    let mut left = r.range(0.2, 3.0);
                    while left > 0.0 {
                        let dt = r.pick(&[0.033, 0.033, 0.1, 0.25]);
                        left -= dt;
                        let at = w.t + dt;
                        due.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                        while due.first().is_some_and(|d| d.0 <= at) {
                            let (_, _, f) = due.remove(0);
                            f(&mut w);
                        }
                        w.blipped = blip_reads.iter().filter(|(_, v)| v.0 == 0 && v.1 > 0).map(|(n, _)| *n).collect();
                        w.collapse = collapse.is_some_and(|(from, until)| at >= from && at < until);
                        w.no_list = w.collapse && r.chance(0.25);
                        w.read(dt);
                        blip_reads = blip_reads
                            .into_iter()
                            .map(
                                |(n, (after, reads))| {
                                    if after > 0 { (n, (after - 1, reads)) } else { (n, (0, reads - 1)) }
                                },
                            )
                            .filter(|(_, v)| v.1 > 0)
                            .collect();
                    }
                    current = next;
                }
                due.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                for (_, _, f) in due {
                    f(&mut w);
                }
                w.in_front = true;
                w.blipped.clear();
                w.collapse = false;
                w.no_list = false;
                // Then each full-screen window shown in turn, cleanly: every one should end up bound.
                for (key, n) in &fs {
                    w.show1(*n);
                    w.read(0.05);
                    let at = w.t - 0.03;
                    w.focus(key, Some(at));
                    if !per_profile {
                        for link in [A, B] {
                            if link != key.link {
                                w.flags(link, None);
                            }
                        }
                    }
                    w.run_every(2.4, 0.1);
                }
                if !w.wrong.is_empty() {
                    wrong_runs += 1;
                    if first_wrong.is_empty() {
                        first_wrong = format!("seed {seed}: {}\n{}", w.wrong[0], tail(&w, 12));
                    }
                }
                if w.numbers() != w.truth {
                    unbound_runs += 1;
                }
                // A binding goes for the window server only after 3 s without its window, measured from the reads.
                if !w.early_drops.is_empty() {
                    blip_drops += 1;
                    if first_drop.is_empty() {
                        first_drop = format!("seed {seed}: {}", w.early_drops[0]);
                    }
                }
            }
            assert_eq!(wrong_runs, 0, "blips {blips}: never bound wrong: {first_wrong}");
            assert_eq!(unbound_runs, 0, "blips {blips}: every window bound once each was shown cleanly");
            assert_eq!(
                blip_drops, 0,
                "blips {blips}: no binding dropped for a window missing less than 3 s: {first_drop}"
            );
        }
    }

    // ---- parked windows (HANDOFF.md §2.2) and the made-by-Margin rule with the answer's bounds (§1.6) ----
    fn parked_world() -> World {
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.add(200, LEFT, false);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(B, 2, Some(LEFT)).state = "normal".into();
        w.truth = map(&[(k(A, 1), 100), (k(B, 2), 200)]);
        w.run(1.0);
        w.parked = set_of(&[200]);
        w.remove(200);
        w
    }

    #[test]
    fn parked_kept_while_missing() {
        let mut w = parked_world();
        assert_eq!(w.numbers(), w.truth, "both bound before the park: {}", w.said());
        w.run(10.0);
        assert!(w.numbers() == w.truth && w.wrong.is_empty(), "missing 10 s, kept");
        assert!(w.binder.absent_numbers().is_empty(), "not counted as a blip");
        assert!(
            w.count("kept while parked") == 1
                && w.said().contains("safari:B#2: window 200 kept while parked: not listed by the window server")
                && !w.said().contains("missing from one read"),
            "{}",
            w.said()
        );
        w.add(200, LEFT, false);
        w.run(5.0);
        assert!(w.numbers() == w.truth && w.count("window 200 kept while parked: off screen") == 1, "{}", w.said());
        let b = w.ext.remove(B);
        w.run(3.0);
        assert!(
            w.numbers() == w.truth
                && w.said().contains("safari:B#2: window 200 kept while parked: its copy isn't linked")
        );
        if let Some(b) = b {
            w.ext.insert(B.into(), b);
        }
        w.run(1.0);
        assert!(w.numbers() == w.truth && !w.said().contains("no longer"), "{}", w.said());
        // The same window not parked, for contrast: dropped after 3 s missing.
        let mut w = parked_world();
        w.parked.clear();
        w.run(4.0);
        assert!(
            w.numbers() == map(&[(k(A, 1), 100)])
                && w.said().contains(
                    "safari:B#2 is no longer window 200: window 200 is gone from the window server (not listed for 3 s)"
                ),
            "{}",
            w.said()
        );
    }

    #[test]
    fn parked_dropped_and_expected() {
        let mut w = parked_world();
        w.run(1.0);
        w.close(B, 2);
        w.read0();
        assert!(
            w.numbers() == map(&[(k(A, 1), 100)])
                && w.said()
                    .contains("safari:B#2 is no longer window 200: closed in the browser (window 200 was parked)")
        );
        let mut w = parked_world();
        w.run(1.0);
        w.server.clear();
        w.pids.clear();
        w.read0();
        assert!(
            w.numbers().is_empty()
                && w.said().contains(
                    "safari:B#2 is no longer window 200: window 200, parked, is gone (the browser isn't running)"
                )
        );
        let mut w = parked_world();
        w.run(1.0);
        w.copies.insert(B.into(), "copy-B-2".into());
        w.close(B, 2);
        w.put(B, 5, Some(LEFT)).state = "normal".into();
        w.truth.insert(k(B, 5), 200);
        w.truth.remove(&k(B, 2));
        w.read0();
        assert!(
            w.numbers() == map(&[(k(A, 1), 100)])
                && w.said().contains("safari:B#2 is no longer window 200: a new copy of Margin started"),
            "{}",
            w.said()
        );
        w.add(200, LEFT, true);
        w.show(Some(200), &[100]);
        w.pages = true;
        let t = w.t;
        w.set(&k(B, 5), |e| {
            e.focused = true;
            e.focused_at = Some(t)
        });
        w.run(8.0);
        assert!(w.numbers() == map(&[(k(A, 1), 100)]) && w.wrong.is_empty(), "no rule binds it: {}", w.said());
        assert!(!w.binder.front_changes().contains(&Some(200)), "never the front window");
        w.binder.expect_parked_all(&map(&[(k(B, 5), 200)]), "the parking registry rebound it after a new copy");
        let at = w.t;
        w.read0();
        assert!(
            w.numbers() == map(&[(k(A, 1), 100), (k(B, 5), 200)])
                && w.wrong.is_empty()
                && w.said()
                    .contains("safari:B#5 is window 200: parked: the parking registry rebound it after a new copy"),
            "{}",
            w.said()
        );
        assert!(w.binder.bindings().get(&k(B, 5)).is_some_and(|b| b.at == w.t) && w.t > at);
        w.remove(200);
        w.run(5.0);
        assert_eq!(w.numbers().get(&k(B, 5)), Some(&200), "then kept as any parked binding");
    }

    #[test]
    fn expect_parked_refusals() {
        let mut w = parked_world();
        w.run(1.0);
        w.binder.expect_parked(k(B, 9), 200, "test");
        w.read0();
        assert!(
            !w.numbers().contains_key(&k(B, 9))
                && w.said().contains("safari:B#9: parked window 200 (test) not bound: its copy doesn't list it"),
            "{}",
            w.said()
        );
        w.put(B, 6, Some(RIGHT)).state = "normal".into();
        w.binder.expect_parked(k(B, 6), 200, "test");
        w.run(6.0);
        assert!(
            !w.numbers().contains_key(&k(B, 6))
                && w.numbers().get(&k(B, 2)) == Some(&200)
                && w.said()
                    .contains("safari:B#6: parked window 200 (test) not bound in 5 s: window 200 is safari:B#2's"),
            "{}",
            w.said()
        );
        w.close(B, 2);
        w.read0();
        w.binder.expect_parked(k(B, 6), 200, "test");
        w.read0();
        assert!(
            !w.numbers().contains_key(&k(B, 6))
                && w.said().contains("safari:B#6: parked window 200 (test) not bound: it's a closed window's"),
            "{}",
            w.said()
        );
    }

    #[test]
    fn parked_and_the_read_that_tells_nothing() {
        let mut w = parked_world();
        w.add(200, LEFT, false);
        w.run(1.0);
        w.blipped = set_of(&[100]);
        w.read0();
        assert!(
            w.binder.last_read_collapsed()
                && w.said().contains("a read of the window server without the browser's windows")
        );
        w.blipped.clear();
        w.read0();
        assert!(!w.binder.last_read_collapsed() && w.numbers() == w.truth);
        w.add(300, RIGHT, false);
        w.run(1.0);
        w.remove(200);
        w.put(A, 3, Some(RIGHT)).state = "normal".into();
        w.truth.insert(k(A, 3), 300);
        w.read0();
        assert!(w.numbers().get(&k(A, 3)) == Some(&300) && !w.binder.last_read_collapsed(), "{}", w.said());

        let mut w = World::new();
        w.add(200, LEFT, false);
        w.put(B, 2, Some(LEFT)).state = "normal".into();
        w.truth = map(&[(k(B, 2), 200)]);
        w.run(1.0);
        w.parked = set_of(&[200]);
        w.remove(200);
        w.read0();
        assert!(
            !w.binder.last_read_collapsed()
                && w.numbers() == w.truth
                && !w.said().contains("without the browser's windows"),
            "{}",
            w.said()
        );
    }

    #[test]
    fn parked_left_out_of_the_rules() {
        // Elimination: a parked window not bound yet has the bounds of A's other window.
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.add(200, LEFT, false);
        w.add(300, LEFT, true);
        w.put(A, 1, Some(SCREEN)).focused = true;
        w.put(A, 3, Some(LEFT)).state = "normal".into();
        w.parked = set_of(&[200]);
        w.truth = map(&[(k(A, 1), 100), (k(A, 3), 300)]);
        w.read0();
        assert!(w.numbers() == w.truth && w.wrong.is_empty(), "never an elimination rival: {}", w.said());
        // Moved: the parked window's copy moves it to a free window's bounds.
        let mut w = parked_world();
        w.add(200, LEFT, false);
        w.add(300, RIGHT, false);
        w.run(1.0);
        w.set(&k(B, 2), |e| e.bounds = Some(RIGHT));
        w.run(6.0);
        assert!(w.numbers().get(&k(B, 2)) == Some(&200) && !w.said().contains("(was 200)"), "{}", w.said());
        // Focus moved: a parked window focused while another window comes to the front.
        let mut w = parked_world();
        w.add(200, LEFT, false);
        w.add(300, SCREEN, false);
        w.put(A, 4, Some(SCREEN));
        w.truth.insert(k(A, 4), 300);
        w.run(1.0);
        for _ in 0..2 {
            w.show_and_focus(300, &k(B, 2));
            w.show1(100);
            w.read(0.05);
            w.run_every(2.4, 0.1);
        }
        assert!(
            w.numbers().get(&k(B, 2)) == Some(&200)
                && w.wrong.is_empty()
                && w.said().contains("safari:B#2: focus heard at")
                && w.said().contains("not used: its window is parked"),
            "{}",
            w.said()
        );
        // Visible and the front window: a parked window back on screen and in front, its page shown.
        let mut w = parked_world();
        w.add(200, LEFT, true);
        w.show(Some(200), &[100]);
        w.pages = true;
        w.run(4.0);
        assert!(
            !w.binder.front_changes().contains(&Some(200)) && w.numbers() == w.truth && w.wrong.is_empty(),
            "{:?}\n{}",
            w.binder.front_changes(),
            w.said()
        );
    }

    const MADE: Rect = Rect::new(0.0, 0.0, 1100.0, 760.0);
    fn creating() -> (World, f64) {
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.put(A, 7, Some(SCREEN)).focused = true;
        w.ext.insert(B.into(), Vec::new());
        w.copies.insert(B.into(), "copy-B".into()); // B's copy linked, no window yet
        w.truth = map(&[(k(A, 7), 100), (k(B, 90), 400)]);
        w.run(1.0);
        let asked = w.t;
        w.add(400, MADE, false);
        w.read(0.05);
        (w, asked)
    }

    #[test]
    fn made_by_margin_with_answered_bounds() {
        let (mut w, asked) = creating();
        let now = w.t;
        w.binder.expect(k(B, 90), asked, now, "made by Margin's openSpaceWindow", Some(MADE));
        w.read(0.05);
        assert!(
            w.numbers().get(&k(B, 90)) == Some(&400)
                && w.said().contains("safari:B#90 is window 400: made by Margin's openSpaceWindow at")
                && w.said().contains("(by the bounds its answer gave, 0,0 1100×760, before its copy listed it)"),
            "{}",
            w.said()
        );
        w.run_every(1.5, 0.05);
        assert!(
            w.numbers().get(&k(B, 90)) == Some(&400) && !w.said().contains("no longer"),
            "kept while its list lags"
        );
        let e = w.put(B, 90, Some(MADE));
        e.state = "normal".into();
        e.created_at = Some(asked + 0.02);
        w.read(0.05);
        w.mv(400, SCREEN);
        w.set(&k(B, 90), |e| {
            e.bounds = Some(SCREEN);
            e.state = "fullscreen".into()
        });
        w.run(3.0);
        assert!(w.numbers() == w.truth && w.wrong.is_empty(), "{}", w.said());

        let (mut w, asked) = creating();
        let now = w.t;
        w.binder.expect(k(B, 90), asked, now, "made by Margin's openSpaceWindow", Some(MADE));
        w.read(0.05);
        w.run_every(2.5, 0.05);
        assert!(
            !w.numbers().contains_key(&k(B, 90))
                && w.said().contains("safari:B#90 is no longer window 400: closed in the browser"),
            "its copy never listing it in 2 s: {}",
            w.said()
        );

        let (mut w, asked) = creating();
        let now = w.t;
        w.binder.expect(k(B, 90), asked, now, "made by Margin's openSpaceWindow", None);
        w.run_every(0.5, 0.05);
        assert!(!w.numbers().contains_key(&k(B, 90)), "no bounds answered: waits for its copy's list");
        let e = w.put(B, 90, Some(MADE));
        e.state = "normal".into();
        e.created_at = Some(asked + 0.02);
        w.read(0.05);
        assert!(w.numbers().get(&k(B, 90)) == Some(&400) && !w.said().contains("by the bounds its answer gave"));

        let (mut w, asked) = creating();
        let now = w.t;
        w.binder.expect(k(B, 90), asked, now, "made by Margin's openSpaceWindow", Some(RIGHT));
        w.run_every(0.5, 0.05);
        assert!(!w.numbers().contains_key(&k(B, 90)), "the answer's bounds not the new window's");
        let e = w.put(B, 90, Some(MADE));
        e.state = "normal".into();
        e.created_at = Some(asked + 0.02);
        w.read(0.05);
        assert!(w.numbers().get(&k(B, 90)) == Some(&400) && w.wrong.is_empty());

        // A parked window shown during the create is never taken for the new one.
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.put(A, 7, Some(SCREEN)).focused = true;
        w.ext.insert(C.into(), Vec::new());
        w.copies.insert(C.into(), "copy-C".into());
        w.parked = set_of(&[200]);
        w.truth = map(&[(k(A, 7), 100), (k(C, 90), 400)]);
        w.run(1.0);
        let asked = w.t;
        w.add(200, LEFT, false);
        w.read(0.05);
        let now = w.t;
        w.binder.expect(k(C, 90), asked, now, "made by Margin's openSpaceWindow", Some(LEFT));
        w.run_every(0.5, 0.05);
        assert!(!w.numbers().contains_key(&k(C, 90)) && w.wrong.is_empty(), "{}", w.said());
        w.add(400, LEFT, false);
        w.read(0.05);
        assert!(w.numbers().get(&k(C, 90)) == Some(&400) && w.wrong.is_empty(), "{}", w.said());
    }

    // ---- Accessibility names each window's profile (Mac only: Safari's titles) ----
    #[test]
    fn exact_bindings() {
        let (a, b, c) = ("safari:s-default", "safari:s-b", "safari:s-c");
        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.add(101, SCREEN, false);
        w.add(102, SCREEN, false);
        w.put(a, 1, Some(SCREEN));
        w.put(b, 2, Some(SCREEN));
        w.put(c, 3, Some(SCREEN));
        w.truth = map(&[(k(a, 1), 101), (k(b, 2), 100), (k(c, 3), 102)]);
        w.exact = [(100, b.to_string()), (101, a.to_string()), (102, c.to_string())].into_iter().collect();
        assert_eq!(w.read0(), w.truth, "every same-bounds window bound at the first read");
        assert!(w.wrong.is_empty());

        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.put(a, 1, Some(SCREEN));
        w.read0();
        w.add(101, SCREEN, false);
        w.put(b, 2, Some(SCREEN));
        w.exact = [(100, b.to_string()), (101, a.to_string())].into_iter().collect();
        let out = w.read0();
        assert!(out.get(&k(a, 1)) == Some(&101) && out.get(&k(b, 2)) == Some(&100), "Accessibility overrides: {out:?}");

        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.add(101, LEFT, true);
        w.put(a, 1, Some(SCREEN));
        w.put(a, 2, Some(LEFT)).state = "normal".into();
        w.exact = [(100, a.to_string()), (101, a.to_string())].into_iter().collect();
        let out = w.read0();
        assert!(out.get(&k(a, 1)) == Some(&100) && out.get(&k(a, 2)) == Some(&101), "{out:?}");

        let mut w = World::new();
        w.add(100, SCREEN, true);
        w.add(101, SCREEN, false);
        w.put(a, 1, Some(SCREEN));
        w.put(b, 2, Some(SCREEN));
        w.parked = set_of(&[101]);
        w.exact = [(100, a.to_string()), (101, b.to_string())].into_iter().collect();
        let out = w.read0();
        assert!(
            !out.contains_key(&k(b, 2)) && out.get(&k(a, 1)) == Some(&100),
            "a parked window is the registry's: {out:?}"
        );
    }

    #[test]
    fn exact_profile_does_not_steal_a_new_window_from_a_lagging_report() {
        let (a, b) = ("safari:s-default", "safari:s-b");
        let mut w = World::new();
        w.add(100, LEFT, true);
        w.put(b, 2, Some(LEFT)).state = "normal".into();
        w.exact.insert(100, a.into());
        w.run(2.0);
        assert!(w.numbers().is_empty() && !w.said().contains(" is window "), "{}", w.said());
        w.add(101, SCREEN, true);
        w.exact.insert(101, b.into());
        w.truth = map(&[(k(b, 2), 100)]);
        w.read0();
        assert!(w.numbers().is_empty() && w.wrong.is_empty(), "{}", w.said());
        w.put(b, 3, Some(SCREEN));
        w.truth.insert(k(b, 3), 101);
        w.read0();
        assert_eq!(w.numbers(), map(&[(k(b, 3), 101)]), "{}", w.said());
        assert!(w.wrong.is_empty());
        w.exact.insert(100, b.into());
        w.read0();
        assert_eq!(w.numbers(), w.truth, "{}", w.said());
        assert!(w.wrong.is_empty());
    }

    // ---- an overlay in front of its window (stacked_above, stacked_above_exactly, full_screen_toolbar) ----
    #[test]
    fn stacking() {
        let full = Rect::new(0.0, 33.0, 1512.0, 949.0);
        let w = |n: i64, pid: u32, layer: i32, alpha: f64, b: Rect| ServerWindow {
            number: n,
            pid,
            layer,
            bounds: b,
            on_screen: true,
            alpha,
            order: 0,
        };
        let own = |n: &[i64]| set_of(n);
        let edge = w(902, 7, 0, 1.0, Rect::new(0.0, 33.0, 4.0, 949.0));
        let (catcher, panel) = (w(901, 7, 0, 1.0, full), w(900, 7, 0, 1.0, full));
        assert!(stacked_above_exactly(&[edge, panel.clone(), catcher], Some(&[]), 900, &full, 50, &own(&[901, 902])));
        assert!(!stacked_above_exactly(&[w(5, 99, 0, 1.0, full)], None, 900, &full, 50, &own(&[])), "not among them");
        assert!(
            !stacked_above_exactly(
                std::slice::from_ref(&panel),
                Some(std::slice::from_ref(&panel)),
                900,
                &full,
                50,
                &own(&[])
            ),
            "in front of its toolbar too"
        );
        assert!(
            !stacked_above_exactly(&[panel.clone(), w(5, 99, 0, 1.0, full)], None, 900, &full, 50, &own(&[])),
            "another app's window between"
        );
        assert!(
            stacked_above_exactly(
                &[panel.clone(), w(6, 50, 3, 1.0, full), w(5, 99, 0, 0.0, full)],
                None,
                900,
                &full,
                50,
                &own(&[])
            ),
            "the browser's own popover, or a see-through window, between: still in front"
        );
        let list = [
            w(65173, 7, 0, 1.0, Rect::new(0.0, 33.0, 4.0, 949.0)),
            w(65170, 7, 0, 1.0, full),
            w(65172, 7, 0, 1.0, full),
        ];
        assert!(stacked_above_exactly(&list, Some(&[]), 65170, &full, 50, &own(&[65172, 65173])), "the real probe");

        // The every-window list's order (stacked_above): the overlay just above, nothing between.
        let at = |mut s: ServerWindow, order: usize| {
            s.order = order;
            s
        };
        let browser = at(w(100, 50, 0, 1.0, full), 3);
        let overlay = at(w(900, 7, 0, 1.0, full), 1);
        let toolbar = at(w(101, 50, 0, 1.0, Rect::new(0.0, -19.0, 1512.0, 52.0)), 0);
        let list = vec![toolbar.clone(), overlay.clone(), browser.clone()];
        assert!(stacked_above(&list, 900, 100, Some(101), &own(&[])), "between its window and its toolbar");
        assert_eq!(full_screen_toolbar(&list, &browser).map(|t| t.number), Some(101), "the toolbar found");
        let above_toolbar = vec![at(overlay.clone(), 0), at(toolbar.clone(), 1), browser.clone()];
        assert!(!stacked_above(&above_toolbar, 900, 100, Some(101), &own(&[])), "over the toolbar: not");
        let between = vec![overlay.clone(), at(w(5, 99, 0, 1.0, full), 2), browser.clone()];
        assert!(!stacked_above(&between, 900, 100, None, &own(&[])), "another app's window between");
        assert!(stacked_above(&between, 900, 100, None, &own(&[5])), "its own window between");
        let mut off = browser.clone();
        off.on_screen = false;
        assert!(!stacked_above(&[overlay, off], 900, 100, None, &own(&[])), "its window off screen");
    }

    #[test]
    fn clock_and_numbers() {
        assert_eq!(clock(0.0, 0.0), "00:00:00.000");
        assert_eq!(clock(1_800_000_000.5, 0.0), "08:00:00.500");
        assert_eq!(clock(1_800_000_000.5, -3600.0), "07:00:00.500");
        assert_eq!(clock(-0.001, 0.0), "23:59:59.999");
        assert_eq!(clock(f64::NEG_INFINITY, 0.0), "--:--:--.---");
        assert_eq!((swift_double(0.5), swift_double(1.0)), ("0.5".into(), "1.0".into()));
    }
}
