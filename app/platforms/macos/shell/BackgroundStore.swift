// Pictures as space backgrounds (M2.9 step 7, docs/SPACE-BACKGROUNDS.md Part B §7), kept beside Margin.app's library
// (`~/Library/Application Support/Margin/data/app/backgrounds/`). The rules are margin-core's `data::backgrounds`
// (app/shared/core/src/data/backgrounds.rs, the one copy, the Windows shell's too), through margin-ffi's backgrounds
// object: a picture kept by its bytes' SHA-256, checked again there (a JPEG or a PNG by its signature, its size and
// sides), served to Margin's page by id alone (OverlayWebView.swift's `/background/<id>`), and the ones no space names
// removed as the library opens. This keeps the Mac's side:
// - what the person chose, read within MAX_INPUT_BYTES, and made a picture Margin keeps by ImageIO (`prepare`):
//   decoded (JPEG, PNG, HEIC, WebP, TIFF), turned upright by its orientation, at most MAX_SIDE on its long side (never
//   made larger), and encoded again (JPEG; PNG when it has transparency), none of its metadata (EXIF, GPS) copied;
// - the file picker (`choose`), as a theme's import has it (ShellThemes.swift), and a test's stand-in for it (`pick`).
// Never logs names, paths or content.

import AppKit
import ImageIO
import MarginCore
import UniformTypeIdentifiers

final class BackgroundStore {
    let root: URL
    private let core: OpaquePointer?
    // The harness's stand-in for the picker: what the person "chose" (nil: cancelled).
    var pick: (() -> URL?)?
    private(set) var picking = false

    static func folder(in dataRoot: URL) -> URL { Library.folder(in: dataRoot).appendingPathComponent("backgrounds", isDirectory: true) }

    init(root: URL) {
        self.root = root
        let path = Array(root.path.utf8)
        core = path.withUnsafeBufferPointer { margin_backgrounds_new($0.baseAddress, $0.count) }
    }
    deinit { margin_backgrounds_free(core) }

    // One JSON call to the core's store.
    private func call(_ request: JSONObject) -> JSONObject {
        guard let core else { return ["error": "no store"] }
        return KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_backgrounds_call(core, p, n, $0) } } as? JSONObject ?? [:]
    }
    lazy var constants = call(["type": "constants"])
    var maxBytes: Int { int(constants["maxBytes"]) ?? 10 * 1024 * 1024 }
    var maxSide: Int { int(constants["maxSide"]) ?? 3840 }
    var maxInputBytes: Int { int(constants["maxInputBytes"]) ?? 40 * 1024 * 1024 }

    /// Where a picture is and its type, for an id that's one and a file that's there.
    func file(id: String) -> (url: URL, mime: String)? {
        let answer = call(["type": "path", "id": id])
        guard let path = answer["path"] as? String, let mime = answer["mime"] as? String else { return nil }
        return (URL(fileURLWithPath: path), mime)
    }

    /// Every picture's id kept here.
    func ids() -> [String] { call(["type": "ids"])["ids"] as? [String] ?? [] }

    /// Removes the pictures no space names (as the library opens): how many files went.
    @discardableResult func prune(keep: Set<String>) -> Int { int(call(["type": "prune", "keep": Array(keep)])["removed"]) ?? 0 }

    /// What the person chose, made a picture and kept: `{ id }`, or `{ refused }` with the words for the page.
    func keep(_ data: Data) -> JSONObject {
        guard data.count <= maxInputBytes else { return ["refused": "That picture is too large (over \(maxInputBytes / 1_048_576) MB)."] }
        guard let made = Self.prepare(data, maxSide: maxSide, maxBytes: maxBytes) else { return ["refused": "Margin couldn’t read that picture."] }
        guard let core else { return ["refused": "Margin couldn’t keep that picture."] }
        let answer = made.withUnsafeBytes { raw in
            KeysCore.answer { margin_backgrounds_add(core, raw.bindMemory(to: UInt8.self).baseAddress, raw.count, $0) } as? JSONObject ?? [:]
        }
        if let id = answer["id"] as? String { return ["id": id] }
        return ["refused": "Margin couldn’t keep that picture."]
    }

    /// A file the person chose, read within its cap and kept.
    func keep(file url: URL) -> JSONObject {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        guard size > 0 else { return ["refused": "Margin couldn’t read that picture."] }
        guard size <= maxInputBytes else { return ["refused": "That picture is too large (over \(maxInputBytes / 1_048_576) MB)."] }
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return ["refused": "Margin couldn’t read that picture."] }
        return keep(data)
    }

    // ImageIO's kinds read (what a camera, a phone or the web gives); anything else refused before it's decoded.
    static let readable: Set<String> = [UTType.jpeg, .png, .heic, .heif, .webP, .tiff].map(\.identifier).reduce(into: []) { $0.insert($1) }

    /// A picture Margin keeps from what the person chose (nil: not one ImageIO reads, or nothing made of it): upright,
    /// at most `maxSide` on its long side (smaller ones as they are), encoded again with nothing of the original's
    /// metadata; smaller sides, or a lower quality, until it fits `maxBytes`.
    static func prepare(_ data: Data, maxSide: Int, maxBytes: Int) -> Data? {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options), CGImageSourceGetCount(source) > 0,
              let type = CGImageSourceGetType(source) as String?, readable.contains(type),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
              let w = int(props[kCGImagePropertyPixelWidth]), let h = int(props[kCGImagePropertyPixelHeight]),
              w > 0, h > 0, w <= 65_535, h <= 65_535, w * h <= 200_000_000 else { return nil }
        let long = max(w, h)
        for (side, quality) in [(maxSide, 0.9), (maxSide, 0.8), (2560, 0.85), (1920, 0.85)] {
            let thumb: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: min(side, long),
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumb as CFDictionary) else { return nil }
            // (Transparency as the file says it: a decoded HEIC has an alpha channel even when it's opaque.)
            let alpha = (props[kCGImagePropertyHasAlpha] as? Bool) == true
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, (alpha ? UTType.png : UTType.jpeg).identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(dest, image, alpha ? nil : [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return nil }
            if out.length <= maxBytes { return out as Data }
        }
        return nil
    }

    /// The file picker: a picture (`then` nil: cancelled). Margin is made active for it (its caller gives the keys back).
    func choose(then: @escaping (URL?) -> Void) {
        guard !picking else { return then(nil) }
        if let pick { return then(pick()) }
        picking = true
        let panel = NSOpenPanel()
        panel.title = "Choose a Picture"
        panel.message = "Choose a picture for this space’s background."
        panel.prompt = "Choose"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.image]
        // Over Margin's full-screen window: the panel joins the active Space, above it.
        panel.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
        NSApp.activate()
        panel.begin { [weak self] answer in
            self?.picking = false
            then(answer == .OK ? panel.url : nil)
        }
    }
}
