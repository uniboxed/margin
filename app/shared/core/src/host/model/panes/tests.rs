//! Cut panes (ported from app/platforms/macos/shell/tests/multi-host-tests.swift's cut-pane cases, their pure parts:
//! the Swift ones stay as the engine's integration tests). The stand-in's display: page 276,41 1228×933 in
//! 0,33 1512×949.

use super::*;
use crate::host::model::Field;

const PAGE: Rect = Rect::new(276.0, 41.0, 1228.0, 933.0);
const AREA: Rect = Rect::new(0.0, 33.0, 1512.0, 949.0);
const LEFT: Rect = Rect::new(276.0, 41.0, 610.0, 933.0);
const RIGHT: Rect = Rect::new(894.0, 41.0, 610.0, 933.0);

fn model() -> HostModel {
    let mut m = HostModel::new();
    m.set_placement(Placement { page: PAGE, area: AREA, display: Rect::new(0.0, 0.0, 1512.0, 982.0) });
    m
}

/// A host shown at `rect` as a pane (None: main at the page area), its own minimum `min`, a tile when `tiled`.
fn pane(m: &mut HostModel, id: &str, rect: Option<Rect>, min: Option<(f64, f64)>, z: i64) -> Handle {
    let h = m.add(id, id, 10 + z, 100 + z);
    m.list(id, Some(h));
    m.set_int(h, Field::Phase, 1);
    m.set_int(h, Field::Tiled, 1);
    let role = if rect.is_some() { Role::Pane } else { Role::Main };
    m.set_int(h, Field::Role, role as i64);
    m.set_rect(h, Field::Rect, rect);
    if let Some((w, ht)) = min {
        m.set_rect(h, Field::MinSize, Some(Rect::new(0.0, 0.0, w, ht)));
    }
    m.layout_set(id, Some(super::super::Visible { rect, role, z }));
    h
}

#[test]
fn a_pane_below_its_minimum_is_cut_its_rest_past_the_displays_edge() {
    let mut m = model();
    let main = pane(&mut m, "edit", Some(LEFT), None, 0);
    let notes = pane(&mut m, "notes", Some(RIGHT), Some((700.0, 400.0)), 1);
    // Its start at its pane's, the rest past the display's edge (a tile: never held within it).
    let start = Rect::new(894.0, 41.0, 700.0, 933.0);
    assert_eq!(m.frame(notes, None), start);
    assert!(m.is_cut(notes) && !m.is_cut(main));
    // Under no pane: its rest is past the display's edge.
    assert!(!m.tucked(notes, None));
    // Not a tile (or tiles off): held within the display, whatever its tile's would be; so is its entry's placement.
    m.set_int(notes, Field::NoTiles, 1);
    assert_eq!(m.frame(notes, None), Rect::new(812.0, 41.0, 700.0, 933.0));
    m.set_int(notes, Field::NoTiles, 0);
    assert_eq!(m.entry_fitted(notes).page, Rect::new(812.0, 41.0, 700.0, 933.0));
    assert_eq!(m.fitted(notes, None).page, start);
}

#[test]
fn held_within_the_display_it_lies_under_the_pane_beside() {
    let mut m = model();
    let main = pane(&mut m, "edit", Some(LEFT), None, 0);
    let notes = pane(&mut m, "notes", Some(RIGHT), Some((700.0, 400.0)), 1);
    // Not a tile: held within the display, its rest under the left pane.
    m.set_int(notes, Field::Tiled, 0);
    assert_eq!(m.frame(notes, None), Rect::new(812.0, 41.0, 700.0, 933.0));
    let mut under = [0; 4];
    assert_eq!(m.lying_under(notes, None, &mut under), 1);
    assert_eq!(under[0], main);
    assert!(m.lies_under(notes, main) && !m.lies_under(main, notes));
    // Over the pane it lies under in the on-screen list (front to back): over; behind it: not; unlisted: not.
    assert!(m.over_under(notes, &[10 + 1, 10]));
    assert!(!m.over_under(notes, &[10, 10 + 1]));
    assert!(!m.over_under(notes, &[10 + 1]));
    // A frame given (a drag's): its own pane's rect alone lies under nothing.
    assert!(!m.tucked(notes, Some(RIGHT)));
    // Its pane changed (a divider moved): its frame follows the pane.
    let narrower = Rect::new(914.0, 41.0, 590.0, 933.0);
    m.set_rect(notes, Field::Rect, Some(narrower));
    assert_eq!(m.frame(notes, None), Rect::new(812.0, 41.0, 700.0, 933.0));
    m.set_int(notes, Field::Tiled, 1);
    assert_eq!(m.frame(notes, None), Rect::new(914.0, 41.0, 700.0, 933.0));
}

