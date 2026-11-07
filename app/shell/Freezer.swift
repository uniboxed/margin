// The freeze the profile handoff runs under (app/HANDOFF.md §1.3, §1.4, §4.3):
// the screen held still by SLSNewTransition while Safari's windows change
// Spaces behind it, then revealed with SLSInvokeTransition.
//
// - macOS lets go of a freeze by itself at about 2 s. Margin reveals first: the
//   freezer's own watchdog, a DispatchSourceTimer on a private serial queue,
//   reveals at Options.watchdog (1.7 s) if the freeze is still live. A stuck
//   main thread can't hold the screen.
// - A lock guards the handle: whoever takes it reveals, once. The watchdog and
//   the machine can't both reveal, and a new freeze can't start while a reveal
//   is still in SkyLight.
// - SLSReleaseTransition only after a reveal that didn't answer 0 (as the labs did).
// - Every result goes to the delegate, on the main actor, for the session rules
//   (FreezeRules): two failed freezes in a row, or one failed reveal, turn the
//   freeze off until Margin.app quits.
// - RealFreezer refuses under MARGIN_APP_TESTS, so no test freezes the screen.
//   FakeFreezer is the tests' and the harness's: scripted results, and its
//   watchdog on a SwitchClock (the unit tests' fake clock).
// - The log holds handles, results and milliseconds only.

import Foundation

// Why a freeze was revealed (HANDOFF.md §4.3 "reveal-at-once paths").
nonisolated enum RevealWhy: String, Sendable {
    case ready // R3, R4 and R5 held, or their timeouts passed
    case watchdog // the freezer's own timer
    case aborted // the active Space moved to one the switch didn't expect (§1.2)
    case failed // a step failed: recovery goes on unfrozen (§4.4)
    case closed // B closed, or its copy gone (§1.8)
    case cancelled // the switch was given up
    case safariQuit
    case sleep // the Mac is going to sleep (§6.8)
    case quit // Margin.app quitting (Shell.stop), or the freezer going away
}

nonisolated enum FreezeResult: Equatable, Sendable {
    case frozen(handle: Int32)
    case failed(Int32) // SLSNewTransition's nonzero answer: this switch runs without a freeze
    case unavailable(String) // nothing called: refused in tests, the calls off, or a freeze already live
}

nonisolated enum RevealResult: Equatable, Sendable {
    case revealed
    case failed(Int32, released: Int32?) // SLSInvokeTransition's nonzero answer, then SLSReleaseTransition's
    case notLive // nothing to reveal: never frozen, or revealed already (the watchdog, or a reveal before)
}

// What the delegate hears: each call made, with its result. Nothing is reported for a call
// that wasn't made (`unavailable`, `notLive`).
nonisolated enum FreezeReport: Equatable, Sendable {
    case froze(handle: Int32)
    case freezeFailed(result: Int32)
    case revealed(handle: Int32, why: RevealWhy, heldMs: Int)
    case revealFailed(handle: Int32, why: RevealWhy, result: Int32, released: Int32?, heldMs: Int)
}

protocol FreezerDelegate: AnyObject {
    // On the main actor. A watchdog reveal arrives a moment after it happened (it's made on the
    // freezer's queue): `isLive` is already false by then.
    func freezer(_ freezer: Freezer, reported: FreezeReport)
}

protocol Freezer: AnyObject {
    var delegate: FreezerDelegate? { get set }
    // A freeze is held and not yet revealed.
    var isLive: Bool { get }
    // Holds the screen still; the watchdog reveals it after `watchdog` seconds (nil: Options.watchdog).
    func freeze(watchdog: TimeInterval?) -> FreezeResult
    // Reveals the live freeze, once. A second reveal, or one after the watchdog's, is `notLive`.
    @discardableResult func reveal(_ why: RevealWhy) -> RevealResult
}

extension Freezer {
    func freeze() -> FreezeResult { freeze(watchdog: nil) }
}

nonisolated struct FreezerOptions: Sendable {
    // Before macOS's own release at about 2 s; the labs used 1.7-1.85 s. Gate G16 may change it.
    var watchdog: TimeInterval = 1.7
    // The close handoff's second freeze (§4.5) is short: its caller passes this.
    var closeWatchdog: TimeInterval = 1.0
}

// The session rules (HANDOFF.md §1.1 "Session demotions", §4.3), kept by the freezer's delegate
// from its reports. Also what the cooldown (§1.5) needs: when the last reveals were.
struct FreezeRules {
    static let failedFreezesToTurnOff = 2

    private(set) var off: String? // why the freeze is off for this session; nil: on
    private(set) var failedInARow = 0
    private(set) var watchdogs = 0 // watchdog reveals this session (counted, not a failure)
    private(set) var lastRevealAt: Double?
    private(set) var lastWatchdogAt: Double?

