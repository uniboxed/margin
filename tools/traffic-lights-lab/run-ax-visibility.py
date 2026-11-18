"""One metadata-only fixture run. Never capture pixels or request permissions."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--fullscreen', action='store_true')
parser.add_argument('--browser', choices=['chrome', 'edge'])
parser.add_argument('--run', action='store_true')
args = parser.parse_args()
if args.browser and args.fullscreen:
    parser.error('browser cases already include one fullscreen round trip')
if not args.run:
    print(json.dumps({'plan': 'One separate-process disposable AppKit fixture, or an absent installed browser with a disposable profile and one fullscreen round trip. AX metadata/native truth only; no capture or permission request. Stop on failure; preserve source, binary and logs.', 'browser': args.browser, 'fullscreen': args.fullscreen or bool(args.browser)}))
    raise SystemExit(0)
root = args.output.resolve()
if '/test-results/button-visibility-' not in str(root):
    raise SystemExit('use a new button-visibility lab output')
root.mkdir(parents=True, exist_ok=False)
ipc = pathlib.Path('/private/tmp') / ('margin-button-visibility-' + uuid.uuid4().hex)
ipc.mkdir()
(ipc / '.owned-fixture').write_text('owned metadata fixture\n')
source = pathlib.Path(__file__).with_name('ax-button-visibility.m')
binary = args.binary.resolve(strict=True)
shutil.copy2(source, root / source.name)
shutil.copy2(binary, root / 'probe')
shutil.copy2(__file__, root / pathlib.Path(__file__).name)
command = [str(binary), '--run', str(ipc)] + (['--fullscreen'] if args.fullscreen else [])
if args.browser:
    command = [str(binary), '--browser', args.browser, str(ipc)]
manifest = {'command': command, 'sourceSHA256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'screenCaptureUsed': False}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
with (root / 'observations.jsonl').open('wb') as stdout, (root / 'probe.stderr').open('wb') as stderr:
    p = subprocess.Popen(command, stdout=stdout, stderr=stderr, start_new_session=True)
    try:
        code = p.wait(timeout=60)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=5)
        code = 124
shutil.copytree(ipc, root / 'native', ignore=shutil.ignore_patterns('profile'))
events = [json.loads(line) for line in (root / 'observations.jsonl').read_text().splitlines()]
completion = next((row for row in reversed(events) if row.get('complete')), {})
result = {'exit': code, 'completion': completion, 'screenCaptureUsed': False}
(root / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
raise SystemExit(0 if code == 0 and completion.get('status') == 0 else 2)
