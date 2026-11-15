// The host in the shell (HostEngine.swift): made at launch, from what the private calls' checks passed, only with
// `MarginHosted` set. A crashed run's marker (hosted.json) is cleaned up at launch whether or not the setting is
// on now (it may have been turned off since): its apps out of full screen and quit.
//
// What the shell still wires once Margin's own window drives it (docs/MARGIN-APP.md phase 2): `open` with the
// window's page area, Margin's window number and its full-screen Space; `requestSafariWindow` to the extension's
// `newWindow` / `openSpaceWindow` request for a profile; `closeSafariWindow` to its `closeWindow`; `poll` on the
// shell's poll.

import AppKit

extension Shell {
    // Beside the parked windows' marker: Application Support/Margin, or a harness's own folder.
    var hostMarkerURL: URL { parkingMarkerURL.deletingLastPathComponent().appendingPathComponent(HostMarker.fileName) }

    func startHost(resolver: PrivateResolver, sky: SkyLight, spaces: SkyLightSpaces) {
        let hasMarker = FileManager.default.fileExists(atPath: hostMarkerURL.path)
        guard options.hosted || hasMarker else { return }
        let calls = HostCalls.check(resolver: resolver, base: privateCalls)
        guard calls.host else {
            if options.hosted { Diagnostics.note("host: asked for (MarginHosted), but its calls didn't pass their check (\(calls.reasons["host"] ?? "not checked")): nothing is hosted") }
            return
        }
        let system = RealHostSystem(calls: HostPrivate(resolver: resolver, availability: calls), sky: sky, spaces: spaces, slots: SkyLightSlots(sky: sky),
                                    freezer: freezer, sidebarMenu: { [weak self] in self?.sidebarMenu },
                                    closedSidebarTitle: { [weak self] pid in self?.sidebarClosedTitle[pid] })
        let engine = HostEngine(system: system, marker: hostMarkerURL)
        engine.options.safariBundle = UserDefaults.standard.string(forKey: "MarginHostedSafari") ?? safariIdentifier
        if hasMarker { Task { await engine.recover() } }
        guard options.hosted else { return }
        engine.onEvent = { event in Diagnostics.note("host: event \(event)") }
        host = engine
        if let session = hosted { wire(engine, to: session) } // (Margin's window was opened first)
        Diagnostics.note("host: on (MarginHosted): apps are hosted in Margin's page area")
    }

    // Quitting: every hosted app out of full screen and quit, then the rest of the stop.
    func stopHost(_ then: @escaping () -> Void) {
        guard let host else { return then() }
        hostQuitting = true
        Task {
            await host.quitAll()
            then()
        }
    }
}
