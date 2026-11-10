//! Spaces across a browser's profiles (PLAN.md §15, docs/DATA.md "Spaces across profiles"; app/platforms/macos/shell/BrowserProfiles.swift):
//! which profile each space is in, the one order of every profile's spaces the person controls, and each profile's
//! name, emoji and color. One file per browser, beside its profiles' data sets:
//!
//! ```text
//! data/<browser>/browser.json
//!   { format, browser, order: [[profile, space]], profiles: { id: info }, switching: { closeWindows }, savedAt }
//! ```
//!
//! `switching`: how a switch between profiles treats the window it leaves (docs/HANDOFF.md §5): "Close windows to save
//! memory" (`closeWindows`, off by default: the window stays open out of sight). One value for the whole browser, so
//! every profile's Settings show the same.
//!
//! A space is in the profile whose data set has it: nothing in a set names its profile. `order` is kept as the person
//! left it and read against the sets each time (`resolve`, "the slots rule"): a space no set has any more is left out;
//! each profile's spaces fill the places its spaces had, in that profile's own order (its spaces' `order`), so a move
//! made in one profile while the app wasn't there still shows; a new space goes right after the one before it in its
//! profile's order (the first of its profile: before that profile's first); a profile not in the order yet comes
//! last. A move here (`move_space`) gives back the profile's own order when it changed, for the app to write into its
//! set, so the profile's copy shows the same order alone.
//!
//! Profile names: browsers don't give extensions profile names, so the person names each profile once; until then
//! "Default" for Safari's default profile (`s-default`) and "Profile N" for the others, in the order Margin first saw
//! them. On the Mac, with Full Disk Access, Safari's own names are read (SafariProfiles.swift) and shown over a typed
//! one; that reading is Safari's and isn't here. What it leaves in the file, each profile's `browserId` (the
//! browser's own id for it) and `browserName` (the name the browser last gave it), is read and kept, and
//! `set_browser_names` / `set_browser_link` take the names a Chromium counterpart reads (Chrome's and Edge's
//! `Local State`, `profile.info_cache`) the same way, when there is one.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::store::{DataStore, write_atomically};
use super::{Note, number, prefix, sorted_json};
use crate::json::{self, Object};

pub const FORMAT: i64 = 1;
/// Safari's default profile's copy.
pub const DEFAULT_PROFILE: &str = "s-default";
/// A profile's mark until it's given a color: one of these, by when Margin first saw it.
pub const COLORS: [&str; 8] = ["#6c5ce7", "#00b894", "#e17055", "#0984e3", "#fdcb6e", "#e84393", "#636e72", "#00cec9"];
/// Not linked for this long (30 days): the profile's menu says when it was last seen.
pub const STALE_MS: f64 = 30.0 * 86_400_000.0;
/// "Seen now" is written at most once an hour (it only says how long it's been).
const SEEN_EVERY_MS: f64 = 3_600_000.0;

/// A space of one profile. Sorted by profile, then space.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SpaceKey {
    pub profile: String,
    pub space: String,
}

impl SpaceKey {
    pub fn new(profile: impl Into<String>, space: impl Into<String>) -> Self {
        Self { profile: profile.into(), space: space.into() }
    }
}

impl std::fmt::Display for SpaceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.profile, self.space)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProfileInfo {
    pub name: String,
    pub emoji: String,
    pub color: String,
    /// The person named it.
    pub named: bool,
    pub first_seen: f64,
    /// Linked last (or now, while it is).
    pub last_seen: f64,
    /// Forgotten by the person: left out until its copy links again.
    pub hidden: bool,
    /// The browser's own id for the profile, once its name was read (Safari: its `server_id`).
    pub browser_id: String,
    /// The name the browser last gave it.
    pub browser_name: String,
}

impl ProfileInfo {
    pub fn to_json(&self) -> Value {
        let mut o = json!({
            "name": self.name, "emoji": self.emoji, "color": self.color, "named": self.named,
            "firstSeen": number(self.first_seen), "lastSeen": number(self.last_seen), "hidden": self.hidden,
        });
        if !self.browser_id.is_empty()
            && let Some(m) = o.as_object_mut()
        {
            m.insert("browserId".into(), Value::from(self.browser_id.as_str()));
            m.insert("browserName".into(), Value::from(self.browser_name.as_str()));
        }
        o
    }

    pub fn from_json(o: &Object) -> Self {
        let s = |k: &str| json::string(o.get(k)).unwrap_or("").to_string();
        let b = |k: &str| json::boolean(o.get(k)).unwrap_or(false);
        Self {
            name: s("name"),
            emoji: s("emoji"),
            color: s("color"),
            named: b("named"),
            first_seen: json::num(o.get("firstSeen")).unwrap_or(0.0),
            last_seen: json::num(o.get("lastSeen")).unwrap_or(0.0),
            hidden: b("hidden"),
            browser_id: s("browserId"),
            browser_name: s("browserName"),
        }
    }
}

/// The browser's own name for a profile now (not saved as such), and its symbol (Safari: an SF Symbol's name).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserName {
    pub name: String,
    pub symbol: String,
}

