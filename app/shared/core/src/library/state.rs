//! The library's typed state (docs/CORE-REFACTOR.md step 4 part 2): library.ts's `stateOf` (LT:87-137), the model's
//! State as the library has it, read from the stored values once per revision of the set and kept. Its items are the
//! model's kept tabs (`keptTabs`, by their own `t-` ids); open tabs are the hosting's, never here (LT:136 `tabs: {}`),
//! so the model's open-tab halves have nothing to work on and aren't ported.
//!
//! Copies are cheap and JS's identity is kept: every collection is an `Rc` of a list of `Rc`s, every string an
//! `Rc<str>`. A rule that changes nothing hands back the state it was given (`LibState::same`: the TS's `next === s`,
//! LT:532, 601, 791); a rule that changes one pin makes a new pins list (`Rc::make_mut`) holding the other pins as
//! they were (`Rc::ptr_eq`: the TS's `p === state.pins[i]`, M:1130), as the TS's spreads do.
//!
//! Absent and null: a field M may leave out of an object it makes (a pin's `pos` before `writeOrder` numbers it,
//! M:1265; a favorite's `target`, M:1504) is an `Option`, so `valuesOf`'s fallbacks (`finite(p.pos, i)`, `targetOf(…) ??
//! webTarget(…)`) see what JS sees. `None` stands for both a missing key and `null` where `valuesOf` reads them alike
//! (`??`, `finite`); the snapshot (always from `state_of`, which never makes a `null` but a space's `profile` and a web
//! target's) omits `None`, as `JSON.stringify` omits `undefined`.

use std::cmp::Ordering;
use std::rc::Rc;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::js::{self, LocaleCompare};
use crate::data::set::DataSet;

/// A string of the state: shared, so a copy of the state (or of an item, `{ ...k, order }`) copies no text.
pub type Str = Rc<str>;
/// A collection of the state (`State['pins']`…): shared, its elements shared (JS's object identity).
pub type List<T> = Rc<Vec<Rc<T>>>;

/// The browsers a web target or a space can be of (LT:39 `BROWSERS`); anything else is Safari's.
pub const BROWSERS: [&str; 3] = ["safari", "chrome", "edge"];
/// Margin's own pages and the title each item of one has (LT:41 `MARGIN_PAGES`).
pub const MARGIN_PAGES: [(&str, &str); 1] = [("settings", "Settings")];
/// The snapshot's `library.v` (LT:25 `FORMAT`).
pub const FORMAT: u32 = 1;
/// `str(v)`'s default cut (LT:43): titles, addresses given by an action.
pub const TEXT_MAX: usize = 2000;
/// An item's or archive entry's icon (LT:120, 127: `str(…, 100_000)`, inline `data:` text).
pub const ICON_MAX: usize = 100_000;

// ---- library.ts's small readers ------------------------------------------------------------------------------------

/// LT:43 `str(v, max)`: a string cut at `max` UTF-16 units, else empty.
#[inline]
pub fn str_of(v: Option<&Value>, max: usize) -> &str {
    v.and_then(Value::as_str).map_or("", |s| js::slice16(s, max))
}

/// LT:43 `str(v, max)` for a value that's a string and not empty (`typeof v === 'string' && v`), cut.
#[inline]
fn some_text(v: Option<&Value>, max: usize) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| js::slice16(s, max))
}

/// `typeof v === 'string' && v ? v : …`: a string that isn't empty, as it is.
#[inline]
fn some_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// M:1111 `themeIdOk`: `/^[a-z0-9][a-z0-9-]{0,40}$/`.
pub fn theme_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 41
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// M:165 `isTabId`: `/^t-[A-Za-z0-9]{1,30}$/`, a Margin tab's (an item's) id.
pub fn is_tab_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b.len() <= 32 && b.starts_with(b"t-") && b[2..].iter().all(u8::is_ascii_alphanumeric)
}

/// LT:42 `BUNDLE_ID`: `/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/`.
fn bundle_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 255
        && b[0].is_ascii_alphanumeric()
        && b[1..].iter().all(|&c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
}

