//! The live-resize pump's scheduling (host/model/live.rs, step 2 part 6) on a hosting core, typed: a page frame of a
//! drag up to 120 a second, a tick of the pump every 2 ms while anything's owed or in flight, a send per follower per
//! frame. No JSON, nothing allocated (lists in fixed arrays of `LIVE_ROOM`, the most hosts a drag moves:
//! margin_ffi.h's `MARGIN_LIVE_ROOM`). Every call takes a null core, an unknown handle or null pointers without harm.

use margin_core::geometry::Rect;
use margin_core::host::api::HostCore;
use margin_core::host::model::{Handle, HostModel, LIVE_ROOM, LiveEvent, LiveSend, LiveTick, LiveTiming};

use crate::{MarginPlacement, MarginRect};

// (margin_ffi.h's MARGIN_LIVE_ROOM must be the core's.)
const _: () = assert!(LIVE_ROOM == 32);

/// The pump's timing: at most one change a host each `frame` seconds, a change given up after `wait`, landed within
/// `tolerance` points.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginLiveTiming {
    pub frame: f64,
    pub wait: f64,
    pub tolerance: f64,
}

/// A flight whose landing is read this tick: its host and its window.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginLiveRead {
    pub host: u32,
    pub window: i64,
}

/// Its window's bounds as read (`read` false: unread).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginLiveBounds {
    pub host: u32,
    pub read: bool,
    pub bounds: MarginRect,
}

/// A flight's end: landed after `elapsed` seconds, or (`landed` false) given up.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginLiveEvent {
    pub host: u32,
    pub landed: bool,
    pub elapsed: f64,
}

/// A tick's answer. `go` false: nothing sent this tick (an operation, Margin quitting, the drag held, the one shown
/// not shown), `held` a frame was owed, `stop` the pump ends (else it sleeps a frame). `go` true: `sends` hosts to send
/// `frame` to (in the sends buffer, in order), `shown` the one shown, `owed_empty` every follower sent it; then
/// `margin_live_done`. `events`: the flights' ends in the events buffer.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginLiveTick {
    pub go: bool,
    pub held: bool,
    pub stop: bool,
    pub owed_empty: bool,
    pub shown: u32,
    pub frame: MarginPlacement,
    pub events: usize,
    pub sends: usize,
}

/// What a host is sent of a frame: `kind` 0 nothing, 1 its tile's `rect` (its window lands at `page`), 2 its
/// window's frame `page` (`centred`: a fixed-size one centred in it at its own size).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarginLiveSend {
    pub kind: u8,
    pub centred: bool,
    pub rect: MarginRect,
    pub page: MarginRect,
}

/// # Safety
/// `core` null or a live core from `margin_host_new`, used by one thread at a time.
unsafe fn model<'a>(core: *mut HostCore) -> Option<&'a mut HostModel> {
    // SAFETY: the caller's contract.
    Some(&mut unsafe { core.as_mut() }?.model)
}

/// # Safety
/// `r` null or readable.
unsafe fn rect(r: *const MarginRect) -> Option<Rect> {
    // SAFETY: the caller's contract.
    unsafe { r.as_ref() }.map(|r| (*r).into())
}

/// Whether a drag is being followed.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_on(core: *mut HostCore) -> bool {
    // SAFETY: the contract above.
    unsafe { model(core) }.is_some_and(|m| m.live_on())
}

/// A drag begins at `now`: -1 not followed, else how many visible hosts other than the one shown follow it (into
/// `others`, back to front, the first `cap`).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `others` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_start(
    core: *mut HostCore,
    now: f64,
    quitting: bool,
    others: *mut u32,
    cap: usize,
) -> i32 {
    // SAFETY: the contract above.
    let Some(m) = (unsafe { model(core) }) else { return -1 };
    let mut o = [0; LIVE_ROOM];
    let Some(n) = m.live_start(now, quitting, &mut o) else { return -1 };
    if !others.is_null() {
        for (i, h) in o.iter().take(n.min(cap)).enumerate() {
            // SAFETY: `cap` writable.
            unsafe { *others.add(i) = *h };
        }
    }
    n as i32
}

/// The drag is over (false: none was followed).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_end(core: *mut HostCore) -> bool {
    // SAFETY: the contract above.
    unsafe { model(core) }.is_some_and(|m| m.live_end())
}

/// A page frame of the drag at `now` (false: no drag followed).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `p` null or readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_follow(core: *mut HostCore, now: f64, p: *const MarginPlacement) -> bool {
    // SAFETY: the contract above.
    let (Some(m), Some(p)) = (unsafe { model(core) }, unsafe { p.as_ref() }) else { return false };
    m.live_follow(now, (*p).into())
}

/// The one shown left its tile during this drag: not followed again until it's over.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_hold(core: *mut HostCore) {
    // SAFETY: the contract above.
    if let Some(m) = unsafe { model(core) } {
        m.live_hold();
    }
}

/// A drag never said over, no page area of it for longer than `forget` seconds: over.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_forgotten(core: *mut HostCore, now: f64, forget: f64) -> bool {
    // SAFETY: the contract above.
    unsafe { model(core) }.is_some_and(|m| m.live_forgotten(now, forget))
}

/// How many of the hosts a drag would move follow it; `visible` (null or writable) of how many.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `visible` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_followers(core: *mut HostCore, visible: *mut usize) -> usize {
    // SAFETY: the contract above.
    let (f, v) = unsafe { model(core) }.map_or((0, 0), |m| m.live_followers_count());
    if !visible.is_null() {
        // SAFETY: writable.
        unsafe { *visible = v };
    }
    f
}

