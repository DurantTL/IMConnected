/** Rightmost X-Forwarded-For entry: the one our own proxy appended (earlier ones can be forged by the visitor). */
function rightmostForwarded(request: Request): string | null {
  const parts = (request.headers.get('x-forwarded-for') || '').split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Client IP for rate limits and audit logs.
 *   TRUST_PROXY=true        one reverse proxy of ours (e.g. xCloud's nginx): the rightmost X-Forwarded-For entry.
 *   TRUST_PROXY=cloudflare  behind Cloudflare's proxy: CF-Connecting-IP, else the rightmost X-Forwarded-For entry.
 *   anything else / unset   the socket address; forwarding headers are ignored.
 */
export function clientIp(request: Request, fallback: string): string {
  const mode = process.env.TRUST_PROXY;
  if (mode === 'cloudflare') return request.headers.get('cf-connecting-ip')?.trim() || rightmostForwarded(request) || fallback;
  if (mode === 'true') return rightmostForwarded(request) || fallback;
  return fallback;
}

/** Same-origin check: the Origin header (when present) must be this site, SITE_URL or ALLOWED_ORIGINS. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients; other guards still apply
  const allowed = new Set<string>([new URL(request.url).host]);
  if (process.env.SITE_URL) allowed.add(new URL(process.env.SITE_URL).host);
  for (const h of (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)) allowed.add(h);
  try {
    return allowed.has(new URL(origin).host);
  } catch {
    return false;
  }
}
