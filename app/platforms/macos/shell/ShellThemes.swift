// The shell's side of user themes (docs/phase6-themes.md §3, docs/THEME-STORE.md §1; ThemeStore.swift over margin-core's
// data::themes).
//
// What a Margin window's page asks (the core's `theme` route, core/session/ui.rs: `themeAsked`):
//   theme.import            the file picker (NSOpenPanel: a folder or a .margintheme file),
//                           then what was chosen, read within caps, to the asking page only
//                           (`themeFile`).
//   theme.link              Load Unpacked: the folder picker, then the folder read as for an import, to
//                           the asking page (`themeFile` with `linking`). The folder is remembered
//                           here (`pendingLink`) until the page's Use Theme: the path never comes from a page.
//   theme.save { value }    a theme the page checked and the person chose to use: stored, the index
//                           to every window and linked copy, and Margin's own settings set to it.
//     { linked: true }      …the folder just picked (`pendingLink`) linked to it and followed from now on.
//     { link: id }          …a linked folder's theme read again and checked (`linkedFolderChanged`): stored
//                           again (only for the theme linked under that id), drawn again, nothing chosen.
//     { store: true }       …a theme from the theme store (`theme.store.try` just downloaded it): stored with the
//                           store's version and package (ShellThemeStore.swift), so an update can be offered.
//   theme.unlink { id }     its folder followed no more; the theme stays as it was last stored.
//   theme.store.open        Settings' Themes: the store's list, checked (`themeStore` { state, rows | message }).
//   theme.store.try { id }  a store theme downloaded and checked against the list, then to the page as an import's
//                           file is (`themeFile` with `store`): previewed, and Use Theme installs it.
//   theme.store.report { id, reason }, theme.share { id }: a report; one of the person's own themes uploaded. Each
//                           answer to its Settings line (`themeStoreResult` { key, ok, message?, data? }).
//   theme.remove { id }     gone from the store (and its link); Margin's settings and every linked copy
//                           whose theme it was set back to Arcadia.
//
// A linked folder is followed by FSEvents (`FolderWatch`). On each change it's read again within the import's caps
// and handed to a Margin window's page, which checks it with the same code as every load (ui/theme-import.ts) and
// asks for it to be stored again only when it passes: a theme that fails keeps the last good one drawn, its reasons
// shown in Settings. Which package Margin's window draws: ShellHosted.swift hostedTheme. The log says what happened and
// byte counts, never names, paths or content. In a test (`harness`) the pickers never show: `pick` answers for them.

import AppKit
import CoreServices

final class UserThemes {
    let store: ThemeStore
    // The harness's stand-in for the pickers: what the person "chose" (nil: cancelled).
    var pick: (() -> URL?)?
    private(set) var picking = false
    // The folder Load Unpacked just picked, until the page's Use Theme (or another pick); for a while only.
    var pendingLink: (url: URL, at: Date)?
    static let pendingLinkFor: TimeInterval = 600
    // The linked folders followed, by theme id.
    var watches: [String: FolderWatch] = [:]
    // The theme store's client (ShellThemeStore.swift), and what its Settings were last told.
    let storeClient: ThemeStoreClient
    var storeShown: JSONObject?
    // A store theme downloaded for its preview, until the page's Use Theme installs it (or another download); for a
    // while only. Its version and package are the store's list's, never the page's.
    var pendingInstall: (id: String, version: String, sha256: String, at: Date)?

    init(harness: Bool, themeStore: (base: String, key: String)? = ThemeStoreClient.environmentStore, storeSend: ((StoreRequest) async -> StoreResponse)? = nil) {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("margin-themes-\(UUID().uuidString)", isDirectory: true)
        store = ThemeStore(root: harness ? scratch : ThemeStore.appRoot)
        storeClient = ThemeStoreClient(root: harness ? scratch.appendingPathComponent("theme-store", isDirectory: true) : ThemeStoreClient.appRoot,
                                       over: themeStore, send: storeSend)
    }

    // The store theme downloaded for `id`'s preview, if it's still waiting for the page's Use Theme; taken once.
    func takePendingInstall(_ id: String, now: Date = Date()) -> (version: String, sha256: String)? {
        defer { pendingInstall = nil }
        guard let p = pendingInstall, p.id == id, now.timeIntervalSince(p.at) <= Self.pendingLinkFor else { return nil }
        return (p.version, p.sha256)
    }

