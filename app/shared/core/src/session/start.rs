//! The start (docs/CORE-REFACTOR.md step 3, part 6; HostedSession.swift's `resumeLast`, the start screen,
//! `settleHosting`, the launcher, the default browser made ready), transliterated as requests.rs is: the item a
//! Margin window showed last and the app its loader shows (pure rules, commit 1), the start screen's state, and the
//! flows.
//!
//! The state machine: `waiting` → `preparing` (`prepare_browser` began) → `done` (prepared, given up for a reason, or
//! not possible). Beside it the start screen: shown with a window's last item gated on it (`resume_last`) → held up
//! (after `startupWait`, or at once when the browser's extension didn't link) → retried (its limit anew; the
//! preparation run again only if it was given up) or skipped → gone, then the last item shown if nothing else was
//! picked meanwhile. Nothing of Margin's usable while it's up (`Session::start_screen`, read per key press).

use serde_json::{Value, json};

use super::exec::begin;
use super::hosting::HostTarget;
use super::target::Target;
use super::{Core, Field, SAFARI_BUNDLE, choice};
use crate::data::profiles::DEFAULT_PROFILE;
use crate::hosted_browser::Role;
use crate::json;

/// The start screen's words (HostedSession `startupLabel`, `startupSlow`, `startupNoLink`).
pub const STARTUP_LABEL: &str = "Getting you started";
pub const STARTUP_SLOW: &str = "Safari is taking longer than usual to start.";
pub const STARTUP_NO_LINK: &str = "Safari started, but Margin\u{2019}s Safari extension didn\u{2019}t connect. Check that Margin is turned on in Safari \u{203a} Settings \u{203a} Extensions.";

/// The default browser's preparation at launch (HostedSession `Startup`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Startup {
    /// Not run yet.
    #[default]
    Waiting,
    /// Under way.
    Preparing,
    /// Ready, or not done (no browser Margin hosts, turned off, failed, the person picked something else first).
    Done,
}

impl Startup {
    pub fn name(self) -> &'static str {
        match self {
            Startup::Waiting => "waiting",
            Startup::Preparing => "preparing",
            Startup::Done => "done",
        }
    }
}

/// The start screen (HostedSession's `startup…` fields): the preparation's state, a window's last item waiting for
/// it, the screen shown, what it says is wrong now, the preparation given up for a reason the person can fix,
/// Continue without Safari picked, Try again's count, the setting the preparation ran with.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StartScreen {
    pub startup: Startup,
    pub waiting: bool,
    pub shown: bool,
    pub stuck: Option<String>,
    pub failure: Option<String>,
    pub skipped: bool,
    pub retries: i64,
    pub prepared_setting: Option<String>,
}

/// Safari's bundle id (ExtensionLink.swift `safariIdentifier`).
pub const SAFARI: &str = "com.apple.Safari";

/// The app whose icon the loader shows for an item: an app's own, Safari for a web item, none for Margin's own page.
pub fn loader_app(target: &Target) -> Option<&str> {
    match target {
        Target::App { bundle, .. } => Some(bundle),
        Target::Web { .. } => Some(SAFARI),
        Target::Margin { .. } => None,
    }
}

/// One item of a space, as `last_item` weighs it: its id, its stored value, its target (none: it has none).
pub struct Candidate<'a> {
    pub id: &'a str,
    pub value: &'a Value,
    pub target: Option<Target>,
}

/// The item a window showed last, and the name its loader says. For an app's item, `app` is the bundle whose own
/// name goes first when the OS knows it (`name` is the item's then, else the bundle id).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastItem {
    pub item: String,
    pub target: Target,
    pub name: String,
    pub app: Option<String>,
}

