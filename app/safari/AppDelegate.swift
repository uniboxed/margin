// Margin's app: its set-up window (ViewController.swift, from the converter's
// storyboard) while it's open, and otherwise running on with no window and no
// Dock icon (an accessory app), linked to Margin's extension copies and
// drawing Margin around the browser's windows (app/shell/Shell.swift), which
// does nothing until a linked browser is in front. Opening the app again
// shows the set-up window again. Quitting, the copies are told first; a
// SIGTERM quits the same way (scripts/safari.sh, before it puts a new build
// in its place, then opens that with --background: no set-up window).
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
            if CommandLine.arguments.contains("--background") {
                window.orderOut(nil)
                NSApp.setActivationPolicy(.accessory)
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
