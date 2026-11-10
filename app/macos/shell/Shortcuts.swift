// Margin's keys as the app's own shortcuts (PLAN.md §6, tested in Phase 0):
// Carbon's RegisterEventHotKey needs no Accessibility, and a key registered
// so never reaches the browser. So they're registered only while a linked
// browser is the active app and its front window has Margin's overlay, and
// let go the moment it isn't (another app in front must get ⌃⌘← and ⌘T).
//
// The keys: next and previous tab and space (sent to the window's extension
// copy as `navigate`), ⌘T, the palette (opened in the front window's overlay,
// which then takes the typing: the app's own, with no round trip through the
// browser), and the sidebar's show/hide key. A held tab or space key repeats
// at the Mac's key repeat (a hot key fires only once per press; Tirth,
// 2026-11-05), each repeat marked as one: the copy takes repeats like presses,
// only one switch at a time with Safari, the newest waiting (navigation.ts),
// and a repeat never starts a switch to another profile's space (at most one
// per press: ShellProfiles.swift spaceKey). Which combinations is the
// copy's to say (its Settings shortcuts, and Safari's command keys: the
// `keys` message, docs/PROTOCOL.md); until it does, the defaults below.
// Combinations are written as the extension's settings write them
// ("Ctrl+Meta+ArrowDown": shared/shortcuts.ts).

import AppKit
import Carbon
import Foundation

enum AppCommand: String, CaseIterable {
    case nextTab = "next-tab", prevTab = "prev-tab", nextSpace = "next-space", prevSpace = "prev-space", palette
    case toggleSidebar = "toggle-sidebar"
    case newWindow = "new-window" // a Margin window of its own (docs/BROWSER-WINDOWS.md §5)

    // Held down, these run again at the Mac's key repeat (a hot key itself fires once).
    var repeats: Bool { self == .nextTab || self == .prevTab || self == .nextSpace || self == .prevSpace }
}

// A held key's repeat: the Mac's own delay and rate (Keyboard settings), a
// way to wait (a test's clock), and whether the combination's modifiers are
// still down (the release can be missed, e.g. when another app comes forward:
// the repeat then stops at the next tick).
struct KeyRepeat {
    var delay: () -> TimeInterval = { NSEvent.keyRepeatDelay }
    var interval: () -> TimeInterval = { NSEvent.keyRepeatInterval }
    var after: (TimeInterval, @escaping () -> Void) -> (() -> Void) = { seconds, run in
        let timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in MainActor.assumeIsolated { run() } }
        return { timer.invalidate() }
    }
    var modifiersDown: (UInt32) -> Bool = { modifiers in
        let now = NSEvent.modifierFlags
        let want: [(Int, NSEvent.ModifierFlags)] = [(cmdKey, .command), (controlKey, .control), (optionKey, .option), (shiftKey, .shift)]
        return want.allSatisfy { modifiers & UInt32($0.0) == 0 || now.contains($0.1) }
    }
}

