// The hosted parts joined in the shell (HostedSession.swift; docs/MARGIN-APP.md), behind `MarginHosted`
// (Shell.Options.hosted). Off, nothing here runs.
//
// - Margin's windows draw the library (LibraryWindowSource) once it opened; the read-only stand-in
//   (DataSetWindowSource) only when it didn't (its rules didn't load), and for the settings either way.
// - The library's requests go to the session, which drives the host engine and the Safari copies' tabs; the engine's
//   Safari window requests are the copies' (`newWindow`, `closeWindow`, after their link); its events tell the session
//   what went outside Margin; a palette pick (`openApp`) is the session's.
// - The overlay path is off: with `hosted`, the shell's read of the window server does no binding, no overlay, no
//   `drawn` and no layout for any browser window (`hostedTrack`), the slot and opening the browser are off (forApp);
//   the copies stay linked as the tabs' drivers. It polls the host instead.
// - The first run with nothing in the library (no profile's set to import): one space made, Personal, and shown in
//   the UI's own space editor as the window's page is drawn, for the person to name (the minimal first-run step;
//   the UI has no create-spaces flow of its own).

import AppKit

// The shell's links, as the session asks the Safari copies.
final class ShellHostedLinks: HostedLinks {
    weak var shell: Shell?
    init(shell: Shell) { self.shell = shell }

    func safariProfiles() -> [String] {
        guard let shell else { return [] }
        return shell.links.values.filter { $0.connection.isUp && $0.connection.hello.browser == "safari" }.map(\.connection.hello.profile).sorted()
    }

    func request(profile: String, _ type: String, _ payload: JSONObject) async -> (result: JSONObject?, error: String?) {
        guard let entry = shell?.links["safari:\(profile)"], entry.connection.isUp else { return (nil, "not linked") }
        do {
            let reply = try await entry.connection.request(type: type, payload: payload, windowId: nil)
            guard reply["ok"] as? Bool == true else { return (nil, Diagnostics.scrub(reply["error"] as? String ?? "refused", max: 160)) }
            return (reply["result"] as? JSONObject ?? [:], nil)
        } catch {
            return (nil, "\(error)")
        }
    }
}

// No engine (its private calls didn't pass): every show fails, said once by the session's log.
final class NoHostEngine: HostedEngine {
    func open(app target: HostTarget, in pageRect: CGRect, marginWindow: Int, marginSpace: UInt64) async -> HostResult { .failed(.margin, "the host engine is off (its calls didn't pass their check)") }
    func show(_ id: HostID) async -> HostResult { .failed(.margin, "the host engine is off") }
    func close(_ id: HostID) async {}
    func pageRectChanged(_ rect: CGRect) async -> Bool { false }
    var shown: HostID? { nil }
    var hasHosts: Bool { false }
    func isHosted(_ id: HostID) -> Bool { false }
    func fullScreenSpace(ofWindow number: Int) -> UInt64? { nil }
    func target(ofWindow number: Int) -> HostTarget? { nil }
}

extension Shell {
    // The source Margin's windows draw, and the session that hosts what they show: the library's, made once.
    func makeHostedSource() -> MarginWindowSource {
        let profiles = DataSetWindowSource(data: data, pick: { [weak self] in self?.hostedProfile() })
        guard let library else {
            Diagnostics.note("Margin's window: no library (its rules didn't load): a profile's spaces, read only")
            return profiles
        }
        let engine: HostedEngine = host ?? NoHostEngine()
        let session = HostedSession(library: library, engine: engine, links: ShellHostedLinks(shell: self), options: options.hostedOptions ?? HostedSession.Options())
        if let name = UserDefaults.standard.string(forKey: "MarginHostedSafari"), !options.harness { session.options.safariBundles.insert(name) }
        session.appName = { [weak self] id in self?.installedAppName(id) }
        library.delegate = session
        hosted = session
        if let host {
            host.requestSafariWindow = { [weak session] profile in await session?.requestSafariWindow(profile) ?? false }
            host.closeSafariWindow = { [weak session] number in await session?.closeSafariWindow(number) ?? false }
            host.safariLinked = { [weak session] profile in await session?.safariLinked(profile) ?? false }
            let before = host.onEvent
            host.onEvent = { [weak session] event in
                before?(event)
                session?.hostEvent(event)
            }
        }
        openApp = { [weak session] id in session?.openApp(id, windowId: nil) }
        // The first run, nothing imported: a space to start in, named by the person in the UI's editor.
        if library.spaces().isEmpty {
            let out = library.perform("createSpace", ["name": "Personal", "emoji": "🏠", "color": "#6c5ce7"])
            session.firstSpace = (out.result as? JSONObject)?["spaceId"] as? String
            Diagnostics.note("hosted: the library is empty (nothing imported): a first space made, for the person to name")
        }
        Diagnostics.note("Margin's window: the library's \(library.spaces().count) space(s), \(library.items().count) item(s); hosting \(host == nil ? "off (no host engine)" : "on")")
        return LibraryWindowSource(library: library, session: session, profileSource: profiles)
    }

    // Margin's windows joined to the session: which window is which, their page areas, the first run's editor.
    func joinHosted(_ windows: MarginWindows) {
        guard let session = hosted else { return }
        session.window = { [weak windows] id in
            guard let windows else { return nil }
            if let id { return windows.controllers.first { $0.id == id } }
            return windows.front
        }
        windows.onPageRect = { [weak session] controller, rect in session?.pageRectChanged(controller, rect) }
        windows.onReady = { [weak session] controller in
            guard let session, let space = session.firstSpace else { return }
            session.firstSpace = nil
            controller.push(#"{"type":"command","name":"edit-space","spaceId":"# + (jsonString(space) ?? "\"\"") + "}")
        }
        windows.onLeftFullScreen = { [weak session] controller in session?.leftFullScreen(controller) }
        windows.apps = { [weak self] in self?.appsJSON ?? "null" }
    }

    // The installed app's name as the catalog read it (Finder's).
    func installedAppName(_ bundleId: String) -> String? {
        guard let json = appsJSON, let list = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [JSONObject] else { return nil }
        return list.first { $0["bundleId"] as? String == bundleId }?["name"] as? String
    }

    // The shell's read while hosted: none of the overlay path (no binding, overlay, `drawn`, layout or slot for any
    // browser window); the host's poll, while it hosts something or a copy is linked.
    func hostedTrack() {
        host?.poll()
        guard host?.hasHosts == true || !links.isEmpty else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: options.restPoll, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
    }
}
