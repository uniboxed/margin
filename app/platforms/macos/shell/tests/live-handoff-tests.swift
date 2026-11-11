// The real handoff machine against independent browser/Space fakes. The cover is a
// controllable acknowledgement boundary, not a second implementation of its gates.
// No AppKit window, browser, private call, wall-clock wait or compositor is used.
import Foundation

final class FakeHandoffCover: HandoffCover {
    var state = LiveCoverState.idle
    var windowNumbers: Set<Int> { state == .shown ? [99001] : [] }
    var onEmergency: (() -> Void)?
    let clock: FakeClock
    var contexts: [LiveCoverContext] = []
    var activations: [(Bool) -> Void] = []
    var activatedAt: Double?
    var ends: [(why: RevealWhy, at: Double)] = []
    var recoveryCalls = 0
    var onEnd: ((RevealWhy) -> Void)?

    init(clock: FakeClock) { self.clock = clock }
    func prepare(_ context: LiveCoverContext) { contexts.append(context); state = .preparing }
    func prepared() { state = .prepared }
    func activate(_ done: @escaping (Bool) -> Void) { state = .showing; activations.append(done) }
    func acknowledge(_ ok: Bool) {
        state = ok ? .shown : .failed("fake activation refused")
        if ok { activatedAt = clock.now() }
        activations.last?(ok)
    }
    // Deliver a callback already queued by another process, without resurrecting
    // the page that end() disposed. This deliberately bypasses fake state updates.
    func staleAcknowledgement(_ index: Int, _ ok: Bool) { activations[index](ok) }
    func recovering() { recoveryCalls += 1 }
    @discardableResult func end(_ why: RevealWhy) -> Bool {
        guard state != .idle else { return true }
        onEnd?(why)
        ends.append((why, clock.now()))
        state = .idle
        onEmergency = nil
        return true
    }
}

private func liveHandoffSetup(_ build: (FakeHandoffWorld) -> Void = { _ in }) -> (FakeHandoffWorld, ProfileSwitch, FakeHandoffCover) {
    let (w, s) = handoffSetup(build)
    let cover = FakeHandoffCover(clock: w.clock)
    w.liveCover = cover
    return (w, s, cover)
}

private func beginLiveHandoff(_ w: FakeHandoffWorld, _ s: ProfileSwitch, _ cover: FakeHandoffCover,
                              _ target: ProfileSwitch.Target) {
    s.start(target, from: hA, windowId: 10)
    check("live cover: source context requested", handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty })
    cover.prepared()
    check("live cover: activation requested", handoffUntil(w, max: 0.3) { !cover.activations.isEmpty })
    cover.acknowledge(true)
}

func liveHandoffTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let toB = ProfileSwitch.Target(profile: hB, space: "b1")
    let toC = ProfileSwitch.Target(profile: hC, space: "c1")

    do {
        let suite = "margin-live-policy-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        check("live policy: absent preference enables live cover", LiveCoverPolicy.requested(defaults))
        defaults.set(false, forKey: "MarginLiveProfileCover")
        check("live policy: explicit opt-out remains respected", !LiveCoverPolicy.requested(defaults))
        defaults.set(true, forKey: "MarginLiveProfileCover")
        check("live policy: explicit opt-in remains respected", LiveCoverPolicy.requested(defaults))
    }
    do {
        let (w, s, cover) = liveHandoffSetup { $0.handoffLowPowerMode = true }
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 5) { !s.busy }
        check("low power: freeze completes with no live allocation", w.events.last == .done(toB)
              && cover.contexts.isEmpty && w.freezer.calls.contains("freeze 1.7 s: 0"))
        check("low power: source parked and target ready without demoting live", w.registry.isParked(1010)
              && w.fullAndInFront(hKB) && s.session.coverOff == nil && s.session.rules.on)
        w.handoffLowPowerMode = false
        s.start(.init(profile: hA, space: "a1"), from: hB, windowId: 20)
        check("low power off: next switch prepares live without restart", handoffUntil(w, max: 0.5) { !cover.contexts.isEmpty })
        cover.prepared()
        handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }
        cover.acknowledge(true)
        handoffUntil(w, max: 5) { !s.busy }
        check("low power off: return completes with live cleanup", w.events.last == .done(.init(profile: hA, space: "a1"))
              && cover.ends.map(\.why) == [.ready] && w.fullAndInFront(hKA))
    }
    do {
        let (w, s, cover) = liveHandoffSetup()
        beginLiveHandoff(w, s, cover, toB)
        w.handoffLowPowerMode = true
        handoffUntil(w, max: 5) { !s.busy }
        check("low power mid-switch: existing cover finishes and disposes normally", w.events.last == .done(toB)
              && cover.ends.map(\.why) == [.ready] && w.freezer.calls.isEmpty && w.fullAndInFront(hKB))
    }

    for allowed in [false, true] {
        let (w, s, cover) = liveHandoffSetup { $0.devAllowed = allowed }
        s.session.dev.cover = false
        if allowed {
            s.start(toB, from: hA, windowId: 10)
            handoffUntil(w, max: 5) { !s.busy }
            check("live cover benchmark: guarded cap uses actual freeze without allocating cover", w.events.last == .done(toB) && cover.contexts.isEmpty && w.freezer.calls.contains("freeze 1.7 s: 0"))
        } else {
            beginLiveHandoff(w, s, cover, toB)
            handoffUntil(w, max: 5) { !s.busy }
            check("live cover benchmark: cap cannot affect a non-test switch", w.events.last == .done(toB) && cover.ends.map(\.why) == [.ready] && w.freezer.calls.isEmpty)
        }
        check("live cover benchmark: cap does not reset or demote genuine session gates", s.session.coverOff == nil && s.session.rules.on)
    }

    do {
        let (w, s) = handoffSetup()
        s.start(toB, from: hA, windowId: 10)
        check("live cover default off: existing freeze path starts", handoffUntil(w, max: 0.5) { s.phase == .frozen }
              && w.handoffCover == nil && w.freezer.isLive)
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover default off: existing park/freeze result unchanged", w.events.last == .done(toB)
              && w.registry.isParked(1010) && w.fullAndInFront(hKB)
              && w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"])
    }

    for why: RevealWhy in [.sleep, .safariQuit, .quit] {
        let (w, s, cover) = liveHandoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        s.revealNow(why)
        check("live cover preparing interruption \(why): prepared resources disposed immediately", !s.busy
              && cover.state == .idle && cover.ends.map(\.why) == [why] && cover.activations.isEmpty && w.freezer.calls.isEmpty)
    }

    // Both ways of obtaining B must wait for the live page AND its activation.
    for target in [toB, toC] {
        let (w, s, cover) = liveHandoffSetup()
        s.start(target, from: hA, windowId: 10)
        handoffRun(w, 0.2)
        check("live cover preparation: no create or show for \(target.profile)", cover.state == .preparing
              && w.types(nil, "openSpaceWindow").isEmpty && w.registry.isParked(2020)
              && w.types(nil, "setWindowState").isEmpty && w.types(nil, "setSpace").isEmpty && w.freezer.calls.isEmpty)
        cover.prepared()
        handoffUntil(w, max: 0.2) { s.phase == .covering }
        handoffRun(w, 0.2)
        check("live cover activation: no create or show for \(target.profile)", s.phase == .covering
              && w.types(nil, "openSpaceWindow").isEmpty && w.registry.isParked(2020)
              && w.types(nil, "setWindowState").isEmpty && w.freezer.calls.isEmpty)
        cover.acknowledge(true)
        check("live cover activation: explicit covered phase, no freezer", s.phase == .covered && w.freezer.calls.isEmpty)
        handoffUntil(w, max: 5) { !s.busy }
        let transition = w.requests.filter { ["openSpaceWindow", "setWindowState", "closeWindow"].contains($0.type) }
        check("live cover activation: browser transitions follow shown acknowledgement", !transition.isEmpty
              && transition.allSatisfy { $0.covered && !$0.frozen && $0.at >= (cover.activatedAt ?? .infinity) })
        check("live cover activation: finishes without any freeze", w.events.last == .done(target)
              && cover.ends.map(\.why) == [.ready] && cover.windowNumbers.isEmpty && w.freezer.calls.isEmpty)
        check("live cover diagnostics: timings use live phase origin and retain request-to-reveal cost", s.session.lines.last.map {
            $0.contains("request to reveal ") && !$0.contains("shown -") && !$0.contains("B steady -") && !$0.contains("A parked -")
        } == true)
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.spaceSelectionLag = 4 }
        beginLiveHandoff(w, s, cover, toB)
        check("live cover: target space selected only after shown acknowledgement", w.types(hB, "setSpace").count == 1
              && w.types(hB, "setSpace").allSatisfy { $0.covered })
        // Hold the independently received selected-space echo behind the tab
        // and native layout echoes; the cover must not expose the old space.
        handoffUntil(w, max: 3) { w.registry.isParked(1010) }
        handoffRun(w, 0.3)
        check("live cover: selected-space echo is required before reveal", w.fullAndInFront(hKB)
              && w.overlayAbove(hKB) && s.phase == .covered && cover.ends.isEmpty)
        w.update(hKB) { $0.space = "b1" }
        handoffUntil(w, max: 3) { !s.busy }
        check("live cover: matching selected-space echo releases cover", cover.ends.map(\.why) == [.ready] && w.events.last == .done(toB))
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.wrongBounds = [hKB] }
        beginLiveHandoff(w, s, cover, toB)
        handoffUntil(w, max: 2) { w.fullAndInFront(hKB) }
        handoffRun(w, 0.08)
        check("live cover R1 alone: source remains full screen until destination fills display", w.win(hKA)?.state == "fullscreen"
              && w.types(hA, "setWindowState").isEmpty && cover.state == .shown)
        w.reads.windows[2020]?.bounds = w.display
        check("live cover R1 plus steady R2: source may leave", handoffUntil(w, max: 0.3) { !w.types(hA, "setWindowState").isEmpty }
              && w.types(hA, "setWindowState").first?.state == "normal")
        handoffUntil(w, max: 3) { !s.busy }
        check("live cover R1/R2: destination ready and source parked at reveal", cover.ends.map(\.why) == [.ready]
              && w.registry.isParked(1010) && w.fullAndInFront(hKB))
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.enterLag[hB] = 2.2; $0.slowExit[hKA] = 0.7 }
        var safeAtReveal = false
        cover.onEnd = { why in
            if why == .ready { safeAtReveal = w.registry.isParked(1010) && w.reads.readsParked(1010) == true
                && w.fullAndInFront(hKB) && w.overlayAbove(hKB) }
        }
        beginLiveHandoff(w, s, cover, toB)
        handoffRun(w, 1.8)
        check("live cover: crossing freeze watchdog cannot reveal or touch A early", s.phase == .covered
              && cover.state == .shown && cover.ends.isEmpty && w.types(hA, "setWindowState").isEmpty && w.freezer.calls.isEmpty)
        handoffUntil(w, max: 1) { !w.types(hA, "setWindowState").isEmpty }
        let aStart = w.types(hA, "setWindowState").first?.at
        check("live cover: source can start after freeze latest-A-start limit", aStart.map { $0 - (cover.activatedAt ?? $0) > 1.15 } == true
              && cover.state == .shown && !w.registry.isParked(1010))
        handoffUntil(w, max: 3) { !s.busy }
        check("live cover: reveal waits for actual park and framed front destination", safeAtReveal
              && cover.ends.map(\.why) == [.ready] && w.events.last == .done(toB) && w.freezer.calls.isEmpty)
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.blockedOverlays = [hKB] }
        beginLiveHandoff(w, s, cover, toB)
        handoffUntil(w, max: 3) { w.registry.isParked(1010) }
        handoffRun(w, 0.3) // exceeds the legacy R4 framedWait fallback
        check("live cover: actual destination layout readiness has no short fallback reveal", w.registry.isParked(1010)
              && w.fullAndInFront(hKB) && cover.state == .shown && cover.ends.isEmpty && s.phase == .covered)
        w.blockedOverlays.remove(hKB)
        handoffUntil(w, max: 3) { !s.busy }
        check("live cover: destination layout readiness releases cover", cover.ends.map(\.why) == [.ready] && w.events.last == .done(toB))
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.blockedFront = [hKB] }
        beginLiveHandoff(w, s, cover, toB)
        handoffUntil(w, max: 2) { w.fullAndInFront(hKB) }
        handoffRun(w, 0.3)
        check("live cover: active destination Space does not substitute for front window", w.fullAndInFront(hKB)
              && w.overlayAbove(hKB) && !w.inFront(hB, windowId: 20) && cover.state == .shown && cover.ends.isEmpty
              && w.win(hKA)?.state == "fullscreen" && w.types(hA, "setWindowState").isEmpty)
        check("live cover: front repair requested once under cover", w.types(hB, "focusWindow").count == 1
              && w.types(hB, "focusWindow").allSatisfy { $0.covered && !$0.frozen })
        w.blockedFront.remove(hKB)
        handoffUntil(w, max: 3) { !s.busy }
        check("live cover: confirmed front destination releases cover", cover.ends.map(\.why) == [.ready] && w.events.last == .done(toB))
    }

    // A cover failure changes its own session gate; it must preserve existing freeze rules.
    for freezeDisabled in [false, true] {
        let (w, s, cover) = liveHandoffSetup()
        if freezeDisabled {
            s.session.rules.note(.freezeFailed(result: 44), at: w.clock.now())
            s.session.rules.note(.freezeFailed(result: 44), at: w.clock.now())
        }
        let failuresBefore = s.session.rules.failedInARow
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        cover.state = .failed("fake content failed")
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover setup failure: usable fallback with freeze disabled=\(freezeDisabled)", w.events.last == .done(toB)
              && w.fullAndInFront(hKB) && cover.ends.map(\.why) == [.failed] && s.session.coverOff != nil)
        check("live cover setup failure: independent FreezeRules disabled=\(freezeDisabled)", s.session.rules.on == !freezeDisabled
              && s.session.rules.failedInARow == failuresBefore && (w.freezer.calls.isEmpty == freezeDisabled))
    }

    do {
        let (w, s, cover) = liveHandoffSetup()
        s.session.rules.note(.freezeFailed(result: 44), at: w.clock.now())
        s.session.rules.note(.freezeFailed(result: 44), at: w.clock.now())
        beginLiveHandoff(w, s, cover, toB)
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover: freeze session failure does not disable independent cover", cover.ends.map(\.why) == [.ready]
              && w.events.last == .done(toB) && !s.session.rules.on && s.session.rules.failedInARow == 2 && w.freezer.calls.isEmpty)
    }

    // Content/activation timeouts and refusal must fall back without accepting a
    // delayed activation as permission to start a second transition.
    for failure in ["content timeout", "activation timeout", "activation refused"] {
        let (w, s, cover) = liveHandoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        if failure != "content timeout" {
            cover.prepared()
            handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }
            if failure == "activation refused" { cover.acknowledge(false) }
        }
        handoffUntil(w, max: 2) { !cover.ends.isEmpty }
        let activationsBefore = cover.activations.count
        if activationsBefore > 0 { cover.staleAcknowledgement(0, true) }
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover \(failure): fallback cleans page and makes one transition", cover.ends.map(\.why) == [.failed]
              && cover.state == .idle && w.events.last == .done(toB)
              && w.types(hB, "setWindowState").count == 1 && w.freezer.calls == ["freeze 1.7 s: 0", "reveal 1 ready: 0"])
        // A refusal is a failure: off for the session. A time-out is that switch's: the next one tries the cover again.
        if failure == "activation refused" {
            check("live cover activation refused: off for the session", s.session.coverOff != nil)
        } else {
            check("live cover \(failure): one time-out doesn't turn the cover off for the session",
                  s.session.coverOff == nil && s.session.coverTimeouts == 1, "\(s.session.coverOff ?? "on") \(s.session.coverTimeouts)")
        }
    }

    // Time run out on several switches in a row: off then, as a failure is at once; a live cover through to the end
    // starts the count again.
    do {
        var session = HandoffSession()
        session.coverTimeouts = HandoffSession.coverTimeoutsOff - 1
        let (w, s, cover) = liveHandoffSetup()
        s.session = session
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover: \(HandoffSession.coverTimeoutsOff) time-outs in a row turn it off for the session",
              s.session.coverOff?.contains("\(HandoffSession.coverTimeoutsOff) times in a row") == true, s.session.coverOff ?? "on")
    }
    do {
        let (w, s, cover) = liveHandoffSetup()
        s.session.coverTimeouts = HandoffSession.coverTimeoutsOff - 1
        beginLiveHandoff(w, s, cover, toB)
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover: one through to the end starts the time-outs' count again", cover.ends.map(\.why) == [.ready]
              && s.session.coverTimeouts == 0 && s.session.coverOff == nil)
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.slowExit[hKA] = 0.4 }
        beginLiveHandoff(w, s, cover, toB)
        handoffUntil(w, max: 2) { !w.types(hA, "setWindowState").isEmpty }
        w.blockedOverlays.insert(hKA)
        w.close(hKB)
        handoffUntil(w, max: 0.3) { s.phase == .recovering }
        check("live cover recovery: target loss retains live cover", s.phase == .recovering && cover.state == .shown
              && cover.recoveryCalls == 1 && cover.ends.isEmpty)
        handoffUntil(w, max: 2) { w.fullAndInFront(hKA) }
        handoffRun(w, 0.1)
        check("live cover recovery: source restored but layout missing still covered", w.fullAndInFront(hKA)
              && cover.state == .shown && cover.ends.isEmpty)
        w.blockedOverlays.remove(hKA)
        handoffUntil(w, max: 3) { !s.busy }
        check("live cover recovery: reveal after source and layout ready", cover.ends.map(\.why) == [.failed]
              && w.fullAndInFront(hKA) && w.events.last == .cancelled(toB) && w.freezer.calls.isEmpty)
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.closeWindows = true; $0.hung = [hKA] }
        var closedAtReveal = false
        cover.onEnd = { why in if why == .ready { closedAtReveal = w.win(hKA) == nil && w.reads.window(1010) == nil && w.fullAndInFront(hKB) } }
        beginLiveHandoff(w, s, cover, toB)
        handoffUntil(w, max: 2) { !w.types(hA, "closeWindow").isEmpty }
        handoffRun(w, 0.2)
        check("live cover close setting: pending close keeps cover", w.win(hKA) != nil && cover.state == .shown && cover.ends.isEmpty)
        w.unhang(hKA)
        handoffUntil(w, max: 3) { !s.busy }
        check("live cover close setting: source actually gone before reveal, no second freeze", closedAtReveal
              && cover.ends.map(\.why) == [.ready] && w.events.last == .done(toB) && w.freezer.calls.isEmpty)
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.linked.remove(hC); $0.opensWindows = true; $0.noFreezer = true }
        s.start(toC, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        check("live cover unlinked new target: no profile window before cover", s.phase == .preparing && w.openedWindowFor.isEmpty)
        cover.prepared()
        handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }
        check("live cover unlinked new target: no profile window before activation acknowledgement", s.phase == .covering && w.openedWindowFor.isEmpty)
        cover.acknowledge(true)
        check("live cover unlinked new target: window requested once under cover without freezer", w.openedWindowFor == [hC]
              && w.openedFrozen == [false] && cover.state == .shown && w.freezer.calls.isEmpty)
        let kc = w.add(hC, id: 30, number: 3030, state: "fullscreen")
        handoffUntil(w, max: 0.3) { s.run?.shownAt != nil }
        // The fake's already-fullscreen fast path does not create a page or
        // emit `framed`. Deliver that independent overlay acknowledgement,
        // just as the native host does when adopting this new linked window.
        check("live cover unlinked new target: window readiness alone still holds cover", cover.state == .shown && cover.ends.isEmpty)
        s.framed(kc, mode: .fullscreen)
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover unlinked new target: connected destination selected and source parked before reveal", w.events.last == .done(toC)
              && w.fullAndInFront(kc) && w.registry.isParked(1010) && cover.ends.map(\.why) == [.ready],
              "phase \(s.phase), events \(w.events), cover \(cover.state), ends \(cover.ends), history \(s.history.suffix(10)), space \(w.activeSpaceId(of: kc) ?? "nil"), front \(w.fullAndInFront(kc)), A parked \(w.registry.isParked(1010)), R1 \(String(describing: s.run?.r1At)), R2 \(String(describing: s.run?.r2At)), R4 \(String(describing: s.run?.framedAt)), R5 \(String(describing: s.run?.r5At)), A done \(String(describing: s.run?.aDone)), A state \(w.win(hKA)?.state ?? "nil")")
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.linked.remove(hC); $0.noFreezer = true }
        beginLiveHandoff(w, s, cover, toC)
        check("live cover unlinked without opener: manual wait has no covering panel", s.phase == .waitingForProfile
              && cover.state == .idle && cover.ends.map(\.why) == [.failed] && w.openedWindowFor.isEmpty && w.freezer.calls.isEmpty)
        let kc = w.add(hC, id: 30, number: 3030, state: "fullscreen")
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover manual opening: existing unprotected fallback completes without orphan cover", w.events.last == .done(toC)
              && w.fullAndInFront(kc) && w.registry.isParked(1010) && cover.state == .idle && cover.activations.count == 1)
    }

    do {
        let (w, s, cover) = liveHandoffSetup { $0.linked.remove(hB) }
        s.start(toB, from: hA, windowId: 10)
        handoffRun(w, 0.2)
        check("live cover unlinked target: wait without showing or creating", s.phase == .waitingForLink
              && cover.contexts.isEmpty && w.registry.isParked(2020) && w.types(nil, "openSpaceWindow").isEmpty)
        w.linked.insert(hB)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        cover.prepared()
        handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }
        cover.acknowledge(true)
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover unlinked target: reconnect uses existing window under cover", w.events.last == .done(toB)
              && w.fullAndInFront(hKB) && w.types(nil, "openSpaceWindow").isEmpty && w.freezer.calls.isEmpty)
    }

    do {
        let (w, s, cover) = liveHandoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        cover.prepared()
        handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }
        s.start(.init(profile: hA, space: "a2"), from: hA, windowId: 10)
        let transitions = w.types(nil, "setWindowState").count
        cover.staleAcknowledgement(0, true)
        handoffRun(w, 0.3)
        check("live cover cancellation: late activation cannot start browser work", !s.busy && cover.state == .idle
              && cover.ends.map(\.why) == [.cancelled] && w.registry.isParked(2020)
              && w.types(nil, "setWindowState").count == transitions && w.types(nil, "openSpaceWindow").isEmpty && w.freezer.calls.isEmpty)
    }

    do {
        let (w, s, cover) = liveHandoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        cover.prepared()
        handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }
        s.start(toC, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { cover.contexts.count == 2 }
        cover.prepared()
        handoffUntil(w, max: 0.3) { cover.activations.count == 2 }
        cover.staleAcknowledgement(0, true)
        handoffRun(w, 0.1)
        check("live cover replacement: earlier run callback cannot activate newer run", s.phase == .covering
              && w.types(nil, "openSpaceWindow").isEmpty && w.types(nil, "setWindowState").isEmpty && w.registry.isParked(2020))
        cover.acknowledge(true)
        handoffUntil(w, max: 4) { !s.busy }
        check("live cover replacement: only new destination opens after its acknowledgement", w.events.last == .done(toC)
              && w.types(hC, "openSpaceWindow").count == 1 && w.types(hB, "setWindowState").isEmpty
              && cover.ends.map(\.why) == [.cancelled, .ready] && w.freezer.calls.isEmpty)
    }

    for acknowledged in [false, true] {
        let (w, s, cover) = liveHandoffSetup()
        s.start(toB, from: hA, windowId: 10)
        handoffUntil(w, max: 0.3) { !cover.contexts.isEmpty }
        cover.prepared()
        handoffUntil(w, max: 0.3) { !cover.activations.isEmpty }
        if acknowledged { cover.acknowledge(true) }
        s.revealNow(.sleep)
        cover.staleAcknowledgement(0, true)
        handoffRun(w, 4)
        check("live cover sleep: disposes cover and ignores late activation, active=\(acknowledged)", cover.state == .idle
              && cover.ends.map(\.why) == [.sleep] && cover.onEmergency == nil && w.freezer.calls.isEmpty && s.session.noFreeze == .sleep)
        check("live cover sleep: source remains recoverable, active=\(acknowledged)", !s.busy && w.fullAndInFront(hKA))
        s.woke()
        check("live cover sleep: wake clears only sleep gate", s.session.noFreeze == nil)
    }
}
