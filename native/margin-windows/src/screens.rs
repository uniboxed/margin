//! Physical pixels ⇄ the DIPs Chrome's `windows.get` reports (the math is OS-neutral, tested on the Mac;
//! reading the monitors is Windows').
//!
//! Margin's process is per-monitor-v2 DPI aware (main.rs), so every Win32 coordinate it reads or sets
//! (EnumWindows' windows, DWM's frame bounds, GetCursorPos, SetWindowPos) is in physical pixels of the
//! virtual screen. Chrome reports window bounds in DIPs: on one monitor, or several at one scale, that's
//! simply pixels ÷ scale (scale = the monitor's effective DPI ÷ 96).
//!
//! With monitors at different scales there is no single factor: Chrome (ui/display/win/screen_win.cc and
//! scaling_util.cc) lays the monitors out again in DIPs, keeping the primary at (0, 0) and each other monitor
//! touching the one it touched in pixels. This module follows that shape: the primary first, then each
//! monitor that shares an edge with one already placed goes beside it, its offset along that edge taken in
//! the placed monitor's DIPs; a monitor touching none falls back to its pixel origin ÷ its own scale. A
//! rectangle converts with the monitor it overlaps most. UNCERTAIN (native/UNVERIFIED.md): Chrome's exact
//! offset rule and its handling of monitors that only touch at a corner; with mixed scales, the bounds this
//! gives and `windows.get`'s may differ by a few DIPs, so the binder must match with a tolerance there.

use margin_core::geometry::{Point, Rect};

/// A rectangle in physical pixels (Win32's RECT: right and bottom exclusive).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PxRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl PxRect {
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self { left, top, right, bottom }
    }
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    fn overlap(&self, o: &PxRect) -> i64 {
        let w = (self.right.min(o.right) - self.left.max(o.left)).max(0) as i64;
        let h = (self.bottom.min(o.bottom) - self.top.max(o.top)).max(0) as i64;
        w * h
    }
    fn center_distance2(&self, o: &PxRect) -> i64 {
        let dx = (self.left + self.right) as i64 - (o.left + o.right) as i64;
        let dy = (self.top + self.bottom) as i64 - (o.top + o.bottom) as i64;
        dx * dx + dy * dy
    }
}

/// A monitor as Windows gives it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Monitor {
    pub px: PxRect,
    /// Effective DPI ÷ 96.
    pub scale: f64,
    pub primary: bool,
}

/// A monitor placed in DIPs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub px: PxRect,
    pub scale: f64,
    pub dip: Rect,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScreenMap {
    pub screens: Vec<Screen>,
}

impl ScreenMap {
    pub fn new(monitors: &[Monitor]) -> Self {
        let mut placed: Vec<Option<Rect>> = vec![None; monitors.len()];
        let size = |m: &Monitor| (m.px.width() as f64 / m.scale, m.px.height() as f64 / m.scale);
        if let Some(i) = monitors.iter().position(|m| m.primary).or(if monitors.is_empty() { None } else { Some(0) }) {
            let m = &monitors[i];
            let (w, h) = size(m);
            placed[i] = Some(Rect::new(m.px.left as f64 / m.scale, m.px.top as f64 / m.scale, w, h));
        }
        // Breadth first from the primary: each pass places every monitor touching one already placed.
        loop {
            let mut progress = false;
            for d in 0..monitors.len() {
                if placed[d].is_some() {
                    continue;
                }
                let dm = &monitors[d];
                let (w, h) = size(dm);
                let found = (0..monitors.len()).find_map(|p| {
                    let pr = placed[p]?;
                    let pm = &monitors[p];
                    let (a, b) = (&pm.px, &dm.px);
                    let along_y = b.top < a.bottom && b.bottom > a.top;
                    let along_x = b.left < a.right && b.right > a.left;
                    let y_beside = pr.y + (b.top - a.top) as f64 / pm.scale;
                    let x_beside = pr.x + (b.left - a.left) as f64 / pm.scale;
                    if b.left == a.right && along_y {
                        Some(Rect::new(pr.max_x(), y_beside, w, h))
                    } else if b.right == a.left && along_y {
                        Some(Rect::new(pr.x - w, y_beside, w, h))
                    } else if b.top == a.bottom && along_x {
                        Some(Rect::new(x_beside, pr.max_y(), w, h))
                    } else if b.bottom == a.top && along_x {
                        Some(Rect::new(x_beside, pr.y - h, w, h))
                    } else {
                        None
                    }
                });
                if let Some(r) = found {
                    placed[d] = Some(r);
                    progress = true;
                }
            }
            if !progress {
                break;
            }
        }
        let screens = monitors
            .iter()
            .zip(placed)
            .map(|(m, r)| {
                let (w, h) = size(m);
                let dip = r.unwrap_or(Rect::new(m.px.left as f64 / m.scale, m.px.top as f64 / m.scale, w, h));
                Screen { px: m.px, scale: m.scale, dip }
            })
            .collect();
        Self { screens }
    }

