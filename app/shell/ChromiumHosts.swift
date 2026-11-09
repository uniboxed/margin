// Chrome's and Edge's native-messaging host files (app/PROTOCOL.md "Transport (Chrome and Edge, on the Mac)"),
// written at each launch: `io.tirth.margin.json` in each browser's NativeMessagingHosts folder, for every browser
// whose folder is there (Chrome and its Beta, Dev and Canary; Edge and its Beta, Dev and Canary), naming this app's
// relay helper and only Margin's extension. A file that already says the same is left alone, so a launch writes
// nothing once they're right; an app moved elsewhere writes its new path.

import Foundation

enum ChromiumHosts {
    static let name = "io.tirth.margin"
    // Margin's extension in Chrome and Edge: the id its manifest's key gives (platform/chrome/manifest.json; the
    // unit tests check the two agree).
    static let extensionIds = ["njeebbcmlenfopaecfbphgcfihbdmkec"]
    // Each browser's folder under ~/Library/Application Support.
    static let browsers = ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary",
                           "Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev", "Microsoft Edge Canary"]

    // This app's relay (Contents/Helpers/margin-relay), if the build has one.
    static var relay: URL? {
        let url = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/margin-relay")
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
    }

    static func manifest(relay: URL) -> Data {
        let object: JSONObject = [
            "name": name,
            "description": "Margin.app's relay, for Margin's extension",
            "path": relay.path,
            "type": "stdio",
            "allowed_origins": extensionIds.map { "chrome-extension://\($0)/" },
        ]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    }

    // The files written (paths), for the log; none when there's no relay or no browser.
    @discardableResult
    static func install(relay: URL? = ChromiumHosts.relay, support: URL = ChromiumHosts.support) -> [String] {
        guard let relay else { return [] }
        let body = manifest(relay: relay)
        var written: [String] = []
        for browser in browsers {
            let folder = support.appendingPathComponent(browser, isDirectory: true)
            guard FileManager.default.fileExists(atPath: folder.path) else { continue }
            let hosts = folder.appendingPathComponent("NativeMessagingHosts", isDirectory: true)
            let file = hosts.appendingPathComponent("\(name).json")
            if (try? Data(contentsOf: file)) == body { continue }
            do {
                try FileManager.default.createDirectory(at: hosts, withIntermediateDirectories: true)
                try body.write(to: file, options: .atomic)
                written.append(file.path)
            } catch {
                Diagnostics.warn("couldn't write \(browser)'s host file: \(error.localizedDescription)")
            }
        }
        return written
    }
}
