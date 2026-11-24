// The library in the shell (Library.swift): the app's own spaces, pins, folders and items, opened at launch from
// data/app beside the profiles' sets (margin-core's library object: its rules and its store), and every profile's set
// imported into it the first time (Library.importOnce: once, its marker kept, the profiles' files never written).
// Margin's own window draws it (the session's `stateText` over the library's snapshot, `library.perform(_:_:)`,
// `library.observe`), and the hosting shows what it asks for (the session made over it is its requests' sink).

import Foundation

extension Shell {
    static func openLibrary(dataRoot: URL, data: DataSync, harness: Bool) -> Library {
        let library = Library.open(dataRoot: dataRoot, background: !harness)
        library.importOnce(from: data)
        Diagnostics.note("hosted: the library has \(library.spaces().count) space(s), \(library.items().count) item(s) (\(Library.folder(in: dataRoot).path))")
        return library
    }
}