nonisolated struct Combo: Hashable, CustomStringConvertible {
    let keyCode: UInt32
    let modifiers: UInt32 // Carbon's cmdKey, controlKey, optionKey, shiftKey

    static let keyCodes: [String: Int] = [
        "ArrowDown": kVK_DownArrow, "ArrowUp": kVK_UpArrow, "ArrowLeft": kVK_LeftArrow, "ArrowRight": kVK_RightArrow,
        "KeyA": kVK_ANSI_A, "KeyB": kVK_ANSI_B, "KeyC": kVK_ANSI_C, "KeyD": kVK_ANSI_D, "KeyE": kVK_ANSI_E, "KeyF": kVK_ANSI_F,
        "KeyG": kVK_ANSI_G, "KeyH": kVK_ANSI_H, "KeyI": kVK_ANSI_I, "KeyJ": kVK_ANSI_J, "KeyK": kVK_ANSI_K, "KeyL": kVK_ANSI_L,
        "KeyM": kVK_ANSI_M, "KeyN": kVK_ANSI_N, "KeyO": kVK_ANSI_O, "KeyP": kVK_ANSI_P, "KeyQ": kVK_ANSI_Q, "KeyR": kVK_ANSI_R,
        "KeyS": kVK_ANSI_S, "KeyT": kVK_ANSI_T, "KeyU": kVK_ANSI_U, "KeyV": kVK_ANSI_V, "KeyW": kVK_ANSI_W, "KeyX": kVK_ANSI_X,
        "KeyY": kVK_ANSI_Y, "KeyZ": kVK_ANSI_Z, "Space": kVK_Space, "F19": kVK_F19,
        "Digit0": kVK_ANSI_0, "Digit1": kVK_ANSI_1, "Digit2": kVK_ANSI_2, "Digit3": kVK_ANSI_3, "Digit4": kVK_ANSI_4,
        "Digit5": kVK_ANSI_5, "Digit6": kVK_ANSI_6, "Digit7": kVK_ANSI_7, "Digit8": kVK_ANSI_8, "Digit9": kVK_ANSI_9,
        "Enter": kVK_Return, "Backquote": kVK_ANSI_Grave, "Minus": kVK_ANSI_Minus, "Equal": kVK_ANSI_Equal,
        "BracketLeft": kVK_ANSI_LeftBracket, "BracketRight": kVK_ANSI_RightBracket, "Backslash": kVK_ANSI_Backslash,
        "Semicolon": kVK_ANSI_Semicolon, "Quote": kVK_ANSI_Quote, "Comma": kVK_ANSI_Comma, "Period": kVK_ANSI_Period, "Slash": kVK_ANSI_Slash,
        "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6,
        "F7": kVK_F7, "F8": kVK_F8, "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12,
    ]
    static let modifierBits: [String: Int] = ["Meta": cmdKey, "Ctrl": controlKey, "Alt": optionKey, "Shift": shiftKey]

    // "Ctrl+Meta+ArrowDown" → the key and its modifiers; nil if it isn't one (no modifier, an unknown key).
    static func parse(_ text: String) -> Combo? {
        let parts = text.split(separator: "+").map(String.init)
        guard let last = parts.last, let code = keyCodes[last], parts.count >= 2 else { return nil }
        var mods = 0
        for p in parts.dropLast() {
            guard let bit = modifierBits[p], mods & bit == 0 else { return nil }
            mods |= bit
        }
        guard mods & (cmdKey | controlKey | optionKey) != 0 else { return nil }
        return Combo(keyCode: UInt32(code), modifiers: UInt32(mods))
    }

    var description: String {
        let names = [(controlKey, "⌃"), (optionKey, "⌥"), (shiftKey, "⇧"), (cmdKey, "⌘")].filter { modifiers & UInt32($0.0) != 0 }.map(\.1).joined()
        return names + (Self.keyCodes.first { $0.value == Int(keyCode) }?.key ?? "#\(keyCode)")
    }
}

enum ShortcutSet {
    static let defaults: [AppCommand: String] = [
        .nextTab: "Alt+Meta+ArrowDown", .prevTab: "Alt+Meta+ArrowUp",
        .nextSpace: "Alt+Meta+ArrowRight", .prevSpace: "Alt+Meta+ArrowLeft",
        .palette: "Meta+KeyT", .toggleSidebar: "Alt+KeyS",
        .newWindow: "Meta+KeyN",
    ]

    static var bindings: [Combo: AppCommand] {
        var out: [Combo: AppCommand] = [:]
        for (command, text) in defaults { if let combo = Combo.parse(text) { out[combo] = command } }
        return out
    }

