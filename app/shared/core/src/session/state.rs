//! The session's state the core keeps (HostedSession's fields, HS:385-433), moved in as the flows that read them move:
//! each Margin window's item shown, each item with a page, each Safari profile's hosted windows by role. While Swift
//! flows still write them, the Swift facade reads a field again only when its revision changed, and writes the
//! difference (`put`, `del`), never the whole field.
//!
//! Every list is JSON arrays (an id that's a number stays one): `shown` `[[window, item]]`, `open`
//! `[[item, host, profile | null]]`, `safariWindows` `[[profile, role, windowId]]` (`role`: `main`, `card`, `pane1`…).
//! Commit 5's (the library's requests, the show, the engine's window asks): `requested` `[[window, item]]`,
//! `labels` `[[host, label]]`, `showing` `[[host, item]]`, `marginPages` `[[window, page]]`, `cycledAt`
//! `[[window, seconds]]`, `safariTabs` `[[item, tab]]`, `safariAudio` `[[item, audible, muted]]`; the sets
//! `marginOpen`, `safariMuted`, `requesting` `[[item]]`… and `made` `[[windowId]]`; the one values `hostingWindow`,
//! `preparingWindow` `[[window]]` and `preparingProfile` `[[profile]]` (none: `[]`; a `del` of anything clears one).
//! Commit 7's (the preview card and Quick Tab): `cards` `[[profile, window, opener, space | null, url, title, open,
//! ready, fresh, rect | null, hiddenBy | null, click | null]]` (`rect`: `[x, y, width, height]`), `littleArcs`
//! `[[window, space]]`; `layouts` `[[window, main, mainRect | null, [[item, role, rect]…], focused, split | null]]`
//! (part 3's: the core's layouts write it, the card's flows and the facade read it).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::geometry::{Rect, cg};
use crate::host::model::Role as HostRole;
use crate::hosted_browser::Role;
use crate::json;

/// A profile's preview card (HostedPeek `PeekCard`): attached to a Margin window, over its opener.
#[derive(Clone, Debug)]
pub struct Card {
    pub profile: String,
    /// The Margin window it's attached to, and the item under it (main of that window's layout).
    pub window: i64,
    pub opener: String,
    /// The space Expand puts it in.
    pub space: Option<String>,
    pub url: String,
    pub title: String,
    /// Shown in its window now (false: hidden with its opener, kept).
    pub open: bool,
    /// Its window in place at its rect.
    pub ready: bool,
    /// Its page still to be loaded at `url` (a new preview): the copy navigates its tab there.
    pub fresh: bool,
    /// Where it was laid out last.
    pub rect: Option<Rect>,
    /// The item whose show hid it (a pick of the opener itself keeps it hidden).
    pub hidden_by: Option<String>,
    /// The page's click it came from (`peekOpen`'s id).
    pub click: Option<String>,
}

impl Card {
    pub fn new(
        profile: &str,
        window: i64,
        opener: &str,
        space: Option<String>,
        url: &str,
        click: Option<String>,
    ) -> Card {
        Card {
            profile: profile.to_string(),
            window,
            opener: opener.to_string(),
            space,
            url: url.to_string(),
            title: String::new(),
            open: true,
            ready: false,
            fresh: true,
            rect: None,
            hidden_by: None,
            click,
        }
    }
}

/// As the Swift struct's `==`: CGRect's (both standardized) for the rect.
impl PartialEq for Card {
    fn eq(&self, o: &Card) -> bool {
        let rect = match (&self.rect, &o.rect) {
            (Some(a), Some(b)) => cg::same(a, b),
            (None, None) => true,
            _ => false,
        };
        rect && self.profile == o.profile
            && self.window == o.window
            && self.opener == o.opener
            && self.space == o.space
            && self.url == o.url
            && self.title == o.title
            && self.open == o.open
            && self.ready == o.ready
            && self.fresh == o.fresh
            && self.hidden_by == o.hidden_by
            && self.click == o.click
    }
}

/// A Margin window's layout while more than its item shown is visible (HostedSession `HostedLayout`): main (at the
/// page area, or `main_rect`: a split's pane), the others with their roles (`main`, `pane`, `card`) and rects back to
/// front, the focused one, the split it shows.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub main: String,
    pub main_rect: Option<Rect>,
    pub extras: Vec<Extra>,
    pub focused: String,
    pub split: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Extra {
    pub item: String,
    pub role: String,
    pub rect: Rect,
}

impl Layout {
    /// Main, then the others (`items`).
    pub fn items(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.main.as_str()).chain(self.extras.iter().map(|e| e.item.as_str()))
    }
    pub fn has(&self, item: &str) -> bool {
        self.items().any(|i| i == item)
    }
}

impl Extra {
    /// Its role as the host model has it (an unknown word: a pane; Swift writes only the three).
    pub fn host_role(&self) -> HostRole {
        host_role_named(&self.role).unwrap_or(HostRole::Pane)
    }
}

/// A host role as Swift's `HostRole.rawValue` says it.
pub fn host_role_name(r: HostRole) -> &'static str {
    match r {
        HostRole::Main => "main",
        HostRole::Pane => "pane",
        HostRole::Card => "card",
    }
}

pub fn host_role_named(name: &str) -> Option<HostRole> {
    match name {
        "main" => Some(HostRole::Main),
        "pane" => Some(HostRole::Pane),
        "card" => Some(HostRole::Card),
        _ => None,
    }
}

