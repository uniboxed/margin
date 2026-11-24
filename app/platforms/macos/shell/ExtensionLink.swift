// Margin.app's lines to Margin's extension copies (docs/PROTOCOL.md has the whole exchange; the extension's end is
// step 3's). The rules are margin-core's (app/shared/core/src/link_hub.rs over socket.rs, link.rs, websocket.rs and
// relay.rs, through margin-ffi's link object; docs/CORE-REFACTOR.md step 1.5): the upgrade and who may open the
// socket, the frames, welcome and hello, one link per browser profile (a newer one takes over, a copy not in charge is
// closed 1008), the tick every 5 s and 40 s of silence closing a link (1001), the requests ending on evidence only
// (their reply, the link down, cancelled, lost: docs/LINK-RESILIENCE.md; no time of their own), the secrets and their
// change 30 s after the last link goes, `wantLink` answered with `link` (held until there's a port), `appUp` once
// Safari has run 2 s, the link note's contents, Chrome's and Edge's relays' words, each link's theme put together.
// This file is the Mac's transport only, as app/platforms/windows/src/tcp.rs and pipe.rs are Windows':
//  - the listener (NWListener, 127.0.0.1 only, no Nagle; made again 1 s after it fails, and on a new port when it's
//    been waiting 5 s, as after sleep or wake) and each copy's NWConnection, their bytes passed in, the core's writes
//    sent in order and a connection closed once what was written before has gone;
//  - Safari's way in: the extension handler's distributed notification (`com.unibox.margin.setup`, a JSON
//    `wantLink` with its nonce), SFSafariApplication.dispatchMessage (never while Safari isn't running: it would open
//    Safari) and its refusals (`onDispatchRefused`, BundleWatch), the link note's file (LinkNote);
//  - one timer at the core's next deadline, and stop's short wait for what's written (0.3 s at most).
// The core's clock is the monotonic one (Diagnostics.now(): a sleep never reads as 40 s of silence); the messages'
// `at` the wall clock's.

import AppKit
import MarginCore
import Network
import SafariServices

protocol ExtensionLinkDelegate: AnyObject {
    func linkUp(_ link: LinkConnection)
    // Everything after hello but replies and tocks (a goodbye just before the link goes down).
    func linkReceived(_ link: LinkConnection, _ message: LinkMessage)
    func linkDown(_ link: LinkConnection, _ why: String)
    // Its copy's bytes read and taken by the core (an ack, a tock, a reply among them): told after each read.
    func linkHeard(_ link: LinkConnection)
}

extension ExtensionLinkDelegate {
    func linkHeard(_ link: LinkConnection) {}
}

// Why a request got no answer (the core's, but `cancelled`: this side's own call to `cancel`).
enum LinkError: Error {
    case down
    case lost
    case cancelled
    case notJSON
}

// What the app says into the extension (its copies' native ports). `done`:
// nil once it's delivered, else why not ("Safari isn't running", or the
// error's domain and code, as "SFErrorDomain 1").
protocol ExtensionDispatch {
    func dispatch(_ name: String, _ info: JSONObject, done: @escaping @MainActor (String?) -> Void)
}

let marginExtensionIdentifier = "com.unibox.margin.Extension"
let safariIdentifier = "com.apple.Safari"

// When Safari started, if it's running.
func safariRunningSince() -> Date? {
    NSRunningApplication.runningApplications(withBundleIdentifier: safariIdentifier).filter { !$0.isTerminated }.compactMap(\.launchDate).min()
}

// SFSafariApplication.dispatchMessage, as one JSON string (userInfo.e). Never
// while Safari isn't running: it would open Safari. Refused here, `done` is
// called at once; else once Safari has taken it or refused it.
// SFErrorDomain 1 is SFErrorNoExtensionFound: seen from a Margin.app whose
// bundle was replaced under it (an update, scripts/safari.sh, before it quit
// the running app), and for a few seconds after an install while the system
// adds the extension again (BundleWatch, AppDelegate.swift).
struct SafariDispatch: ExtensionDispatch {
    func dispatch(_ name: String, _ info: JSONObject, done: @escaping @MainActor (String?) -> Void) {
        guard safariRunningSince() != nil else { return done("Safari isn't running") }
        guard let json = jsonString(info) else { return done("not JSON") }
        Task {
            do {
                try await SFSafariApplication.dispatchMessage(withName: name, toExtensionWithIdentifier: marginExtensionIdentifier, userInfo: ["e": json])
                done(nil)
            } catch {
                let error = error as NSError
                done("\(error.domain) \(error.code)")
            }
        }
    }
}

