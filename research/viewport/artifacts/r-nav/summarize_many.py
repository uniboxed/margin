import sys, json, subprocess
arr = json.loads(sys.stdin.read())
for d in arr:
    print('===', d['url'])
    p = subprocess.run(['/usr/bin/python3.12', '-I', '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-nav/summarize.py'], input=json.dumps(d), capture_output=True, text=True)
    print(p.stdout, p.stderr)
    for r in d.get('records', []):
        print('   REC', json.dumps(r)[:600])
