// Margin's keys as the app's own shortcuts (PLAN.md §6, tested in Phase 0):
// Carbon's RegisterEventHotKey needs no Accessibility, and a key registered
// so never reaches the hosted app. So they're registered only while Margin or
// an app it hosts is the active app (ShortcutSet.hostedActive), and let go the
// moment it isn't (another app in front must get ⌃⌘← and ⌘T).
//
// Every rule is margin-core's (app/shared/core/src/shortcuts.rs, through margin-ffi's keys calls; docs/CORE-REFACTOR.md
// step 1.1), the same on every OS: the commands and their default combinations, the copy's `keys` read, which keys are
// held while an app is hosted, the gates (held, the quit guard, the hosted app's keys), a held key's repeat. This file
// keeps the Mac's mechanism: Carbon's hot keys, the repeat's timer, the Mac's key repeat settings, and the names the
// rest of the app calls. Combinations are written as the extension's settings write them ("Ctrl+Meta+ArrowDown":
// shared/shortcuts.ts) and cross as Carbon's key code and modifier bits.
//
// The keys: next and previous tab and space, ⌘T, the palette, the sidebar's show/hide key, a new Margin window and
// Margin.app's own (copy the address, the address field, pin, reopen, Quick Tab, Add Split, ⌃1–9 spaces, ⌘1–9 rows),
// each run by Margin's window's page as its own (ShellHostedGlue.swift runHosted). A held tab or space key repeats at
// the Mac's key repeat (a hot key fires only once per press; requested 2026-11-05), each repeat marked as one. Which
// combinations is the first linked copy's to say (its Settings shortcuts: the `keys` message, docs/PROTOCOL.md);
// until it does, the defaults.

import AppKit
import Carbon
import Foundation
import MarginCore

// margin-core's keys calls with Swift's values: text in, JSON out (the rare calls), the constants read once.
enum KeysCore {
    // A JSON answer of one of the calls (freed here), nil if there's none.
    nonisolated static func answer(_ call: (UnsafeMutablePointer<Int>) -> UnsafeMutablePointer<UInt8>?) -> Any? {
        var len = 0
        guard let out = call(&len) else { return nil }
        defer { margin_buffer_free(out, len) }
        return try? JSONSerialization.jsonObject(with: Data(bytes: out, count: len), options: [.fragmentsAllowed])
    }
    // `text`'s UTF-8 bytes to a call.
    nonisolated static func bytes<T>(_ text: String, _ call: (UnsafePointer<UInt8>?, Int) -> T) -> T {
        let utf8 = Array(text.utf8)
        return utf8.withUnsafeBufferPointer { call($0.baseAddress, $0.count) }
    }
    nonisolated static func json(_ value: Any) -> String {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
    }
    nonisolated static let constants: [String: Any] = answer { margin_keys_constants($0) } as? [String: Any] ?? [:]
    // The commands in the core's order (a hit's index).
    nonisolated static let commands: [String] = constants["commands"] as? [String] ?? []
    // `[[keyCode, modifiers, command], …]` → bindings (an entry that isn't one left out).
    nonisolated static func bindings(_ value: Any?) -> [Combo: AppCommand] {
        var out: [Combo: AppCommand] = [:]
        for e in value as? [[Any]] ?? [] {
            guard e.count == 3, let k = e[0] as? Int, let m = e[1] as? Int, let name = e[2] as? String, let c = AppCommand(rawValue: name) else { continue }
            out[Combo(keyCode: UInt32(k), modifiers: UInt32(m))] = c
        }
        return out
    }
    nonisolated static func list(_ bindings: [Combo: AppCommand]) -> String {
        json(bindings.map { [Int($0.key.keyCode), Int($0.key.modifiers), $0.value.rawValue] as [Any] })
    }
    // `[[keyCode, modifiers, …], …]` → the combinations.
    nonisolated static func combos(_ value: Any?) -> [(Combo, String?)] {
        (value as? [[Any]] ?? []).compactMap { e in
            guard e.count >= 2, let k = e[0] as? Int, let m = e[1] as? Int else { return nil }
            return (Combo(keyCode: UInt32(k), modifiers: UInt32(m)), e.count > 2 ? e[2] as? String : nil)
        }
    }
}

