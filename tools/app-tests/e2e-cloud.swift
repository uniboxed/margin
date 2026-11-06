// iCloud Tabs end to end (part of e2e.swift's scenario): a stand-in for
// Safari's CloudTabs.db in a temporary folder (made-up devices, never
// Safari's own file), read by the real shell's watcher, sent to the real
// overlay page and drawn by Arcadia in its sidebar; a tab opened on the
// "phone" shows up live; a click on a row asks the copy for a new tab with
// its address; "Show iCloud Tabs" turned off in the copy's settings stops
// the reads and takes the folder away; without permission the folder's one
// row offers Full Disk Access (noted, never opened, in a test).
import AppKit
import SQLite3
import WebKit

final class E2ECloud {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-cloud-\(UUID().uuidString)", isDirectory: true)
    private var db: OpaquePointer?
    var path: String { folder.appendingPathComponent("CloudTabs.db").path }
    static let thisMac = "E2E Mac"

    init() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        sqlite3_open(path, &db)
        exec("PRAGMA journal_mode=WAL")
        exec("""
        CREATE TABLE cloud_tab_devices (device_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_name TEXT,device_type_identifier TEXT,has_duplicate_device_name BOOLEAN DEFAULT 0,is_ephemeral_device BOOLEAN DEFAULT 0,last_modified REAL NOT NULL);
        CREATE TABLE cloud_tabs (tab_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_uuid TEXT NOT NULL,position BLOB NOT NULL,title TEXT,url TEXT NOT NULL,is_showing_reader BOOLEAN DEFAULT 0,is_pinned BOOLEAN DEFAULT 0,reader_scroll_position_page_index INTEGER,scene_id TEXT,last_viewed_time REAL DEFAULT 0,topic_title TEXT);
        CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value);
        """)
        let now = Date().timeIntervalSinceReferenceDate
        exec("""
        INSERT INTO cloud_tab_devices VALUES ('E2E-PHONE', x'00', 'E2E iPhone', 'com.apple.iphone-13-pro-9', 0, 0, \(now - 3600));
        INSERT INTO cloud_tab_devices VALUES ('E2E-MAC', x'00', '\(Self.thisMac)', 'com.apple.macbookpro-14-2021-space-gray', 0, 0, \(now));
        INSERT INTO cloud_tabs (tab_uuid, system_fields, device_uuid, position, title, url, is_pinned, last_viewed_time) VALUES
          ('E2E-T1', x'00', 'E2E-PHONE', x'00', 'Ferry timetable', 'https://tagus.example/ferries', 1, \(now - 60)),
          ('E2E-T2', x'00', 'E2E-PHONE', x'00', 'Bread notes', 'https://breadnotes.example/', 0, \(now - 120)),
          ('E2E-M1', x'00', 'E2E-MAC', x'00', 'This Mac''s own', 'https://mine.example/', 0, \(now));
        """)
    }

    @discardableResult func exec(_ sql: String) -> Int32 { sqlite3_exec(db, sql, nil, nil, nil) }

    func remove() {
        sqlite3_close(db)
        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path)
        try? FileManager.default.removeItem(at: folder)
    }
}

