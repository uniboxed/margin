"""Encode actual display crops at measured sample intervals and add honest external-cover labels."""
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
bands = pathlib.Path(sys.argv[2]).resolve()
app = sys.argv[3]
events = json.loads((root / 'cover.json').read_text())
assert not any(e['event'] == 'failure' for e in events)
times = json.loads((root / 'timestamps.json').read_text())
finished = next(e for e in events if e['event'] == 'finished')['seconds']
origin = times[0]['seconds']
concat = 'ffconcat version 1.0\n'
for i, frame in enumerate(times):
    end = times[i+1]['seconds'] if i + 1 < len(times) else finished
    concat += f"file '{frame['file']}'\noption framerate 1000\nduration {end - frame['seconds']}\n"
concat += f"file '{times[-1]['file']}'\noption framerate 1000\n"
listing = root / 'frames.ffconcat'
listing.write_text(concat)
source = root / 'cover-raw.mp4'
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-safe', '0', '-i', str(listing), '-fps_mode', 'vfr',
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', str(source)], check=True)
stream = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
    'stream=width,height:format=duration', '-of', 'json', str(source)]))
width, height = stream['streams'][0]['width'], stream['streams'][0]['height']
body_height = round(1280 * height / width / 2) * 2
duration = float(stream['format']['duration'])
phases = [e for e in events if e['event'] == 'phase']
command = ['ffmpeg', '-v', 'error', '-y', '-i', str(source)]
assets = root / 'presentation-assets'; assets.mkdir(exist_ok=True)
for i, phase in enumerate(phases):
    png = assets / f'phase-{i}.png'
    subprocess.run([str(bands), str(png), app, 'EXTERNAL COVER / sampled display pixels', phase['label']], check=True)
    command += ['-loop', '1', '-i', str(png)]
filters = ['[0:v]split=2[main][z]', f'[main]scale=1280:{body_height},pad=1280:{body_height+220}:0:0:color=0x0d1624[b0]']
for i, phase in enumerate(phases):
    start = max(0, phase['seconds'] - origin)
    filters += [f'[{i+1}:v]scale=1280:220[l{i}]', f"[b{i}][l{i}]overlay=0:{body_height}:enable='gte(t,{start})'[b{i+1}]"]
# Magnify real recorded titlebar pixels; change crop after the scripted move and restoration.
move = max(0, phases[2]['seconds'] - origin)
restore = max(0, phases[6]['seconds'] - origin)
canvas = list(map(float, re.findall(r'-?\d+(?:\.\d+)?', next(e for e in events if e['event'] == 'binding')['canvas'])))
scale = width / canvas[2]
x = f"{65*scale}*between(t,{move},{restore})"
y = f"{45*scale}*between(t,{move},{restore})"
filters += [f"[z]crop={round(130*scale)}:{round(35*scale)}:x='{x}':y='{y}',scale=520:140:flags=neighbor[zoom]",
            f'[b{len(phases)}][zoom]overlay=20:{body_height+50}[out]']
command += ['-filter_complex', ';'.join(filters), '-map', '[out]', '-t', str(duration), '-r', '30',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(root / 'cover.mp4')]
subprocess.run(command, check=True)
print(f'{app}: {len(times)} actual samples, {duration:.2f}s; presentation labels stay outside captured pixels')
