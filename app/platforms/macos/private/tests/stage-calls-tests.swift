// The ownerless Space's calls (StageCalls.swift), its helper's switch (MarginStage.swift) and the menu bar's copies of
// macOS's menus (MarginMenuBar.swift): part of tests.swift's run. No real private function is ever called (the
// wrappers refuse under MARGIN_APP_TESTS), no helper is started, no window is made.

import AppKit

// Everything macOS 27.2 has for the stage, unless a test takes something away.
final class FakeStageResolver: PrivateResolver, @unchecked Sendable {
    var version = "27.2"
    var build: String? = "26B123"
    var skyLight = true
    var functions = Set(StageCalls.spaceFunctions + StageCalls.menuBarFunctions)
    var appleMenu: AnyClass? = FakeAppleMenu.self
    var fills = Set(StageCalls.appleMenuFill)
    func open(_ framework: PrivateFramework) -> Bool { framework == .skyLight ? skyLight : true }
    // (Never called: every wrapper refuses in the tests. Any non-nil pointer says "there".)
    func function(_ name: String, in framework: PrivateFramework) -> UnsafeRawPointer? { functions.contains(name) ? UnsafeRawPointer(bitPattern: 0x10) : nil }
    func objcClass(_ name: String) -> AnyClass? { name == StageCalls.appleMenuClass ? appleMenu : nil }
    func responds(_ className: String, _ selector: String) -> Bool { className == StageCalls.appleMenuClass && appleMenu != nil && fills.contains(selector) }
    func typeEncoding(_ className: String, _ selector: String) -> String? { nil }
    func implementation(_ className: String, _ selector: String) -> UnsafeRawPointer? { nil }
}

final class FakeAppleMenu: NSObject {
    @objc static func sharedMenu() -> NSMenu { NSMenu(title: "Apple") }
}

