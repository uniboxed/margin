//! The choice of host and profile, and the engine's window asks (docs/CORE-REFACTOR.md step 3, part 2; HostedSession
//! `host`, `profileFallback`, `resolve`, `linkWanted`, `requestSafariWindow`, `askAgain`, `closeSafariWindow`,
//! `safariFullScreen`, `safariFocus`), transliterated as requests.rs is. How a profile with no window is woken stays
//! the Mac's (SafariWaker.swift): the session asks it (`ensureLinked`), and it reads `link_wanted` at each look.
//!
//! The flows Swift calls (an engine's ask, a Swift flow's call of `show`, `close`, `profileFallback`; the palette's
//! `openApp`) start at once (`call_flow`) and answer their caller with a `Reply`.

use serde_json::{Value, json};

use super::state::role_name;
use super::target::Target;
use super::{Command, Core, Field, host_id, object, swift_int};
use crate::geometry::Rect;
use crate::hosted_browser::{Ask, Role, State};
use crate::json;
use crate::protocol::{SpaceWindowAnswer, WindowCallAnswer};

use crate::data::profiles::DEFAULT_PROFILE;

/// What's hosted (Host.swift `HostTarget`): an app by its bundle id, or a Safari profile's window in a role.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostTarget {
    App(String),
    Safari(String, Role),
}

impl HostTarget {
    /// Its host id (`HostTarget.id`): `app:<bundle>`, `safari:<profile>` and its role's suffix.
    pub fn id(&self) -> String {
        match self {
            HostTarget::App(bundle) => format!("app:{bundle}"),
            HostTarget::Safari(p, Role::Main) => format!("safari:{p}"),
            HostTarget::Safari(p, role) => format!("safari:{p}#{}", role_name(*role)),
        }
    }

    /// As the Mac's commands carry it (`{ kind: app, bundle }`, `{ kind: safari, profile, role }`).
    pub fn json(&self) -> Value {
        match self {
            HostTarget::App(bundle) => json!({ "kind": "app", "bundle": bundle }),
            HostTarget::Safari(p, role) => json!({ "kind": "safari", "profile": p, "role": role_name(*role) }),
        }
    }
}

/// A window ask answered so by a copy not in charge, or by a link that went: worth asking again once a link is back
/// (HostedSession `askAgain`).
pub fn ask_again(error: &str) -> bool {
    let e = error.to_lowercase();
    e.contains("newer copy") || e.contains("not linked") || e.contains("down")
}

