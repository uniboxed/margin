// Safari's own UI never shown on a Margin profile's full-screen window, not even while Safari opens (asked
// 2026-11-07: "i should never see safari's ui at all even when i am opening safari for the first time").
//
// A Margin layout needs its copy linked and its overlay page drawn: about 1-2 s after Safari opens its windows.
// Until then each such window is covered: a plain panel in Margin's frame tone over the whole window, in that
// window's Space (on screen: just above it; in another Space: placed there, as Overlay.placeAhead does). It goes
// as soon as the window's overlay is shown over it, or placed in its Space; when the window is gone, out of full
// screen, parked or in a switch; at once when no layout is coming (Safari refusing the link's hand-off, 2026-11-09:
// a cover held its 6 s for nothing); or after `coverFor` at the latest, so Safari is never kept covered. The mouse
// passes through it.
//
// Only a window Accessibility names (SafariAX: its title's profile) and only a profile Margin has data for or a
// link with (a profile without Margin, or a window not named yet, is never covered). Its own loop, at 10 Hz
// while Safari runs and a window wants it, apart from track(), which waits for a linked browser in front.

import AppKit

final class SafariCover {
    let number: Int // the Safari window it covers
    let since: Double
    let panel: NSPanel
    init(number: Int, since: Double) {
        self.number = number
        self.since = since
        panel = NSPanel(contentRect: NSRect(x: -20000, y: -20000, width: 100, height: 100), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = true
        panel.hasShadow = false
        panel.animationBehavior = .none
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.managed, .fullScreenAuxiliary, .ignoresCycle]
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        panel.backgroundColor = dark ? NSColor(calibratedWhite: 0.11, alpha: 1) : NSColor(calibratedWhite: 0.93, alpha: 1)
    }
    func close() { panel.orderOut(nil); panel.close() }
}

/// Which of Safari's windows want a cover now, and which covers go (pure: the shell's covers loop carries it out).
enum CoverPlan {
    struct Facts {
        var candidates: [ServerWindow] = [] // Safari's windows (WindowMatcher.candidates)
        var profiles: [Int: String] = [:] // the profile Accessibility named for each
        var marginProfiles: Set<String> = [] // profiles Margin has data for or a link with
        var laidOut: Set<Int> = [] // windows an overlay is over (shown, or placed in its Space)
        var parked: Set<Int> = []
        var switchBusy = false
        var expired: Set<Int> = [] // covered long enough once: never again
        var linkStalled = false // no layout is coming: Safari refuses the link's hand-off (2 in a row)
        var covers: [Int: Double] = [:] // the covers there, by window, since when
        var fills: (CGRect) -> Bool = { _ in false }
        var now: Double = 0
    }
    struct Plan: Equatable {
        var wanted: [Int] = [] // windows that want a cover (made if they have none), in order
        var close: [Int] = [] // covers that go
        var expire: [Int] = [] // of those, the ones covered long enough (never again for that window)
    }

    static func decide(_ f: Facts, coverFor: Double = Shell.coverFor) -> Plan {
        var plan = Plan()
        for w in f.candidates.sorted(by: { $0.number < $1.number }) {
            guard let link = f.profiles[w.number], f.marginProfiles.contains(link), !f.laidOut.contains(w.number), !f.parked.contains(w.number),
                  !f.switchBusy, !f.expired.contains(w.number), f.fills(w.bounds) || f.covers[w.number] != nil else { continue }
            plan.wanted.append(w.number)
        }
        let wanted = Set(plan.wanted)
        for (n, since) in f.covers.sorted(by: { $0.key < $1.key }) where !wanted.contains(n) || f.now - since >= coverFor || f.linkStalled {
            plan.close.append(n)
            if f.now - since >= coverFor || f.linkStalled { plan.expire.append(n) }
        }
        // (No layout coming: no new cover either.)
        if f.linkStalled { plan.wanted = [] }
        plan.wanted.removeAll { n in plan.expire.contains(n) }
        return plan
    }
}

extension Shell {
    static let coverFor: Double = 6
    static let coverEvery: Double = 0.1

