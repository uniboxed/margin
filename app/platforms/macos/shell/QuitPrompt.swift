// Margin's own prompt on ⌘Q (asked 2026-11-07, after Arc's: "Are you sure you want to quit? … Always quit, Cancel,
// Quit"; for Margin as the app since 2026-11-17: ShellQuit.swift says when it comes up and what each choice does).
// Shown centred on Margin's window, above whatever is hosted there: a panel above normal and floating windows (a
// hosted full-screen member, a window-mode app's window, Margin's own window in front of them), joining the Space that's
// current (Margin's full-screen one) without changing it, never in the window cycle. It
// takes the keys without activating Margin, so a hosted app in front stays the active app.
//
// Return (or ⌘Q again) quits, Escape cancels, "Always quit" quits and stops asking. Clicking anywhere else cancels
// (it loses the keys; and, should it never have got them, any press outside it is heard by its own monitors, which
// need no permission): it's never left up. Its look follows the Mac's light or dark appearance (nothing forced:
// QuitPromptStyle).
// Only numbers and Margin's own words: no title, no address, no app's name (QuitSummary).
//
// In the tests (`harness`) it's never ordered in and never takes the keys (a panel like this would take them from the
// person's own front app): only its state and its buttons are there.

import AppKit

// Quit, Always quit, Cancel (its own key or button, or a press in one of Margin's windows: the keys go back where they
// were), or `left`: cancelled because something else took the keys or the front (a press in another app's window, another
// app in front, the prompt's key taken). Nothing is given back then: whatever took the keys has them, and giving them to
// the hosted app activated it, which brought Margin's Space back over the Space the person had swiped to (2026-11-25).
enum QuitChoice: Equatable { case quit, always, cancel, left }

// The prompt's colours, each for light and dark, resolved by the appearance it's drawn in.
enum QuitPromptStyle {
    static func dynamic(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light }
    }
    static let card = dynamic(light: NSColor(calibratedWhite: 0.98, alpha: 0.98), dark: NSColor(calibratedWhite: 0.11, alpha: 0.97))
    static let border = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.14), dark: NSColor(calibratedWhite: 1, alpha: 0.10))
    static let plainButton = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.07), dark: NSColor(calibratedWhite: 1, alpha: 0.10))
    static let badgeStroke = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.20), dark: NSColor(calibratedWhite: 1, alpha: 0.14))
    static let destructiveButton = NSColor(calibratedRed: 0.82, green: 0.18, blue: 0.16, alpha: 1)

    // A colour as it's drawn in light or dark (the tests read it).
    static func resolved(_ color: NSColor, dark: Bool) -> NSColor {
        var out = color
        NSAppearance(named: dark ? .darkAqua : .aqua)?.performAsCurrentDrawingAppearance {
            out = color.usingColorSpace(.deviceRGB) ?? color
        }
        return out
    }
}

final class QuitPrompt: NSPanel {
    var onChoice: ((QuitChoice) -> Void)?
    private var chosen = false
    private let harness: Bool
    private(set) var isUp = false

