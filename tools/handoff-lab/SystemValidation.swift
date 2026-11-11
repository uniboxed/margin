// Separately approved, user-initiated real OS cases. Never locks/sleeps a Mac,
// changes a display, creates a lab cover, resets a genuine demotion or captures pixels.
import AppKit

@MainActor final class SystemValidationSession {
    let lab: Lab
    let pid: pid_t
    let process: Process
    let buffer: LineBuffer
    init(_ lab: Lab) throws {
        self.lab = lab
        guard let app = Margin.running else { throw Fail("Margin not running") }
        pid = app.processIdentifier
        (process, buffer) = try Margin.stream()
    }
    func dump() async -> String {
        let first = buffer.all.count
        Margin.dev("dump")
        _ = await waitFor(2, every: 0.02) { self.buffer.all.dropFirst(first).contains { $0.contains("dev hook: dump: the last") || $0.contains("refused:") } }
        return buffer.all.dropFirst(first).joined(separator: "\n") + "\n"
    }
    func ready(_ n: Int) -> Bool {
        guard let w = lab.calls.server(n), w.onScreen, fills(w.bounds),
              let active = lab.calls.spaces.showing(onDisplayOf: n), lab.calls.fullScreen().contains(active),
              lab.calls.spacesOf(n).contains(active),
              validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: w.pid, app: pid) else { return false }
        return WindowMatcher.candidates(CGWindowSource().windows(of: [w.pid]), pids: [w.pid]).filter(\.onScreen)
            .min(by: { $0.order < $1.order })?.number == n
    }
    func clean(_ state: String) -> Bool {
        guard Margin.running?.processIdentifier == pid, state.contains("switch: idle"), state.contains("0 windows calls pending"),
              state.contains("session interruption: none"), validationAuditIsClean(state),
              let last = validationNumber(state, after: "last window ") else { return false }
        return last == 0 || lab.calls.server(last) == nil
    }
    func eligible(_ state: String, displays: Int) -> Bool {
        UserDefaults(suiteName: Margin.bundle)?.bool(forKey: "MarginLiveProfileCover") == true && Margin.devHooksOn
            && state.contains("handoff on, parking on") && state.contains("park on;")
            && state.contains("no caps; no faults armed") && state.contains("close windows off; displays \(displays)")
            && state.contains("live cover session: on") && clean(state)
    }
}

func systemInterruptionGate(_ kind: String, id: String) -> Gate {
    Gate(id: id, title: "One user-initiated \(kind) during the actual live cover",
        decides: "actual OS callback during shown cover, bounded recovery/source restoration and cleanup; not performance",
        needs: [.margin, .devHook, .person], freezes: "one fault request; no freeze; user alone performs \(kind)",
        plan: ["separate approval and --person; one display, actual clean opted-in candidate; source full screen/front and exactly one parked test target",
               "caller prepares at most one normal switch under its own allowance, then obtains the person's timing readiness; this gate sends at most ONE request",
               "arm suppressed target fullscreen, request the other test profile, independently observe native cover audit shown; no lab panel or capture",
               "after the animation has run one second, user alone locks/unlocks, closes/opens the lid, or connects the prepared monitor, according to this gate",
               "read existing metadata-only app trace once afterward: actual lock+unlock, will-sleep+wake, or display callback must fall after shown audit and before the matching interrupted summary",
               "within 120 s including user return: exact original source full screen/active/front, matching test profile, no interruption/pending calls and independent zero-resource cleanup",
               "display case ends with exactly two displays; others one; missing/late action or any unexpected failure stops, never auto-retries; caller restores original flag/app"],
        run: { lab in
            guard lab.o.person, Margin.running != nil, Margin.devHooksOn, NSScreen.screens.count == 1,
                  UserDefaults(suiteName: Margin.bundle)?.bool(forKey: "MarginLiveProfileCover") == true,
                  UserDefaults(suiteName: Margin.bundle)?.object(forKey: "MarginWindowTrace") as? Bool != false else {
                return Outcome(status: .notRun, lines: ["requires prepared opted-in one-display app, tracing and person; zero requests"])
            }
            let s = try SystemValidationSession(lab)
            defer { s.process.terminate() }
            await pause(0.4)
            let initial = await s.dump()
            let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Margin/traces")
            guard s.eligible(initial, displays: 1), let source = liveShownNumber(initial), s.ready(source),
                  let name = validationTestProfile(initial), validationNumber(initial, after: "registry: ") == 1,
                  (try? ValidationSystemEvent.read(folder, since: epochMs() / 1000)) != nil else {
                return Outcome(status: .notRun, lines: ["source, parked target, trace or actual capability not ready; zero requests"])
            }
            lab.restoreValidationMode = true
            defer { Margin.dev("mode", ["freeze": "on", "cover": "on", "old": "park"]); lab.restoreValidationMode = false }
            Margin.dev("fail", ["step": "fullscreen"])
            let armed = await s.dump()
            guard armed.contains("armed: fullscreen"), liveShownNumber(armed) == source, s.ready(source), s.clean(armed) else {
                return Outcome(status: .notRun, lines: ["fault/source guard not ready; zero requests"])
            }
            let mark = s.buffer.all.count
            Margin.devSwitch(to: name == "Test A" ? "Test B" : "Test A")
            let deadline = epochMs() + 120_000
            var shown: Double?
            let showBy = epochMs() + 3_000
            while epochMs() < showBy {
                if Margin.running?.processIdentifier != s.pid { break }
                let state = await s.dump()
                if state.contains("live cover audit: state shown, windows 1, views 1, spaces 1,"),
                   let number = validationNumber(state, after: "last window "), let cover = lab.calls.server(number),
                   cover.pid == s.pid, cover.onScreen, cover.alpha > 0, fills(cover.bounds) {
                    shown = epochMs() / 1000; break
                }
                await pause(0.03)
            }
            guard let shown else { return Outcome(status: .fail, lines: ["one request sent; shown cover not independently observed before OS action; stop"] ) }
            var summary: String?
            var ended: Double = 0
            while epochMs() < deadline {
                if Margin.running?.processIdentifier != s.pid { break }
                if s.buffer.all.dropFirst(mark).contains(where: { $0.contains("dev hook:") && $0.contains("refused:") }) { break }
                if let line = s.buffer.all.dropFirst(mark).first(where: liveSwitchSummary) {
                    summary = line; ended = epochMs() / 1000; break
                }
                await pause(0.05)
            }
            guard let summary, summary.contains("live cover "), !summary.contains("frozen "),
                  summary.contains("(park, parked target)"), summary.contains("dev hook: fullscreen"),
                  summary.contains("recovered:"), summary.contains(kind == "display" ? "displays changed" : "sleep") else {
                return Outcome(status: .fail, lines: [summary ?? "no summary", "named interrupted recovery not established; no retry"])
            }
            // Wait only for the person/OS to return; never sends an unlock/wake/display command.
            while !SessionVisibility.allowsCover && epochMs() < deadline && Margin.running?.processIdentifier == s.pid { await pause(0.2) }
            var final = ""
            repeat {
                final = await s.dump()
                if s.clean(final), liveShownNumber(final) == source, validationTestProfile(final) == name, s.ready(source) { break }
                if Margin.running?.processIdentifier != s.pid { break }
                await pause(0.2)
            } while epochMs() < deadline
            await pause(0.2) // let the existing utility trace queue append the final OS callback
            let displays = kind == "display" ? 2 : 1
            guard s.clean(final), liveShownNumber(final) == source, validationTestProfile(final) == name, s.ready(source),
                  NSScreen.screens.count == displays, final.contains("close windows off; displays \(displays)"),
                  let events = try? ValidationSystemEvent.read(folder, since: shown),
                  ValidationSystemEvent.proves(events, kind: kind, shown: shown, ended: ended) else {
                return Outcome(status: .fail, lines: [summary, "actual OS event/recovery/source/display/cleanup proof incomplete; stop"])
            }
            return Outcome(status: .recorded, lines: [summary,
                "actual \(kind) callback during independently shown cover and expected user/OS return verified; exact source restored; \(displays) displays",
                final, "metadata scope only; no physical/energy/performance grade"])
        })
}

