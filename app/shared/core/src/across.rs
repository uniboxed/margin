//! Spaces across profiles, the shell's side (the OS-neutral parts of app/macos/shell/ShellProfiles.swift, and the
//! `across`, `neighbour` and `spaceStep` of BrowserProfiles.swift; docs/DATA.md "Spaces across profiles", PROTOCOL.md):
//!
//! - each overlay gets `across` (every profile's spaces in the one order, the profiles' names and marks, each
//!   space's Margin tabs, the other profiles' spaces' contents, the switch under way): [`across_for`];
//! - the next/previous space keys follow the one order: within the window's profile its copy's `navigate` (or
//!   `setSpace` when the order skips around), across profiles the switch ([`Across::space_key`]); a click on another
//!   profile's space is the switch too ([`Across::profile_switch`]);
//! - ⌘N asks the front window's copy for a Margin window of its own ([`new_margin_window`]);
//! - the switch's words for the person ([`switch_words`]) and the settings a switch carries ([`carried_patch`]).
//!
//! The data comes through [`AcrossData`], the shell's: the copies' mirrored state, the app's data sets and the
//! browser's profiles file (BrowserProfiles, the data port's). The requests and switches come back as values
//! ([`KeyAction`], [`LinkRequest`]) for the shell to make.
//!
//! Left out (ShellProfiles.swift, the Mac's or the data's): Safari's own profile names and the carry-over of a
//! profile's set to new ids (SafariProfiles), the `perform`s that change BrowserProfiles or a data set
//! (`profile.rename`, `profile.forget`, `space.move`, `profile.space`, `switch.closeWindows`), opening a profile's
//! window through Accessibility, the switching cover (the handoff's), `shareSettings` (needs each link's echo and
//! link times: the shell's), the notices' timers, and the DEV-HOOK `dev` switches.

use crate::json::{self, Object};
use crate::switch::{ProfileSwitch, SwitchEvent, SwitchNotice, Target, WindowKey, profile_id};
use crate::time::Secs;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Each profile's space ids, in its own order.
pub type SpaceIds = BTreeMap<String, Vec<String>>;
/// Each profile's spaces' values (name, emoji, color, order), by id.
pub type SpaceValues = BTreeMap<String, BTreeMap<String, Object>>;
/// Profile → space → its Margin tabs.
pub type TabCounts = BTreeMap<String, BTreeMap<String, u64>>;

/// What [`across`] is built from besides the browser's profiles: each profile's spaces' values, their tabs, and
/// the profiles linked now.
#[derive(Clone, Copy, Debug)]
pub struct AcrossParts<'a> {
    pub spaces: &'a SpaceValues,
    pub counts: &'a TabCounts,
    pub linked: &'a HashSet<String>,
}

/// A space: the profile whose data set has it, and its id.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SpaceKey {
    pub profile: String,
    pub space: String,
}

impl SpaceKey {
    pub fn new(profile: &str, space: &str) -> Self {
        Self { profile: profile.into(), space: space.into() }
    }
}

impl std::fmt::Display for SpaceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.profile, self.space)
    }
}

/// A profile as overlays show it (BrowserProfiles' `name`, `color`, `info`, `browserNames`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProfileView {
    pub name: String,
    pub emoji: String,
    pub color: String,
    /// The person named it.
    pub named: bool,
    /// Linked last, in ms since 1970 (0: never).
    pub last_seen: f64,
    /// The name is the browser's own (`nameFrom`: the browser, e.g. "safari"); `symbol` its picture, a PNG
    /// `data:` URL, when the shell has one.
    pub name_from: Option<String>,
    pub symbol: Option<String>,
}

/// What [`across_for`] and the space keys read: the shell's (its links' mirrors, the data store, BrowserProfiles).
/// `link` is a link key (`browser:profile`); `browser` the part before the colon.
pub trait AcrossData {
    /// Every profile of the browser that has a data set, and every link's of that browser (linked or not).
    fn profiles_with_data(&self, browser: &str) -> Vec<String>;
    /// The copy's `spaces` (its mirror's), while its link is up with its state; `None` otherwise.
    fn copy_spaces(&self, link: &str) -> Option<Vec<Value>>;
    /// A collection of the profile's data set (`spaces`, `tabs`, `pins`, `folders`, `siteIcons`): id and value.
    fn values(&self, link: &str, collection: &str) -> Vec<(String, Value)>;
    /// The profiles whose links are up.
    fn linked(&self, browser: &str) -> HashSet<String>;
    /// The one order brought up to date from each profile's spaces in its own order (BrowserProfiles.refresh).
    fn refresh(&mut self, browser: &str, spaces: &SpaceIds, linked: &HashSet<String>);
    /// The one order, as last refreshed (BrowserProfiles.order).
    fn order(&self, browser: &str) -> Vec<SpaceKey>;
    /// Every profile known, in the order first seen (BrowserProfiles.profiles).
    fn known_profiles(&self, browser: &str) -> Vec<String>;
    fn profile(&self, browser: &str, profile: &str) -> ProfileView;
    /// "Close windows to save memory" (browser.json `switching.closeWindows`).
    fn close_windows(&self, browser: &str) -> bool;
    /// The copy's `openTabs.activeSpaceByWindow[windowId]`.
    fn active_space(&self, link: &str, window_id: i64) -> Option<String>;
    /// Now, in ms since 1970 (BrowserProfiles.now).
    fn now_ms(&self) -> f64;
}

/// A link key's browser ("safari:s-a" → "safari").
pub fn browser_of(link: &str) -> &str {
    link.split_once(':').map_or(link, |(b, _)| b)
}

/// Not linked for this long: the profile's menu says when it was last seen (BrowserProfiles.staleMs).
pub const STALE_MS: f64 = 30.0 * 86_400_000.0;

/// Each profile's spaces in its own order (its copy's state while linked, else its set's): the ids, by `order`
/// then id, and the values, each with its `order` (its place in the copy's list when it has none).
pub fn own_spaces(data: &dyn AcrossData, browser: &str) -> (SpaceIds, SpaceValues) {
    let mut ids = BTreeMap::new();
    let mut values = BTreeMap::new();
    let profiles: BTreeSet<String> = data.profiles_with_data(browser).into_iter().collect();
    for p in profiles {
        let link = format!("{browser}:{p}");
        let mut list: BTreeMap<String, Object> = BTreeMap::new();
        if let Some(spaces) = data.copy_spaces(&link) {
            for (n, s) in spaces.iter().enumerate() {
                let Some(s) = s.as_object() else { continue };
                let Some(id) = json::string(s.get("id")) else { continue };
                let mut v = s.clone();
                let order = json::num(s.get("order")).unwrap_or(n as f64);
                v.insert("order".into(), json!(order));
                list.insert(id.to_owned(), v);
            }
        } else {
            for (id, v) in data.values(&link, "spaces") {
                if let Some(v) = v.as_object() {
                    list.insert(id, v.clone());
                }
            }
        }
        if list.is_empty() {
            continue;
        }
        let order = |id: &String| json::num(list.get(id).and_then(|v| v.get("order"))).unwrap_or(0.0);
        let mut sorted: Vec<String> = list.keys().cloned().collect();
        sorted.sort_by(|a, b| order(a).total_cmp(&order(b)).then_with(|| a.cmp(b)));
        ids.insert(p.clone(), sorted);
        values.insert(p, list);
    }
    (ids, values)
}

