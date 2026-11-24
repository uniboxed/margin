// Margin's own window in the shell (MarginWindow.swift, MarginWindowController.swift; docs/MARGIN-APP.md phase 2).
//
// The windows draw the library (LibraryWindowSource, HostedSession.swift, made in ShellHostedGlue.swift) once it
// opened. DataSetWindowSource is the fallback when it didn't, and gives the settings and site icons either way
// (`settingsAndIcons`, each draw of the library's): one browser
// profile's lasting data set (DataSync.swift, read only), turned into the
// State shape pages draw as the extension's stateFromDataSet would (extension/shared/data-set.ts), every Margin
// tab a kept tab (nothing is open in Margin's window yet). Choosing a space (per window) and a setting changed (the
// sidebar kept open) are kept here, in memory; a theme's setting changed (the sidebar's width, dragged) is also kept
// across launches, in the app's defaults (`ThemeSettingsKeeper`: until the app's own store has settings); nothing else
// is written anywhere.

import AppKit

// Where the theme settings changed in Margin's window last: read once as the source is made, written at each change.
// The app's: its defaults (`MarginWindowThemeSettings`: { theme id: { setting: a number, a string or a switch } }); a
// test's or the harness's: none (in memory only).
struct ThemeSettingsKeeper {
    var read: () -> [String: JSONObject]
    var write: ([String: JSONObject]) -> Void

    static let key = "MarginWindowThemeSettings"
    static let appDefaults = ThemeSettingsKeeper(
        read: { clean(UserDefaults.standard.dictionary(forKey: key) ?? [:]) },
        write: { UserDefaults.standard.set(clean($0), forKey: key) })

    // Only what a theme's settings are (numbers, strings up to 200 characters, switches), for at most 50 themes of 50 settings each.
    static func clean(_ raw: [String: Any]) -> [String: JSONObject] {
        var out: [String: JSONObject] = [:]
        for (theme, values) in raw.sorted(by: { $0.key < $1.key }).prefix(50) {
            guard theme.count <= 60, let values = values as? [String: Any] else { continue }
            let kept = values.filter { $0.key.count <= 60 && ($0.value is NSNumber || ($0.value as? String).map { $0.count <= 200 } == true) }
            if !kept.isEmpty { out[theme] = Dictionary(uniqueKeysWithValues: kept.sorted { $0.key < $1.key }.prefix(50).map { ($0.key, $0.value) }) }
        }
        return out
    }
}

// Margin's settings changed in Margin's window (updateSettings), kept across launches: the app's defaults
// (`MarginWindowSettings`: { setting: a number, a string, a switch or a list of strings }); a test's or the harness's: none.
// Until the app's own store has settings. Only Margin's own keys (no `themes`: each theme's are ThemeSettingsKeeper's).
struct SettingsKeeper {
    var read: () -> JSONObject
    var write: (JSONObject) -> Void

    static let key = "MarginWindowSettings"
    static let appDefaults = SettingsKeeper(
        read: { clean(UserDefaults.standard.dictionary(forKey: key) ?? [:]) },
        write: { UserDefaults.standard.set(clean($0), forKey: key) })

