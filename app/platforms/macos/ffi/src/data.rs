//! The lasting data (margin-core's `data`: the profiles' sync over a store that writes in the background, and the app's
//! library) for the Mac app's Swift (docs/CORE-REFACTOR.md step 1.2-1.3). Two objects, each with one JSON call: the
//! data (`margin_data_*`) and the library (`margin_library_*`). Their stores write on a thread of their own and wake the
//! Swift side after each save (a C callback on that thread: it hops to the main thread and asks `written`). The
//! choice for a profile with no set is the Swift side's (Safari's profile folders), asked by a C callback with
//! everything it needs in the question; its answer is JSON it allocated with `malloc`, freed here with `free`.
//! Nothing here panics on what it's given: a bad request is `{"error": …}`.

use margin_core::data::Note;
use margin_core::data::library::LibraryStore;
use margin_core::data::set::DataChange;
use margin_core::data::store::{DataProfile, DataStore};
use margin_core::data::sync::{DataSync, Effects, Link, NeedChoice};
use serde_json::{Map, Value, json};
use std::ffi::c_void;

unsafe extern "C" {
    fn free(ptr: *mut c_void);
}

/// The writer's wake (on its own thread).
pub type MarginDataWake = extern "C" fn(ctx: *mut c_void);
/// The choice for a profile with no set: the question as JSON (`{ browser, profile, withSets }`), the answer JSON
/// (`{ choice: "ask" | "hold" | "carry", from?, why? }`) allocated with `malloc` (or null: ask).
pub type MarginDataNeed =
    extern "C" fn(ctx: *mut c_void, question: *const u8, len: usize, out_len: *mut usize) -> *mut u8;

/// The Swift side's object, as the callbacks get it (it lives as long as the data object: the caller's contract).
#[derive(Clone, Copy)]
struct Ctx(*mut c_void);
// SAFETY: only passed back to the Swift side's callbacks, which hop to its main thread themselves.
unsafe impl Send for Ctx {}
unsafe impl Sync for Ctx {}

impl Ctx {
    /// The pointer (a method, so a closure takes the whole `Ctx`, which is `Send`, not its field).
    fn ptr(self) -> *mut c_void {
        self.0
    }
}

pub struct MarginData {
    sync: DataSync,
}

pub struct MarginLibrary {
    library: LibraryStore,
}

pub(crate) fn answer(value: &Value, out_len: *mut usize) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    let boxed = value.to_string().into_bytes().into_boxed_slice();
    // SAFETY: out_len is writable (checked non-null; the caller's contract).
    unsafe { *out_len = boxed.len() };
    Box::into_raw(boxed) as *mut u8
}

pub(crate) fn text<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    // SAFETY: the caller passes `len` readable bytes at `ptr`.
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).ok()
}

fn s<'a>(o: &'a Map<String, Value>, k: &str) -> &'a str {
    o.get(k).and_then(Value::as_str).unwrap_or("")
}

fn profile_of(o: &Map<String, Value>, browser: &str, profile: &str) -> DataProfile {
    DataProfile::new(s(o, browser), s(o, profile))
}

fn profile_json(p: &DataProfile) -> Value {
    json!({ "browser": p.browser, "profile": p.profile })
}

pub(crate) fn log_json(log: &[Note]) -> Value {
    Value::Array(log.iter().map(|n| json!({ "warn": n.warn, "text": n.text })).collect())
}

fn effects_json(fx: &Effects) -> Value {
    json!({
        "send": fx.send.iter().map(|o| json!({ "browser": o.to.browser, "profile": o.to.profile, "epoch": o.epoch, "message": o.message })).collect::<Vec<_>>(),
        "changed": fx.changed.iter().map(|(p, c)| json!({ "browser": p.browser, "profile": p.profile, "collections": c })).collect::<Vec<_>>(),
        "firstSet": fx.first_set.iter().map(profile_json).collect::<Vec<_>>(),
        "carried": fx.carried.iter().map(|(a, b, why)| json!({ "browser": b.browser, "old": a.profile, "new": b.profile, "why": why })).collect::<Vec<_>>(),
        "log": log_json(&fx.log),
    })
}

/// A name as the store writes it on disk (`DataStore::file_name`: a–z, 0–9, `_`, `-` as they are, the rest `%XX`).
#[unsafe(no_mangle)]
pub extern "C" fn margin_data_file_name(name: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    answer(&Value::String(DataStore::file_name(text(name, len).unwrap_or(""))), out_len)
}

