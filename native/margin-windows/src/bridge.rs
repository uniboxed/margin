//! The overlay page's line to the app, as text (OS-neutral, tested on the Mac); webview.rs carries it.
//!
//! Page → app: `window.chrome.webview.postMessage({ op, ...body, rid })`, which WebView2 gives the app as JSON
//! (`WebMessageAsJson`). The app answers every message that has a `rid` with
//! `PostWebMessageAsJson({ reply: rid, ok: true, value })` or `{ reply: rid, ok: false, error }`; the page's
//! bridge (extension/ui/overlay-bridge.ts) matches replies by `rid` and waits for each, so none may go unanswered
//! (WebKit's `postMessage` returns a promise; WebView2's doesn't).
//! App → page: `ExecuteScript("marginApp.receive(<the JSON as a string literal>)")`, as the Mac's
//! `callAsyncJavaScript("marginApp.receive(m)", ["m": json])` (OverlayWebView.swift): the page gets one string.

use serde_json::{Map, Value};

/// A message from the page.
#[derive(Clone, Debug, PartialEq)]
pub struct PageMessage {
    /// Its request id (a number or a string), when it wants a reply.
    pub id: Option<Value>,
    pub op: String,
    /// Everything else it said.
    pub body: Map<String, Value>,
}

/// Reads one message: a JSON object with an `op` of 1–64 characters, and a `rid` that is a number or a
/// string of at most 64 characters, when there is one.
pub fn parse_page_message(json: &str) -> Result<PageMessage, &'static str> {
    let Ok(Value::Object(mut body)) = serde_json::from_str::<Value>(json) else { return Err("not an object") };
    let op = match body.remove("op") {
        Some(Value::String(op)) if (1..=64).contains(&op.chars().count()) => op,
        _ => return Err("no op"),
    };
    let id = match body.remove("rid") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(Value::Number(n)),
        Some(Value::String(s)) if s.len() <= 64 => Some(Value::String(s)),
        Some(_) => return Err("a bad id"),
    };
    Ok(PageMessage { id, op, body })
}

/// The reply to the message with this id.
pub fn reply_json(id: &Value, result: Result<Value, String>) -> String {
    let mut m = Map::new();
    m.insert("reply".into(), id.clone());
    match result {
        Ok(value) => {
            m.insert("ok".into(), Value::Bool(true));
            m.insert("value".into(), value);
        }
        Err(error) => {
            m.insert("ok".into(), Value::Bool(false));
            m.insert("error".into(), Value::String(error));
        }
    }
    Value::Object(m).to_string()
}

/// The script that hands the page one message from the app (`json`: the message as JSON text).
pub fn receive_script(json: &str) -> String {
    // A JSON string literal is a JavaScript string literal (since ES2019, U+2028 and U+2029 included).
    format!("marginApp.receive({})", Value::String(json.to_string()))
}

/// Whether a message came from Margin's page (WebView2's `Source` of the message): the page itself, at its
/// origin, nothing else (a frame can't post to the top-level `WebMessageReceived`, and there are none: CSP).
pub fn is_page_source(source: &str) -> bool {
    source == crate::serve::PAGE
        || source.starts_with(&format!("{}?", crate::serve::PAGE))
        || source.starts_with(&format!("{}#", crate::serve::PAGE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn page_messages() {
        let m = parse_page_message(r#"{"rid":3,"op":"send","type":"activateTab","payload":{"tabId":1}}"#).unwrap();
        assert_eq!(m.id, Some(json!(3)));
        assert_eq!(m.op, "send");
        assert_eq!(m.body.get("type"), Some(&json!("activateTab")));
        assert!(!m.body.contains_key("op") && !m.body.contains_key("rid"));
        assert_eq!(parse_page_message(r#"{"op":"ready"}"#).unwrap().id, None);
        assert_eq!(parse_page_message(r#"{"rid":"a-1","op":"hello"}"#).unwrap().id, Some(json!("a-1")));
    }

    #[test]
    fn bad_page_messages() {
        assert!(parse_page_message("[1]").is_err());
        assert!(parse_page_message(r#""hello""#).is_err());
        assert!(parse_page_message(r#"{"rid":1}"#).is_err());
        assert!(parse_page_message(r#"{"op":""}"#).is_err());
        assert!(parse_page_message(&format!(r#"{{"op":"{}"}}"#, "x".repeat(65))).is_err());
        assert!(parse_page_message(r#"{"op":"x","rid":{"a":1}}"#).is_err());
    }

    #[test]
    fn replies() {
        assert_eq!(reply_json(&json!(3), Ok(json!({"a": 1}))), r#"{"reply":3,"ok":true,"value":{"a":1}}"#);
        assert_eq!(reply_json(&json!("x"), Err("no".into())), r#"{"reply":"x","ok":false,"error":"no"}"#);
    }

    #[test]
    fn receive_is_one_string() {
        let s = receive_script(r#"{"type":"blur","x":"</script>\"q"}"#);
        assert_eq!(s, r#"marginApp.receive("{\"type\":\"blur\",\"x\":\"</script>\\\"q\"}")"#);
        let s = receive_script("{\"a\":\"\u{2028}\"}");
        assert!(s.starts_with("marginApp.receive(\"{") && s.ends_with("}\")"));
    }

    #[test]
    fn sources() {
        assert!(is_page_source("https://margin.invalid/overlay.html"));
        assert!(is_page_source("https://margin.invalid/overlay.html#x"));
        assert!(!is_page_source("https://margin.invalid/overlay.html.evil"));
        assert!(!is_page_source("https://example.com/"));
    }
}
