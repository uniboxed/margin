// The shell's side of spaces across profiles (BrowserProfiles.swift,
// ProfileSwitch.swift): each overlay gets `across` (every profile's spaces in
// the one order, and the profiles' names and marks) in its hello and again
// whenever it changes; the space keys and a click on another profile's space
// run the cross-profile switch; the overlay's `perform` asks for what only
// the app can do across profiles (rename a profile, move a space in the whole
// order, a space made, renamed or deleted in another profile, forget one).
// The app is SwitchWorld for the switch: requests go over the links, windows
// are the copies' lists, "in front" is the window server's.
// The switch's own settings and words (app/HANDOFF.md §5, §7): `across`
// carries "Close windows to save memory" (`switchSettings`, BrowserProfiles),
// the window the switch leaves (`switching.from`: its overlay draws the
// cover) and the switch's notices by kind (SwitchNotice; the words are the
// overlay's, extension/shared/across.js SWITCH_NOTICES). The overlay's page
// asks for `switch.closeWindows`, says `switch.coverShown`, and passes a
// notice's button back (`switch.notice`).

import AppKit

// One of the switch's notices: its kind, the profile it's about (a link key,
// "safari:s-a"), the one window whose overlay shows it (none: every overlay),
// and, for a window kept open with a draft, that window (its Close window
// button closes it: no drafts check then, Tirth 2026-11-06). Only the kind,
// the profile's id and the window go to overlays; the words are theirs.
struct SwitchNotice: Equatable {
    enum Kind: String {
        case windowKeptDraft = "window-kept-draft" // close mode kept the window it left: a draft in it (§4.5)
        case dialogOpen = "dialog-open" // a sheet or dialog on the window being left (§1.10)
        case windowBusy = "window-busy" // a windows call stuck in the window being left (§1.10)
        case lateLanding = "late-landing" // a switch that gave up landed after all (§1.9)
        case windowOnDesktop = "window-on-desktop" // the copy didn't come back: its window returned to the Desktop (§1.5)
    }
    let kind: Kind
    let profile: String
    var shownIn: WindowKey?
    var kept: WindowKey?
    // How long it stays up unless a button closes it first.
    var seconds: TimeInterval { kind == .windowKeptDraft ? 20 : 8 }

    // As Shell.switchNotice keeps it: what overlays get, and the kept window (never sent).
    var stored: JSONObject {
        var o: JSONObject = ["noticeKind": kind.rawValue, "noticeProfile": Self.profileId(profile)]
        if let w = shownIn { o["noticeIn"] = ["profile": Self.profileId(w.link), "windowId": w.windowId] }
        if let k = kept { o["kept"] = ["link": k.link, "windowId": k.windowId] }
        return o
    }

    init(_ kind: Kind, profile: String, shownIn: WindowKey? = nil, kept: WindowKey? = nil) {
        self.kind = kind
        self.profile = profile
        self.shownIn = shownIn
        self.kept = kept
    }

    // The window a stored notice kept open, if it's that kind's.
    static func kept(_ stored: JSONObject?) -> WindowKey? {
        guard stored?["noticeKind"] as? String == Kind.windowKeptDraft.rawValue, let k = stored?["kept"] as? JSONObject,
              let link = k["link"] as? String, let id = int(k["windowId"]) else { return nil }
        return WindowKey(link: link, windowId: id)
    }

    // What of a stored notice an overlay gets (`across.switching`): never the kept window.
    static func sent(_ stored: JSONObject) -> JSONObject { stored.filter { ["notice", "noticeKind", "noticeProfile", "noticeIn"].contains($0.key) } }