// The core's commands by name (their rules are the core's: which repeat, which are a browser's only, the defaults).
enum AppCommand: String, CaseIterable {
    case nextTab = "next-tab", prevTab = "prev-tab", nextSpace = "next-space", prevSpace = "prev-space", palette
    case toggleSidebar = "toggle-sidebar"
    case newWindow = "new-window" // a Margin window of its own (docs/BROWSER-WINDOWS.md §5)
    case copyUrl = "copy-url"
    case focusAddress = "focus-address"
    case togglePin = "toggle-pin"
    case reopenArchived = "reopen-archived"
    case littleArc = "little-arc"
    case addSplit = "add-split"
    case space1 = "space-1", space2 = "space-2", space3 = "space-3", space4 = "space-4", space5 = "space-5"
    case space6 = "space-6", space7 = "space-7", space8 = "space-8", space9 = "space-9"
    case item1 = "item-1", item2 = "item-2", item3 = "item-3", item4 = "item-4", item5 = "item-5"
    case item6 = "item-6", item7 = "item-7", item8 = "item-8", item9 = "item-9"

    // The number in a numbered key's name (space-1…9, item-1…9), for the page's `space-index` and `item-index`.
    var spaceNumber: Int? { rawValue.hasPrefix("space-") ? Int(rawValue.dropFirst(6)) : nil }
    var itemNumber: Int? { rawValue.hasPrefix("item-") ? Int(rawValue.dropFirst(5)) : nil }
}

// A held key's repeat: the Mac's own delay and rate (Keyboard settings), a clock and a way to wait (a test's), and the
// modifiers down now as Carbon's bits (the release can be missed, e.g. when another app comes forward: the core then
// stops the repeat at the next tick).
struct KeyRepeat {
    var delay: () -> TimeInterval = { NSEvent.keyRepeatDelay }
    var interval: () -> TimeInterval = { NSEvent.keyRepeatInterval }
    var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    var after: (TimeInterval, @escaping () -> Void) -> (() -> Void) = { seconds, run in
        let timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in MainActor.assumeIsolated { run() } }
        return { timer.invalidate() }
    }
    var modifiers: () -> UInt32 = {
        let now = NSEvent.modifierFlags
        let bits: [(Int, NSEvent.ModifierFlags)] = [(cmdKey, .command), (controlKey, .control), (optionKey, .option), (shiftKey, .shift)]
        return bits.reduce(UInt32(0)) { now.contains($1.1) ? $0 | UInt32($1.0) : $0 }
    }
}

// A combination as Carbon has it: its key code and modifier bits (cmdKey, controlKey, optionKey, shiftKey).
nonisolated struct Combo: Hashable, CustomStringConvertible {
    let keyCode: UInt32
    let modifiers: UInt32

    // "Ctrl+Meta+ArrowDown" → the key and its modifiers; nil if it isn't one (the core's rule: no modifier but Shift,
    // an unknown key, a modifier twice).
    static func parse(_ text: String) -> Combo? {
        let c = KeysCore.bytes(text) { margin_keys_parse($0, $1) }
        return c.ok ? Combo(keyCode: UInt32(c.key_code), modifiers: c.modifiers) : nil
    }

    var description: String {
        KeysCore.answer { margin_keys_describe(UInt16(truncatingIfNeeded: keyCode), modifiers, $0) } as? String ?? "#\(keyCode)"
    }
}

enum ShortcutSet {
    // The defaults' bindings.
    static var bindings: [Combo: AppCommand] { KeysCore.bindings(KeysCore.answer { margin_keys_bindings(nil, 0, $0) }) }

