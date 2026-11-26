// Load Unpacked end to end (docs/THEME-STORE.md §1), the shell joined as Margin.app runs it: Margin's window and its page,
// the core's `theme` route (core/session/ui.rs), ShellThemes.swift's picker (the harness's `pick`), the page's preview and
// check (app/shared/host/overlay.ts), the core's links (data::themes) and the folder followed (FSEvents).
//   - Load Unpacked: the folder picked, previewed under Margin's bar, Use Theme: stored, linked, followed, chosen.
//   - A save in the folder: read again, checked by the page, stored again, drawn again.
//   - A save that fails (another id in theme.json, no Settings part): not stored, why said, the last good one drawn.
//   - A save asked for a theme that isn't linked, or a link with no folder picked: refused.
//   - Unlink: followed no more, stored still. Import (the same route): previewed, nothing linked. Remove: gone, Arcadia.

import AppKit
import Foundation
import WebKit

func themesScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("themes: \(label)", ok, detail()) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-themes-\(UUID().uuidString)")
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
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.themes.\(ProcessInfo.processInfo.processIdentifier)"))
  let shell = Shell(link: link, apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
  shell.start()
  defer { shell.stop {} }
  let made = shell.makeMarginWindows()
  let c = made.open()
  defer { made.closeAll() }
  guard await until(10, { c.isReady }) else { return check("Margin's window draws its page", false) }

  // A theme's folder, as someone writing one has it: Pixel's package (the one Margin carries) under an id of its own.
  let folder = root.appendingPathComponent("my-theme", isDirectory: true)
  let fm = FileManager.default
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!).appendingPathComponent("theme.pixel.json")),
        let pkg = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject,
        let manifestText = pkg["manifest"] as? String, let html = pkg["html"] as? String, let css = pkg["css"] as? String else {
    return check("Pixel's package to make a folder from", false)
  }
  func write(_ path: String, _ text: String) { try? fm.createDirectory(at: folder.appendingPathComponent(path).deletingLastPathComponent(), withIntermediateDirectories: true); try? text.write(to: folder.appendingPathComponent(path), atomically: true, encoding: .utf8) }
  func manifest(id: String, version: String) -> String {
    var m = (try? JSONSerialization.jsonObject(with: Data(manifestText.utf8))) as? JSONObject ?? [:]
    m["id"] = id
    m["version"] = version
    return String(data: (try? JSONSerialization.data(withJSONObject: m, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? "{}"
  }
  write("theme.json", manifest(id: "my-theme", version: "1.0.0"))
  write("theme.html", html)
  write("theme.css", css)
  for (path, b64) in pkg["files"] as? [String: String] ?? [:] {
    guard let bytes = Data(base64Encoded: b64) else { continue }
    try? fm.createDirectory(at: folder.appendingPathComponent(path).deletingLastPathComponent(), withIntermediateDirectories: true)
    try? bytes.write(to: folder.appendingPathComponent(path))
  }
  let store = shell.userThemes.store
  let version = { store.list().first { $0["id"] as? String == "my-theme" }?["version"] as? String }
  let linkStatus = { await js(c.webView, "return JSON.stringify(marginApp.linkStatus())") as? String ?? "" }

  // ---- Load Unpacked: previewed, then Use Theme: stored, linked, followed, chosen ----
  shell.userThemes.pick = { folder }
  shell.themeAsked("theme.link", [:], window: c.id)
  let previewed = await waitJS(c.webView, "return marginApp.preview().shown === true")
  var said = await linkStatus()
  check("Load Unpacked: the folder picked and read, previewed under Margin's bar (nothing stored yet)", previewed && version() == nil && store.links().isEmpty, said)
  check("…on Load Unpacked's own line in Settings", said.contains("Previewing"), said)
  _ = await js(c.webView, "marginApp.previewPress('use'); return true")
  let linked = await until(5, { store.links().first?.id == "my-theme" && shell.userThemes.watches["my-theme"] != nil })
  check("Use Theme: stored, linked to the folder Margin picked (never a path from the page), its folder followed",
        linked && version() == "1.0.0" && store.links().first?.path == folder.standardizedFileURL.path, "\(store.links()) \(String(describing: version()))")
  let chosen = await until(5, { shell.hostedSettings?.chosenTheme == "my-theme" })
  let drawn = await waitJS(c.webView, "return !!document.querySelector('.pixel')")
  check("…chosen in Margin's own settings and drawn", chosen && drawn, "\(String(describing: shell.hostedSettings?.chosenTheme))")
  let loaded = await waitJS(c.webView, "return /Loaded/.test(marginApp.linkStatus()?.text ?? '')")
  said = await linkStatus()
  check("…its line says it's followed", loaded, said)
  check("…listed for Settings as linked", store.list().first?["linked"] as? Bool == true, "\(store.list())")

  // ---- a save in the folder: read again, checked by the page, stored again, drawn again ----
  write("theme.json", manifest(id: "my-theme", version: "1.0.1"))
  write("theme.html", html.replacingOccurrences(of: "class=\"pixel\"", with: "class=\"pixel e2e-saved\""))
  let restored = await until(8, { version() == "1.0.1" })
  said = await linkStatus()
  check("a save in the folder: read again, checked, stored again (its new version)", restored, "\(String(describing: version())) \(said)")
  let redrawn = await waitJS(c.webView, "return !!document.querySelector('.pixel.e2e-saved')")
  check("…drawn again (the new template's class on the page)", redrawn)
  let when = await waitJS(c.webView, "return /Drawn at/.test(marginApp.linkStatus()?.text ?? '')")
  said = await linkStatus()
  check("…its line says when", when, said)

  // ---- saves that fail: not stored, why said, the last good one drawn ----
  write("theme.json", manifest(id: "another-id", version: "1.0.2"))
  let saidId = await waitJS(c.webView, "return /names “another-id”/.test(marginApp.linkStatus()?.text ?? '')")
  said = await linkStatus()
  check("a save naming another id: not stored, why said", saidId && version() == "1.0.1", said)
  write("theme.json", manifest(id: "my-theme", version: "1.0.3"))
  write("theme.html", html.replacingOccurrences(of: "<m-settings", with: "<m-unknown").replacingOccurrences(of: "</m-settings>", with: "</m-unknown>"))
  let saidParts = await waitJS(c.webView, "return /m-settings/.test(marginApp.linkStatus()?.text ?? '') && marginApp.linkStatus()?.error === true")
  let stillDrawn = await waitJS(c.webView, "return !!document.querySelector('.pixel.e2e-saved')")
  said = await linkStatus()
  check("a save without Settings: not stored, why said, the last good one still drawn", saidParts && version() == "1.0.1" && stillDrawn, said)
  write("theme.html", html)
  let fixed = await until(8, { version() == "1.0.3" })
  check("fixed: stored again", fixed, "\(String(describing: version()))")

  // ---- refused: a save for a theme that isn't linked; a link with no folder picked ----
  var stored = (try? JSONSerialization.jsonObject(with: Data((store.message("my-theme") ?? "{}").utf8))) as? JSONObject ?? [:]
  stored["format"] = 2
  stored["version"] = "9.9.9"
  var refusals: [String] = []
  shell.performTheme("theme.save", ["value": stored, "link": "not-linked"], reply: { refusals.append($0) }, chose: { _ in })
  check("a linked folder's save for a theme not linked under that id: refused, nothing stored", version() == "1.0.3", "\(String(describing: version()))")
  shell.performTheme("theme.save", ["value": stored, "linked": true], reply: { refusals.append($0) }, chose: { _ in })
  check("a link with no folder picked here: refused, said", refusals.contains { $0.contains("themeSaved") && $0.contains("wasn’t picked here") }, "\(refusals)")

  // ---- Unlink: followed no more, stored still ----
  shell.themeAsked("theme.unlink", ["id": "my-theme"], window: c.id)
  check("Unlink: followed no more (its watch gone), the theme stays, not listed as linked",
        store.links().isEmpty && shell.userThemes.watches.isEmpty && version() != nil && store.list().first?["linked"] == nil)

  // ---- Import (the same route): previewed, Use Theme stores it, nothing linked ----
  write("theme.json", manifest(id: "my-theme", version: "2.0.0"))
  shell.themeAsked("theme.import", [:], window: c.id)
  let imported = await waitJS(c.webView, "return marginApp.preview().shown === true")
  _ = await js(c.webView, "marginApp.previewPress('use'); return true")
  let importStored = await until(5, { version() == "2.0.0" })
  check("Import through the same route: previewed, stored, not linked", imported && importStored && store.links().isEmpty, "\(String(describing: version()))")

  // ---- Remove: gone, its link too, Margin's settings back to Arcadia ----
  shell.themeAsked("theme.remove", ["id": "my-theme"], window: c.id)
  let back = await until(5, { shell.hostedSettings?.chosenTheme == "arcadia" })
  check("Remove: gone from the store, Margin's settings back to Arcadia", version() == nil && back, "\(String(describing: shell.hostedSettings?.chosenTheme))")
}
