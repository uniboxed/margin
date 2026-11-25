// Safari's own window mechanics, as the session uses them (docs/CORE-REFACTOR.md step 3, part 2: they stay the Mac's,
// the session's decisions move into the core): a profile with no window woken through Safari's menu (the presses'
// ladder), the windows opened only for that parked out of sight and closed again, the private Space they were parked
// in released, the windows a Safari Margin started restored from its last session closed, and the profiles Safari's
// menu has no item for. Its state is its own; what it asks of the session (the links, the engine, the options, the
// clock, the log, which windows are Margin's) it reads at each look, as the session did when this was part of it.

import Foundation

final class SafariWaker {
    unowned let session: HostedSession
    init(session: HostedSession) { self.session = session }

    private var links: HostedLinks { session.links }
    private var engine: HostedEngine { session.engine }
    private var options: HostedSession.Options { session.options }
    private func now() -> Double { session.now() }
    private func note(_ line: String) { session.note(line) }
    private func secs(since t: Double) -> String { session.secs(since: t) }

    private(set) var wokenByMenu: [String: [Int]] = [:] // a profile woken through Safari's menu: the windows it had then
    // Profiles Safari's menu has no item for by the names Margin has (Safari's profiles unreadable: its own names
    // unknown): not pressed again; a page of theirs opens in the default profile (`profileFallback`). Forgotten when
    // Safari's names are read (the person allowed Safari's folder, SafariFolderGrant).
    private(set) var unopenable: Set<String> = []
    private var wokenLinkedAt: [String: Double] = [:] // ...and when its copy linked
    // ...and the windows its copy had then. A copy can link through a window Safari restored before the press's window is
    // reported (2026-11-20 11:17:35: linked through restored 96 at .340, the press's 152 reported at .642): the press's
    // window then isn't among them, and is found at the close as one that came since (`wokenLate`).
    private var wokenAtLink: [String: Set<Int>] = [:]
    private var wokenHeld = false
    private var swept: [String: String] = [:] // each profile's link epoch already swept

    // Safari's profile names read (the folder grant): every profile may be pressed for again.
    func namesChanged() { unopenable = [] }

    // Decided by Tirth (2026-11-15): when Safari was started by Margin (no Dock icon), the windows Safari restored from its
    // last session are closed, so they don't come back next time (a restored full-screen one stood as its own Space in
    // Mission Control). Only in a Safari Margin started; only the windows its profile's copy lists at the first look after
    // it links (Safari restores before any copy starts), less Margin's own and the ones opened to wake it; once per link;
    // closed by their copy. A window that comes later (a link opened from another app) is never touched, nor any of a
    // Safari the person opened. Called from the shell's poll (HostedSession.sweepRestoredSafariWindows).
    func sweep() {
        // (A window opened to wake a profile, still open `wokenGrace` after its copy linked with nothing asked of it: what
        // it was for went another way. Closed, whoever started Safari.)
        for (p, at) in wokenLinkedAt.sorted(by: { $0.key < $1.key }) where now() - at >= options.wokenGrace && !session.requesting.contains(p) {
            wokenLinkedAt[p] = nil
            Task { [weak self] in await self?.closeWoken(p, why: " (left open: closed later)") }
        }
        if wokenHeld { releaseWokenSpace() } // (one left open once: released when it's gone)
        guard options.closesRestoredSafariWindows else { return }
        guard startedSafari() != nil else { swept = [:]; return }
        for p in links.safariProfiles() where !session.requesting.contains(p) {
            guard let close = restoredToClose(p) else { continue }
            note("Safari started by Margin: \(close.count) window(s) it restored from its last session closed")
            Task { [weak self] in
                guard let self else { return }
                for id in close { _ = await self.links.request(profile: p, "closeWindow", ["windowId": id]) }
            }
        }
    }

