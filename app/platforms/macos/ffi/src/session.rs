//! The session (margin-core's `session`: HostedSession's flows as async steps, docs/CORE-REFACTOR.md step 3) for the
//! Mac app's Swift. One object per app, made with the library object (its reads go straight to the library's set) and
//! the Swift side's ports: `now` (typed: read at every sleep), `call` (typed: the ports a show asks, by their number,
//! their texts as bytes and the texts they answer given back through `margin_port_out_text`, nothing in JSON) and
//! `port` (JSON in, JSON out allocated with `malloc`, freed here with `free`, as `MarginDataNeed`: the rare ones, and
//! every one when there's no `call`), all called during a call, on its thread, and free to call back in.
//!
//! - `margin_session_input`: an input (`{ type, … }`); `margin_session_answer`: a command's answer by its id;
//!   `margin_session_tick`: the commands handed out are started, and the deadlines up to `due` are over. Each answers
//!   `{ start?, deadline, log?, reply?, error? }`: the commands to start at once, in order, before calling `tick`; the
//!   earliest deadline (null: none); the log lines since; a read's reply; a bad input's error, logged once a kind.
//!   Given a `MarginSessionStatus`, its readiness and deadline are written there and the JSON comes only when there's
//!   more to say (null otherwise): most answers of a switch are nothing to read.
//! - The facade's fields, typed: `margin_session_rows` (a field's rows to a callback) and `margin_session_edit_row`.
//! - Typed reads: `margin_session_done` (the last 200 lines, JSON), `margin_session_idle`,
//!   `margin_session_rev` (a field's revision: the facade reads it again only when it changed),
//!   `margin_session_link_wanted` (the Safari waker's look, every 0.05 s while it waits: nothing allocated),
//!   `margin_session_open_wanted` (the engine's, while a new app's window is awaited).
//!
//! Every function takes the object as a shared pointer: a call made inside another (a port's callback calling back
//! in) only changes state and queues tasks. Nothing here panics on what it's given.

use std::ffi::c_void;

use margin_core::data::library::LibraryStore;
use margin_core::geometry::Rect;
use margin_core::json;
use margin_core::session::state::rect_read;
use margin_core::session::{Field, LibraryView, Out, Performed, Ports, Row, Session};
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

/// Text as bytes (UTF-8; a null `ptr`: none).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MarginBytes {
    pub ptr: *const u8,
    pub len: usize,
}

impl MarginBytes {
    fn of(s: Option<&str>) -> Self {
        s.map_or(MarginBytes { ptr: std::ptr::null(), len: 0 }, |s| MarginBytes { ptr: s.as_ptr(), len: s.len() })
    }
    fn text<'a>(self) -> Option<&'a str> {
        if self.ptr.is_null() { None } else { text(self.ptr, self.len) }
    }
}

/// A typed port's question: a window (`has_window`: one named; else the front one), a flag, up to three texts.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MarginPortArgs {
    pub window: i64,
    pub has_window: bool,
    pub flag: bool,
    pub a: MarginBytes,
    pub b: MarginBytes,
    pub c: MarginBytes,
}

/// What a typed port answers besides its number: texts and whole numbers, given back during the call.
#[derive(Default)]
pub struct MarginPortOut {
    texts: Vec<String>,
    ints: Vec<i64>,
}

/// A typed port (`kind`: session.rs `PortKind`'s number): its answer, a number (`i64::MIN`: none).
pub type MarginSessionCall =
    extern "C" fn(ctx: *mut c_void, kind: u32, args: *const MarginPortArgs, out: *mut MarginPortOut) -> i64;

/// A text a typed port answers (`out` from the call: its texts in order).
///
/// # Safety
/// `out` as the port was given it, during its call; `ptr` points at `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_port_out_text(out: *mut MarginPortOut, ptr: *const u8, len: usize) {
    // SAFETY: the port's `out`, alive for its call (the caller's contract).
    if let (Some(out), Some(t)) = (unsafe { out.as_mut() }, text(ptr, len)) {
        out.texts.push(t.to_owned());
    }
}

