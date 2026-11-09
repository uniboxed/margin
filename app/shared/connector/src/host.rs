//! The connector as the browser's native-messaging host: the browser's framing on stdin and stdout (a 4-byte
//! length in the machine's byte order, then that much UTF-8 JSON), JSON lines to the app, its hello first.
//! The app not running: started (in the background), and each message answered here as Safari's handler does
//! then; a native port's connector waits for the app, and says so in its hello once in (the app then says
//! `appUp` to it). An app of another version answers: this connector exits (the browser starts the new one with
//! the next port or message).

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::os;

/// What it says about itself: the app's version it came with, the browser that started it and its process,
/// and where the app listens.
pub struct Facts {
    pub version: String,
    pub browser: String,
    pub pid: u32,
    pub socket: String,
}

impl Facts {
    pub fn now() -> Self {
        let version = std::env::var("MARGIN_CONNECTOR_VERSION")
            .ok()
            .or(option_env!("MARGIN_APP_VERSION").map(String::from))
            .unwrap_or_default();
        let (browser, pid) = os::browser_and_pid();
        let browser =
            std::env::var("MARGIN_CONNECTOR_BROWSER").ok().filter(|b| b == "chrome" || b == "edge").unwrap_or(browser);
        let socket = std::env::var("MARGIN_CONNECTOR_SOCKET").unwrap_or_else(|_| os::socket_path());
        Facts { version, browser, pid, socket }
    }
}

/// The largest message a browser sends a host (Chrome's own cap).
const MAX_IN: usize = 64 << 20;

struct State {
    facts: Facts,
    app: Mutex<Option<Box<dyn Write + Send>>>,
    linking: Mutex<()>,
    waited: AtomicBool,
    out: Mutex<std::io::Stdout>,
    launched_at: Mutex<Option<Instant>>,
}

pub fn run(facts: &Facts) {
    let state = Arc::new(State {
        facts: Facts {
            version: facts.version.clone(),
            browser: facts.browser.clone(),
            pid: facts.pid,
            socket: facts.socket.clone(),
        },
        app: Mutex::new(None),
        linking: Mutex::new(()),
        waited: AtomicBool::new(false),
        out: Mutex::new(std::io::stdout()),
        launched_at: Mutex::new(None),
    });
    // The app, waited for in the background while the browser keeps this connector (its native port).
    {
        let state = state.clone();
        std::thread::spawn(move || {
            loop {
                linked(&state);
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }
    let mut stdin = std::io::stdin().lock();
    while let Some(body) = read_frame(&mut stdin) {
        let Ok(message) = serde_json::from_slice::<Value>(&body) else { continue };
        if !to_app(&state, &json!({ "msg": message })) {
            answer_without_app(&state, &message);
        }
    }
    // The browser closed its end (the port went, or a one-off message was answered).
    std::process::exit(0);
}

fn read_frame(input: &mut impl Read) -> Option<Vec<u8>> {
    let mut header = [0u8; 4];
    input.read_exact(&mut header).ok()?;
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > MAX_IN {
        return None;
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body).ok()?;
    Some(body)
}

// One message to the browser; its end gone, this connector is done.
fn to_browser(state: &State, body: &[u8]) {
    let mut out = state.out.lock().unwrap_or_else(|e| e.into_inner());
    let length = (body.len() as u32).to_ne_bytes();
    if out.write_all(&length).and_then(|_| out.write_all(body)).and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

// One line to the app; false if it isn't linked (or the line couldn't go).
fn to_app(state: &Arc<State>, message: &Value) -> bool {
    if !linked(state) {
        return false;
    }
    let mut line = message.to_string();
    line.push('\n');
    let mut app = state.app.lock().unwrap_or_else(|e| e.into_inner());
    let sent =
        app.as_mut().is_some_and(|writer| writer.write_all(line.as_bytes()).and_then(|_| writer.flush()).is_ok());
    if !sent {
        *app = None;
    }
    sent
}

// Linked to the app, or linking now: its hello, and a thread reading its lines. False if it isn't there.
fn linked(state: &Arc<State>) -> bool {
    let _one = state.linking.lock().unwrap_or_else(|e| e.into_inner());
    if state.app.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        return true;
    }
    let Some((reader, mut writer)) = os::connect(&state.facts.socket) else { return false };
    let hello = json!({
        "k": "relay", "v": 1, "version": state.facts.version, "pid": state.facts.pid,
        "browser": state.facts.browser, "waited": state.waited.load(Ordering::SeqCst),
    });
    if writer.write_all(format!("{hello}\n").as_bytes()).and_then(|_| writer.flush()).is_err() {
        return false;
    }
    *state.app.lock().unwrap_or_else(|e| e.into_inner()) = Some(writer);
    let state = state.clone();
    std::thread::spawn(move || read_app(&state, reader));
    true
}

// The app's lines: its welcome first (another version: exit), then each one to the browser as it is.
fn read_app(state: &State, reader: Box<dyn Read + Send>) {
    let mut welcomed = false;
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            continue;
        }
        if !welcomed {
            welcomed = true;
            if let Ok(welcome) = serde_json::from_str::<Value>(&line) {
                if welcome["k"] == "relayWelcome" {
                    let theirs = welcome["version"].as_str().unwrap_or_default();
                    if !theirs.is_empty() && !state.facts.version.is_empty() && theirs != state.facts.version {
                        std::process::exit(0); // another Margin app: the browser starts the new connector
                    }
                    continue;
                }
            }
        }
        to_browser(state, line.as_bytes());
    }
    // The app went (it quit, or was replaced): waited for again.
    *state.app.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.waited.store(true, Ordering::SeqCst);
}

// While the app isn't linked: what Safari's handler answers then (the copy asks again; the app says appUp once in).
fn answer_without_app(state: &State, message: &Value) {
    let launching = message["type"] == "wantLink" && launch(state);
    state.waited.store(true, Ordering::SeqCst);
    let reply = json!({ "ok": true, "appOpen": false, "launching": launching, "browser": state.facts.browser, "pid": state.facts.pid });
    to_browser(state, reply.to_string().as_bytes());
}

// The app started in the background, at most once per 10 s.
fn launch(state: &State) -> bool {
    if std::env::var_os("MARGIN_CONNECTOR_NO_LAUNCH").is_some() {
        return false;
    }
    let mut at = state.launched_at.lock().unwrap_or_else(|e| e.into_inner());
    if at.is_some_and(|t| t.elapsed() < Duration::from_secs(10)) {
        return true;
    }
    let started = os::launch_app();
    if started {
        *at = Some(Instant::now());
    }
    started
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_in_the_browsers_framing() {
        let body = br#"{"type":"ping"}"#;
        let mut input = (body.len() as u32).to_ne_bytes().to_vec();
        input.extend_from_slice(body);
        assert_eq!(read_frame(&mut input.as_slice()).as_deref(), Some(&body[..]));
        assert_eq!(read_frame(&mut [0u8, 0, 0, 0].as_slice()), None, "an empty frame ends it");
        assert_eq!(read_frame(&mut [9u8, 0, 0, 0, b'{'].as_slice()), None, "a cut-off frame ends it");
    }
}
