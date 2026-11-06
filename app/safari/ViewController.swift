// Margin's app: a set-up window that walks through what Safari needs for
// Margin, checking each step where it can. It sees itself whether Margin is
// on in Safari (SFSafariExtensionManager); the rest only the extension can see
// (background/onboarding.js → SafariWebExtensionHandler.swift → a distributed
// notification here): whether Margin may run on every website, whether ⌘T
// reaches Margin, whether new tabs and windows open Margin's page. Itself
// again, by trying to read Safari's data: whether Margin has Full Disk Access,
// which shows Safari's own profile names (app/shell/SafariProfiles.swift) and
// iCloud Tabs (app/shell/CloudTabs.swift); without it nothing else changes. Safari only for now; Chrome and Edge come later.
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
    private var placed = false

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

    // Once: it appears again after the app is hidden and shown, where the
    // user may have moved or resized it.
    override func viewDidAppear() {
        super.viewDidAppear()
        guard !placed, let window = view.window else { return }
        placed = true
        window.title = "Set up Margin"
        window.styleMask.formUnion([.resizable, .miniaturizable])
        window.minSize = NSSize(width: 640, height: 520)
        var size = NSSize(width: 760, height: 780)
        if let visible = (window.screen ?? NSScreen.main)?.visibleFrame {
            size.width = min(size.width, visible.width - 40)
            size.height = min(size.height, visible.height - 60) // the title bar, and some room
        }
        window.setContentSize(size)
        window.center()
    }
}

// MARK: - What's done