    // `folder`: Load Unpacked's picker (folders only); else Import's (a folder or a .margintheme file).
    func choose(folder: Bool = false, then: @escaping (URL?) -> Void) {
        guard !picking else { return }
        if let pick { return then(pick()) }
        picking = true
        let panel = NSOpenPanel()
        panel.title = folder ? "Load Unpacked Theme" : "Import Theme"
        panel.message = folder
            ? "Choose the folder of a theme you’re making. Margin links it, not a copy: each time you save, the theme is drawn again."
            : "Choose a .margintheme file or a theme’s folder. Margin adds a copy: later changes to the original don’t reach it."
        panel.prompt = folder ? "Load" : "Import"
        panel.canChooseFiles = !folder
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

    // The folder picked by Load Unpacked, if it's still waiting for the page's Use Theme; taken once.
    func takePendingLink(now: Date = Date()) -> URL? {
        defer { pendingLink = nil }
        guard let p = pendingLink, now.timeIntervalSince(p.at) <= Self.pendingLinkFor else { return nil }
        return p.url
    }
}

// A folder followed as it's edited (FSEvents: its files, at any depth, a change at most every 0.2 s), `onChange` on the
// main queue. Stopped when it goes.
final class FolderWatch {
    let path: String
    private var stream: FSEventStreamRef?
    private let onChange: () -> Void

    init?(path: String, onChange: @escaping () -> Void) {
        self.path = path
        self.onChange = onChange
        var context = FSEventStreamContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
        context.info = Unmanaged.passUnretained(self).toOpaque()
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            let watch = Unmanaged<FolderWatch>.fromOpaque(info).takeUnretainedValue()
            MainActor.assumeIsolated { watch.onChange() }
        }
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot)
        guard let s = FSEventStreamCreate(nil, callback, &context, [path] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.2, flags) else { return nil }
        FSEventStreamSetDispatchQueue(s, DispatchQueue.main)
        guard FSEventStreamStart(s) else {
            FSEventStreamInvalidate(s)
            FSEventStreamRelease(s)
            return nil
        }
        stream = s
    }

    func stop() {
        guard let s = stream else { return }
        stream = nil
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
    }

    deinit { stop() }
}

extension Shell {
    // A Margin window's page asked (the core's `theme` route): its replies go to that window's page; a theme chosen is
    // set in Margin's own settings, as Settings' Theme choice sets it.
    func themeAsked(_ name: String, _ payload: JSONObject, window: Int?) {
        let controller = window.flatMap { id in marginWindows?.controllers.first { $0.id == id } } ?? marginWindows?.front
        performTheme(name, payload, reply: { [weak controller] json in controller?.push(json) }, chose: { [weak controller] id in
            _ = controller?.ask("updateSettings", ["patch": ["theme": id]])
        })
    }

