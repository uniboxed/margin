// model/order.rs against model.ts and pinned-rules.ts (M:612, 1161-1419; PR folderDepth), read line by line: a level's
// order, what's rewritten when something moves, every refusal, and the state itself when nothing changed. The vectors'
// steps of these rules (movePin, renamePin, renameTab, unpin and the folders' actions) run in spaces_tests.rs.

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::state::state_of;
use serde_json::json;

fn lib(v: Value) -> LibState {
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

fn ids(list: &[Entry]) -> Vec<&str> {
    list.iter().map(|e| &*e.id).collect()
}

fn pin<'a>(s: &'a LibState, id: &str) -> &'a Rc<Pin> {
    s.pins.iter().find(|p| *p.id == *id).unwrap()
}

fn folder<'a>(s: &'a LibState, id: &str) -> &'a Rc<Folder> {
    s.folders.iter().find(|f| *f.id == *id).unwrap()
}

/// Each pin's and folder's `(id, folder or parent, pos)`, in the lists' order.
fn layout(s: &LibState) -> Vec<(String, Option<String>, Option<f64>)> {
    let pins = s.pins.iter().map(|p| (p.id.to_string(), p.folder_id.as_deref().map(String::from), p.pos));
    let folders = s.folders.iter().map(|f| (f.id.to_string(), f.parent_id.as_deref().map(String::from), f.pos));
    pins.chain(folders).collect()
}

/// Space `a`: folders f1 (top, pos 1), f2 (in f1, pos 0), f3 (in f2), f4 (in f3); pins p1 (top, pos 1, ties f1), p2
/// (top, pos 0), p3 (in f1, pos 0), p4 (in a gone folder: loose, pos 2), p5 (space b). Items t-1 bound to p1, t-2 to
/// p1, t-3 to none.
fn tree() -> LibState {
    lib(json!({
        "spaces": { "a": { "name": "A", "order": 0 }, "b": { "name": "B", "order": 1 } },
        "folders": {
            "f1": { "spaceId": "a", "name": "One", "pos": 1 },
            "f2": { "spaceId": "a", "name": "Two", "pos": 0, "parentId": "f1" },
            "f3": { "spaceId": "a", "name": "Three", "pos": 0, "parentId": "f2" },
            "f4": { "spaceId": "a", "name": "Four", "pos": 0, "parentId": "f3" },
            "fb": { "spaceId": "b", "name": "B's", "pos": 0 },
        },
        "pins": {
            "p1": { "spaceId": "a", "url": "https://one/", "pos": 1 },
            "p2": { "spaceId": "a", "url": "https://two/", "pos": 0 },
            "p3": { "spaceId": "a", "url": "https://three/", "pos": 0, "folderId": "f1" },
            "p4": { "spaceId": "a", "url": "https://four/", "pos": 2, "folderId": "f-gone" },
            "p5": { "spaceId": "b", "url": "https://one/", "pos": 0 },
        },
        "tabs": {
            "t-1": { "url": "https://one/", "spaceId": "a", "pinnedBy": "p1" },
            "t-2": { "url": "https://one/x", "spaceId": "a", "pinnedBy": "p1", "customTitle": "Mine" },
            "t-3": { "url": "https://x/", "spaceId": "b" },
        },
    }))
}

#[test]
fn arg_reads_a_payload_value_as_js_does() {
    let (five, empty, list, null, obj) = (json!(5), json!(""), json!([1, [2, null]]), json!(null), json!({}));
    assert!(Arg::Undefined.nullish() && Arg::Value(&null).nullish() && !Arg::Value(&five).nullish());
    assert!(Arg::Value(&null).is_null() && !Arg::Undefined.is_null() && Arg::Undefined.or_null().is_null());
    assert!(!Arg::Value(&empty).truthy() && !Arg::Str("").truthy() && Arg::Value(&obj).truthy());
    assert!(!Arg::Value(&json!(0)).truthy() && Arg::Value(&json!([])).truthy());
    assert_eq!(
        (Arg::Value(&five).as_str(), Arg::Value(&json!("x")).as_str(), Arg::Str("y").as_str()),
        (None, Some("x"), Some("y"))
    );
    assert_eq!(
        [
            Arg::Value(&five).text(),
            Arg::Value(&list).text(),
            Arg::Value(&null).text(),
            Arg::Undefined.text(),
            Arg::Value(&obj).text()
        ],
        ["5", "1,2,", "", "", "[object Object]"]
    );
    assert!(matches!(Arg::from(None), Arg::Value(Value::Null)) && matches!(Arg::from(Some("f")), Arg::Str("f")));
}

