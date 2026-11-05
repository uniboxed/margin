// The shell's side of spaces across profiles (BrowserProfiles.swift,
// ProfileSwitch.swift): each overlay gets `across` (every profile's spaces in
// the one order, and the profiles' names and marks) in its hello and again
// whenever it changes; the space keys and a click on another profile's space
// run the cross-profile switch; the overlay's `perform` asks for what only
// the app can do across profiles (rename a profile, move a space in the whole
// order, a space made, renamed or deleted in another profile, forget one).
// The app is SwitchWorld for the switch: requests go over the links, windows
// are the copies' lists, "in front" is the window server's.

import AppKit

extension Shell: SwitchWorld {
    // ---- the profiles of a browser ----

    func profilesOf(_ browser: String) -> BrowserProfiles {
        if let p = browserProfiles[browser] { return p }
        let p = BrowserProfiles(browser: browser, root: data.store.root)
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
            let changed: Bool
            switch outcome {
            case .read(let list): changed = profiles.useBrowserNames(list)
            case .noAccess, .noSafari, .failed: changed = profiles.dropBrowserNames()
            case .busy: changed = false
            }
            if changed { self.acrossSoon() }
        }
        safariNames = watcher
        watcher.start()
    }

    // Each profile's spaces in its own order (its set's, or its copy's state while linked).
    private func ownSpaces(_ browser: String) -> (ids: [String: [String]], values: [String: [String: JSONObject]]) {
        var ids: [String: [String]] = [:]
        var values: [String: [String: JSONObject]] = [:]
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
            values[p] = list
            ids[p] = list.keys.sorted { (num(list[$0]?["order"]) ?? 0, $0) < (num(list[$1]?["order"]) ?? 0, $1) }
        }
        return (ids, values)
    }

    private func linkedProfiles(_ browser: String) -> Set<String> {
        Set(links.values.filter { $0.connection.hello.browser == browser && $0.connection.isUp }.map(\.connection.hello.profile))
    }

    // Each space's Margin tabs (open or not), from the app's sets.
    private func tabCounts(_ browser: String, _ profiles: [String]) -> [String: [String: Int]] {
        var out: [String: [String: Int]] = [:]
        for p in profiles {
            for (_, v) in data.values("tabs", of: DataProfile(browser: browser, profile: p)) {
                guard let s = (v as? JSONObject)?["spaceId"] as? String else { continue }
                out[p, default: [:]][s, default: 0] += 1
            }
        }
        return out
    }

    // The order brought up to date, then every overlay told if its `across` changed (on the next turn).
    func acrossSoon() {
        guard !acrossQueued else { return }
        acrossQueued = true
        DispatchQueue.main.async { MainActor.assumeIsolated {
            self.acrossQueued = false
            self.pushAcross()
        } }
    }

    func pushAcross() {
        var made: [String: (BrowserProfiles, [String: [String: JSONObject]], [String: [String: Int]], Set<String>)] = [:]
        for browser in Set(links.values.map(\.connection.hello.browser)) {
            let (ids, values) = ownSpaces(browser)
            let linked = linkedProfiles(browser)
            let profiles = profilesOf(browser)
            profiles.refresh(spaces: ids, linked: linked)
            made[browser] = (profiles, values, tabCounts(browser, Array(ids.keys)), linked)
        }
        for (key, overlay) in overlays {
            guard let entry = links[key.link], let (profiles, values, counts, linked) = made[entry.connection.hello.browser] else { continue }
            guard let json = jsonString(profiles.across(for: entry.connection.hello.profile, spaces: values, counts: counts, linked: linked, switching: switchingJSON(), symbol: { ProfileSymbols.dataURL($0) })) else { continue }
            if acrossSent[key] == json { continue }
            acrossSent[key] = json
            overlay.push(raw: #"{"type":"across","across":"# + json + "}")
        }
        acrossSent = acrossSent.filter { overlays[$0.key] != nil }
    }

    func acrossJSON(for overlay: OverlayController) -> String? {
        guard let entry = links[overlay.key.link] else { return nil }
        let browser = entry.connection.hello.browser
        let (ids, values) = ownSpaces(browser)
        let linked = linkedProfiles(browser)
        let profiles = profilesOf(browser)
        profiles.refresh(spaces: ids, linked: linked)
        let json = jsonString(profiles.across(for: entry.connection.hello.profile, spaces: values, counts: tabCounts(browser, Array(ids.keys)), linked: linked, switching: switchingJSON(), symbol: { ProfileSymbols.dataURL($0) }))
        acrossSent[overlay.key] = json
        return json
    }

    private func switchingJSON() -> JSONObject? {
        guard switcher.busy, let t = switcher.target, let colon = t.profile.firstIndex(of: ":") else { return switchNotice }
        var out: JSONObject = ["profile": String(t.profile[t.profile.index(after: colon)...]), "space": t.space, "phase": switcher.phase.rawValue]
        if let n = switchNotice { out["notice"] = n["notice"] }
        return out
    }

    // The window's space now: its copy's activeSpaceByWindow (or the chained one, a moment after a key).
    private func currentSpace(_ overlay: OverlayController) -> SpaceKey? {
        guard let entry = links[overlay.key.link] else { return nil }
        let profile = entry.connection.hello.profile
        if let aim = spaceAim[overlay.key], options.switchClock.now() - aim.at < 1.5 { return aim.key }
        let open = entry.mirror.value("openTabs") as? JSONObject
        let active = (open?["activeSpaceByWindow"] as? JSONObject)?[String(overlay.key.windowId)] as? String
        let first = (entry.mirror.value("spaces") as? [Any])?.first.flatMap { ($0 as? JSONObject)?["id"] as? String }
        guard let space = active ?? first else { return nil }
        return SpaceKey(profile: profile, space: space)
    }

    // ⌃⌘→/←: the next space in the whole order. True if it was handled here
    // (more than one profile has spaces); false: the copy's own `navigate`, as before.
    func spaceKey(_ overlay: OverlayController, _ dir: Int) -> Bool {
        guard let entry = links[overlay.key.link] else { return false }
        let browser = entry.connection.hello.browser
        let profiles = profilesOf(browser)
        guard Set(profiles.order.map(\.profile)).count > 1, let here = currentSpace(overlay),
              let next = profiles.neighbour(of: here, dir) else { return false }
        spaceAim[overlay.key] = (next, options.switchClock.now())
        if next.profile == here.profile {
            // The copy's own next space is this one: today's navigate (held keys and all); else straight to it.
            let own = profiles.order.filter { $0.profile == here.profile }
            let at = own.firstIndex(of: here) ?? 0
            let copyNext = own.isEmpty ? nil : own[(at + (dir < 0 ? -1 : 1) + own.count) % own.count]
            let windowId = overlay.key.windowId
            if copyNext == next {
                Task { _ = try? await entry.connection.request(type: "navigate", payload: ["action": dir > 0 ? "next-space" : "prev-space", "windowId": windowId], windowId: windowId) }
            } else {
                Task { _ = try? await entry.connection.request(type: "setSpace", payload: ["windowId": windowId, "spaceId": next.space], windowId: windowId) }
            }
            return true
        }
        startSwitch(from: overlay, to: next)
        return true
    }

    func startSwitch(from overlay: OverlayController, to next: SpaceKey) {
        guard let entry = links[overlay.key.link] else { return }
        let browser = entry.connection.hello.browser
        switcher.start(.init(profile: "\(browser):\(next.profile)", space: next.space), from: overlay.key.link, windowId: overlay.key.windowId)
        burst("profile switch")
        acrossSoon()
    }

    // What the overlay's page asks the app for (host-app.js perform).
    func performAcross(from overlay: OverlayController, _ name: String, _ arg: JSONObject) {
        guard let entry = links[overlay.key.link] else { return }
        let browser = entry.connection.hello.browser
        let profiles = profilesOf(browser)
        let profile = arg["profile"] as? String ?? ""
        switch name {
        case "profile.switch":
            guard let space = arg["space"] as? String, profiles.order.contains(SpaceKey(profile: profile, space: space)) else { return }
            if profile == entry.connection.hello.profile {
                Task { _ = try? await entry.connection.request(type: "setSpace", payload: ["windowId": overlay.key.windowId, "spaceId": space], windowId: overlay.key.windowId) }
            } else {
                startSwitch(from: overlay, to: SpaceKey(profile: profile, space: space))
            }
        case "profile.rename":
            if profiles.rename(profile, name: arg["name"] as? String ?? "", emoji: arg["emoji"] as? String ?? "", color: arg["color"] as? String) { acrossSoon() }
        case "profile.forget":
            // Not the window's own profile, nor one that's linked: it would come straight back.
            guard profile != entry.connection.hello.profile, !linkedProfiles(browser).contains(profile) else { return }
            if profiles.forget(profile) { acrossSoon() }
        case "space.move":
            guard let space = arg["space"] as? String, let dir = int(arg["dir"]) else { return }
            let key = SpaceKey(profile: profile, space: space)
            let (moved, own) = profiles.move(key, by: dir)
            guard moved else { return }
            if let own { writeOwnOrder(browser, profile, own) }
            acrossSoon()
        case "profile.space":
            // A space made, renamed or deleted in another profile: by its copy if it's linked, else in its set.
            guard let type = arg["type"] as? String, ["createSpace", "renameSpace", "deleteSpace"].contains(type) else { return }
            let payload = arg["payload"] as? JSONObject ?? [:]
            spaceInProfile(browser, profile, type, payload)
        default:
            Diagnostics.note("\(overlay.key): \(name) isn't known")
        }
    }

    // A profile's own order (its spaces' `order`), as the whole order now has it.
    private func writeOwnOrder(_ browser: String, _ profile: String, _ ids: [String]) {
        if let entry = links["\(browser):\(profile)"] {
            Task { _ = try? await entry.connection.request(type: "orderSpaces", payload: ["spaceIds": ids], windowId: nil) }
            return
        }
        let p = DataProfile(browser: browser, profile: profile)
        let values = data.values("spaces", of: p)
        let t = (Date().timeIntervalSince1970 * 1000).rounded()
        let changes = ids.enumerated().compactMap { n, id -> DataChange? in
            guard var v = values[id] as? JSONObject, int(v["order"]) != n else { return nil }
            v["order"] = n
            return DataChange(collection: "spaces", id: id, item: DataItem(updatedAt: t, value: v))
        }
        if !changes.isEmpty { data.change(p, changes) }
    }

    private func spaceInProfile(_ browser: String, _ profile: String, _ type: String, _ payload: JSONObject) {
        if let entry = links["\(browser):\(profile)"] {
            var body = payload
            body["windowId"] = nil // not a window of that copy's
            Task { _ = try? await entry.connection.request(type: type, payload: body, windowId: nil) }
            return
        }
        let p = DataProfile(browser: browser, profile: profile)
        let values = data.values("spaces", of: p)
        let t = (Date().timeIntervalSince1970 * 1000).rounded()
        switch type {
        case "createSpace":
            let id = "s" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10).lowercased()
            let order = (values.values.compactMap { num(($0 as? JSONObject)?["order"]) }.max() ?? -1) + 1
            let v: JSONObject = ["name": payload["name"] as? String ?? "New Space", "emoji": payload["emoji"] as? String ?? "", "color": payload["color"] as? String ?? "", "order": order]
            data.change(p, [DataChange(collection: "spaces", id: id, item: DataItem(updatedAt: t, value: v))])
        case "renameSpace":
            guard let id = payload["spaceId"] as? String, var v = values[id] as? JSONObject else { return }
            for k in ["name", "emoji", "color"] { if let x = payload[k] as? String { v[k] = x } }
            data.change(p, [DataChange(collection: "spaces", id: id, item: DataItem(updatedAt: t, value: v))])
        default:
            // Deleting moves its tabs and pins to the profile's first space: its copy's work (state/model.js deleteSpace).
            switchNotice = ["notice": "Open a window of \(profilesOf(browser).name(profile)) to delete its spaces."]
            pushAcross()
            switchNotice = nil
        }
        acrossSoon()
    }

    // ---- SwitchWorld ----

    func isLinked(_ profile: String) -> Bool {
        guard let entry = links[profile] else { return false }
        return entry.connection.isUp && entry.mirror.hasState
    }

    func request(_ profile: String, _ type: String, _ payload: JSONObject, windowId: Int?, done: @escaping (JSONObject?, String?) -> Void) {
        guard let entry = links[profile] else { return done(nil, "not linked") }
        let asked = options.clock()
        Task {
            do {
                let reply = try await entry.connection.request(type: type, payload: payload, windowId: windowId)
                if reply["ok"] as? Bool == true {
                    let result = reply["result"] as? JSONObject ?? [:]
                    if type == "openSpaceWindow", let id = int(result["windowId"]) { self.windowMade(profile, windowId: id, asked: asked) }
                    done(result, nil)
                } else { done(nil, reply["error"] as? String ?? "refused") }
            } catch {
                done(nil, "\(error)")
            }
            self.burst("switch request")
        }
    }

    func windows(of profile: String) -> [(id: Int, state: String)] {
        guard let entry = links[profile] else { return [] }
        return ExtWindow.parse(entry.mirror.windows, link: profile).map { ($0.key.windowId, $0.state) }
    }

    func inFront(_ profile: String, windowId: Int) -> Bool {
        guard let entry = links[profile], let number = matches[WindowKey(link: profile, windowId: windowId)] else { return false }
        var pids = options.bundleIds[entry.connection.hello.browser].map { apps.pids(of: $0) } ?? []
        if let pid = entry.connection.hello.pid { pids.insert(pid_t(pid)) }
        let list = windowSource.windows(of: pids)
        let first = WindowMatcher.candidates(list, pids: pids).filter(\.onScreen).min { $0.order < $1.order }
        return first?.number == number
    }

    func switchChanged(_ event: ProfileSwitch.Event) {
        let words: String?
        switch event {
        case .started: words = nil
        case .done: words = nil
        case .needsProfile(let t): words = "\(profileName(t.profile)) isn’t open in Safari. Open one of its windows (File › New Window › New \(profileName(t.profile)) Window) and Margin shows the space there."
        case .failed(let t, let why): words = "Couldn’t switch to \(profileName(t.profile)): \(why). Nothing was closed."
        case .cancelled: words = nil
        }
        switchNotice = words.map { ["notice": $0] }
        Diagnostics.note("profile switch: \(event)")
        pushAcross()
        if case .needsProfile = event {} else {
            switchNotice = nil
            // A failure's words stay a while, then go.
            if words != nil { Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in MainActor.assumeIsolated { if self?.switcher.busy == false { self?.pushAcross() } } } }
        }
        burst("profile switch")
    }

    private func profileName(_ link: String) -> String {
        let parts = link.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return link }
        return profilesOf(parts[0]).name(parts[1])
    }
}
