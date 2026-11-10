// DEV-HOOK: this whole file goes before production, with every line marked DEV-HOOK in the other
// files and tools/handoff-lab/devswitch.swift (docs/HANDOFF.md §9; `git grep DEV-HOOK` finds them all).
//
// A dev-only test hook for the profile handoff's live runs (gates G1 and G16, TESTING.md's live
// checklist), with no Accessibility, no AppleScript and no clicks:
//
// - Distributed notifications, `io.tirth.margin.dev.<kind>`, as ExtensionLink hears the extension's
//   (its fields in userInfo, or a JSON string as the object). Sent by tools/handoff-lab/devswitch.swift
//   or the lab, with deliverImmediately (and heard that way too, so Margin.app not being the active app
//   holds nothing back).
// - Off unless `defaults write io.tirth.margin MarginDevHooks -bool YES`. Read at each notification,
//   never kept: turned off, the next one is refused.
// - Only Safari's "Test A" and "Test B": Safari's own names for the profiles (SafariProfiles.swift,
//   read with Full Disk Access), exactly, never the names typed in Margin. The window Margin shows now
//   must be one of theirs, and a switch's target the other one. With no names read, everything is
//   refused. The caps and faults it sets are used only by a switch between those two profiles, checked
//   again (the default and both names) as each switch starts. So no other profile can ever be reached
//   through it, whatever is sent.
// - The kinds:
//   - `switch { to: "Test B", space? }`: a switch from the window shown, as a key press would;
//   - `dump`: the registry, the choices, the private calls, the aftercare and the last 5 switch lines;
//   - `mode { freeze: on|off, old: park|close|keep }`: caps Test A and Test B's choices for the session;
//   - `fail { step: show|park|reveal|fullscreen }`: the next such step of a Test A/Test B switch counts
//     as not landed, and its call isn't made. A reveal is the one exception: the screen is revealed
//     anyway (it must never stay held) and the reveal counted as failed.
//   - `probe { what: tabMove }`: Test A's copy's one-shot tab-move probe (docs/BROWSER-WINDOWS.md: tabs following the
//     window in front): one tab and one window made, the tab moved there and back, what survived, closed
//     again. Only Test A's (by Safari's name), whatever window is shown; its answer is numbers and booleans.
// - Each notification is one log line, honoured or refused: the kind, "Test A" or "Test B", ids and the
//   sender's pid (as it says it). Nothing else it sent is ever logged.

import AppKit

// DEV-HOOK: a step the dev hook can make count as not landed (HANDOFF.md §9).
enum DevFailStep: String, CaseIterable {
    case show // a parked B's show
    case park // A's park
    case reveal // the first freeze's reveal
    case fullscreen // B's full-screen request (not a new window's: its copy asks for that itself)

    // As the machine's log says it when it's used.
    var said: String {
        self == .reveal ? "the reveal counted as failed (it was made: the screen is never held)"
            : "the \(rawValue == "fullscreen" ? "full-screen request" : rawValue) counted as not landed (the call not made)"
    }
}

// DEV-HOOK: what the dev hook set for the session (ProfileSwitch.session.dev). Only a switch between
// Test A and Test B uses it (HandoffRun.devTest).
struct DevHookState: Equatable {
    var freeze: Bool? // false: no freeze
    var old: HandoffChoice.Old? // close: no park; keep: neither park nor close
    var fails: Set<DevFailStep> = []

    var isEmpty: Bool { freeze == nil && old == nil && fails.isEmpty }

    // The switch's choices with the caps on. A cap only takes away: `freeze: on` and `old: park` are no cap.
    func capped(_ choice: HandoffChoice) -> HandoffChoice {
        var c = choice
        var why: [String] = []
        if freeze == false, c.freeze {
            c.freeze = false
            why.append("no freeze")
        }
        if let old {
            let rank: [HandoffChoice.Old: Int] = [.park: 0, .close: 1, .keep: 2]
            if rank[old]! > rank[c.old]! {
                c.old = old
                why.append(old.rawValue)
            }
        }
        if !why.isEmpty { c.why = ([c.why].compactMap { $0 } + ["the dev hook's cap: " + why.joined(separator: ", ")]).joined(separator: "; ") }
        return c
    }

    // Armed for this step: used up now.
    mutating func take(_ step: DevFailStep) -> Bool { fails.remove(step) != nil }