#[test]
fn three_panes_a_chain() {
    let mut m = model();
    let a = Rect::new(276.0, 41.0, 404.0, 933.0);
    let b = Rect::new(688.0, 41.0, 404.0, 933.0);
    let c = Rect::new(1100.0, 41.0, 404.0, 933.0);
    let first = pane(&mut m, "edit", Some(a), None, 0);
    let notes = pane(&mut m, "notes", Some(b), Some((700.0, 400.0)), 1);
    let maps = pane(&mut m, "maps", Some(c), Some((600.0, 400.0)), 2);
    assert_eq!(m.frame(notes, None), Rect::new(392.0, 41.0, 700.0, 933.0));
    assert_eq!(m.frame(maps, None), Rect::new(1100.0, 41.0, 600.0, 933.0));
    assert!(m.is_cut(notes) && m.is_cut(maps));
    // The last one not a tile: held within the display, under the middle one, which lies under the first.
    m.set_int(maps, Field::Tiled, 0);
    assert_eq!(m.frame(maps, None), Rect::new(912.0, 41.0, 600.0, 933.0));
    // Each behind the ones it lies under, whatever order they're given in.
    let mut out = [0; 4];
    for given in [[notes, maps], [maps, notes]] {
        assert_eq!(m.tucked_order(&given, &mut out), 2);
        assert_eq!(&out[..2], &[maps, notes], "given {given:?}");
    }
    assert!(!m.tucked(first, None));
}

#[test]
fn tucked_order_as_given_without_a_chain_and_on_a_loop() {
    let mut m = model();
    let a = pane(&mut m, "a", Some(LEFT), Some((700.0, 400.0)), 0);
    let b = pane(&mut m, "b", Some(RIGHT), Some((700.0, 400.0)), 1);
    // Neither a tile, a drag's page area ending at the left pane: the left one's rest past its pane's end (into the
    // right pane), the right one held within the display (into the left pane).
    for h in [a, b] {
        m.set_int(h, Field::Tiled, 0);
    }
    m.set_live_page(Some(LEFT));
    // Each lies under the other (two over each other's): as given.
    assert!(m.lies_under(a, b) && m.lies_under(b, a), "{:?} {:?}", m.frame(a, None), m.frame(b, None));
    let mut out = [0; 4];
    assert_eq!(m.tucked_order(&[a, b], &mut out), 2);
    assert_eq!(&out[..2], &[a, b]);
    assert_eq!(m.tucked_order(&[b, a], &mut out), 2);
    assert_eq!(&out[..2], &[b, a]);
    // One, none: as given.
    assert_eq!(m.tucked_order(&[b], &mut out), 1);
    assert_eq!(out[0], b);
    assert_eq!(m.tucked_order(&[], &mut out), 0);
    m.set_live_page(None);
}

#[test]
fn a_frame_for_each_role_and_mode() {
    let mut m = model();
    let main = m.add("main", "main", 1, 1);
    m.list("main", Some(main));
    // Main with no minimum: the page area; with a wider one: that minimum, its right edge the page area's.
    assert_eq!(m.frame(main, None), PAGE);
    m.set_rect(main, Field::MinSize, Some(Rect::new(0.0, 0.0, 1300.0, 0.0)));
    assert_eq!(m.frame(main, None), Rect::new(204.0, 41.0, 1300.0, 933.0));
    // Zero on both sides: none.
    m.set_rect(main, Field::MinSize, Some(Rect::new(0.0, 0.0, 0.0, 0.0)));
    assert_eq!(m.frame(main, None), PAGE);
    // A card: its rect whatever its minimum; window mode: the page area given.
    let card = Rect::new(400.0, 100.0, 300.0, 200.0);
    m.set_rect(main, Field::MinSize, Some(Rect::new(0.0, 0.0, 1300.0, 0.0)));
    m.set_rect(main, Field::Rect, Some(card));
    m.set_int(main, Field::Role, Role::Card as i64);
    assert_eq!(m.frame(main, None), card);
    assert!(!m.is_cut(main));
    m.set_int(main, Field::Mode, 1);
    let other = Placement { page: LEFT, ..m.placement() };
    assert_eq!(m.frame(main, Some(&other)), LEFT);
    // A drag's page area: a split's pane laid out away from the others within it (at the page's end: its start).
    let p = pane(&mut m, "p", Some(Rect::new(894.0, 41.0, 400.0, 933.0)), Some((500.0, 0.0)), 1);
    assert_eq!(m.frame(p, None).min_x(), 794.0, "not at the page's end: its end at its pane's");
    m.set_live_page(Some(Rect::new(276.0, 41.0, 1018.0, 933.0)));
    assert_eq!(m.frame(p, None).min_x(), 894.0, "at the drag's page's end: its start at its pane's");
    m.set_live_page(None);
    // Its tile's rect from Margin's own tile.
    let home = Rect::new(0.0, 0.0, 1512.0, 982.0);
    assert!(m.tile_rect(p, None, &home).is_some());
}

#[test]
fn an_apps_kept_minimum_with_its_version_unread_is_noted() {
    let mut m = model();
    let h = pane(&mut m, "notes", Some(RIGHT), Some((700.0, 400.0)), 0);
    assert!(m.remember_min(h, Some("1.0")));
    // Another of the same app, its own minimum unread, its version unread: its app's kept one used, it noted.
    let o = pane(&mut m, "notes2", Some(LEFT), None, 1);
    m.get_mut(o).unwrap().app = "notes".into();
    m.versions_clear();
    assert_eq!(m.frame(o, None).width, 700.0);
    let mut out = [0; 8];
    assert_eq!(m.versions_wanted(&mut out), 1);
    assert_eq!(out[0], o);
    // Its version read (another one): none of its app's kept then.
    m.set_version(o, "2.0");
    m.versions_clear();
    assert_eq!(m.frame(o, None), LEFT);
    assert_eq!(m.versions_wanted(&mut out), 0);
}
