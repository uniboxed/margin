// Margin's keys as the app's own shortcuts (PLAN.md §6, tested in Phase 0):
// Carbon's RegisterEventHotKey needs no Accessibility, and a key registered
// so never reaches the hosted app. So they're registered only while Margin or
// an app it hosts is the active app (ShortcutSet.hostedActive), and let go the
// moment it isn't (another app in front must get ⌃⌘← and ⌘T).
//
// The keys: next and previous tab and space, ⌘T, the palette, the sidebar's
// show/hide key and a new Margin window, each run by Margin's window's page as
// its own (ShellHostedGlue.swift runHosted). A held tab or space key repeats at
// the Mac's key repeat (a hot key fires only once per press; requested
// 2026-11-05), each repeat marked as one. Which combinations is the first
// linked copy's to say (its Settings shortcuts: the `keys` message,
// docs/PROTOCOL.md); until it does, the defaults below.
// Combinations are written as the extension's settings write them
// ("Ctrl+Meta+ArrowDown": shared/shortcuts.ts).

import AppKit
import Carbon
import Foundation

enum AppCommand: String, CaseIterable {
    case nextTab = "next-tab", prevTab = "prev-tab", nextSpace = "next-space", prevSpace = "prev-space", palette
    case toggleSidebar = "toggle-sidebar"
    case newWindow = "new-window" // a Margin window of its own (docs/BROWSER-WINDOWS.md §5)
    case copyUrl = "copy-url"
    case focusAddress = "focus-address"
    case togglePin = "toggle-pin"
    case reopenArchived = "reopen-archived"
    case littleArc = "little-arc"
    case space1 = "space-1", space2 = "space-2", space3 = "space-3", space4 = "space-4", space5 = "space-5"
    case space6 = "space-6", space7 = "space-7", space8 = "space-8", space9 = "space-9"
    case item1 = "item-1", item2 = "item-2", item3 = "item-3", item4 = "item-4", item5 = "item-5"
    case item6 = "item-6", item7 = "item-7", item8 = "item-8", item9 = "item-9"

    // Held down, these run again at the Mac's key repeat (a hot key itself fires once).
    var repeats: Bool { self == .nextTab || self == .prevTab || self == .nextSpace || self == .prevSpace }

    // Commands that belong to Margin or a hosted browser, never hijacked from a hosted native app (e.g. Terminal, Notes).
    var browserOnly: Bool {
        switch self {
        case .copyUrl, .focusAddress, .togglePin, .reopenArchived,
             .item1, .item2, .item3, .item4, .item5, .item6, .item7, .item8, .item9:
            return true
        default:
            return false
        }
    }

    var spaceNumber: Int? {
        switch self {
        case .space1: return 1; case .space2: return 2; case .space3: return 3
        case .space4: return 4; case .space5: return 5; case .space6: return 6
        case .space7: return 7; case .space8: return 8; case .space9: return 9
        default: return nil
        }
    }

    var itemNumber: Int? {
        switch self {
        case .item1: return 1; case .item2: return 2; case .item3: return 3
        case .item4: return 4; case .item5: return 5; case .item6: return 6
        case .item7: return 7; case .item8: return 8; case .item9: return 9
        default: return nil
        }
    }
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
        .copyUrl: "Shift+Meta+KeyC",
        .focusAddress: "Meta+KeyL",
        .togglePin: "Meta+KeyD",
        .reopenArchived: "Shift+Meta+KeyT",
        .littleArc: "Alt+Meta+KeyN",
        .space1: "Ctrl+Digit1", .space2: "Ctrl+Digit2", .space3: "Ctrl+Digit3",
        .space4: "Ctrl+Digit4", .space5: "Ctrl+Digit5", .space6: "Ctrl+Digit6",
        .space7: "Ctrl+Digit7", .space8: "Ctrl+Digit8", .space9: "Ctrl+Digit9",
        .item1: "Meta+Digit1", .item2: "Meta+Digit2", .item3: "Meta+Digit3",
        .item4: "Meta+Digit4", .item5: "Meta+Digit5", .item6: "Meta+Digit6",
        .item7: "Meta+Digit7", .item8: "Meta+Digit8", .item9: "Meta+Digit9",
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
    static func bindings(from keys: [String: [String]]) -> [Combo: AppCommand] {
        var out: [Combo: AppCommand] = [:]
        for command in AppCommand.allCases {
            var texts = keys[command.rawValue] ?? [defaults[command]].compactMap { $0 }
            if command == .palette, !texts.contains("Meta+KeyT") { texts.append("Meta+KeyT") }
            for text in texts { if let combo = Combo.parse(text), out[combo] == nil { out[combo] = command } }
        }
        return out
    }
}

