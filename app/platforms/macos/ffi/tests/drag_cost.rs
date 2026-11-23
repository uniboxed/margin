//! What a drag's frame costs on the core's side (docs/CORE-REFACTOR.md step 3, commit 6: the hot path of the step):
//! the page's layout report read into its page (no `Value`), the session's `page_rect` that reads the placement and the
//! panes from that page and calls the engine's typed follow, and a whole frame as Margin's window makes it (the
//! report, the page area again, the session, the holes placed), with a split's two panes, and with the card over
//! them. A measure, not a check: `cargo test --release -p margin-ffi --test drag_cost -- --ignored --nocapture`.

use std::time::Instant;

use margin_ffi::*;

#[path = "drag/world.rs"]
mod drag;

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
fn a_drags_frame_costs() {
    let w = drag::world();
    let reports: Vec<String> = (0..40).map(drag::report).collect();
    // (Where the window's page draws the card: the session's card is in place there.)
    let card = MarginRect { x: 400.0, y: 100.0, width: 600.0, height: 500.0 };
    let parse = per_call(200_000, |i| {
        let r = &reports[(i % 40) as usize];
        // SAFETY: the world's live page, the report's bytes.
        std::hint::black_box(unsafe { margin_page_set_layout(w.page, r.as_ptr(), r.len()) });
    });
    let session = per_call(1_000_000, |_| {
        // SAFETY: the world's live objects.
        std::hint::black_box(unsafe {
            margin_session_page_rect(w.session, 1, w.page, drag::CONTENT, &drag::DISPLAY, std::ptr::null())
        });
    });
    let frame = per_call(200_000, |i| {
        // SAFETY: the world's live objects.
        std::hint::black_box(unsafe { drag::frame(&w, reports[(i % 40) as usize].as_bytes(), None) });
    });
    let with_card = per_call(200_000, |i| {
        // SAFETY: the world's live objects.
        std::hint::black_box(unsafe { drag::frame(&w, reports[(i % 40) as usize].as_bytes(), Some(&card)) });
    });
    println!(
        "a drag's frame, per call: the layout report's parse {parse:.0} ns; the session's page rect (placement and panes \
         read from the page, the typed follow) {session:.0} ns; a whole frame (report, page area, session, holes) \
         {frame:.0} ns, with the card over the split {with_card:.0} ns"
    );
    assert!(w.counter.0 > 0);
}
