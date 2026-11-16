"""Independent saved display-pixel and pointer-query checks; never controls desktop apps."""
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
events = json.loads((root / 'cover.json').read_text())
times = json.loads((root / 'timestamps.json').read_text())
assert not any(e['event'] == 'failure' for e in events)
assert events[-1]['event'] == 'cleanup' and events[-1]['patchReleased'] and events[-1]['targetGone']
binding = next(e for e in events if e['event'] == 'binding')
target = binding['window']
def rect(text):
    return list(map(float, re.findall(r'-?\d+(?:\.\d+)?', text)))
canvas = rect(binding['canvas'])
phases = [e for e in events if e['event'] == 'phase']
assert len(phases) == 7
labels = ['baseline', 'covered', 'moved', 'resized', 'reactivated', 'restored']
for label in labels:
    hits = [e for e in events if e['event'] == 'pointer-target' and e['label'] == label]
    assert len(hits) == 3 and all(e['result'] == 0 and e['window'] == e['expected'] for e in hits)
    assert all((e['expected'] == target) == (label in ['baseline', 'restored']) for e in hits)
assert any(e['event'] == 'ax-notification' and e['name'] == 'AXMoved' for e in events)
assert any(e['event'] == 'ax-notification' and e['name'] == 'AXResized' for e in events)
assert any(e['event'] == 'ax-notification' and e['name'] == 'AXApplicationActivated' for e in events)
assert any(e['event'] == 'deactivated-confirmed' for e in events)
assert any(e['event'] == 'deactivated-cover' and e['result'] == 0 and not e['visible'] for e in events)
assert any(e['event'] == 'activation-settle' for e in events)
finished = next(e for e in events if e['event'] == 'finished')
assert len(times) == finished['frames'] and len(times) >= 14
assert all(b['seconds'] > a['seconds'] for a, b in zip(times, times[1:]))
def image_info(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
        'stream=width,height', '-of', 'json', str(path)]))['streams'][0]
info = image_info(root / times[0]['file'])
scale = info['width'] / canvas[2]
assert abs(info['height'] / canvas[3] - scale) < .01
def colors(path, area, frame_index=None):
    x, y, width, height = [round(x) for x in area]
    selection = f'select=eq(n\\,{frame_index}),' if frame_index is not None else ''
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-vf',
        selection + f'crop={width}:{height}:{x}:{y},format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'])
    assert len(raw) == width * height * 3
    pixels = [raw[k:k+3] for k in range(0, len(raw), 3)]
    return [sum(r > 150 and g < 150 and b < 150 and r > g * 1.4 for r, g, b in pixels),
            sum(r > 150 and g > 130 and b < 130 for r, g, b in pixels),
            sum(g > 100 and r < 140 and b < 160 and g > r * 1.3 for r, g, b in pixels)]
checks = []
for index, label in zip([0, 1, 2, 3, 5, 6], labels):
    phase = phases[index]
    end = phases[index + 1]['seconds'] if index + 1 < len(phases) else finished['seconds']
    samples = [t for t in times if phase['seconds'] + .75 <= t['seconds'] < end]
    assert samples, (label, phase['seconds'], end)
    shot = next(e for e in events if e['event'] == 'windowed' and e['label'] == label)
    boxes = [rect(b) for b in shot['buttons']]
    # Check the native button area, independently of the cover's reported rectangle.
    left = min(b[0] for b in boxes) - 1
    top = min(b[1] for b in boxes) - 1
    width = max(b[0] + b[2] for b in boxes) - left + 1
    height = max(b[1] + b[3] for b in boxes) - top + 1
    counts = colors(root / samples[-1]['file'], [(left - canvas[0]) * scale, (top - canvas[1]) * scale, width * scale, height * scale])
    if label in ['baseline', 'restored']:
        assert min(counts) > 30, (label, counts)
    else:
        assert max(counts) < 5, (label, counts)
    check = {'phase': label, 'sample': samples[-1], 'red_yellow_green_pixels': counts}
    if (root / 'cover-raw.mp4').exists():
        # Select the corresponding decoded sample by index. An input-time seek in VFR output
        # can choose the next sample, which may already belong to the following phase.
        compressed = colors(root / 'cover-raw.mp4', [(left-canvas[0])*scale, (top-canvas[1])*scale, width*scale, height*scale], times.index(samples[-1]))
        assert (min(compressed) > 30 if label in ['baseline', 'restored'] else max(compressed) < 5), (label, compressed)
        check['raw_mp4_red_yellow_green_pixels'] = compressed
    checks.append(check)
underneath = colors(root / 'target-under-cover.png', [0, 0, 180, 80])
assert min(underneath) > 30, underneath
checks.append({'target_alone_under_cover_still_has_native_controls': underneath})
summary = {'frames': len(times), 'duration': finished['seconds'] - times[0]['seconds'],
           'mean_interval_seconds': (times[-1]['seconds'] - times[0]['seconds']) / (len(times)-1),
           'decoded_display_pixels': checks, 'pointer_windowed_move_resize_activation_restore_cleanup': 'pass',
           'limits': 'settled sampled screen crops; not continuous drag, flicker-free behavior or actual click delivery'}
(root / 'pixel-checks.json').write_text(json.dumps(summary, indent=2) + '\n')
print('PASS: independent display pixels, intact underlying controls, pointer targets, windowed lifecycle and cleanup')
