import Foundation

// macOS's web search record, read for the palette's search (DECISIONS.md "The palette's search: the engine from macOS,
// its suggestions"; the rules are the core's, core/session/suggest.rs).
//
// Safari writes the engine chosen in its Settings (never the private windows' one) to the user's global preferences,
// `NSPreferredWebServices` → `NSWebServicesProviderWebSearch` { NSProviderIdentifier, NSDefaultDisplayName }, and does
// again each time it starts (read in Safari 27.2's code: `-[SearchProvidersController _setSystemDefaultProvider:]`,
// from `setDefaultProvider:forPrivateBrowsing:` and as it loads its engines). CoreFoundation's writer posts the Darwin
// notice `com.apple.CFPreferences.WebServices._didChange` after it. Any app reads the record: no permission asked.
// Read at launch and at each notice; what it says goes to the core as it is (`changed`).
final class SearchEngineRecord {
    static let notice = "com.apple.CFPreferences.WebServices._didChange"
    private static let key = "NSPreferredWebServices" as CFString
    private static let webSearch = "NSWebServicesProviderWebSearch"

    // (identifier, name), as the record has them (nil: not there).
    typealias Said = (identifier: String?, name: String?)
    private let changed: (Said) -> Void
    private var observing = false

    init(changed: @escaping (Said) -> Void) {
        self.changed = changed
    }

    deinit { stop() }

    // The record now: read again from the preferences daemon (another process wrote it).
    static func read() -> Said {
        CFPreferencesSynchronize(kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        let value = CFPreferencesCopyValue(key, kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        let provider = (value as? [String: Any])?[webSearch] as? [String: Any]
        return (provider?["NSProviderIdentifier"] as? String, provider?["NSDefaultDisplayName"] as? String)
    }

    // Said once now, then at each notice (on the main queue).
    func start() {
        changed(Self.read())
        guard !observing else { return }
        observing = true
        let me = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), me, { _, observer, _, _, _ in
            guard let observer else { return }
            let record = Unmanaged<SearchEngineRecord>.fromOpaque(observer).takeUnretainedValue()
            DispatchQueue.main.async { record.changed(SearchEngineRecord.read()) }
        }, Self.notice as CFString, nil, .deliverImmediately)
    }

    func stop() {
        guard observing else { return }
        observing = false
        CFNotificationCenterRemoveObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(), CFNotificationName(Self.notice as CFString), nil)
    }
}

// The engine's suggestions asked (the core's `fetch`: its address, its number, the window it's for): an ephemeral
// session (no cookies, no cache, no credentials), a short limit, the answer read up to `largest` bytes.
enum SuggestionFetch {
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 4
        c.timeoutIntervalForResource = 6
        c.httpCookieAcceptPolicy = .never
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    // (status, body): status 0 when none came (the network, the limit, a bad address); the body empty past `largest`.
    static func send(_ fetch: JSONObject) async -> (Int, String) {
        guard let text = fetch["url"] as? String, let url = URL(string: text), url.scheme == "https" else { return (0, "") }
        let largest = fetch["largest"] as? Int ?? 65536
        var req = URLRequest(url: url)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await session.data(for: req), let http = response as? HTTPURLResponse else { return (0, "") }
        guard data.count <= largest else { return (http.statusCode, "") }
        return (http.statusCode, String(decoding: data, as: UTF8.self))
    }
}
