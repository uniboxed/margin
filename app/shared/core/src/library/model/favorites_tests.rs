// favorites.rs against model.ts and pinned-rules.ts (M:1460-1591, PR favoriteScopeOf), read line by line: a scope's
// order, its cap and duplicates, names, bindings. The shared vectors' steps of the actions over them run through the
// real actions (actions_tests.rs).

use super::*;
use crate::library::js::CodePointOrder;
use crate::library::state::state_of;
use serde_json::{Value, json};

fn lib(v: Value) -> LibState {
    state_of(v.as_object().unwrap(), &CodePointOrder)
}

fn ids(s: &LibState) -> Vec<(&str, &str, f64)> {
    s.favorites.iter().map(|f| (&*f.id, scope_of(f), f.pos.unwrap_or(f64::NAN))).collect()
}

fn favs() -> LibState {
    lib(json!({
        "spaces": { "a": { "name": "A", "order": 0, "profile": "Work" }, "b": { "name": "B", "order": 1 } },
        "favorites": {
            "fav-1": { "url": "https://1/", "pos": 1 },
            "fav-2": { "url": "https://2/", "pos": 0 },
            "fav-3": { "url": "https://3/", "scope": "profile:Work", "pos": 0 },
            "fav-4": { "url": "https://4/", "pos": 2 },
        },
        "tabs": {
            "t-1": { "url": "https://1/", "spaceId": "a", "favoriteId": "fav-1", "pinnedBy": "p-1", "lastUsed": 3 },
            "t-2": { "url": "https://1/", "spaceId": "b", "favoriteId": "fav-1", "lastUsed": 3 },
            "t-0": { "url": "https://1/", "spaceId": "b", "favoriteId": "fav-1", "lastUsed": 4 },
            "t-3": { "url": "https://3/", "spaceId": "a" },
        },
    }))
}

fn new<'a>(id: &'a str, url: &'a str) -> NewFavorite<'a> {
    NewFavorite { id, scope: "global", url, title: "", custom_title: None, target: None, before_id: Arg::Undefined }
}

#[test]
fn scopes() {
    let s = favs();
    assert_eq!(favorite_scope_of(&s, Some("a"), false), "global", "everyone's unless per profile");
    assert_eq!(favorite_scope_of(&s, Some("a"), true), "profile:Work");
    assert_eq!(favorite_scope_of(&s, Some("b"), true), "profile:default", "the default profile");
    assert_eq!(favorite_scope_of(&s, None, true), "profile:default");
    assert_eq!(favorite_scope_of(&s, Some(""), true), "profile:default");
    assert_eq!(favorite_scope_of(&s, Some("zz"), true), "profile:default");
    // (`stateOf` never reads an empty profile; a rule could write one.)
    let mut blank = s.clone();
    let mut sp = (*blank.spaces[0]).clone();
    sp.profile = Some("".into());
    Rc::make_mut(&mut blank.spaces)[0] = Rc::new(sp);
    assert_eq!(favorite_scope_of(&blank, Some("a"), true), "profile:default", "an empty profile: the default");
    let mut f = (*s.favorites[0]).clone();
    f.scope = "".into();
    assert_eq!(scope_of(&f), "global");
}

#[test]
fn addresses_a_favorite_can_have() {
    let app = LibTarget::App { bundle_id: "com.apple.Notes".into(), name: "Notes".into() };
    let web = LibTarget::safari();
    let margin = LibTarget::Margin { page: "settings".into() };
    assert!(favorite_url_ok("https://a.com", None) && favorite_url_ok("HTTP://a", Some(&web)));
    assert!(!favorite_url_ok("https://a.com", Some(&app)), "a web address with an app's target");
    assert!(
        !favorite_url_ok("https:///a", None)
            && !favorite_url_ok("https:// a", None)
            && !favorite_url_ok("https://", None)
    );
    assert!(!favorite_url_ok("ftp://a", None) && !favorite_url_ok("margin://settings", Some(&margin)));
    assert!(favorite_url_ok("app://com.apple.Notes", Some(&app)));
    assert!(!favorite_url_ok("app://com.apple.Mail", Some(&app)) && !favorite_url_ok("app://com.apple.Notes", None));
}

