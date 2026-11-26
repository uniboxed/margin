//! A Safari the person opened, asked first before Margin hosts it (restart.rs): through the re-entrant test adapter,
//! what a web item's show asks of Margin's window, the engine and the copies while the question is up, and after each
//! answer.

use super::requests_tests::{acts, item, kinds, named, pump, usual};
use super::*;
use crate::session::restart::{Asked, SafariRun};

const PERSONS: SafariRun = SafariRun { pid: 77, hosting: false, hosted: false };

fn web(lib: &TestLibrary, id: &str) {
    item(
        lib,
        id,
        json!({ "target": { "kind": "web", "browser": "safari", "profile": "s-default" }, "url": "https://a/" }),
    );
}

fn pick(s: &Session, id: &str) -> Out {
    s.input(&json!({ "type": "library", "request": { "type": "activateTab", "item": id, "windowId": 1 } }))
}

fn answer(s: &Session, action: &str) -> Out {
    s.input(&json!({ "type": "ui", "kind": "safariRestart", "payload": { "action": action } }))
}

/// The usual answers, the engine's open making the profile's window as the copy does (requests_tests.rs's web item).
fn opens(s: &Session, c: &Command) -> Value {
    match c {
        Command::Engine { op, args } if op == "open" && args["target"]["kind"] == json!("safari") => {
            s.core().edit(Field::SafariWindows, |st| st.safari_windows.insert(("s-default".into(), Role::Main), 90));
            json!({ "shown": "safari:s-default", "placed": true })
        }
        c => usual(c),
    }
}

/// The notices pushed to Margin's windows that ask it.
fn asks(world: &World) -> Vec<Value> {
    named(&acts(world), "push")
        .into_iter()
        .filter(|p| p[2].as_str().is_some_and(|j| j.contains("safari-restart")))
        .collect()
}

