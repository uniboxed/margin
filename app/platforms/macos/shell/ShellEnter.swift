// Opening Margin (2026-11-15): Margin is what the person opens, and its
// browser's window comes up inside it, in place of Margin waiting for a
// browser to be opened and put in full screen by hand.
//
// - Asked by the app when it's opened by hand or opened again
//   (AppDelegate.swift): `enter`. Off unless `MarginOpensBrowser` is set, or
//   the slot is on (Shell.forApp); off, opening Margin shows the set-up window,
//   as before.
// - The window: the one the person last used among the linked copies' windows
//   (EnterPick), asked of its copy with the request the profile switch already
//   sends (focusWindow, in full screen), and its browser brought to the front.
//   From there everything is as it was: the overlay over the full-screen
//   window, its page in the slot (ShellSlot.swift) or the page box.
// - No window to open into: the browser is opened, once (started if it isn't
//   running, asked for a window if it has none): a linked one, else one that's
//   running, else the one Margin was last linked with (Safari the first time).
//   Then its copy's link and its window are waited for.
// - Nothing to open into within `enterWait`: the app is told why, and shows its
//   set-up window (the extension isn't on, or the browser isn't installed).
//
// Nothing here starts a browser a second time, changes a setting of it, or
// touches its windows except through its own extension.

import AppKit

enum EnterResult: Equatable {
    case window(WindowKey)
    case failed(String)
}

enum EnterPick {
    // The window Margin opens into: among the copies' windows that aren't parked, one that isn't
    // minimized if there is one; of those the focused one, then the one focused last, then the one
    // made last, then the lowest id of the first link (so the same list always gives the same window).
    static func pick(_ windows: [ExtWindow], skip: (WindowKey) -> Bool = { _ in false }) -> WindowKey? {
        let usable = windows.filter { !skip($0.key) }
        let shown = usable.filter { $0.state != "minimized" }
        func before(_ a: ExtWindow, _ b: ExtWindow) -> Bool {
            if a.focused != b.focused { return a.focused }
            if (a.focusedAt ?? 0) != (b.focusedAt ?? 0) { return (a.focusedAt ?? 0) > (b.focusedAt ?? 0) }
            if (a.createdAt ?? 0) != (b.createdAt ?? 0) { return (a.createdAt ?? 0) > (b.createdAt ?? 0) }
            return a.key < b.key
        }
        return (shown.isEmpty ? usable : shown).min(by: before)?.key
    }

    // The browser to open when there's no window: a linked one, else one that's running, else the last one linked.
    static func browser(linked: [String], running: [String], last: String, known: [String]) -> String? {
        if let b = linked.sorted().first(where: known.contains) { return b }
        if running.contains(last), known.contains(last) { return last }
        if let b = running.sorted().first(where: known.contains) { return b }
        return known.contains(last) ? last : nil
    }
}

// One opening, from the ask to its answer.
final class Entering {
    let since: TimeInterval
    let until: TimeInterval
    var opened: String? // the browser opened for it (once)
    var asked: WindowKey? // the window asked of its copy
    var done: [(EnterResult) -> Void]
    var timer: Timer?
    init(since: TimeInterval, until: TimeInterval, done: @escaping (EnterResult) -> Void) {
        self.since = since
        self.until = until
        self.done = [done]
    }
}

extension Shell {
    // Margin opened: its browser's window in front, in full screen, with Margin around it. Asked again
    // while one is under way, both are answered by the one.
    func enter(done: @escaping (EnterResult) -> Void = { _ in }) {
        // Hosted: Margin's own window opens, never the browser to draw over (ShellHostedGlue.swift).
        if options.hosted { return done(.failed("Margin hosts the browser itself (MarginHosted)")) }
        if let entering {
            entering.done.append(done)
            return
        }
        let now = Diagnostics.now()
        let run = Entering(since: now, until: now + options.enterWait, done: done)
        entering = run
        Diagnostics.note("open: Margin opened: its browser's window comes up inside it")
        run.timer = Timer.scheduledTimer(withTimeInterval: options.enterEvery, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.enterStep() }
        }
        enterStep()
    }

    // Every `enterEvery` while one is under way: the window asked for once there is one; the browser
    // opened once while there isn't; given up at `until`.
    func enterStep() {
        guard let run = entering, run.asked == nil else { return }
        let linked = links.keys.filter { isLinked($0) }.sorted()
        let all = linked.flatMap { ExtWindow.parse(links[$0]?.mirror.windows ?? [], link: $0) }
        if let key = EnterPick.pick(all, skip: { self.isParkedKey($0) }) {
            run.asked = key
            let state = all.first { $0.key == key }?.state ?? "?"
            let took = Int((Diagnostics.now() - run.since) * 1000)
            Diagnostics.note("open: \(key) (\(state)), asked for in full screen and in front, \(took) ms after Margin was opened")
            // Its browser in front too (a window focused in an app that isn't doesn't come forward).
            if run.opened == nil, let browser = links[key.link]?.connection.hello.browser { openBrowser(browser, for: run, why: "its window is the one to open into") }
            request(key.link, "focusWindow", ["windowId": key.windowId, "fullscreen": true], windowId: key.windowId) { [weak self] _, error in
                self?.enterDone(error.map { .failed("the window couldn't be brought up (\($0))") } ?? .window(key))
            }
            return
        }
        if run.opened == nil {
            let known = options.bundleIds
            let running = known.filter { !apps.pids(of: $0.value).isEmpty }.map(\.key)
            let linkedBrowsers = linked.compactMap { links[$0]?.connection.hello.browser }
            guard let browser = EnterPick.browser(linked: linkedBrowsers, running: running, last: options.enterBrowser(), known: Array(known.keys)) else {
                return enterDone(.failed("no browser Margin works in is known"))
            }
            let why = linkedBrowsers.contains(browser) ? "linked, with no window to open into" : running.contains(browser) ? "running, not linked yet" : "not running"
            openBrowser(browser, for: run, why: why)
        }
        if Diagnostics.now() >= run.until {
            enterDone(.failed(linked.isEmpty ? "no browser's copy of Margin linked within \(Int(options.enterWait)) s" : "no window to open into within \(Int(options.enterWait)) s"))
        }
    }

    private func openBrowser(_ browser: String, for run: Entering, why: String) {
        run.opened = browser
        guard let bundleId = options.bundleIds[browser] else { return }
        let opened = options.openBrowser(bundleId)
        Diagnostics.note("open: \(browser) (\(why)): \(opened ? "opened" : "couldn't be opened (not installed?)")")
    }

    private func enterDone(_ result: EnterResult) {
        guard let run = entering else { return }
        entering = nil
        run.timer?.invalidate()
        let took = Int((Diagnostics.now() - run.since) * 1000)
        switch result {
        case .window(let key): Diagnostics.note("open: \(key) answered in \(took) ms")
        case .failed(let why): Diagnostics.note("open: given up after \(took) ms: \(why)")
        }
        for done in run.done { done(result) }
    }

    // Stopping: one under way is over, and answered so.
    func enterStopped() {
        guard entering != nil else { return }
        enterDone(.failed("Margin is quitting"))
    }

    // The app's way to open a browser: started, or brought to the front (one running with no window makes one).
    nonisolated static func openBrowserApp(_ bundleId: String) -> Bool {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return false }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            guard let error else { return }
            let text = error.localizedDescription
            DispatchQueue.main.async { MainActor.assumeIsolated { Diagnostics.note("open: the browser couldn't be opened: \(Diagnostics.scrub(text, max: 160))") } }
        }
        return true
    }
}
