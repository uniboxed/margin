// The preview card and Quick Tab in Margin.app (docs/PEEK-SPLIT.md §2, §3; DECISIONS.md "Peek and Little Arc in
// Margin.app", their first names), on the several-visible-hosts foundation (§1: HostedSession.setLayout, HostEngine.setLayout).
//
// - A card is a profile's card window (`safari:<profile>#card`, the engine's `requestRoleWindow(.card)`: opened by the
//   copy at the card's address, never Safari's empty new-tab page, whose address field keeps Safari's toolbar down)
//   shown above the item of a Margin window (its opener) at the theme's `<m-preview-page>` (the page's `peekRect`, else
//   Margin's default rect: centred in the page area, 8% each side, 7% above and below, at least 420×320, under a 52 pt
//   bar), focused (the keys are its window's). One card per profile, attached to its opener: a pick of another item in
//   that window hides it (parked, its page kept), coming back to the opener shows it again; a preview elsewhere replaces it.
// - Its page is the copy's tab tagged `peek-card` (background/hosted.ts CARD_ITEM), never one of the library's items:
//   not in the sidebar, not archived, not counted by the keys. In layouts it's the item `card:<profile>` (`cardItem`).
// - Opened by a page's click (the copy's push `peekOpen`, answered `peekAnswer` at once, by its `notAfter`; a click
//   the copy gave up on is `peekCancel`), or by Quick Tab's field (the page's `peek.go`). Shown as a layout change:
//   main where it is, the card beside it (a parked card window comes back in ~25–36 ms; its first open is the engine's
//   first open, under the card's own loader: the page card's loader is never put over main for it).
// - The page draws it (its `peek` push: `loading` until its window is in place, then not; null: gone, its close
//   animated there). Closed (its ✕, Esc in Margin's field or in its page, ⌘W, a press on the dimmed page): the page
//   told first (its page area covered at once), then the card parked and its tab closed (`hostCardClose`, a blank tab
//   left so the window stays for the next preview). Expand (its button, ⌘↩): a new item of the space at the card's
//   address, the card's tab moved into the profile's main window as that item's (`hostPromotePeek`), shown as main;
//   the card window parked.
// - A card window unused for `cardIdle` (15 minutes) is closed; so is one whose profile's main window went.
//
// Quick Tab with nothing hosted in the window (its launcher in the page area): there's no page under a card, so what's
// chosen opens as the space's new tab at once (decided here, DECISIONS.md).

import AppKit

// One profile's card.
struct PeekCard: Equatable {
    var profile: String
    var window: Int // the Margin window it's attached to
    var opener: String // the item under it (main of that window's layout)
    var space: String? // the space Expand puts it in
    var url: String
    var title: String = ""
    var open = true // shown in its window now (false: hidden with its opener, kept)
    var ready = false // its window in place at its rect
    var fresh = true // its page still to be loaded at `url` (a new preview): the copy navigates its tab there
    var rect: CGRect? // where it was laid out last
    var hiddenBy: String? // the item whose show hid it (a pick of the opener itself keeps it hidden)
    var click: String? // the page's click it came from (`peekOpen`'s id)
}

extension HostedSession {
    static let cardTag = "peek-card" // the copy's tag for the card's page (background/hosted.ts CARD_ITEM)
    static let cardPrefix = "card:"
    static let cardIdle = 15 * 60.0
    static let cardRectWait = 0.3 // the page's <m-preview-page> waited for this long, then Margin's default rect
    static let cardCoverWait = 0.05 // the page given this long to cover the card's page area before its window goes
    static func cardItem(_ profile: String) -> String { cardPrefix + profile }
    static func isCardItem(_ item: String?) -> Bool { item?.hasPrefix(cardPrefix) == true }

    // Margin's default card rect in a page area (a theme with no `<m-preview-page>`): centred, 8% each side and 7% above
    // and below at most (at least 420 wide, 320 tall for its page), its page under a 52 pt bar (at least Safari's full-screen toolbar window, which rests just above the card window, never seen through the dim).
    nonisolated static func defaultCardRect(page: CGRect) -> CGRect {
        let bar: CGFloat = 52
        let w = max(min(page.width, 420), page.width - 2 * min(page.width * 0.08, max(0, (page.width - 420) / 2)))
        let h = max(min(page.height, 320 + bar), page.height - 2 * min(page.height * 0.07, max(0, (page.height - 320 - bar) / 2)))
        let x = page.minX + (page.width - w) / 2, y = page.minY + (page.height - h) / 2
        return CGRect(x: x.rounded(), y: (y + bar).rounded(), width: w.rounded(), height: max(0, h - bar).rounded())
    }

