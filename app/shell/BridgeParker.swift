// Parking a window (app/HANDOFF.md §2.1, §3.1, §4.3): hiding another
// process's window (Safari's) in a private Space Margin made for it, alive,
// normal and out of every user Space, then showing it again or sending it back
// to its display's Desktop. Through SkyLight's window-management bridge, the
// only form that moved Safari's windows across processes in the labs.
//
// - park(n): a new private Space for this window (SLSSpaceCreate), the
//   add/remove op into it (options 7), then verified within 300 ms: in no user
//   Space and off screen.
// - show(n): the add/remove op into the active Space, the removal op out of its
//   private Space, verified (in the active Space), then the private Space
//   destroyed. Also shows a normal window on another Space (§1.5 rule 5): with
//   no private Space, only the first op.
// - returnToDesktop(n): the same, into its display's Desktop (type 0) Space.
// - A verify that fails is sent once more (§4.3); a second failure is the
//   caller's to act on (parking off for the session, §4.4). A park or show that
//   didn't land keeps its private Space on record: the window may still be in
//   it, and a later show or return takes it out and destroys it.
// - One step at a time per window: a second one while one runs is `busy`.
// - The parker never decides whether to park, and never logs a success: the
//   registry (WP4) logs each window's line. It logs its retries and failures,
//   with window numbers, Space ids and milliseconds only.
//
// The cross-process self-test (§4.2) is here too: at launch Margin.app starts
// its own binary as `Margin --park-probe`, which shows one hidden 1×1 window
// and prints its number; the parent parks, shows, parks again and returns that
// window, verifying each step, then ends the child. A failure means parking is
// off. The child never runs under MARGIN_APP_TESTS.

import AppKit

nonisolated enum ParkStep: String, Sendable {
    case park, show
    case returnToDesktop = "return"
}

nonisolated enum ParkFailure: Equatable, Sendable {
    case unavailable(String) // nothing called: parking off, or refused in tests
    case busy // a step for this window is already under way
    case gone // the window isn't listed by the window server
    case noSpace // SLSSpaceCreate answered 0
    case noTarget(String) // no active Space, or no Desktop, to send it to
    case notSent // the bridge's op couldn't be made
    case notLanded(spaces: [UInt64]?, onScreen: Bool?) // not verified after the retry: what the last reads said
}

nonisolated struct ParkOutcome: Equatable, Sendable {
    let number: Int
    let step: ParkStep
    let failure: ParkFailure?
    let ms: Int // from the first op sent to verified, or to giving up
    let tries: Int // ops sent: 1, or 2 after a retry (0: nothing sent)
    let space: UInt64? // park: its private Space; show and return: the Space it went to
    var ok: Bool { failure == nil }
}

protocol BridgeParker: AnyObject {
    // Parking passed the launch check, and nothing refuses. (Whether the self-test passed is the
    // shell's: Shell.parkingOn.)
    var isAvailable: Bool { get }
    // Each window's private Space, while it has one: parked, or a park or show that didn't land.
    var privateSpaces: [Int: UInt64] { get }
    func isBusy(_ number: Int) -> Bool
    func park(_ number: Int, done: @escaping (ParkOutcome) -> Void)
    func show(_ number: Int, done: @escaping (ParkOutcome) -> Void)
    func returnToDesktop(_ number: Int, done: @escaping (ParkOutcome) -> Void)
    // Destroys this window's private Space and forgets it: the window is gone (§6.3), or a show
    // that didn't land (§4.4, "destroy B's own private Space only"). False when it had none.
    @discardableResult func destroySpace(of number: Int) -> Bool
}

nonisolated struct ParkerOptions: Sendable {
    var verifyWithin: Double = 0.3 // §4.3: each op's verify
    var poll: Double = 0.004 // the labs polled every 2 ms; each read is 0.1-0.3 ms
    var tries = 2 // the op, and one retry
}

// ---- the real one: the bridge and the Space reads (SkyLightSpaces), or a test's fake world ----

final class SpaceParker: BridgeParker {
    let options: ParkerOptions
    private let reads: SpaceReads
    private let bridge: SpaceBridge
    private let clock: SwitchClock
    private(set) var privateSpaces: [Int: UInt64] = [:]
    private var busy: Set<Int> = []

