//! Apps that go full screen only with their Dock icon (2026-11-28). Margin starts an app with no Dock icon
//! (LaunchServices' UIElement launch), and AppKit refuses its windows full screen then unless the app itself allows it
//! (`-[NSWindow _implicitlyAllowsFullScreenPrimary]` asks LaunchServices whether the app is a UIElement or background
//! app first: Music, Calculator's kind, App Store, Reminders…; Maps, Weather, Photos allow it themselves). Such an app is
//! given its Dock icon in place (LaunchServices' open of the running app makes it a regular one at once, and AppKit
//! asks again at every full-screen request), shown full screen, and remembered per version of it, so from the next
//! start on it's started with its Dock icon and goes full screen as fast as any app. One whose window still can't go
//! full screen with its Dock icon (its own setting switches full screen off: nothing outside the app can tell before)
//! is quit and opened again with none (macOS doesn't show a Dock app's window that can't go full screen in Margin's
//! full-screen Space), remembered, and never given it again at that version (window mode, as before).
//!
//! The person's setting (Settings › Apps, "Hide apps from the Dock when Margin opens them", on by default) is the rule's
//! first input: off, every app Margin starts is started with its Dock icon, as any app.
//!
//! Plain data and rules: the OS side reads the window's facts, the app's version and the file's bytes (docked.json,
//! beside routes.json); nothing here reads any of them. The file: `{"com.apple.Music":{"version":"1.6 (16)",
//! "needs":true}}`. A file that doesn't read as that whole is taken as none.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What's known of one app, for one version of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DockedApp {
    pub version: String,
    /// True: its windows go full screen only with its Dock icon (started with it). False: given it once, its window
    /// still couldn't go full screen (never given it again).
    pub needs: bool,
}

/// Every app's entry, by its bundle id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DockedApps {
    pub by_app: BTreeMap<String, DockedApp>,
}

/// A window's facts as the OS side read them, for the rule.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DockFacts {
    /// An app's window (not a Safari window of Margin's: those go full screen through its extension).
    pub app: bool,
    /// Started by Margin (an app the person opened is hosted as it is: its Dock icon is its own business).
    pub launched_by_margin: bool,
    /// Its app has no Dock icon now (an accessory app).
    pub dockless: bool,
    /// It can go full screen now (Accessibility can set its AXFullScreen).
    pub can_full_screen: bool,
    /// Accessibility can set its AXSize (AppKit never lets a fixed-size window go full screen on its own).
    pub resizable: bool,
    /// Its green button there and enabled: a titled window (a dialog, panel or sheet has none; AppKit's own rule leaves
    /// those out too). Not its subrole: an app with no Dock icon reports its main window as an AXDialog.
    pub zoomable: bool,
    pub minimized: bool,
}

impl DockedApps {
    /// The file's contents as read (JSON). None: it isn't the file's shape (nothing taken from it).
    pub fn load(v: &Value) -> Option<DockedApps> {
        let by_app = BTreeMap::<String, DockedApp>::deserialize(v).ok()?;
        Some(DockedApps { by_app })
    }

    /// The file's contents to write.
    pub fn to_json(&self) -> Value {
        serde_json::to_value(&self.by_app).unwrap_or(Value::Null)
    }

    /// What's known of `app` at `version` (None: nothing, or only for another version: learnt again).
    pub fn known(&self, app: &str, version: Option<&str>) -> Option<bool> {
        let e = self.by_app.get(app)?;
        if version.is_some_and(|v| v != e.version) {
            return None;
        }
        Some(e.needs)
    }

    /// Whether `app` (its version on disk: `version`, None when unread) is started with its Dock icon: every app when
    /// the person doesn't hide apps from the Dock (`hide_from_dock` false), else one known to need it at that version.
    pub fn starts_docked(&self, app: &str, version: Option<&str>, hide_from_dock: bool) -> bool {
        !hide_from_dock || (version.is_some() && self.known(app, version) == Some(true))
    }