    /// The screen a pixel rectangle is on: the one it overlaps most, else the nearest.
    pub fn screen_for_px(&self, r: &PxRect) -> Option<&Screen> {
        let best = self.screens.iter().max_by_key(|s| s.px.overlap(r)).filter(|s| s.px.overlap(r) > 0);
        best.or_else(|| self.screens.iter().min_by_key(|s| s.px.center_distance2(r)))
    }

    /// The screen a DIP rectangle is on: the one it overlaps most, else the nearest.
    pub fn screen_for_dip(&self, r: &Rect) -> Option<&Screen> {
        let area = |s: &Screen| {
            let i = s.dip.intersection(r);
            i.width * i.height
        };
        let best = self.screens.iter().filter(|s| area(s) > 0.0).max_by(|a, b| area(a).total_cmp(&area(b)));
        best.or_else(|| {
            let d = |s: &Screen| (s.dip.mid_x() - r.mid_x()).powi(2) + (s.dip.mid_y() - r.mid_y()).powi(2);
            self.screens.iter().min_by(|a, b| d(a).total_cmp(&d(b)))
        })
    }

    pub fn to_dip(&self, r: &PxRect) -> Rect {
        match self.screen_for_px(r) {
            Some(s) => Rect::new(
                s.dip.x + (r.left - s.px.left) as f64 / s.scale,
                s.dip.y + (r.top - s.px.top) as f64 / s.scale,
                r.width() as f64 / s.scale,
                r.height() as f64 / s.scale,
            ),
            None => Rect::new(r.left as f64, r.top as f64, r.width() as f64, r.height() as f64),
        }
    }

    pub fn to_px(&self, r: &Rect) -> PxRect {
        match self.screen_for_dip(r) {
            Some(s) => {
                let left = s.px.left + ((r.x - s.dip.x) * s.scale).round() as i32;
                let top = s.px.top + ((r.y - s.dip.y) * s.scale).round() as i32;
                PxRect::new(
                    left,
                    top,
                    left + (r.width * s.scale).round() as i32,
                    top + (r.height * s.scale).round() as i32,
                )
            }
            None => PxRect::new(r.x as i32, r.y as i32, (r.x + r.width) as i32, (r.y + r.height) as i32),
        }
    }

    pub fn point_to_dip(&self, x: i32, y: i32) -> Point {
        let r = self.to_dip(&PxRect::new(x, y, x + 1, y + 1));
        Point::new(r.x, r.y)
    }

    /// The scale of the screen this pixel rectangle is on (1 with no screens).
    pub fn scale_for_px(&self, r: &PxRect) -> f64 {
        self.screen_for_px(r).map(|s| s.scale).unwrap_or(1.0)
    }

    /// The monitors as Windows has them now. Empty when it gave none.
    #[cfg(windows)]
    pub fn read() -> Self {
        Self::new(&win::monitors())
    }
}

#[cfg(windows)]
mod win {
    use super::{Monitor, PxRect};
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::core::BOOL;

    const MONITORINFOF_PRIMARY: u32 = 1;

    unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the `&mut Vec<Monitor>` `monitors` passed, alive for the whole EnumDisplayMonitors call.
        let out = unsafe { &mut *(data.0 as *mut Vec<Monitor>) };
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        // SAFETY: `monitor` comes from the enumeration; `info` is a MONITORINFO with cbSize set.
        if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            let (mut x, mut y) = (96u32, 96u32);
            // SAFETY: plain out-parameters; on failure the defaults (96: scale 1) stay.
            let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) };
            let r = info.rcMonitor;
            out.push(Monitor {
                px: PxRect::new(r.left, r.top, r.right, r.bottom),
                scale: if x == 0 { 1.0 } else { x as f64 / 96.0 },
                primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        BOOL(1)
    }

    pub fn monitors() -> Vec<Monitor> {
        let mut out: Vec<Monitor> = Vec::new();
        // SAFETY: the callback only runs during this call and gets a pointer to `out`, which outlives it.
        let _ = unsafe { EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut out as *mut Vec<Monitor> as isize)) };
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(l: i32, t: i32, r: i32, b: i32, scale: f64, primary: bool) -> Monitor {
        Monitor { px: PxRect::new(l, t, r, b), scale, primary }
    }

    #[test]
    fn one_monitor_divides() {
        let map = ScreenMap::new(&[mon(0, 0, 3840, 2160, 2.0, true)]);
        assert_eq!(map.to_dip(&PxRect::new(100, 200, 1100, 1200)), Rect::new(50.0, 100.0, 500.0, 500.0));
        assert_eq!(map.to_px(&Rect::new(50.0, 100.0, 500.0, 500.0)), PxRect::new(100, 200, 1100, 1200));
        assert_eq!(map.point_to_dip(10, 20), Point::new(5.0, 10.0));
    }

    #[test]
    fn same_scale_is_plain_division() {
        let map = ScreenMap::new(&[mon(0, 0, 1920, 1080, 1.5, true), mon(1920, 0, 3840, 1080, 1.5, false)]);
        assert_eq!(map.screens[1].dip, Rect::new(1280.0, 0.0, 1280.0, 720.0));
        assert_eq!(map.to_dip(&PxRect::new(1920, 0, 2220, 300)), Rect::new(1280.0, 0.0, 200.0, 200.0));
    }

    #[test]
    fn mixed_scales_stay_touching() {
        // A 4K at 200% (primary) and a 1080p at 100% to its right, 300 px lower.
        let map = ScreenMap::new(&[mon(0, 0, 3840, 2160, 2.0, true), mon(3840, 300, 5760, 1380, 1.0, false)]);
        assert_eq!(map.screens[0].dip, Rect::new(0.0, 0.0, 1920.0, 1080.0));
        assert_eq!(map.screens[1].dip, Rect::new(1920.0, 150.0, 1920.0, 1080.0));
        // A window on the second monitor.
        let r = PxRect::new(4000, 400, 4800, 1000);
        assert_eq!(map.to_dip(&r), Rect::new(2080.0, 250.0, 800.0, 600.0));
        assert_eq!(map.to_px(&map.to_dip(&r)), r);
    }

    #[test]
    fn left_and_above() {
        let map = ScreenMap::new(&[
            mon(0, 0, 2000, 1000, 1.0, true),
            mon(-3000, 0, 0, 2000, 2.0, false),
            mon(0, -1000, 2000, 0, 1.0, false),
        ]);
        assert_eq!(map.screens[1].dip, Rect::new(-1500.0, 0.0, 1500.0, 1000.0));
        assert_eq!(map.screens[2].dip, Rect::new(0.0, -1000.0, 2000.0, 1000.0));
    }

    #[test]
    fn chained_and_lone_monitors() {
        let map = ScreenMap::new(&[
            mon(0, 0, 1000, 1000, 1.0, true),
            mon(1000, 0, 3000, 2000, 2.0, false),
            mon(3000, 0, 4000, 1000, 1.0, false),
            mon(9000, 9000, 9100, 9100, 1.25, false),
        ]);
        assert_eq!(map.screens[1].dip, Rect::new(1000.0, 0.0, 1000.0, 1000.0));
        assert_eq!(map.screens[2].dip, Rect::new(2000.0, 0.0, 1000.0, 1000.0));
        assert_eq!(map.screens[3].dip, Rect::new(7200.0, 7200.0, 80.0, 80.0));
    }

    #[test]
    fn off_screen_uses_the_nearest() {
        let map = ScreenMap::new(&[mon(0, 0, 2000, 1000, 2.0, true)]);
        assert_eq!(map.to_dip(&PxRect::new(-100, -100, -50, -50)), Rect::new(-50.0, -50.0, 25.0, 25.0));
        assert_eq!(ScreenMap::default().to_dip(&PxRect::new(1, 2, 3, 4)), Rect::new(1.0, 2.0, 2.0, 2.0));
    }
}
