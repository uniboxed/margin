//! Pictures as space backgrounds (margin-core's `data::backgrounds`, M2.9 step 7) for the Mac app's Swift
//! (BackgroundStore.swift):
//!
//! - one object over its folder (`margin_backgrounds_*`): the picture the platform made kept (`add`: its bytes typed,
//!   never wrapped in JSON: up to 10 MB), and one JSON call for the rest (`path`, `ids`, `constants`), and the cleanup as Margin opens
//!   (`prune_unused`: the library's rule, `Library::prune_pictures`, over this store).
//!
//! The Swift side decodes what the person chose (ImageIO), keeps the folder's place, and serves a picture to Margin's
//! page by id. Nothing here panics on what it's given: a bad request is `{"error": …}`.

use std::path::PathBuf;

use margin_core::data::backgrounds::{self, BackgroundError, BackgroundStore};
use margin_core::json;
use margin_core::library::PicturesPruned;
use serde_json::{Value, json};

use crate::data::{MarginLibrary, answer, library, text};

pub struct MarginBackgrounds {
    store: BackgroundStore,
}

fn refused(e: &BackgroundError) -> Value {
    match e {
        BackgroundError::Refused(why) => json!({ "refused": why }),
        BackgroundError::Io(e) => json!({ "refused": e.to_string(), "io": true }),
    }
}

impl MarginBackgrounds {
    fn call(&self, o: &json::Object) -> Value {
        match json::string(o.get("type")).unwrap_or("") {
            "constants" => json!({
                "maxBytes": backgrounds::MAX_BYTES, "maxSide": backgrounds::MAX_SIDE, "maxInputBytes": backgrounds::MAX_INPUT_BYTES,
            }),
            "path" => match self.store.path(json::string(o.get("id")).unwrap_or("")) {
                Some((path, kind)) => json!({ "path": path.to_string_lossy(), "mime": kind.mime() }),
                None => json!({ "path": null }),
            },
            "ids" => json!({ "ids": self.store.ids() }),
            other => json!({ "error": format!("bad request: no call {other:?}") }),
        }
    }
}

/// The store over `root` (its folder: made when the first picture is kept). Null: no root.
///
/// # Safety
/// `root` points to `len` readable bytes (UTF-8).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_backgrounds_new(root: *const u8, len: usize) -> *mut MarginBackgrounds {
    let Some(root) = text(root, len).filter(|t| !t.is_empty()).map(PathBuf::from) else { return std::ptr::null_mut() };
    Box::into_raw(Box::new(MarginBackgrounds { store: BackgroundStore::new(root) }))
}

/// # Safety
/// `store` from [`margin_backgrounds_new`], not freed yet (or null).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_backgrounds_free(store: *mut MarginBackgrounds) {
    if !store.is_null() {
        // SAFETY: made by Box::into_raw in margin_backgrounds_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(store) });
    }
}

/// A picture the platform made (JPEG or PNG), checked and kept: `{ id, type: "jpg"|"png", width, height, bytes }`, or
/// `{ refused, io? }` (the words for the page).
///
/// # Safety
/// `store` from [`margin_backgrounds_new`], not freed; `bytes` points to `len` readable bytes (or is null with 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_backgrounds_add(
    store: *mut MarginBackgrounds,
    bytes: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_backgrounds_new and not freed (the caller's contract).
    let Some(s) = (!store.is_null()).then(|| unsafe { &*store }) else {
        return answer(&json!({ "error": "no backgrounds object" }), out_len);
    };
    let data: &[u8] = if bytes.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: `len` readable bytes at `bytes` (the caller's contract).
        unsafe { std::slice::from_raw_parts(bytes, len) }
    };
    let out = match s.store.add(data) {
        Ok(k) => json!({ "id": k.id, "type": k.kind.ext(), "width": k.width, "height": k.height, "bytes": k.bytes }),
        Err(e) => refused(&e),
    };
    answer(&out, out_len)
}

/// One request → its answer: `constants` → `{ maxBytes, maxSide, maxInputBytes }`; `path` (id) → `{ path, mime }` or
/// `{ path: null }` (no such picture, or not an id); `ids` → `{ ids }`.
///
/// # Safety
/// `store` from [`margin_backgrounds_new`], not freed; `request` points to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_backgrounds_call(
    store: *mut MarginBackgrounds,
    request: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_backgrounds_new and not freed (the caller's contract).
    let Some(s) = (!store.is_null()).then(|| unsafe { &*store }) else {
        return answer(&json!({ "error": "no backgrounds object" }), out_len);
    };
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    answer(&s.call(o), out_len)
}

