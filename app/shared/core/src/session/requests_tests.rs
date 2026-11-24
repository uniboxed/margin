//! The library's requests, `show`, `close`, `openApp`, the choice of host and profile and the engine's window asks
//! (requests.rs, hosting.rs) through the re-entrant test adapter: what each flow asks of Margin's windows, the engine,
//! the copies, the library and the Swift flows not moved yet, in order. (The same flows are compared against the
//! deleted Swift on generated vectors in the step's harness; these pin the shapes.)

use super::*;

/// The commands a run handed out, each answered by `answer` (a library edit before the run goes on, as Swift answers
/// it in the same turn; the others after); deadlines ticked on the world's clock when nothing else is left.
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
            if matches!(c, Command::Perform { .. }) {
                s.answer(id, a);
            } else {
                later.push((id, a));
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
            Command::Perform { action, .. } => format!("perform {action}"),
            Command::Run { .. } => "run".into(),
            Command::Engine { op, .. } => format!("engine {op}"),
            Command::Waker { op, .. } => format!("waker {op}"),
            Command::Reply { .. } => "reply".into(),
            Command::Done { .. } => "done".into(),
        })
        .collect()
}

pub(super) fn acts(world: &World) -> Vec<Value> {
    std::mem::take(&mut *world.acts.borrow_mut())
}

pub(super) fn named(acts: &[Value], name: &str) -> Vec<Value> {
    acts.iter().filter(|a| a[0] == json!(name) || a[1] == json!(name)).cloned().collect()
}

pub(super) fn item(shelf: &Shelf, id: &str, v: Value) {
    shelf.0.borrow_mut().insert(("tabs".into(), id.into()), v);
}

