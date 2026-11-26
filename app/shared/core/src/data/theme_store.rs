//! The theme store's client rules (docs/THEME-STORE.md §2–§4), one copy for the Mac and Windows: where the store is,
//! the install's anonymous key and what it signs, the proof of work, the signed index read and checked, what each
//! store theme is to this install (to install, installed, an update, or one of the person's own), a downloaded
//! package checked against the index, the `.margintheme` a shared theme is uploaded as, and what an answer means.
//! The server's side of each format is cloud/themes/src/keys.ts and store.ts; both are held to the vectors in
//! cloud/themes/vectors.json. HTTP and threads are the platform's; nothing here sends or waits.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as B64URL};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::store::write_atomically;
use super::themes::{BUILTINS, MAX_PACKAGE_FILES, MAX_ZIP_BYTES, id_ok};
use crate::json::{self, Object};

/// What the index's signature signs, before its text.
pub const INDEX_CONTEXT: &str = "margin-themes-index-v1\n";
/// The first line of what a request's signature signs.
pub const REQUEST_CONTEXT: &str = "margin-themes-v1";
/// The proof of work's first line.
pub const POW_CONTEXT: &str = "margin-themes-pow-v1\n";
/// Never more work than this, whatever a server asks: 28 bits (the server's) is about 1.6 s on an M-series Mac's
/// cores, 30 about 6 s.
pub const MAX_POW_BITS: u32 = 30;
/// An index larger than this is refused unread.
pub const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 5000;
/// A server's words shown as they are, at most this long.
const MAX_WORDS: usize = 300;

/// Margin's theme store: its address and the index's public key (base64url), set once it's deployed (cloud/themes/
/// README.md). `None`: not open yet, and Settings says so.
pub const STORE: Option<(&str, &str)> = None;

/// Where the store is, for this run.
#[derive(Clone, Debug, PartialEq)]
pub struct StoreConfig {
    /// `https://host[:port]`, or `http://127.0.0.1:port` / `http://localhost:port` (a local test server): no path.
    pub base: String,
    pub index_key: [u8; 32],
}

/// The store for this run: `over` (a test's or a developer's, from the process's environment: never from a page or
/// a setting), else [`STORE`]. `None` when neither is set or either is malformed.
pub fn config(over: Option<(&str, &str)>) -> Option<StoreConfig> {
    let (base, key) = over.or(STORE)?;
    let base = base.trim_end_matches('/');
    let url = url::Url::parse(base).ok()?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    let ok = (url.scheme() == "https" || (url.scheme() == "http" && local))
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    if !ok {
        return None;
    }
    let index_key: [u8; 32] = B64URL.decode(key).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&index_key).ok()?;
    Some(StoreConfig { base: base.to_string(), index_key })
}

// ---- the install's key ----

/// The install's anonymous key (§2): an Ed25519 key whose 32-byte seed is kept in Margin's data folder.
pub struct InstallKey {
    signing: SigningKey,
}

impl InstallKey {
    pub fn from_seed(seed: &[u8]) -> Option<Self> {
        let seed: [u8; 32] = seed.try_into().ok()?;
        Some(Self { signing: SigningKey::from_bytes(&seed) })
    }

