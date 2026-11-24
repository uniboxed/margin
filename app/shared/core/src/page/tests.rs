use super::*;

const C: Rect = Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
const PAGE: Rect = Rect { x: 248.0, y: 8.0, width: 1256.0, height: 966.0 };

fn layout(hosted: bool) -> Vec<u8> {
    format!(
        r#"{{"insets":{{"left":248,"top":8,"right":8,"bottom":8}},"radius":10,"radii":[10,10,10,10],"container":{{"width":1512,"height":982}},"mode":"fullscreen","pageHosted":{hosted},"fills":["rgb(240, 236, 228)","rgb(240, 236, 228)","rgb(17, 17, 17)","rgb(240, 236, 228)"]}}"#
    )
    .into_bytes()
}

// A page hosting in full screen, its page area measured.
fn hosting() -> Page {
    let mut p = Page::new(0.12, "Getting you started");
    p.set_full_screen(true);
    assert!(p.set_layout_bytes(&layout(true)).taken);
    assert_eq!(p.set_hosting(true), Some(false));
    assert_eq!(p.update_page(C, Some(C)), Some((Some(PAGE), 10.0)));
    p
}

#[test]
fn the_states_and_the_grace() {
    let mut p = hosting();
    // Hosting, nothing hosted yet, a show not known to be slow: the grace (from empty), its deadline.
    assert!(p.set_showing(Some("Notes"), Some("com.apple.Notes"), false));
    assert!(!p.set_showing(Some("Notes"), Some("com.apple.Notes"), false), "the same: nothing new");
    assert_eq!(p.settle(5.0), Settled::Grace { hole_again: false });
    assert_eq!(p.grace_until(), Some(5.12));
    assert_eq!(p.state(), PageState::Empty, "what's drawn stays meanwhile");
    // Still not ready when it's over: the loader, with the item's name and app.
    assert_eq!(p.grace_over(), Applied { changed: true, shown: false });
    assert_eq!((p.state(), p.loader(), p.loader_app()), (PageState::Loading, Some("Notes"), Some("com.apple.Notes")));
    // Its window hosted and the show over: shown.
    assert_eq!(p.set_hosted(Some(42)), HostedSaid::Changed);
    assert_eq!(p.set_hosted(Some(42)), HostedSaid::Moved);
    assert!(p.set_showing(None, None, false));
    assert_eq!(p.settle(6.0), Settled::Applied(Applied { changed: true, shown: true }));
    assert_eq!((p.state(), p.loader()), (PageState::Shown, None));
    // From shown, another show: the grace, the hole placed again meanwhile.
    p.set_showing(Some("Mail"), None, false);
    assert_eq!(p.settle(7.0), Settled::Grace { hole_again: true });
    // The engine's slow step: loading at once (the grace dropped).
    p.set_loading(Some("Mail"), Some("com.apple.mail"));
    assert_eq!(p.settle(7.05), Settled::Applied(Applied { changed: true, shown: false }));
    assert_eq!((p.grace_until(), p.loader_app()), (None, Some("com.apple.mail")));
    // A slow show (the last item at launch): the loader at once, its start's look.
    let mut q = hosting();
    q.set_showing(Some("Getting you started"), None, true);
    assert!(matches!(q.settle(1.0), Settled::Applied(Applied { changed: true, .. })));
    assert!(q.starting());
    // Not hosting: elsewhere's card, or the launcher.
    let mut e = Page::new(0.12, "x");
    assert!(e.set_elsewhere(Some("Notes"), Some("n")));
    assert!(matches!(e.settle(1.0), Settled::Applied(_)));
    assert_eq!(e.state(), PageState::Elsewhere);
    // ...and from elsewhere back hosting: the loader at once, no grace.
    e.set_hosting(true);
    e.set_showing(Some("Notes"), None, false);
    assert!(matches!(e.settle(2.0), Settled::Applied(_)));
    assert_eq!(e.state(), PageState::Loading);
    // No grace configured: at once.
    let mut z = Page::new(0.0, "");
    z.set_hosting(true);
    assert!(matches!(z.settle(1.0), Settled::Applied(_)));
}

