// Chameleon's switches (docs/HOSTING-CORE.md, "Behaviour classes and the test framework"): one per behaviour class a
// real app has shown, read from the app's own defaults at launch (`defaults write test.margin.chameleon.N
// Chameleon<Name> <value>`, or `-Chameleon<Name> <value>` as a launch argument). Pure Foundation: compiled into
// Chameleon (main.swift), into the app's unit checks (the stand-in world, app/platforms/macos/shell/tests/
// behaviour-world.swift, plays the same switches) and read by the real-screen suite (tools/screen-tests/suite) for
// its plan. Nothing here touches a window.
//
// Values (all off by default; a switch that doesn't parse is off and named in `errors`):
//   restore        <n>[:normal|fullscreen|both][:system|code]   n windows (1-4) come back at launch: none, all or the
//                  first in full screen. `system` (the default): AppKit's own state restoration (a priming run saved
//                  them; `ChameleonPrime`), so macOS restores full screen at launch the way it does Maps' and Safari's
//                  (the Dock makes the Space as the app launches); `code`: made by the app and asked into full screen
//                  in applicationDidFinishLaunching.
//   windowless     YES | close:<s>        stays running when its last window closes (off: a single-window app that
//                  quits then); `close:<s>`: also closes its own window <s> after it's first on screen.
//   autoTerminate  system | attempt:<s> | quit:<s>   `system`: AppKit's automatic termination on (macOS may end it
//                  while it has no visible window; `-NSDisableAutomaticTermination YES` is what should stop it);
//                  `attempt`: after <s> with no window on screen it attempts to terminate (logged), background-only
//                  meanwhile, and stays running (UIKit's "isAttemptingTermination", Maps); `quit`: it really quits then.
//   dialogMain     YES                    its main window's Accessibility subrole is AXDialog (the Phone's).
//   ordersOut      untilActive | after:<s> | every:<s>   its main window never ordered in until the app is activated;
//                  ordered out <s> after first on screen (back in at its next activation); out and back in every <s>.
//   replacesWindow every:<s>[,twin] | twin   closes its main window and makes a new one at the same frame every <s>;
//                  `twin`: a second window at the same frame, behind it (Messages).
//   axBusy         <s>                    its main thread blocked <s> as its window first shows (Accessibility then
//                  answers kAXErrorCannotComplete, -25200: Mail launching).
//   strip          fullscreen | linger | at:<s>,for:<s>   a full-width window 88 tall across the screen's top: made as
//                  its main window enters full screen (gone as it leaves; `linger`: left after the exit, gone at the
//                  next change); `at`/`for`: made <s> after launch for <s> (check10's step x).
//   auxiliary      settings | sidebar | <w>x<h>+<x>+<y> [,at:<s>][,for:<s>][,borderless]   an extra window like a
//                  settings one: centred 520×420, or 1000×800 at the screen's top left (over Margin's sidebar), or
//                  that frame (top-left coordinates); at launch or <s> after, for <s> or for good.
//   noFullScreen   YES                    its windows can't go full screen (no full-screen button).
//   fixedSize      YES | <w>x<h>          its main window can't be resized (400×300 by default).
//   minSize        <w>x<h>                its main window's own minimum content size (AppKit's `contentMinSize`; with a
//                  full-size content view that's its frame's): a full-screen tile narrower than it can't hold it (Weather,
//                  about 1048 wide; the window server's tile then says it as `SizeConstraints`' `Min`).
//   extraWindow    menu | at:<s>          another main-kind window opened on demand: File › New Window (⌘N), a
//                  `test.margin.chameleon.extraWindow` distributed notification naming its bundle id (the suite's
//                  way: no permission), or by itself <s> after launch (like Safari's window woken for a profile).
import Foundation
import CoreGraphics

struct ChameleonSwitches: Equatable {
    enum RestoreMode: String, Equatable { case normal, fullscreen, both }
    enum RestoreVia: String, Equatable { case system, code }
    struct Restore: Equatable {
        var count: Int
        var mode: RestoreMode
        var via: RestoreVia
        // Which of the windows come back in full screen: all, none, or the first only (`both`).
        var fullScreen: [Bool] { (0..<count).map { i in mode == .fullscreen || (mode == .both && i == 0) } }
    }
    enum Windowless: Equatable { case stays, closesAfter(Double) }
    enum AutoTerminate: Equatable { case system, attempt(after: Double), quit(after: Double) }
    enum OrdersOut: Equatable { case untilActive, after(Double), every(Double) }
    struct Replaces: Equatable { var every: Double?; var twin: Bool }
    enum Strip: Equatable { case onFullScreen(linger: Bool), timed(at: Double, lasts: Double) }
    struct Auxiliary: Equatable {
        enum Place: Equatable { case settings, sidebar, rect(CGRect) }
        var place: Place
        var at: Double?
        var lasts: Double?
        var borderless: Bool
    }
    enum Extra: Equatable { case menu, at(Double) }

