//! The themes a person imported (docs/phase6-themes.md §3; app/platforms/macos/shell/ThemeStore.swift), kept by the app for the whole
//! computer, not per profile: a theme is the person's look in every browser and profile. Under the root (macOS:
//! `~/Library/Application Support/Margin/themes/`; Windows: `%LOCALAPPDATA%\Margin\themes`):
//!
//! ```text
//! <id>.json    the stored package, as the overlay made it (ui/theme-loader.ts encodeStoredTheme: format 2, id,
//!              version, savedAt, manifest, html, css, files as base64)
//! index.json   the short list: [{ id, name, version, author, bytes, savedAt }]
//! ```
//!
//! Each written as the data sets' files are (a temporary file, flushed, the old one kept as `.bak`, a rename). The app
//! checks a value's shape, id and size; what's in it is checked by the overlay, in JS, every time it loads (the same
//! checks as any theme). A file of a later format, or one whose id isn't its name, is never used.
//!
//! And what the person chose to import (ShellThemes.swift `theme.import`, ThemeStore.swift `ThemeFileReader`): a
//! folder or a `.margintheme` file, read within caps before anything is read, into the `themeFile` push's body. The
//! file picker is the shell's.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

use super::store::{bak_of, write_atomically};
use super::{number, prefix, sorted_json};
use crate::json::{self, Object};

pub const FORMAT: i64 = 2;
/// ui/theme-loader.ts `PACKAGE_LIMITS.storedBytes` (4.5 MB).
pub const MAX_BYTES: usize = 4_718_592;
pub const MAX_THEMES: usize = 50;
/// A package's files, at most.
pub const MAX_PACKAGE_FILES: usize = 64;
/// extension/themes/packages.ts: an imported theme can't take one of these ids.
/// The built-ins' ids, and an earlier name of one that saved settings still mean it by (Neubrutalism's until
/// 2026-11-10: the extension's state/model.ts OLD_NAMES): an imported theme takes neither.
pub const BUILTINS: [&str; 4] = ["arcadia", "neubrutalism", "pixel", "neo-brutalism"];

/// ui/theme-schema.ts: a theme's id is 1–41 of a–z, 0–9 and `-`, starting with a letter or digit.
pub fn id_ok(id: &str) -> bool {
    let lower_digit = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (1..=41).contains(&id.len())
        && id.bytes().next().is_some_and(lower_digit)
        && id.bytes().all(|b| lower_digit(b) || b == b'-')
}

#[derive(Debug)]
pub enum ThemeError {
    /// Refused for its shape, id or size (the words go in `themeSaved`'s error).
    Refused(String),
    Io(io::Error),
}

impl std::fmt::Display for ThemeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ThemeError::Refused(why) => write!(f, "{why}"),
            ThemeError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ThemeError {}

impl From<io::Error> for ThemeError {
    fn from(e: io::Error) -> Self {
        ThemeError::Io(e)
    }
}

fn refused(why: impl Into<String>) -> ThemeError {
    ThemeError::Refused(why.into())
}

pub struct ThemeStore {
    root: PathBuf,
    /// A theme's message as read, by its entry's `savedAt`.
    cache: HashMap<String, (f64, String)>,
}

