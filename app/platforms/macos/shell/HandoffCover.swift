import Foundation

enum LiveCoverPolicy {
    // Explicit NO remains the diagnostic opt-out; normal launches prefer live.
    static func requested(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: "MarginLiveProfileCover") as? Bool ?? true
    }
}

struct LiveCoverContext {
    var hello: String
    var display: CGRect // AppKit coordinates
    var viewport: CGRect // relative to cover; matches the existing layout
}

enum LiveCoverState: Equatable {
    case idle, preparing, prepared, showing, shown
    case failed(String)
}

protocol HandoffCover: AnyObject {
    var state: LiveCoverState { get }
    var windowNumbers: Set<Int> { get }
    var onEmergency: (() -> Void)? { get set }
    func prepare(_ context: LiveCoverContext)
    func activate(_ done: @escaping (Bool) -> Void)
    func recovering()
    @discardableResult func end(_ why: RevealWhy) -> Bool
}
