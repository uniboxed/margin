//! The hot paths allocate nothing (docs/CORE-REFACTOR.md, step 2 "What every part shares"): a host's fields read and
//! written by handle, and the typed rules the engine asks every frame, poll and wait. Counted by a global allocator,
//! on this test's own thread only (its own binary: no other test runs beside it).

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use margin_core::host::model::Field;
use margin_ffi::*;

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static COUNT: Cell<usize> = const { Cell::new(0) };
}

fn counted() {
    if ON.try_with(Cell::get).unwrap_or(false) {
        let _ = COUNT.try_with(|c| c.set(c.get() + 1));
    }
}

// SAFETY: every call goes to the system allocator as it came; only a count is kept beside.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        counted();
        // SAFETY: as GlobalAlloc::alloc's own contract.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        counted();
        // SAFETY: as GlobalAlloc::alloc_zeroed's own contract.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        counted();
        // SAFETY: as GlobalAlloc::realloc's own contract.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: as GlobalAlloc::dealloc's own contract.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// How many allocations `f` made on this thread.
fn allocations(f: impl FnOnce()) -> usize {
    COUNT.with(|c| c.set(0));
    ON.with(|o| o.set(true));
    f();
    ON.with(|o| o.set(false));
    COUNT.with(Cell::get)
}

#[test]
fn the_counter_counts() {
    assert!(allocations(|| drop(std::hint::black_box(vec![1u8; 64]))) >= 1);
}

