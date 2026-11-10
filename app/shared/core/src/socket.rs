//! The link's WebSocket server, sans IO (app/macos/shell/ExtensionLink.swift: `SocketLink` and its `Socket`, with
//! LinkSocket.swift's protocol in [`crate::websocket`]): the copies' TCP connections to 127.0.0.1, each one's HTTP
//! upgrade (turned away with 403 before any WebSocket for a path other than `/`, a wrong token or an `Origin`
//! that isn't an extension's), its frames, and the link session over them ([`crate::link::Link`]); the secrets (a
//! token, the copy's proof that it's Margin, and a key, the app's proof that it's the app: 32 random bytes each, in
//! hex) and their rotation 30 s after the last link closes; and `wantLink` answered with the `link` the copy opens
//! the socket with (held until the listener has its port). The same on every OS: Margin.app's Swift and
//! margin.exe's Rust.
//!
//! Bytes in, bytes out. What the transport (the OS layer) does, and must:
//! - Listen on 127.0.0.1 only (never another address), any port (0), Nagle off on every connection (the small
//!   messages, `req`, `setLayout`, `tick`, go at once). Say its port with [`SocketLink::listening`], and `None`
//!   while it has none.
//! - A listener that fails is made again after 1 s; one that can't accept for 5 s (the Mac's `waiting`) is made
//!   again on a new port. Each time, say the new port: the copies holding the old one ask again.
//! - Each TCP connection it accepts: [`SocketLink::on_accept`], then its bytes as they come
//!   ([`SocketLink::on_bytes`]), then [`SocketLink::on_ended`] exactly once when it has ended (with the error, if it
//!   failed), also after an [`Out::End`].
//! - Carry out each [`Out::Write`] in order, and [`Out::End`] once what was written before it has gone (a refusal,
//!   a close frame): then close the connection.
//! - [`SocketLink::tick`] at [`SocketLink::next_deadline`]. On quitting, [`SocketLink::stop`], then about 0.3 s for
//!   the `bye`s and close frames to be written.
//!
//! Kept from the Swift, exactly: the checks' order and words (`not the link's path`, `not a WebSocket`,
//! `wrong token`, `not from Margin's extension`; a request that isn't one: 400 `not a request`), the Origins
//! allowed (`safari-web-extension://` and `chrome-extension://`, any extension id: the token is what proves the
//! copy is Margin's), a socket's 5 s to say hello counted from its acceptance, a protocol error closed 1002 with the
//! failure's name, a copy's close frame answered with 1000 `closed by the extension (…)`, a TCP end without one
//! `closed by the extension (1006, no close frame)`, a ping answered with a pong, `token changed` 30 s after the last
//! link went (a hello meanwhile keeps them), up to 8 `wantLink`s held before the listener has its port, each
//! dispatch numbered (`#n`) and its delivery logged (`n in a row` refused).
//!
//! Left out (Safari's, on the Mac only): `SafariDispatch`, the distributed notification, `appUp` once Safari has
//! run 2 s, `onDispatchRefused` (BundleWatch). Chrome's and Edge's relays ([`crate::relay::RelayHub`]) carry the
//! [`Out::Dispatch`]es here, and say through [`SocketLink::dispatched`] whether they got to one.

use std::collections::BTreeMap;

use crate::json::Object;
use crate::link::{Action, ConnId, Level, Link, LinkError, Timing};
use crate::protocol::{AppMessage, VERSION};
use crate::time::Secs;
use crate::websocket::{self, FrameReader, Message, Op, Parsed, Request};

/// `Timing.keep`: the token and key kept this long after the last link closes (a copy starting again tries the
/// link it kept first), then changed.
pub const KEEP: Secs = 30.0;
/// The `wantLink`s held while the listener has no port (the latest).
const ASKED: usize = 8;

/// The Origins a copy may open the socket from: a Safari extension's; Chrome's and Edge's (through their relay).
pub const ALLOWED_ORIGINS: [&str; 2] = ["safari-web-extension://", "chrome-extension://"];

/// Whose relays a `link` goes to: one browser process's (`pid` 0: every relay).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Via {
    pub pid: u32,
    pub browser: String,
}

impl Via {
    /// `RelayDispatch.name`.
    pub fn name(&self) -> &'static str {
        if self.browser == "edge" { "Edge" } else { "Chrome" }
    }
}

/// What the caller does, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// These bytes on that TCP connection.
    Write {
        conn: ConnId,
        bytes: Vec<u8>,
    },
    /// Close that connection once what was written before has gone; say [`SocketLink::on_ended`] after.
    End {
        conn: ConnId,
    },
    /// `dispatchMessage(name, userInfo: { e: info })` into the relays of `to`'s browser process; then say whether
    /// it got to any ([`SocketLink::dispatched`] with `n`).
    Dispatch {
        to: Via,
        name: String,
        info: Object,
        n: u64,
    },
    /// The link session's news: [`Action::Up`], [`Action::Received`], [`Action::Down`], [`Action::Answer`]
    /// (never a send or a close: those are the writes above).
    Link(Action),
    Log {
        level: Level,
        text: String,
    },
}

