// The profile handoff (app/HANDOFF.md), part of tests.swift's run. No real
// private function is called here and nothing freezes the screen.
//
// The freezer (Freezer.swift): FakeFreezer on the fake clock (the watchdog at
// 1.7 s, and the close handoff's 1.0 s; a reveal once only; a release after a
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
        check("freezer: the watchdog reveals at 1.7 s", !fake.isLive && fake.calls.last == "reveal 1 watchdog: 0"
              && heard.reports.last == .revealed(handle: 1, why: .watchdog, heldMs: 1700), "\(heard.reports)")
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
        clock.advance(1.7)
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
