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
//   nothing there, the window's background is clear and its ground is drawn around the hosted window's bounds
//   (`ground`), and the pointer goes through to the app (`slot`, PassThrough.swift: decided on pointer moves only),
//   but for what the theme draws over the page area (`hits`). While an item is opened, made ready or placed again
//   (`loading`) the page card is opaque, with the theme's loader, and the pointer is Margin's: whatever the engine
//   does meanwhile is behind it. Nothing shown (`empty`): the launcher. A field of Margin's that has the keys (the
//   palette) makes Margin active; when it lets go, the hosted app gets the keys back (`onFieldClosed`). A normal window
//   another app opens in this window's Space (a hosted app's Settings) is let in front until it's gone (`yield`).
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
    weak var owner: MarginWindows?
    private let pages: OverlayPages
    private let options: Options
    private let catcher = CatchView(frame: .zero)

    private(set) var isReady = false
    private(set) var isShown = false
    private var asked = false // its page asked for its hello: pushes reach it
    private(set) var isFullScreen = false
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
    enum PageState: String { case empty, loading, shown }
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
        super.init()
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
        window.contentView = content
        window.locksFullScreen = options.alwaysFullScreen
        window.delegate = self
        // Said, not left to the default (which passes the pointer through fully transparent pixels).
        window.ignoresMouseEvents = false
        window.acceptsMouseMovedEvents = true
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
        if options.harness { window.orderBack(nil) }
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
            window.alphaValue = 0
            window.makeKeyAndOrderFront(nil)
            NSApp.activate()
            // (Its first ask; its key and first-on-screen moments here come before it.)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                guard let self else { return }
                self.firstAsked = true
                self.tryFullScreen("its first ask")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + options.fullScreenWithin) { [weak self] in
                guard let self, !self.isClosed, !self.isFullScreen, self.window.alphaValue == 0 else { return }
                Diagnostics.warn("Margin's window \(self.id): not in full screen within \(Int(self.options.fullScreenWithin)) s (\(self.fullScreenState)): shown as it is, and asked until it's in")
                self.window.alphaValue = 1
                self.isShown = true
            }
            return
        }
        if !isShown { Diagnostics.note("Margin's window \(id) shown\(isReady ? "" : " (its page not drawn yet)")") }
        isShown = true
        if window.alphaValue < 1 { window.alphaValue = 1 }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        keepFront()
        placeButtons()
    }

    private(set) var isClosed = false
    // Its page let go of (the window closing, or closed by close()).
    func teardown() {
        guard !isClosed else { return }
        sidebarResizing(false)
        graceTimer?.invalidate()
        retryTimer?.invalidate()
        isClosed = true
        pages.bridge.unregister(webView)
        webView.navigationDelegate = nil
        webView.stopLoading()
        window.delegate = nil
    }

    func close() {
        teardown()
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
            window.level = level
            levelSets += 1
            changedAt = now()
        }
        if up, mechanism == .order || reorder, let target = hosted ?? covering {
            window.order(.above, relativeTo: target)
            frontOrders += 1
            changedAt = now()
        }
        if up { reorder = false }
        if let other = yieldingTo {
            window.order(.below, relativeTo: other)
            yieldOrders += 1
            changedAt = now()
        }
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
            if window.level == FrontMechanism.raised { window.level = .normal; window.level = FrontMechanism.raised; levelSets += 1 }
            window.order(.above, relativeTo: read.hosted)
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
                window.level = .normal
                levelSets += 1
                window.order(.above, relativeTo: read.hosted)
                frontOrders += 1
                changedAt = t
                probedAt = t
                Diagnostics.warn("Margin's window \(id): its raised level isn't held by the window server (it says \(read.marginLayer) at reads \(Int((t - first) * 1000)) ms apart, at rest): kept in front by its order instead, the level tried again every \(Int(Self.probeEvery)) s")
            } else {
                if missAt == nil { missAt = t }
                // (Set again, as it may have been lost: the next read at rest says.)
                window.level = .normal
                window.level = FrontMechanism.raised
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
                    window.level = .normal
                    levelSets += 1
                    window.order(.above, relativeTo: read.hosted)
                    frontOrders += 1
                    changedAt = t
                }
            } else if t - probedAt >= Self.probeEvery - 1e-9 {
                probing = true
                levelProbes += 1
                window.level = FrontMechanism.raised
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
        let target: PageState = !hosting ? .empty : ready ? .shown : .loading
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
        applyPage(!hosting ? .empty : ready ? .shown : .loading)
    }

    private func applyPage(_ state: PageState) {
        let label = state == .loading ? loadingLabel ?? showingLabel : nil
        let app = state == .loading ? loadingLabel != nil ? loadingApp : showingApp : nil
        let changed = state != pageState || label != loaderLabel || app != loaderApp
        pageState = state
        loaderLabel = label
        loaderApp = app
        // (The hole closed, or opened, before the page hears: leaving `shown`, the ground covers the page area at once;
        // into it, the theme's loader is still drawn over the hole until the page fades it.)
        updateHole()
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
            + (loaderApp.flatMap { jsonString($0) }.map { #","bundleId":"# + $0 } ?? "") + "}"
    }

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
            let bounds = hosted != nil ? hostedFrame ?? page : graceTimer != nil ? hole : nil
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
            if window.backgroundColor != .clear { window.backgroundColor = .clear }
        } else {
            if window.backgroundColor != fill { window.backgroundColor = fill }
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
    var hostedPlacement: HostPlacement? {
        guard hosting, isFullScreen, let layout, layout.mode == "fullscreen", hostDisplay != nil,
              let page = MarginWindowGeometry.pageRect(layout: layout, content: contentFrame) else { return nil }
        return HostPlacement(page: page, area: contentFrame)
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
        setIgnoring(PassThrough.decide(at, slot, buttonsDown: buttonsDown, ignoring: ignoring))
        let content = contentFrame
        let local = CGPoint(x: at.x - content.minX, y: at.y - content.minY)
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
        if window.ignoresMouseEvents != on { window.ignoresMouseEvents = on }
    }

    // ---- the window ----

    var mode: String { isFullScreen ? "fullscreen" : "windowed" }
    var windowsJSON: String {
        jsonString([["windowId": id, "id": id, "state": isFullScreen ? "fullscreen" : "normal", "focused": window.isKeyWindow]]) ?? "[]"
    }

    func fullScreenChanged(_ on: Bool) {
        guard on != isFullScreen else { return }
        isFullScreen = on
        Diagnostics.note("Margin's window \(id): \(on ? "in full screen (its own Space)" : "windowed")")
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
            if enteringFirst {
                enteringFirst = false
                window.alphaValue = 1
                Diagnostics.note("Margin's window \(id) shown, in full screen")
                isShown = true
            }
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
            NSApp.activate()
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
        tryFullScreen("the Space changed")
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
            NSApp.activate()
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

    func windowDidResize(_ notification: Notification) { updatePage(); placeButtons() }
    func windowDidChangeOcclusionState(_ notification: Notification) {
        if window.occlusionState.contains(.visible) { tryFullScreen("its window on screen") }
    }
    func windowDidMove(_ notification: Notification) { updatePage() }
    func windowWillEnterFullScreen(_ notification: Notification) { willEnterAt = Date() }
    func windowDidEnterFullScreen(_ notification: Notification) { willEnterAt = nil; fullScreenChanged(true) }
    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        willEnterAt = nil
        Diagnostics.warn("Margin's window \(id): macOS didn't take it to full screen (\(fullScreenState)): asked again")
        lookAgain()
    }
    // About to leave full screen while hosting: the one shown parked first, while it's still in this window's Space.
    func windowWillExitFullScreen(_ notification: Notification) { if hosting { owner?.onLeavingFullScreen?(self) } }
    func windowDidExitFullScreen(_ notification: Notification) { willEnterAt = nil; fullScreenChanged(false) }
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

    func push(_ json: String) {
        guard asked else { return } // its hello, when it asks, has this already
        pushes += 1
        pushed.append(json)
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
        json += #","pageState":""# + pageState.rawValue + #"","pageOpening":"# + (loaderLabel.flatMap { jsonString($0) } ?? "null")
        json += #","pageOpeningBundleId":"# + (loaderApp.flatMap { jsonString($0) } ?? "null")
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
                if said != hostingLayoutSaid {
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
            window.dragRegions = (body["drags"] as? [[Any]] ?? []).compactMap { Self.rect($0) }
            placeButtons()
        case "focus":
            let had = pageWantsKeyboard
            pageWantsKeyboard = body["on"] as? Bool == true
            // A field of Margin's let go (the palette closed, Escape): the keys back to the hosted app shown.
            if had, !pageWantsKeyboard, hosted != nil, pageState == .shown { owner?.onFieldClosed?(self) }
            guard pageWantsKeyboard, !options.harness else { return }
            // A field of Margin's wants the keys (the palette, ⌘T or the menu's New Tab): Margin and this window take
            // the keyboard, which the hosted app under it may have had (seen 2026-11-15: the palette opened while the
            // hosted app kept the keys). It's drawn over the page area as it is: this window is in front.
            if !NSApp.isActive || !window.isKeyWindow {
                NSApp.activate()
                window.makeKey()
            }
            if window.firstResponder !== webView { window.makeFirstResponder(webView) }
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
    var onFieldClosed: ((MarginWindowController) -> Void)? // a field of Margin's let go of the keys with a hosted window shown
    var onOpen: ((MarginWindowController) -> Void)? // a window made, before its page loads (the session: the item it showed last)
    var onSidebarResizing: ((MarginWindowController, Bool) -> Void)? // a change of its sidebar's width began (a drag), or is over
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
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        for o in frontObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
    }

    var anyVisible: Bool { controllers.contains { $0.window.isVisible } }

    // The key one, else the one key last, else the newest.
    var front: MarginWindowController? {
        controllers.first { $0.window.isKeyWindow } ?? lastKey.flatMap { k in controllers.first { $0 === k } } ?? controllers.last
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

    func perform(_ action: MarginMenuAction) {
        if action == .newWindow { open(); return }
        front?.run(action)
    }

    func becameKey(_ controller: MarginWindowController) { lastKey = controller }

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
    // How Margin is brought forward, in turn: its own activation, a reopen asked of LaunchServices, both.
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
        return forwards == 1 ? .activation : forwards == 2 ? .launchServices : .both
    }

    // macOS would take it now, after a wait: the looks from the shortest delay again.
    mutating func takeable() { looks = 0 }

    mutating func entered() { looks = 0; forwards = 0 }
}
