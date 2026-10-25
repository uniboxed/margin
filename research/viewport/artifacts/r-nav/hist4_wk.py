import json, subprocess, sys
REC = "JSON.stringify({top: location.href.replace('http://localhost:8701',''), frame: (()=>{try{return __f.contentWindow.location.href.replace('http://localhost:8701','')}catch(e){return 'XO/none'}})(), title: document.title, ev: (window.__events||[]).splice(0).map(s=>s.replace(/http:\\/\\/localhost:8701/g,''))})"
NPC = len(sys.argv) > 1 and sys.argv[1] == 'npc'
spa = lambda n: {"js": f"__f.contentWindow.eval(\"history.pushState({{}}, '', '/hist4?n={n}'); document.title='Page {n}'\"); 1", "wait": 700, "record": True, "label": f"spa->{n}"}
steps = [{"wait": 0, "record": True, "label": "initial"}, spa("A2"), {"js": "navFrame('/hist4?n=B'); 1", "wait": 900, "record": True, "label": "doc->B"}, spa("B2"),
         {"goback": True, "wait": 900, "record": True, "label": "UI back"},
         {"goback": True, "wait": 900, "record": True, "label": "UI back"},
         {"goback": True, "wait": 900, "record": True, "label": "UI back"},
         {"goforward": True, "wait": 900, "record": True, "label": "UI fwd"},
         {"goforward": True, "wait": 900, "record": True, "label": "UI fwd"},
         {"goforward": True, "wait": 900, "record": True, "label": "UI fwd"},
         {"js": "location.href='http://localhost:8702/site?id=leave&role=xo'; 1", "wait": 1200, "record": True, "label": "left site"},
         {"goback": True, "wait": 1800, "record": True, "label": "UI back"},
         {"goback": True, "wait": 1200, "record": True, "label": "UI back"},
         {"goback": True, "wait": 1200, "record": True, "label": "UI back"},
         {"goback": True, "wait": 1200, "record": True, "label": "UI back"}]
spec = {"url": "http://localhost:8701/hist4?n=A", "wait": 800, "steps": steps, "recordExpr": REC, "timeout": 40000, "nopagecache": NPC}
print(f"=== WebKitGTK hist4 (fully top-owned: SPA pushState rewritten to top pushState) pagecache={not NPC}")
d = json.loads(subprocess.run(['/usr/bin/python3.12', 'wkrun.py', json.dumps(spec)], capture_output=True, text=True, env={'DISPLAY': ':99', 'PATH': '/usr/bin:/bin'}).stdout)
for r in d['records']:
    p = r['page'] if isinstance(r['page'], dict) else {'err': r['page']}
    print(f"  {r['label']:9} addressbar={r['uri'].replace('http://localhost:8701','')!s:16} top={p.get('top')!s:16} frame={p.get('frame')!s:14} title={p.get('title')!r:10} ev={p.get('ev')}")
    print('             BF:', [u.replace('http://localhost:8701','') for u in r['bf']['ordered']])