    // The copy's `keys` ({ command: [combination] }) as bindings: a command it doesn't name keeps its default; one it
    // names with nothing usable has none; the palette is always ⌘T too; a combination two commands name goes to the
    // first in the core's order (the copy's Settings refuse that anyway).
    static func bindings(from keys: [String: [String]]) -> [Combo: AppCommand] {
        KeysCore.bindings(KeysCore.bytes(KeysCore.json(keys)) { p, n in KeysCore.answer { margin_keys_bindings(p, n, $0) } })
    }
}

extension ShortcutSet {
    /// A hosted window that is a browser's (the keys only a browser has are Margin's there): Safari's window a copy
    /// made, or an app item that is one of the browsers Margin links with (`bundles`) or Chrome or Edge in any channel.
    static func hostIsBrowser(target: HostTarget, safariWindow: Int?, bundles: Set<String>) -> Bool {
        if safariWindow != nil { return true }
        switch target {
        case .safariWindow: return true
        case .app(let bundle):
            return KeysCore.bytes(bundle) { b, bn in KeysCore.bytes(KeysCore.json(bundles.sorted())) { l, ln in margin_keys_is_browser_app(b, bn, l, ln) } }
        }
    }

    /// Chrome or Edge, any channel (the core's rule).
    static func isChromium(_ bundle: String) -> Bool { KeysCore.bytes(bundle) { margin_keys_is_chromium($0, $1) } }

    /// The keys Margin holds now (the core's `held`): a hosted app in front keeps its sidebar key and its own ⌘L, ⌘D,
    /// ⌘1–9… unless it's a browser; a numbered key with nothing behind it (more than the window's spaces or rows, its
    /// page says them) isn't held, so the press reaches the app in front. Counts not said yet: every number held.
    static func held(_ bindings: [Combo: AppCommand], marginInFront: Bool, browser: Bool, spaces: Int?, items: Int?) -> [Combo: AppCommand] {
        KeysCore.bindings(KeysCore.bytes(KeysCore.list(bindings)) { p, n in
            KeysCore.answer { margin_keys_held(p, n, marginInFront, browser, Int32(spaces ?? -1), Int32(items ?? -1), $0) }
        })
    }

    // The core's three gates at once (bit 1 held, 2 the quit guard, 4 the hosted app's keys).
    private static func gate(asks: Bool = false, quitting: Bool = false, frontPid: pid_t?, ownPid: pid_t, hostedPids: Set<pid_t>, marginWindowOpen: Bool, marginOnCurrentSpace: Bool) -> UInt8 {
        margin_keys_gate(Int64(frontPid ?? -1), Int64(ownPid), frontPid.map(hostedPids.contains) ?? false, marginWindowOpen, marginOnCurrentSpace, asks, quitting)
    }

    /// Margin hosting apps in its own window: its keys are the app's while Margin itself is the active app (one of its
    /// windows open), or while an app it hosts is with a Margin window on the current Space; let go otherwise.
    static func hostedActive(frontPid: pid_t?, ownPid: pid_t, hostedPids: Set<pid_t>, marginWindowOpen: Bool, marginOnCurrentSpace: Bool) -> Bool {
        gate(frontPid: frontPid, ownPid: ownPid, hostedPids: hostedPids, marginWindowOpen: marginWindowOpen, marginOnCurrentSpace: marginOnCurrentSpace) & 1 != 0
    }

    /// Whether ⌘Q and ⌥⌘Q are Margin's first (the core's quit guard rule: not quitting, Margin or an app it hosts in
    /// front, and either Margin asks before it quits or it's a hosted app in front).
    static func guardsQuit(asks: Bool, quitting: Bool, frontPid: pid_t?, ownPid: pid_t, hostedPids: Set<pid_t>, marginWindowOpen: Bool, marginOnCurrentSpace: Bool) -> Bool {
        gate(asks: asks, quitting: quitting, frontPid: frontPid, ownPid: ownPid, hostedPids: hostedPids, marginWindowOpen: marginWindowOpen, marginOnCurrentSpace: marginOnCurrentSpace) & 2 != 0
    }

