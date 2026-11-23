//! The preview card's default rect and what a web address is (HostedPeek.swift `defaultCardRect`, `webAddress`;
//! docs/CORE-REFACTOR.md step 3, part 4).

use std::ops::Range;

use super::{swift_max, swift_min};
use crate::geometry::{Rect, cg};

/// Margin's default card rect in a page area (a theme with no `<m-preview-page>`): centred, 8% each side and 7%
/// above and below at most (at least 420 wide, 320 tall for its page), its page under a 52 pt bar (at least Safari's
/// full-screen toolbar window, which rests just above the card window, never seen through the dim). Rounded half
/// away from zero, as CGFloat's `rounded()`.
pub fn default_card_rect(page: Rect) -> Rect {
    let p = cg::standard(&page);
    let bar = 52.0;
    let w = swift_max(
        swift_min(p.width, 420.0),
        p.width - 2.0 * swift_min(p.width * 0.08, swift_max(0.0, (p.width - 420.0) / 2.0)),
    );
    let h = swift_max(
        swift_min(p.height, 320.0 + bar),
        p.height - 2.0 * swift_min(p.height * 0.07, swift_max(0.0, (p.height - 320.0 - bar) / 2.0)),
    );
    let x = p.x + (p.width - w) / 2.0;
    let y = p.y + (p.height - h) / 2.0;
    Rect::new(x.round(), (y + bar).round(), w.round(), swift_max(0.0, h - bar).round())
}

/// What `web_address_parts` says of a text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebAddress {
    Yes,
    No,
    /// Everything else is one; its host (these bytes of the text) has letters outside ASCII, which the OS's IDNA
    /// (UTS #46, as Foundation runs ICU's) must make an ASCII name of for it to be one.
    Host(Range<usize>),
}

/// The longest web address, in Unicode scalars (the Swift counted `Character`s: a text with combining marks or
/// joined emoji past 2,048 scalars but not 2,048 characters is one there, not here; step 1's rule for every cap).
pub const WEB_ADDRESS_MAX: usize = 2048;

// RFC 3986's allowed characters as Foundation's parser keeps them (swift-foundation URLParser.swift
// `URLComponentAllowedMask`): bit n is ASCII n.
const HOST: u128 = 0x47ff_fffe_87ff_fffe_2bff_7fd2_0000_0000;
const HOST_IP_FUTURE: u128 = 0x47ff_fffe_87ff_fffe_2fff_7fd2_0000_0000;

fn allowed(mask: u128, b: u8) -> bool {
    b < 128 && mask & (1u128 << b) != 0
}

/// Every byte allowed, a `%` only as the start of two hex digits (URLParser `validate(buffer:)`).
fn valid_encoded(bytes: &[u8], mask: u128) -> bool {
    let mut hex = 0;
    for &b in bytes {
        if b >= 128 {
            return false;
        }
        if b == b'%' {
            if hex != 0 {
                return false;
            }
            hex = 2;
        } else if !allowed(mask, b) {
            return false;
        } else if hex > 0 {
            if !b.is_ascii_hexdigit() {
                return false;
            }
            hex -= 1;
        }
    }
    hex == 0
}

