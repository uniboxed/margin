// Safari's own sidebar, kept hidden in the windows Margin hosts (with it open, a hosted window doesn't take the page
// area's size: Host.swift HostSidebar). Read and pressed through its View › Show Sidebar item (SafariAX). Its title flips
// while Safari's sidebar is open ("Show Sidebar" → "Hide Sidebar").

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

extension Shell {
    var sidebarMenu: SidebarMenu? { options.sidebarMenu ?? (options.safariAX ? safariAX : nil) }
}
