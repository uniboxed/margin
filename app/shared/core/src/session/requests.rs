//! The library's requests to hosting (docs/CORE-REFACTOR.md step 3, part 1; HostedSession `library(_:wants:)`,
//! `handle`, `show`, `close`, `openApp`), transliterated: each decision at the same point between the same awaits,
//! Swift's `defer`s as an inner flow whose every return goes through the outer one's after-steps, in reverse order of
//! declaration.
//!
//! - A show request's item is drawn in front in its window at once (`requested`), its handling queued; a show
//!   overtaken before it started by a newer one for its window is skipped, said.
//! - A pin's and a favourite's open and reset are one flow (`open_by`), the differences as `reset`: a reset navigates
//!   an open item's tab back to its address first, and returns silently when no item could be made. Overtaken, both
//!   are skipped; a reset's tab is navigated back still (Tirth, 2026-11-23: no flash of it before the item picked after).
//! - `show`: the split first, then an app (the cycle's hold, the engine's open or show), a web item (its profile's
//!   window, the copy's `hostShow`) or Margin's own page; the item shown before drawn in front again when it fails.

use std::cell::Cell;

use serde_json::{Value, json};

use super::hosting::HostTarget;
use super::target::Target;
use super::{Core, Field, OpenItem, SAFARI_BUNDLE, object, swift_int};
use crate::hosted_browser::Role;
use crate::json::{self, Object};

/// The requests whose item is drawn in front at once (HostedSession `showRequests`).
pub const SHOW_REQUESTS: &[&str] =
    &["activateTab", "newTab", "restoreArchive", "setSpace", "openPin", "openFavorite", "showSplit"];

/// Margin's own bundle id (AppCatalog `ownApp`): never hosted in itself.
pub const OWN_APP: &str = "com.unibox.margin";
/// Margin picked in its own palette: the official upload, played in Safari.
pub const OWN_APP_SURPRISE: &str = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/// Whose item a pin's or a favourite's open makes (the four near-copies made one).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By {
    Pin,
    Favorite,
}

impl By {
    /// The request's key naming it, the new item's key binding it, the request's name for the log.
    fn keys(self) -> (&'static str, &'static str, &'static str) {
        match self {
            By::Pin => ("pin", "pinnedBy", "openPin"),
            By::Favorite => ("favorite", "favoriteId", "openFavorite"),
        }
    }
}

/// A library request (Library.swift `LibraryRequest`, library.ts `Request`): its type and all it said.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub kind: String,
    pub body: Object,
}

impl Request {
    /// One with a type (Library.swift drops the others).
    pub fn read(body: &Object) -> Option<Request> {
        Some(Request { kind: body.get("type")?.as_str()?.to_string(), body: body.clone() })
    }
    fn string(&self, k: &str) -> Option<&str> {
        self.body.get(k).and_then(Value::as_str)
    }
    pub fn window(&self) -> Option<i64> {
        swift_int(self.body.get("windowId"))
    }
    pub fn item(&self) -> Option<&str> {
        self.string("item")
    }
    pub fn url(&self) -> Option<&str> {
        self.string("url")
    }
    pub fn space(&self) -> Option<&str> {
        self.string("spaceId")
    }
    pub fn target(&self) -> Option<Target> {
        self.body.get("target").and_then(Target::read)
    }
    /// Its item drawn in front at once.
    pub fn shows(&self) -> bool {
        SHOW_REQUESTS.contains(&self.kind.as_str())
    }
}

/// An early return of a flow with after-steps (Swift's `return` inside a `defer`'s scope).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Go {
    On,
    Stop,
}

impl Core {
    // ---- the state the flows share ----

    pub(crate) fn requested_in(&self, w: i64) -> Option<String> {
        self.read(|s| s.requested.get(&w).cloned())
    }

