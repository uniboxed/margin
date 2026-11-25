//! The app's end of its links to the extension's copies, the session without the transport (app/platforms/macos/shell/
//! ExtensionLink.swift: `SocketLink` and `LinkConnection`, less what's the WebSocket's). A state machine the
//! caller drives (sans-IO): it says when a connection opens ([`Link::on_open`]), each message that comes on it
//! ([`Link::on_text`]), when it ends ([`Link::on_closed`]) and the time ([`Link::tick`]); each returns
//! [`Action`]s: text to send on a connection, a connection to close (with a code and a reason), and what the shell
//! hears (a link up, a message, a link down, a request's answer, a log line). Times are [`Secs`], given by the
//! caller.
//!
//! Its connections are the copies' WebSockets to 127.0.0.1, on every OS (docs/PROTOCOL.md, Transport):
//! [`crate::socket::SocketLink`] holds the sockets, the upgrade, the frames and the secrets, and drives this with
//! each socket once it's upgraded ([`ConnId`]: the transport's name for its TCP connection).
//!
//! Kept from the Swift (every rule that isn't the WebSocket's or Safari's): the first message is
//! `welcome { v: 2, key }`; a connection that says no hello within 5 s of being accepted is closed (1008); a hello
//! with `owner` false is closed (1008, "not the copy in charge"), the profile's link kept; a newer hello for the
//! same `browser:profile` replaces the older link (closed 1000 "replaced"); while any link is up the app ticks
//! every 5 s, the copy answers `tock`, and a link not heard from for 40 s is closed (1001); requests (`req`) are
//! numbered per link, answered by `reply`; a `bye` is passed on, then the link closed ("bye"); stopping says `bye` on
//! every link and closes it (1001). A new copy (another `instanceId`) is the shell's to notice ([`Hello::copy_id`],
//! for the window binder).
//!
//! A request ends only on evidence (docs/LINK-RESILIENCE.md §1, rules 1–6), never after a fixed time: its `reply`
//! (answered `Ok`); the link going down (closed, replaced, or 40 s of total silence: answered [`LinkError::Down`]);
//! [`Link::cancel`] (no answer at all: the copy is told `cancel { id }`, and a later reply is left); or lost (answered
//! [`LinkError::Lost`]). Lost: ticks are numbered (`tick { seq }`) and a new copy echoes the number (`tock { seq }`)
//! and acks each request it reads before running it (`ack { id }`), all from its socket's handler, in order. So a
//! tock of a tick sent after a request, with no ack for it, says the copy read past the request without taking it:
//! it's sent once more (the same id: the copy dedupes), and lost a second time. Signs of life are kept apart: any
//! bytes are *alive* (the 40 s rule only); an ack, a reply or a numbered tock are *reading*. A copy alive but not
//! reading is slow, not gone: its requests wait, and [`Link::slow`] says for how long. An older copy (no acks, tocks
//! without a number) is life only, never lost. A new link (a new epoch) starts with nothing waiting: the link never
//! sends an old id into it (the session decides what's still wanted).
//!
//! Left out here, and where it is:
//! - The RFC 6455 framing, the HTTP upgrade and its refusals, the token's check and the `Origin`'s, the secrets
//!   and their rotation, Safari's and the relays' `wantLink` answered with `link`: [`crate::socket`] and
//!   [`crate::websocket`].
//! - Safari's way in (the distributed notification `com.unibox.margin.setup`'s `wantLink`, `appUp` once Safari has
//!   run 2 s, the link note): [`crate::socket`]; `SFSafariApplication.dispatchMessage` itself is the Mac's transport.
//! - The listener and its upkeep (`NWListener`, 127.0.0.1 only, no Nagle, `waiting` 5 s made again on a new
//!   port, `retryListen`) and `stop`'s 0.3 s wait for the `bye`s to be written before quitting: the transport's.
//!
//! The transport's part that stays: `Socket.got` counts any bytes as being heard from (`lastHeard`), even half a
//! message; the caller says so with [`Link::heard`].

use crate::json::Object;
use crate::protocol::{AppMessage, Hello, LinkMessage, MAX_INCOMING};
use crate::time::Secs;
use std::collections::{BTreeMap, BTreeSet};

/// The transport's name for one connection (one TCP connection). Never reused while this [`Link`] lives.
pub type ConnId = u64;

/// `SocketLink.Timing`, the parts that are the session's.
#[derive(Clone, Debug, PartialEq)]
pub struct Timing {
    /// Every 5 s while any link is up: `tick`, and the silent ones closed.
    pub tick: Secs,
    /// Not heard from for 40 s: closed (1001). (40, not 12, since 2026-11-07: Safari slows a background page's
    /// timers while it isn't in front, and a quiet copy then read as gone. A closed connection is heard at once.)
    pub dead: Secs,
    /// An opened connection's time to say hello: 5 s.
    pub hello: Secs,
}

impl Default for Timing {
    fn default() -> Self {
        Self { tick: 5.0, dead: 40.0, hello: 5.0 }
    }
}

/// `LinkError`: why a request got no answer, or a message wasn't sent. (No time-out: a request ends on evidence only.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkError {
    /// The link is down (or went down while the request waited: closed, replaced, 40 s of total silence).
    Down,
    /// The copy read past it twice without taking it (a numbered tock after it, no ack): it won't run.
    Lost,
    /// Not JSON, or over 1 MB ([`crate::protocol::MAX_APP_MESSAGE`]): refused rather than sent.
    NotJson,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Note,
    Warn,
}

/// What the caller does, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Send this text on the connection (one message: one text frame).
    Send { conn: ConnId, text: String },
    /// Close the connection, saying the code and reason if the transport can. The link has already gone down
    /// here (its [`Action::Down`] follows); call [`Link::on_closed`] all the same once it has ended.
    Close { conn: ConnId, code: u16, reason: String },
    /// `ExtensionLinkDelegate.linkUp`: a copy said hello.
    Up { conn: ConnId, hello: Hello },
    /// `linkReceived`: everything after hello but replies and tocks (a `bye` just before the link goes down).
    Received { conn: ConnId, key: String, message: LinkMessage },
    /// `linkDown`: the link is gone, and why ("replaced", "bye", "stopped: …", "no word for 40 s", or the
    /// transport's word).
    Down { conn: ConnId, key: String, why: String },
    /// A request's answer: the reply's body (`{ ok, result }` or `{ ok: false, error, stale? }`), or why none.
    Answer { conn: ConnId, key: String, id: i64, answer: Result<Object, LinkError> },
    /// A line for the app's log (`Diagnostics.note` and `.warn`).
    Log { level: Level, text: String },
}

/// `LinkConnection`: one copy's link, once it has said hello: what the rest of the app talks to.
#[derive(Clone, Debug)]
pub struct Connection {
    hello: Hello,
    conn: ConnId,
    last_heard: Secs,
    next_id: i64,
    /// Each request waiting for its reply.
    waiting: BTreeMap<i64, Waiting>,
    refused: usize,
    /// The last tick's number sent on this link (0: none yet).
    tick_seq: i64,
}

