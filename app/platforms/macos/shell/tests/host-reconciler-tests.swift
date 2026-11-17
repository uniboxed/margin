// The hosting core's reconciler (HostReconciler.swift), part of tests.swift's run: `step(situation, desired)` as a
// table, one row per case of the baseline real-screen run (tools/screen-tests/build/logs/20261117-16*) and of his
// sessions (DECISIONS.md), each with the corrections it must give, most urgent first.
import AppKit
import Foundation

func hostReconcilerTests() {
    let placement = HostPlacement(page: CGRect(x: 350, y: 41, width: 1154, height: 933), area: CGRect(x: 0, y: 33, width: 1512, height: 949))
    let shown = HostDesired.shown(placement)
    // A host shown as it should be: a member of Margin's Space, on screen.
    func member(_ edit: (inout HostSituation) -> Void = { _ in }) -> HostSituation {
        var s = HostSituation()
        s.phase = .shown
        s.member = true
        s.window = 71918
        s.place = .margin
        s.onScreen = true
        s.fullScreen = true
        s.canFullScreen = true
        s.launchedByMargin = true
        edit(&s)
        return s
    }
    func windowed(_ edit: (inout HostSituation) -> Void = { _ in }) -> HostSituation {
        member { s in s.member = false; s.mode = .window; s.fullScreen = false; s.canFullScreen = false; edit(&s) }
    }
    func firstOpen(_ edit: (inout HostSituation) -> Void) -> HostSituation {
        var s = HostSituation()
        s.phase = .preparing
        s.window = 50
        s.launchedByMargin = true
        edit(&s)
        return s
    }
    func leftover(_ n: Int, _ place: WindowPlace, onScreen: Bool? = nil, closable: Bool = false) -> HostOther { HostOther(number: n, place: place, onScreen: onScreen, closable: closable) }

    let rows: [(String, HostSituation, HostDesired, [HostCorrection])] = [
        // ---- the app ----
        ("not running: launched", { var s = HostSituation(); s.running = false; return s }(), shown, [.launch]),
        ("not running, launched once already: the fallback", { var s = HostSituation(); s.running = false; s.tries = ["launch": 1]; return s }(), shown, [.fallback("it doesn't start")]),
        ("running with no window (Maps 15:19, the person's): reopened", { var s = HostSituation(); s.launchedByMargin = false; return s }(), shown, [.reopen]),
        ("running with no window, hidden: unhidden, then reopened", { var s = HostSituation(); s.hidden = true; return s }(), shown, [.unhide, .reopen]),
        ("no window, reopened twice: the fallback", { var s = HostSituation(); s.tries = ["reopen": 2]; return s }(), shown, [.fallback("no window to host")]),
        ("its window gone, its app running (windowless close:8): reopened", member { $0.windowGone = true }, shown, [.reopen]),
        ("its window gone, a new one of its app's main (reopened, or its own): adopted", member { $0.windowGone = true; $0.replacement = 72046 }, shown, [.adopt(72046)]),
        // ---- replaced by its app (Messages 15:20; replacesWindow every:4) ----
        ("replaced: the new window at its frame is its app's main one: adopted, before anything else (then looked at again)", member { $0.replacement = 72210; $0.leftovers = [leftover(72197, .margin)] }, shown, [.adopt(72210)]),
        ("parked and replaced: adopted there too (and parked with it)", member { $0.phase = .parked; $0.place = .parked; $0.replacement = 72210 }, .parked, [.adopt(72210)]),
        ("parked, its window gone: nothing now (its next show reopens it, behind the loader)", member { $0.phase = .parked; $0.place = .parked; $0.windowGone = true }, .parked, []),
        // ---- the first placement, from where it is ----
        ("first open, restored in full screen in a Space of its own (Maps 07:52): placed from there", firstOpen { $0.ownFullScreenSpace = 8054; $0.fullScreen = nil; $0.place = .fullScreen }, shown, [.placeFromOwnSpace(8054)]),
        ("first open, full screen with no Space of its own (moved into Margin's): out of it, then asked", firstOpen { $0.fullScreen = true; $0.place = .margin }, shown, [.outThenAsk]),
        ("first open, a normal window that can go full screen: asked where macOS takes it", firstOpen { $0.fullScreen = false; $0.canFullScreen = true; $0.place = .desktop }, shown, [.askFullScreen]),
        ("first open, can't go full screen (Calculator, the Phone): window mode", firstOpen { $0.fullScreen = false; $0.canFullScreen = false; $0.place = .margin }, shown, [.frameWindow]),
        ("first open, in window mode since its full screen failed: window mode", firstOpen { $0.mode = .window; $0.canFullScreen = true }, shown, [.frameWindow]),
        ("macOS's transition still running: wait", member { $0.busy = true; $0.place = .several }, shown, [.wait("macOS's transition is still running")]),
        // ---- shown: where it should be ----
        ("shown as it should be: settled", member(), shown, []),
        ("shown, in no Space (a Space destroyed under it): put back", member { $0.place = .nowhere }, shown, [.putBack]),
        ("shown, on a Desktop: put back", member { $0.place = .desktop }, shown, [.putBack]),
        ("shown, out of Margin's Space three times in 30 s: no more put back", member { $0.place = .nowhere; $0.tries = ["put back": 3] }, shown, []),
        ("shown, Margin's Space not current (a swipe): nothing about where it is", member { $0.place = .desktop; $0.marginCurrent = false }, shown, []),
        ("window mode, off screen one read: nothing yet (one read can miss mid-transition)", windowed { $0.onScreen = false; $0.offScreenReads = 1 }, shown, []),
        ("window mode, off screen two reads (the Phone, Calculator, noFullScreen): brought forward, activated", windowed { $0.onScreen = false; $0.offScreenReads = 2 }, shown, [.bringForward(.activate)]),
        ("…activated already: a Dock-icon click", windowed { $0.onScreen = false; $0.offScreenReads = 4; $0.tries = ["bring forward (activate)": 1] }, shown, [.bringForward(.reopen)]),
        ("…both rungs tried: the fallback", windowed { $0.onScreen = false; $0.offScreenReads = 6; $0.tries = ["bring forward (activate)": 1, "bring forward (reopen)": 1] }, shown, [.fallback("its window stays off screen in Margin's Space")]),
        // ---- leftovers and strips ----
        ("restored windows on screen in Margin's Space (restore-normal), its app keeps its windows at quit: parked", member { $0.leftovers = [leftover(71919, .margin, onScreen: true)] }, shown, [.parkLeftover(71919)]),
        ("…its app discards its windows at quit, Accessibility reads it: closed by its own close button", member { $0.leftovers = [leftover(71919, .margin, onScreen: true, closable: true)] }, shown, [.closeLeftover(71919)]),
        ("Safari's restored windows (15:19): one on the Desktop, two in full-screen Spaces of their own: all parked", member { $0.leftovers = [leftover(72450, .fullScreen), leftover(72457, .fullScreen), leftover(72468, .desktop, onScreen: true)] }, shown,
         [.parkLeftover(72450), .parkLeftover(72457), .parkLeftover(72468)]),
        ("a leftover parked already: nothing", member { $0.leftovers = [leftover(71919, .parked)] }, shown, []),
        ("a leftover tried twice: left as it is (said by the engine's log)", member { $0.leftovers = [leftover(71919, .margin)]; $0.tries = ["leftover 71919": 2] }, shown, []),
        ("a strip on screen in Margin's Space (strip linger, Mail 14:06): parked", member { $0.strips = [leftover(72279, .margin, onScreen: true)] }, shown, [.parkStrip(72279)]),
        ("a strip parked: nothing", member { $0.strips = [leftover(72279, .parked, onScreen: false)] }, shown, []),
        ("put back before its leftovers", member { $0.place = .nowhere; $0.leftovers = [leftover(7, .margin)] }, shown, [.putBack, .parkLeftover(7)]),
        // ---- parked ----
        ("parked as it should be: nothing", member { $0.phase = .parked; $0.place = .parked }, .parked, []),
        ("parked, found on a Desktop at one read: nothing yet", member { $0.phase = .parked; $0.place = .desktop; $0.strayReads = 1 }, .parked, []),
        ("parked, found on a Desktop two reads in a row: parked again", member { $0.phase = .parked; $0.place = .desktop; $0.strayReads = 2 }, .parked, [.parkAgain]),
        ("parked, its leftovers and strips in user Spaces: parked too", member { $0.phase = .parked; $0.place = .parked; $0.leftovers = [leftover(5, .margin)]; $0.strips = [leftover(6, .fullScreen)] }, .parked, [.parkLeftover(5), .parkStrip(6)]),
        ("parked, its process gone: nothing (the engine's quit handling)", member { $0.phase = .parked; $0.running = false; $0.place = .desktop; $0.strayReads = 3 }, .parked, []),
        // ---- given back ----
        ("given back: the engine's own steps", member { $0.leftovers = [leftover(5, .margin)] }, .givenBack, []),
    ]
    var failed = 0
    for (name, s, d, want) in rows {
        let got = HostReconciler.step(s, d)
        if got != want { failed += 1 }
        check("reconciler: \(name)", got == want, "got \(got.map(\.text)) want \(want.map(\.text))")
    }
    // The budgets: every correction has one, and a correction the engine logs says its name.
    check("reconciler: every correction has a budget of at least one try", [HostCorrection.launch, .reopen, .unhide, .putBack, .bringForward(.activate), .adopt(1), .closeLeftover(1), .parkLeftover(1), .parkStrip(1), .parkAgain]
          .allSatisfy { HostReconciler.budget(of: $0) >= 1 })
    check("reconciler: a leftover's close and park share one budget (a close that fails is a park)", HostCorrection.closeLeftover(5).key == HostCorrection.parkLeftover(5).key)
    // The log line's observed part: numbers and kinds only.
    let text = member { $0.leftovers = [leftover(71919, .margin, onScreen: true)]; $0.replacement = 72210 }.text
    check("reconciler: what's observed, said in one line (numbers and kinds)", text == "shown, a member window 71918 Margin's Space, on screen; its app's main window now 72210; leftover 71919 (Margin's Space, on screen)", text)
    check("reconciler: …a window-mode window off screen", windowed { $0.onScreen = false; $0.offScreenReads = 3 }.text == "shown, window mode window 71918 Margin's Space, off screen (3 reads)", windowed { $0.onScreen = false; $0.offScreenReads = 3 }.text)
    // Pure: the same situation, the same corrections, always.
    let s = member { $0.place = .nowhere; $0.leftovers = [leftover(7, .margin)] }
    check("reconciler: pure (the same situation gives the same corrections)", HostReconciler.step(s, shown) == HostReconciler.step(s, shown) && failed == 0)
}