    // The copy's `keys` ({ command: [combination] }): a command it doesn't
    // name keeps its default; one it names with nothing usable has none; the
    // palette is always ⌘T too; a combination two commands name goes to the
    // first in AppCommand's order (the copy's Settings refuse that anyway).
    // `safari`: ⇧⌘L, Safari's own sidebar key, is Margin's sidebar key too there (Safari's sidebar kept closed under
    // Margin: ShellSafariSidebar.swift), unless another command has it.
    static let safariSidebarKey = "Shift+Meta+KeyL"
    static func bindings(from keys: [String: [String]], safari: Bool = false) -> [Combo: AppCommand] {
        var out: [Combo: AppCommand] = [:]
        for command in AppCommand.allCases {
            var texts = keys[command.rawValue] ?? [defaults[command]].compactMap { $0 }
            if command == .palette, !texts.contains("Meta+KeyT") { texts.append("Meta+KeyT") }
            if command == .toggleSidebar, safari, !texts.contains(safariSidebarKey) { texts.append(safariSidebarKey) }
            for text in texts { if let combo = Combo.parse(text), out[combo] == nil { out[combo] = command } }
        }
        return out
    }

    /// Whether Margin's keys are the app's now: a linked browser is the active
    /// app and its front window has Margin's overlay showing.
    static func active(frontPid: pid_t?, linkedPids: Set<pid_t>, frontWindowHasOverlay: Bool) -> Bool {
        guard let frontPid else { return false }
        return linkedPids.contains(frontPid) && frontWindowHasOverlay
    }
}

// Registering and letting go of a hot key (Carbon's, or a test's stand-in).
protocol HotKeyRegistrar: AnyObject {
    // False if it can't be had (another app has it).
    func register(_ combo: Combo, id: UInt32) -> Bool
    func unregister(id: UInt32)
    var onHit: ((UInt32) -> Void)? { get set }
    var onRelease: ((UInt32) -> Void)? { get set }
}

final class CarbonHotKeys: HotKeyRegistrar {
    var onHit: ((UInt32) -> Void)?
    var onRelease: ((UInt32) -> Void)?
    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var handler: EventHandlerRef?
    static let signature = OSType(0x4D52_474E) // 'MRGN'
    // The one instance Carbon's C callback reaches.
    nonisolated(unsafe) private static weak var current: CarbonHotKeys?

    init() {
        Self.current = self
        var specs = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                     EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var id = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                           MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard status == noErr, id.signature == CarbonHotKeys.signature else { return OSStatus(eventNotHandledErr) }
            let hit = id.id
            let released = GetEventKind(event) == UInt32(kEventHotKeyReleased)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if released { CarbonHotKeys.current?.onRelease?(hit) } else { CarbonHotKeys.current?.onHit?(hit) }
                }
            }
            return noErr
        }, 2, &specs, nil, &handler)
    }

    func register(_ combo: Combo, id: UInt32) -> Bool {
        unregister(id: id)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, EventHotKeyID(signature: Self.signature, id: id), GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else { return false }
        refs[id] = ref
        return true
    }

    func unregister(id: UInt32) {
        if let ref = refs.removeValue(forKey: id) { UnregisterEventHotKey(ref) }
    }
}

// Margin's keys, held while they should be (ShortcutSet.active) and let go otherwise.
final class AppShortcuts {
    // A command, and whether it's a held key's repeat (not a press).
    var onCommand: ((AppCommand, Bool) -> Void)?
    private let registrar: HotKeyRegistrar
    private(set) var bindings: [(Combo, AppCommand)]
    private(set) var isActive = false
    private var held = 0 // ids registered, so a rebind lets go of all of them
    // The ones another app holds (tried again each time they're taken).
    private(set) var unavailable: [Combo] = []

    private let keyRepeat: KeyRepeat
    // The held key repeating now (its id), and how to stop its next tick.
    private var repeating: UInt32?
    private var cancelTick: (() -> Void)?

