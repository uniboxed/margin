// The library's shared vectors (tests/fixtures/library/, docs/CORE-REFACTOR.md step 4, part 8) through the app's own
// rules: dist/app/library.js in JavaScriptCore by LibraryRules, as Margin.app runs them. And the shadow: every call the
// whole suite makes to the rules (perform, snapshot, importValues), given to margin-core's library as well (through the
// FFI: margin_library_rules, library.js's entry answered by the core with the Mac's sorter, libicucore's) and its
// answer compared. The core parses addresses as the browsers do (Tirth's answer 11) and JSC can't (no `URL`): a call
// they differ on only by that is counted and named, the core's answer with no URL being JSC's. And the baselines step 4 must not exceed (MARGIN_LIBRARY_BASELINE=<items>: a perform, a snapshot, a
// draw's library part, the footprint), with the core's perform through the FFI beside today's.
import Foundation
import JavaScriptCore
import MarginCore

// ---- JSON as the vectors compare it: objects with no regard to key order, numbers as doubles, true isn't 1 ----

func jsonSame(_ a: Any?, _ b: Any?) -> Bool {
  switch (a, b) {
  case (nil, nil): return true
  case (is NSNull, is NSNull): return true
  case let (x as NSNumber, y as NSNumber):
    let xb = CFGetTypeID(x) == CFBooleanGetTypeID(), yb = CFGetTypeID(y) == CFBooleanGetTypeID()
    return xb == yb && (xb ? x.boolValue == y.boolValue : x.doubleValue == y.doubleValue)
  case let (x as String, y as String): return x == y
  case let (x as [Any], y as [Any]): return x.count == y.count && zip(x, y).allSatisfy { jsonSame($0, $1) }
  case let (x as [String: Any], y as [String: Any]): return x.count == y.count && x.allSatisfy { jsonSame($0.value, y[$0.key]) }
  default: return false
  }
}

// JSON text as JSONSerialization writes it (a dictionary's keys in its own order), and with every object's keys in
// code-point order (for a report).
func plainJSON(_ v: Any) -> String {
  String(decoding: (try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])) ?? Data("null".utf8), as: UTF8.self)
}
func codePointJSON(_ v: Any) -> String {
  switch v {
  case let o as [String: Any]:
    let keys = o.keys.sorted { $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars) }
    return "{" + keys.map { plainJSON($0) + ":" + codePointJSON(o[$0]!) }.joined(separator: ",") + "}"
  case let a as [Any]: return "[" + a.map(codePointJSON).joined(separator: ",") + "]"
  default: return plainJSON(v)
  }
}
// The library's values (collection → id → value) as JSON with each collection's ids in code-point order: the order
// margin-core's store reads them in (the vectors', Tirth's answer 10). A value's own keys stay in the dictionary's
// order, as the app hands them today (importValues compares the stored values' text: a value whose keys come in
// another order is written again, the same value).
func valuesJSON(_ v: Any) -> String {
  guard let o = v as? [String: Any] else { return plainJSON(v) }
  return "{" + o.keys.sorted().map { c in
    guard let list = o[c] as? [String: Any] else { return plainJSON(c) + ":" + plainJSON(o[c]!) }
    let ids = list.keys.sorted { $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars) }
    return plainJSON(c) + ":{" + ids.map { plainJSON($0) + ":" + plainJSON(list[$0]!) }.joined(separator: ",") + "}"
  }.joined(separator: ",") + "}"
}

// ---- the shadow --------------------------------------------------------------------------------------------------

