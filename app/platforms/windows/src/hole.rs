//! Margin's window and the windows it hosts (docs/HOSTED-WINDOWS-CHROMIUM.md §4.1, §4.2), the OS-neutral half:
//!
//! - `region`: the part of Margin's window that takes the pointer. The page draws nothing in a hole (its pixels are
//!   transparent, so DWM shows the hosted window under it), but transparent pixels still hit Margin's window: each hole
//!   is cut from its window region (`SetWindowRgn`), so a click there reaches the hosted window natively. A square of the
//!   corner's radius at each of a hole's corners stays Margin's, so the theme's anti-aliased rounded corner is never
//!   clipped (a click in those few pixels is Margin's).
//! - `chrome_hit`: what a point of Margin's window is to Windows (`WM_NCHITTEST`): the theme's drag regions are the title
//!   bar, its window controls the minimize, maximize and close buttons (Windows 11's snap layouts come with the maximize
//!   button), the window's edges resize it unless it's maximized or full screen.
//!
//! Client pixels throughout (Win32's RECT: right and bottom exclusive). Pure, tested on any OS.

use crate::screens::PxRect;

/// `a` less `b`: at most four rectangles, none overlapping, none empty.
fn subtract(a: &PxRect, b: &PxRect) -> Vec<PxRect> {
    let (l, t, r, btm) = (a.left.max(b.left), a.top.max(b.top), a.right.min(b.right), a.bottom.min(b.bottom));
    if l >= r || t >= btm {
        return vec![*a];
    }
    let mut out = Vec::with_capacity(4);
    if a.top < t {
        out.push(PxRect::new(a.left, a.top, a.right, t));
    }
    if btm < a.bottom {
        out.push(PxRect::new(a.left, btm, a.right, a.bottom));
    }
    if a.left < l {
        out.push(PxRect::new(a.left, t, l, btm));
    }
    if r < a.right {
        out.push(PxRect::new(r, t, a.right, btm));
    }
    out
}

/// The window's region: its whole client area (`width` × `height`) less each hole, each hole's corners (`radius`
/// pixels square, clamped to half its sides) kept. Disjoint rectangles, top to bottom. With no hole: the whole window
/// (the caller then sets no region at all).
pub fn region(width: i32, height: i32, holes: &[PxRect], radius: i32) -> Vec<PxRect> {
    let mut parts = vec![PxRect::new(0, 0, width.max(0), height.max(0))];
    for h in holes {
        if h.width() <= 0 || h.height() <= 0 {
            continue;
        }
        let r = radius.clamp(0, (h.width() / 2).min(h.height() / 2));
        // The hole less its corners: a band across its middle rows and a band down its middle columns.
        let across = PxRect::new(h.left, h.top + r, h.right, h.bottom - r);
        let down = PxRect::new(h.left + r, h.top, h.right - r, h.bottom);
        for cut in [across, down] {
            if cut.width() <= 0 || cut.height() <= 0 {
                continue;
            }
            parts = parts.iter().flat_map(|p| subtract(p, &cut)).collect();
        }
    }
    parts.retain(|p| p.width() > 0 && p.height() > 0);
    parts.sort_by_key(|p| (p.top, p.left));
    parts
}

/// Whether a point is in the region.
pub fn contains(parts: &[PxRect], x: i32, y: i32) -> bool {
    parts.iter().any(|p| x >= p.left && x < p.right && y >= p.top && y < p.bottom)
}

/// What a point of Margin's window is, as `WM_NCHITTEST` answers it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hit {
    Client,
    Caption,
    Minimize,
    Maximize,
    Close,
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Where the theme draws the window's controls and its drag regions (the page's `chrome` op, ui/host-app.ts
/// `chromeRects`), in client pixels.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Chrome {
    /// The theme's window controls (`<m-window-controls>`): split in three, minimize, maximize and close, Windows'
    /// order left to right.
    pub controls: Option<PxRect>,
    /// The theme's drag regions (`<m-drag-region>`): the title bar.
    pub drags: Vec<PxRect>,
}