/// The item a Margin window showed last, of its space's items: the selected one (the newest used if several; among
/// equal ones the smallest id), if it can be hosted (a web item: Safari's only, for now).
pub fn last_item<'a>(items: impl IntoIterator<Item = Candidate<'a>>) -> Option<LastItem> {
    // (Swift's `selected as? Bool == true`, `num(lastUsed) ?? 0`, and `.max` with the ids compared the other way.)
    let used = |c: &Candidate<'_>| json::num(c.value.get("lastUsed")).unwrap_or(0.0);
    let mut best: Option<(Candidate<'a>, f64)> = None;
    for c in items.into_iter().filter(|c| json::flag(c.value.get("selected")) == Some(true)) {
        let at = used(&c);
        let better = match &best {
            None => true,
            Some((b, b_at)) => *b_at < at || (*b_at == at && c.id < b.id),
        };
        if better {
            best = Some((c, at));
        }
    }
    let (last, _) = best?;
    let target = last.target?;
    let title = json::string(last.value.get("title")).filter(|t| !t.is_empty());
    let (name, app) = match &target {
        Target::App { bundle, name } => {
            (if name.is_empty() { bundle.clone() } else { name.clone() }, Some(bundle.clone()))
        }
        Target::Web { browser, .. } => {
            if browser != "safari" {
                return None;
            }
            (title.unwrap_or("Safari").to_owned(), None)
        }
        Target::Margin { .. } => (title.unwrap_or("Margin").to_owned(), None),
    };
    Some(LastItem { item: last.id.to_owned(), target, name, app })
}

/// `Int(d)` for a log line (toward zero, as Swift's; what isn't finite, which Swift traps on: 0 or the nearest end).
fn whole(d: f64) -> i64 {
    d as i64
}

impl Core {
    // ---- the start screen's state ----

    fn start<R>(&self, f: impl FnOnce(&StartScreen) -> R) -> R {
        self.read(|s| f(&s.start))
    }

    fn set_start(&self, f: impl FnOnce(&mut StartScreen)) {
        self.edit(Field::Start, |s| f(&mut s.start));
    }

    pub(crate) fn resuming(&self) -> Option<i64> {
        self.read(|s| s.resuming)
    }

    fn set_resuming(&self, w: Option<i64>) {
        self.edit(Field::Resuming, |s| s.resuming = w);
    }

    /// The start screen is up: nothing of Margin's usable (its keys, its menu).
    pub(crate) fn start_shown(&self) -> bool {
        self.read(|s| s.start.shown)
    }

    /// The preparation's profile may still be woken for it: nothing shown, nothing on its way, nothing asked for (a
    /// window's last item waiting for it counts as nothing). Read by the Safari waker at each look: nothing allocated.
    pub(crate) fn prepare_wanted(&self) -> bool {
        !self.ports.engine_shows() && self.read(|s| s.start.waiting || (s.resuming.is_none() && s.requested.is_empty()))
    }

    // ---- the start screen's choices ----

    /// The start screen's Try again: the preparation run again if it was given up, else waited for again (its limit
    /// anew).
    pub(crate) fn startup_retry(&self) {
        if !self.start(|st| st.shown && st.stuck.is_some()) {
            return;
        }
        self.set_start(|st| st.retries += 1);
        self.note(format!("the start screen: Try again ({})", self.start(|st| st.retries)));
        if !self.start(|st| st.startup == Startup::Done && st.failure.is_some()) {
            return;
        }
        self.set_start(|st| {
            st.failure = None;
            st.startup = Startup::Waiting;
        });
        let Some(c) = self.rc() else { return };
        self.exec.spawn(async move {
            let setting = c.start(|st| st.prepared_setting.clone());
            c.prepare_browser(setting).await;
        });
    }

    /// The start screen's Continue without Safari: Margin usable now, the browser made ready when it can be (a web
    /// item opens it then).
    pub(crate) fn startup_skip(&self) {
        if !self.start(|st| st.shown && st.stuck.is_some() && !st.skipped) {
            return;
        }
        self.set_start(|st| st.skipped = true);
        self.note("the start screen: Continue without Safari".into());
    }

    /// The preparation over (ready, or not done).
    pub(crate) fn preparation_over(&self) {
        if self.start(|st| st.startup == Startup::Done) {
            return;
        }
        self.set_start(|st| st.startup = Startup::Done);
        self.ports.changed();
    }

    /// Until the browser is ready, Continue without Safari is picked, or another item is asked for: `startupWait`,
    /// then (still not ready) what's wrong said with the two choices, waited on as long as it takes; given up because
    /// its extension didn't link: said at once.
    async fn hold_startup(&self, w: i64, last: Option<String>) {
        let mut limit = self.options.borrow().startup_wait;
        let moved = || last.as_ref().is_some_and(|l| self.requested_in(w).as_ref() != Some(l));
        loop {
            self.wait(limit, || self.start(|st| st.startup == Startup::Done || st.skipped) || moved()).await;
            if self.start(|st| st.skipped)
                || moved()
                || self.start(|st| st.startup == Startup::Done && st.failure.is_none())
            {
                break;
            }
            let failure = self.start(|st| st.failure.clone());
            let why = failure.clone().unwrap_or_else(|| STARTUP_SLOW.into());
            if self.start(|st| st.stuck.as_ref() != Some(&why)) {
                self.set_start(|st| st.stuck = Some(why.clone()));
                self.ports.set_startup_stuck(w, Some(&why));
                let what = match failure {
                    None => format!("the default browser not ready within {} s", whole(limit)),
                    Some(_) => "its extension didn't link".into(),
                };
                self.note(format!("the start screen held up: {what}: Try again or Continue without Safari"));
            }
            let retries = self.start(|st| st.retries);
            self.held_up(retries, &moved).await;
            if self.start(|st| st.retries != retries && !st.skipped) && !moved() {
                self.set_start(|st| st.stuck = None);
                self.ports.set_startup_stuck(w, None);
                limit = self.options.borrow().startup_wait;
            }
        }
        if self.start(|st| st.stuck.is_some()) {
            self.set_start(|st| st.stuck = None);
            self.ports.set_startup_stuck(w, None);
        }
    }

    /// Held up: until Continue without Safari, a pick, Try again, or the browser ready after all. Re-checked only when
    /// what it reads changes (the start screen's state, the window's item asked for: Tirth, 2026-11-23), never on a
    /// look: nothing wakes while it's up and idle.
    async fn held_up(&self, retries: i64, moved: &dyn Fn() -> bool) {
        let over = || {
            self.start(|st| st.skipped)
                || moved()
                || self.start(|st| st.retries != retries)
                || self.start(|st| st.startup == Startup::Done && st.failure.is_none())
        };
        while !over() {
            self.exec.changed().await;
        }
    }

    // ---- at launch: the item the window showed last ----

    /// The item a Margin window showed last, of its space's items (`last_item`), its target and the name its loader
    /// says (an app's own name first, when it has one).
    pub(crate) fn last_item_of(&self, w: i64) -> Option<(String, Target, String)> {
        let space = self.space_of_window(w).or_else(|| self.spaces().into_iter().next().map(|(id, _)| id));
        let items: Vec<(String, Value, Option<Target>)> = self
            .items_of_space(space.as_deref())
            .into_iter()
            .map(|(id, v)| {
                let t = self.target_of(&id);
                (id, Value::Object(v), t)
            })
            .collect();
        let candidates = items.iter().map(|(id, value, target)| Candidate { id, value, target: target.clone() });
        let last = last_item(candidates)?;
        let target = self.target_of(&last.item)?;
        let name = last.app.as_deref().and_then(|a| self.ports.app_name(a)).unwrap_or(last.name);
        Some((last.item, target, name))
    }

    /// The first Margin window opened in a run (as it's made, before its page loads): the item it showed last shown
    /// again behind the loader from its first frame, the start screen first while the default browser gets ready.
    pub(crate) fn resume_last(&self, w: i64) {
        if self.read(|s| s.resumed) || self.hosting().is_some() || self.ports.engine_shown().is_some() {
            return;
        }
        self.edit(Field::Resuming, |s| s.resumed = true);
        // (MarginResumeLast NO: no item shown again, the start screen still: nothing's usable before the browser is.)
        let last = if self.options.borrow().resumes_last { self.last_item_of(w) } else { None };
        let gate = self.options.borrow().prepares_browser && self.start(|st| st.startup != Startup::Done);
        if let Some((item, Target::Margin { page }, _)) = &last
            && !gate
        {
            // Margin's own page (Settings) shown last: drawn by the window itself from its page's first frame (its
            // hello says it), nothing hosted, nothing to wait for.
            self.edit(Field::MarginPages, |s| s.margin_pages.insert(w, page.clone()));
            self.edit(Field::MarginOpen, |s| s.margin_open.insert(item.clone()));
            self.edit(Field::Shown, |s| s.shown.insert(w, item.clone()));
            self.ports.set_margin_page(w, Some(page));
            self.note(format!(
                "Margin's window {w}: the item it showed last ({item}), Margin's {page} page, shown again"
            ));
            return self.ports.changed();
        }
        if last.is_none() && !gate {
            return;
        }
        self.set_resuming(Some(w));
        self.set_hosting(Some(w));
        if let Some((item, _, _)) = &last {
            self.set_requested(w, Some(item));
        }
        self.ports.window_set_hosting(w, true);
        if gate {
            self.set_start(|st| {
                st.waiting = true;
                st.shown = true;
            });
            self.ports.set_showing(w, Some(STARTUP_LABEL), Some(SAFARI_BUNDLE), true);
            let then =
                last.as_ref().map(|(i, _, _)| format!(", then the item it showed last ({i})")).unwrap_or_default();
            self.note(format!("Margin's window {w}: \"{STARTUP_LABEL}\" while the default browser starts{then}"));
        } else if let Some((item, target, name)) = &last {
            self.ports.set_showing(w, Some(name), loader_app(target), true);
            self.note(format!(
                "Margin's window {w}: the item it showed last ({item}) shown again, behind the loader from its first frame"
            ));
        }
        self.ports.changed();
        let Some(c) = self.rc() else { return };
        self.exec.spawn(async move { c.resume_after(w, last, gate).await });
    }

    /// The start screen held while it must be (outside the session's queue: the preparation's own step is in it), then
    /// the last item shown if it's still the one asked for.
    async fn resume_after(&self, w: i64, last: Option<(String, Target, String)>, gate: bool) {
        if gate {
            self.hold_startup(w, last.as_ref().map(|l| l.0.clone())).await;
            self.set_start(|st| {
                st.waiting = false;
                st.shown = false;
            });
            if self.start(|st| st.startup != Startup::Done) {
                self.note(
                    "the start screen left before the default browser was ready (Continue without Safari): the browser when it's ready"
                        .into(),
                );
            }
        }
        let Some((item, target, name)) = last.clone().filter(|(i, _, _)| self.requested_in(w).as_ref() == Some(i))
        else {
            // (No item to show again, or another picked meanwhile: the loader goes, its own show decides.)
            self.set_resuming(None);
            if last.is_none() {
                self.settle_hosting();
            } else {
                self.ports.set_showing(w, None, None, false);
            }
            return;
        };
        if gate {
            self.ports.set_showing(w, Some(&name), loader_app(&target), true);
        }
        self.resume_show(w, item, target);
    }

    /// The last item's show, in the session's queue: once Margin's window is in full screen with its page area.
    fn resume_show(&self, w: i64, item: String, target: Target) {
        let Some(c) = self.rc() else { return };
        self.exec.enqueue(async move {
            c.resume_show_in(w, &item, target).await;
            c.set_resuming(None);
            c.ports.set_showing(w, None, None, false);
            // (Something else asked for meanwhile: its own show decides; else nothing shown is the launcher.)
            let asked = c.requested_in(w);
            if asked.is_none() || asked.as_deref() == Some(item.as_str()) {
                c.set_requested(w, None);
                c.settle_hosting();
            }
        });
    }

    async fn resume_show_in(&self, w: i64, item: &str, target: Target) {
        // (Something else asked for meanwhile ends the wait: its own show is next in line, not held up by this one.)
        // (Margin's own page needs no page area to host into: drawn at once.)
        let own = matches!(target, Target::Margin { .. });
        let ready = own || {
            let wait = self.options.borrow().prepare_window_wait;
            let up = || {
                (self.ports.window_full_screen(w) && self.ports.has_hosted_placement(w))
                    || self.requested_in(w).as_deref() != Some(item)
            };
            self.wait(wait, up).await
        };
        if self.overtaken(item, Some(w)) || self.requested_in(w).as_deref() != Some(item) {
            return;
        }
        if !ready {
            // (Margin's window not up in time: the launcher for now, and the item hosted once the window is in full
            // screen, as after macOS took it out: `enteredFullScreen`.)
            if !self.ports.window_full_screen(w) {
                self.edit(Field::Resume, |s| s.resume.insert(w, item.to_string()));
            }
            let wait = whole(self.options.borrow().prepare_window_wait);
            let then = if self.ports.window_full_screen(w) { "" } else { ": shown once it is" };
            return self.note(format!(
                "{item}: not shown at launch: Margin's window {w} wasn't in full screen with its page area within {wait} s{then}"
            ));
        }
        self.show(item, None, Some(target), Some(w)).await;
    }

    // ---- hosting settled, the launcher ----

    /// Margin's window hosts only while the engine shows something in it: nothing shown, its launcher in the page area
    /// again (after each of the session's steps, and the engine's events, once the engine is done). Not while its last
    /// item is still on its way at launch (`resuming`).
    pub(crate) fn settle_hosting(&self) {
        if self.ports.engine_shown().is_some() {
            return;
        }
        let Some(id) = self.hosting() else { return };
        if self.resuming() == Some(id) {
            return;
        }
        // (Another item asked for and not shown yet: its show is next and decides; no launcher for a frame in between.)
        if let Some(next) = self.requested_in(id)
            && self.shown_in(id).as_ref() != Some(&next)
        {
            return;
        }
        self.set_hosting(None);
        if self.margin_page(id).is_none() {
            self.edit(Field::Shown, |s| s.shown.remove(&id)); // (Margin's own page shown there: still the one shown)
        }
        let there = || self.ports.window(Some(id)).is_some();
        if there() {
            self.ports.set_hosted(id, None);
        }
        if there() {
            self.ports.clear_cover(id);
        }
        // (Hosting off before the loader's words go: words cleared on a card still loading draw "Opening…" for a frame.)
        if there() {
            self.ports.window_set_hosting(id, false);
        }
        if there() {
            self.ports.set_loading(id, None, None);
        }
        if there() {
            self.ports.set_showing(id, None, None, false);
        }
        self.refresh_loading();
        self.ports.changed();
    }

    /// The palette's Settings or Archive in Margin's window (the UI's `openLauncher`): Settings its own tab, drawn by
    /// Margin's window; Archive the launcher in the page area, the item shown there parked.
    pub(crate) async fn open_launcher(&self, window: Option<i64>, settings: bool) {
        let Some(id) = self.ports.window(window) else {
            return self.note("the launcher asked for: no Margin window".into());
        };
        if settings {
            let out =
                self.perform("openMarginPage", super::object(json!({ "windowId": id, "page": "settings" }))).await;
            let refused =
                if out.ok { String::new() } else { format!(", refused ({})", out.error.as_deref().unwrap_or("?")) };
            return self.note(format!("Margin's window {id}: Settings asked for{refused}"));
        }
        let Some(c) = self.rc() else { return };
        self.exec.enqueue(async move {
            if c.ports.engine_shown().is_some() && c.hosting() == Some(id) {
                c.engine("parkShown", json!({ "why": "the launcher asked for in Margin's window" })).await;
            }
            c.settle_hosting();
            if c.ports.window(Some(id)).is_some() {
                c.leave_margin_page(id);
            }
            c.note(format!("Margin's window {id}: its launcher in the page area"));
        });
    }

    /// Margin's own page a window shows, gone: its launcher in the page area (nothing shown there now).
    pub(crate) fn leave_margin_page(&self, w: i64) {
        if self.margin_page(w).is_none() {
            return;
        }
        self.edit(Field::MarginPages, |s| s.margin_pages.remove(&w));
        self.ports.set_margin_page(w, None);
        if self.hosting() != Some(w) {
            self.edit(Field::Shown, |s| s.shown.remove(&w));
        }
        self.ports.changed();
    }

    // ---- the default browser made ready at launch ----

    /// The person's default browser made ready out of sight at Margin's launch (Tirth, 2026-11-16): started with no
    /// Dock icon if it isn't running, its copy for the profile web items will use linked, Margin's window asked of it
    /// and taken to ready by the engine's early full screen, then parked out of sight. Not possible out of sight: not
    /// prepared, said. Its four steps, the last in the session's queue; it never delays Margin's own window.
    pub(crate) async fn prepare_browser(&self, setting: Option<String>) {
        if !self.options.borrow().prepares_browser {
            return self.preparation_over();
        }
        self.set_start(|st| {
            st.prepared_setting = setting.clone();
            st.startup = Startup::Preparing;
        });
        let started = self.ports.now();
        let (name, bundle, supported) = choice::default_browser(setting.as_deref());
        if !supported {
            let was = setting.as_deref().unwrap_or("");
            self.ports.log(false, &format!("hosted: the default browser setting ({was}) isn't supported yet: Safari"));
        }
        let skip = |why: String| {
            self.note(format!("browser not prepared: {why}"));
            self.preparation_over();
        };
        if name != "safari" {
            return skip(format!("{name} isn't hosted yet"));
        }
        if !self.ports.prepares_out_of_sight() {
            return skip("the early full screen isn't available, so it can't be made ready out of sight".into());
        }
        // 1. the browser started at once, beside Margin's own window going full screen, not after it.
        let mut starting = self.exec.command(
            super::Command::Engine { op: "start".into(), args: super::object(json!({ "bundle": bundle })) },
            false,
        );
        begin(&mut starting).await;
        // 2. a Margin window in full screen, its page area measured.
        let wait = self.options.borrow().prepare_window_wait;
        let up = || {
            self.ports
                .window(None)
                .is_some_and(|w| self.ports.window_full_screen(w) && self.ports.has_idle_placement(w))
        };
        let w = if self.wait(wait, up).await { self.ports.window(None) } else { None };
        let Some(w) = w else {
            let wait = whole(self.options.borrow().prepare_window_wait);
            return skip(format!("no Margin window in full screen with its page area within {wait} s"));
        };
        let space = self.space_of_window(w).or_else(|| self.spaces().into_iter().next().map(|(id, _)| id));
        let space_profile =
            self.spaces().into_iter().find(|(id, _)| Some(id) == space.as_ref()).and_then(|(_, v)| {
                v.get("profile").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string)
            });
        // 3. its copy linked (outside the session's and the engine's queues: the person's picks meanwhile aren't held up).
        if json::flag(starting.await.get("started")) != Some(true) {
            return skip(format!("{bundle} couldn't be started with no Dock icon"));
        }
        let mut p = self.resolve(space_profile.as_deref());
        // (A profile with no window is woken through Safari's menu only for a preparation that can still happen:
        // nothing shown, nothing on its way, nothing asked for: `prepare_wanted`, the waker's look.)
        let mut linked = self.ensure_linked_for(&p, true).await;
        // (One Margin can't open, its name unknown: the default profile made ready instead, never the start held up
        // for it; its page says so when it's shown.)
        if !linked && self.ports.unopenable(&p) && p != DEFAULT_PROFILE {
            self.note(
                "browser: the space's Safari profile can't be opened (its name unknown): the default profile made ready instead"
                    .into(),
            );
            p = DEFAULT_PROFILE.into();
            linked = self.ensure_linked_for(&p, true).await;
        }
        if !linked {
            self.close_woken(&p).await;
            // (Said on the start screen while it's up: the person can turn the extension on, then Try again.)
            if self.prepare_wanted() && self.start_shown() {
                self.set_start(|st| st.failure = Some(STARTUP_NO_LINK.into()));
            }
            return skip(if self.prepare_wanted() {
                "its extension didn't link".into()
            } else {
                "something is shown in Margin's window (its profile not woken for it)".into()
            });
        }
        // 4. its window made ready out of sight, one at a time with the person's requests.
        let Some(c) = self.rc() else { return };
        self.exec.enqueue(async move { c.prepare_window(w, p, started).await });
    }

    /// Step 4: its window made ready over Margin's window `w`, parked out of sight.
    async fn prepare_window(&self, w: i64, p: String, started: f64) {
        let target = HostTarget::Safari(p.clone(), Role::Main);
        if self.ports.is_hosted(&target.id()) {
            return self.prepare_given_up(&p, "its window is hosted already").await;
        }
        if self.ports.engine_shown().is_some() {
            return self.prepare_given_up(&p, "something is shown in Margin's window").await;
        }
        let space = self
            .ports
            .window(Some(w))
            .filter(|w| self.ports.has_idle_placement(*w))
            .and_then(|w| self.ports.full_screen_space(self.ports.window_number(w)));
        let Some(space) = space else {
            return self.prepare_given_up(&p, "Margin's window isn't in full screen with its page area").await;
        };
        let was_active = self.ports.margin_active();
        self.edit(Field::PreparingWindow, |s| s.preparing_window = Some(w));
        self.edit(Field::PreparingProfile, |s| s.preparing_profile = Some(p.clone()));
        let t0 = self.ports.now();
        let result = self.engine("prepare", json!({ "target": target.json(), "window": w, "space": space })).await;
        self.edit(Field::PreparingWindow, |s| s.preparing_window = None);
        self.edit(Field::PreparingProfile, |s| s.preparing_profile = None);
        if was_active && !self.ports.margin_active() {
            self.ports.activate_margin();
        }
        if result.get("shown").and_then(Value::as_str).is_some() {
            let ms = |since: f64| ((self.ports.now() - since) * 1000.0).round() as i64;
            let (all, window) = (ms(started), ms(t0));
            self.note(format!("browser prepared in {all} ms (its window {window} ms), parked out of sight"));
            return self.preparation_over();
        }
        let step = result.get("failed").and_then(Value::as_str).unwrap_or("?");
        let why = result.get("why").and_then(Value::as_str).unwrap_or("");
        self.prepare_given_up(&p, &format!("{step}: {why}")).await;
    }

    /// Given up at its last step: a window opened to wake its profile closed (it was only for this), said.
    async fn prepare_given_up(&self, p: &str, why: &str) {
        self.close_woken(p).await;
        self.note(format!("browser not prepared: {why}"));
        self.preparation_over();
    }

    async fn close_woken(&self, p: &str) {
        self.waker("closeWoken", json!({ "profile": p, "except": null, "why": " (its preparation given up)" })).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn web() -> Option<Target> {
        Some(Target::Web { browser: "safari".into(), profile: None })
    }

    #[test]
    fn the_loaders_app() {
        assert_eq!(
            loader_app(&Target::App { bundle: "com.apple.Notes".into(), name: "Notes".into() }),
            Some("com.apple.Notes")
        );
        assert_eq!(loader_app(&Target::Web { browser: "chrome".into(), profile: Some("p".into()) }), Some(SAFARI));
        assert_eq!(loader_app(&Target::Margin { page: "settings".into() }), None);
    }

    // ---- T/session-rules-tests.swift lastItemTests ----

    #[test]
    fn the_newest_selected_the_smallest_id_at_a_tie() {
        let (b, a, c) = (
            json!({"selected":true,"lastUsed":50,"title":"B"}),
            json!({"selected":true,"lastUsed":50,"title":"A"}),
            json!({"selected":false,"lastUsed":90}),
        );
        let last = last_item([
            Candidate { id: "t-b", value: &b, target: web() },
            Candidate { id: "t-a", value: &a, target: web() },
            Candidate { id: "t-c", value: &c, target: web() },
        ]);
        assert_eq!(last.map(|l| (l.item, l.name)), Some(("t-a".into(), "A".into())));
        // (Either order in: the same one out.)
        let last = last_item([
            Candidate { id: "t-a", value: &a, target: web() },
            Candidate { id: "t-b", value: &b, target: web() },
        ]);
        assert_eq!(last.map(|l| l.item), Some("t-a".into()));
    }

    #[test]
    fn selected_as_swift_reads_a_bool_and_no_time_is_0() {
        let (a, b, c) = (
            json!({"selected":true,"title":""}),
            json!({"selected":1,"lastUsed":7,"title":""}),
            json!({"selected":"true","lastUsed":99}),
        );
        let last = last_item([
            Candidate { id: "u-a", value: &a, target: web() },
            Candidate { id: "u-b", value: &b, target: web() },
            Candidate { id: "u-c", value: &c, target: web() },
        ]);
        assert_eq!(last.map(|l| (l.item, l.name)), Some(("u-b".into(), "Safari".into())));
        let neg = json!({"selected":true,"lastUsed":-5});
        let none = json!({"selected":true,"lastUsed":"9"});
        let last = last_item([
            Candidate { id: "a", value: &neg, target: web() },
            Candidate { id: "b", value: &none, target: web() },
        ]);
        assert_eq!(last.map(|l| l.item), Some("b".into()), "a time that isn't a number is 0, newer than -5");
    }

    #[test]
    fn its_name_and_whether_it_can_be_hosted() {
        let v = json!({"selected":true,"lastUsed":3});
        let app = |name: &str| Some(Target::App { bundle: "com.x".into(), name: name.into() });
        let one = |target| last_item([Candidate { id: "i", value: &v, target }]);
        assert_eq!(one(app("")).map(|l| (l.name, l.app)), Some(("com.x".into(), Some("com.x".into()))));
        assert_eq!(one(app("X")).map(|l| l.name), Some("X".into()));
        assert_eq!(
            one(Some(Target::Web { browser: "chrome".into(), profile: None })),
            None,
            "another browser's: not hosted yet"
        );
        assert_eq!(one(Some(Target::Margin { page: "settings".into() })).map(|l| l.name), Some("Margin".into()));
        assert_eq!(one(None), None, "the last one has no target: none (not the one before it)");
        let titled = json!({"selected":true,"lastUsed":3,"title":"Docs"});
        assert_eq!(
            last_item([Candidate { id: "i", value: &titled, target: web() }]).map(|l| l.name),
            Some("Docs".into())
        );
        assert_eq!(last_item(Vec::new()), None);
    }
}
