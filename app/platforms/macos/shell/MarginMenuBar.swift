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
    private let pageArea: () -> CGRect? // the page area (top left), where the strip goes
    private let closeTab: () -> Void

    private let edge: EdgePanel
    private let titles: BarPanel
    private let titlesView: TitlesView
    private let strip: BarPanel
    private var timer: Timer?
    private var leftAt: Date?
    private(set) var shown = false
    private var openMenu: NSMenu?
    private var pending: Int?
    private(set) var reveals = 0

    init(calls: StageCalls, screen: NSScreen, space: UInt64, pageArea: @escaping () -> CGRect?, closeTab: @escaping () -> Void) {
        self.calls = calls
        self.screen = screen
        self.space = space
        self.display = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
        self.pageArea = pageArea
        self.closeTab = closeTab
        let f = screen.frame
        edge = EdgePanel(contentRect: NSRect(x: f.minX, y: f.maxY - 1, width: f.width, height: 1))
        titlesView = TitlesView(frame: .zero)
        titles = BarPanel(contentRect: .zero)
        titles.contentView = titlesView
        titles.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
        strip = BarPanel(contentRect: .zero)
        strip.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) - 1)
        strip.contentView = StripView(close: { [weak self] in self?.closeTab() })
        edge.onEnter = { [weak self] in self?.show() }
        titlesView.onPress = { [weak self] i in DispatchQueue.main.async { self?.press(i) } }
        place(edge)
    }

    // Gone with its window's stage (its Space left or closed, Margin quitting): the bar left to macOS.
    func stop() {
        timer?.invalidate()
        timer = nil
        openMenu?.cancelTrackingWithoutAnimation()
        if shown { calls.showMenuBar(false, display: display) }
        shown = false
        edge.orderOut(nil)
        titles.orderOut(nil)
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
        guard !shown else { return }
        shown = true
        reveals += 1
        calls.showMenuBar(true, display: display)
        layoutTitles()
        place(titles)
        showStrip()
        leftAt = nil
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
        titles.orderOut(nil)
        hideStrip()
    }

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
    private static func panelsOpen() -> Bool {
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        return list.contains { d in
            let layer = d[kCGWindowLayer as String] as? Int ?? 0
            guard layer == Int(CGWindowLevelForKey(.popUpMenuWindow)) || layer == 101 || (d[kCGWindowOwnerName as String] as? String) == "Control Center",
                  let b = d[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return false }
            return r.height > 30
        }
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
        // (Top-left and AppKit coordinates share x: only the height is AppKit's here.)
        guard let page = pageArea(), page.width > 0 else { return nil }
        let h = StripView.height
        let top = screen.frame.maxY - barHeight
        return NSRect(x: page.minX, y: down ? top - h : top, width: page.width, height: h)
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
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) - 1)
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