    init(reads: SpaceReads, bridge: SpaceBridge, clock: SwitchClock, options: ParkerOptions = ParkerOptions()) {
        self.reads = reads
        self.bridge = bridge
        self.clock = clock
        self.options = options
    }

    var isAvailable: Bool { bridge.canPark }
    func isBusy(_ number: Int) -> Bool { busy.contains(number) }

    func park(_ number: Int, done: @escaping (ParkOutcome) -> Void) {
        guard let start = begin(number, .park, done) else { return }
        // Only a listed window: a number that's gone would read as parked at once.
        guard reads.window(number) != nil else { return start.finish(.gone) }
        let space: UInt64
        var made = false
        if let kept = privateSpaces[number] {
            space = kept
        } else if let new = bridge.createSpace() {
            space = new
            made = true
            privateSpaces[number] = new
        } else {
            return start.finish(.noSpace)
        }
        // Parked: in no user Space, and off screen. A parked window the window server doesn't list
        // (gate G6) reads as off screen, as the labs read it.
        run(start, to: space, send: { [bridge] in bridge.add(number, to: space) },
            landed: { [reads] in reads.readsParked(number) == true },
            notSent: { [weak self] in
                // Nothing reached the window: a Space made for this park isn't needed.
                guard made, let self else { return }
                _ = self.bridge.destroySpace(space)
                self.privateSpaces[number] = nil
            }, landedThen: {})
    }

    func show(_ number: Int, done: @escaping (ParkOutcome) -> Void) {
        guard let start = begin(number, .show, done) else { return }
        guard let active = reads.activeSpace() else { return start.finish(.noTarget("the active Space didn't read")) }
        out(start, to: active)
    }

    func returnToDesktop(_ number: Int, done: @escaping (ParkOutcome) -> Void) {
        guard let start = begin(number, .returnToDesktop, done) else { return }
        guard let desktop = reads.desktop(for: number) else { return start.finish(.noTarget("no Desktop read for its display")) }
        out(start, to: desktop)
    }

    @discardableResult func destroySpace(of number: Int) -> Bool {
        guard let space = privateSpaces.removeValue(forKey: number) else { return false }
        if !bridge.destroySpace(space) { Diagnostics.note("handoff: window \(number)'s private Space \(space) wasn't destroyed (the call refused)") }
        return true
    }

    // Show and return: into `target`, out of its private Space; verified in `target`; then that
    // private Space destroyed.
    private func out(_ start: Start, to target: UInt64) {
        let number = start.number
        let from = privateSpaces[number]
        run(start, to: target, send: { [bridge] in
            let sent = bridge.add(number, to: target)
            if sent, let from { _ = bridge.remove(number, from: from) }
            return sent
        }, landed: { [reads] in reads.spaces(of: number)?.contains(target) == true },
        notSent: {}, landedThen: { [weak self] in
            guard let self, let from, self.privateSpaces[number] == from else { return }
            self.destroySpace(of: number)
        })
    }

    // ---- one step: send, poll, retry once ----

    private struct Start {
        let number: Int
        let step: ParkStep
        let done: (ParkOutcome) -> Void
        let release: () -> Void
        func finish(_ failure: ParkFailure?, ms: Int = 0, tries: Int = 0, space: UInt64? = nil) {
            release()
            done(ParkOutcome(number: number, step: step, failure: failure, ms: ms, tries: tries, space: space))
        }
    }

    private func begin(_ number: Int, _ step: ParkStep, _ done: @escaping (ParkOutcome) -> Void) -> Start? {
        guard bridge.canPark else {
            done(ParkOutcome(number: number, step: step, failure: .unavailable("parking is off"), ms: 0, tries: 0, space: nil))
            return nil
        }
        guard !busy.contains(number) else {
            done(ParkOutcome(number: number, step: step, failure: .busy, ms: 0, tries: 0, space: nil))
            return nil
        }
        busy.insert(number)
        return Start(number: number, step: step, done: done, release: { [weak self] in self?.busy.remove(number) })
    }

