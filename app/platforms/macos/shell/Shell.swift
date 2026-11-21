// Margin.app's shell as a whole: what AppDelegate starts and stops. Margin is the app (docs/MARGIN-APP.md): it owns
// the person's spaces (the library: Library.swift, ShellLibrary.swift), draws its UI in its own window
// (MarginWindow.swift, ShellHosted.swift) and hosts Safari's windows and any other app in that window's page area
// (the host engine: HostEngine.swift, ShellHost.swift; the two joined by HostedSession.swift, ShellHostedGlue.swift).
// Nothing is drawn over the person's own browser windows (decided 2026-11-16: hosted only).
//
//  - The links to Margin's extension copies (ExtensionLink.swift, one per browser profile) stay up as the tabs'
//    drivers: each copy's state is mirrored (StateMirror.swift), its lasting data kept (DataSync.swift), its theme
//    package and its shortcuts heard; its `loading` pushes are the Margin window's loading bar, and the pushes for
//    its UI that UIPush.swift passes on (the mini player's `media`, `toast`) go to the Margin window they belong in.
//  - Each read (`track`): Margin's keys held while Margin or an app it hosts is in front (Shortcuts.swift
//    ShortcutSet.hostedActive), the host polled, Safari's restored windows swept; again every `restPoll` while
//    something is hosted or a copy is linked.

import AppKit

final class Shell: ExtensionLinkDelegate {
    struct Options {
        var harness = false
        var root: URL? // the UI page's folder (dist/app); default: the app's Resources/app
        var restPoll: TimeInterval = 0.25 // the host's poll while something is hosted or a copy is linked
        var resyncRetry: TimeInterval = 2
        // The lasting data's folder (DataStore.swift). Default: ~/Library/Application Support/Margin/data,
        // or a new temporary folder for a harness (a test never touches the real one).
        var dataRoot: URL?
        var bundleIds = ["safari": safariIdentifier, "chrome": "com.google.Chrome", "edge": "com.microsoft.edgemac"]
        // Seconds since 1970, the clock the extension's focusedAt and createdAt use (tests set it).
        var clock: () -> Double = { Date().timeIntervalSince1970 }
        // Safari's data folder, for its profiles' names (SafariProfiles.swift); nil: not read (the harness, the tests).
        var safariData: URL?
        var safariWatch = SafariProfileWatcher.Options()
        // macOS's private calls (PrivateCalls.swift): the system's only in forApp(); nil (every test, the harness):
        // none, and the host stays off.
        var privateResolver: PrivateResolver?
        var privateCallsDefaults: UserDefaults? // where the macOS build last checked is kept; nil: not kept
        // The browser Margin was last linked with ("safari", "chrome", "edge"), and each link's told.
        var lastBrowser: () -> String = { "safari" }
        var sawBrowser: ((String) -> Void)?
        // DEV-HOOK: the dev-only test hook (DevHooks.swift, removed before production): whether
        // MarginDevHooks is YES, read at each notification. Nil (every test, the harness): not listened for.
        var devHooksOn: (() -> Bool)?
        // Safari's menus through Accessibility (SafariAX.swift: a profile's new window, its View › Show Sidebar): only the app (forApp).
        var safariAX = false
        // Safari's View › Show Sidebar item (ShellSafariSidebar.swift; the tests: a stand-in; nil: SafariAX's when on).
        var sidebarMenu: SidebarMenu?
        var appCatalog = AppCatalogWatcher.Options() // where apps are read from, the icons' cache (a test: its own folders)
        // A harness's stand-in for the system the host engine runs on (never the real one: ShellHost.swift makes that
        // from the private calls' check). Given, the engine is made at once on it, with no marker.
        var hostSystem: HostSystem?
        var hostOptions: HostEngine.Options?
        var hostedOptions: HostedSession.Options?
        // Whether ⌘Q asks first (Margin's own prompt: ShellQuit.swift) and its "Always quit" (MarginAskBeforeQuit in
        // the app's defaults, forApp; a test keeps its own), and Margin's quit itself (the app's terminate, which
        // comes back to stop(); a test's: its own).
        var asksBeforeQuit: () -> Bool = { true }
        var setAskBeforeQuit: (Bool) -> Void = { _ in }
        var quit: () -> Void = {}
    }