#[test]
fn the_hot_paths_allocate_nothing() {
    let core = margin_host_new();
    let (id, app) = ("safari:#pane1", "com.apple.Safari");
    // SAFETY: a live core, valid buffers.
    let h = unsafe { margin_model_add(core, id.as_ptr(), id.len(), app.as_ptr(), app.len(), 41, 500) };
    let page = MarginRect { x: 248.0, y: 41.0, width: 1256.0, height: 933.0 };
    let area = MarginRect { x: 0.0, y: 33.0, width: 1512.0, height: 949.0 };
    let p = MarginPlacement { page, area, display: MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 } };
    // (Its app's minimum kept, its version read: rare, before the count.)
    let version = "26.2 (21623.1.14.11.9)";
    // SAFETY: a live core, valid buffers.
    let other = unsafe {
        margin_model_learn_min(core, h, &MarginSize { width: 500.0, height: 289.0 });
        margin_model_remember_min(core, h, version.as_ptr(), version.len());
        let (id2, w2) = ("safari:#pane2", 42);
        margin_model_add(core, id2.as_ptr(), id2.len(), app.as_ptr(), app.len(), w2, 500)
    };
    // (Both held by the engine, a split of the two laid out, one shown: rare, before the count.)
    let (id2, pane) = ("safari:#pane2", MarginVisible { rect: page, has_rect: true, role: 1, z: 1 });
    // SAFETY: a live core, valid buffers.
    unsafe {
        margin_model_list(core, id.as_ptr(), id.len(), h);
        margin_model_list(core, id2.as_ptr(), id2.len(), other);
        margin_model_set_shown(core, id.as_ptr(), id.len(), 1.0);
        margin_model_layout_set(core, id2.as_ptr(), id2.len(), &pane);
        margin_model_set_focus(core, id2.as_ptr(), id2.len());
        // (The second a pane, a tile: cut while narrower than its app's kept minimum.)
        margin_model_set(core, other, Field::Role as u32, 1);
        margin_model_set(core, other, Field::Tiled as u32, 1);
        margin_model_set(core, other, Field::Phase as u32, 1);
    }
    let n = allocations(|| {
        // SAFETY: a live core, valid pointers.
        unsafe {
            // The model's typed get and set, every kind.
            for f in
                [Field::Window, Field::Phase, Field::Role, Field::Mode, Field::Unread, Field::Gone, Field::SlidEndX]
            {
                let v = margin_model_get(core, h, f as u32);
                margin_model_set(core, h, f as u32, v + 1);
            }
            for f in [Field::VisibleAt, Field::GoneAt, Field::NarrowestHeld] {
                margin_model_set_real(core, h, f as u32, 3.5);
                std::hint::black_box(margin_model_get_real(core, h, f as u32));
            }
            let mut r = MarginRect::default();
            for f in [Field::Rect, Field::PlacedPage, Field::MinSize, Field::SlidPane] {
                margin_model_set_rect(core, h, f as u32, &page);
                std::hint::black_box(margin_model_get_rect(core, h, f as u32, &mut r));
                margin_model_set_rect(core, h, f as u32, std::ptr::null());
            }
            let times = [1.0, 2.0, 3.0, 4.0];
            let mut out = [0.0; 16];
            for f in [Field::Returns, Field::OffTries, Field::Reentries] {
                margin_model_set_times(core, h, f as u32, times.as_ptr(), times.len());
                std::hint::black_box(margin_model_times(core, h, f as u32, out.as_mut_ptr(), out.len()));
            }
            // The typed rules: a drag's frame (the layout), a wait's predicate, a poll's look.
            let mut edges = MarginEdges::default();
            std::hint::black_box(margin_layout_plan(&p, &mut edges));
            std::hint::black_box(margin_layout_home(&p, &mut r));
            std::hint::black_box(margin_layout_tile(&p, r, &mut r));
            std::hint::black_box(margin_layout_fit(page, 1048.0, 640.0, area));
            std::hint::black_box(margin_layout_cut(page, 701.0, 53.0, area, page, 1, 0));
            std::hint::black_box(margin_layout_within(page, area));
            std::hint::black_box(margin_layout_near(page, area, 1.0));
            std::hint::black_box(margin_layout_toolbar_room());
            std::hint::black_box(margin_kinds_is_strip(page, &p));
            std::hint::black_box(margin_kinds_toolbar_of(page, area));
            std::hint::black_box(margin_front_covers_sidebar(page, &p, 0.25));
            std::hint::black_box(margin_schedule_wake_due(1.0, f64::NEG_INFINITY, false));
            std::hint::black_box(margin_schedule_next_poll(true, false, true, 0.3));
            std::hint::black_box(margin_exits_same_launch(1.0, f64::NAN));
            // The minimums a drag's frame and a sizing read (part 5): a pane's own, another's its app's kept one (its
            // version unread, then not), a tile's read, the narrowest held.
            let mut size = MarginSize::default();
            std::hint::black_box(margin_model_minimum(core, h, 0, &mut size));
            std::hint::black_box(margin_model_minimum(core, other, 1, &mut size));
            std::hint::black_box(margin_model_learn_min(core, h, &MarginSize { width: 499.5, height: 289.0 }));
            std::hint::black_box(margin_model_learn_min(core, other, std::ptr::null()));
            margin_model_held(core, other, 640.0);
            std::hint::black_box(margin_minimums_has(core, app.as_ptr(), app.len()));
            std::hint::black_box(margin_minimums_known(
                core,
                app.as_ptr(),
                app.len(),
                version.as_ptr(),
                version.len(),
                &mut size,
            ));
            // The layout's reads (part 1b), dozens an operation and every poll; an operation's end with nothing to
            // change; the one shown set to itself; an entry set as it is; bringIn's points; a window-mode frame.
            let mut handles = [0u32; 16];
            std::hint::black_box(margin_model_visible(core, handles.as_mut_ptr(), handles.len()));
            for i in [id, id2] {
                std::hint::black_box(margin_model_is_visible(core, i.as_ptr(), i.len()));
                std::hint::black_box(margin_model_rank(core, i.as_ptr(), i.len()));
                std::hint::black_box(margin_model_alone(core, i.as_ptr(), i.len()));
                std::hint::black_box(margin_model_before(core, i.as_ptr(), i.len()));
                let mut v = MarginVisible::default();
                std::hint::black_box(margin_model_layout_get(core, i.as_ptr(), i.len(), &mut v));
            }
            let mut q = MarginPlacement::default();
            for x in [h, other] {
                margin_model_page_of(core, x, &mut r);
                margin_model_placement_for(core, x, &mut q);
                std::hint::black_box(margin_model_below_minimum(core, x, &page));
                std::hint::black_box(margin_model_below_minimum(core, x, std::ptr::null()));
                for point in 0..4 {
                    std::hint::black_box(margin_model_bring_in(core, x, point, 2));
                }
            }
            std::hint::black_box(margin_model_main_host(core));
            std::hint::black_box(margin_model_layout_count(core));
            std::hint::black_box(margin_model_generation(core));
            std::hint::black_box(margin_model_applying(core));
            std::hint::black_box(margin_model_shown_at(core));
            std::hint::black_box(margin_model_shown_min_width(core));
            margin_model_placement(core, &mut q);
            margin_model_set_placement(core, &p);
            margin_model_set_shown(core, id.as_ptr(), id.len(), 2.0);
            margin_model_layout_set(core, id2.as_ptr(), id2.len(), &pane);
            margin_model_layout_move(core, id2.as_ptr(), id2.len(), page);
            margin_model_set_focus(core, id2.as_ptr(), id2.len());
            std::hint::black_box(margin_model_settle_begin(core));
            std::hint::black_box(margin_model_settle_focus(core));
            std::hint::black_box(margin_layout_inside(page, 600.0, 400.0));
            std::hint::black_box(margin_layout_window_frame(page, area, true, true, 1.0, &mut r));
            std::hint::black_box(margin_layout_at_page_area(page, page, 1.0));
            // Cut panes (part 3): a drag's frame per follower (its page area followed), a placing's wait, a poll's
            // look, a slide's frames.
            margin_model_set_live_page(core, &page);
            let narrow = MarginRect { x: 900.0, width: 400.0, ..page };
            margin_model_set_rect(core, other, Field::Rect as u32, &narrow); // (moved to the page area above)
            let pl = MarginPlacement { page: narrow, ..p };
            let home = p.display;
            let mut slide = MarginSlide::default();
            let screen = [42i64, 41];
            for x in [h, other] {
                margin_model_frame(core, x, &pl, &mut r);
                margin_model_frame(core, x, std::ptr::null(), &mut r);
                margin_model_fitted(core, x, &pl, false, &mut q);
                margin_model_fitted(core, x, std::ptr::null(), true, &mut q);
                std::hint::black_box(margin_model_tile_rect(core, x, &pl, home, &mut r));
                std::hint::black_box(margin_model_is_cut(core, x));
                std::hint::black_box(margin_model_cut(core, x));
                for side in 0..4 {
                    std::hint::black_box(margin_model_slide_for(core, x, side, &mut slide));
                }
                std::hint::black_box(margin_model_lying_under(core, x, &narrow, handles.as_mut_ptr(), handles.len()));
                std::hint::black_box(margin_model_tucked(core, x, std::ptr::null()));
                std::hint::black_box(margin_model_over_under(core, x, screen.as_ptr(), screen.len()));
                std::hint::black_box(margin_model_versions_wanted(core, handles.as_mut_ptr(), handles.len()));
            }
            let mut tile = MarginRect::default();
            for t in [0.0, 0.05, 0.2] {
                std::hint::black_box(margin_model_slide_step(core, page, narrow, t, 0.15, &home, &mut r, &mut tile));
            }
            margin_model_set_live_page(core, std::ptr::null());
            // The window order's check while the focused one is waited for (part 2): every few milliseconds.
            let (wanted, below, on_screen) = ([41i64, 42], [0u32], [7i64, 42, 9, 41]);
            let mut order = [0i64; 16];
            std::hint::black_box(margin_order_server(
                wanted.as_ptr(),
                2,
                on_screen.as_ptr(),
                4,
                order.as_mut_ptr(),
                16,
            ));
            std::hint::black_box(margin_order_top_behind(wanted.as_ptr(), 2, below.as_ptr(), 1, on_screen.as_ptr(), 4));
        }
    });
    assert_eq!(n, 0, "the hot paths allocated {n} times");
    // (The second was cut, its app's kept minimum read with its version unread: noted.)
    // SAFETY: a live core, valid buffers.
    unsafe {
        let mut out = [0u32; 4];
        assert!(margin_model_is_cut(core, other));
        assert_eq!(margin_model_versions_wanted(core, out.as_mut_ptr(), 4), 1);
    }
    // (A host's first open and its going may allocate: rare. Freed here.)
    // SAFETY: the live core, freed once.
    unsafe {
        margin_model_remove(core, h);
        margin_model_remove(core, other);
        margin_host_free(core);
    }
}

