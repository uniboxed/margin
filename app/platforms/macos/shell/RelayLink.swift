// Chrome's and Edge's way to Margin.app (docs/PROTOCOL.md "Transport (Chrome and Edge, on the Mac)"): their copies
// can't hear SFSafariApplication.dispatchMessage, so the browser starts Margin's connector
// (Margin.app/Contents/Helpers/margin-connector, app/shared/connector/) through native messaging, and the connector
// connects here, a Unix socket only this user can open. It does for those copies what Safari's extension handler
// does for Safari's: each message gets the handler's reply; a `wantLink` is answered into every relay of that
// browser's process (the copy's lasting port is one of them), as SocketLink answers Safari's into Safari; `appUp`
// goes to a relay that had to wait for the app. The link itself is the same WebSocket as Safari's (SocketLink).
//
// One JSON object per line both ways. The relay's first: `{ k: 'relay', v: 1, version, pid, browser, waited }`,
// answered `{ k: 'relayWelcome', v: 1, version }`; then each of the browser's messages as `{ msg }`. What the app
// sends is passed to the browser as it is.

import Foundation
import Security

// Margin's connector in this build (Contents/Helpers/margin-connector), and what the app asks of it at launch.
enum Connector {
    static var url: URL? {
        let url = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/margin-connector")
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    // Chrome's, Edge's and the other Chromium browsers' host files (margin-connector --install: the connector's
    // own knowledge of where each browser keeps them, app/engines/chromium/), written in the background; the
    // log says how many changed.
    static func installHostFiles() {
        guard let url else { return Diagnostics.warn("no connector in this build (Contents/Helpers/margin-connector): Chrome and Edge can't link") }
        let process = Process()
        process.executableURL = url
        process.arguments = ["--install"]
        let out = Pipe()
        let errors = Pipe()
        process.standardOutput = out
        process.standardError = errors
        process.terminationHandler = { done in
            let written = (String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "").split(separator: "\n").count
            let why = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let status = done.terminationStatus
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if status != 0 { Diagnostics.warn("the browsers' host files weren't written: \(why.prefix(200))") }
                    else if written > 0 { Diagnostics.note("the browsers' host files written: \(written)") }
                }
            }
        }
        do { try process.run() } catch { Diagnostics.warn("the connector didn't start: \(error.localizedDescription)") }
    }
}

final class RelayHub {
    struct Peer: Sendable {
        let pid: pid_t
        let uid: uid_t
    }

    let path: String
    // Whether a connecting process may be a relay: the same user, and in a signed build Margin's relay
    // (relaySignedByUs). The tests pass their own.
    private let allows: (Peer) -> String?
    private let version: String
    private weak var link: SocketLink?
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var relays: [ObjectIdentifier: RelayConnection] = [:]
    // Every browser process a relay's hello has named since the app started (gone relays' too): a copy's hello names
    // its process as its relay told it, so one that matches none is worth a word in the log (Shell.unheardPid).
    private var heard: Set<pid_t> = []

    init(path: String = RelayHub.defaultPath, version: String = RelayHub.appVersion, allows: ((Peer) -> String?)? = nil) {
        self.path = path
        self.version = version
        self.allows = allows ?? RelayHub.relaySignedByUs
    }

    // ~/Library/Application Support/Margin/connector.sock (a socket path may be at most 104 bytes; the connector's
    // own default is the same: app/shared/connector/src/unix.rs).
    static var defaultPath: String {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Margin/connector.sock").path
    }

