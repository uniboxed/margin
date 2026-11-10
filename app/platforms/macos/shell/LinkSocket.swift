// The WebSocket protocol (RFC 6455) on Margin.app's end of the link, done by
// hand on a plain TCP connection (ExtensionLink.swift): Network.framework's
// own WebSocket server doesn't let the app see the request's path, where the
// background puts its token (ws://127.0.0.1:<port>/?t=<token>), so it couldn't
// turn a socket away before it opens. Only what the background's WebSocket
// uses: text, ping, pong and close, no extensions (permessage-deflate offered
// is simply not taken). From feat/native-panel, unchanged but for this note
// (docs/PROTOCOL.md describes the messages on it).

import CryptoKit
import Foundation

enum Handshake {
    struct Request {
        let path: String
        let query: [String: String]
        // Lower-case names.
        let headers: [String: String]
    }

    enum Parsed {
        case incomplete
        case bad
        // `rest`: what came after the request (frames already sent).
        case request(Request, rest: Data)
    }

    static let maxBytes = 16 * 1024

    static func parse(_ data: Data) -> Parsed {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return data.count > maxBytes ? .bad : .incomplete }
        guard let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8) else { return .bad }
        var lines = head.components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ")
        guard first.count == 3, first[0] == "GET", first[2].hasPrefix("HTTP/1.1") else { return .bad }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { return .bad }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let target = URLComponents(string: String(first[1]))
        var query: [String: String] = [:]
        for item in target?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return .request(Request(path: target?.path ?? "", query: query, headers: headers), rest: Data(data[end.upperBound...]))
    }

    // Whether it asks for a WebSocket at all (what it asks of the app is ExtensionLink's to judge).
    static func isUpgrade(_ request: Request) -> Bool {
        request.headers["upgrade"]?.lowercased() == "websocket"
            && request.headers["connection"]?.lowercased().contains("upgrade") == true
            && request.headers["sec-websocket-version"] == "13"
            && request.headers["sec-websocket-key"]?.isEmpty == false
    }

    static func accept(key: String) -> String {
        Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
    }

    static func switching(key: String) -> Data {
        Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept(key: key))\r\n\r\n".utf8)
    }

    static func refusal(_ status: String = "403 Forbidden") -> Data {
        Data("HTTP/1.1 \(status)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
    }
}

// Two secrets compared in the same time whatever they hold.
func sameSecret(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8)
    let y = Array(b.utf8)
    var differ = UInt8(x.count == y.count ? 0 : 1)
    for i in 0..<max(x.count, y.count) { differ |= (i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0) }
    return differ == 0
}

struct Frame: Equatable {
    enum Op: UInt8 {
        case continuation = 0, text = 1, binary = 2, close = 8, ping = 9, pong = 10
    }

    let op: Op
    let fin: Bool
    let payload: Data

    // The app's frames: never masked (only a client's are).
    static func encode(_ op: Op, _ payload: Data = Data()) -> Data {
        var out = Data([0x80 | op.rawValue])
        switch payload.count {
        case ..<126: out.append(UInt8(payload.count))
        case ..<65536: out.append(126); out.append(contentsOf: [UInt8(payload.count >> 8), UInt8(payload.count & 0xff)])
        default:
            out.append(127)
            for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8((payload.count >> shift) & 0xff)) }
        }
        out.append(payload)
        return out
    }

    static func close(_ code: UInt16, _ why: String = "") -> Data {
        encode(.close, Data([UInt8(code >> 8), UInt8(code & 0xff)]) + Data(why.utf8.prefix(120)))
    }
}

// Frames from the background, as its bytes come; then whole messages.
struct FrameReader {
    enum Failure: Error, Equatable {
        case unmasked, reserved, badOp, tooBig, badText, badClose
    }

    // The largest message taken (the first snapshot holds every site icon).
    static let maxMessage = 64 * 1024 * 1024

    private var buffer = [UInt8]()
    private var start = 0
    private var parts = Data()
    private var inMessage = false
    private var binary = false

    mutating func append(_ data: Data) {
        if start > 0 && start == buffer.count {
            buffer.removeAll(keepingCapacity: true)
            start = 0
        } else if start > 65536 && start * 2 > buffer.count {
            buffer.removeFirst(start)
            start = 0
        }
        buffer.append(contentsOf: data)
    }

