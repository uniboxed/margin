// The Mac's installed apps, for Margin's palette (docs/MARGIN-APP.md phase 4, docs/PROTOCOL.md "Installed
// apps"): the apps Margin could host in its page area, each with its bundle id, its name as Finder shows it,
// its path, and a small icon. Only with `MarginHosted` on (Shell.Options.hosted, ShellApps.swift).
//
// - Where: the usual folders (`AppCatalog.folders`), each with one level of plain subfolders, then what
//   Spotlight lists as an application elsewhere (`spotlightKept`: not inside another bundle, the Trash, a
//   hidden folder, another volume or a Library). One entry per bundle id: the first found.
// - Which: `AppCatalog.hostable`, the one rule (an app with a window to show: no agents, no background apps,
//   not Margin, not an installer, not the system's own parts).
// - Icons: 32 px PNGs, made once per app version (its Info.plist's time) and kept in Application Support/
//   Margin/cache/app-icons; read back from there, and kept in memory between scans.
// - When: at start, then 2 s after a change in the folders (FSEvents) or in Spotlight's list. Every scan and
//   every icon runs on a background queue; the main thread only hears the result, as JSON.
//
// Pure parts (`AppCatalog`, `AppIconCache`) are nonisolated and tested against fake bundles in a temporary
// folder (tests/apps-tests.swift). The log says counts only, never a name or path.

import AppKit
import CoreServices
import Foundation

nonisolated struct InstalledApp: Equatable, Sendable {
    var bundleId: String
    var name: String
    var path: String
    var stamp: Int // its Info.plist's modification time, whole seconds: an icon made is kept for this version
}

