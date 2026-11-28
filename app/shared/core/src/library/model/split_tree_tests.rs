// A split's tree (split_tree.rs): tests/split-tree.test.ts's cases of the rules, as the core answers them.

use super::*;
use serde_json::json;

fn leaf(s: &str) -> SplitKid {
    SplitKid::Leaf(Str::from(s))
}
fn node(axis: Axis, kids: Vec<SplitKid>, ratios: &[f64]) -> SplitNode {
    SplitNode { axis, kids, ratios: ratios.to_vec() }
}
fn strs(list: &[&str]) -> Vec<Str> {
    list.iter().map(|s| Str::from(*s)).collect()
}
use Axis::{Horizontal as H, Vertical as V};

#[test]
fn canonical_form() {
    assert_eq!(canonical(&SplitKid::Node(node(H, vec![leaf("a")], &[1.0]))), Some(leaf("a")));
    let merged = canonical(&SplitKid::Node(node(
        H,
        vec![leaf("a"), SplitKid::Node(node(H, vec![leaf("b"), leaf("c")], &[1.0, 3.0]))],
        &[1.0, 1.0],
    )));
    assert_eq!(merged, Some(SplitKid::Node(node(H, vec![leaf("a"), leaf("b"), leaf("c")], &[0.5, 0.125, 0.375]))));
    let one = canonical(&SplitKid::Node(node(
        H,
        vec![leaf("a"), SplitKid::Node(node(V, vec![leaf("b")], &[1.0]))],
        &[3.0, 1.0],
    )));
    assert_eq!(one, Some(SplitKid::Node(node(H, vec![leaf("a"), leaf("b")], &[0.75, 0.25]))));
    assert_eq!(canonical(&SplitKid::Node(node(V, vec![], &[]))), None);
}

#[test]
fn stored_flat_as_before_nested_with_area_shares() {
    let flat = stored_of(Some(SplitKid::Node(node(H, vec![leaf("a"), leaf("b")], &[0.6, 0.4])))).unwrap();
    assert_eq!(flat, Stored { axis: H, panes: strs(&["a", "b"]), ratios: vec![0.6, 0.4], tree: None });
    let nested =
        node(H, vec![leaf("a"), SplitKid::Node(node(V, vec![leaf("b"), leaf("c")], &[0.5, 0.5]))], &[0.5, 0.5]);
    let s = stored_of(Some(SplitKid::Node(nested.clone()))).unwrap();
    assert_eq!(
        s,
        Stored { axis: H, panes: strs(&["a", "b", "c"]), ratios: vec![0.5, 0.25, 0.25], tree: Some(nested.clone()) }
    );
    assert_eq!(area_shares(&nested), vec![0.5, 0.25, 0.25]);
    assert_eq!(leaves_of_node(&nested), strs(&["a", "b", "c"]));
    assert_eq!(stored_of(Some(leaf("a"))), None, "one pane: no split");
}

#[test]
fn a_stored_tree_read_only_when_its_one_for_the_panes() {
    let good = json!({ "axis": "horizontal", "kids": ["a", { "axis": "vertical", "kids": ["b", "c"], "ratios": [0.5, 0.5] }], "ratios": [0.5, 0.5], "extra": 1 });
    let typed = node(H, vec![leaf("a"), SplitKid::Node(node(V, vec![leaf("b"), leaf("c")], &[0.5, 0.5]))], &[0.5, 0.5]);
    assert_eq!(stored_tree(Some(&good), &strs(&["a", "b", "c"])), Some(typed.clone()), "kept as copyTree keeps it");
    assert!(checked(&typed, &strs(&["a", "b", "c"])));
    assert_eq!(stored_tree(Some(&good), &strs(&["a", "c", "b"])), None, "another order");
    assert_eq!(stored_tree(Some(&good), &strs(&["a", "b"])), None, "other panes");
    let bad = [
        json!({ "axis": "horizontal", "kids": ["a", "b"], "ratios": [1, 1] }),
        json!({ "axis": "horizontal", "kids": ["a", { "axis": "horizontal", "kids": ["b", "c"], "ratios": [1, 1] }], "ratios": [1, 1] }),
        json!({ "axis": "diagonal", "kids": ["a", { "axis": "vertical", "kids": ["b", "c"], "ratios": [1, 1] }], "ratios": [1, 1] }),
        json!({ "axis": "horizontal", "kids": ["a", { "axis": "vertical", "kids": ["b", "c"], "ratios": [1, -1] }], "ratios": [1, 1] }),
        json!({ "axis": "horizontal", "kids": ["a", { "axis": "vertical", "kids": ["b", "c"], "ratios": [1, "1"] }], "ratios": [1, 1] }),
        json!({ "axis": "horizontal", "kids": ["", { "axis": "vertical", "kids": ["b", "c"], "ratios": [1, 1] }], "ratios": [1, 1] }),
        json!("a"),
        json!([1]),
    ];
    for b in bad {
        assert_eq!(stored_tree(Some(&b), &strs(&["a", "b", "c"])), None, "{b}");
    }
    assert_eq!(flat_tree(V, &strs(&["a", "b"]), &[0.7, 0.3]), node(V, vec![leaf("a"), leaf("b")], &[0.7, 0.3]));
}