#[test]
fn a_show_request_drawn_in_front_at_once_then_an_app_hosted() {
    let (s, world, shelf) = session();
    world.names.borrow_mut().insert("com.apple.Notes".into(), "Notes".into());
    item(&shelf, "a1", json!({ "target": { "kind": "app", "bundleId": "com.apple.Notes", "name": "" }, "title": "N" }));
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
    let (s, world, shelf) = session();
    item(&shelf, "a1", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    item(&shelf, "a2", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" } }));
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
    let (s, world, shelf) = session();
    world.profiles.borrow_mut().push("s-default".into());
    item(
        &shelf,
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
    let (s, world, shelf) = session();
    world.profiles.borrow_mut().push("s-default".into());
    // An open with no item: one made (in front, bound to the pin), then shown; refused: said.
    let out = s.input(&json!({ "type": "library", "request": { "type": "openPin", "url": "https://p/", "pin": "pin1", "windowId": 1, "spaceId": "sp" } }));
    let mut made = None;
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Perform { payload, .. } => {
            made = Some(Value::Object(payload.clone()));
            json!({ "ok": false, "error": "no such space" })
        }
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["perform addItem"]);
    assert_eq!(
        made,
        Some(json!({ "url": "https://p/", "front": true, "spaceId": "sp", "windowId": 1, "pinnedBy": "pin1" }))
    );
    assert_eq!(s.done().last().map(String::as_str), Some("openPin: no item made (no such space)"));
    // A favourite's reset with no item, refused: silent, its own key.
    let n = s.done().len();
    let out = s.input(
        &json!({ "type": "library", "request": { "type": "resetFavorite", "url": "https://f/", "favorite": "fav1" } }),
    );
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Perform { payload, .. } => {
            made = Some(Value::Object(payload.clone()));
            json!({ "ok": true, "result": {} })
        }
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["perform addItem"]);
    assert_eq!(made, Some(json!({ "url": "https://f/", "front": true, "favoriteId": "fav1" })));
    assert_eq!(s.done().len(), n, "a reset that made nothing says nothing");
    // A reset with no address: nothing at all.
    let out = s.input(&json!({ "type": "library", "request": { "type": "resetPin", "item": "w1" } }));
    assert!(pump(&s, &world, out, &mut usual).is_empty());
    // A reset of an open item: its tab back at its address first, then shown.
    item(
        &shelf,
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
        &shelf,
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
    let (s, world, shelf) = session();
    world.runs.borrow_mut().insert("com.a".into(), false);
    world.now.set(100.0);
    item(&shelf, "a1", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    item(&shelf, "a2", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" } }));
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
    let (s, world, shelf) = session();
    world.runs.borrow_mut().insert("com.a".into(), false);
    item(&shelf, "a1", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    let out = s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a1", "windowId": 1 } }));
    assert_eq!(kinds(&pump(&s, &world, out, &mut usual)), ["engine open"]);
}

#[test]
fn closing_its_page_closed_the_next_one_shown_and_the_split_around_it_again() {
    let (s, world, shelf) = session();
    world.profiles.borrow_mut().push("s-default".into());
    item(&shelf, "w1", json!({ "target": { "kind": "web", "browser": "safari", "profile": "s-default" } }));
    item(&shelf, "a2", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" } }));
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
    let (s, world, shelf) = session();
    world.profiles.borrow_mut().push("s-default".into());
    world.unopenable.borrow_mut().push("s-work".into());
    shelf.0.borrow_mut().insert(("spaces".into(), "sp".into()), json!({ "name": "Work", "order": 1 }));
    item(
        &shelf,
        "w1",
        json!({ "target": { "kind": "web", "browser": "safari", "profile": "s-work" }, "spaceId": "sp" }),
    );
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
    // A link that never comes back while nothing waits for it any more: given up at once, said.
    let (s, world, _) = session();
    world.profiles.borrow_mut().push("s-default".into());
    s.core().edit(Field::Requested, |st| st.requested.insert(1, "other".into()));
    s.core().edit(Field::Showing, |st| st.showing.insert("safari:s-default".into(), "mine".into()));
    let out = s.input(&json!({ "type": "call", "id": 2, "flow": "requestWindow", "args": { "profile": "s-default", "role": "main" } }));
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Ask { .. } => json!({ "error": "not linked" }),
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["ask newWindow", "reply"]);
    assert_eq!(s.done().last().map(String::as_str), Some("Safari window for a profile: not made (not linked)"));
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
    let (s, world, shelf) = session();
    shelf.0.borrow_mut().insert(("windows".into(), "1".into()), json!({ "spaceId": "sp" }));
    item(&shelf, "old", json!({ "url": "app://com.b", "spaceId": "sp" }));
    for (bundle, want, line) in [
        ("com.google.Chrome.beta", vec![], Some("com.google.Chrome.beta: Chrome and Edge aren't hosted yet")),
        ("COM.unibox.margin", vec!["perform newTab"], Some("Margin picked in its own palette: the surprise")),
        ("com.apple.Safari", vec!["perform newTab"], None),
        ("com.b", vec!["perform activateTab"], None),
    ] {
        let n = s.done().len();
        let out = s.input(&json!({ "type": "call", "flow": "openApp", "args": { "bundle": bundle, "window": null } }));
        assert_eq!(kinds(&pump(&s, &world, out, &mut usual)), want, "{bundle}");
        assert_eq!(s.done().get(n).map(String::as_str), line, "{bundle}");
    }
    let out = s.input(&json!({ "type": "call", "flow": "openApp", "args": { "bundle": "com.c", "window": 1 } }));
    let mut payload = None;
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Perform { payload: p, .. } => {
            payload = Some(Value::Object(p.clone()));
            json!({ "ok": true, "result": { "tabId": "new" } })
        }
        c => usual(c),
    });
    assert_eq!(
        payload,
        Some(
            json!({ "windowId": 1, "target": { "kind": "app", "bundleId": "com.c", "name": "com.c" }, "front": true, "spaceId": "sp" })
        )
    );
    assert_eq!(kinds(&seen), ["perform addItem", "engine open"]);
    assert_eq!(s.done()[s.done().len() - 2], "com.c: item new added");
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

/// The library object as the session reads it (its set, in place).
struct LibraryOf(Rc<crate::library::Library>);

impl LibraryView for LibraryOf {
    fn item(&self, collection: &str, id: &str) -> Option<Value> {
        self.0.item(collection, id)
    }
    fn collection(&self, collection: &str) -> Map<String, Value> {
        self.0.live(collection)
    }
}

struct Clock(Cell<u32>);

impl crate::library::LibraryHost for Clock {
    fn env(&self) -> crate::library::actions::Env {
        let n = self.0.get() + 1;
        self.0.set(n);
        crate::library::actions::Env { now: f64::from(n), ids: (0..4).map(|i| format!("lib{n}x{i}")).collect() }
    }
    fn now(&self) -> f64 {
        f64::from(self.0.get())
    }
    fn changed(&self, _: &BTreeSet<String>) {}
}

#[test]
fn the_librarys_requests_reach_the_session_inside_its_perform() {
    // The session as the library's sink (`Library::set_sink`, as margin_session_new will register it at the switch):
    // a perform's request is the session's `library` input inside the perform (the item in front at once), its show
    // started by the caller's next tick, reading the item from the library object (re-entered on every port).
    let (_, world, _) = session();
    let dir = crate::data::testing::temp();
    let lib = Rc::new(crate::library::Library::new(
        crate::data::library::LibraryStore::new(crate::data::store::DataStore::new(dir.path()).flat()),
        Box::new(Clock(Cell::new(0))),
        Box::new(crate::library::js::CodePointOrder),
    ));
    let s =
        Session::new(Box::new(Reentrant(world.clone())), Box::new(LibraryOf(lib.clone())), &json!({ "every": 0.05 }));
    *world.core.borrow_mut() = Rc::downgrade(s.core());
    lib.set_sink(Some(s.sink()));
    world.names.borrow_mut().insert("com.apple.Notes".into(), "Notes".into());
    let space = lib.perform("createSpace", &json!({ "windowId": 1, "name": "A" })).outcome.result["spaceId"].clone();
    let added = lib.perform(
        "addItem",
        &json!({ "spaceId": space, "target": { "kind": "app", "bundleId": "com.apple.Notes", "name": "Notes" } }),
    );
    let item = added.outcome.result["tabId"].as_str().expect("an item").to_owned();
    acts(&world);
    let out = lib.perform("activateTab", &json!({ "windowId": 1, "tabId": item }));
    assert!(out.outcome.ok, "{out:?}");
    assert_eq!(s.core().requested_in(1).as_deref(), Some(item.as_str()), "in front at once, inside the perform");
    assert_eq!(acts(&world), [json!(["changed"])]);
    let seen = pump(&s, &world, s.tick(0.0), &mut usual);
    assert_eq!(kinds(&seen), ["engine open"], "its show, on the caller's next tick");
    let Command::Engine { args, .. } = &seen[0] else { panic!() };
    assert_eq!(args["target"], json!({ "kind": "app", "bundle": "com.apple.Notes" }));
    assert_eq!(s.core().shown_in(1).as_deref(), Some(item.as_str()));
    assert!(world.reentries.get() > 0, "the session re-entered on its ports throughout");
}
