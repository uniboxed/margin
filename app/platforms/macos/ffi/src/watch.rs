//! What the poll and its looks decide of a host that isn't where it should be (host/model/watch.rs), typed: asked per
//! host per poll, nothing allocated. Every call takes a null core or an unknown handle without harm.

use margin_core::host::api::HostCore;
use margin_core::host::model::{Counted, Gone, Handle, OffFacts, OffScreen, Place, Read, Stray, still_off};

/// The poll's read of its window (`read`: 0 closed by its app, 1 its bounds unread, 2 read): 0 gone (twice in a row),
/// 1 skipped (unread this poll), 2 read.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_watch_poll_read(core: *mut HostCore, h: Handle, read: u8) -> u8 {
    // SAFETY: the contract above.
    let Some(core) = (unsafe { core.as_mut() }) else { return 1 };
    let read = match read {
        0 => Read::Closed,
        1 => Read::Unread,
        _ => Read::Read,
    };
    match core.model.poll_read(h, read) {
        Counted::Gone => 0,
        Counted::Skip => 1,
        Counted::Read => 2,
    }
}

/// Its window gone: `runs` its process read again (-1 not yet, 0 no, 1 yes), `parked_own` an app Margin started,
/// parked. 0 read its process and ask again, 1 nothing, 2 reopened at its next show, 3 the one shown's (the
/// reconciler's grace), 4 its window gone as any.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_watch_poll_gone(
    core: *mut HostCore,
    h: Handle,
    now: f64,
    runs: i8,
    parked_own: bool,
) -> u8 {
    // SAFETY: the contract above.
    let Some(core) = (unsafe { core.as_mut() }) else { return 1 };
    let runs = (runs >= 0).then_some(runs > 0);
    match core.model.poll_gone(h, now, runs, parked_own) {
        Gone::AskRuns => 0,
        Gone::Nothing => 1,
        Gone::Reopen => 2,
        Gone::Shown => 3,
        Gone::WindowGone => 4,
    }
}

/// Its window read, its place (0 unread, 1 in no Space, 2 in Margin's alone, 3 elsewhere) and Margin's window in its
/// Space: true, the one shown brought back in its turn.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_watch_poll_place(core: *mut HostCore, h: Handle, place: u8, margin_here: bool) -> bool {
    // SAFETY: the contract above.
    unsafe { core.as_mut() }.is_some_and(|c| c.model.poll_place(h, Place::from_u8(place), margin_here))
}

/// A stray in its turn, read again: 0 nothing, 1 parked with nothing shown, 2 parked alone (its returns spent,
/// `count` NULL or their number), 3 brought back.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `count` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_watch_stray(
    core: *mut HostCore,
    h: Handle,
    now: f64,
    place: u8,
    margin_here: bool,
    margin_now: bool,
    count: *mut u32,
) -> u8 {
    // SAFETY: the contract above.
    let Some(core) = (unsafe { core.as_mut() }) else { return 0 };
    match core.model.stray(h, now, Place::from_u8(place), margin_here, margin_now) {
        Stray::Nothing => 0,
        Stray::Park => 1,
        Stray::ParkOnly { count: n } => {
            if !count.is_null() {
                // SAFETY: writable.
                unsafe { *count = n as u32 };
            }
            2
        }
        Stray::PutBack => 3,
    }
}

/// Whether the on-screen look still finds something missing (`own_on`: the host's own read, -1 not read yet).
#[unsafe(no_mangle)]
pub extern "C" fn margin_watch_still_off(margin_on: bool, host_on: bool, own_on: i8) -> bool {
    still_off(margin_on, host_on, (own_on >= 0).then_some(own_on > 0))
}

/// A visible host off screen in its turn: 0 in place, 1 in place spent (say it), 2 in place spent (said), 4 given up
/// (say it, `count` the tries), 5 given up (said), 6 held by the loop guard's per-second hold (`guarded`; `until`),
/// 8 + bits act (1 Margin's Space made current, 2 its window moved in).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `count`, `until` null or writable.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn margin_watch_off_screen(
    core: *mut HostCore,
    h: Handle,
    now: f64,
    margin_on: bool,
    host_on: bool,
    current_is_margin: bool,
    place: u8,
    guarded: bool,
    count: *mut u32,
    until: *mut f64,
) -> u8 {
    // SAFETY: the contract above.
    let Some(core) = (unsafe { core.as_mut() }) else { return 5 };
    match core.off_screen(
        h,
        now,
        &OffFacts { margin_on, host_on, current_is_margin, place: Place::from_u8(place) },
        guarded,
    ) {
        OffScreen::InPlace => 0,
        OffScreen::InPlaceSpent { say } => {
            if say {
                1
            } else {
                2
            }
        }
        OffScreen::GiveUp { say, count: n } => {
            if !count.is_null() {
                // SAFETY: writable.
                unsafe { *count = n as u32 };
            }
            if say { 4 } else { 5 }
        }
        OffScreen::Held { until: u } => {
            if !until.is_null() {
                // SAFETY: writable.
                unsafe { *until = u };
            }
            6
        }
        OffScreen::Act { make_current, move_in } => 8 | u8::from(make_current) | (u8::from(move_in) << 1),
    }
}