    pub fn new_seed() -> io::Result<[u8; 32]> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| io::Error::other(e.to_string()))?;
        Ok(seed)
    }

    /// Its key file (`key` under `root`, the seed as base64), read; made (written atomically, readable by the person
    /// only) if there's none. A file that isn't a seed is never replaced (a new key would lose the themes this one
    /// shared): an error.
    pub fn load_or_make(root: &Path) -> io::Result<Self> {
        let path = key_path(root);
        match fs::read(&path) {
            Ok(data) => {
                let text = String::from_utf8(data).map_err(|_| io::Error::other("the key file isn’t text"))?;
                let seed = BASE64.decode(text.trim()).map_err(|_| io::Error::other("the key file isn’t a key"))?;
                Self::from_seed(&seed).ok_or_else(|| io::Error::other("the key file isn’t a key"))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let seed = Self::new_seed()?;
                fs::create_dir_all(root)?;
                write_atomically(BASE64.encode(seed).as_bytes(), &path)?;
                private_file(&path)?;
                Ok(Self { signing: SigningKey::from_bytes(&seed) })
            }
            Err(e) => Err(e),
        }
    }

    pub fn public_raw(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    /// The public key, base64url: what registering sends.
    pub fn public_key(&self) -> String {
        B64URL.encode(self.public_raw())
    }

    /// Its id: the first 16 bytes of the public key's SHA-256, in hex (the server's `keyId`).
    pub fn id(&self) -> String {
        hex::encode(&Sha256::digest(self.public_raw())[..16])
    }

    /// `text` signed, base64url.
    pub fn sign(&self, text: &str) -> String {
        B64URL.encode(self.signing.sign(text.as_bytes()).to_bytes())
    }
}

fn key_path(root: &Path) -> PathBuf {
    root.join("key")
}

#[cfg(unix)]
fn private_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn private_file(_path: &Path) -> io::Result<()> {
    Ok(()) // (%LOCALAPPDATA% is the person's own)
}

// ---- requests ----

/// What a request signs (the server's `signedText`): the method, the path (no query), the time, the body's SHA-256 in
/// hex, and the `X-Margin-Meta` header ("" without one), one per line after [`REQUEST_CONTEXT`].
pub fn signed_text(method: &str, path: &str, time: &str, body_sha256: &str, meta: &str) -> String {
    format!("{REQUEST_CONTEXT}\n{method}\n{path}\n{time}\n{body_sha256}\n{meta}")
}

/// A request for the platform to send: its method, the full URL, its headers and body.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn to_json(&self) -> Value {
        let headers: Object = self.headers.iter().map(|(k, v)| (k.clone(), Value::from(v.clone()))).collect();
        json!({ "method": self.method, "url": self.url, "headers": headers, "body": BASE64.encode(&self.body) })
    }
}

fn unsigned(config: &StoreConfig, method: &'static str, path: &str) -> Request {
    Request { method, url: format!("{}{path}", config.base), headers: Vec::new(), body: Vec::new() }
}

fn signed(
    config: &StoreConfig,
    key: &InstallKey,
    method: &'static str,
    path: &str,
    body: Vec<u8>,
    meta: Option<String>,
    now_ms: u64,
) -> Request {
    let time = now_ms.to_string();
    let meta_text = meta.clone().unwrap_or_default();
    let signature = key.sign(&signed_text(method, path, &time, &hex::encode(Sha256::digest(&body)), &meta_text));
    let mut headers = vec![
        ("X-Margin-Key".to_string(), key.id()),
        ("X-Margin-Time".to_string(), time),
        ("X-Margin-Signature".to_string(), signature),
    ];
    if let Some(meta) = meta {
        headers.push(("X-Margin-Meta".to_string(), meta));
    }
    if !body.is_empty() {
        let kind = if path == "/v1/themes" { "application/zip" } else { "application/json" };
        headers.push(("Content-Type".to_string(), kind.to_string()));
    }
    Request { method, url: format!("{}{path}", config.base), headers, body }
}

pub fn challenge_request(config: &StoreConfig) -> Request {
    unsigned(config, "GET", "/v1/challenge")
}

pub fn index_request(config: &StoreConfig) -> Request {
    unsigned(config, "GET", "/v1/index")
}

/// A package by its SHA-256 (from the checked index only).
pub fn package_request(config: &StoreConfig, entry: &StoreEntry) -> Request {
    unsigned(config, "GET", &format!("/v1/packages/{}", entry.sha256))
}

/// Registering the key, with the work done (`nonce` for `challenge`).
pub fn register_request(config: &StoreConfig, key: &InstallKey, challenge: &str, nonce: &str, now_ms: u64) -> Request {
    let body = json!({ "publicKey": key.public_key(), "challenge": challenge, "nonce": nonce }).to_string();
    signed(config, key, "POST", "/v1/keys", body.into_bytes(), None, now_ms)
}