    init(registrar: HotKeyRegistrar, bindings: [Combo: AppCommand] = ShortcutSet.bindings, keyRepeat: KeyRepeat = KeyRepeat()) {
        self.registrar = registrar
        self.bindings = Self.ordered(bindings)
        self.keyRepeat = keyRepeat
        registrar.onHit = { [weak self] id in
            if id >= Self.quitIdBase {
                guard let self, self.guardsQuit, Int(id - Self.quitIdBase) < Self.quitCombos.count else { return }
                self.onQuit?(Self.quitCombos[Int(id - Self.quitIdBase)].keepWindows)
                return
            }
            guard let self, self.isActive, Int(id) < self.bindings.count else { return }
            let (combo, command) = self.bindings[Int(id)]
            self.stopRepeat()
            self.onCommand?(command, false)
            if command.repeats { self.startRepeat(id, combo, command) }
        }
        registrar.onRelease = { [weak self] id in
            guard let self, self.repeating == id else { return }
            self.stopRepeat()
        }
    }

    // Held: again after the Mac's repeat delay, then at its rate, until let go.
    private func startRepeat(_ id: UInt32, _ combo: Combo, _ command: AppCommand) {
        repeating = id
        func tick(_ wait: TimeInterval) {
            cancelTick = keyRepeat.after(wait) { [weak self] in
                guard let self, self.repeating == id, self.isActive, self.keyRepeat.modifiersDown(combo.modifiers) else {
                    self?.stopRepeat()
                    return
                }
                self.onCommand?(command, true)
                tick(max(0.02, self.keyRepeat.interval()))
            }
        }
        tick(max(0.05, keyRepeat.delay()))
    }

    private func stopRepeat() {
        cancelTick?()
        cancelTick = nil
        repeating = nil
    }

    private static func ordered(_ bindings: [Combo: AppCommand]) -> [(Combo, AppCommand)] {
        bindings.sorted { ($0.value.rawValue, $0.key.keyCode, $0.key.modifiers) < ($1.value.rawValue, $1.key.keyCode, $1.key.modifiers) }
    }

    // ---- the quit guard ----
    // ⌘Q and ⌥⌘Q (Quit and Keep Windows), taken while a linked browser is in front with windows Margin has parked
    // (Shell.updateKeys): Margin's first, so it closes those windows before the browser saves its windows for its
    // next launch, then hands the same keys on (Shell.quitBrowser; Tirth, 2026-11-07: parked windows came back as
    // small windows on the Desktop after Safari quit). Never held otherwise: ⌘Q is the browser's as it always was.
    static let quitCombos: [(combo: Combo, keepWindows: Bool)] = [(Combo.parse("Meta+KeyQ")!, false), (Combo.parse("Alt+Meta+KeyQ")!, true)]
    static let quitIdBase: UInt32 = 900
    var onQuit: ((Bool) -> Void)? // keep windows (⌥⌘Q) or not
    private(set) var guardsQuit = false

    func setQuitGuard(active: Bool) {
        guard active != guardsQuit else { return }
        guardsQuit = active
        for (i, entry) in Self.quitCombos.enumerated() {
            let id = Self.quitIdBase + UInt32(i)
            if !active { registrar.unregister(id: id); continue }
            if !registrar.register(entry.combo, id: id) { Diagnostics.warn("\(entry.combo) is another app's: Margin can't close parked windows before the browser quits by it") }
        }
    }

    // New combinations (the copy's `keys`): held at once if the keys are held now.
    func rebind(_ next: [Combo: AppCommand]) {
        let ordered = Self.ordered(next)
        guard ordered.map(\.0) != bindings.map(\.0) || ordered.map(\.1) != bindings.map(\.1) else { return }
        let was = isActive
        set(active: false)
        bindings = ordered
        set(active: was)
    }

    func set(active: Bool) {
        guard active != isActive else { return }
        isActive = active
        if active {
            unavailable = []
            held = bindings.count
            for (i, (combo, command)) in bindings.enumerated() where !registrar.register(combo, id: UInt32(i)) {
                unavailable.append(combo)
                Diagnostics.warn("\(combo) (\(command.rawValue)) is another app's: not Margin's")
            }
        } else {
            stopRepeat()
            for i in 0..<max(bindings.count, held) { registrar.unregister(id: UInt32(i)) }
        }
    }
}