    var description: String {
        let caps = [freeze == false ? "freeze off" : nil, old.flatMap { $0 == .park ? nil : "old \($0.rawValue)" }].compactMap { $0 }
        let armed = fails.map(\.rawValue).sorted()
        return (caps.isEmpty ? "no caps" : caps.joined(separator: ", ")) + "; " + (armed.isEmpty ? "no faults armed" : "armed: " + armed.joined(separator: ", "))
    }
}

// DEV-HOOK: what the hook needs from the shell (Shell, below; the tests' fake).
protocol DevHookWorld: AnyObject {
    // Safari's own name for this link's profile, from the last read of Safari's files; nil: none read.
    func devSafariName(_ link: String) -> String?
    // The links whose Safari name is exactly this.
    func devSafariLinks(named name: String) -> [String]
    // The window Margin shows now (where the last switch landed, else the one with its overlay up).
    func devShownWindow() -> WindowKey?
    // A switch from `from` to that profile's space (nil: the space it would show). Nil if it started;
    // else why not, in Margin's words (ids only).
    func devSwitch(from: WindowKey, to link: String, space: String?) -> String?
    // The dump's lines (ids, numbers, ms only).
    func devDump() -> [String]
    // A probe asked of this link's copy (Test A's); nil if asked, else why not. Its answer is logged.
    func devProbe(_ link: String, _ what: String) -> String?
    var devState: DevHookState { get set }
}

// DEV-HOOK: the hook itself.
final class DevHooks {
    static let names: Set<String> = ["Test A", "Test B"]
    static let prefix = "io.tirth.margin.dev."
    static let defaultsKey = "MarginDevHooks"
    enum Kind: String, CaseIterable { case `switch`, dump, mode, fail, probe }

    weak var world: DevHookWorld?
    let isOn: () -> Bool // the MarginDevHooks default, read each time
    private var receiver: Receiver?
    private(set) var lines: [String] = [] // what it said (the tests read it)

    init(world: DevHookWorld, isOn: @escaping () -> Bool) {
        self.world = world
        self.isOn = isOn
    }

    static func appDefault() -> Bool { UserDefaults.standard.bool(forKey: defaultsKey) }