    // A page's theme asks: `reply` takes what goes back to that page, `chose` sets the theme in Margin's settings.
    func performTheme(_ name: String, _ arg: JSONObject, reply: @escaping (String) -> Void, chose: @escaping (String) -> Void) {
        switch name {
        case "theme.import", "theme.link":
            let linking = name == "theme.link"
            userThemes.choose(folder: linking) { [weak self] url in
                // (The picker needed Margin active; the app shown gets the activation back.)
                self?.keysBackToShown("the theme picker closed")
                guard let self, let url else { return Diagnostics.note("themes: the picker closed with nothing chosen") }
                let read = ThemeFileReader.read(url, chosen: true)
                // (Load Unpacked's answers say so, refusals too: the page reports them on its own line.)
                let said = { (m: JSONObject) -> String in
                    var m = m
                    if linking { m["linking"] = true }
                    return jsonString(m) ?? "{}"
                }
                guard read.isTheme else {
                    reply(said(read.message))
                    return Diagnostics.note("themes: something other than a folder or a .margintheme file chosen")
                }
                if linking {
                    guard read.kind == "folder" else {
                        reply(said(["type": "themeFile", "error": "Choose the theme’s folder to load it unpacked."]))
                        return Diagnostics.note("themes: Load Unpacked given something other than a folder")
                    }
                    if read.message["error"] == nil { userThemes.pendingLink = (url.standardizedFileURL, Date()) }
                }
                let message = read.message
                Diagnostics.note("themes: a \(read.kind) read (\(read.bytes) bytes)\(linking ? " to load unpacked" : "")")
                reply(said(message))
            }
        case "theme.store.open":
            // Settings' Themes: the store's list, checked, each theme with what it is to this install.
            Task { [weak self] in
                guard let self else { return }
                let shown = await userThemes.storeClient.catalog(installed: userThemes.store.list())
                userThemes.storeShown = shown
                reply(jsonString(shown.merging(["type": "themeStore"]) { $1 }) ?? "{}")
            }
        case "theme.store.try":
            // A store theme downloaded, checked against the list, and handed to the page as an import's file is: it's
            // previewed, and Use Theme installs it (`theme.save` with `store`).
            guard let id = arg["id"] as? String, ThemeStore.idOK(id) else { return }
            Task { [weak self] in
                guard let self else { return }
                guard let got = await userThemes.storeClient.download(id) else {
                    return reply(storeResult("storeTry:\(id)", ["ok": false, "message": userThemes.storeClient.lastError ?? ""]))
                }
                userThemes.pendingInstall = (id, got.version, got.sha256, Date())
                let message: JSONObject = ["type": "themeFile", "kind": "zip", "zip": got.zip.base64EncodedString(), "store": ["id": id, "version": got.version]]
                reply(jsonString(message) ?? "{}")
            }
        case "theme.store.report":
            guard let id = arg["id"] as? String, ThemeStore.idOK(id), let reason = arg["reason"] as? String else { return }
            Task { [weak self] in
                guard let self else { return }
                reply(storeResult("storeReport:\(id)", await userThemes.storeClient.report(id, reason: reason)))
            }
        case "theme.share":
            // One of the person's themes (a copy or linked, never one from the store) uploaded as it's stored.
            guard let id = arg["id"] as? String, ThemeStore.idOK(id) else { return }
            let key = "themeShare:\(id)"
            guard let entry = userThemes.store.list().first(where: { $0["id"] as? String == id }), entry["store"] == nil,
                  let message = userThemes.store.message(id) else {
                return reply(storeResult(key, ["ok": false, "message": "Only a theme of your own can be shared."]))
            }
            Task { [weak self] in
                guard let self else { return }
                reply(storeResult(key, await userThemes.storeClient.share(message: message)))
            }
        case "theme.save":
            guard let value = arg["value"] as? JSONObject else { return }
            let reload = arg["link"] as? String // a linked folder's theme read again
            let linking = arg["linked"] as? Bool == true && reload == nil
            let fromStore = arg["store"] as? Bool == true && reload == nil && !linking
            // (A linked folder's theme stored again only under the id it's linked as: never another theme's.)
            if let reload, value["id"] as? String != reload || !userThemes.store.links().contains(where: { $0.id == reload }) {
                return Diagnostics.warn("themes: a linked folder's theme refused for storing: not the theme linked there")
            }
            do {
                let entry: JSONObject
                if fromStore {
                    // Installed from the store: only the theme downloaded here for its preview, as the list said it.
                    guard let id = value["id"] as? String, let p = userThemes.takePendingInstall(id) else {
                        throw ThemeStore.Refused(description: "the theme to install wasn’t downloaded here, or it was over \(Int(UserThemes.pendingLinkFor / 60)) minutes ago")
                    }
                    entry = try userThemes.store.saveFromStore(value, version: p.version, sha256: p.sha256)
                    Diagnostics.note("themes: one installed from the theme store (\(entry["bytes"] ?? 0) bytes)")
                } else {
                    entry = try userThemes.store.save(value)
                }
                let id = entry["id"] as? String ?? ""
                if linking {
                    guard let url = userThemes.takePendingLink() else {
                        throw ThemeStore.Refused(description: "the folder to load wasn’t picked here, or it was picked over \(Int(UserThemes.pendingLinkFor / 60)) minutes ago")
                    }
                    try userThemes.store.link(id, path: url.path)
                    followLinkedFolder(id, path: url.path)
                    Diagnostics.note("themes: one loaded unpacked (\(entry["bytes"] ?? 0) bytes), its folder followed")
                } else if !fromStore {
                    Diagnostics.note("themes: one stored\(reload == nil ? "" : " again from its linked folder") (\(entry["bytes"] ?? 0) bytes)")
                }
                themesListChanged()
                if reload != nil { marginWindows?.themeStored() } else { chose(id) }
            } catch {
                Diagnostics.warn("themes: one refused for storing: \(error)")
                reply(jsonString(["type": "themeSaved", "ok": false, "error": "Margin couldn’t keep that theme (\(error))."] as JSONObject) ?? "{}")
            }
        case "theme.unlink":
            guard let id = arg["id"] as? String, ThemeStore.idOK(id) else { return }
            stopFollowing(id)
            guard userThemes.store.unlink(id) else { return }
            Diagnostics.note("themes: one unlinked (its folder followed no more)")
            themesListChanged()
        case "theme.remove":
            guard let id = arg["id"] as? String, ThemeStore.idOK(id) else { return }
            stopFollowing(id)
            do {
                guard try userThemes.store.remove(id) else { return }
                Diagnostics.note("themes: one removed")
            } catch { return Diagnostics.warn("themes: one couldn't be removed: \(error)") }
            // Margin's own settings and every linked copy that used it: back to Arcadia.
            if hostedSettings?.chosenTheme == id { chose("arcadia") }
            for entry in links.values where (entry.mirror.value("settings") as? JSONObject)?["theme"] as? String == id {
                Task { _ = try? await entry.connection.request(type: "updateSettings", payload: ["patch": ["theme": "arcadia"]], windowId: nil) }
            }
            themesListChanged()
        default:
            Diagnostics.note("\(name) isn't the app's yet")
        }
    }