impl ThemeStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into(), cache: HashMap::new() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    /// Only for an id `id_ok` allows (so never a path).
    fn file_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }

    /// The index: entries with an id the rule allows, not a built-in's, once each. An index that isn't a list of
    /// objects is none.
    pub fn list(&self) -> Vec<Object> {
        let Some(Value::Array(raw)) = read_json(&self.index_path()) else { return Vec::new() };
        let Some(entries) = raw.into_iter().map(|e| e.as_object().cloned()).collect::<Option<Vec<Object>>>() else {
            return Vec::new();
        };
        let mut seen = std::collections::HashSet::new();
        entries
            .into_iter()
            .filter(|e| {
                json::string(e.get("id"))
                    .is_some_and(|id| id_ok(id) && !BUILTINS.contains(&id) && seen.insert(id.to_string()))
            })
            .collect()
    }

    pub fn has(&self, id: &str) -> bool {
        self.list().iter().any(|e| json::string(e.get("id")) == Some(id))
    }

    /// A value from the overlay (`theme.save`), checked for shape, id and size, then stored and listed. Its entry.
    /// `now`: milliseconds since 1970.
    pub fn save(&mut self, value: &Object, now: f64) -> Result<Object, ThemeError> {
        if json::int(value.get("format")) != Some(FORMAT) {
            return Err(refused(format!("not a stored theme of format {FORMAT}")));
        }
        let id = json::string(value.get("id")).filter(|id| id_ok(id)).ok_or_else(|| refused("a bad id"))?;
        if BUILTINS.contains(&id) {
            return Err(refused("a built-in theme's id"));
        }
        let manifest = json::string(value.get("manifest"));
        let files = json::object(value.get("files"));
        let shaped = manifest.is_some()
            && value.get("html").is_some_and(Value::is_string)
            && value.get("css").is_some_and(Value::is_string)
            && files.is_some_and(|f| f.values().all(Value::is_string) && f.len() <= MAX_PACKAGE_FILES);
        let Some(manifest) = manifest.filter(|_| shaped) else { return Err(refused("not a theme package")) };
        let m = match serde_json::from_str::<Value>(manifest) {
            Ok(Value::Object(m)) if json::string(m.get("id")) == Some(id) => m,
            _ => return Err(refused("its theme.json names another id")),
        };
        let mut stored = value.clone();
        stored.insert("savedAt".into(), number(now));
        let data = sorted_json(&Value::Object(stored));
        if data.len() > MAX_BYTES {
            return Err(refused(format!("larger than {MAX_BYTES} bytes")));
        }
        let text = |key: &str, cap: usize| prefix(json::string(m.get(key)).unwrap_or(""), cap);
        let entry = json!({
            "id": id, "name": text("name", 60), "version": text("version", 16), "author": text("author", 80),
            "bytes": data.len(), "savedAt": number(now),
        });
        let entry = entry.as_object().cloned().unwrap_or_default();
        let mut index: Vec<Object> =
            self.list().into_iter().filter(|e| json::string(e.get("id")) != Some(id)).collect();
        if index.len() >= MAX_THEMES {
            return Err(refused(format!("more than {MAX_THEMES} themes")));
        }
        index.push(entry.clone());
        write_atomically(&data, &self.file_path(id))?;
        self.write_index(&index)?;
        self.cache.remove(id);
        Ok(entry)
    }

    /// The theme message the overlay draws (`{ id, manifest, html, css, files }`, as JSON), or `None`: not listed,
    /// missing, of a later format, or naming another id.
    pub fn message(&mut self, id: &str) -> Option<String> {
        if !id_ok(id) {
            return None;
        }
        let entry = self.list().into_iter().find(|e| json::string(e.get("id")) == Some(id))?;
        let saved_at = json::num(entry.get("savedAt")).unwrap_or(0.0);
        if let Some((at, text)) = self.cache.get(id)
            && *at == saved_at
        {
            return Some(text.clone());
        }
        let Some(Value::Object(o)) = read_json(&self.file_path(id)) else { return None };
        if json::int(o.get("format")) != Some(FORMAT) || json::string(o.get("id")) != Some(id) {
            return None; // a later format: never read; another id: never used
        }
        let (manifest, html, css) =
            (json::string(o.get("manifest"))?, json::string(o.get("html"))?, json::string(o.get("css"))?);
        let files = json::object(o.get("files"))?;
        if !files.values().all(Value::is_string) {
            return None;
        }
        let text =
            serde_json::to_string(&json!({ "id": id, "manifest": manifest, "html": html, "css": css, "files": files }))
                .ok()?;
        self.cache.insert(id.to_string(), (saved_at, text.clone()));
        Some(text)
    }

    /// The theme's file and its entry gone. Whether it was there.
    pub fn remove(&mut self, id: &str) -> Result<bool, ThemeError> {
        if !id_ok(id) {
            return Ok(false);
        }
        let index = self.list();
        if !index.iter().any(|e| json::string(e.get("id")) == Some(id)) {
            return Ok(false);
        }
        let kept: Vec<Object> = index.into_iter().filter(|e| json::string(e.get("id")) != Some(id)).collect();
        self.write_index(&kept)?;
        let file = self.file_path(id);
        let _ = fs::remove_file(&file);
        let _ = fs::remove_file(bak_of(&file));
        self.cache.remove(id);
        Ok(true)
    }

    fn write_index(&self, index: &[Object]) -> Result<(), ThemeError> {
        let list = Value::Array(index.iter().cloned().map(Value::Object).collect());
        Ok(write_atomically(&sorted_json(&list), &self.index_path())?)
    }
}

