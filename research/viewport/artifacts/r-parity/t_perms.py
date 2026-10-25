# Permission-gated / gesture-gated APIs: page loaded top-level vs inside the same-origin shell iframe.
import sys, json
from wkharness import Runner, Gdk, WebKit2
mode = sys.argv[1]
attrs = sys.argv[2] if len(sys.argv) > 2 else 'allowfullscreen'
def conf(R):
    pass
R = Runner(port=8811)
s = R.view.get_settings()
fl = WebKit2.Settings.get_all_features()
for i in range(fl.get_length()):
    f = fl.get(i)
    if f.get_identifier() in ('MockCaptureDevices', 'WebShare', 'AllowsPictureInPictureMediaPlayback'):
        s.set_feature_enabled(f, True)
s.set_enable_media_stream(True)
W = "window" if mode == 'top' else "__f.contentWindow"
X, Y = (60, 30) if mode == 'top' else (260, 30)
APIS = {
 'static': None,
 'notification': "await Notification.requestPermission()",
 'geolocation': "await new Promise(r=>navigator.geolocation.getCurrentPosition(p=>r('pos'),e=>r('err '+e.code+' '+e.message),{timeout:3000}))",
 'getUserMedia': "await navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(s=>'stream tracks='+s.getTracks().length)",
 'getDisplayMedia': "await navigator.mediaDevices.getDisplayMedia({video:true}).then(s=>'stream tracks='+s.getTracks().length)",
 'clipboardWrite': "await navigator.clipboard.writeText('hello-clip').then(()=>'written')",
 'clipboardRead': "await navigator.clipboard.readText()",
 'fullscreen': "await document.documentElement.requestFullscreen().then(()=>'fs ok; own fsEl='+document.fullscreenElement.tagName+' top fsEl='+(top.document.fullscreenElement&&top.document.fullscreenElement.tagName)+' innerWidth='+innerWidth)",
 'exitFullscreen': "await document.exitFullscreen().then(()=>'exited')",
 'wakeLock': "await navigator.wakeLock.request('screen').then(l=>'lock '+l.type)",
 'share': "await navigator.share({title:'t',url:location.href}).then(()=>'shared')",
 'storageAccess': "await document.hasStorageAccess()",
 'webauthnGet': "await navigator.credentials.get({publicKey:{challenge:new Uint8Array(16),timeout:2000}}).then(c=>'cred')",
 'windowOpen': "(window.open('/popup-from-click','_blank'), 'called')",
 'paymentRequest': "typeof PaymentRequest",
}
STATIC = "({fullscreenEnabled: document.fullscreenEnabled, pipEnabled: document.pictureInPictureEnabled, PublicKeyCredential: typeof PublicKeyCredential, ApplePaySession: typeof ApplePaySession, PaymentRequest: typeof PaymentRequest, notifPerm: typeof Notification!=='undefined' && Notification.permission, isSecureContext, hasFocus: document.hasFocus(), topIsSelf: window.top===window, innerWidth, vw100: document.getElementById('vw').getBoundingClientRect().width})"
def t():
    url = 'http://127.0.0.1:8811/page' if mode == 'top' else 'http://127.0.0.1:8811/shell?attrs=' + attrs
    yield ('load', url, 600)
    if mode != 'top':
        yield ('js', "__f.contentWindow.focus();1")
    R.view.grab_focus(); yield ('wait', 200)
    res = {}
    for name, code in APIS.items():
        n0 = len(R.events)
        if code is None:
            res[name] = yield ('js', f"JSON.stringify({W}.eval({json.dumps(STATIC)}))")
            continue
        fn = f"window.__onclick = async () => {{ try {{ __r[{json.dumps(name)}] = String({code}); }} catch(e) {{ __r[{json.dumps(name)}] = 'EXC ' + e.name + ': ' + e.message; }} }}; 1"
        yield ('js', f"{W}.eval({json.dumps(fn)})")  # closure created in the target realm
        cx, cy = (60, 30) if name == 'exitFullscreen' else (X, Y)  # in fullscreen the iframe fills the view
        R.click(cx, cy); yield ('wait', 1500 if name not in ('geolocation',) else 3500)
        r = yield ('js', f"{W}.__r[{json.dumps(name)}] || 'pending'")
        res[name] = [r, R.events[n0:]]
    for k, v in res.items(): print(f'{k:16}', v)
R.run(t(), timeout=90)
