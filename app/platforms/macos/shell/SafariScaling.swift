import Foundation

// Safari's own scaling of a full-screen window's pages turned off, so a Safari tile a drag narrows lays its page out
// again at each width, as a plain window's does (DECISIONS.md "Safari laid out live while a drag narrows it").
//
// Safari (`-[BrowserViewController _updateWKViewLayoutModeForWindow:]`, read in Safari 27.2's code) puts the web view of
// a window in full screen, as Margin hosts it, in WebKit's layout mode 4 (DynamicSizeComputedFromMinimumDocumentSize:
// WebKit lays the page out at the document's width when it's wider than the view and scales it down to fit, and stays so
// until the view is that wide again: the page left drawn small after a drag). Its default
// `DebugDisableTiledFullScreenScalingMode`, true, keeps it from setting any mode: the web view keeps mode 0, laid out at
// its size. Read with NSUserDefaults each time, so the global domain reaches Safari, sandboxed (its own container's
// would need the person's permission). A web view already put in mode 4 keeps it: a Safari started before it was set
// still scales (HostEngine `relayNarrowed` lays its tiles out again after a drag).
enum SafariScaling {
    static let key = "DebugDisableTiledFullScreenScalingMode"
    // Margin's own default: when it set Safari's (seconds since 1970).
    static let sinceKey = "MarginSafariScalingOffSince"

    // Since when Safari's scaling is off (seconds since 1970): a Safari started at or after it never scales; nil, it isn't
    // (the write not taken). Set once, the first time it's read (at launch, before Margin starts any browser).
    static let offSince: Double? = turnOff()

    private static func isOff() -> Bool {
        CFPreferencesCopyValue(key as CFString, kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? Bool == true
    }

    private static func turnOff() -> Double? {
        let defaults = UserDefaults.standard
        let now = Date().timeIntervalSince1970
        if isOff() {
            // (Set by Margin before: since then. Set by someone else: since when isn't known, so from now.)
            if let since = defaults.object(forKey: sinceKey) as? Double, since <= now { return since }
            defaults.set(now, forKey: sinceKey)
            Diagnostics.note("Safari's full-screen page scaling: already off (\(key)): a Safari started from now lays its pages out as a drag narrows it")
            return now
        }
        CFPreferencesSetValue(key as CFString, kCFBooleanTrue, kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        CFPreferencesSynchronize(kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        guard isOff() else {
            defaults.removeObject(forKey: sinceKey)
            Diagnostics.note("Safari's full-screen page scaling: NOT turned off (\(key) not taken): a narrowed Safari tile is laid out again after each drag")
            return nil
        }
        defaults.set(now, forKey: sinceKey)
        Diagnostics.note("Safari's full-screen page scaling: turned off (\(key)): a Safari started from now lays its pages out as a drag narrows it")
        return now
    }
}
