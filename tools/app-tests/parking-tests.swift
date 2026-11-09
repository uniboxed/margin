// Parking (app/HANDOFF.md §2.1, §3.1, §4.2, §4.3), part of tests.swift's run.
// No real private function is called here, nothing is spawned, and the
// window server is never read.
//
// The Space reads (SpaceReads.swift): SLSCopyManagedDisplaySpaces' answer
// parsed (Desktops, full-screen Spaces, the display count, an odd shape read as
// unknown), the window server's read of one window, each display's Desktop,
// and FakeSpaceWorld's nil reads. The parker (BridgeParker.swift): SpaceParker
// over FakeSpaceWorld on the fake clock (a private Space per window, made at its
// park and destroyed after its show or return; the retry, then success or
// failure, with the Space kept; unknown reads; gone, busy, no Space, parking
// off), and FakeParker's scripts. The cross-process self-test: the
// --park-probe argument and the child's line parsed, and ParkSelfTest's run
// against a stand-in child. SkyLightSpaces and the real child refusing under
// MARGIN_APP_TESTS, and the shell's wiring.
//
// The registry (Parking.swift), over SpaceParker and FakeSpaceWorld: keyed by
// number and never forgotten for a link down, held or a new copy; forgotten by
// liveness (only once the read has listed it), a pid gone, the same copy
// closing it (once it has listed it, or after its list's lag), or a number
// taken by another process; the hard rule's assertion; rebinding by
// elimination, by bounds, and left unbound; who caused a return (the system's
// re-parked or returned, never the person's; focus after Margin's own call or
// from before the park isn't theirs; the person's kept theirs until released);
// a failed show destroying only its window's Space; a park that didn't land,
// or whose retry couldn't be sent, returned; returnAll, quit and an end with
// no answers (closed by copies, the rest returned, 300 ms in all, nothing left
// closing); the bridge's ops kept by age; and the crash marker in a test folder:
// written, kept up to date, taken at launch, adopted after a crash, removed at
// quit.
import AppKit
import Foundation

// The self-test's child, played on the clock: its window appears in a Space, and its number is
// heard, after `after` seconds.
final class FakeProbeChild: ProbeChild {
    let world: FakeSpaceWorld
    let clock: FakeClock
    var number: Int? = 77
    var windowSpace: UInt64? = 1 // where its window shows; nil: in no Space
    var after = 0.2
    private(set) var started = 0
    private(set) var ended = 0
    init(world: FakeSpaceWorld, clock: FakeClock) { (self.world, self.clock) = (world, clock) }
    var pid: pid_t? { started > 0 ? 4242 : nil }
    func start(_ number: @escaping (Int?) -> Void) {
        started += 1
        _ = clock.after(after) { [self] in
            if let n = self.number {
                world.windows[n] = FakeSpaceWorld.Window(pid: 4242, bounds: CGRect(x: -3000, y: -3000, width: 1, height: 1), spaces: windowSpace.map { [$0] } ?? [])
            }
            number(self.number)
        }
    }
    func end() {
        ended += 1
        if let number { world.windows[number] = nil }
    }
}