/// Whether `s` is an http or https address Foundation's `URL(string:)` makes a URL of (as macOS 14 and later parse
/// it: RFC 3986, invalid characters percent-encoded, so only the authority can refuse it: a port that isn't digits,
/// something after an IP literal but its port, an IP literal with a character it can't have, a host that isn't one).
/// Its parts, with the one question only the OS can answer (`Host`).
pub fn web_address_parts(s: &str) -> WebAddress {
    if s.is_empty() || s.chars().count() > WEB_ADDRESS_MAX {
        return WebAddress::No;
    }
    let b = s.as_bytes();
    // The scheme: up to the first ":", unless a "/", "?", "#", "[", "]" or "@" comes first (a relative reference).
    let Some(colon) =
        b.iter().position(|&c| matches!(c, b':' | b'/' | b'?' | b'#' | b'[' | b']' | b'@')).filter(|&i| b[i] == b':')
    else {
        return WebAddress::No;
    };
    let scheme = &s[..colon];
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return WebAddress::No;
    }
    let rest = colon + 1;
    if !b[rest..].starts_with(b"//") {
        return WebAddress::Yes; // (no authority: the rest is a path, a query and a fragment, encoded as needed)
    }
    let start = rest + 2;
    let end = b[start..].iter().position(|&c| matches!(c, b'/' | b'?' | b'#')).map_or(b.len(), |i| start + i);
    let authority = &b[start..end];
    if authority.is_empty() {
        return WebAddress::Yes;
    }
    // The user and password: up to the last "@" (always encoded as needed).
    let host_start = authority.iter().rposition(|&c| c == b'@').map_or(0, |i| i + 1);
    let mut host_end = authority.len();
    let mut port: Option<&[u8]> = None;
    let literal_end = (authority.get(host_start) == Some(&b'['))
        .then(|| authority[host_start..].iter().position(|&c| c == b']').map(|i| host_start + i))
        .flatten();
    if let Some(close) = literal_end {
        host_end = close + 1;
        if host_end != authority.len() {
            if authority[host_end] != b':' {
                return WebAddress::No; // (something after the IP literal but its port)
            }
            port = Some(&authority[host_end + 1..]);
        }
    } else if let Some(c) = authority[host_start..].iter().position(|&c| c == b':').map(|i| host_start + i) {
        host_end = c;
        port = Some(&authority[c + 1..]); // (an empty port is one: URL allows it)
    }
    if port.is_some_and(|p| !p.iter().all(u8::is_ascii_digit)) {
        return WebAddress::No;
    }
    let host = &authority[host_start..host_end];
    if literal_end.is_some() {
        // An IP literal: what comes before its zone id ("%", encoded if it isn't already) has only the characters an
        // address or IPvFuture can have; the zone id is encoded as needed.
        let inner = &host[1..host.len() - 1];
        let address = inner.iter().position(|&c| c == b'%').map_or(inner, |i| &inner[..i]);
        return if address.iter().all(|&c| allowed(HOST_IP_FUTURE, c)) { WebAddress::Yes } else { WebAddress::No };
    }
    if host.iter().any(|&c| c >= 128) {
        let at = start + host_start;
        return WebAddress::Host(at..at + host.len());
    }
    // An ASCII name: what it may have as it is (IDNA changes no ASCII but its case).
    if valid_encoded(host, HOST) { WebAddress::Yes } else { WebAddress::No }
}