// waitJS for longer (a read retried after a permission came back).
func waitJSFor(_ web: WKWebView, _ code: String, for seconds: Double) async -> Bool {
  let end = Date().addingTimeInterval(seconds)
  while Date() < end {
    if await js(web, code) as? Bool == true { return true }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  return false
}

@MainActor
func cloudScenario(shell: Shell, fake: Fake, overlay o7: OverlayController, cloud: E2ECloud) async {
  check("icloud tabs: read while a Safari copy is linked", shell.cloudWatcher?.running == true)
  check("icloud tabs: the folder in Arcadia's sidebar, above + New Tab, the other device's tabs only (not this Mac's)",
        await waitJS(o7.webView, """
          const cloud = document.querySelector('.cloud'); const plus = document.querySelector('.new-tab-row');
          return !!cloud && !!plus && !!(cloud.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING)
            && document.querySelectorAll('.cloud-tab').length === 2 && document.querySelector('.cloud-device .device-name')?.textContent === 'E2E iPhone'
            && !document.body.textContent.includes('own')
          """))
  cloud.exec("INSERT INTO cloud_tabs (tab_uuid, system_fields, device_uuid, position, title, url, last_viewed_time) VALUES ('E2E-T3', x'00', 'E2E-PHONE', x'00', 'Opened just now', 'https://new.example/', \(Date().timeIntervalSinceReferenceDate))")
  check("icloud tabs: a tab opened on the phone shows up, live", await waitJS(o7.webView, "return document.querySelectorAll('.cloud-tab').length === 3 && [...document.querySelectorAll('.cloud-tab .title')].some((t) => t.textContent === 'Opened just now')"))

  // A real press on a row: the copy asked for a new tab with that address, in window 7.
  var mark = fake.events.count
  if let row = rect(await js(o7.webView, "const r = [...document.querySelectorAll('.cloud-tab')].find((e) => e.textContent.includes('Bread notes'))?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null")) {
    press(o7, at: CGPoint(x: row.midX, y: row.midY))
    let asked = await until(3, { fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "newTab" } != nil })
    let req = fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "newTab" }?["msg"] as? JSONObject ?? [:]
    let payload = req["payload"] as? JSONObject ?? [:]
    check("icloud tabs: a press on a row opens it in this window: newTab with its address", asked && payload["url"] as? String == "https://breadnotes.example/" && req["windowId"] as? Int == 7, "\(req)")
  } else { check("icloud tabs: the Bread notes row", false) }

  // "Show iCloud Tabs" off in the copy's settings: no reads, no folder; on again: both back.
  let settings: JSONObject = ["sidebarPinnedOpen": true, "theme": "arcadia", "themes": ["arcadia": ["sidebarWidth": 260]], "showCloudTabs": false]
  fake.tell(["do": "delta", "id": "A", "changes": ["settings": ["newValue": settings]]])
  check("icloud tabs: turned off in Settings: the reads stop", await until(3, { shell.cloudWatcher == nil }))
  check("icloud tabs: and the folder goes", await waitJS(o7.webView, "return !document.querySelector('.cloud')"))
  var on = settings
  on["showCloudTabs"] = true
  fake.tell(["do": "delta", "id": "A", "changes": ["settings": ["newValue": on]]])
  let readAgain = await until(3, { shell.cloudWatcher?.running == true })
  let drawnAgain = await waitJS(o7.webView, "return document.querySelectorAll('.cloud-tab').length === 3")
  check("icloud tabs: on again: read again, the folder back", readAgain && drawnAgain)

  // No permission (as without Full Disk Access): the folder's one row, its button the app's.
  try? FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: cloud.path)
  cloud.exec("UPDATE cloud_tabs SET title = 'Changed' WHERE tab_uuid = 'E2E-T1'")
  check("icloud tabs: no permission: one row says so, with Full Disk Access's button", await waitJSFor(o7.webView, "return document.querySelectorAll('.cloud-tab').length === 0 && !!document.querySelector('.cloud-fix') && document.querySelector('.cloud-note .text')?.textContent.includes('Full Disk Access')", for: 10))
  mark = fake.events.count
  if let button = rect(await js(o7.webView, "const r = document.querySelector('.cloud-fix')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null")) {
    press(o7, at: CGPoint(x: button.midX, y: button.midY))
    check("icloud tabs: its button: System Settings at Full Disk Access, by the app (noted, not opened, in a test)", await until(3, { shell.opened.last == SafariFiles.fullDiskAccessURL }), "\(shell.opened)")
  } else { check("icloud tabs: the Full Disk Access button", false) }
  try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: cloud.path)
  check("icloud tabs: given again: the tabs back", await waitJSFor(o7.webView, "return document.querySelectorAll('.cloud-tab').length === 3", for: 10))
  check("icloud tabs: nothing went to the copy but the one request", fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "newTab" } == nil)
}