#[test]
fn the_budgets_allocate_nothing_after_a_cut_panes_first_repair() {
    let core = margin_host_new();
    let (id, app) = ("safari:#pane1", "com.apple.Safari");
    // SAFETY: a live core, valid buffers.
    let h = unsafe { margin_model_add(core, id.as_ptr(), id.len(), app.as_ptr(), app.len(), 41, 500) };
    // (A cut pane's first repair keeps its id: rare, before the count.)
    // SAFETY: a live core.
    unsafe { margin_budget_spend(core, h, 4, 0.0, true, std::ptr::null_mut(), std::ptr::null_mut()) };
    let (mut count, mut until) = (0u32, 0.0f64);
    // (The guard's per-second list reaches its room once: before the count.)
    // SAFETY: a live core.
    unsafe {
        for i in 0..14 {
            margin_budget_spend(core, h, 1, 100.0 + i as f64 * 0.01, true, &mut count, &mut until);
        }
    }
    let n = allocations(|| {
        // SAFETY: a live core, a writable count.
        unsafe {
            // (The poll's, every poll for each cut pane seen right; each budget within its room.)
            margin_budget_cut_order_right(core, h);
            margin_budget_cut_order_right(core, 99);
            for (i, kind) in [0u8, 1, 2, 3, 4].into_iter().enumerate() {
                std::hint::black_box(margin_budget_spend(
                    core,
                    h,
                    kind,
                    200.0 + i as f64,
                    true,
                    &mut count,
                    &mut until,
                ));
            }
            margin_budget_repair_took(core, h, false);
            margin_model_full_screen_failed(core, h);
            margin_model_adopted(core, h, true);
            margin_model_moved_to_window(core, h);
            // (Each tiles' sizing asks whether a hold is in force.)
            std::hint::black_box(margin_guard_held_until(core, 100.05));
            std::hint::black_box(margin_guard_held_until(core, 300.0));
        }
    });
    assert_eq!(n, 0, "the budgets allocated {n} times");
    // SAFETY: the live core, freed once.
    unsafe {
        margin_model_remove(core, h);
        margin_host_free(core);
    }
}

#[test]
fn the_polls_counts_and_looks_allocate_nothing() {
    let core = margin_host_new();
    let (id, app) = ("app:com.apple.Notes", "com.apple.Notes");
    // SAFETY: a live core, valid buffers.
    let h = unsafe { margin_model_add(core, id.as_ptr(), id.len(), app.as_ptr(), app.len(), 41, 500) };
    // SAFETY: a live core.
    let (mut count, mut until) = (0u32, 0.0f64);
    // (The loop guard's list of this second's actions made once: its first action, before the count.)
    // SAFETY: a live core, writable outs.
    unsafe {
        margin_model_set(core, h, Field::Phase as u32, 1);
        margin_budget_spend(core, h, 1, 0.0, true, &mut count, &mut until);
    }
    let n = allocations(|| {
        // SAFETY: a live core, writable outs.
        unsafe {
            // (Every poll, per host: its read counted, where it is, a gone window's tree.)
            for read in [2u8, 1, 2, 0, 1] {
                std::hint::black_box(margin_watch_poll_read(core, h, read));
            }
            for place in 0..4u8 {
                std::hint::black_box(margin_watch_poll_place(core, h, place, place != 1));
            }
            std::hint::black_box(margin_watch_poll_gone(core, h, 1.0, -1, false));
            std::hint::black_box(margin_watch_poll_gone(core, h, 1.0, 1, false));
            std::hint::black_box(margin_watch_still_off(true, false, -1));
            // (A stray's and an off-screen look's turn: their budgets within their room.)
            std::hint::black_box(margin_watch_stray(core, h, 2.0, 3, true, true, &mut count));
            std::hint::black_box(margin_watch_off_screen(
                core, h, 3.0, true, false, true, 2, true, &mut count, &mut until,
            ));
            std::hint::black_box(margin_watch_off_screen(
                core, h, 4.0, true, false, false, 3, true, &mut count, &mut until,
            ));
        }
    });
    assert_eq!(n, 0, "the poll's counts and looks allocated {n} times");
    // SAFETY: the live core, freed once.
    unsafe {
        margin_model_remove(core, h);
        margin_host_free(core);
    }
}

