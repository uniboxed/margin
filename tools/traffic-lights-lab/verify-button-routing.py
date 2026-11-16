"""Check archived AX relationship experiments against original captured pixels."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
with (root / 'run-3.jsonl').open() as stream:
    rows = [json.loads(line) for line in stream]
assert rows[-1] == {'childRunning': False, 'cleanup': True, 'exit': 0}
assert not any('refused' in row for row in rows)
shots = {row['stage']: row for row in rows if 'stage' in row}
baseline = shots['baseline']
assert set(shots) == {'baseline', 'native-hidden-control', 'native-restored-control',
                     'owner-relations-rotated', 'owner-relations-restored',
                     'foreign-relationship-0', 'foreign-relationship-1', 'foreign-relationship-2'}


def pixels(stage):
    return subprocess.check_output(['ffmpeg', '-v', 'error', '-i',
        str(root / 'run-3' / (stage + '.png')), '-frames:v', '1',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])


original = pixels('baseline')
changes = {}
for stage, shot in shots.items():
    assert shot['image'] == baseline['image']
    native = shot['native']
    assert native['windowed'] and native['pid'] == baseline['native']['pid']
    assert native['window'] == baseline['native']['window']
    assert native['bounds'] == baseline['native']['bounds']
    actual = pixels(stage)
    assert len(actual) == len(original) == 680 * 452 * 3
    changed = sum(max(abs(original[index + component] - actual[index + component])
                      for component in range(3)) > 8 for index in range(0, len(original), 3))
    changes[stage] = changed
    for button in native['buttons']:
        assert button['enabled'] and button['alpha'] == 1
        assert button['hidden'] == (stage == 'native-hidden-control')
        assert button['hit'] == (stage != 'native-hidden-control')
    assert changed > 200 if stage == 'native-hidden-control' else changed == 0, (stage, changed)

relations = {row['relationsStage']: row for row in rows if 'relationsStage' in row}
assert len(relations) == 6
for stage, row in relations.items():
    ordinary = stage in ['baseline', 'restored']
    assert row['geometryMatchedButtonIndices'] == ([0, 1, 2] if ordinary else [1, 2, 0])
    assert len(row['fingerprints']) == 3
    assert all(fields['AXRole'] == ('AXButton' if ordinary else 'AXUnknown') for fields in row['fingerprints'])
assert relations['baseline']['fingerprints'] == relations['restored']['fingerprints']
writes = [row for row in rows if 'relationshipWrite' in row]
assert [row['relationshipWrite'] for row in writes] == ['AXCloseButton', 'AXMinimizeButton', 'AXZoomButton']
assert all(row['settableQuery'] == row['result'] == 0 and not row['settable'] for row in writes)
for attempt in [1, 2]:
    with (root / f'run-{attempt}.jsonl').open() as stream:
        failed = [json.loads(line) for line in stream]
    assert failed[-1] == {'childRunning': False, 'cleanup': True, 'exit': 2}
    assert any(row.get('refused') == 'owner AX metadata control failed' for row in failed)
    assert not any('relationshipWrite' in row for row in failed)
summary = {'saved_pixels_native_state_AX_metadata_restoration_cleanup': 'pass',
           'changed_pixels_entire_window': changes, 'foreign_writes': writes,
           'geometry_matches': {stage: row['geometryMatchedButtonIndices'] for stage, row in relations.items()},
           'limits': 'owned AppKit child only; overridden AX geometry identifies locations, not native object identity; no new protected-app hide established'}
(root / 'pixel-checks.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
