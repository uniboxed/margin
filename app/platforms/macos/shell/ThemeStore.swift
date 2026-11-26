// The themes a person imported (docs/phase6-themes.md §3), kept by Margin.app for the whole Mac, not per profile: a
// theme is the person's look in every browser and profile. The rules are margin-core's `data::themes`
// (app/shared/core/src/data/themes.rs, the one copy, the Windows shell's too; docs/CORE-REFACTOR.md step 1.6), through
// margin-ffi's themes objects: the files under the folder (`<id>.json`, the stored package as the overlay made it;
// `index.json`, the short list), each written atomically with the old one kept as `.bak`; a value's shape, id and size
// checked (what's in it is checked by the overlay, in JS, every time it loads); a file of a later format, or one whose
// id isn't its name, never used; the built-ins' ids refused; what the picker chose read within caps; the built-ins'
// packages Margin carries for its own window. This file keeps the Mac's side: the folder's place and the API the rest
// of the app calls. Never logs names, paths or content.

import Foundation
import MarginCore

// The core's calls with no object.
enum ThemesCore {
    nonisolated static func call(_ request: JSONObject) -> JSONObject {
        KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_themes_protocol(p, n, $0) } } as? JSONObject ?? [:]
    }
    nonisolated static let constants = call(["type": "constants"])

    // A typed call's bytes as text (freed here); nil if it answered none.
    nonisolated static func text(_ call: (UnsafeMutablePointer<Int>) -> UnsafeMutablePointer<UInt8>?) -> String? {
        var len = 0
        guard let out = call(&len) else { return nil }
        defer { margin_buffer_free(out, len) }
        return String(decoding: UnsafeBufferPointer(start: out, count: len), as: UTF8.self)
    }
}

final class ThemeStore {
    static let format = int(ThemesCore.constants["format"]) ?? 2
    static let maxBytes = int(ThemesCore.constants["maxBytes"]) ?? 4_718_592 // ui/theme-loader.ts PACKAGE_LIMITS.storedBytes (4.5 MB)
    static let maxThemes = int(ThemesCore.constants["maxThemes"]) ?? 50
    // The built-ins' ids and an earlier name of one (app/shared/ui/themes/packages.ts): an imported theme takes neither.
    static let builtins = Set(ThemesCore.constants["builtins"] as? [String] ?? [])
    // ui/theme-schema.ts: a theme's id.
    static func idOK(_ id: String) -> Bool { ThemesCore.call(["type": "idOK", "id": id])["ok"] as? Bool == true }