let realLockGate = systemInterruptionGate("lock", id: "EVLOCK")
let realSleepGate = systemInterruptionGate("sleep", id: "EVSLEEP")
let realDisplayGate = systemInterruptionGate("display", id: "EVDISPLAY")

let realMultiDisplayGate = Gate(id: "MULTI", title: "One actual two-display degraded switch",
    decides: "live allocation refused with actual two-display topology; degraded slide/keep readiness and cleanup, not the live goal",
    needs: [.margin, .devHook, .person], freezes: "one expected public-slide request; no freeze or live cover",
    plan: ["separate approval, --person, exactly two displays; opted-in app with actual native cover available but idle/clean; no caps/faults",
           "ask the other exact Test A/B profile ONCE; require the explicit multiple-display degraded log and no live-cover mechanism/allocation",
           "independently verify target fullscreen/active/front, source parked/gone or explicitly kept, no pending calls and unchanged balanced native cover counters",
           "require the declared two-display keep choice, no freeze and source retained in its real fullscreen Space; stop on any unexpected failure; caller restores flag/app"],
    run: { lab in
        guard lab.o.person, NSScreen.screens.count == 2, Margin.running != nil else { return Outcome(status: .notRun, lines: ["needs prepared two-display app/person; zero requests"]) }
        let s = try SystemValidationSession(lab)
        defer { s.process.terminate() }
        await pause(0.4)
        let initial = await s.dump()
        guard s.eligible(initial, displays: 2), let source = liveShownNumber(initial), s.ready(source), let name = validationTestProfile(initial),
              let made = validationNumber(initial, after: "created ") else { return Outcome(status: .notRun, lines: ["two-display source/capability not ready; zero requests"]) }
        let mark = s.buffer.all.count
        Margin.devSwitch(to: name == "Test A" ? "Test B" : "Test A")
        var summary: String?
        _ = await waitFor(22, every: 0.02) { summary = s.buffer.all.dropFirst(mark).first(where: liveSwitchSummary); return summary != nil }
        guard let summary, !summary.contains("live cover "), !summary.contains("frozen "), !summary.contains("recovered:"),
              !summary.contains("aborted"), !summary.contains("late ("), summary.contains("focus ok"),
              summary.contains("keep (2 displays: kept in its own Space)"), summary.contains("A kept (2 displays: kept in its own Space)"),
              s.buffer.all.dropFirst(mark).contains(where: { $0.contains("live cover unavailable with multiple displays: degraded freeze/slide fallback") }) else {
            return Outcome(status: .fail, lines: [summary ?? "no summary", "expected two-display refusal/degraded mechanism not established; stop"])
        }
        let final = await s.dump()
        guard NSScreen.screens.count == 2, s.clean(final), let target = liveShownNumber(final), target != source, s.ready(target),
              validationTestProfile(final) == (name == "Test A" ? "Test B" : "Test A"),
              validationNumber(final, after: "created ") == made,
              let old = lab.calls.server(source), fills(old.bounds),
              lab.calls.spacesOf(source).contains(where: { lab.calls.fullScreen().contains($0) }) else {
            return Outcome(status: .fail, lines: [summary, "independent degraded final/allocation/cleanup proof failed; stop"])
        }
        return Outcome(status: .recorded, lines: [summary, final, "public slide/keep is a degraded mode only, never live-goal acceptance"])
    })
