/** Client IP for rate limits and audit logs. Honors Cloudflare / proxy headers only when TRUST_PROXY=true. */
export function clientIp(request: Request, fallback: string): string {
  if (process.env.TRUST_PROXY === 'true') {
    const fwd = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0];
    if (fwd) return fwd.trim();
  }
  return fallback;
}
