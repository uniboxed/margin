"""Verify retained metadata/native-state evidence; never capture or control UI."""
import argparse
import hashlib
import json
import os
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument('root', type=pathlib.Path)
args = parser.parse_args()
root = args.root.resolve(strict=True)
read = lambda p: json.loads(p.read_text())
rows = lambda p: [json.loads(line) for line in p.read_text().splitlines()]
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
summary = {'build': '26B131', 'screenCaptureUsed': False, 'fixture': {}, 'browsers': {}, 'cleanup': []}


def outside_displays(button, displays):
    """Entire AX rectangle outside every active display, including negative origins."""
    attrs = button['attributes']
    x, y = attrs['AXPosition']['value']
    w, h = attrs['AXSize']['value']
    return not any(x < dx + dw and dx < x + w and y < dy + dh and dy < y + h
                   for dx, dy, dw, dh in displays)


def exited(pid, case):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        summary['cleanup'].append({'case': case, 'pid': pid, 'exited': True})
    else:
        raise AssertionError(f'{case}: recorded PID {pid} exists; inspect before claiming cleanup')


def load_case(case, status):
    path = root / case
    manifest = read(path / 'manifest.json')
    assert sha(path / 'ax-button-visibility.m') == manifest['sourceSHA256']
    assert sha(path / 'probe') == manifest['binarySHA256']
    result = read(path / 'result.json')
    events = rows(path / 'observations.jsonl')
    assert result['exit'] == result['completion']['status'] == status
    assert result['completion']['childExited'] and not result['screenCaptureUsed']
    assert not result['completion']['screenCaptureUsed']
    assert not (path / 'probe.stderr').read_text()
    identities = [e for e in events if e.get('stage') == 'identity']
    assert identities and all(e['AXTrusted'] and e['build'] == '26B131' for e in identities)
    for e in identities:
        exited(e['pid'], case)
    return path, events


phases = ['shown', 'disabled', 'hidden', 'only-close', 'alpha-zero', 'reveal-zero',
          'reveal-half', 'ancestor-hidden', 'restored']
relations = ['AXCloseButton', 'AXMinimizeButton', 'AXZoomButton', 'AXFullScreenButton']
for case in ['run-1', 'run-2', 'run-3', 'run-4']:
    successful = case in ['run-1', 'run-4']
    path, events = load_case(case, 0 if successful else 2)
    obs = [e for e in events if e.get('stage') == 'observation']
    if not successful:
        assert [e['phase'] for e in obs] == ['shown']
        assert events[-1]['reason'] == 'owned occluder is not the top pointer surface'
        if case == 'run-3':
            setup = next(e for e in events if e.get('stage') == 'occlusion-setup')
            assert setup['panelBounds'] == setup['requestedBounds']
            assert setup['panelIndex'] > setup['targetIndex']
            assert setup['pointerWindow'] == setup['targetWindow']
        summary['fixture'][case] = {'status': 'stopped at failed occluder setup', 'sourceSHA256': sha(path / 'ax-button-visibility.m')}
        continue
    expected = phases + (['fullscreen', 'post-fullscreen'] if case == 'run-1' else [])
    assert [e['phase'] for e in obs if e['phase'] != 'occluded'] == expected
    snapshots = []
    for event in obs:
        phase = event['phase']
        assert [b['relationship'] for b in event['buttons']] == relations
        hits = [bool(b['hitMatches']) for b in event['buttons']]
        wanted = ([True, False, False, False] if phase == 'only-close' else
                  [False] * 4 if phase in ['hidden', 'alpha-zero', 'reveal-zero', 'ancestor-hidden', 'fullscreen'] else [True] * 4)
        assert hits == wanted, (case, phase, hits)
        for b in event['buttons']:
            assert b['referenceError'] == 0
            assert b['attributes']['AXHidden']['error'] == b['attributes']['AXVisible']['error'] == -25205
            assert b['visibleChildrenError'] == -25205
        if phase == 'occluded':
            assert event['occluderVerifiedAbove']
            setup = next(e for e in events if e.get('stage') == 'occlusion-setup')
            assert setup['panelBounds'] == setup['requestedBounds']
            assert setup['panelIndex'] < setup['targetIndex']
            assert setup['pointerWindow'] == setup['panelWindow']
            continue
        before = read(path / f'native/truth-pre-{phase}.json')
        after = read(path / f'native/truth-post-{phase}.json')
        assert before == after, (case, phase, 'AX queries perturbed native fields')
        for index, button in enumerate(before['buttons']):
            if phase == 'fullscreen':
                continue  # Native local hit-test is NOT global rendered visibility.
            native_eligible = not button['hidden'] and button['alpha'] > 0 and button['reveal'] > 0
            assert native_eligible == hits[index] == bool(button['nativeHit'])
        if phase == 'disabled':
            assert all(not b['enabled'] for b in before['buttons']) and all(hits)
        snapshots.append({'phase': phase, 'hitMatches': hits[:3],
                          'inDirectChildren': [bool(b['inChildren']) for b in event['buttons'][:3]],
                          'queryMs': event['queryMs']})
    if case == 'run-4':
        assert all(e['buttons'][3]['sameAsZoomReference'] for e in obs)
    notices = next(e['events'] for e in events if e.get('stage') == 'notifications')
    summary['fixture'][case] = {'status': 'passed native-state correlation', 'phases': snapshots,
                                'notifications': [e['name'] for e in notices], 'sourceSHA256': sha(path / 'ax-button-visibility.m')}

