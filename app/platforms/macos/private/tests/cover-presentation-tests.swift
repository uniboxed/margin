import Foundation

func coverPresentationTests() {
    check("cover renderer: accepts only verified object/PID ABI", CoverRendererIO.accepts(get: "@16@0:8", set: "v24@0:8@16", pid: "i16@0:8")
          && !CoverRendererIO.accepts(get: nil, set: nil, pid: nil)
          && !CoverRendererIO.accepts(get: "@16@0:8", set: "B24@0:8@16", pid: "i16@0:8")
          && !CoverRendererIO.accepts(get: "@16@0:8", set: "v24@0:8@16", pid: "q16@0:8"))
    check("cover renderer: real SPI refuses under app tests", CoverRendererIO.real().reason == "app tests")
    var values: [ObjectIdentifier: Bool] = [:]
    var writes: [(ObjectIdentifier, Bool)] = []
    var refuses = false, unread = false, ignores = false
    let io = CoverPresentationIO(reason: nil, read: { unread ? nil : values[ObjectIdentifier($0)] ?? true }, write: { view, value in
        writes.append((ObjectIdentifier(view), value))
        guard !refuses else { return false }
        if !ignores { values[ObjectIdentifier(view)] = value }
        return true
    })
    let lease = CoverPresentation(io: io)
    let a = NSObject(), b = NSObject()
    values[ObjectIdentifier(b)] = false
    check("cover presentation: checked BOOL ABI only", CoverPresentationIO.accepts(get: "B16@0:8", set: "v20@0:8B16")
          && CoverPresentationIO.accepts(get: "c16@0:8", set: "v20@0:8c16")
          && !CoverPresentationIO.accepts(get: nil, set: nil) && !CoverPresentationIO.accepts(get: "q16@0:8", set: "v24@0:8q16")
          && !CoverPresentationIO.accepts(get: "B16@0:8", set: "v20@0:8c16"))
    check("cover presentation: holds only requested view and reads the write back", lease.hold(a)
          && values[ObjectIdentifier(a)] == false && writes.count == 1 && lease.count == 1)
    check("cover presentation: object identity makes repeated handover idempotent", lease.hold(a) && writes.count == 1 && lease.count == 1)
    check("cover presentation: preserves an already-disabled view without a write", lease.hold(b) && writes.count == 1 && lease.count == 2)
    check("cover presentation: restores each original value, no global reset", lease.restore() && values[ObjectIdentifier(a)] == true
          && values[ObjectIdentifier(b)] == false && lease.count == 0)
    let before = writes.count
    check("cover presentation: repeated cleanup has no work", lease.restore() && writes.count == before)
    _ = lease.hold(a)
    refuses = true
    check("cover presentation: failed restore retains the surviving view's original", !lease.restore() && lease.count == 1 && values[ObjectIdentifier(a)] == false)
    check("cover presentation: repeated failure cannot silently erase restoration", !lease.restore() && lease.count == 1)
    refuses = false
    check("cover presentation: later cleanup restores the retained original", lease.restore() && lease.count == 0 && values[ObjectIdentifier(a)] == true)
    let afterRetry = writes.count
    unread = true
    check("cover presentation: unknown getter refuses before a write", !lease.hold(a) && writes.count == afterRetry && lease.count == 0)
    unread = false; refuses = true
    check("cover presentation: refused setter does not claim protection", !lease.hold(a))
    refuses = false
    check("cover presentation: failed setup still restores all held originals", lease.restore() && lease.count == 0 && values[ObjectIdentifier(a)] == true)
    ignores = true
    check("cover presentation: ignored write refuses on readback", !lease.hold(a) && lease.count == 0)
    ignores = false
    weak var weakView: NSObject?
    do {
        let shortLived = NSObject(); weakView = shortLived
        check("cover presentation: short-lived view can be held", lease.hold(shortLived))
    }
    check("cover presentation: never retains a closed view", weakView == nil && lease.restore() && lease.count == 0)
    let off = CoverPresentation(io: .init(reason: "missing selector", read: { _ in true }, write: { _, _ in fatalError("off presentation wrote") }))
    check("cover presentation: launch failure refuses and cleanup stays safe", !off.hold(a) && off.restore())
    check("cover presentation: real SPI refuses under app tests", CoverPresentationIO.real().reason == "refused under app tests")
}
