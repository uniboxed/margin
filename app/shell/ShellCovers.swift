// Safari's own UI never shown on a Margin profile's full-screen window, not even while Safari opens (Tirth,
// 2026-11-07: "i should never see safari's ui at all even when i am opening safari for the first time").
//
// A Margin layout needs its copy linked and its overlay page drawn: about 1-2 s after Safari opens its windows.
// Until then each such window is covered: a plain panel in Margin's frame tone over the whole window, in that
// window's Space (on screen: just above it; in another Space: placed there, as Overlay.placeAhead does). It goes
// as soon as the window's overlay is shown over it, or placed in its Space; when the window is gone, out of full
// screen, parked or in a switch; or after `coverFor` at the latest, so Safari is never kept covered. The mouse
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
        guard options.safariAX, SafariAX.trusted, !pids.isEmpty, let list = windowSource.read(of: pids) else {
            coverExpired = []
            return endCovers()
        }
        let now = Diagnostics.now()
        let exact = safariExact(list: list, pids: pids)
        let marginProfiles = Set(data.profiles(browser: "safari").map(\.key)).union(links.keys)
        // Windows a layout is over already: shown over it, or placed in its Space.
        let laidOut = Set(overlays.values.filter { $0.isShown }.compactMap(\.aboveWindow))
        let parked = parking?.numbers ?? []
        var wanted: [Int: ServerWindow] = [:]
        for w in WindowMatcher.candidates(list, pids: pids) {
            guard let link = exact[w.number], marginProfiles.contains(link), !laidOut.contains(w.number), !parked.contains(w.number),
                  !switcher.busy, !coverExpired.contains(w.number), fillsDisplay(w.bounds) || covers[w.number] != nil else { continue }
            wanted[w.number] = w
        }
        // Gone: laid out, closed, out of full screen, or covered long enough (never again for that window).
        for (n, c) in covers where wanted[n] == nil || now - c.since >= Self.coverFor {
            if now - c.since >= Self.coverFor {
                coverExpired.insert(n)
                Diagnostics.note("cover over window \(n) taken away after \(Int(Self.coverFor)) s: its layout wasn't ready")
            }
            c.close()
            covers[n] = nil
        }
        coverExpired = coverExpired.filter { n in list.contains { $0.number == n } }
        for (n, w) in wanted.sorted(by: { $0.key < $1.key }) where covers[n] == nil {
            let c = SafariCover(number: n, since: now)
            let frame = ScreenGeometry.appKitRect(w.bounds)
            c.panel.setFrame(frame, display: true)
            if w.onScreen {
                c.panel.order(.above, relativeTo: n)
            } else {
                guard let reads = spaceReads, let bridge = reads as? SpaceBridge, bridge.canPark,
                      let space = reads.spaces(of: n)?.first, reads.fullScreenSpaces()?.contains(space) == true else { c.close(); continue }
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
