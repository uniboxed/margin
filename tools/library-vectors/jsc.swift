// The library's vectors as JavaScriptCore answers them (tests/library-vectors/record.ts, npm run library:vectors):
// a script run in a bare JSContext, as app/platforms/macos/shell/LibraryRules.swift runs library.js (no URL, no
// window, nothing of WebKit's), so its answers are Margin.app's today.
//
//   jsc <script.js> <input> <output>
//
// The input file's text is the global `INPUT` (a string); the script's last value, a string, is written to the
// output file. An uncaught exception: its words on stderr, exit 1.
import Foundation
import JavaScriptCore

let args = CommandLine.arguments
guard args.count == 4 else {
    FileHandle.standardError.write("usage: jsc <script.js> <input> <output>\n".data(using: .utf8)!)
    exit(2)
}
guard let script = try? String(contentsOfFile: args[1], encoding: .utf8),
      let input = try? String(contentsOfFile: args[2], encoding: .utf8),
      let context = JSContext() else {
    FileHandle.standardError.write("jsc: can't read \(args[1]) or \(args[2])\n".data(using: .utf8)!)
    exit(2)
}
context.name = "Margin library vectors"
var failed: String?
context.exceptionHandler = { _, e in failed = e?.toString() ?? "an exception" }
context.setObject(input, forKeyedSubscript: "INPUT" as NSString)
let out = context.evaluateScript(script, withSourceURL: URL(string: "margin-app:///\((args[1] as NSString).lastPathComponent)"))
if let failed {
    FileHandle.standardError.write("jsc: \(failed)\n".data(using: .utf8)!)
    exit(1)
}
guard let text = out?.toString() else { exit(1) }
do { try text.write(toFile: args[3], atomically: true, encoding: .utf8) } catch {
    FileHandle.standardError.write("jsc: can't write \(args[3])\n".data(using: .utf8)!)
    exit(1)
}
