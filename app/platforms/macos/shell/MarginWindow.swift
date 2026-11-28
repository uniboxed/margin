// Margin's own window (docs/MARGIN-APP.md, phase 2): a regular app window,
// windowed or full screen (its own Space). It's always full screen
// (`locksFullScreen`: AppKit's toggle refused once it's in). Since 2026-11-17
// ("Margin's UI never makes the hosted app inactive") it's only the base: it
// owns Margin's full-screen Space (Spaces, Mission Control and the hosting rest
// on it), is kept in front of what it hosts (its level, or its order), draws
// nothing (its background clear) and, in full screen, ignores the mouse. Margin's
// UI is drawn in its child, MarginPanel below: a non-activating panel laid
// exactly over it, so a press in Margin's UI never makes Margin the active app
// and the hosted app keeps its active look (as Spotlight's panel does).
//
// - MarginWindow: the NSWindow. `pageRect` is the page area in the window
//   server's coordinates (top left, points), published with `onPageRectChange`
//   by its controller (MarginWindowController.swift) from the UI's own layout
//   report (`<m-page>`, ui/render.ts measure()) and the window's frame.
// - MarginPanel: what's drawn and what takes the mouse and, when a field of Margin's wants them, the keys: the web
//   view, the ground with the hole (WindowGroundView), the catch fill (PassThrough.swift). A press in a theme's
//   drag region (`<m-drag-region>`) moves the window, a double press zooms it; the window's buttons go where the
//   theme draws `<m-window-controls>` (the panel lets the pointer through to them while windowed).
// - MarginWindowGeometry: the arithmetic, on its own (tests/margin-window-tests.swift).
// - MarginMenu: Margin's menu bar in this mode (its menu items, no global hot keys).
//
// In the tests (`harness`) neither window is ever on a display: AppKit makes a
// titled window asked for off every display on the main one (seen 2026-11-15),
// so it's put back where it was asked for at once; they're ordered in only while
// their frame is off every display (as the overlays' tests' panels were), a frame
// that touches one is refused, AppKit never moves them onto one, nothing is made
// key.

import AppKit
import MarginCore

final class MarginWindow: NSWindow {
    static let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
    static let minimum = NSSize(width: 640, height: 420)

    var harness = false
    // The page area, top left, in points (nil: not measured at this size yet).
    private(set) var pageRect: CGRect?
    private(set) var pageRadius: CGFloat = 0
    var onPageRectChange: ((CGRect?) -> Void)?
    // Always full screen (MarginWindowController.Options.alwaysFullScreen): AppKit's toggle (the green button, a menu
    // item anywhere) refused while it's in full screen; into it always taken.
    var locksFullScreen = false
    private(set) var refusedToggles = 0

    init(frame topLeft: CGRect, harness: Bool) {
        self.harness = harness
        super.init(contentRect: ScreenGeometry.appKitRect(topLeft), styleMask: Self.style, backing: .buffered, defer: false)
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        title = "Margin"
        // (Clear: it draws nothing; its panel draws Margin's UI, filled everywhere but the hole. Not opaque to AppKit.)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isReleasedWhenClosed = false
        isMovableByWindowBackground = false
        tabbingMode = .disallowed // ⌘T is Margin's (a new tab in its UI), never AppKit's window tabs
        collectionBehavior = [.fullScreenPrimary, .managed]
        minSize = Self.minimum
        animationBehavior = harness ? .none : .documentWindow
        // (Made, AppKit put it on the main display: back off every display before anything orders it in.)
        if harness { setFrame(ScreenGeometry.appKitRect(topLeft), display: false) }
    }

    var onADisplay: Bool { NSScreen.screens.contains { $0.frame.intersects(frame) } }

    override func toggleFullScreen(_ sender: Any?) {
        if locksFullScreen, styleMask.contains(.fullScreen) {
            refusedToggles += 1
            return Diagnostics.note("Margin's window: leaving full screen refused (Margin is always full screen)")
        }
        super.toggleFullScreen(sender)
    }

