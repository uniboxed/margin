// Switching to a space of another browser profile (PLAN.md §15, Tirth
// 2026-11-05): only one browser window exists at a time, so the target
// profile's copy creates its full-screen window showing the space, and only
// once that window is full screen and in front (its new Space the active
// one) is the old profile's window closed. Its tabs aren't lost: a window
// closing keeps them as not-open Margin tabs (DATA.md), and switching back
// opens the space's tabs again from those records. macOS's Space slide is
// accepted; no private calls.
//
//   idle ─start─▶ creating ─reply─▶ settling ─full screen, in front─▶ closing ─▶ checking ─▶ idle
//                  │                  │ (a normal window: asked once for full screen)
//                  │                  └ too long / the window gone: the new one closed (unless it was
//                  │                    already there), the old one brought back
//                  └ no answer in time / refused: nothing closed; a late answer's window is closed
//   start with the target's copy not linked ─▶ waitingForProfile: the person
//   opens one of its windows (File › New Window); once its copy links and has
//   a window, that window shows the space and the switch goes on from settling.
//   After the old window closes, the new one must still be in front: if
//   macOS dropped to the desktop instead, its copy focuses it again (twice).
//   A switch asked for while one is under way waits for it, the last one asked
//   wins. A copy going away mid-switch (Safari quitting) ends it with nothing done.
//
// The world (the links, the copies' window lists, the window server) and the
// clock are the shell's (Shell.swift); the unit tests give fakes.

import Foundation

protocol SwitchWorld: AnyObject {
    func isLinked(_ profile: String) -> Bool
    // A `req` to the profile's copy: `done(result, nil)` or `done(nil, error)`, on the main actor.
    func request(_ profile: String, _ type: String, _ payload: JSONObject, windowId: Int?, done: @escaping (JSONObject?, String?) -> Void)
    // The copy's windows as it last said: id and state (normal, fullscreen, …).
    func windows(of profile: String) -> [(id: Int, state: String)]
    // The window is the browser's first window on screen: its Space is the active one (the window server).
    func inFront(_ profile: String, windowId: Int) -> Bool
    // Something to tell the person (ProfileSwitch.Event).
    func switchChanged(_ event: ProfileSwitch.Event)
}

protocol SwitchClock {
    func now() -> Double
    @discardableResult func after(_ seconds: Double, _ fire: @escaping () -> Void) -> SwitchTimer
}
protocol SwitchTimer { func cancel() }

final class RunLoopClock: SwitchClock {
    final class T: SwitchTimer { var timer: Timer?; func cancel() { timer?.invalidate() } }
    func now() -> Double { Date().timeIntervalSince1970 }
    func after(_ seconds: Double, _ fire: @escaping () -> Void) -> SwitchTimer {
        let t = T()
        t.timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in MainActor.assumeIsolated { fire() } }
        return t
    }
}

final class ProfileSwitch {
    struct Target: Equatable, CustomStringConvertible {
        let profile: String
        let space: String
        var description: String { "\(profile)/\(space)" }
    }
    enum Phase: String { case idle, waitingForProfile, creating, settling, closing, checking }
    enum Event: Equatable {
        case started(Target)
        case needsProfile(Target) // its copy isn't running: the person opens one of its windows
        case done(Target)
        case failed(Target, String) // why, in Margin's words
        case cancelled(Target) // the person closed the new window, or switched back
    }
    struct Options {
        var createTimeout: TimeInterval = 8 // the copy's answer to openSpaceWindow (1 in 20 creates takes up to 2 s)
        var settleTimeout: TimeInterval = 6 // the new window full screen and in front
        var fullScreenAfter: TimeInterval = 0.4 // a normal window this long: asked for full screen
        var closeTimeout: TimeInterval = 5
        var frontCheck: TimeInterval = 1.2 // after the close, the new window in front by then…
        var frontHold: TimeInterval = 0.5 // …and still, this long after it (macOS can drop to the desktop as the old Space goes)
        var recoverTries = 2
        var profileWait: TimeInterval = 90 // for the person to open the profile's window
        var poll: TimeInterval = 0.05
    }

    private(set) var phase = Phase.idle
    private(set) var target: Target?
    private(set) var from: (profile: String, windowId: Int?)?
    private(set) var newWindow: Int?
    private(set) var queued: Target?
    private(set) var history: [String] = [] // what happened, for the tests and the log
    private weak var world: SwitchWorld?
    private let clock: SwitchClock
    var options: Options
    private var gen = 0
    private var deadline: Double = 0
    private var phaseSince: Double = 0
    private var adopted = false // the window was the profile's already: never closed by a failure
    private var fullScreenAsked = false
    private var tries = 0
    private var pollTimer: SwitchTimer?

