//! The loading bar, the copies' messages, the UI's numbers, requests and rows (loading.rs, route.rs, ui.rs) through
//! the re-entrant test adapter, pinned as T/hosted-tests.swift reads them (the loading bar's numbers, the mini player's
//! window, the UI's requests' routes); the same are compared against the deleted Swift on generated sequences in the
//! step's harness.

use super::*;

fn acts(world: &World) -> Vec<Value> {
    std::mem::take(&mut *world.acts.borrow_mut())
}

fn named(acts: &[Value], name: &str) -> Vec<Value> {
    acts.iter().filter(|a| a[0] == json!(name)).cloned().collect()
}

fn item(lib: &TestLibrary, id: &str, v: Value) {
    lib.put("tabs", id, v);
}

fn message(s: &Session, profile: &str, window: Option<i64>, msg: Value) -> Out {
    s.copy_message("safari", profile, window, msg.to_string().as_bytes())
}

#[test]
fn the_loading_bar_by_the_uis_numbers_for_the_hosting_window_only() {
    let (s, world, _) = session();
    world.windows.borrow_mut().push(2);
    set(
        &s,
        json!({ "hostingWindow": { "put": [[1]] }, "shown": { "put": [[1, "a"]] },
                "open": { "put": [["a", "safari:s-default", "s-default"], ["b", "safari:s-default", "s-default"], ["x", "app:com.x", null]] },
                "safariWindows": { "put": [["s-default", "main", 90], ["s-default", "card", 91]] },
                "safariTabs": { "put": [["a", 500], ["b", 501]] }, "labels": { "put": [["app:com.x", "X"]] } }),
    );
    let na = s.number("a");
    // (Another window's, or a card's: not the main window's tabs.)
    message(&s, "s-default", Some(91), json!({ "type": "loading", "tabIds": [500] }));
    message(&s, "s-default", None, json!({ "type": "loading", "tabIds": [500] }));
    assert!(named(&acts(&world), "setLoadingTabs").is_empty());
    message(&s, "s-default", Some(90), json!({ "type": "loading", "tabIds": [501, 500, 500, 2.5, true] }));
    let nb = s.number("b");
    assert_eq!(named(&acts(&world), "setLoadingTabs"), [json!(["setLoadingTabs", 1, [na, nb]])]);
    message(&s, "s-default", Some(90), json!({ "type": "loading", "tabIds": [500, 501] }));
    assert!(acts(&world).is_empty(), "the same tabs: nothing again");
    // The engine's slow step for an app: its loader with its name and icon, its item's number on the bar.
    set(&s, json!({ "showing": { "put": [["app:com.x", "x"]] } }));
    s.loading(Some("app:com.x"));
    let nx = s.number("x");
    let a = acts(&world);
    assert_eq!(named(&a, "setLoading"), [json!(["setLoading", 1, "X", "com.x"])]);
    assert_eq!(named(&a, "setLoadingTabs"), [json!(["setLoadingTabs", 1, [na, nb, nx]])]);
    s.loading(None);
    let a = acts(&world);
    assert_eq!(named(&a, "setLoading"), [json!(["setLoading", 1, null, null])]);
    // A Safari host with no label: its logged form; its icon Safari's.
    s.loading(Some("safari:s-work"));
    assert_eq!(named(&acts(&world), "setLoading")[0][3], json!("com.apple.Safari"));
    s.loading(None);
    acts(&world);
    // Hosting moves: the window told before told none.
    set(&s, json!({ "hostingWindow": { "put": [[2]] } }));
    s.refresh_loading();
    assert_eq!(
        named(&acts(&world), "setLoadingTabs"),
        [json!(["setLoadingTabs", 1, []]), json!(["setLoadingTabs", 2, [na, nb]])]
    );
    // A card window's slow step: the card's own loader, nothing else; over, the same.
    s.loading(Some("safari:s-default#card"));
    s.loading(None);
    assert!(acts(&world).is_empty(), "the card's loader is its own");
    s.loading(None);
    assert_eq!(
        named(&acts(&world), "setLoading"),
        [json!(["setLoading", 2, null, null])],
        "then the page card's again"
    );
    assert!(world.reentries.get() > 0);
}

