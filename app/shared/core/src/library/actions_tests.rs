// actions.rs against library.ts (LT:177-832): every perform step of the shared vectors (tests/fixtures/library: the TS
// tests' calls, the generated sequences, the edges, the throw survey) through the real actions, as JavaScriptCore
// answered them; then the few things the vectors can't show (the ids past the env's, the names refused, a request's
// numbers), and the cost of a perform (ignored: `cargo test --release -p margin-core perform_costs -- --ignored
// --nocapture`).

use std::collections::BTreeMap;
use std::time::Instant;

use serde_json::{Map, Value, json};

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::state::state_of;
use crate::library::values::values_of;
use crate::library::vectors::{self, AsciiCollation, Engine};

fn lib(v: Value) -> LibState {
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

fn env(now: f64, ids: &[&str]) -> Env {
    Env { now, ids: ids.iter().map(|x| x.to_string()).collect() }
}

fn run(s: &LibState, action: &str, payload: Value, ids: &[&str]) -> Outcome {
    perform(s, action, &payload, env(5000.0, ids), &CodePointOrder)
}

// ---- the shared vectors ----------------------------------------------------------------------------------------------

/// The core's actions as the vectors' engine: the values read (`stateOf`, the system's sorter's stand-in: ICU's root
/// on ASCII; margin-ffi's tests run the same steps through libicucore), the action
/// performed. Skipped, and counted: a `createSpace` given an emoji or colour that's truthy and no string (the typed
/// space's known gap: JS stores the value as given, the core `""`, what the next reading of it is; spaces.rs `text_or`).
struct Core {
    compare: AsciiCollation,
    gap: usize,
    by: BTreeMap<String, usize>,
}

impl Engine for Core {
    fn perform(
        &mut self,
        values: &Map<String, Value>,
        action: &str,
        payload: &Value,
        env: &vectors::Env,
    ) -> Option<Value> {
        if action == "createSpace" {
            let odd = |k: &str| payload.get(k).is_some_and(|v| js::truthy(Some(v)) && !v.is_string());
            if odd("emoji") || odd("color") {
                self.gap += 1;
                return None;
            }
        }
        let s = state_of(values, &self.compare);
        let out = perform(&s, action, payload, Env { now: env.now, ids: env.ids.clone() }, &self.compare);
        *self.by.entry(action.to_owned()).or_default() += 1;
        Some(out.to_json())
    }
}

#[test]
fn every_perform_vector_answers_as_library_ts() {
    let mut engine = Core { compare: AsciiCollation::new(), gap: 0, by: BTreeMap::new() };
    let mut report = vectors::run(&mut engine);
    // A `cut` step the typed diff answers without its no-op rewrite: library.ts renames a favorite to the name it has
    // but half an emoji (its cut), whose value, the half dropped (Tirth's answer 3), is the stored one; the core's diff
    // sees no change (favorites.rs `rename_favorite`, DECISIONS.md 2026-11-23 piece 2). (`vectors::KNOWN`: its edge.)
    let known = vectors::KNOWN;
    let (expected, rest): (Vec<String>, Vec<String>) =
        report.failures.drain(..).partition(|f| known.iter().any(|k| f.starts_with(k)));
    report.failures = rest;
    report.assert_ok();
    assert_eq!(expected.len(), known.len(), "the known cut step: {expected:?}");
    let checked = report.checked.get("perform").copied().unwrap_or(0);
    let skipped = report.skipped.get("perform").copied().unwrap_or(0);
    eprintln!(
        "the actions' vectors: {checked} perform steps checked, {skipped} skipped (the gap); by action {:?}",
        engine.by
    );
    assert_eq!(engine.gap, 16, "the createSpace steps of the known gap");
    assert_eq!(skipped, engine.gap, "every other perform step checked");
    assert!(checked > 8700, "{checked} perform steps");
    let names: Vec<&str> = engine.by.keys().map(String::as_str).filter(|n| ACTION_NAMES.contains(n)).collect();
    assert_eq!(names.len(), ACTION_NAMES.len(), "every action has vectors: {:?}", engine.by.keys());
}

/// More generated sequences (a scratch harness's: tests/library-vectors' generator with other seeds, answered by
/// library.ts in Node and JavaScriptCore), from `MARGIN_LIBRARY_MORE_VECTORS` (a folder of case files). A `cut` step's
/// expected rewrite of a value with the value it has (the known no-op of a rename through an emoji, as the shared
/// vectors' one) is left out and counted.
#[test]
#[ignore]
fn more_generated_sequences() {
    let Ok(dir) = std::env::var("MARGIN_LIBRARY_MORE_VECTORS") else { return };
    let groups = vectors::groups_in(std::path::Path::new(&dir));
    let mut engine = Core { compare: AsciiCollation::new(), gap: 0, by: BTreeMap::new() };
    let (mut checked, mut urls, mut rewrites, mut failures) = (0, 0, 0, Vec::new());
    for g in &groups {
        for (ci, case) in g.cases.iter().enumerate() {
            let mut values = case.values.clone();
            for (si, step) in case.steps.iter().enumerate() {
                if let vectors::Kind::Perform { action, payload, env, expect } = &step.kind {
                    if let Some(got) = engine.perform(&values, action, payload, env) {
                        checked += 1;
                        urls += usize::from(step.url);
                        let mut want = expect.to_json();
                        if step.cut {
                            // (Against the values as perform reads them: `valuesOf(stateOf(values))`, LT:820.)
                            let normal = values_of(&state_of(&values, &engine.compare), &Map::new());
                            let changes = want["changes"].as_array_mut().unwrap();
                            let before = changes.len();
                            changes.retain(|c| {
                                let (col, id) = (c["collection"].as_str().unwrap(), c["id"].as_str().unwrap());
                                let had = normal.get(col).and_then(|l| l.get(id));
                                !matches!((had, c.get("value")), (Some(a), Some(b)) if vectors::differ(a, b).is_none())
                            });
                            rewrites += before - changes.len();
                        }
                        if let Some(why) = vectors::differ(&got, &want) {
                            failures.push(format!("{} › case {ci} › step {si} ({action}): {why}", g.file));
                        }
                    }
                }
                if let Some(changes) = step.changes() {
                    vectors::merge(&mut values, changes);
                }
            }
        }
    }
    eprintln!(
        "{checked} perform steps checked ({urls} of them url steps: the browsers' answers), {} of the gap, {rewrites} no-op rewrites of a cut, {} differ {:?}",
        engine.gap,
        failures.len(),
        &failures[..failures.len().min(10)]
    );
    assert!(failures.is_empty());
}

// ---- what the vectors don't show ---------------------------------------------------------------------------------------

#[test]
fn the_names_taken_and_refused() {
    let mut sorted = ACTION_NAMES.to_vec();
    sorted.sort_by(|a, b| js::cmp16(a, b));
    sorted.dedup();
    assert_eq!(sorted, ACTION_NAMES, "sorted as JS sorts, each once");
    let s = lib(json!({ "spaces": { "a": { "order": 0 } } }));
    for name in ACTION_NAMES {
        let out = run(&s, name, json!({}), &[]);
        assert_ne!(out.error.as_deref(), Some("unsupported"), "{name}");
    }
    // (`Object.hasOwn(ACTIONS, action)`: the prototype's names and anything else aren't actions.)
    for name in ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "", "perform", "SetSpace"] {
        let out = run(&s, name, json!({}), &[]);
        assert_eq!((out.ok, out.error.as_deref()), (false, Some("unsupported")), "{name}");
        assert!(out.changes.is_empty() && out.requests.is_empty());
    }
}

