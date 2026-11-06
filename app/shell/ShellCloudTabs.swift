// The shell's side of iCloud Tabs (CloudTabs.swift): the reads run while a
// Safari copy is linked with "Show iCloud Tabs" on (settings.showCloudTabs,
// on unless turned off), and every Safari overlay gets what was read, in its
// hello (`cloudTabs`) and then as `{ type: 'cloudTabs', cloudTabs }` whenever
// it changed (app/PROTOCOL.md "iCloud Tabs"). The data is the app's: it never
// goes through the extension. Chrome and Edge overlays get none (Phase 5:
// `sessions.getDevices()`).
//
// What the overlays ask of the app here (`perform`): `cloud.access` (System
// Settings at Full Disk Access, as the set-up window's step opens it) and
// `copyText` (an address to the pasteboard: the folder's Copy Link). In a
// test (`harness`) neither reaches the system: they're only noted.

import AppKit

extension Shell {
    // Is any linked Safari copy showing iCloud Tabs? (Its settings say so; a copy with no state yet counts.)
    private var cloudTabsWanted: Bool {
        guard options.cloudTabsData != nil else { return false }
        return links.values.contains { entry in
            guard entry.connection.hello.browser == "safari" else { return false }
            return (entry.mirror.value("settings") as? JSONObject)?["showCloudTabs"] as? Bool != false
        }
    }

    // The reads started or stopped as the links and their settings say.
    func cloudTabsCheck() {
        let want = cloudTabsWanted
        if want, cloudWatcher == nil, let folder = options.cloudTabsData {
            let watcher = CloudTabsWatcher(folder: folder, options: options.cloudWatch)
            watcher.onChange = { [weak self] outcome in self?.cloudTabsRead(outcome) }
            cloudWatcher = watcher
            watcher.start()
        } else if !want, let watcher = cloudWatcher {
            watcher.stop()
            cloudWatcher = nil
            cloudJSON = nil
            pushCloudTabs()
        }
    }

    private func cloudTabsRead(_ outcome: CloudTabs.Outcome) {
        guard let object = CloudTabs.json(outcome), let json = jsonString(object) else { return } // busy: what was read stands
        guard json != cloudJSON else { return }
        cloudJSON = json
        pushCloudTabs()
    }

    // Each Safari overlay told, if what it has isn't the newest.
    func pushCloudTabs() {
        for (key, overlay) in overlays {
            guard links[key.link]?.connection.hello.browser == "safari" else { continue }
            let json = cloudJSON ?? "null"
            if cloudSent[key] == json { continue }
            cloudSent[key] = json
            overlay.push(raw: #"{"type":"cloudTabs","cloudTabs":"# + json + "}")
        }
        cloudSent = cloudSent.filter { overlays[$0.key] != nil }
    }

    // For an overlay's hello: what it shows now (Safari's only).
    func cloudTabsJSON(for overlay: OverlayController) -> String {
        guard links[overlay.key.link]?.connection.hello.browser == "safari" else { return "null" }
        let json = cloudJSON ?? "null"
        cloudSent[overlay.key] = json
        return json
    }

    // The overlays' asks that only the app can do.
    func performCloud(_ name: String, _ arg: Any?) {
        switch name {
        case "cloud.access":
            Diagnostics.note("icloud tabs: Full Disk Access asked for from the sidebar")
            if options.harness { opened.append(SafariFiles.fullDiskAccessURL); return }
            NSWorkspace.shared.open(SafariFiles.fullDiskAccessURL)
        case "copyText":
            guard let text = (arg as? JSONObject)?["text"] as? String, (1...8192).contains(text.count) else { return }
            if options.harness { copied.append(text); return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        default:
            break
        }
    }
}
