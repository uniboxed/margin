//! The library's shared vectors (docs/CORE-REFACTOR.md step 4, part 8; tests/fixtures/library/README.md): the cases
//! library.ts answered, as JavaScriptCore answers them on the Mac, read here for the Rust's tests. Tests only.
//!
//! A test of a part implements [`Engine`] for what it has (the others answer `None`: skipped) and calls [`run`]:
//!
//! ```ignore
//! struct State;
//! impl vectors::Engine for State {
//!     fn snapshot(&mut self, values: &Map<String, Value>) -> Option<Value> { Some(snapshot_json(&state_of_values(values))) }
//! }
//! let report = vectors::run(&mut State);
//! report.assert_ok();
//! assert!(report.checked["snapshot"] > 100);
//! ```
//!
//! The values each step starts from are the case's `values` with every earlier step's expected changes merged in (the
//! vectors' truth, not the engine's answer), so one wrong step fails alone and a skipped kind never stops a case.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::data::set::{DataItem, DataSet};

/// tests/fixtures/library, from this crate.
pub fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/library")
}

/// One file of cases/ (`{ about, from, cases }`).
#[derive(Clone, Debug)]
pub struct Group {
    /// Its name in cases/ (`recorded-library.json`).
    pub file: String,
    pub about: String,
    /// "recorded" (the TS tests' calls), "generated" (seeded sequences), "survey" (the throw survey) or "edges".
    pub from: String,
    pub cases: Vec<Case>,
}

#[derive(Clone, Debug)]
pub struct Case {
    pub about: String,
    /// collection → id → value: the library's live values before the first step, each collection's ids in code-point
    /// order (the order the core's store reads them in, and the order library.ts was given them).
    pub values: Map<String, Value>,
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug)]
pub struct Step {
    pub kind: Kind,
    /// The answer differs where addresses are parsed: this is the browsers' (library.ts in Node with `URL`, Tirth's
    /// answer 11); Margin.app's JavaScriptCore (a bare JSContext, no `URL`) answers otherwise.
    pub url: bool,
    /// Node's answer differs; this is JavaScriptCore's (`"engine": "jsc"`).
    pub jsc_only: bool,
    /// library.ts's answer held half an emoji (a cut through a surrogate pair): dropped here, Tirth's answer 3.
    pub cut: bool,
}

#[derive(Clone, Debug)]
pub enum Kind {
    /// `perform(values, action, payload, env)`.
    Perform { action: String, payload: Value, env: Env, expect: Expect },
    /// `snapshot(values)`: what the UI draws.
    Snapshot { expect: Value },
    /// `importValues(values, sets, order, { now })`: `expect` is `{ changes, counts }`.
    Import { sets: Vec<Value>, order: Vec<Value>, now: f64, expect: Value },
    /// `valuesOf(stateOf(values), values.imports)`: the values read and written again (part 2's round trip).
    Normal { expect: Value },
    /// `targetOf(raw)` (null: not a target). Reads no values.
    Target { raw: Value, expect: Value },
}

impl Kind {
    pub fn name(&self) -> &'static str {
        match self {
            Kind::Perform { .. } => "perform",
            Kind::Snapshot { .. } => "snapshot",
            Kind::Import { .. } => "import",
            Kind::Normal { .. } => "normal",
            Kind::Target { .. } => "target",
        }
    }
}

/// An action's env: `now` and the ids given (always enough: never library.ts's random fallback).
#[derive(Clone, Debug, PartialEq)]
pub struct Env {
    pub now: f64,
    pub ids: Vec<String>,
}

/// A perform's outcome as library.ts gives it.
#[derive(Clone, Debug)]
pub struct Expect {
    pub ok: bool,
    /// null when the action answers nothing, and on a failure.
    pub result: Value,
    /// The words of a refusal (`no such item`), or of a throw as JavaScriptCore says it (`failed: …`, from
    /// throws.json's site): `None` when `ok`.
    pub error: Option<String>,
    /// The throw survey's site when the action threw (`error` is then `failed: <JSC's words>`).
    pub site: Option<String>,
    pub changes: Vec<Value>,
    pub requests: Vec<Value>,
}