    // An item that's a pin's or a favorite's tab (the library's `pinnedBy`, `favoriteId`): its page's links to other
    // sites open in a card (auto-preview, settings.autoPeekPins). Told to the copy with each hostShow (`pinned`): the copy's
    // own state doesn't have the library's pins.
    func pinnedOrFavorite(_ item: String) -> Bool {
        guard let v = library.items().first(where: { $0.id == item })?.value else { return false }
        return !((v["pinnedBy"] as? String) ?? "").isEmpty || !((v["favoriteId"] as? String) ?? "").isEmpty
    }

    // ---- what the layout needs of a card (HostedSession.applyLayout) ----

    func cardPart(_ item: String, rect: CGRect?) -> LayoutPart? {
        guard Self.isCardItem(item) else { return nil }
        let p = String(item.dropFirst(Self.cardPrefix.count))
        guard let c = cards[p] else { return nil }
        let target = HostTarget.safariWindow(p, .card)
        labels[target.id] = "Safari"
        return LayoutPart(item: item, target: target, profile: p, url: c.url, role: .card, rect: rect)
    }

    // The copy's hostShow for the card's page: in the card's window only (`role`), at its address when it's a new one.
    func cardShowPayload(_ item: String, windowId: Int) -> JSONObject? {
        guard Self.isCardItem(item) else { return nil }
        let p = String(item.dropFirst(Self.cardPrefix.count))
        guard let c = cards[p] else { return nil }
        var out: JSONObject = ["windowId": windowId, "itemId": Self.cardTag, "url": c.url.isEmpty ? "about:blank" : c.url, "role": "card"]
        if c.fresh { out["fresh"] = true }
        return out
    }

    // The engine's slow step for a card's window (its first open): the card's own loader (it says `loading` until it's
    // in place), never the page card's over main. True: a card's, taken here.
    func cardLoadingStep(_ id: HostID?) -> Bool {
        if let id, id.safariRole == .card { cardLoading = id; return true }
        if id == nil, cardLoading != nil { cardLoading = nil; return true }
        return false
    }

    // The card a Margin window shows or keeps (open or hidden with its opener).
    func card(in windowId: Int) -> PeekCard? { cards.values.first { $0.window == windowId } }
    func openCard(in windowId: Int) -> PeekCard? { cards.values.first { $0.window == windowId && $0.open } }

    // ---- the copy's word ----

    // A page's click (the copy's `peekOpen { id, url, source, tabId, notAfter }` for one of its windows): answered at
    // once. Taken only from a window Margin hosts for that profile (main's, or the card's own: a preview inside the card
    // replaces its page) whose Margin window shows one of its items, by the click's time; anything else is refused and
    // the page opens the link as it would have.
    func peekOpen(profile: String, windowId: Int?, msg: JSONObject) {
        let id = msg["id"] as? String ?? ""
        let url = msg["url"] as? String ?? ""
        let notAfter = num(msg["notAfter"]) ?? 0
        func answer(_ ok: Bool, _ why: String) {
            if !id.isEmpty, id.count <= 80 { Task { _ = await self.links.request(profile: profile, "peekAnswer", ["id": id, "ok": ok]) } }
            note("Preview asked by a page: \(ok ? "shown" : "refused (\(why))")")
        }
        // (A click's push has both: anything else isn't one, and is never a card.)
        guard !id.isEmpty, notAfter > 0 else { return note("Preview: a push that isn't a page's click (no id or time): left") }
        guard Self.webAddress(url) else { return answer(false, "not a web address") }
        guard Date().timeIntervalSince1970 * 1000 <= notAfter else { return answer(false, "too late: the page opened it") }
        guard let windowId else { return answer(false, "no window") }
        let fromCard = safariWindows[SafariKey(profile, .card)] == windowId
        guard fromCard || safariWindows[SafariKey(profile)] == windowId else { return answer(false, "not a window Margin hosts") }
        guard let wid = hostingWindow, let w = window(wid) else { return answer(false, "nothing hosted") }
        let main = layout[wid]?.main ?? shown[wid]
        guard let main, !Self.isCardItem(main), open[main] != nil else { return answer(false, "nothing shown under it") }
        if !fromCard, open[main]?.profile != profile, !(layout[wid]?.items.contains { open[$0]?.profile == profile && open[$0]?.host == HostTarget.safariWindow(profile).id } ?? false) {
            return answer(false, "the page isn't one Margin shows")
        }
        answer(true, "")
        showCard(w, profile: profile, url: url, opener: main, space: library.space(ofItem: main) ?? library.space(ofWindow: wid), click: id)
    }

