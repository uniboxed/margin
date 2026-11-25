// The shell's side of a browser's profiles (BrowserProfiles.swift): each profile's name, Safari's own names
// for its profiles kept in step (SafariProfiles.swift), a profile's set carried over when Safari gives it a new id,
// and a profile's window asked of Safari when the host needs one and its copy isn't running.

import AppKit

extension Shell {
    // ---- the profiles of a browser ----

    func profilesOf(_ browser: String) -> BrowserProfiles {
        if let p = browserProfiles[browser] { return p }
        let p = BrowserProfiles(browser: browser, root: data.root)
        browserProfiles[browser] = p
        return p
    }

    // Safari's own names for its profiles, kept in step (SafariProfiles.swift),
    // with Full Disk Access; without it the typed names stay.
    func startSafariNames() {
        guard let folder = options.safariData, safariNames == nil else { return }
        let watcher = SafariProfileWatcher(folder: folder, options: options.safariWatch)
        watcher.onChange = { [weak self] outcome in
            guard let self else { return }
            let profiles = self.profilesOf("safari")
            switch outcome {
            case .read(let list): _ = profiles.useBrowserNames(list)
            case .noAccess, .noSafari, .failed: _ = profiles.dropBrowserNames()
            case .busy: break
            }
            // (Safari's own names read, or gone: a profile Margin couldn't open by name may open now.)
            self.hosted?.profileNamesChanged()
            self.profilesSoon()
            self.marginWindows?.tellProfiles()
        }
        // Each read (changed or not): the linked copies checked against it.
        watcher.onRead = { [weak self] outcome in
            guard let self, case .read = outcome else { return }
            self.profilesOf("safari").checkMapped(self.linkedProfiles("safari"))
            self.carryOver()
        }
        // A signing change's new ids: the profile's set carried over (BrowserProfiles carrySource, DataSync carry).
        data.beforeNeed = { [weak self] p, withSets in self?.needChoice(p, withSets: withSets) ?? .ask }
        data.onCarried = { [weak self] old, new, _ in
            guard let self else { return }
            self.profilesOf(new.browser).carry(from: old.profile, to: new.profile)
            self.profilesSoon()
        }
        data.onFirstSet = { [weak self] p in if p.browser == "safari" { self?.carryOver() } }
        // The copies Margin knows (from their hellos): an entry of theirs is preferred over another live one.
        watcher.known = { [weak self] in
            guard let self else { return [] }
            return Set(self.profilesOf("safari").profiles).union(self.linkedProfiles("safari"))
        }
        safariNames = watcher
        // (The person's one-time pick of Safari's folder, kept: its scope started before the first read. A pick made now
        // is read at once, not at the next retry.)
        SafariFolderGrant.restore()
        NotificationCenter.default.addObserver(forName: SafariFolderGrant.granted, object: nil, queue: .main) { [weak watcher] _ in
            MainActor.assumeIsolated { watcher?.readNow() }
        }
        watcher.start()
    }

    // The Safari profiles with a set on disk (as the data says it in its need question).
    private func safariWithSets() -> Set<String> { Set(data.profiles(browser: "safari").map(\.profile)) }

    // A Safari profile with no set yet: the set of the same Safari profile
    // under its old id, carried over; or a hold while Safari's profiles are
    // read again (none maps it yet, and there's a set that could be its);
    // else data.need as always. Without a read (no Full Disk Access): as always.
    // (`withSets`: the Safari profiles with a set on disk, as the data says it in its question: it isn't asked back.)
    func needChoice(_ p: DataProfile, withSets: Set<String>) -> DataSync.NeedChoice {
        guard p.browser == "safari" else { return .ask }
        let profiles = profilesOf("safari"), linked = linkedProfiles("safari")
        if let (old, id) = profiles.carrySource(for: p.profile, withSets: withSets, linked: linked) {
            return .carry(from: DataProfile(browser: "safari", profile: old), why: "Safari profile \(id)")
        }
        if profiles.mightCarry(p.profile, withSets: withSets, linked: linked) {
            safariNames?.readNow()
            return .hold
        }
        return .ask
    }

    // After a read, and after a new copy's first set: each linked Safari copy
    // whose profile's set sits under its old id gets it; a held hello the read
    // maps with nothing to carry is let go.
    func carryOver() {
        let profiles = profilesOf("safari"), linked = linkedProfiles("safari")
        var withSets = safariWithSets()
        for new in linked.sorted() {
            guard let (old, id) = profiles.carrySource(for: new, withSets: withSets, linked: linked) else { continue }
            if data.carry(from: DataProfile(browser: "safari", profile: old), to: DataProfile(browser: "safari", profile: new), why: "Safari profile \(id)") {
                withSets = safariWithSets() // (the sets as they are now, for the next copy)
            }
        }
        let read = profiles.browserRead
        for p in data.holding where p.browser == "safari" && read?.contains(where: { $0.margin == p.profile }) == true {
            data.release(p, why: "Safari's profiles read: it's mapped, with no set to carry over")
        }
    }