#[test]
fn the_close_and_the_exits_reads_allocate_nothing() {
    let core = margin_host_new();
    let (bundle, id) = ("com.apple.Maps", "app:com.apple.Maps");
    // (An app asked to quit: rare, its bundle and id kept, before the count.)
    // SAFETY: a live core, valid buffers.
    unsafe { margin_exits_asked(core, 501, bundle.as_ptr(), bundle.len(), 1000.5, id.as_ptr(), id.len(), 10.0) };
    let mut out = [0i64; 4];
    let n = allocations(|| {
        // SAFETY: a live core, a writable buffer.
        unsafe {
            // (Every poll: the overdue ones; every keeper's step: whether one is ending.)
            std::hint::black_box(margin_exits_overdue(core, 12.0, 4.0, std::ptr::null_mut(), 0));
            std::hint::black_box(margin_exits_overdue(core, 15.0, 4.0, out.as_mut_ptr(), out.len()));
            std::hint::black_box(margin_exits_has(core, 501) && !margin_exits_has(core, 502));
            std::hint::black_box(margin_exits_count(core));
            std::hint::black_box(margin_exits_asked_at(core, 501) + margin_exits_launched_at(core, 501));
            std::hint::black_box(margin_exits_same_marked_launch(1000.0, f64::NAN));
            for point in 0..=10u8 {
                std::hint::black_box(margin_close_decide(point, point % 3, 0x1_5a5a, point % 2 == 0, point % 3 == 0));
            }
            std::hint::black_box(margin_exits_take_back(core, 502, false, std::ptr::null(), 0, f64::NAN));
        }
    });
    assert_eq!(n, 0, "the close and the exits' reads allocated {n} times");
    assert_eq!(out[0], 501);
    // SAFETY: the live core, freed once.
    unsafe {
        assert!(margin_exits_exited(core, 501));
        margin_host_free(core);
    }
}

/// A split of two tiles and a window-mode card, held by the engine and laid out, the first one shown: the drag's world
/// (rare, before any count).
fn live_world() -> (*mut margin_core::host::api::HostCore, MarginPlacement) {
    let core = margin_host_new();
    let page = MarginRect { x: 276.0, y: 41.0, width: 1228.0, height: 933.0 };
    let area = MarginRect { x: 0.0, y: 33.0, width: 1512.0, height: 949.0 };
    let p = MarginPlacement { page, area, display: MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 } };
    let ids = ["app:com.apple.TextEdit", "app:com.apple.Notes", "app:com.apple.FaceTime"];
    for (i, id) in ids.iter().enumerate() {
        let rect = MarginRect { x: 276.0 + 620.0 * i as f64, y: 41.0, width: 600.0, height: 933.0 };
        let role = [0u8, 1, 2][i];
        let v = MarginVisible { rect, has_rect: true, role, z: i as i64 };
        // SAFETY: a live core, valid buffers.
        unsafe {
            let h = margin_model_add(core, id.as_ptr(), id.len(), id.as_ptr(), id.len(), 40 + i as i64, 500 + i as i64);
            margin_model_list(core, id.as_ptr(), id.len(), h);
            margin_model_layout_set(core, id.as_ptr(), id.len(), &v);
            margin_model_set(core, h, Field::Phase as u32, 1);
            margin_model_set(core, h, Field::Role as u32, i64::from(role));
            margin_model_set_rect(core, h, Field::Rect as u32, &rect);
            margin_model_set(core, h, if i < 2 { Field::Tiled as u32 } else { Field::Mode as u32 }, 1);
        }
    }
    // SAFETY: a live core, valid buffers.
    unsafe {
        margin_model_set_placement(core, &p);
        margin_model_set_shown(core, ids[0].as_ptr(), ids[0].len(), 1.0);
    }
    (core, p)
}

