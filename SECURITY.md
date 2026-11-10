# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through
**[the repository's Security tab → Report a vulnerability](../../security/advisories/new)**. You'll get an answer
within a week, and a fix as soon as one can be made; you'll be credited unless you'd rather not be.

Only the latest release and `main` get security fixes while Margin is early.

## What Margin protects, and how

- **Nothing leaves your computer.** Margin has no servers, accounts or analytics. In Safari it fetches sites' own
  icons (without cookies), since Safari gives extensions none; nothing else is requested.
- **The link between the extension and the app** is a WebSocket on `127.0.0.1` only, opened with a token and a key
  that only Margin's extension gets (through the browser's native messaging, from Safari's extension handler or
  Margin's connector). A connection without them is refused. ([docs/PROTOCOL.md](docs/PROTOCOL.md))
- **The connector** (Chrome and Edge) reaches the app over a socket only your user can open (`0600` on macOS, a
  pipe for your user only on Windows); on macOS a signed app also checks the connector's code signature.
  Its host files allow only Margin's extension.
- **Themes are untrusted.** A theme's HTML and CSS are sanitized and drawn in a page that runs no theme script and
  may load nothing from the network; the security suite (`npm run test:security`) attacks it on every change.
- **Logs** never contain page addresses, titles or page content.
- **macOS private APIs** used for window handling are listed, with their fallbacks, in
  [docs/PRIVATE-APIS.md](docs/PRIVATE-APIS.md).
