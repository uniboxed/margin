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