    /// Whether a hosted app's own keys (AppKey) are Margin's (the core's rule: an app Margin hosts in front, not Margin
    /// itself, a Margin window on the current Space, not quitting).
    static func guardsAppKeys(quitting: Bool, frontPid: pid_t?, ownPid: pid_t, hostedPids: Set<pid_t>, marginWindowOpen: Bool, marginOnCurrentSpace: Bool) -> Bool {
        gate(quitting: quitting, frontPid: frontPid, ownPid: ownPid, hostedPids: hostedPids, marginWindowOpen: marginWindowOpen, marginOnCurrentSpace: marginOnCurrentSpace) & 4 != 0
    }
}

// A hosted app's own key Margin takes while that app is in front (AppShortcuts.setAppKeyGuard), in the core's order,
// and what it does there (Shell.runAppKey): in the window Margin hosts, what Margin's own menu would (⌘W its Close Tab)
// or nothing; in another window of the app's (a meeting, a draft, Safari's Settings), ⌘W closes it and ⌘M minimizes it.
enum AppKey: Int, CaseIterable {
    case closeTab, closeWindow, closeOthers, minimize, hide, hideOthers, fullScreen

    private var entry: [String: Any] {
        let all = KeysCore.constants["appKeys"] as? [[String: Any]] ?? []
        return all.indices.contains(rawValue) ? all[rawValue] : [:]
    }
    // For the log: "⌘W".
    var name: String { entry["name"] as? String ?? "#\(rawValue)" }
    var combo: Combo { Combo(keyCode: UInt32(entry["keyCode"] as? Int ?? 0), modifiers: UInt32(entry["modifiers"] as? Int ?? 0)) }
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

// Margin's keys, held while they should be (ShortcutSet.hostedActive) and let go otherwise: the core's holder
// (`AppShortcuts`: the bindings and their ids, the quit guard, the hosted app's keys, a held key's repeat), Carbon
// registering for it and a timer ticking its repeat.
final class AppShortcuts {
    // A command, and whether it's a held key's repeat (not a press).
    var onCommand: ((AppCommand, Bool) -> Void)?
    var onQuit: ((Bool) -> Void)? // which of the two (⌥⌘Q: true)
    var onAppKey: ((AppKey) -> Void)?
    private(set) var isActive = false
    private(set) var guardsQuit = false
    private(set) var guardsAppKeys = false
    // The ones another app holds (tried again each time they're taken).
    private(set) var unavailable: [Combo] = []

    private let registrar: HotKeyRegistrar
    private let keyRepeat: KeyRepeat
    private var cancelTick: (() -> Void)?
    // A held key's repeat as it went (development diagnostics, 2026-11-25: a hold stopped repeating; Margin's log
    // couldn't say why, its repeats are never said one by one): its repeats, when each came, and why it ended, in one
    // line when it ends (`holdEnded`). A press with no repeat says nothing here.
    private var hold: (name: String, at: TimeInterval, repeats: Int, last: TimeInterval, gap: TimeInterval)?
    private func holdEnded(_ why: String) {
        guard let h = hold else { return }
        hold = nil
        guard h.repeats > 0 else { return }
        let ms = { (s: TimeInterval) in Int((s * 1000).rounded()) }
        Diagnostics.note("held \(h.name): \(h.repeats) repeat\(h.repeats == 1 ? "" : "s") in \(ms(h.last - h.at)) ms (the longest between two \(ms(h.gap)) ms), ended: \(why)")
    }
    // The core's holder, and the box its register and unregister reach the registrar through (kept as long as it).
    private var core: OpaquePointer?
    private let box: RegistrarBox

    private final class RegistrarBox {
        let registrar: HotKeyRegistrar
        init(_ registrar: HotKeyRegistrar) { self.registrar = registrar }
    }