/// One tick of the pump as the engine runs it: the flights' reads (`land`: each at its rect), the tick, each send and
/// its record, the tick's end. How many were sent.
///
/// # Safety
/// `core` a live core.
unsafe fn live_tick_once(core: *mut margin_core::host::api::HostCore, now: f64, land: bool) -> usize {
    let timing = MarginLiveTiming { frame: 1.0 / 120.0, wait: 0.05, tolerance: 1.0 };
    let home = MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    let mut reads = [MarginLiveRead::default(); 16];
    let mut bounds = [MarginLiveBounds::default(); 16];
    let mut wants = [MarginRect::default(); 64];
    let mut events = [MarginLiveEvent::default(); 16];
    let mut sends = [0u32; 16];
    let mut out = MarginLiveTick::default();
    // SAFETY: the caller's contract; the buffers as long as said.
    unsafe {
        let n = margin_live_reads(core, reads.as_mut_ptr(), 16);
        for i in 0..n {
            let at = if land { wants[(reads[i].host as usize).min(63)] } else { MarginRect::default() };
            bounds[i] = MarginLiveBounds { host: reads[i].host, read: true, bounds: at };
        }
        margin_live_tick(
            core,
            now,
            &timing,
            bounds.as_ptr(),
            n,
            false,
            false,
            events.as_mut_ptr(),
            16,
            sends.as_mut_ptr(),
            16,
            &mut out,
        );
        for &h in &sends[..out.sends] {
            let mut send = MarginLiveSend::default();
            margin_live_send(core, h, &out.frame, std::ptr::null(), &home, &mut send);
            std::hint::black_box(margin_model_versions_wanted(core, std::ptr::null_mut(), 0));
            if send.kind != 0 {
                margin_live_sent(core, h, now, send.page);
                wants[(h as usize).min(63)] = send.page;
            }
        }
        std::hint::black_box(margin_live_done(core));
        out.sends
    }
}

#[test]
fn the_live_pump_allocates_nothing() {
    let (core, mut p) = live_world();
    // (The drag begins and the pump's first run starts: its room taken once, before the count.)
    // SAFETY: a live core, valid buffers.
    let first = unsafe {
        let mut others = [0u32; 16];
        assert_eq!(margin_live_start(core, 1.0, false, others.as_mut_ptr(), 16), 2);
        margin_live_pump_begin(core);
        margin_live_follow(core, 1.0, &p);
        live_tick_once(core, 1.0, false)
    };
    assert_eq!(first, 3, "both tiles and the card sent the first frame");
    let mut sent = 0;
    let n = allocations(|| {
        // SAFETY: a live core, valid buffers.
        unsafe {
            for i in 0..240 {
                let now = 1.0 + 0.002 * f64::from(i);
                // (A page frame every other tick, 2 ms each: coalesced, the newest winning; landing or not, given up
                // after the wait; the session's counts, the poll's look.)
                if i % 2 == 0 {
                    p.page.x += 1.0;
                    p.page.width -= 1.0;
                    margin_live_follow(core, now, &p);
                }
                sent += live_tick_once(core, now, i % 40 < 30);
                std::hint::black_box(margin_live_on(core));
                std::hint::black_box(margin_live_forgotten(core, now, 10.0));
                std::hint::black_box(margin_live_followers(core, std::ptr::null_mut()));
            }
            // (A new run of the pump, the drag held, its end.)
            margin_live_pump_begin(core);
            margin_live_hold(core);
            margin_live_follow(core, 3.0, &p);
            std::hint::black_box(live_tick_once(core, 3.0, false));
            std::hint::black_box(margin_live_end(core));
        }
    });
    assert_eq!(n, 0, "the live pump's calls allocated {n} times");
    assert!(sent > 20, "frames sent all along: {sent}");
    // SAFETY: the live core, freed once.
    unsafe { margin_host_free(core) };
}

/// A split of two panes and a card, its page's hits over it, the second pane cut (the pointer's world, docs/CORE-REFACTOR.md
/// step 3 part 12).
struct PointerWorld {
    content: MarginRect,
    hits: [MarginRect; 3],
    holes: [MarginRect; 3],
    cuts: [MarginCut; 3],
}

fn pointer_world() -> PointerWorld {
    let r = |x: f64, y: f64, width: f64, height: f64| MarginRect { x, y, width, height };
    let (left, right, card) =
        (r(276.0, 41.0, 610.0, 933.0), r(894.0, 41.0, 610.0, 933.0), r(374.0, 106.0, 1032.0, 803.0));
    PointerWorld {
        content: r(0.0, 33.0, 1512.0, 949.0),
        hits: [r(886.0, 8.0, 8.0, 933.0), r(400.0, 100.0, 480.0, 300.0), r(1300.0, 20.0, 40.0, 40.0)],
        holes: [left, right, card],
        cuts: [
            MarginCut { window: 41, rect: left, cut: false },
            MarginCut { window: 42, rect: right, cut: true },
            MarginCut { window: 43, rect: card, cut: false },
        ],
    }
}

/// A page hosting in full screen with the world's layout and hits, its hosted window shown (Margin's window's page,
/// docs/CORE-REFACTOR.md step 3 part 11).
fn world_page(w: &PointerWorld) -> *mut MarginPage {
    let page = margin_page_new();
    let label = "Getting you started";
    let layout = br#"{"insets":{"left":276,"top":8,"right":8,"bottom":8},"radius":12,"radii":[12,12,12,12],"container":{"width":1512,"height":949},"mode":"fullscreen","pageHosted":true,"fills":["rgb(240, 236, 228)","rgb(240, 236, 228)","rgb(240, 236, 228)","rgb(240, 236, 228)"]}"#;
    let mut settled = MarginSettled::default();
    // SAFETY: a live page, valid buffers.
    unsafe {
        margin_page_configure(page, 0.12, label.as_ptr(), label.len(), false, 1, 0);
        margin_page_set_full_screen(page, true);
        margin_page_set_layout(page, layout.as_ptr(), layout.len());
        margin_page_set_hits(page, w.hits.as_ptr(), 3, false);
        margin_page_set_hosting(page, true);
        margin_page_set_hosted(page, true, 41);
        margin_page_settle(page, 0.0, &mut settled);
    }
    assert!(settled.shown, "shown: {settled:?}");
    page
}

