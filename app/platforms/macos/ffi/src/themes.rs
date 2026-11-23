//! The themes a person imported, the built-ins' packages and what the picker chose (margin-core's `data::themes`) for
//! the Mac app's Swift (docs/CORE-REFACTOR.md step 1.6):
//!
//! - the store (`margin_themes_*`): one object over its folder, one JSON call for the index and its changes
//!   (`list`, `has`, `save`, `remove`), and a typed call for the package a window draws (`margin_themes_message`: its
//!   JSON's bytes as they are, never wrapped in another JSON string: a package is up to 4.5 MB);
//! - the built-ins' packages (`margin_builtin_themes_*`): one object over the app's folder, the package's bytes typed;
//! - no object (`margin_themes_protocol`): the id rule, the limits, and what the picker chose read within its caps.
//!
//! The Swift side keeps the file picker and the folder's place (`~/Library/Application Support/Margin/themes`).
//! Nothing here panics on what it's given: a bad request is `{"error": …}`, a theme not there a null pointer.

use std::path::{Path, PathBuf};

use margin_core::data::themes::{self, BuiltinThemes, ThemeError, ThemeStore};
use margin_core::json;
use serde_json::{Value, json};

use crate::data::{answer, text};

pub struct MarginThemes {
    store: ThemeStore,
}

/// Bytes as an answer (freed with `margin_buffer_free`); null for none.
fn bytes_out(data: Option<String>, out_len: *mut usize) -> *mut u8 {
    let Some(data) = data.filter(|_| !out_len.is_null()) else { return std::ptr::null_mut() };
    let boxed = data.into_bytes().into_boxed_slice();
    // SAFETY: out_len is writable (checked non-null; the caller's contract).
    unsafe { *out_len = boxed.len() };
    Box::into_raw(boxed) as *mut u8
}

fn error_text(e: &ThemeError) -> Value {
    match e {
        ThemeError::Refused(why) => json!({ "refused": why }),
        ThemeError::Io(e) => json!({ "refused": e.to_string(), "io": true }),
    }
}

impl MarginThemes {
    fn call(&mut self, o: &json::Object) -> Value {
        let id = json::string(o.get("id")).unwrap_or("");
        match json::string(o.get("type")).unwrap_or("") {
            "list" => json!({ "list": self.store.list() }),
            "has" => json!({ "has": self.store.has(id) }),
            "save" => {
                let Some(value) = json::object(o.get("value")) else {
                    return json!({ "refused": "not a theme package" });
                };
                let now = json::num(o.get("now")).unwrap_or(0.0);
                match self.store.save(value, now) {
                    Ok(entry) => json!({ "entry": entry }),
                    Err(e) => error_text(&e),
                }
            }
            "remove" => match self.store.remove(id) {
                Ok(was) => json!({ "removed": was }),
                Err(e) => error_text(&e),
            },
            other => json!({ "error": format!("bad request: no call {other:?}") }),
        }
    }
}

fn path_of(ptr: *const u8, len: usize) -> Option<PathBuf> {
    text(ptr, len).filter(|t| !t.is_empty()).map(PathBuf::from)
}

/// The store over `root` (its folder: made when the first theme is stored). Null: no root.
///
/// # Safety
/// `root` points to `len` readable bytes (UTF-8).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_themes_new(root: *const u8, len: usize) -> *mut MarginThemes {
    let Some(root) = path_of(root, len) else { return std::ptr::null_mut() };
    Box::into_raw(Box::new(MarginThemes { store: ThemeStore::new(root) }))
}

/// # Safety
/// `themes` from [`margin_themes_new`], not freed yet (or null).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_themes_free(themes: *mut MarginThemes) {
    if !themes.is_null() {
        // SAFETY: made by Box::into_raw in margin_themes_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(themes) });
    }
}

/// One request → its answer: `list` → `{ list }`; `has` (id) → `{ has }`; `save` (value, now: ms since 1970) →
/// `{ entry }` or `{ refused, io? }` (the words for the page); `remove` (id) → `{ removed }` or `{ refused, io }`.
///
/// # Safety
/// `themes` from [`margin_themes_new`], not freed; `request` points to `len` readable bytes; one call at a time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_themes_call(
    themes: *mut MarginThemes,
    request: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_themes_new and not freed (the caller's contract); one call at a time.
    let Some(t) = (!themes.is_null()).then(|| unsafe { &mut *themes }) else {
        return answer(&json!({ "error": "no themes object" }), out_len);
    };
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    answer(&t.call(o), out_len)
}

/// The theme message a window draws for a stored theme (`{ id, manifest, html, css, files }`, UTF-8 JSON), or null:
/// not listed, missing, of a later format, or naming another id.
///
/// # Safety
/// `themes` from [`margin_themes_new`], not freed; `id` points to `len` readable bytes; one call at a time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_themes_message(
    themes: *mut MarginThemes,
    id: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_themes_new and not freed (the caller's contract); one call at a time.
    let Some(t) = (!themes.is_null()).then(|| unsafe { &mut *themes }) else { return std::ptr::null_mut() };
    let Some(id) = text(id, len) else { return std::ptr::null_mut() };
    bytes_out(t.store.message(id), out_len)
}

