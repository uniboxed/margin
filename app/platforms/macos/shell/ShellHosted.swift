// Margin's own window in the shell (MarginWindow.swift, MarginWindowController.swift; docs/MARGIN-APP.md
// phase 2), behind `MarginHosted` (Shell.forApp; off, nothing here runs and the app is as before).
//
// The windows draw the library (LibraryWindowSource, HostedSession.swift, made in ShellHostedGlue.swift) once it
// opened. DataSetWindowSource is the fallback when it didn't, and gives the settings either way: one browser
// profile's lasting data set (DataSync.swift, read only), turned into the
// State shape pages draw as the extension's stateFromDataSet would (extension/shared/data-set.ts), every Margin
// tab a kept tab (nothing is open in Margin's window yet). Choosing a space (per window), a setting and a theme's
// setting changed (the sidebar kept open, its width) are kept here, in memory; nothing is written anywhere.

import AppKit

final class DataSetWindowSource: MarginWindowSource {
    let data: DataSync
    // The profile whose set is shown (asked again at every snapshot: a copy linking can change it).
    let pick: () -> DataProfile?
    var onChange: (() -> Void)?
    // The space each window shows, as chosen in it.
    private(set) var active: [Int: String] = [:]
    // Settings changed in the UI (updateSettings), and each theme's (updateThemeSettings), over the set's.
    private(set) var settings: JSONObject = [:]
    private(set) var themeSettings: [String: JSONObject] = [:]
    // Requests this can't do yet, by type (the log says the first of each).
    private(set) var unhandled: [String: Int] = [:]

    init(data: DataSync, pick: @escaping () -> DataProfile?) {
        self.data = data
        self.pick = pick
        // (After the shell's own: a set changed on disk is drawn again.)
        let before = data.onChange
        data.onChange = { [weak self] p, collections in
            before?(p, collections)
            guard let self, p == self.pick() else { return }
            self.onChange?()
        }
    }

    func snapshot() -> JSONObject {
        let p = pick()
        var state = Self.state(values: { collection in p.map { self.data.values(collection, of: $0) } ?? [:] }, active: active)
        guard !settings.isEmpty || !themeSettings.isEmpty, var s = state["settings"] as? JSONObject else { return state }
        s.merge(settings) { _, new in new }
        var themes = s["themes"] as? JSONObject ?? [:]
        for (id, patch) in themeSettings { themes[id] = (themes[id] as? JSONObject ?? [:]).merging(patch) { _, new in new } }
        s["themes"] = themes
        state["settings"] = s
        return state
    }

    @discardableResult func perform(_ type: String, _ payload: JSONObject) -> JSONObject? {
        if type == "setSpace", let space = payload["spaceId"] as? String, let window = payload["windowId"] as? Int {
            active[window] = space
            onChange?()
            return nil
        }
        if type == "updateSettings", let patch = payload["patch"] as? JSONObject, !patch.isEmpty {
            settings.merge(patch) { _, new in new }
            onChange?()
            return nil
        }
        if type == "updateThemeSettings", let theme = payload["themeId"] as? String, let patch = payload["patch"] as? JSONObject, !patch.isEmpty {
            themeSettings[theme, default: [:]].merge(patch) { _, new in new }
            onChange?()
            return nil
        }
        unhandled[type, default: 0] += 1
        if unhandled[type] == 1 { Diagnostics.note("Margin's window: \(type) isn't done yet (its spaces are read only until the app owns them)") }
        return nil
    }

    static let defaultSpace: JSONObject = ["id": "personal", "name": "Personal", "emoji": "🏠", "color": "#6c5ce7"]