/// A whole number a typed port answers (its list's next).
///
/// # Safety
/// As [`margin_port_out_text`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_port_out_int(out: *mut MarginPortOut, n: i64) {
    // SAFETY: as margin_port_out_text.
    if let Some(out) = unsafe { out.as_mut() } {
        out.ints.push(n);
    }
}

/// The typed ports' numbers (SessionCore.swift `PortKind`).
#[derive(Clone, Copy)]
#[repr(u32)]
enum PortKind {
    Window = 0,
    WindowIds = 1,
    EngineShown = 2,
    IsHosted = 3,
    SafariProfiles = 4,
    LinkEpoch = 5,
    AppName = 6,
    AppRuns = 7,
    ShowsAlone = 8,
    StopHidingWoken = 9,
    WindowIdsOf = 10,
    SetShowing = 11,
    SetMarginPage = 12,
    Push = 13,
    Changed = 14,
    WokenByMenu = 15,
    Unopenable = 16,
    Log = 17,
    // (Commit 7's: the wall clock and a window's rects, on a peek open's path; numbers as their bits.)
    Wall = 18,
    CardRect = 19,
    HostedPage = 30,
    SettleHosting = 23,
    RefreshLoading = 24,
    LeaveMarginPage = 25,
    ClearElsewhere = 28,
    ForgetElsewhere = 29,
}

const NONE: i64 = i64::MIN;

pub struct MarginSession {
    session: Session,
}

struct SwiftPorts {
    ctx: *mut c_void,
    now: Option<MarginSessionNow>,
    port: Option<MarginSessionPort>,
    call: Option<MarginSessionCall>,
}

impl SwiftPorts {
    /// A typed port: its number, its texts in `out`.
    fn typed(
        &self,
        call: MarginSessionCall,
        kind: PortKind,
        window: Option<i64>,
        flag: bool,
        texts: [Option<&str>; 3],
        out: &mut MarginPortOut,
    ) -> i64 {
        let args = MarginPortArgs {
            window: window.unwrap_or(0),
            has_window: window.is_some(),
            flag,
            a: MarginBytes::of(texts[0]),
            b: MarginBytes::of(texts[1]),
            c: MarginBytes::of(texts[2]),
        };
        call(self.ctx, kind as u32, &args, out)
    }

