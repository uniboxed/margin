//! The session (margin-core's `session`: HostedSession's flows as async steps, docs/CORE-REFACTOR.md step 3) for the
//! Mac app's Swift. One object per app, made with the library object (its reads go straight to the library's set) and
//! the Swift side's ports: `now` (typed: read at every sleep) and `port` (JSON in, JSON out allocated with `malloc`,
//! freed here with `free`, as `MarginDataNeed`), both called during a call, on its thread, and free to call back in.
//!
//! - `margin_session_input`: an input (`{ type, … }`); `margin_session_answer`: a command's answer by its id;
//!   `margin_session_tick`: the commands handed out are started, and the deadlines up to `due` are over. Each answers
//!   `{ start?, deadline, log?, reply?, error? }`: the commands to start at once, in order, before calling `tick`; the
//!   earliest deadline (null: none); the log lines since; a read's reply; a bad input's error, logged once a kind.
//! - Typed reads: `margin_session_done` (the last 200 lines, JSON), `margin_session_idle`,
//!   `margin_session_rev` (a field's revision: the facade reads it again only when it changed),
//!   `margin_session_link_wanted` (the Safari waker's look, every 0.05 s while it waits: nothing allocated),
//!   `margin_session_open_wanted` (the engine's, while a new app's window is awaited).
//!
//! Every function takes the object as a shared pointer: a call made inside another (a port's callback calling back
//! in) only changes state and queues tasks. Nothing here panics on what it's given.

use std::ffi::c_void;

use margin_core::data::library::LibraryStore;
use margin_core::json;
use margin_core::session::{Field, LibraryView, Ports, Session};
use serde_json::{Map, Value, json};

use crate::data::{MarginLibrary, answer, text};

unsafe extern "C" {
    fn free(ptr: *mut c_void);
}

/// The monotonic clock, seconds.
pub type MarginSessionNow = extern "C" fn(ctx: *mut c_void) -> f64;
/// A port: the question as JSON (`{ port, … }`), the answer JSON allocated with `malloc` (or null: none).
pub type MarginSessionPort =
    extern "C" fn(ctx: *mut c_void, ask: *const u8, len: usize, out_len: *mut usize) -> *mut u8;

pub struct MarginSession {
    session: Session,
}

struct SwiftPorts {
    ctx: *mut c_void,
    now: Option<MarginSessionNow>,
    port: Option<MarginSessionPort>,
}

impl SwiftPorts {
    fn ask(&self, q: Value) -> Value {
        let Some(port) = self.port else { return Value::Null };
        let q = q.to_string();
        let mut len = 0usize;
        let out = port(self.ctx, q.as_ptr(), q.len(), &mut len);
        if out.is_null() {
            return Value::Null;
        }
        // SAFETY: the callback's contract: `len` bytes it allocated with malloc.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: allocated with malloc by the callback, freed once.
        unsafe { free(out as *mut c_void) };
        v
    }

    fn string(v: &Value, k: &str) -> Option<String> {
        v.get(k).and_then(Value::as_str).map(str::to_string)
    }

    fn strings(v: &Value, k: &str) -> Vec<String> {
        json::array(v.get(k))
            .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    }
}