/// `MARGIN_PAGES[page]` (`Object.hasOwn` first, LT:56): the page's title, `None` for a page Margin doesn't have.
pub fn margin_page_title(page: &str) -> Option<&'static str> {
    MARGIN_PAGES.iter().find(|(p, _)| *p == page).map(|(_, title)| *title)
}

/// LT:66 `appUrl`: an app item's address (never a web page's: never archived).
pub fn app_url(bundle_id: &str) -> String {
    format!("app://{bundle_id}")
}

/// LT:68 `marginUrl`: a Margin page's address.
pub fn margin_url(page: &str) -> String {
    format!("margin://{page}")
}

// ---- targets -------------------------------------------------------------------------------------------------------

/// What an item, pin, favorite or archive entry is shown in (LT:27-30 `Target`): a browser's profile, a Mac app, or one
/// of Margin's own pages. The library's rule, the writer's; the session's `session/target.rs` `Target::read` is
/// ItemTarget's lenient reader of what this wrote (L:32-47), a second rule kept on purpose (it reads only values the
/// library normalised).
#[derive(Clone, Debug, PartialEq)]
pub enum LibTarget {
    Web { browser: Str, profile: Option<Str> },
    App { bundle_id: Str, name: Str },
    Margin { page: Str },
}

impl LibTarget {
    /// LT:65 `webTarget(browser, profile)`.
    pub fn web(browser: &str, profile: Option<&str>) -> LibTarget {
        LibTarget::Web { browser: browser.into(), profile: profile.map(Str::from) }
    }

    /// `webTarget('safari', null)`: every fallback's (LT:92-127, 142-157).
    pub fn safari() -> LibTarget {
        LibTarget::web("safari", None)
    }

    /// Its `kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            LibTarget::Web { .. } => "web",
            LibTarget::App { .. } => "app",
            LibTarget::Margin { .. } => "margin",
        }
    }

    /// As JS writes it: `{ kind, browser, profile }`, `{ kind, bundleId, name }` or `{ kind, page }`.
    pub fn to_value(&self) -> Value {
        TargetView::of(self).to_value()
    }
}

/// LT:51 `targetOf(raw)`: a target as given (stored, or an action's), checked and cut; `None` where JS answers null.
pub fn target_of(raw: Option<&Value>) -> Option<LibTarget> {
    let raw = raw?.as_object()?;
    match raw.get("kind").and_then(Value::as_str) {
        Some("app") => {
            let bundle_id = str_of(raw.get("bundleId"), 255);
            if !bundle_id_ok(bundle_id) {
                return None;
            }
            let name = str_of(raw.get("name"), 100);
            Some(LibTarget::App {
                bundle_id: bundle_id.into(),
                name: if name.is_empty() { bundle_id } else { name }.into(),
            })
        }
        Some("margin") => {
            let page = raw.get("page").and_then(Value::as_str)?;
            margin_page_title(page)?;
            Some(LibTarget::Margin { page: page.into() })
        }
        Some("web") => {
            let browser =
                raw.get("browser").and_then(Value::as_str).filter(|b| BROWSERS.contains(b)).unwrap_or("safari");
            Some(LibTarget::web(browser, some_text(raw.get("profile"), 256)))
        }
        _ => None,
    }
}

/// A target as `valuesOf` writes it: `targetOf(t) ?? webTarget('safari', null)` over a typed one (LT:142-157), so a
/// target a rule made itself is checked and cut as a stored one would be. Borrowed: nothing copied to compare two.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum TargetView<'a> {
    Web { browser: &'a str, profile: Option<&'a str> },
    App { bundle_id: &'a str, name: &'a str },
    Margin { page: &'a str },
}

