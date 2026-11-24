//! Link rules (piece 3, with [`super::splits`]): AT `normalizePattern`, `patternMatchesUrl`, `matchAirTrafficRule`
//! (the first enabled match in `order`, a stable sort: equal orders keep the list's order, which `stateOf` sorted by
//! `order` then the ids' `localeCompare`), M:1594-1624 `addAirTrafficRule` (`AIR_TRAFFIC_CAP` 100, a same pattern
//! replaced), `removeAirTrafficRule`, `toggleAirTrafficRule`.
//!
//! **Addresses aren't parsed today** (`js::RULES_PARSE_URLS` false): Margin.app's rules run in a bare JSContext, which has
//! no `URL`, so `patternMatchesUrl`'s `new URL(url)` throws, it answers false, and a link rule never routes a new tab or
//! `routeUrl` in the app (the browsers' copies parse). Kept exactly: [`pattern_matches_url`] and
//! [`match_air_traffic_rule`] take the address through `js::rules_url`. What a parsed address does is written and tested
//! too ([`pattern_matches_parts`], [`match_air_traffic_rule_with`] over `js::url_parts`), so turning parsing on (Tirth's
//! answer 11, its own commit) is that one constant and its tests.

use std::borrow::Cow;
use std::rc::Rc;

use super::has_space;
use crate::library::js::{self, UrlParts};
use crate::library::state::{LibState, Rule, Space, Str};

/// The most link rules there are (M:1594 `AIR_TRAFFIC_CAP`).
pub const AIR_TRAFFIC_CAP: usize = 100;

/// AT:22: a pattern's text, at most, in UTF-16 units (after its scheme).
const PATTERN_MAX: usize = 200;

/// AT:14 `HOST_PART`: `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`, one label of a host.
fn host_part_ok(label: &str) -> bool {
    let b = label.as_bytes();
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match b.len() {
        1 => edge(b[0]),
        2..=63 => edge(b[0]) && edge(b[b.len() - 1]) && b[1..b.len() - 1].iter().all(|&c| edge(c) || c == b'-'),
        _ => false,
    }
}

/// AT:21 `/^https?:\/\//i` taken off the front (ASCII's case: an ASCII pattern without the `u` flag).
fn without_scheme(s: &str) -> &str {
    let b = s.as_bytes();
    let has = |p: &[u8]| b.len() >= p.len() && b[..p.len()].eq_ignore_ascii_case(p);
    if has(b"http://") {
        &s[7..]
    } else if has(b"https://") {
        &s[8..]
    } else {
        s
    }
}

/// `s.toLowerCase()` (the full mapping; Rust's `to_lowercase` is the same one, final sigma included), the input itself
/// when there's nothing to lower.
fn lower(s: &str) -> Cow<'_, str> {
    if s.bytes().all(|b| b.is_ascii() && !b.is_ascii_uppercase()) {
        Cow::Borrowed(s)
    } else {
        Cow::Owned(s.to_lowercase())
    }
}