impl Expect {
    /// The outcome as JSON (`{ ok, result, error?, changes, requests }`), as an engine answers it.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("ok".into(), Value::Bool(self.ok));
        o.insert("result".into(), self.result.clone());
        if let Some(e) = &self.error {
            o.insert("error".into(), Value::String(e.clone()));
        }
        o.insert("changes".into(), Value::Array(self.changes.clone()));
        o.insert("requests".into(), Value::Array(self.requests.clone()));
        Value::Object(o)
    }
}

/// What an implementation answers, each kind as library.ts's JSON. `None`: not implemented yet (the step is skipped
/// and counted as such).
pub trait Engine {
    /// `{ ok, result, error?, changes, requests }` (`result` null when there's none; `error` only when not `ok`).
    fn perform(&mut self, _values: &Map<String, Value>, _action: &str, _payload: &Value, _env: &Env) -> Option<Value> {
        None
    }
    fn snapshot(&mut self, _values: &Map<String, Value>) -> Option<Value> {
        None
    }
    /// `{ changes, counts }`.
    fn import(&mut self, _values: &Map<String, Value>, _sets: &[Value], _order: &[Value], _now: f64) -> Option<Value> {
        None
    }
    fn normal(&mut self, _values: &Map<String, Value>) -> Option<Value> {
        None
    }
    fn target(&mut self, _raw: &Value) -> Option<Value> {
        None
    }
}

/// A run's counts: steps checked and skipped by kind, and each failure (`file › case › step n (kind): why`).
#[derive(Debug, Default)]
pub struct Report {
    pub checked: BTreeMap<&'static str, usize>,
    pub skipped: BTreeMap<&'static str, usize>,
    pub failures: Vec<String>,
}

impl Report {
    pub fn total_checked(&self) -> usize {
        self.checked.values().sum()
    }

    /// Panics with the first 20 failures (and how many there were).
    pub fn assert_ok(&self) {
        if self.failures.is_empty() {
            return;
        }
        let shown: Vec<&str> = self.failures.iter().take(20).map(String::as_str).collect();
        panic!("{} of {} vector steps differ:\n{}", self.failures.len(), self.total_checked(), shown.join("\n"));
    }
}

/// Every case file (cases/*.json), by name.
pub fn groups() -> Vec<Group> {
    groups_in(&dir().join("cases"))
}

/// Every case file of a folder (*.json), by name: cases/ or a harness's (throws.json's words for a throw).
pub fn groups_in(cases: &std::path::Path) -> Vec<Group> {
    let throws = throw_words();
    let mut names: Vec<String> = std::fs::read_dir(cases)
        .unwrap_or_else(|e| panic!("{}: {e}", cases.display()))
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|file| {
            let text = std::fs::read_to_string(cases.join(&file)).expect("a vector file");
            let v: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{file}: {e}"));
            group(file, &v, &throws)
        })
        .collect()
}

/// Every case file whose name starts with `prefix` (`recorded-`, `generated-`, `survey`, `edges`).
pub fn groups_named(prefix: &str) -> Vec<Group> {
    groups().into_iter().filter(|g| g.file.starts_with(prefix)).collect()
}

/// Runs every case file through `engine`.
pub fn run(engine: &mut impl Engine) -> Report {
    run_groups(&groups(), engine)
}

/// Runs these groups through `engine`.
pub fn run_groups(groups: &[Group], engine: &mut impl Engine) -> Report {
    let mut report = Report::default();
    for g in groups {
        for (ci, case) in g.cases.iter().enumerate() {
            let mut values = case.values.clone();
            for (si, step) in case.steps.iter().enumerate() {
                let kind = step.kind.name();
                let at = || format!("{} › case {ci} ({}) › step {si} ({kind})", g.file, case.about);
                let (got, expect) = match &step.kind {
                    Kind::Perform { action, payload, env, expect } => {
                        (engine.perform(&values, action, payload, env), expect.to_json())
                    }
                    Kind::Snapshot { expect } => (engine.snapshot(&values), expect.clone()),
                    Kind::Import { sets, order, now, expect } => {
                        (engine.import(&values, sets, order, *now), expect.clone())
                    }
                    Kind::Normal { expect } => (engine.normal(&values), expect.clone()),
                    Kind::Target { raw, expect } => (engine.target(raw), expect.clone()),
                };
                match got {
                    None => *report.skipped.entry(kind).or_default() += 1,
                    Some(got) => {
                        *report.checked.entry(kind).or_default() += 1;
                        if let Some(why) = differ(&got, &expect) {
                            report.failures.push(format!("{}: {why}", at()));
                        }
                    }
                }
                if let Some(changes) = step.changes() {
                    merge(&mut values, changes);
                }
            }
        }
    }
    report
}

