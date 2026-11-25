// Installed apps (app/platforms/macos/shell/AppCatalog.swift, ShellApps.swift), against fake .app bundles in a
// temporary folder (never /Applications): which bundles are hostable (the one rule), names, the folders' walk (one
// level of plain subfolders, never inside a bundle), one entry per bundle id, Spotlight's paths kept or not, the
// overlays' JSON, the icons' cache (a stand-in renderer: made once per app version, the older one removed), the
// watcher's scan off the main thread and its rescan on a change, and `app.open` handed to the host (or only logged).

import Foundation

func appsTests() {
    let fm = FileManager.default
    let tmp = fm.temporaryDirectory.appendingPathComponent("margin-apps-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: tmp) }
    func makeApp(_ folder: URL, _ file: String, _ info: [String: Any]) {
        let contents = folder.appendingPathComponent("\(file).app/Contents", isDirectory: true)
        try? fm.createDirectory(at: contents, withIntermediateDirectories: true)
        if let data = try? PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0) { try? data.write(to: contents.appendingPathComponent("Info.plist")) }
    }
    func plain(_ id: String, _ extra: [String: Any] = [:]) -> [String: Any] { ["CFBundleIdentifier": id, "CFBundlePackageType": "APPL"].merging(extra) { $1 } }

    // ---- the rule ----
    check("apps: an ordinary app is hostable", AppCatalog.hostable(bundleId: "com.example.editor", name: "Editor", info: plain("com.example.editor")))
    check("apps: no bundle id, or a bad one: not", !AppCatalog.hostable(bundleId: nil, name: "X", info: [:]) && !AppCatalog.hostable(bundleId: "../x", name: "X", info: [:]) && !AppCatalog.hostable(bundleId: "", name: "X", info: [:]))
    check("apps: an agent (LSUIElement, as a bool, a number or a string) or a background app: not",
          !AppCatalog.hostable(bundleId: "a.b", name: "A", info: ["LSUIElement": true]) && !AppCatalog.hostable(bundleId: "a.b", name: "A", info: ["LSUIElement": 1])
          && !AppCatalog.hostable(bundleId: "a.b", name: "A", info: ["LSUIElement": "1"]) && !AppCatalog.hostable(bundleId: "a.b", name: "A", info: ["LSBackgroundOnly": "YES"])
          && AppCatalog.hostable(bundleId: "a.b", name: "A", info: ["LSUIElement": false]) && AppCatalog.hostable(bundleId: "a.b", name: "A", info: ["LSUIElement": "0"]))
    check("apps: not an application bundle: not", !AppCatalog.hostable(bundleId: "a.b", name: "A", info: ["CFBundlePackageType": "BNDL"]) && AppCatalog.hostable(bundleId: "a.b", name: "A", info: [:]))
    check("apps: Margin's own app listed (a surprise when picked), never its parts or old builds, never hostable",
          AppCatalog.listed(bundleId: "com.unibox.margin", name: "Margin", info: [:]) && !AppCatalog.listed(bundleId: "com.unibox.margin.helper", name: "margin-helper", info: [:])
          && !AppCatalog.listed(bundleId: "io.tirth.margin", name: "Margin", info: [:]) && !AppCatalog.listed(bundleId: "com.unibox.margin", name: "Margin", info: ["CFBundlePackageType": "BNDL"]))
    check("apps: Margin itself (any build, any part) is never offered", !AppCatalog.hostable(bundleId: "com.unibox.margin", name: "Margin", info: [:])
          && !AppCatalog.hostable(bundleId: "com.unibox.margin.helper", name: "margin-helper", info: [:]) && !AppCatalog.hostable(bundleId: "io.tirth.margin", name: "Margin", info: [:])
          && AppCatalog.hostable(bundleId: "com.unibox.marginalia", name: "Marginalia", info: [:]))
    check("apps: installers, uninstallers, updaters and the system's own parts: not",
          !AppCatalog.hostable(bundleId: "com.apple.InstallAssistant.macOSTahoe", name: "Install macOS Tahoe", info: [:])
          && !AppCatalog.hostable(bundleId: "com.example.uninst", name: "Uninstall Example", info: [:]) && !AppCatalog.hostable(bundleId: "com.example.inst", name: "Example Installer", info: [:])
          && !AppCatalog.hostable(bundleId: "com.example.up", name: "Example Updater", info: [:]) && !AppCatalog.hostable(bundleId: "com.apple.finder", name: "Finder", info: [:])
          && !AppCatalog.hostable(bundleId: "com.apple.Dock", name: "Dock", info: [:]))
    check("apps: bundle ids as the page takes them", AppCatalog.isBundleId("org.old_style.App-2") && !AppCatalog.isBundleId("-a") && !AppCatalog.isBundleId("a b")
          && !AppCatalog.isBundleId("é.x") && !AppCatalog.isBundleId(String(repeating: "a", count: 256)))

    // ---- the folders ----
    let apps = tmp.appendingPathComponent("Applications", isDirectory: true)
    let more = tmp.appendingPathComponent("More", isDirectory: true)
    makeApp(apps, "Editor", plain("com.example.editor"))
    makeApp(apps, "Zed Notes", plain("com.example.zed", ["CFBundleDisplayName": "Zed"]))
    makeApp(apps, "Agent", plain("com.example.agent", ["LSUIElement": true]))
    makeApp(apps, "Margin", plain("com.unibox.margin"))
    makeApp(apps, "Broken", ["CFBundleName": "Broken"]) // no bundle id
    makeApp(apps.appendingPathComponent("Office Suite", isDirectory: true), "Writer", plain("com.example.writer"))
    makeApp(apps.appendingPathComponent("Deep/Deeper", isDirectory: true), "TooDeep", plain("com.example.deep"))
    makeApp(apps.appendingPathComponent("Editor.app/Contents/Helpers", isDirectory: true), "Editor Helper", plain("com.example.editor.helper"))
    makeApp(apps.appendingPathComponent(".hidden", isDirectory: true), "Hidden", plain("com.example.hidden"))
    try? "not an app".write(to: apps.appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)
    try? fm.createDirectory(at: apps.appendingPathComponent("NoPlist.app/Contents", isDirectory: true), withIntermediateDirectories: true)
    makeApp(more, "Editor Copy", plain("com.example.editor")) // the same app again, later
    makeApp(more, "Atlas", plain("com.example.atlas"))
    let found = AppCatalog.bundles(in: apps).map(\.lastPathComponent)
    check("apps: the folder's bundles and its plain subfolders', one level, never inside a bundle or hidden",
          Set(found) == ["Agent.app", "Broken.app", "Editor.app", "Margin.app", "NoPlist.app", "Writer.app", "Zed Notes.app"], "\(found)")
    check("apps: a folder that isn't there: none", AppCatalog.bundles(in: tmp.appendingPathComponent("nope")).isEmpty)
    // (Safari since macOS 13: /Applications/Safari.app is a hidden link to the app in the system's cryptex.)
    let linked = tmp.appendingPathComponent("Linked", isDirectory: true)
    let cryptex = tmp.appendingPathComponent("Cryptex", isDirectory: true)
    makeApp(cryptex, "Browser", plain("com.example.browser"))
    makeApp(linked, "Flagged", plain("com.example.flagged")) // a hidden app (the flag, not a dot): stays out
    makeApp(linked.appendingPathComponent("Flagged Folder", isDirectory: true), "Inside", plain("com.example.inside"))
    try? fm.createSymbolicLink(atPath: linked.appendingPathComponent("Browser.app").path, withDestinationPath: cryptex.appendingPathComponent("Browser.app").path)
    let flagged = ["Browser.app", "Flagged.app", "Flagged Folder"].allSatisfy { lchflags(linked.appendingPathComponent($0).path, UInt32(UF_HIDDEN)) == 0 }
    let inLinked = AppCatalog.bundles(in: linked).map(\.lastPathComponent)
    check("apps: a hidden link to an app is listed (Safari's), a hidden app or folder isn't", flagged && inLinked == ["Browser.app"], "\(flagged) \(inLinked)")
    check("apps: the hidden link read as the app it links to", AppCatalog.read(linked.appendingPathComponent("Browser.app"))?.bundleId == "com.example.browser")

    let editor = AppCatalog.read(apps.appendingPathComponent("Editor.app"))
    check("apps: one read: its bundle id, Finder's name, its path, its Info.plist's time", editor?.bundleId == "com.example.editor" && editor?.name == "Editor"
          && editor?.path.hasSuffix("/Applications/Editor.app") == true && (editor?.stamp ?? 0) > 1_700_000_000, "\(String(describing: editor))")
    check("apps: an app's name is Finder's (its file's), not its display name key", AppCatalog.read(apps.appendingPathComponent("Zed Notes.app"))?.name == "Zed Notes")
    check("apps: no Info.plist: nothing", AppCatalog.read(apps.appendingPathComponent("NoPlist.app")) == nil)
    let home = tmp.appendingPathComponent("home").path
    let listed = AppCatalog.scan(folders: [apps, more], home: home)
    check("apps: the scan: the hostable ones, one per bundle id (the first folder's), sorted by name",
          listed.map(\.name) == ["Atlas", "Editor", "Margin", "Writer", "Zed Notes"] && listed.first { $0.bundleId == "com.example.editor" }?.path.contains("/Applications/") == true, "\(listed.map(\.name))")

    // ---- Spotlight's paths ----
    check("apps: Spotlight: an app elsewhere is kept", AppCatalog.spotlightKept("/Users/x/Tools/Thing.app", home: "/Users/x") && AppCatalog.spotlightKept("/Developer/Thing.app", home: "/Users/x"))
    check("apps: Spotlight: inside a bundle, the Trash, a hidden folder, another volume, a Library or the system: not",
          !AppCatalog.spotlightKept("/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app", home: "/Users/x")
          && !AppCatalog.spotlightKept("/Library/Frameworks/X.framework/Versions/A/Helper.app", home: "/Users/x")
          && !AppCatalog.spotlightKept("/Users/x/.Trash/Old.app", home: "/Users/x") && !AppCatalog.spotlightKept("/Volumes/Installer/Setup.app", home: "/Users/x")
          && !AppCatalog.spotlightKept("/Users/x/Library/Developer/Xcode/DerivedData/Build/Products/Debug/Margin.app", home: "/Users/x")
          && !AppCatalog.spotlightKept("/System/Library/CoreServices/Finder.app", home: "/Users/x") && !AppCatalog.spotlightKept("relative/Thing.app", home: "/Users/x")
          && !AppCatalog.spotlightKept("/Users/x/Tools/thing.txt", home: "/Users/x"))
    let extra = more.appendingPathComponent("Atlas.app").path
    let withExtra = AppCatalog.scan(folders: [apps], extra: [extra, apps.appendingPathComponent("Editor.app").path], home: home)
    check("apps: Spotlight's apps after the folders', a path already read not twice", withExtra.map(\.name) == ["Atlas", "Editor", "Margin", "Writer", "Zed Notes"], "\(withExtra.map(\.name))")

    // ---- the overlays' JSON ----
    let json = AppCatalog.json(listed, icons: ["com.example.editor": "data:image/png;base64,AAAA"])
    let parsed = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [[String: Any]]
    check("apps: the JSON: [{ bundleId, name, icon }], icon null when none", parsed?.count == 5 && parsed?[1]["bundleId"] as? String == "com.example.editor"
          && parsed?[1]["icon"] as? String == "data:image/png;base64,AAAA" && parsed?[0]["icon"] is NSNull && Set(parsed?[0].keys.map { $0 } ?? []) == ["bundleId", "name", "icon"]
          && !json.contains("/Applications"), json)

    // ---- the icons' cache ----
    nonisolated final class Renders: @unchecked Sendable { var count = 0; let lock = NSLock() }
    let renders = Renders()
    let cacheFolder = tmp.appendingPathComponent("cache/app-icons", isDirectory: true)
    let cache = AppIconCache(folder: cacheFolder, pixels: 32, render: { _, pixels in
        renders.lock.lock(); renders.count += 1; renders.lock.unlock()
        return Data([0x89, 0x50, 0x4e, 0x47, UInt8(pixels)])
    })
    var app = InstalledApp(bundleId: "com.example.Editor", name: "Editor", path: apps.appendingPathComponent("Editor.app").path, stamp: 100)
    let first = cache.dataURL(for: app)
    check("apps: an icon made, as a PNG data URL, and kept on disk", first == "data:image/png;base64,iVBORyA=" && renders.count == 1
          && fm.fileExists(atPath: cacheFolder.appendingPathComponent("com.example.editor@100@32.png").path), "\(first ?? "nil")")
    check("apps: the same version again: read back, not made again", cache.dataURL(for: app) == first && renders.count == 1)
    makeApp(apps, "Editor Pro", plain("com.example.editor-pro"))
    _ = cache.dataURL(for: InstalledApp(bundleId: "com.example.editor-pro", name: "Editor Pro", path: "", stamp: 5))
    app.stamp = 200
    _ = cache.dataURL(for: app)
    let files = Set((try? fm.contentsOfDirectory(atPath: cacheFolder.path)) ?? [])
    check("apps: a new version: made again, its older icon removed, another app's kept", renders.count == 3 && files == ["com.example.editor@200@32.png", "com.example.editor-pro@5@32.png"], "\(files)")
    // The size raised (32 px to 64, 2026-11-17): every icon made again at the new size, its older file removed.
    check("apps: icons are 64 px (sharp at 32 pt on a 2x display: a loader's icon)", AppCatalog.iconPixels == 64 && AppIconCache(folder: cacheFolder).pixels == 64)
    let bigger = AppIconCache(folder: cacheFolder, pixels: 64, render: { _, pixels in
        renders.lock.lock(); renders.count += 1; renders.lock.unlock()
        return Data([0x89, 0x50, 0x4e, 0x47, UInt8(pixels)])
    })
    let resized = bigger.dataURL(for: app)
    let afterResize = Set((try? fm.contentsOfDirectory(atPath: cacheFolder.path)) ?? [])
    check("apps: another size: the kept icon not used, made at the new size, the old size's file removed", resized == "data:image/png;base64,iVBOR0A=" && renders.count == 4
          && afterResize == ["com.example.editor@200@64.png", "com.example.editor-pro@5@32.png"] && bigger.dataURL(for: app) == resized && renders.count == 4, "\(resized ?? "nil") \(afterResize)")
    let none = AppIconCache(folder: cacheFolder, pixels: 32, render: { _, _ in nil })
    check("apps: no icon can be made: none", none.dataURL(for: InstalledApp(bundleId: "com.example.none", name: "None", path: "", stamp: 1)) == nil)
    let huge = AppIconCache(folder: cacheFolder, pixels: 32, render: { _, _ in Data(count: AppIconCache.maxBytes + 1) })
    check("apps: an icon too big: none", huge.dataURL(for: InstalledApp(bundleId: "com.example.huge", name: "Huge", path: "", stamp: 1)) == nil)

    // ---- the watcher ----
    var options = AppCatalogWatcher.Options()
    options.folders = [apps, more]
    options.home = home
    options.spotlight = false
    options.debounce = 0.05
    options.latency = 0.05
    options.icons = AppIconCache(folder: cacheFolder, pixels: 32, render: { _, _ in Data([1, 2, 3]) })
    let watcher = AppCatalogWatcher(options: options)
    var heard: [String] = []
    watcher.onChange = { heard.append($0) }
    watcher.start()
    check("apps: the scan isn't on the main thread: nothing heard as it starts", heard.isEmpty)
    appsWait(5) { !heard.isEmpty }
    let names = ((try? JSONSerialization.jsonObject(with: Data((heard.last ?? "[]").utf8))) as? [[String: Any]])?.compactMap { $0["name"] as? String }
    check("apps: the watcher's first scan, with icons", heard.count == 1 && names?.contains("Editor") == true && heard[0].contains("data:image/png;base64,AQID"), "\(heard.count) \(names ?? []) \(heard.first?.prefix(300) ?? "")")
    makeApp(more, "Bridge", plain("com.example.bridge"))
    watcher.folderChanged() // (FSEvents says so too, but not on every file system: as it would)
    appsWait(5) { heard.count >= 2 }
    check("apps: an app added: scanned again and heard", heard.count == 2 && heard[1].contains("\"Bridge\""))
    let scansBefore = watcher.scans
    watcher.folderChanged()
    appsWait(2) { watcher.scans > scansBefore }
    check("apps: scanned again with nothing new: not heard", watcher.scans > scansBefore && heard.count == 2)
    watcher.stop()
    check("apps: stopped", !watcher.running)

    // ---- the shell ----
    var o = Shell.Options()
    o.harness = true
    o.appCatalog = options
    let on = Shell(link: SocketLink(), apps: StubApps(), hotKeys: FakeRegistrar(), options: o)
    on.appsStart()
    check("apps: the catalog runs with the shell", on.appCatalog?.running == true)
    on.appsStop()
    check("apps: stopped with the shell", on.appCatalog == nil && on.appsJSON == nil)
}

private func appsWait(_ seconds: TimeInterval, _ done: () -> Bool) {
    let until = Date().addingTimeInterval(seconds)
    while !done(), Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
}