#[test]
fn lookups() {
    let s = tree();
    assert_eq!(pin_for_url(&s, "https://one/", None).map(|p| &*p.id), Some("p1"), "the first at the address");
    assert_eq!(pin_for_url(&s, "https://one/", Some("b")).map(|p| &*p.id), Some("p5"));
    assert!(pin_for_url(&s, "https://one", Some("a")).is_none(), "today's rules match addresses as given");
    assert!(pin_for_url(&s, "", None).is_none());
    assert_eq!(folder_in(&s, "f1", "a").map(|f| &*f.id), Some("f1"));
    assert!(folder_in(&s, "f1", "b").is_none(), "another space's");
    assert_eq!(folder_of_pin(&s, pin(&s, "p3")).map(|f| &*f.id), Some("f1"));
    assert!(folder_of_pin(&s, pin(&s, "p4")).is_none(), "a gone folder: loose");
    assert_eq!(folder_parent(&s, folder(&s, "f2")).map(|f| &*f.id), Some("f1"));
    assert!(folder_parent(&s, folder(&s, "f1")).is_none());
    assert_eq!(
        (folder_depth(&s, Some("f4"), "a"), folder_depth(&s, Some("f1"), "a"), folder_depth(&s, None, "a")),
        (3, 0, 0)
    );
    assert_eq!(folder_depth(&s, Some("f4"), "b"), 0, "its space's only");
    // Stored deeper than the limit (an older or another copy's data): counted all the way up.
    let deep = lib(json!({ "spaces": { "a": {} }, "folders": {
        "d1": { "spaceId": "a" }, "d2": { "spaceId": "a", "parentId": "d1" }, "d3": { "spaceId": "a", "parentId": "d2" },
        "d4": { "spaceId": "a", "parentId": "d3" }, "d5": { "spaceId": "a", "parentId": "d4" }, "d6": { "spaceId": "a", "parentId": "d5" },
    } }));
    assert_eq!((folder_depth(&deep, Some("d6"), "a"), folder_subtree_height(&deep, "d1", "a")), (5, 6));
    assert_eq!(
        (
            folder_subtree_height(&s, "f1", "a"),
            folder_subtree_height(&s, "f3", "a"),
            folder_subtree_height(&s, "f4", "a")
        ),
        (4, 2, 1)
    );
    assert!(folder_has_ancestor(&s, "f4", "f1", "a") && folder_has_ancestor(&s, "f2", "f2", "a"), "itself counts");
    assert!(!folder_has_ancestor(&s, "f1", "f2", "a") && !folder_has_ancestor(&s, "f4", "f1", "b"));
}

#[test]
fn cycles_in_stored_folders_are_cut() {
    let s = lib(json!({
        "spaces": { "a": {}, "b": {} },
        "folders": {
            "x": { "spaceId": "a", "parentId": "y" }, "y": { "spaceId": "a", "parentId": "x" },
            "self": { "spaceId": "a", "parentId": "self" }, "away": { "spaceId": "a", "parentId": "fb" },
            "fb": { "spaceId": "b" }, "z": { "spaceId": "a", "parentId": "x" },
        },
    }));
    assert!(folder_parent(&s, folder(&s, "x")).is_none() && folder_parent(&s, folder(&s, "y")).is_none(), "a cycle");
    assert!(folder_parent(&s, folder(&s, "self")).is_none());
    assert!(folder_parent(&s, folder(&s, "away")).is_none(), "a parent in another space");
    assert!(folder_parent(&s, folder(&s, "z")).is_none(), "its parent's walk up cycles");
    assert_eq!(folder_depth(&s, Some("x"), "a"), 2, "up to y, to x again: the walk stops when it comes back");
    assert_eq!(folder_subtree_height(&s, "x", "a"), 2, "under x: y (x seen again: 0, so 1) and z (1)");
    assert!(folder_has_ancestor(&s, "x", "y", "a") && !folder_has_ancestor(&s, "x", "q", "a"));
    assert_eq!(ids(&pin_order(&s, "a", None)), ["x", "y", "self", "away", "z"], "every cut one at the top");
}