/// Each space's Margin tabs (open or not), from the app's sets: profile → space → count.
pub fn tab_counts<'a>(
    data: &dyn AcrossData,
    browser: &str,
    profiles: impl IntoIterator<Item = &'a String>,
) -> TabCounts {
    let mut out: TabCounts = BTreeMap::new();
    for p in profiles {
        for (_, v) in data.values(&format!("{browser}:{p}"), "tabs") {
            let Some(s) = json::string(v.get("spaceId")) else { continue };
            *out.entry(p.clone()).or_default().entry(s.to_owned()).or_default() += 1;
        }
    }
    out
}

/// The space before or after `key` in the whole order, wrapping around; `None` with one space (BrowserProfiles).
pub fn neighbour<'a>(order: &'a [SpaceKey], key: &SpaceKey, dir: i32) -> Option<&'a SpaceKey> {
    let n = order.len();
    if n <= 1 {
        return None;
    }
    let at = order.iter().position(|k| k == key)?;
    Some(&order[if dir < 0 { (at + n - 1) % n } else { (at + 1) % n }])
}

/// What a space key does (BrowserProfiles.SpaceStep).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpaceStep {
    /// A space of the window's own profile, from one of its own.
    Own(SpaceKey),
    /// The cross-profile switch (another profile's space, or on from an aim that's already another profile's).
    Across(SpaceKey),
    /// A held key's repeat that would go to another profile, or on from one: nothing, so a held key starts at most
    /// one switch of profile (and its full-screen windows) per press.
    Held,
}

/// What a space key does in a window of `profile` showing `here` (the chained aim, a moment after a key).
/// `None`: nothing across profiles (only one has spaces): the copy's own `navigate`.
pub fn space_step(order: &[SpaceKey], here: &SpaceKey, profile: &str, dir: i32, is_repeat: bool) -> Option<SpaceStep> {
    let profiles: HashSet<&str> = order.iter().map(|k| k.profile.as_str()).collect();
    if profiles.len() <= 1 {
        return None;
    }
    let next = neighbour(order, here, dir)?;
    if here.profile == profile && next.profile == profile {
        return Some(SpaceStep::Own(next.clone()));
    }
    Some(if is_repeat { SpaceStep::Held } else { SpaceStep::Across(next.clone()) })
}

/// A request for the shell to make on a link (the copy's `req`).
#[derive(Clone, Debug, PartialEq)]
pub struct LinkRequest {
    pub link: String,
    pub kind: &'static str,
    pub payload: Value,
    pub window_id: Option<i64>,
}

/// What a space key, or a click on a space, comes to.
#[derive(Clone, Debug, PartialEq)]
pub enum KeyAction {
    /// Not handled here: the copy's own `navigate`, as before (`shortcuts.rs` KeyRoute::Space's `action`).
    NotHandled,
    /// Handled: nothing to do (a held repeat stopped before another profile).
    Held,
    /// A request to the window's copy (`navigate` or `setSpace`).
    Request(LinkRequest),
    /// The switch to another profile's space (`ProfileSwitch::start(to, from_link, window_id)`), then `across`
    /// pushed again.
    Switch { to: Target, from_link: String, window_id: i64 },
}

fn set_space(key: &WindowKey, space: &str) -> KeyAction {
    KeyAction::Request(LinkRequest {
        link: key.link.clone(),
        kind: "setSpace",
        payload: json!({ "windowId": key.window_id, "spaceId": space }),
        window_id: Some(key.window_id),
    })
}

/// The shell's state for spaces across profiles: each window's aim (the space its last key went to).
#[derive(Debug, Default)]
pub struct Across {
    aims: HashMap<WindowKey, (SpaceKey, Secs)>,
    sent: HashMap<WindowKey, String>,
}

impl Across {
    /// How long a key's aim stands for the window's space (the copy's state lags it).
    pub const AIM: Secs = 1.5;

    pub fn new() -> Self {
        Self::default()
    }

    /// The window's space now: the aim of a key a moment ago, else its copy's `activeSpaceByWindow`, else the
    /// copy's first space.
    pub fn current_space(&self, data: &dyn AcrossData, key: &WindowKey, now: Secs) -> Option<SpaceKey> {
        if let Some((aim, at)) = self.aims.get(key)
            && now - at < Self::AIM
        {
            return Some(aim.clone());
        }
        let profile = profile_id(&key.link);
        let first = || data.copy_spaces(&key.link)?.first().and_then(|s| json::string(s.get("id")).map(str::to_owned));
        let space = data.active_space(&key.link, key.window_id).or_else(first)?;
        Some(SpaceKey::new(profile, &space))
    }

    /// The next/previous space key (dir 1 or -1) in the overlay's window `key`. `is_repeat`: a held key's repeat,
    /// which goes through the window's own profile's spaces but stops before another profile's.
    pub fn space_key(
        &mut self,
        data: &dyn AcrossData,
        key: &WindowKey,
        dir: i32,
        is_repeat: bool,
        now: Secs,
    ) -> KeyAction {
        let browser = browser_of(&key.link);
        let profile = profile_id(&key.link);
        let order = data.order(browser);
        let Some(here) = self.current_space(data, key, now) else { return KeyAction::NotHandled };
        let Some(step) = space_step(&order, &here, profile, dir, is_repeat) else { return KeyAction::NotHandled };
        match step {
            SpaceStep::Held => KeyAction::Held,
            SpaceStep::Across(next) => {
                self.aims.insert(key.clone(), (next.clone(), now));
                let to = Target::new(&format!("{browser}:{}", next.profile), &next.space);
                KeyAction::Switch { to, from_link: key.link.clone(), window_id: key.window_id }
            }
            SpaceStep::Own(next) => {
                self.aims.insert(key.clone(), (next.clone(), now));
                // The copy's own next space is this one: its navigate (held keys and all); else straight to it.
                // (As the Swift's, the copy's order is read from the whole order, so `Own` always finds it the same
                // and the `setSpace` is never reached: kept for a copy whose order the shell reads otherwise.)
                let own: Vec<&SpaceKey> = order.iter().filter(|k| k.profile == here.profile).collect();
                let at = own.iter().position(|k| **k == here).unwrap_or(0);
                let n = own.len();
                let copy_next = (n > 0).then(|| own[if dir < 0 { (at + n - 1) % n } else { (at + 1) % n }]);
                if copy_next == Some(&next) {
                    let action = if dir > 0 { "next-space" } else { "prev-space" };
                    KeyAction::Request(LinkRequest {
                        link: key.link.clone(),
                        kind: "navigate",
                        payload: json!({ "action": action, "windowId": key.window_id }),
                        window_id: Some(key.window_id),
                    })
                } else {
                    set_space(key, &next.space)
                }
            }
        }
    }