    /// A typed port asked for its number alone.
    fn number(
        &self,
        call: MarginSessionCall,
        kind: PortKind,
        window: Option<i64>,
        flag: bool,
        texts: [Option<&str>; 3],
    ) -> i64 {
        self.typed(call, kind, window, flag, texts, &mut MarginPortOut::default())
    }

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
        if let Some(c) = self.call {
            let w = self.number(c, PortKind::Window, id, false, [None; 3]);
            return (w != NONE).then_some(w);
        }
        json::int(self.ask(json!({ "port": "window", "id": id })).get("id"))
    }
    fn window_ids(&self) -> Vec<i64> {
        if let Some(c) = self.call {
            let mut out = MarginPortOut::default();
            self.typed(c, PortKind::WindowIds, None, false, [None; 3], &mut out);
            return out.ints;
        }
        let v = self.ask(json!({ "port": "windowIds" }));
        json::array(v.get("ids")).map(|l| l.iter().filter_map(|i| json::int(Some(i))).collect()).unwrap_or_default()
    }
    fn engine_shown(&self) -> Option<String> {
        if let Some(c) = self.call {
            return self.text(c, PortKind::EngineShown, None, [None; 3]);
        }
        Self::string(&self.ask(json!({ "port": "engineShown" })), "host")
    }
    fn is_hosted(&self, host: &str) -> bool {
        if let Some(c) = self.call {
            return self.number(c, PortKind::IsHosted, None, false, [Some(host), None, None]) == 1;
        }
        self.ask(json!({ "port": "isHosted", "host": host })).get("hosted").and_then(Value::as_bool) == Some(true)
    }
    fn safari_profiles(&self) -> Vec<String> {
        if let Some(c) = self.call {
            let mut out = MarginPortOut::default();
            self.typed(c, PortKind::SafariProfiles, None, false, [None; 3], &mut out);
            return out.texts;
        }
        Self::strings(&self.ask(json!({ "port": "safariProfiles" })), "profiles")
    }
    fn link_epoch(&self, profile: &str) -> Option<String> {
        if let Some(c) = self.call {
            return self.text(c, PortKind::LinkEpoch, None, [Some(profile), None, None]);
        }
        Self::string(&self.ask(json!({ "port": "linkEpoch", "profile": profile })), "epoch")
    }
    fn app_name(&self, bundle: &str) -> Option<String> {
        if let Some(c) = self.call {
            return self.text(c, PortKind::AppName, None, [Some(bundle), None, None]);
        }
        Self::string(&self.ask(json!({ "port": "appName", "bundle": bundle })), "name")
    }
    fn app_runs(&self, bundle: &str) -> Option<bool> {
        if let Some(c) = self.call {
            return match self.number(c, PortKind::AppRuns, None, false, [Some(bundle), None, None]) {
                1 => Some(true),
                0 => Some(false),
                _ => None,
            };
        }
        self.ask(json!({ "port": "appRuns", "bundle": bundle })).get("runs").and_then(Value::as_bool)
    }
    fn shows_alone(&self, host: &str) -> bool {
        if let Some(c) = self.call {
            return self.number(c, PortKind::ShowsAlone, None, false, [Some(host), None, None]) != 0;
        }
        self.ask(json!({ "port": "showsAlone", "host": host })).get("alone").and_then(Value::as_bool) != Some(false)
    }
    fn stop_hiding_woken(&self, bundle: &str) {
        if let Some(c) = self.call {
            self.number(c, PortKind::StopHidingWoken, None, false, [Some(bundle), None, None]);
            return;
        }
        self.ask(json!({ "port": "stopHidingWoken", "bundle": bundle }));
    }
    fn window_ids_of(&self, profile: &str) -> Vec<i64> {
        if let Some(c) = self.call {
            let mut out = MarginPortOut::default();
            self.typed(c, PortKind::WindowIdsOf, None, false, [Some(profile), None, None], &mut out);
            return out.ints;
        }
        let v = self.ask(json!({ "port": "windowIdsOf", "profile": profile }));
        json::array(v.get("ids")).map(|l| l.iter().filter_map(|i| json::int(Some(i))).collect()).unwrap_or_default()
    }
    fn wall(&self) -> f64 {
        if let Some(c) = self.call {
            return f64::from_bits(self.number(c, PortKind::Wall, None, false, [None; 3]) as u64);
        }
        json::num(self.ask(json!({ "port": "wall" })).get("now")).unwrap_or(0.0)
    }
    fn set_showing(&self, window: i64, label: Option<&str>, app: Option<&str>, slow: bool) {
        if let Some(c) = self.call {
            self.number(c, PortKind::SetShowing, Some(window), slow, [label, app, None]);
            return;
        }
        self.ask(json!({ "port": "setShowing", "window": window, "label": label, "app": app, "slow": slow }));
    }
    fn set_margin_page(&self, window: i64, page: Option<&str>) {
        if let Some(c) = self.call {
            self.number(c, PortKind::SetMarginPage, Some(window), false, [page, None, None]);
            return;
        }
        self.ask(json!({ "port": "setMarginPage", "window": window, "page": page }));
    }
    fn push(&self, window: i64, json: &str) {
        if let Some(c) = self.call {
            self.number(c, PortKind::Push, Some(window), false, [Some(json), None, None]);
            return;
        }
        self.ask(json!({ "port": "push", "window": window, "json": json }));
    }
    fn changed(&self) {
        if let Some(c) = self.call {
            self.number(c, PortKind::Changed, None, false, [None; 3]);
            return;
        }
        self.ask(json!({ "port": "changed" }));
    }
    fn woken_by_menu(&self, profile: &str) -> bool {
        if let Some(c) = self.call {
            return self.number(c, PortKind::WokenByMenu, None, false, [Some(profile), None, None]) == 1;
        }
        self.ask(json!({ "port": "wokenByMenu", "profile": profile })).get("woken").and_then(Value::as_bool)
            == Some(true)
    }
    fn unopenable(&self, profile: &str) -> bool {
        if let Some(c) = self.call {
            return self.number(c, PortKind::Unopenable, None, false, [Some(profile), None, None]) == 1;
        }
        self.ask(json!({ "port": "unopenable", "profile": profile })).get("unopenable").and_then(Value::as_bool)
            == Some(true)
    }
    fn log(&self, warn: bool, text: &str) {
        if let Some(c) = self.call {
            self.number(c, PortKind::Log, None, warn, [Some(text), None, None]);
            return;
        }
        self.ask(json!({ "port": "log", "warn": warn, "text": text }));
    }
    fn swift(&self, call: &str, args: Value) -> Value {
        // (The ones a show asks, typed; the rare ones by JSON.)
        if let Some(c) = self.call {
            let w = args.get("window").and_then(|w| json::int(Some(w)));
            let item = args.get("item").and_then(Value::as_str);
            let kind = match call {
                "settleHosting" => Some(PortKind::SettleHosting),
                "refreshLoading" => Some(PortKind::RefreshLoading),
                "leaveMarginPage" => Some(PortKind::LeaveMarginPage),
                "clearElsewhere" => Some(PortKind::ClearElsewhere),
                "forgetElsewhere" => Some(PortKind::ForgetElsewhere),
                _ => None,
            };
            if let Some(kind) = kind {
                self.number(c, kind, w, false, [item, None, None]);
                return Value::Null;
            }
        }
        self.ask(json!({ "port": "swift", "call": call, "args": args })).get("value").cloned().unwrap_or(Value::Null)
    }
    // (The preview card's, commit 7: rare, JSON.)
    fn card_rect(&self, window: i64) -> Option<Rect> {
        if let Some(c) = self.call {
            return self.rect(c, PortKind::CardRect, window);
        }
        self.ask(json!({ "port": "cardRect", "window": window })).get("rect").and_then(rect_read)
    }
    fn hosted_page(&self, window: i64) -> Option<Rect> {
        if let Some(c) = self.call {
            return self.rect(c, PortKind::HostedPage, window);
        }
        self.ask(json!({ "port": "hostedPage", "window": window })).get("page").and_then(rect_read)
    }
    fn idna(&self, host: &str) -> bool {
        self.ask(json!({ "port": "idna", "host": host })).get("ok").and_then(Value::as_bool) == Some(true)
    }
    fn url_host(&self, url: &str) -> Option<String> {
        Self::string(&self.ask(json!({ "port": "urlHost", "url": url })), "host")
    }
    fn perform(&self, action: &str, payload: &Map<String, Value>) -> Performed {
        Performed::read(&self.ask(json!({ "port": "perform", "action": action, "payload": payload })))
    }
}

