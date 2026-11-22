//! A browser's profiles as Margin knows them (docs/DATA.md), the one copy of their rules: Margin.app calls them
//! through margin-ffi's profiles object (app/platforms/macos/shell/BrowserProfiles.swift is its thin wrapper), the
//! Windows shell's old design directly. Each profile's name, when its copy was first and last linked, the browser's
//! own id for it, and the order every profile's spaces were last in. One file per browser, beside its profiles' data
//! sets:
//!
//! ```text
//! data/<browser>/browser.json
//!   { format, browser, order: [[profile, space]], profiles: { id: info }, savedAt }
//! ```
//!
//! Two shapes of the file, one per design:
//! - **Hosted** (the Mac, [`BrowserProfiles::new`]): exactly the above. Margin is the app (2026-11-16): the spaces
//!   the person sees and orders are the library's; `order` (`stored`) is read once by the library's import through
//!   [`BrowserProfiles::resolve`] and kept up to date against the sets (`refresh`), and nothing moves a space in it.
//!   The cross-profile order's moves, Edit Profile's emoji and colour and "Close windows to save memory" went with the
//!   overlay on the Mac (2026-11-17): an earlier version's `emoji`, `color` and `switching` aren't read, and never
//!   written.
//! - **Overlay** (the Windows shell's old design, [`BrowserProfiles::overlay`], until it's hosted): each profile's
//!   `emoji` and `color` too, and `switching: { closeWindows }` (docs/HANDOFF.md §5: the window a switch leaves is
//!   closed, not kept; one value for the whole browser). The person orders every profile's spaces in one order
//!   (`move_space`), and names, marks and colours a profile (`rename`).
//!
//! The order (`resolve`, "the slots rule"): a space no set has any more is left out; each profile's spaces fill the
//! places its spaces had, in that profile's own order (its spaces' `order`), so a move made in one profile while the
//! app wasn't there still shows; a new space goes right after the one before it in its profile's order (the first of
//! its profile: before that profile's first); a profile not in the order yet comes last.
//!
//! Profile names: the browser's own when it gives them (Safari's, read by the Mac with the folder grant or Full Disk
//! Access: SafariProfiles.swift reads them, `use_browser_names` takes them), which win over a typed one (Margin never
//! writes to the browser): a profile's window is asked of Safari by that name. Without them, a name typed in an
//! earlier version's Edit Profile, else "Default" for Safari's default profile (`s-default`) and "Profile N" for the
//! others, in the order Margin first saw them. A profile deleted in the browser keeps the name it last gave, as if
//! typed. A profile under a new id after a signing change: its set carried over (`carry_source`, `carry`).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::store::{DataStore, write_atomically};
use super::{Note, number, prefix, sorted_json};
use crate::json::{self, Object};

pub const FORMAT: i64 = 1;
/// Safari's default profile's copy.
pub const DEFAULT_PROFILE: &str = "s-default";
/// The overlay's: a profile's mark until it's given a color: one of these, by when Margin first saw it.
pub const COLORS: [&str; 8] = ["#6c5ce7", "#00b894", "#e17055", "#0984e3", "#fdcb6e", "#e84393", "#636e72", "#00cec9"];
/// "Seen now" is written at most once an hour (it only says how long it's been).
const SEEN_EVERY_MS: f64 = 3_600_000.0;
/// A name the browser last gave, kept as typed once the browser deleted the profile: at most this many characters.
const KEPT_NAME_MAX: usize = 40;

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
    /// The overlay's.
    pub emoji: String,
    /// The overlay's.
    pub color: String,
    /// The person named it (an earlier version's Edit Profile), or the browser did before it deleted the profile.
    pub named: bool,
    pub first_seen: f64,
    /// Linked last (or now, while it is).
    pub last_seen: f64,
    /// Forgotten (its set carried to the profile's new id): left out until its copy links again.
    pub hidden: bool,
    /// The browser's own id for the profile, once its name was read (Safari: its `server_id`).
    pub browser_id: String,
    /// The name the browser last gave it.
    pub browser_name: String,
}

impl ProfileInfo {
    /// As the file has it; `overlay`: with the emoji and color.
    pub fn to_json(&self, overlay: bool) -> Value {
        let mut o = json!({
            "name": self.name, "named": self.named,
            "firstSeen": number(self.first_seen), "lastSeen": number(self.last_seen), "hidden": self.hidden,
        });
        if let Some(m) = o.as_object_mut() {
            if overlay {
                m.insert("emoji".into(), Value::from(self.emoji.as_str()));
                m.insert("color".into(), Value::from(self.color.as_str()));
            }
            if !self.browser_id.is_empty() {
                m.insert("browserId".into(), Value::from(self.browser_id.as_str()));
                m.insert("browserName".into(), Value::from(self.browser_name.as_str()));
            }
        }
        o
    }

    /// `named` and `hidden` as Swift read them (a stored 1 is true); `overlay`: the emoji and color read too.
    pub fn from_json(o: &Object, overlay: bool) -> Self {
        let s = |k: &str| json::string(o.get(k)).unwrap_or("").to_string();
        let b = |k: &str| json::flag(o.get(k)).unwrap_or(false);
        Self {
            name: s("name"),
            emoji: if overlay { s("emoji") } else { String::new() },
            color: if overlay { s("color") } else { String::new() },
            named: b("named"),
            first_seen: json::num(o.get("firstSeen")).unwrap_or(0.0),
            last_seen: json::num(o.get("lastSeen")).unwrap_or(0.0),
            hidden: b("hidden"),
            browser_id: s("browserId"),
            browser_name: s("browserName"),
        }
    }
}

/// The browser's own name for a profile now (not saved as such).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserName {
    pub name: String,
}

/// One of the browser's profiles as the OS side read it (the Mac: SafariProfiles.swift's `SafariProfile`): the
/// browser's id for it, its name, and the Margin profile of the copy that runs in it, once Margin has run there.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReadProfile {
    pub server_id: String,
    pub name: String,
    pub margin: Option<String>,
}

