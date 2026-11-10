// The shell's side of user themes (docs/phase6-themes.md §3, ThemeStore.swift).
//
// What the overlays ask (`perform`):
//   theme.import            the file picker (NSOpenPanel: a folder or a .margintheme file),
//                           then what was chosen, read within caps, to that overlay only
//                           (`themeFile`). Nothing goes to the extension.
//   theme.save { value }    a theme the overlay checked and the person chose to use: stored,
//                           the index to every overlay (`themes`) and every linked copy
//                           (`userThemes`), and the asking profile's settings.theme set to it.
//   theme.remove { id }     gone from the store; every linked copy whose settings.theme named
//                           it set back to Arcadia; overlays drawing it draw the copy's again.
//
// Which package an overlay draws: the stored one when its profile's settings.theme is in the
// index, otherwise the copy's own (a copy sends Arcadia for an id it doesn't ship). The log
// says what happened and byte counts, never names, paths or content. In a test (`harness`)
// the picker never shows: `pick` answers for it.

import AppKit

final class UserThemes {
    let store: ThemeStore
    var sent: [WindowKey: String] = [:] // the theme message each overlay was given last
    // The harness's stand-in for the picker: what the person "chose" (nil: cancelled).
    var pick: (() -> URL?)?
    private(set) var picking = false

    init(harness: Bool) {
        store = ThemeStore(root: harness ? FileManager.default.temporaryDirectory.appendingPathComponent("margin-themes-\(UUID().uuidString)", isDirectory: true) : ThemeStore.appRoot)
    }

    func choose(then: @escaping (URL?) -> Void) {
        guard !picking else { return }
        if let pick { return then(pick()) }
        picking = true
        let panel = NSOpenPanel()
        panel.title = "Import Theme"
        panel.message = "Choose a theme’s folder or a .margintheme file."
        panel.prompt = "Import"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = false
        panel.treatsFilePackagesAsDirectories = false
        panel.allowedContentTypes = [] // any file: the extension is checked when it's read
        // Over a full-screen browser: the panel joins the active Space, above it.
        panel.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
        NSApp.activate()
        panel.begin { [weak self] answer in
            self?.picking = false
            then(answer == .OK ? panel.url : nil)
        }
    }
}

extension Shell {
    // The overlays' theme asks.
    func performTheme(from overlay: OverlayController, _ name: String, _ arg: Any?) {
        let a = arg as? JSONObject ?? [:]
        switch name {
        case "theme.import":
            userThemes.choose { [weak overlay] url in
                guard let overlay, let url else { return Diagnostics.note("themes: the picker closed with nothing chosen") }
                if url.pathExtension.lowercased() != "margintheme", (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory != true {
                    overlay.push(raw: jsonString(["type": "themeFile", "error": "That isn’t a theme’s folder or a .margintheme file."] as JSONObject) ?? "{}")
                    return Diagnostics.note("themes: something other than a folder or a .margintheme file chosen")
                }
                let read = ThemeFileReader.read(url)
                Diagnostics.note("themes: a \(read.kind) read for \(overlay.key) (\(read.bytes) bytes)")
                overlay.push(raw: jsonString(read.message) ?? "{}")
            }
        case "theme.save":
            guard let value = a["value"] as? JSONObject else { return }
            do {
                let entry = try userThemes.store.save(value)
                let id = entry["id"] as? String ?? ""
                Diagnostics.note("themes: one stored for \(overlay.key) (\(entry["bytes"] ?? 0) bytes)")
                themesListChanged()
                guard let link = links[overlay.key.link] else { return }
                Task { _ = try? await link.connection.request(type: "updateSettings", payload: ["patch": ["theme": id]], windowId: overlay.key.windowId) }
            } catch {
                Diagnostics.warn("themes: one refused for storing: \(error)")
                overlay.push(raw: jsonString(["type": "themeSaved", "ok": false, "error": "Margin couldn’t keep that theme (\(error))."] as JSONObject) ?? "{}")
            }
        case "theme.remove":
            guard let id = a["id"] as? String, ThemeStore.idOK(id) else { return }
            do {
                guard try userThemes.store.remove(id) else { return }
                Diagnostics.note("themes: one removed")
            } catch { return Diagnostics.warn("themes: one couldn't be removed: \(error)") }
            // Every linked copy that used it: back to Arcadia.
            for entry in links.values where (entry.mirror.value("settings") as? JSONObject)?["theme"] as? String == id {
                Task { _ = try? await entry.connection.request(type: "updateSettings", payload: ["patch": ["theme": "arcadia"]], windowId: nil) }
            }
            themesListChanged()
        default:
            Diagnostics.note("\(overlay.key): \(name) isn't the app's yet")
        }
    }

    // The index as the overlays and copies get it.
    var themesListJSON: String { jsonString(userThemes.store.list()) ?? "[]" }

    // The index changed: every overlay told, every linked copy told, every overlay's package checked.
    func themesListChanged() {
        let list = themesListJSON
        for overlay in overlays.values { overlay.push(raw: #"{"type":"themes","list":"# + list + "}") }
        for entry in links.values { themesTellCopy(entry) }
        for entry in links.values { themesCheck(entry) }
    }

    // A copy linked (its first snapshot): the index, so its updateSettings takes an imported theme's id.
    func themesTellCopy(_ entry: Link) {
        let list = userThemes.store.list()
        Task { _ = try? await entry.connection.request(type: "userThemes", payload: ["list": list], windowId: nil) }
    }

    // The package each of this copy's overlays draws: the stored one for an imported
    // settings.theme, else the copy's. Pushed where it changed.
    func themesCheck(_ entry: Link) {
        for overlay in overlays.values where overlay.key.link == entry.connection.key {
            guard let json = overlayTheme(for: entry), userThemes.sent[overlay.key] != json else { continue }
            userThemes.sent[overlay.key] = json
            overlay.push(raw: #"{"type":"theme","theme":"# + json + "}")
        }
        userThemes.sent = userThemes.sent.filter { overlays[$0.key] != nil }
    }

    // For an overlay's hello (and themesCheck): the package it draws, as JSON.
    func overlayTheme(for entry: Link, overlay: OverlayController? = nil) -> String? {
        let chosen = (entry.mirror.value("settings") as? JSONObject)?["theme"] as? String
        let json = chosen.flatMap { userThemes.store.message($0) } ?? entry.theme
        if let overlay, let json { userThemes.sent[overlay.key] = json }
        return json
    }
}