impl SwiftPorts {
    /// A typed port's rect: 1 and its x, y, width, height as their bits (`f64::to_bits`), else none.
    fn rect(&self, call: MarginSessionCall, kind: PortKind, window: i64) -> Option<Rect> {
        let mut out = MarginPortOut::default();
        if self.typed(call, kind, Some(window), false, [None; 3], &mut out) != 1 || out.ints.len() != 4 {
            return None;
        }
        let n = |i: usize| f64::from_bits(out.ints[i] as u64);
        Some(Rect::new(n(0), n(1), n(2), n(3)))
    }

    /// A typed port's one text (none: it gave none).
    fn text(
        &self,
        call: MarginSessionCall,
        kind: PortKind,
        window: Option<i64>,
        texts: [Option<&str>; 3],
    ) -> Option<String> {
        let mut out = MarginPortOut::default();
        self.typed(call, kind, window, false, texts, &mut out);
        out.texts.into_iter().next()
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
/// Swift side's ports (`ctx` passed back to each; alive as long as the session): `call`, the typed ones (null: every
/// port through `port`).
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
    call: Option<MarginSessionCall>,
) -> *mut MarginSession {
    let options = text(options, len).and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null);
    let ports = SwiftPorts { ctx, now, port, call };
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

/// A call's answer as the Mac reads it most often: whether tasks are ready, the earliest deadline (NaN: none).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct MarginSessionStatus {
    pub ready: bool,
    pub deadline: f64,
}

