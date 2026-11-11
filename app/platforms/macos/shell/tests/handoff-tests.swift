// The profile handoff (docs/HANDOFF.md), part of tests.swift's run. No real
// private function is called here and nothing freezes the screen.
//
// The freezer (Freezer.swift): FakeFreezer on the fake clock (the watchdog at
// 1.7 s, and the close handoff's 1.0 s; its report heard a moment after its
// reveal, as the real one's is; a reveal once only; a release after a
// failed reveal, the watchdog's too; a later freeze's handle never revealed by
// an earlier timer), the session rules (two failed freezes in a row, one
// failed reveal, off at launch; the watchdog counted, not a failure), and
// RealFreezer: refusing under MARGIN_APP_TESTS, then against this file's own
// fake SkyLight functions only, its watchdog on its own queue.
import Foundation

// ---- a fake SkyLight for RealFreezer: the freeze calls only, called from the watchdog's queue too ----

nonisolated(unsafe) var fakeFreezeCalls: [String] = []
nonisolated(unsafe) var fakeFreezeAnswer: (new: Int32, invoke: Int32, release: Int32) = (0, 0, 0)
nonisolated let fakeFreezeLock = NSLock()
nonisolated func fakeFreezeCall(_ s: String) { fakeFreezeLock.lock(); fakeFreezeCalls.append(s); fakeFreezeLock.unlock() }
func fakeFreezeCallsNow() -> [String] { fakeFreezeLock.lock(); defer { fakeFreezeLock.unlock() }; return fakeFreezeCalls }
func fakeFreezeReset() { fakeFreezeLock.lock(); fakeFreezeCalls = []; fakeFreezeAnswer = (0, 0, 0); fakeFreezeLock.unlock() }

let freezeLabConnection: SkyLight.MainConnectionID = { fakeFreezeCall("cid"); return 42 }
let freezeLabNew: SkyLight.NewTransition = { cid, spec, handle in
    let s = spec.load(as: TransitionSpec.self)
    fakeFreezeCall("new \(cid) v\(s.version) t\(s.type) o\(s.option) w\(s.window)")
    handle.pointee = 21
    return fakeFreezeAnswer.new
}
let freezeLabInvoke: SkyLight.InvokeTransition = { cid, handle, duration in
    fakeFreezeCall("invoke \(cid) \(handle) \(duration)\(Thread.isMainThread ? "" : " off main")")
    return fakeFreezeAnswer.invoke
}
let freezeLabRelease: SkyLight.ReleaseTransition = { cid, handle in fakeFreezeCall("release \(cid) \(handle)"); return fakeFreezeAnswer.release }

// SkyLight with the freeze's four functions and nothing else.
final class FreezeOnlyResolver: PrivateResolver, @unchecked Sendable {
    let version = "27.2"
    let build: String? = "26B123"
    func open(_ framework: PrivateFramework) -> Bool { framework == .skyLight }
    func function(_ name: String, in framework: PrivateFramework) -> UnsafeRawPointer? {
        func p<T>(_ f: T) -> UnsafeRawPointer { unsafeBitCast(f, to: UnsafeRawPointer.self) }
        switch name {
        case "SLSMainConnectionID": return p(freezeLabConnection)
        case "SLSNewTransition": return p(freezeLabNew)
        case "SLSInvokeTransition": return p(freezeLabInvoke)
        case "SLSReleaseTransition": return p(freezeLabRelease)
        default: return nil
        }
    }
    func objcClass(_ name: String) -> AnyClass? { nil }
    func responds(_ className: String, _ selector: String) -> Bool { false }
    func typeEncoding(_ className: String, _ selector: String) -> String? { nil }
    func implementation(_ className: String, _ selector: String) -> UnsafeRawPointer? { nil }
}

// The delegate a machine would be: every report, and the session rules kept from them.
final class FreezeListener: FreezerDelegate {
    var reports: [FreezeReport] = []
    var rules = FreezeRules()
    var lines: [String] = []
    let now: () -> Double
    init(now: @escaping () -> Double = { 0 }) { self.now = now }
    func freezer(_ freezer: Freezer, reported: FreezeReport) {
        reports.append(reported)
        if let line = rules.note(reported, at: now()) { lines.append(line) }
    }
}

func handoffTests() {
    freezerTests()
    handoffMachineTests() // the switch's machine (Handoff.swift), below
    handoffReviewTests() // what a review of the machine found, each case failing before its fix
    handoffTopologyTests() // actual shell event dispatch over independent browser/Space fakes
}

func freezerTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }

    // ---- FakeFreezer on the fake clock ----
    do {
        let clock = FakeClock()
        let fake = FakeFreezer(clock: clock)
        let heard = FreezeListener(now: { clock.now() })
        fake.delegate = heard
        check("freezer: the watchdog is 1.7 s, the close handoff's 1.0 s", FreezerOptions().watchdog == 1.7 && FreezerOptions().closeWatchdog == 1.0)
        check("freezer: a freeze: a handle, live", fake.freeze() == .frozen(handle: 1) && fake.isLive && heard.reports == [.froze(handle: 1)], "\(heard.reports)")
        clock.advance(1.69)
        check("freezer: still live at 1.69 s", fake.isLive && fake.calls == ["freeze 1.7 s: 0"], "\(fake.calls)")
        clock.advance(0.01)
        check("freezer: the watchdog reveals at 1.7 s", !fake.isLive && fake.calls.last == "reveal 1 watchdog: 0", "\(fake.calls)")
        // As the real one's: revealed on its own queue, heard on the main actor a moment later.
        check("freezer: … its report not heard yet, as the real one's isn't", heard.reports == [.froze(handle: 1)], "\(heard.reports)")
        check("freezer: … a reveal in that gap: not live, nothing called or reported",
              fake.reveal(.ready) == .notLive && fake.calls.count == 2 && heard.reports.count == 1, "\(fake.calls)")
        clock.advance(fake.watchdogReportLag)
        check("freezer: then the watchdog's report, with the time it was revealed at",
              heard.reports.last == .revealed(handle: 1, why: .watchdog, heldMs: 1700) && heard.reports.count == 2, "\(heard.reports)")
        check("freezer: the watchdog counted, not a failure", heard.rules.on && heard.rules.watchdogs == 1 && heard.rules.lastWatchdogAt == clock.now() && heard.rules.lastRevealAt == clock.now())
        check("freezer: the watchdog's line: handle and milliseconds", heard.lines == ["handoff: watchdog revealed freeze 1 at 1700 ms (1 this session)"], "\(heard.lines)")
        check("freezer: a reveal after the watchdog's: nothing to reveal, nothing called", fake.reveal(.ready) == .notLive && fake.calls.count == 2 && heard.reports.count == 2)
    }
    do {
        // A reveal once only, and the watchdog cancelled by it.
        let clock = FakeClock()
        let fake = FakeFreezer(clock: clock)
        let heard = FreezeListener(now: { clock.now() })
        fake.delegate = heard
        _ = fake.freeze()
        clock.advance(0.5)
        check("freezer: revealed when ready", fake.reveal(.ready) == .revealed && !fake.isLive && heard.reports.last == .revealed(handle: 1, why: .ready, heldMs: 500), "\(heard.reports)")
        check("freezer: a second reveal: not live, nothing called", fake.reveal(.failed) == .notLive && fake.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"], "\(fake.calls)")
        clock.advance(2)
        check("freezer: no watchdog after a reveal", fake.calls.count == 2 && heard.reports.count == 2 && heard.rules.watchdogs == 0 && heard.lines.isEmpty, "\(fake.calls)")
        check("freezer: the last reveal's time kept (the cooldown's)", heard.rules.lastRevealAt == 1000.5 && heard.rules.lastWatchdogAt == nil, "\(String(describing: heard.rules.lastRevealAt))")

        // A later freeze has its own handle and timer: the earlier one's never reveals it.
        check("freezer: a new freeze, a new handle", fake.freeze() == .frozen(handle: 2))
        check("freezer: a freeze while one is live: refused, nothing called or reported",
              fake.freeze() == .unavailable("a freeze is already live") && fake.calls.count == 3 && heard.reports.count == 3, "\(fake.calls)")
        clock.advance(1.69)
        check("freezer: the new freeze live until its own 1.7 s", fake.isLive)
        clock.advance(0.01)
        check("freezer: then its watchdog", !fake.isLive && fake.calls.last == "reveal 2 watchdog: 0")
    }
    do {
        // The close handoff's second freeze: its own, shorter watchdog.
        let clock = FakeClock()
        let fake = FakeFreezer(clock: clock)
        _ = fake.freeze(watchdog: fake.options.closeWatchdog)
        clock.advance(0.99)
        let before = fake.isLive
        clock.advance(0.01)
        check("freezer: a watchdog of 1.0 s for the close handoff", before && !fake.isLive && fake.calls == ["freeze 1.0 s: 0", "reveal 1 watchdog: 0"], "\(fake.calls)")
    }
    do {
        // A failed reveal: released, once, and the freeze off for the session.
        let clock = FakeClock()
        let fake = FakeFreezer(clock: clock)
        let heard = FreezeListener(now: { clock.now() })
        fake.delegate = heard
        fake.revealResults = [1011]
        _ = fake.freeze()
        clock.advance(0.3)
        check("freezer: a reveal that answers nonzero: released", fake.reveal(.ready) == .failed(1011, released: 0)
              && fake.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 1011", "release 1: 0"] && !fake.isLive, "\(fake.calls)")
        check("freezer: reported with the release's answer",
              heard.reports.last == .revealFailed(handle: 1, why: .ready, result: 1011, released: 0, heldMs: 300), "\(heard.reports)")
        check("freezer: one failed reveal turns the freeze off", !heard.rules.on
              && heard.lines == ["private calls: freeze off for this session: the reveal of freeze 1 (ready, 300 ms) answered 1011; released, result 0"], "\(heard.lines)")
        clock.advance(2)
        check("freezer: no watchdog and no second release after it", fake.reveal(.ready) == .notLive && fake.calls.count == 3, "\(fake.calls)")
    }
    do {
        // The watchdog's own reveal failing: released too.
        let clock = FakeClock()
        let fake = FakeFreezer(clock: clock)
        let heard = FreezeListener(now: { clock.now() })
        fake.delegate = heard
        fake.revealResults = [7]
        fake.releaseResults = [3]
        _ = fake.freeze()
        clock.advance(1.7 + fake.watchdogReportLag)
        check("freezer: a failed watchdog reveal: released", fake.calls == ["freeze 1.7 s: 0", "reveal 1 watchdog: 7", "release 1: 3"]
              && heard.reports.last == .revealFailed(handle: 1, why: .watchdog, result: 7, released: 3, heldMs: 1700), "\(fake.calls)")
        check("freezer: and off for the session, the watchdog still counted", !heard.rules.on && heard.rules.watchdogs == 1 && (heard.rules.off ?? "").contains("answered 7; released, result 3"))
    }
    do {
        // The two-failure rule: two failed freezes in a row, and only in a row.
        let clock = FakeClock()
        let fake = FakeFreezer(clock: clock)
        let heard = FreezeListener(now: { clock.now() })
        fake.delegate = heard
        fake.freezeResults = [1000, 0, 1000, 1001]
        check("freezer: a freeze that answers nonzero: this switch unfrozen", fake.freeze() == .failed(1000) && !fake.isLive && heard.reports == [.freezeFailed(result: 1000)])
        check("freezer: one failure: still on", heard.rules.on && heard.rules.failedInARow == 1
              && heard.lines == ["handoff: freeze failed (result 1000): this switch runs without one"], "\(heard.lines)")
        check("freezer: no watchdog for a freeze that failed", { clock.advance(2); return fake.calls == ["freeze 1.7 s: 1000"] }(), "\(fake.calls)")
        _ = fake.freeze()
        fake.reveal(.ready)
        check("freezer: a freeze that works resets the count", heard.rules.on && heard.rules.failedInARow == 0)
        _ = fake.freeze()
        check("freezer: a failure after a success: still on", heard.rules.on && heard.rules.failedInARow == 1)
        check("freezer: a second failure in a row", fake.freeze() == .failed(1001))
        check("freezer: two in a row turn the freeze off for the session", !heard.rules.on && heard.rules.failedInARow == 2
              && heard.lines.last == "private calls: freeze off for this session: SLSNewTransition answered 1001 on 2 switches in a row", "\(heard.lines)")
        fake.freezeResults = [1002]
        _ = fake.freeze()
        check("freezer: off stays off, with its first reason, and says so once", !heard.rules.on && (heard.rules.off ?? "").contains("1001")
              && heard.lines.filter { $0.contains("freeze off") }.count == 1, "\(heard.lines)")
    }
    do {
        let fake = FakeFreezer(clock: FakeClock())
        let heard = FreezeListener()
        fake.delegate = heard
        fake.unavailable = "no freeze calls"
        check("freezer: unavailable: nothing called, nothing reported", fake.freeze() == .unavailable("no freeze calls") && fake.calls.isEmpty && heard.reports.isEmpty && heard.rules.on)
        check("freezer: nothing to reveal", fake.reveal(.quit) == .notLive)
        var launch = PrivateCalls.Availability.off
        launch.reasons["freeze"] = "SLSNewTransition missing"
        check("freezer: the rules off from launch when the freeze calls didn't pass", FreezeRules(availability: launch).off == "missing at launch (SLSNewTransition missing)")
        var ok = PrivateCalls.Availability.off
        ok.freeze = true
        check("freezer: the rules on from launch when they did", FreezeRules(availability: ok).on && FreezeRules().on)
    }

    // ---- RealFreezer: refusing under MARGIN_APP_TESTS ----
    do {
        fakeFreezeReset()
        let resolver = FreezeOnlyResolver()
        let available = PrivateCalls.evaluate(resolver)
        check("freezer: the fake SkyLight passes the freeze only", available.freeze && !available.spaces && !available.park, "\(available)")
        let real = RealFreezer(skyLight: SkyLight(resolver: resolver, availability: available, refusing: false))
        let heard = FreezeListener()
        real.delegate = heard
        check("freezer: RealFreezer refuses under MARGIN_APP_TESTS", real.refuses && real.freeze() == .unavailable("refused under MARGIN_APP_TESTS")
              && !real.isLive && real.reveal(.ready) == .notLive && heard.reports.isEmpty && fakeFreezeCallsNow().isEmpty, "\(fakeFreezeCallsNow())")
        let wrappersRefuse = RealFreezer(skyLight: SkyLight(resolver: resolver, availability: available), refusing: false)
        check("freezer: and with SkyLight's wrappers refusing, nothing is called either",
              wrappersRefuse.freeze() == .unavailable("the freeze calls refused") && fakeFreezeCallsNow().isEmpty, "\(fakeFreezeCallsNow())")
        check("freezer: no SkyLight: unavailable", RealFreezer(skyLight: nil, refusing: false).freeze() == .unavailable("no freeze calls"))
    }

    // ---- RealFreezer against the fake functions: its own queue and lock ----
    func spin(_ seconds: Double, until done: () -> Bool = { false }) {
        let until = Date().addingTimeInterval(seconds)
        while !done(), Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }
    }
    let resolver = FreezeOnlyResolver()
    let sky = SkyLight(resolver: resolver, availability: PrivateCalls.evaluate(resolver), refusing: false)
    do {
        fakeFreezeReset()
        let real = RealFreezer(skyLight: sky, options: FreezerOptions(watchdog: 0.05), refusing: false)
        let heard = FreezeListener()
        real.delegate = heard
        check("freezer: real: a freeze with spec version 0, type 1", real.freeze() == .frozen(handle: 21) && real.isLive
              && fakeFreezeCallsNow() == ["cid", "new 42 v0 t1 o0 w0"] && heard.reports == [.froze(handle: 21)], "\(fakeFreezeCallsNow())")
        spin(2) { heard.reports.count >= 2 }
        let calls = fakeFreezeCallsNow()
        check("freezer: real: the watchdog reveals off the main thread", calls.count == 4 && calls[3] == "invoke 42 21 0.0 off main" && !real.isLive, "\(calls)")
        if case .revealed(21, .watchdog, let ms)? = heard.reports.last {
            check("freezer: real: the watchdog's report reaches the delegate on the main actor, with its time", ms >= 45 && ms < 1000, "\(ms) ms")
        } else { check("freezer: real: the watchdog's report", false, "\(heard.reports)") }
        check("freezer: real: a reveal after the watchdog's: nothing called", real.reveal(.ready) == .notLive && fakeFreezeCallsNow().count == 4)
    }
    do {
        fakeFreezeReset()
        let real = RealFreezer(skyLight: sky, options: FreezerOptions(watchdog: 0.05), refusing: false)
        let heard = FreezeListener()
        real.delegate = heard
        _ = real.freeze()
        check("freezer: real: revealed on the main thread when ready", real.reveal(.ready) == .revealed && fakeFreezeCallsNow().last == "invoke 42 21 0.0", "\(fakeFreezeCallsNow())")
        spin(0.2)
        check("freezer: real: once only: the watchdog cancelled", real.reveal(.ready) == .notLive && fakeFreezeCallsNow().filter { $0.hasPrefix("invoke") }.count == 1
              && heard.reports.count == 2, "\(fakeFreezeCallsNow())")
    }
    do {
        fakeFreezeReset()
        let real = RealFreezer(skyLight: sky, options: FreezerOptions(watchdog: 0.05), refusing: false)
        let heard = FreezeListener()
        real.delegate = heard
        fakeFreezeAnswer = (0, 1011, 0)
        _ = real.freeze()
        check("freezer: real: a failed reveal is released", real.reveal(.failed) == .failed(1011, released: 0)
              && Array(fakeFreezeCallsNow().suffix(3)) == ["invoke 42 21 0.0", "cid", "release 42 21"] && !heard.rules.on, "\(fakeFreezeCallsNow())")
        fakeFreezeReset()
        fakeFreezeAnswer = (0, 9, 0)
        let again = RealFreezer(skyLight: sky, options: FreezerOptions(watchdog: 0.05), refusing: false)
        let heard2 = FreezeListener()
        again.delegate = heard2
        _ = again.freeze()
        spin(2) { heard2.reports.count >= 2 }
        check("freezer: real: a failed watchdog reveal is released on its queue",
              fakeFreezeCallsNow().suffix(3) == ["invoke 42 21 0.0 off main", "cid", "release 42 21"] && !heard2.rules.on, "\(fakeFreezeCallsNow()) \(heard2.reports)")
        fakeFreezeReset()
        fakeFreezeAnswer = (1000, 0, 0)
        let failing = RealFreezer(skyLight: sky, refusing: false)
        let heard3 = FreezeListener()
        failing.delegate = heard3
        check("freezer: real: a freeze that answers nonzero: not live, reported", failing.freeze() == .failed(1000) && !failing.isLive && heard3.reports == [.freezeFailed(result: 1000)])
        spin(0.05)
        check("freezer: real: no watchdog and no reveal for it", !fakeFreezeCallsNow().contains { $0.hasPrefix("invoke") }, "\(fakeFreezeCallsNow())")
    }
    do {
        // Never leave the screen held: a freezer that goes away reveals what it holds.
        fakeFreezeReset()
        var real: RealFreezer? = RealFreezer(skyLight: sky, options: FreezerOptions(watchdog: 5), refusing: false)
        _ = real?.freeze()
        real = nil
        check("freezer: real: a freezer let go while live reveals at once", fakeFreezeCallsNow().last == "invoke 42 21 0.0", "\(fakeFreezeCallsNow())")
        fakeFreezeReset()
    }
}