impl Step {
    /// The changes this step's expectation merges into the values (a perform's or an import's).
    pub fn changes(&self) -> Option<&[Value]> {
        match &self.kind {
            Kind::Perform { expect, .. } => Some(&expect.changes),
            Kind::Import { expect, .. } => expect.get("changes").and_then(Value::as_array).map(Vec::as_slice),
            _ => None,
        }
    }
}

/// The changes merged into live values: `{ collection, id, value }` sets it, `{ collection, id, deleted: true }`
/// removes it (the store's merge with every change newer, as tests/library.test.ts's `library()` merges them).
pub fn merge(values: &mut Map<String, Value>, changes: &[Value]) {
    for c in changes {
        let (Some(collection), Some(id)) =
            (c.get("collection").and_then(Value::as_str), c.get("id").and_then(Value::as_str))
        else {
            continue;
        };
        let list = values.entry(collection.to_string()).or_insert_with(|| Value::Object(Map::new()));
        let Some(list) = list.as_object_mut() else { continue };
        if c.get("deleted") == Some(&Value::Bool(true)) {
            list.shift_remove(id);
        } else if let Some(v) = c.get("value") {
            // A new id goes in code-point order, where the store's set would read it.
            if let Some(old) = list.get_mut(id) {
                *old = v.clone();
            } else {
                list.insert(id.to_string(), v.clone());
                list.sort_keys();
            }
        }
    }
}

/// The values as a data set (every item live at time 1), for the parts that read a `DataSet`.
pub fn data_set(values: &Map<String, Value>) -> DataSet {
    let mut set = DataSet::new();
    for (collection, list) in values {
        let Some(list) = list.as_object() else { continue };
        let items = set.items.entry(collection.clone()).or_default();
        for (id, v) in list {
            items.insert(id.clone(), DataItem::live(1.0, v.clone()));
        }
    }
    set
}

/// JSON values equal as the vectors compare them: objects with no regard to key order, numbers as numbers (f64, as JS
/// reads them), arrays in order. `None` when equal, else where the first difference is.
pub fn differ(got: &Value, expect: &Value) -> Option<String> {
    first_difference(got, expect, "$")
}

fn first_difference(got: &Value, expect: &Value, path: &str) -> Option<String> {
    let short = |v: &Value| {
        let t = v.to_string();
        if t.len() > 200 {
            let cut = (0..=200).rev().find(|&i| t.is_char_boundary(i)).unwrap_or(0);
            format!("{}…", &t[..cut])
        } else {
            t
        }
    };
    match (got, expect) {
        (Value::Number(a), Value::Number(b)) => {
            (a.as_f64() != b.as_f64()).then(|| format!("{path}: {} where {} was expected", short(got), short(expect)))
        }
        (Value::Object(a), Value::Object(b)) => {
            for (k, bv) in b {
                match a.get(k) {
                    None => return Some(format!("{path}.{k}: missing ({} expected)", short(bv))),
                    Some(av) => {
                        if let Some(d) = first_difference(av, bv, &format!("{path}.{k}")) {
                            return Some(d);
                        }
                    }
                }
            }
            a.keys()
                .find(|k| !b.contains_key(*k))
                .map(|k| format!("{path}.{k}: {} where nothing was expected", short(&a[k])))
        }
        (Value::Array(a), Value::Array(b)) => {
            for (i, (av, bv)) in a.iter().zip(b).enumerate() {
                if let Some(d) = first_difference(av, bv, &format!("{path}[{i}]")) {
                    return Some(d);
                }
            }
            (a.len() != b.len()).then(|| format!("{path}: {} items where {} were expected", a.len(), b.len()))
        }
        _ => (got != expect).then(|| format!("{path}: {} where {} was expected", short(got), short(expect))),
    }
}