    // The copy gave up on a click before the app's word reached it (`peekCancel`): its card, if shown, closed again.
    func peekCancel(profile: String, msg: JSONObject) {
        guard let id = msg["id"] as? String, let c = cards[profile], c.click == id else { return }
        closeCard(windowId: c.window, why: "the page opened the link itself (no answer in time)")
    }

    // The card's page now (the copy's `cardPage { url, title }`): its bar follows.
    func cardPage(profile: String, windowId: Int?, msg: JSONObject) {
        guard var c = cards[profile], windowId == nil || safariWindows[SafariKey(profile, .card)] == windowId else { return }
        if let url = msg["url"] as? String, Self.webAddress(url) { c.url = url }
        if let title = msg["title"] as? String { c.title = String(title.prefix(300)) }
        c.fresh = false
        guard c != cards[profile] else { return }
        cards[profile] = c
        if c.open { tellPage(c) }
    }

    // Esc or ⌘↩ in the card's page (the copy's `cardKey { key }`).
    func cardKey(profile: String, windowId: Int?, key: String) {
        guard let c = cards[profile], c.open, safariWindows[SafariKey(profile, .card)] == windowId else { return }
        if key == "close" { closeCard(windowId: c.window, why: "Esc in its page") }
        if key == "expand" { expandCard(windowId: c.window, spaceId: nil) }
    }

    // ---- the page's word (LibraryWindowSource.perform: `peek.*`) ----

    // Quick Tab's field up in window `windowId` (no window yet): ⌘W and a press around it close it there.
    func littleArcOpened(windowId: Int?, spaceId: String?) {
        guard let w = window(windowId) else { return }
        if openCard(in: w.id) != nil { closeCard(windowId: w.id, why: "Quick Tab opened over it", tellPage: false) }
        littleArcs[w.id] = spaceId ?? library.space(ofWindow: w.id) ?? ""
        note("Quick Tab open in Margin's window \(w.id)")
    }

    // Quick Tab's choice: the card at that address over the window's item; nothing hosted there: the space's new tab.
    func littleArcGo(windowId: Int?, url: String, spaceId: String?) {
        guard let w = window(windowId), Self.webAddress(url) else { return }
        littleArcs[w.id] = nil
        let space = spaceId.flatMap { s in library.spaces().contains { $0.id == s } ? s : nil } ?? library.space(ofWindow: w.id)
        let main = w.id == hostingWindow ? (layout[w.id]?.main ?? shown[w.id]) : nil
        guard let main, open[main] != nil, !Self.isCardItem(main) else {
            note("Quick Tab: nothing hosted under it: opened as the space's new tab")
            pushPeek(w, nil)
            var payload: JSONObject = ["windowId": w.id, "url": url]
            if let space { payload["spaceId"] = space }
            library.perform("newTab", payload)
            return
        }
        // (Its profile: the space's, as a new tab there would have.)
        let ofSpace = space.flatMap { s in library.spaces().first { $0.id == s }?.value["profile"] as? String }.flatMap { $0.isEmpty ? nil : $0 }
        let profile = resolve(ofSpace)
        showCard(w, profile: profile, url: url, opener: main, space: space, click: nil)
    }

    // ---- open, hide, show again ----

