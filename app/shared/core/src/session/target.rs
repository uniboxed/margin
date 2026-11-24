//! Where an item opens (Library.swift `ItemTarget`, L:23-51): a browser's profile, a Mac app, one of Margin's own
//! pages; read from the library's values with `ItemTarget(json:)`'s rules (moved here with the library's requests,
//! step 3 part 1), written as `ItemTarget.json` writes it.

use serde_json::{Value, json};

use crate::json;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A browser's profile (none: the browser's default).
    Web {
        browser: String,
        profile: Option<String>,
    },
    App {
        bundle: String,
        name: String,
    },
    /// One of Margin's own pages, drawn in Margin's window: nothing hosted.
    Margin {
        page: String,
    },
}

/// Margin's own pages (library.ts `MARGIN_PAGES`, ItemTarget `marginPages`).
pub const MARGIN_PAGES: &[&str] = &["settings"];

impl Target {
    /// `ItemTarget(json:)`: `kind` web (its browser, Safari unless it names one; an empty profile is none), app (a
    /// bundle id that isn't empty; its name, else the id), margin (one of Margin's pages); `None` for anything else.
    pub fn read(v: &Value) -> Option<Target> {
        let o = v.as_object()?;
        let s = |k: &str| json::string(o.get(k));
        match s("kind")? {
            "web" => Some(Target::Web {
                browser: s("browser").unwrap_or("safari").to_owned(),
                profile: s("profile").filter(|p| !p.is_empty()).map(str::to_owned),
            }),
            "app" => {
                let id = s("bundleId").filter(|i| !i.is_empty())?;
                Some(Target::App { bundle: id.to_owned(), name: s("name").unwrap_or(id).to_owned() })
            }
            "margin" => {
                let page = s("page").filter(|p| MARGIN_PAGES.contains(p))?;
                Some(Target::Margin { page: page.to_owned() })
            }
            _ => None,
        }
    }

    /// Its JSON (`ItemTarget.json`).
    pub fn json(&self) -> Value {
        match self {
            Target::Web { browser, profile } => json!({ "kind": "web", "browser": browser, "profile": profile }),
            Target::App { bundle, name } => json!({ "kind": "app", "bundleId": bundle, "name": name }),
            Target::Margin { page } => json!({ "kind": "margin", "page": page }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shape_the_swift_writes() {
        assert_eq!(
            Target::read(&json!({"kind":"web","browser":"safari","profile":null})),
            Some(Target::Web { browser: "safari".into(), profile: None })
        );
        assert_eq!(
            Target::read(&json!({"kind":"web","browser":"safari","profile":"p"})),
            Some(Target::Web { browser: "safari".into(), profile: Some("p".into()) })
        );
        assert_eq!(
            Target::read(&json!({"kind":"app","bundleId":"com.apple.Notes","name":"Notes"})),
            Some(Target::App { bundle: "com.apple.Notes".into(), name: "Notes".into() })
        );
        assert_eq!(
            Target::read(&json!({"kind":"margin","page":"settings"})),
            Some(Target::Margin { page: "settings".into() })
        );
        assert_eq!(Target::read(&json!({"kind":"other"})), None);
        assert_eq!(Target::read(&Value::Null), None);
    }

    #[test]
    fn as_item_target_reads_the_librarys_values() {
        let r = |v: Value| Target::read(&v);
        assert_eq!(
            r(json!({ "kind": "web", "profile": "" })),
            Some(Target::Web { browser: "safari".into(), profile: None })
        );
        assert_eq!(
            r(json!({ "kind": "web", "browser": "chrome", "profile": "p" })),
            Some(Target::Web { browser: "chrome".into(), profile: Some("p".into()) })
        );
        assert_eq!(
            r(json!({ "kind": "web", "browser": 5, "profile": 7 })),
            Some(Target::Web { browser: "safari".into(), profile: None })
        );
        assert_eq!(r(json!({ "kind": "app", "bundleId": "" })), None);
        assert_eq!(
            r(json!({ "kind": "app", "bundleId": "x" })),
            Some(Target::App { bundle: "x".into(), name: "x".into() })
        );
        assert_eq!(r(json!({ "kind": "margin", "page": "nope" })), None);
        assert_eq!(r(json!("web")), None);
        for t in [
            Target::Web { browser: "safari".into(), profile: None },
            Target::App { bundle: "com.a".into(), name: "A".into() },
            Target::Margin { page: "settings".into() },
        ] {
            assert_eq!(Target::read(&t.json()), Some(t));
        }
    }
}