impl Chrome {
    /// From the page's `chrome` op: `controls` [x, y, w, h] or null, `drags` a list of them, CSS pixels, times the
    /// window's scale. At most 32 drag regions (as the page sends); anything not a finite rect is left out.
    pub fn from_op(body: &serde_json::Value, scale: f64) -> Chrome {
        let rect = |v: &serde_json::Value| -> Option<PxRect> {
            let a = v.as_array()?;
            if a.len() != 4 {
                return None;
            }
            let n: Vec<f64> = a.iter().filter_map(|x| x.as_f64()).filter(|x| x.is_finite()).collect();
            if n.len() != 4 || n[2] <= 0.0 || n[3] <= 0.0 || !(scale.is_finite() && scale > 0.0) {
                return None;
            }
            let px = |v: f64| (v * scale).round() as i32;
            Some(PxRect::new(px(n[0]), px(n[1]), px(n[0] + n[2]), px(n[1] + n[3])))
        };
        Chrome {
            controls: body.get("controls").and_then(rect),
            drags: body
                .get("drags")
                .and_then(|d| d.as_array())
                .map(|list| list.iter().take(32).filter_map(rect).collect())
                .unwrap_or_default(),
        }
    }
}

/// `WM_NCHITTEST` for a point (client pixels) of a window `width` × `height`: the resize edges first (within `border`
/// pixels, none while `sizable` is false: maximized or full screen), then the controls, then the drag regions; else
/// the page's.
pub fn chrome_hit(x: i32, y: i32, width: i32, height: i32, border: i32, sizable: bool, chrome: &Chrome) -> Hit {
    let inside = |r: &PxRect| x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    if sizable && border > 0 {
        let (left, right, top, bottom) = (x < border, x >= width - border, y < border, y >= height - border);
        match (left, right, top, bottom) {
            (true, _, true, _) => return Hit::TopLeft,
            (_, true, true, _) => return Hit::TopRight,
            (true, _, _, true) => return Hit::BottomLeft,
            (_, true, _, true) => return Hit::BottomRight,
            (true, ..) => return Hit::Left,
            (_, true, ..) => return Hit::Right,
            (_, _, true, _) => return Hit::Top,
            (.., true) => return Hit::Bottom,
            _ => {}
        }
    }
    if let Some(c) = chrome.controls.filter(|c| inside(c)) {
        let third = (c.width() / 3).max(1);
        return match (x - c.left) / third {
            0 => Hit::Minimize,
            1 => Hit::Maximize,
            _ => Hit::Close,
        };
    }
    if chrome.drags.iter().any(inside) {
        return Hit::Caption;
    }
    Hit::Client
}

/// Where the page's `<m-page>` is (and each `<m-pane>` of a split), from its `layout` op (ui/host.ts `Geometry`: the
/// page's insets from the container, its corner radius, the panes' boxes in the container), in client pixels at
/// `scale`. These are the rects the windows Margin hosts go to (plus the window's client origin on the screen) and the
/// holes cut from Margin's window.
#[derive(Clone, Debug, PartialEq)]
pub struct PageLayout {
    pub page: PxRect,
    pub radius: i32,
    /// A split's panes by item, in its order (empty: no split).
    pub panes: Vec<(String, PxRect)>,
}

impl PageLayout {
    /// The holes: each pane, or the page area when there's no split.
    pub fn holes(&self) -> Vec<PxRect> {
        if self.panes.is_empty() { vec![self.page] } else { self.panes.iter().map(|p| p.1).collect() }
    }
}

