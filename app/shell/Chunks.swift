// Something too big for one link message (a theme package, PLAN.md §14),
// sent in pieces and put back together (app/PROTOCOL.md "Chunks"). The
// whole is UTF-8 JSON; it's cut into pieces of at most chunkBytes, each sent
// as base64 with the whole's size and SHA-256 (`transfer`), so pieces of two
// sends never mix and a whole that came wrong is never used.

import CryptoKit
import Foundation

enum Chunks {
    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    // The pieces of `whole` for `id` (nil if it's bigger than `limit`).
    static func split(_ whole: Data, id: String, size: Int = LinkProtocol.chunkBytes, limit: Int = LinkProtocol.maxThemeBytes) -> [Chunk]? {
        guard whole.count <= limit, size > 0 else { return nil }
        let transfer = sha256(whole)
        let parts = max(1, (whole.count + size - 1) / size)
        guard parts <= 64 else { return nil }
        return (0..<parts).map { i in
            let start = whole.startIndex + i * size
            let piece = whole[start..<min(whole.endIndex, start + size)]
            return Chunk(id: id, transfer: transfer, part: i, parts: parts, size: whole.count, data: Data(piece).base64EncodedString())
        }
    }
}

// Pieces as they come, one whole at a time: a piece of another transfer
// starts over (the older whole is dropped: something newer is on its way).
struct ChunkAssembler {
    enum Outcome: Equatable {
        case waiting(have: Int, of: Int)
        case complete(id: String, data: Data)
        // Not taken: the reason (a bad piece, too big, the whole didn't add up).
        case refused(String)
    }

    let limit: Int
    private var transfer: String?
    private var id = ""
    private var size = 0
    private var parts: [Data?] = []

    init(limit: Int = LinkProtocol.maxThemeBytes) { self.limit = limit }

    var inProgress: Bool { transfer != nil }

    mutating func reset() {
        transfer = nil
        parts = []
    }

    mutating func add(_ chunk: Chunk) -> Outcome {
        guard chunk.size <= limit else { reset(); return .refused("\(chunk.size) bytes is over the limit of \(limit)") }
        if chunk.transfer != transfer || chunk.parts != parts.count || chunk.size != size || chunk.id != id {
            transfer = chunk.transfer
            id = chunk.id
            size = chunk.size
            parts = Array(repeating: nil, count: chunk.parts)
        }
        guard let piece = Data(base64Encoded: chunk.data) else { reset(); return .refused("part \(chunk.part) isn't base64") }
        parts[chunk.part] = piece
        let have = parts.filter { $0 != nil }.count
        guard have == parts.count else { return .waiting(have: have, of: parts.count) }
        let whole = parts.reduce(into: Data()) { $0.append($1!) }
        let expected = transfer
        reset()
        guard whole.count == size else { return .refused("\(whole.count) bytes came, \(size) were said") }
        guard Chunks.sha256(whole) == expected else { return .refused("the pieces don't add up (SHA-256)") }
        return .complete(id: chunk.id, data: whole)
    }
}