    /// The overlay's `perform('profile.switch', { profile, space })`: a space in the one order; the window's own
    /// profile's is its copy's `setSpace`, another's the switch. Anything else: not handled.
    pub fn profile_switch(&self, data: &dyn AcrossData, key: &WindowKey, arg: &Object) -> KeyAction {
        let browser = browser_of(&key.link);
        let profile = json::string(arg.get("profile")).unwrap_or("");
        let Some(space) = json::string(arg.get("space")) else { return KeyAction::NotHandled };
        if !data.order(browser).contains(&SpaceKey::new(profile, space)) {
            return KeyAction::NotHandled;
        }
        if profile == profile_id(&key.link) {
            return set_space(key, space);
        }
        let to = Target::new(&format!("{browser}:{profile}"), space);
        KeyAction::Switch { to, from_link: key.link.clone(), window_id: key.window_id }
    }

    /// Whether `json` differs from what the overlay was last sent (and is now taken as sent): `across` goes only
    /// when it changed (Shell.acrossSent).
    pub fn should_send(&mut self, key: &WindowKey, json: &str) -> bool {
        if self.sent.get(key).is_some_and(|s| s == json) {
            return false;
        }
        self.sent.insert(key.clone(), json.to_owned());
        true
    }

    /// Forget what was sent to overlays gone, and the aims of their windows.
    pub fn retain(&mut self, alive: impl Fn(&WindowKey) -> bool) {
        self.sent.retain(|k, _| alive(k));
        self.aims.retain(|k, _| alive(k));
    }
}

/// What an overlay of `profile`'s window draws besides its own state (BrowserProfiles.across): every shown profile
/// (or this one alone, when no profile has a space in the order), and every space in the one order (`parts`: their
/// values and tabs, and who's linked); `switching`: the switch under way, if any;
/// `switch_settings`: whether "Close windows to save memory" means anything now (the Mac's parking: false on
/// Windows, and then it isn't sent).
pub fn across(
    data: &dyn AcrossData,
    browser: &str,
    profile: &str,
    parts: AcrossParts<'_>,
    switching: Option<Object>,
    switch_settings: bool,
) -> Object {
    let AcrossParts { spaces, counts, linked } = parts;
    let t = data.now_ms();
    let order = data.order(browser);
    let shown: Vec<String> =
        data.known_profiles(browser).into_iter().filter(|p| order.iter().any(|k| &k.profile == p)).collect();
    let mut shown = if shown.is_empty() { vec![profile.to_owned()] } else { shown };
    if !shown.iter().any(|p| p == profile) {
        shown.push(profile.to_owned());
    }
    let list: Vec<Value> = shown
        .iter()
        .map(|p| {
            let i = data.profile(browser, p);
            let is_linked = linked.contains(p);
            let mut o = json!({
                "id": p, "name": i.name, "emoji": i.emoji, "color": i.color, "named": i.named,
                "here": p == profile, "linked": is_linked, "lastSeen": i.last_seen,
                "stale": !is_linked && i.last_seen > 0.0 && t - i.last_seen > STALE_MS,
                "spaces": order.iter().filter(|k| &k.profile == p).count(),
            });
            if let (Some(from), Some(obj)) = (i.name_from, o.as_object_mut()) {
                obj.insert("nameFrom".into(), from.into());
                if let Some(s) = i.symbol {
                    obj.insert("symbol".into(), s.into());
                }
            }
            o
        })
        .collect();
    let entries: Vec<Value> = order
        .iter()
        .map(|k| {
            let v = spaces.get(&k.profile).and_then(|s| s.get(&k.space));
            let text = |f: &str| v.and_then(|v| json::string(v.get(f))).unwrap_or("").to_owned();
            let count = counts.get(&k.profile).and_then(|c| c.get(&k.space)).copied().unwrap_or(0);
            json!({ "profile": k.profile, "id": k.space, "name": text("name"), "emoji": text("emoji"), "color": text("color"), "tabCount": count })
        })
        .collect();
    let mut out = Object::new();
    out.insert("v".into(), 1.into());
    out.insert("profile".into(), profile.into());
    out.insert("profiles".into(), list.into());
    out.insert("spaces".into(), entries.into());
    if switch_settings {
        out.insert("switchSettings".into(), json!({ "closeWindows": data.close_windows(browser) }));
    }
    if let Some(s) = switching {
        out.insert("switching".into(), s.into());
    }
    out
}

/// The whole `across` for the overlay of a window of `link` (Shell.acrossJSON): the order refreshed, then
/// [`across`] with the other profiles' spaces' contents. `switching`: [`switching_json`]'s.
pub fn across_for(data: &mut dyn AcrossData, link: &str, switching: Option<Object>, switch_settings: bool) -> Object {
    let browser = browser_of(link);
    let profile = profile_id(link);
    let (ids, values) = own_spaces(data, browser);
    let linked = data.linked(browser);
    data.refresh(browser, &ids, &linked);
    let counts = tab_counts(data, browser, ids.keys());
    let mut out = across(
        data,
        browser,
        profile,
        AcrossParts { spaces: &values, counts: &counts, linked: &linked },
        switching,
        switch_settings,
    );
    let contents: Vec<Value> = space_contents(data, browser, &ids)
        .into_iter()
        .filter(|c| json::string(c.get("profile")) != Some(profile))
        .map(Value::Object)
        .collect();
    out.insert("contents".into(), contents.into());
    out
}

/// The switch under way as overlays get it (`across.switching`, ShellProfiles.switchingJSON): its target's profile
/// and space, its phase, the window it leaves (its overlay draws the cover), the target space's contents, and the
/// switch's notice. Not busy: the notice alone, if any.
pub fn switching_json(data: &dyn AcrossData, switch: &ProfileSwitch, notice: Option<&Object>) -> Option<Object> {
    let target = switch.target().filter(|t| switch.busy() && t.profile.contains(':'));
    let Some(t) = target else { return notice.map(SwitchNotice::sent) };
    let mut out = Object::new();
    out.insert("profile".into(), profile_id(&t.profile).into());
    out.insert("space".into(), t.space.clone().into());
    out.insert("phase".into(), switch.phase().name().into());
    if let Some(from) = switch.from()
        && let Some(w) = from.window_id
    {
        out.insert("from".into(), json!({ "profile": profile_id(&from.profile), "windowId": w }));
    }
    if let Some(content) = space_content(data, &t.profile, &t.space, 80, 16_000) {
        out.insert("content".into(), Value::Object(content));
    }
    if let Some(n) = notice {
        out.extend(SwitchNotice::sent(n));
    }
    Some(out)
}

/// Every space's contents of each profile, smaller caps (30 tabs, icons of 6000 characters), for the other
/// profiles' layouts: a swipe draws the neighbouring space beside the current one (ui/behaviors/swipe.ts).
pub fn space_contents(data: &dyn AcrossData, browser: &str, ids: &SpaceIds) -> Vec<Object> {
    let mut out = Vec::new();
    for (p, spaces) in ids {
        let mut sorted: Vec<&String> = spaces.iter().collect();
        sorted.sort();
        for s in sorted {
            if let Some(c) = space_content(data, &format!("{browser}:{p}"), s, 30, 6000) {
                let mut o = Object::new();
                o.insert("profile".into(), p.clone().into());
                o.insert("space".into(), s.clone().into());
                o.insert("content".into(), Value::Object(c));
                out.push(o);
            }
        }
    }
    out
}