/// One TCP connection: the upgrade, then its frames.
#[derive(Clone, Debug)]
struct Socket {
    accepted: Secs,
    head: Vec<u8>,
    reader: FrameReader,
    /// Upgraded to a WebSocket.
    open: bool,
    /// Closed here (an [`Out::End`] given): what comes on it is left.
    ended: bool,
    /// Turned away before the upgrade (logged as refused, not again as ended).
    refused: bool,
}

/// `SocketLink`, without the listener or the sockets' I/O.
#[derive(Clone, Debug)]
pub struct SocketLink {
    link: Link,
    keep: Secs,
    /// The Origins allowed ([`ALLOWED_ORIGINS`]).
    pub allowed_origins: Vec<String>,
    token: String,
    key: String,
    port: Option<u16>,
    /// The app's version, as the `link` says it (`app.version`).
    version: String,
    sockets: BTreeMap<ConnId, Socket>,
    rotation: Option<Secs>,
    asked: Vec<(String, Via)>,
    dispatches: u64,
    refused_in_a_row: u32,
    stopped: bool,
}

/// `SocketLink.secret`: 32 random bytes, hex. The OS's generator; should it ever fail, std's per-process random
/// hash keys mixed with the clock (never a constant).
pub fn secret() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        use std::hash::{BuildHasher, Hasher};
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        for (i, chunk) in bytes.chunks_mut(8).enumerate() {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(t);
            h.write_usize(i);
            chunk.copy_from_slice(&h.finish().to_le_bytes());
        }
    }
    hex::encode(bytes)
}

impl SocketLink {
    /// `version`: the app's, for the `link` it hands out.
    pub fn new(timing: Timing, version: impl Into<String>) -> Self {
        Self::with_secrets(timing, version, secret(), secret())
    }

    /// With these secrets (the tests').
    pub fn with_secrets(timing: Timing, version: impl Into<String>, token: String, key: String) -> Self {
        Self {
            link: Link::new(timing, key.clone()),
            keep: KEEP,
            allowed_origins: ALLOWED_ORIGINS.iter().map(|o| (*o).to_owned()).collect(),
            token,
            key,
            port: None,
            version: version.into(),
            sockets: BTreeMap::new(),
            rotation: None,
            asked: Vec::new(),
            dispatches: 0,
            refused_in_a_row: 0,
            stopped: false,
        }
    }

    /// The link session: its connections, who's up.
    pub fn link(&self) -> &Link {
        &self.link
    }
    pub fn port(&self) -> Option<u16> {
        self.port
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn key(&self) -> &str {
        &self.key
    }
    /// Dispatches in a row that didn't reach a copy.
    pub fn refused_in_a_row(&self) -> u32 {
        self.refused_in_a_row
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    // ---- the listener ----

    /// The listener's port now (`.ready`), or none (failed, being made again). With a port, the `wantLink`s asked
    /// for meanwhile are answered.
    pub fn listening(&mut self, port: Option<u16>, now: Secs) -> Vec<Out> {
        let mut out = Vec::new();
        self.port = port.filter(|_| !self.stopped);
        let Some(port) = self.port else { return out };
        note(&mut out, format!("listening on 127.0.0.1:{port}"));
        for (nonce, via) in std::mem::take(&mut self.asked) {
            self.answer(&nonce, via, now, &mut out);
        }
        out
    }

    // ---- getting linked ----

    /// `wantLink(nonce:via:)`: a copy asked for the link through its relay; answered into that browser process's
    /// relays (or held until the listener has its port). A nonce is 1–128 characters.
    pub fn want_link(&mut self, nonce: &str, via: Via, now: Secs) -> Vec<Out> {
        let mut out = Vec::new();
        if self.stopped || !(1..=128).contains(&nonce.chars().count()) {
            return out;
        }
        if self.port.is_none() {
            self.asked.push((nonce.to_owned(), via));
            let extra = self.asked.len().saturating_sub(ASKED);
            self.asked.drain(..extra);
        } else {
            self.answer(nonce, via, now, &mut out);
        }
        out
    }

    fn answer(&mut self, nonce: &str, via: Via, now: Secs, out: &mut Vec<Out>) {
        let Some(port) = self.port else { return };
        self.dispatches += 1;
        let n = self.dispatches;
        note(out, format!("wantLink: link handed to {} (port {port}, #{n})", via.name()));
        let mut app = Object::new();
        app.insert("version".into(), self.version.clone().into());
        let mut info = Object::new();
        info.insert("v".into(), VERSION.into());
        info.insert("nonce".into(), nonce.into());
        info.insert("port".into(), port.into());
        info.insert("token".into(), self.token.clone().into());
        info.insert("key".into(), self.key.clone().into());
        info.insert("app".into(), app.into());
        info.insert("at".into(), at(now).into());
        out.push(Out::Dispatch { to: via, name: "link".into(), info, n });
    }

    /// What became of dispatch `n`: `None` once it reached a copy, else why not. Only now is it said.
    pub fn dispatched(&mut self, name: &str, n: u64, why: Option<&str>) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(why) = why else {
            self.refused_in_a_row = 0;
            note(&mut out, format!("{name} #{n} reached the extension"));
            return out;
        };
        self.refused_in_a_row += 1;
        let row =
            if self.refused_in_a_row > 1 { format!(" ({} in a row)", self.refused_in_a_row) } else { String::new() };
        warn(&mut out, format!("{name} #{n} not passed on: {why}{row}"));
        out
    }

    // ---- sockets ----

    /// `accept`: a TCP connection accepted. It has 5 s to say hello.
    pub fn on_accept(&mut self, conn: ConnId, now: Secs) -> Vec<Out> {
        let mut out = Vec::new();
        if self.stopped {
            out.push(Out::End { conn });
            return out;
        }
        if self.sockets.contains_key(&conn) {
            warn(&mut out, format!("connection {conn} accepted again: left"));
            return out;
        }
        let socket = Socket {
            accepted: now,
            head: Vec::new(),
            reader: FrameReader::new(),
            open: false,
            ended: false,
            refused: false,
        };
        self.sockets.insert(conn, socket);
        out
    }

    /// `allows`: whether a socket's request is a copy's: the link's path, a WebSocket, the token, an extension.
    fn allows(&self, r: &Request) -> Option<&'static str> {
        if !(r.path == "/" || r.path.is_empty()) {
            return Some("not the link's path");
        }
        if !websocket::is_upgrade(r) {
            return Some("not a WebSocket");
        }
        if !websocket::same_secret(r.query.get("t").map(String::as_str).unwrap_or(""), &self.token) {
            return Some("wrong token");
        }
        match r.header("origin") {
            Some(origin) if self.allowed_origins.iter().any(|o| origin.starts_with(o.as_str())) => None,
            _ => Some("not from Margin's extension"),
        }
    }