#[test]
fn a_scope_renumbered_and_a_favorites_items() {
    let s = favs();
    let r = renumber_favorites(&s.favorites, "global");
    assert_eq!(
        r.iter().map(|f| (&*f.id, f.pos)).collect::<Vec<_>>(),
        [("fav-1", Some(0.0)), ("fav-2", Some(1.0)), ("fav-3", Some(0.0)), ("fav-4", Some(2.0))],
        "in the list's order, the others as they were"
    );
    assert!(Rc::ptr_eq(&r[3], &s.favorites[3]) && Rc::ptr_eq(&r[2], &s.favorites[2]));
    let kept = kept_of_favorite(&s, "fav-1", &CodePointOrder);
    assert_eq!(kept.iter().map(|k| &*k.id).collect::<Vec<_>>(), ["t-0", "t-1", "t-2"], "used last first, then the ids");
    assert!(kept_of_favorite(&s, "fav-9", &CodePointOrder).is_empty());
}

#[test]
fn adding_a_favorite() {
    let s = favs();
    assert!(add_favorite(&s, new("fav-n", "ftp://x")).same(&s), "not an address a favorite has");
    assert!(add_favorite(&s, new("fav-n", "https://2/")).same(&s), "its scope has it");
    let other_scope = add_favorite(&s, NewFavorite { scope: "profile:Work", ..new("fav-n", "https://2/") });
    assert!(!other_scope.same(&s), "another scope's address");
    assert!(
        add_favorite(&s, new("fav-n", "https://2")).same(&s),
        "its scope has it: `https://2/`, as the browsers parse it"
    );
    assert!(
        add_favorite(&s, new("fav-n", "HTTPS://2:443/#x")).same(&s),
        "the host's case, the default port, a fragment"
    );
    let added = add_favorite(&s, new("fav-n", "https://2/x"));
    assert_eq!(
        ids(&added),
        [
            ("fav-3", "profile:Work", 0.0),
            ("fav-2", "global", 0.0),
            ("fav-1", "global", 1.0),
            ("fav-4", "global", 2.0),
            ("fav-n", "global", 3.0)
        ],
        "the others first, then the scope in its order, the new one last: `https://2/x` is another address"
    );
    let n = added.favorites.last().unwrap();
    assert_eq!(
        (&*n.title, n.custom_title.as_deref(), n.target.is_none()),
        ("https://2/x", None, true),
        "no title: the address"
    );
    let before = add_favorite(
        &s,
        NewFavorite {
            title: "Mine",
            custom_title: Some(&format!(" {}😀x ", "a".repeat(39))),
            target: Some(LibTarget::safari()),
            before_id: Arg::Str("fav-1"),
            ..new("fav-n", "https://9/")
        },
    );
    assert_eq!(
        before.favorites.iter().map(|f| &*f.id).collect::<Vec<_>>(),
        ["fav-3", "fav-2", "fav-n", "fav-1", "fav-4"]
    );
    let n = before.favorites.iter().find(|f| *f.id == *"fav-n").unwrap();
    assert_eq!(
        (&*n.title, n.custom_title.as_deref()),
        ("Mine", Some(&*"a".repeat(39))),
        "trimmed, cut at 40: the emoji's broken half dropped"
    );
    assert!(n.target.is_some());
    let blank = add_favorite(
        &s,
        NewFavorite { custom_title: Some(" \u{feff} "), before_id: Arg::Str(""), ..new("fav-n", "https://9/") },
    );
    assert_eq!(blank.favorites.last().unwrap().custom_title, None, "only spaces: none");
    assert_eq!(&*blank.favorites.last().unwrap().id, "fav-n", "an empty before: the end");
    let five = json!(5);
    let odd = add_favorite(&s, NewFavorite { before_id: Arg::Value(&five), ..new("fav-n", "https://9/") });
    assert_eq!(&*odd.favorites.last().unwrap().id, "fav-n", "a before that's no string: the end");

    let mut full = s.clone();
    for i in 0..9 {
        let id = format!("fav-x{i}");
        let url = format!("https://x{i}/");
        full = add_favorite(&full, new(&id, &url));
    }
    assert_eq!(full.favorites.iter().filter(|f| scope_of(f) == "global").count(), FAVORITES_CAP);
    assert!(add_favorite(&full, new("fav-y", "https://y/")).same(&full), "a 13th");
    assert!(!add_favorite(&full, NewFavorite { scope: "profile:Work", ..new("fav-y", "https://y/") }).same(&full));
}

