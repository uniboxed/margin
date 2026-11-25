// Margin's own windows (MarginWindow.swift; docs/MARGIN-APP.md phase 2): each
// one the overlay's page (OverlayPages: the same UI, its configuration and
// bridge) in a MarginWindow, fed from a MarginWindowSource instead of a
// browser's copy.
//
// - The page's hello says `host: 'app-window'` (ui/host-app.ts appWindow): it
//   draws the whole app, in the window's mode (windowed or full screen, pushed
//   as its `windows` list as it changes), never as a layer over a browser.
// - Its state is the source's `stateText()` (the State shape pages draw, as its text), pushed
//   again whenever the source says it changed; its requests (`send`) and what
//   only the app does (`perform`) go to the source, but for the window's own
//   full screen, done here.
// - Its `layout` (where `<m-page>` sits) and the window's frame make the page
//   area (MarginWindow.pageRect, top left, points), redone as the window moves,
//   resizes, enters or leaves full screen, and as the page measures again (the
//   sidebar shown or hidden, another theme). With nothing hosted, its page area
//   is the theme's launcher (ui/host-app.ts) and nothing of the window is see-through.
// - Its `chrome`: where the theme draws the window's buttons (the traffic
//   lights go there) and its drag regions.
// - Always in full screen (decided by Tirth, 2026-11-15, `alwaysFullScreen`, on for every Margin window:
//   windowed Margin waits until it's built properly, Stage Manager being his daily setup): opened
//   (by hand, again, ⌘N) it's shown only once it's in full screen (made see-through, ordered in and taken to full
//   screen, then drawn: no windowed first frame); nothing of Margin's leaves full screen (no Enter/Exit Full Screen
//   item, ⌃⌘F and the page's own ask refused while it's full screen); if macOS takes it out anyway (the green button,
//   Mission Control), it goes straight back in, and the session hosts what it showed again (`onEnteredFullScreen`).
//   macOS takes the toggle only for a window of the active app that's on the current Space (opened by a script,
//   cooperative activation refusing it: seen 2026-11-16; opened while another app's full-screen Space was current, its
//   window on a Desktop macOS hadn't switched to yet: 2026-11-17, check10b/c: asked three times too early, refused,
//   then never again). So it's asked only once that holds (`tryFullScreen`): at each event that can make it so (Margin
//   active, its window key, main or on screen, the Space changed) and at a look of its own with a back-off (0.3 s
//   doubling to every 5 s: `FullScreenRetry`), until it's in, for as long as the window is open; meanwhile Margin and
//   its window are brought forward, so macOS shows the Space the window is on.
// - Hosting (HostedSession.swift; DECISIONS.md "Margin's window in front of what it hosts", 2026-11-17): the window
//   keeps its whole width in its own full-screen Space (never a tile, its size constraints never changed); its page
//   draws its own layout with the sidebar docked and no launcher in the page area (`pageHosted`, ui/host-app.ts), and
//   the page area from that layout is the hosted window's placement. The hosted window is a member of its Space UNDER
//   it: this window is in front of what it hosts at all times (`keepFront`: a window level one above normal, or, where
//   a full-screen window doesn't hold that, ordered right above the hosted window whenever that could have changed),
//   so the theme's frame, the page card's rounded corners, the palette, menus and notices are simply drawn over the
//   app. The page area is a hole while a hosted window is shown and ready (`pageState` `shown`): the page draws
//   nothing there, the panel's background is clear and its ground is drawn around the hosted window's bounds
//   (`ground`), and the pointer goes through to the app (`slot`, PassThrough.swift: decided on pointer moves only),
//   but for what the theme draws over the page area (`hits`). While an item is opened, made ready or placed again
//   (`loading`) the page card is opaque, with the theme's loader, and the pointer is Margin's: whatever the engine
//   does meanwhile is behind it. Nothing shown (`empty`): the launcher. A normal window another app opens in this
//   window's Space (a hosted app's Settings) is let in front until it's gone (`yield`).
// - Margin's UI never makes the hosted app inactive (Tirth, 2026-11-17: his recording, Messages flickering between its
//   active and inactive look at every use of the sidebar). Everything the theme draws is in `panel` (MarginPanel: a
//   non-activating panel, this window's child, at its level, exactly over it); this window is the base that owns the
//   full-screen Space and is kept in front, clear and, in full screen, ignoring the mouse. A press in the panel
//   leaves the hosted app the active app; once it's over the keys go back to that app (`afterPress`: a press in a
//   non-activating panel moves the keyboard to Margin without making it active, DECISIONS.md 2026-11-08). A field of
//   Margin's that wants the keys (the page's `focus`: the palette, a rename, an editor) makes the panel key without
//   making Margin active (`takeKeys`), the web view its first responder; when it lets go, the panel lets go of them and
//   the hosted app gets them back (`keysBack` → `onFieldClosed`). Margin is made active only where it must be (its
//   first entry into full screen, a press in its launcher with nothing hosted, a picker of its own), each time through
//   `activate` (said, and counted: `activations`).
//   While a hosted Safari tab loads, the theme's own loading bar on the page card's edge shows for that item
//   (`setLoadingTabs`).
// - The sidebar's edge dragged while hosting: the sidebar slides over the hosted window live (this window is in front,
//   nothing to lift); the session holds the page area's change until the drag is over, then places the hosted window
//   once, behind the loader. Its own size and constraints never change for it.
// - MarginWindows: every such window, the menu bar's actions (to the key one),
//   and the source's changes passed to each.

import AppKit
import MarginCore
import WebKit

// Where Margin's windows get their spaces (the library's, LibraryWindowSource). `stateText()`: the whole state as
// its JSON text, in the shape pages draw (types/margin.d.ts State, as shared/stored.ts fromStorage gives it), pushed as
// it is; `spaceTheme(window:)`: the theme of the space that window shows (nil: none of its own); `spaceAppearance(window:)`:
// that space's own light or dark (its background's; nil: the system's); `perform`: a request
// of the UI's (its `send` type and payload, or a `perform` name and argument), the window's id in the payload as
// `windowId`, answered as the page's request is (`{ ok, result }` or `{ ok: false, error }`; nil: done,
// `{ ok: true, result: true }`); `onChange`: the state changed.
protocol MarginWindowSource: AnyObject {
    func stateText() -> String
    func spaceTheme(window: Int) -> String?
    func spaceAppearance(window: Int) -> SpaceAppearance?
    @discardableResult func perform(_ type: String, _ payload: JSONObject) -> JSONObject?
    var onChange: (() -> Void)? { get set }
}

final class MarginWindowController: NSObject, OverlayPageOwner, NSWindowDelegate, WKNavigationDelegate {
    struct Options {
        var harness = false
        var frame: CGRect? // top left; nil: centred on the main display (a test's: off every display)
        var pointerEvery: TimeInterval = 1.0 / 30 // the pointer handed to a page that wants it
        var showWithin: TimeInterval = 1.5 // shown by then even if its page hasn't said it's drawn
        var alwaysFullScreen = false // (MarginWindows sets it) shown only in full screen, never leaving it
        var fullScreenWithin: TimeInterval = 10 // shown as it is by then if full screen still hasn't come (never left invisible); still asked
        // A test's stand-in for macOS's answer to a full-screen ask: false, ignored; nil: in at once. And for whether
        // macOS would take one now (Margin active, its window on the current Space); nil: yes.
        var harnessEnters: (() -> Bool)?
        var harnessReady: (() -> Bool)?
        // An item not known to be slow keeps what's drawn this long before the loader shows (a switch between prepared
        // windows is tens of ms: no loader flash).
        var loaderGrace: TimeInterval = 0.12
        // Closed while it hosts: held at most this long for the one shown to be parked first (`windowShouldClose`).
        var closeWait: TimeInterval = 1.5
        var front = FrontMechanism.level // how it's kept in front of what it hosts (MarginWindows reads `MarginFront`)
    }

    static let harnessFrame = CGRect(x: -20000, y: -20000, width: 1200, height: 800)

    let id: Int
    let window: MarginWindow
    let webView: OverlayWebView
    // Margin's UI (MarginPanel): the web view, the ground and the catch fill, over `window`, its child at its level.
    let panel: MarginPanel
    weak var owner: MarginWindows?
    private let pages: OverlayPages
    private let options: Options
    private let catcher = CatchView(frame: .zero)

    private(set) var isReady = false
    private(set) var isShown = false
    private var asked = false // its page asked for its hello: pushes reach it
    private(set) var isFullScreen = false { didSet { core.setButtons(controls, fullScreen: isFullScreen); core.setFullScreen(isFullScreen) } }
    // Its page's layout, as the core keeps it (PageCore.swift: its report parsed there).
    var layout: PageLayout? { core.layout }
    private(set) var hits: [CGRect] = []
    private(set) var captureAll = false
    private(set) var controls: CGRect? { didSet { core.setButtons(controls, fullScreen: isFullScreen) } }
    // Its page in the core (PageCore.swift, margin-core's page::Page): the page card's state and the loader's grace, the
    // holes and the ground, in front of what it hosts, the page area, and its pointer (the slot, the catch region, the
    // way each pointer event goes). What's decided is the core's; here, the window's mechanism carrying it out.
    private let core: PageCore
    var ignoring: Bool { core.ignoring }
    // What its sidebar has behind the numbered keys (overlay.ts reportCounts): its spaces, and its rows ⌘1–9 reach
    // (favorites, pins, today's). Nil until its page says: then every numbered key is held (Shell.updateHostedKeys).
    private(set) var rowCounts: (spaces: Int, items: Int)?
    // A field of Margin's wants the keys (its page's `focus`: the palette, a rename, an editor, a menu or prompt open),
    // as the core keeps it (core/page/press.rs).
    var pageWantsKeyboard: Bool { core.fieldKeys }
    private var themeSent: String?
    // What was pushed into the page, the last 50 (the tests read it), and how many in all.
    private(set) var pushed: [String] = []
    private(set) var pushes = 0
    // The source's requests from this window (the tests read it).
    private(set) var asks: [String] = []
    // Hosting another app's window in its page area (setHosting), and the display's full-screen area (top left).
    var hosting: Bool { core.read.hosting }
    private(set) var hostDisplay: CGRect?
    private var hostingLayoutSaid: String? // the last layout logged while hosting (numbers only)
    // The hosted window shown in the page area (the engine's host in this window's Space), this window in front of it.
    var hosted: Int? { let r = core.read; return r.has_hosted ? Int(r.hosted) : nil }
    // Its bounds by the window server (top left; nil: unread), read when it's shown or placed. A test's stand-in reads its own.
    var hostedBounds: (Int) -> CGRect? = { MarginWindowController.serverBounds($0) }
    private var hostedFrame: CGRect? { let r = core.read; return r.has_frame ? CGRect(r.frame) : nil }
    // The preview card page as its page draws it (the theme's <m-preview-page>, top-left screen points), nil: none drawn.
    private(set) var cardRect: CGRect?
    // The engine's slow step (a first open, a placing again): the app's name; an item the session is showing that
    // isn't ready yet: its name. Either: the page card is `loading` (the second only after `loaderGrace`). Each with the
    // app whose icon the loader shows (a bundle id: the page looks it up in its list of installed apps), and whether the
    // show is known to take a while (the last item at launch: the loader at once). The core's.
    var loadingLabel: String? { core.text(.loading) }
    var showingLabel: String? { core.text(.showing) }
    // The page card's state as the page was told (`m-page-state` on the theme's root), and the loader's name.
    // `elsewhere`: not hosting, its item in another Margin window or parked (one window hosts at a time): its card, faded
    // ("… is in another window. Click to show it here."); focused, the item comes back here (HostedSession `focused`).
    enum PageState: String {
        case empty, loading, shown, elsewhere
        init(code: UInt8) { self = code == 1 ? .loading : code == 2 ? .shown : code == 3 ? .elsewhere : .empty }
    }
    // One of Margin's own pages in the page area while nothing's hosted there (HostedSession: ItemTarget.margin), nil:
    // the launcher. The page draws it (ui/host-app.ts `marginPage`); hosting covers it as it covers the launcher.
    private(set) var marginPage: String?
    func setMarginPage(_ page: String?) {
        let page = page.flatMap { ItemTarget.marginPages.contains($0) ? $0 : nil }
        guard page != marginPage else { return }
        marginPage = page
        Diagnostics.note("Margin's window \(id): \(page.map { "Margin's \($0) page" } ?? "no page of Margin's") in its page area")
        push(#"{"type":"marginPage","page":"# + (page.flatMap { jsonString($0) } ?? "null") + "}")
    }
    // A web item's page, as Safari showed it before it left for the other window (a data URL): the page draws it faded
    // under the card's words (`pagePicture`, sent apart from `pageState`: it's large). In memory only, never logged.
    private(set) var elsewherePicture: String?
    func setElsewhere(_ label: String?, app: String?, picture: String?) {
        let picture = label == nil ? nil : picture
        if picture != elsewherePicture {
            elsewherePicture = picture
            push(pagePictureJSON, kept: false)
        }
        guard core.setElsewhere(label, app: app) else { return }
        settlePage()
    }
    private var pagePictureJSON: String {
        #"{"type":"pagePicture","data":"# + (elsewherePicture.flatMap { jsonString($0) } ?? "null") + "}"
    }
    var pageState: PageState { PageState(code: core.read.state) }
    var loaderLabel: String? { core.text(.loader) }
    var loaderApp: String? { core.text(.loaderApp) }
    private var graceTimer: Timer? // (the loader's grace: the core's deadline)
    private(set) var pageStates: [String] = [] // each state the page was told, in order, the last 200 (the tests read it)
    // Where the hosted window shows through (the window server's coordinates, top left): the hole. Nil: nothing does.
    var hole: CGRect? { let r = core.read; return r.has_hole ? CGRect(r.hole) : nil }
    // Where the pointer goes through to the hosted window (PassThrough.swift), made with the hole (updateHole); nil
    // while nothing shows through (the launcher, the loader: the pointer is Margin's everywhere).
    private(set) var slot: Slot?
    // The items loading as the page was last told (the UI's numbers), and a window of the engine's not shown yet (cover).
    private(set) var loadingTabs: [Int] = []
    var covering: Int? { let r = core.read; return r.has_covering ? Int(r.covering) : nil }
    // The ground's colour while hosting: the colour around the page card (the theme's frame), around the hosted window
    // and under the loader; nil: the window's own background (nothing hosted, a theme that says no colour). The core's,
    // as its last placing of the holes left it.
    var pageGround: NSColor? { let r = core.read; return r.has_ground ? NSColor(r.ground) : nil }
    let ground = WindowGroundView(frame: .zero)
    // In front of what it hosts (keepFront, frontRead): how, another app's window it lets in front, and what was done
    // (the tests read the counts). The window server's word on a window's level (the dev hook's line); a test's stand-in
    // answers its own. Whether its window is on the current Space, and the clock (a test's stand-ins for both).
    // (The core's: core/page/front.rs.)
    var mechanism: FrontMechanism { core.read.mechanism == 1 ? .order : .level }
    var yieldingTo: Int? { let r = core.read; return r.has_yielding ? Int(r.yielding) : nil }
    var levelSets: Int { Int(core.read.counts.level_sets) }
    var frontOrders: Int { Int(core.read.counts.front_orders) }
    var yieldOrders: Int { Int(core.read.counts.yield_orders) }
    var frontRestores: Int { Int(core.read.counts.front_restores) } // the poll found the hosted window above it: put right at once
    var levelProbes: Int { Int(core.read.counts.level_probes) } // kept in front by its order, the raised level tried again
    var levelBacks: Int { Int(core.read.counts.level_backs) } // ...and held: back to the raised level
    var serverLevel: (Int) -> Int? = { MarginWindowController.serverLayer($0) }
    lazy var onCurrentSpace: () -> Bool = { [weak self] in self.map { $0.options.harness || $0.window.isOnActiveSpace } ?? false }
    var now: () -> Double = { Diagnostics.now() }
    // The keys (takeKeys, keysBack): whether Margin is the active app (a test's stand-in answers its own), each time
    // Margin was made the active app from here and why (the tests read it), each time the panel asked to be key and
    // let go (a test's panel is never made key), and each time the keys were given back to the hosted app.
    var appActive: () -> Bool = { MarginWindowController.isFrontApp() } // (Margin the front app: the workspace's word)
    private(set) var activations: [String] = []
    private(set) var keyAsks = 0
    private(set) var keyLets = 0
    private(set) var keysGivenBack = 0
    private(set) var hasKeys = false // the panel has the keys (asked to be key for a field of Margin's: nothing else)
    private(set) var panelAttached = 0 // times the panel was made this window's child (once, unless macOS lost it)
    private(set) var lastResorts = 0 // the panel not key a moment after it asked: Margin made frontmost instead
    private var pageResizing = false // its page said a change of the sidebar's width began, and not yet that it's over
    // Always full screen: its first entry (the window see-through until it's in), and the times it went back in.
    private var enteringFirst = false
    private(set) var backIntoFullScreen = 0
    private(set) var refusedExits = 0
    // Its asks for full screen (all of them, and those asked again: the tests read them), the retries' rule, whether
    // the first ask was made (shown), whether it's been on screen, and when AppKit last said it's on its way in.
    private(set) var fullScreenAsks = 0
    private(set) var fullScreenRetries = 0
    private(set) var fullScreenWaits = 0 // looks at which macOS wouldn't have taken it: not asked (the tests read it)
    private(set) var fullScreenForwards = 0 // times Margin and its window were brought forward meanwhile
    private(set) var forwardWays: [FullScreenRetry.Forward] = [] // ...and how, each time
    private var retry = FullScreenRetry()
    private var retryTimer: Timer?
    private var lastAskAt: Date?
    private var lastForwardAt: Date?
    private var waitingSaid: String?
    private var firstAsked = false
    private var willEnterAt: Date?

    init(id: Int, pages: OverlayPages, options: Options = Options()) {
        self.id = id
        self.pages = pages
        self.options = options
        core = PageCore(pointerEvery: options.pointerEvery)
        core.configure(grace: options.loaderGrace, startupLabel: HostedSession.startupLabel, order: options.front == .order,
                       raised: FrontMechanism.raised.rawValue, normal: NSWindow.Level.normal.rawValue)
        let frame = options.harness ? (options.frame ?? Self.harnessFrame) : (options.frame ?? Self.centred())
        window = MarginWindow(frame: frame, harness: options.harness)
        webView = pages.makeWebView(size: frame.size)
        panel = MarginPanel(frame: frame, harness: options.harness)
        super.init()
        // (The base draws nothing: an empty, clear content view. Everything drawn is in the panel.)
        let base = NSView(frame: NSRect(origin: .zero, size: frame.size))
        base.wantsLayer = true
        base.layer?.backgroundColor = .clear
        window.contentView = base
        panel.base = window
        panel.pressEnded = { [weak self] at, number in self?.pressEnded(at: at, number: number) }
        webView.takesEditKeys = { [weak self] in self.map { $0.hasKeys && $0.pageWantsKeyboard && !$0.appActive() } ?? false }
        // (A click makes the panel key only when the keys shouldn't stay with the app shown: the core's one rule.)
        webView.needsKeyForPress = { [weak self] in self.map { !$0.core.keysStay } ?? true }
        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = .clear
        catcher.frame = content.bounds
        catcher.autoresizingMask = [.width, .height]
        content.addSubview(catcher)
        ground.frame = content.bounds
        ground.autoresizingMask = [.width, .height]
        content.addSubview(ground)
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        panel.contentView = content
        window.locksFullScreen = options.alwaysFullScreen
        window.delegate = self
        // Said, not left to the default (which passes the pointer through fully transparent pixels). The base takes
        // the mouse only windowed (its buttons, where the panel lets the pointer through: `pointerMoved`).
        window.ignoresMouseEvents = false
        window.acceptsMouseMovedEvents = true
        panel.ignoresMouseEvents = false
        webView.navigationDelegate = self
        pages.bridge.register(webView, self)
    }

    // 1200 × 800 at most, inside the main display's visible part.
    static func centred() -> CGRect {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = CGSize(width: min(1200, visible.width - 40), height: min(800, visible.height - 40))
        let appKit = NSRect(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2, width: size.width, height: size.height)
        return ScreenGeometry.appKitRect(appKit)
    }

    // The page, loaded; the window shown once it's drawn (or `showWithin` after, whichever is first).
    // A test's window is ordered in off every display at once (its page draws there: MarginWindow refuses
    // a display), never made key.
    func load() {
        if options.harness { window.orderBack(nil); attachPanel("its test window ordered in") }
        // (A test's window: full screen is its state only, at once, or as its stand-in answers.)
        if options.harness, options.alwaysFullScreen { firstAsked = true; tryFullScreen("its first ask") }
        pages.ready { [weak self] in self?.webView.load(URLRequest(url: OverlaySchemeHandler.page)) }
        guard !options.harness else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + options.showWithin) { [weak self] in self?.show() }
    }

