//! What Margin's extension and the app say on their link, version 2 (app/platforms/macos/shell/LinkMessage.swift; docs/PROTOCOL.md
//! describes every message and the order they come in): one JSON object per message, `k` naming its kind.
//! [`LinkMessage`] is what an extension copy sends, [`AppMessage`] what the app does. The state comes as the
//! extension's stored values, left as they are ([`crate::mirror::StateMirror`] keeps them).
//!
//! Everything here reads untrusted JSON without panicking: a message that lacks what its kind needs isn't one
//! (`None`), and a kind not known is [`LinkMessage::Other`] (a newer extension's: left). Nothing the app sends is
//! over 1 MB ([`MAX_APP_MESSAGE`]: Chrome closes a native port on a bigger message from the host):
//! [`AppMessage::encode`] refuses it rather than send it.

use crate::geometry::Rect;
use crate::json::{self, Object};
use serde_json::Value;
use std::collections::BTreeMap;

/// `LinkProtocol.version`.
pub const VERSION: i64 = 2;
/// `LinkProtocol.maxAppMessage`: the largest message the app sends, as UTF-8 JSON (Chrome closes a native port on a
/// bigger one from the host; the same cap is kept for every browser).
pub const MAX_APP_MESSAGE: usize = 1_000_000;
/// The largest message the app takes in (LinkSocket.swift `FrameReader.maxMessage`; Chrome's own limit to a host is
/// 64 MB): a first snapshot holds every site icon.
pub const MAX_INCOMING: usize = 64 * 1024 * 1024;
/// `LinkProtocol.chunkBytes`: a chunk's bytes before base64 (about 683 KB as text, well inside the 1 MB cap).
pub const CHUNK_BYTES: usize = 512 * 1024;
/// `LinkProtocol.maxThemeBytes`: the largest theme taken in chunks (ui/theme-loader.ts stores at most 4.5 MB).
pub const MAX_THEME_BYTES: usize = 8 * 1024 * 1024;
/// The most pieces one whole is cut into (`Chunk`'s `parts`).
pub const MAX_PARTS: usize = 64;

/// A number as JSON, the way JSONSerialization writes it: a whole number as an integer, else as a float. `None`
/// for one that isn't finite (not JSON: Swift's `isValidJSONObject` refuses the message).
pub fn number(v: f64) -> Option<Value> {
    if !v.is_finite() {
        return None;
    }
    if v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 {
        return Some(Value::from(v as i64));
    }
    serde_json::Number::from_f64(v).map(Value::Number)
}

fn count(s: &str) -> usize {
    s.chars().count()
}

/// `PageLayout`: where the theme put the page in one browser window (ui/host.ts Geometry): `<m-page>`'s content box
/// as insets from the window's edges, in points (CSS pixels at zoom 1 in the overlay, which is exactly over the
/// window).
#[derive(Clone, Debug, PartialEq)]
pub struct PageLayout {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub radius: f64,
    /// Top-left, top-right, bottom-right, bottom-left.
    pub radii: Vec<f64>,
    /// The overlay's (the window's) size it was measured at.
    pub width: f64,
    pub height: f64,
    pub mode: String,
}

impl PageLayout {
    /// `init?(geometry:)`: from the page's report (`{ insets, radius, radii, container, mode }`); `None` if it isn't
    /// one (insets and a positive size needed).
    pub fn from_geometry(g: &Object) -> Option<Self> {
        let insets = json::object(g.get("insets"))?;
        let left = json::num(insets.get("left"))?;
        let top = json::num(insets.get("top"))?;
        let right = json::num(insets.get("right"))?;
        let bottom = json::num(insets.get("bottom"))?;
        let container = json::object(g.get("container"))?;
        let width = json::num(container.get("width"))?;
        let height = json::num(container.get("height"))?;
        if !(width > 0.0 && height > 0.0) {
            return None;
        }
        let radius = json::num(g.get("radius")).unwrap_or(0.0);
        let radii: Vec<f64> = json::array(g.get("radii"))
            .map(|a| a.iter().filter_map(|v| json::num(Some(v))).collect())
            .unwrap_or_default();
        Some(Self {
            left,
            top,
            right,
            bottom,
            radius: radius.max(0.0),
            // (As the Swift: four radii or the radius as given, before it's kept from going below 0.)
            radii: if radii.len() == 4 { radii } else { vec![radius; 4] },
            width,
            height,
            mode: json::string(g.get("mode")).unwrap_or("fullscreen").to_owned(),
        })
    }

    /// `inWindow(overlay:window:)`: measured in an overlay at `overlay` over a window at `window` (both top left),
    /// the insets from the window's edges, as setLayout carries them. The overlay is the window, unless the browser
    /// takes part of it (a docked inspector: Shell.overlayFrame).
    pub fn in_window(&self, overlay: Rect, window: Rect) -> PageLayout {
        if overlay == window {
            return self.clone();
        }
        PageLayout {
            left: self.left + (overlay.min_x() - window.min_x()),
            top: self.top + (overlay.min_y() - window.min_y()),
            right: self.right + (window.max_x() - overlay.max_x()),
            bottom: self.bottom + (window.max_y() - overlay.max_y()),
            radius: self.radius,
            radii: self.radii.clone(),
            width: window.width,
            height: window.height,
            mode: self.mode.clone(),
        }
    }

    /// `rounded`: to half a point, what the page box can show (and what's compared before sending again).
    pub fn rounded(&self) -> PageLayout {
        let half = |v: f64| (v * 2.0).round() / 2.0;
        PageLayout {
            left: half(self.left),
            top: half(self.top),
            right: half(self.right),
            bottom: half(self.bottom),
            radius: half(self.radius),
            radii: self.radii.iter().map(|&r| half(r)).collect(),
            width: half(self.width),
            height: half(self.height),
            mode: self.mode.clone(),
        }
    }

    /// `object`: as setLayout carries it. `None` if a number isn't finite.
    pub fn object(&self) -> Option<Object> {
        let mut insets = Object::new();
        insets.insert("left".into(), number(self.left)?);
        insets.insert("top".into(), number(self.top)?);
        insets.insert("right".into(), number(self.right)?);
        insets.insert("bottom".into(), number(self.bottom)?);
        let mut container = Object::new();
        container.insert("width".into(), number(self.width)?);
        container.insert("height".into(), number(self.height)?);
        let radii = self.radii.iter().map(|&r| number(r)).collect::<Option<Vec<_>>>()?;
        let mut o = Object::new();
        o.insert("insets".into(), Value::Object(insets));
        o.insert("radius".into(), number(self.radius)?);
        o.insert("radii".into(), Value::Array(radii));
        o.insert("container".into(), Value::Object(container));
        o.insert("mode".into(), Value::from(self.mode.clone()));
        Some(o)
    }
}

/// `Chunk`: one piece of something too big for one message (a theme package): its bytes are the UTF-8 JSON of the
/// whole, cut in order, each piece as base64.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    /// The theme's id.
    pub id: String,
    /// The whole's SHA-256, hex: which pieces belong together.
    pub transfer: String,
    /// From 0.
    pub part: usize,
    pub parts: usize,
    /// The whole's bytes.
    pub size: usize,
    /// This piece, base64.
    pub data: String,
}

impl Chunk {
    /// `init?(_ m:)`: an id of 1–64 characters, a 64-character transfer, 1–64 parts, a part among them, a size of
    /// 0 or more, the data as a string. `None`: not a chunk.
    pub fn from_object(m: &Object) -> Option<Self> {
        let id = json::string(m.get("id")).filter(|s| !s.is_empty() && count(s) <= 64)?;
        let transfer = json::string(m.get("transfer")).filter(|s| count(s) == 64)?;
        let part = json::int(m.get("part"))?;
        let parts = json::int(m.get("parts"))?;
        if !(1..=MAX_PARTS as i64).contains(&parts) || !(0..parts).contains(&part) {
            return None;
        }
        let size = usize::try_from(json::int(m.get("size"))?).ok()?;
        let data = json::string(m.get("data"))?;
        Some(Self {
            id: id.to_owned(),
            transfer: transfer.to_owned(),
            part: part as usize,
            parts: parts as usize,
            size,
            data: data.to_owned(),
        })
    }