    // The Safari Margin started (no Dock icon): its bundle, nil if none runs.
    private func startedSafari() -> String? { options.safariBundles.sorted().first { engine.launchedPid(bundleId: $0) != nil } }
    // The windows profile `p`'s copy lists at its first look since it linked, in a Safari Margin started, less Margin's own
    // and the ones opened to wake it: the ones Safari restored from its last session, to close (once per link; nil: none).
    private func restoredToClose(_ p: String) -> [Int]? {
        guard options.closesRestoredSafariWindows, startedSafari() != nil,
              let epoch = links.linkEpoch(of: p), swept[p] != epoch, let restored = links.restoredWindowIds(of: p) else { return nil }
        swept[p] = epoch
        let ours = Set(session.safariWindows.values).union(session.made_).union(wokenByMenu[p] ?? []) // (every role's window: main's, a card's, a pane's)
        let close = restored.filter { !ours.contains($0) }
        return close.isEmpty ? nil : close
    }
    // A profile just linked (`linked`), in a Safari Margin started that has a full-screen Space of its own (a window it
    // restored in full screen: a quit with the link down left Margin's windows in full screen, a split of two): its
    // restored windows closed before it's said linked, and waited for, gone from its copy's windows and those Spaces gone
    // from the window server's list, `restoredWait` at most. Closed by the poll's sweep instead, they were still closing as
    // Margin asked the profile for its own window: Safari opened that window in their full-screen Space, and macOS gave
    // it no full-screen Space of its own (2026-11-25 12:50:14-22: the open failed, Safari was quit and started again, the
    // page stayed on Mail meanwhile). With no such Space nothing is waited for here: the sweep closes them as before.
    // Each wait ends on its evidence.
    private func closeRestored(_ p: String) async {
        guard options.closesRestoredSafariWindows, let bundle = startedSafari(),
              let spaces = engine.ownFullScreenSpaces(bundleId: bundle), !spaces.isEmpty else { return }
        let started = now()
        // (Its copy's first look since the link, which says the restored windows, comes a moment after the link.)
        _ = await session.wait(options.restoredWait) { self.links.restoredWindowIds(of: p) != nil }
        guard let close = restoredToClose(p) else { return }
        for id in close { _ = await links.request(profile: p, "closeWindow", ["windowId": id]) }
        let left = { max(0, self.options.restoredWait - (self.now() - started)) }
        let gone = await session.wait(left()) { Set(self.links.windowIds(of: p)).isDisjoint(with: close) }
        let spacesGone = await session.wait(left()) { (self.engine.fullScreenSpacesListed(spaces) ?? []).isEmpty }
        note("Safari started by Margin: \(close.count) window(s) it restored from its last session closed\(gone ? "" : " (not all gone)"), "
             + "\(spaces.count) full-screen Space\(spaces.count == 1 ? "" : "s") of Safari's \(spacesGone ? "gone" : "still listed") in \(secs(since: started)) s, "
             + "before Margin's own window is asked")
    }