#[test]
fn a_failure_changes_and_asks_nothing() {
    let s = lib(json!({
        "spaces": { "a": { "order": 0 } },
        "tabs": { "t-1": { "url": "https://a.com/", "spaceId": "gone", "order": 0 } },
    }));
    let out = run(&s, "createSpace", json!({ "windowId": 1, "name": 5 }), &["abcd"]);
    assert_eq!(out.error.as_deref(), Some(format!("failed: {}", spaces::CREATE_SPACE_NAME_THROWS).as_str()));
    assert!(out.changes.is_empty() && out.requests.is_empty() && out.result.is_null());
    // An item of a gone space archived with no space left: model.ts's throw (`state.spaces[0].id`).
    let none = lib(json!({ "tabs": { "t-1": { "url": "https://a.com/", "spaceId": "gone", "order": 0 } } }));
    for action in ["closeTab", "itemClosed", "closeSplitPane"] {
        let out = run(&none, action, json!({ "tabId": "t-1" }), &["abcd"]);
        assert_eq!(out.error.as_deref(), Some(format!("failed: {}", kept::NO_FIRST_SPACE).as_str()), "{action}");
        assert!(out.requests.is_empty(), "{action}: the close not asked");
    }
    // With a space left it goes to that one's archive.
    let out = run(&s, "closeTab", json!({ "tabId": "t-1" }), &["abcd"]);
    assert!(out.ok);
    assert_eq!(out.requests.len(), 1);
    let entry = out.changes.iter().find(|c| c.collection() == "archive").unwrap().to_json();
    assert_eq!(entry["value"]["spaceId"], "a");
}

