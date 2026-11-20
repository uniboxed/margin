// The menu bar in Margin's ownerless Space (MarginStage.swift; DECISIONS.md "Margin's Space owned by a helper with no
// Dock icon", 2026-11-19; proven in the kit, /tmp/margin-toolbar-test/mbx/mbh.swift, Tirth's hand checks 2026-11-19).
//
// In a Space nobody owns macOS never brings its menu bar down by itself, and shows no app's menus in it. So, while a
// Margin window is in its stage's Space:
// - The pointer at the display's top edge (a 1-point strip that only wakes on that hover: no polling while it's hidden)
//   shows the real menu bar (StageCalls.showMenuBar): macOS's own bar, its status items and Control Center (Wi-Fi,
//   Bluetooth, battery work, and the app Margin hosts keeps the keyboard: nobody owns the Space to be made active).
// - On its empty left Margin draws the Apple logo and its own menus' titles, in the menu bar's font and colour (asked of
//   AppKit: dark on a light bar, light on a dark one; the full-screen bar is dark even in light mode). A press opens the
//   real menu: macOS's own Apple menu (a fresh copy of +[_NSAppleMenu sharedMenu]: its items and actions are macOS's)
//   or Margin's (NSApp.mainMenu, the app menu as a fresh copy: AppKit shows the app menu itself only in the menu bar).
//   Moving onto another title while one is open switches menus, as the real bar does. The open title's highlight is
//   the real bar's: a flat capsule, white at 15 % on the dark bar (black at 10 % on a light one), 23.5 points tall,
//   measured from macOS's own (Tirth's screenshot, 2026-11-19).
// - Under the bar, over the page area, a title strip slides down: AppKit's own window buttons (NSWindow
//   .standardWindowButton) on AppKit's title bar material. Close: Margin's Close Tab; minimize and zoom do nothing
//   (Margin is always full screen) (decided by Tirth, 2026-11-19).
// - It goes up 0.35 s after the pointer leaves the top 96 points, never while a menu or a Control Center panel is open.
// - Every window AppKit opens for a menu of Margin's (this bar's, and its UI's pop-ups) lands on Margin's own Desktop,
//   out of sight: it's shown with "move to the active Space" as it appears (MarginStage). This bar's own panels join
//   the stage the same way (`place`). No direct Space call anywhere (one broke the window server, 2026-11-19).
// - Costs: three small windows; a 30 Hz look at the pointer only while the bar is down. Nothing while it's up.

import AppKit

@MainActor
final class MarginMenuBar {
    static let hideAfter: TimeInterval = 0.35
    static let band: CGFloat = 96 // points from the top the pointer can be in and the bar stays down
    static let pillHeight: CGFloat = 23.5
    static let titlePadding: CGFloat = 20
    static let appleWidth: CGFloat = 36
    static let firstTitleX: CGFloat = 44 // after the Apple logo, as macOS lays its titles out

    private let calls: StageCalls
    private let display: CGDirectDisplayID
    private let screen: NSScreen
    private let space: UInt64
    private let closeTab: () -> Void

    private let edge: EdgePanel
    private let titles: BarPanel
    private let titlesView: TitlesView
    private let strip: BarPanel
    private let icons: BarPanel
    private let iconsView = IconsView(frame: .zero)
    private var timer: Timer?
    private var leftAt: Date?
    private(set) var shown = false
    private var openMenu: NSMenu?
    private var revealMode = "both"
    private var pending: Int?
    private(set) var reveals = 0

