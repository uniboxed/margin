//! The preview card and Quick Tab (card.rs) through the re-entrant test adapter: what each flow says to Margin's
//! windows, asks of the copies, the library and the engine's layout (layouts.rs's), in order. (The same flows are
//! compared against the deleted Swift on generated vectors in the step's harness; these pin the shapes.)

use super::requests_tests::{acts, kinds, named, pump};
use super::*;
use crate::session::card::{CARD_COVER_WAIT, card_item, web_host};

const RECT: Rect = Rect { x: 360.0, y: 150.0, width: 1044.0, height: 700.0 };

/// Window 1 hosting a web item `b1` of `s-default` in its main window (the copy's 90).
fn hosted() -> (Session, Rc<World>, Rc<Shelf>) {
    let (s, world, shelf) = session();
    world.profiles.borrow_mut().push("s-default".into());
    shelf
        .0
        .borrow_mut()
        .insert(("tabs".into(), "b1".into()), json!({ "url": "https://b.example/", "spaceId": "home",
                                                      "target": { "kind": "web", "browser": "safari", "profile": null } }));
    shelf.0.borrow_mut().insert(("spaces".into(), "home".into()), json!({ "name": "Home", "profile": "" }));
    set(
        &s,
        json!({ "shown": { "put": [[1, "b1"]] }, "open": { "put": [["b1", "safari:s-default", "s-default"]] },
                "safariWindows": { "put": [["s-default", "main", 90], ["s-default", "card", 91]] }, "hostingWindow": { "put": [[1]] } }),
    );
    // (Its main window and its card window hosted already: their tabs shown first, out of sight, then the layout.)
    world.hosted.borrow_mut().extend(["safari:s-default".to_string(), "safari:s-default#card".to_string()]);
    *world.shown.borrow_mut() = Some("safari:s-default".into());
    world.card_rects.borrow_mut().insert(1, RECT);
    world.pages.borrow_mut().insert(1, Rect::new(260.0, 41.0, 1244.0, 933.0));
    (s, world, shelf)
}

fn peek(s: &Session, kind: &str, args: Value) -> Out {
    let mut input = json!({ "type": "peek", "kind": kind });
    if let (Some(i), Some(a)) = (input.as_object_mut(), args.as_object()) {
        i.extend(a.clone());
    }
    s.input(&input)
}

fn later() -> f64 {
    1_800_000_000.0 * 1000.0 + 5000.0
}

fn pushes(acts: &[Value]) -> Vec<Value> {
    named(acts, "push").iter().filter_map(|a| serde_json::from_str(a[2].as_str()?).ok()).collect()
}

/// The usual answers, and the engine's layout: every host it's asked for shown.
fn laid_out(_: &Session) -> impl FnMut(&Command) -> Value + '_ {
    move |c| match c {
        Command::Engine { op, args } if op == "setLayout" => {
            let mut hosts = vec![args["main"].clone()];
            hosts.extend(json::array(args.get("extras")).into_iter().flatten().map(|e| e["target"].clone()));
            let results: Vec<Value> = hosts
                .iter()
                .map(|t| {
                    let role = t["role"].as_str().unwrap_or("main");
                    let suffix = if role == "main" { String::new() } else { format!("#{role}") };
                    let id = format!("safari:{}{suffix}", t["profile"].as_str().unwrap_or(""));
                    json!([id, { "shown": id, "placed": true }, format!("shown({id}, placed: true)")])
                })
                .collect();
            json!({ "results": results })
        }
        Command::Ask { kind, .. } if kind == "hostPromotePeek" => json!({ "result": { "ok": true } }),
        c => super::requests_tests::usual(c),
    }
}

