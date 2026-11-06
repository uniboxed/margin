// Margin's app: its set-up window (ViewController.swift, from the converter's
// storyboard) while it's open, and otherwise running on with no window and no
// Dock icon (an accessory app), linked to Margin's extension copies and
// drawing Margin around the browser's windows (app/shell/Shell.swift), which
// does nothing until a linked browser is in front. Opening the app again
// shows the set-up window again. Quitting, the copies are told first; a
// SIGTERM quits the same way. scripts/safari.sh puts a new build in place of
// the installed one, then sends a SIGTERM to the Margin.app it found running
// from there (a KILL after 5 s), and if Safari is running and nothing has
// started the new build in 2 s, opens it with --background (no set-up
// window). Started by the extension handler for a link (Tirth, 2026-11-05: no
// login item needed), there's no set-up window either: the handler's
// arguments never reach a sandboxed caller's app, so it leaves a note instead
// (startedForLink). With no copy linked for 10 minutes (and no set-up
// window), it quits by itself. Replaced on disk some other way, it notices and
// quits (BundleWatch.swift), and starting, it ends any other instance of its
// bundle first. Copied over the converter's by scripts/make-xcode.sh.

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    private let shell = Shell.forApp()
    private var setup: NSWindowController?
    private var closing: NSObjectProtocol?
    private var terminating: DispatchSourceSignal?
    // The executable as it was at launch; quits once another build is in its place.
    private var bundle: BundleWatch?

    func applicationDidFinishLaunching(_ notification: Notification) {
        bundle = BundleWatch(quit: { RunLoop.main.perform { NSApp.terminate(nil) } })
        // The storyboard's window, shown at launch (but opened with --background).
        // How it started goes in the log (a run with the set-up window open is a regular app with a
        // Dock icon, and doesn't quit by itself while that window is open).
        if let window = NSApp.windows.first(where: { $0.contentViewController is ViewController }) {
            keep(window)
            let background = CommandLine.arguments.contains("--background")
            if background || Self.startedForLink() {
                window.orderOut(nil)
                NSApp.setActivationPolicy(.accessory)
                Diagnostics.note(background ? "Margin.app started with --background: no set-up window" : "Margin.app started for a link (the extension's note): no set-up window")
            } else {
                // An agent app (LSUIElement, scripts/make-xcode.sh): opened by
                // the person, it gets its Dock icon and comes forward.
                NSApp.setActivationPolicy(.regular)
                NSApp.activate()
                Diagnostics.note("Margin.app opened by hand: set-up window shown")
            }
        } else {
            NSApp.setActivationPolicy(.accessory)
            Diagnostics.note("Margin.app started: no set-up window in its storyboard")
        }
        signal(SIGTERM, SIG_IGN)
        terminating = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        // Not from inside the handler: quitting waits on the main queue (the goodbye sent).
        terminating?.setEventHandler { RunLoop.main.perform { NSApp.terminate(nil) } }
        terminating?.resume()
        endOthers()
    }

    // Another Margin.app of this bundle still running (one an update left, or
    // opened twice): told to quit (a SIGTERM, as safari.sh sends: no Apple
    // Event, so nothing to allow), waited for up to 2 s, and only then this
    // one's shell starts, so only one answers the copies and draws.
    static let othersWait: TimeInterval = 2
    private var others: [pid_t] = []
    private var othersUntil = Date()
    private var othersTimer: Timer?
    private func endOthers() {
        let me = ProcessInfo.processInfo.processIdentifier
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "io.tirth.margin")
            .map { BundleWatch.Running(pid: $0.processIdentifier, bundlePath: $0.bundleURL?.path) }
        others = BundleWatch.othersToEnd(running, me: me, bundlePath: Bundle.main.bundleURL.path)
        guard !others.isEmpty else { return startShell() }
        for pid in others {
            Diagnostics.note("another Margin.app of this install is running (pid \(pid)): asked to quit")
            kill(pid, SIGTERM)
        }
        othersUntil = Date().addingTimeInterval(Self.othersWait)
        othersTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.waitForOthers() }
        }
    }
    private func waitForOthers() {
        others = others.filter { kill($0, 0) == 0 }
        guard others.isEmpty || Date() >= othersUntil else { return }
        if !others.isEmpty { Diagnostics.warn("another Margin.app (pid \(others.map(String.init).joined(separator: ", "))) is still running after \(Int(Self.othersWait)) s: starting anyway") }
        othersTimer?.invalidate()
        othersTimer = nil
        startShell()
    }

    private func startShell() {
        guard idleCheck == nil else { return }
        if let bundle {
            bundle.watch(shell.link)
            // Replaced while it was starting: no shell at all.
            if bundle.check("at launch") { return }
        }
        shell.start()
        idleCheck = Timer.scheduledTimer(withTimeInterval: Self.idleCheckEvery, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkIdle() }
        }
    }

    // Started on demand, Margin.app quits by itself once no copy has been
    // linked for a while and its set-up window isn't open (Tirth, 2026-11-05):
    // a browser starting again starts it again.
    static let idleQuitAfter: TimeInterval = 10 * 60
    static let idleCheckEvery: TimeInterval = 30
    private var idleCheck: Timer?
    private var idleSince: Date?
    private var keptBySetupSaid = false // the log said, once, that the set-up window keeps it running
    private func checkIdle() {
        // Another build in this one's place: quits, linked or not (BundleWatch.swift).
        if bundle?.check("the 30 s check") == true { return }
        let setupOpen = setup?.window?.isVisible == true
        if shell.links.isEmpty, setupOpen {
            if !keptBySetupSaid { Diagnostics.note("no copy linked, but the set-up window is open: Margin.app doesn't quit by itself while it is") }
            keptBySetupSaid = true
        } else {
            keptBySetupSaid = false
        }
        guard shell.links.isEmpty, !setupOpen else { idleSince = nil; return }
        let since = idleSince ?? Date()
        idleSince = since
        if Date().timeIntervalSince(since) >= Self.idleQuitAfter { NSApp.terminate(nil) }
    }

    // Started by the extension handler for a copy's link (SafariWebExtensionHandler.swift
    // launchApp): it left a note in its container a moment before. Read once and removed.
    static func startedForLink() -> Bool {
        let note = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Containers/\(marginExtensionIdentifier)/Data/Library/Caches/margin-launch")
        guard let at = (try? FileManager.default.attributesOfItem(atPath: note.path))?[.modificationDate] as? Date else { return false }
        try? FileManager.default.removeItem(at: note)
        return Date().timeIntervalSince(at) < 15
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSetup()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        shell.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    private func showSetup() {
        if setup == nil, let controller = NSStoryboard.main?.instantiateInitialController() as? NSWindowController, let window = controller.window {
            keep(window)
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.unhide(nil) // opened with `open -j`
        setup?.showWindow(nil)
        NSApp.activate()
    }

    // The set-up window, kept for showing again; while it's closed, no Dock icon.
    private func keep(_ window: NSWindow) {
        window.isReleasedWhenClosed = false
        setup = window.windowController ?? NSWindowController(window: window)
        if let closing { NotificationCenter.default.removeObserver(closing) }
        closing = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { _ in
            _ = MainActor.assumeIsolated { NSApp.setActivationPolicy(.accessory) }
        }
    }
}