extension ShortcutSet {
    /// Margin hosting apps in its own window: its keys are the app's
    /// while Margin itself is the active app (one of its windows open), or while an app it hosts is (Safari's hosted
    /// window's included) with a Margin window on the current Space; let go otherwise, so other apps keep their keys.
    /// Carbon's hot keys reach Margin only: the hosted app never gets the same press too.
    static func hostedActive(frontPid: pid_t?, ownPid: pid_t, hostedPids: Set<pid_t>, marginWindowOpen: Bool, marginOnCurrentSpace: Bool) -> Bool {
        guard let frontPid, marginWindowOpen else { return false }
        if frontPid == ownPid { return true }
        return hostedPids.contains(frontPid) && marginOnCurrentSpace
    }
}

extension ShortcutSet {
    /// Whether ⌘Q and ⌥⌘Q are Margin's first (AppShortcuts' quit guard): it isn't quitting already, Margin or an app it
    /// hosts is in front (`hostedActive`: a hosted app only with a Margin window on the current Space), and either
    /// Margin asks before it quits (`asks`: its stored setting, off after "Always quit") or it's a hosted app in front.
    /// With asking off the key in a hosted app is still Margin's: it quits Margin without asking (Shell.quitKey),
    /// never the hosted app alone, which would leave its item dead in Margin; with Margin itself in front it's then
    /// Margin's own Quit menu item. Never held for an app Margin doesn't host: ⌘Q there is that app's.
    static func guardsQuit(asks: Bool, quitting: Bool, frontPid: pid_t?, ownPid: pid_t, hostedPids: Set<pid_t>, marginWindowOpen: Bool, marginOnCurrentSpace: Bool) -> Bool {
        !quitting && (asks || frontPid != ownPid)
            && hostedActive(frontPid: frontPid, ownPid: ownPid, hostedPids: hostedPids, marginWindowOpen: marginWindowOpen, marginOnCurrentSpace: marginOnCurrentSpace)
    }
}

// A hosted app's own key Margin takes while that app is in front (AppShortcuts.setAppKeyGuard), and what it does there
// (Shell.runAppKey): in the window Margin hosts, what Margin's own menu would (⌘W its Close Tab) or nothing (the rest:
// each would take the window out of Margin, or close every tab of a Safari window); in another window of the app's (a
// meeting, a draft, Safari's Settings), ⌘W closes it and ⌘M minimizes it, as there.
enum AppKey: String, CaseIterable {
    case closeTab = "Meta+KeyW"
    case closeWindow = "Shift+Meta+KeyW" // Safari: Close Window, every tab in it
    case closeOthers = "Alt+Meta+KeyW" // Safari: Close Other Tabs; most apps: Close All
    case minimize = "Meta+KeyM"
    case hide = "Meta+KeyH"
    case hideOthers = "Alt+Meta+KeyH" // Margin itself among the others
    case fullScreen = "Ctrl+Meta+KeyF" // out of Margin's Space, into one of its own

    var name: String {
        switch self {
        case .closeTab: return "⌘W"
        case .closeWindow: return "⇧⌘W"
        case .closeOthers: return "⌥⌘W"
        case .minimize: return "⌘M"
        case .hide: return "⌘H"
        case .hideOthers: return "⌥⌘H"
        case .fullScreen: return "⌃⌘F"
        }
    }
}