impl<'a> TargetView<'a> {
    pub(crate) fn of(t: &'a LibTarget) -> TargetView<'a> {
        TargetView::checked(Some(t))
    }

    /// `targetOf(t) ?? webTarget('safari', null)`.
    pub(crate) fn checked(t: Option<&'a LibTarget>) -> TargetView<'a> {
        const SAFARI: TargetView<'static> = TargetView::Web { browser: "safari", profile: None };
        match t {
            None => SAFARI,
            Some(LibTarget::App { bundle_id, name }) => {
                let bundle_id = js::slice16(bundle_id, 255);
                if !bundle_id_ok(bundle_id) {
                    return SAFARI;
                }
                let name = js::slice16(name, 100);
                TargetView::App { bundle_id, name: if name.is_empty() { bundle_id } else { name } }
            }
            Some(LibTarget::Margin { page }) => {
                if margin_page_title(page).is_some() {
                    TargetView::Margin { page }
                } else {
                    SAFARI
                }
            }
            Some(LibTarget::Web { browser, profile }) => TargetView::Web {
                browser: if BROWSERS.contains(&&**browser) { browser } else { "safari" },
                profile: profile.as_deref().filter(|p| !p.is_empty()).map(|p| js::slice16(p, 256)),
            },
        }
    }

    pub(crate) fn to_value(self) -> Value {
        let mut o = Map::new();
        match self {
            TargetView::Web { browser, profile } => {
                o.insert("kind".into(), "web".into());
                o.insert("browser".into(), browser.into());
                o.insert("profile".into(), profile.map_or(Value::Null, Value::from));
            }
            TargetView::App { bundle_id, name } => {
                o.insert("kind".into(), "app".into());
                o.insert("bundleId".into(), bundle_id.into());
                o.insert("name".into(), name.into());
            }
            TargetView::Margin { page } => {
                o.insert("kind".into(), "margin".into());
                o.insert("page".into(), page.into());
            }
        }
        Value::Object(o)
    }
}

/// LT:70 `placeOf(target, url, title)`: an item's address and title for its target: an app's and a Margin page's are
/// their own, a web page's as given (cut), its title the address when it has none.
pub fn place_of(target: &LibTarget, url: Option<&Value>, title: Option<&Value>) -> (String, String) {
    match target {
        LibTarget::App { bundle_id, name } => {
            let t = str_of(title, TEXT_MAX);
            (app_url(bundle_id), if t.is_empty() { name.to_string() } else { t.to_owned() })
        }
        // (`MARGIN_PAGES[page]`: a page that isn't one has no title, which valuesOf writes as ''.)
        LibTarget::Margin { page } => (margin_url(page), margin_page_title(page).unwrap_or("").to_owned()),
        LibTarget::Web { .. } => {
            let u = str_of(url, TEXT_MAX);
            let t = str_of(title, TEXT_MAX);
            (u.to_owned(), if t.is_empty() { u } else { t }.to_owned())
        }
    }
}

// ---- the state's records ---------------------------------------------------------------------------------------------

/// A space (M's `Space` with the library's extras: its browser and profile, LT:77 `LibSpace`).
#[derive(Clone, Debug, PartialEq)]
pub struct Space {
    pub id: Str,
    pub name: Str,
    pub emoji: Str,
    pub color: Str,
    /// One of [`BROWSERS`]; a space M makes has none, which `valuesOf` writes as Safari's (`s.browser ?? 'safari'`).
    pub browser: Str,
    /// `None`: the browser's default profile (null).
    pub profile: Option<Str>,
    /// A theme id ([`theme_id_ok`]); `None`: the profile's.
    pub theme: Option<Str>,
}

/// A pin (M's `Pin`, with its target).
#[derive(Clone, Debug, PartialEq)]
pub struct Pin {
    pub id: Str,
    pub space_id: Str,
    pub url: Str,
    pub title: Str,
    pub custom_title: Option<Str>,
    pub folder_id: Option<Str>,
    /// `None`: none yet (`posOf(p, i)`: its place in the list stands in).
    pub pos: Option<f64>,
    /// `None`: none (a pin `M.addPin` made, LT:223 gives it the item's).
    pub target: Option<LibTarget>,
}

/// A favorite (M's `Favorite`).
#[derive(Clone, Debug, PartialEq)]
pub struct Favorite {
    pub id: Str,
    /// `'global'` or a profile's id (`f.scope || 'global'` where it's read).
    pub scope: Str,
    pub url: Str,
    pub title: Str,
    pub custom_title: Option<Str>,
    pub pos: Option<f64>,
    pub target: Option<LibTarget>,
}

/// A link rule (M's `AirTrafficRule`).
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: Str,
    pub pattern: Str,
    pub space_id: Str,
    pub enabled: bool,
    pub order: Option<f64>,
}

/// A split's axis (`'horizontal' | 'vertical'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

impl Axis {
    /// `g.axis === 'vertical' ? 'vertical' : 'horizontal'`.
    pub fn of(v: Option<&Value>) -> Axis {
        if v.and_then(Value::as_str) == Some("vertical") { Axis::Vertical } else { Axis::Horizontal }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Axis::Horizontal => "horizontal",
            Axis::Vertical => "vertical",
        }
    }
}