    /// What its Dock icon did for `app` at `version`. True: new (the caller saves the file and says it).
    pub fn remember(&mut self, app: &str, version: &str, needs: bool) -> bool {
        let e = DockedApp { version: version.to_string(), needs };
        if self.by_app.get(app) == Some(&e) {
            return false;
        }
        self.by_app.insert(app.to_string(), e);
        true
    }

    /// Whether a window that can't go full screen is worth its app's Dock icon: an app's titled (green button), resizable window,
    /// not minimized, of an app Margin started with no Dock icon, that isn't known to stay unable with it.
    pub fn give_dock_icon(&self, app: &str, version: Option<&str>, f: &DockFacts) -> bool {
        f.app
            && f.launched_by_margin
            && f.dockless
            && !f.can_full_screen
            && f.resizable
            && f.zoomable
            && !f.minimized
            && self.known(app, version) != Some(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn music() -> DockFacts {
        DockFacts {
            app: true,
            launched_by_margin: true,
            dockless: true,
            can_full_screen: false,
            resizable: true,
            zoomable: true,
            minimized: false,
        }
    }

    #[test]
    fn given_its_dock_icon_only_when_that_is_all_it_lacks() {
        let d = DockedApps::default();
        assert!(d.give_dock_icon("com.apple.Music", Some("1.6"), &music()));
        for (why, f) in [
            ("it can go full screen already", DockFacts { can_full_screen: true, ..music() }),
            ("a fixed-size window (Calculator's)", DockFacts { resizable: false, ..music() }),
            ("a dialog or panel (no green button)", DockFacts { zoomable: false, ..music() }),
            ("minimized", DockFacts { minimized: true, ..music() }),
            ("its Dock icon shows already", DockFacts { dockless: false, ..music() }),
            ("an app the person opened", DockFacts { launched_by_margin: false, ..music() }),
            ("a Safari window of Margin's", DockFacts { app: false, ..music() }),
        ] {
            assert!(!d.give_dock_icon("com.apple.Music", Some("1.6"), &f), "{why}");
        }
    }

    #[test]
    fn remembered_per_version() {
        let mut d = DockedApps::default();
        assert!(!d.starts_docked("com.apple.Music", Some("1.6"), true), "nothing known: no Dock icon");
        assert!(
            d.starts_docked("com.apple.Music", Some("1.6"), false),
            "apps not hidden from the Dock: every app with its icon"
        );
        assert!(d.starts_docked("com.apple.Safari", None, false), "any app, its version read or not");
        assert!(d.remember("com.apple.Music", "1.6", true));
        assert!(!d.remember("com.apple.Music", "1.6", true), "the same: not kept again");
        assert!(d.starts_docked("com.apple.Music", Some("1.6"), true));
        assert!(!d.starts_docked("com.apple.Music", Some("1.7"), true), "another version: learnt again");
        assert!(!d.starts_docked("com.apple.Music", None, true), "its version unread: as before");
        // Given it once and still unable: never given it again for that version, and never started with it.
        assert!(d.remember("com.example.Odd", "2", false));
        assert!(!d.give_dock_icon("com.example.Odd", Some("2"), &music()));
        assert!(!d.starts_docked("com.example.Odd", Some("2"), true));
        assert!(d.give_dock_icon("com.example.Odd", Some("3"), &music()), "a new version: tried again");
    }

    #[test]
    fn the_file() {
        let mut d = DockedApps::default();
        d.remember("com.apple.Music", "1.6 (16)", true);
        d.remember("com.example.Odd", "2", false);
        let v = d.to_json();
        assert_eq!(
            v,
            json!({"com.apple.Music": {"version": "1.6 (16)", "needs": true}, "com.example.Odd": {"version": "2", "needs": false}})
        );
        assert_eq!(DockedApps::load(&v), Some(d));
        for bad in [json!({"a": {"version": "1"}}), json!({"a": {"version": 1, "needs": true}}), json!([1]), json!("x")]
        {
            assert_eq!(DockedApps::load(&bad), None, "{bad}");
        }
        assert_eq!(DockedApps::load(&json!({})), Some(DockedApps::default()));
    }
}