/// What a space key does in a window (`space_step`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpaceStep {
    /// A space of the window's own profile, from one of its own.
    Own(SpaceKey),
    /// The cross-profile switch (another profile's space, or on from an aim that's already another profile's).
    Across(SpaceKey),
    /// A held key's repeat that would go to another profile, or on from one: nothing, so a held key starts at most
    /// one switch of profile per press.
    Held,
}

pub struct BrowserProfiles {
    browser: String,
    path: Option<PathBuf>,
    /// Milliseconds since 1970.
    pub now: Box<dyn Fn() -> f64 + Send>,
    /// The order as the person left it.
    stored: Vec<SpaceKey>,
    /// Resolved against the sets (`refresh`).
    order: Vec<SpaceKey>,
    info: HashMap<String, ProfileInfo>,
    saves: usize,
    /// "Close windows to save memory" (docs/HANDOFF.md §5): the window a switch leaves is closed, not kept.
    close_windows: bool,
    browser_names: HashMap<String, BrowserName>,
    log: Vec<Note>,
}

impl BrowserProfiles {
    /// `root`: the data folder (`DataStore::root`); `None` keeps it in memory (the tests).
    pub fn new(browser: impl Into<String>, root: Option<&Path>) -> Self {
        let browser = browser.into();
        let path = root.map(|r| r.join(DataStore::file_name(&browser)).join("browser.json"));
        let mut out = Self {
            browser,
            path,
            now: Box::new(crate::time::now_ms),
            stored: Vec::new(),
            order: Vec::new(),
            info: HashMap::new(),
            saves: 0,
            close_windows: false,
            browser_names: HashMap::new(),
            log: Vec::new(),
        };
        out.load();
        out
    }

    fn load(&mut self) {
        let Some(path) = &self.path else { return };
        let Some(o) = super::store::object_at(path).or_else(|| super::store::object_at(&super::store::bak_of(path)))
        else {
            return;
        };
        if json::int(o.get("format")) != Some(FORMAT) {
            return;
        }
        self.stored = json::array(o.get("order"))
            .into_iter()
            .flatten()
            .filter_map(|entry| match entry.as_array()?.as_slice() {
                [p, s] => Some(SpaceKey::new(p.as_str()?, s.as_str()?)),
                _ => None,
            })
            .collect();
        for (id, value) in json::object(o.get("profiles")).into_iter().flatten() {
            if let Some(value) = value.as_object() {
                self.info.insert(id.clone(), ProfileInfo::from_json(value));
            }
        }
        self.close_windows =
            json::object(o.get("switching")).and_then(|s| json::boolean(s.get("closeWindows"))).unwrap_or(false);
        self.order = self.stored.clone();
    }

    /// Written at once, as the sets' files are (a temporary file, flushed, `.bak`, rename). A failure is logged.
    pub fn save(&mut self) {
        self.saves += 1;
        let Some(path) = &self.path else { return };
        let body = json!({
            "format": FORMAT, "browser": self.browser, "savedAt": number((self.now)()),
            "order": self.stored.iter().map(|k| json!([k.profile, k.space])).collect::<Vec<_>>(),
            "profiles": self.info.iter().map(|(id, i)| (id.clone(), i.to_json())).collect::<Object>(),
            "switching": { "closeWindows": self.close_windows },
        });
        if let Err(e) = write_atomically(&sorted_json(&body), path) {
            self.log.push(Note::warn(format!("{}: browser.json not saved: {e}", self.browser)));
        }
    }

