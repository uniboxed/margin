// Safari's menus through Accessibility (the permission Margin asks for at launch): a profile's new window, pressed
// from File › New Window › "New <name> Window" (ShellProfiles.swift openProfileWindow, for a hosted Safari window of a
// profile whose copy isn't running), and Safari's View › Show Sidebar item, read and pressed (ShellSafariSidebar.swift:
// Safari's sidebar kept hidden in the windows Margin hosts). Every call is made on one queue, never the main thread:
// Safari answers on its own main thread, which a page's layout can keep busy. Titles are compared and dropped: never
// logged, never written. Refuses under MARGIN_APP_TESTS (no test reads the real Safari).

import AppKit
import ApplicationServices

final class SafariAX: @unchecked Sendable {
    static var trusted: Bool { !PrivateCalls.inTests && AXIsProcessTrusted() }

    /// Asks macOS to show its Accessibility prompt (once per launch; the person grants it in System Settings).
    static func askOnce() {
        guard !PrivateCalls.inTests, !asked, !AXIsProcessTrusted() else { return }
        asked = true
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    nonisolated(unsafe) private static var asked = false

    private let queue = DispatchQueue(label: "margin.ax", qos: .userInitiated)

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

    // ---- Safari's own sidebar (ShellSafariSidebar.swift) ----
    // Its View › Show Sidebar item (⇧⌘L), known by its identifier in any language; its title flips while the sidebar
    // is open ("Hide Sidebar"). Read and pressed on the Accessibility queue, the menu never opened: the same as
    // the menu command, nothing shown moving.
    private var sidebarItem: (pid: pid_t, element: AXUIElement)?

    private func sidebarMenuItem(_ pid: pid_t) -> AXUIElement? {
        if let kept = sidebarItem, kept.pid == pid { return kept.element }
        func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        guard let barValue = attr(app, kAXMenuBarAttribute), CFGetTypeID(barValue) == AXUIElementGetTypeID() else { return nil }
        let bar = barValue as! AXUIElement
        for top in (attr(bar, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
            for menu in (attr(top, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
                for item in (attr(menu, kAXChildrenAttribute) as? [AXUIElement]) ?? [] where attr(item, "AXIdentifier") as? String == "ShowSidebar" {
                    sidebarItem = (pid, item)
                    return item
                }
            }
        }
        return nil
    }

    /// The Show Sidebar item's title now (nil: not found, or not trusted).
    func sidebarMenuTitle(pid: pid_t, done: @escaping @MainActor (String?) -> Void) {
        guard Self.trusted else { return done(nil) }
        queue.async { [self] in
            var title: String?
            if let item = sidebarMenuItem(pid) {
                var v: AnyObject?
                if AXUIElementCopyAttributeValue(item, kAXTitleAttribute as CFString, &v) == .success { title = v as? String } else { sidebarItem = nil }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { done(title) } }
        }
    }

    /// The Show Sidebar item pressed (its title now its "Hide Sidebar": Safari's sidebar closes). False: not pressed.
    func pressSidebarMenu(pid: pid_t, done: @escaping @MainActor (Bool) -> Void) {
        guard Self.trusted else { return done(false) }
        queue.async { [self] in
            var pressed = false
            if let item = sidebarMenuItem(pid) {
                pressed = AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
                if !pressed { sidebarItem = nil }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { done(pressed) } }
        }
    }
}
