"""Decode saved corner pixels; does not manipulate the desktop."""
import json
from pathlib import Path
import subprocess
import sys

directory, logfile = map(Path, sys.argv[1:3])
rows = [json.loads(line) for line in logfile.read_text().splitlines() if line.startswith('{')]
assert rows[-1] == {'childRunning': False, 'cleanup': True, 'exit': 0}
shots = [r for r in rows if 'stage' in r]
baseline = shots[0]
assert baseline['stage'] == 'baseline'
decoded = {}
for r in shots:
    assert r['native']['windowed']
    assert r['native']['pid'] == baseline['native']['pid']
    assert r['native']['window'] == baseline['native']['window']
    assert r['native']['buttons'] == baseline['native']['buttons']
    assert r['image']['width'] == baseline['image']['width']
    assert r['image']['height'] == baseline['image']['height']
    pixels = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(directory / (r['stage'] + '.png')),
        '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'])
    w, h = r['image']['width'], r['image']['height']
    assert len(pixels) == w * h * 4
    corners = [b''.join(pixels[(y*w+x)*4:(y*w+x)*4+4] for y in range(y0, y0+40) for x in range(x0, x0+40))
               for x0, y0 in [(0, 0), (w-40, 0), (0, h-40), (w-40, h-40)]]
    decoded[r['stage']] = corners
original = decoded['baseline']
summary = {}
for stage, corners in decoded.items():
    transparent = [sum(c[i] < 128 for i in range(3, len(c), 4)) for c in corners]
    changed = [sum(max(abs(c[k+j]-b[k+j]) for j in range(4)) > 8 for k in range(0, len(c), 4))
               for c, b in zip(corners, original)]
    if stage.startswith('foreign-') or 'restore' in stage or 'native-zero' in stage:
        assert changed == [0]*4, (stage, changed)
    if 'native-small' in stage:
        assert transparent == [0]*4
    if stage.startswith('owner-corner-large'):
        assert all(t > 150 for t in transparent)
    summary[stage] = {'transparent_pixels_per_40px_corner': transparent,
                      'changed_pixels_per_corner_vs_baseline': changed}
assert all(sum(c[i] < 128 for i in range(3, len(c), 4)) > 0 for c in original)
result = {'verification': 'pass', 'observations': summary,
          'scope': 'owned fixture only; native 0.01 removes corner transparency but titlebar paint artifacts remain; foreign transaction requests have no observed corner effect'}
(directory / 'corner-checks.json').write_text(json.dumps(result, indent=2) + '\n')
print('PASS: decoded corner pixels, native positive controls, foreign no-effect, windowed state, restoration and cleanup')
