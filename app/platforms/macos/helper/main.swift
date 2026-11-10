// margin-helper: the one part of Margin that runs all the time (Tirth, 2026-11-10: not the whole app). Started at
// login by launchd (Margin.app registers it: SMAppService.agent, io.tirth.margin.helper.plist), it waits for a
// browser Margin works in to open, and then starts Margin.app in the background, so Margin is up (about 0.3 s)
// long before the browser's extension asks for its link (about 3 s after the browser opens). It does nothing else:
// no windows, no network, no files; it sleeps in its run loop between launches (no polling: about 2.5 MB). Margin.app quits by itself when no browser needs it (AppDelegate.swift).
//
// Margin.app is this program's bundle: …/Margin.app/Contents/Helpers/margin-helper. MARGIN_HELPER_APP and
// MARGIN_HELPER_BROWSERS (comma-separated bundle ids) are for the app's tests only.

import AppKit

// The browsers Margin works in (AppDelegate.swift `browsers`: the same list).
let browsers: Set<String> = ProcessInfo.processInfo.environment["MARGIN_HELPER_BROWSERS"].map { Set($0.split(separator: ",").map(String.init)) }
    ?? ["com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.microsoft.edgemac"]

// (Its own path as the system knows it: launchd starts it by the agent's BundleProgram, a path relative to the
// bundle, so argv[0] is no way to find Margin.app.)
let app: URL = ProcessInfo.processInfo.environment["MARGIN_HELPER_APP"].map { URL(fileURLWithPath: $0) }
    ?? URL(fileURLWithPath: Bundle.main.executablePath ?? CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() // Helpers → Contents → Margin.app
let appId = Bundle(url: app)?.bundleIdentifier ?? "io.tirth.margin"

func log(_ line: String) { FileHandle.standardError.write(Data("margin-helper: \(line)\n".utf8)) }

// Margin.app, in the background (never activated, no window: --background), unless it's running already. One
// start at a time: LaunchServices hands a second open of a starting app the instance that's starting.
var startedAt = Date.distantPast
func startMargin(_ why: String) {
    guard NSRunningApplication.runningApplications(withBundleIdentifier: appId).allSatisfy(\.isTerminated),
          Date().timeIntervalSince(startedAt) > 2 else { return }
    startedAt = Date()
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    configuration.promptsUserIfNeeded = false
    configuration.arguments = ["--background"]
    NSWorkspace.shared.openApplication(at: app, configuration: configuration) { running, error in
        if let error { log("couldn't start Margin.app (\(why)): \(error.localizedDescription)") }
        else { log("started Margin.app (\(why)), pid \(running?.processIdentifier ?? 0)") }
    }
}

// Not inside Margin.app: nothing to start, and a clean exit (the agent's KeepAlive starts it again only after a crash).
guard app.pathExtension == "app" else {
    log("not inside Margin.app (\(app.path)): nothing to start")
    exit(0)
}
// A browser open already (the helper started after it, or launchd started it again): at once.
if let open = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier.map(browsers.contains) ?? false }) {
    startMargin("\(open.bundleIdentifier ?? "a browser") is open")
}
// Each app that starts (NSWorkspace's runningApplications, observed: its launch notifications reach only a process
// connected as an app, which would cost this one 50 MB; this costs nothing between launches).
let observer = NSWorkspace.shared.observe(\.runningApplications, options: [.new]) { _, change in
    guard let id = (change.newValue ?? []).compactMap(\.bundleIdentifier).first(where: browsers.contains) else { return }
    DispatchQueue.main.async { MainActor.assumeIsolated { startMargin("\(id) opened") } }
}
withExtendedLifetime(observer) { RunLoop.main.run() }
