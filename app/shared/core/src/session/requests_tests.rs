//! The library's requests, `show`, `close`, `openApp`, the choice of host and profile and the engine's window asks
//! (requests.rs, hosting.rs) through the re-entrant test adapter: what each flow asks of Margin's windows, the engine,
//! the copies, the library (the core's own object: its edits the rules', their requests back through its sink) and the
//! Swift flows not moved yet, in order. (The same flows are compared against the deleted Swift on generated vectors in
//! the step's harness; these pin the shapes.)

use super::*;

/// The commands a run handed out, each answered by `answer` after the run's tick; deadlines ticked on the world's clock
/// when nothing else is left. (A library edit is no command: the library's perform, made in the flow's turn.)
pub(super) fn pump(s: &Session, world: &World, first: Out, answer: &mut dyn FnMut(&Command) -> Value) -> Vec<Command> {
    let mut seen = Vec::new();
    let mut out = first;
    for _ in 0..10_000 {
        let starts = std::mem::take(&mut out.start);
        if starts.is_empty() {
            if out.ready {
                out = s.tick(0.0);
                continue;
            }
            match out.deadline {
                Some(at) => {
                    world.now.set(at);
                    out = s.tick(at);
                    continue;
                }
                None => break,
            }
        }
        let mut later = Vec::new();
        for (id, c) in starts {
            seen.push(c.clone());
            let a = answer(&c);
            engine_after(world, &c, &a);
            later.push((id, a));
        }
        let mut next = s.tick(0.0);
        for (id, a) in later {
            let o = s.answer(id, a);
            next.start.extend(o.start);
            next.ready |= o.ready;
            next.deadline = o.deadline;
        }
        out = next;
    }
    seen
}

/// What the engine shows after an operation (its `shown`, read by the hosting's settle): what an open or show showed,
/// nothing after a park; the rest leave it.
pub(super) fn engine_after(world: &World, c: &Command, a: &Value) {
    if let Command::Engine { op, .. } = c {
        match op.as_str() {
            "open" | "show" | "prepare" => {
                if let Some(id) = a.get("shown").and_then(Value::as_str)
                    && op != "prepare"
                {
                    *world.shown.borrow_mut() = Some(id.to_string());
                }
            }
            "setLayout" => {
                // (The layout's first result shown is the one shown: its main.)
                let main = a.get("results").and_then(Value::as_array).and_then(|r| r.first());
                if let Some(id) = main.and_then(|r| r.get(0)).and_then(Value::as_str)
                    && main.and_then(|r| r.get(1)).and_then(|v| v.get("shown")).is_some()
                {
                    *world.shown.borrow_mut() = Some(id.to_string());
                }
            }
            "parkShown" => *world.shown.borrow_mut() = None,
            _ => {}
        }
    }
}

/// The usual answers: the engine's open shown, a copy's hostShow a tab.
pub(super) fn usual(c: &Command) -> Value {
    match c {
        Command::Engine { op, args } if op == "open" => {
            json!({ "shown": json::string(json::object(args.get("target")).and_then(|t| t.get("kind"))).map(|k| if k == "app" { format!("app:{}", args["target"]["bundle"].as_str().unwrap_or("")) } else { format!("safari:{}", args["target"]["profile"].as_str().unwrap_or("")) }), "placed": true })
        }
        Command::Ask { kind, .. } if kind == "hostShow" => json!({ "result": { "tabId": 501, "created": true } }),
        Command::Ask { kind, .. } if kind == "newWindow" => json!({ "result": { "windowId": 90, "state": "normal" } }),
        Command::Waker { op, .. } if op == "ensureLinked" => json!({ "linked": true }),
        _ => json!({ "result": {} }),
    }
}

pub(super) fn kinds(cs: &[Command]) -> Vec<String> {
    cs.iter()
        .map(|c| match c {
            Command::Ask { kind, .. } => format!("ask {kind}"),
            Command::Run { .. } => "run".into(),
            Command::Engine { op, .. } => format!("engine {op}"),
            Command::Waker { op, .. } => format!("waker {op}"),
            Command::Reply { .. } => "reply".into(),
            Command::Done { .. } => "done".into(),
            Command::Cancel { .. } => "cancel".into(),
        })
        .collect()
}

pub(super) fn acts(world: &World) -> Vec<Value> {
    std::mem::take(&mut *world.acts.borrow_mut())
}

pub(super) fn named(acts: &[Value], name: &str) -> Vec<Value> {
    acts.iter().filter(|a| a[0] == json!(name) || a[1] == json!(name)).cloned().collect()
}

/// The library edits made so far (`["perform", action, payload]`), taken out of the acts (the rest left).
pub(super) fn performed(world: &World) -> Vec<Value> {
    let mut acts = world.acts.borrow_mut();
    let (edits, rest): (Vec<Value>, Vec<Value>) = acts.drain(..).partition(|a| a[0] == json!("perform"));
    *acts = rest;
    edits
}

/// A space and the window showing it, as stored.
pub(super) fn space(lib: &TestLibrary, id: &str, window: i64) {
    lib.put(
        "spaces",
        id,
        json!({ "name": id, "emoji": "", "color": "", "order": 0, "browser": "safari", "profile": null }),
    );
    lib.put("windows", &window.to_string(), json!({ "spaceId": id }));
}

pub(super) fn item(lib: &TestLibrary, id: &str, v: Value) {
    lib.put("tabs", id, v);
}

