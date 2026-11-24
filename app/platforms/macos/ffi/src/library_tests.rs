// The library object through the FFI (data.rs `margin_library_*`, step 4 part 7) with the Mac's sorter: every kind of
// the shared vectors through library.js's entry with libicucore's collation (the Mac's vectors pin the system one,
// Tirth's answer after commit 1), the FFI entry the Swift tests' shadow calls, and the object with Swift's callbacks,
// each of which calls back in (the library's reads, the rules' entry, and the session reading the library in place
// while the library's perform is under way: session.rs `LibraryRef`).

use std::cell::RefCell;
use std::ffi::c_void;

use margin_core::library::vectors;
use serde_json::{Value, json};

use super::*;
use crate::collation::SystemCollation;

fn read(out: *mut u8, len: usize) -> Value {
    if out.is_null() {
        return Value::Null;
    }
    // SAFETY: a buffer a library call made, `len` bytes.
    let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
    // SAFETY: margin_buffer_free's contract.
    unsafe { crate::margin_buffer_free(out, len) };
    v
}

fn lib_call(l: *const MarginLibrary, req: Value) -> Value {
    let t = req.to_string();
    let mut len = 0;
    // SAFETY: l from margin_library_new, the request's bytes.
    read(unsafe { margin_library_call(l, t.as_ptr(), t.len(), &mut len) }, len)
}

fn rules(l: *const MarginLibrary, name: &str, args: &Value) -> Value {
    let a = args.to_string();
    let mut len = 0;
    // SAFETY: l null or live; the name's and the arguments' bytes.
    read(unsafe { margin_library_rules(l, name.as_ptr(), name.len(), a.as_ptr(), a.len(), &mut len) }, len)
}

#[test]
fn every_vector_through_the_entry_with_the_macs_sorter() {
    // (en-US: the locale JSC resolved when the vectors were recorded, js.json's `locale`.)
    let (checked, gap) = vectors::run_entry(&SystemCollation::new("en-US"));
    eprintln!("the vectors through libicucore's collation: checked {checked:?}, {gap} skipped (the gap)");
}

