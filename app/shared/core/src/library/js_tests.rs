// js.rs's edges, each table JavaScriptCore's answers on the Mac (a bare JSContext, macOS 27.2, en-US, 2026-11-23; Node
// 25 gave the same for all of these). The exhaustive runs (every code point's space, every ASCII pair, 63,488 BMP
// characters' order, 30,000 random pairs) are the scratch harness's; their outcome is in DECISIONS.md.

use super::*;
use serde_json::json;

const SPACES: [u32; 25] = [
    0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

#[test]
fn spaces_are_js_spaces_every_code_point() {
    // JSC: `String.fromCodePoint(c).trim() === ''` and `/\s/.test(…)` over 0..=0x10FFFF, the same list for both.
    for c in (0..=0x10ffffu32).filter_map(char::from_u32) {
        assert_eq!(is_space(c), SPACES.contains(&(c as u32)), "U+{:04X}", c as u32);
    }
    assert_eq!(trim("\u{feff} a \u{3000}"), "a");
    assert_eq!(trim("\u{85}a\u{180e}"), "\u{85}a\u{180e}"); // Rust's `str::trim` would cut U+0085
    assert_eq!(trim(" \t\n "), "");
}

#[test]
fn squashed_as_js_replaces_runs() {
    // JSC: ' a\t b  c﻿\u0085d  ᠎ e '.replace(/\s+/g, ' ')
    assert_eq!(squash_spaces(" a\t\u{a0}b\u{2028}\u{2029}c\u{feff}\u{85}d  \u{180e} e "), " a b c \u{85}d \u{180e} e ");
    assert!(matches!(squash_spaces("a b c"), Cow::Borrowed(_)));
    assert!(matches!(squash_spaces("a  b"), Cow::Owned(_)));
    assert_eq!(squash_spaces("a\tb"), "a b");
    assert_eq!(squash_spaces(""), "");
}

#[test]
fn lengths_and_cuts_count_utf16_units() {
    assert_eq!(len16("a😀b"), 4);
    assert_eq!(len16("é"), 1);
    assert_eq!(len16(""), 0);
    // JSC's slice(0, n) of 'a😀b' for 1, 2, 3: 'a', 'a\ud83d' (half: dropped here, Tirth's answer 3), 'a😀'.
    assert_eq!(slice16("a😀b", 1), "a");
    assert_eq!(slice16("a😀b", 2), "a");
    assert_eq!(slice16("a😀b", 3), "a😀");
    assert_eq!(slice16("😀😀", 1), "");
    assert_eq!(slice16("😀😀", 3), "😀");
    assert_eq!(slice16("ab😀", 3), "ab");
    assert_eq!(slice16("ab😀", 4), "ab😀");
    assert_eq!(slice16("éééé", 2), "éé"); // 8 bytes, 4 units
    // 2,000 units with an emoji across the cut: 1,999 kept.
    let title = format!("{}😀tail", "a".repeat(1999));
    assert_eq!(len16(slice16(&title, 2000)), 1999);
    let s = "short";
    assert!(std::ptr::eq(slice16(s, 2000), s));
}

#[test]
fn sort_with_no_comparator_is_utf16_order() {
    // JSC: [...].sort() (the empty string, then by units: the supplementary planes before U+E000–U+FFFF).
    let mut list = vec![
        "\u{e000}",
        "\u{ffff}",
        "😀",
        "\u{10000}",
        "a",
        "A",
        "",
        "ab",
        "a\0",
        "\u{e9}",
        "e\u{301}",
        "\u{ff21}",
        "😀x",
    ];
    list.sort_by(|a, b| cmp16(a, b));
    assert_eq!(
        list,
        ["", "A", "a", "a\0", "ab", "e\u{301}", "\u{e9}", "\u{10000}", "😀", "😀x", "\u{e000}", "\u{ff21}", "\u{ffff}"]
    );
}

#[test]
fn locale_compare_orders_ascii_as_jsc() {
    // Printable ASCII in JSC's localeCompare order (en-US); no two of them equal. The scratch harness checks all 9,025
    // pairs' signs against JSC's.
    let order = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";
    let c = Collation::default();
    let chars: Vec<String> = order.chars().map(String::from).collect();
    for (i, a) in chars.iter().enumerate() {
        for (j, b) in chars.iter().enumerate() {
            assert_eq!(c.compare(a, b), i.cmp(&j), "{a:?} vs {b:?}");
        }
    }
}

#[test]
fn locale_compare_on_ids() {
    let c = Collation::default();
    // JSC: each pair's localeCompare sign.
    for (a, b, want) in [
        ("sp-a", "sp-B", Ordering::Less),
        ("sp-b", "sp-B", Ordering::Less),
        ("sp-B", "sp-c", Ordering::Less),
        ("t-a1", "t-a_1", Ordering::Greater),
        ("safari:Work:x", "safari:Personal:x", Ordering::Greater),
        ("fav-9", "fav-a", Ordering::Less),
        ("atc-10", "atc-9", Ordering::Less),
        ("a", "a\0", Ordering::Equal),
        ("sp-x", "sp-x", Ordering::Equal),
        ("", "a", Ordering::Less),
    ] {
        assert_eq!(locale_compare(&c, a, b), want, "{a:?} vs {b:?}");
    }
}

#[test]
fn locale_compare_takes_the_locale() {
    // A tailored locale reorders ASCII: Danish puts "aa" (å) after "z".
    assert_eq!(Collation::new("en-US").compare("aa", "z"), Ordering::Less);
    assert_eq!(Collation::new("da").compare("aa", "z"), Ordering::Greater);
    assert_eq!(Collation::new("not a tag!").compare("aa", "z"), Ordering::Less);
}

#[test]
fn round_as_math_round() {
    // JSC's Math.round.
    for (x, want) in [
        (0.5, 1.0),
        (1.5, 2.0),
        (2.5, 3.0),
        (-0.5, -0.0),
        (-1.5, -1.0),
        (-2.5, -2.0),
        (0.49999999999999994, 0.0),
        (-0.49999999999999994, -0.0),
        (4503599627370495.5, 4503599627370496.0),
        (-4503599627370495.5, -4503599627370495.0),
        (4503599627370497.0, 4503599627370497.0),
        (0.1, 0.0),
        (-0.1, -0.0),
        (-0.0, -0.0),
        (0.0, 0.0),
        (1e300, 1e300),
        (2.4999999999999996, 2.0),
        (0.6, 1.0),
        (-0.6, -1.0),
        (3.5000000000000004, 4.0),
        (f64::INFINITY, f64::INFINITY),
        (f64::NEG_INFINITY, f64::NEG_INFINITY),
    ] {
        let r = round(x);
        assert!(r == want && r.is_sign_negative() == want.is_sign_negative(), "round({x}) = {r}, want {want}");
    }
    assert!(round(f64::NAN).is_nan());
    // A split's ratios (library.ts stateOf): Math.round((r / sum) * 10000) / 10000.
    assert_eq!([1.0, 2.0, 3.0].map(|r: f64| round((r / 6.0) * 10000.0) / 10000.0), [0.1667, 0.3333, 0.5]);
}

#[test]
fn max_and_min_as_math() {
    let neg = |x: f64| x == 0.0 && x.is_sign_negative();
    // JSC: Math.max(0, -0) 0, (-0, 0) 0, (-0, -0) -0, (-1, -0) -0, NaN either way, (-Infinity, -1) -1.
    assert!(!neg(max(0.0, -0.0)) && !neg(max(-0.0, 0.0)) && neg(max(-0.0, -0.0)) && neg(max(-1.0, -0.0)));
    assert!(max(f64::NAN, 1.0).is_nan() && max(1.0, f64::NAN).is_nan());
    assert_eq!(max(f64::NEG_INFINITY, -1.0), -1.0);
    assert!(neg(min(0.0, -0.0)) && neg(min(-0.0, 0.0)) && min(1.0, f64::NAN).is_nan());
    assert_eq!(max_of([]), f64::NEG_INFINITY);
    assert_eq!(max_of([-1.0, 3.0, 2.0]), 3.0);
    // model.ts lastPlace: Math.max(-1, ...places).
    assert_eq!(max_of([-1.0].into_iter().chain([0.5, -3.0])), 0.5);
}

#[test]
fn comparator_signs() {
    assert_eq!(num_cmp(1.0, 2.0), Ordering::Less);
    assert_eq!(num_cmp(0.0, -0.0), Ordering::Equal);
    assert_eq!(num_cmp(f64::INFINITY, f64::INFINITY), Ordering::Equal); // NaN: on to the tie, as `||` does
    assert_eq!(num_cmp(f64::MAX, -f64::MAX), Ordering::Greater); // overflows to +∞: still the sign
}

#[test]
fn number_strings_as_js() {
    // JSC's String(n) (and JSON.stringify(n): the same for every finite number).
    for (n, want) in [
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (-1.0, "-1"),
        (0.1, "0.1"),
        (0.1 + 0.2, "0.30000000000000004"),
        (1.0 / 3.0, "0.3333333333333333"),
        (2.0 / 3.0, "0.6666666666666666"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (123456789012345680000.0, "123456789012345680000"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (1.5e-7, "1.5e-7"),
        (123e-20, "1.23e-18"),
        (9007199254740992.0, "9007199254740992"),
        (9007199254740994.0, "9007199254740994"),
        (9007199254740991.0, "9007199254740991"),
        (-9007199254740992.0, "-9007199254740992"),
        (5e-324, "5e-324"),
        (f64::MAX, "1.7976931348623157e+308"),
        (100.0, "100"),
        (1e300, "1e+300"),
        (0.0000012345, "0.0000012345"),
        (1234567.125, "1234567.125"),
        (4.35, "4.35"),
        (0.5, "0.5"),
        (-1e-7, "-1e-7"),
        (1e15, "1000000000000000"),
        (1e16, "10000000000000000"),
        (1e17, "100000000000000000"),
        (12345678901234567890.0, "12345678901234567000"),
        (25.0, "25"),
        (1777777777777.5, "1777777777777.5"),
        (1762000000000.0, "1762000000000"),
        (1.0000000000000002, "1.0000000000000002"),
        (999999999999999900000.0, "999999999999999900000"),
        (1e22, "1e+22"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
        (f64::NEG_INFINITY, "-Infinity"),
    ] {
        assert_eq!(number_string(n), want, "{n:e}");
    }
    // JSON.parse("9007199254740993") is …992 in JS: serde_json keeps it as a u64, read as a double it's the same.
    let v: Value = serde_json::from_str("9007199254740993").unwrap();
    assert_eq!(finite(Some(&v)), Some(9007199254740992.0));
}

#[test]
fn values_as_js_reads_them() {
    // JSC: String(JSON.parse(text)), and the key `o[JSON.parse(text)] = 1` makes (the same strings).
    for (text, want) in [
        ("null", "null"),
        ("true", "true"),
        ("false", "false"),
        ("0", "0"),
        ("-0", "0"),
        ("5", "5"),
        ("1.5", "1.5"),
        ("1e21", "1e+21"),
        ("\"x\"", "x"),
        ("\"\"", ""),
        ("[]", ""),
        ("[1,2]", "1,2"),
        ("[null,1]", ",1"),
        ("[[1,[2,3]],\"a\"]", "1,2,3,a"),
        ("[{}]", "[object Object]"),
        ("{}", "[object Object]"),
        ("{\"a\":1}", "[object Object]"),
        ("[true,false]", "true,false"),
        ("[1e21,0.1]", "1e+21,0.1"),
        ("[\"a,b\"]", "a,b"),
        ("[[]]", ""),
        ("[[null]]", ""),
    ] {
        let v: Value = serde_json::from_str(text).unwrap();
        assert_eq!(to_string(&v), want, "{text}");
        assert_eq!(property_key(Some(&v)), want, "{text}");
    }
    assert_eq!(property_key(None), "undefined");

    for (v, want) in [
        (json!(null), false),
        (json!(false), false),
        (json!(0), false),
        (json!(-0.0), false),
        (json!(""), false),
        (json!(true), true),
        (json!(1), true),
        (json!("0"), true),
        (json!(" "), true),
        (json!([]), true),
        (json!({}), true),
    ] {
        assert_eq!(truthy(Some(&v)), want, "{v}");
    }
    assert!(!truthy(None));
    assert!(nullish(None) && nullish(Some(&json!(null))) && !nullish(Some(&json!(0))) && !nullish(Some(&json!(""))));
    assert_eq!(finite(Some(&json!(5))), Some(5.0));
    assert_eq!(finite(Some(&json!("5"))), None);
    assert_eq!(finite(Some(&json!(null))), None);
    assert_eq!(finite(None), None);
}

#[test]
fn fingerprints_as_data_set_ts() {
    // JSC: shared/data-set.ts fingerprint(s) of each string.
    for (s, want) in [
        ("", "ffcaaa85"),
        ("a", "61a1cfea"),
        ("Personal", "f2ff6cbd"),
        ("Work Profile", "ba316665"),
        ("Personal\n", "0d23802f"),
        ("\"q\"", "dbe9a62a"),
        ("back\\slash", "7e58017f"),
        ("\u{8}\u{c}\n\r\t", "35db3815"),
        ("\0\u{1}\u{1f}\u{7f}", "f2f2b1c3"),
        ("\u{2028}\u{2029}", "594ddc88"),
        ("😀", "accb0e0e"),
        ("é", "507809f2"),
        ("tab\there", "5dbf4a88"),
        ("safari\nPersonal\nt-abc123", "74f8ebdc"),
        ("中文", "0a27a3bd"),
        ("/<>&'", "90c5f34f"),
        ("\u{80}\u{9f}\u{a0}", "940672c6"),
    ] {
        assert_eq!(fingerprint(s), want, "{s:?}");
    }
}

#[test]
fn address_shapes_as_the_regexes() {
    // JSC: /^(https?|file):/i, /^https?:/i, /^https?:\/\/[^\s/]/i.
    for (url, web, http, fav) in [
        ("https://a.com", true, true, true),
        ("HTTP://A.COM", true, true, true),
        ("Https:x", true, true, false),
        ("file:///a", true, false, false),
        ("FILE:/a", true, false, false),
        ("ftp://a", false, false, false),
        ("data:text/plain,a", false, false, false),
        ("http:", true, true, false),
        ("https://", true, true, false),
        ("https:// a", true, true, false),
        ("https:///a", true, true, false),
        ("https://\u{a0}a", true, true, false),
        ("https://\u{feff}a", true, true, false),
        ("https://\u{2028}a", true, true, false),
        ("https://a/b", true, true, true),
        ("httpss://a", false, false, false),
        (" https://a", false, false, false),
        ("h\u{17f}tp://a", false, false, false),
        ("http\u{212a}://a", false, false, false),
        ("margin://settings", false, false, false),
        ("app://com.apple.Notes", false, false, false),
        ("https://\u{85}a", true, true, true),
        ("https://\u{180e}a", true, true, true),
    ] {
        assert_eq!((is_web_page(url), is_http(url), favorite_url_ok(url)), (web, http, fav), "{url:?}");
    }
}

#[test]
fn lowercase_as_js() {
    // air-traffic.ts normalizePattern's toLowerCase (JSC's answers): Rust's to_lowercase gives the same.
    for (s, want) in [
        ("LINEAR.APP", "linear.app"),
        ("\u{212a}ELVIN.com", "kelvin.com"),
        ("\u{130}stanbul.com", "i\u{307}stanbul.com"),
        ("ΣΑΣ.com", "σασ.com"),
        ("STRASSE", "strasse"),
        ("\u{1e9e}", "ß"),
    ] {
        assert_eq!(s.to_lowercase(), want);
    }
}

#[test]
fn the_rules_have_no_url_today() {
    // JSC's bare context: `new URL` throws, so normalizeUrl gives the address back and no link rule matches.
    const { assert!(!RULES_PARSE_URLS) };
    assert_eq!(normalize_url("https://A.com/#x"), "https://A.com/#x");
    assert!(matches!(normalize_url("https://a.com/"), Cow::Borrowed(_)));
    assert_eq!(rules_url("https://github.com/x"), None);
}

#[test]
fn urls_as_whatwg() {
    for (url, want) in [
        ("https://a.com/", "https://a.com"),
        ("https://a.com", "https://a.com"),
        ("https://a.com/#x", "https://a.com"),
        ("https://A.COM/Path/?q=1#h", "https://a.com/Path/?q=1"),
        ("https://a.com:443/x", "https://a.com/x"),
        ("http://a.com:8080/", "http://a.com:8080"),
        ("https://a.com/b/../c", "https://a.com/c"),
        ("https://a.com\\b\\c", "https://a.com/b/c"),
        ("https://a.com/%7e", "https://a.com/%7e"),
        ("https://a.com/?", "https://a.com"),
        ("http://0x7f.1/", "http://127.0.0.1"),
        ("https://bücher.de/", "https://xn--bcher-kva.de"),
        ("file:///Users/a/b.html", "file:///Users/a/b.html"),
        ("  https://a.com/x  ", "https://a.com/x"),
        ("https://[::1]:8000/", "https://[::1]:8000"),
        ("not a url", "not a url"),
        ("", ""),
    ] {
        assert_eq!(normalize_url_whatwg(url), want, "{url:?}");
    }
    let u = url_parts("https://Sub.Example.com:8443/a/b?x#y").unwrap();
    assert_eq!(
        u,
        UrlParts {
            protocol: "https:".into(),
            host: "sub.example.com:8443".into(),
            hostname: "sub.example.com".into(),
            pathname: "/a/b".into(),
            search: "?x".into()
        }
    );
    assert_eq!(url_parts("mailto:x@y").map(|u| (u.host, u.pathname)), Some(("".into(), "x@y".into())));
    assert_eq!(url_parts("http://"), None);
}

#[test]
fn ids_given_first_then_random() {
    let mut ids = Ids::new(["abcd".to_string(), "no!".into(), "ABCdef0123".into()]);
    assert_eq!(ids.other("sp"), "sp-abcd");
    let random = ids.tab(); // "no!" doesn't pass: used up, random letters instead
    assert!(
        random.len() == 12
            && random.starts_with("t-")
            && random[2..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    );
    assert_eq!(ids.tab(), "t-ABCdef0123");
    assert_eq!(ids.letters().len(), 10);
    let mut from_json =
        Ids::from_values(&[json!(5), json!("abcd1"), json!("abc"), json!("a".repeat(30)), json!("a".repeat(31))]);
    assert_eq!(from_json.letters().len(), 10);
    assert_eq!(from_json.letters(), "abcd1");
    assert_ne!(from_json.letters(), "abc");
    assert_eq!(from_json.letters(), "a".repeat(30));
    assert_ne!(from_json.letters(), "a".repeat(31));
    assert_ne!(random_letters(10), random_letters(10));
}
