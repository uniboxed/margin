//! The theme store's client (margin-core's `data::theme_store`) for the Mac app's Swift (ShellThemeStore.swift): one
//! object for the app's run, holding where the store is, the install's key (its file read or made on the first signed
//! request) and the last index that checked out, so a page only ever names a theme by id: the package's address and
//! SHA-256 come from that index, never from a page. The Swift side sends the requests this makes (URLSession) and
//! hands back each answer; nothing here sends or waits. The proof of work, which takes a second or two, is a call of its
//! own with no object ([`margin_theme_store_solve`]), so it runs off the main thread while the object stays on it. One
//! JSON call; nothing panics on what it's given: a bad request is `{"error": …}`.
//!
//! Calls (`type`):
//! - `config` → `{ open, base? }`
//! - `index.request`, `challenge.request` → a request (`{ method, url, headers, body: base64 }`)
//! - `index.read` { body: base64, installed } → `{ ok, rows }` (the index kept) or `{ ok: false, message }`
//! - `rows` { installed } → `{ rows }`, from the index kept
//! - `package.request` { id } → a request, or `{ ok: false, message }` (not in the index kept)
//! - `package.check` { id, body: base64 } → `{ ok, id, version, sha256 }` or `{ ok: false, message }`
//! - `challenge.read` { body: base64 } → `{ ok, challenge, bits }` or `{ ok: false, message }`
//! - `publicKey` → `{ ok, publicKey }` (the key read or made), for [`margin_theme_store_solve`]
//! - `register.request` { challenge, nonce, now } → a request
//! - `upload.request` { message, now } → a request (the stored theme as its .margintheme), or `{ ok: false, message }`
//! - `report.request` { id, reason, now } → a request, or `{ ok: false, message }`
//! - `outcome` { kind, status, body: base64 } → what the answer means (data::theme_store::outcome)

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use margin_core::data::theme_store::{self as store, InstallKey, StoreConfig, StoreEntry};
use margin_core::json;
use serde_json::{Value, json};

use crate::data::{answer, text};

pub struct MarginThemeStore {
    config: Option<StoreConfig>,
    /// Where the key file is (`<root>/key`).
    root: PathBuf,
    key: Option<InstallKey>,
    entries: Vec<StoreEntry>,
}

fn refused(message: &str) -> Value {
    json!({ "ok": false, "message": message })
}

fn installed_of(o: &json::Object) -> Vec<json::Object> {
    o.get("installed")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(|e| e.as_object().cloned()).collect())
        .unwrap_or_default()
}

fn bytes_of(o: &json::Object, key: &str) -> Option<Vec<u8>> {
    json::string(o.get(key)).and_then(|s| BASE64.decode(s).ok())
}

impl MarginThemeStore {
    fn key(&mut self) -> Result<&InstallKey, String> {
        if self.key.is_none() {
            self.key = Some(
                InstallKey::load_or_make(&self.root)
                    .map_err(|e| format!("Margin couldn’t read or make its key for the theme store ({e})"))?,
            );
        }
        Ok(self.key.as_ref().expect("set above"))
    }

