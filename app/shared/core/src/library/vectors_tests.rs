// The vectors' loader and runner, and js.json (JavaScriptCore's answers on this Mac) against js.rs: commit 1's
// tables are these cases, so the two can't drift apart.

use std::cmp::Ordering;
use std::collections::{BTreeSet, VecDeque};

use serde_json::json;

use super::super::import::{ns_id, ns_tab_id};
use super::super::js::*;
use super::super::model::links::pattern_matches_url;
use super::*;

#[test]
fn the_vectors_load() {
    let all = groups();
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    let mut actions = BTreeSet::new();
    for g in &all {
        assert!(!g.cases.is_empty(), "{}: cases", g.file);
        for s in g.cases.iter().flat_map(|c| &c.steps) {
            *kinds.entry(s.kind.name()).or_default() += 1;
            if let Kind::Perform { action, expect, .. } = &s.kind {
                actions.insert(action.clone());
                assert_eq!(expect.ok, expect.error.is_none(), "{}: an error only when not ok", g.file);
            }
        }
    }
    for k in ["perform", "snapshot", "import", "normal", "target"] {
        assert!(kinds.get(k).copied().unwrap_or(0) > 0, "{k} steps: {kinds:?}");
    }
    assert!(kinds["perform"] > 5000, "{kinds:?}");
    assert!(actions.len() >= 57, "every action has vectors: {}", actions.len());
    assert!(all.iter().any(|g| g.from == "recorded") && all.iter().any(|g| g.from == "generated"));
    // A throw's words are JavaScriptCore's (the survey's), its site named.
    let threw = all
        .iter()
        .flat_map(|g| &g.cases)
        .flat_map(|c| &c.steps)
        .find_map(|s| match &s.kind {
            Kind::Perform { expect, .. } if expect.site.is_some() => expect.error.clone(),
            _ => None,
        })
        .expect("a step that threw");
    assert!(threw.starts_with("failed: ") && threw.contains("(In '"), "{threw}");
}

// An engine that answers each step with the vectors' own expectation, in the order run_groups asks.
struct Oracle(VecDeque<Value>);
impl Oracle {
    fn new(groups: &[Group]) -> Oracle {
        let answers = groups.iter().flat_map(|g| &g.cases).flat_map(|c| &c.steps).map(|s| match &s.kind {
            Kind::Perform { expect, .. } => expect.to_json(),
            Kind::Snapshot { expect }
            | Kind::Import { expect, .. }
            | Kind::Normal { expect }
            | Kind::Target { expect, .. } => expect.clone(),
        });
        Oracle(answers.collect())
    }
}
impl Engine for Oracle {
    fn perform(&mut self, _: &Map<String, Value>, _: &str, _: &Value, _: &Env) -> Option<Value> {
        self.0.pop_front()
    }
    fn snapshot(&mut self, _: &Map<String, Value>) -> Option<Value> {
        self.0.pop_front()
    }
    fn import(&mut self, _: &Map<String, Value>, _: &[Value], _: &[Value], _: f64) -> Option<Value> {
        self.0.pop_front()
    }
    fn normal(&mut self, _: &Map<String, Value>) -> Option<Value> {
        self.0.pop_front()
    }
    fn target(&mut self, _: &Value) -> Option<Value> {
        self.0.pop_front()
    }
}

#[test]
fn the_runner_checks_every_step() {
    let all = groups_named("recorded-library");
    let report = run_groups(&all, &mut Oracle::new(&all));
    report.assert_ok();
    assert!(report.total_checked() > 100 && report.skipped.is_empty(), "{report:?}");
    // One answer wrong: that step alone fails.
    let mut oracle = Oracle::new(&all);
    oracle.0[3] = json!({ "ok": false });
    assert_eq!(run_groups(&all, &mut oracle).failures.len(), 1);
    // Nothing implemented: every step skipped, none failed.
    struct Nothing;
    impl Engine for Nothing {}
    let none = run_groups(&all, &mut Nothing);
    assert!(none.failures.is_empty() && none.total_checked() == 0 && none.skipped.values().sum::<usize>() > 100);
}

#[test]
fn values_compare_as_the_vectors_say() {
    assert_eq!(differ(&json!({ "a": 1, "b": [1, 2] }), &json!({ "b": [1, 2], "a": 1.0 })), None);
    assert!(differ(&json!([1, 2]), &json!([2, 1])).is_some());
    assert!(differ(&json!({ "a": 1 }), &json!({ "a": 1, "b": null })).unwrap().contains("$.b"));
    assert!(differ(&json!({ "a": 1, "b": null }), &json!({ "a": 1 })).is_some());
    assert!(differ(&json!("1"), &json!(1)).is_some());
    assert_eq!(differ(&json!(9007199254740993u64), &json!(9007199254740992.0)), None, "numbers as JS reads them");
}