/// The cleanup as Margin opens, by the library's rule (`Library::prune_pictures`): `{ removed }` (the files no space
/// names, gone), `{ left }` (nothing removed: why, the library can't say which its spaces name) or `{ refused, io }`.
///
/// # Safety
/// `store` from [`margin_backgrounds_new`] and `library` from [`crate::data::margin_library_new`], neither freed (or
/// null); on their thread.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_backgrounds_prune_unused(
    store: *mut MarginBackgrounds,
    library: *const MarginLibrary,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_backgrounds_new and not freed (the caller's contract).
    let Some(s) = (!store.is_null()).then(|| unsafe { &*store }) else {
        return answer(&json!({ "error": "no backgrounds object" }), out_len);
    };
    let Some(lib) = self::library(library) else { return answer(&json!({ "error": "no library" }), out_len) };
    let out = match lib.prune_pictures(&s.store) {
        Ok(PicturesPruned::Removed(n)) => json!({ "removed": n }),
        Ok(PicturesPruned::LeftAlone(why)) => json!({ "left": why }),
        Err(e) => json!({ "refused": e.to_string(), "io": true }),
    };
    answer(&out, out_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(store: *mut MarginBackgrounds, request: &str) -> Value {
        let mut n = 0;
        // SAFETY: a live store, the request's bytes; the answer freed below.
        let out = unsafe { margin_backgrounds_call(store, request.as_ptr(), request.len(), &mut n) };
        // SAFETY: the answer's `n` bytes, then freed as margin_buffer_free does.
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, n) }).unwrap();
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(out, n)) });
        v
    }
    fn add(store: *mut MarginBackgrounds, bytes: &[u8]) -> Value {
        let mut n = 0;
        // SAFETY: a live store, the picture's bytes; the answer freed below.
        let out = unsafe { margin_backgrounds_add(store, bytes.as_ptr(), bytes.len(), &mut n) };
        let v = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, n) }).unwrap();
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(out, n)) });
        v
    }

    #[test]
    fn kept_found_and_pruned_through_the_ffi() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        // SAFETY: the root's bytes; the store freed at the end.
        let store = unsafe { margin_backgrounds_new(root.as_ptr(), root.len()) };
        assert!(!store.is_null());
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&64u32.to_be_bytes());
        png.extend_from_slice(&32u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        let kept = add(store, &png);
        let id = kept["id"].as_str().unwrap().to_owned();
        assert_eq!(
            (kept["type"].as_str(), kept["width"].as_u64(), kept["height"].as_u64()),
            (Some("png"), Some(64), Some(32))
        );
        let found = call(store, &format!(r#"{{"type":"path","id":"{id}"}}"#));
        assert_eq!(found["mime"], "image/png");
        assert!(found["path"].as_str().unwrap().ends_with(&format!("{id}.png")));
        assert_eq!(call(store, r#"{"type":"path","id":"../etc/passwd"}"#)["path"], Value::Null);
        assert!(add(store, b"GIF89a")["refused"].is_string());
        assert!(add(store, &[])["refused"].is_string());
        assert_eq!(call(store, r#"{"type":"ids"}"#)["ids"], json!([id]));
        assert_eq!(call(store, r#"{"type":"constants"}"#)["maxSide"], 3840);
        assert!(
            call(store, r#"{"type":"prune","keep":[]}"#)["error"].is_string(),
            "no prune by a list the caller made"
        );
        let pruned = |library: *const MarginLibrary| {
            let mut n = 0;
            // SAFETY: a live store and a live library (or null); the answer freed below.
            let out = unsafe { margin_backgrounds_prune_unused(store, library, &mut n) };
            let v: Value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(out, n) }).unwrap();
            drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(out, n)) });
            v
        };
        assert!(pruned(std::ptr::null())["error"].is_string(), "no library: nothing removed");
        let lib_root = dir.path().join("library").to_string_lossy().into_owned();
        // SAFETY: the root's bytes, no callbacks; freed below.
        let lib = unsafe {
            crate::data::margin_library_new(
                lib_root.as_ptr(),
                lib_root.len(),
                false,
                std::ptr::null_mut(),
                None,
                None,
                None,
                None,
            )
        };
        assert!(pruned(lib)["left"].is_string(), "a library with no data yet: nothing removed");
        assert_eq!(call(store, r#"{"type":"ids"}"#)["ids"], json!([id]));
        // SAFETY: from margin_library_new, freed once.
        unsafe { crate::data::margin_library_free(lib) };
        assert!(call(store, "nope")["error"].is_string());
        assert!(call(store, r#"{"type":"open"}"#)["error"].is_string());
        // SAFETY: from margin_backgrounds_new, freed once.
        unsafe { margin_backgrounds_free(store) };
        // SAFETY: null, empty and the null store: answered, never read.
        assert!(unsafe { margin_backgrounds_new(std::ptr::null(), 0) }.is_null());
        assert!(call(std::ptr::null_mut(), r#"{"type":"ids"}"#)["error"].is_string());
    }
}
