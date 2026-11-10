// Margin's own prompt on ⌘Q in a browser window Margin draws around (asked 2026-11-07, after Arc's: "Are you sure
// you want to quit? … Always quit, Cancel, Quit"). Shown centred on the front window, over Margin's layout; the
// browser stays the active app (a panel that takes the keys without activating Margin, as the overlay's palette).
//
// Return (or ⌘Q again) quits, Escape cancels, "Always quit" quits and stops asking (Shell.quitBrowser then closes
// Margin's parked windows and hands the keys on to the browser). Clicking anywhere else cancels: it's never left up.
// Only numbers and Margin's own words: no title, no address.

import AppKit

enum QuitChoice: Equatable { case quit, always, cancel }

final class QuitPrompt: NSPanel {
    var onChoice: ((QuitChoice) -> Void)?
    private var chosen = false

    static let size = NSSize(width: 460, height: 236)

    /// What a key does while it's up (nil: nothing). Return quits, Escape cancels, ⌘Q quits.
    static func choice(keyCode: UInt16, command: Bool) -> QuitChoice? {
        switch keyCode {
        case 36, 76: return .quit // Return, Enter
        case 53: return .cancel // Escape
        case 12 where command: return .quit // ⌘Q again
        default: return nil
        }
    }

    init(browser: String) {
        super.init(contentRect: NSRect(origin: .zero, size: Self.size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .modalPanel
        animationBehavior = .none
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        contentView = QuitPromptView(browser: browser) { [weak self] choice in self?.choose(choice) }
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Shown centred on a window (`window`: top-left origin, the window server's bounds), with the keys.
    func show(over window: CGRect) {
        let frame = ScreenGeometry.appKitRect(CGRect(x: window.midX - Self.size.width / 2, y: window.midY - Self.size.height / 2 - 40,
                                                     width: Self.size.width, height: Self.size.height))
        setFrame(frame, display: true)
        makeKeyAndOrderFront(nil)
    }

    func choose(_ choice: QuitChoice) {
        guard !chosen else { return }
        chosen = true
        orderOut(nil)
        onChoice?(choice)
    }

    override func keyDown(with event: NSEvent) {
        if let c = Self.choice(keyCode: event.keyCode, command: event.modifierFlags.contains(.command)) { choose(c) } else { super.keyDown(with: event) }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let c = Self.choice(keyCode: event.keyCode, command: event.modifierFlags.contains(.command)) { choose(c); return true }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) { choose(.cancel) }

    // Clicked away (the browser's window, another app): cancelled, never left up.
    override func resignKey() {
        super.resignKey()
        if !chosen { choose(.cancel) }
    }
}

// The prompt's look: a dark rounded card, Margin's icon, the question, and three buttons (as Arc's).
final class QuitPromptView: NSView {
    private let pick: (QuitChoice) -> Void
    private(set) var buttons: [PromptButton] = []

    init(browser: String, pick: @escaping (QuitChoice) -> Void) {
        self.pick = pick
        super.init(frame: NSRect(origin: .zero, size: QuitPrompt.size))
        wantsLayer = true
        layer?.cornerRadius = 18
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor(calibratedWhite: 0.11, alpha: 0.97).cgColor
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(calibratedWhite: 1, alpha: 0.10).cgColor
        appearance = NSAppearance(named: .darkAqua)

        let icon = NSImageView(image: NSApp.applicationIconImage ?? NSImage())
        icon.frame = NSRect(x: 28, y: QuitPrompt.size.height - 28 - 48, width: 48, height: 48)
        addSubview(icon)

        let title = NSTextField(labelWithString: "Are you sure you want to quit \(browser)?")
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        title.textColor = .white
        title.frame = NSRect(x: 28, y: 110, width: QuitPrompt.size.width - 56, height: 28)
        addSubview(title)

        let note = NSTextField(labelWithString: "You may lose unsaved work in your tabs.")
        note.font = .systemFont(ofSize: 13)
        note.textColor = NSColor(calibratedWhite: 1, alpha: 0.72)
        note.frame = NSRect(x: 28, y: 86, width: QuitPrompt.size.width - 56, height: 18)
        addSubview(note)

        let always = PromptButton(title: "Always quit", badge: nil, style: .plain) { pick(.always) }
        let cancel = PromptButton(title: "Cancel", badge: "esc", style: .plain) { pick(.cancel) }
        let quit = PromptButton(title: "Quit", badge: "↩", style: .destructive) { pick(.quit) }
        let y: CGFloat = 24, h: CGFloat = 36
        always.frame = NSRect(x: 28, y: y, width: always.fittingWidth, height: h)
        quit.frame = NSRect(x: QuitPrompt.size.width - 28 - quit.fittingWidth, y: y, width: quit.fittingWidth, height: h)
        cancel.frame = NSRect(x: quit.frame.minX - 10 - cancel.fittingWidth, y: y, width: cancel.fittingWidth, height: h)
        for b in [always, cancel, quit] { addSubview(b) }
        buttons = [always, cancel, quit]
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

// One of the prompt's buttons: a rounded pill, its title and a key badge, pressed on mouse up inside.
final class PromptButton: NSView {
    enum Style { case plain, destructive }
    let title: String
    private let badge: String?
    private let style: Style
    private let action: () -> Void
    private var pressed = false { didSet { needsDisplay = true } }
    private var hovered = false { didSet { needsDisplay = true } }

    init(title: String, badge: String?, style: Style, action: @escaping () -> Void) {
        self.title = title
        self.badge = badge
        self.style = style
        self.action = action
        super.init(frame: .zero)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var titleAttrs: [NSAttributedString.Key: Any] { [.font: NSFont.systemFont(ofSize: 14, weight: .medium), .foregroundColor: NSColor.white] }
    private var badgeAttrs: [NSAttributedString.Key: Any] { [.font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: NSColor(calibratedWhite: 1, alpha: 0.75)] }

    var fittingWidth: CGFloat {
        let t = (title as NSString).size(withAttributes: titleAttrs).width
        let b = badge.map { ($0 as NSString).size(withAttributes: badgeAttrs).width + 16 } ?? 0
        return ceil(t + 36 + (badge == nil ? 0 : b + 8))
    }

    override func draw(_ dirtyRect: NSRect) {
        let base: NSColor = style == .destructive ? NSColor(calibratedRed: 0.82, green: 0.18, blue: 0.16, alpha: 1) : NSColor(calibratedWhite: 1, alpha: 0.10)
        let fill = pressed ? base.blended(withFraction: 0.2, of: .black) ?? base : hovered ? base.blended(withFraction: 0.12, of: .white) ?? base : base
        fill.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9).fill()
        let t = (title as NSString).size(withAttributes: titleAttrs)
        var x: CGFloat = 18
        (title as NSString).draw(at: NSPoint(x: x, y: (bounds.height - t.height) / 2), withAttributes: titleAttrs)
        x += t.width + 8
        if let badge {
            let b = (badge as NSString).size(withAttributes: badgeAttrs)
            let pill = NSRect(x: x, y: (bounds.height - 18) / 2, width: b.width + 12, height: 18)
            NSColor(calibratedWhite: 1, alpha: 0.12).setStroke()
            let path = NSBezierPath(roundedRect: pill, xRadius: 5, yRadius: 5)
            path.lineWidth = 1
            path.stroke()
            (badge as NSString).draw(at: NSPoint(x: pill.minX + 6, y: pill.midY - b.height / 2), withAttributes: badgeAttrs)
        }
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false; pressed = false }
    override func mouseDown(with event: NSEvent) { pressed = true }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        pressed = false
        if inside { action() }
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// Pressed as a click would (tests, accessibility).
    func press() { action() }
    override func accessibilityPerformPress() -> Bool { action(); return true }
}