/// One host's hole (its window's bounds) or the split's two panes, the window `dx` along: the page area again, the
/// holes placed (a drag's frame). The slot's and region's change bits.
///
/// # Safety
/// `page` a live page from `world_page`.
unsafe fn place_world(page: *mut MarginPage, w: &PointerWorld, several: bool, dx: f64) -> u8 {
    let content = MarginRect { x: w.content.x + dx, ..w.content };
    let one = MarginRect { x: 276.0 + dx, y: 41.0, width: 1228.0, height: 933.0 };
    let display = MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    let shown = [
        MarginShown { window: 41, rect: w.holes[0], z: 0, role: 0, focused: false },
        MarginShown { window: 42, rect: w.holes[1], z: 1, role: 1, focused: true },
    ];
    let frames = [MarginFrame { window: 41, rect: w.holes[0] }, MarginFrame { window: 42, rect: w.holes[1] }];
    let (mut rect, mut radius, mut placed) = (MarginRect::default(), 0.0, MarginHolePlaced::default());
    // SAFETY: the caller's contract, valid buffers.
    unsafe {
        margin_page_set_visible(page, shown.as_ptr(), if several { 2 } else { 0 });
        margin_page_set_frames(page, frames.as_ptr(), if several { 2 } else { 0 });
        margin_page_set_hosted_frame(page, &one);
        margin_page_update(page, content, &display, &mut rect, &mut radius);
        margin_page_place_hole(page, content, &mut placed);
    }
    u8::from(placed.slot) | (u8::from(placed.region) << 1)
}

#[test]
fn the_pointer_allocates_nothing() {
    let w = pointer_world();
    let page = world_page(&w);
    // (Rare, before the count: its options, its buttons and wants, its buffers grown by a placing of each kind.)
    // SAFETY: a live page, valid buffers.
    unsafe {
        margin_page_set_pointer_every(page, 1.0 / 30.0);
        margin_page_set_buttons(page, &MarginRect { x: 6.0, y: 7.0, width: 60.0, height: 14.0 }, false);
        margin_page_set_want(page, 1, 1, 24.0);
        for several in [true, false, true, false] {
            place_world(page, &w, several, 0.0);
        }
        margin_page_set_cuts(page, true, w.cuts.as_ptr(), 3);
    }
    let mut out = MarginPointer::default();
    let mut view = MarginSlotView::default();
    let mut region = MarginCatchView::default();
    let mut through = 0;
    let n = allocations(|| {
        // SAFETY: a live page, valid buffers; the views read before the next placing.
        unsafe {
            for i in 0..400 {
                // (Every pointer event: over the panes, the gap, the hits, the sidebar, out of the window; held and not.)
                let at = MarginPoint { x: 10.0 + f64::from(i) * 3.9, y: 20.0 + f64::from(i % 97) * 10.0 };
                margin_page_pointer(page, at, w.content, i % 7 == 0, f64::from(i) * 0.01, &mut out);
                through += usize::from(out.pass);
                std::hint::black_box(margin_page_ignoring(page));
                std::hint::black_box(margin_page_gets(page, at));
                if i % 50 == 0 {
                    // (The slot changed under a still pointer; a drag's frame: placed again, the cuts told again.)
                    std::hint::black_box(margin_page_pointer_again(page, at, w.content));
                    std::hint::black_box(place_world(page, &w, i % 100 == 0, f64::from(i % 3)));
                    std::hint::black_box(margin_page_set_cuts(page, true, w.cuts.as_ptr(), 3));
                }
                // (The tap's: the same rules over a slot it holds, here the page's own.)
                if margin_page_slot(page, &mut view) {
                    std::hint::black_box(margin_pass_page_gets(at, &view));
                    std::hint::black_box(margin_pass_decide(at, &view, false, true));
                }
                margin_page_catch(page, &mut region);
                let local = MarginPoint { x: at.x - w.content.x, y: at.y - w.content.y };
                std::hint::black_box(margin_pass_catch_contains(&region, local, w.content.width, w.content.height));
                std::hint::black_box(margin_pass_wants(1, 1 | 8, 24.0, local, w.content.width, w.content.height));
            }
        }
    });
    assert_eq!(n, 0, "the pointer's calls allocated {n} times");
    assert!(through > 50 && through < 350, "the pointer through the holes only: {through} of 400");
    // SAFETY: the live page, freed once.
    unsafe { margin_page_free(page) };
}

unsafe extern "C" fn test_clock(ctx: *mut std::ffi::c_void) -> f64 {
    // SAFETY: the test's own clock, a live f64.
    unsafe { *ctx.cast::<f64>() }
}