    func show() {
        guard !options.harness, !isClosed else { return }
        // Always full screen: shown only once it's there. See-through, ordered in, taken to full screen as soon as macOS
        // would take it (`tryFullScreen`); drawn when it has entered (windowDidEnterFullScreen). Still not in after
        // `fullScreenWithin`: shown as it is (said), and still asked until it's in.
        if options.alwaysFullScreen, !isFullScreen {
            guard !enteringFirst else { return }
            enteringFirst = true
            Diagnostics.note("Margin's window \(id): into full screen before it's seen")
            setAlpha(0)
            window.makeKeyAndOrderFront(nil)
            attachPanel("shown, see-through until it's in full screen")
            activate("its first entry into full screen (macOS takes the toggle only for the active app)")
            // (Its first ask; its key and first-on-screen moments here come before it.)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                guard let self else { return }
                self.firstAsked = true
                self.tryFullScreen("its first ask")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + options.fullScreenWithin) { [weak self] in
                guard let self, !self.isClosed, !self.isFullScreen, self.window.alphaValue == 0 else { return }
                Diagnostics.warn("Margin's window \(self.id): not in full screen within \(Int(self.options.fullScreenWithin)) s (\(self.fullScreenState)): shown as it is, and asked until it's in")
                self.setAlpha(1)
                self.isShown = true
            }
            return
        }
        if !isShown { Diagnostics.note("Margin's window \(id) shown\(isReady ? "" : " (its page not drawn yet)")") }
        isShown = true
        setAlpha(1)
        window.makeKeyAndOrderFront(nil)
        attachPanel("shown")
        activate("shown (opened by hand, or again)")
        shownKeys()
        keepFront()
        placeButtons()
    }

    // Both windows at one alpha (a child window doesn't take its parent's).
    private func setAlpha(_ a: CGFloat) {
        if window.alphaValue != a { window.alphaValue = a }
        if panel.alphaValue != a { panel.alphaValue = a }
    }

    // The panel over this window, its child, at its frame and level (what AppKit keeps: in its Space, moving with it,
    // ordered right above it). Asked again after every full-screen change and Space change: made its child again if
    // it isn't any more, ordered in again if it's out, and, on screen while this window is on the current Space but
    // not itself, taken out and made its child again so it joins this window's Space (said: none of these is expected).
    func attachPanel(_ why: String) {
        defer { syncBackdrop(why) }
        guard !isClosed, window.isVisible || options.harness else { return }
        let frame = window.frame
        if panel.frame != frame { panel.setFrame(frame, display: false) }
        if panel.level != window.level { panel.level = window.level }
        if panel.alphaValue != window.alphaValue { panel.alphaValue = window.alphaValue }
        if panel.parent !== window {
            window.addChildWindow(panel, ordered: .above)
            panelAttached += 1
            if panelAttached > 1 { Diagnostics.warn("Margin's window \(id): its panel wasn't its child any more (\(why)): made its child again") }
            return
        }
        if !panel.isVisible {
            panel.order(.above, relativeTo: window.windowNumber)
            return Diagnostics.warn("Margin's window \(id): its panel wasn't on screen (\(why)): ordered in again")
        }
        if !options.harness, isFullScreen, window.isOnActiveSpace, !panel.isOnActiveSpace {
            window.removeChildWindow(panel)
            panel.orderOut(nil)
            window.addChildWindow(panel, ordered: .above)
            Diagnostics.warn("Margin's window \(id): its panel wasn't in Margin's Space (\(why)): made its child again there")
        }
    }

    // Margin made the active app from here (only where it must be), said and counted. A test's never is.
    private func activate(_ why: String) {
        activations.append(why)
        if activations.count > 50 { activations.removeFirst(activations.count - 50) }
        Diagnostics.note("Margin's window \(id): Margin made the active app: \(why)")
        guard !options.harness else { return }
        NSApp.activate()
    }

    // ---- the ground behind what it hosts (MarginBackdrop) ----

    // Made the first time it's wanted (in full screen), kept for the window's life.
    private(set) var backdrop: MarginBackdrop?
    private(set) var backdropAttached = 0 // times made this window's child
    // Why it isn't used for the rest of this window's life: its layer read at or above a normal window's (it would cover
    // what Margin hosts). Never expected; said once.
    private(set) var backdropOff: String?

    // In full screen: behind everything in Margin's Space, at the window's frame, this window's child (in its Space);
    // out of full screen (or closing): out. Asked with the panel (attachPanel) and after a level change.
    func syncBackdrop(_ why: String) {
        guard backdropOff == nil else { return }
        guard !isClosed, isFullScreen, window.isVisible || options.harness else {
            if let b = backdrop { if b.parent != nil { window.removeChildWindow(b) }; if b.isVisible { b.orderOut(nil) } }
            return
        }
        let frame = MarginBackdrop.frame(window: window.frame, screen: window.screen?.frame)
        let b = backdrop ?? MarginBackdrop(frame: frame)
        backdrop = b
        if b.frame != frame { b.setFrame(frame, display: false) }
        if b.level != MarginBackdrop.level { b.level = MarginBackdrop.level }
        if b.parent !== window {
            let lost = b.isVisible // (taken out on purpose when this window left full screen: not on screen then)
            window.addChildWindow(b, ordered: .below)
            backdropAttached += 1
            if b.level != MarginBackdrop.level { b.level = MarginBackdrop.level }
            if lost { Diagnostics.warn("Margin's window \(id): its backdrop wasn't its child any more (\(why)): made its child again") }
        } else if !options.harness, window.isOnActiveSpace, !b.isOnActiveSpace {
            window.removeChildWindow(b)
            b.orderOut(nil)
            window.addChildWindow(b, ordered: .below)
            Diagnostics.warn("Margin's window \(id): its backdrop wasn't in Margin's Space (\(why)): made its child again there")
        }
        // Below every normal window, as the window server has it, or never used again by this window.
        if let layer = b.serverLayer, layer >= 0 {
            window.removeChildWindow(b)
            b.orderOut(nil)
            backdropOff = "its layer \(layer) (\(why))"
            Diagnostics.warn("Margin's window \(id): its backdrop read at layer \(layer), not below the apps' (\(why)): taken out for good")
        }
    }

    private(set) var isClosed = false
    // Its page let go of (the window closing, or closed by close()).
    func teardown() {
        guard !isClosed else { return }
        sidebarResizing(false)
        graceTimer?.invalidate()
        retryTimer?.invalidate()
        isClosed = true
        barWatch?.invalidate()
        barWatch = nil
        pages.bridge.unregister(webView)
        webView.navigationDelegate = nil
        webView.stopLoading()
        window.delegate = nil
        if panel.parent != nil { window.removeChildWindow(panel) }
        panel.orderOut(nil)
        if let b = backdrop { if b.parent != nil { window.removeChildWindow(b) }; b.orderOut(nil) }
    }

    func close() {
        teardown()
        panel.close()
        backdrop?.close()
        window.close()
    }

    // ---- the page area ----

    // The content's frame, top left.
    var contentFrame: CGRect { MarginWindowGeometry.content(of: window.frame) }

    // The page area again (the layout, the window's frame or what's over the page changed), and the hole with it. (The
    // core's: none without a layout; left as it was while laid out as a split's half for a moment by a tile change in
    // its Space, and for a layout from before a resize; hosting, the hosted window's placement.)
    func updatePage() {
        defer { updateHole() }
        guard let next = core.update(content: contentFrame, display: displayFrame) else { return }
        window.setPageRect(next.rect, radius: next.radius)
    }
    // Its display's frame (top left), nil: none.
    private var displayFrame: CGRect? { window.screen.map { ScreenGeometry.appKitRect($0.frame) } }

    // ---- hosting another app's window in its page area (HostedSession.swift) ----

    // On: its page draws its own layout with the sidebar docked and no launcher in the page area (`pageHosted`), its
    // page area the hosted window's placement. Off: the theme's launcher there again. Its width and its size
    // constraints never change for it (the hosted window is a member of its Space under it, not a tile).
    func setHosting(_ on: Bool) {
        guard let hadVisible = core.setHosting(on) else { return }
        if on {
            hostDisplay = window.screen.map { MarginWindowGeometry.fullScreenArea($0) } ?? contentFrame
            Diagnostics.note("Margin's window \(id): hosting in its page area\(hostDisplay.map { " (the display's full-screen area \(Int($0.width))×\(Int($0.height)))" } ?? "")")
        } else {
            // (What it hosted and its loaders forgotten by the core.)
            sayHostedFrame()
            if hadVisible { visibleHosts = []; sayHostedFrames() }
            setPageMinimum(nil)
            hostDisplay = nil
            Diagnostics.note("Margin's window \(id): hosting nothing: its launcher in the page area again")
        }
        push(#"{"type":"pageHosted","on":\#(on)}"#)
        updatePage()
        settlePage()
    }

    // A host's first open, or its placing again (the app's name; nil: over): the page card opaque with the loader at
    // once (`loading`), and the theme's loading bar for the item it's opened for (setLoadingTabs).
    func setLoading(_ label: String?, app: String?) {
        guard core.setLoading(label, app: app) else { return }
        Diagnostics.note("Margin's window \(id): \(label == nil ? "loading done" : "loading an app in the page area")")
        if label == nil { readHosted() }
        settlePage()
    }

    // An item being shown by the session and not ready yet (its name; nil: it is, or it failed): not known to be slow
    // (a switch between prepared windows is tens of ms), so what's drawn stays for `loaderGrace` and the loader comes
    // only if it isn't ready by then. `slow`: known to take a while (the item the window showed last, at launch,
    // before its window is even in full screen): the loader at once, from the page's first frame (its hello has it).
    func setShowing(_ label: String?, app: String?, slow: Bool) {
        guard core.setShowing(label, app: app, slow: slow) else { return }
        if label == nil { readHosted() }
        settlePage()
    }

    // The items loading (the UI's numbers for them): the page's `loading`, as a browser copy's push says it over a
    // browser (host-app.ts receive): the bar on the page card's edge for the one in front, each one's row.
    func setLoadingTabs(_ numbers: [Int]) {
        guard numbers != loadingTabs else { return }
        loadingTabs = numbers
        push(#"{"type":"push","msg":{"type":"loading","tabIds":"# + (jsonString(numbers) ?? "[]") + "}}")
    }

    // The hosted window shown in the page area (the engine's host now in Margin's Space), nil: none.
    func setHosted(_ number: Int?) {
        // (Said again for the window it has: it was moved back where it belongs, HostEngine `bringBack`: its bounds again.)
        switch core.setHosted(number) {
        case .same: return
        case .moved: return hostedMoved()
        case .changed: break
        }
        Diagnostics.note("Margin's window \(id): \(number.map { "in front of the hosted window \($0)" } ?? "no hosted window under it")")
        readHosted()
        settlePage()
    }

    // The hosted window was placed again where it is (a window-mode app moved, one kept at the frame it had): its
    // bounds read again, the hole and the pointer's slot with them.
    func hostedMoved() {
        readHosted()
        if !visibleHosts.isEmpty { readVisible() }
        updateHole()
    }

    // ---- several visible hosts (docs/PEEK-SPLIT.md §1: the preview card, a split's panes) ----

    // Every visible host's window while more than one is (HostEngine `hostedWindows`), back to front, each at its rect;
    // empty: one host, `hosted` alone, as before.
    private(set) var visibleHosts: [HostShownWindow] = [] { didSet { sayCuts() } }
    // (Their bounds by the window server, read as they're told or moved: the core's, `readVisible`.)
    // The holes: each visible host's frame inside its rect, once it's in place (one host: `hole` alone). The core's.
    var holes: [CGRect] { core.holes }
    // A card open: the press's place each time one landed on the page area outside the card's content (the dimmed page
    // around it, caught: preview closes the card then, §2).
    private(set) var caughtPresses: [CGPoint] = []
    private(set) var tapClaimedPresses = 0 // presses in a pane the pane click tap focused for (the monitor's path left them)
    var catchRegion: CatchRegion { catcher.region } // (what the catch fill fills now: the tests read it)
    func setVisibleHosts(_ list: [HostShownWindow]) {
        // (Only their rects new, in a drag's frame: the holes follow, nothing read, said or reordered; docs/PEEK-SPLIT.md §4.)
        let changed = core.setVisible(list)
        visibleHosts = list
        if !followingPage { readVisible() }
        if changed { Diagnostics.note("Margin's window \(id): \(list.isEmpty ? "one hosted window again" : "\(list.count) hosted windows visible (\(list.map { "\($0.window) \($0.role.rawValue)\($0.focused ? " focused" : "")" }.joined(separator: ", ")))")") }
        if !followingPage { sayHostedFrames() }
        updateHole()
        if changed { keepFront() }
    }

    // A split's cut panes, for their arrows (docs/PEEK-SPLIT.md §4b): pushed when it changes, and in each hello.
    private(set) var paneCuts = "{}"
    func setPaneCuts(_ json: String) {
        guard json != paneCuts else { return }
        paneCuts = json
        Diagnostics.note("Margin's window \(id): cut panes \(json == "{}" ? "none" : json)")
        cutWindows = Set((try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: [String: Any]])?.values.compactMap { $0["window"] as? Int } ?? [])
        push(#"{"type":"paneCut","panes":"# + json + "}")
        sayCuts()
    }
    // The cut panes' windows; the one the pointer is over is the core's (`PageCore`: said to the page as it enters and
    // leaves one, nothing per move, nothing at all while none is cut), told the visible hosts as they change.
    private var cutWindows: Set<Int> = []
    private func sayCuts() {
        let forgot = core.setCuts(cutting: !cutWindows.isEmpty, visibleHosts.map { ($0.window, $0.rect, cutWindows.contains($0.window)) })
        if forgot { sayHover(nil) }
    }
    private func sayHover(_ over: Int?) {
        push(#"{"type":"paneHover","window":\#(over.map(String.init) ?? "null")}"#)
    }

    // ---- a split's panes (docs/PEEK-SPLIT.md §4) ----

    // The split its page lays out now, each pane's box on the screen (top left, whole points, each edge rounded on its
    // own: a window is placed at whole points, and the gap stays the gap), in the split's order; nil: none, or not
    // hosting (the launcher's page area never has one). The core's.
    var paneLayout: (split: String, panes: [PagePane])? { core.panes(content: contentFrame) }
    // Each pane's window's own minimum (its item's id: width, height; the engine's, as learnt): its page lays no pane
    // below it and its divider stops there. Said when it changes, and in each hello.
    private(set) var paneMinimums: [String: CGSize] = [:]
    func setPaneMinimums(_ minimums: [String: CGSize]) {
        let m = minimums.mapValues { CGSize(width: $0.width.rounded(.up), height: $0.height.rounded(.up)) }
        guard m != paneMinimums else { return }
        paneMinimums = m
        push(#"{"type":"paneMin","items":"# + paneMinimumsJSON + "}")
    }
    // A split's pane whose window is opening beside the panes shown (HostedSession `paneLoadingStep`): its page draws a
    // loader over that pane's box only (behaviors/split.ts), the others shown. Said when it changes, and in each hello.
    private(set) var paneLoading: (item: String, label: String, app: String?)?
    func setPaneLoading(_ item: String?, label: String?, app: String?) {
        let next = item.map { (item: $0, label: label ?? "", app: app) }
        guard next?.item != paneLoading?.item || next?.label != paneLoading?.label || next?.app != paneLoading?.app else { return }
        paneLoading = next
        push(#"{"type":"paneLoading","pane":"# + paneLoadingJSON + "}")
    }
    var paneLoadingJSON: String {
        guard let p = paneLoading, let item = jsonString(p.item), let label = jsonString(p.label) else { return "null" }
        return #"{"item":"# + item + #","label":"# + label + #","bundleId":"# + (p.app.flatMap { jsonString($0) } ?? "null") + "}"
    }
    var paneMinimumsJSON: String { minimumsJSON(paneMinimums) }
    func minimumsJSON(_ minimums: [String: CGSize]) -> String {
        let items = minimums.keys.sorted().compactMap { k -> String? in
            guard let v = minimums[k], let key = jsonString(k) else { return nil }
            return "\(key):[\(Int(v.width)),\(Int(v.height))]"
        }
        return "{" + items.joined(separator: ",") + "}"
    }
    // Every app's windows' known minimum (its bundle id; `web`: the web pages Safari hosts), told to the page whether a
    // window of it is open or not (docs/PEEK-SPLIT.md §4): no pane laid out below its app's, a pane that can't fit
    // refused before anything is opened (behaviors/split.ts). Said when it changes, and in each hello.
    private(set) var appMinimums: [String: CGSize] = [:]
    func setAppMinimums(_ minimums: [String: CGSize]) {
        let m = minimums.mapValues { CGSize(width: $0.width.rounded(.up), height: $0.height.rounded(.up)) }
        guard m != appMinimums else { return }
        appMinimums = m
        push(#"{"type":"appMin","apps":"# + minimumsJSON(m) + "}")
    }
    private func readVisible() {
        var frames: [Int: CGRect] = [:]
        for v in visibleHosts { if let b = hostedBounds(v.window) { frames[v.window] = b } }
        core.setFrames(frames)
    }
    // ...said to the page as they change (`hostedFrames`, in its coordinates), and once ([]) when it's one again.
    private var hostedFramesSent: String?
    // (Also in each hello: a page that starts, or starts again, while several are visible knows them at once.)
    var hostedFramesJSON: String {
        let c = contentFrame
        let items = visibleHosts.map { v -> String in
            let f = core.frame(of: v.window) ?? v.rect
            return #"{"role":"\#(v.role.rawValue)","focused":\#(v.focused),"z":\#(v.z),"rect":[\#(Int((f.minX - c.minX).rounded())),\#(Int((f.minY - c.minY).rounded())),\#(Int(f.width.rounded())),\#(Int(f.height.rounded()))]}"#
        }
        return "[" + items.joined(separator: ",") + "]"
    }
    private func sayHostedFrames() {
        let json = hostedFramesJSON
        guard asked, json != hostedFramesSent, hostedFramesSent != nil || !visibleHosts.isEmpty else { return }
        hostedFramesSent = json
        push(#"{"type":"hostedFrames","frames":"# + json + "}")
    }
    // `r` less `cut`: up to four rects (above, below, left, right of it). (The core's: core/page/holes.rs.)
    nonisolated static func subtract(_ r: CGRect, _ cut: CGRect) -> [CGRect] {
        var out = [MarginRect](repeating: MarginRect(), count: 4)
        let n = out.withUnsafeMutableBufferPointer { margin_page_subtract(r.raw, cut.raw, $0.baseAddress) }
        return out.prefix(n).map(CGRect.init)
    }
    // The ground's cut-outs for holes that may overlap (a card over panes): each one less the ones before it, so the
    // even-odd fill never fills an overlap; a hole kept whole keeps its corners, a piece of one is square. (The core's.)
    nonisolated static func groundHoles(_ list: [(rect: CGRect, radii: [CGFloat])]) -> [WindowGroundView.Hole] {
        let rects = list.map(\.rect)
        let need = withRects(rects) { margin_page_ground_holes($0, $1, nil, 0) }
        var out = [MarginPiece](repeating: MarginPiece(), count: need)
        _ = withRects(rects) { r, n in out.withUnsafeMutableBufferPointer { margin_page_ground_holes(r, n, $0.baseAddress, $0.count) } }
        return out.map { WindowGroundView.Hole(rect: CGRect($0.rect), radii: $0.whole ? list[$0.from].radii : []) }
    }
    // The pointer's slot and the catch fill as the core placed them (read back only when changed); whether the slot did.
    private func placed(slot changedSlot: Bool, region changedRegion: Bool) -> Bool {
        if changedSlot { slot = core.slot }
        if changedRegion { catcher.region = core.region }
        return changedSlot
    }

    // ---- the first click in another pane (PaneClickTap.swift) ----

    // The holes the pointer goes through to while several hosts are visible, each with its window (a card's alone while
    // one is open); empty with one host. The core's.
    private var paneHoles: [(rect: CGRect, window: Int, card: Bool)] { core.paneHoles }
    private var paneOwners: [Int: pid_t] = [:] // each pane window's app (the window server's word, read once a window)
    // What the pane click tap decides with (MarginWindows keeps the tap): only while several hosted windows are visible
    // here, shown, this window on screen in the current Space; nil otherwise (no tap at all then, with no other window
    // hosting several). Published as the holes change (`updateHole`), a field of Margin's takes or lets go of the keys,
    // or the Space changes.
    var paneScene: PaneClickScene? {
        guard hosting, visibleHosts.count > 1, !paneHoles.isEmpty, let slot, pageState == .shown, !isClosed,
              options.harness || window.isVisible, onCurrentSpace() else { return nil }
        var panes: [PaneClickScene.Pane] = []
        for h in paneHoles {
            guard let pid = paneOwners[h.window] ?? hostedPid(h.window) else { continue }
            paneOwners[h.window] = pid
            let shown = visibleHosts.first { $0.window == h.window }
            panes.append(PaneClickScene.Pane(rect: h.rect, pid: pid, window: h.window, card: h.card, tucked: shown?.tucked == true, frame: shown?.frame ?? h.rect))
        }
        if paneOwners.count > 8 { paneOwners = paneOwners.filter { k, _ in paneHoles.contains { $0.window == k } } }
        guard !panes.isEmpty else { return nil }
        let own = [window.windowNumber, panel.windowNumber, backdrop?.windowNumber ?? 0].filter { $0 > 0 }
        return PaneClickScene(panes: panes, focused: visibleHosts.first { $0.focused }?.window, slot: slot, marginWindows: own, fieldHasKeys: pageWantsKeyboard)
    }
    // Its panel as the press tap reads it (docs/SIDEBAR-PRESS.md; PaneClickTap.swift `PanelPress`): while it hosts, on
    // screen in the current Space, with what the core decides a press's way with (its content, slot, window controls,
    // full screen, and whether a press on Margin's UI leaves the keyboard where it is now: an app shown, no field of
    // Margin's). Nil otherwise. Published as `paneScene` is (each change of the holes, a field's keys, the Space).
    var panelScene: PaneClickScene.Panel? {
        guard hosting, !isClosed, options.harness || window.isVisible, onCurrentSpace(), panel.windowNumber > 0 else { return nil }
        return PaneClickScene.Panel(window: panel.windowNumber, pid: ProcessInfo.processInfo.processIdentifier, content: MarginWindowGeometry.content(of: panel.frame),
                                    slot: slot, controls: controls, fullScreen: isFullScreen, keysStay: core.keysStay)
    }
    // A card open (one of the visible hosts is one): its content's hole, nil: none.
    private var cardHole: CGRect? { visibleHosts.contains { $0.role == .card } ? slot?.holes?.first : nil }

    // The hosted window follows a drag of the sidebar's edge live (the engine's tiles): the hole is the page area as it
    // is meanwhile (its window a frame behind at most), its bounds read again once it's over.
    private var followingPage: Bool { core.read.following }
    // The hosted window's own minimum width (nil: none): its page stops the sidebar's edge where the page area would be
    // narrower (ui/behaviors/resize.ts, host-app.ts `pageMinWidth`). Said once each change, and in each hello.
    private(set) var pageMinimum: CGFloat?
    func setPageMinimum(_ width: CGFloat?) {
        let w = width.map { $0.rounded(.up) }
        guard w != pageMinimum else { return }
        pageMinimum = w
        push(#"{"type":"pageMin","width":"# + (w.map { String(Int($0)) } ?? "null") + "}")
    }

    func followsPage(_ on: Bool) {
        guard core.setFollowing(on) else { return }
        if !on {
            readHosted()
            // (A split's windows' bounds read again once the drag is over, and said to the page: none were meanwhile.)
            if !visibleHosts.isEmpty { readVisible(); sayHostedFrames() }
        }
        updateHole()
    }

    // A window of the engine's in Margin's Space that isn't shown yet (a new app's, read; a browser's made ready out of
    // sight): what the `order` mechanism orders this window above meanwhile; nil: no more. (The `level` mechanism needs
    // no window: it's above every normal one.)
    func cover(_ number: Int?) {
        guard core.setCovering(number) else { return }
        keepFront()
    }

    // A normal window of another app on screen in this window's Space that the person opened (a hosted app's Settings,
    // a second document: HostEngine `others`): it comes in front, this window right below it at the normal level until
    // it's gone (nil).
    func yield(to number: Int?) {
        guard core.setYielding(number) else { return }
        Diagnostics.note("Margin's window \(id): \(number.map { "another window (\($0)) in its Space: let in front of it" } ?? "no other window in its Space: in front again")")
        keepFront()
    }

    // ---- in front of what it hosts ----

    // The one place Margin's window is put in front of what it hosts (FrontMechanism: MarginWindow.swift), called
    // whenever that could have changed: its full screen, what it hosts, an app activated, its window key or main, a
    // press (the `order` mechanism only), a yield over. In full screen and not yielding: raised a level (`level`), or
    // ordered right above the hosted window (`order`); a yield over, both: the raised level and ordered above the hosted
    // window again. Nothing at all while its window isn't on the current Space (the person is on another Space: a
    // change made then is one the window server may not show, and a read then says nothing). What the window server
    // holds is never read here, right after a change: the poll's read at rest says (`frontRead`).
    func keepFront() {
        guard !isClosed, onCurrentSpace() else { return }
        let k = core.keepFront(level: window.level.rawValue, now: now)
        if k.level != 0 { setLevel(k.level == 2 ? FrontMechanism.raised : .normal) }
        if k.has_above { orderAbove(Int(k.above)) }
        if k.has_below {
            window.order(.below, relativeTo: Int(k.below))
            panelOnTop()
        }
    }

    // Its level, and its panel's: always the same (the panel's own UI above every normal window exactly when this one is).
    private func setLevel(_ level: NSWindow.Level) {
        window.level = level
        if panel.level != level { panel.level = level }
        // (Its backdrop never follows it up: below every normal window whatever this one's level.)
        if let b = backdrop, b.parent === window, b.level != MarginBackdrop.level { b.level = MarginBackdrop.level }
    }

    // Ordered right above a window, its panel right above it (AppKit keeps a child above its parent; said again).
    private func orderAbove(_ number: Int) {
        window.order(.above, relativeTo: number)
        panelOnTop()
    }

    private func panelOnTop() {
        guard panel.parent === window, panel.isVisible || options.harness else { return }
        panel.order(.above, relativeTo: window.windowNumber)
    }

    // What the engine's poll read at rest (HostEngine `lookFront`: its on-screen list, Margin's Space current before and
    // after it): this window's layer by the window server and whether it's above the hosted window in that order. The
    // check that would have caught the whole of 2026-11-17's session (his log 06:32:56-06:36: the hosted Safari above
    // Margin's window at every activation, the card's corners gone, the palette drawn behind it):
    // - the hosted window above this one: put right at once (its level set again if that's the way, ordered above it),
    //   said once until all is well again;
    // - the level's way: the raised level not held by the window server on two reads at rest at least `missApart`
    //   apart (none held between) goes on by its order, said once. A read is at rest only if it's `settle` after this
    //   window last changed its own level or order and after the current Space last changed, with nothing let in front
    //   and its window on the current Space: a read right after a change, during a yield or a Space change says nothing
    //   (06:32:56.269: the read right after a yield's end, during his swipe, was taken as macOS refusing the level);
    // - the order's way, fallen back to (not asked for: `MarginFront`): the raised level tried again every `probeEvery`;
    //   held at the next read at rest, back to it (said once).
    // (The rules and their times are the core's: core/page/front.rs, `SETTLE`, `MISS_APART`, `PROBE_EVERY`.)
    func frontRead(_ read: HostEngine.FrontRead) {
        guard !isClosed, core.frontReads(read.hosted), onCurrentSpace() else { return }
        let ops = core.frontRead(hosted: read.hosted, layer: read.marginLayer, above: read.marginAbove, level: window.level.rawValue, now: now)
        for op in ops {
            switch op.kind {
            case 1: setLevel(.normal)
            case 2: setLevel(FrontMechanism.raised)
            case 3: orderAbove(Int(op.arg))
            case 4: Diagnostics.warn("Margin's window \(id): the hosted window \(read.hosted) above it in the window server's order (its layer \(read.marginLayer), kept in front by its \((op.arg == 1 ? FrontMechanism.order : .level).rawValue)): in front of it again")
            case 5: Diagnostics.note("Margin's window \(id): in front by its level (\(read.marginLayer), held by the window server)")
            case 6: Diagnostics.warn("Margin's window \(id): its raised level isn't held by the window server (it says \(read.marginLayer) at reads \(op.arg) ms apart, at rest): kept in front by its order instead, the level tried again every 5 s")
            case 7: Diagnostics.note("Margin's window \(id): its raised level held by the window server again (\(read.marginLayer)): in front by its level again")
            default: break
            }
        }
    }

    // A window's level as the window server has it (its layer).
    nonisolated static func serverLayer(_ number: Int) -> Int? {
        guard let n = CGWindowID(exactly: number), let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, n) as? [[String: Any]] else { return nil }
        return (list.first?[kCGWindowLayer as String] as? NSNumber)?.intValue
    }

    // ---- the page card's state (the theme's root: `m-page-state`) ----

    // `shown`: a hosted window is in place in the page area and ready: the page area is a hole (nothing drawn there by
    // the page or by this window, the pointer through it). `loading`: an item is being opened, prepared or placed again:
    // the page card opaque with the theme's loader, the pointer Margin's; whatever the engine does meanwhile is behind
    // it. `empty`: nothing to show: the theme's launcher. From `shown` or `empty` to something not known to be slow (the
    // session's show of a prepared item: tens of ms), what's drawn stays for `loaderGrace`; the engine's own slow step
    // (`setLoading`) is `loading` at once. From `elsewhere` (its card, the theme's loader faded and still), the loader
    // at once: the card brightens and turns as its item comes back (Tirth, 2026-11-20: the launcher was drawn for the
    // grace in between).
    private func settlePage() {
        graceTimer?.invalidate()
        graceTimer = nil
        let t = now()
        let s = core.settle(now: t)
        guard s.grace else { return applyPage(s) }
        graceTimer = Timer.scheduledTimer(withTimeInterval: max(0, s.deadline - t), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.graceOver() }
        }
        // (The hole stays open meanwhile, and follows the window shown: the new one comes in before the old one leaves.)
        if s.hole_again { updateHole() }
    }

    // The grace is over and the item still isn't in place: the loader. (A test calls it for its own clock.)
    func graceOver() {
        graceTimer?.invalidate()
        graceTimer = nil
        applyPage(core.graceOver())
    }

    // The state the core applied, carried out.
    private func applyPage(_ s: MarginSettled) {
        // (The hole closed, or opened, before the page hears: leaving `shown`, the ground covers the page area at once;
        // into it, the theme's loader is still drawn over the hole until the page fades it.)
        updateHole()
        // (Shown with no field of Margin's wanting them: the panel never keeps the keys over the app shown.)
        if s.shown, !pageWantsKeyboard, hasKeys || panel.allowKey || (!options.harness && panel.isKeyWindow) { letGoKeys() }
        if s.changed {
            let state = pageState, label = loaderLabel
            Diagnostics.note("Margin's window \(id): page \(state.rawValue)\(hole.map { " (the hole \(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))×\(Int($0.height)))" } ?? "")")
            pageStates.append(state.rawValue + (label.map { " " + $0 } ?? ""))
            if pageStates.count > 200 { pageStates.removeFirst(pageStates.count - 200) }
            push(pageStateJSON)
        }
        keepFront()
    }

    var pageStateJSON: String {
        #"{"type":"pageState","state":"\#(pageState.rawValue)","label":"# + (loaderLabel.flatMap { jsonString($0) } ?? "null")
            + (loaderApp.flatMap { jsonString($0) }.map { #","bundleId":"# + $0 } ?? "") + (starting ? #","starting":true"# : "")
            + (starting ? startupStuck.flatMap { jsonString($0) }.map { #","stuck":"# + $0 } ?? "" : "") + (core.copySlow ? #","slow":true"# : "") + "}"
    }

    // The browser's copy asked to show the item is slow, or no longer (the session's, docs/LINK-RESILIENCE.md §1 rule
    // 8): the loader at once, and its page told, which says "Safari is slow…" under it.
    func setCopySlow(_ on: Bool) {
        guard core.setCopySlow(on) else { return }
        settlePage()
        push(pageStateJSON)
    }

    // Margin's start held up (HostedSession `holdStartup`): what's wrong, on the start screen with its two choices.
    var startupStuck: String? { core.text(.stuck) }
    func setStartupStuck(_ why: String?) {
        guard core.setStuck(why) else { return }
        Diagnostics.note("Margin's window \(id): the start screen \(why == nil ? "no longer held up" : "held up: what's wrong said, Try again and Continue without Safari")")
        push(pageStateJSON)
    }
    // Margin's start (HostedSession `startup`): its loader says "Getting you started…", not "Opening …" (the page's words).
    private var starting: Bool { core.read.starting }

    // The hosted window's bounds read from the window server (kept: a layout report, a pointer move never reads them).
    private func readHosted() {
        core.setHostedFrame(hosted.flatMap { hostedBounds($0) })
        sayHostedFrame()
    }
    // ...and said to the page as they change, in its coordinates (top left in the content; null: none hosted): a theme
    // with a bigger page area waits for the hosted window to take it before it shows (overlay.ts swapTheme).
    private var hostedFrameSent: String?
    private var hostedFrameJSON: String {
        guard let f = hostedFrame else { return "null" }
        let c = contentFrame
        return "[\(Int((f.minX - c.minX).rounded())),\(Int((f.minY - c.minY).rounded())),\(Int(f.width.rounded())),\(Int(f.height.rounded()))]"
    }
    private func sayHostedFrame() {
        let json = hostedFrameJSON
        guard asked, json != hostedFrameSent else { return }
        hostedFrameSent = json
        push(#"{"type":"hostedFrame","rect":"# + json + "}")
    }

    // The hole: where the hosted window shows through, only while the page is `shown`: its bounds inside the page area
    // (a window-mode app's window is smaller than it; one kept at a frame it had before the page area moved isn't the
    // page area's either). There, the window's own background is clear and the ground view fills everything else in
    // the theme's frame colour (around a smaller window, in a gap, under the loader; the window's own colour when the
    // page says none); the corners rounded where the hole's meet the page card's. Nowhere else, and in no other state, is anything of this
    // window see-through. The pointer's slot and the catch fill follow it.
    // The pointer's way looked at again whenever the slot changes (`pointerAgain`).
    private func updateHole() {
        if placeHole() { pointerAgain() }
        owner?.paneSceneChanged()
    }
    private func placeHole() -> Bool {
        let out = core.placeHole(content: contentFrame)
        let fill = out.fill.map { NSColor($0) } ?? .windowBackgroundColor
        switch out.ground {
        case .one(let hole, let radii):
            // (The ground drawn with its hole before the window's own background goes: no frame of it see-through elsewhere.)
            ground.show(color: fill, hole: hole, radii: radii)
            if panel.backgroundColor != .clear { panel.backgroundColor = .clear }
        case .several(let holes):
            ground.show(color: fill, holes: holes)
            if panel.backgroundColor != .clear { panel.backgroundColor = .clear }
        case .none:
            if panel.backgroundColor != fill { panel.backgroundColor = fill }
            ground.clear()
        }
        // The pointer's slot: the hole, less what the theme draws over it that takes the pointer (`hits`: the palette, a
        // menu, a notice) and the page card's rounded corners where the hole's are its; several: each one's hole (a
        // card's content alone while one is open). The core's (`PagePointer`).
        return placed(slot: out.slot, region: out.region)
    }

    // Where the hosted window goes while hosting: the page area from its own layout, measured in full screen at its
    // size (the theme's frame around it), and the display's full-screen area its own Space lays it out in. Nil until then.
    // The area is this window's own frame: a full-screen window, laid out exactly where the hosted window's own Space
    // lays out its full-screen window (seen 2026-11-15: the display's frame less its top safe-area inset said 0,32
    // 1512×950, both windows were at 0,33 1512×949, so the hosted window landed a point below the page area).
    // `display`: the screen's whole frame (a hosted window's tile in Margin's Space is laid out in it). Nil also while
    // this window isn't its screen's width: a tile added to or taken out of its Space lays it out as a split's half for a
    // moment (under the freeze; the engine sets its rect back at once), never a page area to place anything at. Only a
    // layout its page measured hosting: the launcher's, from before, has the sidebar docked whatever Keep open says,
    // and a hidden sidebar's page area is wider: placed by it, the window would be placed again at once. (The core's.)
    var hostedPlacement: HostPlacement? { core.hostedPlacement(content: contentFrame, display: displayFrame) }
    // Its page in the core and its content's and display's frames now: the session reads a drag's frame there (typed).
    var pageFrame: (page: OpaquePointer?, content: CGRect, display: CGRect?)? { (core.pointer, contentFrame, displayFrame) }
    // In full screen and narrower than its screen (laid out as a split's half by a tile change in its Space). The core's.
    private var narrowed: Bool {
        withUnsafePointer(to: displayFrame?.raw ?? MarginRect()) { margin_page_narrowed(isFullScreen, contentFrame.raw, displayFrame == nil ? nil : $0) }
    }

    // The page area as its page draws it now, not hosting (its launcher's layout), in full screen at its size: where a
    // browser's window made ready out of sight is placed (hosting's rect too while the sidebar is docked). Nil until
    // measured. (The core's.)
    var idlePlacement: HostPlacement? { core.idlePlacement(content: contentFrame) }

    // A window's bounds by the window server (CGWindowListCopyWindowInfo: no permission needed for bounds).
    nonisolated static func serverBounds(_ number: Int) -> CGRect? {
        guard let n = CGWindowID(exactly: number), let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, n) as? [[String: Any]],
              let raw = list.first?[kCGWindowBounds as String] else { return nil }
        return CGRect(dictionaryRepresentation: raw as! CFDictionary)
    }

    // Its page asked to measure now (overlay.ts `measure`): it reads the size the web view has, drawn or not.
    func remeasure() {
        guard hosting, asked else { return }
        push(#"{"type":"measure"}"#)
    }

    // The window's buttons where the theme draws its window controls (AppKit's own place when it draws none).
    func placeButtons() {
        guard let controls, !isFullScreen,
              let close = window.standardWindowButton(.closeButton), let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton), let bar = close.superview else { return }
        let step = mini.frame.minX - close.frame.minX
        let origins = MarginWindowGeometry.buttonOrigins(controls: controls, button: close.frame.size, step: step > 0 ? step : 20)
        let height = window.frame.height
        for (button, origin) in zip([close, mini, zoom], origins) {
            // Top left in the content (the window) → the button's superview's own coordinates.
            let inWindow = NSRect(x: origin.x, y: height - origin.y - button.frame.height, width: button.frame.width, height: button.frame.height)
            let placed = bar.convert(inWindow, from: nil).origin
            if button.frame.origin != placed { button.setFrameOrigin(placed) }
        }
    }

    // ---- the pointer (Margin's mouse monitors, the window server's coordinates: top left) ----

    // Whether the pointer goes through Margin's panel (to what it hosts) is the core's (`PageCore`: windowed, the
    // window's buttons are the base's, under the panel where the theme draws its window controls).
    // The pointer as the last move left it (with whether a button was held): the harness's pointer (its moves are
    // the tests' own); the real one is read from the window server (`NSEvent.mouseLocation`).
    private var lastPointer: (at: CGPoint, buttonsDown: Bool)?
    // The slot changed under a pointer that may be still (a card or a pane opening or closing, a layout's change, the
    // page's hits, the loader): where it is looked at again at once, so a still pointer over what's Margin's now is
    // Margin's without a move (the real screen, 2026-11-21: the preview card opened under a still pointer, which was last
    // over the page's hole, and Safari's toolbar resting under Margin's card bar showed its tooltip there). Only when
    // the slot changes, never in a drag's frames (the page area followed live) nor with a button held (a drag keeps its
    // way); nothing said to the page.
    private func pointerAgain() {
        guard !followingPage, window.isVisible || options.harness else { return }
        let now = options.harness ? lastPointer : (at: PointerWatch.location, buttonsDown: PointerWatch.buttonsDown)
        guard let now, !now.buttonsDown else { return }
        setIgnoring(core.again(now.at, content: contentFrame))
    }

    // Each pointer event: its way, its hover, the cut pane it's over and the position its page wants (one typed call).
    func pointerMoved(_ at: CGPoint, buttonsDown: Bool = PointerWatch.buttonsDown) {
        guard window.isVisible || options.harness else { return }
        lastPointer = (at, buttonsDown)
        let out = core.moved(at, content: contentFrame, buttonsDown: buttonsDown, now: Diagnostics.now())
        setIgnoring(out.pass)
        hover(at, inside: out.inside, buttonsDown: buttonsDown)
        if let over = out.hover { sayHover(over) }
        switch out.push {
        case .at(let x, let y): push(#"{"type":"pointer","x":\#(x),"y":\#(y)}"#)
        case .left(let x, let y): push(#"{"type":"pointerLeft","x":\#(x),"y":\#(y)}"#)
        case nil: break
        }
    }

    // The pointer over Margin's UI while its panel isn't key (the app it hosts has the keys, Tirth 2026-11-20: "hovering
    // the sidebar highlights nothing"). WebKit hit-tests a move for hover only in a page whose window is active
    // (WebFrame::handleMouseEvent: with no button down and the page not active, the move goes to the scrollbars alone;
    // active is its window key, PageClientImpl::isViewWindowActive), and Margin's panel is key only while a field or
    // menu of Margin's has the keys. So Margin's page does it itself: where the pointer is, said to the page
    // (`hoverAt`, in its CSS pixels), at most once per frame of its display (the last place wins: the first move after
    // a pause at once, the moves after it one frame apart at most, so it's never more than a frame late), which marks the element
    // there and its ancestors `m-hover` (app/shared/host/overlay.ts), and every theme's :hover also matches [m-hover].
    // Cleared as the pointer leaves for the hosted app or the window, a button goes down, or the panel becomes key
    // (WebKit's own hover from then on). Nothing private, nothing per move but a point kept.
    private var hoverLit = false
    private var hoverPending: CGPoint?
    private var hoverQueued = false
    private var hoverSaidAt = -Double.infinity
    // One frame of the display the window is on (its highest rate, a ProMotion display's 120 Hz).
    private var hoverFrame: TimeInterval { 1.0 / Double(max(30, panel.screen?.maximumFramesPerSecond ?? 60)) }
    private func hover(_ at: CGPoint, inside: Bool, buttonsDown: Bool) {
        let wanted = inside && !ignoring && !buttonsDown && !isClosed && !panel.isKeyWindow && (options.harness || window.isVisible)
        if wanted {
            let content = contentFrame
            hoverPending = CGPoint(x: at.x - content.minX, y: at.y - content.minY)
        } else {
            hoverPending = nil
            guard hoverLit else { return }
        }
        guard !hoverQueued else { return }
        hoverQueued = true
        let wait = hoverSaidAt + hoverFrame - ProcessInfo.processInfo.systemUptime
        if wait <= 0 { DispatchQueue.main.async { [weak self] in self?.flushHover() } } else { DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.flushHover() } }
    }
    private func flushHover() {
        hoverQueued = false
        guard !isClosed else { return }
        hoverSaidAt = ProcessInfo.processInfo.systemUptime
        if let p = hoverPending {
            hoverLit = true
            hoverPushes += 1
            pushHover(#"{"type":"hoverAt","x":\#(Double(p.x)),"y":\#(Double(p.y))}"#)
        } else if hoverLit {
            hoverLit = false
            hoverPushes += 1
            pushHover(#"{"type":"hoverAt"}"#)
        }
    }
    private(set) var hoverPushes = 0 // where the pointer is, said to the page (the tests read it)
    // (Not in `pushed`, the tests' list of what was pushed: a pointer's moves would push everything else out of it.)
    private func pushHover(_ json: String) {
        guard asked else { return }
        webView.callAsyncJavaScript("marginApp.receive(m)", arguments: ["m": json], in: nil, in: .page) { _ in }
    }

    // A press on the page area (the hosted window's, through the hole) or outside: a field of Margin's lets go, the
    // palette goes. A press in the page area around a smaller hosted window (window mode; on it, the app has it already)
    // gives that app the keyboard. Only while this window is on screen in the current Space (the monitor hears every
    // app's presses).
    // `number`: the press's event number (the window server's), how the pane click tap's own presses are known.
    func pressed(_ at: CGPoint, number: Int = 0) {
        // (Several visible: a card open catches a press on the page around its content; else the press's host is found
        // by its rect, HostedSession `pagePressed`, and focused.)
        // (A press on what the page draws over the page area, a split's divider: Margin's own, never a pane's.)
        let onHits = slot?.hits.contains { $0.contains(at) } == true
        if visibleHosts.count > 1, !onHits, pageState == .shown, !pageWantsKeyboard, options.harness || (window.isVisible && window.isOnActiveSpace), let page = window.pageRect, page.contains(at) {
            if let card = cardHole, !card.contains(at) {
                caughtPresses.append(at)
                if caughtPresses.count > 50 { caughtPresses.removeFirst() }
                owner?.onCaughtPress?(self, at)
            } else if owner?.paneTapClaimed(number: number, at: at) == true {
                // (The pane click tap gave its pane's window the keys for this press: focused already, and told to the
                // session by the tap's own word, `onPaneClick`. Fronting the layout again now would flip the app in
                // front while the press goes on.)
                tapClaimedPresses += 1
            } else {
                owner?.onPagePress?(self, at)
            }
        } else if hosted != nil, !onHits, pageState == .shown, !pageWantsKeyboard, options.harness || (window.isVisible && window.isOnActiveSpace), let page = window.pageRect, page.contains(at) {
            // (Never a press on Margin's own over the page area (a divider, a cut pane's arrow): 2026-11-22, an arrow's
            // press focused the pane under it, and a divider's the pane beside it.)
            owner?.onPagePress?(self, at)
        }
        // (Kept in front by its order: a press on the hosted window raised it over this one; above it again, once the
        // window server has done that.)
        if mechanism == .order, hosted != nil { DispatchQueue.main.async { [weak self] in self?.keepFront() } }
        guard pageWantsKeyboard, !contentFrame.contains(at) || core.gets(at) else { return }
        push(#"{"type":"pressOutside"}"#)
    }

    // (What the core decided, carried out: `ignoring` is the core's.)
    private func setIgnoring(_ on: Bool) {
        if panel.ignoresMouseEvents != on { panel.ignoresMouseEvents = on }
    }

    // ---- the keys (Margin's UI never makes the hosted app inactive) ----

    // A field of Margin's wants the keys (the page's `focus`): the panel key, the web view its first responder, Margin
    // not made the front app (a non-activating panel can be key while another app is: the hosted app keeps its active
    // look). The panel can be key ONLY then (`allowKey`): never because Margin was activated (check10's run of
    // 2026-11-17: after a press in the panel AppKit says Margin is active, `NSApp.isActive`, while the hosted app is
    // still the front app, and the panel kept the keys from then on). The web view is made first responder first: a
    // panel made key with no first responder keeps the keys itself (the old overlay's palette: its field focused, the
    // typing lost). Not shown yet (its first entry into full screen): made key once it is (`shownKeys`), never asked of
    // a panel off screen (the 13:05:34 last resort of that run).
    private func takeKeys() {
        panel.allowKey = true
        if panel.firstResponder !== webView { panel.makeFirstResponder(webView) }
        guard options.harness || (isShown && panel.isVisible) else { return }
        guard !hasKeys || !panel.isKeyWindow else { return }
        hasKeys = true
        keyAsks += 1
        Diagnostics.note("Margin's window \(id): a field of Margin's has the keys (its panel key\(appActive() ? "" : ", the app in front still the front app"))")
        guard !options.harness else { return } // (a test's panel is never made key: it would take the person's keys)
        panel.makeKey()
        // (The last resort, said: the panel still not key a moment later, so typing would go to the app under it.
        // Margin made the front app through Accessibility, which deactivates that app: never expected.)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self, !self.isClosed, self.isShown, self.panel.isVisible, self.pageWantsKeyboard, !self.panel.isKeyWindow else { return }
            self.lastResorts += 1
            let made = AXUIElementSetAttributeValue(AXUIElementCreateApplication(getpid()), kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success
            Diagnostics.warn("Margin's window \(self.id): its panel didn't become key for a field of Margin's (\(self.fullScreenState)): Margin made frontmost through Accessibility as a last resort (\(made ? "asked" : "refused"))")
            self.panel.makeKey()
            if self.panel.firstResponder !== self.webView { self.panel.makeFirstResponder(self.webView) }
        }
    }

    // Shown (its first entry, a show by hand): a field that asked for the keys before has them now.
    private func shownKeys() { if pageWantsKeyboard { takeKeys() } }

    // No field of Margin's has the keys: the panel can't be key, and isn't (it resigns if it is, whatever made it).
    private func letGoKeys() {
        panel.allowKey = false
        if hasKeys { keyLets += 1 }
        hasKeys = false
        if !options.harness, panel.isKeyWindow { panel.resignKey() }
    }

    // The keys to the hosted app shown, as the old overlay's `handBack` (7d7f62aa): the panel let go of them (unless a
    // field of Margin's has them), then that app activated by Margin, which yields to it first (`yieldActivation`,
    // `activate(from:)`: it is the front app already; this moves the keyboard back to its window and never deactivates
    // it), then the session's `fieldClosed` (the engine raises its window too). A field of Margin's let go, a press
    // in Margin's UI ended, an item shown, a menu item of Margin's ran, its picker or the quit prompt closed. Said the
    // first time and every 200th; each hand-back's app kept for the tests (`handBacks`).
    var hostedPid: (Int) -> pid_t? = { MarginWindowController.ownerPid($0) }
    var handBack: (pid_t) -> Void = { pid in
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return }
        NSApp.yieldActivation(to: app)
        app.activate(from: NSRunningApplication.current, options: [])
    }
    private(set) var handBacks: [pid_t] = []
    func keysBack(_ why: String) {
        guard let hosted, pageState == .shown else { return }
        if !pageWantsKeyboard { letGoKeys() }
        keysGivenBack += 1
        if keysGivenBack == 1 || keysGivenBack % 200 == 0 { Diagnostics.note("Margin's window \(id): the keys back to the app shown: \(why) (\(keysGivenBack) so far)") }
        if let pid = hostedPid(hosted) {
            handBacks.append(pid)
            if handBacks.count > 50 { handBacks.removeFirst(handBacks.count - 50) }
            if !options.harness { handBack(pid) }
        }
        owner?.onFieldClosed?(self)
    }

    nonisolated static func ownerPid(_ number: Int) -> pid_t? {
        guard let n = CGWindowID(exactly: number), let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, n) as? [[String: Any]] else { return nil }
        return (list.first?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
    }

    // Whether Margin is the front app (the menu bar's, by the workspace), never AppKit's `isActive`: a press in a
    // non-activating panel makes AppKit say active while the hosted app is still the front one (check10, 2026-11-17).
    nonisolated static func isFrontApp() -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
    }

    // A press in Margin's UI ended (the panel's). One the press tap delivered to the panel (docs/SIDEBAR-PRESS.md: an app
    // shown, no field of Margin's; known by its event number) never moved the keyboard: nothing to hand back, nothing
    // waited for. One the window server routed (no tap: Accessibility not granted, the records' layout refused,
    // `MarginSidebarTap` off; or covered there by another window) is looked at `pressSettle` later, once the page has had
    // the chance to say a field took the focus. Not if a field of Margin's has or wants the keys, or Margin is the front
    // app (its keys are its own then). A hosted app shown: the keys back to it (a routed press in a non-activating panel
    // moves the keyboard to Margin without making it the front app: a key after a click in the sidebar went to Margin,
    // check10 k1, 2026-11-17, and 2026-11-08 before). Nothing hosted, nothing opening (its launcher): Margin is made the
    // front app, as a press in its own window always made it (there's no app whose look it could take away).
    // `at`: where, top left in the panel's content; `number`: the press's event number (its release's is the same). A
    // press on its card (`elsewhere`: its item in another Margin window) takes the item back here, as this window
    // brought in front does: on another display the window can be the one in use without ever becoming key (its panel
    // never does for a press), and the card says "Click to show it here".
    static let pressSettle: TimeInterval = 0.08
    private(set) var deliveredPresses = 0 // presses the tap delivered to the panel: no hand-back (the tests and the dev hook read it)
    func pressEnded(at p: CGPoint, number: Int = 0) {
        let at = CGPoint(x: contentFrame.minX + p.x, y: contentFrame.minY + p.y)
        if !isClosed, pageState == .elsewhere, let page = window.pageRect, page.contains(at) { owner?.cardPressed(self) }
        if owner?.panelTapClaimed(number: number) == true { deliveredPresses += 1; return }
        guard !options.harness else { return afterPress() } // (a test's clock: at once)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pressSettle) { [weak self] in self?.afterPress() }
    }

    func afterPress() {
        guard !isClosed, !pageWantsKeyboard, !appActive() else { return }
        if hosted != nil, pageState == .shown { return keysBack("a press in Margin's UI ended") }
        if !hosting, loadingLabel == nil, showingLabel == nil, pageState == .empty { activate("a press in its launcher, nothing hosted") }
    }

    // ---- macOS's menu bar: the keys back once it's up again ----

    // Margin owns its full-screen Space, and macOS's own menu bar makes the Space's owner the active app as it comes down
    // there (the window server's rule: only an app with a Dock icon can be a full-screen Space's owner, and the hosted
    // apps have none; docs/PRIVATE-APIS.md "Considered, not used"). So the app Margin hosts loses the keyboard while the
    // bar is down. Margin made active while the pointer is at the display's top edge, an app shown and no field of
    // Margin's wanting the keys: the bar did it. Looked at 10 times a second until the bar is up again (the pointer out
    // of the top band, no button down, no menu open, no Control Center, Notification Center or menu-bar panel open, a
    // status item's menu included) for `barUpFor`, then the keys back to the app shown (`keysBack`, as after a press in
    // Margin's UI). Given up when another app comes in front (the person clicked it), a field of Margin's takes the keys
    // (a menu item opened the palette), nothing is shown, or after `barWatchMost`. (Decided by Tirth, 2026-11-19, after
    // the ownerless Space was tried and kept off this branch: feat/ownerless-space, DECISIONS.md.)
    nonisolated static let barBand: CGFloat = 40 // points from the display's top: the menu bar and the pointer pushing at it
    nonisolated static let barUpFor: TimeInterval = 0.4
    nonisolated static let barWatchMost: TimeInterval = 120
    private var barWatch: Timer?
    private(set) var barHandBacks = 0 // the keys given back after the bar went up (the tests read it)

    // The decision, on its own (tests/margin-window-tests.swift): Margin just made active, by macOS's menu bar?
    nonisolated static func madeActiveByBar(fullScreen: Bool, appShown: Bool, fieldWantsKeys: Bool, pointer: CGPoint, screen: CGRect) -> Bool {
        fullScreen && appShown && !fieldWantsKeys && pointer.y >= screen.maxY - barBand && pointer.x >= screen.minX && pointer.x <= screen.maxX
    }
    // ...and is the bar still down (the pointer at the top, a button held, a menu or a panel open)?
    nonisolated static func barDown(pointer: CGPoint, screen: CGRect, buttons: Int, menus: Int, panels: Bool) -> Bool {
        pointer.y >= screen.maxY - barBand || buttons != 0 || menus > 0 || panels
    }

    // A panel the menu bar opened, on screen: Control Center's (Wi-Fi, Bluetooth, the battery…), Notification Center's (the
    // clock), or any menu (a status item's own, an app's: the menu level). Read from the window server's on-screen list.
    nonisolated static func barPanelsOpen() -> Bool {
        let menuLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        return list.contains { d in
            let layer = d[kCGWindowLayer as String] as? Int ?? 0
            let owner = d[kCGWindowOwnerName as String] as? String ?? ""
            guard layer == menuLevel || owner == "Control Center" || owner == "Notification Center" || owner == "NotificationCenter",
                  let b = d[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return false }
            return r.height > 40
        }
    }

    // Margin became active (MarginWindows): watched if the bar did it.
    func becameActive() {
        guard !options.harness, window.isOnActiveSpace, let screen = window.screen ?? NSScreen.main,
              Self.madeActiveByBar(fullScreen: isFullScreen, appShown: hosted != nil && pageState == .shown, fieldWantsKeys: pageWantsKeyboard,
                                   pointer: NSEvent.mouseLocation, screen: screen.frame) else { return }
        watchBar(screen: screen)
    }

    private func watchBar(screen: NSScreen) {
        guard barWatch == nil else { return }
        Diagnostics.note("Margin's window \(id): made active by macOS's menu bar: the keys go back to the app shown once the bar is up again")
        let started = Date()
        var upSince: Date?
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                func stop() { self.barWatch?.invalidate(); self.barWatch = nil }
                guard !self.isClosed, self.appActive(), self.hosted != nil, self.pageState == .shown, !self.pageWantsKeyboard,
                      Date().timeIntervalSince(started) < Self.barWatchMost else { return stop() }
                if Self.barDown(pointer: NSEvent.mouseLocation, screen: screen.frame, buttons: NSEvent.pressedMouseButtons,
                                menus: self.owner?.menusTracking ?? 0, panels: Self.barPanelsOpen()) { upSince = nil; return }
                if let u = upSince {
                    guard Date().timeIntervalSince(u) >= Self.barUpFor else { return }
                    stop()
                    self.barHandBacks += 1
                    self.keysBack("macOS's menu bar went up again")
                } else { upSince = Date() }
            }
        }
        RunLoop.main.add(t, forMode: .common)
        barWatch = t
    }

    // Margin's own menu item run while it's the front app (clicked from its Dock icon, ⌘-Tab): the app shown gets
    // the activation back (a field the item opened takes the keys from the panel without it).
    func menuItemRan() {
        guard appActive(), hosted != nil, pageState == .shown else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pressSettle) { [weak self] in
            guard let self, self.appActive() else { return }
            self.keysBack("a menu item of Margin's ran")
        }
    }

    // ---- the window ----

    var mode: String { isFullScreen ? "fullscreen" : "windowed" }
    var windowsJSON: String {
        jsonString([["windowId": id, "id": id, "state": isFullScreen ? "fullscreen" : "normal", "focused": window.isKeyWindow || panel.isKeyWindow]]) ?? "[]"
    }

    func fullScreenChanged(_ on: Bool) {
        guard on != isFullScreen else { return }
        isFullScreen = on
        Diagnostics.note("Margin's window \(id): \(on ? "in full screen (its own Space)" : "windowed")")
        // (In full screen the base never takes the mouse: everything that does is the panel's. Windowed, its buttons.)
        window.ignoresMouseEvents = on
        if !on, hosting { owner?.onLeftFullScreen?(self) } // (hosting needs its own Space: HostedSession.swift)
        push(#"{"type":"windows","list":"# + windowsJSON + "}")
        updatePage()
        placeButtons()
        keepFront()
        if on {
            retryTimer?.invalidate()
            retryTimer = nil
            retry.entered()
            waitingSaid = nil
            attachPanel("in full screen")
            if enteringFirst {
                enteringFirst = false
                setAlpha(1)
                Diagnostics.note("Margin's window \(id) shown, in full screen")
                isShown = true
            }
            shownKeys()
            owner?.onEnteredFullScreen?(self)
        } else if options.alwaysFullScreen, !isClosed {
            // macOS took it out anyway (the green button, Mission Control): straight back in.
            backIntoFullScreen += 1
            Diagnostics.note("Margin's window \(id): out of full screen by macOS (it's always full screen): back into it")
            if options.harness { return fullScreenChanged(true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self, !self.isFullScreen, !self.isClosed else { return }
                self.firstAsked = true
                self.tryFullScreen("out of full screen by macOS")
            }
        }
    }

    // AppKit's toggle into full screen, unless it's in, on its way in (AppKit said so in the last 2 s, or its style
    // has it: MarginWindow refuses the toggle then anyway) or closed. A test's window: its stand-in's answer.
    @discardableResult
    private func enterFullScreen() -> Bool {
        guard !isFullScreen, !isClosed, !window.styleMask.contains(.fullScreen) else { return false }
        if let at = willEnterAt, Date().timeIntervalSince(at) < 2 { return false }
        fullScreenAsks += 1
        if options.harness {
            if options.harnessEnters?() ?? true { fullScreenChanged(true) }
            return true
        }
        window.toggleFullScreen(nil)
        return true
    }

    // Whether macOS would take the toggle now: Margin the active app, its window on screen in the current Space. (Opened
    // while another app's full-screen Space is current, the window is on a Desktop macOS hasn't switched to yet: asked
    // then, it's refused, `windowDidFailToEnterFullScreen`.) A test's window: its stand-in's answer.
    var canAskFullScreen: Bool {
        if options.harness { return options.harnessReady?() ?? true }
        return NSApp.isActive && window.isVisible && window.isOnActiveSpace
    }

    // Always full screen and not in: asked now if macOS would take it, at every event that can make it so and at a look
    // of its own (`lookAgain`), until it's in. Not yet takeable: Margin and its window brought forward (`bringForward`:
    // macOS then shows the Space the window is on; 0.8 s apart, three times at most, each said: after that it only
    // waits, never taking the keys again and again from the app the person went on in), nothing asked. Never before
    // its first ask, nor while it's on its way in.
    func tryFullScreen(_ why: String) {
        guard options.alwaysFullScreen, firstAsked, !isFullScreen, !isClosed else { return }
        let entering = window.styleMask.contains(.fullScreen) || willEnterAt.map { Date().timeIntervalSince($0) < 2 } == true
        let ready = canAskFullScreen
        let since = lastAskAt.map { Date().timeIntervalSince($0) } ?? .infinity
        if retry.shouldAsk(inFullScreen: isFullScreen, entering: entering, closed: isClosed, firstAsked: firstAsked, ready: ready, sinceLastAsk: since) {
            // (Takeable after a wait: its looks from the shortest delay again, so an ask macOS still refuses is made again soon.)
            if waitingSaid != nil {
                retry.takeable()
                retryTimer?.invalidate()
                retryTimer = nil
            }
            waitingSaid = nil
            if fullScreenAsks > 0 {
                fullScreenRetries += 1
                Diagnostics.note("Margin's window \(id): not in full screen (\(fullScreenState)): asked again (\(why))")
            }
            lastAskAt = Date()
            enterFullScreen()
        } else if !entering, !ready {
            fullScreenWaits += 1
            let state = fullScreenState
            if state != waitingSaid {
                waitingSaid = state
                Diagnostics.note("Margin's window \(id): full screen not asked yet (macOS takes it only with Margin active and its window on the current Space: \(state)): waiting (\(why))")
            }
            if let way = retry.forward(sinceLast: lastForwardAt.map { Date().timeIntervalSince($0) } ?? .infinity) {
                lastForwardAt = Date()
                fullScreenForwards += 1
                forwardWays.append(way)
                Diagnostics.note("Margin's window \(id): Margin was opened and isn't in front (\(state)): brought forward \(way.rawValue) (\(retry.forwards) of \(FullScreenRetry.forwardsMax))")
                if !options.harness { bringForward(way) }
            }
        }
        lookAgain()
    }

    // Margin, just opened by the person, brought in front. Its own activation first (macOS 14 and later may not honour
    // it for an app that isn't active: seen 2026-11-17, Margin opened by `open` from another app's full-screen Space
    // stayed inactive through three of them, and came forward at once when `open` named it again); then asked of
    // LaunchServices, as `open` does (a reopen of the running Margin: its window in front); then both.
    private func bringForward(_ way: FullScreenRetry.Forward) {
        if way != .launchServices {
            activate("opened and not in front: brought forward")
            NSRunningApplication.current.activate(options: [.activateAllWindows])
            window.makeKeyAndOrderFront(nil)
        }
        if way != .activation {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
                if let error { Diagnostics.note("Margin: LaunchServices didn't bring Margin forward (\(error.localizedDescription))") }
            }
        }
    }

    // Still not in: looked at again after the back-off's next delay (one look pending at a time; none once it's in or closed).
    private func lookAgain() {
        guard options.alwaysFullScreen, !isFullScreen, !isClosed, retryTimer == nil else { return }
        retryTimer = Timer.scheduledTimer(withTimeInterval: retry.nextLook(), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.retryTimer = nil
                self?.tryFullScreen("still not in")
            }
        }
    }

    // Margin became active (MarginWindows), or the current Space changed: macOS may take it now.
    func appBecameActive() { tryFullScreen("Margin active") }
    func spaceChanged() {
        core.spaceChanged(now: now())
        tryFullScreen("the Space changed")
        if isFullScreen, !options.harness, window.isOnActiveSpace { attachPanel("the Space changed") }
        lookBack()
    }

    // Its Space shown again (back from another app's full screen by a swipe, ⌘-Tab or Mission Control): macOS makes the
    // Space's owner, Margin, the active app, never the app shown in it (it has no Dock icon), so that app looked
    // inactive and its keys were Margin's until a click (Tirth, 2026-11-20). The keys go back to it, as after macOS's
    // menu bar. Looked at `backLooks` after the change (the activation can come after it), once at most per change;
    // never while a field or menu of Margin's wants them, another window of Margin's has them (the quit prompt, a file
    // picker, a sheet), or the menu bar's own watch runs.
    nonisolated static let backLooks: [TimeInterval] = [0.15, 0.5]
    nonisolated static func handsBackOnReturn(onActiveSpace: Bool, fullScreen: Bool, appShown: Bool, marginFront: Bool, fieldWantsKeys: Bool,
                                              otherWindowKey: Bool, modal: Bool, barWatched: Bool) -> Bool {
        onActiveSpace && fullScreen && appShown && marginFront && !fieldWantsKeys && !otherWindowKey && !modal && !barWatched
    }
    private var backLook = 0 // the Space change being looked at (a newer one replaces it)
    private(set) var returnHandBacks = 0 // the keys given back as its Space was shown again (the tests read it)
    private func lookBack() {
        backLook += 1
        let look = backLook
        for delay in Self.backLooks {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.backLook == look, !self.isClosed else { return }
                let key = NSApp.keyWindow
                guard Self.handsBackOnReturn(onActiveSpace: self.options.harness || self.window.isOnActiveSpace, fullScreen: self.isFullScreen,
                                             appShown: self.hosted != nil && self.pageState == .shown, marginFront: self.appActive(),
                                             fieldWantsKeys: self.pageWantsKeyboard, otherWindowKey: key != nil && key !== self.window && key !== self.panel,
                                             modal: NSApp.modalWindow != nil, barWatched: self.barWatch != nil) else { return }
                self.backLook += 1 // (once per change)
                self.returnHandBacks += 1
                Diagnostics.note("Margin's window \(self.id): its Space shown again with Margin the active app: the keys back to the app shown (\(Int(delay * 1000)) ms after)")
                self.keysBack("its Space shown again")
            }
        }
    }

    // The window's full screen asked (⌃⌘F, the page's own ask): refused while it's in full screen and always is.
    func toggleFullScreen() {
        if options.alwaysFullScreen, isFullScreen {
            refusedExits += 1
            return Diagnostics.note("Margin's window \(id): leaving full screen refused (Margin is always full screen)")
        }
        guard !options.harness else { return fullScreenChanged(!isFullScreen) } // (a test's window never leaves its place)
        // macOS ignores the toggle for a window of an app that isn't active, or one not on the current Space (seen
        // 2026-11-15 when Margin was opened from behind another app's full screen): Margin forward and its window key
        // first, then the toggle a moment later.
        if !NSApp.isActive || !window.isKeyWindow || !window.isOnActiveSpace {
            activate("its full screen asked (macOS takes the toggle only for the active app)")
            window.makeKeyAndOrderFront(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.window.toggleFullScreen(nil) }
            return
        }
        window.toggleFullScreen(nil)
    }

    // For the log when it doesn't happen (numbers only).
    var fullScreenState: String {
        "active \(NSApp.isActive), key \(window.isKeyWindow), on the current Space \(window.isOnActiveSpace), visible \(window.isVisible), full screen \(isFullScreen)"
    }

    func windowDidResize(_ notification: Notification) {
        if panel.frame != window.frame { panel.setFrame(window.frame, display: true) }
        updatePage()
        placeButtons()
        // (Laid out as a split's half by a tile change in its Space that Margin didn't make: an app quit or crashed, its
        // window closed. The engine sets every rect again at once: HostEngine `marginNarrowed`.)
        if hosting, narrowed { owner?.onNarrowed?(self) }
    }
    func windowDidChangeOcclusionState(_ notification: Notification) {
        if window.occlusionState.contains(.visible) { tryFullScreen("its window on screen") }
    }
    func windowDidMove(_ notification: Notification) { if panel.frame != window.frame { panel.setFrame(window.frame, display: false) }; updatePage() }
    func windowWillEnterFullScreen(_ notification: Notification) { willEnterAt = Date() }
    func windowDidEnterFullScreen(_ notification: Notification) { willEnterAt = nil; fullScreenChanged(true) }
    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        willEnterAt = nil
        Diagnostics.warn("Margin's window \(id): macOS didn't take it to full screen (\(fullScreenState)): asked again")
        lookAgain()
    }
    // About to leave full screen while hosting: the one shown parked first, while it's still in this window's Space.
    func windowWillExitFullScreen(_ notification: Notification) { if hosting { owner?.onLeavingFullScreen?(self) } }
    func windowDidExitFullScreen(_ notification: Notification) { willEnterAt = nil; fullScreenChanged(false); attachPanel("out of full screen") }
    func windowDidBecomeKey(_ notification: Notification) {
        owner?.becameKey(self); keepFront(); placeButtons()
        tryFullScreen("its window key")
    }
    func windowDidBecomeMain(_ notification: Notification) { keepFront(); tryFullScreen("its window main") }
    func windowDidResignKey(_ notification: Notification) { placeButtons() }
    func windowWillClose(_ notification: Notification) { owner?.closed(self) }

    // Closed by its close button (or Close Window) while it hosts: only this window goes, Margin keeps running, the
    // apps and pages it showed stay open (tabs of their spaces, not of a window). The one shown is parked first, while
    // this window's Space is still there (never left on a Desktop or in a Space macOS takes down), then the window
    // closes; held `closeWait` at most (closed anyway then: the session parks it once it can).
    private(set) var closeHeld = false
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard hosting, let hold = owner?.onClosing else { return true }
        if closeHeld { return false } // (pressed again while held: it closes once that's done)
        closeHeld = true
        var done = false
        let finish: () -> Void = { [weak self] in
            guard !done, let self, !self.isClosed else { return }
            done = true
            self.window.close()
        }
        Diagnostics.note("Margin's window \(id): closing while it hosts: what it shows parked first")
        hold(self, finish)
        DispatchQueue.main.asyncAfter(deadline: .now() + options.closeWait) { finish() }
        return false
    }

    // ---- the menu's actions ----

    func run(_ action: MarginMenuAction) {
        switch action.effect {
        case .page(let json): push(json)
        case .source(let type): ask(type, [:])
        case .newWindow: _ = owner?.open()
        }
    }

    // ---- the page ----

    // `kept`: false for a page's picture: the tests' list of what was pushed keeps only that one was (no page content kept).
    func push(_ json: String) { push(json, kept: true) }
    func push(_ json: String, kept: Bool) {
        guard asked else { return } // its hello, when it asks, has this already
        pushes += 1
        pushed.append(kept ? json : #"{"type":"pagePicture"}"#)
        if pushed.count > 50 { pushed.removeFirst(pushed.count - 50) }
        webView.callAsyncJavaScript("marginApp.receive(m)", arguments: ["m": json], in: nil, in: .page) { result in
            if case .failure(let error) = result { Diagnostics.warn("push into Margin's window failed: \(error.localizedDescription)") }
        }
    }

    // The space's own light or dark (M2.9 step 3, docs/SPACE-BACKGROUNDS.md Part B §3): this window's web view draws
    // in it, so the theme does (WebKit takes a web view's appearance as the page's `prefers-color-scheme` and
    // `light-dark()`, its system appearance on or off: space-appearance-tests.swift); nil, the window's (the system's).
    // Only Margin's own page: the hosted windows, Safari's pages among them, keep theirs. Set before the state that
    // shows the space is pushed (both go to the page in order), so its background and its theme change together.
    func followAppearance() {
        guard let owner else { return }
        let name: NSAppearance.Name? = owner.source.spaceAppearance(window: id).map { $0 == .dark ? .darkAqua : .aqua }
        guard webView.appearance?.name != name else { return }
        webView.appearance = name.flatMap { NSAppearance(named: $0) }
    }

    // The source's state changed: drawn again; its theme too, if that changed (another theme chosen, or this window
    // showing a space with another theme), and its light or dark first.
    func stateChanged() {
        guard asked, let owner else { return }
        followAppearance()
        let state = owner.source.stateText()
        push(#"{"type":"state","state":"# + state + #","windows":"# + windowsJSON + "}")
        if let theme = owner.theme(id, owner.source.spaceTheme(window: id)), theme != themeSent {
            themeSent = theme
            push(#"{"type":"theme","theme":"# + theme + "}")
        }
    }

    @discardableResult func ask(_ type: String, _ payload: JSONObject) -> JSONObject? {
        var payload = payload
        if payload["windowId"] == nil { payload["windowId"] = id }
        asks.append(type)
        return owner?.source.perform(type, payload)
    }

    func pageHello() -> String {
        asked = true
        sidebarResizing(false) // (a page loaded again mid-drag never says it's over)
        guard let owner else { return "null" }
        followAppearance() // (before the page draws anything: its first frame is in the space's light or dark)
        // (The facts this window reads, in the order the Swift read them; the hello itself the core's: its fields, their
        // order, the card's state and words, core/page/hello.rs.)
        let state = owner.source.stateText()
        let windows = windowsJSON, themes = owner.themes(), apps = owner.apps()
        let theme = owner.theme(id, owner.source.spaceTheme(window: id))
        themeSent = theme
        hostedFrameSent = hostedFrameJSON
        // (Every visible host's window while several are: the same as the `hostedFrames` push, kept as said.)
        let frames = hostedFramesJSON
        if !visibleHosts.isEmpty { hostedFramesSent = frames }
        return core.hello(windowId: id, pageMinimum: pageMinimum, texts: [
            owner.browser, mode, state, windows, themes, apps, marginPage, paneMinimumsJSON, minimumsJSON(appMinimums), paneLoadingJSON,
            paneCuts, elsewherePicture, hostedFrameSent, frames, theme,
        ])
    }

    func pageSend(type: String, payload: JSONObject) async throws -> JSONObject {
        // The window's own full screen (ui/actions.ts window.fullscreen's request), not the source's.
        if type == "toggleFullscreen" {
            toggleFullScreen()
            return ["ok": true, "result": true]
        }
        // A space's picture (Edit Theme Color's): the app's, not the source's.
        if type == "backgroundChoose" || type == "backgroundAdd" {
            guard let background = owner?.background else { return ["ok": false, "error": "Pictures aren’t available here."] }
            return await background(type, payload)
        }
        // A note's Allow (shared/notices.ts `safari-profile`): Safari's folder picked once, its profiles' names read.
        if type == "allowSafariProfiles" {
            SafariFolderGrant.ask(over: nil)
            return ["ok": true, "result": true]
        }
        return ask(type, payload) ?? ["ok": true, "result": true]
    }

    // A scroll event's phase change, as its page is told (nil: none worth telling: a move with the fingers down or
    // momentum under way). The momentum's start and end are told apart from the fingers' (a lift then momentum).
    nonisolated static func wheelPhaseName(phase: NSEvent.Phase, momentum: NSEvent.Phase) -> String? {
        if momentum.contains(.began) { return "momentum" }
        if momentum.contains(.ended) || momentum.contains(.cancelled) { return "momentumEnd" }
        if phase.contains(.mayBegin) { return "mayBegin" }
        if phase.contains(.began) { return "began" }
        if phase.contains(.ended) { return "ended" }
        if phase.contains(.cancelled) { return "cancelled" }
        return nil
    }
    // The device a gesture over this window's UI comes from (PointerKind.swift), told to its page as each starts, with
    // whether a trackpad that plays haptics is there and whether the system plays its interface sounds: Edit Theme
    // Color's ticks (M2.9 step 6, ui/picker/feedback.ts). The tests read what was told (the last 20).
    private(set) var pointersSaid: [String] = []
    func tellPointer(_ kind: PointerKind, haptics: Bool, uiSounds: Bool) {
        let message = PointerClassifier.message(kind, haptics: haptics, uiSounds: uiSounds)
        pointersSaid.append(message)
        if pointersSaid.count > 20 { pointersSaid.removeFirst(pointersSaid.count - 20) }
        push(message)
    }
    private(set) var wheelPhasesSaid: [String] = [] // (the tests read them; the last 20)
    func wheelPhase(_ name: String) {
        wheelPhasesSaid.append(name)
        if wheelPhasesSaid.count > 20 { wheelPhasesSaid.removeFirst(wheelPhasesSaid.count - 20) }
        push(#"{"type":"wheelPhase","phase":"\#(name)"}"#)
    }
    // The trackpad's tick, at once (NSHapticFeedbackManager, .now): its alignment for a space swipe's detent
    // (ui/behaviors/swipe.ts, Arc's feel, as Arc does it), a split's snap and Edit Theme Color's detents; a level's
    // change for its texture (M2.9 step 6, ui/picker/feedback.ts). Only a Force Touch trackpad being touched plays it.
    private(set) var haptics = 0
    private(set) var hapticLevels = 0 // (of `haptics`, the level's changes: the tests read them)
    private func hapticTick(level: Bool) {
        haptics += 1
        if level { hapticLevels += 1 }
        guard !options.harness else { return }
        NSHapticFeedbackManager.defaultPerformer.perform(level ? .levelChange : .alignment, performanceTime: .now)
    }

    // What the page said (`op`): its body's JSON as the page sent it (`json`: Margin.app's window's page, its hello's
    // `layoutText` and `saidText`), to the core as it comes; a body as an object (a test's, an older page) made JSON
    // first (a layout's report as `geometry`). Each op read and routed by the core (core/page/said.rs), carried out here.
    func pageSaid(_ op: String, _ body: JSONObject) {
        if var text = body["json"] as? String { return text.withUTF8 { said(op, $0) } }
        let data = op == "layout" ? (body["geometry"] as? JSONObject).flatMap { PageLayout.bytes($0) } : jsonText(SessionRules.json(body))
        guard let data else { return }
        data.withUnsafeBytes { said(op, $0.bindMemory(to: UInt8.self)) }
    }

    private func said(_ op: String, _ body: UnsafeBufferPointer<UInt8>) {
        switch core.said(op, body, content: contentFrame) {
        case .ready:
            guard !isReady else { return }
            isReady = true
            Diagnostics.note("Margin's window \(id): its page drawn")
            show()
            owner?.onReady?(self)
        case .layout(let taken, let panesChanged):
            guard taken else { return }
            // (Not each frame of a drag of the sidebar's edge: its last layout, once it's let go.)
            if hosting, !pageResizing, let layout {
                let said = "\(layout.mode) \(Int(layout.left))/\(Int(layout.top))/\(Int(layout.right))/\(Int(layout.bottom)) in \(Int(layout.width))×\(Int(layout.height))"
                if said != hostingLayoutSaid {
                    hostingLayoutSaid = said
                    Diagnostics.note("Margin's window \(id): hosting, its page measured \(said) (window \(Int(window.frame.width))×\(Int(window.frame.height)), full screen \(window.styleMask.contains(.fullScreen)))")
                }
            }
            updatePage()
            // (A split's panes laid out again with the page area where it was: a divider dragged, the axis or the order
            // changed. The session places the panes' windows, docs/PEEK-SPLIT.md §4.)
            if hosting, panesChanged { owner?.onPanes?(self) }
        case .peekRect(let next):
            // Where the theme draws the preview card page (overlay.ts reportPeekPage), in the window: the card's window goes there.
            guard next != cardRect else { return }
            cardRect = next
            owner?.onCardRect?(self)
        case .hits(let rects, let all):
            hits = rects
            captureAll = all
            updatePage()
        case .chrome(let controls, let drags):
            let had = self.controls
            self.controls = controls
            panel.dragRegions = drags
            placeButtons()
            // (The window's own buttons are the base's while windowed: a press there isn't the panel's.)
            if had != controls { owner?.paneSceneChanged() }
        case .focus(_, let had):
            // (The core kept the field's word as it read the op: `pageWantsKeyboard` is it now.)
            if had != pageWantsKeyboard { owner?.paneSceneChanged() }
            // A field of Margin's wants the keys (the palette, ⌘T or the menu's New Tab; a rename, an editor): the panel
            // takes them, Margin isn't made active (before 2026-11-17 it was, and the hosted app went to its inactive
            // look; the Accessibility frontmost of 1d728d4a is now only a said last resort, `takeKeys`).
            if pageWantsKeyboard { return takeKeys() }
            guard had else { return }
            // It let go (the palette closed, Escape): the panel lets go of them, the keys back to the hosted app shown.
            letGoKeys()
            keysBack("a field of Margin's let go")
        case .counts(let spaces, let items):
            guard rowCounts?.spaces != spaces || rowCounts?.items != items else { return }
            rowCounts = (spaces, items)
            owner?.onCounts?(self)
        case .want, .none:
            break
        case .fullScreen:
            toggleFullScreen()
        case .resizing(let on, let divider):
            // The sidebar's width being dragged, or let go (ui/behaviors/resize.ts), or a split's divider
            // (ui/behaviors/split.ts): the session's (it holds the hosted window's placing, or every pane's follows).
            sidebarResizing(on, divider: divider)
        case .haptic(let level):
            hapticTick(level: level)
        case .slide(let item, let side):
            // (A cut pane's arrow (ui/behaviors/split.ts): the session's, docs/PEEK-SPLIT.md §4b.)
            owner?.onPaneSlide?(self, item, side.rawValue)
        case .ask(let name, let arg):
            ask(name, arg)
        case .log(let warn, let text):
            let line = "Margin's window \(id): \(text)"
            if warn { Diagnostics.warn(line) } else { Diagnostics.note(line) }
        }
    }

    // Its page's word that a change of the sidebar's width began or is over, passed on once each way. A page that
    // goes (closed, its process ended, loaded again) mid-drag: over.
    // `divider`: a split's divider dragged (docs/PEEK-SPLIT.md §4), not the sidebar's edge: the same hold or live follow.
    private func sidebarResizing(_ on: Bool, divider: Bool = false) {
        guard on != pageResizing else { return }
        pageResizing = on
        owner?.onSidebarResizing?(self, on, divider)
    }

    // ---- navigation: only overlay.html ----

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        let ours = url?.scheme == OverlaySchemeHandler.scheme && url?.host == "app" && url?.path == OverlaySchemeHandler.page.path && action.targetFrame?.isMainFrame == true
        decisionHandler(ours ? .allow : .cancel)
    }

    // Its page's process died: loaded again (its state comes with the new hello).
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Diagnostics.warn("Margin's window \(id): its page stopped: loading it again")
        isReady = false
        asked = false
        sidebarResizing(false)
        pages.ready { [weak self] in self?.webView.load(URLRequest(url: OverlaySchemeHandler.page)) }
    }
}

// Every Margin window, and what the menu bar asks of them.
final class MarginWindows {
    struct Options {
        var harness = false
        var installsMenu = true
        var alwaysFullScreen = true // (Tirth, 2026-11-15) every Margin window full screen, never leaving it
        var front = FrontMechanism.level // how each window is kept in front of what it hosts
    }

    let pages: OverlayPages
    let source: MarginWindowSource
    let options: Options
    // The theme package a window draws (JSON; its id and the theme of the space it shows given: the source's
    // `spaceTheme`, nil: none of its own), nil for Arcadia; the imported themes' index (JSON).
    var theme: (Int, String?) -> String? = { _, _ in nil }
    var themes: () -> String = { "[]" }
    var apps: () -> String = { "null" } // the installed apps (ShellApps.swift), null with none read
    // A space's picture (M2.9 step 7, ShellBackgrounds.swift): `backgroundChoose` (the file picker) or `backgroundAdd`
    // (a dropped picture's bytes), answered `{ ok, result: { id } }`, `{ ok, result: null }` (cancelled) or `{ ok: false,
    // error }`. None: not here (a test's windows).
    var background: ((String, JSONObject) async -> JSONObject)?
    // A window's page area changed (MarginWindow.pageRect: hosting's own, or the hole's); its page drawn.
    var onPageRect: ((MarginWindowController, CGRect?) -> Void)?
    var onReady: ((MarginWindowController) -> Void)?
    var onLeavingFullScreen: ((MarginWindowController) -> Void)? // about to leave full screen while hosting
    var onLeftFullScreen: ((MarginWindowController) -> Void)? // left full screen while hosting
    var onEnteredFullScreen: ((MarginWindowController) -> Void)? // in full screen (again)
    var onPagePress: ((MarginWindowController, CGPoint) -> Void)? // a press in its page area around a window-mode host's window
    var onCaughtPress: ((MarginWindowController, CGPoint) -> Void)? // a card open: a press on the page area around its content (docs/PEEK-SPLIT.md §2)
    var onCardRect: ((MarginWindowController) -> Void)? // its page's <m-preview-page> moved, came or went (`cardRect`)
    var onPanes: ((MarginWindowController) -> Void)? // a split's panes laid out again by its page (docs/PEEK-SPLIT.md §4)
    // A window closing while it hosts: what it shows parked, then the closure called (it closes then).
    var onClosing: ((MarginWindowController, @escaping () -> Void) -> Void)?
    var onClosed: ((Int) -> Void)? // a window closed (its id): gone from `controllers`
    // The keys back to the hosted app shown (a field of Margin's let go of them, a press in Margin's UI ended, a menu
    // item of Margin's ran): that app activated again, which it already is (it never stopped being the active app).
    var onFieldClosed: ((MarginWindowController) -> Void)?
    var onOpen: ((MarginWindowController) -> Void)? // a window made, before its page loads (the session: the item it showed last)
    var onSidebarResizing: ((MarginWindowController, Bool, Bool) -> Void)? // a change of its sidebar's width (or a split's divider: true) began (a drag), or is over
    var onCounts: ((MarginWindowController) -> Void)? // its sidebar's spaces or numbered rows changed in number (its rowCounts)
    var onNarrowed: ((MarginWindowController) -> Void)? // in full screen while hosting and narrower than its screen (a tile change in its Space)
    var browser = "safari" // the engine hosted pages are in (Settings offers its features)
    private(set) var controllers: [MarginWindowController] = []
    private var lastKey: MarginWindowController?
    private var nextId = 1
    private let pointer = PointerWatch()
    let menuTarget = MarginMenuTarget()
    private(set) lazy var menu: NSMenu = MarginMenu.build(target: menuTarget, fullScreenItem: !options.alwaysFullScreen)

    init(pages: OverlayPages, source: MarginWindowSource, options: Options = Options()) {
        self.pages = pages
        self.source = source
        self.options = options
        source.onChange = { [weak self] in self?.sourceChanged() }
        menuTarget.handle = { [weak self] action in self?.perform(action) }
        menuTarget.enabled = { [weak self] action in action == .newWindow || self?.front != nil }
        pointer.onMove = { [weak self] at in for c in self?.controllers ?? [] { c.pointerMoved(at) } }
        if !options.harness { startKeyRelay(); startWheelPhases(); startPointers() }
        pointer.onPress = { [weak self] at, number in for c in self?.controllers ?? [] { c.pressed(at, number: number) } }
        // Margin activated (its Dock icon, ⌘-Tab): each window in front of what it hosts (the `order` mechanism orders
        // it there again), and one still not in full screen, its toggle ignored while Margin wasn't active, asked again.
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { for c in self?.controllers ?? [] { c.keepFront(); c.appBecameActive(); c.becameActive() } }
        }
        // (Margin's menus open, any of them: the menu bar watch keeps the keys while one is.)
        menuObservers = [
            NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.menusTracking += 1 } },
            NotificationCenter.default.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { if let s = self { s.menusTracking = max(0, s.menusTracking - 1) } } },
        ]
        // Another Space current, or another app in front (a hosted app activated: its window may have come over
        // Margin's at the same level): in front of it again (a window not on the current Space: nothing, `keepFront`).
        let workspace = NSWorkspace.shared.notificationCenter
        frontObservers = [
            workspace.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { for c in self?.controllers ?? [] { c.spaceChanged(); c.keepFront() }; self?.paneSceneChanged() }
            },
            workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
                let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
                MainActor.assumeIsolated {
                    for c in self?.controllers ?? [] { c.keepFront(); c.tryFullScreen("an app activated") }
                    self?.onFrontApp?(pid) // (all panes active: the split's other panes kept active again)
                }
            },
        ]
    }

    private var activeObserver: NSObjectProtocol?
    private var menuObservers: [NSObjectProtocol] = []
    private(set) var menusTracking = 0
    private var frontObservers: [NSObjectProtocol] = []
    deinit {
        for o in menuObservers { NotificationCenter.default.removeObserver(o) }
        if let keyRelay { NSEvent.removeMonitor(keyRelay) }
        if let wheelPhases { NSEvent.removeMonitor(wheelPhases) }
        if let pointers { NSEvent.removeMonitor(pointers) }
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        if let quitObserver { NotificationCenter.default.removeObserver(quitObserver) }
        paneTap?.stop()
        for o in frontObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
    }

    var anyVisible: Bool { controllers.contains { $0.window.isVisible } }

    // ---- a key that reached Margin while the keyboard is the hosted app's ----

    // The old shell's key relay (7d7f62aa, 2026-11-08), for Margin's panel: a press in a non-activating panel moves the
    // keyboard to Margin without making it the front app, and the keys go back as the press ends (`afterPress`). A
    // key that comes before that, or in any case Margin should never have, goes on to the app shown (its press and its
    // release, as it would have had them there) and the keys are handed back with it; said the first time and every
    // 100th (which key never). Margin's only when one of its windows really takes keys then: a field of Margin's in the
    // panel, the quit prompt, a picker, or Margin the front app.
    enum KeyWindow: Equatable { case none, base, panel, other }
    static func relayTarget(keyWindow: KeyWindow, fieldWantsKeys: Bool, front: pid_t?, margin: pid_t, shown: pid_t?) -> pid_t? {
        guard let front, front != margin, let shown, shown == front else { return nil }
        return keyWindow == .other || fieldWantsKeys ? nil : shown
    }
    private var keyRelay: Any?
    // The trackpad's phases over a window's UI (its panel): told to its page as they change (`wheelPhase`), for the
    // space swipe, which a web page's wheel events don't tell. Never consumed: the event goes on to the web view as is.
    private var wheelPhases: Any?
    private func startWheelPhases() {
        guard wheelPhases == nil else { return }
        wheelPhases = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self, event.hasPreciseScrollingDeltas, let c = self.controllers.first(where: { $0.panel === event.window }),
                  let name = MarginWindowController.wheelPhaseName(phase: event.phase, momentum: event.momentumPhase) else { return event }
            c.wheelPhase(name)
            return event
        }
    }
    // The device each gesture over a window's UI comes from (PointerKind.swift), told to its page (`tellPointer`). Never
    // consumed: the event goes on as is.
    private var pointers: Any?
    let gestureDevice = PointerClassifier()
    private func startPointers() {
        guard pointers == nil else { return }
        pointers = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .pressure, .scrollWheel]) { [weak self] event in
            guard let self, let c = self.controllers.first(where: { $0.panel === event.window }) else { return event }
            self.pointerSaw(event: event, in: c)
            return event
        }
    }
    /// An event's facts over a window's UI: what's new told to its page.
    func pointerSaw(_ facts: PointerFacts, in c: MarginWindowController) {
        guard let kind = gestureDevice.see(facts) else { return }
        c.tellPointer(kind, haptics: PointerClassifier.hapticTrackpad(), uiSounds: PointerClassifier.interfaceSounds())
    }
    private func pointerSaw(event: NSEvent, in c: MarginWindowController) {
        if let facts = PointerFacts(event) { pointerSaw(facts, in: c) }
    }
    private(set) var keysRelayed = 0
    private func startKeyRelay() {
        guard keyRelay == nil else { return }
        keyRelay = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard let self else { return event }
            let shownWindow = self.controllers.first { $0.hosted != nil && $0.pageState == .shown && $0.window.isOnActiveSpace }
            let key = NSApp.keyWindow
            let kind: KeyWindow = key == nil ? .none : self.controllers.contains { $0.panel === key } ? .panel : self.controllers.contains { $0.window === key } ? .base : .other
            let wants = self.controllers.contains { $0.pageWantsKeyboard }
            guard let c = shownWindow, let pid = Self.relayTarget(keyWindow: kind, fieldWantsKeys: wants, front: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                                                                  margin: ProcessInfo.processInfo.processIdentifier, shown: c.hosted.flatMap { c.hostedPid($0) }),
                  let cg = event.cgEvent?.copy() else { return event }
            cg.postToPid(pid)
            if event.type == .keyDown {
                self.keysRelayed += 1
                if self.keysRelayed == 1 || self.keysRelayed % 100 == 0 {
                    Diagnostics.warn("a key reached Margin while the keyboard is the app shown's (Margin's key window: \(kind)): sent on to it, the keys handed back (\(self.keysRelayed) so far)")
                }
                c.keysBack("a key reached Margin")
            }
            return nil
        }
    }

    // The key one, else the one key last, else the newest.
    var front: MarginWindowController? {
        controllers.first { $0.window.isKeyWindow || $0.panel.isKeyWindow } ?? lastKey.flatMap { k in controllers.first { $0 === k } } ?? controllers.last
    }

    // Margin's menu bar (not in a test: its app's menu stays the test's).
    func installMenu() {
        guard options.installsMenu, !options.harness else { return }
        // (AppKit adds its own Enter Full Screen item to a View menu unless told not to: Margin never leaves full screen.)
        if options.alwaysFullScreen { UserDefaults.standard.register(defaults: ["NSFullScreenMenuItemEverywhere": false]) }
        NSApp.mainMenu = menu
        NSApp.windowsMenu = menu.items.first { $0.submenu?.identifier?.rawValue == "margin.window-menu" }?.submenu
    }

    @discardableResult
    func open(_ windowOptions: MarginWindowController.Options? = nil) -> MarginWindowController {
        var o = windowOptions ?? MarginWindowController.Options()
        o.harness = o.harness || options.harness
        o.alwaysFullScreen = o.alwaysFullScreen || options.alwaysFullScreen
        if windowOptions == nil { o.front = options.front }
        let controller = MarginWindowController(id: nextId, pages: pages, options: o)
        nextId += 1
        controller.owner = self
        controller.window.onPageRectChange = { [weak self, weak controller] rect in
            guard let self, let controller else { return }
            self.onPageRect?(controller, rect)
        }
        controllers.append(controller)
        if !options.harness { pointer.start() }
        Diagnostics.note("Margin's window \(controller.id) opened (\(controllers.count) open)")
        onOpen?(controller)
        controller.load()
        return controller
    }

    // Margin opened again (its Dock icon, opened by hand): the window in front shown, or a new one.
    func reopen() {
        if let front { front.show() } else { open() }
    }

    // (Run while Margin is the active app, its menu bar's: the app shown gets the activation back after, `menuItemRan`.)
    // Margin's own menu items held (the start screen up, HostedSession `startupShown`): none of them runs.
    var holdsMenu: () -> Bool = { false }
    func perform(_ action: MarginMenuAction) {
        if holdsMenu() { return Diagnostics.note("Margin's menu: \(action.rawValue) not now, the start screen is up") }
        if action == .newWindow { open(); return }
        front?.run(action)
        front?.menuItemRan()
    }

    func becameKey(_ controller: MarginWindowController) { lastKey = controller; onKey?(controller.id) }
    // A Margin window brought in front (its item from another window comes back: HostedSession `focused`).
    var onKey: ((Int) -> Void)?
    // A press on a window's card (its item in another Margin window): the item back there, as when it's brought in front.
    func cardPressed(_ controller: MarginWindowController) {
        Diagnostics.note("Margin's window \(controller.id): its card pressed: its item back here")
        onKey?(controller.id)
    }

    func closed(_ controller: MarginWindowController) {
        controllers.removeAll { $0 === controller }
        if lastKey === controller { lastKey = nil }
        controller.teardown() // (closing already)
        if controllers.isEmpty { pointer.stop() }
        Diagnostics.note("Margin's window \(controller.id) closed (\(controllers.count) open; Margin keeps running)")
        onClosed?(controller.id)
        paneSceneChanged()
    }

    func closeAll() {
        endPaneTap("Margin quits")
        closingAll = true
        for c in controllers { c.close() }
        controllers = []
        lastKey = nil
        pointer.stop()
        closingAll = false
        onPanesActive?(nil) // (all panes active: no split shown any more)
    }

    // ---- the first click in another pane (PaneClickTap.swift) ----

    // The tap exists only while a Margin window shows several hosted windows on the current Space, Accessibility is
    // granted and Margin isn't quitting; it's told each change of that window's panes (`paneScene`). No longer wanted:
    // every press passes at once, and the tap goes `paneTapGrace` later unless it's wanted again by then (a layout's
    // change takes the panes away for a moment), at once when Margin quits.
    // `makePaneTap`: the real tap (never in a test, MARGIN_APP_TESTS); a test's stand-in otherwise. Its word on each press
    // it held comes back on the main thread (`onPaneClick`), its own lines into the log.
    lazy var makePaneTap: (_ report: @escaping @Sendable (PaneClickResult) -> Void, _ said: @escaping @Sendable (String) -> Void) -> PaneClickTapping? = { [weak self] report, said in
        guard !PrivateCalls.inTests else { return nil }
        let core = PaneClickCore(focuser: AXPaneFocus(fronting: self?.paneFronting(), delivery: self?.paneDelivery()), report: report)
        core.said = said
        return PaneClickTap(core: core, said: said)
    }
    // A press on Margin's own panel through the same tap (docs/SIDEBAR-PRESS.md): wanted while a Margin window on the
    // current Space hosts and the part isn't off (`defaults write com.unibox.margin MarginSidebarTap -bool NO`: today's
    // hand-back after a routed press). Its delivery is public calls only (PaneClickTap.swift `PanelEvents`): no records
    // needed. A test's stand-in answers its own.
    var sidebarTap: () -> Bool = { UserDefaults.standard.object(forKey: "MarginSidebarTap") as? Bool != false }
    // All panes active (PanesActive.swift): the window server's front process for the tap (the engine's; nil: none), the
    // split as the engine is told it (each change of the scene), each change of the front app (NSWorkspace's, the tap's
    // focus), and the apps kept active as the engine says them (the tap's scene carries them).
    var paneFronting: () -> PaneFronting? = { nil }
    var paneDelivery: () -> PaneFronting? = { nil }
    var onPanesActive: ((PaneClickScene?) -> Void)?
    var onFrontApp: ((pid_t?) -> Void)?
    private(set) var keptActive: Set<pid_t> = []
    private var paneSceneTold: PaneClickScene?
    func keptActiveChanged(_ pids: Set<pid_t>) {
        guard pids != keptActive else { return }
        keptActive = pids
        guard let tap = paneTap, var s = paneSceneTold else { return }
        s.kept = pids
        paneSceneTold = s
        tap.update(s)
    }
    var paneTapTrusted: () -> Bool = { AXIsProcessTrusted() }
    var paneTapGrace: TimeInterval = 1
    var onPaneClick: ((MarginWindowController, PaneClickResult) -> Void)?
    // A cut pane's arrow in a Margin window's page (`split.slide`: its item, the side): docs/PEEK-SPLIT.md §4b.
    var onPaneSlide: ((MarginWindowController, String, String) -> Void)?
    private(set) var paneTap: PaneClickTapping?
    private(set) var paneTapsMade = 0 // (the tests read them)
    private(set) var paneTapsEnded = 0
    private var paneTapEnd: DispatchWorkItem?
    private var paneTapRefusedSaid = false
    private var closingAll = false
    private var quitObserver: NSObjectProtocol?

    // A Margin window's panes changed (its holes, a field of Margin's took or let go of the keys, the Space changed, a
    // window closed): the tap made, told, or let go. The split's panes as before (all panes active hears only them);
    // every hosting window's panel with them, or alone (docs/SIDEBAR-PRESS.md).
    func paneSceneChanged() {
        let split = closingAll ? nil : controllers.lazy.compactMap { $0.paneScene }.first
        onPanesActive?(split)
        let panels = closingAll || !sidebarTap() ? [] : controllers.compactMap { $0.panelScene }
        var scene = split
        if !panels.isEmpty {
            if scene == nil { scene = PaneClickScene(marginWindows: controllers.flatMap { [$0.window.windowNumber, $0.panel.windowNumber] }.filter { $0 > 0 }) }
            scene?.panels = panels
        }
        scene?.kept = keptActive
        paneSceneTold = scene
        guard let scene else {
            guard let tap = paneTap else { return }
            tap.update(nil)
            guard paneTapEnd == nil else { return }
            if paneTapGrace <= 0 { return endPaneTap("nothing hosted or split on the current Space") }
            let end = DispatchWorkItem { [weak self] in self?.endPaneTap("nothing hosted or split on the current Space") }
            paneTapEnd = end
            DispatchQueue.main.asyncAfter(deadline: .now() + paneTapGrace, execute: end)
            return
        }
        paneTapEnd?.cancel()
        paneTapEnd = nil
        if let tap = paneTap { return tap.update(scene) }
        guard paneTapTrusted() else {
            if !paneTapRefusedSaid { Diagnostics.note("press tap: Accessibility isn't granted: a first click in another pane only focuses it, and a press on Margin's sidebar hands the keys back after it, as before") }
            paneTapRefusedSaid = true
            return
        }
        let report: @Sendable (PaneClickResult) -> Void = { [weak self] r in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.paneClicked(r) } }
        }
        let said: @Sendable (String) -> Void = { line in DispatchQueue.main.async { MainActor.assumeIsolated { Diagnostics.note(line) } } }
        guard let tap = makePaneTap(report, said) else { return }
        paneTap = tap
        paneTapsMade += 1
        tap.update(scene)
        tap.start()
        if quitObserver == nil {
            quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.endPaneTap("Margin quits") }
            }
        }
    }

    private func endPaneTap(_ why: String) {
        paneTapEnd?.cancel()
        paneTapEnd = nil
        guard let tap = paneTap else { return }
        tap.update(nil)
        tap.stop()
        paneTap = nil
        paneTapsEnded += 1
        Diagnostics.note("press tap: off (\(why))")
    }

    // A press the tap gave its pane's window the keys for (the monitor's press of `number` at `at`), consumed.
    func paneTapClaimed(number: Int, at: CGPoint) -> Bool { paneTap?.claimed(number: number, at: at) ?? false }
    // A press the tap delivered to a Margin window's panel (its release's `number`), consumed: the keyboard never moved.
    func panelTapClaimed(number: Int) -> Bool { paneTap?.claimedPanel(number: number) ?? false }

    private func paneClicked(_ r: PaneClickResult) {
        if case .delivered = r.outcome, r.crossApp { onFrontApp?(r.pid) } // (its app the front one: the one before kept active)
        guard let c = controllers.first(where: { $0.visibleHosts.contains { $0.window == r.window } }) else { return }
        onPaneClick?(c, r)
    }

    private func sourceChanged() {
        for c in controllers { c.stateChanged() }
    }

    // The installed apps changed: every window told (each page checks them: shared/apps.ts).
    func pushApps() {
        let json = apps()
        for c in controllers { c.push(#"{"type":"apps","apps":"# + json + "}") }
    }
}

// Always full screen (MarginWindowController `tryFullScreen`): when a window that isn't in full screen is asked. Never
// before its first ask, nor while it's in or on its way in, nor once closed; only when macOS would take it (`ready`:
// Margin active, its window on the current Space), and not twice within `minGap`. And when it's looked at again if
// nothing else happens: 0.3 s, doubling, then every 5 s, for as long as it isn't in (hosted-only Margin is always full
// screen); from the start again once macOS would take it, and once it has been in.
struct FullScreenRetry {
    static let delays: [TimeInterval] = [0.3, 0.6, 1.2, 2.4, 5]
    static let minGap: TimeInterval = 0.25
    static let forwardGap: TimeInterval = 0.8
    static let forwardsMax = 3
    // How Margin is brought forward: both at once from the first time (its own activation alone isn't honoured on macOS
    // 14 and later for an app that isn't active: at its open on 2026-11-18 23:02 the second try, through LaunchServices,
    // was the one that worked, 0.9 s on), then each again.
    enum Forward: String { case activation = "by its own activation", launchServices = "through LaunchServices", both = "by its own activation and through LaunchServices" }
    private(set) var looks = 0
    private(set) var forwards = 0

    func shouldAsk(inFullScreen: Bool, entering: Bool, closed: Bool, firstAsked: Bool, ready: Bool, sinceLastAsk: TimeInterval) -> Bool {
        !inFullScreen && !entering && !closed && firstAsked && ready && sinceLastAsk >= Self.minGap
    }

    // The next look's delay.
    mutating func nextLook() -> TimeInterval {
        let delay = Self.delays[min(looks, Self.delays.count - 1)]
        looks += 1
        return delay
    }

    // While macOS wouldn't take it: whether Margin and its window are brought forward now (macOS then shows the Space
    // the window is on), and how. 0.8 s apart and three times at most until it has been in: Margin opened and left for
    // another app's full-screen Space never takes that app's keys look after look.
    mutating func forward(sinceLast: TimeInterval) -> Forward? {
        guard forwards < Self.forwardsMax, sinceLast >= Self.forwardGap else { return nil }
        forwards += 1
        return .both
    }

    // macOS would take it now, after a wait: the looks from the shortest delay again.
    mutating func takeable() { looks = 0 }

    mutating func entered() { looks = 0; forwards = 0 }
}
