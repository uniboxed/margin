// The library through the app's own path since step 4's switch (docs/CORE-REFACTOR.md step 4, part 9): Library.swift
// over margin-core's library object. The shared vectors (tests/fixtures/library/) run against the core in Rust, with the
// Mac's sorter through the same FFI entry the app links (margin-ffi library_tests.rs); here, the Mac's own outcome of a
// decided change (a title cut through an emoji, Tirth's answer 3) and the costs step 4 must not exceed
// (MARGIN_LIBRARY_BASELINE=<items>: a perform, a snapshot, a draw's library part, the footprint), against commit 0's.
import Foundation

extension Tests {
  static func libraryVectorsTests() {
    // A title cut through an emoji (step 4's open question 3): JavaScriptCore's rules kept half the pair, which
    // JSONSerialization couldn't read, so the whole action failed with nothing kept. The core drops the broken half
    // (Tirth's answer 3): the item kept, its title 1,999 units.
    let root = tempFolder("library-cut")
    defer { try? FileManager.default.removeItem(at: root) }
    let lib = Library.open(dataRoot: root, background: false)
    lib.randomIds = { ["cut1x", "cut2x", "cut3x", "cut4x"] }
    let space = (lib.perform("createSpace", ["name": "A"]).result as? JSONObject)?["spaceId"] as? String
    let cut = lib.perform("addItem", ["spaceId": space ?? "", "url": "https://a.example/", "title": String(repeating: "a", count: 1999) + "😀tail"])
    let title = lib.items().first?.value["title"] as? String
    check("library: a title cut through an emoji: kept, the broken half dropped (1,999 units)", cut.ok && title == String(repeating: "a", count: 1999), "\(cut) \(title?.utf16.count ?? -1)")
    lib.perform("removeItem", ["tabId": (cut.result as? JSONObject)?["tabId"] ?? ""])
    let whole = lib.perform("addItem", ["spaceId": space ?? "", "url": "https://a.example/", "title": String(repeating: "a", count: 1998) + "😀tail"])
    check("library: the emoji whole at the cut: kept, 2,000 units", whole.ok && (lib.items().first?.value["title"] as? String)?.utf16.count == 2000)
  }

  // ---- the costs (off screen) ----
  // MARGIN_LIBRARY_BASELINE=<items> (tests.swift runs only this, in a process of its own, so the footprint is the
  // library's): a library of that many items (2 KB icons, as a site's inline icon) and a full archive in its store,
  // opened as the app opens it (written in the background), then a click's perform (with the store's apply and the
  // observers in it), a rename, a snapshot, and a draw's library part (the snapshot and its text for Margin's window),
  // each the median of 25; the process's footprint after each. Commit 0's (JavaScriptCore's) to beat: DECISIONS.md.

  static func libraryBaseline(items n: Int) {
    func footprint() -> Double {
      var info = task_vm_info_data_t()
      var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
      let kr = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
      return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
    }
    func median(_ runs: Int, _ f: () -> Void) -> Double {
      var times: [Double] = []
      for _ in 0..<runs { autoreleasepool { let t = DispatchTime.now().uptimeNanoseconds; f(); times.append(Double(DispatchTime.now().uptimeNanoseconds - t) / 1e6) } }
      return times.sorted()[times.count / 2]
    }
    let start = footprint()
    let root = tempFolder("library-baseline")
    defer { try? FileManager.default.removeItem(at: root) }
    let icon = "data:image/png;base64," + String(repeating: "A", count: 2048 - 22)
    let web: JSONObject = ["kind": "web", "browser": "safari", "profile": NSNull()]
    var entries: [Any] = [["collection": "spaces", "id": "a", "value": ["name": "A", "emoji": "", "color": "", "order": 0, "browser": "safari", "profile": NSNull()]],
                          ["collection": "spaces", "id": "b", "value": ["name": "B", "emoji": "", "color": "", "order": 1, "browser": "safari", "profile": NSNull()]],
                          ["collection": "windows", "id": "1", "value": ["spaceId": "a"]]]
    for i in 0..<n {
      entries.append(["collection": "tabs", "id": "t-i\(i)", "value": ["url": "https://site\(i).example/page", "title": "Page \(i) of the baseline", "icon": icon,
                                                                       "spaceId": i % 2 == 0 ? "a" : "b", "order": i, "lastUsed": 1000 + i, "selected": i == n - 1, "target": web]])
    }
    for i in 0..<200 { entries.append(["collection": "archive", "id": "a-\(i)", "value": ["url": "https://old\(i).example/", "title": "Old \(i)", "spaceId": "a", "icon": "", "closedAt": 500 + i, "target": web]]) }
    Library.open(dataRoot: root, background: false).store(entries, at: 900)
    let lib = Library.open(dataRoot: root, background: true)
    var k = 0
    lib.randomIds = { k += 1; return (0..<4).map { "base\(k)x\($0)" } }
    // (An observer as Margin's window is: told of each change, it draws nothing here.)
    var told = 0
    lib.observe { _ in told += 1 }
    let opened = footprint()
    let perform = median(25) { k += 1; lib.perform("activateTab", ["windowId": 1, "tabId": "t-i\(k % n)"]) }
    let rename = median(25) { k += 1; lib.perform("renameTab", ["tabId": "t-i\(k % n)", "title": "Renamed \(k)"]) }
    let snapshot = median(25) { _ = lib.snapshot() }
    let draw = median(25) { _ = try? JSONSerialization.data(withJSONObject: lib.snapshot()) }
    let fresh = median(25) { k += 1; lib.perform("renameTab", ["tabId": "t-i\(k % n)", "title": "Again \(k)"]); _ = try? JSONSerialization.data(withJSONObject: lib.snapshot()) }
    let size = (try? JSONSerialization.data(withJSONObject: lib.snapshot()))?.count ?? 0
    check("library baseline: every perform told its observer", told >= 75, "\(told)")
    // (The footprint after counts the store's writer's backlog: these edits come faster than their saves are written,
    // each save the changed collection's file; written at once, `background: false`, it stays flat.)
    print(String(format: "library baseline (margin-core through Library.swift): %d items (+200 archived, 2 KB icons): a perform %.2f ms (a rename %.2f), a snapshot %.2f ms, a draw's library part %.2f ms (%d KB; a rename and the draw after it %.2f); footprint %.1f MB at start, %.1f with the library open, %.1f after",
                 n, perform, rename, snapshot, draw, size / 1024, fresh, start, opened, footprint()))
  }
}