#[test]
fn the_page_allocates_nothing() {
    let w = pointer_world();
    let page = world_page(&w);
    let display = MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    let mut now = 10.0f64;
    let ctx = (&raw mut now).cast::<std::ffi::c_void>();
    // (Its buffers grown by a placing of each kind first: twice each, the slot's two buffers taking turns.)
    // SAFETY: a live page, valid buffers.
    unsafe {
        for several in [true, true, false, false] {
            place_world(page, &w, several, 0.0);
        }
    }
    let mut read = MarginPageRead::default();
    let mut placement = MarginPlacement::default();
    let mut keep = MarginKeepFront::default();
    let mut ops = MarginFrontOps::default();
    let mut text = [0u8; 64];
    let mut holes = [MarginRect::default(); 8];
    let mut panes = [MarginPaneHole::default(); 8];
    let mut layout = MarginPageLayout::default();
    let mut shown = 0;
    let n = allocations(|| {
        // SAFETY: a live page, valid buffers.
        unsafe {
            for i in 0..400 {
                // (A drag's frame: the page area again, the holes placed, the placement read; the window's reads.)
                std::hint::black_box(place_world(page, &w, i % 3 == 0, f64::from(i % 3)));
                std::hint::black_box(margin_page_hosted_placement(page, w.content, &display, &mut placement));
                std::hint::black_box(margin_page_idle_placement(page, w.content, &mut placement));
                std::hint::black_box(margin_page_set_following(page, i % 2 == 0));
                margin_page_read(page, &mut read);
                shown += usize::from(read.state == 2);
                std::hint::black_box(margin_page_text(page, 1, text.as_mut_ptr(), text.len()));
                std::hint::black_box(margin_page_holes(page, holes.as_mut_ptr(), holes.len()));
                std::hint::black_box(margin_page_pane_holes(page, panes.as_mut_ptr(), panes.len()));
                std::hint::black_box(margin_page_layout_get(page, &mut layout, text.as_mut_ptr(), text.len()));
                // (In front: kept so at each event, the poll's read at rest every 1.5-2 s.)
                now += 0.3;
                margin_page_keep_front(page, 1, ctx, Some(test_clock), &mut keep);
                if margin_page_front_reads(page, 41) {
                    margin_page_front_read(page, 41, i64::from(i % 2), i % 5 != 0, 1, ctx, Some(test_clock), &mut ops);
                }
            }
        }
    });
    assert_eq!(n, 0, "the page's calls allocated {n} times");
    assert!(shown == 400, "shown all along: {shown}");
    // SAFETY: the live page, freed once.
    unsafe { margin_page_free(page) };
}

#[test]
fn a_web_address_and_the_card_rect_allocate_nothing() {
    // (The session's typed rules, step 3 commit 1: an address checked per peek and Quick Tab, the card's default rect.)
    let addresses = [
        "https://docs.example.org/guide?q=1#top",
        "http://[::1]:80/",
        "http://a:xx/",
        "about:blank",
        "http://é.com/x",
        "http://u:p@@a/%zz",
    ];
    let n = allocations(|| {
        let (mut at, mut len) = (0usize, 0usize);
        for s in addresses {
            // SAFETY: the text's bytes, two writable lengths.
            std::hint::black_box(unsafe { margin_web_address(s.as_ptr(), s.len(), &mut at, &mut len) });
        }
        std::hint::black_box(margin_card_default_rect(MarginRect { x: 260.0, y: 41.0, width: 1244.0, height: 933.0 }));
    });
    assert_eq!(n, 0, "a web address and the card rect allocated {n} times");
}

#[test]
fn the_wakers_look_allocates_nothing() {
    // (The session's `link_wanted`, step 3 commit 5: the Safari waker reads it every 0.05 s while a profile links.)
    // SAFETY: a session over no library, with no ports; freed once.
    let s = unsafe {
        margin_session_new(std::ptr::null_mut(), std::ptr::null(), 0, std::ptr::null_mut(), None, None, None)
    };
    let set = br#"{"type":"state","set":{"showing":{"put":[["safari:s-default","t1"],["app:com.a","t2"]]},"requested":{"put":[[1,"t1"],[2,"t1"]]},"preparingProfile":{"put":[["s-prep"]]}}}"#;
    let mut len = 0;
    // SAFETY: the live session, the input's bytes; its answer freed.
    unsafe {
        margin_buffer_free(margin_session_input(s, set.as_ptr(), set.len(), std::ptr::null_mut(), &mut len), len)
    };
    let mut wanted = 0;
    let n = allocations(|| {
        for p in ["s-default", "s-prep", "s-other", "app:com.a"] {
            // SAFETY: the live session, the profile's bytes.
            wanted += usize::from(unsafe { margin_session_link_wanted(s, p.as_ptr(), p.len()) });
        }
    });
    assert_eq!(n, 0, "the waker's look allocated {n} times");
    // (The facade's typed read of a field that changed in a show: its rows to a sink, the texts lent.)
    extern "C" fn count(ctx: *mut std::ffi::c_void, _: *const MarginRow) {
        // SAFETY: ctx is the test's counter.
        unsafe { *(ctx as *mut usize) += 1 };
    }
    let mut rows = 0usize;
    let n = allocations(|| {
        use margin_core::session::Field as F;
        for f in [F::Requested, F::Showing, F::Shown] {
            // SAFETY: the live session, the counter as ctx.
            unsafe { margin_session_rows(s, f as u32, &mut rows as *mut usize as *mut std::ffi::c_void, Some(count)) };
        }
    });
    assert_eq!((n, rows), (0, 4), "a field's typed rows allocated {n} times");
    assert_eq!(wanted, 3, "t1 the only one asked for; the preparation's: something is; none shown: wanted");
    // SAFETY: from margin_session_new, freed once.
    unsafe { margin_session_free(s) };
}

