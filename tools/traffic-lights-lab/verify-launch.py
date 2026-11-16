"""Verify saved real-Chromium launch experiment; never launches an app."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
events = json.loads((root / 'launch.json').read_text())
assert not any(e['event'] == 'failure' for e in events)
assert events[-1]['event'] == 'cleanup' and events[-1]['targetGone'] and events[-1]['profileRemoved']
target = next(e for e in events if e['event'] == 'target')
loaded = json.loads((root / 'hook-loaded.json').read_text())
assert loaded['pid'] == target['pid'] and target['bundle'] == 'com.google.chrome.for.testing'
replies = [e for e in events if e['event'] == 'hook-response']
assert [e['action'] for e in replies] == ['hide', 'inspect', 'restore', 'restore']
for reply in replies:
    assert reply['success'] and reply['windowed']
    assert (reply['pid'], reply['window']) == (target['pid'], target['window'])
    assert len(reply['buttons']) == 3
    for button in reply['buttons']:
        assert button['hidden'] == (reply['action'] != 'restore')
        assert bool(button['hit']) == (reply['action'] == 'restore')
        assert button['alpha'] == 1
shots = [e for e in events if e['event'] == 'snapshot']
assert len(shots) == 4 and all(e['fullscreenRead'] == 0 and not e['fullscreen'] for e in shots)
assert all(e['result'] == 0 for e in events if e['event'] in ['resize', 'size-restore', 'close-owned-window'])
phases = [e for e in events if e['event'] == 'phase']
assert len(phases) == 4
counts = []
for index, phase in enumerate(phases):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(phase['videoSeconds'] + .8),
                                  '-i', str(root / 'launch-raw.mp4'), '-vf', 'crop=180:80:0:0',
                                  '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    assert len(raw) == 180 * 80 * 3
    pixels = [raw[k:k+3] for k in range(0, len(raw), 3)]
    red = sum(r > 150 and g < 150 and b < 150 and r > g * 1.4 for r, g, b in pixels)
    yellow = sum(r > 150 and g > 130 and b < 130 for r, g, b in pixels)
    green = sum(g > 100 and r < 140 and b < 160 and g > r * 1.3 for r, g, b in pixels)
    if index in [0, 3]:
        assert min(red, yellow, green) > 30, (index, red, yellow, green)
    else:
        assert max(red, yellow, green) < 5, (index, red, yellow, green)
    counts.append({'phase': phase['label'], 'red': red, 'yellow': yellow, 'green': green})
finished = next(e for e in events if e['event'] == 'recording-finished')
times = json.loads((root / 'launch-raw.frames' / 'timestamps.json').read_text())
assert len(times) == finished['completeFrames'] and len(times) > 30
intervals = [b['uptime'] - a['uptime'] for a, b in zip(times, times[1:])]
assert all(t > 0 for t in intervals)
probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
    'format=duration:stream=codec_name', '-of', 'json', str(root / 'launch-raw.mp4')]))
assert probe['streams'][0]['codec_name'] == 'h264' and 9 < float(probe['format']['duration']) < 14
summary = {'frames': len(times), 'duration': float(probe['format']['duration']), 'colors': counts,
           'sample_intervals_seconds': {'min': min(intervals), 'max': max(intervals), 'mean': sum(intervals)/len(intervals)},
           'native_state_hit_restoration_windowed_cleanup': 'pass'}
(root / 'pixel-checks.json').write_text(json.dumps(summary, indent=2) + '\n')
print('PASS: real Chromium native state, independent video pixels, resize, restore, windowed state and cleanup')
