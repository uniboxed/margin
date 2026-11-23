//! What the live-resize pump's calls cost (docs/CORE-REFACTOR.md step 2 part 6): a page frame of a drag (up to 120 a
//! second), a tick at rest (every 2 ms while a change is in flight) and a tick that sends a frame to a split of two
//! tiles and a window-mode card (the reads, the tick, each send and its record, the end). A measure, not a check: run
//! it in release, as the app's library is built,
//! `cargo test --release -p margin-ffi --test live_cost -- --ignored --nocapture`.

use std::time::Instant;

use margin_core::host::model::Field;
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
fn the_live_pumps_calls_cost() {
    let core = margin_host_new();
    let page = MarginRect { x: 276.0, y: 41.0, width: 1228.0, height: 933.0 };
    let area = MarginRect { x: 0.0, y: 33.0, width: 1512.0, height: 949.0 };
    let mut p = MarginPlacement { page, area, display: MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 } };
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
    let timing = MarginLiveTiming { frame: 1.0 / 120.0, wait: 0.05, tolerance: 1.0 };
    let home = MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    // SAFETY: a live core, valid buffers throughout.
    unsafe {
        margin_model_set_placement(core, &p);
        margin_model_set_shown(core, ids[0].as_ptr(), ids[0].len(), 1.0);
        assert!(margin_live_start(core, 1.0, false, std::ptr::null_mut(), 0) >= 0);
        margin_live_pump_begin(core);
    }
    let mut reads = [MarginLiveRead::default(); 16];
    let mut bounds = [MarginLiveBounds::default(); 16];
    let mut wants = [MarginRect::default(); 64];
    let mut events = [MarginLiveEvent::default(); 16];
    let mut sends = [0u32; 16];
    let mut out = MarginLiveTick::default();
    let mut tick = |now: f64, land: bool| -> usize {
        // SAFETY: as above.
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
    };
    let follow = per_call(200_000, |i| {
        p.page.x = 276.0 + f64::from(i % 50);
        // SAFETY: as above.
        unsafe { std::hint::black_box(margin_live_follow(core, 1.0, &p)) };
    });
    // (At rest: the frame sent, every flight in flight and not landed yet, nothing free.)
    let now = 2.0;
    tick(now, false);
    let rest = per_call(200_000, |_| {
        std::hint::black_box(tick(now, false));
    });
    // (Sending: a new frame each tick, every flight landed and a frame's time since the last: all three sent.)
    let mut later = 3.0;
    let mut sent = 0;
    let sending = per_call(100_000, |i| {
        later += 0.01;
        p.page.x = 276.0 + f64::from(i % 50);
        // SAFETY: as above.
        unsafe { margin_live_follow(core, later, &p) };
        sent += tick(later, true);
    });
    println!(
        "live pump, per call: a page frame {follow:.0} ns; a tick at rest (3 in flight, each read) {rest:.0} ns; a tick \
         sending a frame to three (its reads, the tick, 3 sends and records, the end) {sending:.0} ns ({:.0} ns a host); \
         {sent} sent",
        sending / 3.0
    );
    assert!(sent >= 100_000, "every tick sent: {sent}");
    // SAFETY: the live core, freed once.
    unsafe { margin_host_free(core) };
}
