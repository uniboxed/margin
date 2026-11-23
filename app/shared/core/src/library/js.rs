//! The JavaScript semantics the library's rules rely on (docs/CORE-REFACTOR.md step 4 part 1), as JavaScriptCore runs
//! them in Margin.app today (a bare `JSContext`, app/platforms/macos/shell/LibraryRules.swift): what app/shared/library/
//! library.ts and extension/state/model.ts get from the engine without saying so. Each function names the JS it stands
//! for. Every edge below was run through JSC on the Mac (macOS 27.2, `en-US`) and through Node 25 (ICU 79.1) on
//! 2026-11-23; where the two differ, this follows JSC.
//!
//! - Strings are UTF-16 in JS: `.length` and `.slice` count units ([`len16`], [`slice16`]), `.sort()` with no
//!   comparator orders units ([`cmp16`]), `trim` and `/\s/` know one list of spaces ([`is_space`]).
//! - `localeCompare` is ICU's collation for the engine's default locale ([`Collation`]).
//! - Numbers are doubles: [`round`] (`Math.round`), [`max`]/[`min`], [`number_string`] (`String(n)`), [`num_cmp`] (a
//!   comparator's `x - y`).
//! - A payload's values as JS reads them: [`truthy`], [`nullish`], [`finite`], [`to_string`] (`String(x)`),
//!   [`property_key`] (`obj[x]`).
//! - `new URL`: **a bare JSContext has none** (`URL` is WebCore's, not JavaScriptCore's): `new URL(…)` throws a
//!   ReferenceError, which model.ts's `normalizeUrl` and air-traffic.ts's `patternMatchesUrl` catch. So in Margin.app
//!   today an address is matched as given (no fragment or trailing slash dropped) and a link rule never matches.
//!   [`RULES_PARSE_URLS`] keeps that; [`url_parts`] and [`normalize_url_whatwg`] are the browsers' (WHATWG, the `url`
//!   crate) for when Tirth decides the app's rules should parse addresses too.
//! - The import's ids hash ([`fingerprint`]) and the ids an action makes ([`Ids`]).

use std::borrow::Cow;
use std::cmp::Ordering;

use icu_collator::{CollatorBorrowed, CollatorPreferences, options::CollatorOptions};
use serde_json::Value;

// ---- strings: UTF-16 --------------------------------------------------------------------------------------------

/// `s.length`: UTF-16 units.
#[inline]
pub fn len16(s: &str) -> usize {
    if s.is_ascii() { s.len() } else { s.chars().map(char::len_utf16).sum() }
}

/// `s.slice(0, max)`, cut at a character: a surrogate pair the cut goes through is dropped whole (Tirth, 2026-11-23:
/// JS keeps its first half, which no Rust string can hold, nor JSONSerialization write). The input itself when it's
/// short enough (no copy: a prefix of it either way).
#[inline]
pub fn slice16(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s; // UTF-8 bytes are never fewer than UTF-16 units
    }
    if s.is_ascii() {
        return &s[..max];
    }
    let mut units = 0;
    for (at, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..at];
        }
    }
    s
}