    // A link key's profile id ("safari:s-a" → "s-a"), as overlays name profiles.
    static func profileId(_ link: String) -> String {
        guard let colon = link.firstIndex(of: ":") else { return link }
        return String(link[link.index(after: colon)...])
    }
}

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
        // Each read (changed or not): the linked copies checked against it.
        watcher.onRead = { [weak self] outcome in
            guard let self, case .read = outcome else { return }
            self.profilesOf("safari").checkMapped(self.linkedProfiles("safari"))
            self.carryOver()
        }
        // A signing change's new ids: the profile's set carried over (BrowserProfiles carrySource, DataSync carry).
        data.beforeNeed = { [weak self] p in self?.needChoice(p) ?? .ask }
        data.onCarried = { [weak self] old, new, _ in
            guard let self else { return }
            self.profilesOf(new.browser).carry(from: old.profile, to: new.profile)
            self.acrossSoon()
        }
        data.onFirstSet = { [weak self] p in if p.browser == "safari" { self?.carryOver() } }
        // The copies Margin knows (from their hellos): an entry of theirs is preferred over another live one.
        watcher.known = { [weak self] in
            guard let self else { return [] }
            return Set(self.profilesOf("safari").profiles).union(self.linkedProfiles("safari"))
        }
        safariNames = watcher
        watcher.start()
    }

    private func hasSafariSet(_ id: String) -> Bool { data.set(of: DataProfile(browser: "safari", profile: id)) != nil }

    // A Safari profile with no set yet: the set of the same Safari profile
    // under its old id, carried over; or a hold while Safari's profiles are
    // read again (none maps it yet, and there's a set that could be its);
    // else data.need as always. Without a read (no Full Disk Access): as always.
    func needChoice(_ p: DataProfile) -> DataSync.NeedChoice {
        guard p.browser == "safari" else { return .ask }
        let profiles = profilesOf("safari"), linked = linkedProfiles("safari")
        if let (old, id) = profiles.carrySource(for: p.profile, hasSet: hasSafariSet, linked: linked) {
            return .carry(from: DataProfile(browser: "safari", profile: old), why: "Safari profile \(id)")
        }
        if profiles.mightCarry(p.profile, hasSet: hasSafariSet, linked: linked) {
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
        for new in linked.sorted() {
            guard let (old, id) = profiles.carrySource(for: new, hasSet: hasSafariSet, linked: linked) else { continue }
            data.carry(from: DataProfile(browser: "safari", profile: old), to: DataProfile(browser: "safari", profile: new), why: "Safari profile \(id)")
        }
        for p in data.holding where p.browser == "safari" && profiles.browserRead?.contains(where: { $0.margin == p.profile }) == true {
            data.release(p, why: "Safari's profiles read: it's mapped, with no set to carry over")
        }
    }

    // A Safari copy said hello: Safari's profiles read again soon, and the copy checked against that read.
    func safariCopyLinked() {
        safariNames?.soon(after: 0.3)
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

    func linkedProfiles(_ browser: String) -> Set<String> {
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
        var made: [String: (BrowserProfiles, [String: [String: JSONObject]], [String: [String: Int]], Set<String>, [JSONObject])] = [:]
        for browser in Set(links.values.map(\.connection.hello.browser)) {
            let (ids, values) = ownSpaces(browser)
            let linked = linkedProfiles(browser)
            let profiles = profilesOf(browser)
            profiles.refresh(spaces: ids, linked: linked)
            made[browser] = (profiles, values, tabCounts(browser, Array(ids.keys)), linked, spaceContents(browser, ids))
        }
        for (key, overlay) in overlays {
            guard let entry = links[key.link], let (profiles, values, counts, linked, contents) = made[entry.connection.hello.browser] else { continue }
            var across = profiles.across(for: entry.connection.hello.profile, spaces: values, counts: counts, linked: linked, switching: switchingJSON(),
                                         switchSettings: switchSettingsShown(entry.connection.hello.browser), symbol: { ProfileSymbols.dataURL($0) })
            across["contents"] = contents.filter { $0["profile"] as? String != entry.connection.hello.profile }
            guard let json = jsonString(across) else { continue }
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
        var across = profiles.across(for: entry.connection.hello.profile, spaces: values, counts: tabCounts(browser, Array(ids.keys)), linked: linked, switching: switchingJSON(),
                                     switchSettings: switchSettingsShown(browser), symbol: { ProfileSymbols.dataURL($0) })
        across["contents"] = spaceContents(browser, ids).filter { $0["profile"] as? String != entry.connection.hello.profile }
        let json = jsonString(across)
        acrossSent[overlay.key] = json
        return json
    }

    private func switchingJSON() -> JSONObject? {
        guard switcher.busy, let t = switcher.target, t.profile.contains(":") else { return switchNotice.map { SwitchNotice.sent($0) } }
        var out: JSONObject = ["profile": SwitchNotice.profileId(t.profile), "space": t.space, "phase": switcher.phase.rawValue]
        // The window it leaves: its overlay draws the cover (ui/view-model.js switchCover).
        if let from = switcher.from, let w = from.windowId { out["from"] = ["profile": SwitchNotice.profileId(from.profile), "windowId": w] }
        // The target space's contents, drawn in that window's sidebar while the switch runs (ui/view-model.js foreignSpace).
        if let content = spaceContent(t.profile, t.space) { out["content"] = content }
        if let n = switchNotice { out.merge(SwitchNotice.sent(n)) { _, new in new } }
        return out
    }

    // A space's pins, folders and Margin tabs from the app's data set for its profile (DATA.md "The data set"):
    // up to 200 pins, 50 folders, 80 tabs (newest first, the one used last marked active); an icon only a small
    // `data:` image, its own or its site's. Titles and addresses go to the overlay only, never to the log.
    // Every space's contents of each profile (smaller caps), for the other profiles' layouts: a swipe draws the
    // neighbouring space beside the current one, another profile's too (ui/behaviors/swipe.js, view-model.js).
    private func spaceContents(_ browser: String, _ ids: [String: [String]]) -> [JSONObject] {
        var out: [JSONObject] = []
        for (p, spaces) in ids.sorted(by: { $0.key < $1.key }) {
            for s in spaces.sorted() {
                if let c = spaceContent("\(browser):\(p)", s, maxTabs: 30, maxIcon: 6000) { out.append(["profile": p, "space": s, "content": c]) }
            }
        }
        return out
    }

    private func spaceContent(_ link: String, _ space: String, maxTabs: Int = 80, maxIcon: Int = 16000) -> JSONObject? {
        let parts = link.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, !space.isEmpty else { return nil }
        let p = DataProfile(browser: parts[0], profile: parts[1])
        let siteIcons = data.values("siteIcons", of: p)
        func icon(_ url: String, _ own: Any?) -> String {
            if let own = own as? String, own.hasPrefix("data:image/"), own.count <= maxIcon { return own }
            guard let u = URL(string: url), let scheme = u.scheme, let host = u.host else { return "" }
            let origin = "\(scheme)://\(host)" + (u.port.map { ":\($0)" } ?? "")
            if let d = (siteIcons[origin] as? JSONObject)?["data"] as? String, d.hasPrefix("data:image/"), d.count <= maxIcon { return d }
            return ""
        }
        func inSpace(_ collection: String) -> [(String, JSONObject)] {
            data.values(collection, of: p).compactMap { id, v in
                guard let o = v as? JSONObject, o["spaceId"] as? String == space else { return nil }
                return (id, o)
            }
        }
        let pins: [JSONObject] = inSpace("pins").prefix(200).map { id, o in
            let url = o["url"] as? String ?? ""
            return ["id": id, "title": o["title"] as? String ?? "", "url": url, "icon": icon(url, nil), "folderId": o["folderId"] as? String ?? NSNull(), "pos": num(o["pos"]) ?? 0]
        }
        let folders: [JSONObject] = inSpace("folders").prefix(50).map { id, o in
            ["id": id, "name": o["name"] as? String ?? "", "open": o["open"] as? Bool ?? true, "pos": num(o["pos"]) ?? 0]
        }
        let sorted = inSpace("tabs").sorted { (num($0.1["order"]) ?? 0) > (num($1.1["order"]) ?? 0) }.prefix(maxTabs)
        let last = sorted.max { (num($0.1["lastUsed"]) ?? 0) < (num($1.1["lastUsed"]) ?? 0) }?.0
        let tabs: [JSONObject] = sorted.map { id, o in
            let url = o["url"] as? String ?? ""
            return ["id": id, "title": o["title"] as? String ?? "", "url": url, "icon": icon(url, o["icon"]), "active": id == last]
        }
        return ["space": space, "pins": pins, "folders": folders, "tabs": tabs]
    }

    // One of the switch's notices, up for its time (or until a button, or another notice, takes its place).
    func showSwitchNotice(_ notice: SwitchNotice) {
        let at = options.clock()
        var stored = notice.stored
        stored["at"] = at
        switchNotice = stored
        Diagnostics.note("profile switch: notice \(notice.kind.rawValue) about \(notice.profile)\(notice.shownIn.map { " in \($0)" } ?? "")")
        pushAcross()
        Timer.scheduledTimer(withTimeInterval: notice.seconds, repeats: false) { [weak self] _ in MainActor.assumeIsolated {
            guard let self, let n = self.switchNotice, num(n["at"]) == at else { return }
            self.switchNotice = nil
            self.pushAcross()
        } }
    }

    // A button of the switch's notice (ui/host-app.js `switch.notice`): the notice goes; a kept
    // window's Close window closes it by its copy, with no drafts check (the person chose it).
    func switchNoticeAction(kind: String, action: String) {
        guard let n = switchNotice, n["noticeKind"] as? String == kind else { return }
        let kept = SwitchNotice.kept(n)
        switchNotice = nil
        pushAcross()
        guard action == "close", let kept, let entry = links[kept.link] else { return }
        Diagnostics.note("profile switch: \(kept) kept open, closed by the person")
        marginCloses.insert(kept) // not the shown window closed by the person (§13.8)
        Task { _ = try? await entry.connection.request(type: "closeWindow", payload: ["windowId": kept.windowId], windowId: kept.windowId) }
    }

    // The switching cover drawn in `overlay` (its page's word: app/overlay/overlay.js): the freeze may start
    // on it (app/HANDOFF.md §1.5, else 250 ms after the start). Only the window the switch leaves counts.
    // Today's close-based switch has no cover, so this is heard only once the handoff runs.
    func switchCoverShown(_ overlay: OverlayController) {
        guard switcher.busy, let from = switcher.from, from.profile == overlay.key.link, from.windowId == overlay.key.windowId else { return }
        Diagnostics.note("profile switch: the cover is drawn in \(overlay.key)")
        switcher.coverShown(in: overlay.key)
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
    // `isRepeat`: a held key's repeat, which goes through the window's own
    // profile's spaces but stops before another profile's (BrowserProfiles.spaceStep).
    func spaceKey(_ overlay: OverlayController, _ dir: Int, isRepeat: Bool = false) -> Bool {
        guard let entry = links[overlay.key.link] else { return false }
        let browser = entry.connection.hello.browser
        let profiles = profilesOf(browser)
        guard let here = currentSpace(overlay),
              let step = profiles.spaceStep(from: here, profile: entry.connection.hello.profile, dir: dir, isRepeat: isRepeat) else { return false }
        switch step {
        case .held:
            return true
        case .across(let next):
            spaceAim[overlay.key] = (next, options.switchClock.now())
            startSwitch(from: overlay, to: next)
            return true
        case .own(let next):
            spaceAim[overlay.key] = (next, options.switchClock.now())
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
        case "switch.closeWindows":
            // "Close windows to save memory", for the whole browser: every overlay hears it with its next across.
            guard let on = arg["on"] as? Bool else { return }
            if profiles.setCloseWindows(on) {
                Diagnostics.note("\(browser): close windows to save memory \(on ? "on" : "off")")
                acrossSoon()
                // On with windows parked: each closed by its copy, drafts permitting (HANDOFF.md §5).
                if on { switcher.closeParkedWindows() }
            }
        case "switch.coverShown":
            switchCoverShown(overlay)
        case "switch.notice":
            guard let kind = arg["kind"] as? String, let action = arg["action"] as? String else { return }
            switchNoticeAction(kind: kind, action: action)
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

    // A profile with no window (its copy not running): Safari's own menu opens one, through Accessibility. Its
    // copy starts with it and links; the switch goes on then (ProfileSwitch waitingForProfile).
    func openProfileWindow(_ profile: String) -> Bool {
        guard options.safariAX, SafariAX.trusted, profile.hasPrefix("safari:"),
              let pid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first?.processIdentifier,
              case let name = profilesOf("safari").browserNames[SwitchNotice.profileId(profile)]?.name ?? profileName(profile), !name.isEmpty else { return false }
        openedFor[profile] = (pid, axWindows(of: profile))
        safariAX.newWindow(pid: pid, profileName: name) { [weak self] pressed in
            guard let self else { return }
            Diagnostics.note(pressed ? "asked Safari for a new window of \(profile) (File › New Window)" : "Safari's File › New Window has no item for \(profile): the person is told to open one")
            if !pressed, let t = self.switcher.target, t.profile == profile { self.switchChanged(.needsProfile(t)) }
        }
        return true
    }

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
                    if type == "openSpaceWindow", let made = SpaceWindowAnswer(result) { self.windowMade(profile, windowId: made.windowId, asked: asked, bounds: made.bounds) }
                    done(result, nil)
                } else { done(nil, Diagnostics.scrub(reply["error"] as? String ?? "refused", max: 160)) } // a browser's words: never a page's
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
        case .started(let t): words = nil; carrySettings(to: t.profile)
        case .done(let t): words = nil; openedFor[t.profile] = nil
        case .needsProfile(let t): words = "\(profileName(t.profile)) isn’t open in Safari. Open one of its windows (File › New Window › New \(profileName(t.profile)) Window) and Margin shows the space there."
        case .failed(let t, let why):
            // Margin opened the profile's window, but its copy never linked: Margin is off in that profile (Safari
            // turned it off, or the person did). Told so, and the window Margin opened is closed again.
            if let opened = openedFor.removeValue(forKey: t.profile) {
                let name = profileName(t.profile)
                for n in Set(axWindows(of: t.profile)).subtracting(opened.before) { safariAX.closeWindow(pid: opened.pid, number: n) }
                let id = SwitchNotice.profileId(t.profile)
                if SafariAX.marginEnabled(profile: id) == false {
                    words = "Margin is turned off in \(name). Turn it on in Safari › Settings › Extensions (with \(name) chosen at the top), then switch again."
                } else {
                    words = "Margin didn’t start in \(name)’s window. Check that Margin is on in Safari › Settings › Extensions for \(name), then switch again."
                }
            } else {
                words = "Couldn’t switch to \(profileName(t.profile)): \(why). Nothing was closed."
            }
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

    // The window a switch leaves, as it looks, given to the profile it goes to before its window shows (Tirth,
    // 2026-11-07: "it should match all the configuration of the previous window like a snapshot"): Keep open,
    // the frame when the sidebar is hidden, the theme and the themes' settings (the sidebar's width). Written to
    // that profile's settings by its copy (`updateSettings`), only when they differ; again when its copy links
    // during the switch (a profile whose window Margin just opened).
    static let carriedSettings = ["sidebarPinnedOpen", "frameWhenHidden", "theme", "themes"]
    func carrySettings(to link: String) {
        guard let from = switcher.from?.profile, from != link, let a = links[from], let b = links[link], b.connection.isUp,
              let settings = a.mirror.value("settings") as? JSONObject else { return }
        var patch: JSONObject = [:]
        for k in Self.carriedSettings { if let v = settings[k] { patch[k] = v } }
        guard !patch.isEmpty else { return }
        if let current = b.mirror.value("settings") as? JSONObject,
           NSDictionary(dictionary: current.filter { patch[$0.key] != nil }).isEqual(to: patch) { return }
        Diagnostics.note("profile switch: \(link) given the sidebar and theme settings of the window it comes from (\(from))")
        Task { _ = try? await b.connection.request(type: "updateSettings", payload: ["patch": patch], windowId: nil) }
    }

    private func profileName(_ link: String) -> String {
        let parts = link.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return link }
        return profilesOf(parts[0]).name(parts[1])
    }
}
