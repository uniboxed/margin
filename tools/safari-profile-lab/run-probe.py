"""Confine a native profile probe to owned scratch writes; never run Safari."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--mode', choices=['inspect', 'fixture-create'], default='inspect')
parser.add_argument('--run', action='store_true')
args = parser.parse_args()
if not args.run:
    print(json.dumps({'plan': 'Run only the owned native probe under seatbelt. Deny live Safari reads/writes, writes outside fixture, Apple Events, AX/Safari/bookmark/TCC/Cloud services and network. Preserve source/binary/output; no Safari launch or permission grants.'}))
    sys.exit(0)
binary, output = args.binary.resolve(strict=True), args.output.resolve()
assert '/test-results/safari-profiles-' in str(output)
output.mkdir(parents=True, exist_ok=False)
allowed = output / 'allowed'
allowed.mkdir()
(allowed / '.margin-profile-fixture').write_text('margin-safari-profile-lab 25G342\n')
canary = output / 'forbidden.txt'
canary.write_text('owned forbidden-read/write control\n')
before = hashlib.sha256(canary.read_bytes()).hexdigest()
home = pathlib.Path.home()
protected = [home / 'Library/Safari', home / 'Library/Containers/com.apple.Safari',
             home / 'Library/Containers/com.apple.SafariTechnologyPreview',
             home / 'Library/Group Containers/group.com.apple.Safari']
quote = json.dumps
policy = ['(version 1)', '(allow default)',
          f'(deny file-write* (require-not (subpath {quote(str(allowed))})))',
          f'(deny file-read* (literal {quote(str(canary))}))',
          '(deny appleevent-send)', '(deny network*)',
          '(deny mach-lookup (regex "^com[.]apple[.](Safari|WebBookmarks|WebKit|accessibility|axserver|tccd|cloudd|bird|safaridavclient|cfprefsd|distributed_notifications)"))']
for path in protected:
    policy.append(f'(deny file-read* file-write* (subpath {quote(str(path))}))')
(output / 'policy.sb').write_text('\n'.join(policy) + '\n')
shutil.copy2(binary, output / 'probe')
shutil.copy2(pathlib.Path(__file__).with_name('profile-probe.m'), output / 'profile-probe.m')
shutil.copy2(__file__, output / 'run-probe.py')
with (allowed / 'probe.jsonl').open('wb') as stdout, (allowed / 'probe.stderr').open('wb') as stderr:
    try:
        result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(output / 'policy.sb'),
            str(output / 'probe'), '--' + args.mode, '--root', str(allowed)],
            stdout=stdout, stderr=stderr, timeout=18)
        code = result.returncode
    except subprocess.TimeoutExpired:
        code = 124
unchanged = hashlib.sha256(canary.read_bytes()).hexdigest() == before
summary = {'exit': code, 'canaryUnchanged': unchanged, 'mode': args.mode,
           'scope': 'seatbelt confinement, not a measurement of inherited host TCC grants',
           'policy': str(output / 'policy.sb')}
(output / 'result.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
sys.exit(0 if code == 0 and unchanged else 2)
