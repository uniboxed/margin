//! The link (margin-core's `link_hub`: the copies' WebSockets, Chrome's and Edge's relays, Safari's way in) for the Mac
//! app's Swift (docs/CORE-REFACTOR.md step 1.5). One object per app: the Swift side owns the sockets (NWListener and
//! NWConnection, the relays' Unix socket), Safari's dispatch, the notification, the note's file and one timer; it
//! passes in what they say, and carries out the answer's `do` list in order.
//!
//! - Bytes in are a typed call (`margin_link_bytes`: a copy's TCP bytes or a relay's), nothing re-encoded; bytes out
//!   go through the `write` callback during the call (each write in order, before the call returns: the answer's
//!   `end`s come after them), so a frame is never copied into JSON.
//! - Everything else is one JSON call (`margin_link_call`), its answer `{ do: […], deadline, port, refusedInARow }`
//!   (and the call's own fields). `now` is the caller's monotonic clock (a sleep is never 40 s of silence), `wall`
//!   the wall clock's (every `at`).
//! - Each link's state is the core's (`link_hub`'s mirrors): a snapshot, a delta or a window list is applied inside
//!   the bytes' call, and the answer says only what it did (`state`: its keys, the windows when they changed, the
//!   mirror's flags), never the values again; a value is read when the app needs it (`margin_link_state_value`: its
//!   JSON's bytes as kept). A resync is the core's too (logged, sent, retried at the answer's `deadline`).
//! - The builders and readers of the Mac's window requests (`setWindowState` with `land: false`, what a windows call
//!   answered, what `newWindow` answered): `margin_link_protocol`, with no object.
//!
//! Nothing here panics on what it's given: a bad request is `{"error": …}`.

use std::ffi::c_void;

use margin_core::json::{self, Object};
use margin_core::link::{Level, LinkError, Timing};
use margin_core::link_hub::{HubOut, LinkHub, StateApplied, Which};
use margin_core::mirror::Outcome;
use margin_core::protocol::{
    AppMessage, HandoffRequest, LinkMessage, MAX_APP_MESSAGE, SpaceWindowAnswer, VERSION, WindowCallAnswer,
    WindowState, number,
};
use margin_core::socket::SocketLink;
use serde_json::{Value, json};

use crate::data::{answer, text};

/// A write: `which` 0 a copy's TCP connection, 1 a relay's; `len` bytes at `bytes`, to copy before returning.
pub type MarginLinkWrite = extern "C" fn(ctx: *mut c_void, which: u8, conn: u64, bytes: *const u8, len: usize);

pub struct MarginLink {
    hub: LinkHub,
    ctx: *mut c_void,
    write: Option<MarginLinkWrite>,
}

fn f(o: &Object, k: &str) -> Option<f64> {
    json::num(o.get(k))
}

fn conn(o: &Object) -> u64 {
    o.get("conn").and_then(Value::as_u64).unwrap_or(0)
}

fn timing(o: Option<&Object>) -> (Timing, f64, f64) {
    let d = Timing::default();
    let Some(o) = o else { return (d, margin_core::socket::KEEP, margin_core::socket::SAFARI_SETTLED) };
    let pos = |k: &str, or: f64| f(o, k).filter(|v| *v > 0.0).unwrap_or(or);
    (
        Timing {
            tick: pos("tick", d.tick),
            dead: pos("dead", d.dead),
            hello: pos("hello", d.hello),
            request: pos("request", d.request),
        },
        pos("keep", margin_core::socket::KEEP),
        f(o, "safariSettled").filter(|v| *v >= 0.0).unwrap_or(margin_core::socket::SAFARI_SETTLED),
    )
}

fn error_name(e: LinkError) -> &'static str {
    match e {
        LinkError::Down => "down",
        LinkError::TimedOut => "timedOut",
        LinkError::NotJson => "notJSON",
    }
}

fn which_name(w: Which) -> &'static str {
    match w {
        Which::Tcp => "tcp",
        Which::Relay => "relay",
    }
}

