//! Switching to a space of another browser profile: the close-based switch (app/platforms/macos/shell/ProfileSwitch.swift; PLAN.md
//! §15, Tirth 2026-11-05), through link requests only, sans IO: a state machine fed the copies' answers and the
//! time, which makes its requests through [`SwitchWorld`] (the shell's: the links, the copies' window lists, the
//! window server).
//!
//! The target profile's copy creates its full-screen window showing the space (`openSpaceWindow`), and only once
//! that window is full screen and in front is the old profile's window closed (`closeWindow`). Its tabs aren't
//! lost: a window closing keeps them as not-open Margin tabs (docs/DATA.md), and switching back opens the space's tabs
//! again from those records.
//!
//! ```text
//!   idle ─start─▶ creating ─reply─▶ settling ─full screen, in front─▶ closing ─▶ checking ─▶ idle
//!                  │                  │ (a normal window: asked once for full screen)
//!                  │                  └ too long / the window gone: the new one closed (unless it was
//!                  │                    already there), the old one brought back
//!                  └ no answer in time / refused: nothing closed; a late answer's window is closed
//!   start with the target's copy not linked ─▶ waitingForProfile: the person opens one of its windows; once its
//!   copy links and has a window, that window shows the space and the switch goes on from settling.
//! ```
//!
//! After the old window closes, the new one must still be in front: if the OS dropped to the desktop instead, its
//! copy focuses it again (twice). A switch asked for while one is under way waits for it, the last one asked wins.
//! A copy going away mid-switch (the browser quitting) ends it with nothing done.
//!
//! With Margin windows ([`SwitchWorld::keeps_lines`], docs/BROWSER-WINDOWS.md §2.3): the target is the switch's line's home
//! for the profile if it's open, else a window is made; never another line's window or one in no line (except one
//! opened for this switch while it waited); the landed window becomes the line's home and shown window. With
//! drafts ([`SwitchWorld::asks_drafts`], HANDOFF.md §1.1): the old window's drafts are asked as the switch starts,
//! and a draft, or no answer, keeps it open (a `window-kept-draft` notice). The Swift does both only in a
//! `HandoffWorld`; the Windows shell, with no handoff, says yes to both.
//!
//! Left out (the Mac's): the handoff (Handoff.swift: the freeze, parking, the aftercare), and with it the phases
//! `waitingForLink`, `preparing`, `frozen`, `after`, `landed`, `recovering`, the parked windows `ownWindow` passes
//! over, and `keysMidSwitch` (always false here).

use crate::json::{self, Object};
use crate::time::Secs;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

/// The shell's id for a link request it made, given back with its answer.
pub type RequestId = u64;
/// The shell's id for a Margin window (a line: docs/BROWSER-WINDOWS.md §1).
pub type LineId = i64;

/// A window of a copy: its link (`browser:profile`) and the extension's window id.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WindowKey {
    pub link: String,
    pub window_id: i64,
}

impl WindowKey {
    pub fn new(link: &str, window_id: i64) -> Self {
        Self { link: link.into(), window_id }
    }
}

impl std::fmt::Display for WindowKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}#{}", self.link, self.window_id)
    }
}

/// Where a switch goes: a profile's link (`browser:profile`) and one of its spaces.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Target {
    pub profile: String,
    pub space: String,
}

impl Target {
    pub fn new(profile: &str, space: &str) -> Self {
        Self { profile: profile.into(), space: space.into() }
    }
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.profile, self.space)
    }
}

/// A window as its copy last listed it (`windows`): its id and state (`normal`, `fullscreen`, …).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CopyWindow {
    pub id: i64,
    pub state: String,
}

impl CopyWindow {
    pub fn new(id: i64, state: &str) -> Self {
        Self { id, state: state.into() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    /// Its copy isn't running: the person opens one of its windows (or the shell opened one).
    WaitingForProfile,
    Creating,
    Settling,
    Closing,
    Checking,
}

impl Phase {
    /// As overlays get it (`across.switching.phase`), the Swift's raw values.
    pub fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::WaitingForProfile => "waitingForProfile",
            Phase::Creating => "creating",
            Phase::Settling => "settling",
            Phase::Closing => "closing",
            Phase::Checking => "checking",
        }
    }
}

/// Something to tell the person (the shell's words: `across.rs` `switch_words`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwitchEvent {
    Started(Target),
    /// Its copy isn't running: the person opens one of its windows.
    NeedsProfile(Target),
    Done(Target),
    /// Why, in Margin's words.
    Failed(Target, String),
    /// The person closed the new window, or switched back.
    Cancelled(Target),
}

/// The world a switch acts in: the shell's. Requests are the copies' `req`s; each answer comes back through
/// [`ProfileSwitch::answered`] with the id `request` gave (an answer that never comes is fine: the switch has its
/// own timeouts; the link's own 15 s timeout should still answer it with an error).
pub trait SwitchWorld {
    fn is_linked(&self, link: &str) -> bool;
    /// A `req` of `kind` to the link's copy. `window_id`: the window it's for (the link's `req.windowId`).
    fn request(&mut self, link: &str, kind: &str, payload: Value, window_id: Option<i64>) -> RequestId;
    /// The copy's windows as it last said.
    fn windows(&self, link: &str) -> Vec<CopyWindow>;
    /// The window is the browser's first window on screen (the window server's front window of the browser,
    /// bound to this key).
    fn in_front(&self, link: &str, window_id: i64) -> bool;
    fn switch_changed(&mut self, event: &SwitchEvent);
    /// Ask the browser itself for a new window in `link`'s profile, for a profile whose copy isn't running (the
    /// Mac: Safari's File › New Window through Accessibility; Chromium: `--profile-directory`). False: it can't.
    fn open_profile_window(&mut self, _link: &str) -> bool {
        false
    }
    /// Margin's extension turned off in that profile, as the browser's own settings say: the switch fails at once.
    fn margin_off(&self, _link: &str) -> bool {
        false
    }

    /// Margin windows (docs/BROWSER-WINDOWS.md §2.3): the switch takes its line's home for the profile, never another
    /// line's. False: the first window its copy lists (the Swift outside a HandoffWorld).
    fn keeps_lines(&self) -> bool {
        false
    }
    /// The window's line, or a new one with it the line's home for `link` (ParkingRegistry.lineFor). `None`: the
    /// window isn't bound to one of the OS's.
    fn line_for(&mut self, _link: &str, _window_id: i64) -> Option<LineId> {
        None
    }
    /// The line's home window for `link` (an id of that link's copy), if it has one and it's bound.
    fn home(&self, _line: LineId, _link: &str) -> Option<i64> {
        None
    }
    /// The line the window is in, if any (`None` too for a window not bound).
    fn line_of(&self, _link: &str, _window_id: i64) -> Option<LineId> {
        None
    }
    /// The window landed: its line's home for `link` and its shown window (ParkingRegistry.noteShown). `line`
    /// `None`: the window's own line, or a new one (lineFor). Nothing for a window not bound.
    fn note_shown(&mut self, _link: &str, _window_id: i64, _line: Option<LineId>) {}

    /// Ask the old window's drafts before closing it (`windowDrafts`), and keep it open with one.
    fn asks_drafts(&self) -> bool {
        false
    }
    /// One of the switch's notices, told once the switch ends (`across.rs` keeps and sends it).
    fn show_notice(&mut self, _notice: &SwitchNotice) {}
}