    pub(crate) fn set_requested(&self, w: i64, item: Option<&str>) {
        self.edit(Field::Requested, |s| match item {
            Some(i) => s.requested.insert(w, i.to_string()),
            None => s.requested.remove(&w),
        });
    }

    pub(crate) fn hosting(&self) -> Option<i64> {
        self.read(|s| s.hosting_window)
    }

    pub(crate) fn set_hosting(&self, w: Option<i64>) {
        self.edit(Field::HostingWindow, |s| s.hosting_window = w);
    }

    fn set_shown(&self, w: i64, item: Option<&str>) {
        self.edit(Field::Shown, |s| match item {
            Some(i) => s.shown.insert(w, i.to_string()),
            None => s.shown.remove(&w),
        });
    }

    fn set_open(&self, item: &str, o: Option<OpenItem>) {
        self.edit(Field::Open, |s| match o {
            Some(o) => s.open.insert(item.to_string(), o),
            None => s.open.remove(item),
        });
    }

    fn set_label(&self, host: &str, label: &str) {
        self.edit(Field::Labels, |s| s.labels.insert(host.to_string(), label.to_string()));
    }

    pub(crate) fn label(&self, host: &str) -> Option<String> {
        self.read(|s| s.labels.get(host).cloned())
    }

    fn set_showing_item(&self, host: &str, item: Option<&str>) {
        self.edit(Field::Showing, |s| match item {
            Some(i) => s.showing.insert(host.to_string(), i.to_string()),
            None => s.showing.remove(host),
        });
    }

    pub(crate) fn margin_page(&self, w: i64) -> Option<String> {
        self.read(|s| s.margin_pages.get(&w).cloned())
    }

    fn set_margin_page_of(&self, w: i64, page: Option<&str>) {
        self.edit(Field::MarginPages, |s| match page {
            Some(p) => s.margin_pages.insert(w, p.to_string()),
            None => s.margin_pages.remove(&w),
        });
    }

    fn set_safari_tab(&self, item: &str, tab: Option<i64>) {
        self.edit(Field::SafariTabs, |s| match tab {
            Some(t) => s.safari_tabs.insert(item.to_string(), t),
            None => s.safari_tabs.remove(item),
        });
    }

    fn forget_audio(&self, item: &str) {
        self.edit(Field::SafariAudio, |s| s.safari_audio.remove(item));
    }

    // ---- the library's requests ----

    /// The Library's delegate (inside its `perform`): a show request's item in front in its window at once (its preview
    /// card hidden with its opener), then handled in the session's queue.
    pub(crate) fn library_request(&self, body: &Object) {
        let Some(r) = Request::read(body) else { return self.refused("library", "a request with no type") };
        if r.shows()
            && let Some(w) = self.ports.window(r.window())
        {
            self.card_leaving(w, r.item());
        }
        if r.shows()
            && let Some(item) = r.item()
            && let Some(w) = self.ports.window(r.window())
            && self.requested_in(w).as_deref() != Some(item)
        {
            self.set_requested(w, Some(item));
            self.ports.changed();
        }
        let Some(c) = self.rc() else { return };
        self.exec.enqueue(async move { c.handle(r).await });
    }

    /// A show overtaken before it started by a newer one for its window (fast clicks): skipped, said.
    pub(crate) fn overtaken(&self, item: &str, window: Option<i64>) -> bool {
        let Some(w) = self.ports.window(window) else { return false };
        match self.requested_in(w) {
            Some(newest) if newest != item => {
                self.note(format!("{item}: not shown, {newest} asked for since"));
                true
            }
            _ => false,
        }
    }

    /// Another item asked for in `w` since `item`'s show began (a pick while it was on its way).
    pub(crate) fn superseded(&self, w: i64, item: &str) -> bool {
        self.read(|s| s.requested.get(&w).is_some_and(|next| next != item))
    }

    async fn handle(&self, r: Request) {
        self.handle_in(&r).await;
        self.settle_hosting();
    }