    /// `fields`: the chunk's own fields, as a `theme` message carries them.
    pub fn fields(&self) -> Object {
        let mut o = Object::new();
        o.insert("id".into(), Value::from(self.id.clone()));
        o.insert("transfer".into(), Value::from(self.transfer.clone()));
        o.insert("part".into(), Value::from(self.part));
        o.insert("parts".into(), Value::from(self.parts));
        o.insert("size".into(), Value::from(self.size));
        o.insert("data".into(), Value::from(self.data.clone()));
        o
    }
}

/// `LinkMessage.Hello`: who a copy is.
#[derive(Clone, Debug, PartialEq)]
pub struct Hello {
    pub epoch: String,
    /// The browser profile this copy runs in (one link per profile).
    pub profile: String,
    /// "safari", "chrome" or "edge".
    pub browser: String,
    /// The extension's version.
    pub ext: Option<String>,
    /// The copy in charge of the state in its profile.
    pub owner: bool,
    pub instance_id: Option<String>,
    /// The copy whose ids the state has.
    pub origin: Option<String>,
    pub since: Option<f64>,
    /// The browser's process, if the copy knows it (Chrome's relay helper does).
    pub pid: Option<i64>,
    /// What the copy says of a time its link was off (its socket guard, background/link.ts), for the log: at most
    /// 200 characters.
    pub sockets_off: Option<String>,
}

impl Hello {
    /// `key`: the link's key, `browser:profile` (one link per browser profile).
    pub fn key(&self) -> String {
        format!("{}:{}", self.browser, self.profile)
    }

    /// Which copy of Margin this is, as Shell.swift hands it to the window binder (`copies`): its instanceId, else
    /// its `since`, else the epoch. A new one may have new window ids, so its bindings go (WindowMatcher.swift).
    pub fn copy_id(&self) -> String {
        if let Some(id) = &self.instance_id {
            return id.clone();
        }
        if let Some(since) = self.since {
            return format!("{since}");
        }
        self.epoch.clone()
    }
}

/// `LinkMessage.profilePattern`: `^[A-Za-z0-9_.:-]{1,64}$`.
pub fn is_profile_id(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// The browsers a hello may name.
pub const BROWSERS: [&str; 3] = ["safari", "chrome", "edge"];

/// `LinkMessage.Change`: a stored key in a delta: its new value, or gone.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Set(Value),
    Removed,
}

/// `LinkMessage.Favicons`: the site icons as a diff.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Favicons {
    pub set: Object,
    pub del: Vec<String>,
}

/// `LinkMessage`: what a copy sends.
#[derive(Clone, Debug, PartialEq)]
pub enum LinkMessage {
    Hello(Hello),
    Snapshot {
        epoch: String,
        seq: i64,
        state: Object,
        windows: Vec<Object>,
    },
    Delta {
        epoch: String,
        seq: i64,
        changes: BTreeMap<String, Change>,
        favicons: Option<Favicons>,
    },
    Windows {
        epoch: String,
        seq: i64,
        list: Vec<Object>,
    },
    /// Something for one window's UI (or every window's, with no window id): a notice, a switch under way.
    Push {
        epoch: String,
        window_id: Option<i64>,
        msg: Object,
    },
    /// `parkedActivity`: a parked window used while it's out of sight (HANDOFF.md §6.1): a `push` of that type,
    /// taken out here because it's for the app, never for an overlay.
    ParkedActivity {
        epoch: String,
        activity: ParkedActivity,
    },
    Theme {
        epoch: String,
        chunk: Chunk,
    },
    /// The copy's shortcuts for the app's hot keys: `{ command: [combination] }` (Shortcuts.swift).
    Keys {
        epoch: String,
        bindings: BTreeMap<String, Vec<String>>,
    },
    /// The answer to a `req`: the message without `k` and `id`.
    Reply {
        id: i64,
        body: Object,
    },
    Tock,
    Bye {
        why: String,
    },
    /// The lasting data (docs/DATA.md "Messages": data.hello, data.snapshot, data.changes), as it came.
    Data {
        kind: String,
        body: Object,
    },
    /// `other`: a kind this app doesn't know (a newer extension): left.
    Other(String),
}

impl LinkMessage {
    /// `decode`: `None` if it's not a message (not JSON, or what its kind needs is missing).
    pub fn decode(text: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(text).ok()?;
        Self::from_value(&value)
    }

    /// As [`LinkMessage::decode`], from JSON already read.
    pub fn from_value(value: &Value) -> Option<Self> {
        let m = value.as_object()?;
        let k = json::string(m.get("k"))?;
        let epoch = json::string(m.get("epoch")).map(str::to_owned);
        let seq = json::int(m.get("seq"));
        if k.starts_with("data.") {
            return Some(Self::Data { kind: k.to_owned(), body: m.clone() });
        }
        match k {
            "hello" => {
                if json::int(m.get("v")) != Some(VERSION) {
                    return None;
                }
                let epoch = epoch.filter(|e| !e.is_empty())?;
                let profile = json::string(m.get("profile")).filter(|p| is_profile_id(p))?;
                let browser = json::string(m.get("browser")).filter(|b| BROWSERS.contains(b))?;
                let text = |key: &str| json::string(m.get(key)).map(str::to_owned);
                Some(Self::Hello(Hello {
                    epoch,
                    profile: profile.to_owned(),
                    browser: browser.to_owned(),
                    ext: text("ext"),
                    owner: json::boolean(m.get("owner")).unwrap_or(false),
                    instance_id: text("instanceId"),
                    origin: text("origin"),
                    since: json::num(m.get("since")),
                    pid: json::int(m.get("pid")),
                    sockets_off: json::string(m.get("socketsOff")).map(|s| s.chars().take(200).collect()),
                }))
            }
            "snapshot" => {
                let state = json::object(m.get("state"))?.clone();
                // Not a list of objects (any one not an object): none.
                let windows = objects(m.get("windows")).unwrap_or_default();
                Some(Self::Snapshot { epoch: epoch?, seq: seq?, state, windows })
            }
            "delta" => {
                let (epoch, seq) = (epoch?, seq?);
                let raw = json::object(m.get("changes"))?;
                let mut changes = BTreeMap::new();
                for (key, change) in raw {
                    // storage.onChanged's { newValue }, with no newValue for a key removed.
                    let change = change.as_object()?;
                    let change = change.get("newValue").map_or(Change::Removed, |v| Change::Set(v.clone()));
                    changes.insert(key.clone(), change);
                }
                let favicons = json::object(m.get("favicons")).map(|f| Favicons {
                    set: json::object(f.get("set")).cloned().unwrap_or_default(),
                    del: strings(f.get("del")).unwrap_or_default(),
                });
                Some(Self::Delta { epoch, seq, changes, favicons })
            }
            "windows" => {
                let (epoch, seq) = (epoch?, seq?);
                Some(Self::Windows { epoch, seq, list: objects(m.get("list"))? })
            }
            "push" => {
                let epoch = epoch?;
                let msg = json::object(m.get("msg"))?;
                let window_id = json::int(m.get("windowId"));
                if json::string(msg.get("type")) == Some(ParkedActivity::TYPE) {
                    let activity = ParkedActivity::from_msg(msg, window_id)?;
                    return Some(Self::ParkedActivity { epoch, activity });
                }
                Some(Self::Push { epoch, window_id, msg: msg.clone() })
            }
            "theme" => {
                let epoch = epoch?;
                Some(Self::Theme { epoch, chunk: Chunk::from_object(m)? })
            }
            "keys" => {
                let epoch = epoch?;
                let raw = json::object(m.get("bindings"))?;
                let mut bindings = BTreeMap::new();
                for (command, list) in raw {
                    let Some(list) = list.as_array() else { continue };
                    let combos = list.iter().filter_map(Value::as_str).filter(|s| count(s) <= 64).take(8);
                    bindings.insert(command.clone(), combos.map(str::to_owned).collect());
                }
                Some(Self::Keys { epoch, bindings })
            }
            "reply" => {
                let id = json::int(m.get("id"))?;
                let mut body = m.clone();
                body.remove("k");
                body.remove("id");
                Some(Self::Reply { id, body })
            }
            "tock" => Some(Self::Tock),
            "bye" => Some(Self::Bye { why: json::string(m.get("why")).unwrap_or("").to_owned() }),
            other => Some(Self::Other(other.to_owned())),
        }
    }
}

