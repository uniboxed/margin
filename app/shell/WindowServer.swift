// What the window server says about windows, without any permission
// (PLAN.md §6, tested in Phase 0): CGWindowListCopyWindowInfo gives every
// window's number, owner, layer, bounds, alpha and whether it's on screen,
// front to back, but no titles (those need Screen Recording, and Margin
// doesn't read them). Reading it costs about 0.2 ms. The apps (which is in
// front, which browser is which process) come from NSWorkspace.
//
// Coordinates: the window server's are from the top left of the main
// display, y down (as windows.get's left/top are); AppKit's from its bottom
// left, y up. `appKitRect` turns one into the other.

import AppKit
import CoreGraphics

struct ServerWindow: Equatable {
    let number: Int
    let pid: pid_t
    let layer: Int
    let bounds: CGRect // top-left origin
    let onScreen: Bool
    let alpha: Double
    // Its place in the window server's list (front to back): lower is nearer the front.
    let order: Int

    init(number: Int, pid: pid_t, layer: Int = 0, bounds: CGRect, onScreen: Bool = true, alpha: Double = 1, order: Int = 0) {
        (self.number, self.pid, self.layer, self.bounds, self.onScreen, self.alpha, self.order) = (number, pid, layer, bounds, onScreen, alpha, order)
    }
}

protocol WindowSource {
    // Every window of these processes (on every Space), plus the on-screen windows above them
    // (all processes), in the window server's order. Overlays' own windows included.
    func windows(of pids: Set<pid_t>) -> [ServerWindow]
}

struct CGWindowSource: WindowSource {
    func windows(of pids: Set<pid_t>) -> [ServerWindow] {
        guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var out: [ServerWindow] = []
        out.reserveCapacity(64)
        for (i, w) in list.enumerated() {
            guard let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let number = (w[kCGWindowNumber as String] as? NSNumber)?.intValue,
                  let raw = w[kCGWindowBounds as String], let bounds = CGRect(dictionaryRepresentation: raw as! CFDictionary) else { continue }
            let onScreen = (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
            // Other processes' windows only where they could be between an overlay and its browser window.
            guard pids.contains(pid) || onScreen else { continue }
            out.append(ServerWindow(number: number, pid: pid, layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0, bounds: bounds,
                                    onScreen: onScreen, alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1, order: i))
        }
        return out
    }
}

enum ScreenGeometry {
    // The main display's height (AppKit's screens[0]: the one with the menu bar, origin 0,0).
    static var mainHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    // A top-left rect (window server, windows.get) in AppKit's coordinates, and back (the same flip).
    static func appKitRect(_ r: CGRect, mainHeight: CGFloat = mainHeight) -> CGRect {
        CGRect(x: r.minX, y: mainHeight - r.maxY, width: r.width, height: r.height)
    }

    // AppKit's point (NSEvent.mouseLocation) from the top left.
    static func topLeftPoint(_ p: CGPoint, mainHeight: CGFloat = mainHeight) -> CGPoint {
        CGPoint(x: p.x, y: mainHeight - p.y)
    }
}

// Which apps are running and in front (NSWorkspace; tests script it).
protocol AppWatch: AnyObject {
    var frontPid: pid_t? { get }
    func pids(of bundleId: String) -> Set<pid_t>
    // Something changed that may have moved windows (an app activated, the Space or displays changed).
    var onChange: ((String) -> Void)? { get set }
    func start()
    func stop()
}

final class WorkspaceApps: AppWatch {
    var onChange: ((String) -> Void)?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    var frontPid: pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

    func pids(of bundleId: String) -> Set<pid_t> {
        Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).filter { !$0.isTerminated }.map(\.processIdentifier))
    }

    func start() {
        guard observers.isEmpty else { return }
        let workspace = NSWorkspace.shared.notificationCenter
        let names: [(NotificationCenter, Notification.Name, String)] = [
            (workspace, NSWorkspace.didActivateApplicationNotification, "app activated"),
            (workspace, NSWorkspace.didLaunchApplicationNotification, "app launched"),
            (workspace, NSWorkspace.didTerminateApplicationNotification, "app quit"),
            (workspace, NSWorkspace.activeSpaceDidChangeNotification, "Space changed"),
            (workspace, NSWorkspace.didWakeNotification, "woke"),
            (NotificationCenter.default, NSApplication.didChangeScreenParametersNotification, "displays changed"),
        ]
        for (center, name, why) in names {
            observers.append((center, center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.onChange?(why) }
            }))
        }
    }

    func stop() {
        for (center, observer) in observers { center.removeObserver(observer) }
        observers = []
    }
}