    async fn handle_in(&self, r: &Request) {
        match r.kind.as_str() {
            "activateTab" | "newTab" | "restoreArchive" | "setSpace" => {
                let Some(item) = r.item() else {
                    // (A space with no items: nothing to show. Margin's own page of the space left goes: the launcher.)
                    if r.kind == "setSpace"
                        && let Some(w) = self.ports.window(r.window())
                    {
                        self.leave_margin_page(w);
                    }
                    return;
                };
                if self.overtaken(item, r.window()) {
                    return;
                }
                self.show(item, r.url(), r.target(), r.window()).await;
            }
            "openPin" => self.open_by(r, By::Pin, false).await,
            "resetPin" => self.open_by(r, By::Pin, true).await,
            "openFavorite" => self.open_by(r, By::Favorite, false).await,
            "resetFavorite" => self.open_by(r, By::Favorite, true).await,
            "showSplit" => {
                // (Shown with `item` focused, else the pane the window has focused, else its first.)
                let Some(w) = self.ports.window(r.window()) else {
                    return self.note("showSplit: no such split".into());
                };
                let Some(split) = r.string("splitId").and_then(|id| self.split(id)) else {
                    return self.note("showSplit: no such split".into());
                };
                let has = |i: &String| split.panes.contains(i);
                let focus = r
                    .item()
                    .map(str::to_string)
                    .filter(has)
                    .or_else(|| self.shown_in(w).filter(has))
                    .unwrap_or_else(|| split.panes[0].clone());
                if self.overtaken(&focus, Some(w)) {
                    return;
                }
                self.show(&focus, None, self.target_of(&focus), Some(w)).await;
            }
            "closeTab" | "unloadTab" => {
                let Some(item) = r.item() else { return };
                // (Rust's maps are in key order: of several windows showing it, the lowest; one does in practice.)
                let windows: Vec<i64> =
                    self.read(|s| s.shown.iter().filter(|(_, i)| *i == item).map(|(w, _)| *w).collect());
                // (A split's pane not focused: the window showing the split shows it again without it, its focus kept.)
                let mut around: Vec<i64> = self.layouts_with(item);
                around.retain(|w| self.shown_in(*w).as_deref() != Some(item));
                around.sort_unstable();
                let next = r.string("next");
                if let (Some(next), Some(&window)) = (next, windows.first())
                    && self.requested_in(window).is_none()
                {
                    self.set_requested(window, Some(next)); // (in front at once)
                }
                self.edit(Field::SafariMuted, |s| s.safari_muted.remove(item));
                self.forget_audio(item);
                self.close(item, r.target()).await;
                if let (Some(next), Some(&window)) = (next, windows.first()) {
                    self.show(next, None, self.target_of(next), Some(window)).await;
                }
                for window in around {
                    let Some(focus) = self.shown_in(window) else { continue };
                    self.show(&focus, None, self.target_of(&focus), Some(window)).await;
                }
            }
            "muteTab" => {
                let Some(item) = r.item() else { return };
                let Some(p) = self.open_item(item).and_then(|o| o.profile) else { return };
                let answer = self.ask(&p, "hostMute", object(json!({ "itemId": item }))).await;
                if let Some(muted) = answer.result.as_ref().and_then(|r| json::flag(r.get("muted"))) {
                    self.edit(Field::SafariMuted, |s| {
                        if muted { s.safari_muted.insert(item.to_string()) } else { s.safari_muted.remove(item) }
                    });
                    if let Some((audible, _)) = self.read(|s| s.safari_audio.get(item).copied()) {
                        self.edit(Field::SafariAudio, |s| s.safari_audio.insert(item.to_string(), (audible, muted)));
                    }
                    self.ports.changed();
                }
            }
            "mediaControl" => {
                // (The mini player's play or pause, previous or next for a web item's page: its copy's `hostMedia`,
                // with the tab its `media` push named.)
                let Some(item) = r.item() else { return };
                let Some(p) = self.open_item(item).and_then(|o| o.profile) else { return };
                let Some(command) = r.string("command") else { return };
                let mut payload = object(json!({ "itemId": item, "command": command }));
                if let Some(tab) = self.read(|s| s.safari_tabs.get(item).copied()) {
                    payload.insert("tabId".into(), json!(tab));
                }
                let answer = self.ask(&p, "hostMedia", payload).await;
                let done = answer.result.as_ref().and_then(|r| json::flag(r.get("ok"))) == Some(true);
                let how = if done {
                    "done".to_string()
                } else {
                    format!("not done ({})", answer.error.as_deref().unwrap_or("its page didn't"))
                };
                self.note(format!("{item}: the mini player's {command}: {how}"));
            }
            "clearToday" => {
                // (`as? [String]`: a list of strings only.)
                let items: Vec<String> = json::array(r.body.get("items"))
                    .filter(|l| l.iter().all(Value::is_string))
                    .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                for item in items {
                    self.close(&item, None).await;
                }
            }
            other => self.note(format!("{other}: nothing to host")),
        }
    }

