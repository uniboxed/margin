// DEV-HOOK: the dev-only test hook's checks go with it before production.
//
// The dev hook (app/engines/webkit/safari/DevHooks.swift) against a fake world: refused with its default off, the
// host kind's fields checked before the world is asked, the address never in its line; and the log's scrub.

import AppKit

// DEV-HOOK
final class FakeDevWorld: DevHookWorld {
    var hosted: [String] = []
    func devHost(app: String?, url: String?) -> String? { hosted.append(app ?? "url"); return "not in the fake" }
    func devForgetTestItems(also apps: [String]) -> String? { hosted.append("forget \(apps.joined(separator: ","))"); return nil }
    func devKey(_ name: String) -> String? { hosted.append("key \(name)"); return nil }
    func devSidebar(width: Int) -> String? { hosted.append("sidebar \(width)"); return nil }
    func devFront() -> String { "mechanism level, page shown" }
    func devPage(_ what: String, done: @escaping (String) -> Void) { done(what == "field" ? "focused true, length 3, palette true" : "at 120,600") }
    func devPicture(watch seconds: Double?, done: @escaping (String) -> Void) { done(seconds.map { "watched \($0) s" } ?? "page shown, page area painted 0 of 81") }
}

func devHooksTests() {
    func setup(_ on: Bool = true) -> (FakeDevWorld, DevHooks) {
        let w = FakeDevWorld()
        return (w, DevHooks(world: w, isOn: { on }))
    }

    // ---- host: a palette pick for the hosting checks ----
    do {
        let (offWorld, off) = setup(false)
        check("dev hook: host, off: refused", off.heard(.host, ["app": "test.margin.pane"]).contains("refused: MarginDevHooks isn't YES") && offWorld.hosted.isEmpty)
        let (world, hooks) = setup(true)
        check("dev hook: host, on: needs one of app or url", hooks.heard(.host, [:]).contains("refused: give app or url"))
        check("dev hook: host, on: a bundle id with other characters refused", hooks.heard(.host, ["app": "a/b"]).contains("refused: not a bundle id"))
        check("dev hook: host, on: only http(s) addresses", hooks.heard(.host, ["url": "file:///etc"]).contains("refused: not an http(s) address"))
        check("dev hook: host, on: nothing asked of the shell for a refused one", world.hosted.isEmpty)
        let line = hooks.heard(.host, ["url": "https://example.com/private"])
        check("dev hook: host, on: asked of the shell, the address never in the line", line.contains("refused: not in the fake") && !line.contains("example") && world.hosted == ["url"], line)
        let forget = hooks.heard(.host, ["forget": "test", "apps": "com.example.a,bad/id"])
        check("dev hook: host forget: only bundle ids handed on", forget.contains("host forget test items") && world.hosted.last == "forget com.example.a", "\(world.hosted)")
        check("dev hook: host key: the palette's key and a press outside only", hooks.heard(.host, ["key": "palette"]).contains("host key palette") && hooks.heard(.host, ["key": "close"]).contains("host key close")
              && hooks.heard(.host, ["key": "quit"]).contains("refused: no such key") && world.hosted.suffix(2) == ["key palette", "key close"], "\(world.hosted)")
        check("dev hook: host sidebar: a width in points, within reason", hooks.heard(.host, ["sidebar": "300"]).contains("host sidebar 300") && hooks.heard(.host, ["sidebar": "9000"]).contains("refused: not a width")
              && hooks.heard(.host, ["sidebar": "wide"]).contains("refused: not a width") && world.hosted.last == "sidebar 300", "\(world.hosted)")
        check("dev hook: host say front: one line of how the window is in front", hooks.heard(.host, ["say": "front"]).contains("dev hook: front: mechanism level, page shown"))
        _ = hooks.heard(.host, ["say": "picture"])
        _ = hooks.heard(.host, ["say": "picture", "watch": "900"])
        check("dev hook: host say picture: the page area in Margin's own window's picture, once or watched (20 s at most)",
              hooks.lines.contains { $0.contains("dev hook: picture: page shown, page area painted 0 of 81") } && hooks.lines.contains { $0.contains("dev hook: picture: watched 20.0 s") }, "\(hooks.lines.suffix(4))")
        _ = hooks.heard(.host, ["say": "field"])
        _ = hooks.heard(.host, ["say": "spot"])
        check("dev hook: host say field and spot: the focused field's length only, an empty point of the sidebar",
              hooks.lines.contains { $0.contains("dev hook: field: focused true, length 3") } && hooks.lines.contains { $0.contains("dev hook: spot: at 120,600") }, "\(hooks.lines.suffix(4))")
    }
    do {
        let (_, hooks) = setup()
        for _ in 0..<160 { hooks.heard(.host, [:]) }
        check("dev hook: only bounded recent lines kept", hooks.lines.count == DevHooks.retainedLineLimit)
    }
    // ---- the fields: userInfo's strings, or the extension's JSON string ----
    do {
        let f = DevHooks.fields(object: #"{"app":"com.example.a","pid":7}"#, userInfo: nil)
        check("dev hook: fields from a JSON string object", f == ["app": "com.example.a", "pid": "7"], "\(f)")
        let u = DevHooks.fields(object: nil, userInfo: ["app": "com.example.b", "pid": NSNumber(value: 9), "long": String(repeating: "x", count: 65), "deep": ["x": 1]])
        check("dev hook: fields from userInfo, long or nested values left out", u == ["app": "com.example.b", "pid": "9"], "\(u)")
    }
    // ---- the log's scrub: no title or address ----
    check("scrub: link keys and Margin's words kept", Diagnostics.scrub("host: safari:s-a#3 → safari:s-b#7, its window full screen") == "host: safari:s-a#3 → safari:s-b#7, its window full screen")
    check("scrub: addresses", Diagnostics.scrub("at file:///Users/x/a.html and about:blank, safari-web-extension://AB/x") == "at (an address) and (an address), (an address)")
    check("scrub: cut at its limit", Diagnostics.scrub(String(repeating: "a", count: 10), max: 4) == "aaaa…")
}
