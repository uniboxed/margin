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
            let both = [h, other];
            std::hint::black_box(margin_model_tucked_order(core, both.as_ptr(), 2, handles.as_mut_ptr(), 16));
            let mut tile = MarginRect::default();
            for t in [0.0, 0.05, 0.2] {
                std::hint::black_box(margin_model_slide_step(core, page, narrow, t, 0.15, &home, &mut r, &mut tile));
            }
            margin_model_set_live_page(core, std::ptr::null());
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
