//! Layouts, splits and the page area moving (layouts.rs, page_area.rs) through the re-entrant test adapter: a split
//! shown at its page's rects, no room before anything moves, a failed pane out of the split, `prepare`'s waits and
//! its other window parked, a drag's frames followed from a page in the core, one placing per burst, the retry after
//! a placing out of full screen. (The same flows are compared against the deleted Swift on generated sequences in
//! the step's harness; these pin the shapes.)

use super::requests_tests::{acts, item, kinds, named, pump, usual};
use super::*;
use crate::page::Page;

fn split_world(s: &Session, world: &World, shelf: &Shelf) {
    world.profiles.borrow_mut().push("s-default".into());
    item(
        shelf,
        "w1",
        json!({ "target": { "kind": "web", "browser": "safari", "profile": null }, "url": "https://a/", "title": "A" }),
    );
    item(shelf, "a2", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" }, "title": "" }));
    item(shelf, "a3", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" }, "title": "" }));
    shelf.0.borrow_mut().insert(("splits".into(), "sp".into()), json!({ "panes": ["w1", "a2", "a3"] }));
    // (The page lays the split out as the item in front asks: two panes side by side.)
    *world.panes.borrow_mut() = Some((
        "sp".into(),
        vec![
            ("w1".into(), Rect::new(260.0, 8.0, 618.0, 933.0)),
            ("a2".into(), Rect::new(886.0, 8.0, 618.0, 933.0)),
            ("a3".into(), Rect::new(1500.0, 8.0, 4.0, 933.0)),
        ],
    ));
    // (The engine makes the profile's window as it lays it out: the copy's.)
    s.core().edit(Field::SafariWindows, |st| st.safari_windows.insert(("s-default".into(), Role::Main), 90));
}

/// The engine's layout: every host asked for shown, except those `failing` (with their words).
fn laid_out<'a>(failing: &'a [(&'a str, &'a str)]) -> impl FnMut(&Command) -> Value + 'a {
    move |c| match c {
        Command::Engine { op, args } if op == "setLayout" => {
            let mut hosts = vec![args["main"].clone()];
            hosts.extend(json::array(args.get("extras")).into_iter().flatten().map(|e| e["target"].clone()));
            let results: Vec<Value> = hosts
                .iter()
                .map(|t| {
                    let id = if t["kind"] == json!("app") {
                        format!("app:{}", t["bundle"].as_str().unwrap_or(""))
                    } else {
                        let role = t["role"].as_str().unwrap_or("main");
                        let suffix = if role == "main" { String::new() } else { format!("#{role}") };
                        format!("safari:{}{suffix}", t["profile"].as_str().unwrap_or(""))
                    };
                    match failing.iter().find(|(h, _)| *h == id) {
                        Some((_, why)) => {
                            json!([id, { "failed": "place", "why": why }, format!("failed(place, {why:?})")])
                        }
                        None => json!([id, { "shown": id, "placed": true }, format!("shown({id}, placed: true)")]),
                    }
                })
                .collect();
            json!({ "results": results })
        }
        Command::Engine { op, .. } if op == "toolbarsRest" || op == "focusPages" => Value::Null,
        c => usual(c),
    }
}