#[test]
fn changes_merge_in_code_point_order() {
    let mut v = json!({ "tabs": { "t-a": { "x": 1 }, "t-c": {} } }).as_object().cloned().unwrap();
    merge(
        &mut v,
        &[
            json!({ "collection": "tabs", "id": "t-b", "value": { "y": 2 } }),
            json!({ "collection": "tabs", "id": "t-c", "deleted": true }),
            json!({ "collection": "tabs", "id": "t-a", "value": { "x": 3 } }),
            json!({ "collection": "pins", "id": "p", "value": 1 }),
        ],
    );
    assert_eq!(v["tabs"].as_object().unwrap().keys().collect::<Vec<_>>(), ["t-a", "t-b"]);
    assert_eq!(v["tabs"]["t-a"], json!({ "x": 3 }));
    assert_eq!(v["pins"], json!({ "p": 1 }));
    assert_eq!(data_set(&v).live_values("tabs").len(), 2);
}

fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => match s.as_str() {
            "-0" => -0.0,
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => panic!("not a number: {other}"),
        },
        v => v.as_f64().expect("a number"),
    }
}
fn same_num(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || (a == b && a.is_sign_negative() == b.is_sign_negative())
}
fn rows<'a>(js: &'a Value, group: &str) -> &'a [Value] {
    js["cases"][group].as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("js.json cases.{group}"))
}
fn s(v: &Value) -> &str {
    v.as_str().expect("a string")
}
fn flag(v: &Value) -> bool {
    v.as_bool().expect("a boolean")
}

#[test]
fn js_json_is_js_rs() {
    let js = js();
    assert_eq!(js["engine"], "jsc");
    assert_eq!(js["nodeDiffers"], json!([]), "Node and JSC agree on every case today");
    let spaces: BTreeSet<u64> = rows(&js, "trimmed").iter().map(|c| c.as_u64().unwrap()).collect();
    assert_eq!(js["cases"]["regex"], js["cases"]["trimmed"], "trim and /\\s/ one list");
    for c in (0..=0x10ffffu32).filter_map(char::from_u32) {
        assert_eq!(is_space(c), spaces.contains(&u64::from(c)), "U+{:04X}", c as u32);
    }
    for r in rows(&js, "trims") {
        assert_eq!(trim(s(&r[0])), s(&r[1]));
    }
    for r in rows(&js, "squash") {
        assert_eq!(squash_spaces(s(&r[0])), s(&r[1]));
    }
    for r in rows(&js, "lengths") {
        assert_eq!(len16(s(&r[0])) as u64, r[1].as_u64().unwrap());
    }
    for r in rows(&js, "cuts") {
        // JSC's units, less a broken half at the end (Tirth's answer 3).
        let mut units: Vec<u16> = r[2].as_array().unwrap().iter().map(|u| u.as_u64().unwrap() as u16).collect();
        if units.last().is_some_and(|u| (0xd800..0xdc00).contains(u)) {
            units.pop();
        }
        let cut = slice16(s(&r[0]), r[1].as_u64().unwrap() as usize);
        assert_eq!(cut.encode_utf16().collect::<Vec<_>>(), units, "{:?} at {}", r[0], r[1]);
    }
    let mut list: Vec<&str> = rows(&js, "sortInput").iter().map(s).collect();
    list.sort_by(|a, b| cmp16(a, b));
    assert_eq!(json!(list), js["cases"]["sorted"]);
    for r in rows(&js, "numberStrings") {
        assert_eq!(number_string(num(&r[0])), s(&r[1]), "{}", r[0]);
    }
    for r in rows(&js, "parsed") {
        let v: Value = serde_json::from_str(s(&r[0])).unwrap();
        assert!(same_num(v.as_f64().unwrap_or(f64::NAN), num(&r[1])), "{}", r[0]);
    }
    for r in rows(&js, "rounds") {
        assert!(same_num(round(num(&r[0])), num(&r[1])), "round {}", r[0]);
    }
    for r in rows(&js, "maxes") {
        let (a, b) = (num(&r[0]), num(&r[1]));
        assert!(same_num(max(a, b), num(&r[2])) && same_num(min(a, b), num(&r[3])), "{r:?}");
    }
    for r in rows(&js, "ratios") {
        // library.ts stateOf: `ratios.reduce((a, b) => a + b, 0)`, then each Math.round((r / sum) * 10000) / 10000.
        let given: Vec<f64> = r[0].as_array().unwrap().iter().map(num).collect();
        let mut sum = 0.0;
        for x in &given {
            sum += x;
        }
        let got: Vec<f64> = given.iter().map(|x| round((x / sum) * 10000.0) / 10000.0).collect();
        assert!(got.iter().zip(r[1].as_array().unwrap()).all(|(a, b)| same_num(*a, num(b))), "{r:?}");
    }
    for r in rows(&js, "values") {
        let v: Value = serde_json::from_str(s(&r[0])).unwrap();
        assert_eq!(to_string(&v), s(&r[1]), "String({})", r[0]);
        assert_eq!(property_key(Some(&v)), s(&r[2]), "key {}", r[0]);
        assert_eq!(truthy(Some(&v)), flag(&r[3]), "!!{}", r[0]);
    }
    for r in rows(&js, "fingerprints") {
        assert_eq!(fingerprint(s(&r[0])), s(&r[2]), "{:?}", r[0]);
    }
    for r in rows(&js, "ids") {
        assert_eq!(ns_id(s(&r[0]), s(&r[1]), s(&r[2])), s(&r[3]));
        assert_eq!(ns_tab_id(s(&r[0]), s(&r[1]), s(&r[2])), s(&r[4]));
    }
    for r in rows(&js, "idLetters") {
        let given = s(&r[0]).to_string();
        assert_eq!(Ids::new([given.clone()]).letters() == given, flag(&r[1]), "{given}");
    }
    for r in rows(&js, "regexes") {
        let u = s(&r[0]);
        assert_eq!((is_web_page(u), is_http(u), favorite_url_ok(u)), (flag(&r[1]), flag(&r[2]), flag(&r[3])), "{u:?}");
    }
    for r in rows(&js, "lower") {
        assert_eq!(s(&r[0]).to_lowercase(), s(&r[1]));
    }
    // Addresses as the browsers parse them (`url`: Node with a URL, Tirth's answer 11). (`jscUrl` is what JSC's bare
    // context, with no URL, gave back before the switch: the address as given, no pattern matching; kept as recorded.)
    assert_eq!((&js["url"]["hasUrl"], &js["jscUrl"]["hasUrl"]), (&json!(true), &json!(false)));
    let normalized = js["url"]["normalized"].as_array().unwrap();
    assert!(normalized.iter().filter(|r| r[0] != r[1]).count() >= 10, "most of them normalised");
    for r in normalized {
        assert_eq!(normalize_url(s(&r[0])), s(&r[1]));
    }
    for r in js["url"]["matches"].as_array().unwrap() {
        assert_eq!(pattern_matches_url(s(&r[0]), s(&r[1])), flag(&r[2]), "{r:?}");
    }
}