#[test]
fn pin_order_puts_folders_first_at_equal_places() {
    let s = tree();
    assert_eq!(ids(&pin_order(&s, "a", None)), ["p2", "f1", "p1", "p4"]);
    assert_eq!(pin_order(&s, "a", None)[1].kind, Kind::Folder);
    assert_eq!(ids(&pin_order(&s, "a", Some("f1"))), ["f2", "p3"]);
    assert_eq!(ids(&pin_order(&s, "b", None)), ["fb", "p5"]);
    // A pin with no place (an older one): its index in the list stands in.
    let mut t = tree();
    Rc::make_mut(&mut t.pins)[1] = Rc::new(Pin { pos: None, ..(*t.pins[1]).clone() });
    assert_eq!(ids(&pin_order(&t, "a", None)), ["f1", "p1", "p2", "p4"], "p2 at 1, after f1 and p1 by the stable sort");
    // Its index in the whole list, every space's (p5 is the 5th pin: 4, after b's new pin at 2).
    let t = add_pin(&tree(), "pb", "b", "https://b/", None, Arg::Undefined, Arg::Undefined);
    let mut t = t;
    Rc::make_mut(&mut t.pins)[4] = Rc::new(Pin { pos: None, ..(*t.pins[4]).clone() });
    let mut u = t.clone();
    Rc::make_mut(&mut u.folders)[4] = Rc::new(Folder { pos: None, ..(*u.folders[4]).clone() });
    assert_eq!(ids(&pin_order(&u, "b", None)), ["pb", "fb", "p5"], "fb, the 5th folder: 4");
    assert_eq!((pin(&t, "pb").pos, ids(&pin_order(&t, "b", None))), (Some(2.0), vec!["fb", "pb", "p5"]));
}

#[test]
fn write_order_rewrites_only_what_moved() {
    let s = tree();
    assert!(!write_order(&s, None, &pin_order(&s, "a", None)).same(&s), "f1 and p1 renumbered");
    let level = [Entry::pin("p2"), Entry::folder("f1"), Entry::pin("p1")];
    let next = write_order(&s, None, &level);
    assert!(Rc::ptr_eq(pin(&next, "p2"), pin(&s, "p2")), "at its place already: the same pin");
    assert_eq!((pin(&next, "p1").pos, folder(&next, "f1").pos), (Some(2.0), Some(1.0)));
    assert!(Rc::ptr_eq(folder(&next, "f1"), folder(&s, "f1")));
    assert!(Rc::ptr_eq(&next.folders, &s.folders), "no folder moved: the same list");
    assert!(write_order(&next, None, &level).same(&next), "nothing moved: the state itself");
    // Into a folder: the pin's folder written, a subfolder's parent; a falsy folder writes none.
    let next = write_order(&s, Some("f2"), &[Entry::pin("p2"), Entry::folder("f4")]);
    assert_eq!(pin(&next, "p2").folder_id.as_deref(), Some("f2"));
    assert_eq!(folder(&next, "f4").parent_id.as_deref(), Some("f2"));
    assert!(!Rc::ptr_eq(folder(&next, "f4"), folder(&s, "f4")));
    let next = write_order(&s, Some(""), &[Entry::pin("p3")]);
    assert_eq!((pin(&next, "p3").folder_id.as_deref(), pin(&next, "p3").pos), (None, Some(0.0)), "moved: '' isn't f1");
    // An id twice (a pin and a folder of one id): the later place for both.
    let next = write_order(&s, None, &[Entry::pin("f1"), Entry::folder("p2"), Entry::folder("f1")]);
    assert_eq!(folder(&next, "f1").pos, Some(2.0));
}

#[test]
fn placed_moves_an_entry_before_another() {
    let l = || vec![Entry::pin("a"), Entry::folder("b"), Entry::pin("c")];
    assert_eq!(ids(&placed(l(), Entry::pin("c"), Some("a"))), ["c", "a", "b"]);
    assert_eq!(ids(&placed(l(), Entry::pin("a"), None)), ["b", "c", "a"], "the end");
    assert_eq!(ids(&placed(l(), Entry::pin("a"), Some("gone"))), ["b", "c", "a"]);
    assert_eq!(ids(&placed(l(), Entry::pin("b"), Some("b"))), ["a", "b", "c"], "before itself: where it is");
    assert_eq!(ids(&placed(l(), Entry::pin("d"), Some("d"))), ["a", "b", "c", "d"]);
    assert_eq!(ids(&placed(l(), Entry::pin("d"), Some("b"))), ["a", "d", "b", "c"]);
}