/// A rect as a row has it (`[x, y, width, height]`).
pub fn rect_json(r: &Rect) -> Value {
    Value::Array(
        [r.x, r.y, r.width, r.height].iter().map(|n| crate::protocol::number(*n).unwrap_or(Value::Null)).collect(),
    )
}

pub fn rect_read(v: &Value) -> Option<Rect> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let n = |i: usize| json::num(a.get(i));
    Some(Rect::new(n(0)?, n(1)?, n(2)?, n(3)?))
}

/// Where an item's page is: its host, and for a web item its profile (HostedSession `OpenItem`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenItem {
    pub host: String,
    pub profile: Option<String>,
}

/// The fields with a revision (`margin_session_rev`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Shown = 0,
    Open = 1,
    SafariWindows = 2,
    /// The log lines kept (`done`): its revision is how many were ever kept.
    Done = 3,
    Requested = 4,
    HostingWindow = 5,
    Labels = 6,
    Showing = 7,
    MarginPages = 8,
    MarginOpen = 9,
    CycledAt = 10,
    SafariTabs = 11,
    SafariMuted = 12,
    SafariAudio = 13,
    PreparingWindow = 14,
    PreparingProfile = 15,
    Requesting = 16,
    Made = 17,
    Cards = 18,
    LittleArcs = 19,
    Layouts = 20,
    /// Each card's address and whether it's a new page (`cards`' own, typed: what Swift's layout reads of a card; read
    /// only, its revision moving with `cards`').
    CardPages = 21,
    /// Commit 9's (the loading bar): a split's panes being laid out in each Margin window, by their hosts; the windows
    /// whose new pane keeps its loader after the engine's slow step (written by applyLayout, still Swift).
    PanesLaying = 22,
    RevealHeld = 23,
}

impl Field {
    pub const COUNT: usize = 24;
    const ALL: [Field; Field::COUNT] = [
        Field::Shown,
        Field::Open,
        Field::SafariWindows,
        Field::Done,
        Field::Requested,
        Field::HostingWindow,
        Field::Labels,
        Field::Showing,
        Field::MarginPages,
        Field::MarginOpen,
        Field::CycledAt,
        Field::SafariTabs,
        Field::SafariMuted,
        Field::SafariAudio,
        Field::PreparingWindow,
        Field::PreparingProfile,
        Field::Requesting,
        Field::Made,
        Field::Cards,
        Field::LittleArcs,
        Field::Layouts,
        Field::CardPages,
        Field::PanesLaying,
        Field::RevealHeld,
    ];
    pub fn from_index(i: u32) -> Option<Field> {
        Self::ALL.get(i as usize).copied()
    }
    /// Its name in a `state` input (`done` is read on its own).
    pub fn name(self) -> &'static str {
        match self {
            Field::Shown => "shown",
            Field::Open => "open",
            Field::SafariWindows => "safariWindows",
            Field::Done => "done",
            Field::Requested => "requested",
            Field::HostingWindow => "hostingWindow",
            Field::Labels => "labels",
            Field::Showing => "showing",
            Field::MarginPages => "marginPages",
            Field::MarginOpen => "marginOpen",
            Field::CycledAt => "cycledAt",
            Field::SafariTabs => "safariTabs",
            Field::SafariMuted => "safariMuted",
            Field::SafariAudio => "safariAudio",
            Field::PreparingWindow => "preparingWindow",
            Field::PreparingProfile => "preparingProfile",
            Field::Requesting => "requesting",
            Field::Made => "made",
            Field::Cards => "cards",
            Field::LittleArcs => "littleArcs",
            Field::Layouts => "layouts",
            Field::CardPages => "cardPages",
            Field::PanesLaying => "panesLaying",
            Field::RevealHeld => "revealHeld",
        }
    }
    pub fn of(name: &str) -> Option<Field> {
        Self::ALL.iter().copied().find(|f| *f != Field::Done && f.name() == name)
    }
}

#[derive(Debug, Default)]
pub struct State {
    pub shown: BTreeMap<i64, String>,
    pub open: BTreeMap<String, OpenItem>,
    pub safari_windows: BTreeMap<(String, Role), i64>,
    /// Each Margin window's item asked to be shown and not shown yet (the newest): drawn in front at once.
    pub requested: BTreeMap<i64, String>,
    pub hosting_window: Option<i64>,
    /// What the loading animation names for a host (the app's name; Safari).
    pub labels: BTreeMap<String, String>,
    /// The item each host is being shown for.
    pub showing: BTreeMap<String, String>,
    /// Each Margin window's own page shown (Settings), and the items of Margin's pages shown this session.
    pub margin_pages: BTreeMap<i64, String>,
    pub margin_open: BTreeSet<String>,
    /// When each Margin window's next/previous-tab key was last pressed.
    pub cycled_at: BTreeMap<i64, f64>,
    /// Each web item's tab in its Safari window (the copy's id), the ones muted, and each one's sound.
    pub safari_tabs: BTreeMap<String, i64>,
    pub safari_muted: BTreeSet<String>,
    pub safari_audio: BTreeMap<String, (bool, bool)>,
    /// The Margin window a browser's window is made ready over at launch, and its profile.
    pub preparing_window: Option<i64>,
    pub preparing_profile: Option<String>,
    /// The profiles a window is being asked of right now, and every Safari window Margin made (never swept).
    pub requesting: BTreeSet<String>,
    pub made: BTreeSet<i64>,
    /// Each profile's preview card, when each card window was last used (closed after `CARD_IDLE` unused), and the
    /// Margin windows with Quick Tab's field up (the space it opens in).
    pub cards: BTreeMap<String, Card>,
    pub card_used_at: BTreeMap<String, f64>,
    pub little_arcs: BTreeMap<i64, String>,
    /// Each Margin window's layout of several (part 3's).
    pub layouts: BTreeMap<i64, Layout>,
    /// The split's panes being laid out in each Margin window now, by their hosts (applyLayout, around the engine's
    /// setLayout), the pane whose slow step is under way (its window, its host), and the windows whose new pane keeps
    /// its loader after the engine's slow step is over (until its tab is shown and its toolbar rests).
    pub panes_laying: BTreeMap<i64, BTreeMap<String, String>>,
    pub reveal_held: BTreeSet<i64>,
    pub pane_loading_at: Option<(i64, String)>,
    /// The card whose window's first open is under way (its own loader, never the page card's).
    pub card_loading: Option<String>,
    /// The loading bar: the engine's slow step now (its host), the tabs each profile's copy says are loading in its
    /// hosted window, and what each Margin window was told last.
    pub app_loading: Option<String>,
    pub copy_loading: BTreeMap<String, BTreeSet<i64>>,
    pub loading_said: BTreeMap<i64, Vec<i64>>,
    /// The Margin window each standing push was last given to (with something in it).
    pub standing_to: BTreeMap<String, i64>,
    /// The UI's numbers for open items (it takes only numbers for open tabs), this session's, given in order of first
    /// use, and back.
    pub numbers: BTreeMap<String, i64>,
    pub items: BTreeMap<i64, String>,
    pub next_number: i64,
}

