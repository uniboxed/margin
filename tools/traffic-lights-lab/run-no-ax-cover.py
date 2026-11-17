"""Build a new no-AX identity; record owned checkpoints from a separate measurer."""
import argparse
import hashlib
import json
import math
import pathlib
import plistlib
import shutil
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--build', action='store_true')
parser.add_argument('--run', action='store_true')
parser.add_argument('--track-events', action='store_true')
parser.add_argument('--transaction-groups', action='store_true')
parser.add_argument('--recorder', type=pathlib.Path, default=pathlib.Path('/tmp/margin-no-ax-screen-recorder'))
args = parser.parse_args()
root = args.output.resolve()
if '/test-results/traffic-lights-no-ax-' not in str(root):
    raise SystemExit('use a new no-AX lab output directory')
if args.build and args.run:
    raise SystemExit('build/review/dry first; run separately')
if args.track_events and args.transaction_groups:
    raise SystemExit('test these strategies separately')
if not args.build and not args.run:
    print(json.dumps({'plan': 'Build a unique app with no entitlements. Launch via LaunchServices; require AXTrusted=false and denied AX windows query. Operate one disposable child plus own surfaces. Parent only captures known owned test canvas; no AX lookup/control by measurer. Preserve failures and source/binary. No browser, user window or permission setting changed.'}))
    raise SystemExit(0)