    // ---- linked folders (Load Unpacked) ----

    // Every linked theme's folder followed (Margin's windows made: there's a page to check what's read).
    func followLinkedFolders() {
        for link in userThemes.store.links() where userThemes.watches[link.id] == nil { followLinkedFolder(link.id, path: link.path) }
    }

    func followLinkedFolder(_ id: String, path: String) {
        stopFollowing(id)
        guard let watch = FolderWatch(path: path, onChange: { [weak self] in self?.linkedFolderChanged(id) }) else {
            return Diagnostics.warn("themes: a linked folder couldn't be followed")
        }
        userThemes.watches[id] = watch
    }

    func stopFollowing(_ id: String) {
        userThemes.watches.removeValue(forKey: id)?.stop()
    }

    // A linked folder changed: read again within the import's caps and handed to a Margin window's page, which checks it
    // and asks for it to be stored again only when it passes (`theme.save` with `link`); else its reasons are shown and
    // the last good one stays drawn.
    func linkedFolderChanged(_ id: String) {
        guard let path = userThemes.store.links().first(where: { $0.id == id })?.path else { return stopFollowing(id) }
        guard let page = marginWindows?.controllers.first(where: \.isReady) else { return }
        let read = ThemeFileReader.read(URL(fileURLWithPath: path, isDirectory: true), chosen: true)
        var message = read.isTheme && read.kind == "folder" ? read.message : ["type": "themeFile", "error": "Margin couldn’t read the theme’s folder."]
        message["link"] = id
        Diagnostics.note("themes: a linked folder changed, read again (\(read.bytes) bytes)")
        page.push(jsonString(message) ?? "{}")
    }

    // The index as Margin's windows and the copies get it.
    var themesListJSON: String { jsonString(userThemes.store.list()) ?? "[]" }

    // The index changed: every Margin window and every linked copy told; and Settings' Themes, if it was shown, what each
    // store theme is now (installed, an update, yours).
    func themesListChanged() {
        marginWindows?.tellThemes()
        for entry in links.values { themesTellCopy(entry) }
        if userThemes.storeShown?["state"] as? String == "ready" {
            let shown: JSONObject = ["state": "ready", "rows": userThemes.storeClient.rows(installed: userThemes.store.list())]
            userThemes.storeShown = shown
            marginWindows?.tell(jsonString(shown.merging(["type": "themeStore"]) { $1 }) ?? "{}")
        }
    }

    // What a store request came to, for the Settings line `key` (a field's id): `{ type: "themeStoreResult", key, ok,
    // message?, data? }` (the page words what was done).
    func storeResult(_ key: String, _ result: JSONObject) -> String {
        var m: JSONObject = ["type": "themeStoreResult", "key": key, "ok": result["ok"] as? Bool == true]
        if let message = result["message"] as? String, !message.isEmpty { m["message"] = message }
        if let data = result["data"] as? JSONObject { m["data"] = data }
        return jsonString(m) ?? "{}"
    }

    // A copy linked (its first snapshot): the index, so its updateSettings takes an imported theme's id.
    func themesTellCopy(_ entry: Link) {
        let list = userThemes.store.list()
        Task { _ = try? await entry.connection.request(type: "userThemes", payload: ["list": list], windowId: nil) }
    }

    // Something of Margin's that needed it active is over (a picker, the quit prompt): the app shown in the window
    // hosting gets the activation back (MarginWindowController `keysBack`; nothing if nothing's shown).
    func keysBackToShown(_ why: String) {
        guard let windows = marginWindows, let w = hosted?.hostingWindow.flatMap({ id in windows.controllers.first { $0.id == id } }) else { return }
        w.keysBack(why)
    }
}
