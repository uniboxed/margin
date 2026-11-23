//! Where an item opens (Library.swift `ItemTarget`): a browser's profile, a Mac app, one of Margin's own pages.
//!
//! Read here from the shape the Swift writes (`ItemTarget.json`: `{ kind: "web", browser, profile }`, `{ kind: "app",
//! bundleId, name }`, `{ kind: "margin", page }`), which the Swift makes from the library's values with its own rules
//! (`ItemTarget(json:)`: the default browser, an empty profile, the pages there are). Those rules move here with the
//! library's requests (step 3, part 1), which carry a target.

use serde_json::Value;

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

impl Target {
    /// From the shape `ItemTarget.json` writes; `None` for anything else.
    pub fn read(v: &Value) -> Option<Target> {
        let o = v.as_object()?;
        let s = |k: &str| json::string(o.get(k)).map(str::to_owned);
        match json::string(o.get("kind"))? {
            "web" => Some(Target::Web { browser: s("browser")?, profile: s("profile") }),
            "app" => Some(Target::App { bundle: s("bundleId")?, name: s("name")? }),
            "margin" => Some(Target::Margin { page: s("page")? }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        assert_eq!(Target::read(&json!({"kind":"app","bundleId":"x"})), None);
        assert_eq!(Target::read(&json!({"kind":"other"})), None);
        assert_eq!(Target::read(&Value::Null), None);
    }
}
