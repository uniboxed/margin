//! The relay's handshake with the app over the named pipe (OS-neutral, tested on the Mac). Both ends are this
//! executable, so the messages live here, apart from the link's own (margin-core `protocol`).
//!
//! On a new pipe connection the app speaks first: `relayWelcome { v, version }`. The relay answers with
//! `relayHello { v, origin, browser, pid?, parentWindow?, version }`, made by the relay itself (the browser and
//! its pid from its parent process, relay.rs). Everything after that is the extension's own frames, both ways,
//! untouched. A relay whose version isn't the app's exits, so Chrome starts the new one next time (as the
//! Mac's relay helper does after an update).
//!
//! Towards Chrome the relay adds only two frames of its own: `relayDown` when the pipe is lost and `relayUp`
//! once it's linked again (the app restarted): the copy says its `hello` again on `relayUp`. The link's
//! messages are named by `k` and unknown kinds are ignored by both ends (app/PROTOCOL.md), so an older copy
//! ignores them. TODO(chromium-link): align these two with the Mac's relay helper once it lands on main.

use serde::{Deserialize, Serialize};

/// The handshake's version (both kinds).
pub const VERSION: u32 = 1;
/// This build's version: a relay and an app of different builds don't link.
pub const BUILD: &str = env!("CARGO_PKG_VERSION");

/// The app's first frame on a new connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayWelcome {
    pub k: String,
    pub v: u32,
    pub version: String,
}

impl RelayWelcome {
    pub fn new() -> Self {
        Self { k: "relayWelcome".into(), v: VERSION, version: BUILD.into() }
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// A welcome this relay can link with: right kind and handshake version (the build is checked apart).
    pub fn parse(body: &[u8]) -> Option<Self> {
        let w: Self = serde_json::from_slice(body).ok()?;
        (w.k == "relayWelcome" && w.v == VERSION).then_some(w)
    }
}

impl Default for RelayWelcome {
    fn default() -> Self {
        Self::new()
    }
}

/// The relay's first frame: who started it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayHello {
    pub k: String,
    pub v: u32,
    /// The caller's origin, as Chrome gave it (`chrome-extension://<id>/`).
    pub origin: String,
    /// `chrome`, `edge`, or the lowercase name of the browser's executable without `.exe` (`brave`, …);
    /// `other` when the parent couldn't be read.
    pub browser: String,
    /// The browser's process (the parent of the relay's `cmd.exe`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// The HWND of the window that called `connectNative`, when Chrome said one (`--parent-window`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_window: Option<i64>,
    pub version: String,
}

impl RelayHello {
    pub fn new(origin: &str, browser: &str, pid: Option<u32>, parent_window: Option<i64>) -> Self {
        Self {
            k: "relayHello".into(),
            v: VERSION,
            origin: origin.into(),
            browser: browser.into(),
            pid,
            parent_window,
            version: BUILD.into(),
        }
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// A hello the app takes: the right kind and version, an origin of at most 128 characters and a browser
    /// name of 1–32 of `a-z 0-9 - _ .`. The origin isn't checked against the allowed list here (Chrome did).
    pub fn parse(body: &[u8]) -> Option<Self> {
        let h: Self = serde_json::from_slice(body).ok()?;
        let browser_ok = (1..=32).contains(&h.browser.len())
            && h.browser.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b));
        (h.k == "relayHello" && h.v == VERSION && h.origin.len() <= 128 && browser_ok).then_some(h)
    }
}

/// The browser's name for `relayHello`, from its executable's file name.
pub fn browser_name(exe_file_name: &str) -> String {
    let lower = exe_file_name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    match stem {
        "chrome" => "chrome".into(),
        "msedge" => "edge".into(),
        "" => "other".into(),
        s => {
            let clean: String = s
                .chars()
                .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "-_.".contains(*c))
                .take(32)
                .collect();
            if clean.is_empty() { "other".into() } else { clean }
        }
    }
}

/// The relay's own frames towards Chrome (see the module's note).
pub const RELAY_DOWN: &[u8] = br#"{"k":"relayDown"}"#;
pub const RELAY_UP: &[u8] = br#"{"k":"relayUp"}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trip_and_json() {
        let h = RelayHello::new("chrome-extension://abc/", "edge", Some(42), Some(7));
        let json = String::from_utf8(h.to_json()).unwrap();
        assert!(json.contains(r#""k":"relayHello""#));
        assert!(json.contains(r#""parentWindow":7"#));
        assert_eq!(RelayHello::parse(json.as_bytes()), Some(h));
        let bare = RelayHello::new("chrome-extension://abc/", "chrome", None, None);
        let json = String::from_utf8(bare.to_json()).unwrap();
        assert!(!json.contains("pid") && !json.contains("parentWindow"));
    }

    #[test]
    fn a_bad_hello_is_refused() {
        assert!(RelayHello::parse(br#"{"k":"hello","v":1,"origin":"x","browser":"chrome","version":"0"}"#).is_none());
        assert!(
            RelayHello::parse(br#"{"k":"relayHello","v":2,"origin":"x","browser":"chrome","version":"0"}"#).is_none()
        );
        assert!(
            RelayHello::parse(br#"{"k":"relayHello","v":1,"origin":"x","browser":"Chrome!","version":"0"}"#).is_none()
        );
        assert!(RelayHello::parse(b"not json").is_none());
    }

    #[test]
    fn welcome() {
        let w = RelayWelcome::new();
        assert_eq!(RelayWelcome::parse(&w.to_json()), Some(w));
        assert!(RelayWelcome::parse(br#"{"k":"relayWelcome","v":9,"version":"x"}"#).is_none());
    }

    #[test]
    fn browser_names() {
        assert_eq!(browser_name("chrome.exe"), "chrome");
        assert_eq!(browser_name("CHROME.EXE"), "chrome");
        assert_eq!(browser_name("msedge.exe"), "edge");
        assert_eq!(browser_name("brave.exe"), "brave");
        assert_eq!(browser_name(""), "other");
        assert_eq!(browser_name("€.exe"), "other");
    }
}