/// The throw survey's words: site → JavaScriptCore's message (throws.json).
pub fn throw_words() -> BTreeMap<String, String> {
    let text = std::fs::read_to_string(dir().join("throws.json")).expect("tests/fixtures/library/throws.json");
    let v: Value = serde_json::from_str(&text).expect("throws.json's JSON");
    v.get("sites")
        .and_then(Value::as_object)
        .map(|sites| {
            sites.iter().filter_map(|(site, s)| Some((site.clone(), s.get("jsc")?.as_str()?.to_string()))).collect()
        })
        .unwrap_or_default()
}

/// js.json (the JavaScript semantics' cases, part 1), as JSON.
pub fn js() -> Value {
    let text = std::fs::read_to_string(dir().join("js.json")).expect("tests/fixtures/library/js.json");
    serde_json::from_str(&text).expect("js.json's JSON")
}

fn group(file: String, v: &Value, throws: &BTreeMap<String, String>) -> Group {
    let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_string();
    let cases = v.get("cases").and_then(Value::as_array).unwrap_or_else(|| panic!("{file}: no cases"));
    Group {
        about: s(v.get("about")),
        from: s(v.get("from")),
        cases: cases
            .iter()
            .enumerate()
            .map(|(i, c)| Case {
                about: s(c.get("about")),
                values: c.get("values").and_then(Value::as_object).cloned().unwrap_or_default(),
                steps: c
                    .get("steps")
                    .and_then(Value::as_array)
                    .unwrap_or_else(|| panic!("{file} case {i}: no steps"))
                    .iter()
                    .enumerate()
                    .map(|(n, st)| step(st, throws).unwrap_or_else(|why| panic!("{file} case {i} step {n}: {why}")))
                    .collect(),
            })
            .collect(),
        file,
    }
}

fn step(v: &Value, throws: &BTreeMap<String, String>) -> Result<Step, String> {
    let flag = |k: &str| v.get(k) == Some(&Value::Bool(true));
    let expect = || v.get("expect").cloned().ok_or("no expect");
    let kind = if let Some(action) = v.get("perform") {
        let e = expect()?;
        let env = v.get("env").ok_or("no env")?;
        let error = e.get("error");
        let site = error.and_then(|x| x.get("failed")).and_then(Value::as_str).map(str::to_string);
        let words = match (&site, error) {
            (Some(site), _) => {
                Some(format!("failed: {}", throws.get(site).ok_or_else(|| format!("{site}: not in throws.json"))?))
            }
            (None, Some(Value::String(w))) => Some(w.clone()),
            (None, Some(other)) => return Err(format!("an error that's neither words nor a site: {other}")),
            (None, None) => None,
        };
        let list = |k: &str| e.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
        Kind::Perform {
            action: action.as_str().ok_or("perform isn't a name")?.to_string(),
            payload: v.get("payload").cloned().unwrap_or(Value::Object(Map::new())),
            env: Env {
                now: env.get("now").and_then(Value::as_f64).ok_or("no env.now")?,
                ids: env
                    .get("ids")
                    .and_then(Value::as_array)
                    .map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default(),
            },
            expect: Expect {
                ok: e.get("ok") == Some(&Value::Bool(true)),
                result: e.get("result").cloned().unwrap_or(Value::Null),
                error: words,
                site,
                changes: list("changes"),
                requests: list("requests"),
            },
        }
    } else if v.get("snapshot").is_some() {
        Kind::Snapshot { expect: expect()? }
    } else if let Some(i) = v.get("import") {
        let list = |k: &str| i.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
        Kind::Import {
            sets: list("sets"),
            order: list("order"),
            now: i.get("now").and_then(Value::as_f64).unwrap_or(0.0),
            expect: expect()?,
        }
    } else if v.get("normal").is_some() {
        Kind::Normal { expect: expect()? }
    } else if let Some(raw) = v.get("target") {
        Kind::Target { raw: raw.clone(), expect: expect()? }
    } else {
        return Err("no kind (perform, snapshot, import, normal, target)".into());
    };
    Ok(Step {
        kind,
        url: flag("url"),
        jsc_only: v.get("engine").and_then(Value::as_str) == Some("jsc"),
        cut: flag("cut"),
    })
}