nonisolated enum AppCatalog {
    static let iconPixels = 32

    /// Where apps are looked for, in order (the first one's copy of an app wins).
    static func folders(home: URL) -> [URL] {
        ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            + [home.appendingPathComponent("Applications", isDirectory: true),
               URL(fileURLWithPath: "/System/Library/CoreServices/Applications", isDirectory: true)]
    }

    static var iconFolder: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        return support.appendingPathComponent("Margin/cache/app-icons", isDirectory: true)
    }

    // ---- which apps can be hosted: the one rule ----

    static let ownIds = ["com.unibox.margin", "io.tirth.margin"] // Margin itself and its parts, any build
    // The system's own parts that are apps on disk but nothing to open in a page area (lowercased).
    static let systemParts: Set<String> = [
        "com.apple.finder", "com.apple.dock", "com.apple.loginwindow", "com.apple.systemuiserver", "com.apple.controlcenter",
        "com.apple.notificationcenterui", "com.apple.installer", "com.apple.installer-progress", "com.apple.coreservices.uiagent",
    ]

    /// Whether an app can be hosted in Margin's page area: an application with a bundle id; not an agent or a
    /// background app (`LSUIElement`, `LSBackgroundOnly`); not Margin; not an installer, an uninstaller or an
    /// updater; not one of the system's own parts.
    static func hostable(bundleId: String?, name: String, info: [String: Any]) -> Bool {
        guard let id = bundleId, isBundleId(id) else { return false }
        if let type = info["CFBundlePackageType"] as? String, type != "APPL" { return false }
        if flag(info["LSUIElement"]) || flag(info["LSBackgroundOnly"]) { return false }
        let lower = id.lowercased()
        if ownIds.contains(where: { lower == $0 || lower.hasPrefix($0 + ".") }) { return false }
        if systemParts.contains(lower) || lower.hasPrefix("com.apple.installassistant.") { return false } // "Install macOS …"
        let words = name.lowercased()
        if words.contains("uninstall") || words.hasSuffix("installer") || words.hasSuffix(" updater") { return false }
        return true
    }

    /// A bundle id as macOS allows it (letters, digits, '-', '.'; '_' too, which older apps use): the page's rule.
    static func isBundleId(_ id: String) -> Bool {
        guard (1...255).contains(id.utf8.count), let first = id.unicodeScalars.first, first.isASCII, CharacterSet.alphanumerics.contains(first) else { return false }
        return id.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "-" || $0 == "_") }
    }

    // An Info.plist yes: a boolean, a number, or the strings plists have held it as.
    static func flag(_ value: Any?) -> Bool {
        switch value {
        case let b as Bool: return b
        case let n as NSNumber: return n.intValue != 0
        case let s as String: return ["1", "yes", "true"].contains(s.lowercased())
        default: return false
        }
    }

    // ---- reading ----

    /// One bundle, if it's a hostable app: its Info.plist read (never its code), its name as Finder shows it.
    static func read(_ app: URL, fm: FileManager = .default) -> InstalledApp? {
        guard app.pathExtension.lowercased() == "app" else { return nil }
        let plist = app.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plist), data.count <= 4 << 20,
              let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any] else { return nil }
        let name = displayName(app, info: info, fm: fm)
        guard let id = info["CFBundleIdentifier"] as? String, hostable(bundleId: id, name: name, info: info) else { return nil }
        let modified = (try? fm.attributesOfItem(atPath: plist.path))?[.modificationDate] as? Date
        return InstalledApp(bundleId: id, name: name, path: app.path, stamp: Int(modified?.timeIntervalSince1970 ?? 0))
    }

    // Finder's name (localized: "System Settings" in the person's language), else the bundle's own, else the file's.
    static func displayName(_ app: URL, info: [String: Any], fm: FileManager = .default) -> String {
        var name = fm.displayName(atPath: app.path)
        if name.lowercased().hasSuffix(".app") { name = String(name.dropLast(4)) }
        name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        for key in ["CFBundleDisplayName", "CFBundleName"] {
            if let v = (info[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty { return v }
        }
        return app.deletingPathExtension().lastPathComponent
    }

    /// The `.app` bundles in a folder and in its plain subfolders, one level down ("/Applications/Microsoft
    /// Office/…"), sorted; never inside a bundle, never a hidden item.
    static func bundles(in folder: URL, fm: FileManager = .default) -> [URL] {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey, .isSymbolicLinkKey]
        guard let items = try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return [] }
        var out: [URL] = []
        for item in items.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            if item.pathExtension.lowercased() == "app" { out.append(item); continue }
            guard let v = try? item.resourceValues(forKeys: Set(keys)), v.isDirectory == true, v.isPackage != true, v.isSymbolicLink != true,
                  let inner = try? fm.contentsOfDirectory(at: item, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { continue }
            out += inner.filter { $0.pathExtension.lowercased() == "app" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        }
        return out
    }

    static let bundleExtensions: Set<String> = ["app", "framework", "bundle", "plugin", "xpc", "appex", "kext", "prefpane", "systemextension", "docc", "xcarchive"]

    /// Whether an app Spotlight found outside the folders is offered: not inside another bundle (helpers, embedded
    /// apps), a hidden folder (the Trash too), another volume (a mounted installer image), a Library or the system.
    static func spotlightKept(_ path: String, home: String) -> Bool {
        guard path.hasPrefix("/"), path.lowercased().hasSuffix(".app") else { return false }
        let parents = path.split(separator: "/").dropLast()
        if parents.contains(where: { $0.hasPrefix(".") || bundleExtensions.contains(($0 as NSString).pathExtension.lowercased()) }) { return false }
        for prefix in ["/Volumes/", "/Library/", "/System/", "/private/", "/usr/", "/opt/", "/cores/", "/nix/", home + "/Library/"] where path.hasPrefix(prefix) { return false }
        return true
    }

    /// Every hostable app in the folders, then those Spotlight found (`extra`), one per bundle id (the first found),
    /// sorted by name as Finder sorts.
    static func scan(folders: [URL], extra: [String] = [], home: String, fm: FileManager = .default) -> [InstalledApp] {
        var paths = Set<String>()
        var ids = Set<String>()
        var out: [InstalledApp] = []
        let found = folders.flatMap { bundles(in: $0, fm: fm) } + extra.filter { spotlightKept($0, home: home) }.sorted().map { URL(fileURLWithPath: $0, isDirectory: true) }
        for url in found {
            guard paths.insert(url.standardizedFileURL.path).inserted, let app = read(url, fm: fm), ids.insert(app.bundleId.lowercased()).inserted else { continue }
            out.append(app)
        }
        return out.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// The overlays' list (docs/PROTOCOL.md "Installed apps"): `[{ bundleId, name, icon }]`, `icon` a data URL or null.
    static func json(_ apps: [InstalledApp], icons: [String: String]) -> String {
        let list: [[String: Any]] = apps.map { ["bundleId": $0.bundleId, "name": $0.name, "icon": icons[$0.bundleId].map { $0 as Any } ?? NSNull()] }
        guard let data = try? JSONSerialization.data(withJSONObject: list, options: [.sortedKeys, .withoutEscapingSlashes]) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }

    /// An app's icon as Finder draws it, `pixels` square, as a PNG.
    static func renderIcon(path: String, pixels: Int) -> Data? {
        let image = NSWorkspace.shared.icon(forFile: path)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        rep.size = NSSize(width: pixels, height: pixels)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels), from: .zero, operation: .copy, fraction: 1)
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}