if args.build:
    root.mkdir(parents=True, exist_ok=False)
    temporary = pathlib.Path('/private/tmp') / ('margin-no-ax-' + uuid.uuid4().hex)
    bundle = temporary / 'No AX Cover.app'
    binary = bundle / 'Contents/MacOS/no-ax-cover'
    binary.parent.mkdir(parents=True)
    ipc = temporary / 'test-results/traffic-lights-no-ax-2026-11-17/run'
    ipc.mkdir(parents=True)
    (ipc / '.owned-fixture').write_text('owned no-AX fixture\n')
    info = {'CFBundleIdentifier': 'com.unibox.margin.no-ax-cover.r' + uuid.uuid4().hex,
            'CFBundleExecutable': binary.name, 'CFBundleName': 'No AX Cover',
            'CFBundleVersion': '1', 'CFBundlePackageType': 'APPL', 'LSUIElement': True,
            'NSHighResolutionCapable': True}
    (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    source = pathlib.Path(__file__).with_name('no-ax-cover.m')
    shutil.copy2(source, root / source.name)
    shutil.copy2(__file__, root / pathlib.Path(__file__).name)
    with (root / 'build.log').open('wb') as log:
        subprocess.run(['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
                        '-framework', 'AppKit', '-framework', 'ApplicationServices',
                        str(source), '-o', str(binary)], stdout=log, stderr=subprocess.STDOUT, check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', str(bundle)], stdout=log, stderr=subprocess.STDOUT, check=True)
        subprocess.run(['codesign', '--verify', '--strict', str(bundle)], stdout=log, stderr=subprocess.STDOUT, check=True)
    with (root / 'dry.jsonl').open('wb') as log:
        subprocess.run([str(binary)], stdout=log, stderr=subprocess.STDOUT, check=True)
    manifest = {'bundle': str(bundle), 'ipc': str(ipc), 'bundleIdentifier': info['CFBundleIdentifier'],
                'sourceSHA256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'trackEvents': args.track_events,
                'transactionGroups': args.transaction_groups}
    if args.track_events or args.transaction_groups:
        recorder = args.recorder.resolve(strict=True)
        preflight = subprocess.run([str(recorder), '--preflight'], capture_output=True, text=True, check=True)
        (root / 'recorder-preflight.json').write_text(preflight.stdout)
        if not json.loads(preflight.stdout)['screenCapturePreflight']:
            raise SystemExit('measurement recorder lacks existing permission; no UI launched')
        shutil.copy2(recorder, root / 'measurement-recorder')
        shutil.copy2(source.with_name('no-ax-screen-recorder.swift'), root / 'no-ax-screen-recorder.swift')
        manifest['recorderSHA256'] = hashlib.sha256(recorder.read_bytes()).hexdigest()
    (root / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
    shutil.copytree(bundle, root / 'app-snapshot')
    print(json.dumps(manifest))
    raise SystemExit(0)
manifest = json.loads((root / 'build.json').read_text())
bundle, ipc = pathlib.Path(manifest['bundle']), pathlib.Path(manifest['ipc'])
binary = bundle / 'Contents/MacOS/no-ax-cover'
if (root / 'launch.json').exists():
    raise SystemExit('refuse replay; retain previous run')
if hashlib.sha256(binary.read_bytes()).hexdigest() != manifest['binarySHA256']:
    raise SystemExit('binary changed')
command = ['/usr/bin/open', '-n', '-W', '--stdout', str(ipc / 'native.jsonl'),
           '--stderr', str(ipc / 'native.stderr'), str(bundle), '--args',
           '--run', str(ipc), '--capture-checkpoints']
if manifest.get('trackEvents'):
    command.append('--track-events')
if manifest.get('transactionGroups'):
    command.append('--transaction-groups')
(root / 'launch.json').write_text(json.dumps({'command': command}) + '\n')
p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
started, last, captures = time.monotonic(), None, []
while p.poll() is None and time.monotonic() - started < 44:
    request = ipc / 'capture-request.json'
    if request.exists():
        row = json.loads(request.read_text())
        if row['phase'] != last:
            last = row['phase']
            rect = row['rect']
            if not all(math.isfinite(rect[key]) for key in ['x', 'y', 'width', 'height']):
                raise SystemExit('invalid measurement crop')
            region = ','.join(str(round(rect[key])) for key in ['x', 'y', 'width', 'height'])
            before = time.monotonic()
            if last in ('tracked-motion', 'grouped-motion'):
                with (root / 'motion-recorder.log').open('wb') as log:
                    shot = subprocess.run([str(root / 'measurement-recorder'), '--run', region,
                                           str(root / 'motion.mp4'), str(ipc / 'capture-done.json'),
                                           last, '5'], stdout=log, stderr=subprocess.STDOUT, timeout=15)
                ok = shot.returncode == 0 and (root / 'motion.mp4').exists()
            else:
                shot = subprocess.run(['/usr/sbin/screencapture', '-x', '-R' + region,
                                       str(root / (last + '.png'))], capture_output=True, timeout=5)
                ok = shot.returncode == 0 and (root / (last + '.png')).exists()
                if ok:
                    pixels = subprocess.check_output(['ffmpeg', '-loglevel', 'error', '-i',
                        str(root / (last + '.png')), '-vf', 'scale=80:50', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
                    teal = sum(g > 110 and b > 110 and r + 45 < g and r + 45 < b
                               for r, g, b in zip(pixels[::3], pixels[1::3], pixels[2::3]))
                    ok = teal > 500
            captures.append({'phase': last, 'requested': before, 'returned': time.monotonic(), 'ok': ok, 'rect': rect})
            if last not in ('tracked-motion', 'grouped-motion'):
                response = ipc / 'capture-done.tmp'
                response.write_text(json.dumps({'phase': last, 'ok': ok}))
                response.replace(ipc / 'capture-done.json')
    time.sleep(0.01)
try:
    stdout, stderr = p.communicate(timeout=3)
except subprocess.TimeoutExpired:
    p.terminate(); stdout, stderr = p.communicate(timeout=3)
(root / 'launch-output.txt').write_bytes(stdout + stderr)
(root / 'captures.json').write_text(json.dumps(captures, indent=2) + '\n')
shutil.copytree(ipc, root / 'native')
rows = [json.loads(line) for line in (root / 'native/native.jsonl').read_text().splitlines()]
completion = next((row for row in reversed(rows) if row.get('complete')), {})
result = {'launchExit': p.returncode, 'completion': completion,
          'measurement': 'Host captures composited display crops only; no AX or target positioning by measurer',
          'measurementComplete': bool(captures) and all(row['ok'] for row in captures),
          'capturePhases': [row['phase'] for row in captures if row['ok']]}
(root / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
raise SystemExit(0 if completion.get('status') == 0 and p.returncode == 0 and result['measurementComplete'] else 2)
