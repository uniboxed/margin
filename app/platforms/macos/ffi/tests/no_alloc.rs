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
        }
    });
    assert_eq!(n, 0, "the hot paths allocated {n} times");
    // (A host's first open and its going may allocate: rare. Freed here.)
    // SAFETY: the live core, freed once.
    unsafe {
        margin_model_remove(core, h);
        margin_host_free(core);
    }
}