    final class Link {
        let connection: LinkConnection
        let mirror = StateMirror()
        var assembler = ChunkAssembler()
        var theme: String? // the theme package's JSON (background/theme-package.ts ThemeMessage)
        var themeId: String?
        var resyncTimer: Timer?
        var keys: [String: [String]]? // the copy's shortcuts, once it said
        var drawnSent: [Int: Bool] = [:] // what the copy was last told of each of its windows (tellDrawn)
        init(_ connection: LinkConnection) { self.connection = connection }
    }

    let link: SocketLink
    // The lasting data, one set per browser profile (DataSync.swift: the read API is there).
    let data: DataSync
    // The app's own spaces, pins, folders and items (ShellLibrary.swift); nil only if its rules didn't load.
    var library: Library?
    let apps: AppWatch
    let shortcuts: AppShortcuts
    private(set) var options: Options
    lazy var pages = OverlayPages(root: options.root ?? OverlayPages.appRoot) // Margin's windows' page (ShellHosted.swift)
    var marginWindows: MarginWindows? // made the first time one is opened
    var hostedSettings: DataSetWindowSource? // the settings Margin's windows draw and change (ShellHostedGlue makeHostedSource)
    // (A harness's: its page folder's, when it gives one (dist/app has every built-in's package); none otherwise.)
    lazy var builtinThemes = BuiltinThemes(root: options.harness ? options.root : OverlayPages.appRoot)

    private(set) var links: [String: Link] = [:]
    // Safari's menus through Accessibility (a profile's new window, the sidebar item).
    let safariAX = SafariAX()
    var pollTimer: Timer?
    var showPolls = 0 // each host shown: its own run of quick polls (ShellHostedGlue.swift pollAfterShow)
    private var trackSoon = false
    private(set) var stopped = false

    // ---- profiles (ShellProfiles.swift) ----
    var browserProfiles: [String: BrowserProfiles] = [:]
    var safariNames: SafariProfileWatcher? // Safari's profile names (ShellProfiles.swift startSafariNames)
    var profilesQueued = false

    // ---- installed apps (ShellApps.swift) ----
    var appCatalog: AppCatalogWatcher?
    var appsJSON: String? // the list last read, as Margin's windows get it
    /// An app picked in the palette, by its bundle id: the session opens it in the page area.
    var openApp: ((String) -> Void)?

    // ---- private calls (PrivateCalls.swift) ----
    var privateCalls = PrivateCalls.Availability.off // what the launch check found
    var skyLight: SkyLight? // the functions it passed, behind their wrappers; nil until checked
    var freezer: Freezer? // the freeze (RealFreezer, from what the launch check passed): the host's first full screen
    // The host (HostEngine.swift, ShellHost.swift): made at launch once its calls passed.
    var host: HostEngine?
    var hostQuitting = false
    // The library's items shown by the host in Margin's window (HostedSession.swift, ShellHostedGlue.swift).
    var hosted: HostedSession?
    var browserPrepared = false // (the default browser made ready once per launch: prepareBrowserOnce)
    var hostedKeysRun: [String] = [] // Margin's keys run while hosting, newest last (the tests read it)
    var quitPrompt: QuitPrompt? // Margin's quit prompt, while it's up (ShellQuit.swift)
    var quitsAsked = 0 // Margin's quit asked of the app (Options.quit) by the prompt's Quit or Always quit (the tests read it)
    var devHooks: DevHooks? // DEV-HOOK: the dev-only test hook (DevHooks.swift), only with Options.devHooksOn
    // ---- user themes (ShellThemes.swift) ----
    lazy var userThemes = UserThemes(harness: options.harness)

