import json, subprocess
REC = "JSON.stringify({top: location.href.replace('http://localhost:8701',''), frame: (()=>{try{return __f.contentWindow.location.href.replace('http://localhost:8701','')}catch(e){return 'XO/none'}})(), len: history.length, title: document.title, ev: (window.__events||[]).splice(0).map(s=>s.replace(/http:\\/\\/localhost:8701/g,'')), persisted: window.__persisted})"
MAIN = "addEventListener('pageshow', e => { window.__persisted = e.persisted; });"
def spec(npc):
    nav = lambda n: {"js": f"__f.contentWindow.eval(\"location.href='/hist?n={n}'\"); 1", "wait": 900, "record": True, "label": f"frame->{n}"}
    steps = [nav("B"), nav("C"),
             {"js": "location.href='http://localhost:8702/site?id=leave&role=xo'; 1", "wait": 1200, "record": True, "label": "left site"},
             {"goback": True, "wait": 1800, "record": True, "label": "UI back"},
             {"goback": True, "wait": 1500, "record": True, "label": "UI back#2"}]
    return {"url": "http://localhost:8701/hist?n=A&sync=1", "wait": 800, "steps": steps, "recordExpr": REC, "timeout": 25000, "nopagecache": npc, "mainworld": MAIN}
for npc in (False, True):
    print(f"=== WebKitGTK leave-and-return, page cache {'DISABLED' if npc else 'enabled'}")
    d = json.loads(subprocess.run(['/usr/bin/python3.12', 'wkrun.py', json.dumps(spec(npc))], capture_output=True, text=True, env={'DISPLAY': ':99', 'PATH': '/usr/bin:/bin'}).stdout)
    for r in d['records']:
        p = r['page'] if isinstance(r['page'], dict) else {'err': r['page']}
        print(f"  {r['label']:10} addressbar={r['uri'].replace('http://localhost:8701','')!s:40} top={p.get('top')!s:40} frame={p.get('frame')!s:16} title={p.get('title')!r} persisted={p.get('persisted')} ev={p.get('ev')}")
        print('              BF:', [u.replace('http://localhost:8701','') for u in r['bf']['ordered']])
