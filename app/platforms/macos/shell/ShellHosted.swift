// Margin's own window in the shell (MarginWindow.swift, MarginWindowController.swift; docs/MARGIN-APP.md phase 2).
//
// The windows draw the library (LibraryWindowSource, HostedSession.swift, made in ShellHostedGlue.swift).
// DataSetWindowSource gives the settings and site icons each draw of the library's takes (`drawnText`, their text kept
// between their changes): one browser profile's lasting data set (DataSync.swift, read only), with the settings changed
// in Margin's window over it. A setting changed (the sidebar kept open) is kept here, and across launches in the app's defaults
// (`SettingsKeeper`), as a theme's setting changed (the sidebar's width, dragged: `ThemeSettingsKeeper`), until the
// app's own store has settings; nothing else is written anywhere.

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

final class DataSetWindowSource {
    let data: DataSync
    // The profile whose settings are drawn (asked again at every draw: a copy linking can change it).
    let pick: () -> DataProfile?
    var onChange: (() -> Void)?
    // Settings changed in the UI (updateSettings), and each theme's (updateThemeSettings), over the set's.
    private(set) var settings: JSONObject = [:]
    private(set) var themeSettings: [String: JSONObject] = [:]
    // The theme chosen in Margin's own Settings (nil: none chosen there: the profile's set says).
    var chosenTheme: String? { settings["theme"] as? String }

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

    // What each draw of the library's takes of the profile: its settings with each theme's own under `themes` and what
    // was changed in the UI over them, and its site icons.
    func settingsAndIcons() -> (settings: JSONObject, icons: JSONObject) { settingsAndIcons(pick()) }
    private func settingsAndIcons(_ p: DataProfile?) -> (settings: JSONObject, icons: JSONObject) {
        (drawnSettings(p), p.map { data.values("siteIcons", of: $0) } ?? [:])
    }

    // The same as each draw's text (`"settings":…,"favicons":…`, which the core splices into the library's state:
    // LibraryWindowSource), made again only when what it reads may have changed: the data set (any call of the data's
    // but a read, `DataSync.changes`, written yet or not), a setting changed here, or another profile picked.
    func drawnText() -> String {
        let p = pick()
        if let kept = drawn, kept.profile == p, kept.changes == data.changes, kept.edits == edits { return kept.text }
        let s = settingsAndIcons(p)
        let text = #""settings":"# + (jsonString(s.settings) ?? "{}") + #","favicons":"# + (jsonString(s.icons) ?? "{}")
        drawn = (p, data.changes, edits, text)
        textsMade += 1
        return text
    }
    private var drawn: (profile: DataProfile?, changes: Int, edits: Int, text: String)?
    private var edits = 0 // the settings changed here (`perform`)
    private(set) var textsMade = 0 // (the tests')
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

    // A settings request of the UI's (the core's `settings` route: core/session/ui.rs), kept and drawn again.
    @discardableResult func perform(_ type: String, _ payload: JSONObject) -> JSONObject? {
        if type == "updateSettings", let patch = payload["patch"] as? JSONObject, !patch.isEmpty {
            settings.merge(patch.filter { $0.key != "themes" }) { _, new in new }
            edits += 1
            settingsKeeper?.write(settings)
            onChange?()
            return nil
        }
        if type == "updateThemeSettings", let theme = payload["themeId"] as? String, let patch = payload["patch"] as? JSONObject, !patch.isEmpty {
            themeSettings[theme, default: [:]].merge(patch) { _, new in new }
            edits += 1
            keeper?.write(themeSettings)
            onChange?()
            return nil
        }
        return nil
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
    // A window's (`spaceTheme`: the theme of the space it shows, the library's `spaceTheme(window:)`): that one first
    // (2026-11-20, Tirth: a theme per space), when Margin has that theme (an imported one removed since: the next one
    // down).
    func hostedTheme(spaceTheme own: String? = nil) -> String? {
        if let own, let json = userThemes.store.message(own) ?? builtinThemes.message(own) { return json }
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
        windows.theme = { [weak self] _, own in self?.hostedTheme(spaceTheme: own) }
        windows.themes = { [weak self] in self?.themesListJSON ?? "[]" }
        windows.profiles = { [weak self] in self?.profilesJSON() ?? "null" }
        windows.background = { [weak self] type, payload in await self?.performBackground(type, payload) ?? ["ok": false, "error": "Pictures aren’t available here."] }
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
