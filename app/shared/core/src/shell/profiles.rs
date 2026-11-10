//! Spaces across profiles and the switch, the shell's side (app/macos/shell/ShellProfiles.swift): each overlay's `across`,
//! the space keys and a click on another profile's space, what the overlay asks of the profiles (`perform`), the
//! settings a switch carries and a browser's profiles share, and the shell as the switch's world
//! ([`crate::switch::SwitchWorld`]: requests over the links, windows from the copies' lists, "in front" from the last
//! read).
//!
//! Left out (the Mac's): Safari's own profile names and symbols (SafariProfiles.swift), the carry-over of a profile's
//! set to new ids, opening a profile's window through Accessibility, Margin off in a profile as Safari's settings
//! say, the handoff's cover and parked windows, and the DEV-HOOK `dev` switches.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Value, json};

use crate::across::{self, AcrossData, KeyAction, ProfileView, SpaceIds, SpaceKey};
use crate::data::profiles::BrowserProfiles;
use crate::data::set::{DataChange, DataItem};
use crate::data::store::DataProfile;
use crate::data::sync::DataSync;
use crate::json::{self, Object};
use crate::socket::SocketLink;
use crate::switch::{self, CopyWindow, LineId, RequestId, SwitchEvent, SwitchNotice, SwitchWorld, Target};
use crate::time::Secs;

use super::{Command, Lines, LinkEntry, Out, Pending, Shell, WindowKey, WindowRead, json_text, scrub};

/// What `across` is made of, borrowed from the shell (AcrossData: its links' mirrors, the data, the profiles).
struct View<'a> {
    links: &'a BTreeMap<String, LinkEntry>,
    data: RefCell<&'a mut DataSync>,
    profiles: &'a mut HashMap<String, BrowserProfiles>,
    root: std::path::PathBuf,
    now_ms: f64,
}

impl View<'_> {
    fn profiles_of(&mut self, browser: &str) -> &mut BrowserProfiles {
        let root = self.root.clone();
        self.profiles.entry(browser.to_owned()).or_insert_with(|| BrowserProfiles::new(browser, Some(&root)))
    }
}

impl AcrossData for View<'_> {
    fn profiles_with_data(&self, browser: &str) -> Vec<String> {
        let mut out: Vec<String> = self.data.borrow().profiles(Some(browser)).into_iter().map(|p| p.profile).collect();
        for e in self.links.values().filter(|e| e.hello.browser == browser) {
            if !out.contains(&e.hello.profile) {
                out.push(e.hello.profile.clone());
            }
        }
        out
    }
    fn copy_spaces(&self, link: &str) -> Option<Vec<Value>> {
        let e = self.links.get(link).filter(|e| e.mirror.has_state())?;
        match e.mirror.value("spaces")? {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }
    fn values(&self, link: &str, collection: &str) -> Vec<(String, Value)> {
        let Some((browser, profile)) = link.split_once(':') else { return Vec::new() };
        self.data.borrow_mut().values(collection, &DataProfile::new(browser, profile)).into_iter().collect()
    }
    fn linked(&self, browser: &str) -> HashSet<String> {
        self.links.values().filter(|e| e.hello.browser == browser).map(|e| e.hello.profile.clone()).collect()
    }
    fn refresh(&mut self, browser: &str, spaces: &SpaceIds, linked: &HashSet<String>) {
        let spaces: HashMap<String, Vec<String>> = spaces.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        self.profiles_of(browser).refresh(&spaces, linked);
    }
    fn order(&self, browser: &str) -> Vec<SpaceKey> {
        self.profiles
            .get(browser)
            .map(|p| p.order().iter().map(|k| SpaceKey::new(&k.profile, &k.space)).collect())
            .unwrap_or_default()
    }
    fn known_profiles(&self, browser: &str) -> Vec<String> {
        self.profiles.get(browser).map(BrowserProfiles::profiles).unwrap_or_default()
    }
    fn profile(&self, browser: &str, profile: &str) -> ProfileView {
        let Some(p) = self.profiles.get(browser) else { return ProfileView::default() };
        let info = p.info(profile).cloned().unwrap_or_default();
        ProfileView {
            name: p.name(profile),
            emoji: info.emoji,
            color: p.color(profile),
            named: info.named,
            last_seen: info.last_seen,
            name_from: None,
            symbol: None,
        }
    }
    fn close_windows(&self, browser: &str) -> bool {
        self.profiles.get(browser).is_some_and(BrowserProfiles::close_windows)
    }
    fn active_space(&self, link: &str, window_id: i64) -> Option<String> {
        let open = self.links.get(link)?.mirror.value("openTabs")?;
        open.get("activeSpaceByWindow")?.get(window_id.to_string())?.as_str().map(str::to_owned)
    }
    fn now_ms(&self) -> f64 {
        self.now_ms
    }
}

