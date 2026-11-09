// Margin.app's shell as a whole (PLAN.md §6): what AppDelegate starts and
// stops. It joins the links to Margin's extension copies (ExtensionLink.swift,
// one per browser profile) and each copy's state (StateMirror.swift) to what
// the window server says (WindowServer.swift), and keeps one overlay
// (Overlay.swift) over each of the browser's windows Margin draws around:
//
//  - Nothing happens until a linked browser has come to the front. From then
//    on, the window server's list is read a few times a second (4 while the
//    browser is in front, 1 otherwise), and 30 times a second for a moment
//    after anything that moves windows (an app activated, the Space or the
//    displays changed, a press, a window list from the extension).
//  - Each copy's windows are bound to the window server's, from evidence,
//    never on a guess (WindowMatcher.swift WindowBinder): a window not bound
//    yet gets nothing drawn over it. A window gets an overlay once its copy's state
//    and theme are here; the overlay shows (just above the window, at its
//    bounds) once its page has drawn, while the window is on screen and in
//    full screen (windowed mode is Phase 4: `windowedToo`), and is put back
//    above the window whenever something comes between them.
//  - Each overlay's page draws the theme around the page slot and reports
//    where the slot is (`layout`): sent to the copy as `setLayout` for that
//    window when it changes (LayoutOutbox), and used, with what the theme
//    draws over the slot (`hits`), to let the pointer through to the page
//    (PassThrough.swift).
//  - Each copy is told, per window, whether the app draws over it (`drawn`,
//    DrawnOutbox): on while the window is bound and wanted, off after a
//    grace. Its pages have a box only where it's on (a window the app draws
//    nothing over gets no empty sidebar gutter). A layout goes only for a
//    bound window.
//  - Margin's keys (Shortcuts.swift) are the app's only while a linked
//    browser is in front with an overlay on its front window, with the
//    combinations that window's copy sent (`keys`: its Settings shortcuts).
//  - A link that drops (not one replaced by a newer link, not a goodbye)
//    leaves its overlays where they are for `reconnectGrace`, dimmed and
//    saying it's reconnecting; the copy linking again in that time takes
//    them back as they are, else they close. The copy's pages go back to
//    drawing their own UI on the same clock (background/link.ts GONE_MS).
//    Meanwhile the window server is still read, and a kept overlay is put
//    away once the window it's over is gone, off screen (not in its own
//    Space) or no longer where it was; dropped while the browser isn't in
//    front, they're put away at once.
//  - The profile handoff (ShellHandoff.swift, app/HANDOFF.md), behind its gate
//    (`Options.handoff`): each read also sweeps the parked windows, a parked
//    window's overlay stays hidden as it was, and the windows a switch moves
//    are drawn from the app's own reads. With the gate off, nothing of it runs.

import AppKit

// What's been sent of each window's layout: only a change goes again, numbered per window.
struct LayoutOutbox {
    private var sent: [Int: PageLayout] = [:]
    private var seq: [Int: Int] = [:]

    // The next number and the layout to send, or nil if it's what was sent last (to half a point).
    mutating func offer(windowId: Int, _ layout: PageLayout) -> (seq: Int, layout: PageLayout)? {
        let rounded = layout.rounded
        guard sent[windowId] != rounded else { return nil }
        sent[windowId] = rounded
        let next = (seq[windowId] ?? 0) + 1
        seq[windowId] = next
        return (next, rounded)
    }

    mutating func forget(windowId: Int) { sent[windowId] = nil }
    mutating func reset() { sent = [:]; seq = [:] }
}

// Whether the app draws over each of one copy's windows, as the copy is told (`drawn`,
// app/PROTOCOL.md). On while the window is bound to one of the window server's and wanted (in full
// screen, or `windowedToo`, with the copy's theme here), whether or not its overlay is on screen
// right now: one left in its window's Space, or kept unseen through a blip of the window server's
// list, stays on, so a Space change never says anything. Off only after a grace, so a full-screen
// animation or a binding that comes back a moment later doesn't take the box from the window's
// pages: not wanted for `notWanted`, never bound since its copy first reported it for `neverBound`,
// bound before and unbound now for `unbound`. A closed window that was on: off at once. Only a
// change is sent.
struct DrawnOutbox {
    struct Grace {
        var notWanted: TimeInterval = 1.5 // covers the full-screen animation
        var neverBound: TimeInterval = 1.5
        var unbound: TimeInterval = 3 // the binder keeps a window missing from a read for 3 s (WindowBinder)
    }
    var grace = Grace()
    private(set) var sent: [Int: Bool] = [:]
    private var everBound: Set<Int> = []
    private var offSince: [Int: TimeInterval] = [:] // when the window stopped being drawn (or was first reported)

    // The windows it has heard of.
    var windows: Set<Int> { Set(offSince.keys).union(sent.keys).union(everBound) }

    // What to send for the window now (nil: nothing), why, and when to look again if off is pending.
    // `pending`: not bound, but its window is one of the browser's same-bounds windows off screen, none of them
    // bound and none on screen (other Spaces' full-screen windows, not told apart until one comes on screen):
    // on as if bound, so its pages have their box as its Space slides in and the overlay, bound then (the
    // visible rule at once, WindowMatcher.swift), only has to show. Off by the grace once it's on screen unbound.
    mutating func offer(windowId id: Int, now: TimeInterval, bound: Bool, wanted: Bool, pending: Bool = false) -> (send: Bool?, why: String, due: TimeInterval?) {
        if bound { everBound.insert(id) }
        if (bound || pending) && wanted {
            offSince[id] = nil
            guard sent[id] != true else { return (nil, "", nil) }
            sent[id] = true
            return (true, bound ? "bound, and in full screen" : "in full screen, not bound yet: its window is one of the browser's same-bounds windows off screen", nil)
        }
        let since = offSince[id] ?? now
        offSince[id] = since
        let (wait, why) = !wanted ? (grace.notWanted, "not in full screen (or no theme yet)")
            : everBound.contains(id) ? (grace.unbound, "no longer bound to one of the window server's")
            : (grace.neverBound, "not bound to one of the window server's since its copy reported it")
        guard sent[id] != false else { return (nil, "", nil) }
        let due = since + wait
        guard now >= due else { return (nil, "", due) }
        sent[id] = false
        return (false, "\(why) for \(String(format: "%.1f", now - since)) s", nil)
    }

    // A palette the app couldn't show over the window (no overlay shown there in `Shell.paletteHold`): off
    // now, whatever the grace (the copy's ⌘T and new-tab page then do without the app's palette there).
    // True if that's a change to send.
    mutating func notShown(windowId id: Int, now: TimeInterval) -> Bool {
        guard sent[id] != false else { return false }
        sent[id] = false
        offSince[id] = offSince[id] ?? now
        return true
    }

    // The window closed (its copy no longer reports it): off, if it was on; forgotten.
    mutating func closed(windowId id: Int) -> Bool? {
        defer { sent[id] = nil; everBound.remove(id); offSince[id] = nil }
        return sent[id] == true ? false : nil
    }
}

// What a copy pushed for a window that an overlay made later still needs
// (app/PROTOCOL.md "Notices, loading and gestures"): its last notice, for
// NOTICE_FOR, and its last set of tabs loading, given to each overlay's page
// with its hello (`held`). A push reaches only the overlays already there,
// and a copy says a notice as it decides it: often as it links, before the
// app has bound the window or drawn its overlay.
struct HeldPushes {
    static let types: Set<String> = ["notice", "loading"]
    static let noticeFor: TimeInterval = 60
    private var held: [Int: [String: (msg: JSONObject, at: Date)]] = [:] // window (-1: every window) → type → the last push

    mutating func offer(windowId: Int?, _ msg: JSONObject, at: Date = Date()) {
        guard let type = msg["type"] as? String, Self.types.contains(type) else { return }
        held[windowId ?? -1, default: [:]][type] = (msg, at)
    }

    // A window's, oldest first: every window's and its own; a notice only while it's recent.
    func messages(for windowId: Int, at now: Date = Date()) -> [JSONObject] {
        let entries = [-1, windowId].flatMap { (held[$0] ?? [:]).map { (type: $0.key, msg: $0.value.msg, at: $0.value.at) } }
        return entries.filter { $0.type != "notice" || now.timeIntervalSince($0.at) <= Self.noticeFor }.sorted { $0.at < $1.at }.map(\.msg)
    }

    mutating func forget(windowId: Int) { held[windowId] = nil }
}

final class Shell: ExtensionLinkDelegate, OverlayDelegate {
    struct Options {
        var harness = false
        // The own-Space check (checkOwnSpace, judgeOwnSpace) in a harness too: its window source says
        // which windows are on screen (the harness's stand-in windows have no Spaces of their own).
        var harnessOwnSpaceCheck = false
        var root: URL? // the overlay's page folder (dist/app); default: the app's Resources/app
        var overlay = OverlayController.Options()
        var restPoll: TimeInterval = 0.25 // a linked browser in front
        var idlePoll: TimeInterval = 1 // not in front
        var burstPoll: TimeInterval = 1.0 / 30
        var burstFor: TimeInterval = 1
        var resyncRetry: TimeInterval = 2
        var pointerEvery: TimeInterval = 1.0 / 30 // the pointer handed to a page passing it through
        var windowedToo = false
        // The lasting data's folder (DataStore.swift). Default: ~/Library/Application Support/Margin/data,
        // or a new temporary folder for a harness (a test never touches the real one).
        var dataRoot: URL?
        var reconnectGrace: TimeInterval = 6 // a dropped link's overlays, kept dimmed (background/link.ts GONE_MS)
        var drawnGrace = DrawnOutbox.Grace() // how long a window is unbound or out of full screen before its copy hears it isn't drawn
        var bundleIds = ["safari": safariIdentifier, "chrome": "com.google.Chrome", "edge": "com.microsoft.edgemac"]
        var profileSwitch = ProfileSwitch.Options() // switching to another profile's space (ProfileSwitch.swift)
        var switchClock: SwitchClock = RunLoopClock()
        // Seconds since 1970, the clock the extension's focusedAt and createdAt use (tests set it).
        var clock: () -> Double = { Date().timeIntervalSince1970 }
        // Safari's data folder, for its profiles' names (SafariProfiles.swift); nil: not read (the harness, the tests).
        var safariData: URL?
        var safariWatch = SafariProfileWatcher.Options()
        // Safari's data folder, for iCloud Tabs (CloudTabs.swift); nil: not read (the harness, unless a test gives a stand-in).
        var cloudTabsData: URL?
        var cloudWatch = CloudTabsWatcher.Options()
        // macOS's private calls for the profile handoff (PrivateCalls.swift): the system's only in
        // forApp(); nil (every test, the harness): none, and every part they serve stays off.
        var privateResolver: PrivateResolver?
        var privateCallsDefaults: UserDefaults? // where the macOS build last checked is kept; nil: not kept
        // The profile handoff in place of the close-based switch (app/HANDOFF.md, ShellHandoff.swift).
        // Off until gate G1 has passed for Margin.app itself (§10.4): every switch is then the
        // close-based one, exactly as before. `MarginHandoff` in the defaults turns it on (forApp).
        var handoff = false
        // A harness's stand-ins for the Space reads, the parker and the freezer (never the system's):
        // given, they're used as the launch check's would be, with no self-test.
        var handoffParts: HandoffParts?
        // Whether a window's bounds fill its display (R2, a window shown over): the screens' by
        // default (ScreenGeometry.fillsDisplay); a harness's stand-in windows are off every screen.
        var fillsDisplay: ((CGRect) -> Bool)?
        // DEV-HOOK: the dev-only test hook (DevHooks.swift, removed before production): whether
        // MarginDevHooks is YES, read at each notification. Nil (every test, the harness): not listened for.
        var devHooksOn: (() -> Bool)?
        // Which Safari window is which profile's, from Accessibility (SafariAX.swift): only the app (forApp).
        var safariAX = false
        // Safari's View › Show Sidebar item (ShellSafariSidebar.swift; the tests: a stand-in; nil: SafariAX's when on).
        var sidebarMenu: SidebarMenu?
        // The edge stop: the pointer kept off a full-screen Safari window's left edge (EdgeStop.swift); off in the tests.
        var edgeStop = true
        // The window trace (WindowTrace.swift, DEV): only the app's, unless a test gives one.
        var trace: WindowTrace?
        // ⌘Q or ⌥⌘Q handed on to the browser after Margin closed its parked windows (Shell.quitBrowser): the keys
        // posted to its process, as the person pressed them. A test records them instead.
        var passQuitKeys: (pid_t, Bool) -> Void = Shell.postQuitKeys
        // Whether ⌘Q over Margin's layout asks first (Margin's own prompt, QuitPrompt.swift), and its "Always quit"
        // (MarginAskBeforeQuit in the app's defaults; a test keeps its own).
        var asksBeforeQuit: () -> Bool = { UserDefaults.standard.object(forKey: "MarginAskBeforeQuit") as? Bool ?? true }
        var setAskBeforeQuit: (Bool) -> Void = { UserDefaults.standard.set($0, forKey: "MarginAskBeforeQuit") }
    }

    final class Link {
        let connection: LinkConnection
        let mirror = StateMirror()
        var assembler = ChunkAssembler()
        var theme: String? // the theme package's JSON (background/theme-package.ts ThemeMessage)
        var themeId: String?
        var outbox = LayoutOutbox()
        var drawn = DrawnOutbox() // whether the app draws over each window, as told to the copy
        var resyncTimer: Timer?
        var keys: [String: [String]]? // the copy's shortcuts, once it said
        var held = HeldPushes() // what an overlay made later is given with its hello
        var parked: [Int: Bool] = [:] // whether each window is parked, as the copy was told (HANDOFF.md §2.5)
        init(_ connection: LinkConnection) { self.connection = connection }
    }

    let link: SocketLink
    // The lasting data, one set per browser profile (DataSync.swift: the read API is there).
    let data: DataSync
    let windowSource: WindowSource
    let apps: AppWatch
    let shortcuts: AppShortcuts
    private let pointer = PointerWatch()
    private(set) var options: Options
    private lazy var pages = OverlayPages(root: options.root ?? OverlayPages.appRoot)

