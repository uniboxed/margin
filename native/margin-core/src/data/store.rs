//! Margin's files for the lasting data (DATA.md "The app's files"; app/shell/DataStore.swift): one data set per
//! browser and profile, one file per collection, so a change to a space doesn't rewrite every site icon. Under
//! the root (macOS: `~/Library/Application Support/Margin/data`; Windows: `%LOCALAPPDATA%\Margin\data`):
//!
//! ```text
//! <browser>/<profile>/set.json                 { format, browser, profile, acked, rev, savedAt }
//! <browser>/<profile>/items/<collection>.json  { format, collection, items }
//! ```
//!
//! Each file is written whole to a temporary file beside it (flushed to the disk), the version it replaces is
//! kept as `<file>.bak` (a hard link, so the file itself is never missing), and the new one is renamed over it.
//! `set.json` is written last: a profile without one has no data set. Reading takes a file's backup when the file
//! can't be read, and removes temporary files a crash left. The names on disk are the browser's and profile's
//! with everything but a–z, 0–9, `_` and `-` written as `%XX` (so no name can be `..`, and two that differ only
//! in case don't meet on a case-insensitive disk, as NTFS and APFS both are); Margin's own collections keep their
//! names, any other is written out the same way after `x-`. The real names are inside the files.
//!
//! The Swift store writes on a queue of its own and calls back; this one writes at once, in the caller's thread
//! (the Swift unit tests' `background: false`): `save` returns once it's all on disk. Run the data on a thread
//! of its own if a write mustn't hold anything up.
//!
//! On Windows: `std::fs::rename` over an existing file replaces it (MoveFileExW with REPLACE_EXISTING), and
//! `hard_link` works on NTFS (where it doesn't, the backup is a copy). A folder can't be flushed there
//! (`FlushFileBuffers` needs a file handle), so the renames' lasting is NTFS's journal's; the folders are
//! flushed on unix only.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::set::{DataSet, FORMAT, TOMBSTONE_CAP, TOMBSTONE_MS};
use super::{Note, number, random_hex, sorted_json};
use crate::json::{self, Object};

/// A browser profile's data set, known by its browser and profile ids. Sorted by `browser:profile`, as Swift.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DataProfile {
    pub browser: String,
    pub profile: String,
}

impl DataProfile {
    pub fn new(browser: impl Into<String>, profile: impl Into<String>) -> Self {
        Self { browser: browser.into(), profile: profile.into() }
    }
    pub fn key(&self) -> String {
        format!("{}:{}", self.browser, self.profile)
    }
}

impl Ord for DataProfile {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.key().cmp(&other.key())
    }
}

impl PartialOrd for DataProfile {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl std::fmt::Display for DataProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.browser, self.profile)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub set: DataSet,
    /// The newest `updatedAt` of the extension's changes the app has confirmed (`data.ack`) to this profile.
    pub acked: f64,
    /// The set's revision: new at every save that changes it (its number, then random hex, so a set restored from
    /// a backup or another computer's never has a rev a copy knows for something else). `save` sets it.
    pub rev: String,
}

impl Stored {
    pub fn new(set: DataSet, acked: f64) -> Self {
        Self { set, acked, rev: String::new() }
    }
}

