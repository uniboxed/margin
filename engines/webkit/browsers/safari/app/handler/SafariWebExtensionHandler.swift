// Margin's extension handler: the extension's native messages
// (browser.runtime.sendNativeMessage, engines/webkit/browsers/safari/extension/onboarding.ts) about what it
// sees in Safari are passed on to Margin's app (its set-up window,
// ViewController.swift) as a distributed notification, while the app is open.
// Both are sandboxed and share no storage; a notification's string object is
// what a sandboxed process may send (other apps on the Mac could listen too:
// it's only event names and whether Margin may run everywhere). The reply
// says whether the app was open to hear it (access it didn't hear is sent
// again later).
// A copy asking for its link to the app (wantLink, docs/PROTOCOL.md) is passed
// on the same way, as only its type and nonce: the app answers into the
// extension itself (app/macos/shell/ExtensionLink.swift). If the app isn't running,
// it's started in the background first (never activated, no window: opened
// with --background), and the reply says so (`launching`): the copy asks
// again shortly. A copy's `ping` (its lasting port, kept used so Safari keeps
// its background alive) is only answered.
// Copied into the generated Xcode project by scripts/make-xcode.sh, which
// also sets marginAppIdentifier.

import AppKit
import SafariServices
import os.log

let marginAppIdentifier = "io.tirth.margin"
let marginNotification = Notification.Name("io.tirth.margin.setup")
// The note the handler leaves (in its container's Caches) as it starts the app for a link.
let launchNote = "margin-launch"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private var profile = "s-default"
    static let extensionLog = Logger(subsystem: "io.tirth.margin", category: "extension")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]
        // Safari's own id for the profile this copy runs in (none for the
        // default profile): it survives Safari wiping the extension's storage,
        // so the app's data for the profile is found again (background/link.ts).
        var profile = "s-default"
        if #available(macOS 14.0, *), let id = request?.userInfo?[SFExtensionProfileKey] as? UUID {
            profile = "s-\(id.uuidString.lowercased())"
        }
        self.profile = profile

        let appOpen = !NSRunningApplication.runningApplications(withBundleIdentifier: marginAppIdentifier).isEmpty

        // Only what the extension sends for the set-up window (a status or an
        // event), and a copy's wantLink (with nothing but its nonce).
        let body = message as? [String: Any]
        var passOn: [String: Any]?
        var launching = false
        if let body, body["type"] as? String == "log", let line = body["line"] as? String {
            // The copy's link events (background/link.ts note): in the system log
            // next to the app's own (subsystem io.tirth.margin, category extension).
            Self.extensionLog.notice("\(profile, privacy: .public): \(String(line.prefix(300)), privacy: .public)")
            return reply(context, appOpen: appOpen)
        }
        if let body, body["type"] as? String == "ping" {
            // The copy's lasting port, used to keep Safari's background alive (background/link.ts): nothing to do.
            return reply(context, appOpen: appOpen)
        }
        if let body, let type = body["type"] as? String, type == "status" || type == "event" {
            passOn = body
        } else if let body, body["type"] as? String == "wantLink", let nonce = body["nonce"] as? String, (1...128).contains(nonce.count) {
            passOn = ["type": "wantLink", "nonce": nonce]
            // Margin.app started on demand (Tirth, 2026-11-05: no login item
            // needed): in the background, never activated, no window. The
            // notification below is lost while it starts; the copy asks again
            // (and the app says `appUp` once it's listening).
            if !appOpen { launching = Self.launchApp() }
        }
        if let passOn,
           let data = try? JSONSerialization.data(withJSONObject: passOn),
           let json = String(data: data, encoding: .utf8) {
            if appOpen {
                DistributedNotificationCenter.default().postNotificationName(marginNotification, object: json, userInfo: nil, deliverImmediately: true)
            }
        } else {
            os_log(.default, "Margin: unexpected native message: %@", String(describing: message))
        }

        reply(context, appOpen: appOpen, launching: launching)
    }

    private func reply(_ context: NSExtensionContext, appOpen: Bool, launching: Bool = false) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true, "appOpen": appOpen, "launching": launching, "profile": profile]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    // When this process last asked for the app to start: one launch at a time
    // (LaunchServices also gives a second open of the same app the instance
    // that's starting, rather than a second one).
    private static var launchedAt: Date?
    static let launchEvery: TimeInterval = 10

    // The containing app (this extension is inside its PlugIns folder), opened
    // in the background. False if it couldn't be asked for.
    static func launchApp() -> Bool {
        if let at = launchedAt, Date().timeIntervalSince(at) < launchEvery { return true }
        // Margin.app/Contents/PlugIns/Margin Extension.appex → Margin.app
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard app.pathExtension == "app" else {
            os_log(.default, "Margin: no containing app at %@", app.path)
            return false
        }
        launchedAt = Date()
        // A sandboxed caller's `arguments` never reach the app (tested off
        // screen, 2026-11-05), so the app learns it was started for a link
        // from this note in the extension's own container, which it can read
        // (AppDelegate.swift startedForLink): no set-up window then.
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: caches, withIntermediateDirectories: true)
        try? "\(Date().timeIntervalSince1970)".write(to: caches.appendingPathComponent(launchNote), atomically: true, encoding: .utf8)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        // Not `hides`: a hidden app's overlays never show (feat/native-panel
        // found a hidden Margin.app had to be shown again without activating it).
        configuration.promptsUserIfNeeded = false
        NSWorkspace.shared.openApplication(at: app, configuration: configuration) { running, error in
            if let error {
                os_log(.default, "Margin: starting Margin.app failed: %@", error.localizedDescription)
            } else {
                os_log(.default, "Margin: Margin.app started in the background (pid %d)", running?.processIdentifier ?? 0)
            }
        }
        return true
    }
}
