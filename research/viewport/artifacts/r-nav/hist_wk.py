import json, subprocess, sys
REC = "JSON.stringify({top: location.href.replace('http://localhost:8701',''), frame: (()=>{try{return __f.contentWindow.location.href.replace('http://localhost:8701','')}catch(e){return 'XO'}})(), len: history.length, title: document.title, ev: __events.splice(0).map(s=>s.replace(/http:\\/\\/localhost:8701/g,''))})"
def spec(sync, useUI):
    nav = lambda n: {"js": f"__f.contentWindow.eval(\"location.href='/hist?n={n}'\"); 1", "wait": 900, "record": True, "label": f"frame->{n}"}
    back = {"goback": True} if useUI else {"js": "history.back(); 1"}
    fwd = {"goforward": True} if useUI else {"js": "history.forward(); 1"}
    steps = [{"wait": 0, "record": True, "label": "initial"}, nav("B"), nav("C"),
             dict(back, wait=900, record=True, label="back#1"), dict(back, wait=900, record=True, label="back#2"),
             dict(fwd, wait=900, record=True, label="forward#1"),
             {"reload": True, "wait": 1500, "record": True, "label": "reload"}]
    return {"url": f"http://localhost:8701/hist?n=A&sync={sync}", "wait": 800, "steps": steps, "recordExpr": REC, "timeout": 20000}
for sync in (1, 0):
    for ui in ((True,) if sync else (True,)):
        print(f"=== WebKitGTK sync={sync} back/forward via {'browser UI (webkit_web_view_go_back)' if ui else 'history.back()/forward() in top'}")
        out = subprocess.run(['/usr/bin/python3.12', 'wkrun.py', json.dumps(spec(sync, ui))], capture_output=True, text=True, env={'DISPLAY': ':99', 'PATH': '/usr/bin:/bin'}).stdout
        d = json.loads(out)
        for r in d['records']:
            p = r['page'] if isinstance(r['page'], dict) else {'err': r['page']}
            bf = r['bf']
            print(f"  {r['label']:10} addressbar={r['uri'].replace('http://localhost:8701','')!s:22} top={p.get('top')!s:22} frame={p.get('frame')!s:16} len={p.get('len')} title={p.get('title')!r} ev={p.get('ev')}")
            print('              BF(oldest->newest, *=current):', [u.replace('http://localhost:8701','') for u in bf['ordered']])