impl MarginLink {
    /// The outs carried out: each write to the callback now, the rest in the answer's list, in order.
    fn carry(&self, outs: Vec<HubOut>, list: &mut Vec<Value>) {
        for o in outs {
            let item = match o {
                HubOut::Write { which, conn, bytes } => {
                    if let Some(write) = self.write {
                        write(self.ctx, if which == Which::Tcp { 0 } else { 1 }, conn, bytes.as_ptr(), bytes.len());
                    }
                    continue;
                }
                HubOut::End { which, conn } => json!({ "do": "end", "which": which_name(which), "conn": conn }),
                HubOut::Safari { name, info, n } => json!({ "do": "safari", "name": name, "info": info, "n": n }),
                HubOut::Note(info) => json!({ "do": "note", "info": info }),
                HubOut::AppUpDue => json!({ "do": "appUpDue" }),
                HubOut::Up { conn, hello } => json!({ "do": "up", "conn": conn, "hello": hello.object() }),
                HubOut::State { conn, key, applied } => state_json(conn, &key, applied),
                HubOut::Received { conn, key, message } => {
                    json!({ "do": "received", "conn": conn, "key": key, "message": message.object() })
                }
                HubOut::Theme { conn, key, epoch, id, data } => {
                    let bytes = data.len();
                    let text = String::from_utf8(data).ok();
                    json!({ "do": "theme", "conn": conn, "key": key, "epoch": epoch, "id": id, "text": text, "bytes": bytes })
                }
                HubOut::ThemeRefused { conn, key, why } => {
                    json!({ "do": "themeRefused", "conn": conn, "key": key, "why": why })
                }
                HubOut::Down { conn, key, why } => json!({ "do": "down", "conn": conn, "key": key, "why": why }),
                HubOut::Answer { conn, id, answer: Ok(reply) } => {
                    json!({ "do": "answer", "conn": conn, "id": id, "reply": reply })
                }
                HubOut::Answer { conn, id, answer: Err(e) } => {
                    json!({ "do": "answer", "conn": conn, "id": id, "error": error_name(e) })
                }
                HubOut::Refused { name, why } => json!({ "do": "refused", "name": name, "why": why }),
                HubOut::Log { level, text } => json!({ "do": "log", "warn": level == Level::Warn, "text": text }),
            };
            list.push(item);
        }
    }

    fn reply(&self, list: Vec<Value>, extra: Option<Object>) -> Value {
        let mut o = extra.unwrap_or_default();
        o.insert("do".into(), Value::Array(list));
        o.insert("deadline".into(), self.hub.next_deadline().and_then(number).unwrap_or(Value::Null));
        o.insert("port".into(), self.hub.link().port().map_or(Value::Null, Value::from));
        o.insert("refusedInARow".into(), self.hub.link().refused_in_a_row().into());
        Value::Object(o)
    }