#[test]
fn the_copy_slow_and_slow_alone_are_new_states() {
    // (docs/LINK-RESILIENCE.md §1 rule 8: the loader while a show waits for a slow copy.)
    let mut p = hosting();
    p.set_hosted(Some(42));
    p.set_showing(None, None, false);
    p.settle(1.0);
    assert!(!p.set_copy_slow(true), "nothing being shown: not slow");
    // A quick tab switch: the grace, the hole as it was.
    assert!(p.set_showing(Some("Docs"), Some("com.apple.Safari"), false));
    assert_eq!(p.settle(2.0), Settled::Grace { hole_again: true });
    // Its copy slow: new, the grace over at once, the loader, saying so.
    assert!(p.set_copy_slow(true));
    assert!(!p.set_copy_slow(true), "the same: nothing new");
    assert_eq!(p.settle(2.05), Settled::Applied(Applied { changed: true, shown: false }));
    assert!(p.copy_slow() && p.state() == PageState::Loading);
    // Reading again: no longer said; the item shown: gone with it.
    assert!(p.set_copy_slow(false));
    assert!(!p.copy_slow());
    p.set_copy_slow(true);
    assert!(p.set_showing(Some("Other"), Some("com.apple.Safari"), false));
    assert!(!p.copy_slow(), "another item: the slowness said for the one before goes");
    p.set_copy_slow(true);
    p.set_showing(None, None, false);
    p.settle(3.0);
    assert!(!p.copy_slow() && p.state() == PageState::Shown);
    // `slow` alone changed for the same item: a change (known slow now: no grace).
    assert!(p.set_showing(Some("Docs"), Some("com.apple.Safari"), false));
    assert!(p.set_showing(Some("Docs"), Some("com.apple.Safari"), true), "slow alone: new");
    assert!(!p.set_showing(Some("Docs"), Some("com.apple.Safari"), true));
    assert!(matches!(p.settle(4.0), Settled::Applied(_)), "no grace once it's known slow");
    // The engine's slow step or the start: never said as the copy's.
    let mut q = hosting();
    q.set_showing(Some("Getting you started"), None, true);
    q.set_copy_slow(true);
    q.settle(1.0);
    assert!(q.starting() && !q.copy_slow());
}

#[test]
fn one_hosts_hole() {
    let mut p = hosting();
    p.set_hosted(Some(42));
    p.set_hosted_frame(Some(Rect::new(300.0, 8.0, 900.0, 966.0)));
    p.settle(1.0);
    let placed = p.place_hole(C);
    assert_eq!(placed.ground, Ground::One);
    assert_eq!(p.hole(), Some(Rect::new(300.0, 8.0, 900.0, 966.0)), "a window-mode window smaller than the page area");
    assert_eq!(p.ground_hole().radii, [0.0, 0.0, 0.0, 0.0], "its corners not the card's");
    assert_eq!(placed.fill, fill::color("rgb(240, 236, 228)"), "the colour most corners have");
    assert!(placed.placed.slot && p.pointer.slot().is_some());
    // Followed live: the page area.
    p.set_following(true);
    p.place_hole(C);
    assert_eq!((p.hole(), p.ground_hole().radii), (Some(PAGE), [10.0; 4]));
    // Its bounds unread: the page area too.
    p.set_following(false);
    p.set_hosted_frame(None);
    p.place_hole(C);
    assert_eq!(p.holes(), &[PAGE]);
    // A bounds outside the page area, or under a point: no hole; the panel filled.
    p.set_hosted_frame(Some(Rect::new(0.0, 0.0, 248.5, 900.0)));
    assert_eq!(p.place_hole(C).ground, Ground::None);
    assert_eq!(p.hole(), None);
    // Not shown: none, the pointer Margin's.
    p.set_hosted_frame(Some(PAGE));
    p.set_loading(Some("x"), None);
    p.settle(2.0);
    assert_eq!((p.place_hole(C).ground, p.pointer.slot().is_none()), (Ground::None, true));
    // Not hosting: no ground colour.
    p.set_hosting(false);
    assert_eq!(p.place_hole(C).fill, None);
}

#[test]
fn the_grace_keeps_the_old_hole() {
    let mut p = hosting();
    p.set_hosted(Some(42));
    p.settle(1.0);
    p.place_hole(C);
    assert_eq!(p.hole(), Some(PAGE));
    // A switch: the hosted window dropped (the next one not in yet) while the grace runs: the hole as it was.
    p.set_hosted(None);
    assert!(matches!(p.settle(2.0), Settled::Grace { hole_again: true }));
    p.place_hole(C);
    assert_eq!(p.hole(), Some(PAGE));
}