    fn entry(&self, id: &str) -> Option<&StoreEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    fn call(&mut self, o: &json::Object) -> Value {
        let kind = json::string(o.get("type")).unwrap_or("");
        if kind == "config" {
            return store::describe(self.config.as_ref());
        }
        if kind == "outcome" {
            let status = o.get("status").and_then(Value::as_u64).and_then(|n| u16::try_from(n).ok()).unwrap_or(0);
            return store::outcome(
                json::string(o.get("kind")).unwrap_or(""),
                status,
                &bytes_of(o, "body").unwrap_or_default(),
            );
        }
        let Some(config) = self.config.clone() else { return refused("The theme store isn’t open yet.") };
        let now = json::num(o.get("now")).filter(|n| n.is_finite() && *n > 0.0).map(|n| n as u64).unwrap_or(0);
        let id = json::string(o.get("id")).unwrap_or("");
        match kind {
            "index.request" => store::index_request(&config).to_json(),
            "challenge.request" => store::challenge_request(&config).to_json(),
            "index.read" => match store::read_index(&bytes_of(o, "body").unwrap_or_default(), &config.index_key) {
                Ok(entries) => {
                    self.entries = entries;
                    json!({ "ok": true, "rows": store::catalog(&self.entries, &installed_of(o)) })
                }
                Err(why) => refused(&format!("Margin can’t use the store’s list: {why}.")),
            },
            "rows" => json!({ "rows": store::catalog(&self.entries, &installed_of(o)) }),
            "package.request" => match self.entry(id) {
                Some(e) => store::package_request(&config, e).to_json(),
                None => refused("That theme isn’t in the store’s list any more: refresh it."),
            },
            "package.check" => {
                let Some(e) = self.entry(id) else {
                    return refused("That theme isn’t in the store’s list any more.");
                };
                let bytes = bytes_of(o, "body").unwrap_or_default();
                if !store::package_ok(&bytes, e) {
                    return refused("The theme that came isn’t the one the store’s list names: not used.");
                }
                json!({ "ok": true, "id": e.id, "version": e.version, "sha256": e.sha256 })
            }
            "challenge.read" => match store::read_challenge(&bytes_of(o, "body").unwrap_or_default()) {
                Ok((challenge, bits)) => json!({ "ok": true, "challenge": challenge, "bits": bits }),
                Err(why) => refused(&format!("Margin couldn’t register with the theme store: {why}.")),
            },
            "publicKey" => match self.key() {
                Ok(k) => json!({ "ok": true, "publicKey": k.public_key() }),
                Err(why) => refused(&why),
            },
            "register.request" => {
                let (challenge, nonce) =
                    (json::string(o.get("challenge")).unwrap_or(""), json::string(o.get("nonce")).unwrap_or(""));
                match self.key() {
                    Ok(k) => store::register_request(&config, k, challenge, nonce, now).to_json(),
                    Err(why) => refused(&why),
                }
            }
            "upload.request" => {
                let (zip, author) = match store::share_zip(json::string(o.get("message")).unwrap_or("")) {
                    Ok(x) => x,
                    Err(why) => return refused(&format!("Margin can’t share it: {why}.")),
                };
                match self.key() {
                    Ok(k) => store::upload_request(&config, k, zip, &author, now).to_json(),
                    Err(why) => refused(&why),
                }
            }
            "report.request" => {
                let reason = json::string(o.get("reason")).unwrap_or("");
                let Some(k) = self.key().ok() else {
                    return refused("Margin couldn’t read or make its key for the theme store.");
                };
                match store::report_request(&config, k, id, reason, now) {
                    Some(r) => r.to_json(),
                    None => refused("That isn’t a report Margin sends."),
                }
            }
            other => json!({ "error": format!("bad request: no call {other:?}") }),
        }
    }
}

/// The client for this run. `root`: the folder of the install's key (`~/Library/Application Support/Margin/
/// theme-store`). `base` and `key` (both or neither, from the process's environment: a test's or a developer's local
/// server): where the store is instead of the one Margin is built with.
///
/// # Safety
/// `root` points to `root_len` readable bytes; `over` is null or points to `over_len` readable bytes (UTF-8 JSON:
/// `{ base, key }`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_theme_store_new(
    root: *const u8,
    root_len: usize,
    over: *const u8,
    over_len: usize,
) -> *mut MarginThemeStore {
    let Some(root) = text(root, root_len).filter(|t| !t.is_empty()).map(PathBuf::from) else {
        return std::ptr::null_mut();
    };
    let over: Option<Value> =
        (!over.is_null()).then(|| text(over, over_len)).flatten().and_then(|t| serde_json::from_str(t).ok());
    let pair = over.as_ref().and_then(|v| Some((json::string(v.get("base"))?, json::string(v.get("key"))?)));
    let config = match pair {
        Some(p) => store::config(Some(p)),
        None => store::config(None),
    };
    Box::into_raw(Box::new(MarginThemeStore { config, root, key: None, entries: Vec::new() }))
}

/// # Safety
/// `client` from [`margin_theme_store_new`], not freed yet (or null).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_theme_store_free(client: *mut MarginThemeStore) {
    if !client.is_null() {
        // SAFETY: made by Box::into_raw in margin_theme_store_new and not freed (the caller's contract).
        drop(unsafe { Box::from_raw(client) });
    }
}

/// One call → its answer (UTF-8 JSON, freed with `margin_buffer_free`).
///
/// # Safety
/// `client` from [`margin_theme_store_new`], not freed; `request` points to `len` readable bytes; one call at a time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_theme_store_call(
    client: *mut MarginThemeStore,
    request: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // SAFETY: from margin_theme_store_new and not freed (the caller's contract); one call at a time.
    let Some(c) = (!client.is_null()).then(|| unsafe { &mut *client }) else {
        return answer(&json!({ "error": "no theme store object" }), out_len);
    };
    let Some(req) = text(request, len).and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return answer(&json!({ "error": "bad request: not JSON" }), out_len);
    };
    let Some(o) = req.as_object() else { return answer(&json!({ "error": "bad request: not an object" }), out_len) };
    answer(&c.call(o), out_len)
}

