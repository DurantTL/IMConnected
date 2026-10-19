/** Client IP for rate limits and audit logs. Honors Cloudflare / proxy headers only when TRUST_PROXY=true. */
export function clientIp(request: Request, fallback: string): string {
  if (process.env.TRUST_PROXY === 'true') {
    const fwd = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0];
    if (fwd) return fwd.trim();
  }
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
