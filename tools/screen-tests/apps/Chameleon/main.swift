// Chameleon: the behaviour test app of the real-screen suite (tools/screen-tests, docs/HOSTING-CORE.md). A stand-in
// for a real app (from the kit's TestPane: a titled window with a real NSToolbar, a text field, a button, a grid with
// corner markers, a small menu bar) that can misbehave in every way a real app has, one switch per behaviour class
// (Switches.swift), read from its own defaults at launch. Copies with their own bundle ids (test.margin.chameleon.1…3)
// run side by side (build.sh).
//
// It logs every window event it makes and receives to its log file (ChameleonLog, else
// /tmp/margin-screen-tests/<bundle id>.log): windows made, closed, ordered out and in, key and main changes, full-screen
// changes, occlusion (on screen or not), Space changes, reopen and terminate asks and attempts, key presses (their key
// codes only, never characters), clicks (where), the text field's length (never its text). Nothing private: it has
// nothing of anyone's to log.
//
// `Chameleon --describe` (the binary, with switches as launch arguments: `-ChameleonAxBusy 2.5`): prints the switches it
// read and exits, before any of AppKit's application starts (no window, no window-server connection): build.sh's check.
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)
let switches = ChameleonSwitches.read { UserDefaults.standard.object(forKey: $0) }
let bundleId = Bundle.main.bundleIdentifier ?? "chameleon"
if CommandLine.arguments.contains("--describe") {
    print("chameleon \(bundleId): on \(switches.on.isEmpty ? "none" : switches.on.joined(separator: " "))\(switches.errors.isEmpty ? "" : "; unread \(switches.errors.joined(separator: " "))")")
    exit(switches.errors.isEmpty ? 0 : 2)
}

let logPath = UserDefaults.standard.string(forKey: ChameleonSwitches.logKey) ?? "/tmp/margin-screen-tests/\(bundleId).log"
try? FileManager.default.createDirectory(atPath: (logPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
let pid = getpid()
func clog(_ s: String) {
    let line = String(format: "CHAMELEON %.3f ", Date().timeIntervalSince1970) + "pid \(pid) " + s + "\n"
    if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile() }
    else { FileManager.default.createFile(atPath: logPath, contents: line.data(using: .utf8)) }
}
func r(_ f: NSRect) -> String { "\(Int(f.minX)),\(Int(f.minY)) \(Int(f.width))x\(Int(f.height))" }
let priming = UserDefaults.standard.bool(forKey: ChameleonSwitches.primeKey)
let copyName = (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? "Chameleon"

// ---- the window's content (TestPane's grid: blur, crossfades and stale frames show in recordings) ----
final class Grid: NSView {
    var label = ""
    override var isFlipped: Bool { true }
    override func draw(_ dirty: NSRect) {
        NSColor(red: 0.30, green: 0.18, blue: 0.40, alpha: 1).setFill(); bounds.fill()
        NSColor(white: 1, alpha: 0.10).setFill()
        for x in stride(from: 0, to: bounds.width, by: 40) { NSRect(x: x, y: 0, width: 1, height: bounds.height).fill() }
        for y in stride(from: 0, to: bounds.height, by: 40) { NSRect(x: 0, y: y, width: bounds.width, height: 1).fill() }
        ("\(label)  \(Int(bounds.width)) × \(Int(bounds.height))" as NSString).draw(at: NSPoint(x: 24, y: bounds.height - 40), withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 18, weight: .bold), .foregroundColor: NSColor(white: 1, alpha: 0.8)])
        NSColor(red: 1, green: 0.8, blue: 0.2, alpha: 1).setFill(); NSRect(x: bounds.width - 30, y: bounds.height - 30, width: 30, height: 30).fill()
        NSColor(red: 1, green: 0.3, blue: 0.5, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: 30, height: 30).fill()
    }
    // (A click, its drags and its release, each with its count: the pane click checks, a double-click's second is count 2.)
    // (A synthetic record with no place reaching a view: said apart, never counted as a click, never converted (Int() of
    // a location that isn't a number traps).)
    private func placed(_ e: NSEvent) -> String? { let p = e.locationInWindow; return p.x.isFinite && p.y.isFinite ? "\(Int(p.x)),\(Int(p.y))" : nil }
    override func mouseDown(with e: NSEvent) { guard let at = placed(e) else { return clog("synthetic mouse record with no place reached the grid (down)") }; clog("click at \(at) window \(window?.windowNumber ?? 0) count \(e.clickCount)"); window?.makeFirstResponder(nil) }
    override func mouseDragged(with e: NSEvent) { guard let at = placed(e) else { return }; clog("drag at \(at) window \(window?.windowNumber ?? 0)") }
    override func mouseUp(with e: NSEvent) { guard let at = placed(e) else { return clog("synthetic mouse record with no place reached the grid (up)") }; clog("release at \(at) window \(window?.windowNumber ?? 0) count \(e.clickCount)") }
}

