// The edge stop (ShellSafariSidebar.swift): while a full-screen Safari window with Margin's layout is in front, the
// pointer stops 5 pt from its left edge, so Safari's own sidebar never opens there.
//
// AppKit reveals a full-screen window's collapsed sidebar when a mouse-moved event lands in the 4 pt inside its
// leading edge (NSSplitViewItemFullscreenEdgeInWindowPadding, default 4; none outside the window: ...OffWindowPadding,
// default 0) and the pointer rests there 0.5 s (...FullscreenEdgeRevealDelay), heard by local and global event
// monitors (AppKit's NSSplitViewController(RevealOnEdgeHover), read 2026-11-07), so an invisible window over the edge
// never stopped it. An event tap (Accessibility, which Margin has) moves each mouse-moved event that would land left of
// the stop to the stop, and the pointer with it: thrown left, it stops there, as at an edge. Margin's own sidebar
// reveal zone is 24 pt in full screen, so it still comes out.
//
// - Only while a fence is set (Shell.updateKeys: the front window's overlay shown, its window in full screen); the tap is
//   off otherwise, so nothing else's pointer is touched.
// - Not where a display lies to the left of the window: the pointer must cross there (and moving across never rests).
// - On its own thread, so a busy moment on Margin's main thread never holds the pointer up. Nothing stored: quit or
//   remove Margin and it's gone.

import AppKit

nonisolated final class EdgeStop: @unchecked Sendable {
    struct Fence: Equatable { var x: CGFloat; var top: CGFloat; var bottom: CGFloat }

    /// Past AppKit's 4 pt edge zone.
    static let inset: CGFloat = 5

    /// The stop for a full-screen window (top-left coordinates); nil where a display lies to its left beside it.
    static func fence(window: CGRect, displays: [(frame: CGRect, topInset: CGFloat)]) -> Fence? {
        guard window.width > inset * 2 else { return nil }
        let beside = displays.contains { d in abs(d.frame.maxX - window.minX) <= 1 && d.frame.minY < window.maxY && d.frame.maxY > window.minY }
        return beside ? nil : Fence(x: window.minX + inset, top: window.minY, bottom: window.maxY)
    }

    /// Where a pointer at `p` goes instead (nil: where it is).
    static func clamp(_ p: CGPoint, _ fence: Fence?) -> CGPoint? {
        guard let f = fence, p.x < f.x, p.y >= f.top, p.y < f.bottom else { return nil }
        return CGPoint(x: f.x, y: p.y)
    }

    private let lock = NSLock()
    private var fence: Fence?
    private var tap: CFMachPort?
    private var started = false
    private var failed = false

    var current: Fence? { lock.withLock { fence } }

    /// The stop now (nil: none, the tap off).
    func set(_ next: Fence?) {
        let changed: Bool = lock.withLock {
            guard fence != next else { return false }
            fence = next
            return true
        }
        guard changed else { return }
        if next != nil, !started { start() }
        lock.withLock { if let tap { CGEvent.tapEnable(tap: tap, enable: next != nil) } }
    }

    private func start() {
        started = true
        let thread = Thread { [weak self] in self?.run() }
        thread.name = "margin.edge-stop"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    private func run() {
        let mask = CGEventMask(1 << CGEventType.mouseMoved.rawValue)
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let stop = Unmanaged<EdgeStop>.fromOpaque(refcon).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                stop.reenable()
            } else if type == .mouseMoved, let to = EdgeStop.clamp(event.location, stop.current) {
                event.location = to
                CGWarpMouseCursorPosition(to)
                CGAssociateMouseAndMouseCursorPosition(1) // (no pause after the warp)
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: me) else {
            failed = true
            DispatchQueue.main.async { Diagnostics.note("edge stop: the pointer can't be watched (Accessibility not granted?): Safari's sidebar may still open at the left edge") }
            return
        }
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        lock.withLock {
            self.tap = tap
            CGEvent.tapEnable(tap: tap, enable: fence != nil)
        }
        CFRunLoopRun()
    }

    private func reenable() {
        lock.withLock { if let tap, fence != nil { CGEvent.tapEnable(tap: tap, enable: true) } }
    }
}
