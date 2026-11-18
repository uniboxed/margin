// The suite's verdict rules that need no screen: pure functions over what it read (Margin's log lines, a copy's own log,
// pluginkit's list), checked by `screen-suite --self-check` against the lines of the real-screen run of 2026-11-17 20:20.
import Foundation

// A Chameleon copy's windows it closed itself ("closed 76030 kind twin"): a closed NSWindow its app keeps stays listed by
// the window server at its last frame, in Margin's Space, off screen, for good (replacesWindow-every, 20:34: 76009,
// 76012, … each counted as a leftover after its app replaced it, though Margin had adopted the new one in ~180 ms).
// Never a leftover, never a main window.
func closedWindows(_ copyLog: [String]) -> Set<Int> {
  Set(copyLog.compactMap { match($0, #" closed (\d+) kind "#).flatMap { Int($0[0]) } })
}

// Whether a read of the desired state is taken while Margin is still correcting (its page card `loading`: an open or a
// placing again under way, under its freeze): not a verdict yet (restore-code, 20:27:47: read while Margin placed the
// member again after its app re-laid it out; AppKit's full-screen transition window, 1512×982, was in the member's new
// full-screen Space, made current for 2 ms under the freeze, so it was listed in front of Margin's panel). The hold has
// the same rule ("loading → shown" settles).
func correcting(_ pageWord: String?) -> Bool { pageWord == "loading" }

// The other Margin builds whose extension is registered beside the one under test (`pluginkit -mDAvvv -i
// com.unibox.margin.Extension`): Safari runs one build's extension handler at a time and refuses the other's native
// messages meanwhile ("Other version in use"), so a profile's copy can't ask for its link for seconds at a time.
func otherBuilds(_ pluginkit: String, built: String) -> [String] {
  let paths = pluginkit.split(separator: "\n").compactMap { line -> String? in
    guard let m = match(String(line), #"^\s*Path = (.*)/Contents/PlugIns/[^/]+\.appex\s*$"#) else { return nil }
    return m[0]
  }
  let mine = (built as NSString).standardizingPath
  return Array(Set(paths.filter { ($0 as NSString).standardizingPath != mine })).sorted()
}

// What a Safari first open took, from Margin's own lines since the ask (each line's own time, `stamp`): its copies
// linked, the item's profile's copy linked (and the presses of Safari's menu it took), its window, shown. Seconds after
// `from`. Nil parts: not said.
struct SafariStory {
  var firstHello: Double?, profileLinked: Double?, presses = 0, opened: Double?, shown: Double?, failed: String?
  var text: String {
    func s(_ v: Double?) -> String { v.map { String(format: "+%.1f s", $0) } ?? "never" }
    return "Safari's first copy linked \(s(firstHello)); the item's profile linked \(s(profileLinked))\(presses > 0 ? " (\(presses) press\(presses == 1 ? "" : "es") of Safari's menu)" : ""); its window \(s(opened)); shown \(s(shown))\(failed.map { "; FAILED: \($0)" } ?? "")"
  }
}
func safariStory(_ lines: [String], from: Date) -> SafariStory {
  var story = SafariStory()
  func at(_ l: String) -> Double? { stamp(l).map { $0.timeIntervalSince(from) } }
  for l in lines {
    guard let t = at(l), t >= -0.05 else { continue }
    if story.firstHello == nil, l.contains("] hello: safari:") { story.firstHello = t }
    if l.contains("hosted: a Safari profile with no window: one opened from Safari's menu") { story.presses += 1 }
    if story.profileLinked == nil, l.contains("hosted: a Safari profile linked in") { story.profileLinked = t }
    if story.opened == nil, l.contains("host: safari:"), l.contains(" opened (pid") { story.opened = t }
    if story.shown == nil, l.contains("host: safari:"), l.contains(" shown in") { story.shown = t }
    if story.failed == nil, l.contains("host: safari:"), l.contains(" failed") { story.failed = String(l.suffix(120)) }
  }
  return story
}

// ---- --self-check ----
func selfCheck() -> Bool {
  var failures = 0
  func expect(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
    print("\(ok ? "ok  " : "FAIL") \(name)\(ok ? "" : ": \(detail())")")
    if !ok { failures += 1 }
  }
  // replacesWindow-every (20:34): its own log's lines for the windows it closed.
  let chameleon = [
    "CHAMELEON 1794965687.987 pid 43997 replaced 76030 by 76033 (the old one at 350,73 1154x869)",
    "CHAMELEON 1794965687.987 pid 43997 closed 76030 kind twin",
    "CHAMELEON 1794965683.990 pid 43997 closed 76027 kind main",
    "CHAMELEON 1794965687.957 pid 43997 window made 76033 kind main frame 350,73 1154x869 subrole AXDialog",
  ]
  expect("closed windows: the ones its app closed, not the one it made", closedWindows(chameleon) == [76030, 76027], "\(closedWindows(chameleon))")
  expect("a read while Margin's page card is loading isn't a verdict", correcting("loading") && !correcting("shown") && !correcting(nil))
  // pluginkit with the build under test and the installed Margin (20:44, both registered).
  let pk = """
       com.unibox.margin.Extension(0.1.1)
  \t            Path = /private/tmp/w-core/xcode/build/Build/Products/Release/Margin.app/Contents/PlugIns/Margin Extension.appex
       com.unibox.margin.Extension(0.1.1)
  \t            Path = /Users/someone/Applications/Margin.app/Contents/PlugIns/Margin Extension.appex
   (2 plug-ins)
  """
  let others = otherBuilds(pk, built: "/private/tmp/w-core/xcode/build/Build/Products/Release/Margin.app")
  expect("other builds: the installed Margin beside the build under test", others == ["/Users/someone/Applications/Margin.app"], "\(others)")
  expect("other builds: none when only the build under test is registered", otherBuilds(pk.components(separatedBy: "\n").prefix(2).joined(separator: "\n"), built: "/private/tmp/w-core/xcode/build/Build/Products/Release/Margin.app").isEmpty)
  // Safari's second open of 20:47 (Margin's own lines).
  let lines = [
    "2026-11-17 20:47:19.168 Df Margin[48356:adca24] [com.unibox.margin:shell] dev hook: host app com.apple.Safari (asked by pid 48312)",
    "2026-11-17 20:47:23.201 Df Margin[48356:adca24] [com.unibox.margin:shell] hello: safari:s-default, Margin 0.1.1",
    "2026-11-17 20:47:23.247 Df Margin[48356:adca24] [com.unibox.margin:shell] hosted: a Safari profile with no window: one opened from Safari's menu so its copy links (press 1)",
    "2026-11-17 20:47:38.523 Df Margin[48356:adca24] [com.unibox.margin:shell] hello: safari:s-f236459b-…, Margin 0.1.1",
    "2026-11-17 20:47:38.530 Df Margin[48356:adca24] [com.unibox.margin:shell] hosted: a Safari profile linked in 15.3 s (1 press of Safari's menu)",
    "2026-11-17 20:47:39.073 Df Margin[48356:adca24] [com.unibox.margin:shell] host: safari:p646 opened (pid 51887, window 76317, the copy's 465): launch 46 (no Dock icon), window 19844 (by the window server)",
    "2026-11-17 20:47:40.185 Df Margin[48356:adca24] [com.unibox.margin:shell] host: safari:p646 shown in 1028 ms (full screen, at the page area)",
  ]
  let from = stamp(lines[0])!
  let story = safariStory(lines, from: from)
  expect("Safari's story: each part from the ask", story.firstHello.map { abs($0 - 4.03) < 0.01 } == true && story.presses == 1 && story.profileLinked.map { abs($0 - 19.36) < 0.01 } == true
         && story.opened.map { abs($0 - 19.9) < 0.01 } == true && story.shown.map { abs($0 - 21.02) < 0.01 } == true && story.failed == nil, story.text)
  let failedStory = safariStory(lines.prefix(3) + ["2026-11-17 20:47:55.999 Df Margin[48356:adca24] [com.unibox.margin:shell] host: safari:p646: window failed: Safari's extension didn't link"], from: from)
  expect("Safari's story: a failure said", failedStory.failed != nil && failedStory.shown == nil, failedStory.text)
  print(failures == 0 ? "self-check: all passed" : "self-check: \(failures) failed")
  return failures == 0
}