    /// Safari launched or came forward: the covers' loop runs (it stops itself when nothing wants a cover).
    func coversSoon() {
        guard options.safariAX, coverTimer == nil else { return }
        coverTimer = Timer.scheduledTimer(withTimeInterval: Self.coverEvery, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateCovers() }
        }
        updateCovers()
    }

    func endCovers() {
        coverTimer?.invalidate()
        coverTimer = nil
        for c in covers.values { c.close() }
        covers = [:]
    }

    func updateCovers() {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").map(\.processIdentifier))
        guard options.safariAX, SafariAX.trusted, !pids.isEmpty else {
            coverExpired = []
            return endCovers()
        }
        // A read the window server didn't answer: this tick skipped (covers kept as they are).
        guard let list = windowSource.read(of: pids.union([ProcessInfo.processInfo.processIdentifier])) else { return }
        let now = Diagnostics.now()
        let exact = safariExact(list: list, pids: pids)
        // (The map kept from this read too while covers are wanted: the trace has Safari's launch.)
        if !started || !covers.isEmpty {
            let changes = windowMap.update(now: now, list: list, browserPids: pids, marginPid: ProcessInfo.processInfo.processIdentifier, front: apps.frontPid, ax: ax,
                                           parked: parking?.numbers ?? [])
            options.trace?.map(windowMap.snapshot, changes)
        }
        var facts = CoverPlan.Facts()
        facts.candidates = WindowMatcher.candidates(list, pids: pids)
        facts.profiles = exact
        facts.marginProfiles = Set(data.profiles(browser: "safari").map(\.key)).union(links.keys)
        // Windows a layout is over already: shown over it, or placed in its Space.
        facts.laidOut = Set(overlays.values.filter { $0.isShown }.compactMap(\.aboveWindow))
        facts.parked = parking?.numbers ?? []
        facts.switchBusy = switcher.busy
        facts.expired = coverExpired
        facts.linkStalled = link.refusedInARow >= 2
        facts.covers = covers.mapValues(\.since)
        facts.fills = { [weak self] b in self?.fillsDisplay(b) ?? false }
        facts.now = now
        let plan = CoverPlan.decide(facts)
        let byNumber = Dictionary(list.map { ($0.number, $0) }, uniquingKeysWith: { a, _ in a })
        var wanted: [Int: ServerWindow] = [:]
        for n in plan.wanted { if let w = byNumber[n] { wanted[n] = w } }
        // Gone: laid out, closed, out of full screen, or covered long enough (never again for that window).
        for n in plan.close {
            if plan.expire.contains(n) {
                coverExpired.insert(n)
                if facts.linkStalled { Diagnostics.note("cover over window \(n) taken away: no layout is coming (Safari refuses the link's hand-off)") }
                else { Diagnostics.note("cover over window \(n) taken away after \(Int(Self.coverFor)) s: its layout wasn't ready") }
            }
            covers[n]?.close()
            covers[n] = nil
        }
        coverExpired = coverExpired.filter { n in list.contains { $0.number == n } }
        for (n, w) in wanted.sorted(by: { $0.key < $1.key }) where covers[n] == nil && !coverExpired.contains(n) {
            let c = SafariCover(number: n, since: now)
            let frame = ScreenGeometry.appKitRect(w.bounds)
            c.panel.setFrame(frame, display: true)
            if w.onScreen {
                c.panel.order(.above, relativeTo: n)
            } else {
                guard let reads = spaceReads, let bridge = reads as? SpaceBridge, bridge.canPark,
                      ax.fullScreen[n] != false, let space = reads.spaces(of: n)?.first, reads.fullScreenSpaces()?.contains(space) == true else { c.close(); continue }
                c.panel.alphaValue = 0
                c.panel.order(.above, relativeTo: n)
                let moved = bridge.add(c.panel.windowNumber, to: space)
                c.panel.alphaValue = 1
                guard moved else { c.close(); continue }
            }
            covers[n] = c
            Diagnostics.note("cover over window \(n) (\(exact[n] ?? "?")): until its layout is ready")
        }
        // Kept just above its window (Safari raises its window as it opens).
        for (n, c) in covers where wanted[n]?.onScreen == true { c.panel.order(.above, relativeTo: n) }
        if covers.isEmpty, wanted.isEmpty, coverTimer != nil, now - (coverQuietSince ?? now) >= 3 {
            coverTimer?.invalidate()
            coverTimer = nil
            coverQuietSince = nil
        } else if covers.isEmpty, wanted.isEmpty {
            coverQuietSince = coverQuietSince ?? now
        } else {
            coverQuietSince = nil
        }
    }
}