impl Ports for SwiftPorts {
    fn now(&self) -> f64 {
        self.now.map_or(0.0, |now| now(self.ctx))
    }
    fn window(&self, id: Option<i64>) -> Option<i64> {
        json::int(self.ask(json!({ "port": "window", "id": id })).get("id"))
    }
    fn window_ids(&self) -> Vec<i64> {
        let v = self.ask(json!({ "port": "windowIds" }));
        json::array(v.get("ids")).map(|l| l.iter().filter_map(|i| json::int(Some(i))).collect()).unwrap_or_default()
    }
    fn engine_shown(&self) -> Option<String> {
        Self::string(&self.ask(json!({ "port": "engineShown" })), "host")
    }
    fn is_hosted(&self, host: &str) -> bool {
        self.ask(json!({ "port": "isHosted", "host": host })).get("hosted").and_then(Value::as_bool) == Some(true)
    }
    fn safari_profiles(&self) -> Vec<String> {
        Self::strings(&self.ask(json!({ "port": "safariProfiles" })), "profiles")
    }
    fn link_epoch(&self, profile: &str) -> Option<String> {
        Self::string(&self.ask(json!({ "port": "linkEpoch", "profile": profile })), "epoch")
    }
    fn app_name(&self, bundle: &str) -> Option<String> {
        Self::string(&self.ask(json!({ "port": "appName", "bundle": bundle })), "name")
    }
    fn app_runs(&self, bundle: &str) -> Option<bool> {
        self.ask(json!({ "port": "appRuns", "bundle": bundle })).get("runs").and_then(Value::as_bool)
    }
    fn shows_alone(&self, host: &str) -> bool {
        self.ask(json!({ "port": "showsAlone", "host": host })).get("alone").and_then(Value::as_bool) != Some(false)
    }
    fn stop_hiding_woken(&self, bundle: &str) {
        self.ask(json!({ "port": "stopHidingWoken", "bundle": bundle }));
    }
    fn window_ids_of(&self, profile: &str) -> Vec<i64> {
        let v = self.ask(json!({ "port": "windowIdsOf", "profile": profile }));
        json::array(v.get("ids")).map(|l| l.iter().filter_map(|i| json::int(Some(i))).collect()).unwrap_or_default()
    }
    fn wall(&self) -> f64 {
        json::num(self.ask(json!({ "port": "wall" })).get("now")).unwrap_or(0.0)
    }
    fn set_showing(&self, window: i64, label: Option<&str>, app: Option<&str>, slow: bool) {
        self.ask(json!({ "port": "setShowing", "window": window, "label": label, "app": app, "slow": slow }));
    }
    fn set_margin_page(&self, window: i64, page: Option<&str>) {
        self.ask(json!({ "port": "setMarginPage", "window": window, "page": page }));
    }
    fn push(&self, window: i64, json: &str) {
        self.ask(json!({ "port": "push", "window": window, "json": json }));
    }
    fn changed(&self) {
        self.ask(json!({ "port": "changed" }));
    }
    fn woken_by_menu(&self, profile: &str) -> bool {
        self.ask(json!({ "port": "wokenByMenu", "profile": profile })).get("woken").and_then(Value::as_bool)
            == Some(true)
    }
    fn unopenable(&self, profile: &str) -> bool {
        self.ask(json!({ "port": "unopenable", "profile": profile })).get("unopenable").and_then(Value::as_bool)
            == Some(true)
    }
    fn log(&self, warn: bool, text: &str) {
        self.ask(json!({ "port": "log", "warn": warn, "text": text }));
    }
    fn swift(&self, call: &str, args: Value) -> Value {
        self.ask(json!({ "port": "swift", "call": call, "args": args })).get("value").cloned().unwrap_or(Value::Null)
    }
}

/// The library object's set, read in place (the Swift side's `Library` outlives the session: its contract).
struct LibraryRef(*mut MarginLibrary);

impl LibraryView for LibraryRef {
    fn item(&self, collection: &str, id: &str) -> Option<Value> {
        if self.0.is_null() {
            return None;
        }
        // SAFETY: from margin_library_new, alive as long as the session (the contract); used on the session's thread,
        // never while a library call is under way (the library calls nothing back), and only for this read.
        let store: &mut LibraryStore = unsafe { &mut (*self.0).library };
        store.item(collection, id)
    }
    fn collection(&self, collection: &str) -> Map<String, Value> {
        if self.0.is_null() {
            return Map::new();
        }
        // SAFETY: as `item`.
        let store: &mut LibraryStore = unsafe { &mut (*self.0).library };
        store.live(collection)
    }
}

fn session<'a>(s: *const MarginSession) -> Option<&'a Session> {
    // SAFETY: from margin_session_new and not freed (the caller's contract); shared, so a call inside another is safe.
    (!s.is_null()).then(|| unsafe { &(*s).session })
}

/// The session over `library` (alive as long as it), with `options` (`len` bytes of the Swift struct's JSON) and the
/// Swift side's ports (`ctx` passed back to each; alive as long as the session).
///
/// # Safety
/// `library` from `margin_library_new` (or null: an empty library); `options` points at `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_new(
    library: *mut MarginLibrary,
    options: *const u8,
    len: usize,
    ctx: *mut c_void,
    now: Option<MarginSessionNow>,
    port: Option<MarginSessionPort>,
) -> *mut MarginSession {
    let options = text(options, len).and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null);
    let ports = SwiftPorts { ctx, now, port };
    let session = Session::new(Box::new(ports), Box::new(LibraryRef(library)), &options);
    Box::into_raw(Box::new(MarginSession { session }))
}

/// # Safety
/// `s` from [`margin_session_new`], not freed yet, and not inside one of its calls.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_free(s: *mut MarginSession) {
    if !s.is_null() {
        // SAFETY: made by Box::into_raw in margin_session_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(s) });
    }
}