#[test]
fn a_pages_click_answered_at_once_then_the_card_laid_out_at_its_rect_the_page_told() {
    let (s, world, _) = hosted();
    let msg = json!({ "id": "peek-1", "url": "https://docs.example.org/guide", "notAfter": later() });
    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    assert!(out.ready && out.start.is_empty(), "the answer and the placing after the caller's code");
    let a = acts(&world);
    assert_eq!(
        pushes(&a),
        [json!({ "type": "peek", "peek": { "url": "https://docs.example.org/guide", "title": "docs.example.org",
                                            "loading": true, "spaceId": "home" } })]
    );
    let seen = pump(&s, &world, out, &mut laid_out(&s));
    // (The layout's: the two tabs in front first, out of sight, main's then the card's new page, then the engine.)
    assert_eq!(
        kinds(&seen),
        ["ask peekAnswer", "ask hostShow", "ask hostShow", "engine setLayout"],
        "answered before anything else is asked"
    );
    let Command::Ask { payload, .. } = &seen[0] else { panic!() };
    assert_eq!(Value::Object(payload.clone()), json!({ "id": "peek-1", "ok": true }));
    let Command::Ask { payload, .. } = &seen[2] else { panic!() };
    assert_eq!(
        Value::Object(payload.clone()),
        json!({ "windowId": 91, "itemId": "peek-card", "url": "https://docs.example.org/guide", "role": "card", "fresh": true })
    );
    let Command::Engine { args, .. } = &seen[3] else { panic!() };
    assert_eq!(
        (args["main"].clone(), args["mainRect"].clone(), args["focused"].clone(), args["extras"].clone()),
        (
            json!({ "kind": "safari", "profile": "s-default", "role": "main" }),
            Value::Null,
            json!("safari:s-default#card"),
            json!([{ "target": { "kind": "safari", "profile": "s-default", "role": "card" }, "role": "card", "rect": [360.0, 150.0, 1044.0, 700.0] }])
        )
    );
    let c = s.core().card("s-default").expect("a card");
    assert!(c.open && c.ready && !c.fresh && c.rect == Some(RECT) && c.click.as_deref() == Some("peek-1"));
    assert_eq!(pushes(&acts(&world))[0]["peek"]["loading"], json!(false), "in place");
    assert_eq!(
        s.done(),
        [
            "Preview asked by a page: shown",
            "Preview: a card in Margin's window 1 over b1",
            "layout: 2 item(s) shown in Margin's window 1, card:s-default focused"
        ],
        "the page's <m-preview-page>: no default rect said"
    );
    assert_eq!(
        s.input(&json!({ "type": "state", "get": ["cards"] })).reply.unwrap()["cards"][0][0],
        json!("s-default")
    );

    // The card window opened at the card's page (hosting.rs `request_window`), never the new-tab page.
    assert_eq!(s.core().card_url("s-default").as_deref(), Some("https://docs.example.org/guide"));
}

#[test]
fn refusals_said_in_the_swifts_words_and_answered_no() {
    let (s, world, _) = hosted();
    let cases = [
        (json!({ "id": "a", "url": "javascript:x", "notAfter": later() }), Some(90), "not a web address"),
        (json!({ "id": "b", "url": "https://x/", "notAfter": 1.0 }), Some(90), "too late: the page opened it"),
        (json!({ "id": "c", "url": "https://x/", "notAfter": later() }), None, "no window"),
        (json!({ "id": "d", "url": "https://x/", "notAfter": later() }), Some(7), "not a window Margin hosts"),
    ];
    for (msg, window, _) in &cases {
        let out = peek(&s, "open", json!({ "profile": "s-default", "window": window, "msg": msg }));
        pump(&s, &world, out, &mut laid_out(&s));
    }
    let said: Vec<String> =
        cases.iter().map(|(_, _, why)| format!("Preview asked by a page: refused ({why})")).collect();
    assert_eq!(s.done(), said);
    assert!(s.core().card("s-default").is_none());
    // (No id or time: not a click; an id past 80 is never answered.)
    peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": { "url": "https://x/" } }));
    assert_eq!(
        s.done().last().map(String::as_str),
        Some("Preview: a push that isn't a page's click (no id or time): left")
    );
    let long = "x".repeat(81);
    let out = peek(
        &s,
        "open",
        json!({ "profile": "s-default", "window": 7, "msg": { "id": long, "url": "https://x/", "notAfter": later() } }),
    );
    assert!(pump(&s, &world, out, &mut laid_out(&s)).is_empty());
}

