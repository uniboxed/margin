// The shell's side of the profile handoff (app/HANDOFF.md §2.3-2.6, §1.7, §6,
// with Tirth's answers in §13): the shell is the switch's HandoffWorld, and
// each read of the window server carries the parked windows along.
//
// - The gate: the handoff runs only with `Options.handoff` on (forApp: the
//   `MarginHandoff` default, until gate G1 has passed for Margin.app) and the
//   Space reads there. Otherwise `handoffOn` is false and the switch treats the
//   shell as a plain SwitchWorld: every switch is the close-based one, exactly
//   as before, and nothing is ever parked.
// - Each read: the aftercare, then the registry's sweep (Safari's processes,
//   the copies' windows, the links held, the windows the switch is moving),
//   a new copy's parked windows bound again, and each copy told which of its
//   windows are parked (`parked`, only a change, like `drawn`).
// - Overlays (Shell.track): a parked window's is hidden, never closed; the
//   window the switch leaves has its overlay ordered out before its Space goes
//   and kept out; the target's is made from the start and shown from the
//   app's own reads. Their `windows` pushes wait for the copy's full screen,
//   their hello says full screen, and no layout goes for them while hidden, so
//   their pages keep their box as it was. Own-Space checks leave them out.
// - Keys mid-switch: the app's while Safari or Margin is in front; the space
//   keys queue a switch from the target, the rest are dropped (§1.7).
// - A parked window used while out of sight (its copy's `parkedActivity`, or
//   the sweep finding the person's focus on it): merged for 150 ms, then one
//   handoff to that window, unless a switch is under way or it's in its
//   aftercare (§6.1).
// - Safari in front with every window parked and no switch to explain it: the
//   window last shown is handed to, after two reads 100 ms apart agree (§6.2).
// - The shown window closed by the person (⌘W, its close button): every parked
//   window of every profile is closed by its copy too, no drafts check (§13.8),
//   unless Safari is quitting. A person's own extra window isn't the shown one.
// - The system's moves (§6.8): going to sleep reveals at once; a wake, a
//   display change or the Dock restarting makes any parked window found back in
//   the next 3 s the system's (parked again, never a handoff).
// - Quit (Shell.stop, §13.1): every parked window closed by its copy.
// - The log has ids, window numbers, counts and milliseconds only.

import AppKit

// The windows gone from their copies' lists, kept from the read that saw them go until the switch
// is idle (§13.8): a window closed while a switch runs is judged once it's over, never lost because
// that read came mid-switch. Margin's own closes are taken out as they go.
struct ShownCloseWatch {
    private(set) var gone: [WindowKey: Int] = [:] // each window's number as it went

    mutating func read(was: Set<WindowKey>, listed: Set<WindowKey>, numbers before: [WindowKey: Int], marginCloses: inout Set<WindowKey>) {
        for key in was.subtracting(listed) {
            if marginCloses.remove(key) != nil { continue }
            if let n = before[key] { gone[key] = n }
        }
        gone = gone.filter { !listed.contains($0.key) } // listed again: not gone
    }

    // Everything kept, to judge now (the switch idle), oldest key first.
    mutating func take() -> [(key: WindowKey, number: Int)] {
        defer { gone = [:] }
        return gone.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    mutating func clear() { gone = [:] }
}

// A harness's stand-ins for macOS's Space reads, the parker and the freezer (Shell.Options).
struct HandoffParts {
    var reads: SpaceReads
    var parker: BridgeParker
    var freezer: Freezer?
}

extension Shell: HandoffWorld {
    // ---- the gate ----

    var handoffOn: Bool { options.handoff && spaceReads != nil }

    // A harness's parts, as the launch check's would be: no self-test, parking on while the parker is.
    func useHandoffParts(_ parts: HandoffParts) {
        spaceReads = parts.reads
        parker = parts.parker
        freezer = parts.freezer
        parking = ParkingRegistry(parker: parts.parker, reads: parts.reads, clock: options.switchClock, marker: parkingMarkerURL, build: nil,
                                  parkingOn: { [weak self] in self?.parkingOn == true && self?.handoffOn == true })
    }

    // ---- HandoffWorld ----

    var handoffFreezer: Freezer? { freezer }