    static let width: CGFloat = 460
    static let level = NSWindow.Level.modalPanel
    static let behavior: NSWindow.CollectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]

    /// What a key does while it's up (nil: nothing). Return quits, Escape cancels, ⌘Q quits.
    static func choice(keyCode: UInt16, command: Bool) -> QuitChoice? {
        switch keyCode {
        case 36, 76: return .quit // Return, Enter
        case 53: return .cancel // Escape
        case 12 where command: return .quit // ⌘Q again
        default: return nil
        }
    }

    init(note: String, harness: Bool = false) {
        self.harness = harness
        let view = QuitPromptView(note: note)
        super.init(contentRect: NSRect(origin: harness ? CGPoint(x: -30000, y: -30000) : .zero, size: view.frame.size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = Self.level
        animationBehavior = .none
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = Self.behavior
        isExcludedFromWindowsMenu = true
        view.pick = { [weak self] choice in self?.choose(choice) }
        contentView = view
    }

    var view: QuitPromptView? { contentView as? QuitPromptView }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Where it goes over a window (`window`: top-left origin, the window server's bounds): centred, a little above the middle.
    static func frame(over window: CGRect, size: CGSize) -> CGRect {
        CGRect(x: (window.midX - size.width / 2).rounded(), y: (window.midY - size.height / 2 - 40).rounded(), width: size.width, height: size.height)
    }

    /// Shown centred on a window (`window`: top-left origin, the window server's bounds), with the keys.
    func show(over window: CGRect) {
        isUp = true
        guard !harness else { return } // (a test's: never on screen, never with the keys)
        setFrame(ScreenGeometry.appKitRect(Self.frame(over: window, size: frame.size)), display: true)
        makeKeyAndOrderFront(nil)
        watchPresses()
    }

    func choose(_ choice: QuitChoice) {
        guard !chosen else { return }
        chosen = true
        takeDown()
        onChoice?(choice)
    }

    /// Taken down with no choice (Margin quits some other way).
    func dismiss() {
        chosen = true
        takeDown()
    }

    private func takeDown() {
        isUp = false
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        if !harness { orderOut(nil) }
    }

    // A press anywhere but on the prompt while it's up: cancelled (another app's window: the global monitor; one of
    // Margin's own: the local one). Losing the keys does the same; this holds when it never had them.
    private var monitors: [Any] = []
    private func watchPresses() {
        let presses: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: presses, handler: { [weak self] _ in MainActor.assumeIsolated { self?.choose(.left) } }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: presses, handler: { [weak self] event in
            if let self, event.window !== self { self.choose(.cancel) }
            return event
        }) {
            monitors.append(local)
        }
    }

    override func keyDown(with event: NSEvent) {
        if let c = Self.choice(keyCode: event.keyCode, command: event.modifierFlags.contains(.command)) { choose(c) } else { super.keyDown(with: event) }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let c = Self.choice(keyCode: event.keyCode, command: event.modifierFlags.contains(.command)) { choose(c); return true }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) { choose(.cancel) }

    // Its keys taken (another app's window, or Margin's own, a press there already chose): cancelled, never left up.
    override func resignKey() {
        super.resignKey()
        if !chosen { choose(.left) }
    }
}

// The prompt's look: a rounded card (light or dark, as the Mac is), Margin's icon, the question, what quitting closes,
// and three buttons (as Arc's). Its height follows the note's lines.
final class QuitPromptView: NSView {
    var pick: (QuitChoice) -> Void = { _ in }
    private(set) var buttons: [PromptButton] = []
    let title: NSTextField
    let note: NSTextField

    static let question = "Are you sure you want to quit Margin?"

    init(note text: String) {
        let width = QuitPrompt.width, inset: CGFloat = 28
        title = NSTextField(labelWithString: Self.question)
        note = NSTextField(wrappingLabelWithString: text)
        note.font = .systemFont(ofSize: 13)
        note.textColor = .secondaryLabelColor
        note.isSelectable = false
        note.maximumNumberOfLines = 4
        note.preferredMaxLayoutWidth = width - inset * 2
        let noteHeight = max(18, ceil(note.sizeThatFits(NSSize(width: width - inset * 2, height: 200)).height))
        // From the bottom: the buttons, the note, the question, the icon.
        let buttonY: CGFloat = 24, buttonHeight: CGFloat = 36
        let noteY = buttonY + buttonHeight + 26
        let titleY = noteY + noteHeight + 6
        let iconY = titleY + 28 + 22
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: iconY + 48 + inset))

        let icon = NSImageView(image: NSApplication.shared.applicationIconImage ?? NSImage())
        icon.frame = NSRect(x: inset, y: iconY, width: 48, height: 48)
        addSubview(icon)

        title.font = .systemFont(ofSize: 20, weight: .semibold)
        title.textColor = .labelColor
        title.frame = NSRect(x: inset, y: titleY, width: width - inset * 2, height: 28)
        addSubview(title)

        note.frame = NSRect(x: inset, y: noteY, width: width - inset * 2, height: noteHeight)
        addSubview(note)

        let always = PromptButton(title: "Always quit", badge: nil, style: .plain) { [weak self] in self?.pick(.always) }
        let cancel = PromptButton(title: "Cancel", badge: "esc", style: .plain) { [weak self] in self?.pick(.cancel) }
        let quit = PromptButton(title: "Quit", badge: "↩", style: .destructive) { [weak self] in self?.pick(.quit) }
        always.frame = NSRect(x: inset, y: buttonY, width: always.fittingWidth, height: buttonHeight)
        quit.frame = NSRect(x: width - inset - quit.fittingWidth, y: buttonY, width: quit.fittingWidth, height: buttonHeight)
        cancel.frame = NSRect(x: quit.frame.minX - 10 - cancel.fittingWidth, y: buttonY, width: cancel.fittingWidth, height: buttonHeight)
        for b in [always, cancel, quit] { addSubview(b) }
        buttons = [always, cancel, quit]
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isOpaque: Bool { false }

    // The card, in the colours of the appearance it's drawn in (the Mac's: nothing sets one here).
    override func draw(_ dirtyRect: NSRect) {
        let card = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 18, yRadius: 18)
        QuitPromptStyle.card.setFill()
        card.fill()
        QuitPromptStyle.border.setStroke()
        card.lineWidth = 1
        card.stroke()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
        for b in buttons { b.needsDisplay = true }
        window?.invalidateShadow()
    }
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

    // (On the red button: white in light and dark. On a plain one: the label's own colour.)
    private var textColor: NSColor { style == .destructive ? .white : .labelColor }
    private var titleAttrs: [NSAttributedString.Key: Any] { [.font: NSFont.systemFont(ofSize: 14, weight: .medium), .foregroundColor: textColor] }
    private var badgeAttrs: [NSAttributedString.Key: Any] {
        [.font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: style == .destructive ? NSColor(calibratedWhite: 1, alpha: 0.85) : NSColor.secondaryLabelColor]
    }

    var fittingWidth: CGFloat {
        let t = (title as NSString).size(withAttributes: titleAttrs).width
        let b = badge.map { ($0 as NSString).size(withAttributes: badgeAttrs).width + 16 } ?? 0
        return ceil(t + 36 + (badge == nil ? 0 : b + 8))
    }

    override func draw(_ dirtyRect: NSRect) {
        let base: NSColor = style == .destructive ? QuitPromptStyle.destructiveButton : QuitPromptStyle.plainButton
        let fill = pressed ? base.blended(withFraction: 0.2, of: .black) ?? base : hovered ? base.blended(withFraction: 0.12, of: style == .destructive ? .white : .labelColor) ?? base : base
        fill.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9).fill()
        let t = (title as NSString).size(withAttributes: titleAttrs)
        var x: CGFloat = 18
        (title as NSString).draw(at: NSPoint(x: x, y: (bounds.height - t.height) / 2), withAttributes: titleAttrs)
        x += t.width + 8
        if let badge {
            let b = (badge as NSString).size(withAttributes: badgeAttrs)
            let pill = NSRect(x: x, y: (bounds.height - 18) / 2, width: b.width + 12, height: 18)
            (style == .destructive ? NSColor(calibratedWhite: 1, alpha: 0.30) : QuitPromptStyle.badgeStroke).setStroke()
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