    // A Safari copy said hello: Safari's profiles read again soon, and the copy checked against that read.
    func safariCopyLinked() {
        safariNames?.soon(after: 0.3)
    }


    // Each profile's spaces in its own order (its set's, or its copy's state while linked).
    private func ownSpaces(_ browser: String) -> [String: [String]] {
        var ids: [String: [String]] = [:]
        var profiles = Set(data.profiles(browser: browser).map(\.profile))
        for entry in links.values where entry.connection.hello.browser == browser { profiles.insert(entry.connection.hello.profile) }
        for p in profiles {
            var list: [String: JSONObject] = [:]
            if let entry = links["\(browser):\(p)"], entry.mirror.hasState, let spaces = entry.mirror.value("spaces") as? [Any] {
                for (n, s) in spaces.enumerated() {
                    guard let s = s as? JSONObject, let id = s["id"] as? String else { continue }
                    var v = s
                    v["order"] = num(s["order"]) ?? Double(n)
                    list[id] = v
                }
            } else {
                for (id, v) in data.values("spaces", of: DataProfile(browser: browser, profile: p)) { if let v = v as? JSONObject { list[id] = v } }
            }
            guard !list.isEmpty else { continue }
            ids[p] = list.keys.sorted { (num(list[$0]?["order"]) ?? 0, $0) < (num(list[$1]?["order"]) ?? 0, $1) }
        }
        return ids
    }

    // Each browser's profiles and the order of their spaces brought up to date (data/<browser>/browser.json: the
    // library's import reads it, a profile's set is carried over by it), on the next turn.
    func profilesSoon() {
        guard !profilesQueued else { return }
        profilesQueued = true
        DispatchQueue.main.async { MainActor.assumeIsolated {
            self.profilesQueued = false
            for browser in Set(self.links.values.map(\.connection.hello.browser)) {
                self.profilesOf(browser).refresh(spaces: self.ownSpaces(browser), linked: self.linkedProfiles(browser))
            }
            self.marginWindows?.tellProfiles()
        } }
    }

    // The profiles' names for Margin's pages (M2.10: a space's tooltip shows its profile, as Arc's does): each browser's
    // known profiles by id, named as Margin names them (Safari's own names when it can read them; else "Default",
    // "Profile N", BrowserProfiles), and the profile a space with none of its own opens in.
    func profilesJSON() -> String {
        var names: [String: [String: String]] = [:]
        for browser in Set(browserProfiles.keys).union(["safari"]).sorted() {
            let p = profilesOf(browser)
            var list: [String: String] = [:]
            for id in p.profiles { let n = p.name(id); if !n.isEmpty { list[id] = n } }
            names[browser] = list
        }
        let fallback = ["safari": hosted?.resolve(nil) ?? BrowserProfiles.defaultProfile]
        return jsonString(["names": names, "fallback": fallback]) ?? "null"
    }

    func linkedProfiles(_ browser: String) -> Set<String> {
        Set(links.values.filter { $0.connection.hello.browser == browser && $0.connection.isUp }.map(\.connection.hello.profile))
    }

    // A profile with no window (its copy not running): Safari's own menu opens one, through Accessibility. Its
    // copy starts with it and links (the host waits for it: HostedSession.requestSafariWindow).
    func openProfileWindow(_ profile: String, pressed done: @escaping @MainActor (Bool) -> Void = { _ in }) -> Bool {
        guard options.safariAX, SafariAX.trusted, profile.hasPrefix("safari:"),
              let pid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first?.processIdentifier,
              case let name = profilesOf("safari").browserNames[String(profile.dropFirst("safari:".count))]?.name ?? profileName(profile), !name.isEmpty else { return false }
        safariAX.newWindow(pid: pid, profileName: name) { pressed in
            Diagnostics.note(pressed ? "asked Safari for a new window of \(profile) (File › New Window)" : "Safari's File › New Window has no item for \(profile)")
            done(pressed)
        }
        return true
    }

    func isLinked(_ profile: String) -> Bool {
        guard let entry = links[profile] else { return false }
        return entry.connection.isUp && entry.mirror.hasState
    }

    func windows(of profile: String) -> [(id: Int, state: String)] {
        guard let entry = links[profile] else { return [] }
        return ExtWindow.parse(entry.mirror.windows).map { ($0.id, $0.state) }
    }

    private func profileName(_ link: String) -> String {
        let parts = link.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return link }
        return profilesOf(parts[0]).name(parts[1])
    }
}