/// "scheme://host[:port]" of an address, as the Swift reads it with `URL` (no default port dropped); `None` for
/// one with no scheme or host.
fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let mut chars = scheme.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    if !first_ok || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (host, port) = if let Some(after) = host_port.strip_prefix('[') {
        let (h, tail) = after.split_once(']')?;
        (format!("[{h}]"), tail.strip_prefix(':'))
    } else {
        match host_port.split_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p)),
            None => (host_port.to_owned(), None),
        }
    };
    if host.is_empty() {
        return None;
    }
    let port = port.filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    Some(match port {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    })
}

/// A space's pins, folders and Margin tabs from the app's data set for its profile (docs/DATA.md "The data set"): up to
/// 200 pins, 50 folders, `max_tabs` tabs (newest first, the one used last marked active); an icon only a small
/// `data:` image (at most `max_icon` characters), its own or its site's. Titles and addresses go to the overlay
/// only, never to the log. Items are taken by id where the Swift took a dictionary's (unordered) first ones.
pub fn space_content(
    data: &dyn AcrossData,
    link: &str,
    space: &str,
    max_tabs: usize,
    max_icon: usize,
) -> Option<Object> {
    if !link.contains(':') || space.is_empty() {
        return None;
    }
    let small = |s: &str| s.starts_with("data:image/") && s.chars().count() <= max_icon;
    let site_icons: HashMap<String, Value> = data.values(link, "siteIcons").into_iter().collect();
    let icon = |url: &str, own: Option<&Value>| -> String {
        if let Some(own) = own.and_then(Value::as_str)
            && small(own)
        {
            return own.to_owned();
        }
        origin(url)
            .and_then(|o| {
                site_icons.get(&o).and_then(|v| json::string(v.get("data"))).filter(|d| small(d)).map(str::to_owned)
            })
            .unwrap_or_default()
    };
    let in_space = |collection: &str| -> Vec<(String, Object)> {
        let mut v: Vec<(String, Object)> = data
            .values(link, collection)
            .into_iter()
            .filter_map(|(id, v)| {
                let o = v.as_object()?;
                (json::string(o.get("spaceId")) == Some(space)).then(|| (id, o.clone()))
            })
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    };
    let text = |o: &Object, k: &str| json::string(o.get(k)).unwrap_or("").to_owned();
    let pins: Vec<Value> = in_space("pins")
        .into_iter()
        .take(200)
        .map(|(id, o)| {
            let url = text(&o, "url");
            let folder = json::string(o.get("folderId")).map_or(Value::Null, Value::from);
            json!({ "id": id, "title": text(&o, "title"), "icon": icon(&url, None), "url": url, "folderId": folder,
                    "pos": json::num(o.get("pos")).unwrap_or(0.0) })
        })
        .collect();
    let folders: Vec<Value> = in_space("folders")
        .into_iter()
        .take(50)
        .map(|(id, o)| {
            json!({ "id": id, "name": text(&o, "name"), "open": json::boolean(o.get("open")).unwrap_or(true),
                    "pos": json::num(o.get("pos")).unwrap_or(0.0) })
        })
        .collect();
    let mut tabs = in_space("tabs");
    let order = |o: &Object| json::num(o.get("order")).unwrap_or(0.0);
    tabs.sort_by(|a, b| order(&b.1).total_cmp(&order(&a.1)));
    tabs.truncate(max_tabs);
    let used = |o: &Object| json::num(o.get("lastUsed")).unwrap_or(0.0);
    // The first of the most recently used (Swift's max(by:) keeps the first of equals).
    let mut last: Option<(&String, f64)> = None;
    for (id, o) in &tabs {
        if last.is_none_or(|(_, u)| u < used(o)) {
            last = Some((id, used(o)));
        }
    }
    let last = last.map(|(id, _)| id.clone());
    let tabs: Vec<Value> = tabs
        .iter()
        .map(|(id, o)| {
            let url = text(o, "url");
            json!({ "id": id, "title": text(o, "title"), "icon": icon(&url, o.get("icon")), "url": url,
                    "active": Some(id) == last.as_ref() })
        })
        .collect();
    let mut out = Object::new();
    out.insert("space".into(), space.into());
    out.insert("pins".into(), pins.into());
    out.insert("folders".into(), folders.into());
    out.insert("tabs".into(), tabs.into());
    Some(out)
}

/// ⌘N (docs/BROWSER-WINDOWS.md §5): a new window of the front window's profile, a Margin window of its own, in full screen
/// like it and on its space (its copy's `newWindow { fromWindowId }`). It's in no line until its first switch gives
/// it one. `None` (nothing asked) when its copy isn't linked. The answer (`{ windowId, state, bounds }`) is the
/// shell's to bind as a window Margin made.
pub fn new_margin_window(from: &WindowKey, linked: bool) -> Option<LinkRequest> {
    linked.then(|| LinkRequest {
        link: from.link.clone(),
        kind: "newWindow",
        payload: json!({ "fromWindowId": from.window_id }),
        window_id: None,
    })
}

/// How the switch's words name the browser's parts (ShellProfiles.switchChanged's are Safari's). `{name}` is the
/// profile's name.
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserWords {
    pub browser: String,
    /// How to open a window of a profile.
    pub open_window: String,
    /// Where Margin is turned on, for a profile.
    pub turn_on: String,
}

impl BrowserWords {
    /// The Mac's, exactly.
    pub fn safari() -> Self {
        Self {
            browser: "Safari".into(),
            open_window: "File › New Window › New {name} Window".into(),
            turn_on: "Safari › Settings › Extensions (with {name} chosen at the top)".into(),
        }
    }
    /// Chrome's or Edge's (provisional, to check on Windows with Tirth).
    pub fn chromium(browser: &str) -> Self {
        let page = if browser == "Edge" { "edge://extensions" } else { "chrome://extensions" };
        Self {
            browser: browser.into(),
            open_window: "its profile picture › {name}".into(),
            turn_on: format!("{page} in {{name}}’s window"),
        }
    }
}

/// What the person is told of a switch's event (ShellProfiles.switchChanged), or `None`. `margin_off`: Margin is
/// off in the target's profile, as the browser's settings say; `opened`: the shell opened the profile's window for
/// this switch (and closes it again on a failure).
pub fn switch_words(
    event: &SwitchEvent,
    name: &str,
    words: &BrowserWords,
    margin_off: bool,
    opened: bool,
) -> Option<String> {
    let fill = |s: &str| s.replace("{name}", name);
    match event {
        SwitchEvent::Started(_) | SwitchEvent::Done(_) | SwitchEvent::Cancelled(_) => None,
        SwitchEvent::NeedsProfile(_) => Some(format!(
            "{name} isn’t open in {}. Open one of its windows ({}) and Margin shows the space there.",
            words.browser,
            fill(&words.open_window)
        )),
        SwitchEvent::Failed(_, why) => Some(if margin_off {
            format!("Margin is turned off in {name}. Turn it on in {}, then switch again.", fill(&words.turn_on))
        } else if opened {
            format!(
                "Margin didn’t start in {name}’s window. Check that Margin is on in {}, then switch again.",
                fill(&words.turn_on)
            )
        } else {
            format!("Couldn’t switch to {name}: {why}. Nothing was closed.")
        }),
    }
}

/// The settings a window's look is made of, carried to the profile a switch goes to and shared between a browser's
/// profiles (Tirth, 2026-11-07: "it should match all the configuration of the previous window like a snapshot").
pub const CARRIED_SETTINGS: [&str; 4] = ["sidebarPinnedOpen", "frameWhenHidden", "theme", "themes"];