    init(registrar: HotKeyRegistrar, bindings: [Combo: AppCommand] = ShortcutSet.bindings, keyRepeat: KeyRepeat = KeyRepeat()) {
        self.registrar = registrar
        self.keyRepeat = keyRepeat
        box = RegistrarBox(registrar)
        core = margin_keys_new(Unmanaged.passUnretained(box).toOpaque(), { ctx, id, key, mods in
            guard let ctx else { return false }
            return MainActor.assumeIsolated { Unmanaged<RegistrarBox>.fromOpaque(ctx).takeUnretainedValue().registrar.register(Combo(keyCode: UInt32(key), modifiers: mods), id: id) }
        }, { ctx, id in
            guard let ctx else { return }
            MainActor.assumeIsolated { Unmanaged<RegistrarBox>.fromOpaque(ctx).takeUnretainedValue().registrar.unregister(id: id) }
        })
        _ = KeysCore.bytes(KeysCore.list(bindings)) { p, n in KeysCore.answer { margin_keys_rebind(core, p, n, $0) } }
        registrar.onHit = { [weak self] id in self?.hit(id) }
        registrar.onRelease = { [weak self] id in
            guard let self else { return }
            margin_keys_release(self.core, id)
            if margin_keys_next_tick(self.core) < 0 { self.cancelTick?(); self.cancelTick = nil; self.holdEnded("its key released") }
        }
    }

    deinit { margin_keys_free(core) }

    // The bindings in their ids' order (the core's).
    var bindings: [(Combo, AppCommand)] {
        let state = KeysCore.answer { margin_keys_state(core, $0) } as? [String: Any]
        return KeysCore.combos(state?["bindings"]).compactMap { c, name in name.flatMap(AppCommand.init(rawValue:)).map { (c, $0) } }
    }

    // ---- the quit guard ----
    // ⌘Q and ⌥⌘Q (a browser's Quit and Keep Windows), taken while Margin or an app it hosts is in front and Margin asks
    // before it quits (ShortcutSet.guardsQuit, held by Shell.updateHostedKeys): Margin's first, so the key in a hosted
    // app never quits that app alone and leaves Margin with a dead item; Margin's own prompt comes up instead
    // (ShellQuit.swift, QuitPrompt.swift), and its Quit gives every hosted app back. Held apart from Margin's own keys,
    // by their own rule. Never held otherwise: ⌘Q is the front app's as it always was.
    static var quitCombos: [(combo: Combo, keepWindows: Bool)] {
        (KeysCore.constants["quit"] as? [[String: Any]] ?? []).map { (Combo(keyCode: UInt32($0["keyCode"] as? Int ?? 0), modifiers: UInt32($0["modifiers"] as? Int ?? 0)), $0["keepWindows"] as? Bool ?? false) }
    }

    func setQuitGuard(active: Bool) {
        guard active != guardsQuit else { return }
        guardsQuit = active
        let answer = KeysCore.answer { margin_keys_set_quit_guard(core, active, $0) } as? [String: Any]
        for (combo, _) in KeysCore.combos(answer?["taken"]) { Diagnostics.warn("\(combo) is another app's: Margin can't ask before it quits by it") }
    }

    // ---- a hosted app's own keys that would undo its hosting (Tirth, 2026-11-19) ----
    // Taken while an app Margin hosts is in front (ShortcutSet.guardsAppKeys), never while Margin itself is (its own menu
    // has them: Close Tab, Close Window, Minimize, Hide) or another app is. Without them, ⌘W in a hosted Safari closed
    // its window and every tab Margin had there (seen 2026-11-19 10:55:40), ⌘M or ⌃⌘F took the window out of Margin's
    // Space, ⌘H hid it, ⌥⌘H hid Margin. Each one's run by Shell.runAppKey for the window that has the keys.
    static var appKeyCombos: [(combo: Combo, key: AppKey)] { AppKey.allCases.map { ($0.combo, $0) } }