extension ShortcutSet {
    /// Whether a hosted app's own keys (AppKey) are Margin's: an app Margin hosts is in front (not Margin itself, whose
    /// menu has them), with a Margin window on the current Space (`hostedActive`), and Margin isn't quitting.
    static func guardsAppKeys(quitting: Bool, frontPid: pid_t?, ownPid: pid_t, hostedPids: Set<pid_t>, marginWindowOpen: Bool, marginOnCurrentSpace: Bool) -> Bool {
        !quitting && frontPid != ownPid
            && hostedActive(frontPid: frontPid, ownPid: ownPid, hostedPids: hostedPids, marginWindowOpen: marginWindowOpen, marginOnCurrentSpace: marginOnCurrentSpace)
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

// Margin's keys, held while they should be (ShortcutSet.hostedActive) and let go otherwise.
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
            if id >= Self.appKeyIdBase {
                guard let self, self.guardsAppKeys, Int(id - Self.appKeyIdBase) < Self.appKeyCombos.count else { return }
                self.onAppKey?(Self.appKeyCombos[Int(id - Self.appKeyIdBase)].key)
                return
            }
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
    // ⌘Q and ⌥⌘Q (a browser's Quit and Keep Windows), taken while Margin or an app it hosts is in front and Margin asks
    // before it quits (ShortcutSet.guardsQuit, held by Shell.updateHostedKeys): Margin's first, so the key in a hosted
    // app never quits that app alone and leaves Margin with a dead item; Margin's own prompt comes up instead
    // (ShellQuit.swift, QuitPrompt.swift), and its Quit gives every hosted app back. Held apart from Margin's own keys,
    // by their own rule. Never held otherwise: ⌘Q is the front app's as it always was.
    static let quitCombos: [(combo: Combo, keepWindows: Bool)] = [(Combo.parse("Meta+KeyQ")!, false), (Combo.parse("Alt+Meta+KeyQ")!, true)]
    static let quitIdBase: UInt32 = 900
    var onQuit: ((Bool) -> Void)? // which of the two (⌥⌘Q: true)
    private(set) var guardsQuit = false

    func setQuitGuard(active: Bool) {
        guard active != guardsQuit else { return }
        guardsQuit = active
        for (i, entry) in Self.quitCombos.enumerated() {
            let id = Self.quitIdBase + UInt32(i)
            if !active { registrar.unregister(id: id); continue }
            if !registrar.register(entry.combo, id: id) { Diagnostics.warn("\(entry.combo) is another app's: Margin can't ask before it quits by it") }
        }
    }

    // ---- a hosted app's own keys that would undo its hosting (Tirth, 2026-11-19) ----
    // Taken while an app Margin hosts is in front (ShortcutSet.guardsAppKeys), never while Margin itself is (its own menu
    // has them: Close Tab, Close Window, Minimize, Hide) or another app is. Without them, ⌘W in a hosted Safari closed
    // its window and every tab Margin had there (seen 2026-11-19 10:55:40), ⌘M or ⌃⌘F took the window out of Margin's
    // Space, ⌘H hid it, ⌥⌘H hid Margin. Each one's run by Shell.runAppKey for the window that has the keys.
    static let appKeyCombos: [(combo: Combo, key: AppKey)] = AppKey.allCases.map { (Combo.parse($0.rawValue)!, $0) }
    static let appKeyIdBase: UInt32 = 920
    var onAppKey: ((AppKey) -> Void)?
    private(set) var guardsAppKeys = false

    func setAppKeyGuard(active: Bool) {
        guard active != guardsAppKeys else { return }
        guardsAppKeys = active
        for (i, entry) in Self.appKeyCombos.enumerated() {
            let id = Self.appKeyIdBase + UInt32(i)
            if !active { registrar.unregister(id: id); continue }
            if !registrar.register(entry.combo, id: id) { Diagnostics.warn("\(entry.combo) is another app's: a hosted app keeps it") }
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