// One copy's link, once it has said hello: what the rest of the app talks to.
final class LinkConnection {
    let hello: LinkMessage.Hello
    var key: String { hello.key }
    var epoch: String { hello.epoch }
    // The core's name for its TCP connection.
    let conn: UInt64
    fileprivate weak var owner: SocketLink?
    fileprivate var waiting: [Int: CheckedContinuation<JSONObject, Error>] = [:]
    private(set) var isUp = true
    // Messages refused for their size, or not JSON (tests read it): the core's count, and those JSONSerialization
    // couldn't write before they got there.
    var refused: Int { refusedByCore + refusedHere }
    fileprivate var refusedByCore = 0
    fileprivate var refusedHere = 0
    // The copy's state, as the core mirrors it (StateMirror.swift): kept up by the link's answers, values read from
    // the core (none once the link is down).
    private(set) lazy var mirror = StateMirror { [weak self] key in
        guard let self else { return nil }
        return self.owner?.stateValue(self.conn, key)
    }

    fileprivate init(hello: LinkMessage.Hello, conn: UInt64, owner: SocketLink) {
        self.hello = hello
        self.conn = conn
        self.owner = owner
    }

    // False if the link is down, or the message couldn't be sent (not JSON, over 1 MB).
    @discardableResult func send(_ message: AppMessage) -> Bool {
        guard isUp, let owner else { return false }
        return owner.send(self, message)
    }

    // Which of its windows Margin draws (Shell.tellDrawn): `hosted` the session's, `windows` the copy's; each change
    // told it (`drawn`), what it was told kept by the core per connection.
    func drawn(hosted: [Int64], windows: [Int64]) {
        guard isUp, let owner else { return }
        owner.drawn(self, hosted: hosted, windows: windows)
    }

    // A request (`req`), answered as a page's is: { ok, result } or { ok: false, error, stale? }. It ends on evidence
    // only (the core's rules): its reply, the link down (`down`), read past twice (`lost`), or `cancel(id)`
    // (`cancelled`); never after a time. `asked`: its id, as it's sent (for `cancel`).
    func request(type: String, payload: JSONObject, windowId: Int?, asked: ((Int) -> Void)? = nil) async throws -> JSONObject {
        guard isUp, let owner else { throw LinkError.down }
        return try await withCheckedThrowingContinuation { continuation in
            switch owner.ask(self, type, payload, windowId) {
            case .success(let id):
                waiting[id] = continuation
                asked?(id)
            case .failure(let error): continuation.resume(throwing: error)
            }
        }
    }

    // Request `id` no longer waited for: the core forgets it and tells the copy (`cancel { id }`); its call ends
    // `cancelled` now, and nothing more comes of it. False: it wasn't waiting.
    @discardableResult func cancel(_ id: Int) -> Bool {
        guard isUp, let owner, waiting[id] != nil else { return false }
        owner.cancel(self, id)
        answered(id, .failure(.cancelled))
        return true
    }

    // How long the oldest request the copy hasn't acked has waited (the core's `slow`): for feedback only. Nil: none.
    var slow: TimeInterval? {
        guard isUp, let owner else { return nil }
        return owner.slow(self)
    }

    func close(_ code: UInt16 = 1000, _ why: String) {
        owner?.close(self, code, why)
    }

    fileprivate func answered(_ id: Int, _ result: Result<JSONObject, LinkError>) {
        guard let continuation = waiting.removeValue(forKey: id) else { return }
        switch result {
        case .success(let body): continuation.resume(returning: body)
        case .failure(let error): continuation.resume(throwing: error)
        }
    }

    fileprivate func down() {
        isUp = false
        let pending = waiting
        waiting = [:]
        for (_, continuation) in pending { continuation.resume(throwing: LinkError.down) }
    }
}

