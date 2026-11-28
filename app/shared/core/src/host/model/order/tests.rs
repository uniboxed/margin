//! The window order's rules (ported from app/platforms/macos/shell/tests/pane-fronting-tests.swift and
//! multi-host-tests.swift's order cases, their pure parts: the Swift ones stay as the engine's integration tests).

use super::*;
use crate::host::layout::Placement;
use crate::host::model::{Field, Role, Visible};

const PAGE: Rect = Rect::new(276.0, 41.0, 1228.0, 933.0);
const LEFT: Rect = Rect::new(276.0, 41.0, 610.0, 933.0);
const RIGHT: Rect = Rect::new(894.0, 41.0, 610.0, 933.0);

fn model() -> HostModel {
    let mut m = HostModel::new();
    m.set_placement(Placement {
        page: PAGE,
        area: Rect::new(0.0, 33.0, 1512.0, 949.0),
        display: Rect::new(0.0, 0.0, 1512.0, 982.0),
    });
    m
}

/// A visible host as `id` at `rect` (None: main at the page area), its window `10 + z`, a tile.
fn host(m: &mut HostModel, id: &str, rect: Option<Rect>, role: Role, z: i64) -> Handle {
    let h = m.add(id, id, 10 + z, 100 + z);
    m.list(id, Some(h));
    m.set_int(h, Field::Phase, 1);
    m.set_int(h, Field::Tiled, 1);
    m.set_int(h, Field::Role, role as i64);
    m.set_rect(h, Field::Rect, rect);
    m.layout_set(id, Some(Visible { rect, role, z }));
    h
}

fn windows(m: &HostModel, hs: &[Handle]) -> Vec<i64> {
    hs.iter().map(|h| m.get(*h).unwrap().window).collect()
}

#[test]
fn the_server_order_of_the_wanted_windows() {
    let mut out = [0; 4];
    // Back to front, from a front-to-back list with others in it.
    assert_eq!(server_order(&[10, 11], &[5, 11, 7, 10, 3], &mut out), Some(2));
    assert_eq!(&out[..2], &[10, 11]);
    // One missing, or one listed twice: unread.
    assert_eq!(server_order(&[10, 11], &[11, 3], &mut out), None);
    assert_eq!(server_order(&[10, 11], &[11, 10, 11], &mut out), None);
    // The same window wanted twice (never): counted once.
    assert_eq!(server_order(&[10, 10], &[10], &mut out), Some(1));
}

#[test]
fn side_by_side_panes_need_no_order_only_the_keys() {
    let mut m = model();
    let main = host(&mut m, "main", Some(LEFT), Role::Main, 0);
    let pane = host(&mut m, "pane", Some(RIGHT), Role::Pane, 1);
    m.set_shown(Some("pane"), 1.0);
    // Stand-alone windows (no toolbar's room): side by side with an 8 pt gap, nothing overlaps.
    for h in [main, pane] {
        m.set_int(h, Field::Mode, 1);
    }
    let mut out = [0; 4];
    assert_eq!(m.front_wanted(&mut out), 2);
    assert_eq!(&out[..2], &[main, pane]);
    // Whatever the server's order: the keys only.
    for order in [None, Some(vec![11i64, 10]), Some(vec![10, 11])] {
        let p = m.front_plan(&[None, None], order.as_deref(), &[]);
        assert!(p.keys && p.raises.is_empty() && p.confirm == Confirm::None, "{order:?}: {p:?}");
        assert_eq!(p.focused, Some(pane));
    }
}

