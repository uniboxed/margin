// What the host engine (HostEngine.swift) runs on: the system's (RealHostSystem), or a test's stand-in. Every
// write here is to a window Margin hosts or a Space Margin made or was given; nothing moves or resizes a window
// through Accessibility (apps save their frames), and nothing posts a click or a key.

import AppKit
import ApplicationServices

protocol HostSystem: AnyObject {
    // ---- time ----
    func now() -> Double // seconds, monotonic
    func sleep(_ seconds: Double) async

    // ---- apps ----
    func running(bundleId: String) -> [HostApp]
    func app(pid: pid_t) -> HostApp? // nil: not running
    func policy(pid: pid_t) -> HostPolicy?
    // Started with no Dock icon (only a fresh launch). True: asked; the engine waits for its pid.
    func launchDockless(bundleId: String, arguments: [String]) -> Bool
    func terminate(pid: pid_t) -> Bool // a polite quit (the app may ask about unsaved work), never a forced one
    var onAppQuit: ((pid_t) -> Void)? { get set }

    // ---- windows, through Accessibility: only read, and full screen set ----
    func windows(pid: pid_t) async -> [HostWindow]? // the ones that can go full screen; nil: not readable
    func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool
    func isFullScreen(pid: pid_t, window: Int) async -> Bool?
    func mainWindow(pid: pid_t) async -> Int? // the app's main window (its View menu acts on that one)
    func safariSidebar(pid: pid_t) async -> HostSidebar
    func pressSafariSidebar(pid: pid_t) async -> Bool
    func safariAutoShowsToolbar() -> Bool? // Safari's own AutoShowToolbarInFullScreen; nil: not readable

    // ---- the window server ----
    func bounds(window: Int) -> CGRect? // model bounds, top-left coordinates; nil: gone or unknown
    func spaces(window: Int) -> [UInt64]? // its user Spaces (a private Space isn't one); nil: unknown
    func spaceType(_ space: UInt64) -> Int?
    func spaceExists(_ space: UInt64) -> Bool? // listed by the managed displays (what Mission Control shows)
    func currentSpace(onDisplayOf space: UInt64) -> UInt64?
    func setCurrentSpace(_ space: UInt64) -> Bool
    func desktop(onDisplayOf space: UInt64) -> UInt64?
    func ownerlessFullScreenSpaces() -> [UInt64]?

    // ---- tiles and the page area's edges ----
    func tiles(of space: UInt64) -> [UInt64]?
    func moveTile(_ tile: UInt64, to space: UInt64, at index: Int) -> Bool
    func setTileSpacing(_ spacing: Double, space: UInt64) -> Bool
    func destroyFullScreenSpace(_ space: UInt64) -> Bool
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool
    func reserved(space: UInt64) -> SlotEdges?

    // ---- parking ----
    func createPrivateSpace() -> UInt64?
    func move(window: Int, to space: UInt64) -> Bool // into `space`, out of every other (the bridge, options 7)
    func destroyPrivateSpace(_ space: UInt64) -> Bool

    // ---- the freeze ----
    func freeze() -> Bool
    func reveal()

    // ---- outside opens: LaunchServices' codes for one app ----
    func watchOpens(pid: pid_t, _ heard: @escaping (Int32) -> Void) -> Bool
    func stopWatchingOpens(pid: pid_t)
}

// ---- the real one ----

