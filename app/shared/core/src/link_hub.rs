//! The app's end of every link, whole, for a shell that isn't margin-core's own (Margin.app's Swift, through
//! margin-ffi's link object; the Windows shell joins the same parts itself in [`crate::shell`]): the copies'
//! WebSockets ([`SocketLink`]), Chrome's and Edge's relays ([`RelayHub`]) and Safari's way in, joined as
//! ExtensionLink.swift and RelayLink.swift joined them, with each link's theme pieces put together
//! ([`ChunkAssembler`]). Sans IO: the caller passes in bytes, connections opened and ended, its listener's port,
//! Safari's notification and the time, and carries out each [`HubOut`] in order.
//!
//! What the caller keeps (the Mac's transport): the listener (127.0.0.1 only, no Nagle, made again 1 s after it
//! fails, on a new port after 5 s waiting), the relays' Unix socket and who may connect to it (this user's
//! processes, Margin's signed relay), `SFSafariApplication.dispatchMessage` ([`HubOut::Safari`]) and its refusals
//! (BundleWatch, from [`HubOut::Refused`]), the notification it listens for, the link note's file
//! ([`HubOut::Note`]), one timer at [`LinkHub::next_deadline`], and stop's short wait for what's written.
//!
//! Routing kept from the Swift: a `link` for a relay's `wantLink` goes into that browser process's relays ("no
//! relay of BROWSER (pid N)" when there's none), Safari's into Safari; each dispatch's fate said once
//! ([`SocketLink::dispatched`]); a theme piece of another epoch than its link's is left, the others put together
//! per link (a new link starts over), the whole handed on once it adds up ([`HubOut::Theme`]) or why not
//! ([`HubOut::ThemeRefused`], logged "KEY: a theme refused: WHY"); a message the link refuses to send is logged
//! "not sent to KEY: not JSON, or over 1000000 bytes".
//!
//! Each link's state is mirrored here ([`StateMirror`], one per link, begun at its hello): a snapshot, a delta or a
//! window list is applied as it's read and the caller told only what it did ([`HubOut::State`]: its keys, the windows
//! when they changed, never the values again); the caller reads a value when it needs one ([`LinkHub::mirror`]). A
//! number missed is logged "KEY: number N came, M was next: the state asked for again" and a `resync` sent at once and
//! every 2 s while the snapshot hasn't come ([`Resync`], at [`LinkHub::next_deadline`]), as Shell.swift's timer did.

use std::collections::BTreeMap;

use crate::chunks::{ChunkAssembler, Outcome};
use crate::json::Object;
use crate::link::{Action, ConnId, Level, LinkError, Timing};
use crate::mirror::{self, Resync, StateMirror};
use crate::protocol::{AppMessage, Hello, LinkMessage, MAX_APP_MESSAGE};
use crate::relay::{RelayHub, RelayOut};
use crate::socket::{Out, SocketLink};
use crate::time::Secs;

/// Which of the caller's connections: a copy's TCP connection, or a relay's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Tcp,
    Relay,
}

/// Which state message a [`StateApplied`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateKind {
    Snapshot,
    Delta,
    Windows,
}

impl StateKind {
    pub fn name(self) -> &'static str {
        match self {
            StateKind::Snapshot => "snapshot",
            StateKind::Delta => "delta",
            StateKind::Windows => "windows",
        }
    }
}

/// What a state message did to its link's mirror.
#[derive(Clone, Debug, PartialEq)]
pub struct StateApplied {
    pub kind: StateKind,
    pub epoch: String,
    pub seq: i64,
    pub outcome: mirror::Outcome,
    /// The keys it carried, sorted: a snapshot's state's, a delta's changes' (`favicons` among them only as a key a
    /// delta named, which is left: icons go as their diff); a window list's none.
    pub keys: Vec<String>,
    /// The windows as the mirror has them now, when this changed them (a snapshot or a window list applied).
    pub windows: Option<Vec<Object>>,
    /// The mirror after it: a snapshot has come this epoch; a number missed and the snapshot not come yet.
    pub has_state: bool,
    pub resyncing: bool,
}

/// What the caller does, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum HubOut {
    /// These bytes on that connection.
    Write {
        which: Which,
        conn: ConnId,
        bytes: Vec<u8>,
    },
    /// Close that connection: a TCP one once what was written before has gone (then say it ended), a relay's at once.
    End {
        which: Which,
        conn: ConnId,
    },
    /// `SFSafariApplication.dispatchMessage(name, userInfo: { e: info })` into Safari's extension; then say whether
    /// it got there ([`LinkHub::dispatched`] with `n`).
    Safari {
        name: String,
        info: Object,
        n: u64,
    },
    /// The link note now, or none ([`crate::socket::Out::Note`]).
    Note(Option<Object>),
    /// `appUp`'s wait is over: [`LinkHub::say_app_up`] again with how long Safari has run.
    AppUpDue,
    /// `linkUp`: a copy said hello.
    Up {
        conn: ConnId,
        hello: Hello,
    },
    /// A snapshot, a delta or a window list, applied to the link's mirror (or not: [`StateApplied::outcome`]).
    State {
        conn: ConnId,
        key: String,
        applied: StateApplied,
    },
    /// `linkReceived`: everything after hello but replies, tocks, theme pieces and the state.
    Received {
        conn: ConnId,
        key: String,
        message: LinkMessage,
    },
    /// A theme package put together from its pieces: its id and its bytes (the UTF-8 JSON of the whole).
    Theme {
        conn: ConnId,
        key: String,
        epoch: String,
        id: String,
        data: Vec<u8>,
    },
    /// A theme's pieces not taken (already logged).
    ThemeRefused {
        conn: ConnId,
        key: String,
        why: String,
    },
    /// `linkDown`.
    Down {
        conn: ConnId,
        key: String,
        why: String,
    },
    /// A request's answer: the reply's body, or why none.
    Answer {
        conn: ConnId,
        id: i64,
        answer: Result<Object, LinkError>,
    },
    /// A dispatch not passed on, and why (`onDispatchRefused`: BundleWatch checks whether the app was replaced).
    Refused {
        name: String,
        why: String,
    },
    Log {
        level: Level,
        text: String,
    },
}

