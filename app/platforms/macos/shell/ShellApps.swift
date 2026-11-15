// The shell's side of installed apps (AppCatalog.swift; docs/PROTOCOL.md "Installed apps"): only with hosting on
// (`MarginHosted`, Options.hosted). The catalog is read while the shell runs, and every overlay gets the list in its
// hello (`apps`) and then as `{ type: 'apps', apps }` whenever it changed. Off, nothing is read and every hello says
// `apps: null`: the palette has no app rows.
//
// What the overlays ask of the app here (`perform`): `app.open { bundleId }`, an app picked in the palette, handed to
// `openApp` (the host sets it: docs/MARGIN-APP.md phase 3); with none set yet, only logged (the bundle id only).

import Foundation

extension Shell {
    func appsStart() {
        guard options.hosted, appCatalog == nil else { return }
        let catalog = AppCatalogWatcher(options: options.appCatalog)
        catalog.onChange = { [weak self] json in
            self?.appsJSON = json
            self?.pushApps()
        }
        appCatalog = catalog
        catalog.start()
    }

    func appsStop() {
        appCatalog?.stop()
        appCatalog = nil
        appsJSON = nil
        appsSent = [:]
    }

    // Each overlay told, if what it has isn't the newest.
    func pushApps() {
        guard options.hosted else { return }
        let json = appsJSON ?? "null"
        for (key, overlay) in overlays where appsSent[key] != json {
            appsSent[key] = json
            overlay.push(raw: #"{"type":"apps","apps":"# + json + "}")
        }
        appsSent = appsSent.filter { overlays[$0.key] != nil }
    }

    // For an overlay's hello: the list now (null with hosting off, or before the first scan).
    func appsJSON(for overlay: OverlayController) -> String {
        guard options.hosted else { return "null" }
        let json = appsJSON ?? "null"
        appsSent[overlay.key] = json
        return json
    }

    /// `app.open { bundleId }`: an app picked in the palette, for the host to open in the page area. A bundle id
    /// that isn't one, or one with hosting off, does nothing.
    func performApp(_ name: String, _ arg: Any?) {
        guard name == "app.open", options.hosted else { return }
        guard let id = (arg as? JSONObject)?["bundleId"] as? String, AppCatalog.isBundleId(id) else {
            Diagnostics.note("app.open: not a bundle id")
            return
        }
        guard let openApp else { return Diagnostics.note("app.open \(id): no host yet") }
        openApp(id)
    }
}
