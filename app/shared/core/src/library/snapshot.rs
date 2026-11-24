//! What the UI draws (docs/CORE-REFACTOR.md step 4 parts 2 and 6): library.ts's `snapshot` (LT:839-852) as the text
//! `JSON.stringify` makes of it, written straight from the typed state (no JSON value built): the stored State shape
//! app/shared/ui's `fromStorage` reads (host-app.ts:430), the spaces, pins, favorites, link rules, splits, folders and
//! archive as `stateOf` made them, the items as kept tabs (`openTabs.keptTabs`) with their targets, no open tabs (the
//! session adds the ones it has), and `library: { v, imported }`.
//!
//! The text is JS's: the same keys in the same order (each record's as `stateOf` builds it, a key whose value is
//! missing left out), JSON.stringify's string escapes, and every number as `String(n)` writes it (`5`, `0.5`, `1e+21`;
//! `null` for one that isn't finite). Built once per revision of the set (part 6's `Cached`); [`write_item`] is one
//! kept tab's object, for the per-draw composition (commit 7) to cache.

use std::fmt::Write as _;

use super::js::{self, LocaleCompare};
use super::state::{
    ArchiveEntry, FORMAT, Favorite, Folder, Item, LibState, LibTarget, Pin, Rule, Space, Split, Values, is_imported,
    state_of,
};

/// LT:839 `JSON.stringify(snapshot(values))`.
pub fn snapshot<V: Values + ?Sized>(values: &V, compare: &dyn LocaleCompare) -> String {
    snapshot_text(&state_of(values, compare), is_imported(values))
}

/// The snapshot's text of a state `state_of` made, `imported` the import's marker (`isObject(values.imports.done)`).
pub fn snapshot_text(s: &LibState, imported: bool) -> String {
    let mut out = String::with_capacity(estimate(s));
    out.push_str("{\"library\":{\"v\":");
    let _ = write!(out, "{FORMAT}");
    out.push_str(",\"imported\":");
    out.push_str(if imported { "true" } else { "false" });
    out.push_str("},\"spaces\":");
    list(&mut out, &s.spaces, write_space);
    out.push_str(",\"pins\":");
    list(&mut out, &s.pins, write_pin);
    out.push_str(",\"favorites\":");
    list(&mut out, &s.favorites, write_favorite);
    out.push_str(",\"airTraffic\":");
    list(&mut out, &s.air_traffic, write_rule);
    out.push_str(",\"splits\":");
    list(&mut out, &s.splits, write_split);
    out.push_str(",\"folders\":");
    list(&mut out, &s.folders, write_folder);
    out.push_str(",\"archive\":");
    list(&mut out, &s.archive, write_archive);
    out.push_str(
        ",\"openTabs\":{\"origin\":\"margin-app\",\"since\":0,\"synced\":true,\"tabs\":{},\"tabSpace\":{},\"activeSpaceByWindow\":{",
    );
    for (i, (w, space_id)) in s.windows.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_str(&mut out, w);
        out.push(':');
        write_str(&mut out, space_id);
    }
    out.push_str("},\"awayByWindow\":{},\"keptTabs\":{");
    for (i, (id, k)) in s.kept.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_str(&mut out, id);
        out.push(':');
        write_item(&mut out, k);
    }
    out.push_str("}}}");
    out
}

/// About the text's length, so it's written into one allocation (the icons are most of it).
fn estimate(s: &LibState) -> usize {
    let kept: usize = s.kept.values().map(|k| 300 + k.url.len() + k.title.len() + k.fav_icon_url.len()).sum();
    let archive: usize = s.archive.iter().map(|a| 250 + a.url.len() + a.title.len() + a.fav_icon_url.len()).sum();
    512 + kept + archive + 200 * (s.spaces.len() + s.pins.len() + s.favorites.len() + s.folders.len() + s.splits.len())
}

fn list<T>(out: &mut String, items: &[std::rc::Rc<T>], each: fn(&mut String, &T)) {
    out.push('[');
    for (i, x) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        each(out, x);
    }
    out.push(']');
}

/// A JSON object written key by key, each key once, in the order given.
struct Obj<'a> {
    out: &'a mut String,
    first: bool,
}

