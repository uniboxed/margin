//! The hosts' model (docs/CORE-REFACTOR.md, step 2 part 1): what the hosting decisions read of each host, OS-neutral,
//! kept here so the decisions can move in one at a time. Each host by a handle (`u32`); its fields read and written by
//! the OS side through typed calls (the Mac's `Host` reads its own fields from here: no copy kept beside it). What's
//! the OS's own (its Space ids, tiles, toolbars, Accessibility's bookkeeping) stays on that side.
//!
//! No decision here yet (part 1a): the state alone. Reading and writing a field never allocates; a list of times
//! (returns, tries) is kept within its capacity (room for 8 from the start: the Mac keeps at most `returnsMax` + 1, 4).

use crate::geometry::Rect;

pub type Handle = u32;

/// A visible host's role in Margin's page area (docs/PEEK-SPLIT.md "Words").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Role {
    #[default]
    Main,
    Pane,
    Card,
}

/// Where a host is in its life: being made, shown in Margin's Space, parked out of sight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Preparing,
    Shown,
    Parked,
}

/// How it's shown: its window full screen, or its normal window (one that can't go full screen).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    FullScreen,
    Window,
}

/// A cut pane's window slid by its arrow: the pane it was slid in, its alignment along each axis (true: its end at
/// the pane's end; None: away from the other panes).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Slide {
    pub pane: Rect,
    pub end_x: Option<bool>,
    pub end_y: Option<bool>,
}

/// How much room each list of times has from the start.
pub const TIMES_ROOM: usize = 8;

/// One host's state (the Mac's `HostEngine.Host`, the fields the decisions read).
#[derive(Clone, Debug, PartialEq)]
pub struct HostState {
    pub id: String,
    /// The app's key: its bundle id (a Safari window's: Safari's).
    pub app: String,
    pub window: i64,
    pub pid: i64,
    pub role: Role,
    pub rect: Option<Rect>,
    pub slid: Option<Slide>,
    pub phase: Phase,
    pub mode: Mode,
    pub resizable: bool,
    pub placed_page: Option<Rect>,
    pub member: bool,
    /// Its window has a tile of its own (the tile's id is the OS side's).
    pub tiled: bool,
    pub no_tiles: bool,
    pub min_size: Option<(f64, f64)>,
    pub narrowest_held: Option<f64>,
    pub unread: i64,
    pub strays: i64,
    pub returns: Vec<f64>,
    pub off_screen_reads: i64,
    pub off_page_reads: i64,
    pub off_tries: Vec<f64>,
    pub off_said: bool,
    pub off_acted_for: Option<f64>,
    pub off_in_place_said: Option<f64>,
    pub visible_at: f64,
    pub reentries: Vec<f64>,
    pub reentry_said: bool,
    pub full_screen_failures: i64,
    pub retry_full_screen: bool,
    pub gone: bool,
    pub gone_at: Option<f64>,
    pub fresh_front: bool,
}

impl HostState {
    /// A new host as the Mac makes one: preparing, main, full screen, resizable, nothing counted.
    pub fn new(id: &str, app: &str, window: i64, pid: i64) -> Self {
        HostState {
            id: id.to_string(),
            app: app.to_string(),
            window,
            pid,
            role: Role::Main,
            rect: None,
            slid: None,
            phase: Phase::Preparing,
            mode: Mode::FullScreen,
            resizable: true,
            placed_page: None,
            member: false,
            tiled: false,
            no_tiles: false,
            min_size: None,
            narrowest_held: None,
            unread: 0,
            strays: 0,
            returns: Vec::with_capacity(TIMES_ROOM),
            off_screen_reads: 0,
            off_page_reads: 0,
            off_tries: Vec::with_capacity(TIMES_ROOM),
            off_said: false,
            off_acted_for: None,
            off_in_place_said: None,
            visible_at: 0.0,
            reentries: Vec::with_capacity(TIMES_ROOM),
            reentry_said: false,
            full_screen_failures: 0,
            retry_full_screen: false,
            gone: false,
            gone_at: None,
            fresh_front: false,
        }
    }
}