#[test]
fn ids_past_the_envs_are_the_cores_own() {
    let tabs: Map<String, Value> = (0..6)
        .map(|i| (format!("t-{i}"), json!({ "url": format!("https://a{i}.com/"), "spaceId": "a", "order": i })))
        .collect();
    let s = lib(json!({ "spaces": { "a": { "order": 0 } }, "tabs": tabs }));
    // Swift gives 4 a perform: a clear of 6 takes 2 more of its own (10 letters and digits), and a given one that isn't
    // 4–30 letters and digits is used up all the same.
    let out = run(&s, "clearToday", json!({}), &["one1", "x", "two2", "three3"]);
    let ids: Vec<String> =
        out.changes.iter().filter(|c| c.collection() == "archive").map(|c| c.id().to_owned()).collect();
    assert_eq!(ids.len(), 6);
    for given in ["a-one1", "a-two2", "a-three3"] {
        assert!(ids.iter().any(|x| x == given), "{given} in {ids:?}");
    }
    let own: Vec<&String> = ids.iter().filter(|x| !["a-one1", "a-two2", "a-three3"].contains(&x.as_str())).collect();
    assert_eq!(own.len(), 3);
    for x in &own {
        let letters = x.strip_prefix("a-").unwrap();
        assert!(letters.len() == 10 && letters.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()), "{x}");
    }
    assert_eq!(out.result.as_array().unwrap().len(), 6, "the items closed, in their ids' order");
}

#[test]
fn a_requests_window_and_target_are_as_js_passes_them() {
    // A space's profile is kept as given (createSpace doesn't cut it; setSpaceProfile does, at 256): a new web item's
    // request names it whole, the item stores it cut (valuesOf's targetOf).
    let long: String = "p".repeat(300);
    let s = lib(json!({ "spaces": { "a": { "order": 0, "profile": long, "browser": "chrome" } } }));
    let out = run(&s, "newTab", json!({ "windowId": 7.0, "url": "https://a.com/" }), &["abcd"]);
    assert!(out.ok, "{:?}", out.error);
    let r = &out.requests[0];
    assert_eq!(r["windowId"].to_string(), "7", "a number through a double, written as JS writes it");
    assert_eq!(r["target"]["profile"].as_str().unwrap().len(), 300);
    assert_eq!(r["target"]["browser"], "chrome");
    let item = out.changes.iter().find(|c| c.collection() == "tabs").unwrap().to_json();
    assert_eq!(item["value"]["target"]["profile"].as_str().unwrap().len(), 256);
    // A window id that's no number nor string is passed on as it came, and isn't a window (`win`).
    let out = run(&s, "newTab", json!({ "windowId": [1, { "x": 2.5 }], "url": "https://b.com/" }), &["efgh"]);
    assert_eq!(out.requests[0]["windowId"], json!([1, { "x": 2.5 }]));
    assert!(out.changes.iter().all(|c| c.collection() != "windows"));
}

#[test]
fn a_failed_composite_asks_nothing() {
    // mediaControl's `focus` is activateTab (its request), `toggle` of an app item refused (none).
    let s = lib(json!({
        "spaces": { "a": { "order": 0 } },
        "tabs": {
            "t-1": { "url": "https://a.com/", "spaceId": "a", "order": 0 },
            "t-2": { "url": "app://com.apple.Notes", "spaceId": "a", "order": 1, "target": { "kind": "app", "bundleId": "com.apple.Notes" } },
        },
    }));
    let out = run(&s, "mediaControl", json!({ "tabId": "t-1", "command": "focus", "windowId": 1 }), &[]);
    assert_eq!(out.requests[0]["type"], "activateTab");
    assert_eq!(out.result, json!({ "shown": "t-1" }));
    let out = run(&s, "mediaControl", json!({ "tabId": "t-2", "command": "toggle" }), &[]);
    assert_eq!(out.error.as_deref(), Some("only a web item plays in the mini player"));
    assert!(out.requests.is_empty());
}

