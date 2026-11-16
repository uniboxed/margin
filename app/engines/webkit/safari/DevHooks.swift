// DEV-HOOK: this whole file goes before production, with every line marked DEV-HOOK in the other files
// (`git grep DEV-HOOK` finds them all).
//
// A dev-only test hook for the on-screen checks of hosting (TESTING.md), with no Accessibility, no AppleScript and
// no clicks:
//
// - Distributed notifications, `com.unibox.margin.dev.host`, as ExtensionLink hears the extension's (its fields in
//   userInfo, or a JSON string as the object), with deliverImmediately (and heard that way too, so Margin.app not
//   being the active app holds nothing back).
// - Off unless `defaults write com.unibox.margin MarginDevHooks -bool YES`. Read at each notification, never kept:
//   turned off, the next one is refused.
// - `host { app: bundle id }` or `host { url: http(s) address }`: what a palette pick does, in Margin's front window;
//   `host { forget: test, apps? }`: the items the checks themselves added, removed from the library.
// - Each notification is one log line, honoured or refused: the kind, ids and the sender's pid (as it says it). The
//   address itself is never logged.

import AppKit
import CoreFoundation

// DEV-HOOK: what the hook needs from the shell (Shell, below; the tests' fake).
protocol DevHookWorld: AnyObject {
    // What a palette pick does, an installed app by bundle id or an address in a new web item, in Margin's front
    // window. Nil if asked, else why not.
    func devHost(app: String?, url: String?) -> String?
    func devForgetTestItems(also apps: [String]) -> String? // nil if done, else why not (`apps`: app items a check added)
}

// DEV-HOOK: the hook itself.
final class DevHooks {
    static let retainedLineLimit = 128
    static let prefix = "com.unibox.margin.dev."
    static let defaultsKey = "MarginDevHooks"
    enum Kind: String, CaseIterable { case host }

    weak var world: DevHookWorld?
    let isOn: () -> Bool // the MarginDevHooks default, read each time
    private var receiver: Receiver?
    private(set) var lines: [String] = [] // what it said (the tests read it)

    init(world: DevHookWorld, isOn: @escaping () -> Bool) {
        self.world = world
        self.isOn = isOn
    }

    static func appDefault() -> Bool { UserDefaults.standard.bool(forKey: defaultsKey) }

    func listen(_ center: DistributedNotificationCenter = .default()) {
        guard receiver == nil else { return }
        let r = Receiver { [weak self] name, fields in
            guard let self, name.hasPrefix(Self.prefix), let kind = Kind(rawValue: String(name.dropFirst(Self.prefix.count))) else { return }
            self.heard(kind, fields)
        }
        for kind in Kind.allCases {
            center.addObserver(r, selector: #selector(Receiver.heard(_:)), name: NSNotification.Name(Self.prefix + kind.rawValue), object: nil, suspensionBehavior: .deliverImmediately)
        }
        receiver = r
        Diagnostics.note("dev hook: listening for \(Self.prefix)* (honoured only while \(Self.defaultsKey) is YES, now \(isOn() ? "YES" : "off"))")
    }

    func stop(_ center: DistributedNotificationCenter = .default()) {
        guard let r = receiver else { return }
        center.removeObserver(r)
        receiver = nil
    }

    // One notification: honoured or refused, one line either way (returned).
    @discardableResult func heard(_ kind: Kind, _ fields: [String: String]) -> String {
        let pid = fields["pid"].flatMap { Int($0) }.map(String.init) ?? "?"
        let asked = "(asked by pid \(pid))"
        func refuse(_ why: String) -> String { say("dev hook: \(Self.prefix)\(kind.rawValue) refused: \(why) \(asked)") }
        guard isOn() else { return refuse("\(Self.defaultsKey) isn't YES") }
        guard let world else { return refuse("no shell") }
        switch kind {
        case .host:
            // `forget`: the items the on-screen checks themselves added, removed from the library (only these test
            // targets: the kit's test app, example.com / example.org).
            if fields["forget"] == "test" {
                if let why = world.devForgetTestItems(also: (fields["apps"] ?? "").split(separator: ",").map(String.init).filter { id in id.count <= 155 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") } }) { return refuse(why) }
                return say("dev hook: host forget test items \(asked)")
            }
            let app = fields["app"], url = fields["url"]
            if let app, !(app.count <= 155 && app.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" })) { return refuse("not a bundle id") }
            if let url, !(url.hasPrefix("https://") || url.hasPrefix("http://")) || url.count > 2000 { return refuse("not an http(s) address") }
            guard (app == nil) != (url == nil) else { return refuse("give app or url") }
            if let why = world.devHost(app: app, url: url) { return refuse(why) }
            return say("dev hook: host \(app.map { "app \($0)" } ?? "url (\(url?.count ?? 0) characters)") \(asked)")
        }
    }

    @discardableResult private func say(_ line: String) -> String {
        lines.append(line)
        if lines.count > Self.retainedLineLimit { lines.removeFirst(lines.count - Self.retainedLineLimit) }
        Diagnostics.note(line)
        return line
    }

    // A notification's fields: userInfo's strings, then a JSON string object's (the extension's way).
    nonisolated static func fields(object: Any?, userInfo: [AnyHashable: Any]?) -> [String: String] {
        var out: [String: String] = [:]
        func take(_ k: AnyHashable, _ v: Any) {
            guard let key = k as? String, key.count <= 16 else { return }
            if let s = v as? String, s.count <= 64 { out[key] = s } else if let n = v as? NSNumber { out[key] = n.stringValue }
        }
        if let text = object as? String, text.count <= 1024, let data = text.data(using: .utf8),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            for (k, v) in json { take(k, v) }
        }
        for (k, v) in userInfo ?? [:] { take(k, v) }
        return out
    }

    // The observer: on the main thread (the run loop it was added on).
    private final class Receiver: NSObject {
        let fire: (String, [String: String]) -> Void
        init(_ fire: @escaping (String, [String: String]) -> Void) { self.fire = fire }
        @objc nonisolated func heard(_ note: Notification) {
            let name = note.name.rawValue
            let fields = DevHooks.fields(object: note.object, userInfo: note.userInfo)
            MainActor.assumeIsolated { fire(name, fields) }
        }
    }
}

// DEV-HOOK: the shell's side.
extension Shell: DevHookWorld {
    func devForgetTestItems(also apps: [String]) -> String? {
        guard let library else { return "no library" }
        let bundles = Set(["test.margin.pane"] + apps)
        let test: (JSONObject) -> Bool = { v in
            let target = v["target"] as? JSONObject
            if let b = target?["bundleId"] as? String, bundles.contains(b) { return true }
            guard let url = v["url"] as? String, let host = URL(string: url)?.host else { return false }
            return host == "example.com" || host == "example.org"
        }
        let ids = library.items().filter { test($0.value) }.map(\.id)
        for id in ids { library.perform("removeItem", ["tabId": id]) }
        Diagnostics.note("dev hook: \(ids.count) test item(s) removed from the library")
        return nil
    }

    func devHost(app: String?, url: String?) -> String? {
        if let app {
            guard let openApp else { return "no host" }
            openApp(app)
            return nil
        }
        guard let url, let front = marginWindows?.front else { return "no Margin window" }
        front.ask("newTab", ["url": url])
        return nil
    }
}
