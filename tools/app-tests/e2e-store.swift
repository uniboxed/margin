// The theme store end to end (docs/THEME-STORE.md §2–§4), the shell joined as Margin.app runs it, against the themes
// server's own code on this Mac (cloud/themes/scripts/dev.ts: the Worker's `handle` over Node's HTTP, its bindings the
// server tests' fakes): Margin's window and its page, the core's `theme` route, ShellThemes.swift and
// ShellThemeStore.swift, margin-core's data::theme_store (through margin-ffi), URLSession, the page's preview and check.
//   - Share one of the person's own: the install's key registered (the proof of work), the theme uploaded, in review.
//   - Review approves it (the review page, as it's used: its password, its own origin, its token).
//   - Settings' Themes: the store's list, signed and checked; Try: downloaded, checked against the list, previewed,
//     Use Theme installs it as the store's; its row then says installed.
//   - An update shared by the same key, approved: its row says so, Update installs it.
//   - Refused: a report of one's own theme (the store's words on its line), sharing a theme from the store, an install
//     with nothing downloaded for it.

import AppKit
import Foundation
import WebKit

func storeScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("store: \(label)", ok, detail()) }
  // (Longer than waitJS: a share registers the key first.)
  func waitPage(_ web: WKWebView, _ code: String, _ seconds: Double = 15) async -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if await js(web, code) as? Bool == true { return true }
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return false
  }

  // ---- the server ----
  let server = Process()
  let input = Pipe()
  let output = Pipe()
  server.executableURL = URL(fileURLWithPath: env["MARGIN_NODE"] ?? "/opt/homebrew/bin/node")
  server.arguments = [env["MARGIN_THEMES_DEV"]!, "--pow-bits", "12"]
  server.standardInput = input
  server.standardOutput = output
  server.standardError = FileHandle.standardError
  guard (try? server.run()) != nil else { return check("the local themes server starts", false) }
  defer { try? input.fileHandleForWriting.close(); server.terminate() }
  let first: Data = await withCheckedContinuation { done in
    DispatchQueue.global().async {
      var line = Data()
      while true {
        let byte = output.fileHandleForReading.readData(ofLength: 1)
        if byte.isEmpty || byte == Data([0x0a]) { break }
        line.append(byte)
      }
      done.resume(returning: line)
    }
  }
  guard let said = (try? JSONSerialization.jsonObject(with: first)) as? JSONObject, let base = said["url"] as? String,
        let indexKey = said["key"] as? String, let adminToken = said["adminToken"] as? String else {
    return check("the local themes server says where it is", false, String(decoding: first, as: UTF8.self))
  }
  // The review page, as it's used (curl: its password, the page's own origin, the token the page carries).
  func review(_ action: String, _ fields: [String: String]) -> Bool {
    func curl(_ args: [String]) -> String {
      let p = Process()
      let out = Pipe()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
      p.arguments = ["-s", "-u", "admin:\(adminToken)"] + args
      p.standardOutput = out
      guard (try? p.run()) != nil else { return "" }
      let data = out.fileHandleForReading.readDataToEndOfFile()
      p.waitUntilExit()
      return String(decoding: data, as: UTF8.self)
    }
    let page = curl(["\(base)/admin"])
    guard let r = page.range(of: #"name="csrf" value="([0-9a-f]{64})""#, options: .regularExpression) else { return false }
    let csrf = String(page[r].dropFirst(#"name="csrf" value=""#.count).dropLast())
    var form = ["csrf": csrf, "action": action]
    form.merge(fields) { $1 }
    let body = form.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" }.joined(separator: "&")
    let answer = curl(["-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", "-H", "Origin: \(base)", "-H", "Sec-Fetch-Site: same-origin", "--data", body, "\(base)/admin"])
    return answer.hasPrefix("303") && !answer.contains("Nothing%20changed")
  }

  // ---- the shell, its store this server ----
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-store-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  var options = Shell.Options()
  options.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root.appendingPathComponent("data")
  options.bundleIds = ["safari": fakeBundle]
  options.hostSystem = GlueHostWorld()
  options.appCatalog.folders = []
  options.appCatalog.spotlight = false
  options.appCatalog.icons = AppIconCache(folder: root.appendingPathComponent("icons"))
  var host = HostEngine.Options()
  host.every = 0.01
  host.privateRetire = 0
  options.hostOptions = host
  options.asksBeforeQuit = { false }
  options.setAskBeforeQuit = { _ in }
  options.quit = {}
  options.themeStore = (base, indexKey)
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.store.\(ProcessInfo.processInfo.processIdentifier)"))
  let shell = Shell(link: link, apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
  shell.start()
  defer { shell.stop {} }
  let made = shell.makeMarginWindows()
  let c = made.open()
  defer { made.closeAll() }
  guard await until(10, { c.isReady }) else { return check("Margin's window draws its page", false) }
  let store = shell.userThemes.store
  let id = "e2e-shared"
  let entry = { store.list().first { $0["id"] as? String == id } }
  let status = { (key: String) async -> String in await js(c.webView, "return JSON.stringify(marginApp.storeStatus(\(jsonString(key) ?? "''")))") as? String ?? "" }

  // ---- a theme of the person's own: Pixel's package under an id of its own, imported ----
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!).appendingPathComponent("theme.pixel.json")),
        let pkg = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject, let manifestText = pkg["manifest"] as? String,
        let html = pkg["html"] as? String, let css = pkg["css"] as? String else { return check("Pixel's package", false) }
  func manifest(_ version: String) -> String {
    var m = (try? JSONSerialization.jsonObject(with: Data(manifestText.utf8))) as? JSONObject ?? [:]
    m["id"] = id
    m["name"] = "Shared Pixel"
    m["author"] = "E2E Author"
    m["version"] = version
    return String(data: (try? JSONSerialization.data(withJSONObject: m, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? "{}"
  }
  let folder = root.appendingPathComponent("theme", isDirectory: true)
  let fm = FileManager.default
  try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
  try? manifest("1.0.0").write(to: folder.appendingPathComponent("theme.json"), atomically: true, encoding: .utf8)
  try? html.write(to: folder.appendingPathComponent("theme.html"), atomically: true, encoding: .utf8)
  try? css.write(to: folder.appendingPathComponent("theme.css"), atomically: true, encoding: .utf8)
  for (path, b64) in pkg["files"] as? [String: String] ?? [:] {
    guard let bytes = Data(base64Encoded: b64) else { continue }
    try? fm.createDirectory(at: folder.appendingPathComponent(path).deletingLastPathComponent(), withIntermediateDirectories: true)
    try? bytes.write(to: folder.appendingPathComponent(path))
  }
  shell.userThemes.pick = { folder }
  shell.themeAsked("theme.import", [:], window: c.id)
  _ = await waitPage(c.webView, "return marginApp.preview().shown === true")
  _ = await js(c.webView, "marginApp.previewPress('use'); return true")
  let imported = await until(5, { entry()?["version"] as? String == "1.0.0" })
  check("one of the person's own imported (a copy: no store record)", imported && entry()?["store"] == nil, "\(entry() ?? [:])")

  // ---- Share: the key registered (its work done), the theme uploaded, waiting for review ----
  shell.themeAsked("theme.share", ["id": id], window: c.id)
  let shared = await waitPage(c.webView, "return /waiting for review/.test(marginApp.storeStatus('themeShare:\(id)')?.text ?? '')")
  var line = await status("themeShare:\(id)")
  check("Share: registered, uploaded, its line says it waits for review", shared, line)
  let keyFile = shell.userThemes.store.root.appendingPathComponent("theme-store/key")
  let keyMode = (try? fm.attributesOfItem(atPath: keyFile.path)[.posixPermissions] as? Int) ?? 0
  check("…the install's key kept in Margin's data, readable by the person only", fm.fileExists(atPath: keyFile.path) && keyMode == 0o600, "\(keyFile.path) \(String(keyMode, radix: 8))")

  // ---- Settings' Themes before review: nothing listed yet ----
  shell.themeAsked("theme.store.open", [:], window: c.id)
  let emptyList = await waitPage(c.webView, "return marginApp.storeState()?.state === 'ready' && marginApp.storeState().rows.length === 0")
  var shown = String(describing: await js(c.webView, "return JSON.stringify(marginApp.storeState())"))
  check("Settings' Themes: the list read and its signature checked; a theme in review isn't in it", emptyList, shown)

  // ---- review approves it; the person's own copy removed, so the store's can be installed ----
  check("review approves it (the review page: its password, its origin, its token)", review("approve", ["theme": id, "version": "1.0.0"]))
  shell.themeAsked("theme.remove", ["id": id], window: c.id)
  _ = await until(5, { entry() == nil })
  shell.themeAsked("theme.store.open", [:], window: c.id)
  let listed = await waitPage(c.webView, "return (marginApp.storeState()?.rows ?? []).some((r) => r.id === '\(id)' && r.state === 'install' && r.version === '1.0.0')")
  shown = String(describing: await js(c.webView, "return JSON.stringify(marginApp.storeState())"))
  check("Settings' Themes: approved, it's listed, to install", listed, shown)

  // ---- Try: downloaded, checked against the list, previewed; Use Theme installs it as the store's ----
  shell.themeAsked("theme.store.try", ["id": id], window: c.id)
  let previewed = await waitPage(c.webView, "return marginApp.preview().shown === true")
  line = await status("storeTry:\(id)")
  check("Try: downloaded, its SHA-256 the list's, previewed under Margin's bar (nothing stored yet)", previewed && entry() == nil, line)
  _ = await js(c.webView, "marginApp.previewPress('use'); return true")
  let installed = await until(5, { (entry()?["store"] as? JSONObject)?["version"] as? String == "1.0.0" })
  check("Use Theme: installed as the store's (its version and package recorded)", installed, "\(entry() ?? [:])")
  let chosen = await until(5, { shell.hostedSettings?.chosenTheme == id })
  let drawn = await waitPage(c.webView, "return !!document.querySelector('.pixel')")
  check("…chosen and drawn", chosen && drawn, "\(String(describing: shell.hostedSettings?.chosenTheme))")
  let rowInstalled = await waitPage(c.webView, "return (marginApp.storeState()?.rows ?? []).some((r) => r.id === '\(id)' && r.state === 'installed')")
  check("…its row in Themes says installed, at once", rowInstalled)

  // ---- an update by the same key (as the author would from their own copy), approved; Update installs it ----
  var newer = (try? JSONSerialization.jsonObject(with: Data((store.message(id) ?? "{}").utf8))) as? JSONObject ?? [:]
  newer["manifest"] = manifest("1.0.1")
  let upload = await shell.userThemes.storeClient.share(message: jsonString(newer) ?? "{}")
  check("an update uploaded by the same key: in review", (upload["data"] as? JSONObject)?["status"] as? String == "review", "\(upload)")
  check("…approved", review("approve", ["theme": id, "version": "1.0.1"]))
  shell.themeAsked("theme.store.open", [:], window: c.id)
  let update = await waitPage(c.webView, "return (marginApp.storeState()?.rows ?? []).some((r) => r.id === '\(id)' && r.state === 'update' && r.version === '1.0.1')")
  check("Settings' Themes: an update to 1.0.1 offered", update)
  shell.themeAsked("theme.store.try", ["id": id], window: c.id)
  _ = await waitPage(c.webView, "return marginApp.preview().shown === true")
  _ = await js(c.webView, "marginApp.previewPress('use'); return true")
  let updated = await until(5, { (entry()?["store"] as? JSONObject)?["version"] as? String == "1.0.1" && entry()?["version"] as? String == "1.0.1" })
  check("Update: previewed, then installed (the store's record follows)", updated, "\(entry() ?? [:])")

  // ---- refused ----
  shell.themeAsked("theme.store.report", ["id": id, "reason": "broken"], window: c.id)
  let ownReport = await waitPage(c.webView, "const s = marginApp.storeStatus('storeReport:\(id)'); return !!s && s.error === true && /own/.test(s.text)")
  line = await status("storeReport:\(id)")
  check("a report of one's own theme: refused by the store, its words on the line", ownReport, line)
  shell.themeAsked("theme.share", ["id": id], window: c.id)
  let notOwn = await waitPage(c.webView, "return /Only a theme of your own/.test(marginApp.storeStatus('themeShare:\(id)')?.text ?? '')")
  line = await status("themeShare:\(id)")
  check("sharing a theme from the store: refused by Margin", notOwn, line)
  var refusals: [String] = []
  var value = (try? JSONSerialization.jsonObject(with: Data((store.message(id) ?? "{}").utf8))) as? JSONObject ?? [:]
  value["format"] = 2
  value["version"] = "1.0.1"
  shell.performTheme("theme.save", ["value": value, "store": true], reply: { refusals.append($0) }, chose: { _ in })
  check("an install with nothing downloaded for it here: refused", refusals.contains { $0.contains("wasn’t downloaded here") }, "\(refusals)")
}