    private(set) var links: [String: Link] = [:]
    var overlays: [WindowKey: OverlayController] = [:]
    private(set) var matches: [WindowKey: Int] = [:]
    // Safari's own sidebar (ShellSafariSidebar.swift): each window's part on the left once it's appeared; the View menu
    // item's title while the sidebar is closed, by Safari's pid, and when it was last read.
    var safariSidebar: [WindowKey: SafariSidebarState] = [:]
    var sidebarClosedTitle: [pid_t: String] = [:]
    var sidebarTitleReadAt: [pid_t: Double] = [:]
    // The edge stop (EdgeStop.swift) and its fence now.
    let edgeStopper = EdgeStop()
    private(set) var edgeFence: EdgeStop.Fence?
    // Each browser's window bindings (WindowMatcher.swift).
    private(set) var binders: [String: WindowBinder] = [:]
    // Safari's windows as Accessibility reads them, and the profile (link) each one's title named, once known: a
    // window's profile never changes (SafariAX.swift).
    let safariAX = SafariAX()
    private(set) var ax = AXKnown()
    // Every window Margin cares about, as one snapshot (WindowMap.swift, the window module's step 1): kept from each read.
    let windowMap = WindowMap()
    // Each shown overlay's placement, checked on the next maps (OverlayPlacer.swift), and how many maps in a row it was wrong on.
    private var placements: [WindowKey: PlacedOverlay] = [:]
    private var placementMisses: [WindowKey: Int] = [:]
    // Settings Margin sent each copy (shareSettings, carrySettings), to know their echo; when each copy linked.
    var settingsSent: [String: String] = [:]
    var linkedAt: [String: Double] = [:]
    // Profiles whose window Margin asked Safari for during a switch: Safari's pid and that profile's windows before.
    var openedFor: [String: (pid: pid_t, before: [Int])] = [:]
    /// The window numbers Accessibility named as `link`'s.
    func axWindows(of link: String) -> [Int] { ax.profiles.filter { $0.value == link }.map(\.key).sorted() }
    // Covers over Safari's windows until their layouts are ready (ShellCovers.swift).
    var covers: [Int: SafariCover] = [:]
    var coverTimer: Timer?
    var coverExpired: Set<Int> = []
    var coverQuietSince: Double?
    private var axSaid: Set<Int> = []
    // A linked browser has been in front since the first link came up: the shell is at work.
    private(set) var started = false
    private(set) var tracks = 0
    private var pollTimer: Timer?
    private var burstUntil: TimeInterval = 0
    private var trackSoon = false
    private var lastPointerPush: [WindowKey: TimeInterval] = [:]
    private var lastPointer: [WindowKey: CGPoint] = [:]
    private var pointerInside: Set<WindowKey> = []
    private var pointerWanted: Set<WindowKey> = []
    private var trailing: Set<WindowKey> = []
    // Pointer positions handed to overlays' pages (the tests read it).
    private(set) var pointerPushes = 0
    private var stopped = false
    // Links that dropped a moment ago: their overlays kept, dimmed, until this timer.
    private var reconnecting: [String: Timer] = [:]
    // Their theme and keys meanwhile: the overlays stay drawn as the link comes back, not hidden until the theme is sent again.
    // And which browser's, with its process from the last hello: its windows are still read meanwhile.
    private struct Kept {
        var theme: String?
        var themeId: String?
        var keys: [String: [String]]?
        var browser: String
        var pid: Int?
    }
    private var keptForReconnect: [String: Kept] = [:]

    // ---- spaces across profiles (ShellProfiles.swift) ----
    var browserProfiles: [String: BrowserProfiles] = [:]
    lazy var switcher = ProfileSwitch(world: self, clock: options.switchClock, options: options.profileSwitch)
    var acrossSent: [WindowKey: String] = [:]
    var acrossQueued = false
    var spaceAim: [WindowKey: (key: SpaceKey, at: Double)] = [:] // the next/previous keys, chained
    var switchNotice: JSONObject?
    var safariNames: SafariProfileWatcher? // Safari's profile names (ShellProfiles.swift startSafariNames)

    // ---- iCloud Tabs (ShellCloudTabs.swift) ----
    var cloudWatcher: CloudTabsWatcher? // while a Safari copy shows them
    var cloudJSON: String? // what was read last, as the overlays get it
    var cloudSent: [WindowKey: String] = [:]
    var opened: [URL] = [] // a test's: what the overlays asked to open
    var copied: [String] = [] // a test's: what they asked to copy

    // ---- private calls (PrivateCalls.swift, app/HANDOFF.md §4.2) ----
    var privateCalls = PrivateCalls.Availability.off // what the launch check found
    var skyLight: SkyLight? // the functions it passed, behind their wrappers; nil until checked
    // The Space reads and the parker (SpaceReads.swift, BridgeParker.swift), made from what the
    // check passed. Parking is used only once the cross-process self-test passed: parkingOn.
    var spaceReads: SpaceReads?
    var parker: BridgeParker?
    var parkSelfTest = ParkSelfTest.Outcome.notRun
    var parkSelfTestRun: ParkSelfTest?
    var parkingOn: Bool {
        if options.handoffParts != nil { return parker?.isAvailable == true }
        return privateCalls.park && parker?.isAvailable == true && parkSelfTest.passed
    }
    // The parked windows (Parking.swift), made with the parker. Nil: nothing can be parked.
    var parking: ParkingRegistry?

    // ---- the profile handoff in the shell (ShellHandoff.swift) ----
    var freezer: Freezer? // the freeze (RealFreezer, from what the launch check passed), or a harness's
    var heldOut: Set<WindowKey> = [] // overlays a switch ordered out (its A's, §2.3): kept out until it's over
    var windowsHeld: Set<WindowKey> = [] // overlays whose `windows` push waits for their copy's full screen (§2.4)
    var windowsPushes: [WindowKey: Int] = [:] // `windows` pushes given to each overlay (the tests read it)
    var activity: [WindowKey: (tabId: Int?, why: String, timer: Timer)] = [:] // a parked window's use, merged for 150 ms (§6.1)
    var activitySaid: Set<WindowKey> = [] // a person's return already logged as waiting
    var lastExtKeys: Set<WindowKey> = [] // the copies' windows at the last read (a closed shown window, §13.8)
    var marginCloses: Set<WindowKey> = [] // windows Margin itself asked to close outside a switch
    var shownGone = ShownCloseWatch() // windows gone from their copies' lists, judged once no switch runs (§13.8)
    var safariActivated = false // Safari came to the front: §6.2's check is due
    var everyParkedSince: TimeInterval? // §6.2: a read with Safari in front and every window parked
    var paletteOnShow: [WindowKey: Double] = [:] // windows made from another (⌘N): the palette as each first shows
    var parkedEnding = false // §13.8: the shown window was closed, its parked windows closing
    var endingNumbers: Set<Int> = [] // those windows (its Margin window's, app/WINDOWS.md §3)
    var parkedBindAsked: Set<Int> = [] // parked windows the binder was asked to bind from the registry's record
    var devHooks: DevHooks? // DEV-HOOK: the dev-only test hook (DevHooks.swift), only with Options.devHooksOn
    // ---- user themes (ShellThemes.swift) ----
    lazy var userThemes = UserThemes(harness: options.harness)

    init(link: SocketLink, windows: WindowSource, apps: AppWatch, hotKeys: HotKeyRegistrar, options: Options = Options()) {
        self.link = link
        self.windowSource = windows
        self.apps = apps
        self.shortcuts = AppShortcuts(registrar: hotKeys)
        self.options = options
        ownSpaceWanted = options.overlay.ownSpace
        let dataRoot = options.dataRoot
            ?? (options.harness ? FileManager.default.temporaryDirectory.appendingPathComponent("margin-harness-\(UUID().uuidString)", isDirectory: true) : DataStore.appRoot)
        data = DataSync(store: DataStore(root: dataRoot))
        link.delegate = self
        data.onChange = { [weak self] _, collections in
            if collections.contains("spaces") || collections.contains("tabs") { self?.acrossSoon() }
        }
        apps.onChange = { [weak self] why in
            if why == "app launched" || why == "app activated" || why == "Space changed" { self?.coversSoon() }
            if why == "Space changed" || why == "displays changed" { self?.windowMap.spacesChanged(at: Diagnostics.now()) }
            self?.options.trace?.event(why, at: Diagnostics.now())
            if why == "Space changed" { self?.spaceDidChange() } else { self?.appsChanged(why) }
        }
        shortcuts.onCommand = { [weak self] command, isRepeat in self?.run(command, isRepeat: isRepeat) }
        shortcuts.onQuit = { [weak self] keep in self?.quitBrowser(keepWindows: keep) }
        pointer.onMove = { [weak self] at in self?.pointerMoved(at) }
        pointer.onPress = { [weak self] at in self?.pressed(at) }
        if let parts = options.handoffParts { useHandoffParts(parts) }
    }

    // The app's own: Safari through the window server and NSWorkspace, Carbon's hot keys.
    static func forApp() -> Shell {
        var options = Options()
        options.safariData = SafariProfiles.safariFolder
        options.cloudTabsData = SafariProfiles.safariFolder
        // The overlays in their window's Space only (Overlay.swift ownSpaceBehavior), so each is already
        // drawn when its window's Space comes back; on unless MarginOverlayOwnSpace is set to NO.
        options.overlay.ownSpace = UserDefaults.standard.object(forKey: "MarginOverlayOwnSpace") as? Bool ?? true
        Diagnostics.note(options.overlay.ownSpace ? "overlays join only their window's Space (each kept there while it's away)" : "overlays join every Space (MarginOverlayOwnSpace is off)")
        options.privateResolver = RealPrivateResolver()
        options.privateCallsDefaults = .standard
        // The handoff: off until its gates pass (HANDOFF.md §10.4), unless MarginHandoff is set for their runs.
        // On by default since 2026-11-07 (Tirth: the switch to another profile without Safari's slide, its window
        // parked); `defaults write io.tirth.margin MarginHandoff -bool NO` turns it off (the close-based switch).
        options.handoff = UserDefaults.standard.object(forKey: "MarginHandoff") as? Bool ?? true
        Diagnostics.note(options.handoff ? "handoff: on: profile switches hand off when the private calls allow"
                         : "handoff: off (MarginHandoff is NO): every profile switch is the close-based one")
        options.devHooksOn = { DevHooks.appDefault() } // DEV-HOOK
        options.safariAX = true
        options.trace = WindowTrace.forApp()
        if let t = options.trace { Diagnostics.note("window trace: on (\(t.folder.path), numbers only; MarginWindowTrace NO turns it off)") }
        SafariAX.askOnce()
        Diagnostics.note(SafariAX.trusted ? "Accessibility: on (Safari's windows matched by their titles' profiles)" : "Accessibility: not granted (Safari's windows matched by their pages and focus only)")
        return Shell(link: SocketLink(), windows: CGWindowSource(), apps: WorkspaceApps(), hotKeys: CarbonHotKeys(), options: options)
    }

    // At launch, before start() (AppDelegate.startShell): which private calls are there. With no
    // resolver nothing is checked, and the freeze and parking stay off.
    func checkPrivateCalls() {
        guard let resolver = options.privateResolver else { return }
        privateCalls = PrivateCalls.check(resolver: resolver, defaults: options.privateCallsDefaults)
        let sky = SkyLight(resolver: resolver, availability: privateCalls)
        skyLight = sky
        // The freeze's session rules start off when the launch check didn't pass it (Freezer.swift).
        switcher.session.rules = FreezeRules(availability: privateCalls)
        if privateCalls.freeze { freezer = RealFreezer(skyLight: sky) }
        guard privateCalls.spaces else { return }
        let spaces = SkyLightSpaces(sky: sky, availability: privateCalls)
        spaceReads = spaces
        if privateCalls.park {
            let parker = SpaceParker(reads: spaces, bridge: spaces, clock: options.switchClock)
            self.parker = parker
            parking = ParkingRegistry(parker: parker, reads: spaces, clock: options.switchClock, marker: parkingMarkerURL, build: resolver.build,
                                      parkingOn: { [weak self] in self?.parkingOn == true && self?.handoffOn == true })
        }
    }

    func start() {
        stopped = false
        link.start()
        startSafariNames()
        coversSoon()
        startKeyRelay()
        // DEV-HOOK: heard only while MarginDevHooks is YES, and only for Safari's Test A and Test B.
        if let on = options.devHooksOn, devHooks == nil {
            devHooks = DevHooks(world: self, isOn: on)
            devHooks?.listen()
        }
    }

    // Quitting (§6.4, §13.1): the screen revealed if frozen, every parked window closed by its own copy
    // (no drafts check; one whose copy can't be asked returned to its Desktop), 300 ms in all, then the
    // rest. The copies' links stay up until then.
    func stop(then: @escaping () -> Void) {
        guard !stopped else { return stopNow(then) }
        switcher.revealNow(.quit)
        guard let parking else { return stopNow(then) }
        stopped = true // no more reads meanwhile
        pollTimer?.invalidate()
        parking.quit(close: parkedCloser()) { [weak self] _ in self?.stopNow(then) }
    }

    private func stopNow(_ then: @escaping () -> Void) {
        stopped = true
        edgeFence = nil
        edgeStopper.set(nil)
        pollTimer?.invalidate()
        for timer in reconnecting.values { timer.invalidate() }
        reconnecting = [:]
        for t in drawnTimers.values { t.timer.invalidate() }
        drawnTimers = [:]
        shortcuts.set(active: false)
        if let keyRelay { NSEvent.removeMonitor(keyRelay) }
        keyRelay = nil
        pointer.stop()
        apps.stop()
        safariNames?.stop()
        endCovers()
        options.trace?.event("stop", at: Diagnostics.now())
        options.trace?.flush()
        devHooks?.stop() // DEV-HOOK
        devHooks = nil // DEV-HOOK
        cloudWatcher?.stop()
        cloudWatcher = nil
        for overlay in overlays.values { overlay.close() }
        overlays = [:]
        link.stop(why: "Margin.app quit", then: then)
    }

    // ---- links ----

