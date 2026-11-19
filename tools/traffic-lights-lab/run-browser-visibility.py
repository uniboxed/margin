"""Recorded browser trials; measurement cannot feed the AX/private backend."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--browser', choices=['chrome', 'edge', 'safari'], required=True)
p.add_argument('--output', type=pathlib.Path, required=True)
p.add_argument('--run', action='store_true')
a = p.parse_args()
if not a.run:
    print(json.dumps({'plan': 'One absent installed browser, disposable Chrome/Edge profile or Safari private window; AX fullscreen/toolbar menu and private mouse-move hover test, restore toolbar/cursor, quit owned app. Independent display-crop recording over owned backdrop; no capture input to backend.', 'browser': a.browser}))
    raise SystemExit(0)
out = a.output.resolve()
assert '/test-results/button-visibility-recorded-' in str(out)
out.mkdir(parents=True, exist_ok=False)
(out / '.owned-fixture').write_text('owned browser recording trial\n')
source = pathlib.Path(__file__).parent
(out / 'sources').mkdir()
for name in ['browser-visibility-stimulus.m', 'ax-button-visibility.m', 'ax-live-detector.m', 'visibility-recorder.swift', pathlib.Path(__file__).name]:
    shutil.copy2(source / name, out / 'sources' / name)
(out / 'binaries').mkdir()
for name in ['browser-visibility-stimulus', 'ax-live-detector', 'visibility-recorder']:
    shutil.copy2(pathlib.Path('/tmp') / ('margin-' + name), out / 'binaries' / name)
(out / 'manifest.json').write_text(json.dumps({'browser': a.browser, 'sha256': {str(f.relative_to(out)): hashlib.sha256(f.read_bytes()).hexdigest() for d in ['sources', 'binaries'] for f in (out / d).iterdir()}, 'pixelFeedbackToBackend': False}, indent=2) + '\n')
processes = []


def start(name, command):
    child = subprocess.Popen(command, stdout=(out / (name + '.jsonl')).open('w'), stderr=(out / (name + '.stderr')).open('w'), start_new_session=True)
    processes.append((name, child))
    return child


def wait_for(predicate, seconds=10):
    end = time.monotonic() + seconds
    while not predicate():
        failed = [(name, q.returncode) for name, q in processes if q.poll() is not None and q.returncode != 0]
        if failed:
            raise RuntimeError(('child failed', failed))
        if time.monotonic() > end:
            raise TimeoutError('browser checkpoint timeout')
        time.sleep(0.01)


serial = 0


def command(name, hold=0.8):
    global serial
    serial += 1
    tmp = out / 'command.tmp'
    tmp.write_text(json.dumps({'serial': serial, 'command': name}))
    tmp.replace(out / 'browser-command.json')
    wait_for(lambda: (out / 'browser-ack.json').exists() and json.loads((out / 'browser-ack.json').read_text()).get('serial') == serial, 12)
    time.sleep(hold)


failure = None
try:
    driver = start('driver', ['/tmp/margin-browser-visibility-stimulus', '--run', str(out), a.browser])
    wait_for(lambda: (out / 'ready.json').exists(), 20)
    ready = json.loads((out / 'ready.json').read_text())
    assert ready['driverPID'] == driver.pid
    detector = start('detector', ['/tmp/margin-ax-live-detector', '--watch', str(ready['pid']), str(ready['window']), str(out), '30', '40', '0', '0'])
    wait_for(lambda: '"stage":"ready"' in (out / 'detector.jsonl').read_text())
    plan = {'rect': [0, 0, 1100, 820], 'output': str(out / 'measurement.mp4'), 'ready': str(out / 'recording.ready'), 'stop': str(out / 'recording.stop'), 'seconds': 35.0, 'pids': [ready['pid'], driver.pid]}
    (out / 'recording-plan.json').write_text(json.dumps(plan))
    recorder = start('recorder', ['/tmp/margin-visibility-recorder', '--run', str(out / 'recording-plan.json')])
    wait_for(lambda: (out / 'recording.ready').exists())
    command('sample')
    command('hide-attributes')
    command('restore-attributes')
    command('away')
    command('fullscreen-on')
    command('away')
    command('toolbar-toggle')
    command('away', 1.3)
    command('hover', 1.3)
    command('away', 1.3)
    command('toolbar-toggle')
    command('fullscreen-off')
    command('sample')
    (out / 'detector.stop').touch()
    detector.wait(timeout=4)
    (out / 'recording.stop').touch()
    recorder.wait(timeout=8)
    command('quit', 0)
    driver.wait(timeout=8)
except Exception as error:
    failure = str(error)
finally:
    for name in ['detector.stop', 'recording.stop']:
        (out / name).touch()
    # Ask the live driver to restore changed toolbar/cursor and quit its app.
    if processes and processes[0][1].poll() is None:
        try:
            command('quit', 0)
        except Exception:
            pass
    for name, q in reversed(processes):
        try:
            q.wait(timeout=6)
        except subprocess.TimeoutExpired:
            os.killpg(q.pid, signal.SIGTERM)
            q.wait(timeout=3)
result = {'failure': failure, 'processes': {name: {'pid': q.pid, 'exit': q.returncode} for name, q in processes}, 'pixelFeedbackToBackend': False}
result['passed'] = failure is None and all(q.returncode == 0 for _, q in processes)
(out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
raise SystemExit(0 if result['passed'] else 2)