/// Swift's `as? [JSONObject]`: every element an object, else none.
fn objects(v: Option<&Value>) -> Option<Vec<Object>> {
    json::array(v)?.iter().map(|v| v.as_object().cloned()).collect()
}

/// Swift's `as? [String]`: every element a string, else none.
fn strings(v: Option<&Value>) -> Option<Vec<String>> {
    json::array(v)?.iter().map(|v| v.as_str().map(str::to_owned)).collect()
}

/// `AppMessage`: what the app sends.
#[derive(Clone, Debug, PartialEq)]
pub enum AppMessage {
    /// First, on a connection the app accepted. Over the WebSocket its `key` is the app's proof that it's the app
    /// (Transport, step 4). **Provisional:** over the Chromium relay (a named pipe on Windows) the pipe's own
    /// security stands in for the token and key, so `key` is optional and left out when `None`; settle this when
    /// the macOS Chromium link lands (docs/windows/BRIEF.md, plan step 2).
    Welcome {
        key: Option<String>,
    },
    /// Every 5 s; the copy answers `tock`.
    Tick,
    /// An action from a window's UI, answered with `reply` (the same id).
    Req {
        id: i64,
        epoch: String,
        window_id: Option<i64>,
        kind: String,
        payload: Object,
    },
    /// A `seq` was missed: send a snapshot.
    Resync {
        epoch: String,
    },
    /// Where the theme put the page in a window. `seq` counts up per window, per epoch.
    SetLayout {
        epoch: String,
        window_id: i64,
        seq: i64,
        layout: PageLayout,
    },
    /// Whether the app draws over a window (bound and wanted: Shell.swift DrawnOutbox). Only a change is sent.
    Drawn {
        epoch: String,
        window_id: i64,
        on: bool,
    },
    /// Whether a window is parked: out of sight, alive (HANDOFF.md §2.5). Only a change is sent, like drawn.
    Parked {
        epoch: String,
        window_id: i64,
        on: bool,
    },
    Theme {
        epoch: String,
        chunk: Chunk,
    },
    /// The lasting data (docs/DATA.md "Messages": data.need, data.snapshot, data.changes, data.ack).
    Data {
        kind: String,
        body: Object,
    },
    Bye {
        why: String,
    },
}

impl AppMessage {
    /// `object`, with `at_ms` for the messages that carry a time (`Date.now()`, milliseconds; rounded). `None` if
    /// a number isn't finite (not JSON).
    pub fn object(&self, at_ms: f64) -> Option<Object> {
        let at = number(at_ms.round())?;
        let mut o = Object::new();
        let mut put = |k: &str, v: Value| {
            o.insert(k.to_owned(), v);
        };
        match self {
            Self::Welcome { key } => {
                put("k", "welcome".into());
                put("v", VERSION.into());
                if let Some(key) = key {
                    put("key", key.clone().into());
                }
            }
            Self::Tick => {
                put("k", "tick".into());
                put("at", at);
            }
            Self::Req { id, epoch, window_id, kind, payload } => {
                put("k", "req".into());
                put("id", (*id).into());
                put("epoch", epoch.clone().into());
                put("at", at);
                put("windowId", window_id.map_or(Value::Null, Value::from));
                put("type", kind.clone().into());
                put("payload", Value::Object(payload.clone()));
            }
            Self::Resync { epoch } => {
                put("k", "resync".into());
                put("epoch", epoch.clone().into());
            }
            Self::SetLayout { epoch, window_id, seq, layout } => {
                for (k, v) in layout.object()? {
                    put(&k, v);
                }
                put("k", "setLayout".into());
                put("epoch", epoch.clone().into());
                put("windowId", (*window_id).into());
                put("seq", (*seq).into());
                put("at", at);
            }
            Self::Drawn { epoch, window_id, on } | Self::Parked { epoch, window_id, on } => {
                put("k", if matches!(self, Self::Drawn { .. }) { "drawn" } else { "parked" }.into());
                put("epoch", epoch.clone().into());
                put("windowId", (*window_id).into());
                put("on", (*on).into());
                put("at", at);
            }
            Self::Theme { epoch, chunk } => {
                for (k, v) in chunk.fields() {
                    put(&k, v);
                }
                put("k", "theme".into());
                put("epoch", epoch.clone().into());
            }
            Self::Data { kind, body } => {
                for (k, v) in body {
                    put(k, v.clone());
                }
                put("k", kind.clone().into());
            }
            Self::Bye { why } => {
                put("k", "bye".into());
                put("why", why.clone().into());
            }
        }
        Some(o)
    }

    /// `encode`: the message as UTF-8 JSON text; `None` if it isn't JSON or would be over [`MAX_APP_MESSAGE`]
    /// bytes (refused rather than sent).
    pub fn encode(&self, at_ms: f64) -> Option<String> {
        encode_object(&self.object(at_ms)?)
    }
}

/// An object as the app sends it: `None` if over [`MAX_APP_MESSAGE`] bytes.
pub fn encode_object(o: &Object) -> Option<String> {
    let text = serde_json::to_string(o).ok()?;
    (text.len() <= MAX_APP_MESSAGE).then_some(text)
}

// ---- The profile handoff's words (HANDOFF.md §1.9, §2.5, §3.3, §6.1; docs/PROTOCOL.md "The handoff") ----

/// `ParkedActivity.Why`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParkedWhy {
    Tab,
    Focus,
    Raise,
}

impl ParkedWhy {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "tab" => Some(Self::Tab),
            "focus" => Some(Self::Focus),
            "raise" => Some(Self::Raise),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tab => "tab",
            Self::Focus => "focus",
            Self::Raise => "raise",
        }
    }
}

/// `ParkedActivity`: a copy's word that one of its parked windows was used while out of sight: a tab made there
/// that Margin didn't open (`tab`), focus landing there that Margin didn't cause (`focus`), or Margin's own UI
/// asking for a tab that's only there (`raise`: the copy doesn't raise it, the app hands off to that window). Sent
/// as a `push` whose msg is `{ type: 'parkedActivity', windowId, tabId?, why }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParkedActivity {
    pub window_id: i64,
    pub tab_id: Option<i64>,
    pub why: ParkedWhy,
}

impl ParkedActivity {
    pub const TYPE: &'static str = "parkedActivity";

    /// `init?(_ msg:windowId:)`: from the push's msg (the push's own window id stands in when the msg has none, and
    /// must agree when both say). A tab's and a raise's need their tab. `None`: not one.
    pub fn from_msg(msg: &Object, pushed: Option<i64>) -> Option<Self> {
        if json::string(msg.get("type")) != Some(Self::TYPE) {
            return None;
        }
        let window_id = json::int(msg.get("windowId")).or(pushed).filter(|&w| w >= 0)?;
        if pushed.is_some_and(|p| p != window_id) {
            return None;
        }
        let why = json::string(msg.get("why")).and_then(ParkedWhy::parse)?;
        let tab_id = json::int(msg.get("tabId"));
        if why != ParkedWhy::Focus && tab_id.is_none() {
            return None;
        }
        Some(Self { window_id, tab_id, why })
    }

    /// `msg`.
    pub fn msg(&self) -> Object {
        let mut m = Object::new();
        m.insert("type".into(), Self::TYPE.into());
        m.insert("windowId".into(), self.window_id.into());
        m.insert("why".into(), self.why.as_str().into());
        if let Some(tab) = self.tab_id {
            m.insert("tabId".into(), tab.into());
        }
        m
    }
}

