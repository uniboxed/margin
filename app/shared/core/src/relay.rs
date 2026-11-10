//! The app's end of Margin's connector, sans IO (app/macos/shell/RelayLink.swift: `RelayHub` and
//! `RelayConnection`, less the socket): Chrome's and Edge's copies can't hear Safari's `dispatchMessage`, so the
//! browser starts the connector (`margin-connector`, app/shared/connector/) through native messaging, and the
//! connector connects to the app (a Unix socket on the Mac, a named pipe on Windows: only this user's, the
//! transport's to check). It does for those copies what Safari's extension handler does for Safari's: each
//! message gets the handler's reply; a `wantLink` is answered into every relay of that browser's process (the
//! copy's lasting port is one of them), as the link answers Safari's into Safari ([`crate::socket::SocketLink`]);
//! `appUp` goes to a relay that had to wait for the app. The link itself is the copy's WebSocket, as Safari's.
//! The relays are for finding the app only: nothing of the link goes through them.
//!
//! One JSON object per line both ways. The relay's first: `{ k: 'relay', v: 1, version, pid, browser, waited }`,
//! answered `{ k: 'relayWelcome', v: 1, version }` (a relay whose version isn't the app's exits: the browser
//! starts the new one next time); then each of the browser's messages as `{ msg }`. What the app sends is
//! passed to the browser as it is.
//!
//! Kept from the Swift, exactly: a first word that isn't a relay's hello of `chrome` or `edge` closes it; a line
//! that isn't a JSON object closes it, as does an unended line over 1 MiB; a `{ msg }` that isn't an object is
//! left; every message is answered `{ ok: true, appOpen: true, launching: false, browser, pid }` (`pid` only when
//! known), a `log`'s line (its first 300 characters) going to the app's log as `<browser>: <line>`, a `wantLink`'s
//! nonce (1–128 characters) to the link; a dispatch is `{ name, userInfo: { e: <JSON string> } }`, into every relay
//! whose hello said that pid (pid 0: every relay). What the transport does: accepts only this user's
//! connections from Margin's connector, says each one's bytes and end, writes [`RelayOut::Write`]s in order and
//! closes on [`RelayOut::End`] (at once: what's queued is left).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::json::{self, Object};
use crate::link::{ConnId, Level};
use crate::protocol::VERSION;
use crate::socket::Via;
use crate::time::Secs;

/// `RelayConnection.maxLine`: at most this much of a line not yet ended (a relay sends the copy's small messages).
pub const MAX_LINE: usize = 1 << 20;

/// What a relay said of itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayHello {
    /// `chrome` or `edge`.
    pub browser: String,
    /// The browser's process (the relay's parent): 0 when it didn't say.
    pub pid: u32,
    pub version: String,
    /// It had to wait for the app (its copies asked in vain meanwhile).
    pub waited: bool,
}

/// What the caller does, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum RelayOut {
    /// These bytes (one line or more) to that relay.
    Write {
        conn: ConnId,
        bytes: Vec<u8>,
    },
    /// Close that relay's connection now.
    End {
        conn: ConnId,
    },
    /// A copy asks for the link: [`crate::socket::SocketLink::want_link`], answered into `via`'s relays.
    WantLink {
        nonce: String,
        via: Via,
    },
    Log {
        level: Level,
        text: String,
    },
}

#[derive(Clone, Debug, Default)]
struct Relay {
    hello: Option<RelayHello>,
    inbox: Vec<u8>,
    closed: bool,
}

/// `RelayHub`, without the listener.
#[derive(Clone, Debug)]
pub struct RelayHub {
    /// The app's version (`relayWelcome.version`).
    version: String,
    relays: BTreeMap<ConnId, Relay>,
}

