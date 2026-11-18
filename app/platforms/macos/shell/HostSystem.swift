// What the host engine (HostEngine.swift) runs on: the system's (RealHostSystem), or a test's stand-in. Every
// write here is to a window Margin hosts or a Space Margin made or was given. The one window Accessibility moves or
// resizes is a window-mode host's (`setFrame`), and only after the engine recorded its frame, which it gives back
// before that window leaves Margin's Space and before its app is quit (apps save their frames). Nothing posts a click
// or a key.

import AppKit
import ApplicationServices

protocol HostSystem: AnyObject {
    // ---- time ----
    func now() -> Double // seconds, monotonic
    func sleep(_ seconds: Double) async

    // ---- apps ----
    func running(bundleId: String) -> [HostApp]
    func app(pid: pid_t) -> HostApp? // nil: not running
    // Whether the process itself still runs (kill(pid, 0)), whatever NSWorkspace says of the app. A UIKit (Catalyst) app
    // attempting termination with no window in any user Space (2026-11-17, Maps: `isAttemptingTermination` twice, still
    // running) was heard as quit while its process went on: "quit" is only ever this saying no.
    func processRuns(pid: pid_t) -> Bool
    func policy(pid: pid_t) -> HostPolicy?
    // Started with no Dock icon (only a fresh launch). True: asked; the engine waits for its pid.
    func launchDockless(bundleId: String, arguments: [String]) -> Bool
    func terminate(pid: pid_t) -> Bool // a polite quit (the app may ask about unsaved work), never a forced one
    // Whether the app keeps its windows across a quit (reopens them at its next launch): its own
    // NSQuitAlwaysKeepsWindows, else the person's (System Settings › Desktop & Dock › "Close windows when quitting an
    // application" off). Off, macOS's default, a quit discards its windows anyway: closing one first changes nothing
    // about its next launch.
    func keepsWindowsAtQuit(pid: pid_t) -> Bool
    // Its app's version ("short (build)"; nil: unread): the hosting core's routes remember a step down per version.
    func appVersion(pid: pid_t) -> String?
    var onAppQuit: ((pid_t) -> Void)? { get set }
    // Whether it's hidden (nil: not running). An app started with no Dock icon is started hidden (LaunchServices' hide
    // option): a hidden app's windows aren't in Accessibility's list, and some apps make or expose their window only
    // once they're unhidden (Dictionary, 2026-11-15: its window read by the window server, never by Accessibility).
    func isHidden(pid: pid_t) -> Bool?
    // Unhidden (NSRunningApplication.unhide: never activated). True: asked.
    func unhide(pid: pid_t) -> Bool
    // A Dock-icon click on a running app (kAEReopenApplication, an Apple event straight to its process, never through
    // LaunchServices: an open there promotes an app Margin started with no Dock icon to a Dock app, 2026-11-15): the app
    // orders its main window in, or makes a new one (Maps running with no window, 2026-11-17 15:19). True: sent.
    func reopen(pid: pid_t) -> Bool