/// A theme shared: its `.margintheme` ([`share_zip`]) and its author's name (its theme.json's).
pub fn upload_request(config: &StoreConfig, key: &InstallKey, zip: Vec<u8>, author: &str, now_ms: u64) -> Request {
    let meta = B64URL.encode(json!({ "author": author, "tags": [] }).to_string());
    signed(config, key, "POST", "/v1/themes", zip, Some(meta), now_ms)
}

/// The server's report reasons (cloud/themes/src/store.ts `REPORT_REASONS`).
pub const REPORT_REASONS: [&str; 5] = ["broken", "offensive", "impersonation", "copied", "other"];

pub fn report_request(config: &StoreConfig, key: &InstallKey, id: &str, reason: &str, now_ms: u64) -> Option<Request> {
    if !id_ok(id) || !REPORT_REASONS.contains(&reason) {
        return None;
    }
    let body = json!({ "theme": id, "reason": reason }).to_string();
    Some(signed(config, key, "POST", "/v1/reports", body.into_bytes(), None, now_ms))
}

// ---- the proof of work ----

/// A challenge's answer (`GET /v1/challenge`: `{ challenge, bits }`), read: its text as the server gives it (checked
/// for shape only: the server checks its own MAC) and its bits, refused above [`MAX_POW_BITS`].
pub fn read_challenge(body: &[u8]) -> Result<(String, u32), String> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "the store’s challenge isn’t JSON".to_string())?;
    let challenge = json::string(v.get("challenge")).unwrap_or("");
    let bits = json::int(v.get("bits")).unwrap_or(-1);
    let shaped = challenge.len() <= 200
        && challenge.split('.').count() == 4
        && challenge.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_');
    if !shaped {
        return Err("the store’s challenge isn’t one Margin reads".into());
    }
    if !(1..=i64::from(MAX_POW_BITS)).contains(&bits) {
        return Err(format!("the store asks for more work than Margin does ({bits} bits)"));
    }
    Ok((challenge.to_string(), bits as u32))
}

fn zero_bits(digest: &[u8]) -> u32 {
    let mut n = 0;
    for &b in digest {
        if b == 0 {
            n += 8;
            continue;
        }
        return n + b.leading_zeros();
    }
    n
}

fn pow_prefix(challenge: &str, public_key: &str) -> Sha256 {
    let mut h = Sha256::new();
    h.update(POW_CONTEXT.as_bytes());
    h.update(challenge.as_bytes());
    h.update(b"\n");
    h.update(public_key.as_bytes());
    h.update(b"\n");
    h
}

/// Whether `nonce` proves the work for this challenge and key (the server's check).
pub fn work_ok(challenge: &str, public_key: &str, nonce: &str, bits: u32) -> bool {
    let mut h = pow_prefix(challenge, public_key);
    h.update(nonce.as_bytes());
    zero_bits(&h.finalize()) >= bits
}

/// A nonce (decimal) that proves the work, found on `threads` threads (each takes every `threads`-th number from its
/// own start); `None` if `stop` is set first. With one thread, the smallest.
pub fn solve(challenge: &str, public_key: &str, bits: u32, threads: usize, stop: &AtomicBool) -> Option<String> {
    let threads = threads.clamp(1, 64) as u64;
    let prefix = pow_prefix(challenge, public_key);
    let found = Arc::new(AtomicU64::new(u64::MAX));
    std::thread::scope(|scope| {
        for start in 0..threads {
            let prefix = prefix.clone();
            let found = Arc::clone(&found);
            scope.spawn(move || {
                let mut n = start;
                let mut digits = [0u8; 20];
                loop {
                    if n >= found.load(Ordering::Relaxed) || stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let mut h = prefix.clone();
                    h.update(decimal(n, &mut digits));
                    if zero_bits(&h.finalize()) >= bits {
                        found.fetch_min(n, Ordering::Relaxed);
                        return;
                    }
                    n += threads;
                }
            });
        }
    });
    let n = found.load(Ordering::Relaxed);
    (n != u64::MAX).then(|| n.to_string())
}