/// One part of a row (an int as `json::int` reads it, a string, a number, a bool).
trait Part: Sized {
    fn read(v: &Value) -> Option<Self>;
    fn json(&self) -> Value;
}
impl Part for i64 {
    fn read(v: &Value) -> Option<Self> {
        json::int(Some(v))
    }
    fn json(&self) -> Value {
        json!(self)
    }
}
impl Part for String {
    fn read(v: &Value) -> Option<Self> {
        v.as_str().map(str::to_string)
    }
    fn json(&self) -> Value {
        json!(self)
    }
}
impl Part for f64 {
    fn read(v: &Value) -> Option<Self> {
        json::num(Some(v))
    }
    fn json(&self) -> Value {
        crate::protocol::number(*self).unwrap_or(Value::Null)
    }
}
impl Part for bool {
    fn read(v: &Value) -> Option<Self> {
        v.as_bool()
    }
    fn json(&self) -> Value {
        json!(self)
    }
}

/// A row's value after its key.
trait Rest: Sized {
    fn read(cells: &[Value]) -> Option<Self>;
    fn cells(&self) -> Vec<Value>;
}
impl<T: Part> Rest for T {
    fn read(cells: &[Value]) -> Option<Self> {
        T::read(cells.first()?)
    }
    fn cells(&self) -> Vec<Value> {
        vec![self.json()]
    }
}
impl Rest for Card {
    fn read(c: &[Value]) -> Option<Self> {
        let s = |i: usize| c.get(i).and_then(Value::as_str).map(str::to_string);
        // (An optional text: null or a string, nothing else.)
        let opt = |i: usize| -> Option<Option<String>> {
            match c.get(i)? {
                Value::Null => Some(None),
                Value::String(t) => Some(Some(t.clone())),
                _ => None,
            }
        };
        let b = |i: usize| c.get(i).and_then(Value::as_bool);
        let rect = match c.get(8)? {
            Value::Null => None,
            v => Some(rect_read(v)?),
        };
        Some(Card {
            profile: String::new(),
            window: json::int(c.first())?,
            opener: s(1)?,
            space: opt(2)?,
            url: s(3)?,
            title: s(4)?,
            open: b(5)?,
            ready: b(6)?,
            fresh: b(7)?,
            rect,
            hidden_by: opt(9)?,
            click: opt(10)?,
        })
    }
    fn cells(&self) -> Vec<Value> {
        vec![
            json!(self.window),
            json!(self.opener),
            json!(self.space),
            json!(self.url),
            json!(self.title),
            json!(self.open),
            json!(self.ready),
            json!(self.fresh),
            self.rect.as_ref().map_or(Value::Null, rect_json),
            json!(self.hidden_by),
            json!(self.click),
        ]
    }
}

impl Rest for Layout {
    fn read(c: &[Value]) -> Option<Self> {
        let rect = |v: &Value| if v.is_null() { Some(None) } else { rect_read(v).map(Some) };
        let extras = c.get(2)?.as_array()?.iter().map(|e| {
            let e = e.as_array()?;
            Some(Extra {
                item: e.first()?.as_str()?.to_string(),
                role: e.get(1)?.as_str()?.to_string(),
                rect: rect_read(e.get(2)?)?,
            })
        });
        Some(Layout {
            main: c.first()?.as_str()?.to_string(),
            main_rect: rect(c.get(1)?)?,
            extras: extras.collect::<Option<Vec<_>>>()?,
            focused: c.get(3)?.as_str()?.to_string(),
            split: match c.get(4)? {
                Value::Null => None,
                v => Some(v.as_str()?.to_string()),
            },
        })
    }
    fn cells(&self) -> Vec<Value> {
        let extras = self.extras.iter().map(|e| json!([e.item, e.role, rect_json(&e.rect)])).collect();
        vec![
            json!(self.main),
            self.main_rect.as_ref().map_or(Value::Null, rect_json),
            Value::Array(extras),
            json!(self.focused),
            json!(self.split),
        ]
    }
}