    /// `got`: bytes on a connection: its request until it's upgraded, then its frames.
    pub fn on_bytes(&mut self, conn: ConnId, data: &[u8], now: Secs) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(socket) = self.sockets.get_mut(&conn) else { return out };
        if socket.ended {
            return out;
        }
        self.link.heard(conn, now);
        if !socket.open {
            socket.head.extend_from_slice(data);
            match websocket::parse(&socket.head) {
                Parsed::Incomplete => return out,
                Parsed::Bad => {
                    self.refuse(conn, "400 Bad Request", "not a request", &mut out);
                    return out;
                }
                Parsed::Request(request, rest) => {
                    socket.head = Vec::new();
                    if let Some(why) = self.allows(&request) {
                        self.refuse(conn, "403 Forbidden", why, &mut out);
                        return out;
                    }
                    let Some(socket) = self.sockets.get_mut(&conn) else { return out };
                    socket.open = true;
                    let accepted = socket.accepted;
                    let key = request.header("sec-websocket-key").unwrap_or("");
                    out.push(Out::Write { conn, bytes: websocket::switching(key) });
                    let actions = self.link.on_open_at(conn, accepted, now);
                    self.carry(actions, now, &mut out);
                    if let Some(socket) = self.sockets.get_mut(&conn) {
                        socket.reader.append(&rest);
                    }
                }
            }
        } else {
            socket.reader.append(data);
        }
        self.messages(conn, now, &mut out);
        out
    }

    /// The whole messages come so far on an open socket.
    fn messages(&mut self, conn: ConnId, now: Secs, out: &mut Vec<Out>) {
        loop {
            let next = match self.sockets.get_mut(&conn) {
                Some(s) if s.open && !s.ended => s.reader.next_message(),
                _ => return,
            };
            match next {
                Ok(None) => return,
                Ok(Some(Message::Text(text))) => {
                    let actions = self.link.on_text(conn, &text, now);
                    self.carry(actions, now, out);
                }
                Ok(Some(Message::Ping(payload))) => {
                    out.push(Out::Write { conn, bytes: websocket::encode(Op::Pong, &payload) })
                }
                Ok(Some(Message::Close { code, reason })) => {
                    let why = format!("closed by the extension ({})", websocket::describe_close(code, &reason));
                    self.close_socket(conn, 1000, &why, now, out);
                }
                Ok(Some(Message::Nothing)) => {}
                Err(failure) => self.close_socket(conn, 1002, &failure.to_string(), now, out),
            }
        }
    }

    /// `refuse`: turned away before the upgrade, with this status.
    fn refuse(&mut self, conn: ConnId, status: &str, why: &str, out: &mut Vec<Out>) {
        let Some(socket) = self.sockets.get_mut(&conn) else { return };
        socket.refused = true;
        socket.ended = true;
        warn(out, format!("socket refused: {why}"));
        out.push(Out::Write { conn, bytes: websocket::refusal(status) });
        out.push(Out::End { conn });
    }

    /// `Socket.close`: a close frame if it's open, then closed; gone for the link at once.
    fn close_socket(&mut self, conn: ConnId, code: u16, why: &str, now: Secs, out: &mut Vec<Out>) {
        let Some(socket) = self.sockets.get(&conn) else { return };
        if socket.ended {
            return;
        }
        if socket.open {
            let actions = self.link.close(conn, code, why, now);
            self.carry(actions, now, out);
        }
        let Some(socket) = self.sockets.get_mut(&conn) else { return };
        if socket.ended {
            return;
        }
        socket.ended = true;
        if socket.open {
            out.push(Out::Write { conn, bytes: websocket::close_frame(code, why) });
        } else if !socket.refused {
            let ms = ((now - socket.accepted) * 1000.0).max(0.0);
            note(out, format!("socket ended before its hello (before the upgrade, {ms:.1} ms): {why}"));
        }
        out.push(Out::End { conn });
    }

    /// The link session's actions: its texts as frames, its closes as close frames, the rest passed on.
    fn carry(&mut self, actions: Vec<Action>, now: Secs, out: &mut Vec<Out>) {
        let mut down = false;
        for a in actions {
            match a {
                Action::Send { conn, text } => {
                    if self.sockets.get(&conn).is_some_and(|s| s.open && !s.ended) {
                        out.push(Out::Write { conn, bytes: websocket::encode(Op::Text, text.as_bytes()) });
                    }
                }
                Action::Close { conn, code, reason } => {
                    if let Some(s) = self.sockets.get_mut(&conn).filter(|s| !s.ended) {
                        s.ended = true;
                        if s.open {
                            out.push(Out::Write { conn, bytes: websocket::close_frame(code, &reason) });
                        }
                        out.push(Out::End { conn });
                    }
                }
                Action::Log { level, text } => out.push(Out::Log { level, text }),
                Action::Up { .. } => {
                    self.rotation = None;
                    out.push(Out::Link(a));
                }
                Action::Down { .. } => {
                    down = true;
                    out.push(Out::Link(a));
                }
                a => out.push(Out::Link(a)),
            }
        }
        if down && !self.stopped && self.link.connections().next().is_none() {
            // A copy starting again tries the link it kept, for a while.
            self.rotation = Some(now + self.keep);
        }
    }

    /// The transport says the connection has ended: the copy's end of TCP (no close frame), a failure (`error`),
    /// or after an [`Out::End`].
    pub fn on_ended(&mut self, conn: ConnId, error: Option<&str>, now: Secs) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(socket) = self.sockets.remove(&conn) else { return out };
        if socket.ended {
            let actions = self.link.on_closed(conn, "ended", now);
            self.carry(actions, now, &mut out);
            return out;
        }
        // No close frame came: a plain TCP end (a background torn down, a crash) or an error.
        let how = match error {
            Some(e) => format!("connection failed: {e}"),
            None if socket.open => "no close frame".into(),
            None => "TCP closed".into(),
        };
        if socket.open {
            let actions = self.link.on_closed(conn, &format!("closed by the extension (1006, {how})"), now);
            self.carry(actions, now, &mut out);
        } else if !socket.refused {
            let ms = ((now - socket.accepted) * 1000.0).max(0.0);
            note(&mut out, format!("socket ended before its hello (before the upgrade, {ms:.1} ms): {how}"));
        }
        out
    }

    // ---- the time ----

    /// Sockets that said no hello within 5 s of being accepted closed, the link's own time (ticks, silent links,
    /// requests), and the secrets changed once 30 s have gone with no link.
    pub fn tick(&mut self, now: Secs) -> Vec<Out> {
        let mut out = Vec::new();
        if self.stopped {
            return out;
        }
        let hello = self.link.timing().hello;
        let late: Vec<ConnId> = self
            .sockets
            .iter()
            .filter(|(_, s)| !s.open && !s.ended && now >= s.accepted + hello)
            .map(|(&c, _)| c)
            .collect();
        for conn in late {
            self.close_socket(conn, 1008, &format!("no hello within {} s", hello as i64), now, &mut out);
        }
        let actions = self.link.tick(now);
        self.carry(actions, now, &mut out);
        if self.rotation.is_some_and(|due| now >= due) {
            self.rotation = None;
            if self.link.connections().next().is_none() {
                self.token = secret();
                self.key = secret();
                self.link.set_welcome_key(self.key.clone());
                note(&mut out, "token changed".into());
            }
        }
        out
    }

    /// When [`SocketLink::tick`] next has something to do, if ever.
    pub fn next_deadline(&self) -> Option<Secs> {
        let hello = self.link.timing().hello;
        let sockets = self.sockets.values().filter(|s| !s.open && !s.ended).map(|s| s.accepted + hello);
        self.link.next_deadline().into_iter().chain(sockets).chain(self.rotation).reduce(f64::min)
    }

    // ---- the link's messages ----

    /// `LinkConnection.send`: a message to the link on `conn`, as the frame to write. `Err(Down)` if it isn't up,
    /// `Err(NotJson)` if it isn't JSON or is over 1 MB.
    pub fn send(&mut self, conn: ConnId, message: &AppMessage, now: Secs) -> Result<Vec<u8>, LinkError> {
        match self.link.send(conn, message, now)? {
            Action::Send { text, .. } => self.frame(conn, &text),
            _ => Err(LinkError::Down),
        }
    }

    /// `LinkConnection.request`: a `req` to the link on `conn`: its id and the frame to write. Its answer comes as
    /// an [`Action::Answer`] with that id.
    pub fn request(
        &mut self,
        conn: ConnId,
        kind: &str,
        payload: Object,
        window_id: Option<i64>,
        now: Secs,
    ) -> Result<(i64, Vec<u8>), LinkError> {
        let (id, action) = self.link.request(conn, kind, payload, window_id, now)?;
        match action {
            Action::Send { text, .. } => Ok((id, self.frame(conn, &text)?)),
            _ => Err(LinkError::Down),
        }
    }

    fn frame(&self, conn: ConnId, text: &str) -> Result<Vec<u8>, LinkError> {
        if self.sockets.get(&conn).is_some_and(|s| s.open && !s.ended) {
            Ok(websocket::encode(Op::Text, text.as_bytes()))
        } else {
            Err(LinkError::Down)
        }
    }

    /// `LinkConnection.close`: the app closes a link.
    pub fn close(&mut self, conn: ConnId, code: u16, why: &str, now: Secs) -> Vec<Out> {
        let mut out = Vec::new();
        self.close_socket(conn, code, why, now, &mut out);
        out
    }

    /// `stop(why:then:)`: the app is going. Sockets not linked are closed (1001); each link is told `bye` and closed
    /// (1001), and goes down ("stopped: WHY"). Nothing is taken after it; the port is gone.
    pub fn stop(&mut self, why: &str, now: Secs) -> Vec<Out> {
        let mut out = Vec::new();
        if self.stopped {
            return out;
        }
        self.stopped = true;
        self.port = None;
        self.rotation = None;
        self.asked.clear();
        let unlinked: Vec<ConnId> = self.sockets.iter().filter(|(_, s)| !s.open && !s.ended).map(|(&c, _)| c).collect();
        for conn in unlinked {
            self.close_socket(conn, 1001, why, now, &mut out);
        }
        let actions = self.link.stop(why, now);
        self.carry(actions, now, &mut out);
        out
    }
}