/// `SocketLink` with its relays, as the Mac's Swift had them.
#[derive(Clone, Debug)]
pub struct LinkHub {
    link: SocketLink,
    relays: RelayHub,
    themes: BTreeMap<ConnId, ChunkAssembler>,
    /// Each link's state and its resync timer.
    mirrors: BTreeMap<ConnId, (StateMirror, Resync)>,
    resync_retry: Secs,
    wall: Secs,
}

impl LinkHub {
    /// `version`: the app's (the `link`'s `app.version`, the note's, the relays' welcome).
    pub fn new(timing: Timing, version: &str) -> Self {
        Self::with_link(SocketLink::new(timing, version), version)
    }

    /// Over a link made by the caller (the tests' secrets).
    pub fn with_link(link: SocketLink, version: &str) -> Self {
        Self {
            link,
            relays: RelayHub::new(version),
            themes: BTreeMap::new(),
            mirrors: BTreeMap::new(),
            resync_retry: Resync::RETRY,
            wall: 0.0,
        }
    }

    pub fn link(&self) -> &SocketLink {
        &self.link
    }

    pub fn link_mut(&mut self) -> &mut SocketLink {
        &mut self.link
    }

    pub fn relays(&self) -> &RelayHub {
        &self.relays
    }

    /// A link's state, as its copy last sent it (from its hello on).
    pub fn mirror(&self, conn: ConnId) -> Option<&StateMirror> {
        self.mirrors.get(&conn).map(|(m, _)| m)
    }

    /// The resync's retry (2 s; the tests' shorter): links that say hello after this take it.
    pub fn set_resync_retry(&mut self, retry: Secs) {
        if retry.is_finite() && retry > 0.0 {
            self.resync_retry = retry;
        }
    }

    /// The relays' welcome says this version (the Mac's `CFBundleVersion`; set before the first relay connects).
    pub fn set_relay_version(&mut self, version: &str) {
        if self.relays.connected() == 0 {
            self.relays = RelayHub::new(version);
        }
    }

    /// `now` plus this is the wall clock's time: every `at` the links and relays stamp.
    pub fn set_wall_offset(&mut self, offset: Secs) {
        self.wall = if offset.is_finite() { offset } else { 0.0 };
        self.link.set_wall_offset(self.wall);
    }

    pub fn next_deadline(&self) -> Option<Secs> {
        let resync = self.mirrors.values().filter_map(|(_, r)| r.due_at());
        self.link.next_deadline().into_iter().chain(resync).reduce(Secs::min)
    }

    // ---- what the caller says ----

    pub fn listening(&mut self, port: Option<u16>, now: Secs) -> Vec<HubOut> {
        let outs = self.link.listening(port, now);
        self.route(outs, now)
    }

    /// Safari's notification, its JSON.
    pub fn woken(&mut self, json: Option<&str>, now: Secs) -> Vec<HubOut> {
        let outs = self.link.woken(json, now);
        self.route(outs, now)
    }

    /// `sayAppUp`: `running_for`, how long Safari has been running (`None`: it isn't).
    pub fn say_app_up(&mut self, running_for: Option<Secs>, now: Secs) -> Vec<HubOut> {
        let outs = self.link.say_app_up(running_for, now);
        self.route(outs, now)
    }

    /// What became of Safari's dispatch `n`: `None` once Safari took it, else why not.
    pub fn dispatched(&mut self, name: &str, n: u64, why: Option<&str>) -> Vec<HubOut> {
        let mut out = Vec::new();
        let outs = self.link.dispatched(name, n, why);
        self.carry(outs, 0.0, &mut out);
        if let Some(why) = why {
            out.push(HubOut::Refused { name: name.to_owned(), why: why.to_owned() });
        }
        out
    }

    pub fn tcp_accept(&mut self, conn: ConnId, now: Secs) -> Vec<HubOut> {
        let outs = self.link.on_accept(conn, now);
        self.route(outs, now)
    }

    pub fn tcp_bytes(&mut self, conn: ConnId, data: &[u8], now: Secs) -> Vec<HubOut> {
        let outs = self.link.on_bytes(conn, data, now);
        self.route(outs, now)
    }

    pub fn tcp_ended(&mut self, conn: ConnId, error: Option<&str>, now: Secs) -> Vec<HubOut> {
        let outs = self.link.on_ended(conn, error, now);
        self.route(outs, now)
    }

    pub fn relay_open(&mut self, conn: ConnId) {
        self.relays.on_open(conn);
    }

    pub fn relay_bytes(&mut self, conn: ConnId, data: &[u8], now: Secs) -> Vec<HubOut> {
        let outs = self.relays.on_bytes(conn, data, now + self.wall);
        let mut out = Vec::new();
        self.relay_outs(outs, now, &mut out);
        out
    }

    pub fn relay_ended(&mut self, conn: ConnId) {
        self.relays.on_ended(conn);
    }

