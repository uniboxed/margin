//! A split's tree (docs/FLEX-SPLIT.md step 3): extension/shared/split-tree.ts transliterated, function by function,
//! with its names (the types are state.rs's [`SplitNode`] and [`SplitKid`]). A split stores its tree only when it's
//! nested; a flat one is stored as it always was, and its tree is read from that (`tree_of`). A nested split keeps its
//! `panes` (the leaves in order) and `axis` (its root's), and `ratios` holds each pane's share of the whole area.
//!
//! Every ratio list is normalised as the TS does it and only where it does (normalising twice isn't the same as once
//! at 4 decimals: 0.3333 thrice becomes 0.3334).

use serde_json::Value;

use super::splits::normalize_split_ratios;
use crate::library::js;
use crate::library::state::{Axis, MAX_SPLIT_PANES, SplitKid, SplitNode, Str};

/// A side a leaf goes beside another on (`SplitSide`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

impl Side {
    /// `['left', 'right', 'top', 'bottom'].includes(v)`: that side; none for anything else.
    pub fn of(v: Option<&Value>) -> Option<Side> {
        match v.and_then(Value::as_str)? {
            "left" => Some(Side::Left),
            "right" => Some(Side::Right),
            "top" => Some(Side::Top),
            "bottom" => Some(Side::Bottom),
            _ => None,
        }
    }
}

/// `normalizeRatios(ratios, count)` for numbers (each finite and positive, else 1; one a kid, else 1 each).
#[inline]
pub fn normalize_ratios(ratios: &[f64], count: usize) -> Vec<f64> {
    normalize_split_ratios(Some(ratios), count)
}

/// `leavesOf(k)`: its leaves, in order.
pub fn leaves_of(k: &SplitKid) -> Vec<Str> {
    let mut out = Vec::new();
    push_leaves(k, &mut out);
    out
}

fn push_leaves(k: &SplitKid, out: &mut Vec<Str>) {
    match k {
        SplitKid::Leaf(s) => out.push(s.clone()),
        SplitKid::Node(n) => n.kids.iter().for_each(|kid| push_leaves(kid, out)),
    }
}

/// `leavesOf(node)` for a node.
pub fn leaves_of_node(n: &SplitNode) -> Vec<Str> {
    let mut out = Vec::new();
    n.kids.iter().for_each(|kid| push_leaves(kid, &mut out));
    out
}

/// `areaShares(node)`: each leaf's share of the whole (the ratios along its path multiplied), in order, normalised.
pub fn area_shares(node: &SplitNode) -> Vec<f64> {
    fn walk(n: &SplitNode, share: f64, out: &mut Vec<f64>) {
        let r = normalize_ratios(&n.ratios, n.kids.len());
        for (i, kid) in n.kids.iter().enumerate() {
            match kid {
                SplitKid::Leaf(_) => out.push(share * r[i]),
                SplitKid::Node(inner) => walk(inner, share * r[i], out),
            }
        }
    }
    let mut out = Vec::new();
    walk(node, 1.0, &mut out);
    let n = out.len();
    normalize_ratios(&out, n)
}

/// `canonical(k)`: a node of one kid is that kid, a node kid running its parent's way merged into it (its kids taking
/// its ratio between them), every node's ratios normalised. None: nothing left.
pub fn canonical(k: &SplitKid) -> Option<SplitKid> {
    let n = match k {
        SplitKid::Leaf(s) => return Some(SplitKid::Leaf(s.clone())),
        SplitKid::Node(n) => n,
    };
    let ratios = normalize_ratios(&n.ratios, n.kids.len());
    let mut kids: Vec<SplitKid> = Vec::new();
    let mut weights: Vec<f64> = Vec::new();
    for (i, raw) in n.kids.iter().enumerate() {
        let Some(kid) = canonical(raw) else { continue };
        match kid {
            SplitKid::Node(inner) if inner.axis == n.axis => {
                let r = normalize_ratios(&inner.ratios, inner.kids.len());
                for (j, g) in inner.kids.into_iter().enumerate() {
                    kids.push(g);
                    weights.push(ratios[i] * r[j]);
                }
            }
            kid => {
                kids.push(kid);
                weights.push(ratios[i]);
            }
        }
    }
    match kids.len() {
        0 => None,
        1 => kids.pop(),
        len => Some(SplitKid::Node(SplitNode { axis: n.axis, ratios: normalize_ratios(&weights, len), kids })),
    }
}

