// Safari's profile names without Full Disk Access (docs/ARCHITECTURE-PLAN.md, 2026-11-18): the person picks Safari's
// data folder once in a standard folder picker that opens on it, and macOS lets Margin read that folder from then on
// (proven on the real Mac with a test app of Margin's team, not sandboxed: no access before, all five profiles and
// their names after, still after a relaunch, no other prompt; Codex's sandboxed helper the same,
// tools/safari-profile-lab/folder-access.md on chore/safari-profile-research). Margin reads only the profiles' rows
// there (SafariProfiles.read), never writes.
//
// The pick is also kept as a security-scoped bookmark (Application Support/Margin/safari-folder.bookmark) and its scope
// started at launch: the grant macOS keeps for the app is what the test showed working on its own, the bookmark is
// there in case a later macOS keeps only that. Neither is ever logged.

import AppKit

@MainActor
enum SafariFolderGrant {
    // Told when the person granted the folder (the shell reads Safari's profiles again at once).
    static let granted = Notification.Name("MarginSafariFolderGranted")

    static var bookmarkURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Margin", isDirectory: true).appendingPathComponent("safari-folder.bookmark")
    }

    private static var scoped: URL?

    // At launch: the kept pick's scope started (nothing when there's none, or it no longer resolves). True: started.
    @discardableResult static func restore() -> Bool {
        guard scoped == nil, let file = bookmarkURL, let data = try? Data(contentsOf: file) else { return false }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale),
              url.standardizedFileURL.path == SafariProfiles.safariFolder.standardizedFileURL.path, url.startAccessingSecurityScopedResource() else { return false }
        scoped = url
        if stale, let fresh = try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil) { try? fresh.write(to: file, options: .atomic) }
        return true
    }

    enum Outcome: Equatable { case granted, cancelled, wrongFolder, unreadable }

    // The picker, on Safari's folder; `done` with what came of it. Only Safari's own folder is taken.
    static func ask(over window: NSWindow?, done: @escaping (Outcome) -> Void = { _ in }) {
        let target = SafariProfiles.safariFolder.standardizedFileURL
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.showsHiddenFiles = false
        panel.directoryURL = target
        panel.prompt = "Allow"
        panel.message = "To open each space's pages in the right Safari profile, Margin needs to see the names of your Safari profiles. Click Allow. Margin only reads the names, never your tabs or history, and never changes anything."
        let finish: (NSApplication.ModalResponse) -> Void = { answer in
            guard answer == .OK, let url = panel.url else { return done(.cancelled) }
            guard url.standardizedFileURL.path == target.path else { return done(.wrongFolder) }
            _ = url.startAccessingSecurityScopedResource()
            scoped = url
            if let file = bookmarkURL, let data = try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil) {
                try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: file, options: .atomic)
            }
            let readable = SafariProfiles.access() == .granted
            Diagnostics.note("safari profiles: the person allowed Safari's folder: \(readable ? "readable" : "still not readable")")
            NotificationCenter.default.post(name: granted, object: nil)
            done(readable ? .granted : .unreadable)
        }
        NSApp.activate()
        if let window { panel.beginSheetModal(for: window, completionHandler: finish) } else { finish(panel.runModal()) }
    }
}
