import type { APIRoute } from 'astro';
import { addLabels, githubConfigFromEnv, removeLabel } from '../../lib/github';
import { confirmSecret, verifyConfirmToken } from '../../lib/email';
import { clientIp, originAllowed } from '../../lib/request';
import { markEmailVerified } from '../../lib/drafts';
import { audit } from '../../lib/auth/audit';

// Third server route (with /api/submit and /api/publish). Same-origin only: no CORS headers.
export const prerender = false;

// ---- per-IP rate limit: 30 an hour ----
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

const json = (status: number, payload: { ok: boolean; error?: string }) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'This request must come from the IMConnected website.' });
  if (rateLimited(clientIp(request, clientAddress))) return json(429, { ok: false, error: 'Too many attempts. Please try again later.' });

  const secret = confirmSecret();
  if (!secret) {
    console.error('[confirm] EMAIL_CONFIRM_SECRET not configured');
    return json(503, { ok: false, error: 'Confirmation is temporarily unavailable. Please email us.' });
  }

  let token = '';
  try {
    const body = (await request.json()) as { t?: unknown };
    token = typeof body?.t === 'string' ? body.t.slice(0, 300) : '';
  } catch {
    return json(400, { ok: false, error: "This link isn't valid." });
  }

  const check = verifyConfirmToken(token, secret);
  if (!check.ok) {
    return json(400, { ok: false, error: check.reason === 'expired' ? 'This link has expired. Please email us.' : "This link isn't valid." });
  }

  if (check.kind === 'draft') {
    // A draft that is gone answers the same as one that worked, so the response reveals nothing.
    try {
      if (markEmailVerified(check.id)) {
        console.log(`[confirm] draft #${check.id}: email verified`);
        try {
          audit('submission.email_verified', { target: `draft:${check.id}`, ip: clientIp(request, clientAddress) });
        } catch {
          /* the audit entry is a convenience */
        }
      }
    } catch (err) {
      console.error(`[confirm] draft #${check.id}: could not record the confirmation`, err instanceof Error ? err.message.slice(0, 200) : err);
      return json(502, { ok: false, error: 'We couldn’t record your confirmation right now. Please try again in a few minutes.' });
    }
    return json(200, { ok: true });
  }

  // An older link, from when submissions opened pull requests: still honoured while GitHub is configured.
  const cfg = githubConfigFromEnv();
  if (!cfg) return json(400, { ok: false, error: "This link isn't valid." });
  // A closed or merged PR still accepts label changes, and the answer is the same either way.
  try {
    await removeLabel(cfg, check.id, 'email-unverified');
    await addLabels(cfg, check.id, ['email-verified']);
  } catch (err) {
    // A PR that is gone answers the same as one that worked, so the response reveals nothing.
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 410 || status === 422) return json(200, { ok: true });
    console.error(`[confirm] PR #${check.id}: label update failed`, err instanceof Error ? err.message : err);
    return json(502, { ok: false, error: 'We couldn’t record your confirmation right now. Please try again in a few minutes.' });
  }
  console.log(`[confirm] PR #${check.id}: email verified`);
  return json(200, { ok: true });
};

export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
