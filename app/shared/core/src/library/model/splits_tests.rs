// splits.rs against model.ts M:1628-1775: tests/split-model.test.ts and arc-data.test.ts's split cases on items (the
// library's kept half), the numbers from model.ts in Node, and "unchanged is the same state". The generated states and
// sequences against model.ts (Node and JavaScriptCore) are the scratch harness's, counted in DECISIONS.md; the shared
// vectors' split actions that need only these rules run in links_tests.rs's engine.

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::state::state_of;
use serde_json::json;

fn lib() -> LibState {
    let tabs: serde_json::Map<String, Value> = ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"]
        .iter()
        .map(|id| (id.to_string(), json!({ "url": format!("https://{id}/"), "spaceId": "a" })))
        .collect();
    let v = json!({ "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } }, "tabs": tabs });
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

fn shape(s: &LibState) -> Vec<(String, Vec<String>, Vec<f64>, &'static str)> {
    s.splits
        .iter()
        .map(|g| (g.id.to_string(), g.panes.iter().map(|p| p.to_string()).collect(), g.ratios.clone(), g.axis.as_str()))
        .collect()
}

fn split(s: &LibState, id: &str, panes: &[&str]) -> LibState {
    create_split(s, id, "a", panes, Axis::Horizontal, None)
}

fn panes(s: &LibState, id: &str) -> Vec<String> {
    s.splits.iter().find(|g| *g.id == *id).map(|g| g.panes.iter().map(|p| p.to_string()).collect()).unwrap_or_default()
}

fn ratios(s: &LibState, id: &str) -> Vec<f64> {
    s.splits.iter().find(|g| *g.id == *id).map(|g| g.ratios.clone()).unwrap_or_default()
}

#[test]
fn ratios_as_model_ts_makes_them() {
    assert_eq!(normalize_split_ratios(None, 0), Vec::<f64>::new());
    assert_eq!(normalize_split_ratios(None, 3), vec![0.3333; 3]);
    assert_eq!(normalize_split_ratios(Some(&[1.0, 2.0, 3.0]), 3), vec![0.1667, 0.3333, 0.5]);
    assert_eq!(normalize_split_ratios(Some(&[1.0, 2.0]), 3), vec![0.3333; 3], "one per pane, else equal");
    assert_eq!(
        normalize_split_ratios(Some(&[0.0, -1.0, f64::NAN, f64::INFINITY]), 4),
        vec![0.25; 4],
        "not positive and finite: 1"
    );
    assert_eq!(normalize_split_ratios(Some(&[1e308, 1e308]), 2), vec![0.0, 0.0], "a sum past the doubles: Infinity");
    assert_eq!(normalize_split_ratios(Some(&[1.0, 1e-9, 3.0]), 3), vec![0.25, 0.0, 0.75]);
    // 1/20000 is 0.00005 at 4 decimals: rounded up (Math.round), and 19999/20000 to 1.
    assert_eq!(normalize_split_ratios(Some(&[1.0, 19999.0]), 2), vec![0.0001, 1.0]);
    let given = [json!(1), json!(2), json!("3"), json!(null), json!(true)];
    assert_eq!(
        normalize_split_ratios_of(Some(&given), 5),
        vec![0.1667, 0.3333, 0.1667, 0.1667, 0.1667],
        "a payload's: only numbers count"
    );
    assert_eq!(normalize_split_ratios_of(Some(&given[..2]), 5), vec![0.2; 5]);
}

#[test]
fn panes_are_items_by_their_ids() {
    assert_eq!(pane_key("t-1"), Some("t-1"));
    assert_eq!(pane_key(""), None);
    assert_eq!(pane_key("123"), None, "a browser's tab id: no open tab here");
    assert_eq!(pane_key("12a"), Some("12a"));
    assert_eq!(pane_key("12\n"), Some("12\n"), "JS's $ is the end only");
    assert_eq!(pane_key_of(Some(&json!(5))), None);
    assert_eq!(pane_key_of(Some(&json!(["t-1"]))), None);
    assert_eq!(pane_key_of(Some(&json!("t-1"))), Some("t-1"));
    assert_eq!(pane_key_of(None), None);
    let s = split(&lib(), "g", &["t-1", "t-2"]);
    assert!(has_margin_tab(&s, "t-1") && !has_margin_tab(&s, "t-ghost") && !has_margin_tab(&s, "constructor"));
    assert_eq!(split_for_item(&s, "t-2").map(|g| &*g.id), Some("g"));
    assert!(split_for_item(&s, "t-3").is_none());
    assert_eq!(split_for_value(&s, Some(&json!("t-1"))).map(|g| &*g.id), Some("g"));
    assert!(split_for_value(&s, Some(&json!(1))).is_none());
}

#[test]
fn lifecycle_as_split_model_test_runs_it() {
    let s0 = lib();
    let mut s = split(&s0, "sp-1", &["t-1", "t-2"]);
    assert_eq!(shape(&s), vec![("sp-1".into(), vec!["t-1".into(), "t-2".into()], vec![0.5, 0.5], "horizontal")]);
    s = add_to_split(&s, "sp-1", "t-3");
    s = add_to_split(&s, "sp-1", "t-4");
    let four = add_to_split(&s, "sp-1", "t-5");
    assert!(four.same(&s), "a 5th pane is refused: the same state");
    assert_eq!(panes(&s, "sp-1"), ["t-1", "t-2", "t-3", "t-4"]);
    assert_eq!(ratios(&s, "sp-1"), vec![0.25; 4]);
    s = swap_split_panes(&s, "sp-1", 0.0, 1.0);
    assert_eq!(panes(&s, "sp-1"), ["t-2", "t-1", "t-3", "t-4"]);
    s = toggle_split_axis(&s, "sp-1");
    assert_eq!(s.splits[0].axis, Axis::Vertical);
    s = resize_split(&s, "sp-1", Some(&[json!(0.4), json!(0.2), json!(0.2), json!(0.2)]));
    assert_eq!(ratios(&s, "sp-1"), vec![0.4, 0.2, 0.2, 0.2]);
    s = remove_from_split(&s, "sp-1", "t-4");
    assert_eq!(ratios(&s, "sp-1"), vec![0.5, 0.25, 0.25], "the others' ratios kept relative to each other");
    s = remove_from_split(&s, "sp-1", "t-3");
    assert_eq!(s.splits.len(), 1);
    s = remove_from_split(&s, "sp-1", "t-2");
    assert!(s.splits.is_empty(), "dissolved below 2 panes");
}

#[test]
fn create_takes_items_once_and_moves_them() {
    let s = lib();
    assert!(split(&s, "x", &["t-1", "t-ghost"]).same(&s), "a pane of no item: no split");
    assert!(create_split(&s, "x", "zz", &["t-1", "t-2"], Axis::Horizontal, None).same(&s), "no such space");
    let all = ["t-1", "t-2", "t-1", "t-ghost", "123", "", "t-3", "t-4", "t-5"];
    let r: Vec<Value> = (1..=all.len()).map(|i| json!(i)).collect();
    let g = create_split(&s, "g", "a", &all, Axis::Vertical, Some(&r));
    assert_eq!(
        shape(&g),
        vec![("g".into(), vec!["t-1".into(), "t-2".into(), "t-3".into(), "t-4".into()], vec![0.25; 4], "vertical")]
    );
    let r = [json!(1), json!(2), json!(3)];
    assert_eq!(
        ratios(&create_split(&s, "g", "a", &["t-1", "t-2", "t-3"], Axis::Horizontal, Some(&r)), "g"),
        vec![0.1667, 0.3333, 0.5]
    );
    assert_eq!(
        ratios(&create_split(&s, "g", "a", &["t-1", "t-2", "t-ghost"], Axis::Horizontal, Some(&r)), "g"),
        vec![0.5, 0.5],
        "ratios only when every pane is one"
    );
    // A pane of another split leaves it first (that one dissolves with one left).
    let one = split(&s, "a1", &["t-1", "t-2"]);
    let two = split(&one, "a2", &["t-2", "t-3"]);
    assert_eq!(shape(&two).len(), 1);
    assert_eq!(panes(&two, "a2"), ["t-2", "t-3"]);
    let three = split(&add_to_split(&one, "a1", "t-3"), "a2", &["t-3", "t-4"]);
    assert_eq!(
        (panes(&three, "a1"), panes(&three, "a2")),
        (vec!["t-1".to_string(), "t-2".into()], vec!["t-3".to_string(), "t-4".into()])
    );
    let g = &three.splits[1];
    assert!(!g.pinned && g.folder_id.is_none() && g.pos.is_none(), "a new split has no pinned, folderId or pos");
}

#[test]
fn add_and_remove_refuse_as_model_ts() {
    let s = split(&lib(), "g", &["t-1", "t-2"]);
    for (split_id, pane) in [("nope", "t-3"), ("g", "t-ghost"), ("g", "t-1"), ("g", ""), ("g", "7")] {
        assert!(add_to_split(&s, split_id, pane).same(&s), "add {split_id} {pane}");
    }
    for (split_id, pane) in [("nope", "t-1"), ("g", "t-3"), ("g", "")] {
        assert!(remove_from_split(&s, split_id, pane).same(&s), "remove {split_id} {pane}");
    }
    // Into one split out of another.
    let two = split(&s, "h", &["t-3", "t-4"]);
    let moved = add_to_split(&add_to_split(&two, "h", "t-5"), "g", "t-3");
    assert_eq!(
        (panes(&moved, "g"), panes(&moved, "h")),
        (vec!["t-1".to_string(), "t-2".into(), "t-3".into()], vec!["t-4".to_string(), "t-5".into()])
    );
    assert_eq!(ratios(&moved, "g"), vec![0.3333; 3], "added: equal ratios");
}

#[test]
fn swap_resize_toggle_refuse_as_model_ts() {
    let s = split(&add_to_split(&split(&lib(), "g", &["t-1", "t-2"]), "g", "t-3"), "h", &["t-4", "t-5"]);
    let s = resize_split(&s, "g", Some(&[json!(1), json!(2), json!(1)]));
    for (a, b) in [(0.0, 0.0), (-1.0, 0.0), (0.0, 3.0), (3.0, 1.0), (0.0, -0.0), (0.5, 1.0)] {
        assert!(swap_split_panes(&s, "g", a, b).same(&s), "swap {a} {b}");
    }
    assert!(swap_split_panes(&s, "nope", 0.0, 1.0).same(&s));
    let swapped = swap_split_panes(&s, "g", -0.0, 2.0);
    assert_eq!(
        (panes(&swapped, "g"), ratios(&swapped, "g")),
        (vec!["t-3".to_string(), "t-2".into(), "t-1".into()], vec![0.25, 0.5, 0.25])
    );
    assert!(Rc::ptr_eq(&swapped.splits[1], &s.splits[1]), "the other split the same");
    assert!(resize_split(&s, "g", Some(&[json!(1)])).same(&s));
    assert!(resize_split(&s, "g", None).same(&s));
    assert!(resize_split(&s, "nope", Some(&[json!(1), json!(1), json!(1)])).same(&s));
    let same_ratios = resize_split(&s, "g", Some(&[json!(1), json!(2), json!(1)]));
    assert!(!same_ratios.same(&s), "a resize is a new state even when equal (M spreads)");
    assert_eq!(ratios(&resize_split(&s, "g", Some(&[json!(1), json!("x"), json!(-2)])), "g"), vec![0.3333; 3]);
    assert!(toggle_split_axis(&s, "nope").same(&s));
    assert_eq!(toggle_split_axis(&toggle_split_axis(&s, "h"), "h").splits[1].axis, Axis::Horizontal);
}

#[test]
fn settle_keeps_what_holds_and_the_same_state() {
    let s = split(&add_to_split(&split(&lib(), "g", &["t-1", "t-2"]), "g", "t-3"), "h", &["t-4", "t-5"]);
    let s = resize_split(&s, "g", Some(&[json!(1), json!(2), json!(1)]));
    let settled = settle_splits(&s);
    assert!(settled.same(&s), "every split holds: the state itself");
    let none = lib();
    assert!(settle_splits(&none).same(&none), "no splits: the state itself");
    // An item gone: it leaves, the others' ratios kept relative to each other; the other split the same Rc.
    let mut gone = s.clone();
    Rc::make_mut(&mut gone.kept).remove("t-2");
    let after = settle_splits(&gone);
    assert_eq!((panes(&after, "g"), ratios(&after, "g")), (vec!["t-1".to_string(), "t-3".into()], vec![0.5, 0.5]));
    assert!(Rc::ptr_eq(&after.splits[1], &s.splits[1]));
    // One left: the split goes.
    Rc::make_mut(&mut gone.kept).remove("t-5");
    assert_eq!(shape(&settle_splits(&gone)).iter().map(|g| g.0.clone()).collect::<Vec<_>>(), ["g"]);
    // A pane already in an earlier split leaves the later one; twice in one split once; a 5th and a digits id out;
    // ratios of another length made equal.
    let mut odd = s.clone();
    {
        let list = Rc::make_mut(&mut odd.splits);
        let h = Rc::make_mut(&mut list[1]);
        h.panes = ["t-1", "t-4", "t-4", "123", "t-5", "t-6", "t-2", "t-3"].iter().map(|p| Str::from(*p)).collect();
        h.ratios = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
    }
    let fixed = settle_splits(&odd);
    assert_eq!(panes(&fixed, "h"), ["t-4", "t-5", "t-6"]);
    assert_eq!(ratios(&fixed, "h"), vec![0.1539, 0.3846, 0.4615], "the kept ones' ratios relative to each other");
    assert!(Rc::ptr_eq(&fixed.splits[0], &s.splits[0]));
    let mut short = s.clone();
    Rc::make_mut(&mut Rc::make_mut(&mut short.splits)[0]).ratios = vec![0.5, 0.5];
    let fixed = settle_splits(&short);
    assert!(!fixed.same(&short), "ratios of another length: remade");
    assert_eq!(ratios(&fixed, "g"), vec![0.3333; 3]);
}