    var on: Bool { off == nil }

    init() {}
    // Off from the start when the launch check didn't pass the freeze calls.
    init(availability: PrivateCalls.Availability) {
        if !availability.freeze { off = "missing at launch (\(availability.reasons["freeze"] ?? "not checked"))" }
    }

    // A report, at the delegate's clock. Returns the line it logged, if any.
    @discardableResult mutating func note(_ report: FreezeReport, at now: Double) -> String? {
        var line: String?
        switch report {
        case .froze:
            failedInARow = 0
        case .freezeFailed(let result):
            failedInARow += 1
            if failedInARow >= Self.failedFreezesToTurnOff, on {
                line = turnOff("SLSNewTransition answered \(result) on \(failedInARow) switches in a row")
            } else {
                line = "handoff: freeze failed (result \(result)): this switch runs without one"
            }
        case .revealed(let handle, let why, let heldMs):
            lastRevealAt = now
            if why == .watchdog {
                watchdogs += 1
                lastWatchdogAt = now
                line = "handoff: watchdog revealed freeze \(handle) at \(heldMs) ms (\(watchdogs) this session)"
            }
        case .revealFailed(let handle, let why, let result, let released, let heldMs):
            lastRevealAt = now
            if why == .watchdog {
                watchdogs += 1
                lastWatchdogAt = now
            }
            let release = released.map { "released, result \($0)" } ?? "not released"
            line = turnOff("the reveal of freeze \(handle) (\(why.rawValue), \(heldMs) ms) answered \(result); \(release)")
        }
        if let line { Diagnostics.note(line) }
        return line
    }

    private mutating func turnOff(_ why: String) -> String {
        off = why
        return "private calls: freeze off for this session: \(why)"
    }
}

// ---- the real one ----

// The freeze calls behind the lock, the watchdog on its own queue. Nonisolated: the watchdog
// reveals from the queue, never waiting for the main thread.
nonisolated final class FreezeCore: @unchecked Sendable {
    private struct Live {
        let handle: Int32
        let at: TimeInterval // systemUptime
        let timer: DispatchSourceTimer
    }

    private let sky: SkyLight
    private let queue = DispatchQueue(label: "io.tirth.margin.freezer", qos: .userInteractive)
    private let lock = NSLock()
    private var live: Live?

    init(sky: SkyLight) { self.sky = sky }

    // Never leave the screen held: a freezer that goes away reveals what it holds.
    deinit { _ = reveal(.quit) }

    var isLive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return live != nil
    }

    // `onWatchdog` hears the watchdog's reveal, on the freezer's queue.
    func freeze(watchdog: TimeInterval, onWatchdog: @escaping @Sendable (FreezeReport) -> Void) -> (FreezeResult, FreezeReport?) {
        lock.lock()
        defer { lock.unlock() }
        guard live == nil else { return (.unavailable("a freeze is already live"), nil) }
        guard let made = sky.freeze() else { return (.unavailable("the freeze calls refused"), nil) }
        guard made.result == 0 else { return (.failed(made.result), .freezeFailed(result: made.result)) }
        let handle = made.handle
        // Strict: no coalescing, so the timer isn't pushed toward macOS's own 2 s.
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(Int((watchdog * 1000).rounded())), leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in
            // Only this freeze: a later one has its own timer.
            guard let self, case (_, let report?) = self.reveal(.watchdog, only: handle) else { return }
            onWatchdog(report)
        }
        live = Live(handle: handle, at: ProcessInfo.processInfo.systemUptime, timer: timer)
        timer.resume()
        return (.frozen(handle: handle), .froze(handle: handle))
    }

    // The lock is held through the calls, so a reveal and the next freeze never overlap in SkyLight.
    func reveal(_ why: RevealWhy, only handle: Int32? = nil) -> (RevealResult, FreezeReport?) {
        lock.lock()
        defer { lock.unlock() }
        guard let held = live, handle == nil || handle == held.handle else { return (.notLive, nil) }
        live = nil
        held.timer.cancel()
        let heldMs = Int(((ProcessInfo.processInfo.systemUptime - held.at) * 1000).rounded())
        // nil can't come from the wrappers that made this freeze; it counts as a failed reveal.
        let result = sky.reveal(held.handle) ?? -1
        guard result != 0 else { return (.revealed, .revealed(handle: held.handle, why: why, heldMs: heldMs)) }
        let released = sky.release(held.handle)
        return (.failed(result, released: released), .revealFailed(handle: held.handle, why: why, result: result, released: released, heldMs: heldMs))
    }
}

final class RealFreezer: Freezer {
    weak var delegate: FreezerDelegate?
    let options: FreezerOptions
    let refuses: Bool
    private let core: FreezeCore?

