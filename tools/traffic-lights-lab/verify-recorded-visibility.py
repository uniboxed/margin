"""Audit this historical raw archive. No live UI or capture operations."""
import argparse
import bisect
import hashlib
import json
import os
import pathlib
import statistics
import subprocess

p = argparse.ArgumentParser()
p.add_argument('root', type=pathlib.Path)
a = p.parse_args()
root = a.root.resolve(strict=True)
read = lambda f: json.loads(f.read_text())
rows = lambda f: [json.loads(s) for s in f.read_text().splitlines()]
sha = lambda f: hashlib.sha256(f.read_bytes()).hexdigest()
summary = {'build': '26B131', 'pixelFeedbackToBackend': False, 'cases': {}, 'cleanup': [], 'videos': {}}
seen_pids = set()


def exited(pid):
    if pid in seen_pids:
        return
    seen_pids.add(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        summary['cleanup'].append({'pid': pid, 'exited': True})
    else:
        raise AssertionError(f'recorded PID {pid} still exists; inspect identity')


for case in sorted(root.iterdir()):
    if not (case / 'manifest.json').exists():
        continue
    manifest = read(case / 'manifest.json')
    for name, digest in manifest['sha256'].items():
        assert sha(case / name) == digest, (case.name, name)
    result = read(case / 'result.json')
    summary['cases'][case.name] = result
    for process in result.get('processes', {}).values():
        exited(process['pid'])
    if (case / 'driver.jsonl').exists():
        for event in rows(case / 'driver.jsonl'):
            if event.get('stage') == 'browser-launched':
                exited(event['pid'])
    if (case / 'group.jsonl').exists():
        for event in rows(case / 'group.jsonl'):
            for key in ['controllerPID', 'childPID']:
                if key in event:
                    exited(event[key])
    if (case / 'measurement.mp4.json').exists():
        meta = read(case / 'measurement.mp4.json')
        assert meta['measurementOnly'] and meta['recordingFinished'] and meta['error'] is None
        frames = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', str(case / 'measurement.mp4')], text=True))['frames']
        encoded = [float(f['best_effort_timestamp_time']) for f in frames]
        capture = meta['completeFramePTS']
        assert len(encoded) == len(capture)
        drift = max(abs((x-encoded[0])-(y-capture[0])) for x, y in zip(encoded, capture))
        assert drift < 0.003, (case.name, drift)
        summary['videos'][case.name] = {'originalFrames': len(encoded), 'relativePTSMaxDifferenceSeconds': drift,
            'minCompleteGapSeconds': min(y-x for x, y in zip(capture,capture[1:])),
            'maxCompleteGapSeconds': max(y-x for x, y in zip(capture,capture[1:])), 'videoSHA256': sha(case / 'measurement.mp4')}


def held(times, time):
    return max(0, bisect.bisect_right(times, time)-1)


def native_pixels(frame):
    # Calibrated finite fixture measurement: color discs, or substantially filled
    # gray discs. The alpha-zero negative control has shifted white title text in
    # these ROIs (54/55 bright samples), so brightness alone is not a disc oracle.
    return [color > 20 or contrast > 80 for color, contrast in zip(frame['coloredSamples'], frame['contrastSamples'])]


summary['nativeSnapshots'] = {}
for name in ['visibility-display-30', 'custom-30']:
    case = root / name
    capture = read(case / 'measurement.mp4.json')['completeFramePTS']
    video = rows(case / 'video-analysis.jsonl')
    detector = [e for e in rows(case / 'detector.jsonl') if e.get('stage') == 'sample']
    ends = [e['finishedUptime'] for e in detector]
    assert len(video) == len(capture) and all(e['validFixture'] for e in video)
    snapshots = []
    for event in rows(case / 'stimulus.jsonl'):
        if event.get('stage') != 'native-truth' or event.get('phase') in ['sample','initial','final','fade-in','fade-out']:
            continue
        time = event['uptime'] + 0.35
        frame = held(capture,time)
        pixel = native_pixels(video[frame])
        truth = [not b['hidden'] and b['alpha'] > 0 and b['reveal'] > 0 for b in event['buttons']]
        ax = [b['state'] == 'hit' for b in detector[held(ends,time)]['buttons']]
        assert pixel == truth, (name,event['phase'],pixel,truth)
        if name == 'visibility-display-30':
            assert ax == pixel
        else:
            assert all(ax)  # Deliberately static custom AX hits, including hidden controls.
        snapshots.append({'phase':event['phase'],'nativeEligible':truth,'pixelDiscs':pixel,'AXHits':ax,'originalFrame':frame})
    summary['nativeSnapshots'][name] = snapshots

# Logged completed native mutation -> next completed correct poll, not a claim
# about the first compositor pixel or an arbitrary application's notification time.
case = root / 'visibility-display-30'
detector = [e for e in rows(case / 'detector.jsonl') if e.get('stage') == 'sample']
timings, previous = [], None
for event in rows(case / 'stimulus.jsonl'):
    if event.get('stage') != 'native-truth':
        continue
    wanted = [not b['hidden'] and b['alpha'] > 0 and b['reveal'] > 0 for b in event['buttons']]
    if event['phase'] in ['shown','hidden','alpha-zero','only-close'] and previous is not None and wanted != previous:
        matching = next(e for e in detector if event['uptime'] <= e['finishedUptime'] <= event['uptime']+0.3
                        and [b['state']=='hit' for b in e['buttons']] == wanted)
        timings.append({'phase':event['phase'],'delayMs':(matching['finishedUptime']-event['uptime'])*1000})
    previous = wanted
summary['nativePollingDelay'] = {'samples':timings,'medianMs':statistics.median(t['delayMs'] for t in timings),
    'maxMs':max(t['delayMs'] for t in timings),'definition':'logged completed native mutation to next correct completed 30 Hz poll; not first-pixel latency'}

summary['browsers'] = {}
for name in ['chrome-1','edge-1','safari-3']:
    case = root / name
    capture = read(case / 'measurement.mp4.json')['completeFramePTS']
    video = rows(case / 'video-analysis-final.jsonl')
    assert len(video) == len(capture)
    states = []
    for event in rows(case / 'driver.jsonl'):
        if event.get('stage') != 'browser-sample':
            continue
        frame = held(capture,event['uptime']+0.2)
        ax = [bool(b['hitMatches']) for b in event['buttons'][:3]]
        visible = video[frame]['threeDiscEvidence']
        assert ax == [visible]*3, (name,event['phase'],ax,video[frame])
        states.append({'serial':event['serial'],'phase':event['phase'],'AXHits':ax,'threeDiscPixelEvidence':visible,'originalFrame':frame})
    assert any(not s['threeDiscPixelEvidence'] for s in states)
    assert any(s['phase']=='hover' and s['threeDiscPixelEvidence'] for s in states)
    summary['browsers'][name] = {'settledStates':states,'scope':'200 ms after driver sample; pixels independently locate color pair + gray middle-disc contrast, no AX rectangle input'}

summary['motion'] = {}
for name in ['motion-0','motion-16','motion-opt-0b','motion-opt-16c','motion-order-16']:
    case = root / name
    video = rows(case / ('video-analysis-final.jsonl' if name=='motion-opt-0b' else 'video-analysis.jsonl'))
    assert len(video) == summary['videos'][name]['originalFrames'] and all(e['validFixture'] for e in video)
    exposed = [e['frame'] for e in video if not e['allDiscsCovered']]
    assert exposed
    summary['motion'][name] = {'originalFrames':len(video),'exposedFrames':exposed,
        'initialCoverValid':bool(video[0]['allDiscsCovered']), 'flickerFree':False}
assert not summary['motion']['motion-opt-16c']['initialCoverValid']  # AppKit ordering mismatch, excluded from motion acceptance.
assert summary['motion']['motion-order-16']['initialCoverValid']
summary['fullFootprintGuards'] = {}
for name, expected in [('motion-order-16',31),('motion-overflow-24',1),('motion-overflow-32',0)]:
    case = root/name
    video = rows(case/'video-analysis-full-disc.jsonl')
    assert len(video)==summary['videos'][name]['originalFrames']
    assert all(e['validFixture'] and e['sampleRadiusPoints']==7.5 for e in video)
    truth = [e for e in rows(case/'stimulus.jsonl') if e.get('stage')=='native-truth']
    assert all(e['active'] and e['key'] and all(not b['hidden'] and b['alpha']==1 for b in e['buttons']) for e in truth)
    exposed = [e['frame'] for e in video if not e['allDiscsCovered']]
    assert len(exposed)==expected
    ready = next(e for e in rows(case/'detector.jsonl') if e.get('stage')=='ready')
    summary['fullFootprintGuards'][name] = {'originalFrames':len(video),'exposedFrames':exposed,
        'paddingPoints':ready['padding'],'overflowGuard':ready.get('overflowGuard',False),
        'maskRadiusPoints':7.5,'nativeControlsRemainUnhiddenAndActive':True,
        'universalFlickerFreeClaim':False}
case = root/'conditional-cover-30'
video = rows(case/'video-analysis-full-disc.jsonl')
assert len(video)==summary['videos']['conditional-cover-30']['originalFrames']
assert all(e['validFixture'] and e['sampleRadiusPoints']==7.5 for e in video)
colored = [e['frame'] for e in video if any(e['coloredSamples'])]
assert colored==[81,108,171]
summary['conditionalCover'] = {'hz':30,'paddingPoints':32,'overflowGuard':True,
    'originalFrames':len(video),'coloredDiscExposureFrames':colored,
    'interpretation':'native reveal/fade trial exposes colored controls despite logical cover state; no first-pixel presentation guarantee'}

summary['pollingCPU'] = {}
for name in ['perf-baseline-b','perf-15b','perf-30b','perf-60b']:
    case = root / name
    target = next(e for e in rows(case / 'stimulus.jsonl') if e.get('stage')=='stimulus-complete')
    row = {'targetOneCoreCPUPercentIncludingTruthInstrumentation':target['processCPUSeconds']/target['elapsedSeconds']*100,
           'screenRecorderRunning':False}
    assert not (case/'measurement.mp4').exists()
    if (case/'detector.jsonl').exists():
        events = rows(case/'detector.jsonl')
        assert events[-1]['complete'] and not events[-1]['captureBackend']
        row['detector'] = events[-1]
        samples = [e['queryMs'] for e in events if e.get('stage')=='sample']
        row['p95QueryMs'] = statistics.quantiles(samples,n=100)[94]
    summary['pollingCPU'][name] = row

events = rows(root/'events-scopes/observer.jsonl')
registrations = [e for e in events if e.get('stage')=='registration']
notices = [e for e in events if e.get('stage')=='AX-event']
assert len(registrations)==40 and all(e['error']==0 for e in registrations)
assert len(notices)==4 and all(e['name']=='AXMoved' for e in notices)
assert {e['scope'] for e in notices}=={1,2}  # App + exact window positive controls.
summary['notifications'] = {'registrations':40,'successful':40,'scopes':'app, window, close, minimize, zoom','observed':notices,'hideFadeEventsObserved':False}
group = rows(root/'group-ax/group.jsonl')
assert group[0]['follows'] and group[0]['AXTrusted']
assert group[1]['joinError']==0 and group[1]['memberDelta']==[0,0] and not group[1]['followsWithoutControllerMoves']
assert abs(group[1]['targetDelta'][0])>80
drag = rows(root/'group-ax-drag/group.jsonl')
assert read(root/'group-ax-drag/result.json')['exit']==2
assert drag[-1]['reason']=='native titlebar drag stimulus did not move target enough'
summary['movementGroups'] = {'ordinaryOwnerMotion':group[:2],'interactiveDrag':'inconclusive: zero target movement; rejected, no coupling claim'}
summary['exclusions'] = {'visibility-30':'app-filtered measurement inserted sharing control; not normal-visibility acceptance',
    'safari-1':'geometry setup failed before capture; private window can start fullscreen',
    'safari-2':'incorrect startup-window precondition; Safari can start menu-only',
    'motion-opt-0':'fixture key/focus setup failed before capture',
    'motion-opt-16':'active but not key; stopped before capture',
    'motion-opt-16b':'obsolete app-shareability precondition in display recorder; stopped before capture',
    'motion-opt-16c':'cover logical state did not match AppKit ordering; all discs exposed from initial frame',
    'perf-15':'key-window gate irrelevant to CPU-only trial; rejected and rerun in separate outputs',
    'group-ax-drag':'mouse stimulus produced no target movement; not a negative or positive coupling result'}
print(json.dumps(summary,indent=2))