func parkingTests() {
    let echo = Diagnostics.echo
    var said: [String] = []
    Diagnostics.echo = { said.append($0) }
    defer { Diagnostics.echo = echo }

    // ---- the self-test's argument and line ----
    check("parking: --park-probe after the executable is the child", ParkProbe.isChild(["/Applications/Margin.app/Contents/MacOS/Margin", "--park-probe"]))
    check("parking: no --park-probe, or only as argv[0]: not the child",
          !ParkProbe.isChild(["/Applications/Margin.app/Contents/MacOS/Margin"]) && !ParkProbe.isChild(["--park-probe"])
          && !ParkProbe.isChild(["/x/Margin", "--background"]) && !ParkProbe.isChild([]))
    check("parking: the child's line", ParkProbe.line(number: 18342) == "park-probe window 18342")
    check("parking: the parent reads it back, newline and all",
          ParkProbe.number(fromLine: "park-probe window 18342\n") == 18342 && ParkProbe.number(fromLine: ParkProbe.line(number: 1)) == 1)
    check("parking: anything else isn't a window number",
          [ "", "park-probe window", "park-probe window 0", "park-probe window -3", "park-probe window 12x", "window 5", "park-probe window 4294967296", "PARK-PROBE WINDOW 5" ]
            .allSatisfy { ParkProbe.number(fromLine: $0) == nil })

    // ---- SLSCopyManagedDisplaySpaces, parsed ----
    let oneDisplay: [[String: Any]] = [["Display Identifier": "Main", "Current Space": ["id64": 5, "type": 4],
                                        "Spaces": [["id64": 1, "type": 0], ["id64": 3, "type": 0], ["id64": 5, "type": 4]]]]
    if let d = FakeSpaceWorld.parseDisplays(oneDisplay)?.first {
        check("parking: a display's Desktops and full-screen Spaces", d.display == "Main" && d.desktops == [1, 3] && d.fullScreen == [5] && d.current == 5)
        check("parking: its Desktop while a full-screen Space shows: the first", d.desktop == 1)
        check("parking: its Desktop while a Desktop shows: that one", DisplaySpaces(display: "Main", current: 3, spaces: d.spaces).desktop == 3)
        check("parking: no Desktop at all: none", DisplaySpaces(display: "x", current: 5, spaces: [ManagedSpace(id: 5, type: 4)]).desktop == nil)
    } else { check("parking: one display parses", false) }
    check("parking: two displays: two entries", FakeSpaceWorld.parseDisplays(oneDisplay + [["Display Identifier": "B", "Spaces": [["id64": 9, "type": 0]]]])?.count == 2)
    check("parking: no displays: an empty list, not unknown", FakeSpaceWorld.parseDisplays([])?.isEmpty == true)
    check("parking: an entry with no identifier, no Spaces, or a Space with no id or type: unknown",
          FakeSpaceWorld.parseDisplays([["Spaces": []]]) == nil && FakeSpaceWorld.parseDisplays([["Display Identifier": "Main"]]) == nil
          && FakeSpaceWorld.parseDisplays([["Display Identifier": "Main", "Spaces": [["type": 0]]]]) == nil
          && FakeSpaceWorld.parseDisplays([["Display Identifier": "Main", "Spaces": [["id64": 1]]]]) == nil)

    // The window server's read of one window.
    let listed: [[String: Any]] = [
        [kCGWindowNumber as String: 4, kCGWindowOwnerPID as String: 10, kCGWindowBounds as String: ["X": 0, "Y": 0, "Width": 5, "Height": 5]],
        [kCGWindowNumber as String: 18342, kCGWindowOwnerPID as String: 501, kCGWindowLayer as String: 0, kCGWindowIsOnscreen as String: true,
         kCGWindowAlpha as String: 1, kCGWindowBounds as String: ["X": 10, "Y": 30, "Width": 1200, "Height": 800]],
    ]
    let w = FakeSpaceWorld.parseWindow(listed, number: 18342)
    check("parking: one window's read: its pid, bounds and on-screen flag",
          w?.pid == 501 && w?.bounds == CGRect(x: 10, y: 30, width: 1200, height: 800) && w?.onScreen == true, "\(String(describing: w))")
    check("parking: a window not in the list: nil", FakeSpaceWorld.parseWindow(listed, number: 7) == nil && FakeSpaceWorld.parseWindow([], number: 18342) == nil)
    check("parking: no on-screen flag reads as off screen", FakeSpaceWorld.parseWindow(listed, number: 4)?.onScreen == false)

    // ---- FakeSpaceWorld's reads, derived ones included ----
    func twoDisplays(_ clock: FakeClock) -> FakeSpaceWorld {
        let world = FakeSpaceWorld(clock: clock)
        world.active = 5
        world.displayList = [
            DisplaySpaces(display: "AAAA", current: 5, spaces: [ManagedSpace(id: 1, type: 0), ManagedSpace(id: 5, type: 4)]),
            DisplaySpaces(display: "BBBB", current: 8, spaces: [ManagedSpace(id: 8, type: 0), ManagedSpace(id: 9, type: 0)]),
        ]
        world.displayOf = ["AAAA": CGRect(x: 0, y: 0, width: 1512, height: 982), "BBBB": CGRect(x: 1512, y: 0, width: 1920, height: 1080)]
        world.windows[11] = .init(pid: 501, bounds: CGRect(x: 100, y: 100, width: 800, height: 600), spaces: [5])
        world.windows[12] = .init(pid: 501, bounds: CGRect(x: 1700, y: 100, width: 800, height: 600), spaces: [8])
        world.windows[13] = .init(pid: 501, bounds: CGRect(x: -3000, y: -3000, width: 1, height: 1), spaces: [5])
        return world
    }
    do {
        let world = twoDisplays(FakeClock())
        check("parking: the full-screen Spaces of every display, and the display count", world.fullScreenSpaces() == [5] && world.managedDisplayCount() == 2)
        check("parking: a window's Desktop is its own display's", world.desktop(for: 11) == 1 && world.desktop(for: 12) == 8)
        check("parking: a window on no display: the active Space's display's Desktop", world.desktop(for: 13) == 1 && world.desktop(for: 99) == 1)
        world.active = 9
        check("parking: … the active Space on the second display", world.desktop(for: 13) == 8)
        world.displayList = [world.displayList![1]]
        check("parking: one display: its Desktop for every window", world.desktop(for: 11) == 8 && world.managedDisplayCount() == 1)
        world.unknown = true
        check("parking: unknown reads: nil, never a guess",
              world.activeSpace() == nil && world.spaces(of: 11) == nil && world.displays() == nil && world.fullScreenSpaces() == nil
              && world.managedDisplayCount() == nil && world.desktop(for: 11) == nil && world.readsParked(11) == nil)
        world.unknown = false
        check("parking: a window in a user Space and on screen isn't parked", world.readsParked(12) == false)
        world.windows[12]?.spaces = []
        check("parking: in no Space and off screen is parked; so is a window not listed", world.readsParked(12) == true && world.readsParked(99) == true)
    }

    // ---- SpaceParker over the fake world ----
    func parker(_ clock: FakeClock, _ world: FakeSpaceWorld) -> SpaceParker { SpaceParker(reads: world, bridge: world, clock: clock) }
    func run(_ clock: FakeClock, _ body: (@escaping (ParkOutcome) -> Void) -> Void) -> ParkOutcome? {
        var got: ParkOutcome?
        body { got = $0 }
        clock.advance(2)
        return got
    }
    do {
        let clock = FakeClock()
        let world = twoDisplays(clock)
        let p = parker(clock, world)
        check("parking: available when the bridge is", p.isAvailable && p.options.verifyWithin == 0.3 && p.options.tries == 2)
        let parked = run(clock) { p.park(11, done: $0) }
        check("parking: park: its own private Space, the add/remove op into it", world.calls == ["create 2431", "add 11 → 2431"], "\(world.calls)")
        check("parking: park verified: in no user Space and off screen, first try",
              parked == ParkOutcome(number: 11, step: .park, failure: nil, ms: 4, tries: 1, space: 2431) && world.readsParked(11) == true, "\(String(describing: parked))")
        check("parking: its Space on record", p.privateSpaces == [11: 2431])
        _ = run(clock) { p.park(12, done: $0) }
        check("parking: a second window, its own Space", p.privateSpaces == [11: 2431, 12: 2432] && world.privateSpaces == [2431, 2432])
        let shown = run(clock) { p.show(11, done: $0) }
        check("parking: show: into the active Space, out of its private Space, then that Space destroyed",
              Array(world.calls.suffix(3)) == ["add 11 → 5", "remove 11 from 2431", "destroy 2431"], "\(world.calls)")
        check("parking: show verified in the active Space", shown?.ok == true && shown?.space == 5 && shown?.tries == 1 && world.spaces(of: 11) == [5])
        check("parking: only that window's Space destroyed", p.privateSpaces == [12: 2432] && world.destroyed == [2431])
        let back = run(clock) { p.returnToDesktop(12, done: $0) }
        check("parking: return: to its display's Desktop, out of its private Space, then destroyed",
              back?.ok == true && back?.space == 8 && Array(world.calls.suffix(3)) == ["add 12 → 8", "remove 12 from 2432", "destroy 2432"]
              && world.spaces(of: 12) == [8] && p.privateSpaces.isEmpty, "\(world.calls)")
        let plain = run(clock) { p.show(13, done: $0) }
        check("parking: show of a window with no private Space: the op only, nothing destroyed",
              plain?.ok == true && world.calls.last == "add 13 → 5" && world.destroyed == [2431, 2432], "\(world.calls)")
        check("parking: no line for a step that landed", said.isEmpty, "\(said)")
    }
    do {
        // The retry: once, then success.
        let clock = FakeClock()
        let world = twoDisplays(clock)
        let p = parker(clock, world)
        world.dropNext = 1
        let o = run(clock) { p.park(11, done: $0) }
        check("parking: a park that didn't land in 300 ms is sent once more, then lands",
              o?.ok == true && o?.tries == 2 && world.calls == ["create 2431", "add 11 → 2431", "add 11 → 2431"] && (o?.ms ?? 0) >= 300 && (o?.ms ?? 0) < 320, "\(String(describing: o)) \(world.calls)")
        check("parking: the retry's line: the window, the step and what the reads said",
              said == ["handoff: window 11's park didn't land in 300 ms (spaces [5], on screen true): sent once more"], "\(said)")
        said = []
        // A show retried sends both ops again.
        world.dropNext = 2
        let s = run(clock) { p.show(11, done: $0) }
        check("parking: a show retried: both ops again, then lands and destroys its Space",
              s?.ok == true && s?.tries == 2 && Array(world.calls.suffix(5)) == ["add 11 → 5", "remove 11 from 2431", "add 11 → 5", "remove 11 from 2431", "destroy 2431"], "\(world.calls)")
        said = []
    }
    do {
        // The retry, then failure: the Space kept, and the caller's to act on.
        let clock = FakeClock()
        let world = twoDisplays(clock)
        let p = parker(clock, world)
        world.dropNext = 2
        let o = run(clock) { p.park(11, done: $0) }
        check("parking: a park that didn't land twice: not landed, with the last reads",
              o?.failure == .notLanded(spaces: [5], onScreen: true) && o?.tries == 2 && (o?.ms ?? 0) >= 600 && o?.space == 2431, "\(String(describing: o))")
        check("parking: two lines: the retry, then the failure", said.count == 2 && said[1].hasPrefix("handoff: window 11's park didn't land after 2 tries in 6"), "\(said)")
        check("parking: the Space kept on record (the window may be in it)", p.privateSpaces == [11: 2431] && world.destroyed.isEmpty)
        check("parking: not busy afterwards", !p.isBusy(11))
        let back = run(clock) { p.returnToDesktop(11, done: $0) }
        check("parking: a return afterwards takes it out of that Space and destroys it",
              back?.ok == true && Array(world.calls.suffix(3)) == ["add 11 → 1", "remove 11 from 2431", "destroy 2431"] && p.privateSpaces.isEmpty, "\(world.calls)")
        said = []
        // A show that didn't land keeps the Space too; destroySpace(of:) is §4.4's "only B's".
        _ = run(clock) { p.park(11, done: $0) }
        _ = run(clock) { p.park(12, done: $0) }
        world.dropNext = 4
        let s = run(clock) { p.show(11, done: $0) }
        check("parking: a show that didn't land: its Space kept", s?.failure == .notLanded(spaces: [], onScreen: false) && p.privateSpaces[11] == 2432, "\(String(describing: s)) \(p.privateSpaces)")
        check("parking: destroying one window's Space leaves the others'", p.destroySpace(of: 11) && p.privateSpaces == [12: 2433] && world.destroyed.last == 2432)
        check("parking: destroying a Space it doesn't have: false", !p.destroySpace(of: 11))
        said = []
    }
    do {
        // The retry's op can't be made, after the first was sent: that one may still land.
        let clock = FakeClock()
        let world = twoDisplays(clock)
        let p = parker(clock, world)
        world.dropNext = 1
        world.refuseAdds = [false, true]
        let o = run(clock) { p.park(11, done: $0) }
        check("parking: a retry that couldn't be sent after the first op went out: not landed, never 'not sent'",
              o?.failure == .notLanded(spaces: [5], onScreen: true) && o?.tries == 1 && o?.space == 2431, "\(String(describing: o))")
        check("parking: … its Space kept (the first op may still land)", p.privateSpaces == [11: 2431] && world.destroyed.isEmpty && !p.isBusy(11), "\(world.calls)")
        check("parking: … the line says so", said.last?.hasPrefix("handoff: window 11's park retry couldn't be sent, after 30") == true, "\(said)")
        world.refuseAdds = [true]
        let none = run(clock) { p.park(12, done: $0) }
        check("parking: the first op not made: not sent, nothing sent, the Space made for it destroyed",
              none?.failure == .notSent && none?.tries == 0 && p.privateSpaces[12] == nil && world.destroyed == [2432], "\(String(describing: none)) \(world.calls)")
        said = []
    }
    do {
        // Unknown reads, a window that's gone, no Space, busy, parking off.
        let clock = FakeClock()
        let world = twoDisplays(clock)
        let p = parker(clock, world)
        world.unknown = true
        let show = run(clock) { p.show(11, done: $0) }
        check("parking: show with no active Space read: nowhere to go, nothing sent",
              show?.failure == .noTarget("the active Space didn't read") && show?.tries == 0 && world.calls.isEmpty)
        let ret = run(clock) { p.returnToDesktop(11, done: $0) }
        check("parking: return with no displays read: nowhere to go", ret?.failure == .noTarget("no Desktop read for its display"))
        let park = run(clock) { p.park(11, done: $0) }
        check("parking: park with the Spaces unknown: never verified, so not landed", park?.failure == .notLanded(spaces: nil, onScreen: false) && park?.tries == 2, "\(String(describing: park))")
        world.unknown = false
        said = []
        let gone = run(clock) { p.park(99, done: $0) }
        check("parking: a window that isn't listed: gone, no Space made", gone?.failure == .gone && !world.calls.contains("create 2432"), "\(world.calls)")
        world.createFails = true
        let none = run(clock) { p.park(12, done: $0) }
        check("parking: SLSSpaceCreate answering 0: no Space", none?.failure == .noSpace && p.privateSpaces[12] == nil)
        world.createFails = false
        var first: ParkOutcome?, second: ParkOutcome?
        p.park(12) { first = $0 }
        p.show(12) { second = $0 }
        check("parking: a second step for a window while one runs: busy, at once", second?.failure == .busy && first == nil && p.isBusy(12))
        clock.advance(1)
        check("parking: the first one still lands", first?.ok == true && !p.isBusy(12))
        world.canPark = false
        let off = run(clock) { p.show(12, done: $0) }
        check("parking: parking off: unavailable, nothing called", !p.isAvailable && off?.failure == .unavailable("parking is off") && world.calls.last == "add 12 → 2432", "\(world.calls)")
        said = []
    }

    // ---- FakeParker ----
    do {
        let clock = FakeClock()
        let fake = FakeParker(clock: clock)
        var got: [ParkOutcome] = []
        fake.park(5) { got.append($0) }
        fake.park(6) { got.append($0) }
        clock.advance(0.01)
        check("fake parker: a private Space per window", fake.privateSpaces == [5: 9001, 6: 9002] && fake.isParked(5) && fake.isParked(6))
        check("fake parker: park lands at its lag", got.map(\.ms) == [4, 4] && got.allSatisfy(\.ok))
        fake.activeSpace = 77
        fake.show(5) { got.append($0) }
        check("fake parker: busy until it lands", fake.isBusy(5))
        clock.advance(0.02)
        check("fake parker: a show lands in the active Space and destroys that window's Space only",
              got.last?.space == 77 && fake.location[5] == 77 && fake.destroyed == [9001] && fake.privateSpaces == [6: 9002] && fake.calls == ["park 5", "park 6", "show 5", "destroy 9001"], "\(fake.calls)")
        fake.scripts[.returnToDesktop] = [.landsOnRetry]
        fake.desktop = 3
        fake.returnToDesktop(6) { got.append($0) }
        clock.advance(0.5)
        check("fake parker: a retry that lands: two tries", got.last?.ok == true && got.last?.tries == 2 && fake.location[6] == 3 && fake.privateSpaces.isEmpty)
        fake.scripts[.park] = [.fails(.notLanded(spaces: [1], onScreen: true))]
        fake.park(5) { got.append($0) }
        clock.advance(0.5)
        check("fake parker: not before both tries", got.count == 4)
        clock.advance(0.2)
        check("fake parker: a retry then failure: two tries, its Space kept",
              got.last?.failure == .notLanded(spaces: [1], onScreen: true) && got.last?.tries == 2 && got.last?.ms == 600 && fake.privateSpaces == [5: 9003] && !fake.isParked(5))
        fake.scripts[.show] = [.fails(.noTarget("x"))]
        fake.show(5) { got.append($0) }
        check("fake parker: a failure before any op: at once, nothing sent", got.last?.failure == .noTarget("x") && got.last?.tries == 0)
        fake.park(8) { _ in }
        clock.advance(0.01)
        fake.comeBack(8, to: 1)
        check("fake parker: a window back by itself: in a user Space, its Space still there", !fake.isParked(8) && fake.privateSpaces[8] == 9004 && fake.location[8] == 1)
        check("fake parker: its Space destroyed on request", fake.destroySpace(of: 8) && fake.privateSpaces[8] == nil && !fake.destroySpace(of: 8))
        fake.isAvailable = false
        fake.park(9) { got.append($0) }
        check("fake parker: off: unavailable", got.last?.failure == .unavailable("parking is off"))
    }

    // ---- the cross-process self-test, with a stand-in child ----
    func selfTest(_ setup: (FakeClock, FakeSpaceWorld, FakeProbeChild) -> Void) -> (ParkSelfTest.Outcome?, FakeSpaceWorld, FakeProbeChild, ParkSelfTest) {
        let clock = FakeClock()
        let world = FakeSpaceWorld(clock: clock)
        world.active = 1
        world.displayList = [DisplaySpaces(display: "Main", current: 1, spaces: [ManagedSpace(id: 1, type: 0)])]
        let child = FakeProbeChild(world: world, clock: clock)
        setup(clock, world, child)
        let test = ParkSelfTest(parker: SpaceParker(reads: world, bridge: world, clock: clock), reads: world, child: child, clock: clock)
        var outcome: ParkSelfTest.Outcome?
        test.run { outcome = $0 }
        clock.advance(5)
        return (outcome, world, child, test)
    }
    do {
        let (outcome, world, child, test) = selfTest { _, _, _ in }
        check("self-test: park, show, park again and return, each verified", outcome == .passed(ParkSelfTest.Times(shown: 0, park: 4, show: 4, parkAgain: 4, returned: 4)), "\(String(describing: outcome))")
        check("self-test: the calls in order",
              world.calls == ["create 2431", "add 77 → 2431", "add 77 → 1", "remove 77 from 2431", "destroy 2431", "create 2432", "add 77 → 2432", "add 77 → 1", "remove 77 from 2432", "destroy 2432"], "\(world.calls)")
        check("self-test: every private Space destroyed, the child ended once", world.privateSpaces.isEmpty && child.started == 1 && child.ended == 1 && test.childPid == 4242)
        check("self-test: its line", ParkSelfTest.line(outcome!, pid: test.childPid)
              == "private calls: cross-process self-test park 4 ms, show 4 ms, park again 4 ms, return 4 ms (the child's window in a Space in 0 ms, pid 4242)")
        said = []
    }
    do {
        let (outcome, _, child, _) = selfTest { _, _, child in child.number = nil }
        check("self-test: a child that gives no number: failed, ended", outcome == .failed("the child ended or gave no window number") && child.ended == 1)
        check("self-test: the failure's line", ParkSelfTest.line(outcome!, pid: nil) == "private calls: park off: the cross-process self-test failed: the child ended or gave no window number")
    }
    do {
        let (outcome, _, child, _) = selfTest { _, _, child in child.after = 4 }
        check("self-test: no number in 3 s: failed", outcome == .failed("the child gave no window number in 3 s") && child.ended == 1, "\(String(describing: outcome))")
    }
    do {
        let (outcome, world, _, _) = selfTest { _, _, child in child.windowSpace = nil }
        check("self-test: its window in no Space: failed before any op", outcome == .failed("the child's window 77 was in no Space after 300 ms") && world.calls.isEmpty, "\(String(describing: outcome))")
    }
    do {
        let (outcome, world, child, _) = selfTest { _, world, _ in world.dropNext = 2 }
        check("self-test: a park that didn't land: failed, with the reads",
              outcome == .failed("the park of its window 77 didn't land (spaces [1], on screen true) (2 tries, 600 ms)"), "\(String(describing: outcome))")
        check("self-test: its private Space destroyed, the child ended", world.privateSpaces.isEmpty && world.destroyed == [2431] && child.ended == 1)
        said = []
    }
    do {
        let (outcome, _, child, _) = selfTest { _, world, _ in world.canPark = false }
        check("self-test: parking off: failed, no child started", outcome == .failed("parking is off") && child.started == 0)
    }

    // ---- the real ones refuse in tests ----
    do {
        let all = PrivateCalls.evaluate(FakePrivateResolver())
        fakeSkyCalls = []
        fakeCopyAnswer = 0
        let spaces = SkyLightSpaces(sky: SkyLight(resolver: FakePrivateResolver(), availability: all, refusing: false), availability: all)
        check("parking: SkyLightSpaces refuses under MARGIN_APP_TESTS: every read nil, every op false, nothing called",
              spaces.refuses && !spaces.canPark && spaces.activeSpace() == nil && spaces.spaces(of: 3) == nil && spaces.displays() == nil
              && spaces.window(3) == nil && spaces.display(at: CGRect(x: 0, y: 0, width: 10, height: 10)) == nil
              && spaces.createSpace() == nil && !spaces.destroySpace(1) && !spaces.add(3, to: 1) && !spaces.remove(3, from: 1) && fakeSkyCalls.isEmpty, "\(fakeSkyCalls)")
        // Not refusing, against private-calls-tests.swift's fake functions only (never the window
        // server: window(_:) and display(at:) aren't called here).
        let faked = SkyLightSpaces(sky: SkyLight(resolver: FakePrivateResolver(), availability: all, refusing: false), availability: all, refusing: false)
        check("parking: SkyLightSpaces: one window at a time, mask 7", faked.spaces(of: 3) == [3, 5] && fakeSkyCalls.last == "spaces 42 7 1", "\(fakeSkyCalls)")
        check("parking: SkyLightSpaces: a window number that isn't one: nil, nothing called", faked.spaces(of: 0) == nil && faked.spaces(of: -1) == nil && fakeSkyCalls.last == "spaces 42 7 1")
        check("parking: SkyLightSpaces: the displays parsed", faked.displays() == [DisplaySpaces(display: "Main", current: nil, spaces: [ManagedSpace(id: 7, type: 0)])] && faked.activeSpace() == 7)
        fakeSkyCalls = []
        check("parking: SkyLightSpaces: the bridge's ops, options 7", faked.canPark && faked.createSpace() == 2431 && faked.add(3, to: 2431) && faked.remove(3, from: 2431) && faked.destroySpace(2431)
              && fakeSkyCalls == ["cid", "create 42 1", "init add 2431 1 7", "perform performWithWMBridgeDelegate", "init remove 1 1", "perform performWithWMBridgeDelegate", "cid", "destroy 42 2431"], "\(fakeSkyCalls)")
        var off = all
        off.park = false
        let noPark = SkyLightSpaces(sky: SkyLight(resolver: FakePrivateResolver(), availability: off, refusing: false), availability: off, refusing: false)
        fakeSkyCalls = []
        check("parking: SkyLightSpaces with parking off: reads, but no Space and no op", !noPark.canPark && noPark.createSpace() == nil && !noPark.add(3, to: 1) && noPark.activeSpace() == 7
              && !fakeSkyCalls.contains { $0.hasPrefix("create") || $0.hasPrefix("init") }, "\(fakeSkyCalls)")

        // The bridge's ops kept by age, never by count: a burst never releases one in flight.
        final class Op {}
        let now = FakeUptime()
        let kept = KeptOperations(now: { now.t })
        var watched: [() -> AnyObject?] = []
        for _ in 0..<40 {
            let op = Op()
            weak let w = op
            watched.append { w }
            kept.keep(op)
        }
        check("parking: 40 ops sent at once (quit's returns): every one still held", kept.count == 40 && watched.allSatisfy { $0() != nil }, "\(kept.count)")
        now.t += KeptOperations.keepFor - 0.5
        kept.keep(Op())
        check("parking: … still held well past their steps' end", kept.count == 41 && watched.allSatisfy { $0() != nil })
        now.t += 0.5
        kept.keep(Op())
        check("parking: … released once older than \(Int(KeptOperations.keepFor)) s, as new ones come", kept.count == 2 && watched.allSatisfy { $0() == nil }, "\(kept.count)")

        let real = ProcessProbeChild()
        var heard: Int?? = .none
        real.start { heard = .some($0) }
        check("parking: the real child refuses under MARGIN_APP_TESTS: nothing spawned", heard == .some(nil) && real.pid == nil)
        real.end()
    }

    // ---- the shell's wiring ----
    do {
        let bare = Shell(link: SocketLink(), windows: StubWindows(), apps: StubApps(), hotKeys: FakeRegistrar(), options: { var o = Shell.Options(); o.harness = true; return o }())
        bare.checkPrivateCalls()
        bare.selfTestParking()
        check("parking: a shell with no resolver: no reads, no parker, no self-test", bare.spaceReads == nil && bare.parker == nil && bare.parkSelfTest == .notRun && !bare.parkingOn)
        var options = Shell.Options()
        options.harness = true
        options.privateResolver = FakePrivateResolver()
        let shell = Shell(link: SocketLink(), windows: StubWindows(), apps: StubApps(), hotKeys: FakeRegistrar(), options: options)
        shell.checkPrivateCalls()
        check("parking: a shell with a fake resolver: reads and a parker, the parker refusing in tests",
              shell.spaceReads != nil && shell.parker != nil && shell.parker?.isAvailable == false && !shell.parkingOn)
        let clock = FakeClock()
        let world = FakeSpaceWorld(clock: clock)
        shell.selfTestParking(child: FakeProbeChild(world: world, clock: clock))
        check("parking: the self-test with parking unavailable: failed at once, parking off",
              shell.parkSelfTest == .failed("parking is off") && !shell.parkingOn && said.last == "private calls: park off: the cross-process self-test failed: parking is off", "\(said)")
        shell.selfTestParking(child: FakeProbeChild(world: world, clock: clock))
        check("parking: the self-test runs once", said.filter { $0.contains("self-test") }.count == 1)
        check("parking: the registry made with the parker", shell.parking != nil && bare.parking == nil)
        check("parking: a harness's crash marker in its own data folder, never Application Support",
              shell.parkingMarkerURL == shell.data.store.root.appendingPathComponent("parked.json")
              && !shell.parkingMarkerURL.path.contains("Library/Application Support"), shell.parkingMarkerURL.path)
    }

    parkingRegistryTests()
}

