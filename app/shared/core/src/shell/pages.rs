//! The overlays' pages (Overlay.swift `pageSaid`, OverlayWebView.swift's bridge, Shell.swift `hello(for:)`,
//! `send`, `perform`, `shownSpace`) and imported themes (ShellThemes.swift).

use serde_json::{Value, json};

use crate::data::themes::{self, ThemeFile};
use crate::geometry::Rect;
use crate::json::{self, Object};
use crate::passthrough::PointerWant;
use crate::protocol::PageLayout;

use super::{Command, OverlayId, Pending, ReplyToken, Shell, WindowKey, json_text};

/// What a page's `copyText` may carry, at most.
pub const COPY_TEXT_MAX: usize = 8192;

impl Shell {
    pub(crate) fn page_op(&mut self, id: OverlayId, op: &str, body: Object, reply: Option<ReplyToken>) {
        let Some(key) = self.by_id.get(&id).cloned() else {
            if let Some(token) = reply {
                self.out.push(Command::Reply { token, result: Err("no overlay".into()) });
            }
            return;
        };
        match op {
            "hello" => {
                let hello = self.hello_json(&key);
                if let Some(o) = self.overlays.get_mut(&key) {
                    o.asked = true;
                }
                if let Some(token) = reply {
                    self.out.push(Command::Reply { token, result: Ok(Value::String(hello)) });
                }
            }
            "send" => {
                let kind = json::string(body.get("type")).filter(|t| (1..=64).contains(&t.chars().count()));
                let Some(kind) = kind.map(str::to_owned) else {
                    if let Some(token) = reply {
                        self.out.push(Command::Reply { token, result: Err("no type".into()) });
                    }
                    return;
                };
                let payload = json::object(body.get("payload")).cloned().unwrap_or_default();
                self.page_send(&key, &kind, payload, reply);
            }
            _ => {
                self.page_said(&key, op, &body);
                if let Some(token) = reply {
                    self.out.push(Command::Reply { token, result: Ok(Value::Null) });
                }
            }
        }
    }

    /// A page's `send { type, payload }`: a `req` for its window; the reply (or why none) goes back to the page.
    fn page_send(&mut self, key: &WindowKey, kind: &str, payload: Object, reply: Option<ReplyToken>) {
        let token = reply.unwrap_or(0);
        let then = match reply {
            Some(token) => Pending::Page { token, overlay: key.clone(), kind: kind.to_owned(), asked: self.now },
            None => Pending::Ignore,
        };
        let sent = self.request(&key.link, kind, Value::Object(payload), Some(key.window_id), then);
        if !sent && reply.is_some() {
            self.out.push(Command::Reply { token, result: Err("no answer from Margin: down".into()) });
        }
    }

