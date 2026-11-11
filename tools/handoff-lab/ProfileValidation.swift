// The product path only: no external cover can hide a failure. All writes are
// through the existing Test A/Test B-only hook. No profile/window pre-creation.
import AppKit

let profileValidationGate = makeProfileValidationGate(prospective: false)
let matchedProfileValidationGate = makeProfileValidationGate(prospective: true)

private func makeProfileValidationGate(prospective: Bool) -> Gate { Gate(
    id: prospective ? "MATCHED" : "VALIDATE",
    title: prospective ? "Prospective matched comparison with degraded freeze controls" : "Matched freeze/live reliability, cleanup and resource validation",
    decides: "42 normal measured switches, 4 warmups, 2 guarded faults and 2 close-mode requests; physical display remains a separate check",
    needs: [.margin, .devHook], freezes: "up to 50 Test A/Test B requests, about 7 minutes including two 60-second idle samples",
    plan: ["installed opted-in candidate, one display, foreground full-screen Test A or Test B; parking on, close setting off, no caps/faults",
           "same Margin PID throughout; a subtractive Test A/Test B cover cap selects the actual freeze control without restarting",
           "4 excluded balanced warmups; 60-second pre-idle; 24 ABBA matched requests (12 freeze/12 live); 18 additional live requests",
           "60-second normal post-idle BEFORE fault/close cases; then suppressed-fullscreen recovery, two close requests, one suppressed park with close fallback",
           "fresh summary and native destination/source verification, cover audit and closed-window check after EVERY request; never reset genuine failure gates",
           "write timestamped request/settled/idle events; run memory.py separately; no pixel coverage/physical-camera acceptance inferred",
           "first unexpected failure stops all further requests; restore test caps on every exit; outer runner restores the launch preference"] + (prospective ? [
           "NEW protocol \(matchedValidationProtocol): no prior allowance/proof reuse; requires separate approval of all 50 requests",
           "only successful watchdog release waiting for A not started may count as degraded freeze, after independent final/cleanup verification; live late/recovery/fallback still fails",
           "fixed Test A/Test B native window identities after warmups; one shown/one parked; equal no-cap park mode in both idles; reveal hazard and verified completion reported separately"] : []),
    run: { lab in
        guard let app = Margin.running, Margin.devHooksOn,
              LiveCoverPolicy.requested(UserDefaults(suiteName: "com.unibox.margin") ?? .standard) else {
            return Outcome(status: .notRun, lines: ["requires running opted-in candidate and guarded hook; nothing switched"])
        }
        if prospective && (lab.o.validationAfterFailedWarmup != nil || lab.o.validationAfterFreezeWatchdog != nil) {
            return Outcome(status: .notRun, lines: ["MATCHED is a new 50-request protocol; prior failed runs/allowances cannot resume it; nothing switched"])
        }
        let appPID = app.processIdentifier
        var consumedRequests = 0
        let liveOnly = lab.o.validationAfterFreezeWatchdog != nil
        if let path = lab.o.validationAfterFreezeWatchdog {
            guard let priorPID = validationFreezeWatchdogPID(try Data(contentsOf: URL(fileURLWithPath: path))),
                  priorPID != Int(appPID) else {
                return Outcome(status: .notRun, lines: ["live-only observation requires the diagnosed late control and a fresh process; nothing switched"])
            }
            consumedRequests = 4
        }
        if let path = lab.o.validationAfterFailedWarmup {
            guard let priorPID = validationFailedFirstWarmupPID(try Data(contentsOf: URL(fileURLWithPath: path))),
                  priorPID != Int(appPID) else {
                return Outcome(status: .notRun, lines: ["resume requires exactly one failed first freeze warmup and a fresh corrected candidate; nothing switched"])
            }
            consumedRequests = 1
        }
        let (process, buffer) = try Margin.stream()
        defer { process.terminate() }
        await pause(0.4)
        let events = lab.o.labDir.appendingPathComponent("build/validation-\(Int(epochMs())).jsonl")
        _ = FileManager.default.createFile(atPath: events.path, contents: nil)
        let handle = try FileHandle(forWritingTo: events)
        defer { try? handle.close() }
        @MainActor func event(_ kind: String, index: Int = 0, step: ProfileValidationStep? = nil, extra: [String: Any] = [:]) throws {
            var row: [String: Any] = ["event": kind, "index": index, "at": epochMs(),
                                      "mono": ProcessInfo.processInfo.systemUptime, "app_pid": appPID]
            if prospective { row["protocol"] = matchedValidationProtocol }
            if let step { row["phase"] = step.phase; row["mode"] = step.mode; row["old"] = step.old; row["fault"] = step.fault }
            row.merge(extra) { _, new in new }
            var data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            data.append(10); try handle.write(contentsOf: data)
        }
        @MainActor func dump() async -> String {
            let at = buffer.all.count
            Margin.dev("dump")
            _ = await waitFor(2, every: 0.02) {
                buffer.all.dropFirst(at).contains { $0.contains("dev hook: dump: the last") || $0.contains("refused:") }
            }
            return buffer.all.dropFirst(at).joined(separator: "\n") + "\n"
        }
        @MainActor func ready(_ n: Int) -> Bool {
            guard let w = lab.calls.server(n), w.onScreen, fills(w.bounds),
                  let active = lab.calls.spaces.showing(onDisplayOf: n),
                  lab.calls.fullScreen().contains(active), lab.calls.spacesOf(n).contains(active) else { return false }
            return WindowMatcher.candidates(CGWindowSource().windows(of: [w.pid]), pids: [w.pid])
                .filter(\.onScreen).min(by: { $0.order < $1.order })?.number == n
        }
        @MainActor func clean(_ state: String) -> Bool {
            guard validationAuditIsClean(state), state.contains("switch: idle"),
                  state.contains("0 windows calls pending"), state.contains("no faults armed") else { return false }
            guard let n = validationNumber(state, after: "last window ") else { return false }
            return n == 0 || lab.calls.server(n) == nil
        }
        var profileWindows: [String: Int] = [:]
        @MainActor func fixedTopology(_ state: String) -> Bool {
            guard let name = validationTestProfile(state), let source = liveShownNumber(state),
                  profileWindows.count == 2, profileWindows[name] == source,
                  let other = profileWindows[name == "Test A" ? "Test B" : "Test A"],
                  other != source, state.contains("registry: 1 parked;"),
                  lab.calls.server(other) != nil, lab.calls.parked(other) else { return false }
            return ready(source)
        }
        @MainActor func idle(_ phase: String) async throws {
            if prospective {
                Margin.dev("mode", ["freeze": "on", "cover": "on", "old": "park"])
                let state = await dump()
                guard state.contains("no caps; no faults armed"), state.contains("park on;"),
                      state.contains("choices: freeze on"), state.contains("live cover session: on"),
                      clean(state), fixedTopology(state) else { throw Fail("equal idle mode/topology not ready") }
            }
            try event("idle_begin", step: .init(phase: phase, mode: "live"))
            await pause(60)
            let state = await dump()
            guard Margin.running?.processIdentifier == appPID, clean(state),
                  let n = liveShownNumber(state), ready(n),
                  validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: lab.calls.server(n)?.pid, app: appPID) else {
                throw Fail("\(phase) idle cleanup/source state changed")
            }
            if prospective {
                guard state.contains("no caps; no faults armed"), state.contains("park on;"),
                      state.contains("choices: freeze on"), state.contains("live cover session: on"),
                      fixedTopology(state) else { throw Fail("idle mode/topology/capability changed") }
            }
            try event("idle_end", step: .init(phase: phase, mode: "live"))
        }
        var lines = ["events: \(events.path)", "same-process matched control; no external cover or recorder"]
        if liveOnly {
            lines.append("matched comparison remains FAILED; separate live-only observation: 36 maximum requests (5–40), two warmups, 30 normal live, pre/post-idle and four fault/close cases")
        } else if consumedRequests == 1 {
            lines.append("one failed first freeze warmup remains recorded separately; at most 49 remaining requests, three fresh warmups, all 42 normal measurements retained")
        }
        let initial = await dump()
        guard initial.contains("handoff on, parking on"), initial.contains("close windows off; displays 1"),
              initial.contains("no caps; no faults armed"), initial.contains("live cover session: on"),
              let firstSource = liveShownNumber(initial), ready(firstSource), validationTestProfile(initial) != nil, clean(initial),
              let browser = lab.calls.server(firstSource),
              validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: browser.pid, app: appPID) else {
            return Outcome(status: .notRun, lines: lines + ["guarded foreground source/capability/preconditions not ready; nothing switched"])
        }
        if prospective, let name = validationTestProfile(initial) { profileWindows[name] = firstSource }
        // Only subtractive test caps are restored, not real FreezeRules/parking/cover demotions.
        lab.restoreValidationMode = true
        defer { Margin.dev("mode", ["freeze": "on", "cover": "on", "old": "park"]); lab.restoreValidationMode = false }
        var index = consumedRequests
        let finalIndex = liveOnly ? 40 : 50
        let numbered = liveOnly
            ? profileLiveReliabilityPlan().enumerated().map { ($0.offset + 5, $0.element) }
            : profileValidationPlan().enumerated().dropFirst(consumedRequests).map { ($0.offset + 1, $0.element) }
        do {
            try event("validation_begin", extra: ["prior_requests_consumed": consumedRequests,
                       "prior_failed_warmups": liveOnly ? 2 : consumedRequests, "validation_kind": liveOnly ? "live_only" : "matched", "gate": prospective ? "MATCHED" : "VALIDATE"])
            for (number, step) in numbered {
                index = number
                if index == (liveOnly ? 7 : 5) { try await idle("pre_idle") }
                if index == (liveOnly ? 37 : 47) { try await idle("post_idle") }
                guard Margin.running?.processIdentifier == appPID else { throw Fail("Margin restarted; comparison invalid") }
                let state = await dump()
                guard let source = liveShownNumber(state), ready(source), clean(state),
                      let sourceName = validationTestProfile(state),
                      state.contains("live cover session: on") else { throw Fail("source or cleanup not ready before request \(index)") }
                guard validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: lab.calls.server(source)?.pid, app: appPID) else {
                    throw Fail("foreground app changed; no further request")
                }
                if prospective && step.phase != "fault" && step.phase != "close" {
                    if let expected = profileWindows[sourceName], expected != source { throw Fail("test profile native identity changed") }
                    if step.phase != "warmup", !fixedTopology(state) { throw Fail("normal two-window topology changed before request") }
                }
                // Both injected failures require their intended operation to be reachable.
                if step.fault == "fullscreen", !state.contains("registry: 1 parked;") { throw Fail("fullscreen fault needs an existing parked target; nothing requested") }
                Margin.dev("mode", ["freeze": "on", "cover": step.mode == "freeze" ? "off" : "on", "old": step.old])
                let mode = await dump()
                guard mode.contains(step.mode == "freeze" ? "the dev hook: cover off;" : (step.old == "close" ? "the dev hook: old close;" : "no caps;")),
                      mode.contains("no faults armed") else { throw Fail("test mode not acknowledged") }
                if let fault = step.fault {
                    Margin.dev("fail", ["step": fault])
                    let armed = await dump()
                    guard armed.contains("armed: \(fault)") else { throw Fail("intended fault was not armed; nothing requested") }
                }
                let targetName = sourceName == "Test A" ? "Test B" : "Test A"
                let first = buffer.all.count, started = epochMs()
                try event("request", index: index, step: step, extra: ["source": source, "source_profile": sourceName, "target_profile": targetName])
                Margin.devSwitch(to: targetName)
                var summary: String?
                guard await waitFor(22, every: 0.02, {
                    let fresh = buffer.all.dropFirst(first)
                    summary = fresh.first(where: liveSwitchSummary)
                    return summary != nil || fresh.contains { $0.contains("refused:") && $0.contains("dev hook:") && !$0.contains("dev hook: dump:") }
                }), let summary else { throw Fail("no fresh summary/refused request \(index)") }
                let frozen = summary.contains("frozen "), live = summary.contains("live cover ")
                guard step.mode == "live" ? live && !frozen : frozen && !live else { throw Fail("requested mechanism did not execute: \(summary)") }
                let expectedRecovery = validationExpectedFullscreenRecovery(step)
                let transition = prospective && !expectedRecovery ? matchedTransition(summary, mode: step.mode) : nil
                if prospective && !expectedRecovery {
                    guard transition != nil else { throw Fail("unexpected mechanism/late/recovered transition: \(summary)") }
                } else {
                    guard !summary.contains("late ("), !summary.contains("aborted"),
                          !summary.contains("recovered") || step.recovers else { throw Fail("unexpected failed/recovered transition: \(summary)") }
                }
                if let fault = step.fault {
                    guard summary.components(separatedBy: "dev hook:").last?.contains(fault) == true else { throw Fail("armed fault never reached intended step") }
                    if step.recovers && !summary.contains("recovered:") { throw Fail("suppressed fullscreen did not exercise recovery") }
                }
                var final = ""
                let cleanupDeadline = ProcessInfo.processInfo.systemUptime + 3
                repeat {
                    final = await dump()
                    if clean(final) { break }
                    await pause(0.1)
                } while ProcessInfo.processInfo.systemUptime < cleanupDeadline
                guard clean(final) else { throw Fail("cleanup/pending call verification failed after request \(index)") }
                guard let destination = liveShownNumber(final), ready(destination),
                      validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: lab.calls.server(destination)?.pid, app: appPID),
                      validationTestProfile(final) == (step.recovers ? sourceName : targetName),
                      step.recovers ? destination == source : destination != source else { throw Fail("final native full-screen/front/source identity failed") }
                if !step.recovers {
                    guard lab.calls.server(source) == nil || lab.calls.parked(source) else { throw Fail("outgoing window is neither parked nor gone") }
                    if step.old == "close" || step.fault == "park" {
                        guard lab.calls.server(source) == nil else { throw Fail("close/fallback did not actually close outgoing test window") }
                    }
                }
                if prospective && step.fault == nil && step.old == "park" {
                    guard lab.calls.server(source) != nil, lab.calls.parked(source) else { throw Fail("normal control used a close fallback") }
                    if let expected = profileWindows[targetName], expected != destination { throw Fail("target native identity changed") }
                    profileWindows[targetName] = destination
                    guard fixedTopology(final) else { throw Fail("normal two-window topology changed after request") }
                }
                // A real demotion is never silently reset to finish the benchmark.
                if index < finalIndex {
                    guard final.contains("park on;"), final.contains("choices: freeze on"), final.contains("live cover session: on") else {
                        throw Fail("genuine capability/session demotion; stop")
                    }
                }
                let elapsed = Int(epochMs() - started)
                var verified: [String: Any] = ["ok": true, "status": step.fault == nil ? "pass" : "expected_fault",
                          "source": source, "destination": destination, "elapsed_ms": elapsed, "summary": summary]
                if prospective {
                    verified.merge(["transition": transition?.rawValue ?? "expected_fault",
                        "degraded_control": transition == .degradedFreeze,
                        "early_reveal_hazard": transition == .degradedFreeze,
                        "final_verified": true, "cleanup_verified": true, "mechanism_verified": true,
                        "capabilities_preserved": index == finalIndex ? false : true,
                        "topology_verified": step.fault == nil && step.old == "park",
                        "final_verified_ms": elapsed]) { _, new in new }
                    if let reveal = liveSummaryNumber(summary, pattern: #"request to reveal ([0-9]+) ms"#) { verified["request_to_reveal_ms"] = reveal }
                    if let held = liveSummaryNumber(summary, pattern: #"frozen ([0-9]+) ms \(result 0\)"#) { verified["freeze_held_ms"] = held }
                }
                try event("settled", index: index, step: step, extra: verified)
                let measured = "\(index)/50 \(step.phase)/\(step.mode): \(elapsed) ms final verified; \(summary)"
                lines.append(measured); note(measured)
                await pause(1)
            }
            try event("validation_end", extra: ["ok": true])
            lines.append("\(numbered.count) requests checked here; post-idle precedes fault/close cases; physical-display and resource analysis remain separate\(liveOnly ? "; matched comparison still failed" : "")")
            return Outcome(status: .recorded, lines: lines)
        } catch {
            try? event("settled", index: index, extra: ["ok": false, "status": "fail", "error": "\(error)"])
            lines.append("stopped at \(index)/50: \(error); no further request")
            return Outcome(status: .fail, lines: lines)
        }
    }) }
