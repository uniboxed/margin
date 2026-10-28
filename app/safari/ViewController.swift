// Margin's app: a set-up window that walks through what Safari needs for
// Margin, checking each step where it can. It sees itself whether Margin is
// on in Safari (SFSafariExtensionManager); the rest only the extension can see
// (background/onboarding.js → SafariWebExtensionHandler.swift → a distributed
// notification here): whether Margin may run on every website, whether ⌘T
// reaches Margin, whether new tabs and windows open Margin's page. Safari only
// for now; Chrome and Edge come later.
// Copied into the generated Xcode project by scripts/make-xcode.sh (the
// converter's storyboard window shows this view controller).

import Cocoa
import Combine
import SafariServices
import SwiftUI
import WebKit

let extensionBundleIdentifier = "io.tirth.margin.Extension"
let setupNotification = Notification.Name("io.tirth.margin.setup")

class ViewController: NSViewController {

    // The converter's storyboard connects this outlet; the window is SwiftUI now.
    @IBOutlet var webView: WKWebView!

    private let model = SetupModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.removeFromSuperview()
        let host = NSHostingView(rootView: SetupView(model: model))
        host.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.topAnchor.constraint(equalTo: view.topAnchor),
            host.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        model.start()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        guard let window = view.window else { return }
        window.title = "Set up Margin"
        window.styleMask.insert(.resizable)
        window.minSize = NSSize(width: 640, height: 520)
        window.setContentSize(NSSize(width: 760, height: 780))
        window.center()
    }
}

// MARK: - What's done

enum Step: String, CaseIterable, Identifiable {
    case turnOn, allSites, newTabs, commandT, restore, tidy, shortcuts
    var id: String { rawValue }
}

enum StepState: Equatable {
    case done, todo, unknown, optional
}

// A check that asks the user to do something in Safari, and waits for the
// extension to say what happened.
struct SetupTest: Equatable {
    let step: Step
    let since: Date
    var result: Result?
    enum Result: Equatable { case passed, failed(String) }
}

@MainActor
final class SetupModel: ObservableObject {
    @Published var extensionOn: Bool?
    @Published var allSites: Bool?
    @Published var events: [String: Date] = [:]
    @Published var manual: Set<String> = []
    @Published var test: SetupTest?

    private let defaults = UserDefaults.standard
    private var poll: Timer?
    private var testTimer: Timer?

    init() {
        if defaults.object(forKey: "setup.allSites") != nil { allSites = defaults.bool(forKey: "setup.allSites") }
        for (name, at) in (defaults.dictionary(forKey: "setup.events") as? [String: Double]) ?? [:] {
            events[name] = Date(timeIntervalSince1970: at)
        }
        manual = Set(defaults.stringArray(forKey: "setup.manual") ?? [])
    }