/// Commit 0's baseline library (T/library-vectors-tests.swift `libraryBaseline`): `n` items (2 KB icons) in two spaces,
/// the last selected, 200 archived, a window on the first space.
pub fn baseline(n: usize) -> DataSet {
    let icon = format!("data:image/png;base64,{}", "A".repeat(2048 - 22));
    let web = serde_json::json!({ "kind": "web", "browser": "safari", "profile": null });
    let mut tabs = Map::new();
    for i in 0..n {
        tabs.insert(
            format!("t-i{i}"),
            serde_json::json!({
                "url": format!("https://site{i}.example/page"), "title": format!("Page {i} of the baseline"), "icon": icon,
                "spaceId": if i % 2 == 0 { "a" } else { "b" }, "order": i, "lastUsed": 1000 + i, "selected": i == n - 1,
                "target": web,
            }),
        );
    }
    let mut archive = Map::new();
    for i in 0..200 {
        archive.insert(
            format!("a-{i}"),
            serde_json::json!({ "url": format!("https://old{i}.example/"), "title": format!("Old {i}"), "spaceId": "a", "icon": "", "closedAt": 500 + i, "target": web }),
        );
    }
    let values = serde_json::json!({
        "spaces": {
            "a": { "name": "A", "emoji": "", "color": "", "order": 0, "browser": "safari", "profile": null },
            "b": { "name": "B", "emoji": "", "color": "", "order": 1, "browser": "safari", "profile": null },
        },
        "windows": { "1": { "spaceId": "a" } },
        "tabs": tabs,
        "archive": archive,
    });
    data_set(values.as_object().unwrap())
}

/// library.js's entry ([`crate::library::object::call`], LT:939) as the vectors' engine with a sorter: perform,
/// snapshot and import (the app's three calls), and the core's `valuesOf(stateOf(…))` and `targetOf` for the other two
/// kinds. Skipped and counted: piece 1's known gap (a `createSpace` given an emoji or colour that's truthy and no
/// string: JS stores it as given, the core `""`, actions_tests.rs).
pub struct Entry<'a> {
    pub compare: &'a dyn crate::library::js::LocaleCompare,
    pub gap: usize,
}

impl Entry<'_> {
    fn value(&self, name: &str, args: Value) -> Option<Value> {
        let out: Value =
            serde_json::from_str(&crate::library::object::call(name, &args.to_string(), self.compare)).ok()?;
        out.get("value").cloned()
    }
}

impl Engine for Entry<'_> {
    fn perform(&mut self, values: &Map<String, Value>, action: &str, payload: &Value, env: &Env) -> Option<Value> {
        if action == "createSpace" {
            let odd = |k: &str| payload.get(k).is_some_and(|v| crate::library::js::truthy(Some(v)) && !v.is_string());
            if odd("emoji") || odd("color") {
                self.gap += 1;
                return None;
            }
        }
        let args = serde_json::json!([values, action, payload, { "now": env.now, "ids": env.ids }]);
        let mut out = self.value("perform", args)?;
        // (The vectors' outcome always has `result`; LT's failure has none: null, as the vectors write it.)
        if let Value::Object(o) = &mut out {
            o.entry("result").or_insert(Value::Null);
        }
        Some(out)
    }
    fn snapshot(&mut self, values: &Map<String, Value>) -> Option<Value> {
        self.value("snapshot", serde_json::json!([values]))
    }
    fn import(&mut self, values: &Map<String, Value>, sets: &[Value], order: &[Value], now: f64) -> Option<Value> {
        self.value("importValues", serde_json::json!([values, sets, order, { "now": now }]))
    }
    fn normal(&mut self, values: &Map<String, Value>) -> Option<Value> {
        let imports = values.get("imports").and_then(Value::as_object).cloned().unwrap_or_default();
        let state = crate::library::state::state_of(values, self.compare);
        Some(Value::Object(crate::library::values::values_of(&state, &imports)))
    }
    fn target(&mut self, raw: &Value) -> Option<Value> {
        Some(crate::library::state::target_of(Some(raw)).map_or(Value::Null, |t| t.to_value()))
    }
}

/// The steps every engine of the core answers otherwise, for a reason decided: a `cut` step the typed diff answers
/// without library.ts's no-op rewrite (a favorite renamed through an emoji to the name it has, the half dropped: the
/// stored value; favorites.rs `rename_favorite`, DECISIONS.md 2026-11-23 piece 2).
/// A hand-written edge since 2026-11-24 (edges.ts), where no re-recording moves it: it was a generated step
/// (generated-11.json, sequence 299) until the backgrounds' re-recording drew other sequences.
pub const KNOWN: [&str; 1] = [
    "edges.json › case 16 (edges: cuts: a favorite renamed through an emoji to the name it has (library.ts rewrites it, the half dropped; the core sees no change)) › step 0 (perform): $.changes: 0 items where 1",
];