/// A field read or written by number (the FFI's `MarginModelField`): whole numbers and flags, times and lengths,
/// rects, lists of times. A field asked of the wrong kind answers nothing (0, none) and takes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Field {
    // Whole numbers and flags (as i64: a flag 0 or 1; an enum its index; an alignment -1 none, 0 start, 1 end).
    Window = 0,
    Pid = 1,
    Role = 2,
    Phase = 3,
    Mode = 4,
    Resizable = 5,
    Member = 6,
    Tiled = 7,
    NoTiles = 8,
    Unread = 9,
    Strays = 10,
    OffScreenReads = 11,
    OffPageReads = 12,
    OffSaid = 13,
    ReentrySaid = 14,
    FullScreenFailures = 15,
    RetryFullScreen = 16,
    Gone = 17,
    FreshFront = 18,
    SlidEndX = 19,
    SlidEndY = 20,
    // Times and lengths (f64; NaN: none).
    VisibleAt = 32,
    GoneAt = 33,
    OffActedFor = 34,
    OffInPlaceSaid = 35,
    NarrowestHeld = 36,
    // Rects (none: not set). A minimum size as a rect at 0,0; the slide by its pane (none: not slid).
    Rect = 64,
    PlacedPage = 65,
    MinSize = 66,
    SlidPane = 67,
    // Lists of times.
    Returns = 96,
    OffTries = 97,
    Reentries = 98,
}

impl Field {
    pub fn from_u32(v: u32) -> Option<Field> {
        use Field::*;
        Some(match v {
            0 => Window,
            1 => Pid,
            2 => Role,
            3 => Phase,
            4 => Mode,
            5 => Resizable,
            6 => Member,
            7 => Tiled,
            8 => NoTiles,
            9 => Unread,
            10 => Strays,
            11 => OffScreenReads,
            12 => OffPageReads,
            13 => OffSaid,
            14 => ReentrySaid,
            15 => FullScreenFailures,
            16 => RetryFullScreen,
            17 => Gone,
            18 => FreshFront,
            19 => SlidEndX,
            20 => SlidEndY,
            32 => VisibleAt,
            33 => GoneAt,
            34 => OffActedFor,
            35 => OffInPlaceSaid,
            36 => NarrowestHeld,
            64 => Rect,
            65 => PlacedPage,
            66 => MinSize,
            67 => SlidPane,
            96 => Returns,
            97 => OffTries,
            98 => Reentries,
            _ => return None,
        })
    }
}