#[test]
fn names() {
    let (n, e, sp) = (json!(12.5), json!("  \u{feff}Work\u{a0} "), json!(" a \u{2028}\t b "));
    assert_eq!(
        (folder_name(Arg::Value(&n)), folder_name(Arg::Value(&e)), folder_name(Arg::Undefined)),
        ("12.5".into(), "Work".into(), String::new())
    );
    assert_eq!(folder_name(Arg::Str(&"x".repeat(50))), "x".repeat(40));
    assert_eq!(folder_name(Arg::Str(&format!("  {}", "x".repeat(45)))), "x".repeat(40), "trimmed, then cut");
    assert_eq!(
        folder_name(Arg::Str(&format!("{}😀", "x".repeat(39)))),
        "x".repeat(39),
        "a cut through an emoji drops it"
    );
    assert_eq!(folder_name(Arg::Str("a\u{85}")), "a\u{85}", "U+0085 isn't JS's space");
    assert_eq!(clean_custom_title(Arg::Value(&sp)), "a b");
    assert_eq!(clean_custom_title(Arg::Str(&"w ".repeat(45))), format!("{}w ", "w ".repeat(39)), "cut after the trim");
    let s = tree();
    assert_eq!(unique_name(&s, "a", "New"), "New");
    let s = create_folder(&s, "f5", "a", Arg::Str("One"), &[], None, Arg::Undefined);
    let s = create_folder(&s, "f6", "a", Arg::Str("One"), &[], None, Arg::Undefined);
    assert_eq!((&*folder(&s, "f5").name, &*folder(&s, "f6").name), ("One 2", "One 3"));
    assert_eq!(unique_name(&s, "b", "One"), "One", "another space's names aren't taken");
}

#[test]
fn adding_a_pin() {
    let s = tree();
    let null = json!(null);
    assert!(add_pin(&s, "n", "a", "", None, Arg::Undefined, Arg::Undefined).same(&s), "no address");
    assert!(add_pin(&s, "n", "zz", "https://n/", None, Arg::Undefined, Arg::Undefined).same(&s), "no such space");
    assert!(
        add_pin(&s, "n", "a", "https://one/", None, Arg::Undefined, Arg::Undefined).same(&s),
        "a pin there already"
    );
    let next = add_pin(&s, "n", "b", "https://two/", Some(""), Arg::Value(&null), Arg::Value(&null));
    let n = pin(&next, "n");
    assert_eq!((&*n.title, n.pos, n.folder_id.as_deref(), n.target.is_none()), ("https://two/", Some(2.0), None, true));
    assert_eq!(ids(&pin_order(&next, "b", None)), ["fb", "p5", "n"]);
    let next = add_pin(&s, "n", "a", "https://n/", Some("N"), Arg::Str("f1"), Arg::Str("p3"));
    assert_eq!(ids(&pin_order(&next, "a", Some("f1"))), ["f2", "n", "p3"]);
    assert_eq!(&*pin(&next, "n").title, "N");
    let five = json!(5);
    let next = add_pin(&s, "n", "a", "https://n/", None, Arg::Value(&five), Arg::Undefined);
    assert_eq!(pin(&next, "n").folder_id, None, "a folder id that's no string: the top level");
    let next = add_pin(&s, "n", "a", "https://n/", None, Arg::Str("fb"), Arg::Undefined);
    assert_eq!(pin(&next, "n").folder_id, None, "another space's folder: the top level");
    // `folderId ? …`: '' is falsy, even with a folder of that id (stored data can have one).
    let odd = lib(json!({ "spaces": { "a": {} }, "folders": { "": { "spaceId": "a" } } }));
    let next = add_pin(&odd, "n", "a", "https://n/", None, Arg::Str(""), Arg::Undefined);
    assert_eq!(ids(&pin_order(&next, "a", None)), ["", "n"], "at the top, beside the folder ''");
}