/// The icons made, on disk: `<bundle id>@<stamp>@<pixels>.png` (`@` is never in a bundle id), an app's older ones
/// removed as a new one is written.
nonisolated struct AppIconCache: Sendable {
    static let maxBytes = 48 * 1024
    let folder: URL
    var pixels = AppCatalog.iconPixels
    var render: @Sendable (String, Int) -> Data? = { AppCatalog.renderIcon(path: $0, pixels: $1) }

    static func stem(_ bundleId: String) -> String {
        String(bundleId.lowercased().unicodeScalars.filter { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "-" || $0 == "_") }.map(Character.init))
    }

    func file(for app: InstalledApp) -> URL { folder.appendingPathComponent("\(Self.stem(app.bundleId))@\(app.stamp)@\(pixels).png") }

    /// The app's icon as a data URL: the kept one, else made now and kept. Nil when none can be made.
    func dataURL(for app: InstalledApp, fm: FileManager = .default) -> String? {
        let file = file(for: app)
        if let data = try? Data(contentsOf: file), !data.isEmpty, data.count <= Self.maxBytes { return Self.url(data) }
        guard let png = render(app.path, pixels), !png.isEmpty, png.count <= Self.maxBytes else { return nil }
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let prefix = Self.stem(app.bundleId) + "@"
        for name in (try? fm.contentsOfDirectory(atPath: folder.path)) ?? [] where name.hasPrefix(prefix) && name != file.lastPathComponent {
            try? fm.removeItem(at: folder.appendingPathComponent(name))
        }
        try? png.write(to: file, options: .atomic)
        return Self.url(png)
    }

    static func url(_ png: Data) -> String { "data:image/png;base64," + png.base64EncodedString() }
}

/// The catalog kept up to date: scans off the main thread, `onChange` with the overlays' JSON when it changed.
final class AppCatalogWatcher {
    struct Options {
        var folders = AppCatalog.folders(home: FileManager.default.homeDirectoryForCurrentUser)
        var home = FileManager.default.homeDirectoryForCurrentUser.path
        var icons = AppIconCache(folder: AppCatalog.iconFolder)
        var spotlight = true // apps elsewhere, from Spotlight's index (off in the tests)
        var debounce: TimeInterval = 2
        var latency: TimeInterval = 1 // FSEvents' own coalescing
    }

    let options: Options
    var onChange: ((String) -> Void)?
    private(set) var json: String?
    private(set) var scans = 0
    private(set) var count = 0
    private var stopped = true
    private var scanning = false
    private var again = false
    private var pending: Timer?
    private var stream: FSEventStreamRef?
    private var query: NSMetadataQuery?
    private var queryObservers: [NSObjectProtocol] = []
    private var spotlightPaths: [String] = []
    private var iconMemo: [String: String] = [:] // "<bundle id>@<stamp>" → its data URL
    private let queue = DispatchQueue(label: "com.unibox.margin.app-catalog", qos: .utility)

    init(options: Options = Options()) { self.options = options }

    var running: Bool { !stopped }

    func start() {
        guard stopped else { return }
        stopped = false
        startStream()
        if options.spotlight { startQuery() }
        scanNow()
    }

    func stop() {
        stopped = true
        pending?.invalidate()
        pending = nil
        if let stream { FSEventStreamStop(stream); FSEventStreamInvalidate(stream); FSEventStreamRelease(stream) }
        stream = nil
        query?.stop()
        query = nil
        for o in queryObservers { NotificationCenter.default.removeObserver(o) }
        queryObservers = []
    }