/// The `updateSettings { patch }` that gives `to` the carried settings of `from` (ShellProfiles.carrySettings):
/// `None` when `from` has none of them or `to` has them all the same already. (Compared as JSON: a number written
/// 1 and 1.0 differs here, where the Swift's NSDictionary took them as equal.)
pub fn carried_patch(from: &Object, to: Option<&Object>) -> Option<Object> {
    let patch: Object =
        CARRIED_SETTINGS.iter().filter_map(|k| from.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
    if patch.is_empty() {
        return None;
    }
    if let Some(current) = to {
        let same: Object =
            current.iter().filter(|(k, _)| patch.contains_key(*k)).map(|(k, v)| (k.clone(), v.clone())).collect();
        if same == patch {
            return None;
        }
    }
    Some(patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::switch::{CopyWindow, RequestId, SwitchWorld};

    fn k(p: &str, s: &str) -> SpaceKey {
        SpaceKey::new(p, s)
    }
    fn obj(v: Value) -> Object {
        v.as_object().cloned().unwrap_or_default()
    }

    /// The shell's data, in memory: copies' spaces, sets, a fixed order (refresh records what it was given).
    #[derive(Default)]
    struct Data {
        with_data: Vec<String>,
        copies: HashMap<String, Vec<Value>>,
        sets: HashMap<(String, String), Vec<(String, Value)>>,
        linked: HashSet<String>,
        order: Vec<SpaceKey>,
        known: Vec<String>,
        views: HashMap<String, ProfileView>,
        close: bool,
        active: HashMap<(String, i64), String>,
        now: f64,
        refreshed: Vec<SpaceIds>,
    }

    impl AcrossData for Data {
        fn profiles_with_data(&self, _browser: &str) -> Vec<String> {
            self.with_data.clone()
        }
        fn copy_spaces(&self, link: &str) -> Option<Vec<Value>> {
            self.copies.get(link).cloned()
        }
        fn values(&self, link: &str, collection: &str) -> Vec<(String, Value)> {
            self.sets.get(&(link.to_string(), collection.to_string())).cloned().unwrap_or_default()
        }
        fn linked(&self, _browser: &str) -> HashSet<String> {
            self.linked.clone()
        }
        fn refresh(&mut self, _browser: &str, spaces: &SpaceIds, _linked: &HashSet<String>) {
            self.refreshed.push(spaces.clone());
        }
        fn order(&self, _browser: &str) -> Vec<SpaceKey> {
            self.order.clone()
        }
        fn known_profiles(&self, _browser: &str) -> Vec<String> {
            self.known.clone()
        }
        fn profile(&self, _browser: &str, profile: &str) -> ProfileView {
            self.views.get(profile).cloned().unwrap_or_default()
        }
        fn close_windows(&self, _browser: &str) -> bool {
            self.close
        }
        fn active_space(&self, link: &str, window_id: i64) -> Option<String> {
            self.active.get(&(link.to_string(), window_id)).cloned()
        }
        fn now_ms(&self) -> f64 {
            self.now
        }
    }

    fn three() -> Data {
        Data {
            order: vec![k("s-a", "a1"), k("s-a", "a2"), k("s-b", "b1"), k("s-c", "c1")],
            known: vec!["s-a".into(), "s-b".into(), "s-c".into()],
            ..Data::default()
        }
    }

    // app/macos/shell/tests/tests.swift shortcuts(): the space step.
    #[test]
    fn the_space_step() {
        let d = three();
        let (a1, a2, b1) = (k("s-a", "a1"), k("s-a", "a2"), k("s-b", "b1"));
        assert_eq!(space_step(&d.order, &a1, "s-a", 1, false), Some(SpaceStep::Own(a2.clone())));
        assert_eq!(
            space_step(&d.order, &a2, "s-a", 1, false),
            Some(SpaceStep::Across(b1.clone())),
            "a press goes across"
        );
        assert_eq!(space_step(&d.order, &a2, "s-a", 1, true), Some(SpaceStep::Held), "a repeat doesn't");
        assert_eq!(
            space_step(&d.order, &b1, "s-a", 1, false),
            Some(SpaceStep::Across(k("s-c", "c1"))),
            "on from another's aim"
        );
        assert_eq!(
            space_step(&[a1.clone(), a2.clone()], &a1, "s-a", 1, false),
            None,
            "one profile: the copy's navigate"
        );
        assert_eq!(space_step(&[], &a1, "s-a", 1, false), None);
        assert_eq!(space_step(&d.order, &k("s-z", "z"), "s-a", 1, false), None, "not in the order");
        // profiles-tests.swift: neighbour wraps around both ways.
        assert_eq!(neighbour(&d.order, &k("s-c", "c1"), 1), Some(&a1));
        assert_eq!(neighbour(&d.order, &a1, -1), Some(&k("s-c", "c1")));
        assert_eq!(neighbour(&d.order[..1], &a1, 1), None);
    }

    // A held next-space key with several profiles: through the window's own profile's spaces only, so a press
    // starts one switch of profile at most (tests.swift holdNextSpace, with the real repeat of shortcuts.rs).
    #[test]
    fn a_held_space_key_stops_before_another_profile() {
        use crate::shortcuts::{AppShortcuts, HotKeyRegistrar, KeyRepeat, Os, default_bindings};
        struct Reg(BTreeMap<u32, crate::shortcuts::Combo>);
        impl HotKeyRegistrar for Reg {
            fn register(&mut self, combo: &crate::shortcuts::Combo, id: u32) -> bool {
                self.0.insert(id, *combo);
                true
            }
            fn unregister(&mut self, id: u32) {
                self.0.remove(&id);
            }
        }
        let d = three();
        let hold = |start: SpaceKey, ticks: usize| {
            let mut reg = Reg(BTreeMap::new());
            let mut keys = AppShortcuts::new(default_bindings(Os::MacOs), KeyRepeat { delay: 0.4, interval: 0.05 });
            keys.set_active(&mut reg, true);
            let right = crate::shortcuts::Combo::parse("Alt+Meta+ArrowRight");
            let id = reg.0.iter().find(|(_, c)| Some(**c) == right).map(|(i, _)| *i).unwrap_or(u32::MAX);
            let mut aim = start;
            let (mut repeats, mut across) = (0, vec![]);
            let mut runs = vec![keys.hit(id, 0.0)];
            for _ in 0..ticks {
                let at = keys.next_tick().unwrap_or(f64::INFINITY);
                runs.push(keys.tick(at, |_| true));
            }
            for r in runs.into_iter().flatten() {
                if r.is_repeat {
                    repeats += 1;
                }
                match space_step(&d.order, &aim, "s-a", 1, r.is_repeat) {
                    Some(SpaceStep::Own(n)) => aim = n,
                    Some(SpaceStep::Across(n)) => {
                        aim = n.clone();
                        across.push(n)
                    }
                    _ => {}
                }
            }
            (repeats, across, aim)
        };
        let (repeats, across, aim) = hold(k("s-a", "a1"), 8);
        assert_eq!(repeats, 8, "it repeats");
        assert!(across.is_empty() && aim == k("s-a", "a2"), "on to its own second, never into another profile");
        let (_, across, _) = hold(k("s-a", "a2"), 8);
        assert_eq!(across, [k("s-b", "b1")], "one switch of profile, at the press");
    }

    #[test]
    fn space_keys_in_a_window() {
        let mut d = three();
        let w = WindowKey::new("safari:s-a", 10);
        d.active.insert(("safari:s-a".into(), 10), "a1".into());
        let mut a = Across::new();
        let nav = |action: &str| {
            KeyAction::Request(LinkRequest {
                link: "safari:s-a".into(),
                kind: "navigate",
                payload: json!({ "action": action, "windowId": 10 }),
                window_id: Some(10),
            })
        };
        assert_eq!(a.space_key(&d, &w, 1, false, 0.0), nav("next-space"), "its own next: the copy's navigate");
        assert_eq!(a.current_space(&d, &w, 1.0), Some(k("s-a", "a2")), "the aim, a moment after");
        let switch = a.space_key(&d, &w, 1, false, 1.0);
        assert_eq!(
            switch,
            KeyAction::Switch { to: Target::new("safari:s-b", "b1"), from_link: "safari:s-a".into(), window_id: 10 },
            "chained from the aim: across"
        );
        assert_eq!(a.space_key(&d, &w, 1, true, 1.1), KeyAction::Held, "a repeat from another profile's aim");
        assert_eq!(a.current_space(&d, &w, 3.0), Some(k("s-a", "a1")), "the aim gone: the copy's own");
        assert_eq!(
            a.space_key(&d, &w, -1, false, 10.0),
            KeyAction::Switch { to: Target::new("safari:s-c", "c1"), from_link: "safari:s-a".into(), window_id: 10 },
            "back from the first: wraps to the last"
        );
        // Other profiles' spaces between its own: still the copy's own neighbours.
        d.order = vec![k("s-a", "a1"), k("s-b", "b1"), k("s-a", "a2"), k("s-a", "a3")];
        let mut a = Across::new();
        d.active.insert(("safari:s-a".into(), 10), "a3".into());
        assert_eq!(a.space_key(&d, &w, -1, false, 0.0), nav("prev-space"), "a3 → a2: the copy's previous too");
        let mut a = Across::new();
        d.active.insert(("safari:s-a".into(), 10), "a2".into());
        assert_eq!(a.space_key(&d, &w, 1, false, 0.0), nav("next-space"));
        // own order a1 a2 a3: from a3 the copy's next is a1, the whole order's (wrapping) is a1 too.
        d.order = vec![k("s-a", "a1"), k("s-a", "a2"), k("s-b", "b1"), k("s-a", "a3")];
        let mut a = Across::new();
        d.active.insert(("safari:s-a".into(), 10), "a3".into());
        assert_eq!(a.space_key(&d, &w, 1, false, 0.0), nav("next-space"));
        d.order = vec![k("s-a", "a1"), k("s-b", "b1"), k("s-a", "a3"), k("s-a", "a2")];
        let mut a = Across::new();
        d.active.insert(("safari:s-a".into(), 10), "a3".into());
        // The whole order's next is a2; the copy's own (its order a1 a3 a2 by the slots rule) is a2: navigate.
        assert_eq!(a.space_key(&d, &w, 1, false, 0.0), nav("next-space"));
        // One profile only: not handled.
        d.order = vec![k("s-a", "a1"), k("s-a", "a2")];
        assert_eq!(Across::new().space_key(&d, &w, 1, false, 0.0), KeyAction::NotHandled);
        // No space known: not handled.
        let other = WindowKey::new("safari:s-a", 11);
        assert_eq!(Across::new().space_key(&three(), &other, 1, false, 0.0), KeyAction::NotHandled);
    }

    #[test]
    fn from_an_aim_and_from_the_copys_list() {
        let mut d = three();
        d.order = vec![k("s-a", "a1"), k("s-a", "a2"), k("s-a", "a3"), k("s-b", "b1")];
        d.active.insert(("safari:s-a".into(), 10), "a1".into());
        let w = WindowKey::new("safari:s-a", 10);
        let mut a = Across::new();
        a.aims.insert(w.clone(), (k("s-a", "a3"), 0.0));
        // From a3 (the aim), the next is b1: across.
        assert!(matches!(a.space_key(&d, &w, 1, false, 0.5), KeyAction::Switch { .. }));
        // From a2 back to a1, the previous: the copy's own previous too.
        let mut a = Across::new();
        d.active.insert(("safari:s-a".into(), 10), "a3".into());
        let r = a.space_key(&d, &w, -1, false, 0.0);
        assert_eq!(
            r,
            KeyAction::Request(LinkRequest {
                link: "safari:s-a".into(),
                kind: "navigate",
                payload: json!({ "action": "prev-space", "windowId": 10 }),
                window_id: Some(10)
            })
        );
        // The first space from the copy's list when it says no active space.
        let mut d = three();
        d.copies.insert("safari:s-a".into(), vec![json!({ "id": "a2" })]);
        assert_eq!(Across::new().current_space(&d, &w, 0.0), Some(k("s-a", "a2")));
    }

    #[test]
    fn a_click_on_a_space() {
        let d = three();
        let w = WindowKey::new("safari:s-a", 10);
        let a = Across::new();
        assert_eq!(a.profile_switch(&d, &w, &obj(json!({ "profile": "s-a", "space": "a2" }))), set_space(&w, "a2"));
        assert_eq!(
            a.profile_switch(&d, &w, &obj(json!({ "profile": "s-b", "space": "b1" }))),
            KeyAction::Switch { to: Target::new("safari:s-b", "b1"), from_link: "safari:s-a".into(), window_id: 10 }
        );
        assert_eq!(
            a.profile_switch(&d, &w, &obj(json!({ "profile": "s-b", "space": "zz" }))),
            KeyAction::NotHandled,
            "not in the order"
        );
        assert_eq!(a.profile_switch(&d, &w, &obj(json!({ "profile": "s-b" }))), KeyAction::NotHandled);
    }

    #[test]
    fn the_space_keys_switch_through_the_switch() {
        // A space key's Switch, carried out with switch.rs's machine.
        #[derive(Default)]
        struct W(Vec<(String, String)>);
        impl SwitchWorld for W {
            fn is_linked(&self, _link: &str) -> bool {
                true
            }
            fn request(&mut self, link: &str, kind: &str, _payload: Value, _window_id: Option<i64>) -> RequestId {
                self.0.push((link.into(), kind.into()));
                self.0.len() as RequestId
            }
            fn windows(&self, _link: &str) -> Vec<CopyWindow> {
                vec![]
            }
            fn in_front(&self, _link: &str, _window_id: i64) -> bool {
                false
            }
            fn switch_changed(&mut self, _event: &SwitchEvent) {}
        }
        let mut d = three();
        d.active.insert(("safari:s-a".into(), 10), "a2".into());
        let w = WindowKey::new("safari:s-a", 10);
        let mut s = ProfileSwitch::default();
        let mut world = W::default();
        if let KeyAction::Switch { to, from_link, window_id } = Across::new().space_key(&d, &w, 1, false, 0.0) {
            s.start(&mut world, to, &from_link, Some(window_id), 0.0);
        }
        assert_eq!(world.0, [("safari:s-b".to_string(), "openSpaceWindow".to_string())]);
        let sw = switching_json(&d, &s, None).map(Value::Object);
        assert_eq!(
            sw,
            Some(
                json!({ "profile": "s-b", "space": "b1", "phase": "creating", "from": { "profile": "s-a", "windowId": 10 },
                                     "content": { "space": "b1", "pins": [], "folders": [], "tabs": [] } })
            )
        );
        let notice = obj(
            json!({ "noticeKind": "window-kept-draft", "noticeProfile": "s-a", "kept": { "link": "safari:s-a", "windowId": 4 } }),
        );
        let with = switching_json(&d, &s, Some(&notice)).unwrap_or_default();
        assert!(with.contains_key("noticeKind") && !with.contains_key("kept"));
        let idle = ProfileSwitch::default();
        assert_eq!(switching_json(&d, &idle, Some(&notice)).map(|o| o.len()), Some(2), "not busy: the notice alone");
        assert_eq!(switching_json(&d, &idle, None), None);
    }

    // profiles-tests.swift: across for an overlay.
    #[test]
    fn across_for_an_overlay() {
        let mut d = Data {
            order: vec![k("s-default", "work"), k("s-default", "home"), k("s-2", "job"), k("s-3", "fun")],
            known: vec!["s-default".into(), "s-2".into(), "s-3".into()],
            now: 1_000_000.0,
            ..Data::default()
        };
        d.views.insert(
            "s-2".into(),
            ProfileView {
                name: "Job".into(),
                emoji: "💼".into(),
                color: "#00b894".into(),
                named: true,
                last_seen: 999_000.0,
                ..ProfileView::default()
            },
        );
        d.views.insert(
            "s-default".into(),
            ProfileView {
                name: "Default".into(),
                name_from: Some("safari".into()),
                symbol: Some("data:image/png;base64,x".into()),
                ..ProfileView::default()
            },
        );
        let spaces: SpaceValues = [(
            "s-2".to_string(),
            [("job".to_string(), obj(json!({ "name": "Job board", "emoji": "📋", "color": "#000" })))].into(),
        )]
        .into();
        let counts: TabCounts = [("s-2".to_string(), [("job".to_string(), 3)].into())].into();
        let linked: HashSet<String> = ["s-default".to_string()].into();
        let parts = AcrossParts { spaces: &spaces, counts: &counts, linked: &linked };
        let a = across(&d, "safari", "s-2", parts, None, false);
        let list = json::array(a.get("profiles")).cloned().unwrap_or_default();
        let entries = json::array(a.get("spaces")).cloned().unwrap_or_default();
        let by = |l: &Vec<Value>, id: &str| l.iter().find(|p| p["id"] == id).cloned().unwrap_or_default();
        assert_eq!(a["profile"], "s-2");
        assert_eq!(a["v"], 1);
        assert_eq!(list.len(), 3, "every shown profile");
        assert!(
            by(&list, "s-2")["here"] == true
                && by(&list, "s-2")["name"] == "Job"
                && by(&list, "s-default")["linked"] == true
        );
        assert_eq!(by(&list, "s-default")["spaces"], 2);
        assert_eq!(by(&list, "s-default")["nameFrom"], "safari", "the browser's name");
        assert_eq!(by(&list, "s-default")["symbol"], "data:image/png;base64,x");
        assert!(by(&list, "s-2").get("nameFrom").is_none());
        assert_eq!(entries.len(), 4, "every space in the order");
        assert!(by(&entries, "job")["tabCount"] == 3 && by(&entries, "job")["name"] == "Job board");
        assert_eq!(by(&entries, "fun")["tabCount"], 0);
        assert!(a.get("switchSettings").is_none() && a.get("switching").is_none(), "not sent without parking");
        let with = across(&d, "safari", "s-2", parts, Some(obj(json!({ "phase": "creating" }))), true);
        assert_eq!(with["switchSettings"], json!({ "closeWindows": false }));
        assert_eq!(with["switching"]["phase"], "creating");
        d.now += STALE_MS + 1.0;
        let later = across(&d, "safari", "s-default", parts, None, false);
        let stale = by(&json::array(later.get("profiles")).cloned().unwrap_or_default(), "s-2");
        assert_eq!(stale["stale"], true, "not seen for a month says so");
        assert_eq!(
            by(&json::array(later.get("profiles")).cloned().unwrap_or_default(), "s-default")["stale"],
            false,
            "linked: never stale"
        );
        // No profile has a space in the order: this one alone.
        let empty = Data::default();
        let (none_s, none_c, none_l) = (SpaceValues::new(), TabCounts::new(), HashSet::new());
        let lone = across(
            &empty,
            "safari",
            "s-x",
            AcrossParts { spaces: &none_s, counts: &none_c, linked: &none_l },
            None,
            false,
        );
        assert_eq!(json::array(lone.get("profiles")).map(Vec::len), Some(1));
        // A profile in no space of the order, but here: added last.
        let here = across(&d, "safari", "s-9", parts, None, false);
        let ids: Vec<Value> =
            json::array(here.get("profiles")).cloned().unwrap_or_default().iter().map(|p| p["id"].clone()).collect();
        assert_eq!(ids, [json!("s-default"), json!("s-2"), json!("s-3"), json!("s-9")]);
    }

    #[test]
    fn own_spaces_and_counts() {
        let mut d = Data { with_data: vec!["s-a".into(), "s-b".into(), "s-c".into()], ..Data::default() };
        // s-a linked with its state: its copy's list, in its order (or its place there).
        d.copies.insert(
            "safari:s-a".into(),
            vec![
                json!({ "id": "a2", "order": 1 }),
                json!({ "id": "a1", "order": 0 }),
                json!({ "id": "a3" }),
                json!("x"),
                json!({ "name": "no id" }),
            ],
        );
        // s-b not linked: its set's, by order then id.
        d.sets.insert(
            ("safari:s-b".into(), "spaces".into()),
            vec![("b2".into(), json!({ "order": 1 })), ("b1".into(), json!({ "order": 1 })), ("b0".into(), json!({}))],
        );
        d.sets.insert(
            ("safari:s-b".into(), "tabs".into()),
            vec![
                ("t1".into(), json!({ "spaceId": "b1" })),
                ("t2".into(), json!({ "spaceId": "b1" })),
                ("t3".into(), json!({})),
            ],
        );
        let (ids, values) = own_spaces(&d, "safari");
        assert_eq!(ids["s-a"], ["a1", "a2", "a3"]);
        assert_eq!(values["s-a"]["a3"]["order"], 2.0, "its place in the list");
        assert_eq!(ids["s-b"], ["b0", "b1", "b2"]);
        assert!(!ids.contains_key("s-c"), "no spaces: left out");
        let counts = tab_counts(&d, "safari", ids.keys());
        assert_eq!(counts["s-b"]["b1"], 2);
        assert!(!counts.contains_key("s-a"));
        // across_for: refreshed with the ids, the other profiles' contents only.
        d.order = vec![k("s-a", "a1"), k("s-b", "b1")];
        d.known = vec!["s-a".into(), "s-b".into()];
        let a = across_for(&mut d, "safari:s-a", None, false);
        assert_eq!(d.refreshed, [ids]);
        let contents = json::array(a.get("contents")).cloned().unwrap_or_default();
        assert_eq!(contents.len(), 3, "s-b's three spaces");
        assert!(contents.iter().all(|c| c["profile"] == "s-b"));
        assert_eq!(contents[1]["content"]["space"], "b1");
    }

    #[test]
    fn a_spaces_contents() {
        let mut d = Data::default();
        let l = "safari:s-a".to_string();
        let big = format!("data:image/png;base64,{}", "x".repeat(7000));
        d.sets.insert((l.clone(), "pins".into()), vec![
            ("p2".into(), json!({ "spaceId": "s1", "title": "Two", "url": "https://two.example:8443/x", "folderId": "f1", "pos": 2 })),
            ("p1".into(), json!({ "spaceId": "s1", "title": "One", "url": "https://user@one.example/path?q#h" })),
            ("p9".into(), json!({ "spaceId": "s2", "url": "https://other.example" })),
        ]);
        d.sets.insert(
            (l.clone(), "folders".into()),
            vec![
                ("f1".into(), json!({ "spaceId": "s1", "name": "Work", "open": false, "pos": 1 })),
                ("f2".into(), json!({ "spaceId": "s1" })),
            ],
        );
        d.sets.insert((l.clone(), "tabs".into()), vec![
            ("t1".into(), json!({ "spaceId": "s1", "url": "https://one.example/a", "order": 1, "lastUsed": 5, "icon": "data:image/png;base64,own" })),
            ("t2".into(), json!({ "spaceId": "s1", "url": "ftp://", "order": 3, "lastUsed": 9 })),
            ("t3".into(), json!({ "spaceId": "s1", "url": "https://one.example/b", "order": 2, "lastUsed": 9, "icon": big.clone() })),
            ("t4".into(), json!({ "spaceId": "s1", "url": "https://one.example/c", "order": 0, "icon": "https://one.example/favicon.ico" })),
        ]);
        d.sets.insert(
            (l.clone(), "siteIcons".into()),
            vec![
                ("https://one.example".into(), json!({ "data": "data:image/png;base64,site" })),
                ("https://two.example:8443".into(), json!({ "data": big })),
            ],
        );
        let c = Value::Object(space_content(&d, &l, "s1", 3, 6000).unwrap_or_default());
        assert_eq!(c["space"], "s1");
        let pins = c["pins"].as_array().cloned().unwrap_or_default();
        assert_eq!(pins.len(), 2, "this space's only");
        assert_eq!(
            pins[0],
            json!({ "id": "p1", "title": "One", "url": "https://user@one.example/path?q#h", "icon": "data:image/png;base64,site", "folderId": null, "pos": 0.0 })
        );
        assert_eq!(pins[1]["icon"], "", "its site's icon too big");
        assert_eq!(pins[1]["folderId"], "f1");
        let folders = c["folders"].as_array().cloned().unwrap_or_default();
        assert_eq!(folders[0], json!({ "id": "f1", "name": "Work", "open": false, "pos": 1.0 }));
        assert_eq!(folders[1]["open"], true, "open unless said");
        let tabs = c["tabs"].as_array().cloned().unwrap_or_default();
        let ids: Vec<&str> = tabs.iter().filter_map(|t| t["id"].as_str()).collect();
        assert_eq!(ids, ["t2", "t3", "t1"], "newest first, at most max_tabs");
        assert_eq!(tabs[0]["active"], true, "the first of the most recently used");
        assert_eq!(tabs[1]["active"], false);
        assert_eq!(tabs[0]["icon"], "", "no site for it");
        assert_eq!(tabs[1]["icon"], "data:image/png;base64,site", "its own too big: its site's");
        assert_eq!(tabs[2]["icon"], "data:image/png;base64,own", "its own, small");
        assert!(space_content(&d, "nolink", "s1", 3, 6000).is_none());
        assert!(space_content(&d, &l, "", 3, 6000).is_none());
        assert_eq!(origin("HTTP://[::1]:80/x"), Some("HTTP://[::1]:80".into()));
        assert_eq!(origin("about:blank"), None);
        assert_eq!(origin("1a://x"), None);
        assert_eq!(origin("https://host:/"), Some("https://host".into()));
    }

    #[test]
    fn new_window_and_sent_once() {
        let w = WindowKey::new("chrome:p-1", 7);
        assert_eq!(
            new_margin_window(&w, true),
            Some(LinkRequest {
                link: "chrome:p-1".into(),
                kind: "newWindow",
                payload: json!({ "fromWindowId": 7 }),
                window_id: None
            })
        );
        assert_eq!(new_margin_window(&w, false), None, "not linked: no window");
        let mut a = Across::new();
        assert!(a.should_send(&w, "{}") && !a.should_send(&w, "{}") && a.should_send(&w, "{\"v\":1}"));
        a.retain(|_| false);
        assert!(a.should_send(&w, "{\"v\":1}"), "forgotten with its overlay");
    }

    #[test]
    fn the_words() {
        let t = Target::new("safari:s-b", "b1");
        let s = BrowserWords::safari();
        assert_eq!(switch_words(&SwitchEvent::Started(t.clone()), "Work", &s, false, false), None);
        assert_eq!(
            switch_words(&SwitchEvent::NeedsProfile(t.clone()), "Work", &s, false, false).as_deref(),
            Some(
                "Work isn’t open in Safari. Open one of its windows (File › New Window › New Work Window) and Margin shows the space there."
            )
        );
        let failed = SwitchEvent::Failed(t.clone(), "Safari took too long to open its window".into());
        assert_eq!(
            switch_words(&failed, "Work", &s, true, false).as_deref(),
            Some(
                "Margin is turned off in Work. Turn it on in Safari › Settings › Extensions (with Work chosen at the top), then switch again."
            )
        );
        assert_eq!(
            switch_words(&failed, "Work", &s, false, true).as_deref(),
            Some(
                "Margin didn’t start in Work’s window. Check that Margin is on in Safari › Settings › Extensions (with Work chosen at the top), then switch again."
            )
        );
        assert_eq!(
            switch_words(&failed, "Work", &s, false, false).as_deref(),
            Some("Couldn’t switch to Work: Safari took too long to open its window. Nothing was closed.")
        );
        let edge = switch_words(&SwitchEvent::NeedsProfile(t), "Work", &BrowserWords::chromium("Edge"), false, false)
            .unwrap_or_default();
        assert!(edge.contains("isn’t open in Edge"));
        assert!(BrowserWords::chromium("Edge").turn_on.contains("edge://extensions in {name}"));
    }

    #[test]
    fn the_carried_settings() {
        let from = obj(json!({ "sidebarPinnedOpen": true, "theme": "arc", "other": 1 }));
        assert_eq!(carried_patch(&from, None), Some(obj(json!({ "sidebarPinnedOpen": true, "theme": "arc" }))));
        let same = obj(json!({ "sidebarPinnedOpen": true, "theme": "arc", "other": 2 }));
        assert_eq!(carried_patch(&from, Some(&same)), None, "the same already");
        let differs = obj(json!({ "sidebarPinnedOpen": false, "theme": "arc" }));
        assert!(carried_patch(&from, Some(&differs)).is_some());
        assert_eq!(carried_patch(&obj(json!({ "other": 1 })), None), None, "none of them");
    }
}