/// AT:18 `normalizePattern(raw)`: a pattern as typed made the rule's (`https://Linear.App/` → `linear.app`,
/// `*.Figma.com`, `github.com/my-org//x**` → `github.com/my-org/x*`), or none when it isn't one: empty, over 200 units,
/// a space or control inside, a host of fewer than 2 labels or a label that isn't `[a-z0-9-]` (after lowering: the
/// Kelvin sign is a `k`). The input itself (borrowed) when it's already a rule's pattern.
pub fn normalize_pattern(raw: &str) -> Option<Cow<'_, str>> {
    let text = without_scheme(js::trim(raw));
    if text.is_empty()
        || js::len16(text) > PATTERN_MAX
        || text.chars().any(|c| js::is_space(c) || c <= '\u{1f}' || c == '\u{7f}')
    {
        return None;
    }
    let (raw_host, raw_path) = match text.find('/') {
        Some(at) => (&text[..at], &text[at..]),
        None => (text, ""),
    };
    let host = lower(raw_host); // `cleanHost` is this: `*.` and the body, or the body
    let body = host.strip_prefix("*.").unwrap_or(&host);
    if body.split('.').count() < 2 || !body.split('.').all(host_part_ok) {
        return None;
    }
    if raw_path.is_empty() || raw_path == "/" || raw_path == "/*" {
        return Some(host);
    }
    // `rawPath.replace(/\/+/g, '/').replace(/\*+$/, '*')`
    let stars = raw_path.len() - raw_path.trim_end_matches('*').len();
    let clean = !raw_path.contains("//") && stars <= 1;
    if clean && matches!(host, Cow::Borrowed(_)) {
        return Some(Cow::Borrowed(text));
    }
    let mut out = String::with_capacity(host.len() + raw_path.len());
    out.push_str(&host);
    let mut slash = false;
    for c in raw_path[..raw_path.len() - stars].chars() {
        if c == '/' && slash {
            continue;
        }
        slash = c == '/';
        out.push(c);
    }
    if stars > 0 {
        out.push('*');
    }
    Some(Cow::Owned(out))
}

/// AT:37 `patternMatchesUrl(pattern, url)` as the library runs it: the address through `new URL` (`js::rules_url`:
/// never parses today, so never a match), then [`pattern_matches_parts`].
pub fn pattern_matches_url(pattern: &str, url: &str) -> bool {
    js::rules_url(url).is_some_and(|u| pattern_matches_parts(pattern, &u))
}

/// AT:40-61, past `new URL`: an http(s) address whose host is the pattern's (or under a `*.` pattern's, or its apex)
/// and whose path is the pattern's path, under it, or (a `…/*` pattern) starts with it.
pub fn pattern_matches_parts(pattern: &str, u: &UrlParts) -> bool {
    if u.protocol != "http:" && u.protocol != "https:" {
        return false;
    }
    let Some(norm) = normalize_pattern(pattern) else { return false };
    let (p_host, p_path) = match norm.find('/') {
        Some(at) => (&norm[..at], &norm[at..]),
        None => (&norm[..], ""),
    };
    let host = lower(&u.hostname);
    if let Some(base) = p_host.strip_prefix("*.") {
        if *host != *base && !host.strip_suffix(base).is_some_and(|h| h.ends_with('.')) {
            return false;
        }
    } else if *host != *p_host {
        return false;
    }
    if p_path.is_empty() {
        return true;
    }
    let path = if u.pathname.is_empty() { "/" } else { &u.pathname };
    if let Some(prefix) = p_path.strip_suffix('*') {
        return path.starts_with(prefix) || prefix.strip_suffix('/').is_some_and(|p| path == p);
    }
    let base = p_path.strip_suffix('/').unwrap_or(p_path);
    path == p_path || path.strip_prefix(base).is_some_and(|rest| rest.starts_with('/'))
}

/// AT:68 `matchAirTrafficRule(url, rules, validSpaceIds)` as the library runs it (LT:340, 664: the state's rules, its
/// spaces' ids): the address through `js::rules_url`, so today none.
pub fn match_air_traffic_rule<'r>(
    url: &str,
    rules: &'r [Rc<Rule>],
    spaces: Option<&[Rc<Space>]>,
) -> Option<&'r Rc<Rule>> {
    match_air_traffic_rule_with(url, rules, spaces, js::rules_url)
}

