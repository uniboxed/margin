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
