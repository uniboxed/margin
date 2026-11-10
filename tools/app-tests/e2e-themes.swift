// Themes the overlay can't draw (part of e2e.swift's scenario, docs/phase6-themes.md §3):
// a package the checks refuse, and one whose page slot is a postage stamp, each
// sent by the copy as its theme. The real overlay draws Arcadia instead (bundled
// beside it: dist/app/arcadia.js), says ready as usual, puts up Margin's own
// notice, and logs the theme's id and the kinds of what was wrong only. The
// copy's next good theme is drawn again.
import AppKit
import WebKit

@MainActor
func themeFallbackScenario(shell: Shell, fake: Fake, overlay o7: OverlayController) async {
  // Refused: Neubrutalism's files with a template that has no <m-page>.
  fake.tell(["do": "theme", "id": "A", "theme": "neubrutalism", "edit": ["html": "<div class=\"broken\">no page here</div>"]])
  check("themes: a refused theme taken by the shell (the checks are the overlay's)", await until(5, { shell.links["safari:P1"]?.themeId == "neubrutalism" }))
  check("themes: refused in the overlay: Arcadia drawn instead, from the app's own copy",
        await waitJS(o7.webView, "return !!document.querySelector('.arcadia') && !document.querySelector('.broken') && marginApp.themeFailure()?.id === 'neubrutalism'"))
  check("themes: and Margin says so, in its own words, with Settings and OK",
        await waitJS(o7.webView, "const n = document.querySelector('.notice'); return !!n && n.querySelector('.text')?.textContent.includes('couldn’t draw the theme you chose, so it’s using Arcadia') && [...n.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|') === 'Settings|OK'"))
  let why = await js(o7.webView, "return marginApp.themeFailure()?.why ?? ''") as? String ?? ""
  check("themes: why, as kinds only (nothing from the theme's files)", why.contains("theme.html") && !why.contains("broken") && !why.contains("no page here"), why)
  check("themes: the overlay still shown over its window", o7.isReady && o7.isShown)

  // OK closes the notice; nothing goes to the copy.
  var mark = fake.events.count
  if let ok = rect(await js(o7.webView, "const b = [...document.querySelectorAll('.notice button')].find((x) => x.textContent.trim() === 'OK')?.getBoundingClientRect(); return b ? [b.x, b.y, b.width, b.height] : null")) {
    press(o7, at: CGPoint(x: ok.midX, y: ok.midY))
    check("themes: OK closes it", await waitJS(o7.webView, "return !document.querySelector('.notice')"))
    try? await Task.sleep(nanoseconds: 300_000_000)
    check("themes: and the copy heard nothing of it", fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "noticeAction" } == nil)
  } else { check("themes: the notice's OK button", false) }

  // Passes the checks, but its page is 60 × 40: unusable, so Arcadia again.
  fake.tell(["do": "theme", "id": "A", "theme": "neubrutalism", "edit": [
    "html": "<div class=\"stamp\"><m-page></m-page></div>",
    "css": ".stamp{position:fixed;inset:0} .stamp m-page{position:absolute;left:10px;top:10px;width:60px;height:40px;display:block}",
  ]])
  check("themes: a page slot too small to use: Arcadia instead",
        await waitJS(o7.webView, "return !!document.querySelector('.arcadia') && !document.querySelector('.stamp') && /page slot/.test(marginApp.themeFailure()?.why ?? '')"))
  mark = fake.events.count
  fake.tell(["do": "theme", "id": "A", "theme": "neubrutalism"])
  check("themes: the copy's next good theme drawn again, the failure forgotten",
        await waitJS(o7.webView, "return !document.querySelector('.arcadia') && marginApp.themeFailure() === null"))
  fake.tell(["do": "theme", "id": "A", "theme": "arcadia"])
  check("themes: and back to Arcadia", await until(5, { shell.links["safari:P1"]?.themeId == "arcadia" }))
  check("themes: Arcadia's layout sent again", await until(10, { fake.first("setLayout", since: mark) != nil }))
}