    var restore: Restore?
    var windowless: Windowless?
    var autoTerminate: AutoTerminate?
    var dialogMain = false
    var ordersOut: OrdersOut?
    var replacesWindow: Replaces?
    var axBusy: Double?
    var strip: Strip?
    var auxiliary: Auxiliary?
    var noFullScreen = false
    var fixedSize: CGSize?
    var minSize: CGSize?
    var extraWindow: Extra?
    var errors: [String] = []

    static let names = ["restore", "windowless", "autoTerminate", "dialogMain", "ordersOut", "replacesWindow", "axBusy",
                        "strip", "auxiliary", "noFullScreen", "fixedSize", "minSize", "extraWindow"]
    // The defaults key of a switch: `Chameleon` and its name with a capital (ChameleonAxBusy).
    static func key(_ name: String) -> String { "Chameleon" + name.prefix(1).uppercased() + name.dropFirst() }
    // Keys the suite also sets: the priming launch (`restore` by the system), and where the app logs.
    static let primeKey = "ChameleonPrime", logKey = "ChameleonLog"
    static let extraWindowNotification = "test.margin.chameleon.extraWindow"
    static let defaultFixedSize = CGSize(width: 400, height: 300)
    static let stripHeight: CGFloat = 88

    // From a defaults lookup (a key → its value: a string, a number or a bool), as the app reads them at launch.
    static func read(_ lookup: (String) -> Any?) -> ChameleonSwitches {
        var raw: [String: String] = [:]
        for name in names {
            switch lookup(key(name)) {
            case let s as String: raw[name] = s
            case let n as NSNumber: raw[name] = CFGetTypeID(n) == CFBooleanGetTypeID() ? (n.boolValue ? "YES" : "NO") : n.stringValue
            default: break
            }
        }
        return parse(raw)
    }

    // From each switch's text (its name → value); missing, empty or NO: off.
    static func parse(_ raw: [String: String]) -> ChameleonSwitches {
        var s = ChameleonSwitches()
        for name in names {
            guard let text = raw[name]?.trimmingCharacters(in: .whitespaces), !text.isEmpty, !isNo(text) else { continue }
            if !s.set(name, text) { s.errors.append("\(name)=\(text)") }
        }
        return s
    }

    private static func isYes(_ t: String) -> Bool { ["1", "yes", "true", "on"].contains(t.lowercased()) }
    private static func isNo(_ t: String) -> Bool { ["0", "no", "false", "off"].contains(t.lowercased()) }
    private static func seconds(_ t: Substring) -> Double? { Double(t).flatMap { $0.isFinite && $0 >= 0 && $0 <= 600 ? $0 : nil } }
    // `key:value` tokens split by commas: at:3,for:5 → ["at": "3", "for": "5"]; bare words → value "".
    private static func tokens(_ t: String) -> [(String, Substring)] {
        t.split(separator: ",").map { part in
            let kv = part.split(separator: ":", maxSplits: 1)
            return (kv[0].trimmingCharacters(in: .whitespaces).lowercased(), kv.count > 1 ? kv[1] : "")
        }
    }
    private static func size(_ t: Substring) -> CGSize? {
        let p = t.lowercased().split(separator: "x")
        guard p.count == 2, let w = Double(p[0]), let h = Double(p[1]), (50...4000).contains(w), (50...4000).contains(h) else { return nil }
        return CGSize(width: w, height: h)
    }