    private func run(_ start: Start, to space: UInt64, send: @escaping () -> Bool, landed: @escaping () -> Bool,
                     notSent: @escaping () -> Void, landedThen: @escaping () -> Void) {
        let began = clock.now()
        func ms() -> Int { Int(((clock.now() - began) * 1000).rounded()) }
        func attempt(_ tries: Int) {
            guard send() else {
                guard tries > 1 else {
                    notSent()
                    return start.finish(.notSent, ms: ms(), tries: 0)
                }
                // The retry couldn't be made, but the first op went out: the bridge's ops are
                // asynchronous, so it may still land. Not landed, never "nothing sent": its Space is
                // kept, and the caller takes the window out of it (§4.4).
                let spaces = reads.spaces(of: start.number)
                let onScreen = reads.window(start.number)?.onScreen
                Diagnostics.note("handoff: window \(start.number)'s \(start.step.rawValue) retry couldn't be sent, after \(ms()) ms")
                return start.finish(.notLanded(spaces: spaces, onScreen: onScreen), ms: ms(), tries: tries - 1, space: space)
            }
            let sent = clock.now()
            poll(tries: tries, sent: sent)
        }
        func poll(tries: Int, sent: Double) {
            clock.after(options.poll) { [weak self] in
                guard let self else { return }
                if landed() {
                    landedThen()
                    return start.finish(nil, ms: ms(), tries: tries, space: space)
                }
                // A tiny allowance: the fake clock's polls add up to a hair under 300 ms.
                guard self.clock.now() - sent >= self.options.verifyWithin - 1e-6 else { return poll(tries: tries, sent: sent) }
                let spaces = self.reads.spaces(of: start.number)
                let onScreen = self.reads.window(start.number)?.onScreen
                let read = "spaces \(spaces.map { "\($0)" } ?? "unknown"), on screen \(onScreen.map { "\($0)" } ?? "unknown")"
                let within = Int((self.options.verifyWithin * 1000).rounded())
                if tries < self.options.tries {
                    Diagnostics.note("handoff: window \(start.number)'s \(start.step.rawValue) didn't land in \(within) ms (\(read)): sent once more")
                    return attempt(tries + 1)
                }
                Diagnostics.note("handoff: window \(start.number)'s \(start.step.rawValue) didn't land after \(tries) tries in \(ms()) ms (\(read))")
                start.finish(.notLanded(spaces: spaces, onScreen: onScreen), ms: ms(), tries: tries, space: space)
            }
        }
        attempt(1)
    }
}

// ---- the stand-in ----

// The tests' and the harness's (WP8's machine, WP9's end-to-end run): no private call and no
// Space reads, results scripted per step, on a SwitchClock. Each park makes a new private Space
// (ids count up from 9001); a show or return that lands destroys it.
final class FakeParker: BridgeParker {
    enum Script: Equatable {
        case lands
        case landsOnRetry // the first op doesn't land; the retry does
        case fails(ParkFailure) // a .notLanded failure comes after both tries
    }

    var isAvailable = true
    var options: ParkerOptions
    var lag: [ParkStep: Double] = [.park: 0.004, .show: 0.015, .returnToDesktop: 0.014] // STP's times
    var scripts: [ParkStep: [Script]] = [:] // each call takes the next; none left: it lands
    var activeSpace: UInt64 = 1
    var desktop: UInt64 = 1
    var nextSpace: UInt64 = 9001
    private(set) var privateSpaces: [Int: UInt64] = [:]
    private(set) var destroyed: [UInt64] = []
    private(set) var location: [Int: UInt64] = [:] // where each window is now: its private Space, or a user Space
    private(set) var calls: [String] = [] // "park 5", "show 5", "return 5", "destroy 9001", in order
    private(set) var outcomes: [ParkOutcome] = []
    private var busy: Set<Int> = []
    private let clock: SwitchClock

    init(clock: SwitchClock, options: ParkerOptions = ParkerOptions()) {
        self.clock = clock
        self.options = options
    }

    func isBusy(_ number: Int) -> Bool { busy.contains(number) }
    func isParked(_ number: Int) -> Bool { privateSpaces[number].map { location[number] == $0 } ?? false }

    // A parked window back in a user Space by itself (a Dock restart, Margin gone, §2.6): its
    // private Space is still there.
    func comeBack(_ number: Int, to space: UInt64) { location[number] = space }

    func park(_ number: Int, done: @escaping (ParkOutcome) -> Void) {
        step(number, .park, done) { [self] in
            if let kept = privateSpaces[number] { return kept }
            let space = nextSpace
            nextSpace += 1
            privateSpaces[number] = space
            return space
        } landed: { [self] space in location[number] = space }
    }

