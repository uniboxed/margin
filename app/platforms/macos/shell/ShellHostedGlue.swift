// The hosted parts joined in the shell (HostedSession.swift; docs/MARGIN-APP.md).
//
// - Margin's windows draw the library (LibraryWindowSource) once it opened; the read-only stand-in
//   (DataSetWindowSource) only when it didn't (its rules didn't load), and for the settings either way.
// - The library's requests go to the session, which drives the host engine and the Safari copies' tabs; the engine's
//   Safari window requests are the copies' (`newWindow`, `setWindowState`, `closeWindow`, after their link); its events tell the session
//   what went outside Margin; a palette pick (`openApp`) is the session's.
// - The copies stay linked as the tabs' drivers; the shell's read (Shell.track) polls the host.
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

    func openProfileWindow(_ profile: String) -> Bool { shell?.openProfileWindow("safari:\(profile)") ?? false }
    func windowIds(of profile: String) -> [Int] { shell?.windows(of: "safari:\(profile)").map(\.id) ?? [] }
    func restoredWindowIds(of profile: String) -> [Int]? {
        guard let entry = shell?.links["safari:\(profile)"], entry.connection.isUp, entry.mirror.hasState else { return nil }
        return ExtWindow.parse(entry.mirror.windows).filter { $0.createdAt == nil }.map(\.id)
    }
    func linkEpoch(of profile: String) -> String? {
        guard let entry = shell?.links["safari:\(profile)"], entry.connection.isUp else { return nil }
        return entry.connection.hello.epoch
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
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult { .failed(.margin, "the host engine is off (its calls didn't pass their check)") }
    func show(_ id: HostID) async -> HostResult { .failed(.margin, "the host engine is off") }
    func close(_ id: HostID) async {}
    func pageRectChanged(_ placement: HostPlacement) async -> Bool { false }
    func parkShown(why: String) async {}
    var shown: HostID? { nil }
    var hasHosts: Bool { false }
    func isHosted(_ id: HostID) -> Bool { false }
    func mode(of id: HostID) -> HostMode? { nil }
    var shownWindow: Int? { nil }
    func activateShown(at point: CGPoint?) async {}
    func fullScreenSpace(ofWindow number: Int) -> UInt64? { nil }
    func target(ofWindow number: Int) -> HostTarget? { nil }
    func launchedPid(bundleId: String) -> pid_t? { nil }
}

// The engine as the session sees it: the shell's at the time of each call (it may start after the session is made),
// the stand-in that fails every show while there is none.
final class LateHostEngine: HostedEngine {
    let resolve: () -> HostEngine?
    private let none = NoHostEngine()
    init(_ resolve: @escaping () -> HostEngine?) { self.resolve = resolve }
    private var engine: HostedEngine { resolve() ?? none }
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult {
        await engine.open(app: target, in: placement, marginWindow: marginWindow, marginSpace: marginSpace)
    }
    func show(_ id: HostID) async -> HostResult { await engine.show(id) }
    func close(_ id: HostID) async { await engine.close(id) }
    func pageRectChanged(_ placement: HostPlacement) async -> Bool { await engine.pageRectChanged(placement) }
    func parkShown(why: String) async { await engine.parkShown(why: why) }
    var shown: HostID? { engine.shown }
    var hasHosts: Bool { engine.hasHosts }
    func isHosted(_ id: HostID) -> Bool { engine.isHosted(id) }
    func mode(of id: HostID) -> HostMode? { engine.mode(of: id) }
    var shownWindow: Int? { engine.shownWindow }
    func activateShown(at point: CGPoint?) async { await engine.activateShown(at: point) }
    func fullScreenSpace(ofWindow number: Int) -> UInt64? { engine.fullScreenSpace(ofWindow: number) }
    func target(ofWindow number: Int) -> HostTarget? { engine.target(ofWindow: number) }
    func launchedPid(bundleId: String) -> pid_t? { resolve()?.launchedPid(bundleId: bundleId) }
    var preparesOutOfSight: Bool { resolve()?.preparesOutOfSight ?? false }
    func start(bundleId: String) async -> HostApp? { await resolve()?.start(bundleId: bundleId) }
    func prepare(_ target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult {
        await engine.prepare(target, in: placement, marginWindow: marginWindow, marginSpace: marginSpace)
    }
    func hideWoken(bundleId: String) { resolve()?.hideWoken(bundleId: bundleId) }
    func stopHidingWoken(bundleId: String) { resolve()?.stopHidingWoken(bundleId: bundleId) }
    func releaseWoken(bundleId: String) { resolve()?.releaseWoken(bundleId: bundleId) }
    func wokenWindows(bundleId: String) -> Int { resolve()?.wokenWindows(bundleId: bundleId) ?? 0 }
    func appRuns(bundleId: String) -> Bool? { resolve()?.appRuns(bundleId: bundleId) }
    func dragging(_ on: Bool) -> Bool { resolve()?.dragging(on) ?? false }
    func follow(_ placement: HostPlacement) { resolve()?.follow(placement) }
}

extension Shell {
    // The engine's hooks to the session (the Safari windows it asks for, its loading steps, its events): when the
    // session is made with an engine already there, or when the engine starts after the session.
    func wire(_ host: HostEngine, to session: HostedSession) {
        host.requestSafariWindow = { [weak session] profile in await session?.requestSafariWindow(profile) }
        host.closeSafariWindow = { [weak session] profile, id in await session?.closeSafariWindow(profile, id) ?? false }
        host.safariFullScreen = { [weak session] profile, id, on in await session?.safariFullScreen(profile, id, on) ?? false }
        host.safariLinked = { [weak session] profile in await session?.safariLinked(profile) ?? false }
        host.loading = { [weak session] id in session?.loading(id) }
        host.hostedWindow = { [weak session] number in session?.hosted(number) }
        host.cover = { [weak session] number in session?.cover(number) }
        host.others = { [weak session] number in session?.others(number) }
        host.front = { [weak session] read in session?.front(read) }
        let before = host.onEvent
        host.onEvent = { [weak self, weak session] event in
            before?(event)
            session?.hostEvent(event)
            // A host just shown: the engine's poll every 0.1 s for the next two seconds, beside the shell's own (macOS's
            // own full-screen change can still finish after the show: a window that ends up in no Space, or off the
            // screen, is brought back at the first read: 2026-11-17, check10).
            if case .shown = event { self?.pollAfterShow() }
            // Any event of the engine's: the shell's own read, which then goes on every `restPoll` while something is
            // hosted. (Found on the real screen, 2026-11-17: with only apps hosted and no browser's copy linked nothing
            // had started the reads, so the poll that brings a strayed window back, lets another window in front and
            // keeps Margin's keys never ran.)
            self?.soon()
        }
    }

