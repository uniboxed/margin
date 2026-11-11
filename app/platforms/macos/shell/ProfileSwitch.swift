// Switching to a space of another browser profile. Two ways, one machine:
//
// - The handoff (Handoff.swift, docs/HANDOFF.md §1 with the answers in §13):
//   the screen frozen while the target profile's window is shown and put in
//   full screen, and the window left is parked out of sight (or closed, or kept
//   in its own full-screen Space). It runs when the world is a HandoffWorld with
//   the handoff on (the shell's gate) and the Space reads, and each switch picks its freeze and the old window's fate
//   from what passed at launch, what failed this session, the setting and the
//   displays at that moment.
// - The close-based switch below (PLAN.md §15, 2026-11-05), the fallback:
//   the target profile's copy creates its full-screen window showing the space,
//   and only once that window is full screen and in front (its new Space the
//   active one) is the old profile's window closed. Its tabs aren't lost: a
//   window closing keeps them as not-open Margin tabs (docs/DATA.md), and switching
//   back opens the space's tabs again from those records. macOS's Space slide
//   is seen. It runs when there's no handoff world, no Space reads or no
//   display read (unsure: never a guess), and when a switch would close the old
//   window without a freeze and the target has no parked window to show. In a
//   HandoffWorld it asks the old window's drafts first (§1.1): a draft, or no
//   answer, keeps it open.
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
    // Asks the browser for a new window in `profile` itself (Safari's File › New Window menu, through
    // Accessibility: SafariAX.swift), for a profile whose copy isn't running. False: it can't.
    func openProfileWindow(_ profile: String) -> Bool
    // Margin's extension turned off in `profile`, as the browser's own settings say (Safari can turn it off as Margin
    // updates: seen 2026-11-08): its copy never starts, so the switch fails at once and says so, no window opened.
    func marginOff(_ profile: String) -> Bool
}