// Every LibraryRules call of the rules' functions goes through here (JSValue's call, exchanged once): its arguments made
// the vectors' (ids in code-point order, the env's ids padded so the rules never draw Math.random), the app's engine
// (JavaScriptCore) answers, then margin-core's (the FFI), and the two answers must be the same, but for what Tirth
// decided they differ in: a cut through an emoji (JSC keeps half the pair, which the app can't read; the core drops
// it: Tirth's answer 3), piece 1's known gap (a `createSpace` given an emoji or colour that's truthy and no string:
// JSC stores it as given, the core `""`, what the next reading of it is) and addresses (Tirth's answer 11: the core
// parses them as the browsers do, JSC has no `URL`; such a call's core answer with no URL, margin_library_rules_without_
// urls, must be JSC's), each counted. Test builds only; never in the app.
enum LibraryShadow {
  static let shadowed: Set<String> = ["perform", "snapshot", "importValues"]
  private(set) static var installed = false
  // A call the shadow makes itself, or a timing (the baselines measure today's rules alone).
  static var bypass = false
  private static var pad = 0
  static var counts: [String: Int] = [:]
  static var differences: [String] = []
  static var differing = 0
  // The calls JSC answered with half an emoji (the same once both drop it), and the known gap's.
  static var cuts = 0
  static var rewrites = 0
  static var gap = 0
  // The calls answered otherwise only because the core parses addresses, by action (`perform`'s) or function.
  static var urls: [String: Int] = [:]

  static func install() {
    guard !installed, let original = class_getInstanceMethod(JSValue.self, #selector(JSValue.call(withArguments:))),
          let shadow = class_getInstanceMethod(JSValue.self, #selector(JSValue.margin_shadowCall(withArguments:))) else { return }
    method_exchangeImplementations(original, shadow)
    installed = true
  }

  // The second engine: margin-core's library.js entry (margin_library_rules), the person's sorter; `parsing` false: the
  // same with no URL, as JSC answers (margin_library_rules_without_urls).
  static func core(_ name: String, _ text: String, parsing: Bool = true) -> String? {
    KeysCore.bytes(name) { np, nn in
      KeysCore.bytes(text) { ap, an in
        var len = 0
        let rules = parsing ? margin_library_rules : margin_library_rules_without_urls
        guard let out = rules(nil, np, nn, ap, an, &len) else { return nil }
        defer { margin_buffer_free(out, len) }
        return String(decoding: UnsafeBufferPointer(start: out, count: len), as: UTF8.self)
      }
    }
  }

  // The arguments as both engines get them: the values' ids in code-point order, and the env's ids each one the rules
  // take (an id the rules refuse, the tests' `q1x`, would draw Math.random: in its place ten letters, as Math.random's
  // would be) with as many more after (never Math.random: the two engines' answers comparable).
  static func arguments(_ name: String, _ text: String) -> String {
    guard var list = (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])) as? [Any], !list.isEmpty else { return text }
    let letters = { () -> String in pad += 1; return "zs" + String(format: "%08d", pad) }
    if name == "perform", list.count >= 4, var env = list[3] as? [String: Any] {
      var ids = ((env["ids"] as? [Any]) ?? []).map { id -> Any in
        guard let s = id as? String, s.range(of: "^[A-Za-z0-9]{4,30}$", options: .regularExpression) != nil else { return letters() }
        return s
      }
      for _ in 0..<48 { ids.append(letters()) }
      env["ids"] = ids
      list[3] = env
    }
    var parts = list.map(plainJSON)
    parts[0] = valuesJSON(list[0])
    if name == "importValues", list.count >= 2, let sets = list[1] as? [Any] {
      parts[1] = "[" + sets.map { set -> String in
        guard let o = set as? [String: Any], let values = o["values"] else { return plainJSON(set) }
        return "{" + o.keys.sorted().map { k in plainJSON(k) + ":" + (k == "values" ? valuesJSON(values) : plainJSON(o[k]!)) }.joined(separator: ",") + "}"
      }.joined(separator: ",") + "]"
    }
    return "[" + parts.joined(separator: ",") + "]"
  }

  // JSC's text with half an emoji dropped: JSON.stringify writes a lone surrogate as its escape (`\ud83d`; a whole pair
  // goes as the character), so every such escape is one.
  static func dropped(_ text: String) -> String {
    text.replacingOccurrences(of: "\\\\u[dD][89a-fA-F][0-9a-fA-F]{2}", with: "", options: .regularExpression)
  }