/// An answer: with `status`, its readiness and deadline there and its JSON only when there's more (else null, 0
/// bytes); without, all of it as JSON.
fn give(out: &Out, status: *mut MarginSessionStatus, out_len: *mut usize) -> *mut u8 {
    // SAFETY: a writable status or null (the caller's contract).
    match unsafe { status.as_mut() } {
        Some(st) => {
            *st = MarginSessionStatus { ready: out.ready, deadline: out.deadline.unwrap_or(f64::NAN) };
            if Session::has_more(out) {
                answer(&out.to_json(), out_len)
            } else {
                if !out_len.is_null() {
                    // SAFETY: writable (the caller's contract).
                    unsafe { *out_len = 0 };
                }
                std::ptr::null_mut()
            }
        }
        None => answer(&out.to_json(), out_len),
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
    status: *mut MarginSessionStatus,
    out_len: *mut usize,
) -> *mut u8 {
    let Some(s) = session(s) else { return answer(&json!({ "error": "no session" }), out_len) };
    let input = text(input, len).and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Null);
    give(&s.input(&input), status, out_len)
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
    status: *mut MarginSessionStatus,
    out_len: *mut usize,
) -> *mut u8 {
    let Some(s) = session(s) else { return answer(&json!({ "error": "no session" }), out_len) };
    let reply = text(reply, len).and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Null);
    give(&s.answer(id, reply), status, out_len)
}

/// A page's click for a preview (the copy's `peekOpen` push), typed: its profile, its window (`has_window`), its id
/// and address (null: none, as empty), its time (0: none) → the call's answer, as `margin_session_input`'s.
///
/// # Safety
/// `s` from [`margin_session_new`], not freed; each text's `len` bytes readable; `status` writable or null;
/// `out_len` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_peek_open(
    s: *const MarginSession,
    profile: MarginBytes,
    window: i64,
    has_window: bool,
    id: MarginBytes,
    url: MarginBytes,
    not_after: f64,
    status: *mut MarginSessionStatus,
    out_len: *mut usize,
) -> *mut u8 {
    let Some(s) = session(s) else { return answer(&json!({ "error": "no session" }), out_len) };
    let not_after = if not_after.is_finite() { not_after } else { 0.0 };
    let (p, i, u) = (profile.text().unwrap_or(""), id.text().unwrap_or(""), url.text().unwrap_or(""));
    give(&s.peek_open(p, has_window.then_some(window), i, u, not_after), status, out_len)
}

/// The commands handed out are started, the deadlines up to `due` over → the call's answer.
///
/// # Safety
/// `s` from [`margin_session_new`], not freed; `out_len` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_tick(
    s: *const MarginSession,
    due: f64,
    status: *mut MarginSessionStatus,
    out_len: *mut usize,
) -> *mut u8 {
    let Some(s) = session(s) else { return answer(&json!({ "error": "no session" }), out_len) };
    give(&s.tick(due), status, out_len)
}

/// One row of a field, typed (session/state.rs `Row`; `s0`…`s2`: texts, a null pointer none).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MarginRow {
    pub i0: i64,
    pub f: f64,
    pub b0: bool,
    pub b1: bool,
    pub s0: MarginBytes,
    pub s1: MarginBytes,
    pub s2: MarginBytes,
}

/// A row handed to the caller, its texts valid during the call only.
pub type MarginRowSink = extern "C" fn(ctx: *mut c_void, row: *const MarginRow);