/// An input → its answer.
///
/// # Safety
/// `s` from [`margin_session_new`], not freed; `input` points at `len` readable bytes; `out_len` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_input(
    s: *const MarginSession,
    input: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    let Some(s) = session(s) else { return answer(&json!({ "error": "no session" }), out_len) };
    let input = text(input, len).and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Null);
    answer(&s.input(&input).to_json(), out_len)
}

/// A command's answer (`len` bytes of JSON) → the call's answer.
///
/// # Safety
/// As [`margin_session_input`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_answer(
    s: *const MarginSession,
    id: u64,
    reply: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    let Some(s) = session(s) else { return answer(&json!({ "error": "no session" }), out_len) };
    let reply = text(reply, len).and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Null);
    answer(&s.answer(id, reply).to_json(), out_len)
}

/// The commands handed out are started, the deadlines up to `due` over → the call's answer.
///
/// # Safety
/// `s` from [`margin_session_new`], not freed; `out_len` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_tick(s: *const MarginSession, due: f64, out_len: *mut usize) -> *mut u8 {
    let Some(s) = session(s) else { return answer(&json!({ "error": "no session" }), out_len) };
    answer(&s.tick(due).to_json(), out_len)
}

/// The log lines kept (the last 200), oldest first, as a JSON array.
///
/// # Safety
/// As [`margin_session_tick`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_done(s: *const MarginSession, out_len: *mut usize) -> *mut u8 {
    let lines = session(s).map(Session::done).unwrap_or_default();
    answer(&json!(lines), out_len)
}

/// Nothing enqueued is left to do (true for a null session).
///
/// # Safety
/// `s` from [`margin_session_new`] (or null), not freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_idle(s: *const MarginSession) -> bool {
    session(s).is_none_or(Session::idle)
}

/// A field's revision (0 `shown`, 1 `open`, 2 `safariWindows`, 3 `done`: how many lines were ever kept); 0 for
/// another number or a null session.
///
/// # Safety
/// As [`margin_session_idle`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_rev(s: *const MarginSession, field: u32) -> u64 {
    match (session(s), Field::from_index(field)) {
        (Some(s), Some(f)) => s.rev(f),
        _ => 0,
    }
}

/// Whether a show waiting on `profile`'s link (`len` bytes of UTF-8) is still wanted (false for a null session or a
/// profile that isn't text). Nothing allocated.
///
/// # Safety
/// `s` from [`margin_session_new`] (or null), not freed; `profile` points at `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_link_wanted(s: *const MarginSession, profile: *const u8, len: usize) -> bool {
    match (session(s), text(profile, len)) {
        (Some(s), Some(p)) => s.link_wanted(p),
        _ => false,
    }
}

