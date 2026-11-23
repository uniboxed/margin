//! A web item's Safari profile (HostedSession.swift `resolve`; docs/CORE-REFACTOR.md step 3, part 2).

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

#[cfg(test)]
mod tests {
    use super::*;

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
