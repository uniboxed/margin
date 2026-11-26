// Responses, request bodies and the caller's network.

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** A JSON response. No caching unless the headers say otherwise. */
export function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/** An error the app can act on: a stable code, and words for the person. */
export function fail(status: number, error: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error, message }, headers);
}

export function bytesResponse(body: ReadableStream<Uint8Array> | Uint8Array | string, headers: Record<string, string>, status = 200): Response {
  return new Response(body as BodyInit, { status, headers: { ...BASE_HEADERS, ...headers } });
}

/**
 * The request's body, at most `max` bytes, or null when it's longer (its stated length, or what came). The body is
 * read as it arrives and dropped once it's past the cap, so an oversized one costs no more than the cap.
 */
export async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  const stated = request.headers.get('Content-Length');
  if (stated !== null && (!/^\d{1,12}$/.test(stated) || Number(stated) > max)) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.length;
    if (total > max) { void reader.cancel().catch(() => {}); return null; }
    chunks.push(step.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** A JSON object from a body, or null. */
export function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/**
 * The caller's network, for the per-network limits (docs/THEME-STORE.md §2): an IPv4 address whole, an IPv6 address
 * by its /64 (one home or phone gets a /64 or more). Cloudflare sets CF-Connecting-IP; anything unreadable is one
 * shared "unknown" network, so a missing header never escapes the limits.
 */
export function networkOf(request: Request): string {
  const ip = (request.headers.get('CF-Connecting-IP') ?? '').trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    return parts.every((n) => n <= 255) ? `4:${parts.join('.')}` : 'unknown';
  }
  const groups = ipv6Groups(ip);
  if (!groups) return 'unknown';
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d) is that IPv4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `4:${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `6:${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** An IPv6 address's eight groups, or null. */
function ipv6Groups(text: string): number[] | null {
  let ip = text.toLowerCase();
  if (!ip.includes(':') || ip.length > 45 || ip.includes('%')) return null;
  // A trailing IPv4 part (::ffff:1.2.3.4) as two groups.
  const tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (tail) {
    const q = tail.slice(2).map(Number);
    if (q.some((n) => n > 255)) return null;
    ip = `${tail[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const read = (part: string) => (part === '' ? [] : part.split(':'));
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}