enum Step: String, CaseIterable, Identifiable {
    case turnOn, allSites, newTabs, commandT, profileNames, restore, tidy, shortcuts
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

// What the app saw itself, kept with the extension's events (by when).
enum Seen {
    static let safariLaunched = "app.safariLaunched"
    static let marginOff = "app.marginOff"
    static func failed(_ check: String) -> String { "app.failed.\(check)" }
}

@MainActor
final class SetupModel: ObservableObject {
    @Published var extensionOn: Bool?
    @Published var allSites: Bool?
    @Published var events: [String: Date] = [:]
    @Published var manual: Set<String> = []
    @Published var test: SetupTest?
    @Published var diskAccess: SafariProfiles.Access?

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
        // On the main run loop and queue, both.
        poll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshExtensionState() }
        }
        DistributedNotificationCenter.default().addObserver(forName: setupNotification, object: nil, queue: .main) { [weak self] note in
            let json = note.object as? String
            MainActor.assumeIsolated { self?.receive(json) }
        }
    }

    // Margin on or off, and when Safari last opened: both can set Safari's
    // new windows and tabs back to its own page (DECISIONS.md, the unsigned
    // build), so what was seen before is checked again.
    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { [weak self] state, _ in
            let on = state?.isEnabled
            Task { @MainActor [weak self] in
                guard let self else { return }
                if on == false, self.extensionOn != false { self.note(Seen.marginOff, Date()) }
                self.extensionOn = on
            }
        }
        if let launched = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").compactMap(\.launchDate).max() {
            note(Seen.safariLaunched, launched)
        }
        // A read attempt on Safari's tab database: nothing is read.
        let access = SafariProfiles.access()
        if access != diskAccess { diskAccess = access }
    }

    // Something seen at `at` (kept if it's later than what was seen before).
    private func note(_ name: String, _ at: Date) {
        if let known = events[name], known >= at { return }
        events[name] = at
        defaults.set(events.mapValues { $0.timeIntervalSince1970 }, forKey: "setup.events")
    }

    // A status or an event from the extension (SafariWebExtensionHandler.swift).
    func receive(_ json: String?) {
        guard let data = json?.data(using: .utf8),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = body["type"] as? String else { return }
        if type == "status", let all = body["allSites"] as? Bool {
            allSites = all
            defaults.set(all, forKey: "setup.allSites")
        } else if type == "event", let name = body["name"] as? String, !name.hasPrefix("app.") {
            note(name, Date())
            judgeTest()
        }
    }

    // Did `name` happen after all of `others` (the latest saying how it is).
    private func seen(_ name: String, after others: [String]) -> Bool {
        guard let at = events[name] else { return false }
        return others.allSatisfy { (events[$0] ?? .distantPast) < at }
    }

    // Safari opened Margin's page for a new window / tab since it last
    // opened, Margin was last off, and nothing said otherwise. ⌘T: it reached
    // Margin, and no test of it failed since (Safari's own New Tab also runs
    // from its + button and File menu, so that alone says nothing).
    var newWindowsOpenMargin: Bool { seen("marginNewWindowPage", after: [Seen.safariLaunched, Seen.marginOff, Seen.failed("newWindow")]) }
    var newTabsOpenMargin: Bool { seen("marginNewTabPage", after: [Seen.safariLaunched, Seen.marginOff, "homepageNewTab", Seen.failed("newTab")]) }
    var commandTReachesMargin: Bool { seen("cmdTKey", after: [Seen.failed("commandT")]) }

    func state(_ step: Step) -> StepState {
        switch step {
        case .turnOn: return extensionOn == nil ? .unknown : (extensionOn! ? .done : .todo)
        case .allSites: return allSites == true ? .done : (allSites == nil ? .unknown : .todo)
        case .newTabs: return newWindowsOpenMargin && newTabsOpenMargin ? .done : .todo
        case .commandT: return commandTReachesMargin ? .done : .todo
        case .restore, .tidy: return manual.contains(step.rawValue) ? .done : .optional
        case .profileNames: return diskAccess == .granted ? .done : .optional
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

    // Safari opening (and restoring its windows) can take a while.
    func startTest(_ step: Step) {
        openSafari()
        test = SetupTest(step: step, since: Date())
        testTimer?.invalidate()
        testTimer = Timer.scheduledTimer(withTimeInterval: step == .newTabs ? 30 : 20, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.timeOutTest() }
        }
    }

    private func happened(_ name: String, since: Date) -> Bool { (events[name] ?? .distantPast) >= since }

    private func judgeTest() {
        guard var t = test, t.result == nil else { return }
        switch t.step {
        case .commandT:
            if happened("cmdTKey", since: t.since) { t.result = .passed }
            else if happened("safariNewTab", since: t.since) {
                t.result = .failed("Safari opened a new tab, so ⌘T still belongs to Safari's New Tab. Check the App Shortcut: Safari, menu title “New Tab” exactly, any other keys.")
                note(Seen.failed("commandT"), Date())
            }
        case .newTabs:
            if happened("otherNewTabPage", since: t.since) || happened("homepageNewTab", since: t.since) {
                t.result = .failed("A new tab opened a web page, not Margin's. In Safari Settings › General, set “New tabs open with” to Margin.")
                note(Seen.failed("newTab"), Date())
            } else if happened("marginNewWindowPage", since: t.since), happened("marginNewTabPage", since: t.since) {
                t.result = .passed
            }
        default: break
        }
        test = t
    }

    private func timeOutTest() {
        guard var t = test, t.result == nil else { return }
        switch t.step {
        case .commandT:
            t.result = .failed("Nothing reached Margin. If Safari opened a new tab, ⌘T still belongs to it: check the App Shortcut (Safari, menu title “New Tab” exactly). Otherwise check Margin is on, then try again with a web page in front.")
        case .newTabs:
            let missing = [
                happened("marginNewWindowPage", since: t.since) ? nil : (check: "newWindow", setting: "New windows open with", what: "a new window (⌘N)"),
                happened("marginNewTabPage", since: t.since) ? nil : (check: "newTab", setting: "New tabs open with", what: "a new tab (+)"),
            ].compactMap { $0 }
            // One of the two came: the user did the test, so the other is wrong
            // (neither: maybe they didn't, so nothing is undone).
            if missing.count == 1 { note(Seen.failed(missing[0].check), Date()) }
            t.result = .failed("Margin's page didn't open for \(missing.map(\.what).joined(separator: " or ")). In Safari Settings › General, set \(missing.map { "“\($0.setting)”" }.joined(separator: " and ")) to Margin, then try again.")
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

    // System Settings at Full Disk Access (its public URL).
    func openFullDiskAccess() {
        NSWorkspace.shared.open(SafariFiles.fullDiskAccessURL)
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
                    if state == .optional || step == .restore || step == .tidy || step == .profileNames {
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
        case .profileNames: return "Show Safari's profile names and iCloud Tabs"
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
        case (.newTabs, _) where model.newWindowsOpenMargin: return "New windows open Margin's page; new tabs not yet (or not since Safari last opened)."
        case (.newTabs, _) where model.newTabsOpenMargin: return "New tabs open Margin's page; new windows not yet (or not since Safari last opened)."
        case (.newTabs, _): return "So a new window or tab starts in Margin, with its sidebar and palette. While Margin isn't signed, Safari can set these back when it restarts: check again then."
        case (.commandT, .done): return "⌘T opens Margin's palette, with no new tab flashing first."
        case (.commandT, _): return "Safari keeps ⌘T for its own New Tab, which makes a tab before Margin can step in (a flicker). Giving Safari's New Tab another shortcut frees ⌘T for Margin."
        case (.profileNames, .done): return "Margin shows each Safari profile by the name Safari gives it, and follows when you rename one in Safari. It shows the tabs open on your other devices (iCloud Tabs) in its sidebar."
        case (.profileNames, _) where model.diskAccess == .noSafari: return "Safari's data wasn't found on this Mac. Margin uses the names you give profiles in Edit Profile, and shows no iCloud Tabs."
        case (.profileNames, _): return "With several Safari profiles, Margin can show them by Safari's own names, and it can show the tabs open on your other devices (iCloud Tabs) in its sidebar. That needs Full Disk Access: Safari keeps both in its own data. Without it, Margin uses the names you give profiles in Edit Profile, shows no iCloud Tabs, and nothing else changes."
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
            Text("Margin isn't listed, or it's off again each time Safari opens? Until Margin is signed, Safari also needs Settings › Developer › Allow unsigned extensions (no Developer tab: Settings › Advanced › Show features for web developers), and asks for it again after it quits.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
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
                Button("Test: ⌘N, then + in Safari") { model.startTest(.newTabs) }
            }
            TestLine(test: model.test, step: step, waiting: "Waiting… in Safari, press ⌘N, then click + in the new window's tab bar (or File › New Tab).")
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
        case .profileNames:
            Instructions(lines: [
                "Click Open Full Disk Access (System Settings › Device Control and Data Access › Full Disk Access).",
                "Turn on Margin. If it isn't listed, click +, then choose Margin in your Applications folder.",
                "Margin reads only the profiles' names and symbols and the tabs open on your other devices (iCloud Tabs), never your history, and never changes anything of Safari's.",
            ])
            HStack {
                Button("Open Full Disk Access") { model.openFullDiskAccess() }
                if model.diskAccess == .granted {
                    Text("Margin has Full Disk Access.").font(.callout).foregroundStyle(.secondary)
                } else {
                    Text("Checked as you go. Names not showing a minute after you allow it: quit Margin and open it again.").font(.callout).foregroundStyle(.secondary)
                }
            }
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
                ShortcutRow(keys: "⌃⌘→  ⌃⌘←", action: "Next / previous space (⌃⌘← with a web page in front: its key went to ⌘T)")
                ShortcutRow(keys: "⌥S", action: "Show or hide the sidebar")
                ShortcutRow(keys: "Two-finger swipe", action: "Sideways on the sidebar: switch spaces")
            }
            Text("⌥⌘ arrows belong to Safari (its own tab switching, before Margin can see them). To use them for Margin anyway, Karabiner-Elements can turn them into ⌃⌘ arrows while Safari is in front (the same limits apply).")
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
