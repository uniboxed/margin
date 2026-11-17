// The real-screen suite (docs/HOSTING-CORE.md, "Behaviour classes and the test framework"; tools/screen-tests/README.md).
// Run by run.sh (npm run test:screen), one part per process:
//   screen-suite --part <name> --margin <Margin.app> --apps <the Chameleon copies' folder> [--real-apps] [--front level|order]
//   screen-suite --dry-run [--real-apps] [--part <name>]   each part's scenarios and steps, touching nothing
//   screen-suite --list-parts [--real-apps]                the parts' names, one a line
//   screen-suite --restore                                 puts the Mac back from the state file of a part that was killed
// It runs only if the Mac has been idle for 180 s and isn't locked (the suite's own posts of the part before left out),
// checks for 60 s of idle before each step, and at the first sign of the person it stops and puts everything back.
// Never in CI: it needs the real screen.
import AppKit
setvbuf(stdout, nil, _IONBF, 0)
_ = t0 // (the run's clock starts here)

let args = Array(CommandLine.arguments.dropFirst())
func value(_ flag: String) -> String? { args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
let dryRun = args.contains("--dry-run"), withReal = args.contains("--real-apps")
let buildDir = value("--build") ?? (URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().path)
statePath = buildDir + "/state.json"
handoffPath = buildDir + "/handoff.json"
builtApps = value("--apps") ?? buildDir + "/apps"
let builtMargin = value("--margin") ?? ""
let allParts = parts(realApps: withReal)

if args.contains("--list-parts") { for p in allParts { print(p.name) }; exit(0) }

// ---- the plan: exactly what a part does (printed first by every run, and alone by --dry-run) ----
func plan(_ p: Part) {
  let est = p.scenarios.reduce(0) { $0 + $1.estimate }
  print("PART \(p.name) (about \(Int(est / 60)) min \(Int(est) % 60) s; hard limit \(Int(hardLimit / 60)) min)")
  print("  Margin: \(builtMargin.isEmpty ? "(--margin not given)" : builtMargin)\(FileManager.default.fileExists(atPath: builtMargin + "/Contents/MacOS") ? "" : " (NOT FOUND: a real run refuses)"); the running Margin quit first, opened again in the background after if it was running")
  print("  Margin's defaults written (each recorded and put back): MarginDevHooks YES, MarginPrepareBrowser NO, MarginResumeLast NO (deleted for a relaunch step), MarginFront (deleted unless --front); \(themeKey) recorded and put back")
  let used = Set(p.scenarios.flatMap(\.copies))
  if !used.isEmpty || !p.realApps {
    print("  test apps: Chameleon copies \(copies.map { "\($0.n)" }.joined(separator: ", ")) copied from \(builtApps) into ~/Applications (\(copies.map { "\($0.name).app" }.joined(separator: ", "))), registered with LaunchServices, removed after with their saved state; their own defaults (test.margin.chameleon.N: Chameleon* switches, ChameleonLog, NSQuitAlwaysKeepsWindows for priming) put back; logs in \(logFolder)")
  }
  if p.realApps {
    let inst = installedRealApps()
    print("  THE PERSON'S OWN APPS: \(inst.map { "\($0.name) (\($0.bundle))" }.joined(separator: ", "))\(realApps.count > inst.count ? "; skipped, not installed: \(realApps.filter { !isInstalled($0.bundle) }.map(\.name).joined(separator: ", "))" : "")")
    print("    recorded first: running or not, pid, windows (numbers, bounds, Spaces), saved-state defaults keys (window frames, full screen, restoration: read with `defaults export`), Margin's library items for each")
    print("    touched ONLY through Margin's dev hook (host, show); no click or key is posted in this part at all; none of their windows or tabs closed by the suite")
    print("    after: apps that weren't running quit politely (never forced); apps that were left running; every changed saved-state key written back, read again, differences reported; Margin's items removed only for apps that had none before")
  } else {
    print("  events posted: clicks and plain keys only on its own Chameleon copies and on Margin's own window (checked on the window list first), Escape; ⌃←/⌃→ (Mission Control's move-a-Space keys, only if they're the default and only Desktops are between), Control and Fn checked released after each")
  }
  print("  window-server writes: none, except making Margin's Space or the starting Space current again (as check10)")
  for s in p.scenarios {
    print("  SCENARIO \(s.name): \(s.title)\(s.copies.isEmpty ? "" : " [Chameleon \(s.copies.map(String.init).joined(separator: ", "))]")")
    for (i, st) in s.steps.enumerated() { print("    \(i + 1). \(st.text)") }
  }
  print("  then: everything put back (Margin quit, test apps quit and removed, defaults as they were, Margin reopened --background if it was running, the starting Space current and verified, the pointer back, modifiers checked released), and a summary: PASS/FAIL/SKIP per step and Margin's log lines")
}
let selected = value("--part").map { name in allParts.filter { $0.name == name } } ?? allParts
if dryRun {
  print("DRY RUN: nothing is touched. \(allParts.count) part(s), each its own process under a \(Int(hardLimit / 60))-minute limit; it starts only if the Mac has been idle \(Int(startIdle)) s and isn't locked (now: idle \(Int(hidIdle())) s, \(locked() ? "LOCKED" : "unlocked"), Accessibility \(canPost ? "granted: clicks and keys are real" : "NOT granted: the click and key steps are skipped"))")
  for p in selected { plan(p) }
  exit(0)
}

// ---- --restore: a part killed from outside, put back from its state file ----
if args.contains("--restore") {
  guard let b = loadState() else { print("no state file at \(statePath): nothing to put back"); exit(0) }
  before = b
  restore("--restore, from \(statePath)")
  exit(0)
}

// ---- a part ----
guard let part = selected.first, value("--part") != nil else { print("give --part <name> (one of \(allParts.map(\.name).joined(separator: ", "))), --dry-run, --list-parts or --restore"); exit(64) }
plan(part)
guard FileManager.default.fileExists(atPath: builtMargin + "/Contents/MacOS") else { print("ABORT: no Margin.app at '\(builtMargin)' (--margin): nothing done"); exit(64) }
loadHandoff(handoffPath)
guard !locked() else { log("REFUSED: the Mac is locked (nothing done)"); exit(3) }
guard userIdle() >= startIdle else { log("REFUSED: the Mac is in use (idle \(Int(userIdle())) s, \(Int(startIdle)) needed): nothing done"); exit(3) }
guard loadState() == nil else { log("ABORT: a state file from a run that wasn't put back is there (\(statePath)): run `run.sh --restore` first; nothing done"); exit(7) }
let usesCopies = !part.realApps
if usesCopies {
  guard copies.allSatisfy({ !FileManager.default.fileExists(atPath: $0.installed) && app($0.id) == nil }) else { log("ABORT: a Chameleon copy is installed or running already: nothing done"); exit(7) }
  guard copies.allSatisfy({ FileManager.default.fileExists(atPath: "\(builtApps)/\($0.name).app") }) else { log("ABORT: the Chameleon copies aren't built in \(builtApps) (apps/Chameleon/build.sh): nothing done"); exit(7) }
}
log("idle \(Int(userIdle())) s; this suite \(canPost ? "may" : "may NOT") post events (Accessibility)")
// (The person's apps recorded with their own Margin quit first: an app it hosts quits with it, and isn't theirs to
// record as running.)
let marginBefore = app(marginId)
if part.realApps, let m = marginBefore {
  log("quitting the running Margin before recording the person's apps")
  m.terminate(); spin(20) { m.isTerminated }
  spin(3)
}
recordBefore(part: part.name, built: builtMargin, realApps: part.realApps ? installedRealApps() : [])
if part.realApps, let m = marginBefore { before.marginPath = m.bundleURL?.path; saveState() }
log("before: Margin \(before.marginPath == nil ? "not running" : "running"); Mission Control \(before.mcCount) Spaces; Space \(before.home); defaults " + marginKeys.map { "\($0) '\(before.marginDefaults[$0]?.prefix(20) ?? "")'" }.joined(separator: " "))
for r in before.realApps { log("before: \(describe(r))") }
logStart = Date()
startWatchdog()
if usesCopies { installCopies() }
spin(1)
let runner = Runner()
runner.built = builtMargin
runner.wantFront = value("--front").flatMap { ["level", "order"].contains($0) ? $0 : nil }
for s in part.scenarios {
  currentScenario = s.name
  log("SCENARIO \(s.name): \(s.title)")
  for st in s.steps { runner.run(st) }
}
restore("done")
exit(results.contains { $0.ok == false } ? 1 : 0)
