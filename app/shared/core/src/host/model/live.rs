//! The live-resize pump's scheduling (docs/CORE-REFACTOR.md step 2 part 6): a drag of the sidebar's edge (or a split's
//! divider) followed by every visible host that can follow it (its window a tile, or a window-mode window), each at
//! most one change a display frame and one in flight, the newest frame winning, tiles first, each change waited for at
//! most the give-up wait. The OS side keeps every write (a tile's rect, a window's frame), every read of the window
//! server (each flight's bounds), its sleeps and the drag's numbers; it asks here at the same points it decided before:
//! the drag's start and end, each page frame (`live_follow`), each tick of its pump (`live_tick`), each send
//! (`live_send`, `live_sent`) and the tick's end (`live_done`).
//!
//! The pump's own state (the frame being sent, who's owed it, each one's flight and last send) lives one run of the
//! OS side's pump, as its locals did: `live_pump_begin` starts it afresh. It's kept per host by handle, and follows
//! the engine's hosts by id as the Swift's dictionaries by id did: a host held again as the same id takes its place
//! (`relisted`). Nothing allocated per frame or tick: the list has room for [`LIVE_ROOM`] hosts from the pump's first
//! run (a layout has at most `MAX_PANES` panes and a card visible).

use super::{Handle, HostModel, Mode, Phase};
use crate::geometry::{Rect, cg};
use crate::host::layout::{self, Placement};

/// The most hosts a drag moves (a layout has at most `MAX_PANES` panes and a card visible, with room to spare): the
/// lists' room, nothing allocated. margin_ffi.h's `MARGIN_LIVE_ROOM` is this.
pub const LIVE_ROOM: usize = 2 * crate::protocol::MAX_PANES;
const ROOM: usize = LIVE_ROOM;

/// A change sent and not landed yet: where its window should land, when it was sent, and whether its landing is read
/// (a fixed-size window-mode window's is taken as landed: it's centred at its own size).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Flight {
    want: Rect,
    at: f64,
    exact: bool,
}

/// One host's part of a pump's run (the Swift's `flights`, `lastSent` and `owed`, by id).
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    h: Handle,
    /// Its id once the engine holds no host as it (matched again when one is held as it: `relisted`).
    unlisted: Option<String>,
    flight: Option<Flight>,
    last_sent: Option<f64>,
    owed: bool,
}

/// The drag and the pump's run.
#[derive(Debug, Default)]
pub(super) struct Live {
    on: bool,
    /// The one shown left its tile in this drag: not followed again until it's over.
    held: bool,
    /// The drag's last page area's time (a drag never said over is over after a while).
    last: f64,
    /// The newest page frame, not taken by the pump yet.
    pending: Option<Placement>,
    /// The frame the pump is sending (until every follower owed it has been sent it).
    frame: Option<Placement>,
    entries: Vec<Entry>,
}

/// The pump's timing (the engine's options, as given: never sent through JSON, so a comparison at its edge is the
/// Swift's).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveTiming {
    /// At most one change a host this often (`liveFrame`).
    pub frame: f64,
    /// A change not landed after this long is given up (`liveWait`).
    pub wait: f64,
    /// A window's bounds this near its change's rect: landed (`tolerance`).
    pub tolerance: f64,
}

/// A flight's end this tick: landed after `elapsed` seconds, or given up.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LiveEvent {
    Landed { h: Handle, elapsed: f64 },
    Missed { h: Handle },
}

/// A tick's answer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LiveTick {
    /// An operation running, Margin quitting, the drag held or the one shown not shown: nothing sent this tick.
    /// `held`: a frame was owed (counted as held by an operation); `stop`: nothing owed and nothing in flight (the
    /// pump ends); else it sleeps a frame.
    Gated { held: bool, stop: bool },
    /// `sends` hosts to send `frame` to, in order (tiles first), each taken off the owed (none: nothing owed, or
    /// none free for it yet); `shown` the one shown; `owed_empty` every follower sent the frame (a frame sent to
    /// every one that follows). Then `live_done` says whether the pump ends.
    Go { sends: usize, shown: Handle, frame: Placement, owed_empty: bool },
}

