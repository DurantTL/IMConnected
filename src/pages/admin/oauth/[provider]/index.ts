import type { APIRoute } from 'astro';
import { audit } from '../../../../lib/auth/audit';
import { beginFlow, isProvider, providerConfig, warnIfOverridden } from '../../../../lib/auth/oauth';
import { isIpLocked, reserveOauthStart } from '../../../../lib/auth/ratelimit';
import { clientIp } from '../../../../lib/request';

export const prerender = false;

// Step 1 of Google / Microsoft sign-in: a plain link from /admin/login. It only stores state, the PKCE verifier and a nonce
// in a 10-minute cookie and sends the browser to the provider; it changes nothing else, so GET is fine (the
// middleware keeps it reachable without a session by exact path).
const back = (code: string) => new Response(null, { status: 303, headers: { Location: `/admin/login?oauth=${code}`, 'Cache-Control': 'no-store' } });

export const GET: APIRoute = ({ params, cookies, request, clientAddress }) => {
  warnIfOverridden();
  const provider = params.provider;
  if (!isProvider(provider)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const cfg = providerConfig(provider);
  if (!cfg) return back('unavailable');
  const ip = clientIp(request, clientAddress);
  // No audit row for a locked IP, and starts are counted per IP, so a flood can neither fill the audit log nor lock anyone out.
  if (isIpLocked(ip) || !reserveOauthStart(ip)) return back('locked');
  const location = beginFlow(cfg, cookies);
  audit('auth.oauth_started', { ip, detail: { provider } });
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
};