/// The data object over the store at `root` (UTF-8 path). `background`: its writer a thread of its own, which calls
/// `wake` after each save (false: written at once, the tests). `need`: the choice for a profile with no set (null:
/// always ask).
///
/// # Safety
/// `root` points to `len` readable bytes; `ctx` lives as long as the object.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_data_new(
    root: *const u8,
    len: usize,
    background: bool,
    ctx: *mut c_void,
    wake: Option<MarginDataWake>,
    need: Option<MarginDataNeed>,
) -> *mut MarginData {
    let Some(root) = text(root, len) else { return std::ptr::null_mut() };
    let ctx = Ctx(ctx);
    let store = match (background, wake) {
        (true, Some(wake)) => DataStore::background(root, move || wake(ctx.ptr())),
        _ => DataStore::new(root),
    };
    let mut sync = DataSync::new(store);
    if let Some(need) = need {
        sync.before_need = Some(Box::new(move |p, with_sets| {
            let question = json!({ "browser": p.browser, "profile": p.profile, "withSets": with_sets }).to_string();
            let mut out_len = 0usize;
            let out = need(ctx.ptr(), question.as_ptr(), question.len(), &mut out_len);
            if out.is_null() {
                return NeedChoice::Ask;
            }
            // SAFETY: the callback's contract: `out_len` bytes it allocated with malloc.
            let parsed: Option<Value> =
                serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, out_len) }).ok();
            // SAFETY: allocated with malloc by the callback, freed once.
            unsafe { free(out as *mut c_void) };
            let Some(o) = parsed.as_ref().and_then(Value::as_object) else { return NeedChoice::Ask };
            match s(o, "choice") {
                "hold" => NeedChoice::Hold,
                "carry" if !s(o, "from").is_empty() => NeedChoice::Carry {
                    from: DataProfile::new(p.browser.as_str(), s(o, "from")),
                    why: s(o, "why").to_string(),
                },
                _ => NeedChoice::Ask,
            }
        }));
    }
    Box::into_raw(Box::new(MarginData { sync }))
}

/// # Safety
/// `data` from [`margin_data_new`], not freed yet (every save handed over is written first).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_data_free(data: *mut MarginData) {
    if !data.is_null() {
        // SAFETY: made by Box::into_raw in margin_data_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(data) });
    }
}

/// One request (`{ type, … }`) → its answer. Effects (`{ send, changed, firstSet, carried, log }`) for: `linkUp`,
/// `linkDown`, `received` (browser, profile, epoch; `message` with its `k`), `change` (browser, profile, `changes`;
/// `{ noSet: true }` without a set), `written`, `tick`, `release` (browser, profile, why), `carry` (browser, old,
/// new, why; `{ refused: true }` when it can't). Reads: `profiles` (browser?), `set` (browser, profile: `{ set,
/// acked, rev }` or `{ set: null }`), `values` (collection, browser, profile), `holding`, `nextHold`, `linked`,
/// `unsent`, `root`. Tests: `configure` (`holdFor`, `partBytes`, `now`: a fixed ms clock).
///
/// # Safety
/// `data` from [`margin_data_new`], not freed; `request` points to `len` readable bytes; one call at a time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_data_call(
    data: *mut MarginData,
    request: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_data_new and not freed (the caller's contract); one call at a time (its thread).
    let Some(d) = (!data.is_null()).then(|| unsafe { &mut *data }) else {
        return answer(&json!({ "error": "no data object" }), out_len);
    };
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    let sync = &mut d.sync;
    let link = || Link::new(s(o, "browser"), s(o, "profile"), s(o, "epoch"));
    let out = match s(o, "type") {
        "linkUp" => {
            sync.link_up(&link());
            effects_json(&Effects::default())
        }
        "linkDown" => {
            sync.link_down(&link());
            effects_json(&Effects::default())
        }
        "received" => effects_json(&sync.received(&link(), o.get("message").unwrap_or(&Value::Null))),
        "change" => {
            let p = profile_of(o, "browser", "profile");
            match sync.change(&p, &DataChange::list(o.get("changes"))) {
                Some(fx) => effects_json(&fx),
                None => json!({ "noSet": true }),
            }
        }
        "written" => effects_json(&sync.written()),
        "tick" => effects_json(&sync.tick()),
        "release" => effects_json(&sync.release(&profile_of(o, "browser", "profile"), s(o, "why"))),
        "carry" => {
            let (old, new) = (profile_of(o, "browser", "old"), profile_of(o, "browser", "new"));
            match sync.carry(&old, &new, s(o, "why")) {
                Some(fx) => effects_json(&fx),
                None => json!({ "refused": true }),
            }
        }
        "profiles" => {
            let browser = o.get("browser").and_then(Value::as_str);
            json!({ "profiles": sync.profiles(browser).iter().map(profile_json).collect::<Vec<_>>() })
        }
        "set" => {
            let p = profile_of(o, "browser", "profile");
            match sync.store_mut().load(&p) {
                Some(stored) => json!({ "set": stored.set.items_json(), "acked": stored.acked, "rev": stored.rev }),
                None => json!({ "set": null }),
            }
        }
        "values" => {
            let p = profile_of(o, "browser", "profile");
            json!({ "values": sync.values(s(o, "collection"), &p) })
        }
        "holding" => json!({ "holding": sync.holding().iter().map(profile_json).collect::<Vec<_>>() }),
        "nextHold" => json!({ "at": sync.next_hold_deadline() }),
        "linked" => json!({ "linked": sync.is_linked(&profile_of(o, "browser", "profile")) }),
        "unsent" => json!({ "unsent": sync.unsent() }),
        "root" => json!({ "root": sync.store().root().to_string_lossy() }),
        "configure" => {
            if let Some(h) = o.get("holdFor").and_then(Value::as_f64) {
                sync.hold_for = h;
            }
            if let Some(b) = o.get("partBytes").and_then(Value::as_u64) {
                sync.part_bytes = usize::try_from(b).unwrap_or(sync.part_bytes);
            }
            if let Some(now) = o.get("now").and_then(Value::as_f64) {
                sync.now = Box::new(move || now);
                sync.store_mut().now = Box::new(move || now);
            }
            json!({})
        }
        other => json!({ "error": format!("bad request: {other:?} isn't one") }),
    };
    answer(&out, out_len)
}