/// `RelayHub.dispatched`: a dispatch as Safari's arrives on the copy's port: `{ name, userInfo: { e: <JSON string> } }`.
pub fn dispatched(name: &str, info: &Object) -> Object {
    let e = serde_json::to_string(info).unwrap_or_else(|_| "{}".into());
    let mut user_info = Object::new();
    user_info.insert("e".into(), e.into());
    let mut m = Object::new();
    m.insert("name".into(), name.into());
    m.insert("userInfo".into(), user_info.into());
    m
}

impl RelayHub {
    pub fn new(version: impl Into<String>) -> Self {
        Self { version: version.into(), relays: BTreeMap::new() }
    }

    /// The relays connected (said hello or not).
    pub fn connected(&self) -> usize {
        self.relays.values().filter(|r| !r.closed).count()
    }

    /// What a relay said of itself, once it has.
    pub fn hello(&self, conn: ConnId) -> Option<&RelayHello> {
        self.relays.get(&conn)?.hello.as_ref()
    }

    /// A relay connected (the transport let it in).
    pub fn on_open(&mut self, conn: ConnId) {
        self.relays.entry(conn).or_default();
    }

    /// `gone`: its connection ended.
    pub fn on_ended(&mut self, conn: ConnId) {
        self.relays.remove(&conn);
    }

    /// `readable` and `lines`: bytes from a relay, each whole line said.
    pub fn on_bytes(&mut self, conn: ConnId, data: &[u8], now: Secs) -> Vec<RelayOut> {
        let mut out = Vec::new();
        match self.relays.get_mut(&conn) {
            Some(r) if !r.closed => r.inbox.extend_from_slice(data),
            _ => return out,
        }
        loop {
            let line = {
                let Some(r) = self.relays.get_mut(&conn) else { return out };
                let Some(end) = r.inbox.iter().position(|&b| b == b'\n') else { break };
                let line: Vec<u8> = r.inbox.drain(..=end).take(end).collect();
                line
            };
            if line.is_empty() {
                continue;
            }
            let Ok(Value::Object(message)) = serde_json::from_slice::<Value>(&line) else {
                warn(&mut out, "relay: not a JSON line: closed".into());
                self.close(conn, &mut out);
                return out;
            };
            self.said(conn, &message, now, &mut out);
            if self.relays.get(&conn).is_none_or(|r| r.closed) {
                return out;
            }
        }
        if self.relays.get(&conn).is_some_and(|r| r.inbox.len() > MAX_LINE) {
            warn(&mut out, format!("relay: a line over {MAX_LINE} bytes: closed"));
            self.close(conn, &mut out);
        }
        out
    }

    fn close(&mut self, conn: ConnId, out: &mut Vec<RelayOut>) {
        let Some(r) = self.relays.get_mut(&conn) else { return };
        if r.closed {
            return;
        }
        r.closed = true;
        r.inbox = Vec::new();
        out.push(RelayOut::End { conn });
    }

    fn send(conn: ConnId, message: &Object, out: &mut Vec<RelayOut>) {
        let Ok(mut line) = serde_json::to_vec(message) else { return };
        line.push(b'\n');
        out.push(RelayOut::Write { conn, bytes: line });
    }