  // Piece 1's known gap (actions_tests.rs): a createSpace given an emoji or colour that's truthy and not a string.
  static func inGap(_ name: String, _ text: String) -> Bool {
    guard name == "perform", let list = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [Any], list.count >= 3,
          list[1] as? String == "createSpace", let p = list[2] as? [String: Any] else { return false }
    let odd = { (v: Any?) -> Bool in
      guard let v, !(v is NSNull), !(v is String) else { return false }
      if let n = v as? NSNumber { return CFGetTypeID(n) == CFBooleanGetTypeID() ? n.boolValue : (n.doubleValue != 0 && !n.doubleValue.isNaN) }
      return true
    }
    return odd(p["emoji"]) || odd(p["color"])
  }

  static func compare(_ name: String, _ text: String, _ answer: JSValue?) {
    counts[name, default: 0] += 1
    bypass = true
    defer { bypass = false }
    if inGap(name, text) { gap += 1; return }
    let a = answer?.toString(), b = core(name, text)
    let parse = { (s: String?) in s.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } }
    if a == b || jsonSame(parse(a), parse(b)) { return }
    if let a, dropped(a) != a {
      if jsonSame(parse(dropped(a)), parse(b)) { cuts += 1; return }
      // The known cut rewrite (core vectors.rs `KNOWN`): JSC writes a value again that, its half dropped, is the one
      // stored (a rename through an emoji to the name it has); the core's diff sees no change. Left out, counted.
      if name == "perform", var o = parse(dropped(a)) as? [String: Any], var v = o["value"] as? [String: Any],
         let changes = v["changes"] as? [[String: Any]],
         let given = ((try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [Any])?.first as? [String: Any] {
        let kept = changes.filter { ch in
          guard let c = ch["collection"] as? String, let id = ch["id"] as? String, ch["deleted"] == nil else { return true }
          return !jsonSame((given[c] as? [String: Any])?[id], ch["value"])
        }
        v["changes"] = kept
        o["value"] = v
        if kept.count < changes.count, jsonSame(o, parse(b)) { rewrites += 1; return }
      }
    }
    // Addresses (Tirth's answer 11): the core with no URL answers as JSC does, so the parsing alone differs.
    if let a {
      let c = parse(core(name, text, parsing: false))
      if jsonSame(parse(a), c) || jsonSame(parse(dropped(a)), c) {
        let list = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [Any]
        let what = name == "perform" && (list?.count ?? 0) > 1 ? (list?[1] as? String ?? "?") : name
        urls[what, default: 0] += 1
        return
      }
    }
    differing += 1
    if differences.count < 20 { differences.append("\(name)(\(text.prefix(300))…): \(a?.prefix(300) ?? "nil") vs \(b?.prefix(300) ?? "nil")") }
  }

  static func report() {
    guard installed else { return }
    let total = counts.values.reduce(0, +)
    let byUrl = urls.values.reduce(0, +)
    let named = urls.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
    print("  (library shadow: \(total) calls of the rules through JavaScriptCore and margin-core: \(counts.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")); \(cuts) the same once the half emoji is dropped, \(rewrites) the known cut rewrite, \(gap) of the known gap, \(byUrl) otherwise only by the addresses the core parses (\(named)), \(differing) differ)")
    check("library shadow: every call of the suite answered the same by JavaScriptCore and margin-core (\(total) calls: \(counts.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")); \(cuts) cuts, \(rewrites) the known rewrite, \(gap) of the gap, \(byUrl) by addresses: \(named))",
          differing == 0, differences.prefix(3).joined(separator: "\n"))
    // (The vectors' url steps go through here: the addresses' differences are seen, not none by accident.)
    check("library shadow: calls answered otherwise by the addresses alone, seen and named", byUrl > 0, named)
    check("library shadow: the suite's calls went through it", total > 100, "\(total)")
  }
}