#[test]
fn remove_and_bind_pins() {
    let s = tree();
    assert!(remove_pin(&s, "gone").same(&s));
    let next = remove_pin(&s, "p1");
    assert!(next.pins.iter().all(|p| *p.id != *"p1"));
    assert_eq!(
        (next.kept.get("t-1").unwrap().pinned_by.as_deref(), next.kept.get("t-2").unwrap().pinned_by.as_deref()),
        (None, None)
    );
    assert!(Rc::ptr_eq(next.kept.get("t-3").unwrap(), s.kept.get("t-3").unwrap()));
    assert_eq!(next.kept.keys().map(|k| &**k).collect::<Vec<_>>(), ["t-1", "t-2", "t-3"]);
    let next = remove_pin(&s, "p2");
    assert!(Rc::ptr_eq(&next.kept, &s.kept), "no item bound: the items as they were");
    assert!(unbind_pin_tab(&s, "p2").same(&s));

    assert!(bind_tab_to_pin(&s, "t-1", Some("p1")).same(&s), "bound so already");
    assert!(bind_tab_to_pin(&s, "t-gone", Some("p1")).same(&s));
    assert!(bind_tab_to_pin(&s, "t-3", None).same(&s));
    let next = bind_tab_to_pin(&s, "t-3", Some("p5"));
    assert_eq!(next.kept.get("t-3").unwrap().pinned_by.as_deref(), Some("p5"));
    assert_eq!(bind_tab_to_pin(&s, "t-1", None).kept.get("t-1").unwrap().pinned_by, None);
    let next = bind_tab_to_pin(&s, "t-3", Some(""));
    assert!(!next.same(&s) && next.kept.get("t-3").unwrap().pinned_by.is_none(), "'' isn't null: made anew, unbound");
}

#[test]
fn rename_pins_and_items() {
    let s = tree();
    let next = rename_pin(&s, "p1", Arg::Str("  My \n pin "));
    assert_eq!(pin(&next, "p1").custom_title.as_deref(), Some("My pin"));
    assert!(Rc::ptr_eq(pin(&next, "p2"), pin(&s, "p2")));
    assert!(rename_pin(&next, "p1", Arg::Str("My pin")).same(&next), "the same name");
    assert!(rename_pin(&s, "p1", Arg::Undefined).same(&s), "none, none");
    assert_eq!(rename_pin(&next, "p1", Arg::Str(" ")).pins.iter().find(|p| *p.id == *"p1").unwrap().custom_title, None);
    assert!(rename_pin(&s, "gone", Arg::Str("x")).same(&s));
    let n = json!(7);
    assert_eq!(pin(&rename_pin(&s, "p2", Arg::Value(&n)), "p2").custom_title.as_deref(), Some("7"));

    let next = rename_tab(&s, Arg::Str("t-3"), Arg::Str("Name"));
    assert_eq!(next.kept.get("t-3").unwrap().custom_title.as_deref(), Some("Name"));
    assert!(rename_tab(&s, Arg::Str("t-2"), Arg::Str("Mine")).same(&s));
    assert_eq!(rename_tab(&s, Arg::Str("t-2"), Arg::Str("")).kept.get("t-2").unwrap().custom_title, None);
    let list = json!(["t-3"]);
    assert!(rename_tab(&s, Arg::Value(&list), Arg::Str("x")).same(&s), "no string: an open tab's, none here");
}