/// What one host is sent of a frame (`live_send`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LiveSend {
    /// Nothing (not shown, not one that follows, or a card's rect below its minimum).
    None,
    /// Its tile's rect; `page` where its window lands.
    Tile { rect: Rect, page: Rect },
    /// Its window's frame by Accessibility: `page` (a fixed-size one centred in it at its own size, `centred`).
    Frame { page: Rect, centred: bool },
}

impl HostModel {
    // ---- the drag ----

    /// Whether a drag is being followed.
    pub fn live_on(&self) -> bool {
        self.live.on
    }

    /// A host that follows a drag: a tile, or a window-mode window.
    fn follows(&self, h: Handle) -> bool {
        self.get(h).is_some_and(|s| s.tiled || s.mode == Mode::Window)
    }

    /// The one shown, held and shown now.
    fn shown_shown(&self) -> Option<Handle> {
        let h = self.listed(self.shown()?)?;
        (self.get(h)?.phase == Phase::Shown).then_some(h)
    }

    /// A drag begins at `now`: followed when the one shown is shown and it or another visible host follows. Into
    /// `others` the visible ones other than the one shown that follow (back to front: their minimums read once as it
    /// begins); how many, None: not followed (one under way already, Margin quitting, nothing to follow).
    pub fn live_start(&mut self, now: f64, quitting: bool, others: &mut [Handle]) -> Option<usize> {
        let mut all = [0; ROOM];
        let n = self.visible_hosts(&mut all);
        let mut count = 0;
        let shown = self.shown();
        for &h in &all[..n.min(ROOM)] {
            if self.get(h).is_some_and(|s| shown != Some(s.id.as_str())) && self.follows(h) {
                if count < others.len() {
                    others[count] = h;
                }
                count += 1;
            }
        }
        if self.live.on || quitting {
            return None;
        }
        let h = self.shown_shown()?;
        if !self.follows(h) && count == 0 {
            return None;
        }
        self.live.on = true;
        self.live.held = false;
        self.live.last = now;
        Some(count)
    }

    /// The drag is over: false, none was followed. Its page area and its pending frame forgotten (a pump still
    /// running ends at its next tick).
    pub fn live_end(&mut self) -> bool {
        if !self.live.on {
            return false;
        }
        self.live.on = false;
        self.live.held = false;
        self.live.pending = None;
        self.live_page = None;
        true
    }

    /// A page frame of the drag at `now`: the newest, the drag's page area. False: no drag followed.
    pub fn live_follow(&mut self, now: f64, p: Placement) -> bool {
        if !self.live.on {
            return false;
        }
        self.live.last = now;
        self.live.pending = Some(p);
        self.live_page = Some(p.page);
        true
    }

    /// The one shown left its tile during this drag: not followed again until it's over.
    pub fn live_hold(&mut self) {
        if self.live.on {
            self.live.held = true;
        }
    }

    /// A drag never said over, no page area of it for longer than `forget`: over.
    pub fn live_forgotten(&self, now: f64, forget: f64) -> bool {
        self.live.on && now - self.live.last > forget
    }

    /// The hosts a drag moves: every visible one with several laid out, else the one shown (whatever its phase).
    fn candidates(&self, out: &mut [Handle; ROOM]) -> usize {
        if self.layout_len() > 1 {
            return self.visible_hosts(out).min(ROOM);
        }
        match self.shown().and_then(|s| self.listed(s)) {
            Some(h) if self.get(h).is_some() => {
                out[0] = h;
                1
            }
            _ => 0,
        }
    }