    /// A pin's or a favourite's item opened (`reset`: its address shown again): its item when it has one, else one
    /// made for it (`addItem`, in front), then shown.
    async fn open_by(&self, r: &Request, by: By, reset: bool) {
        let url = r.url();
        if reset && url.is_none() {
            return;
        }
        if let Some(item) = r.item() {
            // (A reset's tab back at its address whatever comes next; then, as an open, not shown when another item was
            // asked for in its window since: Tirth, 2026-11-23.)
            if reset && let Some(p) = self.open_item(item).and_then(|o| o.profile) {
                self.ask(&p, "hostNavigate", object(json!({ "itemId": item, "url": url }))).await;
            }
            if self.overtaken(item, r.window()) {
                return;
            }
            return self.show(item, url, r.target(), r.window()).await;
        }
        let (asked, binds, name) = by.keys();
        let mut payload = object(json!({ "url": url.unwrap_or(""), "front": true }));
        if let Some(space) = r.space() {
            payload.insert("spaceId".into(), json!(space));
        }
        if let Some(w) = r.window() {
            payload.insert("windowId".into(), json!(w));
        }
        if let Some(target) = r.target() {
            payload.insert("target".into(), target.json());
        }
        if let Some(id) = r.string(asked) {
            payload.insert(binds.into(), json!(id));
        }
        let out = self.perform("addItem", payload).await;
        let made = if out.ok { out.result.get("tabId").and_then(Value::as_str).map(str::to_string) } else { None };
        let Some(item) = made else {
            if !reset {
                self.note(format!("{name}: no item made ({})", out.error.as_deref().unwrap_or("?")));
            }
            return;
        };
        self.show(&item, url, r.target(), r.window()).await;
    }

    // ---- showing ----

    /// An item in a Margin window's page area (None: the front window): its app or its Safari profile's window shown,
    /// and for a web item its tab in front there.
    pub(crate) async fn show(&self, item: &str, url: Option<&str>, target: Option<Target>, window: Option<i64>) {
        let Some(w) = self.ports.window(window) else {
            return self.note(format!("{item}: no Margin window to show it in"));
        };
        // (The preview card there hides with its opener: this show lays the item out alone.)
        self.card_leaving(w, Some(item));
        // (Shown or not, it's no longer one asked for: a failure draws the item shown before in front again.)
        let drawn = Cell::new(false);
        self.show_in(w, item, url, target, &drawn).await;
        if self.requested_in(w).as_deref() == Some(item) {
            self.set_requested(w, None);
            if !drawn.get() {
                self.ports.changed();
            }
        }
    }