impl<'a> Obj<'a> {
    fn new(out: &'a mut String) -> Obj<'a> {
        out.push('{');
        Obj { out, first: true }
    }

    fn key(&mut self, key: &str) -> &mut String {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        self.out.push('"');
        self.out.push_str(key); // (the keys are the shape's own: plain ASCII)
        self.out.push_str("\":");
        self.out
    }

    fn str(&mut self, key: &str, v: &str) -> &mut Self {
        write_str(self.key(key), v);
        self
    }

    fn opt_str(&mut self, key: &str, v: Option<&str>) -> &mut Self {
        if let Some(v) = v {
            self.str(key, v);
        }
        self
    }

    fn str_or_null(&mut self, key: &str, v: Option<&str>) -> &mut Self {
        match v {
            Some(v) => write_str(self.key(key), v),
            None => self.key(key).push_str("null"),
        }
        self
    }

    fn num(&mut self, key: &str, n: f64) -> &mut Self {
        write_num(self.key(key), n);
        self
    }

    fn opt_num(&mut self, key: &str, n: Option<f64>) -> &mut Self {
        if let Some(n) = n {
            self.num(key, n);
        }
        self
    }

    fn bool(&mut self, key: &str, b: bool) -> &mut Self {
        self.key(key).push_str(if b { "true" } else { "false" });
        self
    }

    fn target(&mut self, key: &str, t: Option<&LibTarget>) -> &mut Self {
        if let Some(t) = t {
            write_target(self.key(key), t);
        }
        self
    }

    fn end(&mut self) {
        self.out.push('}');
    }
}

/// LT:90: `{ id, name, emoji, color, browser, profile, theme? }`.
fn write_space(out: &mut String, s: &Space) {
    Obj::new(out)
        .str("id", &s.id)
        .str("name", &s.name)
        .str("emoji", &s.emoji)
        .str("color", &s.color)
        .str("browser", &s.browser)
        .str_or_null("profile", s.profile.as_deref())
        .opt_str("theme", s.theme.as_deref())
        .end();
}

/// LT:92: `{ id, spaceId, url, title, customTitle?, folderId?, pos, target }`.
fn write_pin(out: &mut String, p: &Pin) {
    Obj::new(out)
        .str("id", &p.id)
        .str("spaceId", &p.space_id)
        .str("url", &p.url)
        .str("title", &p.title)
        .opt_str("customTitle", p.custom_title.as_deref())
        .opt_str("folderId", p.folder_id.as_deref())
        .opt_num("pos", p.pos)
        .target("target", p.target.as_ref())
        .end();
}

/// LT:94: `{ id, scope, url, title, customTitle?, pos, target }`.
fn write_favorite(out: &mut String, f: &Favorite) {
    Obj::new(out)
        .str("id", &f.id)
        .str("scope", &f.scope)
        .str("url", &f.url)
        .str("title", &f.title)
        .opt_str("customTitle", f.custom_title.as_deref())
        .opt_num("pos", f.pos)
        .target("target", f.target.as_ref())
        .end();
}

/// LT:97: `{ id, pattern, spaceId, enabled, order }`.
fn write_rule(out: &mut String, r: &Rule) {
    Obj::new(out)
        .str("id", &r.id)
        .str("pattern", &r.pattern)
        .str("spaceId", &r.space_id)
        .bool("enabled", r.enabled)
        .opt_num("order", r.order)
        .end();
}

/// LT:107-114: `{ id, spaceId, axis, panes, ratios, pinned?, folderId?, pos? }`.
fn write_split(out: &mut String, g: &Split) {
    let mut o = Obj::new(out);
    o.str("id", &g.id).str("spaceId", &g.space_id).str("axis", g.axis.as_str());
    let panes = o.key("panes");
    panes.push('[');
    for (i, p) in g.panes.iter().enumerate() {
        if i > 0 {
            panes.push(',');
        }
        write_str(panes, p);
    }
    panes.push(']');
    let ratios = o.key("ratios");
    ratios.push('[');
    for (i, r) in g.ratios.iter().enumerate() {
        if i > 0 {
            ratios.push(',');
        }
        write_num(ratios, *r);
    }
    ratios.push(']');
    if g.pinned {
        o.bool("pinned", true);
    }
    o.opt_str("folderId", g.folder_id.as_deref()).opt_num("pos", g.pos).end();
}

/// LT:117: `{ id, spaceId, name, open, pos, parentId? }`.
fn write_folder(out: &mut String, f: &Folder) {
    Obj::new(out)
        .str("id", &f.id)
        .str("spaceId", &f.space_id)
        .str("name", &f.name)
        .bool("open", f.open)
        .opt_num("pos", f.pos)
        .opt_str("parentId", f.parent_id.as_deref())
        .end();
}

/// LT:120: `{ id, url, title, spaceId, favIconUrl, closedAt, target }`.
fn write_archive(out: &mut String, a: &ArchiveEntry) {
    Obj::new(out)
        .str("id", &a.id)
        .str("url", &a.url)
        .str("title", &a.title)
        .str("spaceId", &a.space_id)
        .str("favIconUrl", &a.fav_icon_url)
        .num("closedAt", a.closed_at)
        .target("target", a.target.as_ref())
        .end();
}

/// One kept tab (LT:124-133): `{ id, url, title, favIconUrl, spaceId, order, lastActive, wasActive, keptAt, why,
/// target, pinnedBy?, favoriteId?, customTitle?, imported? }`.
pub fn write_item(out: &mut String, k: &Item) {
    let mut o = Obj::new(out);
    o.str("id", &k.id)
        .str("url", &k.url)
        .str("title", &k.title)
        .str("favIconUrl", &k.fav_icon_url)
        .str("spaceId", &k.space_id)
        .num("order", k.order)
        .num("lastActive", k.last_active)
        .bool("wasActive", k.was_active)
        .num("keptAt", k.kept_at)
        .str("why", &k.why)
        .target("target", Some(&k.target))
        .opt_str("pinnedBy", k.pinned_by.as_deref())
        .opt_str("favoriteId", k.favorite_id.as_deref())
        .opt_str("customTitle", k.custom_title.as_deref());
    if let Some(i) = &k.imported {
        Obj::new(o.key("imported")).str("browser", &i.browser).str("profile", &i.profile).str("id", &i.id).end();
    }
    o.end();
}

/// A target as JS writes the object `targetOf` made: `{ kind, browser, profile }`, `{ kind, bundleId, name }`,
/// `{ kind, page }`.
fn write_target(out: &mut String, t: &LibTarget) {
    let mut o = Obj::new(out);
    match t {
        LibTarget::Web { browser, profile } => {
            o.str("kind", "web").str("browser", browser).str_or_null("profile", profile.as_deref());
        }
        LibTarget::App { bundle_id, name } => {
            o.str("kind", "app").str("bundleId", bundle_id).str("name", name);
        }
        LibTarget::Margin { page } => {
            o.str("kind", "margin").str("page", page);
        }
    }
    o.end();
}

/// `JSON.stringify(n)`: `String(n)` for a finite number, `null` for NaN and ±∞.
fn write_num(out: &mut String, n: f64) {
    if n.is_finite() {
        out.push_str(&js::number_string(n));
    } else {
        out.push_str("null");
    }
}

/// `JSON.stringify(s)`: `"` and `\` escaped, `\b \f \n \r \t`, other controls below U+0020 as `\u00xx` (lowercase),
/// everything else as it is (DEL, U+2028/2029 and every non-ASCII character too).
pub fn write_str(out: &mut String, s: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    let bytes = s.as_bytes();
    // The usual string (an icon's base64, a title) has nothing to escape: one copy. (No early exit, so the check runs
    // a block at a time.)
    let plain =
        bytes.chunks(64).all(|c| !c.iter().fold(false, |any, &b| any | (b < 0x20) | (b == b'"') | (b == b'\\')));
    if plain {
        out.push_str(s);
        out.push('"');
        return;
    }
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let escaped: &str = match b {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            0x08 => "\\b",
            0x0c => "\\f",
            b'\n' => "\\n",
            b'\r' => "\\r",
            b'\t' => "\\t",
            0..=0x1f => "",
            _ => continue,
        };
        out.push_str(&s[start..i]);
        if escaped.is_empty() {
            out.push_str("\\u00");
            out.push(HEX[usize::from(b >> 4)] as char);
            out.push(HEX[usize::from(b & 15)] as char);
        } else {
            out.push_str(escaped);
        }
        start = i + 1;
    }
    out.push_str(&s[start..]);
    out.push('"');
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