/// The shell as the switch's world, borrowed for one call.
struct World<'a> {
    link: &'a mut SocketLink,
    links: &'a BTreeMap<String, LinkEntry>,
    matches: &'a BTreeMap<WindowKey, i64>,
    read: &'a WindowRead,
    lines: &'a mut Lines,
    pending: &'a mut HashMap<(crate::link::ConnId, i64), Pending>,
    next_rid: &'a mut RequestId,
    out: &'a mut Out,
    events: Vec<SwitchEvent>,
    notices: Vec<SwitchNotice>,
    /// Requests that couldn't go: answered with an error after the call.
    failed: Vec<RequestId>,
    now: Secs,
}

impl SwitchWorld for World<'_> {
    fn is_linked(&self, link: &str) -> bool {
        self.links.get(link).is_some_and(|e| e.mirror.has_state())
    }
    fn request(&mut self, link: &str, kind: &str, payload: Value, window_id: Option<i64>) -> RequestId {
        let rid = *self.next_rid;
        *self.next_rid += 1;
        let conn = self.links.get(link).map(|e| e.conn);
        let payload = match payload {
            Value::Object(o) => o,
            _ => Object::new(),
        };
        match conn.map(|c| (c, self.link.request(c, kind, payload, window_id, self.now))) {
            Some((conn, Ok((id, bytes)))) => {
                self.out.push(Command::Write { conn, bytes });
                let p = Pending::Switch { rid, kind: kind.to_owned(), link: link.to_owned(), asked: self.now };
                self.pending.insert((conn, id), p);
            }
            _ => self.failed.push(rid),
        }
        rid
    }
    fn windows(&self, link: &str) -> Vec<CopyWindow> {
        let Some(e) = self.links.get(link) else { return Vec::new() };
        let list: Vec<Value> = e.mirror.windows().iter().cloned().map(Value::Object).collect();
        crate::binder::ExtWindow::parse(&list, link)
            .into_iter()
            .map(|w| CopyWindow::new(w.key.window_id, &w.state))
            .collect()
    }
    fn in_front(&self, link: &str, window_id: i64) -> bool {
        let Some(number) = self.matches.get(&WindowKey::new(link, window_id)) else { return false };
        let Some(e) = self.links.get(link) else { return false };
        let pid = e.hello.pid.and_then(|p| u32::try_from(p).ok());
        let pids: HashSet<u32> = match pid {
            Some(pid) => {
                std::iter::once(pid).chain(self.read.browsers.iter().filter(|p| p.root == pid).map(|p| p.pid)).collect()
            }
            None => self.read.browsers.iter().filter(|p| p.browser == e.hello.browser).map(|p| p.pid).collect(),
        };
        let first = crate::binder::candidates(&self.read.list, &pids)
            .into_iter()
            .filter(|w| w.on_screen)
            .min_by_key(|w| w.order);
        first.is_some_and(|w| w.number == *number)
    }
    fn switch_changed(&mut self, event: &SwitchEvent) {
        self.events.push(event.clone());
    }
    fn keeps_lines(&self) -> bool {
        true
    }
    fn line_for(&mut self, link: &str, window_id: i64) -> Option<LineId> {
        self.matches.contains_key(&WindowKey::new(link, window_id)).then(|| self.lines.line_for(link, window_id))
    }
    fn home(&self, line: LineId, link: &str) -> Option<i64> {
        self.lines.home(line, link).filter(|w| self.matches.contains_key(&WindowKey::new(link, *w)))
    }
    fn line_of(&self, link: &str, window_id: i64) -> Option<LineId> {
        if !self.matches.contains_key(&WindowKey::new(link, window_id)) {
            return None;
        }
        self.lines.line_of(link, window_id)
    }
    fn note_shown(&mut self, link: &str, window_id: i64, line: Option<LineId>) {
        if self.matches.contains_key(&WindowKey::new(link, window_id)) {
            self.lines.note_shown(link, window_id, line);
        }
    }
    fn asks_drafts(&self) -> bool {
        true
    }
    fn show_notice(&mut self, notice: &SwitchNotice) {
        self.notices.push(notice.clone());
    }
}