    async fn show_in(&self, w: i64, item: &str, url: Option<&str>, target: Option<Target>, drawn: &Cell<bool>) {
        let Some(target) = target.or_else(|| self.target_of(item)) else {
            return self.note(format!("{item}: no target"));
        };
        // (A split's pane: the whole split, this pane focused; one that can't be: it alone.)
        if let Some(split) = self.split_of_item(item) {
            if self.show_split(&split, item, w).await {
                drawn.set(true);
                return;
            }
        }
        let address = url.map(str::to_string).or_else(|| self.item_url(item)).unwrap_or_default();
        let margin = matches!(target, Target::Margin { .. });
        match target {
            Target::App { bundle, name } => {
                let id = HostTarget::App(bundle.clone()).id();
                let label =
                    self.ports.app_name(&bundle).or((!name.is_empty()).then_some(name)).unwrap_or(bundle.clone());
                self.set_label(&id, &label);
                self.set_showing_item(&id, Some(item));
                let go = self.show_app(w, item, &bundle, &id).await;
                self.set_showing_item(&id, None);
                self.refresh_loading();
                if go == Go::Stop {
                    return;
                }
            }
            Target::Web { browser, profile } => {
                if browser != "safari" {
                    return self.note(format!("{item}: {browser} isn't hosted yet"));
                }
                let p =
                    self.profile_fallback(&self.resolve(profile.as_deref()), self.space_of_item(item).as_deref()).await;
                let id = HostTarget::Safari(p.clone(), Role::Main).id();
                self.set_label(&id, "Safari");
                self.set_showing_item(&id, Some(item));
                let go = self.show_web(w, item, &p, &id, &address).await;
                // (Its window not the one shown: Margin's window told the item is being shown until it is.)
                self.ports.set_showing(w, None, None, false);
                self.set_showing_item(&id, None);
                self.refresh_loading();
                if go == Go::Stop {
                    return;
                }
            }
            Target::Margin { page } => {
                // One of Margin's own pages (Settings): drawn by Margin's window itself in its page area, nothing
                // hosted for it. What this window hosted is parked (its row shows it again).
                self.set_margin_page_of(w, Some(&page));
                self.edit(Field::MarginOpen, |s| s.margin_open.insert(item.to_string()));
                self.ports.set_margin_page(w, Some(&page));
                self.clear_elsewhere(w);
                if self.ports.engine_shown().is_some() && self.hosting() == Some(w) {
                    let why = format!("Margin's {page} page shown in Margin's window");
                    self.engine("parkShown", json!({ "why": why })).await;
                }
                self.note(format!("{item}: Margin's {page} page shown in Margin's window {w}"));
            }
        }
        // (Another item shown: Margin's own page this window showed goes. Only now: a show that failed leaves it.)
        if !margin && self.margin_page(w).is_some() {
            self.set_margin_page_of(w, None);
            self.ports.set_margin_page(w, None);
        }
        self.set_shown(w, Some(item));
        self.set_layout_of(w, None); // (one item shown: the engine laid it out alone)
        if self.requested_in(w).as_deref() == Some(item) {
            self.set_requested(w, None);
        }
        drawn.set(true);
        self.ports.changed();
        self.card_returning(w, item);
    }

    /// An app item's show, between its loader's words and their clearing.
    async fn show_app(&self, w: i64, item: &str, bundle: &str, id: &str) -> Go {
        if self.ports.engine_shown().as_deref() != Some(id) || self.hosting() != Some(w) {
            self.ports.set_showing(w, self.label(id).as_deref(), Some(bundle), false);
        }
        let go = self.show_app_in(w, item, bundle, id).await;
        // (Another item asked for meanwhile: the loader stays for it, never a frame without it in between.)
        if !self.superseded(w, item) {
            self.ports.set_showing(w, None, None, false);
        }
        go
    }