impl ReadProfile {
    /// `{ serverId, name, margin? }` (anything else in it left out).
    pub fn from_json(o: &Object) -> Self {
        Self {
            server_id: json::string(o.get("serverId")).unwrap_or("").to_string(),
            name: json::string(o.get("name")).unwrap_or("").to_string(),
            margin: json::string(o.get("margin")).map(str::to_string),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({ "serverId": self.server_id, "name": self.name, "margin": self.margin })
    }
}

/// A copy with the browser's own id (`s-<uuid>`), never the default profile's.
fn browser_own(id: &str) -> bool {
    id.starts_with("s-") && id != DEFAULT_PROFILE
}

pub struct BrowserProfiles {
    browser: String,
    path: Option<PathBuf>,
    /// The file's shape: the overlay's (emoji, color, switching), else the hosted one's.
    overlay: bool,
    /// Milliseconds since 1970.
    pub now: Box<dyn Fn() -> f64 + Send>,
    /// Every profile's spaces in the order last resolved against the sets (`refresh`).
    stored: Vec<SpaceKey>,
    /// The overlay's: `stored`, a forgotten profile's spaces out at once (`forget`).
    order: Vec<SpaceKey>,
    info: HashMap<String, ProfileInfo>,
    saves: usize,
    /// The overlay's "Close windows to save memory" (docs/HANDOFF.md §5): the window a switch leaves is closed.
    close_windows: bool,
    /// The browser's own names now (with the permission; not saved as such): profile → name.
    browser_names: HashMap<String, BrowserName>,
    /// The browser's profiles as last read (`None`: no read, or no permission any more).
    browser_list: Option<Vec<ReadProfile>>,
    /// Linked copies `check_mapped` said no profile maps to (said again only after a read has mapped it).
    unmapped_said: HashSet<String>,
    log: Vec<Note>,
}

impl BrowserProfiles {
    /// The hosted design's (the Mac's) file. `root`: the data folder (`DataStore::root`); `None` keeps it in memory
    /// (the tests).
    pub fn new(browser: impl Into<String>, root: Option<&Path>) -> Self {
        Self::with_shape(browser.into(), root, false)
    }

    /// The overlay's file (the Windows shell's old design): with each profile's emoji and color, and `switching`.
    pub fn overlay(browser: impl Into<String>, root: Option<&Path>) -> Self {
        Self::with_shape(browser.into(), root, true)
    }

    fn with_shape(browser: String, root: Option<&Path>, overlay: bool) -> Self {
        let path = root.map(|r| r.join(DataStore::file_name(&browser)).join("browser.json"));
        let mut out = Self {
            browser,
            path,
            overlay,
            now: Box::new(crate::time::now_ms),
            stored: Vec::new(),
            order: Vec::new(),
            info: HashMap::new(),
            saves: 0,
            close_windows: false,
            browser_names: HashMap::new(),
            browser_list: None,
            unmapped_said: HashSet::new(),
            log: Vec::new(),
        };
        out.load();
        out
    }

