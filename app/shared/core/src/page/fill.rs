//! The ground's colour (MarginWindow.swift's `PageFill`, docs/CORE-REFACTOR.md step 3 part 11): the colours the page
//! says it draws around the page card's corners (host-app.ts cornerFill, reported with the layout as `fills`, CSS
//! colours as WebKit computes them), and the one most of them have (the theme's frame), the ground under the page area.
//!
//! Read as the Swift read them, to the bit: Foundation's trim of `.whitespaces` (Unicode's Zs and the tab, by scalar),
//! Swift's `lowercased()` (each scalar's own lowercase mapping, no context), its `hasPrefix`, `hasSuffix`, `split` and
//! `dropLast` by whole characters (a combining mark after a character, or a prepended one before it, makes another
//! character: session/unicode.rs's tables), and `Double(_:)`'s parse (strtod in the C locale, the whole text, no
//! leading space: decimals, hexadecimal floats, `inf`, `infinity`, `nan` and `nan(…)`).

use crate::session::unicode::{GRAPHEME_EXTEND, PREPEND, has};

/// A colour in sRGB, each component in 0…1 (`NSColor(srgbRed:green:blue:alpha:)`'s arguments, as the Swift made them).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

/// `PageFill.common`: the colour most of the corners have (the theme's frame; a sharp shadow at one corner aside), the
/// first on a tie; None for none. Two colours are the same as NSColor's `==` has it: each component as a 32-bit float.
pub fn common(colors: &[Rgba]) -> Option<Rgba> {
    let same = |a: &Rgba, b: &Rgba| {
        a.r as f32 == b.r as f32 && a.g as f32 == b.g as f32 && a.b as f32 == b.b as f32 && a.a as f32 == b.a as f32
    };
    let count = |c: &Rgba| colors.iter().filter(|o| same(o, c)).count();
    let mut best: Option<(usize, usize)> = None; // (count, index): the first index of the highest count
    for (i, c) in colors.iter().enumerate() {
        let n = count(c);
        if best.is_none_or(|(top, _)| n > top) {
            best = Some((n, i));
        }
    }
    best.map(|(_, i)| colors[i])
}

/// The ground under the page area from the page's four corner colours (`fills`, as the layout has them: four or
/// none): the colour most of the ones read have.
pub fn ground(fills: &[String]) -> Option<Rgba> {
    let mut read = [Rgba::default(); 4];
    let mut n = 0;
    for f in fills.iter().take(4) {
        if let Some(c) = color(f) {
            read[n] = c;
            n += 1;
        }
    }
    common(&read[..n])
}

/// `PageFill.color`: a CSS colour as the page computes it ("rgb(r, g, b)", "rgba(r, g, b, a)", or "color(srgb r g b /
/// a)"); None: none read (or see-through).
pub fn color(css: &str) -> Option<Rgba> {
    let s = lowercased(trimmed(css));
    let s = s.as_str();
    let rgba: [f64; 4] = if (starts(s, "rgb(") || starts(s, "rgba(")) && ends(s, ")") {
        // (`firstIndex(of: "(")`: the first "(" that's a character of its own; the prefix's, as it passed.)
        let open = s.find('(')?;
        let n = numbers(&s[open + 1..s.len() - 1]);
        if n.len() < 3 {
            return None;
        }
        [n[0] / 255.0, n[1] / 255.0, n[2] / 255.0, if n.len() > 3 { n[3] } else { 1.0 }]
    } else if starts(s, "color(srgb ") && ends(s, ")") {
        let inner = &s["color(srgb ".len()..s.len() - 1];
        let n = numbers(inner);
        if n.len() < 3 {
            return None;
        }
        [n[0], n[1], n[2], if n.len() > 3 { n[3] } else { 1.0 }]
    } else {
        return None;
    };
    if !rgba.iter().all(|v| v.is_finite()) || rgba[3] <= 0.0 {
        return None;
    }
    // (Swift's `min(1, max(0, v))`: `max` keeps a -0, `min` keeps v unless 1 is less.)
    let clamp = |v: f64| {
        let v = if v >= 0.0 { v } else { 0.0 };
        if 1.0 < v { 1.0 } else { v }
    };
    Some(Rgba { r: clamp(rgba[0]), g: clamp(rgba[1]), b: clamp(rgba[2]), a: clamp(rgba[3]) })
}

