# Fully automatic Safari profile creation without the three permissions

**Follow-up, 2026-11-17:** the narrower folder grant is now tested successfully
for real Safari storage access, including bookmark resolution in a new process
without a second picker. This changes the access finding, not the still-pending
end-to-end creation finding. See [folder-access.md](folder-access.md).

## Finding

No permission-free, fully automatic creation of a usable Safari profile has been
demonstrated. This pass identified and exercised Apple's actual native profile
metadata API. The remaining obstacle is authority over Safari's real state and
complete provisioning, rather than the ability to allocate a profile object.
This is a bounded result on one installed build, not a universal impossibility
claim or proof that Full Disk Access is the only conceivable form of file access.

A real profile separates browser history, cookies, website data, extensions,
Tab Groups and favorites. Apple documents creation in Safari's Profiles settings;
it also documents iCloud profile synchronization. A database row in a companion
app's directory alone cannot satisfy this contract.
[Apple: Use profiles in Safari](https://support.apple.com/en-ie/105100).

## Native implementation traced

Read installed arm64e code with Xcode `dyld_info`; read the live Objective-C
runtime only inside an isolated helper. No Hopper/IDA license was needed for
these named native methods. Checked macOS 26.7.3/25G342, Safari
27.2/21625.2.8.18.4. The addresses below are unslid and build-specific.

1. `CreateProfilePreferencesViewController.createButtonClicked:` in Safari
   first handles the favorites folder, obtains `AppController`'s tab-group
   manager, constructs `WBProfile` with title/symbol/favorites-folder server ID,
   and calls `WBTabGroupManager.appendProfile:completionHandler:`.
2. `appendProfile:completionHandler:` at **0x27C5823DC**, WebBookmarks,
   copies the profile, assigns ordering and caches it, asks the profile-data
   manager to ensure directories exist, and inserts into the collection.
   Its completion wrapper returns a **profile object or nil**, not a BOOL.
3. `WBSProfileDataManager.ensureProfileDirectoriesExistForProfileWithServerID:profileIdentifier:`
   at **0x1AD7D17BC**, SafariShared, calls the file manager's profile-directory
   helper with creation enabled. The UI and its completion blocks perform
   additional settings work; complete provisioning has not been reproduced.
4. `WBTabCollection.initWithConfiguration:openDatabase:checkIntegrity:` at
   **0x27C54F880** opens a database-backed collection. Its configuration accepts
   an explicit path. The debug configuration selects store owner **1**;
   changing owner changes the collection implementation, not caller authority.
   `WebBookmarkDebugSafariTabCollection.safariDirectoryPath` still resolves
   Safari's production container settings directory when no path is supplied.

Loading WebBookmarks in Margin executes these methods **inside Margin's process**.
It does not execute as Safari or inherit Safari's data access. Existing Margin
code in `app/engines/webkit/safari/SafariProfiles.swift` uses FDA to read native
profile names from `SafariTabs.db`. This experiment did not exercise that reader.

### Observed in a confined fixture

The final fixture run (`fixture-3`) successfully:

- opened a new explicitly named debug database in an owned scratch directory;
- observed the native default profile and appended a uniquely named `WBProfile`;
- received a non-nil profile callback and read it back through the native manager;
- independently verified SQLite integrity, both active profile rows, exact new
  title/local identifier/server identifier and `SymbolImageName=flask`.

The new row has `type=1`, `subtype=2`, `parent=0`, `deleted=0`. Local and server
identifiers differ. The default row's stored empty title is displayed as
localized "Personal" by the native API; an initial independent comparison of
all display titles incorrectly rejected that normalization. The final verifier
compares identifiers and the explicitly created title instead.

The helper deliberately passes **nil** for `profileDataManager`; it creates no
Safari profile directories and no usable Safari session. The real container
database read preflight returns EPERM under the imposed policy; the legacy path
returns ENOENT. No real database is read. Both canary opens fail as required and
the canary hash stays unchanged. Source contains no AX or Apple Event calls.

The launching app already has permissions from earlier work. Seatbelt explicitly
denies relevant capabilities so those grants cannot make this experiment a
misleading success. This is **not a fresh-user TCC test** and does not independently
measure Safari's stock TCC behavior. Denying brokers for isolation also means
this fixture cannot rule out an undiscovered authorized broker.

### Failed attempts retained

`inspect-1` stopped before loading the framework because the first guard treated
a missing legacy path as a failed confinement test. Corrected to distinguish
ENOENT from EPERM; `inspect-2` completed metadata inspection.

`fixture-1` stopped before append because the harness assumed any NSError object
meant failure. Static inspection showed `WBTabCollection.error` unconditionally
wraps the last SQLite result; domain `com.apple.WebBookmarks.SQLiteError`, code
**0** means SQLITE_OK. Scratch integrity was already good. With that check
corrected, `fixture-2` completed. `fixture-3` repeated successfully after tightening
the policy to deny preferences and distributed-notification brokers, using the
final source. These failures are harness findings, not evidence against Safari's
API. No blind retry or live-store mutation was used.

## Routes evaluated

| Route | Evidence | Result for fully automatic creation |
|---|---|---|
| Direct WebBookmarks API | Exact native calls, runtime ABIs, successful isolated persistence | Callable; no demonstrated authority/provisioning of real Safari state |
| Internal cycler XPC | `WBSCyclerTestTarget` explicitly declares optional `createProfileWithTitle:symbolName:inListWithIdentifier:reply:`; native caller found | Real creation interface, but its target listener checks a private Apple entitlement |
| Sync-agent XPC | All seven declared instance methods of `WBTabGroupSyncAgentProtocol` inspected | Sharing, observers, presence, scheduling; no declared profile-create method |
| WebBookmarks settings gateway | All directly declared instance/class methods inventoried | Imports, exports, deletion, usage, maintenance; no declared create-profile method |
| Browser import XPC | Listener at **0x1B868920C** checks an entitlement before exporting/resuming | Not an unrestricted creation entry; import itself is not proof of profile creation |
| Safari sandbox broker | Binary delegate checks `com.apple.private.safari.can-use-sandbox-broker`, supplies a restricted object otherwise | Full broker requires entitlement; restricted method inventory has no profile creation |
| App Intents/Shortcuts | SafariSwift profile entity and "Set Profile or Tab Group" focus filter strings | Existing-profile selection found; no demonstrated creation intent. String search is not exhaustive metadata analysis |
| SafariServices / extension native messaging | SDK headers; Apple's documented profile identifier key | Profile identity/context, not a discovered create-profile operation |
| URL, document, AppleScript and launch surfaces | Safari Info.plist schemes/document types, installed Safari.sdef, selected URL/argument handlers | No creation contract found. Apple Events would additionally violate the stated constraint |
| Internal test launch arguments | `DebugUtilities._parseArgumentsForTestingIfNeeded:atIndex:` begins with an internal-install check | No demonstrated shipping CLI for profile creation |

The cycler target gate at **0x1AD6E7A20** queries
`valueForEntitlement:` before installing the exported interface/object. The
argument is exactly **`com.apple.private.Safari.can-use-cycler`**, independently
read from the pinned loaded CFString at **0x1F1BFFD50** after validating its image,
section bounds and CF type. No real XPC connection is attempted and no cycler
operation is run. Adding a self-asserted private entitlement is not a solution.

The Safari sandbox broker is not simply rejected for every unentitled caller:
the delegate installs `RestrictedSandboxBroker`. Its declared operations concern
downloads, search and related browser support, not creating browsing profiles.
No attempt was made to abuse unrelated operations for arbitrary writes.

Apple's native-messaging documentation describes `SFExtensionProfileKey` as the
identifier of the message's profile. It does not document creation authority.
Apple also describes separate extension activation for existing profiles.
[Native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension),
[WWDC23: Safari extensions](https://developer.apple.com/videos/play/wwdc2023/10119/).

### Limits of the reverse engineering

`dyld_info -objc` cannot print live metadata from cache-only dylibs; those warning
files were not treated as inventories. Some WebBookmarks external call stubs are
mislabelled repeatedly as `WBProfileWindow.initWithWindowState:tabGroupManager:`.
Semantic conclusions use actual selector stubs, local instruction bodies and
independently inspected runtime types, not those misleading labels. Broad string
and selector inventories are candidate discovery, not a complete call graph.
The method inventories do not prove absence of dynamic/forwarded/custom messages.

## Architecture decision and next experiments

Do not ship direct database insertion or expose an automatic-create button as
working. An app can automatically create its **own** profile metadata, but
Safari must either accept a legitimate request or the caller must have suitable
access to Safari's state. This pass found no ordinary-client request that does
that under all three restrictions.

Three distinct directions remain:

1. **Keep the exact requirement:** investigate compiled Safari App Intents
   metadata/implementation and any genuine creation broker further. A candidate
   must expose a real operation, accept an ordinary client, and pass an end-to-end
   fresh-user test. No such candidate is established yet.
2. **Allow one-time narrower file access (tested 2026-11-17):** a selected
   Safari data directory and saved security-scoped bookmark provide access in
   the follow-up's sandboxed helper, without FDA/Automation/AX requests. Complete
   native profile provisioning and safe live synchronization remain untested.
   It requires a user grant and must not be presented as zero-setup automation;
   the measured result is not a general bypass of data-vault/TCC restrictions.
3. **Relax the workflow:** let Safari create the profile once in its own UI,
   then discover it through the existing extension messaging path. This avoids
   the three permissions for the creation step, but fails the fully automatic
   requirement. A separate WKWebView/other browser's profiles would change the
   product requirement and are not Safari profiles.

End-to-end acceptance remains pending: Safari must list the new profile after
relaunch, persist the chosen settings, isolate cookies/history/site storage,
handle extensions correctly and preserve existing profiles, including with
iCloud enabled. Per SPEC's Safari execution rule, this pass does not launch
Safari or claim any of those checks passed. No implementation is proposed for
live installation until a legitimate invocation and authority path is concrete.

## Validation and artifacts

Native helper compiles with `-Wall -Wextra -Werror`. Final fixture and independent
SQLite checks pass; final read-only surface inspection passes. Repository unit
tests: **1031 passed**. Full `npm run test:e2e` attempted with a 15-second bound;
missing pinned WebKit 2388 causes browser setup failures; no full-suite pass. No browser
download, app installation, injection, private-entitlement signing, permission
grant/reset or live Safari database modification.

See [compact summary](results/macos-25G342/summary.json),
[runtime surface](results/macos-25G342/runtime-surface.jsonl), and
[static trace index](results/macos-25G342/trace-index.json).
Full raw output, all attempts, per-run source/binaries/policies and hashes stay
under ignored `test-results/safari-profiles-2026-11-16/`; system-code discovery
dumps stay in `/tmp/margin-safari-profile-research/` and are indexed by hash.
