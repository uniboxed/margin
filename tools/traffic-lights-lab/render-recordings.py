"""Add phase labels and a magnified title-bar crop outside the original recording."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
helper = pathlib.Path(sys.argv[2]).resolve()
pairs = [('native', root), *[(name, root / 'sampled') for name in ['chrome', 'edge', 'textedit']]]
for name, directory in pairs:
    source = directory / f'{name}-raw.mp4'
    if not source.exists():
        continue
    events = json.loads((directory / f'{name}.json').read_text())
    assert not any(event['event'] == 'failure' for event in events), name
    phases = [event for event in events if event['event'] == 'phase']
    assert len(phases) == 4, name
    stream = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', str(source)]))
    duration = float(stream['format']['duration'])
    width = stream['streams'][0]['width']
    height = stream['streams'][0]['height']
    body_height = round((1280 * height / width) / 2) * 2
    crop_width, crop_height = (260, 70) if width >= 1500 else (130, 35)
    app = {'native': 'Native AppKit test app', 'chrome': 'Google Chrome', 'edge': 'Microsoft Edge', 'textedit': 'TextEdit'}[name]
    mode = 'IN-PROCESS PRIVATE API' if name == 'native' else 'EXTERNAL ACCESSIBILITY / sampled frames'
    assets = root / 'presentation-assets'
    assets.mkdir(exist_ok=True)
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(source)]
    for index, phase in enumerate(phases):
        png = assets / f'{name}-{index}.png'
        subprocess.run([str(helper), str(png), app, mode, phase['label']], check=True)
        command += ['-loop', '1', '-i', str(png)]
    filters = [f'[0:v]split=2[m][z]', f'[m]scale=1280:{body_height},pad=1280:{body_height+220}:0:0:color=0x0d1624[b0]']
    for index, phase in enumerate(phases):
        start = 0 if index == 0 else float(phase['videoSeconds'])
        filters.append(f"[{index+1}:v]scale=1280:220[l{index}]")
        filters.append(f"[b{index}][l{index}]overlay=0:{body_height}:enable='gte(t,{start})'[b{index+1}]")
    filters += [f'[z]crop={crop_width}:{crop_height}:0:0,scale=520:140:flags=neighbor[zoom]', f'[b4][zoom]overlay=20:{body_height+50}[out]']
    command += ['-filter_complex', ';'.join(filters), '-map', '[out]', '-t', str(duration), '-r', '30', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(root / f'{name}.mp4')]
    subprocess.run(command, check=True)
    print(f'{name}: {duration:.2f}s, labels and magnifier added outside window')
