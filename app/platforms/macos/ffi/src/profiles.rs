//! A browser's profiles (margin-core's `data::profiles`, the hosted file's shape) for the Mac app's Swift
//! (docs/CORE-REFACTOR.md step 1.4): one object per browser (`margin_profiles_*`) with one JSON call, and the slots
//! rule on its own (`margin_profiles_resolve`, the library's import). The Swift side passes in what it read (Safari's
//! profiles, from SafariProfiles.swift) and `now`; nothing here calls back into it. Every answer carries the log lines
//! the call made (`log`: `[{ warn, text }]`). Nothing here panics on what it's given: a bad request is
//! `{"error": …}`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use margin_core::data::profiles::{BrowserProfiles, ReadProfile, SpaceKey};
use serde_json::{Map, Value, json};

use crate::data::{answer, log_json, text};

pub struct MarginProfiles {
    profiles: BrowserProfiles,
}

fn s<'a>(o: &'a Map<String, Value>, k: &str) -> &'a str {
    o.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `[id, …]` (anything that isn't a string left out).
fn ids(v: Option<&Value>) -> HashSet<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect()
}

/// `{ profile: [space, …] }`.
fn spaces(v: Option<&Value>) -> HashMap<String, Vec<String>> {
    let Some(o) = v.and_then(Value::as_object) else { return HashMap::new() };
    o.iter()
        .map(|(p, list)| {
            let own = list.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect();
            (p.clone(), own)
        })
        .collect()
}

/// `[[profile, space], …]` (an entry that isn't one left out).
fn keys(v: Option<&Value>) -> Vec<SpaceKey> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| match e.as_array()?.as_slice() {
            [p, s] => Some(SpaceKey::new(p.as_str()?, s.as_str()?)),
            _ => None,
        })
        .collect()
}

fn keys_json(keys: &[SpaceKey]) -> Value {
    Value::Array(keys.iter().map(|k| json!([k.profile, k.space])).collect())
}

/// A browser's profiles over its file in `root` (UTF-8 paths; a null `root`: in memory, the tests). Null: a null or
/// bad browser.
///
/// # Safety
/// `browser` points to `browser_len` readable bytes, `root` (unless null) to `root_len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_profiles_new(
    browser: *const u8,
    browser_len: usize,
    root: *const u8,
    root_len: usize,
) -> *mut MarginProfiles {
    let Some(browser) = text(browser, browser_len) else { return std::ptr::null_mut() };
    let root = text(root, root_len).map(Path::new);
    Box::into_raw(Box::new(MarginProfiles { profiles: BrowserProfiles::new(browser, root) }))
}

/// # Safety
/// `profiles` from [`margin_profiles_new`], not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_profiles_free(profiles: *mut MarginProfiles) {
    if !profiles.is_null() {
        // SAFETY: made by Box::into_raw in margin_profiles_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(profiles) });
    }
}