#[test]
fn moving_a_pin() {
    let s = tree();
    let (five, null, zero) = (json!(5), json!(null), json!(0));
    assert!(move_pin(&s, Arg::Str("gone"), Arg::Undefined, Arg::Undefined).same(&s));
    assert!(move_pin(&s, Arg::Value(&five), Arg::Undefined, Arg::Undefined).same(&s));
    assert!(move_pin(&s, Arg::Str("p2"), Arg::Value(&five), Arg::Undefined).same(&s), "a truthy folder id, no string");
    assert!(move_pin(&s, Arg::Str("p2"), Arg::Str("fb"), Arg::Undefined).same(&s), "another space's folder");
    assert!(move_pin(&s, Arg::Str("p2"), Arg::Str("f-gone"), Arg::Undefined).same(&s));
    // Falsy: the top level, at the end.
    let next = move_pin(&s, Arg::Str("p2"), Arg::Value(&zero), Arg::Value(&null));
    assert_eq!(ids(&pin_order(&next, "a", None)), ["f1", "p1", "p4", "p2"]);
    assert_eq!(
        layout(&next)[..4],
        [
            ("p1".into(), None, Some(1.0)),
            ("p2".into(), None, Some(3.0)),
            ("p3".into(), Some("f1".into()), Some(0.0)),
            ("p4".into(), None, Some(2.0)),
        ],
        "p4 loose: its gone folder dropped as it's written"
    );
    // Into a folder, before an entry there; the level it left renumbered.
    let next = move_pin(&s, Arg::Str("p1"), Arg::Str("f1"), Arg::Str("f2"));
    assert_eq!(ids(&pin_order(&next, "a", Some("f1"))), ["p1", "f2", "p3"]);
    assert_eq!(ids(&pin_order(&next, "a", None)), ["p2", "f1", "p4"]);
    assert_eq!((pin(&next, "p4").pos, folder(&next, "f1").pos), (Some(2.0), Some(1.0)));
    // Before itself: where it is (nothing rewritten that's in its place).
    let next = move_pin(&s, Arg::Str("p3"), Arg::Str("f1"), Arg::Str("p3"));
    assert_eq!(pin(&next, "p3").pos, Some(1.0), "f2 0, p3 1");
    let next2 = move_pin(&next, Arg::Str("p3"), Arg::Str("f1"), Arg::Str("p3"));
    assert!(next2.same(&next));
}

#[test]
fn creating_a_folder() {
    let s = tree();
    let n = json!(null);
    assert!(create_folder(&s, "f9", "zz", Arg::Undefined, &[], None, Arg::Undefined).same(&s), "no such space");
    assert!(create_folder(&s, "f1", "a", Arg::Undefined, &[], None, Arg::Undefined).same(&s), "the id taken");
    assert!(create_folder(&s, "f9", "a", Arg::Undefined, &[], Some("fb"), Arg::Undefined).same(&s), "another space's");
    assert!(create_folder(&s, "f9", "a", Arg::Undefined, &[], Some("f4"), Arg::Undefined).same(&s), "4 deep");
    let next = create_folder(&s, "f9", "a", Arg::Undefined, &[], Some("f3"), Arg::Undefined);
    assert_eq!((folder(&next, "f9").parent_id.as_deref(), &*folder(&next, "f9").name), (Some("f3"), "New Folder"));
    assert_eq!(ids(&pin_order(&next, "a", Some("f3"))), ["f4", "f9"]);
    let next = create_folder(&s, "f9", "a", Arg::Value(&n), &["p1", "p5", "gone", "p3"], Some(""), Arg::Str("p1"));
    let f9 = folder(&next, "f9");
    assert_eq!((f9.parent_id.as_deref(), f9.open, &*f9.name), (None, true, "New Folder"));
    assert_eq!(ids(&pin_order(&next, "a", None)), ["p2", "f1", "f9", "p4"], "before p1, which went into it");
    assert_eq!(ids(&pin_order(&next, "a", Some("f9"))), ["p1", "p3"], "its space's pins, in order; p3 out of f1");
    assert_eq!(pin(&next, "p5").folder_id, None);
    // Only the space's pins are moved: with an id '' (falsy to movePin) another space's would go to its top level.
    let mut t = tree();
    Rc::make_mut(&mut t.pins)[4] = Rc::new(Pin { folder_id: Some("fb".into()), ..(*t.pins[4]).clone() });
    let next = create_folder(&t, "", "a", Arg::Undefined, &["p5"], None, Arg::Undefined);
    assert!(Rc::ptr_eq(pin(&next, "p5"), pin(&t, "p5")));
    assert_eq!(
        &*folder(&create_folder(&s, "f9", "a", Arg::Str(" Two "), &[], None, Arg::Undefined), "f9").name,
        "Two 2"
    );
}

#[test]
fn rename_and_open_folders() {
    let s = tree();
    let five = json!(5);
    assert!(rename_folder(&s, Arg::Str("f1"), Arg::Str(" One ")).same(&s), "the same name");
    assert!(rename_folder(&s, Arg::Str("f1"), Arg::Str("  ")).same(&s), "blank");
    assert!(rename_folder(&s, Arg::Value(&five), Arg::Str("x")).same(&s));
    let next = rename_folder(&s, Arg::Str("f1"), Arg::Value(&five));
    assert_eq!(&*folder(&next, "f1").name, "5");
    assert!(Rc::ptr_eq(folder(&next, "f2"), folder(&s, "f2")));
    assert!(set_folder_open(&s, Arg::Str("f1"), true).same(&s));
    assert!(set_folder_open(&s, Arg::Str("gone"), false).same(&s));
    assert!(!folder(&set_folder_open(&s, Arg::Str("f1"), false), "f1").open);
}

