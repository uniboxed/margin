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
// (background/link.ts), and the handler starts the installed build. Never on
// a refused dispatch alone: the extension's record can be gone for seconds
// after an install (safari.sh), and a new process wouldn't help then.
//
// A new instance ends any other one started from the same bundle before it
// starts its shell (AppDelegate.swift), never the other way round.

import CoreServices
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

    // Each dispatch the link's Safari didn't pass on: looked at at once; three in a row, the registrations healed.
    func watch(_ link: SocketLink, registration: Registration? = nil) {
        link.onDispatchRefused = { [weak self, weak link] name, why in
            guard self?.check("\(name) not passed on: \(why)") == false, let link, link.refusedInARow >= 3 else { return }
            registration?.heal("Safari refused \(link.refusedInARow) hand-offs in a row")
        }
    }

    // Registered copies of Margin that aren't this one and are no one's Margin: one left in a build folder (an
    // Xcode or scripts/safari.sh build, a test's), in the Trash, or gone from disk. Another real install (an
    // Applications folder's) is never one. A second registered Margin.app makes Safari take this one for another
    // app's and refuse its messages (SFErrorDomain 1: the build-only safari.sh's, 2026-11-09, 19 in a row).
    nonisolated static let buildFolders = ["/DerivedData/", "/xcode/build/", "/Build/Products/", "/.Trash/", "/private/tmp/", "/private/var/folders/", "/tmp/"]
    nonisolated static func strays(_ registered: [URL], me: URL, exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> [URL] {
        let mine = me.standardizedFileURL.path
        var seen = Set<String>()
        return registered.filter { url in
            let path = url.standardizedFileURL.path
            guard path != mine, seen.insert(path).inserted else { return false }
            return !exists(url) || buildFolders.contains { path.contains($0) }
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

// Margin.app the one copy the system knows by its id: the strays (BundleWatch.strays) unregistered and this one
// registered again, off the main thread, at launch and when Safari keeps refusing its hand-offs; at most once a
// minute, and never under the app's tests (MARGIN_APP_TESTS).
final class Registration {
    private var lastHeal = -Double.infinity
    private let queue = DispatchQueue(label: "com.unibox.margin.registration", qos: .utility)
    nonisolated static let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

    func heal(_ why: String, now: Double = Diagnostics.now()) {
        guard ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] == nil, now - lastHeal >= 60,
              let id = Bundle.main.bundleIdentifier else { return }
        lastHeal = now
        let me = Bundle.main.bundleURL
        queue.async {
            let registered = (LSCopyApplicationURLsForBundleIdentifier(id as CFString, nil)?.takeRetainedValue() as? [URL]) ?? []
            let strays = BundleWatch.strays(registered, me: me)
            for url in strays {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: Self.lsregister)
                task.arguments = ["-u", url.path]
                try? task.run()
                task.waitUntilExit()
            }
            let status = LSRegisterURL(me as CFURL, true)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if !strays.isEmpty || status != noErr {
                        Diagnostics.note("registration (\(why)): \(strays.count) other cop\(strays.count == 1 ? "y" : "ies") of Margin unregistered, this one registered again\(status == noErr ? "" : " (error \(status))")")
                    }
                }
            }
        }
    }
}