/// One request (`{ type, now?, … }`; `now`: ms, the clock for this call and after) → its answer, with `log`.
/// Changes: `refresh` (spaces `{ profile: [space] }`, linked: `{ changed }`), `useBrowserNames` (list
/// `[{ serverId, name, margin? }]`: `{ changed }`), `dropBrowserNames` (`{ changed }`), `checkMapped` (linked:
/// `{ said }`), `carry` (old, new), `forget` (profile: `{ forgotten }`), `save`. Reads: `carrySource` (new, withSets,
/// linked: `{ old, browserId }` or `{ old: null }`), `mightCarry` (new, withSets, linked: `{ might }`), `name`
/// (profile), `defaultName` (profile), `profiles`, `stored` (`[[profile, space]]`), `info` (`{ id: info }` as the
/// file has it), `browserNames` (`{ id: name }`), `browserRead` (`{ read: [..] | null }`), `saves`.
///
/// # Safety
/// `profiles` from [`margin_profiles_new`], not freed; `request` points to `len` readable bytes; one call at a time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_profiles_call(
    profiles: *mut MarginProfiles,
    request: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_profiles_new and not freed (the caller's contract); one call at a time (its thread).
    let Some(p) = (!profiles.is_null()).then(|| unsafe { &mut *profiles }) else {
        return answer(&json!({ "error": "no profiles object" }), out_len);
    };
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    let bp = &mut p.profiles;
    if let Some(now) = o.get("now").and_then(Value::as_f64).filter(|n| n.is_finite()) {
        bp.now = Box::new(move || now);
    }
    let mut out = match s(o, "type") {
        "refresh" => json!({ "changed": bp.refresh(&spaces(o.get("spaces")), &ids(o.get("linked"))) }),
        "useBrowserNames" => {
            let list = o.get("list").and_then(Value::as_array).into_iter().flatten();
            let list: Vec<ReadProfile> = list.filter_map(Value::as_object).map(ReadProfile::from_json).collect();
            json!({ "changed": bp.use_browser_names(list) })
        }
        "dropBrowserNames" => json!({ "changed": bp.drop_browser_names() }),
        "checkMapped" => json!({ "said": bp.check_mapped(&ids(o.get("linked"))) }),
        "carry" => {
            bp.carry(s(o, "old"), s(o, "new"));
            json!({})
        }
        "forget" => json!({ "forgotten": bp.forget(s(o, "profile")) }),
        "save" => {
            bp.save();
            json!({})
        }
        "carrySource" => match bp.carry_source(s(o, "new"), &ids(o.get("withSets")), &ids(o.get("linked"))) {
            Some((old, browser_id)) => json!({ "old": old, "browserId": browser_id }),
            None => json!({ "old": null }),
        },
        "mightCarry" => json!({ "might": bp.might_carry(s(o, "new"), &ids(o.get("withSets")), &ids(o.get("linked"))) }),
        "name" => json!({ "name": bp.name(s(o, "profile")) }),
        "defaultName" => json!({ "name": bp.default_name(s(o, "profile")) }),
        "profiles" => json!({ "profiles": bp.profiles() }),
        "stored" => json!({ "stored": keys_json(bp.stored()) }),
        "info" => {
            let overlay = bp.is_overlay();
            let info: Map<String, Value> = bp.infos().iter().map(|(id, i)| (id.clone(), i.to_json(overlay))).collect();
            json!({ "info": info })
        }
        "browserNames" => {
            let names: Map<String, Value> =
                bp.browser_names().iter().map(|(id, n)| (id.clone(), Value::from(n.name.as_str()))).collect();
            json!({ "names": names })
        }
        "browserRead" => {
            json!({ "read": bp.browser_read().map(|l| l.iter().map(ReadProfile::to_json).collect::<Vec<_>>()) })
        }
        "saves" => json!({ "saves": bp.saves() }),
        other => json!({ "error": format!("bad request: {other:?} isn't one") }),
    };
    if let Some(m) = out.as_object_mut() {
        m.insert("log".into(), log_json(&bp.take_log()));
    }
    answer(&out, out_len)
}

