//! A web item's Safari profile (HostedSession.swift `resolve`) and the browser web items open in (`DefaultBrowser`;
//! docs/CORE-REFACTOR.md step 3, part 2).

use crate::data::profiles::DEFAULT_PROFILE;

/// A web item's Safari profile: its own, else the default profile's copy (or, when only others have linked, the first
/// of them in order). Ordered by their UTF-8, as Swift orders profile ids (ASCII: Safari's own and Margin's `s-…`).
pub fn resolve(profile: Option<&str>, linked: &[&str]) -> String {
    if let Some(p) = profile {
        return p.to_owned();
    }
    if linked.is_empty() || linked.contains(&DEFAULT_PROFILE) {
        return DEFAULT_PROFILE.to_owned();
    }
    linked.iter().min().map_or_else(|| DEFAULT_PROFILE.to_owned(), |p| (*p).to_owned())
}

/// The browsers Margin hosts by the setting's value (Safari only now: Chrome and Edge join it when they're hosted).
pub const SUPPORTED_BROWSERS: &[(&str, &str)] = &[("safari", "com.apple.Safari")];

/// The browser web items open in, by the setting's value (UserDefaults `MarginDefaultBrowser`, default `safari`):
/// trimmed of spaces and tabs (`.whitespaces`: tab and the space separators), lowercased; its name and bundle id, and
/// whether the value was one Margin hosts (not: Safari, said by the caller).
pub fn default_browser(setting: Option<&str>) -> (&'static str, &'static str, bool) {
    let v = setting.unwrap_or("safari");
    let v = v.trim_matches(|c: char| c == '\t' || unicode_space(c)).to_lowercase();
    match SUPPORTED_BROWSERS.iter().find(|(name, _)| *name == v) {
        Some((name, bundle)) => (name, bundle, true),
        None => (SUPPORTED_BROWSERS[0].0, SUPPORTED_BROWSERS[0].1, false),
    }
}

/// `CharacterSet.whitespaces` less the tab: Unicode's space separators (Zs) and, as Foundation has it, U+200B.
fn unicode_space(c: char) -> bool {
    matches!(c, ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200b}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_browser_by_its_setting() {
        // (DefaultBrowser.resolve's answers, Swift 6.4, 2026-11-23.)
        for (setting, want) in [
            (None, ("safari", "com.apple.Safari", true)),
            (Some(" Safari\t"), ("safari", "com.apple.Safari", true)),
            (Some("\u{3000}SAFARI\u{a0}"), ("safari", "com.apple.Safari", true)),
            (Some("safari\n"), ("safari", "com.apple.Safari", false)),
            (Some("chrome"), ("safari", "com.apple.Safari", false)),
            (Some(""), ("safari", "com.apple.Safari", false)),
            (Some("\u{200b}safari"), ("safari", "com.apple.Safari", true)),
            (Some("\u{2028}safari"), ("safari", "com.apple.Safari", false)),
            (Some("\u{85}safari"), ("safari", "com.apple.Safari", false)),
        ] {
            assert_eq!(default_browser(setting), want, "{setting:?}");
        }
    }

    #[test]
    fn its_own_else_the_defaults_else_the_first() {
        assert_eq!(resolve(Some("p-x"), &["s-default"]), "p-x");
        assert_eq!(resolve(Some(""), &[]), "", "its own, even empty (the library never says one)");
        assert_eq!(resolve(None, &[]), DEFAULT_PROFILE);
        assert_eq!(resolve(None, &["zz", DEFAULT_PROFILE, "aa"]), DEFAULT_PROFILE);
        assert_eq!(resolve(None, &["zz", "aa", "mm"]), "aa");
        assert_eq!(resolve(None, &["s-b", "S-a"]), "S-a", "by their bytes: uppercase first");
    }
}
