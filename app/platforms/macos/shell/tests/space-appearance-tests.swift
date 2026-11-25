// A space's appearance (M2.9 step 3, docs/SPACE-BACKGROUNDS.md Part B §3): what Margin's window draws in is the
// space's light or dark (its background's), set as its web view's own appearance. First what that rests on: WebKit
// takes a web view's appearance as the page's `prefers-color-scheme` and `light-dark()`, with the view's system
// appearance off (most themes) and on (Liquid Glass: OverlaySystemAppearance); none set, the window's (the system's).

import AppKit
import WebKit

private func spin(_ seconds: TimeInterval, until test: () -> Bool = { false }) {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end, !test() { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
}

/// The page's `prefers-color-scheme: dark` and the colour `light-dark()` gives, read from the page (nil: no answer).
@MainActor private func scheme(_ view: WKWebView) -> (dark: Bool, color: String)? {
    var out: (dark: Bool, color: String)?
    var done = false
    view.evaluateJavaScript("[matchMedia('(prefers-color-scheme: dark)').matches, getComputedStyle(document.body).color]") { value, _ in
        if let list = value as? [Any], list.count == 2, let dark = list[0] as? Bool, let color = list[1] as? String { out = (dark, color) }
        done = true
    }
    spin(3, until: { done })
    return out
}

@MainActor func spaceAppearanceTests() {
    webViewsAppearance()
}

@MainActor private func webViewsAppearance() {
    let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 320, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
    let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 200))
    window.contentView = view
    view.loadHTMLString("<!doctype html><html><head><style>:root{color-scheme:light dark}body{color:light-dark(rgb(1, 2, 3), rgb(4, 5, 6))}</style></head><body>x</body></html>", baseURL: nil)
    spin(5, until: { scheme(view) != nil })
    check("space appearance: the page loaded", scheme(view) != nil)
    for system in [false, true] {
        let switched = OverlaySystemAppearance.set(system, for: view)
        if system && switched != "on" { check("space appearance: system appearance on (\(switched))", ProcessInfo.processInfo.operatingSystemVersion.majorVersion < 26); continue }
        let label = system ? "with system appearance on" : "with system appearance off"
        for (name, dark) in [(NSAppearance.Name.darkAqua, true), (NSAppearance.Name.aqua, false), (NSAppearance.Name.darkAqua, true)] {
            view.appearance = NSAppearance(named: name)
            spin(3, until: { scheme(view)?.dark == dark })
            let got = scheme(view)
            check("space appearance: \(name.rawValue) \(label): prefers-color-scheme \(dark ? "dark" : "light")", got?.dark == dark, "\(String(describing: got))")
            check("space appearance: \(name.rawValue) \(label): light-dark() follows", got?.color == (dark ? "rgb(4, 5, 6)" : "rgb(1, 2, 3)"), "\(String(describing: got))")
        }
        // None set: the window's (here the system's, what the app's windows have).
        view.appearance = nil
        let systemDark = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        spin(3, until: { scheme(view)?.dark == systemDark })
        check("space appearance: none set \(label): the window's (\(systemDark ? "dark" : "light"))", scheme(view)?.dark == systemDark)
    }
    _ = OverlaySystemAppearance.set(false, for: view)
    window.close()
}
