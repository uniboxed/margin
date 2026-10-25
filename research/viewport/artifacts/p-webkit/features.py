# usage: DISPLAY=:99 /usr/bin/python3.12 features.py  -> identifier, status, default-value, enabled-in-fresh-Settings
import gi
gi.require_version('WebKit2', '4.1')
from gi.repository import WebKit2
print('WebKitGTK %d.%d.%d' % (WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version()))
s = WebKit2.Settings(); fl = WebKit2.Settings.get_all_features()
print('n', fl.get_length())
for i in range(fl.get_length()):
    f = fl.get(i)
    print(f.get_identifier(), f.get_status().value_nick, f.get_default_value(), s.get_feature_enabled(f))