/// The built-ins' packages in `root` (null or empty: none, as a test's and the harness's).
///
/// # Safety
/// `root` is null or points to `len` readable bytes (UTF-8).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_builtin_themes_new(root: *const u8, len: usize) -> *mut BuiltinThemes {
    Box::into_raw(Box::new(BuiltinThemes::new(path_of(root, len))))
}

/// # Safety
/// `builtins` from [`margin_builtin_themes_new`], not freed yet (or null).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_builtin_themes_free(builtins: *mut BuiltinThemes) {
    if !builtins.is_null() {
        // SAFETY: made by Box::into_raw in margin_builtin_themes_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(builtins) });
    }
}

/// A built-in's package (its file's UTF-8 JSON) by the id a setting chose (an earlier name too), or null.
///
/// # Safety
/// `builtins` from [`margin_builtin_themes_new`], not freed; `chosen` points to `len` readable bytes; one call at a
/// time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_builtin_themes_message(
    builtins: *mut BuiltinThemes,
    chosen: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_builtin_themes_new and not freed (the caller's contract); one call at a time.
    let Some(b) = (!builtins.is_null()).then(|| unsafe { &mut *builtins }) else { return std::ptr::null_mut() };
    let Some(chosen) = text(chosen, len) else { return std::ptr::null_mut() };
    bytes_out(b.message(chosen), out_len)
}

