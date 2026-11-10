//! The shell's scenarios, with fake inputs: a relay says hello and asks for the link, the copy opens its WebSocket
//! with the token and says hello and its state, the windows are read, an overlay is made, shown and talks to its
//! page, the keys are held, the link drops.

use serde_json::{Value, json};

use super::*;
use crate::geometry::Rect;
use crate::planner::Display;
use crate::system::ServerWindow;
use crate::websocket::{client_frame, server_frames};

const EDGE: u32 = 100;
const PORT: u16 = 49_152;
const ORIGIN: &str = "chrome-extension://njeebbcmlenfopaecfbphgcfihbdmkec";
const BROWSER_WINDOW: i64 = 5001;
const SCREEN: Rect = Rect::new(0.0, 0.0, 1920.0, 1080.0);
const T0: Secs = 1_800_000_000.0;

struct H {
    shell: Shell,
    now: Secs,
    _dir: tempfile::TempDir,
    /// The browser window's bounds as the OS lists them.
    server: Rect,
    log: Vec<Command>,
}

fn obj(v: Value) -> Object {
    v.as_object().cloned().unwrap_or_default()
}

impl H {
    fn new() -> Self {
        Self::with(|_| {})
    }

    fn with(set: impl FnOnce(&mut Options)) -> Self {
        let dir = tempfile::Builder::new().prefix("margin-shell-").tempdir().expect("a temporary folder");
        let mut opts = Options::new(dir.path().join("data"), dir.path().join("themes"));
        opts.own_pid = 999;
        opts.app_version = "9.9".into();
        set(&mut opts);
        let mut shell = Shell::new(opts);
        let clock = std::sync::Arc::new(std::sync::Mutex::new(T0));
        let c = clock.clone();
        shell.data_mut().now = Box::new(move || c.lock().map(|t| *t * 1000.0).unwrap_or(0.0));
        let mut h = Self { shell, now: T0, _dir: dir, server: SCREEN, log: Vec::new() };
        let out = h.input(Input::Listening { port: Some(PORT) });
        assert!(out.contains(&Command::Log { warn: false, text: format!("listening on 127.0.0.1:{PORT}") }));
        h
    }

    fn input(&mut self, input: Input) -> Vec<Command> {
        let out = self.shell.handle(self.now, input);
        self.log.extend(out.iter().cloned());
        out
    }

    fn later(&mut self, s: Secs) -> Vec<Command> {
        self.now += s;
        self.input(Input::Tick)
    }

    /// One of the copy's messages on its socket (conn 1).
    fn frame(&mut self, v: Value) -> Vec<Command> {
        self.say(1, v)
    }

    fn say(&mut self, conn: ConnId, v: Value) -> Vec<Command> {
        self.input(Input::SocketBytes { conn, bytes: client_frame(1, v.to_string().as_bytes(), true) })
    }

    /// A relay of `browser`'s process `pid` connects and says hello.
    fn relay(&mut self, conn: ConnId, browser: &str, pid: u32, waited: bool) -> Vec<Command> {
        self.input(Input::RelayOpened { conn });
        let hello = json!({ "k": "relay", "v": 1, "version": "9.9", "pid": pid, "browser": browser, "waited": waited });
        self.relay_says(conn, hello)
    }

    fn relay_says(&mut self, conn: ConnId, v: Value) -> Vec<Command> {
        let mut bytes = v.to_string().into_bytes();
        bytes.push(b'\n');
        self.input(Input::RelayBytes { conn, bytes })
    }

    /// What the app wrote to a relay: its lines.
    fn relay_lines(out: &[Command], to: ConnId) -> Vec<Value> {
        out.iter()
            .filter_map(|c| match c {
                Command::RelayWrite { conn, bytes } if *conn == to => Some(bytes.clone()),
                _ => None,
            })
            .flat_map(|b| {
                b.split(|&c| c == b'\n').filter_map(|l| serde_json::from_slice::<Value>(l).ok()).collect::<Vec<_>>()
            })
            .collect()
    }

