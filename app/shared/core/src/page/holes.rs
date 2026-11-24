//! The holes in Margin's ground (MarginWindowController's `holeRadii`, `subtract`, `groundHoles`, docs/CORE-REFACTOR.md
//! step 3 part 11), with CGRect's edges (passthrough.rs `Cg`): where the hosted windows show through, each hole's
//! corners rounded only where they meet the page card's, and the ground's cut-outs for holes that may overlap.

use crate::geometry::{Rect, cg};
use crate::passthrough::{Cg, Edges};

/// A hole's corners (top-left, top-right, bottom-right, bottom-left): the page card's radius where the hole's corner is
/// within 2 pt of the card's, else square (`holeRadii`; the one host's hole the same).
pub fn hole_radii(r: &Rect, page: &Rect, radii: &[f64]) -> [f64; 4] {
    let (p, m) = (Cg::standard(page), Cg::standard(r));
    let corners = [(p.min_x(), p.min_y()), (p.max_x(), p.min_y()), (p.max_x(), p.max_y()), (p.min_x(), p.max_y())];
    let mine = [(m.min_x(), m.min_y()), (m.max_x(), m.min_y()), (m.max_x(), m.max_y()), (m.min_x(), m.max_y())];
    let mut out = [0.0; 4];
    for i in 0..4 {
        if (corners[i].0 - mine[i].0).abs() <= 2.0 && (corners[i].1 - mine[i].1).abs() <= 2.0 && i < radii.len() {
            out[i] = radii[i];
        }
    }
    out
}

/// `r` less `cut` (`subtract`): the parts above, below, left and right of what they share, each kept only if it's more
/// than half a point both ways; `r` itself when they share nothing with a size. Added to `out`.
pub fn subtract(r: &Rect, cut: &Rect, out: &mut Vec<Rect>) {
    let Some(i) = Cg::intersection(r, cut).filter(|i| i.width > 0.0 && i.height > 0.0) else {
        out.push(*r);
        return;
    };
    let s = Cg::standard(r);
    for p in [
        Rect::new(s.min_x(), s.min_y(), s.width, i.min_y() - s.min_y()),
        Rect::new(s.min_x(), i.max_y(), s.width, s.max_y() - i.max_y()),
        Rect::new(s.min_x(), i.min_y(), i.min_x() - s.min_x(), i.height),
        Rect::new(i.max_x(), i.min_y(), s.max_x() - i.max_x(), i.height),
    ] {
        let q = Cg::standard(&p);
        if q.width > 0.5 && q.height > 0.5 {
            out.push(p);
        }
    }
}

/// One piece of the ground's cut-outs (`groundHoles`): its rect, the hole it's of (its index in the list), and whether
/// it's that hole whole (it keeps its corners then; a piece of one is square).
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct Piece {
    pub rect: Rect,
    pub from: usize,
    pub whole: bool,
}

/// `groundHoles`: the cut-outs for holes that may overlap (a card over panes): each one less the ones before it, so the
/// even-odd fill never fills an overlap. Into `out` (cleared first); `scratch` a buffer of the caller's, reused.
pub fn ground_holes(list: &[Rect], out: &mut Vec<Piece>, scratch: &mut [Vec<Rect>; 2]) {
    out.clear();
    for (k, h) in list.iter().enumerate() {
        let [pieces, next] = scratch;
        pieces.clear();
        pieces.push(*h);
        for b in &list[..k] {
            next.clear();
            for p in pieces.iter() {
                subtract(p, b, next);
            }
            std::mem::swap(pieces, next);
        }
        out.extend(pieces.iter().map(|p| Piece { rect: *p, from: k, whole: cg::same(p, h) }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pieces(list: &[Rect]) -> Vec<Piece> {
        let mut out = Vec::new();
        ground_holes(list, &mut out, &mut [Vec::new(), Vec::new()]);
        out
    }

    #[test]
    fn subtract_and_cut_outs() {
        let r = Rect::new(0.0, 0.0, 100.0, 100.0);
        let mut out = Vec::new();
        subtract(&r, &Rect::new(25.0, 25.0, 50.0, 50.0), &mut out);
        assert_eq!(
            out,
            vec![
                Rect::new(0.0, 0.0, 100.0, 25.0),
                Rect::new(0.0, 75.0, 100.0, 25.0),
                Rect::new(0.0, 25.0, 25.0, 50.0),
                Rect::new(75.0, 25.0, 25.0, 50.0)
            ]
        );
        out.clear();
        subtract(&r, &Rect::new(100.0, 0.0, 10.0, 10.0), &mut out);
        assert_eq!(out, vec![r], "touching: shares nothing with a size, kept whole");
        out.clear();
        subtract(&r, &Rect::new(50.0, 50.0, 0.0, 10.0), &mut out);
        assert_eq!(out, vec![r], "a zero-size cut: kept whole");
        out.clear();
        subtract(&r, &Rect::new(-10.0, -10.0, 200.0, 200.0), &mut out);
        assert!(out.is_empty(), "covered: nothing left");
        out.clear();
        subtract(&r, &Rect::new(0.0, 0.0, 100.0, 99.6), &mut out);
        assert!(out.is_empty(), "a sliver under half a point dropped");
        // (A card over two panes: each pane whole, the card in pieces around them.)
        let (left, right, card) =
            (Rect::new(0.0, 0.0, 50.0, 100.0), Rect::new(50.0, 0.0, 50.0, 100.0), Rect::new(10.0, 10.0, 80.0, 80.0));
        let p = pieces(&[left, right, card]);
        assert_eq!(p[0], Piece { rect: left, from: 0, whole: true });
        assert_eq!(p[1], Piece { rect: right, from: 1, whole: true });
        assert!(p[2..].iter().all(|q| q.from == 2 && !q.whole));
        assert!(pieces(&[card, left]).iter().any(|q| q.from == 1 && !q.whole));
    }

    #[test]
    fn corners_only_where_they_meet_the_cards() {
        let page = Rect::new(248.0, 8.0, 1256.0, 966.0);
        let radii = [10.0, 11.0, 12.0, 13.0];
        assert_eq!(hole_radii(&page, &page, &radii), radii);
        assert_eq!(hole_radii(&Rect::new(249.5, 9.0, 1254.0, 964.0), &page, &radii), radii, "within 2 pt: the card's");
        assert_eq!(hole_radii(&Rect::new(251.0, 8.0, 600.0, 966.0), &page, &radii), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(hole_radii(&Rect::new(248.0, 8.0, 600.0, 966.0), &page, &radii), [10.0, 0.0, 0.0, 13.0]);
        assert_eq!(hole_radii(&page, &page, &radii[..2]), [10.0, 11.0, 0.0, 0.0], "past the layout's radii: square");
    }
}
