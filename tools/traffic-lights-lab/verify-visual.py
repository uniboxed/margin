"""Check accepted visual recordings against native/AX logs and independently decoded pixels."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
summary = {}


def crop(path, seconds, width=180, height=80):
    return subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', str(seconds), '-i', str(path), '-vf', f'crop={width}:{height}:0:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])


for name in ['native', 'chrome', 'edge', 'textedit']:
    directory = root if name == 'native' else root / 'sampled'
    events = json.loads((directory / f'{name}.json').read_text())
    assert not any(event['event'] == 'failure' for event in events), name
    phases = [event for event in events if event['event'] == 'phase']
    assert len(phases) == 4
    shots = [event for event in events if event['event'] == 'snapshot']
    assert len(shots) == 4
    assert events[-1]['event'] == 'cleanup' and events[-1]['targetGone'] and events[-1]['profileRemoved']
    finished = next(event for event in events if event['event'] == 'recording-finished')
    assert finished['completeFrames'] >= 30  # PNG acquisition count for sampled backends; SCK complete count for native.
    source = directory / f'{name}-raw.mp4'
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', str(source)]))
    assert probe['streams'][0]['codec_name'] == 'h264' and 9 < float(probe['format']['duration']) < 14
    details = {'duration': float(probe['format']['duration']), 'frames': finished['completeFrames']}
    if name == 'native':
        assert all(shot['windowed'] for shot in shots)
        assert all(not button['hidden'] and button['hit'] for shot in [shots[0], shots[3]] for button in shot['buttons'])
        assert all(button['hidden'] and not button['hit'] for shot in [shots[1], shots[2]] for button in shot['buttons'])
        baseline, hidden, restored = [crop(source, seconds, 160, 64) for seconds in [1, 4, 10]]
        def differences(a, b):
            return sum(max(abs(a[k+j] - b[k+j]) for j in range(3)) > 18 for k in range(0, len(a), 3))
        details['baseline_vs_hidden_changed_pixels'] = differences(baseline, hidden)
        details['baseline_vs_restored_changed_pixels'] = differences(baseline, restored)
        assert details['baseline_vs_hidden_changed_pixels'] > 1000
        assert details['baseline_vs_restored_changed_pixels'] < 100
    else:
        assert all(shot['fullscreenRead'] == 0 and not shot['fullscreen'] for shot in shots)
        writes = [event for event in events if event['event'] == 'ax-hide']
        assert len(writes) == 3 and all(event['result'] == 0 and not event['settable'] for event in writes)
        assert all(event['result'] == 0 for event in events if event['event'] in ['ax-restore', 'size-restore', 'resize', 'close-owned-window'])
        counts = []
        for phase in phases:
            raw = crop(source, phase['videoSeconds'] + 0.8)
            colors = [raw[k:k+3] for k in range(0, len(raw), 3)]
            red = sum(r > 150 and g < 150 and b < 150 and r > g * 1.4 for r, g, b in colors)
            yellow = sum(r > 150 and g > 130 and b < 130 for r, g, b in colors)
            green = sum(g > 100 and r < 140 and b < 160 and g > r * 1.3 for r, g, b in colors)
            assert min(red, yellow, green) > 30, (name, phase, red, yellow, green)
            counts.append({'phase': phase['label'], 'red_pixels': red, 'yellow_pixels': yellow, 'green_pixels': green})
        details['button_color_pixels'] = counts
        times = json.loads((directory / f'{name}-raw.frames' / 'timestamps.json').read_text())
        assert len(times) == finished['completeFrames']
        intervals = [b['uptime'] - a['uptime'] for a, b in zip(times, times[1:])]
        assert all(value > 0 for value in intervals)
        details['sample_intervals_seconds'] = {'min': min(intervals), 'max': max(intervals), 'mean': sum(intervals) / len(intervals)}
    summary[name] = details
(root / 'pixel-checks.json').write_text(json.dumps(summary, indent=2) + '\n')
print('PASS: four accepted videos, windowed state, decoded control pixels, restoration, timestamps and cleanup')
