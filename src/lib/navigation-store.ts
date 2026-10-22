import { getDb } from './db';
import { tx } from './drafts';
import { audit } from './auth/audit';
import { invalidateStories } from './public-cache';
import { defaultNavigation, normalizeNavigation, type Navigation } from './site-navigation';
export function readNavigation(): Navigation {
  const r = getDb().prepare('SELECT version,items FROM site_navigation WHERE id=1').get() as { version: number; items: string } | undefined;
  return r ? { version: r.version, items: normalizeNavigation(JSON.parse(r.items)) } : { version: 0, items: defaultNavigation() };
}
export function saveNavigation(items: unknown, expected: number, userId: number, ip: string): boolean {
  const normalized = normalizeNavigation(items);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Reload the menu before saving.');
  const saved = tx(() => {
    if (readNavigation().version !== expected) return false;
    getDb().prepare('INSERT INTO site_navigation(id,version,items,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,items=excluded.items,updated_at=excluded.updated_at').run(expected + 1, JSON.stringify(normalized), Date.now());
    audit('site.navigation', { userId, target: 'site:navigation', detail: { version: expected + 1, links: normalized.length }, ip });
    return true;
  });
  if (saved) invalidateStories();
  return saved;
}