/// A file's JSON, else its backup's.
fn read_json(path: &Path) -> Option<Value> {
    [path.to_path_buf(), bak_of(path)].iter().find_map(|p| serde_json::from_slice(&fs::read(p).ok()?).ok())
}

// ---- what the picker chose, read with caps before reading ----

/// ui/theme-import.ts `IMPORT_LIMITS.entries`.
pub const MAX_FILES: usize = 70;
/// Folders below the theme's own.
pub const MAX_DEPTH: usize = 2;
/// A font's cap, the largest of a package's (ui/theme-loader.ts `PACKAGE_LIMITS`).
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
pub const MAX_FOLDER_BYTES: u64 = 4 * 1024 * 1024;
/// ui/theme-import.ts `IMPORT_LIMITS.zipBytes`.
pub const MAX_ZIP_BYTES: u64 = 4 * 1024 * 1024;

/// What was read: the `themeFile` push's body (`{ type: 'themeFile', kind: 'folder', files: { path: base64 } }`,
/// `{ type: 'themeFile', kind: 'zip', zip: base64 }` or `{ type: 'themeFile', error }` in Margin's words), its kind
/// (`folder`, `zip`, `refused`) and the bytes read, for the log (which never says a name, a path or content).
#[derive(Clone, Debug, PartialEq)]
pub struct ThemeFile {
    pub message: Value,
    pub kind: &'static str,
    pub bytes: u64,
}

fn fail(why: &str) -> ThemeFile {
    ThemeFile { message: json!({ "type": "themeFile", "error": why }), kind: "refused", bytes: 0 }
}

/// What the picker chose (ShellThemes.swift `theme.import`): a folder, or a file named `.margintheme`; anything else
/// is refused before it's read.
pub fn read_chosen(path: &Path) -> ThemeFile {
    let margintheme = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("margintheme"));
    let folder = fs::symlink_metadata(path).is_ok_and(|m| m.is_dir());
    if !margintheme && !folder {
        return fail("That isn’t a theme’s folder or a .margintheme file.");
    }
    read_theme_file(path)
}

/// A folder or a file, read within the caps (ThemeStore.swift `ThemeFileReader.read`). A link chosen is refused,
/// never followed. On Windows a junction counts as a link too (Rust's `is_symlink` is true for both).
pub fn read_theme_file(path: &Path) -> ThemeFile {
    let Ok(meta) = fs::symlink_metadata(path) else { return fail("Margin couldn’t read what you chose.") };
    if meta.file_type().is_symlink() {
        return fail("That’s an alias or a link. Choose the theme’s folder or .margintheme file itself.");
    }
    if meta.is_dir() {
        return read_folder(path);
    }
    if !meta.is_file() {
        return fail("That isn’t a folder or a .margintheme file.");
    }
    if meta.len() > MAX_ZIP_BYTES {
        return fail("That file is larger than 4 MB, too large for a theme.");
    }
    match read_capped(path, MAX_ZIP_BYTES) {
        Some(data) => {
            let bytes = data.len() as u64;
            ThemeFile {
                message: json!({ "type": "themeFile", "kind": "zip", "zip": BASE64.encode(&data) }),
                kind: "zip",
                bytes,
            }
        }
        None => fail("Margin couldn’t read that file."),
    }
}

