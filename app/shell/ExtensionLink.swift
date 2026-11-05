// Margin.app's lines to Margin's extension copies in Safari (app/PROTOCOL.md
// has the whole exchange; the extension's end is step 3's). The extension can
// reach only the app's extension handler, and the app can only send into the
// extension (SFSafariApplication.dispatchMessage), so:
//  1. a copy asks for the link (a native message `wantLink` with a nonce):
//     the extension handler wakes the app with a distributed notification
//     that carries only the nonce (anything on the Mac may hear it);
//  2. the app answers into the extension: `link`, with that nonce, the port
//     it listens on (127.0.0.1 only), a token (the copy's proof that it's
//     Margin) and a key (the app's proof that it's the app);
//  3. the copy opens ws://127.0.0.1:<port>/?t=<token> (its Origin a Safari
//     extension's); the app's first message is `welcome { key }`, then the
//     copy says `hello` (its browser and profile) and sends the state.
// Safari runs one copy per profile, each with its own link, at once: a link
// is known by its browser and profile (Hello.key). A newer link for the same
// profile takes over from the older one, and a copy not in charge of its
// profile's state (hello.owner false: another copy of Margin, as after an
// update) is closed. The app starting while Safari is open says `appUp`
// (only once Safari has been running 2 s: dispatchMessage launches Safari if
// it isn't), and the copies ask again.
//
// A socket is alive while it's heard from: the app ticks every 5 s, the copy
// answers (`tock`), and 12 s without a word closes it. After the last link
// closes, the token and key stay for 30 s (a copy starting again tries the
// link it kept first), then change.
//
// From feat/native-panel's SocketLink (one link), generalised to several.

import AppKit
import Network
import SafariServices

protocol ExtensionLinkDelegate: AnyObject {
    func linkUp(_ link: LinkConnection)
    // Everything after hello but replies and tocks (a goodbye just before the link goes down).
    func linkReceived(_ link: LinkConnection, _ message: LinkMessage)
    func linkDown(_ link: LinkConnection, _ why: String)
}

enum LinkError: Error {
    case down
    case timedOut
    case notJSON
}

// What the app says into the extension (its copies' native ports).
protocol ExtensionDispatch {
    func dispatch(_ name: String, _ info: JSONObject)
}

let marginExtensionIdentifier = "io.tirth.margin.Extension"
let safariIdentifier = "com.apple.Safari"

// When Safari started, if it's running.
func safariRunningSince() -> Date? {
    NSRunningApplication.runningApplications(withBundleIdentifier: safariIdentifier).filter { !$0.isTerminated }.compactMap(\.launchDate).min()
}

// SFSafariApplication.dispatchMessage, as one JSON string (userInfo.e). Never
// while Safari isn't running: it would open Safari.
struct SafariDispatch: ExtensionDispatch {
    func dispatch(_ name: String, _ info: JSONObject) {
        guard safariRunningSince() != nil else { return Diagnostics.note("\(name) not sent: Safari isn't running") }
        guard let json = jsonString(info) else { return }
        Task {
            do {
                try await SFSafariApplication.dispatchMessage(withName: name, toExtensionWithIdentifier: marginExtensionIdentifier, userInfo: ["e": json])
            } catch {
                Diagnostics.warn("\(name) not passed on to Margin: \(error.localizedDescription)")
            }
        }
    }
}

// One copy's link, once it has said hello: what the rest of the app talks to.
final class LinkConnection {
    let hello: LinkMessage.Hello
    var key: String { hello.key }
    var epoch: String { hello.epoch }
    fileprivate let socket: Socket
    fileprivate weak var owner: SocketLink?
    fileprivate var waiting: [Int: CheckedContinuation<JSONObject, Error>] = [:]
    private var nextId = 1
    private(set) var isUp = true
    // Messages refused for their size (tests read it).
    private(set) var refused = 0

    fileprivate init(hello: LinkMessage.Hello, socket: Socket, owner: SocketLink) {
        self.hello = hello
        self.socket = socket
        self.owner = owner
    }

    // False if the link is down, or the message couldn't be sent (not JSON, over 1 MB).
    @discardableResult func send(_ message: AppMessage) -> Bool {
        guard isUp else { return false }
        guard let text = message.encode() else {
            refused += 1
            Diagnostics.warn("not sent to \(key): not JSON, or over \(LinkProtocol.maxAppMessage) bytes")
            return false
        }
        socket.send(text)
        return true
    }

