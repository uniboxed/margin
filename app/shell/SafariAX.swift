// Which Safari window is which profile's, through Accessibility (Tirth, 2026-11-07: "let's use accessibility
// then … i should never see safari's ui at all"). Without it the window server can't say: every Safari window is
// the same process's, full-screen windows have the same bounds, and their titles are kept from apps without
// Screen Recording (tested 2026-11-06: CGWindowList and SLSCopyWindowProperty both redact them; window-server
// events never carry a title change; SafariTabs.db has no window numbers).
//
// With the permission, each Safari window's number in the window server (`_AXUIElementGetWindow`) and its title:
// a named profile's window is titled "<profile> — <page>", the default profile's has no prefix. WindowBinder
// takes "this number is that profile's" as exact (WindowBinder.update `exact`).
//
// Windows on other Spaces aren't in Safari's AXWindows list (only the active Space's are), so they're found the
// way window switchers find them: an AXUIElement for Safari's pid and each element id in turn
// (`_AXUIElementCreateWithRemoteToken`, a 20-byte token: pid, 0, "coco", the id), keeping those that are
// windows. That scan is the fragile part, so it's kept for what nothing else finds: with Safari's Accessibility
// events heard (`watch`), it's done once when Safari is first read (windows already open on other Spaces), then
// only for a window the window server lists that's still unknown 2 s later, at most every 5 s (`shouldScan`).
// Without the events (not given yet), as before: whenever a listed window isn't known, at most every 0.5 s.
//
// The events (public Accessibility, an AXObserver on Safari's pid, heard on a thread of its own): a window
// created, focused, moved, resized (full screen in or out), retitled while it had no title, closed. Each one gives
// the window's element at once (a new window on another Space needs no scan) and is passed to the shell, which
// reads the window server then instead of at its next poll. The poll stays, as the safety net for a missed event.
//
// Every call is made on one queue, never the main thread: Safari answers on its own main thread, which a page's
// layout can keep busy. Titles stay in memory, are compared and dropped: never logged, never written.
// Refuses under MARGIN_APP_TESTS (no test reads the real Safari).

import AppKit
import ApplicationServices

