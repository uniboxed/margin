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
//   drag of its edge that ends there (begun, the theme's width set, over); `host { drag: "<dx>,<frames>" }`: a real
//   drag of the front window's sidebar edge by its page's own handle (pointer events dispatched in the page as WebKit
//   hands a person's drag: down, one move a display frame for `frames` frames to `dx` points, up; no event is posted
//   to the system), one line once it's let go (`dragged N frames in M ms`); `host { say: front }`: one line with how
//   the front window is kept in front, the page card's state and its hole (numbers only), and what it would show by
//   itself at the next launch (`last`: an app's bundle id, `web`, or `none`); `host { say: picture }`: how
//   much of the page area is painted in the window server's picture of Margin's own window (its own process's window:
//   no permission; alpha only, no pixel leaves the app), and with `watch: <seconds>` the same every 50 ms for that
//   long, summed up by page state in one line at the end. For Margin's UI that never makes the hosted app inactive
//   (2026-11-17): `host { say: field }`: whether a field of Margin's page has the focus and how many characters it
//   holds (its length only, never its text); `host { say: spot }`: a point of the front window's sidebar where a
//   press does nothing (no row, button, field, handle or drag region under it), in the window server's coordinates.
// - Each notification is one log line, honoured or refused: the kind, ids and the sender's pid (as it says it). The
//   address itself is never logged.

import AppKit
import CoreFoundation
import WebKit

// DEV-HOOK: what the hook needs from the shell (Shell, below; the tests' fake).
protocol DevHookWorld: AnyObject {
    // What a palette pick does, an installed app by bundle id or an address in a new web item, in Margin's front
    // window. Nil if asked, else why not.
    func devHost(app: String?, url: String?) -> String?
    func devForgetTestItems(also apps: [String]) -> String? // nil if done, else why not (`apps`: app items a check added)
    // Margin's palette key (`palette`) or a press outside its field (`close`), in the window hosting; nil if done.
    func devKey(_ name: String) -> String?
    func devSidebar(width: Int) -> String? // the front window's sidebar that wide, as a drag that ends there; nil if begun
    func devDrag(dx: Int, frames: Int, done: @escaping (String) -> Void) -> String? // a drag of its handle in the page; nil if begun
    func devFront() -> String // how the front window is in front, its page card and its hole, in one line
    func devPicture(watch seconds: Double?, done: @escaping (String) -> Void) // the page area in Margin's own window's picture
    func devPage(_ what: String, done: @escaping (String) -> Void) // `field` or `spot` of the front window's page, in one line
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
            if let drag = fields["drag"] {
                let parts = drag.split(separator: ",").compactMap { Int($0) }
                guard parts.count == 2, (-400...400).contains(parts[0]), (1...600).contains(parts[1]) else { return refuse("not a drag (dx,frames)") }
                if let why = world.devDrag(dx: parts[0], frames: parts[1], done: { [weak self] line in self?.say("dev hook: drag: \(line) \(asked)") }) { return refuse(why) }
                return say("dev hook: host drag \(parts[0]),\(parts[1]) \(asked)")
            }
            if fields["say"] == "front" { return say("dev hook: front: \(world.devFront()) \(asked)") }
            if let what = fields["say"], what == "field" || what == "spot" || what == "animations" {
                world.devPage(what) { [weak self] line in self?.say("dev hook: \(what): \(line) \(asked)") }
                return say("dev hook: host say \(what) \(asked)")
            }
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

    func devDrag(dx: Int, frames: Int, done: @escaping (String) -> Void) -> String? {
        guard let w = marginWindows?.front else { return "no Margin window" }
        w.devDrag(dx: dx, frames: frames, done: done)
        return nil
    }

    // (`engine`: what the host engine reads of the one shown at this moment, HostEngine.readShown: Spaces, on screen or
    // not, how many polls have read. `last`: what the window would show by itself at Margin's next launch,
    // HostedSession.resumeLast: an app's bundle id, `web` for a page, never its address or title; `none`: the launcher.)
    func devFront() -> String {
        guard let w = marginWindows?.front else { return "no Margin window" }
        var last = "none"
        if let item = hosted?.lastItem(ofWindow: w.id) {
            if case .app(let bundle, _) = item.target { last = "app:\(bundle)" } else { last = "web" }
        }
        return w.devFront + (host.map { "; engine: \($0.readShown())" } ?? "") + ", last \(last)"
    }