#[derive(Debug)]
pub enum SaveError {
    /// The profile's files are of a later format: never written over.
    LaterFormat,
    /// A test's crash: the store stopped as the app would if it died (nothing more written or said).
    Crashed,
    Io(io::Error),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::LaterFormat => write!(f, "its data is of a later format"),
            SaveError::Crashed => write!(f, "the store stopped mid-write"),
            SaveError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SaveError {}

impl From<io::Error> for SaveError {
    fn from(e: io::Error) -> Self {
        SaveError::Io(e)
    }
}

/// Margin's own collections (DATA.md), which differ in more than case, keep their names on disk.
pub const KNOWN_COLLECTIONS: [&str; 9] =
    ["spaces", "pins", "folders", "tabs", "archive", "settings", "themeSettings", "siteIcons", "userThemes"];

pub struct DataStore {
    root: PathBuf,
    /// Milliseconds since 1970 (the tombstones' age, `savedAt`, an archived folder's name).
    pub now: Box<dyn Fn() -> f64 + Send>,
    /// A test's crash: the number of files written before the store stops as the app would if it died (the next
    /// file left as a temporary file, nothing more written or said).
    pub crash_after_writes: Option<usize>,
    crashed: bool,
    /// Files read from their backup, and temporary files removed (tests, the log).
    recovered: Vec<String>,
    removed_temps: usize,
    writes: usize,
    scheduled: usize,
    cache: HashMap<DataProfile, Stored>,
    /// A later format's: read nothing, write nothing.
    unusable: HashSet<DataProfile>,
    log: Vec<Note>,
}

impl DataStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            now: Box::new(crate::time::now_ms),
            crash_after_writes: None,
            crashed: false,
            recovered: Vec::new(),
            removed_temps: 0,
            writes: 0,
            scheduled: 0,
            cache: HashMap::new(),
            unusable: HashSet::new(),
            log: Vec::new(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn crashed(&self) -> bool {
        self.crashed
    }
    pub fn recovered(&self) -> &[String] {
        &self.recovered
    }
    pub fn removed_temps(&self) -> usize {
        self.removed_temps
    }
    pub fn writes(&self) -> usize {
        self.writes
    }
    /// What the store would have logged since the last call.
    pub fn take_log(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.log)
    }

    /// The next revision after `rev`: its number plus one, a dash, 5 random bytes as hex (`12-3f9a0c1b7e`).
    pub fn next_rev(rev: Option<&str>) -> String {
        let n = rev.and_then(|r| r.split('-').next()).and_then(|n| n.parse::<i64>().ok()).unwrap_or(0);
        format!("{}-{}", n.saturating_add(1), random_hex(5))
    }

    // ---- names ----

