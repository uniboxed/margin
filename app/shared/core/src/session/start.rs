//! The item a Margin window showed last and the app its loader shows (HostedSession.swift `lastItem`, `loaderApp`;
//! docs/CORE-REFACTOR.md step 3, part 6).

use serde_json::Value;

use super::target::Target;
use crate::json;

/// Safari's bundle id (ExtensionLink.swift `safariIdentifier`).
pub const SAFARI: &str = "com.apple.Safari";

/// The app whose icon the loader shows for an item: an app's own, Safari for a web item, none for Margin's own page.
pub fn loader_app(target: &Target) -> Option<&str> {
    match target {
        Target::App { bundle, .. } => Some(bundle),
        Target::Web { .. } => Some(SAFARI),
        Target::Margin { .. } => None,
    }
}

/// One item of a space, as `last_item` weighs it: its id, its stored value, its target (none: it has none).
pub struct Candidate<'a> {
    pub id: &'a str,
    pub value: &'a Value,
    pub target: Option<Target>,
}

/// The item a window showed last, and the name its loader says. For an app's item, `app` is the bundle whose own
/// name goes first when the OS knows it (`name` is the item's then, else the bundle id).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastItem {
    pub item: String,
    pub target: Target,
    pub name: String,
    pub app: Option<String>,
}

/// The item a Margin window showed last, of its space's items: the selected one (the newest used if several; among
/// equal ones the smallest id), if it can be hosted (a web item: Safari's only, for now).
pub fn last_item<'a>(items: impl IntoIterator<Item = Candidate<'a>>) -> Option<LastItem> {
    // (Swift's `selected as? Bool == true`, `num(lastUsed) ?? 0`, and `.max` with the ids compared the other way.)
    let used = |c: &Candidate<'_>| json::num(c.value.get("lastUsed")).unwrap_or(0.0);
    let mut best: Option<(Candidate<'a>, f64)> = None;
    for c in items.into_iter().filter(|c| json::flag(c.value.get("selected")) == Some(true)) {
        let at = used(&c);
        let better = match &best {
            None => true,
            Some((b, b_at)) => *b_at < at || (*b_at == at && c.id < b.id),
        };
        if better {
            best = Some((c, at));
        }
    }
    let (last, _) = best?;
    let target = last.target?;
    let title = json::string(last.value.get("title")).filter(|t| !t.is_empty());
    let (name, app) = match &target {
        Target::App { bundle, name } => {
            (if name.is_empty() { bundle.clone() } else { name.clone() }, Some(bundle.clone()))
        }
        Target::Web { browser, .. } => {
            if browser != "safari" {
                return None;
            }
            (title.unwrap_or("Safari").to_owned(), None)
        }
        Target::Margin { .. } => (title.unwrap_or("Margin").to_owned(), None),
    };
    Some(LastItem { item: last.id.to_owned(), target, name, app })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn web() -> Option<Target> {
        Some(Target::Web { browser: "safari".into(), profile: None })
    }

    #[test]
    fn the_loaders_app() {
        assert_eq!(
            loader_app(&Target::App { bundle: "com.apple.Notes".into(), name: "Notes".into() }),
            Some("com.apple.Notes")
        );
        assert_eq!(loader_app(&Target::Web { browser: "chrome".into(), profile: Some("p".into()) }), Some(SAFARI));
        assert_eq!(loader_app(&Target::Margin { page: "settings".into() }), None);
    }

    // ---- T/session-rules-tests.swift lastItemTests ----

    #[test]
    fn the_newest_selected_the_smallest_id_at_a_tie() {
        let (b, a, c) = (
            json!({"selected":true,"lastUsed":50,"title":"B"}),
            json!({"selected":true,"lastUsed":50,"title":"A"}),
            json!({"selected":false,"lastUsed":90}),
        );
        let last = last_item([
            Candidate { id: "t-b", value: &b, target: web() },
            Candidate { id: "t-a", value: &a, target: web() },
            Candidate { id: "t-c", value: &c, target: web() },
        ]);
        assert_eq!(last.map(|l| (l.item, l.name)), Some(("t-a".into(), "A".into())));
        // (Either order in: the same one out.)
        let last = last_item([
            Candidate { id: "t-a", value: &a, target: web() },
            Candidate { id: "t-b", value: &b, target: web() },
        ]);
        assert_eq!(last.map(|l| l.item), Some("t-a".into()));
    }

    #[test]
    fn selected_as_swift_reads_a_bool_and_no_time_is_0() {
        let (a, b, c) = (
            json!({"selected":true,"title":""}),
            json!({"selected":1,"lastUsed":7,"title":""}),
            json!({"selected":"true","lastUsed":99}),
        );
        let last = last_item([
            Candidate { id: "u-a", value: &a, target: web() },
            Candidate { id: "u-b", value: &b, target: web() },
            Candidate { id: "u-c", value: &c, target: web() },
        ]);
        assert_eq!(last.map(|l| (l.item, l.name)), Some(("u-b".into(), "Safari".into())));
        let neg = json!({"selected":true,"lastUsed":-5});
        let none = json!({"selected":true,"lastUsed":"9"});
        let last = last_item([
            Candidate { id: "a", value: &neg, target: web() },
            Candidate { id: "b", value: &none, target: web() },
        ]);
        assert_eq!(last.map(|l| l.item), Some("b".into()), "a time that isn't a number is 0, newer than -5");
    }

    #[test]
    fn its_name_and_whether_it_can_be_hosted() {
        let v = json!({"selected":true,"lastUsed":3});
        let app = |name: &str| Some(Target::App { bundle: "com.x".into(), name: name.into() });
        let one = |target| last_item([Candidate { id: "i", value: &v, target }]);
        assert_eq!(one(app("")).map(|l| (l.name, l.app)), Some(("com.x".into(), Some("com.x".into()))));
        assert_eq!(one(app("X")).map(|l| l.name), Some("X".into()));
        assert_eq!(
            one(Some(Target::Web { browser: "chrome".into(), profile: None })),
            None,
            "another browser's: not hosted yet"
        );
        assert_eq!(one(Some(Target::Margin { page: "settings".into() })).map(|l| l.name), Some("Margin".into()));
        assert_eq!(one(None), None, "the last one has no target: none (not the one before it)");
        let titled = json!({"selected":true,"lastUsed":3,"title":"Docs"});
        assert_eq!(
            last_item([Candidate { id: "i", value: &titled, target: web() }]).map(|l| l.name),
            Some("Docs".into())
        );
        assert_eq!(last_item(Vec::new()), None);
    }
}
