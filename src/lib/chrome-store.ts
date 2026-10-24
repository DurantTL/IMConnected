import { getDb } from './db';
import { tx } from './drafts';
import { audit } from './auth/audit';
import { invalidateStories } from './public-cache';
import { changedChromeFields, defaultChrome, defaultPublicChrome, normalizeChrome, publicChrome, type PublicChrome, type SiteChromeState } from './site-chrome';

export function readChrome(): SiteChromeState {
  const r = getDb().prepare('SELECT version,config FROM site_chrome WHERE id=1').get() as { version: number; config: string } | undefined;
  if (!r) return { version: 0, ...defaultChrome() };
  return { version: r.version, ...normalizeChrome(JSON.parse(r.config)) };
}
/** For pages: never throws; an unreadable or invalid saved configuration falls back to the defaults. */
export function readPublicChrome(): PublicChrome {
  try { return publicChrome(readChrome()); } catch { return defaultPublicChrome(); }
}
/** Returns false on a version conflict. Throws for invalid input. */
export function saveChrome(value: unknown, expected: number, userId: number, ip: string): boolean {
  const next = normalizeChrome(value);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Reload the page before saving.');
  const saved = tx(() => {
    const current = readChrome();
    if (current.version !== expected) return false;
    const fields = changedChromeFields(normalizeChrome(current), next);
    getDb().prepare('INSERT INTO site_chrome(id,version,config,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,config=excluded.config,updated_at=excluded.updated_at').run(expected + 1, JSON.stringify(next), Date.now());
    audit('site_chrome.update', { userId, target: 'site:chrome', detail: { version: expected + 1, fields }, ip });
    return true;
  });
  if (saved) invalidateStories();
  return saved;
}
