//! What commit 9's calls cost (docs/CORE-REFACTOR.md step 3, parts 8-10): a copy's push for the mini player as it
//! comes (its JSON's bytes read, checked and cut, its tabs numbered, its window picked, the page's JSON written and
//! pushed: a few a second while media plays), a `loading` push, the engine's slow step, what a window draws (a draw: its state with the open rows),
//! a UI request's route, the page's ops (a `pointerWant`, the hits, a log line), its hello over a big state, a poll's
//! drawn look. Typed ports throughout, as the Mac has them. A measure, not a check:
//! `cargo test --release -p margin-ffi --test routing_cost -- --ignored --nocapture`.

use std::ffi::c_void;
use std::time::Instant;

use margin_ffi::*;
use serde_json::{Value, json};

extern "C" fn now(_: *mut c_void) -> f64 {
    1.0
}

/// The typed ports: Margin's window 1 (and 2), the windows' ids; everything else none.
extern "C" fn call(_: *mut c_void, kind: u32, args: *const MarginPortArgs, out: *mut MarginPortOut) -> i64 {
    // SAFETY: the call's args.
    let a = unsafe { &*args };
    match kind {
        0 => {
            if a.has_window {
                a.window
            } else {
                1
            }
        }
        1 => {
            for id in [1, 2] {
                // SAFETY: the call's out.
                unsafe { margin_port_out_int(out, id) };
            }
            0
        }
        _ => 0,
    }
}

fn per_call(n: u32, mut f: impl FnMut()) -> f64 {
    for _ in 0..n / 10 {
        f();
    }
    let t = Instant::now();
    for _ in 0..n {
        f();
    }
    t.elapsed().as_nanos() as f64 / f64::from(n)
}

fn free(out: *mut u8, len: usize) {
    // SAFETY: a buffer a call made, `len` bytes (or null), freed once.
    unsafe { margin_buffer_free(out, len) };
}

fn bytes(s: &str) -> MarginBytes {
    MarginBytes { ptr: s.as_ptr(), len: s.len() }
}