    /// Everything else a page says.
    fn page_said(&mut self, key: &WindowKey, op: &str, body: &Object) {
        let now = self.now;
        match op {
            "ready" => {
                let Some(o) = self.overlays.get_mut(key) else { return };
                if o.ready {
                    return;
                }
                o.ready = true;
                self.out.note(format!("overlay page drawn ({key})"));
                self.soon();
            }
            "layout" => {
                let Some(layout) = json::object(body.get("geometry")).and_then(PageLayout::from_geometry) else {
                    return;
                };
                let Some(o) = self.overlays.get_mut(key) else { return };
                o.layout = Some(layout.clone());
                self.layout_changed(key, &layout);
                self.pointer_again();
            }
            "hits" => {
                let rects: Vec<Rect> = json::array(body.get("rects"))
                    .map(|a| {
                        a.iter()
                            .filter_map(|r| {
                                let n: Vec<f64> = r.as_array()?.iter().filter_map(|v| json::num(Some(v))).collect();
                                (n.len() == 4).then(|| Rect::new(n[0], n[1], n[2], n[3]))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let Some(o) = self.overlays.get_mut(key) else { return };
                o.capture_all = json::boolean(body.get("all")) == Some(true) || rects.len() > 64;
                o.hits = rects.into_iter().take(64).collect();
                self.pointer_again();
            }
            "focus" => {
                let on = json::boolean(body.get("on")) == Some(true);
                let Some(o) = self.overlays.get_mut(key) else { return };
                o.page_wants_keyboard = on;
                o.page_focus_at = on.then_some(now);
                if !on {
                    o.hand_back(&mut self.out, "its field let go of the focus");
                } else if o.shown {
                    o.take_keyboard(&mut self.out, now);
                } else {
                    self.out.note(format!(
                        "{key}: a field of its page has the focus, but the overlay isn't shown: the keyboard waits for it to show"
                    ));
                }
            }
            "pointerWant" => {
                if let Some(o) = self.overlays.get_mut(key) {
                    o.pointer_want = PointerWant::from_json(body);
                }
            }
            "perform" => {
                let name = json::string(body.get("name")).unwrap_or("").to_owned();
                self.perform(key, &name, body.get("arg").cloned().unwrap_or(Value::Null));
            }
            "shownSpace" => self.shown_space(key, body),
            "log" => {
                let text = format!("overlay page ({key}): {}", json::string(body.get("text")).unwrap_or(""));
                if matches!(json::string(body.get("level")), Some("error" | "warn")) {
                    self.out.warn(text);
                } else {
                    self.out.note(text);
                }
            }
            // `framed` is the handoff's (R4): nothing to do here.
            _ => {}
        }
    }

    /// The pointer looked at again for every overlay (its slot or hits changed).
    fn pointer_again(&mut self) {
        if let Some((at, buttons)) = self.pointer {
            self.pointer_moved(at, buttons, true);
        }
    }

    pub(crate) fn page_crashed(&mut self, id: OverlayId) {
        let now = self.now;
        let Some(o) = self.by_id.get(&id).and_then(|k| self.overlays.get_mut(k)) else { return };
        o.crashed(&mut self.out, now);
        self.soon();
    }

    /// The overlay's window took the foreground (it has the keyboard) or lost it (the person clicked elsewhere): the
    /// page lets go of its focus then (the Mac's `blur`).
    pub(crate) fn overlay_focus(&mut self, id: OverlayId, has: bool) {
        let Some(o) = self.by_id.get(&id).and_then(|k| self.overlays.get_mut(k)) else { return };
        if has || !o.has_keyboard {
            return;
        }
        o.has_keyboard = false;
        self.out.note(format!("{} gave the keyboard back: another window took the foreground", o.key));
        if o.page_wants_keyboard {
            o.page_wants_keyboard = false;
            o.page_focus_at = None;
            o.push(&mut self.out, r#"{"type":"blur"}"#);
        }
    }

    /// The reply to the page's `hello`: exactly `{windowId, profile, browser, mode, platform, state, windows, across,
    /// cloudTabs, held, themes, theme}` (Shell.hello(for:)), as JSON text.
    pub(crate) fn hello_json(&mut self, key: &WindowKey) -> String {
        let Some(entry) = self.links.get(&key.link) else { return "null".into() };
        let hello = entry.hello.clone();
        let list: Vec<Value> = entry.mirror.windows().iter().cloned().map(Value::Object).collect();
        let window = crate::binder::ExtWindow::parse(&list, &key.link).into_iter().find(|w| &w.key == key);
        let mode = if window.is_some_and(|w| w.state == "fullscreen") { "fullscreen" } else { "windowed" };
        let head = json!({
            "windowId": key.window_id, "profile": hello.profile, "browser": hello.browser, "mode": mode,
            "platform": { "browser": hello.browser, "os": self.opts.platform_os, "app": true },
        });
        let state = entry.mirror.state_json().unwrap_or_else(|| "null".into());
        let windows = json_text(&Value::Array(list));
        let held = json_text(&Value::Array(
            entry.held.messages(key.window_id, self.now).into_iter().map(Value::Object).collect(),
        ));
        let mut out = json_text(&head);
        out.pop();
        out.push_str(&format!(r#","state":{state},"windows":{windows}"#));
        let across = self.across_json_for(key).unwrap_or_else(|| "null".into());
        out.push_str(&format!(r#","across":{across},"cloudTabs":null,"held":{held}"#));
        let list = self.themes_list_json();
        let theme = self.overlay_theme(&key.link, Some(key)).unwrap_or_else(|| "null".into());
        out.push_str(&format!(r#","themes":{list},"theme":{theme}}}"#));
        out
    }

    /// The space a sidebar shows, in the log beside what its copy's state says of that window (space ids only).
    fn shown_space(&mut self, key: &WindowKey, said: &Object) {
        let space = json::string(said.get("space")).unwrap_or("-");
        let foreign = if json::boolean(said.get("foreign")) == Some(true) { " (another profile's)" } else { "" };
        let for_window = match json::int(said.get("windowId")) {
            Some(w) if w != key.window_id => format!(" for window {w}"),
            _ => String::new(),
        };
        let copy =
            self.links.get(&key.link).and_then(|e| e.mirror.value("openTabs")).and_then(|o| {
                o.get("activeSpaceByWindow")?.get(key.window_id.to_string())?.as_str().map(str::to_owned)
            });
        let differs = if copy.as_deref() == Some(space) { "" } else { " (differs)" };
        self.out.note(format!(
            "{key}: its sidebar shows space {space}{foreign}{for_window} — its copy says {}{differs}",
            copy.as_deref().unwrap_or("-")
        ));
    }

    /// What only the app can do (host-app.ts `perform`).
    pub(crate) fn perform(&mut self, key: &WindowKey, name: &str, arg: Value) {
        if !self.links.contains_key(&key.link) {
            return;
        }
        let a = arg.as_object().cloned().unwrap_or_default();
        match name {
            "window.fullscreen" => {
                self.ask(&key.link, "toggleFullscreen", json!({ "windowId": key.window_id }), Some(key.window_id));
            }
            _ if name.starts_with("profile.") || name.starts_with("switch.") || name == "space.move" => {
                self.perform_across(key, name, &a);
            }
            "copyText" => {
                let Some(text) = json::string(a.get("text")) else { return };
                let text: String = text.chars().take(COPY_TEXT_MAX).collect();
                self.out.push(Command::CopyText { text });
            }
            "cloud.access" => self.out.note(format!("{key}: cloud.access is the Mac's (iCloud Tabs)")),
            _ if name.starts_with("theme.") => self.perform_theme(key, name, &a),
            _ => self.out.note(format!("{key}: {name} isn't the app's yet")),
        }
    }

    // ---- user themes (ShellThemes.swift) ----

    fn perform_theme(&mut self, key: &WindowKey, name: &str, a: &Object) {
        match name {
            "theme.import" => {
                if self.picking {
                    return;
                }
                let Some(o) = self.overlays.get(key) else { return };
                self.picking = true;
                self.out.push(Command::PickThemeFile { id: o.id });
            }
            "theme.save" => {
                let Some(value) = json::object(a.get("value")) else { return };
                match self.themes.save(value, (self.now * 1000.0).round()) {
                    Ok(entry) => {
                        let id = json::string(entry.get("id")).unwrap_or("").to_owned();
                        let bytes = json::int(entry.get("bytes")).unwrap_or(0);
                        self.out.note(format!("themes: one stored for {key} ({bytes} bytes)"));
                        self.themes_list_changed();
                        let payload = json!({ "patch": { "theme": id } });
                        self.ask(&key.link, "updateSettings", payload, Some(key.window_id));
                    }
                    Err(e) => {
                        self.out.warn(format!("themes: one refused for storing: {e}"));
                        let msg = json!({ "type": "themeSaved", "ok": false, "error": format!("Margin couldn’t keep that theme ({e}).") });
                        if let Some(o) = self.overlays.get(key) {
                            o.push(&mut self.out, json_text(&msg));
                        }
                    }
                }
            }
            "theme.remove" => {
                let Some(id) = json::string(a.get("id")).filter(|id| themes::id_ok(id)).map(str::to_owned) else {
                    return;
                };
                match self.themes.remove(&id) {
                    Ok(true) => self.out.note("themes: one removed"),
                    Ok(false) => return,
                    Err(e) => return self.out.warn(format!("themes: one couldn't be removed: {e}")),
                }
                // Every linked copy that used it: back to Arcadia.
                let using: Vec<String> = self
                    .links
                    .iter()
                    .filter(|(_, e)| {
                        e.mirror
                            .value("settings")
                            .and_then(|s| s.get("theme").and_then(Value::as_str).map(str::to_owned))
                            == Some(id.clone())
                    })
                    .map(|(k, _)| k.clone())
                    .collect();
                for link in using {
                    self.ask(&link, "updateSettings", json!({ "patch": { "theme": "arcadia" } }), None);
                }
                self.themes_list_changed();
            }
            _ => self.out.note(format!("{key}: {name} isn't the app's yet")),
        }
    }

    /// What the person chose in the picker, read: to that overlay only.
    pub(crate) fn theme_file_read(&mut self, id: OverlayId, file: Option<ThemeFile>) {
        self.picking = false;
        let Some(key) = self.by_id.get(&id).cloned() else { return };
        let Some(file) = file else {
            self.out.note("themes: the picker closed with nothing chosen");
            return;
        };
        if file.kind == "refused" {
            self.out.note("themes: something other than a folder or a .margintheme file chosen");
        } else {
            self.out.note(format!("themes: a {} read for {key} ({} bytes)", file.kind, file.bytes));
        }
        if let Some(o) = self.overlays.get(&key) {
            o.push(&mut self.out, json_text(&file.message));
        }
    }

    /// The index as the overlays and copies get it.
    pub(crate) fn themes_list_json(&self) -> String {
        json_text(&Value::Array(self.themes.list().into_iter().map(Value::Object).collect()))
    }

    /// The index changed: every overlay told, every linked copy told, every overlay's package checked.
    fn themes_list_changed(&mut self) {
        let list = self.themes_list_json();
        for o in self.overlays.values() {
            o.push(&mut self.out, format!(r#"{{"type":"themes","list":{list}}}"#));
        }
        let links: Vec<String> = self.links.keys().cloned().collect();
        for link in &links {
            self.themes_tell_copy(link);
        }
        for link in &links {
            self.themes_check(link);
        }
    }

    /// A copy linked (its first snapshot): the index, so its updateSettings takes an imported theme's id.
    pub(crate) fn themes_tell_copy(&mut self, link: &str) {
        let list = Value::Array(self.themes.list().into_iter().map(Value::Object).collect());
        self.ask(link, "userThemes", json!({ "list": list }), None);
    }

    /// The package each of this copy's overlays draws: pushed where it changed.
    pub(crate) fn themes_check(&mut self, link: &str) {
        let keys: Vec<WindowKey> = self.overlays.keys().filter(|k| k.link == link).cloned().collect();
        for key in keys {
            let Some(json) = self.overlay_theme(link, None) else { continue };
            if self.themes_sent.get(&key) == Some(&json) {
                continue;
            }
            self.themes_sent.insert(key.clone(), json.clone());
            if let Some(o) = self.overlays.get(&key) {
                o.push(&mut self.out, format!(r#"{{"type":"theme","theme":{json}}}"#));
            }
        }
        let overlays = &self.overlays;
        self.themes_sent.retain(|k, _| overlays.contains_key(k));
    }

    /// The package an overlay of `link` draws, as JSON: the stored one for an imported `settings.theme`, else the
    /// copy's. `for_overlay`: taken as sent to it (its hello).
    pub(crate) fn overlay_theme(&mut self, link: &str, for_overlay: Option<&WindowKey>) -> Option<String> {
        let entry = self.links.get(link)?;
        let chosen =
            entry.mirror.value("settings").and_then(|s| s.get("theme").and_then(Value::as_str).map(str::to_owned));
        let copy = entry.theme.clone();
        let json = chosen.and_then(|id| self.themes.message(&id)).or(copy);
        if let (Some(k), Some(j)) = (for_overlay, &json) {
            self.themes_sent.insert(k.clone(), j.clone());
        }
        json
    }
}