/// No object: `idOK` (id) → `{ ok }`; `constants` → the limits; `read` (path, chosen: whether it's what the picker
/// chose, checked to be a folder or a `.margintheme` file first) → `{ message, kind, bytes, chosen }` (`chosen`
/// false: refused before anything was read, for being neither).
#[unsafe(no_mangle)]
pub extern "C" fn margin_themes_protocol(request: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    let out = match json::string(o.get("type")).unwrap_or("") {
        "idOK" => json!({ "ok": themes::id_ok(json::string(o.get("id")).unwrap_or("")) }),
        "constants" => json!({
            "format": themes::FORMAT, "maxBytes": themes::MAX_BYTES, "maxThemes": themes::MAX_THEMES,
            "builtins": themes::BUILTINS, "maxFiles": themes::MAX_FILES, "maxDepth": themes::MAX_DEPTH,
            "maxFileBytes": themes::MAX_FILE_BYTES, "maxFolderBytes": themes::MAX_FOLDER_BYTES,
            "maxZipBytes": themes::MAX_ZIP_BYTES,
        }),
        "read" => {
            let path = Path::new(json::string(o.get("path")).unwrap_or(""));
            let chosen = json::flag(o.get("chosen")) == Some(true);
            let ok = !chosen || themes::chosen_ok(path);
            let read = if chosen { themes::read_chosen(path) } else { themes::read_theme_file(path) };
            json!({ "message": read.message, "kind": read.kind, "bytes": read.bytes, "chosen": ok })
        }
        other => json!({ "error": format!("bad request: no call {other:?}") }),
    };
    answer(&out, out_len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn read(ptr: *mut u8, len: usize) -> Value {
        assert!(!ptr.is_null());
        // SAFETY: an answer's bytes, freed right after.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap_or(Value::Null);
        unsafe { crate::margin_buffer_free(ptr, len) };
        v
    }

    fn call(t: *mut MarginThemes, v: Value) -> Value {
        let s = v.to_string();
        let mut n = 0;
        // SAFETY: a live object, a valid buffer.
        read(unsafe { margin_themes_call(t, s.as_ptr(), s.len(), &mut n) }, n)
    }

    fn message(t: *mut MarginThemes, id: &str) -> Option<String> {
        let mut n = 0;
        // SAFETY: a live object, a valid buffer.
        let p = unsafe { margin_themes_message(t, id.as_ptr(), id.len(), &mut n) };
        if p.is_null() {
            return None;
        }
        // SAFETY: an answer's bytes, freed right after.
        let s = String::from_utf8(unsafe { std::slice::from_raw_parts(p, n) }.to_vec()).ok();
        unsafe { crate::margin_buffer_free(p, n) };
        s
    }

    fn protocol(v: Value) -> Value {
        let s = v.to_string();
        let mut n = 0;
        read(margin_themes_protocol(s.as_ptr(), s.len(), &mut n), n)
    }

    fn value(id: &str) -> Value {
        let manifest = json!({ "format": 2, "id": id, "name": "Mine", "version": "1.0.0", "author": "Me" }).to_string();
        json!({ "format": 2, "id": id, "version": "1.0.0", "savedAt": 1, "manifest": manifest,
                "html": "<div></div>", "css": ".a{}", "files": { "LICENSE.txt": "aGk=" } })
    }

    #[test]
    fn the_store_over_its_calls() {
        let tmp = tempfile::tempdir().expect("a folder");
        let root = tmp.path().join("themes");
        let r = root.to_string_lossy().into_owned();
        // SAFETY: a valid buffer.
        let t = unsafe { margin_themes_new(r.as_ptr(), r.len()) };
        assert!(!t.is_null());
        assert_eq!(call(t, json!({"type":"list"})), json!({"list":[]}));
        let a = call(t, json!({"type":"save","value":value("mine"),"now":42}));
        assert!(a["entry"]["id"] == "mine" && a["entry"]["savedAt"] == 42 && a["entry"]["bytes"].as_u64() > Some(0));
        assert_eq!(call(t, json!({"type":"has","id":"mine"})), json!({"has":true}));
        assert_eq!(call(t, json!({"type":"list"}))["list"][0]["name"], "Mine");
        let m: Value = serde_json::from_str(&message(t, "mine").unwrap_or_default()).unwrap_or(Value::Null);
        assert_eq!(m["files"]["LICENSE.txt"], "aGk=", "the package's bytes as they are");
        assert_eq!(message(t, "other"), None, "not listed: none");
        let refused = call(t, json!({"type":"save","value":value("material"),"now":1}));
        assert!(refused["refused"].as_str().is_some_and(|w| w.contains("built-in")) && refused.get("io").is_none());
        assert_eq!(call(t, json!({"type":"save","value":5}))["refused"], "not a theme package");
        assert_eq!(call(t, json!({"type":"remove","id":"mine"})), json!({"removed":true}));
        assert_eq!(call(t, json!({"type":"remove","id":"mine"})), json!({"removed":false}));
        assert!(call(t, json!({"type":"nope"}))["error"].is_string());
        // SAFETY: live, then freed once; null is fine.
        unsafe {
            let mut n = 0;
            assert!(read(margin_themes_call(t, b"{x".as_ptr(), 2, &mut n), n)["error"].is_string());
            assert!(read(margin_themes_call(std::ptr::null_mut(), b"{}".as_ptr(), 2, &mut n), n)["error"].is_string());
            assert!(margin_themes_message(std::ptr::null_mut(), b"a".as_ptr(), 1, &mut n).is_null());
            margin_themes_free(t);
            margin_themes_free(std::ptr::null_mut());
            assert!(margin_themes_new(std::ptr::null(), 0).is_null(), "no root: no store");
        }
    }

    #[test]
    fn the_built_ins_over_their_calls() {
        let tmp = tempfile::tempdir().expect("a folder");
        let package = json!({"id":"pixel","manifest":"{}","html":"","css":"","files":{}}).to_string();
        fs::write(tmp.path().join("theme.pixel.json"), &package).expect("written");
        let r = tmp.path().to_string_lossy().into_owned();
        let get = |b: *mut BuiltinThemes, id: &str| {
            let mut n = 0;
            // SAFETY: a live object, a valid buffer.
            let p = unsafe { margin_builtin_themes_message(b, id.as_ptr(), id.len(), &mut n) };
            if p.is_null() {
                return None;
            }
            // SAFETY: an answer's bytes, freed right after.
            let s = String::from_utf8(unsafe { std::slice::from_raw_parts(p, n) }.to_vec()).ok();
            unsafe { crate::margin_buffer_free(p, n) };
            s
        };
        // SAFETY: valid buffers; freed once each.
        unsafe {
            let b = margin_builtin_themes_new(r.as_ptr(), r.len());
            assert_eq!(get(b, "pixel"), Some(package));
            assert_eq!(get(b, "arcadia"), None, "its file missing");
            margin_builtin_themes_free(b);
            let none = margin_builtin_themes_new(std::ptr::null(), 0);
            assert_eq!(get(none, "pixel"), None, "no folder: none");
            margin_builtin_themes_free(none);
            margin_builtin_themes_free(std::ptr::null_mut());
        }
    }

    #[test]
    fn the_rule_the_limits_and_the_picker() {
        assert_eq!(protocol(json!({"type":"idOK","id":"mine"})), json!({"ok":true}));
        assert_eq!(protocol(json!({"type":"idOK","id":"../x"})), json!({"ok":false}));
        let c = protocol(json!({"type":"constants"}));
        assert!(c["maxBytes"] == 4_718_592 && c["maxFileBytes"] == 524_288 && c["maxZipBytes"] == 4_194_304);
        assert_eq!(c["builtins"].as_array().map(Vec::len), Some(6));
        let tmp = tempfile::tempdir().expect("a folder");
        let zip = tmp.path().join("t.margintheme");
        fs::write(&zip, "PK").expect("written");
        let other = tmp.path().join("t.zip");
        fs::write(&other, "PK").expect("written");
        let path = |p: &Path| p.to_string_lossy().into_owned();
        let a = protocol(json!({"type":"read","path":path(&zip),"chosen":true}));
        assert!(a["kind"] == "zip" && a["bytes"] == 2 && a["chosen"] == true && a["message"]["zip"] == "UEs=");
        let a = protocol(json!({"type":"read","path":path(&other),"chosen":true}));
        assert!(a["kind"] == "refused" && a["chosen"] == false, "neither a folder nor a .margintheme: refused unread");
        let a = protocol(json!({"type":"read","path":path(&other)}));
        assert_eq!(a["kind"], "zip", "not the picker's: read as it is");
        assert!(protocol(json!({"type":"nope"}))["error"].is_string());
    }
}