    init(calls: StageCalls, screen: NSScreen, space: UInt64, closeTab: @escaping () -> Void) {
        self.calls = calls
        self.screen = screen
        self.space = space
        self.display = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
        self.closeTab = closeTab
        let f = screen.frame
        edge = EdgePanel(contentRect: NSRect(x: f.minX, y: f.maxY - 1, width: f.width, height: 1))
        titlesView = TitlesView(frame: .zero)
        titles = BarPanel(contentRect: .zero)
        titles.contentView = titlesView
        titles.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
        strip = BarPanel(contentRect: .zero)
        icons = BarPanel(contentRect: .zero)
        icons.contentView = iconsView
        icons.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
        strip.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) - 1)
        strip.contentView = StripView(close: { [weak self] in self?.closeTab() })
        edge.onEnter = { [weak self] in self?.show() }
        titlesView.onPress = { [weak self] i in DispatchQueue.main.async { self?.press(i) } }
        placeEdge()
        Diagnostics.note("Margin's menu bar: on in its stage's Space \(space) (the top edge \(edge.isVisible ? "watched" : "not watched yet: its Space isn't showing"))")
    }

    // Gone with its window's stage (its Space left or closed, Margin quitting): the bar left to macOS.
    func stop() {
        timer?.invalidate()
        timer = nil
        openMenu?.cancelTrackingWithoutAnimation()
        if shown { calls.showMenuBar(false, display: display); calls.revealChanged(space: space, shown: false) }
        shown = false
        edge.orderOut(nil)
        titles.orderOut(nil)
        icons.orderOut(nil)
        strip.orderOut(nil)
    }

    // Shown in the stage's Space by macOS's own rule (only ever while it's the Space showing: the bar is made as its
    // window joins it, and comes down from a hover there): "move to the active Space" as it's ordered in, then back to
    // joining full-screen Spaces so no later order moves it. Never a direct Space call (DECISIONS.md, 2026-11-19).
    private func place(_ p: NSPanel) {
        p.collectionBehavior = MarginStage.menuBehavior
        p.orderFrontRegardless()
        p.collectionBehavior = Self.placedBehavior
    }
    static let placedBehavior: NSWindow.CollectionBehavior = [.canJoinAllApplications, .fullScreenAuxiliary, .ignoresCycle, .stationary]

    private var barHeight: CGFloat { max(NSStatusBar.system.thickness, screen.safeAreaInsets.top) }

    // ---- down and up ----

    private func show() {
        guard !shown, calls.activeSpace() == space else { return }
        shown = true
        reveals += 1
        calls.showMenuBar(true, display: display)
        // (The menu bar's process told: its status items take clicks then. `MarginBarReveal`: "both" (the default: the
        // bar and full-screen toolbars), "menu" (the bar only), "none" (not told): read at each reveal, for the hand test
        // of 2026-11-19 23:00, where the bar's status items took no click in Margin.)
        let mode = UserDefaults.standard.string(forKey: "MarginBarReveal") ?? "both"
        if mode != "none" { calls.revealChanged(space: space, shown: true, toolbars: mode != "menu") }
        revealMode = mode
        edge.orderOut(nil)
        layoutTitles()
        place(titles)
        showIcons()
        showStrip()
        leftAt = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.shown else { return }
            let p = CGPoint(x: self.screen.frame.maxX - 300, y: 12) // (over the status icons, in the window server's coordinates)
            let stack = ((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []).compactMap { d -> String? in
                guard let b = d[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary), r.contains(p) else { return nil }
                return "\(d[kCGWindowOwnerName as String] ?? "?")@\(d[kCGWindowLayer as String] ?? "?") \(Int(r.width))×\(Int(r.height))"
            }.prefix(4).joined(separator: " > ")
            Diagnostics.note("Margin's menu bar: down (\(self.revealMode)); over the status icons: \(stack); front \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "none")")
        }
        let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.look() } }
        RunLoop.main.add(t, forMode: .common) // (also while a menu tracks)
        timer = t
    }

    private func hide() {
        guard shown else { return }
        shown = false
        timer?.invalidate()
        timer = nil
        calls.showMenuBar(false, display: display)
        if revealMode != "none" { calls.revealChanged(space: space, shown: false) }
        titles.orderOut(nil)
        icons.orderOut(nil)
        hideStrip()
        placeEdge()
    }

    // The top-edge strip in the stage, only while the stage is the Space showing ("move to the active Space" would put it
    // in whichever Space shows); else when it shows again (`stageShowing`).
    private func placeEdge() {
        guard !shown, !edge.isVisible, calls.activeSpace() == space else { return }
        place(edge)
    }

    // Its stage's Space showing again (MarginWindowController `spaceChanged`): the top-edge strip there if it isn't.
    func stageShowing() { placeEdge() }

    private func look() {
        let m = NSEvent.mouseLocation
        let top = screen.frame.maxY
        // (Moving onto another title while a menu is open: that one's menu instead.)
        if let menu = openMenu, let k = titlesView.open, m.y >= top - barHeight,
           let j = titlesView.index(at: NSPoint(x: m.x - titles.frame.minX, y: m.y - titles.frame.minY)), j != k {
            pending = j
            menu.cancelTrackingWithoutAnimation()
            return
        }
        if m.y >= top - Self.band || openMenu != nil || NSEvent.pressedMouseButtons != 0 || Self.panelsOpen() { leftAt = nil; return }
        if let l = leftAt { if Date().timeIntervalSince(l) > Self.hideAfter { hide() } } else { leftAt = Date() }
    }

    // A Control Center or menu-bar panel open (Wi-Fi, Bluetooth, a status item's menu): the bar stays down.
    static func panelsOpen() -> Bool {
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        return list.contains { d in
            let layer = d[kCGWindowLayer as String] as? Int ?? 0
            guard layer == Int(CGWindowLevelForKey(.popUpMenuWindow)) || layer == 101 || (d[kCGWindowOwnerName as String] as? String) == "Control Center",
                  let b = d[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return false }
            return r.height > 30
        }
    }

    // ---- the status items (Wi-Fi, Bluetooth, the battery, Control Center, the clock…) ----

    // In a Space nobody owns, macOS keeps a window of its menu bar's own over the bar (layer 25, the whole width) while a
    // window of an app with a Dock icon (Margin's) is in it: there to bring the bar down for that app, which it never does
    // there, it takes every click meant for the status items (2026-11-19 23:12: the clicks reached MenuBarAgent's layer-25
    // window, no panel opened; the test kit, with no such app's window in its Space, had none). So, while the bar is down,
    // a panel of Margin's lies over the status items, above that window, and a press on an item presses that item
    // through Accessibility (Margin's grant), as the click would have: its panel opens and the app shown keeps the
    // keyboard (nobody owns the Space; measured 23:16). The items' frames are read as the bar comes down, never on a timer.
    private func showIcons() {
        let items = StatusItems.read()
        guard let minX = items.map({ $0.frame.minX }).min() else { return icons.orderOut(nil) }
        let x = minX - 4
        iconsView.items = items.map { (element: $0.element, rect: NSRect(x: $0.frame.minX - x, y: 0, width: $0.frame.width, height: barHeight), name: $0.name) }
        icons.setFrame(NSRect(x: x, y: screen.frame.maxY - barHeight, width: screen.frame.maxX - x, height: barHeight), display: false)
        iconsView.frame = NSRect(origin: .zero, size: icons.frame.size)
        place(icons)
    }

    // ---- the titles ----

    private func layoutTitles() {
        var items: [TitlesView.Item] = []
        if let apple = calls.appleMenu() { items.append(.init(title: "", menu: apple, rect: NSRect(x: 8, y: 0, width: Self.appleWidth, height: barHeight), apple: true, bold: false)) }
        var x = Self.firstTitleX
        // Titles never under the notch: the left area beside it (the whole width without one).
        let limit = screen.auxiliaryTopLeftArea.map { $0.maxX - screen.frame.minX } ?? screen.frame.width / 2
        for (i, item) in (NSApp.mainMenu?.items ?? []).enumerated() {
            guard let sub = item.submenu, !item.isHidden else { continue }
            let w = (TitlesView.width(of: item.title, bold: i == 0) + Self.titlePadding).rounded()
            if x + w > limit { break }
            items.append(.init(title: item.title, menu: sub, rect: NSRect(x: x, y: 0, width: w, height: barHeight), apple: false, bold: i == 0))
            x += w
        }
        titlesView.items = items
        titles.setFrame(NSRect(x: screen.frame.minX, y: screen.frame.maxY - barHeight, width: x + 8, height: barHeight), display: true)
        titlesView.needsDisplay = true
    }

    // A title pressed: its menu, then the next one the pointer moved onto, until none is pending.
    private func press(_ i: Int) {
        guard openMenu == nil else { return }
        var next: Int? = i
        while let k = next, k < titlesView.items.count {
            next = nil
            pending = nil
            let item = titlesView.items[k]
            // (Fresh copies: macOS shows its Apple menu and an app's own menu only in the menu bar; a copy of their
            // items, same actions and targets, opens anywhere. Margin's other menus open as they are.)
            let menu = item.apple ? MarginMenuBar.copy(item.menu, enableAll: true) : (k == firstMarginIndex ? MarginMenuBar.copy(item.menu, enableAll: false) : item.menu)
            titlesView.open = k
            openMenu = menu
            menu.popUp(positioning: nil, at: NSPoint(x: item.rect.minX + 4, y: -3), in: titlesView)
            openMenu = nil
            next = pending
        }
        titlesView.open = nil
    }

    private var firstMarginIndex: Int { titlesView.items.firstIndex { !$0.apple } ?? -1 }

    // A menu rebuilt with new items (titles, actions, targets, shortcuts, alternates, submenus). `enableAll`: macOS's
    // Apple menu, whose own check of its items misreads them in a copy (Sleep greyed on a Mac that sleeps): its items
    // as they're enabled in macOS's menu, except the ones the menu itself hides.
    static func copy(_ src: NSMenu, enableAll: Bool) -> NSMenu {
        let c = NSMenu(title: src.title)
        c.autoenablesItems = enableAll ? false : src.autoenablesItems
        for i in src.items {
            if i.isSeparatorItem { c.addItem(.separator()); continue }
            let n = NSMenuItem(title: i.title, action: i.action, keyEquivalent: i.keyEquivalent)
            n.keyEquivalentModifierMask = i.keyEquivalentModifierMask
            n.target = i.target
            n.tag = i.tag
            n.representedObject = i.representedObject
            n.isAlternate = i.isAlternate
            n.isHidden = i.isHidden || (enableAll && i.action == NSSelectorFromString("_locationRequested:")) // (macOS shows Location only with several)
            n.isEnabled = enableAll ? true : i.isEnabled
            n.image = i.image
            if let sub = i.submenu { n.submenu = copy(sub, enableAll: enableAll) }
            c.addItem(n)
        }
        return c
    }

    // ---- the strip ----

    private func stripFrame(down: Bool) -> NSRect? {
        // (The display's whole width, as macOS's own strip over a full-screen window: Tirth, 2026-11-19.)
        let h = StripView.height
        let top = screen.frame.maxY - barHeight
        return NSRect(x: screen.frame.minX, y: down ? top - h : top, width: screen.frame.width, height: h)
    }

    private func showStrip() {
        guard let up = stripFrame(down: false), let down = stripFrame(down: true) else { return }
        strip.setFrame(up, display: false)
        place(strip)
        NSAnimationContext.runAnimationGroup { c in c.duration = 0.25; strip.animator().setFrame(down, display: true) }
    }

    private func hideStrip() {
        guard strip.isVisible, let up = stripFrame(down: false) else { return strip.orderOut(nil) }
        NSAnimationContext.runAnimationGroup({ c in c.duration = 0.2; strip.animator().setFrame(up, display: true) },
                                             completionHandler: { [weak self] in MainActor.assumeIsolated { if self?.shown == false { self?.strip.orderOut(nil) } } })
    }
}