#[test]
fn a_split_shown_at_its_pages_rects_an_app_once_room_checked_first() {
    let (s, world, shelf) = session();
    split_world(&s, &world, &shelf);
    world.minimums.borrow_mut().insert("app:com.b".into(), Size::new(300.0, 200.0));
    let out = s.input(
        &json!({ "type": "library", "request": { "type": "showSplit", "splitId": "sp", "item": "a2", "windowId": 1 } }),
    );
    let seen = pump(&s, &world, out, &mut laid_out(&[]));
    // (Its pane's window made under its own loader, its page given the keys and its toolbar let rest.)
    assert_eq!(kinds(&seen), ["engine setLayout", "ask hostShow"]);
    let Command::Engine { args, .. } = &seen[0] else { panic!() };
    assert_eq!(
        args["main"],
        json!({ "kind": "safari", "profile": "s-default", "role": "main" }),
        "the web pane is main"
    );
    assert_eq!(args["mainRect"], json!([260.0, 8.0, 618.0, 933.0]));
    assert_eq!(
        args["extras"],
        json!([{ "target": { "kind": "app", "bundle": "com.b" }, "role": "pane", "rect": [886.0, 8.0, 618.0, 933.0] }])
    );
    assert_eq!(args["focused"], json!("app:com.b"));
    assert_eq!((args["window"].clone(), args["space"].clone()), (json!(101), json!(7)));
    let l = s.core().layout_of(1).expect("a layout");
    assert_eq!((l.main.as_str(), l.focused.as_str(), l.split.as_deref()), ("w1", "a2", Some("sp")));
    assert_eq!(s.core().shown_in(1).as_deref(), Some("a2"));
    assert_eq!(
        s.done(),
        [
            "split sp: a3: com.b is in it already (an app is one pane)",
            "layout: 2 item(s) shown in Margin's window 1, a2 focused"
        ]
    );
    let a = acts(&world);
    assert_eq!(named(&a, "setPaneMinimums"), [json!(["setPaneMinimums", 1, [["a2", 300.0, 200.0]]])]);
    assert_eq!(named(&a, "setHosting"), [json!(["setHosting", 1, true])]);
    // (Its defers: the reveal let go, the panes laying cleared.)
    assert!(s.core().read(|st| st.panes_laying.is_empty() && st.reveal_held.is_empty()));
    assert!(s.core().panes.borrow().address_for.is_empty() && s.core().panes.borrow().address.is_empty());

    // No room: a pane past the page area, the newcomer out of the split before anything moves, the toast said.
    *world.panes.borrow_mut() = Some((
        "sp".into(),
        vec![("w1".into(), Rect::new(949.0, 8.0, 574.0, 933.0)), ("a2".into(), Rect::new(260.0, 8.0, 681.0, 933.0))],
    ));
    shelf.0.borrow_mut().insert(("splits".into(), "sp".into()), json!({ "panes": ["w1", "a2"] }));
    s.core().set_layout_of(1, None);
    let out = s.input(
        &json!({ "type": "library", "request": { "type": "showSplit", "splitId": "sp", "item": "w1", "windowId": 1 } }),
    );
    let seen = pump(&s, &world, out, &mut laid_out(&[]));
    assert!(!kinds(&seen).contains(&"engine setLayout".to_string()), "{:?}", kinds(&seen));
    assert!(kinds(&seen).contains(&"perform removeFromSplit".to_string()));
    let line = "layout: split sp: no room in the page area 1244×933 (w1 949…1523×933 , a2 260…941×933 , each pane 220 at least): nothing moved";
    assert!(s.done().iter().any(|l| l == line), "{:?}", s.done());
    let a = acts(&world);
    assert_eq!(
        named(&a, "push").last(),
        Some(&json!(["push", 1, r#"{"type":"toast","text":"Not enough room for “that pane” in Split View"}"#]))
    );
}

#[test]
fn a_pane_that_didnt_come_leaves_the_split_the_one_with_the_keys_keeps_them() {
    let (s, world, shelf) = session();
    split_world(&s, &world, &shelf);
    shelf.0.borrow_mut().insert(("splits".into(), "sp".into()), json!({ "panes": ["w1", "a2"] }));
    *world.panes.borrow_mut() = Some((
        "sp".into(),
        vec![("w1".into(), Rect::new(260.0, 8.0, 618.0, 933.0)), ("a2".into(), Rect::new(886.0, 8.0, 618.0, 933.0))],
    ));
    let out = s.input(
        &json!({ "type": "library", "request": { "type": "showSplit", "splitId": "sp", "item": "a2", "windowId": 1 } }),
    );
    let seen = pump(&s, &world, out, &mut laid_out(&[("app:com.b", "below its window's minimum")]));
    assert!(kinds(&seen).contains(&"perform removeFromSplit".to_string()));
    let Some(Command::Perform { payload, .. }) = seen.iter().find(|c| matches!(c, Command::Perform { .. })) else {
        panic!()
    };
    assert_eq!(Value::Object(payload.clone()), json!({ "windowId": 1, "tabId": "a2", "focus": "w1" }));
    assert!(s.done().contains(&"layout: a2: not shown (failed(place, \"below its window's minimum\"))".to_string()));
    assert!(
        s.done().contains(
            &"split sp: a2: out of the split (no room for it: below its window's minimum); the rest laid out again"
                .to_string()
        )
    );
    assert_eq!(s.core().layout_of(1), None, "main alone: no layout kept");
    // (The split not shown: the item picked shown alone, as the Swift did; the library's removal shows the rest.)
    assert_eq!(kinds(&seen).last().map(String::as_str), Some("engine open"));
}

#[test]
fn a_profiles_fourth_pane_not_laid_out_its_panes_in_their_roles() {
    let (s, world, shelf) = session();
    world.profiles.borrow_mut().push("s-default".into());
    for i in 0..5 {
        item(
            &shelf,
            &format!("w{i}"),
            json!({ "target": { "kind": "web", "browser": "safari", "profile": null }, "url": format!("https://{i}/") }),
        );
    }
    let extras: Vec<Value> = (1..5).map(|i| json!([format!("w{i}"), "pane", 900, 8, 300, 933])).collect();
    let out = s.input(&json!({ "type": "call", "id": 1, "flow": "applyLayout", "args": { "window": 1, "main": "w0", "mainRect": null, "extras": extras, "focused": null, "split": null } }));
    let seen = pump(&s, &world, out, &mut laid_out(&[]));
    let Some(Command::Engine { args, .. }) =
        seen.iter().find(|c| matches!(c, Command::Engine { op, .. } if op == "setLayout"))
    else {
        panic!("{:?}", kinds(&seen))
    };
    let roles: Vec<Value> =
        json::array(args.get("extras")).into_iter().flatten().map(|e| e["target"]["role"].clone()).collect();
    assert_eq!(roles, [json!("pane1"), json!("pane2"), json!("pane3")], "three at most");
    assert_eq!(s.done()[0], "layout: w4: a profile's fourth pane: not laid out (three at most)");
}

#[test]
fn prepare_parks_the_other_windows_item_and_waits_for_full_screen_and_the_page_area() {
    let (s, world, shelf) = session();
    world.windows.borrow_mut().push(2);
    item(&shelf, "a1", json!({ "target": { "kind": "app", "bundleId": "com.a", "name": "A" } }));
    s.core().set_hosting(Some(2));
    s.core().edit(Field::Shown, |st| st.shown.insert(2, "a1".into()));
    world.not_full_screen.borrow_mut().push(1);
    let out = s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a1", "windowId": 1 } }));
    // (An app's item: no picture asked, its card the app's name: elsewhere.rs, the core's.)
    let seen = pump(&s, &world, out, &mut usual);
    assert_eq!(kinds(&seen), ["engine parkShown", "engine open"]);
    let a = acts(&world);
    let order: Vec<String> = a
        .iter()
        .map(|v| {
            if v[0] == json!("swift") {
                v[1].as_str().unwrap_or("").to_string()
            } else {
                v[0].as_str().unwrap_or("").to_string()
            }
        })
        .collect();
    let at = |n: &str| order.iter().position(|o| o == n).unwrap_or(usize::MAX);
    assert!(at("setHosted") < at("setElsewhere") && at("toFullScreen") < at("setAppMinimums"), "{order:?}");
    assert_eq!(named(&a, "setHosting"), [json!(["setHosting", 2, false]), json!(["setHosting", 1, true])]);
    assert_eq!(named(&a, "setElsewhere"), [json!(["setElsewhere", 2, "A", "com.a", null])]);
    assert_eq!(s.core().hosting(), Some(1));
    // (The card's line first, the core's own now: it was the Swift's, not in `done`.)
    assert_eq!(
        s.done()[0],
        "Margin's window 2: its item a1 shown in another window now: its card, until it's in front again"
    );
    assert_eq!(s.done()[1], "Margin's window 1 not in full screen (it always is while hosting is on: test): asked");
    // No page area within its wait: nothing hosted, said, its looks remeasured (3 s at 0.05: 62 looks).
    *world.placement.borrow_mut() = None;
    item(&shelf, "a2", json!({ "target": { "kind": "app", "bundleId": "com.b", "name": "B" } }));
    let out = s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": "a2", "windowId": 1 } }));
    let seen = pump(&s, &world, out, &mut usual);
    assert!(seen.is_empty());
    assert_eq!(s.done().last().map(String::as_str), Some("Margin's window 1: no page area (test)"));
    assert_eq!(named(&acts(&world), "remeasure").len(), 62, "each of the wait's 62 looks");
}

fn page_with_split() -> Page {
    let mut page = Page::default();
    page.set_hosting(true);
    page.set_full_screen(true);
    let report = br#"{"insets":{"left":260,"top":8,"right":8,"bottom":8},"radius":6,"container":{"width":1512,"height":949},"mode":"fullscreen","pageHosted":true,"split":"sp","panes":[{"id":"w1","rect":[260,8,618,933]},{"id":"a2","rect":[886,8,618,933]}]}"#;
    assert!(page.set_layout_bytes(report).taken);
    page
}

#[test]
fn a_drags_frames_followed_from_the_page_in_the_core_one_placing_per_burst_after() {
    let (s, world, _) = session();
    world.follows.set(true);
    s.core().set_hosting(Some(1));
    *world.shown.borrow_mut() = Some("safari:s-default".into());
    s.core().edit(Field::Open, |st| {
        st.open.insert("w1".into(), OpenItem { host: "safari:s-default".into(), profile: Some("s-default".into()) });
        st.open.insert("a2".into(), OpenItem { host: "app:com.b".into(), profile: None });
    });
    s.core().set_layout_of(
        1,
        Some(Layout {
            main: "w1".into(),
            main_rect: None,
            extras: vec![Extra { item: "a2".into(), role: "pane".into(), rect: Rect::ZERO }],
            focused: "w1".into(),
            split: Some("sp".into()),
        }),
    );
    let page = page_with_split();
    let content = Rect::new(0.0, 0.0, 1512.0, 949.0);
    let display = Some(Rect::new(0.0, 0.0, 1512.0, 982.0));
    let frame = Frame::Page { page: &page, content, display, card: None };
    // (Not dragged: one placing per burst.)
    assert_eq!(s.page_rect(1, &frame), PageRect::Queued);
    assert_eq!(s.page_rect(1, &frame), PageRect::Nothing, "one per burst");
    s.input(&json!({ "type": "sidebarResizing", "window": 1, "on": true, "divider": true }));
    assert_eq!(s.drag(), (Some(1), true));
    assert_eq!(
        s.done().last().map(String::as_str),
        Some("a split's divider dragged in Margin's window 1: the hosted window follows it live")
    );
    acts(&world);
    // (Every frame: the page area and each pane's rect, the card's after them, nothing queued.)
    // (The window's card in place, at where the page draws it.)
    let mut c = Card::new("s-default", 1, "w1", None, "https://c/", None);
    c.ready = true;
    s.core().set_card("s-default", Some(c));
    let card = Some(Rect::new(400.0, 100.0, 600.0, 500.0));
    let framed = Frame::Page { page: &page, content, display, card };
    assert_eq!(s.page_rect(1, &framed), PageRect::Followed);
    assert_eq!(
        acts(&world),
        [json!([
            "follow",
            1244.0,
            [
                ["safari:s-default", 260.0, 8.0, 618.0, 933.0],
                ["app:com.b", 886.0, 8.0, 618.0, 933.0],
                ["safari:s-default#card", 400.0, 100.0, 600.0, 500.0]
            ]
        ])]
    );
    // (The queued placing's turn came during the drag: held, the drag's end places.)
    let out = s.tick(0.0);
    assert!(out.start.is_empty(), "{:?}", out.start);
    s.input(&json!({ "type": "sidebarResizing", "window": 1, "on": false }));
    assert_eq!(s.drag(), (None, false));
    let a = acts(&world);
    assert_eq!(named(&a, "dragging"), [json!(["dragging", false])]);
    assert_eq!(named(&a, "followsPage"), [json!(["followsPage", 1, false])]);
    let out = s.tick(0.0);
    let started: Vec<Command> = out.start.iter().map(|(_, c)| c.clone()).collect();
    assert_eq!(kinds(&started), ["engine pageRectChanged"], "the drag's end places once");
}

#[test]
fn a_placing_out_of_full_screen_shown_again_once_after_its_pause() {
    let (s, world, _) = session();
    s.core().set_hosting(Some(1));
    *world.shown.borrow_mut() = Some("app:com.b".into());
    world.hosted.borrow_mut().push("app:com.b".into());
    s.core().edit(Field::Labels, |st| st.labels.insert("app:com.b".into(), "B".into()));
    let out = s.input(&json!({ "type": "pageRect", "window": 1 }));
    assert!(out.ready);
    let w = world.clone();
    let seen = pump(&s, &world, out, &mut |c| match c {
        Command::Engine { op, .. } if op == "pageRectChanged" => {
            *w.shown.borrow_mut() = None; // (it left full screen and didn't come back in)
            json!({ "placed": false })
        }
        Command::Engine { op, .. } if op == "show" => json!({ "failed": "full screen", "why": "it didn't" }),
        c => usual(c),
    });
    assert_eq!(kinds(&seen), ["engine pageRectChanged", "engine show"]);
    assert_eq!(
        s.done(),
        [
            "page area changed: 1244×933 (not fitted)",
            "app:com.b: not shown again after its placing failed (full screen: it didn't): hosted still, out of sight; its item is kept"
        ]
    );
    let a = acts(&world);
    assert_eq!(
        named(&a, "setShowing"),
        // (The last the hosting settled: nothing shown, its launcher.)
        [
            json!(["setShowing", 1, "B", "com.b", false]),
            json!(["setShowing", 1, null, null, false]),
            json!(["setShowing", 1, null, null, false])
        ]
    );
    assert_eq!(named(&a, "clearCover").len(), 1, "the hosting settled once");
    assert_eq!(world.now.get(), 1.5, "after its pause");
}

#[test]
fn a_host_gone_out_of_every_layout_its_focus_back_to_main() {
    let (s, _, _) = session();
    let open = |i: &str, h: &str| (i.to_string(), OpenItem { host: h.into(), profile: None });
    s.core().edit(Field::Open, |st| st.open.extend([open("a", "app:a"), open("b", "app:b"), open("c", "app:c")]));
    let l = |main: &str, extras: &[&str], focused: &str| Layout {
        main: main.into(),
        main_rect: None,
        extras: extras.iter().map(|e| Extra { item: e.to_string(), role: "pane".into(), rect: Rect::ZERO }).collect(),
        focused: focused.into(),
        split: None,
    };
    s.core().set_layout_of(1, Some(l("a", &["b"], "b")));
    s.core().set_layout_of(2, Some(l("b", &["c"], "c")));
    s.core().set_layout_of(3, Some(l("c", &["b", "a"], "b")));
    s.input(&json!({ "type": "forgetInLayouts", "host": "app:b" }));
    // (Window 1's last other went: no layout; window 2's main went: none; window 3 keeps a, its focus back on main.)
    assert_eq!(s.core().read(|st| st.layouts.keys().copied().collect::<Vec<_>>()), [3]);
    let l3 = s.core().layout_of(3).expect("a layout");
    assert_eq!((l3.focused.as_str(), l3.extras.len(), l3.extras[0].item.as_str()), ("c", 1, "a"));
}

#[test]
fn a_drags_frame_only_the_layouts_panes_followed_a_panes_rect_kept_over_the_cards() {
    let (s, world, _) = session();
    world.follows.set(true);
    s.core().set_hosting(Some(1));
    *world.shown.borrow_mut() = Some("safari:s-default".into());
    // (The card's window is a pane's host here too: the pane's rect is the one kept.)
    s.core().edit(Field::Open, |st| {
        st.open.insert("w1".into(), OpenItem { host: "safari:s-default".into(), profile: Some("s-default".into()) });
        st.open
            .insert("a2".into(), OpenItem { host: "safari:s-default#card".into(), profile: Some("s-default".into()) });
        st.open.insert("x9".into(), OpenItem { host: "app:com.x".into(), profile: None });
    });
    s.core().set_layout_of(
        1,
        Some(Layout {
            main: "w1".into(),
            main_rect: None,
            extras: vec![Extra { item: "a2".into(), role: "pane".into(), rect: Rect::ZERO }],
            focused: "w1".into(),
            split: Some("sp".into()),
        }),
    );
    let mut c = Card::new("s-default", 1, "w1", None, "https://c/", None);
    c.ready = true;
    s.core().set_card("s-default", Some(c));
    let mut page = Page::default();
    page.set_hosting(true);
    page.set_full_screen(true);
    // (Its page lays out a third pane the layout hasn't: x9's, not followed.)
    let report = br#"{"insets":{"left":260,"top":8,"right":8,"bottom":8},"radius":6,"container":{"width":1512,"height":949},"mode":"fullscreen","pageHosted":true,"split":"sp","panes":[{"id":"w1","rect":[260,8,400,933]},{"id":"a2","rect":[668,8,400,933]},{"id":"x9","rect":[1076,8,428,933]}]}"#;
    assert!(page.set_layout_bytes(report).taken);
    s.input(&json!({ "type": "sidebarResizing", "window": 1, "on": true, "divider": true }));
    acts(&world);
    let content = Rect::new(0.0, 0.0, 1512.0, 949.0);
    let card = Some(Rect::new(400.0, 100.0, 600.0, 500.0));
    let frame = Frame::Page { page: &page, content, display: None, card };
    assert_eq!(s.page_rect(1, &frame), PageRect::Followed);
    assert_eq!(
        acts(&world),
        [json!([
            "follow",
            1244.0,
            [["safari:s-default", 260.0, 8.0, 400.0, 933.0], ["safari:s-default#card", 668.0, 8.0, 400.0, 933.0]]
        ])]
    );
}

#[test]
fn a_new_panes_loader_its_own_while_the_engine_lays_it_out_held_till_its_toolbar_rests() {
    let (s, world, shelf) = session();
    world.profiles.borrow_mut().push("s-default".into());
    item(
        &shelf,
        "w1",
        json!({ "target": { "kind": "web", "browser": "safari", "profile": null }, "url": "https://a/" }),
    );
    item(
        &shelf,
        "w2",
        json!({ "target": { "kind": "web", "browser": "safari", "profile": null }, "url": "https://b/" }),
    );
    shelf.0.borrow_mut().insert(("splits".into(), "sp".into()), json!({ "panes": ["w1", "w2"] }));
    *world.panes.borrow_mut() = Some((
        "sp".into(),
        vec![("w1".into(), Rect::new(260.0, 8.0, 618.0, 933.0)), ("w2".into(), Rect::new(886.0, 8.0, 618.0, 933.0))],
    ));
    s.core().edit(Field::SafariWindows, |st| {
        st.safari_windows.insert(("s-default".into(), Role::Main), 90);
        st.safari_windows.insert(("s-default".into(), Role::Pane(1)), 93);
    });
    // (Main's window shown already; the pane's window made by this layout.)
    *world.shown.borrow_mut() = Some("safari:s-default".into());
    world.hosted.borrow_mut().push("safari:s-default".into());
    let during = std::cell::RefCell::new(None);
    let out = s.input(
        &json!({ "type": "library", "request": { "type": "showSplit", "splitId": "sp", "item": "w2", "windowId": 1 } }),
    );
    let mut answer = laid_out(&[]);
    let seen = pump(&s, &world, out, &mut |c| {
        if matches!(c, Command::Engine { op, .. } if op == "setLayout") {
            *during.borrow_mut() =
                Some(s.core().read(|st| (st.panes_laying.get(&1).cloned(), st.reveal_held.contains(&1))));
        }
        answer(c)
    });
    let (laying, held) = during.borrow().clone().expect("laid out");
    // (Only the pane coming in: main isn't, this split not shown there before.)
    assert_eq!(
        laying.map(|m| m.into_iter().collect::<Vec<_>>()),
        Some(vec![("safari:s-default#pane1".to_string(), "w2".to_string())])
    );
    assert!(held, "its loader kept until its toolbar rests");
    assert!(kinds(&seen).contains(&"engine toolbarsRest".to_string()));
    assert!(s.core().read(|st| st.panes_laying.is_empty() && st.reveal_held.is_empty()), "both let go after");
}