    func show(_ number: Int, done: @escaping (ParkOutcome) -> Void) {
        step(number, .show, done) { [self] in activeSpace } landed: { [self] space in moved(number, to: space) }
    }

    func returnToDesktop(_ number: Int, done: @escaping (ParkOutcome) -> Void) {
        step(number, .returnToDesktop, done) { [self] in desktop } landed: { [self] space in moved(number, to: space) }
    }

    @discardableResult func destroySpace(of number: Int) -> Bool {
        guard let space = privateSpaces.removeValue(forKey: number) else { return false }
        destroyed.append(space)
        calls.append("destroy \(space)")
        // A window still in it is in no Space at all.
        if location[number] == space { location[number] = nil }
        return true
    }

    private func moved(_ number: Int, to space: UInt64) {
        location[number] = space
        destroySpace(of: number)
    }

    private func step(_ number: Int, _ step: ParkStep, _ done: @escaping (ParkOutcome) -> Void,
                      target: () -> UInt64, landed: @escaping (UInt64) -> Void) {
        calls.append("\(step.rawValue) \(number)")
        func answer(_ outcome: ParkOutcome) {
            outcomes.append(outcome)
            done(outcome)
        }
        guard isAvailable else { return answer(ParkOutcome(number: number, step: step, failure: .unavailable("parking is off"), ms: 0, tries: 0, space: nil)) }
        guard !busy.contains(number) else { return answer(ParkOutcome(number: number, step: step, failure: .busy, ms: 0, tries: 0, space: nil)) }
        let script = scripts[step]?.isEmpty == false ? scripts[step]!.removeFirst() : .lands
        if case .fails(let failure) = script, !Self.afterTries(failure) {
            // Failures before any op (gone, no Space, no target, not sent): at once.
            return answer(ParkOutcome(number: number, step: step, failure: failure, ms: 0, tries: 0, space: nil))
        }
        let space = target()
        let lag = self.lag[step] ?? 0
        let wait: Double
        let tries: Int
        switch script {
        case .lands: (wait, tries) = (lag, 1)
        case .landsOnRetry: (wait, tries) = (options.verifyWithin + lag, 2)
        case .fails: (wait, tries) = (options.verifyWithin * Double(options.tries), options.tries)
        }
        busy.insert(number)
        clock.after(wait) { [weak self] in
            guard let self else { return }
            self.busy.remove(number)
            let ms = Int((wait * 1000).rounded())
            if case .fails(let failure) = script {
                return answer(ParkOutcome(number: number, step: step, failure: failure, ms: ms, tries: tries, space: space))
            }
            landed(space)
            answer(ParkOutcome(number: number, step: step, failure: nil, ms: ms, tries: tries, space: space))
        }
    }

    private static func afterTries(_ failure: ParkFailure) -> Bool {
        if case .notLanded = failure { return true }
        return false
    }
}

// ---- the cross-process self-test (§4.2) ----

nonisolated enum ParkProbe {
    static let argument = "--park-probe"
    static let prefix = "park-probe window "
    // The child ends by itself after this, whatever its parent does.
    static let childLimit: TimeInterval = 10

    // Started as the self-test's child: the argument after the executable's path.
    static func isChild(_ arguments: [String]) -> Bool { arguments.dropFirst().contains(argument) }

    // The one line the child prints, and the parent's reading of it.
    static func line(number: Int) -> String { prefix + String(number) }
    static func number(fromLine line: String) -> Int? {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(prefix), let n = Int(text.dropFirst(prefix.count)), n > 0, n <= Int(UInt32.max) else { return nil }
        return n
    }

    // The child: one borderless 1×1 window at alpha 0, far off screen, ordered in without the app
    // ever activating; its number on stdout; then it waits on stdin and ends at its end (the
    // parent's close, or the parent gone) or after childLimit. No shell, no set-up window, no log.
    @MainActor static func runChild() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 1, height: 1), styleMask: [.borderless], backing: .buffered, defer: false)
        window.alphaValue = 0
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.isReleasedWhenClosed = false
        window.isExcludedFromWindowsMenu = true
        window.tabbingMode = .disallowed
        // An ordinary managed window, in a user Space, as Safari's are; never in ⌘` or Exposé's cycle.
        window.collectionBehavior = [.managed, .ignoresCycle]
        window.orderFrontRegardless()
        window.setFrameOrigin(NSPoint(x: -3000, y: -3000))
        FileHandle.standardOutput.write(Data((line(number: window.windowNumber) + "\n").utf8))
        DispatchQueue.global(qos: .userInitiated).async {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            exit(0)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + childLimit) { exit(0) }
        app.run()
        exit(0)
    }
}