    // ---- windows, through Accessibility: read, full screen set, a window-mode host's frame set ----
    // (Accessibility lists only the current Space's windows: the engine moves a window there before it sets its frame.)
    func windows(pid: pid_t) async -> [HostWindow]? // its standard windows and the ones that can go full screen; nil: not readable
    // The window whose number is `number` (the window server's), whatever its role or subrole; nil: not listed (yet).
    func window(pid: pid_t, number: Int) async -> HostWindow?
    func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool
    func isFullScreen(pid: pid_t, window: Int) async -> Bool?
    func mainWindow(pid: pid_t) async -> Int? // the app's main window (its View menu acts on that one)
    func focusedWindow(pid: pid_t) async -> Int? // the app's focused window (its keyboard's); nil: none or unread
    func safariSidebar(pid: pid_t) async -> HostSidebar
    func pressSafariSidebar(pid: pid_t) async -> Bool
    func safariAutoShowsToolbar() -> Bool? // Safari's own AutoShowToolbarInFullScreen; nil: not readable
    func frame(pid: pid_t, window: Int) async -> CGRect? // its position and size (top-left coordinates); nil: unread
    // Its position, and its size too when `size` (a resizable window). True: Accessibility took both.
    func setFrame(pid: pid_t, window: Int, _ frame: CGRect, size: Bool) async -> Bool
    // Accessibility's error for that window's last frame set that it refused (nil: none, or not known).
    func frameError(window: Int) -> Int32?
    // The window's kept Accessibility element dropped and found again by its number (an element kept once found can go
    // stale once its window has left the current Space: every set through it refused after). True: found again.
    func refreshWindow(pid: pid_t, window: Int) async -> Bool
    // Its app in front and the window raised and made its main one (AXRaise, AXMain): never a click. True: asked.
    // (NSRunningApplication.activate(from: Margin): macOS 14's cooperative activation takes it only while Margin is the
    // active app, which it never is since its UI is a panel (2026-11-17): `frontmost` is what brings the app forward.)
    func activate(pid: pid_t, window: Int) async -> Bool
    // The app made the front app by Accessibility (AXFrontmost on its application element: the app activates itself,
    // as an app does at a Dock-icon click, so Margin needn't be active). An app started hidden (LaunchServices' hide
    // option) is unhidden by it; its windows ordered in while it was hidden come on screen only so (2026-11-17, the
    // Phone: off screen in Margin's Space until its own reopen made it the front process). True: Accessibility took it.
    func frontmost(pid: pid_t) async -> Bool
    // The front app's pid now (NSWorkspace's), for the log; nil: unread.
    func frontApp() -> pid_t?
    // Closed as its close button would (AXPress on its AXCloseButton, an action, never a click). True: asked.
    func close(pid: pid_t, window: Int) async -> Bool
    // AXEnhancedUserInterface on the app's element (what assistive apps set; some apps expose their windows to
    // Accessibility only with it): read (nil: unread), and set. True: Accessibility took it.
    func enhancedUserInterface(pid: pid_t) async -> Bool?
    func setEnhancedUserInterface(pid: pid_t, _ on: Bool) async -> Bool

    // ---- the window server ----
    // Every window of `pid` on every Space (CGWindowListCopyWindowInfo .optionAll): Accessibility lists only the
    // current Space's windows, so a window that opened on another one (Safari's, asked for while Margin's full-screen
    // Space is current) is found here. Nil: no list.
    func serverWindows(pid: pid_t) -> [ServerWindow]?
    // Every app's windows on screen now (the current Spaces'), front to back; nil: no list. One read, for the poll's
    // look for another app's window in Margin's Space (HostEngine `lookForOthers`).
    func onScreenWindows() -> [ServerWindow]?
    // One window's own word (CGWindowListCopyWindowInfo .optionIncludingWindow): whether it's on screen, and its alpha.
    // Nil: gone or unread. The poll's second read before it acts on a window missing from the on-screen list.
    func windowOnScreen(_ number: Int) -> (onScreen: Bool, alpha: Double)?
    // The screen locked, the display asleep, or the session not the one on the console: the on-screen list says nothing
    // of where Margin's windows should be then.
    func screenAway() -> Bool
    // Each display's current Space as the window server lists it (for the log), nil: unread.
    func currentSpaces() -> [String]?
    func bounds(window: Int) -> CGRect? // model bounds, top-left coordinates; nil: gone or unknown
    func spaces(window: Int) -> [UInt64]? // its user Spaces (a private Space isn't one); nil: unknown
    func spaceType(_ space: UInt64) -> Int?
    func spaceExists(_ space: UInt64) -> Bool? // listed by the managed displays (what Mission Control shows)
    func currentSpace(onDisplayOf space: UInt64) -> UInt64?
    func setCurrentSpace(_ space: UInt64) -> Bool
    func desktop(onDisplayOf space: UInt64) -> UInt64?
    func ownerlessFullScreenSpaces() -> [UInt64]?
    // Every full-screen Space the managed displays list (SLSCopyManagedDisplaySpaces: what Mission Control shows). Nil: unread.
    func listedFullScreenSpaces() -> [UInt64]?
    // ...each with its owner's pid (0: none, Margin's or an emptied one). A window asked into full screen gets its new
    // Space listed here, owned by its app, ~40 ms after the ask, well before the window server says the window is in it
    // (~600 ms, at macOS's Space switch): measured 2026-11-16 (/tmp/margin-toolbar-test/fsopen/early2.swift). Nil: unread.
    func fullScreenSpaceOwners() -> [UInt64: pid_t]?