extension SwitchWorld {
    func openProfileWindow(_ profile: String) -> Bool { false }
    func marginOff(_ profile: String) -> Bool { false }
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
    enum Phase: String {
        case idle
        case waitingForProfile // its copy isn't running, and it has no parked window: the person opens one
        // The handoff's (Handoff.swift, docs/HANDOFF.md §1.2). The overlay draws the cover over the
        // window left while the phase is preparing, waitingForLink or frozen (ui/view-model.ts).
        case waitingForLink // its copy isn't linked, but it has a parked window: up to 3 s
        case preparing // the cover up, the target picked, blockers checked, its space set, drafts asked
        case frozen // the steps: under the freeze when there is one, else the same steps seen
        case covering // live cover activating; no browser transition has started
        case covered // live cover's readiness/old-window gates, independent of FreezeRules
        case after // unfrozen: a late park, the focus check, then landed
        case landed // every step done, waiting for the Spaces to stay still
        case recovering // a step failed: back to a visible window (§4.4)
        // The close-based switch's; closing and checking are also close mode's A closed under its
        // second freeze, and the Desktop drop's check after it, seen (Handoff.swift, §4.5).
        case creating, settling, closing, checking
    }
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
        // For the profile's copy to link once Margin opened its window itself (it links in 1-2 s; longer, Margin
        // is off in that profile, and the person is told so: ShellProfiles.switchChanged).
        var openedProfileWait: TimeInterval = 10
        var poll: TimeInterval = 0.05
        var handoff = HandoffOptions() // the handoff's own (Handoff.swift)
    }

    // Set here and by the handoff (Handoff.swift).
    var phase = Phase.idle
    var target: Target?
    var from: (profile: String, windowId: Int?)?
    private var closeLine: Int? // the close-based switch's Margin window (docs/BROWSER-WINDOWS.md §2.3), from its start
    var newWindow: Int? // the target's window: made by the switch, or the one it shows
    var queued: Target?
    private(set) var history: [String] = [] // what happened, for the tests and the log
    weak var world: SwitchWorld?
    let clock: SwitchClock
    var options: Options
    var gen = 0
    var deadline: Double = 0
    var phaseSince: Double = 0
    private var adopted = false // the window was the profile's already: never closed by a failure
    private var fullScreenAsked = false
    private var tries = 0
    private var pollTimer: SwitchTimer?
    // The close-based switch in a HandoffWorld: the old window's drafts, asked as it starts (§1.1).
    private var drafts: WindowDrafts?
    private var draftsAsked = false

    // The switch's notices (a kept window, a dialog, …), told once its end is: the shell's words for
    // an event take the place of any notice up before it.
    var notices: [SwitchNotice] = []

    // The handoff's: the switch under way, and what lasts the session (Handoff.swift).
    var run: HandoffRun?
    var session = HandoffSession()

    init(world: SwitchWorld, clock: SwitchClock = RunLoopClock(), options: Options = Options()) {
        self.world = world
        self.clock = clock
        self.options = options
    }

    var busy: Bool { phase != .idle }

    // A copy's error can reach a line here (its words, not Margin's): scrubbed of addresses and titles.
    func note(_ s: String) {
        let line = Diagnostics.scrub(s)
        history.append(line)
        Diagnostics.note("profile switch: \(line)")
    }

    func enter(_ p: Phase, for seconds: Double) {
        phase = p
        phaseSince = clock.now()
        deadline = phaseSince + seconds
    }

    // Switch from `windowId` of `fromProfile` to `to`. A switch under way: this one waits (the last
    // asked wins), or, for a handoff not frozen yet, takes its place (§1.7). `asked`: the window whose
    // own activity asks for it (a link or the person's focus in a parked window, §6.1).
    func start(_ to: Target, from fromProfile: String, windowId: Int?, asked: WindowKey? = nil) {
        guard let world else { return }
        if busy {
            if let run { return handoffAgain(to, run) }
            if to == target { return }
            // Back where it started, before anything was made: the switch ends, nothing to do.
            if to.profile == from?.profile, phase == .waitingForProfile {
                return finish(.cancelled(target!), "back to \(to) while waiting: nothing done")
            }
            queued = to
            return note("\(to) asked mid-switch: after this one")
        }
        if handoffStart(to, from: fromProfile, windowId: windowId, asked: asked) { return }
        gen += 1
        target = to
        from = (fromProfile, windowId)
        newWindow = nil
        adopted = false
        fullScreenAsked = false
        tries = 0
        queued = nil
        drafts = nil
        draftsAsked = false
        closeLine = from.flatMap { f in
            guard let hw = handoffWorld, let parking = hw.parking, let id = f.windowId, let n = hw.number(of: WindowKey(link: f.profile, windowId: id)) else { return nil }
            return parking.lineFor(number: n, link: f.profile)
        }
        world.switchChanged(.started(to))
        askDrafts()
        guard world.isLinked(to.profile) else {
            if world.marginOff(to.profile) { return finish(.failed(to, "Margin is turned off in it"), "Margin is turned off in \(to.profile) (the browser's settings)") }
            // Its copy starts with the window Margin asks Safari for; the switch goes on once it links.
            let opened = world.openProfileWindow(to.profile)
            enter(.waitingForProfile, for: opened ? options.openedProfileWait : options.profileWait)
            if opened {
                note("\(to.profile) isn't linked: asked the browser for a new window of it, waiting for its copy")
            } else {
                note("\(to.profile) isn't linked: waiting for one of its windows")
                world.switchChanged(.needsProfile(to))
            }
            return poll()
        }
        if let w = ownWindow(to.profile) {
            adopt(w.id, fullScreen: w.state == "fullscreen")
        } else {
            create()
        }
        poll()
    }

    // The profile's window to show, never one the handoff has parked (this switch can't bring it out of its
    // private Space, and its registry entry would be left saying parked). With Margin windows (a HandoffWorld's
    // registry, docs/BROWSER-WINDOWS.md §2.3): its Margin window's own, the line's home for the profile, or, `awaited`
    // (the profile had no window), one opened for this switch in no line; another line's, or one in no line,
    // is another Margin window's. Without them: the first its copy lists.
    private func ownWindow(_ profile: String, awaited: Bool = false) -> (id: Int, state: String)? {
        guard let world else { return nil }
        if let hw = handoffWorld, let parking = hw.parking {
            let number = { (id: Int) in hw.number(of: WindowKey(link: profile, windowId: id)) }
            let line = closeLine
            let open = world.windows(of: profile).filter { w in number(w.id).map { !parking.isParked($0) } ?? true }
            if let home = line.flatMap({ parking.lines[$0]?.homes[profile] }), let w = open.first(where: { number($0.id) == home }) { return w }
            return awaited ? open.first { w in number(w.id).map { parking.line(of: $0) == nil } ?? true } : nil
        }
        let parked = handoffWorld?.parking?.numbers ?? []
        return world.windows(of: profile).first { w in
            guard !parked.isEmpty, let hw = handoffWorld, let n = hw.number(of: WindowKey(link: profile, windowId: w.id)) else { return true }
            return !parked.contains(n)
        }
    }

    // In a HandoffWorld, the old window's drafts before it may be closed (HANDOFF.md §1.1): asked now,
    // answered long before the new window is in front.
    private func askDrafts() {
        guard handoffWorld != nil, let from, let old = from.windowId, from.profile != target?.profile, let world, world.isLinked(from.profile) else { return }
        draftsAsked = true
        let g = gen
        world.request(from.profile, "windowDrafts", HandoffRequest.windowDrafts(windowId: old).payload, windowId: old) { [weak self] result, _ in
            guard let self, g == self.gen else { return }
            self.drafts = result.flatMap { WindowDrafts($0) }
        }
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

    // Looked at again on every poll: the handoff every 8 ms, the close-based switch every 50 ms, and
    // the aftercare's watches (Handoff.swift) every 100 ms while there are any, as is the setting's
    // close of parked windows asked for mid-switch.
    func poll() {
        pollTimer?.cancel()
        let waiting = phase == .waitingForProfile || phase == .waitingForLink
        let idleWork = !session.watches.isEmpty || session.closeParkedAsked // the aftercare, or §5's close after a switch
        let every: Double? = run != nil && !waiting ? options.handoff.poll : busy ? options.poll : idleWork ? options.handoff.watchPoll : nil
        guard let every else { return }
        pollTimer = clock.after(every) { [weak self] in self?.tick() }
    }

    // Looked at again: on every window list, link change and window-server read, and every `poll`.
    func tick() {
        defer { poll() }
        aftercare()
        if let run { return handoffStep(run) }
        guard let world, let to = target, busy else { return }
        let now = clock.now()
        // A copy gone mid-switch (Safari quitting, the extension turned off): nothing more is done.
        if phase != .waitingForProfile, !world.isLinked(to.profile) {
            return finish(.failed(to, "Safari stopped answering"), "\(to.profile)'s copy went away mid-switch")
        }
        switch phase {
        case .idle, .waitingForLink, .preparing, .covering, .covered, .frozen, .after, .landed, .recovering:
            return
        case .waitingForProfile:
            if world.isLinked(to.profile), let w = ownWindow(to.profile, awaited: true) {
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
        // A draft in it, or no answer: kept in its own full-screen Space, and the person told (§4.5).
        if draftsAsked, drafts?.mayClose != true {
            note("\(from.profile) window \(old) kept open: \(drafts.map { "\($0.drafts.count) with drafts, \($0.unknown.count) unknown" } ?? "no drafts answer")")
            let kept = WindowKey(link: from.profile, windowId: old)
            notices.append(SwitchNotice(.windowKeptDraft, profile: from.profile, shownIn: newWindow.map { WindowKey(link: to.profile, windowId: $0) }, kept: kept))
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

    // The switch ends. `landed`: where it ended up (the handoff says; otherwise the new window when
    // done, else the old one). What was asked meanwhile starts from there.
    func finish(_ event: Event, _ why: String, landed given: (profile: String, windowId: Int?)? = nil) {
        guard let world else { return }
        if let run, let hw = world as? HandoffWorld { endLiveCover(run, hw, .cancelled) }
        note(why)
        let landed: (profile: String, windowId: Int?)?
        if let given {
            landed = given
        } else {
            switch event {
            case .done(let t): landed = (t.profile, newWindow)
            default: landed = from
            }
        }
        let next = queued
        // The close-based switch in a HandoffWorld landed: its window is the shown one now (§13.8 judges a
        // close against it), and its Margin window's home for its profile (docs/BROWSER-WINDOWS.md §2.3).
        if run == nil, case .done(let t) = event, let id = newWindow, let hw = handoffWorld {
            let key = WindowKey(link: t.profile, windowId: id)
            let n = hw.number(of: key)
            session.shown = (key, n)
            if let n, let parking = hw.parking {
                parking.noteShown(link: t.profile, number: n, line: closeLine ?? parking.lineFor(number: n, link: t.profile))
            }
        }
        gen += 1
        phase = .idle
        run = nil
        pollTimer?.cancel()
        queued = nil
        world.switchChanged(event)
        target = nil
        let told = notices
        notices = []
        defer {
            if let hw = handoffWorld { for n in told { hw.showSwitchNotice(n) } }
            poll()
        }
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

// One of the switch's notices: its kind, the profile it's about (a link key,
// "safari:s-a"), the one window whose overlay shows it (none: every overlay),
// and, for a window kept open with a draft, that window (its Close window
// button closes it: no drafts check then, decided 2026-11-06). Only the kind,
// the profile's id and the window go to overlays; the words are theirs.
struct SwitchNotice: Equatable {
    enum Kind: String {
        case windowKeptDraft = "window-kept-draft" // close mode kept the window it left: a draft in it (§4.5)
        case dialogOpen = "dialog-open" // a sheet or dialog on the window being left (§1.10)
        case windowBusy = "window-busy" // a windows call stuck in the window being left (§1.10)
        case lateLanding = "late-landing" // a switch that gave up landed after all (§1.9)
        case windowOnDesktop = "window-on-desktop" // the copy didn't come back: its window returned to the Desktop (§1.5)
    }
    let kind: Kind
    let profile: String
    var shownIn: WindowKey?
    var kept: WindowKey?
    // How long it stays up unless a button closes it first.
    var seconds: TimeInterval { kind == .windowKeptDraft ? 20 : 8 }

    // As Shell.switchNotice keeps it: what overlays get, and the kept window (never sent).
    var stored: JSONObject {
        var o: JSONObject = ["noticeKind": kind.rawValue, "noticeProfile": Self.profileId(profile)]
        if let w = shownIn { o["noticeIn"] = ["profile": Self.profileId(w.link), "windowId": w.windowId] }
        if let k = kept { o["kept"] = ["link": k.link, "windowId": k.windowId] }
        return o
    }

    init(_ kind: Kind, profile: String, shownIn: WindowKey? = nil, kept: WindowKey? = nil) {
        self.kind = kind
        self.profile = profile
        self.shownIn = shownIn
        self.kept = kept
    }

    // The window a stored notice kept open, if it's that kind's.
    static func kept(_ stored: JSONObject?) -> WindowKey? {
        guard stored?["noticeKind"] as? String == Kind.windowKeptDraft.rawValue, let k = stored?["kept"] as? JSONObject,
              let link = k["link"] as? String, let id = int(k["windowId"]) else { return nil }
        return WindowKey(link: link, windowId: id)
    }

    // What of a stored notice an overlay gets (`across.switching`): never the kept window.
    static func sent(_ stored: JSONObject) -> JSONObject { stored.filter { ["notice", "noticeKind", "noticeProfile", "noticeIn"].contains($0.key) } }

    // A link key's profile id ("safari:s-a" → "s-a"), as overlays name profiles.
    static func profileId(_ link: String) -> String {
        guard let colon = link.firstIndex(of: ":") else { return link }
        return String(link[link.index(after: colon)...])
    }
}
