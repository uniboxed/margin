// The product path only: no external cover can hide a failure. All writes are
// through the existing Test A/Test B-only hook. No profile/window pre-creation.
import AppKit

let profileValidationGate = Gate(
    id: "VALIDATE", title: "Matched freeze/live reliability, cleanup and resource validation",
    decides: "42 normal measured switches, 4 warmups, 2 guarded faults and 2 close-mode requests; physical display remains a separate check",
    needs: [.margin, .devHook], freezes: "up to 50 Test A/Test B requests, about 7 minutes including two 60-second idle samples",
    plan: ["installed opted-in candidate, one display, foreground full-screen Test A or Test B; parking on, close setting off, no caps/faults",
           "same Margin PID throughout; a subtractive Test A/Test B cover cap selects the actual freeze control without restarting",
           "4 excluded balanced warmups; 60-second pre-idle; 24 ABBA matched requests (12 freeze/12 live); 18 additional live requests",
           "60-second normal post-idle BEFORE fault/close cases; then suppressed-fullscreen recovery, two close requests, one suppressed park with close fallback",
           "fresh summary and native destination/source verification, cover audit and closed-window check after EVERY request; never reset genuine failure gates",
           "write timestamped request/settled/idle events; run memory.py separately; no pixel coverage/physical-camera acceptance inferred",
           "first unexpected failure stops all further requests; restore test caps on every exit; outer runner restores the launch preference"],
    run: { lab in
        guard let app = Margin.running, Margin.devHooksOn,
              UserDefaults(suiteName: "com.unibox.margin")?.bool(forKey: "MarginLiveProfileCover") == true else {
            return Outcome(status: .notRun, lines: ["requires running opted-in candidate and guarded hook; nothing switched"])
        }
        let appPID = app.processIdentifier
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
        @MainActor func idle(_ phase: String) async throws {
            try event("idle_begin", step: .init(phase: phase, mode: "live"))
            await pause(60)
            let state = await dump()
            guard Margin.running?.processIdentifier == appPID, clean(state),
                  let n = liveShownNumber(state), ready(n),
                  validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: lab.calls.server(n)?.pid, app: appPID) else {
                throw Fail("\(phase) idle cleanup/source state changed")
            }
            try event("idle_end", step: .init(phase: phase, mode: "live"))
        }
        var lines = ["events: \(events.path)", "same-process matched control; no external cover or recorder"]
        let initial = await dump()
        guard initial.contains("handoff on, parking on"), initial.contains("close windows off; displays 1"),
              initial.contains("no caps; no faults armed"), initial.contains("live cover session: on"),
              let firstSource = liveShownNumber(initial), ready(firstSource), validationTestProfile(initial) != nil, clean(initial),
              let browser = lab.calls.server(firstSource),
              validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: browser.pid, app: appPID) else {
            return Outcome(status: .notRun, lines: lines + ["guarded foreground source/capability/preconditions not ready; nothing switched"])
        }
        // Only subtractive test caps are restored, not real FreezeRules/parking/cover demotions.
        lab.restoreValidationMode = true
        defer { Margin.dev("mode", ["freeze": "on", "cover": "on", "old": "park"]); lab.restoreValidationMode = false }
        var index = 0
        do {
            try event("validation_begin")
            let steps = profileValidationPlan()
            for (offset, step) in steps.enumerated() {
                index = offset + 1
                if index == 5 { try await idle("pre_idle") }
                if index == 47 { try await idle("post_idle") }
                guard Margin.running?.processIdentifier == appPID else { throw Fail("Margin restarted; comparison invalid") }
                let state = await dump()
                guard let source = liveShownNumber(state), ready(source), clean(state),
                      let sourceName = validationTestProfile(state),
                      state.contains("live cover session: on") else { throw Fail("source or cleanup not ready before request \(index)") }
                guard validationForegroundAllowed(NSWorkspace.shared.frontmostApplication?.processIdentifier, browser: lab.calls.server(source)?.pid, app: appPID) else {
                    throw Fail("foreground app changed; no further request")
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
                guard !summary.contains("late ("), !summary.contains("aborted"),
                      !summary.contains("recovered") || step.recovers else { throw Fail("unexpected failed/recovered transition: \(summary)") }
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
                // A real demotion is never silently reset to finish the benchmark.
                if index < 50 {
                    guard final.contains("park on;"), final.contains("choices: freeze on"), final.contains("live cover session: on") else {
                        throw Fail("genuine capability/session demotion; stop")
                    }
                }
                let elapsed = Int(epochMs() - started)
                try event("settled", index: index, step: step, extra: ["ok": true, "status": step.fault == nil ? "pass" : "expected_fault",
                          "source": source, "destination": destination, "elapsed_ms": elapsed, "summary": summary])
                let measured = "\(index)/50 \(step.phase)/\(step.mode): \(elapsed) ms final verified; \(summary)"
                lines.append(measured); note(measured)
                await pause(1)
            }
            try event("validation_end", extra: ["ok": true])
            lines.append("50 requests checked; comparative post-idle precedes fault/close cases; physical-display and resource analysis remain separate")
            return Outcome(status: .recorded, lines: lines)
        } catch {
            try? event("settled", index: index, extra: ["ok": false, "status": "fail", "error": "\(error)"])
            lines.append("stopped at \(index)/50: \(error); no further request")
            return Outcome(status: .fail, lines: lines)
        }
    })