#[test]
fn a_safari_the_person_opened_asked_once_before_its_first_show_not_now_hosts_it_as_it_is() {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    world.safari_run.set(Some(PERSONS));
    web(&lib, "w1");
    let seen = pump(&s, &world, pick(&s, "w1"), &mut |c| opens(&s, c));
    assert!(seen.is_empty(), "nothing hosted, nothing asked of the copy while it's asked: {:?}", kinds(&seen));
    let pushed = asks(&world);
    assert_eq!(pushed.len(), 1, "asked in Margin's window");
    assert_eq!(pushed[0][1], json!(1));
    assert_eq!(pushed[0][2], json!(r#"{"type":"hostNote","kind":"safari-restart"}"#));
    assert!(s.done().iter().any(|l| l.contains("Safari was opened outside Margin")), "{:?}", s.done());
    // Not now: hosted as it is, at once.
    let seen = pump(&s, &world, answer(&s, "later"), &mut |c| opens(&s, c));
    assert_eq!(kinds(&seen), ["engine open", "ask hostShow"]);
    assert!(s.done().iter().any(|l| l.contains("hosted as it is")), "{:?}", s.done());
    // Never asked again for that Safari.
    web(&lib, "w2");
    world.safari_run.set(Some(SafariRun { hosted: true, ..PERSONS }));
    let seen = pump(&s, &world, pick(&s, "w2"), &mut |c| opens(&s, c));
    assert!(asks(&world).is_empty());
    assert!(!kinds(&seen).is_empty());
}

#[test]
fn restart_safari_it_is_started_again_with_margins_arguments_then_hosted() {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    world.safari_run.set(Some(PERSONS));
    web(&lib, "w1");
    assert!(pump(&s, &world, pick(&s, "w1"), &mut |c| opens(&s, c)).is_empty());
    assert_eq!(asks(&world).len(), 1);
    let w = world.clone();
    let seen = pump(&s, &world, answer(&s, "restart"), &mut |c| match c {
        Command::Engine { op, args } if op == "restartSafari" => {
            assert_eq!(args.get("pid"), Some(&json!(77)), "that Safari, by its process");
            w.safari_run.set(Some(SafariRun { pid: 90, hosting: true, hosted: false }));
            json!({ "restarted": true, "pid": 90 })
        }
        c => opens(&s, c),
    });
    assert_eq!(kinds(&seen), ["engine restartSafari", "engine open", "ask hostShow"]);
    assert!(s.done().iter().any(|l| l.contains("Safari restarted by Margin")), "{:?}", s.done());
    assert!(asks(&world).is_empty(), "the new Safari has the arguments: nothing asked");
}

#[test]
fn a_restart_that_doesnt_happen_is_said_and_that_safari_hosted_as_it_is_never_asked_again() {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    world.safari_run.set(Some(PERSONS));
    web(&lib, "w1");
    pump(&s, &world, pick(&s, "w1"), &mut |c| opens(&s, c));
    let seen = pump(&s, &world, answer(&s, "restart"), &mut |c| match c {
        Command::Engine { op, .. } if op == "restartSafari" => {
            json!({ "restarted": false, "why": "Safari didn’t quit within 6 s" })
        }
        c => opens(&s, c),
    });
    assert_eq!(kinds(&seen), ["engine restartSafari", "engine open", "ask hostShow"]);
    assert!(s.done().iter().any(|l| l.contains("not restarted") && l.contains("didn’t quit")), "{:?}", s.done());
    web(&lib, "w2");
    pump(&s, &world, pick(&s, "w2"), &mut |c| opens(&s, c));
    assert_eq!(asks(&world).len(), 1, "the one before only");
}

#[test]
fn never_asked_for_a_safari_margin_started_one_it_hosts_or_none_running() {
    for run in [None, Some(SafariRun { hosting: true, ..PERSONS }), Some(SafariRun { hosted: true, ..PERSONS })] {
        let (s, world, lib) = session();
        world.profiles.borrow_mut().push("s-default".into());
        world.safari_run.set(run);
        web(&lib, "w1");
        let seen = pump(&s, &world, pick(&s, "w1"), &mut |c| opens(&s, c));
        assert_eq!(kinds(&seen), ["engine open", "ask hostShow"], "{run:?}");
        assert!(asks(&world).is_empty(), "{run:?}");
    }
}

#[test]
fn an_app_is_never_held_by_it_and_another_pick_meanwhile_ends_the_wait() {
    let (s, world, lib) = session();
    world.profiles.borrow_mut().push("s-default".into());
    world.safari_run.set(Some(PERSONS));
    web(&lib, "w1");
    item(&lib, "a1", json!({ "target": { "kind": "app", "bundleId": "com.apple.Notes", "name": "" }, "title": "N" }));
    assert!(pump(&s, &world, pick(&s, "w1"), &mut |c| opens(&s, c)).is_empty());
    // Another item picked in that window while it's asked: shown at once; the Safari show given up.
    let seen = pump(&s, &world, pick(&s, "a1"), &mut |c| opens(&s, c));
    assert_eq!(kinds(&seen), ["engine open"], "the app's own open, not held up");
    let Command::Engine { args, .. } = &seen[0] else { panic!() };
    assert_eq!(args["target"]["kind"], json!("app"));
    assert!(s.done().iter().any(|l| l.contains("w1") && l.contains("given up")), "{:?}", s.done());
    // A late answer opens nothing for it.
    let seen = pump(&s, &world, answer(&s, "later"), &mut |c| opens(&s, c));
    assert!(seen.is_empty(), "{:?}", kinds(&seen));
}

#[test]
fn an_answer_with_nothing_asked_does_nothing() {
    let (s, world, _lib) = session();
    world.safari_run.set(Some(PERSONS));
    let seen = pump(&s, &world, answer(&s, "restart"), &mut |c| opens(&s, c));
    assert!(seen.is_empty());
    let out = answer(&s, "restart");
    assert_eq!(out.reply, Some(json!({ "route": "answer", "value": { "ok": true, "result": true } })));
}

#[test]
fn the_launchs_preparation_leaves_a_safari_the_person_opened_alone_until_it_is_asked() {
    let prepare = |s: &Session| {
        s.input(&json!({ "type": "call", "id": 3, "flow": "prepareBrowser", "args": { "setting": null } }))
    };
    let (s, world, lib) = session();
    world.out_of_sight.set(true);
    lib.put("spaces", "s1", json!({ "name": "Home", "order": 0, "profile": "" }));
    world.safari_run.set(Some(PERSONS));
    let seen = pump(&s, &world, prepare(&s), &mut |c| opens(&s, c));
    assert_eq!(kinds(&seen), ["reply"], "nothing started, woken or made ready in it");
    assert_eq!(s.done(), ["browser not prepared: Safari was opened outside Margin (asked about at its first show)"]);
    assert!(asks(&world).is_empty(), "not asked for a preparation: only for a show the person wants");
    // Margin's own Safari, or one whose question is over: made ready as ever.
    for (run, asked) in [(SafariRun { hosting: true, ..PERSONS }, None), (PERSONS, Some((77, Asked::Settled)))] {
        let (s, world, lib) = session();
        world.out_of_sight.set(true);
        lib.put("spaces", "s1", json!({ "name": "Home", "order": 0, "profile": "" }));
        world.safari_run.set(Some(run));
        s.core().restart_ask.set(asked);
        let seen = pump(&s, &world, prepare(&s), &mut |c| match c {
            Command::Engine { op, .. } if op == "start" => json!({ "started": true }),
            c => opens(&s, c),
        });
        assert_eq!(kinds(&seen)[..4], ["engine start", "waker ensureLinked", "reply", "engine prepare"], "{run:?}");
    }
}