// Accessibility, on a queue of its own (an app answers on its main thread, which may be busy): each window's
// element kept once found, since an app lists only the active Space's windows.
@_silgen_name("_AXUIElementGetWindow") nonisolated private func hostWindowNumber(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

nonisolated final class HostAX: @unchecked Sendable {
    private let queue = DispatchQueue(label: "margin.host.ax", qos: .userInitiated)
    private var elements: [Int: (pid: pid_t, element: AXUIElement)] = [:] // on the queue only
    let refuses = PrivateCalls.inTests

    private func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
    }

    private func read(_ pid: pid_t) -> [HostWindow]? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1)
        guard let list = attr(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
        var out: [HostWindow] = []
        for w in list {
            var settable: DarwinBoolean = false
            guard AXUIElementIsAttributeSettable(w, "AXFullScreen" as CFString, &settable) == .success, settable.boolValue else { continue }
            var n: CGWindowID = 0
            guard hostWindowNumber(w, &n) == .success, n > 0 else { continue }
            elements[Int(n)] = (pid, w)
            out.append(HostWindow(number: Int(n), fullScreen: (attr(w, "AXFullScreen") as? Bool) == true))
        }
        // Kept windows not listed now (on another Space) are still read through their element.
        for (number, kept) in elements where kept.pid == pid && !out.contains(where: { $0.number == number }) {
            if let fs = attr(kept.element, "AXFullScreen") as? Bool { out.append(HostWindow(number: number, fullScreen: fs)) } else { elements[number] = nil }
        }
        return out.sorted { $0.number < $1.number }
    }

    private func element(_ pid: pid_t, _ number: Int) -> AXUIElement? {
        if let kept = elements[number], kept.pid == pid { return kept.element }
        _ = read(pid)
        return elements[number].flatMap { $0.pid == pid ? $0.element : nil }
    }

    func windows(pid: pid_t) async -> [HostWindow]? {
        guard !refuses, AXIsProcessTrusted() else { return nil }
        return await withCheckedContinuation { c in queue.async { c.resume(returning: self.read(pid)) } }
    }

    func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool {
        guard !refuses, AXIsProcessTrusted() else { return false }
        return await withCheckedContinuation { c in
            queue.async {
                guard let e = self.element(pid, window) else { return c.resume(returning: false) }
                c.resume(returning: AXUIElementSetAttributeValue(e, "AXFullScreen" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse) == .success)
            }
        }
    }

    func isFullScreen(pid: pid_t, window: Int) async -> Bool? {
        guard !refuses, AXIsProcessTrusted() else { return nil }
        return await withCheckedContinuation { c in
            queue.async {
                guard let e = self.element(pid, window) else { return c.resume(returning: nil) }
                c.resume(returning: self.attr(e, "AXFullScreen") as? Bool)
            }
        }
    }

    func mainWindow(pid: pid_t) async -> Int? {
        guard !refuses, AXIsProcessTrusted() else { return nil }
        return await withCheckedContinuation { c in
            queue.async {
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, 1)
                guard let v = self.attr(app, kAXMainWindowAttribute), CFGetTypeID(v) == AXUIElementGetTypeID() else { return c.resume(returning: nil) }
                var n: CGWindowID = 0
                guard hostWindowNumber(v as! AXUIElement, &n) == .success, n > 0 else { return c.resume(returning: nil) }
                c.resume(returning: Int(n))
            }
        }
    }

    func forget(pid: pid_t) { queue.async { self.elements = self.elements.filter { $0.value.pid != pid } } }
}

final class RealHostSystem: HostSystem {
    private let calls: HostPrivate
    private let sky: SkyLight
    private let spacesRW: SkyLightSpaces
    private let slots: SlotSpaces
    private let freezer: Freezer?
    private let sidebarMenu: () -> SidebarMenu?
    private let closedSidebarTitle: (pid_t) -> String?
    private let ax = HostAX()
    private var listeners: [pid_t: UnsafeRawPointer] = [:]
    private var quitObserver: NSObjectProtocol?
    var onAppQuit: ((pid_t) -> Void)?