impl Rest for (bool, bool) {
    fn read(cells: &[Value]) -> Option<Self> {
        Some((<bool as Part>::read(cells.first()?)?, <bool as Part>::read(cells.get(1)?)?))
    }
    fn cells(&self) -> Vec<Value> {
        vec![json!(self.0), json!(self.1)]
    }
}

fn map_json<K: Part, V: Rest>(m: &BTreeMap<K, V>) -> Value {
    Value::Array(
        m.iter()
            .map(|(k, v)| {
                let mut row = vec![k.json()];
                row.extend(v.cells());
                Value::Array(row)
            })
            .collect(),
    )
}

/// A map's edit: its deletions (keys), then its puts (rows). How many weren't one.
fn map_edit<K: Part + Ord, V: Rest>(m: &mut BTreeMap<K, V>, edit: &Value) -> usize {
    let mut bad = 0;
    for d in list(edit.get("del")) {
        match K::read(d) {
            Some(k) => {
                m.remove(&k);
            }
            None => bad += 1,
        }
    }
    for e in list(edit.get("put")) {
        let row = e.as_array().map_or(&[][..], Vec::as_slice);
        match (row.first().and_then(K::read), row.get(1..).and_then(V::read)) {
            (Some(k), Some(v)) => {
                m.insert(k, v);
            }
            _ => bad += 1,
        }
    }
    bad
}

fn set_json<K: Part>(s: &BTreeSet<K>) -> Value {
    Value::Array(s.iter().map(|k| json!([k.json()])).collect())
}

fn set_edit<K: Part + Ord>(s: &mut BTreeSet<K>, edit: &Value) -> usize {
    let mut bad = 0;
    for d in list(edit.get("del")) {
        match K::read(d) {
            Some(k) => {
                s.remove(&k);
            }
            None => bad += 1,
        }
    }
    for e in list(edit.get("put")) {
        match e.get(0).and_then(K::read) {
            Some(k) => {
                s.insert(k);
            }
            None => bad += 1,
        }
    }
    bad
}

fn one_json<K: Part>(v: &Option<K>) -> Value {
    Value::Array(v.iter().map(|k| json!([k.json()])).collect())
}

/// A one value's edit: any `del` clears it, then a `put` (`[[value]]`) sets it.
fn one_edit<K: Part>(v: &mut Option<K>, edit: &Value) -> usize {
    let mut bad = 0;
    if !list(edit.get("del")).is_empty() {
        *v = None;
    }
    for e in list(edit.get("put")) {
        match e.get(0).and_then(K::read) {
            Some(k) => *v = Some(k),
            None => bad += 1,
        }
    }
    bad
}

/// A role as Swift's `SafariRole.description` says it.
pub fn role_name(role: Role) -> String {
    match role {
        Role::Main => "main".into(),
        Role::Card => "card".into(),
        Role::Pane(n) => format!("pane{n}"),
    }
}

pub fn role_named(name: &str) -> Option<Role> {
    match name {
        "main" => Some(Role::Main),
        "card" => Some(Role::Card),
        _ => name.strip_prefix("pane")?.parse::<u8>().ok().map(Role::Pane),
    }
}