/// `storedTree(tree, panes)` for a payload's (or the store's) JSON: the tree when it's one for `panes` (every node a
/// known axis other than its parent's, 2 kids or more, a positive finite number a kid as its ratio, every leaf a string
/// that isn't empty; its leaves `panes` in order; a kid of its root a node), kept as `copyTree` keeps it (its axes,
/// kids and ratios only); none else.
pub fn stored_tree(tree: Option<&Value>, panes: &[Str]) -> Option<SplitNode> {
    fn copy(v: &Value, parent: Option<Axis>) -> Option<SplitKid> {
        match v {
            Value::String(s) => (!s.is_empty()).then(|| SplitKid::Leaf(Str::from(s.as_str()))),
            Value::Object(o) => {
                let axis = match o.get("axis").and_then(Value::as_str) {
                    Some("horizontal") => Axis::Horizontal,
                    Some("vertical") => Axis::Vertical,
                    _ => return None,
                };
                if Some(axis) == parent {
                    return None;
                }
                let kids = o.get("kids").and_then(Value::as_array)?;
                let ratios = o.get("ratios").and_then(Value::as_array)?;
                if kids.len() < 2 || ratios.len() != kids.len() {
                    return None;
                }
                let ratios: Vec<f64> =
                    ratios.iter().map(|r| js::finite(Some(r)).filter(|r| *r > 0.0)).collect::<Option<_>>()?;
                let kids: Vec<SplitKid> = kids.iter().map(|k| copy(k, Some(axis))).collect::<Option<_>>()?;
                Some(SplitKid::Node(SplitNode { axis, kids, ratios }))
            }
            _ => None,
        }
    }
    let Some(SplitKid::Node(node)) = tree.and_then(|t| t.is_object().then_some(t)).and_then(|t| copy(t, None)) else {
        return None;
    };
    holds(&node, panes).then_some(node)
}

/// Whether a tree held as one still is one for `panes` (`storedTree` on the state's own tree: `nestedTree`).
pub fn checked(node: &SplitNode, panes: &[Str]) -> bool {
    fn ok(n: &SplitNode, parent: Option<Axis>) -> bool {
        Some(n.axis) != parent
            && n.kids.len() >= 2
            && n.ratios.len() == n.kids.len()
            && n.ratios.iter().all(|r| r.is_finite() && *r > 0.0)
            && n.kids.iter().all(|kid| match kid {
                SplitKid::Leaf(s) => !s.is_empty(),
                SplitKid::Node(k) => ok(k, Some(n.axis)),
            })
    }
    ok(node, None) && holds(node, panes)
}

/// Its leaves `panes` in order, and a kid of its root a node (a flat one is never a tree).
fn holds(node: &SplitNode, panes: &[Str]) -> bool {
    let leaves = leaves_of_node(node);
    leaves.len() == panes.len()
        && leaves.iter().zip(panes).all(|(l, p)| **l == **p)
        && node.kids.iter().any(|k| matches!(k, SplitKid::Node(_)))
}

/// `treeOf(g)` for a flat split: one node of its panes, its ratios normalised.
pub fn flat_tree(axis: Axis, panes: &[Str], ratios: &[f64]) -> SplitNode {
    SplitNode {
        axis,
        kids: panes.iter().map(|p| SplitKid::Leaf(p.clone())).collect(),
        ratios: normalize_ratios(ratios, panes.len()),
    }
}

/// What `storedOf(k)` gives: the split's axis, panes, ratios, and its tree when it's nested.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub axis: Axis,
    pub panes: Vec<Str>,
    pub ratios: Vec<f64>,
    pub tree: Option<SplitNode>,
}

/// `storedOf(k)`: what a split stores for `k` (canonical first): flat, its axis, panes and ratios (no tree); nested,
/// also its tree, with each pane's share of the area as its ratio. None: fewer than 2 panes.
pub fn stored_of(k: Option<SplitKid>) -> Option<Stored> {
    let SplitKid::Node(c) = canonical(&k?)? else { return None };
    let panes = leaves_of_node(&c);
    if !c.kids.iter().any(|k| matches!(k, SplitKid::Node(_))) {
        return Some(Stored { axis: c.axis, panes, ratios: c.ratios, tree: None });
    }
    Some(Stored { axis: c.axis, panes, ratios: area_shares(&c), tree: Some(c) })
}

/// `mapLeaves(k, f)`: `k` with each leaf as `f` makes it (none: gone); a node left with no kid is none.
pub fn map_leaves(k: &SplitKid, f: &mut impl FnMut(&Str) -> Option<SplitKid>) -> Option<SplitKid> {
    let n = match k {
        SplitKid::Leaf(s) => return f(s),
        SplitKid::Node(n) => n,
    };
    let mut kids = Vec::new();
    let mut ratios = Vec::new();
    for (i, kid) in n.kids.iter().enumerate() {
        if let Some(m) = map_leaves(kid, f) {
            kids.push(m);
            ratios.push(n.ratios.get(i).copied().unwrap_or(1.0));
        }
    }
    (!kids.is_empty()).then_some(SplitKid::Node(SplitNode { axis: n.axis, kids, ratios }))
}