#[test]
fn the_ffi_entry_is_library_js() {
    assert_eq!(rules(std::ptr::null(), "nope", &json!([])), json!({ "error": "no function nope" }));
    assert_eq!(rules(std::ptr::null(), "actions", &json!([]))["value"].as_array().map(Vec::len), Some(57));
    // Ties by the person's sorter (en-US here): `a` < `A` < `b`, `_` before `-`.
    let values =
        json!({ "spaces": { "b": { "name": "B" }, "A": { "name": "A" }, "a": { "name": "a" }, "x_1": {}, "x-1": {} } });
    let snap = rules(std::ptr::null(), "snapshot", &json!([values]));
    let ids: Vec<&str> =
        snap["value"]["spaces"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    if crate::collation::preferred_language().starts_with("en") {
        assert_eq!(ids, ["a", "A", "b", "x_1", "x-1"]);
    }
    let made =
        rules(std::ptr::null(), "perform", &json!([{}, "createSpace", { "name": "A" }, { "now": 1, "ids": ["abcd"] }]));
    assert_eq!(made["value"]["result"], json!({ "spaceId": "sp-abcd" }));
    // (Bad text: answered, never a crash.)
    let mut n = 0;
    // SAFETY: null pointers are allowed.
    let out =
        read(unsafe { margin_library_rules(std::ptr::null(), std::ptr::null(), 0, std::ptr::null(), 0, &mut n) }, n);
    assert_eq!(out, json!({ "error": "no function " }));
}

#[test]
fn the_ffi_entry_parses_addresses_and_answers_as_jsc_without() {
    // Tirth's answer 11: a link rule routes and `https://a.com` is `https://a.com/`; the shadow's entry answers as
    // JavaScriptCore, with no URL, did.
    let without = |name: &str, args: &Value| {
        let a = args.to_string();
        let mut len = 0;
        // SAFETY: null library; the name's and the arguments' bytes.
        read(
            unsafe {
                margin_library_rules_without_urls(
                    std::ptr::null(),
                    name.as_ptr(),
                    name.len(),
                    a.as_ptr(),
                    a.len(),
                    &mut len,
                )
            },
            len,
        )
    };
    let values = json!({
        "spaces": { "a": { "name": "A", "order": 0 } },
        "airTraffic": { "atc-1": { "pattern": "github.com", "spaceId": "a", "order": 0 } },
        "favorites": { "fav-1": { "scope": "global", "url": "https://a.com/", "title": "A", "pos": 0 } },
    });
    let route = json!([values, "routeUrl", { "url": "https://GitHub.com/x#y" }, { "now": 1, "ids": ["abcd"] }]);
    assert_eq!(rules(std::ptr::null(), "perform", &route)["value"]["result"]["ruleId"], json!("atc-1"));
    assert_eq!(without("perform", &route)["value"]["result"], Value::Null);
    let fav = json!([values, "addFavorite", { "url": "https://a.com" }, { "now": 1, "ids": ["abcd"] }]);
    assert_eq!(rules(std::ptr::null(), "perform", &fav)["value"]["changes"], json!([]), "its scope has it");
    assert_eq!(without("perform", &fav)["value"]["result"], json!("fav-abcd"), "JSC's: another address");
    assert_eq!(
        rules(std::ptr::null(), "perform", &route)["value"]["result"]["ruleId"],
        json!("atc-1"),
        "parsing again after it"
    );
}

/// The Swift side as the callbacks see it: its clock and ids, the observers' calls, and the session over the library.
#[derive(Default)]
struct Swift {
    library: RefCell<*const MarginLibrary>,
    session: RefCell<*const crate::MarginSession>,
    seen: RefCell<Vec<String>>,
    next: RefCell<u32>,
}

fn swift<'a>(ctx: *mut c_void) -> &'a Swift {
    // SAFETY: ctx is the test's Swift, alive for the test.
    unsafe { &*(ctx as *const Swift) }
}

/// Back in, during a callback: the library's reads and its rules, and the session reading the library in place.
fn back_in(s: &Swift, at: &str) {
    let l = *s.library.borrow();
    if l.is_null() {
        return;
    }
    let snap = lib_call(l, json!({ "type": "snapshot" }));
    let spaces = snap["snapshot"]["spaces"].as_array().map_or(0, Vec::len);
    lib_call(l, json!({ "type": "item", "collection": "tabs", "id": "t-x" }));
    rules(l, "actions", &json!([]));
    let session = *s.session.borrow();
    let item = b"t-x";
    // SAFETY: the live session; the item's bytes.
    let _ = unsafe { crate::margin_session_pinned(session, item.as_ptr(), item.len()) };
    s.seen.borrow_mut().push(format!("{at}: back in ({spaces} spaces)"));
}

extern "C" fn env(ctx: *mut c_void, out: *mut MarginLibraryEnvOut) -> f64 {
    let s = swift(ctx);
    s.seen.borrow_mut().push("env".into());
    back_in(s, "env");
    let n = {
        let mut next = s.next.borrow_mut();
        *next += 1;
        *next
    };
    for i in 0..4 {
        let id = format!("ffi{n}x{i}");
        // SAFETY: the callback's `out`, during its call; the id's bytes.
        unsafe { margin_library_env_id(out, id.as_ptr(), id.len()) };
    }
    1000.0 + f64::from(n)
}

extern "C" fn now(ctx: *mut c_void) -> f64 {
    let s = swift(ctx);
    s.seen.borrow_mut().push("now".into());
    back_in(s, "now");
    5000.0
}

extern "C" fn changed(ctx: *mut c_void, names: *const u8, len: usize) {
    let s = swift(ctx);
    // SAFETY: the names' bytes, as passed.
    let names = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(names, len) }).into_owned();
    s.seen.borrow_mut().push(format!("changed {names}"));
    back_in(s, "changed");
}