/// `.sort()` with no comparator: UTF-16 units in order. Rust's `str` order is code points, which differs only between
/// U+E000–U+FFFF and the supplementary planes (a surrogate, D800–DFFF, sorts below E000).
#[inline]
pub fn cmp16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// JS's white space and line terminators, the one list `trim()` and the regexes' `\s` use (ECMAScript's WhiteSpace and
/// LineTerminator: U+FEFF is one, U+0085 and U+180E aren't; Rust's `char::is_whitespace` is the other way round for
/// all three). The same in JSC and V8, every code point checked.
#[inline]
pub fn is_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `s.trim()`.
#[inline]
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s.replace(/\s+/g, ' ')`: each run of spaces one space (the input itself when there's nothing to change).
pub fn squash_spaces(s: &str) -> Cow<'_, str> {
    let mut chars = s.chars().peekable();
    let mut clean = true;
    while let Some(c) = chars.next() {
        if is_space(c) && (c != ' ' || chars.peek().is_some_and(|&n| is_space(n))) {
            clean = false;
            break;
        }
    }
    if clean {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if is_space(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    Cow::Owned(out)
}

/// `/^(https?|file):/i`: an address a browser shows (model.ts `isWebPage`, the import's web pages).
#[inline]
pub fn is_web_page(url: &str) -> bool {
    starts_with_ignore_case(url, "http:")
        || starts_with_ignore_case(url, "https:")
        || starts_with_ignore_case(url, "file:")
}

/// `/^https?:/i`: an address the archive keeps.
#[inline]
pub fn is_http(url: &str) -> bool {
    starts_with_ignore_case(url, "http:") || starts_with_ignore_case(url, "https:")
}

/// `/^https?:\/\/[^\s/]/i` (model.ts `favoriteUrlOk`): an http address with a host's first character.
pub fn favorite_url_ok(url: &str) -> bool {
    let rest = if starts_with_ignore_case(url, "http://") {
        &url[7..]
    } else if starts_with_ignore_case(url, "https://") {
        &url[8..]
    } else {
        return false;
    };
    rest.chars().next().is_some_and(|c| c != '/' && !is_space(c))
}

/// A regex's `/i` on an ASCII pattern: without the `u` flag JS folds case only where both sides stay ASCII or both
/// don't (`ſ` isn't `s`, `K` (Kelvin) isn't `k`), so this is ASCII's.
#[inline]
fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

// ---- localeCompare ----------------------------------------------------------------------------------------------

/// `a.localeCompare(b)`: ICU's collation for a locale, as JavaScriptCore runs it (`Intl.Collator` with its defaults:
/// usage sort, sensitivity variant (tertiary), punctuation not ignored, no numeric ordering, the locale's case order).
/// JSC takes the locale from the person's preferred languages (`en-US` on Tirth's Mac); a tailored locale changes even
/// ASCII's order (Danish `aa`, Lithuanian `y`, Czech `ch`), so the caller gives the one the app runs in.
///
/// Root (and `en`) on ASCII is not byte order: `_` < `-` < `,` < `;` < `:` < `!` … < digits < letters, and `a` < `A` <
/// `b`. JSC and Node agree on every pair of printable ASCII characters and on Margin's ids; they differ on a few
/// non-ASCII characters, whose CLDR versions differ (Node 25's is newer).
pub struct Collation {
    collator: CollatorBorrowed<'static>,
}

impl Collation {
    /// The collation for a BCP 47 locale (`en-US`, `da`, `sv-SE`…); an empty or malformed tag is root's (`und`).
    pub fn new(locale: &str) -> Collation {
        let prefs =
            icu_locale_core::Locale::try_from_str(locale).map(|l| CollatorPreferences::from(&l)).unwrap_or_default();
        let collator = CollatorBorrowed::try_new(prefs, CollatorOptions::default())
            .or_else(|_| CollatorBorrowed::try_new(CollatorPreferences::default(), CollatorOptions::default()))
            .expect("the compiled root collation");
        Collation { collator }
    }

    /// `a.localeCompare(b)`'s sign. `Equal` also for strings that differ only in what collation ignores (`"a\0"` and
    /// `"a"`), as JS answers 0 for them.
    #[inline]
    pub fn compare(&self, a: &str, b: &str) -> Ordering {
        if a == b {
            return Ordering::Equal;
        }
        self.collator.compare(a, b)
    }
}

impl Default for Collation {
    /// Tirth's Mac's (`en-US`).
    fn default() -> Collation {
        Collation::new("en-US")
    }
}

/// `a.localeCompare(b)` with a collation.
#[inline]
pub fn locale_compare(collation: &Collation, a: &str, b: &str) -> Ordering {
    collation.compare(a, b)
}

// ---- numbers ----------------------------------------------------------------------------------------------------

/// `Math.round`: the nearest integer, a half toward +∞ (Rust's `round` goes away from zero), -0 kept for (-0.5, -0]:
/// `round(-0.5)` is -0, `round(0.49999999999999994)` is 0.
#[inline]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() || x.fract() == 0.0 {
        return x;
    }
    let floor = x.floor();
    let r = if x - floor >= 0.5 { floor + 1.0 } else { floor }; // exact: |x| < 2^52 here
    if r == 0.0 && x < 0.0 { -0.0 } else { r }
}

/// `Math.max(a, b)`: NaN if either is (Rust's `f64::max` takes the other), +0 over -0.
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is, -0 under +0.
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(...xs)`: -∞ for none.
pub fn max_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::NEG_INFINITY, max)
}

