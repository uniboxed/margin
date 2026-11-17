"""Offline raw-evidence checks plus exact test-PID cleanup; no desktop control."""
import argparse
import json
import os
import pathlib
import statistics
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('root', type=pathlib.Path)
parser.add_argument('--analyzer', type=pathlib.Path, required=True)
args = parser.parse_args()
root = args.root.resolve(strict=True)
read = lambda p: json.loads(p.read_text())
rows = lambda p: [json.loads(line) for line in p.read_text().splitlines()]
stage = lambda values, name: next(row for row in values if row.get('stage') == name)
checks, cleanup = {}, []
for number in range(1, 7):
    run = root / f'run-{number}'
    events = rows(run / 'native/native.jsonl')
    identities = [row for row in events if row.get('stage') == 'identity']
    assert len(identities) == 2 and all(not row['AXTrusted'] for row in identities)
    negative = stage(events, 'permission-negative-control')
    assert negative['AXWindowsResult'] == -25211 and not negative['AXTrusted']
    for identity in identities:
        try:
            os.kill(identity['pid'], 0)
        except ProcessLookupError:
            cleanup.append({'run': number, 'pid': identity['pid'], 'exited': True})
        else:
            raise AssertionError('recorded PID still exists; inspect identity before claiming cleanup')
    if number == 1:
        assert events[-1]['status'] == 2 and events[-1]['reason'] == 'private bounds unavailable'
        continue
    assert events[-1]['status'] == 0
    assert stage(events, 'owned-group-control')['follows']
    foreign = stage(events, 'foreign-group-move')
    assert foreign['joinResult'] == 1001 and not foreign['followsWithoutControllerMoves']
    assert foreign['cover']['x'] == stage(events, 'cover-shown')['cover']['x']
    assert stage(events, 'foreign-metadata')['region'] == {'present': False}
    assert stage(events, 'foreign-metadata-after-proxy')['region'] == {'present': False}
    hidden, shown = read(run / 'native/truth-hidden.json'), read(run / 'native/truth-shown.json')
    assert all(row['hidden'] for row in hidden['buttons'])
    assert all(not row['hidden'] for row in shown['buttons'])
    assert hidden['region'] == shown['region'] and hidden['region']['present']
    for truth in (run / 'native').glob('truth-*.json'):
        assert read(truth)['windowed']
    if number in (4, 5):
        assert read(run / 'result.json')['measurementComplete']
        for name in ['tracked-move', 'tracked-resize']:
            item = stage(events, name)
            assert abs(item['cover']['x'] - item['target']['x'] - 7) < 1
            assert abs(item['cover']['y'] - item['target']['y'] - 7) < 1
        image_results = {}
        for name in ['baseline', 'covered', 'moved', 'tracked-covered', 'tracked-moved', 'tracked-resized']:
            # Decode the original full-size PNG and use the same independent
            # fixture locator as the video; no annotated/interpolated pixels.
            result = subprocess.check_output([str(args.analyzer.resolve()), str(run / (name + '.png')),
                '1656', '1100', '2', str(run / 'native/truth-baseline.json')], text=True)
            analyzed = [json.loads(line) for line in result.splitlines()]
            assert len(analyzed) == 1 and analyzed[0]['validFixture']
            image_results[name] = analyzed[0]['allDiscsCovered']
        assert image_results == {'baseline': False, 'covered': True, 'moved': False,
                                 'tracked-covered': True, 'tracked-moved': True, 'tracked-resized': True}
        analyzed = rows(run / 'video-analysis.jsonl')
        stream = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
            'stream=nb_frames,duration,avg_frame_rate', '-of', 'json', str(run / 'motion.mp4')], text=True))['streams'][0]
        assert len(analyzed) == int(stream['nb_frames']) # reject duplicate-frame decoder defaults
        assert all(row['validFixture'] for row in analyzed)
        exposed = [row['frame'] for row in analyzed if not row['allDiscsCovered']]
        assert exposed == ([] if number == 4 else [16, 28, 113])
        stamps = read(run / 'motion.mp4.json')['completeFramePTS']
        gaps = [b - a for a, b in zip(stamps, stamps[1:])]
        notices = read(run / 'native/notifications.json')['events']
        actual_callbacks = [row for row in notices if row['bytes'] == 4 and row['payloadPrefix'] == negative['targetWindow'] and row['event'] in (806, 807)]
        assert actual_callbacks
        checks[str(number)] = {'decodedOriginalFrames': len(analyzed), 'exposedFrames': exposed,
            'durationSeconds': float(stream['duration']), 'averageFrameRate': stream['avg_frame_rate'],
            'medianCompleteFrameGapSeconds': statistics.median(gaps), 'maxCompleteFrameGapSeconds': max(gaps),
            'nativeMoveResizeCallbacks': len(actual_callbacks), 'stillChecks': image_results,
            'flickerFreeProven': False, 'generalVisibilityDetectionProven': False}
    if number == 6:
        assert stage(events, 'owned-transaction-group-control')['follows']
        assert foreign['transactionAttempted']
result = {'runs': checks, 'cleanup': cleanup, 'allTwelveNativePIDsExited': len(cleanup) == 12,
          'scope': 'Owned separate-process standard AppKit fixture; calibrated layout; no real browser or fullscreen acceptance'}
(root / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