    // ~/Library/Application Support/Margin/themes
    static var appRoot: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Margin/themes", isDirectory: true)
    }

    // Why a value wasn't stored (or a file not written), in the words the page shows.
    struct Refused: Error, CustomStringConvertible { let description: String }

    let root: URL
    private var core: OpaquePointer?

    init(root: URL) {
        self.root = root
        core = KeysCore.bytes(root.path) { margin_themes_new($0, $1) }
    }

    deinit { margin_themes_free(core) }

    private func call(_ request: JSONObject) -> JSONObject {
        let answer = KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_themes_call(core, p, n, $0) } } as? JSONObject ?? [:]
        if let error = answer["error"] as? String { Diagnostics.warn("themes: \(error)") }
        return answer
    }

    // The index: entries with an id the rule allows, not a built-in's, once each.
    func list() -> [JSONObject] { call(["type": "list"])["list"] as? [JSONObject] ?? [] }

    func has(_ id: String) -> Bool { call(["type": "has", "id": id])["has"] as? Bool == true }

    // A value from the overlay, checked for shape and size, then stored and listed. Its entry back.
    @discardableResult func save(_ value: JSONObject, now: Double = Date().timeIntervalSince1970 * 1000) throws -> JSONObject {
        guard JSONSerialization.isValidJSONObject(value) else { throw Refused(description: "not JSON") }
        let answer = call(["type": "save", "value": value, "now": now])
        if let entry = answer["entry"] as? JSONObject { return entry }
        throw Refused(description: answer["refused"] as? String ?? answer["error"] as? String ?? "not stored")
    }

    // A theme installed from the theme store: stored as `save` stores one, and recorded as that version and package
    // (its theme.json must say the version), so updates can be offered. Its entry back.
    @discardableResult func saveFromStore(_ value: JSONObject, version: String, sha256: String, now: Double = Date().timeIntervalSince1970 * 1000) throws -> JSONObject {
        guard JSONSerialization.isValidJSONObject(value) else { throw Refused(description: "not JSON") }
        let answer = call(["type": "saveFromStore", "value": value, "now": now, "version": version, "sha256": sha256])
        if let entry = answer["entry"] as? JSONObject { return entry }
        throw Refused(description: answer["refused"] as? String ?? answer["error"] as? String ?? "not stored")
    }

    // The theme message the overlay draws ({ id, manifest, html, css, files }), or nil:
    // not listed, missing, of a later format, or naming another id.
    func message(_ id: String) -> String? {
        KeysCore.bytes(id) { p, n in ThemesCore.text { margin_themes_message(core, p, n, $0) } }
    }

    // The theme's file and its entry gone (and its link). Whether it was there.
    @discardableResult func remove(_ id: String) throws -> Bool {
        let answer = call(["type": "remove", "id": id])
        if let removed = answer["removed"] as? Bool { return removed }
        throw Refused(description: answer["refused"] as? String ?? answer["error"] as? String ?? "not removed")
    }

    // A stored theme linked to a folder (Load Unpacked, docs/THEME-STORE.md §1): its full path, from Margin's own picker
    // only. One theme per folder (the core's).
    func link(_ id: String, path: String, now: Double = Date().timeIntervalSince1970 * 1000) throws {
        let answer = call(["type": "link", "id": id, "path": path, "now": now])
        if answer["linked"] as? Bool == true { return }
        throw Refused(description: answer["refused"] as? String ?? answer["error"] as? String ?? "not linked")
    }

    // Its link gone; the theme stays stored. Whether it was linked.
    @discardableResult func unlink(_ id: String) -> Bool { call(["type": "unlink", "id": id])["unlinked"] as? Bool == true }

    // The linked themes still listed: id and folder.
    func links() -> [(id: String, path: String)] {
        (call(["type": "links"])["links"] as? [JSONObject] ?? []).compactMap { o in
            guard let id = o["id"] as? String, let path = o["path"] as? String else { return nil }
            return (id, path)
        }
    }
}

// ---- what the picker chose, read with caps before reading (the core's) ----

enum ThemeFileReader {
    static let maxFiles = int(ThemesCore.constants["maxFiles"]) ?? 70 // ui/theme-import.ts IMPORT_LIMITS.entries
    static let maxFileBytes = int(ThemesCore.constants["maxFileBytes"]) ?? 512 * 1024 // a font's cap
    static let maxZipBytes = int(ThemesCore.constants["maxZipBytes"]) ?? 4 * 1024 * 1024 // ui/theme-import.ts IMPORT_LIMITS.zipBytes

    // The message for the overlay: { type: 'themeFile', kind, files | zip } or { type: 'themeFile', error }
    // (Margin's words). `bytes`: what was read, for the log. `chosen`: the picker's choice, refused unread unless it's a
    // folder or a .margintheme file (`isTheme` false then).
    static func read(_ url: URL, chosen: Bool = false) -> (message: JSONObject, kind: String, bytes: Int, isTheme: Bool) {
        let a = ThemesCore.call(["type": "read", "path": url.path, "chosen": chosen])
        let message = a["message"] as? JSONObject ?? ["type": "themeFile", "error": "Margin couldn’t read what you chose."]
        return (message, a["kind"] as? String ?? "refused", int(a["bytes"]) ?? 0, a["chosen"] as? Bool != false)
    }
}

// The built-in themes' packages Margin.app carries for its own window (scripts/build.ts BUILTIN_THEMES: theme.<id>.json
// beside the window's page in Resources/app/), each the `theme` message's JSON ({ id, manifest, html, css, files }).
// The page has only Arcadia of its own; the others came only from a browser's copy, so a built-in chosen in Margin's own
// Settings never reached its window (2026-11-19). Read once each, kept (the core's BuiltinThemes, which knows the
// built-ins and Neubrutalism's earlier name).
@MainActor
final class BuiltinThemes {
    let root: URL?
    private var core: OpaquePointer?

    init(root: URL?) {
        self.root = root
        core = KeysCore.bytes(root?.path ?? "") { margin_builtin_themes_new($0, $1) }
    }

    deinit { margin_builtin_themes_free(core) }

    // The package's JSON, nil: not a built-in, or its file missing or not a package of that id.
    func message(_ chosen: String) -> String? {
        KeysCore.bytes(chosen) { p, n in ThemesCore.text { margin_builtin_themes_message(core, p, n, $0) } }
    }
}
