// Checks of Margin.app's library (Library.swift, LibraryRules.swift, ShellLibrary.swift), part of tests.swift's run:
// the rules from dist/app/library.js (where MARGIN_LIBRARY_JS says) run in JavaScriptCore, the library's files in
// a temporary folder (flat: data/app/set.json), times and merges, the delegate and the recorded requests, the
// observers, the import of every profile's set (once, namespaced, in the person's order, the profiles' files left
// as they were), and the shell's setting (off: nothing made). The rules themselves: tests/library.test.ts.
import Foundation

final class RecordingLibraryDelegate: LibraryDelegate {
  var asked: [LibraryRequest] = []
  func library(_ library: Library, wants request: LibraryRequest) { asked.append(request) }
}

// Every file under a folder, by its path from there, with its bytes (the profiles' files, before and after).
func filesUnder(_ root: URL) -> [String: Data] {
  var out: [String: Data] = [:]
  for path in (try? FileManager.default.subpathsOfDirectory(atPath: root.path)) ?? [] {
    var folder: ObjCBool = false
    let full = root.appendingPathComponent(path).path
    if FileManager.default.fileExists(atPath: full, isDirectory: &folder), !folder.boolValue { out[path] = FileManager.default.contents(atPath: full) }
  }
  return out
}

extension Tests {
  static func libraryTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let script = URL(fileURLWithPath: scriptPath)
    guard let rules = LibraryRules.load(from: script) else { return check("library: the rules load (\(scriptPath): npm run build)", false) }
    check("library: the rules' actions", Set(rules.call("actions", []) as? [String] ?? []).isSuperset(of: [
      "setSpace", "createSpace", "renameSpace", "deleteSpace", "orderSpaces", "moveTabToSpace", "moveTab", "pinTab", "unpin", "openPin",
      "movePin", "createFolder", "renameFolder", "setFolderOpen", "deleteFolder", "moveFolder", "activateTab", "newTab", "closeTab",
      "clearToday", "restoreArchive", "addItem", "updateItem", "itemClosed", "removeItem", "setSpaceProfile", "forgetWindow",
    ]))
    check("library: a script that throws isn't rules", LibraryRules(script: "throw new Error('no')") == nil)
    check("library: a script with no entry isn't rules", LibraryRules(script: "var x = 1") == nil)
    check("library: an unknown function: nil, and why", rules.call("nope", []) == nil && rules.lastError?.contains("no function") == true)

    let dataRoot = tempFolder("library")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    var clock: Double = 5000
    var n = 0
    func make() -> Library? {
      let lib = Library.open(dataRoot: dataRoot, script: script, background: false)
      lib?.now = { clock }
      lib?.store.now = { clock }
      lib?.randomIds = { (0..<4).map { _ in n += 1; return "id\(n)x" } }
      return lib
    }
    guard let lib = make() else { return check("library: opens", false) }
    check("library: empty at first, not imported", lib.spaces().isEmpty && lib.items().isEmpty && !lib.isImported)
    var told: [Set<String>] = []
    let token = lib.observe { told.append($0) }

    // ---- spaces, in files of their own ----
    let made = lib.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠", "profile": "s-default"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    check("library: a space made", made.ok && home == "sp-id1x" && made.changed == ["spaces", "windows"], "\(made)")
    check("library: its profile, and the window shows it", lib.spaces().first?.value["profile"] as? String == "s-default" && lib.space(ofWindow: 1) == home)
    check("library: the observers told what changed", told == [["spaces", "windows"]])
    let dir = Library.folder(in: dataRoot)
    check("library: one flat set in data/app", FileManager.default.fileExists(atPath: dir.appendingPathComponent("set.json").path)
      && FileManager.default.fileExists(atPath: dir.appendingPathComponent("items/spaces.json").path)
      && FileManager.default.fileExists(atPath: dir.appendingPathComponent("items/x-windows.json").path))
    clock += 10
    let work = (lib.perform("createSpace", ["windowId": 2, "name": "Work"]).result as? JSONObject)?["spaceId"] as? String ?? ""
    check("library: a second space after the first", lib.spaces().map(\.id) == [home, work])
    check("library: a refused action changes nothing", !lib.perform("deleteSpace", ["spaceId": "nope"]).ok && lib.spaces().count == 2)
    check("library: an action it doesn't know", lib.perform("updateSettings", ["patch": [:] as JSONObject]).error == "unsupported")

