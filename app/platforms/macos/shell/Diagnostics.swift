// Margin.app's own log: os_log, subsystem io.tirth.margin, category shell. Read it with
//   /usr/bin/log stream --predicate 'subsystem == "io.tirth.margin"'
// (in zsh, `log` is a builtin). Only what the app does and how long it took:
// never a page's title or address.
//
// The profile handoff's lines (docs/HANDOFF.md §8.1), ids, window numbers, Space ids, counts, modes,
// results and milliseconds only:
//   private calls on macOS …: freeze ok, spaces ok, park ok (…)     the launch check (PrivateCalls.swift)
//   private calls: macOS build changed from … to …                  a new macOS build
//   private calls: cross-process self-test park N ms, …             the self-test (BridgeParker.swift)
//   private calls: park off | freeze off for this session: …        a demotion (Handoff.swift, Freezer.swift)
//   handoff: safari:s-a#3 → safari:s-b#7 (park+freeze, parked target), frozen 1214 ms (result 0): shown 9, …
//                                                                   one summary per switch (Handoff.swift)
//   handoff: parked window N (…) in its Space S in 9 ms (…)         the registry (Parking.swift)
//   profile switch: aftercare: window N …                           the aftercare (Handoff.swift)
//   <link>: setWindowState window 3: …                              the copy's side (background/handoff.ts)
//   dev hook: …                                                     the dev-only hook (DevHooks.swift; DEV-HOOK)
// Words that come from outside the app (a copy's error, a browser's message) go through scrub()
// before they reach a line: Margin doesn't choose them, and a browser's error can name a page.

import Foundation
import os

enum Diagnostics {
    static let logger = Logger(subsystem: "io.tirth.margin", category: "shell")

    // Also each line here (tools/app-tests print them).
    static var echo: ((String) -> Void)?

    static func note(_ line: String) {
        logger.notice("\(line, privacy: .public)")
        echo?(line)
    }

    static func warn(_ line: String) {
        logger.error("\(line, privacy: .public)")
        echo?("warning: " + line)
    }

    // Anything in `text` that could be a page's address or a quoted title taken out, and the rest cut
    // at `max` characters. Link keys ("safari:s-a#3") and Margin's own words are left as they are.
    static func scrub(_ text: String, max: Int = 600) -> String {
        var s = text
        for (pattern, with) in scrubRules {
            s = s.replacingOccurrences(of: pattern, with: with, options: .regularExpression)
        }
        return s.count > max ? String(s.prefix(max)) + "…" : s
    }

    // Quotes first, so an address inside a quoted title goes with it. An address ends at a space, a
    // quote or a bracket, and a full stop or comma after it stays the sentence's.
    private static let scrubRules: [(String, String)] = [
        (#""[^"\n]*""#, "\"…\""), // a quoted title, as browsers quote them in errors
        ("“[^”\n]*”", "“…”"),
        (#"(?i)\b[a-z][a-z0-9+.\-]*://(?:[^\s"“”'<>()\[\]]*[^\s"“”'<>()\[\],.;:!?])?"#, "(an address)"), // https://…, file://…
        (#"(?i)\b(?:about|data|blob|javascript|mailto|file|view-source|tel):(?:[^\s"“”'<>()\[\]]*[^\s"“”'<>()\[\],.;:!?])"#, "(an address)"),
        (#"(?i)\bwww\.(?:[^\s"“”'<>()\[\]]*[^\s"“”'<>()\[\],.;:!?])"#, "(an address)"),
    ]

    // A monotonic clock (seconds), for timings.
    static func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    // Milliseconds since `start` (from now()), as a log shows them.
    static func ms(since start: TimeInterval) -> String {
        String(format: "%.1f ms", (now() - start) * 1000)
    }
}
