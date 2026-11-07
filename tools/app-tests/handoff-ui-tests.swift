// The switch's settings and words on the app's side (app/HANDOFF.md §5, §7):
// "Close windows to save memory" kept in data/<browser>/browser.json and sent
// to every overlay as `across.switchSettings`, and the switch's notices by
// kind (SwitchNotice), with the window a kept-draft notice can close never
// sent to an overlay. The overlay's side is npm test's (tests/handoff-ui.test.js).

import Foundation

func handoffUiTests() {
    // ---- "Close windows to save memory" ----
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-handoff-ui-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let bp = BrowserProfiles(browser: "safari", root: root)
    bp.refresh(spaces: ["s-default": ["home"], "s-2": ["job"]], linked: ["s-default", "s-2"])
    check("close windows: off at first", !bp.closeWindows)
    let before = bp.saves
    check("close windows: turned on, saved once", bp.setCloseWindows(true) && bp.closeWindows && bp.saves == before + 1)
    check("close windows: on again changes nothing, saves nothing", !bp.setCloseWindows(true) && bp.saves == before + 1)
    let file = object(try? Data(contentsOf: root.appendingPathComponent("safari/browser.json")))
    check("close windows: browser.json switching.closeWindows", (file?["switching"] as? JSONObject)?["closeWindows"] as? Bool == true, "\(file?["switching"] ?? "none")")
    check("close windows: read back", BrowserProfiles(browser: "safari", root: root).closeWindows)
    for profile in ["s-default", "s-2"] {
        let a = bp.across(for: profile, spaces: [:], counts: [:], linked: ["s-default", "s-2"])
        check("close windows: every profile's across says it (\(profile))", (a["switchSettings"] as? JSONObject)?["closeWindows"] as? Bool == true, "\(a["switchSettings"] ?? "none")")
    }
    check("close windows: not sent when it would mean nothing (the handoff off, or parking not passed)",
          bp.across(for: "s-default", spaces: [:], counts: [:], linked: ["s-default", "s-2"], switchSettings: false)["switchSettings"] == nil)
    check("close windows: turned off", bp.setCloseWindows(false) && !BrowserProfiles(browser: "safari", root: root).closeWindows)
    // A file from before the setting: off.
    let old = root.appendingPathComponent("old", isDirectory: true)
    try? FileManager.default.createDirectory(at: old.appendingPathComponent("safari"), withIntermediateDirectories: true)
    try? Data(#"{"format":1,"browser":"safari","order":[],"profiles":{}}"#.utf8).write(to: old.appendingPathComponent("safari/browser.json"))
    check("close windows: a file without it reads as off", !BrowserProfiles(browser: "safari", root: old).closeWindows)
    check("close windows: in memory too", BrowserProfiles(browser: "safari", root: nil).setCloseWindows(true))

    // ---- the switch's notices ----
    let kept = WindowKey(link: "safari:s-a", windowId: 3)
    let shown = WindowKey(link: "safari:s-b", windowId: 7)
    let draft = SwitchNotice(.windowKeptDraft, profile: "safari:s-a", shownIn: shown, kept: kept)
    let stored = draft.stored
    check("notices: kind and profile id, no browser", stored["noticeKind"] as? String == "window-kept-draft" && stored["noticeProfile"] as? String == "s-a")
    check("notices: shown in one window, named as overlays name it", same(stored["noticeIn"], ["profile": "s-b", "windowId": 7]))
    check("notices: the kept window found again", SwitchNotice.kept(stored) == kept)
    let sent = SwitchNotice.sent(stored.merging(["at": 5.0]) { a, _ in a })
    check("notices: an overlay never gets the kept window (or the time)", sent["kept"] == nil && sent["at"] == nil && Set(sent.keys) == ["noticeKind", "noticeProfile", "noticeIn"], "\(sent.keys.sorted())")
    check("notices: only a kept-draft notice keeps a window", SwitchNotice.kept(SwitchNotice(.lateLanding, profile: "safari:s-b", kept: kept).stored) == nil && SwitchNotice.kept(nil) == nil)
    check("notices: a kept draft stays longer than the others", draft.seconds > SwitchNotice(.dialogOpen, profile: "safari:s-a").seconds)
    check("notices: every kind as the overlay knows it", [SwitchNotice.Kind.windowKeptDraft, .dialogOpen, .windowBusy, .lateLanding, .windowOnDesktop].map(\.rawValue)
          == ["window-kept-draft", "dialog-open", "window-busy", "late-landing", "window-on-desktop"])
    // The words are the overlay's: the kinds here must be the ones extension/shared/across.js has.
    let across = (try? String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../extension/shared/across.js"), encoding: .utf8)) ?? ""
    for kind in ["window-kept-draft", "dialog-open", "window-busy", "late-landing", "window-on-desktop"] {
        check("notices: \(kind) has words in across.js", across.contains("'\(kind)': {"))
    }
    check("notices: a link key's profile id", SwitchNotice.profileId("safari:s-a") == "s-a" && SwitchNotice.profileId("s-a") == "s-a")

    // ---- the shell's §13.8 watch: a window gone while a switch runs is kept until it's idle ----
    let k1 = WindowKey(link: "safari:s-a", windowId: 1), k2 = WindowKey(link: "safari:s-a", windowId: 2), k3 = WindowKey(link: "safari:s-b", windowId: 3)
    var watch = ShownCloseWatch()
    var closes: Set<WindowKey> = [k2]
    watch.read(was: [k1, k2, k3], listed: [k3], numbers: [k1: 11, k2: 12, k3: 13], marginCloses: &closes)
    check("shown closed: a window gone kept with its number; Margin's own close taken out", watch.gone == [k1: 11] && closes.isEmpty, "\(watch.gone)")
    watch.read(was: [k3], listed: [k3], numbers: [k3: 13], marginCloses: &closes)
    check("shown closed: … still kept on the next read (a switch still running)", watch.gone == [k1: 11])
    let taken = watch.take()
    check("shown closed: … taken once the switch is idle, then gone", taken.count == 1 && taken[0].key == k1 && taken[0].number == 11 && watch.gone.isEmpty)
    watch.read(was: [k1, k3], listed: [k3], numbers: [k1: 11], marginCloses: &closes)
    watch.read(was: [k3], listed: [k3, k1], numbers: [:], marginCloses: &closes)
    check("shown closed: a window listed again isn't gone", watch.gone.isEmpty)

    // ---- the `parked` word a copy gets (PROTOCOL.md): on once parked, kept through a park or close under way ----
    typealias P = ParkedWindow.Phase
    check("parked word: on once it's parked", Shell.parkedWord(.parked, told: nil) == true && Shell.parkedWord(.parked, told: false) == true && Shell.parkedWord(.parked, told: true) == nil)
    check("parked word: a park under way says nothing yet", Shell.parkedWord(.parking, told: nil) == nil && Shell.parkedWord(.parking, told: false) == nil)
    check("parked word: a re-park of one told on says nothing (no off and on again)", Shell.parkedWord(.parking, told: true) == nil && Shell.parkedWord(.closing, told: true) == nil)
    check("parked word: off once it's out, only after on", Shell.parkedWord(nil, told: true) == false && Shell.parkedWord(P.showing, told: true) == false
          && Shell.parkedWord(P.out, told: true) == false && Shell.parkedWord(nil, told: nil) == nil && Shell.parkedWord(P.returning, told: false) == nil)
}