    func setAppKeyGuard(active: Bool) {
        guard active != guardsAppKeys else { return }
        guardsAppKeys = active
        let answer = KeysCore.answer { margin_keys_set_app_key_guard(core, active, $0) } as? [String: Any]
        for (combo, _) in KeysCore.combos(answer?["taken"]) { Diagnostics.warn("\(combo) is another app's: a hosted app keeps it") }
    }

    // New combinations (the copy's `keys`): held at once if the keys are held now; the same ones again: nothing.
    func rebind(_ next: [Combo: AppCommand]) {
        let answer = KeysCore.bytes(KeysCore.list(next)) { p, n in KeysCore.answer { margin_keys_rebind(core, p, n, $0) } } as? [String: Any]
        taken(answer?["taken"], fresh: true)
    }

    func set(active: Bool) {
        guard active != isActive else { return }
        isActive = active
        let answer = KeysCore.answer { margin_keys_set_active(core, active, $0) } as? [String: Any]
        if active { taken(answer?["taken"], fresh: true) } else { cancelTick?(); cancelTick = nil; holdEnded("Margin's keys let go") }
    }

    // The ones another app holds, just found so (a hold or a rebind while held), said once each.
    private func taken(_ value: Any?, fresh: Bool) {
        let list = KeysCore.combos(value)
        if !isActive { return }
        if fresh {
            let state = KeysCore.answer { margin_keys_state(core, $0) } as? [String: Any]
            unavailable = KeysCore.combos(state?["unavailable"]).map(\.0)
        }
        for (combo, name) in list { Diagnostics.warn("\(combo) (\(name ?? "?")) is another app's: not Margin's") }
    }

    // ---- a press and a held key's repeat ----

    private func hit(_ id: UInt32) {
        let t = keyRepeat.now()
        let h = margin_keys_press(core, id, t, max(0, keyRepeat.delay()), max(0, keyRepeat.interval()))
        // (One of Margin's keys: any repeat before it is over; the guards' keys leave it running.)
        if h.kind == 1 { cancelTick?(); cancelTick = nil; holdEnded("another press") }
        run(h)
        if h.kind == 1 { scheduleTick(from: t) }
        if h.kind == 1, margin_keys_next_tick(core) >= 0, KeysCore.commands.indices.contains(Int(h.index)) {
            hold = (KeysCore.commands[Int(h.index)], t, 0, t, 0)
        }
    }

    private func run(_ h: MarginKeyHit) {
        switch h.kind {
        case 1:
            guard KeysCore.commands.indices.contains(Int(h.index)), let command = AppCommand(rawValue: KeysCore.commands[Int(h.index)]) else { return }
            onCommand?(command, h.repeat)
        case 2:
            onQuit?(h.index == 1)
        case 3:
            if let key = AppKey(rawValue: Int(h.index)) { onAppKey?(key) }
        default:
            break
        }
    }

    // The repeat's next tick, `from` the time of the press or tick just run (the core says when it's due).
    private func scheduleTick(from t: TimeInterval) {
        let due = margin_keys_next_tick(core)
        guard due >= 0 else { return }
        cancelTick = keyRepeat.after(max(0, due - t)) { [weak self] in self?.tick(due) }
    }

    private func tick(_ due: TimeInterval) {
        cancelTick = nil
        let t = max(due, keyRepeat.now())
        let mods = keyRepeat.modifiers()
        let h = margin_keys_tick(core, t, mods)
        if h.kind == 1, let held = hold { hold = (held.name, held.at, held.repeats + 1, t, max(held.gap, t - held.last)) }
        run(h)
        scheduleTick(from: t)
        if margin_keys_next_tick(core) < 0 {
            let down = [(cmdKey, "⌘"), (optionKey, "⌥"), (controlKey, "⌃"), (shiftKey, "⇧")].filter { mods & UInt32($0.0) != 0 }.map(\.1).joined()
            holdEnded("its modifiers no longer down, or Margin's keys not held (down now: \(down.isEmpty ? "none" : down))")
        }
    }
}