    func closesWindows(_ link: String) -> Bool { profilesOf(Self.browser(of: link)).closeWindows }

    func copyWindows(_ link: String) -> [ExtWindow] {
        guard let entry = links[link] else { return [] }
        return ExtWindow.parse(entry.mirror.windows, link: link)
    }

    func number(of key: WindowKey) -> Int? { matches[key] }

    func key(of number: Int) -> WindowKey? { matches.first { $0.value == number }?.key }

    func activeSpaceId(of key: WindowKey) -> String? {
        let open = links[key.link]?.mirror.value("openTabs") as? JSONObject
        return (open?["activeSpaceByWindow"] as? JSONObject)?[String(key.windowId)] as? String
    }

    func fillsDisplay(_ bounds: CGRect) -> Bool { options.fillsDisplay?(bounds) ?? ScreenGeometry.fillsDisplay(bounds) }

    func browserWindows(of link: String) -> [ServerWindow] {
        let pids = browserPids(Self.browser(of: link))
        return windowSource.windows(of: pids).filter { pids.contains($0.pid) }
    }

    func orderOutOverlay(_ key: WindowKey) {
        heldOut.insert(key)
        overlays[key]?.hide("its window leaves full screen for a switch")
    }

    func overlayOffScreen(_ key: WindowKey) -> Bool { overlays[key].map { !$0.isShown } ?? true }

    func overlayAbove(_ key: WindowKey) -> Bool {
        guard let overlay = overlays[key], overlay.isShown, let number = matches[key], overlay.aboveWindow == number else { return false }
        let list = windowSource.windows(of: [ProcessInfo.processInfo.processIdentifier, overlay.browserPid])
        let toolbar = list.first { $0.number == number }.flatMap { WindowMatcher.fullScreenToolbar(list, browser: $0)?.number }
        return WindowMatcher.stackedAbove(list, overlay: overlay.windowNumber, browser: number, toolbar: toolbar)
    }

    // ---- what the shell asks of it ----

    // "Close windows to save memory" changes what a switch does only with the handoff on and parking
    // passed: otherwise every switch closes its window, so Settings doesn't offer it (across).
    func switchSettingsShown(_ browser: String) -> Bool { browser == "safari" && handoffOn && parkingOn }

    static func browser(of link: String) -> String { link.split(separator: ":", maxSplits: 1).first.map(String.init) ?? link }

    // A browser's processes: its bundle's, and those its copies' hellos named.
    func browserPids(_ browser: String) -> Set<pid_t> {
        var pids = options.bundleIds[browser].map { apps.pids(of: $0) } ?? []
        for entry in links.values where entry.connection.hello.browser == browser {
            if let pid = entry.connection.hello.pid { pids.insert(pid_t(pid)) }
        }
        return pids
    }

    // Parked now (not `out`: a step that didn't land leaves the window where it can be seen).
    func isParkedKey(_ key: WindowKey) -> Bool {
        guard let parking, !parking.entries.isEmpty else { return false }
        if let n = matches[key], let e = parking.entries[n] { return e.phase != .out }
        return parking.entries.values.contains { $0.key == key && $0.phase != .out }
    }

    // The window a handoff is moving: the one it leaves, or its target.
    func inSwitch(_ key: WindowKey) -> Bool { switcher.run != nil && (switcher.leaving == key || switcher.isTarget(key)) }

    // Why the overlay of this window is held as it is (§2.4), or nil.
    func handoffHolds(_ key: WindowKey) -> String? {
        if isParkedKey(key) { return "its window is parked" }
        if inSwitch(key) { return "a switch is moving its window" }
        return nil
    }

    // A `windows` list for this window's overlay waits while it's held and its copy doesn't say full screen.
    func windowsWait(_ key: WindowKey, _ list: [JSONObject]) -> Bool {
        guard handoffHolds(key) != nil else { return false }
        let own = list.first { int($0["windowId"] ?? $0["id"]) == key.windowId }
        return own?["state"] as? String != "fullscreen"
    }

    func pushWindows(_ overlay: OverlayController, _ json: String) {
        windowsPushes[overlay.key, default: 0] += 1
        overlay.push(raw: json)
    }

