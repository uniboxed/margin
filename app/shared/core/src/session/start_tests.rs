//! An item shown in another Margin window and the start (elsewhere.rs, start.rs) through the re-entrant test adapter:
//! what each flow asks of Margin's windows, the engine, the copies and the waker, in order. (The same flows are
//! compared against the deleted Swift on generated sequences in the step's harness; these pin the shapes.)

use super::*;

/// The commands handed out, each answered by `answer` (a library edit and a `Done` before the run goes on, as Swift
/// answers them in the same turn), deadlines ticked on the world's clock while nothing else is left, `ticks` at most.
fn pump(
    s: &Session,
    world: &World,
    first: Out,
    ticks: usize,
    answer: &mut dyn FnMut(&Command) -> Value,
) -> Vec<Command> {
    let mut seen = Vec::new();
    let mut out = first;
    let mut left = ticks;
    for _ in 0..100_000 {
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
            let a = answer(&c);
            if matches!(c, Command::Done { .. }) {
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

fn usual(c: &Command) -> Value {
    match c {
        Command::Engine { op, args } if op == "open" => {
            let t = &args["target"];
            let id = if t["kind"] == json!("app") {
                format!("app:{}", t["bundle"].as_str().unwrap_or(""))
            } else {
                format!("safari:{}", t["profile"].as_str().unwrap_or(""))
            };
            json!({ "shown": id, "placed": true })
        }
        Command::Engine { op, .. } if op == "start" => json!({ "started": true }),
        Command::Engine { op, .. } if op == "prepare" => json!({ "shown": "safari:s-default", "placed": true }),
        Command::Ask { kind, .. } if kind == "hostShow" => json!({ "result": { "tabId": 501, "created": true } }),
        Command::Waker { op, .. } if op == "ensureLinked" => json!({ "linked": true }),
        _ => json!({ "result": {} }),
    }
}

/// The usual answers, the engine's open showing what it opened (as the engine's `shown` says after it).
fn shows(world: &World) -> impl FnMut(&Command) -> Value + '_ {
    move |c| {
        let a = usual(c);
        if let Some(id) = a.get("shown").and_then(Value::as_str)
            && matches!(c, Command::Engine { op, .. } if op == "open")
        {
            *world.shown.borrow_mut() = Some(id.to_string());
        }
        a
    }
}

fn kinds(cs: &[Command]) -> Vec<String> {
    cs.iter()
        .map(|c| match c {
            Command::Ask { kind, .. } => format!("ask {kind}"),
            Command::Run { .. } => "run".into(),
            Command::Engine { op, .. } => format!("engine {op}"),
            Command::Waker { op, .. } => format!("waker {op}"),
            Command::Reply { .. } => "reply".into(),
            Command::Done { then } => format!("done {then}"),
            Command::Cancel { .. } => "cancel".into(),
        })
        .collect()
}

fn acts(world: &World) -> Vec<Value> {
    std::mem::take(&mut *world.acts.borrow_mut())
}

fn named(acts: &[Value], name: &str) -> Vec<Value> {
    acts.iter().filter(|a| a[0] == json!(name)).cloned().collect()
}

fn put(lib: &TestLibrary, collection: &str, id: &str, v: Value) {
    lib.put(collection, id, v);
}

fn input(s: &Session, v: Value) -> Out {
    let out = s.input(&v);
    assert_eq!(out.error, None, "{v}");
    out
}

// ---- an item in another Margin window ----

#[test]
fn a_card_named_by_the_app_else_the_title_else_the_address_120_at_most() {
    let (s, world, lib) = session();
    world.names.borrow_mut().insert("com.apple.Notes".into(), "Notes".into());
    put(&lib, "tabs", "a", json!({ "target": { "kind": "app", "bundleId": "com.apple.Notes", "name": "N" } }));
    put(&lib, "tabs", "b", json!({ "target": { "kind": "app", "bundleId": "com.x", "name": "X app" } }));
    put(&lib, "tabs", "t", json!({ "title": "T".repeat(130), "url": "https://t/" }));
    put(&lib, "tabs", "u", json!({ "title": "", "url": "https://u/" }));
    put(&lib, "tabs", "p", json!({ "title": "" }));
    for (item, picture) in [("a", None), ("b", None), ("t", Some("data:image/png;base64,QQ")), ("u", None), ("p", None)]
    {
        s.core().show_elsewhere(item, 2, picture);
    }
    s.core().show_elsewhere("ghost", 3, None);
    let cards = named(&acts(&world), "setElsewhere");
    let t = "T".repeat(120);
    assert_eq!(
        cards,
        [
            json!(["setElsewhere", 2, "Notes", "com.apple.Notes", null]),
            json!(["setElsewhere", 2, "X app", "com.x", null]),
            json!(["setElsewhere", 2, t, SAFARI_BUNDLE, "data:image/png;base64,QQ"]),
            json!(["setElsewhere", 2, "https://u/", SAFARI_BUNDLE, null]),
            json!(["setElsewhere", 2, "the page", SAFARI_BUNDLE, null]),
        ],
        "no card for an item that isn't there"
    );
    assert_eq!(s.core().elsewhere_in(2).as_deref(), Some("p"));
    assert_eq!(s.core().elsewhere_in(3), None);
    assert_eq!(
        s.done()[2],
        "Margin's window 2: its item t shown in another window now: its card with its page's picture, until it's in front again"
    );
}

/// A web item hosted in its profile's main window, its picture asked.
fn pictured(s: &Session, wait: f64, item: &str) -> Out {
    input(s, json!({ "type": "options", "options": { "pictureWait": wait } }));
    set(
        s,
        json!({ "open": { "put": [["w1", "safari:s-default", "s-default"], ["a1", "app:com.a", null], ["p1", "safari:s-work#pane1", "s-work"]] },
                   "safariWindows": { "put": [["s-default", "main", 90]] } }),
    );
    // (Its flow as a show's move runs it: a task, its answer kept here, given back as a reply would be.)
    let c = s.core().clone();
    let item = item.to_string();
    s.core().exec.spawn_now(async move {
        let picture = c.page_picture(&item).await.map_or(Value::Null, Value::String);
        c.exec.command(Command::Reply { to: 7, value: picture }).await;
    });
    s.tick(0.0)
}

fn reply(out: &Out) -> Option<Value> {
    out.start.iter().find_map(|(_, c)| match c {
        Command::Reply { value, .. } => Some(value.clone()),
        _ => None,
    })
}

#[test]
fn a_web_items_picture_raced_against_its_wait() {
    // Its answer first: the picture (a JPEG or PNG data address only).
    for (data, got) in [
        (json!("data:image/jpeg;base64,QUJD"), json!("data:image/jpeg;base64,QUJD")),
        (json!("data:image/gif;base64,R0"), Value::Null),
        (Value::Null, Value::Null),
    ] {
        let (s, _world, _) = session();
        let out = pictured(&s, 0.4, "w1");
        let a = asks(&out);
        assert_eq!((a[0].1.as_str(), a[0].2.as_str()), ("s-default", "hostPicture"));
        assert_eq!(a[0].3, json!({ "windowId": 90, "itemId": "w1" }));
        assert_eq!(out.deadline, Some(0.4), "its wait from now");
        s.tick(0.0);
        let out = s.answer(a[0].0, json!({ "result": { "data": data }, "error": null }));
        assert_eq!(reply(&out), Some(got));
        assert_eq!(out.deadline, None, "its wait dropped");
    }
    // Its wait over first: none, the answer after it let go; the move not held for it.
    let (s, _world, _) = session();
    let out = pictured(&s, 0.4, "w1");
    let id = asks(&out)[0].0;
    s.tick(0.0);
    let out = s.tick(0.4);
    assert_eq!(reply(&out), Some(Value::Null));
    let out = s.answer(id, json!({ "result": { "data": "data:image/png;base64,QQ" } }));
    assert!(out.start.is_empty());
    // No wait, not a web item, not its main window, no window: nothing asked.
    for (wait, item) in [(0.0, "w1"), (0.4, "a1"), (0.4, "p1"), (0.4, "nope")] {
        let (s, _world, _) = session();
        let out = pictured(&s, wait, item);
        assert!(asks(&out).is_empty() && reply(&out) == Some(Value::Null), "{wait} {item}");
    }
}

#[test]
fn a_window_in_front_takes_its_item_back() {
    let (s, world, lib) = session();
    world.windows.borrow_mut().push(2);
    put(&lib, "tabs", "a", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    set(&s, json!({ "elsewhere": { "put": [[1, "a"], [2, "gone"]] }, "hostingWindow": { "put": [[2]] } }));
    acts(&world);
    // (Its item gone from the library: its card goes, nothing shown.)
    let out = input(&s, json!({ "type": "windowFocused", "window": 2 }));
    assert!(!out.ready, "the window hosting: nothing");
    set(&s, json!({ "hostingWindow": { "del": [null] } }));
    input(&s, json!({ "type": "windowFocused", "window": 2 }));
    assert_eq!(acts(&world), [json!(["setElsewhere", 2, null, null, null])]);
    assert_eq!(s.core().elsewhere_in(2), None);
    // (Its own: in front at once, then shown in the queue.)
    let out = input(&s, json!({ "type": "windowFocused", "window": 1 }));
    assert!(out.ready);
    assert_eq!(s.core().requested_in(1).as_deref(), Some("a"));
    let seen = pump(&s, &world, out, 10, &mut usual);
    assert_eq!(kinds(&seen), ["engine open"]);
    assert_eq!((s.core().requested_in(1), s.core().shown_in(1).as_deref()), (None, Some("a")));
    // (Another item asked for before its turn: not shown.)
    set(&s, json!({ "elsewhere": { "put": [[1, "a"]] }, "shown": { "del": [1] } }));
    let out = input(&s, json!({ "type": "windowFocused", "window": 1 }));
    set(&s, json!({ "requested": { "put": [[1, "b"]] } }));
    assert!(pump(&s, &world, out, 10, &mut usual).is_empty());
}

#[test]
fn a_window_closing_while_it_hosts_parks_first_then_closes() {
    let (s, world, _) = session();
    world.windows.borrow_mut().push(2);
    // Not hosting: close it now.
    let out = input(&s, json!({ "type": "windowClosing", "window": 2, "then": 5 }));
    assert_eq!(out.reply, Some(json!(false)));
    set(&s, json!({ "hostingWindow": { "put": [[2]] } }));
    let out = input(&s, json!({ "type": "windowClosing", "window": 2, "then": 5 }));
    assert_eq!(out.reply, Some(json!(false)), "nothing shown: close it now");
    *world.shown.borrow_mut() = Some("app:com.a".into());
    let out = input(&s, json!({ "type": "windowClosing", "window": 2, "then": 6 }));
    assert_eq!(out.reply, Some(json!(true)));
    assert!(out.ready && out.start.is_empty(), "not queued behind the session's work, but after the caller's code");
    let seen = pump(&s, &world, out, 0, &mut usual);
    assert_eq!(kinds(&seen), ["engine parkShown", "done 6"]);
    assert_eq!(s.done(), ["Margin's window 2 closing while it hosts: the one shown parked first"]);
}

#[test]
fn a_window_closed_forgets_what_was_kept_for_it() {
    let (s, world, _) = session();
    world.windows.borrow_mut().push(2);
    set(
        &s,
        json!({ "elsewhere": { "put": [[2, "x"], [1, "x"], [3, "y"]] }, "requested": { "put": [[2, "r"]] }, "shown": { "put": [[2, "s"], [1, "k"]] },
                "marginPages": { "put": [[2, "settings"]] }, "resume": { "put": [[2, "s"]] }, "cycledAt": { "put": [[2, 1.0]] },
                "hostingWindow": { "put": [[2]] } }),
    );
    *world.shown.borrow_mut() = Some("app:com.a".into());
    acts(&world);
    world.windows.borrow_mut().retain(|w| *w != 2);
    let out = input(&s, json!({ "type": "windowClosed", "window": 2 }));
    assert_eq!(s.done(), ["Margin's window 2 closed: its items stay open (parked), its card for x gone"]);
    let st = s.core().read(|st| {
        (
            st.elsewhere.clone(),
            st.requested.clone(),
            st.shown.clone(),
            st.margin_pages.len(),
            st.resume.len(),
            st.cycled_at.len(),
        )
    });
    assert_eq!(st.0.keys().copied().collect::<Vec<_>>(), [1, 3], "only its own card (a window gone isn't told)");
    assert_eq!((st.1.len(), st.2.keys().copied().collect::<Vec<_>>(), st.3, st.4, st.5), (0, vec![1], 0, 0, 0));
    assert_eq!(s.core().hosting(), None);
    let a = acts(&world);
    assert!(named(&a, "setElsewhere").is_empty(), "{a:?}");
    assert_eq!(a.last(), Some(&json!(["changed"])));
    // (It hosted with something shown: parked, in a task of its own.)
    assert_eq!(kinds(&pump(&s, &world, out, 0, &mut usual)), ["engine parkShown"]);
    // An item closed: every card of it goes, the windows there told.
    input(&s, json!({ "type": "state", "set": { "elsewhere": { "put": [[2, "x"]] } } }));
    world.windows.borrow_mut().push(2);
    s.core().forget_elsewhere(None, Some("x"));
    assert_eq!(
        named(&acts(&world), "setElsewhere"),
        [json!(["setElsewhere", 1, null, null, null]), json!(["setElsewhere", 2, null, null, null])]
    );
    assert_eq!(s.core().read(|st| st.elsewhere.keys().copied().collect::<Vec<_>>()), [3]);
}

// ---- the start ----

fn selected(lib: &TestLibrary, id: &str, target: Value, title: &str) {
    put(lib, "spaces", "s1", json!({ "name": "Home", "order": 0 }));
    put(lib, "windows", "1", json!({ "spaceId": "s1" }));
    put(lib, "tabs", id, json!({ "spaceId": "s1", "selected": true, "lastUsed": 5, "title": title, "target": target }));
}

fn notes() -> Value {
    json!({ "kind": "app", "bundleId": "com.apple.Notes", "name": "Notes" })
}

#[test]
fn the_last_item_behind_the_loader_then_shown_once_the_window_is_up() {
    let (s, world, lib) = session();
    selected(&lib, "n", notes(), "");
    input(&s, json!({ "type": "options", "options": { "preparesBrowser": false, "prepareWindowWait": 0.2 } }));
    world.not_full_screen.borrow_mut().push(1);
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert_eq!(
        (s.core().resuming(), s.core().hosting(), s.core().requested_in(1).as_deref()),
        (Some(1), Some(1), Some("n"))
    );
    let a = acts(&world);
    assert_eq!(named(&a, "setHosting"), [json!(["setHosting", 1, true])]);
    assert_eq!(named(&a, "setShowing"), [json!(["setShowing", 1, "Notes", "com.apple.Notes", true])]);
    assert_eq!(
        s.done(),
        ["Margin's window 1: the item it showed last (n) shown again, behind the loader from its first frame"]
    );
    // (Only the run's first window.)
    input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert_eq!(s.done().len(), 1);
    // Not up within its wait (5 looks): the launcher for now, the item once the window is back in full screen.
    let seen = pump(&s, &world, out, 100, &mut usual);
    assert!(seen.iter().all(|c| matches!(c, Command::Run { .. })) || seen.is_empty(), "{seen:?}");
    assert_eq!(s.core().read(|st| st.resume.get(&1).cloned()).as_deref(), Some("n"));
    assert_eq!(
        s.done()[1],
        "n: not shown at launch: Margin's window 1 wasn't in full screen with its page area within 0 s: shown once it is"
    );
    assert_eq!((s.core().resuming(), s.core().requested_in(1), s.core().hosting()), (None, None, None));
    let a = acts(&world);
    assert_eq!(named(&a, "setHosting"), [json!(["setHosting", 1, false])], "settled: the launcher");
    // Up in time: shown as any pick.
    let (s, world, lib) = session();
    selected(&lib, "n", notes(), "");
    input(&s, json!({ "type": "options", "options": { "preparesBrowser": false } }));
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert_eq!(kinds(&pump(&s, &world, out, 100, &mut shows(&world))), ["engine open"]);
    assert_eq!((s.core().shown_in(1).as_deref(), s.core().resuming()), (Some("n"), None));
    // Nothing selected, or turned off: nothing.
    let (s, world, _) = session();
    input(&s, json!({ "type": "options", "options": { "preparesBrowser": false } }));
    assert!(!input(&s, json!({ "type": "windowOpened", "window": 1 })).ready);
    assert!(acts(&world).is_empty() && s.done().is_empty());
}

#[test]
fn settings_last_drawn_at_once_with_nothing_hosted() {
    let (s, world, lib) = session();
    selected(&lib, "m", json!({ "kind": "margin", "page": "settings" }), "");
    input(&s, json!({ "type": "options", "options": { "preparesBrowser": false } }));
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert!(!out.ready);
    assert_eq!(acts(&world), [json!(["setMarginPage", 1, "settings"]), json!(["changed"])]);
    assert_eq!((s.core().shown_in(1).as_deref(), s.core().hosting()), (Some("m"), None));
    assert_eq!(s.done(), ["Margin's window 1: the item it showed last (m), Margin's settings page, shown again"]);
}

/// A web item of the default profile (its window, 90, the copy's already: its show the engine's open, then the tab).
fn docs() -> Value {
    json!({ "kind": "web", "browser": "safari", "profile": null })
}

/// The start screen up over window 1 with a web item last (`n`, "Docs"); the preparation not over.
fn start_screen(wait: f64) -> (Session, Rc<World>, Out) {
    let (s, world, lib) = session();
    selected(&lib, "n", docs(), "Docs");
    set(&s, json!({ "safariWindows": { "put": [["s-default", "main", 90]] } }));
    input(&s, json!({ "type": "options", "options": { "startupWait": wait } }));
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert!(s.start_screen());
    let a = acts(&world);
    assert_eq!(named(&a, "setShowing"), [json!(["setShowing", 1, STARTUP_LABEL, SAFARI_BUNDLE, true])]);
    assert_eq!(
        s.done(),
        [
            "Margin's window 1: \"Getting you started\" while the default browser starts, then the item it showed last (n)"
        ]
    );
    (s, world, out)
}

#[test]
fn the_start_screen_held_up_past_its_limit_retried_and_skipped() {
    let (s, world, out) = start_screen(0.1);
    // Its limit (3 looks), then said with the two choices; then held as long as it takes.
    pump(&s, &world, out, 3, &mut usual);
    assert_eq!(s.core().read(|st| st.start.stuck.clone()).as_deref(), Some(STARTUP_SLOW));
    assert_eq!(named(&acts(&world), "setStartupStuck"), [json!(["setStartupStuck", 1, STARTUP_SLOW])]);
    assert_eq!(
        s.done()[1],
        "the start screen held up: the default browser not ready within 0 s: Try again or Continue without Safari"
    );
    // Try again (still preparing): its words gone, its limit anew, then said again.
    let out = input(&s, json!({ "type": "startupRetry" }));
    assert_eq!(s.done()[2], "the start screen: Try again (1)");
    pump(&s, &world, out, 6, &mut usual);
    assert_eq!(
        named(&acts(&world), "setStartupStuck"),
        [json!(["setStartupStuck", 1, null]), json!(["setStartupStuck", 1, STARTUP_SLOW])]
    );
    // Continue without Safari: the start screen gone, the item shown last shown.
    let out = input(&s, json!({ "type": "startupSkip" }));
    let seen = pump(&s, &world, out, 3, &mut shows(&world));
    assert_eq!(kinds(&seen), ["engine open", "ask hostShow"]);
    assert!(!s.start_screen());
    assert_eq!(s.core().shown_in(1).as_deref(), Some("n"));
    let tail = s.done()[3..].to_vec();
    assert_eq!(
        tail[..3],
        [
            "the start screen held up: the default browser not ready within 0 s: Try again or Continue without Safari",
            "the start screen: Continue without Safari",
            "the start screen left before the default browser was ready (Continue without Safari): the browser when it's ready"
        ]
    );
    let a = acts(&world);
    assert_eq!(named(&a, "setStartupStuck"), [json!(["setStartupStuck", 1, null])]);
    assert_eq!(named(&a, "setShowing")[0], json!(["setShowing", 1, "Docs", SAFARI_BUNDLE, true]));
    // Gone: its choices do nothing.
    input(&s, json!({ "type": "startupRetry" }));
    input(&s, json!({ "type": "startupSkip" }));
    assert_eq!(s.core().read(|st| st.start.retries), 1);
}

#[test]
fn the_start_screen_lifts_by_itself_once_the_browser_is_ready() {
    let (s, world, out) = start_screen(0.1);
    pump(&s, &world, out, 3, &mut usual);
    let out = input(&s, json!({ "type": "preparationOver" }));
    let seen = pump(&s, &world, out, 3, &mut shows(&world));
    assert_eq!(kinds(&seen), ["engine open", "ask hostShow"]);
    assert!(!s.start_screen());
    assert_eq!(
        named(&acts(&world), "setStartupStuck"),
        [json!(["setStartupStuck", 1, STARTUP_SLOW]), json!(["setStartupStuck", 1, null])]
    );
    // Another item picked meanwhile: the start screen goes, the last one never shown.
    let (s, world, out) = start_screen(600.0);
    pump(&s, &world, out, 2, &mut usual);
    set(&s, json!({ "requested": { "put": [[1, "other"]] } }));
    let seen = pump(&s, &world, s.tick(0.0), 3, &mut usual);
    assert!(seen.is_empty() && !s.start_screen() && s.core().resuming().is_none());
    assert_eq!(named(&acts(&world), "setShowing"), [json!(["setShowing", 1, null, null, false])]);
}

fn prepare(s: &Session, setting: Value) -> Out {
    input(s, json!({ "type": "call", "id": 3, "flow": "prepareBrowser", "args": { "setting": setting } }))
}

#[test]
fn the_browser_made_ready_its_four_steps() {
    let (s, world, lib) = session();
    world.out_of_sight.set(true);
    put(&lib, "spaces", "s1", json!({ "name": "Home", "order": 0, "profile": "" }));
    let out = prepare(&s, json!(" Safari "));
    assert_eq!(
        kinds(&out.start.iter().map(|(_, c)| c.clone()).collect::<Vec<_>>()),
        ["engine start"],
        "started at once, the window's wait read meanwhile"
    );
    let seen = pump(&s, &world, out, 10, &mut usual);
    assert_eq!(kinds(&seen), ["engine start", "waker ensureLinked", "reply", "engine prepare"]);
    let Command::Waker { args, .. } = &seen[1] else { panic!() };
    assert_eq!(Value::Object(args.clone()), json!({ "profile": "s-default", "prepare": true }));
    let Command::Engine { args, .. } = &seen[3] else { panic!() };
    assert_eq!(
        Value::Object(args.clone()),
        json!({ "target": { "kind": "safari", "profile": "s-default", "role": "main" }, "window": 1, "space": 7 })
    );
    assert_eq!(s.done(), ["browser prepared in 0 ms (its window 0 ms), parked out of sight"]);
    assert_eq!(s.core().read(|st| (st.start.startup, st.preparing_window)), (Startup::Done, None));
    assert!(world.lines.borrow().iter().all(|l| !l.text.contains("isn't supported")));
    // An unsupported setting: Safari, said in the log only.
    let (s, world, _) = session();
    world.out_of_sight.set(true);
    pump(&s, &world, prepare(&s, json!("chrome")), 10, &mut usual);
    assert!(
        world
            .lines
            .borrow()
            .iter()
            .any(|l| l.text == "hosted: the default browser setting (chrome) isn't supported yet: Safari")
    );
    // Not possible out of sight, no window in time, not started: not prepared, said, over.
    for (why, out_of_sight, full, started) in [
        ("the early full screen isn't available, so it can't be made ready out of sight", false, true, true),
        ("no Margin window in full screen with its page area within 0 s", true, false, true),
        ("com.apple.Safari couldn't be started with no Dock icon", true, true, false),
    ] {
        let (s, world, _) = session();
        world.out_of_sight.set(out_of_sight);
        input(&s, json!({ "type": "options", "options": { "prepareWindowWait": 0.1 } }));
        if !full {
            world.not_full_screen.borrow_mut().push(1);
        }
        let mut answers = |c: &Command| match c {
            Command::Engine { op, .. } if op == "start" => json!({ "started": started }),
            c => usual(c),
        };
        pump(&s, &world, prepare(&s, Value::Null), 10, &mut answers);
        assert_eq!(s.done(), [format!("browser not prepared: {why}")]);
        assert_eq!(s.core().read(|st| st.start.startup), Startup::Done);
    }
    // Turned off: over at once.
    let (s, world, _) = session();
    input(&s, json!({ "type": "options", "options": { "preparesBrowser": false } }));
    assert!(
        pump(&s, &world, prepare(&s, Value::Null), 10, &mut usual) == [Command::Reply { to: 3, value: Value::Null }]
    );
    assert_eq!(s.core().read(|st| st.start.startup), Startup::Done);
}

#[test]
fn its_extension_never_linked_said_on_the_start_screen_then_try_again() {
    let (s, world, out) = start_screen(600.0);
    world.out_of_sight.set(true);
    let linked = Cell::new(false);
    let mut on = shows(&world);
    let mut answers = |c: &Command| match c {
        Command::Waker { op, .. } if op == "ensureLinked" => json!({ "linked": linked.get() }),
        c => on(c),
    };
    pump(&s, &world, out, 2, &mut answers);
    let seen = pump(&s, &world, prepare(&s, Value::Null), 4, &mut answers);
    assert_eq!(kinds(&seen), ["engine start", "waker ensureLinked", "waker closeWoken", "reply"]);
    assert_eq!(s.core().read(|st| st.start.failure.clone()).as_deref(), Some(STARTUP_NO_LINK));
    assert!(s.done().contains(&"browser not prepared: its extension didn't link".to_string()));
    pump(&s, &world, s.tick(0.0), 2, &mut answers);
    assert_eq!(named(&acts(&world), "setStartupStuck"), [json!(["setStartupStuck", 1, STARTUP_NO_LINK])]);
    assert!(s.done().contains(
        &"the start screen held up: its extension didn't link: Try again or Continue without Safari".to_string()
    ));
    // Try again with it on: the preparation run again, prepared, the start screen lifted, the item shown.
    linked.set(true);
    let seen = pump(&s, &world, input(&s, json!({ "type": "startupRetry" })), 10, &mut answers);
    assert_eq!(kinds(&seen), ["engine start", "waker ensureLinked", "engine prepare", "engine open", "ask hostShow"]);
    assert!(!s.start_screen());
    assert_eq!(s.core().shown_in(1).as_deref(), Some("n"));
}

#[test]
fn hosting_settled_and_the_launcher() {
    let (s, world, _) = session();
    set(
        &s,
        json!({ "hostingWindow": { "put": [[1]] }, "shown": { "put": [[1, "a"]] }, "requested": { "put": [[1, "b"]] } }),
    );
    s.settle();
    assert_eq!(s.core().hosting(), Some(1), "another item asked for: its show decides");
    set(&s, json!({ "requested": { "del": [1] } }));
    *world.shown.borrow_mut() = Some("app:com.a".into());
    s.settle();
    assert_eq!(s.core().hosting(), Some(1), "something shown");
    *world.shown.borrow_mut() = None;
    acts(&world);
    s.settle();
    assert_eq!((s.core().hosting(), s.core().shown_in(1)), (None, None));
    let a: Vec<String> = acts(&world).iter().map(|v| v[0].as_str().unwrap_or("").to_string()).collect();
    assert_eq!(a, ["setHosted", "clearCover", "setHosting", "setLoading", "setShowing", "changed"]);
    // (Margin's own page shown there: still the one shown; a window gone: nothing told.)
    set(
        &s,
        json!({ "hostingWindow": { "put": [[1]] }, "shown": { "put": [[1, "m"]] }, "marginPages": { "put": [[1, "settings"]] } }),
    );
    world.windows.borrow_mut().clear();
    s.settle();
    assert_eq!((s.core().hosting(), s.core().shown_in(1).as_deref()), (None, Some("m")));
    assert_eq!(acts(&world).iter().filter(|v| v[0] != json!("swift") && v[0] != json!("changed")).count(), 0);
    // The launcher asked for: Settings performed at once, said; Archive parks, settles, leaves Margin's page.
    world.windows.borrow_mut().push(1);
    acts(&world);
    let out = input(&s, json!({ "type": "call", "flow": "openLauncher", "args": { "window": 1, "settings": true } }));
    assert!(out.start.is_empty());
    assert_eq!(
        named(&acts(&world), "perform"),
        [json!(["perform", "openMarginPage", { "windowId": 1, "page": "settings" }])],
        "at once, as Swift's call did"
    );
    s.tick(0.0);
    assert_eq!(s.done().last().map(String::as_str), Some("Margin's window 1: Settings asked for, refused (no space)"));
    set(&s, json!({ "hostingWindow": { "put": [[1]] } }));
    *world.shown.borrow_mut() = Some("app:com.a".into());
    let out = input(&s, json!({ "type": "call", "flow": "openLauncher", "args": { "window": 1, "settings": false } }));
    let mut answers = |c: &Command| {
        if matches!(c, Command::Engine { op, .. } if op == "parkShown") {
            *world.shown.borrow_mut() = None;
        }
        usual(c)
    };
    assert_eq!(kinds(&pump(&s, &world, out, 0, &mut answers)), ["engine parkShown"]);
    assert_eq!((s.core().hosting(), s.core().margin_page(1)), (None, None));
    assert_eq!(s.done().last().map(String::as_str), Some("Margin's window 1: its launcher in the page area"));
    let out = input(&s, json!({ "type": "call", "flow": "openLauncher", "args": { "window": 9 } }));
    assert!(out.start.is_empty());
    assert_eq!(s.done().last().map(String::as_str), Some("the launcher asked for: no Margin window"));
}

#[test]
fn the_start_screen_read_typed_and_the_waker_look_for_the_preparation() {
    let (s, world, _) = session();
    assert!(!s.start_screen() && s.prepare_wanted());
    set(&s, json!({ "requested": { "put": [[1, "x"]] } }));
    assert!(!s.prepare_wanted(), "something asked for");
    let (s, world2, _out) = start_screen(600.0);
    assert!(s.start_screen() && s.prepare_wanted(), "the last item waiting for it counts as nothing");
    *world2.shown.borrow_mut() = Some("app:x".into());
    assert!(!s.prepare_wanted(), "something shown");
    let _ = world;
}

#[test]
fn its_extension_never_linked_with_no_start_screen_nothing_said_on_one() {
    // (The preparation alone, no window's start screen up: given up, said in the log, no words kept for a screen.)
    let (s, world, _) = session();
    world.out_of_sight.set(true);
    let mut answers = |c: &Command| match c {
        Command::Waker { op, .. } if op == "ensureLinked" => json!({ "linked": false }),
        c => usual(c),
    };
    let out = input(&s, json!({ "type": "call", "id": 3, "flow": "prepareBrowser", "args": {} }));
    pump(&s, &world, out, 4, &mut answers);
    assert!(s.done().contains(&"browser not prepared: its extension didn't link".to_string()));
    assert_eq!(s.core().read(|st| st.start.failure.clone()), None);
}

#[test]
fn held_up_it_rechecks_only_on_events() {
    // (Tirth, 2026-11-23: no looks while the start screen is held up; each thing it reads changes in an input, an
    // answer, a tick or the facade's edit, and it re-checks then.)
    for event in ["skip", "retry", "over", "edit", "library", "closed"] {
        let (s, world, out) = start_screen(0.1);
        pump(&s, &world, out, 3, &mut shows(&world));
        assert_eq!(s.core().read(|st| st.start.stuck.clone()).as_deref(), Some(STARTUP_SLOW));
        let idle = s.tick(0.0);
        assert!(!idle.ready && idle.deadline.is_none(), "{event}: nothing wakes while it's up and idle");
        let out = match event {
            "skip" => input(&s, json!({ "type": "startupSkip" })),
            "retry" => input(&s, json!({ "type": "startupRetry" })),
            "over" => input(&s, json!({ "type": "preparationOver" })),
            "edit" => {
                let (ok, _) = s.edit_row(Field::Requested, false, &Row { i0: 1, s0: Some("other"), ..Row::default() });
                assert!(ok && s.ready(), "a facade's edit wakes it: tick in the next turn");
                s.tick(0.0)
            }
            "library" => input(
                &s,
                json!({ "type": "library", "request": { "type": "activateTab", "item": "x", "windowId": 1 } }),
            ),
            _ => input(&s, json!({ "type": "windowClosed", "window": 1 })),
        };
        assert!(event == "edit" || out.ready || !out.start.is_empty(), "{event}: re-checked");
        pump(&s, &world, out, 0, &mut shows(&world));
        let held = s.start_screen();
        let stuck = s.core().read(|st| st.start.stuck.clone());
        match event {
            // (Try again: its words gone, its limit anew: a deadline again, no look past it.)
            "retry" => assert!(held && stuck.is_none() && s.tick(0.0).deadline.is_some(), "{event}"),
            _ => assert!(!held && stuck.is_none(), "{event}: the start screen gone at once"),
        }
    }
}

#[test]
fn margins_own_page_left_keeps_the_item_shown_where_the_window_hosts() {
    let (s, world, _) = session();
    set(
        &s,
        json!({ "marginPages": { "put": [[1, "settings"]] }, "shown": { "put": [[1, "a"]] }, "hostingWindow": { "put": [[1]] } }),
    );
    s.core().leave_margin_page(1);
    assert_eq!(
        (s.core().margin_page(1), s.core().shown_in(1).as_deref()),
        (None, Some("a")),
        "it hosts: its item stays the one shown"
    );
    set(&s, json!({ "marginPages": { "put": [[1, "settings"]] }, "hostingWindow": { "del": [null] } }));
    s.core().leave_margin_page(1);
    assert_eq!(s.core().shown_in(1), None, "not hosting: nothing shown there now");
    assert_eq!(
        named(&acts(&world), "setMarginPage"),
        [json!(["setMarginPage", 1, null]), json!(["setMarginPage", 1, null])]
    );
}

// ---- the start waits only for what the first item shown needs (docs/LINK-RESILIENCE.md §2, rules 1–4) ----

#[test]
fn an_app_shown_last_is_shown_at_once_with_no_start_screen() {
    let (s, world, lib) = session();
    selected(&lib, "n", notes(), "");
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert!(!s.start_screen(), "nothing it shows needs the browser: no start screen");
    assert_eq!(named(&acts(&world), "setShowing"), [json!(["setShowing", 1, "Notes", "com.apple.Notes", true])]);
    assert_eq!(
        s.done(),
        ["Margin's window 1: the item it showed last (n) shown again, behind the loader from its first frame"]
    );
    let seen = pump(&s, &world, out, 100, &mut shows(&world));
    assert_eq!(kinds(&seen), ["engine open"], "shown with the browser's preparation not over (not even begun here)");
    assert_eq!(s.core().shown_in(1).as_deref(), Some("n"));
    assert_eq!(s.core().read(|st| st.start.startup), Startup::Waiting);
}

#[test]
fn no_item_or_margins_own_page_shown_last_no_start_screen() {
    // No item: the launcher at once.
    let (s, world, _) = session();
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert!(!s.start_screen() && !out.ready);
    assert!(acts(&world).is_empty() && s.done().is_empty());
    // Margin's own page: drawn at once, nothing hosted.
    let (s, world, lib) = session();
    selected(&lib, "m", json!({ "kind": "margin", "page": "settings" }), "");
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert!(!s.start_screen() && !out.ready);
    assert_eq!(acts(&world), [json!(["setMarginPage", 1, "settings"]), json!(["changed"])]);
    assert_eq!(s.core().shown_in(1).as_deref(), Some("m"));
}

#[test]
fn a_web_item_shown_last_its_own_profile_made_ready_and_waited_for_not_the_spaces() {
    let (s, world, lib) = session();
    world.out_of_sight.set(true);
    put(&lib, "spaces", "s1", json!({ "name": "Home", "order": 0, "profile": "s-q" }));
    put(&lib, "windows", "1", json!({ "spaceId": "s1" }));
    let web = json!({ "kind": "web", "browser": "safari", "profile": "s-p" });
    put(&lib, "tabs", "w", json!({ "spaceId": "s1", "selected": true, "lastUsed": 5, "title": "P", "target": web }));
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert!(s.start_screen(), "it needs its profile: waited for");
    pump(&s, &world, out, 2, &mut usual);
    let seen: Vec<Command> = pump(&s, &world, prepare(&s, Value::Null), 10, &mut usual)
        .into_iter()
        .filter(|c| !matches!(c, Command::Reply { .. }))
        .collect();
    assert_eq!(kinds(&seen[..3]), ["engine start", "waker ensureLinked", "engine prepare"]);
    let Command::Waker { args, .. } = &seen[1] else { panic!() };
    assert_eq!(
        Value::Object(args.clone()),
        json!({ "profile": "s-p", "prepare": true }),
        "its profile, not the space's"
    );
    let Command::Engine { args, .. } = &seen[2] else { panic!() };
    assert_eq!(args["target"], json!({ "kind": "safari", "profile": "s-p", "role": "main" }));
    assert!(!s.start_screen(), "lifted once its profile was made ready");
}

#[test]
fn an_app_shown_first_the_browser_still_made_ready_its_window_once_nothing_is_shown() {
    let (s, world, lib) = session();
    world.out_of_sight.set(true);
    selected(&lib, "n", notes(), "");
    let out = input(&s, json!({ "type": "windowOpened", "window": 1 }));
    assert!(!s.start_screen());
    assert_eq!(kinds(&pump(&s, &world, out, 100, &mut shows(&world))), ["engine open"]);
    assert!(s.prepare_wanted(), "the item shown first is nothing picked since: the preparation still wanted");
    // Its profile linked (the waker may wake it: `prepare_wanted`), then its window: not while the app is shown.
    let seen: Vec<String> = kinds(&pump(&s, &world, prepare(&s, Value::Null), 10, &mut usual));
    assert_eq!(seen, ["engine start", "waker ensureLinked", "reply"], "no engine prepare while something is shown");
    assert!(
        s.done()
            .contains(&"browser: something is shown in Margin's window: its window made ready once nothing is".into()),
        "{:?}",
        s.done()
    );
    assert!(!s.done().iter().any(|l| l.starts_with("browser not prepared")), "not given up");
    // Something else picked: no longer wanted.
    set(&s, json!({ "requested": { "put": [[1, "other"]] } }));
    assert!(!s.prepare_wanted());
    set(&s, json!({ "requested": { "del": [1] } }));
    // Nothing shown any more (the app parked): its window made ready, out of sight.
    *world.shown.borrow_mut() = None;
    let out = s.settle();
    let seen = pump(&s, &world, out, 10, &mut usual);
    assert_eq!(kinds(&seen), ["engine prepare"]);
    let Command::Engine { args, .. } = &seen[0] else { panic!() };
    assert_eq!(args["target"], json!({ "kind": "safari", "profile": "s-default", "role": "main" }));
    assert!(s.done().last().is_some_and(|l| l.starts_with("browser prepared in")), "{:?}", s.done());
    // Kept once only.
    assert!(pump(&s, &world, s.settle(), 10, &mut usual).is_empty());
}