/// A comparator's `x - y` as `sort` reads it: its sign, and NaN (`∞ - ∞`) as 0, so `x - y || tie` goes on to the tie
/// as JS does. A total order over finite numbers (the library's are: `finite()` first), so Rust's sort can't panic.
#[inline]
pub fn num_cmp(x: f64, y: f64) -> Ordering {
    let d = x - y;
    if d > 0.0 {
        Ordering::Greater
    } else if d < 0.0 {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

/// `String(n)` (ECMAScript's Number::toString): the shortest digits that read back as `n`, as an integer up to 21
/// digits, `0.000001` down to 1e-6 and an exponent past those (`1e+21`, `1.5e-7`); `-0` is `"0"`.
pub fn number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n.fract() == 0.0 && n.abs() < 1e18 {
        return (n as i64).to_string(); // the common case (times, places, ids): exact as an integer
    }
    let sci = format!("{:e}", n.abs()); // the shortest round-trip digits: "1.2345e-7"
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n10 = exp.parse::<i32>().unwrap_or(0) + 1; // the value is 0.<digits> × 10^n10
    let mut out = String::with_capacity(k as usize + 8);
    if n < 0.0 {
        out.push('-');
    }
    if k <= n10 && n10 <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n10 - k) as usize));
    } else if 0 < n10 && n10 <= 21 {
        out.push_str(&digits[..n10 as usize]);
        out.push('.');
        out.push_str(&digits[n10 as usize..]);
    } else if -6 < n10 && n10 <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n10) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n10 >= 1 { '+' } else { '-' });
        out.push_str(&(n10 - 1).abs().to_string());
    }
    out
}

// ---- a payload's values as JS reads them ----------------------------------------------------------------------------

/// `!!v`: false for missing (undefined), null, false, 0, -0, NaN and "".
#[inline]
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `v == null` (what `??` and `?.` test): missing or null.
#[inline]
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `Number.isFinite(v) ? v : None`: a JSON number only (`"5"` isn't finite to it). A number JSON reads as a double, as
/// `JSON.parse` does: `9007199254740993` is `…992`.
#[inline]
pub fn finite(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|n| n.is_finite())
}

/// `String(v)` (ECMAScript's ToString) for a JSON value: `null`, `true`, a number's [`number_string`], the string
/// itself, an array's elements joined by `,` (null as nothing, nested arrays flattened: `[[1,[2]],null]` is `"1,2,"`),
/// an object `[object Object]`.
pub fn to_string(v: &Value) -> Cow<'_, str> {
    match v {
        Value::Null => Cow::Borrowed("null"),
        Value::Bool(true) => Cow::Borrowed("true"),
        Value::Bool(false) => Cow::Borrowed("false"),
        Value::Number(n) => Cow::Owned(number_string(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => Cow::Borrowed(s),
        Value::Object(_) => Cow::Borrowed("[object Object]"),
        Value::Array(list) => {
            let mut out = String::new();
            for (i, x) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !x.is_null() {
                    out.push_str(&to_string(x));
                }
            }
            Cow::Owned(out)
        }
    }
}