// localeCompare's cases (JSC's on this Mac, en-US) against the core's tests' stand-in, on ASCII: the printable
// characters' order and every pair's sign, and the ASCII pairs; the whole of it (the accents too) against the system's
// sorter in margin-ffi's tests (collation.rs).
#[test]
fn js_json_collation_on_ascii() {
    let js = js();
    assert_eq!(js["locale"], "en-US");
    let c = AsciiCollation::new();
    let order: Vec<String> = s(&js["cases"]["asciiOrder"]).chars().map(String::from).collect();
    assert_eq!(order.len(), 95);
    for (i, a) in order.iter().enumerate() {
        for (j, b) in order.iter().enumerate() {
            assert_eq!(c.compare(a, b), i.cmp(&j), "{a:?} vs {b:?}");
        }
    }
    let ascii: Vec<String> = (0x20u8..0x7f).map(|b| char::from(b).to_string()).collect();
    let signs: Vec<char> = s(&js["cases"]["asciiSigns"]).chars().collect();
    for (i, a) in ascii.iter().enumerate() {
        for (j, b) in ascii.iter().enumerate() {
            let want = match signs[i * ascii.len() + j] {
                '-' => Ordering::Less,
                '0' => Ordering::Equal,
                _ => Ordering::Greater,
            };
            assert_eq!(c.compare(a, b), want, "{a:?} vs {b:?}");
        }
    }
    let mut checked = 0;
    for r in rows(&js, "pairs").iter().filter(|r| s(&r[0]).is_ascii() && s(&r[1]).is_ascii()) {
        assert_eq!(locale_compare(&c, s(&r[0]), s(&r[1])), r[2].as_i64().unwrap().cmp(&0), "{} vs {}", r[0], r[1]);
        checked += 1;
    }
    assert!(checked >= 19, "{checked}");
}