#[test]
fn a_panes_own_loader_kept_until_its_reveal_is_let_go() {
    let (s, world, lib) = session();
    item(&lib, "p", json!({ "title": "Pane page" }));
    set(
        &s,
        json!({ "hostingWindow": { "put": [[1]] }, "panesLaying": { "put": [[1, "safari:s-default#pane1", "p"], [1, "app:com.n", "n"]] },
                "revealHeld": { "put": [[1]] }, "labels": { "put": [["app:com.n", "Notes"]] } }),
    );
    s.loading(Some("safari:s-default#pane1"));
    let a = acts(&world);
    assert_eq!(named(&a, "setPaneLoading"), [json!(["setPaneLoading", 1, "p", "Pane page", "com.apple.Safari"])]);
    assert_eq!(named(&a, "setLoading"), [json!(["setLoading", 1, null, null])], "never the page area's loader");
    s.loading(None);
    assert!(named(&acts(&world), "setPaneLoading").is_empty(), "held while its reveal is");
    s.core().release_reveal(1);
    assert_eq!(named(&acts(&world), "setPaneLoading"), [json!(["setPaneLoading", 1, null, null, null])]);
    s.loading(Some("app:com.n"));
    assert_eq!(named(&acts(&world), "setPaneLoading"), [json!(["setPaneLoading", 1, "n", "Notes", "com.n"])]);
    // (Its slow step still under way: the reveal let go keeps it.)
    set(&s, json!({ "revealHeld": { "put": [[1]] } }));
    s.core().release_reveal(1);
    assert!(named(&acts(&world), "setPaneLoading").is_empty());
}

fn media(sources: Value) -> Value {
    json!({ "type": "media", "evil": "<script>", "sources": sources })
}