/// `obj[v]`'s key (ToPropertyKey): `String(v)`, and `"undefined"` for a missing value (`s.keptTabs[p?.tabId]` with no
/// `tabId` looks up `"undefined"`). The prototype's members (`"constructor"`, `"toString"`…) find a function in JS and
/// nothing here: open question 4, Rust's ("no such item").
pub fn property_key(v: Option<&Value>) -> Cow<'_, str> {
    match v {
        None => Cow::Borrowed("undefined"),
        Some(v) => to_string(v),
    }
}

// ---- addresses: `new URL` -------------------------------------------------------------------------------------------

/// Whether the library's rules parse addresses (`new URL`). JSC's bare context has no `URL`, so today they don't: model.ts's
/// `normalizeUrl` gives the address as it is and air-traffic.ts's `patternMatchesUrl` is false for every address (a
/// link rule never routes in Margin.app; measured 2026-11-23 with dist/app/library.js in a `JSContext`: `routeUrl` of a
/// matching address answers null, `addFavorite` of `https://a.com` beside `https://a.com/` adds a second). Changing it
/// changes behaviour (the link rules start working, addresses match as the browsers' copies match them): Tirth's call.
pub const RULES_PARSE_URLS: bool = false;

/// What `new URL(s)` gives the rules: a WHATWG URL's parts, or `None` where JS throws (never, today: [`RULES_PARSE_URLS`]).
#[inline]
pub fn rules_url(s: &str) -> Option<UrlParts> {
    if RULES_PARSE_URLS { url_parts(s) } else { None }
}

/// model.ts `normalizeUrl` (M:594) as the library runs it: [`normalize_url_whatwg`] where the rules parse addresses,
/// else the address as given (JSC today: `new URL` throws, `url ?? ''`).
#[inline]
pub fn normalize_url(url: &str) -> Cow<'_, str> {
    if RULES_PARSE_URLS { normalize_url_whatwg(url) } else { Cow::Borrowed(url) }
}

/// A URL's parts as JS's `URL` getters give them (`protocol` with its colon, `host` with a port that isn't the scheme's
/// default, `hostname`, `pathname`, `search` with its `?`, empty for an empty query).
#[derive(Clone, Debug, PartialEq)]
pub struct UrlParts {
    pub protocol: String,
    pub host: String,
    pub hostname: String,
    pub pathname: String,
    pub search: String,
}

/// `new URL(s)` (WHATWG, IDNA UTS 46, as Safari and Chrome parse addresses), or `None` where it throws.
pub fn url_parts(s: &str) -> Option<UrlParts> {
    let u = url::Url::parse(s).ok()?;
    Some(UrlParts {
        protocol: url::quirks::protocol(&u).to_owned(),
        host: url::quirks::host(&u).to_owned(),
        hostname: url::quirks::hostname(&u).to_owned(),
        pathname: url::quirks::pathname(&u).to_owned(),
        search: url::quirks::search(&u).to_owned(),
    })
}

/// model.ts `normalizeUrl` (M:594) as a browser runs it: `protocol + "//" + host + path ("/" dropped) + search` (the
/// fragment dropped), or the address as given where it doesn't parse.
pub fn normalize_url_whatwg(url: &str) -> Cow<'_, str> {
    match url_parts(url) {
        Some(u) => {
            let path = if u.pathname == "/" { "" } else { &u.pathname };
            Cow::Owned(format!("{}//{}{}{}", u.protocol, u.host, path, u.search))
        }
        None => Cow::Borrowed(url),
    }
}

// ---- the import's ids: fingerprint ----------------------------------------------------------------------------------

