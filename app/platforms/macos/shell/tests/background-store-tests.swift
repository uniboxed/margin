// Spaces' pictures (M2.9 step 7, docs/SPACE-BACKGROUNDS.md Part B §7; BackgroundStore.swift over margin-core's
// data::backgrounds): what the person chose made a picture Margin keeps by ImageIO (upright, at most 3840 on its long
// side, smaller ones as they are, encoded again with none of its metadata: a JPEG, or a PNG with transparency), kept by
// the core by its bytes (refused when it's no picture ImageIO reads, or too large), found by its id alone, the ones no
// space names removed as the library opens, and served to Margin's page by the scheme's `/background/<id>`.

import AppKit
import ImageIO
import UniformTypeIdentifiers
import WebKit

/// A picture of w × h, `alpha` with transparency, encoded as `type`, with `props` (EXIF, GPS, orientation) in it.
private func picture(_ w: Int, _ h: Int, type: UTType, alpha: Bool = false, props: [CFString: Any] = [:]) -> Data {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(CGColor(red: 0.9, green: 0.3, blue: 0.2, alpha: alpha ? 0.5 : 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    // (A different colour along its top: where "up" is, after the orientation's turn.)
    ctx.setFillColor(CGColor(red: 0.1, green: 0.2, blue: 0.9, alpha: 1))
    ctx.fill(CGRect(x: 0, y: h - max(1, h / 10), width: w, height: max(1, h / 10)))
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, props as CFDictionary)
    CGImageDestinationFinalize(dest)
    return out as Data
}

private func read(_ data: Data) -> (type: String, w: Int, h: Int, props: [CFString: Any])? {
    guard let s = CGImageSourceCreateWithData(data as CFData, nil), let type = CGImageSourceGetType(s) as String?,
          let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
          let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int else { return nil }
    return (type, w, h, p)
}

@MainActor func backgroundStoreTests() {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-backgrounds-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = BackgroundStore(root: root)
    check("pictures: the core's limits", store.maxSide == 3840 && store.maxBytes == 10 * 1024 * 1024 && store.maxInputBytes == 40 * 1024 * 1024,
          "\(store.maxSide) \(store.maxBytes) \(store.maxInputBytes)")

    // A photo with a place and a camera in it: made a JPEG with neither.
    let exif: [CFString: Any] = [
        kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 51.5, kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitude: 0.12, kCGImagePropertyGPSLongitudeRef: "W"],
        kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "Camera", kCGImagePropertyTIFFModel: "Model"],
        kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "a private note"],
    ]
    let photo = picture(1200, 800, type: .jpeg, props: exif)
    check("pictures: the test's photo has a place in it", (read(photo)?.props[kCGImagePropertyGPSDictionary] as? [CFString: Any])?.isEmpty == false)
    let made = BackgroundStore.prepare(photo, maxSide: 3840, maxBytes: store.maxBytes)
    let m = made.flatMap(read)
    check("pictures: a photo made a JPEG, its size kept", m?.type == UTType.jpeg.identifier && m?.w == 1200 && m?.h == 800, "\(String(describing: m.map { ($0.type, $0.w, $0.h) }))")
    check("pictures: none of its metadata (no place, no camera, no note)", m.map { $0.props[kCGImagePropertyGPSDictionary] == nil && ($0.props[kCGImagePropertyTIFFDictionary] as? [CFString: Any])?[kCGImagePropertyTIFFMake] == nil && ($0.props[kCGImagePropertyExifDictionary] as? [CFString: Any])?[kCGImagePropertyExifUserComment] == nil } == true)

    // Large: at most 3840 on its long side; small: as it is (never made larger).
    let large = BackgroundStore.prepare(picture(5000, 2500, type: .png), maxSide: 3840, maxBytes: store.maxBytes).flatMap(read)
    check("pictures: a large one at most 3840 on its long side, its shape kept", large?.w == 3840 && large?.h == 1920, "\(String(describing: large.map { ($0.w, $0.h) }))")
    let small = BackgroundStore.prepare(picture(40, 30, type: .png), maxSide: 3840, maxBytes: store.maxBytes).flatMap(read)
    check("pictures: a small one as it is", small?.w == 40 && small?.h == 30)
    // Turned upright: a picture stored sideways (orientation 6: turned a quarter clockwise to show it) comes out as shown.
    let sideways = BackgroundStore.prepare(picture(600, 400, type: .jpeg, props: [kCGImagePropertyOrientation: 6]), maxSide: 3840, maxBytes: store.maxBytes).flatMap(read)
    check("pictures: turned upright by its orientation", sideways?.w == 400 && sideways?.h == 600 && (sideways?.props[kCGImagePropertyOrientation] as? Int ?? 1) == 1,
          "\(String(describing: sideways.map { ($0.w, $0.h, $0.props[kCGImagePropertyOrientation] ?? "none") }))")
    // Transparency kept: a PNG; HEIC read (an iPhone's photos).
    let clear = BackgroundStore.prepare(picture(300, 200, type: .png, alpha: true), maxSide: 3840, maxBytes: store.maxBytes).flatMap(read)
    check("pictures: one with transparency made a PNG", clear?.type == UTType.png.identifier)
    let heic = picture(320, 240, type: .heic)
    if !heic.isEmpty {
        let h = BackgroundStore.prepare(heic, maxSide: 3840, maxBytes: store.maxBytes).flatMap(read)
        check("pictures: HEIC read, made a JPEG", h?.type == UTType.jpeg.identifier && h?.w == 320)
    }
    // Refused before it's decoded: no picture, a kind Margin doesn't read (GIF, a PDF), nothing.
    check("pictures: not a picture: refused", BackgroundStore.prepare(Data("hello".utf8), maxSide: 3840, maxBytes: store.maxBytes) == nil)
    check("pictures: a GIF: refused", BackgroundStore.prepare(picture(20, 20, type: .gif), maxSide: 3840, maxBytes: store.maxBytes) == nil)
    check("pictures: nothing: refused", BackgroundStore.prepare(Data(), maxSide: 3840, maxBytes: store.maxBytes) == nil)
    // Too large to fit at any of its sizes: refused, not kept larger.
    check("pictures: one that can't fit the store: refused", BackgroundStore.prepare(picture(1200, 800, type: .png), maxSide: 3840, maxBytes: 100) == nil)

    // Kept by the core, found by its id alone, refused as the page hears it.
    let kept = store.keep(photo)
    let id = kept["id"] as? String ?? ""
    check("pictures: kept, its id its bytes' hash", id.count == 64 && id.allSatisfy { $0.isHexDigit && !$0.isUppercase }, "\(kept)")
    let found = store.file(id: id)
    check("pictures: found by its id, a JPEG", found?.mime == "image/jpeg" && found.map { FileManager.default.fileExists(atPath: $0.url.path) } == true)
    check("pictures: the same picture again: the same id", store.keep(photo)["id"] as? String == id)
    check("pictures: what isn't a picture: refused with words for the page", (store.keep(Data("nope".utf8))["refused"] as? String)?.isEmpty == false)
    check("pictures: too large: refused before it's read", (store.keep(Data(count: store.maxInputBytes + 1))["refused"] as? String)?.contains("too large") == true)
    for bad in ["", "..", "../\(id)", id.uppercased(), "\(id).jpg", String(id.dropLast())] {
        check("pictures: not found by \(bad.isEmpty ? "nothing" : "a near id")", store.file(id: bad) == nil)
    }
    // Removed as the library opens when no space names it.
    let other = store.keep(picture(64, 64, type: .png))["id"] as? String ?? ""
    check("pictures: two kept", Set(store.ids()) == [id, other])
    check("pictures: the one no space names removed", store.prune(keep: [id]) == 1 && store.ids() == [id] && store.file(id: other) == nil)

    // Served to Margin's page at `margin-app://app/background/<id>` as the page draws it (an image: the page's policy
    // lets images come from its own place, nothing else), nothing else.
    let site = root.appendingPathComponent("site", isDirectory: true)
    try? FileManager.default.createDirectory(at: site, withIntermediateDirectories: true)
    try? Data("<!doctype html><title>t</title>".utf8).write(to: site.appendingPathComponent("t.html"))
    let pages = OverlayPages(root: site, backgrounds: store)
    let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 100, height: 100), configuration: pages.configuration)
    view.load(URLRequest(url: URL(string: "margin-app://app/t.html")!))
    var loaded = false
    let until = Date().addingTimeInterval(10)
    while !loaded, Date() < until {
        view.evaluateJavaScript("document.readyState === 'complete' && document.title === 't'") { v, _ in loaded = (v as? Bool) == true }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    var results: [String] = []
    var done = false
    let probe = """
    const load = (p) => new Promise((r) => { const i = new Image(); i.onload = () => r('ok:' + i.naturalWidth); i.onerror = () => r('error'); i.src = p; });
    return [await load('/background/\(id)'), await load('/background/\(other)'), await load('/background/%2E%2E%2Ft.html'), await load('/background/\(id)?x=1')];
    """
    view.callAsyncJavaScript(probe, arguments: [:], in: nil, in: .page) { result in
        if case .success(let v) = result, let list = v as? [String] { results = list }
        done = true
    }
    let end = Date().addingTimeInterval(10)
    while !done, Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    check("pictures: the page loaded from Margin's scheme", loaded)
    check("pictures: served by its id, drawn as the picture", results.first == "ok:1200", "\(results)")
    check("pictures: one removed: not served", results.count > 1 && results[1] == "error", "\(results)")
    check("pictures: a path made of the address, or a query: not served", results.count > 3 && results[2] == "error" && results[3] == "error", "\(results)")
}