    init(link: SocketLink, apps: AppWatch, hotKeys: HotKeyRegistrar, options: Options = Options()) {
        self.link = link
        self.apps = apps
        self.shortcuts = AppShortcuts(registrar: hotKeys)
        self.options = options
        let dataRoot = options.dataRoot
            ?? (options.harness ? FileManager.default.temporaryDirectory.appendingPathComponent("margin-harness-\(UUID().uuidString)", isDirectory: true) : DataStore.appRoot)
        data = DataSync(store: DataStore(root: dataRoot))
        link.delegate = self
        startLibrary(dataRoot: dataRoot)
        if let system = options.hostSystem { host = HostEngine(system: system, marker: nil, options: options.hostOptions ?? HostEngine.Options()) }
        data.onChange = { [weak self] _, collections in
            if collections.contains("spaces") || collections.contains("tabs") { self?.profilesSoon() }
        }
        apps.onChange = { [weak self] _ in self?.soon() }
        shortcuts.onCommand = { [weak self] command, isRepeat in self?.run(command, isRepeat: isRepeat) }
        shortcuts.onQuit = { [weak self] _ in self?.quitKey() }
        shortcuts.onAppKey = { [weak self] key in self?.runAppKey(key) }
    }

    // The app's own: the window server and NSWorkspace, Carbon's hot keys.
    static func forApp() -> Shell {
        var options = Options()
        options.safariData = SafariProfiles.safariFolder
        options.privateResolver = RealPrivateResolver()
        options.privateCallsDefaults = .standard
        Diagnostics.note("Margin's own window, the library, installed apps in the palette, the host engine")
        options.lastBrowser = { UserDefaults.standard.string(forKey: "MarginLastBrowser") ?? "safari" }
        options.sawBrowser = { browser in
            if UserDefaults.standard.string(forKey: "MarginLastBrowser") != browser { UserDefaults.standard.set(browser, forKey: "MarginLastBrowser") }
        }
        options.devHooksOn = { DevHooks.appDefault() } // DEV-HOOK
        options.asksBeforeQuit = { UserDefaults.standard.object(forKey: Shell.askBeforeQuitKey) as? Bool ?? true }
        options.setAskBeforeQuit = { UserDefaults.standard.set($0, forKey: Shell.askBeforeQuitKey) }
        options.quit = { NSApp.terminate(nil) }
        options.safariAX = true
        SafariAX.askOnce()
        Diagnostics.note(SafariAX.trusted ? "Accessibility: on" : "Accessibility: not granted")
        // Chrome's and Edge's copies find the app through its connector (RelayLink.swift): their host files, then its socket.
        let link = SocketLink()
        link.relay = RelayHub()
        Connector.installHostFiles()
        return Shell(link: link, apps: WorkspaceApps(), hotKeys: CarbonHotKeys(), options: options)
    }

    // At launch, before start() (AppDelegate.startShell): which private calls are there. With no resolver nothing is
    // checked, and the freeze and the host stay off.
    func checkPrivateCalls() {
        guard let resolver = options.privateResolver else { return }
        privateCalls = PrivateCalls.check(resolver: resolver, defaults: options.privateCallsDefaults)
        let sky = SkyLight(resolver: resolver, availability: privateCalls)
        skyLight = sky
        if privateCalls.freeze { freezer = RealFreezer(skyLight: sky) }
        guard privateCalls.spaces else { return }
        let spaces = SkyLightSpaces(sky: sky, availability: privateCalls)
        startHost(resolver: resolver, sky: sky, spaces: spaces)
    }

    func start() {
        stopped = false
        link.start()
        startSafariNames()
        appsStart()
        // DEV-HOOK: heard only while MarginDevHooks is YES.
        if let on = options.devHooksOn, devHooks == nil {
            devHooks = DevHooks(world: self, isOn: on)
            devHooks?.listen()
        }
    }

    // Quitting: every hosted app given back first, while the copies' links are still up (Safari windows Margin made
    // are closed by them), then the rest.
    func stop(then: @escaping () -> Void) {
        if let host, host.hasHosts || host.hasLeftSafariWindows, !hostQuitting { return stopHost { [weak self] in self?.stop(then: then) } }
        stopped = true
        pollTimer?.invalidate()
        shortcuts.set(active: false)
        shortcuts.setQuitGuard(active: false)
        shortcuts.setAppKeyGuard(active: false)
        dismissQuitPrompt()
        apps.stop()
        safariNames?.stop()
        devHooks?.stop() // DEV-HOOK
        devHooks = nil // DEV-HOOK
        appsStop()
        marginWindows?.closeAll()
        link.stop(why: "Margin.app quit", then: then)
    }