    pub fn browser(&self) -> &str {
        &self.browser
    }
    pub fn order(&self) -> &[SpaceKey] {
        &self.order
    }
    pub fn stored(&self) -> &[SpaceKey] {
        &self.stored
    }
    pub fn info(&self, profile: &str) -> Option<&ProfileInfo> {
        self.info.get(profile)
    }
    pub fn saves(&self) -> usize {
        self.saves
    }
    pub fn close_windows(&self) -> bool {
        self.close_windows
    }
    pub fn take_log(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.log)
    }

    // ---- switching ----

    /// "Close windows to save memory" turned on or off. True if it changed (saved then).
    pub fn set_close_windows(&mut self, on: bool) -> bool {
        if on == self.close_windows {
            return false;
        }
        self.close_windows = on;
        self.save();
        true
    }

    // ---- profiles ----

    /// Every profile Margin knows, in the order it first saw them (hidden ones too).
    pub fn profiles(&self) -> Vec<String> {
        let mut out: Vec<(&String, f64)> = self.info.iter().map(|(id, i)| (id, i.first_seen)).collect();
        out.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(b.0)));
        out.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// "Default" for Safari's default profile; "Profile N" for the others, by when Margin first saw them (N from 2
    /// when the default one is known, else from 1).
    pub fn default_name(&self, profile: &str) -> String {
        if profile == DEFAULT_PROFILE {
            return "Default".into();
        }
        let others: Vec<String> = self.profiles().into_iter().filter(|p| p != DEFAULT_PROFILE).collect();
        let at = others.iter().position(|p| p == profile).unwrap_or(others.len());
        format!("Profile {}", at + if self.info.contains_key(DEFAULT_PROFILE) { 2 } else { 1 })
    }

    pub fn name(&self, profile: &str) -> String {
        if let Some(b) = self.browser_names.get(profile) {
            return b.name.clone();
        }
        match self.info.get(profile) {
            Some(i) if i.named && !i.name.is_empty() => i.name.clone(),
            _ => self.default_name(profile),
        }
    }

    pub fn color(&self, profile: &str) -> String {
        if let Some(c) = self.info.get(profile).map(|i| &i.color).filter(|c| !c.is_empty()) {
            return c.clone();
        }
        let at = self.profiles().iter().position(|p| p == profile).unwrap_or(0);
        COLORS[at % COLORS.len()].to_string()
    }

    /// Named by the person (trimmed, at most 40 characters; an empty name: back to the default), its emoji (at most
    /// 8) and its color (`#rgb` or `#rrggbb`; anything else leaves it). While the browser's name is shown, the name
    /// is the browser's: only the emoji and color change. False for a profile Margin doesn't know.
    pub fn rename(&mut self, profile: &str, name: &str, emoji: &str, color: Option<&str>) -> bool {
        let browser_named = self.browser_names.contains_key(profile);
        let Some(i) = self.info.get_mut(profile) else { return false };
        if !browser_named {
            let trimmed = prefix(name.trim(), 40);
            i.named = !trimmed.is_empty();
            i.name = trimmed;
        }
        i.emoji = prefix(emoji, 8);
        if let Some(color) = color.filter(|c| is_color(c)) {
            i.color = color.to_string();
        }
        self.save();
        true
    }

    /// Forgotten: its spaces leave the list (its data stays) until its copy links again.
    pub fn forget(&mut self, profile: &str) -> bool {
        match self.info.get_mut(profile) {
            Some(i) if !i.hidden => i.hidden = true,
            _ => return false,
        }
        self.order.retain(|k| k.profile != profile);
        self.save();
        true
    }

    // ---- the browser's own names (a counterpart of SafariProfiles.swift's; none on Windows yet) ----

    /// The names the browser gives its profiles now, by Margin's profile id: shown over a typed name, never saved
    /// as one. True if a name shown changed.
    pub fn set_browser_names(&mut self, names: HashMap<String, BrowserName>) -> bool {
        let changed = names != self.browser_names;
        self.browser_names = names;
        changed
    }

    /// No names from the browser (no permission, or none readable): the typed ones again.
    pub fn drop_browser_names(&mut self) -> bool {
        let had = !self.browser_names.is_empty();
        self.browser_names.clear();
        had
    }

    /// A profile linked to the browser's own (its id and name there), kept in the file. True if it changed (saved).
    pub fn set_browser_link(&mut self, profile: &str, browser_id: &str, browser_name: &str) -> bool {
        let Some(i) = self.info.get_mut(profile) else { return false };
        if i.browser_id == browser_id && i.browser_name == browser_name {
            return false;
        }
        i.browser_id = browser_id.to_string();
        i.browser_name = browser_name.to_string();
        self.save();
        true
    }

    // ---- a profile under a new id ----

    /// `old`'s place taken by `new` (its set was carried over: `DataSync::carry`): its name, emoji, color (the one
    /// it was shown with), when it was first seen and its places in the order; `old` forgotten. Its copy linking
    /// again later brings it back. (Swift also matches the profiles to Safari's again here; that's Safari's.)
    pub fn carry(&mut self, old: &str, new: &str) {
        if old == new {
            return;
        }
        let Some(o) = self.info.get(old).cloned() else { return };
        let shown_color = if o.color.is_empty() { self.color(old) } else { o.color.clone() };
        let mut n = self.info.get(new).cloned().unwrap_or_default();
        n.name = o.name.clone();
        n.named = o.named;
        n.emoji = o.emoji.clone();
        n.color = shown_color;
        n.first_seen = if n.first_seen == 0.0 { o.first_seen } else { n.first_seen.min(o.first_seen) };
        n.last_seen = n.last_seen.max(o.last_seen);
        n.hidden = false;
        if n.browser_id.is_empty() {
            n.browser_id = o.browser_id.clone();
            n.browser_name = o.browser_name.clone();
        }
        self.info.insert(new.to_string(), n);
        let moved = |list: &[SpaceKey]| {
            let mut seen = HashSet::new();
            list.iter()
                .filter(|k| k.profile != new)
                .map(|k| if k.profile == old { SpaceKey::new(new, k.space.as_str()) } else { k.clone() })
                .filter(|k| seen.insert(k.clone()))
                .collect::<Vec<_>>()
        };
        self.stored = moved(&self.stored);
        self.order = moved(&self.order);
        self.save();
        self.forget(old);
    }

    // ---- the order ----

    /// The profiles' spaces as their sets have them now (each profile's in its own order) and which profiles are
    /// linked: the order resolved, new profiles taken in, the linked ones seen now. Saved when anything lasting
    /// changed; true then.
    pub fn refresh(&mut self, spaces: &HashMap<String, Vec<String>>, linked: &HashSet<String>) -> bool {
        let mut changed = false;
        let t = (self.now)();
        let all: BTreeSet<&String> = spaces.keys().chain(linked).collect();
        for p in all {
            if self.info.contains_key(p) {
                continue;
            }
            let i = ProfileInfo {
                first_seen: t + self.info.len() as f64 * 0.001, // apart, in the order they're met
                last_seen: if linked.contains(p) { t } else { 0.0 },
                ..ProfileInfo::default()
            };
            self.info.insert(p.clone(), i);
            changed = true;
        }
        for p in linked {
            let Some(i) = self.info.get_mut(p) else { continue };
            if i.hidden {
                i.hidden = false; // it's back
                changed = true;
            }
            if t - i.last_seen > SEEN_EVERY_MS {
                changed = true;
            }
            i.last_seen = t;
        }
        let visible: HashMap<String, Vec<String>> = spaces
            .iter()
            .filter(|(p, _)| self.info.get(*p).is_none_or(|i| !i.hidden))
            .map(|(p, s)| (p.clone(), s.clone()))
            .collect();
        let resolved = Self::resolve(&self.stored, &visible, &self.profiles());
        if resolved != self.stored {
            self.stored = resolved.clone();
            changed = true;
        }
        self.order = resolved;
        if changed {
            self.save();
        }
        changed
    }

    /// The slots rule (above). `spaces`: each profile's space ids in its own order; `profiles`: in the order Margin
    /// first saw them.
    pub fn resolve(stored: &[SpaceKey], spaces: &HashMap<String, Vec<String>>, profiles: &[String]) -> Vec<SpaceKey> {
        let mut seen = HashSet::new();
        let mut out: Vec<SpaceKey> = stored
            .iter()
            .filter(|k| spaces.get(&k.profile).is_some_and(|s| s.contains(&k.space)))
            .filter(|k| seen.insert((*k).clone()))
            .cloned()
            .collect();
        let mut later: Vec<&String> = spaces.keys().filter(|p| !profiles.contains(p)).collect();
        later.sort();
        let known: Vec<&String> = profiles.iter().chain(later).collect();
        for p in known {
            let Some(own) = spaces.get(p).filter(|o| !o.is_empty()) else { continue };
            let key = |s: &str| SpaceKey::new(p.as_str(), s);
            if !out.iter().any(|k| &k.profile == p) {
                out.extend(own.iter().map(|s| key(s)));
                continue;
            }
            // New ones: each right after the one before it in the profile's order.
            let placed: HashSet<String> = out.iter().filter(|k| &k.profile == p).map(|k| k.space.clone()).collect();
            for (n, id) in own.iter().enumerate() {
                if placed.contains(id) {
                    continue;
                }
                let before = own[..n].iter().rev().find(|s| out.contains(&key(s)));
                if let Some(at) = before.and_then(|b| out.iter().position(|k| *k == key(b))) {
                    out.insert(at + 1, key(id));
                } else if let Some(first) = out.iter().position(|k| &k.profile == p) {
                    out.insert(first, key(id));
                } else {
                    out.push(key(id));
                }
            }
            // Its places, filled in its own order.
            let places: Vec<usize> = (0..out.len()).filter(|i| &out[*i].profile == p).collect();
            for (i, at) in places.into_iter().enumerate() {
                if let Some(s) = own.get(i) {
                    out[at] = key(s);
                }
            }
        }
        out
    }

    /// A space moved one place along (`dir` < 0: back, else on) in the whole order: whether it moved, and the
    /// profile's own order afterwards if it changed (the app writes it into the set).
    pub fn move_space(&mut self, key: &SpaceKey, dir: i32) -> (bool, Option<Vec<String>>) {
        let Some(at) = self.order.iter().position(|k| k == key) else { return (false, None) };
        let to = if dir < 0 { at.checked_sub(1) } else { Some(at + 1) };
        let Some(to) = to.filter(|t| *t < self.order.len()) else { return (false, None) };
        let own = |order: &[SpaceKey]| {
            order.iter().filter(|k| k.profile == key.profile).map(|k| k.space.clone()).collect::<Vec<_>>()
        };
        let before = own(&self.order);
        self.order.swap(at, to);
        self.stored = self.order.clone();
        self.save();
        let after = own(&self.order);
        (true, (after != before).then_some(after))
    }

    /// The space before or after in the whole order, wrapping around; `None` with one space.
    pub fn neighbour(&self, key: &SpaceKey, dir: i32) -> Option<SpaceKey> {
        let n = self.order.len();
        if n < 2 {
            return None;
        }
        let at = self.order.iter().position(|k| k == key)?;
        let to = if dir < 0 { (at + n - 1) % n } else { (at + 1) % n };
        self.order.get(to).cloned()
    }

    /// What a space key does in a window of `profile` showing `here` (the chained aim, a moment after a key:
    /// ShellProfiles.swift spaceKey). `None`: nothing across profiles (only one has spaces): the copy's own
    /// `navigate`.
    pub fn space_step(&self, here: &SpaceKey, profile: &str, dir: i32, is_repeat: bool) -> Option<SpaceStep> {
        let profiles: HashSet<&String> = self.order.iter().map(|k| &k.profile).collect();
        if profiles.len() < 2 {
            return None;
        }
        let next = self.neighbour(here, dir)?;
        if here.profile == profile && next.profile == profile {
            return Some(SpaceStep::Own(next));
        }
        Some(if is_repeat { SpaceStep::Held } else { SpaceStep::Across(next) })
    }

    /// The profiles with a space in the order, in the order Margin first saw them.
    pub fn profiles_shown(&self) -> Vec<String> {
        self.profiles().into_iter().filter(|p| self.order.iter().any(|k| &k.profile == p)).collect()
    }

    /// What an overlay of `profile`'s window draws besides its own state (`ui/host-app.ts` `across`): every shown
    /// profile, and every space in the one order. `spaces`: each profile's spaces' values (name, emoji, color);
    /// `counts`: profile → space → its tabs; `linked`; `switching`: the cross-profile switch under way, if any;
    /// `switch_settings`: whether "Close windows to save memory" means anything now (false: not sent); `symbol`: a
    /// symbol's picture (a PNG `data:` URL), for a profile with the browser's name.
    #[allow(clippy::too_many_arguments)]
    pub fn across(
        &self,
        profile: &str,
        spaces: &HashMap<String, HashMap<String, Object>>,
        counts: &HashMap<String, HashMap<String, i64>>,
        linked: &HashSet<String>,
        switching: Option<Value>,
        switch_settings: bool,
        symbol: &dyn Fn(&str) -> Option<String>,
    ) -> Value {
        let t = (self.now)();
        let mut shown = self.profiles_shown();
        if shown.is_empty() {
            shown.push(profile.to_string());
        }
        if !shown.iter().any(|p| p == profile) {
            shown.push(profile.to_string());
        }
        let list: Vec<Value> = shown
            .iter()
            .map(|p| {
                let i = self.info.get(p).cloned().unwrap_or_default();
                let is_linked = linked.contains(p);
                let mut o = json!({
                    "id": p, "name": self.name(p), "emoji": i.emoji, "color": self.color(p), "named": i.named,
                    "here": p == profile, "linked": is_linked, "lastSeen": number(i.last_seen),
                    "stale": !is_linked && i.last_seen > 0.0 && t - i.last_seen > STALE_MS,
                    "spaces": self.order.iter().filter(|k| &k.profile == p).count(),
                });
                if let (Some(b), Some(m)) = (self.browser_names.get(p), o.as_object_mut()) {
                    m.insert("nameFrom".into(), Value::from(self.browser.as_str())); // the browser's name: Edit Profile leaves it
                    if let Some(picture) = symbol(&b.symbol) {
                        m.insert("symbol".into(), Value::from(picture));
                    }
                }
                o
            })
            .collect();
        let entries: Vec<Value> = self
            .order
            .iter()
            .map(|k| {
                let v = spaces.get(&k.profile).and_then(|s| s.get(&k.space));
                let text = |key: &str| v.and_then(|v| json::string(v.get(key))).unwrap_or("").to_string();
                json!({
                    "profile": k.profile, "id": k.space, "name": text("name"), "emoji": text("emoji"), "color": text("color"),
                    "tabCount": counts.get(&k.profile).and_then(|c| c.get(&k.space)).copied().unwrap_or(0),
                })
            })
            .collect();
        let mut out = json!({ "v": 1, "profile": profile, "profiles": list, "spaces": entries });
        if let Some(m) = out.as_object_mut() {
            if switch_settings {
                m.insert("switchSettings".into(), json!({ "closeWindows": self.close_windows }));
            }
            if let Some(switching) = switching {
                m.insert("switching".into(), switching);
            }
        }
        out
    }
}

