// The rate limits (docs/THEME-STORE.md §2, §3): counted exactly in a Durable Object per key and one per network
// (SQLite-backed, free since April 2025), so two requests at once can't both take the last one.

import type { DurableObjectState, DurableObjectStorage, Env } from './types.ts';

/** A limit: at most `limit` in the last minute or hour (sliding), or in the UTC day (it resets at 00:00 UTC). */
export type Rule = { name: string, limit: number, per: 'minute' | 'hour' | 'day' };

/** Every limit, by what's counted and whose: one place to read them all. */
export const RATES = Object.freeze({
  // Registering a key: 20 new keys a day per network (and each costs a proof of work).
  register: { network: [{ name: 'keys', limit: 20, per: 'day' }] },
  // Uploads: 5 a day per key, 20 per network.
  upload: { key: [{ name: 'uploads', limit: 5, per: 'day' }], network: [{ name: 'uploads', limit: 20, per: 'day' }] },
  // Reports: 20 a day per key, 60 per network.
  report: { key: [{ name: 'reports', limit: 20, per: 'day' }], network: [{ name: 'reports', limit: 60, per: 'day' }] },
} satisfies Record<string, { key?: Rule[], network?: Rule[] }>);

const SPAN = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** What a take says: taken, or which rule refused and how many seconds until it would allow one. */
export type Taken = { ok: true } | { ok: false, rule: string, retryAfter: number };

type Count = { day: number, n: number } | number[];

function ruleOk(rule: unknown): rule is Rule {
  const r = rule as Rule;
  return !!r && typeof r.name === 'string' && /^[a-z-]{1,40}$/.test(r.name) && Number.isInteger(r.limit) && r.limit > 0 && r.limit <= 10_000 && r.per in SPAN;
}

/**
 * The counts of one key or one network. `take` counts one against every rule, or none if any is at its limit;
 * `give` takes one back (a request another limit refused after this one counted it).
 *
 * Each request reads its counts, decides and writes them with no other await in between: a Durable Object's input
 * gate holds other requests while its storage is read or written, so the read-decide-write is atomic.
 */
export class Limiter {
  storage: DurableObjectStorage;
  constructor(state: DurableObjectState, _env?: unknown) { this.storage = state.storage; }

  async fetch(request: Request): Promise<Response> {
    let body: { op?: unknown, rules?: unknown, now?: unknown };
    try { body = await request.json(); } catch { return Response.json({ error: 'bad request' }, { status: 400 }); }
    const { op, rules, now } = body;
    if ((op !== 'take' && op !== 'give') || !Array.isArray(rules) || !rules.length || rules.length > 8 || !rules.every(ruleOk) || typeof now !== 'number' || !Number.isFinite(now)) {
      return Response.json({ error: 'bad request' }, { status: 400 });
    }
    return Response.json(await this.count(op, rules, now));
  }

  async count(op: 'take' | 'give', rules: Rule[], now: number): Promise<Taken> {
    const keys = rules.map((r) => `${r.per}:${r.name}`);
    const stored = await this.storage.get<Count>(keys);
    const today = Math.floor(now / SPAN.day);
    const next: Record<string, Count> = {};
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const was = stored.get(keys[i]);
      if (rule.per === 'day') {
        const n = was && !Array.isArray(was) && was.day === today ? was.n : 0;
        if (op === 'take' && n >= rule.limit) return { ok: false, rule: rule.name, retryAfter: Math.ceil(((today + 1) * SPAN.day - now) / 1000) };
        next[keys[i]] = { day: today, n: op === 'take' ? n + 1 : Math.max(0, n - 1) };
      } else {
        const since = now - SPAN[rule.per];
        const times = (Array.isArray(was) ? was : []).filter((t) => typeof t === 'number' && t > since);
        if (op === 'take' && times.length >= rule.limit) {
          // Allowed again once the oldest of the last `limit` leaves the window.
          const oldest = times[times.length - rule.limit];
          return { ok: false, rule: rule.name, retryAfter: Math.max(1, Math.ceil((oldest + SPAN[rule.per] - now) / 1000)) };
        }
        next[keys[i]] = op === 'take' ? [...times, now].slice(-rule.limit) : times.slice(0, -1);
      }
    }
    await this.storage.put(next);
    return { ok: true };
  }
}

/** One count, in the Durable Object named `name` (`key:<id>` or `network:<network>`). */
export async function count(env: Env, name: string, op: 'take' | 'give', rules: readonly Rule[], now: number): Promise<Taken> {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(name));
  const res = await stub.fetch('https://limiter/count', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, rules, now }) });
  if (!res.ok) throw new Error(`limiter: ${res.status}`);
  return await res.json() as Taken;
}

/**
 * One request counted against the key's limits, then the network's; if the network's refuses, the key's count is
 * given back, so a busy network doesn't use up its people's own allowances.
 */
export async function takeAll(env: Env, rates: { key?: readonly Rule[], network?: readonly Rule[] }, who: { key?: string, network: string }, now: number): Promise<Taken> {
  const keyRules = rates.key && who.key ? rates.key : null;
  if (keyRules) {
    const k = await count(env, `key:${who.key}`, 'take', keyRules, now);
    if (!k.ok) return k;
  }
  if (rates.network) {
    const n = await count(env, `network:${who.network}`, 'take', rates.network, now);
    if (!n.ok) {
      if (keyRules) await count(env, `key:${who.key}`, 'give', keyRules, now);
      return n;
    }
  }
  return { ok: true };
}