    // Overlays whose list waited: the latest one, once their copy says full screen or they're let go.
    func releaseHeldWindows() {
        for key in windowsHeld.sorted() {
            guard let entry = links[key.link], let overlay = overlays[key] else { windowsHeld.remove(key); continue }
            let list = entry.mirror.windows
            guard !windowsWait(key, list) else { continue }
            windowsHeld.remove(key)
            pushWindows(overlay, jsonString(["type": "windows", "list": list]) ?? "")
        }
    }

    // ---- the system ----

    // NSWorkspace's words (WorkspaceApps): the ones the handoff weighs, then a read soon as always.
    func appsChanged(_ why: String) {
        let system: String? = switch why {
        case "woke": "a wake"
        case "displays changed": "a display change"
        case "the Dock restarted": "the Dock restarting"
        default: nil
        }
        if let system, let parking {
            parking.systemEvent(system)
            if !parking.entries.isEmpty { Diagnostics.note("handoff: \(system): any of the \(parking.entries.count) parked found back in the next 3 s is parked again") }
        }
        switch why {
        case "will sleep":
            switcher.revealNow(.sleep)
        case "woke":
            switcher.woke()
        case "app activated":
            if let front = apps.frontPid, browserPids("safari").contains(front) { safariActivated = true }
        case "app quit":
            if switcher.run != nil, browserPids("safari").isEmpty { switcher.revealNow(.safariQuit) }
        default:
            break
        }
        burst(why)
    }

    // ---- each read ----

    func handoffRead(_ ext: [WindowKey: (ExtWindow, Link)], before: [WindowKey: Int], held: Set<String>, copies: [String: String],
                     reporting: Set<String>, byBrowser: [String: Set<pid_t>], list: [ServerWindow]) {
        defer {
            lastExtKeys = Set(ext.keys)
            heldOut = heldOut.filter { ext[$0] != nil }
        }
        guard let parking, handoffOn || !parking.entries.isEmpty else { return }
        // The aftercare first: what it parks again or adopts isn't the system's return (HANDOFF.md §1.11).
        switcher.tick()
        let safari = byBrowser["safari"] ?? []
        let windows = ext.values.map(\.0).filter { $0.key.link.hasPrefix("safari:") }
        let found = parking.sweep(SweepRead(pids: safari, ext: windows, reporting: reporting, copies: copies, held: held, moving: switcher.movingNumbers))
        for case .person(let number, let key) in found { personReturn(key, number) }
        // A new copy's parked windows bound again (§2.2): by elimination, then by bounds.
        if let binder = binders["safari"] {
            for link in Set(parking.entries.values.filter { $0.windowId == nil }.map(\.link)).sorted() where reporting.contains(link) {
                let unbound = windows.filter { $0.key.link == link && matches[$0.key] == nil }
                let rebound = parking.rebind(link: link, unbound: unbound)
                if !rebound.isEmpty { binder.expectParked(rebound, why: "a parked window's new copy id") }
            }
            // One parked with its id known but not bound (parked again from a crash's marker): bound on
            // the registry's record, so its pages keep their box (`drawn`) while it's out of sight.
            for e in parking.entries.values.sorted(by: { $0.number < $1.number }) where e.phase != .out && !parkedBindAsked.contains(e.number) {
                guard let key = e.key, matches[key] == nil, reporting.contains(key.link) else { continue }
                parkedBindAsked.insert(e.number)
                binder.expectParked(key, number: e.number, why: "parked, on the registry's record")
            }
            parkedBindAsked = parkedBindAsked.filter { parking.entries[$0] != nil }
        }
        tellParked(ext)
        shownClosed(ext, before: before)
        everyParkedCheck(ext, list: list, safari: safari)
    }

    // Each copy told which of its windows are parked (§2.5): only a change, and off only after on.
    private func tellParked(_ ext: [WindowKey: (ExtWindow, Link)]) {
        var phases: [WindowKey: ParkedWindow.Phase] = [:]
        for e in parking.map({ Array($0.entries.values) }) ?? [] { if let key = e.key { phases[key] = e.phase } }
        for (key, (_, entry)) in ext.sorted(by: { $0.key < $1.key }) where entry.connection.isUp {
            guard let parked = Self.parkedWord(phases[key], told: entry.parked[key.windowId]) else { continue }
            entry.parked[key.windowId] = parked
            entry.connection.send(.parked(epoch: entry.connection.epoch, windowId: key.windowId, on: parked))
            Diagnostics.note("\(key): told \(parked ? "parked" : "not parked")")
        }
        for entry in links.values { entry.parked = entry.parked.filter { ext[WindowKey(link: entry.connection.key, windowId: $0.key)] != nil } }
    }