/// `#rgb` or `#rrggbb`.
fn is_color(c: &str) -> bool {
    c.strip_prefix('#').is_some_and(|h| (h.len() == 3 || h.len() == 6) && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::testing::temp;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn k(p: &str, s: &str) -> SpaceKey {
        SpaceKey::new(p, s)
    }

    fn spaces(list: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        list.iter().map(|(p, s)| (p.to_string(), s.iter().map(|s| s.to_string()).collect())).collect()
    }

    fn set(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn names(order: &[SpaceKey]) -> Vec<String> {
        order.iter().map(SpaceKey::to_string).collect()
    }

    #[test]
    fn the_slots_rule() {
        let stored = [k("A", "a1"), k("B", "b1"), k("A", "a2"), k("B", "b2")];
        let ab = ["A".to_string(), "B".to_string()];
        let r = |s: &[(&str, &[&str])], p: &[String]| BrowserProfiles::resolve(&stored, &spaces(s), p);
        assert_eq!(r(&[("A", &["a1", "a2"]), ("B", &["b1", "b2"])], &ab), stored, "as stored when the sets agree");
        assert_eq!(
            r(&[("A", &["a2", "a1"]), ("B", &["b1", "b2"])], &ab),
            [k("A", "a2"), k("B", "b1"), k("A", "a1"), k("B", "b2")],
            "a profile's own reorder fills its places"
        );
        assert_eq!(
            r(&[("A", &["a1"]), ("B", &["b1", "b2"])], &ab),
            [k("A", "a1"), k("B", "b1"), k("B", "b2")],
            "a space no set has is left out"
        );
        assert_eq!(
            r(&[("A", &["a1", "a9", "a2"]), ("B", &["b1", "b2"])], &ab),
            [k("A", "a1"), k("A", "a9"), k("B", "b1"), k("A", "a2"), k("B", "b2")],
            "a new space right after the one before it"
        );
        assert_eq!(
            r(&[("A", &["a0", "a1", "a2"]), ("B", &["b1", "b2"])], &ab)[..2],
            [k("A", "a0"), k("A", "a1")],
            "a new first space before its profile's first"
        );
        let abc = ["A".to_string(), "B".to_string(), "C".to_string()];
        assert_eq!(
            r(&[("A", &["a1", "a2"]), ("B", &["b1", "b2"]), ("C", &["c2", "c1"])], &abc)[4..],
            [k("C", "c2"), k("C", "c1")],
            "a profile not in it yet comes last"
        );
        assert_eq!(
            BrowserProfiles::resolve(&[], &spaces(&[("B", &["b1"]), ("A", &["a1", "a2"])]), &ab),
            [k("A", "a1"), k("A", "a2"), k("B", "b1")],
            "nothing stored: profile by profile"
        );
        let mut twice = stored.to_vec();
        twice.push(k("A", "a1"));
        assert_eq!(
            BrowserProfiles::resolve(&twice, &spaces(&[("A", &["a1", "a2"]), ("B", &["b1", "b2"])]), &ab),
            stored,
            "a key twice is kept once"
        );
        assert_eq!(
            BrowserProfiles::resolve(&[], &spaces(&[("Z", &["z1"]), ("A", &["a1"])]), &[]),
            [k("A", "a1"), k("Z", "z1")],
            "profiles Margin doesn't know yet: by id"
        );
    }

    #[test]
    fn profiles_names_the_file() {
        let root = temp();
        let clock = Arc::new(AtomicU64::new(1_000_000f64.to_bits()));
        let c = clock.clone();
        let mut bp = BrowserProfiles::new("safari", Some(root.path()));
        bp.now = Box::new(move || f64::from_bits(c.load(Ordering::SeqCst)));
        bp.refresh(&spaces(&[("s-default", &["home", "work"])]), &set(&["s-default"]));
        clock.store(1_000_010f64.to_bits(), Ordering::SeqCst);
        bp.refresh(
            &spaces(&[("s-default", &["home", "work"]), ("s-2", &["job"]), ("s-3", &["fun"])]),
            &set(&["s-default", "s-2"]),
        );
        assert_eq!(bp.profiles(), ["s-default", "s-2", "s-3"], "in the order first seen");
        assert_eq!(
            (bp.name("s-default"), bp.name("s-2"), bp.name("s-3")),
            ("Default".into(), "Profile 2".into(), "Profile 3".into())
        );
        assert!(
            bp.color("s-default") != bp.color("s-2") && bp.color("s-2").starts_with('#'),
            "colors until chosen, one each"
        );
        assert_eq!(bp.color("s-default"), COLORS[0]);
        assert_eq!(
            names(bp.order()),
            ["s-default/home", "s-default/work", "s-2/job", "s-3/fun"],
            "the new profiles after"
        );
        assert!(
            bp.rename("s-2", "  Job  ", "💼", Some("#00b894"))
                && bp.name("s-2") == "Job"
                && bp.color("s-2") == "#00b894"
        );
        assert!(bp.rename("s-2", "Job", "", Some("red")) && bp.color("s-2") == "#00b894", "a bad color left as it was");
        assert!(bp.rename("s-2", "Job", "", Some("#abc")) && bp.color("s-2") == "#abc");
        assert!(bp.rename("s-2", "Job", "", Some("#00b89")) && bp.color("s-2") == "#abc", "five digits aren't a color");
        assert!(bp.rename("s-3", " ", "", None) && bp.name("s-3") == "Profile 3", "an empty name is the default again");
        assert!(!bp.rename("s-9", "x", "", None), "an unknown profile");
        assert!(bp.rename("s-3", &"n".repeat(50), &"e".repeat(10), None));
        assert!(
            bp.info("s-3").is_some_and(|i| i.name.chars().count() == 40 && i.emoji.chars().count() == 8),
            "40 and 8 at most"
        );
        bp.rename("s-3", "", "", None);
        let moved = bp.move_space(&k("s-2", "job"), -1);
        assert!(
            moved == (true, None) && names(bp.order()) == ["s-default/home", "s-2/job", "s-default/work", "s-3/fun"],
            "one place along"
        );
        let swapped = bp.move_space(&k("s-default", "work"), -1);
        assert!(
            swapped == (true, None) && names(bp.order()) == ["s-default/home", "s-default/work", "s-2/job", "s-3/fun"],
            "past another profile's space"
        );
        let swapped2 = bp.move_space(&k("s-default", "work"), -1);
        assert_eq!(
            swapped2.1,
            Some(vec!["work".to_string(), "home".to_string()]),
            "past its own: that profile's order given back"
        );
        assert!(
            !bp.move_space(&k("s-3", "fun"), 1).0 && !bp.move_space(&k("s-default", "work"), -1).0,
            "not past the ends"
        );
        assert!(!bp.move_space(&k("s-3", "nope"), 1).0);
        assert_eq!(bp.neighbour(&k("s-3", "fun"), 1), Some(k("s-default", "work")), "wraps around");
        assert_eq!(bp.neighbour(&k("s-default", "work"), -1), Some(k("s-3", "fun")));

        let mut again = BrowserProfiles::new("safari", Some(root.path()));
        again.now = Box::new(move || f64::from_bits(clock.load(Ordering::SeqCst)));
        assert!(
            again.order() == bp.order()
                && again.name("s-2") == "Job"
                && again.color("s-2") == "#abc"
                && again.profiles() == bp.profiles(),
            "read back"
        );
        assert!(root.path().join("safari/browser.json").exists());
        assert!(
            again.forget("s-3") && !again.order().iter().any(|k| k.profile == "s-3") && !again.forget("s-3"),
            "forget: its spaces out"
        );
        again.refresh(
            &spaces(&[("s-default", &["work", "home"]), ("s-2", &["job"]), ("s-3", &["fun"])]),
            &set(&["s-default"]),
        );
        assert!(!again.order().iter().any(|k| k.profile == "s-3"), "forget: stays out while it isn't linked");
        again.refresh(
            &spaces(&[("s-default", &["work", "home"]), ("s-2", &["job"]), ("s-3", &["fun"])]),
            &set(&["s-default", "s-3"]),
        );
        assert!(
            again.order().contains(&k("s-3", "fun")) && again.info("s-3").is_some_and(|i| !i.hidden),
            "back once its copy links"
        );
        let job: Object =
            json!({ "name": "Job board", "emoji": "📋", "color": "#000" }).as_object().cloned().unwrap_or_default();
        let space_values = HashMap::from([("s-2".to_string(), HashMap::from([("job".to_string(), job)]))]);
        let counts = HashMap::from([("s-2".to_string(), HashMap::from([("job".to_string(), 3)]))]);
        let across = again.across("s-2", &space_values, &counts, &set(&["s-default"]), None, true, &|_| None);
        let list = across["profiles"].as_array().cloned().unwrap_or_default();
        let of = |id: &str| list.iter().find(|p| p["id"] == id).cloned().unwrap_or(Value::Null);
        assert!(
            across["profile"] == "s-2"
                && list.len() == 3
                && of("s-2")["here"] == true
                && of("s-2")["name"] == "Job"
                && of("s-default")["linked"] == true
        );
        let entries = across["spaces"].as_array().cloned().unwrap_or_default();
        let job = entries.iter().find(|s| s["id"] == "job").cloned().unwrap_or(Value::Null);
        assert!(entries.len() == 4 && job["tabCount"] == 3 && job["name"] == "Job board" && job["emoji"] == "📋");
        assert_eq!(across["switchSettings"], json!({ "closeWindows": false }));
        assert!(across.get("switching").is_none());
        again.now = Box::new(|| 1_000_010.0 + STALE_MS + 1.0);
        let stale = again.across(
            "s-default",
            &HashMap::new(),
            &HashMap::new(),
            &set(&["s-default"]),
            Some(json!({ "phase": "frozen" })),
            false,
            &|_| None,
        );
        let s2 = stale["profiles"]
            .as_array()
            .and_then(|l| l.iter().find(|p| p["id"] == "s-2").cloned())
            .unwrap_or(Value::Null);
        assert_eq!(s2["stale"], true, "a profile not seen for a month says so");
        assert!(stale.get("switchSettings").is_none() && stale["switching"]["phase"] == "frozen");
    }

    #[test]
    fn seen_and_switching() {
        let root = temp();
        let clock = Arc::new(AtomicU64::new(0f64.to_bits()));
        let c = clock.clone();
        let mut bp = BrowserProfiles::new("chrome", Some(root.path()));
        bp.now = Box::new(move || f64::from_bits(c.load(Ordering::SeqCst)));
        let s = spaces(&[("p-1", &["a"])]);
        assert!(bp.refresh(&s, &set(&["p-1"])), "a new profile: saved");
        assert_eq!(bp.name("p-1"), "Profile 1", "no default profile known: Profile 1 first");
        clock.store(1_000f64.to_bits(), Ordering::SeqCst);
        assert!(!bp.refresh(&s, &set(&["p-1"])), "seen again within the hour: not saved");
        clock.store((SEEN_EVERY_MS + 1001.0).to_bits(), Ordering::SeqCst);
        assert!(bp.refresh(&s, &set(&["p-1"])), "an hour after the last refresh: saved");
        assert!(!bp.close_windows() && bp.set_close_windows(true) && !bp.set_close_windows(true));
        let again = BrowserProfiles::new("chrome", Some(root.path()));
        assert!(
            again.close_windows() && again.info("p-1").is_some_and(|i| i.last_seen == SEEN_EVERY_MS + 1001.0),
            "read back"
        );
        let memory = BrowserProfiles::new("chrome", None);
        assert!(memory.order().is_empty());
        // A later format's file: not read.
        std::fs::write(root.path().join("chrome/browser.json"), r#"{"format":2,"order":[["p-1","a"]]}"#)
            .expect("written");
        assert!(BrowserProfiles::new("chrome", Some(root.path())).order().is_empty());
        // A damaged file: its backup read (the version before the last save: closeWindows still off).
        std::fs::write(root.path().join("chrome/browser.json"), "{").expect("written");
        let from_bak = BrowserProfiles::new("chrome", Some(root.path()));
        assert!(from_bak.order() == [k("p-1", "a")] && !from_bak.close_windows());
    }

    #[test]
    fn browser_names_and_links() {
        let root = temp();
        let mut bp = BrowserProfiles::new("chrome", Some(root.path()));
        bp.refresh(&spaces(&[("p-1", &["a"]), ("p-2", &["b"])]), &set(&["p-1", "p-2"]));
        assert!(bp.set_browser_link("p-1", "Profile 1", "Work") && !bp.set_browser_link("p-1", "Profile 1", "Work"));
        assert!(!bp.set_browser_link("p-9", "x", "y"));
        let again = BrowserProfiles::new("chrome", Some(root.path()));
        assert!(
            again.info("p-1").is_some_and(|i| i.browser_id == "Profile 1" && i.browser_name == "Work"),
            "browserId and browserName kept"
        );
        assert!(again.info("p-2").is_some_and(|i| i.browser_id.is_empty()));
        let names =
            HashMap::from([("p-1".to_string(), BrowserName { name: "Work".into(), symbol: "briefcase".into() })]);
        assert!(bp.set_browser_names(names.clone()) && !bp.set_browser_names(names));
        assert!(
            bp.rename("p-1", "Typed", "🙂", None) && bp.name("p-1") == "Work",
            "the browser's name shown over a typed one"
        );
        assert!(bp.info("p-1").is_some_and(|i| i.name.is_empty() && i.emoji == "🙂"), "only the emoji changed");
        let across = bp.across("p-2", &HashMap::new(), &HashMap::new(), &HashSet::new(), None, true, &|s| {
            Some(format!("data:image/png;base64,{s}"))
        });
        let p1 = across["profiles"]
            .as_array()
            .and_then(|l| l.iter().find(|p| p["id"] == "p-1").cloned())
            .unwrap_or(Value::Null);
        assert!(
            p1["nameFrom"] == "chrome" && p1["name"] == "Work" && p1["symbol"] == "data:image/png;base64,briefcase"
        );
        assert!(bp.drop_browser_names() && bp.name("p-1") == "Profile 1" && !bp.drop_browser_names());
    }

    #[test]
    fn carried_to_a_new_id() {
        let mut bp = BrowserProfiles::new("safari", None);
        bp.refresh(&spaces(&[("s-a", &["a1", "a2"]), ("s-c", &["c1"])]), &set(&["s-a", "s-c"]));
        bp.rename("s-a", "Work", "💼", None);
        bp.carry("s-a", "s-b");
        assert_eq!(names(bp.order()), ["s-b/a1", "s-b/a2", "s-c/c1"], "its places in the order");
        assert!(
            bp.name("s-b") == "Work"
                && bp.color("s-b") == COLORS[0]
                && bp.info("s-b").is_some_and(|i| i.emoji == "💼" && !i.hidden)
        );
        assert!(bp.info("s-a").is_some_and(|i| i.hidden), "the old id forgotten");
        let before = bp.saves();
        bp.carry("s-x", "s-y");
        bp.carry("s-b", "s-b");
        assert_eq!(bp.saves(), before, "an unknown or the same: nothing");
    }

    #[test]
    fn space_steps() {
        let mut order = BrowserProfiles::new("safari", None);
        order.refresh(
            &spaces(&[("s-a", &["a1", "a2"]), ("s-b", &["b1"]), ("s-c", &["c1"])]),
            &set(&["s-a", "s-b", "s-c"]),
        );
        let (a1, a2, b1, c1) = (k("s-a", "a1"), k("s-a", "a2"), k("s-b", "b1"), k("s-c", "c1"));
        assert_eq!(order.space_step(&a1, "s-a", 1, false), Some(SpaceStep::Own(a2.clone())), "within its own profile");
        assert_eq!(
            order.space_step(&a1, "s-a", 1, true),
            Some(SpaceStep::Own(a2.clone())),
            "a repeat within its own profile too"
        );
        assert_eq!(order.space_step(&a2, "s-a", 1, false), Some(SpaceStep::Across(b1.clone())), "a press goes across");
        assert_eq!(order.space_step(&a2, "s-a", 1, true), Some(SpaceStep::Held), "a repeat doesn't");
        assert_eq!(
            order.space_step(&b1, "s-a", 1, false),
            Some(SpaceStep::Across(c1)),
            "on from another profile's aim"
        );
        assert_eq!(order.space_step(&a1, "s-a", -1, false), Some(SpaceStep::Across(k("s-c", "c1"))), "wrapping back");
        assert_eq!(
            BrowserProfiles::new("safari", None).space_step(&a1, "s-a", 1, false),
            None,
            "one profile with spaces: the copy's own"
        );
    }
}
