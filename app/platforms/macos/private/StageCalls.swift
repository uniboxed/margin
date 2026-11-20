// The private calls behind Margin's ownerless Space and its own menu bar there (MarginStage.swift, MarginMenuBar.swift;
// DECISIONS.md "Margin's Space owned by a helper with no Dock icon", 2026-11-19; docs/PRIVATE-APIS.md rows 40–45).
//
// - SLSAddWindowsToSpaces / SLSRemoveWindowsFromSpaces: Margin's OWN windows (its window, panel and backdrop, its menus'
//   windows while they're open) into the Space the helper owns, and out of every other. Another process's window goes
//   through the window manager's bridge (PrivateCalls.swift); these are for Margin's own (the bridge's add/remove left
//   AppKit's menu windows on the Desktop: measured in the kit, 2026-11-19).
// - SLSSetMenuBarVisibilityOverrideOnDisplay: the real menu bar shown (or not) on a display, by Margin, as the pointer
//   reaches the top edge: in a Space nobody owns macOS never brings it down by itself.
// - +[_NSAppleMenu sharedMenu] and its -_addAppleMenuItems, -_userNameChanged: macOS's own Apple menu, built in every
//   app, for the Apple logo Margin draws on that menu bar (its items and their actions are macOS's).
// - SLSCopySpacesForWindows, SLSSpaceGetType: which Space a window is in, and that it's a full-screen one.
//
// Checked at launch (StageCalls.check, the same way as PrivateCalls): anything missing or with a changed encoding turns
// its part off with one log line: without `space` Margin owns its Space as before (AppKit's full screen; macOS's own menu
// bar, which makes Margin the active app as it comes down), without `menuBar` the same, without `appleMenu` no Apple
// logo is drawn (macOS's menu bar otherwise as it is). Refused under MARGIN_APP_TESTS, as every wrapper is.

import AppKit