/// `n` in decimal, in `buf`.
fn decimal(mut n: u64, buf: &mut [u8; 20]) -> &[u8] {
    let mut at = buf.len();
    loop {
        at -= 1;
        buf[at] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            return &buf[at..];
        }
    }
}

// ---- the index ----

/// A theme as the checked index lists it (its newest published version).
#[derive(Clone, Debug, PartialEq)]
pub struct StoreEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    /// The first 8 hex digits of its author's key id: two authors can't pass as each other.
    pub author_key: String,
    pub sha256: String,
    pub size: u64,
    pub updated: f64,
}

/// The index (`GET /v1/index`: `{ index: "<JSON as text>", signature }`), its signature checked with the store's
/// key over [`INDEX_CONTEXT`] + the text, then read: `{ format: 1, generation, themes: [...] }`. An entry that isn't
/// well formed, names a built-in's id or repeats an id is left out (the server never sends one: the rest is kept).
pub fn read_index(body: &[u8], index_key: &[u8; 32]) -> Result<Vec<StoreEntry>, String> {
    if body.len() > MAX_INDEX_BYTES {
        return Err("the store’s list is too large".into());
    }
    let outer: Value = serde_json::from_slice(body).map_err(|_| "the store’s list isn’t JSON".to_string())?;
    let text = json::string(outer.get("index")).ok_or("the store’s list isn’t signed")?;
    let signature: [u8; 64] = json::string(outer.get("signature"))
        .and_then(|s| B64URL.decode(s).ok())
        .and_then(|b| b.try_into().ok())
        .ok_or("the store’s list isn’t signed")?;
    let key = VerifyingKey::from_bytes(index_key).map_err(|_| "Margin’s key for the store isn’t a key".to_string())?;
    let signed = format!("{INDEX_CONTEXT}{text}");
    key.verify_strict(signed.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| "the store’s list isn’t signed by the store: not used".to_string())?;
    let index: Value = serde_json::from_str(text).map_err(|_| "the store’s list isn’t JSON".to_string())?;
    if json::int(index.get("format")) != Some(1) {
        return Err("the store’s list is of a format this Margin doesn’t read: update Margin".into());
    }
    let mut seen = std::collections::HashSet::new();
    let entries = index
        .get("themes")
        .and_then(Value::as_array)
        .map(|list| list.iter().take(MAX_ENTRIES).filter_map(entry).filter(|e| seen.insert(e.id.clone())).collect())
        .unwrap_or_default();
    Ok(entries)
}

/// Text as the index may hold it: `min..=max` characters, none of the ones a theme's texts may not hold (controls,
/// angle brackets, bidi and zero-width marks: ui/theme-schema.ts `text`).
fn plain(v: Option<&Value>, min: usize, max: usize) -> Option<String> {
    let s = json::string(v)?;
    let n = s.chars().count();
    ((min..=max).contains(&n) && !s.chars().any(unsafe_char)).then(|| s.to_string())
}

/// A character no text of a theme's may hold (ui/theme-schema.ts `text`): controls, angle brackets, bidi and
/// zero-width marks; and C1 controls.
fn unsafe_char(c: char) -> bool {
    let u = c as u32;
    c.is_control()
        || c == '<'
        || c == '>'
        || u == 0x061c
        || (0x200b..=0x200f).contains(&u)
        || (0x202a..=0x202e).contains(&u)
        || (0x2060..=0x2069).contains(&u)
        || u == 0xfeff
}

fn entry(v: &Value) -> Option<StoreEntry> {
    let id = json::string(v.get("id")).filter(|id| id_ok(id) && !BUILTINS.contains(id))?.to_string();
    let version = json::string(v.get("version")).filter(|s| version_parts(s).is_some())?.to_string();
    let hex_of =
        |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let sha256 = json::string(v.get("sha256")).filter(|s| hex_of(s, 64))?.to_string();
    let author_key = json::string(v.get("authorKey")).filter(|s| hex_of(s, 8))?.to_string();
    let size = v.get("size").and_then(Value::as_u64).filter(|&n| n > 0 && n <= MAX_ZIP_BYTES)?;
    Some(StoreEntry {
        id,
        name: plain(v.get("name"), 1, 60)?,
        description: plain(v.get("description"), 0, 280)?,
        version,
        author: plain(v.get("author"), 1, 40)?,
        author_key,
        sha256,
        size,
        updated: json::num(v.get("updated")).filter(|n| n.is_finite()).unwrap_or(0.0),
    })
}

