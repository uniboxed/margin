//! The page area (MarginWindow.swift's `MarginWindowGeometry.measuredAt`/`pageRect`, MarginWindowController's
//! `narrowed`, `hostedPlacement`, `idlePlacement`, `paneLayout`; docs/CORE-REFACTOR.md step 3 parts 7 and 11): where
//! `<m-page>` sits on the screen, from the page's layout and the window's content (top left, the window server's
//! points), with CGRect's edges.

use crate::geometry::Rect;
use crate::host::layout::Placement;
use crate::passthrough::{Cg, Edges, PassThrough, SlotInsets};
use crate::protocol::PageLayout;

/// The layout's insets and radius as the slot reads them.
pub fn insets(l: &PageLayout) -> SlotInsets {
    SlotInsets { left: l.left, top: l.top, right: l.right, bottom: l.bottom, radius: l.radius }
}

/// Whether a layout was measured at the content's present size (`measuredAt`: one from before a resize is followed by
/// the right one): within a point each way.
pub fn measured_at(width: f64, height: f64, content: &Rect) -> bool {
    (width - content.width).abs() < 1.0 && (height - content.height).abs() < 1.0
}

/// The page area on the screen (`pageRect`): the content less the layout's insets; None until the layout is one
/// measured at the content's size, or if it leaves no area.
pub fn page_rect(insets: SlotInsets, width: f64, height: f64, content: Rect) -> Option<Rect> {
    if !measured_at(width, height, &content) {
        return None;
    }
    let r = PassThrough::slot_rect::<Cg>(content, insets);
    (r.width > 0.0 && r.height > 0.0).then_some(r)
}

/// In full screen and narrower than its display (`narrowed`: laid out as a split's half for a moment by a tile change
/// in its Space).
pub fn narrowed(full_screen: bool, content: &Rect, display: Option<&Rect>) -> bool {
    let Some(d) = display.filter(|_| full_screen) else { return false };
    Cg::standard(content).width < Cg::standard(d).width - 2.0
}

/// A split's panes on the screen (`paneLayout`): each `<m-pane>` box moved into the content, at whole points, each
/// edge rounded on its own (a window is placed at whole points, and the gap stays the gap).
pub fn pane_rect(pane: &Rect, content: &Rect) -> Rect {
    let c = Cg::standard(content);
    let r = Cg::offset(pane, c.min_x(), c.min_y());
    let (x0, y0) = (r.min_x().round(), r.min_y().round());
    Rect::new(x0, y0, r.max_x().round() - x0, r.max_y().round() - y0)
}

/// Where the hosted window goes while hosting (`hostedPlacement`): the page area from a layout its page measured
/// hosting (or with the sidebar alone), in full screen at its size, and the display's frame its own Space lays it
/// out in (`display`: none, the zero rect). None until then, and while the window is narrowed.
pub fn hosted_placement(
    hosting: bool,
    full_screen: bool,
    layout: Option<&PageLayout>,
    content: Rect,
    display: Option<Rect>,
) -> Option<Placement> {
    let l = layout?;
    if !hosting || !full_screen || l.mode != "fullscreen" || !(l.hosted || l.outside) {
        return None;
    }
    if narrowed(full_screen, &content, display.as_ref()) {
        return None;
    }
    let page = page_rect(insets(l), l.width, l.height, content)?;
    Some(Placement { page, area: content, display: display.unwrap_or(Rect::ZERO) })
}

/// The page area as its page draws it now, not hosting (`idlePlacement`: the launcher's layout), in full screen at its
/// size: where a browser's window made ready out of sight is placed. None until measured.
pub fn idle_placement(full_screen: bool, layout: Option<&PageLayout>, content: Rect) -> Option<Placement> {
    let l = layout?;
    if !full_screen || l.mode != "fullscreen" || !measured_at(l.width, l.height, &content) {
        return None;
    }
    let page = page_rect(insets(l), l.width, l.height, content)?;
    Some(Placement { page, area: content, display: Rect::ZERO })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(l: f64, t: f64, r: f64, b: f64, w: f64, h: f64) -> PageLayout {
        PageLayout {
            left: l,
            top: t,
            right: r,
            bottom: b,
            radius: 10.0,
            radii: vec![10.0; 4],
            width: w,
            height: h,
            mode: "fullscreen".into(),
            hosted: true,
            ..PageLayout::default()
        }
    }

    #[test]
    fn the_page_area() {
        // (margin-window-tests.swift's.)
        let windowed = Rect::new(100.0, 200.0, 1200.0, 800.0);
        let sidebar = layout(260.0, 8.0, 8.0, 8.0, 1200.0, 800.0);
        assert_eq!(page_rect(insets(&sidebar), 1200.0, 800.0, windowed), Some(Rect::new(360.0, 208.0, 932.0, 784.0)));
        let display = Rect::new(0.0, 0.0, 1512.0, 982.0);
        assert_eq!(page_rect(insets(&sidebar), 1200.0, 800.0, display), None, "a layout from before: no area yet");
        assert!(page_rect(insets(&sidebar), 1200.4, 799.6, windowed).is_some(), "half a point off still counts");
        assert_eq!(page_rect(insets(&layout(700.0, 0.0, 600.0, 0.0, 1200.0, 800.0)), 1200.0, 800.0, windowed), None);
        let full = layout(248.0, 8.0, 8.0, 8.0, 1512.0, 982.0);
        let p = hosted_placement(true, true, Some(&full), display, Some(display));
        assert_eq!(p.map(|p| (p.page, p.display)), Some((Rect::new(248.0, 8.0, 1256.0, 966.0), display)));
        assert_eq!(hosted_placement(false, true, Some(&full), display, Some(display)), None, "not hosting");
        assert_eq!(hosted_placement(true, false, Some(&full), display, Some(display)), None, "windowed");
        let launcher = PageLayout { hosted: false, ..full.clone() };
        assert_eq!(
            hosted_placement(true, true, Some(&launcher), display, Some(display)),
            None,
            "the launcher's layout"
        );
        let half = Rect::new(0.0, 0.0, 756.0, 982.0);
        assert_eq!(hosted_placement(true, true, Some(&full), half, Some(display)), None, "narrowed");
        assert_eq!(hosted_placement(true, true, Some(&full), display, None).map(|p| p.display), Some(Rect::ZERO));
        assert_eq!(
            idle_placement(true, Some(&launcher), display).map(|p| p.page),
            Some(Rect::new(248.0, 8.0, 1256.0, 966.0))
        );
        assert_eq!(idle_placement(true, Some(&launcher), windowed), None, "measured at another size");
        assert_eq!(
            pane_rect(&Rect::new(0.4, 0.5, 620.4, 965.5), &Rect::new(248.0, 8.0, 1.0, 1.0)),
            Rect::new(248.0, 9.0, 621.0, 965.0)
        );
    }
}
