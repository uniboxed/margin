//! Every app's own window minimum, known before its window is made (docs/PEEK-SPLIT.md §4; docs/CORE-REFACTOR.md
//! step 2 part 5): as its tile said it, kept per app (its bundle id; every Safari window Safari's) and per version of
//! it, beside routes.json in minimums.json (as the routes are, so it's known from the next launch on). Plain data:
//! the OS side reads and writes the file's bytes and reads the running apps' versions; nothing here reads either.
//!
//! The file, as the Mac has always written it (`[String: AppMinimum]`, JSONEncoder):
//! `{"com.apple.Notes":{"version":"4.12 (2700)","width":700,"height":400}}`. A file that doesn't read as that whole
//! (a field missing, of another kind) is taken as none; entries outside 0 ≤ side < 20000 are dropped.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::layout::Size;

/// The largest side a kept minimum may have (one past it is dropped at a load).
pub const SIDE_MAX: f64 = 20000.0;

/// An app's windows' minimum, for one version of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AppMinimum {
    pub version: String,
    pub width: f64,
    pub height: f64,
}

impl AppMinimum {
    pub fn size(&self) -> Size {
        Size::new(self.width, self.height)
    }
}

/// Every app's kept minimum, by its key.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AppMinimums {
    pub by_app: BTreeMap<String, AppMinimum>,
}

impl AppMinimums {
    /// The file's contents as read (JSON): every entry kept whose sides are within 0 ≤ side < 20000. None: it isn't
    /// the file's shape (nothing taken from it, as the Mac's decoder refused the whole file).
    pub fn load(v: &Value) -> Option<AppMinimums> {
        let read = BTreeMap::<String, AppMinimum>::deserialize(v).ok()?;
        let ok = |s: f64| (0.0..SIDE_MAX).contains(&s);
        Some(AppMinimums { by_app: read.into_iter().filter(|(_, m)| ok(m.width) && ok(m.height)).collect() })
    }

    /// The file's contents to write.
    pub fn to_json(&self) -> Value {
        serde_json::to_value(&self.by_app).unwrap_or(Value::Null)
    }

    /// An app's known minimum: none known, or none for another version of it than `running` (the version of the app
    /// running now, or of the host's own process; None: not known, and then the one kept holds).
    pub fn known(&self, app: &str, running: Option<&str>) -> Option<Size> {
        let m = self.by_app.get(app)?;
        if running.is_some_and(|v| v != m.version) {
            return None;
        }
        Some(m.size())
    }

    /// Whether anything is kept for `app` (any version).
    pub fn has(&self, app: &str) -> bool {
        self.by_app.contains_key(app)
    }

    /// A minimum just learnt for `app` at `version`: kept when it's new for that app and version. True: kept (the
    /// caller saves the file, says it, and tells the page).
    pub fn remember(&mut self, app: &str, version: &str, size: Size) -> bool {
        if let Some(m) = self.by_app.get(app)
            && m.version == version
            && m.width == size.width
            && m.height == size.height
        {
            return false;
        }
        self.by_app.insert(
            app.to_string(),
            AppMinimum { version: version.to_string(), width: size.width, height: size.height },
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // As the Mac's JSONEncoder wrote it (whole numbers without a point), the file an existing user has today.
    const TODAY: &str = r#"{"com.apple.Notes":{"version":"4.12 (2700)","width":700,"height":400},"com.apple.Safari":{"version":"26.2 (21623.1.14.11.9)","width":500,"height":289},"com.apple.TextEdit":{"height":150.5,"width":266,"version":"1.20 (414)"}}"#;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn todays_file_loads_unchanged() {
        let m = AppMinimums::load(&parse(TODAY)).unwrap();
        assert_eq!(m.by_app.len(), 3);
        assert_eq!(
            m.by_app["com.apple.Notes"],
            AppMinimum { version: "4.12 (2700)".into(), width: 700.0, height: 400.0 }
        );
        assert_eq!(m.known("com.apple.Safari", None), Some(Size::new(500.0, 289.0)));
        assert_eq!(m.known("com.apple.TextEdit", Some("1.20 (414)")), Some(Size::new(266.0, 150.5)));
        // Written back: the same entries (numbers as JSON numbers; the Mac's reader takes 700 and 700.0 alike).
        let back = AppMinimums::load(&m.to_json()).unwrap();
        assert_eq!(back, m);
        assert_eq!(m.to_json()["com.apple.Notes"], json!({"version": "4.12 (2700)", "width": 700.0, "height": 400.0}));
    }

    #[test]
    fn the_load_filter() {
        let m = AppMinimums::load(&json!({
            "a": {"version": "1", "width": 0, "height": 0},
            "b": {"version": "1", "width": -1, "height": 10},
            "c": {"version": "1", "width": 10, "height": 20000},
            "d": {"version": "1", "width": 19999.5, "height": 10},
            "e": {"version": "1", "width": 10, "height": -0.0},
            "f": {"version": "1", "width": 10, "height": 10, "more": true},
        }))
        .unwrap();
        let kept: Vec<&str> = m.by_app.keys().map(String::as_str).collect();
        assert_eq!(kept, ["a", "d", "e", "f"], "0 ≤ side < 20000, a field more ignored");
        // Not the file's shape: nothing taken (the whole file, as the Mac's decoder).
        for bad in [
            json!({"a": {"version": "1", "width": 10}}),
            json!({"a": {"version": 1, "width": 10, "height": 10}}),
            json!({"a": {"version": "1", "width": "10", "height": 10}}),
            json!({"a": {"version": "1", "width": 10, "height": 10}, "b": null}),
            json!([1, 2]),
            json!("x"),
        ] {
            assert_eq!(AppMinimums::load(&bad), None, "{bad}");
        }
        assert_eq!(AppMinimums::load(&json!({})), Some(AppMinimums::default()));
    }

    #[test]
    fn version_gating() {
        let mut m = AppMinimums::default();
        assert_eq!(m.known("com.apple.Notes", None), None);
        assert!(m.remember("com.apple.Notes", "4.12 (2700)", Size::new(700.0, 400.0)));
        assert_eq!(m.known("com.apple.Notes", None), Some(Size::new(700.0, 400.0)), "no version known: the one kept");
        assert_eq!(m.known("com.apple.Notes", Some("4.12 (2700)")), Some(Size::new(700.0, 400.0)));
        assert_eq!(m.known("com.apple.Notes", Some("4.13 (2750)")), None, "another version: learnt again");
        assert_eq!(m.known("com.apple.notes", None), None, "keys as they are");
        assert!(m.has("com.apple.Notes") && !m.has("x"));
    }

    #[test]
    fn remembered_only_when_new() {
        let mut m = AppMinimums::default();
        assert!(m.remember("a", "1", Size::new(700.0, 400.0)));
        assert!(!m.remember("a", "1", Size::new(700.0, 400.0)), "the same: not kept again");
        assert!(m.remember("a", "1", Size::new(701.0, 400.0)), "another size");
        assert!(m.remember("a", "2", Size::new(701.0, 400.0)), "another version");
        assert!(m.remember("a", "?", Size::new(701.0, 400.0)), "a version unread: kept as ?");
        assert_eq!(m.by_app["a"], AppMinimum { version: "?".into(), width: 701.0, height: 400.0 });
        assert_eq!(m.known("a", Some("2")), None, "kept for ?, asked for 2");
        assert_eq!(m.known("a", None), Some(Size::new(701.0, 400.0)));
    }
}