    func setPageRect(_ rect: CGRect?, radius: CGFloat) {
        guard rect != pageRect || radius != pageRadius else { return }
        pageRect = rect
        pageRadius = radius
        onPageRectChange?(rect)
    }

    // A test's window is ordered in only off every display, whatever asks (every order call comes through here).
    private(set) var refusedOrders = 0
    override func order(_ place: NSWindow.OrderingMode, relativeTo otherWin: Int) {
        guard harness, place != .out, onADisplay else { return super.order(place, relativeTo: otherWin) }
        refusedOrders += 1
        Diagnostics.warn("harness: not ordering Margin's window in on a display (\(frame))")
    }

    // A test's window stays where it was put (AppKit keeps a titled window's title bar on a display).
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        harness ? frameRect : super.constrainFrameRect(frameRect, to: screen)
    }

    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        if harness, NSScreen.screens.contains(where: { $0.frame.intersects(frameRect) }) {
            return Diagnostics.warn("harness: not putting Margin's window on a display (\(frameRect))")
        }
        super.setFrame(frameRect, display: flag)
    }
}

// Margin's UI over its full-screen window (DECISIONS.md "Margin's UI in a panel that never makes Margin active",
// 2026-11-17): a borderless, non-activating, see-through panel exactly over MarginWindow, its child window (so it's in
// Margin's Space and moves with it), at that window's level. A press in it doesn't make Margin the active app: the
// hosted app stays active and keeps its active look. Key only while `allowKey` (a field of Margin's wants the keys:
// nothing else): a non-activating panel can be key while another app is active (Spotlight's way). Never main.
final class MarginPanel: NSPanel {
    static let behavior: NSWindow.CollectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]
    var harness = false
    var allowKey = false
    weak var base: MarginWindow?
    // Where a press moves the window (the theme's <m-drag-region>s), top left in the content.
    var dragRegions: [CGRect] = []
    // Presses that moved or zoomed the window (the tests read it), and every press Margin's UI got (a press over the
    // hole never comes here: it's the hosted app's).
    private(set) var drags = 0
    private(set) var presses = 0
    private(set) var refusedOrders = 0
    // A press in it ended (the main button let go), where (top left in its content), and its event number (the press's:
    // a release has its press's number), how a press the press tap delivered here is known (docs/SIDEBAR-PRESS.md).
    var pressEnded: ((CGPoint, Int) -> Void)?

    init(frame topLeft: CGRect, harness: Bool) {
        self.harness = harness
        super.init(contentRect: ScreenGeometry.appKitRect(topLeft), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .windowBackgroundColor
        hasShadow = false
        hidesOnDeactivate = false
        isFloatingPanel = false
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        isExcludedFromWindowsMenu = true
        animationBehavior = .none
        collectionBehavior = Self.behavior
        acceptsMouseMovedEvents = true
        ignoresMouseEvents = false
        if harness { setFrame(ScreenGeometry.appKitRect(topLeft), display: false) }
    }

    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }

    var onADisplay: Bool { NSScreen.screens.contains { $0.frame.intersects(frame) } }

    override func order(_ place: NSWindow.OrderingMode, relativeTo otherWin: Int) {
        guard harness, place != .out, onADisplay else { return super.order(place, relativeTo: otherWin) }
        refusedOrders += 1
        Diagnostics.warn("harness: not ordering Margin's panel in on a display (\(frame))")
    }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        harness ? frameRect : super.constrainFrameRect(frameRect, to: screen)
    }

    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        if harness, NSScreen.screens.contains(where: { $0.frame.intersects(frameRect) }) {
            return Diagnostics.warn("harness: not putting Margin's panel on a display (\(frameRect))")
        }
        super.setFrame(frameRect, display: flag)
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown { presses += 1 }
        if event.type == .leftMouseDown, !dragRegions.isEmpty {
            let p = event.locationInWindow
            let topLeft = CGPoint(x: p.x, y: frame.height - p.y)
            if MarginWindowGeometry.inDragRegion(topLeft, dragRegions) {
                drags += 1
                // (The window moved is the base; the panel, its child, moves with it. A test's window never moves.)
                if !harness, let base { if event.clickCount == 2 { base.zoom(nil) } else { base.performDrag(with: event) } }
                return
            }
        }
        super.sendEvent(event)
        if event.type == .leftMouseUp { pressEnded?(CGPoint(x: event.locationInWindow.x, y: frame.height - event.locationInWindow.y), event.eventNumber) }
    }
}