/// A version's three numbers ("1.10.0" after "1.9.3"), or `None`: theme.json's `\d{1,4}\.\d{1,4}\.\d{1,4}`.
pub fn version_parts(v: &str) -> Option<(u16, u16, u16)> {
    let parts: Vec<&str> = v.split('.').collect();
    let num = |s: &str| (1..=4).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    if parts.len() != 3 || !parts.iter().all(|p| num(p)) {
        return None;
    }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?))
}

/// What a store theme is to this install, from the themes it has (`ThemeStore::shown`: each with `store` when it was
/// installed from the store):
/// - `install`: none with its id;
/// - `installed`: installed from the store, this version or a newer one;
/// - `update`: installed from the store, an older version;
/// - `yours`: a theme with its id that didn't come from the store (a copy, or linked): never replaced from here.
pub fn state_of(entry: &StoreEntry, installed: &[Object]) -> (&'static str, Option<String>) {
    let Some(have) = installed.iter().find(|e| json::string(e.get("id")) == Some(entry.id.as_str())) else {
        return ("install", None);
    };
    let Some(from_store) = json::object(have.get("store")) else { return ("yours", None) };
    let version = json::string(from_store.get("version")).unwrap_or("").to_string();
    let newer = matches!((version_parts(&entry.version), version_parts(&version)), (Some(a), Some(b)) if a > b);
    (if newer { "update" } else { "installed" }, Some(version))
}

