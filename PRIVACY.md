# Privacy

Margin collects nothing about you. It has no accounts, no analytics, no ads and no servers, and it never sends your
browsing anywhere.

## What stays on your device

- **Your spaces, pinned tabs, folders, archive and settings** are kept in the browser's own extension storage and,
  on a Mac, in Margin.app's folder (`~/Library/Application Support/Margin/`). They never leave your computer, except
  through your browser's own sync if you use it.
- **Your open tabs** (their addresses, titles and icons) are read so Margin can show them in its interface. They're
  kept on your device only, and Margin's logs never contain page addresses, titles or page content.
- **Notes on sites' style sheets.** For a site whose style sheet files are named by their contents (most large
  sites), Margin keeps a short note of which of their rules it adjusts to fit the page beside its interface, so the
  next visit is faster: the site's address, the files' addresses and fingerprints of those rules, never the page's
  content. Kept in the browser's extension storage, a day at most per entry, at most 1 MB in all, never sent
  anywhere.
- **The link between the extension and Margin.app** is a connection on your own computer (`127.0.0.1`) protected by
  a secret only the two of them know. Nothing on it goes over the network.

## The only requests Margin makes

Margin talks only to the sites you're already visiting, never to anyone else, and always without cookies:

- **A site's icon, in Safari**, which doesn't give extensions the icons of open tabs: the icon the page names, or
  the site's own `/favicon.ico`. In Chrome and Edge, Margin uses the icons the browser already has.
- **A page's own style sheets, fetched again**, when the page loads one its own scripts can't read (from another
  of its addresses): Margin reads it to fit the page beside its interface. Only sheets the page itself uses, and
  never one on a local network unless the page is on one too.

Margin loads nothing else from anywhere: no fonts, scripts or images, and nothing about you is sent anywhere.

## Themes

Themes you import are HTML and CSS only. They're shown in a page that can't run scripts or reach the network.

## Permissions

Margin asks for access to every website because it lays each page out beside its interface, as you browse. It
reads only what it needs to do that and to show your tabs, and it changes nothing on a page beyond its layout.

## Questions

Ask in [the repository's issues](https://github.com/uniboxed/margin/issues), or report something sensitive privately
through [the Security tab](https://github.com/uniboxed/margin/security/advisories/new).

Margin is free software: everything above can be checked in its source.