nonisolated struct StageCalls: @unchecked Sendable {
    nonisolated static let spaceFunctions = ["SLSMainConnectionID", "SLSAddWindowsToSpaces", "SLSRemoveWindowsFromSpaces", "SLSCopySpacesForWindows", "SLSSpaceGetType"]
    nonisolated static let menuBarFunctions = ["SLSMainConnectionID", "SLSSetMenuBarVisibilityOverrideOnDisplay"]
    nonisolated static let appleMenuClass = "_NSAppleMenu"
    nonisolated static let appleMenuShared = "sharedMenu" // a class method
    nonisolated static let appleMenuFill = ["_addAppleMenuItems", "_userNameChanged"] // instance methods

    nonisolated struct Availability: Equatable, Sendable {
        var space = false
        var menuBar = false
        var appleMenu = false
        var reasons: [String: String] = [:]
        static let off = Availability()
        func line() -> String {
            func part(_ name: String, _ on: Bool) -> String { on ? "\(name) ok" : "\(name) off: \(reasons[name] ?? "not checked")" }
            return "ownerless Space calls: \(part("space", space)), \(part("menu bar", menuBar)), \(part("Apple menu", appleMenu))"
        }
    }

    nonisolated static func evaluate(_ resolver: PrivateResolver) -> Availability {
        var a = Availability()
        let sky = resolver.open(.skyLight)
        func problems(_ names: [String]) -> [String] { sky ? names.filter { resolver.function($0, in: .skyLight) == nil }.map { "\($0) missing" } : ["SkyLight.framework didn't open"] }
        let s = problems(spaceFunctions), m = problems(menuBarFunctions)
        a.space = s.isEmpty
        a.menuBar = m.isEmpty
        if !s.isEmpty { a.reasons["space"] = s.prefix(2).joined(separator: ", ") }
        if !m.isEmpty { a.reasons["menu bar"] = m.prefix(2).joined(separator: ", ") }
        if let cls = resolver.objcClass(appleMenuClass) {
            let shared = (cls as AnyObject).responds(to: NSSelectorFromString(appleMenuShared))
            let fills = appleMenuFill.filter { !resolver.responds(appleMenuClass, $0) }
            a.appleMenu = shared && fills.isEmpty
            if !a.appleMenu { a.reasons["Apple menu"] = (shared ? [] : ["+\(appleMenuShared) missing"]).joined() + fills.map { " -\($0) missing" }.joined() }
        } else {
            a.reasons["Apple menu"] = "\(appleMenuClass) missing"
        }
        return a
    }

    @MainActor static func check(resolver: PrivateResolver) -> Availability {
        let a = evaluate(resolver)
        Diagnostics.note(a.line())
        return a
    }

    private typealias MainCID = @convention(c) () -> Int32
    private typealias AddRemove = @convention(c) (Int32, CFArray, CFArray) -> Void
    private typealias SpacesFor = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
    private typealias SpaceType = @convention(c) (Int32, UInt64) -> Int32
    private typealias Override = @convention(c) (Int32, UInt32, Bool) -> Int32

    let availability: Availability
    private let refuses: Bool
    private let mainConnection: MainCID?
    private let addFn: AddRemove?, removeFn: AddRemove?
    private let spacesFn: SpacesFor?
    private let typeFn: SpaceType?
    private let overrideFn: Override?

    init(resolver: PrivateResolver, availability: Availability, refusing: Bool = PrivateCalls.inTests) {
        self.availability = availability
        refuses = refusing
        func fn<T>(_ name: String, _ on: Bool, _ type: T.Type) -> T? {
            guard on, !refusing, let p = resolver.function(name, in: .skyLight) else { return nil }
            return unsafeBitCast(p, to: type)
        }
        mainConnection = fn("SLSMainConnectionID", availability.space || availability.menuBar, MainCID.self)
        addFn = fn("SLSAddWindowsToSpaces", availability.space, AddRemove.self)
        removeFn = fn("SLSRemoveWindowsFromSpaces", availability.space, AddRemove.self)
        spacesFn = fn("SLSCopySpacesForWindows", availability.space, SpacesFor.self)
        typeFn = fn("SLSSpaceGetType", availability.space, SpaceType.self)
        overrideFn = fn("SLSSetMenuBarVisibilityOverrideOnDisplay", availability.menuBar, Override.self)
    }

    private var cid: Int32? { mainConnection.map { $0() }.flatMap { $0 == 0 ? nil : $0 } }

    // A window's Spaces (mask 7: every user kind). nil: unknown.
    func spaces(of window: Int) -> [UInt64]? {
        guard !refuses, window > 0, let cid, let spacesFn, let list = spacesFn(cid, 7, [window] as CFArray)?.takeRetainedValue() as? [NSNumber] else { return nil }
        return list.map(\.uint64Value)
    }

    func spaceType(_ space: UInt64) -> Int? {
        guard !refuses, space > 0, let cid, let typeFn else { return nil }
        return Int(typeFn(cid, space))
    }

    // Margin's own windows into `space` (kept in any other they're in: `remove` takes them out).
    @discardableResult func add(_ windows: [Int], to space: UInt64) -> Bool {
        guard !refuses, space > 0, !windows.isEmpty, let cid, let addFn else { return false }
        addFn(cid, windows as CFArray, [space] as CFArray)
        return true
    }

    @discardableResult func remove(_ windows: [Int], from spaces: [UInt64]) -> Bool {
        guard !refuses, !spaces.isEmpty, !windows.isEmpty, let cid, let removeFn else { return false }
        removeFn(cid, windows as CFArray, spaces as CFArray)
        return true
    }

    // The real menu bar shown on `display` (true) or left to macOS (false). The status: 0 taken.
    @discardableResult func showMenuBar(_ on: Bool, display: UInt32) -> Int32? {
        guard !refuses, let cid, let overrideFn else { return nil }
        return overrideFn(cid, display, on)
    }

    // macOS's own Apple menu (its items filled in once), nil: off.
    func appleMenu() -> NSMenu? {
        guard !refuses, availability.appleMenu, let cls = NSClassFromString(Self.appleMenuClass) as? NSObject.Type,
              let menu = cls.perform(NSSelectorFromString(Self.appleMenuShared))?.takeUnretainedValue() as? NSMenu else { return nil }
        if menu.items.isEmpty { for sel in Self.appleMenuFill { menu.perform(NSSelectorFromString(sel)) } }
        return menu.items.isEmpty ? nil : menu
    }
}