// Foundation's `.whitespaces`: Unicode's Zs, and the tab.
fn white(c: char) -> bool {
    matches!(c, '\t' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}

fn trimmed(s: &str) -> &str {
    s.trim_matches(white)
}

// Swift's `lowercased()`: each scalar's own full lowercase mapping (no final sigma's context, as Rust's str has).
fn lowercased(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    s.chars().flat_map(char::to_lowercase).collect()
}

// `hasPrefix` of an ASCII prefix, by characters: the scalar after it mustn't join its last character.
fn starts(s: &str, prefix: &str) -> bool {
    s.starts_with(prefix) && !s[prefix.len()..].chars().next().is_some_and(|c| has(GRAPHEME_EXTEND, c))
}

// `hasSuffix` of an ASCII suffix, by characters: the scalar before it mustn't be one prepended to its first.
fn ends(s: &str, suffix: &str) -> bool {
    s.ends_with(suffix) && !s[..s.len() - suffix.len()].chars().next_back().is_some_and(|c| has(PREPEND, c))
}

// Whether the ASCII byte at `at` in `s` is a character of its own (neither joined to the scalar before it nor to the
// one after it).
fn alone(s: &str, at: usize) -> bool {
    !s[..at].chars().next_back().is_some_and(|c| has(PREPEND, c))
        && !s[at + 1..].chars().next().is_some_and(|c| has(GRAPHEME_EXTEND, c))
}

// `inner.split(whereSeparator: { ", /".contains($0) })` (empty parts dropped), each part a number: "50%" a half.
fn numbers(inner: &str) -> NumberList {
    let mut out = NumberList::default();
    let mut start = 0;
    let bytes = inner.as_bytes();
    let part = |p: &str, out: &mut NumberList| {
        if p.is_empty() {
            return;
        }
        let v = if ends(p, "%") { double(&p[..p.len() - 1]).map(|v| v / 100.0) } else { double(p) };
        if let Some(v) = v {
            out.push(v);
        }
    };
    for (i, &b) in bytes.iter().enumerate() {
        if matches!(b, b',' | b' ' | b'/') && alone(inner, i) {
            part(&inner[start..i], &mut out);
            start = i + 1;
        }
    }
    part(&inner[start..], &mut out);
    out
}

/// A colour's numbers: the first four kept (only those are read), and how many there were.
#[derive(Default)]
struct NumberList {
    v: [f64; 4],
    n: usize,
}

impl NumberList {
    fn push(&mut self, v: f64) {
        if self.n < 4 {
            self.v[self.n] = v;
        }
        self.n += 1;
    }
    fn len(&self) -> usize {
        self.n
    }
}

impl std::ops::Index<usize> for NumberList {
    type Output = f64;
    fn index(&self, i: usize) -> &f64 {
        &self.v[i]
    }
}

/// Swift's `Double(_:)` of a text: not empty, not starting with a space, no NUL in it, read whole by Swift's runtime's
/// strtod in the C locale.
pub fn double(s: &str) -> Option<f64> {
    if s.contains('\0') {
        return None;
    }
    let first = *s.as_bytes().first()?;
    if matches!(first, 9..=13 | 32) {
        return None;
    }
    strtod(s)
}

// Swift's runtime's strtod (strtod_l in the C locale, and its own NaNs) of the whole text, as this Mac's Swift reads it
// (probed, 2026-11-23): a sign, then `inf` or `infinity`, `nan` or `snan` (any case) with an optional payload in
// parentheses (none, `0x` and hex digits, `0` and octal ones, or a decimal number), a hexadecimal float (`0x`, hex
// digits with a point, `p` and a decimal exponent) or a decimal one.
fn strtod(s: &str) -> Option<f64> {
    let (negative, body) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let sign = |v: f64| if negative { -v } else { v };
    let lower = body.to_ascii_lowercase();
    if lower == "inf" || lower == "infinity" {
        return Some(sign(f64::INFINITY));
    }
    for name in ["nan", "snan"] {
        if lower == name {
            return Some(sign(f64::NAN));
        }
        if lower.starts_with(name) && lower.as_bytes().get(name.len()) == Some(&b'(') {
            // (The payload as written: its `0x` lowercase only.)
            let inner = body[name.len() + 1..].strip_suffix(')')?;
            let ok = match inner.as_bytes() {
                [] => true,
                [b'0', b'x', rest @ ..] => rest.iter().all(u8::is_ascii_hexdigit),
                [b'0', rest @ ..] => rest.iter().all(|b| (b'0'..=b'7').contains(b)),
                digits => digits.iter().all(u8::is_ascii_digit),
            };
            return ok.then(|| sign(f64::NAN));
        }
    }
    if let Some(rest) = lower.strip_prefix("0x") {
        return hex(rest).map(sign);
    }
    // A decimal: digits with at most one point (at least one digit), then an optional exponent with digits.
    let b = body.as_bytes();
    let mut i = 0;
    let mut digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let from = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == from {
            return None; // ("1e" is read as 1 with "e" left over: not whole)
        }
        i = j;
    }
    if i != b.len() {
        return None;
    }
    // (Rust's parse is correctly rounded, as Darwin's strtod is; it takes these forms as they are.)
    body.parse::<f64>().ok().map(sign)
}

