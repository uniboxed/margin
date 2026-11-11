import AppKit
import WebKit

@MainActor func readCount(_ view: WKWebView) async -> Int? {
    await withCheckedContinuation { done in
        view.evaluateJavaScript("window.frameCount") { value, _ in done.resume(returning: (value as? NSNumber)?.intValue) }
    }
}
@main enum Probe {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            let lease = CoverPresentation(io: .real())
            guard lease.reason == nil else { print("not measured", lease.reason!); exit(2) }
            let panel = NSPanel(contentRect: NSRect(x: -20000, y: -20000, width: 1000, height: 600), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false; panel.alphaValue = 0
            let root = NSView(frame: NSRect(x: 0, y: 0, width: 1000, height: 600))
            let normal = WKWebView(frame: NSRect(x: 0, y: 0, width: 500, height: 600))
            let held = WKWebView(frame: NSRect(x: 500, y: 0, width: 500, height: 600))
            root.addSubview(normal); root.addSubview(held); panel.contentView = root
            guard lease.hold(held) else { print("failed own-view write/readback"); exit(1) }
            let page = "<script>window.frameCount=0;function tick(){frameCount++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>"
            normal.loadHTMLString(page, baseURL: nil); held.loadHTMLString(page, baseURL: nil)
            panel.orderFrontRegardless(); panel.displayIfNeeded(); CATransaction.flush()
            for _ in 0..<50 {
                if await readCount(normal) != nil, await readCount(held) != nil { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            let a0 = await readCount(normal), b0 = await readCount(held)
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            let a1 = await readCount(normal), b1 = await readCount(held)
            panel.orderOut(nil); CATransaction.flush()
            let restored = lease.restore()
            panel.close()
            print("own invisible window; normal rAF", a0 as Any, a1 as Any, "held rAF", b0 as Any, b1 as Any, "restored", restored, "leases", lease.count)
            guard let a0, let a1, let b0, let b1, a1-a0 == 0, b1-b0 > 10, restored, lease.count == 0 else { exit(1) }
            exit(0)
        }
        app.run()
    }
}