// A stand-in for the system's uptime, read from KeptOperations' lock.
nonisolated final class FakeUptime: @unchecked Sendable {
    var t: TimeInterval = 100
}

// ---- the registry ----

func parkingRegistryTests() {
    let echo = Diagnostics.echo
    var said: [String] = []
    Diagnostics.echo = { said.append($0) }
    defer { Diagnostics.echo = echo }

    let safari: pid_t = 501
    let boundsA = CGRect(x: 100, y: 100, width: 1200, height: 800)
    let boundsB = CGRect(x: 200, y: 150, width: 1000, height: 700)
    let boundsC = CGRect(x: 40, y: 60, width: 900, height: 600)
    final class Setup {
        let clock = FakeClock()
        let world: FakeSpaceWorld
        let registry: ParkingRegistry
        let root: URL
        var strands: [String] = []
        var marker: URL { root.appendingPathComponent(ParkingMarker.fileName) }
        init(_ windows: [Int: CGRect], pid: pid_t) {
            world = FakeSpaceWorld(clock: clock)
            world.active = 5
            world.displayList = [DisplaySpaces(display: "Main", current: 5, spaces: [ManagedSpace(id: 1, type: 0), ManagedSpace(id: 5, type: 4)])]
            for (n, b) in windows { world.windows[n] = .init(pid: pid, bounds: b, spaces: [1]) }
            root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-parking-\(UUID().uuidString)", isDirectory: true)
            registry = ParkingRegistry(parker: SpaceParker(reads: world, bridge: world, clock: clock), reads: world, clock: clock,
                                       marker: root.appendingPathComponent(ParkingMarker.fileName), build: "26B123")
            registry.strandCheck = { [unowned self] in self.strands.append($0) }
        }
        deinit { try? FileManager.default.removeItem(at: root) }
        @discardableResult func park(_ n: Int, _ link: String, _ id: Int?, bounds: CGRect) -> ParkingRegistry.ParkResult? {
            var got: ParkingRegistry.ParkResult?
            registry.park(number: n, link: link, windowId: id, pid: world.windows[n]?.pid ?? 501, bounds: bounds, cause: .handoff) { got = $0 }
            clock.advance(1)
            return got
        }
    }
    func win(_ link: String, _ id: Int, _ bounds: CGRect?, state: String = "normal", focused: Bool = false, focusedAt: Double? = nil) -> ExtWindow {
        ExtWindow(key: WindowKey(link: link, windowId: id), bounds: bounds, state: state, focused: focused, activeTabId: nil, focusedAt: focusedAt)
    }
    func read(_ ext: [ExtWindow], reporting: Set<String>? = nil, copies: [String: String]? = nil, held: Set<String> = [], pids: Set<pid_t> = [501],
              moving: Set<Int> = []) -> SweepRead {
        let links = reporting ?? Set(ext.map(\.key.link))
        return SweepRead(pids: pids, ext: ext, reporting: links, copies: copies ?? Dictionary(uniqueKeysWithValues: links.map { ($0, "copy-1") }),
                         held: held, moving: moving)
    }

    // ---- park, and the marker it starts ----
    do {
        let s = Setup([11: boundsA, 12: boundsB], pid: safari)
        check("registry: nothing parked, no crash marker", !FileManager.default.fileExists(atPath: s.marker.path))
        _ = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        let r = s.park(11, "safari:a", 3, bounds: boundsA)
        check("registry: a park: its own private Space, verified, tracked by number",
              r?.park.ok == true && s.registry.entries[11]?.space == 2431 && s.registry.entries[11]?.phase == .parked && s.registry.isParked(11)
              && s.registry.entries[11]?.copy == "copy-1" && s.world.readsParked(11) == true, "\(String(describing: s.registry.entries[11]))")
        check("registry: its line: number, link and id, Space, ms and cause",
              said.last == "handoff: parked window 11 (safari:a#3) in its Space 2431 in 4 ms (a handoff)", "\(said)")
        let m = ParkingMarker.read(s.marker)
        check("registry: the crash marker written at the first park, in the given folder",
              m?.count == 1 && m?.build == "26B123" && m?.pid == ProcessInfo.processInfo.processIdentifier && m?.at == 1000004
              && m?.windows == [ParkingMarker.Window(number: 11, link: "safari:a", windowId: 3, copy: "copy-1", pid: 501, bounds: [100, 100, 1200, 800])],
              "\(String(describing: m))")
        let text = (try? String(contentsOf: s.marker, encoding: .utf8)) ?? ""
        check("registry: the marker holds numbers, links, ids and bounds only", text.contains("\"windows\"") && !text.contains("http") && !text.contains("title"), text)
        s.park(12, "safari:b", 7, bounds: boundsB)
        check("registry: … and kept up to date", ParkingMarker.read(s.marker)?.windows.map(\.number) == [11, 12] && s.registry.entries[12]?.space == 2432)
        let again = s.park(11, "safari:a", 3, bounds: boundsA)
        check("registry: parking a parked window: answered at once, nothing sent", again?.park.ok == true && again?.park.tries == 0
              && s.world.calls.filter { $0.hasPrefix("add 11") }.count == 1, "\(s.world.calls)")
        said = []
        let gone = s.park(99, "safari:a", 4, bounds: boundsA)
        check("registry: a park of a window that isn't listed: not tracked, and no strand", gone?.park.failure == .gone && !s.registry.isParked(99) && s.strands.isEmpty)
        check("registry: the registry's line for it", said.last == "handoff: window 99 (safari:a#4) not parked: found no such window", "\(said)")
        said = []
    }

    // ---- never forgotten by a link down, a link held, or a new copy ----
    do {
        let s = Setup([11: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        var f = s.registry.sweep(read([], reporting: []))
        check("registry: its link down: nothing changes", f == [.held(number: 11, link: "safari:a")] && s.registry.entries[11]?.windowId == 3)
        s.clock.advance(30)
        f = s.registry.sweep(read([], reporting: [], held: ["safari:a"]))
        check("registry: … reconnecting (held), 30 s on: still parked, still bound", f == [.held(number: 11, link: "safari:a")] && s.registry.entries[11]?.phase == .parked
              && s.registry.entries[11]?.windowId == 3)
        f = s.registry.sweep(read([win("safari:a", 21, boundsA)], copies: ["safari:a": "copy-2"]))
        check("registry: a new copy: kept by number, its window id nil until rebound",
              f == [.newCopy(number: 11, link: "safari:a")] && s.registry.entries[11]?.windowId == nil && s.registry.entries[11]?.phase == .parked
              && ParkingMarker.read(s.marker)?.windows.first?.windowId == nil, "\(f)")
        check("registry: … logged", said.last == "handoff: window 11 (safari:a#3): a new copy of Margin in its profile, rebinding", "\(said)")
        f = s.registry.sweep(read([win("safari:a", 21, boundsA)], copies: ["safari:a": "copy-2"]))
        check("registry: … and a new copy not listing the old id doesn't forget it", f.isEmpty && s.registry.isParked(11), "\(f)")
        check("registry: no strand on the way", s.strands.isEmpty)
        said = []
    }

    // ---- forgotten only when the window is gone ----
    do {
        let s = Setup([11: boundsA, 12: boundsB, 13: boundsC], pid: safari)
        let ext = [win("safari:a", 3, boundsA), win("safari:a", 4, boundsB), win("safari:b", 9, boundsC)]
        _ = s.registry.sweep(read(ext))
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.park(12, "safari:a", 4, bounds: boundsB)
        s.park(13, "safari:b", 9, bounds: boundsC)
        _ = s.registry.sweep(read(ext)) // the liveness read lists each one parked
        s.world.windows[11] = nil
        var f = s.registry.sweep(read(ext))
        check("registry: missing from one read: kept", f.isEmpty && s.registry.isParked(11), "\(f)")
        s.clock.advance(2.9)
        f = s.registry.sweep(read(ext))
        check("registry: … 2.9 s: kept", f.isEmpty && s.registry.isParked(11))
        s.clock.advance(0.1)
        f = s.registry.sweep(read(ext))
        check("registry: not listed for 3 s with Safari running: forgotten, its Space destroyed",
              f == [.gone(number: 11, link: "safari:a", why: .notListed)] && !s.registry.isParked(11) && s.world.destroyed == [2431], "\(f) \(s.world.destroyed)")
        check("registry: … logged", said.last == "handoff: forgot parked window 11 (safari:a#3): the window server hasn't listed it for 3 s", "\(said)")
        f = s.registry.sweep(read([win("safari:a", 3, boundsA), win("safari:b", 9, boundsC)]))
        check("registry: the same copy no longer listing its id: closed, forgotten", f == [.gone(number: 12, link: "safari:a", why: .closedInCopy)] && !s.registry.isParked(12), "\(f)")
        s.world.windows[13]?.pid = 777
        f = s.registry.sweep(read(ext))
        check("registry: its number now another process's: gone at once", f == [.gone(number: 13, link: "safari:b", why: .notListed)], "\(f)")
        check("registry: the marker follows", ParkingMarker.read(s.marker)?.count == 0)
        check("registry: none of it a strand", s.strands.isEmpty)
        said = []
    }
    do {
        let s = Setup([11: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.world.windows[11] = nil // never listed while parked (gate G6's question)
        _ = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        s.clock.advance(10)
        let f = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        check("registry: a read that never listed it parked proves nothing: kept", f.isEmpty && s.registry.isParked(11), "\(f)")
        let p = s.registry.sweep(read([win("safari:a", 3, boundsA)], pids: [502]))
        check("registry: Safari's process gone: forgotten", p == [.gone(number: 11, link: "safari:a", why: .pidGone)] && s.registry.entries.isEmpty, "\(p)")
        said = []
    }

    do {
        // A window made a moment ago (openSpaceWindow), parked before its copy's list names it.
        let s = Setup([11: boundsA, 12: boundsB, 13: boundsC], pid: safari)
        _ = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        s.park(12, "safari:a", 8, bounds: boundsB)
        s.park(13, "safari:a", 9, bounds: boundsC)
        check("registry: a made window parked: its copy known from the last read", s.registry.entries[12]?.copy == "copy-1")
        var f = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        check("registry: its copy's next list lags and doesn't name it: kept, its Space left alone",
              f.isEmpty && s.registry.isParked(12) && s.registry.isParked(13) && s.world.destroyed.isEmpty && s.world.readsParked(12) == true, "\(f) \(s.world.destroyed)")
        s.clock.advance(1.5)
        f = s.registry.sweep(read([win("safari:a", 3, boundsA), win("safari:a", 8, boundsB)]))
        check("registry: … 1.5 s on, still not named (13), or named now (12): both kept", f.isEmpty && s.registry.isParked(12) && s.registry.isParked(13), "\(f)")
        s.clock.advance(0.5)
        f = s.registry.sweep(read([win("safari:a", 3, boundsA), win("safari:a", 8, boundsB)]))
        check("registry: never named by its copy for 2 s: closed in Safari, forgotten", f == [.gone(number: 13, link: "safari:a", why: .closedInCopy)] && s.registry.isParked(12), "\(f)")
        f = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        check("registry: named since its park, then not: closed, forgotten at once", f == [.gone(number: 12, link: "safari:a", why: .closedInCopy)], "\(f)")
        check("registry: … no strand", s.strands.isEmpty)
        said = []
    }

    // ---- the hard rule ----
    do {
        let s = Setup([11: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.registry.forget(11, .returned)
        s.registry.forget(11, .shown)
        s.registry.forget(11, .neverParked, sent: false)
        check("registry: forgetting a parked window that wasn't returned or shown: refused, asserted, still tracked",
              s.strands.count == 3 && s.registry.isParked(11) && s.strands[0] == "handoff: window 11 (safari:a#3) would stop being tracked (returned to a user Space) while it's still alive and parked",
              "\(s.strands)")
        s.strands = []
        var back: ParkOutcome?
        s.registry.returnToDesktop(number: 11, cause: .aftercare) { back = $0 }
        s.clock.advance(1)
        check("registry: a return verified, then let go: no strand", back?.ok == true && !s.registry.isParked(11) && s.strands.isEmpty
              && s.world.spaces(of: 11) == [1] && s.world.destroyed == [2431])
        check("registry: the return's line", said.last == "handoff: returned window 11 (safari:a#3) to the Desktop 1 in 4 ms (the aftercare)", "\(said)")
        said = []
    }

    // ---- rebinding after a new copy ----
    do {
        let s = Setup([11: boundsA, 12: boundsB], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        _ = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        _ = s.registry.sweep(read([win("safari:a", 30, nil)], copies: ["safari:a": "copy-2"]))
        let bound = s.registry.rebind(link: "safari:a", unbound: [win("safari:a", 30, nil), win("safari:a", 31, boundsA, state: "fullscreen"), win("safari:b", 8, boundsA)])
        check("registry: rebound by elimination: one normal window, one number without an id",
              bound == [WindowKey(link: "safari:a", windowId: 30): 11] && s.registry.entries[11]?.windowId == 30 && s.registry.entries[11]?.copy == "copy-2", "\(bound)")
        check("registry: … logged as §8.1 says", said.last == "handoff: window 11 rebound to safari:a#30 (a new copy; by elimination)", "\(said)")
        check("registry: … and kept in the marker", ParkingMarker.read(s.marker)?.windows.first?.windowId == 30)
        check("registry: nothing to rebind: nothing", s.registry.rebind(link: "safari:a", unbound: [win("safari:a", 40, boundsA)]).isEmpty)
        said = []
    }
    do {
        let s = Setup([11: boundsA, 12: boundsB, 13: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.park(12, "safari:a", 4, bounds: boundsB)
        _ = s.registry.sweep(read([win("safari:a", 3, boundsA), win("safari:a", 4, boundsB)]))
        _ = s.registry.sweep(read([], reporting: ["safari:a"], copies: ["safari:a": "copy-2"]))
        let near = CGRect(x: 101.5, y: 98.5, width: 1200, height: 801)
        let bound = s.registry.rebind(link: "safari:a", unbound: [win("safari:a", 31, near), win("safari:a", 32, boundsB), win("safari:a", 33, boundsC, state: "minimized")])
        check("registry: rebound by bounds within 2 pt",
              bound == [WindowKey(link: "safari:a", windowId: 31): 11, WindowKey(link: "safari:a", windowId: 32): 12]
              && said.suffix(2) == ["handoff: window 11 rebound to safari:a#31 (a new copy; by bounds)", "handoff: window 12 rebound to safari:a#32 (a new copy; by bounds)"], "\(bound) \(said)")
        said = []
    }
    do {
        let s = Setup([11: boundsA, 12: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.park(12, "safari:a", 4, bounds: boundsA)
        _ = s.registry.sweep(read([win("safari:a", 3, boundsA), win("safari:a", 4, boundsA)]))
        _ = s.registry.sweep(read([], reporting: ["safari:a"], copies: ["safari:a": "copy-2"]))
        said = []
        let same = s.registry.rebind(link: "safari:a", unbound: [win("safari:a", 31, boundsA), win("safari:a", 32, boundsA)])
        check("registry: two windows with the same bounds for two numbers: ambiguous, left unbound",
              same.isEmpty && s.registry.entries[11]?.windowId == nil && s.registry.entries[12]?.windowId == nil
              && said == ["handoff: window 11 (safari:a) left unbound: 2 of the copy's windows fit", "handoff: window 12 (safari:a) left unbound: 2 of the copy's windows fit"], "\(said)")
        _ = s.registry.rebind(link: "safari:a", unbound: [win("safari:a", 31, boundsA), win("safari:a", 32, boundsA)])
        check("registry: … said once", said.count == 2)
        let one = s.registry.rebind(link: "safari:a", unbound: [win("safari:a", 31, boundsA)])
        check("registry: one window fitting two numbers: still unbound", one.isEmpty)
        said = []
    }
    do {
        let s = Setup([11: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        _ = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        _ = s.registry.sweep(read([], reporting: ["safari:a"], copies: ["safari:a": "copy-2"]))
        said = []
        let none = s.registry.rebind(link: "safari:a", unbound: [win("safari:a", 31, boundsB), win("safari:a", 32, boundsC)])
        check("registry: one number, two normal windows, neither fitting: unbound", none.isEmpty && said == ["handoff: window 11 (safari:a) left unbound: 0 of the copy's windows fit"], "\(said)")
        said = []
    }

    // ---- who caused a return (§2.6) ----
    do {
        let s = Setup([11: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.world.comeBack(11, to: 5)
        var f = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        check("registry: back with no focus on it: the system's, parked again, never the person's",
              f == [.system(number: 11, link: "safari:a", why: "no focus on it", then: .parkAgain)], "\(f)")
        check("registry: … logged", said.last == "handoff: window 11 (safari:a#3) back with no focus on it: parked again", "\(said)")
        s.clock.advance(1)
        check("registry: … parked again in its Space, quietly", s.registry.entries[11]?.phase == .parked && s.world.readsParked(11) == true
              && said.last == "handoff: parked window 11 (safari:a#3) in its Space 2431 in 4 ms (no focus on it)", "\(said)")
        s.registry.systemEvent("a wake")
        s.world.comeBack(11, to: 5)
        f = s.registry.sweep(read([win("safari:a", 3, boundsA, focused: true, focusedAt: s.clock.now())]))
        check("registry: within 3 s of a wake, even with focus on it: the system's", f == [.system(number: 11, link: "safari:a", why: "a wake", then: .parkAgain)]
              && said.last == "handoff: window 11 (safari:a#3) back after a wake: parked again", "\(f) \(said)")
        s.clock.advance(3)
        s.world.comeBack(11, to: 5)
        let focusedAt = s.clock.now()
        let before = s.world.calls.count
        f = s.registry.sweep(read([win("safari:a", 3, boundsA, focused: true, focusedAt: focusedAt)]))
        check("registry: back with the person's focus on it: theirs, and nothing moved", f == [.person(number: 11, key: WindowKey(link: "safari:a", windowId: 3))]
              && s.registry.entries[11]?.phase == .parked && s.world.calls.count == before
              && said.last == "handoff: window 11 (safari:a#3) back with focus on it: the person's", "\(f) \(said)")
        let calls = s.world.calls.count
        let lines = said.count
        f = s.registry.sweep(read([win("safari:a", 3, boundsA, focused: true, focusedAt: focusedAt)]))
        check("registry: … said again on the next read (a switch may have been busy), logged once",
              f == [.person(number: 11, key: WindowKey(link: "safari:a", windowId: 3))] && s.world.calls.count == calls && said.count == lines, "\(f) \(said)")
        // The person clicks the shown window: focus leaves the one they brought back.
        s.clock.advance(1)
        f = s.registry.sweep(read([win("safari:a", 3, boundsA, focused: false, focusedAt: focusedAt)]))
        check("registry: … focus lost since: still the person's, never parked again",
              f == [.person(number: 11, key: WindowKey(link: "safari:a", windowId: 3))] && s.world.calls.count == calls && s.registry.entries[11]?.claimed == focusedAt
              && said.count == lines, "\(f) \(said)")
        s.registry.systemEvent("a display change")
        f = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        check("registry: … a system event after the person's return: still theirs", f == [.person(number: 11, key: WindowKey(link: "safari:a", windowId: 3))]
              && s.world.calls.count == calls, "\(f)")
        check("registry: release: refused for a window that isn't the person's, or that isn't back", !s.registry.release(99))
        check("registry: release: the person's window let go, its Space destroyed, no strand",
              s.registry.release(11) && !s.registry.isParked(11) && s.world.destroyed.last == 2431 && s.world.spaces(of: 11) == [5] && s.strands.isEmpty
              && said.last == "handoff: window 11 (safari:a#3) let go: the person brought it back", "\(said)")
        check("registry: … and nothing found for it after", s.registry.sweep(read([win("safari:a", 3, boundsA)])).isEmpty)
        said = []
    }
    do {
        // Focus its copy heard before the park, still on it when it's found back: not the person's.
        let s = Setup([11: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        let since = s.registry.entries[11]!.since
        s.clock.advance(5) // well past Margin's own call (the park) and any system event
        s.world.comeBack(11, to: 5)
        let f = s.registry.sweep(read([win("safari:a", 3, boundsA, focused: true, focusedAt: since - 5)]))
        check("registry: focus from before the park isn't the person's: the system's, parked again",
              f == [.system(number: 11, link: "safari:a", why: "no focus on it", then: .parkAgain)] && s.registry.entries[11]?.claimed == nil, "\(f)")
        said = []
    }
    do {
        // A park of the person's window parks it for real (a handoff refused, say).
        let s = Setup([11: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.clock.advance(5)
        s.world.comeBack(11, to: 5)
        let f = s.registry.sweep(read([win("safari:a", 3, boundsA, focused: true, focusedAt: s.clock.now())]))
        let r = s.park(11, "safari:a", 3, bounds: boundsA)
        check("registry: parking the person's window: sent, verified, theirs no more",
              f.count == 1 && r?.park.ok == true && r?.park.tries == 1 && s.world.readsParked(11) == true && s.registry.entries[11]?.claimed == nil
              && s.registry.entries[11]?.phase == .parked, "\(String(describing: r)) \(s.world.calls)")
        said = []
    }
    do {
        let s = Setup([11: boundsA], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.clock.advance(5)
        s.registry.noteCall(11, cause: .handoff)
        s.world.comeBack(11, to: 5)
        let f = s.registry.sweep(read([win("safari:a", 3, boundsA, focused: true, focusedAt: s.clock.now() + 0.4)]))
        check("registry: focus within a second of Margin's own call: Margin's, not the person's", f == [.system(number: 11, link: "safari:a", why: "no focus on it", then: .parkAgain)], "\(f)")
        s.clock.advance(1)
        s.world.comeBack(11, to: 5)
        let moving = s.registry.sweep(read([win("safari:a", 3, boundsA)], moving: [11]))
        check("registry: a window a switch is moving: not judged", moving.isEmpty, "\(moving)")
        let full = s.registry.sweep(read([win("safari:a", 3, boundsA, state: "fullscreen")]))
        check("registry: back but full screen: not parked until normal (§4.4)", full == [.system(number: 11, link: "safari:a", why: "no focus on it", then: .wait("it's fullscreen"))]
              && s.registry.entries[11]?.phase == .parked, "\(full)")
        s.registry.parkingOn = { false }
        let off = s.registry.sweep(read([win("safari:a", 3, boundsA)]))
        s.clock.advance(1)
        check("registry: back with parking off: returned to its Desktop, then let go",
              off == [.system(number: 11, link: "safari:a", why: "no focus on it", then: .returnToDesktop)] && !s.registry.isParked(11) && s.world.spaces(of: 11) == [1]
              && s.strands.isEmpty, "\(off) \(String(describing: s.world.spaces(of: 11)))")
        said = []
    }

    // ---- show, and a show that didn't land ----
    do {
        let s = Setup([11: boundsA, 12: boundsB], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.park(12, "safari:b", 7, bounds: boundsB)
        var shown: ParkOutcome?
        s.registry.show(number: 12, cause: .handoff) { shown = $0 }
        s.clock.advance(1)
        check("registry: a show verified: let go, its Space destroyed, the profile's home window",
              shown?.ok == true && !s.registry.isParked(12) && s.registry.lastShown["safari:b"] == 12 && s.world.destroyed == [2432] && s.world.spaces(of: 12) == [5])
        check("registry: … its line", said.last == "handoff: shown window 12 (safari:b#7) in 4 ms (a handoff)", "\(said)")
        check("registry: the marker has the shown window", ParkingMarker.read(s.marker)?.shown == [ParkingMarker.Shown(link: "safari:b", number: 12)])
        s.world.dropNext = 4
        var failed: ParkOutcome?, busy: ParkOutcome?
        s.registry.show(number: 11, cause: .handoff) { failed = $0 }
        s.registry.show(number: 11, cause: .handoff) { busy = $0 }
        check("registry: a second step while one runs: busy", busy?.failure == .busy && failed == nil)
        s.clock.advance(1)
        check("registry: a show that didn't land: that window's Space destroyed, and only that one",
              failed?.failure == .notLanded(spaces: [], onScreen: false) && s.world.destroyed == [2432, 2431] && s.registry.entries[11]?.space == nil
              && s.registry.entries[11]?.phase == .out && s.registry.isParked(11), "\(String(describing: failed)) \(s.world.destroyed)")
        check("registry: … logged", said.last == "handoff: window 11 (safari:a#3) wasn't shown: its own Space 2431 destroyed, the others left", "\(said)")
        s.world.comeBack(11, to: 5)
        let f = s.registry.sweep(read([win("safari:a", 3, boundsA), win("safari:b", 7, boundsB)]))
        check("registry: found in a user Space afterwards: an ordinary window again, let go", f == [.returned(number: 11, link: "safari:a")]
              && !s.registry.isParked(11) && s.strands.isEmpty, "\(f)")
        said = []
    }
    do {
        let s = Setup([11: boundsA], pid: safari)
        s.world.dropNext = 2
        let r = s.park(11, "safari:a", 3, bounds: boundsA)
        check("registry: a park that didn't land: returned to its Desktop, verified, then let go (§4.4)",
              r?.park.failure == .notLanded(spaces: [1], onScreen: false) && r?.returned?.ok == true && !s.registry.isParked(11) && s.world.spaces(of: 11) == [1]
              && s.world.privateSpaces.isEmpty && s.strands.isEmpty, "\(String(describing: r)) \(s.world.calls)")
        said = []
    }

    do {
        // The first op went out and didn't verify; the retry's couldn't be made.
        let s = Setup([11: boundsA], pid: safari)
        s.world.dropNext = 1
        s.world.refuseAdds = [false, true]
        var r: ParkingRegistry.ParkResult?
        s.registry.park(number: 11, link: "safari:a", windowId: 3, pid: safari, bounds: boundsA, cause: .handoff) { r = $0 }
        s.clock.advance(1)
        check("registry: a park whose retry couldn't be sent: its Space kept and the window taken out of it before it's let go (the first op may land)",
              s.world.calls == ["create 2431", "add 11 → 2431", "add 11 → 2431 refused", "add 11 → 1", "remove 11 from 2431", "destroy 2431"], "\(s.world.calls)")
        check("registry: … returned to its Desktop, verified, its Space destroyed, then let go",
              r?.park.failure == .notLanded(spaces: [1], onScreen: false) && r?.returned?.ok == true && !s.registry.isParked(11)
              && s.world.spaces(of: 11) == [1] && s.world.privateSpaces.isEmpty && s.strands.isEmpty, "\(String(describing: r)) \(s.world.calls)")
        said = []
    }
    do {
        // A failure after an op went out, whatever its kind, isn't "nothing sent".
        check("registry: an outcome with an op sent may have moved the window",
              ParkingRegistry.mayHaveMoved(ParkOutcome(number: 1, step: .park, failure: .notSent, ms: 300, tries: 1, space: 5))
              && ParkingRegistry.mayHaveMoved(ParkOutcome(number: 1, step: .park, failure: .notLanded(spaces: nil, onScreen: nil), ms: 600, tries: 2, space: 5))
              && !ParkingRegistry.mayHaveMoved(ParkOutcome(number: 1, step: .park, failure: .notSent, ms: 0, tries: 0, space: nil))
              && !ParkingRegistry.mayHaveMoved(ParkOutcome(number: 1, step: .park, failure: nil, ms: 4, tries: 1, space: 5)))
    }

    // ---- returnAll and quit ----
    do {
        let s = Setup([11: boundsA, 12: boundsB], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.park(12, "safari:b", 7, bounds: boundsB)
        var end: ParkingEnd?
        s.registry.returnAll { end = $0 }
        s.clock.advance(1)
        check("registry: returnAll: every window on its Desktop, every private Space destroyed",
              end == ParkingEnd(closed: 0, returned: 2, left: 0, ms: 4) && s.registry.entries.isEmpty && s.world.privateSpaces.isEmpty
              && s.world.spaces(of: 11) == [1] && s.world.spaces(of: 12) == [1] && s.strands.isEmpty, "\(String(describing: end))")
        var none: ParkingEnd?
        s.registry.returnAll { none = $0 }
        check("registry: nothing parked: done at once", none == ParkingEnd())
        said = []
    }
    do {
        let s = Setup([11: boundsA, 12: boundsB, 13: boundsC], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.park(12, "safari:b", 7, bounds: boundsB)
        s.park(13, "safari:c", 9, bounds: boundsC)
        check("registry: the marker there before quit", FileManager.default.fileExists(atPath: s.marker.path))
        var asked: [Int] = []
        var end: ParkingEnd?
        s.registry.quit(close: { e, closed in
            asked.append(e.number)
            switch e.link {
            case "safari:a": // its copy closes it
                _ = s.clock.after(0.02) { s.world.windows[e.number] = nil; closed(true) }
                return true
            case "safari:c": // its copy couldn't
                _ = s.clock.after(0.01) { closed(false) }
                return true
            default: return false // not linked
            }
        }) { end = $0 }
        s.clock.advance(1)
        check("registry: quit: each window closed by its own copy, the rest returned to their Desktops",
              asked == [11, 12, 13] && end?.closed == 1 && end?.returned == 2 && end?.left == 0 && s.registry.entries.isEmpty && s.world.privateSpaces.isEmpty
              && s.world.spaces(of: 12) == [1] && s.world.spaces(of: 13) == [1], "\(String(describing: end))")
        check("registry: … within 300 ms", (end?.ms ?? 999) <= 300)
        check("registry: … the crash marker removed at a clean quit", !FileManager.default.fileExists(atPath: s.marker.path))
        check("registry: … one line", said.last == "handoff: closed 1 parked window, returned 2 parked windows to the Desktop at quit (\(end?.ms ?? 0) ms)", "\(said)")
        check("registry: … no strand", s.strands.isEmpty)
        said = []
    }
    do {
        let s = Setup([11: boundsA, 12: boundsB], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.park(12, "safari:b", 7, bounds: boundsB)
        var end: ParkingEnd?
        s.registry.quit(close: { e, _ in e.number == 11 }) { end = $0 } // 11's copy never answers
        s.clock.advance(0.29)
        check("registry: quit waits for a slow close…", end == nil)
        s.clock.advance(0.02)
        check("registry: … 300 ms in all, then done, the window left to come back by itself",
              end == ParkingEnd(closed: 0, returned: 1, left: 1, ms: 300) && s.registry.isParked(11) && !FileManager.default.fileExists(atPath: s.marker.path)
              && said.last == "handoff: returned 1 parked window to the Desktop, left 1 to come back by itself at quit (300 ms)", "\(String(describing: end)) \(said)")
        check("registry: … the window left parked as it was, not closing", s.registry.entries[11]?.phase == .parked && s.registry.entries[11]?.cause == nil)
        said = []
    }
    do {
        // §13.8: the shown window closed, every parked window closed, and Margin keeps running.
        let s = Setup([11: boundsA, 12: boundsB], pid: safari)
        s.park(11, "safari:a", 3, bounds: boundsA)
        s.park(12, "safari:b", 7, bounds: boundsB)
        var answers: [Int: (Bool) -> Void] = [:]
        var end: ParkingEnd?
        s.registry.endAll(cause: .aftercare, within: 0.3, close: { e, closed in answers[e.number] = closed; return true }) { end = $0 } // neither copy answers
        s.clock.advance(0.31)
        check("registry: an end whose copies never answer: done at 300 ms, both left",
              end == ParkingEnd(closed: 0, returned: 0, left: 2, ms: 300) && s.registry.isParked(11) && s.registry.isParked(12), "\(String(describing: end))")
        check("registry: … both parked again as they were, not closing for good",
              s.registry.entries[11]?.phase == .parked && s.registry.entries[12]?.phase == .parked && s.registry.entries[11]?.cause == nil
              && said.contains("handoff: window 11 (safari:a#3): its copy didn't answer the close in 300 ms, still tracked"), "\(said)")
        var shown: ParkOutcome?
        s.registry.show(number: 11, cause: .handoff) { shown = $0 }
        s.clock.advance(1)
        check("registry: … a handoff to it afterwards isn't busy: shown", shown?.ok == true && !s.registry.isParked(11) && s.world.spaces(of: 11) == [5], "\(String(describing: shown))")
        let f = s.registry.sweep(read([win("safari:b", 7, boundsB)]))
        check("registry: … the other judged by each read again", f.isEmpty && s.registry.isParked(12), "\(f)")
        s.world.windows[12] = nil
        answers[12]?(true)
        check("registry: … its copy's late 'closed': forgotten, its Space destroyed, no strand",
              !s.registry.isParked(12) && s.world.privateSpaces.isEmpty && s.strands.isEmpty, "\(s.world.privateSpaces)")
        answers[11]?(false)
        check("registry: … a late 'couldn't' for a window already gone: nothing", s.registry.entries.isEmpty && s.strands.isEmpty)
        said = []
    }

    // ---- the crash marker at the next launch (§13.2) ----
    do {
        let s = Setup([11: boundsA, 12: boundsB, 14: boundsC, 15: boundsA], pid: safari)
        s.world.windows[12]?.pid = 400
        s.world.windows[14]?.bounds = boundsB // moved since
        let window = { (n: Int, link: String, id: Int?, pid: Int32, b: CGRect) in
            ParkingMarker.Window(number: n, link: link, windowId: id, copy: "copy-1", pid: pid, bounds: [b.minX, b.minY, b.width, b.height].map(Double.init))
        }
        let crashed = ParkingMarker(pid: 99999, build: "26B123", at: 1, count: 4,
                                    windows: [window(11, "safari:a", 3, 501, boundsA), window(12, "safari:b", 7, 400, boundsB),
                                              window(13, "safari:c", 9, 501, boundsC), window(14, "safari:d", 2, 501, boundsC)],
                                    shown: [ParkingMarker.Shown(link: "safari:e", number: 15)])
        try? FileManager.default.createDirectory(at: s.root, withIntermediateDirectories: true)
        try? JSONEncoder().encode(crashed).write(to: s.marker)
        check("registry: a marker of a Margin still running: left alone", s.registry.takeMarker(running: { $0 == 99999 }) == nil
              && FileManager.default.fileExists(atPath: s.marker.path))
        let taken = s.registry.takeMarker(running: { _ in false })
        check("registry: a crash's marker: taken, the file removed (a second crash never reads it)", taken == crashed && !FileManager.default.fileExists(atPath: s.marker.path))
        var parked: Int?
        s.registry.adoptAfterCrash(crashed, safariPids: [501, 400 + 1]) { parked = $0 }
        check("registry: … its line", said.last == "handoff: Margin.app didn't quit cleanly with 4 parked windows: 1 parked again, left as normal windows: 1 of an earlier Safari, 1 gone, 1 moved", "\(said)")
        s.clock.advance(1)
        check("registry: the same Safari's window, still there with its bounds: parked again, with its link, id and copy",
              parked == 1 && s.registry.numbers == [11] && s.registry.entries[11]?.windowId == 3 && s.registry.entries[11]?.copy == "copy-1"
              && s.world.readsParked(11) == true && said.last == "handoff: parked window 11 (safari:a#3) in its Space 2431 in 4 ms (a recovery)", "\(said)")
        check("registry: … the shown window stays the profile's home window", s.registry.lastShown == ["safari:e": 15])
        check("registry: … a new marker for the windows parked now", ParkingMarker.read(s.marker)?.windows.map(\.number) == [11])
        let f = s.registry.sweep(read([win("safari:a", 3, boundsA)], copies: ["safari:a": "copy-1"]))
        check("registry: … the same copy reporting: still bound", f.isEmpty && s.registry.entries[11]?.windowId == 3, "\(f)")
        said = []
    }
    // ---- Margin windows: lines (app/WINDOWS.md §1, §4) ----
    do {
        let s = Setup([21: boundsA, 22: boundsB, 23: boundsC, 24: boundsA], pid: safari)
        let lines = [ParkingMarker.LineRecord(id: 1, homes: [.init(link: "safari:a", number: 21), .init(link: "safari:b", number: 22)], shown: 21),
                     ParkingMarker.LineRecord(id: 4, homes: [.init(link: "safari:a", number: 23), .init(link: "safari:b", number: 24)], shown: 24)]
        let m = ParkingMarker(pid: 99999, build: "26B123", at: 1, count: 0, windows: [], shown: lines.flatMap(\.homes), lines: lines)
        s.registry.adoptAfterCrash(m, safariPids: [safari])
        check("lines: a marker's lines restored, each with its homes and its shown window",
              s.registry.lines[1]?.homes == ["safari:a": 21, "safari:b": 22] && s.registry.lines[1]?.shown == 21
              && s.registry.lines[4]?.homes == ["safari:a": 23, "safari:b": 24] && s.registry.lines[4]?.shown == 24, "\(s.registry.lines)")
        check("lines: each window in its own line", s.registry.line(of: 21) == 1 && s.registry.line(of: 24) == 4 && s.registry.line(of: 99) == nil)
        check("lines: the first line is the one chain's view", s.registry.lastShown == ["safari:a": 21, "safari:b": 22])
        s.registry.noteShown(link: "safari:a", number: 23, line: 1)
        check("lines: a window is in one line only: moved, and the home it replaced is in none",
              s.registry.lines[1]?.homes["safari:a"] == 23 && s.registry.lines[1]?.shown == 23 && s.registry.lines[4]?.homes == ["safari:b": 24]
              && s.registry.line(of: 21) == nil, "\(s.registry.lines)")
        let written = s.registry.marker
        check("lines: the marker keeps the lines, and every home flattened for an older Margin",
              written.lines?.map(\.id) == [1, 4] && written.lines?.first?.shown == 23 && written.shown.count == 3, "\(String(describing: written.lines))")
        let windowless = Setup([31: boundsA], pid: safari)
        windowless.registry.adoptAfterCrash(ParkingMarker(pid: 99999, build: "26B123", at: 1, count: 0, windows: [], shown: [], lines: [
            ParkingMarker.LineRecord(id: 2, homes: [.init(link: "safari:a", number: 31), .init(link: "safari:b", number: 32)], shown: 32)]), safariPids: [safari])
        check("lines: a home Safari no longer has isn't restored", windowless.registry.lines[2]?.homes == ["safari:a": 31] && windowless.registry.lines[2]?.shown == nil,
              "\(windowless.registry.lines)")
    }
    do {
        let s = Setup([11: boundsA], pid: safari)
        s.registry.parkingOn = { false }
        let crashed = ParkingMarker(pid: 99999, build: nil, at: 1, count: 1,
                                    windows: [ParkingMarker.Window(number: 11, link: "safari:a", windowId: 3, copy: nil, pid: 501, bounds: [100, 100, 1200, 800])], shown: [])
        var parked: Int?
        s.registry.adoptAfterCrash(crashed, safariPids: [501]) { parked = $0 }
        check("registry: after a crash with parking off: every window left as it is",
              parked == 0 && s.registry.entries.isEmpty && s.world.calls.isEmpty
              && said.last == "handoff: Margin.app didn't quit cleanly with 1 parked window: 0 parked again, left as normal windows: 1 with parking off", "\(said)")
        check("registry: no marker read: nothing", s.registry.takeMarker(running: { _ in false }) == nil)
        said = []
    }
    do {
        // The windows came back by themselves and the person went on in one: it's the one in front on
        // screen, so it's left as it is; the other is parked again.
        let s = Setup([21: boundsA, 22: boundsB, 25: boundsC], pid: safari)
        s.world.active = 1 // the Desktop: the windows that came back are on screen
        let window = { (n: Int, b: CGRect) in ParkingMarker.Window(number: n, link: "safari:a", windowId: n, copy: nil, pid: safari, bounds: [b.minX, b.minY, b.width, b.height].map(Double.init)) }
        let crashed = ParkingMarker(pid: 99999, build: nil, at: 1, count: 2, windows: [window(21, boundsA), window(22, boundsB)], shown: [ParkingMarker.Shown(link: "safari:e", number: 25)])
        let front = [21, 22, 25].enumerated().map { i, n in ServerWindow(number: n, pid: safari, bounds: s.world.windows[n]!.bounds, onScreen: true, order: i) }
        var parked: Int?
        s.registry.adoptAfterCrash(crashed, safariPids: [safari], front: front) { parked = $0 }
        check("registry: after a crash, the window in front left as it is (the person's), the other parked again",
              said.last == "handoff: Margin.app didn't quit cleanly with 2 parked windows: 1 parked again, left as normal windows: 1 in front", "\(said)")
        s.clock.advance(1)
        check("registry: … only that one parked", parked == 1 && s.registry.numbers == [22] && s.world.spaces(of: 21) == [1])
        said = []
    }
    do {
        // The shown window closed since, and nothing else of Safari's in a user Space: the one most in front stays.
        let s = Setup([21: boundsA, 22: boundsB], pid: safari)
        let window = { (n: Int, b: CGRect) in ParkingMarker.Window(number: n, link: "safari:a", windowId: n, copy: nil, pid: safari, bounds: [b.minX, b.minY, b.width, b.height].map(Double.init)) }
        let crashed = ParkingMarker(pid: 99999, build: nil, at: 1, count: 2, windows: [window(21, boundsA), window(22, boundsB)], shown: [ParkingMarker.Shown(link: "safari:e", number: 25)])
        let front = [22, 21].enumerated().map { i, n in ServerWindow(number: n, pid: safari, bounds: s.world.windows[n]!.bounds, onScreen: false, order: i) }
        var parked: Int?
        s.registry.adoptAfterCrash(crashed, safariPids: [safari], front: front) { parked = $0 }
        s.clock.advance(1)
        check("registry: after a crash with no other window to show: the one most in front left, the rest parked",
              parked == 1 && s.registry.numbers == [21] && s.world.spaces(of: 22) == [1] && said.contains { $0.hasSuffix("left as normal windows: 1 kept so a window shows") }, "\(said)")
        said = []
    }
}