    func showCard(_ w: HostedWindow, profile: String, url: String, opener: String, space: String?, click: String?) {
        // (One card in a window: another profile's there goes, its page kept for its own next preview.)
        for (p, c) in cards where p != profile && c.window == w.id && c.open { closeCard(windowId: w.id, why: "another profile's card replaces it", tellPage: false) }
        let was = cards[profile]
        var c = PeekCard(profile: profile, window: w.id, opener: opener, space: space, url: url, click: click)
        c.rect = was?.window == w.id ? was?.rect : nil
        cards[profile] = c
        cardUsedAt[profile] = now()
        littleArcs[w.id] = nil
        note("Preview: a card in Margin's window \(w.id) over \(opener)\(was == nil ? "" : was!.window == w.id ? " (its page replaced)" : " (moved from Margin's window \(was!.window))")")
        tellPage(c)
        enqueue { await self.placeCard(profile) }
    }

    // The card laid out over its opener: at the page's <m-preview-page> (waited for a moment), else Margin's default rect;
    // a split's panes kept as they are. Then the page told it's in place (or it's gone: refused, failed).
    func placeCard(_ profile: String) async {
        guard let c = cards[profile], c.open, let w = window(c.window) else { return }
        _ = await wait(Self.cardRectWait) { w.cardRect != nil || self.cards[profile]?.open != true }
        guard var c = cards[profile], c.open, c.window == w.id else { return }
        guard let rect = w.cardRect ?? w.hostedPlacement.map({ Self.defaultCardRect(page: $0.page) }) else {
            note("Preview: no page area to lay the card out in")
            return dropCard(profile, w, why: "no page area")
        }
        if w.cardRect == nil { note("Preview: the theme has no <m-preview-page>: Margin's default place for the card") }
        let base = layout[w.id]
        let main = base?.main ?? c.opener
        let extras = (base?.extras ?? []).filter { $0.role != .card } + [HostedLayout.Extra(item: Self.cardItem(profile), role: .card, rect: rect)]
        // (Over a split: the split's own layout kept, its panes at their <m-pane>s, the card above them.)
        await applyLayout(w.id, main: main, mainRect: base?.mainRect, extras: extras, focused: Self.cardItem(profile), split: splitOf(base))
        guard let after = cards[profile], after.open, after.window == w.id else { return }
        guard layout[w.id]?.extras.contains(where: { $0.item == Self.cardItem(profile) }) == true else {
            note("Preview: the card wasn't shown (refused or failed: see the layout's line)")
            w.push(#"{"type":"toast","text":"Not enough room for that card"}"#)
            return dropCard(profile, w, why: "not shown")
        }
        c = after
        c.ready = true
        c.fresh = false
        c.rect = rect
        cards[profile] = c
        cardUsedAt[profile] = now()
        tellPage(c)
    }

    // A card that couldn't be shown: gone from the page, forgotten (its window, if any, stays parked).
    private func dropCard(_ profile: String, _ w: HostedWindow, why: String) {
        cards[profile] = nil
        pushPeek(w, nil)
    }

    // A pick in window `w` (the library's show requests): its card hides with its opener (parked by the show itself,
    // which lays the item out alone), kept for when the opener's shown again.
    func cardLeaving(_ w: HostedWindow, for item: String?) {
        littleArcs[w.id] = nil
        guard var c = card(in: w.id) else { return }
        if c.open {
            c.open = false
            c.ready = false
            c.hiddenBy = item
            cards[c.profile] = c
            cardUsedAt[c.profile] = now()
            pushPeek(w, nil)
            note("Preview: the card hidden with its opener (another item picked)")
        } else if item != c.opener {
            c.hiddenBy = nil
            cards[c.profile] = c
        }
    }

    // An item shown in window `w`: its own card (hidden when another was picked) shown again over it.
    func cardReturning(_ w: HostedWindow, to item: String) {
        guard var c = card(in: w.id), !c.open, c.opener == item, c.hiddenBy != item, w.id == hostingWindow else { return }
        c.open = true
        c.ready = false
        cards[c.profile] = c
        note("Preview: back to its opener: the card shown again")
        tellPage(c)
        let p = c.profile
        enqueue { await self.placeCard(p) }
    }

    // The page's <m-preview-page> moved (a resize, another theme): the card laid out there again.
    func cardRectChanged(_ w: HostedWindow) {
        guard let c = openCard(in: w.id), c.ready, let rect = w.cardRect, let was = c.rect,
              abs(rect.minX - was.minX) > 1 || abs(rect.minY - was.minY) > 1 || abs(rect.width - was.width) > 1 || abs(rect.height - was.height) > 1 else { return }
        let p = c.profile
        enqueue { await self.placeCard(p) }
    }

    // The split a window's layout shows, for laying it out again with or without the card (its panes as the library
    // has them, the page's `<m-pane>` order: HostedSession.paneRects). Nil: no split there.
    func splitOf(_ l: HostedLayout?) -> (id: String, items: [String])? {
        guard let id = l?.split, let split = library.split(id) else { return nil }
        return (id, split.panes)
    }

    // The card's window at its <m-preview-page> as the page lays it out now (a page area's change, a drag's frame), by its
    // host; empty: no card in place there.
    func cardHostRects(_ w: HostedWindow) -> [HostID: CGRect] {
        guard let c = openCard(in: w.id), c.ready, let r = w.cardRect else { return [:] }
        return [HostTarget.safariWindow(c.profile, .card).id: r]
    }
    // ...placed there by the page area's change: its rect kept (its own <m-preview-page> report then changes nothing).
    func cardPlaced(_ w: HostedWindow, rects: [HostID: CGRect]) {
        guard var c = openCard(in: w.id), let r = rects[HostTarget.safariWindow(c.profile, .card).id] else { return }
        c.rect = r
        cards[c.profile] = c
    }

    // ---- close, expand, history ----

    // The card in window `windowId` closed (or Quick Tab's field): the page told first (it covers the card's page area
    // at once and animates it out; `tellPage` false: it closed it itself), then the card parked and its tab closed.
    // False: no card there.
    @discardableResult func closeCard(windowId: Int?, why: String, tellPage: Bool = true) -> Bool {
        guard let w = window(windowId) else { return false }
        if littleArcs.removeValue(forKey: w.id) != nil, openCard(in: w.id) == nil {
            if tellPage { pushPeek(w, nil) }
            note("Quick Tab closed (\(why))")
            return true
        }
        guard let c = openCard(in: w.id) else { return false }
        cards[c.profile] = nil
        cardUsedAt[c.profile] = now()
        if tellPage { pushPeek(w, nil) }
        note("Preview: the card closed (\(why))")
        let p = c.profile
        enqueue {
            await self.sleep(Self.cardCoverWait)
            if let base = self.layout[w.id], base.extras.contains(where: { $0.item == Self.cardItem(p) }) {
                // (The rest as it was: a split goes on, its focused pane (the window's item shown) focused again.)
                let extras = base.extras.filter { $0.item != Self.cardItem(p) }
                let main = base.main
                let under = self.shown[w.id].flatMap { s in s == main || extras.contains { $0.item == s } ? s : nil } ?? main
                await self.applyLayout(w.id, main: main, mainRect: base.mainRect, extras: extras, focused: under, split: self.splitOf(base))
            }
            _ = await self.links.request(profile: p, "hostCardClose", [:])
        }
        return true
    }

    // ⌘W in window `windowId` (Margin's own Close Tab, a hosted app's ⌘W): the card there, or Quick Tab's field,
    // closed; never the item under it. False: neither there (the item's own ⌘W).
    func closeCardForKey(windowId: Int?) -> Bool {
        guard let w = window(windowId) else { return false }
        guard openCard(in: w.id) != nil || littleArcs[w.id] != nil else { return false }
        return closeCard(windowId: w.id, why: "⌘W")
    }

    // Expand: the card's page a new item of its space, its tab moved into the profile's main window (its page kept),
    // shown as main; the card window parked for the next preview.
    func expandCard(windowId: Int?, spaceId: String?) {
        guard let w = window(windowId), let c = openCard(in: w.id) else { return }
        cards[c.profile] = nil
        cardUsedAt[c.profile] = now()
        pushPeek(w, nil)
        let space = spaceId.flatMap { s in library.spaces().contains { $0.id == s } ? s : nil } ?? c.space ?? library.space(ofWindow: w.id)
        var payload: JSONObject = ["windowId": w.id, "url": c.url, "title": c.title, "target": ItemTarget.web(browser: "safari", profile: c.profile).json, "front": true]
        if let space { payload["spaceId"] = space }
        let out = library.perform("addItem", payload)
        guard out.ok, let item = (out.result as? JSONObject)?["tabId"] as? String else {
            note("Preview: Expand made no item (\(out.error ?? "?")): the card closed instead")
            cards[c.profile] = c
            closeCard(windowId: w.id, why: "Expand failed", tellPage: false)
            return
        }
        note("Preview: expanded into item \(item)")
        requested[w.id] = item
        onChange?()
        let p = c.profile
        enqueue {
            if let main = self.safariWindows[SafariKey(p)] {
                let (result, error) = await self.links.request(profile: p, "hostPromotePeek", ["fromItemId": Self.cardTag, "toWindowId": main, "toItemId": item])
                if result?["ok"] as? Bool != true {
                    self.note("Preview: the card's tab not moved (\(error ?? "refused")): opened at its address in the main window")
                    _ = await self.links.request(profile: p, "hostCardClose", [:])
                }
            }
            // (Shown alone, as any item picked outside a split: a split under the card stays, for its next pick.)
            await self.show(item, url: c.url, target: nil, windowId: w.id)
            self.settleHosting()
        }
    }

    // The card's Back and Forward: its page's history (the copy's goBack/goForward for the card's window's tab in front).
    func cardHistory(windowId: Int?, back: Bool) {
        guard let w = window(windowId), let c = openCard(in: w.id), let cardWindow = safariWindows[SafariKey(c.profile, .card)] else { return }
        Task { _ = await self.links.request(profile: c.profile, back ? "goBack" : "goForward", ["windowId": cardWindow]) }
    }

    // ---- the card windows' own lives ----

    // A host gone (closed, quit, its window closed): a card window's card forgotten; a profile's main window's: its card
    // window closed with it.
    func cardHostGone(_ id: HostID) {
        for (p, c) in cards where HostTarget.safariWindow(p, .card).id == id {
            cards[p] = nil
            if let w = window(c.window) { pushPeek(w, nil) }
        }
        for p in Set(cardUsedAt.keys) where HostTarget.safariWindow(p, .card).id == id { cardUsedAt[p] = nil }
        guard id.safariRole == .main, id.raw.hasPrefix("safari:") else { return }
        let profile = String(id.raw.dropFirst("safari:".count))
        let cardId = HostTarget.safariWindow(profile, .card).id
        guard engine.isHosted(cardId) else { return }
        note("Preview: its profile's main window went: the card window closed with it")
        if let c = cards[profile], let w = window(c.window) { cards[profile] = nil; pushPeek(w, nil) }
        cardUsedAt[profile] = nil
        enqueue { await self.engine.close(cardId) }
    }

    // Card windows not used for `cardIdle` (parked, no card open): closed (the shell's poll, through the sweep).
    func closeIdleCards() {
        let t = now()
        for (p, at) in cardUsedAt.sorted(by: { $0.key < $1.key }) where cards[p]?.open != true && t - at >= Self.cardIdle {
            cardUsedAt[p] = nil
            if let c = cards[p], !c.open { cards[p] = nil }
            let id = HostTarget.safariWindow(p, .card).id
            guard engine.isHosted(id) else { continue }
            note("Preview: the card window unused for \(Int(Self.cardIdle / 60)) minutes: closed")
            enqueue { await self.engine.close(id) }
        }
    }

    // ---- the page ----

    func tellPage(_ c: PeekCard) {
        guard let w = window(c.window) else { return }
        let host = URL(string: c.url)?.host ?? ""
        pushPeek(w, ["url": c.url, "title": c.title.isEmpty ? host : c.title, "loading": !c.ready, "spaceId": c.space ?? NSNull()])
    }

    func pushPeek(_ w: HostedWindow, _ peek: JSONObject?) {
        let body: JSONObject = ["type": "peek", "peek": peek ?? NSNull()]
        if let json = jsonString(body) { w.push(json) }
    }

    nonisolated static func webAddress(_ s: String) -> Bool {
        guard s.count <= 2048, let u = URL(string: s), let scheme = u.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }
}
