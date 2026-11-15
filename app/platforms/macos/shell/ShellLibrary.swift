// The library in the shell (Library.swift): with `MarginHosted` on (Shell.Options.hosted, read in forApp), the app's
// own spaces, pins, folders and items, opened at launch from data/app beside the profiles' sets, with the rules from
// the app's page folder (Resources/app/library.js, or a harness's dist/app), and every profile's set imported into it
// the first time (Library.importOnce: once, its marker kept, the profiles' files never written). Off, nothing here
// runs: no file is read or made, and every profile's copy keeps its own spaces exactly as before.
//
// What the library is for comes in the next phases (docs/MARGIN-APP.md): Margin's own window draws it
// (`library.snapshot()`, `library.perform(_:_:)`, `library.observe`), and the hosting shows what it asks for
// (`library.delegate`). Until then it's kept, imported, and logged.

import Foundation

extension Shell {
    func startLibrary(dataRoot: URL) {
        let script = (options.root ?? OverlayPages.appRoot).appendingPathComponent(Library.scriptName)
        guard let library = Library.open(dataRoot: dataRoot, script: script, background: !options.harness) else {
            Diagnostics.warn("hosted: the library's rules didn't load (\(script.path)): Margin keeps each profile's spaces")
            return
        }
        self.library = library
        library.importOnce(from: data.store)
        Diagnostics.note("hosted: the library has \(library.spaces().count) space(s), \(library.items().count) item(s) (\(Library.folder(in: dataRoot).path))")
    }
}