    // ---- a full-screen Space's edges, and its destroy ----
    func destroyFullScreenSpace(_ space: UInt64) -> Bool
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool
    func reserved(space: UInt64) -> SlotEdges?

    // ---- parking, and members of Margin's Space ----
    func createPrivateSpace() -> UInt64?
    // Into `space`, out of every other (the bridge, options 7): parking, a window-mode window into Margin's Space, and a
    // full-screen window into Margin's Space as a plain member (it stays full screen, at its frame).
    func move(window: Int, to space: UInt64) -> Bool
    func destroyPrivateSpace(_ space: UInt64) -> Bool

    // ---- the freeze ----
    func freeze() -> Bool
    func reveal()

    // ---- outside opens: LaunchServices' codes for one app ----
    func watchOpens(pid: pid_t, _ heard: @escaping (Int32) -> Void) -> Bool
    func stopWatchingOpens(pid: pid_t)

    // ---- the tiles (live resize: docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space") ----
    // A full-screen window lives in a tile of its full-screen Space; a hosted window's own tile moved into Margin's Space
    // is sized by its rect (`TileRect`, in its display's points from the display's top left, the menu bar's band
    // included: a full-screen window sits that band below its tile's top), its window following in 10-26 ms, shown or
    // parked. Every write is through the window manager's bridge (sent: whether it took is the caller's to read).
    var tilesAvailable: Bool { get } // the tiles part passed its launch check (HostCalls.swift)
    func tiles(of space: UInt64) -> [UInt64]? // a Space's tiles in its layout's order; nil: unread
    func tileRect(_ tile: UInt64) -> CGRect? // nil: unread, or not a tile
    func tileWindow(_ tile: UInt64) -> Int? // the window in it (`TileWindowID`); nil: none or unread
    // The smallest its window can be, as its app gave its full-screen tile (`SizeConstraints`' `Min`: AppKit's
    // minimum full-screen content size, what Split View's divider stops at); nil: none said, or unread.
    func tileMinSize(_ tile: UInt64) -> CGSize?
    func maxTiles(of space: UInt64) -> Int? // its layout's limit (`Max Tile Config`'s width: 2 for a new full-screen Space)
    func setMaxTiles(_ space: UInt64, _ count: Int) -> Bool
    func setTileRect(_ tile: UInt64, _ rect: CGRect) -> Bool
    // A tile, with its window, into `space`'s layout at `index` (its id kept). Any tile added to or removed from a Space
    // lays the first two of its layout out again (a split's halves): their rects are set again after (the engine).
    func moveTile(_ tile: UInt64, to space: UInt64, index: Int) -> Bool
    func destroyTile(_ tile: UInt64) -> Bool // a tile left with no live window (its app gone: a placeholder) destroyed
    // The anchors (docs/HOSTING-CORE.md "Anchors"): an empty tile made in `space`, at its layout's end (nil: not made, or
    // its id not said: the caller reads the Space's tiles).
    var anchorsAvailable: Bool { get }
    func createTile(in space: UInt64) -> UInt64?
    func setLiveResizing(_ space: UInt64, _ on: Bool) -> Bool // a drag under way in that Space's layout (its windows' live resize)
}

extension HostSystem {
    func appVersion(pid: pid_t) -> String? { nil }
    // (A stand-in that doesn't play it: not sent.)
    func reopen(pid: pid_t) -> Bool { false }
    // (A stand-in that doesn't play it: not taken, front app unread.)
    func frontmost(pid: pid_t) async -> Bool { false }
    func frontApp() -> pid_t? { nil }
    // (A stand-in that doesn't play it: none.)
    func focusedWindow(pid: pid_t) async -> Int? { nil }
    func frameError(window: Int) -> Int32? { nil }
    func refreshWindow(pid: pid_t, window: Int) async -> Bool { false }
    // (A stand-in that doesn't play it: unread, so the engine's early full screen isn't tried.)
    func fullScreenSpaceOwners() -> [UInt64: pid_t]? { nil }
    // (A stand-in that doesn't play it: no list, so no other window is ever let in front.)
    func onScreenWindows() -> [ServerWindow]? { nil }
    // (A stand-in that doesn't play them: the app's word is the process's; no window's own read.)
    func processRuns(pid: pid_t) -> Bool { app(pid: pid) != nil }
    func windowOnScreen(_ number: Int) -> (onScreen: Bool, alpha: Double)? { nil }
    func screenAway() -> Bool { false }
    func currentSpaces() -> [String]? { nil }
    // (A stand-in that doesn't play the tiles: none, the host as before.)
    var tilesAvailable: Bool { false }
    func tiles(of space: UInt64) -> [UInt64]? { nil }
    func tileRect(_ tile: UInt64) -> CGRect? { nil }
    func tileWindow(_ tile: UInt64) -> Int? { nil }
    func tileMinSize(_ tile: UInt64) -> CGSize? { nil }
    func maxTiles(of space: UInt64) -> Int? { nil }
    func setMaxTiles(_ space: UInt64, _ count: Int) -> Bool { false }
    func setTileRect(_ tile: UInt64, _ rect: CGRect) -> Bool { false }
    func moveTile(_ tile: UInt64, to space: UInt64, index: Int) -> Bool { false }
    func destroyTile(_ tile: UInt64) -> Bool { false }
    var anchorsAvailable: Bool { false }
    func createTile(in space: UInt64) -> UInt64? { nil }
    func setLiveResizing(_ space: UInt64, _ on: Bool) -> Bool { false }
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

