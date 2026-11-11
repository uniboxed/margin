// Owned/off-screen actual shared-WebContent crash and production delegate recovery.
// No browser, cover activation, Space mutation or physical-display surface.
import AppKit
import WebKit

@MainActor final class CrashProbeDelegate: OverlayDelegate {
    let helloText: String
    var events: [[String: Any]] = []
    init(_ hello: String) { helloText = hello }
    func note(_ name: String, _ fields: [String: Any] = [:]) {
        var row = fields; row["event"] = name; row["t"] = ProcessInfo.processInfo.systemUptime
        events.append(row)
        if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
    }
    func hello(for overlay: OverlayController) -> String { helloText }
    func send(from overlay: OverlayController, type: String, payload: JSONObject) async throws -> JSONObject { throw LinkError.down }
    func layoutChanged(_ overlay: OverlayController, _ layout: PageLayout) {}
    func overlayChanged(_ overlay: OverlayController, _ why: String) { note("actual-overlay-delegate", ["key": overlay.key.description, "why": why, "ready": overlay.isReady]) }
    func perform(from overlay: OverlayController, _ name: String, _ arg: Any?) {}
    func framed(_ overlay: OverlayController, mode: OverlayFramed.Mode) {}
    func shownSpace(_ overlay: OverlayController, _ said: JSONObject) {}
    func crashes(_ key: WindowKey) -> Int { events.filter { $0["event"] as? String == "actual-overlay-delegate" && $0["key"] as? String == key.description && $0["why"] as? String == "page crashed" }.count }
}

@MainActor final class CrashProbeViews {
    weak var cover: WKWebView?
    var original: Bool?
    var restorationReadBack = false
    var emergencies = 0
}