    /// How many of the hosts a drag would move follow it, of how many (the session's word before a drag: each counted
    /// as it is, its phase not asked).
    pub fn live_followers_count(&self) -> (usize, usize) {
        let mut c = [0; ROOM];
        let n = self.candidates(&mut c);
        (c[..n].iter().filter(|h| self.follows(**h)).count(), n)
    }

    /// The drag's followers now: the hosts it moves that follow it and are shown, the one shown first. Into `out`; how
    /// many.
    pub fn live_followers(&self, out: &mut [Handle; ROOM]) -> usize {
        let mut c = [0; ROOM];
        let n = self.candidates(&mut c);
        let shown = self.shown();
        let mut k = 0;
        for first in [true, false] {
            for &h in &c[..n] {
                let Some(s) = self.get(h) else { continue };
                if (shown == Some(s.id.as_str())) == first && s.phase == Phase::Shown && self.follows(h) {
                    out[k] = h;
                    k += 1;
                }
            }
        }
        k
    }

    // ---- the pump ----

    /// A pump's run begins: nothing owed, in flight or sent yet (the frame pending kept).
    pub fn live_pump_begin(&mut self) {
        self.live.frame = None;
        self.live.entries.clear();
        if self.live.entries.capacity() < ROOM {
            self.live.entries.reserve(ROOM);
        }
    }

    fn entry(&self, h: Handle) -> Option<usize> {
        self.live.entries.iter().position(|e| e.unlisted.is_none() && e.h == h)
    }

    /// The flights whose landing is read this tick (a host held, its change exact): each host and its window, into
    /// `out`; how many (the first `out.len()` when more).
    pub fn live_reads(&self, out: &mut [(Handle, i64)]) -> usize {
        let mut n = 0;
        for e in &self.live.entries {
            if e.unlisted.is_none()
                && e.flight.is_some_and(|f| f.exact)
                && let Some(s) = self.get(e.h)
            {
                if n < out.len() {
                    out[n] = (e.h, s.window);
                }
                n += 1;
            }
        }
        n
    }

