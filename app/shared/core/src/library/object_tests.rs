// The library object (L:89-286) and library.js's entry (LT:939): every kind of the shared vectors through the entry,
// the object's perform as Library.swift's (the store, the observers, the requests kept and handed to the sink in its
// order), re-entered on every call out (as the session's tests do), the import once over a data object's sets, and
// the cost of a perform through the object (ignored: `cargo test --release -p margin-core object_costs -- --ignored
// --nocapture`).

use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::rc::{Rc, Weak};
use std::time::Instant;

use serde_json::{Value, json};

use super::*;
use crate::data::library::LibraryStore;
use crate::data::store::{DataProfile, DataStore, Stored};
use crate::data::sync::DataSync;
use crate::data::testing::temp;
use crate::library::vectors::{self, AsciiCollation};

// ---- every kind of the vectors through the entry ------------------------------------------------------------------

#[test]
fn every_vector_through_library_js_entry() {
    let (checked, gap) = vectors::run_entry(&AsciiCollation::new());
    eprintln!("library.js's entry: checked {checked:?}, {gap} skipped (the gap)");
}

#[test]
fn the_entry_answers_as_library_js() {
    let c = AsciiCollation::new();
    let v = |name: &str, args: &str| serde_json::from_str::<Value>(&call(name, args, &c)).unwrap();
    assert_eq!(v("nope", "[]"), json!({ "error": "no function nope" }));
    assert!(v("perform", "[").get("error").is_some(), "not JSON: an error");
    assert_eq!(v("actions", "[]")["value"].as_array().map(Vec::len), Some(57));
    assert_eq!(
        v("perform", r#"[{}, "nothing", {}, {"now": 1}]"#),
        json!({ "value": { "ok": false, "error": "unsupported", "changes": [], "requests": [] } }),
        "a failure has no result, as LT's"
    );
    let made = v("perform", r#"[{}, "createSpace", {"name": "A"}, {"now": 1, "ids": ["abcd"]}]"#);
    assert_eq!(made["value"]["result"], json!({ "spaceId": "sp-abcd" }));
    assert_eq!(v("perform", r#"[{}, "createSpace", {"name": "A"}]"#)["value"]["ok"], json!(true), "no env: now 0");
    assert_eq!(v("snapshot", "[null]")["value"]["library"], json!({ "v": 1, "imported": false }));
    let imported = v("importValues", r#"[{}, [], [], {"now": 3}]"#);
    assert_eq!(imported["value"]["changes"][0]["value"]["at"], json!(3));
    assert_eq!(imported["value"]["counts"], json!({ "spaces": 0, "pins": 0, "folders": 0, "tabs": 0, "archive": 0 }));
}

// ---- the object -------------------------------------------------------------------------------------------------

/// What happened, in order: `env`, `now`, `changed …`, `request …`, and what a call back in read.
#[derive(Default)]
struct Seen(RefCell<Vec<String>>);

impl Seen {
    fn push(&self, s: impl Into<String>) {
        self.0.borrow_mut().push(s.into());
    }
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.borrow_mut())
    }
}

/// The host: the env from a counter (4 ids an action, Swift's count), a fixed clock, the observers recorded; and on
/// every call out, the library re-entered (`reenter`: every read, and once a nested perform from an observer).
struct Host {
    seen: Rc<Seen>,
    library: RefCell<Weak<Library>>,
    next: Cell<u32>,
    reenter: bool,
    nested: Cell<bool>,
}

impl Host {
    fn new(seen: Rc<Seen>, reenter: bool) -> Host {
        Host { seen, library: RefCell::new(Weak::new()), next: Cell::new(0), reenter, nested: Cell::new(false) }
    }

    fn back_in(&self, at: &str) {
        if !self.reenter {
            return;
        }
        let Some(lib) = self.library.borrow().upgrade() else { return };
        // Every read, while the edit is under way: a borrow held across this call out would panic here.
        let _ = lib.snapshot_text();
        let _ = lib.state();
        let _ = lib.item("tabs", "t-x");
        let _ = lib.live("spaces");
        let _ = lib.values();
        let _ = lib.is_imported();
        let _ = lib.requests();
        let _ = lib.take_log();
        self.seen.push(format!("{at}: read back in"));
    }
}

struct HostRef(Rc<Host>);

impl LibraryHost for HostRef {
    fn env(&self) -> actions::Env {
        self.0.seen.push("env");
        self.0.back_in("env");
        let n = self.0.next.get() + 1;
        self.0.next.set(n);
        actions::Env { now: 1000.0 + f64::from(n), ids: (0..4).map(|i| format!("id{n}x{i}")).collect() }
    }
    fn now(&self) -> f64 {
        self.0.seen.push("now");
        self.0.back_in("now");
        2000.0
    }
    fn changed(&self, collections: &BTreeSet<String>) {
        self.0.seen.push(format!("changed {}", collections.iter().cloned().collect::<Vec<_>>().join(",")));
        self.0.back_in("changed");
        // Once: an observer that edits (a perform inside a perform's observer), the same object.
        if self.0.reenter && !self.0.nested.replace(true) {
            let lib = self.0.library.borrow().upgrade();
            if let Some(lib) = lib {
                let space = lib.state().spaces.first().map(|s| s.id.to_string()).unwrap_or_default();
                let out = lib.perform("renameSpace", &json!({ "spaceId": space, "name": "Renamed inside" }));
                self.0.seen.push(format!("nested perform ok {}", out.outcome.ok));
            }
        }
    }
}

/// The session's stand-in as the sink: each request recorded, and the library read back in (as the session's
/// `library_request` reads it: the item's address).
struct Sink {
    seen: Rc<Seen>,
    host: Rc<Host>,
}

impl RequestSink for Sink {
    fn request(&self, r: &actions::Request) {
        self.seen.push(format!("request {}", r.get("type").and_then(Value::as_str).unwrap_or("?")));
        self.host.back_in("request");
    }
}

fn library(root: &std::path::Path, reenter: bool) -> (Rc<Library>, Rc<Seen>, Rc<Host>) {
    let seen = Rc::new(Seen::default());
    let host = Rc::new(Host::new(seen.clone(), reenter));
    let mut store = DataStore::new(root).flat();
    store.now = Box::new(|| 1.0);
    let lib = Rc::new(Library::new(
        LibraryStore::new(store),
        Box::new(HostRef(host.clone())),
        Box::new(AsciiCollation::new()),
    ));
    *host.library.borrow_mut() = Rc::downgrade(&lib);
    (lib, seen, host)
}

#[test]
fn a_perform_as_library_swift_makes_it() {
    let dir = temp();
    let (lib, seen, host) = library(dir.path(), false);
    let sink: Rc<dyn RequestSink> = Rc::new(Sink { seen: seen.clone(), host: host.clone() });
    lib.set_sink(Some(Rc::downgrade(&sink)));

    let made = lib.perform("createSpace", &json!({ "windowId": 1, "name": " Work " }));
    assert!(made.outcome.ok, "{made:?}");
    assert_eq!(made.outcome.result, json!({ "spaceId": "sp-id1x0" }), "the env's ids first");
    assert_eq!(made.changed, BTreeSet::from(["spaces".to_string(), "windows".to_string()]));
    // The env, then the store's time, then the observers (createSpace asks nothing).
    assert_eq!(seen.take(), ["env", "now", "changed spaces,windows"]);
    assert_eq!(lib.live("spaces")["sp-id1x0"]["name"], json!("Work"));
    assert_eq!(
        DataStore::new(dir.path())
            .flat()
            .load(&crate::data::library::key())
            .map(|s| s.set.item("spaces", "sp-id1x0").map(|i| i.updated_at)),
        Some(Some(2000.0)),
        "stored at the host's now"
    );

    // The state is read once per revision: the same until something is stored.
    let a = lib.state();
    assert!(Rc::ptr_eq(&a, &lib.state()));
    assert!(Rc::ptr_eq(&lib.snapshot_text(), &lib.snapshot_text()));
    assert_eq!(
        *lib.snapshot_text(),
        *snapshot::snapshot(&lib.values(), &AsciiCollation::new()),
        "the kept snapshot is the values' snapshot"
    );

    // A refusal: nothing stored, no observer, no request.
    let refused = lib.perform("renameSpace", &json!({ "spaceId": "none", "name": "X" }));
    assert!(!refused.outcome.ok && refused.changed.is_empty());
    assert_eq!(seen.take(), ["env"]);
    assert!(Rc::ptr_eq(&a, &lib.state()), "nothing stored: the same state");

    // The env, the store's time, the observers, then the requests: L:205-225's order.
    let space = "sp-id1x0";
    lib.perform("setSpace", &json!({ "windowId": 2, "spaceId": space }));
    assert_eq!(seen.take(), ["env", "now", "changed windows", "request setSpace"]);
    // An edit that changes nothing stored tells no one but still hands on its requests.
    lib.perform("setSpace", &json!({ "windowId": 1, "spaceId": space }));
    assert_eq!(seen.take(), ["env", "request setSpace"]);

    // An item, its request, and the last 100 requests kept.
    let added = lib.perform("addItem", &json!({ "windowId": 1, "spaceId": space, "url": "https://a.example/" }));
    let item = added.outcome.result["tabId"].as_str().unwrap().to_owned();
    assert_eq!(lib.item("tabs", &item).map(|v| v["url"].clone()), Some(json!("https://a.example/")));
    seen.take();
    for _ in 0..120 {
        lib.perform("activateTab", &json!({ "windowId": 1, "tabId": item }));
    }
    let kept = lib.requests();
    assert_eq!(kept.len(), REQUESTS_KEPT);
    assert_eq!(kept.last().and_then(|r| r.get("type")), Some(&json!("activateTab")));
    assert!(kept.iter().all(|r| r.get("type") == Some(&json!("activateTab"))), "the oldest dropped");

    // No sink (gone): the requests are only the answer's.
    seen.take();
    drop(sink);
    let out = lib.perform("activateTab", &json!({ "windowId": 1, "tabId": item }));
    assert_eq!(out.outcome.requests.len(), 1);
    assert!(!seen.take().iter().any(|s| s.starts_with("request")));
    assert_eq!(
        out.to_json(),
        json!({ "ok": true, "result": { "shown": item }, "changed": ["tabs"], "requests": [out.outcome.requests[0].clone()] })
    );
}

#[test]
fn re_entered_on_every_call_out() {
    let dir = temp();
    let (lib, seen, host) = library(dir.path(), true);
    let sink: Rc<dyn RequestSink> = Rc::new(Sink { seen: seen.clone(), host: host.clone() });
    lib.set_sink(Some(Rc::downgrade(&sink)));
    let made = lib.perform("createSpace", &json!({ "windowId": 1, "name": "A" }));
    assert!(made.outcome.ok);
    let space = made.outcome.result["spaceId"].as_str().unwrap().to_owned();
    let seen_now = seen.take();
    assert_eq!(
        seen_now,
        [
            "env",
            "env: read back in",
            "now",
            "now: read back in",
            "changed spaces,windows",
            "changed: read back in",
            // The nested perform, whole, inside the outer one's observer.
            "env",
            "env: read back in",
            "now",
            "now: read back in",
            "changed spaces",
            "changed: read back in",
            "nested perform ok true",
        ]
    );
    // A request handled while the library is read back in.
    lib.perform("setSpace", &json!({ "windowId": 2, "spaceId": space }));
    assert_eq!(
        seen.take(),
        [
            "env",
            "env: read back in",
            "now",
            "now: read back in",
            "changed windows",
            "changed: read back in",
            "request setSpace",
            "request: read back in",
        ]
    );
    assert_eq!(lib.live("spaces")[&space]["name"], json!("Renamed inside"), "the nested edit stored");
    assert_eq!(lib.state().spaces[0].name.as_ref(), "Renamed inside", "and the state read again after it");
    // Every action of the vectors' first cases, re-entered each time, never a borrow held.
    let groups = vectors::groups_named("recorded-library");
    let mut performed = 0;
    for case in groups.iter().flat_map(|g| &g.cases).take(10) {
        for step in &case.steps {
            if let vectors::Kind::Perform { action, payload, .. } = &step.kind {
                lib.perform(action, payload);
                performed += 1;
            }
        }
    }
    assert!(performed > 10, "{performed}");
}

// ---- the import once ----------------------------------------------------------------------------------------------

fn space(name: &str, order: f64) -> Value {
    json!({ "name": name, "emoji": "", "color": "", "order": order })
}

#[test]
fn the_import_once_over_the_data_sets() {
    // Library.swift's importChecks (T/library-tests.swift:126-174): two Safari profiles, both with a `personal` space
    // and the same tab id, browser.json's order.
    let dir = temp();
    let root = dir.path();
    let mut store = DataStore::new(root);
    let tab = |url: &str, space: &str| json!({ "url": url, "title": "", "icon": "", "spaceId": space, "order": 1, "lastUsed": 1, "selected": false });
    let put = |store: &mut DataStore, profile: &str, values: Value| {
        let set = vectors::data_set(values.as_object().unwrap());
        store.save(&DataProfile::new("safari", profile), Stored::new(set, 0.0), None).expect("saved");
    };
    put(
        &mut store,
        "s-default",
        json!({
            "spaces": { "personal": space("Personal", 0.0), "work": space("Work", 1.0) },
            "pins": { "p-1": { "spaceId": "work", "url": "https://mail.example/", "title": "Mail", "folderId": null, "pos": 0 } },
            "tabs": { "t-same": tab("https://a.example/", "personal") },
            "settings": { "s": { "theme": "arcadia" } },
        }),
    );
    put(
        &mut store,
        "s-OTHER",
        json!({ "spaces": { "personal": space("Home", 0.0) }, "tabs": { "t-same": tab("https://b.example/", "personal") } }),
    );
    // A Chrome profile's set: after Safari's (Safari first, then the browsers by name).
    let chrome =
        vectors::data_set(json!({ "spaces": { "c1": space("C", 1.0), "c2": space("D", 0.0) } }).as_object().unwrap());
    store.save(&DataProfile::new("chrome", "Default"), Stored::new(chrome, 0.0), None).expect("saved");
    let browser = root.join("safari").join("browser.json");
    std::fs::write(
        &browser,
        json!({ "format": 1, "browser": "safari", "order": [["s-default", "personal"], ["s-OTHER", "personal"], ["s-default", "work"]],
                "profiles": { "s-default": { "name": "Default", "firstSeen": 1 }, "s-OTHER": { "name": "Other", "firstSeen": 2 } }, "savedAt": 1 })
        .to_string(),
    )
    .expect("written");
    let files = |root: &std::path::Path| -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if !p.starts_with(root.join("app")) {
                    out.push((p.to_string_lossy().into_owned(), std::fs::read(&p).unwrap_or_default()));
                }
            }
        }
        out.sort();
        out
    };
    let before = files(root);
    let mut data = DataSync::new(DataStore::new(root));
    let (sets, order) = import::sources(&mut data);
    assert_eq!(
        sets.iter().map(|s| format!("{}:{}", s.browser, s.profile)).collect::<Vec<_>>(),
        ["safari:s-OTHER", "safari:s-default", "chrome:Default"],
        "Safari's first, each browser's in the data's order"
    );
    assert_eq!(
        order,
        [
            ("safari", "s-default", "personal"),
            ("safari", "s-OTHER", "personal"),
            ("safari", "s-default", "work"),
            ("chrome", "Default", "c2"),
            ("chrome", "Default", "c1"),
        ]
        .map(|(b, p, s)| (b.to_string(), p.to_string(), s.to_string()))
    );
    assert!(sets.iter().all(|s| s.values.get("settings").is_none()), "the five collections only");

    let (lib, seen, _host) = library(&root.join("app"), false);
    let counts = lib.import_once(&sets, &order).expect("runs once");
    assert_eq!(counts, Counts { spaces: 5, pins: 1, folders: 0, tabs: 2, archive: 0 });
    assert_eq!(seen.take(), ["now", "now", "changed imports,pins,spaces,tabs"]);
    assert_eq!(
        lib.take_log().iter().map(|n| n.text.clone()).collect::<Vec<_>>(),
        ["library: imported 3 profile set(s): archive 0, folders 0, pins 1, spaces 5, tabs 2"],
        "L:274's line"
    );
    let state = lib.state();
    assert_eq!(
        state.spaces.iter().map(|s| s.id.to_string()).collect::<Vec<_>>(),
        [
            "safari:s-default:personal",
            "safari:s-OTHER:personal",
            "safari:s-default:work",
            "chrome:Default:c2",
            "chrome:Default:c1"
        ],
        "the person's order"
    );
    assert_eq!(state.spaces[1].profile.as_deref(), Some("s-OTHER"));
    assert_eq!(state.kept.len(), 2, "the same tab id in two profiles: two items");
    assert_eq!(lib.live("pins")["safari:s-default:p-1"]["spaceId"], json!("safari:s-default:work"));
    assert!(lib.live("settings").is_empty());
    assert_eq!(lib.live("imports")["done"]["sets"], json!(["safari:s-OTHER", "safari:s-default", "chrome:Default"]));
    assert!(lib.is_imported());
    assert_eq!(lib.import_once(&sets, &order), None, "never twice");
    let (again, _, _) = library(&root.join("app"), false);
    assert!(again.is_imported() && again.import_once(&sets, &order).is_none(), "nor after a relaunch");
    assert_eq!(files(root), before, "the profiles' files as they were");

    // Nothing to import: the marker alone.
    let bare = temp();
    let mut none = DataSync::new(DataStore::new(bare.path()));
    let (sets, order) = import::sources(&mut none);
    assert!(sets.is_empty() && order.is_empty());
    let (lib, _, _) = library(&bare.path().join("app"), false);
    assert_eq!(lib.import_once(&sets, &order), Some(Counts::default()));
    assert!(lib.is_imported() && lib.state().spaces.is_empty());
}

