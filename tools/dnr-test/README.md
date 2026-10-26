# DNR header test

A standalone Safari extension (not Margin) that checks whether Safari applies `declarativeNetRequest` **response-header** rules, the only extension route to framing sites that send `X-Frame-Options` / `frame-ancestors` (a cross-site split view). Rerun it after Safari updates.

1. Turn Margin off. Safari → Develop → **Add Temporary Extension…** → this folder.
2. Settings → Extensions → DNR header test → **Edit Websites…** → "When visiting other websites": **Allow** (or the page's "Ask Safari for access" button, then ⌘R).
3. The test page opens (or click the toolbar button). Valid only when the `access:` lines are `true` and the **Control** frame shows `"Accept-Language": "xx-DNR-WORKS"` (request-header rule 2).
4. Answer: the **httpbin X-Frame-Options: DENY** frame shows JSON and the **rule 3** line says `"xx-DNR-WORKS"` only if Safari applies response-header rules (rules 1 and 3). The **rule 4** line is a second control the page reads itself (a request header on a fetch, echoed by httpbin).
5. "Rules as" switches the same rules between **static** (built in, `rules.json`), **session** (`updateSessionRules`) and **dynamic** (`updateDynamicRules`, as extensions like Framer do).

Result so far (DECISIONS.md, "Safari: response-header rules, checked in Safari"): Safari 27.0.1 doesn't apply them, as static, session or dynamic rules. Chromium does in all three (all frames show), which also checks the test itself.