enum MarginWindowGeometry {
    // The content's frame from the top left (window server coordinates): the whole window, its content
    // drawn under the transparent title bar (windowed), or the whole display (full screen).
    static func content(of appKitFrame: CGRect, mainHeight: CGFloat = ScreenGeometry.mainHeight) -> CGRect {
        ScreenGeometry.appKitRect(appKitFrame, mainHeight: mainHeight)
    }

    // Whether a layout was measured at the content's present size (one from before a resize is followed by the right one).
    // (The core's: core/page/area.rs.)
    static func measuredAt(_ layout: PageLayout, _ size: CGSize) -> Bool {
        margin_page_measured_at(layout.width, layout.height, MarginRect(x: 0, y: 0, width: Double(size.width), height: Double(size.height)))
    }

    // The page area in the window server's coordinates: the content (top left) less the layout's insets.
    // Nil until the layout is one measured at the content's size, or if it leaves no area. (The core's.)
    static func pageRect(layout: PageLayout, content: CGRect) -> CGRect? {
        var out = MarginRect()
        return margin_page_rect(layout.insets, layout.width, layout.height, content.raw, &out) ? CGRect(out) : nil
    }

    // The window's three buttons (close, minimize, zoom) inside the theme's <m-window-controls> box (top left,
    // in the content): their own size and spacing, the group centred in the box, from its left when it's narrower.
    static func buttonOrigins(controls: CGRect, button: CGSize, step: CGFloat, count: Int = 3) -> [CGPoint] {
        guard count > 0, controls.width > 0, controls.height > 0 else { return [] }
        let group = step * CGFloat(count - 1) + button.width
        let x = controls.minX + max(0, (controls.width - group) / 2)
        let y = controls.midY - button.height / 2
        return (0..<count).map { CGPoint(x: (x + step * CGFloat($0)).rounded(), y: y.rounded()) }
    }

    static func inDragRegion(_ p: CGPoint, _ regions: [CGRect]) -> Bool { regions.contains { $0.contains(p) } }

    // A display's full-screen layout area (top left): its frame below the camera housing, where a full-screen
    // window (Margin's, and a hosted window's in its own Space) is laid out.
    static func fullScreenArea(_ screen: NSScreen) -> CGRect {
        var frame = screen.frame
        frame.size.height -= screen.safeAreaInsets.top
        return ScreenGeometry.appKitRect(frame)
    }
}

// ---- Margin's menu bar ----

enum MarginMenuAction: String, CaseIterable {
    case newTab = "new-tab", newWindow = "new-window", closeTab = "close-tab", toggleSidebar = "toggle-sidebar"
}

// What each of Margin's own items does: a word to the window's page, a request of its source, or a window.
enum MarginWindowEffect: Equatable {
    case page(String) // JSON pushed into the page (marginApp.receive)
    case source(String) // asked of the window's source (MarginWindowSource.perform), for the window
    case newWindow
}

