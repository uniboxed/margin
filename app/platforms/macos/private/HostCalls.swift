// The host's private calls (docs/MARGIN-APP.md phase 3, docs/PRIVATE-APIS.md rows 23-35): what Margin needs, beyond
// the parts PrivateCalls.swift already checks, to show another app's full-screen window in its page area.
//
// - LaunchServices: an app started with no Dock icon (`_LSOpenURLsWithCompletionHandler` with the UIElement
//   option), and its notifications, which say when someone opens that app from outside (the Dock, Finder, a link):
//   code 659 an open request, 561 the no-Dock instance promoted to a normal app.
// - SkyLight: a Space's type, the display's current Space set back, and a hosted window's own full-screen Space
//   destroyed through the window manager's bridge once its window is a member of Margin's Space
//   (`SLSBridgedSpaceDestroyOperation -initWithSpaceID:`, then `-performWithWMBridgeDelegate`). The window's move into
//   Margin's Space is the parker's bridge (PrivateCalls' park part), its edges the slot's reservation (the slot part).
//   (The tile calls of the first build, `SLSSpaceCopyTileSpaces`, `SLSSpaceTileMoveToSpaceAtIndex` and
//   `SLSSpaceSetInterTileSpacing`, went with the tiles on 2026-11-15: nothing checks or calls them now.)
//
// The same rules as PrivateCalls.swift: everything looked up at launch (`HostCalls.check`, one log line), anything
// missing or an encoding changed turns the host off for the run (Margin then never hosts; the setting says so in
// the log), every function optional, every wrapper refusing under MARGIN_APP_TESTS. The outside-open notifications
// are a part of their own: off, the host still runs and an outside open isn't heard.
// The log holds names, counts and results only.

import AppKit
import ObjectiveC

enum HostCalls {
    // SkyLight's (the Space reads, parking, the slot and geometry are PrivateCalls' parts, which the host also needs).
    nonisolated static let skyFunctions = ["SLSMainConnectionID", "SLSSpaceGetType", "SLSManagedDisplaySetCurrentSpace"]
    // LaunchServices': the open and its option keys (data symbols: each a CFStringRef).
    nonisolated static let launchFunctions = ["_LSOpenURLsWithCompletionHandler"]
    nonisolated static let launchKeys = ["_kLSOpenOptionUIElementLaunchKey", "_kLSOpenOptionActivateKey", "_kLSOpenOptionHideKey",
                                         "_kLSOpenOptionAddToRecentsKey", "_kLSOpenOptionArgumentsKey"]
    // The outside-open notifications (their own part).
    nonisolated static let noteFunctions = ["_LSScheduleNotificationOnQueueWithBlock", "_LSModifyNotification", "_LSASNCreateWithPid"]

    nonisolated static let destroyClass = "SLSBridgedSpaceDestroyOperation"
    nonisolated static let initDestroy = "initWithSpaceID:"
    // Read on macOS 27.2.1 (26B131) with method_getTypeEncoding.
    nonisolated static let selectors = [
        PrivateCalls.Selector(className: destroyClass, name: initDestroy, encoding: "@24@0:8Q16"), // (UInt64 space)
        PrivateCalls.Selector(className: destroyClass, name: PrivateCalls.perform, encoding: "v16@0:8"),
    ]

    // The codes LaunchServices' notifications carry for an app (memory: external-open-research).
    nonisolated static let openRequestCode: Int32 = 659
    nonisolated static let promotedCode: Int32 = 561