for case, bundle in [('chrome-1', 'com.google.Chrome'), ('edge-1', 'com.microsoft.edgemac')]:
    path, events = load_case(case, 0)
    launched = next(e for e in events if e.get('stage') == 'browser-launched')
    assert launched['bundleIdentifier'] == bundle
    assert any(a.startswith('--user-data-dir=/private/tmp/margin-button-visibility-') for a in launched['arguments'])
    assert launched['arguments'][-1] == 'about:blank'
    exited(launched['pid'], case)
    obs = [e for e in events if e.get('stage') == 'browser-observation']
    assert [e['phase'] for e in obs] == ['windowed', 'fullscreen', 'post-fullscreen']
    assert len({e['window'] for e in obs}) == 1
    states = []
    for event in obs:
        assert event['pid'] == launched['pid']
        assert bool(event['AXFullScreen']['value']) == (event['phase'] == 'fullscreen')
        assert all(b['referenceError'] == 0 for b in event['buttons'])
        assert all(b['hitError'] == 0 and b['hitMatches'] for b in event['buttons'])
        assert event['buttons'][3]['sameAsZoomReference']
        states.append({'phase': event['phase'], 'hitMatches': [bool(b['hitMatches']) for b in event['buttons'][:3]],
                       'inDirectChildren': [bool(b['inChildren']) for b in event['buttons'][:3]]})
    summary['browsers'][case] = {'version': launched['version'], 'states': states,
                                'scope': 'AX metadata only; rendered visibility not independently verified'}

# run-1 predates display logging: compare its fullscreen frames with later run-4
# display metadata from this session; keep that provenance explicit.
displays = next(e['rects'] for e in rows(root / 'run-4/observations.jsonl') if e.get('stage') == 'display-metadata')
full = next(e for e in rows(root / 'run-1/observations.jsonl') if e.get('phase') == 'fullscreen')
assert all(outside_displays(b, displays) for b in full['buttons'])
summary['fullscreenGeometry'] = {'rectanglesOutsideAllDisplays': True, 'displayBounds': displays,
                                 'provenance': 'run-1 AX rectangles compared with subsequent run-4 display metadata'}
summary['limits'] = ['not a universal rendered-visibility oracle', 'no fullscreen-hover or transition latency acceptance',
                     'no flicker-free tracking claim', 'no Safari or custom-control acceptance', 'no product changes']
print(json.dumps(summary, indent=2))