    // A profile's copy linked, waking it through Safari's menu if it has no window. Evidence decides, time only paces
    // (Tirth, 2026-11-17: "time only paces retries and drives feedback"): its link taken the moment it comes (never a
    // fixed wait first); Safari's menu pressed once Safari's own copies have had their turn (a copy of a window it
    // restored links by itself) and pressed again only while no window came of a press (a Safari still starting does
    // nothing at one), never once one did; given up only on evidence: what it was for isn't wanted any more (`wakeIf`,
    // else the show waiting on it overtaken by another pick), Safari quit, or every press opened nothing. While a window
    // came and the copy hasn't linked (2026-11-17: another build of Margin's extension handler in use made Safari refuse
    // its native messages for 15–35 s), it's waited for, said every `linkSayEvery`.
    // `wakeIf`: asked right before each press and at each look; false: not woken, or no longer waited for.
    func linked(_ profile: String?, wakeIf wanted: (() -> Bool)? = nil) async -> Bool {
        let p = session.resolve(profile)
        if links.safariProfiles().contains(p) {
            await closeRestored(p)
            return true
        }
        // (Margin quits: Safari isn't started nor its menu pressed for a profile any more.)
        if engine.quitting {
            note("a Safari profile not linked: Margin quits: not woken")
            return false
        }
        let wanted = wanted ?? { self.session.linkWanted(p) }
        let started = now()
        var ranAtStart = engine.appRuns(bundleId: safariIdentifier) == true
        // Safari not running at all: no copy of its own links and its menu can't be pressed. Started now (no Dock icon, as
        // Margin's start does it), then waited for as usual; one that doesn't start, not waited for. (2026-11-20 13:45:
        // Margin had quit the Safari it started after a failed preparation; the show after it waited 30 s, pressing the
        // menu of a Safari that wasn't there.)
        if engine.appRuns(bundleId: safariIdentifier) == false {
            guard await engine.start(bundleId: safariIdentifier) != nil else {
                note("a Safari profile not linked: Safari isn't running and didn't start: not waited for")
                return false
            }
            note("a Safari profile not linked: Safari wasn't running: started (no Dock icon)")
            ranAtStart = true
        }
        let seenBefore = engine.wokenWindows(bundleId: safariIdentifier)
        var presses = 0, pressedAt = started, saidAt = started
        // (Its own copies first: a Safari just started has no menus and no copies for a while, ~4–12 s to the first link,
        // and the profile may be among the windows it restores. Pressed once one has linked and it isn't this profile's,
        // or after `firstCopiesPace` with none.)
        if links.safariProfiles().isEmpty { note("a Safari profile not linked yet: Safari's own copies waited for first (a window it restores links by itself)") }
        while !links.safariProfiles().contains(p) {
            // (Safari's menu has no item by the name Margin has for it: pressing again can't open it. Said at once, not after
            // four presses and 15 s: the caller opens the default profile instead, `profileFallback`.)
            if unopenable.contains(p) {
                note("a Safari profile with no window: Safari's menu has no item by the name Margin has for it (Safari's profiles not readable: its own names unknown): not woken, \(secs(since: started)) s")
                if wokenByMenu.isEmpty { engine.releaseWoken(bundleId: safariIdentifier) }
                return false
            }
            guard wanted() else {
                note(presses == 0 ? "a Safari profile with no window: not woken (what it was for isn't wanted any more)"
                                  : "a Safari profile woken: its copy no longer waited for (what it was for isn't wanted any more), \(secs(since: started)) s")
                return false
            }
            // (Margin quits: its quit gives back every window a press opened, which a look would take for a press that
            // opened nothing and press again: 2026-11-24 09:15:42, Safari's menu pressed 0.07 s after the quit.)
            if engine.quitting {
                note("a Safari profile's copy no longer waited for: Margin quits (\(presses) press\(presses == 1 ? "" : "es"), \(secs(since: started)) s)")
                return false
            }
            if ranAtStart, engine.appRuns(bundleId: safariIdentifier) == false {
                note("Safari quit while its profile's copy was waited for (\(secs(since: started)) s)")
                return false
            }
            let t = now()
            let opened = engine.wokenWindows(bundleId: safariIdentifier) - seenBefore // (also parks them out of sight now)
            let press: Bool
            if presses == 0 { press = !links.safariProfiles().isEmpty || t - started >= options.firstCopiesPace }
            else { press = opened == 0 && t - pressedAt >= options.pressPace * Double(presses) }
            if press {
                guard presses < options.wakePresses else {
                    note("a Safari profile with no window: \(presses) presses of Safari's menu opened no window (\(secs(since: started)) s): given up")
                    return false
                }
                presses += 1
                pressedAt = t
                // (The window it opens is parked out of sight as soon as it's listed: it opens in the current Space, Margin's,
                // and would show through the page area over what's shown.)
                engine.hideWoken(bundleId: safariIdentifier)
                if links.openProfileWindow(p, pressed: { [weak self] ok in if !ok { self?.unopenable.insert(p) } }) {
                    note("a Safari profile with no window: one opened from Safari's menu so its copy links (press \(presses)\(presses > 1 ? ": no window came of the one before" : ""))")
                    if wokenByMenu[p] == nil { wokenByMenu[p] = [] }
                } else {
                    note("a Safari profile with no window: Safari's menu couldn't be pressed (press \(presses))")
                    if wokenByMenu.isEmpty { engine.releaseWoken(bundleId: safariIdentifier) } // (nothing pressed: nothing to hide)
                }
            }
            if t - saidAt >= options.linkSayEvery {
                saidAt = t
                note("a Safari profile's copy not linked yet after \(secs(since: started)) s (\(presses == 0 ? "Safari's own copies first" : opened > 0 ? "its window opened: its copy waited for" : "no window of the press yet")); linked: \(links.safariProfiles().count) profile(s)")
            }
            await session.sleep(options.every)
        }
        note("a Safari profile linked in \(secs(since: started)) s\(presses == 0 ? "" : " (\(presses) press\(presses == 1 ? "" : "es") of Safari's menu)")")
        if wokenByMenu[p] != nil {
            _ = await session.wait(1.5) { !self.links.windowIds(of: p).isEmpty }
            await closeRestored(p) // (before the windows at the link are taken for the press's)
            wokenByMenu[p] = links.windowIds(of: p)
            wokenAtLink[p] = Set(links.windowIds(of: p))
            wokenLinkedAt[p] = now()
        } else {
            await closeRestored(p)
        }
        return true
    }

    // The windows opened only to wake a profile, closed by its copy (Margin opened them; they hold no page of the
    // person's), whatever happened to what they were for: Margin's window made for it (`except`), the preparation given
    // up, or left open past `wokenGrace` (the poll). One not closed is tried again by the poll. All closed: the private
    // Space they were parked in released.
    // Closed within `wokenLate` of the link, a window of the profile that came since and isn't Margin's is the press's
    // too (the copy linked through a restored one first): closed with them. Later, only those known at the link: a
    // window that comes later (a link opened from another app) is the person's. The private Space is released only once
    // every window parked in it is closed: retired with one still in it, macOS puts that one in the current Space,
    // Margin's, over the page area (2026-11-20: Safari's page drawn over Maps until another tab was picked).
    func closeWoken(_ p: String, except made: Int? = nil, why: String = "") async {
        guard var ids = wokenByMenu.removeValue(forKey: p) else { return }
        let linkedAt = wokenLinkedAt.removeValue(forKey: p)
        let atLink = wokenAtLink.removeValue(forKey: p) ?? Set(ids)
        if let linkedAt, now() - linkedAt <= options.wokenLate {
            let ours = Set(session.safariWindows.values).union(session.made_).union(made.map { [$0] } ?? [])
            let late = links.windowIds(of: p).filter { !atLink.contains($0) && !ours.contains($0) && !ids.contains($0) }
            if !late.isEmpty { note("the window opened to wake the profile: \(late.count) more that came after its copy linked (it linked through another)"); ids += late }
        }
        var left: [Int] = []
        for id in ids where id != made && !session.made_.contains(id) {
            let (_, error) = await links.request(profile: p, "closeWindow", ["windowId": id])
            if error != nil, links.windowIds(of: p).contains(id) { left.append(id) }
            note("the window opened to wake the profile closed\(why): \(error ?? "ok")")
        }
        if !left.isEmpty, wokenByMenu[p] == nil {
            wokenByMenu[p] = left
            wokenAtLink[p] = Set(left)
            wokenLinkedAt[p] = now()
        }
        releaseWokenSpace()
    }
    // The private Space the woken windows were parked in, released once nothing's woken any more and none of them is
    // still open (else the poll looks again: `sweep`).
    private func releaseWokenSpace() {
        guard wokenByMenu.isEmpty else { return }
        let open = engine.wokenParked(bundleId: safariIdentifier)
        guard open.isEmpty else {
            if !wokenHeld { wokenHeld = true; note("the private Space of the windows opened to wake a profile kept: \(open.count) of them still open (never let into Margin's Space)") }
            return
        }
        wokenHeld = false
        engine.releaseWoken(bundleId: safariIdentifier)
    }
}
