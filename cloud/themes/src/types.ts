// What the server uses of Cloudflare's bindings (D1, R2, Durable Objects), as types of its own: the subset it calls,
// so the code type-checks with the repo's TypeScript alone, and the tests' fakes (tests/cloud-themes/fakes.ts) fill
// the same shapes on Node's SQLite and in memory.

export type D1Value = string | number | null;

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number };
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  /** The statements in one transaction: all of them or none. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  size: number;
  customMetadata?: Record<string, string>;
  text(): Promise<string>;
}

export interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  /** R2 refuses the write if the bytes' SHA-256 isn't this (hex). */
  sha256?: string;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: Uint8Array | string, options?: R2PutOptions): Promise<unknown>;
}

export interface DurableObjectStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface DurableObjectStorage {
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
}

/** The Worker's bindings (cloud/themes/wrangler.toml) and secrets (`wrangler secret put`). */
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  LIMITER: DurableObjectNamespace;
  /** The index's signing key: Ed25519, PKCS #8, base64 (npm run themes:keys). Its public half is in Margin. */
  SIGNING_KEY?: string;
  /** Signs the proof of work's challenges, and hashes networks in reports. 32 random bytes or more. */
  CHALLENGE_SECRET?: string;
  /** The review page's password (HTTP Basic, any user name). 32 random bytes or more. */
  ADMIN_TOKEN?: string;
  /** The proof of work's zero bits (wrangler.toml [vars]). */
  POW_BITS?: string;
}
