//! Which of an app's windows is hosted (Host.swift `HostWindowChoice`). Seen 2026-11-15 (Dictionary started with no
//! Dock icon): three server windows of the same size and a smaller one, only one ordered in; Accessibility lists all
//! three before its activation and only the real one after. So, with no per-app rule, in this order:
//!   1. Accessibility's main window, else its focused one, when readable;
//!   2. the window server's window that's on screen (the current Space's, ordered in);
//!   3. a window Accessibility lists as a standard one (or one that can go full screen);
//!   4. one in a Space (a spare never ordered in is in none);
//!   5. the window server's front one (its only one, or nothing tells them apart).
//!
//! Never an off-screen window while an on-screen one of the same size is there. Rules 2, 4 and 5 (the window
//! server's alone) only when `server_allowed` (an app Margin started may still be making its window).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::system::ServerWindow;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChoiceRule {
    Main,
    Focused,
    OnScreen,
    Standard,
    InSpace,
    Front,
    Only,
}

impl ChoiceRule {
    pub fn text(self) -> &'static str {
        match self {
            ChoiceRule::Main => "Accessibility's main window",
            ChoiceRule::Focused => "Accessibility's focused window",
            ChoiceRule::OnScreen => "the window server's one on screen",
            ChoiceRule::Standard => "a standard window as Accessibility lists it",
            ChoiceRule::InSpace => "the one in a Space (the others in none: never ordered in)",
            ChoiceRule::Front => "the window server's front one (nothing else told them apart)",
            ChoiceRule::Only => "its only window by the window server",
        }
    }
}

/// An app's windows Margin could host, by the window server: layer 0, drawn, at least 100×100, not `excluded`
/// (hosted already, or minimized), front first.
pub fn candidates(server: &[ServerWindow], pid: u32, excluded: impl Fn(i64) -> bool) -> Vec<ServerWindow> {
    let mut out: Vec<ServerWindow> = server
        .iter()
        .filter(|w| {
            w.pid == pid
                && w.layer == 0
                && w.alpha > 0.0
                && w.bounds.width >= 100.0
                && w.bounds.height >= 100.0
                && !excluded(w.number)
        })
        .cloned()
        .collect();
    out.sort_by_key(|w| w.order);
    out
}