/// `besideLeaf(k, target, side, leaf)`: `leaf` beside `target` on `side`: in the target's node when it runs that way
/// (the two sharing the target's ratio, half each), else the target split into a node of the two across it (half
/// each). None: `target` isn't a leaf of `k`.
pub fn beside_leaf(k: &SplitNode, target: &str, side: Side, leaf: &Str) -> Option<SplitNode> {
    let axis = if matches!(side, Side::Left | Side::Right) { Axis::Horizontal } else { Axis::Vertical };
    let first = matches!(side, Side::Left | Side::Top);
    fn walk(n: &SplitNode, target: &str, axis: Axis, first: bool, leaf: &Str, found: &mut bool) -> SplitNode {
        let mut kids = Vec::new();
        let mut ratios = Vec::new();
        let own = normalize_ratios(&n.ratios, n.kids.len());
        for (i, kid) in n.kids.iter().enumerate() {
            if let SplitKid::Leaf(id) = kid
                && **id == *target
                && !*found
            {
                *found = true;
                let new = SplitKid::Leaf(leaf.clone());
                let pair = if first { [new, kid.clone()] } else { [kid.clone(), new] };
                if n.axis == axis {
                    for p in pair {
                        kids.push(p);
                        ratios.push(own[i] / 2.0);
                    }
                } else {
                    kids.push(SplitKid::Node(SplitNode { axis, kids: pair.to_vec(), ratios: vec![0.5, 0.5] }));
                    ratios.push(own[i]);
                }
                continue;
            }
            kids.push(match kid {
                SplitKid::Node(inner) => SplitKid::Node(walk(inner, target, axis, first, leaf, found)),
                leaf => leaf.clone(),
            });
            ratios.push(own[i]);
        }
        SplitNode { axis: n.axis, kids, ratios }
    }
    let mut found = false;
    let out = walk(k, target, axis, first, leaf, &mut found);
    found.then_some(out)
}

/// `nodeAt(k, path)`: the node at `path` (each a kid's index from the root); none: not a node there.
pub fn node_at<'a>(k: &'a SplitNode, path: &[usize]) -> Option<&'a SplitNode> {
    let mut n = k;
    for &i in path {
        match n.kids.get(i)? {
            SplitKid::Node(inner) => n = inner,
            // (A leaf there: a path past it is no node; one ending at it isn't either.)
            SplitKid::Leaf(_) => return None,
        }
    }
    Some(n)
}

/// `withNodeAt(k, path, f)`: `k` with the node at `path` as `f` makes it; none: no node there.
pub fn with_node_at(k: &SplitNode, path: &[usize], f: impl FnOnce(&SplitNode) -> SplitNode) -> Option<SplitNode> {
    node_at(k, path)?;
    fn go(n: &SplitNode, path: &[usize], f: impl FnOnce(&SplitNode) -> SplitNode) -> SplitNode {
        let Some((&i, rest)) = path.split_first() else { return f(n) };
        let mut kids = n.kids.clone();
        if let Some(SplitKid::Node(inner)) = n.kids.get(i) {
            kids[i] = SplitKid::Node(go(inner, rest, f));
        }
        SplitNode { axis: n.axis, kids, ratios: n.ratios.clone() }
    }
    Some(go(k, path, f))
}

/// `turned(k)`: every node's axis the other way, with all that's in it.
pub fn turned(k: &SplitNode) -> SplitNode {
    SplitNode {
        axis: if k.axis == Axis::Vertical { Axis::Horizontal } else { Axis::Vertical },
        kids: k
            .kids
            .iter()
            .map(|kid| match kid {
                SplitKid::Node(n) => SplitKid::Node(turned(n)),
                leaf => leaf.clone(),
            })
            .collect(),
        ratios: k.ratios.clone(),
    }
}

/// `pathOf(v)`: a node path as a payload gives it: an array of at most [`MAX_SPLIT_PANES`] whole numbers 0 or more
/// (`Number.isInteger`, -0 is 0; one past any index reads as none there); none: not one.
pub fn path_of(v: Option<&Value>) -> Option<Vec<usize>> {
    let list = v?.as_array()?;
    if list.len() > MAX_SPLIT_PANES {
        return None;
    }
    list.iter()
        .map(|i| {
            let n = i.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)?;
            // (`as` saturates: a whole number past any count is no kid's index.)
            Some(n as usize)
        })
        .collect()
}

/// A tree as the store and the UI's snapshot write it (`{ axis, kids, ratios }`), its numbers by `number`.
pub fn tree_value(n: &SplitNode, number: &impl Fn(f64) -> Value) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("axis".into(), n.axis.as_str().into());
    o.insert(
        "kids".into(),
        Value::Array(
            n.kids
                .iter()
                .map(|k| match k {
                    SplitKid::Leaf(s) => Value::from(&**s),
                    SplitKid::Node(inner) => tree_value(inner, number),
                })
                .collect(),
        ),
    );
    o.insert("ratios".into(), Value::Array(n.ratios.iter().map(|r| number(*r)).collect()));
    Value::Object(o)
}

#[cfg(test)]
#[path = "split_tree_tests.rs"]
mod tests;