// A hexadecimal float's digits (after `0x`), lowercase: hex digits with at most one point (at least one digit), an
// optional `p` exponent with decimal digits; correctly rounded (to nearest, ties to even), subnormals and overflow as
// strtod gives them.
fn hex(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut mantissa: u64 = 0; // the first 15 significant hex digits (60 bits)
    let mut sticky = false; // any non-zero digit past those
    let mut exp: i64 = 0; // the binary exponent of the mantissa's last bit
    let mut digits = 0;
    let mut significant = 0;
    let mut point = false;
    while i < b.len() {
        let c = b[i];
        let v = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'.' if !point => {
                point = true;
                i += 1;
                continue;
            }
            _ => break,
        };
        digits += 1;
        if significant < 15 {
            if mantissa != 0 || v != 0 {
                significant += 1;
            }
            mantissa = (mantissa << 4) | u64::from(v);
            if point {
                exp -= 4;
            }
        } else {
            sticky |= v != 0;
            if !point {
                exp += 4;
            }
        }
        i += 1;
    }
    if digits == 0 {
        return None;
    }
    if i < b.len() && b[i] == b'p' {
        let mut j = i + 1;
        let mut negative = false;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            negative = b[j] == b'-';
            j += 1;
        }
        let from = j;
        let mut e: i64 = 0;
        while j < b.len() && b[j].is_ascii_digit() {
            e = (e * 10 + i64::from(b[j] - b'0')).min(1 << 40);
            j += 1;
        }
        if j == from {
            return None;
        }
        exp += if negative { -e } else { e };
        i = j;
    }
    if i != b.len() {
        return None;
    }
    Some(compose(mantissa, sticky, exp))
}