// Where the link is, for Safari's extension handler to answer a copy's ask with at once (docs/PROTOCOL.md
// "Transport (Safari)" step 1): `margin-link` in the extension's own container (its Caches, where the handler leaves
// its launch note for the app), `{ v, port, token, key, app: { version }, pid, at }` (the core's: written as the
// listener gets its port and as the token changes, removed when the listener goes). Only the handler (the extension's
// sandbox) and this app read it; owner-only, replaced whole (a reader never sees half a file). None under the app's
// tests.
struct LinkNote {
    let url: URL?

    static func standard() -> LinkNote {
        guard ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] == nil else { return LinkNote(url: nil) }
        let caches = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Containers/\(marginExtensionIdentifier)/Data/Library/Caches", isDirectory: true)
        return LinkNote(url: caches.appendingPathComponent("margin-link"))
    }

    // The note now (`info` nil: none). Only into a container the extension has made (it has run once).
    func write(_ info: JSONObject?) {
        guard let url else { return }
        guard let info, let data = try? JSONSerialization.data(withJSONObject: info) else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        let dir = url.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: dir.path) else { return }
        let temp = dir.appendingPathComponent(".margin-link-\(ProcessInfo.processInfo.processIdentifier)")
        guard FileManager.default.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600]),
              rename(temp.path, url.path) == 0 else {
            try? FileManager.default.removeItem(at: temp)
            return
        }
    }
}

final class SocketLink {
    struct Timing {
        var tick: TimeInterval = 5
        // (40, not 12, since 2026-11-07: Safari slows a background page's timers while it isn't in front, and a quiet
        // copy then read as gone left the sidebar dimmed on coming back to Safari. A closed socket is heard at once.)
        var dead: TimeInterval = 40
        var keep: TimeInterval = 30 // the token and key, after the last link closes
        var hello: TimeInterval = 5 // an accepted socket, to say hello
        var safariSettled: TimeInterval = 2 // before appUp
        var listenWait: TimeInterval = 5 // the listener waiting this long (after sleep or wake): made again
    }

    weak var delegate: ExtensionLinkDelegate?
    private(set) var port: UInt16?
    let timing: Timing
    // The Origins a copy may open the socket from (a Safari extension's; Chrome's and Edge's, through their relay).
    var allowedOrigins = ["safari-web-extension://", "chrome-extension://"] {
        didSet { perform(call(["type": "origins", "origins": allowedOrigins])) }
    }
    // Chrome's and Edge's relays (RelayLink.swift): started and stopped with the link. None in the tests that make
    // their own.
    var relay: RelayHub?

    private let dispatch: ExtensionDispatch
    private let note: LinkNote
    private let safariSince: () -> Date?
    private let wake: Notification.Name
    private var listener: NWListener?
    private var wakeObserver: NSObjectProtocol?
    private var sockets: [UInt64: Socket] = [:] // every TCP connection the core knows, by its id
    private var nextConn: UInt64 = 1
    private var links: [String: LinkConnection] = [:] // by Hello.key
    private var byConn: [UInt64: LinkConnection] = [:]
    private var timer: Timer?
    private var timerAt: Double?
    private var listenWaitTimer: Timer?
    private var listenerWaiting = false
    private var stopped = false
    // Dispatches in a row that weren't passed on (the core counts them).
    private(set) var refusedInARow = 0
    // A dispatch Safari didn't pass on (its name and why): BundleWatch checks whether the app was replaced.
    var onDispatchRefused: ((String, String) -> Void)?

    private var core: OpaquePointer?
    private let box = Box()
    fileprivate final class Box { weak var link: SocketLink? }

    var connections: [LinkConnection] { links.values.sorted { $0.key < $1.key } }
    func connection(_ key: String) -> LinkConnection? { links[key] }

    init(dispatch: ExtensionDispatch = SafariDispatch(), safariSince: @escaping () -> Date? = safariRunningSince,
         wake: Notification.Name = Notification.Name("com.unibox.margin.setup"), timing: Timing = Timing(), note: LinkNote = .standard()) {
        self.dispatch = dispatch
        self.note = note
        self.safariSince = safariSince
        self.wake = wake
        self.timing = timing
        box.link = self
        let config: JSONObject = [
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "timing": ["tick": timing.tick, "dead": timing.dead, "keep": timing.keep, "hello": timing.hello, "safariSettled": timing.safariSettled],
            "origins": allowedOrigins,
        ]
        let ctx = Unmanaged.passUnretained(box).toOpaque()
        core = jsonText(config).flatMap { data in
            data.withUnsafeBytes { raw in
                margin_link_new(raw.bindMemory(to: UInt8.self).baseAddress, raw.count, ctx) { ctx, which, conn, bytes, len in
                    // (Called during the core's call, on the main thread: each write, in order.)
                    guard let ctx, let bytes else { return }
                    let data = Data(bytes: bytes, count: len)
                    MainActor.assumeIsolated { Unmanaged<Box>.fromOpaque(ctx).takeUnretainedValue().link?.written(which, conn, data) }
                }
            }
        }
        if core == nil { Diagnostics.warn("link: the core's link didn't start") }
    }