    // ---- items, and what the hosting is asked ----
    let opened = lib.perform("newTab", ["windowId": 1, "url": "https://example.com/"])
    let page = (opened.result as? JSONObject)?["tabId"] as? String ?? ""
    check("library: newTab: an item, asked of the hosting (none yet: recorded)", opened.ok && page.hasPrefix("t-") && opened.requests.first?.type == "newTab"
      && lib.requests.last?.item == page && lib.requests.last?.target == .web(browser: "safari", profile: "s-default") && lib.requests.last?.windowId == 1)
    let delegate = RecordingLibraryDelegate()
    lib.delegate = delegate
    let app = lib.perform("addItem", ["windowId": 1, "target": ["kind": "app", "bundleId": "com.apple.Notes", "name": "Notes"] as JSONObject])
    let notes = (app.result as? JSONObject)?["tabId"] as? String ?? ""
    check("library: an app item", lib.target(ofItem: notes) == .app(bundleId: "com.apple.Notes", name: "Notes") && app.requests.isEmpty)
    lib.perform("activateTab", ["windowId": 1, "tabId": notes])
    check("library: activateTab given to the delegate, with its target", delegate.asked.map(\.type) == ["activateTab"]
      && delegate.asked.first?.target == .app(bundleId: "com.apple.Notes", name: "Notes") && delegate.asked.first?.item == notes)
    lib.perform("closeTab", ["tabId": page])
    check("library: closeTab: archived, the delegate asked to close it", delegate.asked.last?.type == "closeTab" && delegate.asked.last?.url == "https://example.com/"
      && lib.dataSet.liveValues("archive").count == 1 && lib.items().map(\.id) == [notes])
    lib.perform("moveTabToSpace", ["tabId": notes, "spaceId": work])
    check("library: an item moved to another space", lib.items(space: work).map(\.id) == [notes])
    check("library: deleting a space takes its items to the first space", lib.perform("deleteSpace", ["spaceId": work]).ok && lib.items(space: home).map(\.id) == [notes] && lib.space(ofWindow: 2) == home)

    // ---- times: always newer than the item's own ----
    let before = lib.dataSet.item("tabs", notes)?.updatedAt ?? 0
    clock = 100 // a clock that went back
    lib.perform("updateItem", ["tabId": notes, "title": "My notes"])
    let after = lib.dataSet.item("tabs", notes)
    check("library: a change after the item's own time, whatever the clock", (after?.updatedAt ?? 0) == before + 1 && (after?.value as? JSONObject)?["title"] as? String == "My notes")
    clock = 9000

    // ---- the snapshot ----
    let snap = lib.snapshot()
    let kept = (snap["openTabs"] as? JSONObject)?["keptTabs"] as? JSONObject
    check("library: the snapshot in the UI's stored shape", (snap["spaces"] as? [Any])?.count == 1 && kept?[notes] != nil
      && ((kept?[notes] as? JSONObject)?["target"] as? JSONObject)?["kind"] as? String == "app" && (snap["library"] as? JSONObject)?["imported"] as? Bool == false)

    // ---- kept on disk ----
    lib.stopObserving(token)
    let count = told.count
    lib.perform("renameSpace", ["spaceId": home, "name": "House"])
    check("library: an observer stopped isn't told", told.count == count)
    guard let again = make() else { return check("library: opens again", false) }
    check("library: read back from its files", again.spaces().map { $0.value["name"] as? String } == ["House"] && again.items().map(\.id) == [notes]
      && again.target(ofItem: notes) == .app(bundleId: "com.apple.Notes", name: "Notes"))
    for _ in 0..<(Library.requestsKept + 5) { lib.perform("setSpace", ["windowId": 1, "spaceId": home]) }
    check("library: the requests recorded, the last ones only", lib.requests.count == Library.requestsKept && lib.requests.last?.type == "setSpace")