    // A request (`req`), answered as a page's is: { ok, result } or { ok: false, error, stale? }.
    func request(type: String, payload: JSONObject, windowId: Int?) async throws -> JSONObject {
        guard isUp else { throw LinkError.down }
        let id = nextId
        nextId += 1
        guard let text = AppMessage.req(id: id, epoch: epoch, windowId: windowId, type: type, payload: payload).encode() else { throw LinkError.notJSON }
        let timeout = owner?.timing.request ?? 15
        return try await withCheckedThrowingContinuation { continuation in
            waiting[id] = continuation
            socket.send(text)
            Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.waiting.removeValue(forKey: id)?.resume(throwing: LinkError.timedOut) }
            }
        }
    }

    func close(_ code: UInt16 = 1000, _ why: String) {
        socket.close(code, why)
    }

    fileprivate func replied(_ id: Int, _ body: JSONObject) {
        waiting.removeValue(forKey: id)?.resume(returning: body)
    }

    fileprivate func down() {
        isUp = false
        let pending = waiting
        waiting = [:]
        for (_, continuation) in pending { continuation.resume(throwing: LinkError.down) }
    }
}

final class SocketLink {
    struct Timing {
        var tick: TimeInterval = 5
        var dead: TimeInterval = 12
        var keep: TimeInterval = 30 // the token and key, after the last link closes
        var hello: TimeInterval = 5 // an accepted socket, to say hello
        var request: TimeInterval = 15
        var safariSettled: TimeInterval = 2 // before appUp
    }

    weak var delegate: ExtensionLinkDelegate?
    private(set) var port: UInt16?
    let timing: Timing
    // The Origins a copy may open the socket from (a Safari extension's).
    var allowedOrigins = ["safari-web-extension://"]

    private let dispatch: ExtensionDispatch
    private let safariSince: () -> Date?
    private let wake: Notification.Name
    private var listener: NWListener?
    private var token = SocketLink.secret()
    private var key = SocketLink.secret()
    private var wakeObserver: NSObjectProtocol?
    private var asked: [String] = [] // nonces asked for before the listener had its port
    private var sockets: [Socket] = [] // accepted, no hello yet
    private var links: [String: LinkConnection] = [:] // by Hello.key
    private var ticker: Timer?
    private var rotation: Timer?
    private var appUpTimer: Timer?
    private var stopped = false

    var connections: [LinkConnection] { links.values.sorted { $0.key < $1.key } }
    func connection(_ key: String) -> LinkConnection? { links[key] }

    init(dispatch: ExtensionDispatch = SafariDispatch(), safariSince: @escaping () -> Date? = safariRunningSince,
         wake: Notification.Name = Notification.Name("io.tirth.margin.setup"), timing: Timing = Timing()) {
        self.dispatch = dispatch
        self.safariSince = safariSince
        self.wake = wake
        self.timing = timing
    }

    // 32 random bytes, hex.
    static func secret() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    func start() {
        guard listener == nil else { return }
        stopped = false
        listen()
        // The extension handler's notification (app/safari/SafariWebExtensionHandler.swift): a JSON string.
        wakeObserver = DistributedNotificationCenter.default().addObserver(forName: wake, object: nil, queue: .main) { [weak self] note in
            let json = note.object as? String
            MainActor.assumeIsolated { self?.woken(json) }
        }
        sayAppUp()
    }

    private func listen() {
        // No Nagle: the small frames (req, setLayout, tick) go at once.
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
            port = listener.port?.rawValue
            Diagnostics.note("listening on 127.0.0.1:\(port ?? 0)")
            let nonces = asked
            asked = []
            for nonce in nonces { answer(nonce) }
        case .failed(let error):
            Diagnostics.warn("listener failed: \(error)")
            listener.cancel()
            self.listener = nil
            port = nil
            retryListen()
        default:
            break
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

    // ---- getting linked ----

    private func woken(_ json: String?) {
        guard !stopped, let data = json?.data(using: .utf8),
              let body = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject,
              body["type"] as? String == "wantLink" else { return }
        guard let nonce = body["nonce"] as? String, (1...128).contains(nonce.count) else { return Diagnostics.warn("wantLink without a nonce") }
        if port == nil { asked = Array((asked + [nonce]).suffix(8)) } else { answer(nonce) }
    }

    // The wantLink a distributed notification carries (the tests call it too).
    func wantLink(nonce: String) {
        woken(jsonString(["type": "wantLink", "nonce": nonce]))
    }

    private func answer(_ nonce: String) {
        guard let port else { return }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        dispatch.dispatch("link", ["v": LinkProtocol.version, "nonce": nonce, "port": Int(port), "token": token, "key": key, "app": ["version": version], "at": Self.at()])
        Diagnostics.note("wantLink: link sent (port \(port))")
    }

    // Safari open before the app: its copies are told to ask. Only once Safari
    // has been running a while (dispatchMessage opens Safari if it isn't).
    private func sayAppUp() {
        appUpTimer?.invalidate()
        guard let since = safariSince() else { return }
        let wait = timing.safariSettled - Date().timeIntervalSince(since)
        if wait <= 0 {
            dispatch.dispatch("appUp", ["v": LinkProtocol.version, "at": Self.at()])
            Diagnostics.note("appUp sent")
            return
        }
        appUpTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { if let self, !self.stopped, self.links.isEmpty { self.sayAppUp() } }
        }
    }

