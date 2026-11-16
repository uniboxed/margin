"""Verify saved filter catalog and window-right delegation evidence, without live APIs."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()


def read(name):
    with (root / name).open() as stream:
        return [json.loads(line) for line in stream]


catalog = read('catalog-run-1.jsonl')
assert catalog[0]['build'] == '25G342'
assert catalog[-1] == {'allAllocatedFiltersReleased': True, 'complete': True}
entries = {row['filter']: row for row in catalog if 'filter' in row}
assert set(entries) == {'CIColorInvert', 'CIShapedWaterRipple', 'CIColorMatrix', 'CIBlendWithAlphaMask', 'CICrop'}
for name, row in entries.items():
    known = name in ['CIColorInvert', 'CIShapedWaterRipple']
    assert row['createResult'] == (0 if known else 1006)
    assert (row['identifier'] != 0) == known
    assert row['releaseResult'] == (0 if known else -1)

failed = read('rights-run-1.jsonl')
assert failed[-1] == {'childRunning': False, 'cleanup': True, 'exit': 2}
assert any(row.get('refused') == 'owner grant control not established' for row in failed)
assert any(row.get('offerCompletion') == {'missing': True} for row in failed)
rows = read('rights-run-2.jsonl')
assert rows[-1] == {'childRunning': False, 'cleanup': True, 'exit': 0}
assert not any('refused' in row for row in rows)


def one(key):
    return next(row[key] for row in rows if key in row)


before = one('foreignRightsBaseline')
assert before == one('foreignRightsAfterSelfGrant') == one('foreignRightsRestored')
assert before == {'rawOutputs': [0, 0, 65536], 'result': 0}
assert one('foreignSelfGrantWriter') == 1001
assert one('ownerGrantWriter') == one('relinquishWriter') == 0
assert one('foreignRightsAfterOwnerGrant') == {'rawOutputs': [131072, 0, 65536], 'result': 0}
shots = {row['stage']: row for row in rows if 'stage' in row}
assert set(shots) == {'baseline', 'writer-granted-no-rendering-change', 'writer-relinquished'}
baseline = shots['baseline']
offer = one('offerCompletion')
assert offer['completeGrant'] == 0
assert offer['record'][0] == baseline['native']['window']
assert offer['record'][1] == one('grantee')
assert offer['record'][2] == baseline['native']['pid'] and offer['record'][3] > 0


def pixels(stage):
    return subprocess.check_output(['ffmpeg', '-v', 'error', '-i',
        str(root / 'rights-run-2' / (stage + '.png')), '-frames:v', '1',
        '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'])


original = pixels('baseline')
assert len(original) == baseline['image']['width'] * baseline['image']['height'] * 4
for stage, shot in shots.items():
    assert shot['image'] == baseline['image']
    native = shot['native']
    for key in ['pid', 'connection', 'window', 'bounds', 'windowRights', 'buttons', 'buttonRegion']:
        assert native[key] == baseline['native'][key], (stage, key)
    assert native['windowed']
    assert all(button['enabled'] and button['hit'] and not button['hidden'] and button['alpha'] == 1 for button in native['buttons'])
    assert pixels(stage) == original, stage

summary = {'catalog_all_resources_released': 'pass', 'owner_grant_acceptance_rights_readback_relinquishment': 'pass',
           'native_pixels_controls_owner_geometry_unchanged': 'pass', 'native_button_hide_demonstrated': False,
           'before': before, 'after_owner_grant': one('foreignRightsAfterOwnerGrant'),
           'restored': one('foreignRightsRestored'),
           'limits': 'owned child cooperation required; no backing-store writes or filter attachment tested; no protected-app success inferred'}
(root / 'verification.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