    func start() {
        refreshExtensionState()
        poll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshExtensionState() }
        }
        DistributedNotificationCenter.default().addObserver(forName: setupNotification, object: nil, queue: .main) { [weak self] note in
            let json = note.object as? String
            Task { @MainActor in self?.receive(json) }
        }
    }

    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { [weak self] state, _ in
            let on = state?.isEnabled
            Task { @MainActor in self?.extensionOn = on }
        }
    }

    // A status or an event from the extension (SafariWebExtensionHandler.swift).
    func receive(_ json: String?) {
        guard let data = json?.data(using: .utf8),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = body["type"] as? String else { return }
        if type == "status", let all = body["allSites"] as? Bool {
            allSites = all
            defaults.set(all, forKey: "setup.allSites")
        } else if type == "event", let name = body["name"] as? String {
            events[name] = Date()
            defaults.set(events.mapValues { $0.timeIntervalSince1970 }, forKey: "setup.events")
            judgeTest()
        }
    }

    // Did `good` happen after `bad` (both events), the latest saying how it is.
    private func latest(_ good: String, over bad: String) -> Bool {
        guard let g = events[good] else { return false }
        guard let b = events[bad] else { return true }
        return g > b
    }

    func state(_ step: Step) -> StepState {
        switch step {
        case .turnOn: return extensionOn == nil ? .unknown : (extensionOn! ? .done : .todo)
        case .allSites: return allSites == true ? .done : (allSites == nil ? .unknown : .todo)
        case .newTabs: return latest("marginNewTabPage", over: "otherNewTabPage") ? .done : .todo
        case .commandT: return latest("cmdTKey", over: "safariNewTab") ? .done : .todo
        case .restore, .tidy: return manual.contains(step.rawValue) ? .done : .optional
        case .shortcuts: return .optional
        }
    }

    var required: [Step] { [.turnOn, .allSites, .newTabs, .commandT] }
    var doneCount: Int { required.filter { state($0) == .done }.count }

    func toggleManual(_ step: Step) {
        if manual.contains(step.rawValue) { manual.remove(step.rawValue) } else { manual.insert(step.rawValue) }
        defaults.set(Array(manual), forKey: "setup.manual")
    }

    // MARK: Tests

    func startTest(_ step: Step) {
        test = SetupTest(step: step, since: Date())
        testTimer?.invalidate()
        testTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.timeOutTest() }
        }
        openSafari()
    }

    private func happened(_ name: String, since: Date) -> Bool { (events[name] ?? .distantPast) >= since }

    private func judgeTest() {
        guard var t = test, t.result == nil else { return }
        switch t.step {
        case .commandT:
            if happened("cmdTKey", since: t.since) { t.result = .passed }
            else if happened("safariNewTab", since: t.since) { t.result = .failed("Safari opened a new tab, so ⌘T still belongs to Safari's New Tab. Check the App Shortcut: Safari, menu title “New Tab” exactly, any other keys.") }
        case .newTabs:
            if happened("marginNewTabPage", since: t.since) { t.result = .passed }
            else if happened("otherNewTabPage", since: t.since) { t.result = .failed("Safari opened another page. In Safari Settings › General, set “New windows open with” and “New tabs open with” to Margin.") }
        default: break
        }
        test = t
    }

    private func timeOutTest() {
        guard var t = test, t.result == nil else { return }
        switch t.step {
        case .commandT: t.result = .failed("Nothing reached Margin. Press ⌘T on a web page in Safari (Margin needs to be on and allowed there), then try again.")
        case .newTabs: t.result = .failed("Margin's page didn't open. In Safari Settings › General, set “New windows open with” to Margin, then press ⌘N again.")
        default: break
        }
        test = t
    }

    // MARK: Actions

    func openExtensionSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
    }

    func openSafari() {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    func openKeyboardSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

// ⌥⌘ arrows are Safari's own (its tab switching, before any extension or
// page): with Karabiner-Elements, they become the ⌃⌘ arrows Margin uses.
let karabinerRule = """
{
  "description": "Safari: ⌥⌘ arrows as ⌃⌘ arrows (Margin's tabs and spaces)",
  "manipulators": [
    \(["down_arrow", "up_arrow", "left_arrow", "right_arrow"].map { key in
        "{ \"type\": \"basic\", \"from\": { \"key_code\": \"\(key)\", \"modifiers\": { \"mandatory\": [\"option\", \"command\"] } }, \"to\": [{ \"key_code\": \"\(key)\", \"modifiers\": [\"control\", \"command\"] }], \"conditions\": [{ \"type\": \"frontmost_application_if\", \"bundle_identifiers\": [\"^com\\\\.apple\\\\.Safari$\"] }] }"
    }.joined(separator: ",\n    "))
  ]
}
"""

// MARK: - The window

struct SetupView: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                ForEach(Step.allCases) { step in
                    StepCard(step: step, model: model)
                }
                footer
            }
            .padding(28)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 56, height: 56)
            VStack(alignment: .leading, spacing: 4) {
                Text("Set up Margin for Safari")
                    .font(.system(size: 22, weight: .semibold))
                Text("A few settings in Safari and macOS make Margin feel like its own browser. Steps with a check confirm themselves as you go.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            ProgressBadge(done: model.doneCount, total: model.required.count)
        }
        .padding(.bottom, 6)
    }

    private var footer: some View {
        HStack {
            Text("Chrome and Edge are coming later.")
                .foregroundStyle(.secondary)
            Spacer()
            Button("Open Safari") { model.openSafari() }
                .keyboardShortcut(.defaultAction)
                .controlSize(.large)
        }
        .padding(.top, 4)
    }
}