// AppKit's state restoration (`restore` by the system): each saved window made again by its identifier; AppKit puts
// back its frame and its full screen itself. A priming run restores none (what an earlier scenario saved is dropped:
// its windows aren't made, so they aren't saved again at its quit; only the priming's own are).
final class Restorer: NSObject, NSWindowRestoration {
    static func restoreWindow(withIdentifier identifier: NSUserInterfaceItemIdentifier, state: NSCoder, completionHandler: @escaping (NSWindow?, Error?) -> Void) {
        if priming {
            clog("priming: an earlier run's window \(identifier.rawValue) not restored (dropped)")
            return completionHandler(nil, NSError(domain: "Chameleon", code: 1, userInfo: [NSLocalizedDescriptionKey: "a priming run restores nothing"]))
        }
        let kind: Kind = identifier.rawValue.hasPrefix("twin") ? .twin : .main
        let w = app.makeWindow(kind, index: app.windows.count, order: false)
        clog("restored window \(w.windowNumber) identifier \(identifier.rawValue)")
        completionHandler(w, nil)
    }
}

enum Kind: String { case main, twin, extra, auxiliary, strip }

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, NSToolbarDelegate, NSTextFieldDelegate {
    var windows: [NSWindow] = [] // every window it made and hasn't closed
    var kinds: [ObjectIdentifier: Kind] = [:]
    var main: NSWindow? { windows.first { kinds[ObjectIdentifier($0)] == .main } }
    var strip: NSWindow?
    var stripLingering = false
    var auxiliary: NSWindow?
    var shownOnce: Set<ObjectIdentifier> = []
    var busyDone = false
    var orderedOutByMe: Set<ObjectIdentifier> = []
    var attempting = false
    var policyBeforeAttempt: NSApplication.ActivationPolicy?
    var noWindowSince: Date?
    var fullScreenQueue: [NSWindow] = []
    var primeDone = false

    var screenFrame: CGRect { NSScreen.screens.first?.frame ?? CGRect(x: 0, y: 0, width: 1512, height: 982) }
    var menuBar: CGFloat { let s = NSScreen.screens.first; return s.map { $0.frame.maxY - $0.visibleFrame.maxY } ?? 33 }
    // A frame in the window server's top-left coordinates, as AppKit's.
    func appKit(_ topLeft: CGRect) -> CGRect { chameleonFlip(topLeft, mainScreenHeight: screenFrame.height) }

    // ---- windows ----
    // `exact`: the AppKit frame it gets before it's ordered in (a replacement or a twin at the old window's frame exactly;
    // `frame` is a content rect, so the title bar and toolbar would land above it: 2026-11-17, the replacements came 40 pt
    // off the old frame and were never taken for replacements).
    @discardableResult func makeWindow(_ kind: Kind, index: Int, order: Bool = true, frame: CGRect? = nil, exact: NSRect? = nil) -> NSWindow {
        let screen = CGRect(origin: .zero, size: screenFrame.size)
        let topLeft = frame ?? switches.mainFrame(index: index, screen: screen)
        var style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        if switches.fixedSize != nil, kind == .main || kind == .twin { style.remove(.resizable) }
        let w = NSWindow(contentRect: appKit(topLeft), styleMask: style, backing: .buffered, defer: false)
        w.title = "\(copyName) \(kind.rawValue)"
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.collectionBehavior = switches.noFullScreen ? [.fullScreenNone] : switches.implicitFullScreen ? [] : [.fullScreenPrimary]
        let tb = NSToolbar(identifier: "chameleon-\(kind.rawValue)"); tb.delegate = self; tb.displayMode = .iconOnly; w.toolbar = tb; w.toolbarStyle = .unified
        let g = Grid(frame: w.contentView!.bounds); g.label = "\(copyName) \(kind.rawValue)"; g.autoresizingMask = [.width, .height]; w.contentView!.addSubview(g)
        let field = NSTextField(string: ""); field.placeholderString = "type here"; field.frame = NSRect(x: 30, y: 150, width: 320, height: 28); field.delegate = self; g.addSubview(field)
        let button = NSButton(title: "Click me", target: self, action: #selector(hit(_:))); button.frame = NSRect(x: 30, y: 200, width: 140, height: 32); g.addSubview(button)
        if kind == .main, switches.dialogMain { w.setAccessibilitySubrole(.dialog) }
        // (Its own minimum, as an app's: a full-screen tile narrower than it can't hold it.)
        if let m = switches.minSize, kind == .main || kind == .twin { w.contentMinSize = m }
        if case .system? = switches.restore?.via, kind == .main || kind == .twin {
            w.isRestorable = true
            w.restorationClass = Restorer.self
            w.identifier = NSUserInterfaceItemIdentifier("\(kind.rawValue)-\(index)")
        } else { w.isRestorable = false }
        windows.append(w)
        kinds[ObjectIdentifier(w)] = kind
        NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: w, queue: .main) { [weak self] _ in self?.occlusion(w) }
        if let exact { w.setFrame(exact, display: false) }
        clog("window made \(w.windowNumber) kind \(kind.rawValue) frame \(r(topLeft)) subrole \(w.accessibilitySubrole()?.rawValue ?? "-") fullScreenable \(!switches.noFullScreen) resizable \(style.contains(.resizable)) min \(Int(w.minSize.width))x\(Int(w.minSize.height)) minFullScreen \(Int(w.minFullScreenContentSize.width))x\(Int(w.minFullScreenContentSize.height))")
        if order { show(w) }
        return w
    }
    func show(_ w: NSWindow) {
        if NSApp.isActive { w.makeKeyAndOrderFront(nil) } else { w.orderFront(nil) }
        clog("ordered in \(w.windowNumber) kind \(kind(w)) active \(NSApp.isActive) onActiveSpace \(w.isOnActiveSpace)")
    }
    func kind(_ w: NSWindow) -> String { kinds[ObjectIdentifier(w)]?.rawValue ?? "?" }
    func orderOut(_ w: NSWindow, _ why: String) {
        orderedOutByMe.insert(ObjectIdentifier(w))
        w.orderOut(nil)
        clog("ordered out \(w.windowNumber) kind \(kind(w)) (\(why))")
    }

    func occlusion(_ w: NSWindow) {
        let visible = w.occlusionState.contains(.visible)
        clog("occlusion \(w.windowNumber) kind \(kind(w)) visible \(visible) onActiveSpace \(w.isOnActiveSpace)")
        guard visible, kinds[ObjectIdentifier(w)] == .main else { return }
        let first = !shownOnce.contains(ObjectIdentifier(w))
        shownOnce.insert(ObjectIdentifier(w))
        guard first else { return }
        // axBusy: its main thread blocked as its window first shows (Accessibility's calls answer -25200 meanwhile).
        if let busy = switches.axBusy, !busyDone {
            busyDone = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { clog("busy pid \(pid) for \(busy) s"); Thread.sleep(forTimeInterval: busy); clog("busy over pid \(pid)") }
        }
        if case .after(let s)? = switches.ordersOut, shownOnce.count == 1 {
            DispatchQueue.main.asyncAfter(deadline: .now() + s) { [weak self, weak w] in if let w, w.isVisible { self?.orderOut(w, "ordersOut after \(s) s") } }
        }
        if case .closesAfter(let s)? = switches.windowless, shownOnce.count == 1 {
            DispatchQueue.main.asyncAfter(deadline: .now() + s) { [weak w] in if let w { clog("closing its own window \(w.windowNumber) (windowless close:\(s))"); w.close() } }
        }
    }

    // ---- launch ----
    func applicationWillFinishLaunching(_ n: Notification) {
        clog("launching \(bundleId) policy \(NSApp.activationPolicy().rawValue) priming \(priming)")
    }
    func applicationDidFinishLaunching(_ n: Notification) {
        let restored = windows.count
        clog("options pid \(pid) on \(switches.on.isEmpty ? "none" : switches.on.joined(separator: " "))\(switches.errors.isEmpty ? "" : " unread \(switches.errors.joined(separator: " "))") restored \(restored) NSDisableAutomaticTermination \(UserDefaults.standard.string(forKey: "NSDisableAutomaticTermination") ?? "unset") NSQuitAlwaysKeepsWindows \(UserDefaults.standard.object(forKey: "NSQuitAlwaysKeepsWindows").map { "\($0)" } ?? "unset")")
        if let r = switches.restore, r.via == .code || priming {
            // n windows made now, the full-screen ones asked one after another (each once the one before is in).
            for i in 0..<r.count { makeWindow(.main, index: i) }
            fullScreenQueue = zip(windows, r.fullScreen).filter { $0.1 }.map { $0.0 }
            nextFullScreen()
            if priming, fullScreenQueue.isEmpty { primeQuit() }
        } else if switches.restore != nil, restored > 0 {
            clog("restore: \(restored) window(s) restored by AppKit")
            for w in windows where !w.isVisible { show(w) }
        } else {
            if switches.restore != nil { clog("restore: nothing restored by AppKit (no priming run, or its state discarded): a fresh window") }
            let w = makeWindow(.main, index: 0, order: switches.ordersOut != .untilActive)
            if switches.ordersOut == .untilActive { clog("main window \(w.windowNumber) not ordered in until the app is activated") }
        }
        if switches.replacesWindow?.twin == true, let m = main { twin(of: m) }
        if let every = switches.replacesWindow?.every { Timer.scheduledTimer(withTimeInterval: every, repeats: true) { [weak self] _ in self?.replaceMain() } }
        if case .every(let s)? = switches.ordersOut { Timer.scheduledTimer(withTimeInterval: s, repeats: true) { [weak self] _ in self?.hop() } }
        if case .timed(let at, let lasts)? = switches.strip { DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in self?.makeStrip("timed"); DispatchQueue.main.asyncAfter(deadline: .now() + lasts) { self?.closeStrip("timed, after \(lasts) s") } } }
        if let a = switches.auxiliary {
            DispatchQueue.main.asyncAfter(deadline: .now() + (a.at ?? 0.3)) { [weak self] in
                self?.makeAuxiliary(a)
                if let lasts = a.lasts { DispatchQueue.main.asyncAfter(deadline: .now() + lasts) { if let w = self?.auxiliary { clog("auxiliary window \(w.windowNumber) closed (after \(lasts) s)"); w.close(); self?.auxiliary = nil } } }
            }
        }
        if case .at(let s)? = switches.extraWindow { DispatchQueue.main.asyncAfter(deadline: .now() + s) { [weak self] in self?.extra("timer") } }
        // (Its state, on the suite's ask: AppKit's own word, as a split's pane kept active by Margin's records has it.)
        DistributedNotificationCenter.default().addObserver(forName: .init(ChameleonSwitches.stateNotification), object: nil, queue: .main) { note in
            guard (note.userInfo?["bundle"] as? String) == bundleId || (note.object as? String) == bundleId else { return }
            let key = NSApp.keyWindow
            let editing = key.map { $0.firstResponder is NSTextView && ($0.firstResponder as? NSTextView)?.isFieldEditor == true } ?? false
            clog("state active \(NSApp.isActive) key \(key?.windowNumber ?? -1) main \(NSApp.mainWindow?.windowNumber ?? -1) editing \(editing) ask \(note.userInfo?["ask"] as? String ?? "-")")
        }
        if switches.extraWindow != nil {
            DistributedNotificationCenter.default().addObserver(forName: .init(ChameleonSwitches.extraWindowNotification), object: nil, queue: .main) { [weak self] note in
                guard (note.userInfo?["bundle"] as? String) == bundleId || (note.object as? String) == bundleId else { return }
                self?.extra("event")
            }
        }
        switch switches.autoTerminate {
        case .system?:
            ProcessInfo.processInfo.automaticTerminationSupportEnabled = true
            ProcessInfo.processInfo.enableAutomaticTermination("chameleon")
            clog("automatic termination on (AppKit's): macOS may end this app while it has no visible window")
        case .attempt?, .quit?:
            Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.watchForTermination() }
        case nil: break
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            clog("space changed: on the active Space \(self.windows.filter(\.isOnActiveSpace).map { "\($0.windowNumber)" }.joined(separator: ",")) of \(self.windows.map { "\($0.windowNumber)" }.joined(separator: ","))")
        }
    }
    func nextFullScreen() {
        guard !fullScreenQueue.isEmpty else { return }
        let w = fullScreenQueue.removeFirst()
        clog("asking full screen \(w.windowNumber) (restore \(switches.restore?.via.rawValue ?? "?")\(priming ? ", priming" : ""))")
        w.toggleFullScreen(nil)
    }
    // The priming run of `restore` by the system: its windows as the switch says, then a quit that keeps them
    // (NSQuitAlwaysKeepsWindows, set by the suite in its own defaults): AppKit restores them at the next launch.
    func primeQuit() {
        guard priming, !primeDone else { return }
        primeDone = true
        // (Each window's state invalidated, so AppKit encodes it before the quit. The priming run is a plain launch:
        // with -ApplePersistenceIgnoreState YES, AppKit saved only the windows that went full screen, never a normal
        // one, even invalidated (2026-11-17 17:38 and 19:00: restore-normal restored 0; the baseline's plain priming
        // launch, 16:04, restored both normal windows, in a launch Margin made with no Dock icon).)
        for w in windows { w.invalidateRestorableState() }
        NSApp.invalidateRestorableState()
        clog("priming done: \(windows.count) window(s), full screen \(windows.filter { $0.styleMask.contains(.fullScreen) }.map { "\($0.windowNumber)" }.joined(separator: ",")): quitting, its windows kept")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { NSApp.terminate(nil) }
    }

    // ---- the behaviours over time ----
    func twin(of m: NSWindow) {
        let w = makeWindow(.twin, index: 0, order: false, frame: chameleonFlip(m.frame, mainScreenHeight: screenFrame.height), exact: m.frame)
        w.order(.below, relativeTo: m.windowNumber)
        clog("twin \(w.windowNumber) behind \(m.windowNumber) at \(r(m.frame))")
    }
    func replaceMain() {
        guard let old = main else { return }
        let frame = chameleonFlip(old.frame, mainScreenHeight: screenFrame.height)
        let wasFull = old.styleMask.contains(.fullScreen)
        kinds[ObjectIdentifier(old)] = .twin // (not the main one any more: its close isn't the last window's)
        let new = makeWindow(.main, index: 0, order: true, frame: wasFull ? switches.mainFrame(index: 0, screen: CGRect(origin: .zero, size: screenFrame.size)) : frame, exact: wasFull ? nil : old.frame)
        clog("replaced \(old.windowNumber) by \(new.windowNumber) (the old one \(wasFull ? "in full screen" : "at \(r(frame))"))")
        old.close()
    }
    func hop() {
        guard let m = main, m.isVisible else { return }
        orderOut(m, "ordersOut every")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.orderedOutByMe.remove(ObjectIdentifier(m)); self?.show(m) }
    }
    func makeStrip(_ why: String) {
        guard strip == nil else { return }
        let f = ChameleonSwitches.stripFrame(screen: CGRect(origin: .zero, size: screenFrame.size), menuBar: menuBar)
        let x = NSWindow(contentRect: appKit(f), styleMask: [.borderless], backing: .buffered, defer: false)
        x.isReleasedWhenClosed = false
        x.backgroundColor = .systemPink
        x.orderFront(nil)
        strip = x
        windows.append(x); kinds[ObjectIdentifier(x)] = .strip
        clog("extra strip window \(x.windowNumber) pid \(pid) frame \(r(f)) (\(why))")
    }
    func closeStrip(_ why: String) {
        guard let x = strip else { return }
        strip = nil
        stripLingering = false
        x.close()
        clog("strip window \(x.windowNumber) closed (\(why))")
    }
    func makeAuxiliary(_ a: ChameleonSwitches.Auxiliary) {
        let f = ChameleonSwitches.auxiliaryFrame(a.place, screen: CGRect(origin: .zero, size: screenFrame.size), menuBar: menuBar)
        let x = NSWindow(contentRect: appKit(f), styleMask: a.borderless ? [.borderless] : [.titled, .closable], backing: .buffered, defer: false)
        x.isReleasedWhenClosed = false
        x.title = "\(copyName) settings"
        x.backgroundColor = .systemTeal
        x.collectionBehavior = [.fullScreenAuxiliary]
        x.delegate = self
        x.orderFront(nil)
        auxiliary = x
        windows.append(x); kinds[ObjectIdentifier(x)] = .auxiliary
        clog("auxiliary window \(x.windowNumber) pid \(pid) frame \(r(f)) place \(a.place)")
    }
    func extra(_ how: String) {
        let w = makeWindow(.extra, index: windows.count)
        clog("extra window \(w.windowNumber) opened (\(how))")
    }
    @objc func newWindow(_ s: Any?) { extra("menu") }
    func watchForTermination() {
        let seen = windows.contains { $0.isVisible && $0.occlusionState.contains(.visible) }
        if seen || NSApp.isActive { noWindowSince = nil; return }
        if noWindowSince == nil { noWindowSince = Date(); clog("no window of it on screen: termination watch started") }
        let after: Double
        switch switches.autoTerminate { case .attempt(let a)?: after = a; case .quit(let a)?: after = a; default: return }
        guard !attempting, let since = noWindowSince, Date().timeIntervalSince(since) >= after else { return }
        attempting = true
        if case .quit? = switches.autoTerminate {
            clog("terminate attempt pid \(pid): no window on screen for \(after) s: quitting")
            NSApp.terminate(nil)
            return
        }
        // UIKit's attempt: background-only for a moment (its policy prohibited), a terminate that doesn't finish.
        policyBeforeAttempt = NSApp.activationPolicy()
        clog("terminate attempt pid \(pid): no window on screen for \(after) s: attempting (policy \(policyBeforeAttempt!.rawValue) → prohibited)")
        NSApp.setActivationPolicy(.prohibited)
        NSApp.terminate(nil)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if attempting, case .attempt? = switches.autoTerminate {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                NSApp.reply(toApplicationShouldTerminate: false)
                if let p = self?.policyBeforeAttempt { NSApp.setActivationPolicy(p) }
                self?.attempting = false
                self?.noWindowSince = nil
                clog("terminate attempt over pid \(pid): still running (policy \(NSApp.activationPolicy().rawValue))")
            }
            clog("terminate asked: later (an attempt)")
            return .terminateLater
        }
        clog("terminate asked: now")
        return .terminateNow
    }
    func applicationWillTerminate(_ n: Notification) { clog("terminating pid \(pid)") }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // (Its own orderOut isn't a close: AppKit asks this when its last visible window is ordered out too (2026-11-17,
        // ordersOut after:3 quit with it); an app that orders its window out keeps running, as the Phone does.)
        if !orderedOutByMe.isEmpty, windows.contains(where: { orderedOutByMe.contains(ObjectIdentifier($0)) }) {
            clog("last window ordered out by itself: still running")
            return false
        }
        let quits = switches.quitsAfterLastWindow && !priming
        clog("last window closed: \(quits ? "quitting" : "still running (windowless)")")
        return quits
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        clog("reopen asked (visible windows \(flag), main \(main.map { "\($0.windowNumber) visible \($0.isVisible)" } ?? "none"), hidden \(NSApp.isHidden), active \(NSApp.isActive))")
        if let m = main { if !m.isVisible { orderedOutByMe.remove(ObjectIdentifier(m)); show(m) } } else { makeWindow(.main, index: 0) }
        return false
    }
    func applicationDidBecomeActive(_ n: Notification) {
        clog("appDidBecomeActive")
        guard let m = main, !m.isVisible else { return }
        if switches.ordersOut == .untilActive || orderedOutByMe.contains(ObjectIdentifier(m)) {
            orderedOutByMe.remove(ObjectIdentifier(m))
            show(m)
        }
    }
    func applicationDidResignActive(_ n: Notification) { clog("appDidResignActive") }
    func applicationDidHide(_ n: Notification) { clog("appDidHide") }
    func applicationDidUnhide(_ n: Notification) { clog("appDidUnhide (main \(main.map { "\($0.windowNumber) visible \($0.isVisible)" } ?? "none"))") }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // ---- what each window hears ----
    func windowDidBecomeKey(_ n: Notification) { clog("becameKey \((n.object as! NSWindow).windowNumber)") }
    func windowDidResignKey(_ n: Notification) { clog("resignedKey \((n.object as! NSWindow).windowNumber)") }
    func windowDidBecomeMain(_ n: Notification) { clog("becameMain \((n.object as! NSWindow).windowNumber)") }
    func windowDidResignMain(_ n: Notification) { clog("resignedMain \((n.object as! NSWindow).windowNumber)") }
    func windowDidResize(_ n: Notification) { let w = n.object as! NSWindow; clog("didResize \(w.windowNumber) \(Int(w.frame.width))x\(Int(w.frame.height)) live=\(w.inLiveResize)") }
    func windowDidMove(_ n: Notification) { let w = n.object as! NSWindow; clog("didMove \(w.windowNumber) \(Int(w.frame.minX)),\(Int(w.frame.minY))") }
    func windowDidChangeScreen(_ n: Notification) { clog("didChangeScreen \((n.object as! NSWindow).windowNumber)") }
    func windowDidMiniaturize(_ n: Notification) { clog("didMiniaturize \((n.object as! NSWindow).windowNumber)") }
    func windowDidDeminiaturize(_ n: Notification) { clog("didDeminiaturize \((n.object as! NSWindow).windowNumber)") }
    func windowWillEnterFullScreen(_ n: Notification) { clog("willEnterFullScreen \((n.object as! NSWindow).windowNumber)") }
    func windowDidEnterFullScreen(_ n: Notification) {
        let w = n.object as! NSWindow
        clog("didEnterFullScreen \(w.windowNumber)")
        if case .onFullScreen? = switches.strip, kinds[ObjectIdentifier(w)] == .main {
            if stripLingering { closeStrip("the next full screen") }
            makeStrip("its window in full screen")
        }
        if fullScreenQueue.isEmpty { primeQuit() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.nextFullScreen() } }
    }
    func windowDidFailToEnterFullScreen(_ w: NSWindow) { clog("didFailToEnterFullScreen \(w.windowNumber)"); if fullScreenQueue.isEmpty { primeQuit() } else { nextFullScreen() } }
    func windowWillExitFullScreen(_ n: Notification) {
        let w = n.object as! NSWindow
        clog("willExitFullScreen \(w.windowNumber)")
        if case .onFullScreen(let linger)? = switches.strip, kinds[ObjectIdentifier(w)] == .main {
            if linger, !stripLingering { stripLingering = true; clog("strip left behind (linger)") } else { closeStrip("its window out of full screen") }
        }
    }
    func windowDidExitFullScreen(_ n: Notification) { clog("didExitFullScreen \((n.object as! NSWindow).windowNumber)") }
    func windowWillClose(_ n: Notification) {
        let w = n.object as! NSWindow
        clog("closed \(w.windowNumber) kind \(kind(w))")
        windows.removeAll { $0 === w }
        if strip === w { strip = nil }
        if auxiliary === w { auxiliary = nil }
    }
    func controlTextDidChange(_ n: Notification) { clog("typed count=\((n.object as! NSTextField).stringValue.count)") }
    @objc func hit(_ s: Any?) { clog("button"); (s as? NSButton)?.title = "Clicked" }

    // ---- the toolbar (a real NSToolbar, as TestPane's) ----
    func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [.init("a"), .flexibleSpace, .init("b")] }
    func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [.init("a"), .flexibleSpace, .init("b")] }
    func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar f: Bool) -> NSToolbarItem? {
        let i = NSToolbarItem(itemIdentifier: id); i.label = id.rawValue == "a" ? "Back" : "Share"
        i.image = NSImage(systemSymbolName: id.rawValue == "a" ? "chevron.left" : "square.and.arrow.up", accessibilityDescription: nil); i.isBordered = true; return i
    }
}