#[test]
fn a_show_request_drawn_in_front_at_once_then_an_app_hosted() {
    let (s, world, lib) = session();
    world.names.borrow_mut().insert("com.apple.Notes".into(), "Notes".into());
    item(&lib, "a1", json!({ "target": { "kind": "app", "bundleId": "com.apple.Notes", "name": "" }, "title": "N" }));
    let out = s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a1", "windowId": 1 } }));
    assert!(out.ready && out.start.is_empty(), "handled in the queue, after the caller's code");
    assert_eq!(s.core().requested_in(1).as_deref(), Some("a1"), "in front at once");
    let a = acts(&world);
    assert_eq!(a, [json!(["changed"])], "(no card there to hide: card.rs, the core's own)");
    let seen = pump(&s, &world, out, &mut usual);
    assert_eq!(kinds(&seen), ["engine open"]);
    let Command::Engine { args, .. } = &seen[0] else { panic!() };
    assert_eq!(args["target"], json!({ "kind": "app", "bundle": "com.apple.Notes" }));
    assert_eq!(
        (args["window"].clone(), args["item"].clone(), args["space"].clone()),
        (json!(1), json!("a1"), json!(7))
    );
    assert_eq!(s.done(), ["app:com.apple.Notes: shown"]);
    assert_eq!(s.core().shown_in(1).as_deref(), Some("a1"));
    assert_eq!(s.core().open_item("a1"), Some(OpenItem { host: "app:com.apple.Notes".into(), profile: None }));
    assert_eq!(s.core().requested_in(1), None);
    assert_eq!(s.core().label("app:com.apple.Notes").as_deref(), Some("Notes"));
    let a = acts(&world);
    // (The loader with the app's name and icon, cleared once it's shown; the loading bar refreshed; the windows told;
    // the hosting settled after the request: the core's now, nothing to settle, nothing hosting.)
    assert_eq!(
        named(&a, "setShowing"),
        [json!(["setShowing", 1, "Notes", "com.apple.Notes", false]), json!(["setShowing", 1, null, null, false])]
    );
    let order: Vec<String> = a.iter().map(|v| v[1].as_str().or(v[0].as_str()).unwrap_or("").to_string()).collect();
    let at = |n: &str| order.iter().position(|o| o == n).unwrap_or(usize::MAX);
    // (The loading bar refreshed before them is the core's now: nothing loading, no window told.)
    assert!(
        at("changed") < usize::MAX && at("setLoadingTabs") == usize::MAX && at("clearCover") == usize::MAX,
        "{order:?}"
    );
    assert!(s.idle());
}

#[test]
fn a_show_overtaken_before_it_started_is_skipped_and_a_failed_one_draws_the_one_before() {
    let (s, world, lib) = session();
    item(&lib, "a1", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    item(&lib, "a2", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" } }));
    s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a1", "windowId": 1 } }));
    let out = s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a2", "windowId": 1 } }));
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Engine { op, .. } if op == "open" => json!({ "failed": "launch", "why": "no such app" }),
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["engine open"]);
    assert_eq!(s.done(), ["a1: not shown, a2 asked for since", "app:com.b: launch failed: no such app"]);
    assert_eq!(s.core().shown_in(1), None);
    assert_eq!(s.core().requested_in(1), None, "no longer asked for");
    let a = acts(&world);
    // (And the hosting settled after it: nothing shown, Margin's window not hosting, its launcher.)
    assert_eq!(named(&a, "changed").len(), 4, "two asks, the failure drawing the one before, the settle: {a:?}");
    assert_eq!(s.input(&json!({ "type": "overtaken", "item": "x", "window": 1 })).reply, Some(json!(false)));
}

#[test]
fn a_web_item_its_profiles_window_made_then_its_tab_shown() {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    item(
        &lib,
        "w1",
        json!({ "target": { "kind": "web", "browser": "safari", "profile": null }, "url": "https://a/", "title": "" }),
    );
    let mut made = false;
    let out = s.input(&json!({ "type": "library", "request": { "type": "newTab", "item": "w1", "windowId": 1 } }));
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Engine { op, .. } if op == "open" => {
            made = true;
            // (The engine asks for the window as it opens: the copy makes it.)
            s.core().edit(Field::SafariWindows, |st| st.safari_windows.insert(("s-default".into(), Role::Main), 90));
            json!({ "shown": "safari:s-default", "placed": false })
        }
        c => usual(c),
    });
    assert!(made);
    assert_eq!(kinds(&seen), ["engine open", "ask hostShow"]);
    let Command::Ask { payload, profile, .. } = &seen[1] else { panic!() };
    assert_eq!(profile, "s-default");
    assert_eq!(
        Value::Object(payload.clone()),
        json!({ "windowId": 90, "itemId": "w1", "url": "https://a/", "pinned": false })
    );
    assert_eq!(s.done(), ["safari:p8010: shown (not fitted to the page area)", "w1: shown in Safari window 90"]);
    assert_eq!(
        s.core().open_item("w1"),
        Some(OpenItem { host: "safari:s-default".into(), profile: Some("s-default".into()) })
    );
    assert_eq!(s.core().read(|st| st.safari_tabs.get("w1").copied()), Some(501));
    let a = acts(&world);
    assert_eq!(
        named(&a, "setShowing")[0],
        json!(["setShowing", 1, "Safari", "com.apple.Safari", false]),
        "no title: Safari's name"
    );
}

