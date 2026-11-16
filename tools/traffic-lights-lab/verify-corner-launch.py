"""Verify launch-scoped corner effects from original PNGs, recordings and AX logs."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
def decode(path):
    meta = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=width,height','-of','json',str(path)]))['streams'][0]
    w,h = meta['width'],meta['height']
    pixels = subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'])
    assert len(pixels) == w*h*4
    counts = [sum(pixels[(y*w+x)*4+3] < 128 for y in range(y0,y0+40) for x in range(x0,x0+40))
              for x0,y0 in [(0,0),(w-40,0),(0,h-40),(w-40,h-40)]]
    colors=[0,0,0]
    for y in range(45):
        for x in range(150):
            r,g,b,a=pixels[(y*w+x)*4:(y*w+x)*4+4]
            if a<128:continue
            if r>180 and g<150 and b<150:colors[0]+=1
            if r>180 and g>130 and b<150:colors[1]+=1
            if g>130 and r<150 and b<150:colors[2]+=1
    return {'size':[w,h],'transparentPixelsPerCorner':counts,'trafficLightColorPixels':colors}
summary = {'owned':{},'apps':{}}
for case in ['owned-baseline','owned-override']:
    rows = [json.loads(l) for l in (root/(case+'.jsonl')).read_text().splitlines() if l.startswith('{')]
    assert rows[-1] == {'childRunning':False,'cleanup':True,'exit':0}
    shots = [r for r in rows if 'stage' in r]
    assert [r['stage'] for r in shots] == ['baseline','resized','size-restored']
    expected = [0]*4 if case.endswith('override') else [63]*4
    for row in shots:
        native=row['native']; assert native['windowed']
        assert abs(native['nativeCornerRadius']-(0.01 if case.endswith('override') else 16)) < 1e-6
        assert all(not b['hidden'] and b['enabled'] for b in native['buttons'])
        result=decode(root/case/(row['stage']+'.png')); assert result['transparentPixelsPerCorner']==expected
    assert shots[1]['image']['width']==shots[0]['image']['width']+80
    assert shots[1]['image']['height']==shots[0]['image']['height']+40
    assert shots[2]['image']==shots[0]['image']
    summary['owned'][case]={'nativeRadius':shots[0]['native']['nativeCornerRadius'],'transparentPixelsPerCorner':expected}
for app in ['textedit','preview','chrome']:
    if not (root/(app+'-baseline')).exists(): continue
    cases={}
    for variant in ['baseline','override','normal-after']:
        directory=root/(app+'-'+variant); rows=json.loads((directory/(app+'.json')).read_text())
        assert not any(r['event']=='failure' for r in rows)
        assert rows[-1]['event']=='cleanup' and rows[-1]['targetGone'] and rows[-1]['profileRemoved']
        config=next(r for r in rows if r['event']=='corner-launch-configuration')
        assert config['override']==(variant=='override') and not config['preferenceWrites']
        target=next(r for r in rows if r['event']=='target')
        snapshots=[r for r in rows if r['event']=='corner-snapshot']
        assert [r['label'] for r in snapshots]==['startup','resized','size-restored']
        assert all(r['windowed'] and len(r['buttons'])==3 and all(b['enabled'] for b in r['buttons']) for r in snapshots)
        original=snapshots[0]['size'];assert snapshots[1]['size']==[original[0]+80,original[1]+45]
        assert snapshots[2]['size']==original
        frames=directory/(app+'-raw.frames');times=json.loads((frames/'timestamps.json').read_text())
        assert all(b['uptime']>a['uptime'] for a,b in zip(times,times[1:]))
        assert len(times)==next(r['completeFrames'] for r in rows if r['event']=='recording-finished')
        operation_end=[next(r['uptime'] for r in rows if r['event']=='resize'),
                       next(r['uptime'] for r in rows if r['event']=='size-restore'),times[-1]['uptime']+0.01]
        phases={}
        for shot,end in zip(snapshots,operation_end):
            selected=[r for r in times if shot['uptime']+0.1 <= r['uptime'] < end-0.05]
            assert len(selected)>=5,(app,variant,shot['label'],len(selected))
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                decoded=list(pool.map(decode,[frames/r['file'] for r in selected]))
            assert all(r['size']==shot['size'] for r in decoded)
            assert all(all(c>5 for c in r['trafficLightColorPixels']) for r in decoded)
            counts=[r['transparentPixelsPerCorner'] for r in decoded]
            assert all(r==counts[0] for r in counts),(app,variant,shot['label'],counts)
            phases[shot['label']]={'verifiedFrames':len(selected),'transparentPixelsPerCorner':counts[0]}
        video=directory/(app+'-raw.mp4')
        duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(video)]))
        assert abs(duration-(times[-1]['uptime']-times[0]['uptime'])) < 1
        rgb=subprocess.check_output(['ffmpeg','-v','error','-ss',str(snapshots[0]['videoSeconds']+0.5),'-i',str(video),
            '-vf','format=rgb24,crop=1:1:0:0','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
        assert len(rgb)==3
        if app in ['textedit','preview'] and variant=='override':assert min(rgb)>60
        else:assert max(rgb)<30
        cases[variant]={'target':target,'frames':len(times),'videoDuration':duration,'decodedVideoCornerRGB':list(rgb),'phases':phases}
    normal=cases['baseline']['phases'];after=cases['normal-after']['phases'];override=cases['override']['phases']
    assert all(after[k]['transparentPixelsPerCorner']==normal[k]['transparentPixelsPerCorner'] for k in normal)
    assert all(all(c>0 for c in row['transparentPixelsPerCorner']) for row in normal.values())
    squared=all(r['transparentPixelsPerCorner']==[0]*4 for r in override.values())
    if app in ['textedit','preview']: assert squared,(app,override)
    if not squared:
        assert all(override[k]['transparentPixelsPerCorner']==normal[k]['transparentPixelsPerCorner'] for k in normal)
    summary['apps'][app]={'effect':'square outer shape' if squared else 'no corner effect','cases':cases}
assert {'textedit','preview'} <= summary['apps'].keys()
failed=root/'chrome-override-failed-tab/chrome.json'
if failed.exists():
    rejected=json.loads(failed.read_text())
    assert any(r['event']=='failure' for r in rejected)
    assert not any(r['event']=='recording-finished' for r in rejected)
    assert rejected[-1]['event']=='cleanup' and rejected[-1]['targetGone'] and rejected[-1]['profileRemoved']
    summary['invalidChromeAttempt']='retained; not counted as a corner-effect result'
assert json.loads((root/'preferences-before.json').read_text())==json.loads((root/'preferences-after.json').read_text())
before=json.loads((root/'signatures-before.json').read_text());after=json.loads((root/'signatures-after.json').read_text())
assert all(r['verifyExit']==0 for r in before+after)
assert {r['app']:r['binarySHA256'] for r in before}=={r['app']:r['binarySHA256'] for r in after}
summary['preferencesUnchanged']=True;summary['targetSignaturesAndBinaryHashesUnchanged']=True
(root/'launch-verification.json').write_text(json.dumps(summary,indent=2)+'\n')
print('PASS: original corner pixels, sampled media, windowed/button/resize state, ordinary relaunch, preferences, signatures and cleanup')
