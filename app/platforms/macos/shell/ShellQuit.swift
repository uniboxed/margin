// Margin's quit, asked first (QuitPrompt.swift; asked 2026-11-17 for Margin as the app, after the prompt it had over a
// browser's window, 2026-11-07).
//
// ⌘Q (or ⌥⌘Q) while Margin's window or an app Margin hosts is in front is Margin's first (the shortcuts' quit guard,
// held by Shell.updateHostedKeys under ShortcutSet.guardsQuit): without it, the key in a hosted Safari quit Safari
// alone and left Margin with an item that had no page. Margin's own prompt comes up instead, centred on Margin's
// window, above whatever is hosted there:
//   Quit (Return, or ⌘Q again): Margin quits as it always does (Options.quit: the app's terminate, which comes back to
//     Shell.stop: every hosted app given back at once, DECISIONS.md "Margin's quit gives every host back at once").
//   Cancel (Escape, a click anywhere else, another app coming to the front): nothing happens; the keys are back where
//     they were (the hosted app never stopped being the active app: the prompt takes the keys without activating Margin).
//   Always quit: quits, and stops asking (`MarginAskBeforeQuit` NO in the app's defaults, the key it always had).
// With asking off the guard isn't held at all: ⌘Q is the front app's own, as in any app Margin doesn't host (Margin's
// own menu item when Margin is in front). To ask again: `defaults delete com.unibox.margin MarginAskBeforeQuit`.
// A quit that isn't the person's key (the Dock's Quit, the menu item clicked, a new build, logging out) never asks.
//
// What the prompt says is numbers and Margin's own words only (QuitSummary): never a title, an address or an app's name.

import AppKit

// What Margin's quit closes, counted: web items with a page (their browser windows are closed, the items stay in their
// spaces), apps Margin started (quit), and apps the person had open themselves that Margin hosts (given back as they
// were, left open).
struct QuitSummary: Equatable {
    var tabs = 0
    var apps = 0
    var kept = 0

    var note: String {
        func count(_ n: Int, _ one: String, _ many: String) -> String { n == 1 ? "1 \(one)" : "\(n) \(many)" }
        var out: String
        switch (tabs > 0, apps > 0) {
        case (true, true):
            out = "Margin will close \(count(tabs, "open tab", "open tabs")) and quit \(count(apps, "app", "apps")) it opened. Your tabs stay in their spaces, but unsaved work may be lost."
        case (true, false):
            out = "Margin will close \(count(tabs, "open tab", "open tabs")). \(tabs == 1 ? "It stays in its space" : "They stay in their spaces"), but unsaved work may be lost."
        case (false, true):
            out = "Margin will quit \(count(apps, "app", "apps")) it opened. Unsaved work may be lost."
        case (false, false):
            out = "Nothing Margin opened is running."
        }
        if kept > 0 { out += " \(count(kept, "app you opened yourself stays", "apps you opened yourself stay")) open." }
        return out
    }
}

extension Shell {
    static let askBeforeQuitKey = "MarginAskBeforeQuit"

    // What's hosted now, counted for the prompt.
    func quitSummary() -> QuitSummary {
        var summary = QuitSummary()
        summary.tabs = hosted?.open.values.filter { $0.profile != nil }.count ?? 0
        for h in host?.hosts.values.map({ $0 }) ?? [] {
            guard case .app = h.target else { continue }
            if h.personApp { summary.kept += 1 } else { summary.apps += 1 }
        }
        return summary
    }

    // ⌘Q or ⌥⌘Q, taken by the quit guard. With the prompt up: Quit (the key again). Else the prompt, over the Margin
    // window that hosts (else the one in front); with none to centre it on, or asking turned off since the guard was
    // last set, the quit itself.
    func quitKey() {
        if let prompt = quitPrompt { return prompt.choose(.quit) }
        guard !hostQuitting, quitsAsked == 0 else { return }
        let windows = marginWindows
        let over = hosted?.hostingWindow.flatMap { id in windows?.controllers.first { $0.id == id } } ?? windows?.front
        guard options.asksBeforeQuit(), let over else { return quitNow("asked by its key, nothing to ask over") }
        let summary = quitSummary()
        let prompt = QuitPrompt(note: summary.note, harness: options.harness)
        quitPrompt = prompt
        // (The window of Margin's that had the keys, if Margin is the active app: it has them again after a Cancel.)
        let hadKeys = options.harness ? nil : NSApp.keyWindow
        Diagnostics.note("⌘Q with Margin or an app it hosts in front: Margin's quit prompt (\(summary.tabs) tab(s), \(summary.apps) app(s) Margin started, \(summary.kept) of the person's)")
        prompt.onChoice = { [weak self] choice in
            guard let self else { return }
            self.quitPrompt = nil
            Diagnostics.note("quit prompt: \(choice == .cancel ? "cancelled" : choice == .always ? "always quit" : "quit")")
            switch choice {
            case .cancel:
                if !self.options.harness, NSApp.isActive, let hadKeys, hadKeys.isVisible { hadKeys.makeKey() }
                // (Margin not the active app: the prompt had the keys without it, so they go back to the app shown.)
                if !self.options.harness, !NSApp.isActive { self.keysBackToShown("the quit prompt cancelled") }
            case .always:
                self.options.setAskBeforeQuit(false)
                self.quitNow("always quit")
            case .quit:
                self.quitNow("quit")
            }
        }
        prompt.show(over: over.contentFrame)
    }

    // Margin's quit, asked of the app: the guard let go first, for good (a ⌘Q while it quits is the front app's).
    func quitNow(_ why: String) {
        shortcuts.setQuitGuard(active: false)
        quitsAsked += 1
        Diagnostics.note("Margin quits (\(why))")
        options.quit()
    }

    // The prompt taken down with no choice made (Margin quits some other way while it's up).
    func dismissQuitPrompt() {
        guard let prompt = quitPrompt else { return }
        quitPrompt = nil
        prompt.onChoice = nil
        prompt.dismiss()
    }
}