    fn call(&mut self, o: &Object) -> Value {
        let now = f(o, "now").unwrap_or(0.0);
        if let Some(wall) = f(o, "wall") {
            self.hub.set_wall_offset(wall - now);
        }
        let s = |k: &str| json::string(o.get(k));
        let mut list = Vec::new();
        let mut extra = Object::new();
        let outs = match s("type").unwrap_or("") {
            "origins" => {
                let origins: Vec<String> = json::array(o.get("origins"))
                    .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                    .unwrap_or_default();
                self.hub.link_mut().allowed_origins = origins;
                Vec::new()
            }
            "relays" => {
                self.hub.set_relay_version(s("version").unwrap_or(""));
                Vec::new()
            }
            "listening" => {
                let port = o.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0);
                self.hub.listening(port, now)
            }
            "woken" => self.hub.woken(s("json"), now),
            "appUp" => self.hub.say_app_up(f(o, "runningFor"), now),
            "dispatched" => {
                let n = o.get("n").and_then(Value::as_u64).unwrap_or(0);
                self.hub.dispatched(s("name").unwrap_or(""), n, s("why"))
            }
            "accept" => self.hub.tcp_accept(conn(o), now),
            "ended" => self.hub.tcp_ended(conn(o), s("error"), now),
            "relayOpen" => {
                self.hub.relay_open(conn(o));
                Vec::new()
            }
            "relayEnded" => {
                self.hub.relay_ended(conn(o));
                Vec::new()
            }
            "tick" => self.hub.tick(now),
            "send" => {
                let Some(message) = json::object(o.get("message")).and_then(app_message) else {
                    return json!({ "error": "bad request: not a message the app sends" });
                };
                let c = conn(o);
                let (sent, outs) = self.hub.send(c, &message, now);
                extra.insert("sent".into(), sent.is_ok().into());
                if let Err(e) = sent {
                    extra.insert("error".into(), error_name(e).into());
                }
                let refused = self.hub.link().link().connection_on(c).map_or(0, |l| l.refused());
                extra.insert("refused".into(), refused.into());
                outs
            }
            "request" => {
                let payload = json::object(o.get("payload")).cloned().unwrap_or_default();
                let window = json::int(o.get("windowId"));
                let (id, outs) = self.hub.request(conn(o), s("kind").unwrap_or(""), payload, window, now);
                match id {
                    Ok(id) => extra.insert("id".into(), id.into()),
                    Err(e) => extra.insert("error".into(), error_name(e).into()),
                };
                outs
            }
            "close" => {
                let code = o.get("code").and_then(Value::as_u64).and_then(|c| u16::try_from(c).ok()).unwrap_or(1000);
                self.hub.close(conn(o), code, s("why").unwrap_or(""), now)
            }
            "stop" => self.hub.stop(s("why").unwrap_or(""), now),
            "heardPid" => {
                let pid = o.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()).unwrap_or(0);
                extra.insert("heard".into(), (pid > 0 && self.hub.relays().heard_pid(pid)).into());
                Vec::new()
            }
            "state" => Vec::new(),
            "mirror" => {
                let m = self.hub.mirror(conn(o));
                extra.insert(
                    "mirror".into(),
                    m.map_or(Value::Null, |m| {
                        let state = m.state_json().and_then(|t| serde_json::from_str::<Value>(&t).ok());
                        json!({
                            "epoch": m.epoch(), "seq": m.seq(), "keys": m.keys(), "hasState": m.has_state(),
                            "resyncing": m.is_resyncing(), "windows": m.windows(), "state": state,
                        })
                    }),
                );
                Vec::new()
            }
            other => return json!({ "error": format!("bad request: no call {other:?}") }),
        };
        self.carry(outs, &mut list);
        self.reply(list, Some(extra))
    }
}

/// What a state message did, for the answer's list.
fn state_json(conn: u64, key: &str, a: StateApplied) -> Value {
    let mut o = json!({
        "do": "state", "conn": conn, "key": key, "kind": a.kind.name(), "epoch": a.epoch, "seq": a.seq,
        "keys": a.keys, "hasState": a.has_state, "resyncing": a.resyncing,
    });
    let outcome = match a.outcome {
        Outcome::Applied => "applied",
        Outcome::Ignored => "ignored",
        Outcome::Gap { expected, got } => {
            o["expected"] = expected.into();
            o["got"] = got.into();
            "gap"
        }
    };
    o["outcome"] = outcome.into();
    if let Some(windows) = a.windows {
        o["windows"] = Value::Array(windows.into_iter().map(Value::Object).collect());
    }
    o
}

/// A message the Mac's Swift sends, from its JSON (`{ k, … }` as on the wire, `at` stamped here): `drawn`,
/// `resync`, a data message.
fn app_message(m: &Object) -> Option<AppMessage> {
    let k = json::string(m.get("k"))?;
    let epoch = || json::string(m.get("epoch")).map(str::to_owned);
    match k {
        "drawn" => Some(AppMessage::Drawn {
            epoch: epoch()?,
            window_id: json::int(m.get("windowId"))?,
            on: json::flag(m.get("on"))?,
        }),
        "resync" => Some(AppMessage::Resync { epoch: epoch()? }),
        k if k.starts_with("data.") => {
            let mut body = m.clone();
            body.remove("k");
            Some(AppMessage::Data { kind: k.to_owned(), body })
        }
        _ => None,
    }
}

/// The link object (free it with `margin_link_free`). `config`: `{ version, pid?, timing?: { tick, dead, keep,
/// hello, request, safariSettled }, origins? }` (`pid`: the link note written for this process; none, no notes).
/// `write`: each write, during the call that makes it.
///
/// # Safety
/// `config` points to `len` readable bytes; `ctx` lives as long as the object.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_link_new(
    config: *const u8,
    len: usize,
    ctx: *mut c_void,
    write: Option<MarginLinkWrite>,
) -> *mut MarginLink {
    let parsed = text(config, len).and_then(|t| serde_json::from_str::<Value>(t).ok());
    let Some(o) = parsed.as_ref().and_then(Value::as_object) else { return std::ptr::null_mut() };
    let version = json::string(o.get("version")).unwrap_or("");
    let (timing, keep, settled) = timing(json::object(o.get("timing")));
    let mut link = SocketLink::new(timing, version);
    link.set_keep(keep, settled);
    if let Some(pid) = o.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()) {
        link.publish_notes(pid);
    }
    if let Some(origins) = json::array(o.get("origins")) {
        link.allowed_origins = origins.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    }
    Box::into_raw(Box::new(MarginLink { hub: LinkHub::with_link(link, version), ctx, write }))
}