#[test]
fn several_hosts_holes() {
    let mut p = hosting();
    p.set_hosted(Some(1));
    p.settle(1.0);
    let left = Rect::new(248.0, 8.0, 620.0, 966.0);
    let right = Rect::new(876.0, 8.0, 628.0, 966.0);
    let card = Rect::new(400.0, 100.0, 700.0, 700.0);
    let shown = [
        Shown { window: 1, rect: left, z: 0, role: role::MAIN, focused: false },
        Shown { window: 2, rect: right, z: 1, role: role::PANE, focused: true },
    ];
    assert!(p.set_visible(&shown));
    assert!(!p.set_visible(&shown), "the same shape");
    p.set_frames([(1, left), (2, Rect::new(876.0, 8.0, 628.0, 900.0))]);
    let placed = p.place_hole(C);
    assert_eq!(placed.ground, Ground::Several);
    assert_eq!(p.holes(), &[left, Rect::new(876.0, 8.0, 628.0, 900.0)]);
    assert_eq!(p.hole(), Some(Rect::new(876.0, 8.0, 628.0, 900.0)), "the focused one's");
    assert_eq!(p.ground_holes()[0].radii, [10.0, 0.0, 0.0, 10.0]);
    assert_eq!(p.pane_holes().len(), 2);
    // A card over them: its whole rect a cut, the pointer through its content only.
    let mut with_card = shown.to_vec();
    with_card.push(Shown { window: 3, rect: card, z: 2, role: role::CARD, focused: false });
    p.set_visible(&with_card);
    p.set_frames([(1, left), (2, right), (3, Rect::new(400.0, 100.0, 700.0, 10.0))]);
    p.place_hole(C);
    assert_eq!(p.holes(), &[left, right, card], "the card's whole page box cut out");
    assert_eq!(
        p.pointer.slot().and_then(|s| s.holes).map(<[Rect]>::to_vec),
        Some(vec![Rect::new(400.0, 100.0, 700.0, 10.0)])
    );
    assert_eq!(p.pane_holes(), &[PaneHole { rect: Rect::new(400.0, 100.0, 700.0, 10.0), window: 3, card: true }]);
    assert!(p.ground_holes().iter().filter(|h| !h.has_radii).count() > 0, "the card in pieces around the panes");
    // In front: ordered above the focused one.
    assert_eq!(p.front_target(), Some(2));
}

#[test]
fn layout_reports() {
    let mut p = Page::default();
    assert!(!p.set_layout_bytes(b"{\"insets\":1}").taken);
    assert!(!p.set_layout_bytes(b"not json").taken);
    assert!(!p.set_layout_bytes(b"[1]").taken);
    let first = p.set_layout_bytes(&layout(false));
    assert_eq!(first, LayoutSaid { taken: true, panes_changed: true }, "the first: its panes new");
    assert!(!p.set_layout_bytes(&layout(true)).panes_changed);
    let split = br#"{"insets":{"left":248,"top":8,"right":8,"bottom":8},"container":{"width":1512,"height":982},"split":"s","panes":[{"id":"a","rect":[0,0,620,966]},{"id":"b","rect":[628,0,628,966]}],"pageHosted":true}"#;
    assert!(p.set_layout_bytes(split).panes_changed);
    assert!(p.panes(C).is_none(), "not hosting: none");
    p.set_hosting(true);
    let (id, panes) = p.panes(Rect::new(0.0, 0.0, 1512.0, 982.0)).expect("a split");
    assert_eq!(
        (id, panes.collect::<Vec<_>>()),
        ("s", vec![("a", Rect::new(0.0, 0.0, 620.0, 966.0)), ("b", Rect::new(628.0, 0.0, 628.0, 966.0))])
    );
    assert!(!p.set_layout_bytes(split).panes_changed);
}

#[test]
fn the_page_area_and_its_placements() {
    let mut p = Page::default();
    assert_eq!(p.update_page(C, Some(C)), Some((None, 0.0)), "no layout: none");
    p.set_layout_bytes(&layout(false));
    p.set_full_screen(true);
    assert_eq!(p.update_page(C, Some(C)), Some((Some(PAGE), 10.0)), "the launcher's page area");
    assert_eq!(
        p.update_page(Rect::new(0.0, 0.0, 1200.0, 800.0), None),
        None,
        "a layout from before a resize: as it was"
    );
    assert_eq!(p.idle_placement(C).map(|p| p.page), Some(PAGE));
    p.set_hosting(true);
    assert_eq!(p.update_page(C, Some(C)), Some((None, 10.0)), "hosting: no placement from the launcher's layout");
    p.set_layout_bytes(&layout(true));
    assert_eq!(p.update_page(C, Some(C)), Some((Some(PAGE), 10.0)));
    assert_eq!(p.hosted_placement(C, Some(C)).map(|p| p.display), Some(C));
    assert_eq!(p.update_page(Rect::new(0.0, 0.0, 756.0, 982.0), Some(C)), None, "narrowed: as it was");
}

#[test]
fn kept_in_front_by_its_page() {
    let mut p = hosting();
    p.configure(0.12, "", Mechanism::Order, 1, 0);
    p.set_hosted(Some(42));
    let t = 1.0;
    let k = p.keep_front(0, &mut || t);
    assert_eq!(k, KeepFront { level: None, above: Some(42), below: None }, "the order's way: above the hosted window");
    assert!(p.front_reads(42) && !p.front_reads(7));
    p.set_full_screen(false);
    assert!(!p.front_reads(42), "windowed: not its read");
    assert!(p.front.set_covering(Some(9)));
    p.set_hosted(None);
    p.set_full_screen(true);
    assert_eq!(p.keep_front(0, &mut || t).above, Some(9), "nothing hosted: the window it covers");
    // The order asked for: kept, never probed.
    let ops = p.front_read(9, 0, true, 0, &mut || 20.0);
    assert_eq!(ops.len, 0);
}