    nonisolated struct Availability: Equatable, Sendable {
        var host = false // launch, Spaces' types, the current Space, destroy: everything the engine needs of its own
        var opens = false // the outside-open notifications
        var missing: [String] = []
        var mismatched: [String] = []
        var reasons: [String: String] = [:] // "host", "outside opens"
        var functionsFound = 0, functionsTotal = 0
        var selectorsFound = 0, selectorsTotal = 0
        static let off = Availability()

        func line(build: String?) -> String {
            func part(_ name: String, _ on: Bool) -> String { on ? "\(name) ok" : "\(name) off: \(reasons[name] ?? "not checked")" }
            let encodings = mismatched.isEmpty ? "encodings ok" : "\(mismatched.count) encoding\(mismatched.count == 1 ? "" : "s") changed"
            return "private calls (host) on \(build ?? "build unknown"): \(part("host", host)) (\(functionsFound)/\(functionsTotal) functions and keys, "
                + "\(selectorsFound)/\(selectorsTotal) selectors, \(encodings)); \(part("outside opens", opens))"
        }
    }

    // `base`: PrivateCalls' own check, whose parts the host builds on (the Space reads, parking, the slot, geometry).
    nonisolated static func evaluate(_ resolver: PrivateResolver, base: PrivateCalls.Availability) -> Availability {
        var a = Availability()
        let sky = resolver.open(.skyLight)
        let ls = resolver.open(.launchServices)
        var problems: [String] = []
        var noteProblems: [String] = []
        func lack(_ name: String, _ into: inout [String]) {
            if !a.missing.contains(name) { a.missing.append(name) }
            into.append("\(name) missing")
        }
        if !sky { problems.append("SkyLight.framework didn't open") }
        if !ls { problems.append("LaunchServices.framework didn't open"); noteProblems.append("LaunchServices.framework didn't open") }
        a.functionsTotal = skyFunctions.count + launchFunctions.count + launchKeys.count + noteFunctions.count
        for name in skyFunctions where sky {
            if resolver.function(name, in: .skyLight) != nil { a.functionsFound += 1 } else { lack(name, &problems) }
        }
        for name in launchFunctions + launchKeys where ls {
            if resolver.function(name, in: .launchServices) != nil { a.functionsFound += 1 } else { lack(name, &problems) }
        }
        for name in noteFunctions where ls {
            if resolver.function(name, in: .launchServices) != nil { a.functionsFound += 1 } else { lack(name, &noteProblems) }
        }
        a.selectorsTotal = selectors.count
        if sky, resolver.objcClass(destroyClass) != nil {
            for s in selectors {
                guard resolver.responds(s.className, s.name) else { lack(s.label, &problems); continue }
                a.selectorsFound += 1
                let got = resolver.typeEncoding(s.className, s.name)
                if got != s.encoding {
                    a.mismatched.append(s.label)
                    problems.append("-\(s.name) encoding changed (\(got ?? "none"), expected \(s.encoding))")
                }
            }
        } else if sky { lack(destroyClass, &problems) }
        // What the host needs of PrivateCalls' parts.
        if problems.isEmpty {
            for (part, on) in [("spaces", base.spaces), ("park", base.park), ("slot", base.slot), ("geometry", base.geometry)] where !on {
                problems.append("the \(part) part is off")
            }
        }
        func why(_ list: [String]) -> String? {
            guard !list.isEmpty else { return nil }
            let shown = list.prefix(2).joined(separator: ", ")
            return list.count > 2 ? "\(shown) and \(list.count - 2) more" : shown
        }
        a.host = problems.isEmpty
        a.reasons["host"] = why(problems)
        a.opens = a.host && noteProblems.isEmpty
        a.reasons["outside opens"] = a.host ? why(noteProblems) : "the host is off"
        return a
    }

    // At launch (ShellHost.swift startHost), after PrivateCalls.check: one line.
    static func check(resolver: PrivateResolver, base: PrivateCalls.Availability) -> Availability {
        let started = Diagnostics.now()
        let a = evaluate(resolver, base: base)
        Diagnostics.note(a.line(build: resolver.build) + " in " + Diagnostics.ms(since: started))
        return a
    }
}