    // What a copy is told of one window (PROTOCOL.md `parked`): on once it's parked and checked, off once
    // it's out again (shown, returned, gone, or a step that didn't land). A park under way, or a parked
    // window's close, changes nothing: a re-park from a system return never says off and on again.
    // Nil: nothing to send.
    static func parkedWord(_ phase: ParkedWindow.Phase?, told: Bool?) -> Bool? {
        switch phase {
        case .parked?: return told == true ? nil : true
        case .parking?, .closing?: return nil
        default: return told == true ? false : nil
        }
    }

    // ---- a parked window used (§6.1) ----

    func parkedActivity(_ entry: Link, _ activity: ParkedActivity) {
        let key = WindowKey(link: entry.connection.key, windowId: activity.windowId)
        Diagnostics.note("handoff: \(key) used while parked (\(activity.why.rawValue)\(activity.tabId.map { ", tab \($0)" } ?? ""))")
        // Focus on a window the system brought back (a wake, a display change, the Dock restarting) is
        // the system's: the registry parks it again, and no handoff starts from it (§2.6, §4.4.5).
        if activity.why == .focus, parking?.inSystemWindow == true {
            return Diagnostics.note("handoff: \(key)'s focus dropped: in the system's 3 s after \(parking?.systemWhy ?? "-")")
        }
        queueActivity(key, tabId: activity.tabId, why: activity.why.rawValue)
    }

    // The sweep found the person's focus on a parked window that came back: theirs, said on every read
    // until a handoff shows it. With the handoff off, it's let go as the ordinary window it is.
    private func personReturn(_ key: WindowKey, _ number: Int) {
        guard handoffOn else { parking?.release(number); return }
        queueActivity(key, tabId: nil, why: "focus, back on screen")
    }

    // A burst merged into one (150 ms), then one handoff to that window.
    static let activityMerge: TimeInterval = 0.15
    func queueActivity(_ key: WindowKey, tabId: Int?, why: String) {
        // The shown window was just closed and every parked one is closing (§13.8): none comes back for it.
        if parkedEnding { return Diagnostics.note("handoff: \(key)'s use (\(why)) dropped: the parked windows are closing") }
        if let was = activity[key] { activity[key] = (tabId ?? was.tabId, was.why, was.timer); return }
        let timer = Timer.scheduledTimer(withTimeInterval: Self.activityMerge, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.activityDue(key) }
        }
        activity[key] = (tabId, why, timer)
    }

    private func activityDue(_ key: WindowKey) {
        guard let a = activity.removeValue(forKey: key), handoffOn, let parking else { return }
        if parkedEnding { return Diagnostics.note("handoff: \(key)'s use (\(a.why)) dropped: the parked windows are closing") }
        guard let number = matches[key] ?? parking.entries.values.first(where: { $0.key == key })?.number, parking.isParked(number) else {
            return Diagnostics.note("handoff: \(key) isn't parked any more: no handoff")
        }
        guard !switcher.busy else {
            if activitySaid.insert(key).inserted { Diagnostics.note("handoff: \(key)'s use (\(a.why)) left: a switch is under way") }
            return
        }
        guard !switcher.session.watches.contains(where: { $0.number == number }) else {
            return Diagnostics.note("handoff: \(key)'s use (\(a.why)) left: the window is in its aftercare")
        }
        activitySaid.remove(key)
        guard let space = spaceFor(key, tabId: a.tabId) else { return Diagnostics.note("handoff: \(key) has no space to show: no handoff") }
        let from = shownWindow()
        Diagnostics.note("handoff: window \(number) (\(key)) used while parked (\(a.why)): handed off to it from \(from.map(\.description) ?? "nothing")")
        switcher.start(.init(profile: key.link, space: space), from: from?.link ?? "", windowId: from?.windowId, asked: key)
        burst("a parked window used")
        acrossSoon()
    }

