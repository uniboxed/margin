// Explicit owned/off-screen component verification; never a browser or display
// capture. This does not establish OS lock delivery or the full cover watchdog.
import AppKit
import WebKit

@main enum CleanupProbe {
    @MainActor static var lastWindow = 0
    @MainActor static func blockOwnMainThread() { Thread.sleep(forTimeInterval: 0.15) }
    @MainActor static func waitOwnProbe(_ done: DispatchSemaphore) -> Bool { done.wait(timeout: .now() + 1) == .success }
    @MainActor static func round(_ iteration: Int, sky: SkyLight) async -> Bool {
        let io = LiveCoverSpaceIO.real(sky)
        let setting = CoverPresentationIO.real()
        let presentation = CoverPresentation(io: setting)
        var panel: NSPanel? = NSPanel(contentRect: NSRect(x: -20000, y: -20000, width: 96, height: 64),
                                     styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        var view: WKWebView? = WKWebView(frame: NSRect(x: 0, y: 0, width: 96, height: 64))
        var space: LiveCoverSpace?
        defer {
            panel?.orderOut(nil); CATransaction.flush()
            _ = space?.close(); _ = presentation.restore()
            view?.removeFromSuperview(); panel?.close()
        }
        guard let p = panel, let v = view, let original = setting.read(v),
              !NSScreen.screens.contains(where: { $0.frame.intersects(p.frame) }) else { return false }
        p.isReleasedWhenClosed = false; p.hidesOnDeactivate = false
        p.alphaValue = 0; p.contentView = v
        guard presentation.hold(v) else { return false }
        v.loadHTMLString("<script>window.count=0;function tick(){count++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>", baseURL: nil)
        p.orderFrontRegardless(); p.displayIfNeeded(); CATransaction.flush()
        let number = p.windowNumber
        lastWindow = number
        guard case .success(let owned) = LiveCoverSpace.open(window: UInt32(number), io: io) else { return false }
        space = owned
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while !owned.isReady && ProcessInfo.processInfo.systemUptime < deadline { try? await Task.sleep(nanoseconds: 10_000_000) }
        guard owned.isReady, let row = CGWindowSource().windows(of: [ProcessInfo.processInfo.processIdentifier]).first(where: { $0.number == number }),
              !ScreenGeometry.displayFrames.contains(where: { $0.frame.intersects(row.bounds) }) else { return false }
        // Still physically off screen, now nonzero alpha so the independent
        // background hide read proves a change while this main thread sleeps.
        p.alphaValue = 1; CATransaction.flush()
        let alphaDeadline = ProcessInfo.processInfo.systemUptime + 0.5
        func raised() -> Bool {
            CGWindowSource().windows(of: [ProcessInfo.processInfo.processIdentifier]).first(where: { $0.number == number })?.alpha == 1
        }
        while !raised(), ProcessInfo.processInfo.systemUptime < alphaDeadline { try? await Task.sleep(nanoseconds: 10_000_000) }
        guard raised() else { return false }
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.03) { _ = owned.hide(); done.signal() }
        blockOwnMainThread()
        guard waitOwnProbe(done), owned.isHidden,
              let hidden = CGWindowSource().windows(of: [ProcessInfo.processInfo.processIdentifier]).first(where: { $0.number == number }),
              hidden.alpha == 0 else { return false }
        p.orderOut(nil); CATransaction.flush()
        var cleaned = owned.close()
        for _ in 0..<2 where !cleaned { try? await Task.sleep(nanoseconds: 10_000_000); cleaned = owned.close() }
        let restored = presentation.restore()
        guard cleaned, sky.coverLevel(owned.number) == 0, restored, presentation.count == 0, setting.read(v) == original else { return false }
        v.removeFromSuperview(); p.close(); view = nil; panel = nil
        print("round \(iteration): own membership/level400, background hide while main blocked, level0 and presentation restored")
        return true
    }
    @MainActor static func main() {
        guard ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] == nil else { print("refused under app tests"); exit(2) }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            let resolver = RealPrivateResolver()
            let availability = PrivateCalls.check(resolver: resolver, defaults: nil)
            guard availability.liveCover else { print("not measured: capability unavailable"); exit(2) }
            let sky = SkyLight(resolver: resolver, availability: availability)
            for i in 1...3 {
                guard await round(i, sky: sky) else { print("failed owned off-screen round \(i); no further round"); exit(1) }
                let until = ProcessInfo.processInfo.systemUptime + 1
                @MainActor func windowGone() -> Bool {
                    !CGWindowSource().windows(of: [ProcessInfo.processInfo.processIdentifier]).contains { $0.number == lastWindow }
                }
                while !windowGone(), ProcessInfo.processInfo.systemUptime < until { try? await Task.sleep(nanoseconds: 10_000_000) }
                guard windowGone() else { print("owned window cleanup unverified; no further round"); exit(1) }
            }
            print("all 3 owned off-screen component rounds passed; no browser/window/lock/display acceptance inferred")
            exit(0)
        }
        app.run()
    }
}
