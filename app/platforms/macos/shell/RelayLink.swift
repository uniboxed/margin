// Chrome's and Edge's way to Margin.app (docs/PROTOCOL.md "Transport (Chrome and Edge, on the Mac)"): their copies
// can't hear SFSafariApplication.dispatchMessage, so the browser starts Margin's connector
// (Margin.app/Contents/Helpers/margin-connector, app/shared/connector/) through native messaging, and the connector
// connects here, a Unix socket only this user can open. What a relay says, and what it's answered, is margin-core's
// (app/shared/core/src/relay.rs, joined to the link in link_hub.rs: the relay's hello and `relayWelcome`, each
// message answered as Safari's extension handler answers, a `wantLink`'s `link` into every relay of that browser's
// process, `appUp` to a relay that had to wait for the app). This file is the Mac's transport only: the socket, who
// may connect to it (this user's processes; in a signed build Margin's own relay: relaySignedByUs), each relay's bytes
// passed to the link's core and the core's lines written back, and the connector's host files. The link itself is the
// same WebSocket as Safari's (ExtensionLink.swift).

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
    // The app's version, as the relays' welcome says it (a relay of another version exits).
    let version: String
    private weak var link: SocketLink?
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var relays: [UInt64: RelayConnection] = [:]
    private var nextId: UInt64 = 1

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

    // Whether a relay's hello has named this browser process since the app started (gone relays' too): a copy's hello
    // names its process as its relay told it, so one that matches none is worth a word in the log (Shell.unheardPid).
    func heardPid(_ pid: pid_t) -> Bool { link?.heardPid(pid) ?? false }

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
            let relay = RelayConnection(id: nextId, fd: fd, peer: peer, hub: self)
            nextId += 1
            relays[relay.id] = relay
            link?.relayOpened(relay.id)
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
        let text = "identifier \"com.unibox.margin.connector\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
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

    // ---- a relay's bytes, to the link's core and back ----

    fileprivate func read(_ relay: RelayConnection, _ data: Data) {
        link?.relayBytes(relay.id, data)
    }

    fileprivate func gone(_ relay: RelayConnection) {
        guard relays.removeValue(forKey: relay.id) != nil else { return }
        link?.relayEnded(relay.id)
    }

    // The core's lines to a relay, and its close.
    func write(_ id: UInt64, _ data: Data) { relays[id]?.send(data) }
    func end(_ id: UInt64) { relays[id]?.close() }
}

// One relay's socket: its bytes as they come, what the core writes back.
final class RelayConnection {
    let id: UInt64
    let fd: Int32
    let peer: RelayHub.Peer
    private weak var hub: RelayHub?
    private var readSource: DispatchSourceRead?
    private var writeSource: DispatchSourceWrite?
    private var outbox = Data()
    private var closed = false

    init(id: UInt64, fd: Int32, peer: RelayHub.Peer, hub: RelayHub) {
        self.id = id
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
                hub?.read(self, Data(buffer[0..<n]))
                continue
            }
            if n < 0, errno == EAGAIN || errno == EINTR { return }
            return close() // ended (0), or failed
        }
    }

    func send(_ data: Data) {
        guard !closed else { return }
        outbox.append(data)
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
