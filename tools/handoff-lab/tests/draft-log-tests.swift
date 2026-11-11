import Foundation

@main enum DraftLogTests {
    static func main() {
        var count = 0
        func check(_ ok: Bool) { count += 1; if !ok { print("draft log check \(count) failed"); exit(1) } }
        let nonce = UUID().uuidString
        let line = "dev hook: drafts observed: nonce \(nonce), window 10, native 100, pid 20, caller 30, elapsed 45 ms, tabs [1, 2], drafts 0 [], unknown 0 []"
        let clear = DraftObservation.parse(line)
        check(clear?.clear == true && clear?.tabs == [1, 2] && clear?.nonce == UUID(uuidString: nonce))
        let unknown = DraftObservation.parse(line.replacingOccurrences(of: "unknown 0 []", with: "unknown 1 [2]"))
        check(unknown?.clear == false && unknown?.unknown == [2])
        check(unknown.map { $0.sameSource(as: clear!) } == true)
        let draft = DraftObservation.parse(line.replacingOccurrences(of: "drafts 0 []", with: "drafts 1 [1]"))
        check(draft?.clear == false)
        for (from, to) in [("window 10", "window 0"), ("native 100", "native 0"), ("pid 20", "pid 0"),
                           ("caller 30", "caller 0"), (nonce, "not-a-uuid"), ("unknown 0 []", "unknown 0 [2]"),
                           ("drafts 0 []", "drafts 1 [99]"), ("tabs [1, 2]", "tabs [2, 1]"),
                           ("tabs [1, 2]", "tabs [1, 1]"), ("tabs [1, 2]", "tabs []"),
                           ("drafts observed:", "drafts requested:"), ("unknown 0 []", "unknown 1 [true]")] {
            check(DraftObservation.parse(line.replacingOccurrences(of: from, with: to)) == nil)
        }
        check(DraftObservation.parse("dev hook: dump: " + line) == nil)
        check(DraftObservation.parse(line + " extra") == nil)
        let other = DraftObservation.parse(line.replacingOccurrences(of: "native 100", with: "native 101"))
        check(other.map { !$0.sameSource(as: clear!) } == true)
        let newNonce = DraftObservation.parse(line.replacingOccurrences(of: nonce, with: UUID().uuidString))
        check(newNonce.map { $0.sameSource(as: clear!) } == true)
        print("all \(count) drafts parser checks passed; no app/window/private call")
    }
}