/// At most `cap` bytes of a file; `None` if it can't be read or holds more.
fn read_capped(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let mut data = Vec::new();
    File::open(path).ok()?.take(cap + 1).read_to_end(&mut data).ok()?;
    (data.len() as u64 <= cap).then_some(data)
}

/// The names that are never part of a theme and are left out: macOS's Finder's `.DS_Store` (Swift's), and Windows
/// Explorer's `Thumbs.db` and `desktop.ini`, its counterparts.
fn left_out(name: &str) -> bool {
    name == ".DS_Store" || name.eq_ignore_ascii_case("thumbs.db") || name.eq_ignore_ascii_case("desktop.ini")
}

fn read_folder(folder: &Path) -> ThemeFile {
    let Ok(base) = fs::canonicalize(folder) else { return fail("Margin couldn’t read that folder.") };
    let mut files: BTreeMap<String, Value> = BTreeMap::new();
    let mut total: u64 = 0;
    // Depth first, each folder's entries by name: (path, its path from the theme's folder, as parts).
    let mut stack: Vec<(PathBuf, Vec<String>)> = Vec::new();
    let Some(top) = children(folder, &[]) else { return fail("Margin couldn’t read that folder.") };
    stack.extend(top.into_iter().rev());
    while let Some((path, rel)) = stack.pop() {
        let name = rel.last().cloned().unwrap_or_default();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            return fail("Margin couldn’t read a file in that folder.");
        };
        // Inside the folder, by its own path (nothing that resolves elsewhere).
        if meta.file_type().is_symlink() {
            return fail("That folder holds an alias or a link. Themes can’t hold any.");
        }
        if !fs::canonicalize(&path).is_ok_and(|p| p.starts_with(&base) && p != base) {
            return fail("That folder holds a file from somewhere else.");
        }
        if left_out(&name) {
            continue;
        }
        if meta.is_dir() {
            if name.starts_with('.') {
                continue; // .git and the like: never part of a theme
            }
            if rel.len() > MAX_DEPTH + 1 {
                return fail("That folder is nested too deep for a theme.");
            }
            let Some(inside) = children(&path, &rel) else {
                return fail("Margin couldn’t read a file in that folder.");
            };
            stack.extend(inside.into_iter().rev());
            continue;
        }
        if !meta.is_file() {
            return fail("That folder holds something that isn’t a file.");
        }
        if name.starts_with('.') {
            continue;
        }
        if rel.len() > MAX_DEPTH + 1 {
            return fail("That folder is nested too deep for a theme.");
        }
        if files.len() >= MAX_FILES {
            return fail(&format!("That folder holds more than {MAX_FILES} files, too many for a theme."));
        }
        let size = meta.len();
        if size > MAX_FILE_BYTES || total + size > MAX_FOLDER_BYTES {
            return fail("That folder is too large for a theme.");
        }
        let Some(data) = read_capped(&path, size).filter(|d| d.len() as u64 == size) else {
            return fail("Margin couldn’t read a file in that folder.");
        };
        total += size;
        // Paths with `/`, whatever the OS's separator: the overlay's package paths.
        files.insert(rel.join("/"), Value::from(BASE64.encode(&data)));
    }
    ThemeFile {
        message: json!({ "type": "themeFile", "kind": "folder", "files": files.into_iter().collect::<Object>() }),
        kind: "folder",
        bytes: total,
    }
}