#[test]
fn the_mini_players_window_and_its_standing_push_taken_back() {
    let (s, world, lib) = session();
    world.windows.borrow_mut().push(2);
    item(&lib, "a", json!({ "url": "https://a.example/", "spaceId": "work" }));
    item(&lib, "b", json!({ "url": "https://b.example/", "spaceId": "home" }));
    lib.put("windows", "2", json!({ "spaceId": "work" }));
    set(
        &s,
        json!({ "hostingWindow": { "put": [[1]] }, "open": { "put": [["a", "safari:s-default", "s-default"], ["b", "safari:s-default", "s-default"]] },
                "safariWindows": { "put": [["s-default", "main", 90], ["s-default", "pane1", 92]] }, "safariTabs": { "put": [["b", 600]] } }),
    );
    // Its item's space shown in window 2: there, its tab by the UI's number, only the fields passed on.
    message(&s, "s-default", Some(92), media(json!([{ "tabId": 500, "itemId": "a", "playing": true }])));
    let a = acts(&world);
    let pushed = named(&a, "push");
    assert_eq!(pushed.len(), 1);
    assert_eq!(pushed[0][1], json!(2));
    let page: Value = serde_json::from_str(pushed[0][2].as_str().unwrap_or("")).unwrap_or_default();
    assert_eq!(page["type"], json!("media"));
    assert_eq!(page["sources"][0]["tabId"], json!(s.number("a")));
    assert!(page.get("evil").is_none());
    assert_eq!(s.core().read(|st| st.safari_tabs.get("a").copied()), Some(500), "the tab kept as its item's");
    // Another item's, its space shown nowhere: the hosting window's; window 2 given the empty one first.
    message(&s, "s-default", Some(90), media(json!([{ "tabId": 600, "playing": true }])));
    let pushed = named(&acts(&world), "push");
    assert_eq!(pushed.iter().map(|p| p[1].clone()).collect::<Vec<_>>(), [json!(2), json!(1)]);
    assert_eq!(
        serde_json::from_str::<Value>(pushed[0][2].as_str().unwrap_or("")).unwrap_or_default()["sources"],
        json!([])
    );
    // By its address, without its fragment and its last slash; another profile's window, a card push, a state push.
    message(
        &s,
        "s-default",
        Some(90),
        media(json!([{ "tabId": 777, "url": "https://b.example#t=3", "playing": true }])),
    );
    assert_eq!(named(&acts(&world), "push").len(), 1);
    assert_eq!(s.core().read(|st| st.safari_tabs.get("b").copied()), Some(777));
    message(&s, "s-work", Some(90), media(json!([])));
    message(&s, "s-default", Some(90), json!({ "type": "state" }));
    s.copy_message("chrome", "s-default", Some(90), br#"{"type":"media"}"#);
    assert!(named(&acts(&world), "push").is_empty());
    // (The card's pushes: card.rs's own, no Swift hop: a cancel and a key with no card do nothing.)
    message(&s, "s-default", Some(90), json!({ "type": "peekCancel", "id": "x" }));
    message(&s, "s-default", Some(90), json!({ "type": "cardKey", "key": "Escape" }));
    assert!(named(&acts(&world), "swift").is_empty());
    let out = s.copy_message("safari", "s-default", Some(90), b"[1]");
    assert!(out.log.first().is_some_and(|l| l.warn), "not an object: said once");
    // A window closed: its standing push forgotten (no empty one sent to it again).
    s.input(&json!({ "type": "loadingForget", "window": 1, "standing": true }));
    message(&s, "s-default", Some(92), media(json!([{ "tabId": 500, "itemId": "a" }])));
    assert_eq!(named(&acts(&world), "push").iter().map(|p| p[1].clone()).collect::<Vec<_>>(), [json!(2)]);
}

#[test]
fn the_copys_tabs_sound_drawn_again_only_on_change() {
    let (s, world, _) = session();
    set(
        &s,
        json!({ "open": { "put": [["a", "safari:s-default", "s-default"]] }, "safariTabs": { "put": [["a", 500]] } }),
    );
    let tabs = |v: Value| json!({ "tabs": v }).to_string();
    s.copy_tabs("s-default", tabs(json!({ "500": { "audible": true, "muted": 1 } })).as_bytes());
    assert_eq!(acts(&world), [json!(["changed"])]);
    assert_eq!(s.core().read(|st| st.safari_audio.get("a").copied()), Some((true, true)));
    s.copy_tabs("s-default", tabs(json!({ "500": { "audible": true, "muted": true } })).as_bytes());
    s.copy_tabs("s-work", tabs(json!({ "500": {} })).as_bytes());
    s.copy_tabs("s-default", b"{\"tabs\":5}");
    assert!(acts(&world).is_empty());
    s.copy_tabs("s-default", tabs(json!({})).as_bytes());
    assert_eq!(acts(&world), [json!(["changed"])]);
    assert_eq!(s.core().read(|st| st.safari_audio.get("a").copied()), None);
    assert_eq!(s.drawn_windows("safari", "s-default"), Vec::<i64>::new());
    set(
        &s,
        json!({ "safariWindows": { "put": [["s-default", "main", 90], ["s-default", "card", 91], ["s-work", "main", 93]] } }),
    );
    assert_eq!(s.drawn_windows("safari", "s-default"), [90, 91]);
    assert!(s.drawn_windows("chrome", "s-default").is_empty());
}

fn ui(s: &Session, kind: &str, payload: Value) -> Value {
    s.input(&json!({ "type": "ui", "kind": kind, "payload": payload })).reply.unwrap_or_default()
}

#[test]
fn the_uis_requests_routed() {
    let (s, world, _) = session();
    set(&s, json!({ "shown": { "put": [[1, "a"]] }, "open": { "put": [["a", "app:com.a", null]] } }));
    let n = s.number("a");
    let r = ui(&s, "closeTab", json!({ "windowId": 1, "tabId": n, "nextTo": n, "hint": "x" }));
    assert_eq!(
        r,
        json!({ "route": "perform", "action": "closeTab", "payload": { "windowId": 1, "tabId": "a", "nextTo": "a" } })
    );
    assert_eq!(
        ui(&s, "pinTab", json!({ "tabId": 99 }))["payload"]["tabId"],
        json!(99),
        "a number never given: as it came"
    );
    assert_eq!(ui(&s, "updateSettings", json!({ "x": 1 }))["route"], json!("settings"));
    // A theme imported or linked: the shell's, for the window that asked (docs/THEME-STORE.md §1), never the library's.
    for name in [
        "theme.import",
        "theme.link",
        "theme.save",
        "theme.remove",
        "theme.unlink",
        "theme.store.open",
        "theme.store.try",
        "theme.store.report",
        "theme.share",
    ] {
        assert_eq!(
            ui(&s, name, json!({ "windowId": 3, "id": "mine" })),
            json!({ "route": "theme", "name": name, "payload": { "windowId": 3, "id": "mine" }, "window": 3 }),
            "{name}"
        );
    }
    assert_eq!(ui(&s, "theme.other", json!({}))["route"], json!("perform"), "only those five");
    assert_eq!(
        ui(&s, "copyUrl", json!({ "url": "https://a/" })),
        json!({ "route": "answer", "value": { "ok": true, "result": true }, "pasteboard": "https://a/" })
    );
    assert_eq!(ui(&s, "copyUrl", json!({ "url": "" })).get("pasteboard"), None);
    assert_eq!(
        ui(&s, "app.open", json!({ "bundleId": "not one" }))["value"],
        json!({ "ok": false, "error": "not a bundle id" })
    );
    // (An engine an older Margin stored: never read; none named by macOS: Google's.)
    *world.settings.borrow_mut() =
        json!({ "favoritesScope": "profile", "safariSearch": { "template": "https://d.example/?q=%s" } });
    let r = ui(&s, "search", json!({ "windowId": 1, "query": " \u{3000}a b\n" }));
    assert_eq!(
        r,
        json!({ "route": "perform", "action": "newTab", "payload": { "windowId": 1, "url": "https://www.google.com/search?client=safari&rls=en&q=a%20b&ie=UTF-8&oe=UTF-8", "title": "a b" } })
    );
    assert_eq!(ui(&s, "search", json!({ "query": " " })), json!({ "route": "none" }));
    let r = ui(&s, "addFavorite", json!({ "windowId": 1, "tabId": n, "scope": "profile:evil", "favoritesScope": "x" }));
    assert_eq!(r["payload"], json!({ "windowId": 1, "tabId": "a", "favoritesScope": "profile" }));
    *world.settings.borrow_mut() = Value::Null;
    assert_eq!(ui(&s, "addFavorite", json!({}))["payload"]["favoritesScope"], json!("global"));
    assert_eq!(
        ui(&s, "sidebarScroll", json!({})),
        json!({ "route": "answer", "value": { "ok": true, "result": null } })
    );
    acts(&world);
    // ⌘W: the card's first (card.rs's: none here), else the item shown there.
    assert_eq!(ui(&s, "closeTab", json!({ "windowId": 1 }))["payload"]["tabId"], json!("a"));
    assert_eq!(ui(&s, "closeTab", json!({ "windowId": 2 })), json!({ "route": "none" }));
    assert_eq!(ui(&s, "peek.close", json!({ "windowId": 1 }))["value"], json!({ "ok": true, "result": true }));
    assert_eq!(
        ui(&s, "peek.go", json!({ "windowId": 1, "query": " " }))["value"],
        json!({ "ok": false, "error": "no address" })
    );
    // The launcher and the start screen's choices: the core's own flows (start.rs), no Swift asked.
    ui(&s, "openLauncher", json!({ "windowId": 1, "settings": 1 }));
    ui(&s, "startup.retry", json!({}));
    assert!(named(&acts(&world), "swift").is_empty());
    s.tick(0.0);
    let settings: Vec<Value> = acts(&world).into_iter().filter(|a| a[0] == json!("perform")).collect();
    assert_eq!(settings, [json!(["perform", "openMarginPage", { "windowId": 1, "page": "settings" }])]);
    s.tick(0.0);
    // The history's in the queue (navigate), an app's open at once (its flow's first part in the call).
    set(&s, json!({ "open": { "put": [["a", "safari:p", "p"]] } }));
    let out = s.input(&json!({ "type": "ui", "kind": "goBack", "payload": { "windowId": 1 } }));
    assert!(out.ready && out.start.is_empty());
    s.tick(0.0);
    let out = s.input(&json!({ "type": "ui", "kind": "app.open", "payload": { "bundleId": "com.b", "windowId": 1 } }));
    let next = s.tick(0.0);
    assert!(
        !out.start.is_empty() || !next.start.is_empty() || s.done().iter().any(|l| l.starts_with("com.b")),
        "openApp run: {:?}",
        s.done()
    );
}

#[test]
fn the_rows_the_ui_draws_numbered_in_order_of_first_use() {
    let (s, world, _) = session();
    set(
        &s,
        json!({ "hostingWindow": { "put": [[2]] }, "shown": { "put": [[2, "c"]] }, "requested": { "put": [[2, "b"]] },
                "open": { "put": [["c", "app:com.c", null], ["a", "safari:p", "p"]] }, "marginOpen": { "put": [["m"]] },
                "safariAudio": { "put": [["a", true, false]] }, "safariMuted": { "put": [["c"]] } }),
    );
    let layout = json!({ "layouts": { "put": [[2, "c", null, [["b", "pane", [0, 0, 10, 10]], ["z", "pane", [0, 0, 10, 10]]], "c", null]] } });
    set(&s, layout);
    let _ = &world;
    let (w, rows) = s.live_plan(&mut |i| i != "m").unwrap_or_default();
    assert_eq!(w, 2);
    let got: Vec<(String, i64, i64, bool, bool, bool, bool)> =
        rows.iter().map(|r| (r.item.clone(), r.number, r.index, r.active, r.visible, r.audible, r.muted)).collect();
    assert_eq!(
        got,
        [
            ("a".into(), 1, 0, false, false, true, false),
            ("b".into(), 2, 1, true, false, false, false),
            ("c".into(), 3, 2, false, true, false, true),
        ]
    );
    assert_eq!((s.open_row("a"), s.open_row("b"), s.open_row("m")), (Some(1), None, None));
    assert_eq!(s.item_of_tab(3).as_deref(), Some("c"));
    // Nothing open: nothing asked, nothing numbered.
    let (s, world, _) = session();
    assert_eq!(s.live_plan(&mut |_| panic!("not asked")), None);
    assert!(acts(&world).is_empty());
}

#[test]
fn what_a_window_draws_is_the_librarys_snapshot_with_the_open_items_as_tabs() {
    // The library's items (`t-` ids, as the rules keep them), three open, one not kept (Margin's own page `m`).
    let (s, _, lib) = session();
    for (id, space) in [("t-a", "home"), ("t-b", "home"), ("t-c", "work"), ("t-d", "home")] {
        lib.put(
            "tabs",
            id,
            json!({ "url": format!("https://{id}.example/"), "title": id, "spaceId": space, "order": 1 }),
        );
    }
    let text = lib.lib.snapshot().text.clone();
    assert_eq!(s.state_text(&lib.lib, ""), text, "nothing open: the snapshot as it is");
    set(
        &s,
        json!({ "hostingWindow": { "put": [[2]] }, "shown": { "put": [[2, "t-c"]] }, "requested": { "put": [[2, "t-b"]] },
                "open": { "put": [["t-c", "app:com.c", null], ["t-a", "safari:p", "p"]] }, "marginOpen": { "put": [["m"]] },
                "safariAudio": { "put": [["t-a", true, false]] } }),
    );
    // (An edit first: this draw is the first to make the new revision's snapshot.)
    lib.put("tabs", "t-e", json!({ "url": "https://t-e.example/", "title": "t-e", "spaceId": "home", "order": 2 }));
    let drawn: Value = serde_json::from_str(&s.state_text(&lib.lib, r#""settings":{"a":1},"favicons":{}"#)).unwrap();
    let open = &drawn["openTabs"];
    let numbers: Vec<i64> = ["t-a", "t-b", "t-c"].iter().map(|i| s.number(i)).collect();
    assert_eq!(open["tabs"].as_object().map(|t| t.len()), Some(3), "{open}");
    let tab = |n: i64| &open["tabs"][n.to_string()];
    assert_eq!(tab(numbers[0])["audible"], json!(true));
    assert_eq!((tab(numbers[1])["active"].clone(), tab(numbers[1])["mid"].clone()), (json!(true), json!("t-b")));
    assert_eq!(
        (tab(numbers[2])["windowId"].clone(), open["tabSpace"][numbers[2].to_string()].clone()),
        (json!(2), json!("work"))
    );
    assert_eq!(
        open["keptTabs"].as_object().map(|k| k.keys().cloned().collect::<Vec<_>>()),
        Some(vec!["t-d".to_string(), "t-e".to_string()])
    );
    assert_eq!((drawn["settings"].clone(), drawn["favicons"].clone()), (json!({ "a": 1 }), json!({})));
}

#[test]
fn the_palettes_engine_and_suggestions() {
    let (s, world, _) = session();
    let engine = |id: Value, name: Value| {
        s.input(&json!({ "type": "searchEngine", "identifier": id, "name": name })).reply.unwrap_or_default()
    };
    // No engine named yet: no suggestions, the search to Google's (an engine an older Margin stored: never read).
    *world.settings.borrow_mut() = json!({ "safariSearch": { "template": "https://d.example/?q=%s" } });
    assert_eq!(
        ui(&s, "search.suggest", json!({ "windowId": 1, "query": "we" })),
        json!({ "route": "suggest", "value": { "ok": true, "result": { "engine": null, "on": true, "items": [] } } })
    );
    assert_eq!(
        ui(&s, "search", json!({ "windowId": 1, "query": "a" }))["payload"]["url"],
        json!("https://www.google.com/search?client=safari&rls=en&q=a&ie=UTF-8&oe=UTF-8")
    );
    // macOS names DuckDuckGo: the search and the suggestions its.
    assert_eq!(
        engine(json!("com.duckduckgo"), json!("DuckDuckGo")),
        json!({ "engine": { "id": "duckduckgo", "name": "DuckDuckGo" } })
    );
    assert_eq!(
        ui(&s, "search", json!({ "windowId": 1, "query": "a b" }))["payload"]["url"],
        json!("https://duckduckgo.com/?q=a%20b&t=osx&ia=web")
    );
    assert_eq!(
        ui(&s, "peek.go", json!({ "windowId": 1, "query": "x" }))["value"]["ok"],
        json!(true),
        "the card's search too"
    );
    let r = ui(&s, "search.suggest", json!({ "windowId": 1, "query": "we" }));
    assert_eq!(r["value"]["result"]["engine"], json!({ "id": "duckduckgo", "name": "DuckDuckGo" }));
    let fetch = r["fetch"].clone();
    assert_eq!(fetch["url"], json!("https://duckduckgo.com/ac/?q=we&type=list"));
    assert_eq!(fetch["window"], json!(1));
    // Typed on meanwhile: held, asked once it answers.
    assert_eq!(ui(&s, "search.suggest", json!({ "windowId": 1, "query": "wea" })).get("fetch"), None);
    let answer = |seq: &Value, status: i64, body: &str| {
        s.input(&json!({ "type": "suggestAnswer", "window": 1, "seq": seq, "status": status, "body": body }))
            .reply
            .unwrap_or_default()
    };
    let out = answer(&fetch["seq"], 200, r#"["we",["web","weather"]]"#);
    assert_eq!(
        out["push"],
        json!({ "type": "suggestions", "query": "we", "items": ["web", "weather"], "engine": { "id": "duckduckgo", "name": "DuckDuckGo" } })
    );
    assert_eq!(out["fetch"]["url"], json!("https://duckduckgo.com/ac/?q=wea&type=list"));
    assert_eq!(answer(&out["fetch"]["seq"], 0, ""), json!({}), "failed: nothing shown");
    // Known: in the answer itself.
    let r = ui(&s, "search.suggest", json!({ "windowId": 1, "query": "we" }));
    assert_eq!(r["value"]["result"]["items"], json!(["web", "weather"]));
    assert_eq!(r.get("fetch"), None);
    // Off in the settings: none asked.
    *world.settings.borrow_mut() = json!({ "searchSuggestions": false });
    let r = ui(&s, "search.suggest", json!({ "windowId": 1, "query": "other" }));
    assert_eq!((r["value"]["result"]["on"].clone(), r.get("fetch")), (json!(false), None));
    // An engine not Safari's: none, and the search back to Google's.
    assert_eq!(engine(json!("com.baidu.www"), json!("Baidu")), json!({ "engine": null }));
    *world.settings.borrow_mut() = Value::Null;
    assert!(
        ui(&s, "search", json!({ "windowId": 1, "query": "a" }))["payload"]["url"]
            .as_str()
            .unwrap()
            .starts_with("https://www.google.com/search?client=safari")
    );
    assert_eq!(ui(&s, "search.suggest", json!({ "query": "a" })), json!({ "route": "none" }), "no window");
}
