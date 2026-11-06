// macOS's private calls the profile handoff uses (app/HANDOFF.md §4.1-4.3,
// PRIVATE-APIS.md, which lists each one with its fallback): SkyLight's
// freeze (SLSNewTransition and its reveal), its Space reads, a private Space
// per parked window, and the window-management bridge that moves another
// process's window between Spaces.
//
// - Checked at launch (PrivateCalls.check, from AppDelegate.startShell before
//   the shell starts): each function looked up with dlsym, each class with
//   NSClassFromString, each selector with instancesRespond(to:) and its type
//   encoding against the one recorded on macOS 27.2 (26B123). Anything missing
//   or changed turns that part off, with one log line and no notice: the
//   switch falls back (HANDOFF.md §1.1).
// - The rule: no private call without a fallback and a launch check.
// - Every Copy function is declared as returning Unmanaged<CFArray>?: nil
//   reads as "unknown", never a crash.
// - Tests never call a real private function and never freeze the screen.
//   The real resolver is made only in Shell.forApp(); it, and every wrapper
//   here, refuses to run when MARGIN_APP_TESTS is set (tools/app-tests/run.sh
//   sets it). A test gives a fake resolver whose "functions" are its own.
// - The log holds names, counts and results only.

import AppKit
import ObjectiveC

nonisolated enum PrivateFramework: String, CaseIterable, Sendable {
    case skyLight = "SkyLight.framework"
    case windowManagement = "WindowManagement.framework"

    var path: String {
        switch self {
        case .skyLight: return "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
        case .windowManagement: return "/System/Library/PrivateFrameworks/WindowManagement.framework/WindowManagement"
        }
    }
}

// Where the private calls come from: the system's (RealPrivateResolver), or a test's fake.
nonisolated protocol PrivateResolver: Sendable {
    var version: String { get } // "27.2"
    var build: String? { get } // kern.osversion, "26B123"
    func open(_ framework: PrivateFramework) -> Bool
    func function(_ name: String, in framework: PrivateFramework) -> UnsafeRawPointer?
    func objcClass(_ name: String) -> AnyClass?
    func responds(_ className: String, _ selector: String) -> Bool
    func typeEncoding(_ className: String, _ selector: String) -> String?
    func implementation(_ className: String, _ selector: String) -> UnsafeRawPointer?
}