    pub fn tick(&mut self, now: Secs) -> Vec<HubOut> {
        let outs = self.link.tick(now);
        let mut out = self.route(outs, now);
        // Resyncs due again (the snapshot asked for not come yet).
        let due: Vec<(ConnId, String)> = self
            .mirrors
            .iter_mut()
            .filter_map(|(conn, (m, r))| r.tick(now, m).then(|| (*conn, m.epoch().unwrap_or_default().to_owned())))
            .collect();
        for (conn, epoch) in due {
            self.resync(conn, epoch, now, &mut out);
        }
        out
    }

    /// A `resync` to that link (nothing if it can't go: the link is going).
    fn resync(&mut self, conn: ConnId, epoch: String, now: Secs, out: &mut Vec<HubOut>) {
        if let Ok(bytes) = self.link.send(conn, &AppMessage::Resync { epoch }, now) {
            out.push(HubOut::Write { which: Which::Tcp, conn, bytes });
        }
    }

    /// A state message applied to its link's mirror: what it did, said; a number missed, logged and the state asked
    /// for again.
    fn mirrored(&mut self, conn: ConnId, key: String, message: &LinkMessage, now: Secs, out: &mut Vec<HubOut>) {
        let Some((m, r)) = self.mirrors.get_mut(&conn) else { return };
        let (kind, epoch, seq, keys) = match message {
            LinkMessage::Snapshot { epoch, seq, state, .. } => {
                (StateKind::Snapshot, epoch, *seq, state.keys().cloned().collect::<Vec<_>>())
            }
            LinkMessage::Delta { epoch, seq, changes, .. } => {
                (StateKind::Delta, epoch, *seq, changes.keys().cloned().collect())
            }
            LinkMessage::Windows { epoch, seq, .. } => (StateKind::Windows, epoch, *seq, Vec::new()),
            _ => return,
        };
        let outcome = m.apply(message);
        let ask = r.after(outcome, now);
        let windows = (outcome == mirror::Outcome::Applied && kind != StateKind::Delta).then(|| m.windows().to_vec());
        let mut keys = keys;
        keys.sort();
        let applied = StateApplied {
            kind,
            epoch: epoch.clone(),
            seq,
            outcome,
            keys,
            windows,
            has_state: m.has_state(),
            resyncing: m.is_resyncing(),
        };
        let own_epoch = m.epoch().unwrap_or_default().to_owned();
        if let mirror::Outcome::Gap { expected, got } = outcome {
            let text = format!("{key}: number {got} came, {expected} was next: the state asked for again");
            out.push(HubOut::Log { level: Level::Warn, text });
        }
        if ask {
            self.resync(conn, own_epoch, now, out);
        }
        out.push(HubOut::State { conn, key, applied });
    }

    /// `LinkConnection.send`. A message refused for its size is logged and counted
    /// ([`crate::link::Connection::refused`]).
    pub fn send(&mut self, conn: ConnId, message: &AppMessage, now: Secs) -> (Result<(), LinkError>, Vec<HubOut>) {
        match self.link.send(conn, message, now) {
            Ok(bytes) => (Ok(()), vec![HubOut::Write { which: Which::Tcp, conn, bytes }]),
            Err(LinkError::NotJson) => {
                let key = self.link.link().connection_on(conn).map(|c| c.key()).unwrap_or_default();
                let text = format!("not sent to {key}: not JSON, or over {MAX_APP_MESSAGE} bytes");
                (Err(LinkError::NotJson), vec![HubOut::Log { level: Level::Warn, text }])
            }
            Err(e) => (Err(e), Vec::new()),
        }
    }

    /// `LinkConnection.request`: its id; the answer comes as [`HubOut::Answer`].
    pub fn request(
        &mut self,
        conn: ConnId,
        kind: &str,
        payload: Object,
        window_id: Option<i64>,
        now: Secs,
    ) -> (Result<i64, LinkError>, Vec<HubOut>) {
        match self.link.request(conn, kind, payload, window_id, now) {
            Ok((id, bytes)) => (Ok(id), vec![HubOut::Write { which: Which::Tcp, conn, bytes }]),
            Err(e) => (Err(e), Vec::new()),
        }
    }

    /// [`crate::link::Link::cancel`]: request `id` on `conn` no longer waited for (no answer comes for it), the copy
    /// told. False: nothing waited for it there.
    pub fn cancel(&mut self, conn: ConnId, id: i64) -> (bool, Vec<HubOut>) {
        match self.link.cancel(conn, id) {
            Some(bytes) => (true, vec![HubOut::Write { which: Which::Tcp, conn, bytes }]),
            None => (false, Vec::new()),
        }
    }

    /// [`crate::link::Link::slow`]: the age of the oldest request on `conn` its copy hasn't acked (for feedback only).
    pub fn slow(&self, conn: ConnId, now: Secs) -> Option<Secs> {
        self.link.slow(conn, now)
    }

    /// `LinkConnection.close`.
    pub fn close(&mut self, conn: ConnId, code: u16, why: &str, now: Secs) -> Vec<HubOut> {
        let outs = self.link.close(conn, code, why, now);
        self.route(outs, now)
    }

    /// `stop`: the relays closed, then every socket (each link told `bye`).
    pub fn stop(&mut self, why: &str, now: Secs) -> Vec<HubOut> {
        let mut out = Vec::new();
        let relays = self.relays.stop();
        self.relay_outs(relays, now, &mut out);
        let outs = self.link.stop(why, now);
        self.carry(outs, now, &mut out);
        out
    }

