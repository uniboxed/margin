// A live cover must not suspend the destination's real `framed` acknowledgement.
// This per-view lease changes no process/shared preferences and retains no view.
import Foundation
import ObjectiveC
import WebKit

struct CoverPresentationIO {
    var reason: String?
    var read: (AnyObject) -> Bool?
    var write: (AnyObject, Bool) -> Bool

    static let getter = "_windowOcclusionDetectionEnabled"
    static let setter = "_setWindowOcclusionDetectionEnabled:"
    static func accepts(get: String?, set: String?) -> Bool {
        (get == "B16@0:8" && set == "v20@0:8B16") || (get == "c16@0:8" && set == "v20@0:8c16")
    }

    static func real() -> Self {
        func off(_ why: String) -> Self { Self(reason: why, read: { _ in nil }, write: { _, _ in false }) }
        guard ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] == nil else { return off("refused under app tests") }
        let get = NSSelectorFromString(getter), set = NSSelectorFromString(setter)
        guard let gm = class_getInstanceMethod(WKWebView.self, get), let sm = class_getInstanceMethod(WKWebView.self, set) else { return off("WebKit occlusion selectors missing") }
        let ge = method_getTypeEncoding(gm).map { String(cString: $0) }, se = method_getTypeEncoding(sm).map { String(cString: $0) }
        guard accepts(get: ge, set: se) else { return off("WebKit occlusion encodings changed") }
        // BOOL is one byte for both checked encodings; setters receive 0 or 1.
        typealias Get = @convention(c) (AnyObject, Selector) -> UInt8
        typealias Set = @convention(c) (AnyObject, Selector, UInt8) -> Void
        let read = unsafeBitCast(method_getImplementation(gm), to: Get.self)
        let write = unsafeBitCast(method_getImplementation(sm), to: Set.self)
        return Self(reason: nil, read: { view in
            guard view is WKWebView else { return nil }
            return read(view, get) != 0
        }, write: { view, value in
            guard view is WKWebView else { return false }
            write(view, set, value ? 1 : 0)
            return true
        })
    }
}

final class CoverPresentation {
    private final class Held {
        weak var view: AnyObject?
        let original: Bool
        init(_ view: AnyObject, _ original: Bool) { self.view = view; self.original = original }
    }
    private let io: CoverPresentationIO
    private var held: [ObjectIdentifier: Held] = [:]
    var reason: String? { io.reason }
    var count: Int { held.count }
    init(io: CoverPresentationIO) { self.io = io }

    func hold(_ view: AnyObject) -> Bool {
        guard io.reason == nil else { return false }
        let id = ObjectIdentifier(view)
        if held[id]?.view === view { return true }
        guard let original = io.read(view) else { return false }
        held[id] = Held(view, original)
        if !original { return true } // already opted out: preserve that value
        guard io.write(view, false), io.read(view) == false else {
            if io.write(view, original), io.read(view) == original { held[id] = nil }
            return false
        }
        return true
    }

    @discardableResult func restore() -> Bool {
        var ok = true
        var remaining: [ObjectIdentifier: Held] = [:]
        for (id, entry) in held {
            guard let view = entry.view else { continue }
            if io.read(view) == entry.original { continue }
            let sent = io.write(view, entry.original)
            if !sent || io.read(view) != entry.original { ok = false; remaining[id] = entry }
        }
        held = remaining // a failed restoration must not forget the surviving view's original value
        return ok
    }
}
