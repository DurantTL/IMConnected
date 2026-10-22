// A Studio connection can copy only the current lead upload of an open announcement.
// The random media identity prevents an old import descriptor binding a reused photo ID.
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db';
import { dataDir } from './db/db-core.mjs';
import { parseAnnouncement } from './announcement';

export interface StudioDraftFlyer { draftId: number; photoId: number; key: string; alt: string }
function currentFlyer(draftId: number): (StudioDraftFlyer & { path: string }) | null {
  const row = getDb().prepare(`SELECT p.id,p.path,p.media_key,p.alt,d.announcement FROM drafts d
    JOIN draft_photos p ON p.draft_id=d.id WHERE d.id=? AND d.status IN ('new','in_review')
    ORDER BY p.position,p.id LIMIT 1`).get(draftId) as { id: number; path: string | null; media_key: string; alt: string; announcement: string | null } | undefined;
  if (!row?.path || !row.media_key) return null;
  try { if (!parseAnnouncement(row.announcement)) return null; } catch { return null; }
  return { draftId, photoId: row.id, key: row.media_key, alt: row.alt, path: row.path };
}
export function studioDraftFlyer(draftId: number): StudioDraftFlyer | null {
  const row = currentFlyer(draftId);
  if (!row) return null;
  const { path: _privatePath, ...descriptor } = row;
  return descriptor;
}
export function resolveStudioDraftFlyer(draftId: number, photoId: number, key: string): string | null {
  const row = currentFlyer(draftId);
  if (!row || row.photoId !== photoId || row.key !== key) return null;
  try {
    const root = fs.realpathSync(path.join(dataDir(), 'uploads'));
    const lexical = path.resolve(root, row.path), real = fs.realpathSync(lexical);
    if (real !== lexical || !real.startsWith(root + path.sep) || !fs.lstatSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}