    // ---- routing ----

    fn route(&mut self, outs: Vec<Out>, now: Secs) -> Vec<HubOut> {
        let mut out = Vec::new();
        self.carry(outs, now, &mut out);
        out
    }

    fn carry(&mut self, outs: Vec<Out>, now: Secs, out: &mut Vec<HubOut>) {
        for o in outs {
            match o {
                Out::Write { conn, bytes } => out.push(HubOut::Write { which: Which::Tcp, conn, bytes }),
                Out::End { conn } => out.push(HubOut::End { which: Which::Tcp, conn }),
                Out::Dispatch { to, name, info, n } if to.is_safari() => out.push(HubOut::Safari { name, info, n }),
                Out::Dispatch { to, name, info, n } => {
                    let (relays, sent) = self.relays.dispatch(&name, &info, to.pid);
                    self.relay_outs(relays, now, out);
                    let why = (!sent).then(|| format!("no relay of {} (pid {})", to.browser, to.pid));
                    let said = self.link.dispatched(&name, n, why.as_deref());
                    self.carry(said, now, out);
                    if let Some(why) = why {
                        out.push(HubOut::Refused { name, why });
                    }
                }
                Out::Note(note) => out.push(HubOut::Note(note)),
                Out::AppUpDue => out.push(HubOut::AppUpDue),
                Out::Log { level, text } => out.push(HubOut::Log { level, text }),
                Out::Link(a) => self.session(a, now, out),
            }
        }
    }

    fn relay_outs(&mut self, outs: Vec<RelayOut>, now: Secs, out: &mut Vec<HubOut>) {
        for o in outs {
            match o {
                RelayOut::Write { conn, bytes } => out.push(HubOut::Write { which: Which::Relay, conn, bytes }),
                RelayOut::End { conn } => out.push(HubOut::End { which: Which::Relay, conn }),
                RelayOut::WantLink { nonce, via } => {
                    let outs = self.link.want_link(&nonce, via, now);
                    self.carry(outs, now, out);
                }
                RelayOut::Log { level, text } => out.push(HubOut::Log { level, text }),
            }
        }
    }