// mantissa × 2^exp (and a little more when `sticky`), rounded to the nearest double, ties to even.
fn compose(mantissa: u64, sticky: bool, exp: i64) -> f64 {
    if mantissa == 0 {
        return 0.0;
    }
    let lead = 63 - i64::from(mantissa.leading_zeros()); // the top bit's place in the mantissa
    let top = lead + exp; // the value's binary exponent
    if top > 1023 {
        return f64::INFINITY;
    }
    // The bits kept: 53 for a normal number, fewer for a subnormal (its last bit 2^-1074).
    let last = (top - 52).max(-1074); // the exponent of the kept value's last bit
    let shift = last - exp; // the mantissa's bits below that
    let (mut kept, round, rest) = if shift <= 0 {
        (u128::from(mantissa) << (-shift).min(64), false, sticky)
    } else if shift > 64 {
        (0, false, true)
    } else {
        let m = u128::from(mantissa);
        let kept = m >> shift;
        let round = (m >> (shift - 1)) & 1 == 1;
        let rest = m & ((1u128 << (shift - 1)) - 1) != 0 || sticky;
        (kept, round, rest)
    };
    if round && (rest || kept & 1 == 1) {
        kept += 1;
    }
    // kept × 2^last, exactly (kept fits 54 bits).
    let v = kept as f64;
    let mut out = v;
    let mut e = last;
    // (Scaled in steps a double can hold: never through an overflow or an underflow on the way.)
    while e > 0 {
        let step = e.min(1000);
        out *= 2f64.powi(step as i32);
        e -= step;
    }
    while e < 0 {
        let step = (-e).min(1000);
        out /= 2f64.powi(step as i32);
        e += step;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(r: f64, g: f64, b: f64, a: f64) -> Option<Rgba> {
        Some(Rgba { r, g, b, a })
    }

    #[test]
    fn the_colours_webkit_computes() {
        // (margin-window-tests.swift's: the frame's grey, a gutter, ink, a half alpha, a color(srgb) one.)
        assert_eq!(color("rgb(156, 157, 161)"), rgb(156.0 / 255.0, 157.0 / 255.0, 161.0 / 255.0, 1.0));
        assert_eq!(color("rgba(0, 0, 0, 0.5)").map(|c| c.a), Some(0.5));
        assert!(color("color(srgb 0.801961 0.768627 0.939216)").is_some());
        assert_eq!(color("color(srgb 0.5 0.25 1 / 0.5)"), rgb(0.5, 0.25, 1.0, 0.5));
        assert_eq!(color("rgba(0, 0, 0, 0)"), None, "see-through: none");
        assert_eq!(color("red"), None);
        assert_eq!(color(""), None);
        assert_eq!(color("  RGB(255, 0, 0)\t"), rgb(1.0, 0.0, 0.0, 1.0), "trimmed and lowercased");
        assert_eq!(color("rgb(300, -5, 50%)"), rgb(1.0, 0.0, 0.5 / 255.0, 1.0), "clamped; a percentage a fraction");
        assert_eq!(color("rgb(1, 2)"), None);
        assert_eq!(
            color("rgb(1, x, 2, 3)"),
            rgb(1.0 / 255.0, 2.0 / 255.0, 3.0 / 255.0, 1.0),
            "what isn't a number dropped"
        );
        assert_eq!(color("rgb(nan, 1, 2)"), None, "not finite");
        assert_eq!(color("rgb(0x10, 0, 0)"), rgb(16.0 / 255.0, 0.0, 0.0, 1.0), "strtod's hexadecimal");
        assert_eq!(color("rgb(1,2,3)\u{301}"), None, "a combining mark makes another last character");
        assert_eq!(color("rgb(\u{301}1,2,3)"), None, "...and another \"(\"");
        assert_eq!(color("rgb(1,\u{301}2,3,4)").map(|c| c.a), None, "a separator joined: one part, not a number");
    }

    #[test]
    fn the_most_common_first_on_a_tie() {
        let (a, b, c) = (Rgba { r: 1.0, ..Rgba::default() }, Rgba { g: 1.0, ..Rgba::default() }, Rgba::default());
        assert_eq!(common(&[a, a, b, a]), Some(a));
        assert_eq!(common(&[b, a]), Some(b));
        assert_eq!(common(&[b, c, c, b]), Some(b));
        assert_eq!(common(&[]), None);
        let near = Rgba { r: 0.1, ..Rgba::default() };
        let as_float = Rgba { r: f64::from(0.1f32), ..Rgba::default() };
        assert_eq!(common(&[b, near, as_float]), Some(near), "the same to NSColor (its components as floats): two");
    }

    #[test]
    fn swift_doubles() {
        assert_eq!(double("1.5"), Some(1.5));
        assert_eq!(double(" 1"), None);
        assert_eq!(double(""), None);
        assert_eq!(double("1e"), None);
        assert_eq!(double("1e5"), Some(1e5));
        assert_eq!(double(".5"), Some(0.5));
        assert_eq!(double("5."), Some(5.0));
        assert_eq!(double("."), None);
        assert_eq!(double("0x1p3"), Some(8.0));
        assert_eq!(double("0x.8"), Some(0.5));
        assert_eq!(double("0x"), None);
        assert_eq!(double("-0x1.8p1"), Some(-3.0));
        assert!(
            ["nan()", "nan(0)", "nan(012)", "nan(12)", "nan(0x1F)", "nan(0x)", "snan", "-snan(1)", "NaN(1)"]
                .iter()
                .all(|t| double(t).is_some_and(f64::is_nan))
        );
        assert!(
            ["nan(1f)", "nan(0X1F)", "nan(abc_1)", "nan(09)", "nan( 1)", "nan(", "nan(1)x", "qnan", "nan(-1)"]
                .iter()
                .all(|t| double(t).is_none())
        );
        assert_eq!(double("-inf"), Some(f64::NEG_INFINITY));
        assert_eq!(double("1\0"), None, "a NUL in it: not read whole");
        assert_eq!(double("0x1p-1074"), Some(f64::from_bits(1)));
        assert_eq!(double("0x1p-1075"), Some(0.0), "half the least subnormal, a tie: to even");
        assert_eq!(double("0x1.8p-1074"), Some(f64::from_bits(2)), "1.5 of it: to even");
        assert_eq!(double("0x1p1024"), Some(f64::INFINITY));
        assert_eq!(double("0x1.fffffffffffff8p0"), Some(2.0), "a tie past 53 bits: to even");
        assert_eq!(double("0x1.fffffffffffff80000001p0"), Some(2.0));
        assert_eq!(double("0x1.fffffffffffff7ffffffp0"), Some(f64::from_bits(0x3fff_ffff_ffff_ffff)));
    }
}
