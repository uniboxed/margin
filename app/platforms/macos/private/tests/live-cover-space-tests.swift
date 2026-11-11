import Foundation

nonisolated final class FakeCoverSpace: @unchecked Sendable {
    var calls: [String] = []
    var fail: String?
    var owner = true
    var memberships: [UInt64]? = [700]
    var absoluteLevel: Int32? = 400
    var laggedLevel = false
    func call(_ name: String) -> Bool { calls.append(name); if name == "destroy", fail != name { absoluteLevel = 0 }; return fail != name }
    var io: LiveCoverSpaceIO {
        LiveCoverSpaceIO(owns: { _ in self.owner }, create: { self.call("create") ? 700 : nil }, level: { _ in self.call("level") }, readLevel: { _ in self.absoluteLevel },
                         add: { _, _ in self.call("add") }, show: { _ in self.call("show") }, hide: { _ in self.call("hide") },
                         hideWindow: { _ in self.call("alpha") },
                         destroy: { _ in self.call("destroy") }, spaces: { _ in self.memberships })
    }
}

func liveCoverSpaceTests() {
    do {
        let f = FakeCoverSpace(); f.owner = false
        if case .failure(.ownership) = LiveCoverSpace.open(window: 12, io: f.io) {
            check("live cover: a foreign window is refused before any write", f.calls.isEmpty)
        } else { check("live cover: a foreign window is refused", false) }
    }
    for step in ["create", "level", "add", "show"] {
        let f = FakeCoverSpace(); f.fail = step
        let r = LiveCoverSpace.open(window: 12, io: f.io)
        if case .failure = r {
            check("live cover: failed \(step) cleans up exactly what it made", f.calls.filter { $0 == "destroy" }.count == (step == "create" ? 0 : 1))
        } else { check("live cover: failed \(step) refuses the cover", false) }
    }
    for answer: [UInt64]? in [nil, [], [700, 99], [99]] {
        let f = FakeCoverSpace(); f.memberships = answer
        if case .success(let lease) = LiveCoverSpace.open(window: 12, io: f.io) {
            check("live cover: unknown or wrong membership cannot make the panel ready", !lease.isReady)
            _ = lease.close()
            check("live cover: a refused membership destroys its temporary Space", f.calls.last == "destroy")
        } else { check("live cover: wrong membership awaits verification", false) }
    }
    do {
        let f = FakeCoverSpace()
        guard case .success(let lease) = LiveCoverSpace.open(window: 12, io: f.io) else { return check("live cover: valid setup opens", false) }
        check("live cover: checked own-window setup follows the demonstrated ordering", f.calls == ["create", "level", "show", "add"] && lease.isReady && !lease.isHidden)
        check("live cover: emergency hide retains the Space until its panel is ordered out", lease.hide() && lease.isHidden && !f.calls.contains("destroy"))
        check("live cover: emergency hide uses direct own-window alpha rather than the async Space bridge", f.calls.last == "alpha" && !f.calls.contains("hide"))
        check("live cover: close destroys once, including after an emergency hide", lease.close() && lease.close() && f.calls.filter { $0 == "hide" }.count == 1 && f.calls.filter { $0 == "destroy" }.count == 1)
    }
    for level: Int32? in [nil, 0, 399] {
        let f = FakeCoverSpace(); f.absoluteLevel = level
        if case .success(let lease) = LiveCoverSpace.open(window: 12, io: f.io) {
            check("live cover: wrong/unknown level cannot make the panel ready", !lease.isReady)
            _ = lease.close()
        }
    }
    do {
        let f = FakeCoverSpace()
        guard case .success(let lease) = LiveCoverSpace.open(window: 12, io: f.io) else { return }
        f.fail = "hide"
        check("live cover: hide retries once and destroy still runs on refusal", !lease.close() && f.calls.filter { $0 == "hide" }.count == 2 && f.calls.last == "destroy")
    }
    do {
        let f = FakeCoverSpace()
        guard case .success(let lease) = LiveCoverSpace.open(window: 12, io: f.io) else { return }
        f.fail = "destroy"
        check("live cover: failed destroy is not declared closed", !lease.close() && f.absoluteLevel == 400)
        f.fail = nil
        check("live cover: later cleanup can retry an unverified destruction", lease.close() && f.absoluteLevel == 0 && f.calls.filter { $0 == "destroy" }.count == 2)
        let count = f.calls.count
        check("live cover: only verified destruction is idempotent", lease.close() && f.calls.count == count)
    }
    do {
        let f = FakeCoverSpace(); f.laggedLevel = true
        var io = f.io; io.readLevel = { _ in f.laggedLevel ? 400 : 0 }
        guard case .success(let lease) = LiveCoverSpace.open(window: 12, io: io) else { return }
        check("live cover: sent destroy without independent verification remains retryable", !lease.close())
        f.laggedLevel = false
        check("live cover: eventual zero-level read verifies the retried cleanup", lease.close())
    }
    do {
        let f = FakeCoverSpace(); f.fail = "destroy"
        var io = f.io; io.level = { _ in false }
        let pending = CoverSpaceCleanup()
        if case .failure(.level) = LiveCoverSpace.open(window: 12, io: io, onFailedCleanup: { pending.retain($0) }) {
            check("live cover: failed setup retains an unverified own Space", pending.count == 1 && !pending.retry())
            f.fail = nil
            check("live cover: later owned cleanup verifies and releases failed-setup Space", pending.retry() && pending.count == 0 && f.absoluteLevel == 0)
        } else { check("live cover: setup refusal cannot conceal an orphan", false) }
    }
    for name in PrivateCalls.liveCoverFunctions {
        let r = FakePrivateResolver(); r.functions.remove(name)
        check("live cover: launch refuses missing \(name)", !PrivateCalls.evaluate(r).liveCover)
    }
}
