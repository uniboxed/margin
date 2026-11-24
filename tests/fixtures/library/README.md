# The library's vectors

The library's edit rules (app/shared/library/library.ts over extension/state/model.ts) as Margin.app ran them until
step 4's switch, in JavaScriptCore, a bare `JSContext` (the deleted LibraryRules.swift), but for addresses: the `url` steps
are the browsers' answers (library.ts in Node with its `URL`, as the browsers' copies parse addresses; Tirth's answer 11,
2026-11-23), where JavaScriptCore, which has no `URL`, answers otherwise. library.ts is the reference; margin-core's port
(docs/CORE-REFACTOR.md step 4) must answer every step the same. Recorded by
`npm run library:vectors` (tests/library-vectors/record.ts), re-recorded only with a rule changed on purpose, in the
same commit as both copies' change.

## Files

- `cases/*.json`: the steps, one file per group.
  - `recorded-<test>.json`: every call tests/<test>.test.ts makes to library.ts (`perform`, `snapshot`,
    `importValues`, `stateOf`, `targetOf`), grouped into cases by test.
  - `generated-NN.json`: 300 seeded random sequences of 30 steps over random libraries (tests/library-vectors/
    generate.ts), 25 a file.
  - `edges.json`: written by hand (tests/library-vectors/edges.ts): ties (the ids' order, localeCompare's
    tie-breaks), cuts, JS's spaces, addresses as the browsers parse them, numbers, payload keys.
  - `survey.json`: the throw survey: every action with each payload field as each wrong JSON type, the steps that
    threw.
- `throws.json`: every place an action throws (a TypeError on a payload value of the wrong type, caught by `perform`
  as `failed: <the engine's words>`), with JavaScriptCore's words (`jsc`, the app's and the core's), Node's (`node`),
  where it is and a payload that does it.