// The functions, typed, behind wrappers that refuse under MARGIN_APP_TESTS and answer nil or false for anything
// they can't do. Only what the check passed is filled in.
nonisolated struct HostPrivate: @unchecked Sendable {
    typealias MainConnectionID = @convention(c) () -> UInt32
    typealias SpaceGetType = @convention(c) (UInt32, UInt64) -> Int32
    typealias SetCurrentSpace = @convention(c) (UInt32, CFString, UInt64) -> Void
    typealias InitDestroy = @convention(c) (UnsafeMutableRawPointer, ObjectiveC.Selector, UInt64) -> Unmanaged<AnyObject>?
    typealias OpenCompletion = @convention(block) (CFTypeRef?, Bool, CFError?) -> Void
    // (Both blocks are kept by LaunchServices and called later: @escaping, or Swift's runtime check stops the app the
    // moment one is kept: "non-escaping closure has escaped", seen 2026-11-15 on the first real hosted launch.)
    typealias OpenURLs = @convention(c) (CFArray?, CFURL, CFDictionary, @escaping OpenCompletion) -> Void
    // (code, time, info, the app's ASN, and two more nobody reads).
    typealias NoteBlock = @convention(block) (Int32, Double, CFTypeRef?, CFTypeRef?, Int32, UnsafeRawPointer?) -> Void
    typealias ScheduleNotification = @convention(c) (Int32, CFTypeRef?, DispatchQueue, @escaping NoteBlock) -> UnsafeRawPointer?
    // (id, codes added: count and list, codes removed: count and list, the app's ASN, nil).
    typealias ModifyNotification = @convention(c) (UnsafeRawPointer?, UInt32, UnsafePointer<Int32>?, UInt32, UnsafePointer<Int32>?, CFTypeRef?, CFTypeRef?) -> Int32
    typealias ASNCreateWithPid = @convention(c) (CFAllocator?, pid_t) -> Unmanaged<AnyObject>?

    let refuses: Bool
    private var mainConnectionID: MainConnectionID?
    private var spaceGetType: SpaceGetType?
    private var setCurrentSpace: SetCurrentSpace?
    private var destroyClass: AnyClass?
    private var initDestroy: InitDestroy?
    private var performDestroy: SkyLight.Perform?
    private var openURLs: OpenURLs?
    private var keys: [String: String] = [:]
    private var schedule: ScheduleNotification?
    private var modify: ModifyNotification?
    private var asnCreate: ASNCreateWithPid?
    private let kept = KeptOperations()

    init(resolver: PrivateResolver, availability: HostCalls.Availability, refusing: Bool = PrivateCalls.inTests) {
        refuses = refusing
        guard availability.host else { return }
        func fn<T>(_ name: String, _ framework: PrivateFramework, _: T.Type) -> T? { resolver.function(name, in: framework).map { unsafeBitCast($0, to: T.self) } }
        mainConnectionID = fn("SLSMainConnectionID", .skyLight, MainConnectionID.self)
        spaceGetType = fn("SLSSpaceGetType", .skyLight, SpaceGetType.self)
        setCurrentSpace = fn("SLSManagedDisplaySetCurrentSpace", .skyLight, SetCurrentSpace.self)
        destroyClass = resolver.objcClass(HostCalls.destroyClass)
        initDestroy = resolver.implementation(HostCalls.destroyClass, HostCalls.initDestroy).map { unsafeBitCast($0, to: InitDestroy.self) }
        performDestroy = resolver.implementation(HostCalls.destroyClass, PrivateCalls.perform).map { unsafeBitCast($0, to: SkyLight.Perform.self) }
        openURLs = fn("_LSOpenURLsWithCompletionHandler", .launchServices, OpenURLs.self)
        if !refusing {
            for key in HostCalls.launchKeys {
                if let p = resolver.function(key, in: .launchServices) { keys[key] = p.assumingMemoryBound(to: CFString.self).pointee as String }
            }
        }
        if availability.opens {
            schedule = fn("_LSScheduleNotificationOnQueueWithBlock", .launchServices, ScheduleNotification.self)
            modify = fn("_LSModifyNotification", .launchServices, ModifyNotification.self)
            asnCreate = fn("_LSASNCreateWithPid", .launchServices, ASNCreateWithPid.self)
        }
    }

    private func connection() -> UInt32? {
        guard !refuses, let mainConnectionID else { return nil }
        let cid = mainConnectionID()
        return cid == 0 ? nil : cid
    }

    func spaceType(_ space: UInt64) -> Int? {
        guard space > 0, let cid = connection(), let spaceGetType else { return nil }
        return Int(spaceGetType(cid, space))
    }

    func setCurrent(_ space: UInt64, display: String) -> Bool {
        guard space > 0, !display.isEmpty, let cid = connection(), let setCurrentSpace else { return false }
        setCurrentSpace(cid, display as CFString, space)
        return true
    }

    // The window manager's own destroy, for a hosted window's full-screen Space once its window is a member of Margin's
    // (its tile stays behind, with no window). Sent; whether it went is the caller's to read (the Space gone from the
    // managed list). Never for the Space showing: that drops to the Desktop.
    func destroyFullScreenSpace(_ space: UInt64) -> Bool {
        guard space > 0, !refuses, let initDestroy, let performDestroy,
              let cls = destroyClass as? NSObject.Type, let made = cls.perform(NSSelectorFromString("alloc")) else { return false }
        guard let op = initDestroy(made.toOpaque(), NSSelectorFromString(HostCalls.initDestroy), space)?.takeRetainedValue() else { return false }
        performDestroy(op, NSSelectorFromString(PrivateCalls.perform))
        kept.keep(op)
        return true
    }

    // The app at `url` started with no Dock icon, not activated, hidden, not in Recents, with `arguments`. Only a
    // fresh launch: an app already running is only asked to open (and keeps its Dock icon). True: asked.
    func launchDockless(_ url: URL, arguments: [String], done: @escaping @Sendable (Bool) -> Void) -> Bool {
        guard !refuses, let openURLs,
              let uiElement = keys["_kLSOpenOptionUIElementLaunchKey"], let activate = keys["_kLSOpenOptionActivateKey"],
              let hide = keys["_kLSOpenOptionHideKey"], let recents = keys["_kLSOpenOptionAddToRecentsKey"],
              let args = keys["_kLSOpenOptionArgumentsKey"] else { return false }
        let options: [String: Any] = [uiElement: true, activate: false, hide: true, recents: false, args: arguments]
        openURLs([] as CFArray, url as CFURL, options as CFDictionary) { _, ok, _ in done(ok) }
        return true
    }

    // LaunchServices' notifications for one app (by its pid): every code, as the research run subscribed (0..<8192),
    // heard on the main queue. The token to stop with; nil: not listening.
    func listen(pid: pid_t, heard: @escaping @Sendable (Int32) -> Void) -> UnsafeRawPointer? {
        guard !refuses, pid > 0, let schedule, let modify, let asnCreate, let asn = asnCreate(nil, pid)?.takeRetainedValue() else { return nil }
        let block: NoteBlock = { code, _, _, _, _, _ in heard(code) }
        guard let id = schedule(-2, nil, DispatchQueue.main, block) else { return nil }
        let codes = (0..<8192).map { Int32($0) }
        let result = codes.withUnsafeBufferPointer { modify(id, UInt32($0.count), $0.baseAddress, 0, nil, asn, nil) }
        return result == 0 ? id : nil
    }

    // Every code removed again (no unschedule is used: its signature isn't known).
    func stopListening(_ id: UnsafeRawPointer, pid: pid_t) {
        guard !refuses, let modify, let asnCreate, let asn = asnCreate(nil, pid)?.takeRetainedValue() else { return }
        let codes = (0..<8192).map { Int32($0) }
        _ = codes.withUnsafeBufferPointer { modify(id, 0, nil, UInt32($0.count), $0.baseAddress, asn, nil) }
    }
}
