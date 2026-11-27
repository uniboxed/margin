// Margin's app (docs/MARGIN-APP.md): opened by hand, or again, it shows Margin's own window (ShellHosted.swift: a
// regular app from then on, its Dock icon and menu bar), which hosts Safari's windows and other apps in its page area;
// its set-up window (ViewController.swift, from the converter's storyboard) only with Option held. Started in the
// background (margin-helper, --background, or by the extension handler for a link) it runs on with no window and no
// Dock icon (an accessory app), linked to Margin's extension copies (app/platforms/macos/shell/Shell.swift).
// Quitting, every hosted app is given back and the copies are told first; a SIGTERM quits the same way.
// scripts/safari.sh puts a new build in place of the installed one, then sends a SIGTERM to the Margin.app it found
// running from there (a KILL after 5 s), and if Safari is running and nothing has started the new build in 2 s, opens
// it with --background (no set-up window). Started by the extension handler for a link (2026-11-05: no login item
// needed), there's no set-up window either: the handler's arguments never reach a sandboxed caller's app, so it leaves
// a note instead (startedForLink). Margin is the app: once the person has opened it (a window of its own shown), or
// while anything is hosted, it never quits by itself. Only one started in the background and never opened leaves
// again, after 60 s with no browser open, no copy linked and nothing hosted (IdleQuit.swift). Replaced on disk some
// other way, it notices and quits (BundleWatch.swift), and starting, it ends any other instance of its bundle first.
// Copied over the converter's by scripts/make-xcode.sh.

