//! What the session's calls cost (docs/CORE-REFACTOR.md step 3, commit 4): an input that does nothing but its JSON (a
//! note), the facade's read of a field, a tick with nothing due, and a whole navigate (its input, its two requests
//! handed out and answered, its window read through the port); commit 5's: a whole switch to a web item of the
//! profile shown (its library request, the show in the queue, the copy's hostShow answered: a tab switch, every port
//! its JSON). None is per frame: the session adds nothing to a drag. A measure, not a check: `cargo test --release -p margin-ffi --test session_cost -- --ignored --nocapture`.

use std::ffi::c_void;
use std::time::Instant;

use margin_ffi::*;
use serde_json::{Value, json};

unsafe extern "C" {
    fn malloc(n: usize) -> *mut c_void;
}

extern "C" fn now(_: *mut c_void) -> f64 {
    1.0
}

extern "C" fn port(_: *mut c_void, _: *const u8, _: usize, out_len: *mut usize) -> *mut u8 {
    // (One answer for every port: window 1, the profile linked, its window hosted and shown alone, the Swift flows'
    // reads false.)
    let a = br#"{"id":1,"profiles":["p"],"hosted":true,"host":"safari:p","alone":true,"value":false}"#;
    // SAFETY: malloc'd here, freed by the session with free.
    unsafe {
        let p = malloc(a.len()) as *mut u8;
        std::ptr::copy_nonoverlapping(a.as_ptr(), p, a.len());
        *out_len = a.len();
        p
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

fn take(out: *mut u8, len: usize) -> Value {
    // SAFETY: a buffer a session call made, `len` bytes, freed once.
    let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
    unsafe { margin_buffer_free(out, len) };
    v
}

#[test]
#[ignore = "a measure: run in release with --ignored --nocapture"]
fn the_sessions_calls_cost() {
    let dir = tempfile::tempdir().expect("a folder");
    let root = dir.path().to_string_lossy().to_string();
    // SAFETY: the root's bytes; the library outlives the session below.
    let lib =
        unsafe { margin_library_new(root.as_ptr(), root.len(), false, std::ptr::null_mut(), None, None, None, None) };
    let web = json!({ "kind": "web", "browser": "safari", "profile": "p" });
    let apply = json!({ "type": "apply", "at": 1, "entries": [
        { "collection": "tabs", "id": "t1", "value": { "url": "https://a.example/", "target": web } },
        { "collection": "tabs", "id": "t2", "value": { "url": "https://b.example/", "title": "B", "target": web } },
    ] })
    .to_string();
    let mut n = 0;
    // SAFETY: the library, the request's bytes.
    take(unsafe { margin_library_call(lib, apply.as_ptr(), apply.len(), &mut n) }, n);
    let options = br#"{"every":0.05}"#;
    // SAFETY: the library, the options' bytes, no ctx needed.
    let s = unsafe {
        margin_session_new(lib, options.as_ptr(), options.len(), std::ptr::null_mut(), Some(now), Some(port), None)
    };
    let input = |v: &str| {
        let mut n = 0;
        // SAFETY: the live session, the input's bytes.
        take(unsafe { margin_session_input(s, v.as_ptr(), v.len(), std::ptr::null_mut(), &mut n) }, n)
    };
    input(
        r#"{"type":"state","set":{"shown":{"put":[[1,"t1"]]},"open":{"put":[["t1","safari:p","p"]]},"safariWindows":{"put":[["p","main",90]]}}}"#,
    );
    let note = per_call(100_000, || {
        input(r#"{"type":"note","line":"t1: shown in Safari window 90"}"#);
    });
    let read = per_call(100_000, || {
        input(r#"{"type":"state","get":["open"]}"#);
    });
    let tick = per_call(100_000, || {
        let mut n = 0;
        // SAFETY: the live session.
        take(unsafe { margin_session_tick(s, 0.0, std::ptr::null_mut(), &mut n) }, n);
    });
    let rev = per_call(1_000_000, || {
        // SAFETY: the live session.
        std::hint::black_box(unsafe { margin_session_rev(s, 1) });
    });
    let reply = br#"{"result":{"tabId":501,"created":false},"error":null}"#;
    let navigate = per_call(50_000, || {
        input(r#"{"type":"navigate","kind":"goBack","window":1}"#);
        let mut n = 0;
        // SAFETY: the live session; the reply's bytes.
        let mut out = take(unsafe { margin_session_tick(s, 0.0, std::ptr::null_mut(), &mut n) }, n);
        for _ in 0..2 {
            let id = out["start"][0]["id"].as_u64().unwrap_or(0);
            // SAFETY: as above.
            take(unsafe { margin_session_tick(s, 0.0, std::ptr::null_mut(), &mut n) }, n);
            out = take(
                unsafe { margin_session_answer(s, id, reply.as_ptr(), reply.len(), std::ptr::null_mut(), &mut n) },
                n,
            );
        }
    });
    // SAFETY: the live session.
    assert!(unsafe { margin_session_idle(s) });
    input(r#"{"type":"state","set":{"hostingWindow":{"put":[[1]]}}}"#);
    let shown = br#"{"result":{"tabId":502,"created":false},"error":null}"#;
    let mut flip = false;
    let switch = per_call(20_000, || {
        flip = !flip;
        let item = if flip { "t2" } else { "t1" };
        input(&format!(r#"{{"type":"library","request":{{"type":"activateTab","item":"{item}","windowId":1}}}}"#));
        let mut n = 0;
        // SAFETY: the live session; the reply's bytes.
        let out = take(unsafe { margin_session_tick(s, 0.0, std::ptr::null_mut(), &mut n) }, n);
        let id = out["start"][0]["id"].as_u64().unwrap_or(0);
        take(unsafe { margin_session_tick(s, 0.0, std::ptr::null_mut(), &mut n) }, n);
        take(unsafe { margin_session_answer(s, id, shown.as_ptr(), shown.len(), std::ptr::null_mut(), &mut n) }, n);
    });
    // SAFETY: the live session.
    assert!(unsafe { margin_session_idle(s) }, "each switch over");
    println!("a web tab switch (a library request, the show, the copy's hostShow, every port its JSON) {switch:.0} ns");
    // (Commit 8's: the start screen read per key press, the preparation's look every 0.05 s while it links, hosting
    // settled after an engine event, a Margin window brought in front with nothing to take back.)
    let screen = per_call(1_000_000, || {
        // SAFETY: the live session.
        std::hint::black_box(unsafe { margin_session_start_screen(s) });
    });
    let look = per_call(100_000, || {
        // SAFETY: the live session.
        std::hint::black_box(unsafe { margin_session_prepare_wanted(s) });
    });
    let settle = per_call(100_000, || {
        let mut n = 0;
        // SAFETY: the live session.
        take(unsafe { margin_session_settle(s, std::ptr::null_mut(), &mut n) }, n);
    });
    let focused = per_call(100_000, || {
        input(r#"{"type":"windowFocused","window":1}"#);
    });
    extern "C" fn typed(_: *mut c_void, _: u32, _: *const MarginPortArgs, _: *mut MarginPortOut) -> i64 {
        0
    }
    // SAFETY: no library, the typed port only (as the Mac's: the engine's read typed); freed below.
    let t = unsafe {
        margin_session_new(std::ptr::null_mut(), std::ptr::null(), 0, std::ptr::null_mut(), None, None, Some(typed))
    };
    let typed_look = per_call(1_000_000, || {
        // SAFETY: the live session.
        std::hint::black_box(unsafe { margin_session_prepare_wanted(t) });
    });
    // SAFETY: from margin_session_new, freed once.
    unsafe { margin_session_free(t) };
    println!(
        "commit 8 (release): the start screen read {screen:.1} ns, the preparation's look {typed_look:.1} ns typed \
         ({look:.0} ns with its engine read through the JSON port), hosting settled with something shown {settle:.0} ns \
         (its engine read as JSON), a window in front {focused:.0} ns"
    );
    println!(
        "session calls (release): a note {note:.0} ns, a field read {read:.0} ns, a tick with nothing due {tick:.0} ns, \
         a revision {rev:.1} ns, a whole navigate (an input, four ticks, two answers, one port) {navigate:.0} ns"
    );
    // SAFETY: freed once, the session first.
    unsafe {
        margin_session_free(s);
        margin_library_free(lib);
    }
}