fn flag(b: bool) -> i64 {
    i64::from(b)
}
fn align(a: Option<bool>) -> i64 {
    a.map_or(-1, i64::from)
}
fn from_align(v: i64) -> Option<bool> {
    match v {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// Every host of one engine, by handle. A handle is never given to two hosts at once; a removed one's is used again.
#[derive(Debug, Default)]
pub struct HostModel {
    slots: Vec<Option<HostState>>,
    free: Vec<Handle>,
}

impl HostModel {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new host's handle (rare: its first open).
    pub fn add(&mut self, id: &str, app: &str, window: i64, pid: i64) -> Handle {
        let state = HostState::new(id, app, window, pid);
        if let Some(h) = self.free.pop() {
            self.slots[h as usize] = Some(state);
            return h;
        }
        self.slots.push(Some(state));
        (self.slots.len() - 1) as Handle
    }

    /// The host gone: its handle free again. An unknown one: nothing.
    pub fn remove(&mut self, h: Handle) {
        if let Some(slot) = self.slots.get_mut(h as usize)
            && slot.take().is_some()
        {
            self.free.push(h);
        }
    }

    pub fn get(&self, h: Handle) -> Option<&HostState> {
        self.slots.get(h as usize).and_then(Option::as_ref)
    }
    pub fn get_mut(&mut self, h: Handle) -> Option<&mut HostState> {
        self.slots.get_mut(h as usize).and_then(Option::as_mut)
    }
    /// How many hosts it has.
    pub fn len(&self) -> usize {
        self.slots.iter().filter(|s| s.is_some()).count()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// A whole number or a flag (0: an unknown host, or a field of another kind).
    pub fn int(&self, h: Handle, f: Field) -> i64 {
        let Some(s) = self.get(h) else { return 0 };
        match f {
            Field::Window => s.window,
            Field::Pid => s.pid,
            Field::Role => s.role as i64,
            Field::Phase => s.phase as i64,
            Field::Mode => s.mode as i64,
            Field::Resizable => flag(s.resizable),
            Field::Member => flag(s.member),
            Field::Tiled => flag(s.tiled),
            Field::NoTiles => flag(s.no_tiles),
            Field::Unread => s.unread,
            Field::Strays => s.strays,
            Field::OffScreenReads => s.off_screen_reads,
            Field::OffPageReads => s.off_page_reads,
            Field::OffSaid => flag(s.off_said),
            Field::ReentrySaid => flag(s.reentry_said),
            Field::FullScreenFailures => s.full_screen_failures,
            Field::RetryFullScreen => flag(s.retry_full_screen),
            Field::Gone => flag(s.gone),
            Field::FreshFront => flag(s.fresh_front),
            Field::SlidEndX => s.slid.map_or(-1, |x| align(x.end_x)),
            Field::SlidEndY => s.slid.map_or(-1, |x| align(x.end_y)),
            _ => 0,
        }
    }

    /// Sets a whole number or a flag (a flag: anything but 0 is true; an enum out of range: its first). An alignment
    /// with no slide: nothing (the slide is made by its pane).
    pub fn set_int(&mut self, h: Handle, f: Field, v: i64) {
        let Some(s) = self.get_mut(h) else { return };
        let on = v != 0;
        match f {
            Field::Window => s.window = v,
            Field::Pid => s.pid = v,
            Field::Role => {
                s.role = match v {
                    1 => Role::Pane,
                    2 => Role::Card,
                    _ => Role::Main,
                }
            }
            Field::Phase => {
                s.phase = match v {
                    1 => Phase::Shown,
                    2 => Phase::Parked,
                    _ => Phase::Preparing,
                }
            }
            Field::Mode => s.mode = if v == 1 { Mode::Window } else { Mode::FullScreen },
            Field::Resizable => s.resizable = on,
            Field::Member => s.member = on,
            Field::Tiled => s.tiled = on,
            Field::NoTiles => s.no_tiles = on,
            Field::Unread => s.unread = v,
            Field::Strays => s.strays = v,
            Field::OffScreenReads => s.off_screen_reads = v,
            Field::OffPageReads => s.off_page_reads = v,
            Field::OffSaid => s.off_said = on,
            Field::ReentrySaid => s.reentry_said = on,
            Field::FullScreenFailures => s.full_screen_failures = v,
            Field::RetryFullScreen => s.retry_full_screen = on,
            Field::Gone => s.gone = on,
            Field::FreshFront => s.fresh_front = on,
            Field::SlidEndX => {
                if let Some(x) = s.slid.as_mut() {
                    x.end_x = from_align(v)
                }
            }
            Field::SlidEndY => {
                if let Some(x) = s.slid.as_mut() {
                    x.end_y = from_align(v)
                }
            }
            _ => {}
        }
    }

    /// A time or a length (None: not set, an unknown host, or a field of another kind).
    pub fn real(&self, h: Handle, f: Field) -> Option<f64> {
        let s = self.get(h)?;
        match f {
            Field::VisibleAt => Some(s.visible_at),
            Field::GoneAt => s.gone_at,
            Field::OffActedFor => s.off_acted_for,
            Field::OffInPlaceSaid => s.off_in_place_said,
            Field::NarrowestHeld => s.narrowest_held,
            _ => None,
        }
    }

    /// Sets a time or a length (None: unset; `visible_at` is always set, None leaves it).
    pub fn set_real(&mut self, h: Handle, f: Field, v: Option<f64>) {
        let Some(s) = self.get_mut(h) else { return };
        match f {
            Field::VisibleAt => {
                if let Some(v) = v {
                    s.visible_at = v
                }
            }
            Field::GoneAt => s.gone_at = v,
            Field::OffActedFor => s.off_acted_for = v,
            Field::OffInPlaceSaid => s.off_in_place_said = v,
            Field::NarrowestHeld => s.narrowest_held = v,
            _ => {}
        }
    }

    /// A rect (None: not set). The minimum size as a rect at 0,0.
    pub fn rect(&self, h: Handle, f: Field) -> Option<Rect> {
        let s = self.get(h)?;
        match f {
            Field::Rect => s.rect,
            Field::PlacedPage => s.placed_page,
            Field::MinSize => s.min_size.map(|(w, h)| Rect::new(0.0, 0.0, w, h)),
            Field::SlidPane => s.slid.map(|x| x.pane),
            _ => None,
        }
    }

    /// Sets a rect (None: unset). The slide's pane: a new slide (no alignment) when there was none, else its pane
    /// moved (its alignment kept); None: not slid.
    pub fn set_rect(&mut self, h: Handle, f: Field, v: Option<Rect>) {
        let Some(s) = self.get_mut(h) else { return };
        match f {
            Field::Rect => s.rect = v,
            Field::PlacedPage => s.placed_page = v,
            Field::MinSize => s.min_size = v.map(|r| (r.width, r.height)),
            Field::SlidPane => {
                s.slid = v.map(|pane| match s.slid {
                    Some(was) => Slide { pane, ..was },
                    None => Slide { pane, end_x: None, end_y: None },
                })
            }
            _ => {}
        }
    }

    /// A list of times (empty: an unknown host, or a field of another kind).
    pub fn times(&self, h: Handle, f: Field) -> &[f64] {
        let Some(s) = self.get(h) else { return &[] };
        match f {
            Field::Returns => &s.returns,
            Field::OffTries => &s.off_tries,
            Field::Reentries => &s.reentries,
            _ => &[],
        }
    }

    /// Sets a list of times (within its room: nothing allocated).
    pub fn set_times(&mut self, h: Handle, f: Field, v: &[f64]) {
        let Some(s) = self.get_mut(h) else { return };
        let list = match f {
            Field::Returns => &mut s.returns,
            Field::OffTries => &mut s.off_tries,
            Field::Reentries => &mut s.reentries,
            _ => return,
        };
        list.clear();
        list.extend_from_slice(v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_host_as_the_mac_makes_one() {
        let mut m = HostModel::new();
        let h = m.add("app:com.apple.TextEdit", "com.apple.TextEdit", 41, 500);
        let s = m.get(h).unwrap();
        assert_eq!(
            (s.id.as_str(), s.app.as_str(), s.window, s.pid),
            ("app:com.apple.TextEdit", "com.apple.TextEdit", 41, 500)
        );
        assert_eq!((s.role, s.phase, s.mode, s.resizable), (Role::Main, Phase::Preparing, Mode::FullScreen, true));
        assert_eq!(m.int(h, Field::Window), 41);
        assert_eq!(m.int(h, Field::Resizable), 1);
        assert_eq!(m.real(h, Field::VisibleAt), Some(0.0));
        assert_eq!(m.real(h, Field::GoneAt), None);
        assert_eq!(m.rect(h, Field::Rect), None);
        assert!(m.times(h, Field::Returns).is_empty());
    }

    #[test]
    fn handles_are_never_two_hosts_at_once() {
        let mut m = HostModel::new();
        let a = m.add("a", "x", 1, 1);
        let b = m.add("b", "x", 2, 1);
        assert_ne!(a, b);
        m.set_int(a, Field::Unread, 3);
        m.remove(a);
        assert_eq!(m.int(a, Field::Unread), 0, "gone: nothing read");
        m.set_int(a, Field::Unread, 5);
        assert!(m.get(a).is_none(), "gone: nothing written");
        let c = m.add("c", "x", 3, 1);
        assert_eq!(c, a, "its handle used again");
        assert_eq!(m.int(c, Field::Unread), 0, "a new host, nothing of the old one's");
        assert_eq!(m.len(), 2);
        m.remove(c);
        m.remove(c);
        m.remove(99);
        assert_eq!(m.len(), 1);
        assert_eq!(m.add("d", "x", 4, 1), a, "freed once, given once");
        assert_ne!(m.add("e", "x", 5, 1), a);
    }

    #[test]
    fn every_field_round_trips() {
        let mut m = HostModel::new();
        let h = m.add("a", "x", 1, 1);
        for (f, v) in [
            (Field::Window, 77),
            (Field::Pid, 900),
            (Field::Role, 2),
            (Field::Phase, 1),
            (Field::Mode, 1),
            (Field::Unread, 2),
            (Field::Strays, 4),
            (Field::OffScreenReads, 1),
            (Field::OffPageReads, 3),
            (Field::FullScreenFailures, 1),
        ] {
            m.set_int(h, f, v);
            assert_eq!(m.int(h, f), v, "{f:?}");
        }
        for f in [
            Field::Resizable,
            Field::Member,
            Field::Tiled,
            Field::NoTiles,
            Field::OffSaid,
            Field::ReentrySaid,
            Field::RetryFullScreen,
            Field::Gone,
            Field::FreshFront,
        ] {
            m.set_int(h, f, 1);
            assert_eq!(m.int(h, f), 1, "{f:?}");
            m.set_int(h, f, 0);
            assert_eq!(m.int(h, f), 0, "{f:?}");
        }
        let s = m.get(h).unwrap();
        assert_eq!((s.role, s.phase, s.mode), (Role::Card, Phase::Shown, Mode::Window));
        for f in [Field::GoneAt, Field::OffActedFor, Field::OffInPlaceSaid, Field::NarrowestHeld, Field::VisibleAt] {
            m.set_real(h, f, Some(12.5));
            assert_eq!(m.real(h, f), Some(12.5), "{f:?}");
        }
        m.set_real(h, Field::GoneAt, None);
        assert_eq!(m.real(h, Field::GoneAt), None);
        m.set_real(h, Field::VisibleAt, None);
        assert_eq!(m.real(h, Field::VisibleAt), Some(12.5), "always set");
        let r = Rect::new(10.0, 20.0, 300.0, 400.0);
        for f in [Field::Rect, Field::PlacedPage] {
            m.set_rect(h, f, Some(r));
            assert_eq!(m.rect(h, f), Some(r));
            m.set_rect(h, f, None);
            assert_eq!(m.rect(h, f), None);
        }
        m.set_rect(h, Field::MinSize, Some(Rect::new(0.0, 0.0, 701.0, 53.0)));
        assert_eq!(m.get(h).unwrap().min_size, Some((701.0, 53.0)));
        // Zero-size rects are rects (kept as they are, not taken for none).
        m.set_rect(h, Field::Rect, Some(Rect::ZERO));
        assert_eq!(m.rect(h, Field::Rect), Some(Rect::ZERO));
        // A field of another kind: nothing.
        assert_eq!(m.int(h, Field::Rect), 0);
        assert_eq!(m.real(h, Field::Window), None);
        assert_eq!(m.rect(h, Field::Window), None);
        m.set_int(h, Field::Returns, 3);
        assert!(m.times(h, Field::Returns).is_empty());
    }

    #[test]
    fn a_slide_by_its_pane_and_its_alignments() {
        let mut m = HostModel::new();
        let h = m.add("a", "x", 1, 1);
        m.set_int(h, Field::SlidEndX, 1);
        assert_eq!(m.get(h).unwrap().slid, None, "no slide: an alignment alone makes none");
        assert_eq!(m.int(h, Field::SlidEndX), -1);
        let pane = Rect::new(876.0, 41.0, 628.0, 933.0);
        m.set_rect(h, Field::SlidPane, Some(pane));
        assert_eq!(m.get(h).unwrap().slid, Some(Slide { pane, end_x: None, end_y: None }));
        m.set_int(h, Field::SlidEndX, 1);
        m.set_int(h, Field::SlidEndY, 0);
        assert_eq!((m.int(h, Field::SlidEndX), m.int(h, Field::SlidEndY)), (1, 0));
        let moved = Rect::new(800.0, 41.0, 700.0, 933.0);
        m.set_rect(h, Field::SlidPane, Some(moved));
        assert_eq!(m.get(h).unwrap().slid, Some(Slide { pane: moved, end_x: Some(true), end_y: Some(false) }), "kept");
        m.set_int(h, Field::SlidEndY, -1);
        assert_eq!(m.get(h).unwrap().slid.unwrap().end_y, None);
        m.set_rect(h, Field::SlidPane, None);
        assert_eq!(m.get(h).unwrap().slid, None);
    }

    #[test]
    fn lists_of_times() {
        let mut m = HostModel::new();
        let h = m.add("a", "x", 1, 1);
        m.set_times(h, Field::Returns, &[1.0, 2.0, 3.0]);
        assert_eq!(m.times(h, Field::Returns), &[1.0, 2.0, 3.0]);
        m.set_times(h, Field::OffTries, &[4.0]);
        m.set_times(h, Field::Reentries, &[]);
        assert_eq!(m.times(h, Field::OffTries), &[4.0]);
        assert!(m.times(h, Field::Reentries).is_empty());
        // Past its room: kept whole (grown), never cut short.
        let many: Vec<f64> = (0..20).map(f64::from).collect();
        m.set_times(h, Field::Returns, &many);
        assert_eq!(m.times(h, Field::Returns), many.as_slice());
    }

    #[test]
    fn every_field_number_is_its_own() {
        for v in 0..128u32 {
            if let Some(f) = Field::from_u32(v) {
                assert_eq!(f as u32, v);
            }
        }
    }
}