/// A split (M's `SplitGroup`): 2–4 items' ids, a ratio each.
#[derive(Clone, Debug, PartialEq)]
pub struct Split {
    pub id: Str,
    pub space_id: Str,
    pub axis: Axis,
    pub panes: Vec<Str>,
    pub ratios: Vec<f64>,
    pub pinned: bool,
    pub folder_id: Option<Str>,
    /// Kept only when it's a number (LT:113 `Number.isFinite(g.pos) ? { pos }`): never a 0 that wasn't there.
    pub pos: Option<f64>,
}

/// A folder of pins (M's `Folder`).
#[derive(Clone, Debug, PartialEq)]
pub struct Folder {
    pub id: Str,
    pub space_id: Str,
    pub name: Str,
    pub open: bool,
    pub pos: Option<f64>,
    pub parent_id: Option<Str>,
}

/// An archive entry (M's `ArchiveEntry`, with its target).
#[derive(Clone, Debug, PartialEq)]
pub struct ArchiveEntry {
    pub id: Str,
    pub url: Str,
    pub title: Str,
    pub space_id: Str,
    pub fav_icon_url: Str,
    pub closed_at: f64,
    /// `None`: none (an entry `M.archiveTab` made: LT:239 gives it the item's).
    pub target: Option<LibTarget>,
}

/// Where an imported item came from (LT:131): its set's browser and profile, and its id there.
#[derive(Clone, Debug, PartialEq)]
pub struct Imported {
    pub browser: Str,
    pub profile: Str,
    pub id: Str,
}

/// An item: the model's kept tab (M's `KeptTab`, the library's half: LT:124-133), with its target.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: Str,
    pub url: Str,
    pub title: Str,
    /// Its icon (stored as `icon`).
    pub fav_icon_url: Str,
    pub space_id: Str,
    pub order: f64,
    /// When it was used last (stored as `lastUsed`).
    pub last_active: f64,
    /// Selected (stored as `selected`).
    pub was_active: bool,
    pub kept_at: f64,
    /// Always `'library'` in the library (LT:126, 228).
    pub why: Str,
    pub target: LibTarget,
    pub pinned_by: Option<Str>,
    pub favorite_id: Option<Str>,
    pub custom_title: Option<Str>,
    pub imported: Option<Imported>,
}

// ---- a JS object's keys ------------------------------------------------------------------------------------------------

/// Whether a key is an array index (ECMAScript's: the canonical digits of an integer below 2^32 − 1), which a JS object
/// lists before its other keys, in numeric order.
pub fn is_array_index(key: &str) -> bool {
    let b = key.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) || (b[0] == b'0' && b.len() > 1) {
        return false;
    }
    key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// JS's own-key order for a list of keys in insertion order: array indexes first, ascending; then the rest as they came.
pub(crate) fn js_key_order<T>(list: &mut [(&str, T)]) {
    if list.iter().any(|(k, _)| is_array_index(k)) {
        // Stable: the others keep their order.
        list.sort_by(|(a, _), (b, _)| match (is_array_index(a), is_array_index(b)) {
            (true, true) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => Ordering::Equal,
        });
    }
}

/// A JS object used as a map (`keptTabs`, `activeSpaceByWindow`): `o[key] = v` keeps a key where it was or adds it
/// (an array index among the others in numeric order, any other key last), `delete o[key]` keeps the others' order,
/// and every walk (`Object.values`, `Object.entries`, `JSON.stringify`) is in that order. The order decides "the first
/// that…" (`Object.values(s.keptTabs).find(…)`, LT:546, 562, 617) and the snapshot's text.
#[derive(Clone, Debug)]
pub struct JsObject<V> {
    map: IndexMap<Str, V>,
}

