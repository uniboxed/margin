// kept.rs against model.ts and front-item.ts (M:317-355, 395-531, 1069-1083, 1777-1796, FI), read line by line: the
// places beside a row and their renumbering, the archive's one entry per address, newest first and capped, the items an
// address finds, the item in front. (The generated runs against model.ts in Node and JSC are the harness's,
// docs/CORE-REFACTOR.md step 4 part 3.)

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::state::state_of;
use serde_json::{Value, json};

fn lib(v: Value) -> LibState {
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

fn tab(url: &str, space: &str, order: f64, used: f64) -> Value {
    json!({ "url": url, "title": "T", "spaceId": space, "order": order, "lastUsed": used })
}

fn orders(s: &LibState) -> Vec<(&str, f64)> {
    s.kept.values().map(|k| (&*k.id, k.order)).collect()
}

fn two_spaces(tabs: Value) -> LibState {
    lib(json!({ "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } }, "tabs": tabs }))
}

#[test]
fn places_and_the_last_one() {
    let s = two_spaces(json!({ "t-1": tab("https://x/", "a", 3.0, 0.0), "t-2": tab("https://y/", "b", -7.0, 0.0) }));
    assert_eq!(last_place(&s), 3.0);
    assert_eq!(last_place(&LibState::default()), -1.0, "none: -1");
    let mut k = (**s.kept.get("t-1").unwrap()).clone();
    k.order = f64::INFINITY;
    assert_eq!(place_of(&k), 0.0, "a place that isn't finite is 0");
}

#[test]
fn tight_places_are_renumbered_in_their_order() {
    let s = two_spaces(json!({
        "t-1": tab("https://x/", "a", 5.0, 0.0),
        "t-2": tab("https://y/", "b", 1.0, 0.0),
        "t-3": tab("https://z/", "a", 1.0000005, 0.0),
        "t-4": tab("https://w/", "a", 1.0, 0.0),
    }));
    assert!(tight(&s), "1 and 1.0000005: closer than 1e-6");
    assert!(
        !tight(&two_spaces(
            json!({ "t-1": tab("https://x/", "a", 1.0, 0.0), "t-2": tab("https://y/", "a", 1.0, 0.0) })
        )),
        "equal places aren't tight"
    );
    assert!(
        !tight(&two_spaces(
            json!({ "t-1": tab("https://x/", "a", 0.0, 0.0), "t-2": tab("https://y/", "a", 0.000001, 0.0) })
        )),
        "1e-6 apart isn't"
    );
    // (1.000001 - 1 is 9.99999999917733e-7 in doubles: tight, as in JS.)
    assert!(tight(&two_spaces(
        json!({ "t-1": tab("https://x/", "a", 1.0, 0.0), "t-2": tab("https://y/", "a", 1.000001, 0.0) })
    )));
    let r = renumber(&s);
    // Equal places (t-2, t-4 at 1) keep the items' order: the stable sort.
    assert_eq!(
        orders(&r),
        [("t-1", 3.0), ("t-2", 0.0), ("t-3", 2.0), ("t-4", 1.0)],
        "every item numbered, each where it was"
    );
    let again = renumber(&r);
    assert!(Rc::ptr_eq(again.kept.get("t-1").unwrap(), r.kept.get("t-1").unwrap()), "one at its number: the same item");
}

#[test]
fn forgetting_and_archiving_an_item() {
    let s = lib(json!({
        "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } },
        "tabs": {
            "t-1": { "url": "https://x.com/", "title": "", "icon": "i.png", "spaceId": "gone", "order": 0, "lastUsed": 1 },
            "t-2": { "url": "app://com.apple.Notes", "title": "Notes", "spaceId": "a", "order": 1, "lastUsed": 1 },
            "t-3": { "url": "HTTP://x.com/", "title": "X", "spaceId": "b", "order": 2, "lastUsed": 1 },
        },
        "archive": {
            "a-old": { "url": "https://x.com/", "title": "Old", "spaceId": "a", "closedAt": 5 },
            "a-other": { "url": "https://x.com", "title": "Other", "spaceId": "a", "closedAt": 4 },
        },
    }));
    assert!(forget_kept(&s, "t-9".into()).same(&s), "no such item: the state itself");
    let f = forget_kept(&s, "t-2".into());
    assert_eq!(f.kept.keys().map(|k| &**k).collect::<Vec<_>>(), ["t-1", "t-3"]);
    assert!(Rc::ptr_eq(&f.archive, &s.archive));
    // `p.tabId` as it came: a key as JS makes one (`["t-2"]` is `"t-2"`), none is `"undefined"`.
    let listed = json!(["t-2"]);
    assert!(!forget_kept(&s, Arg::Value(&listed)).kept.contains_key("t-2"));
    assert!(forget_kept(&s, Arg::Undefined).same(&s));
    assert!(!archive_kept(&s, Arg::Value(&listed), "a-x", 1.0).unwrap().kept.contains_key("t-2"));

    assert!(archive_kept(&s, "t-9".into(), "a-new", 9.0).unwrap().same(&s));
    let a = archive_kept(&s, "t-1".into(), "a-new", 9.0).unwrap();
    assert!(!a.kept.contains_key("t-1"));
    let first = &a.archive[0];
    assert_eq!(
        (&*first.id, &*first.title, &*first.space_id, &*first.fav_icon_url, first.closed_at, first.target.is_none()),
        ("a-new", "https://x.com/", "a", "i.png", 9.0, true),
        "its title the address, its space gone: the first space's; no target (LT:239 gives it)"
    );
    // The address as given (no URL in the app's rules today): `https://x.com` is another address.
    assert_eq!(a.archive.iter().map(|e| &*e.id).collect::<Vec<_>>(), ["a-new", "a-other"], "one entry per address");

    let app = archive_kept(&s, "t-2".into(), "a-new", 9.0).unwrap();
    assert!(!app.kept.contains_key("t-2") && Rc::ptr_eq(&app.archive, &s.archive), "an app's item: forgotten only");
    let upper = archive_kept(&s, "t-3".into(), "a-new", 9.0).unwrap();
    assert_eq!(upper.archive.len(), 3, "/^https?:/i: HTTP: is a web page's");

    let lonely = lib(
        json!({ "tabs": { "t-1": tab("https://x/", "gone", 0.0, 0.0), "t-2": tab("file:///x", "gone", 0.0, 0.0) } }),
    );
    assert_eq!(
        archive_kept(&lonely, "t-1".into(), "a-x", 1.0).unwrap_err(),
        NO_FIRST_SPACE,
        "no space to give it: JS throws"
    );
    assert!(archive_kept(&lonely, "t-2".into(), "a-x", 1.0).is_ok(), "not a web page: nothing read");
}

#[test]
fn the_archive_is_capped_and_an_entry_needs_an_address() {
    let s = lib(
        json!({ "archive": { "a-1": { "url": "https://1/", "closedAt": 3 }, "a-2": { "url": "https://2/", "closedAt": 2 }, "a-3": { "url": "https://3/", "closedAt": 1 } } }),
    );
    let entry = |url: &str| ArchiveEntry {
        id: "a-n".into(),
        url: url.into(),
        title: "N".into(),
        space_id: "a".into(),
        fav_icon_url: "".into(),
        closed_at: 9.0,
        target: None,
    };
    assert!(archive_tab(&s, entry(""), ARCHIVE_CAP).same(&s), "no address: the state itself");
    let capped = archive_tab(&s, entry("https://9/"), 3);
    assert_eq!(
        capped.archive.iter().map(|e| &*e.id).collect::<Vec<_>>(),
        ["a-n", "a-1", "a-2"],
        "the oldest dropped past the cap"
    );
    assert_eq!(archive_tab(&s, entry("https://2/"), 3).archive.len(), 3, "its address's old entry dropped first");

    let removed = remove_archived(&s, "a-2");
    assert_eq!(removed.archive.iter().map(|e| &*e.id).collect::<Vec<_>>(), ["a-1", "a-3"]);
    let none = remove_archived(&s, "a-9");
    assert!(!none.same(&s) && *none.archive == *s.archive, "no such entry: a new list all the same (the TS's filter)");
}

#[test]
fn an_item_by_its_address() {
    let s = lib(json!({
        "spaces": { "a": { "name": "A" } },
        "pins": { "p-1": { "spaceId": "a", "url": "https://x/" }, "p-2": { "spaceId": "a", "url": "https://x/" } },
        "tabs": {
            "t-1": tab("https://x/", "a", 0.0, 5.0),
            "t-2": tab("https://x/", "a", 1.0, 7.0),
            "t-3": tab("https://x/", "a", 2.0, 7.0),
            "t-4": tab("https://x/", "b", 3.0, 9.0),
            "t-5": tab("https://x", "a", 4.0, 9.0),
        },
    }));
    let found = |s: &LibState, w: Option<ForWhom>| kept_for_url(s, "https://x/", "a", w).map(|k| k.id.to_string());
    assert_eq!(found(&s, None).as_deref(), Some("t-2"), "used last; of two equal, the first");
    let mut bound = s.clone();
    let mut k = (**bound.kept.get("t-2").unwrap()).clone();
    k.pinned_by = Some("p-2".into());
    Rc::make_mut(&mut bound.kept).insert("t-2".into(), Rc::new(k));
    let p1 = ForWhom { pin_id: Some("p-1"), favorite_id: None };
    assert_eq!(found(&bound, Some(p1)).as_deref(), Some("t-3"), "another pin's item isn't taken");
    assert_eq!(found(&bound, Some(ForWhom { pin_id: Some("p-2"), favorite_id: None })).as_deref(), Some("t-2"));
    assert_eq!(found(&bound, None).as_deref(), Some("t-2"), "for no one: any");
    assert!(kept_for_url(&s, "https://y/", "a", None).is_none());
}

#[test]
fn a_place_beside_a_row() {
    // Space a's list by place: t-1 (0), t-2 (1), t-3 (2); t-4 is b's.
    let s = two_spaces(json!({
        "t-1": tab("https://1/", "a", 0.0, 0.0),
        "t-2": tab("https://2/", "a", 1.0, 0.0),
        "t-3": tab("https://3/", "a", 2.0, 0.0),
        "t-4": tab("https://4/", "b", 3.0, 0.0),
    }));
    assert_eq!(place_beside(&s, "t-3", "t-1", Side::Before, "a"), Some(0.5), "above t-1: between it and t-2");
    assert_eq!(place_beside(&s, "t-1", "t-3", Side::Before, "a"), Some(3.0), "above the top: one more");
    assert_eq!(place_beside(&s, "t-3", "t-1", Side::After, "a"), Some(-1.0), "below the bottom: one less");
    assert_eq!(place_beside(&s, "t-1", "t-3", Side::After, "a"), Some(1.5), "the moving item isn't a neighbour");
    assert_eq!(place_beside(&s, "t-1", "t-1", Side::After, "a"), None, "beside itself");
    assert_eq!(place_beside(&s, "t-1", "t-4", Side::After, "a"), None, "a row of another space");
    assert_eq!(place_beside(&s, "t-9", "t-1", Side::After, "a"), None);
    assert_eq!(place_beside(&s, "t-1", "t-9", Side::After, "a"), None);
    assert_eq!(place_beside(&s, "t-4", "t-2", Side::After, "a"), Some(0.5), "an item of another space moved in");

    assert!(place_kept(&s, "t-1", "t-4", Side::After, "a").same(&s), "no place: the state itself");
    let placed = place_kept(&s, "t-3", "t-1", Side::Before, "a");
    assert_eq!(orders(&placed), [("t-1", 0.0), ("t-2", 1.0), ("t-3", 0.5), ("t-4", 3.0)]);
    assert!(Rc::ptr_eq(placed.kept.get("t-1").unwrap(), s.kept.get("t-1").unwrap()), "the others as they were");

    let close = two_spaces(
        json!({ "t-1": tab("https://1/", "a", 0.0, 0.0), "t-2": tab("https://2/", "a", 0.000001, 0.0), "t-3": tab("https://3/", "a", 5.0, 0.0) }),
    );
    let renumbered = place_kept(&close, "t-3", "t-1", Side::Before, "a");
    assert_eq!(orders(&renumbered), [("t-1", 0.0), ("t-2", 2.0), ("t-3", 1.0)], "too close: all renumbered");
}

#[test]
fn an_item_moved_to_another_space() {
    let s = lib(json!({
        "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } },
        "pins": { "p-a": { "spaceId": "a", "url": "https://x/" }, "p-b": { "spaceId": "b", "url": "https://x/" } },
        "favorites": { "fav-1": { "url": "https://x/" } },
        "tabs": {
            "t-1": { "url": "https://x/", "spaceId": "a", "pinnedBy": "p-a", "favoriteId": "fav-1" },
            "t-2": { "url": "https://x/", "spaceId": "a", "pinnedBy": "p-b" },
        },
    }));
    assert!(move_tab(&s, "t-1", "a").same(&s), "its own space");
    assert!(move_tab(&s, "t-1", "c").same(&s), "no such space");
    assert!(move_tab(&s, "t-9", "b").same(&s), "no such item");
    let moved = move_tab(&s, "t-1", "b");
    let k = moved.kept.get("t-1").unwrap();
    assert_eq!(
        (&*k.space_id, k.pinned_by.as_deref(), k.favorite_id.as_deref()),
        ("b", None, Some("fav-1")),
        "a's pin's no more; still the favorite's"
    );
    let back = move_tab(&s, "t-2", "b");
    assert_eq!(back.kept.get("t-2").unwrap().pinned_by.as_deref(), Some("p-b"), "into its pin's space: its pin's");
}

/// The tests' sorter, the other way round, to show which way the tie goes.
struct Reversed;
impl LocaleCompare for Reversed {
    fn compare(&self, a: &str, b: &str) -> Ordering {
        b.cmp(a)
    }
}

#[test]
fn the_item_in_front() {
    let s = two_spaces(json!({
        "t-b": { "url": "https://1/", "spaceId": "a", "lastUsed": 5, "selected": false },
        "t-a": { "url": "https://2/", "spaceId": "a", "lastUsed": 5, "selected": false },
        "t-c": { "url": "https://3/", "spaceId": "a", "lastUsed": 4, "selected": true },
        "t-d": { "url": "https://4/", "spaceId": "b", "lastUsed": 9, "selected": true },
    }));
    let front = |except: Option<&str>, c: &dyn LocaleCompare| {
        front_item_of(s.kept.values(), "a", except, c).map(|k| k.id.to_string())
    };
    assert_eq!(
        front(None, &CodePointOrder).as_deref(),
        Some("t-a"),
        "used last; a tie: the id localeCompare puts first"
    );
    assert_eq!(front(None, &Reversed).as_deref(), Some("t-b"), "the sorter decides the tie");
    assert_eq!(front(Some("t-a"), &CodePointOrder).as_deref(), Some("t-b"), "but `except`");
    let mut sel = s.clone();
    let mut b = (**sel.kept.get("t-b").unwrap()).clone();
    b.was_active = true;
    Rc::make_mut(&mut sel.kept).insert("t-b".into(), Rc::new(b));
    assert_eq!(
        front_item_of(sel.kept.values(), "a", None, &CodePointOrder).map(|k| &*k.id),
        Some("t-b"),
        "a tie: the selected one before the id"
    );
    assert!(front_item_of(s.kept.values(), "c", None, &CodePointOrder).is_none());
}
