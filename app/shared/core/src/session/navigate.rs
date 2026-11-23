//! A web item's history in its Safari window (HostedSession `navigate`, HS:2378-2385): the copy's `goBack`,
//! `goForward` or `reload` for its tab, the tab found first by `hostShow` in its profile's window. The step-3
//! skeleton's first flow.

use serde_json::json;

use super::{Core, host_id, swift_int};
use crate::json::Object;

fn object(v: serde_json::Value) -> Object {
    match v {
        serde_json::Value::Object(o) => o,
        _ => Object::new(),
    }
}

impl Core {
    /// What's read at once (the window, its item shown, where its page is), then in the session's queue its window
    /// (-1: none) and address at its turn.
    pub(crate) fn navigate(&self, kind: &str, window: Option<i64>) {
        let Some(w) = self.ports.window(window) else { return };
        let Some(item) = self.shown_in(w) else { return };
        let Some(o) = self.open_item(&item) else { return };
        let Some(p) = o.profile else { return };
        let role = host_id::safari_role(&o.host);
        let (Some(c), kind) = (self.rc(), kind.to_string()) else { return };
        self.exec.enqueue(async move {
            let window_id = c.safari_window(&p, role).unwrap_or(-1);
            let url = c.item_url(&item).unwrap_or_else(|| "about:blank".into());
            let shown =
                c.ask(&p, "hostShow", object(json!({ "windowId": window_id, "itemId": item, "url": url }))).await;
            let Some(tab) = swift_int(shown.result.as_ref().and_then(|r| r.get("tabId"))) else { return };
            c.ask(&p, &kind, object(json!({ "tabId": tab }))).await;
        });
    }
}