@_silgen_name("_AXUIElementGetWindow") private func axWindowNumber(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError
@_silgen_name("_AXUIElementCreateWithRemoteToken") private func axCreateWithRemoteToken(_ token: CFData) -> Unmanaged<AXUIElement>?

final class SafariAX: @unchecked Sendable {
    struct Window: Equatable { let number: Int; let title: String; let fullScreen: Bool }
    /// What Safari's Accessibility events say, on the main thread: a window seen (new, focused, moved, resized,
    /// titled), a window closed, or whether the events are heard at all (after `watch`).
    enum Event: Equatable { case window(Window), gone(Int), watching(Bool) }

    /// Whether to scan for other Spaces' windows now (see the top). `unknownSince`: since when a window the window
    /// server lists has been unknown (nil: none is); `scans`: scans made for this Safari; `watching`: events heard.
    nonisolated static func shouldScan(now: Double, unknownSince: Double?, scannedAt: Double, scans: Int, watching: Bool) -> Bool {
        guard let since = unknownSince else { return false }
        if !watching || scans == 0 { return now - scannedAt >= 0.5 }
        return now - since >= 2 && now - scannedAt >= 5
    }

    static var trusted: Bool { !PrivateCalls.inTests && AXIsProcessTrusted() }

    /// Asks macOS to show its Accessibility prompt (once per launch; the person grants it in System Settings).
    static func askOnce() {
        guard !PrivateCalls.inTests, !asked, !AXIsProcessTrusted() else { return }
        asked = true
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    nonisolated(unsafe) private static var asked = false

    private let queue = DispatchQueue(label: "margin.ax", qos: .userInitiated)
    // On the queue only.
    private var elements: [Int: AXUIElement] = [:] // window number → its element
    private var elementsPid: pid_t = 0
    private var scannedAt: Double = -.infinity
    private var scans = 0
    private var unknownSince: Double?
    private var busy = false
    // The events (on the queue): the observer for `elementsPid`, the windows each has notifications for, the
    // windows read without a title (their title change is passed on, once), where events go, the last try.
    private var observer: AXObserver?
    private var watched: Set<Int> = []
    private var untitled: Set<Int> = []
    private var onEvent: (@Sendable (Event) -> Void)? // posts to the main thread
    private var watchTriedAt: Double = -.infinity
    private var watchPid: pid_t = 0

    /// Reads Safari's windows (`pid`) and calls `done` on the main thread with every window found, the ones in
    /// `wanted` (window numbers the window server lists) scanned for when they aren't known. One read at a time:
    /// a refresh asked while one runs is dropped (the caller asks again on its next read).
    func refresh(pid: pid_t, wanted: Set<Int>, done: @escaping @MainActor ([Int: Window]) -> Void) {
        guard Self.trusted else { return }
        queue.async { [self] in
            guard !busy else { return }
            busy = true
            defer { busy = false }
            if pid != elementsPid { forget(pid) }
            let app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, 0.25)
            // The active Space's windows: cheap, and what's in front now.
            var list: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &list) == .success, let windows = list as? [AXUIElement] {
                for w in windows { if let n = Self.number(of: w) { elements[n] = w; watchWindow(n, w) } }
            }
            // Windows on other Spaces: scanned for when one the window server lists isn't known (shouldScan).
            let now = Date().timeIntervalSince1970
            if wanted.subtracting(elements.keys).isEmpty { unknownSince = nil } else { unknownSince = unknownSince ?? now }
            if Self.shouldScan(now: now, unknownSince: unknownSince, scannedAt: scannedAt, scans: scans, watching: observer != nil) {
                scannedAt = now
                scans += 1
                for (n, w) in Self.scan(pid: pid) where elements[n] == nil { elements[n] = w; watchWindow(n, w) }
                if wanted.subtracting(elements.keys).isEmpty { unknownSince = nil }
            }
            var found: [Int: Window] = [:]
            for (n, w) in elements {
                var title: CFTypeRef?
                guard AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &title) == .success else {
                    if !wanted.contains(n) { elements[n] = nil; watched.remove(n) } // gone
                    continue
                }
                found[n] = read(n, w, title: title as? String)
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { done(found) } }
        }
    }

    // On the queue: a window's title and full screen, read (the title remembered as missing, for its change).
    private func read(_ n: Int, _ w: AXUIElement, title known: String?? = nil) -> Window {
        let title: String
        if let known { title = known ?? "" } else {
            var t: CFTypeRef?
            AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
            title = (t as? String) ?? ""
        }
        if title.isEmpty { untitled.insert(n) } else { untitled.remove(n) }
        var full: CFTypeRef?
        AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &full)
        return Window(number: n, title: title, fullScreen: (full as? Bool) ?? false)
    }

    // On the queue: another Safari (relaunched) starts from nothing.
    private func forget(_ pid: pid_t) {
        elements = [:]; elementsPid = pid; scannedAt = -.infinity; scans = 0; unknownSince = nil
        watched = []; untitled = []
    }

    /// Safari's Accessibility events heard for `pid`, passed to `onEvent` on the main thread (see the top). Asked
    /// on each read: once heard for that pid it's kept; a try that failed (Safari still opening) is made again
    /// after 1 s.
    func watch(pid: pid_t, onEvent: @escaping @MainActor @Sendable (Event) -> Void) {
        guard Self.trusted else { return }
        let post: @Sendable (Event) -> Void = { e in DispatchQueue.main.async { MainActor.assumeIsolated { onEvent(e) } } }
        queue.async { [self] in
            self.onEvent = post
            if pid != elementsPid { forget(pid) }
            let now = Date().timeIntervalSince1970
            guard observer == nil || watchPid != pid, now - watchTriedAt >= 1 else { return }
            watchTriedAt = now
            if let old = observer { CFRunLoopRemoveSource(Self.loop.run, AXObserverGetRunLoopSource(old), .defaultMode) }
            observer = nil
            watched = []
            watchPid = pid
            var made: AXObserver?
            let heard = AXObserverCreate(pid, { _, element, name, refcon in
                guard let refcon else { return }
                Unmanaged<SafariAX>.fromOpaque(refcon).takeUnretainedValue().heard(element, name as String)
            }, &made)
            guard heard == .success, let o = made else { return say(.watching(false)) }
            let app = AXUIElementCreateApplication(pid)
            let me = Unmanaged.passUnretained(self).toOpaque()
            let on = [kAXWindowCreatedNotification, kAXFocusedWindowChangedNotification].map {
                AXObserverAddNotification(o, app, $0 as CFString, me)
            }
            guard on.allSatisfy({ $0 == .success || $0 == .notificationAlreadyRegistered }) else { return say(.watching(false)) }
            CFRunLoopAddSource(Self.loop.run, AXObserverGetRunLoopSource(o), .defaultMode)
            observer = o
            for (n, w) in elements { watchWindow(n, w) }
            say(.watching(true))
        }
    }

    // On the queue: a window's own events (closed, moved, resized, retitled), once.
    private func watchWindow(_ n: Int, _ w: AXUIElement) {
        guard let o = observer, !watched.contains(n) else { return }
        let me = Unmanaged.passUnretained(self).toOpaque()
        for name in [kAXUIElementDestroyedNotification, kAXMovedNotification, kAXResizedNotification, kAXTitleChangedNotification] {
            _ = AXObserverAddNotification(o, w, name as CFString, me)
        }
        watched.insert(n)
    }

    // On the events' thread: handled on the queue.
    nonisolated private func heard(_ heardElement: AXUIElement, _ name: String) {
        nonisolated(unsafe) let element = heardElement // (CF objects are thread-safe; Accessibility's aren't marked Sendable)
        queue.async { [self] in
            if name == kAXUIElementDestroyedNotification {
                guard let n = elements.first(where: { CFEqual($0.value, element) })?.key else { return }
                elements[n] = nil
                watched.remove(n)
                untitled.remove(n)
                return say(.gone(n))
            }
            guard let n = Self.number(of: element) else { return }
            // A page's title change says nothing new, unless the window had no title (its profile wasn't known).
            if name == kAXTitleChangedNotification, !untitled.contains(n) { return }
            elements[n] = element
            watchWindow(n, element)
            say(.window(read(n, element)))
        }
    }

    // On the queue: an event passed to the main thread.
    private func say(_ e: Event) {
        onEvent?(e)
    }

    // The thread the events are heard on: a run loop of its own (never the main thread, never the queue).
    private final class Loop: @unchecked Sendable {
        var run: CFRunLoop!
        init() {
            let ready = DispatchSemaphore(value: 0)
            let thread = Thread { [self] in
                run = CFRunLoopGetCurrent()
                // (A run loop with nothing in it returns at once: a timer that never fires keeps it.)
                let keep = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 1e9, 1e9, 0, 0) { _ in }
                CFRunLoopAddTimer(run, keep, .defaultMode)
                ready.signal()
                CFRunLoopRun()
            }
            thread.name = "margin.ax.events"
            thread.qualityOfService = .userInitiated
            thread.start()
            ready.wait()
        }
    }
    nonisolated private static let loop = Loop()

    private static func number(of element: AXUIElement) -> Int? {
        var id: CGWindowID = 0
        guard axWindowNumber(element, &id) == .success, id != 0 else { return nil }
        return Int(id)
    }

    // Every window element of `pid`'s, by element id (a window switcher's way to reach other Spaces' windows).
    private static func scan(pid: pid_t) -> [Int: AXUIElement] {
        var out: [Int: AXUIElement] = [:]
        var token = Data(count: 20)
        token.replaceSubrange(0..<4, with: withUnsafeBytes(of: pid) { Data($0) })
        token.replaceSubrange(8..<12, with: withUnsafeBytes(of: UInt32(0x636f_636f)) { Data($0) })
        let deadline = Date().addingTimeInterval(1.0) // a busy Safari (restoring its windows) answers slowly: never more than 1 s
        for id in UInt64(0)..<2000 where Date() < deadline {
            token.replaceSubrange(12..<20, with: withUnsafeBytes(of: id) { Data($0) })
            guard let element = axCreateWithRemoteToken(token as CFData)?.takeRetainedValue() else { continue }
            AXUIElementSetMessagingTimeout(element, 0.05)
            var role: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success, (role as? String) == kAXWindowRole else { continue }
            if let n = number(of: element) { out[n] = element }
        }
        return out
    }

    /// Safari's File › New Window › "New <name> Window" pressed (the menu Safari has for each profile), on the
    /// Accessibility queue. `done(true)` on the main thread once pressed; false if the item isn't there.
    func newWindow(pid: pid_t, profileName: String, done: @escaping @MainActor (Bool) -> Void) {
        guard Self.trusted else { DispatchQueue.main.async { MainActor.assumeIsolated { done(false) } }; return }
        queue.async {
            func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil }
            func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
            func title(_ e: AXUIElement) -> String { (attr(e, kAXTitleAttribute) as? String) ?? "" }
            let app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, 1)
            var pressed = false
            if let bar = attr(app, kAXMenuBarAttribute) {
                // (The menu's names are English in an English Safari; the File menu is the second in any language.)
                let menus = kids(bar as! AXUIElement)
                let file = menus.first { title($0) == "File" } ?? (menus.count > 1 ? menus[1] : nil)
                let items = file.map { kids($0).flatMap(kids) } ?? []
                let want = "New \(profileName) Window"
                let sub = items.flatMap { kids($0).flatMap(kids) }
                if let item = (sub + items).first(where: { title($0) == want }) {
                    pressed = AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
                }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { done(pressed) } }
        }
    }

    /// A window Margin opened itself (newWindow) closed again by its close button, on the Accessibility queue.
    func closeWindow(pid: pid_t, number: Int) {
        guard Self.trusted else { return }
        queue.async { [self] in
            if pid != elementsPid { return }
            guard let w = elements[number] else { return }
            var button: CFTypeRef?
            guard AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &button) == .success, let b = button else { return }
            _ = AXUIElementPerformAction(b as! AXUIElement, kAXPressAction as CFString)
        }
    }

    /// Whether Margin's extension is turned on in a Safari profile, as Safari's own settings say (needs Full Disk
    /// Access): `profile` the copy's id ("s-default" or "s-" and the profile's identifier). Nil: not readable.
    static func marginEnabled(profile: String) -> Bool? {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library/Safari")
        func entries(_ url: URL) -> [String: Any]? {
            guard let data = try? Data(contentsOf: url) else { return nil }
            return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
        }
        func enabled(_ list: [String: Any], matching: (([String: Any]) -> Bool)?) -> Bool? {
            let margin = list.filter { $0.key.hasPrefix("io.tirth.margin.Extension (") }.compactMap { k, v -> (String, [String: Any])? in (v as? [String: Any]).map { (k, $0) } }
            let signed = margin.filter { !$0.0.contains("(UNSIGNED)") }
            let pick = (signed.isEmpty ? margin : signed).filter { matching?($0.1) ?? true }
            guard !pick.isEmpty else { return nil }
            return pick.contains { $0.1["Enabled"] as? Bool == true }
        }
        if profile == "s-default" {
            return entries(root.appendingPathComponent("WebExtensions/Extensions.plist")).flatMap { enabled($0, matching: nil) }
        }
        let id = profile.hasPrefix("s-") ? String(profile.dropFirst(2)).uppercased() : profile.uppercased()
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("Profiles"), includingPropertiesForKeys: nil)) ?? []
        for d in dirs {
            guard let list = entries(d.appendingPathComponent("WebExtensions/Extensions.plist")),
                  let on = enabled(list, matching: { ($0["ProfileIdentifier"] as? String)?.uppercased() == id }) else { continue }
            return on
        }
        return nil
    }

    /// The profile a window's title names: the named profile whose "<name> — " starts it, else the default
    /// profile's. `names`: profile id (as in a link, "s-…") → its name in Safari; `defaultId`: the default's id.
    static func profile(ofTitle title: String, names: [String: String], defaultId: String?) -> String? {
        let named = names.filter { $0.key != defaultId && !$0.value.isEmpty }
        if let hit = named.sorted(by: { $0.value.count > $1.value.count }).first(where: { title.hasPrefix($0.value + " — ") || title == $0.value }) {
            return hit.key
        }
        return defaultId
    }
}

