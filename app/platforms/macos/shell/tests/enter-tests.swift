// Opening Margin (ShellEnter.swift), part of tests.swift's run: which window
// it opens into, and which browser it opens when there's none.
import AppKit
import Foundation

func enterTests() {
    func w(_ link: String, _ id: Int, state: String = "normal", focused: Bool = false, focusedAt: Double? = nil, createdAt: Double? = nil) -> ExtWindow {
        ExtWindow(key: WindowKey(link: link, windowId: id), bounds: CGRect(x: 0, y: 0, width: 800, height: 600), state: state, focused: focused,
                  activeTabId: nil, focusedAt: focusedAt, createdAt: createdAt)
    }
    func key(_ link: String, _ id: Int) -> WindowKey { WindowKey(link: link, windowId: id) }

    check("open: no windows, no window", EnterPick.pick([]) == nil)
    check("open: the only window", EnterPick.pick([w("safari:P", 4)]) == key("safari:P", 4))
    check("open: the focused window before one focused later (the copy says which is in front now)",
          EnterPick.pick([w("safari:P", 1, focusedAt: 90), w("safari:P", 2, focused: true, focusedAt: 50)]) == key("safari:P", 2))
    check("open: nothing focused (the browser isn't in front): the window focused last",
          EnterPick.pick([w("safari:P", 1, focusedAt: 40), w("safari:P", 2, focusedAt: 70), w("safari:P", 3)]) == key("safari:P", 2))
    check("open: across profiles, each with its own focused window: the one focused last",
          EnterPick.pick([w("safari:P", 1, focused: true, focusedAt: 40), w("safari:Q", 1, focused: true, focusedAt: 60)]) == key("safari:Q", 1))
    check("open: never focused since the copies started: the window made last",
          EnterPick.pick([w("safari:P", 1, createdAt: 10), w("safari:P", 2, createdAt: 30)]) == key("safari:P", 2))
    check("open: nothing to tell them apart: the lowest id of the first link, whatever the order",
          EnterPick.pick([w("safari:Q", 2), w("safari:P", 9), w("safari:P", 3)]) == key("safari:P", 3))
    check("open: a minimized window only when there's no other",
          EnterPick.pick([w("safari:P", 1, state: "minimized", focused: true, focusedAt: 99), w("safari:P", 2, focusedAt: 5)]) == key("safari:P", 2))
    check("open: only minimized windows: one of them (asked for in front, it comes back)",
          EnterPick.pick([w("safari:P", 1, state: "minimized", focusedAt: 5), w("safari:P", 2, state: "minimized", focusedAt: 9)]) == key("safari:P", 2))
    check("open: a parked window is never the one",
          EnterPick.pick([w("safari:P", 1, state: "fullscreen", focused: true, focusedAt: 99), w("safari:Q", 1, focusedAt: 5)], skip: { $0.link == "safari:P" }) == key("safari:Q", 1))
    check("open: every window parked: none", EnterPick.pick([w("safari:P", 1)], skip: { _ in true }) == nil)
    check("open: a full-screen window is as good as any (it's asked for in front)",
          EnterPick.pick([w("safari:P", 1, state: "fullscreen", focusedAt: 80), w("safari:P", 2, focusedAt: 20)]) == key("safari:P", 1))

    let known = ["safari", "chrome", "edge"]
    check("open: the browser: a linked one first", EnterPick.browser(linked: ["chrome"], running: ["safari", "chrome"], last: "safari", known: known) == "chrome")
    check("open: the browser: none linked, the last one linked if it's running", EnterPick.browser(linked: [], running: ["chrome", "edge"], last: "edge", known: known) == "edge")
    check("open: the browser: none linked, another running one when the last isn't", EnterPick.browser(linked: [], running: ["chrome"], last: "safari", known: known) == "chrome")
    check("open: the browser: nothing running, the last one linked", EnterPick.browser(linked: [], running: [], last: "edge", known: known) == "edge")
    check("open: the browser: nothing running, Safari the first time", EnterPick.browser(linked: [], running: [], last: "safari", known: known) == "safari")
    check("open: the browser: a name that isn't one Margin works in is never opened", EnterPick.browser(linked: ["arc"], running: ["arc"], last: "arc", known: known) == nil)
}