#[test]
fn moving_a_folder() {
    let s = tree();
    let (null, five, empty) = (json!(null), json!(5), json!(""));
    assert!(move_folder(&s, Arg::Str("gone"), Arg::Value(&null), Arg::Undefined).same(&s));
    assert!(move_folder(&s, Arg::Str("f1"), Arg::Str("f3"), Arg::Undefined).same(&s), "into its own subtree: a cycle");
    assert!(move_folder(&s, Arg::Str("f1"), Arg::Str("f1"), Arg::Undefined).same(&s), "into itself");
    assert!(move_folder(&s, Arg::Str("f2"), Arg::Str("fb"), Arg::Undefined).same(&s), "another space's");
    assert!(move_folder(&s, Arg::Str("f2"), Arg::Value(&five), Arg::Undefined).same(&s), "a parent that's no string");
    assert!(move_folder(&s, Arg::Str("f2"), Arg::Value(&empty), Arg::Undefined).same(&s), "'' isn't null: no such one");
    // Depth: f3 (2 levels) under f2 (depth 1) is 4 deep: refused under f3's own... a new folder at the top.
    let t = create_folder(&s, "g", "a", Arg::Undefined, &[], None, Arg::Undefined);
    let t = create_folder(&t, "g2", "a", Arg::Undefined, &[], Some("g"), Arg::Undefined);
    assert!(move_folder(&t, Arg::Str("f2"), Arg::Str("g2"), Arg::Undefined).same(&t), "3 levels under depth 1: 5");
    let moved = move_folder(&t, Arg::Str("f3"), Arg::Str("g2"), Arg::Undefined);
    assert_eq!(folder(&moved, "f3").parent_id.as_deref(), Some("g2"), "2 levels under depth 1: 4");
    // Out to the top before p1; the level it left renumbered.
    let next = move_folder(&s, Arg::Str("f2"), Arg::Value(&null), Arg::Str("p1"));
    assert_eq!(ids(&pin_order(&next, "a", None)), ["p2", "f1", "f2", "p1", "p4"]);
    assert_eq!(ids(&pin_order(&next, "a", Some("f1"))), ["p3"]);
    assert_eq!(pin(&next, "p3").pos, Some(0.0));
    // A parent '' (stored data can have a folder of that id): found, so moved, but '' written as no parent.
    let odd = lib(
        json!({ "spaces": { "a": {} }, "folders": { "": { "spaceId": "a", "pos": 0 }, "x": { "spaceId": "a", "pos": 1 } } }),
    );
    let next = move_folder(&odd, Arg::Str("x"), Arg::Value(&empty), Arg::Undefined);
    assert_eq!((folder(&next, "x").parent_id.as_deref(), folder(&next, "x").pos), (None, Some(0.0)));
    // Undefined: where it is, moved within its level.
    let next = move_folder(&s, Arg::Str("f2"), Arg::Undefined, Arg::Undefined);
    assert_eq!(ids(&pin_order(&next, "a", Some("f1"))), ["p3", "f2"]);
    assert!(move_folder(&next, Arg::Str("f2"), Arg::Undefined, Arg::Undefined).same(&next));
}

#[test]
fn delete_folder_puts_what_it_held_in_its_place() {
    let s = tree();
    assert!(delete_folder(&s, Arg::Str("gone")).same(&s));
    let next = delete_folder(&s, Arg::Str("f1"));
    assert!(next.folders.iter().all(|f| *f.id != *"f1"));
    assert_eq!(ids(&pin_order(&next, "a", None)), ["p2", "f2", "p3", "p1", "p4"]);
    assert_eq!((pin(&next, "p3").folder_id.as_deref(), folder(&next, "f2").parent_id.as_deref()), (None, None));
    let next = delete_folder(&s, Arg::Str("f3"));
    assert_eq!(ids(&pin_order(&next, "a", Some("f2"))), ["f4"]);
    assert_eq!(folder(&next, "f4").parent_id.as_deref(), Some("f2"));
}