    init(world: SwitchWorld, clock: SwitchClock = RunLoopClock(), options: Options = Options()) {
        self.world = world
        self.clock = clock
        self.options = options
    }

    var busy: Bool { phase != .idle }

    private func note(_ s: String) {
        history.append(s)
        Diagnostics.note("profile switch: \(s)")
    }

    private func enter(_ p: Phase, for seconds: Double) {
        phase = p
        phaseSince = clock.now()
        deadline = phaseSince + seconds
    }

    // Switch from `windowId` of `fromProfile` to `to`. A switch under way: this one waits (the last asked wins).
    func start(_ to: Target, from fromProfile: String, windowId: Int?) {
        guard let world else { return }
        if busy {
            if to == target { return }
            // Back where it started, before anything was made: the switch ends, nothing to do.
            if to.profile == from?.profile, phase == .waitingForProfile {
                return finish(.cancelled(target!), "back to \(to) while waiting: nothing done")
            }
            queued = to
            return note("\(to) asked mid-switch: after this one")
        }
        gen += 1
        target = to
        from = (fromProfile, windowId)
        newWindow = nil
        adopted = false
        fullScreenAsked = false
        tries = 0
        queued = nil
        world.switchChanged(.started(to))
        guard world.isLinked(to.profile) else {
            enter(.waitingForProfile, for: options.profileWait)
            note("\(to.profile) isn't linked: waiting for one of its windows")
            world.switchChanged(.needsProfile(to))
            return poll()
        }
        if let w = world.windows(of: to.profile).first {
            adopt(w.id, fullScreen: w.state == "fullscreen")
        } else {
            create()
        }
        poll()
    }

    private func create() {
        guard let world, let to = target else { return }
        enter(.creating, for: options.createTimeout)
        note("create \(to)")
        let g = gen
        world.request(to.profile, "openSpaceWindow", ["spaceId": to.space, "fullscreen": true], windowId: nil) { [weak self] result, error in
            guard let self else { return }
            let id = int(result?["windowId"])
            guard g == self.gen, self.phase == .creating else {
                // Answered after the switch gave up: its window would be a second one.
                if let id { self.note("late window \(id) of \(to.profile): closed"); world.request(to.profile, "closeWindow", ["windowId": id], windowId: id) { _, _ in } }
                return
            }
            guard let id else { return self.finish(.failed(to, "Safari didn’t open a window for it"), "create refused: \(error ?? "no window")") }
            self.newWindow = id
            self.enter(.settling, for: self.options.settleTimeout)
            self.note("created window \(id) (\(result?["state"] as? String ?? "?"))")
            self.tick()
        }
    }

    // The profile's window that's already there (or that the person opened): it shows the space.
    private func adopt(_ id: Int, fullScreen: Bool) {
        guard let world, let to = target else { return }
        adopted = true
        newWindow = id
        enter(.settling, for: options.settleTimeout)
        note("window \(id) of \(to.profile) is there: shown")
        world.request(to.profile, "focusWindow", ["windowId": id, "fullscreen": true], windowId: id) { _, _ in }
        fullScreenAsked = true
        world.request(to.profile, "setSpace", ["windowId": id, "spaceId": to.space], windowId: id) { _, _ in }
    }

    private func poll() {
        pollTimer?.cancel()
        guard busy else { return }
        pollTimer = clock.after(options.poll) { [weak self] in self?.tick() }
    }