/// A request waiting for its reply.
#[derive(Clone, Debug)]
struct Waiting {
    kind: String,
    /// When it was sent: its age is how slow the copy is while it isn't acked.
    asked: Secs,
    /// The number of the last tick sent before it (sent again: before that): a tock with a later one means the copy
    /// read past it.
    after_tick: i64,
    acked: bool,
    /// When its ack came (said with a slow reply: read late, or worked on long).
    acked_at: Option<Secs>,
    /// Sent a second time already.
    again: bool,
    /// Its text, to send again.
    text: String,
}

impl Connection {
    pub fn hello(&self) -> &Hello {
        &self.hello
    }
    pub fn conn(&self) -> ConnId {
        self.conn
    }
    /// `browser:profile`.
    pub fn key(&self) -> String {
        self.hello.key()
    }
    pub fn epoch(&self) -> &str {
        &self.hello.epoch
    }
    /// Messages refused for their size (or not JSON).
    pub fn refused(&self) -> usize {
        self.refused
    }
    /// Requests waiting for their reply.
    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }
    /// The oldest request not acked yet: how long it has waited at `now` (none: every request waiting was taken).
    pub fn slow(&self, now: Secs) -> Option<Secs> {
        self.waiting.values().filter(|w| !w.acked).map(|w| (now - w.asked).max(0.0)).reduce(Secs::max)
    }
    pub fn last_heard(&self) -> Secs {
        self.last_heard
    }
}

/// A reply this late is said in the log with when its request was acked (feedback for the app's log only: nothing is
/// decided by it).
const SLOW_REPLY: Secs = 0.1;

/// `SocketLink`, without the socket.
#[derive(Clone, Debug)]
pub struct Link {
    timing: Timing,
    welcome_key: String,
    /// Opened, no hello yet: when each was accepted.
    opening: BTreeMap<ConnId, Secs>,
    /// By `Hello::key`.
    links: BTreeMap<String, Connection>,
    /// Closed here, not yet said to have ended by the transport: whatever comes on them is left.
    ended: BTreeSet<ConnId>,
    /// The ticker's next time, while any link is up.
    next_tick: Option<Secs>,
    stopped: bool,
    /// Added to `now` for the messages' `at` (the wall clock's, `Date.now()`), for a caller whose `now` is a
    /// monotonic clock (the Mac's `systemUptime`: a sleep never reads as 40 s of silence). 0: `now` is the wall's.
    wall: Secs,
}

fn whole(s: Secs) -> i64 {
    s as i64
}

impl Link {
    /// `welcome_key`: the key the first message carries (the app's proof that it's the app).
    pub fn new(timing: Timing, welcome_key: String) -> Self {
        Self {
            timing,
            welcome_key,
            opening: BTreeMap::new(),
            links: BTreeMap::new(),
            ended: BTreeSet::new(),
            next_tick: None,
            stopped: false,
            wall: 0.0,
        }
    }

    pub fn timing(&self) -> &Timing {
        &self.timing
    }

    /// `now` plus this is the wall clock's time (seconds since 1970), for the messages' `at`.
    pub fn set_wall_offset(&mut self, offset: Secs) {
        self.wall = if offset.is_finite() { offset } else { 0.0 };
    }

    /// The messages' `at` for `now`: the wall clock's milliseconds.
    pub fn at_ms(&self, now: Secs) -> f64 {
        (now + self.wall) * 1000.0
    }

    /// The key the next connections' `welcome` carries (the secrets changed: [`crate::socket::SocketLink`]).
    pub fn set_welcome_key(&mut self, key: String) {
        self.welcome_key = key;
    }

    /// `connections`: every link up, by key.
    pub fn connections(&self) -> impl Iterator<Item = &Connection> {
        self.links.values()
    }

    /// `connection(_:)`: the link up for `browser:profile`.
    pub fn connection(&self, key: &str) -> Option<&Connection> {
        self.links.get(key)
    }

    /// The link up on a connection.
    pub fn connection_on(&self, conn: ConnId) -> Option<&Connection> {
        self.links.values().find(|l| l.conn == conn)
    }