    deinit {
        timer?.invalidate()
        listenWaitTimer?.invalidate()
        margin_link_free(core)
    }

    // ---- the core ----

    // One stored key of a link's state, its JSON as the core keeps it (nil: no such link or key).
    fileprivate func stateValue(_ conn: UInt64, _ key: String) -> Data? {
        guard let core else { return nil }
        var len = 0
        let out = Array(key.utf8).withUnsafeBufferPointer { margin_link_state_value(core, conn, $0.baseAddress, $0.count, &len) }
        guard let out else { return nil }
        defer { margin_buffer_free(out, len) }
        return Data(bytes: out, count: len)
    }

    // One request to the core (`now` and `wall` added), its answer; nil if it couldn't be made.
    private func call(_ request: JSONObject) -> JSONObject? {
        var r = request
        r["now"] = Diagnostics.now()
        r["wall"] = Date().timeIntervalSince1970
        return LinkCore.call(r) { margin_link_call(core, $0, $1, $2) } as? JSONObject
    }

    // An answer carried out: the core's state first (another call made while acting supersedes it), then each of its
    // `do`s, in order.
    @discardableResult private func perform(_ answer: JSONObject?) -> JSONObject {
        guard let answer else { return [:] }
        if let error = answer["error"] as? String {
            Diagnostics.warn("link: \(error)")
            return answer
        }
        port = int(answer["port"]).map { UInt16(truncatingIfNeeded: $0) }
        refusedInARow = int(answer["refusedInARow"]) ?? refusedInARow
        schedule(num(answer["deadline"]))
        for item in answer["do"] as? [JSONObject] ?? [] { act(item) }
        return answer
    }

    private func act(_ item: JSONObject) {
        let conn = (item["conn"] as? NSNumber)?.uint64Value ?? 0
        switch item["do"] as? String {
        case "end":
            if item["which"] as? String == "relay" { relay?.end(conn) } else { sockets[conn]?.end() }
        case "log":
            let text = item["text"] as? String ?? ""
            if item["warn"] as? Bool == true { Diagnostics.warn(text) } else { Diagnostics.note(text) }
        case "safari":
            let name = item["name"] as? String ?? ""
            let n = item["n"] as? Int ?? 0
            dispatch.dispatch(name, item["info"] as? JSONObject ?? [:]) { [weak self] why in
                self?.perform(self?.call(["type": "dispatched", "name": name, "n": n, "why": why ?? NSNull()]))
            }
        case "note":
            note.write(item["info"] as? JSONObject)
        case "appUpDue":
            sayAppUp()
        case "up":
            guard let hello = (item["hello"] as? JSONObject).flatMap({ LinkMessage.Hello(core: $0) }) else { return }
            let link = LinkConnection(hello: hello, conn: conn, owner: self)
            links[hello.key] = link
            byConn[conn] = link
            delegate?.linkUp(link)
        case "state":
            // (Applied by the core as it was read: its mirror has it, the gap's resync sent and logged there.)
            guard let link = byConn[conn], let state = LinkMessage.State(core: item) else { return }
            link.mirror.applied(state)
            delegate?.linkReceived(link, .state(state))
        case "received":
            guard let link = byConn[conn], let message = (item["message"] as? JSONObject).flatMap({ LinkMessage(core: $0) }) else { return }
            delegate?.linkReceived(link, message)
        case "theme":
            guard let link = byConn[conn] else { return }
            let data = (item["text"] as? String).map { Data($0.utf8) } ?? Data()
            delegate?.linkReceived(link, .theme(epoch: item["epoch"] as? String ?? link.epoch, theme: .complete(id: item["id"] as? String ?? "", data: data)))
        case "themeRefused":
            guard let link = byConn[conn] else { return }
            delegate?.linkReceived(link, .theme(epoch: link.epoch, theme: .refused(item["why"] as? String ?? "")))
        case "down":
            guard let link = byConn.removeValue(forKey: conn) else { return }
            if links[link.key] === link { links[link.key] = nil }
            link.down()
            delegate?.linkDown(link, item["why"] as? String ?? "")
        case "answer":
            guard let link = byConn[conn], let id = item["id"] as? Int else { return }
            if let reply = item["reply"] as? JSONObject { return link.answered(id, .success(reply)) }
            link.answered(id, .failure(Self.error(item["error"] as? String)))
        case "refused":
            onDispatchRefused?(item["name"] as? String ?? "", item["why"] as? String ?? "")
        default:
            break
        }
    }

