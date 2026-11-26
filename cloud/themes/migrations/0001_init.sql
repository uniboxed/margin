-- The themes server's records (docs/THEME-STORE.md §2, §3). Times are ms since 1970.

-- An install's key (no accounts): its id is the first 16 bytes of the public key's SHA-256, in hex.
CREATE TABLE keys (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,          -- raw Ed25519, base64url
  created_at INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,      -- its versions review approved (trusted at 2)
  blocked INTEGER NOT NULL DEFAULT 0
);

-- A theme id, owned by the key that first uploaded it.
CREATE TABLE themes (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES keys (id),
  created_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0         -- by reports or review: not in the index
);
CREATE INDEX themes_owner ON themes (owner);

-- Each uploaded version; its file is R2's packages/<sha256>.
CREATE TABLE versions (
  theme_id TEXT NOT NULL REFERENCES themes (id),
  version TEXT NOT NULL,
  major INTEGER NOT NULL,
  minor INTEGER NOT NULL,
  patch INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  name TEXT NOT NULL,                       -- theme.json's
  description TEXT NOT NULL,                -- theme.json's
  author TEXT NOT NULL,                     -- the display name typed when sharing
  tags TEXT NOT NULL,                       -- a JSON array
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('review', 'published', 'rejected')),
  reviewed_at INTEGER,                      -- set by review (null when a trusted key's version published at once)
  note TEXT,                                -- review's
  PRIMARY KEY (theme_id, version)
);
CREATE INDEX versions_sha256 ON versions (sha256);
CREATE INDEX versions_status ON versions (status, created_at);

-- One report per key per theme; the reporter's network only as an HMAC (never the address).
CREATE TABLE reports (
  theme_id TEXT NOT NULL REFERENCES themes (id),
  key_id TEXT NOT NULL REFERENCES keys (id),
  network TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0,       -- by review: no longer counted
  PRIMARY KEY (theme_id, key_id)
);

-- The index's generation: raised with every change to what it lists.
CREATE TABLE meta (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO meta (name, value) VALUES ('generation', 0);