@main enum SharedRendererCrashProbe {
    @MainActor static func value(_ name: String) -> String? {
        guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[i + 1]
    }
    @MainActor static func until(_ seconds: Double, _ predicate: () -> Bool) async -> Bool {
        let end = ProcessInfo.processInfo.systemUptime + seconds
        while !predicate(), ProcessInfo.processInfo.systemUptime < end { try? await Task.sleep(nanoseconds: 10_000_000) }
        return predicate()
    }
    @MainActor static func js(_ view: WKWebView, _ script: String) async -> Any? {
        var finished = false, answer: Any?
        view.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            if case .success(let value) = result { answer = value }
            finished = true
        }
        guard await until(2, { finished }) else { return nil }
        return answer
    }
    @MainActor static func outside(_ windows: [NSWindow], requireListed: Set<Int> = []) -> Bool {
        let displays = NSScreen.screens.map(\.frame)
        guard !displays.isEmpty, windows.allSatisfy({ window in !displays.contains(where: { $0.intersects(window.frame) }) }) else { return false }
        for window in windows {
            guard let number = UInt32(exactly: window.windowNumber) else { if requireListed.contains(window.windowNumber) { return false }; continue }
            guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, number) as? [[String: Any]] else { return false }
            if let row = rows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == window.windowNumber }) {
                guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == ProcessInfo.processInfo.processIdentifier,
                      (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue == 0,
                      let raw = row[kCGWindowBounds as String] as? NSDictionary,
                      let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary),
                      !ScreenGeometry.displayFrames.contains(where: { $0.frame.intersects(bounds) }) else { return false }
            } else if requireListed.contains(window.windowNumber) { return false }
        }
        return true
    }
    @MainActor static func run(root: URL, hello: String, python: String, killer: String, receipt: String) async -> Bool {
        let observer = CrashProbeDelegate(hello)
        let pages = OverlayPages(root: root)
        let settings = CoverPresentationIO.real(), sharing = CoverRendererIO.real()
        guard settings.reason == nil, sharing.reason == nil else { observer.note("not-measured", ["reason": "real presentation/renderer SPI unavailable"]); return false }
        var options = OverlayController.Options()
        options.harness = true; options.edgeWidth = 0
        let ka = WindowKey(link: "safari:owned-crash-A", windowId: 7), kb = WindowKey(link: "safari:owned-crash-B", windowId: 8)
        let a = OverlayController(pages: pages, key: ka, options: options)
        let b = OverlayController(pages: pages, key: kb, options: options)
        a.delegate = observer; b.delegate = observer
        let panels: [NSWindow] = [a.panel, b.panel, a.catcher, b.catcher]
        let outer = CoverPresentation(io: settings)
        var native: NativeHandoffCover?
        defer {
            _ = native?.end(.failed)
            _ = outer.restore()
            a.close(); b.close()
        }
        // No OverlayController.show call. Only alpha-zero, independently checked
        // off-screen source windows are ordered so held WebKit pages can render.
        a.panel.alphaValue = 0; b.panel.alphaValue = 0
        a.catcher.alphaValue = 0; b.catcher.alphaValue = 0
        guard outside(panels), let originalA = settings.read(a.webView), let originalB = settings.read(b.webView),
              outer.hold(a.webView), outer.hold(b.webView) else { return false }
        a.panel.orderFrontRegardless(); b.panel.orderFrontRegardless(); CATransaction.flush()
        guard outside(panels, requireListed: [a.panel.windowNumber, b.panel.windowNumber]), pages.bridge.registrationCount == 2 else { return false }
        a.load(); b.load()
        guard await until(6, { a.isReady && b.isReady }), outside(panels),
              let pa = sharing.process(a.webView), let pb = sharing.process(b.webView), pa != pb else {
            observer.note("not-measured", ["reason": "source readiness/separate own WebContent control unavailable"]); return false
        }
        guard let ta = await js(a.webView, "window.__ownedCrashMark='A'; return performance.timeOrigin;") as? Double,
              let tb = await js(b.webView, "window.__ownedCrashMark='B'; return performance.timeOrigin;") as? Double else { return false }
        let captured = CrashProbeViews()
        let inner = CoverPresentation(io: CoverPresentationIO(reason: settings.reason, read: { view in
            let value = settings.read(view)
            if let view = view as? WKWebView, view !== a.webView, view !== b.webView {
                captured.cover = view
                if captured.original == nil { captured.original = value }
            }
            return value
        }, write: { view, value in
            let sent = settings.write(view, value)
            if let cover = captured.cover, view === cover, value == captured.original {
                captured.restorationReadBack = sent && settings.read(view) == captured.original
            }
            return sent
        }))
        // A prepared cover must never reach any Space callback. No real Space IO
        // is installed; the entire lifecycle below is prepare/end only.
        let noSpaces = LiveCoverSpaceIO(owns: { _ in false }, create: { nil }, level: { _ in false }, readLevel: { _ in nil },
            add: { _, _ in false }, show: { _ in false }, hide: { _ in false }, hideWindow: { _ in false }, destroy: { _ in false }, spaces: { _ in nil })
        let cover = NativeHandoffCover(pages: pages, io: noSpaces, presentation: inner,
                                      layoutViews: { [a.webView, b.webView] }, renderer: CoverRenderer(io: sharing))
        native = cover
        cover.onEmergency = { [weak cover] in captured.emergencies += 1; observer.note("actual-native-emergency", ["audit": cover?.validationStatus ?? "released"]) }
        let frame = CGRect(x: -20000, y: -20000, width: 800, height: 600)
        cover.prepare(LiveCoverContext(hello: hello, display: frame, viewport: CGRect(origin: .zero, size: frame.size)))
        guard await until(4, { cover.state == .prepared }), cover.validationStatus.contains("renderer shared"),
              pages.bridge.registrationCount == 3, let pc = captured.cover.flatMap({ sharing.process($0) }), pc == pa, pc != pb,
              outside(panels) else { return false }
        let coverWindows = Array(cover.windowNumbers)
        let ownCoverPanels = NSApp.windows.filter { cover.windowNumbers.contains($0.windowNumber) }
        guard ownCoverPanels.count == 1, outside(panels + ownCoverPanels), await isolatedCover(captured) else { return false }
        observer.note("shared-prepared", ["sourceA": pa, "sourceB": pb, "cover": pc, "registrations": pages.bridge.registrationCount,
                                           "sourceATimeOrigin": ta, "sourceBTimeOrigin": tb, "docIsolation": true])
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = [killer, "--kill-webcontent", "--go", "--owner", String(ProcessInfo.processInfo.processIdentifier),
                             "--target", String(pa), "--receipt", receipt]
        do { try process.run() } catch { return false }
        guard await until(3, { !process.isRunning }), process.terminationReason == .exit, process.terminationStatus == 0 else {
            if process.isRunning { process.terminate() }
            observer.note("guarded-kill-refused"); return false
        }
        guard await until(7, { captured.emergencies == 1 && a.isReady && sharing.process(a.webView) != pa
            && cover.state == .failed("page process ended") && pages.bridge.registrationCount == 2 }),
              let newPA = sharing.process(a.webView), newPA != pa, observer.crashes(ka) == 1, observer.crashes(kb) == 0,
              sharing.process(b.webView) == pb, outside(panels), !a.isShown, !b.isShown,
              settings.read(a.webView) == false, settings.read(b.webView) == false, captured.restorationReadBack else { return false }
        guard let newTA = await js(a.webView, "return performance.timeOrigin;") as? Double, newTA != ta,
              let newTB = await js(b.webView, "return performance.timeOrigin;") as? Double, newTB == tb,
              await js(b.webView, "return window.__ownedCrashMark;") as? String == "B" else { return false }
        let audit = cover.validationStatus
        guard audit.contains("windows 0, views 0, spaces 0, presentation 0, timers 0, cleanup failures 0; created 1, disposed 1,"),
              outer.restore(), outer.count == 0, settings.read(a.webView) == originalA, settings.read(b.webView) == originalB else { return false }
        observer.note("recovered", ["sourceANewPID": newPA, "sourceANewTimeOrigin": newTA, "sourceBUnchanged": true,
                                    "registrations": pages.bridge.registrationCount, "audit": audit])
        return await finishWeak(captured, cover: cover, a: a, b: b, pages: pages, observer: observer, coverWindows: coverWindows)
    }

    @MainActor static func isolatedCover(_ captured: CrashProbeViews) async -> Bool {
        guard let view = captured.cover else { return false }
        return await js(view, "return window.opener===null && typeof window.__ownedCrashMark==='undefined';") as? Bool == true
    }

    @MainActor static func finishWeak(_ captured: CrashProbeViews, cover: NativeHandoffCover, a: OverlayController, b: OverlayController,
                                      pages: OverlayPages, observer: CrashProbeDelegate, coverWindows: [Int]) async -> Bool {
        guard await until(3, { captured.cover == nil }) else { observer.note("cover-view-retained"); return false }
        let numbers = [a.panel, b.panel, a.catcher, b.catcher].compactMap { UInt32(exactly: $0.windowNumber) }
            + coverWindows.compactMap(UInt32.init(exactly:))
        a.close(); b.close()
        guard pages.bridge.registrationCount == 0 else { return false }
        let gone = await until(2, {
            numbers.allSatisfy { number in
                guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, number) as? [[String: Any]] else { return false }
                return !rows.contains { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == number }
            }
        })
        observer.note("final", ["ok": gone, "weakCoverGone": captured.cover == nil, "registrations": pages.bridge.registrationCount,
                                "emergencies": captured.emergencies, "audit": cover.validationStatus])
        return gone
    }

    @MainActor static func main() {
        guard CommandLine.arguments.contains("--go") else {
            print("DRY RUN: no NSApplication/window/kill/private write. --go prepares owned alpha0 offscreen OverlayController A/B and Native cover only; guarded Python child may SIGKILL exact own shared WebContent, then actual production delegates/reload/cleanup are verified. No Native.activate, browser or Space mutation.")
            return
        }
        guard ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] == nil,
              let root = value("--root"), let path = value("--hello"), let hello = try? String(contentsOfFile: path, encoding: .utf8),
              let python = value("--python"), let killer = value("--killer"), let receipt = value("--receipt") else { exit(2) }
        let app = NSApplication.shared; app.setActivationPolicy(.accessory)
        Task { @MainActor in
            let ok = await run(root: URL(fileURLWithPath: root), hello: hello, python: python, killer: killer, receipt: receipt)
            exit(ok ? 0 : 1)
        }
        app.run()
    }
}