#[test]
fn a_pins_open_and_reset_the_four_paths_as_one() {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    // An open with no item: one made (in front, bound to the pin), then shown; refused: said.
    let out = s.input(&json!({ "type": "library", "request": { "type": "openPin", "url": "https://p/", "pin": "pin1", "windowId": 1, "spaceId": "sp" } }));
    assert!(pump(&s, &world, out, &mut usual).is_empty());
    assert_eq!(
        performed(&world),
        [
            json!(["perform", "addItem", { "url": "https://p/", "front": true, "spaceId": "sp", "windowId": 1, "pinnedBy": "pin1" }])
        ]
    );
    assert_eq!(s.done().last().map(String::as_str), Some("openPin: no item made (no space)"), "the library has none");
    // A favourite's reset with no item, refused: silent, its own key.
    let n = s.done().len();
    let out = s.input(
        &json!({ "type": "library", "request": { "type": "resetFavorite", "url": "https://f/", "favorite": "fav1" } }),
    );
    assert!(pump(&s, &world, out, &mut usual).is_empty());
    assert_eq!(
        performed(&world),
        [json!(["perform", "addItem", { "url": "https://f/", "front": true, "favoriteId": "fav1" }])]
    );
    assert_eq!(s.done().len(), n, "a reset that made nothing says nothing");
    // A pin's open with a space: its item made, bound to the pin (the library's own), then shown in its window.
    space(&lib, "sp", 1);
    lib.put("pins", "pin1", json!({ "spaceId": "sp", "url": "https://p/", "title": "P", "folderId": null, "pos": 0 }));
    let out = s.input(&json!({ "type": "library", "request": { "type": "openPin", "url": "https://p/", "pin": "pin1", "windowId": 1, "spaceId": "sp" } }));
    let seen = pump(&s, &world, out, &mut usual);
    assert_eq!(kinds(&seen), ["engine open"]);
    assert_eq!(performed(&world).len(), 1);
    let made = lib.lib.live("tabs").into_iter().find(|(_, v)| v["pinnedBy"] == json!("pin1")).map(|(id, _)| id);
    let Command::Engine { args, .. } = &seen[0] else { panic!() };
    assert!(made.as_deref().is_some_and(|m| m.starts_with("t-")), "{made:?}");
    assert_eq!(args["item"].as_str(), made.as_deref(), "{args:?}");
    lib.clear();
    // A reset with no address: nothing at all.
    let out = s.input(&json!({ "type": "library", "request": { "type": "resetPin", "item": "w1" } }));
    assert!(pump(&s, &world, out, &mut usual).is_empty());
    // A reset of an open item: its tab back at its address first, then shown.
    item(
        &lib,
        "w1",
        json!({ "target": { "kind": "web", "browser": "safari", "profile": "s-default" }, "url": "https://moved/" }),
    );
    s.core().edit(Field::Open, |st| {
        st.open.insert("w1".into(), OpenItem { host: "safari:s-default".into(), profile: Some("s-default".into()) })
    });
    s.core().edit(Field::SafariWindows, |st| st.safari_windows.insert(("s-default".into(), Role::Main), 90));
    world.hosted.borrow_mut().push("safari:s-default".into());
    *world.shown.borrow_mut() = Some("safari:s-default".into());
    s.core().set_hosting(Some(1));
    let out = s.input(&json!({ "type": "library", "request": { "type": "resetPin", "item": "w1", "url": "https://p/", "windowId": 1 } }));
    let seen = pump(&s, &world, out, &mut usual);
    assert_eq!(kinds(&seen), ["ask hostNavigate", "ask hostShow"], "a tab switch in the window shown");
    let Command::Ask { payload, .. } = &seen[1] else { panic!() };
    assert_eq!(payload["url"], json!("https://p/"), "the pin's address, not the item's");
    // Overtaken (Tirth, 2026-11-23): its tab back at its address still, not shown; the item picked after it is.
    item(
        &lib,
        "w2",
        json!({ "target": { "kind": "web", "browser": "safari", "profile": "s-default" }, "url": "https://two/" }),
    );
    for kind in ["resetPin", "resetFavorite"] {
        let n = s.done().len();
        s.input(&json!({ "type": "library", "request": { "type": kind, "item": "w1", "url": "https://p/", "windowId": 1 } }));
        let out =
            s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "w2", "windowId": 1 } }));
        let seen = pump(&s, &world, out, &mut usual);
        assert_eq!(kinds(&seen), ["ask hostNavigate", "ask hostShow"], "{kind}");
        let (Command::Ask { kind: k0, payload: p0, .. }, Command::Ask { payload: p1, .. }) = (&seen[0], &seen[1])
        else {
            panic!()
        };
        assert_eq!(
            (k0.as_str(), p0["itemId"].clone(), p1["itemId"].clone()),
            ("hostNavigate", json!("w1"), json!("w2")),
            "{kind}"
        );
        assert_eq!(s.done()[n], "w1: not shown, w2 asked for since", "{kind}");
        assert_eq!(s.core().shown_in(1).as_deref(), Some("w2"));
    }
}