    async fn show_app_in(&self, w: i64, item: &str, bundle: &str, id: &str) -> Go {
        // (Picked by the next/previous-tab key, its app not running yet: held a moment first. One the keys only pass
        // over is never started. A click is never held.)
        let (cycle_window, cycle_hold) = {
            let o = self.options.borrow();
            (o.cycle_window, o.cycle_hold)
        };
        if let Some(at) = self.read(|s| s.cycled_at.get(&w).copied())
            && self.ports.now() - at < cycle_window
            && !self.ports.is_hosted(id)
            && self.ports.app_runs(bundle) == Some(false)
            && self.wait(cycle_hold, || self.superseded(w, item)).await
        {
            self.note(format!("{item}: passed over by the tab keys ({bundle} not started)"));
            return Go::Stop;
        }
        if !self.host(&HostTarget::App(bundle.to_string()), w, item).await {
            return Go::Stop;
        }
        self.set_open(item, Some(OpenItem { host: id.to_string(), profile: None }));
        Go::On
    }

    /// A web item's show: its profile's window shown (made the first time), its tab in front there by the copy.
    async fn show_web(&self, w: i64, item: &str, p: &str, id: &str, address: &str) -> Go {
        // (Its window in a layout of several (a split's main pane, a card's opener): never a tab switch only.)
        let laid_out = self.has_layout(w) || !self.ports.shows_alone(id);
        let comes = self.ports.engine_shown().as_deref() != Some(id) || self.hosting() != Some(w) || laid_out;
        let there = self.safari_window(p, Role::Main).is_some() && self.ports.is_hosted(id);
        let target = HostTarget::Safari(p.to_string(), Role::Main);
        if comes {
            let title = self.title_of(item);
            self.ports.set_showing(w, Some(title.as_deref().unwrap_or("Safari")), Some(SAFARI_BUNDLE), false);
            if !there && !self.host(&target, w, item).await {
                return Go::Stop;
            }
        }
        let Some(window_id) = self.safari_window(p, Role::Main) else {
            self.note(format!("{item}: no Safari window of its profile"));
            return Go::Stop;
        };
        let url = if address.is_empty() { "about:blank" } else { address };
        let pinned = self.pinned_or_favorite(item);
        let payload = object(json!({ "windowId": window_id, "itemId": item, "url": url, "pinned": pinned }));
        let shown = self.ask(p, "hostShow", payload).await;
        let Some(result) = shown.result else {
            self.note(format!("{item}: its tab wasn't shown ({})", shown.error.as_deref().unwrap_or("no answer")));
            return Go::Stop;
        };
        self.set_open(item, Some(OpenItem { host: id.to_string(), profile: Some(p.to_string()) }));
        if let Some(tab) = swift_int(result.get("tabId")) {
            self.set_safari_tab(item, Some(tab));
        }
        if comes && there && !self.host(&target, w, item).await {
            return Go::Stop;
        }
        self.note(format!("{item}: shown in Safari window {window_id}"));
        Go::On
    }

    // ---- closing ----

    pub(crate) async fn close(&self, item: &str, target: Option<Target>) {
        self.forget_elsewhere(None, Some(item));
        let target = target.or_else(|| self.target_of(item));
        let had = self.open_item(item);
        self.set_open(item, None);
        self.set_safari_tab(item, None);
        self.forget_audio(item);
        let showing: Vec<i64> = self.read(|s| s.shown.iter().filter(|(_, i)| *i == item).map(|(w, _)| *w).collect());
        for w in &showing {
            self.set_shown(*w, None);
        }
        match target {
            Some(Target::App { bundle, .. }) => {
                let id = HostTarget::App(bundle).id();
                if self.ports.is_hosted(&id) && !self.read(|s| s.open.values().any(|o| o.host == id)) {
                    self.engine("close", json!({ "host": id })).await;
                }
            }
            Some(Target::Web { profile, .. }) => {
                let p =
                    had.as_ref().and_then(|o| o.profile.clone()).unwrap_or_else(|| self.resolve(profile.as_deref()));
                if had.is_some() {
                    self.ask(&p, "hostClose", object(json!({ "itemId": item }))).await;
                }
            }
            Some(Target::Margin { .. }) => {
                // (Its windows' page goes with it: the next item shown there, else the launcher.)
                for w in showing {
                    if self.margin_page(w).is_some() {
                        self.set_margin_page_of(w, None);
                        if self.ports.window(Some(w)).is_some() {
                            self.ports.set_margin_page(w, None);
                        }
                    }
                }
            }
            None => {}
        }
        self.edit(Field::MarginOpen, |s| s.margin_open.remove(item));
        self.note(format!("{item}: closed"));
        self.ports.changed();
        self.refresh_loading();
    }