#[test]
fn a_card_over_main_raised_when_out_of_order_then_confirmed() {
    let mut m = model();
    let main = host(&mut m, "main", None, Role::Main, 0);
    let card = host(&mut m, "card", Some(Rect::new(400.0, 100.0, 800.0, 700.0)), Role::Card, 1);
    m.set_shown(Some("card"), 1.0);
    let w = windows(&m, &[main, card]);
    // In order (the card in front, the server's back to front): the keys only.
    let p = m.front_plan(&[None, None], Some(&w), &[]);
    assert!(p.keys && p.raises.is_empty(), "{p:?}");
    // Out of order: every one from the first out of place raised, back to front, the focused one last; confirmed
    // after; a fresh one out and back.
    let behind = [w[1], w[0]];
    let p = m.front_plan(&[None, None], Some(&behind), &[]);
    assert_eq!(p.raises, vec![(main, None), (card, None)]);
    assert!(!p.keys && p.confirm == Confirm::Wait && p.below_top == vec![0], "{p:?}");
    assert_eq!(m.front_plan(&[None, None], Some(&behind), &[card]).confirm, Confirm::Fresh);
    // Unread: as if out of order.
    assert_eq!(m.front_plan(&[None, None], None, &[]).raises.len(), 2);
    // The confirm: behind while the server's order has main in front of it; unread: not behind.
    assert!(top_behind(&w, &p.below_top, Some(&[w[0], w[1]])));
    assert!(!top_behind(&w, &p.below_top, Some(&[w[1], w[0]])));
    assert!(!top_behind(&w, &p.below_top, None));
    assert!(!top_behind(&w, &p.below_top, Some(&[w[1]])));
}

#[test]
fn a_full_screen_windows_toolbar_room_counts() {
    let mut m = model();
    // Stacked with an 8 pt gap: the lower one's toolbar room (52) reaches into the upper one.
    let top = Rect::new(276.0, 41.0, 1228.0, 400.0);
    let low = Rect::new(276.0, 449.0, 1228.0, 525.0);
    let a = host(&mut m, "a", Some(top), Role::Main, 0);
    let b = host(&mut m, "b", Some(low), Role::Pane, 1);
    m.set_shown(Some("b"), 1.0);
    assert_eq!(m.overlapping(&[a, b], &[None, None]), vec![(0, 1)]);
    // Across a 52 pt band: just meeting, nothing over the tolerance.
    m.set_rect(b, Field::Rect, Some(Rect::new(276.0, 493.0, 1228.0, 481.0)));
    assert!(m.overlapping(&[a, b], &[None, None]).is_empty());
    // A window's bounds past its frame count too.
    let reach = Rect::new(276.0, 400.0, 1228.0, 200.0);
    assert_eq!(m.overlapping(&[a, b], &[None, Some(reach)]), vec![(0, 1)]);
    // Window mode: no toolbar's room.
    m.set_rect(b, Field::Rect, Some(low));
    m.set_int(b, Field::Mode, 1);
    assert!(m.overlapping(&[a, b], &[None, None]).is_empty());
    m.opts.toolbar_room = 0.0;
    m.set_int(b, Field::Mode, 0);
    assert!(m.overlapping(&[a, b], &[None, None]).is_empty());
}

#[test]
fn a_cut_pane_lying_under_another_is_kept_behind_it_and_given_the_keys() {
    let mut m = model();
    let edit = host(&mut m, "edit", Some(LEFT), Role::Main, 0);
    let notes = host(&mut m, "notes", Some(RIGHT), Role::Pane, 1);
    m.set_rect(notes, Field::MinSize, Some(Rect::new(0.0, 0.0, 700.0, 400.0)));
    // Not a tile: held within the display, it lies under the left pane.
    m.set_int(notes, Field::Tiled, 0);
    m.set_shown(Some("notes"), 1.0);
    let mut out = [0; 4];
    assert_eq!(m.front_wanted(&mut out), 2);
    assert_eq!(&out[..2], &[notes, edit], "the cut one behind, focused or not");
    let w = windows(&m, &[notes, edit]);
    // In order: its keys, without a raise (it's cut).
    let p = m.front_plan(&[None, None], Some(&w), &[]);
    assert!(p.keys && p.cut_focused && p.raises.is_empty(), "{p:?}");
    // Its window over the pane it lies under: the pane raised over it (a raise over), never the cut one; its keys.
    let p = m.front_plan(&[None, None], Some(&[w[1], w[0]]), &[]);
    assert_eq!(p.raises, vec![(edit, Some(notes))]);
    assert!(p.keys && p.confirm == Confirm::None, "{p:?}");
    // The other focused: the cut one still behind, the left pane raised over it, then confirmed.
    m.set_shown(Some("edit"), 2.0);
    let p = m.front_plan(&[None, None], Some(&[w[1], w[0]]), &[]);
    assert_eq!(p.wanted, vec![notes, edit]);
    assert_eq!(p.raises, vec![(edit, Some(notes))]);
    assert_eq!(p.confirm, Confirm::Wait);
}