/// AT:68 `matchAirTrafficRule` with `new URL` given (`parse`): the first rule in `order` (`Number(order) || 0`, a stable
/// sort) that's enabled, of a space there is (when `spaces` is given) and matches. The address is parsed once, not per
/// rule as `patternMatchesUrl` does: the same answer (it's pure), and none at once when it doesn't parse.
pub fn match_air_traffic_rule_with<'r>(
    url: &str,
    rules: &'r [Rc<Rule>],
    spaces: Option<&[Rc<Space>]>,
    parse: impl Fn(&str) -> Option<UrlParts>,
) -> Option<&'r Rc<Rule>> {
    if url.is_empty() || rules.is_empty() {
        return None;
    }
    let u = parse(url)?;
    let key = |r: &Rule| r.order.filter(|o| !o.is_nan()).unwrap_or(0.0);
    let matches = |r: &&Rc<Rule>| {
        r.enabled
            && spaces.is_none_or(|sp| sp.iter().any(|x| x.id == r.space_id))
            && pattern_matches_parts(&r.pattern, &u)
    };
    if rules.is_sorted_by(|a, b| js::num_cmp(key(a), key(b)).is_le()) {
        return rules.iter().find(matches);
    }
    let mut ordered: Vec<&Rc<Rule>> = rules.iter().collect();
    ordered.sort_by(|a, b| js::num_cmp(key(a), key(b)));
    ordered.into_iter().find(matches)
}

/// `[...].map((r, i) => ({ ...r, order: i }))`: each rule at its place; one already there stays the same `Rc` (JS makes
/// an equal new object).
fn renumber<'a>(rules: impl Iterator<Item = &'a Rc<Rule>>) -> Vec<Rc<Rule>> {
    rules
        .enumerate()
        .map(|(i, r)| {
            let order = i as f64;
            if r.order.map(f64::to_bits) == Some(order.to_bits()) {
                r.clone()
            } else {
                Rc::new(Rule { order: Some(order), ..(**r).clone() })
            }
        })
        .collect()
}

/// M:1596 `addAirTrafficRule(state, { id, pattern, spaceId, enabled })`: a rule for the pattern (normalised) into the
/// space, last; a rule of the same pattern goes first (Always Open in This Space again updates it, at the cap too). The
/// state itself for a pattern that isn't one, no such space, or 100 rules already.
pub fn add_air_traffic_rule(s: &LibState, id: &str, pattern: &str, space_id: &str, enabled: bool) -> LibState {
    let Some(norm) = normalize_pattern(pattern) else { return s.clone() };
    if !has_space(s, space_id) {
        return s.clone();
    }
    let rest: Vec<&Rc<Rule>> =
        s.air_traffic.iter().filter(|r| normalize_pattern(&r.pattern).as_deref() != Some(&*norm)).collect();
    if rest.len() >= AIR_TRAFFIC_CAP {
        return s.clone();
    }
    let rule = Rc::new(Rule {
        id: id.into(),
        pattern: Str::from(&*norm),
        space_id: space_id.into(),
        enabled,
        order: Some(rest.len() as f64),
    });
    let mut list = renumber(rest.into_iter());
    list.push(rule);
    let mut next = s.clone();
    next.air_traffic = Rc::new(list);
    next
}

/// M:1609 `removeAirTrafficRule(state, ruleId)`: every rule of the id out, the rest renumbered; the state itself for no
/// such rule.
pub fn remove_air_traffic_rule(s: &LibState, rule_id: &str) -> LibState {
    if !s.air_traffic.iter().any(|r| *r.id == *rule_id) {
        return s.clone();
    }
    let mut next = s.clone();
    next.air_traffic = Rc::new(renumber(s.air_traffic.iter().filter(|r| *r.id != *rule_id)));
    next
}

/// M:1615 `toggleAirTrafficRule(state, ruleId, enabled)`: on or off as given (a boolean), else the first of the id's
/// flipped, for every rule of the id; the state itself for no such rule.
pub fn toggle_air_traffic_rule(s: &LibState, rule_id: &str, enabled: Option<bool>) -> LibState {
    let Some(cur) = s.air_traffic.iter().find(|r| *r.id == *rule_id) else { return s.clone() };
    let next_enabled = enabled.unwrap_or(!cur.enabled);
    let mut next = s.clone();
    next.air_traffic =
        Rc::new(
            s.air_traffic
                .iter()
                .map(|r| {
                    if *r.id == *rule_id { Rc::new(Rule { enabled: next_enabled, ..(**r).clone() }) } else { r.clone() }
                })
                .collect(),
        );
    next
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod tests;