    /// One tick of the pump at `now`, each exact flight's window's bounds read (`reads`, None: unread). The flights
    /// landed or given up (into `events`: the first `events.len()`), the newest frame taken (every follower owed it),
    /// then the gate (`busy`: an operation running; `quitting`), then the followers free for it (owed, none in flight,
    /// a frame's time since their last), tiles first, into `sends`.
    #[allow(clippy::too_many_arguments)]
    pub fn live_tick(
        &mut self,
        now: f64,
        t: LiveTiming,
        reads: &[(Handle, Option<Rect>)],
        busy: bool,
        quitting: bool,
        events: &mut [LiveEvent],
        events_n: &mut usize,
        sends: &mut [Handle; ROOM],
    ) -> LiveTick {
        // (Landed, or given up on after the wait: free for the next frame. A host no longer held: forgotten.)
        let mut entries = std::mem::take(&mut self.live.entries);
        let mut ne = 0;
        for e in entries.iter_mut() {
            let Some(f) = e.flight else { continue };
            if e.unlisted.is_some() {
                e.flight = None;
                continue;
            }
            let there = !f.exact
                || reads
                    .iter()
                    .find(|r| r.0 == e.h)
                    .and_then(|r| r.1)
                    .is_some_and(|b| layout::near(&b, &f.want, t.tolerance));
            let event = if there {
                if self.get(e.h).is_some_and(|s| s.tiled) {
                    self.held(e.h, cg::standard(&f.want).width);
                }
                e.flight = None;
                Some(LiveEvent::Landed { h: e.h, elapsed: now - f.at })
            } else if now - f.at >= t.wait {
                e.flight = None;
                Some(LiveEvent::Missed { h: e.h })
            } else {
                None
            };
            if let Some(ev) = event {
                if ne < events.len() {
                    events[ne] = ev;
                }
                ne += 1;
            }
        }
        self.live.entries = entries;
        *events_n = ne.min(events.len());
        // (The newest frame: every follower owed it.)
        if let Some(p) = self.live.pending.take() {
            self.live.frame = Some(p);
            for e in self.live.entries.iter_mut() {
                e.owed = false;
            }
            let mut f = [0; ROOM];
            let n = self.live_followers(&mut f);
            for &h in &f[..n] {
                match self.entry(h) {
                    Some(i) => self.live.entries[i].owed = true,
                    None => {
                        self.live.entries.push(Entry { h, unlisted: None, flight: None, last_sent: None, owed: true })
                    }
                }
            }
        }
        let owed = |l: &Live| l.entries.iter().any(|e| e.owed);
        let flying = |l: &Live| l.entries.iter().any(|e| e.flight.is_some());
        // (An operation running, or the one shown left its tile in this drag: held a frame, the newest kept.)
        let shown = if busy || quitting || self.live.held { None } else { self.shown_shown() };
        let Some(shown) = shown else {
            let any_owed = owed(&self.live);
            return LiveTick::Gated {
                held: self.live.frame.is_some() && any_owed,
                stop: (self.live.frame.is_none() || !any_owed) && !flying(&self.live),
            };
        };
        let Some(frame) = self.live.frame.filter(|_| owed(&self.live)) else {
            return LiveTick::Go { sends: 0, shown, frame: Placement::ZERO, owed_empty: !owed(&self.live) };
        };
        let mut f = [0; ROOM];
        let n = self.live_followers(&mut f);
        let mut k = 0;
        for &h in &f[..n] {
            let Some(e) = self.entry(h).map(|i| &self.live.entries[i]) else { continue };
            if e.owed && e.flight.is_none() && now - e.last_sent.unwrap_or(f64::NEG_INFINITY) >= t.frame - 1e-6 {
                sends[k] = h;
                k += 1;
            }
        }
        // (Tiles first, nothing awaited between them; a window-mode window's frame after. Stable: the order kept.)
        sends[..k].sort_by_key(|h| !self.get(*h).is_some_and(|s| s.tiled));
        for &h in &sends[..k] {
            if let Some(i) = self.entry(h) {
                self.live.entries[i].owed = false;
            }
        }
        let owed_empty = !owed(&self.live);
        if owed_empty {
            self.live.frame = None;
        }
        LiveTick::Go { sends: k, shown, frame, owed_empty }
    }

    /// What `h` is sent of the frame `p` (`given`: its rect in this frame as the page measured it; `home`: Margin's
    /// own tile, None: none): at its rect in the frame, else its own, else the page area; another than the one shown
    /// never below its minimum; a tile's rect (its window's frame for that page area), else a window-mode window's
    /// frame. Read only: asked again after a version is read.
    pub fn live_send(&self, h: Handle, p: &Placement, given: Option<Rect>, home: Option<Rect>) -> LiveSend {
        let Some(s) = self.get(h) else { return LiveSend::None };
        if s.phase != Phase::Shown || !(s.tiled || s.mode == Mode::Window) {
            return LiveSend::None;
        }
        let mut q = *p;
        q.page = given.or(s.rect).unwrap_or(p.page);
        // (Never narrower than its window's own minimum: a comparison, nothing read.)
        if self.shown() != Some(s.id.as_str()) && (s.rect.is_some() || given.is_some()) {
            let (below, needs) = self.below_minimum(h, Some(q.page));
            if needs {
                self.wanted.note(h);
            }
            if below {
                return LiveSend::None;
            }
        }
        let page = if s.tiled { self.frame(h, Some(&q)) } else { q.page };
        if s.tiled
            && let Some(home) = home
            && let Some(rect) = self.tile_rect(h, Some(&q), &home)
        {
            return LiveSend::Tile { rect, page };
        }
        if s.mode == Mode::Window {
            return LiveSend::Frame { page, centred: !s.resizable };
        }
        LiveSend::None
    }

