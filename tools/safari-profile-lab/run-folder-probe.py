"""Launch the reviewed sandbox app once; resume its bookmark only after success."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('run_directory', type=pathlib.Path)
parser.add_argument('--run', dest='execute', action='store_true')
args = parser.parse_args()
root = args.run_directory.resolve(strict=True)
build = json.loads((root / 'build.json').read_text())
bundle = pathlib.Path(build['bundle'])
binary = bundle / 'Contents/MacOS/folder-access'
if not args.execute:
    print(json.dumps({'plan': 'Launch the separately sandboxed app through LaunchServices. User selects only Safari data directory. On success, relaunch same app once, resolving stored bookmark without UI. Stop on first failure. No Safari launch or profile/database mutation.'}))
    raise SystemExit(0)
if '/test-results/safari-profiles-' not in str(root):
    raise SystemExit('refuse output outside a Safari-profile lab fixture')
if hashlib.sha256(binary.read_bytes()).hexdigest() != build['binarySHA256']:
    raise SystemExit('refuse changed binary')
if (root / 'launch-start.json').exists():
    raise SystemExit('refuse replay of a previous UI run')
(root / 'launch-start.json').write_text(json.dumps({'bundle': str(bundle), 'launched': True}) + '\n')
shutil.copy2(__file__, root / pathlib.Path(__file__).name)
shutil.copytree(bundle, root / 'app-snapshot')
results = []
for mode, timeout in [('grant', 620), ('resume', 25)]:
    stdout, stderr = root / (mode + '.jsonl'), root / (mode + '.stderr')
    command = ['/usr/bin/open', '-n', '-W', '--stdout', str(stdout), '--stderr', str(stderr), str(bundle), '--args', '--' + mode]
    print(json.dumps({'launching': mode, 'log': str(stdout)}), flush=True)
    try:
        opened = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        launch_code = opened.returncode
        (root / (mode + '-launch.txt')).write_text(opened.stdout + opened.stderr)
    except subprocess.TimeoutExpired:
        # Only terminate a PID that our own log identifies and ps confirms as
        # the exact reviewed executable. Never kill Safari or a process by name.
        rows = [json.loads(line) for line in stdout.read_text().splitlines()] if stdout.exists() else []
        identity = next((row for row in rows if row.get('stage') == 'identity'), None)
        if identity:
            pid = identity['pid']
            current = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'comm='], capture_output=True, text=True)
            if current.returncode == 0 and current.stdout.strip() == str(binary):
                os.kill(pid, signal.SIGTERM)
        launch_code = 124
    rows = [json.loads(line) for line in stdout.read_text().splitlines()] if stdout.exists() else []
    complete = next((row for row in reversed(rows) if row.get('complete')), {})
    results.append({'mode': mode, 'launchExit': launch_code, 'completion': complete})
    (root / 'run-result.json').write_text(json.dumps(results, indent=2) + '\n')
    if launch_code != 0 or complete.get('status') != 0:
        break
unchanged = hashlib.sha256((root / 'outside-control.txt').read_bytes()).hexdigest() == build['outsideControlSHA256']
summary = {'phases': results, 'outsideControlUnchanged': unchanged, 'realSafariProfileCreated': False}
(root / 'result.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary), flush=True)
raise SystemExit(0 if len(results) == 2 and all(row['completion'].get('status') == 0 for row in results) and unchanged else 2)
