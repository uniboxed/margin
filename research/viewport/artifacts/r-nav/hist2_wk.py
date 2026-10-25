import json, subprocess, sys
REC = "JSON.stringify({top: location.href.replace('http://localhost:8701',''), frame: (()=>{try{return __f.contentWindow.location.href.replace('http://localhost:8701','')}catch(e){return 'XO/none'}})(), len: history.length, title: document.title, ev: (window.__events||[]).splice(0).map(s=>s.replace(/http:\\/\\/localhost:8701/g,''))})"
route = sys.argv[1] if len(sys.argv) > 1 else 'hist2'
NPC = len(sys.argv) > 2 and sys.argv[2] == "npc"
def spec(cc):
    if route == 'hist2':
        nav = lambda n: {"js": f"navFrame('/hist2?n={n}'); 1", "wait": 900, "record": True, "label": f"frame->{n}"}
        start = f"http://localhost:8701/hist2?n=A&cc={cc}"
    else:
        nav = lambda n: {"js": f"__f.contentWindow.eval(\"location.href='/hist?n={n}'\"); 1", "wait": 900, "record": True, "label": f"frame->{n}"}
        start = "http://localhost:8701/hist?n=A&sync=1"
    steps = [{"wait": 0, "record": True, "label": "initial"}, nav("B"), nav("C"),
             {"goback": True, "wait": 900, "record": True, "label": "UI back"},
             {"goforward": True, "wait": 900, "record": True, "label": "UI fwd"},
             {"js": "location.href='http://localhost:8702/site?id=leave&role=xo'; 1", "wait": 1200, "record": True, "label": "left site"},
             {"goback": True, "wait": 1800, "record": True, "label": "UI back"},
             {"goback": True, "wait": 1500, "record": True, "label": "UI back"},
             {"goback": True, "wait": 1500, "record": True, "label": "UI back"},
             {"goforward": True, "wait": 1500, "record": True, "label": "UI fwd"}]
    return {"url": start, "wait": 800, "steps": steps, "recordExpr": REC, "timeout": 30000, "nopagecache": NPC}
for cc in ('1',):
    print(f"=== WebKitGTK route={route} pagecache={not NPC}")
    d = json.loads(subprocess.run(['/usr/bin/python3.12', 'wkrun.py', json.dumps(spec(cc))], capture_output=True, text=True, env={'DISPLAY': ':99', 'PATH': '/usr/bin:/bin'}).stdout)
    for r in d['records']:
        p = r['page'] if isinstance(r['page'], dict) else {'err': r['page']}
        print(f"  {r['label']:10} addressbar={r['uri'].replace('http://localhost:8701','')!s:28} top={p.get('top')!s:28} frame={p.get('frame')!s:12} title={p.get('title')!r} ev={p.get('ev')}")
        print('              BF:', [u.replace('http://localhost:8701','') for u in r['bf']['ordered']])
