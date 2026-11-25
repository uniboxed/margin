//! A host's id as the session's log lines say it and the role it names (Host.swift `HostID`): the lines print
//! `\(id)`, so the form is ported exactly, with a vector (tests below).

use crate::hosted_browser::Role;

const SAFARI: &str = "safari:";

/// A role's suffix in an id (`card`, `pane1`…`pane3`, after the last `#`); None: not a role.
fn role_of(suffix: &str) -> Option<Role> {
    if suffix == "card" {
        return Some(Role::Card);
    }
    // (Swift's `Int(_:)`: ASCII digits, an optional sign, within an Int64.)
    let n: i64 = suffix.strip_prefix("pane")?.parse().ok()?;
    (1..=3).contains(&n).then_some(Role::Pane(n as u8))
}

/// A Safari host's profile (as in its id) and its role (None: main).
fn safari_parts(raw: &str) -> (&str, Option<Role>) {
    let rest = &raw[SAFARI.len()..];
    match rest.rfind('#') {
        Some(hash) => match role_of(&rest[hash + 1..]) {
            Some(role) => (&rest[..hash], Some(role)),
            None => (rest, None),
        },
        None => (rest, None),
    }
}

fn suffix(role: Role) -> String {
    match role {
        Role::Main => String::new(),
        Role::Card => "#card".into(),
        Role::Pane(n) => format!("#pane{n}"),
    }
}

/// How the log says a host: an app's id as it is, a Safari window's `safari:default` (no profile) or
/// `safari:p<number>` (the djb2 hash of its profile's UTF-8, modulo 10000: never a profile's name), its role's
/// suffix after it.
pub fn logged(raw: &str) -> String {
    if !raw.starts_with(SAFARI) {
        return raw.to_string();
    }
    let (profile, role) = safari_parts(raw);
    let suffix = role.map(suffix).unwrap_or_default();
    if profile.is_empty() {
        return format!("safari:default{suffix}");
    }
    let hash = profile.bytes().fold(5381u32, |h, b| h.wrapping_mul(33).wrapping_add(u32::from(b)));
    format!("safari:p{}{suffix}", hash % 10000)
}

/// Its Safari role (`HostID.safariRole`): main for an app's and for a main window's.
pub fn safari_role(raw: &str) -> Role {
    if raw.starts_with(SAFARI) { safari_parts(raw).1.unwrap_or(Role::Main) } else { Role::Main }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logged_as_the_swift_says_it() {
        // (Each line's Swift answer: HostID(raw:).description and .safariRole, Swift 6.4, 2026-11-23. A `#` or the
        // `:` joined to a combining mark after it is one Character in Swift, so not a `#` or `safari:`: the one
        // difference, ids that never have one, as step 1's caps counted scalars.)
        let vector: &[(&str, &str, Role)] = &[
            ("app:com.apple.Notes", "app:com.apple.Notes", Role::Main),
            ("safari:", "safari:default", Role::Main),
            ("safari:#card", "safari:default#card", Role::Card),
            ("safari:s-default", "safari:p8010", Role::Main),
            ("safari:s-default#card", "safari:p8010#card", Role::Card),
            ("safari:s-default#pane1", "safari:p8010#pane1", Role::Pane(1)),
            ("safari:s-default#pane3", "safari:p8010#pane3", Role::Pane(3)),
            ("safari:s-default#pane4", "safari:p3333", Role::Main),
            ("safari:s-default#pane+2", "safari:p8010#pane2", Role::Pane(2)),
            ("safari:s-default#pane02", "safari:p8010#pane2", Role::Pane(2)),
            ("safari:s-default#pane", "safari:p2097", Role::Main),
            ("safari:a#b#card", "safari:p3883#card", Role::Card),
            ("safari:a#card#x", "safari:p4078", Role::Main),
            ("safari:é", "safari:p6513", Role::Main),
            ("safari:6F1C0D1E-8B53-4F8A-9C1D-2B7C1E9A0F11", "safari:p5311", Role::Main),
            ("safarix:s", "safarix:s", Role::Main),
            ("", "", Role::Main),
            ("safari:s#pane-1", "safari:p9389", Role::Main),
            ("safari:s#pane9223372036854775807", "safari:p2599", Role::Main),
            ("safari:s#pane99999999999999999999", "safari:p5171", Role::Main),
            ("safari:s#pane 1", "safari:p8960", Role::Main),
            ("safari:s#PANE1", "safari:p3296", Role::Main),
        ];
        for (raw, said, role) in vector {
            assert_eq!(logged(raw), *said, "{raw}");
            assert_eq!(safari_role(raw), *role, "{raw}");
        }
    }
}