/// `HandoffRequest.State`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowState {
    Fullscreen,
    Normal,
}

impl WindowState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fullscreen => "fullscreen",
            Self::Normal => "normal",
        }
    }
}

/// `HandoffRequest`: the handoff's requests to a copy, as a `req`'s type and payload. `not_after` is milliseconds
/// since 1970 (the app and its copies read the same clock): a copy that gets the request after it makes no windows
/// call and answers `{ refused: 'late' }`. Once a windows call is made it can't be taken back, so only the
/// request's arrival is checked.
#[derive(Clone, Debug, PartialEq)]
pub enum HandoffRequest {
    /// B to full screen and focused, or A to normal without taking focus (not focusWindow, which always focuses).
    SetWindowState {
        window_id: i64,
        state: WindowState,
        focused: bool,
        not_after: f64,
    },
    /// Six frames of the window's tab in front at the full-screen size, after a short nudge (R3, gate G2).
    FrameProbe {
        window_id: i64,
        width: f64,
        height: f64,
        frames: i64,
        nudge_ms: i64,
        timeout_ms: i64,
    },
    /// The window's tabs with typed text not sent: asked before any close.
    WindowDrafts {
        window_id: i64,
    },
    /// Today's switch sends this and CloseWindow with no `not_after` (none is checked then).
    FocusWindow {
        window_id: i64,
        fullscreen: bool,
        not_after: Option<f64>,
    },
    CloseWindow {
        window_id: i64,
        not_after: Option<f64>,
    },
    OpenSpaceWindow {
        space_id: String,
        fullscreen: bool,
    },
}

impl HandoffRequest {
    /// A frameProbe with the design's defaults: 6 frames, an 80 ms nudge, 400 ms to answer.
    pub fn frame_probe(window_id: i64, width: f64, height: f64) -> Self {
        Self::FrameProbe { window_id, width, height, frames: 6, nudge_ms: 80, timeout_ms: 400 }
    }

    /// `type`: the req's type.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::SetWindowState { .. } => "setWindowState",
            Self::FrameProbe { .. } => "frameProbe",
            Self::WindowDrafts { .. } => "windowDrafts",
            Self::FocusWindow { .. } => "focusWindow",
            Self::CloseWindow { .. } => "closeWindow",
            Self::OpenSpaceWindow { .. } => "openSpaceWindow",
        }
    }

    /// `windowId`: the window it's about (the req's window id, as today's switch sends it), `None` for a window to
    /// make.
    pub fn window_id(&self) -> Option<i64> {
        match self {
            Self::SetWindowState { window_id, .. }
            | Self::FrameProbe { window_id, .. }
            | Self::WindowDrafts { window_id }
            | Self::FocusWindow { window_id, .. }
            | Self::CloseWindow { window_id, .. } => Some(*window_id),
            Self::OpenSpaceWindow { .. } => None,
        }
    }

    /// `payload`: `None` if a number isn't finite.
    pub fn payload(&self) -> Option<Object> {
        let mut p = Object::new();
        match self {
            Self::SetWindowState { window_id, state, focused, not_after } => {
                p.insert("windowId".into(), (*window_id).into());
                p.insert("state".into(), state.as_str().into());
                p.insert("notAfter".into(), number(not_after.round())?);
                if *focused {
                    p.insert("focused".into(), true.into());
                }
            }
            Self::FrameProbe { window_id, width, height, frames, nudge_ms, timeout_ms } => {
                p.insert("windowId".into(), (*window_id).into());
                p.insert("width".into(), number(*width)?);
                p.insert("height".into(), number(*height)?);
                p.insert("frames".into(), (*frames).into());
                p.insert("nudgeMs".into(), (*nudge_ms).into());
                p.insert("timeoutMs".into(), (*timeout_ms).into());
            }
            Self::WindowDrafts { window_id } => {
                p.insert("windowId".into(), (*window_id).into());
            }
            Self::FocusWindow { window_id, fullscreen, not_after } => {
                p.insert("windowId".into(), (*window_id).into());
                if *fullscreen {
                    p.insert("fullscreen".into(), true.into());
                }
                if let Some(t) = not_after {
                    p.insert("notAfter".into(), number(t.round())?);
                }
            }
            Self::CloseWindow { window_id, not_after } => {
                p.insert("windowId".into(), (*window_id).into());
                if let Some(t) = not_after {
                    p.insert("notAfter".into(), number(t.round())?);
                }
            }
            Self::OpenSpaceWindow { space_id, fullscreen } => {
                p.insert("spaceId".into(), space_id.clone().into());
                p.insert("fullscreen".into(), (*fullscreen).into());
            }
        }
        Some(p)
    }
}

/// `WindowCallAnswer`: what a windows call answered (setWindowState, focusWindow, closeWindow: the reply's
/// `result`). `Busy` and `Refused` mean the copy made no windows call: nothing changed, and a busy is evidence that
/// an earlier call for that window is stuck (behind a hung tab).
#[derive(Clone, Debug, PartialEq)]
pub enum WindowCallAnswer {
    /// setWindowState: the browser says the window is in that state (`landedAt`).
    Landed { window_id: i64, state: String, at: f64 },
    /// setWindowState: asked, not in that state within 3 s.
    TimedOut { window_id: i64, state: String },
    /// Another windows call for that window was still pending.
    Busy,
    /// `late`: it came past its notAfter (by `past_ms`).
    Refused { why: String, past_ms: Option<f64> },
    /// focusWindow's `{ windowId, state }`, closeWindow's nothing.
    Done { state: Option<String> },
}

impl WindowCallAnswer {
    pub fn from_result(result: &Object) -> Self {
        if json::boolean(result.get("busy")) == Some(true) {
            return Self::Busy;
        }
        if let Some(why) = json::string(result.get("refused")) {
            return Self::Refused { why: why.to_owned(), past_ms: json::num(result.get("pastMs")) };
        }
        let state = json::string(result.get("state")).map(str::to_owned);
        if let (Some(window_id), Some(state)) = (json::int(result.get("windowId")), &state) {
            if json::boolean(result.get("timedOut")) == Some(true) {
                return Self::TimedOut { window_id, state: state.clone() };
            }
            if let Some(at) = json::num(result.get("landedAt")) {
                return Self::Landed { window_id, state: state.clone(), at };
            }
        }
        Self::Done { state }
    }

    /// `called`: whether the copy called the browser for it.
    pub fn called(&self) -> bool {
        !matches!(self, Self::Busy | Self::Refused { .. })
    }
}

/// `FrameProbeAnswer.Frames`: the frames the window's tab in front drew. Times are the page's `Date.now()`.
#[derive(Clone, Debug, PartialEq)]
pub struct ProbeFrames {
    pub tab_id: i64,
    pub frames: i64,
    pub first_at: f64,
    pub last_at: f64,
    /// The page's window size at the last frame (outerWidth, outerHeight: points).
    pub width: f64,
    pub height: f64,
    /// `document.hasFocus()`.
    pub has_focus: bool,
    /// `document.visibilityState` is 'visible'.
    pub visible: bool,
    /// The page's last visibilitychange to visible, if it heard one.
    pub visible_at: Option<f64>,
}

/// `FrameProbeAnswer`: what a frameProbe answered: the frames, or none (no page there, or it didn't answer within
/// the probe's timeout).
#[derive(Clone, Debug, PartialEq)]
pub enum FrameProbeAnswer {
    Frames(ProbeFrames),
    None { why: String },
}

impl FrameProbeAnswer {
    /// `None`: not an answer.
    pub fn from_result(result: &Object) -> Option<Self> {
        if let Some(why) = json::string(result.get("none")) {
            return Some(Self::None { why: why.to_owned() });
        }
        let frames = json::int(result.get("frames")).filter(|&f| f >= 0);
        Some(Self::Frames(ProbeFrames {
            tab_id: json::int(result.get("tabId"))?,
            frames: frames?,
            first_at: json::num(result.get("firstAt"))?,
            last_at: json::num(result.get("lastAt"))?,
            width: json::num(result.get("width"))?,
            height: json::num(result.get("height"))?,
            has_focus: json::boolean(result.get("hasFocus")) == Some(true),
            visible: json::boolean(result.get("visible")) == Some(true),
            visible_at: json::num(result.get("visibleAt")),
        }))
    }
}