    func linkUp(_ connection: LinkConnection) {
        let entry = Link(connection)
        entry.drawn.grace = options.drawnGrace
        entry.mirror.begin(connection.hello)
        links[connection.key] = entry
        linkedAt[connection.key] = options.clock()
        options.trace?.event("link up \(connection.key)", at: Diagnostics.now())
        data.linkUp(connection)
        // A switch on its way to this profile: given the leaving window's settings as soon as its copy is here.
        if switcher.busy, switcher.target?.profile == connection.key {
            DispatchQueue.main.async { MainActor.assumeIsolated { self.carrySettings(to: connection.key) } }
        }
        if let timer = reconnecting.removeValue(forKey: connection.key) {
            timer.invalidate()
            if let kept = keptForReconnect.removeValue(forKey: connection.key) { (entry.theme, entry.themeId, entry.keys) = (kept.theme, kept.themeId, kept.keys) }
            Diagnostics.note("\(connection.key) is back: its overlays kept")
            for overlay in overlays.values where overlay.key.link == connection.key { overlay.push(raw: #"{"type":"link","state":"linked"}"#) }
        }
        apps.start()
        burst("linked: \(connection.key)")
        if connection.hello.browser == "safari" { safariCopyLinked() }
        acrossSoon()
        cloudTabsCheck()
        switcher.tick()
    }

    func linkReceived(_ connection: LinkConnection, _ message: LinkMessage) {
        guard let entry = links[connection.key], entry.connection === connection else { return }
        switch message {
        case .snapshot, .delta, .windows:
            let windowsBefore = entry.mirror.windows
            switch entry.mirror.apply(message) {
            case .applied:
                entry.resyncTimer?.invalidate()
                forward(message, of: entry, windowsBefore: windowsBefore)
                if case .windows = message { switcher.tick() }
                if case .snapshot = message { acrossSoon(); cloudTabsCheck(); themesTellCopy(entry); themesCheck(entry) }
                if case .delta(_, _, let changes, _) = message, changes["spaces"] != nil { acrossSoon() }
                if case .delta(_, _, let changes, _) = message, changes["settings"] != nil { cloudTabsCheck(); themesCheck(entry); shareSettings(from: entry) }
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
                themesCheck(entry) // the copy's package, or the stored one its settings choose (ShellThemes.swift)
                burst("theme")
            case .refused(let why):
                Diagnostics.warn("\(connection.key): a theme refused: \(why)")
            case .waiting:
                break
            }
        case .data(let kind, let body):
            data.received(connection, kind, body)
        case .push(_, let windowId, let msg):
            entry.held.offer(windowId: windowId, msg)
            let json = jsonString(["type": "push", "msg": msg]) ?? ""
            switch msg["type"] as? String {
            case "keyHeard": return keyHeard(entry, windowId, msg)
            case "palette" where windowId != nil: return palettePush(entry, windowId!, json, newTab: msg["newTab"] as? Bool == true)
            default: break
            }
            for overlay in overlays(of: entry) where windowId == nil || overlay.key.windowId == windowId { overlay.push(raw: json) }
        case .keys(let epoch, let bindings):
            guard epoch == connection.epoch else { return }
            entry.keys = bindings
            burst("keys")
        case .parkedActivity(let epoch, let activity):
            guard epoch == connection.epoch else { return }
            parkedActivity(entry, activity)
        default:
            break
        }
    }

    func linkDown(_ connection: LinkConnection, _ why: String) {
        guard let entry = links[connection.key], entry.connection === connection else { return }
        options.trace?.event("link down \(connection.key)", at: Diagnostics.now())
        entry.resyncTimer?.invalidate()
        links[connection.key] = nil
        data.linkDown(connection)
        let shown = overlays(of: entry)
        ownSpaceSuspects = ownSpaceSuspects.filter { $0.key.link != connection.key }
        // Dropped (not replaced, not a goodbye, not quitting): kept, dimmed, for a while.
        if why != "replaced", !why.hasPrefix("stopped"), !why.hasPrefix("bye"), options.reconnectGrace > 0, !shown.isEmpty {
            for overlay in shown { overlay.push(raw: #"{"type":"link","state":"reconnecting"}"#) }
            reconnecting[connection.key]?.invalidate()
            let key = connection.key
            let hello = connection.hello
            keptForReconnect[key] = Kept(theme: entry.theme, themeId: entry.themeId, keys: entry.keys, browser: hello.browser, pid: hello.pid)
            reconnecting[key] = Timer.scheduledTimer(withTimeInterval: options.reconnectGrace, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.reconnectGaveUp(key) }
            }
            // The browser not in front: nothing of it on screen is worth keeping (the relink shows them again).
            var pids = options.bundleIds[hello.browser].map { apps.pids(of: $0) } ?? []
            if let pid = hello.pid { pids.insert(pid_t(pid)) }
            let inFront = apps.frontPid.map(pids.contains) ?? false
            if !inFront { for overlay in shown { overlay.hide("its link dropped while the browser isn't in front") } }
            Diagnostics.note("\(key) dropped (\(why)): its overlays kept, dimmed, for \(Int(options.reconnectGrace)) s\(inFront ? " while their windows stay as they are" : ", put away (the browser isn't in front)")")
        } else {
            for overlay in shown {
                overlay.close()
                overlays[overlay.key] = nil
            }
        }
        // (Still following the windows while a dropped link's overlays are kept.)
        if links.isEmpty && reconnecting.isEmpty { started = false }
        ownSpaceResetIfIdle()
        burst("link down: \(connection.key)")
        acrossSoon()
        cloudTabsCheck()
        switcher.tick()
    }

    // A profile's Margin tabs that aren't open: all of them for a profile not
    // linked, else those no open tab of its copy's state carries (openTabs.tabs[*].mid).
    func notOpenTabs(_ p: DataProfile, space: String? = nil) -> [(id: String, value: JSONObject)] {
        let open: Set<String>
        if let entry = links[p.key], entry.mirror.hasState, let records = (entry.mirror.value("openTabs") as? JSONObject)?["tabs"] as? JSONObject {
            open = Set(records.values.compactMap { ($0 as? JSONObject)?["mid"] as? String })
        } else {
            open = []
        }
        return data.marginTabs(of: p, space: space).filter { !open.contains($0.id) }
    }

    // ---- what a copy pushed that the shell weighs first ----

    // A palette for one window (Safari's New Tab handed off, Margin's new-tab page): to its overlay if
    // that's shown. Not shown yet (being made, or its window not bound yet): held up to `paletteHold`
    // and given to it as it shows; dropped after that, so a palette never opens in an overlay that
    // isn't on screen (where it took the keyboard unseen: "took the keyboard, but it isn't shown").
    // Dropped, the copy is told at once that the app doesn't draw over the window (`drawn` off, without
    // the grace: its new-tab page shows its own notice and address field) and, for Safari's New Tab
    // it handed off (`newTab`, the new tab already closed), asked to open Margin's new-tab page there
    // (`paletteDropped`), so ⌘T still opens something in the moments before the copy would have heard.
    static let paletteHold: TimeInterval = 1.5
    private var heldPalette: [WindowKey: (json: String, until: TimeInterval, newTab: Bool)] = [:]
    private func palettePush(_ entry: Link, _ windowId: Int, _ json: String, newTab: Bool) {
        let key = WindowKey(link: entry.connection.key, windowId: windowId)
        // A parked window, or one a switch is moving (§2.4): nothing to show it in, and nothing to tell
        // its copy (its `drawn` stays on, and Margin's new-tab page never opens there).
        if let held = handoffHolds(key) { return Diagnostics.note("palette push for window \(windowId) (\(key)): dropped: \(held)") }
        if let overlay = overlays[key], overlay.isShown, matches[key] != nil { return overlay.push(raw: json) }
        let why = overlays[key] == nil ? "no overlay drawn there" : matches[key] == nil ? "no overlay drawn there (its window isn't bound)" : "its overlay isn't shown yet"
        Diagnostics.note("palette push for window \(windowId) (\(key)): \(why): held \(Shell.paletteHold) s for it to show")
        heldPalette[key] = (json, Diagnostics.now() + Shell.paletteHold, newTab || heldPalette[key]?.newTab == true)
        DispatchQueue.main.asyncAfter(deadline: .now() + Shell.paletteHold + 0.05) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let held = self.heldPalette[key], Diagnostics.now() >= held.until else { return }
                self.heldPalette[key] = nil
                self.paletteDropped(key, newTab: held.newTab)
            }
        }
    }
    private func paletteDropped(_ key: WindowKey, newTab: Bool) {
        Diagnostics.note("palette push for window \(key.windowId) (\(key)) dropped: no overlay was shown there within \(Shell.paletteHold) s\(newTab ? "; its copy asked to open Margin's new-tab page there" : "")")
        guard let entry = links[key.link] else { return }
        if entry.drawn.notShown(windowId: key.windowId, now: Diagnostics.now()) { sendDrawn(entry, key, false, "a palette for it couldn't be shown") }
        guard newTab else { return }
        Task { _ = try? await entry.connection.request(type: "paletteDropped", payload: ["windowId": key.windowId, "newTab": true], windowId: key.windowId) }
    }
    // An overlay just shown: a palette held for it, if it's still fresh.
    private func deliverHeldPalette(_ overlay: OverlayController) {
        guard let held = heldPalette.removeValue(forKey: overlay.key), Diagnostics.now() <= held.until else { return }
        Diagnostics.note("palette push for \(overlay.key): given to its overlay as it showed")
        overlay.push(raw: held.json)
    }
    // Whether a palette is held for a window (tests read it).
    func holdsPalette(_ key: WindowKey) -> Bool { heldPalette[key] != nil }

    // A key the app holds heard by the copy anyway (its command, or a page): logged here, with
    // whether the app's hot keys were on then and, if not, why.
    private func keyHeard(_ entry: Link, _ windowId: Int?, _ msg: JSONObject) {
        let command = msg["command"] as? String ?? "a key"
        let from = msg["from"] as? String ?? "the copy"
        let at = windowId.map { "\(WindowKey(link: entry.connection.key, windowId: $0))" } ?? entry.connection.key
        let front = frontOverlay()
        let state: String
        if shortcuts.isActive {
            state = "the app's hot keys were on (the front overlay: \(front.map { "\($0.key)" } ?? "none")): another combination, or Safari's own command"
        } else if apps.frontPid == nil {
            state = "the app's hot keys were off: no app in front"
        } else if !linkedPids().values.contains(where: { $0.contains(apps.frontPid!) }) {
            state = "the app's hot keys were off: the front app isn't a linked browser"
        } else {
            state = "the app's hot keys were off: \(keysOffReason(front: front))"
        }
        Diagnostics.note("\(at): \(command) reached the extension (\(from)): \(state)")
    }

    // Why the keys are off with a linked browser in front (`front`: the overlay over its front window, if any).
    private func keysOffReason(front: OverlayController?) -> String {
        guard let front else {
            let shown = overlays.values.filter(\.isShown).count
            return "the front window has no overlay shown (\(shown) shown elsewhere; the front window read: \(lastFrontWindow.map(String.init) ?? "none"))"
        }
        return "the overlay over the front window (\(front.key)) doesn't hold them"
    }

    // The copy didn't come back in time: its overlays go.
    private func reconnectGaveUp(_ key: String) {
        reconnecting[key] = nil
        keptForReconnect[key] = nil
        guard links[key] == nil else { return }
        for overlay in overlays.values where overlay.key.link == key {
            overlay.close()
            overlays[overlay.key] = nil
        }
        Diagnostics.note("\(key) didn't come back: its overlays closed")
        if links.isEmpty && reconnecting.isEmpty { started = false }
        ownSpaceResetIfIdle()
        burst("gave up on \(key)")
    }

    // Whether a link's overlays are kept for it to come back (tests read it).
    func isReconnecting(_ key: String) -> Bool { reconnecting[key] != nil }

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

    // What came, to each of the copy's overlays (each page keeps its own copy of the state).
    // `windowsBefore`: the copy's window list before a `windows` message.
    private func forward(_ message: LinkMessage, of entry: Link, windowsBefore: [JSONObject] = []) {
        let shown = overlays(of: entry)
        switch message {
        case .snapshot:
            guard let state = entry.mirror.stateJSON() else { return }
            let json = #"{"type":"state","state":"# + String(decoding: state, as: UTF8.self) + #","windows":"# + (jsonString(entry.mirror.windows) ?? "[]") + "}"
            for overlay in shown { overlay.push(raw: json) }
            burst("snapshot")
        case .delta(_, _, let changes, let favicons):
            var out: JSONObject = [:]
            for (key, change) in changes {
                switch change {
                case .set(let value): out[key] = ["newValue": value]
                case .removed: out[key] = [String: Any]()
                }
            }
            var message: JSONObject = ["type": "changes", "changes": out]
            if let favicons { message["favicons"] = ["set": favicons.set, "del": favicons.del] }
            guard let json = jsonString(message) else { return }
            for overlay in shown { overlay.push(raw: json) }
        case .windows(_, _, let list):
            // Only the pages' words of being shown changed (a tab switch says hidden, then shown): nothing an
            // overlay draws from, and nothing to follow at once unless one of the copy's windows isn't bound
            // yet (the visible rule binds from them; one read then, not a burst). A fast run of tab switches
            // brings several of these each, on the main thread with the keys and the highlight.
            if Shell.onlyVisibilityChanged(windowsBefore, list) {
                if list.contains(where: { w in int(w["windowId"] ?? w["id"]).map { matches[WindowKey(link: entry.connection.key, windowId: $0)] == nil } ?? false }) { soon() }
                return
            }
            let json = jsonString(["type": "windows", "list": list]) ?? ""
            for overlay in shown {
                // A parked window's overlay, or one a switch is moving, hears no list until its copy says
                // the window is in full screen (§2.4): its mode stays full screen, so no layout changes.
                if windowsWait(overlay.key, list) { windowsHeld.insert(overlay.key); continue }
                windowsHeld.remove(overlay.key)
                pushWindows(overlay, json)
            }
            burst("windows")
        default:
            break
        }
    }

    // Whether two window lists of a copy differ only in their pages' words of being shown (`visible`,
    // `visibleAt`: app/PROTOCOL.md `windows`).
    static func onlyVisibilityChanged(_ before: [JSONObject], _ after: [JSONObject]) -> Bool {
        guard before.count == after.count, !after.isEmpty else { return false }
        let strip = { (list: [JSONObject]) -> [JSONObject] in list.map { $0.filter { $0.key != "visible" && $0.key != "visibleAt" } } }
        return zip(strip(before), strip(after)).allSatisfy { NSDictionary(dictionary: $0).isEqual(to: $1) }
    }

    private func overlays(of entry: Link) -> [OverlayController] {
        overlays.values.filter { $0.key.link == entry.connection.key }.sorted { $0.key < $1.key }
    }

    // ---- following the windows ----

    // The active Space changed (NSWorkspace activeSpaceDidChangeNotification): read the window server
    // now, not on the next turn, so an overlay whose window left the screen with the Space is put away
    // at once (it's in every Space: Overlay.swift collectionBehavior), and one comes back only when
    // the window server says its window is on screen.
    private(set) var spaceChangedAt: TimeInterval = -.infinity
    // The same, on the extension's clock (options.clock), for the binders (WindowMatcher.swift: which pages are shown).
    private var spaceChangedWall: Double = -.infinity
    var spaceChanged: Bool { Diagnostics.now() - spaceChangedAt < options.burstFor }
    func spaceDidChange() {
        spaceChangedAt = Diagnostics.now()
        spaceChangedWall = options.clock()
        let shown = overlays.values.filter(\.isShown).count
        Diagnostics.note("the active Space changed (\(shown) overlay\(shown == 1 ? "" : "s") shown, the browser \(browserIsFront ? "in front" : "not in front"))")
        burstUntil = Diagnostics.now() + options.burstFor
        track()
    }
    private var browserIsFront: Bool {
        guard let front = apps.frontPid else { return false }
        return linkedPids().values.contains { $0.contains(front) }
    }

    // An overlay just placed in its window's own Space: checked a moment later that macOS has it on
    // screen together with its window. If not (macOS put it in another Space, or kept it out), every
    // overlay goes back to joining every Space until the browser's links and overlays are all gone
    // (ownSpaceResetIfIdle), and the log says why.
    private(set) var ownSpaceFellBack = false
    private let ownSpaceWanted: Bool // options.overlay.ownSpace as the shell started
    private var ownSpaceChecks: Bool { !options.harness || options.harnessOwnSpaceCheck }
    // Only for an overlay just shown, and judged only if it's been shown since then: a check asked for an
    // overlay that couldn't be shown yet (its page not drawn: every read while Safari opens) would otherwise
    // judge it the moment it's shown, before macOS lists it on screen, and every overlay would join every Space
    // for the rest of that run of Safari (Tirth's log 2026-11-07, at each launch: the sidebar then put away for
    // every swipe and back 1.5-5 s later).
    private func checkOwnSpace(_ overlay: OverlayController, browser number: Int) {
        guard !ownSpaceFellBack, ownSpaceChecks, overlay.isShown else { return }
        let asked = Diagnostics.now()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak overlay] in
            MainActor.assumeIsolated {
                guard let self, let overlay, overlay.isShown, overlay.shownAt <= asked, overlay.aboveWindow == number, overlay.ownSpace else { return }
                let list = self.windowSource.windows(of: [ProcessInfo.processInfo.processIdentifier, overlay.browserPid])
                let mine = list.first { $0.number == overlay.windowNumber }
                let browser = list.first { $0.number == number }
                guard let browser, browser.onScreen else { return } // its window went away meanwhile: nothing to judge
                if mine?.onScreen == true { return }
                self.ownSpaceFallBack("an overlay placed in its window's Space isn't on screen with it")
                overlay.hide("moved to every Space")
            }
        }
    }

    private func ownSpaceFallBack(_ why: String) {
        guard !ownSpaceFellBack else { return }
        ownSpaceFellBack = true
        ownSpaceSuspects = [:]
        options.overlay.ownSpace = false
        Diagnostics.warn("\(why): overlays join every Space again, until no link and no overlay is left")
        for o in overlays.values { o.joinEverySpace() }
        burst("own Space fallback")
    }

    // An overlay in its window's own Space read as on screen while its window isn't. A window closing,
    // or every window of a browser quitting, is ordered out a read or so before it leaves the window
    // server's list (Tirth's log, 21:57:20: 73 ms), so one read proves nothing: the overlay is put away
    // at once and the window looked at again. Only a later read, `ownSpaceWait` on or more, with no
    // Space change since, the link up, the window still its copy's and bound to the same window, that
    // still lists the window as off screen falls back (judgeOwnSpace).
    static let ownSpaceWait: TimeInterval = 0.3
    private struct OwnSpaceSuspicion { let number: Int; let at: TimeInterval }
    private var ownSpaceSuspects: [WindowKey: OwnSpaceSuspicion] = [:]
    // Whether an overlay's window is being looked at again (tests read it).
    func suspectsOwnSpace(_ key: WindowKey) -> Bool { ownSpaceSuspects[key] != nil }

    private func suspectOwnSpace(_ overlay: OverlayController, number: Int) {
        guard ownSpaceSuspects[overlay.key] == nil else { return }
        let now = Diagnostics.now()
        ownSpaceSuspects[overlay.key] = OwnSpaceSuspicion(number: number, at: now)
        let since = spaceChangedAt == -.infinity ? "no Space change since the start" : "the Space changed \(Int((now - spaceChangedAt) * 1000)) ms ago"
        Diagnostics.note("\(overlay.key): its overlay (window \(overlay.windowNumber)) reads on screen while its window \(number) is listed off screen (\(since)): put away; looked at again in \(Int(Shell.ownSpaceWait * 1000)) ms before overlays join every Space")
    }

    /// Why a suspicion (an overlay read on screen while its window `number` wasn't) is dropped, or nil to keep it.
    static func ownSpaceCleared(number: Int, linkUp: Bool, parkedOrMoving: Bool, inCopy: Bool, bound: Int?, spaceChanged: Bool,
                                shownAgain: Bool, server: ServerWindow?) -> String? {
        if !linkUp { return "its link went down" }
        if parkedOrMoving { return "its window is parked, or a switch is moving it" }
        if !inCopy { return "its copy no longer has the window (closed)" }
        if bound != number { return "it's no longer bound to window \(number)" }
        if spaceChanged { return "the active Space changed since" }
        // Put away as suspect and shown again since: placed in its window's Space ahead of a visit (a placement of
        // its own, with its own check: Overlay.aheadPending), or on screen with its window. The old read says
        // nothing of where it is now.
        if shownAgain { return "its overlay was placed again since" }
        guard let server else { return "window \(number) left the window server's list (closed, or the browser quit)" }
        return server.onScreen ? "window \(number) is on screen again" : nil
    }

    // Each suspicion, on a read that told something: dropped, kept for a later read, or the fallback.
    private func judgeOwnSpace(_ ext: [WindowKey: (ExtWindow, Link)], _ byNumber: [Int: ServerWindow]) {
        let now = Diagnostics.now()
        for (key, s) in ownSpaceSuspects.sorted(by: { $0.key < $1.key }) {
            let o = overlays[key]
            let cleared = Shell.ownSpaceCleared(number: s.number, linkUp: links[key.link] != nil, parkedOrMoving: isParkedKey(key) || inSwitch(key),
                                                inCopy: ext[key] != nil, bound: matches[key], spaceChanged: spaceChangedAt > s.at,
                                                shownAgain: o.map { $0.isShown && $0.shownAt > s.at } ?? false, server: byNumber[s.number])
            if let cleared {
                ownSpaceSuspects[key] = nil
                Diagnostics.note("\(key): no own-Space fallback: \(cleared)")
                continue
            }
            guard now - s.at >= Shell.ownSpaceWait else { continue }
            ownSpaceSuspects[key] = nil
            ownSpaceFallBack("\(key): its overlay read on screen while its window \(s.number) didn't, and \(Int((now - s.at) * 1000)) ms later the window is still listed off screen, with no Space change, the link up and the window its copy's")
        }
    }

    // No link and no overlay left (the browser quit, or every copy gone): a fallback was for that run of
    // the browser; overlays made from now on join only their window's Space again, if that's the setting.
    private func ownSpaceResetIfIdle() {
        guard ownSpaceFellBack || options.overlay.ownSpace != ownSpaceWanted, links.isEmpty, reconnecting.isEmpty, overlays.isEmpty else { return }
        ownSpaceFellBack = false
        ownSpaceSuspects = [:]
        options.overlay.ownSpace = ownSpaceWanted
        if ownSpaceWanted { Diagnostics.note("no link and no overlay left: overlays join only their window's Space again") }
    }

    // A slow read of the window server and all that follows it, in the log (at most every 10 s).
    private var slowTrackSaidAt: TimeInterval = -.infinity
    private var slowTracksUnsaid = 0
    private(set) var slowestTrack: TimeInterval = 0
    private func trackTook(_ s: TimeInterval) {
        slowestTrack = max(slowestTrack, s)
        guard s > 0.008 else { return }
        let now = Diagnostics.now()
        guard now - slowTrackSaidAt > 10 else { slowTracksUnsaid += 1; return }
        Diagnostics.note(String(format: "slow: following the windows took %.1f ms (%d overlays)%@", s * 1000, overlays.count, slowTracksUnsaid > 0 ? "; \(slowTracksUnsaid) more since the last line" : ""))
        slowTrackSaidAt = now
        slowTracksUnsaid = 0
    }

    /// What the shell kept of an overlay for a window (what it was sent, where it was placed, its checks): forgotten
    /// when the overlay goes to another window (a switch's hand-over), so the new one is sent and checked afresh.
    func forgetOverlayState(_ key: WindowKey) {
        placements[key] = nil; placementMisses[key] = nil; frameSaid[key] = nil; reorderedAt[key] = nil; joinTriedAt[key] = nil
        aheadFailedAt[key] = nil; ownSpaceSuspects[key] = nil; lastPointerPush[key] = nil; lastPointer[key] = nil; safariSidebar[key] = nil
        acrossSent[key] = nil; cloudSent[key] = nil
    }

    /// Whether a window its copy says it had parked before Safari quit is closed now: not one Margin has parked now
    /// (a Margin update keeps them alive and out of sight), not in full screen (a restored parked window comes back
    /// normal), and asked once.
    static func closesRestoredParked(wasParked: Bool, parkedNow: Bool, state: String, asked: Bool) -> Bool {
        wasParked && !parkedNow && state != "fullscreen" && !asked
    }

    // Parked windows Safari restored after a quit, as normal windows on the Desktop (Tirth, 2026-11-07): closed by
    // their own copy, as Margin's quit closes parked ones (their tabs stay in their spaces, not open).
    private var restoredClosed: Set<WindowKey> = []
    private func closeRestoredParked(_ ext: [WindowKey: (ExtWindow, Link)]) {
        for (key, (w, entry)) in ext.sorted(by: { $0.key < $1.key }) {
            let parkedNow = isParkedKey(key) || matches[key].map { parking?.numbers.contains($0) == true } == true
            guard Shell.closesRestoredParked(wasParked: w.wasParked, parkedNow: parkedNow, state: w.state, asked: restoredClosed.contains(key)) else { continue }
            restoredClosed.insert(key)
            Diagnostics.note("\(key): a window Margin had parked before Safari quit, restored by Safari: closed (its tabs stay in their spaces)")
            options.trace?.event("closeRestoredParked \(key)", at: Diagnostics.now())
            Task { [weak entry] in _ = try? await entry?.connection.request(type: "closeWindow", payload: ["windowId": key.windowId], windowId: key.windowId) }
        }
    }

    // The placer's check (OverlayPlacer.swift): each shown overlay's placement against this read's map, fixed on the
    // second map in a row it's wrong on (moved into its window's Space, or ordered in again over it); a frame not
    // the one asked only said. Each fix in the log and the trace. Not in the test harness (its windows have no Spaces).
    private var frameSaid: [WindowKey: Double] = [:]
    private var reorderedAt: [WindowKey: Double] = [:]
    private func checkPlacements() {
        guard !options.harness else { return }
        let now = Diagnostics.now()
        let canMove = (spaceReads as? SpaceBridge)?.canPark == true
        for (key, p) in placements.sorted(by: { $0.key < $1.key }) {
            guard let overlay = overlays[key], overlay.isShown, overlay.aboveWindow == p.window, !inSwitch(key) else {
                placements[key] = nil; placementMisses[key] = nil; continue
            }
            let r = PlacementCheck.check(p, map: windowMap.snapshot, now: now, canMove: canMove, misses: placementMisses[key] ?? 0)
            placementMisses[key] = r.wrong ? (placementMisses[key] ?? 0) + 1 : 0
            guard let fix = r.fix else { continue }
            switch fix {
            case .join(let space):
                joinSpace(overlay, space: space)
            case .reorder(let why):
                // (At most every 2 s for each: one that stays off screen isn't ordered in on every read.)
                guard now - (reorderedAt[key] ?? -.infinity) >= 2 else { continue }
                reorderedAt[key] = now
                Diagnostics.note("\(key): its overlay \(why) (checked against the map): ordered in again over window \(p.window)")
                overlay.reorder()
                placementMisses[key] = 0
            case .frame(let at):
                guard now - (frameSaid[key] ?? -.infinity) >= 30 else { continue }
                frameSaid[key] = now
                Diagnostics.note("\(key): its overlay is at \(WindowMatcher.describe(at)), not \(WindowMatcher.describe(p.frame)) as asked")
            }
            options.trace?.event("placer \(key) \(fix)", at: now)
        }
    }

    /// Whether an overlay is in front of its browser window (and behind its toolbar): the read's list first (cheap);
    /// when that says no, asked exactly (the windows in front of the browser's window), since the every-window list's
    /// order isn't front to back between Margin's windows and Safari's (Tirth's trace 2026-11-07): an overlay already
    /// in front isn't ordered in again on every read, and a switch's R4 isn't held back by a wrong "behind".
    func isStacked(_ list: [ServerWindow], overlay: OverlayController, browser: ServerWindow, toolbar: Int?) -> Bool {
        if WindowMatcher.stackedAbove(list, overlay: overlay.windowNumber, browser: browser.number, toolbar: toolbar, own: overlay.catcherWindowNumbers) { return true }
        guard let above = windowSource.above(browser.number) else { return false }
        return WindowMatcher.stackedAboveExactly(aboveBrowser: above, aboveToolbar: toolbar.flatMap { windowSource.above($0) } ?? (toolbar == nil ? nil : []),
                                                overlay: overlay.windowNumber, browser: browser.bounds, browserPid: browser.pid, own: overlay.catcherWindowNumbers)
    }

    // A shown overlay in its window's own Space, checked against the map on each read: in another Space, it's moved
    // into its window's (the Space bridge), at most once a second for each. Tirth's trace 2026-11-07 11:32:51: a
    // switch brought a parked window back into a new full-screen Space and macOS removed its old one, moving the
    // overlay kept hidden there to the Desktop: no sidebar over Safari after the switch, and the sidebar on the
    // Desktop when he swiped there.
    private var joinTriedAt: [WindowKey: Double] = [:]
    // (Read from SkyLight there and then, not the map's last read, when it was just shown or the map has it off screen
    // while its window is on: the map reads a window's Spaces only when it moves, goes on or off screen, or each second.)
    private func keepInWindowSpace(_ overlay: OverlayController, number: Int, justShown: Bool) {
        guard !options.harness, let reads = spaceReads, let bridge = reads as? SpaceBridge, bridge.canPark else { return }
        let snap = windowMap.snapshot
        let mine = snap.windows[overlay.windowNumber], theirs = snap.windows[number]
        let fresh = justShown || (theirs?.onScreen == true && mine?.onScreen != true)
        let overlaySpaces = fresh ? reads.spaces(of: overlay.windowNumber) : mine?.spaces
        let windowSpaces = fresh ? reads.spaces(of: number) : theirs?.spaces
        guard let target = OverlayPlanner.spaceToJoin(overlay: overlaySpaces, window: windowSpaces,
                                             windowOnScreen: theirs?.onScreen == true, showing: snap.showing) else { return }
        joinSpace(overlay, space: target, was: overlaySpaces)
    }

    // An overlay's windows moved into its window's Space (the Space bridge), at most once a second for each; the
    // map reads Spaces again on the next read, so the move is checked there.
    private func joinSpace(_ overlay: OverlayController, space: UInt64, was: [UInt64]? = nil) {
        guard let bridge = spaceReads as? SpaceBridge, bridge.canPark else { return }
        let now = Diagnostics.now()
        guard now - (joinTriedAt[overlay.key] ?? -.infinity) >= 1 else { return }
        joinTriedAt[overlay.key] = now
        let moved = overlay.spaceWindowNumbers.allSatisfy { bridge.add($0, to: space) }
        windowMap.spacesChanged(at: now)
        let from = was ?? windowMap.snapshot.windows[overlay.windowNumber]?.spaces ?? []
        Diagnostics.note("\(overlay.key): its overlay was in Space \(from) while its window is in \(space): \(moved ? "moved into its window's Space" : "couldn't be moved")")
    }

    // An overlay placed in its full-screen window's Space ahead of a visit (Overlay.placeAhead): only an overlay
    // in its window's own Space, a full-screen window in a full-screen Space, the Space bridge passed at launch,
    // no switch moving it; a failed placement waits 5 s before the next try.
    private var aheadFailedAt: [WindowKey: Double] = [:]
    private var lastSwitchBusyAt: Double = -.infinity
    private func placeAhead(_ overlay: OverlayController, key: WindowKey, w: ExtWindow, number: Int, server: ServerWindow) -> Bool {
        // (Not within 3 s of a switch: its windows' Spaces were just changed, and a read may still give the old one.)
        if switcher.busy { lastSwitchBusyAt = Diagnostics.now() }
        guard !options.harness, overlay.ownSpace, !ownSpaceFellBack, w.state == "fullscreen", !inSwitch(key), !isParkedKey(key),
              !switcher.busy, Diagnostics.now() - lastSwitchBusyAt >= 3,
              let reads = spaceReads, let bridge = reads as? SpaceBridge, bridge.canPark,
              Diagnostics.now() - (aheadFailedAt[key] ?? -.infinity) >= 5 else { return false }
        // (A window Accessibility read as not full screen: no SkyLight calls. One it read as full screen is still
        // checked with SkyLight, as entering full screen says so before the window is in its own Space.)
        guard ax.fullScreen[number] != false, let space = reads.spaces(of: number)?.first, reads.fullScreenSpaces()?.contains(space) == true else { return false }
        let viewport = w.viewport
        let docked = Shell.dockedLeft(overlay)
        let frame = Shell.overlayFrame(window: server.bounds, viewport: viewport, dockedLeft: docked)
        overlay.windowFrame = server.bounds
        overlay.size(to: frame)
        overlay.browserPid = server.pid
        let placed = overlay.placeAhead(over: number, frame: frame) { numbers in numbers.allSatisfy { bridge.add($0, to: space) } }
        if !placed { aheadFailedAt[key] = Diagnostics.now() }
        return placed
    }

    // Safari's windows' profiles from Accessibility: known ones at once, unknown ones asked for (the answer
    // comes back on the main thread and reads again). Safari's events heard too (SafariAX.watch): a window
    // created, closed, moved or resized reads the window server at once. Window numbers only: no title is kept
    // or logged.
    func safariExact(list: [ServerWindow], pids: Set<pid_t>) -> [Int: String] {
        guard options.safariAX, SafariAX.trusted, let pid = pids.first else { return [:] }
        let wanted = Set(WindowMatcher.candidates(list, pids: pids).map(\.number))
        ax.keep(listed: Set(list.map(\.number)))
        safariAX.watch(pid: pid) { [weak self] e in self?.axEvent(e) }
        if !wanted.subtracting(ax.profiles.keys).isEmpty {
            safariAX.refresh(pid: pid, wanted: wanted) { [weak self] found in
                guard let self, !self.stopped else { return }
                if !self.axLearn(found).isEmpty { self.burst("Accessibility named a window's profile") }
            }
        }
        return ax.profiles.filter { wanted.contains($0.key) }
    }

    // What Accessibility read of Safari's windows, kept; the windows whose profile it named now.
    @discardableResult
    func axLearn(_ found: [Int: SafariAX.Window]) -> [Int] {
        let names = profilesOf("safari").browserNames.mapValues(\.name)
        let learned = ax.learn(found, names: names)
        for n in learned where !axSaid.contains(n) {
            axSaid.insert(n)
            Diagnostics.note("Accessibility: window \(n) is \(ax.profiles[n] ?? "?")'s\(found[n]?.fullScreen == true ? " (full screen)" : "")")
        }
        return learned
    }

    // One of Safari's Accessibility events: the window server read at once (a new window's layout, a window
    // in or out of full screen, a closed one's overlay put away), not at the next poll.
    func axEvent(_ e: SafariAX.Event) {
        guard !stopped else { return }
        options.trace?.event({ switch e { case .window(let w): "ax window \(w.number)\(w.fullScreen ? " full" : "")"; case .gone(let n): "ax gone \(n)"; case .watching(let on): "ax watching \(on)" } }(), at: Diagnostics.now())
        switch e {
        case .window(let w):
            axLearn([w.number: w])
            burst("Accessibility: a window changed")
        case .gone(let n):
            ax.gone(n)
            burst("Accessibility: a window closed")
        case .watching(let on):
            guard on != axWatching else { return }
            axWatching = on
            Diagnostics.note(on ? "Accessibility: Safari's window events heard (new, closed, moved, resized)" : "Accessibility: Safari's window events not heard yet (tried again in 1 s)")
        }
    }
    private var axWatching: Bool?

    // Read the window server often for a while (something is moving).
    func burst(_ why: String) {
        burstUntil = Diagnostics.now() + options.burstFor
        soon()
    }

    // A read on the next turn of the run loop (several reasons at once: one read).
    private func soon() {
        guard !trackSoon, !stopped else { return }
        trackSoon = true
        DispatchQueue.main.async { MainActor.assumeIsolated {
            self.trackSoon = false
            self.track()
        } }
    }

    // Each linked browser's processes. `reconnecting`: a dropped link's browser too (from its last
    // hello), for reading its windows while its overlays are kept; not for the keys (nothing would take them).
    private func linkedPids(reconnecting withKept: Bool = false) -> [String: Set<pid_t>] {
        var out: [String: Set<pid_t>] = [:]
        func add(_ browser: String, _ pid: Int?) {
            var pids = options.bundleIds[browser].map { apps.pids(of: $0) } ?? []
            if let pid { pids.insert(pid_t(pid)) }
            out[browser, default: []].formUnion(pids)
        }
        for entry in links.values { add(entry.connection.hello.browser, entry.connection.hello.pid) }
        if withKept { for (key, kept) in keptForReconnect where reconnecting[key] != nil { add(kept.browser, kept.pid) } }
        return out
    }

    private var lastBrowserOnScreen: Set<Int> = []

    // Whether two bounds have the same size (to a point): a window offset in a slide is the same window.
    static func sameSize(_ a: CGRect, _ b: CGRect) -> Bool { abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1 }

    // One read of the window server, and everything that follows from it.
    func track() {
        pollTimer?.invalidate()
        pollTimer = nil
        guard !stopped else { return }
        let began = Diagnostics.now()
        defer { trackTook(Diagnostics.now() - began) }
        // (A dropped link's browser too, while its overlays are kept: they're checked against its windows.)
        let byBrowser = linkedPids(reconnecting: true)
        let readPids = byBrowser.values.reduce(into: Set<pid_t>()) { $0.formUnion($1) }
        let allPids = linkedPids().values.reduce(into: Set<pid_t>()) { $0.formUnion($1) } // the keys': live links only
        let front = apps.frontPid
        let browserInFront = front.map(readPids.contains) ?? false
        if !started {
            guard browserInFront else { return updateKeys(list: [], allPids: allPids) } // nothing until a linked browser is in front
            started = true
            Diagnostics.note("a linked browser is in front: following its windows")
        }
        tracks += 1
        var own = readPids
        own.insert(ProcessInfo.processInfo.processIdentifier)
        let read = windowSource.read(of: own)
        let list = read ?? []
        let byNumber = Dictionary(list.map { ($0.number, $0) }, uniquingKeysWith: { a, _ in a })
        // The browser's windows coming on or going off screen (a swipe between full-screen windows starts; macOS
        // says the Space changed only once it's over): read often for a moment, so a window bound as it slides
        // in has its overlay as soon as it's in place.
        if read != nil {
            let onScreen = Set(WindowMatcher.candidates(list, pids: readPids).filter(\.onScreen).map(\.number))
            if onScreen != lastBrowserOnScreen { burstUntil = max(burstUntil, Diagnostics.now() + options.burstFor) }
            lastBrowserOnScreen = onScreen
        }

        // Each browser's windows, bound (WindowBinder: it logs every binding made, moved or dropped, and why).
        var next: [WindowKey: Int] = [:]
        // Each browser's windows no binding has (for `drawn` while a window waits to be told apart: updateDrawn).
        var freeWindows: [String: [ServerWindow]] = [:]
        // Bound windows this read didn't list (a blip: their overlays are kept where they are, unseen).
        var absent: Set<Int> = []
        var ext: [WindowKey: (ExtWindow, Link)] = [:]
        let wallNow = options.clock()
        // What the parked windows' sweep needs of each browser's read (ShellHandoff.swift).
        var sweepHeld: Set<String> = [], sweepCopies: [String: String] = [:], sweepReporting: Set<String> = []
        let parkedNumbers = parking?.numbers ?? []
        for (browser, pids) in byBrowser {
            let all = links.values.filter { $0.connection.hello.browser == browser }
            let entries = all.filter { $0.mirror.hasState }
            let windows = entries.flatMap { entry in ExtWindow.parse(entry.mirror.windows, link: entry.connection.key).map { ($0, entry) } }
            for (w, entry) in windows { ext[w.key] = (w, entry) }
            // Kept as they are: a link without its state yet, one that dropped a moment ago.
            let held = Set(all.filter { !$0.mirror.hasState }.map(\.connection.key)).union(reconnecting.keys.filter { $0.hasPrefix(browser + ":") })
            var copies: [String: String] = [:]
            for entry in entries { copies[entry.connection.key] = entry.connection.hello.instanceId ?? entry.connection.hello.since.map { "\($0)" } ?? entry.connection.epoch }
            let binder = binders[browser] ?? WindowBinder(browser: browser)
            binders[browser] = binder
            let exact = browser == "safari" && read != nil ? safariExact(list: list, pids: pids) : [:]
            let bound = binder.update(now: wallNow, ext: windows.map(\.0), reporting: Set(entries.map(\.connection.key)), copies: copies, held: held,
                                      server: list, pids: pids, browserInFront: front.map(pids.contains) ?? false, listed: read != nil, spaceChangedAt: spaceChangedWall,
                                      parked: parkedNumbers, exact: exact)
            next.merge(bound) { a, _ in a }
            let boundNumbers = Set(bound.values)
            freeWindows[browser] = WindowMatcher.candidates(list, pids: pids).filter { !boundNumbers.contains($0.number) && !parkedNumbers.contains($0.number) }
            absent.formUnion(binder.absentNumbers)
            sweepHeld.formUnion(held)
            sweepCopies.merge(copies) { a, _ in a }
            sweepReporting.formUnion(entries.map(\.connection.key))
        }
        let before = matches
        matches = next
        // The map, from this read (and the trace, when there's one: what changed, and what the copies said).
        windowMap.reads = spaceReads
        let mapChanges = windowMap.update(now: Diagnostics.now(), list: read, browserPids: readPids, marginPid: ProcessInfo.processInfo.processIdentifier, front: front, ax: ax,
                                          parked: parking?.numbers ?? [])
        checkPlacements()
        if let trace = options.trace {
            trace.map(windowMap.snapshot, mapChanges)
            trace.ext(ext.values.map { w, _ in TraceExt(k: "\(w.key)", state: w.state, b: w.bounds, focused: w.focused) }, at: windowMap.snapshot.at)
        }
        // The parked windows: the aftercare, the sweep, the copies told, the person's returns (§2.5, §2.6).
        if read != nil { handoffRead(ext, before: before, held: sweepHeld, copies: sweepCopies, reporting: sweepReporting, byBrowser: byBrowser, list: list) }
        // Each copy told which of its windows the app draws over, before any overlay shows or layout goes.
        updateDrawn(ext, free: freeWindows)

        // The overlays: made when wanted, shown when they can be, closed when their window is gone.
        for (key, (w, entry)) in ext.sorted(by: { $0.key < $1.key }) {
            // What it should do, from the facts (OverlayPlanner.swift); carried out here.
            let existing = overlays[key]
            let target = switcher.run != nil && switcher.isTarget(key)
            let boundTo = next[key]
            var facts = OverlayFacts()
            facts.full = w.state == "fullscreen" || options.windowedToo
            facts.hasTheme = entry.theme != nil
            // Parked: its overlay kept as it is, hidden (§2.3). The switch's target: made or kept from the
            // switch's start, shown from the app's own reads (R1, R2), not its copy's lagging state.
            facts.parked = isParkedKey(key)
            facts.target = target
            facts.early = entry.theme != nil && switcher.busy && switcher.target?.profile == key.link && switcher.newWindow == key.windowId
            // The window the switch leaves: its overlay ordered out before its Space goes, and kept out.
            facts.leaving = heldOut.contains(key) && switcher.run != nil && switcher.leaving == key
            facts.targetReady = target && switcher.run?.r2At != nil
            facts.bound = boundTo
            facts.absent = boundTo.map(absent.contains) ?? false
            facts.window = boundTo.flatMap { byNumber[$0] }
            facts.fills = options.harness || options.windowedToo || facts.window.map { fillsDisplay($0.bounds) } == true
            facts.ownSpace = existing?.ownSpace ?? options.overlay.ownSpace
            facts.shown = existing?.isShown ?? false
            facts.over = existing?.aboveWindow
            facts.windowFrame = existing?.windowFrame
            facts.aheadPending = existing?.aheadPending ?? false
            facts.overlayOnScreen = existing.flatMap { byNumber[$0.windowNumber]?.onScreen } ?? false
            if let existing {
                facts.overlaySpaces = windowMap.snapshot.windows[existing.windowNumber]?.spaces
                facts.windowSpaces = boundTo.flatMap { windowMap.snapshot.windows[$0]?.spaces }
            }
            facts.canMove = !options.harness && (spaceReads as? SpaceBridge)?.canPark == true && !inSwitch(key)
            facts.canSuspect = ownSpaceChecks && !ownSpaceFellBack && !spaceChanged && !inSwitch(key)
            facts.spaceChanged = spaceChanged
            let decision = OverlayPlanner.decide(facts)
            if case .show = decision {} else if decision != .keep { placements[key] = nil; placementMisses[key] = nil }
            if decision.pastHeldOut, heldOut.contains(key), !facts.leaving { heldOut.remove(key) }
            guard decision.needsOverlay else {
                switch decision {
                case .notWanted(let why): existing?.hide(why)
                case .parked: ownSpaceSuspects[key] = nil; existing?.hide("its window is parked")
                default: existing?.hide("its window leaves full screen for a switch")
                }
                continue
            }
            let overlay = existing ?? makeOverlay(key)
            switch decision {
            case .hide(let why): overlay.hide(why); continue
            case .conceal: overlay.conceal(); continue
            case .reveal: overlay.reveal(); continue
            case .misplaced:
                // Placed ahead and on screen while its window isn't: the Space read for it was stale (a window a
                // switch had just moved). That overlay alone is put away and not placed ahead for 30 s; the rest
                // keep their own Spaces (no fallback for every overlay).
                overlay.hide("placed ahead in a Space that isn't its window's")
                aheadFailedAt[key] = Diagnostics.now() + 25
                continue
            case .suspect:
                // In its own Space but on screen itself while its window isn't (macOS kept it in the Space showing):
                // put away, and back to every Space if a later read still says so (judgeOwnSpace: a closing window
                // reads like this for a moment).
                overlay.reveal()
                suspectOwnSpace(overlay, number: facts.bound ?? 0)
                overlay.hide("its window isn't on screen")
                continue
            case .placeAhead(let orHide):
                // Placed ahead in its window's Space, so the layout is there when that Space slides in (Tirth,
                // 2026-11-07: never Safari's own UI, not even on a first visit). Else put away, as before.
                if let n = facts.bound, let server = facts.window, placeAhead(overlay, key: key, w: w, number: n, server: server) { continue }
                overlay.hide(orHide)
                continue
            case .keep: continue // sliding with its window's Space: macOS moves it with the Space
            case .join(let space):
                joinSpace(overlay, space: space)
                continue
            case .notWanted, .parked, .leaving: continue
            case .show: break
            }
            guard case .show(let number) = decision, let server = facts.window else { continue }
            overlay.browserPid = server.pid
            // Its page (or a video in it) in full screen: out of sight over the window until it's back, Margin's keys
            // and the edge stop let go meanwhile (updateKeys). Shown again through the usual show after.
            if overlay.pageFullscreen != w.pageFullscreen {
                overlay.pageFullscreen = w.pageFullscreen
                Diagnostics.note("\(key): its page \(w.pageFullscreen ? "went into full screen: Margin's layout out of sight" : "came out of full screen: Margin's layout back")")
            }
            if w.pageFullscreen {
                if overlay.isShown { overlay.conceal() }
                continue
            }
            let wasShown = overlay.isShown && overlay.aboveWindow == number
            let wasShownAnywhere = overlay.isShown
            // Over the part of the window that's the page's and Margin's: not the docked Web Inspector.
            // (Not for Safari's own sidebar sliding in under Margin's docked one: `dockedLeft`.)
            let viewport = w.state == "fullscreen" ? w.viewport : nil
            // Safari's own sidebar opened over Margin's layout: closed by its View menu, covered meanwhile (ShellSafariSidebar.swift).
            let isFront = apps.frontPid == server.pid
                && WindowMatcher.candidates(list, pids: [server.pid]).filter(\.onScreen).min(by: { $0.order < $1.order })?.number == number
            followSafariSidebar(overlay, left: w.viewport?.minX ?? 0, front: isFront)
            overlay.windowFullScreen = w.state == "fullscreen"
            let docked = Shell.dockedLeft(overlay)
            // (Covering it: the whole window kept, whatever's on the left, as under a docked sidebar as wide as the window.)
            let frame = Shell.overlayFrame(window: server.bounds, viewport: viewport, dockedLeft: coversSafariSidebar(key) ? server.bounds.width : docked)
            noteLeftPart(overlay, window: server.bounds, viewport: viewport, measured: w.viewportMeasured, docked: docked, frame: frame)
            if frame != server.bounds, overlay.windowFrame != server.bounds || overlay.frameTopLeft != frame {
                Diagnostics.note("\(key): Safari takes part of its window (the Web Inspector docked?): Margin draws in \(frame) of \(server.bounds)\(Shell.viewportDelay(w.viewportTimes, now: options.clock()))")
            }
            overlay.windowFrame = server.bounds
            overlay.size(to: frame)
            // Below the window's full-screen toolbar (its own window), so it slides over Margin too.
            let toolbar = WindowMatcher.fullScreenToolbar(list, browser: server)?.number
            let showed = overlay.show(over: number, frame: frame, toolbar: toolbar, why: spaceChanged ? "its window is on screen after the Space changed" : "its window is on screen")
            if showed, wasShown, !isStacked(list, overlay: overlay, browser: server, toolbar: toolbar) {
                overlay.reorder()
            }
            if showed, !wasShownAnywhere || overlay.aheadPending { overlay.arrived(); appeared(overlay, w, list: list) }
            if showed { deliverHeldPalette(overlay) }
            if showed, placements[key].map({ $0.window != number || $0.frame != frame || $0.windowBounds != server.bounds }) ?? true {
                placements[key] = PlacedOverlay(overlay: overlay.windowNumber, window: number, frame: frame, windowBounds: server.bounds, at: Diagnostics.now())
                placementMisses[key] = 0
            }
            if showed, !wasShown, overlay.ownSpace, !inSwitch(key),
               OverlayPlanner.checksOwnSpace(canMove: !options.harness && (spaceReads as? SpaceBridge)?.canPark == true) { checkOwnSpace(overlay, browser: number) }
            if showed, overlay.ownSpace { keepInWindowSpace(overlay, number: number, justShown: !wasShown) }
            if let layout = overlay.layout { layoutChanged(overlay, layout) }
        }
        releaseHeldWindows()
        closeRestoredParked(ext)
        options.trace?.overlays(overlays.map { key, o in
            TraceOverlay(k: "\(key)", n: o.windowNumber, over: o.aboveWindow, shown: o.isShown, own: o.ownSpace, f: o.frameTopLeft)
        }, at: Diagnostics.now())
        if read != nil { judgeOwnSpace(ext, byNumber) }
        if read != nil { followKept(byNumber) }
        // (Not a link's that dropped a moment ago, nor one back but without its state yet: kept as they are.)
        for (key, overlay) in overlays where ext[key] == nil && reconnecting[key.link] == nil && links[key.link]?.mirror.hasState != false {
            overlay.close()
            overlays[key] = nil
            ownSpaceSuspects[key] = nil
        }
        if overlays.values.contains(where: \.isShown) { pointer.start() } else { pointer.stop() }
        updateKeys(list: list, allPids: allPids)
        pointerMoved(PointerWatch.location, fromTrack: true)
        if switcher.busy { switcher.tick(); lastSwitchBusyAt = Diagnostics.now() }

        // The next read.
        let now = Diagnostics.now()
        let every = now < burstUntil ? options.burstPoll : (browserInFront ? options.restPoll : options.idlePoll)
        guard !links.isEmpty || !reconnecting.isEmpty else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: every, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
    }

    // A dropped link's overlays, kept dimmed for it to come back (nothing of its copy says where its
    // windows are meanwhile): each checked against the window it's over. Put away once that window is
    // gone from the window server, off screen (not left in its own Space), moved or resized (out of
    // full screen), or no longer fills its display; shown again by the relink.
    private func followKept(_ byNumber: [Int: ServerWindow]) {
        for (key, overlay) in overlays.sorted(by: { $0.key < $1.key }) where reconnecting[key.link] != nil && links[key.link] == nil && overlay.isShown {
            guard let number = overlay.aboveWindow else { continue }
            let why: String?
            if let server = byNumber[number] {
                // (In its window's own Space, at its size: left there, as track() leaves it, through a slide too.)
                let inSpace = overlay.ownSpace && overlay.windowFrame.map { Shell.sameSize($0, server.bounds) } == true
                if !server.onScreen {
                    why = inSpace ? nil : "its window isn't on screen"
                } else if let was = overlay.windowFrame, was != server.bounds, !inSpace {
                    why = "its window moved or changed size (out of full screen?)"
                } else if !inSpace, !(options.harness || options.windowedToo || ScreenGeometry.fillsDisplay(server.bounds)) {
                    why = "its window doesn't fill its display"
                } else {
                    why = nil
                }
            } else {
                why = "its window is gone from the window server"
            }
            if let why { overlay.hide("\(why), while its link is reconnecting") }
        }
    }

    // Whether the app draws over each reported window, to its copy (DrawnOutbox): on at once as it's
    // bound (and wanted), off after the grace (a timer per window looks again then), off at once for a
    // closed window that was on. A link held (no state yet, reconnecting) says nothing meanwhile.
    private var drawnTimers: [WindowKey: (due: TimeInterval, timer: Timer)] = [:]
    private func updateDrawn(_ ext: [WindowKey: (ExtWindow, Link)], free: [String: [ServerWindow]] = [:]) {
        let now = Diagnostics.now()
        for (key, (w, entry)) in ext.sorted(by: { $0.key < $1.key }) {
            // A parked window's pages keep their box (at its full-screen insets), and the switch's target
            // is wanted for its whole entry, however late its copy reports (§2.4).
            let wanted = (w.state == "fullscreen" || options.windowedToo || isParkedKey(key) || (switcher.run != nil && switcher.isTarget(key))) && entry.theme != nil
            // Not bound yet, a full-screen window whose only candidates are off screen (DrawnOutbox.offer `pending`).
            let same = w.bounds.map { b in (free[entry.connection.hello.browser] ?? []).filter { WindowMatcher.close($0.bounds, b) } } ?? []
            let pending = matches[key] == nil && w.state == "fullscreen" && !same.isEmpty && same.allSatisfy { !$0.onScreen }
            let r = entry.drawn.offer(windowId: key.windowId, now: now, bound: matches[key] != nil, wanted: wanted, pending: pending)
            if let on = r.send { sendDrawn(entry, key, on, r.why) }
            if let due = r.due {
                if drawnTimers[key]?.due != due {
                    drawnTimers[key]?.timer.invalidate()
                    let timer = Timer.scheduledTimer(withTimeInterval: max(0.01, due - now + 0.01), repeats: false) { [weak self] _ in
                        MainActor.assumeIsolated {
                            self?.drawnTimers[key] = nil
                            self?.soon()
                        }
                    }
                    drawnTimers[key] = (due, timer)
                }
            } else if let t = drawnTimers.removeValue(forKey: key) {
                t.timer.invalidate()
            }
        }
        for entry in links.values where entry.mirror.hasState {
            let link = entry.connection.key
            for id in entry.drawn.windows where ext[WindowKey(link: link, windowId: id)] == nil {
                let key = WindowKey(link: link, windowId: id)
                drawnTimers.removeValue(forKey: key)?.timer.invalidate()
                if let on = entry.drawn.closed(windowId: id) { sendDrawn(entry, key, on, "closed") }
            }
        }
    }

    private func sendDrawn(_ entry: Link, _ key: WindowKey, _ on: Bool, _ why: String) {
        entry.connection.send(.drawn(epoch: entry.connection.epoch, windowId: key.windowId, on: on))
        Diagnostics.note("\(key): told \(on ? "drawn" : "not drawn"): \(why)")
    }

    // Where an overlay goes over a window (top left): the whole window, or, when its copy says the
    // tab in front's page area is only part of it (`viewport`: the Web Inspector docked at the bottom,
    // left or right), that part, so Margin is laid out beside the inspector, draws nothing over it,
    // and the pointer always reaches it. A part too small to lay a theme out in (under 200 pt) or
    // outside the window: the whole window. An edge within `edgeSnap` of the window's is the
    // window's (Safari's sidebar ends its slide 1 or 2 pt off).
    // Not on the left when Margin's sidebar is docked at least that wide (`dockedLeft`: its left
    // inset): that's Safari's own sidebar sliding in under Margin's (Tirth's log, 19:37:14: x 19, 213,
    // 238, 240, … 2, 0, over about 1.3 s, open 0.4 to 1.1 s), and the overlay stays over the whole
    // window. The page's box keeps its place (shared/app-link.ts boxFromLayout takes the viewport's
    // offset off the layout's left inset). Whether the page measured where its area starts (`measured`)
    // doesn't change that: a pointer moving over the page while Safari's sidebar slides away measures
    // each step. A hidden Margin sidebar, or a part wider than its docked one (a left-docked
    // inspector, Safari's sidebar kept open past it): carved out, at once.
    static let edgeSnap: CGFloat = 2
    static func overlayFrame(window: CGRect, viewport: CGRect?, dockedLeft: CGFloat? = nil) -> CGRect {
        guard let viewport else { return window }
        var part = viewport.offsetBy(dx: window.minX, dy: window.minY).intersection(window)
        guard !part.isNull, part.width >= 200, part.height >= 200 else { return window }
        part = CGRect(x: part.minX.rounded(), y: part.minY.rounded(), width: part.width.rounded(), height: part.height.rounded())
        var minX = part.minX, minY = part.minY, maxX = part.maxX, maxY = part.maxY
        if minX - window.minX <= edgeSnap { minX = window.minX }
        if minY - window.minY <= edgeSnap { minY = window.minY }
        if window.maxX - maxX <= edgeSnap { maxX = window.maxX }
        if window.maxY - maxY <= edgeSnap { maxY = window.maxY }
        if minX > window.minX, let dockedLeft, minX - window.minX <= dockedLeft { minX = window.minX }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    // How wide an overlay's docked sidebar is (its page wants no pointer positions: PointerWant none,
    // Margin's sidebar docked): its last layout's left inset, from the overlay's own left edge, so it's
    // the same whether or not the overlay is carved out (no back and forth), and still right for the
    // moment after a resize before its page measures again (the sidebar's width doesn't change with
    // the overlay's); nil otherwise.
    static func dockedLeft(_ overlay: OverlayController) -> CGFloat? {
        guard overlay.pointerWant.mode == .none, let layout = overlay.layout, layout.left > 0 else { return nil }
        return CGFloat(layout.left)
    }

    // A part of the window on the left as it first shows (for the edge guard's question: does Safari's
    // sidebar come out even with the guard in place?): where the pointer and the guard were, and what
    // the overlay did. Once per appearance.
    private var leftPartSaid: Set<WindowKey> = []
    /// Where the time went between the page's resize and Margin drawing in its new area, for the log: "; the page
    /// resized 380 ms ago: said after 20, its copy heard it after 300, Margin had it 60 later". Empty without times.
    static func viewportDelay(_ t: ViewportTimes?, now: Double) -> String {
        guard let t, let heard = t.heard else { return "" }
        let ms = { (s: Double) in Int((s * 1000).rounded()) }
        var parts: [String] = []
        if let r = t.resized, let said = t.said { parts.append("said after \(ms(said - r))") }
        if let said = t.said { parts.append("its copy heard it after \(ms(heard - said))") }
        parts.append("Margin had it \(ms(now - heard)) later")
        let from = t.resized ?? t.said ?? heard
        return "; the page resized \(ms(now - from)) ms ago: " + parts.joined(separator: ", ")
    }

    private func noteLeftPart(_ overlay: OverlayController, window: CGRect, viewport: CGRect?, measured: Bool, docked: CGFloat?, frame: CGRect) {
        let left = viewport.map { $0.minX } ?? 0
        guard left > Shell.edgeSnap else { leftPartSaid.remove(overlay.key); return }
        guard !leftPartSaid.contains(overlay.key) else { return }
        leftPartSaid.insert(overlay.key)
        let p = PointerWatch.location
        let pointer = String(format: "(%.0f, %.0f)", p.x - window.minX, p.y - window.minY)
        let guardAt = overlay.edgeFrame.map { String(format: "x %.0f, %.0f pt wide", $0.minX - window.minX, $0.width) } ?? "none"
        let did = frame.minX > window.minX ? "carved out" : docked.map { "left under Margin's docked sidebar (\(Int($0)) pt)" } ?? "not carved"
        Diagnostics.note("\(overlay.key): a part on the left, \(Int(left)) pt (\(measured ? "measured" : "guessed")), appeared: the pointer at \(pointer) in the window, the edge guard \(guardAt); \(did)")
    }

    // A window the app's own request made (the profile switch's openSpaceWindow, asked at `asked`):
    // its binder binds it to the one new window the window server lists from then (WindowMatcher.swift),
    // by the bounds the answer gave until the copy's list has it (HANDOFF.md §1.6; an older copy gives none).
    func windowMade(_ link: String, windowId: Int, asked: Double, bounds: CGRect? = nil) {
        guard let browser = links[link]?.connection.hello.browser else { return }
        let binder = binders[browser] ?? WindowBinder(browser: browser)
        binders[browser] = binder
        binder.expect(WindowKey(link: link, windowId: windowId), since: asked, now: options.clock(), why: "made by Margin's openSpaceWindow", bounds: bounds)
        burst("window made")
    }

    // An overlay just shown (it wasn't): whether it's the front window's (a field its page focused
    // while hidden gets the keyboard only then, OverlayController.appeared). Only over the front window:
    // a window made from another (⌘N, the palette's New window: `paletteOnShow`) gets the palette over its
    // new tab, as ⌘T's does (Tirth, 2026-11-09); another its copy heard made within `launcherFocusWithin`
    // (Safari's own New Window) has its new-tab launcher focused. Not at Margin.app's start, a relink, a
    // switch's window or a page reloaded over a window that was already there: the keys stay where they were.
    static let launcherFocusWithin: TimeInterval = 10
    private func appeared(_ overlay: OverlayController, _ w: ExtWindow, list: [ServerWindow]) {
        let front = frontOverlay(list: list) === overlay
        let new = w.createdAt.map { options.clock() - $0 <= Shell.launcherFocusWithin } ?? false
        let made = paletteOnShow.removeValue(forKey: overlay.key).map { options.clock() - $0 <= Shell.launcherFocusWithin } ?? false
        overlay.appeared(front: front, palette: front && made, focusLauncher: front && new)
    }

    private func makeOverlay(_ key: WindowKey) -> OverlayController {
        let overlay = OverlayController(pages: pages, key: key, options: options.overlay)
        overlay.delegate = self
        overlays[key] = overlay
        overlay.load()
        Diagnostics.note("overlay made for \(key)")
        return overlay
    }

    // The overlay over the front app's frontmost window, if it's a linked browser's.
    private var lastFrontWindow: Int?
    func frontOverlay(list: [ServerWindow]? = nil) -> OverlayController? {
        guard let front = apps.frontPid else { return nil }
        let windows = list ?? windowSource.windows(of: [front])
        guard let top = WindowMatcher.candidates(windows, pids: [front]).filter(\.onScreen).min(by: { $0.order < $1.order }) else {
            // None of its windows on screen: the one in front may be missing from this read (a blip),
            // its overlay kept unseen over it.
            return overlays.values.first { $0.isShown && $0.isConcealed && $0.browserPid == front && $0.aboveWindow == lastFrontWindow }
        }
        lastFrontWindow = top.number
        return overlays.values.first { $0.isShown && $0.aboveWindow == top.number }
    }

    // The overlay that last had the keys, and when: a moment with none matched over the front window (a window
    // being made or moved, a Space settling) keeps them for `keysGrace` while its browser stays in front, so a press
    // then is still Margin's, not the page's (Tirth, 2026-11-08: "sometimes … overridden by the site").
    private var keysOverlay: (key: WindowKey, pid: pid_t, at: TimeInterval)?
    static let keysGrace: TimeInterval = 1.0
    // Why the keys went off, last logged (logged as it changes, a linked browser in front).
    private var keysOffWhy: String?

    private func updateKeys(list: [ServerWindow], allPids: Set<pid_t>) {
        // (A read missing the front window: its overlay kept unseen over it still has the keys, frontOverlay.)
        let now = Diagnostics.now()
        var front = frontOverlay(list: list)
        if let f = front { keysOverlay = (f.key, f.browserPid, now) }
        else if let last = keysOverlay, apps.frontPid == last.pid, now - last.at < Shell.keysGrace, let o = overlays[last.key], o.isShown { front = o }
        let has = front != nil
        // The front window's copy's combinations (each profile's Settings may differ).
        // (⇧⌘L too with Safari's: its own sidebar key, Margin's sidebar's there: ShellSafariSidebar.swift.)
        // While its page is in full screen (a video), only the tab and space keys: ⌘T and the rest are the page's then.
        if let front {
            var bindings = ShortcutSet.bindings(from: links[front.key.link]?.keys ?? [:], safari: front.key.link.hasPrefix("safari:"))
            if front.pageFullscreen { bindings = bindings.filter { $0.value.repeats } }
            shortcuts.rebind(bindings)
        }
        // The edge stop: the front window's overlay shown over a full-screen Safari window.
        let fence = front.flatMap { o -> EdgeStop.Fence? in
            guard options.edgeStop, o.key.link.hasPrefix("safari:"), o.windowFullScreen, !o.pageFullscreen, let window = o.windowFrame else { return nil }
            return EdgeStop.fence(window: window, displays: ScreenGeometry.displayFrames)
        }
        if fence != edgeFence {
            edgeFence = fence
            if !options.harness { edgeStopper.set(fence) } // (the tests read the fence; no real pointer is touched)
        }
        // Mid-handoff no overlay may be shown over the front window (B is on top, its own not up yet):
        // the keys stay the app's with Safari or Margin in front, and `run` gives them to the switch (§1.7).
        let ownPid = ProcessInfo.processInfo.processIdentifier
        let midSwitch = switcher.keysMidSwitch && apps.frontPid.map { allPids.contains($0) || $0 == ownPid } == true
        shortcuts.set(active: ShortcutSet.active(frontPid: apps.frontPid, linkedPids: allPids, frontWindowHasOverlay: has) || midSwitch)
        // Off with a linked browser in front: why, once (a press then goes to the page: the copy's own keys take it there).
        let why = shortcuts.isActive || !(apps.frontPid.map(allPids.contains) ?? false) ? nil : keysOffReason(front: front)
        if why != keysOffWhy {
            if let why { Diagnostics.note("Margin's keys are the browser's for now: \(why)") }
            else if keysOffWhy != nil, shortcuts.isActive { Diagnostics.note("Margin's keys are the app's again") }
            keysOffWhy = why
        }
        shortcuts.setQuitGuard(active: Shell.guardsQuit(browserInFront: apps.frontPid.map(allPids.contains) == true,
                                                        parked: parking?.entries.count ?? 0, quitting: quittingBrowser,
                                                        asks: has && front?.pageFullscreen != true && options.asksBeforeQuit()))
    }

    // A click in Margin's UI moves the keyboard to Margin.app without making it the active app (a non-activating
    // panel), and OverlayController.pressEnded gives it back as the press ends. A key pressed before that, with none
    // of Margin's windows key, had nowhere to go (the system's beep: ⌘R after a click in the sidebar, Tirth,
    // 2026-11-08): it goes on to the linked browser in front instead, as the press and the release it would have had
    // there, and the keyboard goes back with it. Which key isn't logged, only that one was sent on.
    private var keyRelay: Any?
    private(set) var keysRelayed = 0
    /// Where a key that reached Margin.app goes on to: the browser in front, if it's linked and none of Margin's windows
    /// is key (one that is takes its keys: a field of Margin's, the quit prompt, a settings window); nil: it stays Margin's.
    static func relayTarget(marginWindowKey: Bool, front: pid_t?, margin: pid_t, linked: [Set<pid_t>]) -> pid_t? {
        guard !marginWindowKey, let front, front != margin, linked.contains(where: { $0.contains(front) }) else { return nil }
        return front
    }
    private func startKeyRelay() {
        guard keyRelay == nil, !options.harness else { return }
        keyRelay = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard let self, let pid = Shell.relayTarget(marginWindowKey: NSApp.keyWindow != nil, front: self.apps.frontPid,
                                                        margin: ProcessInfo.processInfo.processIdentifier, linked: Array(self.linkedPids().values)),
                  let cg = event.cgEvent?.copy() else { return event }
            cg.postToPid(pid)
            if event.type == .keyDown {
                self.keysRelayed += 1
                if self.keysRelayed == 1 || self.keysRelayed % 100 == 0 { Diagnostics.note("a key reached Margin.app with none of its windows key: sent on to the browser in front (\(self.keysRelayed) so far)") }
                self.overlays.values.first { $0.browserPid == pid && $0.isShown }?.returnKeyboard()
            }
            return nil
        }
    }

    /// ⌘Q (or ⌥⌘Q) posted to a process, a key press and release (Accessibility lets Margin post events); if it
    /// can't be posted, the plain quit asked of the app instead.
    nonisolated static func postQuitKeys(_ pid: pid_t, _ keepWindows: Bool) {
        let source = CGEventSource(stateID: .hidSystemState)
        let flags: CGEventFlags = keepWindows ? [.maskCommand, .maskAlternate] : [.maskCommand]
        let q: CGKeyCode = 12 // kVK_ANSI_Q
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: q, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: q, keyDown: false) else {
            NSRunningApplication(processIdentifier: pid)?.terminate()
            return
        }
        down.flags = flags
        up.flags = flags
        down.postToPid(pid)
        up.postToPid(pid)
    }

    /// Whether ⌘Q and ⌥⌘Q are Margin's first (AppShortcuts' quit guard): a linked browser in front, not already quitting
    /// it, and either windows Margin has parked (closed first) or Margin's layout in front with its prompt wanted.
    static func guardsQuit(browserInFront: Bool, parked: Int, quitting: Bool, asks: Bool = false) -> Bool {
        browserInFront && !quitting && (parked > 0 || asks)
    }

    // Margin's quit prompt, while it's up (QuitPrompt.swift).
    private(set) var quitPrompt: QuitPrompt?

    // ⌘Q or ⌥⌘Q in the browser with windows parked: every parked window closed by its own copy first (its tabs stay in
    // their spaces, not open), at most `quitCloseWithin`, then the same keys handed to the browser, which quits as it
    // would have (its own "quit with these tabs?" too). So the browser never saves them as windows to bring back on the
    // Desktop at its next launch (Tirth, 2026-11-07). A parked window whose copy can't be asked goes back to its Desktop
    // as at Margin's own quit.
    private(set) var quittingBrowser = false
    static let quitCloseWithin: Double = 0.6
    func quitBrowser(keepWindows: Bool) {
        // ⌘Q again with the prompt up: Quit.
        if let prompt = quitPrompt { return prompt.choose(.quit) }
        guard !quittingBrowser, let pid = apps.frontPid else { return }
        // Over Margin's layout, Margin's own prompt first (Tirth, 2026-11-07, as Arc's): Quit, Always quit, Cancel.
        if options.asksBeforeQuit(), let front = frontOverlay(), let window = front.windowFrame {
            let browser = links[front.key.link]?.connection.hello.browser == "safari" ? "Safari" : (NSRunningApplication(processIdentifier: pid)?.localizedName ?? "the browser")
            let prompt = QuitPrompt(browser: browser)
            quitPrompt = prompt
            Diagnostics.note("\(keepWindows ? "⌥⌘Q" : "⌘Q") over Margin's layout: Margin's quit prompt")
            prompt.onChoice = { [weak self] choice in
                guard let self else { return }
                self.quitPrompt = nil
                Diagnostics.note("quit prompt: \(choice == .cancel ? "cancelled" : choice == .always ? "always quit" : "quit")")
                switch choice {
                case .cancel: return
                case .always: self.options.setAskBeforeQuit(false); self.acrossSoon(); self.quitNow(pid: pid, keepWindows: keepWindows)
                case .quit: self.quitNow(pid: pid, keepWindows: keepWindows)
                }
            }
            prompt.show(over: window)
            return
        }
        quitNow(pid: pid, keepWindows: keepWindows)
    }

    private func quitNow(pid: pid_t, keepWindows: Bool) {
        guard !quittingBrowser else { return }
        quittingBrowser = true
        shortcuts.setQuitGuard(active: false)
        let keys = keepWindows ? "⌥⌘Q" : "⌘Q"
        guard let parking, !parking.entries.isEmpty else {
            options.passQuitKeys(pid, keepWindows)
            quittingBrowser = false
            return
        }
        Diagnostics.note("\(keys) in the browser with \(parking.entries.count) parked window\(parking.entries.count == 1 ? "" : "s"): closed first, then the keys passed on")
        options.trace?.event("quit \(keys) with \(parking.entries.count) parked", at: Diagnostics.now())
        parking.endAll(cause: .quit, within: Shell.quitCloseWithin, close: parkedCloser()) { [weak self] end in
            guard let self else { return }
            Diagnostics.note("before the browser quits: closed \(end.closed), returned \(end.returned), \(end.left) left (\(end.ms) ms); \(keys) passed on")
            self.options.passQuitKeys(pid, keepWindows)
            // (Taken again only if the browser is still in front with windows parked: its quit was cancelled.)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.quittingBrowser = false }
        }
    }

    // ---- the pointer ----

    private func pointerMoved(_ at: CGPoint, fromTrack: Bool = false) {
        let down = PointerWatch.buttonsDown
        let now = Diagnostics.now()
        for overlay in overlays.values where overlay.isShown {
            let ignore = PassThrough.decide(at, overlay.slot, buttonsDown: down, ignoring: overlay.ignoring)
            overlay.setIgnoring(ignore)
            // Handed in wherever it is over the overlay: while it passes through, the
            // overlay's page doesn't hear it; elsewhere it may not either, since
            // Margin.app is never the active app and its web view may hear only
            // clicks (a hidden sidebar's reveal edge, keeping a peeked sidebar out).
            // Only the positions its page wants (PointerWant: none while the sidebar is docked,
            // the reveal zone while it's hidden, all while it's out), at most `pointerEvery`, a
            // moved one only, the last of a run sent after it; the first one out of the zone once.
            let frame = overlay.frameTopLeft
            if frame.contains(at) {
                pointerInside.insert(overlay.key)
                guard !fromTrack else { continue }
                let local = CGPoint(x: at.x - frame.minX, y: at.y - frame.minY)
                guard overlay.pointerWant.wants(local, in: frame.size) else {
                    if pointerWanted.remove(overlay.key) != nil { pushPointer(overlay, local, now) }
                    continue
                }
                pointerWanted.insert(overlay.key)
                guard lastPointer[overlay.key] != local else { continue }
                if now - (lastPointerPush[overlay.key] ?? 0) >= options.pointerEvery { pushPointer(overlay, local, now) } else { trailPointer(overlay) }
            } else if pointerInside.remove(overlay.key) != nil {
                pointerWanted.remove(overlay.key)
                overlay.push(raw: #"{"type":"pointerLeft","x":\#(Double(at.x - frame.minX)),"y":\#(Double(at.y - frame.minY))}"#)
            }
        }
    }

    // The pointer at `at` (top left), as the mouse monitors would say (the tests: no real pointer moves).
    func pointerMovedForTests(_ at: CGPoint) { pointerMoved(at) }

    private func pushPointer(_ overlay: OverlayController, _ local: CGPoint, _ now: TimeInterval) {
        lastPointerPush[overlay.key] = now
        lastPointer[overlay.key] = local
        pointerPushes += 1
        overlay.push(raw: #"{"type":"pointer","x":\#(Double(local.x)),"y":\#(Double(local.y))}"#)
    }

    // A move skipped for the rate: the position the pointer rests at goes once the time's up.
    private func trailPointer(_ overlay: OverlayController) {
        guard !trailing.contains(overlay.key) else { return }
        trailing.insert(overlay.key)
        let wait = max(0, options.pointerEvery - (Diagnostics.now() - (lastPointerPush[overlay.key] ?? 0)))
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self, weak overlay] in MainActor.assumeIsolated {
            guard let self, let overlay else { return }
            self.trailing.remove(overlay.key)
            guard overlay.isShown else { return }
            let at = PointerWatch.location
            let frame = overlay.frameTopLeft
            let local = CGPoint(x: at.x - frame.minX, y: at.y - frame.minY)
            guard frame.contains(at), overlay.pointerWant.wants(local, in: frame.size), self.lastPointer[overlay.key] != local else { return }
            self.pushPointer(overlay, local, Diagnostics.now())
        } }
    }

    // A press anywhere: the browser may have been raised above an overlay; a press on the page
    // (or another app) takes the keyboard back from an overlay that had it.
    // A field focused in an overlay not shown yet lets go too (it would take the keyboard as it shows).
    func pressed(_ at: CGPoint) {
        for overlay in overlays.values where overlay.hasKeyboard && (!overlay.frameTopLeft.contains(at) || PassThrough.pageGets(at, overlay.slot)) {
            overlay.push(raw: #"{"type":"pressOutside"}"#)
            overlay.handBack("a press on the page or another app")
        }
        for overlay in overlays.values where overlay.pageWantsKeyboard && !overlay.isShown {
            overlay.letGo("a press while it wasn't shown")
        }
        burst("press")
    }

    // ---- the keys ----

    // `isRepeat`: a held key's repeat (AppShortcuts), not a press.
    func run(_ command: AppCommand, isRepeat: Bool = false) {
        switcher.personActed()
        if switcher.keysMidSwitch { return runMidSwitch(command, isRepeat: isRepeat) }
        guard let overlay = frontOverlay(), let entry = links[overlay.key.link] else { return }
        switch command {
        case .palette:
            overlay.paletteKeyAt = Diagnostics.now()
            Diagnostics.note("the palette's key: sent to \(overlay.key)'s overlay\(overlay.hasKeyboard ? " (it has the keyboard: the palette closes)" : "")")
            overlay.push(raw: #"{"type":"command","name":"palette"}"#)
        case .toggleSidebar:
            overlay.push(raw: #"{"type":"command","name":"toggle-sidebar"}"#)
        case .newWindow:
            newMarginWindow(from: overlay.key)
        case .nextSpace where spaceKey(overlay, 1, isRepeat: isRepeat), .prevSpace where spaceKey(overlay, -1, isRepeat: isRepeat):
            return // across profiles (ShellProfiles.swift)
        case .nextTab where overlay.isReady, .prevTab where overlay.isReady:
            // The overlay's page highlights the tab at once (its own pick, the copy's rule) and asks the copy for it
            // (overlay.ts navTab): the highlight never waits for the copy's background (Tirth, 2026-11-07).
            overlay.push(raw: #"{"type":"command","name":"\#(command.rawValue)","repeat":\#(isRepeat)}"#)
        case .nextTab, .prevTab, .nextSpace, .prevSpace:
            let windowId = overlay.key.windowId
            Task { _ = try? await entry.connection.request(type: "navigate", payload: ["action": command.rawValue, "windowId": windowId], windowId: windowId) }
        }
    }

    // ---- the overlays' pages ----

    func hello(for overlay: OverlayController) -> String {
        guard let entry = links[overlay.key.link] else { return "null" }
        let hello = entry.connection.hello
        let window = ExtWindow.parse(entry.mirror.windows, link: entry.connection.key).first { $0.key == overlay.key }
        let head: JSONObject = [
            "windowId": overlay.key.windowId, "profile": hello.profile, "browser": hello.browser,
            // A parked window's overlay, or one a switch is moving, is drawn in full screen (§2.4).
            "mode": window?.state == "fullscreen" || handoffHolds(overlay.key) != nil ? "fullscreen" : "windowed",
            "platform": ["browser": hello.browser, "os": "mac", "app": true],
        ]
        var json = String((jsonString(head) ?? "{}").dropLast())
        json += #","state":"# + (entry.mirror.stateJSON().map { String(decoding: $0, as: UTF8.self) } ?? "null")
        json += #","windows":"# + (jsonString(entry.mirror.windows) ?? "[]")
        json += #","across":"# + (acrossJSON(for: overlay) ?? "null")
        json += #","cloudTabs":"# + cloudTabsJSON(for: overlay)
        json += #","held":"# + (jsonString(entry.held.messages(for: overlay.key.windowId)) ?? "[]")
        json += #","themes":"# + themesListJSON
        json += #","theme":"# + (overlayTheme(for: entry, overlay: overlay) ?? "null") + "}"
        return json
    }

    func send(from overlay: OverlayController, type: String, payload: JSONObject) async throws -> JSONObject {
        guard let entry = links[overlay.key.link] else { throw LinkError.down }
        let asked = options.clock()
        let reply = try await entry.connection.request(type: type, payload: payload, windowId: overlay.key.windowId)
        // The palette's New window: made from this one, as ⌘N's (app/WINDOWS.md §5).
        if type == "newWindow", reply["ok"] as? Bool == true, let made = (reply["result"] as? JSONObject).flatMap({ SpaceWindowAnswer($0) }) {
            madeFromWindow(overlay.key.link, made, asked: asked)
        }
        return reply
    }

    // A window made from another (⌘N, the palette's New window): bound as Margin's, and the palette opens
    // over its new tab as it shows.
    func madeFromWindow(_ link: String, _ made: SpaceWindowAnswer, asked: Double) {
        let key = WindowKey(link: link, windowId: made.windowId)
        windowMade(link, windowId: made.windowId, asked: asked, bounds: made.bounds)
        // Its overlay shown before the answer came (its window list first): the palette now, as the copy's own
        // push for a new-tab page opens it (over its new tab, not a new one).
        if let overlay = overlays[key], overlay.isShown {
            overlay.push(raw: #"{"type":"push","msg":{"type":"palette","newTab":false}}"#)
        } else {
            paletteOnShow[key] = options.clock()
        }
    }

    // Only a layout measured at the window's own size goes (one from before the overlay
    // was sized to it, or mid-resize, is followed by the right one), and only for a bound window
    // (the copy has been told it's drawn first: updateDrawn).
    func layoutChanged(_ overlay: OverlayController, _ layout: PageLayout) {
        guard matches[overlay.key] != nil else { return }
        // Nothing for a parked window, nor from a hidden overlay a switch is moving (§2.4): its pages
        // keep the layout they had, so showing it again changes nothing.
        if isParkedKey(overlay.key) || (!overlay.isShown && inSwitch(overlay.key)) { return }
        let size = overlay.frameTopLeft.size
        guard abs(layout.width - size.width) < 1, abs(layout.height - size.height) < 1 else { return }
        let window = overlay.windowFrame ?? overlay.frameTopLeft
        let inWindow = layout.inWindow(overlay: overlay.frameTopLeft, window: window)
        guard let entry = links[overlay.key.link], let (seq, rounded) = entry.outbox.offer(windowId: overlay.key.windowId, inWindow) else { return }
        entry.connection.send(.setLayout(epoch: entry.connection.epoch, windowId: overlay.key.windowId, seq: seq, layout: rounded))
    }

    func overlayChanged(_ overlay: OverlayController, _ why: String) {
        if why == "hits" || why == "layout" { return pointerMoved(PointerWatch.location, fromTrack: true) }
        soon()
    }

    /// The space a sidebar shows, in the log beside what its copy's state says of that window (space ids only), and in
    /// the trace (Tirth, 2026-11-07: after a switch the sidebar showed another space's tabs).
    func shownSpace(_ overlay: OverlayController, _ said: JSONObject) {
        let space = said["space"] as? String ?? "-"
        let windowId = said["windowId"] as? Int
        // (Stored inside the copy's `openTabs` record: shared/stored.ts OPEN_TABS_KEYS.)
        let open = links[overlay.key.link]?.mirror.value("openTabs") as? JSONObject
        let copy = (open?["activeSpaceByWindow"] as? JSONObject)?[String(overlay.key.windowId)] as? String
        let agree = copy == space
        Diagnostics.note("\(overlay.key): its sidebar shows space \(space)\(said["foreign"] as? Bool == true ? " (another profile's)" : "")\(windowId.map { $0 == overlay.key.windowId ? "" : " for window \($0)" } ?? "") — its copy says \(copy ?? "-")\(agree ? "" : " (differs)")")
        options.trace?.event("shownSpace \(overlay.key) \(space) copy \(copy ?? "-")", at: Diagnostics.now())
    }

    func perform(from overlay: OverlayController, _ name: String, _ arg: Any?) {
        // A click in Margin: what lands late isn't the person's choice any more (§1.9). (The cover's word is the page's.)
        if name != "switch.coverShown" { switcher.personActed() }
        guard let entry = links[overlay.key.link] else { return }
        switch name {
        case "window.fullscreen":
            Task { _ = try? await entry.connection.request(type: "toggleFullscreen", payload: ["windowId": overlay.key.windowId], windowId: overlay.key.windowId) }
        case _ where name.hasPrefix("profile.") || name.hasPrefix("switch.") || name == "space.move":
            performAcross(from: overlay, name, arg as? JSONObject ?? [:])
        case "cloud.access", "copyText":
            performCloud(name, arg)
        case _ where name.hasPrefix("theme."):
            performTheme(from: overlay, name, arg)
        default:
            Diagnostics.note("\(overlay.key): \(name) isn't the app's yet")
        }
    }
}

extension OverlayController {
    // A message already JSON.
    func push(raw json: String) { pushJSON(json) }
}
