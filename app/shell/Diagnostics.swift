// Margin.app's own log: os_log, subsystem io.tirth.margin, category shell. Read it with
//   /usr/bin/log stream --predicate 'subsystem == "io.tirth.margin"'
// (in zsh, `log` is a builtin). Only what the app does and how long it took:
// never a page's title or address.

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

    // A monotonic clock (seconds), for timings.
    static func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    // Milliseconds since `start` (from now()), as a log shows them.
    static func ms(since start: TimeInterval) -> String {
        String(format: "%.1f ms", (now() - start) * 1000)
    }
}
