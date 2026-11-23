//! What the session's pure rules cost (docs/CORE-REFACTOR.md step 3, commit 1): a web address (a peek, Quick Tab's
//! choice, a card's window), the card's default rect, a split's room, and the page's layout report read by its JSON
//! call (every report of Margin's window: up to 120 a second while its sidebar's edge is dragged, until its typed call
//! comes with part 7). A measure, not a check: run it in release, as the app's library is built,
//! `cargo test --release -p margin-ffi --test session_cost -- --ignored --nocapture`.

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
fn the_session_rules_cost() {
    let address = "https://docs.example.org/guide/getting-started?q=margin&page=2#top";
    let (mut at, mut len) = (0usize, 0usize);
    let web = per_call(1_000_000, |_| {
        // SAFETY: the text's bytes, two writable lengths.
        std::hint::black_box(unsafe { margin_web_address(address.as_ptr(), address.len(), &mut at, &mut len) });
    });
    let page = MarginRect { x: 260.0, y: 41.0, width: 1244.0, height: 933.0 };
    let card = per_call(1_000_000, |i| {
        let r = MarginRect { width: page.width + f64::from(i % 7), ..page };
        std::hint::black_box(margin_card_default_rect(r));
    });
    let pane = |x: f64, w: f64, role: u8| MarginPaneRoom {
        role,
        has_rect: true,
        rect: MarginRect { x, y: 41.0, width: w, height: 933.0 },
        has_least: true,
        least: MarginSize { width: 220.0, height: 220.0 },
        had: true,
    };
    let panes = [pane(240.0, 412.0, 0), pane(660.0, 412.0, 1), pane(1080.0, 424.0, 1)];
    let mut leave = [false; 3];
    let room = per_call(200_000, |_| {
        // SAFETY: three panes, three bools.
        std::hint::black_box(unsafe { margin_session_no_room(panes.as_ptr(), 3, page, leave.as_mut_ptr()) });
    });
    let report = r#"{"container":{"height":949,"width":1512},"fills":["rgb(20, 20, 24)","rgb(20, 20, 24)","rgb(20, 20, 24)","rgb(20, 20, 24)"],"insets":{"bottom":8,"left":260.5,"right":8,"top":8},"mode":"fullscreen","pageHosted":true,"pageOutside":false,"panes":[{"id":"t-abc","rect":[0,0,612,933]},{"id":"t-def","rect":[620,0,612,933]}],"radii":[10,10,10,10],"radius":10,"split":"sp-1"}"#;
    let mut layout = MarginPageLayout::default();
    let mut text = [0u8; 512];
    let parse = per_call(100_000, |_| {
        // SAFETY: the report's bytes, a writable layout, 512 writable bytes.
        std::hint::black_box(unsafe {
            margin_page_layout_read(report.as_ptr(), report.len(), &mut layout, text.as_mut_ptr(), text.len())
        });
    });
    println!(
        "session rules: a web address {web:.0} ns, the card rect {card:.1} ns, a split's room (three panes) {room:.0} ns, a layout report read (its JSON in, typed out) {parse:.0} ns"
    );
}
