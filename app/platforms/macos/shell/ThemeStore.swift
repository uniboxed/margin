// The themes a person imported (docs/phase6-themes.md §3), kept by Margin.app
// for the whole Mac, not per profile: a theme is the person's look in every
// browser and profile. `~/Library/Application Support/Margin/themes/`:
//
//   <id>.json    the stored package, as the overlay made it (ui/theme-loader.ts
//                encodeStoredTheme: format 2, id, version, savedAt, manifest,
//                html, css, files as base64)
//   index.json   the short list: [{ id, name, version, author, bytes, savedAt }]
//
// Each written as DataStore writes (a temporary file, fsync, the old one kept
// as .bak, a rename). The app checks a value's shape, id and size; what's in
// it is checked by the overlay, in JS, every time it loads (the same checks as
// any theme). A file of a later format, or one whose id isn't its name, is
// never used. Never logs names, paths or content.

import Foundation

final class ThemeStore {
    static let format = 2
    static let maxBytes = 4_718_592 // ui/theme-loader.ts PACKAGE_LIMITS.storedBytes (4.5 MB)
    static let maxThemes = 50
    // The built-ins' ids (extension/themes/packages.ts), and an earlier name of one that saved settings still mean it
    // by (Neubrutalism's until 2026-11-10: state/model.ts OLD_NAMES): an imported theme takes neither.
    static let builtins: Set<String> = ["arcadia", "neubrutalism", "pixel", "neo-brutalism"]
    // ui/theme-schema.ts: a theme's id.
    static func idOK(_ id: String) -> Bool {
        guard (1...41).contains(id.count), let first = id.unicodeScalars.first, Self.lowerDigit(first) else { return false }
        return id.unicodeScalars.allSatisfy { Self.lowerDigit($0) || $0 == "-" }
    }
    private static func lowerDigit(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("0"..."9").contains(c) }

    // ~/Library/Application Support/Margin/themes
    static var appRoot: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Margin/themes", isDirectory: true)
    }

    struct Refused: Error, CustomStringConvertible { let description: String }

    let root: URL
    private var cache: [String: (savedAt: Double, json: String)] = [:]
    init(root: URL) { self.root = root }

    private var indexURL: URL { root.appendingPathComponent("index.json") }
    private func fileURL(_ id: String) -> URL { root.appendingPathComponent("\(id).json") }

    private static func readObject(_ url: URL) -> Any? {
        for u in [url, URL(fileURLWithPath: url.path + ".bak")] {
            if let data = try? Data(contentsOf: u), let o = try? JSONSerialization.jsonObject(with: data) { return o }
        }
        return nil
    }

    // The index: entries with an id the rule allows, not a built-in's, once each.
    func list() -> [JSONObject] {
        guard let raw = Self.readObject(indexURL) as? [JSONObject] else { return [] }
        var seen = Set<String>()
        return raw.filter { e in
            guard let id = e["id"] as? String, Self.idOK(id), !Self.builtins.contains(id), !seen.contains(id) else { return false }
            seen.insert(id)
            return true
        }
    }

    func has(_ id: String) -> Bool { list().contains { $0["id"] as? String == id } }

    // A value from the overlay, checked for shape and size, then stored and listed. Its entry back.
    @discardableResult func save(_ value: JSONObject, now: Double = Date().timeIntervalSince1970 * 1000) throws -> JSONObject {
        guard value["format"] as? Int == Self.format else { throw Refused(description: "not a stored theme of format \(Self.format)") }
        guard let id = value["id"] as? String, Self.idOK(id) else { throw Refused(description: "a bad id") }
        guard !Self.builtins.contains(id) else { throw Refused(description: "a built-in theme's id") }
        guard let manifest = value["manifest"] as? String, value["html"] is String, value["css"] is String,
              let files = value["files"] as? [String: Any], files.values.allSatisfy({ $0 is String }), files.count <= 64 else {
            throw Refused(description: "not a theme package")
        }
        guard let m = (try? JSONSerialization.jsonObject(with: Data(manifest.utf8))) as? JSONObject, m["id"] as? String == id else {
            throw Refused(description: "its theme.json names another id")
        }
        var stored = value
        stored["savedAt"] = now
        guard let data = try? JSONSerialization.data(withJSONObject: stored, options: [.sortedKeys]) else { throw Refused(description: "not JSON") }
        guard data.count <= Self.maxBytes else { throw Refused(description: "larger than \(Self.maxBytes) bytes") }
        let text = { (key: String, cap: Int) -> String in String(((m[key] as? String) ?? "").prefix(cap)) }
        let entry: JSONObject = ["id": id, "name": text("name", 60), "version": text("version", 16), "author": text("author", 80), "bytes": data.count, "savedAt": now]
        var index = list().filter { $0["id"] as? String != id }
        guard index.count < Self.maxThemes else { throw Refused(description: "more than \(Self.maxThemes) themes") }
        index.append(entry)
        try DataStore.writeAtomically(data, to: fileURL(id))
        try writeIndex(index)
        cache[id] = nil
        return entry
    }

    // The theme message the overlay draws ({ id, manifest, html, css, files }), or nil:
    // not listed, missing, of a later format, or naming another id.
    func message(_ id: String) -> String? {
        guard Self.idOK(id), let entry = list().first(where: { $0["id"] as? String == id }) else { return nil }
        let savedAt = (entry["savedAt"] as? NSNumber)?.doubleValue ?? 0
        if let c = cache[id], c.savedAt == savedAt { return c.json }
        guard let o = Self.readObject(fileURL(id)) as? JSONObject else { return nil }
        guard let format = o["format"] as? Int, format == Self.format else { return nil } // a later format: never read
        guard o["id"] as? String == id, let manifest = o["manifest"] as? String, let html = o["html"] as? String, let css = o["css"] as? String,
              let files = o["files"] as? [String: String] else { return nil }
        guard let json = jsonString(["id": id, "manifest": manifest, "html": html, "css": css, "files": files] as JSONObject) else { return nil }
        cache[id] = (savedAt, json)
        return json
    }

    // The theme's file and its entry gone. Whether it was there.
    @discardableResult func remove(_ id: String) throws -> Bool {
        guard Self.idOK(id) else { return false }
        let index = list()
        guard index.contains(where: { $0["id"] as? String == id }) else { return false }
        try writeIndex(index.filter { $0["id"] as? String != id })
        for u in [fileURL(id), URL(fileURLWithPath: fileURL(id).path + ".bak")] { try? FileManager.default.removeItem(at: u) }
        cache[id] = nil
        return true
    }

    private func writeIndex(_ index: [JSONObject]) throws {
        guard let data = try? JSONSerialization.data(withJSONObject: index, options: [.sortedKeys]) else { throw Refused(description: "the index isn't JSON") }
        try DataStore.writeAtomically(data, to: indexURL)
    }
}