// ---- cost -------------------------------------------------------------------------------------------------------------

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

/// Commit 0's baseline library through the object: a click's perform (the state kept; the store's apply and the
/// observers in it) and a snapshot after an edit (the state read and the text made again), at 50, 500 and 2,000 items.
#[test]
#[ignore]
fn object_costs() {
    struct Quiet(Cell<u32>);
    impl LibraryHost for Quiet {
        fn env(&self) -> actions::Env {
            let n = self.0.get() + 1;
            self.0.set(n);
            actions::Env { now: 5000.0 + f64::from(n), ids: (0..4).map(|i| format!("base{n}x{i}")).collect() }
        }
        fn now(&self) -> f64 {
            6000.0
        }
        fn changed(&self, _: &BTreeSet<String>) {}
    }
    for n in [50, 500, 2000] {
        let dir = temp();
        let mut store = DataStore::new(dir.path()).flat();
        let set = vectors::baseline(n);
        store.save(&crate::data::library::key(), Stored::new(set, 0.0), None).expect("saved");
        // (Opened as the app opens it: written in the background.)
        let store = DataStore::background(dir.path(), || {}).flat();
        let lib =
            Library::new(LibraryStore::new(store), Box::new(Quiet(Cell::new(0))), Box::new(AsciiCollation::new()));
        let _ = lib.state();
        let perform = median(25, |k| {
            std::hint::black_box(
                lib.perform("activateTab", &json!({ "windowId": 1, "tabId": format!("t-i{}", k % n) })),
            );
        });
        let snapshot = median(25, |k| {
            lib.perform("renameTab", &json!({ "tabId": format!("t-i{}", k % n), "title": format!("R {k}") }));
            std::hint::black_box(lib.snapshot_text());
        });
        let kept = median(25, |_| {
            std::hint::black_box(lib.snapshot_text());
        });
        eprintln!(
            "{n} items: a perform through the object {perform:.3} ms; an edit and the snapshot made again {snapshot:.3} ms; the kept snapshot {kept:.4} ms"
        );
    }
}