/// A field's rows (`field`: its revision's number), each to `sink` in the field's order. The sink must not call
/// into the session. Nothing for a null session or another number.
///
/// # Safety
/// `s` from [`margin_session_new`] (or null), not freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_rows(
    s: *const MarginSession,
    field: u32,
    ctx: *mut c_void,
    sink: Option<MarginRowSink>,
) {
    let (Some(s), Some(f), Some(sink)) = (session(s), Field::from_index(field), sink) else { return };
    s.rows(f, &mut |r| {
        let row = MarginRow {
            i0: r.i0,
            f: r.f,
            b0: r.b0,
            b1: r.b1,
            s0: MarginBytes::of(r.s0),
            s1: MarginBytes::of(r.s1),
            s2: MarginBytes::of(r.s2),
        };
        sink(ctx, &row);
    });
}

/// One row of a field put or (`del`) taken out: whether it was one; the field's revision after it in `rev`.
///
/// # Safety
/// As [`margin_session_rows`]; `row` readable (its texts as said), `rev` writable or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_edit_row(
    s: *const MarginSession,
    field: u32,
    del: bool,
    row: *const MarginRow,
    rev: *mut u64,
) -> bool {
    // SAFETY: readable or null (the caller's contract).
    let (Some(s), Some(f), Some(r)) = (session(s), Field::from_index(field), unsafe { row.as_ref() }) else {
        return false;
    };
    let row = Row { i0: r.i0, f: r.f, b0: r.b0, b1: r.b1, s0: r.s0.text(), s1: r.s1.text(), s2: r.s2.text() };
    let (ok, now) = s.edit_row(f, del, &row);
    if !rev.is_null() {
        // SAFETY: writable (the caller's contract).
        unsafe { *rev = now };
    }
    ok
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

/// Whether `item` (`len` bytes of UTF-8) is a pin's or a favourite's tab (false for a null session or an item that
/// isn't text): Swift's applyLayout's `pinned`, each web pane. No JSON.
///
/// # Safety
/// As [`margin_session_link_wanted`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_session_pinned(s: *const MarginSession, item: *const u8, len: usize) -> bool {
    match (session(s), text(item, len)) {
        (Some(s), Some(i)) => s.pinned_or_favorite(i),
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
        let back = unsafe { margin_session_input(s, r.as_ptr(), r.len(), std::ptr::null_mut(), &mut n) };
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
        let out = unsafe { margin_session_input(s, t.as_ptr(), t.len(), std::ptr::null_mut(), &mut len) };
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
                None,
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
        let out = read(unsafe { margin_session_tick(s, 0.0, std::ptr::null_mut(), &mut n) }, n);
        assert_eq!(
            out["start"],
            json!([{ "op": "ask", "id": 1, "profile": "p", "kind": "hostShow", "payload": { "windowId": 90, "itemId": "t1", "url": "https://a/" } }])
        );
        assert_eq!(swift.asked.borrow()[0], json!({ "port": "window", "id": 1 }));
        // SAFETY: the live session.
        assert!(!unsafe { margin_session_idle(s) });
        // SAFETY: the live session.
        read(unsafe { margin_session_tick(s, 0.0, std::ptr::null_mut(), &mut n) }, n);
        let reply = br#"{"result":{"tabId":7},"error":null}"#;
        // SAFETY: the live session, the reply's bytes.
        let out =
            read(unsafe { margin_session_answer(s, 1, reply.as_ptr(), reply.len(), std::ptr::null_mut(), &mut n) }, n);
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
            assert!(
                read(margin_session_tick(std::ptr::null(), 0.0, std::ptr::null_mut(), &mut n), n)["error"].is_string()
            );
        }
    }

    /// The typed ports' questions, as the test's Swift heard them.
    #[derive(Default)]
    struct Typed {
        heard: RefCell<Vec<String>>,
    }

    extern "C" fn typed(ctx: *mut c_void, kind: u32, args: *const MarginPortArgs, out: *mut MarginPortOut) -> i64 {
        // SAFETY: ctx is the test's Typed, args the call's.
        let (t, a) = unsafe { (&*(ctx as *const Typed), &*args) };
        let text = a.a.text().map(str::to_owned);
        t.heard.borrow_mut().push(format!("{kind} {} {} {:?} {}", a.has_window, a.window, text, a.flag));
        match kind {
            0 => 1,
            4 => {
                let p = "s-work";
                // SAFETY: the call's out, a text's bytes.
                unsafe { margin_port_out_text(out, p.as_ptr(), p.len()) };
                0
            }
            _ => 0,
        }
    }

    #[test]
    fn the_typed_ports_and_rows() {
        let t = Typed::default();
        let options = br#"{"every":0.05}"#;
        // SAFETY: no library, the options' bytes, the test's Typed as ctx (alive for the test); no JSON port.
        let s = unsafe {
            margin_session_new(
                std::ptr::null_mut(),
                options.as_ptr(),
                options.len(),
                &t as *const Typed as *mut c_void,
                Some(now),
                None,
                Some(typed),
            )
        };
        let row = |s0: Option<&'static str>, i0: i64| MarginRow {
            i0,
            f: 0.0,
            b0: false,
            b1: false,
            s0: MarginBytes::of(s0),
            s1: MarginBytes::of(None),
            s2: MarginBytes::of(None),
        };
        let mut rev = 0;
        // SAFETY: the live session, a row, a writable revision.
        assert!(unsafe { margin_session_edit_row(s, Field::Requested as u32, false, &row(Some("t1"), 1), &mut rev) });
        assert_eq!(rev, 1);
        // SAFETY: as above.
        assert!(
            !unsafe { margin_session_edit_row(s, Field::Requested as u32, false, &row(None, 2), &mut rev) },
            "an item needed"
        );
        // A note logged through the typed port; the overtaken check's window read through it.
        let mut n = 0;
        let mut status = MarginSessionStatus::default();
        let q = br#"{"type":"overtaken","item":"t2","window":1}"#;
        // SAFETY: the live session, the input's bytes, a status.
        let out = unsafe { margin_session_input(s, q.as_ptr(), q.len(), &mut status, &mut n) };
        assert_eq!(read(out, n)["reply"], json!(true), "a reply: JSON");
        assert!(!status.ready && status.deadline.is_nan());
        assert_eq!(
            *t.heard.borrow(),
            ["0 true 1 None false", "17 false 0 Some(\"hosted: t2: not shown, t1 asked for since\") false"]
        );
        // Nothing more to say: no JSON.
        let q = br#"{"type":"cycled","window":1}"#;
        // SAFETY: as above.
        let out = unsafe { margin_session_input(s, q.as_ptr(), q.len(), &mut status, &mut n) };
        assert!(out.is_null() && n == 0);
        // The rows, typed.
        extern "C" fn sink(ctx: *mut c_void, r: *const MarginRow) {
            // SAFETY: ctx is the test's list, the row the call's.
            let (rows, r) = unsafe { (&*(ctx as *const RefCell<Vec<(i64, Option<String>, f64)>>), &*r) };
            rows.borrow_mut().push((r.i0, r.s0.text().map(str::to_owned), r.f));
        }
        let rows: RefCell<Vec<(i64, Option<String>, f64)>> = RefCell::default();
        for f in [Field::Requested, Field::CycledAt] {
            // SAFETY: the live session, the list as ctx.
            unsafe { margin_session_rows(s, f as u32, &rows as *const _ as *mut c_void, Some(sink)) };
        }
        assert_eq!(*rows.borrow(), [(1, Some("t1".to_owned()), 0.0), (1, None, 5.0)]);
        // A page's click, typed: refused (no window), its answer to the copy queued, said through the typed log.
        t.heard.borrow_mut().clear();
        let text = |s: &'static str| MarginBytes::of(Some(s));
        // SAFETY: the live session, the texts' bytes, a status.
        let out = unsafe {
            margin_session_peek_open(
                s,
                text("p"),
                0,
                false,
                text("c1"),
                text("https://a.example/"),
                1e15,
                &mut status,
                &mut n,
            )
        };
        assert!(out.is_null() && status.ready, "nothing more to say; the answer to the copy ready");
        assert_eq!(
            t.heard.borrow().last().map(String::as_str),
            Some("17 false 0 Some(\"hosted: Preview asked by a page: refused (no window)\") false")
        );
        // SAFETY: from margin_session_new, freed once.
        unsafe { margin_session_free(s) };
    }
}