// The child, as the self-test sees it: started, its window number heard once, ended.
protocol ProbeChild: AnyObject {
    var pid: pid_t? { get }
    // `number` is called once, on the main actor: the window number, or nil (it couldn't start,
    // ended, or printed something else).
    func start(_ number: @escaping (Int?) -> Void)
    func end()
}

// The real child: this app's own binary with --park-probe. Refuses under MARGIN_APP_TESTS.
final class ProcessProbeChild: ProbeChild {
    private let executable: URL?
    private let refuses: Bool
    private var process: Process?
    private var input: Pipe?
    private var heard: ((Int?) -> Void)?

    init(executable: URL? = Bundle.main.executableURL, refusing: Bool = PrivateCalls.inTests) {
        self.executable = executable
        refuses = refusing
    }

    var pid: pid_t? { process.map(\.processIdentifier) }

    func start(_ number: @escaping (Int?) -> Void) {
        guard !refuses, let executable else { return number(nil) }
        heard = number
        let p = Process()
        p.executableURL = executable
        p.arguments = [ParkProbe.argument]
        let input = Pipe()
        let output = Pipe()
        p.standardInput = input
        p.standardOutput = output
        p.standardError = FileHandle.nullDevice
        let lines = ProbeLines()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            let line = data.isEmpty ? "" : lines.add(data)
            guard data.isEmpty || line != nil else { return }
            handle.readabilityHandler = nil
            let number = line.flatMap(ParkProbe.number(fromLine:))
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.say(number) } }
        }
        p.terminationHandler = { [weak self] _ in DispatchQueue.main.async { MainActor.assumeIsolated { self?.say(nil) } } }
        do {
            try p.run()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            return say(nil)
        }
        process = p
        self.input = input
    }

    // Its stdin closed: the child exits. Still running a second later, it's ended.
    func end() {
        heard = nil
        try? input?.fileHandleForWriting.close()
        input = nil
        guard let p = process else { return }
        process = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if p.isRunning { p.terminate() } }
    }

    private func say(_ number: Int?) {
        guard let heard else { return }
        self.heard = nil
        heard(number)
    }
}

// The child's output, read on the pipe's own queue, up to its first line.
nonisolated final class ProbeLines: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    func add(_ data: Data) -> String? {
        lock.lock()
        defer { lock.unlock() }
        bytes.append(data)
        guard let end = bytes.firstIndex(of: 0x0A) else { return bytes.count > 256 ? "" : nil }
        return String(decoding: bytes[bytes.startIndex..<end], as: UTF8.self)
    }
}

final class ParkSelfTest {
    struct Times: Equatable {
        var shown = 0 // from the child's number to its window in a user Space
        var park = 0, show = 0, parkAgain = 0, returned = 0
    }
    enum Outcome: Equatable {
        case notRun
        case running
        case passed(Times)
        case failed(String)
        var passed: Bool { if case .passed = self { return true } else { return false } }
    }

    static let numberWithin: Double = 3 // starting an app's binary takes a few hundred ms
    static let shownWithin: Double = 0.3

    private let parker: BridgeParker
    private let reads: SpaceReads
    private let child: ProbeChild
    private let clock: SwitchClock
    private var finished = false
    private var number: Int?
    private(set) var childPid: pid_t? // kept for the log line: the child is gone by then
    private var times = Times()
    private var done: ((Outcome) -> Void)?

    init(parker: BridgeParker, reads: SpaceReads, child: ProbeChild, clock: SwitchClock) {
        self.parker = parker
        self.reads = reads
        self.child = child
        self.clock = clock
    }

    // Park, show, park again and return the child's window, each verified by the parker. The
    // second park makes the return start from a private Space, as every real return does.
    func run(_ done: @escaping (Outcome) -> Void) {
        guard parker.isAvailable else { return done(.failed("parking is off")) }
        self.done = done
        clock.after(Self.numberWithin) { [weak self] in
            guard let self, self.number == nil else { return }
            self.fail("the child gave no window number in \(Int(Self.numberWithin)) s")
        }
        child.start { [weak self] number in
            guard let self, !self.finished else { return }
            guard let number else { return self.fail("the child ended or gave no window number") }
            self.number = number
            self.childPid = self.child.pid
            self.waitShown(number, since: self.clock.now())
        }
    }