// Neubrutalism's package, from the repo, as the overlay stores an imported theme
// (ui/theme-loader.ts encodeStoredTheme), under another id.
func storedNeo(id: String) -> JSONObject {
  let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../extension/themes/neubrutalism").standardizedFileURL
  let text = { (f: String) in (try? String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8)) ?? "" }
  var manifest = (try? JSONSerialization.jsonObject(with: Data(text("theme.json").utf8))) as? JSONObject ?? [:]
  manifest["id"] = id
  manifest["name"] = "E2E Neo"
  var files: [String: String] = [:]
  for f in (manifest["fonts"] as? [JSONObject] ?? []).compactMap({ $0["file"] as? String }) {
    files[f] = (try? Data(contentsOf: dir.appendingPathComponent(f)))?.base64EncodedString()
  }
  return ["format": 2, "id": id, "version": manifest["version"] ?? "1.0.0", "savedAt": 1, "manifest": jsonString(manifest) ?? "{}", "html": text("theme.html"), "css": text("theme.css"), "files": files]
}

// Imported themes kept by the app (ShellThemes.swift): stored, the index to the copy and
// the overlay, the profile's settings.theme asked for, the stored package drawn once the
// copy's settings choose it, and removed again: the copy asked to go back to Arcadia.
@MainActor
func userThemesScenario(shell: Shell, fake: Fake, overlay o7: OverlayController) async {
  check("user themes: the copy was given the index as it linked", fake.first("req") { (($0["msg"] as? JSONObject)?["type"] as? String) == "userThemes" } != nil)
  check("user themes: the store is a temporary folder in a test", shell.userThemes.store.root.path.hasPrefix(FileManager.default.temporaryDirectory.path))
  var mark = fake.events.count
  shell.performTheme(from: o7, "theme.save", ["value": storedNeo(id: "e2e-neo")])
  check("user themes: stored", shell.userThemes.store.has("e2e-neo"))
  let reqOf = { (type: String) in fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == type }?["msg"] as? JSONObject }
  check("user themes: the index to the copy, with only the entry's fields", await until(3, { reqOf("userThemes") != nil })
        && ((reqOf("userThemes")?["payload"] as? JSONObject)?["list"] as? [JSONObject])?.first.map { Set($0.keys) == ["id", "name", "version", "author", "bytes", "savedAt"] } == true)
  check("user themes: and the window's profile asked to use it", await until(3, { reqOf("updateSettings") != nil })
        && same((reqOf("updateSettings")?["payload"] as? JSONObject)?["patch"], ["theme": "e2e-neo"]) && reqOf("updateSettings")?["windowId"] as? Int == 7)
  let stateNow = shell.links["safari:P1"]?.mirror.stateJSON().flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject } ?? [:]
  var settings = (stateNow["settings"] as? JSONObject) ?? [:]
  settings["theme"] = "e2e-neo"
  fake.tell(["do": "delta", "id": "A", "changes": ["settings": ["newValue": settings]]])
  check("user themes: the copy's settings choose it: the stored package drawn (the copy still sends Arcadia)",
        await waitJS(o7.webView, "return !!document.querySelector('.nb') && !document.querySelector('.arcadia') && marginApp.themeFailure() === null")
          && shell.links["safari:P1"]?.themeId == "arcadia")

  mark = fake.events.count
  shell.performTheme(from: o7, "theme.remove", ["id": "e2e-neo"])
  check("user themes: removed from the store", !shell.userThemes.store.has("e2e-neo"))
  check("user themes: the copy that used it asked to go back to Arcadia", await until(3, { reqOf("updateSettings") != nil }) && same((reqOf("updateSettings")?["payload"] as? JSONObject)?["patch"], ["theme": "arcadia"]))
  check("user themes: and given the index without it", ((reqOf("userThemes")?["payload"] as? JSONObject)?["list"] as? [JSONObject])?.isEmpty == true)
  check("user themes: the overlay draws the copy's theme again at once", await waitJS(o7.webView, "return !!document.querySelector('.arcadia') && !document.querySelector('.nb')"))
  settings["theme"] = "arcadia"
  fake.tell(["do": "delta", "id": "A", "changes": ["settings": ["newValue": settings]]])
  check("user themes: a theme that isn't the app's can't be saved", { shell.performTheme(from: o7, "theme.save", ["value": storedNeo(id: "arcadia")]); return !shell.userThemes.store.has("arcadia") }())
}

