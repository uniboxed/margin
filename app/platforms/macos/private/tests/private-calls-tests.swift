// macOS's private calls (PrivateCalls.swift), part of tests.swift's run, against
// a fake resolver whose "functions" are this file's own (no real private
// function is ever called here, and nothing freezes the screen): the launch
// check's availability for each missing framework, function, class and
// selector and each changed type encoding, the enumerator behind gate G5,
// the macOS build kept in a test's own defaults, the launch line, the
// wrappers refusing under MARGIN_APP_TESTS (which run.sh sets), a nil Copy
// result read as unknown, and the real resolver finding nothing in a test.
import AppKit
import Foundation
import ObjectiveC

// What the fake functions were called with, in order.
nonisolated(unsafe) var fakeSkyCalls: [String] = []
nonisolated(unsafe) var fakeModelAnswer = CGRect(x: 10, y: 20, width: 900, height: 700)
nonisolated(unsafe) var fakeModelResult: Int32 = 0
nonisolated(unsafe) var fakeCopyAnswer: Int = 0 // 0 a list, 1 nil, 2 not numbers

let fakeMainConnection: SkyLight.MainConnectionID = { fakeSkyCalls.append("cid"); return 42 }
let fakeNewTransition: SkyLight.NewTransition = { cid, spec, handle in
    let s = spec.load(as: TransitionSpec.self)
    fakeSkyCalls.append("new \(cid) v\(s.version) t\(s.type) o\(s.option) w\(s.window)")
    handle.pointee = 9
    return 0
}
let fakeInvokeTransition: SkyLight.InvokeTransition = { cid, handle, duration in fakeSkyCalls.append("invoke \(cid) \(handle) \(duration)"); return 0 }
let fakeReleaseTransition: SkyLight.ReleaseTransition = { cid, handle in fakeSkyCalls.append("release \(cid) \(handle)"); return 0 }
let fakeGetModelBounds: SkyLight.GetWindowBounds = { cid, window, out in
    fakeSkyCalls.append("model \(cid) \(window)"); out.pointee = fakeModelAnswer; return fakeModelResult
}
let fakeGetActiveSpace: SkyLight.GetActiveSpace = { cid in fakeSkyCalls.append("active \(cid)"); return 7 }
let fakeCopySpaces: SkyLight.CopySpacesForWindows = { cid, mask, windows in
    fakeSkyCalls.append("spaces \(cid) \(mask) \(CFArrayGetCount(windows))")
    switch fakeCopyAnswer {
    case 1: return nil
    case 2: return Unmanaged.passRetained(["x"] as CFArray)
    default: return Unmanaged.passRetained([NSNumber(value: 3), NSNumber(value: 5)] as CFArray)
    }
}
let fakeCopyDisplays: SkyLight.CopyManagedDisplaySpaces = { cid in
    fakeSkyCalls.append("displays \(cid)")
    return fakeCopyAnswer == 1 ? nil : Unmanaged.passRetained([["Display Identifier": "Main", "Spaces": [["id64": 7, "type": 0]]]] as CFArray)
}
let fakeSpaceCreate: SkyLight.SpaceCreate = { cid, kind, _ in fakeSkyCalls.append("create \(cid) \(kind)"); return 2431 }
let fakeSpaceDestroy: SkyLight.SpaceDestroy = { cid, space in fakeSkyCalls.append("destroy \(cid) \(space)") }
// The bridge's: init consumes the object alloc made (released here) and returns its own, +1.
let fakeInitAddRemove: SkyLight.InitAddRemove = { raw, _, space, windows, options in
    Unmanaged<AnyObject>.fromOpaque(raw).release()
    fakeSkyCalls.append("init add \(space) \(windows.count) \(options)")
    return Unmanaged.passRetained(NSObject())
}
let fakeInitRemove: SkyLight.InitRemove = { raw, _, windows, spaces in
    Unmanaged<AnyObject>.fromOpaque(raw).release()
    fakeSkyCalls.append("init remove \(windows.count) \(spaces.count)")
    return Unmanaged.passRetained(NSObject())
}
let fakePerform: SkyLight.Perform = { _, sel in fakeSkyCalls.append("perform \(NSStringFromSelector(sel))") }

// Everything macOS 27.2 has, unless a test takes something away.
final class FakePrivateResolver: PrivateResolver, @unchecked Sendable {
    var version = "27.2"
    var build: String? = "26B123"
    var frameworks = Set(PrivateFramework.allCases)
    var functions = Set(PrivateCalls.functions + [PrivateCalls.enumeratorCandidate])
    var classes = Set(PrivateCalls.classes)
    var selectors = Set(PrivateCalls.selectors.map(\.label))
    var encodings = Dictionary(uniqueKeysWithValues: PrivateCalls.selectors.map { ($0.label, $0.encoding) })

