# One-time Safari folder access: observed success

2026-11-17. This tests the narrower-directory-grant candidate from the initial
research. **One folder selection enabled access to Safari's real data directory,
and a saved security-scoped bookmark restored that access in a new process.**
The user confirmed that only the folder picker appeared; no additional permission
dialog was approved. This is a positive access result, not real profile creation.

Checked host: macOS 26.7.3, build 25G342, arm64; installed Safari 27.2,
21625.2.8.18.4. Neither Safari nor WebBookmarks was launched/loaded by the probe.
Safari's database contents and profiles were not modified or read. The native
probe opened the database in two modes and immediately closed each descriptor.

## Experiment and result

A separate, newly identified, ad-hoc-signed App Sandbox application was launched
through LaunchServices. Both measured process parents were PID 1. Its signature
contains exactly three entitlements:

```text
com.apple.security.app-sandbox = true
com.apple.security.files.user-selected.read-write = true
com.apple.security.files.bookmarks.app-scope = true
```

No temporary filesystem exception, Apple entitlement, Automation or AX entitlement,
FDA request, injected library or TCC reset was used. A new app identifier and
its own sandbox home, signed-entitlement verification and denied baseline avoid
treating the research host's broad existing access as this helper's result.
This remains a test in the existing user session, not an independently verified
fresh-user TCC configuration or a test of the shipping Margin identity.

The only selected folder was:

```text
~/Library/Containers/com.apple.Safari/Data/Library/Safari
```

| Check | Before picker | After picker | New process, before bookmark | After bookmark resolution |
|---|---|---|---|---|
| Open selected directory | EPERM | Success | EPERM | Success |
| Open SafariTabs.db O_RDONLY | EPERM | Success | EPERM | Success |
| Open SafariTabs.db O_RDWR, no writes | EPERM | Success | EPERM | Success |
| Open known owned file outside selection | EPERM | EPERM | EPERM | EPERM |
| Open neighboring Safari Preferences directory | EPERM | EPERM | EPERM | EPERM |

After selection and again after resolution, the app exclusively created a uniquely
named `.margin-profile-folder-probe-<UUID>` sentinel inside the selected folder.
It wrote fixed probe bytes, fsynced, read them back, verified the created inode
before unlinking and removed the file. **Both sentinel cleanups passed.** It did
not execute SQL or create a profile row. The outside owned control's hash stayed
unchanged, and both measured app processes exited.

The app saved bookmark data in its own sandbox Application Support directory.
The second launch displayed no picker and resolved it with security scope,
`withoutUI` and `withoutMounting`; resolution was not stale and
`startAccessingSecurityScopedResource` succeeded. Before resolving, that new
process was again denied the target. The bookmark itself stays local in the
owned test-app container and is not copied into committed evidence.

This follows Apple's documented user-selected URL and persistent bookmark
mechanism. Apple also notes that other access controls can still restrict
individual files, so the measured success must not be generalized to every
folder, file or user environment.
[Apple: Accessing files from the macOS App Sandbox](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox).

## What this establishes for Margin

The original three-permission restriction does **not** by itself require a dead
end for filesystem access. On the checked Mac, a legitimate narrower user grant
provided persistent access to the directory that contains the profile database.
The earlier claim was that this was unverified; it is now verified for this
separate helper and this path.

The potential architecture is: user selects the directory once; the same signed
app saves a security-scoped bookmark; later operations resolve/start that scope
without UI. The profile creation action could then run automatically within that
scope **if complete native provisioning and live-store mutation are validated**.

The next creation test must establish all of the following before claiming success:

- The native collection uses the explicitly authorized real path, rather than
  silently using the helper's sandbox or a debug store.
- All native profile directories/settings resolve to the intended Safari paths.
  Static follow-up in SafariCore shows `safari_profilesDirectoryURL` derives from
  `safari_containerSettingsDirectory`; the create helper's `createIfNeeded:NO`
  branch only checks existence. Runtime destination checks remain necessary.
- A complete disposable profile can be created and removed without losing other
  profiles or interfering with Safari's live collection and synchronization.
- Safari recognizes it after relaunch and actually separates browsing data.
  These are pending Safari acceptance checks under SPEC, not results of this test.

Opening a database O_RDWR is not equivalent to successfully changing its bytes,
and a successful sentinel write does not prove safe profile provisioning. This
test deliberately resolves the access question before attempting any such write.
No production onboarding or profile-creation implementation is added.

## Reproduction and retained attempts

From the repository root:

```sh
python3 tools/safari-profile-lab/build-folder-probe.py \
  --output test-results/safari-profiles-local/folder-1
python3 tools/safari-profile-lab/build-folder-probe.py \
  --output test-results/safari-profiles-local/folder-1 --build
python3 tools/safari-profile-lab/run-folder-probe.py \
  test-results/safari-profiles-local/folder-1
# Review the native plan and entitlements. This opens one user-operated picker:
python3 tools/safari-profile-lab/run-folder-probe.py \
  test-results/safari-profiles-local/folder-1 --run
```

Choose exactly the folder shown in the picker, not a broader parent. No tool
clicks the grant button. The runner stops on first failure and automatically
relaunches only after the first phase succeeds. It refuses replaying an old UI
run or executing a changed binary. Existing raw run `folder-2` is complete and
must not be reused for another picker.

The first build (`folder-1`) compiled and signed but stopped before native dry
execution or any UI: this host's `codesign --display --entitlements -` defaults
to a human-readable representation, not a plist. Inspect the output and local
manual, add `--xml`, retain that failed build, and build a new identity as
`folder-2`. Entitlements then parsed and matched exactly; native dry execution
printed the plan before any UI run.

**Launcher defect:** the first Python runner used `run` as the argparse
destination for both its positional directory and optional execution flag.
The positional Path made the intended runner dry invocation truthy and launched
the already-authorized experiment. The user operated the picker; both phases
completed. Retain that exact original runner with the experiment rather than
rewriting history. Corrected destinations are `run_directory` and `execute`.
The default invocation now prints the plan without launching. A regression check
prohibits any subprocess and verifies that the default creates no output files.
No UI was rerun to verify this fix. The native binary/source did not change.

Raw source, signed app snapshot, original runner, build failure, native dry plan,
both launch logs, signed entitlements and result remain under ignored
`test-results/safari-profiles-2026-11-17/`. Compact sanitized logs, hashes,
user-observation record and verification are in
[results/folder-access-25G342](results/folder-access-25G342/summary.json).
The app and bookmark are retained locally for audit/reproduction, with no
resident process. No bookmark content is included in the evidence manifest.

Validation: native `-Wall -Wextra -Werror` build/signature checks, independent
two-phase verification and corrected dry-run regression pass. Fresh repository
unit tests: **1,031 passed**. Full E2E attempted/bounded at 15 seconds after missing
pinned WebKit 2388 setup errors; no browser download or full-suite pass.