// ---- the switch's machine (Handoff.swift) against a fake Safari ----
//
// FakeHandoffWorld plays Safari on the fake clock: each profile's copy (its windows with ids, states,
// focus and spaces; requests answered after a round trip; windows calls one at a time per window,
// `busy` and `refused: late` as the copy answers them, hung calls held until let go), the window
// server and its Spaces (FakeSpaceWorld: the active Space, the full-screen Spaces a window enters
// and leaves, the displays), the real parker and registry over it, FakeFreezer, the overlays (the
// cover drawn, `framed` after a window enters full screen, ordered out) and the notices.

final class FakeHandoffWorld: HandoffWorld {
    var off: Set<String> = [] // profiles Margin is turned off in (the browser's settings)
    func marginOff(_ profile: String) -> Bool { off.contains(profile) }
    // Safari's own menu opening a profile's window (Shell.openProfileWindow, through Accessibility): asked for these.
    var opensWindows = false
    var openedWindowFor: [String] = []
    var openedFrozen: [Bool] = [] // the freeze was live as each was asked
    func openProfileWindow(_ profile: String) -> Bool {
        guard opensWindows else { return false }
        openedWindowFor.append(profile)
        openedFrozen.append(freezer.isLive)
        return true
    }
    struct Win {
        var id: Int
        var number: Int
        var state: String
        var focused = false
        var focusedAt: Double?
        var normal: CGRect
        var space = "s1"
    }
    struct Req {
        let link: String
        let type: String
        let payload: JSONObject
        let at: Double
        let frozen: Bool // the freeze was live when it was sent
        var covered = false // an independently acknowledged live cover was shown when it was sent
        var windowId: Int? { int(payload["windowId"]) }
        var state: String? { payload["state"] as? String }
    }

    let clock = FakeClock()
    let reads: FakeSpaceWorld
    let freezer: FakeFreezer
    let spaceParker: SpaceParker
    let registry: ParkingRegistry
    weak var switcher: ProfileSwitch?
    var strands: [String] = []
    let pid: pid_t = 500
    let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let desktop: UInt64 = 1
    var fs: [UInt64] = [] // the full-screen Spaces, on the main display
    var nextFs: UInt64 = 100
    var displays = 1 { didSet { updateDisplays() } }
    var displaysUnread = false { didSet { updateDisplays() } } // SLSCopyManagedDisplaySpaces answers nothing
    var slides = false // a window asked into full screen from a Space that isn't the active one: macOS slides there first
    var linked: Set<String> = []
    var wins: [String: [Win]] = [:]
    var nextId = 50
    var nextNumber = 5000
    var unbound: Set<Int> = [] // numbers the binder hasn't bound
    var noFreezer = false
    var noReads = false
    var gateOff = false // the shell's gate (Options.handoff) off
    var parkingOnFlag = true
    var closeWindows = false
    var lag = 0.02 // each way
    var enterLag: [String: Double] = [:] // per link; else 0.8 (STP: 790-951 ms)
    var exitLag = 0.2
    var slowExit: [WindowKey: Double] = [:]
    var createLag = 0.25
    var framedLag = 0.03
    var coverLag = 0.03
    var coverOn = true
    var liveCover: HandoffCover?
    var liveContextAvailable = true
    var blockedOverlays: Set<WindowKey> = []
    var blockedFront: Set<WindowKey> = [] // browser reports another window above this one, independent of its active Space
    var spaceSelectionLag: Double = 0 // selected-space storage echo, independent of tab/native readiness
    var spaceSelectionFocuses = false // Safari may activate that window when its selected space changes
    var framedOn = true
    var hung: Set<WindowKey> = [] // its windows calls held (a hung tab), until `unhang`
    private var held: [WindowKey: () -> Void] = [:]
    private(set) var calling: Set<WindowKey> = [] // windows calls the copy has under way
    var drafts: [WindowKey: JSONObject] = [:]
    var silentDrafts = false
    var probeAnswer: JSONObject?
    var noFullScreen: Set<WindowKey> = [] // asked for full screen, Safari never enters
    var wrongBounds: Set<WindowKey> = [] // enters, but its bounds never fill the display
    var noCreateAnswer = false
    var closeFails = 0
    var dropOnClose = false // macOS shows the Desktop as a closed window's full-screen Space goes (§4.5)
    var ignoreFocus = 0 // focusWindow calls that bring nothing to the front
    var dialogs: [ServerWindow] = []
    var outOverlays: [WindowKey] = []
    var requests: [Req] = []
    var events: [ProfileSwitch.Event] = []
    var notices: [SwitchNotice] = []
    var onRequest: ((Req) -> Void)?
    var onEvent: ((ProfileSwitch.Event) -> Void)?
    var errors: [String: String] = [:] // "link type" → the copy's error for that request (its words, as Safari's can be)
    var devAllowed = false // DEV-HOOK: the dev hook allows this switch (both Test A and Test B, its default on)

    private func later(_ seconds: Double, _ fire: @escaping () -> Void) { _ = clock.after(seconds, fire) }

    init() {
        reads = FakeSpaceWorld(clock: clock)
        reads.lag = 0.002
        freezer = FakeFreezer(clock: clock)
        spaceParker = SpaceParker(reads: reads, bridge: reads, clock: clock)
        registry = ParkingRegistry(parker: spaceParker, reads: reads, clock: clock, marker: nil, build: nil)
        registry.parkingOn = { [weak self] in self?.parkingOnFlag ?? false }
        registry.strandCheck = { [weak self] in self?.strands.append($0) }
        reads.active = desktop
        updateDisplays()
    }

    // ---- set-up ----

    @discardableResult
    func add(_ link: String, id: Int, number: Int, state: String, space: String = "s1") -> WindowKey {
        let normal = CGRect(x: 100, y: 80, width: 1200, height: 800)
        if state == "fullscreen" {
            reads.windows[number] = .init(pid: pid, bounds: display, spaces: [newFs()])
        } else {
            reads.windows[number] = .init(pid: pid, bounds: normal, spaces: state == "minimized" ? [] : [desktop])
        }
        wins[link, default: []].append(Win(id: id, number: number, state: state, normal: normal, space: space))
        linked.insert(link)
        return WindowKey(link: link, windowId: id)
    }

    // A normal window parked through the registry, as a switch would have.
    func park(_ key: WindowKey, home: Bool = true) {
        guard let w = win(key) else { return }
        registry.park(number: w.number, link: key.link, windowId: key.windowId, pid: pid, bounds: w.normal, cause: .handoff)
        clock.advance(0.05)
        if home { registry.noteShown(link: key.link, number: w.number) }
    }

    func newFs() -> UInt64 {
        let s = nextFs
        nextFs += 1
        fs.append(s)
        updateDisplays()
        return s
    }

    func updateDisplays() {
        guard !displaysUnread else { reads.displayList = nil; return }
        var list = [DisplaySpaces(display: "Main", current: reads.active, spaces: [ManagedSpace(id: desktop, type: 0)] + fs.map { ManagedSpace(id: $0, type: 4) })]
        for i in 1..<max(displays, 1) { list.append(DisplaySpaces(display: "D\(i)", current: UInt64(900 + i), spaces: [ManagedSpace(id: UInt64(900 + i), type: 0)])) }
        reads.displayList = list
    }

    func setActive(_ s: UInt64) {
        reads.active = s
        updateDisplays()
    }

    func unhang(_ key: WindowKey) {
        hung.remove(key)
        held.removeValue(forKey: key)?()
    }

    // ---- reading it ----

    func win(_ key: WindowKey) -> Win? { wins[key.link]?.first { $0.id == key.windowId } }
    func update(_ key: WindowKey, _ change: (inout Win) -> Void) {
        guard let i = wins[key.link]?.firstIndex(where: { $0.id == key.windowId }) else { return }
        change(&wins[key.link]![i])
    }
    func spacesOf(_ key: WindowKey) -> [UInt64] { win(key).flatMap { reads.spaces(of: $0.number) } ?? [] }
    func inFrontNow(_ key: WindowKey) -> Bool { reads.active.map { spacesOf(key).contains($0) } ?? false }
    func fullAndInFront(_ key: WindowKey) -> Bool { win(key)?.state == "fullscreen" && inFrontNow(key) && fs.contains(reads.active ?? 0) }
    func types(_ link: String? = nil, _ type: String? = nil) -> [Req] { requests.filter { (link == nil || $0.link == link) && (type == nil || $0.type == type) } }

    // ---- Safari ----

    func focus(_ key: WindowKey) {
        for l in wins.keys { for i in wins[l]!.indices { wins[l]![i].focused = false } }
        update(key) { $0.focused = true; $0.focusedAt = clock.now() }
        if let s = spacesOf(key).first(where: { $0 == desktop || fs.contains($0) }) { setActive(s) }
    }

    func enter(_ key: WindowKey, _ done: @escaping (Bool) -> Void) {
        guard let w = win(key) else { return done(false) }
        if w.state == "fullscreen", spacesOf(key).contains(where: { fs.contains($0) }) {
            focus(key)
            return done(true)
        }
        // Focusing a window on another Space (its Desktop) makes that Space the active one at once.
        if slides, let active = reads.active, !spacesOf(key).contains(active), let there = spacesOf(key).first { setActive(there) }
        if noFullScreen.contains(key) { return }
        later(enterLag[key.link] ?? 0.8) { [self] in
            guard let w = self.win(key) else { return done(false) }
            let s = self.newFs()
            self.reads.windows[w.number]?.spaces = [s]
            self.reads.windows[w.number]?.bounds = self.wrongBounds.contains(key) ? CGRect(x: 0, y: 40, width: 1512, height: 900) : self.display
            self.update(key) { $0.state = "fullscreen" }
            self.focus(key)
            if self.framedOn { self.later(self.framedLag) { [weak self] in self?.switcher?.framed(key, mode: .fullscreen) } }
            done(true)
        }
    }

    func exit(_ key: WindowKey, after: Double, _ done: @escaping (Bool) -> Void) {
        guard let w = win(key), w.state == "fullscreen" else { return done(win(key) != nil) }
        later(after) { [self] in
            guard let w = self.win(key) else { return done(false) }
            let old = self.spacesOf(key).filter { self.fs.contains($0) }
            self.fs.removeAll { old.contains($0) }
            self.reads.windows[w.number]?.spaces = [self.desktop]
            self.reads.windows[w.number]?.bounds = w.normal
            self.update(key) { $0.state = "normal" }
            if let a = self.reads.active, old.contains(a) { self.reads.active = self.desktop }
            self.updateDisplays()
            done(true)
        }
    }

    func close(_ key: WindowKey) {
        guard let w = win(key) else { return }
        let old = spacesOf(key).filter { fs.contains($0) }
        fs.removeAll { old.contains($0) }
        reads.windows[w.number] = nil
        wins[key.link]?.removeAll { $0.id == key.windowId }
        if let a = reads.active, old.contains(a) { reads.active = desktop }
        updateDisplays()
    }

    // ---- HandoffWorld ----

    var handoffOn: Bool { !gateOff }
    var handoffFreezer: Freezer? { noFreezer ? nil : freezer }
    var handoffCover: HandoffCover? { liveCover }
    func handoffCoverContext(from: WindowKey, to: ProfileSwitch.Target) -> LiveCoverContext? {
        liveContextAvailable ? LiveCoverContext(hello: "{}", display: display, viewport: display) : nil
    }
    var spaceReads: SpaceReads? { noReads ? nil : reads }
    var parker: BridgeParker? { spaceParker }
    var parking: ParkingRegistry? { registry }
    var parkingOn: Bool { parkingOnFlag }
    func closesWindows(_ link: String) -> Bool { closeWindows }
    func isLinked(_ profile: String) -> Bool { linked.contains(profile) }

    func request(_ profile: String, _ type: String, _ payload: JSONObject, windowId: Int?, done: @escaping (JSONObject?, String?) -> Void) {
        let r = Req(link: profile, type: type, payload: payload, at: clock.now(), frozen: freezer.isLive, covered: liveCover?.state == .shown)
        requests.append(r)
        onRequest?(r)
        let reply = { [self] (result: JSONObject?, error: String?) in self.later(self.lag) { done(result, error) } }
        guard linked.contains(profile) else { return reply(nil, "not linked") }
        later(lag) { [self] in self.arrive(r, windowId: windowId, reply) }
    }

    private func arrive(_ r: Req, windowId: Int?, _ reply: @escaping (JSONObject?, String?) -> Void) {
        guard linked.contains(r.link) else { return } // its copy went away: no answer
        if let error = errors["\(r.link) \(r.type)"] { return reply(nil, error) }
        let key = WindowKey(link: r.link, windowId: r.windowId ?? windowId ?? -1)
        if ["setWindowState", "focusWindow", "closeWindow"].contains(r.type) {
            if let notAfter = num(r.payload["notAfter"]), clock.now() * 1000 > notAfter {
                return reply(["refused": "late", "pastMs": clock.now() * 1000 - notAfter], nil)
            }
            if calling.contains(key) { return reply(["busy": true], nil) }
            calling.insert(key)
            let carry = { [self] in self.windowsCall(r, key) { result, error in self.calling.remove(key); reply(result, error) } }
            if hung.contains(key) { held[key] = carry; return }
            return carry()
        }
        switch r.type {
        case "openSpaceWindow":
            if noCreateAnswer { return }
            later(createLag) { [self] in
                let id = self.nextId, number = self.nextNumber
                self.nextId += 1
                self.nextNumber += 1
                let normal = CGRect(x: 120, y: 90, width: 1200, height: 800)
                self.reads.windows[number] = .init(pid: self.pid, bounds: normal, spaces: [self.reads.active ?? self.desktop])
                self.wins[r.link, default: []].append(Win(id: id, number: number, state: "normal", normal: normal, space: r.payload["spaceId"] as? String ?? "s1"))
                reply(["windowId": id, "state": "normal", "bounds": ["left": 120, "top": 90, "width": 1200, "height": 800]], nil)
                // macOS puts a window made beside a full-screen one in full screen by itself (bg-create).
                self.enter(WindowKey(link: r.link, windowId: id)) { _ in }
            }
        case "setSpace":
            later(spaceSelectionLag) { [self] in update(key) { $0.space = r.payload["spaceId"] as? String ?? $0.space } }
            if spaceSelectionFocuses { focus(key) }
            reply([:], nil)
        case "windowDrafts":
            if silentDrafts { return }
            reply(drafts[key] ?? ["drafts": [], "unknown": []], nil)
        case "frameProbe":
            reply(probeAnswer ?? ["none": "no page"], nil)
        default:
            reply(nil, "unknown")
        }
    }