/// `candidates` (front first; empty: the window server's list didn't read), which are in a Space, Accessibility's
/// main and focused windows, the windows it lists as hostable (`standard`, in its order). None: none chosen (yet).
pub fn choose(
    candidates: &[ServerWindow],
    in_space: &BTreeSet<i64>,
    main: Option<i64>,
    focused: Option<i64>,
    standard: &[i64],
    server_allowed: bool,
) -> Option<(i64, ChoiceRule)> {
    let on_screen: Vec<&ServerWindow> = candidates.iter().filter(|w| w.on_screen).collect();
    let known: BTreeSet<i64> = candidates.iter().map(|w| w.number).collect();
    // (An off-screen window with an on-screen one of its size: a spare.)
    let spare = |n: i64| -> bool {
        let Some(w) = candidates.iter().find(|w| w.number == n) else { return false };
        if w.on_screen {
            return false;
        }
        on_screen.iter().any(|o| {
            o.number != n
                && (o.bounds.width - w.bounds.width).abs() < 1.0
                && (o.bounds.height - w.bounds.height).abs() < 1.0
        })
    };
    // (One of the app's: by the window server's list, or by Accessibility's when that list didn't read.)
    let usable = |n: Option<i64>| -> Option<i64> {
        let n = n?;
        let ok = if candidates.is_empty() { standard.contains(&n) } else { known.contains(&n) };
        (ok && !spare(n)).then_some(n)
    };
    if let Some(n) = usable(main) {
        return Some((n, ChoiceRule::Main));
    }
    if let Some(n) = usable(focused) {
        return Some((n, ChoiceRule::Focused));
    }
    if server_allowed && let Some(w) = on_screen.iter().find(|w| standard.contains(&w.number)).or(on_screen.first()) {
        return Some((w.number, ChoiceRule::OnScreen));
    }
    let on_screen_numbers: BTreeSet<i64> = on_screen.iter().map(|w| w.number).collect();
    if let Some(&n) = standard
        .iter()
        .find(|&&n| usable(Some(n)).is_some() && on_screen_numbers.contains(&n))
        .or_else(|| standard.iter().find(|&&n| usable(Some(n)).is_some()))
    {
        return Some((n, ChoiceRule::Standard));
    }
    if !server_allowed {
        return None;
    }
    let front = candidates.first()?;
    if candidates.len() == 1 {
        return Some((front.number, ChoiceRule::Only));
    }
    let placed: Vec<&ServerWindow> = candidates.iter().filter(|w| in_space.contains(&w.number)).collect();
    if let Some(w) = placed.first()
        && placed.len() < candidates.len()
    {
        return Some((w.number, ChoiceRule::InSpace));
    }
    Some((front.number, ChoiceRule::Front))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Rect;

    fn win(n: i64, w: f64, h: f64, on: bool, order: usize) -> ServerWindow {
        ServerWindow {
            number: n,
            pid: 7,
            layer: 0,
            bounds: Rect::new(0.0, 0.0, w, h),
            on_screen: on,
            alpha: 1.0,
            order,
        }
    }

    #[test]
    fn dictionary_spares_never_chosen() {
        // Three 1292×888 (one on screen), a 500×500; AX main reads one of the off-screen spares.
        let c = vec![
            win(10, 1292.0, 888.0, false, 0),
            win(11, 1292.0, 888.0, false, 1),
            win(12, 500.0, 500.0, false, 2),
            win(13, 1292.0, 888.0, true, 3),
        ];
        let got = choose(&c, &BTreeSet::new(), Some(10), None, &[], true);
        assert_eq!(got, Some((13, ChoiceRule::OnScreen)));
        // Without the server's word: nothing yet.
        assert_eq!(choose(&c, &BTreeSet::new(), Some(10), None, &[], false), None);
        assert_eq!(choose(&c, &BTreeSet::new(), Some(13), None, &[], false), Some((13, ChoiceRule::Main)));
    }

    #[test]
    fn rules_in_order() {
        let c = vec![win(1, 800.0, 600.0, false, 0), win(2, 900.0, 600.0, false, 1)];
        assert_eq!(choose(&c, &BTreeSet::new(), None, Some(2), &[], false), Some((2, ChoiceRule::Focused)));
        assert_eq!(choose(&c, &BTreeSet::new(), None, None, &[2], false), Some((2, ChoiceRule::Standard)));
        assert_eq!(choose(&c, &[2].into(), None, None, &[], true), Some((2, ChoiceRule::InSpace)));
        assert_eq!(choose(&c, &[1, 2].into(), None, None, &[], true), Some((1, ChoiceRule::Front)));
        assert_eq!(choose(&c[..1], &BTreeSet::new(), None, None, &[], true), Some((1, ChoiceRule::Only)));
        // The server's list unread: Accessibility's word alone.
        assert_eq!(choose(&[], &BTreeSet::new(), Some(5), None, &[5], false), Some((5, ChoiceRule::Main)));
        assert_eq!(choose(&[], &BTreeSet::new(), Some(5), None, &[], false), None);
    }

    #[test]
    fn candidates_filter_and_order() {
        let mut tiny = win(3, 80.0, 600.0, true, 0);
        tiny.pid = 7;
        let mut other = win(4, 800.0, 600.0, true, 1);
        other.pid = 8;
        let mut menu = win(5, 800.0, 600.0, true, 2);
        menu.layer = 101;
        let list = vec![win(2, 800.0, 600.0, true, 5), tiny, other, menu, win(1, 800.0, 600.0, true, 4)];
        let got: Vec<i64> = candidates(&list, 7, |_| false).iter().map(|w| w.number).collect();
        assert_eq!(got, vec![1, 2]);
        let got: Vec<i64> = candidates(&list, 7, |n| n == 1).iter().map(|w| w.number).collect();
        assert_eq!(got, vec![2]);
    }
}
