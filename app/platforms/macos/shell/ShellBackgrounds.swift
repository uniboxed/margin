// The shell's side of spaces' pictures (M2.9 step 7, docs/SPACE-BACKGROUNDS.md Part B §7; BackgroundStore.swift over
// margin-core's data::backgrounds):
// - opened beside the library at launch, the pictures no space names removed then (not as a space changes, so ⌘Z and
//   Escape in Edit Theme Color can always bring one back while Margin runs);
// - what Margin's window asks (`MarginWindows.background`, its page's `send`): `backgroundChoose`, the file picker,
//   then what was chosen kept; `backgroundAdd { bytes }`, a picture dropped on the picker (its bytes, base64), kept.
//   Each answered `{ ok, result: { id } }`, `{ ok, result: null }` (the picker cancelled) or `{ ok: false, error }`
//   (words for the page). The page saves the space's background with the id (ui/behaviors/background-picker.ts).
// The log says what happened and sizes, never names, paths or content. In a test (`harness`) the picker never shows:
// the store's `pick` answers for it.

import AppKit

extension Shell {
    static func openBackgrounds(dataRoot: URL, library: Library) -> BackgroundStore {
        let store = BackgroundStore(root: BackgroundStore.folder(in: dataRoot))
        let named = Set(library.spaces().compactMap { (($0.value["background"] as? JSONObject)?["image"] as? JSONObject)?["id"] as? String })
        let removed = store.prune(keep: named)
        if removed > 0 { Diagnostics.note("backgrounds: \(removed) picture file(s) no space names removed") }
        return store
    }

    func performBackground(_ type: String, _ payload: JSONObject) async -> JSONObject {
        let answer: JSONObject
        switch type {
        case "backgroundChoose":
            let url: URL? = await withCheckedContinuation { done in backgrounds.choose { done.resume(returning: $0) } }
            // (The picker needed Margin active; the app shown gets the activation back.)
            keysBackToShown("the picture picker closed")
            guard let url else {
                Diagnostics.note("backgrounds: the picker closed with nothing chosen")
                return ["ok": true, "result": NSNull()]
            }
            answer = backgrounds.keep(file: url)
        case "backgroundAdd":
            // (base64 of at most the input cap: checked before it's decoded.)
            guard let text = payload["bytes"] as? String, text.utf8.count <= (backgrounds.maxInputBytes / 3 + 1) * 4,
                  let data = Data(base64Encoded: text) else {
                return ["ok": false, "error": "Margin couldn’t read that picture."]
            }
            answer = backgrounds.keep(data)
        default:
            return ["ok": false, "error": "no such request"]
        }
        if let id = answer["id"] as? String {
            Diagnostics.note("backgrounds: a picture kept (\(type == "backgroundAdd" ? "dropped" : "chosen"))")
            return ["ok": true, "result": ["id": id]]
        }
        Diagnostics.note("backgrounds: a picture refused (\(type == "backgroundAdd" ? "dropped" : "chosen"))")
        return ["ok": false, "error": answer["refused"] as? String ?? "Margin couldn’t keep that picture."]
    }
}