/// Whether a new app's open for `item` in Margin window `window` is still wanted (false for a null session).
///
/// # Safety
/// As [`margin_session_link_wanted`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_open_wanted(
    s: *const MarginSession,
    window: i64,
    item: *const u8,
    len: usize,
) -> bool {
    match (session(s), text(item, len)) {
        (Some(s), Some(i)) => s.open_wanted(window, i),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// The ports' questions, and the session to call back into (a port re-entering, as Swift's may).
    #[derive(Default)]
    struct Swift {
        asked: RefCell<Vec<Value>>,
        session: RefCell<*const MarginSession>,
    }

    unsafe extern "C" {
        fn malloc(n: usize) -> *mut c_void;
    }

    extern "C" fn now(_: *mut c_void) -> f64 {
        5.0
    }

    extern "C" fn port(ctx: *mut c_void, q: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
        // SAFETY: ctx is the test's Swift, alive for the call; the question's bytes as passed.
        let swift = unsafe { &*(ctx as *const Swift) };
        let q: Value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(q, len) }).unwrap_or(Value::Null);
        swift.asked.borrow_mut().push(q.clone());
        // (Back in, during the call: a read of the state.)
        let s = *swift.session.borrow();
        let r = br#"{"type":"state","get":["shown"]}"#;
        let mut n = 0;
        // SAFETY: the live session; the request's bytes.
        let back = unsafe { margin_session_input(s, r.as_ptr(), r.len(), &mut n) };
        // SAFETY: a buffer the call made.
        unsafe { crate::margin_buffer_free(back, n) };
        let a = if q["port"] == json!("window") { r#"{"id":1}"# } else { "{}" };
        // SAFETY: malloc'd here, freed by the session with free.
        unsafe {
            let p = malloc(a.len()) as *mut u8;
            std::ptr::copy_nonoverlapping(a.as_ptr(), p, a.len());
            *out_len = a.len();
            p
        }
    }

    fn call(s: *const MarginSession, v: Value) -> Value {
        let t = v.to_string();
        let mut len = 0;
        // SAFETY: the live session, the input's bytes.
        let out = unsafe { margin_session_input(s, t.as_ptr(), t.len(), &mut len) };
        read(out, len)
    }

    fn read(out: *mut u8, len: usize) -> Value {
        // SAFETY: a buffer a session call made, `len` bytes.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: margin_buffer_free's contract.
        unsafe { crate::margin_buffer_free(out, len) };
        v
    }

    #[test]
    fn navigate_through_the_ffi_its_url_from_the_library_object() {
        let dir = tempfile::tempdir().expect("a folder");
        let root = dir.path().to_string_lossy().to_string();
        // SAFETY: the root's bytes.
        let lib = unsafe { crate::margin_library_new(root.as_ptr(), root.len(), false, std::ptr::null_mut(), None) };
        let apply = json!({ "type": "apply", "at": 1, "entries": [{ "collection": "tabs", "id": "t1", "value": { "url": "https://a/" } }] })
            .to_string();
        let mut n = 0;
        // SAFETY: the library, the request's bytes.
        read(unsafe { crate::margin_library_call(lib, apply.as_ptr(), apply.len(), &mut n) }, n);
        let swift = Swift::default();
        let options = br#"{"every":0.05}"#;
        // SAFETY: the library, the options' bytes, the test's Swift as ctx (alive for the test).
        let s = unsafe {
            margin_session_new(
                lib,
                options.as_ptr(),
                options.len(),
                &swift as *const Swift as *mut c_void,
                Some(now),
                Some(port),
            )
        };
        *swift.session.borrow_mut() = s;
        call(
            s,
            json!({ "type": "state", "set": {
            "shown": { "put": [[1, "t1"]] }, "open": { "put": [["t1", "safari:p", "p"]] }, "safariWindows": { "put": [["p", "main", 90]] } } }),
        );
        // SAFETY: the live session.
        assert_eq!(unsafe { margin_session_rev(s, 0) }, 1);
        let asked = call(s, json!({ "type": "navigate", "kind": "goBack", "window": 1 }));
        assert_eq!((asked["ready"].clone(), asked.get("start")), (json!(true), None));
        let mut n = 0;
        // SAFETY: the live session.
        let out = read(unsafe { margin_session_tick(s, 0.0, &mut n) }, n);
        assert_eq!(
            out["start"],
            json!([{ "op": "ask", "id": 1, "profile": "p", "kind": "hostShow", "payload": { "windowId": 90, "itemId": "t1", "url": "https://a/" } }])
        );
        assert_eq!(swift.asked.borrow()[0], json!({ "port": "window", "id": 1 }));
        // SAFETY: the live session.
        assert!(!unsafe { margin_session_idle(s) });
        // SAFETY: the live session.
        read(unsafe { margin_session_tick(s, 0.0, &mut n) }, n);
        let reply = br#"{"result":{"tabId":7},"error":null}"#;
        // SAFETY: the live session, the reply's bytes.
        let out = read(unsafe { margin_session_answer(s, 1, reply.as_ptr(), reply.len(), &mut n) }, n);
        assert_eq!(out["start"][0]["kind"], json!("goBack"));
        assert_eq!(out["start"][0]["payload"], json!({ "tabId": 7 }));
        let bad = call(s, json!({ "type": "nonsense" }));
        assert!(bad["error"].is_string() && bad["log"][0]["warn"] == json!(true));
        call(s, json!({ "type": "note", "line": "hello" }));
        assert_eq!(
            swift.asked.borrow().last(),
            Some(&json!({ "port": "log", "warn": false, "text": "hosted: hello" }))
        );
        // SAFETY: the live session.
        assert_eq!(read(unsafe { margin_session_done(s, &mut n) }, n), json!(["hello"]));
        // SAFETY: from margin_session_new / margin_library_new, freed once, the session first.
        unsafe {
            margin_session_free(s);
            crate::margin_library_free(lib);
        }
        // (Null: answers, no harm.)
        // SAFETY: null pointers are allowed.
        unsafe {
            assert!(margin_session_idle(std::ptr::null()));
            assert_eq!(margin_session_rev(std::ptr::null(), 0), 0);
            assert!(read(margin_session_tick(std::ptr::null(), 0.0, &mut n), n)["error"].is_string());
        }
    }
}
