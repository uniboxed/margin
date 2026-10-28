// Margin's extension handler: the extension's native messages
// (browser.runtime.sendNativeMessage, background/onboarding.js) about what it
// sees in Safari are passed on to Margin's app (its set-up window,
// ViewController.swift) as a distributed notification. Both are sandboxed and
// share no storage; a notification's string object is what a sandboxed
// process may send. The reply says whether the app is open to hear it (the
// extension holds its events back for a while when it isn't).
// Copied into the generated Xcode project by scripts/make-xcode.sh.

import AppKit
import SafariServices
import os.log

let marginAppIdentifier = "io.tirth.margin"
let marginNotification = Notification.Name("io.tirth.margin.setup")

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]

        // Only what the extension sends for the set-up window: a status or an event.
        if let body = message as? [String: Any],
           let type = body["type"] as? String, type == "status" || type == "event",
           let data = try? JSONSerialization.data(withJSONObject: body),
           let json = String(data: data, encoding: .utf8) {
            DistributedNotificationCenter.default().postNotificationName(marginNotification, object: json, userInfo: nil, deliverImmediately: true)
        } else {
            os_log(.default, "Margin: unexpected native message: %@", String(describing: message))
        }

        let appOpen = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == marginAppIdentifier }
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true, "appOpen": appOpen]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