/// # Safety
/// `link` from [`margin_link_new`], not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_link_free(link: *mut MarginLink) {
    if !link.is_null() {
        // SAFETY: made by Box::into_raw in margin_link_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(link) });
    }
}

/// One request (`{ type, now, wall, … }`) → its answer (`{ do, deadline, port, refusedInARow, … }`). Types:
/// `origins` (origins), `relays` (version: the relays' welcome's), `listening` (port or null), `woken` (json: the
/// notification's), `appUp` (runningFor: how long Safari has run, or null), `dispatched` (name, n, why or null),
/// `accept` and `ended` (conn; error), `relayOpen` and `relayEnded` (conn), `tick`, `send` (conn, message: `drawn`,
/// `resync` or a data message; answers `sent`, `error`, `refused`), `request` (conn, kind, payload, windowId; answers
/// `id` or `error`), `close` (conn, code, why), `stop` (why), `heardPid` (pid; answers `heard`), `mirror` (conn;
/// answers `mirror`: that link's state whole, for the tests), `state`.
///
/// # Safety
/// `link` from [`margin_link_new`], not freed; `request` points to `len` readable bytes; one call at a time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_link_call(
    link: *mut MarginLink,
    request: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_link_new and not freed (the caller's contract); one call at a time.
    let Some(l) = (!link.is_null()).then(|| unsafe { &mut *link }) else {
        return answer(&json!({ "error": "no link object" }), out_len);
    };
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    answer(&l.call(o), out_len)
}

/// Bytes on a connection (`which` 0: a copy's TCP connection, 1: a relay's) → the answer, as `margin_link_call`'s.
///
/// # Safety
/// `link` from [`margin_link_new`], not freed; `bytes` points to `len` readable bytes (or is null with 0); one call
/// at a time.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn margin_link_bytes(
    link: *mut MarginLink,
    which: u8,
    conn: u64,
    bytes: *const u8,
    len: usize,
    now: f64,
    wall: f64,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_link_new and not freed (the caller's contract); one call at a time.
    let Some(l) = (!link.is_null()).then(|| unsafe { &mut *link }) else {
        return answer(&json!({ "error": "no link object" }), out_len);
    };
    let data: &[u8] = if bytes.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: `len` readable bytes at `bytes` (the contract).
        unsafe { std::slice::from_raw_parts(bytes, len) }
    };
    let now = if now.is_finite() { now } else { 0.0 };
    if wall.is_finite() {
        l.hub.set_wall_offset(wall - now);
    }
    let outs = match which {
        0 => l.hub.tcp_bytes(conn, data, now),
        1 => l.hub.relay_bytes(conn, data, now),
        _ => return answer(&json!({ "error": "bad request: which connection" }), out_len),
    };
    let mut list = Vec::new();
    l.carry(outs, &mut list);
    answer(&l.reply(list, None), out_len)
}

/// One stored key of a link's state (its copy's storage.local, as the core mirrors it), its JSON's bytes as kept
/// (UTF-8; freed with `margin_buffer_free`). Null: no such link, no state yet for that key.
///
/// # Safety
/// `link` from [`margin_link_new`], not freed; `key` points to `len` readable bytes; one call at a time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_link_state_value(
    link: *mut MarginLink,
    conn: u64,
    key: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_link_new and not freed (the caller's contract); one call at a time.
    let Some(l) = (!link.is_null()).then(|| unsafe { &*link }) else { return std::ptr::null_mut() };
    let Some(key) = text(key, len) else { return std::ptr::null_mut() };
    let Some(value) = l.hub.mirror(conn).and_then(|m| m.value_text(key)).filter(|_| !out_len.is_null()) else {
        return std::ptr::null_mut();
    };
    let boxed = value.into_bytes().into_boxed_slice();
    // SAFETY: out_len is writable (checked non-null; the caller's contract).
    unsafe { *out_len = boxed.len() };
    Box::into_raw(boxed) as *mut u8
}