/// One call into the switch.
enum SwitchCall {
    Tick,
    Answered(RequestId, Result<Value, String>),
    Start { to: Target, from: String, window_id: Option<i64> },
}

fn sw(k: &WindowKey) -> switch::WindowKey {
    switch::WindowKey::new(&k.link, k.window_id)
}

/// The browser as the person knows it, for the switch's words.
fn browser_name(browser: &str) -> String {
    match browser {
        "edge" => "Edge".into(),
        "chrome" => "Chrome".into(),
        "safari" => "Safari".into(),
        other => {
            let mut c = other.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

fn make_view<'a>(
    links: &'a BTreeMap<String, LinkEntry>,
    data: &'a mut DataSync,
    profiles: &'a mut HashMap<String, BrowserProfiles>,
    now: Secs,
) -> View<'a> {
    let root = data.store().root().to_path_buf();
    View { links, data: RefCell::new(data), profiles, root, now_ms: (now * 1000.0).round() }
}

/// The shell's `View`, borrowing only the fields it needs (so the rest stays usable beside it).
macro_rules! view {
    ($s:expr) => {
        make_view(&$s.links, &mut $s.data, &mut $s.profiles, $s.now)
    };
}

impl Shell {
    fn profiles_of(&mut self, browser: &str) -> &mut BrowserProfiles {
        let root = self.data.store().root().to_path_buf();
        self.profiles.entry(browser.to_owned()).or_insert_with(|| BrowserProfiles::new(browser, Some(&root)))
    }

    /// The order brought up to date, then every overlay told if its `across` changed (after this input).
    pub(crate) fn across_soon(&mut self) {
        self.across_queued = true;
    }

    fn switching(&mut self) -> Option<Object> {
        let notice = self.switch_notice.clone();
        let view = view!(self);
        across::switching_json(&view, &self.switcher, notice.as_ref())
    }

    /// `across` for the overlay of a window of `key.link`, taken as sent to it (its hello).
    pub(crate) fn across_json_for(&mut self, key: &WindowKey) -> Option<String> {
        if !self.links.contains_key(&key.link) {
            return None;
        }
        let switching = self.switching();
        let mut view = view!(self);
        let json = json_text(&Value::Object(across::across_for(&mut view, &key.link, switching, false)));
        self.across.should_send(&sw(key), &json);
        Some(json)
    }

    pub(crate) fn push_across(&mut self) {
        let switching = self.switching();
        let mut by_link: BTreeMap<String, String> = BTreeMap::new();
        let keys: Vec<WindowKey> = self.overlays.keys().cloned().collect();
        for key in &keys {
            if !self.links.contains_key(&key.link) || by_link.contains_key(&key.link) {
                continue;
            }
            let mut view = view!(self);
            let json = json_text(&Value::Object(across::across_for(&mut view, &key.link, switching.clone(), false)));
            by_link.insert(key.link.clone(), json);
        }
        for key in keys {
            let Some(json) = by_link.get(&key.link) else { continue };
            if !self.across.should_send(&sw(&key), json) {
                continue;
            }
            if let Some(o) = self.overlays.get(&key) {
                o.push(&mut self.out, format!(r#"{{"type":"across","across":{json}}}"#));
            }
        }
        let alive: HashSet<switch::WindowKey> = self.overlays.keys().map(sw).collect();
        self.across.retain(|k| alive.contains(k));
    }

    // ---- the switch ----

    /// The switch looked at again (a window list, a link change, a read, its wake).
    pub(crate) fn switch_tick(&mut self) {
        self.with_world(SwitchCall::Tick);
    }

    pub(crate) fn switch_answered(&mut self, rid: RequestId, result: Result<Value, String>) {
        self.with_world(SwitchCall::Answered(rid, result));
    }

    fn switch_start(&mut self, to: Target, from_link: &str, window_id: Option<i64>) {
        let browser = to.profile.split_once(':').map_or(to.profile.as_str(), |(b, _)| b).to_owned();
        self.switcher.options.browser_name = browser_name(&browser);
        self.with_world(SwitchCall::Start { to, from: from_link.to_owned(), window_id });
        self.burst("profile switch");
        self.across_soon();
    }

    /// Calls into the switch with the shell as its world; then what each told (events, notices, requests that
    /// couldn't go: answered with an error at once).
    fn with_world(&mut self, first: SwitchCall) {
        let now = self.now;
        let mut calls = std::collections::VecDeque::from([first]);
        while let Some(call) = calls.pop_front() {
            let (events, notices, failed) = {
                let mut w = World {
                    link: &mut self.link,
                    links: &self.links,
                    matches: &self.matches,
                    read: &self.last_read,
                    lines: &mut self.lines,
                    pending: &mut self.pending,
                    next_rid: &mut self.next_rid,
                    out: &mut self.out,
                    events: Vec::new(),
                    notices: Vec::new(),
                    failed: Vec::new(),
                    now,
                };
                let s = &mut self.switcher;
                match call {
                    SwitchCall::Tick => s.tick(&mut w, now),
                    SwitchCall::Answered(rid, result) => s.answered(&mut w, rid, result, now),
                    SwitchCall::Start { to, from, window_id } => s.start(&mut w, to, &from, window_id, now),
                }
                (w.events, w.notices, w.failed)
            };
            for event in events {
                self.switch_changed(&event);
            }
            for notice in notices {
                self.show_switch_notice(&notice);
            }
            calls.extend(failed.into_iter().map(|rid| SwitchCall::Answered(rid, Err("not linked".into()))));
        }
    }

    fn profile_name(&mut self, link: &str) -> String {
        let Some((browser, profile)) = link.split_once(':') else { return link.to_owned() };
        let (browser, profile) = (browser.to_owned(), profile.to_owned());
        self.profiles_of(&browser).name(&profile)
    }

    fn switch_changed(&mut self, event: &SwitchEvent) {
        let (target, what) = match event {
            SwitchEvent::Started(t) => (t, "started".to_owned()),
            SwitchEvent::NeedsProfile(t) => (t, "needsProfile".to_owned()),
            SwitchEvent::Done(t) => (t, "done".to_owned()),
            SwitchEvent::Failed(t, why) => (t, format!("failed: {}", scrub(why, 160))),
            SwitchEvent::Cancelled(t) => (t, "cancelled".to_owned()),
        };
        if let SwitchEvent::Started(t) = event {
            let to = t.profile.clone();
            self.carry_settings(&to);
        }
        let name = self.profile_name(&target.profile);
        let browser = target.profile.split_once(':').map_or("", |(b, _)| b);
        let words =
            across::switch_words(event, &name, &across::BrowserWords::chromium(&browser_name(browser)), false, false);
        self.switch_notice = words.as_ref().map(|w| {
            let mut o = Object::new();
            o.insert("notice".into(), w.clone().into());
            o
        });
        self.switch_notice_until = None;
        self.out.note(format!("profile switch: {what} {target}"));
        self.push_across();
        if !matches!(event, SwitchEvent::NeedsProfile(_)) {
            self.switch_notice = None;
            // A failure's words stay a while, then go.
            if words.is_some() {
                self.words_until = Some(self.now + 8.0);
            }
        }
        self.burst("profile switch");
    }

    /// One of the switch's notices, up for its time (or until a button, or another notice, takes its place).
    fn show_switch_notice(&mut self, notice: &SwitchNotice) {
        let mut stored = notice.stored();
        stored.insert("at".into(), json!(self.now));
        self.switch_notice = Some(stored);
        self.switch_notice_until = Some(self.now + notice.seconds());
        let shown = notice.shown_in.as_ref().map(|w| format!(" in {w}")).unwrap_or_default();
        self.out.note(format!("profile switch: notice {} about {}{shown}", notice.kind.name(), notice.profile));
        self.push_across();
    }

    /// A button of the switch's notice: the notice goes; a kept window's Close window closes it by its copy.
    fn switch_notice_action(&mut self, kind: &str, action: &str) {
        let Some(n) = self.switch_notice.clone() else { return };
        if json::string(n.get("noticeKind")) != Some(kind) {
            return;
        }
        let kept = SwitchNotice::kept_in(Some(&n));
        self.switch_notice = None;
        self.switch_notice_until = None;
        self.push_across();
        let Some(kept) = kept.filter(|_| action == "close") else { return };
        if !self.links.contains_key(&kept.link) {
            return;
        }
        self.out.note(format!("profile switch: {kept} kept open, closed by the person"));
        self.ask(&kept.link, "closeWindow", json!({ "windowId": kept.window_id }), Some(kept.window_id));
    }

    /// The next/previous space key: true if it was handled here (more than one profile has spaces); false: the copy's
    /// own `navigate`.
    pub(crate) fn space_key(&mut self, key: &WindowKey, dir: i32, is_repeat: bool) -> bool {
        let now = self.now;
        let k = sw(key);
        let mut across = std::mem::take(&mut self.across);
        let action = {
            let view = view!(self);
            across.space_key(&view, &k, dir, is_repeat, now)
        };
        self.across = across;
        self.key_action(action)
    }

    fn key_action(&mut self, action: KeyAction) -> bool {
        match action {
            KeyAction::NotHandled => false,
            KeyAction::Held => true,
            KeyAction::Request(r) => {
                self.ask(&r.link, r.kind, r.payload, r.window_id);
                true
            }
            KeyAction::Switch { to, from_link, window_id } => {
                self.switch_start(to, &from_link, Some(window_id));
                true
            }
        }
    }

    /// What the overlay's page asks the app for, across profiles (host-app.ts perform).
    pub(crate) fn perform_across(&mut self, key: &WindowKey, name: &str, arg: &Object) {
        let Some(entry) = self.links.get(&key.link) else { return };
        let browser = entry.hello.browser.clone();
        let own = entry.hello.profile.clone();
        let profile = json::string(arg.get("profile")).unwrap_or("").to_owned();
        match name {
            "profile.switch" => {
                let action = {
                    let view = view!(self);
                    self.across.profile_switch(&view, &sw(key), arg)
                };
                self.key_action(action);
            }
            "profile.rename" => {
                let (n, e) =
                    (json::string(arg.get("name")).unwrap_or(""), json::string(arg.get("emoji")).unwrap_or(""));
                let (n, e, c) = (n.to_owned(), e.to_owned(), json::string(arg.get("color")).map(str::to_owned));
                if self.profiles_of(&browser).rename(&profile, &n, &e, c.as_deref()) {
                    self.across_soon();
                }
            }
            "profile.forget" => {
                // Not the window's own profile, nor one that's linked: it would come straight back.
                let linked = self.links.values().any(|e| e.hello.browser == browser && e.hello.profile == profile);
                if profile == own || linked {
                    return;
                }
                if self.profiles_of(&browser).forget(&profile) {
                    self.across_soon();
                }
            }
            "space.move" => {
                let (Some(space), Some(dir)) = (json::string(arg.get("space")), json::int(arg.get("dir"))) else {
                    return;
                };
                let k = crate::data::profiles::SpaceKey::new(profile.as_str(), space);
                let (moved, order) = self.profiles_of(&browser).move_space(&k, if dir < 0 { -1 } else { 1 });
                if !moved {
                    return;
                }
                if let Some(order) = order {
                    self.write_own_order(&browser, &profile, &order);
                }
                self.across_soon();
            }
            "profile.space" => {
                let Some(kind) = json::string(arg.get("type"))
                    .filter(|t| matches!(*t, "createSpace" | "renameSpace" | "deleteSpace"))
                else {
                    return;
                };
                let payload = json::object(arg.get("payload")).cloned().unwrap_or_default();
                self.space_in_profile(&browser, &profile, kind, payload);
            }
            "switch.closeWindows" => {
                let Some(on) = json::boolean(arg.get("on")) else { return };
                if self.profiles_of(&browser).set_close_windows(on) {
                    self.out.note(format!("{browser}: close windows to save memory {}", if on { "on" } else { "off" }));
                    self.across_soon();
                }
            }
            "switch.notice" => {
                let (Some(kind), Some(action)) = (json::string(arg.get("kind")), json::string(arg.get("action")))
                else {
                    return;
                };
                let (kind, action) = (kind.to_owned(), action.to_owned());
                self.switch_notice_action(&kind, &action);
            }
            // The handoff's cover and the Mac's development switch: nothing on Windows.
            "switch.coverShown" | "switch.askBeforeQuit" => {}
            _ => self.out.note(format!("{key}: {name} isn't known")),
        }
    }

    /// A profile's own order (its spaces' `order`), as the whole order now has it.
    fn write_own_order(&mut self, browser: &str, profile: &str, ids: &[String]) {
        let link = format!("{browser}:{profile}");
        if self.links.contains_key(&link) {
            self.ask(&link, "orderSpaces", json!({ "spaceIds": ids }), None);
            return;
        }
        let p = DataProfile::new(browser, profile);
        let values = self.data.values("spaces", &p);
        let t = (self.now * 1000.0).round();
        let changes: Vec<DataChange> = ids
            .iter()
            .enumerate()
            .filter_map(|(n, id)| {
                let mut v = values.get(id)?.as_object()?.clone();
                if json::int(v.get("order")) == Some(n as i64) {
                    return None;
                }
                v.insert("order".into(), json!(n));
                Some(DataChange::new("spaces", id.as_str(), DataItem::live(t, Value::Object(v))))
            })
            .collect();
        if !changes.is_empty()
            && let Some(fx) = self.data.change(&p, &changes)
        {
            self.effects(fx);
        }
    }

    /// A space made, renamed or deleted in another profile: by its copy if it's linked, else in its set.
    fn space_in_profile(&mut self, browser: &str, profile: &str, kind: &str, payload: Object) {
        let link = format!("{browser}:{profile}");
        if self.links.contains_key(&link) {
            let mut body = payload;
            body.remove("windowId"); // not a window of that copy's
            self.ask(&link, kind, Value::Object(body), None);
            return;
        }
        let p = DataProfile::new(browser, profile);
        let values = self.data.values("spaces", &p);
        let t = (self.now * 1000.0).round();
        let text = |k: &str, d: &str| json::string(payload.get(k)).unwrap_or(d).to_owned();
        let change = match kind {
            "createSpace" => {
                let id = format!("s{}", crate::data::random_hex(5));
                let order = values.values().filter_map(|v| json::num(v.get("order"))).fold(-1.0, f64::max) + 1.0;
                let v = json!({ "name": text("name", "New Space"), "emoji": text("emoji", ""), "color": text("color", ""), "order": order });
                Some(DataChange::new("spaces", id, DataItem::live(t, v)))
            }
            "renameSpace" => {
                let Some(id) = json::string(payload.get("spaceId")) else { return };
                let Some(mut v) = values.get(id).and_then(Value::as_object).cloned() else { return };
                for k in ["name", "emoji", "color"] {
                    if let Some(x) = json::string(payload.get(k)) {
                        v.insert(k.into(), x.into());
                    }
                }
                Some(DataChange::new("spaces", id, DataItem::live(t, Value::Object(v))))
            }
            _ => {
                // Deleting moves its tabs and pins to the profile's first space: its copy's work.
                let name = self.profiles_of(browser).name(profile);
                let mut o = Object::new();
                o.insert("notice".into(), format!("Open a window of {name} to delete its spaces.").into());
                self.switch_notice = Some(o);
                self.push_across();
                self.switch_notice = None;
                None
            }
        };
        if let Some(change) = change
            && let Some(fx) = self.data.change(&p, &[change])
        {
            self.effects(fx);
        }
        self.across_soon();
    }

    /// The window a switch leaves, as it looks, given to the profile it goes to before its window shows.
    pub(crate) fn carry_settings(&mut self, to: &str) {
        let Some(from) = self.switcher.from().map(|f| f.profile.clone()) else { return };
        if from == to {
            return;
        }
        let (Some(a), Some(b)) = (self.links.get(&from), self.links.get(to)) else { return };
        let Some(Value::Object(settings)) = a.mirror.value("settings") else { return };
        let current = b.mirror.value("settings");
        let Some(patch) = across::carried_patch(&settings, current.as_ref().and_then(Value::as_object)) else { return };
        self.out.note(format!(
            "profile switch: {to} given the sidebar and theme settings of the window it comes from ({from})"
        ));
        self.settings_sent.insert(to.to_owned(), sorted_text(&patch));
        self.ask(to, "updateSettings", json!({ "patch": patch }), None);
    }

    /// Keep open, the frame, the theme and the themes' settings are the person's, not a profile's: a change in one
    /// profile is given to the browser's other profiles (not Margin's own echo, not in a copy's first 5 s).
    pub(crate) fn share_settings(&mut self, source: &str) {
        let Some(entry) = self.links.get(source) else { return };
        let Some(Value::Object(settings)) = entry.mirror.value("settings") else { return };
        let browser = entry.hello.browser.clone();
        let Some(patch) = across::carried_patch(&settings, None) else { return };
        let text = sorted_text(&patch);
        if self.settings_sent.get(source) == Some(&text) {
            self.settings_sent.remove(source);
            return; // our own, back
        }
        if self.now - self.linked_at.get(source).copied().unwrap_or(0.0) < 5.0 {
            return;
        }
        let others: Vec<String> = self
            .links
            .iter()
            .filter(|(k, e)| k.as_str() != source && e.hello.browser == browser)
            .filter(|(_, e)| {
                let cur = e.mirror.value("settings");
                across::carried_patch(&patch, cur.as_ref().and_then(Value::as_object)).is_some()
            })
            .map(|(k, _)| k.clone())
            .collect();
        for link in others {
            self.settings_sent.insert(link.clone(), text.clone());
            self.ask(&link, "updateSettings", json!({ "patch": patch }), None);
        }
        self.out.note(format!("settings: {source}'s sidebar and theme settings given to the browser's other profiles"));
    }
}

/// An object as JSON with its keys sorted (the echo's check).
fn sorted_text(o: &Object) -> String {
    let mut v = Value::Object(o.clone());
    v.sort_all_objects();
    json_text(&v)
}
