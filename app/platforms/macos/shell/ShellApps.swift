// The shell's side of installed apps (AppCatalog.swift; docs/PROTOCOL.md "Installed apps"): the catalog is read while
// the shell runs, and Margin's windows get the list in their hello (`apps`) and then as `{ type: 'apps', apps }`
// whenever it changed. Before the first scan every hello says `apps: null`: the palette has no app rows yet.
// An app picked in the palette goes to `openApp` (the session's: ShellHostedGlue.swift).

import Foundation

extension Shell {
    func appsStart() {
        guard appCatalog == nil else { return }
        let catalog = AppCatalogWatcher(options: options.appCatalog)
        catalog.onChange = { [weak self] json in
            self?.appsJSON = json
            self?.marginWindows?.pushApps()
        }
        appCatalog = catalog
        catalog.start()
    }

    func appsStop() {
        appCatalog?.stop()
        appCatalog = nil
        appsJSON = nil
    }
}