/// The Mac's window requests and their answers read (no object): `setWindowState` (windowId, state, focused,
/// notAfter, land) → `{ type, payload }`; `windowCall` (result) → `{ answer, windowId?, state?, at?, why?, pastMs?,
/// called }`; `spaceWindow` (result) → `{ windowId, bounds }` or null; `message` (text) → the message as read, or
/// null; `encode` (message, at) → `{ text }` (null: not one the app sends, or over 1 MB); `constants` → the link's
/// numbers.
#[unsafe(no_mangle)]
pub extern "C" fn margin_link_protocol(request: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    let empty = Object::new();
    let result = json::object(o.get("result")).unwrap_or(&empty);
    let out = match json::string(o.get("type")).unwrap_or("") {
        "setWindowState" => {
            let state = match json::string(o.get("state")) {
                Some("fullscreen") => WindowState::Fullscreen,
                Some("normal") => WindowState::Normal,
                _ => return answer(&json!({ "error": "bad request: a state is fullscreen or normal" }), out_len),
            };
            let (Some(window_id), Some(not_after)) = (json::int(o.get("windowId")), f(o, "notAfter")) else {
                return answer(&json!({ "error": "bad request: a window and a notAfter" }), out_len);
            };
            let request = HandoffRequest::SetWindowState {
                window_id,
                state,
                focused: json::flag(o.get("focused")) == Some(true),
                not_after,
                land: json::flag(o.get("land")) != Some(false),
            };
            json!({ "type": request.type_name(), "payload": request.payload() })
        }
        "windowCall" => {
            let a = WindowCallAnswer::from_result(result);
            let called = a.called();
            match a {
                WindowCallAnswer::Asked { window_id, state } => {
                    json!({ "answer": "asked", "windowId": window_id, "state": state, "called": called })
                }
                WindowCallAnswer::Landed { window_id, state, at } => {
                    json!({ "answer": "landed", "windowId": window_id, "state": state, "at": at, "called": called })
                }
                WindowCallAnswer::TimedOut { window_id, state } => {
                    json!({ "answer": "timedOut", "windowId": window_id, "state": state, "called": called })
                }
                WindowCallAnswer::Busy => json!({ "answer": "busy", "called": called }),
                WindowCallAnswer::Refused { why, past_ms } => {
                    json!({ "answer": "refused", "why": why, "pastMs": past_ms, "called": called })
                }
                WindowCallAnswer::Done { state } => json!({ "answer": "done", "state": state, "called": called }),
            }
        }
        "spaceWindow" => match SpaceWindowAnswer::from_result(result) {
            Some(a) => json!({
                "windowId": a.window_id,
                "bounds": a.bounds.map(|b| json!({ "x": b.x, "y": b.y, "width": b.width, "height": b.height })),
            }),
            None => Value::Null,
        },
        "message" => match LinkMessage::decode(json::string(o.get("text")).unwrap_or("")) {
            Some(m) => Value::Object(m.object()),
            None => Value::Null,
        },
        "encode" => {
            let at = f(o, "at").unwrap_or(0.0);
            let text = json::object(o.get("message")).and_then(app_message).and_then(|m| m.encode(at));
            json!({ "text": text })
        }
        "constants" => json!({ "version": VERSION, "maxAppMessage": MAX_APP_MESSAGE }),
        other => json!({ "error": format!("bad request: no call {other:?}") }),
    };
    answer(&out, out_len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static WRITES: Mutex<Vec<(u8, u64, Vec<u8>)>> = Mutex::new(Vec::new());

    extern "C" fn record(_ctx: *mut c_void, which: u8, conn: u64, bytes: *const u8, len: usize) {
        // SAFETY: `len` bytes at `bytes`, the call's contract.
        let b = unsafe { std::slice::from_raw_parts(bytes, len) }.to_vec();
        if let Ok(mut w) = WRITES.lock() {
            w.push((which, conn, b));
        }
    }

    fn read(ptr: *mut u8, len: usize) -> Value {
        assert!(!ptr.is_null());
        // SAFETY: an answer's bytes, freed right after.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap_or(Value::Null);
        unsafe { crate::margin_buffer_free(ptr, len) };
        v
    }

    fn call(l: *mut MarginLink, v: Value) -> Value {
        let t = v.to_string();
        let mut n = 0;
        // SAFETY: a live link, a valid buffer.
        read(unsafe { margin_link_call(l, t.as_ptr(), t.len(), &mut n) }, n)
    }

    fn bytes(l: *mut MarginLink, which: u8, conn: u64, b: &[u8], now: f64) -> Value {
        let mut n = 0;
        // SAFETY: a live link, a valid buffer.
        read(unsafe { margin_link_bytes(l, which, conn, b.as_ptr(), b.len(), now, 1_800_000_000.0 + now, &mut n) }, n)
    }

    fn protocol(v: Value) -> Value {
        let t = v.to_string();
        let mut n = 0;
        read(margin_link_protocol(t.as_ptr(), t.len(), &mut n), n)
    }

    /// A text frame as a copy's WebSocket sends it: masked (short payloads only).
    fn client_frame(payload: &[u8]) -> Vec<u8> {
        let mask = [0x37u8, 0xfa, 0x21, 0x3d];
        let mut out = vec![0x81, 0x80 | 126, (payload.len() >> 8) as u8, (payload.len() & 0xff) as u8];
        out.extend_from_slice(&mask);
        out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));
        out
    }

    fn did<'a>(a: &'a Value, what: &str) -> Vec<&'a Value> {
        a["do"].as_array().map(|l| l.iter().filter(|d| d["do"] == what).collect()).unwrap_or_default()
    }

    #[test]
    fn a_link_object_over_its_calls() {
        let config = json!({"version":"1.2","pid":99,"timing":{"tick":5,"dead":40,"keep":30,"hello":5,"request":15,"safariSettled":2},"origins":["safari-web-extension://"]}).to_string();
        // SAFETY: a valid buffer; ctx unused by `record`.
        let l = unsafe { margin_link_new(config.as_ptr(), config.len(), std::ptr::null_mut(), Some(record)) };
        assert!(!l.is_null());
        let a = call(l, json!({"type":"listening","port":5555,"now":1,"wall":1_800_000_001}));
        assert_eq!(a["port"], 5555);
        let note = did(&a, "note");
        assert_eq!(note[0]["info"]["pid"], 99);
        assert_eq!(note[0]["info"]["at"], 1_800_000_001_000_i64);
        let a = call(
            l,
            json!({"type":"woken","json":"{\"type\":\"wantLink\",\"nonce\":\"n\"}","now":1,"wall":1_800_000_001}),
        );
        let safari = did(&a, "safari");
        assert_eq!(safari[0]["name"], "link");
        let token = safari[0]["info"]["token"].as_str().unwrap_or("").to_owned();
        assert_eq!(token.len(), 64);
        assert_eq!(
            did(&call(l, json!({"type":"dispatched","name":"link","n":1,"why":"SFErrorDomain 1","now":1})), "refused")
                .len(),
            1
        );
        assert_eq!(call(l, json!({"type":"state"}))["refusedInARow"], 1);
        // A copy: accepted, upgraded, linked.
        call(l, json!({"type":"accept","conn":3,"now":1}));
        let request = format!(
            "GET /?t={token} HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: safari-web-extension://A\r\n\r\n"
        );
        WRITES.lock().map(|mut w| w.clear()).ok();
        let a = bytes(l, 0, 3, request.as_bytes(), 1.0);
        assert!(did(&a, "log").iter().any(|d| d["text"] == "socket open"));
        let written = WRITES.lock().map(|w| w.clone()).unwrap_or_default();
        assert!(
            written.first().is_some_and(|w| w.0 == 0 && w.1 == 3 && w.2.starts_with(b"HTTP/1.1 101")),
            "the 101, through the callback"
        );
        assert_eq!(written.len(), 2, "then the welcome's frame");
        let hello = json!({"k":"hello","v":2,"epoch":"e","profile":"P","browser":"safari","owner":true}).to_string();
        let a = bytes(l, 0, 3, &client_frame(hello.as_bytes()), 1.0);
        let up = did(&a, "up");
        assert_eq!(up[0]["hello"]["profile"], "P");
        assert_eq!(a["deadline"], 6.0, "the ticker in 5 s");
        let snap = json!({"k":"snapshot","epoch":"e","seq":1,"state":{"a":1}}).to_string();
        let a = bytes(l, 0, 3, &client_frame(snap.as_bytes()), 1.5);
        assert!(did(&a, "received").is_empty(), "the state isn't handed on as it came");
        assert_eq!(
            did(&a, "state")[0],
            &json!({"do":"state","conn":3,"key":"safari:P","kind":"snapshot","epoch":"e","seq":1,"keys":["a"],
                    "hasState":true,"resyncing":false,"outcome":"applied","windows":[]})
        );
        let value = |key: &str| {
            let mut n = 0;
            // SAFETY: a live link, a valid buffer.
            let p = unsafe { margin_link_state_value(l, 3, key.as_ptr(), key.len(), &mut n) };
            if p.is_null() {
                return None;
            }
            // SAFETY: an answer's bytes, freed right after.
            let t = String::from_utf8(unsafe { std::slice::from_raw_parts(p, n) }.to_vec()).ok();
            unsafe { crate::margin_buffer_free(p, n) };
            t
        };
        assert_eq!(value("a").as_deref(), Some("1"));
        assert_eq!(value("b"), None);
        let delta = json!({"k":"delta","epoch":"e","seq":3,"changes":{"a":{"newValue":{"x":[1]}}}}).to_string();
        let a = bytes(l, 0, 3, &client_frame(delta.as_bytes()), 1.6);
        let gap = did(&a, "state")[0];
        assert!(gap["outcome"] == "gap" && gap["expected"] == 2 && gap["got"] == 3 && gap["resyncing"] == true);
        assert!(
            did(&a, "log")
                .iter()
                .any(|d| d["text"] == "safari:P: number 3 came, 2 was next: the state asked for again")
        );
        assert_eq!(value("a").as_deref(), Some("1"), "nothing taken past a gap");
        let snap = json!({"k":"snapshot","epoch":"e","seq":4,"state":{"a":{"x":[1]}},"windows":[{"windowId":2}]});
        bytes(l, 0, 3, &client_frame(snap.to_string().as_bytes()), 1.7);
        let m = call(l, json!({"type":"mirror","conn":3}))["mirror"].clone();
        assert_eq!(
            m,
            json!({"epoch":"e","seq":4,"keys":["a"],"hasState":true,"resyncing":false,"windows":[{"windowId":2}],
                   "state":{"a":{"x":[1]}}})
        );
        assert_eq!(call(l, json!({"type":"mirror","conn":9}))["mirror"], Value::Null);
        // SAFETY: null link or key: none.
        unsafe {
            let mut n = 0;
            assert!(margin_link_state_value(std::ptr::null_mut(), 3, b"a".as_ptr(), 1, &mut n).is_null());
            assert!(margin_link_state_value(l, 3, std::ptr::null(), 0, &mut n).is_null());
        }
        // Sends and requests.
        let a =
            call(l, json!({"type":"send","conn":3,"message":{"k":"drawn","epoch":"e","windowId":4,"on":true},"now":2}));
        assert_eq!(a["sent"], true);
        let a = call(
            l,
            json!({"type":"send","conn":3,"message":{"k":"data.changes","x":"x".repeat(MAX_APP_MESSAGE)},"now":2}),
        );
        assert_eq!(
            (a["sent"].clone(), a["error"].clone(), a["refused"].clone()),
            (json!(false), json!("notJSON"), json!(1))
        );
        assert_eq!(
            call(l, json!({"type":"send","conn":3,"message":{"k":"welcome"}}))["error"],
            "bad request: not a message the app sends"
        );
        let a = call(
            l,
            json!({"type":"request","conn":3,"kind":"userThemes","payload":{"list":[]},"windowId":null,"now":2}),
        );
        assert_eq!(a["id"], 1);
        assert_eq!(call(l, json!({"type":"request","conn":9,"kind":"x","now":2}))["error"], "down");
        let a = call(l, json!({"type":"tick","now":17.5}));
        assert_eq!(did(&a, "answer")[0]["error"], "timedOut");
        let a = call(l, json!({"type":"stop","why":"Margin.app quit","now":18}));
        assert!(did(&a, "end").iter().any(|d| d["which"] == "tcp" && d["conn"] == 3));
        assert_eq!(did(&a, "down")[0]["why"], "stopped: Margin.app quit");
        assert_eq!(did(&a, "note")[0]["info"], Value::Null);
        assert!(call(l, json!({"type":"nope"}))["error"].is_string());
        assert!(call(l, json!([1]))["error"].is_string());
        // SAFETY: live, then freed once; null is fine.
        unsafe {
            let mut n = 0;
            assert!(read(margin_link_call(l, b"{x".as_ptr(), 2, &mut n), n)["error"].is_string());
            assert!(read(margin_link_call(std::ptr::null_mut(), b"{}".as_ptr(), 2, &mut n), n)["error"].is_string());
            assert!(read(margin_link_bytes(l, 7, 1, std::ptr::null(), 0, 0.0, 0.0, &mut n), n)["error"].is_string());
            margin_link_free(l);
            margin_link_free(std::ptr::null_mut());
        }
        // SAFETY: a bad config: no object.
        assert!(unsafe { margin_link_new(b"[]".as_ptr(), 2, std::ptr::null_mut(), None) }.is_null());
    }

    #[test]
    fn the_window_requests_and_answers() {
        assert_eq!(
            protocol(
                json!({"type":"setWindowState","windowId":90,"state":"fullscreen","focused":true,"notAfter":1_800_000_002_000.4,"land":false})
            ),
            json!({"type":"setWindowState","payload":{"windowId":90,"state":"fullscreen","notAfter":1_800_000_002_000_i64,"land":false,"focused":true}})
        );
        assert!(
            protocol(json!({"type":"setWindowState","windowId":90,"state":"odd","notAfter":1}))["error"].is_string()
        );
        assert_eq!(
            protocol(json!({"type":"windowCall","result":{"windowId":4,"state":"fullscreen","asked":true}})),
            json!({"answer":"asked","windowId":4,"state":"fullscreen","called":true})
        );
        assert_eq!(protocol(json!({"type":"windowCall","result":{"busy":1}}))["called"], false);
        assert_eq!(protocol(json!({"type":"windowCall","result":{"refused":"late","pastMs":3}}))["pastMs"], 3.0);
        assert_eq!(protocol(json!({"type":"windowCall"}))["answer"], "done");
        assert_eq!(
            protocol(
                json!({"type":"spaceWindow","result":{"windowId":5,"bounds":{"left":1,"top":2,"width":3,"height":4}}})
            ),
            json!({"windowId":5,"bounds":{"x":1.0,"y":2.0,"width":3.0,"height":4.0}})
        );
        assert_eq!(
            protocol(
                json!({"type":"spaceWindow","result":{"windowId":5,"bounds":{"left":1,"top":2,"width":0,"height":4}}})
            )["bounds"],
            Value::Null
        );
        assert_eq!(protocol(json!({"type":"spaceWindow","result":{"state":"normal"}})), Value::Null);
        assert_eq!(protocol(json!({"type":"constants"})), json!({"version":2,"maxAppMessage":1_000_000}));
        assert_eq!(protocol(json!({"type":"message","text":"{\"k\":\"tock\"}"})), json!({"k":"tock"}));
        assert_eq!(protocol(json!({"type":"message","text":"{"})), Value::Null);
        let drawn =
            protocol(json!({"type":"encode","message":{"k":"drawn","epoch":"e","windowId":7,"on":false},"at":5.0}));
        let text: Value = serde_json::from_str(drawn["text"].as_str().unwrap_or("")).unwrap_or(Value::Null);
        assert_eq!(text, json!({"k":"drawn","epoch":"e","windowId":7,"on":false,"at":5}));
        let ack = protocol(json!({"type":"encode","message":{"k":"data.ack","upTo":5,"profile":"P1"},"at":5.0}));
        let text: Value = serde_json::from_str(ack["text"].as_str().unwrap_or("")).unwrap_or(Value::Null);
        assert_eq!(text, json!({"k":"data.ack","upTo":5,"profile":"P1"}));
        let big = json!({"type":"encode","message":{"k":"data.changes","x":"x".repeat(MAX_APP_MESSAGE)},"at":5.0});
        assert_eq!(protocol(big)["text"], Value::Null, "over 1 MB: none");
        assert_eq!(protocol(json!({"type":"encode","message":{"k":"tick"}}))["text"], Value::Null, "the session's own");
    }
}
