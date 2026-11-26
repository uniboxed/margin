// The theme store's client on the Mac (docs/THEME-STORE.md §2–§4): margin-core's data::theme_store (through margin-ffi's
// theme_store.rs) makes every request and reads every answer: where the store is, the install's key and what it signs,
// the proof of work, the signed index, a package checked against it, a shared theme's .margintheme. This side sends
// them (URLSession, or a test's transport) and keeps the order: a signed request the server answers "unknown key" is
// sent again once the key is registered (a challenge, the work off the main thread, the registration).
//
// What a page names is a theme's id only: the package's address and SHA-256 come from the last index that checked
// out, kept in the core's object. The log says what happened and sizes, never a key, an id of the person's or a theme.

import Foundation
import MarginCore

struct StoreRequest {
    let method: String
    let url: URL
    let headers: [String: String]
    let body: Data
}

struct StoreResponse {
    // 0: no answer (the network, a timeout).
    let status: Int
    let body: Data
}

final class ThemeStoreClient {
    static var appRoot: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Margin/theme-store", isDirectory: true)
    }

    // A test's or a developer's local store, from the process's environment (never a setting or a page):
    // MARGIN_THEME_STORE_URL and MARGIN_THEME_STORE_KEY, both or neither.
    static var environmentStore: (base: String, key: String)? {
        let env = ProcessInfo.processInfo.environment
        guard let base = env["MARGIN_THEME_STORE_URL"], let key = env["MARGIN_THEME_STORE_KEY"], !base.isEmpty, !key.isEmpty else { return nil }
        return (base, key)
    }

    // The largest answer read: an index (8 MB) is the largest the core reads.
    static let maxAnswer = 8 * 1024 * 1024

    private var core: OpaquePointer?
    let send: (StoreRequest) async -> StoreResponse

    init(root: URL, over: (base: String, key: String)?, send: ((StoreRequest) async -> StoreResponse)? = nil) {
        let overJSON = over.map { KeysCore.json(["base": $0.base, "key": $0.key] as JSONObject) }
        core = KeysCore.bytes(root.path) { r, rn in
            if let overJSON {
                return KeysCore.bytes(overJSON) { o, on in margin_theme_store_new(r, rn, o, on) }
            }
            return margin_theme_store_new(r, rn, nil, 0)
        }
        self.send = send ?? ThemeStoreClient.urlSession
    }

    deinit { margin_theme_store_free(core) }

    func call(_ request: JSONObject) -> JSONObject {
        let answer = KeysCore.bytes(KeysCore.json(request)) { p, n in KeysCore.answer { margin_theme_store_call(core, p, n, $0) } } as? JSONObject ?? [:]
        if let error = answer["error"] as? String { Diagnostics.warn("theme store: \(error)") }
        return answer
    }

    var isOpen: Bool { call(["type": "config"])["open"] as? Bool == true }

    // ---- sending ----

    // An ephemeral session: no cookies, no cache on disk, no credentials kept.
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 120
        c.httpCookieAcceptPolicy = .never
        c.httpShouldSetCookies = false
        c.urlCache = nil
        return URLSession(configuration: c)
    }()

    static func urlSession(_ r: StoreRequest) async -> StoreResponse {
        var req = URLRequest(url: r.url)
        req.httpMethod = r.method
        for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
        if !r.body.isEmpty { req.httpBody = r.body }
        guard let (data, response) = try? await session.data(for: req), let http = response as? HTTPURLResponse else {
            return StoreResponse(status: 0, body: Data())
        }
        return StoreResponse(status: http.statusCode, body: data.count <= maxAnswer ? data : Data())
    }

    // A request the core made (`{ method, url, headers, body: base64 }`), or nil with why (`{ ok: false, message }`).
    private func request(of made: JSONObject) -> StoreRequest? {
        guard let method = made["method"] as? String, let urlText = made["url"] as? String, let url = URL(string: urlText),
              let headers = made["headers"] as? [String: String], let body = Data(base64Encoded: made["body"] as? String ?? "") else { return nil }
        return StoreRequest(method: method, url: url, headers: headers, body: body)
    }

    private func outcome(_ kind: String, _ response: StoreResponse) -> JSONObject {
        if response.status == 0 { return ["ok": false, "message": "Margin couldn’t reach the theme store: check the connection and try again."] }
        return call(["type": "outcome", "kind": kind, "status": response.status, "body": response.body.base64EncodedString()])
    }

    private static let notMade: JSONObject = ["ok": false, "message": "Margin couldn’t make that request to the theme store."]

    // A signed request (`make` gives the core's call for it, at a time), sent; if the server doesn't know the key, the key
    // registered and the request made again, signed anew (once).
    private func signed(_ kind: String, _ make: (Double) -> JSONObject) async -> (JSONObject, StoreResponse?) {
        for attempt in 0..<2 {
            let made = call(make(Date().timeIntervalSince1970 * 1000))
            if made["ok"] as? Bool == false { return (made, nil) }
            guard let req = request(of: made) else { return (Self.notMade, nil) }
            let response = await send(req)
            let result = outcome(kind, response)
            if result["register"] as? Bool == true, attempt == 1 {
                return (["ok": false, "message": "The theme store didn’t take this Mac’s key: try again later."], response)
            }
            guard result["register"] as? Bool == true else { return (result, response) }
            if let failed = await register() { return (failed, nil) }
        }
        return (Self.notMade, nil)
    }

    // The install's key registered (docs/THEME-STORE.md §2): a challenge, the work (off the main thread), the
    // registration. Nil when it's done, else why.
    private func register() async -> JSONObject? {
        guard let ask = request(of: call(["type": "challenge.request"])) else { return Self.notMade }
        let answer = await send(ask)
        let got = outcome("challenge", answer)
        guard got["ok"] as? Bool == true else { return got }
        let read = call(["type": "challenge.read", "body": answer.body.base64EncodedString()])
        guard read["ok"] as? Bool == true, let challenge = read["challenge"] as? String, let bits = read["bits"] as? Int else { return read }
        let key = call(["type": "publicKey"])
        guard let publicKey = key["publicKey"] as? String else { return key }
        let started = Date()
        let work = KeysCore.json(["challenge": challenge, "publicKey": publicKey, "bits": bits] as JSONObject)
        let solved: JSONObject = await withCheckedContinuation { done in
            DispatchQueue.global(qos: .userInitiated).async {
                let answer = KeysCore.bytes(work) { p, n in KeysCore.answer { margin_theme_store_solve(p, n, $0) } } as? JSONObject ?? [:]
                done.resume(returning: answer)
            }
        }
        guard solved["ok"] as? Bool == true, let nonce = solved["nonce"] as? String else { return solved }
        Diagnostics.note("theme store: the key's work done (\(bits) bits, \(Int(Date().timeIntervalSince(started) * 1000)) ms)")
        let (registered, _) = await signedOnce("register") { now in ["type": "register.request", "challenge": challenge, "nonce": nonce, "now": now] }
        guard registered["ok"] as? Bool == true else { return registered }
        Diagnostics.note("theme store: the key registered")
        return nil
    }

    private func signedOnce(_ kind: String, _ make: (Double) -> JSONObject) async -> (JSONObject, StoreResponse?) {
        let made = call(make(Date().timeIntervalSince1970 * 1000))
        if made["ok"] as? Bool == false { return (made, nil) }
        guard let req = request(of: made) else { return (Self.notMade, nil) }
        let response = await send(req)
        return (outcome(kind, response), response)
    }

    // ---- what Settings asks ----

    // The store's themes, each with what it is to this install (`installed`: ThemeStore.list(), with each one's
    // `store` record): `{ state: "ready", rows }`, `{ state: "closed" }`, or `{ state: "error", message }`.
    func catalog(installed: [JSONObject]) async -> JSONObject {
        guard isOpen else { return ["state": "closed"] }
        guard let req = request(of: call(["type": "index.request"])) else { return ["state": "error", "message": Self.notMade["message"] ?? ""] }
        let response = await send(req)
        let got = outcome("index", response)
        guard got["ok"] as? Bool == true else { return ["state": "error", "message": got["message"] ?? ""] }
        let read = call(["type": "index.read", "body": response.body.base64EncodedString(), "installed": installed])
        guard read["ok"] as? Bool == true, let rows = read["rows"] as? [JSONObject] else { return ["state": "error", "message": read["message"] ?? ""] }
        Diagnostics.note("theme store: its list read (\(rows.count) themes, \(response.body.count) bytes)")
        return ["state": "ready", "rows": rows]
    }

    // The rows again (what each is to this install changed: one installed, updated or removed), from the list kept.
    func rows(installed: [JSONObject]) -> [JSONObject] {
        call(["type": "rows", "installed": installed])["rows"] as? [JSONObject] ?? []
    }

    // A store theme's package, downloaded and checked against the list: its bytes, version and SHA-256, or why not.
    func download(_ id: String) async -> (zip: Data, version: String, sha256: String)? {
        lastError = nil
        let made = call(["type": "package.request", "id": id])
        guard made["ok"] as? Bool != false, let req = request(of: made) else {
            lastError = made["message"] as? String ?? Self.notMade["message"] as? String
            return nil
        }
        let response = await send(req)
        let got = outcome("package", response)
        guard got["ok"] as? Bool == true else { lastError = got["message"] as? String; return nil }
        let checked = call(["type": "package.check", "id": id, "body": response.body.base64EncodedString()])
        guard checked["ok"] as? Bool == true, let version = checked["version"] as? String, let sha = checked["sha256"] as? String else {
            lastError = checked["message"] as? String
            return nil
        }
        Diagnostics.note("theme store: a theme downloaded and checked against the list (\(response.body.count) bytes)")
        return (response.body, version, sha)
    }

    // Why the last download didn't come, in the page's words.
    private(set) var lastError: String?

    // A stored theme (ThemeStore.message: its JSON) shared: uploaded as its .margintheme, its author from its theme.json.
    // `{ ok, data: { id, version, status } }` or `{ ok: false, message }`.
    func share(message: String) async -> JSONObject {
        let (result, _) = await signed("upload") { now in ["type": "upload.request", "message": message, "now": now] }
        if result["ok"] as? Bool == true { Diagnostics.note("theme store: a theme shared (\((result["data"] as? JSONObject)?["status"] ?? "?"))") }
        return result
    }

    func report(_ id: String, reason: String) async -> JSONObject {
        let (result, _) = await signed("report") { now in ["type": "report.request", "id": id, "reason": reason, "now": now] }
        if result["ok"] as? Bool == true { Diagnostics.note("theme store: a theme reported") }
        return result
    }
}