/// One of the switch's notices (ShellProfiles.swift `SwitchNotice`): its kind, the profile it's about (a link key),
/// the one window whose overlay shows it (none: every overlay), and, for a window kept open with a draft, that
/// window (its Close window button closes it: no drafts check then, Tirth 2026-11-06). Only the kind, the profile's
/// id and the window go to overlays; the words are theirs (extension/shared/across.ts SWITCH_NOTICES).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwitchNotice {
    pub kind: NoticeKind,
    pub profile: String,
    pub shown_in: Option<WindowKey>,
    pub kept: Option<WindowKey>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeKind {
    /// The window left kept open: a draft in it (§4.5). The only one the close-based switch gives.
    WindowKeptDraft,
    /// The handoff's (§1.10, §1.9, §1.5), kept so stored notices read back.
    DialogOpen,
    WindowBusy,
    LateLanding,
    WindowOnDesktop,
}

impl NoticeKind {
    pub fn name(self) -> &'static str {
        match self {
            NoticeKind::WindowKeptDraft => "window-kept-draft",
            NoticeKind::DialogOpen => "dialog-open",
            NoticeKind::WindowBusy => "window-busy",
            NoticeKind::LateLanding => "late-landing",
            NoticeKind::WindowOnDesktop => "window-on-desktop",
        }
    }
}

impl SwitchNotice {
    /// How long it stays up unless a button closes it first.
    pub fn seconds(&self) -> Secs {
        if self.kind == NoticeKind::WindowKeptDraft { 20.0 } else { 8.0 }
    }

    /// As the shell keeps it (Shell.switchNotice): what overlays get, and the kept window (never sent).
    pub fn stored(&self) -> Object {
        let mut o = Object::new();
        o.insert("noticeKind".into(), self.kind.name().into());
        o.insert("noticeProfile".into(), profile_id(&self.profile).into());
        if let Some(w) = &self.shown_in {
            o.insert("noticeIn".into(), json!({ "profile": profile_id(&w.link), "windowId": w.window_id }));
        }
        if let Some(k) = &self.kept {
            o.insert("kept".into(), json!({ "link": k.link, "windowId": k.window_id }));
        }
        o
    }

    /// The window a stored notice kept open, if it's that kind's.
    pub fn kept_in(stored: Option<&Object>) -> Option<WindowKey> {
        let stored = stored?;
        if json::string(stored.get("noticeKind")) != Some(NoticeKind::WindowKeptDraft.name()) {
            return None;
        }
        let k = json::object(stored.get("kept"))?;
        Some(WindowKey::new(json::string(k.get("link"))?, json::int(k.get("windowId"))?))
    }