enum PrivateCalls {
    // Set by tools/app-tests/run.sh for every test binary.
    nonisolated static var inTests: Bool { ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] != nil }

    // The macOS build last checked (HANDOFF.md §4.2): a change adds one log line.
    nonisolated static let buildKey = "MarginPrivateCallsBuild"

    // ---- what's checked ----
    nonisolated static let freezeFunctions = ["SLSMainConnectionID", "SLSNewTransition", "SLSInvokeTransition", "SLSReleaseTransition"]
    nonisolated static let spaceFunctions = ["SLSMainConnectionID", "SLSGetActiveSpace", "SLSCopySpacesForWindows", "SLSCopyManagedDisplaySpaces"]
    nonisolated static let parkFunctions = ["SLSSpaceCreate", "SLSSpaceDestroy"] // and the Space reads, to verify
    nonisolated static var functions: [String] { var seen = Set<String>(); return (freezeFunctions + spaceFunctions + parkFunctions).filter { seen.insert($0).inserted } }

    nonisolated static let addRemoveClass = "SLSBridgedSpaceAddWindowsAndRemoveFromSpacesOperation"
    nonisolated static let removeClass = "SLSBridgedRemoveWindowsFromSpacesOperation"
    nonisolated static let classes = [addRemoveClass, removeClass]
    nonisolated static let initAddRemove = "initWithSpaceID:windows:options:"
    nonisolated static let initRemove = "initWithWindows:spaces:"
    nonisolated static let perform = "performWithWMBridgeDelegate"

    nonisolated struct Selector: Equatable, Sendable {
        var className: String
        var name: String
        var encoding: String // as macOS 27.2 (26B123) has it
        var label: String { "\(className) -\(name)" }
    }
    // Read on Tirth's Mac with method_getTypeEncoding (macOS 27.2, 26B123). The perform selector is
    // SkyLight's own (both classes, implemented in SkyLight); it's checked on each class.
    nonisolated static let selectors = [
        Selector(className: addRemoveClass, name: initAddRemove, encoding: "@36@0:8Q16@24I32"), // (UInt64 space, NSArray windows, UInt32 options)
        Selector(className: removeClass, name: initRemove, encoding: "@32@0:8@16@24"), // (NSArray windows, NSArray spaces)
        Selector(className: addRemoveClass, name: perform, encoding: "v16@0:8"),
        Selector(className: removeClass, name: perform, encoding: "v16@0:8"),
    ]

    // HANDOFF.md §4.1 row 13: a read listing a private Space's windows, for the orphan check. Only a
    // candidate until gate G5 finds the right one; its signature isn't known, so it's never called.
    nonisolated static let enumeratorCandidate = "SLSCopyWindowsWithOptionsAndTags"
    nonisolated static let enumeratorPassedG5 = false

    nonisolated struct Availability: Equatable, Sendable {
        var freeze = false // the freeze and its reveal
        var spaces = false // the Space reads (R1, where to show, verifying parks and shows)
        var park = false // the private Spaces and the bridge (needs spaces)
        var enumerator = false // §4.1 row 13: off until gate G5
        var missing: [String] = [] // frameworks, functions, classes and "Class -selector"
        var mismatched: [String] = [] // "Class -selector" whose type encoding changed
        var reasons: [String: String] = [:] // "freeze", "spaces", "park": why it's off
        var functionsFound = 0, functionsTotal = 0
        var classesFound = 0, classesTotal = 0
        var selectorsFound = 0, selectorsTotal = 0
        var candidateFound = false // the enumerator's candidate resolves
        static let off = Availability()

        // The launch line (HANDOFF.md §8.1).
        func line(version: String, build: String?) -> String {
            func part(_ name: String, _ on: Bool) -> String { on ? "\(name) ok" : "\(name) off: \(reasons[name] ?? "not checked")" }
            let encodings = mismatched.isEmpty ? "encodings ok" : "\(mismatched.count) encoding\(mismatched.count == 1 ? "" : "s") changed"
            let enumeration = enumerator ? "enumerator ok" : "enumerator off (\(candidateFound ? "candidate found, " : "")gate G5)"
            return "private calls on macOS \(version) (\(build ?? "build unknown")): \(part("freeze", freeze)), \(part("spaces", spaces)), \(part("park", park)) "
                + "(\(functionsFound)/\(functionsTotal) functions, \(classesFound)/\(classesTotal) classes, \(selectorsFound)/\(selectorsTotal) selectors, \(encodings)); \(enumeration)"
        }
    }

    // What the resolver has, with no logging and no record (the tests' entry).
    nonisolated static func evaluate(_ resolver: PrivateResolver, enumeratorPassed: Bool = enumeratorPassedG5) -> Availability {
        var a = Availability()
        var missing: [String] = []
        func lack(_ name: String) { if !missing.contains(name) { missing.append(name) } }

        let sky = resolver.open(.skyLight)
        let wm = resolver.open(.windowManagement)
        if !sky { lack(PrivateFramework.skyLight.rawValue) }
        if !wm { lack(PrivateFramework.windowManagement.rawValue) }

        var found = Set<String>()
        for name in functions {
            if sky, resolver.function(name, in: .skyLight) != nil { found.insert(name) } else if sky { lack(name) }
        }
        a.functionsTotal = functions.count
        a.functionsFound = found.count

        var classFound = Set<String>()
        for name in classes {
            if sky, resolver.objcClass(name) != nil { classFound.insert(name) } else if sky { lack(name) }
        }
        a.classesTotal = classes.count
        a.classesFound = classFound.count

        var selectorProblems: [String] = []
        a.selectorsTotal = selectors.count
        for s in selectors where classFound.contains(s.className) {
            guard resolver.responds(s.className, s.name) else { lack(s.label); selectorProblems.append("-\(s.name) missing"); continue }
            a.selectorsFound += 1
            let got = resolver.typeEncoding(s.className, s.name)
            if got != s.encoding {
                a.mismatched.append(s.label)
                selectorProblems.append("-\(s.name) encoding changed (\(got ?? "none"), expected \(s.encoding))")
            }
        }
        a.missing = missing

        // Why each part is off: the first few of its own problems.
        func why(_ problems: [String]) -> String? {
            guard !problems.isEmpty else { return nil }
            let shown = problems.prefix(2).joined(separator: ", ")
            return problems.count > 2 ? "\(shown) and \(problems.count - 2) more" : shown
        }
        let skyProblem = sky ? [] : ["SkyLight.framework didn't open"]
        let freezeProblems = skyProblem + freezeFunctions.filter { sky && !found.contains($0) }.map { "\($0) missing" }
        let spaceProblems = skyProblem + spaceFunctions.filter { sky && !found.contains($0) }.map { "\($0) missing" }
        var parkProblems = skyProblem + (wm ? [] : ["WindowManagement.framework didn't open"])
        parkProblems += parkFunctions.filter { sky && !found.contains($0) }.map { "\($0) missing" }
        parkProblems += classes.filter { sky && !classFound.contains($0) }.map { "\($0) missing" }
        parkProblems += selectorProblems
        if spaceProblems.isEmpty == false, parkProblems.isEmpty { parkProblems = ["the Space reads are off"] }

        a.freeze = freezeProblems.isEmpty
        a.spaces = spaceProblems.isEmpty
        a.park = a.spaces && parkProblems.isEmpty
        a.reasons["freeze"] = why(freezeProblems)
        a.reasons["spaces"] = why(spaceProblems)
        a.reasons["park"] = why(parkProblems)

        a.candidateFound = sky && resolver.function(enumeratorCandidate, in: .skyLight) != nil
        a.enumerator = a.candidateFound && enumeratorPassed
        return a
    }

    // The macOS build against the last one checked; the line to log when it's new or changed.
    // Every launch checks everything anyway: this only says why the results may differ.
    nonisolated static func noteBuild(_ build: String?, defaults: UserDefaults) -> String? {
        guard let build else { return "private calls: the macOS build didn't read (kern.osversion)" }
        let last = defaults.string(forKey: buildKey)
        guard last != build else { return nil }
        defaults.set(build, forKey: buildKey)
        guard let last else { return "private calls: first check on macOS build \(build)" }
        return "private calls: macOS build changed from \(last) to \(build): private calls checked again"
    }

    // At launch (AppDelegate.startShell, through Shell.checkPrivateCalls): what's there, logged.
    // defaults: where the build is kept (nil: not kept, a harness).
    static func check(resolver: PrivateResolver, defaults: UserDefaults?, enumeratorPassed: Bool = enumeratorPassedG5) -> Availability {
        let started = Diagnostics.now()
        if let defaults, let line = noteBuild(resolver.build, defaults: defaults) { Diagnostics.note(line) }
        let a = evaluate(resolver, enumeratorPassed: enumeratorPassed)
        Diagnostics.note(a.line(version: resolver.version, build: resolver.build) + " in " + Diagnostics.ms(since: started))
        return a
    }
}