#[test]
fn closed_the_page_told_first_then_the_rest_laid_out_again_and_its_tab_closed() {
    let (s, world, _) = hosted();
    let msg = json!({ "id": "p", "url": "https://docs.example.org/", "notAfter": later() });
    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    pump(&s, &world, out, &mut laid_out(&s));
    acts(&world);
    let out = peek(&s, "closeForKey", json!({ "window": 1 }));
    assert_eq!(out.reply, Some(json!(true)));
    assert_eq!(pushes(&acts(&world)), [json!({ "type": "peek", "peek": null })]);
    assert!(s.core().card("s-default").is_none());
    let t0 = world.now.get();
    let seen = pump(&s, &world, out, &mut laid_out(&s));
    assert_eq!(kinds(&seen), ["ask hostShow", "engine setLayout", "ask hostCardClose"]);
    assert!((world.now.get() - t0 - CARD_COVER_WAIT).abs() < 1e-9, "after the page had its moment to cover it");
    let Command::Engine { args, .. } = &seen[1] else { panic!() };
    assert_eq!((args["extras"].clone(), args["focused"].clone()), (json!([]), json!("safari:s-default")));
    assert!(s.core().layout_of(1).is_none(), "main alone again: no layout kept");
    assert!(s.done().iter().any(|l| l == "Preview: the card closed (⌘W)"), "{:?}", s.done());
    assert_eq!(
        peek(&s, "closeForKey", json!({ "window": 1 })).reply,
        Some(json!(false)),
        "nothing there: the item's own ⌘W"
    );
}

#[test]
fn hidden_with_its_opener_and_shown_again_on_its_return() {
    let (s, world, _) = hosted();
    let msg = json!({ "id": "p", "url": "https://docs.example.org/", "notAfter": later() });
    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    pump(&s, &world, out, &mut laid_out(&s));
    s.core().card_leaving(1, Some("a1"));
    let c = s.core().card("s-default").unwrap();
    assert!(!c.open && !c.ready && c.hidden_by.as_deref() == Some("a1"));
    s.core().card_returning(1, "a1");
    assert!(!s.core().card("s-default").unwrap().open, "another item: not its opener");
    s.core().card_returning(1, "b1");
    assert!(s.core().card("s-default").unwrap().open);
    let out = s.tick(0.0);
    let seen = pump(&s, &world, out, &mut laid_out(&s));
    assert_eq!(kinds(&seen), ["ask hostShow", "ask hostShow", "engine setLayout"]);
    assert!(s.core().card("s-default").unwrap().ready);
    // (The opener picked while it was hidden by it: it stays hidden.)
    s.core().card_leaving(1, Some("b1"));
    s.core().card_returning(1, "b1");
    assert!(!s.core().card("s-default").unwrap().open);
}

#[test]
fn quick_tab_with_nothing_hosted_the_spaces_new_tab_made_now() {
    let (s, world, _) = hosted();
    set(&s, json!({ "hostingWindow": { "del": [null] } }));
    peek(&s, "quickTab", json!({ "window": 1, "space": "home" }));
    assert_eq!(
        s.input(&json!({ "type": "state", "get": ["littleArcs"] })).reply.unwrap()["littleArcs"],
        json!([[1, "home"]])
    );
    world.perform_requests.borrow_mut().push(object(json!({ "type": "newTab", "item": "n1", "windowId": 1 })));
    world.performs.borrow_mut().push_back(json!({ "ok": true, "result": { "tabId": "n1" } }));
    peek(&s, "quickTabGo", json!({ "window": 1, "url": "https://quick.example/", "space": "home" }));
    let a = acts(&world);
    assert_eq!(
        named(&a, "perform"),
        [json!(["perform", "newTab", { "windowId": 1, "url": "https://quick.example/", "spaceId": "home" }])]
    );
    assert_eq!(s.core().requested_in(1).as_deref(), Some("n1"), "its request reached the session inside the edit");
    assert!(s.core().read(|st| st.little_arcs.is_empty()));
}