// A copy of a built-in theme's folder as a person's: its own id and name, only a package's files.
func personalCopy(of builtin: String, id: String, name: String, in root: URL) -> URL {
  let fm = FileManager.default
  let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../extension/themes/\(builtin)").standardizedFileURL
  let dst = root.appendingPathComponent(id, isDirectory: true)
  try? fm.removeItem(at: dst)
  try? fm.copyItem(at: src, to: dst)
  for extra in ["first-paint.css", "theme.ts"] { try? fm.removeItem(at: dst.appendingPathComponent(extra)) }
  let manifestURL = dst.appendingPathComponent("theme.json")
  var manifest = (try? JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL))) as? JSONObject ?? [:]
  manifest["id"] = id
  manifest["name"] = name
  manifest["version"] = "1.0.0"
  try? JSONSerialization.data(withJSONObject: manifest).write(to: manifestURL)
  return dst
}

// Import Theme… end to end, with the harness answering for the file picker: a folder
// previewed under Margin's bar and used; a .margintheme file previewed and cancelled (the
// theme from before back); a folder with a script in it refused, with why.
@MainActor
func importScenario(shell: Shell, fake: Fake, overlay o7: OverlayController) async {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-import-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root); shell.userThemes.pick = nil }
  let folder = personalCopy(of: "neubrutalism", id: "e2e-import", name: "E2E Import", in: root)
  shell.userThemes.pick = { folder }
  var mark = fake.events.count
  shell.performTheme(from: o7, "theme.import", nil)
  check("import: a folder picked: previewed over the window, under Margin's bar with the theme's name",
        await waitJS(o7.webView, "const p = marginApp.preview(); return p.shown && p.text.includes('Previewing “E2E Import” 1.0.0 by Margin') && !!document.querySelector('.nb')"))
  check("import: the bar takes the pointer (in the hits the app gets)", await waitJS(o7.webView, "return !!marginApp.preview().rect"))
  check("import: nothing went to the copy while previewing", fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "updateSettings" } == nil)
  _ = await js(o7.webView, "marginApp.previewPress('use'); return true")
  check("import: Use Theme: kept by the app", await until(5, { shell.userThemes.store.has("e2e-import") }))
  check("import: and this profile asked to use it", await until(3, { fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "updateSettings" } != nil }))
  check("import: the bar gone", await waitJS(o7.webView, "return !marginApp.preview().shown && !!document.querySelector('.nb')"))
  let stateNow = shell.links["safari:P1"]?.mirror.stateJSON().flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject } ?? [:]
  var settings = (stateNow["settings"] as? JSONObject) ?? [:]
  settings["theme"] = "e2e-import"
  check("import: until the app's package for it comes, Settings says it's saving", await waitJS(o7.webView, "return marginApp.saving() === 'e2e-import' || /^Saved\\./.test(marginApp.importStatus()?.text ?? '')"))
  fake.tell(["do": "delta", "id": "A", "changes": ["settings": ["newValue": settings]]])
  check("import: the app's package for it came: saved, nothing waiting", await waitJS(o7.webView, "return marginApp.saving() === null && /^Saved\\./.test(marginApp.importStatus()?.text ?? '') && !!document.querySelector('.nb')"))
  try? await Task.sleep(nanoseconds: 300_000_000)

  // Use Theme refused by the app (its store full): the theme from before back, not the unsaved one.
  let tiny = { (id: String) -> JSONObject in ["format": 2, "id": id, "version": "1.0.0", "savedAt": 1, "manifest": jsonString(["format": 2, "id": id, "name": id, "version": "1.0.0"] as JSONObject) ?? "{}", "html": "<div><m-page></m-page></div>", "css": "", "files": [String: String]()] }
  let fillers = (0..<(ThemeStore.maxThemes - shell.userThemes.store.list().count)).map { "e2e-fill-\($0)" }
  for id in fillers { _ = try? shell.userThemes.store.save(tiny(id)) }
  shell.themesListChanged()
  let full = personalCopy(of: "arcadia", id: "e2e-full", name: "E2E Full", in: root)
  shell.userThemes.pick = { full }
  shell.performTheme(from: o7, "theme.import", nil)
  check("import: with the store full, a theme still previewed", await waitJS(o7.webView, "const p = marginApp.preview(); return p.shown && p.text.includes('“E2E Full”') && !!document.querySelector('.arcadia')"))
  _ = await js(o7.webView, "marginApp.previewPress('use'); return true")
  check("import: Use Theme refused by the app: the theme from before drawn again, and Settings says why",
        await waitJS(o7.webView, "const s = marginApp.importStatus(); return !!document.querySelector('.nb') && !document.querySelector('.arcadia') && marginApp.saving() === null && !!s?.error && s.text.includes('more than')")
          && !shell.userThemes.store.has("e2e-full"))
  for id in fillers { _ = try? shell.userThemes.store.remove(id) }
  shell.themesListChanged()

  // A .margintheme file (macOS's own zip of a folder), previewed and cancelled.
  let arc = personalCopy(of: "arcadia", id: "e2e-zip", name: "E2E Zip", in: root)
  let zip = root.appendingPathComponent("e2e-zip.margintheme")
  let ditto = Process()
  ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
  ditto.arguments = ["-c", "-k", "--keepParent", arc.path, zip.path]
  try? ditto.run()
  ditto.waitUntilExit()
  shell.userThemes.pick = { zip }
  shell.performTheme(from: o7, "theme.import", nil)
  check("import: a .margintheme file picked: read in the overlay and previewed",
        await waitJS(o7.webView, "const p = marginApp.preview(); return p.shown && p.text.includes('“E2E Zip”') && !!document.querySelector('.arcadia')"))
  _ = await js(o7.webView, "marginApp.previewPress('cancel'); return true")
  check("import: Cancel: the theme from before back, nothing kept", await waitJS(o7.webView, "return !marginApp.preview().shown && !!document.querySelector('.nb') && !document.querySelector('.arcadia')") && !shell.userThemes.store.has("e2e-zip"))

  // Refused: a script in the folder.
  try? Data("alert(1)".utf8).write(to: folder.appendingPathComponent("evil.js"))
  shell.userThemes.pick = { folder }
  shell.performTheme(from: o7, "theme.import", nil)
  check("import: a folder with a script refused, and Settings says why", await waitJS(o7.webView, "const s = marginApp.importStatus(); return !marginApp.preview().shown && !!s?.error && s.text.includes('evil.js')"))
  shell.userThemes.pick = { nil }
  mark = fake.events.count
  shell.performTheme(from: o7, "theme.import", nil)
  try? await Task.sleep(nanoseconds: 200_000_000)
  check("import: the picker cancelled: nothing happens", fake.first("req", since: mark) == nil)

  // Removed while in use: back to the copy's own theme.
  shell.performTheme(from: o7, "theme.remove", ["id": "e2e-import"])
  check("import: removed while in use: Arcadia again", await waitJS(o7.webView, "return !!document.querySelector('.arcadia') && !document.querySelector('.nb')"))
  settings["theme"] = "arcadia"
  fake.tell(["do": "delta", "id": "A", "changes": ["settings": ["newValue": settings]]])

  // Previewed and cancelled while Arcadia stands in for a theme Margin couldn't draw: Arcadia back, still standing in.
  try? await Task.sleep(nanoseconds: 300_000_000)
  fake.tell(["do": "theme", "id": "A", "theme": "neubrutalism", "edit": ["html": "<div class=\"broken\">no page here</div>"]])
  check("import: the copy's theme refused: Arcadia standing in", await waitJS(o7.webView, "return !!document.querySelector('.arcadia') && marginApp.themeFailure()?.id === 'neubrutalism'"))
  let other = personalCopy(of: "neubrutalism", id: "e2e-over-fallback", name: "E2E Over", in: root)
  shell.userThemes.pick = { other }
  shell.performTheme(from: o7, "theme.import", nil)
  check("import: over the fallback: previewed", await waitJS(o7.webView, "const p = marginApp.preview(); return p.shown && !!document.querySelector('.nb')"))
  _ = await js(o7.webView, "marginApp.previewPress('cancel'); return true")
  check("import: Cancel over the fallback: Arcadia back, still standing in for the theme it couldn't draw",
        await waitJS(o7.webView, "return !marginApp.preview().shown && !!document.querySelector('.arcadia') && !document.querySelector('.nb') && marginApp.themeFailure()?.id === 'neubrutalism'"))
  fake.tell(["do": "theme", "id": "A", "theme": "arcadia"])
  check("import: the copy's good theme again", await waitJS(o7.webView, "return !!document.querySelector('.arcadia') && marginApp.themeFailure() === null"))
}