#[test]
#[ignore = "a measure: run in release with --ignored --nocapture"]
fn commit_nines_calls_cost() {
    let dir = tempfile::tempdir().expect("a folder");
    let root = dir.path().to_string_lossy().to_string();
    // SAFETY: the root's bytes; the library outlives the session below.
    let lib =
        unsafe { margin_library_new(root.as_ptr(), root.len(), false, std::ptr::null_mut(), None, None, None, None) };
    let mut entries = vec![json!({ "collection": "windows", "id": "1", "value": { "spaceId": "home" } })];
    for i in 0..10 {
        entries.push(json!({ "collection": "tabs", "id": format!("t{i}"), "value": { "url": format!("https://{i}.example/"), "title": "T", "spaceId": "home" } }));
    }
    let apply = json!({ "type": "apply", "at": 1, "entries": entries }).to_string();
    let mut n = 0;
    // SAFETY: the library, the request's bytes.
    free(unsafe { margin_library_call(lib, apply.as_ptr(), apply.len(), &mut n) }, n);
    let options = br#"{"every":0.05}"#;
    // SAFETY: the library, the options' bytes, no ctx needed; typed ports.
    let s = unsafe {
        margin_session_new(lib, options.as_ptr(), options.len(), std::ptr::null_mut(), Some(now), None, Some(call))
    };
    let mut status = MarginSessionStatus { ready: false, deadline: 0.0 };
    let input = |v: &str, status: &mut MarginSessionStatus| {
        let mut n = 0;
        // SAFETY: the live session, the input's bytes.
        free(unsafe { margin_session_input(s, v.as_ptr(), v.len(), status, &mut n) }, n);
    };
    let open: Vec<Value> = (0..10).map(|i| json!([format!("t{i}"), "safari:s-default", "s-default"])).collect();
    let tabs: Vec<Value> = (0..10).map(|i| json!([format!("t{i}"), 500 + i])).collect();
    let set = json!({ "type": "state", "set": {
        "hostingWindow": { "put": [[1]] }, "shown": { "put": [[1, "t0"]] }, "open": { "put": open },
        "safariWindows": { "put": [["s-default", "main", 90]] }, "safariTabs": { "put": tabs } } });
    input(&set.to_string(), &mut status);
    // The mini player's push: three sources, their tabs by id, titles, a small artwork, flags and times (~1 KB).
    let art = format!("data:image/png;base64,{}", "A".repeat(400));
    let sources: Vec<Value> = (0..3)
        .map(|i| json!({ "tabId": 500 + i, "title": format!("Track {i} — an artist"), "subtitle": "An album", "artwork": art,
                         "playing": i == 0, "muted": false, "canPrev": true, "canNext": true, "updatedAt": 1_800_000_000_000.0_f64, "pausedAt": null }))
        .collect();
    let media = json!({ "type": "media", "sources": sources }).to_string();
    let (browser, profile) = ("safari", "s-default");
    let push = per_call(100_000, || {
        let mut n = 0;
        // SAFETY: the live session; the texts and the message's bytes.
        let out = unsafe {
            margin_session_copy_message(
                s,
                bytes(browser),
                bytes(profile),
                true,
                90,
                media.as_ptr(),
                media.len(),
                &mut status,
                &mut n,
            )
        };
        free(out, n);
    });
    let loading_push = {
        let mut flip = false;
        per_call(100_000, || {
            flip = !flip;
            let msg =
                if flip { r#"{"type":"loading","tabIds":[500,501]}"# } else { r#"{"type":"loading","tabIds":[]}"# };
            let mut n = 0;
            // SAFETY: as above.
            let out = unsafe {
                margin_session_copy_message(
                    s,
                    bytes(browser),
                    bytes(profile),
                    true,
                    90,
                    msg.as_ptr(),
                    msg.len(),
                    &mut status,
                    &mut n,
                )
            };
            free(out, n);
        })
    };
    let host = "safari:s-default";
    let loading = {
        let mut flip = false;
        per_call(100_000, || {
            flip = !flip;
            let mut n = 0;
            // SAFETY: the live session; the host's bytes or none.
            let out = unsafe {
                if flip {
                    margin_session_loading(s, host.as_ptr(), host.len(), &mut status, &mut n)
                } else {
                    margin_session_loading(s, std::ptr::null(), 0, &mut status, &mut n)
                }
            };
            free(out, n);
        })
    };
    let mut rows = 0usize;
    let draw = per_call(100_000, || {
        let mut n = 0;
        // SAFETY: the live session, no tail.
        let out = unsafe { margin_session_state(s, std::ptr::null(), 0, &mut n) };
        rows = n;
        free(out, n);
    });
    let ui = per_call(50_000, || {
        input(r#"{"type":"ui","kind":"closeTab","payload":{"windowId":1,"tabId":3}}"#, &mut status);
    });
    // The page's ops and its hello.
    let page = margin_page_new();
    let content = MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    let mut out = MarginSaid {
        kind: 0,
        flag: false,
        flag2: false,
        has_rect: false,
        a: 0,
        b: 0,
        rect: content,
        rects: 0,
        text: std::ptr::null_mut(),
        text_len: 0,
    };
    let op = |name: &str, body: &str, out: &mut MarginSaid| {
        // SAFETY: the live page; the op's and the body's bytes; a writable out.
        unsafe { margin_page_said(page, name.as_ptr(), name.len(), body.as_ptr(), body.len(), content, out) };
        free(out.text, out.text_len);
    };
    let want =
        per_call(200_000, || op("pointerWant", r#"{"mode":"edges","edges":["left","top"],"zone":24}"#, &mut out));
    let hits_body =
        json!({ "rects": (0..10).map(|i| json!([i * 10, 0, 100, 40])).collect::<Vec<_>>(), "all": false }).to_string();
    let hits = per_call(100_000, || op("hits", &hits_body, &mut out));
    let log = per_call(100_000, || op("log", r#"{"level":"note","text":"a line of the page's"}"#, &mut out));
    let state = json!({ "spaces": (0..50).map(|i| json!({ "id": format!("s{i}"), "name": "A space", "items": (0..20).map(|j| json!({ "id": j, "url": "https://example.com/a/b" })).collect::<Vec<_>>() })).collect::<Vec<_>>() }).to_string();
    let facts = MarginHelloFacts {
        window_id: 1,
        page_minimum: f64::NAN,
        browser: bytes("safari"),
        mode: bytes("fullscreen"),
        state: bytes(&state),
        windows: bytes("[]"),
        themes: bytes("[]"),
        apps: bytes("[]"),
        margin_page: MarginBytes { ptr: std::ptr::null(), len: 0 },
        pane_min: bytes("{}"),
        app_min: bytes("{}"),
        pane_loading: bytes("null"),
        pane_cut: bytes("{}"),
        picture: MarginBytes { ptr: std::ptr::null(), len: 0 },
        hosted_frame: bytes("null"),
        hosted_frames: bytes("[]"),
        theme: MarginBytes { ptr: std::ptr::null(), len: 0 },
    };
    let hello = per_call(5_000, || {
        let mut n = 0;
        // SAFETY: the live page, the facts' texts alive for the call.
        free(unsafe { margin_page_hello(page, &facts, &mut n) }, n);
    });
    // A poll's drawn look, nothing changed.
    let config = br#"{"version":"t"}"#;
    // SAFETY: the config's bytes; no ctx, no write callback.
    let link = unsafe { margin_link_new(config.as_ptr(), config.len(), std::ptr::null_mut(), None) };
    let (hosted, windows) = ([90_i64], [89_i64, 90, 91]);
    let look = || {
        let mut n = 0;
        // SAFETY: the live link; its texts and lists.
        let out = unsafe {
            margin_link_drawn(
                link,
                7,
                "e".as_ptr(),
                1,
                hosted.as_ptr(),
                1,
                windows.as_ptr(),
                3,
                1.0,
                1_800_000_000.0,
                &mut n,
            )
        };
        free(out, n);
    };
    look();
    let drawn = per_call(1_000_000, look);
    println!(
        "commit 9 (release): a mini player's push (~{} bytes, 3 sources) {push:.0} ns, a loading push {loading_push:.0} ns, the \
         engine's slow step on and off {loading:.0} ns, a window's state with 10 items open (a draw) {draw:.0} ns ({rows} bytes), a UI \
         request's route {ui:.0} ns, a pointerWant {want:.0} ns, 10 hits {hits:.0} ns, a log line {log:.0} ns, a hello over a \
         {} KB state {hello:.0} ns, a poll's drawn look {drawn:.1} ns",
        media.len(),
        state.len() / 1024
    );
    // SAFETY: freed once each, the session before the library.
    unsafe {
        margin_link_free(link);
        margin_page_free(page);
        margin_session_free(s);
        margin_library_free(lib);
    }
}