/// The proof of work (`{ challenge, publicKey, bits }` → `{ ok, nonce }` or `{ ok: false, message }`), on every core:
/// a second or two. No object: call it off the main thread.
///
/// # Safety
/// `request` points to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn margin_theme_store_solve(request: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let req: Option<Value> = text(request, len).and_then(|t| serde_json::from_str(t).ok());
    let o = req.as_ref().and_then(Value::as_object);
    let challenge = o.and_then(|o| json::string(o.get("challenge"))).unwrap_or("");
    let public_key = o.and_then(|o| json::string(o.get("publicKey"))).unwrap_or("");
    let bits = o.and_then(|o| json::int(o.get("bits"))).filter(|b| (1..=i64::from(store::MAX_POW_BITS)).contains(b));
    let Some(bits) = bits.filter(|_| !challenge.is_empty() && !public_key.is_empty()) else {
        return answer(&refused("Margin couldn’t register with the theme store: a bad challenge."), out_len);
    };
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let found = store::solve(challenge, public_key, bits as u32, threads, &AtomicBool::new(false));
    let out = found.map_or_else(
        || refused("Margin couldn’t register with the theme store."),
        |nonce| json!({ "ok": true, "nonce": nonce }),
    );
    answer(&out, out_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(dir: &std::path::Path, open: bool) -> MarginThemeStore {
        let key = InstallKey::from_seed(&[3u8; 32]).unwrap().public_key();
        let config = if open { store::config(Some(("https://themes.example", &key))) } else { None };
        MarginThemeStore { config, root: dir.to_path_buf(), key: None, entries: Vec::new() }
    }

    fn call(c: &mut MarginThemeStore, v: Value) -> Value {
        c.call(v.as_object().unwrap())
    }

    #[test]
    fn closed_until_its_address_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = client(dir.path(), false);
        assert_eq!(call(&mut c, json!({ "type": "config" })), json!({ "open": false }));
        assert_eq!(call(&mut c, json!({ "type": "index.request" }))["message"], "The theme store isn’t open yet.");
        assert!(!dir.path().join("key").exists(), "no key made for a store that isn't open");
    }

    #[test]
    fn requests_and_the_key_made_once_on_the_first_signed_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = client(dir.path(), true);
        let index = call(&mut c, json!({ "type": "index.request" }));
        assert_eq!(index["url"], "https://themes.example/v1/index");
        assert!(!dir.path().join("key").exists(), "an unsigned request makes no key");
        let reg = call(
            &mut c,
            json!({ "type": "register.request", "challenge": "1.2.3.4", "nonce": "5", "now": 1795600000000u64 }),
        );
        assert_eq!(reg["method"], "POST");
        assert!(reg["headers"]["X-Margin-Signature"].as_str().is_some());
        assert!(dir.path().join("key").exists());
        // A package only by an id in the index kept; a report only for a reason the server takes.
        assert_eq!(call(&mut c, json!({ "type": "package.request", "id": "dusk" }))["ok"], false);
        assert_eq!(
            call(&mut c, json!({ "type": "report.request", "id": "dusk", "reason": "meh", "now": 1 }))["ok"],
            false
        );
        assert_eq!(
            call(&mut c, json!({ "type": "report.request", "id": "dusk", "reason": "broken", "now": 1 }))["url"],
            "https://themes.example/v1/reports"
        );
        let solve = |v: Value| {
            let t = v.to_string();
            let mut n = 0usize;
            // SAFETY: t is alive for the call; the answer is freed below.
            let p = unsafe { margin_theme_store_solve(t.as_ptr(), t.len(), &mut n) };
            // SAFETY: p and n from `answer` (a boxed slice of n bytes), freed once here.
            let bytes = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(p, n)) };
            serde_json::from_slice::<Value>(&bytes).unwrap()
        };
        let pk = call(&mut c, json!({ "type": "publicKey" }))["publicKey"].as_str().unwrap().to_string();
        let nonce =
            solve(json!({ "challenge": "a.1.b.c", "publicKey": pk, "bits": 8 }))["nonce"].as_str().unwrap().to_string();
        assert!(store::work_ok("a.1.b.c", &pk, &nonce, 8));
        let greedy = solve(json!({ "challenge": "a.1.b.c", "publicKey": pk, "bits": 99 }));
        assert_eq!(greedy["ok"], false, "never more work than Margin does");
        assert_eq!(call(&mut c, json!({ "type": "nope" }))["error"], "bad request: no call \"nope\"");
    }
}
