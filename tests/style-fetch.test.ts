// Which style sheets the background fetches for a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleUrlAllowed } from '../extension/background/site-icons.ts';

test('a sheet on a local network is only for a page on one', () => {
  const page = 'https://example.com/a';
  assert.ok(styleUrlAllowed('https://cdn.example.net/s.css', page));
  assert.ok(styleUrlAllowed('http://cdn.example.net/s.css', page));
  for (const url of ['http://localhost/s.css', 'http://intranet/s.css', 'http://printer.local/s.css', 'http://10.0.0.2/s.css', 'http://192.168.1.2/s.css', 'http://[::1]/s.css']) {
    assert.equal(styleUrlAllowed(url, page), false, url);
    assert.ok(styleUrlAllowed(url, 'http://192.168.1.9/app'), `${url} from a page on the network`);
  }
  assert.equal(styleUrlAllowed('file:///etc/passwd', page), false);
  assert.equal(styleUrlAllowed('not a url', page), false);
});
