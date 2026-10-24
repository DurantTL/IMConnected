// Reading and saving the home page layout (issue #155, migration 037). The rules live in homepage-layout.ts, which stays import-free of the database.
import { getDb } from './db';
import { tx } from './drafts';
import { audit } from './auth/audit';
import { invalidateStories } from './public-cache';
import { defaultLayout, isRailKey, normalizeHomepageBlocks, readableHomepageBlocks, type HomepageLayout } from './homepage-layout.ts';

/** The saved layout, or the default when none is saved or the database cannot be read (the page never errors for this). */
export function readHomepageLayout(): HomepageLayout {
  try {
    const r = getDb().prepare('SELECT version,blocks FROM homepage_layout WHERE id=1').get() as { version: number; blocks: string } | undefined;
    if (!r) return defaultLayout();
    return { version: r.version, blocks: readableHomepageBlocks(JSON.parse(r.blocks)) };
  } catch {
    const at = Date.now(); // one line (no data), at most once a minute, so a broken table does not flood the log
    if (at - lastReadFailure > 60_000) { lastReadFailure = at; console.error('[homepage-layout] the saved layout could not be read; showing the default layout'); }
    return defaultLayout();
  }
}
let lastReadFailure = 0;

/** Version-checked save. Returns false when `expected` is stale. Writes no story rows; audit carries counts and the version only. */
export function saveHomepageLayout(blocks: unknown, expected: number, userId: number, ip: string): boolean {
  const normalized = normalizeHomepageBlocks(blocks);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Reload the layout before saving.');
  const saved = tx(() => {
    const row = getDb().prepare('SELECT version FROM homepage_layout WHERE id=1').get() as { version: number } | undefined;
    if ((row?.version ?? 0) !== expected) return false;
    getDb().prepare('INSERT INTO homepage_layout(id,version,blocks,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,blocks=excluded.blocks,updated_at=excluded.updated_at').run(expected + 1, JSON.stringify(normalized), Date.now());
    audit('homepage.update', { userId, target: 'site:homepage', detail: { version: expected + 1, blocks: normalized.length, visible: normalized.filter((b) => b.visible).length, rails: normalized.filter((b) => isRailKey(b.key)).length }, ip });
    return true;
  });
  if (saved) invalidateStories();
  return saved;
}
