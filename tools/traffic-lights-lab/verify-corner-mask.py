"""Validate direct-mask storage/readback and independent content pixels; no desktop actions."""
import json
from pathlib import Path
import subprocess
import sys

directory, logfile = map(Path, sys.argv[1:3])
rows = [json.loads(line) for line in logfile.read_text().splitlines() if line.startswith('{')]
assert rows[-1] == {'childRunning': False, 'cleanup': True, 'exit': 0}
assert not any('refused' in r for r in rows)
assert any(r.get('controlKind') == 'nonuniform stored image mask; no content rendering claim' for r in rows)
shots = {r['stage']: r for r in rows if 'stage' in r}
baseline = shots['baseline']
prepared = shots['owner-prepared-image-path']
def mask(stage):
    return shots[stage]['native']['cornerMask']
positive = mask('owner-mask-image')
assert positive['present'] and positive['width'] == positive['height'] == 64
assert positive['bitsPerPixel'] == 8 and positive['isMask']
assert 100 < positive['samplesBelow128'] < 4000
assert mask('foreign-clear-owner-mask') == positive
for stage in ['baseline', 'owner-prepared-image-path', 'owner-mask-cleared', 'foreign-mask-image',
              'foreign-mask-cleared', 'final-mask-restored']:
    assert mask(stage) == {'present': False}, stage
def corners(row):
    pixels = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(directory / (row['stage'] + '.png')),
        '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'])
    w, h = row['image']['width'], row['image']['height']
    assert len(pixels) == w*h*4
    return [b''.join(pixels[(y*w+x)*4:(y*w+x)*4+4] for y in range(y0, y0+40) for x in range(x0, x0+40))
            for x0,y0 in [(0,0), (w-40,0), (0,h-40), (w-40,h-40)]]
original, prepared_pixels = corners(baseline), corners(prepared)
observations = {}
for stage, row in shots.items():
    assert row['native']['pid'] == baseline['native']['pid']
    assert row['native']['window'] == baseline['native']['window']
    assert row['native']['windowed']
    assert row['native']['buttons'] == baseline['native']['buttons']
    assert row['native']['nativeCornerRadius'] == baseline['native']['nativeCornerRadius'] == 16
    assert (row['image']['width'], row['image']['height']) == (baseline['image']['width'], baseline['image']['height'])
    decoded = corners(row)
    reference = original if stage in ['baseline', 'final-mask-restored'] else prepared_pixels
    changed = [sum(max(abs(c[k+j]-b[k+j]) for j in range(4)) > 8 for k in range(0,len(c),4))
               for c,b in zip(decoded,reference)]
    assert changed == [0]*4, (stage, changed)
    counts = [sum(c[i] < 128 for i in range(3,len(c),4)) for c in decoded]
    assert counts == row['image']['transparentCornerPixels']
    observations[stage] = {'transparentPixelsPerCorner': counts, 'changedVsReferencePerCorner': changed}
summary = {'verification': 'pass', 'positiveControl': 'owner stores and clears a nonuniform image mask; not a content rendering control',
           'externalResult': 'cannot clear owner mask or install mask after owner clears it',
           'observations': observations, 'restorationCleanup': 'pass'}
(directory / 'mask-checks.json').write_text(json.dumps(summary,indent=2)+'\n')
print('PASS: owner mask storage/readback, foreign no-effect, decoded content corners, restoration and cleanup')
