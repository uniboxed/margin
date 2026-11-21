// Peek & Little Arc pure helpers (Track 2 M2.5):
// - External-domain Auto-Peek detection for Pinned tabs & Favorites
// - OAuth / SSO / Login URL exclusion so auth redirects never get trapped in Peek
// - Centered floating modal card geometry over the dimmed Space backdrop

const OAUTH_HOSTS = new Set([
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'auth0.com',
  'okta.com',
  'signin.aws.amazon.com',
  'id.atlassian.com',
  'accounts.shopify.com',
]);

const OAUTH_HOST_SUFFIXES = ['.auth0.com', '.okta.com', '.oktapreview.com', '.onelogin.com', '.duosecurity.com'];
const OAUTH_PATH = /\/(oauth2?|authorize|auth\/login|login|signin|sign-in|sso|saml|oidc|session\/new|consent)(\/|$|\?)/i;

/** Coarse registrable domain (eTLD+1 approximation sufficient for same-site check). */
export function siteDomain(host: string): string {
  const clean = host.toLowerCase().replace(/^www\./, '');
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;
  // Handle common two-part public suffixes (.co.uk, .com.au, .co.jp, etc.).
  const last2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (/^(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/.test(last2) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

export function isAuthFlowUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (OAUTH_HOSTS.has(host)) return true;
  if (OAUTH_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (OAUTH_PATH.test(u.pathname)) return true;
  if (u.searchParams.has('client_id') && (u.searchParams.has('redirect_uri') || u.searchParams.has('response_type'))) return true;
  return false;
}

export function isPeekableUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Decides whether a normal click on `href` from `currentUrl` should Auto-Peek.
 * Explicit Shift+Click always peeks any `isPeekableUrl(href)`.
 */
export function shouldAutoPeek({
  href,
  currentUrl,
  fromPinnedOrFav,
  autoPeekEnabled = true,
}: {
  href: string,
  currentUrl: string,
  fromPinnedOrFav: boolean,
  autoPeekEnabled?: boolean,
}): boolean {
  if (!autoPeekEnabled || !fromPinnedOrFav) return false;
  if (!isPeekableUrl(href) || !isPeekableUrl(currentUrl)) return false;
  if (isAuthFlowUrl(href)) return false;
  const target = new URL(href);
  const current = new URL(currentUrl);
  if (siteDomain(target.hostname) === siteDomain(current.hostname)) return false;
  return true;
}

export type Rect = { x: number, y: number, width: number, height: number };

/**
 * Computes the centered floating modal card rect for Peek / Little Arc within a Space.
 * Reserves a 44px top header strip inside the card for Margin's Peek chrome bar
 * (URL pill, Back/Forward, Copy URL, Space picker, Expand into Space, Close).
 */
export function peekCardRect(container: Rect): { card: Rect, content: Rect, headerHeight: number } {
  const headerHeight = 44;
  const padX = Math.max(48, Math.round(container.width * 0.08));
  const padY = Math.max(36, Math.round(container.height * 0.07));
  const width = Math.max(420, Math.min(1280, container.width - padX * 2));
  const height = Math.max(320, Math.min(920, container.height - padY * 2));
  const x = Math.round(container.x + (container.width - width) / 2);
  const y = Math.round(container.y + (container.height - height) / 2);
  return {
    card: { x, y, width, height },
    content: { x, y: y + headerHeight, width, height: Math.max(200, height - headerHeight) },
    headerHeight,
  };
}