#[test]
fn nothing_raised_over_the_focused_one_in_front() {
    let mut m = model();
    // A card in front of two panes (focused), the two panes stacked over each other's toolbar room and out of order.
    let a = host(&mut m, "a", Some(Rect::new(276.0, 41.0, 1228.0, 400.0)), Role::Main, 0);
    let b = host(&mut m, "b", Some(Rect::new(276.0, 449.0, 1228.0, 525.0)), Role::Pane, 1);
    let c = host(&mut m, "c", Some(Rect::new(1000.0, 600.0, 300.0, 200.0)), Role::Card, 2);
    m.set_shown(Some("c"), 1.0);
    let w = windows(&m, &[a, b, c]);
    let pairs = m.overlapping(&[a, b, c], &[None, None, None]);
    assert_eq!(pairs, vec![(0, 1), (1, 2)]);
    // The card in front of the pane it overlaps, a and b out of order: b overlaps the card, so nothing's raised (it
    // would go over the card); the keys.
    let p = m.front_plan(&[None, None, None], Some(&[w[1], w[0], w[2]]), &[]);
    assert!(p.keys && p.raises.is_empty(), "{p:?}");
    // The card behind b: everything from the first out of place that overlaps another raised, the card last.
    let p = m.front_plan(&[None, None, None], Some(&[w[0], w[2], w[1]]), &[]);
    assert_eq!(p.raises, vec![(b, None), (c, None)]);
    assert_eq!(p.confirm, Confirm::Wait);
}

#[test]
fn two_cut_panes_out_of_order_raised_both() {
    let mut m = model();
    let a = Rect::new(276.0, 41.0, 404.0, 933.0);
    let b = Rect::new(688.0, 41.0, 404.0, 933.0);
    let c = Rect::new(1100.0, 41.0, 404.0, 933.0);
    let first = host(&mut m, "edit", Some(a), Role::Main, 0);
    let notes = host(&mut m, "notes", Some(b), Role::Pane, 1);
    let maps = host(&mut m, "maps", Some(c), Role::Pane, 2);
    m.set_rect(notes, Field::MinSize, Some(Rect::new(0.0, 0.0, 700.0, 400.0)));
    m.set_rect(maps, Field::MinSize, Some(Rect::new(0.0, 0.0, 600.0, 400.0)));
    // The last one not a tile: held within the display, under the middle one.
    m.set_int(maps, Field::Tiled, 0);
    m.set_shown(Some("edit"), 1.0);
    let wanted = m.front_plan(&[None, None, None], None, &[]).wanted;
    assert_eq!(wanted, vec![maps, notes, first], "a chain: the last under the middle one, under the first");
    let w = windows(&m, &wanted);
    // The two cut ones out of order (the middle one behind the last): every one from there raised, cut ones too.
    let p = m.front_plan(&[None, None, None], Some(&[w[1], w[0], w[2]]), &[]);
    assert_eq!(p.raises, vec![(maps, None), (notes, Some(maps)), (first, Some(notes))]);
    assert_eq!(p.confirm, Confirm::Wait);
}