#[test]
fn the_library_object_through_the_ffi_called_back_into() {
    let dir = tempfile::tempdir().expect("a folder");
    let root = dir.path().join("app").to_string_lossy().to_string();
    let world = Box::new(Swift::default());
    let ctx = &*world as *const Swift as *mut c_void;
    // SAFETY: the root's bytes; the test's Swift as ctx (alive for the test).
    let l =
        unsafe { margin_library_new(root.as_ptr(), root.len(), false, ctx, None, Some(env), Some(now), Some(changed)) };
    let options = br#"{"every":0.05}"#;
    // SAFETY: the library; the options' bytes; no ports (the reads here call none).
    let session = unsafe {
        crate::margin_session_new(l, options.as_ptr(), options.len(), std::ptr::null_mut(), None, None, None)
    };
    *world.library.borrow_mut() = l;
    *world.session.borrow_mut() = session;

    let made = lib_call(
        l,
        json!({ "type": "perform", "action": "createSpace", "payload": { "windowId": 1, "name": "Work" } }),
    );
    assert_eq!(made["ok"], json!(true), "{made}");
    assert_eq!(made["result"], json!({ "spaceId": "sp-ffi1x0" }), "the env's ids");
    assert_eq!(made["changed"], json!(["spaces", "windows"]));
    assert_eq!(made["log"], json!([]));
    assert_eq!(
        *world.seen.borrow(),
        [
            "env",
            "env: back in (0 spaces)",
            "now",
            "now: back in (0 spaces)",
            "changed [\"spaces\",\"windows\"]",
            "changed: back in (1 spaces)",
        ],
        "the env, the store's time, the observers: each calling back in, the snapshot read again after the store"
    );
    let space = "sp-ffi1x0";
    let added = lib_call(
        l,
        json!({ "type": "perform", "action": "addItem", "payload": { "windowId": 1, "spaceId": space, "url": "https://a.example/" } }),
    );
    let item = added["result"]["tabId"].as_str().expect("an item").to_owned();
    let shown =
        lib_call(l, json!({ "type": "perform", "action": "activateTab", "payload": { "windowId": 1, "tabId": item } }));
    assert_eq!(shown["requests"][0]["type"], json!("activateTab"), "{shown}");
    assert_eq!(
        lib_call(l, json!({ "type": "item", "collection": "tabs", "id": item }))["value"]["url"],
        json!("https://a.example/")
    );
    assert_eq!(lib_call(l, json!({ "type": "requests" }))["requests"].as_array().map(Vec::len), Some(1));
    let value = lib_call(l, json!({ "type": "item", "collection": "tabs", "id": item }))["value"].clone();
    assert_eq!(value["lastUsed"], json!(1003), "the activateTab env's time: {value}");
    let snap = lib_call(l, json!({ "type": "snapshot" }))["snapshot"].clone();
    assert_eq!(snap["keptTabs"], Value::Null);
    assert_eq!(snap["openTabs"]["keptTabs"][&item]["url"], json!("https://a.example/"));
    assert_eq!(snap["library"], json!({ "v": 1, "imported": false }));
    assert_eq!(lib_call(l, json!({ "type": "actions" }))["actions"].as_array().map(Vec::len), Some(57));
    let refused = lib_call(l, json!({ "type": "perform", "action": "renameSpace", "payload": { "spaceId": "none" } }));
    assert_eq!((refused["ok"].clone(), refused["error"].clone()), (json!(false), json!("no such space")));
    // The stored rev and the values as before (Library.swift's reads until the switch).
    assert!(lib_call(l, json!({ "type": "rev" }))["rev"].as_str().is_some());
    assert_eq!(lib_call(l, json!({ "type": "values" }))["values"]["spaces"][space]["name"], json!("Work"));
    assert!(lib_call(l, json!({ "type": "nonsense" }))["error"].is_string());

    // The import once, over a data object with a profile's set: its line in the answer's log; never twice.
    let data_root = dir.path().to_string_lossy().to_string();
    // SAFETY: the root's bytes; no callbacks.
    let d =
        unsafe { crate::margin_data_new(data_root.as_ptr(), data_root.len(), false, std::ptr::null_mut(), None, None) };
    {
        let mut store = margin_core::data::store::DataStore::new(dir.path());
        let set =
            vectors::data_set(json!({ "spaces": { "home": { "name": "Home", "order": 0 } } }).as_object().unwrap());
        let p = margin_core::data::store::DataProfile::new("safari", "s-default");
        store.save(&p, margin_core::data::store::Stored::new(set, 0.0), None).expect("saved");
    }
    let mut n = 0;
    // SAFETY: the live library and data objects.
    let imported = read(unsafe { margin_library_import(l, d, &mut n) }, n);
    assert_eq!(imported["imported"], json!(true), "{imported}");
    assert_eq!(imported["counts"]["spaces"], json!(1));
    assert_eq!(
        imported["log"][0]["text"],
        json!("library: imported 1 profile set(s): archive 0, folders 0, pins 0, spaces 1, tabs 0")
    );
    assert_eq!(lib_call(l, json!({ "type": "imported" }))["imported"], json!(true));
    // SAFETY: as above.
    let again = read(unsafe { margin_library_import(l, d, &mut n) }, n);
    assert_eq!(again["imported"], json!(false));
    // SAFETY: null pointers are allowed.
    assert!(read(unsafe { margin_library_import(std::ptr::null(), d, &mut n) }, n)["error"].is_string());

    // SAFETY: from their news, freed once, the session first.
    unsafe {
        crate::margin_session_free(session);
        crate::margin_data_free(d);
        margin_library_free(l);
    }
    // (Null: answers, no harm.)
    assert!(lib_call(std::ptr::null(), json!({ "type": "values" }))["error"].is_string());
}

#[test]
fn without_callbacks_library_swifts_defaults() {
    let dir = tempfile::tempdir().expect("a folder");
    let root = dir.path().to_string_lossy().to_string();
    // SAFETY: the root's bytes; no ctx needed.
    let l =
        unsafe { margin_library_new(root.as_ptr(), root.len(), false, std::ptr::null_mut(), None, None, None, None) };
    let made = lib_call(l, json!({ "type": "perform", "action": "createSpace", "payload": { "name": "A" } }));
    let id = made["result"]["spaceId"].as_str().expect("an id");
    assert!(id.len() == 13 && id.starts_with("sp-"), "{id}: 10 random letters");
    let at = margin_core::data::store::DataStore::new(dir.path())
        .flat()
        .load(&margin_core::data::library::key())
        .and_then(|s| s.set.item("spaces", id).map(|i| i.updated_at))
        .expect("stored");
    assert!(at > 1.7e12, "stored at the wall clock's ms: {at}");
    // SAFETY: from margin_library_new, freed once.
    unsafe { margin_library_free(l) };
}
