//! What Margin's window's pointer calls cost (docs/CORE-REFACTOR.md step 3 part 12): a pointer event (up to ~120 a
//! second, the main thread) over a split of two panes and a card with the page's hits over them, a cut pane under it;
//! the slot looked at again; a placing (each change of the holes, a drag's frames); the pane click tap's pure read. A
//! measure, not a check: run it in release, as the app's library is built,
//! `cargo test --release -p margin-ffi --test pointer_cost -- --ignored --nocapture`.

use std::time::Instant;

use margin_ffi::*;

fn per_call(n: u32, mut f: impl FnMut(u32)) -> f64 {
    for i in 0..n / 10 {
        f(i);
    }
    let t = Instant::now();
    for i in 0..n {
        f(i);
    }
    t.elapsed().as_nanos() as f64 / f64::from(n)
}

#[test]
#[ignore = "a measure: run in release with --ignored --nocapture"]
fn the_pointers_calls_cost() {
    let r = |x: f64, y: f64, width: f64, height: f64| MarginRect { x, y, width, height };
    let content = r(0.0, 33.0, 1512.0, 949.0);
    let layout = MarginInsets { left: 276.0, top: 8.0, right: 8.0, bottom: 8.0, radius: 12.0 };
    let hits = [r(886.0, 8.0, 8.0, 933.0), r(400.0, 100.0, 480.0, 300.0), r(1300.0, 20.0, 40.0, 40.0)];
    let (left, right) = (r(276.0, 41.0, 610.0, 933.0), r(894.0, 41.0, 610.0, 933.0));
    let holes = [left, right];
    let cuts = [MarginCut { window: 41, rect: left, cut: false }, MarginCut { window: 42, rect: right, cut: true }];
    let page = margin_page_new();
    let place = |dx: f64| {
        let c = MarginRect { x: content.x + dx, ..content };
        // SAFETY: a live page, valid buffers.
        unsafe {
            margin_page_place_slot(page, c, &layout, hits.as_ptr(), 3, false, std::ptr::null(), holes.as_ptr(), 2, true)
        }
    };
    // SAFETY: a live page, valid buffers.
    unsafe {
        margin_page_set_pointer_every(page, 1.0 / 30.0);
        margin_page_set_want(page, 1, 1, 24.0);
        margin_page_set_cuts(page, true, cuts.as_ptr(), 2);
    }
    place(0.0);
    let at = |i: u32| MarginPoint { x: 10.0 + f64::from(i % 380) * 3.9, y: 40.0 + f64::from(i % 89) * 10.0 };
    let mut out = MarginPointer::default();
    let mut through = 0u32;
    let event = per_call(1_000_000, |i| {
        // SAFETY: as above.
        unsafe { margin_page_pointer(page, at(i), content, false, f64::from(i) * 0.008, &mut out) };
        through += u32::from(out.pass);
    });
    let again = per_call(1_000_000, |i| {
        // SAFETY: as above.
        std::hint::black_box(unsafe { margin_page_pointer_again(page, at(i), content) });
    });
    let placing = per_call(200_000, |i| {
        std::hint::black_box(place(f64::from(i % 3)));
    });
    place(0.0);
    let mut view = MarginSlotView::default();
    // SAFETY: as above (the view read before the next placing).
    let present = unsafe { margin_page_slot(page, &mut view) };
    let tap = per_call(1_000_000, |i| {
        // SAFETY: as above.
        std::hint::black_box(unsafe { margin_pass_page_gets(at(i), &view) });
    });
    println!(
        "pointer, per call: a pointer event (two panes, three hits, a cut pane) {event:.1} ns ({through} through); the \
         slot looked at again {again:.1} ns; a placing {placing:.1} ns; the tap's read of a slot {tap:.1} ns"
    );
    assert!(present && through > 0);
    // SAFETY: the live page, freed once.
    unsafe { margin_page_free(page) };
}