extension MarginMenuAction {
    var effect: MarginWindowEffect {
        switch self {
        case .newTab: return .page(#"{"type":"command","name":"palette"}"#) // the palette, as ⌘T opens it
        case .toggleSidebar: return .page(#"{"type":"command","name":"toggle-sidebar"}"#)
        case .closeTab: return .source("closeTab")
        case .newWindow: return .newWindow
        }
    }
}

// The menu items' target: each of Margin's own items says its action (`representedObject`).
final class MarginMenuTarget: NSObject, NSMenuItemValidation {
    var handle: (MarginMenuAction) -> Void = { _ in }
    var enabled: (MarginMenuAction) -> Bool = { _ in true }

    @objc func run(_ sender: NSMenuItem) {
        guard let action = (sender.representedObject as? String).flatMap(MarginMenuAction.init(rawValue:)) else { return }
        handle(action)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let action = (item.representedObject as? String).flatMap(MarginMenuAction.init(rawValue:)) else { return true }
        return enabled(action)
    }
}

enum MarginMenu {
    // The whole menu bar: Margin's app menu, File, Edit (a field of the UI needs its keys), View, Window.
    // `fullScreenItem`: View › Enter Full Screen (⌃⌘F); none while Margin is always full screen.
    static func build(target: MarginMenuTarget, appName: String = "Margin", fullScreenItem: Bool = true) -> NSMenu {
        let bar = NSMenu(title: "Main Menu")
        func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            for item in items { m.addItem(item) }
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = m
            bar.addItem(top)
            return m
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        func own(_ title: String, _ action: MarginMenuAction, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = item(title, #selector(MarginMenuTarget.run(_:)), key, mods)
            i.target = target
            i.representedObject = action.rawValue
            return i
        }
        _ = menu(appName, [
            item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = menu("File", [
            own("New Tab", .newTab, "t"),
            own("New Window", .newWindow, "n"),
            .separator(),
            own("Close Tab", .closeTab, "w"),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w", [.command, .shift]),
        ])
        _ = menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        // (AppKit titles it Enter or Exit Full Screen as the key window is.)
        _ = menu("View", [own("Toggle Sidebar", .toggleSidebar, "s", [.command, .control])]
                 + (fullScreenItem ? [.separator(), item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])] : []))
        let window = menu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        window.identifier = NSUserInterfaceItemIdentifier("margin.window-menu")
        return bar
    }

    // Margin's own item for an action (the tests, and the windows' check of what's enabled).
    static func item(_ action: MarginMenuAction, in bar: NSMenu) -> NSMenuItem? {
        for top in bar.items {
            if let found = top.submenu?.items.first(where: { $0.representedObject as? String == action.rawValue }) { return found }
        }
        return nil
    }
}

// What a hosted app's see-through parts show (Tirth, 2026-11-19: Notes', Weather's and WhatsApp's glass sidebars showed
// the yellow wallpaper macOS draws behind every window of a full-screen Space, its WindowManager's backdrop; "plain grey,
// like macOS"): a window of Margin's own behind them, opaque in the system's window background colour (light or dark as
// the Mac is), at the display's frame, below every normal window and above that backdrop. Margin's window's child, as
// its panel is, so it's in Margin's Space with it and moves with it; it takes no mouse, never the keys, isn't in the
// window cycle or the Window menu, and draws nothing of its own.
final class MarginBackdrop: NSWindow {
    // Above the backdrop macOS draws (WindowManager's, at about -2^31) and the desktop's icons' level, below every
    // normal window (a hosted app's are at 0).
    static let level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)

    // `frame`: AppKit's (bottom left), its parent's.
    init(frame: NSRect) {
        super.init(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: true)
        isReleasedWhenClosed = false
        isOpaque = true
        backgroundColor = .windowBackgroundColor
        hasShadow = false
        ignoresMouseEvents = true
        isExcludedFromWindowsMenu = true
        animationBehavior = .none
        collectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]
        level = Self.level
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    // The whole display, not only Margin's window (its full-screen area starts below the menu bar's band, 33 pt on Tirth's
    // display): a hosted app's toolbar reaches up into that band (Safari's at -11), under the see-through menu bar, and
    // its glass showed the wallpaper there (2026-11-19, the second look). A window with no display (a test's): its frame.
    static func frame(window: NSRect, screen: NSRect?) -> NSRect { screen ?? window }

    // Its layer as the window server has it now; nil: unread (not ordered in).
    var serverLayer: Int? { windowNumber > 0 ? MarginWindowController.serverLayer(windowNumber) : nil }
}

// The window's ground, with the page area cut out of it (MarginWindowController: Margin's window is in front of what it
// hosts, DECISIONS.md "Margin's window in front of what it hosts"). While a hosted window is shown, the window's own
// background is clear and this view, under the web view, fills the ground everywhere but that window's bounds (`hole`,
// top left in the content, rounded where it meets the page card's corners): the hosted window shows through the theme's
// see-through page slot, the theme draws its frame and the card's corners over it, and whatever the theme leaves
// see-through outside the hole is the ground, never the Space's backdrop. One shape layer, drawn when it changes;
// hidden, with nothing drawn, while nothing shows through (the window's own background fills it then).
final class WindowGroundView: NSView {
    private(set) var color: NSColor?
    private(set) var hole: CGRect?
    private(set) var radii: [CGFloat] = []
    private(set) var draws = 0 // how many times it was drawn (the tests read it)
    private let shape = CAShapeLayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = .clear
        shape.fillRule = .evenOdd
        shape.actions = ["path": NSNull(), "fillColor": NSNull(), "bounds": NSNull(), "position": NSNull()]
        layer?.addSublayer(shape)
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil } // (under the web view: never the one that takes an event)

    var isShown: Bool { !isHidden }

    // `radii`: the hole's corners (top-left, top-right, bottom-right, bottom-left), none where it's square.
    func show(color: NSColor, hole: CGRect, radii: [CGFloat]) {
        guard isHidden || color != self.color || hole != self.hole || radii != self.radii || !extras.isEmpty else { return }
        self.color = color
        self.hole = hole
        self.radii = radii
        extras = []
        isHidden = false
        draw()
    }

    // Several visible hosts (docs/PEEK-SPLIT.md §1): every one's hole, each with its corners (rounded only where they
    // meet the page card's); the first is `hole`, the others `extras`.
    struct Hole: Equatable { var rect: CGRect; var radii: [CGFloat] }
    private(set) var extras: [Hole] = []
    func show(color: NSColor, holes: [Hole]) {
        guard let first = holes.first else { return clear() }
        let rest = Array(holes.dropFirst())
        guard isHidden || color != self.color || first.rect != hole || first.radii != radii || rest != extras else { return }
        self.color = color
        hole = first.rect
        radii = first.radii
        extras = rest
        isHidden = false
        draw()
    }

    func clear() {
        guard !isHidden else { return }
        isHidden = true
        color = nil
        hole = nil
        radii = []
        extras = []
        shape.path = nil
    }

    override func layout() {
        super.layout()
        if !isHidden { draw() }
    }

    // The hole's outline from the top left (y down), each corner its own radius.
    static func outline(_ rect: CGRect, radii: [CGFloat]) -> CGPath {
        let limit = min(rect.width, rect.height) / 2
        let r = (0..<4).map { i in min(max(0, i < radii.count ? radii[i] : 0), limit) }
        let p = CGMutablePath()
        p.move(to: CGPoint(x: rect.minX + r[0], y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r[1], y: rect.minY))
        if r[1] > 0 { p.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY + r[1]), radius: r[1]) }
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r[2]))
        if r[2] > 0 { p.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX - r[2], y: rect.maxY), radius: r[2]) }
        p.addLine(to: CGPoint(x: rect.minX + r[3], y: rect.maxY))
        if r[3] > 0 { p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY - r[3]), radius: r[3]) }
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r[0]))
        if r[0] > 0 { p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY), tangent2End: CGPoint(x: rect.minX + r[0], y: rect.minY), radius: r[0]) }
        p.closeSubpath()
        return p
    }

    // The whole view filled, less the hole (even-odd): the hole from the top left, the layer's own y from the bottom.
    private func draw() {
        shape.frame = bounds
        let path = CGMutablePath()
        path.addRect(bounds)
        if let hole = hole?.intersection(bounds), !hole.isNull, hole.width > 0, hole.height > 0 {
            var flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: bounds.height)
            if let outline = Self.outline(hole, radii: hole == self.hole ? radii : []).copy(using: &flip) { path.addPath(outline) }
        }
        for e in extras {
            let r = e.rect.intersection(bounds)
            guard !r.isNull, r.width > 0, r.height > 0 else { continue }
            var flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: bounds.height)
            if let outline = Self.outline(r, radii: r == e.rect ? e.radii : []).copy(using: &flip) { path.addPath(outline) }
        }
        shape.path = path
        // (Resolved for the window's appearance: a dynamic colour's cgColor is the current appearance's.)
        var resolved = color?.cgColor
        (window?.effectiveAppearance ?? effectiveAppearance).performAsCurrentDrawingAppearance { resolved = color?.cgColor }
        shape.fillColor = resolved
        draws += 1
    }

    // Whether a point of the content (top left) is the ground's (the tests read it).
    func fills(_ p: CGPoint) -> Bool {
        guard !isHidden, bounds.contains(p) else { return false }
        guard let hole else { return true }
        if extras.contains(where: { Self.outline($0.rect, radii: $0.radii).contains(p) }) { return false }
        return !Self.outline(hole, radii: radii).contains(p)
    }
}