/// The page's `layout` op read as untrusted (`{ geometry }`): None if it isn't one, or the page area is empty.
pub fn page_layout(body: &serde_json::Value, scale: f64) -> Option<PageLayout> {
    let g = body.get("geometry")?;
    if !(scale.is_finite() && scale > 0.0) {
        return None;
    }
    let num = |v: Option<&serde_json::Value>| v.and_then(|x| x.as_f64()).filter(|x| x.is_finite());
    let px = |v: f64| (v * scale).round() as i32;
    let insets = g.get("insets")?;
    let container = g.get("container")?;
    let (w, h) = (num(container.get("width"))?, num(container.get("height"))?);
    let (l, t, r, b) =
        (num(insets.get("left"))?, num(insets.get("top"))?, num(insets.get("right"))?, num(insets.get("bottom"))?);
    let page = PxRect::new(px(l), px(t), px(w - r), px(h - b));
    if page.width() <= 0 || page.height() <= 0 {
        return None;
    }
    let panes = g
        .get("panes")
        .and_then(|p| p.as_array())
        .map(|list| {
            list.iter()
                .take(4)
                .filter_map(|p| {
                    let id = p.get("id")?.as_str()?.chars().take(256).collect::<String>();
                    let a = p.get("rect")?.as_array()?;
                    let n: Vec<f64> = a.iter().filter_map(|x| x.as_f64()).filter(|x| x.is_finite()).collect();
                    (n.len() == 4 && n[2] > 0.0 && n[3] > 0.0)
                        .then(|| (id, PxRect::new(px(n[0]), px(n[1]), px(n[0] + n[2]), px(n[1] + n[3]))))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(PageLayout { page, radius: px(num(g.get("radius")).unwrap_or(0.0).clamp(0.0, 64.0)), panes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pages_layout_in_client_pixels() {
        let body = serde_json::json!({ "geometry": {
            "insets": { "left": 260, "top": 40, "right": 8, "bottom": 8 }, "radius": 10, "radii": [],
            "outer": { "left": 0, "top": 0, "right": 0, "bottom": 0, "radius": 0 },
            "container": { "width": 1280, "height": 800 },
        } });
        let l = page_layout(&body, 1.5).unwrap_or_else(|| panic!("a layout"));
        assert_eq!(l.page, PxRect::new(390, 60, 1908, 1188));
        assert_eq!(l.radius, 15);
        assert_eq!(l.holes(), vec![l.page]);
        let split = serde_json::json!({ "geometry": {
            "insets": { "left": 260, "top": 40, "right": 8, "bottom": 8 }, "radius": 10,
            "container": { "width": 1280, "height": 800 },
            "panes": [{ "id": "t-a", "rect": [260, 40, 500, 752] }, { "id": "t-b", "rect": [766, 40, 506, 752] }, { "id": "x", "rect": [0, 0, -1, 4] }],
        } });
        let s = page_layout(&split, 1.0).unwrap_or_else(|| panic!("a split"));
        assert_eq!(
            s.panes,
            vec![("t-a".into(), PxRect::new(260, 40, 760, 792)), ("t-b".into(), PxRect::new(766, 40, 1272, 792))]
        );
        assert_eq!(s.holes().len(), 2);
        assert_eq!(page_layout(&serde_json::json!({ "geometry": { "insets": {}, "container": {} } }), 1.0), None);
        assert_eq!(page_layout(&serde_json::json!({}), 1.0), None);
        assert_eq!(page_layout(&body, 0.0), None);
    }

    fn area(parts: &[PxRect]) -> i64 {
        parts.iter().map(|p| p.width() as i64 * p.height() as i64).sum()
    }
    fn disjoint(parts: &[PxRect]) -> bool {
        for (i, a) in parts.iter().enumerate() {
            for b in &parts[i + 1..] {
                if a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom {
                    return false;
                }
            }
        }
        true
    }

    #[test]
    fn no_hole_is_the_whole_window() {
        assert_eq!(region(1200, 800, &[], 10), vec![PxRect::new(0, 0, 1200, 800)]);
    }

    #[test]
    fn a_hole_passes_the_pointer_through_but_its_corners_stay_margins() {
        let hole = PxRect::new(260, 40, 1190, 790);
        let parts = region(1200, 800, &[hole], 12);
        assert!(disjoint(&parts), "{parts:?}");
        // The area: the window less the hole, plus its four corner squares.
        assert_eq!(area(&parts), 1200 * 800 - (930 * 750) + 4 * 12 * 12);
        assert!(contains(&parts, 10, 10), "the sidebar");
        assert!(!contains(&parts, 700, 400), "the page area's middle");
        assert!(!contains(&parts, 260, 400), "its left edge, away from a corner");
        assert!(!contains(&parts, 700, 40), "its top edge, away from a corner");
        assert!(contains(&parts, 260, 40), "its top-left corner: the theme's rounded corner");
        assert!(contains(&parts, 1189, 789), "its bottom-right corner");
        assert!(!contains(&parts, 272, 52), "just past the corner square");
        assert!(contains(&parts, 1195, 400), "the frame to its right");
    }

    #[test]
    fn several_holes_and_a_radius_larger_than_a_hole() {
        let a = PxRect::new(100, 100, 500, 700);
        let b = PxRect::new(510, 100, 900, 700);
        let parts = region(1000, 800, &[a, b], 8);
        assert!(disjoint(&parts));
        assert!(!contains(&parts, 300, 400) && !contains(&parts, 700, 400));
        assert!(contains(&parts, 505, 400), "the gap between two panes is Margin's (the divider)");
        let tiny = PxRect::new(10, 10, 16, 20);
        let small = region(100, 100, &[tiny], 50);
        assert_eq!(area(&small), 100 * 100 - 6 * 10 + 4 * 3 * 3, "the radius held to half the hole's short side");
        let empty = region(100, 100, &[PxRect::new(5, 5, 5, 50)], 4);
        assert_eq!(empty, vec![PxRect::new(0, 0, 100, 100)], "an empty hole cuts nothing");
    }

    #[test]
    fn a_hole_past_the_window_cuts_only_what_is_in_it() {
        let parts = region(800, 600, &[PxRect::new(400, -50, 900, 300)], 0);
        assert!(disjoint(&parts));
        assert_eq!(area(&parts), 800 * 600 - 400 * 300);
    }

    #[test]
    fn the_frame_answers_windows_hit_test() {
        let chrome =
            Chrome { controls: Some(PxRect::new(1080, 0, 1200, 40)), drags: vec![PxRect::new(0, 0, 1080, 40)] };
        let hit = |x, y| chrome_hit(x, y, 1200, 800, 8, true, &chrome);
        assert_eq!(hit(2, 2), Hit::TopLeft);
        assert_eq!(hit(1199, 799), Hit::BottomRight);
        assert_eq!(hit(2, 400), Hit::Left);
        assert_eq!(hit(600, 2), Hit::Top);
        assert_eq!(hit(600, 20), Hit::Caption);
        assert_eq!(hit(1090, 20), Hit::Minimize);
        assert_eq!(hit(1130, 20), Hit::Maximize);
        assert_eq!(hit(1170, 20), Hit::Close);
        assert_eq!(hit(600, 400), Hit::Client);
        // Maximized or full screen: no resize edges.
        assert_eq!(chrome_hit(2, 2, 1200, 800, 8, false, &chrome), Hit::Caption);
        assert_eq!(chrome_hit(2, 400, 1200, 800, 8, false, &chrome), Hit::Client);
    }

    #[test]
    fn the_pages_chrome_op_read_as_untrusted() {
        let body = serde_json::json!({ "controls": [540, 0, 60, 20], "drags": [[0, 0, 540, 20], [1, 2], "x", [0, 0, -1, 5], [0, 0, null, 5]] });
        let c = Chrome::from_op(&body, 2.0);
        assert_eq!(c.controls, Some(PxRect::new(1080, 0, 1200, 40)));
        assert_eq!(c.drags, vec![PxRect::new(0, 0, 1080, 40)]);
        assert_eq!(Chrome::from_op(&serde_json::json!({ "controls": null }), 1.0), Chrome::default());
        assert_eq!(Chrome::from_op(&body, f64::NAN), Chrome::default());
    }
}