    func open(_ framework: PrivateFramework) -> Bool { frameworks.contains(framework) }
    func function(_ name: String, in framework: PrivateFramework) -> UnsafeRawPointer? {
        guard frameworks.contains(framework), functions.contains(name) else { return nil }
        func p<T>(_ f: T) -> UnsafeRawPointer { unsafeBitCast(f, to: UnsafeRawPointer.self) }
        switch name {
        case "SLSMainConnectionID": return p(fakeMainConnection)
        case "SLSNewTransition": return p(fakeNewTransition)
        case "SLSInvokeTransition": return p(fakeInvokeTransition)
        case "SLSReleaseTransition": return p(fakeReleaseTransition)
        case "SLSGetWindowBounds": return p(fakeGetModelBounds)
        case "SLSGetActiveSpace": return p(fakeGetActiveSpace)
        case "SLSCopySpacesForWindows": return p(fakeCopySpaces)
        case "SLSCopyManagedDisplaySpaces": return p(fakeCopyDisplays)
        case "SLSSpaceCreate": return p(fakeSpaceCreate)
        case "SLSSpaceDestroy": return p(fakeSpaceDestroy)
        default: return p(fakeMainConnection) // the enumerator's candidate: looked up, never called
        }
    }
    // A stand-in class, so alloc is NSObject's own.
    func objcClass(_ name: String) -> AnyClass? { classes.contains(name) ? NSObject.self : nil }
    func responds(_ className: String, _ selector: String) -> Bool { classes.contains(className) && selectors.contains("\(className) -\(selector)") }
    func typeEncoding(_ className: String, _ selector: String) -> String? { encodings["\(className) -\(selector)"] }
    func implementation(_ className: String, _ selector: String) -> UnsafeRawPointer? {
        guard responds(className, selector) else { return nil }
        func p<T>(_ f: T) -> UnsafeRawPointer { unsafeBitCast(f, to: UnsafeRawPointer.self) }
        switch selector {
        case PrivateCalls.initAddRemove: return p(fakeInitAddRemove)
        case PrivateCalls.initRemove: return p(fakeInitRemove)
        default: return p(fakePerform)
        }
    }
}

// A shell's other parts, for the check only: no windows, no apps.
struct StubWindows: WindowSource { func windows(of pids: Set<pid_t>) -> [ServerWindow] { [] } }
final class StubApps: AppWatch {
    var frontPid: pid_t? { nil }
    func pids(of bundleId: String) -> Set<pid_t> { [] }
    var onChange: ((String) -> Void)?
    func start() {}
    func stop() {}
}