    private func windowsCall(_ r: Req, _ key: WindowKey, _ done: @escaping (JSONObject?, String?) -> Void) {
        guard win(key) != nil else { return done(nil, "no window") }
        switch r.type {
        case "setWindowState":
            if r.state == "fullscreen" {
                if noFullScreen.contains(key) {
                    later(3) { done(["windowId": key.windowId, "state": "fullscreen", "timedOut": true], nil) }
                    return
                }
                enter(key) { [self] ok in
                    if ok, r.payload["focused"] as? Bool == true { self.focus(key) }
                    done(ok ? ["windowId": key.windowId, "state": "fullscreen", "landedAt": self.clock.now() * 1000] : nil, ok ? nil : "gone")
                }
            } else {
                let wait = slowExit[key] ?? exitLag
                var answered = false
                if wait > 3 { later(3) { answered = true; done(["windowId": key.windowId, "state": "normal", "timedOut": true], nil) } }
                exit(key, after: wait) { [self] ok in
                    guard !answered else { return }
                    done(ok ? ["windowId": key.windowId, "state": "normal", "landedAt": self.clock.now() * 1000] : nil, ok ? nil : "gone")
                }
            }
        case "focusWindow":
            if ignoreFocus > 0 {
                ignoreFocus -= 1
                return done(["windowId": key.windowId, "state": win(key)?.state ?? "normal"], nil)
            }
            if r.payload["fullscreen"] as? Bool == true { enter(key) { _ in } }
            focus(key)
            done(["windowId": key.windowId, "state": win(key)?.state ?? "normal"], nil)
        case "closeWindow":
            if closeFails > 0 {
                closeFails -= 1
                return done(nil, "couldn't close")
            }
            close(key)
            if dropOnClose { setActive(desktop) }
            done([:], nil)
        default:
            done(nil, "unknown")
        }
    }

    func windows(of profile: String) -> [(id: Int, state: String)] { copyWindows(profile).map { ($0.key.windowId, $0.state) } }
    func inFront(_ profile: String, windowId: Int) -> Bool {
        let key = WindowKey(link: profile, windowId: windowId)
        return !blockedFront.contains(key) && inFrontNow(key)
    }
    func switchChanged(_ event: ProfileSwitch.Event) {
        events.append(event)
        onEvent?(event)
        if case .started = event, coverOn {
            later(coverLag) { [weak self] in
                guard let s = self?.switcher, let a = s.leaving else { return }
                s.coverShown(in: a)
            }
        }
    }
    func copyWindows(_ link: String) -> [ExtWindow] {
        guard linked.contains(link) else { return [] }
        return (wins[link] ?? []).map { w in
            ExtWindow(key: WindowKey(link: link, windowId: w.id), bounds: reads.windows[w.number]?.bounds, state: w.state, focused: w.focused, activeTabId: 1, focusedAt: w.focusedAt)
        }
    }
    func number(of key: WindowKey) -> Int? { win(key).map(\.number).flatMap { unbound.contains($0) ? nil : $0 } }
    func key(of number: Int) -> WindowKey? {
        guard !unbound.contains(number) else { return nil }
        for (link, list) in wins { if let w = list.first(where: { $0.number == number }) { return WindowKey(link: link, windowId: w.id) } }
        return nil
    }
    func activeSpaceId(of key: WindowKey) -> String? { win(key)?.space }
    func fillsDisplay(_ bounds: CGRect) -> Bool { bounds == display }
    func browserWindows(of link: String) -> [ServerWindow] {
        reads.windows.keys.sorted().compactMap { reads.window($0) } + dialogs
    }
    // The sidebar handed to the switch's target (Shell.handOverOverlay): whether this world can, and what was asked.
    var handsOver = false
    var handedOver: [(from: WindowKey, to: WindowKey, frozen: Bool)] = []
    func handOverOverlay(from a: WindowKey, to b: WindowKey) -> Bool {
        guard handsOver else { return false }
        handedOver.append((a, b, freezer.isLive))
        requests.append(Req(link: a.link, type: "overlay handed", payload: ["windowId": a.windowId, "to": b.windowId], at: clock.now(), frozen: freezer.isLive))
        return true
    }
    func orderOutOverlay(_ key: WindowKey) {
        outOverlays.append(key)
        requests.append(Req(link: key.link, type: "overlay out", payload: ["windowId": key.windowId], at: clock.now(), frozen: freezer.isLive))
    }
    func overlayOffScreen(_ key: WindowKey) -> Bool { outOverlays.contains(key) || !inFrontNow(key) }
    func overlayAbove(_ key: WindowKey) -> Bool {
        !blockedOverlays.contains(key) && framedOn && inFrontNow(key) && win(key).flatMap { reads.windows[$0.number]?.bounds }.map(fillsDisplay) == true
    }
    func showSwitchNotice(_ notice: SwitchNotice) { notices.append(notice) }
    func devHookAllows(_ a: String, _ b: String) -> Bool { devAllowed } // DEV-HOOK
}

let hA = "safari:A", hB = "safari:B", hC = "safari:C"
let hKA = WindowKey(link: hA, windowId: 10), hKB = WindowKey(link: hB, windowId: 20)

// A in full screen in front; B's window parked (its home window); C linked with no window.
func handoffSetup(_ build: (FakeHandoffWorld) -> Void = { _ in }) -> (FakeHandoffWorld, ProfileSwitch) {
    let w = FakeHandoffWorld()
    w.add(hA, id: 10, number: 1010, state: "fullscreen", space: "a1")
    w.focus(hKA)
    w.add(hB, id: 20, number: 2020, state: "normal", space: "b0")
    w.park(hKB)
    w.registry.noteShown(link: hA, number: 1010)
    w.linked.insert(hC)
    build(w)
    let s = ProfileSwitch(world: w, clock: w.clock)
    w.switcher = s
    return (w, s)
}

// Time passes in small steps (the fake clock's list of timers stays short).
func handoffRun(_ w: FakeHandoffWorld, _ seconds: Double) {
    var left = seconds
    while left > 1e-9 {
        let step = min(0.05, left)
        w.clock.advance(step)
        left -= step
    }
}

// Until `until` holds (true) or `max` seconds pass (false), in 4 ms steps.
@discardableResult
func handoffUntil(_ w: FakeHandoffWorld, max: Double = 15, _ until: () -> Bool) -> Bool {
    var t = 0.0
    while t < max {
        if until() { return true }
        w.clock.advance(0.004)
        t += 0.004
    }
    return until()
}

// HANDOFF.md §4.4's invariants, after a case has run out: the screen revealed, nothing busy, a window
// of A's or B's profile in front, every window that's in no user Space still in the registry, and the
// registry's hard rule never refused.
func handoffInvariants(_ label: String, _ w: FakeHandoffWorld, _ s: ProfileSwitch, _ links: [String] = [hA, hB]) {
    handoffRun(w, 12)
    check("\(label): invariant, the screen revealed", !w.freezer.isLive)
    check("\(label): invariant, the switch idle", !s.busy, "\(s.phase)")
    let front = links.flatMap { l in (w.wins[l] ?? []).map { WindowKey(link: l, windowId: $0.id) } }.filter(w.inFrontNow)
    check("\(label): invariant, a window of A's or B's in front", !front.isEmpty, "active \(w.reads.active ?? 0), \(w.wins)")
    let minimized = Set(w.wins.values.flatMap { $0 }.filter { $0.state == "minimized" }.map(\.number))
    let untracked = w.reads.windows.keys.filter { w.reads.spaces(of: $0)?.isEmpty == true && !minimized.contains($0) && !w.registry.isParked($0) }
    check("\(label): invariant, every hidden window in the registry", untracked.isEmpty, "\(untracked)")
    check("\(label): invariant, nothing stranded", w.strands.isEmpty, "\(w.strands)")
}