fn list(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

impl State {
    pub fn field_json(&self, f: Field) -> Value {
        match f {
            Field::Shown => Value::Array(self.shown.iter().map(|(w, i)| json!([w, i])).collect()),
            Field::Open => Value::Array(self.open.iter().map(|(i, o)| json!([i, o.host, o.profile])).collect()),
            Field::SafariWindows => {
                Value::Array(self.safari_windows.iter().map(|((p, r), id)| json!([p, role_name(*r), id])).collect())
            }
            Field::Done => Value::Null,
            Field::Requested => map_json(&self.requested),
            Field::HostingWindow => one_json(&self.hosting_window),
            Field::Labels => map_json(&self.labels),
            Field::Showing => map_json(&self.showing),
            Field::MarginPages => map_json(&self.margin_pages),
            Field::MarginOpen => set_json(&self.margin_open),
            Field::CycledAt => map_json(&self.cycled_at),
            Field::SafariTabs => map_json(&self.safari_tabs),
            Field::SafariMuted => set_json(&self.safari_muted),
            Field::SafariAudio => map_json(&self.safari_audio),
            Field::PreparingWindow => one_json(&self.preparing_window),
            Field::PreparingProfile => one_json(&self.preparing_profile),
            Field::Requesting => set_json(&self.requesting),
            Field::Made => set_json(&self.made),
            Field::Cards => map_json(&self.cards),
            Field::LittleArcs => map_json(&self.little_arcs),
            Field::Layouts => map_json(&self.layouts),
            Field::CardPages => Value::Array(self.cards.iter().map(|(p, c)| json!([p, c.url, c.fresh])).collect()),
            Field::PanesLaying => Value::Array(
                self.panes_laying.iter().flat_map(|(w, m)| m.iter().map(move |(h, i)| json!([w, h, i]))).collect(),
            ),
            Field::RevealHeld => set_json(&self.reveal_held),
        }
    }

    /// One field's edit (`{ put: [...], del: [...] }`): the fields it changed, and how many entries weren't one.
    pub fn edit(&mut self, name: &str, edit: &Value) -> (Option<Field>, usize) {
        let Some(f) = Field::of(name) else { return (None, 1) };
        let bad = match f {
            Field::Requested => Some(map_edit(&mut self.requested, edit)),
            Field::HostingWindow => Some(one_edit(&mut self.hosting_window, edit)),
            Field::Labels => Some(map_edit(&mut self.labels, edit)),
            Field::Showing => Some(map_edit(&mut self.showing, edit)),
            Field::MarginPages => Some(map_edit(&mut self.margin_pages, edit)),
            Field::MarginOpen => Some(set_edit(&mut self.margin_open, edit)),
            Field::CycledAt => Some(map_edit(&mut self.cycled_at, edit)),
            Field::SafariTabs => Some(map_edit(&mut self.safari_tabs, edit)),
            Field::SafariMuted => Some(set_edit(&mut self.safari_muted, edit)),
            Field::SafariAudio => Some(map_edit(&mut self.safari_audio, edit)),
            Field::PreparingWindow => Some(one_edit(&mut self.preparing_window, edit)),
            Field::PreparingProfile => Some(one_edit(&mut self.preparing_profile, edit)),
            Field::Requesting => Some(set_edit(&mut self.requesting, edit)),
            Field::Made => Some(set_edit(&mut self.made, edit)),
            Field::Cards => {
                let bad = map_edit(&mut self.cards, edit);
                // (A row's key is its profile.)
                for (p, c) in self.cards.iter_mut() {
                    c.profile.clone_from(p);
                }
                Some(bad)
            }
            Field::LittleArcs => Some(map_edit(&mut self.little_arcs, edit)),
            Field::Layouts => Some(map_edit(&mut self.layouts, edit)),
            Field::CardPages => Some(1),
            Field::RevealHeld => Some(set_edit(&mut self.reveal_held, edit)),
            Field::PanesLaying => Some(panes_edit(&mut self.panes_laying, edit)),
            Field::Shown | Field::Open | Field::SafariWindows | Field::Done => None,
        };
        if let Some(bad) = bad {
            return (Some(f), bad);
        }
        let mut bad = 0;
        let del = list(edit.get("del"));
        let put = list(edit.get("put"));
        for d in del {
            let ok = match f {
                Field::Shown => json::int(Some(d)).map(|w| self.shown.remove(&w)).is_some(),
                Field::Open => d.as_str().map(|i| self.open.remove(i)).is_some(),
                Field::SafariWindows => match (d.get(0).and_then(Value::as_str), d.get(1).and_then(Value::as_str)) {
                    (Some(p), Some(r)) => {
                        role_named(r).map(|r| self.safari_windows.remove(&(p.to_string(), r))).is_some()
                    }
                    _ => false,
                },
                _ => false,
            };
            bad += usize::from(!ok);
        }
        for e in put {
            let ok = match f {
                Field::Shown => match (json::int(e.get(0)), e.get(1).and_then(Value::as_str)) {
                    (Some(w), Some(i)) => {
                        self.shown.insert(w, i.to_string());
                        true
                    }
                    _ => false,
                },
                Field::Open => match (e.get(0).and_then(Value::as_str), e.get(1).and_then(Value::as_str), e.get(2)) {
                    (Some(i), Some(h), Some(p)) if p.is_null() || p.is_string() => {
                        let profile = p.as_str().map(str::to_string);
                        self.open.insert(i.to_string(), OpenItem { host: h.to_string(), profile });
                        true
                    }
                    _ => false,
                },
                Field::SafariWindows => {
                    match (e.get(0).and_then(Value::as_str), e.get(1).and_then(Value::as_str), json::int(e.get(2))) {
                        (Some(p), Some(r), Some(id)) => match role_named(r) {
                            Some(r) => {
                                self.safari_windows.insert((p.to_string(), r), id);
                                true
                            }
                            None => false,
                        },
                        _ => false,
                    }
                }
                _ => false,
            };
            bad += usize::from(!ok);
        }
        (Some(f), bad)
    }
}

/// One row of a field, typed: what the Mac's facade reads and edits with no JSON (`margin_session_rows`,
/// `margin_session_edit_row`). Each field uses the parts its rows have: `shown`, `requested`, `marginPages` (`i0` the
/// window, `s0` the item or page); `open` (`s0` item, `s1` host, `s2` profile); `safariWindows` (`s0` profile, `s1`
/// role, `i0` window); `labels`, `showing` (`s0` host, `s1` label or item); `cycledAt` (`i0`, `f`); `safariTabs`
/// (`s0`, `i0`); `safariAudio` (`s0`, `b0` audible, `b1` muted); the sets `marginOpen`, `safariMuted`, `requesting`
/// (`s0`) and `made` (`i0`); the one values `hostingWindow`, `preparingWindow` (`i0`), `preparingProfile` (`s0`);
/// commit 7's `cards` (`s0` profile, `s1` its parts as their JSON row's text), `littleArcs` (`i0`, `s0` space) and
/// `layouts` (`i0` window, `s0` its parts as JSON text); `cardPages` (`s0` profile, `s1` address, `b0` fresh: read only).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Row<'a> {
    pub i0: i64,
    pub f: f64,
    pub b0: bool,
    pub b1: bool,
    pub s0: Option<&'a str>,
    pub s1: Option<&'a str>,
    pub s2: Option<&'a str>,
}