    private func settable(_ e: AXUIElement, _ name: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(e, name as CFString, &settable) == .success && settable.boolValue
    }

    // A window Margin can host: a standard one, or one whose AXFullScreen is settable. Nil: neither, or gone.
    private func describe(_ w: AXUIElement, _ number: Int) -> HostWindow? {
        guard (attr(w, kAXRoleAttribute) as? String) == kAXWindowRole else { return nil }
        let fullScreen = settable(w, "AXFullScreen")
        guard fullScreen || (attr(w, kAXSubroleAttribute) as? String) == kAXStandardWindowSubrole else { return nil }
        return HostWindow(number: number, fullScreen: (attr(w, "AXFullScreen") as? Bool) == true, canFullScreen: fullScreen,
                          resizable: settable(w, kAXSizeAttribute), minimized: (attr(w, kAXMinimizedAttribute) as? Bool) == true)
    }

    // Any element of the app's whose window number is `number`: its windows, its main and focused ones, its children.
    // Kept once found (read and set through it after, as a listed one).
    private func find(_ pid: pid_t, _ number: Int) -> HostWindow? {
        func loose(_ w: AXUIElement) -> HostWindow {
            let role = [attr(w, kAXRoleAttribute) as? String, attr(w, kAXSubroleAttribute) as? String].compactMap { $0 }.joined(separator: "/")
            return HostWindow(number: number, fullScreen: (attr(w, "AXFullScreen") as? Bool) == true, canFullScreen: settable(w, "AXFullScreen"),
                              resizable: settable(w, kAXSizeAttribute), minimized: (attr(w, kAXMinimizedAttribute) as? Bool) == true, role: role.isEmpty ? nil : role)
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1)
        var candidates = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        for name in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
            if let v = attr(app, name), CFGetTypeID(v) == AXUIElementGetTypeID() { candidates.append(v as! AXUIElement) }
        }
        candidates += (attr(app, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        for w in candidates {
            var n: CGWindowID = 0
            guard hostWindowNumber(w, &n) == .success, Int(n) == number else { continue }
            elements[number] = (pid, w)
            return loose(w)
        }
        return nil
    }

    func window(pid: pid_t, number: Int) async -> HostWindow? {
        guard !refuses, AXIsProcessTrusted() else { return nil }
        return await withCheckedContinuation { c in queue.async { c.resume(returning: self.find(pid, number)) } }
    }

    private func read(_ pid: pid_t) -> [HostWindow]? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1)
        guard let list = attr(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
        var out: [HostWindow] = []
        for w in list {
            var n: CGWindowID = 0
            guard hostWindowNumber(w, &n) == .success, n > 0, let window = describe(w, Int(n)) else { continue }
            elements[Int(n)] = (pid, w)
            out.append(window)
        }
        // Kept windows not listed now (on another Space) are still read through their element.
        for (number, kept) in elements where kept.pid == pid && !out.contains(where: { $0.number == number }) {
            if let window = describe(kept.element, number) { out.append(window) } else { elements[number] = nil }
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

    func mainWindow(pid: pid_t) async -> Int? { await appWindow(pid, kAXMainWindowAttribute) }
    func focusedWindow(pid: pid_t) async -> Int? { await appWindow(pid, kAXFocusedWindowAttribute) }

    // The number of the app's window an attribute of its element names (its main or focused window).
    private func appWindow(_ pid: pid_t, _ name: String) async -> Int? {
        guard !refuses, AXIsProcessTrusted() else { return nil }
        return await withCheckedContinuation { c in
            queue.async {
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, 1)
                guard let v = self.attr(app, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return c.resume(returning: nil) }
                var n: CGWindowID = 0
                guard hostWindowNumber(v as! AXUIElement, &n) == .success, n > 0 else { return c.resume(returning: nil) }
                c.resume(returning: Int(n))
            }
        }
    }

    func frame(pid: pid_t, window: Int) async -> CGRect? {
        guard !refuses, AXIsProcessTrusted() else { return nil }
        return await withCheckedContinuation { c in
            queue.async {
                guard let e = self.element(pid, window), let p = self.attr(e, kAXPositionAttribute), let s = self.attr(e, kAXSizeAttribute),
                      CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return c.resume(returning: nil) }
                var origin = CGPoint.zero, size = CGSize.zero
                guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return c.resume(returning: nil) }
                c.resume(returning: CGRect(origin: origin, size: size))
            }
        }
    }

    // Position, then size, then position again (an app can move a window it's resizing to keep it on its display).
    // Accessibility's error for the first set it refused (`.success`: all taken; `.cannotComplete`: not tried here).
    func setFrame(pid: pid_t, window: Int, _ frame: CGRect, size: Bool) async -> AXError {
        guard !refuses, AXIsProcessTrusted(), frame.width.isFinite, frame.height.isFinite, frame.minX.isFinite, frame.minY.isFinite else { return .cannotComplete }
        return await withCheckedContinuation { c in
            queue.async {
                guard let e = self.element(pid, window) else { return c.resume(returning: .invalidUIElement) }
                var origin = frame.origin, extent = frame.size
                guard let p = AXValueCreate(.cgPoint, &origin), let s = AXValueCreate(.cgSize, &extent) else { return c.resume(returning: .failure) }
                var first = AXError.success
                func set(_ name: String, _ v: AXValue) {
                    let r = AXUIElementSetAttributeValue(e, name as CFString, v)
                    if r != .success, first == .success { first = r }
                }
                set(kAXPositionAttribute, p)
                if size {
                    set(kAXSizeAttribute, s)
                    set(kAXPositionAttribute, p)
                }
                c.resume(returning: first)
            }
        }
    }

    // The window found again by its number (its windows, its main and focused ones, its children: as a first look), the
    // element found kept in place of the old one. Not found (not listed now): the old one kept as it was.
    func refresh(pid: pid_t, window: Int) async -> Bool {
        guard !refuses, AXIsProcessTrusted() else { return false }
        return await withCheckedContinuation { c in
            queue.async {
                let old = self.elements[window]
                self.elements[window] = nil
                let found = self.find(pid, window) != nil
                if !found { self.elements[window] = old }
                c.resume(returning: found)
            }
        }
    }

    // The app made the front app: AXFrontmost on its application element (an attribute, never a click).
    func frontmost(pid: pid_t) async -> Bool {
        guard !refuses, AXIsProcessTrusted() else { return false }
        return await withCheckedContinuation { c in
            queue.async {
                let app = AXUIElementCreateApplication(pid)
                c.resume(returning: AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success)
            }
        }
    }

    // The window raised and made its app's main one (actions and attributes, never a click).
    func raise(pid: pid_t, window: Int) async -> Bool {
        guard !refuses, AXIsProcessTrusted() else { return false }
        return await withCheckedContinuation { c in
            queue.async {
                guard let e = self.element(pid, window) else { return c.resume(returning: false) }
                let raised = AXUIElementPerformAction(e, kAXRaiseAction as CFString) == .success
                _ = AXUIElementSetAttributeValue(e, kAXMainAttribute as CFString, kCFBooleanTrue)
                c.resume(returning: raised)
            }
        }
    }

    // Its close button pressed (an action, never a click).
    func close(pid: pid_t, window: Int) async -> Bool {
        guard !refuses, AXIsProcessTrusted() else { return false }
        return await withCheckedContinuation { c in
            queue.async {
                guard let e = self.element(pid, window), let b = self.attr(e, kAXCloseButtonAttribute), CFGetTypeID(b) == AXUIElementGetTypeID() else { return c.resume(returning: false) }
                c.resume(returning: AXUIElementPerformAction(b as! AXUIElement, kAXPressAction as CFString) == .success)
            }
        }
    }

    // The app's AXEnhancedUserInterface (an attribute of its application element, not a window's).
    func enhancedUserInterface(pid: pid_t) async -> Bool? {
        guard !refuses, AXIsProcessTrusted() else { return nil }
        return await withCheckedContinuation { c in
            queue.async {
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, 1)
                c.resume(returning: self.attr(app, "AXEnhancedUserInterface") as? Bool)
            }
        }
    }

    func setEnhancedUserInterface(pid: pid_t, _ on: Bool) async -> Bool {
        guard !refuses, AXIsProcessTrusted() else { return false }
        return await withCheckedContinuation { c in
            queue.async {
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, 1)
                c.resume(returning: AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse) == .success)
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
    private let ax = HostAX()
    private var listeners: [pid_t: UnsafeRawPointer] = [:]
    private var quitObserver: NSObjectProtocol?
    var onAppQuit: ((pid_t) -> Void)?

    init(calls: HostPrivate, sky: SkyLight, spaces: SkyLightSpaces, slots: SlotSpaces, freezer: Freezer?,
         sidebarMenu: @escaping () -> SidebarMenu?) {
        self.calls = calls
        self.sky = sky
        self.spacesRW = spaces
        self.slots = slots
        self.freezer = freezer
        self.sidebarMenu = sidebarMenu
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
    // (EPERM: it runs, as another user's; ESRCH: gone.)
    func processRuns(pid: pid_t) -> Bool { pid > 0 && (kill(pid, 0) == 0 || errno == EPERM) }

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

    func appVersion(pid: pid_t) -> String? {
        guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL, let info = Bundle(url: url)?.infoDictionary else { return nil }
        return "\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))"
    }
    func keepsWindowsAtQuit(pid: pid_t) -> Bool {
        guard let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier else { return false }
        let key = "NSQuitAlwaysKeepsWindows"
        // A sandboxed app's own preferences are in its container; CFPreferences reads its plain domain, then the global one.
        let container = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Containers/\(bundle)/Data/Library/Preferences/\(bundle).plist")
        if let d = NSDictionary(contentsOf: container), let v = d[key] as? NSNumber { return v.boolValue }
        return (CFPreferencesCopyAppValue(key as CFString, bundle as CFString) as? NSNumber)?.boolValue ?? false
    }

    func close(pid: pid_t, window: Int) async -> Bool { await ax.close(pid: pid, window: window) }

    func isHidden(pid: pid_t) -> Bool? {
        guard let a = NSRunningApplication(processIdentifier: pid), !a.isTerminated else { return nil }
        return a.isHidden
    }

    func unhide(pid: pid_t) -> Bool {
        guard !PrivateCalls.inTests, let a = NSRunningApplication(processIdentifier: pid), !a.isTerminated else { return false }
        return a.unhide()
    }

    // Sent off the main thread, its answer waited for (at most `reopenAnswerWait`), never interacting, and what came of
    // it said in the log: answered (the app took it: its handler ran), sent and not answered in time, refused by the
    // system (errAEEventNotPermitted -1743: Automation would need its entitlement and the person's consent), or not
    // delivered (its process gone). Seen 2026-11-17 on the real screen without the apple-events entitlement: Chameleon
    // logged each reopen at once, the Phone's UIKit logged `aevt/rapp` and came forward (a reopen is one of the events
    // a hardened app sends without Automation's consent). True: sent to a running app (the answer is the log's).
    nonisolated static let reopenAnswerWait = 1.0
    private let reopenQueue = DispatchQueue(label: "margin.host.reopen", qos: .userInitiated)
    func reopen(pid: pid_t) -> Bool {
        guard !PrivateCalls.inTests, let a = NSRunningApplication(processIdentifier: pid), !a.isTerminated else { return false }
        let bundle = a.bundleIdentifier ?? "pid \(pid)"
        reopenQueue.async { Self.sendReopen(pid: pid, bundle: bundle) }
        return true
    }
    nonisolated private static func sendReopen(pid: pid_t, bundle: String) {
        let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEReopenApplication),
                                           targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid), returnID: AEReturnID(kAutoGenerateReturnID),
                                           transactionID: AETransactionID(kAnyTransactionID))
        guard let desc = event.aeDesc else { return }
        var reply = AEDesc()
        let t0 = ProcessInfo.processInfo.systemUptime
        let err = AESendMessage(desc, &reply, AESendMode(kAEWaitReply | kAENeverInteract), Int(reopenAnswerWait * 60))
        AEDisposeDesc(&reply)
        let ms = Int(((ProcessInfo.processInfo.systemUptime - t0) * 1000).rounded())
        let said: String
        switch Int(err) {
        case Int(noErr): said = "delivered: answered in \(ms) ms"
        case Int(errAETimeout): said = "sent, not answered within \(ms) ms (the app's handler hadn't run)"
        case -1743: said = "REFUSED by the system (error -1743: Automation's entitlement and the person's consent would be needed)"
        case Int(procNotFound), Int(connectionInvalid): said = "not delivered (error \(err): its process is gone)"
        default: said = "error \(err) after \(ms) ms"
        }
        DispatchQueue.main.async { MainActor.assumeIsolated { Diagnostics.note("host: a reopen (kAEReopenApplication) to \(bundle) (pid \(pid)): \(said)") } }
    }

    func enhancedUserInterface(pid: pid_t) async -> Bool? { await ax.enhancedUserInterface(pid: pid) }
    func setEnhancedUserInterface(pid: pid_t, _ on: Bool) async -> Bool { await ax.setEnhancedUserInterface(pid: pid, on) }

    func windows(pid: pid_t) async -> [HostWindow]? { await ax.windows(pid: pid) }
    func window(pid: pid_t, number: Int) async -> HostWindow? { await ax.window(pid: pid, number: number) }
    func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool { await ax.setFullScreen(pid: pid, window: window, on) }
    func isFullScreen(pid: pid_t, window: Int) async -> Bool? { await ax.isFullScreen(pid: pid, window: window) }
    func mainWindow(pid: pid_t) async -> Int? { await ax.mainWindow(pid: pid) }
    func focusedWindow(pid: pid_t) async -> Int? { await ax.focusedWindow(pid: pid) }
    func frame(pid: pid_t, window: Int) async -> CGRect? { await ax.frame(pid: pid, window: window) }
    private var frameErrors: [Int: Int32] = [:]
    func setFrame(pid: pid_t, window: Int, _ frame: CGRect, size: Bool) async -> Bool {
        let r = await ax.setFrame(pid: pid, window: window, frame, size: size)
        if r == .success { frameErrors[window] = nil } else { frameErrors[window] = r.rawValue }
        return r == .success
    }
    func frameError(window: Int) -> Int32? { frameErrors[window] }
    func refreshWindow(pid: pid_t, window: Int) async -> Bool { await ax.refresh(pid: pid, window: window) }

    func activate(pid: pid_t, window: Int) async -> Bool {
        guard !PrivateCalls.inTests, let a = NSRunningApplication(processIdentifier: pid), !a.isTerminated else { return false }
        let raised = await ax.raise(pid: pid, window: window)
        return a.activate(from: NSRunningApplication.current, options: []) || raised
    }
    func frontmost(pid: pid_t) async -> Bool {
        guard !PrivateCalls.inTests, NSRunningApplication(processIdentifier: pid).map({ !$0.isTerminated }) == true else { return false }
        return await ax.frontmost(pid: pid)
    }
    func frontApp() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

    // The View › Show Sidebar item's title (SafariAX, ShellSafariSidebar.swift): "Hide Sidebar" while it's open,
    // "Show Sidebar" while it's closed; in another language, unknown.
    func safariSidebar(pid: pid_t) async -> HostSidebar {
        guard let menu = sidebarMenu() else { return .unknown }
        let title: String? = await withCheckedContinuation { c in menu.title(pid: pid) { c.resume(returning: $0) } }
        guard let title, !title.isEmpty else { return .unknown }
        if title == "Hide Sidebar" { return .open }
        if title == "Show Sidebar" { return .closed }
        return .unknown
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

    func serverWindows(pid: pid_t) -> [ServerWindow]? { CGWindowSource().read(of: [pid])?.filter { $0.pid == pid } }
    func onScreenWindows() -> [ServerWindow]? { CGWindowSource().onScreen() }
    func windowOnScreen(_ number: Int) -> (onScreen: Bool, alpha: Double)? {
        guard number > 0, let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(number)) as? [[String: Any]],
              let w = list.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == number }) else { return nil }
        return ((w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false, (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }
    func screenAway() -> Bool {
        if CGDisplayIsAsleep(CGMainDisplayID()) != 0 { return true }
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if session["CGSSessionScreenIsLocked"] as? Bool == true { return true }
        return session[kCGSessionOnConsoleKey as String] as? Bool == false
    }
    func currentSpaces() -> [String]? {
        spacesRW.displays()?.map { d in "\(d.current.map { "\($0)" } ?? "none")\(d.current.map { c in d.spaces.contains { $0.id == c } } == false ? " (not listed)" : "")" }
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

    func listedFullScreenSpaces() -> [UInt64]? { spacesRW.displays()?.flatMap(\.fullScreen) }

    func fullScreenSpaceOwners() -> [UInt64: pid_t]? {
        guard let raw = sky.managedDisplaySpaces() else { return nil }
        var out: [UInt64: pid_t] = [:]
        for d in raw {
            for s in (d["Spaces"] as? [[String: Any]]) ?? [] {
                guard (s["type"] as? NSNumber)?.intValue == ManagedSpace.fullScreenType, let id = (s["id64"] as? NSNumber)?.uint64Value else { continue }
                out[id] = (s["pid"] as? NSNumber)?.int32Value ?? 0
            }
        }
        return out
    }

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

    // ---- the tiles ----
    var tilesAvailable: Bool { calls.hasTiles }
    func tiles(of space: UInt64) -> [UInt64]? { calls.tiles(of: space) }
    func tileRect(_ tile: UInt64) -> CGRect? {
        guard let r = calls.values(of: tile)?["TileRect"] as? [String: Any] else { return nil }
        func v(_ k: String) -> CGFloat? { (r[k] as? NSNumber).map { CGFloat($0.doubleValue) } }
        guard let x = v("X"), let y = v("Y"), let w = v("Width"), let h = v("Height"), [x, y, w, h].allSatisfy(\.isFinite) else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }
    func tileWindow(_ tile: UInt64) -> Int? { (calls.values(of: tile)?["TileWindowID"] as? NSNumber)?.intValue }
    func tileMinSize(_ tile: UInt64) -> CGSize? {
        guard let m = (calls.values(of: tile)?["SizeConstraints"] as? [String: Any])?["Min"] as? [String: Any],
              let w = (m["Width"] as? NSNumber)?.doubleValue, let h = (m["Height"] as? NSNumber)?.doubleValue, w.isFinite, h.isFinite, w >= 1, h >= 1 else { return nil }
        return CGSize(width: w, height: h)
    }
    func maxTiles(of space: UInt64) -> Int? {
        let manager = calls.values(of: space)?["TileLayoutManager"] as? [String: Any]
        return ((manager?["Max Tile Config"] as? [String: Any])?["Width"] as? NSNumber)?.intValue
    }
    func setMaxTiles(_ space: UInt64, _ count: Int) -> Bool {
        count > 0 && calls.setValues(space, ["Max Tile Config": ["Width": count, "Height": 1]])
    }
    func setTileRect(_ tile: UInt64, _ rect: CGRect) -> Bool {
        guard [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite), rect.width >= 1, rect.height >= 1 else { return false }
        return calls.setValues(tile, ["TileRect": ["X": Double(rect.minX), "Y": Double(rect.minY), "Width": Double(rect.width), "Height": Double(rect.height)]])
    }
    func moveTile(_ tile: UInt64, to space: UInt64, index: Int) -> Bool { calls.moveTile(tile, to: space, index: index) }
    func destroyTile(_ tile: UInt64) -> Bool { calls.hasTiles && calls.destroyFullScreenSpace(tile) }
    var anchorsAvailable: Bool { calls.hasAnchors }
    func createTile(in space: UInt64) -> UInt64? {
        let (sent, tile) = calls.createTile(in: space)
        return sent ? (tile ?? 0) : nil // (0: sent, its id not said)
    }
    // (Set false at the end, never removed: a key taken away doesn't end the live resize, the kit's lead 4.)
    func setLiveResizing(_ space: UInt64, _ on: Bool) -> Bool { calls.setValues(space, ["LiveResizing": on]) }
}
