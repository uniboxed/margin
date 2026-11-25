//! The page's hello (docs/CORE-REFACTOR.md step 3, part 10; MarginWindowController.swift `pageHello`): what Margin's
//! window answers its page's `{ op: 'hello' }`, built here from the Page's own state (its card's state and loader's
//! words, the start's) and the facts the window reads (its library's state, its windows, the themes, the apps and the
//! theme as their JSON, never parsed here; its own page, its minimums, a pane's loader, the cut panes, the hosted
//! window's frames).
//!
//! The same text as the Swift made, but for the head's keys (`windowId`, `profile`, `browser`, `mode`, `host`,
//! `platform`, `state`), which the Swift wrote in its dictionary's order, a new one each launch (Swift's hash seed):
//! here always in that order. Strings are written as JSONSerialization writes them (`\/`, the short escapes,
//! `\u00xx` for the other controls).

use std::fmt::Write;

use super::Page;

/// What the window reads for its hello (texts are JSON, as the Swift made them, unless said).
#[derive(Clone, Debug, Default)]
pub struct HelloFacts<'a> {
    pub window_id: i64,
    /// The browser (a string), the window's mode (a string).
    pub browser: &'a str,
    pub mode: &'a str,
    pub state: &'a str,
    pub windows: &'a str,
    pub themes: &'a str,
    pub apps: &'a str,
    /// Its own page shown (a string; None: null), its page's minimum width (None: null).
    pub margin_page: Option<&'a str>,
    pub page_minimum: Option<f64>,
    /// Said only when there are some (`{}`, `null`: none): the panes' and the apps' minimums, a pane's loader, the cut
    /// panes.
    pub pane_min: &'a str,
    pub app_min: &'a str,
    pub pane_loading: &'a str,
    pub pane_cut: &'a str,
    /// Its card's picture while it shows an item elsewhere (a string).
    pub picture: Option<&'a str>,
    pub hosted_frame: &'a str,
    pub hosted_frames: &'a str,
    pub theme: Option<&'a str>,
}

/// A string as JSONSerialization writes it, quoted.
pub fn ns_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '/' => out.push_str("\\/"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn opt(out: &mut String, s: Option<&str>) {
    match s {
        Some(s) => ns_string(out, s),
        None => out.push_str("null"),
    }
}

impl Page {
    /// The hello's JSON text.
    pub fn hello(&self, f: &HelloFacts) -> String {
        let mut o =
            String::with_capacity(f.state.len() + f.themes.len() + f.apps.len() + f.theme.map_or(0, str::len) + 1024);
        let _ = write!(o, "{{\"windowId\":{},\"profile\":\"\",\"browser\":", f.window_id);
        ns_string(&mut o, f.browser);
        o.push_str(",\"mode\":");
        ns_string(&mut o, f.mode);
        o.push_str(",\"host\":\"app-window\",\"platform\":{\"browser\":");
        ns_string(&mut o, f.browser);
        o.push_str(",\"os\":\"mac\",\"app\":true},\"state\":");
        o.push_str(f.state);
        o.push_str(",\"windows\":");
        o.push_str(f.windows);
        o.push_str(",\"themes\":");
        o.push_str(f.themes);
        o.push_str(",\"apps\":");
        o.push_str(f.apps);
        o.push_str(if self.hosting() { ",\"pageHosted\":true" } else { ",\"pageHosted\":false" });
        o.push_str(",\"layoutText\":true,\"saidText\":true,\"marginPage\":");
        opt(&mut o, f.margin_page);
        o.push_str(",\"pageMinWidth\":");
        match f.page_minimum {
            // (Swift's `Int(_:)` of the width: towards zero.)
            Some(w) if w.is_finite() => {
                let _ = write!(o, "{}", w.trunc() as i64);
            }
            _ => o.push_str("null"),
        }
        for (key, v, none) in [
            ("paneMin", f.pane_min, "{}"),
            ("appMin", f.app_min, "{}"),
            ("paneLoading", f.pane_loading, "null"),
            ("paneCut", f.pane_cut, "{}"),
        ] {
            if !v.is_empty() && v != none {
                let _ = write!(o, ",\"{key}\":{v}");
            }
        }
        o.push_str(",\"pageState\":\"");
        o.push_str(self.state().as_str());
        o.push_str("\",\"pageOpening\":");
        opt(&mut o, self.loader());
        o.push_str(",\"pageOpeningBundleId\":");
        opt(&mut o, self.loader_app());
        if self.copy_slow() {
            o.push_str(",\"pageSlow\":true");
        }
        if self.starting() {
            o.push_str(",\"pageStarting\":true");
            if let Some(why) = self.stuck() {
                o.push_str(",\"pageStuck\":");
                ns_string(&mut o, why);
            }
        }
        if self.state() == super::PageState::Elsewhere
            && let Some(p) = f.picture
        {
            o.push_str(",\"pagePicture\":");
            ns_string(&mut o, p);
        }
        o.push_str(",\"hostedFrame\":");
        o.push_str(f.hosted_frame);
        o.push_str(",\"hostedFrames\":");
        o.push_str(f.hosted_frames);
        o.push_str(",\"theme\":");
        o.push_str(f.theme.unwrap_or("null"));
        o.push('}');
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_as_json_serialization_writes_them() {
        let mut o = String::new();
        ns_string(&mut o, "a/\"\\\u{8}\t\n\u{b}\u{c}\r\u{1f}\u{7f}é\u{2028}😀");
        assert_eq!(o, "\"a\\/\\\"\\\\\\b\\t\\n\\u000b\\f\\r\\u001f\u{7f}é\u{2028}😀\"");
    }

    #[test]
    fn a_hello() {
        let p = Page::default();
        let f = HelloFacts {
            window_id: 3,
            browser: "safari",
            mode: "fullscreen",
            state: "{\"spaces\":[]}",
            windows: "[]",
            themes: "[]",
            apps: "[]",
            margin_page: Some("settings"),
            page_minimum: Some(400.9),
            pane_min: "{}",
            app_min: "{\"web\":[1,2]}",
            pane_loading: "null",
            pane_cut: "{}",
            picture: Some("data:image/png;base64,AA"),
            hosted_frame: "null",
            hosted_frames: "[]",
            theme: None,
        };
        let h = p.hello(&f);
        let v: serde_json::Value = serde_json::from_str(&h).unwrap_or_default();
        assert_eq!(v["windowId"], 3);
        assert_eq!(v["platform"]["os"], "mac");
        assert_eq!(v["pageMinWidth"], 400);
        assert_eq!(v["appMin"]["web"][1], 2);
        assert!(v.get("paneMin").is_none() && v.get("pagePicture").is_none() && v.get("pageStarting").is_none());
        assert_eq!(v["pageState"], "empty");
        assert!(h.ends_with(",\"hostedFrame\":null,\"hostedFrames\":[],\"theme\":null}"));
    }
}