    private func waitShown(_ number: Int, since: Double) {
        if reads.spaces(of: number)?.isEmpty == false {
            times.shown = Int(((clock.now() - since) * 1000).rounded())
            return steps(number)
        }
        guard clock.now() - since < Self.shownWithin - 1e-6 else { return fail("the child's window \(number) was in no Space after \(Int(Self.shownWithin * 1000)) ms") }
        clock.after(0.004) { [weak self] in
            guard let self, !self.finished else { return }
            self.waitShown(number, since: since)
        }
    }

    private func steps(_ number: Int) {
        parker.park(number) { [weak self] o in
            guard let self, self.check(o, \.park) else { return }
            self.parker.show(number) { [weak self] o in
                guard let self, self.check(o, \.show) else { return }
                self.parker.park(number) { [weak self] o in
                    guard let self, self.check(o, \.parkAgain) else { return }
                    self.parker.returnToDesktop(number) { [weak self] o in
                        guard let self, self.check(o, \.returned) else { return }
                        self.finish(.passed(self.times))
                    }
                }
            }
        }
    }

    private func check(_ o: ParkOutcome, _ time: WritableKeyPath<Times, Int>) -> Bool {
        guard !finished else { return false }
        guard o.ok else {
            fail("the \(o.step.rawValue) of its window \(o.number) \(Self.describe(o.failure)) (\(o.tries) tr\(o.tries == 1 ? "y" : "ies"), \(o.ms) ms)")
            return false
        }
        times[keyPath: time] = o.ms
        return true
    }

    private func fail(_ why: String) { finish(.failed(why)) }

    private func finish(_ outcome: Outcome) {
        guard !finished else { return }
        finished = true
        // The window goes with the child; a private Space left over doesn't.
        if let number { parker.destroySpace(of: number) }
        child.end()
        let done = self.done
        self.done = nil
        done?(outcome)
    }

    static func describe(_ failure: ParkFailure?) -> String {
        switch failure {
        case nil: return "landed"
        case .unavailable(let why)?: return "wasn't run (\(why))"
        case .busy?: return "was refused: another step was under way"
        case .gone?: return "found no such window"
        case .noSpace?: return "got no private Space"
        case .noTarget(let why)?: return "had nowhere to go: \(why)"
        case .notSent?: return "couldn't be sent"
        case .notLanded(let spaces, let onScreen)?:
            return "didn't land (spaces \(spaces.map { "\($0)" } ?? "unknown"), on screen \(onScreen.map { "\($0)" } ?? "unknown"))"
        }
    }

    // The launch's line (HANDOFF.md §8.1), after PrivateCalls' own.
    static func line(_ outcome: Outcome, pid: pid_t?) -> String {
        switch outcome {
        case .passed(let t):
            return "private calls: cross-process self-test park \(t.park) ms, show \(t.show) ms, park again \(t.parkAgain) ms, return \(t.returned) ms (the child's window in a Space in \(t.shown) ms\(pid.map { ", pid \($0)" } ?? ""))"
        case .failed(let why):
            return "private calls: park off: the cross-process self-test failed: \(why)"
        case .notRun, .running:
            return "private calls: the cross-process self-test hasn't run"
        }
    }
}

extension Shell {
    // At launch, after checkPrivateCalls (AppDelegate.startShell): the cross-process self-test.
    // Parking stays off (parkingOn false) until it passes. Nothing to test without a parker.
    func selfTestParking(child: ProbeChild = ProcessProbeChild()) {
        guard let parker, let spaceReads, case .notRun = parkSelfTest else { return }
        parkSelfTest = .running
        let test = ParkSelfTest(parker: parker, reads: spaceReads, child: child, clock: options.switchClock)
        parkSelfTestRun = test
        test.run { [weak self] outcome in
            guard let self else { return }
            self.parkSelfTest = outcome
            self.parkSelfTestRun = nil
            Diagnostics.note(ParkSelfTest.line(outcome, pid: test.childPid))
            // A crash's parked windows parked again, now that it's known whether parking works (§13.2).
            self.recoverParked()
        }
    }
}