    // Looked at again: on every window list, link change and window-server read, and every `poll`.
    func tick() {
        guard let world, let to = target, busy else { return }
        defer { poll() }
        let now = clock.now()
        // A copy gone mid-switch (Safari quitting, the extension turned off): nothing more is done.
        if phase != .waitingForProfile, !world.isLinked(to.profile) {
            return finish(.failed(to, "Safari stopped answering"), "\(to.profile)'s copy went away mid-switch")
        }
        switch phase {
        case .idle:
            return
        case .waitingForProfile:
            if world.isLinked(to.profile), let w = world.windows(of: to.profile).first {
                note("\(to.profile) linked with window \(w.id)")
                return adopt(w.id, fullScreen: w.state == "fullscreen")
            }
            if now >= deadline { return finish(.failed(to, "no window of it was opened"), "gave up waiting for \(to.profile)") }
        case .creating:
            if now >= deadline { return finish(.failed(to, "Safari took too long to open its window"), "create timed out") }
        case .settling:
            guard let id = newWindow, let w = world.windows(of: to.profile).first(where: { $0.id == id }) else {
                if now - phaseSince < 0.5 { return } // the copy's window list may lag its answer
                return cancel(to, "window \(newWindow ?? -1) gone before it was in front")
            }
            if w.state == "fullscreen", world.inFront(to.profile, windowId: id) {
                return closeOld()
            }
            if w.state != "fullscreen", !fullScreenAsked, now - phaseSince >= options.fullScreenAfter {
                fullScreenAsked = true
                note("window \(id) came back \(w.state): asked for full screen")
                world.request(to.profile, "focusWindow", ["windowId": id, "fullscreen": true], windowId: id) { _, _ in }
            }
            if now >= deadline { return undo(to, "Safari’s window didn’t go full screen") }
        case .closing:
            if now >= deadline { checkFront() } // the close never answered: on as if it had
        case .checking:
            guard let id = newWindow else { return }
            if world.inFront(to.profile, windowId: id), now - phaseSince >= options.frontHold { return finish(.done(to), "done: window \(id) in front") }
            if world.windows(of: to.profile).first(where: { $0.id == id }) == nil { return finish(.cancelled(to), "window \(id) closed after the switch") }
            if now >= deadline {
                // macOS showed the desktop instead of the new Space: its copy focuses it again.
                guard tries < options.recoverTries else { return finish(.failed(to, "macOS didn’t show its window: click it in Mission Control"), "not in front after \(tries) tries") }
                tries += 1
                note("not in front after the close: focused again (\(tries))")
                world.request(to.profile, "focusWindow", ["windowId": id, "fullscreen": true], windowId: id) { _, _ in }
                enter(.checking, for: options.frontCheck)
            }
        }
    }

    private func closeOld() {
        guard let world, let to = target else { return }
        guard let from, let old = from.windowId, from.profile != to.profile,
              world.isLinked(from.profile), world.windows(of: from.profile).contains(where: { $0.id == old }) else {
            note("the old window is gone already")
            return checkFront()
        }
        enter(.closing, for: options.closeTimeout)
        note("close \(from.profile) window \(old)")
        let g = gen
        world.request(from.profile, "closeWindow", ["windowId": old], windowId: old) { [weak self] _, error in
            guard let self, g == self.gen, self.phase == .closing else { return }
            if let error { self.note("close answered: \(error)") }
            self.checkFront()
        }
    }

    private func checkFront() {
        enter(.checking, for: options.frontCheck)
        tick()
    }

    // The new window gone before it was in front: the old one stays.
    private func cancel(_ to: Target, _ why: String) {
        bringBackOld()
        finish(.cancelled(to), why)
    }

    // It didn't work: the window made for it closed (not one that was there), the old one back in front.
    private func undo(_ to: Target, _ why: String) {
        if let world, let id = newWindow, !adopted, from?.windowId != nil {
            world.request(to.profile, "closeWindow", ["windowId": id], windowId: id) { _, _ in }
        }
        bringBackOld()
        finish(.failed(to, why), why)
    }

    private func bringBackOld() {
        guard let world, let from, let old = from.windowId, world.isLinked(from.profile),
              world.windows(of: from.profile).contains(where: { $0.id == old }) else { return }
        world.request(from.profile, "focusWindow", ["windowId": old], windowId: old) { _, _ in }
    }

    private func finish(_ event: Event, _ why: String) {
        guard let world else { return }
        note(why)
        let landed: (profile: String, windowId: Int?)?
        switch event {
        case .done(let t): landed = (t.profile, newWindow)
        default: landed = from
        }
        let next = queued
        gen += 1
        phase = .idle
        pollTimer?.cancel()
        queued = nil
        world.switchChanged(event)
        target = nil
        // What was asked meanwhile, from where the switch landed.
        guard let next, let landed, world.isLinked(landed.profile) else { return }
        if next.profile == landed.profile {
            note("then \(next) in the same window")
            world.request(landed.profile, "setSpace", ["windowId": landed.windowId ?? NSNull(), "spaceId": next.space], windowId: landed.windowId) { _, _ in }
        } else {
            start(next, from: landed.profile, windowId: landed.windowId)
        }
    }
}