/// The slots rule on its own (`{ stored: [[profile, space]], spaces: { profile: [space] }, profiles: [id] }` →
/// `{ order: [[profile, space]] }`): the library's import, over a file it only reads.
///
/// # Safety
/// `request` points to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_profiles_resolve(request: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    let profiles: Vec<String> = o
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_string))
        .collect();
    let order = BrowserProfiles::resolve(&keys(o.get("stored")), &spaces(o.get("spaces")), &profiles);
    answer(&json!({ "order": keys_json(&order) }), out_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(p: *mut MarginProfiles, req: Value) -> Value {
        let t = req.to_string();
        let mut len = 0;
        // SAFETY: p from margin_profiles_new (or null), the request's bytes.
        let out = unsafe { margin_profiles_call(p, t.as_ptr(), t.len(), &mut len) };
        // SAFETY: a buffer margin_profiles_call made, `len` bytes.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: margin_buffer_free's contract.
        unsafe { crate::margin_buffer_free(out, len) };
        v
    }

    fn new(browser: &str, root: Option<&str>) -> *mut MarginProfiles {
        let (r, rn) = root.map_or((std::ptr::null(), 0), |r| (r.as_ptr(), r.len()));
        // SAFETY: the strings' bytes (or a null root).
        unsafe { margin_profiles_new(browser.as_ptr(), browser.len(), r, rn) }
    }

    #[test]
    fn the_profiles_through_the_ffi() {
        let dir = tempfile::tempdir().expect("a folder");
        let root = dir.path().to_string_lossy().to_string();
        let p = new("safari", Some(&root));
        let refreshed = call(
            p,
            json!({ "type": "refresh", "now": 1000, "spaces": { "s-default": ["a"], "s-old": ["b", "c"] },
                "linked": ["s-default", "s-old"] }),
        );
        assert_eq!(refreshed, json!({ "changed": true, "log": [] }));
        assert_eq!(
            call(p, json!({ "type": "stored" }))["stored"],
            json!([["s-default", "a"], ["s-old", "b"], ["s-old", "c"]])
        );
        assert_eq!(call(p, json!({ "type": "profiles" }))["profiles"], json!(["s-default", "s-old"]));
        assert_eq!(call(p, json!({ "type": "name", "profile": "s-old" }))["name"], json!("Profile 2"));
        assert_eq!(call(p, json!({ "type": "browserRead" }))["read"], Value::Null);
        let read = json!([{ "serverId": "DefaultProfile", "name": "Work", "margin": "s-default", "uuid": "x", "symbol": "" },
            { "serverId": "P", "name": "Personal", "margin": "s-old" }]);
        assert_eq!(call(p, json!({ "type": "useBrowserNames", "list": read, "now": 2000 }))["changed"], json!(true));
        assert_eq!(
            call(p, json!({ "type": "browserNames" }))["names"],
            json!({ "s-default": "Work", "s-old": "Personal" })
        );
        assert_eq!(
            call(p, json!({ "type": "browserRead" }))["read"][1],
            json!({ "serverId": "P", "name": "Personal", "margin": "s-old" })
        );
        let said = call(p, json!({ "type": "checkMapped", "linked": ["s-new", "s-default"] }));
        assert_eq!(said["said"], json!(["s-new"]));
        assert_eq!(said["log"][0]["warn"], json!(false));
        assert!(
            said["log"][0]["text"]
                .as_str()
                .is_some_and(|t| t.contains("copy s-new isn't any Safari profile's as read"))
        );
        let moved = json!([{ "serverId": "P", "name": "Personal", "margin": "s-new" }]);
        call(p, json!({ "type": "useBrowserNames", "list": moved }));
        let q = json!({ "type": "carrySource", "new": "s-new", "withSets": ["s-old"], "linked": ["s-new"] });
        assert_eq!(call(p, q), json!({ "old": "s-old", "browserId": "P", "log": [] }));
        let q = json!({ "type": "carrySource", "new": "s-new", "withSets": [], "linked": ["s-new"] });
        assert_eq!(call(p, q)["old"], Value::Null);
        let q = json!({ "type": "mightCarry", "new": "s-other", "withSets": ["s-old"], "linked": [] });
        assert_eq!(call(p, q)["might"], json!(true));
        call(p, json!({ "type": "carry", "old": "s-old", "new": "s-new", "now": 3000 }));
        let info = call(p, json!({ "type": "info" }))["info"].clone();
        assert!(info["s-old"]["hidden"] == true && info["s-new"]["browserId"] == "P");
        assert!(info["s-new"].get("emoji").is_none() && info["s-new"].get("color").is_none(), "the hosted shape");
        assert_eq!(call(p, json!({ "type": "forget", "profile": "s-old" }))["forgotten"], json!(false));
        assert_eq!(call(p, json!({ "type": "dropBrowserNames" }))["changed"], json!(true));
        assert_eq!(
            call(p, json!({ "type": "name", "profile": "s-default" }))["name"],
            json!("Work"),
            "gone from the last read: kept as typed"
        );
        assert!(call(p, json!({ "type": "saves" }))["saves"].as_u64().is_some_and(|n| n >= 3));
        assert!(call(p, json!({ "type": "nonsense" }))["error"].is_string());
        assert!(call(std::ptr::null_mut(), json!({ "type": "profiles" }))["error"].is_string());
        // The file as the Mac's: no switching.
        let file: Value = serde_json::from_slice(&std::fs::read(dir.path().join("safari/browser.json")).expect("read"))
            .expect("JSON");
        assert!(file.get("switching").is_none() && file["savedAt"] == json!(3000));
        // SAFETY: from margin_profiles_new, freed once.
        unsafe { margin_profiles_free(p) };
        // Read back by a new object; one in memory has nothing.
        let again = new("safari", Some(&root));
        assert_eq!(call(again, json!({ "type": "name", "profile": "s-new" }))["name"], json!("Profile 2"));
        // SAFETY: as above.
        unsafe { margin_profiles_free(again) };
        let memory = new("safari", None);
        assert_eq!(call(memory, json!({ "type": "profiles" }))["profiles"], json!([]));
        // SAFETY: as above.
        unsafe { margin_profiles_free(memory) };
        // SAFETY: a null browser: no object.
        assert!(unsafe { margin_profiles_new(std::ptr::null(), 0, std::ptr::null(), 0) }.is_null());
    }

    #[test]
    fn the_slots_rule_through_the_ffi() {
        let q = json!({ "stored": [["A", "a1"], ["B", "b1"], ["A", "a2"], "bad"], "spaces": { "A": ["a2", "a1"], "B": ["b1"] },
            "profiles": ["A", "B"] })
        .to_string();
        let mut len = 0;
        // SAFETY: the request's bytes.
        let out = unsafe { margin_profiles_resolve(q.as_ptr(), q.len(), &mut len) };
        // SAFETY: as margin_profiles_call's.
        let v: Value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: margin_buffer_free's contract.
        unsafe { crate::margin_buffer_free(out, len) };
        assert_eq!(v["order"], json!([["A", "a2"], ["B", "b1"], ["A", "a1"]]));
        let bad = b"nope";
        // SAFETY: as above.
        let out = unsafe { margin_profiles_resolve(bad.as_ptr(), bad.len(), &mut len) };
        // SAFETY: as above.
        let v: Value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, len) }).unwrap_or(Value::Null);
        // SAFETY: as above.
        unsafe { crate::margin_buffer_free(out, len) };
        assert!(v["error"].is_string());
    }
}