#[test]
fn what_three_breaks_showed() {
    // (Each checked against library.ts in Node: the vectors had no step of it.)
    let tabs: Map<String, Value> = (1..=16)
        .map(|i| (format!("t-{i}"), json!({ "url": format!("https://a{i}.com/"), "spaceId": "a", "order": i })))
        .collect();
    let s = lib(json!({ "spaces": { "a": { "order": 0 }, "b": { "order": 1 } }, "tabs": tabs }));
    // splitRefusal counts a pane given twice twice (`adding` isn't made unique against itself).
    let twice: Vec<String> = std::iter::once("t-1".to_owned()).chain((1..=16).map(|i| format!("t-{i}"))).collect();
    let out = run(&s, "createSplit", json!({ "panes": twice }), &["abcd"]);
    assert_eq!(out.error.as_deref(), Some("a split has 16 panes at most"));
    let out = run(&s, "createSplit", json!({ "panes": ["t-1", "t-2", "t-3", "t-4"] }), &["abcd"]);
    assert_eq!(out.result, json!({ "splitId": "spv-abcd" }));
    // moveTabToSpace moves the item a key finds (`String(p.tabId)`: `["t-1"]` is `t-1`).
    let out = run(&s, "moveTabToSpace", json!({ "tabId": ["t-1"], "spaceId": "b" }), &[]);
    assert_eq!(out.changes.len(), 1);
    assert_eq!(out.changes[0].to_json()["value"]["spaceId"], "b");
    // openMarginPage shows the page's item used last.
    let settings = json!({ "kind": "margin", "page": "settings" });
    let m = lib(json!({
        "spaces": { "a": { "order": 0 } }, "windows": { "1": { "spaceId": "a" } },
        "tabs": {
            "t-old": { "url": "margin://settings", "spaceId": "a", "order": 0, "lastUsed": 10, "target": settings },
            "t-new": { "url": "margin://settings", "spaceId": "a", "order": 1, "lastUsed": 20, "target": settings },
        },
    }));
    let out = run(&m, "openMarginPage", json!({ "page": "settings", "windowId": 1 }), &["abcd"]);
    assert_eq!(out.result, json!({ "tabId": "t-new" }));
    assert_eq!(out.requests[0]["type"], "activateTab");
}

// ---- the cost ----------------------------------------------------------------------------------------------------------

