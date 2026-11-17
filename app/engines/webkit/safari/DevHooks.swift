// DEV-HOOK: this whole file goes before production, with every line marked DEV-HOOK in the other files
// (`git grep DEV-HOOK` finds them all).
//
// A dev-only test hook for the on-screen checks of hosting (TESTING.md), with no Accessibility, no AppleScript and
// no clicks:
//
// - Distributed notifications, `com.unibox.margin.dev.host`, as ExtensionLink hears the extension's (its fields in
//   userInfo, or a JSON string as the object), with deliverImmediately (and heard that way too, so Margin.app not
//   being the active app holds nothing back).
// - Off unless `defaults write com.unibox.margin MarginDevHooks -bool YES`. Read at each notification, never kept:
//   turned off, the next one is refused.
// - `host { app: bundle id }` or `host { url: http(s) address }`: what a palette pick does, in Margin's front window;
//   `host { forget: test, apps? }`: the items the checks themselves added, removed from the library.
// - For the check of Margin's window in front of what it hosts (2026-11-17, /tmp/margin-toolbar-test/hosted/check10):
//   `host { key: palette }`: Margin's palette key, as its hot key runs it; `host { key: close }`: what a press outside a
//   field of Margin's does (the palette goes); `host { sidebar: <points> }`: the front window's sidebar that wide, as a
//   drag of its edge that ends there (begun, the theme's width set, over); `host { say: front }`: one line with how
//   the front window is kept in front, the page card's state and its hole (numbers only); `host { say: picture }`: how
//   much of the page area is painted in the window server's picture of Margin's own window (its own process's window:
//   no permission; alpha only, no pixel leaves the app), and with `watch: <seconds>` the same every 50 ms for that
//   long, summed up by page state in one line at the end.
// - Each notification is one log line, honoured or refused: the kind, ids and the sender's pid (as it says it). The
//   address itself is never logged.

import AppKit
import CoreFoundation

// DEV-HOOK: what the hook needs from the shell (Shell, below; the tests' fake).
protocol DevHookWorld: AnyObject {
    // What a palette pick does, an installed app by bundle id or an address in a new web item, in Margin's front
    // window. Nil if asked, else why not.
    func devHost(app: String?, url: String?) -> String?
    func devForgetTestItems(also apps: [String]) -> String? // nil if done, else why not (`apps`: app items a check added)
    // Margin's palette key (`palette`) or a press outside its field (`close`), in the window hosting; nil if done.
    func devKey(_ name: String) -> String?
    func devSidebar(width: Int) -> String? // the front window's sidebar that wide, as a drag that ends there; nil if begun
    func devFront() -> String // how the front window is in front, its page card and its hole, in one line
    func devPicture(watch seconds: Double?, done: @escaping (String) -> Void) // the page area in Margin's own window's picture
}

// DEV-HOOK: the hook itself.
final class DevHooks {
    static let retainedLineLimit = 128
    static let prefix = "com.unibox.margin.dev."
    static let defaultsKey = "MarginDevHooks"
    enum Kind: String, CaseIterable { case host }

    weak var world: DevHookWorld?
    let isOn: () -> Bool // the MarginDevHooks default, read each time
    private var receiver: Receiver?
    private(set) var lines: [String] = [] // what it said (the tests read it)

    init(world: DevHookWorld, isOn: @escaping () -> Bool) {
        self.world = world
        self.isOn = isOn
    }

    static func appDefault() -> Bool { UserDefaults.standard.bool(forKey: defaultsKey) }