    // A data set's collections (`values`: live values by id) as the State pages draw, nothing open:
    // spaces in their order (Personal when there are none), pins, folders, the archive newest first,
    // settings with each theme's own, site icons, and every Margin tab of a known space as a kept tab.
    // `active`: the space each window shows (one that no longer exists is left out).
    static func state(values: (String) -> [String: Any], active: [Int: String]) -> JSONObject {
        func objects(_ collection: String) -> [(id: String, value: JSONObject)] {
            values(collection).compactMap { id, v in (v as? JSONObject).map { (id, $0) } }.sorted { $0.id < $1.id }
        }
        func number(_ v: Any?) -> Double { num(v).flatMap { $0.isFinite ? $0 : nil } ?? 0 }
        var spaces: [JSONObject] = objects("spaces").sorted { (number($0.value["order"]), $0.id) < (number($1.value["order"]), $1.id) }.map { id, s in
            ["id": id, "name": s["name"] as? String ?? "", "emoji": s["emoji"] as? String ?? "", "color": s["color"] as? String ?? ""]
        }
        if spaces.isEmpty { spaces = [defaultSpace] }
        let known = Set(spaces.compactMap { $0["id"] as? String })
        let pins: [JSONObject] = objects("pins").map { id, p in
            var pin: JSONObject = ["id": id, "spaceId": p["spaceId"] as? String ?? "", "url": p["url"] as? String ?? "", "title": p["title"] as? String ?? "", "pos": number(p["pos"])]
            if let folder = p["folderId"] as? String { pin["folderId"] = folder }
            return pin
        }
        let folders: [JSONObject] = objects("folders").map { id, f in
            ["id": id, "spaceId": f["spaceId"] as? String ?? "", "name": f["name"] as? String ?? "", "open": f["open"] as? Bool ?? true, "pos": number(f["pos"])]
        }
        let archive: [JSONObject] = objects("archive").sorted { number($0.value["closedAt"]) > number($1.value["closedAt"]) }.map { id, a in
            ["id": id, "url": a["url"] as? String ?? "", "title": a["title"] as? String ?? "", "spaceId": a["spaceId"] as? String ?? "", "favIconUrl": a["icon"] as? String ?? "", "closedAt": number(a["closedAt"])]
        }
        var settings: JSONObject = values("settings")
        settings["themes"] = values("themeSettings")
        var kept: JSONObject = [:]
        for (id, t) in objects("tabs") {
            guard let space = t["spaceId"] as? String, known.contains(space) else { continue }
            kept[id] = ["id": id, "url": t["url"] as? String ?? "", "title": t["title"] as? String ?? "", "favIconUrl": t["icon"] as? String ?? "", "spaceId": space,
                        "order": number(t["order"]), "lastActive": number(t["lastUsed"]), "keptAt": number(t["lastUsed"]), "why": "app", "wasActive": t["selected"] as? Bool == true]
        }
        var shown: JSONObject = [:]
        for (window, space) in active where known.contains(space) { shown[String(window)] = space }
        return [
            "spaces": spaces, "pins": pins, "folders": folders, "archive": archive, "settings": settings,
            "favicons": values("siteIcons"), "keptTabs": kept, "tabs": JSONObject(), "tabSpace": JSONObject(),
            "activeSpaceByWindow": shown, "awayByWindow": JSONObject(), "lostTabs": NSNull(),
        ]
    }
}

extension Shell {
    // The profile Margin's window shows: a linked copy's (the first, by its key), else one of the browser Margin
    // was last linked with, else any; only one with spaces in its set. Nil: none (Personal, empty).
    func hostedProfile() -> DataProfile? {
        let withSpaces = data.profiles().filter { !data.values("spaces", of: $0).isEmpty }.sorted()
        let linked = Set(links.values.filter { $0.connection.isUp }.map { DataProfile(browser: $0.connection.hello.browser, profile: $0.connection.hello.profile) })
        if let p = withSpaces.first(where: linked.contains) { return p }
        let last = options.enterBrowser()
        return withSpaces.first { $0.browser == last } ?? withSpaces.first
    }

    // The theme Margin's window draws (a package's JSON): an imported theme its settings choose, else a linked copy's
    // package; nil: Arcadia, bundled with the page.
    func hostedTheme() -> String? {
        let chosen = hostedProfile().flatMap { data.values("settings", of: $0)["theme"] as? String }
        if let chosen, let json = userThemes.store.message(chosen) { return json }
        return links.keys.sorted().lazy.compactMap { self.links[$0]?.theme }.first
    }

    // Margin's windows, made once (their page's configuration is the overlays').
    @discardableResult
    func makeMarginWindows(options windowOptions: MarginWindows.Options? = nil) -> MarginWindows {
        if let marginWindows { return marginWindows }
        var o = windowOptions ?? MarginWindows.Options()
        o.harness = o.harness || options.harness
        let source = makeHostedSource()
        let windows = MarginWindows(pages: pages, source: source, options: o)
        windows.theme = { [weak self] in self?.hostedTheme() }
        windows.themes = { [weak self] in self?.themesListJSON ?? "[]" }
        windows.browser = options.enterBrowser()
        marginWindows = windows
        joinHosted(windows)
        Diagnostics.note("Margin's window: on (MarginHosted), its settings read from \(hostedProfile().map(\.key) ?? "no data set yet")")
        return windows
    }

    // Opened by hand, or again: Margin's menu bar, and its window in front (a new one if none is open).
    func showMarginWindow() {
        let windows = makeMarginWindows()
        windows.installMenu()
        windows.reopen()
    }
}