/// A number as Swift's `Double.description` says it (`1.0`, `0.0001`, `1e-05`, `1e+16`).
pub(crate) fn swift_double(d: f64) -> String {
    if d.is_nan() {
        return "nan".into();
    }
    if d.is_infinite() {
        return if d > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let a = d.abs();
    if a != 0.0 && !(1e-4..1e16).contains(&a) {
        let e = format!("{d:e}");
        let (m, x) = e.split_once('e').unwrap_or((&e, "0"));
        let (sign, digits) = x.strip_prefix('-').map_or(("+", x), |x| ("-", x));
        return format!("{m}e{sign}{digits:0>2}");
    }
    let s = format!("{d}");
    if s.contains('.') { s } else { format!("{s}.0") }
}

/// A string as Swift's `debugDescription` says it (quoted, its escapes).
fn swift_quoted(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\0' => out.push_str("\\0"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '"' => out.push_str("\\\""),
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{{{:02x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A windows call's answer as the Swift log line says it (`WindowCallAnswer`'s description).
fn described(a: &WindowCallAnswer) -> String {
    match a {
        WindowCallAnswer::Asked { window_id, state } => {
            format!("asked(windowId: {window_id}, state: {})", swift_quoted(state))
        }
        WindowCallAnswer::Landed { window_id, state, at } => {
            format!("landed(windowId: {window_id}, state: {}, at: {})", swift_quoted(state), swift_double(*at))
        }
        WindowCallAnswer::TimedOut { window_id, state } => {
            format!("timedOut(windowId: {window_id}, state: {})", swift_quoted(state))
        }
        WindowCallAnswer::Busy => "busy".into(),
        WindowCallAnswer::Refused { why, past_ms } => format!(
            "refused(why: {}, pastMs: {})",
            swift_quoted(why),
            past_ms.map_or("nil".into(), |p| format!("Optional({})", swift_double(p)))
        ),
        WindowCallAnswer::Done { state } => format!(
            "done(state: {})",
            state.as_deref().map_or("nil".into(), |s| format!("Optional({})", swift_quoted(s)))
        ),
    }
}

/// `String(format: "%.1f", …)`.
pub(crate) fn secs(d: f64) -> String {
    format!("{d:.1}")
}

impl Core {
    /// A web item's Safari profile (choice.rs `resolve`, over the copies linked now).
    pub(crate) fn resolve(&self, profile: Option<&str>) -> String {
        let linked = self.ports.safari_profiles();
        super::choice::resolve(profile, &linked.iter().map(String::as_str).collect::<Vec<_>>())
    }

    /// Whether a show waiting on profile `p`'s link is still wanted: no other item asked for in a Margin window since.
    /// Nothing being shown for it: wanted. (Nothing allocated: the waker reads it at each look.)
    pub(crate) fn link_wanted(&self, p: &str) -> bool {
        self.read(|s| {
            if s.preparing_profile.as_deref() == Some(p) {
                // (The launch's preparation: until the person asks for something.)
                return s.requested.is_empty();
            }
            let main = s.showing.iter().find(|(h, _)| h.strip_prefix("safari:") == Some(p));
            let Some((_, item)) = main else { return true };
            s.requested.values().all(|r| r == item)
        })
    }

    /// The engine's open (the first time) or show, into `w`'s page area, for `item`; Margin's window made ready first.
    /// False: not shown.
    pub(crate) async fn host(&self, target: &HostTarget, w: i64, item: &str) -> bool {
        self.hosts_asked.set(self.hosts_asked.get() + 1);
        let Some((placement, token, space)) = self.prepare(w, target).await else {
            self.settle_hosting();
            return false;
        };
        let placement = super::page_area::placement_json(&placement, token);
        // (A new app's open that's waiting for its window is given up as soon as another item is picked in this
        // window, or its window closed: the engine asks `open_wanted`.)
        let args =
            json!({ "target": target.json(), "placement": placement, "space": space, "window": w, "item": item });
        let result = self.engine("open", args).await;
        if let Some(id) = result.get("shown").and_then(Value::as_str) {
            if self.ports.window(Some(w)).is_none() {
                // (Shown into a window closed while it opened: parked at once, nothing of it left where it was.)
                self.note(format!("{}: shown as Margin's window {w} closed: parked", host_id::logged(id)));
                self.engine("parkShown", json!({ "why": "its Margin window closed" })).await;
                if self.hosting() == Some(w) {
                    self.set_hosting(None);
                }
                return false;
            }
            let placed = json::flag(result.get("placed")) == Some(true);
            let how = if placed { "" } else { " (not fitted to the page area)" };
            self.note(format!("{}: shown{how}", host_id::logged(id)));
            return true;
        }
        let step = result.get("failed").and_then(Value::as_str).unwrap_or("?");
        let target_id = host_id::logged(&target.id());
        if step == "superseded" {
            if self.ports.window(Some(w)).is_none() {
                self.note(format!("{target_id}: its open given up: Margin's window {w} closed meanwhile"));
                if self.hosting() == Some(w) {
                    self.set_hosting(None);
                }
                return false;
            }
            // (Its loading bar goes with its show; Margin's window keeps hosting and its loader for the item since.)
            let since = self.requested_in(w).unwrap_or_else(|| "?".into());
            self.note(format!("{target_id}: its open given up for the item picked since ({since})"));
            return false;
        }
        let why = result.get("why").and_then(Value::as_str).unwrap_or("");
        self.note(format!("{target_id}: {step} failed: {why}"));
        self.settle_hosting();
        false
    }

    /// The profile a web item of `space` opens in: `p` when it's linked or can be woken; else the default one, said in
    /// the sidebar with the folder grant's Allow.
    pub(crate) async fn profile_fallback(&self, p: &str, space: Option<&str>) -> String {
        if p == DEFAULT_PROFILE || self.ports.safari_profiles().iter().any(|l| l == p) {
            return p.to_string();
        }
        if !self.ports.unopenable(p) && self.ensure_linked(p).await {
            return p.to_string();
        }
        if !self.ports.unopenable(p) {
            return p.to_string(); // (not woken for another reason: the show goes on and says it)
        }
        self.note("a Safari profile Margin can't open (its name unknown): the default profile used instead".into());
        let name = space.and_then(|id| {
            self.spaces()
                .into_iter()
                .find(|(s, _)| s == id)
                .and_then(|(_, v)| v.get("name")?.as_str().map(str::to_string))
        });
        let near = self.read(|s| s.hosting_window.or(s.preparing_window));
        // (Its 60 Characters counted as Unicode scalars, as step 1's caps.)
        let space: String = name.unwrap_or_default().chars().take(60).collect();
        if let Some(w) = self.ports.window(near).or_else(|| self.ports.window(None)) {
            let note = json!({ "type": "hostNote", "kind": "safari-profile", "space": space });
            self.ports.push(w, &note.to_string());
        }
        DEFAULT_PROFILE.into()
    }

    /// A profile's copy linked, woken through Safari's menu if it has no window (the Mac's SafariWaker).
    async fn ensure_linked(&self, p: &str) -> bool {
        self.ensure_linked_for(p, false).await
    }

    /// The same for the launch's preparation (`prepare`): the waker's look is `prepare_wanted`, not `link_wanted`.
    pub(crate) async fn ensure_linked_for(&self, p: &str, prepare: bool) -> bool {
        let args = if prepare { json!({ "profile": p, "prepare": true }) } else { json!({ "profile": p }) };
        let answer = self.waker("ensureLinked", args).await;
        answer.get("linked").and_then(Value::as_bool) == Some(true)
    }

    /// A window for the engine from a profile's copy (`newWindow`), in its role; its id and bounds.
    pub(crate) async fn request_window(&self, profile: Option<&str>, role: Role) -> Option<(i64, Option<Rect>)> {
        let p = self.resolve(profile);
        // (The restored-window sweep leaves this profile alone meanwhile.)
        self.edit(Field::Requesting, |s| s.requesting.insert(p.clone()));
        let made = self.request_window_in(&p, role).await;
        self.edit(Field::Requesting, |s| s.requesting.remove(&p));
        made
    }

    async fn request_window_in(&self, p: &str, role: Role) -> Option<(i64, Option<Rect>)> {
        // (The window asked for now is Margin's own: never parked as a woken one.)
        if self.ports.woken_by_menu(p) {
            self.ports.stop_hiding_woken(super::SAFARI_BUNDLE);
        }
        // (A card's or a pane's window in full screen from the start, in a Space of its own; one made ready out of
        // sight a blank page.)
        let preparing = self.read(|s| s.preparing_profile.as_deref() == Some(p));
        let mut payload = if preparing {
            object(json!({ "fullscreen": false, "url": "about:blank" }))
        } else {
            object(json!({ "fullscreen": role != Role::Main }))
        };
        // (The preview card's window opened at the card's page; a split's pane's at its pane's: never Safari's empty
        // new-tab page, whose address field keeps Safari's toolbar down over the page.)
        if role == Role::Card
            && let Some(url) = self.card_url(p)
        {
            payload.insert("url".into(), json!(url));
        }
        if let Role::Pane(_) = role {
            let key = (p.to_string(), role);
            let (address, item) = {
                let o = self.panes.borrow();
                (o.address_for.get(&key).cloned(), o.item_for.get(&key).cloned())
            };
            if let Some(address) = address
                && (address == "about:blank" || address.to_lowercase().starts_with("http"))
            {
                payload.insert("url".into(), json!(address));
            }
            if let Some(item) = item {
                payload.insert("itemId".into(), json!(item));
            }
        }
        // (The link the ask went on: one replaced while it was answered counts as back.)
        let mut asked_epoch = self.ports.link_epoch(p);
        let mut answer = self.ask_held(p, "newWindow", payload.clone(), || self.link_wanted(p)).await;
        let made = |a: &super::Asked| {
            a.result
                .as_ref()
                .and_then(SpaceWindowAnswer::from_result)
                .filter(|m| swift_int(Some(&json!(m.window_id))).is_some())
        };
        // (A copy that isn't the one in charge answers `stale`, a copy just starting can drop its link: asked again, at
        // most twice, once the profile's link is back or another copy's replaced it, waited for as long as what it's
        // for is wanted, said every `linkSayEvery`.)
        for attempt in 1..=2 {
            if made(&answer).is_some() {
                break;
            }
            let Some(e) = answer.error.clone().filter(|e| ask_again(e)) else { break };
            let epoch = asked_epoch.clone();
            self.note(format!(
                "Safari window for a profile: not made ({e}): asked again once its copy's link is back or another copy's (try {})",
                attempt + 1
            ));
            let t0 = self.ports.now();
            let mut said_at = t0;
            loop {
                let now = self.ports.link_epoch(p);
                if now.is_some() && now != epoch {
                    break;
                }
                if !self.link_wanted(p) {
                    break;
                }
                let (say_every, every) = {
                    let o = self.options.borrow();
                    (o.link_say_every, o.every)
                };
                if self.ports.now() - said_at >= say_every {
                    said_at = self.ports.now();
                    let since = secs(self.ports.now() - t0);
                    self.note(format!("Safari window for a profile: its copy's link not back yet after {since} s"));
                }
                self.sleep(every).await;
            }
            match self.ports.link_epoch(p) {
                Some(back) if Some(&back) != epoch.as_ref() => {
                    asked_epoch = Some(back);
                    answer = self.ask_held(p, "newWindow", payload.clone(), || self.link_wanted(p)).await;
                }
                _ => break,
            }
        }
        let Some(m) = made(&answer) else {
            self.note(format!(
                "Safari window for a profile: not made ({})",
                answer.error.as_deref().unwrap_or("no answer")
            ));
            return None;
        };
        self.edit(Field::SafariWindows, |s| s.safari_windows.insert((p.to_string(), role), m.window_id));
        self.edit(Field::Made, |s| s.made.insert(m.window_id));
        let its = if role == Role::Main { String::new() } else { format!(" (its {})", role_name(role)) };
        self.note(format!("Safari window {} made for hosting{its}", m.window_id));
        // The window opened only to wake the profile's copy: closed again (Margin opened it; it has no page of the
        // person's).
        self.waker_tell("closeWoken", json!({ "profile": p, "except": m.window_id, "why": "" })).await;
        Some((m.window_id, m.bounds))
    }

    /// A window a profile's copy made for Margin, closed by that copy (by the copy's id). True: the copy asked Safari,
    /// and its own list confirms it's gone.
    pub(crate) async fn close_window(&self, profile: Option<&str>, window_id: i64) -> bool {
        let p = self.resolve(profile);
        self.edit(Field::SafariWindows, |s| s.safari_windows.retain(|(k, _), id| !(k == &p && *id == window_id)));
        let answer = self.ask_held(&p, "closeWindow", object(json!({ "windowId": window_id })), || true).await;
        let called = answer.result.as_ref().is_some_and(|r| WindowCallAnswer::from_result(r).called());
        if !called {
            let why = answer.error.as_deref().unwrap_or("busy");
            self.note(format!("Safari window {window_id}: not closed by its copy ({why})"));
            return false;
        }
        // (Safari keeps a closed window's window-server window for a while, so the window server can't say it's gone.)
        let gone = self.wait(3.0, || !self.ports.window_ids_of(&p).contains(&window_id)).await;
        if !gone {
            self.note(format!("Safari window {window_id}: closed by its copy, still in its list after 3 s"));
        }
        gone
    }

    /// A window a profile's copy made for Margin, into full screen (focused) or out of it, by that copy
    /// (`setWindowState`). True: Safari was asked.
    pub(crate) async fn safari_full_screen(&self, profile: Option<&str>, window_id: i64, on: bool) -> bool {
        let p = self.resolve(profile);
        let request = Ask::SetWindowState {
            window_id,
            state: if on { State::Fullscreen } else { State::Normal },
            focused: on,
            not_after: Some((self.ports.wall() + 2.0) * 1000.0),
            land: false,
        };
        // (A request the copy's checks refuse goes as Swift built it then: no payload.)
        let payload = request.payload().unwrap_or_default();
        let answer = self.ask_held(&p, request.kind(), payload, || self.link_wanted(&p)).await;
        let Some(result) = answer.result else {
            let how = if on { "full screen" } else { "normal" };
            let why = answer.error.as_deref().unwrap_or("no answer");
            self.note(format!("Safari window {window_id}: {how} not asked of its copy ({why})"));
            return false;
        };
        let a = WindowCallAnswer::from_result(&result);
        let how = if on { "to full screen" } else { "out of full screen" };
        self.note(format!("Safari window {window_id} {how} by its copy: {}", described(&a)));
        a.called()
    }

    /// A Safari window Margin hosts brought in front of its app's others by its copy (`hostFocusWindow`). True: done.
    pub(crate) async fn safari_focus(&self, profile: Option<&str>, window_id: i64) -> bool {
        let p = self.resolve(profile);
        let not_after = (self.ports.wall() + 2.0) * 1000.0;
        let answer = self
            .ask_held(&p, "hostFocusWindow", object(json!({ "windowId": window_id, "notAfter": not_after })), || {
                self.link_wanted(&p)
            })
            .await;
        let how = if answer.result.is_some() { "done" } else { answer.error.as_deref().unwrap_or("no answer") };
        self.note(format!("Safari window {window_id} brought in front by its copy: {how}"));
        answer.result.as_ref().and_then(|r| json::flag(r.get("focused"))) == Some(true)
    }

    /// A flow Swift called: started now, as the Swift call ran its first part at once; its answer, for a caller that
    /// awaits it (`id`), a `Reply`.
    pub(crate) fn call_flow(&self, id: Option<u64>, flow: &str, args: json::Object) {
        const FLOWS: &[&str] = &[
            "show",
            "close",
            "profileFallback",
            "openApp",
            "requestWindow",
            "closeWindow",
            "safariFullScreen",
            "safariFocus",
            "applyLayout",
            "prepareBrowser",
            "openLauncher",
        ];
        if !FLOWS.contains(&flow) {
            return self.refused("call", &format!("no flow {flow:?}"));
        }
        let Some(c) = self.rc() else { return };
        let flow = flow.to_string();
        self.exec.spawn_now(async move {
            let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
            let window = swift_int(args.get("window"));
            let value = match flow.as_str() {
                "show" => {
                    if let Some(item) = s("item") {
                        c.show(&item, s("url").as_deref(), args.get("target").and_then(Target::read), window).await;
                    }
                    Value::Null
                }
                "close" => {
                    if let Some(item) = s("item") {
                        c.close(&item, args.get("target").and_then(Target::read)).await;
                    }
                    Value::Null
                }
                "profileFallback" => {
                    let p = s("profile").unwrap_or_default();
                    json!(c.profile_fallback(&p, s("space").as_deref()).await)
                }
                "openApp" => {
                    if let Some(bundle) = s("bundle") {
                        c.open_app(&bundle, window).await;
                    }
                    Value::Null
                }
                "requestWindow" => {
                    let role = s("role").and_then(|r| super::state::role_named(&r)).unwrap_or(Role::Main);
                    match c.request_window(s("profile").as_deref(), role).await {
                        Some((id, bounds)) => json!({
                            "id": id,
                            "bounds": bounds.map(|b| json!({ "x": b.x, "y": b.y, "width": b.width, "height": b.height })),
                        }),
                        None => Value::Null,
                    }
                }
                "closeWindow" => match swift_int(args.get("windowId")) {
                    Some(n) => json!(c.close_window(s("profile").as_deref(), n).await),
                    None => json!(false),
                },
                "safariFullScreen" => match swift_int(args.get("windowId")) {
                    Some(n) => {
                        let on = args.get("on").and_then(Value::as_bool) == Some(true);
                        json!(c.safari_full_screen(s("profile").as_deref(), n, on).await)
                    }
                    None => json!(false),
                },
                "safariFocus" => match swift_int(args.get("windowId")) {
                    Some(n) => json!(c.safari_focus(s("profile").as_deref(), n).await),
                    None => json!(false),
                },
                "applyLayout" => {
                    if let Some(main) = s("main") {
                        let (main_rect, extras, split) = super::layouts::layout_args(&args);
                        let focused = s("focused");
                        c.apply_layout(window, &main, main_rect, extras, focused.as_deref(), split).await;
                    }
                    Value::Null
                }
                "prepareBrowser" => {
                    c.prepare_browser(s("setting")).await;
                    Value::Null
                }
                "openLauncher" => {
                    c.open_launcher(window, args.get("settings").and_then(Value::as_bool) == Some(true)).await;
                    Value::Null
                }
                _ => Value::Null,
            };
            if let Some(to) = id {
                c.exec.command(Command::Reply { to, value }).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_ids_and_the_swifts_words() {
        assert_eq!(HostTarget::App("com.a".into()).id(), "app:com.a");
        assert_eq!(HostTarget::Safari("p".into(), Role::Main).id(), "safari:p");
        assert_eq!(HostTarget::Safari("p".into(), Role::Pane(2)).id(), "safari:p#pane2");
        assert_eq!(HostTarget::Safari("".into(), Role::Card).id(), "safari:#card");
        for (e, again) in [
            ("a newer copy of Margin is running", true),
            ("Not Linked", true),
            ("its link went down", true),
            ("refused", false),
            ("", false),
        ] {
            assert_eq!(ask_again(e), again, "{e}");
        }
        // (Swift's own descriptions, Swift 6.4, 2026-11-23.)
        for (d, swift) in [
            (1.0, "1.0"),
            (0.0, "0.0"),
            (1_800_000_000_000.5, "1800000000000.5"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (1e16, "1e+16"),
            (9_007_199_254_740_992.0, "9007199254740992.0"),
            (1e15, "1000000000000000.0"),
            (-3.25, "-3.25"),
            (1.2345678901234568e17, "1.2345678901234568e+17"),
        ] {
            assert_eq!(swift_double(d), swift, "{d}");
        }
        assert_eq!(described(&WindowCallAnswer::Busy), "busy");
        assert_eq!(
            described(&WindowCallAnswer::Refused { why: "late".into(), past_ms: Some(3.0) }),
            r#"refused(why: "late", pastMs: Optional(3.0))"#
        );
        assert_eq!(described(&WindowCallAnswer::Done { state: None }), "done(state: nil)");
        assert_eq!(
            described(&WindowCallAnswer::Asked { window_id: 90, state: "a\"b'c".into() }),
            r#"asked(windowId: 90, state: "a\"b\'c")"#
        );
        assert_eq!(
            (secs(0.25), secs(0.35), secs(1.05), secs(12.0)),
            ("0.2".into(), "0.3".into(), "1.1".into(), "12.0".into())
        );
    }
}