#[test]
fn a_cycles_pick_of_an_app_not_running_held_and_never_started_when_passed_over() {
    let (s, world, lib) = session();
    world.runs.borrow_mut().insert("com.a".into(), false);
    world.now.set(100.0);
    item(&lib, "a1", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    item(&lib, "a2", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" } }));
    s.input(&json!({ "type": "cycled", "window": 1 }));
    let out = s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a1", "windowId": 1 } }));
    let mut first = s.tick(0.0);
    assert!(first.start.is_empty() && first.deadline.is_some(), "held: a sleep, nothing started");
    let _ = out;
    // (The next press passes over it: the hold ends at its next look.)
    world.now.set(100.1);
    s.input(&json!({ "type": "cycled", "window": 1 }));
    s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a2", "windowId": 1 } }));
    first.ready = true;
    let seen = pump(&s, &world, first, &mut usual);
    assert_eq!(s.done()[0], "a1: passed over by the tab keys (com.a not started)");
    assert_eq!(kinds(&seen), ["engine open"], "only the second (com.b's running state unknown: never held)");
    // A click (no key) is never held.
    let (s, world, lib) = session();
    world.runs.borrow_mut().insert("com.a".into(), false);
    item(&lib, "a1", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    let out = s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a1", "windowId": 1 } }));
    assert_eq!(kinds(&pump(&s, &world, out, &mut usual)), ["engine open"]);
}

#[test]
fn closing_its_page_closed_the_next_one_shown_and_the_split_around_it_again() {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    item(&lib, "w1", json!({ "target": { "kind": "web", "browser": "safari", "profile": "s-default" } }));
    item(&lib, "a2", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" } }));
    s.core().edit(Field::Open, |st| {
        st.open.insert("w1".into(), OpenItem { host: "safari:s-default".into(), profile: Some("s-default".into()) })
    });
    s.core().edit(Field::Shown, |st| st.shown.insert(1, "w1".into()));
    s.core().edit(Field::Shown, |st| st.shown.insert(2, "a2".into()));
    // (Window 2's split has it as a pane: shown again without it.)
    let pane = Layout {
        main: "a2".into(),
        main_rect: None,
        extras: vec![state::Extra { item: "w1".into(), role: "pane".into(), rect: Rect::ZERO }],
        focused: "a2".into(),
        split: None,
    };
    s.core().edit(Field::Layouts, |st| st.layouts.insert(2, pane));
    world.windows.borrow_mut().push(2);
    let out = s.input(
        &json!({ "type": "library", "request": { "type": "closeTab", "item": "w1", "next": "a2", "windowId": 1 } }),
    );
    let seen = pump(&s, &world, out, &mut usual);
    // (The next item shown in window 1, then the split around it in window 2: window 1's parked first, pictured.)
    assert_eq!(kinds(&seen), ["ask hostClose", "engine open", "engine parkShown", "engine open"]);
    assert_eq!(s.done()[0], "w1: closed");
    assert_eq!(s.core().open_item("w1"), None);
    // Clear today: each closed, a list of strings only.
    let out = s.input(&json!({ "type": "library", "request": { "type": "clearToday", "items": ["a2", 5] } }));
    assert!(pump(&s, &world, out, &mut usual).is_empty());
    let out = s.input(&json!({ "type": "library", "request": { "type": "unknownKind" } }));
    pump(&s, &world, out, &mut usual);
    assert_eq!(s.done().last().map(String::as_str), Some("unknownKind: nothing to host"));
}

#[test]
fn the_profile_fallback_said_once_its_profile_cant_be_opened() {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    world.unopenable.borrow_mut().push("s-work".into());
    lib.put("spaces", "sp", json!({ "name": "Work", "order": 1 }));
    item(&lib, "w1", json!({ "target": { "kind": "web", "browser": "safari", "profile": "s-work" }, "spaceId": "sp" }));
    let out = s.input(
        &json!({ "type": "call", "id": 7, "flow": "profileFallback", "args": { "profile": "s-work", "space": "sp" } }),
    );
    let first = out.clone();
    let a = acts(&world);
    assert_eq!(
        a,
        [json!(["push", 1, r#"{"type":"hostNote","kind":"safari-profile","space":"Work"}"#])],
        "said at once"
    );
    let reply = out.start.iter().find_map(|(_, c)| match c {
        Command::Reply { to, value } => Some((*to, value.clone())),
        _ => None,
    });
    assert_eq!(reply, Some((7, json!("s-default"))));
    // Linked or woken: its own; not woken for another reason: its own still (the show says it).
    pump(&s, &world, first, &mut usual);
    let out = s.input(&json!({ "type": "call", "id": 8, "flow": "profileFallback", "args": { "profile": "s-home" } }));
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Waker { .. } => json!({ "linked": false }),
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["waker ensureLinked", "reply"]);
    let Command::Reply { value, .. } = &seen[1] else { panic!() };
    assert_eq!(value, &json!("s-home"));
}

#[test]
fn a_window_asked_of_a_stale_copy_asked_again_once_its_link_is_back() {
    let (s, world, _) = session();
    world.profiles.borrow_mut().push("s-default".into());
    {
        let mut p = s.core().panes.borrow_mut();
        p.address_for.insert(("s-default".into(), Role::Pane(2)), "HTTPS://pane/".into());
        p.item_for.insert(("s-default".into(), Role::Pane(2)), "w2".into());
    }
    let mut asks = 0;
    let out = s.input(
        &json!({ "type": "call", "id": 1, "flow": "requestWindow", "args": { "profile": null, "role": "pane2" } }),
    );
    assert!(s.core().read(|st| st.requesting.contains("s-default")), "the sweep leaves it alone from the ask");
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Ask { kind, .. } if kind == "newWindow" => {
            asks += 1;
            if asks == 1 {
                world.epochs.borrow_mut().insert("s-default".into(), "e2".into());
                json!({ "result": null, "error": "a newer copy of Margin is running" })
            } else {
                json!({ "result": { "windowId": 93, "state": "normal", "bounds": { "left": 1, "top": 2, "width": 3, "height": 4 } } })
            }
        }
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["ask newWindow", "ask newWindow", "waker closeWoken", "reply"]);
    let Command::Ask { payload, .. } = &seen[0] else { panic!() };
    assert_eq!(Value::Object(payload.clone()), json!({ "fullscreen": true, "url": "HTTPS://pane/", "itemId": "w2" }));
    let Command::Reply { value, .. } = &seen[3] else { panic!() };
    assert_eq!(value, &json!({ "id": 93, "bounds": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 } }));
    assert_eq!(
        s.done(),
        [
            "Safari window for a profile: not made (a newer copy of Margin is running): asked again once its copy's link is back or another copy's (try 2)",
            "Safari window 93 made for hosting (its pane2)"
        ]
    );
    assert_eq!(s.core().safari_window("s-default", Role::Pane(2)), Some(93));
    assert!(s.core().read(|st| st.made.contains(&93) && st.requesting.is_empty()));
    // The window the launch's preparation asks for: a blank page, not in full screen, whatever its role.
    let (s, world, _) = session();
    world.profiles.borrow_mut().push("s-prep".into());
    s.core().edit(Field::PreparingProfile, |st| st.preparing_profile = Some("s-prep".into()));
    let out = s.input(
        &json!({ "type": "call", "id": 4, "flow": "requestWindow", "args": { "profile": "s-prep", "role": "card" } }),
    );
    let seen = pump(&s, &world, out, &mut usual);
    let Command::Ask { payload, .. } = &seen[0] else { panic!() };
    assert_eq!(Value::Object(payload.clone()), json!({ "fullscreen": false, "url": "about:blank" }));
    // Stale three times, its link replaced each time: asked again twice at most, then given up.
    let (s, world, _) = session();
    world.profiles.borrow_mut().push("s-default".into());
    let mut n = 0;
    let out = s.input(&json!({ "type": "call", "id": 3, "flow": "requestWindow", "args": { "profile": "s-default", "role": "main" } }));
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Ask { .. } => {
            n += 1;
            world.epochs.borrow_mut().insert("s-default".into(), format!("e{}", n + 1));
            json!({ "error": "a newer copy of Margin is running" })
        }
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["ask newWindow", "ask newWindow", "ask newWindow", "reply"]);
    assert_eq!(
        s.done().last().map(String::as_str),
        Some("Safari window for a profile: not made (a newer copy of Margin is running)")
    );
    // Nothing waits for it any more (another item asked for): not asked at all (docs/LINK-RESILIENCE.md: a copy's
    // request made for an engine operation is raced against being wanted), said.
    let (s, world, _) = session();
    world.profiles.borrow_mut().push("s-default".into());
    s.core().edit(Field::Requested, |st| st.requested.insert(1, "other".into()));
    s.core().edit(Field::Showing, |st| st.showing.insert("safari:s-default".into(), "mine".into()));
    let out = s.input(&json!({ "type": "call", "id": 2, "flow": "requestWindow", "args": { "profile": "s-default", "role": "main" } }));
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Ask { .. } => json!({ "error": "not linked" }),
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["reply"]);
    assert_eq!(
        s.done().last().map(String::as_str),
        Some("Safari window for a profile: not made (given up (no longer wanted))")
    );
}

#[test]
fn a_window_closed_full_screen_and_focused_by_its_copy() {
    let (s, world, _) = session();
    world.profiles.borrow_mut().push("s-default".into());
    s.core().edit(Field::SafariWindows, |st| st.safari_windows.insert(("s-default".into(), Role::Card), 91));
    world.windows_of.borrow_mut().insert("s-default".into(), vec![91]);
    let out = s
        .input(&json!({ "type": "call", "id": 1, "flow": "closeWindow", "args": { "profile": null, "windowId": 91 } }));
    assert_eq!(s.core().safari_window("s-default", Role::Card), None, "forgotten at once");
    let seen = pump(&s, &world, out, &mut usual);
    let Some(Command::Reply { value, .. }) = seen.last() else { panic!() };
    assert_eq!(value, &json!(false), "still in its list after 3 s");
    assert_eq!(
        s.done().last().map(String::as_str),
        Some("Safari window 91: closed by its copy, still in its list after 3 s")
    );
    let out = s
        .input(&json!({ "type": "call", "id": 2, "flow": "safariFullScreen", "args": { "windowId": 90, "on": true } }));
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Ask { .. } => json!({ "result": { "windowId": 90, "state": "fullscreen", "asked": true } }),
        c => usual(c),
    });
    let Command::Ask { kind, payload, .. } = &seen[0] else { panic!() };
    assert_eq!(kind, "setWindowState");
    assert_eq!(
        Value::Object(payload.clone()),
        json!({ "windowId": 90, "state": "fullscreen", "notAfter": 1_800_000_002_000_i64, "land": false, "focused": true })
    );
    assert_eq!(
        s.done().last().map(String::as_str),
        Some(r#"Safari window 90 to full screen by its copy: asked(windowId: 90, state: "fullscreen")"#)
    );
    let out = s.input(&json!({ "type": "call", "id": 3, "flow": "safariFocus", "args": { "windowId": 90 } }));
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Ask { .. } => json!({ "result": { "focused": 1 } }),
        c => usual(c),
    });
    let Command::Ask { kind, payload, .. } = &seen[0] else { panic!() };
    assert_eq!((kind.as_str(), payload["notAfter"].clone()), ("hostFocusWindow", json!(1_800_000_002_000.0)));
    let Some(Command::Reply { value, .. }) = seen.last() else { panic!() };
    assert_eq!(value, &json!(true), "Swift's `as? Bool` takes a 1");
}

