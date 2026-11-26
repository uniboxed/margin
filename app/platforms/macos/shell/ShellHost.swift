// The host in the shell (HostEngine.swift): made at launch, from what the private calls' checks passed. A crashed
// run's marker (hosted.json) is cleaned up at launch: its apps out of full screen and quit.
//
// What the shell still wires once Margin's own window drives it (docs/MARGIN-APP.md phase 2): `open` with the
// window's page area, Margin's window number and its full-screen Space; `requestSafariWindow` to the extension's
// `newWindow` request for a profile; `safariFullScreen` to its `setWindowState`; `closeSafariWindow` to its
// `closeWindow`; `poll` on the shell's poll.

import AppKit

extension Shell {
    // Application Support/Margin (beside the lasting data's folder), or a harness's own folder.
    var hostMarkerURL: URL {
        let root = options.harness || options.dataRoot != nil ? data.root : DataSync.appRoot.deletingLastPathComponent()
        return root.appendingPathComponent(HostMarker.fileName)
    }

    func startHost(resolver: PrivateResolver, sky: SkyLight, spaces: SkyLightSpaces) {
        let hasMarker = FileManager.default.fileExists(atPath: hostMarkerURL.path)
        let calls = HostCalls.check(resolver: resolver, base: privateCalls)
        guard calls.host else {
            return Diagnostics.note("host: its calls didn't pass their check (\(calls.reasons["host"] ?? "not checked")): nothing is hosted")
        }
        // (`defaults write com.unibox.margin MarginPanesActive -bool NO`: a split's other panes never kept active, only the
        // focused one draws active, as before; a crashed run's kept apps are still let go.)
        let keepsActive = UserDefaults.standard.object(forKey: "MarginPanesActive") as? Bool != false
        if calls.panesActive, !keepsActive { Diagnostics.note("panes active: off (MarginPanesActive is NO): only a split's focused pane draws active") }
        let system = RealHostSystem(calls: HostPrivate(resolver: resolver, availability: calls), sky: sky, spaces: spaces, slots: SkyLightSlots(sky: sky),
                                    freezer: freezer, sidebarMenu: { [weak self] in self?.sidebarMenu }, keepsActive: keepsActive)
        let engine = HostEngine(system: system, marker: hostMarkerURL, observation: RealHostObservation())
        engine.options.safariBundle = UserDefaults.standard.string(forKey: "MarginHostedSafari") ?? safariIdentifier
        // (`defaults write com.unibox.margin MarginTiles -bool NO`: no tiles, every hosted window a plain member of Margin's
        // Space, sized as it's shown: the screen suite's `--members` measures that route beside the tiles'.)
        if UserDefaults.standard.object(forKey: "MarginTiles") as? Bool == false {
            engine.options.tiles = false
            Diagnostics.note("host: tiles off (MarginTiles is NO): hosted windows are plain members of Margin's Space")
        }
        if hasMarker { Task { await engine.recover() } }
        engine.onEvent = { event in Diagnostics.note("host: event \(event)") }
        host = engine
        if let session = hosted { wire(engine, to: session); prepareBrowserOnce() } // (Margin's window was opened first)
        Diagnostics.note("host: on: apps are hosted in Margin's page area")
    }

    // Quitting: every hosted app out of full screen and quit, then the rest of the stop. Never longer than
    // `hostQuitAtMost`: past it Margin quits anyway, what isn't given back yet left in the marker for the next launch's
    // recovery (2026-11-26: the quit hung until Margin was force quit, which leaves the same and says nothing).
    static let hostQuitAtMost = 20.0
    func stopHost(_ then: @escaping () -> Void) {
        guard let host else { return then() }
        hostQuitting = true
        hosted?.marginQuits() // (the core's waits for its copies bounded by quitWait from now: docs/LINK-RESILIENCE.md)
        var over = false
        let finish = {
            guard !over else { return }
            over = true
            then()
        }
        Task {
            await host.quitAll()
            finish()
        }
        // (Not a Timer: quitting, AppKit runs the run loop in its modal panel mode, where one never fires.)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.hostQuitAtMost) {
            MainActor.assumeIsolated {
                guard !over else { return }
                Diagnostics.warn("host: quit: not over within \(Int(Self.hostQuitAtMost)) s (\(host.underWayLine ?? "no operation under way")): Margin quits anyway, what's left in the marker for the next launch")
                finish()
            }
        }
    }
}