// The system's: dlopen, dlsym and the Objective-C runtime. Made only in Shell.forApp(). Under
// MARGIN_APP_TESTS it opens nothing and finds nothing, so a test that made one by mistake still
// can't reach a real function.
nonisolated final class RealPrivateResolver: PrivateResolver {
    private let refused: Bool
    // dlopen's handles, kept for the life of the app (never dlclosed: the functions are kept too).
    nonisolated(unsafe) private let handles: [PrivateFramework: UnsafeMutableRawPointer]

    init() {
        refused = PrivateCalls.inTests
        var handles: [PrivateFramework: UnsafeMutableRawPointer] = [:]
        if !refused {
            for framework in PrivateFramework.allCases { handles[framework] = dlopen(framework.path, RTLD_LAZY) }
        }
        self.handles = handles
    }

    var version: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return v.patchVersion == 0 ? "\(v.majorVersion).\(v.minorVersion)" : "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    var build: String? {
        var size = 0
        guard sysctlbyname("kern.osversion", nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("kern.osversion", &bytes, &size, nil, 0) == 0 else { return nil }
        return String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    func open(_ framework: PrivateFramework) -> Bool { !refused && handles[framework] != nil }

    func function(_ name: String, in framework: PrivateFramework) -> UnsafeRawPointer? {
        guard !refused, let handle = handles[framework], let symbol = dlsym(handle, name) else { return nil }
        return UnsafeRawPointer(symbol)
    }

    func objcClass(_ name: String) -> AnyClass? { refused ? nil : NSClassFromString(name) }

    func responds(_ className: String, _ selector: String) -> Bool {
        guard let cls = objcClass(className) as? NSObject.Type else { return false }
        return cls.instancesRespond(to: NSSelectorFromString(selector))
    }

    func typeEncoding(_ className: String, _ selector: String) -> String? {
        guard let cls = objcClass(className), let method = class_getInstanceMethod(cls, NSSelectorFromString(selector)),
              let encoding = method_getTypeEncoding(method) else { return nil }
        return String(cString: encoding)
    }

    func implementation(_ className: String, _ selector: String) -> UnsafeRawPointer? {
        guard let cls = objcClass(className), let method = class_getInstanceMethod(cls, NSSelectorFromString(selector)) else { return nil }
        return unsafeBitCast(method_getImplementation(method), to: UnsafeRawPointer.self)
    }
}

// SLSNewTransition's spec: version 0, type 1 (the whole screen held still), as every lab ran it.
nonisolated struct TransitionSpec {
    var version: UInt32 = 0
    var type: UInt32 = 1
    var option: UInt32 = 0
    var window: UInt32 = 0
    var color: UnsafeMutablePointer<Float>? = nil
}

// The functions, typed, behind wrappers that refuse under MARGIN_APP_TESTS and return nil (or
// false) for anything they can't do. Only the parts the launch check passed are filled in: the
// bridge's initializers are never called with an encoding that changed. The freezer (WP2's
// Freezer.swift) and the parker and Space reads (WP3's) are built on these. Nonisolated: the
// freezer's watchdog reveals from its own queue.
nonisolated struct SkyLight: @unchecked Sendable {
    typealias MainConnectionID = @convention(c) () -> UInt32
    typealias NewTransition = @convention(c) (UInt32, UnsafeRawPointer, UnsafeMutablePointer<Int32>) -> Int32
    typealias InvokeTransition = @convention(c) (UInt32, Int32, Float) -> Int32
    typealias ReleaseTransition = @convention(c) (UInt32, Int32) -> Int32
    typealias GetActiveSpace = @convention(c) (UInt32) -> UInt64
    typealias CopySpacesForWindows = @convention(c) (UInt32, Int32, CFArray) -> Unmanaged<CFArray>?
    typealias CopyManagedDisplaySpaces = @convention(c) (UInt32) -> Unmanaged<CFArray>?
    typealias SpaceCreate = @convention(c) (UInt32, Int32, CFDictionary?) -> UInt64
    typealias SpaceDestroy = @convention(c) (UInt32, UInt64) -> Void
    // The receiver goes in as a raw pointer: init consumes the object alloc made and may return
    // another, so Swift must never retain or release it. The result is +1 (an init's).
    typealias InitAddRemove = @convention(c) (UnsafeMutableRawPointer, ObjectiveC.Selector, UInt64, NSArray, UInt32) -> Unmanaged<AnyObject>?
    typealias InitRemove = @convention(c) (UnsafeMutableRawPointer, ObjectiveC.Selector, NSArray, NSArray) -> Unmanaged<AnyObject>?
    typealias Perform = @convention(c) (AnyObject, ObjectiveC.Selector) -> Void

    let refuses: Bool
    private var mainConnectionID: MainConnectionID?
    private var newTransition: NewTransition?
    private var invokeTransition: InvokeTransition?
    private var releaseTransition: ReleaseTransition?
    private var getActiveSpace: GetActiveSpace?
    private var copySpacesForWindows: CopySpacesForWindows?
    private var copyManagedDisplaySpaces: CopyManagedDisplaySpaces?
    private var spaceCreate: SpaceCreate?
    private var spaceDestroy: SpaceDestroy?
    private var addRemoveClass: AnyClass?
    private var removeClass: AnyClass?
    private var initAddRemove: InitAddRemove?
    private var initRemove: InitRemove?
    private var performAddRemove: Perform?
    private var performRemove: Perform?
    // The bridge's operations are asynchronous (SLSAsynchronousBridgedWindowManagementOperation):
    // the last few are kept alive a while, as the labs (which never released them) did.
    private let kept = KeptOperations()

    // refusing: always true under MARGIN_APP_TESTS, except in the test that checks the wrappers
    // against its own fake functions.
    init(resolver: PrivateResolver, availability: PrivateCalls.Availability, refusing: Bool = PrivateCalls.inTests) {
        refuses = refusing
        func fn<T>(_ name: String, _: T.Type) -> T? { resolver.function(name, in: .skyLight).map { unsafeBitCast($0, to: T.self) } }
        func imp<T>(_ cls: String, _ sel: String, _: T.Type) -> T? { resolver.implementation(cls, sel).map { unsafeBitCast($0, to: T.self) } }
        if availability.freeze || availability.spaces { mainConnectionID = fn("SLSMainConnectionID", MainConnectionID.self) }
        if availability.freeze {
            newTransition = fn("SLSNewTransition", NewTransition.self)
            invokeTransition = fn("SLSInvokeTransition", InvokeTransition.self)
            releaseTransition = fn("SLSReleaseTransition", ReleaseTransition.self)
        }
        if availability.spaces {
            getActiveSpace = fn("SLSGetActiveSpace", GetActiveSpace.self)
            copySpacesForWindows = fn("SLSCopySpacesForWindows", CopySpacesForWindows.self)
            copyManagedDisplaySpaces = fn("SLSCopyManagedDisplaySpaces", CopyManagedDisplaySpaces.self)
        }
        if availability.park {
            spaceCreate = fn("SLSSpaceCreate", SpaceCreate.self)
            spaceDestroy = fn("SLSSpaceDestroy", SpaceDestroy.self)
            addRemoveClass = resolver.objcClass(PrivateCalls.addRemoveClass)
            removeClass = resolver.objcClass(PrivateCalls.removeClass)
            initAddRemove = imp(PrivateCalls.addRemoveClass, PrivateCalls.initAddRemove, InitAddRemove.self)
            initRemove = imp(PrivateCalls.removeClass, PrivateCalls.initRemove, InitRemove.self)
            performAddRemove = imp(PrivateCalls.addRemoveClass, PrivateCalls.perform, Perform.self)
            performRemove = imp(PrivateCalls.removeClass, PrivateCalls.perform, Perform.self)
        }
    }

    private func connection() -> UInt32? {
        guard !refuses, let mainConnectionID else { return nil }
        return mainConnectionID()
    }

    // ---- the freeze ----

    // SLSNewTransition: the result (0 is a freeze) and its handle.
    func freeze() -> (result: Int32, handle: Int32)? {
        guard let cid = connection(), let newTransition else { return nil }
        var spec = TransitionSpec()
        var handle: Int32 = 0
        let result = withUnsafePointer(to: &spec) { newTransition(cid, UnsafeRawPointer($0), &handle) }
        return (result, handle)
    }

    // SLSInvokeTransition with no animation: the result (0 is revealed).
    func reveal(_ handle: Int32) -> Int32? {
        guard let cid = connection(), let invokeTransition else { return nil }
        return invokeTransition(cid, handle, 0)
    }

    // SLSReleaseTransition: only after a reveal that failed.
    func release(_ handle: Int32) -> Int32? {
        guard let cid = connection(), let releaseTransition else { return nil }
        return releaseTransition(cid, handle)
    }

    // ---- the Space reads (nil: unknown) ----

    func activeSpace() -> UInt64? {
        guard let cid = connection(), let getActiveSpace else { return nil }
        let space = getActiveSpace(cid)
        return space == 0 ? nil : space
    }

    // Each window's Spaces (mask 7: every kind, as the labs read them). An empty list is a real
    // answer (in no user Space); nil is unknown.
    func spaces(forWindows windows: [UInt32], mask: Int32 = 7) -> [UInt64]? {
        guard let cid = connection(), let copySpacesForWindows else { return nil }
        guard let list = copySpacesForWindows(cid, mask, windows.map { NSNumber(value: $0) } as CFArray)?.takeRetainedValue() else { return nil }
        guard let numbers = list as? [NSNumber] else { return nil }
        return numbers.map(\.uint64Value)
    }

    // Each display's Spaces, as SkyLight gives them ("Display Identifier", "Spaces" with "id64"
    // and "type", "Current Space"). WP3's SpaceReads reads them.
    func managedDisplaySpaces() -> [[String: Any]]? {
        guard let cid = connection(), let copyManagedDisplaySpaces else { return nil }
        return copyManagedDisplaySpaces(cid)?.takeRetainedValue() as? [[String: Any]]
    }

    // ---- private Spaces and the bridge (parking) ----

    // A new private Space (SLSSpaceCreate(cid, 1, nil), as the labs made it); nil when it's 0.
    func createSpace() -> UInt64? {
        guard let cid = connection(), let spaceCreate else { return nil }
        let space = spaceCreate(cid, 1, nil)
        return space == 0 ? nil : space
    }

    // SLSSpaceDestroy returns nothing: true means it was called.
    func destroySpace(_ space: UInt64) -> Bool {
        guard let cid = connection(), let spaceDestroy else { return false }
        spaceDestroy(cid, space)
        return true
    }

    // The windows into `space`, out of the Spaces they were in (options 7, as every lab parked).
    // True means it was sent; whether it landed is the caller's to verify (HANDOFF.md §4.3).
    func bridgeAdd(windows: [UInt32], toSpace space: UInt64, options: UInt32 = 7) -> Bool {
        guard !refuses, let initAddRemove, let performAddRemove, let raw = alloc(addRemoveClass) else { return false }
        guard let op = initAddRemove(raw, NSSelectorFromString(PrivateCalls.initAddRemove), space, windows.map { NSNumber(value: $0) } as NSArray, options)?.takeRetainedValue() else { return false }
        performAddRemove(op, NSSelectorFromString(PrivateCalls.perform))
        kept.keep(op)
        return true
    }

    // The windows out of `spaces` (a show or a return, out of the private Space).
    func bridgeRemove(windows: [UInt32], fromSpaces spaces: [UInt64]) -> Bool {
        guard !refuses, let initRemove, let performRemove, let raw = alloc(removeClass) else { return false }
        guard let op = initRemove(raw, NSSelectorFromString(PrivateCalls.initRemove), windows.map { NSNumber(value: $0) } as NSArray, spaces.map { NSNumber(value: $0) } as NSArray)?.takeRetainedValue() else { return false }
        performRemove(op, NSSelectorFromString(PrivateCalls.perform))
        kept.keep(op)
        return true
    }

    // +alloc's object, +1, handed to an init that consumes it.
    private func alloc(_ cls: AnyClass?) -> UnsafeMutableRawPointer? {
        guard let cls = cls as? NSObject.Type, let made = cls.perform(NSSelectorFromString("alloc")) else { return nil }
        return made.toOpaque()
    }
}

nonisolated final class KeptOperations: @unchecked Sendable {
    static let count = 16
    private let lock = NSLock()
    private var operations: [AnyObject] = []
    func keep(_ op: AnyObject) {
        lock.lock()
        operations.append(op)
        if operations.count > Self.count { operations.removeFirst(operations.count - Self.count) }
        lock.unlock()
    }
}