/// Whether `s` is a web address (HostedPeek `webAddress`): `idna` answers for a host with letters outside ASCII
/// (whether the OS's IDNA makes a valid ASCII name of it).
pub fn web_address(s: &str, idna: impl FnOnce(&str) -> bool) -> bool {
    match web_address_parts(s) {
        WebAddress::Yes => true,
        WebAddress::No => false,
        WebAddress::Host(r) => idna(&s[r]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- T/peek-session-tests.swift 193-199 ----

    #[test]
    fn the_default_card_rect() {
        let page = Rect::new(260.0, 41.0, 1244.0, 933.0);
        let r = default_card_rect(page);
        // (Arcadia's page area: 8% each side is 99.52, under the 412 the 420 least leaves; 7% above and below.)
        assert_eq!(r, Rect::new(360.0, 158.0, 1045.0, 750.0), "{r:?}");
        let small = default_card_rect(Rect::new(0.0, 0.0, 500.0, 400.0));
        assert_eq!(small, Rect::new(40.0, 66.0, 420.0, 320.0), "{small:?}");
        let tiny = default_card_rect(Rect::new(10.0, 10.0, 300.0, 40.0));
        assert_eq!(tiny, Rect::new(10.0, 62.0, 300.0, 0.0), "the page's whole area, under the bar: no height");
        assert_eq!(
            default_card_rect(Rect::new(0.0, 0.0, -500.0, 400.0)),
            Rect::new(-460.0, 66.0, 420.0, 320.0),
            "standardized"
        );
        // (Half away from zero, as CGFloat's rounded().)
        assert_eq!(default_card_rect(Rect::new(0.5, 0.0, 420.0, 372.0)).x, 1.0);
        assert_eq!(default_card_rect(Rect::new(-0.5, 0.0, 420.0, 372.0)).x, -1.0);
    }

    // ---- T/session-rules-tests.swift webAddressTests: Foundation's answers on macOS 27.2 ----

    fn ok(s: &str) -> bool {
        // (The OS's IDNA as Foundation's for the hosts these vectors have.)
        web_address(s, |host| !matches!(host, "-é" | "aש" | "a\u{200D}b"))
    }

    #[test]
    fn web_addresses() {
        for s in [
            "http:",
            "https://",
            "HTTP://A",
            "http://a/b c",
            "http://a/%zz",
            "http://a:80/",
            "http://[::1]/",
            "http://[zz]/",
            "http://a%20b/",
            "http://a/é",
            "http://a/\n",
            "http://u:p@@a/",
            "http://u@a@b/",
            "http://a:/",
            "http://a:99999999999/",
            "http://:80/",
            "http://[::1%en0]/",
            "http://[]/",
            "https:x y",
            "http://a!$&'()*+,;=b/",
            "https://docs.example.org/guide?q=1#top",
            "http://a?b",
            "http://a#b",
            "http://@/",
            "http://u a@b/",
            "http://[::1]:80/",
            "http://[::1]:/",
            "http://[v1.a]/",
            "http://[::1%25en0]/",
            "http://[a%zz]/",
            "http://u:p:q@a/",
        ] {
            assert!(ok(s), "{s:?} is one");
        }
        for s in [
            "",
            " http://a/",
            "http://a b",
            "http://a:xx/",
            "http://a:-1/",
            "http://[::1/",
            "http://a]b/",
            "http://a%zzb/",
            "http://a\\b/",
            "http://a^b/",
            "http://[::1]x/",
            "http://[::1]:x/",
            "http://a:80:80/",
            "http://a:８０/",
            "http://[é]/",
            "http://[a b]/",
            "javascript:alert(1)",
            "about:blank",
            "ftp://a/",
            "file:///etc/hosts",
            ":http://a",
            "http//a",
            "ht+tp://a",
            "http://a%/",
            "http://a<b/",
            "http://a\u{7f}b/",
            "http://a\u{0}b/",
            "http://-é/",
            "http://aש/",
            "http://a\u{200D}b/",
        ] {
            assert!(!ok(s), "{s:?} isn't one");
        }
    }

    #[test]
    fn a_non_ascii_host_is_the_os_s_question() {
        assert_eq!(web_address_parts("http://é.com/x"), WebAddress::Host(7..13));
        assert_eq!(web_address_parts("https://u:é@a/"), WebAddress::Yes, "a user's letters are encoded");
        assert_eq!(web_address_parts("http://a/é"), WebAddress::Yes);
        assert_eq!(web_address_parts("http://u@é:8/"), WebAddress::Host(9..11));
        assert_eq!(web_address_parts("http://é:x/"), WebAddress::No, "the port first");
        let mut asked = None;
        assert!(!web_address("http://ab.שלום:80/", |h| {
            asked = Some(h.to_owned());
            false
        }));
        assert_eq!(asked.as_deref(), Some("ab.שלום"));
    }

    #[test]
    fn at_most_2048_scalars() {
        let head = "https://a/";
        let at = format!("{head}{}", "x".repeat(WEB_ADDRESS_MAX - head.len()));
        assert!(ok(&at));
        assert!(!ok(&format!("{at}x")));
        // (2,048 characters, 2,049 scalars: one in the Swift, not here: the accepted edge.)
        let marks = format!("{head}{}e\u{301}", "x".repeat(WEB_ADDRESS_MAX - 1 - head.len()));
        assert!(!ok(&marks));
    }
}