    // The next frame, or nil until it has all come.
    mutating func next() throws -> Frame? {
        let available = buffer.count - start
        guard available >= 2 else { return nil }
        let b0 = buffer[start]
        let b1 = buffer[start + 1]
        guard b0 & 0x70 == 0 else { throw Failure.reserved }
        guard let op = Frame.Op(rawValue: b0 & 0x0f) else { throw Failure.badOp }
        guard b1 & 0x80 != 0 else { throw Failure.unmasked }
        var at = start + 2
        var length = Int(b1 & 0x7f)
        if length == 126 {
            guard available >= 4 else { return nil }
            length = Int(buffer[at]) << 8 | Int(buffer[at + 1])
            at += 2
        } else if length == 127 {
            guard available >= 10 else { return nil }
            var n: UInt64 = 0
            for i in 0..<8 { n = n << 8 | UInt64(buffer[at + i]) }
            guard n <= UInt64(Self.maxMessage) else { throw Failure.tooBig }
            length = Int(n)
            at += 8
        }
        guard length <= Self.maxMessage else { throw Failure.tooBig }
        guard buffer.count - at >= 4 + length else { return nil }
        let mask = Array(buffer[at..<at + 4])
        at += 4
        var payload = [UInt8](repeating: 0, count: length)
        for i in 0..<length { payload[i] = buffer[at + i] ^ mask[i & 3] }
        start = at + length
        return Frame(op: op, fin: b0 & 0x80 != 0, payload: Data(payload))
    }

    enum Message: Equatable {
        case text(String)
        case ping(Data)
        // The close frame's code (1005 when it carried none) and its reason (UTF-8, at most 123 bytes).
        case close(code: UInt16, reason: String)
        // A pong, a binary message: nothing to do.
        case none
    }

    // The next whole message (text put together from its frames), or nil until it has come.
    mutating func nextMessage() throws -> Message? {
        while let frame = try next() {
            switch frame.op {
            case .ping: return .ping(frame.payload)
            case .close: return try Self.close(frame.payload)
            case .pong: return Message.none
            case .text, .binary, .continuation:
                if frame.op == .continuation {
                    guard inMessage else { throw Failure.badOp }
                } else {
                    guard !inMessage else { throw Failure.badOp }
                    inMessage = true
                    parts = Data()
                    binary = frame.op == .binary
                }
                guard parts.count + frame.payload.count <= Self.maxMessage else { throw Failure.tooBig }
                parts.append(frame.payload)
                guard frame.fin else { continue }
                inMessage = false
                if binary { return Message.none }
                guard let text = String(data: parts, encoding: .utf8) else { throw Failure.badText }
                return .text(text)
            }
        }
        return nil
    }

    // A close frame's payload (RFC 6455 5.5.1): empty, no status code (1005); else two bytes of
    // code, then the reason. The reason is clipped to 123 bytes (a control frame's most) and taken
    // only as UTF-8; control characters become spaces, for the log.
    static func close(_ payload: Data) throws -> Message {
        let bytes = [UInt8](payload)
        guard !bytes.isEmpty else { return .close(code: 1005, reason: "") }
        guard bytes.count >= 2 else { throw Failure.badClose }
        let code = UInt16(bytes[0]) << 8 | UInt16(bytes[1])
        let raw = Array(bytes.dropFirst(2).prefix(123))
        // (Clipped in the middle of a character: up to 3 bytes less.)
        let cuts = raw.count < bytes.count - 2 ? 0...min(3, raw.count) : 0...0
        guard let text = cuts.lazy.compactMap({ String(bytes: raw.dropLast($0), encoding: .utf8) }).first else {
            return .close(code: code, reason: "(a reason that isn't UTF-8)")
        }
        return .close(code: code, reason: String(text.unicodeScalars.map { $0.properties.generalCategory == .control ? " " : Character($0) }))
    }

    // How a close reads in the log: "1000 no word from the app for 12 s", "1001 going away",
    // "1005, no status code", "1006, no close frame".
    static func describeClose(_ code: UInt16, _ reason: String) -> String {
        if !reason.isEmpty { return "\(code) \(reason)" }
        switch code {
        case 1000: return "1000 normal"
        case 1001: return "1001 going away"
        case 1002: return "1002 protocol error"
        case 1005: return "1005, no status code"
        case 1006: return "1006, no close frame"
        case 1008: return "1008 policy"
        case 1011: return "1011 unexpected condition"
        default: return "\(code)"
        }
    }
}