    // ---- sockets ----

    private func accept(_ connection: NWConnection) {
        guard !stopped else { return connection.cancel() }
        let socket = Socket(connection, link: self)
        sockets.append(socket)
        socket.start()
        Timer.scheduledTimer(withTimeInterval: timing.hello, repeats: false) { [weak self, weak socket] _ in
            MainActor.assumeIsolated {
                guard let self, let socket, socket.connection == nil, self.sockets.contains(where: { $0 === socket }) else { return }
                socket.close(1008, "no hello")
            }
        }
    }

    // Whether a socket's request is a copy's: the token, from a Safari extension.
    fileprivate func allows(_ request: Handshake.Request) -> String? {
        guard request.path == "/" || request.path.isEmpty else { return "not the link's path" }
        guard Handshake.isUpgrade(request) else { return "not a WebSocket" }
        guard sameSecret(request.query["t"] ?? "", token) else { return "wrong token" }
        guard let origin = request.headers["origin"], allowedOrigins.contains(where: { origin.hasPrefix($0) }) else { return "not from a Safari extension" }
        return nil
    }

    fileprivate func opened(_ socket: Socket) {
        Diagnostics.note("socket open")
        socket.send(AppMessage.welcome(key: key).encode() ?? "")
    }

    fileprivate func received(_ text: String, on socket: Socket) {
        guard let message = LinkMessage.decode(text) else { return Diagnostics.warn("not a link message (\(text.prefix(40)))") }
        if case .hello(let hello) = message { return said(hello, on: socket) }
        guard let link = socket.connection, link.isUp else { return Diagnostics.warn("a message before hello: closed") }
        switch message {
        case .reply(let id, let body):
            link.replied(id, body)
        case .tock:
            break
        case .bye(let why):
            Diagnostics.note("\(link.key) said goodbye: \(why)")
            delegate?.linkReceived(link, message) // before it's down: nothing to wait for
            socket.close(1000, "bye")
        default:
            delegate?.linkReceived(link, message)
        }
    }

    private func said(_ hello: LinkMessage.Hello, on socket: Socket) {
        guard socket.connection == nil else { return Diagnostics.warn("a second hello on one socket: left") }
        guard hello.owner else {
            Diagnostics.note("hello from a copy of Margin not in charge in \(hello.key): closed")
            return socket.close(1008, "not the copy in charge")
        }
        sockets.removeAll { $0 === socket }
        if let old = links[hello.key] {
            // Not the profile's link going down: the newer one takes over.
            links[hello.key] = nil
            old.down()
            old.socket.close(1000, "replaced")
            Diagnostics.note("a newer link for \(hello.key) took over")
            delegate?.linkDown(old, "replaced")
        }
        let link = LinkConnection(hello: hello, socket: socket, owner: self)
        socket.connection = link
        links[hello.key] = link
        rotation?.invalidate()
        rotation = nil
        appUpTimer?.invalidate()
        if ticker == nil {
            ticker = Timer.scheduledTimer(withTimeInterval: timing.tick, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
        }
        Diagnostics.note("hello: \(hello.key), Margin \(hello.ext ?? "?")")
        delegate?.linkUp(link)
    }

    private func tick() {
        for link in connections {
            if Diagnostics.now() - link.socket.lastHeard > timing.dead {
                Diagnostics.warn("no word from \(link.key) for \(Int(timing.dead)) s")
                link.socket.close(1001, "no word for \(Int(timing.dead)) s")
            } else {
                link.send(.tick)
            }
        }
    }

    fileprivate func closed(_ socket: Socket, _ why: String) {
        sockets.removeAll { $0 === socket }
        guard let link = socket.connection, links[link.key] === link else { return }
        links[link.key] = nil
        link.down()
        Diagnostics.note("link down (\(link.key)): \(why)")
        if links.isEmpty {
            ticker?.invalidate()
            ticker = nil
            // A copy starting again tries the link it kept, for a while.
            rotation?.invalidate()
            rotation = stopped ? nil : Timer.scheduledTimer(withTimeInterval: timing.keep, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.links.isEmpty else { return }
                    self.token = Self.secret()
                    self.key = Self.secret()
                    Diagnostics.note("token changed")
                }
            }
        }
        delegate?.linkDown(link, why)
    }

