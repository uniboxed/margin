// Margin's own window (docs/MARGIN-APP.md, phase 2): a regular app window,
// windowed or full screen (its own Space), with Margin's UI drawn edge to edge
// under a transparent title bar. It's opaque, its corners rounded as macOS
// draws a window's: a hosted window is never behind it but above it, a member
// of its full-screen Space in its page area (HostedSession.swift), so nothing
// shows through and nothing passes through; with nothing hosted, its page area
// is the theme's launcher (ui/host-app.ts). Behind `MarginHosted` (off: none
// of this runs; Shell.forApp). While hosting is on it's always full screen
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
        case .newTab: return .page(#"{"type":"command","name":"palette"}"#) // the palette, as ⌘T over a browser opens it
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

// The loading animation over the page area while a host's first open or placing again runs: a spinner and "Opening
// <name>…", centred, drawn natively (the hosted window isn't there yet, and a press goes through to the page).
final class HostLoadingView: NSView {
    private let spinner = NSProgressIndicator()
    private let label = NSTextField(labelWithString: "")
    private(set) var text = ""

    override init(frame: NSRect) {
        super.init(frame: frame)
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isDisplayedWhenStopped = false
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.alignment = .center
        addSubview(spinner)
        addSubview(label)
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        let size = spinner.fittingSize
        spinner.frame = NSRect(x: (bounds.width - size.width) / 2, y: bounds.midY + 4, width: size.width, height: size.height)
        label.frame = NSRect(x: 8, y: bounds.midY - 26, width: max(0, bounds.width - 16), height: 20)
    }

    func show(_ name: String) {
        text = "Opening \(name)…"
        label.stringValue = text
        isHidden = false
        spinner.startAnimation(nil)
        needsLayout = true
    }

    func hide() {
        guard !isHidden else { return }
        isHidden = true
        spinner.stopAnimation(nil)
    }
}
