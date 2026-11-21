//! Multi-pane Split View layout math (Track 2 M2.7): computes exact whole-point
//! pane rectangles, macOS tile rectangles, divider hit rects, and live 120 Hz
//! divider resize ratios for 1–4 simultaneous hosted panes (App+App, Web+App,
//! Web+Web). Respects every pane's `SizeConstraints.Min` so dragging a divider
//! never shrinks a hosted app below its minimum width/height.

use serde::{Deserialize, Serialize};

use super::layout::{self, Placement, Size};
use crate::geometry::Rect;

pub const MAX_PANES: usize = 4;
pub const DEFAULT_MIN_PANE_PX: f64 = 240.0;
pub const DEFAULT_GUTTER_PX: f64 = 8.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    #[default]
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSpec {
    pub id: String,
    pub ratio: f64,
    #[serde(default)]
    pub min_size: Option<Size>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneGeometry {
    pub id: String,
    pub rect: Rect,
    pub tile: Option<Rect>,
    pub ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividerGeometry {
    pub index: usize,
    pub rect: Rect,
    pub axis: Axis,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLayoutResult {
    pub axis: Axis,
    pub panes: Vec<PaneGeometry>,
    pub dividers: Vec<DividerGeometry>,
    pub ratios: Vec<f64>,
    pub min_page_width: f64,
    pub min_page_height: f64,
}

fn pane_min_extent(spec: &PaneSpec, axis: Axis) -> f64 {
    let raw = match (axis, spec.min_size) {
        (Axis::Horizontal, Some(s)) if s.width.is_finite() && s.width > 0.0 => s.width.ceil(),
        (Axis::Vertical, Some(s)) if s.height.is_finite() && s.height > 0.0 => s.height.ceil(),
        _ => DEFAULT_MIN_PANE_PX,
    };
    raw.max(120.0)
}

fn pane_cross_min(spec: &PaneSpec, axis: Axis) -> f64 {
    match (axis, spec.min_size) {
        (Axis::Horizontal, Some(s)) if s.height.is_finite() && s.height > 0.0 => s.height.ceil(),
        (Axis::Vertical, Some(s)) if s.width.is_finite() && s.width > 0.0 => s.width.ceil(),
        _ => DEFAULT_MIN_PANE_PX,
    }
}

/// Normalizes weights to positive fractions summing to 1.0.
pub fn normalize_ratios(ratios: &[f64]) -> Vec<f64> {
    if ratios.is_empty() {
        return Vec::new();
    }
    let clean: Vec<f64> = ratios.iter().map(|&r| if r.is_finite() && r > 0.0 { r } else { 1.0 }).collect();
    let sum: f64 = clean.iter().sum();
    if sum <= 0.0 {
        let eq = 1.0 / clean.len() as f64;
        return vec![eq; clean.len()];
    }
    clean.into_iter().map(|r| r / sum).collect()
}

/// Allocates `available` pixels across panes respecting each pane's `mins[i]`,
/// returning whole-point extents summing exactly to `available.round()`.
fn allocate_extents(available: f64, ratios: &[f64], mins: &[f64]) -> Vec<f64> {
    let n = ratios.len();
    if n == 0 {
        return Vec::new();
    }
    let target_total = available.round().max(1.0);
    let min_sum: f64 = mins.iter().sum();

    // If the page area is narrower than the sum of minimums, scale proportionally
    // to minimums so panes still tile cleanly without overlapping.
    let mut extents: Vec<f64> = if target_total <= min_sum {
        mins.iter().map(|&m| (m / min_sum) * target_total).collect()
    } else {
        // Start with desired ratio sizes, then enforce per-pane minimums by
        // iteratively clamping deficit panes and redistributing remaining slack.
        let mut sizes: Vec<f64> = ratios.iter().map(|&r| r * target_total).collect();
        let mut locked = vec![false; n];
        loop {
            let mut changed = false;
            let mut locked_sum = 0.0;
            let mut free_weight = 0.0;
            for i in 0..n {
                if !locked[i] && sizes[i] < mins[i] {
                    sizes[i] = mins[i];
                    locked[i] = true;
                    changed = true;
                }
                if locked[i] {
                    locked_sum += sizes[i];
                } else {
                    free_weight += ratios[i];
                }
            }
            if !changed {
                break;
            }
            let slack = (target_total - locked_sum).max(0.0);
            if free_weight <= 0.0 {
                break;
            }
            for i in 0..n {
                if !locked[i] {
                    sizes[i] = slack * (ratios[i] / free_weight);
                }
            }
        }
        sizes
    };

    // Round to whole points while preserving exact sum on the last pane.
    let mut used = 0.0;
    for ext in extents.iter_mut().take(n - 1) {
        *ext = ext.round().max(1.0);
        used += *ext;
    }
    extents[n - 1] = (target_total - used).max(1.0);
    extents
}

/// Computes pane rects, optional macOS tile rects, and divider hit rects for 1–4 panes.
pub fn layout_panes(placement: &Placement, axis: Axis, specs: &[PaneSpec], gutter: f64) -> Option<PaneLayoutResult> {
    if specs.is_empty() || placement.page.width < 1.0 || placement.page.height < 1.0 {
        return None;
    }
    let slice = &specs[..specs.len().min(MAX_PANES)];
    let n = slice.len();
    let g = if gutter.is_finite() && gutter >= 0.0 { gutter.round() } else { DEFAULT_GUTTER_PX };
    let total_gutters = g * (n.saturating_sub(1) as f64);
    let main_total = match axis {
        Axis::Horizontal => placement.page.width,
        Axis::Vertical => placement.page.height,
    };
    let available = (main_total - total_gutters).max(n as f64);

    let norm_ratios = normalize_ratios(&slice.iter().map(|s| s.ratio).collect::<Vec<_>>());
    let mins: Vec<f64> = slice.iter().map(|s| pane_min_extent(s, axis)).collect();
    let extents = allocate_extents(available, &norm_ratios, &mins);
    let actual_sum: f64 = extents.iter().sum();
    let final_ratios: Vec<f64> = extents.iter().map(|&e| e / actual_sum).collect();

    let home = layout::home(placement);
    let mut panes = Vec::with_capacity(n);
    let mut dividers = Vec::with_capacity(n.saturating_sub(1));
    let mut cursor = match axis {
        Axis::Horizontal => placement.page.x,
        Axis::Vertical => placement.page.y,
    };

    for i in 0..n {
        let ext = extents[i];
        let rect = match axis {
            Axis::Horizontal => Rect::new(cursor.round(), placement.page.y.round(), ext, placement.page.height.round()),
            Axis::Vertical => Rect::new(placement.page.x.round(), cursor.round(), placement.page.width.round(), ext),
        };
        let pane_placement = Placement { page: rect, area: placement.area, display: placement.display };
        let tile = home.as_ref().and_then(|h| layout::tile(&pane_placement, h));
        panes.push(PaneGeometry { id: slice[i].id.clone(), rect, tile, ratio: final_ratios[i] });
        cursor += ext;
        if i + 1 < n {
            let div_rect = match axis {
                Axis::Horizontal => {
                    Rect::new(cursor.round(), placement.page.y.round(), g.max(4.0), placement.page.height.round())
                }
                Axis::Vertical => {
                    Rect::new(placement.page.x.round(), cursor.round(), placement.page.width.round(), g.max(4.0))
                }
            };
            dividers.push(DividerGeometry { index: i, rect: div_rect, axis });
            cursor += g;
        }
    }

    let min_main: f64 = mins.iter().sum::<f64>() + total_gutters;
    let min_cross: f64 = slice.iter().map(|s| pane_cross_min(s, axis)).fold(0.0, f64::max);
    let (min_page_width, min_page_height) = match axis {
        Axis::Horizontal => (min_main, min_cross),
        Axis::Vertical => (min_cross, min_main),
    };

    Some(PaneLayoutResult { axis, panes, dividers, ratios: final_ratios, min_page_width, min_page_height })
}

/// Adjusts ratios when dragging divider `divider_index` (between pane `i` and `i + 1`)
/// by `delta_px` points, strictly respecting both adjacent panes' minimum sizes.
pub fn resize_divider(
    specs: &[PaneSpec],
    divider_index: usize,
    delta_px: f64,
    total_px: f64,
    gutter: f64,
    axis: Axis,
) -> Vec<f64> {
    let slice = &specs[..specs.len().min(MAX_PANES)];
    let n = slice.len();
    let mut ratios = normalize_ratios(&slice.iter().map(|s| s.ratio).collect::<Vec<_>>());
    if n < 2 || divider_index + 1 >= n || !delta_px.is_finite() || !total_px.is_finite() || total_px <= 1.0 {
        return ratios;
    }
    let g = if gutter.is_finite() && gutter >= 0.0 { gutter.round() } else { DEFAULT_GUTTER_PX };
    let available = (total_px - g * ((n - 1) as f64)).max(1.0);
    let i = divider_index;
    let j = divider_index + 1;
    let pair = ratios[i] + ratios[j];
    let min_i = (pane_min_extent(&slice[i], axis) / available).min(pair * 0.5);
    let min_j = (pane_min_extent(&slice[j], axis) / available).min(pair * 0.5);
    let delta_ratio = delta_px / available;
    let next_i = (ratios[i] + delta_ratio).clamp(min_i, pair - min_j);
    ratios[i] = next_i;
    ratios[j] = (pair - next_i).max(min_j);
    normalize_ratios(&ratios)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kit() -> Placement {
        Placement {
            page: Rect::new(248.0, 41.0, 1256.0, 933.0),
            area: Rect::new(0.0, 33.0, 1512.0, 949.0),
            display: Rect::new(0.0, 0.0, 1512.0, 982.0),
        }
    }

    fn spec(id: &str, ratio: f64, min_w: Option<f64>) -> PaneSpec {
        PaneSpec { id: id.into(), ratio, min_size: min_w.map(|w| Size::new(w, 300.0)) }
    }

    #[test]
    fn two_pane_horizontal_split_with_gutter_and_tiles() {
        let res = layout_panes(&kit(), Axis::Horizontal, &[spec("a", 0.5, None), spec("b", 0.5, None)], 8.0).unwrap();
        assert_eq!(res.panes.len(), 2);
        assert_eq!(res.dividers.len(), 1);
        assert_eq!(res.panes[0].rect.width + res.panes[1].rect.width + 8.0, 1256.0);
        assert_eq!(res.panes[0].rect.x, 248.0);
        assert_eq!(res.dividers[0].rect.x, res.panes[0].rect.max_x());
        assert_eq!(res.panes[1].rect.x, res.panes[0].rect.max_x() + 8.0);
        assert!(res.panes[0].tile.is_some());
        assert!(res.panes[1].tile.is_some());
    }

    #[test]
    fn respects_per_app_minimum_width_and_computes_min_page_width() {
        let specs = [spec("wide-app", 0.2, Some(700.0)), spec("web", 0.8, Some(300.0))];
        let res = layout_panes(&kit(), Axis::Horizontal, &specs, 8.0).unwrap();
        assert!(res.panes[0].rect.width >= 700.0, "wide app never shrunk below min width");
        assert_eq!(res.panes[0].rect.width + res.panes[1].rect.width + 8.0, 1256.0);
        assert_eq!(res.min_page_width, 1008.0);
    }

    #[test]
    fn four_pane_vertical_and_divider_drag_clamping() {
        let specs = [
            spec("p1", 0.25, Some(200.0)),
            spec("p2", 0.25, Some(200.0)),
            spec("p3", 0.25, Some(200.0)),
            spec("p4", 0.25, Some(200.0)),
        ];
        let res = layout_panes(&kit(), Axis::Vertical, &specs, 8.0).unwrap();
        assert_eq!(res.panes.len(), 4);
        assert_eq!(res.dividers.len(), 3);
        let sum_h: f64 = res.panes.iter().map(|p| p.rect.height).sum();
        assert_eq!(sum_h + 24.0, 933.0);

        // Dragging divider 0 aggressively left clamps pane 0 at its minimum instead of collapsing it.
        let dragged = resize_divider(&specs, 0, -900.0, 1256.0, 8.0, Axis::Horizontal);
        let after = layout_panes(
            &kit(),
            Axis::Horizontal,
            &specs.iter().enumerate().map(|(i, s)| PaneSpec { ratio: dragged[i], ..s.clone() }).collect::<Vec<_>>(),
            8.0,
        )
        .unwrap();
        assert!(after.panes[0].rect.width >= 200.0);
        assert_eq!(after.panes.iter().map(|p| p.rect.width).sum::<f64>() + 24.0, 1256.0);
    }
}
