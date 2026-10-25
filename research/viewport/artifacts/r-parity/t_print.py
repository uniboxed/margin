# Print the MAIN frame to PDF (what a browser's File > Print does when it prints the top document).
import sys, subprocess
from wkharness import Runner, WebKit2, Gtk, GLib
OUT = '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-parity/out'
url, name = sys.argv[1], sys.argv[2]
R = Runner(port=8815)
def t():
    yield ('load', 'http://127.0.0.1:8815' + url, 800)
    if len(sys.argv) > 3: yield ('js', sys.argv[3]); yield ('wait', 300)
    op = WebKit2.PrintOperation.new(R.view)
    ps = Gtk.PrintSettings(); ps.set_printer('Print to File')
    ps.set(Gtk.PRINT_SETTINGS_OUTPUT_FILE_FORMAT, 'pdf'); ps.set(Gtk.PRINT_SETTINGS_OUTPUT_URI, f'file://{OUT}/{name}.pdf')
    op.set_print_settings(ps)
    done = {}
    op.connect('finished', lambda o: done.__setitem__('ok', True))
    op.connect('failed', lambda o, e: done.__setitem__('err', str(e)))
    op.print_()
    for _ in range(100):
        if done: break
        yield ('wait', 100)
    yield ('wait', 500)
    txt = subprocess.run(['pdftotext', f'{OUT}/{name}.pdf', '-'], capture_output=True, text=True).stdout
    pages = subprocess.run(['pdfinfo', f'{OUT}/{name}.pdf'], capture_output=True, text=True).stdout
    np = [l for l in pages.splitlines() if l.startswith('Pages')]
    print("PRINTMEDIA in pdf:", "PRINTMEDIA" in txt, "SCREENMEDIA in pdf:", "SCREENMEDIA" in txt)
    print(f'{name:22} {done} {np} sidebarPrinted={"SIDEBAR" in txt} lastParaPrinted={"para 199" in txt} tokenPrinted={"UNIQUEFINDTOKEN" in txt} paras={txt.count("para ")}')
R.run(t(), timeout=40)