func handoffMachineTests() {
    let echo = Diagnostics.echo
    var said: [String] = []
    Diagnostics.echo = { said.append($0) }
    defer { Diagnostics.echo = echo }
    let toB = ProfileSwitch.Target(profile: hB, space: "b1")
    let toC = ProfileSwitch.Target(profile: hC, space: "c1")
    func failed(_ e: ProfileSwitch.Event?) -> Bool { if case .failed? = e { return true }; return false }

    // ---- §1.1: the two choices ----
    typealias F = HandoffChoice.Facts
    check("choice: the default is park+freeze", HandoffChoice.pick(F()) == HandoffChoice(freeze: true, old: .park))
    check("choice: no freeze: park, seen", HandoffChoice.pick(F(freezeOn: false)).description == "park")
    check("choice: the setting: close+freeze", HandoffChoice.pick(F(closeSetting: true)).description == "close+freeze")
    check("choice: parking off: close", HandoffChoice.pick(F(parkOn: false)).old == .close)
    check("choice: two displays: no freeze, the new A kept", { let c = HandoffChoice.pick(F(displays: 2)); return !c.freeze && c.old == .keep }())
    check("choice: two displays with the setting: close, no freeze", { let c = HandoffChoice.pick(F(closeSetting: true, displays: 2)); return !c.freeze && c.old == .close }())
    check("choice: A's copy gone: kept", HandoffChoice.pick(F(aLinked: false)).old == .keep)
    // (No "the person's own window: kept": every window is a Margin window's, parked like any, docs/BROWSER-WINDOWS.md §2.2.)
    check("choice: no A: the freeze, nothing left", { let c = HandoffChoice.pick(F(hasA: false)); return c.freeze && c.old == .keep }())

    // ---- park+freeze, a parked target: the whole switch ----
    do {
        let (w, s) = handoffSetup()
        var drawnAtFreeze = false
        w.onRequest = { r in if r.type == "setWindowState", r.link == hB { drawnAtFreeze = s.phase == .frozen } }
        s.start(toB, from: hA, windowId: 10)
        check("handoff: preparing, the cover up, nothing frozen", s.phase == .preparing && !w.freezer.isLive && s.isTarget(hKB) && s.leaving == hKA)
        handoffRun(w, 0.025)
        check("handoff: B's space set while it's hidden, A's drafts asked", w.types(hB, "setSpace").first?.payload["spaceId"] as? String == "b1"
              && w.types(hA, "windowDrafts").count == 1 && w.registry.isParked(2020), "\(w.requests.map(\.type))")
        handoffUntil(w, max: 0.5) { s.phase == .frozen }
        check("handoff: the freeze on the cover's word (before 250 ms)", w.freezer.calls == ["freeze 1.7 s: 0"] && w.clock.now() - 1000 < 0.25 + 0.2, "\(w.freezer.calls)")
        handoffUntil(w, max: 1) { w.types(hB, "setWindowState").count == 1 }
        let bAsk = w.types(hB, "setWindowState").first
        check("handoff: B shown, then full screen and focused, once, under the freeze, with its notAfter",
              drawnAtFreeze && bAsk?.state == "fullscreen" && bAsk?.payload["focused"] as? Bool == true && bAsk?.frozen == true
              && num(bAsk?.payload["notAfter"]).map { abs($0 - ((bAsk!.at - 0.016) + 1.5) * 1000) < 40 } == true && !w.registry.isParked(2020), "\(String(describing: bAsk?.payload))")
        handoffUntil(w, max: 2) { w.types(hA, "setWindowState").count == 1 }
        let out = w.requests.firstIndex { $0.type == "overlay out" && $0.link == hA }
        let aAsk = w.requests.firstIndex { $0.type == "setWindowState" && $0.link == hA }
        check("handoff: A's overlay ordered out before A's normal", out != nil && aAsk != nil && out! < aAsk!)
        check("handoff: A asked normal under the freeze, once B is in its Space", w.requests[aAsk!].frozen && w.requests[aAsk!].state == "normal" && w.fullAndInFront(hKB))
        handoffUntil(w, max: 2) { s.phase == .after }
        check("handoff: revealed once A is parked and settled", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"] && w.registry.isParked(1010), "\(w.freezer.calls)")
        handoffUntil(w, max: 3) { !s.busy }
        check("handoff: done, B in front in full screen, A parked", w.events == [.started(toB), .done(toB)] && w.fullAndInFront(hKB) && w.registry.isParked(1010), "\(w.events)")
        check("handoff: the home windows", w.registry.lastShown[hB] == 2020 && w.registry.lastShown[hA] == 1010)
        let line = s.session.lines.last ?? ""
        check("handoff: one line: modes, numbers and milliseconds", line.hasPrefix("handoff: safari:A#10 → safari:B#20 (park+freeze, parked target), frozen ") && line.contains("A parked") && line.contains("focus ok"), line)
        check("handoff: frozen less than the watchdog", w.freezer.reports.contains { if case .revealed(_, .ready, let ms) = $0 { return ms < 1700 }; return false })
        handoffInvariants("handoff", w, s)
    }
    // ---- the sidebar kept through the switch: A's handed to B under the freeze, before A's goes out ----
    do {
        let (w, s) = handoffSetup()
        w.handsOver = true
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 3) { !s.busy }
        let handed = w.requests.firstIndex { $0.type == "overlay handed" }
        let out = w.requests.firstIndex { $0.type == "overlay out" && $0.link == hA }
        check("handoff, same sidebar: A's handed to B once, under the freeze", w.handedOver.count == 1 && w.handedOver.first?.from == hKA && w.handedOver.first?.to == hKB
              && w.handedOver.first?.frozen == true, "\(w.handedOver)")
        check("handoff, same sidebar: handed before A's window's overlay goes out", handed != nil && out != nil && handed! < out!)
        check("handoff, same sidebar: the switch done as before", w.events == [.started(toB), .done(toB)] && w.fullAndInFront(hKB) && w.registry.isParked(1010))
        handoffInvariants("handoff, same sidebar", w, s)
    }
    do {
        let (w, s) = handoffSetup { $0.noFreezer = true }
        w.handsOver = true
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("handoff, same sidebar: not without a freeze (the hand-over would be seen)", w.handedOver.isEmpty && w.events.last == .done(toB))
    }
    // ---- park without a freeze: the same steps, seen ----
    do {
        let (w, s) = handoffSetup { $0.noFreezer = true }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("park, no freeze: done, A parked, B in front, nothing frozen", w.events.last == .done(toB) && w.registry.isParked(1010) && w.fullAndInFront(hKB) && w.freezer.calls.isEmpty)
        handoffInvariants("park, no freeze", w, s)
    }
    // ---- close+freeze (§4.5): B under the first freeze with A untouched, A closed under a second ----
    do {
        let (w, s) = handoffSetup { $0.closeWindows = true }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 3) { w.freezer.calls.count >= 2 }
        let revealed = w.clock.now()
        check("close+freeze: B revealed with A untouched in its full-screen Space", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"]
              && w.types(hA, "setWindowState").isEmpty && w.types(hA, "closeWindow").isEmpty && w.win(hKA)?.state == "fullscreen" && w.fullAndInFront(hKB), "\(w.freezer.calls)")
        handoffUntil(w, max: 2) { w.freezer.isLive }
        let frozen2 = w.clock.now()
        check("close+freeze: a second freeze with its 1.0 s watchdog, at least 300 ms after the reveal",
              w.freezer.calls.last == "freeze 1.0 s: 0" && frozen2 - revealed >= 0.3 - 1e-6 && frozen2 - revealed < 0.4, "\(frozen2 - revealed) \(w.freezer.calls)")
        let close = w.types(hA, "closeWindow").first
        check("close+freeze: A's close sent under it, refused past 600 ms into it",
              close?.frozen == true && num(close?.payload["notAfter"]).map { abs($0 - (close!.at + 0.6) * 1000) < 5 } == true, "\(String(describing: close?.payload))")
        handoffUntil(w, max: 1) { w.win(hKA) == nil }
        let gone = w.clock.now()
        handoffUntil(w, max: 1.5) { !w.freezer.isLive }
        let held = w.clock.now() - gone
        check("close+freeze: revealed once A is gone with B in front for 120 ms", w.freezer.calls.last == "reveal 2 ready: 0" && held >= 0.12 - 0.005 && held < 0.15
              && w.fullAndInFront(hKB), "\(held) \(w.freezer.calls)")
        handoffRun(w, 3)
        check("close+freeze: done, A gone, nothing parked of A's", w.events.last == .done(toB) && w.win(hKA) == nil && !w.registry.isParked(1010) && w.fullAndInFront(hKB))
        let line = s.session.lines.last ?? ""
        check("close+freeze: its line says A closed and the second freeze's time", line.contains("(close+freeze, parked target)") && line.contains("A closed") && line.contains("close frozen 1"), line)
        handoffInvariants("close+freeze", w, s)
    }
    do {
        // macOS drops to the Desktop as A's Space goes: B focused once, inside the second freeze.
        let (w, s) = handoffSetup { $0.closeWindows = true; $0.dropOnClose = true }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        let focus = w.types(hB, "focusWindow")
        check("close+freeze, a Desktop drop: B focused once, inside the second freeze", focus.count == 1 && focus[0].frozen && focus[0].payload["fullscreen"] as? Bool == true, "\(focus.map(\.payload))")
        check("close+freeze, a Desktop drop: revealed on B, not by the watchdog", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0", "freeze 1.0 s: 0", "reveal 2 ready: 0"]
              && w.events.last == .done(toB) && w.fullAndInFront(hKB) && (s.session.lines.last ?? "").contains("Desktop drop, B focused"), "\(w.freezer.calls) \(s.session.lines.last ?? "")")
        handoffInvariants("close+freeze, a Desktop drop", w, s)
    }
    do {
        // The drop still there at the second freeze's watchdog: today's checking path, seen.
        let (w, s) = handoffSetup { $0.closeWindows = true; $0.dropOnClose = true; $0.ignoreFocus = 1 }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 5) { s.phase == .checking }
        check("close+freeze, the drop left: revealed by the watchdog at 1.0 s, then checking, seen",
              s.phase == .checking && w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0", "freeze 1.0 s: 0", "reveal 2 watchdog: 0"] && w.types(hB, "focusWindow").count == 1, "\(w.freezer.calls)")
        handoffRun(w, 4)
        let focus = w.types(hB, "focusWindow")
        check("close+freeze, the drop left: B focused again, unfrozen, and done", focus.count == 2 && !focus[1].frozen && w.events.last == .done(toB) && w.fullAndInFront(hKB)
              && (s.session.lines.last ?? "").contains("close frozen 1000 ms (watchdog)"), "\(w.events) \(s.session.lines.last ?? "")")
        handoffInvariants("close+freeze, checking", w, s)
    }
    do {
        // Never back in front: two more focuses, then the person is told, as today's switch does.
        let (w, s) = handoffSetup { $0.closeWindows = true; $0.dropOnClose = true; $0.ignoreFocus = 9 }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 10)
        check("close+freeze, never in front: B focused three times in all, then failed with today's words, landed on B",
              w.types(hB, "focusWindow").count == 3 && w.events.last == .failed(toB, "macOS didn’t show its window: click it in Mission Control") && !s.busy && !w.freezer.isLive
              && w.win(hKA) == nil, "\(w.events) \(s.history.suffix(3))")
    }
    do {
        // Close mode with no freeze and a parked target: the same steps, seen.
        let (w, s) = handoffSetup { $0.closeWindows = true; $0.noFreezer = true }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("close, no freeze, a parked target: the handoff's close, unfrozen", s.history.contains { $0.hasPrefix("safari:A#10 → safari:B/b1 (close)") } && w.freezer.calls.isEmpty
              && w.types(hA, "closeWindow").count == 1 && w.types(hA, "closeWindow").first?.frozen == false && w.win(hKA) == nil && w.events.last == .done(toB), "\(s.history.prefix(3))")
        handoffInvariants("close, no freeze, parked", w, s)
    }
    // ---- close without a freeze and no parked target: today's switch, with the drafts check ----
    do {
        let (w, s) = handoffSetup { $0.noFreezer = true; $0.closeWindows = true }
        s.start(toC, from: hA, windowId: 10)
        check("close, no freeze: today's switch (creating), the drafts asked", s.phase == .creating && s.run == nil && w.types(hA, "windowDrafts").count == 1)
        handoffRun(w, 5)
        check("close, no freeze: done, A closed", w.events.last == .done(toC) && w.win(hKA) == nil && w.freezer.calls.isEmpty, "\(w.events) \(s.history.suffix(3))")
        handoffInvariants("close, no freeze", w, s, [hA, hC])
    }
    do {
        let (w, s) = handoffSetup { $0.noFreezer = true; $0.closeWindows = true; $0.drafts[hKA] = ["drafts": [3], "unknown": []] }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("close, no freeze, a draft: A kept, told after the switch's end", w.events.last == .done(toC) && w.win(hKA) != nil && w.types(hA, "closeWindow").isEmpty
              && w.notices == [SwitchNotice(.windowKeptDraft, profile: hA, shownIn: WindowKey(link: hC, windowId: 50), kept: hKA)], "\(w.notices)")
        handoffInvariants("close, no freeze, a draft", w, s, [hA, hC])
    }
    do {
        // A world with no Space reads: today's switch, whatever the setting.
        let (w, s) = handoffSetup { $0.noReads = true }
        s.start(toC, from: hA, windowId: 10)
        check("no Space reads: the close-based switch", s.phase == .creating && s.run == nil)
        handoffRun(w, 5)
        check("no Space reads: done as today", w.events.last == .done(toC) && w.win(hKA) == nil)
        handoffInvariants("no Space reads", w, s, [hA, hC])
    }
    do {
        // The shell's gate off (Options.handoff, until G1): a plain SwitchWorld, today's switch exactly,
        // with no drafts asked and no freeze, though the reads, the parker and the freezer are there.
        let (w, s) = handoffSetup { $0.gateOff = true }
        s.start(toC, from: hA, windowId: 10)
        check("gate off: the close-based switch", s.phase == .creating && s.run == nil && s.handoffWorld == nil)
        handoffRun(w, 5)
        check("gate off: done as before, with no drafts asked and nothing frozen", w.events.last == .done(toC) && w.win(hKA) == nil
              && w.types(hA, "windowDrafts").isEmpty && w.freezer.calls.isEmpty && w.types(nil, "setWindowState").isEmpty, "\(w.requests.map(\.type))")
        handoffInvariants("gate off", w, s, [hA, hC])
    }
    // ---- keep: two displays; and the next switch on one display freezes again ----
    do {
        let (w, s) = handoffSetup { $0.displays = 2 }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("two displays: no freeze, A kept in its full-screen Space, B shown in front", w.events.last == .done(toB) && w.freezer.calls.isEmpty
              && w.win(hKA)?.state == "fullscreen" && !w.registry.isParked(1010) && w.fullAndInFront(hKB) && w.outOverlays.contains(hKA) && w.types(hA, "setWindowState").isEmpty)
        handoffInvariants("two displays", w, s)
        w.displays = 1
        s.start(.init(profile: hA, space: "a1"), from: hB, windowId: 20)
        handoffRun(w, 4)
        check("back to one display: the next switch freezes and parks (no lasting demotion)", w.events.last == .done(.init(profile: hA, space: "a1")) && w.freezer.calls.first == "freeze 1.7 s: 0"
              && w.registry.isParked(2020) && w.fullAndInFront(hKA) && w.types(hA, "setWindowState").last?.payload["focused"] as? Bool == true, "\(w.freezer.calls)")
        handoffInvariants("back to one display", w, s)
    }
    // ---- Chrome's and Edge's profiles: never a handoff (parking reads Safari's windows); the close-based switch ----
    do {
        let (w, s) = handoffSetup()
        let runs = s.session.runs
        s.start(.init(profile: "chrome:B", space: "b0"), from: "chrome:A", windowId: 10)
        handoffRun(w, 4)
        check("Chrome: no handoff, no freeze, nothing parked", s.session.runs == runs && w.freezer.calls.isEmpty && !w.registry.isParked(1010)
              && w.types(nil, "setWindowState").isEmpty, "\(w.freezer.calls) \(w.requests.map(\.type))")
        let (w2, s2) = handoffSetup()
        let runs2 = s2.session.runs
        s2.start(.init(profile: "edge:B", space: "b0"), from: "", windowId: nil)
        handoffRun(w2, 4)
        check("Edge, no window to leave: no handoff either", s2.session.runs == runs2 && w2.freezer.calls.isEmpty, "\(w2.freezer.calls)")
    }
    // ---- session demotions ----
    do {
        // Two failed freezes in a row turn it off; each switch still parks, seen.
        let (w, s) = handoffSetup { $0.freezer.freezeResults = [7, 7] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("demotion: a failed freeze: this switch without one, still parked", w.events.last == .done(toB) && w.registry.isParked(1010) && s.session.rules.on)
        s.start(.init(profile: hA, space: "a1"), from: hB, windowId: 20)
        handoffRun(w, 4)
        check("demotion: two in a row: the freeze off for the session", !s.session.rules.on && w.registry.isParked(2020) && w.freezer.calls == ["freeze 1.7 s: 7", "freeze 1.7 s: 7"], "\(w.freezer.calls)")
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("demotion: then no freeze asked at all", w.freezer.calls.count == 2 && w.events.last == .done(toB))
        handoffInvariants("demotion, freeze", w, s)
    }
    do {
        // A failed reveal: released, and the freeze off.
        let (w, s) = handoffSetup { $0.freezer.revealResults = [3] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("demotion: a failed reveal released, the freeze off", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 3", "release 1: 0"] && !s.session.rules.on && w.events.last == .done(toB))
        handoffInvariants("demotion, reveal", w, s)
    }
    do {
        // A's park didn't land: parking off for the session, A closed (no drafts), the next switch closes.
        let (w, s) = handoffSetup()
        w.onRequest = { r in if r.link == hA, r.type == "setWindowState", r.state == "normal" { w.reads.dropNext = 2 } }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("demotion: A's park didn't land: parking off, A closed, B in front", s.session.parkOff?.contains("1010's park didn't land") == true
              && w.win(hKA) == nil && !w.registry.isParked(1010) && w.events.last == .done(toB) && w.fullAndInFront(hKB), "\(String(describing: s.session.parkOff)) \(s.history.suffix(4))")
        handoffInvariants("demotion, park", w, s)
    }
    do {
        // A's park didn't land, with a draft in A: kept on its Desktop, and told.
        let (w, s) = handoffSetup { $0.drafts[hKA] = ["drafts": [], "unknown": [4]] }
        w.onRequest = { r in if r.link == hA, r.type == "setWindowState", r.state == "normal" { w.reads.dropNext = 2 } }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("demotion: A's park didn't land, a draft: kept as a normal window, told", w.win(hKA)?.state == "normal" && w.types(hA, "closeWindow").isEmpty
              && w.notices.first?.kind == .windowKeptDraft && w.notices.first?.kept == hKA && w.notices.first?.shownIn == hKB && w.events.last == .done(toB), "\(w.notices)")
        handoffInvariants("demotion, park, a draft", w, s)
    }
    do {
        // B's show didn't land: parking off; B closed by its copy (no drafts) and the switch goes on as a create.
        let (w, s) = handoffSetup()
        w.onRequest = { r in if r.link == hB, r.type == "setSpace" { w.reads.dropNext = 4 } }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("demotion: B's show didn't land: parking off, B closed, a new window made", s.session.parkOff?.contains("2020's show didn't land") == true
              && w.types(hB, "closeWindow").count == 1 && w.types(hB, "openSpaceWindow").count == 1 && w.win(hKB) == nil, "\(s.history.suffix(6))")
        check("demotion: … A closed rather than parked (parking off), the new window in front", w.events.last == .done(toB) && w.win(hKA) == nil
              && w.fullAndInFront(WindowKey(link: hB, windowId: 50)), "\(w.events) \(s.history.suffix(4))")
        handoffInvariants("demotion, show", w, s)
    }
    // ---- drafts before a close ----
    do {
        let (w, s) = handoffSetup { $0.closeWindows = true; $0.drafts[hKA] = ["drafts": [7], "unknown": []] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("drafts: close mode with a draft: A kept in its Space, told in B's overlay with its window", w.win(hKA)?.state == "fullscreen" && w.types(hA, "closeWindow").isEmpty
              && w.notices == [SwitchNotice(.windowKeptDraft, profile: hA, shownIn: hKB, kept: hKA)] && w.events.last == .done(toB))
        check("drafts: … and no second freeze for it", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"], "\(w.freezer.calls)")
        handoffInvariants("drafts", w, s)
    }
    do {
        let (w, s) = handoffSetup { $0.closeWindows = true; $0.silentDrafts = true }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("drafts: no answer: kept too", w.win(hKA) != nil && w.types(hA, "closeWindow").isEmpty && w.notices.first?.kind == .windowKeptDraft)
        handoffInvariants("drafts, no answer", w, s)
    }
    // ---- deadlines ----
    do {
        // A create never answered: given up at 8 s, A untouched; its late window closed.
        let (w, s) = handoffSetup { $0.noCreateAnswer = true }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 7.5)
        check("deadline: the create's answer waited for", s.busy && w.types(hC, "openSpaceWindow").count == 1 && w.freezer.calls.last == "reveal 1 watchdog: 0")
        handoffRun(w, 1)
        check("deadline: no answer in 8 s: failed, A untouched and in front", failed(w.events.last) && w.types(hA, "setWindowState").allSatisfy { $0.state == "fullscreen" }
              && w.fullAndInFront(hKA), "\(w.events) \(s.history.suffix(3))")
        handoffInvariants("deadline, create", w, s, [hA, hC])
    }
    do {
        // B never in full screen: the watchdog at 1.7 s, recovery at the settle timeout; B parked again.
        let (w, s) = handoffSetup { $0.noFullScreen = [hKB] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 2)
        check("deadline: B not ready: the watchdog revealed, still going", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 watchdog: 0"] && s.phase == .frozen && s.run?.lateAt != nil)
        handoffRun(w, 4.5)
        check("deadline: B never full screen: recovered, A back in front, B set normal", failed(w.events.last) && w.fullAndInFront(hKA)
              && w.types(hB, "setWindowState").last?.state == "normal" && w.types(hA, "setWindowState").isEmpty == false, "\(w.events) \(s.history.suffix(4))")
        handoffRun(w, 1)
        check("deadline: … and B parked again once normal", w.registry.isParked(2020))
        handoffInvariants("deadline, settle", w, s)
    }
    do {
        // Its copy not linked, with a parked window: waitingForLink (not "isn't open"), 3 s, then that
        // window back on its Desktop and the person told.
        let (w, s) = handoffSetup { $0.linked.remove(hB) }
        s.start(toB, from: hA, windowId: 10)
        check("waitingForLink: a parked window, its copy away: waiting, the cover up, no needsProfile", s.phase == .waitingForLink && w.events == [.started(toB)])
        handoffRun(w, 3.1)
        check("waitingForLink: 3 s: B returned to the Desktop by number, told", !s.busy && !w.registry.isParked(2020) && w.reads.spaces(of: 2020) == [w.desktop]
              && w.notices == [SwitchNotice(.windowOnDesktop, profile: hB, shownIn: hKA)] && w.events.last == .cancelled(toB) && w.fullAndInFront(hKA), "\(w.notices) \(w.events)")
        handoffInvariants("waitingForLink", w, s)
    }
    do {
        let (w, s) = handoffSetup { $0.linked.remove(hB) }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 1)
        w.linked.insert(hB)
        handoffRun(w, 4)
        check("waitingForLink: the copy back in time: on, done", w.events.last == .done(toB) && w.registry.isParked(1010) && w.fullAndInFront(hKB), "\(w.events)")
        handoffInvariants("waitingForLink, back", w, s)
    }
    do {
        // Margin turned off in that profile, no parked window: failed at once and said, no window asked of Safari.
        let (w, s) = handoffSetup { $0.linked.remove(hC); $0.off = [hC]; $0.opensWindows = true }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 0.2)
        check("Margin off in the target's profile: failed at once, no window opened, A still in front",
              !s.busy && failed(w.events.last) && w.openedWindowFor.isEmpty && w.fullAndInFront(hKA), "\(w.events)")
        handoffInvariants("Margin off", w, s, [hA])
    }
    do {
        // No parked window and no copy, and Safari can't be asked for one: the freeze that would have hidden its
        // window's slide revealed at once, then needsProfile, as today; 90 s.
        let (w, s) = handoffSetup { $0.linked.remove(hC) }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 0.5)
        check("waitingForProfile: no parked window: the person asked to open one", s.phase == .waitingForProfile && w.events == [.started(toC), .needsProfile(toC)], "\(s.phase) \(w.events)")
        check("waitingForProfile: and the freeze revealed at once", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 failed: 0"] && !w.freezer.isLive, "\(w.freezer.calls)")
        handoffRun(w, 91)
        check("waitingForProfile: given up after 90 s, nothing done", !s.busy && failed(w.events.last) && w.fullAndInFront(hKA))
        handoffInvariants("waitingForProfile", w, s, [hA])
    }
    do {
        // The person opens one of its windows meanwhile: the switch goes on to it.
        let (w, s) = handoffSetup { $0.linked.remove(hC) }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 2)
        let kc = w.add(hC, id: 30, number: 3030, state: "normal")
        handoffRun(w, 4)
        check("waitingForProfile: its window opened: shown full screen, A parked", w.events.last == .done(toC) && w.fullAndInFront(kc) && w.registry.isParked(1010), "\(w.events) \(s.history.suffix(3))")
        handoffInvariants("waitingForProfile, opened", w, s, [hA, hC])
    }
    do {
        // With Accessibility: Margin asks Safari for the profile's window itself, the person isn't told to open one,
        // and the switch goes on when its copy links with that window (reported 2026-11-07: "Test A isn't open").
        // Asked under the freeze, after the cover: a window opened beside a full-screen one is put in full screen
        // by macOS, which slides to it, and that slide was seen (2026-11-09).
        let (w, s) = handoffSetup { $0.linked.remove(hC); $0.opensWindows = true }
        s.start(toC, from: hA, windowId: 10)
        check("profile window: nothing asked before the freeze", s.phase == .preparing && w.openedWindowFor.isEmpty && w.events == [.started(toC)], "\(s.phase) \(w.events) \(w.openedWindowFor)")
        handoffRun(w, 0.5)
        check("profile window: Safari asked for it under the freeze, no needsProfile", s.phase == .frozen && w.openedWindowFor == [hC] && w.openedFrozen == [true] && w.events == [.started(toC)], "\(s.phase) \(w.events) \(w.openedFrozen)")
        handoffRun(w, 0.3)
        check("and asked once, not on every poll", w.openedWindowFor == [hC], "\(w.openedWindowFor)")
        let kc = w.add(hC, id: 30, number: 3030, state: "fullscreen")
        handoffRun(w, 4)
        check("its window opened by Safari: shown, A parked", w.events.last == .done(toC) && w.fullAndInFront(kc) && w.registry.isParked(1010), "\(w.events) \(s.history.suffix(3))")
        check("profile window: one freeze, revealed when ready, not at the watchdog", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"], "\(w.freezer.calls)")
        handoffInvariants("waitingForProfile, opened by Margin", w, s, [hA, hC])
    }
    do {
        // Margin opened the profile's window, but its copy never links (Margin off in that profile): revealed at the
        // watchdog, given up after 10 s, not 90, with A back in front (the shell tells the person why and closes that window).
        let (w, s) = handoffSetup { $0.linked.remove(hC); $0.opensWindows = true }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 2)
        check("Margin's own window asked for: revealed at the watchdog, then waited for unfrozen, the keys the person's",
              s.phase == .waitingForProfile && !s.keysMidSwitch && w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 watchdog: 0"], "\(s.phase) \(w.freezer.calls)")
        handoffRun(w, 7)
        check("Margin's own window asked for: still waiting at 9 s", s.phase == .waitingForProfile, "\(s.phase)")
        handoffRun(w, 2)
        check("given up at 10 s, A in front", !s.busy && failed(w.events.last) && w.fullAndInFront(hKA), "\(w.events)")
        handoffInvariants("waitingForProfile, Margin off there", w, s, [hA])
    }
    do {
        // Its copy slower than the freeze: revealed at the watchdog, waited for unfrozen, and once it links the
        // switch freezes again for its window (after the cooldown) and goes on to it.
        let (w, s) = handoffSetup { $0.linked.remove(hC); $0.opensWindows = true }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 3)
        check("profile window, slow copy: waiting unfrozen after the watchdog", s.phase == .waitingForProfile && w.openedWindowFor == [hC], "\(s.phase)")
        let kc = w.add(hC, id: 30, number: 3030, state: "fullscreen")
        handoffRun(w, 4)
        check("profile window, slow copy: frozen again for it, shown, A parked", w.events.last == .done(toC) && w.fullAndInFront(kc) && w.registry.isParked(1010)
              && w.freezer.calls.first == "freeze 1.7 s: 0" && w.freezer.calls.filter { $0.hasPrefix("freeze") }.count == 2 && w.openedWindowFor == [hC], "\(w.freezer.calls) \(w.events)")
        handoffInvariants("waitingForProfile, slow copy", w, s, [hA, hC])
    }
    do {
        // With no freeze to hide it, Safari is asked at once, as before.
        let (w, s) = handoffSetup { $0.linked.remove(hC); $0.opensWindows = true; $0.noFreezer = true }
        s.start(toC, from: hA, windowId: 10)
        check("profile window, no freeze: asked at once", s.phase == .waitingForProfile && w.openedWindowFor == [hC] && w.events == [.started(toC)], "\(s.phase) \(w.openedWindowFor)")
        let kc = w.add(hC, id: 30, number: 3030, state: "fullscreen")
        handoffRun(w, 4)
        check("profile window, no freeze: shown, A parked", w.events.last == .done(toC) && w.fullAndInFront(kc) && w.registry.isParked(1010), "\(w.events)")
        handoffInvariants("waitingForProfile, no freeze", w, s, [hA, hC])
    }
    // ---- the watchdog's three states, and step 5's latest start ----
    do {
        // B ready, A settling: revealed by the watchdog; the steps go on, A parked.
        let (w, s) = handoffSetup { $0.slowExit[hKA] = 0.8 }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 1.75)
        check("watchdog: B ready, A leaving: revealed at 1.7 s", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 watchdog: 0"] && s.run?.lateAt != nil && s.run?.r2At != nil && s.run?.aAskedAt != nil)
        handoffRun(w, 3)
        check("watchdog: … then A parked unfrozen, done", w.events.last == .done(toB) && w.registry.isParked(1010) && s.session.lines.last?.contains("late (watchdog at 1700 ms, waiting for ") == true, "\(s.session.lines)")
        handoffInvariants("watchdog, settling", w, s)
    }
    do {
        // B steady after 1.15 s: A not touched under the freeze; revealed, then A's exit and park.
        let (w, s) = handoffSetup { $0.enterLag[hB] = 1.2 }
        var aAskedFrozen: Bool?
        w.onRequest = { r in if r.link == hA, r.type == "setWindowState" { aAskedFrozen = r.frozen } }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("latest start: B steady past 1.15 s: A asked only after the reveal", aAskedFrozen == false && w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"]
              && w.registry.isParked(1010) && w.events.last == .done(toB), "\(String(describing: aAskedFrozen)) \(w.freezer.calls)")
        handoffInvariants("latest start", w, s)
    }
    do {
        // B not ready at 1.7 s: revealed, and the rest seen.
        let (w, s) = handoffSetup { $0.enterLag[hB] = 2.4 }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("watchdog: B not ready: revealed at 1.7 s, then done seen", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 watchdog: 0"] && w.events.last == .done(toB) && w.registry.isParked(1010))
        // The cooldown: the next freeze at least 1 s after a watchdog reveal.
        s.start(.init(profile: hA, space: "a1"), from: hB, windowId: 20)
        handoffUntil(w, max: 3) { w.freezer.isLive }
        let gap = (w.clock.now() - (s.session.rules.lastWatchdogAt ?? 0))
        check("cooldown: after a watchdog reveal, the next freeze waits a second", gap >= 1 - 1e-6, "\(gap)")
        handoffInvariants("watchdog, B late", w, s)
    }
    // ---- §1.2: a foreign Space change aborts ----
    do {
        let (w, s) = handoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 1) { !w.types(hB, "setWindowState").isEmpty }
        handoffRun(w, 0.2)
        w.setActive(w.desktop) // a trackpad swipe to the Desktop under the freeze
        handoffRun(w, 0.15)
        check("abort: another Space active for 100 ms: revealed at once, recovering", w.freezer.calls.last == "reveal 1 aborted: 0" && s.phase != .frozen && s.phase != .after
              && s.history.contains { $0.contains("aborted: the active Space moved to 1") }, "\(w.freezer.calls) \(s.history.suffix(3))")
        handoffRun(w, 4)
        check("abort: A back in front, B parked again once normal", failed(w.events.last) && w.fullAndInFront(hKA) && w.registry.isParked(2020), "\(w.events)")
        handoffInvariants("abort", w, s)
    }
    // ---- §1.7: one switch at a time ----
    do {
        // Before the freeze a new target takes its place.
        let (w, s) = handoffSetup { $0.coverOn = false }
        s.start(toB, from: hA, windowId: 10)
        s.start(toC, from: hA, windowId: 10)
        check("queue: before the freeze, the new target in its place", s.target == toC && s.phase == .preparing && w.freezer.calls.isEmpty)
        handoffRun(w, 4)
        check("queue: … and only it runs", w.events.last == .done(toC) && w.registry.isParked(2020) && w.types(hB, "setWindowState").isEmpty, "\(w.events)")
        handoffInvariants("queue, replaced", w, s, [hA, hC])
    }
    do {
        // Back to A's own profile before the freeze: ended, its space set in A.
        let (w, s) = handoffSetup { $0.coverOn = false }
        s.start(toB, from: hA, windowId: 10)
        s.start(.init(profile: hA, space: "a2"), from: hA, windowId: 10)
        check("queue: back to A's profile before the freeze: nothing done, its space set", !s.busy && w.events.last == .cancelled(toB) && w.freezer.calls.isEmpty)
        handoffRun(w, 0.1)
        check("queue: … setSpace in A", w.types(hA, "setSpace").last?.payload["spaceId"] as? String == "a2")
    }
    do {
        // From the freeze on, it waits; it starts only once this one is idle, from where it landed.
        let (w, s) = handoffSetup { $0.enterLag[hB] = 1.2 } // A's park after the reveal
        var parkedAtNext: Bool?
        w.onEvent = { e in if e == .started(toC) { parkedAtNext = w.registry.isParked(1010) && !s.busy } }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 1) { s.phase == .frozen }
        s.start(toC, from: hA, windowId: 10)
        check("queue: asked under the freeze: queued", s.queued == toC && s.target == toB)
        handoffRun(w, 8)
        check("queue: the next started only once idle, A's late park done", parkedAtNext == true && w.events.contains(.done(toB)) && w.events.last == .done(toC), "\(String(describing: parkedAtNext)) \(w.events)")
        check("queue: … from B's window: B parked, C in front", w.registry.isParked(2020) && w.registry.isParked(1010))
        handoffInvariants("queue, landed", w, s, [hB, hC])
    }
    do {
        // Queued after a watchdog reveal with A's late park still to do.
        let (w, s) = handoffSetup { $0.enterLag[hB] = 2.4 }
        var parkedAtNext: Bool?
        w.onEvent = { e in if e == .started(toC) { parkedAtNext = w.registry.isParked(1010) } }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 1)
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 10)
        check("queue: after a watchdog reveal, the next waits for A's late park and the landing", parkedAtNext == true && w.events.last == .done(toC), "\(String(describing: parkedAtNext)) \(w.events)")
        handoffInvariants("queue, after the watchdog", w, s, [hB, hC])
    }
    // ---- §1.7: a window with a windows call still pending ----
    do {
        let (w, s) = handoffSetup { $0.hung = [hKA] }
        s.windowCall(w, hKA, .focusWindow(windowId: 10)) { _, _ in }
        handoffRun(w, 0.1)
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 0.5)
        check("pending: A with a call pending: the switch waits", s.phase == .preparing && w.freezer.calls.isEmpty)
        handoffRun(w, 0.7)
        check("pending: … 1 s, then refused: Safari is busy in this window", !s.busy && w.events.last == .cancelled(toB) && w.notices == [SwitchNotice(.windowBusy, profile: hA, shownIn: hKA)]
              && w.registry.isParked(2020), "\(w.notices) \(w.events)")
        w.unhang(hKA)
        handoffInvariants("pending A", w, s)
    }
    do {
        // B's window has a call pending; another parked window of B's is taken instead.
        let kb2 = WindowKey(link: hB, windowId: 21)
        let (w, s) = handoffSetup { w in
            w.add(hB, id: 21, number: 2121, state: "normal")
            w.park(kb2, home: false)
            w.hung = [hKB]
        }
        s.windowCall(w, hKB, .focusWindow(windowId: 20)) { _, _ in }
        handoffRun(w, 0.1)
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("pending: B busy: another parked window of its profile after 1 s", w.events.last == .done(toB) && w.fullAndInFront(kb2) && w.registry.isParked(2020) && w.registry.isParked(1010), "\(w.events) \(s.history.suffix(4))")
        w.unhang(hKB)
        handoffInvariants("pending B", w, s)
    }
    // ---- §1.9: the aftercare ----
    do {
        // A late landing: B's full-screen call hung behind a tab, the switch gave up; it lands later
        // with nothing done since: B adopted, A parked in the background, the person told.
        let (w, s) = handoffSetup { $0.hung = [hKB] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 7)
        check("late landing: the switch gave up, A back in front", failed(w.events.last) && w.fullAndInFront(hKA) && !s.session.watches.isEmpty, "\(w.events)")
        handoffRun(w, 0.5)
        w.unhang(hKB)
        handoffRun(w, 1.5)
        check("late landing: B in front, told, the home window B's", w.fullAndInFront(hKB) && w.notices.last == SwitchNotice(.lateLanding, profile: hB, shownIn: hKB) && w.registry.lastShown[hB] == 2020, "\(w.notices) \(s.history.suffix(4))")
        handoffRun(w, 2)
        check("late landing: … the window shown before set normal and parked", w.registry.isParked(1010) && !w.registry.isParked(2020))
        handoffInvariants("late landing", w, s)
    }
    do {
        // The same, but the person did something since: B set normal and parked again.
        let (w, s) = handoffSetup { $0.hung = [hKB] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 7.5)
        s.personActed()
        w.unhang(hKB)
        handoffRun(w, 4)
        check("late landing, the person acted: no landing, A stays in front", w.fullAndInFront(hKA) && !w.notices.contains { $0.kind == .lateLanding } && !w.registry.isParked(1010), "\(s.history.suffix(4))")
        let sweep = { _ = w.registry.sweep(SweepRead(pids: [w.pid], ext: w.copyWindows(hA) + w.copyWindows(hB), reporting: [hA, hB], moving: s.movingNumbers)) }
        for _ in 0..<20 { sweep(); handoffRun(w, 0.1) }
        check("late landing, the person acted: … B back in its private Space (a system return)", w.registry.isParked(2020) && w.reads.spaces(of: 2020) == [], "\(String(describing: w.reads.spaces(of: 2020)))")
        handoffInvariants("late landing, acted", w, s)
    }
    do {
        // A late normal: A's exit took longer than the switch; parked once it's normal.
        let (w, s) = handoffSetup { $0.slowExit[hKA] = 8 }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 8.2)
        check("late normal: the switch landed on B with A still in full screen", w.events.last == .done(toB) && w.win(hKA)?.state == "fullscreen" && !w.registry.isParked(1010), "\(w.events) \(s.history.suffix(3))")
        handoffRun(w, 2)
        check("late normal: … parked by the aftercare as it lands", w.registry.isParked(1010) && w.fullAndInFront(hKB))
        handoffInvariants("late normal", w, s)
    }
    do {
        // A parked window back by itself with no focus on it: the registry parks it again; no handoff.
        let (w, s) = handoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        w.reads.comeBack(1010, to: w.reads.active!)
        let eventsBefore = w.events.count
        let found = w.registry.sweep(SweepRead(pids: [w.pid], ext: w.copyWindows(hA) + w.copyWindows(hB), reporting: [hA, hB], moving: s.movingNumbers))
        handoffRun(w, 0.5)
        check("system return: parked again quietly, no handoff", found.contains { if case .system(1010, _, _, .parkAgain) = $0 { return true }; return false }
              && w.registry.isParked(1010) && !s.busy && w.events.count == eventsBefore, "\(found)")
        handoffInvariants("system return", w, s)
    }
    // ---- §4.4: recovery ----
    do {
        // B's copy gone before A was touched: revealed at once; B still floating normal parked again.
        let (w, s) = handoffSetup { $0.noFullScreen = [hKB] } // its request never carried out
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 1) { !w.types(hB, "setWindowState").isEmpty }
        handoffRun(w, 0.1)
        w.linked.remove(hB)
        handoffRun(w, 0.05)
        check("recovery, B's copy gone: revealed at once", w.freezer.calls.last == "reveal 1 closed: 0" && s.phase != .frozen)
        handoffRun(w, 3)
        check("recovery, B's copy gone: A untouched and in front, B parked again by number", failed(w.events.last) && w.fullAndInFront(hKA) && w.registry.isParked(2020)
              && w.types(hA, "setWindowState").allSatisfy { $0.state == "fullscreen" }, "\(w.events) \(s.history.suffix(4)) front \(w.fullAndInFront(hKA)) parked \(w.registry.isParked(2020)) \(w.registry.entries[2020].map { "\($0.phase)" } ?? "-") active \(w.reads.active ?? 0) A \(w.spacesOf(hKA)) \(w.win(hKA).map(\.state) ?? "-")")
        handoffInvariants("recovery, B's copy", w, s)
    }
    do {
        // B closed by the person after A went normal, before A was parked: A back full screen.
        let (w, s) = handoffSetup { $0.slowExit[hKA] = 0.4 }
        w.onRequest = { r in if r.link == hA, r.type == "setWindowState", r.state == "normal" { _ = w.clock.after(0.1) { w.close(hKB) } } }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("recovery, after A's normal: A back full screen and focused, cancelled", w.events.last == .cancelled(toB) && w.fullAndInFront(hKA) && !w.registry.isParked(1010)
              && w.types(hA, "setWindowState").last?.state == "fullscreen", "\(w.events) \(w.types(hA).map { $0.state ?? $0.type })")
        handoffInvariants("recovery, A normal", w, s, [hA])
    }
    do {
        // B closed after A was parked: A shown again, then full screen.
        let (w, s) = handoffSetup { $0.framedOn = false }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 3) { w.registry.isParked(1010) }
        w.close(hKB)
        handoffRun(w, 5)
        check("recovery, after A's park: A shown, full screen, in front", w.events.last == .cancelled(toB) && w.fullAndInFront(hKA) && !w.registry.isParked(1010), "\(w.events) \(s.history.suffix(4))")
        handoffInvariants("recovery, A parked", w, s, [hA])
    }
    do {
        // B entered full screen but never filled the display: recovered at the settle timeout, B set
        // normal, and parked again only once it is.
        let (w, s) = handoffSetup { $0.wrongBounds = [hKB] }
        var parkedWhileFull = false
        s.start(toB, from: hA, windowId: 10)
        for _ in 0..<200 {
            handoffRun(w, 0.05)
            if w.registry.isParked(2020), w.win(hKB)?.state == "fullscreen" { parkedWhileFull = true }
        }
        check("recovery: B parked again only once normal", !parkedWhileFull && w.registry.isParked(2020) && failed(w.events.last) && w.fullAndInFront(hKA), "\(w.events) \(s.history.suffix(4))")
        handoffInvariants("recovery, normal first", w, s)
    }
    do {
        // A failed close is tried once more after 0.5 s.
        let (w, s) = handoffSetup { $0.closeWindows = true; $0.closeFails = 1 }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        let closes = w.types(hA, "closeWindow")
        check("recovery: a failed close tried again after 0.5 s, then closed", closes.count == 2 && abs((closes[1].at - closes[0].at) - 0.54) < 0.05 && w.win(hKA) == nil, "\(closes.map(\.at))")
        check("recovery: … each try under a second freeze of its own, the failed one's revealed at once",
              w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0", "freeze 1.0 s: 0", "reveal 2 failed: 0", "freeze 1.0 s: 0", "reveal 3 ready: 0"] && closes.allSatisfy(\.frozen)
              && s.history.contains { $0.contains("'s close failed (couldn't close): again in 500 ms") }, "\(w.freezer.calls)")
        let (w2, s2) = handoffSetup { $0.closeWindows = true; $0.closeFails = 2 }
        s2.start(toB, from: hA, windowId: 10)
        handoffRun(w2, 4)
        check("recovery: failed twice: A stays where it is, the switch done", w2.types(hA, "closeWindow").count == 2 && w2.win(hKA) != nil && w2.events.last == .done(toB))
        check("recovery: … in its full-screen Space, logged, nothing held", w2.win(hKA)?.state == "fullscreen" && !w2.freezer.isLive && w2.fullAndInFront(hKB)
              && s2.history.contains { $0.contains("not closed (couldn't close): it stays") } && (s2.session.lines.last ?? "").contains("A kept (its close failed)"), "\(s2.session.lines.last ?? "")")
        handoffInvariants("recovery, close", w2, s2)
    }
    // ---- §1.5: targets ----
    do {
        // The window that asked comes first; then the home window; then the most recent parked one.
        let kb2 = WindowKey(link: hB, windowId: 21), kb3 = WindowKey(link: hB, windowId: 22)
        let (w, s) = handoffSetup { w in
            w.add(hB, id: 21, number: 2121, state: "normal")
            w.add(hB, id: 22, number: 2222, state: "normal")
            w.park(kb2, home: false)
            w.park(kb3, home: false)
        }
        s.start(toB, from: hA, windowId: 10, asked: kb2)
        check("target: the window that asked", s.run?.b == kb2 && s.run?.way == .parked)
        handoffRun(w, 4)
        check("target: … shown", w.fullAndInFront(kb2) && w.events.last == .done(toB))
        handoffInvariants("target, asked", w, s)
        let (w2, s2) = handoffSetup { w in
            w.add(hB, id: 22, number: 2222, state: "normal")
            w.park(kb3, home: false)
        }
        s2.start(toB, from: hA, windowId: 10)
        check("target: the home window over a more recent one", s2.run?.b == hKB)
        w2.registry.noteShown(link: hB, number: 999)
        s2.start(toC, from: hA, windowId: 10) // in its place, then back
        s2.start(toB, from: hA, windowId: 10)
        check("target: no home window parked: the most recently parked", s2.run?.b == kb3, "\(String(describing: s2.run?.b))")
        handoffRun(w2, 5)
        check("target: … shown", w2.events.last == .done(toB) && w2.fullAndInFront(kb3))
        handoffInvariants("target, recent", w2, s2)
    }
    do {
        // Its own window in full screen elsewhere: the focus variant, no show.
        let (w, s) = handoffSetup { w in
            w.registry.noteShown(link: hC, number: 3030)
            w.add(hC, id: 30, number: 3030, state: "fullscreen")
            w.focus(hKA)
        }
        let kc = WindowKey(link: hC, windowId: 30)
        s.start(toC, from: hA, windowId: 10)
        check("target: a full-screen window of its own: the focus variant", s.run?.way == .focus && s.run?.b == kc)
        handoffRun(w, 4)
        check("target: … focused full screen, nothing shown by the bridge, done", w.events.last == .done(toC) && w.fullAndInFront(kc) && w.types(hC, "setWindowState").count == 1
              && !w.reads.calls.contains("add 3030 → \(w.desktop)") && w.registry.isParked(1010), "\(w.reads.calls.suffix(6))")
        handoffInvariants("target, focus", w, s, [hA, hC])
    }
    do {
        // A normal window of its own (its Margin window's) on the Desktop: shown by the bridge (one op), then full screen.
        let (w, s) = handoffSetup { w in
            w.add(hC, id: 30, number: 3030, state: "normal")
            w.registry.noteShown(link: hC, number: 3030)
            w.registry.noteShown(link: hA, number: 1010)
        }
        let kc = WindowKey(link: hC, windowId: 30)
        s.start(toC, from: hA, windowId: 10)
        check("target: a normal window: the show variant", s.run?.way == .show)
        handoffRun(w, 4)
        check("target: … added to the active Space, then full screen", w.reads.calls.contains { $0.hasPrefix("add 3030 → ") } && w.fullAndInFront(kc) && w.events.last == .done(toC))
        handoffInvariants("target, show", w, s, [hA, hC])
    }
    do {
        // A normal window of the profile in no line is another Margin window's (docs/BROWSER-WINDOWS.md §2.1 rule 5): never
        // the target; one is made for this one instead.
        let (w, s) = handoffSetup { $0.add(hC, id: 30, number: 3030, state: "normal") }
        s.start(toC, from: hA, windowId: 10)
        check("target: another Margin window's window: passed over, a new one", s.run?.way == .create, "\(String(describing: s.run?.way))")
        handoffRun(w, 4)
        check("target: … made and in front, the other left where it is", w.events.last == .done(toC) && s.session.shown?.key != WindowKey(link: hC, windowId: 30)
              && w.win(WindowKey(link: hC, windowId: 30))?.state == "normal" && w.types(hC, "openSpaceWindow").count == 1, "\(w.events)")
        handoffInvariants("target, another Margin window's", w, s, [hA, hC])
    }
    do {
        // Minimized only: not a target (the genie under a freeze): a new window.
        let (w, s) = handoffSetup { $0.add(hC, id: 30, number: 3030, state: "minimized") }
        s.start(toC, from: hA, windowId: 10)
        check("target: only minimized: a new window", s.run?.way == .create)
        handoffRun(w, 4)
        check("target: … the minimized one left as it is", w.win(WindowKey(link: hC, windowId: 30))?.state == "minimized" && w.events.last == .done(toC))
        handoffInvariants("target, minimized", w, s, [hA, hC])
    }
    do {
        // §13.11: its home window there, and a window the person opened: never the target.
        let (w, s) = handoffSetup { w in
            w.add(hB, id: 23, number: 2323, state: "fullscreen") // the person's ⌘N window
            w.focus(hKA)
        }
        s.start(toB, from: hA, windowId: 10)
        check("target: the person's own extra window passed over for the home window", s.run?.b == hKB)
        handoffRun(w, 4)
        check("target: … which stays in its own Space", w.win(WindowKey(link: hB, windowId: 23))?.state == "fullscreen" && !w.registry.isParked(2323))
        handoffInvariants("target, extra", w, s)
    }
    do {
        // Its parked window mid-step as the switch starts (here, on its way back to the Desktop): waited
        // for, then picked again, never a second window.
        let (w, s) = handoffSetup()
        w.registry.returnToDesktop(number: 2020, cause: .system("a test"))
        s.start(toB, from: hA, windowId: 10)
        check("target: a parked window mid-step: still the target", s.run?.way == .parked && s.run?.bNumber == 2020)
        handoffRun(w, 4)
        check("target: … picked again once its step is over, shown, no window made", w.events.last == .done(toB) && w.fullAndInFront(hKB)
              && w.types(hB, "openSpaceWindow").isEmpty && s.session.parkOff == nil, "\(w.events) \(s.history.suffix(4))")
        handoffInvariants("target, mid-step", w, s)
    }
    // ---- §1.6: the create variant ----
    do {
        let (w, s) = handoffSetup()
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 4)
        let kc = WindowKey(link: hC, windowId: 50)
        check("create: one openSpaceWindow under the freeze, no full-screen request of its own", w.types(hC, "openSpaceWindow").count == 1 && w.types(hC, "openSpaceWindow")[0].frozen
              && w.types(hC, "setWindowState").isEmpty && w.types(hC, "focusWindow").isEmpty, "\(w.types(hC).map(\.type))")
        check("create: done, the new window in front, A parked, its home window", w.events.last == .done(toC) && w.fullAndInFront(kc) && w.registry.isParked(1010) && w.registry.lastShown[hC] == 5000)
        handoffInvariants("create", w, s, [hA, hC])
    }
    do {
        // §3.4: a second full-screen request only behind fullScreenRetry, on evidence it never took.
        let (w, s) = handoffSetup { $0.noFullScreen = [hKB] }
        s.options.handoff.fullScreenRetry = true
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 1.5)
        check("retry: on (gate G4 passed), still normal and unmoved 400 ms on: asked once more", w.types(hB, "setWindowState").filter { $0.state == "fullscreen" }.count == 2)
        handoffRun(w, 6)
        let (w2, s2) = handoffSetup { $0.noFullScreen = [hKB] }
        s2.start(toB, from: hA, windowId: 10)
        handoffRun(w2, 1.5)
        check("retry: off (the first build): one request only", w2.types(hB, "setWindowState").filter { $0.state == "fullscreen" }.count == 1)
        handoffInvariants("retry", w2, s2)
        _ = s
    }
    // ---- §1.10: blockers ----
    do {
        let (w, s) = handoffSetup { $0.dialogs = [ServerWindow(number: 7777, pid: 500, bounds: CGRect(x: 500, y: 300, width: 400, height: 200), onScreen: true)] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 0.1)
        check("blocker: a dialog over A: no handoff, the person told", !s.busy && w.events.last == .cancelled(toB) && w.notices == [SwitchNotice(.dialogOpen, profile: hA, shownIn: hKA)]
              && w.freezer.calls.isEmpty && w.registry.isParked(2020), "\(w.notices)")
        handoffInvariants("blocker", w, s)
    }
    do {
        // A's own full-screen toolbar isn't a dialog.
        let (w, s) = handoffSetup { $0.dialogs = [ServerWindow(number: 7778, pid: 500, bounds: CGRect(x: 0, y: 0, width: 1512, height: 40), onScreen: true, order: -1)] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("blocker: A's toolbar isn't one", w.events.last == .done(toB))
        w.dialogs = []
        handoffInvariants("blocker, toolbar", w, s)
    }
    // ---- §13.11: one window per profile ----
    do {
        let (w, s) = handoffSetup()
        s.start(.init(profile: hA, space: "a2"), from: hA, windowId: 10)
        handoffRun(w, 0.1)
        check("same profile: its space in its window, no switch", !s.busy && w.events.isEmpty && w.types(hA, "setSpace").last?.payload["spaceId"] as? String == "a2")
        handoffInvariants("same profile", w, s, [hA])
    }
    do {
        // A window in no line (one the person opened; line 1's A is 1111, parked) is a Margin window of its own
        // (docs/BROWSER-WINDOWS.md §2.1, 2026-11-09): the switch gives it a line, parks it like any A, and makes it
        // its own window of B. Line 1's parked B is another Margin window's: left parked.
        let ka2 = WindowKey(link: hA, windowId: 11)
        let (w, s) = handoffSetup { w in
            w.add(hA, id: 11, number: 1111, state: "normal")
            w.park(ka2) // line 1's home for A is 1111 now: 1010 is in no line
            w.focus(hKA)
        }
        let line1 = w.registry.line(of: 2020)
        s.start(toB, from: hA, windowId: 10)
        let line2 = w.registry.line(of: 1010)
        check("own window: a window in no line: a line of its own, parked like any A, B made for it",
              s.run?.choice.old == .park && s.run?.way == .create && line2 != nil && line2 != line1, "\(String(describing: s.run?.choice)) \(String(describing: s.run?.way)) \(w.registry.lines)")
        handoffRun(w, 4)
        let madeB = s.session.shown?.key
        check("own window: … its new B in front, A parked in its line, line 1's B and A still parked",
              w.events.last == .done(toB) && madeB != nil && madeB != hKB && madeB.map { w.fullAndInFront($0) } == true
              && w.registry.isParked(1010) && w.registry.isParked(2020) && w.registry.isParked(1111)
              && madeB.flatMap { w.number(of: $0) }.flatMap { w.registry.line(of: $0) } == line2 && w.registry.line(of: 2020) == line1, "\(w.events) \(w.registry.lines)")
        // Back to A from that window: its own A (1010), never line 1's (1111).
        if let madeB {
            s.start(.init(profile: hA, space: "a1"), from: hB, windowId: madeB.windowId)
            handoffRun(w, 4)
            check("own window: back to A in it: its own A shown, line 1's left parked", w.fullAndInFront(hKA) && w.registry.isParked(1111) && w.registry.isParked(2020)
                  && w.registry.lines[line2 ?? -1]?.shown == 1010, "\(w.events) \(w.registry.lines)")
        }
        handoffInvariants("own window", w, s)
    }
    // ---- §1.5: a parked target its copy hasn't named yet ----
    do {
        let kb5 = WindowKey(link: hB, windowId: 25)
        let (w, s) = handoffSetup { w in
            // A new copy of Margin in B's profile: its window has a new id, the binder hasn't bound it.
            w.update(hKB) { $0.id = 25 }
            w.unbound = [2020]
            _ = w.registry.sweep(SweepRead(pids: [w.pid], ext: w.copyWindows(hA) + w.copyWindows(hB), reporting: [hA, hB]))
        }
        check("unbound target: the registry's entry has no window id", w.registry.entries[2020] != nil && w.registry.entries[2020]?.windowId == nil)
        s.start(toB, from: hA, windowId: 10)
        check("unbound target: picked by number, with no key", s.run?.way == .parked && s.run?.b == nil && s.run?.bNumber == 2020)
        handoffRun(w, 0.4)
        check("unbound target: no freeze, shown by number, waiting for the binder", w.freezer.calls.isEmpty && !w.registry.isParked(2020) && w.types(hB, "setWindowState").isEmpty
              && s.history.contains { $0.contains("no copy id yet: no freeze") })
        w.unbound = []
        handoffRun(w, 4)
        check("unbound target: bound, then full screen: done", w.events.last == .done(toB) && w.fullAndInFront(kb5) && w.types(hB, "setWindowState").count == 1 && w.registry.isParked(1010))
        handoffInvariants("unbound", w, s)
    }
    do {
        // Never bound: recovered, the window parked again.
        let (w, s) = handoffSetup { w in
            w.update(hKB) { $0.id = 25 }
            w.unbound = [2020]
            _ = w.registry.sweep(SweepRead(pids: [w.pid], ext: w.copyWindows(hA) + w.copyWindows(hB), reporting: [hA, hB]))
        }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("unbound target, never bound: given up, A in front, the window parked again", failed(w.events.last) && w.fullAndInFront(hKA) && w.registry.isParked(2020), "\(w.events) \(s.history.suffix(3))")
        handoffInvariants("unbound, never", w, s)
    }
    // ---- the person's focus in a parked window asks for a handoff to it (§6.1) ----
    do {
        let (w, s) = handoffSetup()
        s.start(.init(profile: hB, space: "b0"), from: hA, windowId: 10, asked: hKB)
        handoffRun(w, 4)
        check("asked: a parked window's own activity: handed off to it", w.events.last == .done(.init(profile: hB, space: "b0")) && w.fullAndInFront(hKB) && w.types(hB, "setSpace").isEmpty)
        handoffInvariants("asked", w, s)
    }
    // ---- §6.2: no A ----
    do {
        let (w, s) = handoffSetup { w in w.close(hKA) }
        s.start(toB, from: hA, windowId: nil)
        handoffRun(w, 4)
        check("no A: B shown from the Desktop, frozen, done", w.events.last == .done(toB) && w.fullAndInFront(hKB) && w.freezer.calls.first == "freeze 1.7 s: 0")
        handoffInvariants("no A", w, s, [hB])
    }
    // ---- the watchdog with B ready and A not started (B steady past 1.15 s, its overlay not framed) ----
    do {
        let (w, s) = handoffSetup { $0.enterLag[hB] = 1.55; $0.framedOn = false }
        var aAskedFrozen: Bool?
        w.onRequest = { r in if r.link == hA, r.type == "setWindowState" { aAskedFrozen = r.frozen } }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 1.75)
        check("watchdog: B ready, A not started: revealed at 1.7 s, A untouched", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 watchdog: 0"] && aAskedFrozen == nil && s.run?.r2At != nil, "\(w.freezer.calls)")
        handoffRun(w, 3)
        check("watchdog: … A's exit and park after it, unfrozen", aAskedFrozen == false && w.registry.isParked(1010) && w.events.last == .done(toB))
        handoffInvariants("watchdog, A not started", w, s)
    }
    // ---- R3 behind Options.frameProbe ----
    do {
        let (w, s) = handoffSetup { $0.probeAnswer = ["tabId": 44, "frames": 6, "firstAt": 1, "lastAt": 80, "width": 1512, "height": 982, "hasFocus": true, "visible": true] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("R3 off (the first build): no probe sent", w.types(hB, "frameProbe").isEmpty && w.events.last == .done(toB))
        let (w2, s2) = handoffSetup { $0.probeAnswer = ["tabId": 44, "frames": 6, "firstAt": 1, "lastAt": 80, "width": 1512, "height": 982, "hasFocus": true, "visible": true] }
        s2.options.handoff.frameProbe = true
        s2.start(toB, from: hA, windowId: 10)
        handoffRun(w2, 4)
        let probe = w2.types(hB, "frameProbe").first
        check("R3 on: one probe at R1, at the full-screen size, under the freeze", w2.types(hB, "frameProbe").count == 1 && probe?.frozen == true
              && num(probe?.payload["width"]) == 1512 && num(probe?.payload["height"]) == 982 && int(probe?.payload["frames"]) == 6)
        check("R3 on: its frames in the switch's line", w2.events.last == .done(toB) && s2.session.lines.last?.contains("page frames") == true
              && s2.history.contains { $0.contains("(6, tab 44)") }, "\(s2.session.lines)")
        let (w3, s3) = handoffSetup()
        s3.options.handoff.frameProbe = true
        s3.start(toB, from: hA, windowId: 10)
        handoffRun(w3, 4)
        check("R3 on, no page: on anyway", w3.events.last == .done(toB) && s3.history.contains { $0.contains("no page frames") })
        handoffInvariants("R3", w3, s3)
    }
    // ---- landed: the Spaces still for 150 ms, or 2 s at most ----
    do {
        let (w, s) = handoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 4) { s.phase == .landed }
        let at = w.clock.now()
        var made: [UInt64] = []
        handoffUntil(w, max: 3) {
            made.append(w.newFs()) // a full-screen Space after another
            return !s.busy
        }
        check("landed: Spaces that keep moving: idle after 2 s anyway", !s.busy && abs(w.clock.now() - at - 2) < 0.05, "\(w.clock.now() - at)")
        w.fs.removeAll { made.contains($0) }
        w.updateDisplays()
        handoffInvariants("landed", w, s)
    }
    // ---- §5: "Close windows to save memory" turned on with windows parked ----
    do {
        // B's parked window with nothing typed; C's with a draft.
        let kC = WindowKey(link: hC, windowId: 30)
        let (w, s) = handoffSetup { w in
            w.add(hC, id: 30, number: 3030, state: "normal", space: "c1")
            w.park(kC)
            w.drafts[kC] = ["drafts": [5], "unknown": []]
        }
        let bSpace = w.registry.entries[2020]?.space
        s.closeParkedWindows()
        handoffRun(w, 2)
        check("setting on: a parked window with nothing typed closed by its copy, after its drafts", w.win(hKB) == nil && !w.registry.isParked(2020)
              && w.types(hB, "windowDrafts").count == 1 && w.types(hB, "closeWindow").count == 1
              && bSpace.map { w.reads.destroyed.contains($0) } == true, "\(s.history.suffix(4))")
        check("setting on: one with a draft stays parked, and the person is told with its Close window",
              w.win(kC) != nil && w.registry.entries[3030]?.phase == .parked && w.types(hC, "closeWindow").isEmpty
              && w.notices == [SwitchNotice(.windowKeptDraft, profile: hC, kept: kC)], "\(w.notices)")
        check("setting on: the window in front untouched", w.fullAndInFront(hKA) && w.types(hA).isEmpty && !w.freezer.isLive && w.freezer.calls.isEmpty)
        handoffInvariants("setting on", w, s, [hA])
    }
    do {
        // No drafts answer: kept; a close that fails twice: tried again after 0.5 s, then kept.
        let (w, s) = handoffSetup { $0.silentDrafts = true }
        s.closeParkedWindows()
        handoffRun(w, 2)
        check("setting on, no drafts answer: stays parked, told", w.registry.entries[2020]?.phase == .parked && w.types(hB, "closeWindow").isEmpty
              && w.notices.first?.kind == .windowKeptDraft && w.notices.first?.kept == hKB)
        let (w2, s2) = handoffSetup { $0.closeFails = 2 }
        s2.closeParkedWindows()
        handoffRun(w2, 3)
        let closes = w2.types(hB, "closeWindow")
        check("setting on, a close that fails: tried again after 0.5 s, then it stays parked as it was",
              closes.count == 2 && closes[1].at - closes[0].at >= 0.5 && w2.registry.entries[2020]?.phase == .parked && w2.win(hKB) != nil
              && s2.history.contains { $0.contains("not closed: it stays parked") }, "\(s2.history.suffix(3))")
        handoffInvariants("setting on, failed", w2, s2, [hA])
        handoffInvariants("setting on, no answer", w, s, [hA])
    }
    do {
        // Turned on mid-switch: nothing closed until the switch is idle, then A (parked by it) and none other.
        let (w, s) = handoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 1) { s.phase == .frozen }
        s.closeParkedWindows()
        check("setting on mid-switch: nothing asked yet", w.types(hA, "windowDrafts").count == 1 && w.types(hA, "closeWindow").isEmpty && s.session.closeParkedAsked)
        handoffUntil(w, max: 5) { !s.busy }
        let parkedThen = w.registry.isParked(1010)
        handoffRun(w, 2)
        check("setting on mid-switch: after it, the window it parked closed by its copy", parkedThen && w.win(hKA) == nil && !w.registry.isParked(1010)
              && w.types(hA, "windowDrafts").count == 2 && w.fullAndInFront(hKB) && !s.session.closeParkedAsked, "\(s.history.suffix(4))")
        handoffInvariants("setting on mid-switch", w, s, [hB])
    }
    // ---- nothing logged but ids and numbers ----
    check("log: no addresses or titles in the machine's lines", !said.contains { $0.contains("http") || $0.contains("title") }, "\(said.filter { $0.contains("http") })")
}