/// `WindowDrafts`: what windowDrafts answered: the window's tabs with typed text not sent, and those that didn't
/// say in time (400 ms). A window is closed only when both are empty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowDrafts {
    pub drafts: Vec<i64>,
    pub unknown: Vec<i64>,
}

impl WindowDrafts {
    /// `None`: not an answer (a close then waits, as for a draft).
    pub fn from_result(result: &Object) -> Option<Self> {
        let ids = |key: &str| -> Option<Vec<i64>> {
            Some(json::array(result.get(key))?.iter().filter_map(|v| json::int(Some(v))).collect())
        };
        Some(Self { drafts: ids("drafts")?, unknown: ids("unknown")? })
    }

    pub fn may_close(&self) -> bool {
        self.drafts.is_empty() && self.unknown.is_empty()
    }
}

/// `SpaceWindowAnswer`: what openSpaceWindow answered: the new window, and its bounds as the browser gave them
/// (points from the top left of the main display), so the binder can bind it as made by Margin before the copy's
/// next windows list (HANDOFF.md §1.6). An older copy sends no bounds.
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceWindowAnswer {
    pub window_id: i64,
    pub state: String,
    pub tab_id: Option<i64>,
    pub bounds: Option<Rect>,
}

impl SpaceWindowAnswer {
    pub fn from_result(result: &Object) -> Option<Self> {
        let window_id = json::int(result.get("windowId"))?;
        let bounds = json::object(result.get("bounds")).and_then(|b| {
            let (l, t) = (json::num(b.get("left"))?, json::num(b.get("top"))?);
            let (w, h) = (json::num(b.get("width"))?, json::num(b.get("height"))?);
            (w > 0.0 && h > 0.0).then(|| Rect::new(l, t, w, h))
        });
        Some(Self {
            window_id,
            state: json::string(result.get("state")).unwrap_or("normal").to_owned(),
            tab_id: json::int(result.get("tabId")),
            bounds,
        })
    }
}

/// `OverlayFramed.Mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FramedMode {
    Fullscreen,
    Windowed,
}

/// `OverlayFramed`: the overlay page's `framed { mode }` (app/shared/host/overlay.ts): after the shell's `shown`, on
/// its next animation frame, the page says it has drawn, and in which mode (R4: B's overlay framed in full screen).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverlayFramed {
    pub mode: FramedMode,
}

impl OverlayFramed {
    pub const OP: &'static str = "framed";

    pub fn from_body(body: &Object) -> Option<Self> {
        let mode = match json::string(body.get("mode"))? {
            "fullscreen" => FramedMode::Fullscreen,
            "windowed" => FramedMode::Windowed,
            _ => return None,
        };
        Some(Self { mode })
    }