// macOS's status items, as Accessibility has them (MenuBarAgent's extras menu bar: each item, or each group's item, and
// the hidden items' button), with their frames in AppKit's coordinates. Nothing logged but identifiers.
enum StatusItems {
    struct Item { var element: AXUIElement; var frame: NSRect; var name: String }
    static func read() -> [Item] {
        guard AXIsProcessTrusted(), let agent = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.MenuBarAgent" || $0.localizedName == "MenuBarAgent" }) else { return [] }
        func attr<T>(_ e: AXUIElement, _ n: String) -> T? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v as? T : nil }
        let app = AXUIElementCreateApplication(agent.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 0.3)
        guard let bar: AXUIElement = attr(app, "AXExtrasMenuBar"), let groups: [AXUIElement] = attr(bar, kAXChildrenAttribute) else { return [] }
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        var out: [Item] = []
        for g in groups {
            let role: String? = attr(g, kAXRoleAttribute)
            let candidates = role == "AXGroup" ? ((attr(g, kAXChildrenAttribute) as [AXUIElement]?) ?? []) : [g]
            for e in candidates {
                guard let r: String = attr(e, kAXRoleAttribute), r == "AXMenuBarItem" || r == "AXButton" else { continue }
                var p = CGPoint.zero, s = CGSize.zero
                guard let pv: AXValue = attr(e, kAXPositionAttribute), let sv: AXValue = attr(e, kAXSizeAttribute),
                      AXValueGetValue(pv, .cgPoint, &p), AXValueGetValue(sv, .cgSize, &s), s.width > 0 else { continue }
                out.append(Item(element: e, frame: NSRect(x: p.x, y: top - p.y - s.height, width: s.width, height: s.height), name: (attr(e, "AXIdentifier") as String?) ?? r))
            }
        }
        return out
    }
}