/// A pump's run begins (nothing owed, in flight or sent yet).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_pump_begin(core: *mut HostCore) {
    // SAFETY: the contract above.
    if let Some(m) = unsafe { model(core) } {
        m.live_pump_begin();
    }
}

/// The flights whose landing is read this tick, into `out` (the first `cap`); how many.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null or `cap` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_reads(core: *mut HostCore, out: *mut MarginLiveRead, cap: usize) -> usize {
    // SAFETY: the contract above.
    let Some(m) = (unsafe { model(core) }) else { return 0 };
    let mut r = [(0, 0); LIVE_ROOM];
    let n = m.live_reads(&mut r);
    if !out.is_null() {
        for (i, (h, w)) in r.iter().take(n.min(cap)).enumerate() {
            // SAFETY: `cap` writable.
            unsafe { *out.add(i) = MarginLiveRead { host: *h, window: *w } };
        }
    }
    n
}

/// One tick of the pump at `now`: `reads` (`n` of them) the bounds read for `margin_live_reads`' flights; `busy` an
/// operation running; the flights' ends into `events` (the first `events_cap`), the hosts to send to into `sends`
/// (the first `sends_cap`: 16 holds every one), the answer into `out`.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `timing` null or readable (null: nothing done); `reads` null or
/// `n` readable; `events` null or `events_cap` writable; `sends` null or `sends_cap` writable; `out` null or writable.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn margin_live_tick(
    core: *mut HostCore,
    now: f64,
    timing: *const MarginLiveTiming,
    reads: *const MarginLiveBounds,
    n: usize,
    busy: bool,
    quitting: bool,
    events: *mut MarginLiveEvent,
    events_cap: usize,
    sends: *mut u32,
    sends_cap: usize,
    out: *mut MarginLiveTick,
) {
    // SAFETY: the contract above.
    let (Some(m), Some(t)) = (unsafe { model(core) }, unsafe { timing.as_ref() }) else { return };
    let mut r: [(Handle, Option<Rect>); LIVE_ROOM] = [(0, None); LIVE_ROOM];
    let k = if reads.is_null() { 0 } else { n.min(LIVE_ROOM) };
    for (i, slot) in r.iter_mut().take(k).enumerate() {
        // SAFETY: `n` readable.
        let b = unsafe { *reads.add(i) };
        *slot = (b.host, b.read.then(|| b.bounds.into()));
    }
    let mut ev = [LiveEvent::Missed { h: 0 }; LIVE_ROOM];
    let mut en = 0;
    let mut s = [0; LIVE_ROOM];
    let timing = LiveTiming { frame: t.frame, wait: t.wait, tolerance: t.tolerance };
    let tick = m.live_tick(now, timing, &r[..k], busy, quitting, &mut ev, &mut en, &mut s);
    let en = if events.is_null() { 0 } else { en.min(events_cap) };
    for (i, e) in ev.iter().take(en).enumerate() {
        let e = match *e {
            LiveEvent::Landed { h, elapsed } => MarginLiveEvent { host: h, landed: true, elapsed },
            LiveEvent::Missed { h } => MarginLiveEvent { host: h, landed: false, elapsed: 0.0 },
        };
        // SAFETY: `events_cap` writable.
        unsafe { *events.add(i) = e };
    }
    let answer = match tick {
        LiveTick::Gated { held, stop } => MarginLiveTick { held, stop, events: en, ..MarginLiveTick::default() },
        LiveTick::Go { sends: k, shown, frame, owed_empty } => {
            let k = if sends.is_null() { 0 } else { k.min(sends_cap) };
            for (i, h) in s.iter().take(k).enumerate() {
                // SAFETY: `sends_cap` writable.
                unsafe { *sends.add(i) = *h };
            }
            MarginLiveTick {
                go: true,
                owed_empty,
                shown,
                frame: frame.into(),
                events: en,
                sends: k,
                ..Default::default()
            }
        }
    };
    if !out.is_null() {
        // SAFETY: writable.
        unsafe { *out = answer };
    }
}

/// What `h` is sent of the frame `p` (`given` null: no rect of its own in this frame; `home` null: no tile of
/// Margin's), into `out`. Notes the hosts whose version it wanted (margin_model_versions_wanted): read only, so asked
/// again after.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `p`, `given`, `home` null or readable; `out` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_send(
    core: *mut HostCore,
    h: u32,
    p: *const MarginPlacement,
    given: *const MarginRect,
    home: *const MarginRect,
    out: *mut MarginLiveSend,
) {
    // SAFETY: the contract above.
    let (Some(m), Some(p)) = (unsafe { model(core) }, unsafe { p.as_ref() }) else { return };
    m.versions_clear();
    // SAFETY: the contract above.
    let send = m.live_send(h, &(*p).into(), unsafe { rect(given) }, unsafe { rect(home) });
    let answer = match send {
        LiveSend::None => MarginLiveSend::default(),
        LiveSend::Tile { rect, page } => {
            MarginLiveSend { kind: 1, centred: false, rect: rect.into(), page: page.into() }
        }
        LiveSend::Frame { page, centred } => {
            MarginLiveSend { kind: 2, centred, rect: MarginRect::default(), page: page.into() }
        }
    };
    if !out.is_null() {
        // SAFETY: writable.
        unsafe { *out = answer };
    }
}

/// `h` was sent at `at` (when its send began), its window to land at `want`.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_sent(core: *mut HostCore, h: u32, at: f64, want: MarginRect) {
    // SAFETY: the contract above.
    if let Some(m) = unsafe { model(core) } {
        m.live_sent(h, at, want.into());
    }
}

/// After a tick's sends: nothing pending, owed or in flight (the pump ends).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_live_done(core: *mut HostCore) -> bool {
    // SAFETY: the contract above.
    unsafe { model(core) }.is_none_or(|m| m.live_done())
}