    // The page's own answer (one script): its focused field's length only; a sidebar point no control is under.
    func devPage(_ what: String, done: @escaping (String) -> Void) {
        guard let w = marginWindows?.front else { return done("no Margin window") }
        // (animations: what the page keeps redrawing for: its running animations and transitions, where, whether they
        // can be seen; and its own requestAnimationFrame calls counted for a second. The idle-cost part's diagnosis.)
        let script = what == "animations" ? """
            const shown = (t) => { if (!t) return '?'; const c = getComputedStyle(t); let hidden = c.visibility !== 'visible' || +c.opacity === 0; for (let p = t.parentElement; p && !hidden; p = p.parentElement) { const s = getComputedStyle(p); hidden = +s.opacity === 0 || s.visibility !== 'visible'; } return hidden ? 'not seen' : 'seen'; };
            const name = (t) => !t ? '?' : t.tagName.toLowerCase() + (typeof t.className === 'string' && t.className.trim() ? '.' + t.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + [...t.attributes].filter((a) => a.name.startsWith('m-')).slice(0, 2).map((a) => '[' + a.name + ']').join('');
            const list = document.getAnimations().map((a) => (a.animationName || a.transitionProperty || 'script') + ' on ' + name(a.effect && a.effect.target) + ' (' + shown(a.effect && a.effect.target) + ')');
            let frames = 0; const raf = window.requestAnimationFrame;
            window.requestAnimationFrame = function (f) { frames++; return raf.call(window, f); };
            const got = {}; const app = window.marginApp; const receive = app && app.receive;
            if (receive) app.receive = function (m) { const t = (m && m.type) || '?'; got[t] = (got[t] || 0) + 1; return receive.apply(this, arguments); };
            let mutations = 0; const watch = new MutationObserver((l) => { mutations += l.length; }); watch.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
            await new Promise((r) => setTimeout(r, 2000));
            watch.disconnect();
            window.requestAnimationFrame = raf;
            if (receive) app.receive = receive;
            return list.length + ' running: ' + list.slice(0, 14).join('; ') + '; in 2 s the page asked ' + frames + ' frames, got ' + JSON.stringify(got) + ' from Margin, ' + mutations + ' DOM changes';
            """ : what == "field" ? """
            const a = document.activeElement, field = !!a && (a.matches('input, textarea') || a.isContentEditable);
            return 'focused ' + field + ', length ' + (field ? String((a.value ?? a.textContent ?? '').length) : '-1') + ', palette ' + (!!document.querySelector('[m-input="palette"]'));
            """ : """
            const page = document.querySelector('m-page')?.getBoundingClientRect();
            if (!page || page.left < 40) return 'none';
            const busy = 'a, button, input, textarea, select, [contenteditable], [m-action], [m-input], [m-drag], [m-resize], [m-drag-region], [m-rename], [m-editor], [m-menu], [m-notice], [m-prompt], [m-window-controls], [draggable="true"], [role="button"], [tabindex]';
            for (const x of [page.left / 2, page.left * 0.3, page.left * 0.7]) {
              for (let y = innerHeight - 90; y > 90; y -= 12) {
                const el = document.elementFromPoint(x, y);
                if (el && !el.closest(busy) && !el.closest('m-page')) return Math.round(x) + ',' + Math.round(y);
              }
            }
            return 'none';
            """
        w.webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            guard case .success(let value) = result, let text = value as? String else { return done("no answer from the page") }
            guard what == "spot" else { return done(text) }
            let parts = text.split(separator: ",").compactMap { Double($0) }
            guard parts.count == 2 else { return done("none") }
            let content = w.contentFrame
            done("at \(Int(content.minX + parts[0])),\(Int(content.minY + parts[1]))")
        }
    }

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

    // A drag of its sidebar's edge by the page's own handle: pointer events dispatched in the page as WebKit hands a
    // person's drag (ui/behaviors/resize.ts hears them as one), one move a display frame (requestAnimationFrame), so
    // the page reports its layout each frame as it would for a person. Nothing is posted to the system.
    func devDrag(dx: Int, frames: Int, done: @escaping (String) -> Void) {
        let script = """
            const h = document.querySelector('[m-resize]');
            if (!h) return 'no handle';
            const r = h.getBoundingClientRect(), x0 = r.left + r.width / 2, y = r.top + r.height / 2;
            const ev = (t, x, b) => h.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, composed: true, button: 0, buttons: b, clientX: x, clientY: y, pointerId: 7, isPrimary: true }));
            const t0 = performance.now();
            ev('pointerdown', x0, 1);
            await new Promise((done) => {
              let i = 0;
              const step = () => { i += 1; ev('pointermove', x0 + dx * i / frames, 1); if (i < frames) requestAnimationFrame(step); else done(); };
              requestAnimationFrame(step);
            });
            ev('pointerup', x0 + dx, 0);
            return 'dragged ' + frames + ' frames in ' + Math.round(performance.now() - t0) + ' ms';
            """
        webView.callAsyncJavaScript(script, arguments: ["dx": dx, "frames": frames], in: nil, in: .page) { result in
            guard case .success(let value) = result, let text = value as? String else { return done("no answer from the page") }
            done(text)
        }
    }

    // The window server's picture of Margin's UI (its panel: its own process's window, no permission needed), as alpha only: how many of
    // 81 points across the page area are painted (alpha over 128), the least and most alpha there, and the sidebar's.
    func devPicture() -> (painted: Int, text: String)? {
        typealias Create = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        guard let page = window.pageRect, let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage"),
              let image = unsafeBitCast(symbol, to: Create.self)(.null, 8, UInt32(panel.windowNumber), 1 | 16)?.takeRetainedValue(), image.width > 0, image.height > 0,
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

    // How it's in front, the page card and the hole (numbers only). `window`: the base (the full-screen one, its Space
    // Margin's); `panel`: Margin's UI over it, the window that takes Margin's presses and, for a field, the keys.
    // `active`: Margin the front app (the workspace's word); `appkit active`: AppKit's, true too after a press in the
    // non-activating panel.
    var devFront: String {
        func r(_ c: CGRect?) -> String { c.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" } ?? "none" }
        return "mechanism \(mechanism.rawValue), level \(window.level.rawValue) (server \(serverLevel(window.windowNumber).map(String.init) ?? "?")), window \(window.windowNumber), page \(pageState.rawValue), hole \(r(hole)), "
            + "page area \(r(window.pageRect)), hosted \(hosted.map(String.init) ?? "none"), ignoring \(panel.ignoresMouseEvents), keys \(pageWantsKeyboard), full screen \(isFullScreen), presses \(panel.presses), "
            + "panel \(panel.windowNumber) (level \(panel.level.rawValue), server \(serverLevel(panel.windowNumber).map(String.init) ?? "?"), key \(panel.isKeyWindow), child \(panel.parent === window)), active \(MarginWindowController.isFrontApp()), appkit active \(NSApp.isActive), allow key \(panel.allowKey), hand-backs \(handBacks.count), activations \(activations.count), keys back \(keysGivenBack)"
    }
}