// The panel over the status items: a press on one presses it through Accessibility.
private final class IconsView: NSView {
    var items: [(element: AXUIElement, rect: NSRect, name: String)] = []
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let item = items.first(where: { $0.rect.insetBy(dx: -3, dy: 0).contains(p) }) else { return }
        let element = item.element, name = item.name
        DispatchQueue.global(qos: .userInteractive).async {
            AXUIElementSetMessagingTimeout(element, 0.5)
            let r = AXUIElementPerformAction(element, kAXPressAction as CFString)
            DispatchQueue.main.async { Diagnostics.note("Margin's menu bar: \(name) pressed for the click (\(r == .success ? "done" : "Accessibility said \(r.rawValue)"))") }
        }
    }
}

// The 1-point strip at the display's top edge: its tracking area is the only thing that wakes the bar.
private final class EdgePanel: NSPanel {
    var onEnter: (() -> Void)?
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = NSColor(white: 0, alpha: 0.004) // (not fully clear: a fully clear pixel lets the pointer through)
        hasShadow = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        ignoresMouseEvents = false
        // (Above the menu bar's own window: macOS keeps it over a full-screen Space's top edge, hidden, and it took the
        // hover, 2026-11-19. Out of the way while the real bar is down: MarginMenuBar takes it out and puts it back.)
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
        collectionBehavior = MarginMenuBar.placedBehavior
        let v = EdgeView(frame: NSRect(origin: .zero, size: contentRect.size))
        v.autoresizingMask = [.width, .height]
        v.onEnter = { [weak self] in self?.onEnter?() }
        contentView = v
    }
}

