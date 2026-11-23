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
//
// The state machine and its flows are margin-core's (core/session/card.rs, docs/CORE-REFACTOR.md step 3 part 4): this
// is the facade (the same calls, each the core's `peek` input), and what the layout, the page area's moves and the
// loading bar (parts 3, 7 and 8, still Swift's) read of a card.

import AppKit
import MarginCore

// One profile's card (the core's session/state.rs `Card`, read through `cards`).
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

    // As the core's `cards` rows have it (session/state.rs): its profile, and its parts as JSON text, [window, opener,
    // space, url, title, open, ready, fresh, rect, hiddenBy, click].
    init?(row: CoreRow) {
        guard let profile = row.s0, let text = row.s1, let r = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [Any], r.count == 11,
              let window = int(r[0]), let opener = r[1] as? String, let url = r[3] as? String, let title = r[4] as? String,
              let open = r[5] as? Bool, let ready = r[6] as? Bool, let fresh = r[7] as? Bool else { return nil }
        (self.profile, self.window, self.opener, self.space, self.url, self.title) = (profile, window, opener, r[2] as? String, url, title)
        (self.open, self.ready, self.fresh, self.hiddenBy, self.click) = (open, ready, fresh, r[9] as? String, r[10] as? String)
        if let n = r[8] as? [Any], n.count == 4, let x = num(n[0]), let y = num(n[1]), let w = num(n[2]), let h = num(n[3]) { rect = CGRect(x: x, y: y, width: w, height: h) }
    }
    var cells: String? {
        jsonString([window, opener, space ?? NSNull(), url, title, open, ready, fresh, rect.map(HostedSession.json) ?? NSNull(), hiddenBy ?? NSNull(), click ?? NSNull()] as [Any])
    }
}

extension HostedSession {
    static let cardPrefix = "card:"
    static let cardIdle = 15 * 60.0 // (the core's CARD_IDLE: the tests move their clock past it)
    static func cardItem(_ profile: String) -> String { cardPrefix + profile }
    static func isCardItem(_ item: String?) -> Bool { item?.hasPrefix(cardPrefix) == true }
    private static let cardTag = "peek-card" // the copy's tag for the card's page (background/hosted.ts CARD_ITEM)

    // Margin's default card rect in a page area (a theme with no `<m-preview-page>`): the core's session/card.rs
    // `default_card_rect` (centred, 8% each side and 7% above and below at most, its page under a 52 pt bar).
    nonisolated static func defaultCardRect(page: CGRect) -> CGRect { CGRect(margin_card_default_rect(page.marginRect)) }

    // An item that's a pin's or a favorite's tab (the library's `pinnedBy`, `favoriteId`): its page's links to other
    // sites open in a card (auto-preview, settings.autoPeekPins), told to the copy with each hostShow. The core's.
    func pinnedOrFavorite(_ item: String) -> Bool { core.pinned(item) }

    // ---- what the layout needs of a card (HostedSession.applyLayout: part 3's, still Swift's) ----

    func cardPart(_ item: String, rect: CGRect?) -> LayoutPart? {
        guard Self.isCardItem(item) else { return nil }
        let p = String(item.dropFirst(Self.cardPrefix.count))
        guard let c = cardPages[p] else { return nil }
        let target = HostTarget.safariWindow(p, .card)
        labels[target.id] = "Safari"
        return LayoutPart(item: item, target: target, profile: p, url: c.url, role: .card, rect: rect)
    }

    // The copy's hostShow for the card's page: in the card's window only (`role`), at its address when it's a new one.
    func cardShowPayload(_ item: String, windowId: Int) -> JSONObject? {
        guard Self.isCardItem(item) else { return nil }
        let p = String(item.dropFirst(Self.cardPrefix.count))
        guard let c = cardPages[p] else { return nil }
        var out: JSONObject = ["windowId": windowId, "itemId": Self.cardTag, "url": c.url.isEmpty ? "about:blank" : c.url, "role": "card"]
        if c.fresh { out["fresh"] = true }
        return out
    }