impl<V> Default for JsObject<V> {
    fn default() -> Self {
        JsObject { map: IndexMap::new() }
    }
}

impl<V: PartialEq> PartialEq for JsObject<V> {
    /// The same keys in the same order with the same values.
    fn eq(&self, other: &Self) -> bool {
        self.map.len() == other.map.len() && self.map.iter().zip(other.map.iter()).all(|(a, b)| a == b)
    }
}

impl<V> JsObject<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// `o[key]` (an own key only: open question 4, the prototype's names find nothing).
    pub fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.map.get_mut(key)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    /// `o[key] = value`: where the key was, else in JS's place for a new key. The old value, if any.
    pub fn insert(&mut self, key: Str, value: V) -> Option<V> {
        if let Some(slot) = self.map.get_mut(&*key) {
            return Some(std::mem::replace(slot, value));
        }
        if is_array_index(&key) {
            let n: u64 = key.parse().unwrap_or(0);
            let at = self.map.keys().take_while(|k| is_array_index(k) && k.parse::<u64>().unwrap_or(0) < n).count();
            self.map.shift_insert(at, key, value);
        } else {
            self.map.insert(key, value);
        }
        None
    }

    /// `delete o[key]`: the others keep their order.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        self.map.shift_remove(key)
    }

    /// `Object.entries(o)`.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&Str, &V)> + DoubleEndedIterator {
        self.map.iter()
    }

    /// `Object.keys(o)`.
    pub fn keys(&self) -> impl ExactSizeIterator<Item = &Str> + DoubleEndedIterator {
        self.map.keys()
    }

    /// `Object.values(o)`.
    pub fn values(&self) -> impl ExactSizeIterator<Item = &V> + DoubleEndedIterator {
        self.map.values()
    }

    /// `Object.fromEntries(Object.entries(o).filter(…))`: the kept ones in their order.
    pub fn retain(&mut self, mut keep: impl FnMut(&Str, &mut V) -> bool) {
        self.map.retain(|k, v| keep(k, v));
    }
}

impl<V> FromIterator<(Str, V)> for JsObject<V> {
    /// `Object.fromEntries(…)`: each key set in turn.
    fn from_iter<I: IntoIterator<Item = (Str, V)>>(iter: I) -> Self {
        let mut o = JsObject::new();
        for (k, v) in iter {
            o.insert(k, v);
        }
        o
    }
}

// ---- the state -----------------------------------------------------------------------------------------------------------

/// The library's state (LT:78 `LibState`): the model's State with the library's collections only.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LibState {
    /// In their order (`order`, then the ids' `localeCompare`).
    pub spaces: List<Space>,
    pub pins: List<Pin>,
    pub favorites: List<Favorite>,
    /// The link rules, in their order (`airTraffic`).
    pub air_traffic: List<Rule>,
    pub splits: List<Split>,
    pub folders: List<Folder>,
    /// Newest first (`closedAt`, then the ids' `localeCompare`).
    pub archive: List<ArchiveEntry>,
    /// The items (`keptTabs`), by id.
    pub kept: Rc<JsObject<Rc<Item>>>,
    /// The space each Margin window shows (`activeSpaceByWindow`), by the window's id as a string.
    pub windows: Rc<JsObject<Str>>,
}

impl LibState {
    /// The same state, not only an equal one (JS's `next === s`): every collection the same list. What a rule that
    /// changed nothing hands back, which decides `result: null` against an id (LT:532, 601, 791).
    pub fn same(&self, other: &LibState) -> bool {
        Rc::ptr_eq(&self.spaces, &other.spaces)
            && Rc::ptr_eq(&self.pins, &other.pins)
            && Rc::ptr_eq(&self.favorites, &other.favorites)
            && Rc::ptr_eq(&self.air_traffic, &other.air_traffic)
            && Rc::ptr_eq(&self.splits, &other.splits)
            && Rc::ptr_eq(&self.folders, &other.folders)
            && Rc::ptr_eq(&self.archive, &other.archive)
            && Rc::ptr_eq(&self.kept, &other.kept)
            && Rc::ptr_eq(&self.windows, &other.windows)
    }
}

