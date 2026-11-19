//! The routes a hosted app can take, best first, and the way down (docs/ARCHITECTURE-PLAN.md, "Policy"). Every
//! route keeps the same promise, the app fills the pane; some give more than others:
//!   tiles    its full-screen window a tile in Margin's Space: sized live, parked ones too (live resize)
//!   members  its full-screen window a plain member of Margin's Space: sized when it's shown, behind a cover
//!   window   a plain window Margin keeps at the page area (an app that can't go full screen without a Dock icon)
//! An app that keeps fighting its route (the loop guard stopped it, its full screen failed) moves down one rung, by
//! what it did, never by its name. The step down is remembered for that version of the app and tried again after an
//! update (a fix in the app may make the better route work). Persisted by the caller (`Routes` is plain data).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    Tiles,
    Members,
    Window,
}

impl Route {
    pub const LADDER: [Route; 3] = [Route::Tiles, Route::Members, Route::Window];
    pub fn name(self) -> &'static str {
        match self {
            Route::Tiles => "tiles",
            Route::Members => "members",
            Route::Window => "window mode",
        }
    }
    /// What the person loses on it, for the note.
    pub fn gives(self) -> &'static str {
        match self {
            Route::Tiles => "kept at the page area's size live, even when it isn't shown",
            Route::Members => "sized when it's shown, behind a short cover",
            Route::Window => "a plain window kept at the page area",
        }
    }
}

/// One app's step down: the route it's held at, for which version, why, and when.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Held {
    pub route: Route,
    pub version: String,
    pub why: String,
    pub at: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Routes {
    /// By bundle id (an app's identity; never used to pick a rule, only to remember what it did).
    pub held: BTreeMap<String, Held>,
}

impl Routes {
    /// The best route for this app among `available` (what this Mac and this window can do: no tiles on a macOS
    /// without them, no full screen for a window that can't), at or below where it's held for this version.
    pub fn route(&self, bundle: &str, version: &str, available: &[Route]) -> Option<Route> {
        let floor = self.held.get(bundle).filter(|h| h.version == version).map(|h| h.route);
        Route::LADDER.into_iter().filter(|r| available.contains(r)).find(|r| floor.is_none_or(|f| *r >= f))
    }

    /// `bundle` failed on `from`: held at the next route down that's available. None: nothing below (it stays where
    /// it is; the caller parks it with nothing shown and says so).
    pub fn step_down(
        &mut self,
        bundle: &str,
        version: &str,
        from: Route,
        available: &[Route],
        why: &str,
        now: f64,
    ) -> Option<Route> {
        let next = Route::LADDER.into_iter().filter(|r| available.contains(r)).find(|r| *r > from)?;
        self.held.insert(bundle.into(), Held { route: next, version: version.into(), why: why.into(), at: now });
        Some(next)
    }

    /// Where it's held, for the sidebar's note and the log (None: on its best route, or a newer version).
    pub fn held_at(&self, bundle: &str, version: &str) -> Option<&Held> {
        self.held.get(bundle).filter(|h| h.version == version)
    }

    /// Versions that changed since: their holds dropped (tried again on the better route).
    pub fn forget_old(&mut self, current: &BTreeMap<String, String>) {
        self.held.retain(|b, h| current.get(b).is_none_or(|v| *v == h.version));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Route; 3] = Route::LADDER;

    #[test]
    fn best_available_then_down_one_rung() {
        let mut r = Routes::default();
        assert_eq!(r.route("com.apple.weather", "4.0 (1)", &ALL), Some(Route::Tiles));
        assert_eq!(r.route("com.apple.weather", "4.0 (1)", &[Route::Members, Route::Window]), Some(Route::Members));
        let next = r.step_down("com.apple.weather", "4.0 (1)", Route::Tiles, &ALL, "its tile resize loop", 10.0);
        assert_eq!(next, Some(Route::Members));
        assert_eq!(r.route("com.apple.weather", "4.0 (1)", &ALL), Some(Route::Members));
        // Another app isn't touched.
        assert_eq!(r.route("com.apple.Maps", "3.0", &ALL), Some(Route::Tiles));
        // A new version tries the best route again.
        assert_eq!(r.route("com.apple.weather", "4.1 (2)", &ALL), Some(Route::Tiles));
        r.forget_old(&[("com.apple.weather".to_string(), "4.1 (2)".to_string())].into());
        assert!(r.held.is_empty());
    }

    #[test]
    fn nothing_below_the_last_rung() {
        let mut r = Routes::default();
        assert_eq!(r.step_down("a", "1", Route::Window, &ALL, "x", 0.0), None);
        // Skips what isn't available: from tiles straight to window mode for a window that can't go full screen.
        assert_eq!(r.step_down("b", "1", Route::Tiles, &[Route::Tiles, Route::Window], "x", 0.0), Some(Route::Window));
        // Held below what's available now (window mode held, only full-screen routes offered): the best offered.
        assert_eq!(r.route("b", "1", &[Route::Members]), None);
        assert_eq!(r.route("b", "1", &[Route::Members, Route::Window]), Some(Route::Window));
    }

    #[test]
    fn round_trips_as_json() {
        let mut r = Routes::default();
        r.step_down("com.apple.weather", "4.0", Route::Tiles, &ALL, "loop", 1.0);
        let text = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<Routes>(&text).unwrap(), r);
        assert!(text.contains(r#""route":"members""#), "{text}");
    }
}