    private static func error(_ name: String?) -> LinkError {
        switch name {
        case "lost": .lost
        case "notJSON": .notJSON
        default: .down
        }
    }

    // The one timer, at the core's next deadline (nil: none).
    private func schedule(_ at: Double?) {
        guard at != timerAt || (at != nil && timer == nil) else { return }
        timer?.invalidate()
        timer = nil
        timerAt = at
        guard let at, !stopped else { return }
        timer = Timer.scheduledTimer(withTimeInterval: max(0, at - Diagnostics.now()), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.timer = nil
                self.timerAt = nil
                self.perform(self.call(["type": "tick"]))
            }
        }
    }

    // A write the core made (during its call): to that TCP connection, or that relay.
    private func written(_ which: UInt8, _ conn: UInt64, _ data: Data) {
        if which == 1 { relay?.write(conn, data) } else { sockets[conn]?.write(data) }
    }

    // ---- what the rest of the app calls ----

    func start() {
        guard listener == nil else { return }
        stopped = false
        listen()
        // The extension handler's notification (app/engines/webkit/safari/handler/SafariWebExtensionHandler.swift): a JSON string.
        wakeObserver = DistributedNotificationCenter.default().addObserver(forName: wake, object: nil, queue: .main) { [weak self] note in
            let json = note.object as? String
            MainActor.assumeIsolated { self?.woken(json) }
        }
        if let relay {
            perform(call(["type": "relays", "version": relay.version]))
            relay.start(link: self)
        }
        sayAppUp()
    }

    // The wantLink a distributed notification carries (the tests call it too).
    func wantLink(nonce: String) {
        woken(jsonString(["type": "wantLink", "nonce": nonce]))
    }

    private func woken(_ json: String?) {
        guard !stopped else { return }
        perform(call(["type": "woken", "json": json ?? NSNull()]))
    }

    // Safari open before the app: its copies are told to ask (the core waits until Safari has run 2 s).
    private func sayAppUp() {
        let runningFor: Any = safariSince().map { Date().timeIntervalSince($0) } ?? NSNull()
        perform(call(["type": "appUp", "runningFor": runningFor]))
    }

    fileprivate func drawn(_ link: LinkConnection, hosted: [Int64], windows: [Int64]) {
        var epoch = link.epoch
        let answer = epoch.withUTF8 { e in
            hosted.withUnsafeBufferPointer { h in
                windows.withUnsafeBufferPointer { w in
                    LinkCore.answer { margin_link_drawn(core, link.conn, e.baseAddress, e.count, h.baseAddress, h.count, w.baseAddress, w.count, Diagnostics.now(), Date().timeIntervalSince1970, $0) }
                }
            }
        } as? JSONObject
        guard let answer else { return } // (nothing changed: nothing sent)
        perform(answer)
        if let refused = int(answer["refused"]) { link.refusedByCore = refused }
    }

    fileprivate func send(_ link: LinkConnection, _ message: AppMessage) -> Bool {
        guard let answer = call(["type": "send", "conn": link.conn, "message": message.core]) else {
            // (Not JSON here, before the core: a payload JSONSerialization can't write.)
            link.refusedHere += 1
            Diagnostics.warn("not sent to \(link.key): not JSON, or over \(LinkProtocol.maxAppMessage) bytes")
            return false
        }
        perform(answer)
        if let refused = int(answer["refused"]) { link.refusedByCore = refused }
        return answer["sent"] as? Bool == true
    }

    fileprivate func ask(_ link: LinkConnection, _ type: String, _ payload: JSONObject, _ windowId: Int?) -> Result<Int, LinkError> {
        guard let answer = call(["type": "request", "conn": link.conn, "kind": type, "payload": payload, "windowId": windowId ?? NSNull()]) else { return .failure(.notJSON) }
        perform(answer)
        if let id = int(answer["id"]) { return .success(id) }
        return .failure(Self.error(answer["error"] as? String))
    }

    fileprivate func close(_ link: LinkConnection, _ code: UInt16, _ why: String) {
        perform(call(["type": "close", "conn": link.conn, "code": Int(code), "why": why]))
    }

    fileprivate func cancel(_ link: LinkConnection, _ id: Int) {
        perform(call(["type": "cancel", "conn": link.conn, "id": id]))
    }

    fileprivate func slow(_ link: LinkConnection) -> TimeInterval? {
        num(call(["type": "slow", "conn": link.conn])?["slow"])
    }

    // Whether a relay's hello has named this browser process since the app started (RelayHub.heardPid).
    func heardPid(_ pid: pid_t) -> Bool {
        pid > 0 && call(["type": "heardPid", "pid": Int(pid)])?["heard"] as? Bool == true
    }

    func stop(why: String, then: @escaping () -> Void) {
        stopped = true
        relay?.stop()
        if let wakeObserver { DistributedNotificationCenter.default().removeObserver(wakeObserver) }
        wakeObserver = nil
        listenWaitTimer?.invalidate()
        listenWaitTimer = nil
        listener?.cancel()
        listener = nil
        perform(call(["type": "stop", "why": why]))
        timer?.invalidate()
        timer = nil
        timerAt = nil
        // The `bye`s and close frames written, at most 0.3 s (not a Timer: quitting, AppKit runs the run loop in its
        // modal panel mode, where one never fires).
        let writing = sockets.values.filter(\.writing)
        guard !writing.isEmpty else { return then() }
        var left = writing.count
        var done = false
        let finish = {
            guard !done else { return }
            done = true
            then()
        }
        for socket in writing {
            socket.drained = {
                left -= 1
                if left == 0 { finish() }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MainActor.assumeIsolated { finish() } }
    }

    // ---- the listener ----

    private func listen() {
        // No Nagle: the small frames (req, drawn, tick) go at once.
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let parameters = NWParameters(tls: nil, tcp: tcp)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        parameters.acceptLocalOnly = true
        let listener: NWListener
        do {
            listener = try NWListener(using: parameters)
        } catch {
            Diagnostics.warn("no listener: \(error)")
            return retryListen()
        }
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated { self?.listening(listener, state) }
        }
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        listener.start(queue: .main)
    }

    private func listening(_ listener: NWListener, _ state: NWListener.State) {
        guard listener === self.listener else { return }
        switch state {
        case .ready:
            listenerWaiting = false
            listenWaitTimer?.invalidate()
            listenWaitTimer = nil
            perform(call(["type": "listening", "port": listener.port.map { Int($0.rawValue) } ?? NSNull()]))
        case .failed(let error):
            listenerWaiting = false
            Diagnostics.warn("listener failed: \(error)")
            listener.cancel()
            self.listener = nil
            perform(call(["type": "listening", "port": NSNull()]))
            retryListen()
        case .waiting(let error):
            // As after sleep or wake, or a network change: made again if it lasts.
            Diagnostics.warn("listener waiting: \(error)")
            listenerWaiting = true
            waitForListener(listener)
        case .setup:
            Diagnostics.note("listener setting up")
        case .cancelled:
            // Not by stop() or a restart here (those let it go first): the system's.
            Diagnostics.warn("listener cancelled")
            self.listener = nil
            perform(call(["type": "listening", "port": NSNull()]))
            retryListen()
        @unknown default:
            Diagnostics.note("listener state: \(state)")
        }
    }

    // A listener still waiting after `listenWait`: cancelled and made again (a new port; copies
    // with the old one kept ask again).
    private func waitForListener(_ listener: NWListener) {
        guard listenWaitTimer == nil else { return }
        listenWaitTimer = Timer.scheduledTimer(withTimeInterval: timing.listenWait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.listenWaitTimer = nil
                guard !self.stopped, listener === self.listener, self.listenerWaiting else { return }
                Diagnostics.warn("listener still waiting after \(Int(self.timing.listenWait)) s: made again")
                self.listenerWaiting = false
                self.listener = nil
                self.perform(self.call(["type": "listening", "port": NSNull()]))
                listener.cancel()
                self.listen()
            }
        }
    }

    private func retryListen() {
        Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.stopped, self.listener == nil else { return }
                self.listen()
            }
        }
    }

    // ---- sockets ----

    private func accept(_ connection: NWConnection) {
        guard !stopped else { return connection.cancel() }
        let id = nextConn
        nextConn += 1
        let socket = Socket(id: id, connection, link: self)
        sockets[id] = socket
        perform(call(["type": "accept", "conn": id]))
        socket.start()
    }

    fileprivate func bytes(_ socket: Socket, _ data: Data) {
        let answer = data.withUnsafeBytes { raw in
            LinkCore.answer { margin_link_bytes(core, 0, socket.id, raw.bindMemory(to: UInt8.self).baseAddress, raw.count, Diagnostics.now(), Date().timeIntervalSince1970, $0) }
        }
        perform(answer as? JSONObject)
        if let link = byConn[socket.id] { delegate?.linkHeard(link) }
    }

    fileprivate func ended(_ socket: Socket, _ error: String?) {
        guard sockets[socket.id] === socket else { return }
        sockets[socket.id] = nil
        perform(call(["type": "ended", "conn": socket.id, "error": error ?? NSNull()]))
    }

    // ---- the relays (RelayLink.swift) ----

    func relayOpened(_ id: UInt64) {
        perform(call(["type": "relayOpen", "conn": id]))
    }

    func relayBytes(_ id: UInt64, _ data: Data) {
        let answer = data.withUnsafeBytes { raw in
            LinkCore.answer { margin_link_bytes(core, 1, id, raw.bindMemory(to: UInt8.self).baseAddress, raw.count, Diagnostics.now(), Date().timeIntervalSince1970, $0) }
        }
        perform(answer as? JSONObject)
        if let link = byConn[id] { delegate?.linkHeard(link) }
    }

    func relayEnded(_ id: UInt64) {
        perform(call(["type": "relayEnded", "conn": id]))
    }
}