    // ---- links ----

    // A Chrome or Edge copy's hello names its browser process as its connector told it. Trusted (decided 2026-11-09:
    // never refused), but one no connector has named since the app started is logged: a copy linking with a link
    // kept from before, a connector that knew no process, or a hello not as its relay said. The same in margin-core
    // (app/shared/core/src/shell/mod.rs warn_unheard_pid), word for word.
    nonisolated static func unheardPid(_ key: String, _ hello: LinkMessage.Hello, heard: (pid_t) -> Bool) -> String? {
        guard hello.browser != "safari", let pid = hello.pid, pid > 0, pid <= Int(Int32.max), !heard(pid_t(pid)) else { return nil }
        return "\(key): its hello says browser process \(pid), which no connector has named: trusted, as on the Mac"
    }

    func linkUp(_ connection: LinkConnection) {
        let entry = Link(connection)
        entry.mirror.begin(connection.hello)
        if let hub = link.relay, let warning = Self.unheardPid(connection.key, connection.hello, heard: hub.heardPid) { Diagnostics.warn(warning) }
        links[connection.key] = entry
        options.sawBrowser?(connection.hello.browser)
        data.linkUp(connection)
        apps.start()
        if connection.hello.browser == "safari" { safariCopyLinked() }
        profilesSoon()
        soon()
    }

    func linkReceived(_ connection: LinkConnection, _ message: LinkMessage) {
        guard let entry = links[connection.key], entry.connection === connection else { return }
        switch message {
        case .snapshot, .delta, .windows:
            switch entry.mirror.apply(message) {
            case .applied:
                entry.resyncTimer?.invalidate()
                if case .snapshot = message { profilesSoon(); themesTellCopy(entry) }
                if case .delta(_, _, let changes, _) = message, changes["spaces"] != nil { profilesSoon() }
                // A Safari copy's tabs: the hosted items' sound (playing, muted), for the UI's rows (HostedSession.copyTabs).
                var tabsChanged = false
                if case .snapshot = message { tabsChanged = true }
                if case .delta(_, _, let changes, _) = message, changes["openTabs"] != nil { tabsChanged = true }
                if tabsChanged, connection.hello.browser == "safari", let tabs = (entry.mirror.value("openTabs") as? JSONObject)?["tabs"] as? JSONObject {
                    hosted?.copyTabs(profile: connection.hello.profile, tabs: tabs)
                }
                tellDrawn(entry)
                soon()
            case .gap(let expected, let got):
                Diagnostics.warn("\(connection.key): number \(got) came, \(expected) was next: the state asked for again")
                resync(entry)
            case .ignored:
                break
            }
        case .theme(let epoch, let chunk):
            guard epoch == connection.epoch else { return }
            switch entry.assembler.add(chunk) {
            case .complete(let id, let data):
                guard let object = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject, object["id"] as? String == id,
                      object["manifest"] is String, object["html"] is String, object["css"] is String, let text = String(data: data, encoding: .utf8) else {
                    return Diagnostics.warn("\(connection.key): the theme \(id) isn't a theme package: left")
                }
                entry.theme = text
                entry.themeId = id
                Diagnostics.note("\(connection.key): theme \(id) here (\(data.count) bytes)")
            case .refused(let why):
                Diagnostics.warn("\(connection.key): a theme refused: \(why)")
            case .waiting:
                break
            }
        case .data(let kind, let body):
            data.received(connection, kind, body)
        case .push(_, let windowId, let msg):
            guard connection.hello.browser == "safari", let type = msg["type"] as? String else { return }
            // A Safari copy's tabs loading in the window Margin hosts for its profile, drawn as Margin's window's
            // loading bar (HostedSession.copyLoading).
            if type == "loading" {
                let ids = (msg["tabIds"] as? [Any] ?? []).compactMap { int($0) }
                hosted?.copyLoading(profile: connection.hello.profile, windowId: windowId, tabIds: ids)
                return
            }
            // What its UI shows for that window (UIPush.swift: only the types passed on, checked there), to the Margin
            // window it belongs in (HostedSession.copyPush). Any other push: not the page's.
            if UIPush.forwarded[type] != nil { hosted?.copyPush(profile: connection.hello.profile, windowId: windowId, msg: msg) }
        case .keys(let epoch, let bindings):
            guard epoch == connection.epoch else { return }
            entry.keys = bindings
            soon()
        default:
            break
        }
    }