    /// `said`: one of a relay's lines.
    fn said(&mut self, conn: ConnId, message: &Object, now: Secs, out: &mut Vec<RelayOut>) {
        let Some(relay) = self.relays.get_mut(&conn) else { return };
        let Some(hello) = relay.hello.clone() else {
            let browser = json::string(message.get("browser")).filter(|b| matches!(*b, "chrome" | "edge"));
            let (Some("relay"), Some(browser)) = (json::string(message.get("k")), browser) else {
                warn(out, "relay: its first word wasn't its hello: closed".into());
                return self.close(conn, out);
            };
            let pid = json::int(message.get("pid")).and_then(|p| u32::try_from(p).ok()).unwrap_or(0);
            let hello = RelayHello {
                browser: browser.to_owned(),
                pid,
                version: json::string(message.get("version")).unwrap_or("").to_owned(),
                waited: json::boolean(message.get("waited")) == Some(true),
            };
            let waited = hello.waited;
            relay.hello = Some(hello);
            let mut welcome = Object::new();
            welcome.insert("k".into(), "relayWelcome".into());
            welcome.insert("v".into(), 1.into());
            welcome.insert("version".into(), self.version.clone().into());
            Self::send(conn, &welcome, out);
            // Waiting for the app, the copies asked in vain: they ask again now (as Safari's do on appUp).
            if waited {
                let mut info = Object::new();
                info.insert("v".into(), VERSION.into());
                info.insert("at".into(), ((now * 1000.0).round() as i64).into());
                Self::send(conn, &dispatched("appUp", &info), out);
            }
            return;
        };
        let Some(body) = json::object(message.get("msg")) else { return };
        let mut reply = Object::new();
        reply.insert("ok".into(), true.into());
        reply.insert("appOpen".into(), true.into());
        reply.insert("launching".into(), false.into());
        reply.insert("browser".into(), hello.browser.clone().into());
        if hello.pid > 0 {
            reply.insert("pid".into(), hello.pid.into());
        }
        match json::string(body.get("type")) {
            Some("log") => {
                if let Some(line) = json::string(body.get("line")) {
                    let line: String = line.chars().take(300).collect();
                    note(out, format!("{}: {line}", hello.browser));
                }
                Self::send(conn, &reply, out);
            }
            Some("wantLink") => {
                Self::send(conn, &reply, out);
                let nonce = json::string(body.get("nonce")).filter(|n| (1..=128).contains(&n.chars().count()));
                let Some(nonce) = nonce else { return warn(out, "relay: wantLink without a nonce".into()) };
                out.push(RelayOut::WantLink {
                    nonce: nonce.to_owned(),
                    via: Via { pid: hello.pid, browser: hello.browser },
                });
            }
            // A ping (the lasting port), or anything else: answered as Safari's handler does.
            _ => Self::send(conn, &reply, out),
        }
    }

    /// `dispatch(_:_:pid:)`: into every relay of one browser process (its copies' lasting ports among them); `pid`
    /// 0: every relay. False if there was none.
    pub fn dispatch(&mut self, name: &str, info: &Object, pid: u32) -> (Vec<RelayOut>, bool) {
        let mut out = Vec::new();
        let message = dispatched(name, info);
        let mut sent = false;
        for (&conn, relay) in &self.relays {
            let Some(hello) = relay.hello.as_ref().filter(|_| !relay.closed) else { continue };
            if pid == 0 || hello.pid == pid {
                Self::send(conn, &message, &mut out);
                sent = true;
            }
        }
        (out, sent)
    }

    /// `stop`: every relay closed.
    pub fn stop(&mut self) -> Vec<RelayOut> {
        let mut out = Vec::new();
        let conns: Vec<ConnId> = self.relays.keys().copied().collect();
        for conn in conns {
            self.close(conn, &mut out);
        }
        out
    }
}

fn note(out: &mut Vec<RelayOut>, text: String) {
    out.push(RelayOut::Log { level: Level::Note, text });
}

