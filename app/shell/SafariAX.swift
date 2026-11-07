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
// windows. That scan is done when a window the window server lists isn't known yet, at most every 0.5 s; known
// windows' titles are read again on each refresh (a page's title becomes the window's).
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
    private var busy = false

    /// Reads Safari's windows (`pid`) and calls `done` on the main thread with every window found, the ones in
    /// `wanted` (window numbers the window server lists) scanned for when they aren't known. One read at a time:
    /// a refresh asked while one runs is dropped (the caller asks again on its next read).
    func refresh(pid: pid_t, wanted: Set<Int>, done: @escaping @MainActor ([Int: Window]) -> Void) {
        guard Self.trusted else { return }
        queue.async { [self] in
            guard !busy else { return }
            busy = true
            defer { busy = false }
            if pid != elementsPid { elements = [:]; elementsPid = pid; scannedAt = -.infinity }
            let app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, 0.25)
            // The active Space's windows: cheap, and what's in front now.
            var list: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &list) == .success, let windows = list as? [AXUIElement] {
                for w in windows { if let n = Self.number(of: w) { elements[n] = w } }
            }
            // Windows on other Spaces: scanned for when one the window server lists isn't known.
            let now = Date().timeIntervalSince1970
            if !wanted.subtracting(elements.keys).isEmpty, now - scannedAt >= 0.5 {
                scannedAt = now
                for (n, w) in Self.scan(pid: pid) where elements[n] == nil { elements[n] = w }
            }
            var found: [Int: Window] = [:]
            for (n, w) in elements {
                var title: CFTypeRef?
                guard AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &title) == .success else {
                    if !wanted.contains(n) { elements[n] = nil } // gone
                    continue
                }
                var full: CFTypeRef?
                AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &full)
                found[n] = Window(number: n, title: (title as? String) ?? "", fullScreen: (full as? Bool) ?? false)
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { done(found) } }
        }
    }

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