    func listen(_ center: DistributedNotificationCenter = .default()) {
        guard receiver == nil else { return }
        let r = Receiver { [weak self] name, fields in
            guard let self, name.hasPrefix(Self.prefix), let kind = Kind(rawValue: String(name.dropFirst(Self.prefix.count))) else { return }
            self.heard(kind, fields)
        }
        for kind in Kind.allCases {
            center.addObserver(r, selector: #selector(Receiver.heard(_:)), name: NSNotification.Name(Self.prefix + kind.rawValue), object: nil, suspensionBehavior: .deliverImmediately)
        }
        receiver = r
        Diagnostics.note("dev hook: listening for \(Self.prefix)* (honoured only while \(Self.defaultsKey) is YES, now \(isOn() ? "YES" : "off"))")
    }

    func stop(_ center: DistributedNotificationCenter = .default()) {
        guard let r = receiver else { return }
        center.removeObserver(r)
        receiver = nil
    }

    // One notification: honoured or refused, one line either way (returned).
    @discardableResult func heard(_ kind: Kind, _ fields: [String: String]) -> String {
        let pid = fields["pid"].flatMap { Int($0) }.map(String.init) ?? "?"
        let asked = "(asked by pid \(pid))"
        func refuse(_ why: String) -> String { say("dev hook: \(Self.prefix)\(kind.rawValue) refused: \(why) \(asked)") }
        guard isOn() else { return refuse("\(Self.defaultsKey) isn't YES") }
        guard let world else { return refuse("no shell") }
        switch kind {
        case .host:
            // `forget`: the items the on-screen checks themselves added, removed from the library (only these test
            // targets: the kit's test app, example.com / example.org).
            if fields["forget"] == "test" {
                if let why = world.devForgetTestItems(also: (fields["apps"] ?? "").split(separator: ",").map(String.init).filter { id in id.count <= 155 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") } }) { return refuse(why) }
                return say("dev hook: host forget test items \(asked)")
            }
            if let key = fields["key"] {
                guard key == "palette" || key == "close" else { return refuse("no such key") }
                if let why = world.devKey(key) { return refuse(why) }
                return say("dev hook: host key \(key) \(asked)")
            }
            if let wide = fields["sidebar"] {
                guard let width = Int(wide), (160...640).contains(width) else { return refuse("not a width") }
                if let why = world.devSidebar(width: width) { return refuse(why) }
                return say("dev hook: host sidebar \(width) \(asked)")
            }
            if fields["say"] == "front" { return say("dev hook: front: \(world.devFront()) \(asked)") }
            if fields["say"] == "picture" {
                let seconds = fields["watch"].flatMap { Double($0) }.map { min(20, max(0.2, $0)) }
                world.devPicture(watch: seconds) { [weak self] line in self?.say("dev hook: picture: \(line) \(asked)") }
                return say("dev hook: host say picture\(seconds.map { " for \($0) s" } ?? "") \(asked)")
            }
            let app = fields["app"], url = fields["url"]
            if let app, !(app.count <= 155 && app.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" })) { return refuse("not a bundle id") }
            if let url, !(url.hasPrefix("https://") || url.hasPrefix("http://")) || url.count > 2000 { return refuse("not an http(s) address") }
            guard (app == nil) != (url == nil) else { return refuse("give app or url") }
            if let why = world.devHost(app: app, url: url) { return refuse(why) }
            return say("dev hook: host \(app.map { "app \($0)" } ?? "url (\(url?.count ?? 0) characters)") \(asked)")
        }
    }

    @discardableResult private func say(_ line: String) -> String {
        lines.append(line)
        if lines.count > Self.retainedLineLimit { lines.removeFirst(lines.count - Self.retainedLineLimit) }
        Diagnostics.note(line)
        return line
    }

    // A notification's fields: userInfo's strings, then a JSON string object's (the extension's way).
    nonisolated static func fields(object: Any?, userInfo: [AnyHashable: Any]?) -> [String: String] {
        var out: [String: String] = [:]
        func take(_ k: AnyHashable, _ v: Any) {
            guard let key = k as? String, key.count <= 16 else { return }
            if let s = v as? String, s.count <= 64 { out[key] = s } else if let n = v as? NSNumber { out[key] = n.stringValue }
        }
        if let text = object as? String, text.count <= 1024, let data = text.data(using: .utf8),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            for (k, v) in json { take(k, v) }
        }
        for (k, v) in userInfo ?? [:] { take(k, v) }
        return out
    }

    // The observer: on the main thread (the run loop it was added on).
    private final class Receiver: NSObject {
        let fire: (String, [String: String]) -> Void
        init(_ fire: @escaping (String, [String: String]) -> Void) { self.fire = fire }
        @objc nonisolated func heard(_ note: Notification) {
            let name = note.name.rawValue
            let fields = DevHooks.fields(object: note.object, userInfo: note.userInfo)
            MainActor.assumeIsolated { fire(name, fields) }
        }
    }
}

// DEV-HOOK: the shell's side.
extension Shell: DevHookWorld {
    func devForgetTestItems(also apps: [String]) -> String? {
        guard let library else { return "no library" }
        let bundles = Set(["test.margin.pane"] + apps)
        let test: (JSONObject) -> Bool = { v in
            let target = v["target"] as? JSONObject
            if let b = target?["bundleId"] as? String, bundles.contains(b) { return true }
            guard let url = v["url"] as? String, let host = URL(string: url)?.host else { return false }
            return host == "example.com" || host == "example.org"
        }
        let ids = library.items().filter { test($0.value) }.map(\.id)
        for id in ids { library.perform("removeItem", ["tabId": id]) }
        Diagnostics.note("dev hook: \(ids.count) test item(s) removed from the library")
        return nil
    }

    func devHost(app: String?, url: String?) -> String? {
        if let app {
            guard let openApp else { return "no host" }
            openApp(app)
            return nil
        }
        guard let url, let front = marginWindows?.front else { return "no Margin window" }
        front.ask("newTab", ["url": url])
        return nil
    }

    func devKey(_ name: String) -> String? {
        guard let windows = marginWindows, let w = hosted?.hostingWindow.flatMap({ id in windows.controllers.first { $0.id == id } }) ?? windows.front else { return "no Margin window" }
        if name == "palette" { run(.palette) } else { w.push(#"{"type":"pressOutside"}"#) }
        return nil
    }

    func devSidebar(width: Int) -> String? {
        guard let w = marginWindows?.front else { return "no Margin window" }
        return w.devResize(to: width)
    }

    func devFront() -> String { marginWindows?.front?.devFront ?? "no Margin window" }

    func devPicture(watch seconds: Double?, done: @escaping (String) -> Void) {
        guard let w = marginWindows?.front else { return done("no Margin window") }
        guard let seconds else { return done(w.devPicture()?.text ?? "no picture of the window") }
        // Every 50 ms for that long: per page state, how many pictures, and the fewest and most painted points of the page area.
        var seen: [String: (count: Int, least: Int, most: Int)] = [:]
        var order: [String] = []
        let started = Date()
        func sample() {
            if let p = w.devPicture() {
                let state = w.pageState.rawValue
                if seen[state] == nil { order.append(state) }
                let was = seen[state] ?? (0, p.painted, p.painted)
                seen[state] = (was.count + 1, min(was.least, p.painted), max(was.most, p.painted))
            }
            guard Date().timeIntervalSince(started) < seconds else {
                return done("watched \(String(format: "%.1f", seconds)) s: " + (order.isEmpty ? "no picture" : order.map { s in "\(s) \(seen[s]!.count) pictures, painted \(seen[s]!.least) to \(seen[s]!.most) of 81" }.joined(separator: "; ")) + "; last \(w.pageState.rawValue)")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { sample() }
        }
        sample()
    }
}

// DEV-HOOK: the window's side.
extension MarginWindowController {
    // The sidebar's width set as a drag of its edge that ends there: begun (the session holds the page area's changes),
    // the theme's own width setting changed, and over once the page has said its layout at that width (0.6 s at most).
    func devResize(to width: Int) -> String? {
        guard let state = owner?.source.snapshot(), let theme = (state["settings"] as? JSONObject)?["theme"] as? String ?? Optional("arcadia") else { return "no theme" }
        let before = layout?.left
        owner?.onSidebarResizing?(self, true)
        ask("updateThemeSettings", ["themeId": theme, "patch": ["sidebarWidth": width]])
        let started = Date()
        func finish() {
            if layout?.left == before, Date().timeIntervalSince(started) < 0.6 { return DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { finish() } }
            self.owner?.onSidebarResizing?(self, false)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { finish() }
        return nil
    }

    // The window server's picture of this window (its own process's: no permission needed), as alpha only: how many of
    // 81 points across the page area are painted (alpha over 128), the least and most alpha there, and the sidebar's.
    func devPicture() -> (painted: Int, text: String)? {
        typealias Create = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        guard let page = window.pageRect, let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage"),
              let image = unsafeBitCast(symbol, to: Create.self)(.null, 8, UInt32(window.windowNumber), 1 | 16)?.takeRetainedValue(), image.width > 0, image.height > 0,
              let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let data = ctx.data else { return nil }
        ctx.clear(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let content = contentFrame
        let sx = CGFloat(image.width) / max(1, content.width), sy = CGFloat(image.height) / max(1, content.height)
        func alpha(_ p: CGPoint) -> Int {
            let x = min(image.width - 1, max(0, Int((p.x - content.minX) * sx))), y = min(image.height - 1, max(0, Int((p.y - content.minY) * sy)))
            return Int(bytes[(y * image.width + x) * 4 + 3])
        }
        var painted = 0, least = 255, most = 0
        for i in 1...9 { for j in 1...9 {
            let a = alpha(CGPoint(x: page.minX + page.width * CGFloat(i) / 10, y: page.minY + page.height * CGFloat(j) / 10))
            if a > 128 { painted += 1 }
            least = min(least, a); most = max(most, a)
        } }
        let side = alpha(CGPoint(x: content.minX + max(4, (page.minX - content.minX) / 2), y: page.midY))
        return (painted, "page \(pageState.rawValue), page area painted \(painted) of 81 (alpha \(least) to \(most)), sidebar alpha \(side), picture \(image.width)x\(image.height)")
    }

    // How it's in front, the page card and the hole (numbers only).
    var devFront: String {
        func r(_ c: CGRect?) -> String { c.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" } ?? "none" }
        return "mechanism \(mechanism.rawValue), level \(window.level.rawValue) (server \(serverLevel(window.windowNumber).map(String.init) ?? "?")), window \(window.windowNumber), page \(pageState.rawValue), hole \(r(hole)), "
            + "page area \(r(window.pageRect)), hosted \(hosted.map(String.init) ?? "none"), ignoring \(window.ignoresMouseEvents), keys \(pageWantsKeyboard), full screen \(isFullScreen), presses \(window.presses)"
    }
}
