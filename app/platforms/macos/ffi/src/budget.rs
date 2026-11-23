//! The budgets of Margin's own corrections and the full-screen ladder (host/model/budget.rs), typed: asked by
//! handle, nothing allocated but a cut pane's first repair (its id kept). Every call takes a null core or an unknown
//! handle without harm.

use margin_core::host::api::HostCore;
use margin_core::host::model::{BudgetKind, Handle, Spend};

/// A budget asked before its action (`kind`: 0 a stray's returns, 1 a re-entry into full screen, 2 off screen in
/// place, 3 off screen elsewhere, 4 a cut pane's repair) at `now`: 0 go, 1 spent and to be said, 2 spent (said
/// already, or nothing to say), 3 spent and to be said by its streak (a cut pane's repairs that didn't take). `count`
/// (NULL: not wanted): the budget's entries. 4: held (`guarded`, the loop guard on: too many reactions this second
/// across every host), nothing spent, `until` (NULL: not wanted) when it lapses.
///
/// # Safety
/// `core` null or a live core (one thread at a time); `count` and `until` null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_budget_spend(
    core: *mut HostCore,
    h: Handle,
    kind: u8,
    now: f64,
    guarded: bool,
    count: *mut u32,
    until: *mut f64,
) -> u8 {
    // SAFETY: the contract above.
    let (Some(core), Some(kind)) = (unsafe { core.as_mut() }, BudgetKind::from_u8(kind)) else { return 2 };
    let (verdict, n) = match core.spend(h, kind, now, guarded) {
        Spend::Held { until: u } => {
            if !until.is_null() {
                // SAFETY: writable.
                unsafe { *until = u };
            }
            (4, 0)
        }
        Spend::Go { count } => (0, count),
        Spend::Spent { say: false, count, .. } => (2, count),
        Spend::Spent { say: true, count, streak } => (if streak { 3 } else { 1 }, count),
    };
    if !count.is_null() {
        // SAFETY: writable.
        unsafe { *count = n as u32 };
    }
    verdict
}

/// A cut pane's repair done: whether it took. The repairs in a row that didn't take now.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_budget_repair_took(core: *mut HostCore, h: Handle, took: bool) -> u32 {
    // SAFETY: the contract above.
    unsafe { core.as_mut() }.map_or(0, |c| c.model.repair_took(h, took) as u32)
}

/// A cut pane seen behind the panes it lies under, or out of the split: its repairs start again.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_budget_cut_order_right(core: *mut HostCore, h: Handle) {
    // SAFETY: the contract above.
    if let Some(c) = unsafe { core.as_mut() } {
        c.model.cut_order_right(h);
    }
}

/// A full-screen show failed and was backed out: true, tried again at its next show (the first time).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_full_screen_failed(core: *mut HostCore, h: Handle) -> bool {
    // SAFETY: the contract above.
    unsafe { core.as_mut() }.is_some_and(|c| c.model.full_screen_failed(h))
}

/// Another window of its app's adopted in its place (asked before its fields change).
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_adopted(core: *mut HostCore, h: Handle, can_full_screen: bool) {
    // SAFETY: the contract above.
    if let Some(c) = unsafe { core.as_mut() } {
        c.model.adopted(h, can_full_screen);
    }
}

/// The loop guard moved it to window mode: never in full screen again this run.
///
/// # Safety
/// `core` null or a live core (one thread at a time).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_model_moved_to_window(core: *mut HostCore, h: Handle) {
    // SAFETY: the contract above.
    if let Some(c) = unsafe { core.as_mut() } {
        c.model.moved_to_window(h);
    }
}
