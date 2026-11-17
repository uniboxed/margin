// Margin's own window (docs/MARGIN-APP.md, phase 2): a regular app window,
// windowed or full screen (its own Space), with Margin's UI drawn edge to edge
// under a transparent title bar. It's opaque, its corners rounded as macOS
// draws a window's: a hosted window is never behind it but above it, a member
// of its full-screen Space in its page area (HostedSession.swift), so nothing
// shows through and nothing passes through; with nothing hosted, its page area
// is the theme's launcher (ui/host-app.ts). It's always full screen
// (`locksFullScreen`: AppKit's toggle refused once it's in).
//
// - MarginWindow: the NSWindow. `pageRect` is the page area in the window
//   server's coordinates (top left, points), published with `onPageRectChange`
//   by its controller (MarginWindowController.swift) from the UI's own layout
//   report (`<m-page>`, ui/render.ts measure()) and the window's frame. A press
//   in a theme's drag region (`<m-drag-region>`) moves the window, a double
//   press zooms it; its buttons go where the theme draws `<m-window-controls>`.
// - MarginWindowGeometry: the arithmetic, on its own (tests/margin-window-tests.swift).
// - MarginMenu: Margin's menu bar in this mode (its menu items, no global hot keys).
//
// In the tests (`harness`) the window is never on a display: AppKit makes a
// titled window asked for off every display on the main one (seen 2026-11-15),
// so it's put back where it was asked for at once; it's ordered in only while
// its frame is off every display (as the overlays' tests' panels are), a frame
// that touches one is refused, AppKit never moves it onto one, nothing is made
// key.

import AppKit

final class MarginWindow: NSWindow {
    static let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
    static let minimum = NSSize(width: 640, height: 420)

    var harness = false
    // The page area, top left, in points (nil: not measured at this size yet).
    private(set) var pageRect: CGRect?
    private(set) var pageRadius: CGFloat = 0
    var onPageRectChange: ((CGRect?) -> Void)?
    // Where a press moves the window (the theme's <m-drag-region>s), top left in the content.
    var dragRegions: [CGRect] = []
    // Presses that moved or zoomed the window (the tests read it).
    private(set) var drags = 0
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
        // (Not opaque to AppKit, so its corners stay rounded; filled, so no edge of it is ever see-through. Seen
        // 2026-11-15: a clear background showed the Desktop through its page area and edges at the first open.)
        isOpaque = false
        backgroundColor = .windowBackgroundColor
        hasShadow = true
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

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown, !dragRegions.isEmpty {
            let p = event.locationInWindow
            let topLeft = CGPoint(x: p.x, y: frame.height - p.y)
            if MarginWindowGeometry.inDragRegion(topLeft, dragRegions) {
                drags += 1
                // (A test's window never moves: zoomed or dragged, it would land on a display.)
                if !harness { if event.clickCount == 2 { zoom(nil) } else { performDrag(with: event) } }
                return
            }
        }
        super.sendEvent(event)
    }
}

enum MarginWindowGeometry {
    // The content's frame from the top left (window server coordinates): the whole window, its content
    // drawn under the transparent title bar (windowed), or the whole display (full screen).
    static func content(of appKitFrame: CGRect, mainHeight: CGFloat = ScreenGeometry.mainHeight) -> CGRect {
        ScreenGeometry.appKitRect(appKitFrame, mainHeight: mainHeight)
    }

    // Whether a layout was measured at the content's present size (one from before a resize is followed by the right one).
    static func measuredAt(_ layout: PageLayout, _ size: CGSize) -> Bool {
        abs(layout.width - size.width) < 1 && abs(layout.height - size.height) < 1
    }