#[test]
fn expand_refused_the_card_closed_instead_and_made_its_tab_moved_then_shown() {
    let (s, world, shelf) = hosted();
    let msg = json!({ "id": "p", "url": "https://docs.example.org/", "notAfter": later() });
    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    pump(&s, &world, out, &mut laid_out(&s));
    peek(&s, "expand", json!({ "window": 1, "space": "nope" }));
    assert_eq!(s.done().last().map(String::as_str), Some("Preview: the card closed (Expand failed)"), "{:?}", s.done());
    let a = acts(&world);
    let Some(edit) = named(&a, "perform").first().cloned() else { panic!("{a:?}") };
    assert_eq!(edit[2]["spaceId"], json!("home"), "a space the library hasn't: the card's");
    assert_eq!(edit[2]["target"], json!({ "kind": "web", "browser": "safari", "profile": "s-default" }));
    let out = s.tick(0.0);
    pump(&s, &world, out, &mut laid_out(&s));

    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    pump(&s, &world, out, &mut laid_out(&s));
    world.performs.borrow_mut().push_back(json!({ "ok": true, "result": { "tabId": "e1" } }));
    let out = peek(&s, "expand", json!({ "window": 1 }));
    assert_eq!(s.core().requested_in(1).as_deref(), Some("e1"));
    let seen = pump(&s, &world, out, &mut laid_out(&s));
    assert_eq!(kinds(&seen)[0], "ask hostPromotePeek");
    let Command::Ask { payload, .. } = &seen[0] else { panic!() };
    assert_eq!(
        Value::Object(payload.clone()),
        json!({ "fromItemId": "peek-card", "toWindowId": 90, "toItemId": "e1" })
    );
    assert_eq!(s.done().iter().filter(|l| l.as_str() == "Preview: expanded into item e1").count(), 1);

    // A space the library has, named: it, before the card's own.
    shelf.0.borrow_mut().insert(("spaces".into(), "work".into()), json!({ "name": "Work" }));
    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    pump(&s, &world, out, &mut laid_out(&s));
    acts(&world);
    world.performs.borrow_mut().push_back(json!({ "ok": true, "result": { "tabId": "e2" } }));
    peek(&s, "expand", json!({ "window": 1, "space": "work" }));
    assert_eq!(named(&acts(&world), "perform")[0][2]["spaceId"], json!("work"));
}

#[test]
fn a_profiles_main_window_gone_its_card_window_closed_and_idle_ones_after_fifteen_minutes() {
    let (s, world, _) = hosted();
    let msg = json!({ "id": "p", "url": "https://docs.example.org/", "notAfter": later() });
    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    pump(&s, &world, out, &mut laid_out(&s));
    world.hosted.borrow_mut().push("safari:s-default#card".into());
    let out = peek(&s, "hostGone", json!({ "host": "safari:s-default" }));
    assert!(s.core().card("s-default").is_none());
    let seen = pump(&s, &world, out, &mut laid_out(&s));
    assert_eq!(
        seen,
        [Command::Engine { op: "close".into(), args: object(json!({ "host": "safari:s-default#card" })) }]
    );

    // Used, closed, then fifteen minutes on: its window closed by the engine.
    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    pump(&s, &world, out, &mut laid_out(&s));
    peek(&s, "close", json!({ "window": 1, "why": "test", "tellPage": false }));
    let out = s.tick(0.0);
    pump(&s, &world, out, &mut laid_out(&s));
    world.now.set(world.now.get() + 60.0);
    assert!(peek(&s, "idle", json!({})).start.is_empty() && !s.core().read(|st| st.card_used_at.is_empty()));
    // (Swift's `>=`: just under fifteen minutes kept, fifteen to the second closed.)
    let used = s.core().read(|st| st.card_used_at["s-default"]);
    world.now.set(used + 899.999);
    assert!(peek(&s, "idle", json!({})).start.is_empty() && !s.core().read(|st| st.card_used_at.is_empty()));
    world.now.set(used + 900.0);
    let out = peek(&s, "idle", json!({}));
    assert_eq!(s.done().last().map(String::as_str), Some("Preview: the card window unused for 15 minutes: closed"));
    assert_eq!(kinds(&pump(&s, &world, out, &mut laid_out(&s))), ["engine close"]);
}