    // At most 100 settings: numbers and switches, strings up to 500 characters, lists of up to 500 such strings.
    static func clean(_ raw: [String: Any]) -> JSONObject {
        var out: JSONObject = [:]
        for (key, value) in raw.sorted(by: { $0.key < $1.key }).prefix(100) where key.count <= 60 && key != "themes" {
            if value is NSNumber { out[key] = value }
            else if let s = value as? String, s.count <= 500 { out[key] = s }
            else if let list = value as? [Any] {
                let strings = list.compactMap { $0 as? String }.filter { $0.count <= 500 }
                if strings.count == list.count, strings.count <= 500 { out[key] = strings }
            }
        }
        return out
    }
}

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
    // The theme chosen in Margin's own Settings (nil: none chosen there: the profile's set says).
    var chosenTheme: String? { settings["theme"] as? String }
    // Requests this can't do yet, by type (the log says the first of each).
    private(set) var unhandled: [String: Int] = [:]

    private let keeper: ThemeSettingsKeeper?
    private let settingsKeeper: SettingsKeeper?

    init(data: DataSync, pick: @escaping () -> DataProfile?, keeper: ThemeSettingsKeeper? = nil, settingsKeeper: SettingsKeeper? = nil) {
        self.data = data
        self.pick = pick
        self.keeper = keeper
        self.settingsKeeper = settingsKeeper
        themeSettings = keeper?.read() ?? [:]
        settings = settingsKeeper?.read() ?? [:]
        // (After the shell's own: a set changed on disk is drawn again.)
        let before = data.onChange
        data.onChange = { [weak self] p, collections in
            before?(p, collections)
            guard let self, p == self.pick() else { return }
            self.onChange?()
        }
    }

    // The whole State (the no-rules fallback's, until step 4: ShellHostedGlue makeHostedSource).
    func snapshot() -> JSONObject {
        let p = pick()
        var state = Self.state(values: { collection in p.map { self.data.values(collection, of: $0) } ?? [:] }, active: active)
        if let s = state["settings"] as? JSONObject { state["settings"] = overlaid(s) }
        return state
    }

    // What the library's snapshot takes of the profile (LibraryWindowSource, every draw), no State built: its settings
    // with each theme's own under `themes` and what was changed in the UI over them, and its site icons. The same
    // values as `snapshot()`'s `settings` and `favicons`.
    func settingsAndIcons() -> (settings: JSONObject, icons: JSONObject) {
        let p = pick()
        return (drawnSettings(p), p.map { data.values("siteIcons", of: $0) } ?? [:])
    }
    // (The settings alone: a UI request's, a search's engine and the favorites' scope.)
    var drawnSettings: JSONObject { drawnSettings(pick()) }
    private func drawnSettings(_ p: DataProfile?) -> JSONObject {
        var s: JSONObject = p.map { data.values("settings", of: $0) } ?? [:]
        s["themes"] = p.map { data.values("themeSettings", of: $0) } ?? [:]
        return overlaid(s)
    }
    // The settings changed in the UI over the set's (each theme's over its own).
    private func overlaid(_ base: JSONObject) -> JSONObject {
        guard !settings.isEmpty || !themeSettings.isEmpty else { return base }
        var s = base
        s.merge(settings) { _, new in new }
        var themes = s["themes"] as? JSONObject ?? [:]
        for (id, patch) in themeSettings { themes[id] = (themes[id] as? JSONObject ?? [:]).merging(patch) { _, new in new } }
        s["themes"] = themes
        return s
    }

    @discardableResult func perform(_ type: String, _ payload: JSONObject) -> JSONObject? {
        if type == "setSpace", let space = payload["spaceId"] as? String, let window = payload["windowId"] as? Int {
            active[window] = space
            onChange?()
            return nil
        }
        if type == "updateSettings", let patch = payload["patch"] as? JSONObject, !patch.isEmpty {
            settings.merge(patch.filter { $0.key != "themes" }) { _, new in new }
            settingsKeeper?.write(settings)
            onChange?()
            return nil
        }
        if type == "updateThemeSettings", let theme = payload["themeId"] as? String, let patch = payload["patch"] as? JSONObject, !patch.isEmpty {
            themeSettings[theme, default: [:]].merge(patch) { _, new in new }
            keeper?.write(themeSettings)
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
            var space: JSONObject = ["id": id, "name": s["name"] as? String ?? "", "emoji": s["emoji"] as? String ?? "", "color": s["color"] as? String ?? ""]
            if let theme = s["theme"] as? String, !theme.isEmpty { space["theme"] = theme }
            return space
        }
        if spaces.isEmpty { spaces = [defaultSpace] }
        let known = Set(spaces.compactMap { $0["id"] as? String })
        let pins: [JSONObject] = objects("pins").map { id, p in
            var pin: JSONObject = ["id": id, "spaceId": p["spaceId"] as? String ?? "", "url": p["url"] as? String ?? "", "title": p["title"] as? String ?? "", "pos": number(p["pos"])]
            if let folder = p["folderId"] as? String { pin["folderId"] = folder }
            if let custom = p["customTitle"] as? String, !custom.isEmpty { pin["customTitle"] = custom }
            return pin
        }
        let favorites: [JSONObject] = objects("favorites").map { id, f in
            var fav: JSONObject = ["id": id, "scope": f["scope"] as? String ?? "global", "url": f["url"] as? String ?? "", "title": f["title"] as? String ?? "", "pos": number(f["pos"])]
            if let custom = f["customTitle"] as? String, !custom.isEmpty { fav["customTitle"] = custom }
            if let target = f["target"] { fav["target"] = target }
            return fav
        }
        let airTraffic: [JSONObject] = objects("airTraffic").sorted { (number($0.value["order"]), $0.id) < (number($1.value["order"]), $1.id) }.map { id, r in
            ["id": id, "pattern": r["pattern"] as? String ?? "", "spaceId": r["spaceId"] as? String ?? "", "enabled": r["enabled"] as? Bool ?? true, "order": number(r["order"])]
        }
        let splits: [JSONObject] = objects("splits").map { id, g in
            var split: JSONObject = ["id": id, "spaceId": g["spaceId"] as? String ?? "", "axis": g["axis"] as? String ?? "horizontal", "panes": g["panes"] as? [String] ?? [], "ratios": g["ratios"] as? [Double] ?? []]
            if let pinned = g["pinned"] as? Bool, pinned { split["pinned"] = true }
            if let folder = g["folderId"] as? String { split["folderId"] = folder }
            return split
        }
        let folders: [JSONObject] = objects("folders").map { id, f in
            var folder: JSONObject = ["id": id, "spaceId": f["spaceId"] as? String ?? "", "name": f["name"] as? String ?? "", "open": f["open"] as? Bool ?? true, "pos": number(f["pos"])]
            if let parent = f["parentId"] as? String, !parent.isEmpty { folder["parentId"] = parent }
            return folder
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
            "spaces": spaces, "pins": pins, "favorites": favorites, "airTraffic": airTraffic, "splits": splits, "folders": folders, "archive": archive, "settings": settings,
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
        let last = options.lastBrowser()
        return withSpaces.first { $0.browser == last } ?? withSpaces.first
    }

    // The theme Margin's window draws (a package's JSON): the one its settings choose (`hostedSettings`: what was
    // chosen in Margin's own Settings, else the profile's set), an imported one or a built-in Margin carries; with none
    // chosen, a linked copy's package; nil: Arcadia, bundled with the page.
    // A window's (`window`, `state`: the state it draws): the theme of the space it shows first (2026-11-20, Tirth: a
    // theme per space; MarginWindowController.spaceTheme), when Margin has that theme (an imported one removed since:
    // the next one down).
    func hostedTheme(window: Int? = nil, state: JSONObject? = nil) -> String? {
        if let window, let state, let own = MarginWindowController.spaceTheme(window: window, state: state),
           let json = userThemes.store.message(own) ?? builtinThemes.message(own) { return json }
        let chosen = hostedSettings?.chosenTheme ?? hostedProfile().flatMap { data.values("settings", of: $0)["theme"] as? String }
        if let chosen, let json = userThemes.store.message(chosen) ?? builtinThemes.message(chosen) { return json }
        // (Nothing chosen: Arcadia's own package, never nil while it's there: a window that drew another space's theme
        // must be told to draw Arcadia again, and nil tells it nothing.)
        return links.keys.sorted().lazy.compactMap { self.links[$0]?.theme }.first ?? builtinThemes.message("arcadia")
    }

    // Margin's windows, made once.
    @discardableResult
    func makeMarginWindows(options windowOptions: MarginWindows.Options? = nil) -> MarginWindows {
        if let marginWindows { return marginWindows }
        var o = windowOptions ?? MarginWindows.Options()
        o.harness = o.harness || options.harness
        // (How Margin's window is kept in front of what it hosts: `defaults write com.unibox.margin MarginFront order`
        // for the ordering way; unset or anything else: its level, the ordering way if the window server doesn't hold it.)
        if !o.harness, windowOptions == nil, UserDefaults.standard.string(forKey: FrontMechanism.key) == FrontMechanism.order.rawValue { o.front = .order }
        let source = makeHostedSource()
        let windows = MarginWindows(pages: pages, source: source, options: o)
        windows.theme = { [weak self] window, state in self?.hostedTheme(window: window, state: state) }
        windows.themes = { [weak self] in self?.themesListJSON ?? "[]" }
        windows.browser = options.lastBrowser()
        marginWindows = windows
        joinHosted(windows)
        Diagnostics.note("Margin's window: its settings read from \(hostedProfile().map(\.key) ?? "no data set yet")")
        return windows
    }

    // Opened by hand, or again: Margin's menu bar, and its window in front (a new one if none is open).
    func showMarginWindow() {
        let windows = makeMarginWindows()
        windows.installMenu()
        windows.reopen()
    }
}
