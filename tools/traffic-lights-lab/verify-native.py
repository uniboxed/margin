"""Validate saved button-region/proxy experiments and independent original pixels."""
import json
import pathlib
import re
import subprocess
import sys

directory = pathlib.Path(sys.argv[1]).resolve()
rows = [json.loads(line) for line in pathlib.Path(sys.argv[2]).read_text().splitlines() if line.startswith('{')]
assert rows[-1] == {'childRunning': False, 'cleanup': True, 'exit': 0}
assert not any('refused' in row or 'invalidControl' in row for row in rows)
shots = {row['stage']: row for row in rows if 'stage' in row}
baseline = shots['baseline']
assert all(row['native']['windowed'] for row in shots.values())
for row in shots.values():
    assert row['native']['pid'] == baseline['native']['pid']
    assert row['native']['window'] == baseline['native']['window']
    assert [b['type'] for b in row['native']['buttons']] == [0, 1, 2]
    assert all(b['enabled'] for b in row['native']['buttons'])
    if row['stage'] not in ['owner-buttons-empty', 'owner-buttons-sentinel']:
        assert row['native']['buttonRegion'] == baseline['native']['buttonRegion']
assert not shots['owner-buttons-empty']['native']['buttonRegion']['present']
sentinel = shots['owner-buttons-sentinel']['native']['buttonRegion']
assert sentinel['present'] and list(map(float, re.findall(r'-?\d+(?:\.\d+)?', sentinel['bounds']))) == [0, 0, 4, 4]
for stage in ['foreign-buttons-empty', 'foreign-buttons-sentinel', 'restored-buttons']:
    assert shots[stage]['native']['buttonRegion'] == baseline['native']['buttonRegion']
assert any(row.get('foreignProxy', {}).get('created') for row in rows)
before = next(row['foreignRights'] for row in rows if 'foreignRights' in row)
after = next((row['foreignRightsAfterRetainedProxy'] for row in rows if 'foreignRightsAfterRetainedProxy' in row), None)
if after is not None:
    assert before == after
def pixels(stage):
    return subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(directory / (stage + '.png')),
        '-vf', 'crop=110:35:0:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
original = pixels('baseline')
details = {}
for stage, row in shots.items():
    if stage == 'owner-client-clip' or stage == 'owner-global-control-after-proxy':
        continue
    actual = pixels(stage)
    assert len(actual) == len(original) == 110 * 35 * 3
    changed = sum(max(abs(original[k+j] - actual[k+j]) for j in range(3)) > 8 for k in range(0, len(original), 3))
    if stage == 'native-hidden-control':
        assert changed > 200
        assert all(b['hidden'] and not b['hit'] for b in row['native']['buttons'])
    else:
        assert changed == 0, (stage, changed)
        assert all(not b['hidden'] and b['hit'] and b['alpha'] == 1 for b in row['native']['buttons'])
    details[stage] = {'titlebar_pixels_changed_vs_baseline': changed}
if 'owner-client-clip' in shots:
    assert shots['owner-client-clip']['image']['height'] == baseline['image']['height'] - 50
    for stage in ['owner-client-restored', 'foreign-client-clip-after-proxy', 'foreign-client-restored', 'foreign-global-restored']:
        assert shots[stage]['image'] == baseline['image'], stage
    owner = shots['owner-global-control-after-proxy']['image']
    assert .1 < owner['transparentSamples'] / owner['samples'] < .9
    assert shots['owner-global-control-restored']['image'] == baseline['image']
    assert shots['foreign-global-clip-after-proxy']['image'] == baseline['image']
    details['matched_clip_controls'] = {'owner_local_crops_50_points': True,
        'owner_global_transparent_samples': owner['transparentSamples'],
        'foreign_local_and_global_after_retained_proxy': 'unchanged'}
summary = {'native_region_proxy_pixels_restoration_cleanup': 'pass', 'foreign_rights_before': before,
           'foreign_rights_after_retention': after, 'observations': details,
           'interpretation': 'button-region metadata can change without native visibility; proxy construction does not establish foreign hide/clip authority'}
(directory / 'pixel-checks.json').write_text(json.dumps(summary, indent=2) + '\n')
print('PASS: actual region changes, independent native pixels, proxy/rights, matched clip controls, restoration and cleanup')