#[test]
fn removing_and_moving_a_favorite() {
    let s = favs();
    assert!(remove_favorite(&s, "fav-9").same(&s));
    let r = remove_favorite(&s, "fav-2");
    assert_eq!(ids(&r), [("fav-1", "global", 0.0), ("fav-3", "profile:Work", 0.0), ("fav-4", "global", 1.0)]);
    assert!(Rc::ptr_eq(&r.kept, &s.kept), "no item was its");
    let r = remove_favorite(&s, "fav-1");
    assert!(r.kept.values().all(|k| k.favorite_id.is_none()), "its items no longer its");
    assert_eq!(r.kept.get("t-1").unwrap().pinned_by.as_deref(), Some("p-1"), "the rest kept");

    assert!(move_favorite(&s, "fav-9".into(), Arg::Undefined).same(&s));
    assert!(move_favorite(&s, "fav-4".into(), Arg::Undefined).same(&s), "already last");
    assert!(move_favorite(&s, "fav-1".into(), "fav-4".into()).same(&s), "already before it");
    assert!(move_favorite(&s, "fav-3".into(), "fav-1".into()).same(&s), "a favorite of another scope: its own end");
    let m = move_favorite(&s, "fav-4".into(), "fav-2".into());
    assert_eq!(
        ids(&m),
        [("fav-3", "profile:Work", 0.0), ("fav-4", "global", 0.0), ("fav-2", "global", 1.0), ("fav-1", "global", 2.0)]
    );
    let listed = json!(["fav-2"]);
    assert!(move_favorite(&s, Arg::Value(&listed), Arg::Undefined).same(&s), "an id that's no string: none's (`===`)");
    let blank = lib(
        json!({ "favorites": { "": { "url": "https://0/", "pos": 0 }, "fav-1": { "url": "https://1/", "pos": 1 } } }),
    );
    let m = move_favorite(&blank, "fav-1".into(), "".into());
    assert!(
        m.same(&blank),
        "an empty before is falsy: the end, where it is (not before the favorite whose id is empty)"
    );
    let m = move_favorite(&s, "fav-2".into(), "fav-2".into());
    assert_eq!(
        m.favorites.iter().map(|f| &*f.id).collect::<Vec<_>>(),
        ["fav-3", "fav-1", "fav-4", "fav-2"],
        "before itself: the end"
    );
}

#[test]
fn naming_and_binding_a_favorite() {
    let s = favs();
    assert!(rename_favorite(&s, "fav-9", Arg::Str("X")).same(&s));
    assert!(rename_favorite(&s, "fav-1", Arg::Undefined).same(&s), "no name, none given");
    assert!(rename_favorite(&s, "fav-1", Arg::Str(" \t ")).same(&s));
    let named = rename_favorite(&s, "fav-1", Arg::Str("  my \n\u{a0} news  "));
    assert_eq!(named.favorites[0].custom_title.as_deref(), Some("my news"), "spaces squashed and trimmed");
    assert!(Rc::ptr_eq(&named.favorites[1], &s.favorites[1]));
    assert!(rename_favorite(&named, "fav-1", Arg::Str("my  news")).same(&named), "the name it has");
    assert_eq!(
        rename_favorite(&named, "fav-1", Arg::Undefined).favorites[0].custom_title,
        None,
        "not a string: its name removed"
    );
    // A cut through an emoji: JS's name ends in half of it, which the stored name (`stateOf` never reads half a pair)
    // never equals, so it renames (the same name, its half dropped): not the state itself.
    let a39 = "a".repeat(39);
    let held = rename_favorite(&s, "fav-1", Arg::Str(&a39));
    let cut = rename_favorite(&held, "fav-1", Arg::Str(&format!("{a39}😀tail")));
    assert!(!cut.same(&held) && cut.favorites[0].custom_title.as_deref() == Some(&*a39));
    assert!(rename_favorite(&held, "fav-1", Arg::Str(&format!(" {a39} "))).same(&held), "a cut that breaks nothing");
    let long = rename_favorite(&s, "fav-1", Arg::Str(&"é".repeat(50)));
    assert_eq!(long.favorites[0].custom_title.as_deref(), Some(&*"é".repeat(40)));

    assert!(bind_tab_to_favorite(&s, "t-3", "fav-9").same(&s), "no such favorite");
    assert!(bind_tab_to_favorite(&s, "t-9", "fav-3").same(&s), "no such item");
    assert!(bind_tab_to_favorite(&s, "t-1", "fav-1").same(&s), "its already");
    let b = bind_tab_to_favorite(&s, "t-1", "fav-3");
    let k = b.kept.get("t-1").unwrap();
    assert_eq!((k.favorite_id.as_deref(), k.pinned_by.as_deref()), (Some("fav-3"), None), "a favorite's is no pin's");
    assert_eq!(b.kept.keys().map(|k| &**k).collect::<Vec<_>>(), s.kept.keys().map(|k| &**k).collect::<Vec<_>>());

    assert!(unbind_favorite_tab(&s, "fav-3").same(&s));
    let u = unbind_favorite_tab(&s, "fav-1");
    assert!(u.kept.values().all(|k| k.favorite_id.is_none()));
    assert!(Rc::ptr_eq(u.kept.get("t-3").unwrap(), s.kept.get("t-3").unwrap()));
}