    func listen(_ center: DistributedNotificationCenter = .default()) {
        guard receiver == nil else { return }
        let r = Receiver { [weak self] name, fields in
            guard let self, name.hasPrefix(Self.prefix), let kind = Kind(rawValue: String(name.dropFirst(Self.prefix.count))) else { return }
            self.heard(kind, fields)
        }
        for kind in Kind.allCases {
            center.addObserver(r, selector: #selector(Receiver.heard(_:)), name: NSNotification.Name(Self.prefix + kind.rawValue), object: nil, suspensionBehavior: .deliverImmediately)
        }
        receiver = r
        Diagnostics.note("dev hook: listening for \(Self.prefix)* (honoured only while \(Self.defaultsKey) is YES, now \(isOn() ? "YES" : "off"), and only for Safari's Test A and Test B)")
    }

    func stop(_ center: DistributedNotificationCenter = .default()) {
        guard let r = receiver else { return }
        center.removeObserver(r)
        receiver = nil
    }

    // Whether a switch between these two links may use what the hook set: the default on, and both
    // profiles Safari's Test A and Test B (one each).
    func allows(_ a: String, _ b: String) -> Bool {
        guard isOn(), let world, a != b, let na = world.devSafariName(a), let nb = world.devSafariName(b) else { return false }
        return Self.names.contains(na) && Self.names.contains(nb) && na != nb
    }

    // One notification: honoured or refused, one line either way (returned).
    @discardableResult func heard(_ kind: Kind, _ fields: [String: String]) -> String {
        let pid = fields["pid"].flatMap { Int($0) }.map(String.init) ?? "?"
        let asked = "(asked by pid \(pid))"
        func refuse(_ why: String) -> String { say("dev hook: \(Self.prefix)\(kind.rawValue) refused: \(why) \(asked)") }
        guard isOn() else { return refuse("\(Self.defaultsKey) isn't YES") }
        guard let world else { return refuse("no shell") }
        // A probe acts only in Test A's own copy, whatever window is shown.
        if kind == .probe {
            guard fields["what"] == "tabMove" else { return refuse("a probe that isn't tabMove") }
            let links = world.devSafariLinks(named: "Test A")
            guard links.count == 1, let link = links.first, world.devSafariName(link) == "Test A" else { return refuse("\(links.count) Safari profiles named Test A") }
            if let why = world.devProbe(link, "tabMove") { return refuse(why) }
            return say("dev hook: probe tabMove in Test A (\(link)) \(asked)")
        }
        guard let shown = world.devShownWindow() else { return refuse("no window shown") }
        guard let here = world.devSafariName(shown.link) else { return refuse("the window shown has no name from Safari (Full Disk Access, or not a Safari profile)") }
        guard Self.names.contains(here) else { return refuse("the window shown isn't Test A's or Test B's") }
        switch kind {
        case .switch:
            guard let to = fields["to"], Self.names.contains(to) else { return refuse("a target that isn't exactly Test A or Test B") }
            guard to != here else { return refuse("\(to)'s window is the one shown") }
            let links = world.devSafariLinks(named: to)
            guard links.count == 1, let link = links.first else { return refuse("\(links.count) Safari profiles named \(to)") }
            guard world.devSafariName(link) == to else { return refuse("\(to) isn't named so any more") }
            var space: String?
            if let s = fields["space"] {
                guard Self.plainId(s) else { return refuse("a space id that isn't a plain id") }
                space = s
            }
            if let why = world.devSwitch(from: shown, to: link, space: space) { return refuse(why) }
            return say("dev hook: switch to \(to)\(space.map { ", space \($0)" } ?? "") from \(shown) \(asked)")
        case .dump:
            let line = say("dev hook: dump \(asked)")
            for l in world.devDump() { say("dev hook: dump: " + l) }
            return line
        case .mode:
            var state = world.devState
            var set: [String] = []
            if let f = fields["freeze"] {
                guard f == "on" || f == "off" else { return refuse("freeze isn't on or off") }
                state.freeze = f == "on" ? nil : false
                set.append("freeze \(f)")
            }
            if let o = fields["old"] {
                guard let old = HandoffChoice.Old(rawValue: o) else { return refuse("old isn't park, close or keep") }
                state.old = old == .park ? nil : old
                set.append("old \(o)")
            }
            guard !set.isEmpty else { return refuse("neither freeze nor old") }
            world.devState = state
            return say("dev hook: mode \(set.joined(separator: ", ")) for Test A and Test B's switches this session (\(state.description)) \(asked)")
        case .probe:
            return refuse("unreachable")
        case .fail:
            guard let s = fields["step"], let step = DevFailStep(rawValue: s) else { return refuse("a step that isn't show, park, reveal or fullscreen") }
            world.devState.fails.insert(step)
            return say("dev hook: fail: the next \(step.rawValue) of a Test A/Test B switch counts as not landed (\(world.devState.description)) \(asked)")
        }
    }

    @discardableResult private func say(_ line: String) -> String {
        lines.append(line)
        Diagnostics.note(line)
        return line
    }

    static func plainId(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 64 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    // A notification's fields: userInfo's strings, then a JSON string object's (the extension's way).
    nonisolated static func fields(object: Any?, userInfo: [AnyHashable: Any]?) -> [String: String] {
        var out: [String: String] = [:]
        func take(_ k: AnyHashable, _ v: Any) {
            guard let key = k as? String, key.count <= 16 else { return }
            if let s = v as? String, s.count <= 64 { out[key] = s } else if let n = v as? NSNumber { out[key] = n.stringValue }
        }
        if let text = object as? String, text.count <= 1024, let data = text.data(using: .utf8),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            for (k, v) in json { take(k, v) }
        }
        for (k, v) in userInfo ?? [:] { take(k, v) }
        return out
    }

    // The observer: on the main thread (the run loop it was added on).
    private final class Receiver: NSObject {
        let fire: (String, [String: String]) -> Void
        init(_ fire: @escaping (String, [String: String]) -> Void) { self.fire = fire }
        @objc nonisolated func heard(_ note: Notification) {
            let name = note.name.rawValue
            let fields = DevHooks.fields(object: note.object, userInfo: note.userInfo)
            MainActor.assumeIsolated { fire(name, fields) }
        }
    }
}

// DEV-HOOK: the shell's side.
extension Shell: DevHookWorld {
    func devSafariName(_ link: String) -> String? {
        guard link.hasPrefix("safari:") else { return nil }
        return profilesOf("safari").browserNames[SwitchNotice.profileId(link)]?.name
    }

    func devProbe(_ link: String, _ what: String) -> String? {
        guard isLinked(link) else { return "Test A isn't linked: open one of its windows" }
        // The page it opens: a plain one, here and not in the extension (no third-party address there).
        request(link, "devTabMoveProbe", ["what": what, "url": "https://example.com/"], windowId: nil) { result, error in
            // Numbers and booleans only (the copy's summary), scrubbed and cut short all the same.
            let said = (result?["summary"] as? String).map { Diagnostics.scrub($0, max: 600) } ?? "none"
            Diagnostics.note("dev hook: probe \(what): \(error.map { "failed: " + Diagnostics.scrub($0, max: 160) } ?? said)")
        }
        return nil
    }