// One TCP connection's transport: its bytes to the core, the core's writes in order, closed once what was written
// before has gone, and its end said to the core once.
fileprivate final class Socket {
    let id: UInt64
    private let tcp: NWConnection
    private weak var link: SocketLink?
    private var pending = 0 // writes not yet sent
    private var endWhenSent = false
    private var cancelled = false
    private var finished = false
    // Stop's wait: told once what was written has gone.
    var drained: (() -> Void)?
    var writing: Bool { pending > 0 }

    init(id: UInt64, _ tcp: NWConnection, link: SocketLink) {
        self.id = id
        self.tcp = tcp
        self.link = link
    }

    func start() {
        guard !cancelled else { return }
        tcp.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                switch state {
                case .failed(let error): self?.finish("\(error)")
                case .cancelled: self?.finish(nil)
                default: break
                }
            }
        }
        tcp.start(queue: .main)
        receive()
    }

    private func receive() {
        tcp.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, !self.finished else { return }
                if let data, !data.isEmpty { self.link?.bytes(self, data) }
                // No close frame came: a plain TCP end (a background torn down, a crash) or an error.
                if complete || error != nil { return self.finish(error.map { "\($0)" }) }
                if !self.finished, !self.cancelled { self.receive() }
            }
        }
    }

    func write(_ data: Data) {
        guard !cancelled else { return }
        pending += 1
        tcp.send(content: data, completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated { self?.sent() }
        })
    }

    private func sent() {
        pending -= 1
        guard pending == 0 else { return }
        if endWhenSent { cancel() }
        drained?()
        drained = nil
    }

    // The core's end: closed once what was written before has gone.
    func end() {
        guard !cancelled else { return }
        if pending == 0 { cancel() } else { endWhenSent = true }
    }

    private func cancel() {
        guard !cancelled else { return }
        cancelled = true
        tcp.cancel()
    }

    // It has ended (the copy's end, a failure, or ours): said to the core once.
    private func finish(_ error: String?) {
        guard !finished else { return }
        finished = true
        cancel()
        link?.ended(self, error)
    }
}
