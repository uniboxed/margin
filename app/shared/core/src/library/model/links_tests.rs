// links.rs against air-traffic.ts and model.ts M:1594-1624: tests/air-traffic.test.ts's cases, js.json's `patterns` and
// `url.matches` (JavaScriptCore's answers), the URL path (off today) against the browsers' answers, and the shared
// vectors' steps of the actions these rules and splits.rs's carry alone (link rules, routeUrl, resizeSplit,
// toggleSplitAxis, swapSplit) through a stand-in of their library.ts actions (LT:648-665, 755-777; part 4 writes the
// real ones). The generated states and sequences against model.ts are the scratch harness's, counted in DECISIONS.md.

use serde_json::{Map, Value, json};

use super::*;
use crate::library::js::{CodePointOrder, Collation, Ids, url_parts};
use crate::library::model::splits;
use crate::library::state::{LibTarget, TEXT_MAX, state_of, str_of};
use crate::library::values::diff;
use crate::library::vectors;

fn lib(rules: Value) -> LibState {
    let v = json!({
        "spaces": { "personal": { "name": "P", "order": 0 }, "work": { "name": "W", "order": 1 }, "design": { "name": "D", "order": 2 } },
        "airTraffic": rules,
    });
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

fn patterns(s: &LibState) -> Vec<(String, String, bool, f64)> {
    s.air_traffic
        .iter()
        .map(|r| (r.id.to_string(), r.pattern.to_string(), r.enabled, r.order.unwrap_or(f64::NAN)))
        .collect()
}

/// The URL path, as the commit that turns parsing on will run it.
fn parsed(pattern: &str, url: &str) -> bool {
    url_parts(url).is_some_and(|u| pattern_matches_parts(pattern, &u))
}

#[test]
fn patterns_as_air_traffic_test_normalises_them() {
    let n = |p: &str| normalize_pattern(p).map(|c| c.into_owned());
    assert_eq!(n("https://Linear.App/").as_deref(), Some("linear.app"));
    assert_eq!(n("*.Figma.com").as_deref(), Some("*.figma.com"));
    assert_eq!(n("github.com/my-org/*").as_deref(), Some("github.com/my-org/*"));
    assert_eq!(n("not a domain"), None);
    assert_eq!(n("localhost"), None);
    // The rest from model.ts in Node (probe.ts), each a branch of AT:18-34.
    for (p, want) in [
        ("HTTPS://a.com//x///y**", Some("a.com/x/y*")),
        (" \u{212a}a.com ", Some("ka.com")),
        ("\u{130}.com", None),
        ("a.com/", Some("a.com")),
        ("a.com/*", Some("a.com")),
        ("a.com/**", Some("a.com/*")),
        ("a.com//", Some("a.com/")),
        ("a.b", Some("a.b")),
        ("a-.com", None),
        ("-a.com", None),
        ("a.c-m", Some("a.c-m")),
        ("a_b.com", None),
        ("x.y_z", None),
        ("*.com", None),
        ("*.*.a.com", None),
        ("a..com", None),
        ("a.com\u{a0}", Some("a.com")),
        ("\u{feff}a.com", Some("a.com")),
        ("a.com\u{85}", None),
        ("a.com/x\u{85}", Some("a.com/x\u{85}")),
        ("a.com/x y", None),
        ("a.com/\u{7f}", None),
        ("httpS://x.y/a", Some("x.y/a")),
        ("http://https://x.y", None),
        ("http:/aa.b.com", None),
        (" https://a.com ", Some("a.com")),
        ("https:// a.com", None),
        ("https:/aa.b.com", None),
        ("ftp://x.y", None),
        ("x.y/é", Some("x.y/é")),
        ("X.Y/AbC", Some("x.y/AbC")),
        ("", None),
        ("   ", None),
        ("https://", None),
    ] {
        assert_eq!(n(p).as_deref(), want, "{p:?}");
    }
    let label = |len: usize| format!("{}.com", "a".repeat(len));
    assert_eq!(n(&label(63)), Some(label(63)));
    assert_eq!(n(&label(64)), None);
    // 200 units after the scheme, at most: an emoji is two.
    let long = format!("a.com/{}", "x".repeat(194));
    assert_eq!(n(&long).as_deref(), Some(&*long));
    assert_eq!(n(&format!("https://{long}")).as_deref(), Some(&*long));
    assert_eq!(n(&format!("{long}x")), None);
    assert_eq!(n(&format!("a.com/{}😀", "x".repeat(193))), None);
    let wide = format!("a.com/{}", "é".repeat(150)); // 156 units, 306 bytes
    assert_eq!(n(&wide).as_deref(), Some(&*wide));
    // Already a rule's: borrowed.
    assert!(matches!(normalize_pattern("github.com/my-org/*"), Some(Cow::Borrowed(_))));
    assert!(matches!(normalize_pattern("Github.com"), Some(Cow::Owned(_))));
}

#[test]
fn patterns_as_javascriptcore_normalises_them() {
    let js = vectors::js();
    let cases = js["cases"]["patterns"].as_array().expect("js.json's patterns");
    for c in cases {
        let (raw, want) = (c[0].as_str().expect("a pattern"), c[1].as_str());
        assert_eq!(normalize_pattern(raw).as_deref(), want, "{raw:?}");
    }
    assert!(cases.len() >= 18, "{} patterns", cases.len());
}

#[test]
fn no_address_matches_today() {
    // Margin.app's JSContext has no URL (js.json `url.hasUrl`): no pattern matches any address. Flips with
    // js::RULES_PARSE_URLS (Tirth's answer 11, its own commit): these become `parsed`'s answers below.
    const { assert!(!js::RULES_PARSE_URLS) };
    let js = vectors::js();
    assert_eq!(js["url"]["hasUrl"], json!(false));
    let matches = js["url"]["matches"].as_array().expect("js.json's url matches");
    for m in matches {
        let (p, u, want) = (m[0].as_str().unwrap(), m[1].as_str().unwrap(), m[2].as_bool().unwrap());
        assert_eq!(pattern_matches_url(p, u), want, "{p} {u}");
    }
    assert!(!pattern_matches_url("linear.app", "https://linear.app/inbox"));
    let s = lib(json!({ "r1": { "pattern": "github.com", "spaceId": "work", "order": 0 } }));
    assert!(match_air_traffic_rule("https://github.com/x", &s.air_traffic, Some(&s.spaces)).is_none());
}

#[test]
fn addresses_once_parsed_match_as_the_browsers() {
    // air-traffic.test.ts's (Node has a URL: the browsers' copies).
    assert!(parsed("linear.app", "https://linear.app/inbox"));
    assert!(!parsed("linear.app", "https://sub.linear.app/inbox"));
    assert!(parsed("*.figma.com", "https://www.figma.com/file/123"));
    assert!(parsed("*.figma.com", "https://figma.com/"));
    assert!(parsed("github.com/my-org/*", "https://github.com/my-org/repo/pull/1"));
    assert!(!parsed("github.com/my-org/*", "https://github.com/other-org/repo"));
    // Each branch of AT:40-61.
    assert!(parsed("github.com/my-org/*", "https://github.com/my-org"), "a /* pattern takes its folder");
    assert!(!parsed("github.com/my-org/*", "https://github.com/my-orgx"));
    assert!(parsed("github.com/my-org", "https://github.com/my-org/repo"));
    assert!(parsed("github.com/my-org/", "https://github.com/my-org/repo"));
    assert!(!parsed("github.com/my-org", "https://github.com/my-orgx"));
    assert!(parsed("a.com/x*", "https://a.com/xyz"));
    assert!(!parsed("*.figma.com", "https://xfigma.com/"));
    assert!(parsed("A.COM", "HTTP://a.com"));
    assert!(!parsed("a.com", "ftp://a.com/"));
    assert!(!parsed("a.com", "file:///a.com"));
    assert!(!parsed("a.com", "file://a.com/x"), "a host, but not http");
    assert!(!parsed("a.com", "ws://a.com/"));
    assert!(parsed("a.com", "https://a.com"), "and https");
    assert!(!parsed("not a pattern", "https://a.com/"));
    assert!(!parsed("a.com", "not a url"));
    assert!(parsed("a.com/%7E", "https://a.com/%7E"));
    // The rules: the first enabled, of a space there is, in order.
    let s = lib(json!({
        "r1": { "pattern": "github.com/my-org/*", "spaceId": "work", "enabled": true, "order": 0 },
        "r2": { "pattern": "github.com", "spaceId": "personal", "enabled": true, "order": 1 },
        "r3": { "pattern": "*.figma.com", "spaceId": "design", "enabled": false, "order": 2 },
    }));
    let found = |url: &str, spaces: Option<&[Rc<Space>]>| {
        match_air_traffic_rule_with(url, &s.air_traffic, spaces, url_parts).map(|r| r.space_id.to_string())
    };
    assert_eq!(found("https://github.com/my-org/app", Some(&s.spaces)).as_deref(), Some("work"));
    assert_eq!(found("https://github.com/torvalds/linux", Some(&s.spaces)).as_deref(), Some("personal"));
    assert_eq!(found("https://www.figma.com/file/1", Some(&s.spaces)), None, "disabled rule skipped");
    let personal: Vec<Rc<Space>> = s.spaces.iter().filter(|sp| *sp.id == *"personal").cloned().collect();
    assert_eq!(
        found("https://github.com/my-org/app", Some(&personal)).as_deref(),
        Some("personal"),
        "a gone space skipped"
    );
    assert_eq!(found("https://github.com/my-org/app", None).as_deref(), Some("work"));
    assert_eq!(found("", Some(&s.spaces)), None);
    // Out of order: a stable sort by `Number(order) || 0`.
    let mut shuffled = s.air_traffic.to_vec();
    shuffled.reverse();
    let mut r3 = (*shuffled[0]).clone();
    r3.enabled = true;
    shuffled[0] = Rc::new(r3);
    let mut none = (*shuffled[2]).clone();
    none.order = None; // r1, as 0
    shuffled[2] = Rc::new(none);
    let first = match_air_traffic_rule_with("https://github.com/my-org/x", &shuffled, None, url_parts);
    assert_eq!(first.map(|r| &*r.id), Some("r1"));
}

#[test]
fn rules_added_replaced_capped() {
    let s = lib(json!({}));
    assert!(add_air_traffic_rule(&s, "atc-1", "not a pattern", "work", true).same(&s), "bad pattern");
    assert!(add_air_traffic_rule(&s, "atc-1", "a.com", "nowhere", true).same(&s), "no such space");
    let s1 = add_air_traffic_rule(&s, "atc-1", "https://A.com/", "work", true);
    let s2 = add_air_traffic_rule(&s1, "atc-2", "b.com", "personal", false);
    assert_eq!(
        patterns(&s2),
        [("atc-1".into(), "a.com".into(), true, 0.0), ("atc-2".into(), "b.com".into(), false, 1.0)]
    );
    assert!(Rc::ptr_eq(&s2.air_traffic[0], &s1.air_traffic[0]), "a rule in its place stays the same");
    // The same pattern again: the old one goes, the new one last.
    let s3 = add_air_traffic_rule(&s2, "atc-3", "a.com/", "design", true);
    assert_eq!(
        patterns(&s3),
        [("atc-2".into(), "b.com".into(), false, 0.0), ("atc-3".into(), "a.com".into(), true, 1.0)]
    );
    // At the cap: refused, but a replacement still goes in.
    let mut full = s.clone();
    for i in 0..AIR_TRAFFIC_CAP {
        full = add_air_traffic_rule(&full, &format!("atc-{i}"), &format!("h{i}.com"), "work", true);
    }
    assert_eq!(full.air_traffic.len(), 100);
    assert!(add_air_traffic_rule(&full, "atc-x", "new.com", "work", true).same(&full), "a 101st");
    let replaced = add_air_traffic_rule(&full, "atc-x", "H5.com", "personal", true);
    assert_eq!(replaced.air_traffic.len(), 100);
    assert_eq!(&*replaced.air_traffic[99].id, "atc-x");
    assert_eq!(replaced.air_traffic[5].id.as_ref(), "atc-6");
    // A stored pattern that isn't one (cut, or old) is never the same pattern.
    let odd = lib(json!({ "r1": { "pattern": "not one", "spaceId": "work", "order": 0 } }));
    assert_eq!(add_air_traffic_rule(&odd, "atc-1", "a.com", "work", true).air_traffic.len(), 2);
}

#[test]
fn rules_removed_and_toggled() {
    let s = lib(json!({
        "r1": { "pattern": "a.com", "spaceId": "work", "order": 0 },
        "r2": { "pattern": "b.com", "spaceId": "work", "order": 1, "enabled": false },
        "r3": { "pattern": "c.com", "spaceId": "work", "order": 2 },
    }));
    assert!(remove_air_traffic_rule(&s, "nope").same(&s));
    let r = remove_air_traffic_rule(&s, "r2");
    assert_eq!(patterns(&r), [("r1".into(), "a.com".into(), true, 0.0), ("r3".into(), "c.com".into(), true, 1.0)]);
    assert!(Rc::ptr_eq(&r.air_traffic[0], &s.air_traffic[0]));
    assert!(toggle_air_traffic_rule(&s, "nope", None).same(&s));
    let t = toggle_air_traffic_rule(&s, "r2", None);
    assert!(t.air_traffic[1].enabled, "flipped");
    let t = toggle_air_traffic_rule(&t, "r1", None);
    assert!(!t.air_traffic[0].enabled);
    let t2 = toggle_air_traffic_rule(&t, "r1", Some(false));
    assert!(!t2.air_traffic[0].enabled && !t2.same(&t), "as given, a new state even when equal (M spreads)");
    assert!(Rc::ptr_eq(&t2.air_traffic[2], &s.air_traffic[2]));
}

// ---- the shared vectors: library.ts's actions that are these rules alone -------------------------------------------

/// LT:192 `win(p)`: a number's `String`, a string that isn't empty; else none.
fn win(p: &Map<String, Value>) -> Option<String> {
    match p.get("windowId") {
        Some(Value::Number(n)) => Some(js::number_string(n.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(w)) if !w.is_empty() => Some(w.clone()),
        _ => None,
    }
}

/// LT:193 `hasSpace(s, id)` for a payload's value.
fn has_space_value(s: &LibState, id: Option<&Value>) -> Option<String> {
    id.and_then(Value::as_str).filter(|id| has_space(s, id)).map(str::to_owned)
}

/// LT:196 `windowSpace(s, w)`.
fn window_space(s: &LibState, w: Option<&str>) -> Option<String> {
    w.and_then(|w| s.windows.get(w))
        .filter(|id| has_space(s, id))
        .map(|id| id.to_string())
        .or_else(|| s.spaces.first().map(|sp| sp.id.to_string()))
}

/// LT:267 `splitShown(s, group, null, p)`.
fn split_shown(s: &LibState, g: &crate::library::state::Split, p: &Map<String, Value>) -> Value {
    let panes: Vec<Value> = g
        .panes
        .iter()
        .filter_map(|id| s.kept.get(id))
        .map(|k| json!({ "item": &*k.id, "url": &*k.url, "target": k.target.to_value() }))
        .collect();
    json!({
        "type": "showSplit", "windowId": p.get("windowId").cloned().unwrap_or(Value::Null), "splitId": &*g.id,
        "item": null, "axis": g.axis.as_str(), "ratios": g.ratios, "panes": panes,
    })
}

struct Rules(Collation);

impl vectors::Engine for Rules {
    fn perform(
        &mut self,
        values: &Map<String, Value>,
        action: &str,
        payload: &Value,
        env: &vectors::Env,
    ) -> Option<Value> {
        let empty = Map::new();
        let p = payload.as_object().unwrap_or(&empty);
        let s = state_of(values, &self.0);
        let mut ids = Ids::new(env.ids.clone());
        let mut requests: Vec<Value> = Vec::new();
        let split_of = |id: Option<&Value>| {
            id.and_then(Value::as_str).and_then(|id| s.splits.iter().find(|g| *g.id == *id)).cloned()
        };
        let outcome: Result<(LibState, Value), &str> = match action {
            "addAirTrafficRule" => (|| {
                let space = has_space_value(&s, p.get("spaceId")).or_else(|| window_space(&s, win(p).as_deref()));
                let Some(space) = space else { return Err("no space") };
                let id = ids.other("atc");
                let enabled = p.get("enabled") != Some(&Value::Bool(false));
                let next = add_air_traffic_rule(&s, &id, str_of(p.get("pattern"), 200), &space, enabled);
                if next.same(&s) { Err("bad pattern") } else { Ok((next, json!(id))) }
            })(),
            "removeAirTrafficRule" => Ok((remove_air_traffic_rule(&s, str_of(p.get("ruleId"), 128)), Value::Null)),
            "toggleAirTrafficRule" => Ok((
                toggle_air_traffic_rule(&s, str_of(p.get("ruleId"), 128), p.get("enabled").and_then(Value::as_bool)),
                Value::Null,
            )),
            "routeUrl" => {
                let url = str_of(p.get("url"), TEXT_MAX);
                let result = match match_air_traffic_rule(url, &s.air_traffic, Some(&s.spaces)) {
                    None => Value::Null,
                    Some(r) => {
                        let sp = s.spaces.iter().find(|sp| sp.id == r.space_id);
                        let target = LibTarget::web(
                            sp.map_or("safari", |sp| &sp.browser),
                            sp.and_then(|sp| sp.profile.as_deref()),
                        );
                        json!({ "ruleId": &*r.id, "pattern": &*r.pattern, "spaceId": &*r.space_id, "target": target.to_value() })
                    }
                };
                Ok((s.clone(), result))
            }
            "resizeSplit" => match split_of(p.get("splitId")) {
                None => Err("no such split"),
                Some(g) => Ok((
                    splits::resize_split(&s, &g.id, p.get("ratios").and_then(Value::as_array).map(Vec::as_slice)),
                    Value::Null,
                )),
            },
            "toggleSplitAxis" => match split_of(p.get("splitId")) {
                None => Err("no such split"),
                Some(g) => {
                    let next = splits::toggle_split_axis(&s, &g.id);
                    if let Some(after) = next.splits.iter().find(|x| x.id == g.id) {
                        requests.push(split_shown(&next, after, p));
                    }
                    Ok((next, Value::Null))
                }
            },
            "swapSplit" => match split_of(p.get("splitId")) {
                None => Err("no such split"),
                Some(g) => {
                    let int = |v: Option<&Value>, or: f64| js::finite(v).filter(|n| n.fract() == 0.0).unwrap_or(or);
                    let next = splits::swap_split_panes(&s, &g.id, int(p.get("a"), 0.0), int(p.get("b"), 1.0));
                    if let Some(after) = next.splits.iter().find(|x| x.id == g.id).filter(|_| !next.same(&s)) {
                        requests.push(split_shown(&next, after, p));
                    }
                    Ok((next, Value::Null))
                }
            },
            _ => return None,
        };
        Some(match outcome {
            Err(error) => json!({ "ok": false, "result": null, "error": error, "changes": [], "requests": [] }),
            Ok((next, result)) => {
                let after = splits::settle_splits(&next);
                let changes: Vec<Value> = diff(&s, &after).iter().map(|c| c.to_json()).collect();
                json!({ "ok": true, "result": result, "changes": changes, "requests": requests })
            }
        })
    }
}

#[test]
fn the_vectors_of_these_rules_actions() {
    let report = vectors::run(&mut Rules(Collation::default()));
    report.assert_ok();
    let checked = report.checked.get("perform").copied().unwrap_or(0);
    assert!(checked > 900, "{checked} perform steps checked");
}