private final class EdgeView: NSView {
    var onEnter: (() -> Void)?
    private var area: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        let a = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(a)
        area = a
    }
    override func mouseEntered(with event: NSEvent) { onEnter?() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// A borderless, non-activating, never-key panel for the titles and the strip (the whole of it takes the pointer).
private final class BarPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        ignoresMouseEvents = false // (said: the default lets a press through the transparent pixels between the letters)
        collectionBehavior = MarginMenuBar.placedBehavior
        animationBehavior = .none
    }
}

// The titles over the bar's empty left, and the open one's capsule (a layer under the words).
private final class TitlesView: NSView {
    struct Item { var title: String; var menu: NSMenu; var rect: NSRect; var apple: Bool; var bold: Bool }
    var items: [Item] = []
    var onPress: ((Int) -> Void)?
    private let pill = CALayer()
    var open: Int? {
        didSet {
            CATransaction.begin(); CATransaction.setDisableActions(true)
            if let k = open, k < items.count {
                let r = items[k].rect, h = MarginMenuBar.pillHeight
                pill.frame = NSRect(x: r.minX, y: ((bounds.height - h) / 2).rounded(), width: r.width, height: h)
                pill.cornerRadius = h / 2
                pill.backgroundColor = NSColor(white: dark ? 1 : 0, alpha: dark ? 0.15 : 0.1).cgColor
                pill.isHidden = false
            } else { pill.isHidden = true }
            CATransaction.commit()
        }
    }
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        pill.isHidden = true
        layer?.addSublayer(pill)
    }
    required init?(coder: NSCoder) { nil }
    var dark: Bool { effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
    static func width(of title: String, bold: Bool) -> CGFloat { (title as NSString).size(withAttributes: [.font: font(bold)]).width }
    static func font(_ bold: Bool) -> NSFont { let f = NSFont.menuBarFont(ofSize: 0); return bold ? NSFontManager.shared.convert(f, toHaveTrait: .boldFontMask) : f }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true; let o = open; open = o }
    override func draw(_ dirtyRect: NSRect) {
        let color = dark ? NSColor.white : NSColor.black
        for item in items {
            let text = item.apple ? "\u{F8FF}" : item.title
            let font = item.apple ? NSFont.systemFont(ofSize: NSFont.menuBarFont(ofSize: 0).pointSize + 2) : Self.font(item.bold)
            let a: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            let size = (text as NSString).size(withAttributes: a)
            (text as NSString).draw(at: NSPoint(x: (item.rect.midX - size.width / 2).rounded(), y: ((bounds.height - size.height) / 2).rounded()), withAttributes: a)
        }
    }
    func index(at p: NSPoint) -> Int? { items.firstIndex { $0.rect.contains(p) } }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { if let i = index(at: convert(event.locationInWindow, from: nil)) { onPress?(i) } }
}

// The title strip: AppKit's own close, minimize and zoom buttons on AppKit's title bar material.
private final class StripView: NSVisualEffectView {
    static let height: CGFloat = 28
    private let close: () -> Void
    init(close: @escaping () -> Void) {
        self.close = close
        super.init(frame: NSRect(x: 0, y: 0, width: 400, height: Self.height))
        material = .titlebar
        blendingMode = .behindWindow
        state = .active
        autoresizingMask = [.width]
        var x: CGFloat = 12
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            guard let b = NSWindow.standardWindowButton(kind, for: [.titled, .closable, .miniaturizable, .resizable]) else { continue }
            b.target = self
            b.action = kind == .closeButton ? #selector(closePressed) : #selector(nothing)
            b.setFrameOrigin(NSPoint(x: x, y: ((Self.height - b.frame.height) / 2).rounded()))
            x += b.frame.width + 8
            addSubview(b)
        }
    }
    required init?(coder: NSCoder) { nil }
    @objc private func closePressed() { close() }
    @objc private func nothing() {} // (minimize and zoom: Margin is always full screen)
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