    func pollAfterShow() {
        showPolls += 1
        let mine = showPolls
        for i in 1...20 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1 * Double(i)) { [weak self] in
                guard let self, !self.stopped, self.showPolls == mine else { return } // (a newer show's own run takes over)
                self.host?.poll()
            }
        }
    }

    // The source Margin's windows draw, and the session that hosts what they show: the library's, made once.
    func makeHostedSource() -> MarginWindowSource {
        // (A theme's settings changed in Margin's window, its sidebar's width, last across launches: the app's defaults.)
        let profiles = DataSetWindowSource(data: data, pick: { [weak self] in self?.hostedProfile() }, keeper: options.harness ? nil : .appDefaults)
        guard let library else {
            Diagnostics.note("Margin's window: no library (its rules didn't load): a profile's spaces, read only")
            return profiles
        }
        // The engine looked up at each call: Margin's window (and so this session) is made when Margin is opened by hand,
        // before the private calls are checked and the engine started (seen 2026-11-15: the session kept the stand-in).
        let engine = LateHostEngine { [weak self] in self?.host }
        let session = HostedSession(library: library, engine: engine, links: ShellHostedLinks(shell: self), options: options.hostedOptions ?? HostedSession.Options())
        if let name = UserDefaults.standard.string(forKey: "MarginHostedSafari"), !options.harness { session.options.safariBundles.insert(name) }
        // (`defaults write com.unibox.margin MarginResumeLast -bool NO`: the launcher at every launch, the last item never shown by itself.)
        if !options.harness, !HostedSession.resumesLast(setting: UserDefaults.standard.object(forKey: HostedSession.resumeKey)) {
            session.options.resumesLast = false
            Diagnostics.note("hosted: the last item isn't shown at launch (\(HostedSession.resumeKey) is NO)")
        }
        session.appName = { [weak self] id in self?.installedAppName(id) }
        library.delegate = session
        hosted = session
        session.marginActive = { NSApp.isActive }
        session.activateMargin = { NSApp.activate() }
        if let host { wire(host, to: session); prepareBrowserOnce() }
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

    // The person's default browser made ready out of sight (HostedSession.prepareBrowser), once both the session and the
    // engine are up (either may come first), in the background: Margin's own window isn't held up for it.
    func prepareBrowserOnce() {
        guard let session = hosted, host != nil, !browserPrepared else { return }
        browserPrepared = true
        // (`defaults write com.unibox.margin MarginPrepareBrowser -bool NO`: no browser started or asked for a window at
        // launch; the first web item opens it then. The on-screen checks that use only their own test apps set it.)
        if !options.harness, UserDefaults.standard.object(forKey: "MarginPrepareBrowser") as? Bool == false {
            return Diagnostics.note("hosted: browser not prepared at launch (MarginPrepareBrowser is NO)")
        }
        let setting = UserDefaults.standard.string(forKey: DefaultBrowser.key)
        Task { await session.prepareBrowser(setting: setting) }
    }

    // Margin's windows joined to the session: which window is which, their page areas, the first run's editor.
    func joinHosted(_ windows: MarginWindows) {
        guard let session = hosted else { return }
        session.window = { [weak windows] id in
            guard let windows else { return nil }
            if let id { return windows.controllers.first { $0.id == id } }
            return windows.front
        }
        windows.onPageRect = { [weak session] controller, _ in session?.pageRectChanged(controller) }
        windows.onReady = { [weak session] controller in
            guard let session, let space = session.firstSpace else { return }
            session.firstSpace = nil
            controller.push(#"{"type":"command","name":"edit-space","spaceId":"# + (jsonString(space) ?? "\"\"") + "}")
        }
        windows.onLeavingFullScreen = { [weak session] controller in session?.leavingFullScreen(controller) }
        windows.onLeftFullScreen = { [weak session] controller in session?.leftFullScreen(controller) }
        windows.onEnteredFullScreen = { [weak session] controller in session?.enteredFullScreen(controller) }
        windows.onPagePress = { [weak session] controller, at in session?.pagePressed(controller, at: at) }
        windows.onFieldClosed = { [weak session] controller in session?.fieldClosed(controller) }
        windows.onOpen = { [weak session] controller in session?.resumeLast(controller) }
        windows.onSidebarResizing = { [weak session] controller, on in session?.sidebarResizing(controller, on) }
        windows.onNarrowed = { [weak self] _ in self?.host?.marginNarrowed() }
        windows.apps = { [weak self] in self?.appsJSON ?? "null" }
    }

    // The installed app's name as the catalog read it (Finder's).
    func installedAppName(_ bundleId: String) -> String? {
        guard let json = appsJSON, let list = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [JSONObject] else { return nil }
        return list.first { $0["bundleId"] as? String == bundleId }?["name"] as? String
    }

    // ---- Margin's keys while hosting (Shortcuts.swift ShortcutSet.hostedActive) ----

    // Held while Margin or an app it hosts is in front (with a Margin window on the current Space), let go otherwise;
    // the combinations the first linked copy's Settings say, else the defaults. The quit guard (⌘Q, ⌥⌘Q) by the same
    // rule, while Margin asks before it quits (ShellQuit.swift).
    func updateHostedKeys() {
        let own = ProcessInfo.processInfo.processIdentifier
        let windows = marginWindows?.controllers ?? []
        let hostedPids = Set(host?.hosts.values.map(\.pid) ?? [])
        let here = options.harness ? !windows.isEmpty : windows.contains { $0.window.isVisible && $0.window.isOnActiveSpace }
        let active = ShortcutSet.hostedActive(frontPid: apps.frontPid, ownPid: own, hostedPids: hostedPids, marginWindowOpen: !windows.isEmpty, marginOnCurrentSpace: here)
        if active {
            let said = links.keys.sorted().lazy.compactMap { self.links[$0] }.first { $0.connection.isUp && $0.keys != nil }?.keys
            var bindings = ShortcutSet.bindings(from: said ?? [:])
            // (A hosted app in front: the sidebar stays docked while hosting, so its key would only take the app's typing.)
            if apps.frontPid != own { bindings = bindings.filter { $0.value != .toggleSidebar } }
            shortcuts.rebind(bindings)
        }
        // (Which app took the front is said by its bundle id: 2026-11-17's log let go and held the keys again and again
        // and couldn't say which app came between.)
        if active != shortcuts.isActive {
            let front = active ? "" : apps.frontPid.flatMap { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier }.map { " (\($0))" } ?? ""
            Diagnostics.note("Margin's keys \(active ? "held: Margin or an app it hosts is in front" : "let go: another app is in front\(front)")")
        }
        shortcuts.set(active: active)
        let guards = ShortcutSet.guardsQuit(asks: options.asksBeforeQuit(), quitting: hostQuitting || quitsAsked > 0, frontPid: apps.frontPid, ownPid: own, hostedPids: hostedPids,
                                            marginWindowOpen: !windows.isEmpty, marginOnCurrentSpace: here)
        if guards != shortcuts.guardsQuit { Diagnostics.note("⌘Q \(guards ? "is Margin's first: it asks before it quits" : "let go: the front app's own")") }
        shortcuts.setQuitGuard(active: guards)
        // (Its prompt up and neither Margin nor an app it hosts in front any more: never left up.)
        if !active, quitPrompt != nil { quitPrompt?.choose(.cancel) }
    }

    // A key of Margin's while hosting: to the Margin window hosting (else the front one), whose page does it as its own
    // (the palette; the sidebar; the next or previous item of its space, an app or a web item, shown as a sidebar pick;
    // the next or previous space: overlay.ts), or a new Margin window.
    func runHosted(_ command: AppCommand, isRepeat: Bool) {
        guard let windows = marginWindows else { return }
        let w = hosted?.hostingWindow.flatMap { id in windows.controllers.first { $0.id == id } } ?? windows.front
        switch command {
        case .newWindow:
            windows.open()
        case .palette:
            Diagnostics.note("the palette's key: sent to Margin's window \(w?.id ?? 0)")
            w?.push(#"{"type":"command","name":"palette"}"#)
        case .toggleSidebar:
            w?.push(#"{"type":"command","name":"toggle-sidebar"}"#)
        case .nextTab, .prevTab, .nextSpace, .prevSpace:
            w?.push(#"{"type":"command","name":"\#(command.rawValue)","repeat":\#(isRepeat)}"#)
        }
        w.map { hostedKeysRun.append("\(command.rawValue) → \($0.id)") }
        if hostedKeysRun.count > 50 { hostedKeysRun.removeFirst(hostedKeysRun.count - 50) }
    }
}