/// `SocketLink.at()`: now in whole milliseconds.
fn at(now: Secs) -> i64 {
    (now * 1000.0).round() as i64
}

fn note(out: &mut Vec<Out>, text: String) {
    out.push(Out::Log { level: Level::Note, text });
}

fn warn(out: &mut Vec<Out>, text: String) {
    out.push(Out::Log { level: Level::Warn, text });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::websocket::{client_frame, server_frames};
    use serde_json::{Value, json};

    const TOKEN: &str = "t0k3n";
    const KEY: &str = "k3y";

    fn server() -> SocketLink {
        let mut s = SocketLink::with_secrets(Timing::default(), "1.2", TOKEN.into(), KEY.into());
        s.listening(Some(5555), 0.0);
        s
    }

    fn request(token: &str, origin: Option<&str>, path: &str) -> Vec<u8> {
        let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
        format!(
            "GET {path}?t={token} HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{origin}\r\n"
        )
        .into_bytes()
    }

    fn copy_request() -> Vec<u8> {
        request(TOKEN, Some("chrome-extension://njeebbcmlenfopaecfbphgcfihbdmkec"), "/")
    }

    fn hello(profile: &str) -> Vec<u8> {
        let h = json!({"k":"hello","v":2,"epoch":"e1","profile":profile,"browser":"edge","owner":true,"pid":42});
        client_frame(1, h.to_string().as_bytes(), true)
    }

    fn writes(out: &[Out], conn: ConnId) -> Vec<u8> {
        out.iter()
            .filter_map(|o| match o {
                Out::Write { conn: c, bytes } if *c == conn => Some(bytes.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    /// The app's close frames on `conn`: each one's code and reason.
    fn closes(out: &[Out], conn: ConnId) -> Vec<(u16, String)> {
        raw_frames(out, conn)
            .into_iter()
            .filter(|f| f.0 == 8 && f.1.len() >= 2)
            .map(|(_, p)| (u16::from_be_bytes([p[0], p[1]]), String::from_utf8_lossy(&p[2..]).into_owned()))
            .collect()
    }

    /// The app's frames on `conn` after its 101: each one's op and text.
    fn frames(out: &[Out], conn: ConnId) -> Vec<(u8, String)> {
        raw_frames(out, conn).into_iter().map(|(op, p)| (op, String::from_utf8_lossy(&p).into_owned())).collect()
    }

    fn raw_frames(out: &[Out], conn: ConnId) -> Vec<(u8, Vec<u8>)> {
        let bytes = writes(out, conn);
        let after = match bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            Some(i) if bytes.starts_with(b"HTTP/1.1 101") => &bytes[i + 4..],
            _ => &bytes[..],
        };
        server_frames(after).unwrap_or_default()
    }

    fn texts(out: &[Out], conn: ConnId) -> Vec<Value> {
        frames(out, conn).into_iter().filter(|f| f.0 == 1).filter_map(|f| serde_json::from_str(&f.1).ok()).collect()
    }

    fn ended(out: &[Out], conn: ConnId) -> bool {
        out.iter().any(|o| matches!(o, Out::End { conn: c } if *c == conn))
    }

    fn logged(out: &[Out], text: &str) -> bool {
        out.iter().any(|o| matches!(o, Out::Log { text: t, .. } if t.contains(text)))
    }

    fn ups(out: &[Out]) -> usize {
        out.iter().filter(|o| matches!(o, Out::Link(Action::Up { .. }))).count()
    }

    fn downs(out: &[Out]) -> Vec<String> {
        out.iter()
            .filter_map(|o| match o {
                Out::Link(Action::Down { why, .. }) => Some(why.clone()),
                _ => None,
            })
            .collect()
    }

    /// A copy linked on connection 1 at time 0.
    fn linked() -> SocketLink {
        let mut s = server();
        s.on_accept(1, 0.0);
        s.on_bytes(1, &copy_request(), 0.0);
        s.on_bytes(1, &hello("P1"), 0.0);
        assert!(s.link().is_up(1));
        s
    }

    #[test]
    fn the_copy_is_welcomed_with_the_key_then_says_hello() {
        let mut s = server();
        assert!(s.on_accept(1, 0.0).is_empty());
        let out = s.on_bytes(1, &copy_request()[..30], 0.0);
        assert!(out.is_empty(), "the request in pieces: waits");
        let out = s.on_bytes(1, &copy_request()[30..], 0.1);
        let bytes = writes(&out, 1);
        assert!(bytes.starts_with(b"HTTP/1.1 101 Switching Protocols\r\n"), "{}", String::from_utf8_lossy(&bytes));
        assert!(String::from_utf8_lossy(&bytes).contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"));
        assert_eq!(texts(&out, 1), vec![json!({"k":"welcome","v":2,"key":KEY})], "welcome first, with the key");
        assert!(logged(&out, "socket open"));
        let out = s.on_bytes(1, &hello("P1"), 0.2);
        assert_eq!(ups(&out), 1);
        assert!(logged(&out, "hello: edge:P1, Margin ?"));
        assert_eq!(s.link().connection("edge:P1").and_then(|c| c.hello().pid), Some(42), "the pid as the copy says");
    }

    #[test]
    fn frames_that_came_with_the_request_are_read() {
        let mut s = server();
        s.on_accept(1, 0.0);
        let mut both = copy_request();
        both.extend(hello("P1"));
        let out = s.on_bytes(1, &both, 0.0);
        assert_eq!(ups(&out), 1);
    }

    #[test]
    fn turned_away_with_403_before_any_websocket() {
        for (bytes, why) in [
            (request("nope", Some("chrome-extension://x"), "/"), "wrong token"),
            (request(TOKEN, Some("https://evil.example"), "/"), "not from Margin's extension"),
            (request(TOKEN, None, "/"), "not from Margin's extension"),
            (request(TOKEN, Some("chrome-extension://x"), "/other"), "not the link's path"),
            (
                format!("GET /?t={TOKEN} HTTP/1.1\r\nOrigin: chrome-extension://x\r\n\r\n").into_bytes(),
                "not a WebSocket",
            ),
        ] {
            let mut s = server();
            s.on_accept(7, 0.0);
            let out = s.on_bytes(7, &bytes, 0.0);
            assert_eq!(writes(&out, 7), websocket::refusal("403 Forbidden"), "{why}");
            assert!(ended(&out, 7), "{why}: closed");
            assert!(logged(&out, &format!("socket refused: {why}")), "{why}: {out:?}");
            assert!(texts(&out, 7).is_empty(), "no welcome");
            assert!(s.on_bytes(7, &hello("P1"), 0.1).is_empty(), "nothing taken after");
            let out = s.on_ended(7, None, 0.2);
            assert!(!logged(&out, "ended before its hello"), "logged as refused, not again as ended");
        }
        let mut s = server();
        s.on_accept(8, 0.0);
        let out = s.on_bytes(8, b"POST / HTTP/1.1\r\n\r\n", 0.0);
        assert_eq!(writes(&out, 8), websocket::refusal("400 Bad Request"));
        assert!(logged(&out, "socket refused: not a request"));
        let mut s = server();
        s.on_accept(9, 0.0);
        let safari = request(TOKEN, Some("safari-web-extension://ABC"), "");
        assert!(writes(&s.on_bytes(9, &safari, 0.0), 9).starts_with(b"HTTP/1.1 101"), "Safari's origin; an empty path");
    }

    #[test]
    fn no_hello_within_5_s_of_being_accepted() {
        let mut s = server();
        s.on_accept(1, 10.0);
        assert_eq!(s.next_deadline(), Some(15.0));
        assert!(s.tick(14.9).is_empty());
        let out = s.tick(15.0);
        assert!(ended(&out, 1));
        assert!(writes(&out, 1).is_empty(), "not upgraded: no close frame");
        assert!(logged(&out, "socket ended before its hello (before the upgrade, 5000.0 ms): no hello within 5 s"));
        // Upgraded at 3 s, still no hello: closed 1008 at 5 s from its acceptance.
        s.on_accept(2, 20.0);
        s.on_bytes(2, &copy_request(), 23.0);
        assert_eq!(s.next_deadline(), Some(25.0));
        let out = s.tick(25.0);
        assert_eq!(closes(&out, 2), vec![(1008, "no hello within 5 s".to_string())]);
        assert!(logged(&out, "socket ended before its hello (after the upgrade, 5000.0 ms): no hello within 5 s"));
        assert!(s.on_ended(2, None, 25.1).is_empty());
    }

    #[test]
    fn pings_are_answered_and_a_close_frame_closes_1000() {
        let mut s = linked();
        let out = s.on_bytes(1, &client_frame(9, b"hi", true), 1.0);
        assert_eq!(frames(&out, 1), vec![(10, "hi".into())], "a pong");
        let mut close = vec![3, 233];
        close.extend_from_slice(b"going");
        let out = s.on_bytes(1, &client_frame(8, &close, true), 2.0);
        assert_eq!(downs(&out), vec!["closed by the extension (1001 going)".to_string()]);
        assert_eq!(closes(&out, 1), vec![(1000, "closed by the extension (1001 going)".to_string())], "answered 1000");
        assert!(ended(&out, 1));
        assert!(s.on_ended(1, None, 2.1).is_empty(), "its end after: nothing more");
    }

    #[test]
    fn a_tcp_end_without_a_close_frame_is_1006() {
        let mut s = linked();
        let out = s.on_ended(1, None, 1.0);
        assert_eq!(downs(&out), vec!["closed by the extension (1006, no close frame)".to_string()]);
        let mut s = linked();
        let out = s.on_ended(1, Some("reset"), 1.0);
        assert_eq!(downs(&out), vec!["closed by the extension (1006, connection failed: reset)".to_string()]);
        let mut s = server();
        s.on_accept(3, 0.0);
        let out = s.on_ended(3, None, 0.5);
        assert!(logged(&out, "socket ended before its hello (before the upgrade, 500.0 ms): TCP closed"));
    }

    #[test]
    fn a_protocol_error_closes_1002() {
        let mut s = linked();
        let out = s.on_bytes(1, &[0x81, 0x02, b'h', b'i'], 1.0);
        assert_eq!(downs(&out), vec!["unmasked".to_string()]);
        assert_eq!(closes(&out, 1), vec![(1002, "unmasked".to_string())]);
        assert!(ended(&out, 1));
    }

    #[test]
    fn the_links_messages_are_frames() {
        let mut s = linked();
        let bytes = s.send(1, &AppMessage::Tick, 1.0).unwrap_or_default();
        let back = server_frames(&bytes).unwrap_or_default();
        assert_eq!(back.len(), 1);
        assert_eq!(serde_json::from_slice::<Value>(&back[0].1).ok(), Some(json!({"k":"tick","at":1000})));
        let (id, bytes) = s.request(1, "x", Object::new(), Some(3), 1.0).unwrap_or_default();
        assert_eq!(id, 1);
        assert!(!bytes.is_empty());
        let out = s.on_bytes(1, &client_frame(1, br#"{"k":"reply","id":1,"ok":true}"#, true), 2.0);
        assert!(out.iter().any(|o| matches!(o, Out::Link(Action::Answer { id: 1, answer: Ok(_), .. }))));
        let out = s.tick(5.0);
        assert_eq!(texts(&out, 1), vec![json!({"k":"tick","at":5000})], "the ticker, as frames");
        assert_eq!(s.send(9, &AppMessage::Tick, 1.0), Err(LinkError::Down));
    }

    #[test]
    fn a_message_in_pieces() {
        let mut s = linked();
        let text = br#"{"k":"later","x":1}"#;
        let mut bytes = client_frame(1, &text[..5], false);
        bytes.extend(client_frame(0, &text[5..], true));
        let out = s.on_bytes(1, &bytes, 1.0);
        assert!(out.iter().any(|o| matches!(o, Out::Link(Action::Received { .. }))), "{out:?}");
    }

    #[test]
    fn the_secrets_change_30_s_after_the_last_link_closes() {
        let mut s = linked();
        s.on_ended(1, None, 10.0);
        assert_eq!(s.next_deadline(), Some(40.0));
        assert!(s.tick(39.9).is_empty());
        let out = s.tick(40.0);
        assert!(logged(&out, "token changed"));
        assert_ne!(s.token(), TOKEN);
        assert_ne!(s.key(), KEY);
        assert_eq!((s.token().len(), s.key().len()), (64, 64), "32 bytes, hex");
        // The old token is refused now; the new one's welcome has the new key.
        s.on_accept(2, 41.0);
        assert_eq!(writes(&s.on_bytes(2, &copy_request(), 41.0), 2), websocket::refusal("403 Forbidden"));
        s.on_accept(3, 41.0);
        let token = s.token().to_owned();
        let out = s.on_bytes(3, &request(&token, Some("chrome-extension://x"), "/"), 41.0);
        assert_eq!(texts(&out, 3), vec![json!({"k":"welcome","v":2,"key":s.key()})]);
    }

    #[test]
    fn a_link_within_the_30_s_keeps_the_secrets() {
        let mut s = linked();
        s.on_ended(1, None, 10.0);
        s.on_accept(2, 20.0);
        s.on_bytes(2, &copy_request(), 20.0);
        s.on_bytes(2, &hello("P1"), 20.0);
        assert!(!logged(&s.tick(40.0), "token changed"));
        assert_eq!(s.token(), TOKEN);
        // A replaced link isn't the last one going.
        s.on_accept(3, 41.0);
        s.on_bytes(3, &copy_request(), 41.0);
        let out = s.on_bytes(3, &hello("P1"), 41.0);
        assert_eq!(downs(&out), vec!["replaced".to_string()]);
        assert_eq!(closes(&out, 2), vec![(1000, "replaced".to_string())], "the old one closed 1000");
        assert!(!logged(&s.tick(80.0), "token changed"));
    }

    #[test]
    fn want_link_is_answered_with_the_port_token_and_key() {
        let mut s = SocketLink::with_secrets(Timing::default(), "1.2", TOKEN.into(), KEY.into());
        let edge = Via { pid: 42, browser: "edge".into() };
        assert!(s.want_link("n1", edge.clone(), 1.0).is_empty(), "no port yet: held");
        assert!(s.want_link("", edge.clone(), 1.0).is_empty(), "no nonce: left");
        assert!(s.want_link(&"x".repeat(129), edge.clone(), 1.0).is_empty(), "a nonce too long: left");
        let out = s.listening(Some(5555), 2.0);
        assert!(logged(&out, "listening on 127.0.0.1:5555"));
        let dispatches: Vec<(Via, String, Value, u64)> = out
            .iter()
            .filter_map(|o| match o {
                Out::Dispatch { to, name, info, n } => {
                    Some((to.clone(), name.clone(), Value::Object(info.clone()), *n))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            dispatches,
            vec![(
                edge.clone(),
                "link".into(),
                json!({"v":2,"nonce":"n1","port":5555,"token":TOKEN,"key":KEY,"app":{"version":"1.2"},"at":2000}),
                1
            )]
        );
        assert!(logged(&out, "wantLink: link handed to Edge (port 5555, #1)"));
        let out = s.dispatched("link", 1, None);
        assert!(logged(&out, "link #1 reached the extension"));
        let out = s.want_link("n2", Via { pid: 7, browser: "chrome".into() }, 3.0);
        assert!(logged(&out, "wantLink: link handed to Chrome (port 5555, #2)"));
        assert!(logged(
            &s.dispatched("link", 2, Some("no relay of chrome (pid 7)")),
            "link #2 not passed on: no relay"
        ));
        assert!(logged(&s.dispatched("link", 3, Some("x")), "(2 in a row)"));
        assert!(logged(&s.dispatched("link", 4, None), "reached"));
        assert_eq!(s.refused_in_a_row(), 0);
    }

    #[test]
    fn at_most_8_held() {
        let mut s = SocketLink::with_secrets(Timing::default(), "1", TOKEN.into(), KEY.into());
        for i in 0..10 {
            s.want_link(&format!("n{i}"), Via { pid: 0, browser: "chrome".into() }, 0.0);
        }
        let out = s.listening(Some(1), 0.0);
        let nonces: Vec<String> = out
            .iter()
            .filter_map(|o| match o {
                Out::Dispatch { info, .. } => info.get("nonce").and_then(Value::as_str).map(str::to_owned),
                _ => None,
            })
            .collect();
        assert_eq!(nonces, (2..10).map(|i| format!("n{i}")).collect::<Vec<_>>(), "the latest 8");
    }

    #[test]
    fn stopping_says_bye_and_closes_everything() {
        let mut s = linked();
        s.on_accept(2, 1.0);
        let out = s.stop("Margin quit", 2.0);
        assert!(ended(&out, 2), "not upgraded: closed");
        assert!(logged(&out, "socket ended before its hello (before the upgrade, 1000.0 ms): Margin quit"));
        let f = frames(&out, 1);
        assert_eq!(f.first().map(|f| f.0), Some(1));
        assert_eq!(serde_json::from_str::<Value>(&f[0].1).ok(), Some(json!({"k":"bye","why":"Margin quit"})));
        assert_eq!(f.get(1).map(|f| f.0), Some(8), "then a close frame");
        assert_eq!(closes(&out, 1), vec![(1001, "Margin quit".to_string())]);
        assert!(ended(&out, 1));
        assert_eq!(downs(&out), vec!["stopped: Margin quit".to_string()]);
        assert_eq!(s.port(), None);
        assert_eq!(s.on_accept(3, 3.0), vec![Out::End { conn: 3 }], "nothing taken after");
        assert!(s.want_link("n", Via { pid: 0, browser: "chrome".into() }, 3.0).is_empty());
        assert!(s.listening(Some(9), 3.0).is_empty());
        assert!(s.tick(100.0).is_empty());
    }

    #[test]
    fn bad_input_is_lived_with() {
        let mut s = server();
        assert!(s.on_bytes(99, b"anything", 0.0).is_empty(), "a connection never accepted");
        assert!(s.on_ended(99, None, 0.0).is_empty());
        s.on_accept(1, 0.0);
        s.on_bytes(1, &copy_request(), 0.0);
        for junk in [&b"\xff\xff\xff\xff"[..], &[0x81, 0xff], &client_frame(1, b"\xc3\x28", true)] {
            let mut t = linked();
            t.on_bytes(1, junk, 1.0);
            t.tick(200.0);
        }
        s.on_bytes(1, &client_frame(1, b"not json", true), 1.0);
        assert!(s.link().connection_on(1).is_none(), "not linked, still open");
        assert_eq!(s.on_accept(1, 0.5).len(), 1, "accepted again: a warning");
    }

    #[test]
    fn secrets_are_64_hex_and_never_twice_the_same() {
        let (a, b) = (secret(), secret());
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