    /// What of a stored notice an overlay gets (`across.switching`): never the kept window.
    pub fn sent(stored: &Object) -> Object {
        stored
            .iter()
            .filter(|(k, _)| matches!(k.as_str(), "notice" | "noticeKind" | "noticeProfile" | "noticeIn"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

/// A link key's profile id ("safari:s-a" → "s-a"), as overlays name profiles.
pub fn profile_id(link: &str) -> &str {
    link.split_once(':').map_or(link, |(_, p)| p)
}

/// The copy's `windowDrafts` answer (LinkMessage.swift `WindowDrafts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowDrafts {
    pub drafts: Vec<i64>,
    pub unknown: Vec<i64>,
}

impl WindowDrafts {
    /// `None`: not an answer (a close then waits, as for a draft).
    pub fn parse(result: &Value) -> Option<Self> {
        let ints = |k: &str| json::array(result.get(k)).map(|a| a.iter().filter_map(|v| json::int(Some(v))).collect());
        Some(Self { drafts: ints("drafts")?, unknown: ints("unknown")? })
    }
    pub fn may_close(&self) -> bool {
        self.drafts.is_empty() && self.unknown.is_empty()
    }
}

#[derive(Clone, Debug)]
pub struct SwitchOptions {
    /// The copy's answer to openSpaceWindow (1 in 20 creates takes up to 2 s).
    pub create_timeout: Secs,
    /// The new window full screen and in front.
    pub settle_timeout: Secs,
    /// A normal window this long: asked for full screen.
    pub full_screen_after: Secs,
    pub close_timeout: Secs,
    /// After the close, the new window in front by then…
    pub front_check: Secs,
    /// …and still, this long after it (the OS can drop to the desktop as the old window goes).
    pub front_hold: Secs,
    pub recover_tries: u32,
    /// For the person to open the profile's window.
    pub profile_wait: Secs,
    /// For the profile's copy to link once the shell opened its window itself (it links in 1-2 s).
    pub opened_profile_wait: Secs,
    pub poll: Secs,
    /// The browser's name in the failures' words (the Swift's say Safari).
    pub browser_name: String,
    /// The failure when the new window never stays in front, in the OS's words.
    pub not_shown_words: String,
}

impl Default for SwitchOptions {
    fn default() -> Self {
        Self {
            create_timeout: 8.0,
            settle_timeout: 6.0,
            full_screen_after: 0.4,
            close_timeout: 5.0,
            front_check: 1.2,
            front_hold: 0.5,
            recover_tries: 2,
            profile_wait: 90.0,
            opened_profile_wait: 10.0,
            poll: 0.05,
            browser_name: "Safari".into(),
            not_shown_words: "macOS didn’t show its window: click it in Mission Control".into(),
        }
    }
}

#[derive(Clone, Debug)]
enum Pending {
    Drafts { generation: u64 },
    Create { generation: u64, to: Target },
    Close { generation: u64 },
}

/// The window a switch leaves: its link and window (none: a switch from no window).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct From {
    pub profile: String,
    pub window_id: Option<i64>,
}

/// The close-based switch. Every call takes the world and the time; the shell calls [`ProfileSwitch::tick`] at
/// [`ProfileSwitch::next_wake`] and on every window list, link change and window-server read, and passes each
/// answer to [`ProfileSwitch::answered`].
#[derive(Debug)]
pub struct ProfileSwitch {
    pub options: SwitchOptions,
    phase: Phase,
    target: Option<Target>,
    from: Option<From>,
    /// The switch's Margin window (docs/BROWSER-WINDOWS.md §2.3), from its start.
    close_line: Option<LineId>,
    /// The target's window: made by the switch, or the one it shows.
    new_window: Option<i64>,
    queued: Option<Target>,
    generation: u64,
    deadline: Secs,
    phase_since: Secs,
    /// The window was the profile's already: never closed by a failure.
    adopted: bool,
    full_screen_asked: bool,
    tries: u32,
    drafts: Option<WindowDrafts>,
    drafts_asked: bool,
    notices: Vec<SwitchNotice>,
    pending: HashMap<RequestId, Pending>,
    next_wake: Option<Secs>,
    history: VecDeque<String>,
    notes: Vec<String>,
}

impl Default for ProfileSwitch {
    fn default() -> Self {
        Self::new(SwitchOptions::default())
    }
}

impl ProfileSwitch {
    /// The most lines kept in `history`.
    pub const HISTORY: usize = 500;

    pub fn new(options: SwitchOptions) -> Self {
        Self {
            options,
            phase: Phase::Idle,
            target: None,
            from: None,
            close_line: None,
            new_window: None,
            queued: None,
            generation: 0,
            deadline: 0.0,
            phase_since: 0.0,
            adopted: false,
            full_screen_asked: false,
            tries: 0,
            drafts: None,
            drafts_asked: false,
            notices: Vec::new(),
            pending: HashMap::new(),
            next_wake: None,
            history: VecDeque::new(),
            notes: Vec::new(),
        }
    }

    pub fn busy(&self) -> bool {
        self.phase != Phase::Idle
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn target(&self) -> Option<&Target> {
        self.target.as_ref()
    }
    /// The window the switch left (kept after it ends, as the Swift's).
    pub fn from(&self) -> Option<&From> {
        self.from.as_ref()
    }
    pub fn new_window(&self) -> Option<i64> {
        self.new_window
    }
    pub fn queued(&self) -> Option<&Target> {
        self.queued.as_ref()
    }
    /// When to tick next (every `poll` while busy), or `None` while idle.
    pub fn next_wake(&self) -> Option<Secs> {
        self.next_wake
    }
    /// What happened, for the tests and the log (the last [`ProfileSwitch::HISTORY`] lines). A line can carry a
    /// copy's error words: the shell scrubs them before they reach a log (Diagnostics.scrub).
    pub fn history(&self) -> impl Iterator<Item = &str> {
        self.history.iter().map(String::as_str)
    }
    /// The lines since the last call, for the shell's log ("profile switch: …").
    pub fn take_notes(&mut self) -> Vec<String> {
        std::mem::take(&mut self.notes)
    }

    fn note(&mut self, line: String) {
        if self.history.len() >= Self::HISTORY {
            self.history.pop_front();
        }
        self.history.push_back(line.clone());
        self.notes.push(line);
    }

    fn enter(&mut self, p: Phase, seconds: Secs, now: Secs) {
        self.phase = p;
        self.phase_since = now;
        self.deadline = now + seconds;
    }

    fn poll(&mut self, now: Secs) {
        self.next_wake = self.busy().then_some(now + self.options.poll);
    }

    fn ask(
        &mut self,
        w: &mut dyn SwitchWorld,
        link: &str,
        kind: &str,
        payload: Value,
        window_id: Option<i64>,
        then: Option<Pending>,
    ) {
        let id = w.request(link, kind, payload, window_id);
        if let Some(p) = then {
            self.pending.insert(id, p);
        }
    }

    /// Switch from `window_id` of `from_profile` to `to`. A switch under way: this one waits (the last asked wins).
    pub fn start(
        &mut self,
        w: &mut dyn SwitchWorld,
        to: Target,
        from_profile: &str,
        window_id: Option<i64>,
        now: Secs,
    ) {
        if self.busy() {
            if self.target.as_ref() == Some(&to) {
                return;
            }
            // Back where it started, before anything was made: the switch ends, nothing to do.
            if self.from.as_ref().is_some_and(|f| f.profile == to.profile) && self.phase == Phase::WaitingForProfile {
                if let Some(t) = self.target.clone() {
                    return self.finish(
                        w,
                        SwitchEvent::Cancelled(t),
                        format!("back to {to} while waiting: nothing done"),
                        now,
                    );
                }
            }
            self.note(format!("{to} asked mid-switch: after this one"));
            self.queued = Some(to);
            return;
        }
        self.generation += 1;
        self.target = Some(to.clone());
        self.from = Some(From { profile: from_profile.into(), window_id });
        self.new_window = None;
        self.adopted = false;
        self.full_screen_asked = false;
        self.tries = 0;
        self.queued = None;
        self.drafts = None;
        self.drafts_asked = false;
        self.close_line = match window_id {
            Some(id) if w.keeps_lines() => w.line_for(from_profile, id),
            _ => None,
        };
        w.switch_changed(&SwitchEvent::Started(to.clone()));
        self.ask_drafts(w);
        if !w.is_linked(&to.profile) {
            if w.margin_off(&to.profile) {
                let why = format!("Margin is turned off in {} (the browser's settings)", to.profile);
                return self.finish(w, SwitchEvent::Failed(to, "Margin is turned off in it".into()), why, now);
            }
            // Its copy starts with the window the shell asks the browser for; the switch goes on once it links.
            let opened = w.open_profile_window(&to.profile);
            let wait = if opened { self.options.opened_profile_wait } else { self.options.profile_wait };
            self.enter(Phase::WaitingForProfile, wait, now);
            if opened {
                self.note(format!(
                    "{} isn't linked: asked the browser for a new window of it, waiting for its copy",
                    to.profile
                ));
            } else {
                self.note(format!("{} isn't linked: waiting for one of its windows", to.profile));
                w.switch_changed(&SwitchEvent::NeedsProfile(to));
            }
            return self.poll(now);
        }
        match self.own_window(w, &to.profile, false) {
            Some(win) => self.adopt(w, win.id, now),
            None => self.create(w, now),
        }
        self.poll(now);
    }

    /// The profile's window to show. With Margin windows: its line's home for the profile, or, `awaited` (the
    /// profile had no window), one opened for this switch in no line; another line's, or one in no line, is another
    /// Margin window's. Without them: the first its copy lists.
    fn own_window(&self, w: &dyn SwitchWorld, profile: &str, awaited: bool) -> Option<CopyWindow> {
        let open = w.windows(profile);
        if !w.keeps_lines() {
            return open.into_iter().next();
        }
        if let Some(home) = self.close_line.and_then(|l| w.home(l, profile))
            && let Some(win) = open.iter().find(|x| x.id == home)
        {
            return Some(win.clone());
        }
        if awaited { open.into_iter().find(|x| w.line_of(profile, x.id).is_none()) } else { None }
    }

    /// The old window's drafts before it may be closed (HANDOFF.md §1.1): asked now, answered long before the new
    /// window is in front.
    fn ask_drafts(&mut self, w: &mut dyn SwitchWorld) {
        let Some(from) = self.from.clone() else { return };
        let Some(old) = from.window_id else { return };
        if !w.asks_drafts()
            || self.target.as_ref().is_some_and(|t| t.profile == from.profile)
            || !w.is_linked(&from.profile)
        {
            return;
        }
        self.drafts_asked = true;
        let generation = self.generation;
        self.ask(
            w,
            &from.profile,
            "windowDrafts",
            json!({ "windowId": old }),
            Some(old),
            Some(Pending::Drafts { generation }),
        );
    }

    fn create(&mut self, w: &mut dyn SwitchWorld, now: Secs) {
        let Some(to) = self.target.clone() else { return };
        self.enter(Phase::Creating, self.options.create_timeout, now);
        self.note(format!("create {to}"));
        let payload = json!({ "spaceId": to.space, "fullscreen": true });
        let generation = self.generation;
        let link = to.profile.clone();
        self.ask(w, &link, "openSpaceWindow", payload, None, Some(Pending::Create { generation, to }));
    }

    /// The profile's window that's already there (or that the person opened): it shows the space.
    fn adopt(&mut self, w: &mut dyn SwitchWorld, id: i64, now: Secs) {
        let Some(to) = self.target.clone() else { return };
        self.adopted = true;
        self.new_window = Some(id);
        self.enter(Phase::Settling, self.options.settle_timeout, now);
        self.note(format!("window {id} of {} is there: shown", to.profile));
        self.ask(w, &to.profile, "focusWindow", json!({ "windowId": id, "fullscreen": true }), Some(id), None);
        self.full_screen_asked = true;
        self.ask(w, &to.profile, "setSpace", json!({ "windowId": id, "spaceId": to.space }), Some(id), None);
    }

    /// A copy's answer to one of the switch's requests: the reply's `result` (`ok: true`), or its error.
    pub fn answered(&mut self, w: &mut dyn SwitchWorld, id: RequestId, answer: Result<Value, String>, now: Secs) {
        let Some(pending) = self.pending.remove(&id) else { return };
        match pending {
            Pending::Drafts { generation } => {
                if generation == self.generation {
                    self.drafts = answer.ok().and_then(|r| WindowDrafts::parse(&r));
                }
            }
            Pending::Create { generation, to } => {
                let made = answer.as_ref().ok().and_then(|r| json::int(r.get("windowId")));
                if generation != self.generation || self.phase != Phase::Creating {
                    // Answered after the switch gave up: its window would be a second one.
                    if let Some(late) = made {
                        self.note(format!("late window {late} of {}: closed", to.profile));
                        self.ask(w, &to.profile, "closeWindow", json!({ "windowId": late }), Some(late), None);
                    }
                    return;
                }
                let Some(made) = made else {
                    let error = answer.err().unwrap_or_else(|| "no window".into());
                    let why = format!("{} didn’t open a window for it", self.options.browser_name);
                    return self.finish(w, SwitchEvent::Failed(to, why), format!("create refused: {error}"), now);
                };
                self.new_window = Some(made);
                self.enter(Phase::Settling, self.options.settle_timeout, now);
                let state = answer
                    .ok()
                    .and_then(|r| json::string(r.get("state")).map(str::to_owned))
                    .unwrap_or_else(|| "?".into());
                self.note(format!("created window {made} ({state})"));
                self.tick(w, now);
            }
            Pending::Close { generation } => {
                if generation != self.generation || self.phase != Phase::Closing {
                    return;
                }
                if let Err(error) = answer {
                    self.note(format!("close answered: {error}"));
                }
                self.check_front(w, now);
            }
        }
    }

    /// Looked at again: on every window list, link change and window-server read, and at [`Self::next_wake`].
    pub fn tick(&mut self, w: &mut dyn SwitchWorld, now: Secs) {
        self.step(w, now);
        self.poll(now);
    }

    fn step(&mut self, w: &mut dyn SwitchWorld, now: Secs) {
        let Some(to) = self.target.clone() else { return };
        if !self.busy() {
            return;
        }
        // A copy gone mid-switch (the browser quitting, the extension turned off): nothing more is done.
        if self.phase != Phase::WaitingForProfile && !w.is_linked(&to.profile) {
            let why = format!("{} stopped answering", self.options.browser_name);
            return self.finish(
                w,
                SwitchEvent::Failed(to.clone(), why),
                format!("{}'s copy went away mid-switch", to.profile),
                now,
            );
        }
        match self.phase {
            Phase::Idle => {}
            Phase::WaitingForProfile => {
                if w.is_linked(&to.profile)
                    && let Some(win) = self.own_window(w, &to.profile, true)
                {
                    self.note(format!("{} linked with window {}", to.profile, win.id));
                    return self.adopt(w, win.id, now);
                }
                if now >= self.deadline {
                    let why = format!("gave up waiting for {}", to.profile);
                    self.finish(w, SwitchEvent::Failed(to, "no window of it was opened".into()), why, now);
                }
            }
            Phase::Creating => {
                if now >= self.deadline {
                    let why = format!("{} took too long to open its window", self.options.browser_name);
                    self.finish(w, SwitchEvent::Failed(to, why), "create timed out".into(), now);
                }
            }
            Phase::Settling => {
                let listed = self.new_window.and_then(|id| w.windows(&to.profile).into_iter().find(|x| x.id == id));
                let Some(win) = listed else {
                    if now - self.phase_since < 0.5 {
                        return; // the copy's window list may lag its answer
                    }
                    let why = format!("window {} gone before it was in front", self.new_window.unwrap_or(-1));
                    return self.cancel(w, to, why, now);
                };
                if win.state == "fullscreen" && w.in_front(&to.profile, win.id) {
                    return self.close_old(w, now);
                }
                if win.state != "fullscreen"
                    && !self.full_screen_asked
                    && now - self.phase_since >= self.options.full_screen_after
                {
                    self.full_screen_asked = true;
                    self.note(format!("window {} came back {}: asked for full screen", win.id, win.state));
                    let payload = json!({ "windowId": win.id, "fullscreen": true });
                    self.ask(w, &to.profile, "focusWindow", payload, Some(win.id), None);
                }
                if now >= self.deadline {
                    let why = format!("{}’s window didn’t go full screen", self.options.browser_name);
                    self.undo(w, to, why, now);
                }
            }
            Phase::Closing => {
                if now >= self.deadline {
                    self.check_front(w, now); // the close never answered: on as if it had
                }
            }
            Phase::Checking => {
                let Some(id) = self.new_window else { return };
                if w.in_front(&to.profile, id) && now - self.phase_since >= self.options.front_hold {
                    return self.finish(w, SwitchEvent::Done(to), format!("done: window {id} in front"), now);
                }
                if !w.windows(&to.profile).iter().any(|x| x.id == id) {
                    return self.finish(
                        w,
                        SwitchEvent::Cancelled(to),
                        format!("window {id} closed after the switch"),
                        now,
                    );
                }
                if now >= self.deadline {
                    // The OS showed the desktop instead of the new window: its copy focuses it again.
                    if self.tries >= self.options.recover_tries {
                        let why = self.options.not_shown_words.clone();
                        let note = format!("not in front after {} tries", self.tries);
                        return self.finish(w, SwitchEvent::Failed(to, why), note, now);
                    }
                    self.tries += 1;
                    self.note(format!("not in front after the close: focused again ({})", self.tries));
                    self.ask(
                        w,
                        &to.profile,
                        "focusWindow",
                        json!({ "windowId": id, "fullscreen": true }),
                        Some(id),
                        None,
                    );
                    self.enter(Phase::Checking, self.options.front_check, now);
                }
            }
        }
    }

    fn close_old(&mut self, w: &mut dyn SwitchWorld, now: Secs) {
        let Some(to) = self.target.clone() else { return };
        let old = self.from.clone().and_then(|f| {
            let id = f.window_id?;
            let there =
                f.profile != to.profile && w.is_linked(&f.profile) && w.windows(&f.profile).iter().any(|x| x.id == id);
            there.then_some((f.profile, id))
        });
        let Some((profile, old)) = old else {
            self.note("the old window is gone already".into());
            return self.check_front(w, now);
        };
        // A draft in it, or no answer: kept open, and the person told (§4.5).
        if self.drafts_asked && !self.drafts.as_ref().is_some_and(WindowDrafts::may_close) {
            let said = match &self.drafts {
                Some(d) => format!("{} with drafts, {} unknown", d.drafts.len(), d.unknown.len()),
                None => "no drafts answer".into(),
            };
            self.note(format!("{profile} window {old} kept open: {said}"));
            let shown_in = self.new_window.map(|id| WindowKey::new(&to.profile, id));
            let kept = Some(WindowKey::new(&profile, old));
            self.notices.push(SwitchNotice {
                kind: NoticeKind::WindowKeptDraft,
                profile: profile.clone(),
                shown_in,
                kept,
            });
            return self.check_front(w, now);
        }
        self.enter(Phase::Closing, self.options.close_timeout, now);
        self.note(format!("close {profile} window {old}"));
        let generation = self.generation;
        self.ask(
            w,
            &profile,
            "closeWindow",
            json!({ "windowId": old }),
            Some(old),
            Some(Pending::Close { generation }),
        );
    }

    fn check_front(&mut self, w: &mut dyn SwitchWorld, now: Secs) {
        self.enter(Phase::Checking, self.options.front_check, now);
        self.step(w, now);
    }

    /// The new window gone before it was in front: the old one stays.
    fn cancel(&mut self, w: &mut dyn SwitchWorld, to: Target, why: String, now: Secs) {
        self.bring_back_old(w);
        self.finish(w, SwitchEvent::Cancelled(to), why, now);
    }

    /// It didn't work: the window made for it closed (not one that was there), the old one back in front.
    fn undo(&mut self, w: &mut dyn SwitchWorld, to: Target, why: String, now: Secs) {
        if let Some(id) = self.new_window
            && !self.adopted
            && self.from.as_ref().is_some_and(|f| f.window_id.is_some())
        {
            self.ask(w, &to.profile, "closeWindow", json!({ "windowId": id }), Some(id), None);
        }
        self.bring_back_old(w);
        self.finish(w, SwitchEvent::Failed(to, why.clone()), why, now);
    }

    fn bring_back_old(&mut self, w: &mut dyn SwitchWorld) {
        let Some(from) = self.from.clone() else { return };
        let Some(old) = from.window_id else { return };
        if !w.is_linked(&from.profile) || !w.windows(&from.profile).iter().any(|x| x.id == old) {
            return;
        }
        self.ask(w, &from.profile, "focusWindow", json!({ "windowId": old }), Some(old), None);
    }

    /// The switch ends; where it ended up is the new window when done, else the old one. What was asked meanwhile
    /// starts from there.
    fn finish(&mut self, w: &mut dyn SwitchWorld, event: SwitchEvent, why: String, now: Secs) {
        self.note(why);
        let landed = match &event {
            SwitchEvent::Done(t) => Some(From { profile: t.profile.clone(), window_id: self.new_window }),
            _ => self.from.clone(),
        };
        let next = self.queued.take();
        // Landed: its window is its Margin window's home for its profile, and its shown one (docs/BROWSER-WINDOWS.md §2.3).
        if let SwitchEvent::Done(t) = &event
            && let Some(id) = self.new_window
            && w.keeps_lines()
        {
            w.note_shown(&t.profile, id, self.close_line);
        }
        self.generation += 1;
        self.phase = Phase::Idle;
        self.next_wake = None;
        w.switch_changed(&event);
        self.target = None;
        let told = std::mem::take(&mut self.notices);
        // What was asked meanwhile, from where the switch landed.
        if let (Some(next), Some(landed)) = (next, landed)
            && w.is_linked(&landed.profile)
        {
            if next.profile == landed.profile {
                self.note(format!("then {next} in the same window"));
                let window = landed.window_id.map_or(Value::Null, Value::from);
                let payload = json!({ "windowId": window, "spaceId": next.space });
                self.ask(w, &landed.profile, "setSpace", payload, landed.window_id, None);
            } else {
                self.start(w, next, &landed.profile, landed.window_id, now);
            }
        }
        for n in &told {
            w.show_notice(n);
        }
        self.poll(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "safari:A";
    const B: &str = "safari:B";
    const C: &str = "safari:C";

    #[derive(Debug, Clone)]
    struct Req {
        id: RequestId,
        link: String,
        kind: String,
        payload: Value,
    }

    /// The Swift FakeWorld (app/platforms/macos/shell/tests/profiles-tests.swift): the copies answer closeWindow, focusWindow and
    /// setSpace at once (queued here, delivered by `pump`), openSpaceWindow when told.
    #[derive(Default)]
    struct World {
        off: Vec<String>,
        linked: Vec<String>,
        wins: HashMap<String, Vec<CopyWindow>>,
        front: Option<(String, i64)>,
        requests: Vec<Req>,
        events: Vec<SwitchEvent>,
        answer_create: bool,
        create_state: String,
        next_window: i64,
        replies: VecDeque<(RequestId, Result<Value, String>)>,
        opens: bool,
        // Margin windows and drafts.
        lines: bool,
        line_of: HashMap<(String, i64), LineId>,
        homes: HashMap<(LineId, String), i64>,
        shown: Vec<(String, i64, Option<LineId>)>,
        drafts: bool,
        notices: Vec<SwitchNotice>,
    }

    impl World {
        fn new() -> Self {
            let mut w = World { next_window: 50, create_state: "fullscreen".into(), ..World::default() };
            w.linked = vec![A.into(), B.into(), C.into()];
            w.wins.insert(A.into(), vec![CopyWindow::new(10, "fullscreen")]);
            w.front = Some((A.into(), 10));
            w
        }
        fn types(&self, link: Option<&str>) -> Vec<&str> {
            self.requests.iter().filter(|r| link.is_none_or(|l| r.link == l)).map(|r| r.kind.as_str()).collect()
        }
        fn last(&self) -> &Req {
            &self.requests[self.requests.len() - 1]
        }
        /// The copy's answer to a create: a new window, in its list.
        fn answer(&mut self, index: usize, state: &str) {
            let r = self.requests[index].clone();
            let id = self.next_window;
            self.next_window += 1;
            self.wins.entry(r.link.clone()).or_default().push(CopyWindow::new(id, state));
            self.replies.push_back((r.id, Ok(json!({ "windowId": id, "state": state }))));
        }
        fn front(&mut self, link: &str, id: i64) {
            self.front = Some((link.into(), id));
        }
        fn last_failed(&self) -> bool {
            matches!(self.events.last(), Some(SwitchEvent::Failed(..)))
        }
    }

    impl SwitchWorld for World {
        fn is_linked(&self, link: &str) -> bool {
            self.linked.iter().any(|l| l == link)
        }
        fn request(&mut self, link: &str, kind: &str, payload: Value, _window_id: Option<i64>) -> RequestId {
            let id = self.requests.len() as RequestId + 1;
            self.requests.push(Req { id, link: link.into(), kind: kind.into(), payload: payload.clone() });
            let window = json::int(payload.get("windowId")).unwrap_or(-1);
            match kind {
                "closeWindow" => {
                    if let Some(list) = self.wins.get_mut(link) {
                        list.retain(|x| x.id != window);
                    }
                    self.replies.push_back((id, Ok(json!({}))));
                }
                "focusWindow" => {
                    if payload.get("fullscreen") == Some(&Value::Bool(true))
                        && let Some(x) = self.wins.get_mut(link).and_then(|l| l.iter_mut().find(|x| x.id == window))
                    {
                        x.state = "fullscreen".into();
                    }
                    self.replies.push_back((id, Ok(json!({}))));
                }
                "setSpace" => self.replies.push_back((id, Ok(json!({})))),
                "openSpaceWindow" => {
                    if self.answer_create {
                        let state = self.create_state.clone();
                        self.answer(self.requests.len() - 1, &state);
                    }
                }
                "windowDrafts" => {}
                _ => self.replies.push_back((id, Err("unknown".into()))),
            }
            id
        }
        fn windows(&self, link: &str) -> Vec<CopyWindow> {
            self.wins.get(link).cloned().unwrap_or_default()
        }
        fn in_front(&self, link: &str, window_id: i64) -> bool {
            self.front.as_ref().is_some_and(|(l, id)| l == link && *id == window_id)
        }
        fn switch_changed(&mut self, event: &SwitchEvent) {
            self.events.push(event.clone());
        }
        fn open_profile_window(&mut self, _link: &str) -> bool {
            self.opens
        }
        fn margin_off(&self, link: &str) -> bool {
            self.off.iter().any(|l| l == link)
        }
        fn keeps_lines(&self) -> bool {
            self.lines
        }
        fn line_for(&mut self, link: &str, window_id: i64) -> Option<LineId> {
            if let Some(l) = self.line_of.get(&(link.to_string(), window_id)) {
                return Some(*l);
            }
            let l = 100 + self.line_of.len() as LineId;
            self.line_of.insert((link.into(), window_id), l);
            self.homes.insert((l, link.into()), window_id);
            Some(l)
        }
        fn home(&self, line: LineId, link: &str) -> Option<i64> {
            self.homes.get(&(line, link.to_string())).copied()
        }
        fn line_of(&self, link: &str, window_id: i64) -> Option<LineId> {
            self.line_of.get(&(link.to_string(), window_id)).copied()
        }
        fn note_shown(&mut self, link: &str, window_id: i64, line: Option<LineId>) {
            self.shown.push((link.into(), window_id, line));
        }
        fn asks_drafts(&self) -> bool {
            self.drafts
        }
        fn show_notice(&mut self, notice: &SwitchNotice) {
            self.notices.push(notice.clone());
        }
    }

    /// The switch, its world and the clock (the Swift FakeClock: the poll's timers fire as time passes).
    struct Run {
        w: World,
        s: ProfileSwitch,
        t: Secs,
    }

    impl Run {
        fn new(build: impl FnOnce(&mut World)) -> Self {
            let mut w = World::new();
            build(&mut w);
            Run { w, s: ProfileSwitch::default(), t: 1000.0 }
        }
        /// The answers the copies gave, delivered in order (each may ask more).
        fn pump(&mut self) {
            while let Some((id, answer)) = self.w.replies.pop_front() {
                self.s.answered(&mut self.w, id, answer, self.t);
            }
        }
        fn start(&mut self, to: Target) {
            self.s.start(&mut self.w, to, A, Some(10), self.t);
            self.pump();
        }
        fn answer(&mut self, index: usize) {
            self.w.answer(index, "fullscreen");
            self.pump();
        }
        fn reply(&mut self, index: usize, answer: Result<Value, String>) {
            let id = self.w.requests[index].id;
            self.s.answered(&mut self.w, id, answer, self.t);
            self.pump();
        }
        fn advance(&mut self, seconds: Secs) {
            let end = self.t + seconds;
            while let Some(at) = self.s.next_wake().filter(|at| *at <= end + 1e-9) {
                self.t = self.t.max(at);
                self.s.tick(&mut self.w, self.t);
                self.pump();
            }
            self.t = end;
        }
    }

    fn to_b() -> Target {
        Target::new(B, "b1")
    }

    // app/platforms/macos/shell/tests/profiles-tests.swift switchTests(), each case.
    #[test]
    fn it_works() {
        let mut r = Run::new(|_| {});
        r.start(to_b());
        assert_eq!(r.w.types(None), ["openSpaceWindow"]);
        assert_eq!(r.w.requests[0].link, B);
        assert_eq!(r.w.requests[0].payload, json!({ "spaceId": "b1", "fullscreen": true }));
        assert_eq!(r.s.phase(), Phase::Creating);
        r.answer(0);
        r.advance(0.3);
        assert!(
            r.s.phase() == Phase::Settling && !r.w.types(None).contains(&"closeWindow"),
            "waits for the new window in front"
        );
        r.w.front(B, 50);
        r.advance(0.1);
        let last = r.w.last();
        assert!(
            last.kind == "closeWindow" && last.link == A && last.payload["windowId"] == 10,
            "the old window closed"
        );
        r.advance(0.6);
        assert!(!r.s.busy());
        assert_eq!(r.w.events, [SwitchEvent::Started(to_b()), SwitchEvent::Done(to_b())]);
        assert!(r.w.wins[A].is_empty());
        assert_eq!(r.w.types(None), ["openSpaceWindow", "closeWindow"], "the plain world: no drafts asked");
        assert_eq!(r.s.next_wake(), None, "idle: no wake");
        assert!(r.s.history().any(|l| l == "done: window 50 in front"));
        assert!(!r.s.take_notes().is_empty() && r.s.take_notes().is_empty());
    }

    #[test]
    fn a_normal_window_is_asked_for_full_screen_once() {
        let mut r = Run::new(|w| {
            w.answer_create = true;
            w.create_state = "normal".into();
        });
        r.start(to_b());
        r.advance(0.2);
        assert!(!r.w.types(None).contains(&"focusWindow"), "not asked at once");
        r.advance(0.4);
        assert_eq!(r.w.types(None).iter().filter(|t| **t == "focusWindow").count(), 1);
        assert_eq!(r.w.last().payload["fullscreen"], true);
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(!r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Done(to_b())));
        assert_eq!(r.w.types(None).iter().filter(|t| **t == "focusWindow").count(), 1);
    }

    #[test]
    fn a_create_refused() {
        let mut r = Run::new(|_| {});
        r.start(to_b());
        r.reply(0, Err("no such space".into()));
        r.advance(0.2);
        assert!(!r.s.busy() && !r.w.types(None).contains(&"closeWindow"));
        assert_eq!(r.w.events.last(), Some(&SwitchEvent::Failed(to_b(), "Safari didn’t open a window for it".into())));
        assert!(r.s.history().any(|l| l == "create refused: no such space"));
        // An answer with no window: refused too.
        let mut r = Run::new(|_| {});
        r.start(to_b());
        r.reply(0, Ok(json!({ "state": "normal" })));
        assert!(!r.s.busy() && r.w.last_failed());
    }

    #[test]
    fn a_create_too_slow_and_its_late_window() {
        let mut r = Run::new(|_| {});
        r.start(to_b());
        r.advance(8.1);
        assert!(!r.s.busy() && !r.w.types(None).contains(&"closeWindow") && r.w.last_failed(), "failed after 8 s");
        r.answer(0);
        let last = r.w.last();
        assert!(
            last.kind == "closeWindow" && last.link == B && last.payload["windowId"] == 50,
            "its late window closed"
        );
        assert_eq!(r.w.wins[A].len(), 1);
    }

    #[test]
    fn never_in_front() {
        let mut r = Run::new(|w| w.answer_create = true);
        r.start(to_b());
        r.advance(6.2);
        let closed: Vec<&Req> = r.w.requests.iter().filter(|q| q.kind == "closeWindow").collect();
        assert!(!r.s.busy() && closed.len() == 1 && closed[0].link == B, "the new window closed");
        assert!(
            r.w.requests.iter().any(|q| q.kind == "focusWindow" && q.link == A && q.payload["windowId"] == 10),
            "the old back"
        );
        assert_eq!(
            r.w.events.last(),
            Some(&SwitchEvent::Failed(to_b(), "Safari’s window didn’t go full screen".into()))
        );
    }

    #[test]
    fn the_new_window_closed_by_the_person() {
        let mut r = Run::new(|w| w.answer_create = true);
        r.start(to_b());
        r.advance(0.6);
        r.w.wins.insert(B.into(), vec![]);
        r.advance(0.1);
        assert!(!r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Cancelled(to_b())));
        assert!(!r.w.types(None).contains(&"closeWindow"));
        assert!(r.w.requests.iter().any(|q| q.kind == "focusWindow" && q.link == A), "the old one comes back");
    }

    #[test]
    fn the_new_window_listed_late() {
        let mut r = Run::new(|_| {});
        r.start(to_b());
        let id = r.w.requests[0].id;
        r.s.answered(&mut r.w, id, Ok(json!({ "windowId": 77, "state": "fullscreen" })), r.t);
        r.advance(0.3);
        assert_eq!(r.s.phase(), Phase::Settling, "the copy's list may lag its answer");
        r.advance(0.3);
        assert_eq!(r.w.events.last(), Some(&SwitchEvent::Cancelled(to_b())), "then gone");
    }

    #[test]
    fn the_old_window_closed_by_the_person() {
        let mut r = Run::new(|w| w.answer_create = true);
        r.start(to_b());
        r.w.wins.insert(A.into(), vec![]);
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(!r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Done(to_b())));
        assert!(!r.w.types(None).contains(&"closeWindow"), "nothing to close");
    }

    #[test]
    fn switching_again_mid_switch() {
        let mut r = Run::new(|w| w.answer_create = true);
        r.start(to_b());
        r.start(Target::new(B, "b2"));
        r.start(Target::new(C, "c1"));
        assert_eq!(r.s.queued(), Some(&Target::new(C, "c1")), "the last asked kept");
        assert_eq!(r.w.types(None), ["openSpaceWindow"]);
        r.start(to_b());
        assert_eq!(r.s.queued(), Some(&Target::new(C, "c1")), "the one under way asked again: nothing");
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(r.s.busy() && r.s.target().is_some_and(|t| t.profile == C));
        assert!(r.w.last().kind == "openSpaceWindow" && r.w.last().link == C, "on to C from B's new window");
        assert_eq!(r.s.from(), Some(&From { profile: B.into(), window_id: Some(50) }));
        r.w.front(C, 51);
        r.advance(0.7);
        assert!(!r.s.busy());
        assert!(r.w.requests.iter().any(|q| q.kind == "closeWindow" && q.link == B && q.payload["windowId"] == 50));
        let count: usize = [A, B, C].iter().map(|l| r.w.wins.get(*l).map_or(0, Vec::len)).sum();
        assert_eq!(count, 1, "one window left");
    }

    #[test]
    fn the_same_profile_asked_mid_switch() {
        let mut r = Run::new(|w| w.answer_create = true);
        r.start(to_b());
        r.start(Target::new(B, "b2"));
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(!r.s.busy());
        let last = r.w.last();
        assert!(last.kind == "setSpace" && last.link == B, "setSpace in the new window");
        assert_eq!(last.payload, json!({ "windowId": 50, "spaceId": "b2" }));
    }

    #[test]
    fn the_browser_quits_mid_switch() {
        let mut r = Run::new(|_| {});
        r.start(to_b());
        r.w.linked.clear();
        r.advance(0.1);
        let count = r.w.requests.len();
        r.answer(0);
        r.advance(1.0);
        assert!(!r.s.busy() && r.w.last_failed());
        assert_eq!(r.w.requests.len(), count + 1, "only the late window's close");
        assert_eq!(r.w.last().kind, "closeWindow");
    }

    #[test]
    fn margin_off_in_that_profile() {
        let mut r = Run::new(|w| {
            w.linked = vec![A.into()];
            w.off = vec![B.into()];
        });
        r.start(to_b());
        assert!(!r.s.busy() && r.w.events.len() == 2 && r.w.requests.is_empty());
        assert!(matches!(r.w.events.last(), Some(SwitchEvent::Failed(_, why)) if why.contains("turned off")));
    }

    #[test]
    fn the_targets_copy_isnt_running() {
        let mut r = Run::new(|w| w.linked = vec![A.into()]);
        r.start(to_b());
        assert_eq!(r.s.phase(), Phase::WaitingForProfile);
        assert_eq!(r.w.events, [SwitchEvent::Started(to_b()), SwitchEvent::NeedsProfile(to_b())]);
        assert!(r.w.requests.is_empty());
        r.advance(5.0);
        r.w.linked.push(B.into());
        r.w.wins.insert(B.into(), vec![CopyWindow::new(70, "normal")]);
        r.advance(0.1);
        assert_eq!(r.s.phase(), Phase::Settling);
        assert_eq!(r.w.types(Some(B)), ["focusWindow", "setSpace"], "its window shows the space, full screen");
        assert_eq!(r.w.last().payload["spaceId"], "b1");
        r.w.front(B, 70);
        r.advance(0.7);
        assert!(!r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Done(to_b())));
        assert_eq!(r.w.types(Some(A)), ["closeWindow"]);
    }

    #[test]
    fn the_shell_opens_the_profiles_window() {
        let mut r = Run::new(|w| {
            w.linked = vec![A.into()];
            w.opens = true;
        });
        r.start(to_b());
        assert_eq!(r.w.events, [SwitchEvent::Started(to_b())], "nothing for the person to do");
        r.advance(10.1);
        assert!(
            !r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Failed(to_b(), "no window of it was opened".into()))
        );
    }

