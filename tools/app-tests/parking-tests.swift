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
    }
}
