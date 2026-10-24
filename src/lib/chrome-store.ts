import { getDb } from './db';
import { tx } from './drafts';
import { audit } from './auth/audit';
import { invalidateStories } from './public-cache';
import { changedChromeFields, defaultChrome, defaultPublicChrome, normalizeChrome, publicChrome, type PublicChrome, type SiteChromeState } from './site-chrome';

/** Stored values over the defaults, per part, so a field missing from an older row still validates. */
function withDefaults(raw: unknown): unknown {
  const d = defaultChrome() as unknown as Record<string, Record<string, unknown>>;
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const part = (k: string) => ({ ...d[k], ...(r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]) ? r[k] as Record<string, unknown> : {}) });
  return { header: part('header'), footer: part('footer') };
}
const storedRow = () => getDb().prepare('SELECT version,config FROM site_chrome WHERE id=1').get() as { version: number; config: string } | undefined;

/** Throws when a stored row no longer validates (see readChromeForAdmin for the safe variant). */
export function readChrome(): SiteChromeState {
  const r = storedRow();
  if (!r) return { version: 0, ...defaultChrome() };
  return { version: r.version, ...normalizeChrome(withDefaults(JSON.parse(r.config))) };
}
/** A stored row that cannot be read falls back to the defaults at the stored version, flagged `broken`, so an administrator can always restore and save. */
export function readChromeForAdmin(): { state: SiteChromeState; broken: boolean } {
  try { return { state: readChrome(), broken: false }; }
  catch { return { state: { version: storedRow()?.version ?? 0, ...defaultChrome() }, broken: true }; }
}
const perRequest = new WeakMap<Request, PublicChrome>();
/** For pages: never throws; an unreadable or invalid saved configuration falls back to the defaults. Read once per request when the request is given. */
export function readPublicChrome(request?: Request): PublicChrome {
  const seen = request && perRequest.get(request);
  if (seen) return seen;
  let chrome: PublicChrome;
  try { chrome = publicChrome(readChrome()); } catch { chrome = defaultPublicChrome(); }
  if (request) perRequest.set(request, chrome);
  return chrome;
}
/** 'conflict' on a version mismatch, 'unchanged' when nothing differs (no version bump, no audit entry; a broken stored row is always rewritten), else 'saved'. Throws for invalid input. */
export function saveChrome(value: unknown, expected: number, userId: number, ip: string): 'saved' | 'unchanged' | 'conflict' {
  const next = normalizeChrome(value);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Reload the page before saving.');
  const result = tx((): 'saved' | 'unchanged' | 'conflict' => {
    const { state, broken } = readChromeForAdmin();
    if (state.version !== expected) return 'conflict';
    const fields = changedChromeFields(normalizeChrome(state), next);
    if (!fields.length && !broken && storedRow()) return 'unchanged';
    if (!fields.length && !storedRow()) return 'unchanged';
    getDb().prepare('INSERT INTO site_chrome(id,version,config,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,config=excluded.config,updated_at=excluded.updated_at').run(expected + 1, JSON.stringify(next), Date.now());
    audit('site_chrome.update', { userId, target: 'site:chrome', detail: { version: expected + 1, fields, ...(broken ? { repaired: true } : {}) }, ip });
    return 'saved';
  });
  if (result === 'saved') invalidateStories();
  return result;
}