/// What Accessibility has said of Safari's windows, on the main thread: the profile (link) each one's title named,
/// once known (a window's profile never changes), and whether each is full screen (as last read). From reads
/// (`SafariAX.refresh`) and events (`SafariAX.watch`) alike.
struct AXKnown {
    private(set) var profiles: [Int: String] = [:]
    private(set) var fullScreen: [Int: Bool] = [:]

    /// Windows read: full screen kept for each; a profile named for each not known yet, with a title, when Safari's
    /// profile names are known (without them, every title would read as the default profile's). The windows whose
    /// profile was learned now, in order.
    mutating func learn(_ found: [Int: SafariAX.Window], names: [String: String]) -> [Int] {
        var learned: [Int] = []
        for (n, w) in found {
            fullScreen[n] = w.fullScreen
            guard !names.isEmpty, profiles[n] == nil, !w.title.isEmpty,
                  let id = SafariAX.profile(ofTitle: w.title, names: names, defaultId: "s-default") else { continue }
            profiles[n] = "safari:" + id
            learned.append(n)
        }
        return learned.sorted()
    }

    /// A window closed.
    mutating func gone(_ n: Int) { profiles[n] = nil; fullScreen[n] = nil }

    /// Only the windows the window server still lists.
    mutating func keep(listed: Set<Int>) {
        profiles = profiles.filter { listed.contains($0.key) }
        fullScreen = fullScreen.filter { listed.contains($0.key) }
    }
}