extension JSValue {
  // After the exchange, this is JSValue's call(withArguments:) and the original is reached by this name.
  @objc nonisolated func margin_shadowCall(withArguments arguments: [Any]!) -> JSValue! {
    guard let args = arguments, args.count == 2, let name = args[0] as? String, let text = args[1] as? String else {
      return margin_shadowCall(withArguments: arguments)
    }
    return MainActor.assumeIsolated {
      if LibraryShadow.bypass || !LibraryShadow.shadowed.contains(name) { return margin_shadowCall(withArguments: arguments) }
      let given = LibraryShadow.arguments(name, text)
      let out = margin_shadowCall(withArguments: [name, given])
      LibraryShadow.compare(name, given, out)
      return out
    }
  }
}

// ---- the vectors through LibraryRules -------------------------------------------------------------------------------

extension Tests {
  static func libraryVectorsTests() {
    LibraryShadow.install()
    let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["MARGIN_LIBRARY_VECTORS"] ?? "../../tests/fixtures/library")
    let script = URL(fileURLWithPath: ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js")
    guard let rules = LibraryRules.load(from: script) else { return check("library vectors: the rules load", false) }
    let read = { (url: URL) in (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? JSONObject }
    guard let sites = read(dir.appendingPathComponent("throws.json"))?["sites"] as? JSONObject else { return check("library vectors: throws.json (\(dir.path))", false) }
    let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("cases").path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
    check("library vectors: the case files", files.count >= 20, "\(files.count) in \(dir.path)")
    var counts: [String: Int] = [:]
    var failed: [String] = []
    for file in files {
      guard let group = read(dir.appendingPathComponent("cases/\(file)")), let cases = group["cases"] as? [JSONObject] else {
        failed.append("\(file): not a case file"); continue
      }
      for (ci, c) in cases.enumerated() {
        var values = c["values"] as? JSONObject ?? [:]
        for (si, step) in (c["steps"] as? [JSONObject] ?? []).enumerated() {
          let expect = step["expect"]
          let at = "\(file) case \(ci) step \(si)"
          var got: Any?
          var kind = "skipped"
          if let action = step["perform"] as? String {
            kind = "perform"
            got = rules.call("perform", [values, action, step["payload"] ?? [:], step["env"] ?? [:]]).map { o -> Any in
              let o = o as? JSONObject ?? [:]
              let ok = (o["ok"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
              var out: JSONObject = ["ok": ok, "result": ok ? (o["result"] ?? NSNull()) : NSNull(), "changes": o["changes"] ?? [Any](), "requests": o["requests"] ?? [Any]()]
              if !ok { out["error"] = o["error"] ?? NSNull() }
              return out
            }
          } else if step["snapshot"] != nil {
            kind = "snapshot"
            got = rules.call("snapshot", [values])
          } else if let i = step["import"] as? JSONObject {
            kind = "import"
            got = rules.call("importValues", [values, i["sets"] ?? [Any](), i["order"] ?? [Any](), ["now": i["now"] ?? 0]])
          }
          counts[kind, default: 0] += 1
          if kind != "skipped" {
            if step["url"] as? Bool == true {
              // The browsers' answer (Tirth's answer 11), not JSC's: JSC has no URL. The shadow compares JSC with the
              // core with no URL on this call; the core's own vectors check the browsers' answer.
              counts["url: the browsers' answer, not JSC's", default: 0] += 1
            } else if step["cut"] as? Bool == true {
              // Half an emoji in the rules' answer: today's app can't read it (JSONSerialization), the whole call fails.
              if got != nil || rules.lastError?.hasSuffix("no answer") != true { failed.append("\(at) (\(kind), cut): the app read an answer with half an emoji") }
              counts["cut: the call fails today", default: 0] += 1
            } else {
              var want = expect
              if var e = expect as? JSONObject, let site = (e["error"] as? JSONObject)?["failed"] as? String {
                e["error"] = "failed: \((sites[site] as? JSONObject)?["jsc"] as? String ?? "?")"
                want = e
              }
              if kind == "import" {
                // (The import compares the stored values' text, and here a value's keys come in Swift's order, so it
                // may write a value again, the same value: those left out of both.)
                let fresh = { (o: Any?) -> Any? in
                  guard var o = o as? JSONObject else { return o }
                  o["changes"] = (o["changes"] as? [JSONObject] ?? []).filter { ch in
                    guard let c = ch["collection"] as? String, let id = ch["id"] as? String, ch["deleted"] == nil else { return true }
                    return !jsonSame((values[c] as? JSONObject)?[id], ch["value"])
                  }
                  return o
                }
                got = fresh(got)
                want = fresh(want)
              }
              if !jsonSame(got, want) { failed.append("\(at) (\(kind) \(step["perform"] as? String ?? "")): \(codePointJSON(got ?? NSNull()).prefix(300)) vs \(codePointJSON(want ?? NSNull()).prefix(300))") }
            }
          }
          if kind == "perform" || kind == "import", let changes = (expect as? JSONObject)?["changes"] as? [JSONObject] {
            for ch in changes {
              guard let collection = ch["collection"] as? String, let id = ch["id"] as? String else { continue }
              var list = values[collection] as? JSONObject ?? [:]
              if ch["deleted"] as? Bool == true { list[id] = nil } else { list[id] = ch["value"] }
              values[collection] = list
            }
          }
        }
      }
    }
    check("library vectors: every perform, snapshot and import step answered by JavaScriptCore as recorded (\(counts.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")))",
          failed.isEmpty, "\(failed.count) differ: " + failed.prefix(3).joined(separator: "\n"))
    print("  (library vectors through JavaScriptCore: \(counts.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")); \(failed.count) differ)")
    check("library vectors: thousands of steps", (counts["perform"] ?? 0) > 5000 && (counts["snapshot"] ?? 0) > 100)

    // A title cut through an emoji, the app today (step 4's open question 3): the rules' answer holds half the pair,
    // JSONSerialization can't read it, and the action fails with nothing changed. The core drops the half instead
    // (Tirth's answer 3), from the switch (commit 6).
    let root = tempFolder("library-cut")
    defer { try? FileManager.default.removeItem(at: root) }
    if let lib = Library.open(dataRoot: root, script: script, background: false) {
      lib.randomIds = { ["cut1x", "cut2x", "cut3x", "cut4x"] }
      let space = (lib.perform("createSpace", ["name": "A"]).result as? JSONObject)?["spaceId"] as? String
      let cut = lib.perform("addItem", ["spaceId": space ?? "", "url": "https://a.example/", "title": String(repeating: "a", count: 1999) + "😀tail"])
      check("library: a title cut through an emoji fails the action today (no answer), nothing kept", !cut.ok && cut.error?.hasSuffix("no answer") == true && lib.items().isEmpty, "\(cut)")
      let whole = lib.perform("addItem", ["spaceId": space ?? "", "url": "https://a.example/", "title": String(repeating: "a", count: 1998) + "😀tail"])
      check("library: the emoji whole at the cut: kept, 2,000 units", whole.ok && (lib.items().first?.value["title"] as? String)?.utf16.count == 2000)
    } else { check("library cut: opens", false) }

  }

  // ---- the baselines (off screen): what step 4's core must not exceed ----
  // MARGIN_LIBRARY_BASELINE=<items> (tests.swift runs only this, in a process of its own, so the footprint is the
  // library's): a library of that many items (2 KB icons, as a site's inline icon) and a full archive in its store,
  // opened as the app opens it (written in the background), then a click's perform (the rules' call alone, and the
  // whole perform with the store's apply and the observers), a snapshot, and a draw's library part (the snapshot and
  // its text for Margin's window), each the median of 25; the process's footprint after each.

  static func libraryBaseline(items n: Int) {
    LibraryShadow.bypass = true
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
    let script = URL(fileURLWithPath: ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js")
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
    do { _ = LibraryCore(root: Library.folder(in: root), background: false).apply(entries, at: 900) }
    guard let lib = Library.open(dataRoot: root, script: script, background: true) else { return check("library baseline: opens", false) }
    var k = 0
    lib.randomIds = { k += 1; return (0..<4).map { "base\(k)x\($0)" } }
    let opened = footprint()
    let values = lib.values
    let rules = median(25) { k += 1; _ = lib.rules.call("perform", [values, "activateTab", ["windowId": 1, "tabId": "t-i\(k % n)"], ["now": 5000.0 + Double(k), "ids": ["base\(k)y"]]]) }
    let perform = median(25) { k += 1; lib.perform("activateTab", ["windowId": 1, "tabId": "t-i\(k % n)"]) }
    let rename = median(25) { k += 1; lib.perform("renameTab", ["tabId": "t-i\(k % n)", "title": "Renamed \(k)"]) }
    let snapshot = median(25) { _ = lib.snapshot() }
    let draw = median(25) { _ = try? JSONSerialization.data(withJSONObject: lib.snapshot()) }
    let size = (try? JSONSerialization.data(withJSONObject: lib.snapshot()))?.count ?? 0
    print(String(format: "library baseline: %d items (+200 archived, 2 KB icons): a perform %.2f ms (the rules' call %.2f, a rename %.2f), a snapshot %.2f ms, a draw's library part %.2f ms (%d KB); footprint %.1f MB at start, %.1f with the library open, %.1f after",
                 n, perform, rules, rename, snapshot, draw, size / 1024, start, opened, footprint()))

    // margin-core's library through the FFI (step 4 commit 5; the app switches at commit 6): the same library in a
    // folder of its own, opened as the app will (written in the background), a click's perform as the facade will make
    // it (margin_library_call: the request's JSON in, the answer read back with JSONSerialization; the observers and
    // the store's apply in it), a rename, and the snapshot as JSON (the call the tests keep; the draw's own typed text
    // is commit 7's).
    let coreRoot = tempFolder("library-baseline-core")
    defer { try? FileManager.default.removeItem(at: coreRoot) }
    do { _ = LibraryCore(root: Library.folder(in: coreRoot), background: false).apply(entries, at: 900) }
    let beforeCore = footprint()
    let core: OpaquePointer? = KeysCore.bytes(Library.folder(in: coreRoot).path) { p, len in margin_library_new(p, len, true, nil, { _ in }, nil, nil, nil) }
    defer { margin_library_free(core) }
    let ask = { (request: JSONObject) -> Any? in KeysCore.bytes(KeysCore.json(request)) { p, len in KeysCore.answer { margin_library_call(core, p, len, $0) } } }
    _ = ask(["type": "snapshot"])
    let corePerform = median(25) { k += 1; _ = ask(["type": "perform", "action": "activateTab", "payload": ["windowId": 1, "tabId": "t-i\(k % n)"]]) }
    let coreRename = median(25) { k += 1; _ = ask(["type": "perform", "action": "renameTab", "payload": ["tabId": "t-i\(k % n)", "title": "Renamed \(k)"]]) }
    let coreSnapshot = median(25) { _ = ask(["type": "snapshot"]) }
    let coreFresh = median(25) { k += 1; _ = ask(["type": "perform", "action": "renameTab", "payload": ["tabId": "t-i\(k % n)", "title": "Again \(k)"]]); _ = ask(["type": "snapshot"]) }
    print(String(format: "library baseline, margin-core through the FFI: %d items: a perform %.2f ms (a rename %.2f), a snapshot as JSON %.2f ms (a rename and the snapshot made again %.2f); footprint %.1f MB before it, %.1f after",
                 n, corePerform, coreRename, coreSnapshot, coreFresh, beforeCore, footprint()))
  }
}