impl State {
    /// A field's rows, in its order (as `field_json` gives them).
    pub fn rows(&self, f: Field, emit: &mut dyn FnMut(&Row)) {
        let d = Row::default();
        match f {
            Field::Shown => self.shown.iter().for_each(|(w, i)| emit(&Row { i0: *w, s0: Some(i), ..d })),
            Field::Open => self
                .open
                .iter()
                .for_each(|(i, o)| emit(&Row { s0: Some(i), s1: Some(&o.host), s2: o.profile.as_deref(), ..d })),
            Field::SafariWindows => {
                for ((p, r), id) in &self.safari_windows {
                    let role = role_name(*r);
                    emit(&Row { s0: Some(p), s1: Some(&role), i0: *id, ..d });
                }
            }
            Field::Done => {}
            Field::Requested => self.requested.iter().for_each(|(w, i)| emit(&Row { i0: *w, s0: Some(i), ..d })),
            Field::HostingWindow => self.hosting_window.iter().for_each(|w| emit(&Row { i0: *w, ..d })),
            Field::Labels => self.labels.iter().for_each(|(h, l)| emit(&Row { s0: Some(h), s1: Some(l), ..d })),
            Field::Showing => self.showing.iter().for_each(|(h, i)| emit(&Row { s0: Some(h), s1: Some(i), ..d })),
            Field::MarginPages => self.margin_pages.iter().for_each(|(w, p)| emit(&Row { i0: *w, s0: Some(p), ..d })),
            Field::MarginOpen => self.margin_open.iter().for_each(|i| emit(&Row { s0: Some(i), ..d })),
            Field::CycledAt => self.cycled_at.iter().for_each(|(w, t)| emit(&Row { i0: *w, f: *t, ..d })),
            Field::SafariTabs => self.safari_tabs.iter().for_each(|(i, t)| emit(&Row { s0: Some(i), i0: *t, ..d })),
            Field::SafariMuted => self.safari_muted.iter().for_each(|i| emit(&Row { s0: Some(i), ..d })),
            Field::SafariAudio => {
                self.safari_audio.iter().for_each(|(i, (a, m))| emit(&Row { s0: Some(i), b0: *a, b1: *m, ..d }))
            }
            Field::PreparingWindow => self.preparing_window.iter().for_each(|w| emit(&Row { i0: *w, ..d })),
            Field::PreparingProfile => self.preparing_profile.iter().for_each(|p| emit(&Row { s0: Some(p), ..d })),
            Field::Requesting => self.requesting.iter().for_each(|p| emit(&Row { s0: Some(p), ..d })),
            Field::Made => self.made.iter().for_each(|w| emit(&Row { i0: *w, ..d })),
            // (A card's and a layout's parts as JSON text, as their rows in `field_json` after the key: rare.)
            Field::Cards => {
                for (p, c) in &self.cards {
                    let text = Value::Array(c.cells()).to_string();
                    emit(&Row { s0: Some(p), s1: Some(&text), ..d });
                }
            }
            Field::LittleArcs => self.little_arcs.iter().for_each(|(w, s)| emit(&Row { i0: *w, s0: Some(s), ..d })),
            Field::Layouts => {
                for (w, l) in &self.layouts {
                    let text = Value::Array(l.cells()).to_string();
                    emit(&Row { i0: *w, s0: Some(&text), ..d });
                }
            }
            Field::CardPages => {
                self.cards.iter().for_each(|(p, c)| emit(&Row { s0: Some(p), s1: Some(&c.url), b0: c.fresh, ..d }))
            }
            Field::PanesLaying => {
                for (w, m) in &self.panes_laying {
                    m.iter().for_each(|(h, i)| emit(&Row { i0: *w, s0: Some(h), s1: Some(i), ..d }));
                }
            }
            Field::RevealHeld => self.reveal_held.iter().for_each(|w| emit(&Row { i0: *w, ..d })),
        }
    }

    /// One row put (`del` false) or taken out (`del`: by its key; a one value cleared whatever the row): false when
    /// the row lacks what the field needs.
    pub fn edit_row(&mut self, f: Field, del: bool, r: &Row) -> bool {
        let s0 = r.s0.map(str::to_string);
        let need = |v: Option<String>| v.ok_or(());
        let done: Result<(), ()> = (|| match f {
            Field::Shown => edit_map(&mut self.shown, r.i0, del, || need(s0.clone())),
            Field::Requested => edit_map(&mut self.requested, r.i0, del, || need(s0.clone())),
            Field::MarginPages => edit_map(&mut self.margin_pages, r.i0, del, || need(s0.clone())),
            Field::Open => edit_map(&mut self.open, need(s0.clone())?, del, || {
                Ok(OpenItem { host: need(r.s1.map(str::to_string))?, profile: r.s2.map(str::to_string) })
            }),
            Field::SafariWindows => {
                let key = (need(s0.clone())?, r.s1.and_then(role_named).ok_or(())?);
                edit_map(&mut self.safari_windows, key, del, || Ok(r.i0))
            }
            Field::Labels => edit_map(&mut self.labels, need(s0.clone())?, del, || need(r.s1.map(str::to_string))),
            Field::Showing => edit_map(&mut self.showing, need(s0.clone())?, del, || need(r.s1.map(str::to_string))),
            Field::CycledAt => edit_map(&mut self.cycled_at, r.i0, del, || Ok(r.f)),
            Field::SafariTabs => edit_map(&mut self.safari_tabs, need(s0.clone())?, del, || Ok(r.i0)),
            Field::SafariAudio => edit_map(&mut self.safari_audio, need(s0.clone())?, del, || Ok((r.b0, r.b1))),
            Field::MarginOpen => edit_set(&mut self.margin_open, need(s0.clone())?, del),
            Field::SafariMuted => edit_set(&mut self.safari_muted, need(s0.clone())?, del),
            Field::Requesting => edit_set(&mut self.requesting, need(s0.clone())?, del),
            Field::Made => edit_set(&mut self.made, r.i0, del),
            Field::RevealHeld => edit_set(&mut self.reveal_held, r.i0, del),
            Field::PanesLaying => {
                let host = need(s0.clone())?;
                if del {
                    if let Some(m) = self.panes_laying.get_mut(&r.i0) {
                        m.remove(&host);
                        if m.is_empty() {
                            self.panes_laying.remove(&r.i0);
                        }
                    }
                } else {
                    let item = need(r.s1.map(str::to_string))?;
                    self.panes_laying.entry(r.i0).or_default().insert(host, item);
                }
                Ok(())
            }
            Field::HostingWindow => {
                self.hosting_window = (!del).then_some(r.i0);
                Ok(())
            }
            Field::PreparingWindow => {
                self.preparing_window = (!del).then_some(r.i0);
                Ok(())
            }
            Field::PreparingProfile => {
                self.preparing_profile = if del { None } else { Some(need(s0.clone())?) };
                Ok(())
            }
            Field::Cards => edit_map(&mut self.cards, need(s0.clone())?, del, || {
                let cells: Value = serde_json::from_str(r.s1.ok_or(())?).map_err(|_| ())?;
                let mut c = <Card as Rest>::read(cells.as_array().ok_or(())?).ok_or(())?;
                c.profile = s0.clone().ok_or(())?;
                Ok(c)
            }),
            Field::LittleArcs => edit_map(&mut self.little_arcs, r.i0, del, || need(s0.clone())),
            Field::Layouts => edit_map(&mut self.layouts, r.i0, del, || {
                let cells: Value = serde_json::from_str(r.s0.ok_or(())?).map_err(|_| ())?;
                <Layout as Rest>::read(cells.as_array().ok_or(())?).ok_or(())
            }),
            Field::Done | Field::CardPages => Err(()),
        })();
        done.is_ok()
    }
}