#[test]
fn an_app_picked_in_the_palette() {
    let (s, world, lib) = session();
    space(&lib, "sp", 1);
    item(&lib, "old", json!({ "url": "app://com.b", "spaceId": "sp" }));
    for (bundle, want, line) in [
        ("com.google.Chrome.beta", vec![], Some("com.google.Chrome.beta: Chrome and Edge aren't hosted yet")),
        ("COM.unibox.margin", vec!["newTab"], Some("Margin picked in its own palette: the surprise")),
        ("com.apple.Safari", vec!["newTab"], None),
        ("com.b", vec!["activateTab"], None),
    ] {
        let n = s.done().len();
        let out = s.input(&json!({ "type": "call", "flow": "openApp", "args": { "bundle": bundle, "window": null } }));
        pump(&s, &world, out, &mut usual);
        let edits: Vec<Value> = performed(&world).iter().map(|e| e[1].clone()).collect();
        assert_eq!(edits, want, "{bundle}");
        // (The flow's own line; a new item's show says its own after it, `t-…: …`.)
        let own = s.done()[n..].iter().find(|l| !l.starts_with("t-")).cloned();
        assert_eq!(own.as_deref(), line, "{bundle}");
    }
    let out = s.input(&json!({ "type": "call", "flow": "openApp", "args": { "bundle": "com.c", "window": 1 } }));
    let seen = pump(&s, &world, out, &mut usual);
    assert_eq!(
        performed(&world),
        [
            json!(["perform", "addItem", { "windowId": 1, "target": { "kind": "app", "bundleId": "com.c", "name": "com.c" }, "front": true, "spaceId": "sp" }])
        ]
    );
    assert_eq!(kinds(&seen), ["engine open"]);
    let made =
        lib.lib.live("tabs").into_iter().find(|(_, v)| v["target"]["bundleId"] == json!("com.c")).map(|(id, _)| id);
    let made = made.expect("the app's item, in the library");
    assert!(made.starts_with("t-"));
    assert_eq!(s.done()[s.done().len() - 2], format!("com.c: item {made} added"));
}

#[test]
fn link_wanted_and_open_wanted() {
    let (s, _, _) = session();
    assert!(s.link_wanted("p"), "nothing shown for it");
    s.core().edit(Field::Showing, |st| st.showing.insert("safari:p".into(), "t1".into()));
    s.core().edit(Field::Requested, |st| st.requested.insert(1, "t1".into()));
    assert!(s.link_wanted("p"));
    s.core().edit(Field::Requested, |st| st.requested.insert(2, "t2".into()));
    assert!(!s.link_wanted("p"), "another asked for since");
    s.core().edit(Field::PreparingProfile, |st| st.preparing_profile = Some("p".into()));
    assert!(!s.link_wanted("p"), "the launch's preparation: until something's asked for");
    s.core().edit(Field::Requested, |st| st.requested.clear());
    assert!(s.link_wanted("p"));
    assert!(s.open_wanted(1, "t1"));
    s.core().edit(Field::Requested, |st| st.requested.insert(1, "t2".into()));
    assert!(!s.open_wanted(1, "t1") && s.open_wanted(1, "t2"));
    assert!(!s.open_wanted(5, "t2"), "its window gone");
}

// ---- the library object as the requests' source (step 4 part 7) ------------------------------------------------------

#[test]
fn the_librarys_requests_reach_the_session_inside_its_perform() {
    // The session as the library's sink (`Library::set_sink`, as margin_session_new registers it): a perform's request
    // is the session's `library` input inside the perform (the item in front at once), its show started by the
    // caller's next tick, reading the item from the library object (re-entered on every port and callback).
    let (s, world, lib) = session();
    world.names.borrow_mut().insert("com.apple.Notes".into(), "Notes".into());
    let l = &lib.lib;
    let space = l.perform("createSpace", &json!({ "windowId": 1, "name": "A" })).outcome.result["spaceId"].clone();
    let added = l.perform(
        "addItem",
        &json!({ "spaceId": space, "target": { "kind": "app", "bundleId": "com.apple.Notes", "name": "Notes" } }),
    );
    let item = added.outcome.result["tabId"].as_str().expect("an item").to_owned();
    acts(&world);
    let out = l.perform("activateTab", &json!({ "windowId": 1, "tabId": item }));
    assert!(out.outcome.ok, "{out:?}");
    assert_eq!(s.core().requested_in(1).as_deref(), Some(item.as_str()), "in front at once, inside the perform");
    assert_eq!(
        acts(&world),
        [json!(["libraryChanged", ["tabs"]]), json!(["changed"])],
        "its observers, then the session"
    );
    assert!(s.ready(), "what it queued waits for the caller's tick");
    let seen = pump(&s, &world, s.tick(0.0), &mut usual);
    assert_eq!(kinds(&seen), ["engine open"], "its show, on the caller's next tick");
    let Command::Engine { args, .. } = &seen[0] else { panic!() };
    assert_eq!(args["target"], json!({ "kind": "app", "bundle": "com.apple.Notes" }));
    assert_eq!(s.core().shown_in(1).as_deref(), Some(item.as_str()));
    assert!(world.reentries.get() > 0, "the session re-entered on its ports throughout");
    // A perform Swift makes itself, outside a call: what its requests left answered by the `edited` input (their lines,
    // nothing run in it), then run at the caller's tick, as the `library` input answered the delegate.
    l.perform("closeTab", &json!({ "windowId": 1, "tabId": item }));
    let left = s.input(&json!({ "type": "edited" }));
    assert!(left.ready && left.start.is_empty() && left.error.is_none(), "{left:?}");
    let n = s.done().len();
    pump(&s, &world, left, &mut usual);
    assert_eq!(s.done()[n..], [format!("{item}: closed")], "{:?}", s.done());
}

