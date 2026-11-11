// Issue #15: a temporary high-level Space containing only Margin's own cover window.
// No foreign-window writes, captures, event taps or browser windows. All writes are
// checked, and every failed setup destroys the Space it allocated.
import Foundation
import CoreGraphics

nonisolated struct LiveCoverSpaceIO: @unchecked Sendable {
    var owns: @Sendable (UInt32) -> Bool
    var create: @Sendable () -> UInt64?
    var level: @Sendable (UInt64) -> Bool
    var readLevel: @Sendable (UInt64) -> Int32?
    var add: @Sendable (UInt32, UInt64) -> Bool
    var show: @Sendable (UInt64) -> Bool
    var hide: @Sendable (UInt64) -> Bool
    var hideWindow: @Sendable (UInt32) -> Bool
    var destroy: @Sendable (UInt64) -> Bool
    var spaces: @Sendable (UInt32) -> [UInt64]?

    static func real(_ sky: SkyLight) -> LiveCoverSpaceIO {
        let owns: @Sendable (UInt32) -> Bool = { number in
            guard !sky.refuses, let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, number) as? [[String: Any]] else { return false }
            return rows.contains { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == number
                && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == ProcessInfo.processInfo.processIdentifier }
        }
        return LiveCoverSpaceIO(owns: owns, create: { sky.createCoverSpace() }, level: { sky.setCoverLevel($0) }, readLevel: { sky.coverLevel($0) }, add: { sky.addCoverWindow($0, to: $1) },
        show: { sky.showCoverSpace($0) }, hide: { sky.hideCoverSpace($0) }, hideWindow: { n in owns(n) && sky.hideCoverWindow(n) }, destroy: { sky.destroyCoverSpace($0) },
        // Mask 7 intentionally omits private/application Spaces (parking uses
        // that property). This own high-level Space needs the OS-space bit too.
        spaces: { sky.spaces(forWindows: [$0], mask: 15) })
    }
}

nonisolated enum LiveCoverSpaceFailure: String, Error, Sendable {
    case ownership, create, level, add, membership, show
}

nonisolated final class LiveCoverSpace: @unchecked Sendable {
    let number: UInt64
    let window: UInt32
    private let io: LiveCoverSpaceIO
    private let lock = NSLock()
    private var ended = false
    private var hidden = false

    private init(number: UInt64, window: UInt32, io: LiveCoverSpaceIO) { self.number = number; self.window = window; self.io = io }

    static func open(window: UInt32, io: LiveCoverSpaceIO) -> Result<LiveCoverSpace, LiveCoverSpaceFailure> {
        guard window != 0, io.owns(window) else { return .failure(.ownership) }
        guard let number = io.create(), number != 0 else { return .failure(.create) }
        let lease = LiveCoverSpace(number: number, window: window, io: io)
        func failed(_ why: LiveCoverSpaceFailure) -> Result<LiveCoverSpace, LiveCoverSpaceFailure> { _ = lease.close(); return .failure(why) }
        guard io.level(number) else { return failed(.level) }
        // Match the independently tested operator: show the empty special Space
        // before assigning its own window. The panel is still alpha zero.
        guard io.show(number) else { return failed(.show) }
        guard io.owns(window) else { return failed(.ownership) }
        guard io.add(window, number) else { return failed(.add) }
        return .success(lease)
    }

    // The setters are asynchronous on current macOS. Unknown/wrong reads wait
    // at alpha zero; the owner bounds that wait and never starts the browser yet.
    var isReady: Bool {
        guard !isHidden else { return false }
        let ready = io.spaces(window) == [number] && io.readLevel(number) == 400
        return ready && !isHidden
    }

    // Emergency watchdog: hide on its private queue even if the main thread is stuck.
    // Destruction waits for the owner to order its panel out on the main actor first;
    // otherwise destroying a Space can return a still-visible panel to the Desktop.
    @discardableResult func hide() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !ended, !hidden else { return true }
        // Direct own-window alpha, not the async Space/WM bridge: verified with
        // an owned off-screen panel while its main thread was blocked (26B131).
        let ok = io.owns(window) && io.hideWindow(window)
        hidden = ok
        return ok
    }

    @discardableResult func close() -> Bool {
        lock.lock()
        guard !ended else { lock.unlock(); return true }
        ended = true
        lock.unlock() // never hold the watchdog's lock across a synchronous bridge read
        let hid = io.hide(number) || io.hide(number)
        let destroyed = io.destroy(number)
        return hid && destroyed && io.readLevel(number) == 0
    }

    var isHidden: Bool { lock.lock(); defer { lock.unlock() }; return hidden || ended }
    deinit { _ = close() }
}