    /// A relay's copy asks for the link: the `link` dispatched into that relay, read.
    fn want_link(&mut self, relay: ConnId) -> Value {
        let out = self.relay_says(relay, json!({ "msg": { "type": "wantLink", "nonce": "n1" } }));
        let link = H::relay_lines(&out, relay).into_iter().find(|m| m["name"] == "link").expect("the link dispatched");
        serde_json::from_str(link["userInfo"]["e"].as_str().unwrap_or("")).expect("its JSON")
    }

    /// The copy's WebSocket request, with this token and Origin.
    fn upgrade(token: &str, origin: &str) -> Vec<u8> {
        format!(
            "GET /?t={token} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n"
        )
        .into_bytes()
    }

    /// A socket opened with this token and Origin, its first answer.
    fn connect(&mut self, conn: ConnId, token: &str, origin: &str) -> Vec<Command> {
        self.input(Input::SocketOpened { conn });
        self.input(Input::SocketBytes { conn, bytes: H::upgrade(token, origin) })
    }

    /// What the app wrote on a socket.
    fn written(out: &[Command], to: ConnId) -> Vec<u8> {
        out.iter()
            .filter_map(|c| match c {
                Command::Write { conn, bytes } if *conn == to => Some(bytes.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn read(&mut self, front: u32) -> Vec<Command> {
        let mut w = ServerWindow::new(BROWSER_WINDOW, EDGE, self.server);
        w.order = 0;
        self.input(Input::Windows(WindowRead {
            list: vec![w],
            front_pid: Some(front),
            front_window: Some(if front == EDGE { BROWSER_WINDOW } else { 1 }),
            browsers: vec![BrowserProcess { pid: EDGE, browser: "edge".into(), root: EDGE }],
            displays: vec![Display { frame: SCREEN, top_inset: 0.0 }],
        }))
    }

    /// Reads (a quarter second apart) until the copy's window is bound.
    fn read_until_bound(&mut self) -> Vec<Command> {
        let mut all = Vec::new();
        for _ in 0..40 {
            self.now += 0.25;
            all.extend(self.read(EDGE));
            if !self.shell.bindings().is_empty() {
                return all;
            }
        }
        panic!("never bound: {:?}", self.logs());
    }

    fn logs(&self) -> Vec<String> {
        self.log
            .iter()
            .filter_map(|c| if let Command::Log { text, .. } = c { Some(text.clone()) } else { None })
            .collect()
    }

    /// The app's messages on every socket (its text frames; a 101 before them skipped).
    fn sent(out: &[Command]) -> Vec<Value> {
        out.iter()
            .filter_map(|c| if let Command::Write { bytes, .. } = c { Some(bytes.as_slice()) } else { None })
            .flat_map(|b| {
                let frames = match b.windows(4).position(|w| w == b"\r\n\r\n") {
                    Some(i) if b.starts_with(b"HTTP/1.1 ") => &b[i + 4..],
                    _ => b,
                };
                server_frames(frames).unwrap_or_default()
            })
            .filter(|(op, _)| *op == 1)
            .filter_map(|(_, p)| serde_json::from_slice(&p).ok())
            .collect()
    }

    fn sent_kind(out: &[Command], k: &str) -> Vec<Value> {
        Self::sent(out).into_iter().filter(|m| m["k"] == k).collect()
    }

    fn received(out: &[Command]) -> Vec<Value> {
        out.iter()
            .filter_map(|c| if let Command::Receive { json, .. } = c { serde_json::from_str(json).ok() } else { None })
            .collect()
    }

    fn overlay_id(&self) -> OverlayId {
        self.shell.overlays().next().map(|o| o.id).expect("an overlay")
    }

    fn op(&mut self, op: &str, body: Value, reply: Option<ReplyToken>) -> Vec<Command> {
        let id = self.overlay_id();
        self.input(Input::PageOp { id, op: op.into(), body: obj(body), reply })
    }

    /// A relay of Edge's linked, its copy linked over its socket (the token from the relay's `link`) with its state,
    /// theme and one full-screen window.
    fn linked() -> Self {
        Self::linked_with(
            H::new(),
            json!({ "windowId": 7, "left": 0, "top": 0, "width": 1920, "height": 1080, "state": "fullscreen", "focused": true }),
        )
    }

    fn linked_with(mut h: H, window: Value) -> Self {
        h.relay(1, "edge", EDGE, false);
        let link = h.want_link(1);
        let token = link["token"].as_str().unwrap_or("").to_owned();
        let out = h.connect(1, &token, ORIGIN);
        assert_eq!(
            H::sent_kind(&out, "welcome"),
            vec![json!({ "k": "welcome", "v": 2, "key": link["key"] })],
            "welcome first"
        );
        h.frame(json!({ "k": "hello", "v": 2, "epoch": "e1", "profile": "p-a", "browser": "edge", "pid": EDGE, "owner": true, "instanceId": "i1" }));
        assert_eq!(h.shell.link_keys(), vec!["edge:p-a".to_string()], "the hello's browser");
        h.frame(json!({
            "k": "snapshot", "epoch": "e1", "seq": 1,
            "state": { "settings": {}, "spaces": [{ "id": "s1", "name": "One" }], "openTabs": { "activeSpaceByWindow": { "7": "s1" } } },
            "windows": [window],
        }));
        let package = json!({ "id": "arcadia", "manifest": "{}", "html": "<m-page></m-page>", "css": "" }).to_string();
        for chunk in crate::chunks::split(package.as_bytes(), "arcadia").unwrap_or_default() {
            let mut m = chunk.fields();
            m.insert("k".into(), "theme".into());
            m.insert("epoch".into(), "e1".into());
            h.frame(Value::Object(m));
        }
        h
    }

    /// …and its overlay made, its page's hello answered, drawn and shown over the window.
    fn shown() -> (Self, Value) {
        let mut h = H::linked();
        let out = h.read_until_bound();
        assert!(out.iter().any(|c| matches!(c, Command::CreateOverlay { .. })), "an overlay made");
        let drawn = H::sent_kind(&h.log, "drawn");
        assert_eq!(drawn.last().map(|d| d["on"].clone()), Some(json!(true)), "told drawn as it's bound");
        let out = h.op("hello", json!({}), Some(1));
        let hello = out
            .iter()
            .find_map(|c| match c {
                Command::Reply { token: 1, result: Ok(Value::String(s)) } => serde_json::from_str::<Value>(s).ok(),
                _ => None,
            })
            .expect("the hello answered with JSON");
        let out = h.op("ready", json!({}), Some(2));
        assert!(out.contains(&Command::Reply { token: 2, result: Ok(Value::Null) }));
        assert!(out.contains(&Command::ReadWindows), "drawn: the windows read again");
        h.now += 0.05;
        let out = h.read(EDGE);
        assert!(
            out.iter()
                .any(|c| matches!(c, Command::ShowOverlay { above: BROWSER_WINDOW, frame, .. } if *frame == SCREEN)),
            "shown over its window: {out:?}"
        );
        (h, hello)
    }
}

#[test]
fn a_copy_links_and_an_overlay_shows_with_its_hello() {
    let (h, hello) = H::shown();
    let keys: Vec<&str> = hello.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
    assert_eq!(
        keys,
        [
            "windowId",
            "profile",
            "browser",
            "mode",
            "platform",
            "state",
            "windows",
            "across",
            "cloudTabs",
            "held",
            "themes",
            "theme"
        ]
    );
    assert_eq!(hello["windowId"], 7);
    assert_eq!(hello["profile"], "p-a");
    assert_eq!(hello["browser"], "edge");
    assert_eq!(hello["mode"], "fullscreen");
    assert_eq!(hello["platform"], json!({ "browser": "edge", "os": "win", "app": true }));
    assert_eq!(hello["state"]["spaces"][0]["id"], "s1");
    assert_eq!(hello["windows"][0]["windowId"], 7);
    assert_eq!(hello["across"]["profile"], "p-a");
    assert_eq!(hello["cloudTabs"], Value::Null);
    assert_eq!(hello["held"], json!([]));
    assert_eq!(hello["themes"], json!([]));
    assert_eq!(hello["theme"]["id"], "arcadia");
    assert!(h.shell.hot_keys_active(), "the keys held: a linked browser in front with an overlay shown");
    assert!(h.log.iter().any(|c| matches!(c, Command::HotKeys { keys } if !keys.is_empty())));
}

#[test]
fn a_page_send_is_a_req_and_its_reply_goes_back() {
    let (mut h, _) = H::shown();
    let out = h.op("send", json!({ "type": "activateTab", "payload": { "tabId": 3 } }), Some(9));
    let req = H::sent_kind(&out, "req");
    assert_eq!(req.len(), 1);
    assert_eq!(req[0]["type"], "activateTab");
    assert_eq!(req[0]["windowId"], 7);
    assert_eq!(req[0]["payload"]["tabId"], 3);
    let id = req[0]["id"].clone();
    let out = h.frame(json!({ "k": "reply", "id": id, "ok": true, "result": { "shown": 3 } }));
    let reply = out.iter().find_map(|c| match c {
        Command::Reply { token: 9, result: Ok(Value::String(s)) } => serde_json::from_str::<Value>(s).ok(),
        _ => None,
    });
    assert_eq!(reply, Some(json!({ "ok": true, "result": { "shown": 3 } })));
    let out = h.op("send", json!({ "payload": {} }), Some(10));
    assert!(out.contains(&Command::Reply { token: 10, result: Err("no type".into()) }));
}

#[test]
fn the_layout_goes_out_once_as_set_layout() {
    let (mut h, _) = H::shown();
    let geometry = json!({ "geometry": { "insets": { "left": 280, "top": 0, "right": 0, "bottom": 0 },
                                         "container": { "width": 1920, "height": 1080 }, "radius": 8, "mode": "fullscreen" } });
    let out = h.op("layout", geometry.clone(), None);
    let layouts = H::sent_kind(&out, "setLayout");
    assert_eq!(layouts.len(), 1);
    assert_eq!(layouts[0]["windowId"], 7);
    assert_eq!(layouts[0]["seq"], 1);
    assert_eq!(layouts[0]["insets"]["left"], 280);
    let out = h.op("layout", geometry, None);
    assert!(H::sent_kind(&out, "setLayout").is_empty(), "only a change");
    // The pointer over the sidebar is Margin's, over the page the page's.
    let id = h.overlay_id();
    let out = h.input(Input::Pointer { at: Point::new(500.0, 300.0), buttons: false, pressed: false });
    assert!(out.contains(&Command::SetPassThrough { id, on: true }), "{out:?}");
    let out = h.input(Input::Pointer { at: Point::new(100.0, 300.0), buttons: false, pressed: false });
    assert!(out.contains(&Command::SetPassThrough { id, on: false }));
}

#[test]
fn the_keys_only_with_the_linked_browser_in_front() {
    let (mut h, _) = H::shown();
    assert!(h.shell.hot_keys_active());
    h.now += 0.3;
    let out = h.read(300);
    assert!(out.contains(&Command::HotKeys { keys: Vec::new() }), "another app in front: let go");
    assert!(!h.shell.hot_keys_active());
    h.now += 0.3;
    h.read(EDGE);
    assert!(h.shell.hot_keys_active());
    // The palette's key: to the front overlay.
    let id = h
        .shell
        .hotkeys_sent
        .iter()
        .find(|k| k.command == AppCommand::Palette)
        .map(|k| k.id)
        .expect("the palette's key");
    let out = h.input(Input::HotKey { id, repeat: false });
    assert_eq!(H::received(&out), vec![json!({ "type": "command", "name": "palette" })]);
}

#[test]
fn a_palette_push_is_held_until_its_overlay_shows() {
    let mut h = H::linked();
    h.read_until_bound();
    h.op("hello", json!({}), Some(1));
    let out =
        h.frame(json!({ "k": "push", "epoch": "e1", "windowId": 7, "msg": { "type": "palette", "newTab": true } }));
    assert!(H::received(&out).is_empty(), "not shown yet");
    assert!(h.shell.holds_palette(&WindowKey::new("edge:p-a", 7)));
    h.op("ready", json!({}), None);
    h.now += 0.1;
    let out = h.read(EDGE);
    assert!(H::received(&out).contains(&json!({ "type": "push", "msg": { "type": "palette", "newTab": true } })));
    assert!(!h.shell.holds_palette(&WindowKey::new("edge:p-a", 7)));
}

#[test]
fn a_palette_push_for_a_window_never_shown_is_dropped() {
    let (mut h, _) = H::shown();
    h.frame(json!({ "k": "push", "epoch": "e1", "windowId": 8, "msg": { "type": "palette", "newTab": true } }));
    assert!(h.shell.holds_palette(&WindowKey::new("edge:p-a", 8)));
    let out = h.later(1.6);
    assert!(!h.shell.holds_palette(&WindowKey::new("edge:p-a", 8)));
    let reqs = H::sent_kind(&out, "req");
    assert_eq!(reqs.iter().map(|r| r["type"].clone()).collect::<Vec<_>>(), vec![json!("paletteDropped")]);
    assert_eq!(H::sent_kind(&out, "drawn").first().map(|d| d["on"].clone()), Some(json!(false)));
}

#[test]
fn a_dropped_link_keeps_its_overlays_dimmed_for_6_s() {
    let (mut h, _) = H::shown();
    let out = h.input(Input::SocketEnded { conn: 1, error: None });
    assert!(H::received(&out).contains(&json!({ "type": "link", "state": "reconnecting" })));
    assert!(h.logs().iter().any(|l| l == "link down (edge:p-a): closed by the extension (1006, no close frame)"));
    assert!(h.shell.is_reconnecting("edge:p-a"));
    assert!(!out.iter().any(|c| matches!(c, Command::DestroyOverlay { .. })));
    let out = h.later(5.0);
    assert!(!out.iter().any(|c| matches!(c, Command::DestroyOverlay { .. })), "kept for 6 s");
    let out = h.later(1.1);
    assert!(out.iter().any(|c| matches!(c, Command::DestroyOverlay { .. })), "then closed");
    assert!(h.logs().iter().any(|l| l == "edge:p-a didn't come back: its overlays closed"));
}

#[test]
fn a_relink_within_the_grace_takes_the_overlays_back() {
    let (mut h, _) = H::shown();
    h.input(Input::SocketEnded { conn: 1, error: None });
    h.now += 2.0;
    let token = h.shell.link.token().to_owned();
    h.connect(2, &token, ORIGIN);
    let out = h.say(
        2,
        json!({ "k": "hello", "v": 2, "epoch": "e2", "profile": "p-a", "browser": "edge", "pid": EDGE, "owner": true, "instanceId": "i1" }),
    );
    assert!(H::received(&out).contains(&json!({ "type": "link", "state": "linked" })));
    assert!(!h.shell.is_reconnecting("edge:p-a"));
    assert!(h.logs().iter().any(|l| l == "edge:p-a is back: its overlays kept"));
}

#[test]
fn a_goodbye_closes_at_once() {
    let (mut h, _) = H::shown();
    let out = h.frame(json!({ "k": "bye", "why": "updating" }));
    assert!(out.iter().any(|c| matches!(c, Command::DestroyOverlay { .. })));
    assert!(!h.shell.is_reconnecting("edge:p-a"));
}

#[test]
fn the_data_round_trip_through_data_sync() {
    let mut h = H::linked();
    let out =
        h.frame(json!({ "k": "data.hello", "epoch": "e1", "profile": "p-a", "format": 1, "acked": 0, "queue": [] }));
    assert_eq!(H::sent_kind(&out, "data.need").len(), 1, "no set yet: the copy's asked for its whole set");
    let out = h.frame(json!({
        "k": "data.snapshot", "epoch": "e1", "profile": "p-a", "format": 1, "transfer": "t1", "part": 0, "parts": 1,
        "set": { "format": 1, "items": { "spaces": { "s1": { "updatedAt": 5, "value": { "name": "One", "order": 0 } } } } },
    }));
    let ack = H::sent_kind(&out, "data.ack");
    assert_eq!(ack.len(), 1, "{out:?}");
    assert_eq!(ack[0]["upTo"], 5);
    let p = crate::data::store::DataProfile::new("edge", "p-a");
    assert!(h.shell.data_mut().set(&p).is_some(), "stored under the hello's browser");
}

#[test]
fn a_page_crash_reloads_it() {
    let (mut h, _) = H::shown();
    let id = h.overlay_id();
    let out = h.input(Input::PageCrashed { id });
    assert!(out.contains(&Command::HideOverlay { id }));
    assert!(out.contains(&Command::ReloadOverlay { id }));
}

#[test]
fn copy_text_and_the_theme_picker_are_commands() {
    let (mut h, _) = H::shown();
    let id = h.overlay_id();
    let out = h.op("perform", json!({ "name": "copyText", "arg": { "text": "https://example.com/" } }), None);
    assert!(out.contains(&Command::CopyText { text: "https://example.com/".into() }));
    let out = h.op("perform", json!({ "name": "theme.import", "arg": null }), None);
    assert!(out.contains(&Command::PickThemeFile { id }));
    let file = crate::data::themes::ThemeFile {
        message: json!({ "type": "themeFile", "kind": "zip", "zip": "AA==" }),
        kind: "zip",
        bytes: 1,
    };
    let out = h.input(Input::ThemeFileRead { id, file: Some(file) });
    assert_eq!(H::received(&out), vec![json!({ "type": "themeFile", "kind": "zip", "zip": "AA==" })]);
}

#[test]
fn only_visibility_changes_are_told_apart() {
    let a = obj(json!({ "windowId": 1, "state": "fullscreen", "visible": true, "visibleAt": 1 }));
    let b = obj(json!({ "windowId": 1, "state": "fullscreen", "visible": false, "visibleAt": 2 }));
    let c = obj(json!({ "windowId": 1, "state": "normal" }));
    assert!(only_visibility_changed(std::slice::from_ref(&a), std::slice::from_ref(&b)));
    assert!(!only_visibility_changed(&[a], &[c]));
    assert!(!only_visibility_changed(&[], &[]));
}

#[test]
fn each_link_binds_only_its_browser_process_windows() {
    let mut h = H::linked();
    // Chrome's own relay and copy, its window at the same bounds as Edge's.
    h.relay(2, "chrome", 200, false);
    let token = h.want_link(2)["token"].as_str().unwrap_or("").to_owned();
    h.connect(2, &token, ORIGIN);
    let say = |v: Value| Input::SocketBytes { conn: 2, bytes: client_frame(1, v.to_string().as_bytes(), true) };
    h.input(say(json!({ "k": "hello", "v": 2, "epoch": "c1", "profile": "p-b", "browser": "chrome", "pid": 200, "owner": true })));
    h.input(say(json!({
        "k": "snapshot", "epoch": "c1", "seq": 1, "state": { "settings": {} },
        "windows": [{ "windowId": 3, "left": 0, "top": 0, "width": 1920, "height": 1080, "state": "fullscreen", "focused": true }],
    })));
    assert_eq!(h.shell.link_keys(), vec!["chrome:p-b".to_string(), "edge:p-a".to_string()]);
    for _ in 0..40 {
        h.now += 0.25;
        let mut edge = ServerWindow::new(BROWSER_WINDOW, EDGE, SCREEN);
        edge.order = 0;
        let mut chrome = ServerWindow::new(6001, 200, SCREEN);
        chrome.order = 1;
        h.input(Input::Windows(WindowRead {
            list: vec![edge, chrome],
            front_pid: Some(EDGE),
            front_window: Some(BROWSER_WINDOW),
            browsers: vec![
                BrowserProcess { pid: EDGE, browser: "edge".into(), root: EDGE },
                BrowserProcess { pid: 200, browser: "chrome".into(), root: 200 },
            ],
            displays: vec![Display { frame: SCREEN, top_inset: 0.0 }],
        }));
        if h.shell.bindings().len() == 2 {
            break;
        }
    }
    assert_eq!(h.shell.bindings().get(&WindowKey::new("edge:p-a", 7)), Some(&BROWSER_WINDOW));
    assert_eq!(h.shell.bindings().get(&WindowKey::new("chrome:p-b", 3)), Some(&6001));
}

#[test]
fn bad_input_is_lived_with() {
    let mut h = H::new();
    h.input(Input::SocketBytes { conn: 5, bytes: b"not json".to_vec() });
    h.input(Input::RelayBytes { conn: 5, bytes: b"not json\n".to_vec() });
    h.input(Input::SocketOpened { conn: 6 });
    h.input(Input::SocketBytes { conn: 6, bytes: vec![0xff; 20_000] });
    h.input(Input::RelayOpened { conn: 6 });
    h.input(Input::RelayBytes { conn: 6, bytes: b"[]\n".to_vec() });
    h.input(Input::SocketEnded { conn: 6, error: Some("reset".into()) });
    h.input(Input::RelayEnded { conn: 6 });
    h.input(Input::PageOp { id: 42, op: "hello".into(), body: Object::new(), reply: Some(1) });
    h.input(Input::HotKey { id: 7, repeat: true });
    h.input(Input::OverlayFocus { id: 3, has: false });
    h.input(Input::ThemeFileRead { id: 3, file: None });
    h.input(Input::Windows(WindowRead::default()));
    h.later(100.0);
}

#[test]
fn a_windowed_window_gets_an_overlay_over_its_page_area_with_windowed_too() {
    // Chrome on Windows, not in full screen: windows.get's bounds have the invisible borders the OS's frame hasn't.
    let window = json!({ "windowId": 7, "left": 93, "top": 50, "width": 1214, "height": 807, "state": "normal",
                         "focused": true, "viewport": { "x": 16, "y": 97, "width": 1198, "height": 710 } });
    let mut h = H::linked_with(H::with(|o| o.windowed_too = true), window.clone());
    h.server = Rect::new(100.0, 50.0, 1200.0, 800.0);
    h.read_until_bound();
    assert_eq!(H::sent_kind(&h.log, "drawn").last().map(|d| d["on"].clone()), Some(json!(true)), "drawn over it");
    let hello = h.op("hello", json!({}), Some(1));
    let hello = hello
        .iter()
        .find_map(|c| match c {
            Command::Reply { token: 1, result: Ok(Value::String(s)) } => serde_json::from_str::<Value>(s).ok(),
            _ => None,
        })
        .expect("the hello answered");
    assert_eq!(hello["mode"], "windowed");
    h.op("ready", json!({}), Some(2));
    h.now += 0.05;
    let out = h.read(EDGE);
    let page = Rect::new(101.0, 139.0, 1198.0, 710.0);
    assert!(
        out.iter().any(|c| matches!(c, Command::ShowOverlay { frame, .. } if *frame == page)),
        "over the page area, under the toolbar: {out:?}"
    );
    // A sidebar 280 wide in the overlay: the copy, taking its page to start 16 in and 97 down, boxes it at 280.
    let geometry = json!({ "geometry": { "insets": { "left": 280, "top": 0, "right": 0, "bottom": 0 },
                                         "container": { "width": 1198, "height": 710 }, "radius": 0, "mode": "windowed" } });
    let layouts = H::sent_kind(&h.op("layout", geometry, None), "setLayout");
    assert_eq!(layouts.len(), 1, "{:?}", h.logs());
    let l = &layouts[0];
    assert_eq!((l["insets"]["left"].as_f64(), l["insets"]["top"].as_f64()), (Some(296.0), Some(97.0)));
    assert_eq!((l["insets"]["right"].as_f64(), l["insets"]["bottom"].as_f64()), (Some(0.0), Some(0.0)));
    assert_eq!((l["container"]["width"].as_f64(), l["container"]["height"].as_f64()), (Some(1214.0), Some(807.0)));
}

#[test]
fn a_windowed_window_gets_no_overlay_without_windowed_too() {
    let window = json!({ "windowId": 7, "left": 93, "top": 50, "width": 1214, "height": 807, "state": "normal", "focused": true });
    let mut h = H::linked_with(H::new(), window);
    h.server = Rect::new(100.0, 50.0, 1200.0, 800.0);
    for _ in 0..12 {
        h.now += 0.25;
        h.read(EDGE);
    }
    assert!(!h.log.iter().any(|c| matches!(c, Command::ShowOverlay { .. })), "the Mac's rule: full screen only");
}

#[test]
fn a_relay_says_hello_and_is_welcomed() {
    let mut h = H::new();
    let out = h.relay(1, "edge", EDGE, false);
    assert_eq!(H::relay_lines(&out, 1), vec![json!({ "k": "relayWelcome", "v": 1, "version": "9.9" })]);
    // A relay that had to wait for the app: told appUp once in, as Safari's copies are when the app starts.
    let out = h.relay(2, "chrome", 200, true);
    let lines = H::relay_lines(&out, 2);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1]["name"], "appUp");
    // Its first word not a relay's hello: closed.
    h.input(Input::RelayOpened { conn: 3 });
    let out = h.relay_says(3, json!({ "msg": { "type": "ping" } }));
    assert!(out.contains(&Command::RelayEnd { conn: 3 }));
}

#[test]
fn want_link_is_answered_then_the_link_dispatched_with_the_sockets_port_token_and_key() {
    let mut h = H::new();
    h.relay(1, "edge", EDGE, false);
    h.relay(2, "edge", EDGE, false); // the copy's lasting port: another relay of the same process
    h.relay(3, "chrome", 200, false);
    let out = h.relay_says(1, json!({ "msg": { "type": "wantLink", "nonce": "n1" } }));
    let reply = H::relay_lines(&out, 1);
    assert_eq!(reply[0], json!({ "ok": true, "appOpen": true, "launching": false, "browser": "edge", "pid": EDGE }));
    for relay in [1, 2] {
        let link = H::relay_lines(&out, relay).into_iter().find(|m| m["name"] == "link").expect("dispatched");
        let e: Value = serde_json::from_str(link["userInfo"]["e"].as_str().unwrap_or("")).unwrap_or(Value::Null);
        assert_eq!(e["v"], 2);
        assert_eq!(e["nonce"], "n1");
        assert_eq!(e["port"], PORT);
        assert_eq!(e["token"], h.shell.link.token());
        assert_eq!(e["key"], h.shell.link.key());
        assert_eq!(e["app"], json!({ "version": "9.9" }));
    }
    assert!(H::relay_lines(&out, 3).is_empty(), "not into another browser process's relays");
    assert!(h.logs().iter().any(|l| l == &format!("wantLink: link handed to Edge (port {PORT}, #1)")));
    assert!(h.logs().iter().any(|l| l == "link #1 reached the extension"));
    // A log line from a copy: the app's log.
    h.relay_says(3, json!({ "msg": { "type": "log", "line": "kept link try 1 of 3" } }));
    assert!(h.logs().iter().any(|l| l == "chrome: kept link try 1 of 3"));
}

#[test]
fn a_want_link_before_the_listener_has_its_port_waits_for_it() {
    let mut h = H::new();
    h.input(Input::Listening { port: None });
    h.relay(1, "edge", EDGE, false);
    let out = h.relay_says(1, json!({ "msg": { "type": "wantLink", "nonce": "n1" } }));
    assert_eq!(H::relay_lines(&out, 1).len(), 1, "answered, the link not yet");
    let out = h.input(Input::Listening { port: Some(PORT + 1) });
    let link = H::relay_lines(&out, 1).into_iter().find(|m| m["name"] == "link").expect("then dispatched");
    let e: Value = serde_json::from_str(link["userInfo"]["e"].as_str().unwrap_or("")).unwrap_or(Value::Null);
    assert_eq!(e["port"], PORT + 1, "the new port");
}

#[test]
fn a_wrong_token_or_origin_is_turned_away_with_403() {
    let mut h = H::new();
    h.relay(1, "edge", EDGE, false);
    let token = h.want_link(1)["token"].as_str().unwrap_or("").to_owned();
    let refused = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
    let out = h.connect(5, "nope", ORIGIN);
    assert_eq!(H::written(&out, 5), refused, "a wrong token");
    assert!(out.contains(&Command::End { conn: 5 }));
    assert!(H::sent_kind(&out, "welcome").is_empty());
    let out = h.connect(6, &token, "https://evil.example");
    assert_eq!(H::written(&out, 6), refused, "a web page's Origin");
    assert!(h.logs().iter().any(|l| l == "socket refused: wrong token"));
    assert!(h.logs().iter().any(|l| l == "socket refused: not from Margin's extension"));
    assert!(h.shell.link_keys().is_empty());
    // The right ones: welcomed.
    let out = h.connect(7, &token, ORIGIN);
    assert!(H::written(&out, 7).starts_with(b"HTTP/1.1 101 Switching Protocols\r\n"));
    assert_eq!(H::sent_kind(&out, "welcome").len(), 1);
}

#[test]
fn quitting_says_bye_on_the_socket_and_closes_the_relays() {
    let (mut h, _) = H::shown();
    let out = h.input(Input::Stop { why: "Margin quit".into() });
    assert_eq!(H::sent_kind(&out, "bye"), vec![json!({ "k": "bye", "why": "Margin quit" })]);
    assert!(out.contains(&Command::End { conn: 1 }));
    assert!(out.contains(&Command::RelayEnd { conn: 1 }));
}
