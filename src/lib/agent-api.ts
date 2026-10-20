// Shared by the /api/agent/* routes: machine-to-machine only (the AI agent), so NO CORS headers at all.
import { bearerStatus, tokensShared } from './bearer';

export function agentJson(status: number, payload: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
}

/** null = fine; otherwise the response to send: 503 when AGENT_API_TOKEN is unset or short, 401 when wrong. */
export function agentAuth(request: Request): Response | null {
  if (tokensShared()) return agentJson(503, { ok: false, error: 'not_configured', message: 'The agent API is not configured.' });
  const s = bearerStatus(request, process.env.AGENT_API_TOKEN);
  if (s === 'unconfigured') return agentJson(503, { ok: false, error: 'not_configured', message: 'The agent API is not configured.' });
  if (s === 'unauthorized') return agentJson(401, { ok: false, error: 'unauthorized', message: 'Unauthorized.' });
  return null;
}