#[test]
fn a_polls_drawn_look_with_nothing_changed_allocates_nothing() {
    // (Shell.tellDrawn at every poll, for each link: what the copy was told, kept per connection; nothing sent.)
    let config = br#"{"version":"t"}"#;
    // SAFETY: the config's bytes; no ctx, no write callback.
    let link = unsafe { margin_link_new(config.as_ptr(), config.len(), std::ptr::null_mut(), None) };
    let (hosted, windows) = ([90_i64, 92], [89_i64, 90, 91, 92]);
    let epoch = "e1";
    let mut len = 0;
    let look = |len: &mut usize| {
        // SAFETY: the live link; the texts and lists as their lengths say.
        unsafe {
            margin_link_drawn(
                link,
                7,
                epoch.as_ptr(),
                epoch.len(),
                hosted.as_ptr(),
                hosted.len(),
                windows.as_ptr(),
                windows.len(),
                1.0,
                1_800_000_000.0,
                len,
            )
        }
    };
    let first = look(&mut len);
    assert!(!first.is_null(), "the first look tells each window");
    // SAFETY: the answer's buffer, freed once.
    unsafe { margin_buffer_free(first, len) };
    let n = allocations(|| {
        for _ in 0..3 {
            assert!(look(&mut len).is_null(), "nothing changed: nothing sent");
        }
    });
    assert_eq!(n, 0, "a poll's drawn look allocated {n} times");
    // SAFETY: from margin_link_new, freed once.
    unsafe { margin_link_free(link) };
}

// ---- a drag's frame (step 3 commit 6): the layout report read into the page, the page area, the session's follow ----

#[path = "drag/world.rs"]
mod drag;

#[test]
fn a_drags_frame_allocates_nothing() {
    let w = drag::world();
    // (Where the window's page draws the card: the session's card is in place there.)
    let card = MarginRect { x: 400.0, y: 100.0, width: 600.0, height: 500.0 };
    let reports: Vec<String> = (0..40).map(drag::report).collect();
    // (The page's two layouts' buffers grown first, the session's first frames.)
    // SAFETY: the world's live objects.
    unsafe {
        for r in &reports[..4] {
            drag::frame(&w, r.as_bytes(), Some(&card));
        }
    }
    let mut followed = 0;
    let n = allocations(|| {
        for (i, r) in reports.iter().cycle().take(400).enumerate() {
            // SAFETY: the world's live objects.
            followed += usize::from(unsafe { drag::frame(&w, r.as_bytes(), (i % 2 == 0).then_some(&card)) } == 1);
        }
    });
    assert_eq!(n, 0, "a drag's frame allocated {n} times");
    assert_eq!((followed, w.counter.0), (400, 404), "every frame followed");
    // (The page's report read without serde's Value: alone, nothing either.)
    let page = margin_page_new();
    // (Its first two reports grow its two layouts' buffers.)
    for r in &reports[..2] {
        // SAFETY: a live page, the report's bytes.
        unsafe { margin_page_set_layout(page, r.as_ptr(), r.len()) };
    }
    let n = allocations(|| {
        for r in reports.iter().cycle().take(200) {
            // SAFETY: as above.
            unsafe { margin_page_set_layout(page, r.as_ptr(), r.len()) };
        }
    });
    assert_eq!(n, 0, "the report's parse allocated {n} times once grown");
    // SAFETY: the live page, freed once.
    unsafe { margin_page_free(page) };
}

#[test]
fn the_start_screens_read_and_the_preparations_look_allocate_nothing() {
    // (Step 3 commit 8: the start screen read per key press and menu check; the Safari waker's look for the launch's
    // preparation, every 0.05 s while it links. The engine's `shown` asked through the typed port: nothing shown.)
    extern "C" fn typed(_: *mut std::ffi::c_void, _: u32, _: *const MarginPortArgs, _: *mut MarginPortOut) -> i64 {
        0
    }
    // SAFETY: a session over no library, with the typed port only; freed once.
    let s = unsafe {
        margin_session_new(std::ptr::null_mut(), std::ptr::null(), 0, std::ptr::null_mut(), None, None, Some(typed))
    };
    let (up, wanted) = (std::cell::Cell::new(0), std::cell::Cell::new(0));
    let look = || {
        for _ in 0..10 {
            // SAFETY: the live session.
            up.set(up.get() + usize::from(unsafe { margin_session_start_screen(s) }));
            // SAFETY: as above.
            wanted.set(wanted.get() + usize::from(unsafe { margin_session_prepare_wanted(s) }));
        }
    };
    let n = allocations(look);
    assert_eq!(
        (n, up.get(), wanted.get()),
        (0, 0, 10),
        "the start screen's read and the preparation's look allocated {n} times"
    );
    wanted.set(0);
    let set = br#"{"type":"state","set":{"requested":{"put":[[1,"t1"]]}}}"#;
    let mut len = 0;
    // SAFETY: the live session, the input's bytes; its answer freed.
    unsafe {
        margin_buffer_free(margin_session_input(s, set.as_ptr(), set.len(), std::ptr::null_mut(), &mut len), len)
    };
    let n = allocations(look);
    assert_eq!((n, wanted.get()), (0, 0), "something asked for: not wanted ({n} allocations)");
    // SAFETY: from margin_session_new, freed once.
    unsafe { margin_session_free(s) };
}
