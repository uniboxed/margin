// Safari's profile names (SafariProfiles.swift, BrowserProfiles.swift), part
// of tests.swift's run, against a stand-in for Safari's folder made here in a
// temporary folder (its tab database with the schema Safari 27.2 has, each
// profile's Extensions.plist), never Safari's own: the profiles read, the
// default profile, a copy linked to its profile, another extension's entry
// and an unsigned build's, Safari closed (no write-ahead log: nothing made
// beside the database), a busy database, no permission, no Safari, a
// database that isn't Safari's, a rename and a new profile picked up by the
// watcher, and the names used: Safari's over a typed one, Edit Profile
// keeping the name, the typed names back without the permission, a profile
// deleted in Safari, and the symbol's picture.
import AppKit
import Foundation
import SQLite3

func waitUntil(_ seconds: TimeInterval, _ done: () -> Bool) {
    let until = Date().addingTimeInterval(seconds)
    while !done(), Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
}

func safariProfilesTests() {
    let personal = "s-" + FakeSafari.personalCopy.lowercased()
    let test = "s-" + FakeSafari.testCopy.lowercased()

    // ---- the reader ----
    let safari = FakeSafari()
    defer { safari.remove() }
    check("safari: no database yet, the folder readable: access", SafariProfiles.access(safari.folder) == .granted)
    check("safari: no database: no Safari data", SafariProfiles.read(safari.folder) == .noSafari)
    safari.standard()
    check("safari: Safari open (its log there)", FileManager.default.fileExists(atPath: safari.dbPath + "-wal"))
    guard case .read(let list) = SafariProfiles.read(safari.folder) else { return check("safari: read", false, "\(SafariProfiles.read(safari.folder))") }
    check("safari: the profiles, in Safari's order, not the deleted one nor tab groups", list.map(\.name) == ["Work", "Personal", "Test"], "\(list.map(\.name))")
    check("safari: the default profile is s-default", list.first?.serverId == "DefaultProfile" && list.first?.margin == "s-default")
    check("safari: a copy linked through Margin's entry in its profile's Extensions.plist", list.count > 1 && list[1].margin == personal, "\(list.map { $0.margin ?? "-" })")
    check("safari: another extension's entry is never taken for Margin's", list.count > 2 && list[2].margin == nil)
    check("safari: the symbols", list.map(\.symbol) == ["person.fill", "person.lanyardcard.fill", "person.lanyardcard.fill"], "\(list.map(\.symbol))")
    check("safari: Safari's ids", list.count > 2 && list[1].serverId == FakeSafari.personalServer && list[2].serverId == FakeSafari.testServer)
    check("safari: the log says names and ids, never a page", !SafariProfiles.describe(.read(list)).contains("example.com") && SafariProfiles.describe(.read(list)).contains("“Personal”"))
    // An unsigned build's entry ("(UNSIGNED)"), and one whose id isn't a UUID.
    safari.extensions(FakeSafari.testServer, ["com.unibox.margin.Extension (UNSIGNED)": ["ProfileIdentifier": FakeSafari.testCopy]])
    check("safari: an unsigned build's entry", SafariProfiles.marginProfile(safari.folder, folders: [FakeSafari.testServer], extensionId: SafariProfiles.marginExtension) == test)
    safari.extensions(FakeSafari.testServer, ["com.unibox.margin.Extension (UNSIGNED)": ["ProfileIdentifier": "not a uuid"]])
    check("safari: an id that isn't a UUID: no link", SafariProfiles.marginProfile(safari.folder, folders: [FakeSafari.testServer], extensionId: SafariProfiles.marginExtension) == nil)
    check("safari: a folder name that isn't an id: never read", SafariProfiles.marginProfile(safari.folder, folders: ["../Profiles"], extensionId: SafariProfiles.marginExtension) == nil)
    check("safari: a symbol that isn't a symbol's name: none", SafariProfiles.symbol(try? PropertyListSerialization.data(fromPropertyList: ["SymbolImageName": "../x y"], format: .binary, options: 0)) == "")

    // ---- which of Margin's entries (a real Mac's named profiles: the removed unsigned build beside the signed one) ----
    let ext = SafariProfiles.marginExtension
    let day = { (d: Int) in Date(timeIntervalSinceReferenceDate: 783_000_000 + Double(d) * 86_400) }
    let idA = "5068E0E4-81AA-4EC4-A74A-BB4DA5A64A41", idB = FakeSafari.personalCopy
    let sA = "s-" + idA.lowercased(), sB = personal
    let removedUnsigned: [String: Any] = ["Enabled": false, "AddedDate": day(0), "RemovedDate": day(6), "ProfileIdentifier": idA]
    let liveTeam: [String: Any] = ["Enabled": true, "AddedDate": day(5), "ProfileIdentifier": idB]
    let realEntries: [String: Any] = ["\(ext) (UNSIGNED)": removedUnsigned, "\(ext) (VSNN5UW99X)": liveTeam,
                                      "com.unibox.margin-move-test.Extension (VSNN5UW99X)": ["Enabled": true, "AddedDate": day(10), "RemovedDate": day(11), "ProfileIdentifier": "77777777-7777-4777-8777-777777777777"]]
    let a = SafariProfiles.entries(realEntries, extensionId: ext, team: "VSNN5UW99X")
    check("entries: (UNSIGNED) removed and off beside the team's live one, this build the team's: the team's, though UNSIGNED sorts first", a.chosen == sB && a.suffix == "VSNN5UW99X" && a.count == 2, "\(a)")
    let b = SafariProfiles.entries(realEntries, extensionId: ext, team: nil)
    check("entries: the same with an unsigned build: still the live one, never the removed", b.chosen == sB && b.suffix == "VSNN5UW99X", "\(b)")
    let c = SafariProfiles.entries(["\(ext) (UNSIGNED)": removedUnsigned], extensionId: ext, team: nil)
    check("entries: only a removed entry: none (the typed name is kept)", c.chosen == nil && c.count == 1, "\(c)")
    let twoLive: [String: Any] = ["\(ext) (UNSIGNED)": ["Enabled": true, "AddedDate": day(0), "ProfileIdentifier": idA], "\(ext) (VSNN5UW99X)": liveTeam]
    check("entries: two live, this build unsigned: the UNSIGNED one", SafariProfiles.entries(twoLive, extensionId: ext, team: nil).chosen == sA)
    check("entries: two live, this build the team's: the team's", SafariProfiles.entries(twoLive, extensionId: ext, team: "VSNN5UW99X").chosen == sB)
    let enabledRemoved: [String: Any] = ["\(ext) (ZZZZZ00000)": ["Enabled": true, "AddedDate": day(8), "RemovedDate": day(9), "ProfileIdentifier": idA], "\(ext) (VSNN5UW99X)": liveTeam]
    check("entries: Enabled true with a RemovedDate beside a live one: the live one", SafariProfiles.entries(enabledRemoved, extensionId: ext, team: "OTHER00000").chosen == sB)
    check("entries: Enabled true with a RemovedDate alone: none", SafariProfiles.entries(["\(ext) (ZZZZZ00000)": enabledRemoved["\(ext) (ZZZZZ00000)"]!], extensionId: ext, team: nil).chosen == nil)
    let readded: [String: Any] = ["\(ext) (VSNN5UW99X)": ["Enabled": true, "AddedDate": day(9), "RemovedDate": day(6), "ProfileIdentifier": idB]]
    check("entries: added again after an old RemovedDate: taken", SafariProfiles.entries(readded, extensionId: ext, team: "VSNN5UW99X").chosen == sB)
    let reenabled: [String: Any] = ["\(ext) (VSNN5UW99X)": ["Enabled": true, "AddedDate": day(1), "RemovedDate": day(6), "EnabledModificationDate": day(7), "ProfileIdentifier": idB]]
    check("entries: turned on again after its RemovedDate: taken", SafariProfiles.entries(reenabled, extensionId: ext, team: nil).chosen == sB)
    let twoOthers: [String: Any] = ["\(ext) (AAAAA11111)": ["Enabled": true, "AddedDate": day(1), "ProfileIdentifier": idA], "\(ext) (BBBBB22222)": ["Enabled": true, "AddedDate": day(2), "ProfileIdentifier": idB]]
    check("entries: neither the build's team: the copy Margin knows from a hello", SafariProfiles.entries(twoOthers, extensionId: ext, team: nil, known: [sA]).chosen == sA)
    check("entries: neither known: the newest", SafariProfiles.entries(twoOthers, extensionId: ext, team: nil).chosen == sB)
    let offNewer: [String: Any] = ["\(ext) (AAAAA11111)": ["Enabled": true, "AddedDate": day(1), "ProfileIdentifier": idA], "\(ext) (BBBBB22222)": ["Enabled": false, "AddedDate": day(2), "ProfileIdentifier": idB]]
    check("entries: an enabled one over a newer one turned off", SafariProfiles.entries(offNewer, extensionId: ext, team: nil).chosen == sA)
    check("entries: another bundle id that starts the same is never Margin's", SafariProfiles.entries(["\(ext)Other (X)": liveTeam, "\(ext)2 (VSNN5UW99X)": liveTeam], extensionId: ext, team: "VSNN5UW99X").count == 0)
    // Through the files, as a real Mac has them: both named profiles with the removed unsigned entry.
    let idA2 = "BE3F2B99-F245-4869-B8C3-25B40B7A3316", idB2 = "4282EA5B-775B-400D-BE65-CB1B668E7367"
    safari.extensions(FakeSafari.personalServer, realEntries.merging(["com.example.other.Extension (ZZZZZ99999)": ["Enabled": true, "ProfileIdentifier": "99999999-9999-4999-8999-999999999999"]]) { a, _ in a })
    safari.extensions(FakeSafari.testServer, ["\(ext) (UNSIGNED)": ["Enabled": false, "AddedDate": day(0), "RemovedDate": day(6), "ProfileIdentifier": idA2],
                                              "\(ext) (VSNN5UW99X)": ["Enabled": true, "AddedDate": day(5), "ProfileIdentifier": idB2]])
    if case .read(let l) = SafariProfiles.read(safari.folder, team: "VSNN5UW99X") {
        check("read: Personal → the signed entry's copy, Test → its own", l.map { $0.margin ?? "-" } == ["s-default", sB, "s-" + idB2.lowercased()], "\(l.map { $0.margin ?? "-" })")
        let line = SafariProfiles.describe(.read(l))
        check("read: the log says the entry used and how many", line.contains("→ \(sB) (VSNN5UW99X, 2 entries)") && line.contains("→ s-default;") && !line.contains("example") && !line.contains("move-test") && !line.contains(sA), line)
        // Safari's names given to the copies that link.
        let named = tempFolder("names-signed")
        defer { try? FileManager.default.removeItem(at: named) }
        let np = BrowserProfiles(browser: "safari", root: named)
        np.refresh(spaces: [sB: ["a"]], linked: [sB])
        np.useBrowserNames(l)
        check("names: the signed entry's copy gets “Personal”", np.name(sB) == "Personal" && BrowserProfiles(browser: "safari", root: named).info[sB]?.browserId == FakeSafari.personalServer, np.name(sB))
    } else { check("read: the real Mac's layout read", false) }
    if case .read(let l) = SafariProfiles.read(safari.folder, team: nil) {
        check("read, an unsigned build: still the live entries", l.dropFirst().map { $0.margin ?? "-" } == [sB, "s-" + idB2.lowercased()])
    } else { check("read: unsigned", false) }
    safari.extensions(FakeSafari.testServer, ["\(ext) (UNSIGNED)": ["Enabled": false, "AddedDate": day(0), "RemovedDate": day(6), "ProfileIdentifier": idA2]])
    if case .read(let l) = SafariProfiles.read(safari.folder, team: "VSNN5UW99X") {
        check("read: a profile with only a removed entry: no copy", l.last?.margin == nil && l.last?.entries == 1)
        check("read: and the log says so", SafariProfiles.describe(.read(l)).contains("no copy yet (1 entry, none live)"), SafariProfiles.describe(.read(l)))
    } else { check("read: removed only", false) }
    safari.standardExtensions()

    // Linked copies no profile maps to: said once each, and only after a read.
    let said0 = Diagnostics.echo
    var lines: [String] = []
    Diagnostics.echo = { lines.append($0) }
    let mp = BrowserProfiles(browser: "safari", root: nil)
    check("mapped: no read yet: nothing said", mp.checkMapped([sA, sB, "s-default"]).isEmpty && lines.isEmpty)
    let read1 = [SafariProfile(serverId: "DefaultProfile", uuid: "DefaultProfile", name: "Work", symbol: "", margin: "s-default"),
                 SafariProfile(serverId: FakeSafari.personalServer, uuid: "A9", name: "Personal", symbol: "", margin: sB)]
    mp.useBrowserNames(read1)
    check("mapped: after a read, the copy no profile has: said", mp.checkMapped([sA, sB, "s-default", "p-own"]) == [sA] && lines.contains { $0.contains("copy \(sA) isn't any Safari profile's as read") })
    check("mapped: once", mp.checkMapped([sA, sB]).isEmpty)
    mp.dropBrowserNames()
    check("mapped: no permission any more: nothing", mp.checkMapped(["s-" + idB2.lowercased()]).isEmpty)
    mp.useBrowserNames(read1.map { var p = $0; if p.margin == sB { p.margin = sA }; return p })
    check("mapped: a read that maps it: nothing said", mp.checkMapped([sA]).isEmpty)
    mp.useBrowserNames(read1)
    check("mapped: mapped by a read, then not again: said again", mp.checkMapped([sA]) == [sA])
    check("mapped: the line has ids only", lines.allSatisfy { !$0.contains("Personal") && !$0.contains("Work") })
    Diagnostics.echo = said0

    // A busy database: another connection holding it (exclusive locking, as no reader can get past).
    safari.close()
    let holder = FakeSafari.holder(safari.dbPath)
    check("safari: held: its log there", FileManager.default.fileExists(atPath: safari.dbPath + "-wal"))
    let busy = SafariProfiles.read(safari.folder, busyTimeoutMs: 50)
    check("safari: a busy database: busy, nothing used", busy == .busy, "\(busy)")
    sqlite3_close(holder)
    safari.open(schema: "")
    check("safari: let go: read again", { if case .read = SafariProfiles.read(safari.folder) { return true }; return false }())

    // No write-ahead log (macOS's SQLite keeps an empty one when Safari closes;
    // with none there): the file read alone, nothing made beside it.
    safari.close()
    try? FileManager.default.removeItem(atPath: safari.dbPath + "-wal")
    try? FileManager.default.removeItem(atPath: safari.dbPath + "-shm")
    let before = try? FileManager.default.contentsOfDirectory(atPath: safari.folder.path).sorted()
    check("safari: no log", !FileManager.default.fileExists(atPath: safari.dbPath + "-wal"), "\(before ?? [])")
    check("safari: closed: still read", { if case .read(let l) = SafariProfiles.read(safari.folder) { return l.count == 3 }; return false }())
    check("safari: closed: nothing made in Safari's folder", (try? FileManager.default.contentsOfDirectory(atPath: safari.folder.path).sorted()) == before)

    // No permission: the database can't be opened (as without Full Disk Access).
    try? FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: safari.dbPath)
    check("safari: no permission: denied", SafariProfiles.access(safari.folder) == .denied)
    check("safari: no permission: nothing read", SafariProfiles.read(safari.folder) == .noAccess)
    try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: safari.dbPath)
    check("safari: no folder: no Safari", SafariProfiles.access(safari.folder.appendingPathComponent("none")) == .noSafari)

    // Not Safari 27.2's table: nothing used.
    let odd = FakeSafari()
    odd.open(schema: "CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, title TEXT, type INTEGER);")
    check("safari: not the table Safari has: not read", { if case .failed = SafariProfiles.read(odd.folder) { return true }; return false }())
    odd.remove()

    // ---- the watcher ----
    safari.open(schema: "") // Safari again (its log back)
    var options = SafariProfileWatcher.Options()
    options.debounce = 0.15
    options.latency = 0.05
    options.retry = 0.3
    let watcher = SafariProfileWatcher(folder: safari.folder, options: options)
    var outcomes: [SafariProfiles.Outcome] = []
    watcher.onChange = { outcomes.append($0) }
    watcher.start()
    waitUntil(3) { !outcomes.isEmpty }
    check("watcher: the first read", { if case .read(let l) = outcomes.last { return l.count == 3 }; return false }(), "\(outcomes)")
    waitUntil(0.5) { false } // FSEvents takes a moment to start sending a new stream's events
    safari.exec("UPDATE bookmarks SET title = 'Home' WHERE id = 1562")
    waitUntil(5) { if case .read(let l) = outcomes.last { return l.contains { $0.name == "Home" } }; return false }
    check("watcher: a rename in Safari picked up", { if case .read(let l) = outcomes.last { return l.map(\.name) == ["Work", "Home", "Test"] }; return false }(), "\(outcomes.last.map(SafariProfiles.describe) ?? "nothing")")
    let reads = watcher.reads
    for n in 0..<20 { safari.exec("UPDATE bookmarks SET num_children = \(n) WHERE id = 1764") }
    waitUntil(1.5) { false }
    check("watcher: many writes at once: few reads", watcher.reads - reads <= 4, "\(watcher.reads - reads) reads")
    check("watcher: nothing new: nothing handed on", outcomes.count == 2, "\(outcomes.count)")
    safari.extensions(FakeSafari.testServer, ["com.unibox.margin.Extension (ABCDE12345)": ["ProfileIdentifier": FakeSafari.testCopy]])
    waitUntil(5) { if case .read(let l) = outcomes.last { return l.last?.margin == test }; return false }
    check("watcher: Margin turned on in another profile: linked", { if case .read(let l) = outcomes.last { return l.last?.margin == test }; return false }())
    try? FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: safari.dbPath)
    safari.exec("UPDATE bookmarks SET title = 'Home 2' WHERE id = 1562")
    waitUntil(5) { outcomes.last == .noAccess }
    check("watcher: the permission withdrawn: said", outcomes.last == .noAccess)
    try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: safari.dbPath)
    waitUntil(5) { if case .read = outcomes.last { return true }; return false }
    check("watcher: given again: read again without a change in Safari (the retry)", { if case .read(let l) = outcomes.last { return l.contains { $0.name == "Home 2" } }; return false }())
    watcher.stop()
    check("watcher: the files that matter", SafariProfileWatcher.matters("/x/Safari/SafariTabs.db-wal") && SafariProfileWatcher.matters("/x/Safari/Profiles/ABC/WebExtensions/Extensions.plist")
          && !SafariProfileWatcher.matters("/x/Safari/SafariTabs.db-shm") && !SafariProfileWatcher.matters("/x/Safari/Profiles/ABC/History.db-wal"))

    // ---- the names used ----
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-names-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let bp = BrowserProfiles(browser: "safari", root: root)
    bp.refresh(spaces: ["s-default": ["a"], personal: ["b"], "s-9": ["c"]], linked: ["s-default", personal])
    bp.rename(personal, name: "Typed", emoji: "🏠", color: "#00b894")
    let safariList = [
        SafariProfile(serverId: "DefaultProfile", uuid: "DefaultProfile", name: "Work", symbol: "person.fill", margin: "s-default"),
        SafariProfile(serverId: FakeSafari.personalServer, uuid: "A9", name: "Personal", symbol: "person.lanyardcard.fill", margin: personal),
        SafariProfile(serverId: FakeSafari.testServer, uuid: "E2", name: "Test", symbol: "", margin: test),
    ]
    check("names: Safari's read: changed", bp.useBrowserNames(safariList))
    check("names: Safari's win over a typed one", bp.name("s-default") == "Work" && bp.name(personal) == "Personal", bp.name(personal))
    check("names: a profile Safari doesn't name keeps Margin's", bp.name("s-9") == "Profile 3", bp.name("s-9"))
    check("names: the same again: nothing changed", !bp.useBrowserNames(safariList))
    bp.rename(personal, name: "Something else", emoji: "🎒", color: "#e17055")
    check("names: Edit Profile keeps Safari's name, the emoji and color change", bp.name(personal) == "Personal" && bp.info[personal]?.emoji == "🎒" && bp.color(personal) == "#e17055")
    check("names: the typed name is kept for later", bp.info[personal]?.name == "Typed")
    let across = bp.across(for: "s-default", spaces: [:], counts: [:], linked: ["s-default"], symbol: { $0.isEmpty ? nil : "data:image/png;base64,AAAA" })
    let entry = (across["profiles"] as? [JSONObject])?.first { $0["id"] as? String == personal }
    check("names: across says the name is Safari's, with its symbol", entry?["nameFrom"] as? String == "safari" && entry?["symbol"] as? String == "data:image/png;base64,AAAA" && entry?["name"] as? String == "Personal")
    let other = (across["profiles"] as? [JSONObject])?.first { $0["id"] as? String == "s-9" }
    check("names: and nothing for Margin's own", other?["nameFrom"] == nil && other?["symbol"] == nil)
    bp.refresh(spaces: ["s-default": ["a"], personal: ["b"], "s-9": ["c"], test: ["d"]], linked: ["s-default", personal, test])
    check("names: a profile seen after the read gets Safari's name at once", bp.name(test) == "Test" && bp.info[test]?.browserId == FakeSafari.testServer)
    let reloaded = BrowserProfiles(browser: "safari", root: root)
    check("names: Safari's ids kept in browser.json", reloaded.info[personal]?.browserId == FakeSafari.personalServer && reloaded.info[personal]?.browserName == "Personal")
    check("names: never Safari's name as the typed one", reloaded.name(personal) == "Typed")
    // The copy's entry unreadable this time (Margin turned off there): the profile still has its name, by Safari's id.
    var noEntry = safariList
    noEntry[1].margin = nil
    bp.useBrowserNames(noEntry)
    check("names: known by Safari's id when the copy's entry is missing", bp.name(personal) == "Personal")
    check("names: renamed in Safari", bp.useBrowserNames(safariList.map { var p = $0; if p.margin == test { p.name = "Testing" }; return p }) && bp.name(test) == "Testing")
    // No permission any more: the typed names again.
    check("names: no permission: changed", bp.dropBrowserNames())
    check("names: no permission: typed and default names", bp.name(personal) == "Typed" && bp.name("s-default") == "Default" && bp.name(test) == "Profile 4", "\(bp.name(test))")
    bp.useBrowserNames(safariList)
    // Deleted in Safari: the last name it gave stays (as typed); a typed one stays.
    let gone = safariList.filter { $0.margin != test && $0.margin != personal }
    check("names: deleted in Safari: changed", bp.useBrowserNames(gone))
    check("names: deleted in Safari: its last name kept", bp.name(test) == "Test" && bp.info[test]?.named == true && bp.info[test]?.browserId == "")
    check("names: deleted in Safari, a name typed before: that name", bp.name(personal) == "Typed")
    check("names: and saved", BrowserProfiles(browser: "safari", root: root).name(test) == "Test")

    // ---- a signing change: the same Safari profile under a new id ----
    let oldId = "s-5068e0e4-81aa-4ec4-a74a-bb4da5a64a41", newId = personal
    let cp = BrowserProfiles(browser: "safari", root: nil)
    cp.refresh(spaces: ["s-default": ["w"], oldId: ["a1", "a2"]], linked: ["s-default", oldId])
    cp.rename(oldId, name: "", emoji: "🏠", color: "#00b894")
    let readBefore = [SafariProfile(serverId: "DefaultProfile", uuid: "DefaultProfile", name: "Work", symbol: "", margin: "s-default"),
                  SafariProfile(serverId: FakeSafari.personalServer, uuid: "A9", name: "Personal", symbol: "", margin: oldId)]
    let hasOld = { (id: String) in id == oldId }
    check("carry source: before any read: none, and no hold", cp.carrySource(for: newId, hasSet: hasOld, linked: [newId]) == nil && !cp.mightCarry(newId, hasSet: hasOld, linked: [newId]))
    cp.useBrowserNames(readBefore)
    check("carry source: the old id linked to Safari's profile", cp.info[oldId]?.browserId == FakeSafari.personalServer)
    check("carry source: a new copy no read maps yet: worth a hold", cp.mightCarry(newId, hasSet: hasOld, linked: [newId, "s-default"]))
    check("carry source: not while the old one is linked, nor with no set to carry", !cp.mightCarry(newId, hasSet: hasOld, linked: [newId, oldId]) && !cp.mightCarry(newId, hasSet: { _ in false }, linked: [newId]))
    check("carry source: never for the default profile's copy", !cp.mightCarry("s-default", hasSet: hasOld, linked: []) && cp.carrySource(for: "s-default", hasSet: hasOld, linked: []) == nil)
    check("carry source: the read doesn't map the new one: none yet", cp.carrySource(for: newId, hasSet: hasOld, linked: [newId]) == nil)
    let readAfter = readBefore.map { var p = $0; if p.margin == oldId { p.margin = newId }; return p }
    cp.useBrowserNames(readAfter)
    check("startup: historical copies keep their names for carry-over, but only the current copy names a window",
          cp.browserNames[oldId]?.name == "Personal" && cp.windowNames[oldId] == nil && cp.windowNames[newId] == "Personal")
    check("startup: Accessibility resolves a restored window to the current copy after a signing change",
          SafariAX.profile(ofTitle: "Personal — Start Page", names: cp.windowNames, defaultId: "s-default") == newId)
    let src = cp.carrySource(for: newId, hasSet: hasOld, linked: [newId, "s-default"])
    check("carry source: the read maps Safari's profile to the new id: the old id's set", src?.old == oldId && src?.browserId == FakeSafari.personalServer, "\(String(describing: src))")
    check("carry source: no hold once the read maps it", !cp.mightCarry(newId, hasSet: hasOld, linked: [newId]))
    check("carry source: not if the old one is linked again", cp.carrySource(for: newId, hasSet: hasOld, linked: [newId, oldId]) == nil)
    check("carry source: not with no set", cp.carrySource(for: newId, hasSet: { _ in false }, linked: [newId]) == nil)
    let colorBefore = cp.color(oldId)
    cp.refresh(spaces: ["s-default": ["w"], oldId: ["a1", "a2"], newId: ["n1"]], linked: ["s-default", newId])
    let orderBefore = cp.order.filter { $0.profile != newId }.map { $0.profile == oldId ? SpaceKey(profile: newId, space: $0.space) : $0 }
    cp.carry(from: oldId, to: newId)
    cp.refresh(spaces: ["s-default": ["w"], newId: ["a1", "a2"]], linked: ["s-default", newId])
    check("carry: the old profile's emoji and color go with it", cp.info[newId]?.emoji == "🏠" && cp.color(newId) == colorBefore && cp.name(newId) == "Personal")
    check("carry: the old one forgotten, its places in the order the new one's", cp.info[oldId]?.hidden == true
          && cp.order == orderBefore && orderBefore.count == 3, "\(cp.order)")
    check("carry: one Personal in across", ((cp.across(for: "s-default", spaces: [:], counts: [:], linked: ["s-default", newId])["profiles"] as? [JSONObject]) ?? []).filter { $0["name"] as? String == "Personal" }.count == 1)
    cp.dropBrowserNames()
    check("startup: without Safari's mapping, historical names never identify a window", cp.windowNames.isEmpty)
    check("carry source: no read (no permission): none", cp.carrySource(for: newId, hasSet: { $0 == oldId }, linked: [newId]) == nil && !cp.mightCarry(oldId, hasSet: { $0 == newId }, linked: [oldId]))

    // ---- the symbol's picture ----
    let picture = ProfileSymbols.dataURL("person.fill")
    check("symbol: a PNG data URL", picture?.hasPrefix("data:image/png;base64,") == true && (picture?.count ?? 0) > 60, "\(picture?.prefix(40) ?? "none")")
    check("symbol: made once", ProfileSymbols.dataURL("person.fill") == picture)
    check("symbol: not a symbol: none", ProfileSymbols.dataURL("no.such.symbol.margin") == nil && ProfileSymbols.dataURL("") == nil)
}
