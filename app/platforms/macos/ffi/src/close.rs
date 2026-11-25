//! A host's close and the apps a row's close asked to quit (host/close.rs, host/exits.rs), typed: the close's
//! predicates by point with the host's facts as bits (no object, nothing allocated), the exits' reads the poll and the
//! panes-active keeper ask often (`has`, `overdue`). The exits' rare changes are JSON (`exitsAsked`, `exitsTakeBack`…).

use margin_core::host::api::HostCore;
use margin_core::host::close::{self, BeforeQuit, Exit, Facts, GiveBack};
use margin_core::host::exits::{self, Exiting, TakeBack};

/// # Safety
/// `ptr` null or `len` readable bytes.
unsafe fn text<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() {
        return (len == 0).then_some("");
    }
    // SAFETY: the caller's contract.
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).ok()
}

/// An app a row's close asked to quit at `at` (its pid, bundle, launch time: NaN unknown; the host's id), its times
/// kept exactly. False: a null core or text that isn't UTF-8.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `bundle`, `id` null or their lengths' readable bytes.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn margin_exits_asked(
    core: *mut HostCore,
    pid: i64,
    bundle: *const u8,
    bundle_len: usize,
    launched_at: f64,
    id: *const u8,
    id_len: usize,
    at: f64,
) -> bool {
    // SAFETY: the contract above.
    let (Some(c), Some(bundle), Some(id)) =
        (unsafe { core.as_mut() }, unsafe { text(bundle, bundle_len) }, unsafe { text(id, id_len) })
    else {
        return false;
    };
    let launched_at = (!launched_at.is_nan()).then_some(launched_at);
    c.exits.asked(Exiting { pid, bundle: bundle.into(), launched_at, id: id.into(), asked_at: at });
    true
}

/// Its exit heard: forgotten. False: none asked as that pid.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_exits_exited(core: *mut HostCore, pid: i64) -> bool {
    // SAFETY: the contract above.
    unsafe { core.as_mut() }.is_some_and(|c| c.exits.exited(pid).is_some())
}

/// `quit_wait` after its ask, the app running as that pid now (`running`: false none; its bundle and launch time, NaN
/// unknown): 0 none asked, 1 its exit unheard (forgotten), 2 still that launch: Margin's again (forgotten here).
///
/// # Safety
/// `core` null or a live core (one thread at a time); `bundle` null or `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_exits_take_back(
    core: *mut HostCore,
    pid: i64,
    running: bool,
    bundle: *const u8,
    len: usize,
    launched_at: f64,
) -> u8 {
    // SAFETY: the contract above.
    let Some(c) = (unsafe { core.as_mut() }) else { return 0 };
    // SAFETY: the contract above.
    let now = if running { unsafe { text(bundle, len) } } else { None };
    let launched_at = (!launched_at.is_nan()).then_some(launched_at);
    match c.exits.take_back(pid, now.map(|b| (b, launched_at))) {
        TakeBack::None => 0,
        TakeBack::Exited(_) => 1,
        TakeBack::Back(_) => 2,
    }
}

/// One of the close's decisions (`point`) with the host's facts (`facts`: host/close.rs `Facts`' fields as bits, in
/// order), how it waits (`exit`: 0 waited, 1 watched, 2 at Margin's quit), whether its app quits (`quits`) and the
/// point's own fact (`flag`: closed for 5, 6 and 8; in Margin's Space for 7 and 10). Points: 0 quit at once, 1 under
/// the freeze, 2 given back first (0 nothing, 1 its frame, 2 out of full screen), 3 its app quits, 4 its close button
/// asked of its app, 5 home after, 6 where before the quit matters, 7 before the quit (0 nothing, 1 home, 2 out of
/// sight), 8 a copy's window to the Desktop, 9 left to the person on the Desktop, 10 the marker keeps it (0 no, 1 yes,
/// 2 as a member). Booleans as 0 or 1; an unknown point 0.
#[unsafe(no_mangle)]
pub extern "C" fn margin_close_decide(point: u8, exit: u8, facts: u32, quits: bool, flag: bool) -> u8 {
    let f = Facts::from_bits(facts);
    let exit = match exit {
        1 => Exit::Watched,
        2 => Exit::AtQuit,
        _ => Exit::Waited,
    };
    match point {
        0 => u8::from(close::quit_at_once(exit, &f)),
        1 => u8::from(close::freeze(&f)),
        2 => match close::give_back(&f) {
            GiveBack::Nothing => 0,
            GiveBack::Frame => 1,
            GiveBack::OutOfFullScreen => 2,
        },
        3 => u8::from(close::quits(&f)),
        4 => u8::from(close::close_first_asks(quits, &f)),
        5 => u8::from(close::home_after(flag, &f)),
        6 => u8::from(close::before_quit_asks(quits, flag, &f)),
        7 => match close::before_quit(exit, flag, &f) {
            BeforeQuit::Nothing => 0,
            BeforeQuit::Home => 1,
            BeforeQuit::OutOfSight => 2,
        },
        8 => u8::from(close::copy_window_to_desktop(flag, quits, exit, &f)),
        9 => u8::from(close::left_to_the_person(&f)),
        10 => close::unfinished(flag, &f).map_or(0, |member| if member { 2 } else { 1 }),
        _ => 0,
    }
}

/// The crash recovery's rule for an app the marker kept (NaN: a time unknown).
#[unsafe(no_mangle)]
pub extern "C" fn margin_exits_same_marked_launch(then: f64, now: f64) -> bool {
    let known = |t: f64| (!t.is_nan()).then_some(t);
    exits::same_marked_launch(known(then), known(now))
}

/// Whether an app as `pid` was asked to quit by a row's close and isn't heard gone yet.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_exits_has(core: *mut HostCore, pid: i64) -> bool {
    // SAFETY: the contract above.
    unsafe { core.as_mut() }.is_some_and(|c| c.exits.has(pid))
}

/// How many are asked and not heard gone.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_exits_count(core: *mut HostCore) -> usize {
    // SAFETY: the contract above.
    unsafe { core.as_mut() }.map_or(0, |c| c.exits.len())
}

/// When the app as `pid` was asked (NaN: none).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_exits_asked_at(core: *mut HostCore, pid: i64) -> f64 {
    // SAFETY: the contract above.
    unsafe { core.as_mut() }.and_then(|c| c.exits.get(pid).map(|e| e.asked_at)).unwrap_or(f64::NAN)
}

/// The launch time of the app as `pid` asked to quit (NaN: none asked, or its time unknown).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_exits_launched_at(core: *mut HostCore, pid: i64) -> f64 {
    // SAFETY: the contract above.
    unsafe { core.as_mut() }.and_then(|c| c.exits.get(pid).and_then(|e| e.launched_at)).unwrap_or(f64::NAN)
}

/// The pids asked `quit_wait` or longer ago, in pid order, into `out` (`cap` of them at most); how many there are.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `out` null (cap 0) or `cap` writable entries.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_exits_overdue(
    core: *mut HostCore,
    now: f64,
    quit_wait: f64,
    out: *mut i64,
    cap: usize,
) -> usize {
    // SAFETY: the contract above.
    let Some(c) = (unsafe { core.as_mut() }) else { return 0 };
    let out: &mut [i64] = if out.is_null() || cap == 0 {
        &mut []
    } else {
        // SAFETY: `cap` writable entries.
        unsafe { std::slice::from_raw_parts_mut(out, cap) }
    };
    c.exits.overdue(now, quit_wait, out)
}
