"""Orchestrate isolated targets, pixel-free backend and independent test recorder."""
import argparse
import hashlib
import json
import pathlib
import shutil
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True, type=pathlib.Path)
parser.add_argument('--mode', choices=['visibility', 'custom', 'motion', 'idle', 'events'], default='visibility')
parser.add_argument('--observe', action='store_true')
parser.add_argument('--hz', type=int, default=30)
parser.add_argument('--padding', type=int, default=0)
parser.add_argument('--cover', action='store_true')
parser.add_argument('--overflow-guard', action='store_true')
parser.add_argument('--no-recording', action='store_true')
parser.add_argument('--no-detector', action='store_true')
parser.add_argument('--seconds', type=float, default=6)
parser.add_argument('--run', action='store_true')
args = parser.parse_args()
if not args.run:
    print(json.dumps({'plan': 'One owned separate-process fixture, AX/private-metadata-only detector, optional separate display-crop recorder over an owned backdrop/target. No pixel feedback. Preserve failed attempts, stop first failure.', 'mode': args.mode, 'hz': args.hz, 'cover': args.cover, 'padding': args.padding, 'recording': not args.no_recording}))
    raise SystemExit(0)
out = args.output.resolve()
assert '/test-results/button-visibility-recorded-' in str(out)
out.mkdir(parents=True, exist_ok=False)
(out / '.owned-fixture').write_text('owned recorded validation\n')
tools = pathlib.Path(__file__).parent
(out / 'sources').mkdir()
for name in ['ax-live-detector.m', 'visibility-stimulus.m', 'ax-button-visibility.m', 'visibility-recorder.swift', 'visibility-observer.m', pathlib.Path(__file__).name]:
    shutil.copy2(tools / name, out / 'sources' / name)
bins = {name: pathlib.Path('/tmp') / ('margin-' + name) for name in ['ax-live-detector', 'visibility-stimulus', 'visibility-recorder']}
if args.observe:
    bins['visibility-observer'] = pathlib.Path('/tmp/margin-visibility-observer')
(out / 'binaries').mkdir()
for name, path in bins.items():
    shutil.copy2(path, out / 'binaries' / name)
(out / 'manifest.json').write_text(json.dumps({'arguments': vars(args) | {'output': str(out)}, 'sha256': {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest() for d in ['sources', 'binaries'] for p in (out / d).iterdir()}, 'pixelFeedbackToBackend': False}, indent=2) + '\n')
processes = []


def start(name, command):
    p = subprocess.Popen(command, stdout=(out / (name + '.jsonl')).open('w'), stderr=(out / (name + '.stderr')).open('w'), start_new_session=True)
    processes.append((name, p))
    return p


def wait_for(predicate, seconds=8):
    end = time.monotonic() + seconds
    while not predicate():
        failed = [(name, p.returncode) for name, p in processes if p.poll() is not None and p.returncode != 0]
        if failed:
            raise RuntimeError(('child failed', failed))
        if time.monotonic() > end:
            raise TimeoutError('owned test checkpoint timed out')
        time.sleep(0.01)


failure = None
try:
    fixture = start('stimulus', [str(bins['visibility-stimulus']), '--run', str(out), args.mode])
    wait_for(lambda: (out / 'ready.json').exists())
    ready = json.loads((out / 'ready.json').read_text())
    assert ready['pid'] == fixture.pid
    observer = None
    if args.observe:
        observer = start('observer', [str(bins['visibility-observer']), '--run', str(out)])
        wait_for(lambda: (out / 'observer.ready').exists())
    detector = None
    if not args.no_detector:
        detector = start('detector', [str(bins['ax-live-detector']), '--watch', str(fixture.pid), str(ready['window']), str(out), str(args.hz), '40', str(args.padding), str(int(args.cover))] + (['--overflow-guard'] if args.overflow_guard else []))
        wait_for(lambda: '"stage":"ready"' in (out / 'detector.jsonl').read_text())
    if not args.no_recording:
        plan = {'rect': [0, 0, 1100, 820], 'output': str(out / 'measurement.mp4'), 'ready': str(out / 'recording.ready'), 'stop': str(out / 'recording.stop'), 'seconds': 35.0, 'pids': [fixture.pid] + ([detector.pid] if args.cover else [])}
        (out / 'recording-plan.json').write_text(json.dumps(plan))
        recorder = start('recorder', [str(bins['visibility-recorder']), '--run', str(out / 'recording-plan.json')])
        wait_for(lambda: (out / 'recording.ready').exists(), 10)
        assert json.loads((out / 'recording.ready').read_text())['ok']
    (out / 'stimulus.start').write_text(str(time.monotonic()))
    if args.mode == 'idle':
        time.sleep(args.seconds)
    else:
        wait_for(lambda: (out / 'stimulus.done').exists(), 20)
    (out / 'detector.stop').touch()
    if detector:
        detector.wait(timeout=4)
    (out / 'recording.stop').touch()
    if not args.no_recording:
        recorder.wait(timeout=8)
        assert json.loads((out / 'measurement.mp4.json').read_text())['recordingFinished']
except Exception as error:
    failure = str(error)
finally:
    for name in ['detector.stop', 'recording.stop', 'observer.stop', 'stimulus.stop', 'stimulus.start']:
        (out / name).touch()
    for name, p in reversed(processes):
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # Only process groups created by this runner.
            subprocess.run(['kill', '-TERM', '--', '-' + str(p.pid)], check=False, capture_output=True)
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=3)
result = {'failure': failure, 'processes': {name: {'pid': p.pid, 'exit': p.returncode} for name, p in processes}, 'pixelFeedbackToBackend': False, 'recordingUsedForMeasurementOnly': not args.no_recording}
result['passed'] = failure is None and all(p.returncode == 0 for _, p in processes)
(out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
raise SystemExit(0 if result['passed'] else 2)
