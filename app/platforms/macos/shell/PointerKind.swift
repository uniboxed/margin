// Which device a gesture over Margin's window comes from (M2.9 step 6, docs/SPACE-BACKGROUNDS.md Part B §6), for Edit
// Theme Color's ticks: a haptic where the person's finger is on a trackpad that plays them, a short sound otherwise.
// The page decides (ui/picker/feedback.ts); this tells it, with each gesture's start (`pointerKind`, pushed by
// MarginWindowController.tellPointer: a push before the page's hello is lost, so each press tells it again).
// - A mouse unless proven a trackpad: a press whose subtype is a touch (a trackpad's), a pressure event (only a Force
//   Touch trackpad sends them, between its press and release), or a scroll with precise deltas and a phase (fingers on
//   a trackpad, or their momentum). A press that isn't a touch, or a wheel's notch (no precise deltas, no phase), is a
//   mouse's. A precise scroll with no phase (a Magic Mouse may send them) says nothing.
// - Whether a trackpad that plays haptics is there at all: the IORegistry's multitouch devices with
//   `ActuationSupported` (read again at most every 10 s: a Magic Trackpad comes and goes). None: always sound.
// - Whether the system plays its interface sounds (System Settings › Sound › "Play user interface sound effects",
//   `com.apple.sound.uiaudio.enabled`): off, no sound either.
// Which evidence tells tap-to-click apart is the spike's (docs/SPACE-BACKGROUNDS.md step 0's event logger); a wrong
// answer lands on sound, and the setting (`pickerFeedback`) overrides it.

import AppKit
import IOKit

enum PointerKind: String { case trackpad, mouse }

/// What an event says of its device, read once (the classifier is pure over these: the tests make them from events).
struct PointerFacts: Equatable {
    enum Kind: Equatable { case press, pressure, scroll }
    var kind: Kind
    /// A press: its subtype is a touch (a trackpad's).
    var touch = false
    /// A scroll: precise deltas.
    var precise = false
    /// A scroll: a phase (the fingers', or their momentum's).
    var phased = false
    /// A scroll: its gesture starting (began, may begin).
    var began = false

    init(kind: Kind, touch: Bool = false, precise: Bool = false, phased: Bool = false, began: Bool = false) {
        (self.kind, self.touch, self.precise, self.phased, self.began) = (kind, touch, precise, phased, began)
    }

    /// An event's facts; nil for an event that says nothing of its device. (`subtype` is read only for a mouse event:
    /// AppKit raises for others.)
    init?(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            self.init(kind: .press, touch: event.subtype == .touch)
        case .pressure:
            self.init(kind: .pressure)
        case .scrollWheel:
            let phase = event.phase, momentum = event.momentumPhase
            self.init(kind: .scroll, precise: event.hasPreciseScrollingDeltas, phased: !phase.isEmpty || !momentum.isEmpty,
                      began: phase.contains(.began) || phase.contains(.mayBegin))
        default:
            return nil
        }
    }
}

final class PointerClassifier {
    private(set) var kind: PointerKind = .mouse

    /// The gesture's device as an event leaves it: what to tell the page (nil: nothing new). A press always tells (a
    /// new gesture), a scroll's start too; the rest only a change.
    func see(_ f: PointerFacts) -> PointerKind? {
        let was = kind
        switch f.kind {
        case .press:
            kind = f.touch ? .trackpad : .mouse
            return kind
        case .pressure:
            kind = .trackpad
        case .scroll:
            if f.precise && f.phased {
                kind = .trackpad
                if f.began { return kind }
            } else if !f.precise && !f.phased {
                kind = .mouse
            }
        }
        return kind == was ? nil : kind
    }

    // ---- what the Mac has ----

    private static var actuators: (at: Date, has: Bool)?
    /// A trackpad that plays haptics is connected (the IORegistry's `AppleMultitouchDevice`s, `ActuationSupported`),
    /// read again at most every 10 s.
    static func hapticTrackpad(now: Date = Date()) -> Bool {
        if let a = actuators, now.timeIntervalSince(a.at) < 10 { return a.has }
        let has = readActuators()
        actuators = (now, has)
        return has
    }
    static func readActuators() -> Bool {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleMultitouchDevice"), &iterator) == KERN_SUCCESS else { return false }
        defer { IOObjectRelease(iterator) }
        var found = false
        var service = IOIteratorNext(iterator)
        while service != 0 {
            if !found, let v = IORegistryEntryCreateCFProperty(service, "ActuationSupported" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() {
                found = (v as? NSNumber)?.boolValue == true
            }
            IOObjectRelease(service)
            service = IOIteratorNext(iterator)
        }
        return found
    }

    /// The system plays its interface sounds (absent: it does, macOS's default).
    static func interfaceSounds(_ defaults: UserDefaults = .standard) -> Bool {
        guard let v = defaults.object(forKey: "com.apple.sound.uiaudio.enabled") else { return true }
        return (v as? NSNumber)?.boolValue ?? (v as? Bool) ?? true
    }

    /// What the page is told: `{ type: "pointerKind", kind, haptics, uiSounds }`.
    static func message(_ kind: PointerKind, haptics: Bool, uiSounds: Bool) -> String {
        #"{"type":"pointerKind","kind":"\#(kind.rawValue)","haptics":\#(haptics),"uiSounds":\#(uiSounds)}"#
    }
}