    private mutating func set(_ name: String, _ text: String) -> Bool {
        switch name {
        case "restore":
            var count = 1, mode = RestoreMode.normal, via = RestoreVia.system
            for part in text.split(whereSeparator: { $0 == ":" || $0 == "," }) {
                if let n = Int(part) { guard (1...4).contains(n) else { return false }; count = n }
                else if let m = RestoreMode(rawValue: part.lowercased()) { mode = m }
                else if let v = RestoreVia(rawValue: part.lowercased()) { via = v }
                else { return false }
            }
            restore = Restore(count: count, mode: mode, via: via)
        case "windowless":
            if Self.isYes(text) { windowless = .stays; return true }
            guard let (k, v) = Self.tokens(text).first, k == "close", let s = Self.seconds(v) else { return false }
            windowless = .closesAfter(s)
        case "autoTerminate":
            guard let (k, v) = Self.tokens(text).first else { return false }
            let after = v.isEmpty ? 5 : Self.seconds(v)
            switch (k, after) {
            case ("system", _): autoTerminate = .system
            case ("attempt", let a?): autoTerminate = .attempt(after: a)
            case ("quit", let a?): autoTerminate = .quit(after: a)
            default: return false
            }
        case "dialogMain":
            guard Self.isYes(text) else { return false }
            dialogMain = true
        case "ordersOut":
            guard let (k, v) = Self.tokens(text).first else { return false }
            switch k {
            case "untilactive": ordersOut = .untilActive
            case "after": guard let s = Self.seconds(v) else { return false }; ordersOut = .after(s)
            case "every": guard let s = Self.seconds(v), s >= 0.5 else { return false }; ordersOut = .every(s)
            default: return false
            }
        case "replacesWindow":
            var r = Replaces(every: nil, twin: false)
            for (k, v) in Self.tokens(text) {
                switch k {
                case "every": guard let s = Self.seconds(v), s >= 0.5 else { return false }; r.every = s
                case "twin": r.twin = true
                default: return false
                }
            }
            replacesWindow = r
        case "axBusy":
            guard let s = Double(text), s > 0, s <= 30 else { return false }
            axBusy = s
        case "strip":
            let t = Self.tokens(text)
            if t.count == 1, t[0].0 == "fullscreen" { strip = .onFullScreen(linger: false); return true }
            if t.count == 1, t[0].0 == "linger" { strip = .onFullScreen(linger: true); return true }
            let d = Dictionary(t, uniquingKeysWith: { a, _ in a })
            guard let at = d["at"].flatMap(Self.seconds), let lasts = d["for"].flatMap(Self.seconds), lasts > 0, d.count == 2 else { return false }
            strip = .timed(at: at, lasts: lasts)
        case "auxiliary":
            var parts = Self.tokens(text)
            guard !parts.isEmpty else { return false }
            let first = text.split(separator: ",")[0].trimmingCharacters(in: .whitespaces)
            parts.removeFirst()
            var a: Auxiliary
            switch first.lowercased() {
            case "settings": a = Auxiliary(place: .settings, at: nil, lasts: nil, borderless: false)
            case "sidebar": a = Auxiliary(place: .sidebar, at: nil, lasts: nil, borderless: false)
            default:
                // <w>x<h>+<x>+<y>
                let p = first.split(separator: "+")
                guard p.count == 3, let sz = Self.size(p[0]), let x = Double(p[1]), let y = Double(p[2]) else { return false }
                a = Auxiliary(place: .rect(CGRect(x: x, y: y, width: sz.width, height: sz.height)), at: nil, lasts: nil, borderless: false)
            }
            for (k, v) in parts {
                switch k {
                case "at": guard let s = Self.seconds(v) else { return false }; a.at = s
                case "for": guard let s = Self.seconds(v), s > 0 else { return false }; a.lasts = s
                case "borderless": a.borderless = true
                default: return false
                }
            }
            auxiliary = a
        case "noFullScreen":
            guard Self.isYes(text) else { return false }
            noFullScreen = true
        case "fixedSize":
            if Self.isYes(text) { fixedSize = Self.defaultFixedSize; return true }
            guard let sz = Self.size(Substring(text)) else { return false }
            fixedSize = sz
        case "minSize":
            guard let sz = Self.size(Substring(text)) else { return false }
            minSize = sz
        case "extraWindow":
            if Self.isYes(text) || text.lowercased() == "menu" { extraWindow = .menu; return true }
            guard let (k, v) = Self.tokens(text).first, k == "at", let s = Self.seconds(v) else { return false }
            extraWindow = .at(s)
        default: return false
        }
        return true
    }