/// `panesLaying`'s edit: its deletions (`[window, host]`), then its puts (`[window, host, item]`); a window with no
/// pane left is gone.
fn panes_edit(m: &mut BTreeMap<i64, BTreeMap<String, String>>, edit: &Value) -> usize {
    let mut bad = 0;
    for d in list(edit.get("del")) {
        match (json::int(d.get(0)), d.get(1).and_then(Value::as_str)) {
            (Some(w), Some(h)) => {
                if let Some(panes) = m.get_mut(&w) {
                    panes.remove(h);
                    if panes.is_empty() {
                        m.remove(&w);
                    }
                }
            }
            _ => bad += 1,
        }
    }
    for e in list(edit.get("put")) {
        match (json::int(e.get(0)), e.get(1).and_then(Value::as_str), e.get(2).and_then(Value::as_str)) {
            (Some(w), Some(h), Some(i)) => {
                m.entry(w).or_default().insert(h.to_string(), i.to_string());
            }
            _ => bad += 1,
        }
    }
    bad
}

fn edit_map<K: Ord, V>(m: &mut BTreeMap<K, V>, k: K, del: bool, v: impl FnOnce() -> Result<V, ()>) -> Result<(), ()> {
    if del {
        m.remove(&k);
    } else {
        m.insert(k, v()?);
    }
    Ok(())
}