// ---- a show waiting on a slow copy (docs/LINK-RESILIENCE.md §1, the session's rules 7–10) ----------------------------

/// As `pump`, with commands held: `answer`'s None keeps one unanswered (the test answers it later by its id, or
/// never); deadlines ticked on the world's clock `ticks` times at most. What was handed out, and the held ones.
fn pump_holding(
    s: &Session,
    world: &World,
    first: Out,
    ticks: usize,
    answer: &mut dyn FnMut(&Command) -> Option<Value>,
) -> (Vec<Command>, Vec<(u64, Command)>) {
    let (mut seen, mut held) = (Vec::new(), Vec::new());
    let mut out = first;
    let mut left = ticks;
    for _ in 0..10_000 {
        let starts = std::mem::take(&mut out.start);
        if starts.is_empty() {
            if out.ready {
                out = s.tick(0.0);
                continue;
            }
            match out.deadline {
                Some(at) if left > 0 => {
                    left -= 1;
                    world.now.set(at);
                    out = s.tick(at);
                    continue;
                }
                _ => break,
            }
        }
        let mut later = Vec::new();
        for (id, c) in starts {
            seen.push(c.clone());
            match answer(&c) {
                Some(a) => {
                    engine_after(world, &c, &a);
                    later.push((id, a));
                }
                None => held.push((id, c)),
            }
        }
        let mut next = s.tick(0.0);
        for (id, a) in later {
            let o = s.answer(id, a);
            next.start.extend(o.start);
            next.ready |= o.ready;
            next.deadline = o.deadline;
        }
        out = next;
    }
    (seen, held)
}

/// The copy never answers a `hostShow`; everything else as usual.
fn host_show_held(c: &Command) -> Option<Value> {
    match c {
        Command::Ask { kind, .. } if kind == "hostShow" => None,
        c => Some(usual(c)),
    }
}

