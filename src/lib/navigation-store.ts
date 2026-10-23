import { getDb } from './db';
import { tx } from './drafts';
import { audit } from './auth/audit';
import { invalidateStories } from './public-cache';
import { defaultNavigation, newsletterSignupHref, normalizeNavigation, type Navigation } from './site-navigation';
export function readNavigation(): Navigation {
  const r = getDb().prepare('SELECT version,items,newsletter_signup AS signup FROM site_navigation WHERE id=1').get() as { version: number; items: string; signup: string } | undefined;
  return r ? { version: r.version, items: normalizeNavigation(JSON.parse(r.items)), newsletterSignup: r.signup || '' } : { version: 0, items: defaultNavigation(), newsletterSignup: '' };
}
export function saveNavigation(items: unknown, expected: number, userId: number, ip: string, signup?: unknown): boolean {
  const normalized = normalizeNavigation(items);
  const nextSignup = signup === undefined ? undefined : newsletterSignupHref(signup); // undefined keeps the stored link
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Reload the menu before saving.');
  const saved = tx(() => {
    const current = readNavigation();
    if (current.version !== expected) return false;
    const finalSignup = nextSignup ?? current.newsletterSignup;
    const fields = ['links', ...(finalSignup !== current.newsletterSignup ? ['newsletterSignup'] : [])];
    getDb().prepare('INSERT INTO site_navigation(id,version,items,newsletter_signup,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,items=excluded.items,newsletter_signup=excluded.newsletter_signup,updated_at=excluded.updated_at').run(expected + 1, JSON.stringify(normalized), finalSignup, Date.now());
    audit('site.navigation', { userId, target: 'site:navigation', detail: { version: expected + 1, links: normalized.length, fields, newsletterSignup: !!finalSignup }, ip });
    return true;
  });
  if (saved) invalidateStories();
  return saved;
}
