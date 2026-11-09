//! The shell's scenarios, with fake inputs: a relay links, the copy says hello and its state, the windows are read, an
//! overlay is made, shown and talks to its page, the keys are held, the link drops.

use serde_json::{Value, json};

use super::*;
use crate::geometry::Rect;
use crate::planner::Display;
use crate::system::ServerWindow;

const EDGE: u32 = 100;
const BROWSER_WINDOW: i64 = 5001;
const SCREEN: Rect = Rect::new(0.0, 0.0, 1920.0, 1080.0);
const T0: Secs = 1_800_000_000.0;

struct H {
    shell: Shell,
    now: Secs,
    _dir: tempfile::TempDir,
    log: Vec<Command>,
}

fn obj(v: Value) -> Object {
    v.as_object().cloned().unwrap_or_default()
}

impl H {
    fn new() -> Self {
        let dir = tempfile::Builder::new().prefix("margin-shell-").tempdir().expect("a temporary folder");
        let mut opts = Options::new(dir.path().join("data"), dir.path().join("themes"));
        opts.own_pid = 999;
        let mut shell = Shell::new(opts);
        let clock = std::sync::Arc::new(std::sync::Mutex::new(T0));
        let c = clock.clone();
        shell.data_mut().now = Box::new(move || c.lock().map(|t| *t * 1000.0).unwrap_or(0.0));
        Self { shell, now: T0, _dir: dir, log: Vec::new() }
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

    fn frame(&mut self, v: Value) -> Vec<Command> {
        self.input(Input::RelayFrame { conn: 1, text: v.to_string() })
    }

    fn read(&mut self, front: u32) -> Vec<Command> {
        let mut w = ServerWindow::new(BROWSER_WINDOW, EDGE, SCREEN);
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

    fn sent(out: &[Command]) -> Vec<Value> {
        out.iter()
            .filter_map(|c| if let Command::Send { text, .. } = c { serde_json::from_str(text).ok() } else { None })
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

    /// A relay of Edge's linked, its copy (saying `chrome`, as Edge's may) linked with its state, theme and one
    /// full-screen window.
    fn linked() -> Self {
        let mut h = H::new();
        let out = h.input(Input::RelayConnected {
            conn: 1,
            relay: RelayFacts { browser: "edge".into(), pid: Some(EDGE), origin: "chrome-extension://x/".into() },
        });
        assert_eq!(H::sent_kind(&out, "welcome").len(), 1, "welcome first");
        h.frame(json!({ "k": "hello", "v": 2, "epoch": "e1", "profile": "p-a", "browser": "chrome", "owner": true, "instanceId": "i1" }));
        assert_eq!(h.shell.link_keys(), vec!["edge:p-a".to_string()], "the relay's browser wins");
        h.frame(json!({
            "k": "snapshot", "epoch": "e1", "seq": 1,
            "state": { "settings": {}, "spaces": [{ "id": "s1", "name": "One" }], "openTabs": { "activeSpaceByWindow": { "7": "s1" } } },
            "windows": [{ "windowId": 7, "left": 0, "top": 0, "width": 1920, "height": 1080, "state": "fullscreen", "focused": true }],
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
fn a_relay_links_and_an_overlay_shows_with_its_hello() {
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
    let out = h.input(Input::RelayClosed { conn: 1, why: "the relay went".into() });
    assert!(H::received(&out).contains(&json!({ "type": "link", "state": "reconnecting" })));
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
    h.input(Input::RelayClosed { conn: 1, why: "the relay went".into() });
    h.now += 2.0;
    h.input(Input::RelayConnected {
        conn: 2,
        relay: RelayFacts { browser: "edge".into(), pid: Some(EDGE), origin: "chrome-extension://x/".into() },
    });
    let out = h.input(Input::RelayFrame {
        conn: 2,
        text: json!({ "k": "hello", "v": 2, "epoch": "e2", "profile": "p-a", "browser": "chrome", "owner": true, "instanceId": "i1" })
            .to_string(),
    });
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
    assert!(h.shell.data_mut().set(&p).is_some(), "stored under the relay's browser");
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
fn bad_input_is_lived_with() {
    let mut h = H::new();
    h.input(Input::RelayFrame { conn: 5, text: "not json".into() });
    h.input(Input::PageOp { id: 42, op: "hello".into(), body: Object::new(), reply: Some(1) });
    h.input(Input::HotKey { id: 7, repeat: true });
    h.input(Input::OverlayFocus { id: 3, has: false });
    h.input(Input::ThemeFileRead { id: 3, file: None });
    h.input(Input::Windows(WindowRead::default()));
    h.later(100.0);
}
