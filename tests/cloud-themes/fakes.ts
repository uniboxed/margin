// The themes server's bindings, faked for Node's test runner (docs/THEME-STORE.md "Order": its SQL on Node's own
// SQLite, the engine D1 runs): D1 on node:sqlite with the real migrations, R2 in memory (checking a put's sha256 as
// R2 does), and the Limiter Durable Objects in memory, one instance per name, each handling one request at a time
// (a Durable Object is single-threaded and its input gate holds other requests while its storage is read or written,
// which is all the Limiter awaits while it counts).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Limiter } from '../../cloud/themes/src/limits.ts';
import type { D1Database, D1PreparedStatement, D1Result, D1Value, DurableObjectNamespace, DurableObjectStorage, Env, R2Bucket, R2ObjectBody, R2PutOptions } from '../../cloud/themes/src/types.ts';

const MIGRATIONS = new URL('../../cloud/themes/migrations/', import.meta.url);

export class FakeD1 implements D1Database {
  db = new DatabaseSync(':memory:');
  constructor() {
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) this.db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  prepare(sql: string): D1PreparedStatement {
    return new FakeStatement(this, sql, []);
  }
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => (s as FakeStatement).execute());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  /** A query straight on the database, for the tests' own looks. */
  rows(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).all(...values) as Record<string, any>[]; }
}

class FakeStatement implements D1PreparedStatement {
  d1: FakeD1; sql: string; values: D1Value[];
  constructor(d1: FakeD1, sql: string, values: D1Value[]) { this.d1 = d1; this.sql = sql; this.values = values; }
  bind(...values: D1Value[]): D1PreparedStatement {
    for (const v of values) if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw new TypeError(`D1 binds strings, numbers and null, not ${typeof v}`);
    return new FakeStatement(this.d1, this.sql, values);
  }
  execute(): D1Result {
    const stmt = this.d1.db.prepare(this.sql);
    if (/^\s*SELECT/i.test(this.sql)) return { results: stmt.all(...this.values) as Record<string, unknown>[], meta: { changes: 0 } };
    const r = stmt.run(...this.values);
    return { results: [], meta: { changes: Number(r.changes) } };
  }
  async first<T>(): Promise<T | null> { return (this.execute().results[0] as T) ?? null; }
  async all<T>(): Promise<D1Result<T>> { return this.execute() as D1Result<T>; }
  async run(): Promise<D1Result> { return this.execute(); }
}

export class FakeR2 implements R2Bucket {
  objects = new Map<string, { bytes: Uint8Array, customMetadata: Record<string, string> }>();
  puts = 0;
  async get(key: string): Promise<R2ObjectBody | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      body: new Blob([o.bytes as Uint8Array<ArrayBuffer>]).stream(),
      size: o.bytes.length,
      customMetadata: { ...o.customMetadata },
      text: async () => new TextDecoder().decode(o.bytes),
    };
  }
  async put(key: string, value: Uint8Array | string, options: R2PutOptions = {}) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value.slice();
    if (options.sha256 && createHash('sha256').update(bytes).digest('hex') !== options.sha256) throw new Error('R2: the bytes\' SHA-256 isn\'t the one given');
    this.puts++;
    this.objects.set(key, { bytes, customMetadata: { ...(options.customMetadata ?? {}) } });
    return {};
  }
}

export class MapStorage implements DurableObjectStorage {
  map = new Map<string, unknown>();
  async get<T>(keys: string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const k of keys) if (this.map.has(k)) out.set(k, structuredClone(this.map.get(k)) as T);
    return out;
  }
  async put(entries: Record<string, unknown>) { for (const [k, v] of Object.entries(entries)) this.map.set(k, structuredClone(v)); }
}

export class FakeLimiters implements DurableObjectNamespace {
  objects = new Map<string, { limiter: Limiter, storage: MapStorage, queue: Promise<unknown> }>();
  requests = 0;
  idFromName(name: string) { return name; }
  get(id: unknown) {
    const name = String(id);
    return {
      fetch: (input: string, init?: RequestInit) => {
        this.requests++;
        let o = this.objects.get(name);
        if (!o) { const storage = new MapStorage(); o = { limiter: new Limiter({ storage }), storage, queue: Promise.resolve() }; this.objects.set(name, o); }
        const obj = o;
        const run = obj.queue.then(() => obj.limiter.fetch(new Request(input, init)));
        obj.queue = run.catch(() => {});
        return run;
      },
    };
  }
}

export type FakeEnv = Env & { DB: FakeD1, FILES: FakeR2, LIMITER: FakeLimiters };

/** An env with every binding and secret set (the signing key's public half returned for the tests to verify with). */
export async function fakeEnv(over: Partial<Env> = {}): Promise<{ env: FakeEnv, indexKey: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const indexKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const env = {
    DB: new FakeD1(), FILES: new FakeR2(), LIMITER: new FakeLimiters(),
    SIGNING_KEY: pkcs8, CHALLENGE_SECRET: 'c'.repeat(43), ADMIN_TOKEN: 'a'.repeat(43), POW_BITS: '8',
    ...over,
  } as FakeEnv;
  return { env, indexKey };
}