    // The page area in the window server's coordinates: the content (top left) less the layout's insets.
    // Nil until the layout is one measured at the content's size, or if it leaves no area.
    static func pageRect(layout: PageLayout, content: CGRect) -> CGRect? {
        guard measuredAt(layout, content.size) else { return nil }
        let rect = PassThrough.slot(in: content, layout: layout).rect
        return rect.width > 0 && rect.height > 0 ? rect : nil
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

// The page card's rounded corners over a hosted window (HostedSession.swift: the hosted window is above Margin's, its
// corners square, so it covered the card's rounded corners and whatever the theme draws around them). One small panel
// per rounded corner, the corner's square only (the page's inner radius: `<m-page>`'s content box, ui/render.ts
// measure), drawing what the theme draws there outside the rounded curve: the card's border in the band between the
// page area's curve and the card's outer edge (same centre), and that corner's colour outside the card beyond it
// (host-app.ts cornerFill: the theme's frame, or a sharp shadow painted there), see-through inside the curve, so the
// hosted window shows. Borderless, transparent, non-activating, never taking the mouse (everything passes through),
// above normal windows so it stays above the hosted window when its app is active, below menus, the menu bar and the
// Dock; joined to Margin's Space only (ordered in only while that Space is current: MarginWindowController.placeCorners),
// hidden in Mission Control and never in the window cycle. Drawn once per change of the page area, its radii or its
// colours (shape layers: nothing redraws per frame). Checked against each built-in theme's own pixels in
// tests/theme/corners.test.ts.
final class HostCorners {
    struct Edge: Equatable {
        var width: CGFloat
        var color: NSColor
    }
    static let level = NSWindow.Level.floating
    static let behavior: NSWindow.CollectionBehavior = [.transient, .fullScreenAuxiliary, .ignoresCycle]
    static let fallback = NSColor.windowBackgroundColor
    let harness: Bool
    private(set) var panels: [NSPanel] = []
    private(set) var placed: (page: CGRect, radii: [CGFloat], fills: [NSColor], edge: Edge?)?
    private(set) var isShown = false
    private(set) var draws = 0 // how many times the corners were drawn (the tests read it)

    init(harness: Bool) { self.harness = harness }

    // The corners' squares (top left, points), the corner each is (0 top left, clockwise), and its radius, for a page
    // area and its radii (top-left, top-right, bottom-right, bottom-left). A radius under 1: none there.
    static func squares(page: CGRect, radii: [CGFloat]) -> [(rect: CGRect, corner: Int, radius: CGFloat)] {
        let r = radii.count == 4 ? radii : [CGFloat](repeating: radii.first ?? 0, count: 4)
        let limit = min(page.width, page.height) / 2
        var out: [(CGRect, Int, CGFloat)] = []
        for corner in 0..<4 {
            let radius = min(max(0, r[corner]), limit)
            let side = radius.rounded(.up)
            guard radius >= 1 else { continue }
            let x = corner == 0 || corner == 3 ? page.minX : page.maxX - side
            let y = corner == 0 || corner == 1 ? page.minY : page.maxY - side
            out.append((CGRect(x: x, y: y, width: side, height: side), corner, radius))
        }
        return out
    }

    // Each corner panel's frame in AppKit's coordinates (bottom left, y up: what NSWindow.setFrame takes), from the
    // squares above (top left), with its corner and radius.
    static func panelFrames(page: CGRect, radii: [CGFloat], mainHeight: CGFloat = ScreenGeometry.mainHeight) -> [(frame: CGRect, corner: Int, radius: CGFloat)] {
        squares(page: page, radii: radii).map { (ScreenGeometry.appKitRect($0.rect, mainHeight: mainHeight), $0.corner, $0.radius) }
    }

    // A circle of `r` round the curve's centre (`radius` in from the page's corner) in a corner's square (AppKit's
    // bottom-left coordinates, y up).
    private static func circle(size: CGFloat, radius: CGFloat, corner: Int, r: CGFloat) -> CGRect {
        let cx: CGFloat = corner == 0 || corner == 3 ? radius : size - radius
        let cy: CGFloat = corner == 0 || corner == 1 ? size - radius : radius
        return CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
    }

    // A corner's mask outside the card (filled even-odd, clipped to its square): the square less the card's outer curve
    // (the page area's curve grown by the border, `out`).
    static func path(size: CGFloat, radius: CGFloat, corner: Int, out: CGFloat = 0) -> CGPath {
        let p = CGMutablePath()
        p.addRect(CGRect(x: 0, y: 0, width: size, height: size))
        p.addEllipse(in: circle(size: size, radius: radius, corner: corner, r: radius + out))
        return p
    }

    // The border's band in a corner's square (filled even-odd): between the page area's curve and the card's outer one.
    static func band(size: CGFloat, radius: CGFloat, corner: Int, width: CGFloat) -> CGPath {
        let p = CGMutablePath()
        p.addEllipse(in: circle(size: size, radius: radius, corner: corner, r: radius + width))
        p.addEllipse(in: circle(size: size, radius: radius, corner: corner, r: radius))
        return p
    }

    // Shown as these say already.
    func shows(page: CGRect, radii: [CGFloat], fills: [NSColor], edge: Edge?) -> Bool {
        guard isShown, let placed else { return false }
        return placed.page == page && placed.radii == radii && placed.fills == fills && placed.edge == edge
    }

    private(set) var reorders = 0 // panels ordered in again (not shown, or in another Space) though nothing changed (the tests read it)

    func show(page: CGRect, radii: [CGFloat], fills: [NSColor], edge: Edge?) {
        if shows(page: page, radii: radii, fills: fills, edge: edge) {
            // (Nothing to draw again, but each still shown, in the current Space: one ordered in while another Space was
            // current, during a first open's jump, joined that Space and went with it; it joins this one again.)
            for panel in panels.prefix(Self.squares(page: page, radii: radii).count) where !panel.isVisible || !panel.isOnActiveSpace {
                if harness, NSScreen.screens.contains(where: { $0.frame.intersects(panel.frame) }) { continue }
                panel.orderOut(nil)
                panel.orderFrontRegardless()
                reorders += 1
            }
            return
        }
        let squares = Self.panelFrames(page: page, radii: radii)
        placed = (page, radii, fills, edge)
        while panels.count < squares.count { panels.append(Self.panel()) }
        for (i, panel) in panels.enumerated() {
            guard i < squares.count else { panel.orderOut(nil); continue }
            let (frame, corner, radius) = squares[i]
            let rect = CGRect(origin: .zero, size: frame.size)
            panel.setFrame(frame, display: false)
            guard let root = panel.contentView?.layer, let layers = root.sublayers as? [CAShapeLayer], layers.count == 2 else { continue }
            let fill = corner < fills.count ? fills[corner] : Self.fallback
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            for layer in layers { layer.frame = CGRect(origin: .zero, size: frame.size) }
            layers[0].fillColor = fill.cgColor
            layers[0].path = Self.path(size: rect.width, radius: radius, corner: corner, out: edge?.width ?? 0)
            layers[1].fillColor = edge?.color.cgColor
            layers[1].path = edge.map { Self.band(size: rect.width, radius: radius, corner: corner, width: $0.width) }
            CATransaction.commit()
            // (A test's never on a display: ordered in only off every display.)
            if !harness || !NSScreen.screens.contains(where: { $0.frame.intersects(frame) }) { panel.orderFrontRegardless() }
        }
        draws += 1
        isShown = !squares.isEmpty
    }

    func hide() {
        guard isShown || placed != nil else { return }
        for panel in panels { panel.orderOut(nil) }
        isShown = false
        placed = nil
    }

    // The frames shown now (top left), in corner order (the tests read them).
    var frames: [CGRect] { isShown ? panels.prefix(Self.squares(page: placed?.page ?? .zero, radii: placed?.radii ?? []).count).map { ScreenGeometry.appKitRect($0.frame) } : [] }

    private static func panel() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(x: -30000, y: -30000, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.becomesKeyOnlyIfNeeded = true
        p.level = level
        p.collectionBehavior = behavior
        p.animationBehavior = .none
        p.isExcludedFromWindowsMenu = true
        let v = NSView(frame: .zero)
        v.layer = CALayer() // (its own layer, hosting the two below)
        v.wantsLayer = true
        v.layer?.backgroundColor = .clear
        for _ in 0..<2 { // outside the card; its border's band
            let layer = CAShapeLayer()
            layer.fillRule = .evenOdd
            layer.masksToBounds = true
            v.layer?.addSublayer(layer)
        }
        p.contentView = v
        return p
    }

    // The colour most of the corners have (the theme's frame; a sharp shadow at one corner aside), the first on a tie.
    static func common(_ colors: [NSColor]) -> NSColor? {
        let counts = colors.map { c in colors.filter { $0 == c }.count }
        guard let top = counts.max(), let i = counts.firstIndex(of: top) else { return nil }
        return colors[i]
    }

    // A CSS colour as the page computes it ("rgb(r, g, b)", "rgba(r, g, b, a)", or "color(srgb r g b / a)"); nil: none
    // read (or see-through).
    static func color(_ css: String) -> NSColor? {
        let s = css.trimmingCharacters(in: .whitespaces).lowercased()
        func numbers(_ inner: Substring) -> [Double] {
            inner.split(whereSeparator: { ", /".contains($0) }).compactMap { part -> Double? in
                if part.hasSuffix("%") { return Double(part.dropLast()).map { $0 / 100 } }
                return Double(part)
            }
        }
        var rgba: [Double] = []
        if (s.hasPrefix("rgb(") || s.hasPrefix("rgba(")), let open = s.firstIndex(of: "("), s.hasSuffix(")") {
            let n = numbers(s[s.index(after: open)..<s.index(before: s.endIndex)])
            guard n.count >= 3 else { return nil }
            rgba = [n[0] / 255, n[1] / 255, n[2] / 255, n.count > 3 ? n[3] : 1]
        } else if s.hasPrefix("color(srgb "), s.hasSuffix(")") {
            let n = numbers(s.dropFirst("color(srgb ".count).dropLast())
            guard n.count >= 3 else { return nil }
            rgba = [n[0], n[1], n[2], n.count > 3 ? n[3] : 1]
        } else {
            return nil
        }
        guard rgba.allSatisfy({ $0.isFinite }), rgba[3] > 0 else { return nil }
        return NSColor(srgbRed: min(1, max(0, rgba[0])), green: min(1, max(0, rgba[1])), blue: min(1, max(0, rgba[2])), alpha: min(1, max(0, rgba[3])))
    }
}
