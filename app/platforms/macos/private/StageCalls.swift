// The private calls behind Margin's ownerless Space and its own menu bar there (MarginStage.swift, MarginMenuBar.swift;
// DECISIONS.md "Margin's Space owned by a helper with no Dock icon", 2026-11-19; docs/PRIVATE-APIS.md rows 40–45).
//
// - No call here moves a window between Spaces: Margin's windows join its stage's Space by macOS's own rules (a panel
//   shown with "move to the active Space", the others its children; MarginWindowController `placeGroup`). The direct
//   SLSAddWindowsToSpaces / SLSRemoveWindowsFromSpaces did, and left the window server's count of a window's current
//   Spaces wrong: a Space switch then stopped the window server (2026-11-19 21:35, DECISIONS.md). Never again.
// - SLSSetMenuBarVisibilityOverrideOnDisplay: the real menu bar shown (or not) on a display, by Margin, as the pointer
//   reaches the top edge: in a Space nobody owns macOS never brings it down by itself.
// - +[NSMenu _dispatchAgentRevealChangedForSpaceID:menuBarRevealTarget:toolbarRevealTarget:duration:]: the menu bar's
//   process told the bar came down (or went up) in that Space: without it, the bar shows but its status items (Wi-Fi,
//   Bluetooth, battery) take no click (2026-11-19 22:30; the kit called it and they worked).
// - +[_NSAppleMenu sharedMenu] and its -_addAppleMenuItems, -_userNameChanged: macOS's own Apple menu, built in every
//   app, for the Apple logo Margin draws on that menu bar (its items and their actions are macOS's).
// - SLSCopySpacesForWindows, SLSSpaceGetType, SLSGetActiveSpace: which Space a window is in, that it's a full-screen
//   one, and which Space is showing (reads only).
//
// Checked at launch (StageCalls.check, the same way as PrivateCalls): anything missing or with a changed encoding turns
// its part off with one log line: without `space` Margin owns its Space as before (AppKit's full screen; macOS's own menu
// bar, which makes Margin the active app as it comes down), without `menuBar` the same, without `appleMenu` no Apple
// logo is drawn (macOS's menu bar otherwise as it is). Refused under MARGIN_APP_TESTS, as every wrapper is.

import AppKit

nonisolated struct StageCalls: @unchecked Sendable {
    nonisolated static let spaceFunctions = ["SLSMainConnectionID", "SLSCopySpacesForWindows", "SLSSpaceGetType", "SLSGetActiveSpace"]
    nonisolated static let menuBarFunctions = ["SLSMainConnectionID", "SLSSetMenuBarVisibilityOverrideOnDisplay"]
    nonisolated static let revealSelector = "_dispatchAgentRevealChangedForSpaceID:menuBarRevealTarget:toolbarRevealTarget:duration:" // NSMenu, a class method
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
        let s = problems(spaceFunctions)
        var m = problems(menuBarFunctions)
        if !(NSMenu.self as AnyObject).responds(to: NSSelectorFromString(revealSelector)) { m.append("+[NSMenu \(revealSelector)] missing") }
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
    private typealias ActiveSpace = @convention(c) (Int32) -> UInt64
    private typealias SpacesFor = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
    private typealias SpaceType = @convention(c) (Int32, UInt64) -> Int32
    private typealias Override = @convention(c) (Int32, UInt32, Bool) -> Int32
    private typealias Reveal = @convention(c) (AnyClass, Selector, Int64, Double, Double, Double) -> Void

    let availability: Availability
    private let refuses: Bool
    private let mainConnection: MainCID?
    private let activeFn: ActiveSpace?
    private let spacesFn: SpacesFor?
    private let typeFn: SpaceType?
    private let overrideFn: Override?
    private let revealFn: Reveal?

    init(resolver: PrivateResolver, availability: Availability, refusing: Bool = PrivateCalls.inTests) {
        self.availability = availability
        refuses = refusing
        func fn<T>(_ name: String, _ on: Bool, _ type: T.Type) -> T? {
            guard on, !refusing, let p = resolver.function(name, in: .skyLight) else { return nil }
            return unsafeBitCast(p, to: type)
        }
        mainConnection = fn("SLSMainConnectionID", availability.space || availability.menuBar, MainCID.self)
        activeFn = fn("SLSGetActiveSpace", availability.space, ActiveSpace.self)
        spacesFn = fn("SLSCopySpacesForWindows", availability.space, SpacesFor.self)
        typeFn = fn("SLSSpaceGetType", availability.space, SpaceType.self)
        overrideFn = fn("SLSSetMenuBarVisibilityOverrideOnDisplay", availability.menuBar, Override.self)
        revealFn = availability.menuBar && !refusing ? class_getClassMethod(NSMenu.self, NSSelectorFromString(Self.revealSelector)).map { unsafeBitCast(method_getImplementation($0), to: Reveal.self) } : nil
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

    // The Space showing (on the display with the menu bar's focus). nil: unknown.
    func activeSpace() -> UInt64? {
        guard !refuses, let cid, let activeFn else { return nil }
        let s = activeFn(cid)
        return s == 0 ? nil : s
    }

    // The real menu bar shown on `display` (true) or left to macOS (false). The status: 0 taken.
    @discardableResult func showMenuBar(_ on: Bool, display: UInt32) -> Int32? {
        guard !refuses, let cid, let overrideFn else { return nil }
        return overrideFn(cid, display, on)
    }

    // The menu bar's process told the bar came down (true) or went up in `space` (with AppKit's own 0.25 s).
    func revealChanged(space: UInt64, shown: Bool) {
        guard !refuses, space > 0, let revealFn else { return }
        revealFn(NSMenu.self, NSSelectorFromString(Self.revealSelector), Int64(space), shown ? 1 : 0, shown ? 1 : 0, 0.25)
    }

    // macOS's own Apple menu (its items filled in once), nil: off.
    func appleMenu() -> NSMenu? {
        guard !refuses, availability.appleMenu, let cls = NSClassFromString(Self.appleMenuClass) as? NSObject.Type,
              let menu = cls.perform(NSSelectorFromString(Self.appleMenuShared))?.takeUnretainedValue() as? NSMenu else { return nil }
        if menu.items.isEmpty { for sel in Self.appleMenuFill { menu.perform(NSSelectorFromString(sel)) } }
        return menu.items.isEmpty ? nil : menu
    }
}
