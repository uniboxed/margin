// Margin's app: its set-up window (ViewController.swift, from the converter's
// storyboard) while it's open, and otherwise running on with no window and no
// Dock icon (an accessory app), linked to Margin's extension copies and
// drawing Margin around the browser's windows (app/shell/Shell.swift), which
// does nothing until a linked browser is in front. Opening the app again
// shows the set-up window again. Quitting, the copies are told first; a
// SIGTERM quits the same way (scripts/safari.sh, before it puts a new build
// in its place, then opens that with --background: no set-up window). Started
// by the extension handler for a link (Tirth, 2026-11-05: no login item
// needed), there's no set-up window either: the handler's arguments never
// reach a sandboxed caller's app, so it leaves a note instead (startedForLink).
// With no copy linked for 10 minutes (and no set-up window), it quits by itself.
// Copied over the converter's by scripts/make-xcode.sh.

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    private let shell = Shell.forApp()
    private var setup: NSWindowController?
    private var closing: NSObjectProtocol?
    private var terminating: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The storyboard's window, shown at launch (but opened with --background).
        if let window = NSApp.windows.first(where: { $0.contentViewController is ViewController }) {
            keep(window)
            if CommandLine.arguments.contains("--background") || Self.startedForLink() {
                window.orderOut(nil)
                NSApp.setActivationPolicy(.accessory)
            } else {
                // An agent app (LSUIElement, scripts/make-xcode.sh): opened by
                // the person, it gets its Dock icon and comes forward.
                NSApp.setActivationPolicy(.regular)
                NSApp.activate()
            }
        } else {
            NSApp.setActivationPolicy(.accessory)
        }
        signal(SIGTERM, SIG_IGN)
        terminating = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        // Not from inside the handler: quitting waits on the main queue (the goodbye sent).
        terminating?.setEventHandler { RunLoop.main.perform { NSApp.terminate(nil) } }
        terminating?.resume()
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
    private func checkIdle() {
        let setupOpen = setup?.window?.isVisible == true
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