    // ---- the palette ----

    /// An installed app picked (`app.open`) in a Margin window (None: the front one): an item of the window's space
    /// (the one it has for that app, else a new one), then shown. Safari: a new web item; Chrome and Edge: nothing.
    pub(crate) async fn open_app(&self, bundle: &str, window: Option<i64>) {
        if crate::shortcuts::is_chromium_bundle(bundle) {
            return self.note(format!("{bundle}: Chrome and Edge aren't hosted yet"));
        }
        let Some(w) = self.ports.window(window) else { return self.note(format!("{bundle}: no Margin window")) };
        if bundle.to_lowercase() == OWN_APP {
            // Margin picked inside Margin: never hosted in itself. A surprise instead, as a new web item.
            self.perform("newTab", object(json!({ "windowId": w, "url": OWN_APP_SURPRISE, "title": "Margin" }))).await;
            return self.note("Margin picked in its own palette: the surprise".into());
        }
        if self.options.borrow().safari_bundles.iter().any(|b| b == bundle) {
            // Safari itself: a new web item, in the space's Safari profile.
            self.perform("newTab", object(json!({ "windowId": w, "url": "about:blank", "title": "New Tab" }))).await;
            return;
        }
        let space = self.space_of_window(w).or_else(|| self.spaces().into_iter().next().map(|(id, _)| id));
        let app = format!("app://{bundle}");
        let existing = self
            .items_of_space(space.as_deref())
            .into_iter()
            .find(|(_, v)| v.get("url").and_then(Value::as_str) == Some(app.as_str()));
        if let Some((existing, _)) = existing {
            self.perform("activateTab", object(json!({ "windowId": w, "tabId": existing }))).await;
            return;
        }
        let name = self.ports.app_name(bundle).unwrap_or_else(|| bundle.to_string());
        let target = Target::App { bundle: bundle.to_string(), name };
        let mut payload = object(json!({ "windowId": w, "target": target.json(), "front": true }));
        if let Some(space) = &space {
            payload.insert("spaceId".into(), json!(space));
        }
        let out = self.perform("addItem", payload).await;
        let made = if out.ok { out.result.get("tabId").and_then(Value::as_str).map(str::to_string) } else { None };
        let Some(item) = made else {
            return self.note(format!("{bundle}: no item made ({})", out.error.as_deref().unwrap_or("?")));
        };
        self.note(format!("{bundle}: item {item} added"));
        // (In front at once, as a sidebar pick: its row lit and the loading bar its own while it opens.)
        self.set_requested(w, Some(&item));
        self.ports.changed();
        let Some(c) = self.rc() else { return };
        self.exec.enqueue(async move { c.show(&item, None, Some(target), Some(w)).await });
    }
}

/// The library's requests reach the session inside the library's perform (step 4 part 7, the point Library.swift's
/// delegate had them, L:225): as the `library` input, with the session counted as in a call, so what it starts waits
/// for the caller's next answer and tick (as a request from a port's callback does) and no borrow of the library is
/// held while it reads the library again.
impl crate::library::RequestSink for Core {
    fn request(&self, request: &Object) {
        self.depth.set(self.depth.get() + 1);
        self.library_request(request);
        self.depth.set(self.depth.get() - 1);
    }
}