// ---- what the picker chose, read with caps before reading ----

enum ThemeFileReader {
    static let maxFiles = 70 // ui/theme-import.ts IMPORT_LIMITS.entries
    static let maxDepth = 2 // folders below the theme's own
    static let maxFileBytes = 512 * 1024 // a font's cap, the largest of a package's (ui/theme-loader.ts PACKAGE_LIMITS)
    static let maxFolderBytes = 4 * 1024 * 1024
    static let maxZipBytes = 4 * 1024 * 1024 // ui/theme-import.ts IMPORT_LIMITS.zipBytes

    // The message for the overlay: { type: 'themeFile', kind, files | zip } or { type: 'themeFile', error }
    // (Margin's words). `bytes`: what was read, for the log.
    static func read(_ url: URL) -> (message: JSONObject, kind: String, bytes: Int) {
        let fail = { (why: String) -> (JSONObject, String, Int) in (["type": "themeFile", "error": why], "refused", 0) }
        guard let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey, .fileSizeKey]) else {
            return fail("Margin couldn’t read what you chose.")
        }
        if values.isSymbolicLink == true { return fail("That’s an alias or a link. Choose the theme’s folder or .margintheme file itself.") }
        if values.isDirectory == true { return readFolder(url) }
        guard values.isRegularFile == true else { return fail("That isn’t a folder or a .margintheme file.") }
        guard (values.fileSize ?? .max) <= maxZipBytes else { return fail("That file is larger than 4 MB, too large for a theme.") }
        guard let data = try? Data(contentsOf: url), data.count <= maxZipBytes else { return fail("Margin couldn’t read that file.") }
        return (["type": "themeFile", "kind": "zip", "zip": data.base64EncodedString()], "zip", data.count)
    }

    private static func readFolder(_ folder: URL) -> (message: JSONObject, kind: String, bytes: Int) {
        let fail = { (why: String) -> (JSONObject, String, Int) in (["type": "themeFile", "error": why], "refused", 0) }
        let base = folder.resolvingSymlinksInPath().standardizedFileURL.path
        let keys: [URLResourceKey] = [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey, .fileSizeKey]
        guard let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys, options: []) else {
            return fail("Margin couldn’t read that folder.")
        }
        var files: [String: String] = [:]
        var total = 0
        for case let url as URL in walker {
            let name = url.lastPathComponent
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return fail("Margin couldn’t read a file in that folder.") }
            let path = url.resolvingSymlinksInPath().standardizedFileURL.path
            // Inside the folder, by its own path (nothing that resolves elsewhere).
            guard v.isSymbolicLink != true else { return fail("That folder holds an alias or a link. Themes can’t hold any.") }
            guard path.hasPrefix(base + "/") else { return fail("That folder holds a file from somewhere else.") }
            let rel = String(path.dropFirst(base.count + 1))
            if name == ".DS_Store" { continue }
            if v.isDirectory == true {
                if name.hasPrefix(".") { walker.skipDescendants(); continue } // .git and the like: never part of a theme
                if rel.split(separator: "/").count > maxDepth + 1 { return fail("That folder is nested too deep for a theme.") }
                continue
            }
            guard v.isRegularFile == true else { return fail("That folder holds something that isn’t a file.") }
            if name.hasPrefix(".") { continue }
            guard rel.split(separator: "/").count <= maxDepth + 1 else { return fail("That folder is nested too deep for a theme.") }
            guard files.count < maxFiles else { return fail("That folder holds more than \(maxFiles) files, too many for a theme.") }
            let size = v.fileSize ?? .max
            guard size <= maxFileBytes, total + size <= maxFolderBytes else { return fail("That folder is too large for a theme.") }
            guard let data = try? Data(contentsOf: url), data.count == size else { return fail("Margin couldn’t read a file in that folder.") }
            total += data.count
            files[rel] = data.base64EncodedString()
        }
        return (["type": "themeFile", "kind": "folder", "files": files], "folder", total)
    }
}