func privateCallsTests() {
    check("private calls: run.sh sets MARGIN_APP_TESTS", PrivateCalls.inTests)

    // ---- the launch check ----
    let all = PrivateCalls.evaluate(FakePrivateResolver())
    check("private calls: all there: freeze, spaces and park on, nothing missing or changed",
          all.freeze && all.spaces && all.park && all.missing.isEmpty && all.mismatched.isEmpty && all.reasons.isEmpty, "\(all)")
    check("private calls: the counts (10 functions, 2 classes, 4 selectors)",
          all.functionsFound == 10 && all.functionsTotal == 10 && all.classesFound == 2 && all.classesTotal == 2 && all.selectorsFound == 4 && all.selectorsTotal == 4, "\(all)")
    check("private calls: the enumerator stays off until gate G5, its candidate found", !all.enumerator && all.candidateFound)
    check("private calls: the enumerator once G5 passed", PrivateCalls.evaluate(FakePrivateResolver(), enumeratorPassed: true).enumerator)
    do {
        let r = FakePrivateResolver()
        r.functions.remove(PrivateCalls.enumeratorCandidate)
        let a = PrivateCalls.evaluate(r, enumeratorPassed: true)
        check("private calls: no enumerator candidate: the enumerator off, nothing else", !a.enumerator && !a.candidateFound && a.freeze && a.park && a.missing.isEmpty, "\(a)")
    }

    func without(function name: String) -> PrivateCalls.Availability {
        let r = FakePrivateResolver()
        r.functions.remove(name)
        return PrivateCalls.evaluate(r)
    }
    let a0 = without(function: "SLSMainConnectionID")
    check("private calls: no SLSMainConnectionID: everything off", !a0.freeze && !a0.spaces && !a0.park && a0.missing == ["SLSMainConnectionID"], "\(a0)")
    for name in ["SLSNewTransition", "SLSInvokeTransition", "SLSReleaseTransition"] {
        let a = without(function: name)
        check("private calls: no \(name): the freeze off, the reads and parking on", !a.freeze && a.spaces && a.park && a.missing == [name] && a.reasons["freeze"] == "\(name) missing", "\(a)")
    }
    for name in ["SLSGetActiveSpace", "SLSCopySpacesForWindows", "SLSCopyManagedDisplaySpaces"] {
        let a = without(function: name)
        check("private calls: no \(name): the reads and parking off, the freeze on", a.freeze && !a.spaces && !a.park && a.missing == [name] && a.reasons["park"] == "the Space reads are off", "\(a)")
    }
    for name in ["SLSSpaceCreate", "SLSSpaceDestroy"] {
        let a = without(function: name)
        check("private calls: no \(name): parking off only", a.freeze && a.spaces && !a.park && a.missing == [name] && a.functionsFound == 9, "\(a)")
    }
    for name in PrivateCalls.classes {
        let r = FakePrivateResolver()
        r.classes.remove(name)
        let a = PrivateCalls.evaluate(r)
        check("private calls: no class \(name): parking off, its selectors not counted", a.freeze && a.spaces && !a.park && a.missing == [name] && a.classesFound == 1 && a.selectorsFound == 2 && a.mismatched.isEmpty, "\(a)")
    }
    for s in PrivateCalls.selectors {
        let r = FakePrivateResolver()
        r.selectors.remove(s.label)
        let a = PrivateCalls.evaluate(r)
        check("private calls: \(s.label) not answered: parking off", a.freeze && a.spaces && !a.park && a.missing == [s.label] && a.selectorsFound == 3, "\(a)")
    }
    for s in PrivateCalls.selectors {
        let r = FakePrivateResolver()
        r.encodings[s.label] = "@40@0:8Q16@24I32I36"
        let a = PrivateCalls.evaluate(r)
        check("private calls: \(s.label)'s encoding changed: parking off, the selector counted as there",
              a.freeze && a.spaces && !a.park && a.missing.isEmpty && a.mismatched == [s.label] && a.selectorsFound == 4 && (a.reasons["park"] ?? "").contains("encoding changed"), "\(a)")
        r.encodings[s.label] = nil
        let b = PrivateCalls.evaluate(r)
        check("private calls: \(s.label) with no encoding at all: parking off, mismatched", !b.park && b.mismatched == [s.label], "\(b)")
    }
    do {
        let r = FakePrivateResolver()
        r.frameworks.remove(.skyLight)
        let a = PrivateCalls.evaluate(r)
        check("private calls: SkyLight doesn't open: everything off, only the framework named", !a.freeze && !a.spaces && !a.park && !a.enumerator && a.missing == ["SkyLight.framework"] && a.functionsFound == 0, "\(a)")
        let w = FakePrivateResolver()
        w.frameworks.remove(.windowManagement)
        let b = PrivateCalls.evaluate(w)
        check("private calls: WindowManagement doesn't open: parking off only", b.freeze && b.spaces && !b.park && b.missing == ["WindowManagement.framework"], "\(b)")
    }
    do {
        let r = FakePrivateResolver()
        r.functions.subtract(["SLSNewTransition", "SLSSpaceCreate"])
        r.classes.remove(PrivateCalls.removeClass)
        r.encodings[PrivateCalls.selectors[0].label] = "x"
        let a = PrivateCalls.evaluate(r)
        check("private calls: several at once: each named once, each part off with its own reasons",
              !a.freeze && a.spaces && !a.park && Set(a.missing) == ["SLSNewTransition", "SLSSpaceCreate", PrivateCalls.removeClass] && a.mismatched == [PrivateCalls.selectors[0].label]
              && (a.reasons["park"] ?? "").hasSuffix("and 1 more"), "\(a)")
    }

    // ---- the macOS build, in a test's own defaults ----
    let suite = "margin-private-calls-tests-\(UUID().uuidString)"
    if let defaults = UserDefaults(suiteName: suite) {
        defer { defaults.removePersistentDomain(forName: suite) }
        check("private calls: the first build checked", PrivateCalls.noteBuild("26B123", defaults: defaults) == "private calls: first check on macOS build 26B123" && defaults.string(forKey: PrivateCalls.buildKey) == "26B123")
        check("private calls: the same build: no line", PrivateCalls.noteBuild("26B123", defaults: defaults) == nil)
        check("private calls: a new build: one line, kept", PrivateCalls.noteBuild("26C45", defaults: defaults) == "private calls: macOS build changed from 26B123 to 26C45: private calls checked again" && defaults.string(forKey: PrivateCalls.buildKey) == "26C45")
        check("private calls: no build read: said, nothing kept", PrivateCalls.noteBuild(nil, defaults: defaults) != nil && defaults.string(forKey: PrivateCalls.buildKey) == "26C45")

        // The check: the build's line, then one launch line, ids and counts only.
        var said: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { said.append($0) }
        let r = FakePrivateResolver()
        r.encodings[PrivateCalls.selectors[0].label] = "@40@0:8"
        let a = PrivateCalls.check(resolver: r, defaults: defaults)
        Diagnostics.echo = echo
        check("private calls: check: parking off for the changed encoding", a.freeze && a.spaces && !a.park)
        check("private calls: check: the build's line, then the launch line", said.count == 2 && said[0].contains("changed from 26C45 to 26B123"), "\(said)")
        let line = said.last ?? ""
        check("private calls: the launch line",
              line.hasPrefix("private calls on macOS 27.2 (26B123): freeze ok, spaces ok, park off: -initWithSpaceID:windows:options: encoding changed (@40@0:8, expected @36@0:8Q16@24I32)")
              && line.contains("(10/10 functions, 2/2 classes, 4/4 selectors, 1 encoding changed); enumerator off (candidate found, gate G5) in "), line)
        said = []
        Diagnostics.echo = { said.append($0) }
        _ = PrivateCalls.check(resolver: FakePrivateResolver(), defaults: nil)
        Diagnostics.echo = echo
        check("private calls: check with no defaults: the launch line only, all ok", said.count == 1 && said[0].contains("freeze ok, spaces ok, park ok, geometry ok (10/10 functions, 2/2 classes, 4/4 selectors, encodings ok)"), "\(said)")
    } else { check("private calls: a test's defaults", false) }

    do {
        let a = without(function: "SLSGetWindowBounds")
        check("private calls: missing model geometry disables only native preview geometry", !a.geometry && a.freeze && a.spaces && a.park && a.reasons["geometry"] == "SLSGetWindowBounds missing")
    }
    // ---- the wrappers ----
    do {
        fakeSkyCalls = []
        let sky = SkyLight(resolver: FakePrivateResolver(), availability: all)
        check("private calls: the wrappers refuse under MARGIN_APP_TESTS", sky.refuses)
        let refused = sky.freeze() == nil && sky.reveal(9) == nil && sky.release(9) == nil && sky.activeSpace() == nil
            && sky.modelBounds(of: 3) == nil && sky.spaces(forWindows: [3]) == nil && sky.managedDisplaySpaces() == nil && sky.createSpace() == nil
            && !sky.destroySpace(2431) && !sky.bridgeAdd(windows: [3], toSpace: 2431) && !sky.bridgeRemove(windows: [3], fromSpaces: [2431])
        check("private calls: refused: every wrapper answers nothing, and no function is called", refused && fakeSkyCalls.isEmpty, "\(fakeSkyCalls)")
    }
    do {
        // Not refusing, against this file's fakes only: what each wrapper sends and reads.
        fakeSkyCalls = []
        fakeCopyAnswer = 0
        let sky = SkyLight(resolver: FakePrivateResolver(), availability: all, refusing: false)
        fakeModelResult = 0
        fakeModelAnswer = CGRect(x: 10, y: 20, width: 900, height: 700)
        check("model geometry: reads the requested window on the owned connection", sky.modelBounds(of: 12) == fakeModelAnswer && fakeSkyCalls == ["cid", "model 42 12"], "\(fakeSkyCalls)")
        fakeModelResult = 1
        check("model geometry: an API error is unknown", sky.modelBounds(of: 12) == nil)
        fakeModelResult = 0
        fakeModelAnswer.size.width = .nan
        check("model geometry: invalid dimensions are unknown", sky.modelBounds(of: 12) == nil)
        check("model geometry: invalid IDs are never queried", sky.modelBounds(of: -1) == nil)
        fakeSkyCalls = []
        let frozen = sky.freeze()
        check("private calls: freeze: spec version 0, type 1; the handle", frozen?.result == 0 && frozen?.handle == 9 && fakeSkyCalls == ["cid", "new 42 v0 t1 o0 w0"], "\(fakeSkyCalls)")
        fakeSkyCalls = []
        check("private calls: reveal with no animation, release", sky.reveal(9) == 0 && sky.release(9) == 0 && fakeSkyCalls == ["cid", "invoke 42 9 0.0", "cid", "release 42 9"], "\(fakeSkyCalls)")
        check("private calls: the active Space", sky.activeSpace() == 7)
        check("private calls: a window's Spaces, mask 7", sky.spaces(forWindows: [3, 4]) == [3, 5] && fakeSkyCalls.last == "spaces 42 7 2", "\(fakeSkyCalls)")
        check("private calls: the displays' Spaces", sky.managedDisplaySpaces()?.first?["Display Identifier"] as? String == "Main")
        fakeCopyAnswer = 1
        check("private calls: a nil Copy result reads as unknown", sky.spaces(forWindows: [3]) == nil && sky.managedDisplaySpaces() == nil)
        fakeCopyAnswer = 2
        check("private calls: a Copy result that isn't numbers reads as unknown", sky.spaces(forWindows: [3]) == nil)
        fakeCopyAnswer = 0
        fakeSkyCalls = []
        check("private calls: a private Space made and destroyed", sky.createSpace() == 2431 && sky.destroySpace(2431) && fakeSkyCalls == ["cid", "create 42 1", "cid", "destroy 42 2431"], "\(fakeSkyCalls)")
        fakeSkyCalls = []
        check("private calls: the bridge: add with options 7, then perform", sky.bridgeAdd(windows: [3, 4], toSpace: 2431) && fakeSkyCalls == ["init add 2431 2 7", "perform performWithWMBridgeDelegate"], "\(fakeSkyCalls)")
        fakeSkyCalls = []
        check("private calls: the bridge: remove, then perform", sky.bridgeRemove(windows: [3], fromSpaces: [2431, 1]) && fakeSkyCalls == ["init remove 1 2", "perform performWithWMBridgeDelegate"], "\(fakeSkyCalls)")
    }
    do {
        // Only what the check passed is filled in: a changed encoding never reaches its initializer.
        fakeSkyCalls = []
        let r = FakePrivateResolver()
        r.encodings[PrivateCalls.selectors[0].label] = "x"
        let a = PrivateCalls.evaluate(r)
        let sky = SkyLight(resolver: r, availability: a, refusing: false)
        check("private calls: parking off: no bridge call and no private Space, the freeze still there",
              !sky.bridgeAdd(windows: [3], toSpace: 1) && !sky.bridgeRemove(windows: [3], fromSpaces: [1]) && sky.createSpace() == nil && !sky.destroySpace(1)
              && !fakeSkyCalls.contains { $0.hasPrefix("init") || $0.hasPrefix("create") || $0.hasPrefix("destroy") } && sky.freeze() != nil, "\(fakeSkyCalls)")
        let none = SkyLight(resolver: FakePrivateResolver(), availability: .off, refusing: false)
        fakeSkyCalls = []
        check("private calls: nothing passed: nothing called", none.freeze() == nil && none.activeSpace() == nil && fakeSkyCalls.isEmpty, "\(fakeSkyCalls)")
    }

    // ---- the real resolver, made here only to see it refuse ----
    do {
        let real = RealPrivateResolver()
        let a = PrivateCalls.evaluate(real)
        check("private calls: the real resolver under MARGIN_APP_TESTS opens and finds nothing",
              !real.open(.skyLight) && real.function("SLSMainConnectionID", in: .skyLight) == nil && real.objcClass(PrivateCalls.addRemoveClass) == nil
              && !a.freeze && !a.spaces && !a.park && a.missing == ["SkyLight.framework", "WindowManagement.framework"], "\(a)")
        check("private calls: the build reads (kern.osversion)", (real.build ?? "").isEmpty == false && real.version.contains("."))
    }

    // ---- the shell ----
    do {
        let shell = Shell(link: SocketLink(), windows: StubWindows(), apps: StubApps(), hotKeys: FakeRegistrar(), options: { var o = Shell.Options(); o.harness = true; return o }())
        shell.checkPrivateCalls()
        check("private calls: a shell with no resolver checks nothing: all off", shell.privateCalls == .off && shell.skyLight == nil)
        var options = Shell.Options()
        options.harness = true
        options.privateResolver = FakePrivateResolver()
        let faked = Shell(link: SocketLink(), windows: StubWindows(), apps: StubApps(), hotKeys: FakeRegistrar(), options: options)
        let echo = Diagnostics.echo
        Diagnostics.echo = { _ in }
        faked.checkPrivateCalls()
        Diagnostics.echo = echo
        check("private calls: a shell with a fake resolver: its availability, its wrappers refusing", faked.privateCalls.park && faked.skyLight?.refuses == true)
    }
}