    func linkDown(_ connection: LinkConnection, _ why: String) {
        guard let entry = links[connection.key], entry.connection === connection else { return }
        entry.resyncTimer?.invalidate()
        links[connection.key] = nil
        data.linkDown(connection)
        profilesSoon()
        soon()
    }

    private func resync(_ entry: Link) {
        entry.connection.send(.resync(epoch: entry.connection.epoch))
        entry.resyncTimer?.invalidate()
        entry.resyncTimer = Timer.scheduledTimer(withTimeInterval: options.resyncRetry, repeats: false) { [weak self, weak entry] _ in
            MainActor.assumeIsolated {
                guard let self, let entry, entry.mirror.isResyncing, self.links[entry.connection.key] === entry else { return }
                self.resync(entry)
            }
        }
    }

    // ---- the reads ----

    // A read on the next turn of the run loop (several reasons at once: one read).
    func soon() {
        guard !trackSoon, !stopped else { return }
        trackSoon = true
        DispatchQueue.main.async { MainActor.assumeIsolated {
            self.trackSoon = false
            self.track()
        } }
    }

    // Which of a copy's windows Margin draws (`drawn`, background/link.ts): true only for the Safari window the session
    // hosts for that profile, false for every other, the person's own (hosted only, 2026-11-16: their ⌘T and keys stay
    // the browser's, the copy's new-tab page; a linked copy takes a window it wasn't told of as drawn). Sent on change.
    func tellDrawn(_ entry: Link) {
        guard entry.connection.isUp, entry.mirror.hasState else { return }
        let hello = entry.connection.hello
        let hostedId = hello.browser == "safari" ? hosted?.safariWindows[hello.profile] : nil
        let ids = windows(of: entry.connection.key).map(\.id)
        for id in ids {
            let on = id == hostedId
            guard entry.drawnSent[id] != on else { continue }
            entry.drawnSent[id] = on
            entry.connection.send(.drawn(epoch: entry.connection.epoch, windowId: id, on: on))
        }
        entry.drawnSent = entry.drawnSent.filter { ids.contains($0.key) }
    }

    // One read: Margin's keys, the host's poll, Safari's restored windows; the next one while the host has something
    // or a copy is linked.
    func track() {
        pollTimer?.invalidate()
        pollTimer = nil
        guard !stopped else { return }
        updateHostedKeys()
        host?.poll()
        hosted?.sweepRestoredSafariWindows()
        for entry in links.values { tellDrawn(entry) }
        // (When to look again: the hosting core's schedule (schedule.rs): fast just after activity, every 0.25 s while
        // something is unconfirmed, every 1.5 s at rest with apps hosted, every 2 s with only copies linked, never with
        // nothing. Events (an app activated, a Space changed, a notification of a hosted app's, an engine event) look at
        // once. It was every 0.25 s whenever anything was hosted: 3.4% of a CPU at rest with three, 2026-11-18.)
        let after: Double?
        if let host {
            after = host.nextPoll(links: !links.isEmpty)
        } else {
            after = links.isEmpty ? nil : options.restPoll
        }
        guard let after else { return }
        let timer = Timer(timeInterval: options.harness ? min(after, options.restPoll) : after, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
        timer.tolerance = after * 0.1 // (coalesced with the system's other timers: fewer wakeups)
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    // `isRepeat`: a held key's repeat (AppShortcuts), not a press.
    func run(_ command: AppCommand, isRepeat: Bool = false) { runHosted(command, isRepeat: isRepeat) }
}
