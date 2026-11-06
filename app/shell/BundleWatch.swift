// One Margin.app at a time, and only the build that's installed.
//
// An update (scripts/safari.sh, or any other copy over ~/Applications/Margin.app)
// puts a new bundle where the running app's was. Before safari.sh quit the
// running app, the old process ran on: Safari refused every `link` it
// dispatched (SFErrorDomain 1, SFErrorNoExtensionFound: Tirth's runs of
// 2026-11-05, pids 73613 and 50812), and the extension handler, seeing a
// Margin.app running, never started the new one, so a copy that needed a new
// link never got one. It would also have drawn the new build's overlay files
// (OverlayWebView.appRoot is Bundle.main.resourceURL) with the old code.
//
// So the app notes its executable's identity at launch (the file's resource
// id and modification date) and compares it every 30 s (AppDelegate.swift's
// idle check) and right after a dispatch Safari didn't pass on. When the
// file is another one, it quits: the copies are told goodbye, ask again
// (background/link.js), and the handler starts the installed build. Never on
// a refused dispatch alone: the extension's record can be gone for seconds
// after an install (safari.sh), and a new process wouldn't help then.
//
// A new instance ends any other one started from the same bundle before it
// starts its shell (AppDelegate.swift), never the other way round.

import Foundation

// A file as it is now: the same path can hold another file after an update.
struct FileIdentity: Equatable {
    var id: NSObject?
    var modified: Date?

    // Nil when it can't be read (missing for a moment mid-swap, say).
    static func of(_ url: URL?) -> FileIdentity? {
        guard var url else { return nil }
        url.removeAllCachedResourceValues()
        guard let values = try? url.resourceValues(forKeys: [.fileResourceIdentifierKey, .contentModificationDateKey]),
              values.fileResourceIdentifier != nil || values.contentModificationDate != nil else { return nil }
        return FileIdentity(id: values.fileResourceIdentifier as? NSObject, modified: values.contentModificationDate)
    }
}

final class BundleWatch {
    private let read: () -> FileIdentity?
    private let quit: () -> Void
    private let started: FileIdentity?
    private(set) var quitting = false

    // `read`: the executable's identity now (the tests give their own); `quit`: called once.
    init(read: @escaping () -> FileIdentity? = { FileIdentity.of(Bundle.main.executableURL) }, quit: @escaping () -> Void) {
        self.read = read
        self.quit = quit
        started = read()
        if started == nil { Diagnostics.warn("Margin.app's own executable can't be read: a new build put in its place won't be noticed") }
    }

    // Whether the app was replaced on disk (and so is quitting). An executable
    // that can't be read just now is looked at again next time.
    @discardableResult func check(_ why: String) -> Bool {
        guard !quitting else { return true }
        guard let started, let now = read(), now != started else { return false }
        quitting = true
        Diagnostics.note("Margin.app was replaced on disk: quitting so the new build starts (\(why))")
        quit()
        return true
    }

    // Each dispatch the link's Safari didn't pass on: looked at at once.
    func watch(_ link: SocketLink) {
        link.onDispatchRefused = { [weak self] name, why in
            self?.check("\(name) not passed on: \(why)")
        }
    }

    // The other instances to end as one starts: those of the same bundle
    // (its path, or the path an update moves it aside to), never this one,
    // never a copy elsewhere (an Xcode build's, the test hosts have none).
    struct Running {
        let pid: pid_t
        let bundlePath: String?
    }
    static func othersToEnd(_ running: [Running], me: pid_t, bundlePath: String) -> [pid_t] {
        let here = URL(fileURLWithPath: bundlePath).standardizedFileURL.path
        return running.filter { copy in
            guard copy.pid != me, let path = copy.bundlePath else { return false }
            let there = URL(fileURLWithPath: path).standardizedFileURL.path
            return there == here || there == here + ".old"
        }.map(\.pid)
    }
}