fn median(runs: usize, mut f: impl FnMut(usize)) -> f64 {
    let mut times: Vec<f64> = (0..runs)
        .map(|k| {
            let t = Instant::now();
            f(k);
            t.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    times.sort_by(f64::total_cmp);
    times[times.len() / 2]
}

#[test]
#[ignore]
fn perform_costs() {
    let compare = AsciiCollation::new();
    for n in [50, 500, 2000] {
        let set = vectors::baseline(n);
        let s = state_of(&set, &compare);
        let ids =
            |k: usize| vec![format!("base{k}x0"), format!("base{k}x1"), format!("base{k}x2"), format!("base{k}x3")];
        let activate = |s: &LibState, k: usize| {
            let p = json!({ "windowId": 1, "tabId": format!("t-i{}", k % n) });
            perform(s, "activateTab", &p, Env { now: 5000.0 + k as f64, ids: ids(k) }, &compare)
        };
        for k in 0..5 {
            assert!(activate(&s, k).ok);
        }
        let cached = median(25, |k| {
            std::hint::black_box(activate(&s, k));
        });
        let read = median(25, |k| {
            let s = state_of(&set, &compare);
            std::hint::black_box(activate(&s, k));
        });
        let rename = median(25, |k| {
            let p = json!({ "tabId": format!("t-i{}", k % n), "title": format!("Renamed {k}") });
            std::hint::black_box(perform(&s, "renameTab", &p, Env { now: 6000.0, ids: ids(k) }, &compare));
        });
        let close = median(25, |k| {
            let p = json!({ "tabId": format!("t-i{}", k % n) });
            std::hint::black_box(perform(&s, "closeTab", &p, Env { now: 7000.0, ids: ids(k) }, &compare));
        });
        let state = median(25, |_| {
            std::hint::black_box(state_of(&set, &compare));
        });
        eprintln!(
            "{n} items (+200 archived, 2 KB icons): activateTab {cached:.3} ms on the kept state, {read:.3} ms with the state read; renameTab {rename:.3} ms, closeTab {close:.3} ms; the state read alone {state:.3} ms"
        );
    }
}

/// What parsing addresses costs (Tirth's answer 11): the actions that match an address, each on a library of `n` items
/// in two spaces with 200 archived, 50 pins (`…/page/`: a trailing slash, so a match needs the parse), 12 favorites and
/// 99 link rules (the last the one that matches), parsed and with no URL (JSC's), and one `normalize_url`. Ignored:
/// `cargo test --release -p margin-core url_costs -- --ignored --nocapture`.
#[test]
#[ignore]
fn url_costs() {
    let compare = AsciiCollation::new();
    let web = json!({ "kind": "web", "browser": "safari", "profile": null });
    let addresses: Vec<String> = (0..7).map(|k| format!("https://Site{k}.example:443/page/#top")).collect();
    let t = Instant::now();
    for k in 0..100_000 {
        std::hint::black_box(js::normalize_url(std::hint::black_box(&addresses[k % 7])));
    }
    eprintln!("normalize_url of an address: {:.0} ns", t.elapsed().as_secs_f64() * 1e9 / 100_000.0);
    for n in [50, 500, 2000] {
        let map = |list: Vec<(String, Value)>| Value::Object(list.into_iter().collect());
        let values = json!({
            "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } },
            "windows": { "1": { "spaceId": "a" } },
            "tabs": map((0..n).map(|i| (format!("t-i{i}"), json!({ "url": format!("https://site{i}.example/page"), "title": "T", "icon": "", "spaceId": if i % 2 == 0 { "a" } else { "b" }, "order": i, "lastUsed": 1000 + i, "target": web }))).collect()),
            "archive": map((0..200).map(|i| (format!("a-{i}"), json!({ "url": format!("https://old{i}.example/"), "title": "O", "spaceId": "a", "icon": "", "closedAt": 500 + i, "target": web }))).collect()),
            "pins": map((0..50).map(|k| (format!("p-{k:02}"), json!({ "spaceId": "a", "url": format!("https://site{}.example/page/", 2 * k), "title": "P", "folderId": null, "pos": k, "target": web }))).collect()),
            "favorites": map((0..12).map(|k| (format!("fav-{k:02}"), json!({ "scope": "global", "url": format!("https://SITE{}.example/page", 2 * k + 1), "title": "F", "pos": k, "target": web }))).collect()),
            "airTraffic": map((0..99).map(|k| (format!("atc-{k:02}"), json!({ "pattern": if k == 98 { "site0.example/page".to_string() } else { format!("other{k}.example") }, "spaceId": "b", "order": k }))).collect()),
        });
        let s = state_of(values.as_object().unwrap(), &compare);
        let ids = |k: usize| vec![format!("url{k}x0"), format!("url{k}x1"), format!("url{k}x2"), format!("url{k}x3")];
        type Payload = Box<dyn Fn(usize) -> Value>;
        let calls: [(&str, Payload); 6] = [
            ("openPin", Box::new(|k| json!({ "windowId": 1, "pinId": format!("p-{:02}", k % 50) }))),
            ("openFavorite", Box::new(|k| json!({ "windowId": 1, "favoriteId": format!("fav-{:02}", k % 12) }))),
            ("addFavorite", Box::new(|_| json!({ "windowId": 1, "url": "https://site1.example/page/#x" }))),
            ("closeTab", Box::new(move |k| json!({ "tabId": format!("t-i{}", k % n) }))),
            ("routeUrl", Box::new(|_| json!({ "url": "https://site0.example/page" }))),
            ("newTab", Box::new(|_| json!({ "windowId": 1, "url": "https://site0.example/page" }))),
        ];
        let mut line = Vec::new();
        for (name, payload) in &calls {
            let go = |k: usize| perform(&s, name, &payload(k), Env { now: 9000.0 + k as f64, ids: ids(k) }, &compare);
            assert!(go(0).ok, "{name}");
            let parsed = median(41, |k| {
                std::hint::black_box(go(k));
            });
            line.push(format!("{name} {:.1} µs", parsed * 1000.0));
        }
        eprintln!("{n} items (+200 archived, 50 pins, 12 favorites, 99 rules): {}", line.join(", "));
    }
}
