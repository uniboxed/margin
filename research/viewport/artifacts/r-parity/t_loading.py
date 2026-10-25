# Does the browser chrome see loading state when only the iframe navigates?
from wkharness import Runner, GLib
R = Runner(port=8816)
samples = []
def sample():
    samples.append((round(R.view.is_loading()), round(R.view.get_estimated_load_progress(), 2)))
    return True
def t():
    for label, url, nav in [('top-level', 'http://127.0.0.1:8816/page', "location.href='/slow?s=2';1"), ('shell', 'http://127.0.0.1:8816/shell', "__f.contentWindow.location.href='/slow?s=2';1")]:
        yield ('load', url, 500)
        samples.clear(); sid = GLib.timeout_add(250, sample)
        yield ('js', nav); yield ('wait', 3000)
        GLib.source_remove(sid)
        print(f'{label:10} (isLoading, estimatedProgress) every 250ms:', samples)
R.run(t(), timeout=30)