    func devSafariLinks(named name: String) -> [String] {
        profilesOf("safari").browserNames.filter { $0.value.name == name }.keys.sorted().map { "safari:\($0)" }
    }

    // Where the last switch landed, or the one in front with its overlay; else the one Safari window
    // with its overlay up (Safari needn't be in front: the sender runs in a terminal).
    func devShownWindow() -> WindowKey? {
        if let key = shownWindow() { return key }
        let up = overlays.values.filter { $0.isShown && $0.key.link.hasPrefix("safari:") && !isParkedKey($0.key) }
        return up.count == 1 ? up[0].key : nil
    }

    func devSwitch(from: WindowKey, to link: String, space: String?) -> String? {
        let profile = SwitchNotice.profileId(link)
        let order = profilesOf("safari").order.filter { $0.profile == profile }
        let chosen: String?
        if let space {
            guard order.contains(SpaceKey(profile: profile, space: space)) else { return "space \(space) isn't one of that profile's" }
            chosen = space
        } else {
            // The space its home window shows (parked or not), else its first in the order.
            let home = parking?.lastShown[link].flatMap { n in parking?.entries[n]?.key ?? key(of: n) }
            chosen = home.flatMap { spaceFor($0, tabId: nil) } ?? order.first?.space
        }
        guard let space = chosen else { return "that profile has no spaces" }
        switcher.start(.init(profile: link, space: space), from: from.link, windowId: from.windowId)
        burst("dev hook")
        acrossSoon()
        return nil
    }

    func devDump() -> [String] {
        var out: [String] = []
        let a = privateCalls
        out.append("handoff \(handoffOn ? "on" : "off"), parking \(parkingOn ? "on" : "off") (self-test \(parkSelfTest.passed ? "passed" : "not passed")); private calls: freeze \(a.freeze ? "ok" : "off"), spaces \(a.spaces ? "ok" : "off"), park \(a.park ? "ok" : "off"), enumerator \(a.enumerator ? "ok" : "off"), \(a.missing.count) missing, \(a.mismatched.count) encodings changed")
        let s = switcher.session
        let displays = spaceReads?.managedDisplayCount().map(String.init) ?? "unread"
        out.append("choices: freeze \(s.rules.on ? "on" : "off (\(s.rules.off ?? "-"))"), \(s.rules.watchdogs) watchdog reveals; park \(s.parkOff.map { "off (\($0))" } ?? "on"); close windows \(profilesOf("safari").closeWindows ? "on" : "off"); displays \(displays); the dev hook: \(s.dev.description)")
        out.append("switch: \(switcher.phase.rawValue)\(switcher.target.map { " to \($0)" } ?? ""); shown \(s.shown.map { "\($0.key) (\($0.number.map(String.init) ?? "-"))" } ?? "-"); \(s.runs) handoffs, \(s.pending.count) windows calls pending")
        if let parking {
            let now = options.switchClock.now()
            out.append("registry: \(parking.entries.count) parked; home windows \(parking.lastShown.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", "))")
            for e in parking.entries.values.sorted(by: { $0.number < $1.number }) {
                out.append("  window \(e.number) (\(e.label)) \(e.phase.rawValue), Space \(e.space.map(String.init) ?? "-"), pid \(e.pid), for \(Int((now - e.since).rounded())) s")
            }
        } else {
            out.append("registry: none (no parker)")
        }
        let now = options.switchClock.now()
        out.append("aftercare: \(s.watches.count) watched")
        for w in s.watches {
            out.append("  window \(w.number) (\(w.key.map(\.description) ?? "-")) \(w.kind == .parkWhenNormal ? "park when normal" : "leave full screen")\(w.landsLate ? ", may land late" : ""), \(w.cause), \(String(format: "%.1f", max(0, w.until - now))) s left")
        }
        out.append("the last \(s.lines.count) switch lines:")
        out += s.lines.map { "  " + $0 }
        return out
    }

    var devState: DevHookState {
        get { switcher.session.dev }
        set { switcher.session.dev = newValue }
    }

    // HandoffWorld's: whether this switch may use what the hook set.
    func devHookAllows(_ a: String, _ b: String) -> Bool { devHooks?.allows(a, b) ?? false }
}
