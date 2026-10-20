// Files the site serves from DATA_DIR/media at /media/<path> (src/pages/media/[...path].ts).
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './db/db-core.mjs';

export const MEDIA_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export const mediaDir = () => path.join(dataDir(), 'media');

/** A path segment: no dots at the start, no separators, nothing but letters, digits, dot, dash and underscore. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;

/**
 * Turn the part of the URL after /media/ into a file under the media folder, or null. Strict on purpose:
 * relative, forward-slash paths of plain segments ending in .jpg, .png or .webp. Backslashes, NUL, empty or
 * dot segments, absolute paths and encoded forms (%2e%2e, %2f, %5c, even double-encoded) are all refused,
 * and the real path (symlinks resolved) must still be inside the media folder.
 */
export function resolveMediaFile(rawAfterPrefix: string): { file: string; type: string } | null {
  let rel: string;
  try {
    rel = decodeURIComponent(rawAfterPrefix);
  } catch {
    return null;
  }
  if (!rel || rel.length > 600 || rel.includes('\\') || rel.includes('\0') || rel.includes('%') || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.length < 1 || parts.length > 6 || !parts.every((p) => SEGMENT.test(p))) return null;
  const ext = path.extname(parts[parts.length - 1]).slice(1).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return null;
  const root = mediaDir();
  const file = path.join(root, ...parts);
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    if (!real.startsWith(realRoot + path.sep) || !fs.statSync(real).isFile()) return null;
    return { file: real, type };
  } catch {
    return null;
  }
}
