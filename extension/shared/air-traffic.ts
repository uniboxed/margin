// Air Traffic Control: URL → Space/Profile routing rules (Track 2 M2.6).
// Pure pattern normalization and deterministic first-match-wins evaluator.
// Supported pattern formats:
//   - exact host:          `linear.app`
//   - wildcard subdomain:  `*.figma.com` (matches subdomains and apex `figma.com`)
//   - host + path prefix:  `github.com/my-org/*` or `github.com/my-org`

export type AirTrafficRule = {
  id: string,
  pattern: string,
  spaceId: string,
  enabled?: boolean,
  order?: number,
};

const HOST_PART = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalizes a user-entered rule pattern, returning null if invalid. */
export function normalizePattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/^https?:\/\//i, '');
  if (!text || text.length > 200 || /[\s\u0000-\u001f\u007f]/.test(text)) return null;
  const slash = text.indexOf('/');
  const rawHost = (slash >= 0 ? text.slice(0, slash) : text).toLowerCase();
  const rawPath = slash >= 0 ? text.slice(slash) : '';
  const wildcard = rawHost.startsWith('*.');
  const hostBody = wildcard ? rawHost.slice(2) : rawHost;
  const labels = hostBody.split('.');
  if (labels.length < 2 || !labels.every((l) => HOST_PART.test(l))) return null;
  const cleanHost = wildcard ? `*.${hostBody}` : hostBody;
  if (!rawPath || rawPath === '/' || rawPath === '/*') return cleanHost;
  const cleanPath = rawPath.replace(/\/+/g, '/').replace(/\*+$/, '*');
  return `${cleanHost}${cleanPath}`;
}

/** Tests whether a normalized pattern matches an http(s) URL. */
export function patternMatchesUrl(pattern: string, url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const norm = normalizePattern(pattern);
  if (!norm) return false;
  const slash = norm.indexOf('/');
  const pHost = slash >= 0 ? norm.slice(0, slash) : norm;
  const pPath = slash >= 0 ? norm.slice(slash) : '';
  const host = u.hostname.toLowerCase();
  if (pHost.startsWith('*.')) {
    const base = pHost.slice(2);
    if (host !== base && !host.endsWith(`.${base}`)) return false;
  } else if (host !== pHost) {
    return false;
  }
  if (!pPath) return true;
  const path = u.pathname || '/';
  if (pPath.endsWith('*')) {
    const prefix = pPath.slice(0, -1);
    return path.startsWith(prefix) || (prefix.endsWith('/') && path === prefix.slice(0, -1));
  }
  return path === pPath || path.startsWith(`${pPath.replace(/\/$/, '')}/`);
}

/**
 * Evaluates Air Traffic Control rules in order (first enabled matching rule wins).
 * Ignores rules whose target `spaceId` is not in `validSpaceIds` (when provided).
 */
export function matchAirTrafficRule(
  url: string,
  rules: AirTrafficRule[] | null | undefined,
  validSpaceIds?: Set<string> | null,
): AirTrafficRule | null {
  if (!url || !Array.isArray(rules) || !rules.length) return null;
  const ordered = [...rules].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  for (const rule of ordered) {
    if (!rule || rule.enabled === false) continue;
    if (validSpaceIds && !validSpaceIds.has(rule.spaceId)) continue;
    if (patternMatchesUrl(rule.pattern, url)) return rule;
  }
  return null;
}