    /// The file, else its `.bak` (also when the file doesn't parse: Swift fell back only when it couldn't be read).
    /// A later format's: nothing read.
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
                self.info.insert(id.clone(), ProfileInfo::from_json(value, self.overlay));
            }
        }
        if self.overlay {
            self.close_windows =
                json::object(o.get("switching")).and_then(|s| json::boolean(s.get("closeWindows"))).unwrap_or(false);
        }
        self.order = self.stored.clone();
    }

    /// Written at once, as the sets' files are (a temporary file, flushed, `.bak`, rename). A failure is logged.
    pub fn save(&mut self) {
        self.saves += 1;
        let Some(path) = &self.path else { return };
        let mut body = json!({
            "format": FORMAT, "browser": self.browser, "savedAt": number((self.now)()),
            "order": self.stored.iter().map(|k| json!([k.profile, k.space])).collect::<Vec<_>>(),
            "profiles": self.info.iter().map(|(id, i)| (id.clone(), i.to_json(self.overlay))).collect::<Object>(),
        });
        if self.overlay
            && let Some(m) = body.as_object_mut()
        {
            m.insert("switching".into(), json!({ "closeWindows": self.close_windows }));
        }
        if let Err(e) = write_atomically(&sorted_json(&body), path) {
            self.log.push(Note::warn(format!("{}: browser.json not saved: {e}", self.browser)));
        }
    }

    pub fn browser(&self) -> &str {
        &self.browser
    }
    /// The overlay's: the order as shown (a forgotten profile's spaces out at once).
    pub fn order(&self) -> &[SpaceKey] {
        &self.order
    }
    /// Every profile's spaces in the order last resolved against the sets.
    pub fn stored(&self) -> &[SpaceKey] {
        &self.stored
    }
    pub fn info(&self, profile: &str) -> Option<&ProfileInfo> {
        self.info.get(profile)
    }
    /// Every profile's info, by id.
    pub fn infos(&self) -> &HashMap<String, ProfileInfo> {
        &self.info
    }
    pub fn saves(&self) -> usize {
        self.saves
    }
    pub fn is_overlay(&self) -> bool {
        self.overlay
    }
    pub fn close_windows(&self) -> bool {
        self.close_windows
    }
    pub fn take_log(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.log)
    }

    // ---- switching (the overlay's) ----

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

    /// The browser's name for it, else a typed one, else its default name.
    pub fn name(&self, profile: &str) -> String {
        if let Some(b) = self.browser_names.get(profile) {
            return b.name.clone();
        }
        match self.info.get(profile) {
            Some(i) if i.named && !i.name.is_empty() => i.name.clone(),
            _ => self.default_name(profile),
        }
    }

    /// The overlay's: its color, else one of `COLORS` by when Margin first saw it.
    pub fn color(&self, profile: &str) -> String {
        if let Some(c) = self.info.get(profile).map(|i| &i.color).filter(|c| !c.is_empty()) {
            return c.clone();
        }
        let at = self.profiles().iter().position(|p| p == profile).unwrap_or(0);
        COLORS[at % COLORS.len()].to_string()
    }

    /// The overlay's Edit Profile: named by the person (trimmed, at most 40 characters; an empty name: back to the
    /// default), its emoji (at most 8) and its color (`#rgb` or `#rrggbb`; anything else leaves it). While the
    /// browser's name is shown, the name is the browser's: only the emoji and color change. False for a profile
    /// Margin doesn't know.
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

    /// Forgotten (its set was carried to the profile's new id: `carry`): its spaces leave the order at the next
    /// refresh (its data stays) until its copy links again. The overlay's order drops them at once. True if it was
    /// known and not forgotten yet (saved then).
    pub fn forget(&mut self, profile: &str) -> bool {
        match self.info.get_mut(profile) {
            Some(i) if !i.hidden => i.hidden = true,
            _ => return false,
        }
        if self.overlay {
            self.order.retain(|k| k.profile != profile);
        }
        self.save();
        true
    }

    // ---- the browser's own names ----

    /// What the browser has now (the Mac: SafariProfiles.read): each of its profiles that Margin's copy runs in gets
    /// the browser's name; one linked before (by `browser_id`) keeps it while the browser still has that profile, even
    /// if the copy's entry can't be read this time. A profile the browser no longer has keeps its last name as a
    /// typed one (unless one was typed). True if a name shown changed.
    pub fn use_browser_names(&mut self, list: Vec<ReadProfile>) -> bool {
        self.browser_list = Some(list);
        let before = self.browser_names.clone();
        if self.associate() {
            self.save();
        }
        self.browser_names != before
    }

    /// Linked copies with a browser's own id (`s-<uuid>`) that no profile in the last read maps to: said in the log
    /// once each (again only after a read has mapped it). Nothing before a read: no permission, a busy database or no
    /// read yet says nothing about them. The ids said.
    pub fn check_mapped(&mut self, linked: &HashSet<String>) -> Vec<String> {
        let Some(list) = &self.browser_list else { return Vec::new() };
        let mapped: BTreeSet<&str> = list.iter().filter_map(|p| p.margin.as_deref()).collect();
        for m in &mapped {
            self.unmapped_said.remove(*m);
        }
        let mut ids: Vec<&String> = linked.iter().collect();
        ids.sort();
        let mut said = Vec::new();
        for id in ids {
            if !browser_own(id) || mapped.contains(id.as_str()) || self.unmapped_said.contains(id) {
                continue;
            }
            self.unmapped_said.insert(id.clone());
            said.push(id.clone());
            let copies: Vec<&str> = mapped.iter().copied().collect();
            self.log.push(Note::note(format!(
                "{}: copy {id} isn't any Safari profile's as read ({} profiles, copies {})",
                self.browser,
                list.len(),
                copies.join(", ")
            )));
        }
        said
    }

    /// No names from the browser (no permission, or none readable): the typed ones again. True if names were shown.
    pub fn drop_browser_names(&mut self) -> bool {
        self.browser_list = None;
        if self.browser_names.is_empty() {
            return false;
        }
        self.browser_names.clear();
        true
    }

    /// The browser's profiles as last read (`None`: none read, or no permission any more).
    pub fn browser_read(&self) -> Option<&[ReadProfile]> {
        self.browser_list.as_deref()
    }

    /// The browser's own names now, by Margin's profile id.
    pub fn browser_names(&self) -> &HashMap<String, BrowserName> {
        &self.browser_names
    }

    /// The names from the last read, and each known profile's link to the browser's (`browser_id`, `browser_name`)
    /// brought up to date. True if the links changed (to be saved).
    fn associate(&mut self) -> bool {
        let Some(list) = &self.browser_list else { return false };
        let mut by_id: HashMap<&str, &ReadProfile> = HashMap::new();
        for p in list {
            by_id.entry(p.server_id.as_str()).or_insert(p);
        }
        let mut names: HashMap<String, BrowserName> = HashMap::new();
        for p in list.iter().filter(|p| !p.name.is_empty()) {
            if let Some(margin) = &p.margin {
                names.entry(margin.clone()).or_insert_with(|| BrowserName { name: p.name.clone() });
            }
        }
        let mut ids: Vec<String> = self.info.keys().cloned().collect();
        ids.sort();
        let mut changed = false;
        for id in ids {
            let Some(mut i) = self.info.get(&id).cloned() else { continue };
            let known = if i.browser_id.is_empty() { None } else { by_id.get(i.browser_id.as_str()).copied() };
            if !names.contains_key(&id)
                && let Some(k) = known.filter(|k| !k.name.is_empty())
            {
                names.insert(id.clone(), BrowserName { name: k.name.clone() });
            }
            if let Some(mapped) = list.iter().find(|p| p.margin.as_deref() == Some(id.as_str())).or(known) {
                if i.browser_id == mapped.server_id && i.browser_name == mapped.name {
                    continue;
                }
                i.browser_id = mapped.server_id.clone();
                i.browser_name = mapped.name.clone();
            } else if !i.browser_id.is_empty() {
                // Deleted in the browser: the last name it gave stays, as if typed.
                self.log.push(Note::note(format!(
                    "{}: profile “{}” ({}) is gone from the browser: {id} keeps {}",
                    self.browser,
                    i.browser_name,
                    i.browser_id,
                    if i.named { "its typed name" } else { "that name" }
                )));
                if !i.named && !i.browser_name.is_empty() {
                    i.name = prefix(&i.browser_name, KEPT_NAME_MAX);
                    i.named = true;
                }
                i.browser_id.clear();
                i.browser_name.clear();
            } else {
                continue;
            }
            self.info.insert(id, i);
            changed = true;
        }
        self.browser_names = names;
        changed
    }

    // ---- a profile under a new id (a signing change) ----

    /// A build signed by another team (or unsigned) is a new extension to Safari: each named profile's copy gets a
    /// new random id, so its spaces would start fresh while the old set sits beside them as a profile with no link.
    /// The browser's own id for the profile (`browser_id`, kept from an earlier read) ties the two: the set to carry
    /// to `new` is the one of a known profile Margin linked to the same browser profile that the last read maps `new`
    /// to, that has a set (`with_sets`: the browser's profiles with a set), and that isn't linked. Copies with the
    /// browser's own ids only (`s-<uuid>`), never the default profile's. With two such, the one linked last (the same:
    /// the first by id). `(old, browser_id)`; `None` with no read (no permission).
    pub fn carry_source(
        &self,
        new: &str,
        with_sets: &HashSet<String>,
        linked: &HashSet<String>,
    ) -> Option<(String, String)> {
        if !browser_own(new) {
            return None;
        }
        let list = self.browser_list.as_ref()?;
        let mapped = list.iter().find(|p| p.margin.as_deref() == Some(new))?;
        let current: HashSet<&str> = list.iter().filter_map(|p| p.margin.as_deref()).collect();
        self.info
            .iter()
            .filter(|(id, i)| {
                id.as_str() != new
                    && browser_own(id)
                    && i.browser_id == mapped.server_id
                    && !current.contains(id.as_str())
                    && !linked.contains(*id)
                    && with_sets.contains(*id)
            })
            .max_by(|a, b| a.1.last_seen.total_cmp(&b.1.last_seen).then_with(|| b.0.cmp(a.0)))
            .map(|(id, _)| (id.clone(), mapped.server_id.clone()))
    }

    /// Worth waiting for a read before a new copy's first set: the last read (there is one: the permission's given)
    /// doesn't map `new`, and a profile linked to the browser's before has a set and isn't linked. That one may still
    /// be mapped by the last read: Safari's plist may not say yet that its entry was removed. The hold ends as soon as
    /// a read maps `new`.
    pub fn might_carry(&self, new: &str, with_sets: &HashSet<String>, linked: &HashSet<String>) -> bool {
        if !browser_own(new) {
            return false;
        }
        let Some(list) = &self.browser_list else { return false };
        if list.iter().any(|p| p.margin.as_deref() == Some(new)) {
            return false;
        }
        self.info.iter().any(|(id, i)| {
            id.as_str() != new
                && browser_own(id)
                && !i.browser_id.is_empty()
                && !linked.contains(id)
                && with_sets.contains(id)
        })
    }

    /// `old`'s place taken by `new` (its set was carried over: `DataSync::carry`): its name, when it was first seen
    /// and its places in the order (the overlay's: its emoji and the color it was shown with too); matched to the
    /// browser's profiles again; `old` forgotten (its data set was put away). Its copy linking again later (a switch
    /// back) brings it back, and the set is carried back the same way.
    pub fn carry(&mut self, old: &str, new: &str) {
        if old == new {
            return;
        }
        let Some(o) = self.info.get(old).cloned() else { return };
        let shown_color = if !self.overlay || !o.color.is_empty() { o.color.clone() } else { self.color(old) };
        let mut n = self.info.get(new).cloned().unwrap_or_default();
        n.name = o.name.clone();
        n.named = o.named;
        if self.overlay {
            n.emoji = o.emoji.clone();
            n.color = shown_color;
        }
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
        self.associate();
        self.save();
        self.forget(old);
    }

    // ---- the order ----

    /// The profiles' spaces as their sets have them now (each profile's in its own order) and which profiles are
    /// linked: the order resolved, new profiles taken in (and matched to the browser's, if it's read), the linked ones
    /// seen now. Saved when anything lasting changed; true then.
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
        if changed {
            self.associate(); // a new profile linked to the browser's, if it's read
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

    /// The overlay's: a space moved one place along (`dir` < 0: back, else on) in the whole order: whether it moved,
    /// and the profile's own order afterwards if it changed (the app writes it into the set).
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

    fn rp(server: &str, name: &str, margin: Option<&str>) -> ReadProfile {
        ReadProfile { server_id: server.into(), name: name.into(), margin: margin.map(str::to_string) }
    }

    fn file(root: &Path, browser: &str) -> Object {
        super::super::store::object_at(&root.join(browser).join("browser.json")).unwrap_or_default()
    }

    fn write(root: &Path, browser: &str, o: &Object) {
        std::fs::write(root.join(browser).join("browser.json"), Value::Object(o.clone()).to_string()).expect("written");
    }

    fn lines(bp: &mut BrowserProfiles) -> Vec<String> {
        bp.take_log().into_iter().map(|n| n.text).collect()
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

    // profiles-tests.swift: the hosted file (the Mac's).
    #[test]
    fn the_hosted_file() {
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
        assert_eq!(
            names(bp.stored()),
            ["s-default/home", "s-default/work", "s-2/job", "s-3/fun"],
            "the new ones after"
        );
        bp.refresh(
            &spaces(&[("s-default", &["work", "home"]), ("s-2", &["job"]), ("s-3", &["fun"])]),
            &set(&["s-default", "s-2"]),
        );
        assert_eq!(
            names(bp.stored()),
            ["s-default/work", "s-default/home", "s-2/job", "s-3/fun"],
            "a profile's own reorder kept in its places"
        );
        let mut again = BrowserProfiles::new("safari", Some(root.path()));
        assert!(
            again.stored() == bp.stored() && again.name("s-2") == "Profile 2" && again.profiles() == bp.profiles(),
            "read back"
        );
        let written = file(root.path(), "safari");
        let infos = json::object(written.get("profiles")).cloned().unwrap_or_default();
        assert!(
            !written.contains_key("switching")
                && !infos.is_empty()
                && infos.values().all(|i| i.get("emoji").is_none() && i.get("color").is_none()),
            "no switch settings, no emoji or color: {written:?}"
        );
        assert_eq!(written.get("savedAt"), Some(&json!(1_000_010)), "savedAt a whole number, as Swift wrote it");

        // A file an earlier version wrote (a typed name, an emoji and color, the switch setting): read, the name kept,
        // and the rest never written again.
        let mut older = written.clone();
        older.insert("switching".into(), json!({ "closeWindows": true }));
        let mut profiles = infos.clone();
        if let Some(Value::Object(s2)) = profiles.get_mut("s-2") {
            s2.extend([
                ("name".to_string(), json!("Job")),
                ("named".to_string(), json!(true)),
                ("emoji".to_string(), json!("💼")),
                ("color".to_string(), json!("#00b894")),
            ]);
        }
        older.insert("profiles".into(), Value::Object(profiles));
        write(root.path(), "safari", &older);
        let mut typed = BrowserProfiles::new("safari", Some(root.path()));
        assert!(typed.name("s-2") == "Job" && typed.stored() == bp.stored() && typed.name("s-3") == "Profile 3");
        assert!(typed.info("s-2").is_some_and(|i| i.emoji.is_empty() && i.color.is_empty()) && !typed.close_windows());
        typed.save();
        let rewritten = file(root.path(), "safari");
        assert!(
            !rewritten.contains_key("switching")
                && rewritten["profiles"]["s-2"].get("emoji").is_none()
                && rewritten["profiles"]["s-2"].get("color").is_none()
                && rewritten["profiles"]["s-2"]["name"] == "Job",
            "an earlier version's emoji, color and switching dropped: {rewritten:?}"
        );

        // forget: marked once; its spaces out of the order at the next refresh while it isn't linked, back after.
        assert!(again.forget("s-3") && again.info("s-3").is_some_and(|i| i.hidden) && !again.forget("s-3"));
        assert!(again.stored().contains(&k("s-3", "fun")), "the Mac's order: out only at the next refresh");
        again.refresh(
            &spaces(&[("s-default", &["work", "home"]), ("s-2", &["job"]), ("s-3", &["fun"])]),
            &set(&["s-default"]),
        );
        assert!(!again.stored().iter().any(|k| k.profile == "s-3"), "out while it isn't linked");
        again.refresh(
            &spaces(&[("s-default", &["work", "home"]), ("s-2", &["job"]), ("s-3", &["fun"])]),
            &set(&["s-default", "s-3"]),
        );
        assert!(
            again.stored().contains(&k("s-3", "fun")) && again.info("s-3").is_some_and(|i| !i.hidden),
            "back once its copy links"
        );
        assert!(BrowserProfiles::new("safari", None).stored().is_empty(), "in memory: nothing read");
    }

    #[test]
    fn a_stored_one_is_true() {
        let root = temp();
        let mut bp = BrowserProfiles::new("safari", Some(root.path()));
        bp.refresh(&spaces(&[("s-a", &["a"]), ("s-b", &["b"]), ("s-c", &["c"])]), &set(&[]));
        let mut o = file(root.path(), "safari");
        let mut profiles = json::object(o.get("profiles")).cloned().unwrap_or_default();
        for (id, named, hidden) in
            [("s-a", json!(1), json!(1)), ("s-b", json!(0), json!(1.0)), ("s-c", json!(2), json!("1"))]
        {
            if let Some(Value::Object(i)) = profiles.get_mut(id) {
                i.insert("name".into(), json!(format!("Named {id}")));
                i.insert("named".into(), named);
                i.insert("hidden".into(), hidden);
            }
        }
        o.insert("profiles".into(), Value::Object(profiles));
        write(root.path(), "safari", &o);
        let again = BrowserProfiles::new("safari", Some(root.path()));
        let flags = |id: &str| again.info(id).map(|i| (i.named, i.hidden));
        assert_eq!(flags("s-a"), Some((true, true)), "1: true, as Swift's as? Bool");
        assert_eq!(flags("s-b"), Some((false, true)), "0 false, 1.0 true");
        assert_eq!(flags("s-c"), Some((false, false)), "2 and \"1\" aren't a bool");
        assert_eq!((again.name("s-a"), again.name("s-c")), ("Named s-a".into(), "Profile 3".into()));
    }

    #[test]
    fn seen_hourly_and_the_backup() {
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
        let again = BrowserProfiles::new("chrome", Some(root.path()));
        assert!(again.info("p-1").is_some_and(|i| i.last_seen == SEEN_EVERY_MS + 1001.0), "read back");
        // A later format's file: not read.
        std::fs::write(root.path().join("chrome/browser.json"), r#"{"format":2,"order":[["p-1","a"]]}"#)
            .expect("written");
        assert!(BrowserProfiles::new("chrome", Some(root.path())).stored().is_empty());
        // A damaged file: its backup read (kept as Rust had it: Swift read the backup only when the file didn't read).
        std::fs::write(root.path().join("chrome/browser.json"), "{").expect("written");
        assert_eq!(BrowserProfiles::new("chrome", Some(root.path())).stored(), [k("p-1", "a")]);
        // A save that can't be written: said.
        let blocked = temp();
        std::fs::write(blocked.path().join("chrome"), "a file where the folder goes").expect("written");
        let mut b = BrowserProfiles::new("chrome", Some(blocked.path()));
        b.save();
        assert!(b.take_log().iter().any(|n| n.warn && n.text.starts_with("chrome: browser.json not saved: ")));
    }

    // safari-profiles-tests.swift "the names used".
    #[test]
    fn the_browsers_names() {
        let root = temp();
        let (personal, test) = ("s-1personal", "s-test"); // (s-1personal seen before s-9, as a uuid can be)
        BrowserProfiles::new("safari", Some(root.path())).refresh(
            &spaces(&[("s-default", &["a"]), (personal, &["b"]), ("s-9", &["c"])]),
            &set(&["s-default", personal]),
        );
        // A name typed in an earlier version's Edit Profile (nothing types one now): as its browser.json has it.
        let mut o = file(root.path(), "safari");
        if let Some(Value::Object(p)) = o.get_mut("profiles").and_then(|p| p.get_mut(personal)) {
            p.insert("name".into(), json!("Typed"));
            p.insert("named".into(), json!(true));
        }
        write(root.path(), "safari", &o);
        let mut bp = BrowserProfiles::new("safari", Some(root.path()));
        assert_eq!(bp.name(personal), "Typed", "a typed one read from the file");
        let list = vec![
            rp("DefaultProfile", "Work", Some("s-default")),
            rp("PERSONAL", "Personal", Some(personal)),
            rp("TEST", "Test", Some(test)),
        ];
        assert!(bp.browser_read().is_none());
        assert!(bp.use_browser_names(list.clone()), "Safari's read: changed");
        assert_eq!(bp.browser_read(), Some(list.as_slice()));
        assert!(bp.name("s-default") == "Work" && bp.name(personal) == "Personal", "Safari's win over a typed one");
        assert_eq!(bp.name("s-9"), "Profile 3", "a profile Safari doesn't name keeps Margin's");
        assert!(!bp.use_browser_names(list.clone()), "the same again: nothing changed");
        assert!(bp.info(personal).is_some_and(|i| i.name == "Typed"), "the typed name is kept for later");
        assert!(
            bp.browser_names().get(personal).is_some_and(|b| b.name == "Personal")
                && !bp.browser_names().contains_key("s-9"),
            "Safari's own, for the profiles it names only"
        );
        bp.refresh(
            &spaces(&[("s-default", &["a"]), (personal, &["b"]), ("s-9", &["c"]), (test, &["d"])]),
            &set(&["s-default", personal, test]),
        );
        assert!(
            bp.name(test) == "Test" && bp.info(test).is_some_and(|i| i.browser_id == "TEST"),
            "a profile seen after the read gets Safari's name at once"
        );
        let reloaded = BrowserProfiles::new("safari", Some(root.path()));
        assert!(
            reloaded.info(personal).is_some_and(|i| i.browser_id == "PERSONAL" && i.browser_name == "Personal"),
            "Safari's ids kept in browser.json"
        );
        assert_eq!(reloaded.name(personal), "Typed", "never Safari's name as the typed one");
        // The copy's entry unreadable this time (Margin turned off there): the profile still has its name, by Safari's id.
        let mut no_entry = list.clone();
        no_entry[1].margin = None;
        bp.use_browser_names(no_entry);
        assert_eq!(bp.name(personal), "Personal", "known by Safari's id when the copy's entry is missing");
        let renamed: Vec<ReadProfile> = list
            .iter()
            .map(|p| if p.margin.as_deref() == Some(test) { rp("TEST", "Testing", Some(test)) } else { p.clone() })
            .collect();
        assert!(bp.use_browser_names(renamed) && bp.name(test) == "Testing", "renamed in Safari");
        assert!(bp.drop_browser_names() && bp.browser_read().is_none(), "no permission: changed");
        assert!(
            bp.name(personal) == "Typed" && bp.name("s-default") == "Default" && bp.name(test) == "Profile 4",
            "no permission: typed and default names"
        );
        assert!(!bp.drop_browser_names(), "dropped twice: nothing changed");
        bp.use_browser_names(list.clone());
        bp.take_log();
        // Deleted in Safari: the last name it gave stays (as typed); a typed one stays.
        let gone: Vec<ReadProfile> = list
            .iter()
            .filter(|p| p.margin.as_deref() != Some(test) && p.margin.as_deref() != Some(personal))
            .cloned()
            .collect();
        assert!(bp.use_browser_names(gone), "deleted in Safari: changed");
        assert!(
            bp.name(test) == "Test" && bp.info(test).is_some_and(|i| i.named && i.browser_id.is_empty()),
            "deleted in Safari: its last name kept"
        );
        assert_eq!(bp.name(personal), "Typed", "deleted in Safari, a name typed before: that name");
        let said = lines(&mut bp);
        assert!(
            said.contains(
                &"safari: profile “Test” (TEST) is gone from the browser: s-test keeps that name".to_string()
            ) && said.contains(
                &"safari: profile “Personal” (PERSONAL) is gone from the browser: s-1personal keeps its typed name"
                    .to_string()
            ),
            "{said:?}"
        );
        assert_eq!(BrowserProfiles::new("safari", Some(root.path())).name(test), "Test", "and saved");
    }

    #[test]
    fn a_deleted_profiles_name_kept_at_most_40_characters() {
        let mut bp = BrowserProfiles::new("safari", None);
        bp.refresh(&spaces(&[("s-long", &["a"]), ("s-none", &["b"])]), &set(&["s-long", "s-none"]));
        let long = format!("{}é{}", "n".repeat(38), "x".repeat(20)); // 59 characters
        bp.use_browser_names(vec![rp("LONG", &long, Some("s-long")), rp("NONE", "", Some("s-none"))]);
        assert_eq!(bp.name("s-long"), long, "shown whole while Safari has it");
        assert_eq!(bp.name("s-none"), "Profile 2", "an empty name from Safari: not a name");
        assert!(bp.info("s-none").is_some_and(|i| i.browser_id == "NONE"), "but linked");
        bp.use_browser_names(Vec::new());
        let kept = bp.info("s-long").map(|i| i.name.clone()).unwrap_or_default();
        assert_eq!(kept.chars().count(), 40, "{kept}");
        assert_eq!(kept, format!("{}é{}", "n".repeat(38), "x"), "the first 40 characters, as typed");
        assert_eq!(bp.name("s-long"), kept);
        assert!(
            bp.info("s-none").is_some_and(|i| !i.named && i.browser_id.is_empty()) && bp.name("s-none") == "Profile 2",
            "deleted with no name: no typed name made"
        );
    }

    // safari-profiles-tests.swift "Linked copies no profile maps to".
    #[test]
    fn copies_no_profile_maps_said_once() {
        let mut bp = BrowserProfiles::new("safari", None);
        let (sa, sb) = ("s-aaaa", "s-bbbb");
        assert!(bp.check_mapped(&set(&[sa, sb, "s-default"])).is_empty() && lines(&mut bp).is_empty(), "no read yet");
        let read1 = vec![rp("DefaultProfile", "Work", Some("s-default")), rp("P", "Personal", Some(sb))];
        bp.use_browser_names(read1.clone());
        assert_eq!(
            bp.check_mapped(&set(&[sa, sb, "s-default", "p-own"])),
            [sa],
            "after a read, the copy no profile has"
        );
        assert_eq!(
            lines(&mut bp),
            ["safari: copy s-aaaa isn't any Safari profile's as read (2 profiles, copies s-bbbb, s-default)"]
        );
        assert!(bp.check_mapped(&set(&[sa, sb])).is_empty(), "once");
        bp.drop_browser_names();
        assert!(bp.check_mapped(&set(&["s-cccc"])).is_empty(), "no permission any more: nothing");
        bp.use_browser_names(vec![rp("DefaultProfile", "Work", Some("s-default")), rp("P", "Personal", Some(sa))]);
        assert!(bp.check_mapped(&set(&[sa])).is_empty(), "a read that maps it: nothing said");
        bp.use_browser_names(read1);
        assert_eq!(bp.check_mapped(&set(&[sa])), [sa], "mapped by a read, then not again: said again");
        assert!(lines(&mut bp).iter().all(|l| !l.contains("Personal") && !l.contains("Work")), "ids only");
        let both = bp.check_mapped(&set(&["s-zz", "s-yy"]));
        assert_eq!(both, ["s-yy", "s-zz"], "in id order");
    }

    // safari-profiles-tests.swift "a signing change: the same Safari profile under a new id".
    #[test]
    fn carried_over_after_a_signing_change() {
        let (old, new) = ("s-old", "s-new");
        let mut cp = BrowserProfiles::new("safari", None);
        cp.refresh(&spaces(&[("s-default", &["w"]), (old, &["a1", "a2"])]), &set(&["s-default", old]));
        let before = vec![rp("DefaultProfile", "Work", Some("s-default")), rp("PERSONAL", "Personal", Some(old))];
        let with_old = set(&[old]);
        let none = set(&[]);
        assert!(
            cp.carry_source(new, &with_old, &set(&[new])).is_none() && !cp.might_carry(new, &with_old, &set(&[new])),
            "before any read: none, and no hold"
        );
        cp.use_browser_names(before.clone());
        assert!(cp.info(old).is_some_and(|i| i.browser_id == "PERSONAL"), "the old id linked to Safari's profile");
        // might_carry: (new, with sets, linked) → worth a hold.
        for (new_id, sets, linked, want, why) in [
            (new, &with_old, set(&[new, "s-default"]), true, "a new copy no read maps yet"),
            (new, &with_old, set(&[new, old]), false, "not while the old one is linked"),
            (new, &none, set(&[new]), false, "nor with no set to carry"),
            ("s-default", &with_old, set(&[]), false, "never for the default profile's copy"),
            ("p-chrome", &with_old, set(&[]), false, "nor a copy without the browser's id"),
            (old, &with_old, set(&[]), false, "a copy the read maps: no hold"),
        ] {
            assert_eq!(cp.might_carry(new_id, sets, &linked), want, "might carry: {why}");
        }
        assert!(cp.carry_source("s-default", &with_old, &set(&[])).is_none(), "never for the default profile's copy");
        assert!(cp.carry_source(new, &with_old, &set(&[new])).is_none(), "the read doesn't map the new one: none yet");
        let after: Vec<ReadProfile> = before
            .iter()
            .map(|p| if p.margin.as_deref() == Some(old) { rp("PERSONAL", "Personal", Some(new)) } else { p.clone() })
            .collect();
        cp.use_browser_names(after.clone());
        assert!(
            cp.browser_names().get(old).is_some_and(|b| b.name == "Personal")
                && cp.browser_names().get(new).is_some_and(|b| b.name == "Personal"),
            "historical copies keep their names for carry-over"
        );
        // carry_source: (with sets, linked) → the source.
        let source = Some((old.to_string(), "PERSONAL".to_string()));
        for (sets, linked, want, why) in [
            (&with_old, set(&[new, "s-default"]), source.clone(), "the read maps Safari's profile to the new id"),
            (&with_old, set(&[new, old]), None, "not if the old one is linked again"),
            (&none, set(&[new]), None, "not with no set"),
        ] {
            assert_eq!(cp.carry_source(new, sets, &linked), want, "carry source: {why}");
        }
        assert!(!cp.might_carry(new, &with_old, &set(&[new])), "no hold once the read maps it");
        // Two old ids of the same Safari profile with sets: the one linked last; the same: the first by id.
        let mut two = BrowserProfiles::new("safari", None);
        two.now = Box::new(|| 1000.0);
        two.refresh(&spaces(&[("s-o1", &["a"])]), &set(&["s-o1"]));
        two.now = Box::new(|| 2000.0);
        two.refresh(&spaces(&[("s-o2", &["b"])]), &set(&["s-o2"]));
        two.use_browser_names(vec![rp("P", "Personal", Some("s-o1"))]);
        two.use_browser_names(vec![rp("P", "Personal", Some("s-o2"))]);
        two.use_browser_names(vec![rp("P", "Personal", Some("s-n"))]);
        let sets = set(&["s-o1", "s-o2"]);
        assert_eq!(two.carry_source("s-n", &sets, &set(&["s-n"])).map(|s| s.0), Some("s-o2".into()), "linked last");
        two.now = Box::new(|| 2000.0);
        two.refresh(&HashMap::new(), &set(&["s-o1"]));
        two.refresh(&HashMap::new(), &set(&["s-o2"]));
        assert_eq!(two.carry_source("s-n", &sets, &set(&["s-n"])).map(|s| s.0), Some("s-o1".into()), "a tie: by id");

        cp.refresh(&spaces(&[("s-default", &["w"]), (old, &["a1", "a2"]), (new, &["n1"])]), &set(&["s-default", new]));
        let order_before: Vec<SpaceKey> = cp
            .stored()
            .iter()
            .filter(|k| k.profile != new)
            .map(|k| if k.profile == old { SpaceKey::new(new, k.space.as_str()) } else { k.clone() })
            .collect();
        let first_seen = cp.info(old).map(|i| i.first_seen);
        cp.carry(old, new);
        cp.refresh(&spaces(&[("s-default", &["w"]), (new, &["a1", "a2"])]), &set(&["s-default", new]));
        assert!(
            cp.name(new) == "Personal" && cp.info(new).map(|i| i.first_seen) == first_seen,
            "the old profile's name and first sight go with it"
        );
        assert!(
            cp.info(old).is_some_and(|i| i.hidden) && cp.stored() == order_before && order_before.len() == 3,
            "the old one forgotten, its places in the order the new one's: {:?}",
            cp.stored()
        );
        let shown: Vec<String> = cp
            .profiles()
            .into_iter()
            .filter(|p| cp.info(p).is_some_and(|i| !i.hidden) && cp.name(p) == "Personal")
            .collect();
        assert_eq!(shown, [new], "one Personal shown");
        cp.drop_browser_names();
        assert!(
            cp.carry_source(new, &with_old, &set(&[new])).is_none() && !cp.might_carry(old, &set(&[new]), &set(&[old])),
            "no read (no permission): none"
        );
        let saves = cp.saves();
        cp.carry("s-x", "s-y");
        cp.carry(new, new);
        assert_eq!(cp.saves(), saves, "an unknown or the same: nothing");
    }

    #[test]
    fn a_carry_matches_the_browsers_profiles_again() {
        // The new id has no link of its own yet; the carry gives it the old one's, and the read's names follow.
        let mut bp = BrowserProfiles::new("safari", None);
        bp.refresh(&spaces(&[("s-old", &["a"])]), &set(&["s-old"]));
        bp.use_browser_names(vec![rp("P", "Personal", Some("s-old"))]);
        bp.use_browser_names(vec![rp("P", "Personal", None)]);
        bp.carry("s-old", "s-new");
        assert!(bp.info("s-new").is_some_and(|i| i.browser_id == "P") && bp.name("s-new") == "Personal");
    }

    // The overlay's file (the Windows shell's old design): emoji, color and switching kept.
    #[test]
    fn the_overlay_file() {
        let root = temp();
        let mut bp = BrowserProfiles::overlay("safari", Some(root.path()));
        assert!(bp.is_overlay() && !BrowserProfiles::new("safari", None).is_overlay());
        bp.refresh(&spaces(&[("s-default", &["home", "work"])]), &set(&["s-default"]));
        bp.refresh(
            &spaces(&[("s-default", &["home", "work"]), ("s-2", &["job"]), ("s-3", &["fun"])]),
            &set(&["s-default", "s-2"]),
        );
        assert!(
            bp.color("s-default") != bp.color("s-2") && bp.color("s-2").starts_with('#'),
            "colors until chosen, one each"
        );
        assert_eq!(bp.color("s-default"), COLORS[0]);
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
        assert_eq!(swapped2.1, Some(vec!["work".to_string(), "home".to_string()]), "past its own: its order back");
        assert!(
            !bp.move_space(&k("s-3", "fun"), 1).0 && !bp.move_space(&k("s-default", "work"), -1).0,
            "not past the ends"
        );
        assert!(!bp.move_space(&k("s-3", "nope"), 1).0);
        assert!(!bp.close_windows() && bp.set_close_windows(true) && !bp.set_close_windows(true));

        let mut again = BrowserProfiles::overlay("safari", Some(root.path()));
        assert!(
            again.order() == bp.order()
                && again.name("s-2") == "Job"
                && again.color("s-2") == "#abc"
                && again.info("s-2").is_some_and(|i| i.emoji.is_empty())
                && again.close_windows()
                && again.profiles() == bp.profiles(),
            "read back"
        );
        let written = file(root.path(), "safari");
        assert!(written["switching"]["closeWindows"] == true && written["profiles"]["s-2"]["color"] == "#abc");
        assert!(
            again.forget("s-3") && !again.order().iter().any(|k| k.profile == "s-3") && !again.forget("s-3"),
            "forget: the overlay's order drops its spaces at once"
        );
        // The hosted shape reads the same file without them.
        let hosted = BrowserProfiles::new("safari", Some(root.path()));
        assert!(!hosted.close_windows() && hosted.info("s-2").is_some_and(|i| i.color.is_empty()));
        // A damaged file: its backup (the version before the last save).
        std::fs::write(root.path().join("safari/browser.json"), "{").expect("written");
        let from_bak = BrowserProfiles::overlay("safari", Some(root.path()));
        assert!(from_bak.close_windows() && from_bak.info("s-3").is_some_and(|i| !i.hidden));
    }

    #[test]
    fn the_overlays_carry() {
        let mut bp = BrowserProfiles::overlay("safari", None);
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
        let mut hosted = BrowserProfiles::new("safari", None);
        hosted.refresh(&spaces(&[("s-a", &["a1"])]), &set(&["s-a"]));
        hosted.carry("s-a", "s-b");
        assert!(hosted.info("s-b").is_some_and(|i| i.color.is_empty() && i.emoji.is_empty()), "the Mac's: no color");
    }

    #[test]
    fn read_profiles_as_json() {
        let o = json!({ "serverId": "S", "name": "N", "margin": "s-x", "uuid": "U", "symbol": "person" });
        let p = ReadProfile::from_json(o.as_object().expect("an object"));
        assert_eq!(p, rp("S", "N", Some("s-x")));
        assert_eq!(p.to_json(), json!({ "serverId": "S", "name": "N", "margin": "s-x" }));
        let none = ReadProfile::from_json(json!({ "serverId": "S", "margin": null }).as_object().expect("an object"));
        assert_eq!(none, rp("S", "", None));
    }
}
