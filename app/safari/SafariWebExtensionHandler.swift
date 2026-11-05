// Margin's extension handler: the extension's native messages
// (browser.runtime.sendNativeMessage, background/onboarding.js) about what it
// sees in Safari are passed on to Margin's app (its set-up window,
// ViewController.swift) as a distributed notification, while the app is open.
// Both are sandboxed and share no storage; a notification's string object is
// what a sandboxed process may send (other apps on the Mac could listen too:
// it's only event names and whether Margin may run everywhere). The reply
// says whether the app was open to hear it (access it didn't hear is sent
// again later).
// A copy asking for its link to the app (wantLink, app/PROTOCOL.md) is passed
// on the same way, as only its type and nonce: the app answers into the
// extension itself (app/shell/ExtensionLink.swift).
// Copied into the generated Xcode project by scripts/make-xcode.sh, which
// also sets marginAppIdentifier.

import AppKit
import SafariServices
import os.log

let marginAppIdentifier = "io.tirth.margin"
let marginNotification = Notification.Name("io.tirth.margin.setup")

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]

        let appOpen = !NSRunningApplication.runningApplications(withBundleIdentifier: marginAppIdentifier).isEmpty

        // Only what the extension sends for the set-up window (a status or an
        // event), and a copy's wantLink (with nothing but its nonce).
        let body = message as? [String: Any]
        var passOn: [String: Any]?
        if let body, let type = body["type"] as? String, type == "status" || type == "event" {
            passOn = body
        } else if let body, body["type"] as? String == "wantLink", let nonce = body["nonce"] as? String, (1...128).contains(nonce.count) {
            passOn = ["type": "wantLink", "nonce": nonce]
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

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true, "appOpen": appOpen]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