// The blurs behind a split's folded panes' cards (docs/FLEX-SPLIT.md step 1): one behind-window material per rect (the
// core's `margin_page_blurs`, from the top left of the content), in the ground's holes and under the web view, so the
// hosted app's window shows through blurred and the theme's card is drawn over it. The window server draws the blur:
// no permission, nothing private, nothing done per frame here but a frame set.
final class WindowBlurView: NSView {
    private(set) var rects: [CGRect] = []
    private var views: [NSVisualEffectView] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = .clear
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true } // (the rects from the top left)
    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil } // (under the web view: never the one that takes an event)

    // How many blurs are shown, and where (the tests read it).
    var shown: [CGRect] { zip(views, rects).filter { !$0.0.isHidden }.map(\.1) }

    func show(_ list: [CGRect]) {
        guard list != rects else { return }
        rects = list
        while views.count < list.count {
            let v = NSVisualEffectView(frame: .zero)
            v.blendingMode = .behindWindow
            v.material = .fullScreenUI
            v.state = .active
            addSubview(v)
            views.append(v)
        }
        for (i, v) in views.enumerated() {
            if i < list.count {
                if v.frame != list[i] { v.frame = list[i] }
                if v.isHidden { v.isHidden = false }
            } else if !v.isHidden {
                v.isHidden = true
            }
        }
    }
}

