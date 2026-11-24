// model/mod.rs's shared rules against model.ts and pinned-rules.ts (M:604, 620-656, 1161; PR boundElsewhere), read line
// by line: the bindings an item keeps, the state itself back when nothing changed.

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::state::state_of;
use serde_json::json;

fn lib() -> LibState {
    let v = json!({
        "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } },
        "pins": { "p-a": { "spaceId": "a", "url": "https://p/" }, "p-b": { "spaceId": "b", "url": "https://q/" } },
        "favorites": { "fav-1": { "url": "https://f/" } },
        "tabs": {
            "t-1": { "url": "https://p/", "spaceId": "a", "pinnedBy": "p-a", "favoriteId": "fav-1" },
            "t-2": { "url": "https://p/", "spaceId": "a", "pinnedBy": "p-b" },
            "t-3": { "url": "https://x/", "spaceId": "b", "favoriteId": "fav-gone" },
            "t-4": { "url": "https://y/", "spaceId": "b" },
        },
    });
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

#[test]
fn spaces_and_places() {
    let s = lib();
    assert!(has_space(&s, "a") && !has_space(&s, "c") && !has_space(&s, ""));
    assert_eq!(
        (pos_of(Some(2.5), 7), pos_of(None, 7), pos_of(Some(f64::NAN), 7), pos_of(Some(f64::INFINITY), 1)),
        (2.5, 7.0, 7.0, 1.0)
    );
}

#[test]
fn bindings_that_hold() {
    let s = lib();
    assert!(pin_of_space(&s, "p-a", "a") && !pin_of_space(&s, "p-a", "b") && !pin_of_space(&s, "", "a"));
    assert!(has_favorite(&s, "fav-1") && !has_favorite(&s, "fav-gone") && !has_favorite(&s, ""));
    let k = |id: &str| s.kept.get(id).unwrap().clone();
    // A pin's search by address never takes another's item.
    assert!(!bound_elsewhere(&s, &k("t-1"), "a", Some("p-a"), Some("fav-1")), "its own pin and favorite");
    assert!(bound_elsewhere(&s, &k("t-1"), "a", Some("p-x"), Some("fav-1")), "another pin's, in its space");
    assert!(bound_elsewhere(&s, &k("t-1"), "a", Some("p-a"), None), "a favorite's");
    assert!(!bound_elsewhere(&s, &k("t-2"), "a", None, None), "its pin is in another space: no pin's here");
    assert!(!bound_elsewhere(&s, &k("t-3"), "b", None, None), "its favorite is gone");
    assert!(!bound_elsewhere(&s, &k("t-4"), "b", Some("p-b"), None));
}

#[test]
fn held_bindings_drop_what_no_longer_holds() {
    let s = lib();
    let one = s.kept.get("t-1").unwrap();
    assert!(Rc::ptr_eq(&held_bindings(&s, one, "a"), one), "both hold: the item itself");
    let moved = held_bindings(&s, one, "b");
    assert_eq!(
        (moved.pinned_by.as_deref(), moved.favorite_id.as_deref()),
        (None, Some("fav-1")),
        "in another space: no pin's"
    );
    let three = held_bindings(&s, s.kept.get("t-3").unwrap(), "b");
    assert_eq!(three.favorite_id, None, "its favorite gone");
}

#[test]
fn settle_bindings_checks_every_item_and_keeps_the_rest() {
    let s = lib();
    let next = settle_bindings(&s);
    assert!(!next.same(&s));
    assert_eq!(next.kept.keys().map(|k| &**k).collect::<Vec<_>>(), ["t-1", "t-2", "t-3", "t-4"], "each where it was");
    assert_eq!(next.kept.get("t-2").unwrap().pinned_by, None, "its pin is another space's");
    assert_eq!(next.kept.get("t-3").unwrap().favorite_id, None);
    assert!(Rc::ptr_eq(next.kept.get("t-1").unwrap(), s.kept.get("t-1").unwrap()), "one that holds: the same item");
    assert!(Rc::ptr_eq(&next.pins, &s.pins), "only the items made anew");
    assert!(settle_bindings(&next).same(&next), "settled: the state itself");
}
