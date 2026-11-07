// The user themes' store and reader (app/shell/ThemeStore.swift), in a
// temporary folder (never ~/Library/Application Support/Margin): a value
// stored and listed, read back as the overlay's theme message, replaced,
// removed; values refused for their shape, id or size; files tampered with
// on disk never used; what the picker chose read within its caps (folders:
// no links, not too deep, hidden folders left out; files: a size cap).

import Foundation

func themeTests() {
    let fm = FileManager.default
    let tmp = fm.temporaryDirectory.appendingPathComponent("margin-theme-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: tmp) }
    let store = ThemeStore(root: tmp.appendingPathComponent("themes"))
    func value(_ id: String, name: String = "Mine", version: String = "1.0.0", manifestId: String? = nil, extra: JSONObject = [:]) -> JSONObject {
        let manifest = jsonString(["format": 2, "id": manifestId ?? id, "name": name, "version": version, "author": "Me"] as JSONObject) ?? "{}"
        return ["format": 2, "id": id, "version": version, "savedAt": 1, "manifest": manifest, "html": "<div><m-page></m-page></div>", "css": ".a{}", "files": ["LICENSE.txt": "aGk="]].merging(extra) { $1 }
    }
    let refused = { (v: JSONObject) -> String? in do { try store.save(v); return nil } catch { return "\(error)" } }

    // ---- storing ----
    check("themes: nothing listed at first", store.list().isEmpty && store.message("mine") == nil)
    let entry = try? store.save(value("mine"), now: 42)
    check("themes: stored, with its entry from its theme.json", entry?["id"] as? String == "mine" && entry?["name"] as? String == "Mine" && entry?["version"] as? String == "1.0.0"
          && entry?["author"] as? String == "Me" && (entry?["savedAt"] as? Double) == 42 && ((entry?["bytes"] as? Int) ?? 0) > 0, "\(entry ?? [:])")
    check("themes: listed", store.list().map { $0["id"] as? String } == ["mine"] && store.has("mine"))
    let msg = object(store.message("mine"))
    check("themes: read back as the overlay's theme message, nothing else in it", msg?["id"] as? String == "mine" && (msg?["files"] as? [String: String])?["LICENSE.txt"] == "aGk="
          && Set(msg?.keys.map { $0 } ?? []) == ["id", "manifest", "html", "css", "files"])
    check("themes: its files on disk: the package and the index", fm.fileExists(atPath: tmp.appendingPathComponent("themes/mine.json").path) && fm.fileExists(atPath: tmp.appendingPathComponent("themes/index.json").path))
    _ = try? store.save(value("mine", name: "Mine again", version: "1.1.0"), now: 43)
    check("themes: the same id again replaces it (listed once)", store.list().count == 1 && store.list().first?["version"] as? String == "1.1.0" && object(store.message("mine")).flatMap { $0["manifest"] as? String }?.contains("Mine again") == true)
    _ = try? store.save(value("other"), now: 44)
    check("themes: another, listed after it", store.list().compactMap { $0["id"] as? String } == ["mine", "other"])

    // ---- refused ----
    check("themes: a built-in's id refused", refused(value("arcadia"))?.contains("built-in") == true)
    check("themes: a bad id refused", refused(value("../evil")) != nil && refused(value("Mine")) != nil && refused(value("")) != nil && refused(value(String(repeating: "a", count: 42))) != nil)
    check("themes: a theme.json naming another id refused", refused(value("mine", manifestId: "arcadia"))?.contains("another id") == true)
    check("themes: another format refused", refused(value("mine", extra: ["format": 3])) != nil)
    check("themes: not a package refused", refused(value("mine", extra: ["files": ["a.png": 5]])) != nil && refused(["format": 2, "id": "x"]) != nil)
    check("themes: over 4.5 MB refused", refused(value("big", extra: ["css": String(repeating: "x", count: ThemeStore.maxBytes)]))?.contains("larger") == true)
    check("themes: nothing refused was listed", store.list().count == 2)

    // ---- tampered with on disk ----
    let file = tmp.appendingPathComponent("themes/other.json")
    var stored = object(try? Data(contentsOf: file)) ?? [:]
    stored["format"] = 3
    try? JSONSerialization.data(withJSONObject: stored).write(to: file)
    try? fm.removeItem(atPath: file.path + ".bak")
    let fresh = ThemeStore(root: tmp.appendingPathComponent("themes"))
    check("themes: a stored file of a later format never used", fresh.message("other") == nil)
    stored["format"] = 2
    stored["id"] = "mine"
    try? JSONSerialization.data(withJSONObject: stored).write(to: file)
    check("themes: a stored file whose id isn't its name never used", fresh.message("other") == nil)
    try? Data("[{\"id\":\"arcadia\"},{\"id\":\"../x\"},{\"id\":\"mine\"},{\"id\":\"mine\"}]".utf8).write(to: tmp.appendingPathComponent("themes/index.json"))
    check("themes: an index edited by hand: built-ins, bad ids and repeats left out", fresh.list().compactMap { $0["id"] as? String } == ["mine"])
    check("themes: a theme not in the index isn't drawn", fresh.message("other") == nil)

    // ---- removed ----
    check("themes: removed", (try? fresh.remove("mine")) == true && fresh.list().isEmpty && fresh.message("mine") == nil && !fm.fileExists(atPath: tmp.appendingPathComponent("themes/mine.json").path))
    check("themes: removing one that isn't there: nothing", (try? fresh.remove("mine")) == false && (try? fresh.remove("../index")) == false)

    // ---- what the picker chose ----
    let folder = tmp.appendingPathComponent("My Theme", isDirectory: true)
    try? fm.createDirectory(at: folder.appendingPathComponent("fonts"), withIntermediateDirectories: true)
    for (name, text) in [("theme.json", "{}"), ("theme.html", "<div></div>"), ("theme.css", ""), ("fonts/OFL.txt", "licence"), (".DS_Store", "x")] {
        try? Data(text.utf8).write(to: folder.appendingPathComponent(name))
    }
    try? fm.createDirectory(at: folder.appendingPathComponent(".git"), withIntermediateDirectories: true)
    try? Data("[core]".utf8).write(to: folder.appendingPathComponent(".git/config"))
    var read = ThemeFileReader.read(folder)
    let files = read.message["files"] as? [String: String] ?? [:]
    check("themes: a folder read: its files by path, as base64, .DS_Store and .git left out", read.kind == "folder" && Set(files.keys) == ["theme.json", "theme.html", "theme.css", "fonts/OFL.txt"] && files["theme.html"] == Data("<div></div>".utf8).base64EncodedString(), "\(files.keys.sorted())")
    try? fm.createSymbolicLink(at: folder.appendingPathComponent("hosts.txt"), withDestinationURL: URL(fileURLWithPath: "/etc/hosts"))
    read = ThemeFileReader.read(folder)
    check("themes: a folder with a link in it refused, in Margin's words", read.kind == "refused" && (read.message["error"] as? String)?.contains("link") == true)
    try? fm.removeItem(at: folder.appendingPathComponent("hosts.txt"))
    try? fm.createDirectory(at: folder.appendingPathComponent("images/a/b"), withIntermediateDirectories: true)
    try? Data("x".utf8).write(to: folder.appendingPathComponent("images/a/b/deep.png"))
    read = ThemeFileReader.read(folder)
    check("themes: a folder nested too deep refused", read.kind == "refused" && (read.message["error"] as? String)?.contains("deep") == true)
    try? fm.removeItem(at: folder.appendingPathComponent("images"))
    try? Data(count: ThemeFileReader.maxFileBytes + 1).write(to: folder.appendingPathComponent("fonts/big.woff2"))
    read = ThemeFileReader.read(folder)
    check("themes: a file over the cap refused before it's read", read.kind == "refused" && (read.message["error"] as? String)?.contains("too large") == true)
    try? fm.removeItem(at: folder.appendingPathComponent("fonts/big.woff2"))
    let zip = tmp.appendingPathComponent("mine.margintheme")
    try? Data([0x50, 0x4b, 0x05, 0x06] + [UInt8](repeating: 0, count: 18)).write(to: zip)
    read = ThemeFileReader.read(zip)
    check("themes: a .margintheme file read as bytes (the overlay reads the zip)", read.kind == "zip" && read.message["zip"] as? String == Data([0x50, 0x4b, 0x05, 0x06] + [UInt8](repeating: 0, count: 18)).base64EncodedString())
    try? Data(count: ThemeFileReader.maxZipBytes + 1).write(to: zip)
    check("themes: a file over 4 MB refused", ThemeFileReader.read(zip).kind == "refused")
    let alias = tmp.appendingPathComponent("alias.margintheme")
    try? fm.createSymbolicLink(at: alias, withDestinationURL: zip)
    check("themes: a link chosen refused", (ThemeFileReader.read(alias).message["error"] as? String)?.contains("link") == true)
}