func stageCallsTests() {
    let all = StageCalls.evaluate(FakeStageResolver())
    check("stage calls: all there: the Space, the menu bar and the Apple menu on", all.space && all.menuBar && all.appleMenu && all.reasons.isEmpty, "\(all)")
    for name in ["SLSCopySpacesForWindows", "SLSSpaceGetType", "SLSGetActiveSpace"] {
        let r = FakeStageResolver()
        r.functions.remove(name)
        let a = StageCalls.evaluate(r)
        check("stage calls: no \(name): the Space off (named), the menu bar and Apple menu on", !a.space && a.menuBar && a.appleMenu && a.reasons["space"] == "\(name) missing", "\(a)")
    }
    do {
        let r = FakeStageResolver()
        r.functions.remove("SLSSetMenuBarVisibilityOverrideOnDisplay")
        let a = StageCalls.evaluate(r)
        check("stage calls: no menu bar override: the menu bar off, the Space on", a.space && !a.menuBar && a.reasons["menu bar"] == "SLSSetMenuBarVisibilityOverrideOnDisplay missing", "\(a)")
        r.functions.remove("SLSMainConnectionID")
        let b = StageCalls.evaluate(r)
        check("stage calls: no SLSMainConnectionID: the Space and the menu bar off", !b.space && !b.menuBar, "\(b)")
    }
    do {
        let r = FakeStageResolver()
        r.skyLight = false
        let a = StageCalls.evaluate(r)
        check("stage calls: SkyLight doesn't open: the Space and the menu bar off, said", !a.space && !a.menuBar && a.reasons["space"] == "SkyLight.framework didn't open" && a.reasons["menu bar"] == "SkyLight.framework didn't open", "\(a)")
    }
    do {
        let r = FakeStageResolver()
        r.appleMenu = nil
        let a = StageCalls.evaluate(r)
        check("stage calls: no _NSAppleMenu: only the Apple menu off", a.space && a.menuBar && !a.appleMenu && a.reasons["Apple menu"] == "_NSAppleMenu missing", "\(a)")
        let f = FakeStageResolver()
        f.fills.remove("_addAppleMenuItems")
        let b = StageCalls.evaluate(f)
        check("stage calls: the Apple menu's fill missing: only the Apple menu off, named", b.space && b.menuBar && !b.appleMenu && (b.reasons["Apple menu"] ?? "").contains("_addAppleMenuItems"), "\(b)")
        let s = FakeStageResolver()
        s.appleMenu = NSObject.self // (no +sharedMenu)
        s.fills = Set(StageCalls.appleMenuFill)
        let c = StageCalls.evaluate(s)
        check("stage calls: no +sharedMenu: the Apple menu off", !c.appleMenu && (c.reasons["Apple menu"] ?? "").contains("sharedMenu"), "\(c)")
    }
    // The wrappers refuse in the tests, whatever the check said.
    let calls = StageCalls(resolver: FakeStageResolver(), availability: all)
    check("stage calls: refused in the tests (reads nil, no menu bar, no Apple menu)",
          calls.spaces(of: 5) == nil && calls.spaceType(7) == nil && calls.activeSpace() == nil && calls.showMenuBar(true, display: 1) == nil && calls.appleMenu() == nil)
    check("stage calls: no call moves a window between Spaces (the direct add/remove broke the window server, 2026-11-19)",
          !(StageCalls.spaceFunctions + StageCalls.menuBarFunctions).contains { $0.contains("AddWindows") || $0.contains("RemoveWindows") || $0.contains("MoveWindows") })
    check("stage: menus and the bar's panels join the Space showing by macOS's own rule, then never move",
          MarginStage.menuBehavior.contains(.moveToActiveSpace) && MarginMenuBar.placedBehavior.contains(.canJoinAllApplications) && !MarginMenuBar.placedBehavior.contains(.moveToActiveSpace)
          && MarginPanel.stageBehavior.contains(.canJoinAllApplications) && MarginWindow.stageBehavior.contains(.canJoinAllApplications) && MarginBackdrop.stageBehavior.contains(.canJoinAllApplications))

    // The helper's switch: never usable without its calls or its bundle, never a dead end.
    let off = MarginStage(calls: StageCalls(resolver: FakeStageResolver(), availability: .off), executable: URL(fileURLWithPath: "/bin/sh"))
    check("stage: its calls off: not usable, said why", !off.usable && (off.offReason ?? "").contains("calls are off"), off.offReason ?? "")
    let noBundle = MarginStage(calls: calls, executable: URL(fileURLWithPath: "/nonexistent/margin-space"))
    check("stage: Margin Space.app not in the bundle: not usable, said why", !noBundle.usable && (noBundle.offReason ?? "").contains("Margin Space.app"), noBundle.offReason ?? "")
    var noMenuBar = all
    noMenuBar.menuBar = false
    let menuOff = MarginStage(calls: StageCalls(resolver: FakeStageResolver(), availability: noMenuBar), executable: URL(fileURLWithPath: "/bin/sh"))
    check("stage: no menu bar call: not usable (Margin owns its Space, macOS's own bar)", !menuOff.usable && (menuOff.offReason ?? "").contains("menu bar"), menuOff.offReason ?? "")
    let usable = MarginStage(calls: calls, executable: URL(fileURLWithPath: "/bin/sh"))
    check("stage: everything there: usable", usable.usable, usable.offReason ?? "")
    usable.giveUp("a stage didn't come")
    check("stage: given up once: not usable for the rest of the run", !usable.usable && usable.offReason == "a stage didn't come")
    check("stage: the bundled helper's path", MarginStage.bundledExecutable?.path.hasSuffix("Contents/Helpers/Margin Space.app/Contents/MacOS/margin-space") == true)

    // The menu bar's copies of a menu: every item's title, action, target, shortcut, alternate, tag and submenu kept;
    // macOS's Apple menu with every item enabled (its own check misreads a copy) and Location hidden.
    final class Target: NSObject { @objc func run(_ sender: Any?) {} }
    let target = Target()
    let src = NSMenu(title: "File")
    let a = NSMenuItem(title: "New Tab", action: #selector(Target.run(_:)), keyEquivalent: "t")
    a.target = target; a.representedObject = "new-tab"; a.tag = 3
    let b = NSMenuItem(title: "Close All", action: #selector(Target.run(_:)), keyEquivalent: "w")
    b.keyEquivalentModifierMask = [.command, .option]; b.isAlternate = true; b.isEnabled = false
    let sub = NSMenu(title: "Recent"); sub.addItem(NSMenuItem(title: "One", action: nil, keyEquivalent: ""))
    let c = NSMenuItem(title: "Recent", action: nil, keyEquivalent: ""); c.submenu = sub
    let loc = NSMenuItem(title: "Location", action: NSSelectorFromString("_locationRequested:"), keyEquivalent: "")
    src.addItem(a); src.addItem(.separator()); src.addItem(b); src.addItem(c); src.addItem(loc)
    let copy = MarginMenuBar.copy(src, enableAll: false)
    let i = copy.items
    check("menu bar: a copy keeps every item (titles, separators, order)", i.map(\.title) == src.items.map(\.title) && i[1].isSeparatorItem && copy.title == "File")
    check("menu bar: a copy's item: its action, target, shortcut, tag and represented object",
          i[0].action == #selector(Target.run(_:)) && i[0].target === target && i[0].keyEquivalent == "t" && i[0].tag == 3 && i[0].representedObject as? String == "new-tab")
    check("menu bar: a copy keeps an alternate and its modifiers, and a disabled item disabled", i[2].isAlternate && i[2].keyEquivalentModifierMask == [.command, .option] && !i[2].isEnabled)
    check("menu bar: a copy's submenu is a copy too", i[3].submenu !== sub && i[3].submenu?.items.first?.title == "One")
    check("menu bar: Location shown in a copy of Margin's own menu", !i[4].isHidden)
    let apple = MarginMenuBar.copy(src, enableAll: true)
    check("menu bar: the Apple menu's copy: every item enabled, not auto-enabled, Location hidden",
          !apple.autoenablesItems && apple.items.filter { !$0.isSeparatorItem }.allSatisfy(\.isEnabled) && apple.items[4].isHidden)
    check("menu bar: the highlight is the real bar's (23.5 points)", MarginMenuBar.pillHeight == 23.5)

    // The fallback (Margin owns its Space): made active by macOS's menu bar, the keys go back once it's up again.
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    func by(_ stage: Bool = false, _ full: Bool = true, _ shown: Bool = true, _ field: Bool = false, y: CGFloat = 980) -> Bool {
        MarginWindowController.madeActiveByBar(inStage: stage, fullScreen: full, appShown: shown, fieldWantsKeys: field, pointer: CGPoint(x: 400, y: y), screen: screen)
    }
    check("fallback bar: made active with the pointer at the top, an app shown: the bar did it", by())
    check("fallback bar: the pointer lower down (⌘-Tab, the Dock): not the bar", !by(y: 900))
    check("fallback bar: in a stage (nobody is made active there): never watched", !by(true))
    check("fallback bar: nothing shown, not in full screen, or a field of Margin's wanting the keys: not watched", !by(false, true, false) && !by(false, false) && !by(false, true, true, true))
    func down(y: CGFloat = 500, buttons: Int = 0, menus: Int = 0, panels: Bool = false) -> Bool {
        MarginWindowController.barDown(pointer: CGPoint(x: 400, y: y), screen: screen, buttons: buttons, menus: menus, panels: panels)
    }
    check("fallback bar: up once the pointer's lower, no button, no menu, no panel", !down())
    check("fallback bar: still down at the top, with a button held, a menu open or a Control Center panel open",
          down(y: 960) && down(buttons: 1) && down(menus: 1) && down(panels: true))
    check("fallback bar: the keys go back after it's been up 0.4 s, given up after 2 minutes", MarginWindowController.barUpFor == 0.4 && MarginWindowController.barWatchMost == 120)
}