// ---- the stored values ---------------------------------------------------------------------------------------------------

/// The library's stored values (LT:31 `Values`, collection → id → value) as `stateOf` reads them: the store's set
/// itself (its live items, ids in code-point order: no JSON built) or values as JSON (the import's, the tests').
pub trait Values {
    /// A collection's live entries in their stored order, whatever each value is; none if it isn't an object.
    fn raw(&self, collection: &str) -> Vec<(&str, &Value)>;
}

impl Values for Map<String, Value> {
    fn raw(&self, collection: &str) -> Vec<(&str, &Value)> {
        match self.get(collection) {
            Some(Value::Object(list)) => list.iter().map(|(id, v)| (id.as_str(), v)).collect(),
            _ => Vec::new(),
        }
    }
}

impl Values for DataSet {
    fn raw(&self, collection: &str) -> Vec<(&str, &Value)> {
        self.items.get(collection).map_or_else(Vec::new, |list| {
            list.iter().filter_map(|(id, item)| Some((id.as_str(), item.value.as_ref()?))).collect()
        })
    }
}

/// LT:85 `sorted(list)`: `Object.entries` of a collection (JS's key order) whose values are objects.
pub(crate) fn sorted<'a, V: Values + ?Sized>(
    values: &'a V,
    collection: &str,
) -> Vec<(&'a str, &'a Map<String, Value>)> {
    let mut list: Vec<(&str, &Map<String, Value>)> =
        values.raw(collection).into_iter().filter_map(|(id, v)| Some((id, v.as_object()?))).collect();
    js_key_order(&mut list);
    list
}

/// `{ ...(values.imports ?? {}) }`: the import's markers, passed through as they are (LT:819, 877). (The store's
/// collections are objects; JS's spread of a string or an array, which no store holds, isn't reproduced.)
pub fn imports_of<V: Values + ?Sized>(values: &V) -> Map<String, Value> {
    let mut list = values.raw("imports");
    js_key_order(&mut list);
    list.into_iter().map(|(id, v)| (id.to_owned(), v.clone())).collect()
}

/// LT:841 `isObject(values?.imports?.done)`: the import ran.
pub fn is_imported<V: Values + ?Sized>(values: &V) -> bool {
    values.raw("imports").into_iter().any(|(id, v)| id == "done" && v.is_object())
}

/// `finite(v, or)` (LT:44) for a stored number.
#[inline]
fn finite_or(v: Option<&Value>, or: f64) -> f64 {
    js::finite(v).unwrap_or(or)
}

