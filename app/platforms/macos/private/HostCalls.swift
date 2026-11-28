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
//   `SLSSpaceSetInterTileSpacing`, went with the tiles on 2026-11-15; the tiles came back on 2026-11-17, below.)
// - The tiles (live resize, docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space"; a part of its own): a hosted
//   window's own tile moved into Margin's Space (`SLSBridgedSpaceTileMoveToSpaceAtIndexOperation`), Margin's Space's
//   tile limit and each tile's rect set (`SLSBridgedSpaceSetValuesOperation`: `Max Tile Config`, `TileRect`,
//   `LiveResizing`), and a Space's tiles read (`SLSSpaceCopyTileSpaces`; their values with the slot's
//   `SLSSpaceCopyValues`). Bridged only: the direct `SLSSpaceSetValues` is ignored for another process's tiles (the kit,
//   2026-11-17). Off: the host runs as before (a page-area change re-fits the one shown on release).
//
// - All panes active (a part of its own, PaneRecords.swift; docs/PRIVATE-APIS.md rows 40-45): a split's panes of other apps than the front one kept
//   active by the window server's event records (`SLPSPostEventRecordTo`, the records' layout checked at launch with
//   `SLEventRecordPointer`), the window server's front process read (`SLPSGetFrontProcess`) and set
//   (`_SLPSSetFrontProcessWithOptions`: a kept app made the front one, which AppKit's own activation may take for done),
//   a pid's process serial number and back (HIServices' `GetProcessForPID`, `GetProcessPID`). Off: only the focused
//   pane draws active, as before.
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

    // All panes active (their own part): SkyLight's records and front process, HIServices' process serial numbers.
    nonisolated static let activeFunctions = ["SLPSPostEventRecordTo", "SLEventRecordPointer", "SLPSGetFrontProcess", "_SLPSSetFrontProcessWithOptions"]
    nonisolated static let processFunctions = ["GetProcessForPID", "GetProcessPID"]

    nonisolated static let destroyClass = "SLSBridgedSpaceDestroyOperation"
    nonisolated static let initDestroy = "initWithSpaceID:"
    // The tiles (their own part): a Space's tiles read, the two bridged operations.
    nonisolated static let tileFunctions = ["SLSSpaceCopyTileSpaces", "SLSSpaceCopyValues"]
    nonisolated static let setValuesClass = "SLSBridgedSpaceSetValuesOperation"
    nonisolated static let initSetValues = "initWithSpaceID:values:"
    nonisolated static let tileMoveClass = "SLSBridgedSpaceTileMoveToSpaceAtIndexOperation"
    nonisolated static let initTileMove = "initWithTileID:parentID:index:"
    nonisolated static let tileClasses = [setValuesClass, tileMoveClass]
    // The anchors (docs/HOSTING-CORE.md "Anchors"): empty tiles made in Margin's Space (no window), its layout's first
    // two, so a tile change lays only them out again. Synchronous: its perform answers the new tile.
    nonisolated static let createTileClass = "SLSBridgedSpaceCreateTileOperation"
    // Read on macOS 27.2.1 with method_getTypeEncoding (2026-11-18).
    nonisolated static let anchorSelectors = [
        PrivateCalls.Selector(className: createTileClass, name: initSetValues, encoding: "@32@0:8Q16@24"), // (UInt64 space, NSDictionary values)
        PrivateCalls.Selector(className: createTileClass, name: PrivateCalls.perform, encoding: "@16@0:8"), // (the result)
    ]
    // Read on macOS 27.2.1 (26B131) with method_getTypeEncoding (both asynchronous operations, as the destroy).
    nonisolated static let tileSelectors = [
        PrivateCalls.Selector(className: setValuesClass, name: initSetValues, encoding: "@32@0:8Q16@24"), // (UInt64 space, NSDictionary values)
        PrivateCalls.Selector(className: setValuesClass, name: PrivateCalls.perform, encoding: "v16@0:8"),
        PrivateCalls.Selector(className: tileMoveClass, name: initTileMove, encoding: "@40@0:8Q16Q24Q32"), // (UInt64 tile, UInt64 parent, UInt64 index)
        PrivateCalls.Selector(className: tileMoveClass, name: PrivateCalls.perform, encoding: "v16@0:8"),
    ]
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
        var tiles = false // live resize: a hosted window's tile in Margin's Space, sized by its rect
        var anchors = false // the layout's first two tiles Margin's own, empty
        var panesActive = false // a split's panes of other apps kept active (their records' layout checked at launch)
        var missing: [String] = []
        var mismatched: [String] = []
        var reasons: [String: String] = [:] // "host", "outside opens", "tiles", "anchors", "panes active"
        var functionsFound = 0, functionsTotal = 0
        var selectorsFound = 0, selectorsTotal = 0
        static let off = Availability()

        func line(build: String?) -> String {
            func part(_ name: String, _ on: Bool) -> String { on ? "\(name) ok" : "\(name) off: \(reasons[name] ?? "not checked")" }
            let encodings = mismatched.isEmpty ? "encodings ok" : "\(mismatched.count) encoding\(mismatched.count == 1 ? "" : "s") changed"
            return "private calls (host) on \(build ?? "build unknown"): \(part("host", host)) (\(functionsFound)/\(functionsTotal) functions and keys, "
                + "\(selectorsFound)/\(selectorsTotal) selectors, \(encodings)); \(part("outside opens", opens)); \(part("tiles", tiles)); \(part("anchors", anchors)); \(part("panes active", panesActive))"
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
        // The tiles: their functions, both classes, their selectors at their encodings. Off: the host as before.
        var tileProblems: [String] = []
        for name in tileFunctions where sky {
            if resolver.function(name, in: .skyLight) == nil { tileProblems.append("\(name) missing") }
        }
        for cls in tileClasses where sky && resolver.objcClass(cls) == nil { tileProblems.append("\(cls) missing") }
        for s in tileSelectors where sky && resolver.objcClass(s.className) != nil {
            guard resolver.responds(s.className, s.name) else { tileProblems.append("\(s.label) missing"); continue }
            let got = resolver.typeEncoding(s.className, s.name)
            if got != s.encoding { tileProblems.append("\(s.label) encoding changed (\(got ?? "none"), expected \(s.encoding))") }
        }
        if !sky { tileProblems.append("SkyLight.framework didn't open") }
        a.tiles = a.host && tileProblems.isEmpty
        a.reasons["tiles"] = a.host ? why(tileProblems) : "the host is off"
        // The anchors: the create-tile class and its selectors at their encodings. Off: the tiles as before.
        var anchorProblems: [String] = []
        if sky, resolver.objcClass(createTileClass) == nil { anchorProblems.append("\(createTileClass) missing") }
        for s in anchorSelectors where sky && resolver.objcClass(s.className) != nil {
            guard resolver.responds(s.className, s.name) else { anchorProblems.append("\(s.label) missing"); continue }
            let got = resolver.typeEncoding(s.className, s.name)
            if got != s.encoding { anchorProblems.append("\(s.label) encoding changed (\(got ?? "none"), expected \(s.encoding))") }
        }
        a.anchors = a.tiles && anchorProblems.isEmpty
        a.reasons["anchors"] = a.tiles ? why(anchorProblems) : "the tiles are off"
        // All panes active: SkyLight's four, HIServices' two (the records' layout is the launch check's, `check`).
        var activeProblems: [String] = []
        for name in activeFunctions where sky && resolver.function(name, in: .skyLight) == nil { activeProblems.append("\(name) missing") }
        let his = resolver.open(.hiServices)
        if !his { activeProblems.append("HIServices.framework didn't open") }
        for name in processFunctions where his && resolver.function(name, in: .hiServices) == nil { activeProblems.append("\(name) missing") }
        a.panesActive = a.host && activeProblems.isEmpty
        a.reasons["panes active"] = a.host ? why(activeProblems) : "the host is off"
        return a
    }

    // The records' layout (PaneRecords.swift) read back from three public events through the resolver's
    // `SLEventRecordPointer`: nil as expected, else what differs. Only the system's resolver is ever asked (a test's
    // "functions" are never called: its stand-in reader is given instead).
    static func recordsProblem(_ resolver: PrivateResolver) -> String? {
        typealias RecordPointer = @convention(c) (CGEvent) -> UnsafeRawPointer?
        guard !PrivateCalls.inTests, let p = resolver.function("SLEventRecordPointer", in: .skyLight) else { return "SLEventRecordPointer missing" }
        let pointer = unsafeBitCast(p, to: RecordPointer.self)
        let r = PaneRecords.publicRecords { event in
            pointer(event).map { Array(UnsafeBufferPointer(start: $0.assumingMemoryBound(to: UInt8.self), count: Int(PaneRecords.length))) }
        }
        return PaneRecords.problem(appKit: r.appKit, down: r.down, up: r.up)
    }

    // At launch (ShellHost.swift startHost), after PrivateCalls.check: one line.
    static func check(resolver: PrivateResolver, base: PrivateCalls.Availability) -> Availability {
        let started = Diagnostics.now()
        var a = evaluate(resolver, base: base)
        // (The records' layout, from public events: anything else and the part's off for the run.)
        if a.panesActive, let problem = recordsProblem(resolver) {
            a.panesActive = false
            a.reasons["panes active"] = "the event records' layout isn't the one checked (\(problem))"
        }
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
    // The tiles: a Space's tiles and values read; the bridged set-values and tile-move operations (alloc'd object in,
    // +1 out, as the destroy's).
    typealias CopyTileSpaces = @convention(c) (UInt32, UInt64) -> Unmanaged<CFArray>?
    typealias SpaceCopyValues = @convention(c) (UInt32, UInt64) -> Unmanaged<CFDictionary>?
    typealias InitSetValues = @convention(c) (UnsafeMutableRawPointer, ObjectiveC.Selector, UInt64, NSDictionary) -> Unmanaged<AnyObject>?
    typealias InitTileMove = @convention(c) (UnsafeMutableRawPointer, ObjectiveC.Selector, UInt64, UInt64, UInt64) -> Unmanaged<AnyObject>?
    // A synchronous operation's perform: its answer (+0, kept with the operation).
    typealias PerformAnswering = @convention(c) (AnyObject, ObjectiveC.Selector) -> Unmanaged<AnyObject>?
    // All panes active: a record to a process (its serial number), the window server's front process read (two more
    // pointers given that it never writes: a callee taking fewer ignores them; one taking more never writes past them)
    // and set (window, options), a pid's serial number and back.
    typealias PostRecord = @convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafePointer<UInt8>) -> Int32
    typealias RecordPointer = @convention(c) (CGEvent) -> UnsafeRawPointer?
    typealias GetFrontProcess = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Int32
    typealias SetFrontProcess = @convention(c) (UnsafePointer<ProcessSerialNumber>, UInt32, UInt32) -> Int32
    typealias ProcessForPID = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> Int32
    typealias ProcessPID = @convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafeMutablePointer<pid_t>) -> Int32
    // `_SLPSSetFrontProcessWithOptions`' kCPSUserGenerated: as a person's click or ⌘-Tab makes an app the front one.
    static let userGenerated: UInt32 = 0x200
    // …kCPSNoWindows: the app made the front one, its windows left where they are in the window server's order (a split's
    // cut pane, kept behind the panes it lies under: docs/PEEK-SPLIT.md §4b; yabai's focus without raise).
    static let noWindows: UInt32 = 0x400

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
    private var copyTileSpaces: CopyTileSpaces?
    private var spaceCopyValues: SpaceCopyValues?
    private var setValuesClass: AnyClass?
    private var initSetValues: InitSetValues?
    private var performSetValues: SkyLight.Perform?
    private var tileMoveClass: AnyClass?
    private var initTileMove: InitTileMove?
    private var performTileMove: SkyLight.Perform?
    private var createTileClass: AnyClass?
    private var initCreateTile: InitSetValues?
    private var performCreateTile: PerformAnswering?
    private var postRecord: PostRecord?
    private var recordPointer: RecordPointer?
    private var getFrontProcess: GetFrontProcess?
    private var setFrontProcess: SetFrontProcess?
    private var processForPID: ProcessForPID?
    private var processPID: ProcessPID?
    let hasTiles: Bool
    let hasAnchors: Bool
    let hasPanesActive: Bool
    private let kept = KeptOperations()

    init(resolver: PrivateResolver, availability: HostCalls.Availability, refusing: Bool = PrivateCalls.inTests) {
        refuses = refusing
        hasTiles = availability.host && availability.tiles
        hasAnchors = hasTiles && availability.anchors
        hasPanesActive = availability.host && availability.panesActive
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
        if availability.tiles {
            copyTileSpaces = fn("SLSSpaceCopyTileSpaces", .skyLight, CopyTileSpaces.self)
            spaceCopyValues = fn("SLSSpaceCopyValues", .skyLight, SpaceCopyValues.self)
            setValuesClass = resolver.objcClass(HostCalls.setValuesClass)
            initSetValues = resolver.implementation(HostCalls.setValuesClass, HostCalls.initSetValues).map { unsafeBitCast($0, to: InitSetValues.self) }
            performSetValues = resolver.implementation(HostCalls.setValuesClass, PrivateCalls.perform).map { unsafeBitCast($0, to: SkyLight.Perform.self) }
            tileMoveClass = resolver.objcClass(HostCalls.tileMoveClass)
            initTileMove = resolver.implementation(HostCalls.tileMoveClass, HostCalls.initTileMove).map { unsafeBitCast($0, to: InitTileMove.self) }
            performTileMove = resolver.implementation(HostCalls.tileMoveClass, PrivateCalls.perform).map { unsafeBitCast($0, to: SkyLight.Perform.self) }
        }
        if availability.tiles, availability.anchors {
            createTileClass = resolver.objcClass(HostCalls.createTileClass)
            initCreateTile = resolver.implementation(HostCalls.createTileClass, HostCalls.initSetValues).map { unsafeBitCast($0, to: InitSetValues.self) }
            performCreateTile = resolver.implementation(HostCalls.createTileClass, PrivateCalls.perform).map { unsafeBitCast($0, to: PerformAnswering.self) }
        }
        if availability.panesActive {
            postRecord = fn("SLPSPostEventRecordTo", .skyLight, PostRecord.self)
            recordPointer = fn("SLEventRecordPointer", .skyLight, RecordPointer.self)
            getFrontProcess = fn("SLPSGetFrontProcess", .skyLight, GetFrontProcess.self)
            setFrontProcess = fn("_SLPSSetFrontProcessWithOptions", .skyLight, SetFrontProcess.self)
            processForPID = fn("GetProcessForPID", .hiServices, ProcessForPID.self)
            processPID = fn("GetProcessPID", .hiServices, ProcessPID.self)
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

    // ---- the tiles (live resize) ----

    // A Space's tiles, in its layout's order (a full-screen Space's: its windows' tiles, the first its owner's). Nil: unread.
    func tiles(of space: UInt64) -> [UInt64]? {
        guard space > 0, let cid = connection(), let copyTileSpaces,
              let list = copyTileSpaces(cid, space)?.takeRetainedValue() as? [NSNumber] else { return nil }
        return list.map(\.uint64Value)
    }

    // A Space's (or a tile's) values: `TileRect`, `TileWindowID`, `TileLayoutManager` → `Max Tile Config`, ... Nil: unread.
    func values(of space: UInt64) -> [String: Any]? {
        guard space > 0, let cid = connection(), let spaceCopyValues else { return nil }
        return spaceCopyValues(cid, space)?.takeRetainedValue() as? [String: Any]
    }

    // The window manager's own set of a Space's (or a tile's) values, through the bridge (a direct SLSSpaceSetValues is
    // ignored for another process's tiles). Sent; whether it took is the caller's to read (the values, the window's bounds).
    func setValues(_ space: UInt64, _ values: [String: Any]) -> Bool {
        guard space > 0, !refuses, let initSetValues, let performSetValues, let raw = alloc(setValuesClass) else { return false }
        guard let op = initSetValues(raw, NSSelectorFromString(HostCalls.initSetValues), space, values as NSDictionary)?.takeRetainedValue() else { return false }
        performSetValues(op, NSSelectorFromString(PrivateCalls.perform))
        kept.keep(op)
        return true
    }

    // A tile (with its window) into another Space's layout at `index`, through the bridge (its id kept). Sent.
    func moveTile(_ tile: UInt64, to parent: UInt64, index: Int) -> Bool {
        guard tile > 0, parent > 0, index >= 0, !refuses, let initTileMove, let performTileMove, let raw = alloc(tileMoveClass) else { return false }
        guard let op = initTileMove(raw, NSSelectorFromString(HostCalls.initTileMove), tile, parent, UInt64(index))?.takeRetainedValue() else { return false }
        performTileMove(op, NSSelectorFromString(PrivateCalls.perform))
        kept.keep(op)
        return true
    }

    // An empty tile (no window) made in `space` (its layout's end), through the bridge. Its id: the operation's answer
    // when it names one (nil: the caller finds the new tile in the Space's list).
    func createTile(in space: UInt64) -> (sent: Bool, tile: UInt64?) {
        guard space > 0, !refuses, let initCreateTile, let performCreateTile, let raw = alloc(createTileClass) else { return (false, nil) }
        guard let op = initCreateTile(raw, NSSelectorFromString(HostCalls.initSetValues), space, [:] as NSDictionary)?.takeRetainedValue() else { return (false, nil) }
        kept.keep(op)
        guard let answer = performCreateTile(op, NSSelectorFromString(PrivateCalls.perform))?.takeUnretainedValue() as? NSObject else { return (true, nil) }
        kept.keep(answer)
        for key in ["spaceID", "spaceIDValue", "value"] where answer.responds(to: NSSelectorFromString(key)) {
            if let n = answer.value(forKey: key) as? NSNumber, n.uint64Value > 0 { return (true, n.uint64Value) }
        }
        return (true, nil)
    }

    // ---- all panes active (PaneRecords.swift) ----

    private func serialNumber(_ pid: pid_t) -> ProcessSerialNumber? {
        guard pid > 0, !refuses, let processForPID else { return nil }
        var psn = ProcessSerialNumber()
        return processForPID(pid, &psn) == 0 ? psn : nil
    }

    // A record (PaneRecords: 0x100 bytes) to the app of `pid`. Its result: 0 taken, else the window server's error (nil:
    // not sent: no such process, refused).
    func post(_ record: [UInt8], to pid: pid_t) -> Int32? {
        guard record.count >= PaneRecords.size, let postRecord, var psn = serialNumber(pid) else { return nil }
        return record.withUnsafeBufferPointer { postRecord(&psn, $0.baseAddress!) }
    }

    // An event's own record as the window server keeps it (PaneRecords.length bytes); nil: unread.
    func record(of event: CGEvent) -> [UInt8]? {
        guard !refuses, let recordPointer, let p = recordPointer(event) else { return nil }
        return Array(UnsafeBufferPointer(start: p.assumingMemoryBound(to: UInt8.self), count: Int(PaneRecords.length)))
    }

    // The window server's front process (the keyboard's, the menu bar's): its pid; nil: unread.
    func frontProcess() -> pid_t? {
        guard !refuses, let getFrontProcess, let processPID else { return nil }
        var psn = ProcessSerialNumber()
        var a = (UInt64(0), UInt64(0), UInt64(0), UInt64(0)), b = a
        let read = withUnsafeMutableBytes(of: &a) { pa in withUnsafeMutableBytes(of: &b) { pb in getFrontProcess(&psn, pa.baseAddress!, pb.baseAddress!) } }
        guard read == 0 else { return nil }
        var pid: pid_t = 0
        return processPID(&psn, &pid) == 0 && pid > 0 ? pid : nil
    }

    // The app of `pid` made the window server's front process, `window` its window, as a person's click would. True: taken.
    func setFront(pid: pid_t, window: Int, options: UInt32 = HostPrivate.userGenerated) -> Bool {
        guard let setFrontProcess, var psn = serialNumber(pid), let n = UInt32(exactly: window) else { return false }
        return setFrontProcess(&psn, n, options) == 0
    }

    private func alloc(_ cls: AnyClass?) -> UnsafeMutableRawPointer? {
        guard let cls = cls as? NSObject.Type, let made = cls.perform(NSSelectorFromString("alloc")) else { return nil }
        return made.toOpaque()
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

    // Opened with its Dock icon (docked.rs, 2026-11-28): the same open as `launchDockless` without the UIElement option,
    // never activated, kept hidden. A running instance started with no Dock icon is made a regular app by it at once
    // (proven on the real Mac with a test app: same process, LaunchServices' type UIElement → Foreground, AppKit's
    // full-screen check passing from the next ask); a fresh launch starts as any app does. True: asked.
    func launchDocked(_ url: URL, arguments: [String], done: @escaping @Sendable (Bool) -> Void) -> Bool {
        guard !refuses, let openURLs, let activate = keys["_kLSOpenOptionActivateKey"], let hide = keys["_kLSOpenOptionHideKey"],
              let recents = keys["_kLSOpenOptionAddToRecentsKey"], let args = keys["_kLSOpenOptionArgumentsKey"] else { return false }
        let options: [String: Any] = [activate: false, hide: true, recents: false, args: arguments]
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