    pub fn body(&self) -> Object {
        let mut b = Object::new();
        let mode = match self.mode {
            FramedMode::Fullscreen => "fullscreen",
            FramedMode::Windowed => "windowed",
        };
        b.insert("mode".into(), mode.into());
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Object {
        v.as_object().cloned().unwrap_or_default()
    }

    fn decode(v: Value) -> Option<LinkMessage> {
        LinkMessage::decode(&v.to_string())
    }

    fn sent(m: &AppMessage) -> Object {
        m.encode(1.8e12).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    const AT: f64 = 1_800_000_000_000.0;

    // ---- tests.swift linkMessages() ----

    #[test]
    fn hello() {
        let m = decode(
            json!({"k":"hello","v":2,"epoch":"e1","profile":"P-1","browser":"safari","origin":"safari-web-extension://A","since":1761800000000_i64,"ext":"2.0","owner":true,"instanceId":"i"}),
        );
        let Some(LinkMessage::Hello(h)) = m else { panic!("hello decodes") };
        assert_eq!(h.epoch, "e1");
        assert_eq!(h.key(), "safari:P-1");
        assert_eq!(h.origin.as_deref(), Some("safari-web-extension://A"));
        assert_eq!(h.since, Some(1761800000000.0));
        assert_eq!(h.ext.as_deref(), Some("2.0"));
        assert!(h.owner);
        assert_eq!(h.instance_id.as_deref(), Some("i"));
        assert_eq!(h.pid, None);
        assert_eq!(h.copy_id(), "i");

        let Some(LinkMessage::Hello(h)) =
            decode(json!({"k":"hello","v":2,"epoch":"e1","profile":"p","browser":"chrome","pid":4321}))
        else {
            panic!("bare hello decodes")
        };
        assert!(!h.owner, "not the owner unless it says so");
        assert_eq!(h.pid, Some(4321));
        assert_eq!(h.copy_id(), "e1", "no instanceId nor since: the epoch");
        assert!(matches!(
            decode(json!({"k":"hello","v":2,"epoch":"e1","profile":"p","browser":"edge","since":5})),
            Some(LinkMessage::Hello(h)) if h.copy_id() == "5" && h.key() == "edge:p"
        ));
    }

    #[test]
    fn hellos_that_are_not() {
        let not = |v: Value| assert_eq!(decode(v.clone()), None, "{v}");
        not(json!({"k":"hello","v":1,"epoch":"e1","owner":true,"profile":"p","browser":"safari"}));
        not(json!({"k":"hello","v":2,"epoch":"e1","browser":"safari"}));
        not(json!({"k":"hello","v":2,"epoch":"e1","browser":"safari","profile":"a/b"}));
        not(json!({"k":"hello","v":2,"epoch":"e1","browser":"lynx","profile":"p"}));
        not(json!({"k":"hello","v":2,"epoch":"","browser":"safari","profile":"p"}));
        not(json!({"k":"hello","v":2,"browser":"safari","profile":"p"}));
        not(json!({"k":"hello","v":"2","epoch":"e","browser":"safari","profile":"p"}));
        not(json!({"k":"hello","v":2,"epoch":"e","browser":"safari","profile":"x".repeat(65)}));
        assert!(decode(json!({"k":"hello","v":2,"epoch":"e","browser":"safari","profile":"x".repeat(64)})).is_some());
        assert!(decode(json!({"k":"hello","v":2.0,"epoch":"e","browser":"safari","profile":"A-z_0.9:x"})).is_some());
    }

    #[test]
    fn sockets_off_is_clipped() {
        let long = "é".repeat(300);
        let Some(LinkMessage::Hello(h)) =
            decode(json!({"k":"hello","v":2,"epoch":"e","browser":"safari","profile":"p","socketsOff":long}))
        else {
            panic!()
        };
        assert_eq!(h.sockets_off.map(|s| s.chars().count()), Some(200));
    }

    #[test]
    fn not_messages() {
        assert_eq!(LinkMessage::decode("{k:"), None);
        assert_eq!(LinkMessage::decode(""), None);
        assert_eq!(LinkMessage::decode("[1]"), None);
        assert_eq!(LinkMessage::decode(&"[".repeat(100_000)), None, "deep nesting: refused, no stack overflow");
        assert_eq!(decode(json!({"epoch":"e"})), None, "no kind");
        assert_eq!(decode(json!({"k":3})), None);
        assert_eq!(decode(json!({"k":"snapshot","seq":1,"state":{}})), None, "a snapshot needs its epoch");
        assert_eq!(decode(json!({"k":"windows","epoch":"e","seq":1.5,"list":[]})), None, "seq not whole");
        assert_eq!(decode(json!({"k":"windows","epoch":"e","seq":1,"list":[1]})), None, "a list of non-objects");
        assert_eq!(decode(json!({"k":"delta","epoch":"e","seq":1,"changes":{"a":1}})), None, "a change not an object");
    }

    #[test]
    fn snapshot_delta_windows() {
        let Some(LinkMessage::Snapshot { epoch, seq, state, windows }) = decode(
            json!({"k":"snapshot","epoch":"e","seq":1,"state":{"spaces":[{"id":"a"}]},"windows":[{"windowId":3,"focused":true}]}),
        ) else {
            panic!("snapshot decodes")
        };
        assert_eq!((epoch.as_str(), seq), ("e", 1));
        assert_eq!(state.get("spaces"), Some(&json!([{"id":"a"}])));
        assert_eq!(windows[0].get("windowId"), Some(&json!(3)));
        // Windows that aren't all objects: none (Swift's `as? [JSONObject] ?? []`).
        assert!(matches!(
            decode(json!({"k":"snapshot","epoch":"e","seq":1,"state":{},"windows":[{"windowId":3}, 4]})),
            Some(LinkMessage::Snapshot { windows, .. }) if windows.is_empty()
        ));

        let Some(LinkMessage::Delta { seq, changes, favicons, .. }) = decode(
            json!({"k":"delta","epoch":"e","seq":2,"changes":{"pins":{"newValue":[]},"folders":{},"archive":{"newValue":null}},"favicons":{"set":{"https://a.example":{"icon":"data:x"}},"del":["https://b.example"]}}),
        ) else {
            panic!("delta decodes")
        };
        assert_eq!(seq, 2);
        assert_eq!(changes.get("pins"), Some(&Change::Set(json!([]))));
        assert_eq!(changes.get("folders"), Some(&Change::Removed));
        assert_eq!(changes.get("archive"), Some(&Change::Set(Value::Null)), "a stored null is a value");
        let f = favicons.unwrap_or_default();
        assert_eq!(f.del, vec!["https://b.example".to_owned()]);
        assert_eq!(f.set.get("https://a.example"), Some(&json!({"icon":"data:x"})));
        assert!(matches!(
            decode(json!({"k":"delta","epoch":"e","seq":2,"changes":{},"favicons":{"set":3,"del":["a",1]}})),
            Some(LinkMessage::Delta { favicons: Some(f), .. }) if f.set.is_empty() && f.del.is_empty()
        ));

        assert!(matches!(
            decode(json!({"k":"windows","epoch":"e","seq":3,"list":[{"windowId":1},{"windowId":2}]})),
            Some(LinkMessage::Windows { seq: 3, list, .. }) if list.len() == 2
        ));
    }

    #[test]
    fn pushes() {
        assert!(matches!(
            decode(json!({"k":"push","epoch":"e","windowId":4,"msg":{"type":"switching","tabId":5}})),
            Some(LinkMessage::Push { window_id: Some(4), msg, .. }) if msg.get("type") == Some(&json!("switching"))
        ));
        assert!(matches!(
            decode(json!({"k":"push","epoch":"e","msg":{"type":"notice","kind":"x"}})),
            Some(LinkMessage::Push { window_id: None, .. })
        ));
        assert_eq!(decode(json!({"k":"push","epoch":"e","msg":3})), None);
    }

    #[test]
    fn theme_chunks() {
        let sha = "a".repeat(64);
        let Some(LinkMessage::Theme { epoch, chunk }) = decode(
            json!({"k":"theme","epoch":"e","id":"arcadia","transfer":sha,"part":1,"parts":3,"size":10,"data":"YWJj"}),
        ) else {
            panic!("theme decodes")
        };
        assert_eq!(epoch, "e");
        assert_eq!(
            chunk,
            Chunk { id: "arcadia".into(), transfer: sha.clone(), part: 1, parts: 3, size: 10, data: "YWJj".into() }
        );
        let not = |v: Value| assert_eq!(decode(v.clone()), None, "{v}");
        not(json!({"k":"theme","epoch":"e","id":"a","transfer":sha,"part":3,"parts":3,"size":1,"data":""}));
        not(json!({"k":"theme","epoch":"e","id":"a","transfer":"x","part":0,"parts":1,"size":1,"data":""}));
        not(json!({"k":"theme","epoch":"e","id":"a","transfer":sha,"part":0,"parts":65,"size":1,"data":""}));
        not(json!({"k":"theme","epoch":"e","id":"a","transfer":sha,"part":0,"parts":0,"size":1,"data":""}));
        not(json!({"k":"theme","epoch":"e","id":"a","transfer":sha,"part":-1,"parts":1,"size":1,"data":""}));
        not(json!({"k":"theme","epoch":"e","id":"a","transfer":sha,"part":0,"parts":1,"size":-1,"data":""}));
        not(json!({"k":"theme","epoch":"e","id":"","transfer":sha,"part":0,"parts":1,"size":1,"data":""}));
        not(json!({"k":"theme","epoch":"e","id":"i".repeat(65),"transfer":sha,"part":0,"parts":1,"size":1,"data":""}));
        not(json!({"k":"theme","epoch":"e","id":"a","transfer":sha,"part":0,"parts":1,"size":1}));
        not(json!({"k":"theme","id":"a","transfer":sha,"part":0,"parts":1,"size":1,"data":""}));
    }

    #[test]
    fn reply_tock_bye_other_keys_data() {
        let Some(LinkMessage::Reply { id, body }) =
            decode(json!({"k":"reply","id":7,"ok":false,"error":"x","stale":true}))
        else {
            panic!("reply decodes")
        };
        assert_eq!(id, 7);
        assert_eq!(Value::Object(body), json!({"ok":false,"error":"x","stale":true}), "the answer without k and id");
        assert_eq!(decode(json!({"k":"reply","ok":true})), None, "a reply needs its id");
        assert_eq!(decode(json!({"k":"tock","at":1})), Some(LinkMessage::Tock));
        assert_eq!(decode(json!({"k":"bye","why":"turned off"})), Some(LinkMessage::Bye { why: "turned off".into() }));
        assert_eq!(decode(json!({"k":"bye"})), Some(LinkMessage::Bye { why: String::new() }));
        assert_eq!(decode(json!({"k":"later"})), Some(LinkMessage::Other("later".into())));

        let Some(LinkMessage::Keys { epoch, bindings }) = decode(
            json!({"k":"keys","epoch":"e","bindings":{"next-tab":["Alt+Meta+ArrowDown","Ctrl+Meta+ArrowDown",3],"palette":["Meta+KeyT"],"odd":"x"}}),
        ) else {
            panic!("keys decode")
        };
        assert_eq!(epoch, "e");
        assert_eq!(
            bindings.get("next-tab"),
            Some(&vec!["Alt+Meta+ArrowDown".to_owned(), "Ctrl+Meta+ArrowDown".to_owned()])
        );
        assert_eq!(bindings.get("palette"), Some(&vec!["Meta+KeyT".to_owned()]));
        assert_eq!(bindings.get("odd"), None);
        assert_eq!(decode(json!({"k":"keys","bindings":{}})), None, "keys need their epoch");
        let many: Vec<String> = (0..10).map(|i| format!("Meta+Digit{i}")).collect();
        let long = "x".repeat(65);
        assert!(matches!(
            decode(json!({"k":"keys","epoch":"e","bindings":{"a":many,"b":[long]}})),
            Some(LinkMessage::Keys { bindings, .. }) if bindings["a"].len() == 8 && bindings["b"].is_empty()
        ));

        let Some(LinkMessage::Data { kind, body }) = decode(json!({"k":"data.hello","format":1})) else { panic!() };
        assert_eq!(kind, "data.hello");
        assert_eq!(body.get("format"), Some(&json!(1)));
    }

    // ---- tests.swift appMessages() ----

    #[test]
    fn app_messages() {
        let w = sent(&AppMessage::Welcome { key: Some("K".into()) });
        assert_eq!(Value::Object(w), json!({"k":"welcome","v":2,"key":"K"}));
        let w = sent(&AppMessage::Welcome { key: None });
        assert_eq!(Value::Object(w), json!({"k":"welcome","v":2}), "over the relay: no key");

        let req = AppMessage::Req {
            id: 3,
            epoch: "e".into(),
            window_id: None,
            kind: "activateTab".into(),
            payload: obj(json!({"tabId":9})),
        };
        let r = sent(&req);
        assert_eq!(r.get("k"), Some(&json!("req")));
        assert_eq!(r.get("id"), Some(&json!(3)));
        assert_eq!(r.get("windowId"), Some(&Value::Null));
        assert_eq!(r.get("type"), Some(&json!("activateTab")));
        assert_eq!(r.get("payload"), Some(&json!({"tabId":9})));
        assert_eq!(r.get("at"), Some(&json!(1_800_000_000_000_i64)), "at in whole milliseconds");

        let layout = PageLayout {
            left: 260.0,
            top: 8.0,
            right: 8.0,
            bottom: 8.0,
            radius: 6.25,
            radii: vec![6.25; 4],
            width: 1280.0,
            height: 800.0,
            mode: "fullscreen".into(),
        };
        let s = sent(&AppMessage::SetLayout { epoch: "e".into(), window_id: 7, seq: 2, layout: layout.clone() });
        assert_eq!(s.get("k"), Some(&json!("setLayout")));
        assert_eq!(s.get("windowId"), Some(&json!(7)));
        assert_eq!(s.get("seq"), Some(&json!(2)));
        assert_eq!(s.get("insets"), Some(&json!({"left":260,"top":8,"right":8,"bottom":8})));
        assert_eq!(s.get("radius"), Some(&json!(6.25)));
        assert_eq!(s.get("container"), Some(&json!({"width":1280,"height":800})));
        assert_eq!(s.get("mode"), Some(&json!("fullscreen")));

        let d = sent(&AppMessage::Drawn { epoch: "e".into(), window_id: 7, on: false });
        assert_eq!(
            Value::Object(d),
            json!({"k":"drawn","epoch":"e","windowId":7,"on":false,"at":1_800_000_000_000_i64})
        );
        let p = sent(&AppMessage::Parked { epoch: "e".into(), window_id: 7, on: true });
        assert_eq!(
            Value::Object(p),
            json!({"k":"parked","epoch":"e","windowId":7,"on":true,"at":1_800_000_000_000_i64})
        );
        assert_eq!(sent(&AppMessage::Resync { epoch: "e".into() }).get("epoch"), Some(&json!("e")));
        assert_eq!(sent(&AppMessage::Bye { why: "quit".into() }).get("why"), Some(&json!("quit")));
        assert_eq!(sent(&AppMessage::Tick).get("k"), Some(&json!("tick")));

        let data = sent(&AppMessage::Data { kind: "data.ack".into(), body: obj(json!({"k":"x","upTo":4})) });
        assert_eq!(Value::Object(data), json!({"k":"data.ack","upTo":4}), "the kind wins over the body's k");

        let chunk = Chunk { id: "t".into(), transfer: "0".repeat(64), part: 0, parts: 1, size: 3, data: "YWJj".into() };
        let t = sent(&AppMessage::Theme { epoch: "e".into(), chunk });
        assert_eq!(t.get("k"), Some(&json!("theme")));
        assert_eq!(t.get("id"), Some(&json!("t")));
        assert_eq!(t.get("parts"), Some(&json!(1)));
        assert_eq!(t.get("data"), Some(&json!("YWJj")));
    }

    #[test]
    fn nothing_over_1_mb_goes() {
        let req = |n: usize| AppMessage::Req {
            id: 1,
            epoch: "e".into(),
            window_id: Some(1),
            kind: "x".into(),
            payload: obj(json!({"big": "x".repeat(n)})),
        };
        assert_eq!(req(MAX_APP_MESSAGE).encode(AT), None, "nothing over 1 MB goes from the app");
        assert!(req(MAX_APP_MESSAGE - 200).encode(AT).is_some(), "just under 1 MB goes");
        // Exactly at the cap goes, a byte more doesn't.
        let base = req(0).encode(AT).map_or(0, |t| t.len());
        assert_eq!(req(MAX_APP_MESSAGE - base).encode(AT).map(|t| t.len()), Some(MAX_APP_MESSAGE));
        assert_eq!(req(MAX_APP_MESSAGE - base + 1).encode(AT), None);
    }

    #[test]
    fn not_json_is_not_sent() {
        let layout = PageLayout {
            left: f64::NAN,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
            radius: 0.0,
            radii: vec![0.0; 4],
            width: 1.0,
            height: 1.0,
            mode: "fullscreen".into(),
        };
        assert_eq!(AppMessage::SetLayout { epoch: "e".into(), window_id: 1, seq: 1, layout }.encode(AT), None);
        assert_eq!(AppMessage::Tick.encode(f64::INFINITY), None);
        assert_eq!(HandoffRequest::frame_probe(1, f64::NAN, 1.0).payload(), None);
    }

    // ---- tests.swift layouts() (the PageLayout part) ----

    #[test]
    fn layouts() {
        let g = obj(
            json!({"insets":{"left":260.3,"top":8,"right":8,"bottom":8.26},"radius":6.25,"radii":[6.25,6.25,6.25,6.25],"container":{"width":1280,"height":800},"mode":"fullscreen","outer":{}}),
        );
        let Some(l) = PageLayout::from_geometry(&g) else { panic!("a layout report") };
        assert_eq!((l.left, l.bottom, l.width, l.radius, l.mode.as_str()), (260.3, 8.26, 1280.0, 6.25, "fullscreen"));
        let r = l.rounded();
        assert_eq!((r.left, r.bottom, r.top), (260.5, 8.5, 8.0), "rounded to half a point");
        assert_eq!(PageLayout::from_geometry(&obj(json!({"container":{"width":1,"height":1}}))), None);
        assert_eq!(
            PageLayout::from_geometry(&obj(
                json!({"insets":{"left":0,"top":0,"right":0,"bottom":0},"container":{"width":0,"height":10}})
            )),
            None
        );
        assert_eq!(
            PageLayout::from_geometry(&obj(
                json!({"insets":{"left":true,"top":0,"right":0,"bottom":0},"container":{"width":10,"height":10}})
            )),
            None,
            "a number that's a boolean"
        );
        let bare = PageLayout::from_geometry(&obj(
            json!({"insets":{"left":0,"top":0,"right":0,"bottom":0},"container":{"width":10,"height":10},"radius":-3,"radii":[1,2]}),
        ));
        let Some(bare) = bare else { panic!() };
        assert_eq!(bare.radius, 0.0, "a radius below 0 kept at 0");
        assert_eq!(bare.radii, vec![-3.0; 4], "not four radii: the radius as given, four times (as the Swift)");
        assert_eq!(bare.mode, "fullscreen");
    }

    #[test]
    fn layout_in_window() {
        let l = PageLayout {
            left: 10.0,
            top: 20.0,
            right: 30.0,
            bottom: 40.0,
            radius: 0.0,
            radii: vec![0.0; 4],
            width: 800.0,
            height: 600.0,
            mode: "fullscreen".into(),
        };
        let window = Rect::new(0.0, 0.0, 1000.0, 700.0);
        assert_eq!(l.in_window(window, window), l);
        let overlay = Rect::new(200.0, 0.0, 800.0, 600.0); // an inspector on the left and at the bottom
        let w = l.in_window(overlay, window);
        assert_eq!((w.left, w.top, w.right, w.bottom, w.width, w.height), (210.0, 20.0, 30.0, 140.0, 1000.0, 700.0));
    }

    // ---- tests.swift handoffMessages() ----

    #[test]
    fn parked_activity() {
        for a in [
            ParkedActivity { window_id: 3, tab_id: Some(44), why: ParkedWhy::Tab },
            ParkedActivity { window_id: 3, tab_id: None, why: ParkedWhy::Focus },
            ParkedActivity { window_id: 0, tab_id: Some(9), why: ParkedWhy::Raise },
        ] {
            let text = json!({"k":"push","epoch":"e","windowId":a.window_id,"msg":Value::Object(a.msg())});
            assert_eq!(
                decode(text),
                Some(LinkMessage::ParkedActivity { epoch: "e".into(), activity: a.clone() }),
                "round trip"
            );
        }
        assert!(!ParkedActivity { window_id: 3, tab_id: None, why: ParkedWhy::Focus }.msg().contains_key("tabId"));
        assert!(matches!(
            decode(json!({"k":"push","epoch":"e","windowId":5,"msg":{"type":"parkedActivity","why":"focus"}})),
            Some(LinkMessage::ParkedActivity { activity, .. }) if activity.window_id == 5
        ));
        let not = |v: Value| assert_eq!(decode(v.clone()), None, "{v}");
        not(json!({"k":"push","epoch":"e","windowId":5,"msg":{"type":"parkedActivity","windowId":6,"why":"focus"}}));
        not(json!({"k":"push","epoch":"e","msg":{"type":"parkedActivity","windowId":6,"why":"hover"}}));
        not(json!({"k":"push","epoch":"e","msg":{"type":"parkedActivity","windowId":6,"why":"tab"}}));
        not(json!({"k":"push","epoch":"e","msg":{"type":"parkedActivity","why":"focus"}}));
        not(json!({"k":"push","epoch":"e","msg":{"type":"parkedActivity","windowId":-1,"why":"focus"}}));
        assert_eq!(
            ParkedActivity::from_msg(&obj(json!({"type":"parkedActivity","windowId":6,"why":"raise"})), None),
            None
        );
    }

    #[test]
    fn handoff_requests() {
        let full = HandoffRequest::SetWindowState {
            window_id: 4,
            state: WindowState::Fullscreen,
            focused: true,
            not_after: 1_800_000_000_123.4,
        };
        let req = AppMessage::Req {
            id: 1,
            epoch: "e".into(),
            window_id: full.window_id(),
            kind: full.type_name().into(),
            payload: full.payload().unwrap_or_default(),
        };
        let r = sent(&req);
        assert_eq!(r.get("type"), Some(&json!("setWindowState")));
        assert_eq!(r.get("windowId"), Some(&json!(4)));
        assert_eq!(
            r.get("payload"),
            Some(&json!({"windowId":4,"state":"fullscreen","notAfter":1_800_000_000_123_i64,"focused":true}))
        );
        let normal =
            HandoffRequest::SetWindowState { window_id: 4, state: WindowState::Normal, focused: false, not_after: 1.0 };
        assert_eq!(normal.payload().map(Value::Object), Some(json!({"windowId":4,"state":"normal","notAfter":1})));
        let probe = HandoffRequest::frame_probe(4, 1512.0, 982.0).payload().map(Value::Object);
        assert_eq!(
            probe,
            Some(json!({"windowId":4,"width":1512,"height":982,"frames":6,"nudgeMs":80,"timeoutMs":400}))
        );
        let drafts = HandoffRequest::WindowDrafts { window_id: 9 };
        assert_eq!(
            (drafts.type_name(), drafts.payload().map(Value::Object)),
            ("windowDrafts", Some(json!({"windowId":9})))
        );
        let focus = HandoffRequest::FocusWindow { window_id: 4, fullscreen: true, not_after: Some(5.0) };
        assert_eq!(focus.payload().map(Value::Object), Some(json!({"windowId":4,"fullscreen":true,"notAfter":5})));
        let today = HandoffRequest::FocusWindow { window_id: 4, fullscreen: false, not_after: None };
        assert_eq!(today.payload().map(Value::Object), Some(json!({"windowId":4})));
        let close = HandoffRequest::CloseWindow { window_id: 4, not_after: None };
        assert_eq!(close.payload().map(Value::Object), Some(json!({"windowId":4})));
        let close = HandoffRequest::CloseWindow { window_id: 4, not_after: Some(9.0) };
        assert_eq!(close.payload().map(Value::Object), Some(json!({"windowId":4,"notAfter":9})));
        let open = HandoffRequest::OpenSpaceWindow { space_id: "s".into(), fullscreen: true };
        assert_eq!(open.window_id(), None);
        assert_eq!(open.payload().map(Value::Object), Some(json!({"spaceId":"s","fullscreen":true})));
    }

    #[test]
    fn handoff_answers() {
        let a = |v: Value| WindowCallAnswer::from_result(&obj(v));
        assert_eq!(
            a(json!({"windowId":4,"state":"fullscreen","landedAt":12.0})),
            WindowCallAnswer::Landed { window_id: 4, state: "fullscreen".into(), at: 12.0 }
        );
        assert_eq!(
            a(json!({"windowId":4,"state":"fullscreen","timedOut":true})),
            WindowCallAnswer::TimedOut { window_id: 4, state: "fullscreen".into() }
        );
        assert_eq!(a(json!({"busy":true})), WindowCallAnswer::Busy);
        assert!(!a(json!({"busy":true})).called());
        assert_eq!(
            a(json!({"refused":"late","pastMs":210})),
            WindowCallAnswer::Refused { why: "late".into(), past_ms: Some(210.0) }
        );
        assert!(!a(json!({"refused":"late"})).called());
        assert_eq!(
            a(json!({"windowId":4,"state":"fullscreen"})),
            WindowCallAnswer::Done { state: Some("fullscreen".into()) }
        );
        assert_eq!(a(json!({})), WindowCallAnswer::Done { state: None });
        assert!(a(json!({})).called());

        let f = FrameProbeAnswer::from_result(&obj(
            json!({"tabId":44,"frames":6,"firstAt":1.0,"lastAt":75.0,"width":1512,"height":982,"hasFocus":true,"visible":true,"visibleAt":2.0}),
        ));
        let Some(FrameProbeAnswer::Frames(f)) = f else { panic!("frameProbe answer decodes") };
        assert_eq!((f.tab_id, f.frames, f.last_at - f.first_at, f.width), (44, 6, 74.0, 1512.0));
        assert!(f.has_focus && f.visible && f.visible_at == Some(2.0));
        assert_eq!(
            FrameProbeAnswer::from_result(&obj(json!({"none":"no page"}))),
            Some(FrameProbeAnswer::None { why: "no page".into() })
        );
        assert_eq!(FrameProbeAnswer::from_result(&obj(json!({"frames":6}))), None);

        let d = |v: Value| WindowDrafts::from_result(&obj(v));
        assert_eq!(d(json!({"drafts":[3],"unknown":[]})), Some(WindowDrafts { drafts: vec![3], unknown: vec![] }));
        assert_eq!(d(json!({"drafts":[],"unknown":[]})).map(|w| w.may_close()), Some(true));
        assert_eq!(d(json!({"drafts":[],"unknown":[5]})).map(|w| w.may_close()), Some(false));
        assert_eq!(d(json!({"drafts":[3]})), None);

        let s = |v: Value| SpaceWindowAnswer::from_result(&obj(v));
        let made = s(
            json!({"windowId":50,"state":"fullscreen","tabId":7,"bounds":{"left":0,"top":0,"width":1512,"height":982}}),
        );
        assert_eq!(
            made.as_ref().map(|m| (m.window_id, m.tab_id, m.bounds)),
            Some((50, Some(7), Some(Rect::new(0.0, 0.0, 1512.0, 982.0))))
        );
        assert_eq!(s(json!({"windowId":50,"state":"normal","tabId":null})).and_then(|m| m.bounds), None);
        assert_eq!(
            s(json!({"windowId":50,"bounds":{"left":0,"top":0,"width":0,"height":982}})).and_then(|m| m.bounds),
            None
        );
        assert_eq!(s(json!({"windowId":50})).map(|m| m.state), Some("normal".into()));
        assert_eq!(s(json!({"state":"normal"})), None);

        let fs = OverlayFramed { mode: FramedMode::Fullscreen };
        assert_eq!(OverlayFramed::from_body(&fs.body()), Some(fs));
        assert_eq!(
            OverlayFramed::from_body(&obj(json!({"mode":"windowed"}))).map(|f| f.mode),
            Some(FramedMode::Windowed)
        );
        assert_eq!(OverlayFramed::from_body(&obj(json!({"mode":"odd"}))), None);
        assert_eq!(OverlayFramed::from_body(&Object::new()), None);
    }
}