/// shared/data-set.ts `fingerprint(s)` of a string (DS:105): FNV-1a over `JSON.stringify(s)`'s UTF-16 units, as 8 hex
/// digits. JSON.stringify's escapes: `\"`, `\\`, `\b \f \n \r \t`, other controls below U+0020 as `\u00xx` (lowercase),
/// everything else as it is (DEL, U+2028/2029 and every non-ASCII character too). The import's ids are made with it
/// (library.ts `nsId`, `nsTabId`), so it must be the same, or an import run again doubles what it brought.
pub fn fingerprint(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut h: u32 = 0x811c_9dc5;
    let mut feed = |unit: u16| {
        h ^= u32::from(unit);
        h = h.wrapping_mul(0x0100_0193);
    };
    feed(u16::from(b'"'));
    for c in s.chars() {
        let escaped: Option<&[u8]> = match c {
            '"' => Some(b"\\\""),
            '\\' => Some(b"\\\\"),
            '\u{8}' => Some(b"\\b"),
            '\u{c}' => Some(b"\\f"),
            '\n' => Some(b"\\n"),
            '\r' => Some(b"\\r"),
            '\t' => Some(b"\\t"),
            _ => None,
        };
        if let Some(e) = escaped {
            e.iter().for_each(|&b| feed(u16::from(b)));
        } else if (c as u32) < 0x20 {
            let n = c as usize;
            [b'\\', b'u', b'0', b'0', HEX[n >> 4], HEX[n & 15]].iter().for_each(|&b| feed(u16::from(b)));
        } else {
            let mut buf = [0u16; 2];
            c.encode_utf16(&mut buf).iter().for_each(|&u| feed(u));
        }
    }
    feed(u16::from(b'"'));
    format!("{h:08x}")
}

// ---- the ids an action makes ----------------------------------------------------------------------------------------

const LETTERS: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// library.ts `idMaker` (LT:177): the ids given first (Swift gives 4 random ones per action, a test its own), each used
/// once and only when it's 4–30 ASCII letters and digits (one that isn't is used up all the same, as `given.shift()`
/// does), then 10 random letters and digits of the core's own (open question 6: `getrandom`, Swift's `randomLetters`
/// rule, a byte mod 36; LT's was `Math.random`).
pub struct Ids {
    given: std::vec::IntoIter<Option<String>>,
}

impl Ids {
    pub fn new(given: impl IntoIterator<Item = String>) -> Ids {
        Ids { given: given.into_iter().map(Some).collect::<Vec<_>>().into_iter() }
    }

    /// From an env's JSON list: a value that isn't a string is used up as one that doesn't pass.
    pub fn from_values(given: &[Value]) -> Ids {
        Ids { given: given.iter().map(|v| v.as_str().map(str::to_owned)).collect::<Vec<_>>().into_iter() }
    }

    /// The next letters: a given id that passes, else random ones.
    pub fn letters(&mut self) -> String {
        match self.given.next() {
            Some(Some(id)) if (4..=30).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric()) => id,
            _ => random_letters(10),
        }
    }

    /// An item's id: `t-` and letters.
    pub fn tab(&mut self) -> String {
        format!("t-{}", self.letters())
    }

    /// Any other id: `<prefix>-` and letters (`sp`, `p`, `f`, `fav`, `atc`, `spv`, `a`).
    pub fn other(&mut self, prefix: &str) -> String {
        format!("{prefix}-{}", self.letters())
    }
}

/// `count` random lowercase letters and digits (Library.swift `randomLetters`: a random byte mod 36). Never fails: with
/// no randomness from the OS (it doesn't happen on the Mac or Windows) a counter's mix stands in, so ids still differ.
pub fn random_letters(count: usize) -> String {
    let mut bytes = vec![0u8; count];
    if getrandom::fill(&mut bytes).is_err() {
        use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
        static NEXT: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);
        for b in &mut bytes {
            let mut z = NEXT.fetch_add(0x9e37_79b9_7f4a_7c15, Relaxed);
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            *b = (z ^ (z >> 31)) as u8;
        }
    }
    bytes.iter().map(|&b| LETTERS[usize::from(b) % LETTERS.len()] as char).collect()
}

#[cfg(test)]
#[path = "js_tests.rs"]
mod tests;