    /// `h` was sent at `at` (when its send began), its window to land at `want`. Kept as its id's, as the Swift's
    /// dictionaries by id: the host the engine holds as that id now (another, if it was made again while this one's
    /// send was awaited), or that id's part kept for one held as it later.
    pub fn live_sent(&mut self, h: Handle, at: f64, want: Rect) {
        let Some(s) = self.get(h) else { return };
        let exact = s.mode != Mode::Window || s.resizable;
        let flight = Some(Flight { want, at, exact });
        let i = match self.listed(&s.id) {
            Some(now) => {
                self.entry(now).ok_or(Entry { h: now, unlisted: None, flight: None, last_sent: None, owed: false })
            }
            None => {
                let id = s.id.as_str();
                self.live.entries.iter().position(|e| e.unlisted.as_deref() == Some(id)).ok_or_else(|| Entry {
                    h,
                    unlisted: Some(id.to_string()),
                    flight: None,
                    last_sent: None,
                    owed: false,
                })
            }
        };
        let i = i.unwrap_or_else(|e| {
            self.live.entries.push(e);
            self.live.entries.len() - 1
        });
        let e = &mut self.live.entries[i];
        e.flight = flight;
        e.last_sent = Some(at);
    }

    /// After a tick's sends: nothing pending, owed or in flight (the pump ends).
    pub fn live_done(&self) -> bool {
        self.live.frame.is_none() && self.live.pending.is_none() && self.live.entries.iter().all(|e| e.flight.is_none())
    }