    // Each switch that's on, in a canonical text (what the app logs at launch: `options ... on restore=2:fullscreen:system`).
    var on: [String] {
        func n(_ d: Double) -> String { d == d.rounded() ? String(Int(d)) : String(d) }
        var out: [String] = []
        if let r = restore { out.append("restore=\(r.count):\(r.mode.rawValue):\(r.via.rawValue)") }
        switch windowless { case .stays?: out.append("windowless=YES"); case .closesAfter(let s)?: out.append("windowless=close:\(n(s))"); case nil: break }
        switch autoTerminate {
        case .system?: out.append("autoTerminate=system")
        case .attempt(let a)?: out.append("autoTerminate=attempt:\(n(a))")
        case .quit(let a)?: out.append("autoTerminate=quit:\(n(a))")
        case nil: break
        }
        if dialogMain { out.append("dialogMain=YES") }
        switch ordersOut { case .untilActive?: out.append("ordersOut=untilActive"); case .after(let s)?: out.append("ordersOut=after:\(n(s))"); case .every(let s)?: out.append("ordersOut=every:\(n(s))"); case nil: break }
        if let r = replacesWindow { out.append("replacesWindow=" + ([r.every.map { "every:\(n($0))" }, r.twin ? "twin" : nil].compactMap { $0 }.joined(separator: ","))) }
        if let b = axBusy { out.append("axBusy=\(n(b))") }
        switch strip { case .onFullScreen(let l)?: out.append("strip=\(l ? "linger" : "fullscreen")"); case .timed(let a, let f)?: out.append("strip=at:\(n(a)),for:\(n(f))"); case nil: break }
        if let a = auxiliary {
            var t: String
            switch a.place { case .settings: t = "settings"; case .sidebar: t = "sidebar"; case .rect(let r): t = "\(Int(r.width))x\(Int(r.height))+\(Int(r.minX))+\(Int(r.minY))" }
            if let at = a.at { t += ",at:\(n(at))" }
            if let f = a.lasts { t += ",for:\(n(f))" }
            if a.borderless { t += ",borderless" }
            out.append("auxiliary=" + t)
        }
        if noFullScreen { out.append("noFullScreen=YES") }
        if let f = fixedSize { out.append("fixedSize=\(Int(f.width))x\(Int(f.height))") }
        if let m = minSize { out.append("minSize=\(Int(m.width))x\(Int(m.height))") }
        switch extraWindow { case .menu?: out.append("extraWindow=menu"); case .at(let s)?: out.append("extraWindow=at:\(n(s))"); case nil: break }
        return out
    }

    // A single-window app quits when its last window closes; `windowless` keeps it running.
    var quitsAfterLastWindow: Bool { windowless == nil }
    var canFullScreen: Bool { !noFullScreen }

    // ---- geometry, in the window server's top-left coordinates of a screen `screen` (its whole frame) with a menu bar
    // `menuBar` tall ----
    // The strip: the screen's whole width, 88 tall, right under the menu bar (Mail's 1512×88).
    static func stripFrame(screen: CGRect, menuBar: CGFloat) -> CGRect {
        CGRect(x: screen.minX, y: screen.minY + menuBar, width: screen.width, height: stripHeight)
    }
    // The auxiliary window's frame: a settings window centred, the sidebar one from the screen's top left (under the
    // menu bar) where Margin's sidebar is, or the frame asked for.
    static func auxiliaryFrame(_ place: Auxiliary.Place, screen: CGRect, menuBar: CGFloat) -> CGRect {
        switch place {
        case .settings: return CGRect(x: screen.midX - 260, y: screen.minY + menuBar + max(0, (screen.height - menuBar - 420) / 3), width: 520, height: 420)
        case .sidebar: return CGRect(x: screen.minX, y: screen.minY + menuBar, width: min(1000, screen.width), height: min(800, screen.height - menuBar))
        case .rect(let r): return r
        }
    }
    // The main window's first frame (top-left coordinates): 900×560 (or its fixed size) at 260,220 from the screen's
    // top left, each next window 30 points lower and to the right.
    func mainFrame(index: Int, screen: CGRect) -> CGRect {
        let size = fixedSize ?? CGSize(width: 900, height: 560)
        let step = CGFloat(30 * index)
        return CGRect(x: screen.minX + 260 + step, y: screen.minY + 220 + step, width: size.width, height: size.height)
    }
}

// Window coordinates between the window server's (top left of the main screen, y down) and AppKit's (bottom left, y up).
func chameleonFlip(_ r: CGRect, mainScreenHeight h: CGFloat) -> CGRect { CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height) }
