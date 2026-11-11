// Optional resource optimization for owned Margin pages only. Missing/changed
// WebKit SPI keeps the existing isolated cover; it never relaxes readiness.
import Foundation
import ObjectiveC
import WebKit

struct CoverRendererIO {
    var reason: String?
    var relate: (WKWebViewConfiguration, WKWebView) -> Bool
    var process: (WKWebView) -> pid_t?

    static let getter = "_relatedWebView", setter = "_setRelatedWebView:"
    static let pidGetter = "_webProcessIdentifier"
    static func accepts(get: String?, set: String?, pid: String?) -> Bool {
        get == "@16@0:8" && set == "v24@0:8@16" && pid == "i16@0:8"
    }
    static func real() -> Self {
        func off(_ why: String) -> Self { Self(reason: why, relate: { _, _ in false }, process: { _ in nil }) }
        guard ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] == nil else { return off("app tests") }
        let get = NSSelectorFromString(getter), set = NSSelectorFromString(setter), pid = NSSelectorFromString(pidGetter)
        guard let gm = class_getInstanceMethod(WKWebViewConfiguration.self, get),
              let sm = class_getInstanceMethod(WKWebViewConfiguration.self, set),
              let pm = class_getInstanceMethod(WKWebView.self, pid) else { return off("selectors unavailable") }
        func encoding(_ method: Method) -> String? { method_getTypeEncoding(method).map { String(cString: $0) } }
        guard accepts(get: encoding(gm), set: encoding(sm), pid: encoding(pm)) else { return off("encodings changed") }
        typealias Get = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
        typealias Set = @convention(c) (AnyObject, Selector, AnyObject?) -> Void
        typealias Pid = @convention(c) (AnyObject, Selector) -> Int32
        let read = unsafeBitCast(method_getImplementation(gm), to: Get.self)
        let write = unsafeBitCast(method_getImplementation(sm), to: Set.self)
        let process = unsafeBitCast(method_getImplementation(pm), to: Pid.self)
        return Self(reason: nil, relate: { configuration, view in
            // WebKit throws for different stores. Never make that call, and
            // never modify the common configuration or the source view.
            guard configuration.websiteDataStore === view.configuration.websiteDataStore else { return false }
            write(configuration, set, view)
            return read(configuration, get)?.takeUnretainedValue() === view
        }, process: { view in
            let value = process(view, pid)
            return value > 0 ? value : nil
        })
    }
}

final class CoverRenderer {
    private let io: CoverRendererIO
    private weak var anchor: WKWebView?
    private(set) var detail = "none"
    init(io: CoverRendererIO = .real()) { self.io = io }

    func configuration(base: WKWebViewConfiguration, views: [WKWebView]) -> WKWebViewConfiguration? {
        anchor = nil
        detail = "isolated"
        guard io.reason == nil else { detail = "isolated (\(io.reason!))"; return nil }
        // No browser page, unready layout, foreign data store or foreign bridge
        // can become the cover's related page. Documents still have no opener.
        guard let source = views.first(where: {
            $0.url == OverlaySchemeHandler.page && !$0.isLoading
                && $0.configuration.websiteDataStore === base.websiteDataStore
                && $0.configuration.userContentController === base.userContentController
                && io.process($0) != nil
        }), let copy = source.configuration.copy() as? WKWebViewConfiguration,
              io.relate(copy, source) else { return nil }
        // WebKit also requires the related page's process pool. Copy that
        // owned page configuration rather than reconstructing its compatibility.
        anchor = source
        detail = "pending"
        return copy
    }

    func prepared(_ view: WKWebView) {
        guard detail == "pending" else { return }
        guard let source = anchor, let sourcePID = io.process(source), io.process(view) == sourcePID else {
            detail = "isolated (framework process policy)"; return
        }
        detail = "shared"
    }
    func detach() { anchor = nil }
}
