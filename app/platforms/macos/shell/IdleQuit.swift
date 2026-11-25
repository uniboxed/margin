// When Margin.app quits by itself (AppDelegate.swift's 30 s check). Margin is the app (docs/MARGIN-APP.md): opened by
// the person, it runs until they quit it, with a window open or not, hosting or not. Only a Margin.app that something
// started in the background (margin-helper as a browser opened, with --background; a login item; the extension
// handler, for a copy's link) and that the person never opened leaves again by itself: once no browser Margin works in
// is running, no copy is linked and nothing is hosted, for `after` seconds on end. margin-helper (or the extension,
// asking for its link) starts it again when a browser opens.

import Foundation

nonisolated enum IdleQuit {
    static let after: TimeInterval = 60

    struct State: Equatable {
        var startedInBackground: Bool // started with no window: --background, a login item, the handler's link start
        var shown: Bool // a window of Margin's has been shown since (Margin's own window, or the set-up window)
        var hosting: Bool // an app or a Safari window is hosted, or one is still being given back
        var linked: Bool // an extension copy is linked
        var browserOpen: Bool // a browser Margin works in is running
    }

    // Nothing keeps it: started in the background, never opened by the person, nothing hosted, no copy, no browser.
    static func idle(_ s: State) -> Bool {
        s.startedInBackground && !s.shown && !s.hosting && !s.linked && !s.browserOpen
    }

    // One check. `since`: when it was first seen idle (nil: it wasn't at the last check). What to keep as `since`,
    // and whether to quit now: only after `after` seconds idle without a break.
    static func check(_ s: State, since: Date?, now: Date) -> (since: Date?, quit: Bool) {
        guard idle(s) else { return (nil, false) }
        let from = since ?? now
        return (from, now.timeIntervalSince(from) >= after)
    }
}