/// A folder's entries, sorted by name, each with its path from the theme's folder. `None` if it can't be listed or
/// holds a name that isn't Unicode.
fn children(dir: &Path, rel: &[String]) -> Option<Vec<(PathBuf, Vec<String>)>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name().into_string().ok()?;
        let mut r = rel.to_vec();
        r.push(name);
        out.push((entry.path(), r));
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::testing::temp;

    fn value(id: &str, name: &str, version: &str, manifest_id: Option<&str>) -> Object {
        let manifest =
            json!({ "format": 2, "id": manifest_id.unwrap_or(id), "name": name, "version": version, "author": "Me" })
                .to_string();
        json!({ "format": 2, "id": id, "version": version, "savedAt": 1, "manifest": manifest,
                "html": "<div><m-page></m-page></div>", "css": ".a{}", "files": { "LICENSE.txt": "aGk=" } })
        .as_object()
        .cloned()
        .unwrap_or_default()
    }

    fn with(mut v: Object, key: &str, x: Value) -> Object {
        v.insert(key.into(), x);
        v
    }

    fn ids(list: &[Object]) -> Vec<String> {
        list.iter().filter_map(|e| json::string(e.get("id")).map(str::to_string)).collect()
    }

    fn error(f: &ThemeFile) -> String {
        f.message.get("error").and_then(Value::as_str).unwrap_or("").to_string()
    }

    #[test]
    fn id_rule() {
        assert!(id_ok("mine") && id_ok("a") && id_ok("9-lives") && id_ok(&"a".repeat(41)));
        assert!(
            !id_ok("") && !id_ok(&"a".repeat(42)) && !id_ok("-x") && !id_ok("Mine") && !id_ok("../evil") && !id_ok("é")
        );
    }

    #[test]
    fn the_store() {
        let tmp = temp();
        let root = tmp.path().join("themes");
        let mut store = ThemeStore::new(&root);
        let refuse = |store: &mut ThemeStore, v: Object| store.save(&v, 1.0).err().map(|e| e.to_string());

        // ---- storing ----
        assert!(store.list().is_empty() && store.message("mine").is_none(), "nothing listed at first");
        let entry = store.save(&value("mine", "Mine", "1.0.0", None), 42.0).expect("stored");
        assert!(
            entry["id"] == "mine" && entry["name"] == "Mine" && entry["version"] == "1.0.0" && entry["author"] == "Me"
        );
        assert!(entry["savedAt"] == 42 && entry["bytes"].as_u64().is_some_and(|b| b > 0));
        assert!(ids(&store.list()) == ["mine"] && store.has("mine"), "listed");
        let msg: Value = serde_json::from_str(&store.message("mine").expect("a message")).expect("JSON");
        assert!(msg["id"] == "mine" && msg["files"]["LICENSE.txt"] == "aGk=");
        let mut keys: Vec<&String> = msg.as_object().map(|o| o.keys().collect()).unwrap_or_default();
        keys.sort();
        assert_eq!(keys, ["css", "files", "html", "id", "manifest"], "nothing else in it");
        assert!(root.join("mine.json").exists() && root.join("index.json").exists());
        store.save(&value("mine", "Mine again", "1.1.0", None), 43.0).expect("stored");
        let list = store.list();
        assert!(list.len() == 1 && list[0]["version"] == "1.1.0", "the same id again replaces it");
        assert!(store.message("mine").is_some_and(|m| m.contains("Mine again")), "not the cached one");
        store.save(&value("other", "Other", "1", None), 44.0).expect("stored");
        assert_eq!(ids(&store.list()), ["mine", "other"], "another, listed after it");
        let long = value("long", &"n".repeat(100), &"v".repeat(30), None);
        let e = store.save(&long, 45.0).expect("stored");
        assert!(
            e["name"].as_str().map(str::len) == Some(60) && e["version"].as_str().map(str::len) == Some(16),
            "60 and 16 at most"
        );
        store.remove("long").expect("removed");

        // ---- refused ----
        assert!(refuse(&mut store, value("arcadia", "A", "1", None)).is_some_and(|e| e.contains("built-in")));
        for bad in ["../evil", "Mine", ""] {
            assert!(refuse(&mut store, value(bad, "A", "1", None)).is_some(), "a bad id: {bad}");
        }
        assert!(refuse(&mut store, value(&"a".repeat(42), "A", "1", None)).is_some());
        assert!(refuse(&mut store, value("mine", "A", "1", Some("arcadia"))).is_some_and(|e| e.contains("another id")));
        assert!(
            refuse(&mut store, with(value("mine", "A", "1", None), "format", json!(3))).is_some(),
            "another format"
        );
        assert!(
            refuse(&mut store, with(value("mine", "A", "1", None), "files", json!({ "a.png": 5 }))).is_some(),
            "not a package"
        );
        assert!(
            refuse(&mut store, json!({ "format": 2, "id": "x" }).as_object().cloned().unwrap_or_default()).is_some()
        );
        let many: Object = (0..65).map(|n| (format!("f{n}"), json!("x"))).collect();
        assert!(
            refuse(&mut store, with(value("mine", "A", "1", None), "files", Value::Object(many))).is_some(),
            "more than 64 files"
        );
        let big = with(value("big", "A", "1", None), "css", json!("x".repeat(MAX_BYTES)));
        assert!(refuse(&mut store, big).is_some_and(|e| e.contains("larger")), "over 4.5 MB");
        assert_eq!(store.list().len(), 2, "nothing refused was listed");
        assert!(!root.join("big.json").exists());

        // ---- tampered with on disk ----
        let file = root.join("other.json");
        let mut stored: Object = serde_json::from_slice(&fs::read(&file).expect("read")).expect("JSON");
        stored.insert("format".into(), json!(3));
        fs::write(&file, Value::Object(stored.clone()).to_string()).expect("written");
        let _ = fs::remove_file(bak_of(&file));
        let mut fresh = ThemeStore::new(&root);
        assert!(fresh.message("other").is_none(), "a stored file of a later format never used");
        stored.insert("format".into(), json!(2));
        stored.insert("id".into(), json!("mine"));
        fs::write(&file, Value::Object(stored).to_string()).expect("written");
        assert!(fresh.message("other").is_none(), "a stored file whose id isn't its name never used");
        fs::write(root.join("index.json"), r#"[{"id":"arcadia"},{"id":"../x"},{"id":"mine"},{"id":"mine"}]"#)
            .expect("written");
        assert_eq!(ids(&fresh.list()), ["mine"], "an index edited by hand: built-ins, bad ids and repeats left out");
        assert!(fresh.message("other").is_none(), "a theme not in the index isn't drawn");
        fs::write(root.join("index.json"), r#"[{"id":"mine"}, 5]"#).expect("written");
        assert!(fresh.list().is_empty(), "an index that isn't all objects: none");
        fs::write(root.join("index.json"), r#"[{"id":"mine","savedAt":43}]"#).expect("written");

        // ---- removed ----
        assert!(fresh.remove("mine").expect("removed") && fresh.list().is_empty() && fresh.message("mine").is_none());
        assert!(!root.join("mine.json").exists() && !bak_of(&root.join("mine.json")).exists());
        assert!(!fresh.remove("mine").expect("nothing") && !fresh.remove("../index").expect("nothing"));
    }

    #[test]
    fn at_most_fifty() {
        let tmp = temp();
        let mut store = ThemeStore::new(tmp.path());
        for n in 0..MAX_THEMES {
            store.save(&value(&format!("t{n}"), "T", "1", None), 1.0).expect("stored");
        }
        assert!(
            store.save(&value("one-more", "T", "1", None), 1.0).is_err_and(|e| e.to_string().contains("more than 50"))
        );
        assert!(store.save(&value("t3", "T again", "2", None), 2.0).is_ok(), "replacing one is fine");
    }

    #[test]
    fn what_the_picker_chose() {
        let tmp = temp();
        let folder = tmp.path().join("My Theme");
        fs::create_dir_all(folder.join("fonts")).expect("made");
        for (name, text) in [
            ("theme.json", "{}"),
            ("theme.html", "<div></div>"),
            ("theme.css", ""),
            ("fonts/OFL.txt", "licence"),
            (".DS_Store", "x"),
            ("Thumbs.db", "x"),
            (".hidden", "x"),
        ] {
            fs::write(folder.join(name), text).expect("written");
        }
        fs::create_dir_all(folder.join(".git")).expect("made");
        fs::write(folder.join(".git/config"), "[core]").expect("written");
        let read = read_theme_file(&folder);
        let files = read.message["files"].as_object().cloned().unwrap_or_default();
        let mut names: Vec<&String> = files.keys().collect();
        names.sort();
        assert_eq!(read.kind, "folder");
        assert_eq!(
            names,
            ["fonts/OFL.txt", "theme.css", "theme.html", "theme.json"],
            ".DS_Store, Thumbs.db, hidden files and .git left out"
        );
        assert_eq!(files["theme.html"], BASE64.encode("<div></div>"));
        assert_eq!(read.bytes, 2 + 11 + 7);
        assert_eq!(read_chosen(&folder).kind, "folder", "a folder chosen");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", folder.join("hosts.txt")).expect("linked");
            let read = read_theme_file(&folder);
            assert!(read.kind == "refused" && error(&read).contains("link"), "a folder with a link in it refused");
            fs::remove_file(folder.join("hosts.txt")).expect("removed");
        }
        fs::create_dir_all(folder.join("images/a/b")).expect("made");
        let read = read_theme_file(&folder);
        assert_eq!(read.kind, "folder", "a folder two below the theme's, empty: fine");
        fs::write(folder.join("images/a/b/deep.png"), "x").expect("written");
        let read = read_theme_file(&folder);
        assert!(read.kind == "refused" && error(&read).contains("deep"), "a file nested too deep refused");
        fs::remove_file(folder.join("images/a/b/deep.png")).expect("removed");
        fs::write(folder.join("images/a/ok.png"), "x").expect("written");
        assert_eq!(read_theme_file(&folder).kind, "folder", "a file two folders deep: fine");
        fs::create_dir_all(folder.join("images/a/b/c")).expect("made");
        assert!(error(&read_theme_file(&folder)).contains("deep"), "a folder three below: too deep");
        fs::remove_dir_all(folder.join("images")).expect("removed");
        fs::write(folder.join("fonts/big.woff2"), vec![0u8; MAX_FILE_BYTES as usize + 1]).expect("written");
        let read = read_theme_file(&folder);
        assert!(read.kind == "refused" && error(&read).contains("too large"), "a file over the cap refused");
        fs::remove_file(folder.join("fonts/big.woff2")).expect("removed");
        for n in 0..9 {
            fs::write(folder.join(format!("fonts/f{n}.woff2")), vec![0u8; MAX_FILE_BYTES as usize]).expect("written");
        }
        assert!(error(&read_theme_file(&folder)).contains("too large"), "over 4 MB in all refused");
        for n in 0..9 {
            fs::remove_file(folder.join(format!("fonts/f{n}.woff2"))).expect("removed");
        }
        for n in 0..67 {
            fs::write(folder.join(format!("f{n:02}.txt")), "x").expect("written");
        }
        assert!(error(&read_theme_file(&folder)).contains("more than 70 files"), "71 files refused");
        fs::remove_file(folder.join("f00.txt")).expect("removed");
        assert_eq!(read_theme_file(&folder).kind, "folder", "70 files: fine");

        let zip = tmp.path().join("mine.margintheme");
        let bytes = [&[0x50u8, 0x4b, 0x05, 0x06][..], &[0u8; 18]].concat();
        fs::write(&zip, &bytes).expect("written");
        let read = read_chosen(&zip);
        assert!(
            read.kind == "zip" && read.message["zip"] == BASE64.encode(&bytes) && read.bytes == 22,
            "a .margintheme read as bytes"
        );
        fs::write(&zip, vec![0u8; MAX_ZIP_BYTES as usize + 1]).expect("written");
        assert_eq!(read_theme_file(&zip).kind, "refused", "a file over 4 MB refused");
        fs::write(&zip, vec![0u8; MAX_ZIP_BYTES as usize]).expect("written");
        assert_eq!(read_theme_file(&zip).kind, "zip", "4 MB exactly: fine");
        let other = tmp.path().join("theme.zip");
        fs::write(&other, "x").expect("written");
        assert!(error(&read_chosen(&other)).contains("isn’t a theme’s folder"), "another file chosen: refused");
        assert!(error(&read_theme_file(&tmp.path().join("gone"))).contains("couldn’t read"));
        #[cfg(unix)]
        {
            let alias = tmp.path().join("alias.margintheme");
            std::os::unix::fs::symlink(&zip, &alias).expect("linked");
            assert!(error(&read_chosen(&alias)).contains("link"), "a link chosen refused");
        }
    }
}
