// The theme store's client (ShellThemeStore.swift over margin-core's data::theme_store) against a stand-in transport:
// a store that isn't open asks nothing; a list signed by another key isn't used; a package that isn't the one the list
// names isn't handed on; a request the network never answered says so. (The whole flow against the server's own code is
// tools/app-tests/e2e-store.swift.) The list and its key are cloud/themes/vectors.json's, made by the server's code.

import Foundation

func storeClientTests() {
    let fm = FileManager.default
    let tmp = fm.temporaryDirectory.appendingPathComponent("margin-store-client-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: tmp) }
    // (Run where tools/app-tests/run.sh runs the checks: the repo two folders up.)
    guard let data = fm.contents(atPath: "../../cloud/themes/vectors.json"), let vectors = object(String(decoding: data, as: UTF8.self)),
          let index = vectors["index"] as? JSONObject, let body = index["body"] as? String, let key = index["publicKey"] as? String else {
        return check("store client: cloud/themes/vectors.json read", false)
    }
    func wait<T>(_ work: @escaping () async -> T) -> T? {
        var out: T?
        Task { out = await work() }
        let end = Date().addingTimeInterval(10)
        while out == nil, Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        return out
    }
    var asked: [String] = []
    // The stand-in store: the vectors' list; a package of other bytes than the list names.
    let send: (StoreRequest) async -> StoreResponse = { r in
        asked.append("\(r.method) \(r.url.path)")
        if r.url.path == "/v1/index" { return StoreResponse(status: 200, body: Data(body.utf8)) }
        if r.url.path.hasPrefix("/v1/packages/") { return StoreResponse(status: 200, body: Data("not the package".utf8)) }
        return StoreResponse(status: 0, body: Data())
    }

    // Not open: nothing asked, and Settings says so.
    let closed = ThemeStoreClient(root: tmp.appendingPathComponent("closed"), over: nil, send: send)
    let shut = wait { await closed.catalog(installed: []) }
    check("store client: a store that isn't open asks nothing", shut?["state"] as? String == "closed" && asked.isEmpty, "\(shut ?? [:]) \(asked)")
    check("…and makes no key", !fm.fileExists(atPath: tmp.appendingPathComponent("closed/key").path))

    // Open: the list checked with the store's key, each theme with what it is here.
    let client = ThemeStoreClient(root: tmp.appendingPathComponent("open"), over: ("https://themes.example", key), send: send)
    let shown = wait { await client.catalog(installed: [["id": "paper", "version": "1.0.0", "store": ["version": "1.0.0", "sha256": String(repeating: "a", count: 64)]]]) }
    let rows = shown?["rows"] as? [JSONObject] ?? []
    check("store client: the list read, signed by the store; each row's state", shown?["state"] as? String == "ready" && rows.map { $0["id"] as? String } == ["dusk", "paper"]
          && rows.last?["state"] as? String == "update", "\(shown ?? [:])")

    // A package that isn't the list's: not handed on, why said.
    let got = wait { await client.download("dusk") ?? (Data(), "", "") }
    check("store client: a package of other bytes than the list names: refused", got?.version == "" && client.lastError?.contains("isn’t the one the store’s list names") == true, "\(client.lastError ?? "")")
    let gone = wait { await client.download("nope") ?? (Data(), "", "") }
    check("store client: a theme not in the list: nothing asked for it", gone?.version == "" && !asked.contains("GET /v1/packages/nope") && client.lastError?.contains("isn’t in the store’s list") == true, "\(asked)")

    // A list signed by another key: not used.
    let other = ThemeStoreClient(root: tmp.appendingPathComponent("other"), over: ("https://themes.example", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"), send: send)
    let forged = wait { await other.catalog(installed: []) }
    check("store client: a list another key signed: not used, why said", forged?["state"] as? String == "error" && (forged?["message"] as? String)?.contains("isn’t signed by the store") == true, "\(forged ?? [:])")

    // No answer at all (the network): said so.
    let report = wait { await client.report("dusk", reason: "broken") }
    check("store client: no answer from the network: said so", report?["ok"] as? Bool == false && (report?["message"] as? String)?.contains("couldn’t reach the theme store") == true, "\(report ?? [:])")
}