// ---- what a review of the machine found (each case fails before its fix) ----

func handoffReviewTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let toB = ProfileSwitch.Target(profile: hB, space: "b1")
    let toC = ProfileSwitch.Target(profile: hC, space: "c1")
    func failed(_ e: ProfileSwitch.Event?) -> Bool { if case .failed? = e { return true }; return false }
    let unboundB = { (w: FakeHandoffWorld) in
        // A new copy of Margin in B's profile: its window has a new id, the binder hasn't bound it.
        w.update(hKB) { $0.id = 25 }
        w.unbound = [2020]
        _ = w.registry.sweep(SweepRead(pids: [w.pid], ext: w.copyWindows(hA) + w.copyWindows(hB), reporting: [hA, hB]))
    }

    do {
        // A's normal times out (a hung tab), then lands while the switch still owns A: parked by the
        // switch's own steps, never raced by the aftercare into a busy park that turns parking off.
        let (w, s) = handoffSetup { $0.slowExit[hKA] = 4.5 }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 12)
        check("review: A's normal timed out, then landed mid-switch: parked, parking still on, A not closed",
              s.session.parkOff == nil && w.registry.isParked(1010) && w.win(hKA) != nil && w.types(hA, "closeWindow").isEmpty && w.events.last == .done(toB),
              "\(String(describing: s.session.parkOff)) \(w.events) \(s.history.suffix(4))")
        handoffInvariants("review, late normal mid-switch", w, s)
    }
    do {
        // The clock moves on while the abort reveals and recovers (it always does outside the tests): B's
        // full-screen request landing after the person's swipe is still no late landing.
        let (w, s) = handoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 1) { !w.types(hB, "setWindowState").isEmpty }
        handoffRun(w, 0.2)
        w.freezer.onReveal = { why in if why == .aborted { w.clock.t += 0.001 } } // the reveal takes its time
        w.setActive(w.desktop)
        handoffRun(w, 4)
        check("review: a swipe's abort, the clock moving in its recovery: B's late full screen not adopted",
              !w.notices.contains { $0.kind == .lateLanding } && w.fullAndInFront(hKA) && w.registry.isParked(2020), "\(w.notices) \(s.history.suffix(4))")
        handoffInvariants("review, abort with time passing", w, s)
    }
    do {
        // A switch that recovers (B never answers): A is its line's shown window again (docs/BROWSER-WINDOWS.md §2.2).
        let (w, s) = handoffSetup { $0.hung = [hKB] }
        let line = w.registry.line(of: 1010)
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 7)
        check("review: the switch recovered: A its line's shown window again, and the session's",
              failed(w.events.last) && s.session.shown?.key == hKA && w.registry.lines[line ?? -1]?.shown == 1010 && w.fullAndInFront(hKA), "\(w.events) \(w.registry.lines)")
        w.unhang(hKB)
        handoffRun(w, 4)
        handoffInvariants("review, recovered in a line", w, s)
    }
    do {
        // B's show didn't land and its drafts never answer: when the switch gives up, B (in no Space, its
        // own destroyed) goes back to its Desktop by number.
        let (w, s) = handoffSetup { $0.silentDrafts = true }
        w.onRequest = { r in if r.link == hB, r.type == "setSpace" { w.reads.dropNext = 4 } }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 9)
        check("review: B's show didn't land, no drafts answer: back on its Desktop, not left in no Space",
              w.reads.spaces(of: 2020)?.isEmpty == false && !w.registry.isParked(2020) && failed(w.events.last) && w.fullAndInFront(hKA),
              "\(String(describing: w.reads.spaces(of: 2020))) \(w.registry.entries[2020].map { "\($0.phase)" } ?? "-") \(s.history.suffix(4))")
        handoffInvariants("review, show not landed", w, s)
    }
    do {
        // A normal window of its own and no bridge (parking off): run unfrozen, since macOS slides to its
        // Desktop as it's asked into full screen and the freeze's Space rule would abort.
        let kc = WindowKey(link: hC, windowId: 30)
        let (w, s) = handoffSetup { w in
            w.slides = true
            w.parkingOnFlag = false
            w.add(hC, id: 30, number: 3030, state: "normal")
            w.registry.noteShown(link: hC, number: 3030)
            w.registry.noteShown(link: hA, number: 1010)
        }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 6)
        check("review: a normal target with no bridge: unfrozen, done, never aborted", w.events.last == .done(toC) && w.fullAndInFront(kc) && w.freezer.calls.isEmpty
              && !s.history.contains { $0.contains("aborted") }, "\(w.events) \(w.freezer.calls) \(s.history.suffix(4))")
        handoffInvariants("review, show with no bridge", w, s, [hA, hC])
    }
    do {
        // A parked target with no copy id, bound 1.6 s after its show: its space set and its full screen
        // asked from the bind (not from a freeze it never had), so it lands.
        let kb5 = WindowKey(link: hB, windowId: 25)
        let (w, s) = handoffSetup(unboundB)
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 1) { s.run?.shownAt != nil }
        handoffRun(w, 1.6)
        w.unbound = []
        handoffRun(w, 4)
        check("review: an unbound target bound 1.6 s after its show: done, not refused as late", w.events.last == .done(toB) && w.fullAndInFront(kb5), "\(w.events) \(s.history.suffix(4))")
        check("review: … its space set once it was bound", w.types(hB, "setSpace").contains { int($0.payload["windowId"]) == 25 && $0.payload["spaceId"] as? String == "b1" },
              "\(w.types(hB, "setSpace").map(\.payload))")
        handoffInvariants("review, bound late", w, s)
    }
    do {
        // Never bound: parked again under its own profile, so it's rebound and found again.
        let (w, s) = handoffSetup(unboundB)
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("review: an unbound target never bound: parked again with its profile's link", failed(w.events.last) && w.registry.entries[2020]?.link == hB
              && w.registry.entries(of: hB).map(\.number) == [2020], "\(w.registry.entries[2020].map(\.link) ?? "-")")
        handoffInvariants("review, never bound", w, s)
    }
    do {
        // Close mode, a late landing: the window shown before is closed by its copy (drafts permitting),
        // not left a normal window on the Desktop.
        let (w, s) = handoffSetup { $0.closeWindows = true; $0.hung = [hKB] }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 7)
        w.unhang(hKB)
        handoffRun(w, 4)
        check("review: close mode, a late landing: the window shown before closed, never set normal", w.fullAndInFront(hKB) && w.win(hKA) == nil
              && w.types(hA, "setWindowState").allSatisfy { $0.state != "normal" }, "\(w.win(hKA).map(\.state) ?? "gone") \(s.history.suffix(4))")
        handoffInvariants("review, close mode late landing", w, s)
    }
    do {
        // The displays don't read and the target has a parked window: refused, the window still parked;
        // never adopted by the close-based switch out of its private Space.
        let (w, s) = handoffSetup { $0.displaysUnread = true }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 3)
        check("review: the displays unread, B parked: refused, B still parked, nothing asked of it", failed(w.events.last) && !s.busy && w.registry.isParked(2020)
              && w.types(hB).filter { ["focusWindow", "openSpaceWindow", "setWindowState"].contains($0.type) }.isEmpty && w.fullAndInFront(hKA), "\(w.events) \(w.types(hB).map(\.type))")
    }
    do {
        // The close-based switch in a handoff world: its window becomes the shown one (§13.8 judges a close
        // against it) and its profile's home window.
        let (w, s) = handoffSetup { $0.noFreezer = true; $0.closeWindows = true }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 5)
        check("review: the close-based switch landed: its window the shown one, its profile's home window", w.events.last == .done(toC)
              && s.session.shown?.key == WindowKey(link: hC, windowId: 50) && s.session.shown?.number == 5000 && w.registry.lastShown[hC] == 5000,
              "\(String(describing: s.session.shown))")
    }
    do {
        // ⌘W on B in `after`, a switch queued meanwhile: the switch ends there with B the shown window (the
        // shell's §13.8 judges it once idle), and nothing starts from the closed window.
        let (w, s) = handoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 3) { s.phase == .after }
        s.start(toC, from: hA, windowId: 10)
        w.close(hKB)
        handoffRun(w, 4)
        check("review: B closed in after: cancelled, B still the shown window, the queued switch dropped", w.events.last == .cancelled(toB)
              && !w.events.contains(.started(toC)) && s.session.shown?.key == hKB && !s.busy && w.registry.isParked(1010), "\(w.events) \(String(describing: s.session.shown))")
    }
    do {
        // Going to sleep before the freeze: the switch given up with nothing touched, and no freeze until
        // the Mac wakes.
        let (w, s) = handoffSetup { $0.coverOn = false }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 0.1)
        s.revealNow(.sleep)
        handoffRun(w, 3)
        check("review: sleep before the freeze: given up, nothing frozen or touched", w.freezer.calls.isEmpty && w.events.last == .cancelled(toB) && w.registry.isParked(2020)
              && w.fullAndInFront(hKA), "\(w.freezer.calls) \(w.events)")
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("review: … still asleep: a switch runs, without a freeze", w.freezer.calls.isEmpty && w.events.last == .done(toB), "\(w.freezer.calls) \(w.events)")
        s.woke()
        let toA = ProfileSwitch.Target(profile: hA, space: "a1")
        s.start(toA, from: hB, windowId: 20)
        handoffRun(w, 4)
        check("review: … woke: frozen again", w.freezer.calls.first == "freeze 1.7 s: 0" && w.events.last == .done(toA), "\(w.freezer.calls)")
        handoffInvariants("review, sleep", w, s)
    }
    do {
        // Margin quitting after B's reveal in close mode: no second freeze for the close, and nothing queued starts.
        let (w, s) = handoffSetup { $0.closeWindows = true }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 3) { s.phase == .after }
        s.start(toC, from: hA, windowId: 10)
        s.revealNow(.quit)
        handoffRun(w, 4)
        check("review: quitting after the reveal: never frozen again, the queued switch dropped", w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"]
              && !w.events.contains(.started(toC)) && !s.busy, "\(w.freezer.calls) \(w.events)")
    }
    do {
        // The keys (§1.7): the switch's while it moves windows; not while it waits for a profile's copy.
        let (w, s) = handoffSetup { $0.linked.remove(hC) }
        s.start(toC, from: hA, windowId: 10)
        handoffRun(w, 0.5)
        check("review: waiting for a profile's copy: the keys aren't the switch's", s.phase == .waitingForProfile && !s.keysMidSwitch, "\(s.phase)")
        let (w2, s2) = handoffSetup()
        s2.start(toB, from: hA, windowId: 10)
        check("review: preparing: the keys are the switch's", s2.phase == .preparing && s2.keysMidSwitch)
        withExtendedLifetime((w, w2)) {} // the switch's world is weak
    }
}