    /// Something changed: one scan, `debounce` from now, unless one is already coming.
    func soon() {
        guard !stopped, pending == nil else { return }
        pending = Timer.scheduledTimer(withTimeInterval: options.debounce, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.pending = nil
                self?.scanNow()
            }
        }
    }

    func scanNow() {
        guard !stopped else { return }
        if scanning { again = true; return }
        scanning = true
        let folders = options.folders, extra = spotlightPaths, home = options.home, icons = options.icons, memo = iconMemo
        queue.async {
            let apps = AppCatalog.scan(folders: folders, extra: extra, home: home)
            var kept: [String: String] = [:]
            var byId: [String: String] = [:]
            for app in apps {
                let key = "\(app.bundleId)@\(app.stamp)"
                guard let url = memo[key] ?? icons.dataURL(for: app) else { continue }
                kept[key] = url
                byId[app.bundleId] = url
            }
            let json = AppCatalog.json(apps, icons: byId)
            let count = apps.count
            DispatchQueue.main.async { MainActor.assumeIsolated { self.scanned(json, count: count, icons: kept) } }
        }
    }

    private func scanned(_ json: String, count: Int, icons: [String: String]) {
        scanning = false
        scans += 1
        guard !stopped else { return }
        iconMemo = icons
        if json != self.json {
            self.json = json
            self.count = count
            Diagnostics.note("apps: \(count) installed apps can be hosted (\(icons.count) icons)")
            onChange?(json)
        }
        if again { again = false; soon() }
    }

    func folderChanged() { soon() }

    // ---- FSEvents on the folders there are ----

    private func startStream() {
        let paths = options.folders.map(\.path).filter { FileManager.default.fileExists(atPath: $0) }
        guard stream == nil, !paths.isEmpty else { return }
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer)
        guard let made = FSEventStreamCreate(nil, appFolderEvents, &context, paths as CFArray,
                                             FSEventStreamEventId(kFSEventStreamEventIdSinceNow), options.latency, flags) else { return }
        FSEventStreamSetDispatchQueue(made, .main)
        guard FSEventStreamStart(made) else { FSEventStreamInvalidate(made); FSEventStreamRelease(made); return }
        stream = made
    }

    // ---- Spotlight: apps elsewhere ----

    private func startQuery() {
        let q = NSMetadataQuery()
        q.predicate = NSPredicate(format: "kMDItemContentType == 'com.apple.application-bundle'")
        q.searchScopes = [NSMetadataQueryLocalComputerScope]
        let read: (Notification) -> Void = { [weak self] _ in MainActor.assumeIsolated { self?.queryRead() } }
        queryObservers = [
            NotificationCenter.default.addObserver(forName: .NSMetadataQueryDidFinishGathering, object: q, queue: .main, using: read),
            NotificationCenter.default.addObserver(forName: .NSMetadataQueryDidUpdate, object: q, queue: .main, using: read),
        ]
        query = q
        if !q.start() { Diagnostics.note("apps: Spotlight's list of apps couldn't be asked for (the folders only)") }
    }

    private func queryRead() {
        guard let q = query, !stopped else { return }
        q.disableUpdates()
        var paths: [String] = []
        for i in 0..<q.resultCount {
            if let path = q.value(ofAttribute: NSMetadataItemPathKey, forResultAt: i) as? String, AppCatalog.spotlightKept(path, home: options.home) { paths.append(path) }
        }
        q.enableUpdates()
        paths.sort()
        guard paths != spotlightPaths else { return }
        spotlightPaths = paths
        soon()
    }
}

// FSEvents' callback (on the main queue, FSEventStreamSetDispatchQueue): any change in the folders, a scan soon.
private nonisolated func appFolderEvents(_ stream: ConstFSEventStreamRef, _ info: UnsafeMutableRawPointer?, _ count: Int,
                                         _ paths: UnsafeMutableRawPointer, _ flags: UnsafePointer<FSEventStreamEventFlags>,
                                         _ ids: UnsafePointer<FSEventStreamEventId>) {
    guard let info else { return }
    let pointer = UInt(bitPattern: info)
    MainActor.assumeIsolated {
        guard let raw = UnsafeMutableRawPointer(bitPattern: pointer) else { return }
        Unmanaged<AppCatalogWatcher>.fromOpaque(raw).takeUnretainedValue().folderChanged()
    }
}
