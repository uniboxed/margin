//! What Margin's window's page calls cost (docs/CORE-REFACTOR.md step 3 part 11 and part 7's page area): a setter (a
//! show's label, a few a switch), a placing of the holes (one host, and a split of two panes under a card: each change
//! of the holes, a drag's frames), the poll's read at rest (every 1.5-2 s), the page area again with the hosted
//! window's placement (a drag's frame), and the layout report's parse (a drag's frame: its JSON as the page sends it).
//! A measure, not a check: run it in release, as the app's library is built,
//! `cargo test --release -p margin-ffi --test page_cost -- --ignored --nocapture`.

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

unsafe extern "C" fn clock(ctx: *mut std::ffi::c_void) -> f64 {
    // SAFETY: the test's own clock, a live f64.
    unsafe { *ctx.cast::<f64>() }
}

#[test]
#[ignore = "a measure: run in release with --ignored --nocapture"]
fn the_pages_calls_cost() {
    let r = |x: f64, y: f64, width: f64, height: f64| MarginRect { x, y, width, height };
    let content = r(0.0, 0.0, 1512.0, 982.0);
    let layout = br#"{"insets":{"left":248,"top":8,"right":8,"bottom":8},"radius":10,"radii":[10,10,10,10],"container":{"width":1512,"height":982},"mode":"fullscreen","pageOutside":false,"pageHosted":true,"fills":["color(srgb 0.941176 0.92549 0.894118)","color(srgb 0.941176 0.92549 0.894118)","color(srgb 0.941176 0.92549 0.894118)","color(srgb 0.941176 0.92549 0.894118)"]}"#;
    let split = br#"{"insets":{"left":248,"top":8,"right":8,"bottom":8},"radius":10,"radii":[10,10,10,10],"container":{"width":1512,"height":982},"mode":"fullscreen","pageOutside":false,"pageHosted":true,"fills":["rgb(240, 236, 228)","rgb(240, 236, 228)","rgb(240, 236, 228)","rgb(240, 236, 228)"],"split":"split-1","panes":[{"id":"item-1","rect":[0,0,620,966]},{"id":"item-2","rect":[628,0,628,966]}]}"#;
    let hits = [r(886.0, 8.0, 8.0, 933.0), r(400.0, 100.0, 480.0, 300.0), r(1300.0, 20.0, 40.0, 40.0)];
    let (left, right, card) =
        (r(248.0, 8.0, 620.0, 966.0), r(876.0, 8.0, 628.0, 966.0), r(374.0, 106.0, 1032.0, 803.0));
    let page = margin_page_new();
    let label = "Getting you started";
    let mut settled = MarginSettled::default();
    // SAFETY: a live page, valid buffers.
    unsafe {
        margin_page_configure(page, 0.12, label.as_ptr(), label.len(), false, 1, 0);
        margin_page_set_full_screen(page, true);
        margin_page_set_layout(page, layout.as_ptr(), layout.len());
        margin_page_set_hits(page, hits.as_ptr(), 3, false);
        margin_page_set_hosting(page, true);
        margin_page_set_hosted(page, true, 41);
        margin_page_set_hosted_frame(page, &left);
        margin_page_settle(page, 0.0, &mut settled);
    }
    let (notes, mail) = ("Notes", "Mail");
    let setter = per_call(1_000_000, |i| {
        let l = if i % 2 == 0 { notes } else { mail };
        // SAFETY: as above.
        std::hint::black_box(unsafe {
            margin_page_set_showing(page, l.as_ptr(), l.len(), true, std::ptr::null(), 0, false, false)
        });
    });
    // SAFETY: as above.
    unsafe {
        margin_page_set_showing(page, std::ptr::null(), 0, false, std::ptr::null(), 0, false, false);
        margin_page_settle(page, 0.0, &mut settled);
    }
    let (mut placed, mut rect, mut radius, mut placement) =
        (MarginHolePlaced::default(), MarginRect::default(), 0.0, MarginPlacement::default());
    // SAFETY: as above.
    unsafe { margin_page_update(page, content, &content, &mut rect, &mut radius) };
    let one = per_call(1_000_000, |i| {
        let c = MarginRect { x: f64::from(i % 3), ..content };
        // SAFETY: as above.
        unsafe { margin_page_place_hole(page, c, &mut placed) };
    });
    assert_eq!(placed.ground, 1, "one host's hole placed");
    let shown = [
        MarginShown { window: 41, rect: left, z: 0, role: 0, focused: false },
        MarginShown { window: 42, rect: right, z: 1, role: 1, focused: true },
        MarginShown { window: 43, rect: card, z: 2, role: 2, focused: false },
    ];
    let frames = [
        MarginFrame { window: 41, rect: left },
        MarginFrame { window: 42, rect: right },
        MarginFrame { window: 43, rect: card },
    ];
    // SAFETY: as above.
    unsafe {
        margin_page_set_visible(page, shown.as_ptr(), 3);
        margin_page_set_frames(page, frames.as_ptr(), 3);
    }
    let several = per_call(500_000, |i| {
        let c = MarginRect { x: f64::from(i % 3), ..content };
        // SAFETY: as above.
        unsafe { margin_page_place_hole(page, c, &mut placed) };
    });
    assert_eq!(placed.ground, 2, "the split's and the card's holes placed");
    let area = per_call(1_000_000, |i| {
        let c = MarginRect { width: 1512.0 - f64::from(i % 2) * 0.25, ..content };
        // SAFETY: as above.
        unsafe {
            margin_page_update(page, c, &content, &mut rect, &mut radius);
            std::hint::black_box(margin_page_hosted_placement(page, c, &content, &mut placement));
        }
    });
    let mut now = 10.0f64;
    let ctx = (&raw mut now).cast::<std::ffi::c_void>();
    let mut ops = MarginFrontOps::default();
    let read = per_call(1_000_000, |i| {
        now += 0.75;
        // SAFETY: as above.
        unsafe {
            if margin_page_front_reads(page, 41) {
                margin_page_front_read(page, 41, i64::from(i % 3 != 0), true, 1, ctx, Some(clock), &mut ops);
            }
        }
    });
    let mut keep = MarginKeepFront::default();
    let keep_front = per_call(1_000_000, |_| {
        // SAFETY: as above.
        unsafe { margin_page_keep_front(page, 1, ctx, Some(clock), &mut keep) };
    });
    let parse = per_call(200_000, |i| {
        let b: &[u8] = if i % 2 == 0 { layout } else { split };
        // SAFETY: as above.
        std::hint::black_box(unsafe { margin_page_set_layout(page, b.as_ptr(), b.len()) });
    });
    let mut state = MarginPageRead::default();
    let reads = per_call(1_000_000, |_| {
        // SAFETY: as above.
        unsafe { margin_page_read(page, &mut state) };
    });
    println!(
        "page, per call: a setter (a show's label) {setter:.1} ns; the holes placed, one host {one:.1} ns, a split of two \
         panes under a card {several:.1} ns; the page area again and the placement {area:.1} ns; the poll's read at rest \
         {read:.1} ns; keepFront {keep_front:.1} ns; a layout report's parse {parse:.1} ns; its state read {reads:.1} ns"
    );
    assert_eq!(state.state, 2, "shown all along");
    // SAFETY: the live page, freed once.
    unsafe { margin_page_free(page) };
}