// The real shell event entry point with independent fake browser/Space state.
// No event is posted to macOS; no window, native private call or browser runs.
func handoffTopologyTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let toB = ProfileSwitch.Target(profile: hB, space: "b1")
    let toC = ProfileSwitch.Target(profile: hC, space: "c1")
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-topology-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    func routing(_ w: FakeHandoffWorld, _ s: ProfileSwitch) -> Shell {
        var options = Shell.Options()
        options.harness = true; options.dataRoot = root; options.switchClock = w.clock
        let shell = Shell(link: SocketLink(), windows: StubWindows(), apps: StubApps(), hotKeys: FakeRegistrar(), options: options)
        shell.switcher = s
        shell.parking = w.registry // actual systemEvent ordering before source recovery
        return shell
    }
    func sweep(_ w: FakeHandoffWorld, _ s: ProfileSwitch, seconds: Double) {
        var left = seconds
        while left > 1e-9 {
            let step = min(0.004, left)
            w.clock.advance(step); left -= step
            _ = w.registry.sweep(SweepRead(pids: [w.pid], ext: w.linked.flatMap { w.copyWindows($0) },
                                         reporting: w.linked, moving: s.movingNumbers))
        }
    }

    for why in ["screen locked", "will sleep"] {
        do {
            let (w, s) = handoffSetup { $0.noFreezer = true; $0.coverOn = false; $0.linked.remove(hC); $0.opensWindows = true }
            let shell = routing(w, s)
            s.start(toC, from: hA, windowId: 10)
            check("session \(why): missing profile wait has actually opened its window", s.phase == .waitingForProfile
                  && s.run?.awaitedProfile == true && w.openedWindowFor == [hC])
            w.setActive(w.desktop)
            shell.appsChanged(why)
            let kc = w.add(hC, id: 30, number: 3030, state: "normal") // arrival while cancellation restores A
            handoffRun(w, 2)
            check("session \(why): late profile cannot resume or park source after interruption", !s.busy
                  && w.events.last == .cancelled(toC) && s.session.noFreeze == .sleep && s.queued == nil
                  && w.fullAndInFront(hKA) && !w.registry.isParked(1010)
                  && w.types(hC, "setWindowState").isEmpty && w.types(hC, "setSpace").isEmpty
                  && w.types(hA, "setWindowState").allSatisfy { $0.state == "fullscreen" }
                  && w.win(kc)?.state == "normal" && w.freezer.calls.isEmpty)
            shell.appsChanged(why == "screen locked" ? "screen unlocked" : "woke")
            check("session \(why): wake clears sleep gate without resuming cancelled request", s.session.noFreeze == nil && !s.busy
                  && w.events.filter { $0 == .started(toC) }.count == 1)
            s.start(toB, from: hA, windowId: 10)
            handoffRun(w, 4)
            check("session \(why): fresh deliberate request succeeds after wake", w.events.last == .done(toB)
                  && w.fullAndInFront(hKB) && w.registry.isParked(1010) && w.strands.isEmpty)
        }

        do {
            let (w, s) = handoffSetup { $0.coverOn = false; $0.linked.remove(hC); $0.opensWindows = true }
            let shell = routing(w, s)
            s.start(toC, from: hA, windowId: 10)
            handoffUntil(w, max: 1) { s.phase == .frozen && w.openedWindowFor == [hC] }
            s.start(toB, from: hA, windowId: 10)
            check("session \(why): later target actually queued under the profile-opening freeze", s.queued == toB)
            handoffRun(w, 2)
            check("session \(why): watchdog actually left a waiting profile with queued work", s.phase == .waitingForProfile
                  && s.queued == toB && !w.freezer.isLive)
            shell.appsChanged(why)
            w.add(hC, id: 30, number: 3030, state: "normal")
            handoffRun(w, 3)
            check("session \(why): late profile never launches pre-sleep queued target", !s.busy && s.queued == nil
                  && !w.events.contains(.started(toB)) && w.events.last == .cancelled(toC)
                  && w.fullAndInFront(hKA) && !w.registry.isParked(1010) && w.registry.isParked(2020)
                  && w.types(hC, "setWindowState").isEmpty && w.freezer.calls.filter { $0.hasPrefix("freeze") }.count == 1)
        }

        do {
            let (w, s) = handoffSetup { $0.coverOn = false; $0.linked.remove(hB) }
            let shell = routing(w, s)
            s.start(toB, from: hA, windowId: 10)
            check("session \(why): parked target waits for its copy before any browser mutation", s.phase == .waitingForLink)
            shell.appsChanged(why)
            w.linked.insert(hB)
            handoffRun(w, 1)
            check("session \(why): late link cannot restart a pre-sleep parked-window request", !s.busy
                  && w.events.last == .cancelled(toB) && w.freezer.calls.isEmpty && w.types(nil, "setWindowState").isEmpty
                  && w.registry.isParked(2020) && w.fullAndInFront(hKA) && s.session.noFreeze == .sleep)
        }
    }

    for why in ["displays changed", "the Dock restarted"] {
        let (w, s) = handoffSetup { $0.coverOn = false }
        let shell = routing(w, s)
        s.start(toB, from: hA, windowId: 10)
        check("topology \(why): legacy preparation has no live cover handle", s.phase == .preparing && s.run?.coverPreparedAt == nil)
        if why == "displays changed" { w.displays = 2 }
        shell.appsChanged(why)
        handoffRun(w, 0.4)
        check("topology \(why): untouched run cancelled before any stale freeze/show", !s.busy && w.events.last == .cancelled(toB)
              && w.freezer.calls.isEmpty && w.types(nil, "setWindowState").isEmpty && w.registry.isParked(2020)
              && w.fullAndInFront(hKA) && w.registry.inSystemWindow)
    }

    do {
        let (w, s) = handoffSetup { $0.linked.remove(hB) }
        let cover = FakeHandoffCover(clock: w.clock); w.liveCover = cover
        let shell = routing(w, s)
        s.start(toB, from: hA, windowId: 10)
        check("topology: link wait captures a one-display choice before cover preparation", s.phase == .waitingForLink
              && s.run?.coverPreparedAt == nil && s.run?.choice.freeze == true)
        w.displays = 2
        shell.appsChanged("displays changed")
        w.linked.insert(hB)
        handoffRun(w, 0.4)
        check("topology: a later link cannot resume the invalidated choice", !s.busy && w.events.last == .cancelled(toB)
              && cover.contexts.isEmpty && w.freezer.calls.isEmpty && w.types(nil, "setWindowState").isEmpty && w.fullAndInFront(hKA))
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 4)
        check("topology: a fresh two-display request uses keep/no-freeze without demotion", w.events.last == .done(toB)
              && w.freezer.calls.isEmpty && cover.contexts.isEmpty && w.win(hKA)?.state == "fullscreen" && !w.registry.isParked(1010)
              && w.fullAndInFront(hKB) && s.session.rules.on && s.session.coverOff == nil && s.session.parkOff == nil)
    }

    do {
        let (w, s) = handoffSetup { $0.coverOn = false }
        let shell = routing(w, s)
        s.session.pending[hKA] = ("focusWindow", 42, w.clock.now())
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 0.04)
        check("topology: pending source holds preparation before cover setup", s.phase == .preparing && s.run?.coverPreparedAt == nil)
        w.displays = 2
        shell.appsChanged("displays changed")
        s.session.pending[hKA] = nil
        handoffRun(w, 0.5)
        check("topology: pending completion cannot restart the cancelled preparation", !s.busy && w.freezer.calls.isEmpty
              && w.types(nil, "setWindowState").isEmpty && w.registry.isParked(2020) && w.fullAndInFront(hKA))
    }

    do {
        let (w, s) = handoffSetup()
        let cover = FakeHandoffCover(clock: w.clock); w.liveCover = cover
        let shell = routing(w, s)
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        cover.prepared()
        handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }
        check("topology: activation acknowledgement is still pending", s.phase == .covering && cover.activations.count == 1)
        w.displays = 2
        shell.appsChanged("displays changed")
        if !cover.activations.isEmpty { cover.staleAcknowledgement(0, true) }
        handoffRun(w, 0.3)
        check("topology: stale cover activation cannot start a browser transition", !s.busy && cover.ends.map(\.why) == [.aborted]
              && cover.state == .idle && w.types(nil, "setWindowState").isEmpty && w.types(nil, "openSpaceWindow").isEmpty
              && w.registry.isParked(2020) && w.fullAndInFront(hKA))
    }

    do {
        let (w, s) = handoffSetup { $0.noFreezer = true; $0.linked.remove(hC); $0.opensWindows = true }
        let shell = routing(w, s)
        s.start(toC, from: hA, windowId: 10)
        check("topology: awaiting profile may already have asked Safari to open it", s.phase == .waitingForProfile && w.openedWindowFor == [hC])
        w.setActive(w.desktop) // opening a profile may already have taken focus
        w.displays = 2
        shell.appsChanged("displays changed")
        handoffRun(w, 1.5)
        w.add(hC, id: 30, number: 3030, state: "normal") // late copy/window arrival
        handoffRun(w, 0.3)
        check("topology: awaiting profile restores source and ignores late target arrival", !s.busy && w.events.last == .cancelled(toC)
              && w.fullAndInFront(hKA) && w.types(hA, "setWindowState").last?.state == "fullscreen"
              && w.types(hC, "setWindowState").isEmpty && w.types(hC, "openSpaceWindow").isEmpty && w.freezer.calls.isEmpty)
    }

    do {
        let (w, s) = handoffSetup { $0.noFreezer = true; $0.coverOn = false; $0.spaceSelectionFocuses = true }
        w.registry.show(number: 2020, cause: .handoff)
        handoffRun(w, 0.05)
        // Give B its own actual fake full-screen Space. Merely showing a
        // normal B can put it in A's active Space, where both inFront reads
        // would be true even when setSpace really focused B.
        w.enter(hKB) { _ in }
        handoffRun(w, 1)
        w.update(hKB) { $0.space = "b0" } // independent selected-space mismatch
        w.focus(hKA)
        let shell = routing(w, s)
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.15) { w.types(hB, "setSpace").count == 1 && w.inFrontNow(hKB) }
        check("topology: legacy preparation can already focus target through space selection", s.phase == .preparing
              && s.run?.spaceSelectionAsked == true && w.inFrontNow(hKB) && !w.inFrontNow(hKA))
        w.displays = 2
        shell.appsChanged("displays changed")
        handoffRun(w, 1.5)
        check("topology: pretransition space selection restores source rather than claiming untouched", !s.busy
              && w.fullAndInFront(hKA) && w.events.last == .cancelled(toB)
              && w.types(hA, "setWindowState").last?.state == "fullscreen"
              && w.types(hA, "closeWindow").isEmpty && w.freezer.calls.isEmpty)
    }

    do {
        let (w, s) = handoffSetup { $0.slowExit[hKB] = 1.5 }
        let cover = FakeHandoffCover(clock: w.clock); w.liveCover = cover
        s.session.coverOff = "legacy fallback for this regression"
        let shell = routing(w, s)
        w.onRequest = { r in
            if r.link == hA, r.type == "setWindowState", r.state == "normal" { w.reads.dropNext = 2 }
        }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 2) { w.registry.entries[1010]?.stepping == true }
        check("topology: legacy source park is actually pending before its delayed failure", s.phase == .frozen
              && s.run?.coverStartedAt == nil && w.registry.entries[1010]?.stepping == true && w.types(hA, "closeWindow").isEmpty)
        w.displays = 2
        shell.appsChanged("displays changed")
        sweep(w, s, seconds: 4)
        check("topology: genuine late failed park still demotes capability during recovery", s.session.parkOff?.contains("park didn't land") == true
              && s.session.coverOff == "legacy fallback for this regression")
        check("topology: delayed legacy park failure cannot close restoring source", !s.busy && w.fullAndInFront(hKA)
              && w.win(hKA) != nil && w.types(hA, "closeWindow").isEmpty && !w.registry.isParked(1010)
              && w.events.last == .cancelled(toB) && cover.contexts.isEmpty && !w.freezer.isLive && w.strands.isEmpty)
    }

    do {
        let (w, s) = handoffSetup { $0.closeFails = 1; $0.enterLag[hA] = 0.1 }
        s.session.coverOff = "legacy fallback for this regression"
        let shell = routing(w, s)
        w.onRequest = { r in
            if r.link == hA, r.type == "setWindowState", r.state == "normal" { w.reads.dropNext = 2 }
        }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 3) { s.history.contains { $0.contains("'s close failed") && $0.contains("again in") } }
        check("topology: legacy failed-close retry has actually been scheduled", w.types(hA, "closeWindow").count == 1
              && w.win(hKA) != nil && s.run?.coverStartedAt == nil
              && s.history.contains { $0.contains("'s close failed") && $0.contains("again in") })
        w.displays = 2
        shell.appsChanged("displays changed")
        sweep(w, s, seconds: 2)
        check("topology: old close retry cannot run after source restoration or completion", !s.busy && w.fullAndInFront(hKA)
              && w.types(hA, "closeWindow").count == 1 && w.win(hKA) != nil && s.session.parkOff != nil
              && w.events.last == .cancelled(toB) && !w.freezer.isLive && w.strands.isEmpty)
    }

    do {
        let (w, s) = handoffSetup { $0.blockedOverlays = [hKB] }
        let cover = FakeHandoffCover(clock: w.clock); w.liveCover = cover
        let shell = routing(w, s)
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }; cover.prepared()
        handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }; cover.acknowledge(true)
        handoffUntil(w, max: 3) { w.registry.isParked(1010) }
        check("topology: source is parked under an acknowledged live cover", s.phase == .covered && w.registry.isParked(1010) && cover.state == .shown)
        s.start(toC, from: hA, windowId: 10)
        check("topology: a later target is queued behind the moving run", s.queued == toC)
        w.displays = 2
        shell.appsChanged("displays changed")
        let recoveringDeadline = s.deadline
        shell.appsChanged("displays changed")
        check("topology: immediate disposal, one bounded recovery, queued target dropped", cover.ends.map(\.why) == [.aborted]
              && s.phase == .recovering && s.queued == nil && s.deadline == recoveringDeadline && w.registry.inSystemWindow)
        sweep(w, s, seconds: 4)
        check("topology: registry system sweep does not repark the restoring source", !s.busy && w.fullAndInFront(hKA)
              && !w.registry.isParked(1010) && w.registry.entries[1010] == nil && w.registry.isParked(2020)
              && w.types(hA, "setWindowState").filter { $0.state == "normal" }.count == 1 && w.strands.isEmpty)
        check("topology: no queued profile starts after recovery on changed displays", !w.events.contains(.started(toC))
              && w.types(hC, "openSpaceWindow").isEmpty && w.events.last == .cancelled(toB) && w.freezer.calls.isEmpty)
    }

    do {
        let (w, s) = handoffSetup { $0.coverOn = false }
        let shell = routing(w, s)
        w.onRequest = { r in
            if r.link == hB, r.type == "setWindowState", r.state == "fullscreen" { w.linked.remove(hA) }
        }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 3) { s.phase == .after && s.session.watches.contains { $0.number == 1010 && $0.kind == .leaveFullScreen } }
        check("topology: disconnected source actually has a pending leave-fullscreen aftercare watch", s.phase == .after
              && s.session.watches.contains { $0.number == 1010 && $0.kind == .leaveFullScreen }
              && w.types(hA, "setWindowState").isEmpty && w.fullAndInFront(hKB))
        w.displays = 2
        shell.appsChanged("displays changed")
        check("topology: source recovery removes conflicting prior aftercare ownership", s.phase == .recovering
              && !s.session.watches.contains { $0.number == 1010 })
        w.linked.insert(hA)
        sweep(w, s, seconds: 4)
        check("topology: relinked source restored without stale aftercare exiting or parking it", !s.busy
              && w.events.last == .cancelled(toB) && w.fullAndInFront(hKA) && !w.registry.isParked(1010)
              && !w.types(hA, "setWindowState").isEmpty && w.types(hA, "setWindowState").allSatisfy { $0.state == "fullscreen" }
              && w.types(hA, "closeWindow").isEmpty && !s.session.watches.contains { $0.number == 1010 } && w.strands.isEmpty)
    }
}
