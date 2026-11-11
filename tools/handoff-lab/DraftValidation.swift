// One separately approved park-failure/close-fallback check. No batch replay.
import AppKit

let closeFallbackGate = Gate(
    id: "FALLBACK", title: "One guarded close fallback after actual draft readiness",
    decides: "one missing fault case only; never changes the failed MATCHED result",
    needs: [.margin, .devHook], freezes: "at most ONE Test A/Test B request under the live cover; no freeze",
    plan: ["fresh tested opted-in app, one display, foreground full-screen Test A or Test B; idle, no caps/faults or real demotions",
           "observe actual windowDrafts at most three times within two seconds, before any fault/switch; require two consecutive empty drafts/unknown results with identical source and tab IDs",
           "observation records the checker's existing scroll metadata; it does not authorize close; production Handoff.askDrafts still runs fresh",
           "arm one suppressed park, request the other test profile once, then independently verify native target fullscreen/active/front, source actually gone and zero-resource cover cleanup",
           "any unknown/stale/changed/unavailable preflight refuses BEFORE switching; keep an unknown source, never override protection",
           "restore test caps; caller restores original flag/app after expected parking demotion; separate approval required"],
    run: { lab in
        guard let app = Margin.running, Margin.devHooksOn,
              LiveCoverPolicy.requested(UserDefaults(suiteName: "com.unibox.margin") ?? .standard) else {
            return Outcome(status: .notRun, lines: ["requires running opted-in candidate; nothing switched"])
        }
        let appPID = app.processIdentifier
        let (process, buffer) = try Margin.stream()
        defer { process.terminate() }
        await pause(0.4)
        @MainActor func dump() async -> String {
            let first = buffer.all.count
            Margin.dev("dump")
            _ = await waitFor(2, every: 0.02) { buffer.all.dropFirst(first).contains { $0.contains("dev hook: dump: the last") || $0.contains("refused:") } }
            return buffer.all.dropFirst(first).joined(separator: "\n") + "\n"
        }
        @MainActor func ready(_ n: Int) -> Bool {
            guard let w = lab.calls.server(n), w.onScreen, fills(w.bounds),
                  let active = lab.calls.spaces.showing(onDisplayOf: n), lab.calls.fullScreen().contains(active),
                  lab.calls.spacesOf(n).contains(active) else { return false }
            return WindowMatcher.candidates(CGWindowSource().windows(of: [w.pid]), pids: [w.pid]).filter(\.onScreen)
                .min(by: { $0.order < $1.order })?.number == n
        }
        @MainActor func clean(_ state: String) -> Bool {
            guard validationAuditIsClean(state), state.contains("switch: idle"), state.contains("0 windows calls pending"),
                  state.contains("no faults armed"), let last = validationNumber(state, after: "last window ") else { return false }
            return last == 0 || lab.calls.server(last) == nil
        }
        let initial = await dump()
        guard initial.contains("handoff on, parking on"), initial.contains("close windows off; displays 1"),
              initial.contains("no caps; no faults armed"), initial.contains("choices: freeze on"), initial.contains("park on;"),
              initial.contains("live cover session: on"), initial.contains("session interruption: none"),
              clean(initial), let source = liveShownNumber(initial), ready(source), let name = validationTestProfile(initial),
              let browser = lab.calls.server(source)?.pid,
              validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: browser, app: appPID) else {
            return Outcome(status: .notRun, lines: ["source/capability/preconditions not ready; nothing switched"])
        }
        var lines: [String] = []
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        var previous: DraftObservation?
        var consecutive = 0
        for attempt in 1...3 {
            guard ProcessInfo.processInfo.systemUptime < deadline else { break }
            let nonce = UUID(), first = buffer.all.count
            Margin.dev("drafts", ["nonce": nonce.uuidString])
            var observed: DraftObservation?
            var refused = false
            _ = await waitFor(max(0, deadline - ProcessInfo.processInfo.systemUptime), every: 0.01) {
                let fresh = buffer.all.dropFirst(first)
                observed = fresh.compactMap(DraftObservation.parse).first { $0.nonce == nonce }
                refused = fresh.contains { ($0.contains("dev hook:") && $0.contains("refused:"))
                    || ($0.contains(nonce.uuidString) && ($0.contains("drafts stale:") || $0.contains("drafts unavailable:"))) }
                return observed != nil || refused
            }
            guard !refused, let observed, observed.native == source, observed.browser == Int(browser),
                  observed.caller == Int(ProcessInfo.processInfo.processIdentifier), Margin.running?.processIdentifier == appPID,
                  ready(source), validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: browser, app: appPID),
                  previous.map({ observed.sameSource(as: $0) }) ?? true else {
                return Outcome(status: .notRun, lines: lines + ["drafts observation stale/unavailable/changed; nothing switched"])
            }
            lines.append("draft observation \(attempt): window \(observed.window), native \(source), \(observed.tabs.count) tabs, \(observed.drafts.count) drafts, \(observed.unknown.count) unknown")
            consecutive = observed.clear ? consecutive + 1 : 0
            previous = observed
            if consecutive == 2 { break }
        }
        guard consecutive == 2 else { return Outcome(status: .notRun, lines: lines + ["two consecutive clear answers not established; nothing switched"] ) }
        let before = await dump()
        guard clean(before), liveShownNumber(before) == source, validationTestProfile(before) == name,
              before.contains("session interruption: none"), before.contains("no caps; no faults armed"),
              before.contains("park on;"), before.contains("live cover session: on"), before.contains("close windows off; displays 1"),
              Margin.running?.processIdentifier == appPID, ready(source) else {
            return Outcome(status: .notRun, lines: lines + ["source changed after observation; nothing switched"])
        }
        lab.restoreValidationMode = true
        defer { Margin.dev("mode", ["freeze": "on", "cover": "on", "old": "park"]); lab.restoreValidationMode = false }
        Margin.dev("fail", ["step": "park"])
        let armed = await dump()
        guard armed.contains("armed: park"), liveShownNumber(armed) == source, ready(source),
              armed.contains("close windows off; displays 1"), armed.contains("park on;"), armed.contains("live cover session: on"),
              armed.contains("session interruption: none"), validationTestProfile(armed) == name,
              LiveCoverPolicy.requested(UserDefaults(suiteName: "com.unibox.margin") ?? .standard),
              Margin.running?.processIdentifier == appPID,
              validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: browser, app: appPID) else {
            return Outcome(status: .notRun, lines: lines + ["fault/source guard not ready; nothing switched"])
        }
        let mark = buffer.all.count
        Margin.devSwitch(to: name == "Test A" ? "Test B" : "Test A")
        var summary: String?
        guard await waitFor(22, every: 0.02, {
            let fresh = buffer.all.dropFirst(mark)
            summary = fresh.first(where: liveSwitchSummary)
            return summary != nil || fresh.contains { $0.contains("dev hook:") && $0.contains("refused:") }
        }), let summary else { return Outcome(status: .fail, lines: lines + ["one request sent, no fresh accepted summary; no retry"] ) }
        lines.append(summary)
        guard matchedTransition(summary, mode: "live") == .onTime, summary.contains("A closed "),
              summary.components(separatedBy: "dev hook:").last?.contains("park") == true else {
            return Outcome(status: .fail, lines: lines + ["requested close fallback not established; protected/unknown window is never forced closed"])
        }
        var final = ""
        let cleanBy = ProcessInfo.processInfo.systemUptime + 3
        repeat { final = await dump(); if clean(final) { break }; await pause(0.1) } while ProcessInfo.processInfo.systemUptime < cleanBy
        guard Margin.running?.processIdentifier == appPID, clean(final), let target = liveShownNumber(final), target != source,
              validationTestProfile(final) == (name == "Test A" ? "Test B" : "Test A"), ready(target),
              lab.calls.server(source) == nil,
              validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: lab.calls.server(target)?.pid, app: appPID) else {
            return Outcome(status: .fail, lines: lines + ["final native target/source/cleanup verification failed"])
        }
        return Outcome(status: .recorded, lines: lines + ["one close fallback independently verified; \(final)", "prior failed MATCHED run remains failed; no performance/physical-display grade"])
    })