    #[test]
    fn never_opened_and_back_while_waiting() {
        let mut r = Run::new(|w| w.linked = vec![A.into()]);
        r.start(to_b());
        r.advance(91.0);
        assert!(!r.s.busy() && r.w.requests.is_empty() && r.w.last_failed(), "gave up, nothing done");
        r.start(to_b());
        r.start(Target::new(A, "a1"));
        assert!(!r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Cancelled(to_b())), "back to where it started");
    }

    #[test]
    fn the_os_drops_to_the_desktop() {
        let mut r = Run::new(|w| w.answer_create = true);
        r.start(to_b());
        r.w.front(B, 50);
        r.advance(0.1);
        r.w.front = None; // the desktop
        r.advance(1.3);
        assert!(r.s.busy());
        let last = r.w.last();
        assert!(last.kind == "focusWindow" && last.link == B && last.payload["windowId"] == 50, "focused again");
        r.w.front(B, 50);
        r.advance(0.6);
        assert!(!r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Done(to_b())));

        let mut r = Run::new(|w| w.answer_create = true);
        r.start(to_b());
        r.w.front(B, 50);
        r.advance(0.1);
        r.w.front = None;
        r.advance(5.0);
        assert!(!r.s.busy());
        assert_eq!(r.w.types(Some(B)).iter().filter(|t| **t == "focusWindow").count(), 2, "two tries");
        let words = SwitchOptions::default().not_shown_words;
        assert_eq!(r.w.events.last(), Some(&SwitchEvent::Failed(to_b(), words)), "then the person is told");
    }

    #[test]
    fn its_window_there_already() {
        let mut r = Run::new(|w| {
            w.wins.insert(B.into(), vec![CopyWindow::new(60, "fullscreen")]);
        });
        r.start(to_b());
        assert_eq!(r.w.types(Some(B)), ["focusWindow", "setSpace"], "focused and shown, nothing made");
        assert_eq!(r.s.phase(), Phase::Settling);
        r.advance(6.2);
        assert!(
            !r.w.types(Some(B)).contains(&"closeWindow") && !r.s.busy(),
            "never in front: not closed by the failure"
        );
    }

    #[test]
    fn the_close_never_answered() {
        let mut r = Run::new(|w| w.answer_create = true);
        r.start(to_b());
        r.w.front(B, 50);
        // The copy of A stops answering its closeWindow (still linked).
        r.s.tick(&mut r.w, r.t);
        r.w.replies.clear();
        assert_eq!(r.s.phase(), Phase::Closing);
        r.advance(4.9);
        assert_eq!(r.s.phase(), Phase::Closing);
        r.advance(0.2);
        r.advance(0.6);
        assert!(!r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Done(to_b())), "on as if it had");
    }

    #[test]
    fn the_words_name_the_browser() {
        let mut r = Run::new(|_| {});
        r.s.options.browser_name = "Chrome".into();
        r.start(to_b());
        r.advance(8.1);
        assert_eq!(
            r.w.events.last(),
            Some(&SwitchEvent::Failed(to_b(), "Chrome took too long to open its window".into()))
        );
    }

    // docs/BROWSER-WINDOWS.md §2.3: the close-based switch with Margin windows.
    #[test]
    fn with_margin_windows_its_lines_home_only() {
        // B has a window, but in no line (another Margin window): a window is made instead.
        let mut r = Run::new(|w| {
            w.lines = true;
            w.answer_create = true;
            w.wins.insert(B.into(), vec![CopyWindow::new(60, "fullscreen")]);
            w.line_of.insert((B.into(), 60), 7);
            w.homes.insert((7, B.into()), 60);
        });
        r.start(to_b());
        assert_eq!(r.w.types(Some(B)), ["openSpaceWindow"], "another line's window passed over");
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(!r.s.busy());
        let line = r.w.line_of(A, 10);
        assert!(line.is_some(), "A's window given a line at the start");
        assert_eq!(r.w.shown, [(B.to_string(), 50, line)], "B the line's home and shown window");

        // The line's home for B, open: shown.
        let mut r = Run::new(|w| {
            w.lines = true;
            w.wins.insert(B.into(), vec![CopyWindow::new(61, "normal"), CopyWindow::new(60, "fullscreen")]);
            w.line_of.insert((A.into(), 10), 3);
            w.homes.insert((3, A.into()), 10);
            w.line_of.insert((B.into(), 60), 3);
            w.homes.insert((3, B.into()), 60);
        });
        r.start(to_b());
        assert_eq!(r.w.types(Some(B)), ["focusWindow", "setSpace"]);
        assert_eq!(r.w.requests[0].payload["windowId"], 60, "its own line's, not the first listed");
    }

    #[test]
    fn with_margin_windows_one_opened_while_waiting() {
        let mut r = Run::new(|w| {
            w.lines = true;
            w.linked = vec![A.into()];
        });
        r.start(to_b());
        r.w.linked.push(B.into());
        r.w.wins.insert(B.into(), vec![CopyWindow::new(80, "normal"), CopyWindow::new(81, "normal")]);
        r.w.line_of.insert((B.into(), 80), 9); // another Margin window's
        r.advance(0.1);
        assert_eq!(r.s.new_window(), Some(81), "the one in no line: opened for this switch");
    }

    // HANDOFF.md §1.1: drafts asked as the switch starts.
    #[test]
    fn with_drafts_a_draft_keeps_the_old_window() {
        let mut r = Run::new(|w| {
            w.drafts = true;
            w.answer_create = true;
        });
        r.start(to_b());
        assert_eq!(r.w.types(None), ["windowDrafts", "openSpaceWindow"]);
        assert_eq!(r.w.requests[0].payload, json!({ "windowId": 10 }));
        r.reply(0, Ok(json!({ "drafts": [3], "unknown": [] })));
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(!r.s.busy() && r.w.events.last() == Some(&SwitchEvent::Done(to_b())));
        assert!(!r.w.types(None).contains(&"closeWindow"), "kept open");
        let notice = SwitchNotice {
            kind: NoticeKind::WindowKeptDraft,
            profile: A.into(),
            shown_in: Some(WindowKey::new(B, 50)),
            kept: Some(WindowKey::new(A, 10)),
        };
        assert_eq!(r.w.notices, [notice], "the person told, once the switch ended");
    }

    #[test]
    fn with_drafts_none_closes_and_no_answer_keeps() {
        let mut r = Run::new(|w| {
            w.drafts = true;
            w.answer_create = true;
        });
        r.start(to_b());
        r.reply(0, Ok(json!({ "drafts": [], "unknown": [] })));
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(r.w.types(Some(A)).contains(&"closeWindow"), "no drafts: closed");
        assert!(r.w.notices.is_empty());

        let mut r = Run::new(|w| {
            w.drafts = true;
            w.answer_create = true;
        });
        r.start(to_b());
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(!r.w.types(Some(A)).contains(&"closeWindow"), "no answer: kept");
        assert_eq!(r.w.notices.len(), 1);

        let mut r = Run::new(|w| {
            w.drafts = true;
            w.answer_create = true;
        });
        r.start(to_b());
        r.reply(0, Ok(json!({ "drafts": "none" })));
        r.w.front(B, 50);
        r.advance(0.7);
        assert!(!r.w.types(Some(A)).contains(&"closeWindow"), "not an answer: kept");
    }

    #[test]
    fn drafts_and_notices_read() {
        assert_eq!(
            WindowDrafts::parse(&json!({ "drafts": [1, 2.0, "x"], "unknown": [] })),
            Some(WindowDrafts { drafts: vec![1, 2], unknown: vec![] })
        );
        assert_eq!(WindowDrafts::parse(&json!({ "drafts": [] })), None);
        assert!(WindowDrafts { drafts: vec![], unknown: vec![] }.may_close());
        assert!(!WindowDrafts { drafts: vec![], unknown: vec![4] }.may_close());
        let n = SwitchNotice {
            kind: NoticeKind::WindowKeptDraft,
            profile: "safari:s-a".into(),
            shown_in: Some(WindowKey::new("safari:s-b", 5)),
            kept: Some(WindowKey::new("safari:s-a", 4)),
        };
        let stored = n.stored();
        assert_eq!(
            Value::Object(stored.clone()),
            json!({ "noticeKind": "window-kept-draft", "noticeProfile": "s-a", "noticeIn": { "profile": "s-b", "windowId": 5 },
                    "kept": { "link": "safari:s-a", "windowId": 4 } })
        );
        assert_eq!(SwitchNotice::kept_in(Some(&stored)), Some(WindowKey::new("safari:s-a", 4)));
        assert!(!SwitchNotice::sent(&stored).contains_key("kept"), "never the kept window");
        assert_eq!(SwitchNotice::sent(&stored).len(), 3);
        assert_eq!(n.seconds(), 20.0);
        let late = SwitchNotice { kind: NoticeKind::LateLanding, ..n.clone() };
        assert_eq!(late.seconds(), 8.0);
        assert_eq!(SwitchNotice::kept_in(Some(&late.stored())), None);
        assert_eq!(SwitchNotice::kept_in(None), None);
        assert_eq!(profile_id("safari:s-a"), "s-a");
        assert_eq!(profile_id("chrome:p-1:x"), "p-1:x");
        assert_eq!(profile_id("plain"), "plain");
    }

    #[test]
    fn stray_answers_do_nothing() {
        let mut r = Run::new(|_| {});
        r.s.answered(&mut r.w, 999, Ok(json!({ "windowId": 5 })), r.t);
        assert!(!r.s.busy() && r.w.requests.is_empty());
        r.s.tick(&mut r.w, r.t);
        assert!(!r.s.busy() && r.s.next_wake().is_none());
    }
}