/// LT:87 `stateOf(values)`: each collection read, checked, cut and sorted. `compare` is `localeCompare` (the system's
/// sorter): it breaks ties of spaces' and link rules' `order` and of the archive's `closedAt`.
pub fn state_of<V: Values + ?Sized>(values: &V, compare: &dyn LocaleCompare) -> LibState {
    let safari: Str = "safari".into();
    let shared = |s: &str, common: &Str| if **common == *s { common.clone() } else { Str::from(s) };
    let target =
        |v: Option<&Value>| target_of(v).unwrap_or_else(|| LibTarget::Web { browser: safari.clone(), profile: None });

    let mut spaces = sorted(values, "spaces");
    spaces.sort_by(|a, b| {
        js::num_cmp(finite_or(a.1.get("order"), 0.0), finite_or(b.1.get("order"), 0.0))
            .then_with(|| compare.compare(a.0, b.0))
    });
    let spaces: Vec<Rc<Space>> = spaces
        .into_iter()
        .map(|(id, s)| {
            let browser = s.get("browser").and_then(Value::as_str).filter(|b| BROWSERS.contains(b)).unwrap_or("safari");
            Rc::new(Space {
                id: id.into(),
                name: str_of(s.get("name"), 200).into(),
                emoji: str_of(s.get("emoji"), 16).into(),
                color: str_of(s.get("color"), 32).into(),
                browser: shared(browser, &safari),
                profile: some_str(s.get("profile")).map(Str::from),
                theme: s.get("theme").and_then(Value::as_str).filter(|t| theme_id_ok(t)).map(Str::from),
            })
        })
        .collect();

    let pins: Vec<Rc<Pin>> = sorted(values, "pins")
        .into_iter()
        .filter_map(|(id, p)| {
            let space_id = p.get("spaceId")?.as_str()?;
            let url = p.get("url")?.as_str()?;
            Some(Rc::new(Pin {
                id: id.into(),
                space_id: space_id.into(),
                url: url.into(),
                title: str_of(p.get("title"), TEXT_MAX).into(),
                custom_title: some_text(p.get("customTitle"), 200).map(Str::from),
                folder_id: some_str(p.get("folderId")).map(Str::from),
                pos: Some(finite_or(p.get("pos"), 0.0)),
                target: Some(target(p.get("target"))),
            }))
        })
        .collect();

    let global: Str = "global".into();
    let favorites: Vec<Rc<Favorite>> = sorted(values, "favorites")
        .into_iter()
        .filter_map(|(id, f)| {
            let url = f.get("url")?.as_str()?;
            Some(Rc::new(Favorite {
                id: id.into(),
                scope: some_str(f.get("scope")).map_or_else(|| global.clone(), Str::from),
                url: url.into(),
                title: str_of(f.get("title"), TEXT_MAX).into(),
                custom_title: some_text(f.get("customTitle"), 200).map(Str::from),
                pos: Some(finite_or(f.get("pos"), 0.0)),
                target: Some(target(f.get("target"))),
            }))
        })
        .collect();

    let mut rules: Vec<(&str, &Map<String, Value>)> = sorted(values, "airTraffic")
        .into_iter()
        .filter(|(_, r)| {
            r.get("pattern").is_some_and(Value::is_string) && r.get("spaceId").is_some_and(Value::is_string)
        })
        .collect();
    rules.sort_by(|a, b| {
        js::num_cmp(finite_or(a.1.get("order"), 0.0), finite_or(b.1.get("order"), 0.0))
            .then_with(|| compare.compare(a.0, b.0))
    });
    let air_traffic: Vec<Rc<Rule>> = rules
        .into_iter()
        .enumerate()
        .map(|(i, (id, r))| {
            Rc::new(Rule {
                id: id.into(),
                pattern: str_of(r.get("pattern"), 200).into(),
                space_id: str_of(r.get("spaceId"), usize::MAX).into(),
                enabled: r.get("enabled") != Some(&Value::Bool(false)),
                order: Some(finite_or(r.get("order"), i as f64)),
            })
        })
        .collect();

    let splits: Vec<Rc<Split>> = sorted(values, "splits")
        .into_iter()
        .filter_map(|(id, g)| {
            let space_id = g.get("spaceId")?.as_str()?;
            let given = g.get("panes")?.as_array()?;
            split_of(id, space_id, given, g)
        })
        .collect();

    let folders: Vec<Rc<Folder>> = sorted(values, "folders")
        .into_iter()
        .filter_map(|(id, f)| {
            let space_id = f.get("spaceId")?.as_str()?;
            Some(Rc::new(Folder {
                id: id.into(),
                space_id: space_id.into(),
                name: str_of(f.get("name"), 200).into(),
                open: f.get("open") != Some(&Value::Bool(false)),
                pos: Some(finite_or(f.get("pos"), 0.0)),
                parent_id: some_str(f.get("parentId")).map(Str::from),
            }))
        })
        .collect();

    let mut archive: Vec<(&str, &Map<String, Value>)> =
        sorted(values, "archive").into_iter().filter(|(_, a)| a.get("url").is_some_and(Value::is_string)).collect();
    archive.sort_by(|a, b| {
        js::num_cmp(finite_or(b.1.get("closedAt"), 0.0), finite_or(a.1.get("closedAt"), 0.0))
            .then_with(|| compare.compare(a.0, b.0))
    });
    let archive: Vec<Rc<ArchiveEntry>> = archive
        .into_iter()
        .map(|(id, a)| {
            Rc::new(ArchiveEntry {
                id: id.into(),
                url: str_of(a.get("url"), usize::MAX).into(),
                title: str_of(a.get("title"), TEXT_MAX).into(),
                space_id: str_of(a.get("spaceId"), 256).into(),
                fav_icon_url: str_of(a.get("icon"), ICON_MAX).into(),
                closed_at: finite_or(a.get("closedAt"), 0.0),
                target: Some(target(a.get("target"))),
            })
        })
        .collect();

    let library: Str = "library".into();
    let mut kept: JsObject<Rc<Item>> = JsObject::new();
    for (id, t) in sorted(values, "tabs") {
        if !is_tab_id(id) {
            continue;
        }
        let (Some(url), Some(space_id)) =
            (t.get("url").and_then(Value::as_str), t.get("spaceId").and_then(Value::as_str))
        else {
            continue;
        };
        let used = finite_or(t.get("lastUsed"), 0.0);
        let imported = t.get("imported").and_then(Value::as_object).map(|i| Imported {
            browser: str_of(i.get("browser"), 32).into(),
            profile: str_of(i.get("profile"), 256).into(),
            id: str_of(i.get("id"), 256).into(),
        });
        let id: Str = id.into();
        let item = Item {
            id: id.clone(),
            url: url.into(),
            title: str_of(t.get("title"), TEXT_MAX).into(),
            fav_icon_url: str_of(t.get("icon"), ICON_MAX).into(),
            space_id: space_id.into(),
            order: finite_or(t.get("order"), 0.0),
            last_active: used,
            was_active: t.get("selected") == Some(&Value::Bool(true)),
            kept_at: used,
            why: library.clone(),
            target: target(t.get("target")),
            pinned_by: some_str(t.get("pinnedBy")).map(Str::from),
            favorite_id: some_str(t.get("favoriteId")).map(Str::from),
            custom_title: some_text(t.get("customTitle"), 200).map(Str::from),
            imported,
        };
        kept.insert(id, Rc::new(item));
    }

    let mut windows: JsObject<Str> = JsObject::new();
    for (w, v) in sorted(values, "windows") {
        if let Some(space_id) = v.get("spaceId").and_then(Value::as_str) {
            windows.insert(w.into(), space_id.into());
        }
    }

    LibState {
        spaces: Rc::new(spaces),
        pins: Rc::new(pins),
        favorites: Rc::new(favorites),
        air_traffic: Rc::new(air_traffic),
        splits: Rc::new(splits),
        folders: Rc::new(folders),
        archive: Rc::new(archive),
        kept: Rc::new(kept),
        windows: Rc::new(windows),
    }
}