    static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "" }

    var connected: Int { relays.count }

    // Whether a relay's hello has named this browser process since the app started.
    func heardPid(_ pid: pid_t) -> Bool { heard.contains(pid) }

    func start(link: SocketLink) {
        guard listenFD < 0 else { return }
        self.link = link
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return Diagnostics.warn("relay: no socket (errno \(errno))") }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            close(fd)
            return Diagnostics.warn("relay: its socket's path is too long (\(bytes.count) bytes)")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
        }
        // Made with no access for anyone else from the start (then 0600 on the file itself).
        let mask = umask(0o077)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        umask(mask)
        guard bound == 0, listen(fd, 16) == 0 else {
            Diagnostics.warn("relay: couldn't listen at its socket (errno \(errno))")
            close(fd)
            return
        }
        chmod(path, 0o600)
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        listenFD = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.accept() } }
        source.resume()
        acceptSource = source
        Diagnostics.note("relay: listening for Chrome's and Edge's relays")
    }

    func stop() {
        acceptSource?.cancel()
        acceptSource = nil
        if listenFD >= 0 { close(listenFD) }
        listenFD = -1
        unlink(path)
        for relay in relays.values { relay.close() }
        relays = [:]
    }

    private func accept() {
        while true {
            let fd = Darwin.accept(listenFD, nil, nil)
            guard fd >= 0 else { return }
            guard let peer = Self.peer(fd) else {
                Diagnostics.warn("relay: a connection whose process couldn't be told: closed")
                close(fd)
                continue
            }
            if let why = allows(peer) {
                Diagnostics.warn("relay: refused pid \(peer.pid): \(why)")
                close(fd)
                continue
            }
            let relay = RelayConnection(fd: fd, peer: peer, hub: self)
            relays[ObjectIdentifier(relay)] = relay
            relay.start()
        }
    }

    // The process at the other end of a Unix socket, and its user.
    nonisolated static func peer(_ fd: Int32) -> Peer? {
        var pid: pid_t = 0
        var size = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0, pid > 0 else { return nil }
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(fd, &uid, &gid) == 0 else { return nil }
        return Peer(pid: pid, uid: uid)
    }

    // This user's, and (when Margin.app is signed by a team) Margin's relay signed by the same team.
    nonisolated static func relaySignedByUs(_ peer: Peer) -> String? {
        guard peer.uid == getuid() else { return "another user's process" }
        guard let team = ownTeam() else { return nil } // an ad-hoc build (--unsigned): the user's own processes
        var code: SecCode?
        let attributes = [kSecGuestAttributePid: peer.pid] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else { return "its code couldn't be read" }
        var requirement: SecRequirement?
        let text = "identifier \"io.tirth.margin.connector\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else { return "no requirement" }
        return SecCodeCheckValidity(code, [], requirement) == errSecSuccess ? nil : "not Margin's relay"
    }

    // The team that signed this app, if one did.
    nonisolated static func ownTeam() -> String? {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(me, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return nil }
        return dict[kSecCodeInfoTeamIdentifier as String] as? String
    }

    // ---- what relays say ----

    fileprivate func said(_ relay: RelayConnection, _ message: JSONObject) {
        if relay.hello == nil {
            guard message["k"] as? String == "relay", let browser = message["browser"] as? String, ["chrome", "edge"].contains(browser) else {
                Diagnostics.warn("relay: its first word wasn't its hello: closed")
                return relay.close()
            }
            let pid = (message["pid"] as? Int).map { pid_t($0) } ?? 0
            if pid > 0 { heard.insert(pid) }
            relay.hello = RelayConnection.Hello(browser: browser, pid: pid, version: message["version"] as? String ?? "", waited: message["waited"] as? Bool == true)
            relay.send(["k": "relayWelcome", "v": 1, "version": version])
            // Waiting for the app, the copies asked in vain: they ask again now (as Safari's do on appUp).
            if relay.hello?.waited == true { relay.send(Self.dispatched("appUp", ["v": LinkProtocol.version, "at": SocketLink.at()])) }
            return
        }
        guard let hello = relay.hello, let body = message["msg"] as? JSONObject else { return }
        var reply: JSONObject = ["ok": true, "appOpen": true, "launching": false, "browser": hello.browser]
        if hello.pid > 0 { reply["pid"] = Int(hello.pid) }
        switch body["type"] as? String {
        case "log":
            if let line = body["line"] as? String { Diagnostics.note("\(hello.browser): \(String(line.prefix(300)))") }
            relay.send(reply)
        case "wantLink":
            relay.send(reply)
            guard let nonce = body["nonce"] as? String, (1...128).contains(nonce.count) else { return Diagnostics.warn("relay: wantLink without a nonce") }
            link?.wantLink(nonce: nonce, via: RelayDispatch(hub: self, pid: hello.pid, browser: hello.browser))
        default:
            relay.send(reply) // a ping (the lasting port), or anything else: answered as Safari's handler does
        }
    }

    fileprivate func gone(_ relay: RelayConnection) {
        relays[ObjectIdentifier(relay)] = nil
    }

    // A dispatch as Safari's arrives on the copy's port: { name, userInfo: { e: <JSON string> } }.
    static func dispatched(_ name: String, _ info: JSONObject) -> JSONObject {
        ["name": name, "userInfo": ["e": jsonString(info) ?? "{}"]]
    }

    // Into every relay of one browser process (its copies' lasting ports among them). False if there was none.
    fileprivate func dispatch(_ name: String, _ info: JSONObject, pid: pid_t) -> Bool {
        let message = Self.dispatched(name, info)
        var sent = false
        for relay in relays.values where relay.hello != nil && (pid <= 0 || relay.hello?.pid == pid) {
            relay.send(message)
            sent = true
        }
        return sent
    }
}