// The colours the page says it draws around the page card's corners (host-app.ts cornerFill, reported with the layout
// as `fills`): the ground under the page area is the colour most of them have (the theme's frame). The rules are the
// core's (core/page/fill.rs); here the colours as AppKit's.
enum PageFill {
    // The colour most of the corners have (the theme's frame; a sharp shadow at one corner aside), the first on a tie.
    static func common(_ colors: [NSColor]) -> NSColor? {
        let list = colors.map { c -> MarginRgba in
            let s = c.usingColorSpace(.sRGB) ?? c
            return MarginRgba(r: Double(s.redComponent), g: Double(s.greenComponent), b: Double(s.blueComponent), a: Double(s.alphaComponent))
        }
        var out = MarginRgba()
        guard list.withUnsafeBufferPointer({ margin_page_fill_common($0.baseAddress, $0.count, &out) }) else { return nil }
        return colors[list.firstIndex { $0.r == out.r && $0.g == out.g && $0.b == out.b && $0.a == out.a } ?? 0]
    }

    // A CSS colour as the page computes it ("rgb(r, g, b)", "rgba(r, g, b, a)", or "color(srgb r g b / a)"); nil: none
    // read (or see-through).
    static func color(_ css: String) -> NSColor? {
        var out = MarginRgba()
        return withText(css) { t, n, _ in margin_page_fill_color(t, n, &out) } ? NSColor(out) : nil
    }
}

// Margin's window in front of what it hosts (decided 2026-11-17): how it's kept there. `level`: a window level one
// above normal (below floating: a hosted app's panels, pop-up menus and tooltips still come above it), which the window
// server holds whatever app is active or clicked. `order`: at the normal level, ordered right above the hosted window
// and ordered there again whenever something could have raised that window (an app activated, a press); the way the
// overlay over a browser's window was kept (v0.1.0), for a Mac whose full-screen window doesn't hold a raised level.
enum FrontMechanism: String {
    case level, order
    static let key = "MarginFront" // (UserDefaults: `level` or `order`; unset: level, order if the server doesn't hold it)
    static let raised = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue + 1)
}