    /// A name as it's written on disk: a–z, 0–9, `_` and `-` as they are, every other byte of its UTF-8 as `%XX`.
    /// A long name (a later format's collection), or an empty one: `~` and its SHA-256.
    pub fn file_name(name: &str) -> String {
        let mut out = String::new();
        for b in name.bytes() {
            match b {
                b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' => out.push(b as char),
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        if out.is_empty() || out.len() > 200 {
            return format!("~{}", hex::encode(Sha256::digest(name.as_bytes())));
        }
        out
    }

    pub fn collection_file_name(name: &str) -> String {
        if KNOWN_COLLECTIONS.contains(&name) { name.to_string() } else { format!("x-{}", Self::file_name(name)) }
    }

    pub fn directory(&self, p: &DataProfile) -> PathBuf {
        self.root.join(Self::file_name(&p.browser)).join(Self::file_name(&p.profile))
    }

    // ---- reading ----

    /// The profile's data set, or `None` if it has none (never linked, or the first set's write didn't finish)
    /// or it's a later format's.
    pub fn load(&mut self, p: &DataProfile) -> Option<&Stored> {
        if !self.cache.contains_key(p) {
            let stored = self.read(p)?;
            self.cache.insert(p.clone(), stored);
        }
        self.cache.get(p)
    }

    fn read(&mut self, p: &DataProfile) -> Option<Stored> {
        if self.unusable.contains(p) {
            return None;
        }
        let dir = self.directory(p);
        let items = dir.join("items");
        self.remove_temps(&dir);
        self.remove_temps(&items);
        let manifest = self.read_object(&dir.join("set.json"))?;
        if json::int(manifest.get("format")) != Some(FORMAT) {
            self.unusable.insert(p.clone());
            self.log
                .push(Note::warn(format!("{p}: its data is of format {}: left alone", shown(manifest.get("format")))));
            return None;
        }
        let mut collections = Object::new();
        let mut files = BTreeSet::new();
        for name in list_names(&items) {
            if name.ends_with(".json") {
                files.insert(name);
            } else if let Some(file) = name.strip_suffix(".bak").filter(|n| n.ends_with(".json")) {
                files.insert(file.to_string()); // a backup whose file is gone
            }
        }
        for name in files {
            let Some(o) = self.read_object(&items.join(&name)) else { continue };
            if json::int(o.get("format")) != Some(FORMAT) {
                self.unusable.insert(p.clone());
                self.log.push(Note::warn(format!(
                    "{p}: {name} is of format {}: the profile's data left alone",
                    shown(o.get("format"))
                )));
                return None;
            }
            let (Some(collection), Some(list)) = (json::string(o.get("collection")), json::object(o.get("items")))
            else {
                continue;
            };
            collections.insert(collection.to_string(), Value::Object(list.clone()));
        }
        // A set.json with no rev (none before the revisions) gets one no copy knows.
        let rev = json::string(manifest.get("rev")).map_or_else(|| Self::next_rev(None), str::to_string);
        let stored = Stored {
            set: DataSet::from_items(&collections),
            acked: json::num(manifest.get("acked")).unwrap_or(0.0),
            rev,
        };
        self.log.push(Note::note(format!("{p}: data read ({} collections)", collections.len())));
        Some(stored)
    }

    /// A file's object, else its backup's (noted in `recovered`).
    fn read_object(&mut self, path: &Path) -> Option<Object> {
        if let Some(o) = object_at(path) {
            return Some(o);
        }
        let o = object_at(&bak_of(path))?;
        let name = file_name_of(path);
        self.log.push(Note::warn(format!("{name} couldn't be read: its backup taken")));
        self.recovered.push(name);
        Some(o)
    }

    fn remove_temps(&mut self, dir: &Path) {
        for name in list_names(dir) {
            if name.ends_with(".tmp") && fs::remove_file(dir.join(&name)).is_ok() {
                self.removed_temps += 1;
            }
        }
    }

    /// Every profile with a data set, of one browser or all, by its real ids.
    pub fn profiles(&self, browser: Option<&str>) -> Vec<DataProfile> {
        let mut out: BTreeSet<DataProfile> =
            self.cache.keys().filter(|p| browser.is_none_or(|b| p.browser == b)).cloned().collect();
        let browsers = match browser {
            Some(b) => vec![Self::file_name(b)],
            None => list_names(&self.root),
        };
        for b in browsers {
            let dir = self.root.join(b);
            for name in list_names(&dir) {
                let set = dir.join(name).join("set.json");
                let Some(o) = object_at(&set).or_else(|| object_at(&bak_of(&set))) else { continue };
                if let (Some(br), Some(pr)) = (json::string(o.get("browser")), json::string(o.get("profile"))) {
                    out.insert(DataProfile::new(br, pr));
                }
            }
        }
        out.into_iter().collect()
    }

    // ---- writing ----

    /// The profile's set and acked as they are now: in memory at once, then the files of the `changed`
    /// collections (`None`: all) and `set.json`. Tombstones past their time (60 days, 2,000 a collection) go
    /// first. A save that changes anything gives the set a new `rev` (`stored.rev` is ignored), written to
    /// `set.json` before the collections too (with the acked from before), so a crash between them never leaves
    /// new items under the rev a copy has. The rev written, once it's all on disk; an error if a write failed
    /// (the memory is dropped: it's read again from the files).
    pub fn save(
        &mut self,
        p: &DataProfile,
        stored: Stored,
        changed: Option<&BTreeSet<String>>,
    ) -> Result<String, SaveError> {
        if self.crashed {
            return Err(SaveError::Crashed); // a dead app says nothing
        }
        if self.unusable.contains(p) {
            return Err(SaveError::LaterFormat);
        }
        let mut stored = stored;
        let before = self.load(p).map(|b| (b.rev.clone(), b.acked));
        if self.unusable.contains(p) {
            return Err(SaveError::LaterFormat); // found so by that read
        }
        let pruned = stored.set.prune_tombstones((self.now)() - TOMBSTONE_MS, TOMBSTONE_CAP);
        let collections: BTreeSet<String> = match changed {
            Some(c) => c.union(&pruned).cloned().collect(),
            None => stored.set.items.keys().cloned().collect(),
        };
        let bumped = before.is_none() || !collections.is_empty();
        stored.rev = match &before {
            Some((rev, _)) if !bumped => rev.clone(),
            _ => Self::next_rev(before.as_ref().map(|b| b.0.as_str())),
        };
        let dir = self.directory(p);
        let items = dir.join("items");
        let now = (self.now)();
        let manifest = |acked: f64| {
            sorted_json(&json!({
                "format": FORMAT, "browser": p.browser, "profile": p.profile,
                "acked": number(acked), "rev": stored.rev, "savedAt": number(now),
            }))
        };
        let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
        // The new rev first (not for a first set: without set.json, a profile has none).
        if let Some((_, acked)) = before.filter(|_| bumped) {
            files.push((dir.join("set.json"), manifest(acked)));
        }
        for collection in &collections {
            let list = stored.set.items.get(collection).map(DataSet::list_json).unwrap_or_else(|| json!({}));
            let body = json!({ "format": FORMAT, "collection": collection, "items": list });
            files.push((items.join(format!("{}.json", Self::collection_file_name(collection))), sorted_json(&body)));
        }
        files.push((dir.join("set.json"), manifest(stored.acked)));
        let rev = stored.rev.clone();
        self.cache.insert(p.clone(), stored);
        let allowed = self.crash_after_writes.map(|n| n.saturating_sub(self.scheduled));
        self.scheduled += files.len();
        let mut written = 0;
        let result = write_all(&files, &[&items, &dir], allowed, &mut written);
        self.writes += written;
        match result {
            Ok(true) => Ok(rev),
            Ok(false) => {
                self.crashed = true;
                self.log.push(Note::warn(format!("{p}: the store stopped mid-write (a test's crash)")));
                Err(SaveError::Crashed)
            }
            Err(e) => {
                self.log.push(Note::warn(format!("{p}: data not saved: {e}")));
                self.cache.remove(p);
                Err(SaveError::Io(e))
            }
        }
    }

    /// The memory dropped: the next load reads the files.
    pub fn forget(&mut self, p: &DataProfile) {
        self.cache.remove(p);
    }

    /// A profile's set put away, whole and as it was (carried to another id: `DataSync::carry`): its folder
    /// renamed to `<browser>/.archived/<profile>-<ms>`, where `profiles` never looks, so the profile has no set
    /// any more. Nothing is deleted. Where it went, or `None` if it had no folder or the rename failed.
    pub fn archive(&mut self, p: &DataProfile) -> Option<PathBuf> {
        let dir = self.directory(p);
        if !dir.exists() {
            return None;
        }
        let into = self.root.join(Self::file_name(&p.browser)).join(".archived");
        let to = into.join(format!("{}-{}", Self::file_name(&p.profile), (self.now)() as i64));
        if let Err(e) = fs::create_dir_all(&into).and_then(|_| fs::rename(&dir, &to)) {
            self.log.push(Note::warn(format!("{p}: its data set not put away: {e}")));
            return None;
        }
        self.cache.remove(p);
        Some(to)
    }
}

/// One small file written the same way (a temporary file, flushed, `.bak`, rename), at once: `browser.json`, the
/// themes' files.
pub fn write_atomically(data: &[u8], path: &Path) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no folder"))?;
    fs::create_dir_all(dir)?;
    write_file(data, path, true)?;
    sync_directory(dir);
    Ok(())
}

/// The files in order, each whole or not at all. `Ok(false)`: a test's crash stopped it (the next file left as a
/// temporary file).
fn write_all(
    files: &[(PathBuf, Vec<u8>)],
    dirs: &[&Path],
    allowed: Option<usize>,
    written: &mut usize,
) -> io::Result<bool> {
    for dir in dirs {
        fs::create_dir_all(dir)?;
    }
    for (path, data) in files {
        if allowed.is_some_and(|a| *written >= a) {
            let _ = write_file(data, path, false); // the crash: a temporary file left, the file as it was
            return Ok(false);
        }
        write_file(data, path, true)?;
        *written += 1;
    }
    for dir in dirs {
        sync_directory(dir);
    }
    Ok(true)
}

/// `data` to `.<name>.<random>.tmp` beside `path`, flushed; then (with `replace`) the file it replaces linked as
/// `<name>.bak` and the temporary file renamed over it.
fn write_file(data: &[u8], path: &Path, replace: bool) -> io::Result<()> {
    let name = file_name_of(path);
    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no folder"))?;
    let tmp = dir.join(format!(".{name}.{}.tmp", random_hex(4)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&tmp).map_err(|e| context(&name, "open", e))?;
    if let Err(e) = file.write_all(data).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&tmp);
        return Err(context(&name, "write", e));
    }
    drop(file);
    if !replace {
        return Ok(());
    }
    // The version it replaces, kept: a hard link (the file stays where it is throughout), else a copy.
    if path.exists() {
        let bak = bak_of(path);
        let bak_tmp = PathBuf::from(format!("{}.tmp", bak.display()));
        let _ = fs::remove_file(&bak_tmp);
        if fs::hard_link(path, &bak_tmp).is_ok() || fs::copy(path, &bak_tmp).is_ok() {
            let _ = fs::rename(&bak_tmp, &bak);
        }
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(context(&name, "rename", e));
    }
    Ok(())
}