#[test]
fn the_pages_rect_moved_more_than_a_point_the_card_laid_out_again() {
    let (s, world, _) = hosted();
    let msg = json!({ "id": "p", "url": "https://docs.example.org/", "notAfter": later() });
    let out = peek(&s, "open", json!({ "profile": "s-default", "window": 90, "msg": msg }));
    pump(&s, &world, out, &mut laid_out(&s));
    for (dx, again) in [(0.5, false), (1.0, false), (-1.0, false), (1.5, true)] {
        world.card_rects.borrow_mut().insert(1, Rect { x: RECT.x + dx, ..RECT });
        let out = peek(&s, "rect", json!({ "window": 1 }));
        assert_eq!(out.ready, again, "{dx}");
        pump(&s, &world, out, &mut laid_out(&s));
    }
    // (A negative size: compared as CGRect, standardized.)
    world.card_rects.borrow_mut().insert(1, Rect::new(RECT.x + RECT.width + 1.5, RECT.y, -RECT.width, RECT.height));
    assert!(!peek(&s, "rect", json!({ "window": 1 })).ready, "the same rect, laid out the other way");
}

#[test]
fn a_window_laid_out_with_several_never_only_switches_tabs_and_a_show_clears_its_layout() {
    let (s, world, shelf) = hosted();
    shelf.0.borrow_mut().insert(
        ("tabs".into(), "b1".into()),
        json!({ "url": "https://b.example/", "spaceId": "home", "target": { "kind": "web", "browser": "safari", "profile": "s-default" } }),
    );
    *world.shown.borrow_mut() = Some("safari:s-default".into());
    world.hosted.borrow_mut().push("safari:s-default".into());
    let show = |s: &Session| {
        s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "b1", "windowId": 1 } }))
    };
    let out = show(&s);
    assert_eq!(kinds(&pump(&s, &world, out, &mut laid_out(&s))), ["ask hostShow"], "alone: a tab switch");
    let card = Layout {
        main: "b1".into(),
        main_rect: None,
        extras: vec![state::Extra { item: "card:s-default".into(), role: "card".into(), rect: RECT }],
        focused: "card:s-default".into(),
        split: None,
    };
    s.core().edit(Field::Layouts, |st| st.layouts.insert(1, card));
    let out = show(&s);
    assert_eq!(
        kinds(&pump(&s, &world, out, &mut laid_out(&s))),
        ["ask hostShow", "engine open"],
        "laid out with a card: shown again, alone"
    );
    assert!(s.core().layout_of(1).is_none(), "its layout cleared");
}

#[test]
fn bad_card_inputs_refused_once_a_kind() {
    let (s, _, _) = hosted();
    assert!(peek(&s, "nope", json!({})).error.is_some());
    assert!(!s.pinned_or_favorite("b1"));
}

// ---- web_host: Foundation's `URL(string:)?.host` on macOS 27.2 (2026-11-23) ----

#[test]
fn a_web_addresss_host_as_foundation_says_it() {
    let os = || Some("xn--os".to_string());
    for (s, host) in [
        ("https://docs.example.org/guide", Some("docs.example.org")),
        ("http://x.example/a?b#c", Some("x.example")),
        ("https://A.Example:8080/p", Some("A.Example")),
        ("http://a%41b/", Some("aAb")),
        ("http://u:p@h.example/", Some("h.example")),
        ("https://[::1]:80/", Some("::1")),
        ("http://[::1%25en0]/", Some("::1%en0")),
        ("http://a%FF/", None),
        ("http://a%20b/", Some("a b")),
        ("http:", None),
        ("https://", None),
        ("http://a/b c", Some("a")),
        ("HTTP://A", Some("A")),
        ("http://@/", Some("")),
        ("http://u@a@b/", Some("b")),
        ("http://[v1.a]/", Some("v1.a")),
        ("http://a?b", Some("a")),
        ("http://:80/", Some("")),
        ("http://a:/", Some("a")),
        ("http://a.b%2Ec/", Some("a.b.c")),
        ("http://%C3%A9.example/", Some("é.example")),
        ("http://[::FFFF:1.2.3.4]/", Some("::FFFF:1.2.3.4")),
        ("http://é.example/", Some("xn--os")),
    ] {
        assert_eq!(web_host(s, os).as_deref(), host, "{s}");
    }
    assert_eq!(card_item("p"), "card:p");
}