    /// The engine now holds `now` as `id` (it held `was`): the pump's part of the host it held follows the id, as the
    /// Swift's dictionaries by id did (a host gone keeps its id's part until one is held as it again).
    pub(super) fn relisted(&mut self, id: &str, was: Option<Handle>, now: Option<Handle>) {
        if self.live.entries.is_empty() || was == now {
            return;
        }
        for e in self.live.entries.iter_mut() {
            if e.unlisted.is_none() && was == Some(e.h) {
                match now {
                    Some(h) => e.h = h,
                    None => e.unlisted = Some(id.to_string()),
                }
            } else if let Some(h) = now
                && e.unlisted.as_deref() == Some(id)
            {
                e.h = h;
                e.unlisted = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::model::{Field, Role, Visible};

    const PAGE: Rect = Rect::new(276.0, 41.0, 1228.0, 933.0);
    const AREA: Rect = Rect::new(0.0, 33.0, 1512.0, 949.0);
    const T: LiveTiming = LiveTiming { frame: 1.0 / 120.0, wait: 0.05, tolerance: 1.0 };

    fn placed(page: Rect) -> Placement {
        Placement { page, area: AREA, display: Rect::new(0.0, 0.0, 1512.0, 982.0) }
    }

    /// A model with hosts shown and listed, laid out (several: as panes), `first` the one shown.
    fn world(hosts: &[(&str, bool, Mode)]) -> (HostModel, Vec<Handle>) {
        let mut m = HostModel::new();
        let mut hs = vec![];
        for (i, (id, tiled, mode)) in hosts.iter().enumerate() {
            let h = m.add(id, "com.apple.TextEdit", 40 + i as i64, 500 + i as i64);
            m.list(id, Some(h));
            m.set_int(h, Field::Phase, 1);
            m.set_int(h, Field::Tiled, i64::from(*tiled));
            m.set_int(h, Field::Mode, if *mode == Mode::Window { 1 } else { 0 });
            hs.push(h);
        }
        if hosts.len() > 1 {
            for (i, (id, _, _)) in hosts.iter().enumerate() {
                let rect = Rect::new(276.0 + 620.0 * i as f64, 41.0, 600.0, 933.0);
                let role = if i == 0 { Role::Main } else { Role::Pane };
                m.layout_set(id, Some(Visible { rect: Some(rect), role, z: i as i64 }));
                m.set_rect(hs[i], Field::Rect, Some(rect));
                m.set_int(hs[i], Field::Role, role as i64);
            }
        }
        m.set_shown(Some(hosts[0].0), 0.0);
        (m, hs)
    }

    struct Tick {
        tick: LiveTick,
        events: Vec<LiveEvent>,
        sends: Vec<Handle>,
    }

    fn tick(m: &mut HostModel, now: f64, reads: &[(Handle, Option<Rect>)], busy: bool) -> Tick {
        let mut events = [LiveEvent::Missed { h: 0 }; ROOM];
        let mut n = 0;
        let mut sends = [0; ROOM];
        let tick = m.live_tick(now, T, reads, busy, false, &mut events, &mut n, &mut sends);
        let k = if let LiveTick::Go { sends, .. } = tick { sends } else { 0 };
        Tick { tick, events: events[..n].to_vec(), sends: sends[..k].to_vec() }
    }

    #[test]
    fn a_drag_starts_only_with_something_to_follow() {
        let (mut m, hs) = world(&[("a", false, Mode::FullScreen)]);
        let mut others = [0; ROOM];
        assert_eq!(m.live_start(1.0, false, &mut others), None);
        m.set_int(hs[0], Field::Tiled, 1);
        assert_eq!(m.live_start(1.0, true, &mut others), None);
        assert_eq!(m.live_start(1.0, false, &mut others), Some(0));
        assert!(m.live_on());
        assert_eq!(m.live_start(1.0, false, &mut others), None, "one at a time");
        assert!(m.live_end());
        assert!(!m.live_end());
        // (A split: the one shown not a tile, the other one is: followed, the other's minimum read.)
        let (mut m, hs) = world(&[("a", false, Mode::FullScreen), ("b", true, Mode::FullScreen)]);
        assert_eq!(m.live_start(1.0, false, &mut others), Some(1));
        assert_eq!(others[0], hs[1]);
    }

    #[test]
    fn one_in_flight_the_newest_wins_and_the_wait_gives_up() {
        let (mut m, hs) = world(&[("a", true, Mode::FullScreen)]);
        let h = hs[0];
        m.live_start(0.0, false, &mut [0; ROOM]);
        m.live_pump_begin();
        assert!(m.live_follow(0.0, placed(PAGE)));
        let t = tick(&mut m, 0.0, &[], false);
        assert_eq!(t.sends, vec![h]);
        assert!(matches!(t.tick, LiveTick::Go { owed_empty: true, .. }));
        m.live_sent(h, 0.0, PAGE);
        assert!(!m.live_done());
        // (Three frames while it's in flight: only the newest is sent, once it lands.)
        let newest = Rect::new(300.0, 41.0, 1204.0, 933.0);
        for x in [280.0, 290.0, 300.0] {
            m.live_follow(0.001, placed(Rect::new(x, 41.0, 1504.0 - x, 933.0)));
        }
        let mut r = [(0, 0); ROOM];
        assert_eq!(m.live_reads(&mut r), 1);
        assert_eq!(r[0], (h, 40));
        let t = tick(&mut m, 0.002, &[(h, Some(Rect::new(0.0, 0.0, 10.0, 10.0)))], false);
        assert!(t.events.is_empty() && t.sends.is_empty(), "still in flight");
        let t = tick(&mut m, 0.004, &[(h, Some(PAGE))], false);
        assert_eq!(t.events, vec![LiveEvent::Landed { h, elapsed: 0.004 }]);
        assert!(t.sends.is_empty(), "landed, within a frame of its last send");
        let t = tick(&mut m, 0.009, &[], false);
        assert_eq!(t.sends, vec![h]);
        let LiveTick::Go { frame, .. } = t.tick else { panic!() };
        assert_eq!(frame.page, newest);
        m.live_sent(h, 0.009, newest);
        // (Never there: given up at the wait, exactly.)
        assert!(tick(&mut m, 0.009 + 0.049, &[(h, None)], false).events.is_empty());
        assert_eq!(tick(&mut m, 0.009 + 0.05, &[(h, None)], false).events, vec![LiveEvent::Missed { h }]);
        assert!(m.live_done());
        // (The narrowest width a tile held, kept for its minimum.)
        assert_eq!(m.real(h, Field::NarrowestHeld), Some(1228.0));
    }

    #[test]
    fn a_frames_throttle_per_host_and_tiles_first() {
        let (mut m, hs) =
            world(&[("a", false, Mode::Window), ("b", true, Mode::FullScreen), ("c", true, Mode::FullScreen)]);
        m.set_int(hs[0], Field::Resizable, 1);
        assert_eq!(m.live_start(0.0, false, &mut [0; ROOM]), Some(2));
        m.live_pump_begin();
        m.live_follow(0.0, placed(PAGE));
        let t = tick(&mut m, 0.0, &[], false);
        assert_eq!(t.sends, vec![hs[1], hs[2], hs[0]], "the one shown first, then tiles first");
        for &h in &t.sends {
            m.live_sent(h, 0.0, PAGE);
        }
        // (Landed at once, a new frame: not sent again within a frame's time of the last.)
        m.live_follow(0.001, placed(PAGE));
        let reads: Vec<_> = hs.iter().map(|h| (*h, Some(PAGE))).collect();
        let t = tick(&mut m, 1.0 / 120.0 - 2e-6, &reads, false);
        assert_eq!(t.events.len(), 3);
        assert!(t.sends.is_empty());
        let t = tick(&mut m, 1.0 / 120.0 - 1e-6, &[], false);
        assert_eq!(t.sends, vec![hs[1], hs[2], hs[0]], "at the frame's time less a microsecond");
    }

    #[test]
    fn an_operation_holds_the_frame_and_the_newest_is_kept() {
        let (mut m, hs) = world(&[("a", true, Mode::FullScreen)]);
        m.live_start(0.0, false, &mut [0; ROOM]);
        m.live_pump_begin();
        m.live_follow(0.0, placed(PAGE));
        assert_eq!(tick(&mut m, 0.0, &[], true).tick, LiveTick::Gated { held: true, stop: false });
        m.live_follow(0.001, placed(AREA));
        assert_eq!(tick(&mut m, 0.002, &[], true).tick, LiveTick::Gated { held: true, stop: false });
        let t = tick(&mut m, 0.004, &[], false);
        let LiveTick::Go { sends: 1, frame, .. } = t.tick else { panic!("{:?}", t.tick) };
        assert_eq!(frame.page, AREA);
        // (Held by the drag itself: the one shown left its tile.)
        m.live_sent(hs[0], 0.004, AREA);
        m.live_hold();
        m.live_follow(0.005, placed(PAGE));
        let t = tick(&mut m, 0.006, &[(hs[0], Some(AREA))], false);
        assert_eq!(t.tick, LiveTick::Gated { held: true, stop: false });
        assert_eq!(t.events.len(), 1, "a flight lands while held");
        assert!(m.live_end());
        assert!(m.live_page().is_none());
    }

    #[test]
    fn a_follower_leaving_mid_drag_and_made_again_as_the_same_id() {
        let (mut m, hs) = world(&[("a", true, Mode::FullScreen), ("b", true, Mode::FullScreen)]);
        let (a, b) = (hs[0], hs[1]);
        m.live_start(0.0, false, &mut [0; ROOM]);
        m.live_pump_begin();
        m.live_follow(0.0, placed(PAGE));
        assert_eq!(tick(&mut m, 0.0, &[], false).sends, vec![a, b]);
        m.live_sent(a, 0.0, PAGE);
        m.live_sent(b, 0.0, PAGE);
        // (b's host gone: its flight forgotten, never read or counted.)
        m.list("b", None);
        let mut r = [(0, 0); ROOM];
        assert_eq!(m.live_reads(&mut r), 1);
        let t = tick(&mut m, 0.001, &[(a, Some(PAGE))], false);
        assert_eq!(t.events, vec![LiveEvent::Landed { h: a, elapsed: 0.001 }]);
        assert!(m.live_done());
        // (Made again as the same id, another handle: its last send's time its id's, so within a frame of it it
        // waits as the old one would have.)
        let b2 = m.add("b", "com.apple.Notes", 77, 600);
        m.set_int(b2, Field::Phase, 1);
        m.set_int(b2, Field::Tiled, 1);
        m.layout_set("b", Some(Visible { rect: Some(Rect::new(896.0, 41.0, 600.0, 933.0)), role: Role::Pane, z: 1 }));
        m.list("b", Some(b2));
        m.live_follow(0.002, placed(AREA));
        assert!(tick(&mut m, 0.003, &[], false).sends.is_empty());
        assert_eq!(tick(&mut m, 1.0 / 120.0, &[], false).sends, vec![a, b2]);
        m.live_sent(a, 1.0 / 120.0, AREA);
        m.live_sent(b2, 1.0 / 120.0, AREA);
        // (A frame owed while an operation runs, the host made again meanwhile: the new one owed it.)
        let reads = [(a, Some(AREA)), (b2, Some(AREA))];
        m.live_follow(0.01, placed(PAGE));
        assert!(matches!(tick(&mut m, 0.011, &reads, true).tick, LiveTick::Gated { held: true, .. }));
        m.list("b", None);
        let b3 = m.add("b", "com.apple.Notes", 78, 600);
        m.set_int(b3, Field::Phase, 1);
        m.set_int(b3, Field::Tiled, 1);
        m.list("b", Some(b3));
        assert_eq!(tick(&mut m, 0.03, &[], false).sends, vec![a, b3]);
    }

    #[test]
    fn the_one_shown_freed_before_it_is_let_go() {
        // (The engine lets a host go and its last reference frees it at once: removed while still held as its id,
        // `list` told after. Its flight forgotten at the next tick, never read or given up; the pump ends then.)
        let (mut m, hs) = world(&[("a", false, Mode::Window)]);
        m.set_int(hs[0], Field::Resizable, 1);
        m.live_start(0.0, false, &mut [0; ROOM]);
        m.live_pump_begin();
        m.live_follow(0.0, placed(PAGE));
        assert_eq!(tick(&mut m, 0.0, &[], false).sends, vec![hs[0]]);
        m.live_sent(hs[0], 0.0, PAGE);
        m.remove(hs[0]);
        m.list("a", None);
        assert_eq!(m.live_reads(&mut [(0, 0); ROOM]), 0);
        let t = tick(&mut m, 0.002, &[], false);
        assert_eq!(t.tick, LiveTick::Gated { held: false, stop: true });
        assert!(t.events.is_empty());
    }

    #[test]
    fn the_counts_the_session_reads() {
        let (m, _) = world(&[("a", true, Mode::FullScreen), ("b", false, Mode::FullScreen)]);
        assert_eq!(m.live_followers_count(), (1, 2));
        let (mut m, hs) = world(&[("a", true, Mode::FullScreen)]);
        m.set_int(hs[0], Field::Phase, 2);
        assert_eq!(m.live_followers_count(), (1, 1), "the one shown counted whatever its phase");
        let mut f = [0; ROOM];
        assert_eq!(m.live_followers(&mut f), 0, "the drag's own: shown ones only");
    }

    #[test]
    fn a_forgotten_drag() {
        let (mut m, _) = world(&[("a", true, Mode::FullScreen)]);
        assert!(!m.live_forgotten(100.0, 10.0));
        m.live_start(1.0, false, &mut [0; ROOM]);
        assert!(!m.live_forgotten(11.0, 10.0));
        assert!(m.live_forgotten(11.000001, 10.0));
        m.live_follow(5.0, placed(PAGE));
        assert!(!m.live_forgotten(15.0, 10.0));
    }
}