/// A web item `w1` of s-default whose Safari window (90) is the one window 1 shows: its show a tab switch alone; and
/// an app item `a1`.
fn tab_switch_world() -> (Session, Rc<World>, Rc<TestLibrary>) {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    item(
        &lib,
        "w1",
        json!({ "target": { "kind": "web", "browser": "safari", "profile": "s-default" }, "url": "https://a/", "title": "A page" }),
    );
    item(&lib, "a1", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    s.core().edit(Field::SafariWindows, |st| st.safari_windows.insert(("s-default".into(), Role::Main), 90));
    world.hosted.borrow_mut().push("safari:s-default".into());
    *world.shown.borrow_mut() = Some("safari:s-default".into());
    s.core().set_hosting(Some(1));
    (s, world, lib)
}

fn pick(s: &Session, item: &str, window: i64) -> Out {
    s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": item, "windowId": window } }))
}

#[test]
fn a_host_show_never_answered_holds_no_pick_up_overtaken_it_is_cancelled_and_its_late_answer_does_nothing() {
    let (s, world, _) = tab_switch_world();
    let (seen, held) = pump_holding(&s, &world, pick(&s, "w1", 1), 0, &mut host_show_held);
    assert_eq!(kinds(&seen), ["ask hostShow"]);
    let ask = held[0].0;
    // An app picked in the window meanwhile: the show waiting for the copy cancelled at once, the app shown (until now
    // it waited behind it: 15 s, then "its tab wasn't shown (timedOut)").
    let (seen, held) = pump_holding(&s, &world, pick(&s, "a1", 1), 0, &mut host_show_held);
    assert_eq!(kinds(&seen), ["cancel", "engine open"]);
    assert_eq!(seen[0], Command::Cancel { profile: "s-default".into(), id: ask }, "that ask, of its profile's copy");
    assert!(held.is_empty());
    assert_eq!(s.core().shown_in(1).as_deref(), Some("a1"));
    let done = s.done();
    assert!(
        done.contains(
            &"w1: overtaken while its copy was asked for its tab (a1 asked for since): the request cancelled".into()
        ),
        "{done:?}"
    );
    assert!(done.iter().all(|l| !l.contains("wasn't shown")), "{done:?}");
    // Its answer after all: let go, nothing changes.
    let n = s.done().len();
    let out = s.answer(ask, json!({ "result": { "tabId": 777, "created": false } }));
    assert!(out.start.is_empty() && !out.ready, "{out:?}");
    assert_eq!(s.done().len(), n);
    assert_eq!(s.core().read(|st| st.safari_tabs.get("w1").copied()), None);
    assert_eq!((s.core().open_item("w1"), s.core().shown_in(1).as_deref()), (None, Some("a1")));
    assert!(s.idle());
}

#[test]
fn a_show_waiting_for_a_closed_windows_pick_is_cancelled() {
    let (s, world, _) = tab_switch_world();
    world.windows.borrow_mut().push(2);
    let (_, held) = pump_holding(&s, &world, pick(&s, "w1", 1), 0, &mut host_show_held);
    // (Nothing can be picked in a window gone: what's queued behind it gets its turn.)
    world.windows.borrow_mut().retain(|w| *w != 1);
    let out = s.input(&json!({ "type": "windowClosed", "window": 1 }));
    let (seen, _) = pump_holding(&s, &world, out, 0, &mut host_show_held);
    assert!(seen.contains(&Command::Cancel { profile: "s-default".into(), id: held[0].0 }), "{seen:?}");
    assert!(
        s.done().contains(
            &"w1: overtaken while its copy was asked for its tab (Margin's window 1 closed): the request cancelled"
                .into()
        ),
        "{:?}",
        s.done()
    );
    assert!(s.idle());
}

#[test]
fn its_loader_while_the_copy_is_asked_slow_once_its_link_says_so_for_slow_say() {
    let (s, world, _) = tab_switch_world();
    acts(&world);
    let (_, held) = pump_holding(&s, &world, pick(&s, "w1", 1), 0, &mut host_show_held);
    // (At once, not slow: the page's grace keeps a quick switch unseen.)
    assert_eq!(named(&acts(&world), "setShowing"), [json!(["setShowing", 1, "A page", SAFARI_BUNDLE, false])]);
    // Its link looked at `slowSay` (3 s) after the ask: not slow, nothing said; looked at again 3 s on.
    assert_eq!(s.tick(0.0).deadline, Some(3.0));
    world.now.set(3.0);
    assert_eq!(s.tick(3.0).deadline, Some(6.0));
    assert!(named(&acts(&world), "setShowing").is_empty());
    // Slow for 2 s: not yet; looked at again once it would be (1 s on).
    world.slow.borrow_mut().insert("s-default".into(), 2.0);
    world.now.set(6.0);
    assert_eq!(s.tick(6.0).deadline, Some(7.0));
    assert!(named(&acts(&world), "setShowing").is_empty());
    world.slow.borrow_mut().insert("s-default".into(), 3.0);
    world.now.set(7.0);
    s.tick(7.0);
    let a = acts(&world);
    assert_eq!(named(&a, "setShowing"), [json!(["setShowing", 1, "A page", SAFARI_BUNDLE, true])]);
    assert_eq!(named(&a, "setCopySlow"), [json!(["setCopySlow", 1, true])], "its loader says the copy is slow");
    // Reading again (its link no longer slow): said too.
    world.slow.borrow_mut().clear();
    world.now.set(10.0);
    s.tick(10.0);
    let a = acts(&world);
    assert_eq!(named(&a, "setShowing"), [json!(["setShowing", 1, "A page", SAFARI_BUNDLE, false])]);
    assert_eq!(named(&a, "setCopySlow"), [json!(["setCopySlow", 1, false])]);
    // Its answer: shown, the loader gone, its look dropped (no deadline left).
    let out = s.answer(held[0].0, json!({ "result": { "tabId": 501, "created": false } }));
    assert_eq!(out.deadline, None);
    assert_eq!(named(&acts(&world), "setShowing"), [json!(["setShowing", 1, null, null, false])]);
    assert_eq!(s.done().last().map(String::as_str), Some("w1: shown in Safari window 90"));
}

#[test]
fn a_show_whose_link_went_down_asked_again_on_its_copys_next_link_never_a_menu_press_while_its_window_is_there() {
    for first in ["down", "not linked"] {
        let (s, world, _) = tab_switch_world();
        let mut asks = 0;
        let mut answers = |c: &Command| match c {
            Command::Ask { kind, .. } if kind == "hostShow" => {
                asks += 1;
                if asks == 1 {
                    json!({ "error": first })
                } else {
                    json!({ "result": { "tabId": 502, "created": false } })
                }
            }
            c => usual(c),
        };
        let seen = pump(&s, &world, pick(&s, "w1", 1), &mut answers);
        assert_eq!(kinds(&seen), ["ask hostShow"], "{first}: its window still there: its copy's next link waited for");
        // (A link event of the same link, or another profile's: nothing yet.)
        let out = s.input(&json!({ "type": "linked", "profile": "s-default" }));
        assert!(pump(&s, &world, out, &mut answers).is_empty(), "{first}");
        // Its copy back on a new link: asked again, shown.
        world.epochs.borrow_mut().insert("s-default".into(), "e2".into());
        let out = s.input(&json!({ "type": "linked", "profile": "s-default" }));
        let seen = pump(&s, &world, out, &mut answers);
        assert_eq!(kinds(&seen), ["ask hostShow"], "{first}: no waker, no menu press");
        assert_eq!(
            s.done(),
            [
                format!(
                    "w1: its copy's link went down while it was asked for its tab ({first}): asked again once its profile links again"
                ),
                "w1: shown in Safari window 90".into()
            ]
        );
        assert_eq!(s.core().read(|st| st.safari_tabs.get("w1").copied()), Some(502));
    }
    // Its window gone too (Safari quit): the waker's, then asked again on the new link.
    let (s, world, _) = tab_switch_world();
    let mut asks = 0;
    let seen = pump(&s, &world, pick(&s, "w1", 1), &mut |c| match c {
        Command::Ask { kind, .. } if kind == "hostShow" => {
            asks += 1;
            if asks == 1 {
                world.hosted.borrow_mut().clear();
                json!({ "error": "down" })
            } else {
                json!({ "result": { "tabId": 502, "created": false } })
            }
        }
        Command::Waker { op, .. } if op == "ensureLinked" => {
            world.epochs.borrow_mut().insert("s-default".into(), "e2".into());
            json!({ "linked": true })
        }
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["ask hostShow", "waker ensureLinked", "ask hostShow"]);
    let Command::Waker { args, .. } = &seen[1] else { panic!() };
    assert_eq!(Value::Object(args.clone()), json!({ "profile": "s-default" }), "the show's own wait (`linkWanted`)");
    assert_eq!(seen[0], seen[2], "the same request again");
    // ...the waker says linked on the same link (no new epoch: no evidence it came back): not asked again, said.
    let (s, world, _) = tab_switch_world();
    let seen = pump(&s, &world, pick(&s, "w1", 1), &mut |c| match c {
        Command::Ask { kind, .. } if kind == "hostShow" => {
            world.hosted.borrow_mut().clear();
            json!({ "error": "down" })
        }
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["ask hostShow", "waker ensureLinked"]);
    assert_eq!(
        s.done().last().map(String::as_str),
        Some("w1: its tab wasn't shown (down: its profile's link not back)")
    );
    // Another error: not asked again, as before.
    let (s, world, _) = tab_switch_world();
    let seen = pump(&s, &world, pick(&s, "w1", 1), &mut |c| match c {
        Command::Ask { kind, .. } if kind == "hostShow" => json!({ "error": "refused" }),
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["ask hostShow"]);
    assert_eq!(s.done(), ["w1: its tab wasn't shown (refused)"]);
}

#[test]
fn a_show_whose_link_went_down_overtaken_before_it_links_again_is_not_asked_again() {
    let (s, world, _) = tab_switch_world();
    let seen = pump(&s, &world, pick(&s, "w1", 1), &mut |c| match c {
        Command::Ask { kind, .. } if kind == "hostShow" => json!({ "error": "down" }),
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["ask hostShow"]);
    // An app picked while its link is waited for: shown at once; its link back later: nothing asked.
    let seen = pump(&s, &world, pick(&s, "a1", 1), &mut usual);
    assert_eq!(kinds(&seen), ["engine open"], "never asked again: the app shown");
    assert_eq!(s.core().shown_in(1).as_deref(), Some("a1"));
    world.epochs.borrow_mut().insert("s-default".into(), "e2".into());
    let out = s.input(&json!({ "type": "linked", "profile": "s-default" }));
    assert!(pump(&s, &world, out, &mut usual).is_empty());
    assert!(
        s.done().contains(
            &"w1: overtaken while its copy's link was waited for (a1 asked for since): not asked again".into()
        ),
        "{:?}",
        s.done()
    );
    assert!(s.idle());
}

#[test]
fn a_show_waiting_for_its_copy_holds_no_other_windows_pick_up_and_the_later_pick_keeps_the_engine() {
    let (s, world, _) = tab_switch_world();
    world.windows.borrow_mut().push(2);
    let (seen, held) = pump_holding(&s, &world, pick(&s, "w1", 1), 0, &mut host_show_held);
    assert_eq!(kinds(&seen), ["ask hostShow"]);
    // An app picked in window 2 meanwhile: shown at once, nothing cancelled (window 1's pick is still wanted).
    let (seen, _) = pump_holding(&s, &world, pick(&s, "a1", 2), 0, &mut host_show_held);
    assert_eq!(kinds(&seen), ["engine parkShown", "engine open"], "window 1's shown parked, the app opened in 2");
    assert_eq!((s.core().hosting(), s.core().shown_in(2).as_deref()), (Some(2), Some("a1")));
    assert_eq!(s.core().requested_in(1).as_deref(), Some("w1"), "window 1's pick still wanted");
    // Window 1's copy answers after: its tab is in front in Safari, but the later pick keeps the engine; window 1 keeps
    // its item as its card.
    let out = s.answer(held[0].0, json!({ "result": { "tabId": 501, "created": false } }));
    let seen = pump(&s, &world, out, &mut usual);
    assert!(seen.is_empty(), "nothing hosted again for it: {seen:?}");
    assert_eq!((s.core().hosting(), s.core().elsewhere_in(1).as_deref()), (Some(2), Some("w1")));
    assert_eq!(s.core().requested_in(1), None);
    assert_eq!(s.core().read(|st| st.safari_tabs.get("w1").copied()), Some(501));
    assert_eq!(
        s.done().last().map(String::as_str),
        Some("w1: its tab in front in Safari window 90, another Margin window hosting since: its card here")
    );
    assert!(s.idle());
}

#[test]
fn no_request_to_a_copy_that_never_answers_holds_the_queue() {
    // (docs/LINK-RESILIENCE.md §1: with no time limit, each ends on evidence or is raced; none holds a pick up.)
    // A tab's close: told, waited for by nothing; the next pick shown at once.
    let (s, world, _) = tab_switch_world();
    s.core().edit(Field::Open, |st| {
        st.open.insert("w1".into(), OpenItem { host: "safari:s-default".into(), profile: Some("s-default".into()) })
    });
    let held = |c: &Command| match c {
        Command::Ask { .. } => None,
        c => Some(usual(c)),
    };
    let out = s.input(&json!({ "type": "library", "request": { "type": "closeTab", "item": "w1", "windowId": 1 } }));
    let (seen, _) = pump_holding(&s, &world, out, 0, &mut held.clone());
    assert_eq!(kinds(&seen), ["ask hostClose"]);
    let (seen, _) = pump_holding(&s, &world, pick(&s, "a1", 1), 0, &mut held.clone());
    assert_eq!(kinds(&seen), ["engine open"], "the close's answer waited for by nothing");
    assert!(s.idle());
    // Mute: its copy works outside the queue; the next pick at once; its answer still applied after.
    let (s, world, _) = tab_switch_world();
    s.core().edit(Field::Open, |st| {
        st.open.insert("w1".into(), OpenItem { host: "safari:s-default".into(), profile: Some("s-default".into()) })
    });
    let out = s.input(&json!({ "type": "library", "request": { "type": "muteTab", "item": "w1" } }));
    let (seen, mute) = pump_holding(&s, &world, out, 0, &mut held.clone());
    assert_eq!(kinds(&seen), ["ask hostMute"]);
    let (seen, _) = pump_holding(&s, &world, pick(&s, "a1", 1), 0, &mut held.clone());
    assert_eq!(kinds(&seen), ["engine open"]);
    let out = s.answer(mute[0].0, json!({ "result": { "muted": true } }));
    pump(&s, &world, out, &mut usual);
    assert!(s.core().read(|st| st.safari_muted.contains("w1")) && s.idle());
    // A window asked of the copy for a show (newWindow, under the engine's open): given up once another item is picked.
    let (s, world, _) = session();
    world.profiles.borrow_mut().push("s-default".into());
    s.core().edit(Field::Requested, |st| st.requested.insert(1, "mine".into()));
    s.core().edit(Field::Showing, |st| st.showing.insert("safari:s-default".into(), "mine".into()));
    let out = s.input(&json!({ "type": "call", "id": 2, "flow": "requestWindow", "args": { "profile": "s-default", "role": "main" } }));
    let (seen, asked) = pump_holding(&s, &world, out, 0, &mut held.clone());
    assert_eq!(kinds(&seen), ["ask newWindow"]);
    s.core().edit(Field::Requested, |st| st.requested.insert(1, "other".into()));
    let seen = pump(&s, &world, s.tick(0.0), &mut usual);
    assert_eq!(kinds(&seen), ["cancel", "reply"]);
    assert_eq!(seen[0], Command::Cancel { profile: "s-default".into(), id: asked[0].0 });
    assert_eq!(
        s.done().last().map(String::as_str),
        Some("Safari window for a profile: not made (given up (no longer wanted))")
    );
    // A window closed at Margin's quit (the engine's): waited for while its copy reads it; once Margin quits and its
    // copy hasn't read it (not acked), given up at the next look, so the quit goes on (the engine keeps the window to
    // close later, its marker).
    let (s, world, _) = session();
    world.profiles.borrow_mut().push("s-default".into());
    let out = s
        .input(&json!({ "type": "call", "id": 3, "flow": "closeWindow", "args": { "profile": null, "windowId": 91 } }));
    let (seen, _) = pump_holding(&s, &world, out, 0, &mut held.clone());
    assert_eq!(kinds(&seen), ["ask closeWindow"]);
    s.input(&json!({ "type": "quitting" }));
    let (seen, _) = pump_holding(&s, &world, s.tick(0.0), 0, &mut held.clone());
    assert!(seen.is_empty(), "its copy reading it (acked): still waited for");
    world.slow.borrow_mut().insert("s-default".into(), 0.5);
    world.now.set(3.0);
    let seen = pump(&s, &world, s.tick(3.0), &mut usual);
    assert_eq!(kinds(&seen), ["cancel", "reply"], "{seen:?}");
    let Some(Command::Reply { value, .. }) = seen.last() else { panic!() };
    assert_eq!(value, &json!(false));
    assert!(
        s.done().iter().any(|l| l.contains("not closed by its copy (given up (not read by its copy as Margin quits))")),
        "{:?}",
        s.done()
    );
}