fn context(name: &str, what: &str, e: io::Error) -> io::Error {
    io::Error::new(e.kind(), format!("{name}: {what}: {e}"))
}

/// The renames made lasting (unix only: Windows can't open a folder as a file to flush it).
fn sync_directory(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

pub(crate) fn bak_of(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.bak", path.display()))
}

fn file_name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// A file's JSON object, if it reads and is one.
pub(crate) fn object_at(path: &Path) -> Option<Object> {
    let data = fs::read(path).ok()?;
    match serde_json::from_slice(&data).ok()? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}

/// The names in a folder (none if it can't be read), names that aren't Unicode left out (Margin writes none).
fn list_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect()
}

fn shown(v: Option<&Value>) -> String {
    v.map_or_else(|| "?".to_string(), Value::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::set::{DataChange, DataItem};
    use crate::data::testing::{same, temp};

    pub(crate) fn test_store(root: &Path) -> DataStore {
        let mut s = DataStore::new(root);
        s.now = Box::new(|| 1000.0); // the tests' times are small: no tombstone is old
        s
    }

    fn space(name: &str) -> Value {
        json!({ "name": name, "emoji": "", "color": "#000", "order": 0 })
    }

    fn change(c: &str, id: &str, at: f64, value: Option<Value>) -> DataChange {
        DataChange::new(c, id, value.map_or_else(|| DataItem::tombstone(at), |v| DataItem::live(at, v)))
    }

    fn set_of(changes: &[DataChange]) -> DataSet {
        let mut set = DataSet::new();
        set.merge(changes);
        set
    }

    fn name_of(store: &mut DataStore, p: &DataProfile, c: &str, id: &str) -> Option<String> {
        store.load(p)?.set.live_values(c).get(id)?.get("name")?.as_str().map(str::to_string)
    }

    #[test]
    fn names_on_disk() {
        assert_eq!(DataStore::file_name(".."), "%2E%2E");
        assert_eq!(DataStore::file_name("Ab:c.d"), "%41b%3Ac%2Ed");
        assert_eq!(DataStore::file_name("p-1_x"), "p-1_x");
        assert_eq!(DataStore::file_name("P1"), "%501");
        let long = DataStore::file_name(&"é".repeat(100));
        assert!(long.starts_with('~') && long.len() == 65, "a long name: its hash");
        assert!(DataStore::file_name("").starts_with('~'), "an empty name: its hash");
        assert_eq!(DataStore::collection_file_name("themeSettings"), "themeSettings");
        assert_eq!(DataStore::collection_file_name("Spaces"), "x-%53paces");
        assert_eq!(DataStore::collection_file_name("laterThing"), "x-later%54hing");
    }

    #[test]
    fn revisions() {
        assert_ne!(DataStore::next_rev(Some("4-aa")), DataStore::next_rev(Some("4-aa")), "random after the number");
        assert!(DataStore::next_rev(Some("4-aa")).starts_with("5-"));
        assert!(DataStore::next_rev(None).starts_with("1-"));
        assert!(DataStore::next_rev(Some("junk")).starts_with("1-"));
        assert_eq!(DataStore::next_rev(None).len(), 12, "1- and 10 hex");
    }

    #[test]
    fn the_vectors_through_the_files() {
        let root = temp();
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/data-merge");
        for entry in fs::read_dir(&dir).expect("vectors") {
            let name = entry.expect("an entry").file_name().into_string().expect("a name");
            if !name.ends_with(".json") {
                continue;
            }
            let v: Value = serde_json::from_slice(&fs::read(dir.join(&name)).expect("a vector")).expect("JSON");
            let got = DataSet::merge_json(v.get("base").filter(|b| !b.is_null()), v.get("changes"));
            let p = DataProfile::new("safari", name.as_str());
            let mut store = DataStore::new(root.path());
            store.now = Box::new(|| 0.0);
            store.save(&p, Stored::new(got, 0.0), None).expect("saved");
            let back = DataStore::new(root.path()).load(&p).map(|s| s.set.to_json());
            assert!(back.is_some_and(|b| same(&b, &v["expected"])), "vector {name} through the files");
        }
    }

    #[test]
    fn files_backups_crashes_formats() {
        let root = temp();
        let root = root.path();
        let p1 = DataProfile::new("safari", "P1");
        let mut store = test_store(root);
        assert!(store.load(&p1).is_none(), "no data set for a profile never linked");
        let mut set = set_of(&[
            change("spaces", "a", 10.0, Some(space("A"))),
            change("pins", "p", 11.0, Some(json!({ "url": "https://p.test/" }))),
            change("pins", "gone", 12.0, None),
        ]);
        assert!(store.save(&p1, Stored::new(set.clone(), 12.0), None).is_ok());
        let dir = store.directory(&p1);
        assert!(
            dir.join("set.json").exists()
                && dir.join("items/spaces.json").exists()
                && dir.join("items/pins.json").exists()
        );
        assert!(dir.starts_with(root.join("safari")), "inside the root");
        assert!(dir.ends_with("safari/%501"));
        let again = test_store(root).load(&p1).cloned().expect("read back");
        assert!(
            same(&again.set.to_json(), &set.to_json()) && again.acked == 12.0,
            "a relaunch: the same set and acked"
        );

        // A change to one collection: the version before kept as its backup, the others left alone.
        let spaces_file = dir.join("items/spaces.json");
        let before = fs::read(&spaces_file).expect("spaces");
        let pins_before = fs::metadata(dir.join("items/pins.json")).and_then(|m| m.modified()).ok();
        set.merge(&[change("spaces", "a", 20.0, Some(space("A2")))]);
        store.save(&p1, Stored::new(set.clone(), 20.0), Some(&BTreeSet::from(["spaces".into()]))).expect("saved");
        assert_eq!(fs::read(bak_of(&spaces_file)).ok(), Some(before), "the version before kept as its backup");
        assert_eq!(fs::metadata(dir.join("items/pins.json")).and_then(|m| m.modified()).ok(), pins_before);
        assert!(!dir.join("items/pins.json.bak").exists(), "and the other collections' files left alone");

        // A file damaged: its backup is read; a temporary file left over is removed.
        fs::write(&spaces_file, "{\"format\":1,\"coll").expect("damaged");
        fs::write(dir.join("items/.spaces.json.1234.tmp"), "half").expect("a temp");
        let mut fresh = test_store(root);
        let recovered = fresh.load(&p1).cloned().expect("read");
        assert_eq!(fresh.recovered(), ["spaces.json"]);
        assert_eq!(recovered.set.live_values("spaces")["a"]["name"], "A", "a damaged file: its backup read instead");
        assert_eq!(fresh.removed_temps(), 1);
        assert!(!dir.join("items/.spaces.json.1234.tmp").exists());
        assert!(
            recovered.set.item("pins", "gone").is_some_and(DataItem::deleted) && recovered.acked == 20.0,
            "the rest as saved"
        );

        // Revisions: new at every save that changes the set, not otherwise; kept in set.json.
        let mut revs = test_store(root);
        let r = revs.load(&p1).cloned().expect("a set");
        let r0 = r.rev.clone();
        revs.save(&p1, r.clone(), Some(&BTreeSet::new())).expect("saved");
        assert_eq!(
            revs.load(&p1).map(|s| s.rev.clone()),
            Some(r0.clone()),
            "a save that changes nothing: the same rev"
        );
        let mut r = r;
        r.set.merge(&[change("folders", "f", 25.0, Some(json!({ "name": "F" })))]);
        let r1 = revs.save(&p1, r, Some(&BTreeSet::from(["folders".into()]))).expect("saved");
        let n = |r: &str| r.split('-').next().and_then(|n| n.parse::<i64>().ok()).unwrap_or(-9);
        assert!(r1 != r0 && n(&r1) == n(&r0) + 1, "a new rev, numbered on");
        assert_eq!(test_store(root).load(&p1).map(|s| s.rev.clone()), Some(r1), "the rev read back from set.json");

        // A crash mid-write: set.json's new rev, one file, the next left as a temporary file.
        test_store(root).save(&p1, recovered, None).expect("the damaged file written whole again");
        let mut crashy = test_store(root);
        let mut base = crashy.load(&p1).cloned().expect("loaded");
        let rev_before = base.rev.clone();
        base.set.merge(&[
            change("pins", "p", 30.0, Some(json!({ "url": "https://p2.test/" }))),
            change("spaces", "a", 30.0, Some(space("A3"))),
        ]);
        base.acked = 30.0;
        crashy.crash_after_writes = Some(2);
        let result = crashy.save(&p1, base, Some(&BTreeSet::from(["pins".into(), "spaces".into()])));
        assert!(matches!(result, Err(SaveError::Crashed)) && crashy.crashed(), "a crash: nothing said after it");
        let mut after = test_store(root);
        let read = after.load(&p1).cloned().expect("read");
        assert_eq!(read.set.live_values("pins")["p"]["url"], "https://p2.test/", "the one written new");
        assert_eq!(read.set.live_values("spaces")["a"]["name"], "A", "the next as it was");
        assert!(after.recovered().is_empty());
        assert!(
            read.acked == 20.0 && read.rev != rev_before && !read.rev.is_empty(),
            "acked as it was, the rev already new"
        );
        assert_eq!(after.removed_temps(), 1, "its temporary file removed");
        let p3 = DataProfile::new("safari", "P3");
        let mut first_crash = test_store(root);
        first_crash.crash_after_writes = Some(1);
        let _ = first_crash.save(&p3, Stored::new(set.clone(), 1.0), None);
        assert!(test_store(root).load(&p3).is_none(), "a crash during a profile's first write: no data set");

        // Tombstones past their time go as it's saved.
        let mut pruner = test_store(root);
        let day = 24.0 * 3600.0 * 1000.0;
        pruner.now = Box::new(move || 100.0 * day);
        let old = set_of(&[change("pins", "ancient", 1.0, None), change("pins", "recent", 99.0 * day, None)]);
        let p4 = DataProfile::new("safari", "P4");
        pruner.save(&p4, Stored::new(old, 0.0), Some(&BTreeSet::new())).expect("saved");
        assert!(pruner.load(&p4).is_some_and(|s| s.set.item("pins", "ancient").is_none()));
        let mut reread = test_store(root);
        let s4 = reread.load(&p4).expect("read");
        assert!(s4.set.item("pins", "recent").is_some() && s4.set.item("pins", "ancient").is_none(), "in the file too");

        // A later format's data is left alone.
        let p5 = DataProfile::new("safari", "P5");
        let mut later = test_store(root);
        later.save(&p5, Stored::new(set.clone(), 1.0), None).expect("saved");
        let manifest = later.directory(&p5).join("set.json");
        let text = r#"{"format":2,"browser":"safari","profile":"P5","acked":1}"#;
        fs::write(&manifest, text).expect("later");
        let mut reader = test_store(root);
        assert!(reader.load(&p5).is_none(), "a later format's set: not read");
        assert!(matches!(reader.save(&p5, Stored::new(set.clone(), 2.0), None), Err(SaveError::LaterFormat)));
        assert_eq!(fs::read_to_string(&manifest).ok().as_deref(), Some(text), "and never written over");
        let mut fresh_reader = test_store(root);
        assert!(
            matches!(fresh_reader.save(&p5, Stored::new(set.clone(), 2.0), None), Err(SaveError::LaterFormat)),
            "found on the save's own read"
        );
        assert_eq!(fs::read_to_string(&manifest).ok().as_deref(), Some(text));

        let odd = DataProfile::new("safari", "..");
        reader.save(&odd, Stored::new(set.clone(), 1.0), None).expect("saved");
        assert!(root.join("safari/%2E%2E/set.json").exists(), "a profile called ..: a folder of its own");
        reader.save(&DataProfile::new("chrome", "P1"), Stored::new(set, 1.0), None).expect("saved");
        let listed: Vec<String> = test_store(root).profiles(None).iter().map(DataProfile::key).collect();
        assert_eq!(listed, ["chrome:P1", "safari:..", "safari:P1", "safari:P4", "safari:P5"]);
        let chrome: Vec<String> = test_store(root).profiles(Some("chrome")).iter().map(DataProfile::key).collect();
        assert_eq!(chrome, ["chrome:P1"], "of one browser");
    }

    #[test]
    fn a_later_collection_file_and_archive() {
        let root = temp();
        let p = DataProfile::new("chrome", "p-1");
        let mut store = test_store(root.path());
        let set = set_of(&[change("Later", "x", 1.0, Some(json!(1))), change("spaces", "a", 1.0, Some(space("A")))]);
        store.save(&p, Stored::new(set, 0.0), None).expect("saved");
        let dir = store.directory(&p);
        assert!(dir.join("items/x-%4Cater.json").exists(), "another collection after x-");
        assert_eq!(
            test_store(root.path()).load(&p).map(|s| s.set.collections()),
            Some(vec!["Later".into(), "spaces".into()])
        );
        assert_eq!(name_of(&mut store, &p, "spaces", "a").as_deref(), Some("A"));
        let to = store.archive(&p).expect("put away");
        assert!(to.starts_with(root.path().join("chrome/.archived")) && to.join("set.json").exists() && !dir.exists());
        assert!(store.profiles(None).is_empty() && store.load(&p).is_none(), "out of the profiles");
        assert!(store.archive(&p).is_none(), "nothing to put away");
    }

    #[test]
    fn writes_atomically() {
        let root = temp();
        let path = root.path().join("a/b/file.json");
        write_atomically(b"one", &path).expect("written");
        assert!(!bak_of(&path).exists(), "no backup for a first write");
        write_atomically(b"two", &path).expect("written");
        assert_eq!(fs::read(&path).ok().as_deref(), Some(&b"two"[..]));
        assert_eq!(fs::read(bak_of(&path)).ok().as_deref(), Some(&b"one"[..]), "the one it replaced kept");
        let names = list_names(path.parent().expect("a folder"));
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "no temporary file left: {names:?}");
        assert!(write_atomically(b"x", Path::new("")).is_err());
    }
}