/// The rows Settings' Themes shows: each entry with its state, newest first.
pub fn catalog(entries: &[StoreEntry], installed: &[Object]) -> Vec<Value> {
    let mut rows: Vec<&StoreEntry> = entries.iter().collect();
    rows.sort_by(|a, b| b.updated.total_cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    rows.into_iter()
        .map(|e| {
            let (state, have) = state_of(e, installed);
            json!({
                "id": e.id, "name": e.name, "description": e.description, "version": e.version,
                "author": e.author, "authorKey": e.author_key, "size": e.size, "state": state, "installedVersion": have,
            })
        })
        .collect()
}

/// Whether downloaded bytes are the index's package: its size, its SHA-256.
pub fn package_ok(bytes: &[u8], entry: &StoreEntry) -> bool {
    bytes.len() as u64 == entry.size && hex::encode(Sha256::digest(bytes)) == entry.sha256
}

// ---- sharing ----

/// A stored theme (`ThemeStore::message`'s JSON: `{ id, manifest, html, css, files: { path: base64 } }`) as the
/// `.margintheme` it's shared as, and its author's name (its theme.json's `author`): the three texts and its files,
/// stored (not deflated), sorted, dated 1 January 2026, so the same theme is the same bytes every time. Refused: no
/// author in its theme.json (the store shows one), a file that isn't base64, more files than a package holds.
pub fn share_zip(message: &str) -> Result<(Vec<u8>, String), String> {
    let v: Value = serde_json::from_str(message).map_err(|_| "it isn’t a stored theme".to_string())?;
    let manifest = json::string(v.get("manifest")).ok_or("it isn’t a stored theme")?;
    let html = json::string(v.get("html")).ok_or("it isn’t a stored theme")?;
    let css = json::string(v.get("css")).ok_or("it isn’t a stored theme")?;
    let files = json::object(v.get("files")).ok_or("it isn’t a stored theme")?;
    if files.len() > MAX_PACKAGE_FILES {
        return Err("it holds more files than a theme may".into());
    }
    let m: Value = serde_json::from_str(manifest).map_err(|_| "its theme.json isn’t JSON".to_string())?;
    let author = plain(m.get("author"), 1, 80)
        .map(|a| a.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|a| !a.is_empty() && a.chars().count() <= 40)
        .ok_or("add your name as its author in its theme.json (at most 40 characters) to share it")?;
    let mut entries: Vec<(String, Vec<u8>)> = vec![
        ("theme.json".into(), manifest.as_bytes().to_vec()),
        ("theme.html".into(), html.as_bytes().to_vec()),
        ("theme.css".into(), css.as_bytes().to_vec()),
    ];
    for (path, data) in files {
        let bytes =
            json::string(Some(data)).and_then(|s| BASE64.decode(s).ok()).ok_or("one of its files isn’t readable")?;
        entries.push((path.clone(), bytes));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let zip = zip_stored(&entries);
    if zip.len() as u64 > MAX_ZIP_BYTES {
        return Err("it’s larger than a shared theme may be".into());
    }
    Ok((zip, author))
}

/// Files as a zip, each stored: UTF-8 names, made on Unix as plain files (0644), dated 1 January 2026.
pub fn zip_stored(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    const DOS_DATE: u16 = ((2026 - 1980) << 9) | (1 << 5) | 1;
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let (size, nlen) = (data.len() as u32, name.len() as u16);
        // The local header.
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
        out.extend_from_slice(&0u16.to_le_bytes()); // stored
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&nlen.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        // Its directory entry.
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&((3u16 << 8) | 20).to_le_bytes()); // made on Unix
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&nlen.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
        central.extend_from_slice(&(0o100644u32 << 16).to_le_bytes()); // a plain file
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let (cd_offset, cd_size, count) = (out.len() as u32, central.len() as u32, entries.len() as u16);
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment
    out
}

/// CRC-32 (the zip's: reflected, 0xedb88320).
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

// ---- answers ----

/// What an answer means for a request (`kind`: `register`, `upload`, `report`, `index`, `package`, `challenge`):
/// `{ ok, data? }` for a 2xx with JSON (or the bytes, for a package); `{ register: true }` when the key must be
/// registered first (then the request is made again, signed anew); else `{ ok: false, message }` in words for the
/// person: the server's own (capped, controls removed), or Margin's for its status.
pub fn outcome(kind: &str, status: u16, body: &[u8]) -> Value {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let error = parsed.as_ref().and_then(|v| json::string(v.get("error"))).unwrap_or("");
    if (200..300).contains(&status) {
        if kind == "package" || kind == "index" {
            return json!({ "ok": true });
        }
        return match parsed {
            Some(v @ Value::Object(_)) => json!({ "ok": true, "data": v }),
            _ => json!({ "ok": false, "message": "The theme store answered with something Margin doesn’t read." }),
        };
    }
    if status == 401 && error == "unknown-key" && kind != "register" {
        return json!({ "ok": false, "register": true });
    }
    let theirs = parsed
        .as_ref()
        .and_then(|v| json::string(v.get("message")))
        .map(|m| m.chars().filter(|&c| !unsafe_char(c)).take(MAX_WORDS).collect::<String>())
        .filter(|m| !m.trim().is_empty());
    let message = theirs.unwrap_or_else(|| {
        match status {
            404 => "The theme store doesn’t have that (any more).",
            413 => "That theme is larger than the store takes.",
            429 => "Too many for now: try again later.",
            500..=599 => "The theme store isn’t working right now: try again later.",
            _ => "The theme store refused that.",
        }
        .to_string()
    });
    let mut out = json!({ "ok": false, "message": message, "status": status });
    if !error.is_empty() && error.len() <= 40 && error.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
        out["error"] = Value::from(error);
    }
    out
}

/// Whether the store is open for this run, and where (for the log: never a key).
pub fn describe(config: Option<&StoreConfig>) -> Value {
    match config {
        Some(c) => json!({ "open": true, "base": c.base }),
        None => json!({ "open": false }),
    }
}

#[cfg(test)]
#[path = "theme_store_tests.rs"]
mod tests;