fn edit_set<K: Ord>(s: &mut BTreeSet<K>, k: K, del: bool) -> Result<(), ()> {
    if del {
        s.remove(&k);
    } else {
        s.insert(k);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_and_reads() {
        let mut s = State::default();
        assert_eq!(s.edit("shown", &json!({ "put": [[1, "a"], [2, "b"]] })), (Some(Field::Shown), 0));
        assert_eq!(s.edit("shown", &json!({ "del": [2, "x"], "put": [["1", "c"]] })), (Some(Field::Shown), 2));
        assert_eq!(s.field_json(Field::Shown), json!([[1, "a"]]));
        s.edit("open", &json!({ "put": [["a", "app:x", null], ["b", "safari:p", "p"], ["c", "h", 3]] }));
        assert_eq!(s.field_json(Field::Open), json!([["a", "app:x", null], ["b", "safari:p", "p"]]));
        s.edit("safariWindows", &json!({ "put": [["p", "main", 90], ["p", "pane2", 91], ["p", "nope", 1]] }));
        assert_eq!(s.safari_windows.get(&("p".into(), Role::Pane(2))), Some(&91));
        s.edit("safariWindows", &json!({ "del": [["p", "main"]] }));
        assert_eq!(s.field_json(Field::SafariWindows), json!([["p", "pane2", 91]]));
        assert_eq!(s.edit("nope", &json!({})), (None, 1));
        assert_eq!(role_named(&role_name(Role::Card)), Some(Role::Card));
    }

    #[test]
    fn rows_as_the_json_has_them() {
        let mut s = State::default();
        let r = |i0: i64, s0: Option<&'static str>| Row { i0, s0, ..Row::default() };
        assert!(s.edit_row(Field::Shown, false, &r(1, Some("a"))));
        assert!(!s.edit_row(Field::Shown, false, &r(2, None)), "an item needed");
        assert!(s.edit_row(
            Field::Open,
            false,
            &Row { s0: Some("a"), s1: Some("safari:p"), s2: Some("p"), ..Row::default() }
        ));
        assert!(s.edit_row(
            Field::SafariWindows,
            false,
            &Row { s0: Some("p"), s1: Some("pane2"), i0: 91, ..Row::default() }
        ));
        assert!(!s.edit_row(
            Field::SafariWindows,
            false,
            &Row { s0: Some("p"), s1: Some("x"), i0: 9, ..Row::default() }
        ));
        assert!(s.edit_row(Field::SafariAudio, false, &Row { s0: Some("a"), b0: true, ..Row::default() }));
        assert!(s.edit_row(Field::HostingWindow, false, &r(4, None)));
        assert!(s.edit_row(Field::Made, false, &r(90, None)));
        assert!(s.edit_row(Field::CycledAt, false, &Row { i0: 1, f: 2.5, ..Row::default() }));
        for f in [
            Field::Shown,
            Field::Open,
            Field::SafariWindows,
            Field::SafariAudio,
            Field::HostingWindow,
            Field::Made,
            Field::CycledAt,
        ] {
            let mut rows = Vec::new();
            s.rows(f, &mut |row| {
                rows.push(format!("{} {} {} {} {:?} {:?} {:?}", row.i0, row.f, row.b0, row.b1, row.s0, row.s1, row.s2))
            });
            assert_eq!(rows.len(), s.field_json(f).as_array().map_or(0, Vec::len), "{f:?}");
        }
        assert!(s.edit_row(Field::Shown, true, &r(1, None)));
        assert!(s.edit_row(Field::HostingWindow, true, &r(0, None)));
        assert_eq!((s.shown.len(), s.hosting_window), (0, None));
        assert!(s.edit_row(Field::SafariWindows, true, &Row { s0: Some("p"), s1: Some("pane2"), ..Row::default() }));
        assert!(s.safari_windows.is_empty());
    }

    #[test]
    fn the_cards_quick_tab_and_layouts_rows() {
        let mut s = State::default();
        let card = r#"[1,"b1","home","https://a/","",true,false,true,[360,150,1044,700],null,"c1"]"#;
        assert!(s.edit_row(Field::Cards, false, &Row { s0: Some("p"), s1: Some(card), ..Row::default() }));
        assert!(!s.edit_row(Field::Cards, false, &Row { s0: Some("q"), s1: Some("[1]"), ..Row::default() }));
        let c = &s.cards["p"];
        assert_eq!(
            (c.profile.as_str(), c.window, c.rect, c.click.as_deref()),
            ("p", 1, Some(Rect::new(360.0, 150.0, 1044.0, 700.0)), Some("c1"))
        );
        let layout = r#"["b1",null,[["card:p","card",[360,150,1044,700]]],"card:p",null]"#;
        assert!(s.edit_row(Field::Layouts, false, &Row { i0: 1, s0: Some(layout), ..Row::default() }));
        assert!(s.edit_row(Field::LittleArcs, false, &Row { i0: 2, s0: Some("home"), ..Row::default() }));
        let mut back = Vec::new();
        for f in [Field::Cards, Field::Layouts, Field::LittleArcs] {
            s.rows(f, &mut |r| back.push(format!("{} {:?} {:?}", r.i0, r.s0, r.s1)));
        }
        assert_eq!(
            back,
            [
                format!("0 Some(\"p\") Some({card:?})"),
                format!("1 Some({layout:?}) None"),
                "2 Some(\"home\") None".to_string()
            ]
        );
        assert_eq!(s.field_json(Field::Cards)[0][0], json!("p"));
        let mut pages = Vec::new();
        s.rows(Field::CardPages, &mut |r| pages.push((r.s0.map(str::to_string), r.s1.map(str::to_string), r.b0)));
        assert_eq!(pages, [(Some("p".to_string()), Some("https://a/".to_string()), true)], "the card's address, typed");
        assert!(!s.edit_row(Field::CardPages, false, &Row { s0: Some("p"), ..Row::default() }), "read only");
        assert!(s.edit_row(Field::Cards, true, &Row { s0: Some("p"), ..Row::default() }) && s.cards.is_empty());
    }

    #[test]
    fn commit_fives_fields_edited_and_read() {
        let mut s = State::default();
        assert_eq!(s.edit("requested", &json!({ "put": [[1, "a"], ["x", "b"]] })), (Some(Field::Requested), 1));
        assert_eq!(s.field_json(Field::Requested), json!([[1, "a"]]));
        s.edit("hostingWindow", &json!({ "put": [[4]] }));
        assert_eq!((s.hosting_window, s.field_json(Field::HostingWindow)), (Some(4), json!([[4]])));
        s.edit("hostingWindow", &json!({ "del": [null] }));
        assert_eq!((s.hosting_window, s.field_json(Field::HostingWindow)), (None, json!([])));
        s.edit("safariAudio", &json!({ "put": [["t1", true, false], ["t2", 1, 0]] }));
        assert_eq!(s.field_json(Field::SafariAudio), json!([["t1", true, false]]));
        s.edit("marginOpen", &json!({ "put": [["m1"], ["m2"]], "del": ["m0"] }));
        s.edit("marginOpen", &json!({ "del": ["m1"] }));
        assert_eq!(s.field_json(Field::MarginOpen), json!([["m2"]]));
        s.edit("cycledAt", &json!({ "put": [[1, 2.5]] }));
        assert_eq!(s.cycled_at.get(&1), Some(&2.5));
        s.edit("made", &json!({ "put": [[90], [91]] }));
        assert_eq!(s.field_json(Field::Made), json!([[90], [91]]));
        s.edit("preparingProfile", &json!({ "put": [["s-default"]] }));
        assert_eq!(s.preparing_profile.as_deref(), Some("s-default"));
        assert_eq!(Field::of("done"), None);
        for i in 0..Field::COUNT as u32 {
            let f = Field::from_index(i).expect("a field");
            assert_eq!(f as u32, i);
            assert!(f == Field::Done || Field::of(f.name()) == Some(f));
        }
    }
}