/// The most panes a split has (M:1628 `MAX_SPLIT_PANES`).
pub const MAX_SPLIT_PANES: usize = 4;

/// LT:101-115: a split's panes as stored: item ids (strings, not empty), each once, at most [`MAX_SPLIT_PANES`], each
/// with the ratio stored at its own place (one per pane given; else 1 each), normalised to 4 decimals; fewer than 2:
/// no split.
fn split_of(id: &str, space_id: &str, given: &[Value], g: &Map<String, Value>) -> Option<Rc<Split>> {
    let at: Vec<usize> = given
        .iter()
        .enumerate()
        .filter(|(i, x)| x.as_str().is_some_and(|s| !s.is_empty()) && !given[..*i].contains(x))
        .map(|(i, _)| i)
        .take(MAX_SPLIT_PANES)
        .collect();
    if at.len() < 2 {
        return None;
    }
    let ratios: Vec<f64> = match g.get("ratios").and_then(Value::as_array) {
        Some(r) if r.len() == given.len() => at
            .iter()
            .map(|&i| {
                let r = finite_or(r.get(i), 1.0);
                if r > 0.0 { r } else { 1.0 }
            })
            .collect(),
        _ => vec![1.0; at.len()],
    };
    let sum = ratios.iter().fold(0.0, |a, b| a + b);
    Some(Rc::new(Split {
        id: id.into(),
        space_id: space_id.into(),
        axis: Axis::of(g.get("axis")),
        panes: at.iter().map(|&i| Str::from(given[i].as_str().unwrap_or(""))).collect(),
        ratios: ratios.iter().map(|r| js::round((r / sum) * 10000.0) / 10000.0).collect(),
        pinned: js::truthy(g.get("pinned")),
        folder_id: some_str(g.get("folderId")).map(Str::from),
        pos: js::finite(g.get("pos")),
    }))
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