/// Every vector of every kind through library.js's entry with `compare`: all answered as JSC answered them but the
/// known step and the gap (21 steps since the split drop's re-recording, 2026-11-28, which also left 269 snapshot steps
/// where there were about 290; 14 after the backgrounds', 2026-11-24; 19 before). The steps checked by kind, and the gap's.
pub fn run_entry(compare: &dyn crate::library::js::LocaleCompare) -> (BTreeMap<&'static str, usize>, usize) {
    let mut engine = Entry { compare, gap: 0 };
    let mut report = run(&mut engine);
    let (expected, rest): (Vec<String>, Vec<String>) =
        report.failures.drain(..).partition(|f| KNOWN.iter().any(|k| f.starts_with(k)));
    report.failures = rest;
    report.assert_ok();
    assert_eq!(expected.len(), KNOWN.len(), "the known step: {expected:?}");
    assert_eq!(engine.gap, 21, "the createSpace steps of the known gap");
    for (kind, at_least) in [("perform", 8700), ("snapshot", 260), ("import", 2), ("normal", 1), ("target", 1)] {
        assert!(report.checked.get(kind).copied().unwrap_or(0) >= at_least, "{kind}: {:?}", report.checked);
    }
    assert_eq!(report.skipped.get("perform").copied().unwrap_or(0), engine.gap, "every other perform step checked");
    (report.checked, engine.gap)
}

/// The core's tests' stand-in for the system's sorter (Tirth, 2026-11-23: the platform hands the core its
/// comparator; the Mac's tests pin libicucore's): ICU's root collation on ASCII, as JavaScriptCore answers it (js.json's
/// `asciiOrder`, its recorded order of the 95 printable characters), three levels as ICU compares them: every
/// character's primary weight first (a letter's two cases one weight; the controls but tab to return ignorable, as
/// `"a\0"` equals `"a"`), then the cases (lower before upper). Past ASCII a character weighs its code point, after
/// every ASCII one: not ICU's (an accent is ICU's second level), so a test whose answer depends on a tie between
/// non-ASCII strings runs on the platform's comparator, not this.
pub struct AsciiCollation {
    primary: [u32; 128],
}

impl AsciiCollation {
    pub fn new() -> AsciiCollation {
        let order = js()["cases"]["asciiOrder"].as_str().map(str::to_owned).unwrap_or_default();
        let mut primary = [0u32; 128];
        // Tab to return, before the space, in their order.
        for (i, c) in (0x09u32..=0x0d).enumerate() {
            primary[c as usize] = 1 + i as u32;
        }
        let mut next = 10;
        for c in order.chars() {
            let lower = c.to_ascii_lowercase();
            if c.is_ascii_uppercase() && primary[lower as usize] != 0 {
                primary[c as usize] = primary[lower as usize];
                continue;
            }
            primary[c as usize] = next;
            next += 1;
        }
        AsciiCollation { primary }
    }

    fn weights(&self, s: &str) -> (Vec<u32>, Vec<u8>) {
        let mut p = Vec::with_capacity(s.len());
        let mut t = Vec::with_capacity(s.len());
        for c in s.chars() {
            let w = if c.is_ascii() { self.primary[c as usize] } else { 0x1_0000 + c as u32 };
            if w != 0 {
                p.push(w);
                t.push(u8::from(c.is_ascii_uppercase()));
            }
        }
        (p, t)
    }
}

impl Default for AsciiCollation {
    fn default() -> AsciiCollation {
        AsciiCollation::new()
    }
}

impl crate::library::js::LocaleCompare for AsciiCollation {
    fn compare(&self, a: &str, b: &str) -> std::cmp::Ordering {
        if a == b {
            return std::cmp::Ordering::Equal;
        }
        let (pa, ta) = self.weights(a);
        let (pb, tb) = self.weights(b);
        pa.cmp(&pb).then_with(|| ta.cmp(&tb))
    }
}

#[cfg(test)]
#[path = "vectors_tests.rs"]
mod tests;