#[test]
fn beside_a_pane() {
    let flat = node(H, vec![leaf("a"), leaf("b")], &[0.5, 0.5]);
    let c = Str::from("c");
    assert_eq!(
        beside_leaf(&flat, "b", Side::Right, &c),
        Some(node(H, vec![leaf("a"), leaf("b"), leaf("c")], &[0.5, 0.25, 0.25]))
    );
    assert_eq!(
        beside_leaf(&flat, "a", Side::Left, &c),
        Some(node(H, vec![leaf("c"), leaf("a"), leaf("b")], &[0.25, 0.25, 0.5]))
    );
    let below = beside_leaf(&flat, "b", Side::Bottom, &c).unwrap();
    assert_eq!(
        below,
        node(H, vec![leaf("a"), SplitKid::Node(node(V, vec![leaf("b"), leaf("c")], &[0.5, 0.5]))], &[0.5, 0.5])
    );
    assert_eq!(
        beside_leaf(&flat, "a", Side::Top, &c),
        Some(node(H, vec![SplitKid::Node(node(V, vec![leaf("c"), leaf("a")], &[0.5, 0.5])), leaf("b")], &[0.5, 0.5]))
    );
    assert_eq!(beside_leaf(&flat, "x", Side::Top, &c), None);
    let d = Str::from("d");
    assert_eq!(
        beside_leaf(&below, "c", Side::Bottom, &d),
        Some(node(
            H,
            vec![leaf("a"), SplitKid::Node(node(V, vec![leaf("b"), leaf("c"), leaf("d")], &[0.5, 0.25, 0.25]))],
            &[0.5, 0.5]
        ))
    );
    assert_eq!(Side::of(Some(&json!("bottom"))), Some(Side::Bottom));
    assert_eq!(Side::of(Some(&json!("above"))), None);
}

#[test]
fn turned_paths_and_nodes() {
    let n = node(H, vec![leaf("a"), SplitKid::Node(node(V, vec![leaf("b"), leaf("c")], &[1.0, 1.0]))], &[1.0, 1.0]);
    assert_eq!(
        turned(&n),
        node(V, vec![leaf("a"), SplitKid::Node(node(H, vec![leaf("b"), leaf("c")], &[1.0, 1.0]))], &[1.0, 1.0])
    );
    assert_eq!(path_of(Some(&json!([0, 1]))), Some(vec![0, 1]));
    assert_eq!(path_of(Some(&json!([]))), Some(vec![]));
    assert_eq!(path_of(Some(&json!([-0.0]))), Some(vec![0]));
    for bad in [json!([-1]), json!([0.5]), json!(["1"]), json!(3), json!(null), json!({}), json!(vec![0; 17])] {
        assert_eq!(path_of(Some(&bad)), None, "{bad}");
    }
    assert_eq!(node_at(&n, &[1]).map(|x| x.axis), Some(V));
    assert_eq!(node_at(&n, &[0]), None, "a leaf");
    assert_eq!(node_at(&n, &[5]), None);
    let resized = with_node_at(&n, &[1], |x| SplitNode { ratios: vec![1.0, 3.0], ..x.clone() }).unwrap();
    assert_eq!(node_at(&resized, &[1]).unwrap().ratios, vec![1.0, 3.0]);
    assert_eq!(with_node_at(&n, &[0], |x| x.clone()), None);
    assert_eq!(MAX_SPLIT_PANES, 16);
}
