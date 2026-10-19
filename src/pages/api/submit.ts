import type { APIRoute } from 'astro';
import { githubConfigFromEnv, openPullRequest, addLabels, updatePullRequestBody } from '../../lib/github';
import { clientIp, originAllowed } from '../../lib/request';
import { checkEmail, EmailCheckError } from '../../lib/email-check';
import { verifyTurnstile } from '../../lib/turnstile';
import { sendConfirmationEmail } from '../../lib/email';
import { parseSubmission, buildFiles, prBody, emailSent, emailNotSent, ValidationError } from '../../lib/submission';
import { getSection } from '../../lib/site';

export const prerender = false;

// ---- simple in-memory rate limit (per container) ----
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.SUBMIT_RATE_LIMIT || 10);
if (process.env.NODE_ENV === 'production' && !process.env.TURNSTILE_SECRET_KEY) {
  console.warn('[submit] TURNSTILE_SECRET_KEY is not set: the Turnstile check is off');
}

for (const v of ['TURNSTILE_VERIFY_URL', 'EMAIL_API_URL']) {
  if (process.env.NODE_ENV === 'production' && process.env[v]) console.warn(`[submit] ${v} is set: it is for local testing only`);
}

const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

function respond(request: Request, status: number, payload: { ok: boolean; error?: string }) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  if (wantsJson) {
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }
  // No-JS fallback
  if (payload.ok) return new Response(null, { status: 303, headers: { Location: '/submit/thanks/' } });
  const msg = (payload.error || 'Something went wrong.').replace(/[<>&]/g, '');
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Submission problem</title><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1>We couldn’t send your story</h1><p>${msg}</p><p><a href="javascript:history.back()">Go back and try again</a></p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function notifyDiscord(text: string) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
  }).catch((e) => console.error('[submit] discord notify failed', e));
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!originAllowed(request)) return respond(request, 403, { ok: false, error: 'Submissions must come from the IMConnected website.' });

  const ip = clientIp(request, clientAddress);
  if (rateLimited(ip)) return respond(request, 429, { ok: false, error: 'Too many submissions. Please try again later.' });

  const cfg = githubConfigFromEnv();
  if (!cfg) {
    console.error('[submit] GITHUB_TOKEN / GITHUB_REPO not configured');
    return respond(request, 503, { ok: false, error: 'Submissions are temporarily unavailable. Please email us your story.' });
  }

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return respond(request, 400, { ok: false, error: 'We couldn’t read the form. Your photos may be too large.' });
  }

  // Bot traps: hidden field filled in, or form sent faster than a human could type
  const started = Number(fd.get('t') || 0);
  if (String(fd.get('website') || '') !== '' || (started && Date.now() - started < 4000)) {
    console.warn('[submit] bot trap triggered', ip);
    return respond(request, 200, { ok: true }); // pretend success
  }

  try {
    const sub = parseSubmission(fd);
    const { slug, files, photoCount } = await buildFiles(sub);

    // Checks that need no GitHub call. Email first: a refusal here doesn't use up the Turnstile token.
    await checkEmail(sub.email);
    const security = await verifyTurnstile(String(fd.get('cf-turnstile-response') || ''), ip);
    if (security === 'fail') return respond(request, 400, { ok: false, error: 'Please complete the security check and try again.' });
    if (security === 'unreachable') return respond(request, 503, { ok: false, error: 'Please try again in a minute.' });

    const pr = await openPullRequest(cfg, {
      branch: `submission/${slug}`,
      files,
      commitMessage: `Story submission: ${sub.title}\n\nSubmitted via IMConnected form by ${sub.name} (${sub.church}).`,
      title: `Story: ${sub.title}`,
      body: prBody(sub, slug, photoCount),
    });
    console.log(`[submit] opened PR #${pr.number} for ${slug}`);

    // Mark the PR unverified, then email the submitter a confirmation link and record the outcome in the PR body.
    await addLabels(cfg, pr.number, ['email-unverified']).catch((e) => console.error(`[submit] PR #${pr.number}: could not add email-unverified label`, e instanceof Error ? e.message : e));
    const mail = await sendConfirmationEmail({ to: sub.email, title: sub.title, prNumber: pr.number });
    if (mail.sent) console.log(`[submit] PR #${pr.number}: confirmation email sent`);
    else console.warn(`[submit] PR #${pr.number}: confirmation email not sent (${mail.reason})`);
    await updatePullRequestBody(cfg, pr.number, prBody(sub, slug, photoCount, mail.sent ? emailSent : emailNotSent(mail.reason))).catch((e) =>
      console.error(`[submit] PR #${pr.number}: could not update the email status`, e instanceof Error ? e.message : e),
    );
    const section = getSection(sub.section)?.label;
    await notifyDiscord(`📰 **New IMConnected story submission**\n**${sub.title}**\n${sub.name} · ${sub.church} · ${section}\n${pr.url}`);
    return respond(request, 200, { ok: true });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof EmailCheckError) return respond(request, 400, { ok: false, error: err.message });
    console.error('[submit] failed', err);
    return respond(request, 502, { ok: false, error: 'We couldn’t save your story right now. Please try again in a few minutes.' });
  }
};

export const ALL: APIRoute = () => new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
