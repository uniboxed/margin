//! What the UI asks of the session (docs/CORE-REFACTOR.md step 3, part 10): a search's address (HostedSession.swift
//! `LibraryWindowSource.searchUrl`).

use super::unicode::{COMPOSED_EXTEND, GRAPHEME_EXTEND, contains_characters, has};

/// Safari's default engine, Google's.
pub const GOOGLE: &str = "https://www.google.com/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8";

/// Whether `text` starts with `prefix` (ASCII) as Swift's `hasPrefix` sees it: as whole characters.
fn has_prefix_characters(text: &str, prefix: &str) -> bool {
    text.starts_with(prefix) && !text[prefix.len()..].chars().next().is_some_and(|c| has(GRAPHEME_EXTEND, c))
}

/// `text` with every `needle` (ASCII) replaced as NSString's `replacingOccurrences(of:with:)` does it: left to right,
/// not where the scalar after it makes one composed sequence with its last.
fn replace_composed(text: &str, needle: &str, with: &str) -> String {
    let mut out = String::with_capacity(text.len() + with.len());
    let mut from = 0;
    for (at, _) in text.match_indices(needle) {
        if text[at + needle.len()..].chars().next().is_some_and(|c| has(COMPOSED_EXTEND, c)) {
            continue;
        }
        out.push_str(&text[from..at]);
        out.push_str(with);
        from = at + needle.len();
    }
    out.push_str(&text[from..]);
    out
}

/// A query percent-encoded as Foundation's `addingPercentEncoding(withAllowedCharacters:)` did with
/// `CharacterSet.alphanumerics` and `-_.!~*'()`: that method ignores whatever of the set isn't ASCII, so ASCII's
/// letters and digits and those marks stay, everything else is its UTF-8 bytes as `%XX` (encodeURIComponent's set).
fn encode(query: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(query.len());
    for &b in query.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 15) as usize] as char);
        }
    }
    out
}

/// The search's address: the engine Safari searches with as the copy learned it (`settings.safariSearch.template`,
/// shared/search.ts safariEngine: an https address with `%s` in it), else Google's, as Safari's default; every `%s`
/// is the query, encoded.
pub fn search_url(query: &str, learned: Option<&str>) -> String {
    let template =
        learned.filter(|t| contains_characters(t, "%s") && has_prefix_characters(t, "https://")).unwrap_or(GOOGLE);
    replace_composed(template, "%s", &encode(query))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(query: &str) -> String {
        search_url(query, None)
            .replace("https://www.google.com/search?client=safari&rls=en&q=", "")
            .replace("&ie=UTF-8&oe=UTF-8", "")
    }

    // ---- T/session-rules-tests.swift searchUrlTests, T/hosted-tests.swift 1902-1905 ----

    #[test]
    fn a_search_address() {
        assert_eq!(search_url("x", None), GOOGLE.replace("%s", "x"));
        assert!(search_url("a b&c", None).contains("q=a%20b%26c"));
        assert_eq!(q("aZ09-_.!~*'()"), "aZ09-_.!~*'()");
        assert_eq!(
            q(" &=+/?#%:@\"<>[]\\^`{|}$,;"),
            "%20%26%3D%2B%2F%3F%23%25%3A%40%22%3C%3E%5B%5D%5C%5E%60%7B%7C%7D%24%2C%3B"
        );
        assert_eq!(q("\t\n\u{7f}"), "%09%0A%7F");
        assert_eq!(q("café"), "caf%C3%A9");
        assert_eq!(q("e\u{301}"), "e%CC%81");
        assert_eq!(q("١٢"), "%D9%A1%D9%A2");
        assert_eq!(q("😀"), "%F0%9F%98%80");
        assert_eq!(q("%s"), "%25s");
        assert_eq!(q(""), "");
    }

    #[test]
    fn a_learned_template() {
        assert_eq!(
            search_url("a b", Some("https://e.example/?q=%s&again=%s")),
            "https://e.example/?q=a%20b&again=a%20b"
        );
        for t in ["https://e.example/?q=", "http://e.example/?q=%s", "javascript:%s", ""] {
            assert!(search_url("x", Some(t)).starts_with("https://www.google.com/"), "{t:?}");
        }
        assert_eq!(search_url("x", Some("https://duckduckgo.com/?q=%s")), "https://duckduckgo.com/?q=x");
    }

    // ---- what Swift and NSString make of marks beside a template's "%s" and "https://" (probed, macOS 27.2) ----

    #[test]
    fn marks_beside_the_template_as_the_swift() {
        let t = |s: &str| search_url("Q", Some(s));
        assert_eq!(
            t("https://e/?q=%s\u{301}"),
            GOOGLE.replace("%s", "Q"),
            "a mark on its s: not a %s (Swift's characters)"
        );
        assert_eq!(t("https://e/?q=\u{301}%s"), "https://e/?q=\u{301}Q");
        assert_eq!(t("https://\u{301}e/?q=%s"), GOOGLE.replace("%s", "Q"), "a mark on the prefix's last /");
        assert_eq!(t("https://e/?q=\u{600}%s"), GOOGLE.replace("%s", "Q"), "a prepended mark before its %");
        assert_eq!(t("https://e/?q=%s%s\u{301}%s"), "https://e/?q=Q%s\u{301}Q", "NSString's: not the one a mark joins");
        assert_eq!(
            t("https://e/?q=%s\u{200D}x%s"),
            "https://e/?q=Q\u{200D}xQ",
            "a joiner: Swift's character, not NSString's"
        );
        assert_eq!(t("https://e/?q=\r\n%s"), "https://e/?q=\r\nQ");
        assert_eq!(t("https://e/?q=%S"), GOOGLE.replace("%s", "Q"));
    }
}
