// The shell's side of user themes (docs/phase6-themes.md §3, ThemeStore.swift).
//
// What the UI asks (`performTheme`; not wired to Margin's own window yet):
//   theme.import            the file picker (NSOpenPanel: a folder or a .margintheme file),
//                           then what was chosen, read within caps, to the asking page only
//                           (`themeFile`). Nothing goes to the extension.
//   theme.save { value }    a theme the page checked and the person chose to use: stored,
//                           the index to every linked copy (`userThemes`), and the asking
//                           profile's settings.theme set to it.
//   theme.remove { id }     gone from the store; every linked copy whose settings.theme named
//                           it set back to Arcadia.
//
// Which package Margin's window draws: ShellHosted.swift hostedTheme. The log says what happened
// and byte counts, never names, paths or content. In a test (`harness`) the picker never shows:
// `pick` answers for it.

import AppKit

final class UserThemes {
    let store: ThemeStore
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
        // Over Margin's full-screen window: the panel joins the active Space, above it.
        panel.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
        NSApp.activate()
        panel.begin { [weak self] answer in
            self?.picking = false
            then(answer == .OK ? panel.url : nil)
        }
    }
}

extension Shell {
    // A page's theme asks: `reply` takes what goes back to that page, `link` is the profile whose settings change.
    func performTheme(_ name: String, _ arg: Any?, link key: String?, reply: @escaping (String) -> Void) {
        let a = arg as? JSONObject ?? [:]
        switch name {
        case "theme.import":
            userThemes.choose { url in
                guard let url else { return Diagnostics.note("themes: the picker closed with nothing chosen") }
                if url.pathExtension.lowercased() != "margintheme", (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory != true {
                    reply(jsonString(["type": "themeFile", "error": "That isn’t a theme’s folder or a .margintheme file."] as JSONObject) ?? "{}")
                    return Diagnostics.note("themes: something other than a folder or a .margintheme file chosen")
                }
                let read = ThemeFileReader.read(url)
                Diagnostics.note("themes: a \(read.kind) read (\(read.bytes) bytes)")
                reply(jsonString(read.message) ?? "{}")
            }
        case "theme.save":
            guard let value = a["value"] as? JSONObject else { return }
            do {
                let entry = try userThemes.store.save(value)
                let id = entry["id"] as? String ?? ""
                Diagnostics.note("themes: one stored (\(entry["bytes"] ?? 0) bytes)")
                themesListChanged()
                guard let key, let link = links[key] else { return }
                Task { _ = try? await link.connection.request(type: "updateSettings", payload: ["patch": ["theme": id]], windowId: nil) }
            } catch {
                Diagnostics.warn("themes: one refused for storing: \(error)")
                reply(jsonString(["type": "themeSaved", "ok": false, "error": "Margin couldn’t keep that theme (\(error))."] as JSONObject) ?? "{}")
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
            Diagnostics.note("\(name) isn't the app's yet")
        }
    }

    // The index as Margin's windows and the copies get it.
    var themesListJSON: String { jsonString(userThemes.store.list()) ?? "[]" }

    // The index changed: every linked copy told.
    func themesListChanged() {
        for entry in links.values { themesTellCopy(entry) }
    }

    // A copy linked (its first snapshot): the index, so its updateSettings takes an imported theme's id.
    func themesTellCopy(_ entry: Link) {
        let list = userThemes.store.list()
        Task { _ = try? await entry.connection.request(type: "userThemes", payload: ["list": list], windowId: nil) }
    }
}