    func stop(why: String, then: @escaping () -> Void) {
        stopped = true
        if let wakeObserver { DistributedNotificationCenter.default().removeObserver(wakeObserver) }
        wakeObserver = nil
        for timer in [ticker, rotation, appUpTimer] { timer?.invalidate() }
        ticker = nil
        listener?.cancel()
        listener = nil
        port = nil
        for socket in sockets { socket.close(1001, why) }
        let open = connections
        guard !open.isEmpty else { return then() }
        var left = open.count
        var done = false
        let finish = {
            guard !done else { return }
            done = true
            then()
        }
        for link in open {
            let socket = link.socket
            socket.send(AppMessage.bye(why: why).encode() ?? "") {
                socket.close(1001, why)
                left -= 1
                if left == 0 { finish() }
            }
            closed(socket, "stopped: \(why)")
        }
        // Not a Timer: quitting, AppKit runs the run loop in its modal panel mode, where one never fires.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MainActor.assumeIsolated { finish() } }
    }

    static func at() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
}

// One TCP connection: the WebSocket handshake, then its messages (LinkSocket.swift).
fileprivate final class Socket {
    private let tcp: NWConnection
    private weak var link: SocketLink?
    // Its copy's link, once it said hello.
    var connection: LinkConnection?
    private var head = Data()
    private var reader = FrameReader()
    private var open = false
    private var ended = false
    private(set) var lastHeard = Diagnostics.now()

    init(_ tcp: NWConnection, link: SocketLink) {
        self.tcp = tcp
        self.link = link
    }

    func start() {
        tcp.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                switch state {
                case .failed(let error): self?.end("failed: \(error)")
                case .cancelled: self?.end("cancelled")
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
                guard let self, !self.ended else { return }
                if let data, !data.isEmpty { self.got(data) }
                if complete || error != nil { return self.end(error.map { "\($0)" } ?? "closed") }
                if !self.ended { self.receive() }
            }
        }
    }

    private func got(_ data: Data) {
        lastHeard = Diagnostics.now()
        if !open {
            head.append(data)
            switch Handshake.parse(head) {
            case .incomplete:
                return
            case .bad:
                return refuse("400 Bad Request", "not a request")
            case .request(let request, let rest):
                head = Data()
                if let why = link?.allows(request) { return refuse("403 Forbidden", why) }
                open = true
                tcp.send(content: Handshake.switching(key: request.headers["sec-websocket-key"] ?? ""), completion: .idempotent)
                link?.opened(self)
                reader.append(rest)
            }
        } else {
            reader.append(data)
        }
        do {
            while open, !ended, let message = try reader.nextMessage() {
                switch message {
                case .text(let text): link?.received(text, on: self)
                case .ping(let payload): write(Frame.encode(.pong, payload))
                case .close: close(1000, "closed by the extension")
                case .none: break
                }
            }
        } catch {
            close(1002, "\(error)")
        }
    }

    private func refuse(_ status: String, _ why: String) {
        Diagnostics.warn("socket refused: \(why)")
        tcp.send(content: Handshake.refusal(status), completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated { self?.tcp.cancel() }
        })
        end(why)
    }

    func send(_ text: String, then: (() -> Void)? = nil) {
        guard open, !ended else { then?(); return }
        write(Frame.encode(.text, Data(text.utf8)), then: then)
    }

    private func write(_ data: Data, then: (() -> Void)? = nil) {
        tcp.send(content: data, completion: .contentProcessed { _ in
            MainActor.assumeIsolated { then?() }
        })
    }

    func close(_ code: UInt16, _ why: String) {
        guard !ended else { return }
        if open {
            write(Frame.close(code, why)) { [tcp] in tcp.cancel() }
        } else {
            tcp.cancel()
        }
        end(why)
    }

    private func end(_ why: String) {
        guard !ended else { return }
        ended = true
        link?.closed(self, why)
    }
}
