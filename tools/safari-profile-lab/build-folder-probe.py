"""Build a unique, separately sandboxed app; never launch it implicitly."""
import argparse
import hashlib
import json
import pathlib
import plistlib
import shutil
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--build', action='store_true')
args = parser.parse_args()
root = args.output.resolve()
if '/test-results/safari-profiles-' not in str(root):
    raise SystemExit('output must be a new Safari-profile lab fixture')
if not args.build:
    print(json.dumps({'plan': 'Build and ad-hoc-sign a distinct App Sandbox app with user-selected read/write and app-scoped bookmarks only. Create an outside control. No launch or permission request.'}))
    raise SystemExit(0)
root.mkdir(parents=True, exist_ok=False)
run_id = uuid.uuid4().hex
bundle_id = 'com.unibox.margin.profile-folder-probe.r' + run_id
# Keep the app outside Documents to avoid unrelated launch-time Documents access.
bundle = pathlib.Path('/private/tmp') / ('margin-profile-folder-' + run_id) / 'Margin Folder Probe.app'
binary = bundle / 'Contents/MacOS/folder-access'
binary.parent.mkdir(parents=True)
control = root / 'outside-control.txt'
control.write_text('owned control outside the selected Safari directory\n')
entitlements = {'com.apple.security.app-sandbox': True,
                'com.apple.security.files.user-selected.read-write': True,
                'com.apple.security.files.bookmarks.app-scope': True}
(root / 'entitlements.plist').write_bytes(plistlib.dumps(entitlements))
info = {'CFBundleIdentifier': bundle_id, 'CFBundleExecutable': binary.name,
        'CFBundleName': 'Margin Folder Probe', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0',
        'NSHighResolutionCapable': True, 'OutsideControlPath': str(control)}
(bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
source = pathlib.Path(__file__).with_name('folder-access.m')
shutil.copy2(source, root / source.name)
shutil.copy2(__file__, root / pathlib.Path(__file__).name)
with (root / 'build.log').open('wb') as log:
    subprocess.run(['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
                    '-framework', 'AppKit', str(source), '-o', str(binary)],
                   stdout=log, stderr=subprocess.STDOUT, check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', '--entitlements',
                    str(root / 'entitlements.plist'), str(bundle)],
                   stdout=log, stderr=subprocess.STDOUT, check=True)
    subprocess.run(['codesign', '--verify', '--strict', str(bundle)],
                   stdout=log, stderr=subprocess.STDOUT, check=True)
with (root / 'signed-entitlements.plist').open('wb') as log:
    subprocess.run(['codesign', '--display', '--entitlements', '-', '--xml', str(bundle)],
                   stdout=log, stderr=subprocess.DEVNULL, check=True)
signed = plistlib.loads((root / 'signed-entitlements.plist').read_bytes())
assert signed == entitlements
with (root / 'dry-plan.jsonl').open('wb') as log:
    subprocess.run([str(binary)], stdout=log, stderr=subprocess.STDOUT, check=True)
manifest = {'bundle': str(bundle), 'bundleIdentifier': bundle_id,
            'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'sourceSHA256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'outsideControlSHA256': hashlib.sha256(control.read_bytes()).hexdigest(),
            'entitlements': entitlements, 'launched': False}
(root / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
