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

fn sides(bits: Option<u8>) -> Option<Vec<Side>> {
    bits.map(|b| Side::ALL.into_iter().filter(|s| b & s.bit() != 0).collect())
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
    assert_eq!(sides(m.cut_of(notes)), Some(vec![Side::Right]));
    assert_eq!(m.cut_of(main), None);
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
fn a_slide_shows_its_other_side_and_tucks_it_under_the_pane_beside() {
    let mut m = model();
    let main = pane(&mut m, "edit", Some(LEFT), None, 0);
    let notes = pane(&mut m, "notes", Some(RIGHT), Some((700.0, 400.0)), 1);
    let to = m.slide_for(notes, Side::Right).unwrap();
    assert_eq!(to, Slide { pane: RIGHT, end_x: Some(true), end_y: None });
    m.set_rect(notes, Field::SlidPane, Some(to.pane));
    m.set_int(notes, Field::SlidEndX, 1);
    let end = Rect::new(804.0, 41.0, 700.0, 933.0);
    assert_eq!(m.frame(notes, None), end);
    assert_eq!(sides(m.cut_of(notes)), Some(vec![Side::Left]));
    let mut under = [0; 4];
    assert_eq!(m.lying_under(notes, None, &mut under), 1);
    assert_eq!(under[0], main);
    // Over the pane it lies under in the on-screen list (front to back): over; behind it: not; unlisted: not.
    assert!(m.over_under(notes, &[10 + 1, 10]));
    assert!(!m.over_under(notes, &[10, 10 + 1]));
    assert!(!m.over_under(notes, &[10 + 1]));
    // A frame given (a drag's): its own pane's rect alone lies under nothing.
    assert!(!m.tucked(notes, Some(RIGHT)));
    // Its pane changed (a divider moved): away from the other panes again, whatever it was slid to.
    let narrower = Rect::new(914.0, 41.0, 590.0, 933.0);
    m.set_rect(notes, Field::Rect, Some(narrower));
    assert_eq!(m.frame(notes, None), Rect::new(914.0, 41.0, 700.0, 933.0));
}

#[test]
fn slide_for_keeps_the_other_axis_as_it_is() {
    let mut m = model();
    pane(&mut m, "top", Some(Rect::new(276.0, 41.0, 1228.0, 300.0)), None, 0);
    let low = Rect::new(276.0, 349.0, 1228.0, 300.0);
    let h = pane(&mut m, "low", Some(low), Some((1300.0, 500.0)), 1);
    // Wider and taller than its pane, away from the other panes: on x at the page's end (its start at the pane's,
    // passing its end), on y not (its end at the pane's, passing its start).
    let f = m.frame(h, None);
    assert_eq!(f, Rect::new(276.0, 149.0, 1300.0, 500.0));
    assert_eq!(m.slide_for(h, Side::Up), Some(Slide { pane: low, end_x: Some(false), end_y: Some(false) }));
    assert_eq!(m.slide_for(h, Side::Down), Some(Slide { pane: low, end_x: Some(false), end_y: Some(true) }));
    assert_eq!(m.slide_for(h, Side::Left), Some(Slide { pane: low, end_x: Some(false), end_y: Some(true) }));
    assert_eq!(m.slide_for(h, Side::Right), Some(Slide { pane: low, end_x: Some(true), end_y: Some(true) }));
    // No rect: no slide.
    let main = m.add("main", "main", 1, 1);
    assert_eq!(m.slide_for(main, Side::Left), None);
}

#[test]
fn three_panes_a_chain_never_a_crossing_slide() {
    let mut m = model();
    let a = Rect::new(276.0, 41.0, 404.0, 933.0);
    let b = Rect::new(688.0, 41.0, 404.0, 933.0);
    let c = Rect::new(1100.0, 41.0, 404.0, 933.0);
    let first = pane(&mut m, "edit", Some(a), None, 0);
    let notes = pane(&mut m, "notes", Some(b), Some((700.0, 400.0)), 1);
    let maps = pane(&mut m, "maps", Some(c), Some((600.0, 400.0)), 2);
    assert_eq!(m.frame(notes, None), Rect::new(392.0, 41.0, 700.0, 933.0));
    assert_eq!(m.frame(maps, None), Rect::new(1100.0, 41.0, 600.0, 933.0));
    assert_eq!(sides(m.cut_of(notes)), Some(vec![Side::Left]));
    assert_eq!(sides(m.cut_of(maps)), Some(vec![Side::Right]));
    // The last one slid right: under the middle one, which lies under the first.
    m.set_rect(maps, Field::SlidPane, Some(c));
    m.set_int(maps, Field::SlidEndX, 1);
    assert_eq!(m.frame(maps, None), Rect::new(904.0, 41.0, 600.0, 933.0));
    // The middle one's left no longer offered: slid, it would lie over the last one's pane while that lies over its.
    assert_eq!(sides(m.cut_of(notes)), Some(vec![]));
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
    // Each slid into the other's pane.
    for (h, r, end) in [(a, LEFT, 0), (b, RIGHT, 1)] {
        m.set_rect(h, Field::SlidPane, Some(r));
        m.set_int(h, Field::SlidEndX, end);
    }
    // Each lies under the other (two over each other's, which cut_of never offers): as given.
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

#[test]
fn a_slides_frames_eased_out_to_the_last() {
    let from = Rect::new(894.0, 41.0, 700.0, 933.0);
    let to = Rect::new(804.0, 41.0, 700.0, 933.0);
    let (r, last) = slide_rect(&from, &to, 0.0, 0.15);
    assert_eq!((r, last), (from, false));
    let (r, last) = slide_rect(&from, &to, 0.075, 0.15);
    // Half the time: 7/8 of the way (1 - 0.5³).
    assert_eq!((r.x, last), (894.0 - 90.0 * 0.875, false));
    assert_eq!(slide_rect(&from, &to, 0.15, 0.15), (to, true));
    assert_eq!(slide_rect(&from, &to, 1.0, 0.15), (to, true));
    // One a frame (1/120 s): 19 rects for 150 ms, the last at its end.
    let mut steps = 0;
    let mut t = 0.0;
    loop {
        steps += 1;
        if slide_rect(&from, &to, t, 0.15).1 {
            break;
        }
        t += 1.0 / 120.0;
    }
    assert_eq!(steps, 19);
    // A frame's tile in Margin's placement from its own tile.
    let m = model();
    let home = Rect::new(0.0, 0.0, 1512.0, 982.0);
    let s = m.slide_step(&from, &to, 0.15, 0.15, Some(&home));
    assert!(s.last && s.tile.is_some() && s.page == to);
    assert_eq!(m.slide_step(&from, &to, 0.0, 0.15, None).tile, None);
}