    // The engine's slow step for a card's window (its first open): the card's own loader (it says `loading` until it's
    // in place), never the page card's over main. True: a card's, taken here. (The loading bar's, part 8.)
    func cardLoadingStep(_ id: HostID?) -> Bool {
        if let id, id.safariRole == .card { cardLoading = id; return true }
        if id == nil, cardLoading != nil { cardLoading = nil; return true }
        return false
    }

    // The card a Margin window shows (one open card in a window: the core's).
    func openCard(in windowId: Int) -> PeekCard? { cards.values.first { $0.window == windowId && $0.open } }

    // The card's window at its <m-preview-page> as the page lays it out now (a page area's change, a drag's frame), by its
    // host; empty: no card in place there. (The page area's moves, part 7's.)
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

    // ---- the copy's word (Shell.swift routes its pushes here): the core's ----

    // (A page's click, `peekOpen`: HostedSession's, typed.)
    // The copy gave up on a click before the app's word reached it: its card, if shown, closed again.
    func peekCancel(profile: String, msg: JSONObject) { peek("cancel", ["profile": profile, "msg": SessionRules.json(msg)]) }
    // The card's page now (the copy's `cardPage { url, title }`): its bar follows.
    func cardPage(profile: String, windowId: Int?, msg: JSONObject) {
        peek("page", ["profile": profile, "window": windowId ?? NSNull(), "msg": SessionRules.json(msg)])
    }
    // Esc or ⌘↩ in the card's page (the copy's `cardKey { key }`).
    func cardKey(profile: String, windowId: Int?, key: String) { peek("key", ["profile": profile, "window": windowId ?? NSNull(), "key": key]) }

    // ---- the page's word (LibraryWindowSource.perform: `peek.*`, ⌘W): the core's ----

    // Quick Tab's field up in window `windowId`; its choice (the card at that address over the window's item; nothing
    // hosted there: the space's new tab).
    func littleArcOpened(windowId: Int?, spaceId: String?) { peek("quickTab", ["window": windowId ?? NSNull(), "space": spaceId ?? NSNull()]) }
    func littleArcGo(windowId: Int?, url: String, spaceId: String?) {
        peek("quickTabGo", ["window": windowId ?? NSNull(), "url": url, "space": spaceId ?? NSNull()])
    }

    // The card in window `windowId` closed (or Quick Tab's field): the page told first unless it closed it itself
    // (`tellPage` false). False: no card there.
    @discardableResult func closeCard(windowId: Int?, why: String, tellPage: Bool = true) -> Bool {
        peek("close", ["window": windowId ?? NSNull(), "why": why, "tellPage": tellPage]) as? Bool == true
    }
    // ⌘W in window `windowId`: the card there, or Quick Tab's field, closed; never the item under it. False: neither.
    func closeCardForKey(windowId: Int?) -> Bool { peek("closeForKey", ["window": windowId ?? NSNull()]) as? Bool == true }
    // Expand: the card's page a new item of its space, its tab moved into the profile's main window, shown as main.
    func expandCard(windowId: Int?, spaceId: String?) { peek("expand", ["window": windowId ?? NSNull(), "space": spaceId ?? NSNull()]) }
    // The card's Back and Forward: its page's history.
    func cardHistory(windowId: Int?, back: Bool) { peek("history", ["window": windowId ?? NSNull(), "back": back]) }

    // ---- the card windows' own lives: the core's ----

    // A host gone: a card window's card forgotten; a profile's main window's: its card window closed with it.
    func cardHostGone(_ id: HostID) { peek("hostGone", ["host": id.raw]) }
    // Card windows not used for `cardIdle` (parked, no card open): closed (the shell's poll, through the sweep).
    func closeIdleCards() { peek("idle") }
    // The page's <m-preview-page> moved (a resize, another theme): the card laid out there again.
    func cardRectChanged(_ w: HostedWindow) { peek("rect", ["window": w.id]) }

    // An http or https address Foundation's URL(string:) makes a URL of, at most 2,048 scalars (the core's
    // session/card.rs `web_address`; a host outside ASCII by the OS's IDNA: SessionRules.webAddress).
    nonisolated static func webAddress(_ s: String) -> Bool { SessionRules.webAddress(s) }
}
