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
  // Refused: Neo-brutalism's files with a template that has no <m-page>.
  fake.tell(["do": "theme", "id": "A", "theme": "neo-brutalism", "edit": ["html": "<div class=\"broken\">no page here</div>"]])
  check("themes: a refused theme taken by the shell (the checks are the overlay's)", await until(5, { shell.links["safari:P1"]?.themeId == "neo-brutalism" }))
  check("themes: refused in the overlay: Arcadia drawn instead, from the app's own copy",
        await waitJS(o7.webView, "return !!document.querySelector('.arcadia') && !document.querySelector('.broken') && marginApp.themeFailure()?.id === 'neo-brutalism'"))
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
  fake.tell(["do": "theme", "id": "A", "theme": "neo-brutalism", "edit": [
    "html": "<div class=\"stamp\"><m-page></m-page></div>",
    "css": ".stamp{position:fixed;inset:0} .stamp m-page{position:absolute;left:10px;top:10px;width:60px;height:40px;display:block}",
  ]])
  check("themes: a page slot too small to use: Arcadia instead",
        await waitJS(o7.webView, "return !!document.querySelector('.arcadia') && !document.querySelector('.stamp') && /page slot/.test(marginApp.themeFailure()?.why ?? '')"))
  mark = fake.events.count
  fake.tell(["do": "theme", "id": "A", "theme": "neo-brutalism"])
  check("themes: the copy's next good theme drawn again, the failure forgotten",
        await waitJS(o7.webView, "return !document.querySelector('.arcadia') && marginApp.themeFailure() === null"))
  fake.tell(["do": "theme", "id": "A", "theme": "arcadia"])
  check("themes: and back to Arcadia", await until(5, { shell.links["safari:P1"]?.themeId == "arcadia" }))
  check("themes: Arcadia's layout sent again", await until(10, { fake.first("setLayout", since: mark) != nil }))
}

// Neo-brutalism's package, from the repo, as the overlay stores an imported theme
// (ui/theme-loader.js encodeStoredTheme), under another id.
func storedNeo(id: String) -> JSONObject {
  let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../extension/themes/neo-brutalism").standardizedFileURL
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
