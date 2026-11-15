// The library's edit rules (Library.swift) are the extension's own (extension/state/model.ts, through
// app/shared/library/library.ts), run here in a JavaScriptCore context: one copy of the rules for the extension and
// the app (DECISIONS.md "Margin.app owns the spaces"). The script is dist/app/library.js (scripts/build.ts), in the
// app's Resources/app/ beside the overlay's page; it has no clock, no randomness and nothing of a browser's, so it
// runs the same here as in the unit tests (tests/library.test.ts).
//
// One entry, JSON in and out (`marginLibrary.call(name, argsJSON)`): no objects bridged, so JSON's null, true and
// numbers come back as JSONSerialization gives them everywhere else in the app.

import Foundation
import JavaScriptCore

final class LibraryRules {
    private let context: JSContext
    private let entry: JSValue
    // Why the last call gave nothing (the script threw, or its answer wasn't JSON): for the log and the tests.
    private(set) var lastError: String?

    init?(script: String, name: String = "library.js") {
        guard let context = JSContext() else { return nil }
        context.name = "Margin library"
        self.context = context
        context.evaluateScript(script, withSourceURL: URL(string: "margin-app:///\(name)"))
        if let e = context.exception {
            Diagnostics.warn("library: \(name) didn't load: \(e.toString() ?? "?")")
            return nil
        }
        guard let lib = context.objectForKeyedSubscript("marginLibrary"), lib.isObject,
              let call = lib.objectForKeyedSubscript("call"), call.isObject else {
            Diagnostics.warn("library: \(name) has no marginLibrary.call")
            return nil
        }
        entry = call
    }

    // The app's script (Resources/app/library.js, or dist/app/ for a harness), nil if it can't be read or run.
    static func load(from url: URL) -> LibraryRules? {
        guard let script = try? String(contentsOf: url, encoding: .utf8) else {
            Diagnostics.warn("library: \(url.lastPathComponent) not found in \(url.deletingLastPathComponent().path)")
            return nil
        }
        return LibraryRules(script: script, name: url.lastPathComponent)
    }

    // One of the library's functions with these arguments (any JSON): its value (NSNull for null), or nil when it
    // failed (lastError says why).
    func call(_ name: String, _ args: [Any]) -> Any? {
        lastError = nil
        guard let data = try? JSONSerialization.data(withJSONObject: args, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else {
            lastError = "\(name): arguments aren't JSON"
            return nil
        }
        let out = entry.call(withArguments: [name, text])
        if let e = context.exception {
            context.exception = nil
            lastError = "\(name): \(e.toString() ?? "threw")"
            return nil
        }
        guard let answer = out?.toString(), let o = object(answer) else {
            lastError = "\(name): no answer"
            return nil
        }
        if let error = o["error"] as? String {
            lastError = "\(name): \(error)"
            return nil
        }
        return o["value"] ?? NSNull()
    }

    private func object(_ text: String) -> JSONObject? {
        text.data(using: .utf8).flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? JSONObject }
    }
}