    fn session(&mut self, a: Action, now: Secs, out: &mut Vec<HubOut>) {
        match a {
            Action::Up { conn, hello } => {
                self.themes.insert(conn, ChunkAssembler::default());
                let mut m = StateMirror::new();
                m.begin(&hello);
                self.mirrors.insert(conn, (m, Resync::new(self.resync_retry)));
                out.push(HubOut::Up { conn, hello });
            }
            Action::Received { conn, key, message: LinkMessage::Theme { epoch, chunk } } => {
                // (Shell.swift: a piece of another epoch than its link's is left.)
                if self.link.link().connection_on(conn).is_none_or(|c| c.epoch() != epoch) {
                    return;
                }
                let Some(assembler) = self.themes.get_mut(&conn) else { return };
                match assembler.add(&chunk) {
                    Outcome::Waiting { .. } => {}
                    Outcome::Complete { id, data } => out.push(HubOut::Theme { conn, key, epoch, id, data }),
                    Outcome::Refused(why) => {
                        out.push(HubOut::Log { level: Level::Warn, text: format!("{key}: a theme refused: {why}") });
                        out.push(HubOut::ThemeRefused { conn, key, why });
                    }
                }
            }
            Action::Received {
                conn,
                key,
                message:
                    message @ (LinkMessage::Snapshot { .. } | LinkMessage::Delta { .. } | LinkMessage::Windows { .. }),
            } => self.mirrored(conn, key, &message, now, out),
            Action::Received { conn, key, message } => out.push(HubOut::Received { conn, key, message }),
            Action::Down { conn, key, why } => {
                self.themes.remove(&conn);
                self.mirrors.remove(&conn);
                out.push(HubOut::Down { conn, key, why });
            }
            Action::Answer { conn, id, answer, .. } => out.push(HubOut::Answer { conn, id, answer }),
            Action::Log { level, text } => out.push(HubOut::Log { level, text }),
            // (The socket link writes these itself.)
            Action::Send { .. } | Action::Close { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunks;
    use crate::websocket::{client_frame, server_frames};
    use serde_json::{Value, json};

    const TOKEN: &str = "t0k3n";
    const KEY: &str = "k3y";

    fn hub() -> LinkHub {
        let link = SocketLink::with_secrets(Timing::default(), "1.2", TOKEN.into(), KEY.into());
        let mut h = LinkHub::with_link(link, "7");
        h.link_mut().publish_notes(4242);
        h
    }

    fn copy_request() -> Vec<u8> {
        format!(
            "GET /?t={TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: safari-web-extension://ABC\r\n\r\n"
        )
        .into_bytes()
    }

    fn frame(v: Value) -> Vec<u8> {
        client_frame(1, v.to_string().as_bytes(), true)
    }

    fn hello(browser: &str, profile: &str, epoch: &str) -> Vec<u8> {
        frame(json!({"k":"hello","v":2,"epoch":epoch,"profile":profile,"browser":browser,"owner":true}))
    }

    fn line(v: Value) -> Vec<u8> {
        let mut b = v.to_string().into_bytes();
        b.push(b'\n');
        b
    }

    fn logged(out: &[HubOut], text: &str) -> bool {
        out.iter().any(|o| matches!(o, HubOut::Log { text: t, .. } if t.contains(text)))
    }

    fn texts(out: &[HubOut], which: Which, conn: ConnId) -> Vec<Value> {
        let bytes: Vec<u8> = out
            .iter()
            .filter_map(|o| match o {
                HubOut::Write { which: w, conn: c, bytes } if *w == which && *c == conn => Some(bytes.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        match which {
            Which::Relay => bytes
                .split(|&b| b == b'\n')
                .filter(|l| !l.is_empty())
                .filter_map(|l| serde_json::from_slice(l).ok())
                .collect(),
            Which::Tcp => {
                let after = match bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    Some(i) if bytes.starts_with(b"HTTP/1.1 101") => &bytes[i + 4..],
                    _ => &bytes[..],
                };
                server_frames(after)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|f| f.0 == 1)
                    .filter_map(|f| serde_json::from_slice(&f.1).ok())
                    .collect()
            }
        }
    }

    /// A Safari copy linked on connection 1 at time 0.
    fn linked() -> LinkHub {
        let mut h = hub();
        h.listening(Some(5555), 0.0);
        h.tcp_accept(1, 0.0);
        h.tcp_bytes(1, &copy_request(), 0.0);
        let out = h.tcp_bytes(1, &hello("safari", "P1", "e1"), 0.0);
        assert!(out.iter().any(|o| matches!(o, HubOut::Up { conn: 1, .. })));
        h
    }

    #[test]
    fn the_note_as_the_port_and_secrets_change() {
        let mut h = hub();
        h.set_wall_offset(1000.0);
        let out = h.listening(Some(5555), 1.5);
        let note = out.iter().find_map(|o| if let HubOut::Note(n) = o { Some(n.clone()) } else { None });
        assert_eq!(
            note.flatten().map(Value::Object),
            Some(json!({"v":2,"port":5555,"token":TOKEN,"key":KEY,"app":{"version":"1.2"},"pid":4242,"at":1_001_500})),
            "written as the listener gets its port, its at the wall clock's"
        );
        assert!(logged(&out, "listening on 127.0.0.1:5555"));
        assert_eq!(
            h.listening(None, 2.0),
            vec![HubOut::Note(None)],
            "no port: removed (failed, cancelled, made again)"
        );
        h.listening(Some(6000), 3.0);
        // The secrets changed 30 s after the last link: written again with the new ones.
        h.tcp_accept(1, 3.0);
        h.tcp_bytes(1, &copy_request(), 3.0);
        h.tcp_bytes(1, &hello("safari", "P1", "e1"), 3.0);
        h.tcp_ended(1, None, 4.0);
        let out = h.tick(34.0);
        let Some(HubOut::Note(Some(n))) = out.iter().find(|o| matches!(o, HubOut::Note(_))) else {
            panic!("a note at the rotation: {out:?}")
        };
        assert_eq!(n.get("port"), Some(&json!(6000)));
        assert_ne!(n.get("token"), Some(&json!(TOKEN)));
        assert_eq!(n.get("token").and_then(Value::as_str).map(str::len), Some(64));
        assert!(logged(&out, "token changed"));
        let out = h.stop("Margin.app quit", 35.0);
        assert!(out.contains(&HubOut::Note(None)), "stopped: removed");
        // Without notes asked for (Windows): never one.
        let mut quiet = LinkHub::new(Timing::default(), "1");
        assert!(!quiet.listening(Some(1), 0.0).iter().any(|o| matches!(o, HubOut::Note(_))));
    }

    #[test]
    fn safaris_want_link_is_answered_into_safari() {
        let mut h = hub();
        let held = h.woken(Some(r#"{"type":"wantLink","nonce":"n1"}"#), 1.0);
        assert!(held.is_empty(), "no port yet: held");
        let out = h.listening(Some(5555), 2.0);
        let Some(HubOut::Safari { name, info, n }) = out.iter().find(|o| matches!(o, HubOut::Safari { .. })) else {
            panic!("dispatched into Safari: {out:?}")
        };
        assert_eq!((name.as_str(), *n), ("link", 1));
        assert_eq!(info.get("nonce"), Some(&json!("n1")));
        assert_eq!(info.get("port"), Some(&json!(5555)));
        assert!(logged(&out, "wantLink: link handed to Safari (port 5555, #1)"));
        assert!(
            h.woken(Some(r#"{"type":"wantLink"}"#), 2.0)
                .iter()
                .any(|o| matches!(o, HubOut::Log { level: Level::Warn, text } if text == "wantLink without a nonce"))
        );
        assert!(logged(
            &h.woken(Some(&json!({"type":"wantLink","nonce":"x".repeat(129)}).to_string()), 2.0),
            "wantLink without a nonce"
        ));
        assert!(h.woken(Some(r#"{"type":"other","nonce":"n"}"#), 2.0).is_empty(), "not a wantLink: left");
        assert!(h.woken(Some("not json"), 2.0).is_empty());
        assert!(h.woken(None, 2.0).is_empty());
        // Its fate: said once Safari answers; a refusal counted, and passed on for BundleWatch.
        assert!(logged(&h.dispatched("link", 1, None), "link #1 reached the extension"));
        let out = h.dispatched("link", 2, Some("SFErrorDomain 1"));
        assert!(logged(&out, "link #2 not passed on: SFErrorDomain 1"));
        assert_eq!(out.last(), Some(&HubOut::Refused { name: "link".into(), why: "SFErrorDomain 1".into() }));
        assert!(logged(&h.dispatched("link", 3, Some("SFErrorDomain 1")), "(2 in a row)"));
        assert_eq!(h.link().refused_in_a_row(), 2);
    }

    #[test]
    fn app_up_once_safari_has_run_2_s() {
        let mut h = hub();
        h.set_wall_offset(100.0);
        assert!(h.say_app_up(None, 10.0).is_empty(), "Safari not running: nothing");
        assert_eq!(h.next_deadline(), None);
        assert!(h.say_app_up(Some(0.5), 10.0).is_empty(), "running 0.5 s: wait");
        assert_eq!(h.next_deadline(), Some(11.5));
        assert!(h.tick(11.4).is_empty());
        assert_eq!(h.tick(11.5), vec![HubOut::AppUpDue], "the wait over, no link: look again");
        let out = h.say_app_up(Some(2.0), 11.5);
        let Some(HubOut::Safari { name, info, n }) = out.iter().find(|o| matches!(o, HubOut::Safari { .. })) else {
            panic!("appUp into Safari: {out:?}")
        };
        assert_eq!((name.as_str(), *n), ("appUp", 1));
        assert_eq!(Value::Object(info.clone()), json!({"v":2,"at":111_500}));
        assert!(logged(&out, "appUp handed to Safari (#1)"));
        // A hello meanwhile ends the wait.
        let mut h = hub();
        h.listening(Some(5555), 0.0);
        h.say_app_up(Some(0.0), 0.0);
        assert_eq!(h.next_deadline(), Some(2.0));
        h.tcp_accept(1, 0.5);
        h.tcp_bytes(1, &copy_request(), 0.5);
        h.tcp_bytes(1, &hello("safari", "P1", "e1"), 0.5);
        assert_eq!(h.next_deadline(), Some(5.5), "the ticker's, not appUp's");
        assert!(!h.tick(2.0).contains(&HubOut::AppUpDue));
        // Stopped: never.
        let mut h = hub();
        h.say_app_up(Some(1.0), 0.0);
        h.stop("quit", 0.5);
        assert!(h.say_app_up(Some(5.0), 1.0).is_empty());
        assert!(h.tick(5.0).is_empty());
    }

    #[test]
    fn a_relays_want_link_goes_into_its_browsers_relays() {
        let mut h = hub();
        h.set_wall_offset(50.0);
        h.listening(Some(5555), 0.0);
        h.relay_open(7);
        let out =
            h.relay_bytes(7, &line(json!({"k":"relay","v":1,"version":"7","pid":42,"browser":"edge","waited":1})), 1.0);
        let said = texts(&out, Which::Relay, 7);
        assert_eq!(said[0], json!({"k":"relayWelcome","v":1,"version":"7"}));
        assert_eq!(said[1]["name"], "appUp", "a relay that waited: told appUp (waited: 1 is true, as Swift read it)");
        let e: Value = serde_json::from_str(said[1]["userInfo"]["e"].as_str().unwrap_or("")).unwrap_or(Value::Null);
        assert_eq!(e, json!({"v":2,"at":51_000}), "its at the wall clock's");
        assert!(h.relays().heard_pid(42));
        let out = h.relay_bytes(7, &line(json!({"msg":{"type":"wantLink","nonce":"n1"}})), 2.0);
        let said = texts(&out, Which::Relay, 7);
        assert_eq!(said[0], json!({"ok":true,"appOpen":true,"launching":false,"browser":"edge","pid":42}));
        assert_eq!(said[1]["name"], "link");
        let info: Value = serde_json::from_str(said[1]["userInfo"]["e"].as_str().unwrap_or("")).unwrap_or(Value::Null);
        assert_eq!(info["nonce"], "n1");
        assert_eq!(info["port"], 5555);
        assert!(logged(&out, "wantLink: link handed to Edge (port 5555, #1)"));
        assert!(logged(&out, "link #1 reached the extension"));
        assert!(!out.iter().any(|o| matches!(o, HubOut::Safari { .. })), "never into Safari");
        // The relay gone: the next one has nowhere to go.
        h.relay_ended(7);
        assert!(h.relay_bytes(7, &line(json!({"msg":{"type":"ping"}})), 3.0).is_empty());
        let out = h.link_mut().want_link("n2", crate::socket::Via { pid: 42, browser: "edge".into() }, 3.0);
        let out = h.route(out, 3.0);
        assert!(logged(&out, "link #2 not passed on: no relay of edge (pid 42)"));
        assert_eq!(out.last(), Some(&HubOut::Refused { name: "link".into(), why: "no relay of edge (pid 42)".into() }));
    }

    #[test]
    fn a_links_theme_is_put_together() {
        let mut h = linked();
        let whole = br#"{"id":"arcadia","manifest":"{}","html":"","css":""}"#.repeat(20_000);
        let parts = chunks::split_with(&whole, "arcadia", 300_000, 8 << 20).unwrap_or_default();
        assert!(parts.len() >= 3);
        let theme = |epoch: &str, c: &crate::protocol::Chunk| {
            let mut o = c.fields();
            o.insert("k".into(), "theme".into());
            o.insert("epoch".into(), epoch.into());
            frame(Value::Object(o))
        };
        for p in &parts[..parts.len() - 1] {
            assert!(h.tcp_bytes(1, &theme("e1", p), 1.0).is_empty(), "waiting");
        }
        assert!(h.tcp_bytes(1, &theme("e0", &parts[0]), 1.0).is_empty(), "another epoch's piece: left, nothing lost");
        let out = h.tcp_bytes(1, &theme("e1", &parts[parts.len() - 1]), 1.0);
        assert_eq!(
            out,
            vec![HubOut::Theme {
                conn: 1,
                key: "safari:P1".into(),
                epoch: "e1".into(),
                id: "arcadia".into(),
                data: whole.clone()
            }]
        );
        let mut bad = parts[1].clone();
        bad.data = "not base64!".into();
        let out = h.tcp_bytes(1, &theme("e1", &bad), 2.0);
        assert!(logged(&out, "safari:P1: a theme refused: part 1 isn't base64"));
        assert!(out.iter().any(|o| matches!(o, HubOut::ThemeRefused { why, .. } if why == "part 1 isn't base64")));
        // A new link starts over.
        h.tcp_bytes(1, &theme("e1", &parts[0]), 3.0);
        h.tcp_accept(2, 3.0);
        h.tcp_bytes(2, &copy_request(), 3.0);
        h.tcp_bytes(2, &hello("safari", "P1", "e2"), 3.0);
        for p in &parts[1..] {
            assert!(!h.tcp_bytes(2, &theme("e2", p), 3.0).iter().any(|o| matches!(o, HubOut::Theme { .. })));
        }
    }

    #[test]
    fn messages_requests_and_what_isnt_sent() {
        let mut h = linked();
        let (sent, out) = h.send(1, &AppMessage::Drawn { epoch: "e1".into(), window_id: 3, on: true }, 1.0);
        assert_eq!(sent, Ok(()));
        let m = texts(&out, Which::Tcp, 1);
        assert_eq!(m[0]["k"], "drawn");
        let big = AppMessage::Data {
            kind: "data.changes".into(),
            body: json!({"x":"x".repeat(MAX_APP_MESSAGE)}).as_object().cloned().unwrap_or_default(),
        };
        let (sent, out) = h.send(1, &big, 1.0);
        assert_eq!(sent, Err(LinkError::NotJson));
        assert!(logged(&out, "not sent to safari:P1: not JSON, or over 1000000 bytes"));
        assert_eq!(h.link().link().connection_on(1).map(|c| c.refused()), Some(1));
        assert_eq!(h.send(9, &AppMessage::Tick { seq: 1 }, 1.0).0, Err(LinkError::Down));
        let (id, _) = h.request(1, "updateSettings", Object::new(), None, 1.0);
        assert_eq!(id, Ok(1));
        let out = h.tcp_bytes(1, &frame(json!({"k":"reply","id":1,"ok":true,"result":{}})), 2.0);
        let answers: Vec<&HubOut> = out.iter().filter(|o| matches!(o, HubOut::Answer { .. })).collect();
        assert!(matches!(&answers[..], [HubOut::Answer { conn: 1, id: 1, answer: Ok(_) }]));
        // (1 s after its ask: said in the log, the link's slow reply line.)
        assert!(logged(&out, "request 1 (updateSettings) answered in 1000 ms (not acked)"), "{out:?}");
        let (id, _) = h.request(1, "x", Object::new(), None, 3.0);
        assert_eq!(id, Ok(2));
        let out = h.tick(18.0);
        assert!(!out.iter().any(|o| matches!(o, HubOut::Answer { .. })), "no time-out: still waiting");
        assert_eq!(h.slow(1, 18.0), Some(15.0), "not acked: slow for 15 s");
        assert!(h.tcp_bytes(1, &frame(json!({"k":"ack","id":2})), 18.5).is_empty(), "an ack: the link's own");
        assert_eq!(h.slow(1, 19.0), None);
        let (cancelled, out) = h.cancel(1, 2);
        assert!(cancelled);
        assert_eq!(texts(&out, Which::Tcp, 1), vec![json!({"k":"cancel","id":2})]);
        assert!(h.tcp_bytes(1, &frame(json!({"k":"reply","id":2,"ok":true})), 19.0).is_empty(), "its late reply: left");
        assert!(!h.cancel(1, 2).0 && !h.cancel(9, 1).0, "nothing waits for it");
        let out = h.tcp_bytes(
            1,
            &frame(json!({"k":"push","epoch":"e1","windowId":3,"msg":{"type":"loading","tabIds":[1]}})),
            19.0,
        );
        assert!(matches!(&out[..], [HubOut::Received { conn: 1, message: LinkMessage::Push { .. }, .. }]));
    }

    fn state(out: &[HubOut]) -> Option<&StateApplied> {
        out.iter().find_map(|o| if let HubOut::State { applied, .. } = o { Some(applied) } else { None })
    }

    fn resyncs(out: &[HubOut]) -> usize {
        texts(out, Which::Tcp, 1).iter().filter(|m| m["k"] == "resync" && m["epoch"] == "e1").count()
    }

    #[test]
    fn each_links_state_mirrored_as_it_comes() {
        let mut h = linked();
        assert!(h.mirror(1).is_some_and(|m| !m.has_state() && m.epoch() == Some("e1")), "begun at its hello");
        let out = h.tcp_bytes(
            1,
            &frame(json!({"k":"snapshot","epoch":"e1","seq":1,"state":{"spaces":[{"id":"a"}],"openTabs":{"tabs":{}},"favicons":{"https://a":{"icon":"A"}}},"windows":[{"windowId":3}]})),
            1.0,
        );
        let a = state(&out).expect("said");
        assert!(a.kind == StateKind::Snapshot && a.outcome == mirror::Outcome::Applied && a.has_state && !a.resyncing);
        assert_eq!(a.keys, ["favicons", "openTabs", "spaces"]);
        assert_eq!(a.windows.as_ref().map(Vec::len), Some(1), "the windows, as they changed");
        assert!(!out.iter().any(|o| matches!(o, HubOut::Received { .. })), "the state never handed on as it came");
        let m = h.mirror(1).expect("a mirror");
        assert_eq!(m.value_text("spaces").as_deref(), Some(r#"[{"id":"a"}]"#), "a value's text as it's kept");
        assert_eq!(m.value_text("favicons").as_deref(), Some(r#"{"https://a":{"icon":"A"}}"#));
        let out = h.tcp_bytes(
            1,
            &frame(json!({"k":"delta","epoch":"e1","seq":2,"changes":{"spaces":{"newValue":[]},"pins":{}}})),
            1.5,
        );
        let a = state(&out).expect("said");
        assert!(a.kind == StateKind::Delta && a.outcome == mirror::Outcome::Applied && a.seq == 2);
        assert_eq!((a.keys.clone(), a.windows.clone()), (vec!["pins".to_owned(), "spaces".to_owned()], None));
        assert_eq!(h.mirror(1).and_then(|m| m.value("spaces")), Some(json!([])));
        let out = h.tcp_bytes(
            1,
            &frame(json!({"k":"windows","epoch":"e1","seq":3,"list":[{"windowId":3},{"windowId":4}]})),
            2.0,
        );
        assert_eq!(state(&out).and_then(|a| a.windows.as_ref()).map(Vec::len), Some(2));
        assert_eq!(h.next_deadline(), Some(5.0), "only the link's ticker");

        // A number missed: logged, the state asked for at once, and every 2 s until it comes.
        let out = h.tcp_bytes(1, &frame(json!({"k":"windows","epoch":"e1","seq":5,"list":[]})), 10.0);
        let a = state(&out).expect("said");
        assert!(a.outcome == mirror::Outcome::Gap { expected: 4, got: 5 } && a.resyncing && a.windows.is_none());
        assert!(logged(&out, "safari:P1: number 5 came, 4 was next: the state asked for again"));
        assert_eq!(resyncs(&out), 1);
        let out = h.tcp_bytes(1, &frame(json!({"k":"delta","epoch":"e1","seq":6,"changes":{}})), 11.0);
        assert!(state(&out).is_some_and(|a| a.outcome == mirror::Outcome::Ignored) && resyncs(&out) == 0);
        assert_eq!(resyncs(&h.tick(11.9)), 0);
        assert_eq!(resyncs(&h.tick(12.0)), 1, "2 s on: again");
        assert_eq!(resyncs(&h.tick(14.0)), 1, "and again");
        let out = h.tcp_bytes(1, &frame(json!({"k":"snapshot","epoch":"e1","seq":9,"state":{}})), 15.0);
        assert!(state(&out).is_some_and(|a| a.outcome == mirror::Outcome::Applied && !a.resyncing));
        assert_eq!(resyncs(&h.tick(16.0)), 0, "the snapshot: no more");
        assert_eq!(h.mirror(1).map(|m| m.keys()), Some(vec![]), "the resync's state, whole");

        // Another gap, then the link goes: no more asks, the mirror gone.
        h.tcp_bytes(1, &frame(json!({"k":"windows","epoch":"e1","seq":20,"list":[]})), 17.0);
        let out = h.tcp_ended(1, None, 18.0);
        assert!(out.iter().any(|o| matches!(o, HubOut::Down { conn: 1, .. })));
        assert!(h.mirror(1).is_none() && h.tick(19.0).is_empty());
    }

    #[test]
    fn a_new_link_starts_its_state_over() {
        let mut h = linked();
        h.set_resync_retry(0.5);
        h.tcp_bytes(1, &frame(json!({"k":"snapshot","epoch":"e1","seq":1,"state":{"a":1}})), 1.0);
        // The same profile again (a reload): it takes over, and its mirror is its own.
        h.tcp_accept(2, 2.0);
        h.tcp_bytes(2, &copy_request(), 2.0);
        let out = h.tcp_bytes(2, &hello("safari", "P1", "e2"), 2.0);
        assert!(out.iter().any(|o| matches!(o, HubOut::Up { conn: 2, .. })));
        assert!(h.mirror(2).is_some_and(|m| !m.has_state() && m.keys().is_empty() && m.epoch() == Some("e2")));
        let out = h.tcp_bytes(2, &frame(json!({"k":"snapshot","epoch":"e1","seq":1,"state":{"a":1}})), 2.5);
        assert!(state(&out).is_some_and(|a| a.outcome == mirror::Outcome::Ignored), "the old epoch's: left");
        let out = h.tcp_bytes(2, &frame(json!({"k":"delta","epoch":"e2","seq":1,"changes":{}})), 3.0);
        assert!(state(&out).is_some_and(|a| a.outcome == mirror::Outcome::Gap { expected: 1, got: 1 }));
        assert_eq!(h.next_deadline(), Some(3.5), "the retry set before its hello: taken");
    }

    #[test]
    fn stopping_closes_the_relays_then_the_links() {
        let mut h = linked();
        h.relay_open(7);
        h.relay_bytes(7, &line(json!({"k":"relay","v":1,"version":"7","pid":1,"browser":"chrome"})), 1.0);
        let out = h.stop("Margin.app quit", 2.0);
        assert_eq!(out.first(), Some(&HubOut::End { which: Which::Relay, conn: 7 }));
        assert_eq!(texts(&out, Which::Tcp, 1), vec![json!({"k":"bye","why":"Margin.app quit"})]);
        assert!(out.contains(&HubOut::End { which: Which::Tcp, conn: 1 }));
        assert!(out.iter().any(|o| matches!(o, HubOut::Down { why, .. } if why == "stopped: Margin.app quit")));
    }
}