    // The space a handoff to this window shows: the tab's, else the window's, else the profile's first.
    func spaceFor(_ key: WindowKey, tabId: Int?) -> String? {
        let open = links[key.link]?.mirror.value("openTabs") as? JSONObject
        if let tabId, let s = (open?["tabSpace"] as? JSONObject)?[String(tabId)] as? String { return s }
        if let s = activeSpaceId(of: key) { return s }
        return (links[key.link]?.mirror.value("spaces") as? [Any])?.first.flatMap { ($0 as? JSONObject)?["id"] as? String }
    }

    // The window Margin shows now: where the last switch landed, if it's still there and not parked;
    // else the one in front with its overlay.
    func shownWindow() -> WindowKey? {
        if let s = switcher.session.shown, isLinked(s.key.link), !isParkedKey(s.key), copyWindows(s.key.link).contains(where: { $0.key == s.key }) { return s.key }
        return frontOverlay()?.key
    }

    // ---- the keys mid-switch (§1.7) ----

    func runMidSwitch(_ command: AppCommand, isRepeat: Bool) {
        switch command {
        case .nextSpace, .prevSpace:
            let dir = command == .nextSpace ? 1 : -1
            // From where the switch will land (the last one asked, if one waits).
            guard let t = switcher.queued ?? switcher.target, let colon = t.profile.firstIndex(of: ":") else { return }
            let browser = String(t.profile[..<colon]), profile = String(t.profile[t.profile.index(after: colon)...])
            guard let step = profilesOf(browser).spaceStep(from: SpaceKey(profile: profile, space: t.space), profile: profile, dir: dir, isRepeat: isRepeat) else {
                return Diagnostics.note("the \(command.rawValue) key mid-switch: no other space: dropped")
            }
            switch step {
            case .held:
                return
            case .across(let next), .own(let next):
                let from = switcher.from
                Diagnostics.note("the \(command.rawValue) key mid-switch: \(browser):\(next.profile)/\(next.space) asked of the switch")
                switcher.start(.init(profile: "\(browser):\(next.profile)", space: next.space), from: from?.profile ?? "", windowId: from?.windowId)
                acrossSoon()
            }
        default:
            // Never to Safari's key window mid-switch: A's copy would act in a window that's going (§1.7).
            Diagnostics.note("the \(command.rawValue) key mid-switch: dropped")
        }
    }

    // ---- an overlay's page ----

    func framed(_ overlay: OverlayController, mode: OverlayFramed.Mode) {
        switcher.framed(overlay.key, mode: mode)
    }

    // ---- closing parked windows (quit §13.1, the shown window closed §13.8) ----

    // A parked window's close by its own copy, as the registry asks it (no drafts check).
    func parkedCloser() -> ParkingRegistry.Closer {
        { [weak self] w, closed in
            guard let self, let key = w.key, self.isLinked(key.link) else { return false }
            self.request(key.link, "closeWindow", HandoffRequest.closeWindow(windowId: key.windowId).payload, windowId: key.windowId) { result, error in
                closed(error == nil && (result.map { WindowCallAnswer($0).called } ?? false))
            }
            return true
        }
    }