    init(calls: HostPrivate, sky: SkyLight, spaces: SkyLightSpaces, slots: SlotSpaces, freezer: Freezer?,
         sidebarMenu: @escaping () -> SidebarMenu?, closedSidebarTitle: @escaping (pid_t) -> String?) {
        self.calls = calls
        self.sky = sky
        self.spacesRW = spaces
        self.slots = slots
        self.freezer = freezer
        self.sidebarMenu = sidebarMenu
        self.closedSidebarTitle = closedSidebarTitle
        quitObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = app.processIdentifier
            MainActor.assumeIsolated { self?.onAppQuit?(pid) }
        }
    }

    deinit {
        if let quitObserver { NSWorkspace.shared.notificationCenter.removeObserver(quitObserver) }
    }

    func now() -> Double { ProcessInfo.processInfo.systemUptime }
    func sleep(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000)) }

    nonisolated private static func hostApp(_ a: NSRunningApplication) -> HostApp? {
        guard !a.isTerminated, let bundle = a.bundleIdentifier else { return nil }
        return HostApp(pid: a.processIdentifier, bundleId: bundle, launchedAt: a.launchDate?.timeIntervalSince1970)
    }

    func running(bundleId: String) -> [HostApp] {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).compactMap(Self.hostApp)
    }

    func app(pid: pid_t) -> HostApp? { NSRunningApplication(processIdentifier: pid).flatMap(Self.hostApp) }

    func policy(pid: pid_t) -> HostPolicy? {
        guard let a = NSRunningApplication(processIdentifier: pid), !a.isTerminated else { return nil }
        switch a.activationPolicy {
        case .regular: return .regular
        case .accessory: return .accessory
        case .prohibited: return .prohibited
        @unknown default: return nil
        }
    }

    func launchDockless(bundleId: String, arguments: [String]) -> Bool {
        guard running(bundleId: bundleId).isEmpty, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return false }
        return calls.launchDockless(url, arguments: arguments) { ok in
            if !ok { Task { @MainActor in Diagnostics.warn("host: LaunchServices didn't start \(bundleId) with no Dock icon") } }
        }
    }

    func terminate(pid: pid_t) -> Bool {
        guard !PrivateCalls.inTests, let a = NSRunningApplication(processIdentifier: pid), !a.isTerminated else { return false }
        ax.forget(pid: pid)
        return a.terminate()
    }

    func windows(pid: pid_t) async -> [HostWindow]? { await ax.windows(pid: pid) }
    func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool { await ax.setFullScreen(pid: pid, window: window, on) }
    func isFullScreen(pid: pid_t, window: Int) async -> Bool? { await ax.isFullScreen(pid: pid, window: window) }
    func mainWindow(pid: pid_t) async -> Int? { await ax.mainWindow(pid: pid) }

    // The View › Show Sidebar item's title (SafariAX, ShellSafariSidebar.swift): "Hide Sidebar" while it's open, or
    // anything but the title the shell learned with it closed.
    func safariSidebar(pid: pid_t) async -> HostSidebar {
        guard let menu = sidebarMenu() else { return .unknown }
        let title: String? = await withCheckedContinuation { c in menu.title(pid: pid) { c.resume(returning: $0) } }
        guard let title, !title.isEmpty else { return .unknown }
        if title == "Hide Sidebar" { return .open }
        if title == "Show Sidebar" { return .closed }
        guard let closed = closedSidebarTitle(pid) else { return .unknown }
        return SafariSidebar.isOpen(title: title, closedTitle: closed) ? .open : .closed
    }

    func pressSafariSidebar(pid: pid_t) async -> Bool {
        guard let menu = sidebarMenu() else { return false }
        return await withCheckedContinuation { c in menu.press(pid: pid) { c.resume(returning: $0) } }
    }

    // Safari's own preference (in its container, or the old place); never written.
    func safariAutoShowsToolbar() -> Bool? {
        guard !PrivateCalls.inTests else { return nil }
        let home = FileManager.default.homeDirectoryForCurrentUser
        for path in ["Library/Containers/com.apple.Safari/Data/Library/Preferences/com.apple.Safari.plist", "Library/Preferences/com.apple.Safari.plist"] {
            if let d = NSDictionary(contentsOf: home.appendingPathComponent(path)), let v = d["AutoShowToolbarInFullScreen"] as? NSNumber { return v.boolValue }
        }
        return nil
    }

    func bounds(window: Int) -> CGRect? { sky.modelBounds(of: window) }
    func spaces(window: Int) -> [UInt64]? { spacesRW.spaces(of: window) }
    func spaceType(_ space: UInt64) -> Int? { calls.spaceType(space) }

    private func display(of space: UInt64) -> DisplaySpaces? {
        spacesRW.displays()?.first { $0.spaces.contains { $0.id == space } }
    }

    func spaceExists(_ space: UInt64) -> Bool? {
        guard let displays = spacesRW.displays() else { return nil }
        return displays.contains { $0.spaces.contains { $0.id == space } }
    }

    func currentSpace(onDisplayOf space: UInt64) -> UInt64? { display(of: space)?.current }

    func setCurrentSpace(_ space: UInt64) -> Bool {
        guard let d = display(of: space) else { return false }
        return calls.setCurrent(space, display: d.display)
    }

    func desktop(onDisplayOf space: UInt64) -> UInt64? { display(of: space)?.desktops.first }

    // Full-screen Spaces with no owner (an emptied one keeps neither a pid nor a tile).
    func ownerlessFullScreenSpaces() -> [UInt64]? {
        guard let raw = sky.managedDisplaySpaces() else { return nil }
        var out: [UInt64] = []
        for d in raw {
            for s in (d["Spaces"] as? [[String: Any]]) ?? [] {
                guard (s["type"] as? NSNumber)?.intValue == ManagedSpace.fullScreenType, let id = (s["id64"] as? NSNumber)?.uint64Value else { continue }
                let tiles = ((s["TileLayoutManager"] as? [String: Any])?["TileSpaces"] as? [Any])?.count ?? 0
                if s["pid"] == nil, tiles == 0 { out.append(id) }
            }
        }
        return out
    }

    func tiles(of space: UInt64) -> [UInt64]? { calls.tiles(of: space) }
    func moveTile(_ tile: UInt64, to space: UInt64, at index: Int) -> Bool { calls.moveTile(tile, to: space, at: index) }
    func setTileSpacing(_ spacing: Double, space: UInt64) -> Bool { calls.setTileSpacing(spacing, space: space) }
    func destroyFullScreenSpace(_ space: UInt64) -> Bool { calls.destroyFullScreenSpace(space) }
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool { slots.reserve(edges, space: space) }
    func reserved(space: UInt64) -> SlotEdges? { slots.reserved(space: space) }

    func createPrivateSpace() -> UInt64? { spacesRW.createSpace() }
    func move(window: Int, to space: UInt64) -> Bool { spacesRW.add(window, to: space) }
    func destroyPrivateSpace(_ space: UInt64) -> Bool { spacesRW.destroySpace(space) }

    func freeze() -> Bool {
        guard let freezer else { return false }
        if case .frozen = freezer.freeze() { return true }
        return false
    }
    func reveal() { freezer?.reveal(.ready) }

    func watchOpens(pid: pid_t, _ heard: @escaping (Int32) -> Void) -> Bool {
        guard listeners[pid] == nil else { return true }
        let token = calls.listen(pid: pid) { code in
            DispatchQueue.main.async { MainActor.assumeIsolated { heard(code) } }
        }
        guard let token else { return false }
        listeners[pid] = token
        return true
    }

    func stopWatchingOpens(pid: pid_t) {
        guard let token = listeners.removeValue(forKey: pid) else { return }
        calls.stopListening(token, pid: pid)
    }
}
