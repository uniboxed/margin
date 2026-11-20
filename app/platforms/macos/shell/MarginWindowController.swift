// Margin's own windows (MarginWindow.swift; docs/MARGIN-APP.md phase 2): each
// one the overlay's page (OverlayPages: the same UI, its configuration and
// bridge) in a MarginWindow, fed from a MarginWindowSource instead of a
// browser's copy.
//
// - The page's hello says `host: 'app-window'` (ui/host-app.ts appWindow): it
//   draws the whole app, in the window's mode (windowed or full screen, pushed
//   as its `windows` list as it changes), never as a layer over a browser.
// - Its state is the source's `snapshot()` (the State shape pages draw), pushed
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
import WebKit

// Where Margin's windows get their spaces (until the app owns them: the library phase's store, with the same
// two calls). `snapshot()`: the whole state, in the shape pages draw (types/margin.d.ts State, as
// shared/stored.ts fromStorage gives it); `perform`: a request of the UI's (its `send` type and payload, or a
// `perform` name and argument), the window's id in the payload as `windowId`, answered as the page's request is
// (`{ ok, result }` or `{ ok: false, error }`; nil: done, `{ ok: true, result: true }`); `onChange`: the snapshot changed.
protocol MarginWindowSource: AnyObject {
    func snapshot() -> JSONObject
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
    private(set) var isFullScreen = false
    // Its stage (MarginStage.swift): the full-screen Space Margin Space.app's window started, which this window, its
    // panel and its backdrop join as plain members (`isFullScreen` true while they're in it). Nil: not joined (or Margin
    // owns its Space: AppKit's full screen, the fallback).
    private(set) var stageSpace: UInt64?
    private var stageOpening = false
    private(set) var stageFell = false // this window fell back to AppKit's full screen for the rest of its life
    private(set) var menuBar: MarginMenuBar?
    private var stageHidden = false // out of sight while its stage is lost, until it's in one again
    private(set) var layout: PageLayout?
    private(set) var hits: [CGRect] = []
    private(set) var captureAll = false
    private(set) var controls: CGRect?
    private(set) var ignoring = false
    private(set) var pointerWant = PointerWant.all
    private(set) var pageWantsKeyboard = false
    private var pointerInside = false
    private var lastPointerPush: TimeInterval = 0
    private var themeSent: String?
    // What was pushed into the page, the last 50 (the tests read it), and how many in all.
    private(set) var pushed: [String] = []
    private(set) var pushes = 0
    // The source's requests from this window (the tests read it).
    private(set) var asks: [String] = []
    // Hosting another app's window in its page area (setHosting): the display's full-screen area (top left).
    private(set) var hosting = false
    private(set) var hostDisplay: CGRect?
    private var hostingLayoutSaid: String? // the last layout logged while hosting (numbers only)
    // The hosted window shown in the page area (the engine's host in this window's Space), this window in front of it.
    private(set) var hosted: Int?
    // Its bounds by the window server (top left; nil: unread), read when it's shown or placed. A test's stand-in reads its own.
    var hostedBounds: (Int) -> CGRect? = { MarginWindowController.serverBounds($0) }
    private var hostedFrame: CGRect?
    // The engine's slow step (a first open, a placing again): the app's name; an item the session is showing that
    // isn't ready yet: its name. Either: the page card is `loading` (the second only after `loaderGrace`).
    private(set) var loadingLabel: String?
    private(set) var showingLabel: String?
    // The app whose icon the loader shows with each (a bundle id: the app's, or the browser's for a web item): the page
    // looks the icon up in its list of installed apps (`bundleId` in `pageState`, the hello's `pageOpeningBundleId`).
    private(set) var loadingApp: String?
    private(set) var showingApp: String?
    private var showingSlow = false // the session's show is known to take a while (the last item at launch): the loader at once
    // The page card's state as the page was told (`m-page-state` on the theme's root), and the loader's name.
    // `elsewhere`: not hosting, its item in another Margin window or parked (one window hosts at a time): its card, faded
    // ("Click to show … here"); focused, the item comes back here (HostedSession `focused`).
    enum PageState: String { case empty, loading, shown, elsewhere }
    private var elsewhereLabel: String?
    private var elsewhereApp: String?
    // A web item's page, as Safari showed it before it left for the other window (a data URL): the page draws it faded
    // under the card's words (`pagePicture`, sent apart from `pageState`: it's large). In memory only, never logged.
    private(set) var elsewherePicture: String?
    func setElsewhere(_ label: String?, app: String?, picture: String?) {
        let picture = label == nil ? nil : picture
        if picture != elsewherePicture {
            elsewherePicture = picture
            push(pagePictureJSON, kept: false)
        }
        guard label != elsewhereLabel || app != elsewhereApp else { return }
        elsewhereLabel = label
        elsewhereApp = label == nil ? nil : app
        settlePage()
    }
    private var pagePictureJSON: String {
        #"{"type":"pagePicture","data":"# + (elsewherePicture.flatMap { jsonString($0) } ?? "null") + "}"
    }
    private(set) var pageState = PageState.empty
    private(set) var loaderLabel: String?
    private(set) var loaderApp: String?
    private var graceTimer: Timer?
    private(set) var pageStates: [String] = [] // each state the page was told, in order, the last 200 (the tests read it)
    // Where the hosted window shows through (the window server's coordinates, top left): the hole. Nil: nothing does.
    private(set) var hole: CGRect?
    // Where the pointer goes through to the hosted window (PassThrough.swift), made with the hole (updateHole); nil
    // while nothing shows through (the launcher, the loader: the pointer is Margin's everywhere).
    private(set) var slot: Slot?
    // The items loading as the page was last told (the UI's numbers), and a window of the engine's not shown yet (cover).
    private(set) var loadingTabs: [Int] = []
    private(set) var covering: Int?
    // The ground's colour while hosting: the colour around the page card (the theme's frame), around the hosted window
    // and under the loader; nil: the window's own background (nothing hosted, a theme that says no colour).
    private(set) var pageGround: NSColor?
    let ground = WindowGroundView(frame: .zero)
    // In front of what it hosts (keepFront, frontRead): how, another app's window it lets in front, and what was done
    // (the tests read the counts). The window server's word on a window's level (the dev hook's line); a test's stand-in
    // answers its own. Whether its window is on the current Space, and the clock (a test's stand-ins for both).
    private(set) var mechanism: FrontMechanism
    private(set) var yieldingTo: Int?
    private(set) var levelSets = 0
    private(set) var frontOrders = 0
    private(set) var yieldOrders = 0
    private(set) var frontRestores = 0 // the poll found the hosted window above it: put right at once
    private(set) var levelProbes = 0 // kept in front by its order, the raised level tried again
    private(set) var levelBacks = 0 // ...and held: back to the raised level
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
    private var changedAt = -Double.infinity // when it last changed its own level or order
    private var spaceChangedAt = -Double.infinity // when the current Space last changed
    private var missAt: Double? // the first read at rest, since the last one that held, of the raised level not held
    private var probing = false // kept in front by its order, the raised level set again: the next read at rest says
    private var probedAt = -Double.infinity
    private var reorder = false // a yield just ended: ordered above the hosted window again, beside its level
    private var levelSaid = false
    private var wrongSaid = false
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
        let frame = options.harness ? (options.frame ?? Self.harnessFrame) : (options.frame ?? Self.centred())
        window = MarginWindow(frame: frame, harness: options.harness)
        mechanism = options.front
        webView = pages.makeWebView(size: frame.size)
        panel = MarginPanel(frame: frame, harness: options.harness)
        super.init()
        // (The base draws nothing: an empty, clear content view. Everything drawn is in the panel.)
        let base = NSView(frame: NSRect(origin: .zero, size: frame.size))
        base.wantsLayer = true
        base.layer?.backgroundColor = .clear
        window.contentView = base
        panel.base = window
        panel.pressEnded = { [weak self] in self?.pressEnded() }
        webView.takesEditKeys = { [weak self] in self.map { $0.hasKeys && $0.pageWantsKeyboard && !$0.appActive() } ?? false }
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
        // In its stage's Space the panel is the group's parent (`placeGroup`): this window its child, below it.
        if stageSpace != nil {
            if !panel.isVisible { panel.orderFrontRegardless(); Diagnostics.warn("Margin's window \(id): its panel wasn't on screen (\(why)): ordered in again") }
            if window.parent !== panel { panel.addChildWindow(window, ordered: .below); Diagnostics.warn("Margin's window \(id): it wasn't its panel's child any more (\(why)): made it again") }
            return
        }
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
            if let b = backdrop { b.parent?.removeChildWindow(b); if b.isVisible { b.orderOut(nil) } }
            return
        }
        let parent: NSWindow = stageSpace != nil ? panel : window // (the group's parent: the panel in a stage)
        let frame = MarginBackdrop.frame(window: window.frame, screen: window.screen?.frame)
        let b = backdrop ?? MarginBackdrop(frame: frame)
        backdrop = b
        if b.frame != frame { b.setFrame(frame, display: false) }
        if b.level != MarginBackdrop.level { b.level = MarginBackdrop.level }
        if b.parent !== parent {
            let lost = b.isVisible // (taken out on purpose when this window left full screen: not on screen then)
            b.parent?.removeChildWindow(b)
            parent.addChildWindow(b, ordered: .below)
            backdropAttached += 1
            if b.level != MarginBackdrop.level { b.level = MarginBackdrop.level }
            if lost { Diagnostics.warn("Margin's window \(id): its backdrop wasn't its child any more (\(why)): made its child again") }
        } else if !options.harness, stageSpace == nil, window.isOnActiveSpace, !b.isOnActiveSpace {
            window.removeChildWindow(b)
            b.orderOut(nil)
            window.addChildWindow(b, ordered: .below)
            Diagnostics.warn("Margin's window \(id): its backdrop wasn't in Margin's Space (\(why)): made its child again there")
        }
        // Below every normal window, as the window server has it, or never used again by this window.
        if let layer = b.serverLayer, layer >= 0 {
            b.parent?.removeChildWindow(b)
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
        stopMenuBar()
        if stageSpace != nil || stageOpening { owner?.stage?.close(id: id) }
        stageSpace = nil
        stageOpening = false
        pages.bridge.unregister(webView)
        webView.navigationDelegate = nil
        webView.stopLoading()
        window.delegate = nil
        panel.parent?.removeChildWindow(panel)
        window.parent?.removeChildWindow(window)
        panel.orderOut(nil)
        if let b = backdrop { b.parent?.removeChildWindow(b); b.orderOut(nil) }
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

    // The page area again (the layout, the window's frame or what's over the page changed), and the hole with it.
    func updatePage() {
        let content = contentFrame
        defer { updateHole() }
        guard let layout else { return window.setPageRect(nil, radius: 0) }
        // (Laid out as a split's half for a moment by a tile change in its Space: the page area left as it was.)
        if hosting, narrowed { return }
        if hosting { return window.setPageRect(hostedPlacement?.page, radius: CGFloat(layout.radius)) }
        // (A layout from before a resize changes nothing: the page's next one, at the new size, does.)
        guard MarginWindowGeometry.measuredAt(layout, content.size) else { return }
        window.setPageRect(MarginWindowGeometry.pageRect(layout: layout, content: content), radius: CGFloat(layout.radius))
    }

    // ---- hosting another app's window in its page area (HostedSession.swift) ----

    // On: its page draws its own layout with the sidebar docked and no launcher in the page area (`pageHosted`), its
    // page area the hosted window's placement. Off: the theme's launcher there again. Its width and its size
    // constraints never change for it (the hosted window is a member of its Space under it, not a tile).
    func setHosting(_ on: Bool) {
        guard on != hosting else { return }
        hosting = on
        if on {
            hostDisplay = window.screen.map { MarginWindowGeometry.fullScreenArea($0) } ?? contentFrame
            Diagnostics.note("Margin's window \(id): hosting in its page area\(hostDisplay.map { " (the display's full-screen area \(Int($0.width))×\(Int($0.height)))" } ?? "")")
        } else {
            hosted = nil
            hostedFrame = nil
            setPageMinimum(nil)
            loadingLabel = nil
            showingLabel = nil
            loadingApp = nil
            showingApp = nil
            showingSlow = false
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
        guard label != loadingLabel || (label != nil && app != loadingApp) else { return }
        loadingLabel = label
        loadingApp = label == nil ? nil : app
        Diagnostics.note("Margin's window \(id): \(label == nil ? "loading done" : "loading an app in the page area")")
        if label == nil { readHosted() }
        settlePage()
    }

    // An item being shown by the session and not ready yet (its name; nil: it is, or it failed): not known to be slow
    // (a switch between prepared windows is tens of ms), so what's drawn stays for `loaderGrace` and the loader comes
    // only if it isn't ready by then. `slow`: known to take a while (the item the window showed last, at launch,
    // before its window is even in full screen): the loader at once, from the page's first frame (its hello has it).
    func setShowing(_ label: String?, app: String?, slow: Bool) {
        guard label != showingLabel || (label != nil && app != showingApp) else { return }
        showingLabel = label
        showingApp = label == nil ? nil : app
        showingSlow = label != nil && slow
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
        guard number != hosted else { if number != nil { hostedMoved() }; return }
        hosted = number
        Diagnostics.note("Margin's window \(id): \(number.map { "in front of the hosted window \($0)" } ?? "no hosted window under it")")
        readHosted()
        settlePage()
    }

    // The hosted window was placed again where it is (a window-mode app moved, one kept at the frame it had): its
    // bounds read again, the hole and the pointer's slot with them.
    func hostedMoved() {
        readHosted()
        updateHole()
    }

    // The hosted window follows a drag of the sidebar's edge live (the engine's tiles): the hole is the page area as it
    // is meanwhile (its window a frame behind at most), its bounds read again once it's over.
    private var followingPage = false
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
        guard on != followingPage else { return }
        followingPage = on
        if !on { readHosted() }
        updateHole()
    }

    // A window of the engine's in Margin's Space that isn't shown yet (a new app's, read; a browser's made ready out of
    // sight): what the `order` mechanism orders this window above meanwhile; nil: no more. (The `level` mechanism needs
    // no window: it's above every normal one.)
    func cover(_ number: Int?) {
        guard number != covering else { return }
        covering = number
        keepFront()
    }

    // A normal window of another app on screen in this window's Space that the person opened (a hosted app's Settings,
    // a second document: HostEngine `others`): it comes in front, this window right below it at the normal level until
    // it's gone (nil).
    func yield(to number: Int?) {
        guard number != yieldingTo else { return }
        yieldingTo = number
        if number == nil { reorder = true }
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
        let up = isFullScreen && yieldingTo == nil
        let level: NSWindow.Level = up && (mechanism == .level || probing) ? FrontMechanism.raised : .normal
        if window.level != level {
            setLevel(level)
            levelSets += 1
            changedAt = now()
        }
        if up, mechanism == .order || reorder, let target = hosted ?? covering {
            orderAbove(target)
            frontOrders += 1
            changedAt = now()
        }
        if up { reorder = false }
        if let other = yieldingTo {
            if stageSpace != nil { panel.order(.below, relativeTo: other) } else { window.order(.below, relativeTo: other) }
            panelOnTop()
            yieldOrders += 1
            changedAt = now()
        }
    }

    // Its level, and its panel's: always the same (the panel's own UI above every normal window exactly when this one is).
    private func setLevel(_ level: NSWindow.Level) {
        window.level = level
        if panel.level != level { panel.level = level }
        // (Its backdrop never follows it up: below every normal window whatever this one's level.)
        if let b = backdrop, b.parent != nil, b.level != MarginBackdrop.level { b.level = MarginBackdrop.level }
    }

    // Ordered right above a window, its panel right above it (AppKit keeps a child above its parent; said again).
    private func orderAbove(_ number: Int) {
        // (In a stage the panel is the group's parent: it's ordered, this window comes with it, below it.)
        if stageSpace != nil { return panel.order(.above, relativeTo: number) }
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
    static let settle = 0.5, missApart = 1.0, probeEvery = 5.0
    func frontRead(_ read: HostEngine.FrontRead) {
        guard !isClosed, isFullScreen, yieldingTo == nil, hosted == read.hosted, onCurrentSpace() else { return }
        let t = now()
        let atRest = t - changedAt >= Self.settle - 1e-9 && t - spaceChangedAt >= Self.settle - 1e-9
        if !read.marginAbove {
            if !wrongSaid {
                wrongSaid = true
                Diagnostics.warn("Margin's window \(id): the hosted window \(read.hosted) above it in the window server's order (its layer \(read.marginLayer), kept in front by its \(mechanism.rawValue)): in front of it again")
            }
            frontRestores += 1
            if window.level == FrontMechanism.raised { setLevel(.normal); setLevel(FrontMechanism.raised); levelSets += 1 }
            orderAbove(read.hosted)
            frontOrders += 1
            changedAt = t
        } else if atRest {
            wrongSaid = false
        }
        guard atRest else { return }
        let held = read.marginLayer == FrontMechanism.raised.rawValue
        switch mechanism {
        case .level:
            if held {
                missAt = nil
                if !levelSaid { levelSaid = true; Diagnostics.note("Margin's window \(id): in front by its level (\(read.marginLayer), held by the window server)") }
            } else if let first = missAt, t - first >= Self.missApart - 1e-9 {
                missAt = nil
                mechanism = .order
                setLevel(.normal)
                levelSets += 1
                orderAbove(read.hosted)
                frontOrders += 1
                changedAt = t
                probedAt = t
                Diagnostics.warn("Margin's window \(id): its raised level isn't held by the window server (it says \(read.marginLayer) at reads \(Int((t - first) * 1000)) ms apart, at rest): kept in front by its order instead, the level tried again every \(Int(Self.probeEvery)) s")
            } else {
                if missAt == nil { missAt = t }
                // (Set again, as it may have been lost: the next read at rest says.)
                setLevel(.normal)
                setLevel(FrontMechanism.raised)
                levelSets += 1
                changedAt = t
            }
        case .order:
            guard options.front != .order else { return } // (asked for: kept)
            if probing {
                probing = false
                probedAt = t
                if held {
                    mechanism = .level
                    levelBacks += 1
                    levelSaid = true
                    Diagnostics.note("Margin's window \(id): its raised level held by the window server again (\(read.marginLayer)): in front by its level again")
                } else {
                    setLevel(.normal)
                    levelSets += 1
                    orderAbove(read.hosted)
                    frontOrders += 1
                    changedAt = t
                }
            } else if t - probedAt >= Self.probeEvery - 1e-9 {
                probing = true
                levelProbes += 1
                setLevel(FrontMechanism.raised)
                levelSets += 1
                changedAt = t
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
    // (`setLoading`) is `loading` at once.
    private func settlePage() {
        let ready = hosting && hosted != nil && loadingLabel == nil && showingLabel == nil
        let target: PageState = !hosting ? (elsewhereLabel != nil ? .elsewhere : .empty) : ready ? .shown : .loading
        graceTimer?.invalidate()
        graceTimer = nil
        if target == .loading, pageState != .loading, loadingLabel == nil, !showingSlow, options.loaderGrace > 0 {
            graceTimer = Timer.scheduledTimer(withTimeInterval: options.loaderGrace, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.graceOver() }
            }
            // (The hole stays open meanwhile, and follows the window shown: the new one comes in before the old one leaves.)
            if pageState == .shown { updateHole() }
            return
        }
        applyPage(target)
    }

    // The grace is over and the item still isn't in place: the loader. (A test calls it for its own clock.)
    func graceOver() {
        graceTimer?.invalidate()
        graceTimer = nil
        let ready = hosting && hosted != nil && loadingLabel == nil && showingLabel == nil
        applyPage(!hosting ? (elsewhereLabel != nil ? .elsewhere : .empty) : ready ? .shown : .loading)
    }

    private func applyPage(_ state: PageState) {
        let label = state == .loading ? loadingLabel ?? showingLabel : state == .elsewhere ? elsewhereLabel : nil
        let app = state == .loading ? loadingLabel != nil ? loadingApp : showingApp : state == .elsewhere ? elsewhereApp : nil
        let changed = state != pageState || label != loaderLabel || app != loaderApp
        pageState = state
        loaderLabel = label
        loaderApp = app
        // (The hole closed, or opened, before the page hears: leaving `shown`, the ground covers the page area at once;
        // into it, the theme's loader is still drawn over the hole until the page fades it.)
        updateHole()
        // (Shown with no field of Margin's wanting them: the panel never keeps the keys over the app shown.)
        if state == .shown, !pageWantsKeyboard, hasKeys || panel.allowKey || (!options.harness && panel.isKeyWindow) { letGoKeys() }
        if changed {
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
            + (starting ? startupStuck.flatMap { jsonString($0) }.map { #","stuck":"# + $0 } ?? "" : "") + "}"
    }

    // Margin's start held up (HostedSession `holdStartup`): what's wrong, on the start screen with its two choices.
    private(set) var startupStuck: String?
    func setStartupStuck(_ why: String?) {
        guard why != startupStuck else { return }
        startupStuck = why
        Diagnostics.note("Margin's window \(id): the start screen \(why == nil ? "no longer held up" : "held up: what's wrong said, Try again and Continue without Safari")")
        push(pageStateJSON)
    }
    // Margin's start (HostedSession `startup`): its loader says "Getting you started…", not "Opening …" (the page's words).
    private var starting: Bool { pageState == .loading && loaderLabel == HostedSession.startupLabel }

    // The hosted window's bounds read from the window server (kept: a layout report, a pointer move never reads them).
    private func readHosted() {
        hostedFrame = hosted.flatMap { hostedBounds($0) }
    }

    // The hole: where the hosted window shows through, only while the page is `shown`: its bounds inside the page area
    // (a window-mode app's window is smaller than it; one kept at a frame it had before the page area moved isn't the
    // page area's either). There, the window's own background is clear and the ground view fills everything else in
    // the theme's frame colour (around a smaller window, in a gap, under the loader; the window's own colour when the
    // page says none); the corners rounded where the hole's meet the page card's. Nowhere else, and in no other state, is anything of this
    // window see-through. The pointer's slot and the catch fill follow it.
    private func updateHole() {
        let content = contentFrame
        var next: CGRect?
        if pageState == .shown, let page = window.pageRect {
            // (Between two windows in a switch, the grace running: the hole as it was. The new one is under it already.)
            let bounds = hosted != nil ? (followingPage ? page : hostedFrame ?? page) : graceTimer != nil ? hole : nil
            if let r = bounds?.intersection(page), !r.isNull, r.width >= 1, r.height >= 1 { next = r }
        }
        let said = (0..<4).map { i in i < (layout?.fills.count ?? 0) ? PageFill.color(layout?.fills[i] ?? "") : nil }
        pageGround = hosting ? PageFill.common(said.compactMap { $0 }) : nil
        let fill = pageGround ?? .windowBackgroundColor
        if let next, let page = window.pageRect {
            // (A corner of the hole is the page card's where the two meet: rounded as the theme rounds it.)
            let corners = [CGPoint(x: page.minX, y: page.minY), CGPoint(x: page.maxX, y: page.minY), CGPoint(x: page.maxX, y: page.maxY), CGPoint(x: page.minX, y: page.maxY)]
            let mine = [CGPoint(x: next.minX, y: next.minY), CGPoint(x: next.maxX, y: next.minY), CGPoint(x: next.maxX, y: next.maxY), CGPoint(x: next.minX, y: next.maxY)]
            let radii = (0..<4).map { i -> CGFloat in
                guard abs(corners[i].x - mine[i].x) <= 2, abs(corners[i].y - mine[i].y) <= 2, let layout, i < layout.radii.count else { return 0 }
                return CGFloat(layout.radii[i])
            }
            // (The ground drawn with its hole before the window's own background goes: no frame of it see-through elsewhere.)
            ground.show(color: fill, hole: next.offsetBy(dx: -content.minX, dy: -content.minY), radii: radii)
            if panel.backgroundColor != .clear { panel.backgroundColor = .clear }
        } else {
            if panel.backgroundColor != fill { panel.backgroundColor = fill }
            ground.clear()
        }
        hole = next
        // The pointer's slot: the hole, less what the theme draws over it that takes the pointer (`hits`: the palette, a
        // menu, a notice) and the page card's rounded corners (kept: a pointer move only compares against it).
        slot = nil
        if let next, let layout {
            var s = PassThrough.slot(in: content, layout: layout, hits: hits, captureAll: captureAll)
            if !HostLayout.near(next, s.rect, within: 2) { s.radius = 0 }
            s.rect = s.rect.intersection(next)
            if !s.rect.isNull, !s.rect.isEmpty { slot = s }
        }
        catcher.region = CatchRegion.of(frame: content, slot: slot)
    }

    // Where the hosted window goes while hosting: the page area from its own layout, measured in full screen at its
    // size (the theme's frame around it), and the display's full-screen area its own Space lays it out in. Nil until then.
    // The area is this window's own frame: a full-screen window, laid out exactly where the hosted window's own Space
    // lays out its full-screen window (seen 2026-11-15: the display's frame less its top safe-area inset said 0,32
    // 1512×950, both windows were at 0,33 1512×949, so the hosted window landed a point below the page area).
    // `display`: the screen's whole frame (a hosted window's tile in Margin's Space is laid out in it). Nil also while
    // this window isn't its screen's width: a tile added to or taken out of its Space lays it out as a split's half for a
    // moment (under the freeze; the engine sets its rect back at once), never a page area to place anything at.
    var hostedPlacement: HostPlacement? {
        guard hosting, isFullScreen, let layout, layout.mode == "fullscreen", hostDisplay != nil, !narrowed,
              let page = MarginWindowGeometry.pageRect(layout: layout, content: contentFrame) else { return nil }
        let display = window.screen.map { ScreenGeometry.appKitRect($0.frame) } ?? .zero
        return HostPlacement(page: page, area: contentFrame, display: display)
    }
    // In full screen and narrower than its screen (laid out as a split's half by a tile change in its Space).
    private var narrowed: Bool {
        guard isFullScreen, let screen = window.screen else { return false }
        return contentFrame.width < screen.frame.width - 2
    }

    // The page area as its page draws it now, not hosting (its launcher's layout), in full screen at its size: where a
    // browser's window made ready out of sight is placed (hosting's rect too while the sidebar is docked). Nil until measured.
    var idlePlacement: HostPlacement? {
        guard isFullScreen, let layout, layout.mode == "fullscreen", MarginWindowGeometry.measuredAt(layout, contentFrame.size),
              let page = MarginWindowGeometry.pageRect(layout: layout, content: contentFrame) else { return nil }
        return HostPlacement(page: page, area: contentFrame)
    }

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

    func pointerMoved(_ at: CGPoint, buttonsDown: Bool = PointerWatch.buttonsDown) {
        guard window.isVisible || options.harness else { return }
        let content = contentFrame
        let local = CGPoint(x: at.x - content.minX, y: at.y - content.minY)
        // (Windowed, the window's buttons are the base's, under the panel where the theme draws its window controls.)
        let overButtons = !isFullScreen && controls?.contains(local) == true
        setIgnoring(buttonsDown ? ignoring : overButtons || PassThrough.pageGets(at, slot))
        if content.contains(at) {
            pointerInside = true
            let now = Diagnostics.now()
            guard pointerWant.wants(local, in: content.size), now - lastPointerPush >= options.pointerEvery else { return }
            lastPointerPush = now
            push(#"{"type":"pointer","x":\#(Double(local.x)),"y":\#(Double(local.y))}"#)
        } else if pointerInside {
            pointerInside = false
            push(#"{"type":"pointerLeft","x":\#(Double(local.x)),"y":\#(Double(local.y))}"#)
        }
    }

    // A press on the page area (the hosted window's, through the hole) or outside: a field of Margin's lets go, the
    // palette goes. A press in the page area around a smaller hosted window (window mode; on it, the app has it already)
    // gives that app the keyboard. Only while this window is on screen in the current Space (the monitor hears every
    // app's presses).
    func pressed(_ at: CGPoint) {
        if hosted != nil, pageState == .shown, !pageWantsKeyboard, options.harness || (window.isVisible && window.isOnActiveSpace), let page = window.pageRect, page.contains(at) {
            owner?.onPagePress?(self, at)
        }
        // (Kept in front by its order: a press on the hosted window raised it over this one; above it again, once the
        // window server has done that.)
        if mechanism == .order, hosted != nil { DispatchQueue.main.async { [weak self] in self?.keepFront() } }
        guard pageWantsKeyboard, !contentFrame.contains(at) || PassThrough.pageGets(at, slot) else { return }
        push(#"{"type":"pressOutside"}"#)
    }

    func setIgnoring(_ on: Bool) {
        ignoring = on
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

    // A press in Margin's UI ended (the panel's): looked at `pressSettle` later, once the page has had the chance to say
    // a field took the focus. Not if a field of Margin's has or wants the keys, or Margin is the front app (its keys
    // are its own then). A hosted app shown: the keys back to it (a press in a non-activating panel moves the keyboard
    // to Margin without making it the front app: a key after a click in the sidebar went to Margin, check10 k1,
    // 2026-11-17, and 2026-11-08 before). Nothing hosted, nothing opening (its launcher): Margin is made the front app,
    // as a press in its own window always made it (there's no app whose look it could take away).
    static let pressSettle: TimeInterval = 0.08
    func pressEnded() {
        guard !options.harness else { return afterPress() } // (a test's clock: at once)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pressSettle) { [weak self] in self?.afterPress() }
    }

    func afterPress() {
        guard !isClosed, !pageWantsKeyboard, !appActive() else { return }
        if hosted != nil, pageState == .shown { return keysBack("a press in Margin's UI ended") }
        if !hosting, loadingLabel == nil, showingLabel == nil, pageState == .empty { activate("a press in its launcher, nothing hosted") }
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
            if stageHidden {
                stageHidden = false
                setAlpha(1)
            }
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
        if options.harness {
            fullScreenAsks += 1
            if options.harnessEnters?() ?? true { fullScreenChanged(true) }
            return true
        }
        if let stage { return openStage(stage) }
        fullScreenAsks += 1
        setButtonsHidden(false) // (hidden while it was in a stage)
        window.toggleFullScreen(nil)
        return true
    }

    // Whether macOS would take the toggle now: Margin the active app, its window on screen in the current Space. (Opened
    // while another app's full-screen Space is current, the window is on a Desktop macOS hasn't switched to yet: asked
    // then, it's refused, `windowDidFailToEnterFullScreen`.) A test's window: its stage-to-be's answer. With a stage
    // (the helper's window goes full screen, not this one): the window only needs to be ordered in.
    var canAskFullScreen: Bool {
        if options.harness { return options.harnessReady?() ?? true }
        if stage != nil { return window.isVisible && !stageOpening }
        return NSApp.isActive && window.isVisible && window.isOnActiveSpace
    }

    // ---- its stage (MarginStage.swift; DECISIONS.md "Margin's Space owned by a helper with no Dock icon") ----

    // The helper's stages, while they're usable and this window hasn't fallen back (never a test's window).
    var stage: MarginStage? {
        guard !options.harness, !stageFell, let s = owner?.stage, s.usable else { return nil }
        return s
    }

    // The window that owns this window's Space: its stage's (the helper's), else this window (AppKit's full screen).
    var spaceOwnerNumber: Int { stageSpace != nil ? (owner?.stage?.stageWindow(for: id) ?? number) : number }

    // Its stage asked for (once at a time): the helper's window for it into full screen on this window's display; this
    // window joins that Space when it's there (`joinStage`). Not asked: AppKit's full screen instead.
    private func openStage(_ stage: MarginStage) -> Bool {
        guard !stageOpening else { return false }
        let display = (window.screen ?? NSScreen.main).flatMap { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value } ?? CGMainDisplayID()
        stageOpening = true
        fullScreenAsks += 1
        let asked = stage.open(id: id, display: display) { [weak self] event in self?.stageEvent(event) }
        guard asked else {
            stageOpening = false
            return fallBack("its stage couldn't be asked for")
        }
        Diagnostics.note("Margin's window \(id): its stage asked for (Margin Space.app's window into full screen)")
        return true
    }

    private func stageEvent(_ event: MarginStage.Event) {
        guard !isClosed else { return }
        switch event {
        case .window:
            break
        case .full:
            guard stageOpening, let stage = owner?.stage, let n = stage.stageWindow(for: id) else { return }
            // (Its Space can take a moment to read after the window says it's in.)
            var tries = 0
            func look() {
                guard !self.isClosed, self.stageOpening else { return }
                // (Its Space read, and the one showing: macOS switches to a new full-screen Space as it's made.)
                if let space = stage.fullScreenSpace(of: n), stage.calls.activeSpace() == space { return self.joinStage(space) }
                tries += 1
                guard tries < 20 else { stageOpening = false; _ = fallBack("its stage's Space didn't read"); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { look() }
            }
            look()
        case .left:
            lostStage("macOS took its stage out of full screen")
        case .gone:
            stageOpening = false
            lostStage("Margin Space.app ended")
        case .failed(let why):
            stageOpening = false
            owner?.stage?.giveUp(why)
            _ = fallBack(why)
        case .resized(let size):
            // (Its stage laid out as a split's part by a tile change Margin didn't make: as the window's own resize was.)
            if hosting, stageSpace != nil, let d = hostDisplay, size.width < d.width - 1 { owner?.onNarrowed?(self) }
        }
    }

    // In its stage's Space: this window at the display's full-screen area (what AppKit gives a full-screen window: below
    // a notch), its buttons hidden (no title bar: the menu bar's strip is MarginMenuBar's), it and its panel members of
    // that Space (its backdrop too, once made), then in full screen as far as everything else is concerned.
    private func joinStage(_ space: UInt64) {
        guard let stage = owner?.stage else { return }
        window.refusesToggle = true // (first: its frame isn't constrained from here)
        if let screen = window.screen ?? NSScreen.main {
            let area = ScreenGeometry.appKitRect(MarginWindowGeometry.fullScreenArea(screen))
            if window.frame != area { window.setFrame(area, display: false) }
        }
        setButtonsHidden(true)
        // (Placed only while its stage is the Space showing: "move to the active Space" puts the panel in the Space showing.)
        guard stage.calls.activeSpace() == space else {
            stageOpening = false
            stage.close(id: id)
            stage.giveUp("its stage's Space wasn't the one showing when it was ready")
            window.refusesToggle = false
            setButtonsHidden(false)
            _ = fallBack("its stage's Space wasn't showing")
            return
        }
        guard placeGroup(space, stage: stage) else {
            stageOpening = false
            restoreGroup()
            stage.close(id: id)
            stage.giveUp("Margin's windows didn't join its stage's Space")
            window.refusesToggle = false
            setButtonsHidden(false)
            _ = fallBack("its windows didn't join its stage's Space")
            return
        }
        stageOpening = false
        stageSpace = space
        Diagnostics.note("Margin's window \(id): in its stage's Space \(space) (owned by Margin Space.app: nobody makes Margin active there)")
        fullScreenChanged(true)
        startMenuBar()
    }

    // Margin's windows into its stage's Space by macOS's own rules only (DECISIONS.md "The window server's crash and the
    // official placement", 2026-11-19: a direct Space call left macOS's count of a window's current Spaces wrong, and a
    // later Space switch stopped the window server). The panel, an NSPanel, shown with "move to the active Space" while
    // the stage is the Space showing: macOS puts it there. This window and the backdrop then the panel's children: a child
    // joins its parent's Space, macOS moves them itself. The panel's behaviour then back to joining full-screen Spaces,
    // so no later order moves the group. Each window's Spaces read back: true, all three in the stage.
    private func placeGroup(_ space: UInt64, stage: MarginStage) -> Bool {
        panel.parent?.removeChildWindow(panel)
        let b = backdrop ?? MarginBackdrop(frame: MarginBackdrop.frame(window: window.frame, screen: window.screen?.frame))
        backdrop = b
        b.parent?.removeChildWindow(b)
        b.setFrame(MarginBackdrop.frame(window: window.frame, screen: window.screen?.frame), display: false)
        b.collectionBehavior = MarginBackdrop.stageBehavior
        window.collectionBehavior = MarginWindow.stageBehavior
        panel.setFrame(window.frame, display: false)
        panel.level = window.level
        panel.alphaValue = window.alphaValue
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        panel.orderFrontRegardless()
        panel.addChildWindow(window, ordered: .below)
        panel.addChildWindow(b, ordered: .below)
        b.level = MarginBackdrop.level
        panel.collectionBehavior = MarginPanel.stageBehavior
        let read = [panel, window, b].map { stage.calls.spaces(of: $0.windowNumber) }
        let joined = read.allSatisfy { $0 == [space] }
        Diagnostics.note("Margin's window \(id): its panel, window and backdrop \(joined ? "in" : "NOT in") its stage's Space by macOS's own placement (\(read.map { $0.map { "\($0)" } ?? "unread" }.joined(separator: ", ")))")
        return joined
    }

    // Margin's order of things again (out of a stage): this window the parent, the panel above it, the backdrop below,
    // their usual behaviours.
    private func restoreGroup() {
        window.parent?.removeChildWindow(window)
        panel.collectionBehavior = MarginPanel.behavior
        window.collectionBehavior = MarginWindow.behavior
        if let b = backdrop { b.parent?.removeChildWindow(b); b.collectionBehavior = MarginBackdrop.behavior }
        if panel.parent !== window { window.addChildWindow(panel, ordered: .above) }
    }

    // Its stage's Space left or gone (macOS took the helper's window out of full screen, Mission Control closed it, the
    // helper ended): out of full screen as far as everything is concerned (the session parks what it showed), out of
    // sight, and into a stage again by the always-full-screen ask (`fullScreenChanged`).
    private func lostStage(_ why: String) {
        guard stageSpace != nil else { return }
        Diagnostics.warn("Margin's window \(id): its stage's Space is gone (\(why)): into a stage again")
        if hosting { owner?.onLeavingFullScreen?(self) }
        stopMenuBar()
        stageSpace = nil
        window.refusesToggle = false
        stageHidden = true
        setAlpha(0)
        restoreGroup()
        fullScreenChanged(false)
        // (Never left unseen: shown as it is if no stage comes back.)
        DispatchQueue.main.asyncAfter(deadline: .now() + options.fullScreenWithin) { [weak self] in
            guard let self, !self.isClosed, self.stageHidden else { return }
            self.stageHidden = false
            self.setButtonsHidden(false)
            self.setAlpha(1)
        }
    }

    // No stage for this window from now: AppKit's full screen, Margin owning its Space (as before the stage).
    private func fallBack(_ why: String) -> Bool {
        guard !stageFell else { return false }
        stageFell = true
        owner?.stage?.close(id: id)
        restoreGroup()
        setButtonsHidden(false)
        Diagnostics.warn("Margin's window \(id): no stage (\(why)): AppKit's full screen, Margin owns its Space")
        DispatchQueue.main.async { [weak self] in self?.tryFullScreen("its stage didn't come") }
        return true
    }

    private func setButtonsHidden(_ hidden: Bool) {
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(kind)?.isHidden = hidden }
    }

    private func startMenuBar() {
        guard menuBar == nil, let stage = owner?.stage, let space = stageSpace, let screen = window.screen ?? NSScreen.main else { return }
        menuBar = MarginMenuBar(calls: stage.calls, screen: screen, space: space, pageArea: { [weak self] in self?.window.pageRect },
                                closeTab: { [weak self] in self?.owner?.perform(.closeTab) })
    }

    private func stopMenuBar() {
        menuBar?.stop()
        menuBar = nil
    }

    // Always full screen and not in: asked now if macOS would take it, at every event that can make it so and at a look
    // of its own (`lookAgain`), until it's in. Not yet takeable: Margin and its window brought forward (`bringForward`:
    // macOS then shows the Space the window is on; 0.8 s apart, three times at most, each said: after that it only
    // waits, never taking the keys again and again from the app the person went on in), nothing asked. Never before
    // its first ask, nor while it's on its way in.
    func tryFullScreen(_ why: String) {
        guard options.alwaysFullScreen, firstAsked, !isFullScreen, !isClosed else { return }
        if stageOpening { return } // (its stage on its way: it says when it's there or fails)
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
        spaceChangedAt = now()
        if let space = stageSpace, let stage = owner?.stage, stage.calls.spaces(of: window.windowNumber).map({ !$0.contains(space) }) == true {
            lostStage("it's no longer in its stage's Space")
        }
        tryFullScreen("the Space changed")
        if isFullScreen, !options.harness, window.isOnActiveSpace { attachPanel("the Space changed") }
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

    // The source's state changed: drawn again; its theme too, if that changed.
    func stateChanged() {
        guard asked, let owner else { return }
        let state = jsonString(owner.source.snapshot()) ?? "null"
        push(#"{"type":"state","state":"# + state + #","windows":"# + windowsJSON + "}")
        if let theme = owner.theme(), theme != themeSent {
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
        let head: JSONObject = [
            "windowId": id, "profile": "", "browser": owner.browser, "mode": mode, "host": "app-window",
            "platform": ["browser": owner.browser, "os": "mac", "app": true],
            "state": owner.source.snapshot(),
        ]
        var json = String((jsonString(head) ?? "{}").dropLast())
        json += #","windows":"# + windowsJSON
        json += #","themes":"# + owner.themes()
        json += #","apps":"# + owner.apps()
        json += #","pageHosted":"# + (hosting ? "true" : "false")
        json += #","pageMinWidth":"# + (pageMinimum.map { String(Int($0)) } ?? "null")
        json += #","pageState":""# + pageState.rawValue + #"","pageOpening":"# + (loaderLabel.flatMap { jsonString($0) } ?? "null")
        json += #","pageOpeningBundleId":"# + (loaderApp.flatMap { jsonString($0) } ?? "null")
        if starting { json += #","pageStarting":true"# }
        if starting, let why = startupStuck.flatMap({ jsonString($0) }) { json += #","pageStuck":"# + why }
        if pageState == .elsewhere, let picture = elsewherePicture, let data = jsonString(picture) { json += #","pagePicture":"# + data }
        let theme = owner.theme()
        themeSent = theme
        json += #","theme":"# + (theme ?? "null") + "}"
        return json
    }

    func pageSend(type: String, payload: JSONObject) async throws -> JSONObject {
        // The window's own full screen (ui/actions.ts window.fullscreen's request), not the source's.
        if type == "toggleFullscreen" {
            toggleFullScreen()
            return ["ok": true, "result": true]
        }
        // A note's Allow (shared/notices.ts `safari-profile`): Safari's folder picked once, its profiles' names read.
        if type == "allowSafariProfiles" {
            SafariFolderGrant.ask(over: nil)
            return ["ok": true, "result": true]
        }
        return ask(type, payload) ?? ["ok": true, "result": true]
    }

    func pageSaid(_ op: String, _ body: JSONObject) {
        switch op {
        case "ready":
            guard !isReady else { return }
            isReady = true
            Diagnostics.note("Margin's window \(id): its page drawn")
            show()
            owner?.onReady?(self)
        case "layout":
            guard let geometry = body["geometry"] as? JSONObject, let layout = PageLayout(geometry: geometry) else { return }
            if hosting {
                let said = "\(layout.mode) \(Int(layout.left))/\(Int(layout.top))/\(Int(layout.right))/\(Int(layout.bottom)) in \(Int(layout.width))×\(Int(layout.height))"
                // (Not each frame of a drag of the sidebar's edge: its last layout, once it's let go.)
                if said != hostingLayoutSaid, !pageResizing {
                    hostingLayoutSaid = said
                    Diagnostics.note("Margin's window \(id): hosting, its page measured \(said) (window \(Int(window.frame.width))×\(Int(window.frame.height)), full screen \(window.styleMask.contains(.fullScreen)))")
                }
            }
            self.layout = layout
            updatePage()
        case "hits":
            let rects = (body["rects"] as? [[Any]] ?? []).compactMap { Self.rect($0) }
            hits = Array(rects.prefix(64))
            captureAll = body["all"] as? Bool == true || rects.count > 64
            updatePage()
        case "chrome":
            controls = (body["controls"] as? [Any]).flatMap { Self.rect($0) }
            panel.dragRegions = (body["drags"] as? [[Any]] ?? []).compactMap { Self.rect($0) }
            placeButtons()
        case "focus":
            let had = pageWantsKeyboard
            pageWantsKeyboard = body["on"] as? Bool == true
            // A field of Margin's wants the keys (the palette, ⌘T or the menu's New Tab; a rename, an editor): the panel
            // takes them, Margin isn't made active (before 2026-11-17 it was, and the hosted app went to its inactive
            // look; the Accessibility frontmost of 1d728d4a is now only a said last resort, `takeKeys`).
            if pageWantsKeyboard { return takeKeys() }
            guard had else { return }
            // It let go (the palette closed, Escape): the panel lets go of them, the keys back to the hosted app shown.
            letGoKeys()
            keysBack("a field of Margin's let go")
        case "pointerWant":
            pointerWant = PointerWant(body)
        case "perform":
            let name = body["name"] as? String ?? ""
            if name == "window.fullscreen" { return toggleFullScreen() }
            // The sidebar's width being dragged, or let go (ui/behaviors/resize.ts): the session's (it holds the hosted
            // window's placing until it's over).
            if name == "sidebar.resizing" { return sidebarResizing((body["arg"] as? JSONObject)?["on"] as? Bool == true) }
            guard !name.isEmpty else { return }
            ask(name, body["arg"] as? JSONObject ?? [:])
        case "log":
            let text = "Margin's window \(id): \(body["text"] as? String ?? "")"
            if ["error", "warn"].contains(body["level"] as? String ?? "") { Diagnostics.warn(text) } else { Diagnostics.note(text) }
        default:
            break
        }
    }

    // Its page's word that a change of the sidebar's width began or is over, passed on once each way. A page that
    // goes (closed, its process ended, loaded again) mid-drag: over.
    private func sidebarResizing(_ on: Bool) {
        guard on != pageResizing else { return }
        pageResizing = on
        owner?.onSidebarResizing?(self, on)
    }

    static func rect(_ r: [Any]) -> CGRect? {
        let n = r.compactMap(num)
        return n.count == 4 && n.allSatisfy(\.isFinite) && n[2] >= 0 && n[3] >= 0 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
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
    // The theme package the windows draw (JSON), nil for Arcadia; the imported themes' index (JSON).
    var theme: () -> String? = { nil }
    var themes: () -> String = { "[]" }
    var apps: () -> String = { "null" } // the installed apps (ShellApps.swift), null with none read
    // A window's page area changed (MarginWindow.pageRect: hosting's own, or the hole's); its page drawn.
    var onPageRect: ((MarginWindowController, CGRect?) -> Void)?
    var onReady: ((MarginWindowController) -> Void)?
    var onLeavingFullScreen: ((MarginWindowController) -> Void)? // about to leave full screen while hosting
    var onLeftFullScreen: ((MarginWindowController) -> Void)? // left full screen while hosting
    var onEnteredFullScreen: ((MarginWindowController) -> Void)? // in full screen (again)
    var onPagePress: ((MarginWindowController, CGPoint) -> Void)? // a press in its page area around a window-mode host's window
    // The keys back to the hosted app shown (a field of Margin's let go of them, a press in Margin's UI ended, a menu
    // item of Margin's ran): that app activated again, which it already is (it never stopped being the active app).
    var onFieldClosed: ((MarginWindowController) -> Void)?
    var onOpen: ((MarginWindowController) -> Void)? // a window made, before its page loads (the session: the item it showed last)
    var onSidebarResizing: ((MarginWindowController, Bool) -> Void)? // a change of its sidebar's width began (a drag), or is over
    var onNarrowed: ((MarginWindowController) -> Void)? // in full screen while hosting and narrower than its screen (a tile change in its Space)
    var browser = "safari" // the engine hosted pages are in (Settings offers its features)
    // The owner of the windows' full-screen Spaces (MarginStage.swift); nil, or not usable: each window owns its own
    // (AppKit's full screen). Set by the shell before the first window opens.
    var stage: MarginStage? {
        didSet {
            stage?.currentSpace = { [weak self] in self?.controllers.first { $0.stageSpace != nil && $0.window.isOnActiveSpace }?.stageSpace }
            stage?.watchOwnWindows()
        }
    }
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
        if !options.harness { startKeyRelay() }
        pointer.onPress = { [weak self] at in for c in self?.controllers ?? [] { c.pressed(at) } }
        // Margin activated (its Dock icon, ⌘-Tab): each window in front of what it hosts (the `order` mechanism orders
        // it there again), and one still not in full screen, its toggle ignored while Margin wasn't active, asked again.
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { for c in self?.controllers ?? [] { c.keepFront(); c.appBecameActive() } }
        }
        // Another Space current, or another app in front (a hosted app activated: its window may have come over
        // Margin's at the same level): in front of it again (a window not on the current Space: nothing, `keepFront`).
        let workspace = NSWorkspace.shared.notificationCenter
        frontObservers = [
            workspace.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { for c in self?.controllers ?? [] { c.spaceChanged(); c.keepFront() } }
            },
            workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { for c in self?.controllers ?? [] { c.keepFront(); c.tryFullScreen("an app activated") } }
            },
        ]
    }

    private var activeObserver: NSObjectProtocol?
    private var frontObservers: [NSObjectProtocol] = []
    deinit {
        if let keyRelay { NSEvent.removeMonitor(keyRelay) }
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
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

    func closed(_ controller: MarginWindowController) {
        controllers.removeAll { $0 === controller }
        if lastKey === controller { lastKey = nil }
        controller.teardown() // (closing already)
        if controllers.isEmpty { pointer.stop() }
        Diagnostics.note("Margin's window \(controller.id) closed (\(controllers.count) open)")
    }

    func closeAll() {
        for c in controllers { c.close() }
        controllers = []
        lastKey = nil
        pointer.stop()
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
