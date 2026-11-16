"""Annotate actual sampled recordings outside the window; preserve originals."""
import json
from pathlib import Path
import subprocess
import sys

root,helper=map(lambda p:Path(p).resolve(),sys.argv[1:3])
assets=root/'presentation-assets';assets.mkdir(exist_ok=True)
def encode(app,variant):
    directory=root/(app+'-'+variant);source=directory/(app+'-raw.mp4')
    rows=json.loads((directory/(app+'.json')).read_text())
    assert not any(r['event']=='failure' for r in rows)
    phases=[r for r in rows if r['event']=='phase'];assert len(phases)==3
    duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(source)]))
    mode={'baseline':'Standard launch — native rounding','override':'Private AppKit launch request: 0.01','normal-after':'Normal relaunch — private arguments omitted'}[variant]
    title={'textedit':'TextEdit','preview':'Preview','chrome':'Google Chrome'}[app]
    command=['ffmpeg','-hide_banner','-loglevel','error','-i',str(source)]
    for i,phase in enumerate(phases):
        png=assets/(app+'-'+variant+'-'+str(i)+'.png')
        subprocess.run([str(helper),str(png),title,mode,phase['label']],check=True)
        command+=['-loop','1','-i',str(png)]
    filters=['[0:v]split=2[m][z]','[m]scale=1280:924,pad=1280:1144:0:0:color=0x0d1624[b0]']
    for i,phase in enumerate(phases):
        start=0 if i==0 else phase['videoSeconds']
        filters += [f'[{i+1}:v]scale=1280:220[l{i}]',f"[b{i}][l{i}]overlay=0:924:enable='gte(t,{start})'[b{i+1}]"]
    filters += ['[z]crop=130:35:0:0,scale=520:140:flags=neighbor[zoom]','[b3][zoom]overlay=20:974[out]']
    output=root/(app+'-'+variant+'.mp4')
    command+=['-filter_complex',';'.join(filters),'-map','[out]','-t',str(duration),'-r','30','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(output)]
    subprocess.run(command,check=True);return output
combined=[]
for app in ['textedit','preview','chrome']:
    if not (root/(app+'-normal-after')).exists():continue
    clips=[encode(app,v) for v in ['baseline','override','normal-after']]
    listing=root/(app+'-comparison.ffconcat');listing.write_text('ffconcat version 1.0\n'+''.join("file '"+str(p)+"'\n" for p in clips))
    result=root/(app+'-comparison.mp4')
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-safe','0','-f','concat','-i',str(listing),'-c','copy','-movflags','+faststart',str(result)],check=True)
    combined.append(result);print(app,'recording annotated',flush=True)
listing=root/'comparison.ffconcat';listing.write_text('ffconcat version 1.0\n'+''.join("file '"+str(p)+"'\n" for p in combined))
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-safe','0','-f','concat','-i',str(listing),'-c','copy','-movflags','+faststart',str(root/'comparison.mp4')],check=True)
