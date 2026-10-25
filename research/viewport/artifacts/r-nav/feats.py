import gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import WebKit2
print(WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version())
s = WebKit2.Settings()
feats = WebKit2.Settings.get_all_features()
for i in range(feats.get_length()):
    f = feats.get(i)
    ident = f.get_identifier()
    if any(k in ident.lower() for k in ['navigation','frame','sandbox','cross','iframe','coop','sitei','partition','storage']):
        print(ident, 'status=', f.get_status().value_nick, 'default=', f.get_default_value(), 'enabled=', s.get_feature_enabled(f))
