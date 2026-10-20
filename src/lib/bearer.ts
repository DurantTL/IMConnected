// Shared bearer-token check for the machine-to-machine routes (/api/publish, /api/stories, /api/agent/*).
import { createHash, timingSafeEqual } from 'node:crypto';

const sha = (v: string) => createHash('sha256').update(v).digest();

/** Tokens shorter than this are treated as "not configured". */
export const MIN_TOKEN_LENGTH = 32;

/**
 * 'unconfigured' when the secret is unset or short (answer 503), 'unauthorized' when the header is missing
 * or wrong (401), otherwise 'ok'. Both sides are hashed so the comparison is constant time whatever the length.
 */
export function bearerStatus(request: Request, secret: string | undefined): 'ok' | 'unconfigured' | 'unauthorized' {
  if (!secret || secret.length < MIN_TOKEN_LENGTH) return 'unconfigured';
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  const given = m ? m[1].trim() : '';
  return timingSafeEqual(sha(given), sha(secret)) ? 'ok' : 'unauthorized';
}

/**
 * True when AGENT_API_TOKEN and PUBLISH_TOKEN are both set and equal. The AI agent must never hold the token that
 * lets Studio commit straight to main, so both APIs answer 503 until the operator uses two different secrets.
 * Logs only that it happened, never a value.
 */
export function tokensShared(env = process.env): boolean {
  const a = env.AGENT_API_TOKEN;
  const p = env.PUBLISH_TOKEN;
  if (!a || !p || a !== p) return false;
  console.error('[auth] AGENT_API_TOKEN and PUBLISH_TOKEN are the same value; /api/agent and the Studio APIs are disabled until they differ.');
  return true;
}

/** Reads a request body up to `max` bytes. null = too large. */
export async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