_ = NSApplication.shared // no explicit policy: the Info.plist or the launch decides, as real apps
let app = App()
NSApp.delegate = app
let mainMenu = NSMenu()
for (title, items) in [(copyName, ["About \(copyName)", "Quit \(copyName)"]), ("File", ["New Window", "Close"]), ("Edit", ["Undo", "Cut", "Copy", "Paste"]), ("View", ["Show Sidebar"])] {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); let sub = NSMenu(title: title)
    for t in items {
        let mi: NSMenuItem
        if t.hasPrefix("Quit") { mi = NSMenuItem(title: t, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); mi.target = NSApp }
        else if t == "New Window" { mi = NSMenuItem(title: t, action: #selector(App.newWindow(_:)), keyEquivalent: "n"); mi.target = app; mi.isEnabled = switches.extraWindow != nil }
        else if t == "Close" { mi = NSMenuItem(title: t, action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w") }
        else { mi = NSMenuItem(title: t, action: #selector(App.hit(_:)), keyEquivalent: ""); mi.target = app }
        sub.addItem(mi)
    }
    item.submenu = sub; mainMenu.addItem(item)
}
NSApp.mainMenu = mainMenu
// Every key press and click it gets (key codes and flags, never characters), and who has the keyboard then.
NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) { e in
    if e.type == .keyDown { clog("EVENT keyDown code \(e.keyCode) flags \(String(e.modifierFlags.rawValue, radix: 16)) appActive=\(NSApp.isActive) keyWindow=\(NSApp.keyWindow?.windowNumber ?? -1)") }
    // (A synthetic mouse record, the window server's make-key pair as Margin's "all panes active" sends it (as yabai and
    // AltTab do), has no place: its location isn't a number, and Int() of it traps: logged as such, never converted.)
    else {
        let p = e.locationInWindow
        let at = p.x.isFinite && p.y.isFinite ? "\(Int(p.x)),\(Int(p.y))" : "no place (a synthetic record)"
        clog("EVENT mouseDown at \(at) in window \(e.windowNumber) appActive=\(NSApp.isActive)")
    }
    return e
}
NSApp.run()