fn warn(out: &mut Vec<RelayOut>, text: String) {
    out.push(RelayOut::Log { level: Level::Warn, text });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(v: Value) -> Vec<u8> {
        let mut b = v.to_string().into_bytes();
        b.push(b'\n');
        b
    }

    fn written(out: &[RelayOut], conn: ConnId) -> Vec<Value> {
        out.iter()
            .filter_map(|o| match o {
                RelayOut::Write { conn: c, bytes } if *c == conn => Some(bytes.clone()),
                _ => None,
            })
            .flat_map(|b| {
                b.split(|&c| c == b'\n')
                    .filter(|l| !l.is_empty())
                    .filter_map(|l| serde_json::from_slice::<Value>(l).ok())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn logged(out: &[RelayOut], text: &str) -> bool {
        out.iter().any(|o| matches!(o, RelayOut::Log { text: t, .. } if t.contains(text)))
    }

    fn ended(out: &[RelayOut], conn: ConnId) -> bool {
        out.iter().any(|o| matches!(o, RelayOut::End { conn: c } if *c == conn))
    }

    fn relay(hub: &mut RelayHub, conn: ConnId, browser: &str, pid: u32, waited: bool) -> Vec<RelayOut> {
        hub.on_open(conn);
        let hello = json!({"k":"relay","v":1,"version":"7","pid":pid,"browser":browser,"waited":waited});
        hub.on_bytes(conn, &line(hello), 1.0)
    }

    #[test]
    fn a_relay_says_hello_and_is_welcomed() {
        let mut hub = RelayHub::new("7");
        let out = relay(&mut hub, 1, "edge", 42, false);
        assert_eq!(written(&out, 1), vec![json!({"k":"relayWelcome","v":1,"version":"7"})]);
        assert_eq!(hub.hello(1).map(|h| (h.browser.as_str(), h.pid)), Some(("edge", 42)));
        assert_eq!(hub.connected(), 1);
    }

    #[test]
    fn a_relay_that_waited_is_told_app_up() {
        let mut hub = RelayHub::new("7");
        let out = relay(&mut hub, 1, "chrome", 42, true);
        let said = written(&out, 1);
        assert_eq!(said.len(), 2);
        assert_eq!(said[1]["name"], "appUp");
        let e: Value = serde_json::from_str(said[1]["userInfo"]["e"].as_str().unwrap_or("")).unwrap_or(Value::Null);
        assert_eq!(e, json!({"v":2,"at":1000}));
    }

    #[test]
    fn every_message_is_answered_as_safaris_handler_does() {
        let mut hub = RelayHub::new("7");
        relay(&mut hub, 1, "edge", 42, false);
        let out = hub.on_bytes(1, &line(json!({"msg":{"type":"wantLink","nonce":"n1"}})), 2.0);
        assert_eq!(
            written(&out, 1),
            vec![json!({"ok":true,"appOpen":true,"launching":false,"browser":"edge","pid":42})],
            "wantLink: replied open, with the browser and its process"
        );
        assert!(out.contains(&RelayOut::WantLink { nonce: "n1".into(), via: Via { pid: 42, browser: "edge".into() } }));
        let out = hub.on_bytes(1, &line(json!({"msg":{"type":"ping","at":1}})), 2.0);
        assert_eq!(written(&out, 1).first().map(|r| r["ok"].clone()), Some(json!(true)), "a ping: answered");
        let out = hub.on_bytes(1, &line(json!({"msg":{"type":"log","line":"kept link try 1 of 3"}})), 2.0);
        assert!(logged(&out, "edge: kept link try 1 of 3"), "a log line: in the app's log");
        assert_eq!(written(&out, 1).len(), 1, "and answered");
        let out = hub.on_bytes(1, &line(json!({"msg":{"type":"log","line":"x".repeat(400)}})), 2.0);
        assert!(logged(&out, &format!("edge: {}", "x".repeat(300))) && !logged(&out, &"x".repeat(301)), "300 at most");
        let out = hub.on_bytes(1, &line(json!({"msg":{"type":"wantLink"}})), 2.0);
        assert_eq!(written(&out, 1).len(), 1, "answered all the same");
        assert!(logged(&out, "relay: wantLink without a nonce"));
        assert!(!out.iter().any(|o| matches!(o, RelayOut::WantLink { .. })));
        assert!(hub.on_bytes(1, &line(json!({"msg":"not an object"})), 2.0).is_empty(), "no message: left");
        // A relay that knows no pid: none in the reply.
        relay(&mut hub, 2, "chrome", 0, false);
        let out = hub.on_bytes(2, &line(json!({"msg":{"type":"ping"}})), 2.0);
        assert_eq!(written(&out, 2), vec![json!({"ok":true,"appOpen":true,"launching":false,"browser":"chrome"})]);
    }

    #[test]
    fn a_dispatch_goes_to_every_relay_of_that_browser_process() {
        let mut hub = RelayHub::new("7");
        relay(&mut hub, 1, "edge", 42, false);
        relay(&mut hub, 2, "edge", 42, false);
        relay(&mut hub, 3, "chrome", 99, false);
        hub.on_open(4); // no hello yet
        let info = json!({"v":2,"nonce":"n"}).as_object().cloned().unwrap_or_default();
        let (out, sent) = hub.dispatch("link", &info, 42);
        assert!(sent);
        let to: Vec<ConnId> =
            out.iter().filter_map(|o| if let RelayOut::Write { conn, .. } = o { Some(*conn) } else { None }).collect();
        assert_eq!(to, vec![1, 2]);
        let said = written(&out, 1);
        assert_eq!(said[0]["name"], "link");
        assert_eq!(said[0]["userInfo"]["e"], json!(r#"{"v":2,"nonce":"n"}"#));
        assert_eq!(hub.dispatch("link", &info, 0).0.len(), 3, "pid 0: every relay that said hello");
        assert_eq!(hub.dispatch("link", &info, 5), (Vec::new(), false), "none of that process");
    }

    #[test]
    fn what_closes_a_relay() {
        let mut hub = RelayHub::new("7");
        hub.on_open(1);
        let out = hub.on_bytes(1, &line(json!({"msg":{"type":"ping"}})), 1.0);
        assert!(ended(&out, 1) && logged(&out, "relay: its first word wasn't its hello: closed"));
        hub.on_open(2);
        let out = hub.on_bytes(2, &line(json!({"k":"relay","browser":"firefox"})), 1.0);
        assert!(ended(&out, 2), "not chrome or edge");
        relay(&mut hub, 3, "edge", 1, false);
        let out = hub.on_bytes(3, b"{not json\n", 1.0);
        assert!(ended(&out, 3) && logged(&out, "relay: not a JSON line: closed"));
        relay(&mut hub, 4, "edge", 1, false);
        let out = hub.on_bytes(4, b"[1,2]\n", 1.0);
        assert!(ended(&out, 4), "not an object");
        relay(&mut hub, 5, "edge", 1, false);
        let out = hub.on_bytes(5, &vec![b'a'; MAX_LINE + 1], 1.0);
        assert!(ended(&out, 5) && logged(&out, "relay: a line over 1048576 bytes: closed"));
        assert!(hub.on_bytes(5, b"\n", 1.0).is_empty(), "nothing taken after");
        hub.on_ended(5);
        assert!(hub.hello(5).is_none());
    }

    #[test]
    fn lines_in_pieces_and_several_at_once() {
        let mut hub = RelayHub::new("7");
        hub.on_open(1);
        let hello = line(json!({"k":"relay","v":1,"version":"7","pid":3,"browser":"chrome","waited":false}));
        assert!(hub.on_bytes(1, &hello[..10], 1.0).is_empty());
        let mut rest = hello[10..].to_vec();
        rest.extend(b"\n\n");
        rest.extend(line(json!({"msg":{"type":"ping"}})));
        let out = hub.on_bytes(1, &rest, 1.0);
        let said = written(&out, 1);
        assert_eq!(said.len(), 2, "the welcome, then the ping's answer; empty lines skipped");
        assert_eq!(said[0]["k"], "relayWelcome");
    }

    #[test]
    fn stopping_closes_every_relay() {
        let mut hub = RelayHub::new("7");
        relay(&mut hub, 1, "edge", 1, false);
        hub.on_open(2);
        assert_eq!(hub.stop(), vec![RelayOut::End { conn: 1 }, RelayOut::End { conn: 2 }]);
        assert_eq!(hub.connected(), 0);
    }
}
