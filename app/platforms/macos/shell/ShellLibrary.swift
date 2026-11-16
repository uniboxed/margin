// The library in the shell (Library.swift): the app's own spaces, pins, folders and items, opened at launch from
// data/app beside the profiles' sets, with the rules from the app's page folder (Resources/app/library.js, or a
// harness's dist/app), and every profile's set imported into it the first time (Library.importOnce: once, its marker
// kept, the profiles' files never written). Margin's own window draws it (`library.snapshot()`,
// `library.perform(_:_:)`, `library.observe`), and the hosting shows what it asks for (`library.delegate`).

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
