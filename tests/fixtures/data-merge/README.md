# Merge test vectors

Each file is one case of the lasting data set's merge (`DATA.md`, "The merge"): `base` (the app's data set, or `null` for none), `changes` (the extension's queued changes, applied in order) and `expected` (the merged data set). The reference is `extension/shared/data-merge.js` (`mergeData(base, changes)`), run by `tests/data-set.test.js`; Margin.app's Swift store runs the same files.

Compare data sets as JSON values: object key order doesn't matter, numbers are compared as numbers.
