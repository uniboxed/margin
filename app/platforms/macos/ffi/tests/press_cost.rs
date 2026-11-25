//! What the press tap's core decision costs (docs/SIDEBAR-PRESS.md "The cost"): on the tap's own thread, for each
//! press of any mouse button while a Margin window shows a hosted app, the way of the press (`margin_press_way`) over
//! the copy of the slot its scene holds. The input waits for it, so it's what each click adds before the window server
//! goes on (the window server's list of the windows above the panel is read only for a press it would deliver, and is
//! the OS's: measured on the Mac by the report, not here). A measure, not a check: run it in release, as the app's
//! library is built, `cargo test --release -p margin-ffi --test press_cost -- --ignored --nocapture`.

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
fn a_press_decision_costs() {
    let r = |x: f64, y: f64, width: f64, height: f64| MarginRect { x, y, width, height };
    let content = r(0.0, 33.0, 1512.0, 949.0);
    let hits = [r(886.0, 8.0, 8.0, 933.0), r(400.0, 100.0, 480.0, 300.0), r(1300.0, 20.0, 40.0, 40.0)];
    let page = margin_page_new();
    let geometry = br#"{"insets":{"left":276,"top":8,"right":8,"bottom":8},"radius":12,"container":{"width":1512,"height":949},"mode":"fullscreen","pageHosted":true}"#;
    let mut settled = MarginSettled::default();
    let (mut rect, mut radius, mut placed) = (MarginRect::default(), 0.0, MarginHolePlaced::default());
    let one = r(276.0, 41.0, 1228.0, 933.0);
    // SAFETY: a live page, valid buffers.
    unsafe {
        margin_page_set_full_screen(page, true);
        margin_page_set_layout(page, geometry.as_ptr(), geometry.len());
        margin_page_set_hits(page, hits.as_ptr(), 3, false);
        margin_page_set_hosting(page, true);
        margin_page_set_hosted(page, true, 41);
        margin_page_settle(page, 0.0, &mut settled);
        margin_page_set_hosted_frame(page, &one);
        margin_page_update(page, content, &content, &mut rect, &mut radius);
        margin_page_place_hole(page, content, &mut placed);
    }
    let mut view = MarginSlotView::default();
    // SAFETY: as above (the view read before the next placing).
    let present = unsafe { margin_page_slot(page, &mut view) };
    // SAFETY: as above.
    let keys = unsafe { margin_page_keys_stay(page) };
    let at = |i: u32| MarginPoint { x: 10.0 + f64::from(i % 380) * 3.9, y: 40.0 + f64::from(i % 89) * 10.0 };
    let mut ui = 0u32;
    let press = per_call(1_000_000, |i| {
        // SAFETY: as above.
        let way = unsafe { margin_press_way(at(i), content, &view, std::ptr::null(), true, keys) };
        ui += u32::from(way == 2);
    });
    println!("a press's way, per press: {press:.1} ns ({ui} of 1000000 Margin's UI with the keys staying)");
    assert!(present && keys && ui > 0);
    // SAFETY: the live page, freed once.
    unsafe { margin_page_free(page) };
}