    /// `isUp`: whether the link on `conn` is up (said hello, not replaced, not closed).
    pub fn is_up(&self, conn: ConnId) -> bool {
        self.connection_on(conn).is_some()
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    fn key_of(&self, conn: ConnId) -> Option<String> {
        self.links.iter().find(|(_, l)| l.conn == conn).map(|(k, _)| k.clone())
    }

    fn known(&self, conn: ConnId) -> bool {
        self.opening.contains_key(&conn) || self.ended.contains(&conn) || self.key_of(conn).is_some()
    }

    /// `accept` and `opened`: a connection opened now. Its first message is `welcome`; it has 5 s to say hello.
    pub fn on_open(&mut self, conn: ConnId, now: Secs) -> Vec<Action> {
        self.on_open_at(conn, now, now)
    }

    /// `opened`: a connection accepted at `accepted` (its 5 s to say hello count from then) opened now (the
    /// WebSocket's upgrade done).
    pub fn on_open_at(&mut self, conn: ConnId, accepted: Secs, now: Secs) -> Vec<Action> {
        let mut out = Vec::new();
        if self.stopped {
            out.push(Action::Close { conn, code: 1001, reason: "stopped".into() });
            self.ended.insert(conn);
            return out;
        }
        if self.known(conn) {
            warn(&mut out, format!("connection {conn} opened again: left"));
            return out;
        }
        self.opening.insert(conn, accepted);
        note(&mut out, "socket open".into());
        if let Some(text) = (AppMessage::Welcome { key: self.welcome_key.clone() }).encode(self.at_ms(now)) {
            out.push(Action::Send { conn, text });
        }
        out
    }

    /// Bytes came on a connection, maybe not yet a whole message (`Socket.got`'s `lastHeard`): it's alive.
    pub fn heard(&mut self, conn: ConnId, now: Secs) {
        if let Some(link) = self.links.values_mut().find(|l| l.conn == conn) {
            link.last_heard = now;
        }
    }

    /// `received(_:on:)`: one message (one WebSocket message's text) on a connection.
    pub fn on_text(&mut self, conn: ConnId, text: &str, now: Secs) -> Vec<Action> {
        let mut out = Vec::new();
        if self.stopped || self.ended.contains(&conn) || !self.known(conn) {
            return out;
        }
        self.heard(conn, now);
        if text.len() > MAX_INCOMING {
            // (The frame reader's `TooBig`, closed 1002.)
            self.close_conn(conn, 1002, format!("a message over {MAX_INCOMING} bytes"), now, &mut out);
            return out;
        }
        let Some(message) = LinkMessage::decode(text) else {
            let start: String = text.chars().take(40).collect();
            warn(&mut out, format!("not a link message ({start})"));
            return out;
        };
        if let LinkMessage::Hello(hello) = message {
            self.said(conn, hello, now, &mut out);
            return out;
        }
        let Some(key) = self.key_of(conn) else {
            // (The Swift's log says "closed" here, but it only leaves the message.)
            warn(&mut out, "a message before hello: left".into());
            return out;
        };
        match message {
            LinkMessage::Reply { id, body } => {
                let waited = self.links.get_mut(&key).and_then(|l| l.waiting.remove(&id));
                if let Some(w) = waited {
                    // (A slow one said, where its time went: the copy reading it late, or working on it long.)
                    if now - w.asked >= SLOW_REPLY {
                        let ms = |s: Secs| (s * 1000.0).round() as i64;
                        let read =
                            w.acked_at.map_or("not acked".to_string(), |a| format!("acked at {} ms", ms(a - w.asked)));
                        note(
                            &mut out,
                            format!("{key}: request {id} ({}) answered in {} ms ({read})", w.kind, ms(now - w.asked)),
                        );
                    }
                    out.push(Action::Answer { conn, key, id, answer: Ok(body) });
                }
            }
            LinkMessage::Ack { id } => {
                if let Some(w) = self.links.get_mut(&key).and_then(|l| l.waiting.get_mut(&id)) {
                    w.acked = true;
                    w.acked_at.get_or_insert(now);
                }
            }
            LinkMessage::Tock { seq: Some(seq) } => self.read_past(&key, seq, &mut out),
            // (An older copy's, or the copy's probe after a pause: alive, nothing more.)
            LinkMessage::Tock { seq: None } => {}
            LinkMessage::Bye { ref why } => {
                note(&mut out, format!("{key} said goodbye: {why}"));
                // Before it's down: nothing to wait for.
                out.push(Action::Received { conn, key, message: message.clone() });
                self.close_conn(conn, 1000, "bye".into(), now, &mut out);
            }
            message => out.push(Action::Received { conn, key, message }),
        }
        out
    }

    /// `said(_:on:)`: a hello.
    fn said(&mut self, conn: ConnId, hello: Hello, now: Secs, out: &mut Vec<Action>) {
        if self.key_of(conn).is_some() {
            return warn(out, "a second hello on one socket: left".into());
        }
        let key = hello.key();
        if !hello.owner {
            note(out, format!("hello from a copy of Margin not in charge in {key}: closed"));
            return self.close_conn(conn, 1008, "not the copy in charge".into(), now, out);
        }
        self.opening.remove(&conn);
        if let Some(old) = self.links.remove(&key) {
            // Not the profile's link going down: the newer one takes over.
            let old_conn = old.conn;
            fail_waiting(old, key.clone(), out);
            out.push(Action::Close { conn: old_conn, code: 1000, reason: "replaced".into() });
            self.ended.insert(old_conn);
            note(out, format!("a newer link for {key} took over"));
            out.push(Action::Down { conn: old_conn, key: key.clone(), why: "replaced".into() });
        }
        let socket_note =
            hello.sockets_off.as_ref().map(|s| format!("; its link was off before: {s}")).unwrap_or_default();
        note(out, format!("hello: {key}, Margin {}{socket_note}", hello.ext.as_deref().unwrap_or("?")));
        self.links.insert(
            key,
            Connection {
                hello: hello.clone(),
                conn,
                last_heard: now,
                next_id: 1,
                waiting: BTreeMap::new(),
                refused: 0,
                tick_seq: 0,
            },
        );
        if self.next_tick.is_none() {
            self.next_tick = Some(now + self.timing.tick);
        }
        out.push(Action::Up { conn, hello });
    }

    /// A numbered tock: the copy read that tick, so everything sent before it. A request sent before the tick and not
    /// acked was read past without being taken (never by a correct copy): sent once more with its id, then lost.
    fn read_past(&mut self, key: &str, seq: i64, out: &mut Vec<Action>) {
        let Some(link) = self.links.get_mut(key) else { return };
        let conn = link.conn;
        let past: Vec<i64> =
            link.waiting.iter().filter(|(_, w)| !w.acked && seq > w.after_tick).map(|(&id, _)| id).collect();
        for id in past {
            let Some(w) = link.waiting.get_mut(&id) else { continue };
            if w.again {
                let kind = w.kind.clone();
                link.waiting.remove(&id);
                warn(out, format!("{key}: request {id} ({kind}) lost twice: the copy read past it without taking it"));
                out.push(Action::Answer { conn, key: key.to_owned(), id, answer: Err(LinkError::Lost) });
            } else {
                w.again = true;
                w.after_tick = link.tick_seq;
                warn(out, format!("{key}: request {id} ({}) read past without being taken: sent again", w.kind));
                out.push(Action::Send { conn, text: w.text.clone() });
            }
        }
    }

    /// `closed(_:_:)`: the transport says the connection ended (the copy closed it, the TCP connection went), and why.
    pub fn on_closed(&mut self, conn: ConnId, why: &str, now: Secs) -> Vec<Action> {
        let mut out = Vec::new();
        if self.ended.remove(&conn) {
            return out;
        }
        self.closed(conn, why, now, &mut out);
        out
    }

    /// `LinkConnection.close`: the app closes a link (or a connection not yet linked).
    pub fn close(&mut self, conn: ConnId, code: u16, why: &str, now: Secs) -> Vec<Action> {
        let mut out = Vec::new();
        self.close_conn(conn, code, why.into(), now, &mut out);
        out
    }

    /// `Socket.close`: closed here, at once gone for the session (`end`).
    fn close_conn(&mut self, conn: ConnId, code: u16, why: String, now: Secs, out: &mut Vec<Action>) {
        if self.ended.contains(&conn) || !self.known(conn) {
            return;
        }
        out.push(Action::Close { conn, code, reason: why.clone() });
        self.ended.insert(conn);
        self.closed(conn, &why, now, out);
    }

    fn closed(&mut self, conn: ConnId, why: &str, now: Secs, out: &mut Vec<Action>) {
        if let Some(opened) = self.opening.remove(&conn) {
            // Ended before its hello: the 'no hello' timeout, a TCP connection closed after the upgrade, a copy not in
            // charge. (One ended before the upgrade is the socket's to say: crate::socket.)
            let ms = ((now - opened) * 1000.0).max(0.0);
            return note(out, format!("socket ended before its hello (after the upgrade, {ms:.1} ms): {why}"));
        }
        let Some(key) = self.key_of(conn) else { return };
        let Some(link) = self.links.remove(&key) else { return };
        fail_waiting(link, key.clone(), out);
        note(out, format!("link down ({key}): {why}"));
        if self.links.is_empty() {
            self.next_tick = None;
        }
        out.push(Action::Down { conn, key, why: why.into() });
    }

    /// The time: hellos not said within 5 s closed, and every 5 s while a link is up, each link ticked (its next
    /// number) or (silent for 40 s) closed, its requests answered `Down`. Requests have no time of their own. Call it at
    /// [`Link::next_deadline`], or often.
    pub fn tick(&mut self, now: Secs) -> Vec<Action> {
        let mut out = Vec::new();
        if self.stopped {
            return out;
        }
        let hello = self.timing.hello;
        let late: Vec<ConnId> = self.opening.iter().filter(|&(_, &at)| now >= at + hello).map(|(&c, _)| c).collect();
        for conn in late {
            self.close_conn(conn, 1008, format!("no hello within {} s", whole(hello)), now, &mut out);
        }
        if let Some(due) = self.next_tick.filter(|&due| now >= due) {
            let dead = self.timing.dead;
            let at = self.at_ms(now);
            let links: Vec<(String, ConnId, Secs)> =
                self.links.iter().map(|(k, l)| (k.clone(), l.conn, l.last_heard)).collect();
            for (key, conn, last_heard) in links {
                if now - last_heard > dead {
                    warn(&mut out, format!("no word from {key} for {} s", whole(dead)));
                    self.close_conn(conn, 1001, format!("no word for {} s", whole(dead)), now, &mut out);
                } else if let Some(link) = self.links.get_mut(&key) {
                    let seq = link.tick_seq + 1;
                    if let Some(text) = (AppMessage::Tick { seq }).encode(at) {
                        link.tick_seq = seq;
                        out.push(Action::Send { conn, text });
                    }
                }
            }
            // A repeating timer: on from the last time, skipping any missed.
            let next = due + self.timing.tick;
            self.next_tick =
                (!self.links.is_empty()).then_some(if next <= now { now + self.timing.tick } else { next });
        }
        out
    }

    /// When [`Link::tick`] next has something to do, if ever.
    pub fn next_deadline(&self) -> Option<Secs> {
        let hellos = self.opening.values().map(|&at| at + self.timing.hello);
        self.next_tick.into_iter().chain(hellos).reduce(f64::min)
    }

    /// `LinkConnection.send`: a message to the link on `conn`, as the text to send. `Err(Down)` if it isn't up,
    /// `Err(NotJson)` if it isn't JSON or is over 1 MB (counted in [`Connection::refused`]; the caller logs it:
    /// "not sent to KEY: not JSON, or over 1000000 bytes").
    pub fn send(&mut self, conn: ConnId, message: &AppMessage, now: Secs) -> Result<Action, LinkError> {
        let at = self.at_ms(now);
        let link = self.links.values_mut().find(|l| l.conn == conn).ok_or(LinkError::Down)?;
        match message.encode(at) {
            Some(text) => Ok(Action::Send { conn, text }),
            None => {
                link.refused += 1;
                Err(LinkError::NotJson)
            }
        }
    }

    /// `LinkConnection.request`: a `req` to the link on `conn`, its id and the text to send. Its answer comes as an
    /// [`Action::Answer`] with that id, on evidence only: the reply, `Down` if the link goes first, `Lost` if the copy
    /// read past it twice; none once [`Link::cancel`]led. It has no time-out.
    pub fn request(
        &mut self,
        conn: ConnId,
        kind: &str,
        payload: Object,
        window_id: Option<i64>,
        now: Secs,
    ) -> Result<(i64, Action), LinkError> {
        let at = self.at_ms(now);
        let link = self.links.values_mut().find(|l| l.conn == conn).ok_or(LinkError::Down)?;
        let id = link.next_id;
        link.next_id += 1;
        let req = AppMessage::Req { id, epoch: link.hello.epoch.clone(), window_id, kind: kind.into(), payload };
        let text = req.encode(at).ok_or(LinkError::NotJson)?;
        let waiting = Waiting {
            kind: kind.into(),
            asked: now,
            after_tick: link.tick_seq,
            acked: false,
            acked_at: None,
            again: false,
            text: text.clone(),
        };
        link.waiting.insert(id, waiting);
        Ok((id, Action::Send { conn, text }))
    }

    /// The session no longer waits for request `id` on `conn` (the pick it was for was overtaken): it's no longer
    /// waiting (no answer comes for it, a later reply is left) and the copy is told (`cancel { id }`, the text to send).
    /// `None`: nothing waits for it there (answered already, cancelled, or the link is down).
    pub fn cancel(&mut self, conn: ConnId, id: i64) -> Option<Action> {
        let link = self.links.values_mut().find(|l| l.conn == conn)?;
        link.waiting.remove(&id)?;
        let text = (AppMessage::Cancel { id }).encode(0.0)?;
        Some(Action::Send { conn, text })
    }

    /// How slow the copy on `conn` is at `now`: the age of its oldest request not acked yet, for the session's
    /// feedback only ("Safari is slow"). `None`: nothing waits unread (or no such link).
    pub fn slow(&self, conn: ConnId, now: Secs) -> Option<Secs> {
        self.connection_on(conn)?.slow(now)
    }

    /// `stop(why:then:)`: the app is going. Connections not linked yet are closed (1001); each link is told `bye`
    /// and closed (1001), and goes down ("stopped: WHY"). Nothing is taken after it.
    pub fn stop(&mut self, why: &str, now: Secs) -> Vec<Action> {
        let mut out = Vec::new();
        if self.stopped {
            return out;
        }
        self.stopped = true;
        self.next_tick = None;
        let opening: Vec<ConnId> = self.opening.keys().copied().collect();
        for conn in opening {
            self.close_conn(conn, 1001, why.into(), now, &mut out);
        }
        let links: Vec<ConnId> = self.links.values().map(|l| l.conn).collect();
        for conn in links {
            if let Some(text) = (AppMessage::Bye { why: why.into() }).encode(self.at_ms(now)) {
                out.push(Action::Send { conn, text });
            }
            out.push(Action::Close { conn, code: 1001, reason: why.into() });
            self.ended.insert(conn);
            self.closed(conn, &format!("stopped: {why}"), now, &mut out);
        }
        out
    }
}

/// `LinkConnection.down`: every request still waiting answered `Down`.
fn fail_waiting(link: Connection, key: String, out: &mut Vec<Action>) {
    for id in link.waiting.into_keys() {
        out.push(Action::Answer { conn: link.conn, key: key.clone(), id, answer: Err(LinkError::Down) });
    }
}

fn note(out: &mut Vec<Action>, text: String) {
    out.push(Action::Log { level: Level::Note, text });
}

fn warn(out: &mut Vec<Action>, text: String) {
    out.push(Action::Log { level: Level::Warn, text });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::MAX_APP_MESSAGE;
    use serde_json::{Value, json};

    fn hello(profile: &str, instance: &str) -> String {
        json!({"k":"hello","v":2,"epoch":format!("ep-{instance}"),"profile":profile,"browser":"chrome","owner":true,"instanceId":instance,"ext":"2.0"}).to_string()
    }

    fn sends(actions: &[Action]) -> Vec<(ConnId, Value)> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Send { conn, text } => Some((*conn, serde_json::from_str(text).unwrap_or(Value::Null))),
                _ => None,
            })
            .collect()
    }

    fn closes(actions: &[Action]) -> Vec<(ConnId, u16, String)> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Close { conn, code, reason } => Some((*conn, *code, reason.clone())),
                _ => None,
            })
            .collect()
    }

    fn downs(actions: &[Action]) -> Vec<(ConnId, String, String)> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Down { conn, key, why } => Some((*conn, key.clone(), why.clone())),
                _ => None,
            })
            .collect()
    }

    fn answers(actions: &[Action]) -> Vec<(i64, Result<Object, LinkError>)> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Answer { id, answer, .. } => Some((*id, answer.clone())),
                _ => None,
            })
            .collect()
    }

    fn ups(actions: &[Action]) -> usize {
        actions.iter().filter(|a| matches!(a, Action::Up { .. })).count()
    }

    fn logged(actions: &[Action], text: &str) -> bool {
        actions.iter().any(|a| matches!(a, Action::Log { text: t, .. } if t.contains(text)))
    }

    /// A link with one copy linked on connection 1 at time 0.
    fn linked() -> Link {
        let mut link = Link::new(Timing::default(), "K".into());
        link.on_open(1, 0.0);
        link.on_text(1, &hello("P1", "A"), 0.0);
        link
    }

    #[test]
    fn the_first_message_is_welcome() {
        let mut link = Link::new(Timing::default(), "K".into());
        let out = link.on_open(1, 0.0);
        assert_eq!(sends(&out), vec![(1, json!({"k":"welcome","v":2,"key":"K"}))]);
        link.set_welcome_key("K2".into());
        assert_eq!(sends(&link.on_open(2, 0.0)), vec![(2, json!({"k":"welcome","v":2,"key":"K2"}))], "new secrets");
    }

    #[test]
    fn hello_brings_the_link_up() {
        let mut link = Link::new(Timing::default(), "K".into());
        link.on_open(1, 0.0);
        let out = link.on_text(1, &hello("P1", "A"), 1.0);
        assert_eq!(ups(&out), 1);
        assert!(logged(&out, "hello: chrome:P1, Margin 2.0"));
        assert!(link.is_up(1));
        let c = link.connection("chrome:P1").map(|c| (c.conn(), c.epoch().to_owned(), c.hello().copy_id()));
        assert_eq!(c, Some((1, "ep-A".into(), "A".into())));
    }

    #[test]
    fn no_hello_within_5_s_is_closed() {
        let mut link = Link::new(Timing::default(), "K".into());
        link.on_open(1, 10.0);
        assert_eq!(link.next_deadline(), Some(15.0));
        assert!(closes(&link.tick(14.9)).is_empty());
        let out = link.tick(15.0);
        assert_eq!(closes(&out), vec![(1, 1008, "no hello within 5 s".into())]);
        assert!(logged(&out, "socket ended before its hello (after the upgrade, 5000.0 ms): no hello within 5 s"));
        assert!(downs(&out).is_empty(), "never a link");
        assert_eq!(link.next_deadline(), None);
        assert!(link.on_text(1, &hello("P1", "A"), 15.1).is_empty(), "a hello after: left");
        // Said in time: kept.
        link.on_open(2, 20.0);
        link.on_text(2, &hello("P1", "A"), 24.9);
        assert!(closes(&link.tick(25.0)).is_empty());
        assert!(link.is_up(2));
    }

    #[test]
    fn a_copy_not_in_charge_is_closed_1008() {
        let mut link = linked();
        link.on_open(2, 1.0);
        let not_owner =
            json!({"k":"hello","v":2,"epoch":"e","profile":"P1","browser":"chrome","owner":false}).to_string();
        let out = link.on_text(2, &not_owner, 1.0);
        assert_eq!(closes(&out), vec![(2, 1008, "not the copy in charge".into())]);
        assert_eq!(ups(&out), 0);
        assert!(downs(&out).is_empty());
        assert!(link.is_up(1), "the profile's link kept");
        assert_eq!(link.connection("chrome:P1").map(Connection::conn), Some(1));
        // No owner field at all: not the owner.
        link.on_open(3, 1.0);
        let bare = json!({"k":"hello","v":2,"epoch":"e","profile":"P2","browser":"chrome"}).to_string();
        assert_eq!(closes(&link.on_text(3, &bare, 1.0)), vec![(3, 1008, "not the copy in charge".into())]);
    }

    #[test]
    fn a_newer_hello_replaces_the_older_link() {
        let mut link = linked();
        let id = link.request(1, "activateTab", Object::new(), Some(4), 1.0).map(|r| r.0).unwrap_or(0);
        link.on_open(2, 2.0);
        let out = link.on_text(2, &hello("P1", "A2"), 2.0);
        assert_eq!(closes(&out), vec![(1, 1000, "replaced".into())]);
        assert_eq!(downs(&out), vec![(1, "chrome:P1".into(), "replaced".into())]);
        assert_eq!(answers(&out), vec![(id, Err(LinkError::Down))], "the older link's requests: down");
        assert_eq!(ups(&out), 1);
        assert!(logged(&out, "a newer link for chrome:P1 took over"));
        assert!(!link.is_up(1) && link.is_up(2));
        assert_eq!(link.connection("chrome:P1").map(|c| c.hello().copy_id()), Some("A2".into()));
        assert!(
            link.on_text(1, r#"{"k":"windows","epoch":"ep-A","seq":2,"list":[]}"#, 3.0).is_empty(),
            "the old one's messages: left"
        );
        assert!(link.on_closed(1, "pipe closed", 3.0).is_empty(), "and its end: nothing more");
        // Another profile is another link.
        link.on_open(3, 4.0);
        link.on_text(3, &hello("P2", "B"), 4.0);
        let keys: Vec<String> = link.connections().map(Connection::key).collect();
        assert_eq!(keys, vec!["chrome:P1".to_owned(), "chrome:P2".to_owned()]);
    }

    #[test]
    fn a_tick_every_5_s_while_linked() {
        let mut link = Link::new(Timing::default(), "K".into());
        assert_eq!(link.next_deadline(), None, "nothing to do with no link");
        assert!(link.tick(100.0).is_empty());
        link.on_open(1, 100.0);
        link.on_text(1, &hello("P1", "A"), 100.0);
        link.on_open(2, 101.0);
        link.on_text(2, &hello("P2", "B"), 101.0);
        assert_eq!(link.next_deadline(), Some(105.0), "from the first hello");
        assert!(sends(&link.tick(104.9)).is_empty());
        let ticks = sends(&link.tick(105.0));
        assert_eq!(ticks.len(), 2);
        assert!(ticks.iter().all(|(_, m)| m["k"] == "tick" && m["at"] == json!(105_000)));
        assert_eq!(link.next_deadline(), Some(110.0));
        assert!(sends(&link.tick(109.0)).is_empty());
        assert_eq!(sends(&link.tick(110.2)).len(), 2);
        assert_eq!(link.next_deadline(), Some(115.0), "on the 5 s beat, not from when tick was called");
        assert_eq!(sends(&link.tick(131.0)).len(), 2, "missed beats: one tick");
        assert_eq!(link.next_deadline(), Some(136.0));
    }

    #[test]
    fn at_is_the_wall_clocks_with_a_monotonic_now() {
        let mut link = linked();
        link.set_wall_offset(1_800_000_000.0);
        let ticks = sends(&link.tick(5.0));
        assert_eq!(ticks[0].1["at"], json!(1_800_000_005_000_i64));
        let Ok((_, Action::Send { text, .. })) = link.request(1, "x", Object::new(), None, 6.0) else {
            panic!("a send")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&text).ok().map(|v| v["at"].clone()),
            Some(json!(1_800_000_006_000_i64))
        );
        // The deadlines stay on `now`'s clock: a sleep (no `now` passing) is never 40 s of silence.
        assert_eq!(link.next_deadline(), Some(10.0));
        link.set_wall_offset(f64::NAN);
        assert_eq!(sends(&link.tick(10.0))[0].1["at"], json!(10_000), "not a number: none added");
    }

    #[test]
    fn silent_for_40_s_is_closed_1001() {
        let mut link = linked();
        for t in [5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0] {
            assert!(closes(&link.tick(t)).is_empty());
        }
        let at_40 = link.tick(40.0);
        assert!(closes(&at_40).is_empty(), "40 s exactly: still ticked");
        assert_eq!(sends(&at_40).len(), 1);
        let out = link.tick(45.0);
        assert_eq!(closes(&out), vec![(1, 1001, "no word for 40 s".into())]);
        assert_eq!(downs(&out), vec![(1, "chrome:P1".into(), "no word for 40 s".into())]);
        assert!(logged(&out, "no word from chrome:P1 for 40 s"));
        assert!(sends(&out).is_empty());
        assert_eq!(link.next_deadline(), None, "the last link gone: no ticker");
    }

    #[test]
    fn a_tock_or_any_word_keeps_it() {
        let mut link = linked();
        link.on_text(1, r#"{"k":"tock","at":1}"#, 30.0);
        assert!(closes(&link.tick(45.0)).is_empty());
        assert!(closes(&link.tick(70.0)).is_empty(), "40 s from the tock");
        link.heard(1, 60.0); // bytes of a message not yet whole
        assert!(closes(&link.tick(100.0)).is_empty());
        assert_eq!(closes(&link.tick(105.0)), vec![(1, 1001, "no word for 40 s".into())]);
    }

    #[test]
    fn tocks_and_replies_are_not_passed_on() {
        let mut link = linked();
        assert!(link.on_text(1, r#"{"k":"tock","at":1}"#, 1.0).is_empty());
        assert!(link.on_text(1, r#"{"k":"reply","id":99,"ok":true}"#, 1.0).is_empty(), "a reply no one waits for");
    }

    #[test]
    fn requests_are_answered_by_reply() {
        let mut link = linked();
        let first =
            link.request(1, "activateTab", json!({"tabId":9}).as_object().cloned().unwrap_or_default(), Some(4), 1.0);
        let Ok((id, send)) = first else { panic!("a request") };
        assert_eq!(id, 1, "numbered from 1 per link");
        let Action::Send { conn: 1, text } = send else { panic!("sent on the link") };
        let sent: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        assert_eq!(
            sent,
            json!({"k":"req","id":1,"epoch":"ep-A","at":1000,"windowId":4,"type":"activateTab","payload":{"tabId":9}})
        );
        assert_eq!(link.request(1, "x", Object::new(), None, 1.0).map(|r| r.0), Ok(2));
        let out = link.on_text(1, r#"{"k":"reply","id":1,"ok":true,"result":{"a":1}}"#, 2.0);
        assert_eq!(
            answers(&out),
            vec![(1, Ok(json!({"ok":true,"result":{"a":1}}).as_object().cloned().unwrap_or_default()))]
        );
        assert!(link.on_text(1, r#"{"k":"reply","id":1,"ok":true}"#, 2.0).is_empty(), "answered once");
        assert_eq!(link.connection("chrome:P1").map(Connection::waiting), Some(1));
    }

    /// The copy saying something now and then (a windows report: alive), never an ack, a reply or a tock with a seq.
    fn alive(link: &mut Link, now: Secs) -> Vec<Action> {
        link.on_text(1, r#"{"k":"windows","epoch":"ep-A","seq":1,"list":[]}"#, now)
    }

    #[test]
    fn a_request_to_a_copy_alive_but_not_reading_keeps_waiting() {
        let mut link = linked();
        let id = link.request(1, "hostShow", Object::new(), None, 1.0).map(|r| r.0).unwrap_or(0);
        let mut answered = Vec::new();
        let mut t = 5.0;
        while t <= 600.0 {
            answered.extend(answers(&alive(&mut link, t - 0.5)));
            answered.extend(answers(&link.tick(t)));
            if [15.0, 60.0, 600.0].contains(&t) {
                assert_eq!(link.connection("chrome:P1").map(Connection::waiting), Some(1), "still waiting at {t} s");
            }
            t += 5.0;
        }
        assert!(answered.is_empty(), "no answer while the copy is alive: {answered:?}");
        assert!(link.is_up(1));
        assert_eq!(link.next_deadline(), Some(605.0), "only the ticker: a request has no time of its own");
        let out = link.on_text(1, &format!(r#"{{"k":"reply","id":{id},"ok":true}}"#), 601.0);
        assert_eq!(answers(&out).len(), 1, "its reply, whenever it comes, ends it");
    }

    #[test]
    fn a_waiting_request_ends_down_on_40_s_of_silence() {
        let mut link = linked();
        let id = link.request(1, "x", Object::new(), None, 1.0).map(|r| r.0).unwrap_or(0);
        let mut before = Vec::new();
        for t in [5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0] {
            before.extend(answers(&link.tick(t)));
        }
        assert!(before.is_empty(), "nothing before the link is dead: {before:?}");
        let out = link.tick(45.0);
        assert_eq!(answers(&out), vec![(id, Err(LinkError::Down))]);
        assert_eq!(downs(&out), vec![(1, "chrome:P1".into(), "no word for 40 s".into())]);
    }

    #[test]
    fn an_old_copys_tock_without_a_seq_is_life_only() {
        let mut link = linked();
        link.request(1, "x", Object::new(), None, 1.0).map(|r| r.0).unwrap_or(0);
        let mut out = Vec::new();
        for t in (1..=30).map(|n| f64::from(n) * 5.0) {
            out.extend(link.tick(t));
            out.extend(link.on_text(1, r#"{"k":"tock","at":1}"#, t + 0.1));
        }
        assert!(answers(&out).is_empty(), "never lost, never timed out: {:?}", answers(&out));
        assert!(sends(&out).iter().all(|(_, m)| m["k"] == "tick"), "never sent again");
        assert!(link.is_up(1) && link.connection("chrome:P1").map(Connection::waiting) == Some(1));
    }

    #[test]
    fn cancel_ends_a_request_with_no_answer_and_tells_the_copy() {
        let mut link = linked();
        let id = link.request(1, "hostShow", Object::new(), Some(4), 1.0).map(|r| r.0).unwrap_or(0);
        let Some(Action::Send { conn: 1, text }) = link.cancel(1, id) else { panic!("a cancel sent") };
        assert_eq!(serde_json::from_str::<Value>(&text).ok(), Some(json!({"k":"cancel","id":id})));
        assert_eq!(link.connection("chrome:P1").map(Connection::waiting), Some(0), "no longer waiting");
        let late = link.on_text(1, &format!(r#"{{"k":"reply","id":{id},"ok":true}}"#), 3.0);
        assert!(late.is_empty(), "a later reply: dropped");
        assert_eq!(link.cancel(1, id), None, "once: nothing waits for it now");
        assert_eq!(link.cancel(9, 1), None, "no such link");
        let id2 = link.request(1, "x", Object::new(), None, 3.0).map(|r| r.0).unwrap_or(0);
        assert_eq!(
            answers(&link.on_closed(1, "gone", 4.0)),
            vec![(id2, Err(LinkError::Down))],
            "the cancelled one: no Down"
        );
    }

    #[test]
    fn a_request_the_copy_read_past_without_taking_is_sent_again_then_lost() {
        let mut link = linked();
        let Ok((id, Action::Send { text: first, .. })) = link.request(1, "hostShow", Object::new(), None, 1.0) else {
            panic!("a request")
        };
        let ticks = sends(&link.tick(5.0));
        assert_eq!(ticks, vec![(1, json!({"k":"tick","at":5000,"seq":1}))], "ticks carry a number");
        let out = link.on_text(1, r#"{"k":"tock","at":5100,"seq":1}"#, 5.1);
        let again = serde_json::from_str::<Value>(&first).unwrap_or(Value::Null);
        assert_eq!(sends(&out), vec![(1, again)], "sent once more, the same id");
        assert!(logged(&out, &format!("chrome:P1: request {id} (hostShow) read past without being taken: sent again")));
        assert!(answers(&out).is_empty());
        let out = link.on_text(1, r#"{"k":"tock","at":5200,"seq":1}"#, 5.2);
        assert!(out.is_empty(), "a tock of a tick sent before the second send: nothing yet");
        link.tick(10.0);
        let out = link.on_text(1, r#"{"k":"tock","at":10100,"seq":2}"#, 10.1);
        assert_eq!(answers(&out), vec![(id, Err(LinkError::Lost))], "lost a second time: Lost");
        assert!(logged(&out, &format!("chrome:P1: request {id} (hostShow) lost twice")));
        assert_eq!(link.connection("chrome:P1").map(Connection::waiting), Some(0));
    }

    #[test]
    fn an_acked_request_waits_for_its_reply_through_later_tocks() {
        let mut link = linked();
        let id = link.request(1, "x", Object::new(), None, 1.0).map(|r| r.0).unwrap_or(0);
        let acked = link.on_text(1, &format!(r#"{{"k":"ack","id":{id}}}"#), 1.1);
        assert!(acked.is_empty(), "an ack is the link's own: not passed on");
        assert!(link.on_text(1, r#"{"k":"ack","id":99}"#, 1.1).is_empty(), "one for nothing waiting: left");
        let mut out = Vec::new();
        for n in 1..=4 {
            let t = f64::from(n) * 5.0;
            out.extend(link.tick(t));
            out.extend(link.on_text(1, &format!(r#"{{"k":"tock","at":1,"seq":{n}}}"#), t + 0.1));
        }
        assert!(answers(&out).is_empty(), "not lost");
        assert!(sends(&out).iter().all(|(_, m)| m["k"] == "tick"), "never sent again");
        let out = link.on_text(1, &format!(r#"{{"k":"reply","id":{id},"ok":true}}"#), 21.0);
        assert_eq!(answers(&out).len(), 1);
    }

    #[test]
    fn a_slow_reply_is_said_with_when_it_was_acked() {
        // (Where a slow request's time went, for the app's log: read late (acked late), or worked on long.)
        let lines = |out: &[Action]| -> Vec<String> {
            out.iter()
                .filter_map(|a| if let Action::Log { text, .. } = a { Some(text.clone()) } else { None })
                .collect()
        };
        let mut link = linked();
        let id = link.request(1, "hostShow", Object::new(), None, 1.0).map(|r| r.0).unwrap_or(0);
        link.on_text(1, &format!(r#"{{"k":"ack","id":{id}}}"#), 1.25);
        let out = link.on_text(1, &format!(r#"{{"k":"reply","id":{id},"ok":true}}"#), 1.3);
        let said = lines(&out);
        assert_eq!(said.len(), 1, "{said:?}");
        assert!(
            said[0].ends_with(&format!("request {id} (hostShow) answered in 300 ms (acked at 250 ms)")),
            "{said:?}"
        );
        assert_eq!(answers(&out).len(), 1);
        // A quick one: nothing said.
        let id = link.request(1, "hostShow", Object::new(), None, 2.0).map(|r| r.0).unwrap_or(0);
        link.on_text(1, &format!(r#"{{"k":"ack","id":{id}}}"#), 2.01);
        let out = link.on_text(1, &format!(r#"{{"k":"reply","id":{id},"ok":true}}"#), 2.05);
        assert!(lines(&out).is_empty());
        // An older copy's (no ack): said so.
        let id = link.request(1, "x", Object::new(), None, 3.0).map(|r| r.0).unwrap_or(0);
        let out = link.on_text(1, &format!(r#"{{"k":"reply","id":{id},"ok":true}}"#), 3.2);
        assert!(lines(&out)[0].ends_with("answered in 200 ms (not acked)"), "{:?}", lines(&out));
    }

    #[test]
    fn slow_is_the_oldest_unacked_requests_age() {
        let mut link = linked();
        assert_eq!(link.slow(1, 1.0), None, "nothing waiting");
        let a = link.request(1, "x", Object::new(), None, 2.0).map(|r| r.0).unwrap_or(0);
        let b = link.request(1, "y", Object::new(), None, 4.0).map(|r| r.0).unwrap_or(0);
        assert_eq!(link.slow(1, 10.0), Some(8.0));
        link.on_text(1, &format!(r#"{{"k":"ack","id":{a}}}"#), 10.0);
        assert_eq!(link.slow(1, 10.0), Some(6.0), "the oldest not acked");
        link.on_text(1, &format!(r#"{{"k":"ack","id":{b}}}"#), 10.0);
        assert_eq!(link.slow(1, 12.0), None, "acked, only its answer to come: not slow");
        let c = link.request(1, "z", Object::new(), None, 12.0).map(|r| r.0).unwrap_or(0);
        link.cancel(1, c);
        assert_eq!(link.slow(1, 20.0), None, "a cancelled one isn't waited for");
        assert_eq!(link.slow(9, 20.0), None, "no such link");
    }

    #[test]
    fn each_link_numbers_its_ticks() {
        let mut link = linked();
        link.on_open(2, 1.0);
        link.on_text(2, &hello("P2", "B"), 1.0);
        let seqs = |out: &[Action], conn: ConnId| -> Vec<Value> {
            sends(out).into_iter().filter(|(c, _)| *c == conn).map(|(_, m)| m["seq"].clone()).collect()
        };
        let a = link.tick(5.0);
        let b = link.tick(10.0);
        assert_eq!((seqs(&a, 1), seqs(&b, 1)), (vec![json!(1)], vec![json!(2)]));
        assert_eq!((seqs(&a, 2), seqs(&b, 2)), (vec![json!(1)], vec![json!(2)]), "its own count");
    }

    #[test]
    fn requests_and_sends_on_a_link_down() {
        let mut link = linked();
        let id = link.request(1, "x", Object::new(), None, 1.0).map(|r| r.0).unwrap_or(0);
        let out = link.on_closed(1, "the relay went", 2.0);
        assert_eq!(answers(&out), vec![(id, Err(LinkError::Down))]);
        assert_eq!(downs(&out), vec![(1, "chrome:P1".into(), "the relay went".into())]);
        assert!(logged(&out, "link down (chrome:P1): the relay went"));
        assert_eq!(link.request(1, "x", Object::new(), None, 2.0).map(|r| r.0), Err(LinkError::Down));
        assert_eq!(link.send(1, &AppMessage::Tick { seq: 1 }, 2.0), Err(LinkError::Down));
        assert!(link.on_closed(1, "again", 2.0).is_empty());
    }

    #[test]
    fn nothing_over_1_mb_is_sent() {
        let mut link = linked();
        let big = json!({"big": "x".repeat(MAX_APP_MESSAGE)}).as_object().cloned().unwrap_or_default();
        assert_eq!(link.request(1, "x", big.clone(), None, 1.0).map(|r| r.0), Err(LinkError::NotJson));
        assert_eq!(link.request(1, "x", Object::new(), None, 1.0).map(|r| r.0), Ok(2), "the refused one took its id");
        let data = AppMessage::Data { kind: "data.snapshot".into(), body: big };
        assert_eq!(link.send(1, &data, 1.0), Err(LinkError::NotJson));
        assert_eq!(link.connection("chrome:P1").map(Connection::refused), Some(1));
        assert!(link.send(1, &AppMessage::Resync { epoch: "ep-A".into() }, 1.0).is_ok());
    }

    #[test]
    fn bye_is_passed_on_then_closed() {
        let mut link = linked();
        let out = link.on_text(1, r#"{"k":"bye","why":"updating"}"#, 1.0);
        let received = out
            .iter()
            .position(|a| matches!(a, Action::Received { message: LinkMessage::Bye { why }, .. } if why == "updating"));
        let down = out.iter().position(|a| matches!(a, Action::Down { .. }));
        assert!(received.is_some() && down.is_some() && received < down, "the bye before the link goes down");
        assert_eq!(closes(&out), vec![(1, 1000, "bye".into())]);
        assert_eq!(downs(&out), vec![(1, "chrome:P1".into(), "bye".into())]);
        assert!(logged(&out, "chrome:P1 said goodbye: updating"));
    }

    #[test]
    fn messages_after_hello_are_passed_on() {
        let mut link = linked();
        for text in [
            r#"{"k":"snapshot","epoch":"ep-A","seq":1,"state":{}}"#,
            r#"{"k":"data.hello","epoch":"ep-A","format":1}"#,
            r#"{"k":"keys","epoch":"ep-A","bindings":{}}"#,
            r#"{"k":"later"}"#,
        ] {
            let out = link.on_text(1, text, 1.0);
            assert!(matches!(&out[..], [Action::Received { conn: 1, key, .. }] if key == "chrome:P1"), "{text}");
        }
    }

    #[test]
    fn what_isnt_a_message_or_comes_before_hello_is_left() {
        let mut link = Link::new(Timing::default(), "K".into());
        link.on_open(1, 0.0);
        let out = link.on_text(1, "{not json", 1.0);
        assert!(logged(&out, "not a link message ({not json)"));
        let out = link.on_text(1, r#"{"k":"snapshot","epoch":"e","seq":1,"state":{}}"#, 1.0);
        assert!(logged(&out, "a message before hello: left"));
        assert!(closes(&out).is_empty(), "not closed (as the Swift)");
        assert!(link.on_text(9, &hello("P1", "A"), 1.0).is_empty(), "a connection never opened: left");
        link.on_text(1, &hello("P1", "A"), 1.0);
        let out = link.on_text(1, &hello("P1", "A"), 2.0);
        assert!(logged(&out, "a second hello on one socket: left"));
        assert_eq!(ups(&out), 0);
        assert!(link.is_up(1));
    }

    #[test]
    fn a_message_over_64_mb_closes() {
        let mut link = linked();
        let big = "x".repeat(MAX_INCOMING + 1);
        let out = link.on_text(1, &big, 1.0);
        assert_eq!(closes(&out).first().map(|c| c.1), Some(1002));
        assert_eq!(downs(&out).len(), 1);
    }

    #[test]
    fn a_connection_ending_before_hello() {
        let mut link = Link::new(Timing::default(), "K".into());
        link.on_open(1, 0.0);
        let out = link.on_closed(1, "the relay went", 0.25);
        assert!(logged(&out, "socket ended before its hello (after the upgrade, 250.0 ms): the relay went"));
        assert!(downs(&out).is_empty());
        assert_eq!(link.next_deadline(), None);
    }

    #[test]
    fn the_app_closing_a_link() {
        let mut link = linked();
        let out = link.close(1, 1000, "done", 1.0);
        assert_eq!(closes(&out), vec![(1, 1000, "done".into())]);
        assert_eq!(downs(&out), vec![(1, "chrome:P1".into(), "done".into())]);
        assert!(link.close(1, 1000, "done", 1.0).is_empty(), "once");
    }

    #[test]
    fn stopping_says_bye_and_closes() {
        let mut link = linked();
        link.on_open(2, 1.0);
        let id = link.request(1, "x", Object::new(), None, 1.0).map(|r| r.0).unwrap_or(0);
        let out = link.stop("Margin quit", 2.0);
        assert_eq!(sends(&out), vec![(1, json!({"k":"bye","why":"Margin quit"}))]);
        assert_eq!(closes(&out), vec![(2, 1001, "Margin quit".into()), (1, 1001, "Margin quit".into())]);
        assert_eq!(downs(&out), vec![(1, "chrome:P1".into(), "stopped: Margin quit".into())]);
        assert_eq!(answers(&out), vec![(id, Err(LinkError::Down))]);
        assert!(link.is_stopped() && link.connections().next().is_none());
        assert_eq!(closes(&link.on_open(3, 3.0)), vec![(3, 1001, "stopped".into())], "nothing taken after");
        assert!(link.tick(100.0).is_empty());
        assert!(link.stop("again", 3.0).is_empty());
    }

    #[test]
    fn a_connection_opened_twice_is_left() {
        let mut link = linked();
        let out = link.on_open(1, 1.0);
        assert!(sends(&out).is_empty());
        assert!(link.is_up(1));
    }
}
