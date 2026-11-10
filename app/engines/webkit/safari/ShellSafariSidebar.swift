// Safari's own sidebar, kept closed under Margin (asked 2026-11-07: "when i reach my cursor on the left edge, it still
// opens … can we not have it open please"). Three parts, all Margin.app's, all only where Margin's layout is drawn over
// the Safari window in front:
//
// - The edge stop (EdgeStop.swift): AppKit reveals a collapsed sidebar of a full-screen window when a mouse-moved event
//   lands in the 4 pt inside its leading edge and rests 0.5 s (NSSplitViewController(RevealOnEdgeHover), watched with
//   local and global event monitors: an invisible window over the edge never stopped it). Margin keeps the pointer
//   5 pt from the edge of a full-screen Safari window with Margin's layout in front, so it never opens there.
// - ⇧⌘L, Safari's own sidebar key, is Margin's sidebar key there (Shortcuts.swift `ShortcutSet.bindings`).
// - Opened anyway (View › Show Sidebar, the sidebar button in Safari's toolbar): Margin presses View › Hide Sidebar by
//   Accessibility at once, and covers it meanwhile (the overlay keeps the whole window, as over the page).
//
// Telling Safari's sidebar from Safari's other parts on the left (a Web Inspector docked there): the page's visible
// area starts further right either way, so the menu item decides. Its title, learned while no part shows on the left,
// flips while Safari's sidebar is open ("Show Sidebar" → "Hide Sidebar", in any language); a part on the left with the
// title unchanged is something else, and is left alone (carved out, as before).

import AppKit

// Safari's View › Show Sidebar item (SafariAX; a test's stand-in).
protocol SidebarMenu: AnyObject {
    func title(pid: pid_t, done: @escaping @MainActor (String?) -> Void)
    func press(pid: pid_t, done: @escaping @MainActor (Bool) -> Void)
}

extension SafariAX: SidebarMenu {
    func title(pid: pid_t, done: @escaping @MainActor (String?) -> Void) { sidebarMenuTitle(pid: pid, done: done) }
    func press(pid: pid_t, done: @escaping @MainActor (Bool) -> Void) { pressSidebarMenu(pid: pid, done: done) }
}

// One window's part on the left, once it's appeared: being checked, Safari's sidebar being closed, or not Safari's sidebar
// (or its close didn't go through: not pressed again until the part goes).
enum SafariSidebarState: Equatable { case checking, closing, left }

enum SafariSidebar {
    /// Whether the menu item's title says Safari's sidebar is open: it isn't its title while the sidebar was closed.
    static func isOpen(title: String?, closedTitle: String?) -> Bool {
        guard let title, let closedTitle, !title.isEmpty else { return false }
        return title != closedTitle
    }
    /// How often the item's title is learned again while nothing shows on the left (a language change, Safari updated).
    static let learnEvery: TimeInterval = 10
}

extension Shell {
    var sidebarMenu: SidebarMenu? { options.sidebarMenu ?? (options.safariAX ? safariAX : nil) }

    /// Whether the overlay keeps the whole window over a part on the left: Safari's sidebar being checked or closed.
    func coversSafariSidebar(_ key: WindowKey) -> Bool { safariSidebar[key] == .checking || safariSidebar[key] == .closing }

    // On each read of a shown overlay's window (`left`: where its page's visible area starts, from the window's left).
    func followSafariSidebar(_ overlay: OverlayController, left: CGFloat, front: Bool) {
        let key = overlay.key
        guard key.link.hasPrefix("safari:"), let menu = sidebarMenu, overlay.browserPid > 0 else { return }
        let pid = overlay.browserPid
        guard left > Shell.edgeSnap else {
            safariSidebar[key] = nil
            // Nothing on the left of the window in front: the item's title as it reads while the sidebar is closed.
            if front, Diagnostics.now() - (sidebarTitleReadAt[pid] ?? -.infinity) >= SafariSidebar.learnEvery {
                sidebarTitleReadAt[pid] = Diagnostics.now()
                menu.title(pid: pid) { [weak self] title in
                    guard let self, let title, !title.isEmpty else { return }
                    self.sidebarClosedTitle[pid] = title
                }
            }
            return
        }
        // A part on the left, once per appearance, of the window in front (the menu is the front window's).
        guard front, safariSidebar[key] == nil, sidebarClosedTitle[pid] != nil else { return }
        safariSidebar[key] = .checking
        menu.title(pid: pid) { [weak self] title in
            guard let self, self.safariSidebar[key] == .checking else { return }
            guard SafariSidebar.isOpen(title: title, closedTitle: self.sidebarClosedTitle[pid]) else {
                self.safariSidebar[key] = .left
                Diagnostics.note("\(key): a part on the left (\(Int(left)) pt) that isn't Safari's sidebar (the Web Inspector?): left as it is")
                self.burst("not Safari's sidebar")
                return
            }
            self.safariSidebar[key] = .closing
            menu.press(pid: pid) { [weak self] pressed in
                guard let self else { return }
                Diagnostics.note("\(key): Safari's sidebar opened (\(Int(left)) pt): \(pressed ? "closed by its View menu, covered meanwhile" : "couldn't be closed (its menu item didn't press)")")
                if !pressed { self.safariSidebar[key] = .left }
                self.burst("Safari's sidebar closed")
            }
        }
    }
}