    // The window Margin showed is gone from its copy's list, and not by Margin's own hand: the person
    // closed it. To them it was the one window, so every parked window closes too, after 0.5 s if
    // Safari's still running (a quitting Safari takes its windows itself). A window that goes while a
    // switch runs (⌘W on B in its `after` or `landed`) is kept and judged once the switch is idle,
    // against the window it landed on.
    static let shownCloseWait: TimeInterval = 0.5
    private func shownClosed(_ ext: [WindowKey: (ExtWindow, Link)], before: [WindowKey: Int]) {
        defer { marginCloses = marginCloses.filter { ext[$0] != nil } }
        guard handoffOn, let parking else { return shownGone.clear() }
        shownGone.read(was: lastExtKeys, listed: Set(ext.keys), numbers: before, marginCloses: &marginCloses)
        guard !switcher.busy, !parkedEnding else { return }
        let gone = shownGone.take()
        guard !parking.entries.isEmpty else { return }
        for (key, number) in gone {
            guard let entry = links[key.link], entry.connection.isUp, entry.mirror.hasState, !parking.isParked(number) else { continue }
            // The shown window by its number, or by its key when the switch that showed it had no number yet.
            let shown = switcher.session.shown.map { $0.number == number || $0.key == key } ?? (parking.lastShown[key.link] == number)
            guard shown else { continue }
            Diagnostics.note("handoff: the shown window \(number) (\(key)) closed by the person: the \(parking.entries.count) parked close too")
            parkedEnding = true
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.shownCloseWait) { [weak self] in
                MainActor.assumeIsolated { self?.endParked(after: key) }
            }
            return
        }
    }

    // A switch under way when it's due (none should start meanwhile: a parked window's use is dropped
    // while they close): after it, looked at every 0.25 s for up to 10 s.
    private func endParked(after key: WindowKey, waited: TimeInterval = 0) {
        guard handoffOn, let parking, !parking.entries.isEmpty else { parkedEnding = false; return }
        if switcher.busy {
            guard waited < 10 else {
                parkedEnding = false
                return Diagnostics.note("handoff: the shown window closed, but a switch ran for 10 s: its parked windows left parked")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                MainActor.assumeIsolated { self?.endParked(after: key, waited: waited + 0.25) }
            }
            return
        }
        guard links[key.link]?.connection.isUp == true, !browserPids("safari").isEmpty else {
            parkedEnding = false
            return Diagnostics.note("handoff: Safari is going: its parked windows left to it")
        }
        parking.endAll(cause: .handoff, within: switcher.options.closeTimeout, close: parkedCloser()) { [weak self] end in
            self?.parkedEnding = false
            Diagnostics.note("handoff: the shown window closed: \(end.closed) parked closed, \(end.returned) returned to the Desktop, \(end.left) not done (\(end.ms) ms)")
        }
    }

    // ---- §6.2: Safari in front with every window parked ----

    private func everyParkedCheck(_ ext: [WindowKey: (ExtWindow, Link)], list: [ServerWindow], safari: Set<pid_t>) {
        guard handoffOn, safariActivated, !parkedEnding, let parking, let reads = spaceReads, !parking.entries.isEmpty, !switcher.busy,
              let front = apps.frontPid, safari.contains(front) else {
            everyParkedSince = nil
            if let front = apps.frontPid, !safari.contains(front) { safariActivated = false }
            return
        }
        // Any window of Safari's that isn't parked in a user Space (or not known), on screen, or not
        // bound yet (a Dock click's new window): nothing to explain.
        let parked = parking.numbers
        let unbound = ext.keys.contains { $0.link.hasPrefix("safari:") && matches[$0] == nil && !isParkedKey($0) }
        let seen = list.contains { safari.contains($0.pid) && $0.layer == 0 && $0.onScreen && !parked.contains($0.number) }
        let inSpace = matches.contains { key, number in
            guard key.link.hasPrefix("safari:"), !parked.contains(number) else { return false }
            return reads.spaces(of: number)?.isEmpty != true
        }
        guard !unbound, !seen, !inSpace else {
            everyParkedSince = nil
            safariActivated = false
            return
        }
        let now = Diagnostics.now()
        guard let since = everyParkedSince else {
            everyParkedSince = now
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.11) { [weak self] in MainActor.assumeIsolated { self?.burst("every window parked") } }
            return
        }
        guard now - since >= 0.1 else { return }
        everyParkedSince = nil
        safariActivated = false
        // The window last shown: where the last switch left from or landed, else the most recent parked.
        let entries = parking.entries.values.filter { $0.key != nil && $0.phase == .parked }.sorted { $0.since > $1.since }
        let lastShown = switcher.session.shown?.number
        guard let e = entries.first(where: { $0.number == lastShown || parking.lastShown[$0.link] == $0.number }) ?? entries.first, let key = e.key,
              let space = spaceFor(key, tabId: nil) else { return }
        Diagnostics.note("handoff: Safari in front with every window parked, and no switch explains it: window \(e.number) (\(key)) shown")
        switcher.start(.init(profile: key.link, space: space), from: "", windowId: nil, asked: key)
        acrossSoon()
    }
}