import Cocoa
import ServiceManagement

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    // The app, as AppKit's own main would start it (the storyboard makes this delegate).
    static func main() {
        _ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv)
    }

    private let shell = Shell.forApp()
    private var setup: NSWindowController?
    private var closing: NSObjectProtocol?
    private var terminating: DispatchSourceSignal?
    // The executable as it was at launch; quits once another build is in its place.
    private var bundle: BundleWatch?
    private let registration = Registration()

    // Opened by macOS at login (a login item: SMAppService.mainApp), so it's running before Safari opens. Read while
    // the open event is current.
    private var atLogin = false
    func applicationWillFinishLaunching(_ notification: Notification) {
        // (Safari's full-screen page scaling turned off before Margin starts any browser: SafariScaling.swift.)
        _ = SafariScaling.offSince
        if let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == kAEOpenApplication,
           event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem {
            atLogin = true
        }
    }

    // What runs at login is the helper (decided 2026-11-10: not the whole app): margin-helper, a login agent
    // (app/platforms/macos/helper/), starts Margin.app as a browser opens, about 0.3 s, long before the browser's
    // extension asks for its link. A build without it (an Xcode run's) is Margin.app's own login item, as before.
    static let helperPlist = "com.unibox.margin.helper.plist"
    static var hasHelper: Bool {
        FileManager.default.fileExists(atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/Library/LaunchAgents/\(helperPlist)").path)
    }
    private var helperOn: Bool { Self.hasHelper && SMAppService.agent(plistName: Self.helperPlist).status == .enabled }

    // Margin opens at login (asked 2026-11-07: Safari's UI never shown, not even as Safari opens: Margin has to be
    // running first). Added once; if the person turns it off in System Settings, it stays off. The app's own login
    // item, from before the helper, becomes the helper's: on if it was on (or never added), off if they'd turned it off.
    private func addLoginItemOnce() {
        let defaults = UserDefaults.standard
        if Self.hasHelper {
            guard !defaults.bool(forKey: "MarginHelperAdded") else { return }
            let appWasOn = SMAppService.mainApp.status == .enabled
            let wanted = appWasOn || !defaults.bool(forKey: "MarginLoginItemAdded")
            if appWasOn { try? SMAppService.mainApp.unregister() }
            defaults.set(true, forKey: "MarginHelperAdded")
            guard wanted else { return Diagnostics.note("Margin's login item stays off, as it was turned off (System Settings › General › Login Items)") }
            let agent = SMAppService.agent(plistName: Self.helperPlist)
            do {
                try agent.register()
                Diagnostics.note(agent.status == .requiresApproval
                    ? "margin-helper is a login item now, once allowed in System Settings › General › Login Items"
                    : "margin-helper opens at login now, and starts Margin.app when a browser opens (System Settings › General › Login Items turns it off)")
            } catch {
                Diagnostics.note("margin-helper couldn't be added to the login items: \(error.localizedDescription)")
            }
            return
        }
        let key = "MarginLoginItemAdded"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        do {
            try SMAppService.mainApp.register()
            UserDefaults.standard.set(true, forKey: key)
            Diagnostics.note("Margin.app opens at login now (System Settings › General › Login Items turns it off)")
        } catch {
            Diagnostics.note("Margin.app couldn't be added to the login items: \(error.localizedDescription)")
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        bundle = BundleWatch(quit: { RunLoop.main.perform { NSApp.terminate(nil) } })
        registration.heal("launch")
        // The storyboard's window, shown at launch (but opened with --background).
        // How it started goes in the log, and is kept: only a start in the background may end in a quit by itself
        // (IdleQuit.swift), and only while the person hasn't opened Margin since.
        if let window = NSApp.windows.first(where: { $0.contentViewController is ViewController }) {
            keep(window)
            watching = atLogin || CommandLine.arguments.contains("--watch")
            let background = CommandLine.arguments.contains("--background") || atLogin
            if background || Self.startedForLink() {
                startedInBackground = true
                window.orderOut(nil)
                NSApp.setActivationPolicy(.accessory)
                Diagnostics.note(atLogin ? "Margin.app opened at login: no set-up window" : background ? "Margin.app started with --background: no set-up window" : "Margin.app started for a link (the extension's note): no set-up window")
            } else if !optionHeld {
                // Opened by the person: Margin's own window (MarginWindow.swift), a regular app with its menu bar.
                window.orderOut(nil)
                showMarginWindow()
                Diagnostics.note("Margin.app opened by hand: Margin's own window (no set-up window)")
            } else {
                // An agent app (LSUIElement, scripts/make-xcode.sh): opened by
                // the person holding Option, it gets its Dock icon and comes forward with its set-up window.
                shown = true
                NSApp.setActivationPolicy(.regular)
                NSApp.activate()
                Diagnostics.note("Margin.app opened by hand with Option: set-up window shown")
            }
        } else {
            startedInBackground = true
            NSApp.setActivationPolicy(.accessory)
            Diagnostics.note("Margin.app started: no set-up window in its storyboard")
        }
        signal(SIGTERM, SIG_IGN)
        terminating = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        // Not from inside the handler: quitting waits on the main queue (the goodbye sent).
        terminating?.setEventHandler { RunLoop.main.perform { NSApp.terminate(nil) } }
        terminating?.resume()
        // (The login item first: whether margin-helper is on decides whether this app waits for a browser at all.)
        addLoginItemOnce()
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
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "com.unibox.margin")
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
        let alive = others.filter { kill($0, 0) == 0 }
        let ended = others.filter { !alive.contains($0) }
        others = alive
        let took = Int((Self.othersWait - othersUntil.timeIntervalSinceNow) * 1000)
        for pid in ended { Diagnostics.note("ended an older Margin.app (pid \(pid)) in \(took) ms") }
        guard others.isEmpty || Date() >= othersUntil else { return }
        if !others.isEmpty { Diagnostics.warn("another Margin.app (pid \(others.map(String.init).joined(separator: ", "))) is still running after \(Int(Self.othersWait)) s: starting anyway") }
        othersTimer?.invalidate()
        othersTimer = nil
        startShell()
    }

    // Watching (opened at login, or restarted idle with --watch): no shell, no link, no web views until a browser
    // Margin works in opens; then the shell starts, in time for its copies' links.
    private var watching = false
    private var browserLaunch: NSObjectProtocol?
    static let browsers: Set<String> = ["com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.microsoft.edgemac"]
    private static func browserRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier.map(browsers.contains) ?? false }
    }

    private func startShell() {
        guard idleCheck == nil else { return }
        // Waiting is margin-helper's (it starts this app as a browser opens): with it on and no browser open, quit.
        if watching, !Self.browserRunning(), helperOn, shell.marginWindows == nil, !shown {
            Diagnostics.note("no browser open: Margin.app quits (margin-helper starts it when one opens)")
            return NSApp.terminate(nil)
        }
        if watching, !Self.browserRunning() {
            guard browserLaunch == nil else { return }
            Diagnostics.note("Margin.app is waiting for a browser to open (no shell until then)")
            browserLaunch = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
                let id = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier
                guard let id, Self.browsers.contains(id) else { return }
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if let o = self.browserLaunch { NSWorkspace.shared.notificationCenter.removeObserver(o) }
                    self.browserLaunch = nil
                    self.watching = false
                    Diagnostics.note("\(id) opened: Margin's shell starts")
                    self.startShell()
                }
            }
            return
        }
        watching = false
        if let bundle {
            bundle.watch(shell.link, registration: registration)
            // Replaced while it was starting: no shell at all.
            if bundle.check("at launch") { return }
        }
        // macOS's private calls for the freeze and the host, checked before the shell starts: anything
        // missing or changed turns that part off, with one log line (PrivateCalls.swift).
        shell.checkPrivateCalls()
        shell.start()
        idleCheck = Timer.scheduledTimer(withTimeInterval: Self.idleCheckEvery, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkIdle() }
        }
    }

    // Margin never quits by itself once the person has opened it, or while anything is hosted. Started in the
    // background and never opened, it leaves after a minute with no browser open, no copy linked and nothing hosted
    // (IdleQuit.swift: the rule, and its unit checks): a browser starting again starts it again.
    static let idleCheckEvery: TimeInterval = 30
    private var idleCheck: Timer?
    private var idleSince: Date?
    private var startedInBackground = false // no window at launch: --background, a login item, the handler's link start
    private var shown = false // a window of Margin's has been shown (its own, or the set-up window)
    private func checkIdle() {
        // Another build in this one's place: quits, whatever is open (BundleWatch.swift).
        if bundle?.check("the 30 s check") == true { return }
        let state = IdleQuit.State(startedInBackground: startedInBackground,
                                   shown: shown || setup?.window?.isVisible == true || shell.marginWindows != nil,
                                   hosting: shell.host?.hasHosts == true || shell.host?.hasLeftSafariWindows == true,
                                   linked: !shell.links.isEmpty, browserOpen: Self.browserRunning())
        let (since, quit) = IdleQuit.check(state, since: idleSince, now: Date())
        idleSince = since
        guard quit else { return }
        // The app its own login item (no helper): back to watching in a fresh process (nothing of the shell kept), so
        // the next browser to open links at once. Otherwise quit (the helper, or the extension asking, starts it again).
        if !helperOn, SMAppService.mainApp.status == .enabled {
            Diagnostics.note("started in the background and never opened; no browser open, no copy linked, nothing hosted for \(Int(IdleQuit.after)) s: Margin.app goes back to waiting for a browser")
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            configuration.addsToRecentItems = false
            configuration.createsNewApplicationInstance = true
            configuration.arguments = ["--background", "--watch"]
            NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, _ in
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
            idleCheck?.invalidate()
            idleCheck = nil
            return
        }
        Diagnostics.note("started in the background and never opened; no browser open, no copy linked, nothing hosted for \(Int(IdleQuit.after)) s: Margin.app quits (margin-helper, or the extension asking for its link, starts it again)")
        NSApp.terminate(nil)
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
        // Margin's own window: in front, or a new one; the set-up window if it's what's open, or with Option.
        if !optionHeld, setup?.window?.isVisible != true { showMarginWindow() } else { showSetup() }
        return false
    }

    // Opening Margin shows its own window, unless Option is held: the set-up window then.
    private var optionHeld: Bool { NSEvent.modifierFlags.contains(.option) }
    private func showMarginWindow() {
        shown = true
        NSApp.setActivationPolicy(.regular)
        NSApp.unhide(nil)
        shell.showMarginWindow()
        NSApp.activate()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        shell.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    private func showSetup() {
        if setup == nil, let controller = NSStoryboard.main?.instantiateInitialController() as? NSWindowController, let window = controller.window {
            keep(window)
        }
        shown = true
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
        closing = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                // (Margin's own windows keep the Dock icon: a regular app from the first one on.)
                guard self?.shell.marginWindows == nil else { return }
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }
}