// What SocketLink answers a relay's wantLink through: that browser process's relays.
struct RelayDispatch: ExtensionDispatch {
    weak var hub: RelayHub?
    let pid: pid_t
    let browser: String

    func dispatch(_ name: String, _ info: JSONObject, done: @escaping @MainActor (String?) -> Void) {
        guard let hub else { return done("the relay listener is gone") }
        done(hub.dispatch(name, info, pid: pid) ? nil : "no relay of \(browser) (pid \(pid))")
    }

    var name: String { browser == "edge" ? "Edge" : "Chrome" }
}

// One relay: lines of JSON over its socket.
final class RelayConnection {
    struct Hello {
        let browser: String
        let pid: pid_t
        let version: String
        let waited: Bool
    }

    let fd: Int32
    let peer: RelayHub.Peer
    var hello: Hello?
    private weak var hub: RelayHub?
    private var readSource: DispatchSourceRead?
    private var writeSource: DispatchSourceWrite?
    private var inbox = Data()
    private var outbox = Data()
    private var closed = false
    // At most this much of a line not yet ended (Chrome's own cap on a message to a host is 64 MB; a relay sends
    // the copy's small messages only).
    static let maxLine = 1 << 20

    init(fd: Int32, peer: RelayHub.Peer, hub: RelayHub) {
        self.fd = fd
        self.peer = peer
        self.hub = hub
    }

    func start() {
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.readable() } }
        source.resume()
        readSource = source
    }

    private func readable() {
        var buffer = [UInt8](repeating: 0, count: 65536)
        while !closed {
            let n = read(fd, &buffer, buffer.count)
            if n > 0 {
                inbox.append(buffer, count: n)
                lines()
                continue
            }
            if n < 0, errno == EAGAIN || errno == EINTR { return }
            return close() // ended (0), or failed
        }
    }

    private func lines() {
        while let end = inbox.firstIndex(of: 0x0A) {
            let line = inbox[inbox.startIndex..<end]
            inbox = Data(inbox[inbox.index(after: end)...])
            guard !line.isEmpty else { continue }
            guard let message = (try? JSONSerialization.jsonObject(with: line)) as? JSONObject else {
                Diagnostics.warn("relay: not a JSON line: closed")
                return close()
            }
            hub?.said(self, message)
            if closed { return }
        }
        if inbox.count > Self.maxLine {
            Diagnostics.warn("relay: a line over \(Self.maxLine) bytes: closed")
            close()
        }
    }

    func send(_ message: JSONObject) {
        guard !closed, let text = jsonString(message) else { return }
        outbox.append(contentsOf: Array(text.utf8))
        outbox.append(0x0A)
        flush()
    }

    private func flush() {
        while !outbox.isEmpty, !closed {
            let n = outbox.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            if n > 0 {
                outbox.removeFirst(n)
                continue
            }
            if n < 0, errno == EAGAIN || errno == EINTR {
                // Full: written once it can take more.
                guard writeSource == nil else { return }
                let source = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: .main)
                source.setEventHandler { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        self.writeSource?.cancel()
                        self.writeSource = nil
                        self.flush()
                    }
                }
                source.resume()
                writeSource = source
                return
            }
            return close()
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        readSource?.cancel()
        writeSource?.cancel()
        readSource = nil
        writeSource = nil
        Darwin.close(fd)
        hub?.gone(self)
    }
}
