//! Pins and folders in order (piece 1, with [`super::spaces`]): M:612 `pinForUrl`, M:1161-1197 (`folderIn`,
//! `folderOfPin`, `folderParent`, `folderSubtreeHeight`, `folderHasAncestor`; `posOf` is [`super::pos_of`]), M:1200
//! `pinOrder` (folders first at equal places: the stable sort), M:1218 `writeOrder` (only what moved rewritten), M:1242
//! `placed`, M:1251 `folderName`, M:1253 `uniqueName`, M:1263 `addPin`, M:1270 `removePin`, M:1277 `bindTabToPin` and
//! M:1290 `unbindPinTab` (kept halves), M:1314-1344 `cleanCustomTitle`, `renamePin`, `renameTab` (kept half), M:1346
//! `movePin`, M:1362 `createFolder`, M:1376-1407 `renameFolder`, `setFolderOpen`, `moveFolder` (the cycle guard,
//! [`super::MAX_FOLDER_DEPTH`]), M:1410 `deleteFolder`; PR `folderDepth`.