/// The library over the flat store at `root` (UTF-8 path); `background` and `wake` as [`margin_data_new`]'s.
///
/// # Safety
/// `root` points to `len` readable bytes; `ctx` lives as long as the object.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_library_new(
    root: *const u8,
    len: usize,
    background: bool,
    ctx: *mut c_void,
    wake: Option<MarginDataWake>,
) -> *mut MarginLibrary {
    let Some(root) = text(root, len) else { return std::ptr::null_mut() };
    let ctx = Ctx(ctx);
    let store = match (background, wake) {
        (true, Some(wake)) => DataStore::background(root, move || wake(ctx.ptr())),
        _ => DataStore::new(root),
    };
    Box::into_raw(Box::new(MarginLibrary { library: LibraryStore::new(store.flat()) }))
}

/// # Safety
/// `library` from [`margin_library_new`], not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_library_free(library: *mut MarginLibrary) {
    if !library.is_null() {
        // SAFETY: made by Box::into_raw in margin_library_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(library) });
    }
}

/// One request → its answer: `values` (`{ values: { collection: { id: value } }, log }`), `apply` (`entries`, `at`
/// ms: `{ changed, values, log }`), `written` (`{ log }`), `rev` (`{ rev }`, the set's, or null).
///
/// # Safety
/// `library` from [`margin_library_new`], not freed; `request` points to `len` readable bytes; one call at a time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_library_call(
    library: *mut MarginLibrary,
    request: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_library_new and not freed (the caller's contract); one call at a time (its thread).
    let Some(l) = (!library.is_null()).then(|| unsafe { &mut *library }) else {
        return answer(&json!({ "error": "no library" }), out_len);
    };
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    let lib = &mut l.library;
    let out = match s(o, "type") {
        "values" => {
            let values = lib.values();
            json!({ "values": values, "log": log_json(&lib.take_log()) })
        }
        "apply" => {
            let entries = o.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
            let at = o.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            let a = lib.apply(&entries, at);
            json!({ "changed": a.changed, "values": a.values, "log": log_json(&lib.take_log()) })
        }
        "written" => json!({ "log": log_json(&lib.written()) }),
        "rev" => json!({ "rev": lib.store_mut().load(&margin_core::data::library::key()).map(|s| s.rev.clone()) }),
        other => json!({ "error": format!("bad request: {other:?} isn't one") }),
    };
    answer(&out, out_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(d: *mut MarginData, req: Value) -> Value {
        let t = req.to_string();
        let mut len = 0;
        // SAFETY: d from margin_data_new, the request's bytes.
        let out = unsafe { margin_data_call(d, t.as_ptr(), t.len(), &mut len) };
        // SAFETY: a buffer margin_data_call made, `len` bytes.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: margin_buffer_free's contract.
        unsafe { crate::margin_buffer_free(out, len) };
        v
    }

    fn lib_call(l: *mut MarginLibrary, req: Value) -> Value {
        let t = req.to_string();
        let mut len = 0;
        // SAFETY: l from margin_library_new, the request's bytes.
        let out = unsafe { margin_library_call(l, t.as_ptr(), t.len(), &mut len) };
        // SAFETY: as above.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: as above.
        unsafe { crate::margin_buffer_free(out, len) };
        v
    }

    extern "C" fn carry_from_old(_: *mut c_void, q: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
        // SAFETY: the question's bytes, as the data object passes them.
        let question: Value =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(q, len) }).unwrap_or(Value::Null);
        let has_old = question["withSets"].as_array().is_some_and(|l| l.contains(&json!("OLD")));
        let a = if has_old { r#"{"choice":"carry","from":"OLD","why":"a test"}"# } else { r#"{"choice":"ask"}"# };
        // SAFETY: malloc'd here, freed by the data object with free.
        unsafe {
            let p = libc_malloc(a.len()) as *mut u8;
            std::ptr::copy_nonoverlapping(a.as_ptr(), p, a.len());
            *out_len = a.len();
            p
        }
    }
    unsafe extern "C" {
        #[link_name = "malloc"]
        fn libc_malloc(n: usize) -> *mut c_void;
    }

    #[test]
    fn the_data_through_the_ffi() {
        let dir = tempfile::tempdir().expect("a folder");
        let root = dir.path().to_string_lossy().to_string();
        // SAFETY: the root's bytes; no ctx needed by these callbacks.
        let d = unsafe {
            margin_data_new(root.as_ptr(), root.len(), false, std::ptr::null_mut(), None, Some(carry_from_old))
        };
        assert_eq!(call(d, json!({ "type": "configure", "now": 1000 })), json!({}));
        assert_eq!(
            call(d, json!({ "type": "linkUp", "browser": "safari", "profile": "P1", "epoch": "e1" }))["send"],
            json!([])
        );
        let need = call(
            d,
            json!({ "type": "received", "browser": "safari", "profile": "P1", "epoch": "e1",
            "message": { "k": "data.hello", "format": 1, "acked": 0, "queue": [] } }),
        );
        assert_eq!(need["send"][0]["message"]["k"], json!("data.need"), "no set, no old one: asked");
        let snap = call(
            d,
            json!({ "type": "received", "browser": "safari", "profile": "P1", "epoch": "e1",
            "message": { "k": "data.snapshot", "format": 1, "set": { "format": 1, "items": { "spaces": {
                "s1": { "updatedAt": 5, "value": { "name": "Home" } } } } }, "transfer": "t", "part": 0, "parts": 1 } }),
        );
        assert!(
            snap["send"]
                .as_array()
                .is_some_and(|l| l.iter().any(|m| m["message"]["k"] == json!("data.ack") && m["epoch"] == json!("e1")))
        );
        assert_eq!(snap["firstSet"], json!([{ "browser": "safari", "profile": "P1" }]));
        assert_eq!(
            call(d, json!({ "type": "values", "collection": "spaces", "browser": "safari", "profile": "P1" }))["values"]
                ["s1"]["name"],
            json!("Home")
        );
        assert_eq!(
            call(d, json!({ "type": "profiles", "browser": "safari" }))["profiles"],
            json!([{ "browser": "safari", "profile": "P1" }])
        );
        assert!(call(d, json!({ "type": "set", "browser": "safari", "profile": "P1" }))["rev"].as_str().is_some());
        assert_eq!(call(d, json!({ "type": "set", "browser": "safari", "profile": "NONE" }))["set"], Value::Null);
        assert_eq!(
            call(d, json!({ "type": "change", "browser": "safari", "profile": "NONE", "changes": [] })),
            json!({ "noSet": true })
        );
        assert!(call(d, json!({ "type": "nonsense" }))["error"].is_string());
        // SAFETY: from margin_data_new, freed once.
        unsafe { margin_data_free(d) };

        // The library: entries applied, values back, read again by a new object.
        let lroot = dir.path().join("app").to_string_lossy().to_string();
        // SAFETY: as above.
        let l = unsafe { margin_library_new(lroot.as_ptr(), lroot.len(), false, std::ptr::null_mut(), None) };
        let a = lib_call(
            l,
            json!({ "type": "apply", "at": 50, "entries": [{ "collection": "tabs", "id": "t1", "value": { "url": "https://a" } }] }),
        );
        assert_eq!(a["changed"], json!(["tabs"]));
        assert_eq!(a["values"]["tabs"]["t1"]["url"], json!("https://a"));
        // SAFETY: from margin_library_new, freed once.
        unsafe { margin_library_free(l) };
        // SAFETY: as above.
        let l2 = unsafe { margin_library_new(lroot.as_ptr(), lroot.len(), true, std::ptr::null_mut(), None) };
        assert_eq!(lib_call(l2, json!({ "type": "values" }))["values"]["tabs"]["t1"]["url"], json!("https://a"));
        // SAFETY: as above.
        unsafe { margin_library_free(l2) };
    }
}