- `js.json`: the JavaScript the rules rely on (part 1: spaces, UTF-16 cuts and order, `localeCompare`, numbers' strings,
  `Math.round`/`max`/`min`, values as strings and keys, `fingerprint`, the import's ids, the address regexes,
  `toLowerCase`, link-rule patterns), as JSC answers it on this Mac (`locale` is the collation's locale JSC resolved),
  checked against Node (`nodeDiffers`: none today); under `url`, the addresses normalised and matched as Node with its
  `URL` does (the browsers', `urlEngine`), under `jscUrl` as JSC did (no `URL`: each address as given, no match).
  Strings a cut can break are given as UTF-16 units; numbers JSON can't hold as `"-0"`, `"NaN"`, `"Infinity"`,
  `"-Infinity"`.

## A case file

```json
{ "about": "…", "from": "recorded | generated | survey | edges",
  "cases": [
    { "about": "library.test.ts: library: spaces are created, …",
      "values": { "spaces": { "a": { "name": "A", … } }, "tabs": { … } },
      "steps": [
        { "perform": "createSpace", "payload": { "windowId": 7, "name": "  Work " }, "env": { "now": 1001, "ids": ["id1x", "id2x", "zq000001x"] },
          "expect": { "ok": true, "result": { "spaceId": "sp-id1x" }, "changes": [ … ], "requests": [] } },
        { "perform": "createSpace", "payload": { "name": 5 }, "env": { … },
          "expect": { "ok": false, "result": null, "error": { "failed": "createSpace: name?.trim is not a function" }, "changes": [], "requests": [] } },
        { "snapshot": true, "expect": { "library": { "v": 1, "imported": false }, "spaces": [ … ], … } },
        { "import": { "sets": [ … ], "order": [ … ], "now": 5 }, "expect": { "changes": [ … ], "counts": { … } } },
        { "normal": true, "expect": { "spaces": { … }, … } },
        { "target": { "kind": "app", "bundleId": "com.apple.Notes" }, "expect": { "kind": "app", "bundleId": "com.apple.Notes", "name": "com.apple.Notes" } } ] } ] }
```

- `values`: the library's live values (collection → id → value) before the first step, **each collection's ids in
  code-point order**: the order margin-core's store reads them in (`DataSet`'s `BTreeMap`), and the order library.ts was
  given them when recorded (the "first of several equal" picks, step 4 part 4, Tirth's answer 10). One exception JS
  can't follow: an object's integer-like keys (`windows`' `"7"`, `"12"`) iterate first in ascending number order; no
  rule's outcome depends on the windows' order.
- Steps run in order. After a `perform` or an `import`, its **expected** `changes` are merged into the values before the
  next step (`{ collection, id, value }` sets it, `{ collection, id, deleted: true }` removes it; a new id goes in
  code-point order), as tests/library.test.ts's `library()` merges them. The times are the store's, never the rules'.
- A step is exactly one of:
  - `perform` (an action's name), `payload` (any JSON), `env` (`now`, `ids`: the ids given, always enough, so never
    library.ts's `Math.random` fallback; ids library.ts would refuse, `x1`, are kept, and a step that then drew
    `Math.random` isn't a vector). `expect`: `ok`, `result` (null when there's none and on a failure), `error` (only
    when not `ok`: a refusal's words, or `{ "failed": "<site>" }` for a throw), `changes`, `requests`;
  - `snapshot`: `snapshot(values)`, what the UI draws;
  - `import`: `importValues(values, sets, order, { now })`, `expect` `{ changes, counts }`;
  - `normal`: `valuesOf(stateOf(values), values.imports)`, the values read and written again (part 2's round trip);
  - `target`: `targetOf(raw)` (null: not a target); reads no values.
- Flags on a step:
  - `"url": true`: **the browsers' answer**: the step answers otherwise where addresses aren't parsed. Its `expect` is
    library.ts's in Node with `URL` (WHATWG, as Safari, Chrome and Edge parse addresses: Tirth's answer 11, the core's
    `js::RULES_PARSE_URLS`), and the steps after it start from its changes. JavaScriptCore, a bare JSContext with no
    `URL` (`normalizeUrl` gives the address back, no link rule matches), answers it as Node does with `URL` taken away,
    which the recorder checks. Every other step is JavaScriptCore's answer.
  - `"cut": true`: library.ts's answer held half an emoji (`slice(0, max)` through a surrogate pair); the vector has the
    broken half dropped (Tirth's answer 3). Today's Mac refuses the whole answer (`JSONSerialization` can't read half a
    pair: the action fails with `perform: no answer`, a snapshot comes back empty).
  - `"engine": "jsc"`: Node's answer differs; this is JavaScriptCore's (none today).

## Comparing

JSON values: objects with no regard to key order, numbers as numbers (doubles, as JS reads them), arrays in order. A
step's `error` `{ "failed": site }` is `failed: ` and throws.json's `jsc` words for JavaScriptCore and the core, its
`node` words for Node. A `cut` step: the engine's answer with broken halves dropped (library.ts's) is compared.

## Who runs them

- tests/library-vectors.test.ts (`npm test`): library.ts in Node, without `URL`, but the `url` steps with it (and each
  of them answered otherwise without).
- app/shared/core/src/library/vectors.rs (`cargo test`): margin-core. A part's test implements `vectors::Engine` for
  the kinds it has (the others answer `None`: skipped and counted) and calls `vectors::run(&mut engine)`, which loads
  every file (`vectors::groups()`, or `groups_named("generated-")`), resolves each site's words, merges the expected
  changes between steps and returns a `Report` (checked and skipped by kind, failures with the file, case and step):
  `report.assert_ok()`. `vectors::data_set(&values)` gives the values as a `DataSet`; `vectors::js()` is js.json.
  `vectors::run_entry(&sorter)` runs every kind through library.js's entry as the core answers it
  (`library::object::call`). The core's tests sort with `vectors::AsciiCollation` (ICU's root on ASCII, from js.json's
  recorded order), a stand-in for the system's sorter.
- app/platforms/macos/ffi (`cargo test -p margin-ffi`, the `vectors` feature): every kind through the same entry with the
  Mac's sorter (libicucore, collation.rs), and js.json's `localeCompare` cases: the Mac's vectors pin the system one.
- Until step 4's switch (commit 6), app/platforms/macos/shell/tests/library-vectors-tests.swift also ran the perform,
  snapshot and import steps through LibraryRules (JavaScriptCore), and its shadow gave every call the whole Swift
  suite made to the rules to margin-core as well. Both went with JavaScriptCore: the app runs the core, whose run with
  the Mac's sorter is margin-ffi's above.