    importChecks(script: script)
    shellChecks()
  }

  // Two Safari profiles' sets (both with a `personal` space and the same tab id) and browser.json's order.
  static func importChecks(script: URL) {
    let root = tempFolder("library-import")
    defer { try? FileManager.default.removeItem(at: root) }
    let profiles = testStore(root)
    func put(_ profile: String, _ items: [String: [String: Any]]) {
      var set = DataSet()
      set.merge(items.flatMap { c, list in list.map { change(c, $0.key, 10, $0.value) } })
      profiles.save(DataProfile(browser: "safari", profile: profile), DataStore.Stored(set: set, acked: 0), changed: nil)
    }
    let tab: (String, String, Double) -> JSONObject = { url, space, order in ["url": url, "title": "", "icon": "", "spaceId": space, "order": order, "lastUsed": 1, "selected": false] }
    put("s-default", [
      "spaces": ["personal": space("Personal", 0), "work": space("Work", 1)],
      "pins": ["p-1": ["spaceId": "work", "url": "https://mail.example/", "title": "Mail", "folderId": NSNull(), "pos": 0]],
      "tabs": ["t-same": tab("https://a.example/", "personal", 1)],
      "settings": ["theme": "arcadia"],
    ])
    put("s-OTHER", ["spaces": ["personal": space("Home", 0)], "tabs": ["t-same": tab("https://b.example/", "personal", 1)]])
    let browserJSON = root.appendingPathComponent("safari/browser.json")
    let order: JSONObject = ["format": 1, "browser": "safari", "order": [["s-default", "personal"], ["s-OTHER", "personal"], ["s-default", "work"]],
                             "profiles": ["s-default": ["name": "Default", "firstSeen": 1], "s-OTHER": ["name": "Other", "firstSeen": 2]], "savedAt": 1]
    try? DataStore.writeAtomically(try! JSONSerialization.data(withJSONObject: order), to: browserJSON)
    let filesBefore = filesUnder(root)
    guard let lib = Library.open(dataRoot: root, script: script, background: false) else { return check("library import: opens", false) }
    lib.now = { 777 }
    check("library import: runs once", lib.importOnce(from: profiles) && lib.isImported)
    check("library import: every space, namespaced, in the person's order",
          lib.spaces().map(\.id) == ["safari:s-default:personal", "safari:s-OTHER:personal", "safari:s-default:work"], "\(lib.spaces().map(\.id))")
    check("library import: a space keeps its profile", lib.spaces().dropFirst().first?.value["profile"] as? String == "s-OTHER")
    let items = lib.items()
    check("library import: the same tab id in two profiles is two items, each in its profile", items.count == 2 && Set(items.map(\.id)).count == 2
      && Set(items.compactMap { lib.target(ofItem: $0.id) }) == [.web(browser: "safari", profile: "s-default"), .web(browser: "safari", profile: "s-OTHER")])
    check("library import: pins with their space and target", (lib.dataSet.liveValues("pins")["safari:s-default:p-1"] as? JSONObject)?["spaceId"] as? String == "safari:s-default:work")
    check("library import: no settings", lib.dataSet.liveValues("settings").isEmpty)
    check("library import: its marker", ((lib.dataSet.liveValues("imports")["done"] as? JSONObject)?["sets"] as? [String]) == ["safari:s-OTHER", "safari:s-default"]
      || ((lib.dataSet.liveValues("imports")["done"] as? JSONObject)?["sets"] as? [String]) == ["safari:s-default", "safari:s-OTHER"])
    check("library import: never twice", !lib.importOnce(from: profiles))
    let reopened = Library.open(dataRoot: root, script: script, background: false)
    check("library import: never twice, after a relaunch too", reopened?.isImported == true && reopened?.importOnce(from: profiles) == false)
    let filesAfter = filesUnder(root).filter { !$0.key.hasPrefix("app/") }
    check("library import: the profiles' files left as they were", filesAfter == filesBefore, "\(Set(filesAfter.keys).symmetricDifference(filesBefore.keys))")

    // Nothing to import: the marker alone, and the library empty for the create-spaces step.
    let bare = tempFolder("library-bare")
    defer { try? FileManager.default.removeItem(at: bare) }
    let none = Library.open(dataRoot: bare, script: script, background: false)
    check("library import: no profiles: marked, empty", none?.importOnce(from: testStore(bare)) == true && none?.isImported == true && none?.spaces().isEmpty == true)
  }

  // The setting: off, no library and no folder; on, the library opened and imported.
  static func shellChecks() {
    let appRoot = URL(fileURLWithPath: ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js").deletingLastPathComponent()
    let root = tempFolder("library-shell")
    defer { try? FileManager.default.removeItem(at: root) }
    var options = Shell.Options()
    options.harness = true
    options.dataRoot = root
    options.root = appRoot
    let shell = Shell(link: SocketLink(), apps: StubApps(), hotKeys: FakeRegistrar(), options: options)
    let made = FileManager.default.fileExists(atPath: Library.folder(in: root).path)
    check("library: opened and imported with the shell", shell.library?.isImported == true && made)
  }
}
