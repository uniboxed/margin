//! What the overlay's web view may load (OS-neutral, tested on the Mac): the overlay page's own files, from
//! `https://margin.invalid/<file>`, answered by the app itself (webview.rs `WebResourceRequested`), with the
//! Mac's Content-Security-Policy (app/macos/shell/OverlayWebView.swift `OverlaySchemeHandler.policy`). Every other
//! request, of any host and any scheme the web view lets the app see, is answered 403: the network is blocked,
//! as on the Mac.
//!
//! The files are read once, when the app starts (`OverlayFiles::load`), so nothing is read from disk on the UI
//! thread later: a rebuilt `dist/app` is picked up at the next launch.

use std::collections::HashMap;
use std::path::Path;

/// The overlay's origin. `.invalid` never resolves (RFC 2606), and https makes the page a secure context.
pub const ORIGIN: &str = "https://margin.invalid";
pub const HOST: &str = "margin.invalid";
/// The page every overlay loads.
pub const PAGE: &str = "https://margin.invalid/overlay.html";

/// Copied from OverlayWebView.swift (PLAN.md §4): scripts only Margin's own, styles adopted or inline, images
/// and fonts from data and blobs (a theme's bundled files), no connections, no frames, nothing posted.
pub const POLICY: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// The content type for a file of the overlay's folder, by extension; `None`: not served.
pub fn content_type(name: &str) -> Option<&'static str> {
    match name.rsplit_once('.')?.1 {
        "html" => Some("text/html; charset=utf-8"),
        "js" => Some("text/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        _ => None,
    }
}

/// The file a request asks for, if it's one Margin serves: a GET of `https://margin.invalid/<name>` (a query or
/// fragment is ignored), `<name>` one path segment, not starting with a dot, of a served type.
pub fn requested_file(uri: &str, method: &str) -> Option<String> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let rest = uri.strip_prefix("https://")?;
    let rest = rest.split(['#', '?']).next().unwrap_or("");
    let (host, path) = rest.split_once('/')?;
    if !host.eq_ignore_ascii_case(HOST) {
        return None;
    }
    let name = path;
    let ok = !name.is_empty()
        && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && content_type(name).is_some();
    ok.then(|| name.to_string())
}

/// The headers of a served file, as WebView2's `CreateWebResourceResponse` takes them (`\r\n` between).
pub fn headers_ok(content_type: &str, length: usize) -> String {
    format!(
        "Content-Type: {content_type}\r\nContent-Length: {length}\r\nContent-Security-Policy: {POLICY}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff"
    )
}

/// The headers of a refusal.
pub fn headers_refused() -> String {
    format!("Content-Security-Policy: {POLICY}\r\nCache-Control: no-store")
}

/// The overlay's files, in memory.
#[derive(Clone, Debug, Default)]
pub struct OverlayFiles {
    files: HashMap<String, Vec<u8>>,
}

impl OverlayFiles {
    /// Reads every served file directly in `dir` (not its subfolders). Files of other types are left out.
    pub fn load(dir: &Path) -> std::io::Result<Self> {
        let mut files = HashMap::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
            if requested_file(&format!("{ORIGIN}/{name}"), "GET").is_none() || !entry.file_type()?.is_file() {
                continue;
            }
            files.insert(name, std::fs::read(entry.path())?);
        }
        Ok(Self { files })
    }

    pub fn from_map(files: HashMap<String, Vec<u8>>) -> Self {
        Self { files }
    }

    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.files.get(name).map(Vec::as_slice)
    }

    pub fn has_page(&self) -> bool {
        self.files.contains_key("overlay.html")
    }

    pub fn names(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.files.keys().map(String::as_str).collect();
        v.sort();
        v
    }
}

/// How one request is answered.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer<'a> {
    File { body: &'a [u8], content_type: &'static str },
    Refused,
}

pub fn answer<'a>(files: &'a OverlayFiles, uri: &str, method: &str) -> Answer<'a> {
    match requested_file(uri, method) {
        Some(name) => match (files.get(&name), content_type(&name)) {
            (Some(body), Some(content_type)) => Answer::File { body, content_type },
            _ => Answer::Refused,
        },
        None => Answer::Refused,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_margins_files() {
        assert_eq!(requested_file("https://margin.invalid/overlay.html", "GET").as_deref(), Some("overlay.html"));
        assert_eq!(requested_file("https://MARGIN.invalid/overlay.js?x=1#y", "get").as_deref(), Some("overlay.js"));
        assert_eq!(requested_file("https://margin.invalid/arcadia.js", "GET").as_deref(), Some("arcadia.js"));
        for (uri, method) in [
            ("https://margin.invalid/overlay.html", "POST"),
            ("http://margin.invalid/overlay.html", "GET"),
            ("https://margin.invalid.evil.test/overlay.html", "GET"),
            ("https://evil.test/overlay.html", "GET"),
            ("https://margin.invalid/sub/overlay.js", "GET"),
            ("https://margin.invalid/../overlay.js", "GET"),
            ("https://margin.invalid/.hidden.js", "GET"),
            ("https://margin.invalid/%2e%2e.js", "GET"),
            ("https://margin.invalid/image.png", "GET"),
            ("https://margin.invalid/", "GET"),
            ("https://margin.invalid", "GET"),
            ("file:///C:/overlay.html", "GET"),
            ("data:text/html,hi", "GET"),
            ("wss://margin.invalid/overlay.js", "GET"),
        ] {
            assert_eq!(requested_file(uri, method), None, "{uri}");
        }
    }

    #[test]
    fn answers() {
        let files = OverlayFiles::from_map(HashMap::from([("overlay.html".to_string(), b"<p>".to_vec())]));
        assert_eq!(
            answer(&files, PAGE, "GET"),
            Answer::File { body: b"<p>", content_type: "text/html; charset=utf-8" }
        );
        assert_eq!(answer(&files, "https://margin.invalid/overlay.js", "GET"), Answer::Refused);
        assert_eq!(answer(&files, "https://example.com/", "GET"), Answer::Refused);
    }

    #[test]
    fn headers_carry_the_policy() {
        let h = headers_ok("text/html; charset=utf-8", 3);
        assert!(h.contains("Content-Length: 3\r\n"));
        assert!(h.contains("connect-src 'none'"));
        assert!(!h.ends_with("\r\n"));
        assert!(headers_refused().starts_with("Content-Security-Policy: default-src 'none'"));
    }

    #[test]
    fn loads_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("overlay.html"), "<html>").unwrap();
        std::fs::write(dir.path().join("overlay.js"), "1").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
        std::fs::write(dir.path().join(".x.js"), "x").unwrap();
        std::fs::create_dir(dir.path().join("sub.js")).unwrap();
        let files = OverlayFiles::load(dir.path()).unwrap();
        assert_eq!(files.names(), vec!["overlay.html", "overlay.js"]);
        assert!(files.has_page());
    }
}