struct ProgressBadge: View {
    let done: Int
    let total: Int

    var body: some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.2), lineWidth: 5)
            Circle()
                .trim(from: 0, to: total == 0 ? 0 : CGFloat(done) / CGFloat(total))
                .stroke(done == total ? Color.green : Color.accentColor, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(done)/\(total)")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
        }
        .frame(width: 52, height: 52)
        .accessibilityLabel("\(done) of \(total) steps done")
    }
}

struct StepCard: View {
    let step: Step
    @ObservedObject var model: SetupModel
    @State private var expanded = false

    private var state: StepState { model.state(step) }
    private var open: Bool { expanded || state == .todo || state == .unknown }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            StatusIcon(state: state)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.headline)
                    if state == .optional || step == .restore || step == .tidy {
                        Text(step == .shortcuts ? "Reference" : "Recommended")
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.secondary.opacity(0.15)))
                    }
                    Spacer()
                    if !(state == .todo || state == .unknown) {
                        Button(open ? "Hide" : "Show") { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } }
                            .buttonStyle(.link)
                    }
                }
                Text(summary)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if open {
                    details
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.08)))
    }

    private var title: String {
        switch step {
        case .turnOn: return "Turn on Margin in Safari"
        case .allSites: return "Let Margin work on every website"
        case .newTabs: return "Open Margin for new windows and tabs"
        case .commandT: return "Make ⌘T open Margin's palette"
        case .restore: return "Keep your tabs when Safari restarts"
        case .tidy: return "Tidy up Safari's own interface"
        case .shortcuts: return "Margin's keyboard shortcuts"
        }
    }

    private var summary: String {
        switch (step, state) {
        case (.turnOn, .done): return "Margin is on."
        case (.turnOn, _): return "Safari keeps new extensions off until you turn them on."
        case (.allSites, .done): return "Margin can show its sidebar on every website."
        case (.allSites, _): return "Without this, Safari asks site by site, and Margin's sidebar is missing where it hasn't been allowed."
        case (.newTabs, .done): return "New windows and tabs open Margin's page."
        case (.newTabs, _): return "So a new window starts in Margin, with its sidebar and palette."
        case (.commandT, .done): return "⌘T opens Margin's palette, with no new tab flashing first."
        case (.commandT, _): return "Safari keeps ⌘T for its own New Tab, which makes a tab before Margin can step in (a flicker). Giving Safari's New Tab another shortcut frees ⌘T for Margin."
        case (.restore, _): return "Margin keeps tabs in their spaces across restarts when Safari reopens them."
        case (.tidy, _): return "Margin's sidebar replaces Safari's tab bar and sidebar."
        case (.shortcuts, _): return "Most of Margin works from the keyboard."
        }
    }

    @ViewBuilder private var details: some View {
        switch step {
        case .turnOn:
            Instructions(lines: [
                "Click Open Safari Settings.",
                "In Extensions, tick Margin.",
            ])
            Button("Open Safari Settings") { model.openExtensionSettings() }
        case .allSites:
            Instructions(lines: [
                "In Safari Settings › Extensions, select Margin, then Edit Websites…",
                "Set “When visiting other websites” to Allow.",
                "If Safari asks on a site, choose Always Allow on Every Website.",
            ])
            HStack {
                Button("Open Safari Settings") { model.openExtensionSettings() }
                if model.allSites == nil {
                    Text("Margin reports this once Safari opens a page.").font(.callout).foregroundStyle(.secondary)
                }
            }
        case .newTabs:
            Instructions(lines: [
                "Open Safari Settings › General.",
                "Set “New windows open with” to Margin.",
                "Set “New tabs open with” to Margin.",
            ])
            HStack {
                Button("Open Safari") { model.openSafari() }
                Button("Test: press ⌘N in Safari") { model.startTest(.newTabs) }
            }
            TestLine(test: model.test, step: step, waiting: "Waiting for a new window in Safari… press ⌘N.")
        case .commandT:
            Instructions(lines: [
                "Open System Settings › Keyboard, then Keyboard Shortcuts… › App Shortcuts.",
                "Click +. Application: Safari. Menu title: New Tab (exactly).",
                "Keyboard shortcut: something you won't press, like ⌃⌥⌘T. Click Done.",
            ])
            HStack {
                Button("Open Keyboard Settings") { model.openKeyboardSettings() }
                Button("Copy “New Tab”") { model.copy("New Tab") }
                Button("Test: press ⌘T in Safari") { model.startTest(.commandT) }
            }
            TestLine(test: model.test, step: step, waiting: "Waiting for ⌘T on a web page in Safari…")
        case .restore:
            Instructions(lines: [
                "Open Safari Settings › General.",
                "Set “Safari opens with” to All windows from last session.",
            ])
            HStack {
                Button("Open Safari") { model.openSafari() }
                Toggle("Done", isOn: Binding(get: { model.manual.contains(step.rawValue) }, set: { _ in model.toggleManual(step) }))
                    .toggleStyle(.checkbox)
            }
        case .tidy:
            Instructions(lines: [
                "Hide Safari's sidebar: View › Hide Sidebar (⇧⌘L).",
                "Use the compact tab bar: Safari Settings › Tabs › Tab layout: Compact.",
                "For the cleanest look, use Safari in full screen (⌃⌘F).",
            ])
            Toggle("Done", isOn: Binding(get: { model.manual.contains(step.rawValue) }, set: { _ in model.toggleManual(step) }))
                .toggleStyle(.checkbox)
        case .shortcuts:
            VStack(alignment: .leading, spacing: 6) {
                ShortcutRow(keys: "⌘T", action: "Command palette: open or search anything, as a new tab")
                ShortcutRow(keys: "⌃⌘↓  ⌃⌘↑", action: "Next / previous tab in the space")
                ShortcutRow(keys: "⌃⌘→  ⌃⌘←", action: "Next / previous space")
                ShortcutRow(keys: "⌥S", action: "Show or hide the sidebar")
                ShortcutRow(keys: "Two-finger swipe", action: "Sideways on the sidebar: switch spaces")
            }
            Text("⌥⌘ arrows belong to Safari (its own tab switching, before Margin can see them). To use them for Margin anyway, Karabiner-Elements can turn them into ⌃⌘ arrows while Safari is in front.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Copy Karabiner rule") { model.copy(karabinerRule) }
        }
    }
}

struct StatusIcon: View {
    let state: StepState

    var body: some View {
        Group {
            switch state {
            case .done:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case .todo:
                Image(systemName: "circle").foregroundStyle(Color.accentColor)
            case .unknown:
                Image(systemName: "questionmark.circle").foregroundStyle(.secondary)
            case .optional:
                Image(systemName: "circle.dashed").foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 22))
        .frame(width: 26)
        .accessibilityLabel(state == .done ? "Done" : state == .todo ? "To do" : state == .unknown ? "Not known yet" : "Optional")
    }
}

struct Instructions: View {
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(index + 1).").monospacedDigit().foregroundStyle(.secondary)
                    Text(line).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct TestLine: View {
    let test: SetupTest?
    let step: Step
    let waiting: String

    var body: some View {
        if let test, test.step == step {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                switch test.result {
                case .none:
                    ProgressView().controlSize(.small)
                    Text(waiting)
                case .passed:
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    Text("It works.")
                case .failed(let why):
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(why).fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(.callout)
        }
    }
}

struct ShortcutRow: View {
    let keys: String
    let action: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(keys)
                .font(.system(.body, design: .rounded).weight(.medium))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.14)))
                .frame(minWidth: 132, alignment: .leading)
            Text(action)
        }
    }
}