    // skyLight: Shell.skyLight (nil, or without the freeze calls: every freeze is `unavailable`).
    // refusing: always true under MARGIN_APP_TESTS, except in the test that runs it against its
    // own fake functions.
    init(skyLight: SkyLight?, options: FreezerOptions = FreezerOptions(), refusing: Bool = PrivateCalls.inTests) {
        self.options = options
        refuses = refusing
        core = skyLight.map { FreezeCore(sky: $0) }
    }

    var isLive: Bool { core?.isLive ?? false }

    func freeze(watchdog: TimeInterval?) -> FreezeResult {
        guard !refuses else { return .unavailable("refused under MARGIN_APP_TESTS") }
        guard let core else { return .unavailable("no freeze calls") }
        let (result, report) = core.freeze(watchdog: watchdog ?? options.watchdog) { [weak self] report in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.tell(report) } }
        }
        if let report { tell(report) }
        return result
    }

    @discardableResult func reveal(_ why: RevealWhy) -> RevealResult {
        guard !refuses, let core else { return .notLive }
        let (result, report) = core.reveal(why)
        if let report { tell(report) }
        return result
    }

    private func tell(_ report: FreezeReport) { delegate?.freezer(self, reported: report) }
}

// ---- the stand-in ----

// The tests' and the harness's: no private call, results scripted per call, and the watchdog on
// a SwitchClock. Handles count up from 1. Its watchdog keeps the real one's order: the reveal at
// once (`isLive` false, a reveal then `notLive`), its report `watchdogReportLag` later, as the real
// one's reaches the main actor after it was made on the freezer's queue.
final class FakeFreezer: Freezer {
    weak var delegate: FreezerDelegate?
    var options: FreezerOptions
    var watchdogReportLag: Double = 0.001
    var unavailable: String? // set: every freeze is `unavailable` with this reason
    // Each call takes the next result; an empty list answers 0.
    var freezeResults: [Int32] = []
    var revealResults: [Int32] = []
    var releaseResults: [Int32] = []
    private(set) var calls: [String] = [] // "freeze 1 (1.7 s)", "reveal 1 ready", "release 1", in order
    private(set) var reports: [FreezeReport] = []
    var onReveal: ((RevealWhy) -> Void)? // each reveal asked, as it's made (a test's clock can move in it, as time does in the real call)

    private let clock: SwitchClock
    private var live: (handle: Int32, at: Double, timer: SwitchTimer)?
    private var nextHandle: Int32 = 1

    init(clock: SwitchClock, options: FreezerOptions = FreezerOptions()) {
        self.clock = clock
        self.options = options
    }

    var isLive: Bool { live != nil }

    func freeze(watchdog: TimeInterval?) -> FreezeResult {
        if let unavailable { return .unavailable(unavailable) }
        guard live == nil else { return .unavailable("a freeze is already live") }
        let seconds = watchdog ?? options.watchdog
        let result = freezeResults.isEmpty ? 0 : freezeResults.removeFirst()
        calls.append("freeze \(seconds) s: \(result)")
        guard result == 0 else {
            tell(.freezeFailed(result: result))
            return .failed(result)
        }
        let handle = nextHandle
        nextHandle += 1
        let timer = clock.after(seconds) { [weak self] in
            guard let self, self.live?.handle == handle, let report = self.take(.watchdog).1 else { return }
            _ = self.clock.after(self.watchdogReportLag) { [weak self] in self?.tell(report) }
        }
        live = (handle, clock.now(), timer)
        tell(.froze(handle: handle))
        return .frozen(handle: handle)
    }

    @discardableResult func reveal(_ why: RevealWhy) -> RevealResult {
        onReveal?(why)
        let (result, report) = take(why)
        if let report { tell(report) }
        return result
    }

    // The live freeze revealed (released after a nonzero answer), and what to report; nothing told.
    private func take(_ why: RevealWhy) -> (RevealResult, FreezeReport?) {
        guard let held = live else { return (.notLive, nil) }
        live = nil
        held.timer.cancel()
        let heldMs = Int(((clock.now() - held.at) * 1000).rounded())
        let result = revealResults.isEmpty ? 0 : revealResults.removeFirst()
        calls.append("reveal \(held.handle) \(why.rawValue): \(result)")
        guard result != 0 else { return (.revealed, .revealed(handle: held.handle, why: why, heldMs: heldMs)) }
        let released = releaseResults.isEmpty ? 0 : releaseResults.removeFirst()
        calls.append("release \(held.handle): \(released)")
        return (.failed(result, released: released), .revealFailed(handle: held.handle, why: why, result: result, released: released, heldMs: heldMs))
    }

    private func tell(_ report: FreezeReport) {
        reports.append(report)
        delegate?.freezer(self, reported: report)
    }
}
